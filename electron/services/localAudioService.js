const fs = require('fs-extra');
const path = require('path');
let app = null;
try {
  ({ app } = require('electron'));
} catch {
  app = null;
}

const { runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const { buildFileArtifact, summarizeArtifact } = require('./pipelineArtifactService');
const { PORT_KIND_AUDIO } = require('../shared/pipelineSchema.cjs');

const LOCAL_AUDIO_RUNTIME_MODE_IDS = Object.freeze({
  DIRECT_COMMAND: 'direct-command',
});

const LOCAL_AUDIO_TOOL_ADAPTERS = Object.freeze({
  'audiocraft-webui': Object.freeze({
    label: 'AudioCraft WebUI',
    runtimeMode: LOCAL_AUDIO_RUNTIME_MODE_IDS.DIRECT_COMMAND,
  }),
});

function getHelperScriptPath() {
  return app?.isPackaged
    ? path.join(process.resourcesPath, 'helpers', 'run_audiocraft_pipeline_task.py')
    : path.join(__dirname, '..', 'helpers', 'run_audiocraft_pipeline_task.py');
}

function firstNonEmptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function getLocalAudioToolRuntimeMode(toolId) {
  return LOCAL_AUDIO_TOOL_ADAPTERS[String(toolId || '').trim().toLowerCase()]?.runtimeMode || '';
}

function getLocalAudioToolLabel(tool) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  return LOCAL_AUDIO_TOOL_ADAPTERS[toolId]?.label || String(tool?.name || 'This local audio tool').trim() || 'This local audio tool';
}

function resolveLocalAudioToolRoot(tool) {
  const rawToolRoot = String(tool?.appDir || tool?.installDir || '').trim();
  if (!rawToolRoot) {
    throw new Error(getLocalAudioToolLabel(tool) + ' does not have a usable local install folder yet. Reinstall the tool, then try this pipeline step again.');
  }

  return path.resolve(rawToolRoot);
}

async function resolveLocalAudioPythonPath(tool) {
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

  throw new Error('Local AI Hub could not find the Python runtime for ' + getLocalAudioToolLabel(tool) + '. Repair or reinstall the tool, then try again.');
}

function sanitizeLabelSegment(value, fallback) {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

function buildJsonRequestPath(runDirectories, nodeLabel) {
  return path.join(runDirectories.artifactsDir, `${sanitizeLabelSegment(nodeLabel, 'audio-step')}-${Date.now()}.audiocraft-request.json`);
}

function buildAudioOutputPath(runDirectories, nodeLabel) {
  return path.join(runDirectories.artifactsDir, `${sanitizeLabelSegment(nodeLabel, 'audio-step')}-${Date.now()}.wav`);
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

async function runAudiocraftTask(tool, payload, reportProgress) {
  const toolLabel = getLocalAudioToolLabel(tool);
  const helperScript = getHelperScriptPath();
  if (!(await fs.pathExists(helperScript))) {
    throw new Error('Local AI Hub is missing its AudioCraft helper script. Reinstall the app to restore it.');
  }

  const pythonPath = await resolveLocalAudioPythonPath(tool);
  const toolRoot = resolveLocalAudioToolRoot(tool);
  const logger = createLogger('pipeline-local-audio', {
    toolId: tool?.id || 'local-audio-tool',
  });

  const requestPath = String(payload.requestPath || '').trim();
  if (!requestPath) {
    throw new Error('Local AI Hub could not prepare the local audio request file.');
  }

  await fs.writeJson(requestPath, payload, { spaces: 2 });
  reportProgress?.(
    'Starting the local AudioCraft backend for this audio step.',
    'Running ' + (payload.nodeLabel || 'this step') + ' with ' + toolLabel + '...',
  );

  const commandResult = await runCommand(pythonPath, [helperScript, requestPath], {
    allowFailure: true,
    cwd: toolRoot,
    env: {
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  });

  if (Number(commandResult.code || 0) !== 0) {
    const message = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout) || toolLabel + ' could not finish the local audio request.';
    await logger.warn('Local audio helper failed.', {
      message,
      stderr: String(commandResult.stderr || '').trim(),
      stdout: String(commandResult.stdout || '').trim(),
    });
    throw new Error(message);
  }

  return parseCommandJson(commandResult.stdout, toolLabel);
}

function buildSourceAudioReference(sourceAudioArtifact) {
  if (!sourceAudioArtifact) {
    return null;
  }

  return {
    displayName: String(sourceAudioArtifact.displayName || '').trim(),
    fileName: String(sourceAudioArtifact.fileName || '').trim(),
    filePath: String(sourceAudioArtifact.filePath || '').trim(),
    fileUrl: String(sourceAudioArtifact.fileUrl || '').trim(),
    formatLabel: String(sourceAudioArtifact.formatLabel || '').trim(),
    kind: String(sourceAudioArtifact.kind || '').trim(),
    mimeType: String(sourceAudioArtifact.mimeType || '').trim(),
    sizeBytes: Number(sourceAudioArtifact.sizeBytes || 0) || 0,
    summary: String(sourceAudioArtifact.summary || '').trim(),
  };
}

async function generateAudioWithAudiocraftTool(tool, options = {}) {
  const toolLabel = getLocalAudioToolLabel(tool);
  const runDirectories = options.runDirectories || null;
  if (!runDirectories?.artifactsDir) {
    throw new Error('Local AI Hub could not prepare a pipeline run folder for the local audio output.');
  }

  const nodeLabel = String(options.nodeLabel || options.displayName || 'Audio step').trim() || 'Audio step';
  const outputPath = buildAudioOutputPath(runDirectories, nodeLabel);
  const requestPath = buildJsonRequestPath(runDirectories, nodeLabel);
  const response = await runAudiocraftTask(tool, {
    audioMode: String(options.audioMode || 'music').trim() || 'music',
    durationSeconds: Math.max(1, Number(options.durationSeconds || 8) || 8),
    model: String(options.model || '').trim(),
    nodeLabel,
    outputPath,
    prompt: String(options.prompt || '').trim(),
    requestPath,
    sourceAudioPath: String(options.sourceAudioPath || '').trim(),
    toolRoot: resolveLocalAudioToolRoot(tool),
  }, options.reportProgress);

  const finalOutputPath = path.resolve(String(response?.outputPath || outputPath).trim());
  if (!(await fs.pathExists(finalOutputPath))) {
    throw new Error(toolLabel + ' reported success, but the generated audio file could not be found.');
  }

  const audioGeneration = {
    backend: 'audiocraft',
    backendLabel: 'AudioCraft',
    durationSeconds: Number(response?.durationSeconds || options.durationSeconds || 0) || 0,
    mode: String(response?.audioMode || options.audioMode || 'music').trim() || 'music',
    model: String(response?.model || options.model || '').trim(),
    prompt: String(response?.prompt || options.prompt || '').trim(),
    sourceAudio: buildSourceAudioReference(options.sourceAudioArtifact),
    toolId: String(tool?.id || '').trim() || 'audiocraft-webui',
    toolLabel,
  };

  const artifact = await buildFileArtifact(finalOutputPath, {
    audioGeneration,
    displayName: String(options.displayName || nodeLabel || 'Audio').trim() || 'Audio',
    kind: PORT_KIND_AUDIO,
    role: 'generated',
  });

  return {
    destinationPath: artifact.filePath,
    message: String(response?.message || toolLabel + ' generated audio locally and saved it to ' + artifact.filePath + '.').trim(),
    metadata: response,
    outputs: {
      audio: artifact,
    },
    preview: summarizeArtifact(artifact),
  };
}

async function generateAudioWithLocalAudioTool(tool, options = {}) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  if (toolId === 'audiocraft-webui') {
    return generateAudioWithAudiocraftTool(tool, options);
  }

  throw new Error((tool?.name || 'This local audio tool') + ' does not have a runnable local audio adapter in Local AI Hub yet.');
}

module.exports = {
  LOCAL_AUDIO_RUNTIME_MODE_IDS,
  generateAudioWithLocalAudioTool,
  getLocalAudioToolRuntimeMode,
};
