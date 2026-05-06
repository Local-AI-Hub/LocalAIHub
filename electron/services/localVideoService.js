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
const { PIPELINE_OPERATION_IDS, PORT_KIND_VIDEO } = require('../shared/pipelineSchema.cjs');

const LOCAL_VIDEO_RUNTIME_MODE_IDS = Object.freeze({
  DIRECT_COMMAND: 'direct-command',
});

const LOCAL_VIDEO_TOOL_ADAPTERS = Object.freeze({
  'wan21-webui': Object.freeze({
    label: 'Wan2.1 WebUI',
    runtimeMode: LOCAL_VIDEO_RUNTIME_MODE_IDS.DIRECT_COMMAND,
  }),
});

function getHelperScriptPath() {
  return app?.isPackaged
    ? path.join(process.resourcesPath, 'helpers', 'run_wan_pipeline_task.py')
    : path.join(__dirname, '..', 'helpers', 'run_wan_pipeline_task.py');
}

function firstNonEmptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function getLocalVideoToolRuntimeMode(toolId) {
  return LOCAL_VIDEO_TOOL_ADAPTERS[String(toolId || '').trim().toLowerCase()]?.runtimeMode || '';
}

function getLocalVideoToolLabel(tool) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  return LOCAL_VIDEO_TOOL_ADAPTERS[toolId]?.label || String(tool?.name || 'This local video tool').trim() || 'This local video tool';
}

function resolveLocalVideoToolRoot(tool) {
  const rawToolRoot = String(tool?.appDir || tool?.installDir || '').trim();
  if (!rawToolRoot) {
    throw new Error(getLocalVideoToolLabel(tool) + ' does not have a usable local install folder yet. Reinstall the tool, then try this pipeline step again.');
  }

  return path.resolve(rawToolRoot);
}

async function resolveLocalVideoPythonPath(tool) {
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

  throw new Error('Local AI Hub could not find the Python runtime for ' + getLocalVideoToolLabel(tool) + '. Repair or reinstall the tool, then try again.');
}

function buildJsonRequestPath(runDirectories, nodeLabel) {
  const safeLabel = String(nodeLabel || 'video-step').trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'video-step';
  return path.join(runDirectories.artifactsDir, `${safeLabel}-${Date.now()}.wan-request.json`);
}

function buildVideoOutputPath(runDirectories, nodeLabel) {
  const safeLabel = String(nodeLabel || 'video-step').trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'video-step';
  return path.join(runDirectories.artifactsDir, `${safeLabel}-${Date.now()}.mp4`);
}

function buildSourceImageReference(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return null;
  }

  return {
    displayName: String(artifact.displayName || '').trim(),
    fileName: String(artifact.fileName || '').trim(),
    filePath: String(artifact.filePath || '').trim(),
    fileUrl: String(artifact.fileUrl || '').trim(),
    formatLabel: String(artifact.formatLabel || '').trim(),
    kind: String(artifact.kind || '').trim(),
    mimeType: String(artifact.mimeType || '').trim(),
    sizeBytes: Number(artifact.sizeBytes || 0) || 0,
    summary: String(artifact.summary || '').trim(),
  };
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
    throw new Error(toolLabel + ' finished, but Local AI Hub could not read its result.');
  }
}

async function runWanLocalVideoTask(tool, payload, reportProgress) {
  const toolLabel = getLocalVideoToolLabel(tool);
  const helperScript = getHelperScriptPath();
  if (!(await fs.pathExists(helperScript))) {
    throw new Error('Local AI Hub is missing its Wan video helper script. Reinstall the app to restore it.');
  }

  const pythonPath = await resolveLocalVideoPythonPath(tool);
  const toolRoot = resolveLocalVideoToolRoot(tool);
  const logger = createLogger('pipeline-local-video', {
    toolId: tool?.id || 'local-video-tool',
  });

  const requestPath = String(payload.requestPath || '').trim();
  if (!requestPath) {
    throw new Error('Local AI Hub could not prepare the local video request file.');
  }

  await fs.writeJson(requestPath, payload, { spaces: 2 });
  reportProgress?.(
    'Starting the local Wan video backend.',
    'Running ' + (payload.nodeLabel || 'this step') + ' with ' + toolLabel + '...',
  );

  const runtimeEnv = await buildLaunchRuntimeEnv(tool, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }, { launchProfile: tool?.launchProfile || null });
  await logger.info?.('Local video helper launch environment prepared.', {
    launchEnvironment: summarizeLaunchRuntimeEnv(runtimeEnv),
  });
  const commandResult = await runCommand(pythonPath, [helperScript, requestPath], {
    allowFailure: true,
    cwd: toolRoot,
    env: runtimeEnv,
    replaceEnv: true,
  });

  if (Number(commandResult.code || 0) !== 0) {
    const message = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout) || toolLabel + ' could not finish the local video request.';
    await logger.warn('Local video helper failed.', {
      message,
      stderr: String(commandResult.stderr || '').trim(),
      stdout: String(commandResult.stdout || '').trim(),
    });
    throw new Error(message);
  }

  return parseCommandJson(commandResult.stdout, toolLabel);
}

async function generateVideoWithWanTool(tool, options = {}) {
  const toolLabel = getLocalVideoToolLabel(tool);
  const runDirectories = options.runDirectories || null;
  if (!runDirectories?.artifactsDir) {
    throw new Error('Local AI Hub could not prepare a pipeline run folder for the local video output.');
  }

  const outputPath = buildVideoOutputPath(runDirectories, options.nodeLabel || options.displayName || 'video-step');
  const requestPath = buildJsonRequestPath(runDirectories, options.nodeLabel || options.displayName || 'video-step');
  const referenceImagePath = String(options.referenceImagePath || '').trim();
  const operationSubtype = referenceImagePath ? 'image-to-video' : 'text-to-video';
  const prompt = String(options.prompt || '').trim();
  const requestedModel = String(options.model || '').trim();
  const requestedSize = String(options.size || '1280x720').trim() || '1280x720';
  const requestedFps = Number(options.fps || 15);
  const requestedSeed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : 0;
  const requestedSteps = Math.max(1, Number(options.steps || 24) || 24);
  const response = await runWanLocalVideoTask(tool, {
    fps: requestedFps,
    generationMode: operationSubtype,
    model: requestedModel,
    negativePrompt: String(options.negativePrompt || '').trim(),
    nodeLabel: String(options.nodeLabel || options.displayName || 'Video step').trim() || 'Video step',
    outputPath,
    prompt,
    quality: Number(options.quality || 5),
    referenceImagePath,
    requestPath,
    seed: requestedSeed,
    size: requestedSize,
    steps: requestedSteps,
    toolRoot: resolveLocalVideoToolRoot(tool),
  }, options.reportProgress);

  const finalOutputPath = path.resolve(String(response?.outputPath || outputPath).trim());
  if (!(await fs.pathExists(finalOutputPath))) {
    throw new Error(toolLabel + ' reported success, but the rendered video file could not be found.');
  }

  const resolvedModel = String(response?.modelDir || requestedModel || '').trim();
  const artifact = await buildFileArtifact(finalOutputPath, {
    displayName: String(options.displayName || options.nodeLabel || 'Video').trim() || 'Video',
    kind: PORT_KIND_VIDEO,
    role: 'generated',
    videoGeneration: {
      backend: 'local-video',
      backendLabel: toolLabel,
      fps: requestedFps,
      mode: operationSubtype,
      model: resolvedModel ? path.basename(resolvedModel) : '',
      negativePrompt: String(options.negativePrompt || '').trim(),
      operationId: PIPELINE_OPERATION_IDS.VIDEO_GENERATE,
      operationSubtype,
      prompt,
      seed: requestedSeed,
      size: String(response?.size || requestedSize).trim() || requestedSize,
      sourceImage: buildSourceImageReference(options.sourceImageArtifact),
      steps: requestedSteps,
      toolId: String(tool?.id || '').trim().toLowerCase(),
      toolLabel,
      usedReferenceImage: Boolean(referenceImagePath),
    },
  });

  return {
    destinationPath: artifact.filePath,
    message: String(response?.message || toolLabel + ' generated a video locally and saved it to ' + artifact.filePath + '.').trim(),
    metadata: response,
    outputs: {
      video: artifact,
    },
    preview: summarizeArtifact(artifact),
  };
}

async function generateVideoWithLocalVideoTool(tool, options = {}) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  if (toolId === 'wan21-webui') {
    return generateVideoWithWanTool(tool, options);
  }

  throw new Error((tool?.name || 'This local video tool') + ' does not have a runnable local video adapter in Local AI Hub yet.');
}

module.exports = {
  LOCAL_VIDEO_RUNTIME_MODE_IDS,
  generateVideoWithLocalVideoTool,
  getLocalVideoToolRuntimeMode,
};
