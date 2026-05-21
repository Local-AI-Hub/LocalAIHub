const fs = require('fs-extra');
const path = require('path');
let app = null;
try {
  ({ app } = require('electron'));
} catch {
  app = null;
}

const { runCommand } = require('./commandService');
const { buildLaunchRuntimeEnv, summarizeLaunchRuntimeEnv } = require('./processService');
const { createLogger } = require('./logService');
const { buildFileArtifact, summarizeArtifact } = require('./pipelineArtifactService');
const { PORT_KIND_IMAGE } = require('../shared/pipelineSchema.cjs');

const LOCAL_IMAGE_RUNTIME_MODE_IDS = Object.freeze({
  DIRECT_COMMAND: 'direct-command',
});

const UPSCAYL_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

const LOCAL_IMAGE_TOOL_ADAPTERS = Object.freeze({
  facefusion: Object.freeze({
    helperScript: 'run_facefusion_pipeline_task.py',
    label: 'FaceFusion',
    runtimeMode: LOCAL_IMAGE_RUNTIME_MODE_IDS.DIRECT_COMMAND,
  }),
  upscayl: Object.freeze({
    label: 'Upscayl',
    runtimeMode: LOCAL_IMAGE_RUNTIME_MODE_IDS.DIRECT_COMMAND,
  }),
});

function getHelperScriptPath(toolId) {
  const adapter = LOCAL_IMAGE_TOOL_ADAPTERS[String(toolId || '').trim().toLowerCase()] || null;
  const helperScript = String(adapter?.helperScript || '').trim();
  if (!helperScript) {
    return '';
  }

  return app?.isPackaged
    ? path.join(process.resourcesPath, 'helpers', helperScript)
    : path.join(__dirname, '..', 'helpers', helperScript);
}

function firstNonEmptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function parseLastJsonLine(value) {
  const line = String(value || '')
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.trim().startsWith('{'));
  if (!line) {
    return null;
  }

  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isFaceFusionProgressOnlyLine(value) {
  return /\[FACEFUSION\.CORE\]\s+processing step \d+ of \d+/i.test(String(value || '').trim());
}
function buildUsefulCommandMessage(commandResult, fallbackMessage) {
  const combined = [commandResult?.stderr, commandResult?.stdout]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .join('\n');
  const jsonMessage = String(parseLastJsonLine(commandResult?.stderr)?.message || parseLastJsonLine(commandResult?.stdout)?.message || '').trim();
  const missingModule = combined.match(/ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/i);
  if (missingModule?.[1]) {
    if (missingModule[1].toLowerCase() === 'cv2') {
      return 'FaceFusion is missing OpenCV (cv2). Run Repair to reinstall the opencv-python dependency required by this FaceFusion version.';
    }
    if (missingModule[1].toLowerCase() === 'onnxruntime') {
      return 'FaceFusion is missing ONNX Runtime (onnxruntime). Run Repair to reinstall the ONNX Runtime dependency declared by this FaceFusion version.';
    }
    return 'FaceFusion is missing the Python package "' + missingModule[1] + '". Run Repair to rebuild its managed Python environment.';
  }

  if (jsonMessage && !/^Traceback(?:\s|$)/i.test(jsonMessage) && !isFaceFusionProgressOnlyLine(jsonMessage)) {
    return jsonMessage;
  }

  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const usefulLine = [...lines].reverse().find((line) => {
    if (/^Traceback/i.test(line) || /^File "/i.test(line) || /^\{.*"message"\s*:\s*"Traceback/i.test(line) || isFaceFusionProgressOnlyLine(line)) {
      return false;
    }
    return /Error:|Exception:|No module named|failed|not found|timed out|cancelled|aborted/i.test(line);
  });

  const firstLine = firstNonEmptyLine(combined);
  return usefulLine
    || (!/^Traceback(?:\s|$)/i.test(jsonMessage) && !isFaceFusionProgressOnlyLine(jsonMessage) ? jsonMessage : '')
    || (!/^Traceback/i.test(firstLine) && !/^\{.*"message"\s*:\s*"Traceback/i.test(firstLine) && !isFaceFusionProgressOnlyLine(firstLine) ? firstLine : '')
    || fallbackMessage;
}

function getLocalImageToolRuntimeMode(toolId) {
  return LOCAL_IMAGE_TOOL_ADAPTERS[String(toolId || '').trim().toLowerCase()]?.runtimeMode || '';
}

function getLocalImageToolLabel(tool) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  return LOCAL_IMAGE_TOOL_ADAPTERS[toolId]?.label || String(tool?.name || 'This local image tool').trim() || 'This local image tool';
}

function resolveLocalImageToolRoot(tool) {
  const rawToolRoot = String(tool?.appDir || tool?.installDir || '').trim();
  if (!rawToolRoot) {
    throw new Error(getLocalImageToolLabel(tool) + ' does not have a usable local install folder yet. Reinstall the tool, then try this pipeline step again.');
  }

  return path.resolve(rawToolRoot);
}

async function resolveLocalImagePythonPath(tool) {
  const candidates = [
    tool?.launchProfile?.pythonPath,
    tool?.managedPythonPath,
    tool?.venvDir ? path.join(tool.venvDir, 'Scripts', 'python.exe') : '',
    tool?.pythonBootstrapPath,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate.includes('\\') && !candidate.includes('/')) {
      return candidate;
    }

    if (await fs.pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error('Local AI Hub could not find the Python runtime for ' + getLocalImageToolLabel(tool) + '. Repair or reinstall the tool, then try again.');
}

function sanitizeLabelSegment(value, fallback) {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

function buildJsonRequestPath(runDirectories, nodeLabel, requestKind = 'image-step') {
  return path.join(runDirectories.artifactsDir, `${sanitizeLabelSegment(nodeLabel, 'image-step')}-${Date.now()}.${requestKind}.json`);
}

function buildImageOutputPath(runDirectories, nodeLabel, suffix = 'png') {
  return path.join(runDirectories.artifactsDir, `${sanitizeLabelSegment(nodeLabel, 'image-step')}-${Date.now()}.${suffix}`);
}

function getImageFileExtension(filePath, fallback = 'png') {
  const extension = path.extname(String(filePath || '').trim()).replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(extension) ? extension : fallback;
}

function parseCommandJson(stdout, toolLabel) {
  const lastLine = String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find(Boolean);

  if (!lastLine) {
    throw new Error(toolLabel + ' finished, but it did not return a readable result.');
  }

  try {
    return JSON.parse(lastLine);
  } catch {
    const diagnostic = buildUsefulCommandMessage({ stdout }, '');
    throw new Error(diagnostic || toolLabel + ' finished, but Local AI Hub could not read its result.');
  }
}

function buildImageSourceReference(sourceImageArtifact) {
  if (!sourceImageArtifact) {
    return null;
  }

  return {
    displayName: String(sourceImageArtifact.displayName || '').trim(),
    fileName: String(sourceImageArtifact.fileName || '').trim(),
    filePath: String(sourceImageArtifact.filePath || '').trim(),
    fileUrl: String(sourceImageArtifact.fileUrl || '').trim(),
    formatLabel: String(sourceImageArtifact.formatLabel || '').trim(),
    kind: String(sourceImageArtifact.kind || '').trim(),
    mimeType: String(sourceImageArtifact.mimeType || '').trim(),
    sizeBytes: Number(sourceImageArtifact.sizeBytes || 0) || 0,
    summary: String(sourceImageArtifact.summary || '').trim(),
  };
}

async function runLocalImageTask(tool, payload, reportProgress, progressMessages = {}) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  const toolLabel = getLocalImageToolLabel(tool);
  const helperScript = getHelperScriptPath(toolId);
  if (!helperScript || !(await fs.pathExists(helperScript))) {
    throw new Error('Local AI Hub is missing its ' + toolLabel + ' helper script. Reinstall the app to restore it.');
  }

  const pythonPath = await resolveLocalImagePythonPath(tool);
  const toolRoot = resolveLocalImageToolRoot(tool);
  const logger = createLogger('pipeline-local-image', {
    toolId: tool?.id || 'local-image-tool',
  });

  const requestPath = String(payload.requestPath || '').trim();
  if (!requestPath) {
    throw new Error('Local AI Hub could not prepare the local image request file.');
  }

  await fs.writeJson(requestPath, payload, { spaces: 2 });
  reportProgress?.(
    progressMessages.start || ('Starting ' + toolLabel + ' for this image step.'),
    progressMessages.run || ('Running ' + (payload.nodeLabel || 'this step') + ' with ' + toolLabel + '...'),
  );

  const runtimeEnv = await buildLaunchRuntimeEnv(tool, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }, { launchProfile: tool?.launchProfile || null });
  await logger.info?.('Local image helper launch environment prepared.', {
    launchEnvironment: summarizeLaunchRuntimeEnv(runtimeEnv),
  });
  const commandResult = await runCommand(pythonPath, [helperScript, requestPath], {
    allowFailure: true,
    cwd: toolRoot,
    env: runtimeEnv,
    replaceEnv: true,
  });

  if (Number(commandResult.code || 0) !== 0) {
    const message = buildUsefulCommandMessage(commandResult, toolLabel + ' could not finish the local image request.');
    await logger.warn('Local image helper failed.', {
      message,
      stderr: String(commandResult.stderr || '').trim(),
      stdout: String(commandResult.stdout || '').trim(),
    });
    throw new Error(message);
  }

  return parseCommandJson(commandResult.stdout, toolLabel);
}

async function walkForFileNames(rootPath, fileNames = [], maxDepth = 3, currentDepth = 0) {
  if (!rootPath || currentDepth > maxDepth || !(await fs.pathExists(rootPath))) {
    return '';
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && fileNames.includes(entry.name.toLowerCase())) {
      return path.join(rootPath, entry.name);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nestedPath = await walkForFileNames(path.join(rootPath, entry.name), fileNames, maxDepth, currentDepth + 1);
    if (nestedPath) {
      return nestedPath;
    }
  }

  return '';
}

function isUpscaylTransformExecutable(candidatePath) {
  const executableName = path.basename(String(candidatePath || '').trim()).toLowerCase();
  return [
    'upscayl-bin.exe',
    'realesrgan-ncnn-vulkan.exe',
    'realcugan-ncnn-vulkan.exe',
  ].includes(executableName);
}

async function resolveUpscaylBinary(tool, toolRoot) {
  const bundledCandidates = [
    path.join(toolRoot, 'resources', 'bin', 'upscayl-bin.exe'),
    path.join(toolRoot, 'resources', 'upscayl-bin.exe'),
    path.join(toolRoot, 'upscayl-bin.exe'),
    path.join(toolRoot, 'resources', 'bin', 'realesrgan-ncnn-vulkan.exe'),
    path.join(toolRoot, 'resources', 'realesrgan-ncnn-vulkan.exe'),
    path.join(toolRoot, 'realesrgan-ncnn-vulkan.exe'),
    path.join(toolRoot, 'resources', 'bin', 'realcugan-ncnn-vulkan.exe'),
    path.join(toolRoot, 'realcugan-ncnn-vulkan.exe'),
  ];
  const explicitCliCandidates = [
    tool?.launchProfile?.executable,
    tool?.executablePath,
  ]
    .map((value) => String(value || '').trim())
    .filter((value) => value && isUpscaylTransformExecutable(value));

  for (const candidate of [...bundledCandidates, ...explicitCliCandidates]) {
    if (await fs.pathExists(candidate)) {
      return candidate;
    }
  }

  return walkForFileNames(toolRoot, [
    'upscayl-bin.exe',
    'realesrgan-ncnn-vulkan.exe',
    'realcugan-ncnn-vulkan.exe',
  ], 4);
}

async function resolveUpscaylModelDirectory(toolRoot) {
  const candidates = [
    path.join(toolRoot, 'resources', 'models'),
    path.join(toolRoot, 'resources', 'bin', 'models'),
    path.join(toolRoot, 'models'),
    path.join(toolRoot, 'resources', 'app.asar.unpacked', 'models'),
  ];

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      return candidate;
    }
  }

  return '';
}

async function resolveUpscaylModelName(modelsDirectory, requestedModel = '') {
  if (!modelsDirectory || !(await fs.pathExists(modelsDirectory))) {
    return 'realesrgan-x4plus';
  }

  const entries = await fs.readdir(modelsDirectory).catch(() => []);
  const paramNames = entries
    .filter((entry) => String(entry || '').toLowerCase().endsWith('.param'))
    .map((entry) => entry.slice(0, -6));
  const requestedName = String(requestedModel || '').trim();
  if (requestedName) {
    const requestedStem = path.basename(requestedName, path.extname(requestedName));
    const hasParam = paramNames.some((entry) => entry.toLowerCase() === requestedStem.toLowerCase());
    const hasBin = entries.some((entry) => entry.toLowerCase() === (requestedStem.toLowerCase() + '.bin'));
    if (hasParam && hasBin) {
      return requestedStem;
    }
    throw new Error('The selected Upscayl model set was not found in the Upscayl models folder. Refresh models or choose a paired .param and .bin model set.');
  }

  const preferredNames = [
    'realesrgan-x4plus',
    'realesrgan-x4plus-anime',
    'ultrasharp',
    'upscayl-standard-4x',
    'remacri',
  ];
  for (const preferredName of preferredNames) {
    if (paramNames.some((entry) => entry.toLowerCase() === preferredName.toLowerCase())) {
      return preferredName;
    }
  }

  return paramNames[0] || 'realesrgan-x4plus';
}

async function resolveUpscaylOutputFile(preferredOutputPath, outputDirectory, sourceImagePath) {
  const explicitOutputPath = path.resolve(String(preferredOutputPath || '').trim());
  if (explicitOutputPath && await fs.pathExists(explicitOutputPath)) {
    return explicitOutputPath;
  }

  const sourceBaseName = path.basename(String(sourceImagePath || '').trim(), path.extname(String(sourceImagePath || '').trim())).toLowerCase();
  const directoryEntries = await fs.readdir(outputDirectory, { withFileTypes: true }).catch(() => []);
  const imageEntries = directoryEntries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(outputDirectory, entry.name))
    .filter((entry) => ['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(entry).toLowerCase()));

  const exactMatch = imageEntries.find((entry) => path.basename(entry, path.extname(entry)).toLowerCase() === sourceBaseName);
  if (exactMatch) {
    return exactMatch;
  }

  const newestEntry = await Promise.all(imageEntries.map(async (entry) => ({
    entry,
    stat: await fs.stat(entry).catch(() => null),
  }))).then((entries) => entries
    .filter((entry) => entry.stat)
    .sort((left, right) => Number(right.stat.mtimeMs || 0) - Number(left.stat.mtimeMs || 0))[0] || null);

  return newestEntry?.entry || '';
}

async function runUpscaylCommand(executablePath, args, cwd, toolLabel, logger, tool = null, options = {}) {
  const runtimeEnv = await buildLaunchRuntimeEnv(tool, {
    UPX_NO_LOGO: '1',
  }, { launchProfile: tool?.launchProfile || null });
  const timeoutMs = Number(options.timeoutMs || 0) > 0 ? Number(options.timeoutMs) : UPSCAYL_COMMAND_TIMEOUT_MS;
  await logger.info?.('Starting Upscayl transform command.', {
    args,
    cwd,
    executablePath,
    launchEnvironment: summarizeLaunchRuntimeEnv(runtimeEnv),
    timeoutMs,
  });
  const commandResult = await runCommand(executablePath, args, {
    abortMessage: toolLabel + ' was cancelled while Local AI Hub was running this image transformation step.',
    allowFailure: true,
    cwd,
    env: runtimeEnv,
    replaceEnv: true,
    signal: options.signal || null,
    timeoutMessage: toolLabel + ' took too long to finish this image transformation step, so Local AI Hub stopped it. Try a smaller image, a lighter model, or launch Upscayl directly to test the runtime.',
    timeoutMs,
  });

  if (Number(commandResult.code || 0) === 0) {
    await logger.info?.('Upscayl transform command finished.', {
      code: Number(commandResult.code || 0),
    });
    return commandResult;
  }

  const diagnostic = buildUsefulCommandMessage(commandResult, toolLabel + ' could not finish the local image enhancement request.');
  await logger.warn('Upscayl command attempt failed.', {
    args,
    code: Number(commandResult.code || 0),
    message: diagnostic,
    stderr: String(commandResult.stderr || '').trim(),
    stdout: String(commandResult.stdout || '').trim(),
  });

  if (/timed out|cancelled|aborted/i.test(diagnostic)) {
    throw new Error(diagnostic);
  }

  return null;
}

async function generateImageWithUpscaylTool(tool, options = {}) {
  const toolLabel = getLocalImageToolLabel(tool);
  const runDirectories = options.runDirectories || null;
  if (!runDirectories?.artifactsDir) {
    throw new Error('Local AI Hub could not prepare a pipeline run folder for the transformed image output.');
  }

  const rawSourceImagePath = String(options.sourceImagePath || '').trim();
  const sourceImagePath = rawSourceImagePath ? path.resolve(rawSourceImagePath) : '';
  if (!sourceImagePath || !(await fs.pathExists(sourceImagePath))) {
    throw new Error('The source image for this Upscayl step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  const toolRoot = resolveLocalImageToolRoot(tool);
  const logger = createLogger('pipeline-local-image', {
    toolId: tool?.id || 'upscayl',
  });
  await logger.info?.('Resolving Upscayl CLI transform runtime.', {
    desktopExecutable: String(tool?.launchProfile?.executable || tool?.executablePath || '').trim(),
    toolRoot,
  });
  const executablePath = await resolveUpscaylBinary(tool, toolRoot);
  if (!executablePath) {
    throw new Error('Upscayl is installed, but Local AI Hub could not find its bundled upscaling runtime yet. Run Repair or reinstall Upscayl, then try again.');
  }

  const modelsDirectory = await resolveUpscaylModelDirectory(toolRoot);
  const modelName = await resolveUpscaylModelName(modelsDirectory, options.model);
  const transformSubtype = ['upscale', 'enhance'].includes(String(options.transformSubtype || '').trim().toLowerCase())
    ? String(options.transformSubtype || '').trim().toLowerCase()
    : 'upscale';
  const scale = Math.max(2, Number(options.scale || 4) || 4);
  const nodeLabel = String(options.nodeLabel || options.displayName || 'Image transform').trim() || 'Image transform';
  const outputDirectory = path.join(runDirectories.artifactsDir, `${sanitizeLabelSegment(nodeLabel, 'image-transform')}-${Date.now()}-upscayl`);
  await fs.ensureDir(outputDirectory);
  const preferredOutputPath = path.join(outputDirectory, `${sanitizeLabelSegment(nodeLabel, 'image-transform')}.png`);
  await logger.info?.('Prepared Upscayl transform request.', {
    executablePath,
    modelName,
    modelsDirectory,
    outputDirectory,
    preferredOutputPath,
    sourceImagePath,
    transformSubtype,
  });

  const reportProgress = options.reportProgress;
  reportProgress?.(
    'Starting Upscayl for this image transformation step.',
    'Running ' + nodeLabel + ' with ' + toolLabel + '...',
  );

  const argSets = [
    [
      '-i', sourceImagePath,
      '-o', preferredOutputPath,
      '-n', modelName,
      '-s', String(scale),
      ...(modelsDirectory ? ['-m', modelsDirectory] : []),
      '-f', 'png',
    ],
    [
      '-i', sourceImagePath,
      '-o', outputDirectory,
      '-n', modelName,
      '-s', String(scale),
      ...(modelsDirectory ? ['-m', modelsDirectory] : []),
      '-f', 'png',
    ],
  ];

  let commandResult = null;
  for (const args of argSets) {
    commandResult = await runUpscaylCommand(executablePath, args, toolRoot, toolLabel, logger, tool, {
      signal: options.cancelSignal || null,
      timeoutMs: options.timeoutMs || UPSCAYL_COMMAND_TIMEOUT_MS,
    });
    const outputPath = await resolveUpscaylOutputFile(preferredOutputPath, outputDirectory, sourceImagePath);
    if (commandResult && outputPath) {
      const artifact = await buildFileArtifact(outputPath, {
        displayName: String(options.displayName || nodeLabel || 'Image').trim() || 'Image',
        imageTransformation: {
          backend: 'upscayl',
          backendLabel: 'Upscayl',
          model: modelName,
          operationId: String(options.operationId || '').trim(),
          scale,
          sourceImage: buildImageSourceReference(options.sourceImageArtifact),
          toolId: String(tool?.id || '').trim() || 'upscayl',
          toolLabel,
          transformationType: transformSubtype,
          transformSubtype,
        },
        kind: PORT_KIND_IMAGE,
        role: 'generated',
      });
      return {
        destinationPath: artifact.filePath,
        message: toolLabel + ' enhanced the connected image locally and saved it to ' + artifact.filePath + '.',
        metadata: {
          model: modelName,
          outputPath: artifact.filePath,
          scale,
          transformationType: transformSubtype,
          transformSubtype,
        },
        outputs: {
          image: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }
  }

  const failureMessage = commandResult
    ? firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout)
    : '';
  throw new Error(failureMessage || toolLabel + ' could not finish the local image enhancement request. Check the Upscayl runtime and bundled models, then try again.');
}

async function generateImageWithFaceFusionTool(tool, options = {}) {
  const toolLabel = getLocalImageToolLabel(tool);
  const runDirectories = options.runDirectories || null;
  if (!runDirectories?.artifactsDir) {
    throw new Error('Local AI Hub could not prepare a pipeline run folder for the transformed image output.');
  }

  const rawTargetImagePath = String(options.sourceImagePath || '').trim();
  const targetImagePath = rawTargetImagePath ? path.resolve(rawTargetImagePath) : '';
  if (!targetImagePath || !(await fs.pathExists(targetImagePath))) {
    throw new Error('The target image for this FaceFusion step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  const rawReferenceImagePath = String(options.referenceImagePath || '').trim();
  const referenceImagePath = rawReferenceImagePath ? path.resolve(rawReferenceImagePath) : '';
  if (!referenceImagePath || !(await fs.pathExists(referenceImagePath))) {
    throw new Error('FaceFusion needs a source face image on the Reference Image input. Choose it again and rerun the pipeline.');
  }

  const nodeLabel = String(options.nodeLabel || options.displayName || 'Image transform').trim() || 'Image transform';
  const outputPath = buildImageOutputPath(runDirectories, nodeLabel, getImageFileExtension(targetImagePath, 'png'));
  const requestPath = buildJsonRequestPath(runDirectories, nodeLabel, 'facefusion-request');
  const response = await runLocalImageTask(tool, {
    instruction: String(options.instruction || '').trim(),
    nodeLabel,
    outputPath,
    referenceImagePath,
    requestPath,
    targetImagePath,
    toolRoot: resolveLocalImageToolRoot(tool),
  }, options.reportProgress, {
    run: 'Running ' + nodeLabel + ' with ' + toolLabel + '...',
    start: 'Starting FaceFusion for this image transformation step.',
  });

  const finalOutputPath = path.resolve(String(response?.outputPath || outputPath).trim());
  if (!(await fs.pathExists(finalOutputPath))) {
    throw new Error(toolLabel + ' reported success, but the transformed image file could not be found.');
  }

  const transformSubtype = 'face-swap';
  const artifact = await buildFileArtifact(finalOutputPath, {
    displayName: String(options.displayName || nodeLabel || 'Image').trim() || 'Image',
    imageTransformation: {
      backend: 'facefusion',
      backendLabel: 'FaceFusion',
      operationId: String(options.operationId || '').trim(),
      instruction: String(options.instruction || '').trim(),
      referenceImage: buildImageSourceReference(options.referenceImageArtifact),
      sourceImage: buildImageSourceReference(options.sourceImageArtifact),
      toolId: String(tool?.id || '').trim() || 'facefusion',
      toolLabel,
      transformationType: transformSubtype,
      transformSubtype,
    },
    kind: PORT_KIND_IMAGE,
    role: 'generated',
  });

  return {
    destinationPath: artifact.filePath,
    message: String(response?.message || toolLabel + ' transformed the connected image locally and saved it to ' + artifact.filePath + '.').trim(),
    metadata: {
      ...response,
      transformSubtype,
      transformationType: transformSubtype,
    },
    outputs: {
      image: artifact,
    },
    preview: summarizeArtifact(artifact),
  };
}

async function generateImageWithLocalImageTool(tool, options = {}) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  if (toolId === 'upscayl') {
    return generateImageWithUpscaylTool(tool, options);
  }

  if (toolId === 'facefusion') {
    return generateImageWithFaceFusionTool(tool, options);
  }

  throw new Error((tool?.name || 'This local image tool') + ' does not have a runnable local image transformation adapter in Local AI Hub yet.');
}

module.exports = {
  LOCAL_IMAGE_RUNTIME_MODE_IDS,
  generateImageWithLocalImageTool,
  getLocalImageToolRuntimeMode,
};
