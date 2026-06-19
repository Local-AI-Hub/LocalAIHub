const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  BUILT_IN_TEMPLATES,
  createHyperFramesProject,
  getHyperFramesProjectsRoot,
  prepareHyperFramesProjectForPipeline,
  validateTemplate,
} = require('../electron/services/hyperFramesProjectService');
const {
  probeRenderedMp4,
  renderHyperFramesComposition,
} = require('../electron/services/hyperFramesRenderService');
const { getManagedHyperFramesExecutionRuntime } = require('../electron/services/hyperFramesService');
const { resolveManagedFfmpegPaths } = require('../electron/services/managedFfmpegService');

const SMOKE_ROOT = 'D:\\LocalAIHub-HyperFrames-Template-Animation-Smoke';
const DEFAULT_INSTALL_ROOT = 'D:\\LocalAIHub';
const MIN_ADJACENT_MEAN_DIFF = 1.0;
const MIN_MAX_MEAN_DIFF = 2.0;
const RENDER_CONFIG = Object.freeze({ fps: 30, quality: 'draft', workers: 1, browserGpu: false, format: 'mp4' });
const CACHE_PATHS_TO_GUARD = Object.freeze([
  'C:\\Users\\Dell.cache\\hyperframes\\chrome',
  'C:\\Users\\Dell\\.cache\\hyperframes\\chrome',
]);

const runDirectories = Object.freeze({
  root: SMOKE_ROOT,
  artifactsDir: path.join(SMOKE_ROOT, 'artifacts'),
  outputsDir: path.join(SMOKE_ROOT, 'outputs'),
});

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

async function snapshotDirectoryMetadata(rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  if (!(await fs.pathExists(resolvedRoot))) {
    return { exists: false, fileCount: 0, totalBytes: 0, latestWriteMs: 0, digest: '' };
  }
  const entries = [];
  async function visit(currentPath) {
    const stats = await fs.lstat(currentPath);
    const relative = path.relative(resolvedRoot, currentPath).replace(/\\/g, '/');
    entries.push([relative, stats.isDirectory() ? 'dir' : 'file', Number(stats.size || 0), Math.round(Number(stats.mtimeMs || 0))].join('|'));
    if (!stats.isDirectory()) return;
    const children = await fs.readdir(currentPath);
    for (const child of children.sort()) await visit(path.join(currentPath, child));
  }
  await visit(resolvedRoot);
  const fileEntries = entries.filter((entry) => entry.includes('|file|'));
  return {
    exists: true,
    fileCount: fileEntries.length,
    totalBytes: fileEntries.reduce((total, entry) => total + Number(entry.split('|')[2] || 0), 0),
    latestWriteMs: Math.max(0, ...entries.map((entry) => Number(entry.split('|')[3] || 0))),
    digest: hashText(entries.join('\n')),
  };
}

async function snapshotGuardedCaches() {
  const output = {};
  for (const cachePath of CACHE_PATHS_TO_GUARD) {
    output[cachePath] = await snapshotDirectoryMetadata(cachePath);
  }
  return output;
}

function assertCacheSnapshotsEqual(before, after) {
  for (const cachePath of CACHE_PATHS_TO_GUARD) {
    assert.deepStrictEqual(after[cachePath], before[cachePath], `${cachePath} changed during the controlled HyperFrames render smoke.`);
  }
}

async function hashProjectFiles(projectDir) {
  const records = [];
  async function visit(currentPath) {
    const stats = await fs.lstat(currentPath);
    const relative = path.relative(projectDir, currentPath).replace(/\\/g, '/');
    if (stats.isDirectory()) {
      const children = await fs.readdir(currentPath);
      for (const child of children.sort()) await visit(path.join(currentPath, child));
      return;
    }
    if (!stats.isFile()) return;
    const buffer = await fs.readFile(currentPath);
    records.push(`${relative}|${buffer.length}|${crypto.createHash('sha256').update(buffer).digest('hex')}`);
  }
  await visit(projectDir);
  return hashText(records.sort().join('\n'));
}

function sampleFrame(ffmpegPath, videoPath, timestamp, width, height) {
  const result = spawnSync(ffmpegPath, [
    '-v', 'error',
    '-ss', timestamp.toFixed(3),
    '-i', videoPath,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: width * height * 3 + 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Managed FFmpeg could not extract a frame at ${timestamp.toFixed(3)}s from ${path.basename(videoPath)}: ${String(result.stderr || '').trim()}`);
  }
  const expectedBytes = width * height * 3;
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length < expectedBytes) {
    throw new Error(`Managed FFmpeg returned ${result.stdout?.length || 0} frame bytes, expected ${expectedBytes}.`);
  }
  return result.stdout.subarray(0, expectedBytes);
}

function meanAbsolutePixelDifference(first, second) {
  const length = Math.min(first.length, second.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += Math.abs(first[index] - second[index]);
  }
  return total / Math.max(1, length);
}

function assertTemporalMotion(templateId, samples, diffs, probe) {
  const [earlyMiddle, middleLate, earlyLate] = diffs;
  const maxDiff = Math.max(...diffs);
  const diagnostics = JSON.stringify({
    templateId,
    sampledTimestamps: samples,
    frameDimensions: { width: probe.width, height: probe.height },
    meanAbsolutePixelDifferences: { earlyMiddle, middleLate, earlyLate, maxDiff },
    thresholds: { minAdjacent: MIN_ADJACENT_MEAN_DIFF, minMax: MIN_MAX_MEAN_DIFF },
  });
  assert(earlyMiddle >= MIN_ADJACENT_MEAN_DIFF, `Early/middle frames are too similar. ${diagnostics}`);
  assert(middleLate >= MIN_ADJACENT_MEAN_DIFF, `Middle/late frames are too similar. ${diagnostics}`);
  assert(maxDiff >= MIN_MAX_MEAN_DIFF, `Sampled frames do not show material motion. ${diagnostics}`);
}

function getRuntimeOptions() {
  return fs.existsSync(path.join(DEFAULT_INSTALL_ROOT, 'tools', 'hyperframes', 'runtime'))
    ? { installRoot: DEFAULT_INSTALL_ROOT }
    : {};
}

async function renderTemplate(template, runtimeContext, ffmpegPaths) {
  await validateTemplate(template.id);
  const created = await createHyperFramesProject({ templateId: template.id, displayName: `Temporal ${template.id}` }, { managedRoot: SMOKE_ROOT });
  const prepared = await prepareHyperFramesProjectForPipeline(created.project.projectId, { managedRoot: SMOKE_ROOT });
  const projectDir = path.dirname(prepared.artifact.filePath);
  const projectHashBefore = await hashProjectFiles(projectDir);
  const render = await renderHyperFramesComposition({ artifact: prepared.artifact, sourceNode: { type: 'hyperframesProjectInput' } }, {
    config: RENDER_CONFIG,
    displayName: `Temporal ${template.id}`,
    runDirectories,
    runtimeContext,
    timeoutMs: 15 * 60 * 1000,
  });
  const projectHashAfter = await hashProjectFiles(projectDir);
  assert.strictEqual(projectHashAfter, projectHashBefore, `${template.id} source project files changed during render.`);

  const outputStats = await fs.stat(render.outputPath);
  assert(outputStats.size > 0, `${template.id} MP4 should exist and be non-empty.`);
  const probe = await probeRenderedMp4(render.outputPath, runtimeContext);
  assert(probe.width > 0 && probe.height > 0, `${template.id} MP4 should have dimensions.`);
  assert(probe.fps > 0, `${template.id} MP4 should report FPS.`);
  assert(probe.durationSeconds > 0, `${template.id} MP4 should report duration.`);

  const samples = [
    Math.min(0.35, Math.max(0.05, probe.durationSeconds - 0.05)),
    Math.max(0.7, probe.durationSeconds / 2),
    Math.max(0.5, probe.durationSeconds - 0.5),
  ].map((time) => Math.min(time, Math.max(0.05, probe.durationSeconds - 0.05)));
  const frames = samples.map((timestamp) => sampleFrame(ffmpegPaths.ffmpegPath, render.outputPath, timestamp, probe.width, probe.height));
  const diffs = [
    meanAbsolutePixelDifference(frames[0], frames[1]),
    meanAbsolutePixelDifference(frames[1], frames[2]),
    meanAbsolutePixelDifference(frames[0], frames[2]),
  ];
  assertTemporalMotion(template.id, samples, diffs, probe);

  return {
    templateId: template.id,
    outputSizeBytes: outputStats.size,
    probe,
    sampledTimestamps: samples,
    meanAbsolutePixelDifferences: diffs,
    sourceUnchanged: true,
  };
}

async function renderTrustedFileInput(runtimeContext) {
  const template = BUILT_IN_TEMPLATES.find((entry) => entry.id === 'animated-title-card') || BUILT_IN_TEMPLATES[0];
  const created = await createHyperFramesProject({ templateId: template.id, displayName: 'Temporal File Input' }, { managedRoot: SMOKE_ROOT });
  const prepared = await prepareHyperFramesProjectForPipeline(created.project.projectId, { managedRoot: SMOKE_ROOT });
  const render = await renderHyperFramesComposition({ artifact: prepared.artifact, sourceNode: { type: 'fileInput' } }, {
    config: RENDER_CONFIG,
    displayName: 'Temporal File Input flow',
    runDirectories,
    runtimeContext,
    timeoutMs: 15 * 60 * 1000,
  });
  const probe = await probeRenderedMp4(render.outputPath, runtimeContext);
  assert(probe.width > 0 && probe.height > 0 && probe.durationSeconds > 0, 'Trusted File Input -> HyperFrames Render flow should render a valid MP4.' );
  return { outputPath: render.outputPath, probe };
}

async function main() {
  await fs.remove(SMOKE_ROOT);
  await fs.ensureDir(runDirectories.artifactsDir);
  const cacheBefore = await snapshotGuardedCaches();
  let success = false;
  try {
    const runtimeContext = await getManagedHyperFramesExecutionRuntime({}, getRuntimeOptions());
    const ffmpegPaths = resolveManagedFfmpegPaths();
    const projectsRoot = getHyperFramesProjectsRoot({ managedRoot: SMOKE_ROOT });
    assert.strictEqual(projectsRoot, path.join(SMOKE_ROOT, 'projects', 'hyperframes'), 'Smoke projects must live under the explicit test-owned managed root.');
    const results = [];
    for (const template of BUILT_IN_TEMPLATES) {
      results.push(await renderTemplate(template, runtimeContext, ffmpegPaths));
    }
    const fileInputResult = await renderTrustedFileInput(runtimeContext);
    const cacheAfter = await snapshotGuardedCaches();
    assertCacheSnapshotsEqual(cacheBefore, cacheAfter);
    success = true;
    console.log(JSON.stringify({
      message: 'HyperFrames starter template temporal animation verification passed.',
      smokeRoot: SMOKE_ROOT,
      thresholds: { minAdjacentMeanDiff: MIN_ADJACENT_MEAN_DIFF, minMaxMeanDiff: MIN_MAX_MEAN_DIFF },
      templates: results,
      trustedFileInput: fileInputResult.probe,
      guardedCaches: cacheAfter,
    }, null, 2));
  } finally {
    if (success) {
      const resolvedSmokeRoot = path.resolve(SMOKE_ROOT);
      if (resolvedSmokeRoot !== path.resolve(SMOKE_ROOT) || path.basename(resolvedSmokeRoot) !== 'LocalAIHub-HyperFrames-Template-Animation-Smoke') {
        throw new Error(`Refusing to clean unexpected smoke root: ${resolvedSmokeRoot}`);
      }
      await fs.remove(resolvedSmokeRoot);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
