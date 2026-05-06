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
const { PIPELINE_OPERATION_IDS, PORT_KIND_AUDIO } = require('../shared/pipelineSchema.cjs');

const LOCAL_AUDIO_RUNTIME_MODE_IDS = Object.freeze({
  DIRECT_COMMAND: 'direct-command',
});

const LOCAL_AUDIO_TOOL_ADAPTERS = Object.freeze({
  'audiocraft-webui': Object.freeze({
    helperScript: 'run_audiocraft_pipeline_task.py',
    label: 'AudioCraft WebUI',
    runtimeMode: LOCAL_AUDIO_RUNTIME_MODE_IDS.DIRECT_COMMAND,
  }),
  rvc: Object.freeze({
    helperScript: 'run_rvc_pipeline_task.py',
    label: 'RVC',
    runtimeMode: LOCAL_AUDIO_RUNTIME_MODE_IDS.DIRECT_COMMAND,
  }),
});

function getHelperScriptPath(toolId) {
  const adapter = LOCAL_AUDIO_TOOL_ADAPTERS[String(toolId || '').trim().toLowerCase()] || null;
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

function buildJsonRequestPath(runDirectories, nodeLabel, requestKind = 'audio-step') {
  return path.join(runDirectories.artifactsDir, `${sanitizeLabelSegment(nodeLabel, 'audio-step')}-${Date.now()}.${requestKind}.json`);
}

function buildAudioOutputPath(runDirectories, nodeLabel, suffix = 'wav') {
  return path.join(runDirectories.artifactsDir, `${sanitizeLabelSegment(nodeLabel, 'audio-step')}-${Date.now()}.${suffix}`);
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

function parseCommandMessage(value) {
  const lines = String(value || '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const message = String(parsed && parsed.message || '').trim();
      if (message) {
        return message;
      }
    } catch {
      // Keep looking for the helper's structured result line.
    }
  }

  return '';
}

function resolveCommandFailureMessage(commandResult, fallbackMessage) {
  return parseCommandMessage(commandResult?.stdout)
    || parseCommandMessage(commandResult?.stderr)
    || firstNonEmptyLine(commandResult?.stdout)
    || firstNonEmptyLine(commandResult?.stderr)
    || fallbackMessage;
}

const AUDIOCRAFT_PIPELINE_IMPORT_CHECKS = Object.freeze([
  Object.freeze({ label: 'numpy', moduleName: 'numpy' }),
  Object.freeze({ label: 'torchaudio', moduleName: 'torchaudio' }),
  Object.freeze({ label: 'audiocraft', moduleName: 'audiocraft' }),
  Object.freeze({ label: 'audiocraft.data.audio', moduleName: 'audiocraft.data.audio' }),
  Object.freeze({ label: 'audiocraft.models', moduleName: 'audiocraft.models' }),
]);

function uniqueNonEmptyStrings(values) {
  return [...new Set((values || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function buildAudiocraftMissingPipelinePackagesMessage(missingPackages = []) {
  const uniqueMissing = uniqueNonEmptyStrings(missingPackages);
  const detail = uniqueMissing.length ? ': ' + uniqueMissing.join(', ') : '';
  return 'AudioCraft is installed, but its Python environment is missing the packages needed for pipeline audio generation' + detail + '. Run Repair or reinstall AudioCraft WebUI, then try again.';
}

function buildAudiocraftPipelineLoadFailureMessage() {
  return 'AudioCraft is installed, but Local AI Hub could not load the Python packages needed for pipeline audio generation. Run Repair or reinstall AudioCraft WebUI, then try again.';
}

function buildAudiocraftPipelineProbeScript() {
  const checksJson = JSON.stringify(AUDIOCRAFT_PIPELINE_IMPORT_CHECKS.map((entry) => [entry.moduleName, entry.label]));
  return [
    'import importlib, json, sys',
    'checks = ' + checksJson,
    'missing = []',
    'failures = []',
    'for module_name, label in checks:',
    '    try:',
    '        importlib.import_module(module_name)',
    '    except ModuleNotFoundError as exc:',
    '        missing.append(str(getattr(exc, "name", "") or label))',
    '    except Exception as exc:',
    '        failures.append({"module": module_name, "label": label, "errorType": exc.__class__.__name__})',
    'payload = {"ready": not missing and not failures, "missing": sorted(set(missing)), "failures": failures}',
    'print(json.dumps(payload))',
    'sys.exit(0 if payload["ready"] else 3)',
  ].join('\n');
}

function parseProbeJson(stdout) {
  const lastLine = String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find(Boolean);
  if (!lastLine) {
    return null;
  }
  try {
    return JSON.parse(lastLine);
  } catch {
    return null;
  }
}

async function checkAudiocraftPipelineReadiness(tool) {
  const toolLabel = getLocalAudioToolLabel(tool);
  let toolRoot = '';
  try {
    toolRoot = resolveLocalAudioToolRoot(tool);
  } catch (error) {
    return {
      message: error?.message || toolLabel + ' is not installed yet.',
      ready: false,
      reason: 'not-installed',
    };
  }

  let pythonPath = '';
  try {
    pythonPath = await resolveLocalAudioPythonPath(tool);
  } catch (error) {
    return {
      message: error?.message || 'Local AI Hub could not find the Python runtime for ' + toolLabel + '.',
      ready: false,
      reason: 'python-missing',
    };
  }

  const runtimeEnv = await buildLaunchRuntimeEnv(tool, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }, { launchProfile: tool?.launchProfile || null });
  const commandResult = await runCommand(pythonPath, ['-c', buildAudiocraftPipelineProbeScript()], {
    allowFailure: true,
    cwd: toolRoot,
    env: runtimeEnv,
    replaceEnv: true,
  });
  const probe = parseProbeJson(commandResult.stdout);
  if (Number(commandResult.code || 0) === 0 && probe?.ready !== false) {
    return {
      message: 'AudioCraft pipeline packages are ready.',
      ready: true,
      reason: 'ready',
    };
  }

  const missing = uniqueNonEmptyStrings(probe?.missing || []);
  if (missing.length) {
    return {
      message: buildAudiocraftMissingPipelinePackagesMessage(missing),
      missingPackages: missing,
      ready: false,
      reason: 'missing-packages',
    };
  }

  return {
    message: buildAudiocraftPipelineLoadFailureMessage(),
    ready: false,
    reason: 'package-load-failed',
  };
}

async function assertAudiocraftPipelineReady(tool) {
  const readiness = await checkAudiocraftPipelineReadiness(tool);
  if (!readiness.ready) {
    throw new Error(readiness.message);
  }
  return readiness;
}

async function runLocalAudioTask(tool, payload, reportProgress, progressMessages = {}) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  const toolLabel = getLocalAudioToolLabel(tool);
  const helperScript = getHelperScriptPath(toolId);
  if (!helperScript || !(await fs.pathExists(helperScript))) {
    throw new Error('Local AI Hub is missing its ' + toolLabel + ' helper script. Reinstall the app to restore it.');
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
    progressMessages.start || ('Starting ' + toolLabel + ' for this audio step.'),
    progressMessages.run || ('Running ' + (payload.nodeLabel || 'this step') + ' with ' + toolLabel + '...'),
  );

  const runtimeEnv = await buildLaunchRuntimeEnv(tool, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }, { launchProfile: tool?.launchProfile || null });
  await logger.info?.('Local audio helper launch environment prepared.', {
    launchEnvironment: summarizeLaunchRuntimeEnv(runtimeEnv),
  });
  const commandResult = await runCommand(pythonPath, [helperScript, requestPath], {
    allowFailure: true,
    cwd: toolRoot,
    env: runtimeEnv,
    replaceEnv: true,
  });

  if (Number(commandResult.code || 0) !== 0) {
    const message = resolveCommandFailureMessage(commandResult, toolLabel + ' could not finish the local audio request.');
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

function buildVoiceModelReference(voiceModel, fallbackModel) {
  if (voiceModel && typeof voiceModel === 'object') {
    return {
      fileName: String(voiceModel.fileName || '').trim(),
      model: String(voiceModel.relativePath || voiceModel.fileName || voiceModel.name || voiceModel.id || fallbackModel || '').trim(),
      name: String(voiceModel.name || voiceModel.fileName || voiceModel.id || fallbackModel || '').trim(),
      path: String(voiceModel.path || '').trim(),
      relativePath: String(voiceModel.relativePath || '').trim(),
    };
  }

  const normalizedFallback = String(fallbackModel || '').trim();
  return normalizedFallback
    ? {
        fileName: normalizedFallback,
        model: normalizedFallback,
        name: normalizedFallback,
        path: '',
        relativePath: '',
      }
    : null;
}

async function generateAudioWithAudiocraftTool(tool, options = {}) {
  const toolLabel = getLocalAudioToolLabel(tool);
  const runDirectories = options.runDirectories || null;
  if (!runDirectories?.artifactsDir) {
    throw new Error('Local AI Hub could not prepare a pipeline run folder for the local audio output.');
  }

  await assertAudiocraftPipelineReady(tool);

  const nodeLabel = String(options.nodeLabel || options.displayName || 'Audio step').trim() || 'Audio step';
  const outputPath = buildAudioOutputPath(runDirectories, nodeLabel, 'wav');
  const requestPath = buildJsonRequestPath(runDirectories, nodeLabel, 'audiocraft-request');
  const response = await runLocalAudioTask(tool, {
    audioMode: String(options.audioMode || 'music').trim() || 'music',
    durationSeconds: Math.max(1, Number(options.durationSeconds || 8) || 8),
    model: String(options.model || '').trim(),
    nodeLabel,
    outputPath,
    prompt: String(options.prompt || '').trim(),
    requestPath,
    sourceAudioPath: String(options.sourceAudioPath || '').trim(),
    toolRoot: resolveLocalAudioToolRoot(tool),
  }, options.reportProgress, {
    run: 'Running ' + nodeLabel + ' with ' + toolLabel + '...',
    start: 'Starting the local AudioCraft backend for this audio step.',
  });

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
    operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
    operationSubtype: String(response?.audioMode || options.audioMode || 'music').trim() || 'music',
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

async function generateAudioWithRvcTool(tool, options = {}) {
  const toolLabel = getLocalAudioToolLabel(tool);
  const runDirectories = options.runDirectories || null;
  if (!runDirectories?.artifactsDir) {
    throw new Error('Local AI Hub could not prepare a pipeline run folder for the transformed audio output.');
  }

  const sourceAudioPath = path.resolve(String(options.sourceAudioPath || '').trim());
  if (!sourceAudioPath || !(await fs.pathExists(sourceAudioPath))) {
    throw new Error('The source audio for this RVC step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  const voiceModel = buildVoiceModelReference(options.voiceModel, options.model);
  if (!voiceModel?.model) {
    throw new Error('Choose an RVC voice model before running this audio transformation step.');
  }

  const nodeLabel = String(options.nodeLabel || options.displayName || 'Audio transform').trim() || 'Audio transform';
  const outputPath = buildAudioOutputPath(runDirectories, nodeLabel, 'wav');
  const requestPath = buildJsonRequestPath(runDirectories, nodeLabel, 'rvc-request');
  const response = await runLocalAudioTask(tool, {
    instruction: String(options.instruction || '').trim(),
    model: voiceModel.model,
    nodeLabel,
    outputPath,
    requestPath,
    sourceAudioPath,
    toolRoot: resolveLocalAudioToolRoot(tool),
    voiceModelName: voiceModel.name,
    voiceModelPath: voiceModel.path,
    voiceModelRelativePath: voiceModel.relativePath,
  }, options.reportProgress, {
    run: 'Running ' + nodeLabel + ' with ' + toolLabel + '...',
    start: 'Starting RVC for this audio transformation step.',
  });

  const finalOutputPath = path.resolve(String(response?.outputPath || outputPath).trim());
  if (!(await fs.pathExists(finalOutputPath))) {
    throw new Error(toolLabel + ' reported success, but the transformed audio file could not be found.');
  }

  const audioTransformation = {
    backend: 'rvc',
    backendLabel: 'RVC',
    durationSeconds: Number(response?.durationSeconds || 0) || 0,
    instruction: String(options.instruction || '').trim(),
    model: String(response?.model || voiceModel.model || '').trim(),
    operationId: PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM,
    operationSubtype: String(response?.transformationType || 'voice-conversion').trim() || 'voice-conversion',
    sourceAudio: buildSourceAudioReference(options.sourceAudioArtifact),
    targetVoice: String(response?.targetVoice || voiceModel.name || voiceModel.fileName || '').trim(),
    toolId: String(tool?.id || '').trim() || 'rvc',
    toolLabel,
    transformationType: String(response?.transformationType || 'voice-conversion').trim() || 'voice-conversion',
  };

  const artifact = await buildFileArtifact(finalOutputPath, {
    audioTransformation,
    displayName: String(options.displayName || nodeLabel || 'Transformed audio').trim() || 'Transformed audio',
    kind: PORT_KIND_AUDIO,
    role: 'transformed',
  });

  return {
    destinationPath: artifact.filePath,
    message: String(response?.message || toolLabel + ' transformed the source audio locally and saved it to ' + artifact.filePath + '.').trim(),
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

  if (toolId === 'rvc') {
    return generateAudioWithRvcTool(tool, options);
  }

  throw new Error((tool?.name || 'This local audio tool') + ' does not have a runnable local audio adapter in Local AI Hub yet.');
}

module.exports = {
  LOCAL_AUDIO_RUNTIME_MODE_IDS,
  checkAudiocraftPipelineReadiness,
  generateAudioWithLocalAudioTool,
  getLocalAudioToolRuntimeMode,
  _test: {
    AUDIOCRAFT_PIPELINE_IMPORT_CHECKS,
    buildAudiocraftMissingPipelinePackagesMessage,
    buildAudiocraftPipelineLoadFailureMessage,
    buildAudiocraftPipelineProbeScript,
    parseCommandMessage,
    parseProbeJson,
    resolveCommandFailureMessage,
  },
};
