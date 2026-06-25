const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const { runCommand } = require('./commandService');
const { getAppPaths, normalizePathList } = require('./configService');
const {
  HYPERFRAMES_TOOL_ID,
  HYPERFRAMES_VERSION,
  getManagedHyperFramesExecutionRuntime,
  runHyperFramesCli,
} = require('./hyperFramesService');
const { resolveManagedFfmpegPaths } = require('./managedFfmpegService');
const {
  buildFileArtifact,
  saveVideoArtifactMetadata,
  sanitizeSegment,
} = require('./pipelineArtifactService');
const { assertPathInside, assertRealPathInside, isPathInside } = require('./pathSafetyService');

const HYPERFRAMES_RENDER_NODE_TYPE = 'hyperframesRender';
const HYPERFRAMES_RENDER_OPERATION_ID = 'hyperframesRender';
const HYPERFRAMES_RENDER_WARNING = 'HyperFrames renders HTML/CSS/JavaScript in Chromium. Render only compositions you trust. This first version is intended for local projects with local assets.';
const HYPERFRAMES_LOCAL_ASSETS_ERROR = 'This first HyperFrames integration supports local composition assets only. Remove remote references or use local copies.';
const HYPERFRAMES_RENDER_FPS_VALUES = Object.freeze([24, 30, 60]);
const HYPERFRAMES_RENDER_QUALITY_VALUES = Object.freeze(['draft', 'standard', 'high']);
const HYPERFRAMES_RENDER_WORKERS = 1;
const HYPERFRAMES_RENDER_BROWSER_GPU = false;
const HYPERFRAMES_RENDER_FORMAT = 'mp4';
const HYPERFRAMES_RENDER_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_STAGING_LIMITS = Object.freeze({
  maxDepth: 12,
  maxFiles: 2500,
  maxTotalBytes: 512 * 1024 * 1024,
  maxScannedTextBytesPerFile: 1024 * 1024,
});
const TEXT_SCAN_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs']);
const IGNORED_STAGE_NAMES = new Set(['.git', '.hg', '.svn', '.cache', '.hyperframes-cache', 'node_modules', 'tmp', 'temp']);

function normalizeHyperFramesRenderSettings(config = {}) {
  const fps = Number(config.fps || 30);
  const quality = String(config.quality || 'draft').trim().toLowerCase();
  return {
    browserGpu: HYPERFRAMES_RENDER_BROWSER_GPU,
    format: HYPERFRAMES_RENDER_FORMAT,
    fps: HYPERFRAMES_RENDER_FPS_VALUES.includes(fps) ? fps : 30,
    quality: HYPERFRAMES_RENDER_QUALITY_VALUES.includes(quality) ? quality : 'draft',
    workers: HYPERFRAMES_RENDER_WORKERS,
  };
}

function assertSupportedHyperFramesRenderSettings(config = {}) {
  const fps = Number(config.fps || 30);
  const quality = String(config.quality || 'draft').trim().toLowerCase();
  if (!HYPERFRAMES_RENDER_FPS_VALUES.includes(fps)) {
    throw new Error('HyperFrames Render supports 24, 30, or 60 FPS in this first version.');
  }
  if (!HYPERFRAMES_RENDER_QUALITY_VALUES.includes(quality)) {
    throw new Error('HyperFrames Render supports Draft, Standard, or High quality in this first version.');
  }
  return normalizeHyperFramesRenderSettings(config);
}

function getArtifactUrlScheme(artifact) {
  const value = String(artifact?.fileUrl || artifact?.url || artifact?.sourceUrl || '').trim();
  if (!value) return '';
  const match = value.match(/^([a-z][a-z0-9+.-]*):/i);
  return match ? match[1].toLowerCase() : '';
}

function getManagedArtifactRoots(runDirectories = {}) {
  const paths = getAppPaths();
  return normalizePathList([
    runDirectories.root,
    runDirectories.artifactsDir,
    runDirectories.outputsDir,
    paths.managedRoot,
    paths.runtimesRoot,
    paths.librariesRoot,
    paths.recordingsRoot,
    paths.tempRoot,
    ...(paths.knownManagedRoots || []),
  ]).map((entry) => path.resolve(entry));
}

function isArtifactUnderManagedRoot(filePath, runDirectories = {}) {
  return getManagedArtifactRoots(runDirectories).some((rootPath) => isPathInside(rootPath, filePath));
}

function assertTrustedCompositionArtifact(input, options = {}) {
  const artifact = input?.artifact || input || null;
  if (!artifact || artifact.kind !== 'file' || !artifact.filePath) {
    throw new Error('HyperFrames Render needs a File Input that points to a local index.html artifact.');
  }

  const scheme = getArtifactUrlScheme(artifact);
  if (scheme && scheme !== 'file') {
    throw new Error('HyperFrames Render only accepts local file artifacts. Remote, data, and generated URL inputs are not supported in this first version.');
  }

  const filePath = path.resolve(String(artifact.filePath || '').trim());
  if (path.basename(filePath) !== 'index.html') {
    throw new Error('HyperFrames Render needs the selected source file to be named exactly index.html.');
  }

  const sourceNodeType = String(input?.sourceNode?.type || input?.sourceNodeType || '').trim();
  const isUserSelectedFileInput = sourceNodeType === 'fileInput';
  const isManagedArtifact = isArtifactUnderManagedRoot(filePath, options.runDirectories || {});
  if (!isUserSelectedFileInput && !isManagedArtifact && options.allowDirectLocalIndexHtmlArtifact !== true) {
    throw new Error('HyperFrames Render only accepts user-selected File Input artifacts or Local AI Hub managed local artifacts.');
  }

  return {
    artifact,
    filePath,
    projectRoot: path.dirname(filePath),
    sourceFileName: path.basename(filePath),
  };
}

function mergeStagingLimits(limits = {}) {
  return {
    maxDepth: Math.max(1, Number(limits.maxDepth || DEFAULT_STAGING_LIMITS.maxDepth) || DEFAULT_STAGING_LIMITS.maxDepth),
    maxFiles: Math.max(1, Number(limits.maxFiles || DEFAULT_STAGING_LIMITS.maxFiles) || DEFAULT_STAGING_LIMITS.maxFiles),
    maxTotalBytes: Math.max(1, Number(limits.maxTotalBytes || DEFAULT_STAGING_LIMITS.maxTotalBytes) || DEFAULT_STAGING_LIMITS.maxTotalBytes),
    maxScannedTextBytesPerFile: Math.max(1, Number(limits.maxScannedTextBytesPerFile || DEFAULT_STAGING_LIMITS.maxScannedTextBytesPerFile) || DEFAULT_STAGING_LIMITS.maxScannedTextBytesPerFile),
  };
}

function isReparsePointStats(stats) {
  return Boolean(stats && (
    (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) ||
    (typeof stats.isReparsePoint === 'function' && stats.isReparsePoint())
  ));
}

function shouldIgnoreStageEntry(name) {
  return IGNORED_STAGE_NAMES.has(String(name || '').trim().toLowerCase());
}

async function copyCompositionProjectSafely(sourceRoot, stagedRoot, limits = {}, state = null, relativePath = '') {
  const activeLimits = mergeStagingLimits(limits);
  const currentState = state || { fileCount: 0, totalBytes: 0, ignoredEntries: [] };
  const sourcePath = path.join(sourceRoot, relativePath);
  const targetPath = path.join(stagedRoot, relativePath);
  const depth = relativePath ? relativePath.split(path.sep).filter(Boolean).length : 0;
  if (depth > activeLimits.maxDepth) {
    throw new Error('HyperFrames Render refused this project because it is deeper than the first-version staging limit.');
  }

  const stats = await fs.lstat(sourcePath);
  if (isReparsePointStats(stats)) {
    throw new Error('HyperFrames Render refused this project because it contains a symlink or junction. Copy those assets into the project folder and try again.');
  }

  if (stats.isDirectory()) {
    await fs.ensureDir(targetPath);
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnoreStageEntry(entry.name)) {
        currentState.ignoredEntries.push(path.join(relativePath, entry.name));
        continue;
      }
      await copyCompositionProjectSafely(sourceRoot, stagedRoot, activeLimits, currentState, path.join(relativePath, entry.name));
    }
    return currentState;
  }

  if (!stats.isFile()) {
    currentState.ignoredEntries.push(relativePath || path.basename(sourcePath));
    return currentState;
  }

  currentState.fileCount += 1;
  currentState.totalBytes += Number(stats.size || 0);
  if (currentState.fileCount > activeLimits.maxFiles) {
    throw new Error('HyperFrames Render refused this project because it has more files than the first-version staging limit.');
  }
  if (currentState.totalBytes > activeLimits.maxTotalBytes) {
    throw new Error('HyperFrames Render refused this project because it is larger than the first-version staging limit.');
  }

  await fs.ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
  return currentState;
}

async function scanStagedCompositionForRemoteReferences(stagedRoot, limits = {}) {
  const activeLimits = mergeStagingLimits(limits);
  const findings = [];
  const scannedFiles = [];
  async function visit(currentPath) {
    const stats = await fs.lstat(currentPath);
    if (isReparsePointStats(stats)) {
      throw new Error('HyperFrames Render refused the staged project because it contains a symlink or junction.');
    }
    if (stats.isDirectory()) {
      const entries = await fs.readdir(currentPath);
      for (const entry of entries) {
        await visit(path.join(currentPath, entry));
      }
      return;
    }
    if (!stats.isFile()) return;
    const extension = path.extname(currentPath).toLowerCase();
    if (!TEXT_SCAN_EXTENSIONS.has(extension)) return;
    const buffer = await fs.readFile(currentPath);
    const text = buffer.slice(0, activeLimits.maxScannedTextBytesPerFile).toString('utf8');
    const relative = path.relative(stagedRoot, currentPath);
    scannedFiles.push({ extension, relative });
    if (/https?:\/\//i.test(text)) {
      findings.push({ category: 'remote-http-reference', extension });
    }
    if (/\bdata:/i.test(text)) {
      findings.push({ category: 'data-url-reference', extension });
    }
  }

  await visit(stagedRoot);
  if (findings.length) {
    const error = new Error(HYPERFRAMES_LOCAL_ASSETS_ERROR);
    error.code = 'HYPERFRAMES_REMOTE_REFERENCE';
    error.findings = findings;
    throw error;
  }
  return {
    localOnly: true,
    scannedFileCount: scannedFiles.length,
    scannedExtensions: [...new Set(scannedFiles.map((entry) => entry.extension))].sort(),
  };
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function sanitizeCliText(value, options = {}) {
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : '';
  const managedRoot = options.managedRoot ? path.resolve(options.managedRoot) : '';
  return stripAnsi(value)
    .replace(/https?:\/\/\S+/gi, '[remote-reference]')
    .replace(/data:[^\s"')]+/gi, '[data-reference]')
    .replace(/[A-Za-z]:\\[^\r\n\t"']+/g, (match) => {
      const resolved = path.resolve(match.trim());
      if ((sourceRoot && isPathInside(sourceRoot, resolved)) || (managedRoot && isPathInside(managedRoot, resolved))) {
        return '[local-path]';
      }
      return '[local-path]';
    })
    .replace(/(token|secret|password|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12)
    .join('\n');
}

function buildCliSummary(result, options = {}) {
  return {
    code: Number(result?.code || 0) || 0,
    stderrTail: sanitizeCliText(result?.stderr || '', options),
    stdoutTail: sanitizeCliText(result?.stdout || '', options),
  };
}

function buildHyperFramesLintFailureMessage(lintSummary = {}) {
  const details = [];
  details.push('Lint phase: hyperframes lint --json.');
  const combinedTail = [lintSummary.stderrTail, lintSummary.stdoutTail]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .join('\n');
  if (combinedTail) {
    details.push('Lint details: ' + combinedTail.slice(0, 3000));
  } else {
    details.push('HyperFrames did not emit specific lint details on stdout or stderr.');
  }
  return 'HyperFrames lint found a problem in this composition. Fix the local project, then run the pipeline again. ' + details.join(' ');
}

function parseRational(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d+)\/(\d+)$/);
  if (match) {
    const numerator = Number(match[1]) || 0;
    const denominator = Number(match[2]) || 0;
    return denominator > 0 ? numerator / denominator : 0;
  }
  return Number(text) || 0;
}

async function probeRenderedMp4(outputPath, runtimeContext = {}) {
  const ffmpegPaths = runtimeContext.ffmpegReadiness?.paths || resolveManagedFfmpegPaths();
  const result = await runCommand(ffmpegPaths.ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,duration:format=duration,size',
    '-of', 'json',
    outputPath,
  ], {
    allowFailure: true,
    timeoutMs: 30000,
    errorMessage: 'Local AI Hub could not inspect the HyperFrames MP4 output.',
  });
  if (Number(result.code || 0) !== 0) {
    throw new Error('HyperFrames finished, but Local AI Hub could not verify the MP4 video stream.');
  }
  let payload = null;
  try {
    payload = JSON.parse(String(result.stdout || '{}'));
  } catch {
    throw new Error('HyperFrames finished, but Local AI Hub could not read the MP4 video metadata.');
  }
  const stream = Array.isArray(payload.streams) ? payload.streams[0] || {} : {};
  const format = payload.format || {};
  const summary = {
    durationSeconds: Number(stream.duration || format.duration || 0) || 0,
    fps: parseRational(stream.avg_frame_rate || stream.r_frame_rate),
    height: Number(stream.height || 0) || 0,
    sizeBytes: Number(format.size || 0) || 0,
    width: Number(stream.width || 0) || 0,
  };
  if (summary.width <= 0 || summary.height <= 0 || summary.fps <= 0 || summary.durationSeconds <= 0) {
    throw new Error('HyperFrames finished, but the MP4 output did not contain a sensible video stream.');
  }
  return summary;
}

function buildHyperFramesRenderMetadata(options = {}) {
  return {
    browserGpu: false,
    cancel: Boolean(options.cancelled),
    ffmpegVersion: String(options.runtimeContext?.ffmpegReadiness?.ffmpegVersion || '').split(/\r?\n/)[0],
    ffprobeVersion: String(options.runtimeContext?.ffmpegReadiness?.ffprobeVersion || '').split(/\r?\n/)[0],
    format: HYPERFRAMES_RENDER_FORMAT,
    fps: options.settings.fps,
    hyperframesVersion: HYPERFRAMES_VERSION,
    lintStatus: options.lintStatus || 'passed',
    localOnly: true,
    nodeVersion: String(options.runtimeContext?.runtime?.nodeVersion || '').trim(),
    operationId: HYPERFRAMES_RENDER_OPERATION_ID,
    outputSizeBytes: Number(options.outputSizeBytes || 0) || 0,
    probe: options.probeSummary || null,
    project: {
      fileCount: Number(options.stagingSummary?.fileCount || 0) || 0,
      ignoredEntryCount: Number(options.stagingSummary?.ignoredEntries?.length || 0) || 0,
      sourceFileName: 'index.html',
      totalBytes: Number(options.stagingSummary?.totalBytes || 0) || 0,
    },
    quality: options.settings.quality,
    renderDurationMs: Number(options.renderDurationMs || 0) || 0,
    renderSummary: options.renderSummary || null,
    lintSummary: options.lintSummary || null,
    timeout: Boolean(options.timedOut),
    toolId: HYPERFRAMES_TOOL_ID,
    workers: HYPERFRAMES_RENDER_WORKERS,
  };
}

function buildRenderArgs(stagedProjectRoot, outputPath, settings) {
  return [
    'render',
    '--composition', '.',
    '--output', outputPath,
    '--fps', String(settings.fps),
    '--quality', settings.quality,
    '--format', HYPERFRAMES_RENDER_FORMAT,
    '--workers', String(HYPERFRAMES_RENDER_WORKERS),
    '--no-browser-gpu',
    '--quiet',
    stagedProjectRoot,
  ];
}

async function renderHyperFramesComposition(input, options = {}) {
  const settings = assertSupportedHyperFramesRenderSettings(options.config || {});
  const runtimeContext = options.runtimeContext || await getManagedHyperFramesExecutionRuntime(options.toolState || {}, { logger: options.logger || null });
  const trustedInput = assertTrustedCompositionArtifact(input, {
    allowDirectLocalIndexHtmlArtifact: Boolean(options.allowDirectLocalIndexHtmlArtifact),
    runDirectories: options.runDirectories || {},
  });
  const projectRoot = trustedInput.projectRoot;
  const indexPath = trustedInput.filePath;

  if (!(await fs.pathExists(indexPath))) {
    throw new Error('The selected HyperFrames index.html file could not be found anymore. Choose it again and try the pipeline one more time.');
  }
  await assertRealPathInside(projectRoot, indexPath, 'HyperFrames Render refused this project because index.html crosses a symlink or junction.');

  const runDirectories = options.runDirectories || {};
  const outputRoot = runDirectories.artifactsDir || path.join(runtimeContext.paths.tempDir, 'pipeline-artifacts');
  await fs.ensureDir(outputRoot);
  const operationId = sanitizeSegment(options.nodeId || `hyperframes-${Date.now()}`, 'hyperframes-render');
  const randomId = crypto.randomBytes(6).toString('hex');
  const workRoot = path.join(runtimeContext.paths.tempDir, 'pipeline-renders', `${operationId}-${randomId}`);
  const stagedRoot = path.join(workRoot, 'project');
  const outputDir = path.join(outputRoot, `hyperframes-render-${operationId}-${randomId}`);
  const outputPath = path.join(outputDir, 'hyperframes-render.mp4');
  assertPathInside(runtimeContext.paths.tempDir, workRoot, 'Local AI Hub refused to stage HyperFrames outside its managed temp folder.');
  assertPathInside(outputRoot, outputDir, 'Local AI Hub refused to write HyperFrames output outside the pipeline run folder.');

  const startedAt = Date.now();
  let lintSummary = null;
  let renderSummary = null;
  try {
    await fs.ensureDir(stagedRoot);
    await fs.ensureDir(outputDir);
    const stagingSummary = await copyCompositionProjectSafely(projectRoot, stagedRoot, options.limits || {});
    await assertRealPathInside(workRoot, path.join(stagedRoot, 'index.html'), 'Local AI Hub refused to stage a HyperFrames project that crosses a symlink or junction.');
    const localScan = await scanStagedCompositionForRemoteReferences(stagedRoot, options.limits || {});

    options.reportProgress?.({ stage: 'linting', message: 'Checking the HyperFrames composition.' });
    const lintResult = await runHyperFramesCli(runtimeContext.paths, runtimeContext.runtime, ['lint', '--json', stagedRoot], {
      allowFailure: true,
      browserExecutablePath: runtimeContext.browserExecutablePath,
      cwd: stagedRoot,
      errorMessage: 'Local AI Hub could not lint the HyperFrames composition.',
      signal: options.cancelSignal || null,
      timeoutMs: 2 * 60 * 1000,
    });
    lintSummary = buildCliSummary(lintResult, { managedRoot: runtimeContext.paths.installDir, sourceRoot: projectRoot });
    if (Number(lintResult.code || 0) !== 0) {
      const lintError = new Error(buildHyperFramesLintFailureMessage(lintSummary));
      lintError.code = 'HYPERFRAMES_LINT_FAILED';
      lintError.hyperFramesLint = lintSummary;
      throw lintError;
    }

    options.reportProgress?.({ stage: 'rendering', message: 'Rendering the HyperFrames composition to MP4.' });
    const renderResult = await runHyperFramesCli(runtimeContext.paths, runtimeContext.runtime, buildRenderArgs(stagedRoot, outputPath, settings), {
      browserExecutablePath: runtimeContext.browserExecutablePath,
      cwd: stagedRoot,
      errorMessage: 'Local AI Hub could not render the HyperFrames composition.',
      signal: options.cancelSignal || null,
      timeoutMs: options.timeoutMs || HYPERFRAMES_RENDER_TIMEOUT_MS,
    });
    renderSummary = buildCliSummary(renderResult, { managedRoot: runtimeContext.paths.installDir, sourceRoot: projectRoot });

    const outputStats = await fs.stat(outputPath).catch(() => null);
    if (!outputStats || outputStats.size <= 0) {
      throw new Error('HyperFrames finished, but it did not produce a non-empty MP4 output.');
    }
    const probeSummary = await probeRenderedMp4(outputPath, runtimeContext);
    const renderMetadata = buildHyperFramesRenderMetadata({
      lintStatus: 'passed',
      lintSummary,
      localScan,
      outputSizeBytes: outputStats.size,
      probeSummary,
      renderDurationMs: Date.now() - startedAt,
      renderSummary,
      runtimeContext,
      settings,
      stagingSummary,
    });
    const artifact = await buildFileArtifact(outputPath, {
      displayName: options.displayName || 'HyperFrames render',
      hyperFramesRender: renderMetadata,
      kind: 'video',
      role: 'generated',
    });
    artifact.hyperFramesRender = renderMetadata;
    artifact.metadataPaths = await saveVideoArtifactMetadata(outputPath, artifact);
    return {
      artifact,
      message: `HyperFrames rendered index.html to MP4 at ${settings.fps} FPS using ${settings.quality} quality.`,
      metadata: renderMetadata,
      outputPath,
      probeSummary,
      stagedRoot,
      workRoot,
    };
  } finally {
    await fs.remove(workRoot).catch(() => null);
  }
}

module.exports = {
  DEFAULT_STAGING_LIMITS,
  HYPERFRAMES_LOCAL_ASSETS_ERROR,
  HYPERFRAMES_RENDER_BROWSER_GPU,
  HYPERFRAMES_RENDER_FORMAT,
  HYPERFRAMES_RENDER_FPS_VALUES,
  HYPERFRAMES_RENDER_NODE_TYPE,
  HYPERFRAMES_RENDER_OPERATION_ID,
  HYPERFRAMES_RENDER_QUALITY_VALUES,
  HYPERFRAMES_RENDER_TIMEOUT_MS,
  HYPERFRAMES_RENDER_WARNING,
  HYPERFRAMES_RENDER_WORKERS,
  assertSupportedHyperFramesRenderSettings,
  assertTrustedCompositionArtifact,
  buildCliSummary,
  buildHyperFramesLintFailureMessage,
  buildHyperFramesRenderMetadata,
  buildRenderArgs,
  copyCompositionProjectSafely,
  normalizeHyperFramesRenderSettings,
  probeRenderedMp4,
  renderHyperFramesComposition,
  sanitizeCliText,
  scanStagedCompositionForRemoteReferences,
};
