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
const { serializePromptStyleApplication } = require('../shared/promptStyles.cjs');
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

async function resolveBundledFfmpegPath() {
  const candidates = [];
  if (app?.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', 'ffmpeg.exe'));
  }

  try {
    const ffmpegStaticPath = require('ffmpeg-static');
    if (ffmpegStaticPath) {
      candidates.push(String(ffmpegStaticPath));
    }
  } catch {
    // The packaged app copies ffmpeg.exe into extra resources instead of relying on node_modules.
  }

  candidates.push(path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));
  candidates.push(path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));

  for (const candidate of uniqueNonEmptyStrings(candidates)) {
    if (await fs.pathExists(candidate)) {
      return path.resolve(candidate);
    }
  }

  return '';
}

function prependExecutableDirectoryToPath(env, executablePath) {
  const resolvedExecutablePath = String(executablePath || '').trim();
  if (!resolvedExecutablePath) {
    return env;
  }

  const executableDirectory = path.dirname(resolvedExecutablePath);
  const pathKey = Object.keys(env || {}).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const existingPath = String(env?.[pathKey] || process.env[pathKey] || '');
  const existingSegments = existingPath.split(path.delimiter).filter(Boolean);
  const alreadyPresent = existingSegments.some((segment) => path.resolve(segment).toLowerCase() === path.resolve(executableDirectory).toLowerCase());
  return {
    ...env,
    FFMPEG_BINARY: resolvedExecutablePath,
    [pathKey]: alreadyPresent ? existingPath : executableDirectory + (existingPath ? path.delimiter + existingPath : ''),
  };
}

async function prepareLocalAudioRuntimeEnv(tool, toolId) {
  let runtimeEnv = await buildLaunchRuntimeEnv(tool, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }, { launchProfile: tool?.launchProfile || null });

  if (String(toolId || '').trim().toLowerCase() === 'rvc') {
    runtimeEnv = prependExecutableDirectoryToPath(runtimeEnv, await resolveBundledFfmpegPath());
  }

  return runtimeEnv;
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

const RVC_REQUIRED_RUNTIME_ASSETS = Object.freeze([
  Object.freeze({ label: 'Hubert feature model', relativePath: path.join('assets', 'hubert', 'hubert_base.pt'), minBytes: 1024 }),
  Object.freeze({ label: 'RMVPE pitch model', relativePath: path.join('assets', 'rmvpe', 'rmvpe.pt'), minBytes: 1024 }),
]);

async function assertRvcRuntimeAssetsReady(tool) {
  const toolRoot = resolveLocalAudioToolRoot(tool);
  const missing = [];
  for (const asset of RVC_REQUIRED_RUNTIME_ASSETS) {
    const assetPath = path.join(toolRoot, asset.relativePath);
    const stats = await fs.stat(assetPath).catch(() => null);
    if (!stats?.isFile() || stats.size < asset.minBytes) {
      missing.push(asset.relativePath.replace(/\\/g, '/'));
    }
  }

  if (missing.length) {
    throw new Error('RVC is missing required runtime asset' + (missing.length === 1 ? '' : 's') + ': ' + missing.join(', ') + '. Run Repair or reinstall RVC while online, then try this voice conversion again.');
  }
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
  const lines = String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  if (!lines.length) {
    throw new Error(toolLabel + ' finished, but it did not return a readable result.');
  }

  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // Keep looking in case the helper printed warnings around its JSON result.
    }
  }

  throw new Error(toolLabel + ' finished, but Local AI Hub could not read its result.');
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

  const runtimeEnv = await prepareLocalAudioRuntimeEnv(tool, toolId);
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
    id: String(sourceAudioArtifact.id || sourceAudioArtifact.artifactId || '').trim(),
    kind: String(sourceAudioArtifact.kind || '').trim(),
    mimeType: String(sourceAudioArtifact.mimeType || '').trim(),
    sizeBytes: Number(sourceAudioArtifact.sizeBytes || 0) || 0,
    summary: String(sourceAudioArtifact.summary || '').trim(),
  };
}

function buildAudioSourceLineage(sourceAudioArtifact) {
  if (!sourceAudioArtifact) {
    return null;
  }

  const lineage = {
    sourceArtifactId: String(sourceAudioArtifact.id || sourceAudioArtifact.artifactId || '').trim(),
    sourceFileName: String(sourceAudioArtifact.fileName || sourceAudioArtifact.displayName || '').trim(),
    sourceFilePath: String(sourceAudioArtifact.filePath || '').trim(),
    sourceKind: String(sourceAudioArtifact.kind || '').trim(),
  };
  return Object.values(lineage).some(Boolean) ? lineage : null;
}

function buildAudiocraftGenerationSettings(options = {}) {
  return {
    cfgCoef: Number.isFinite(Number(options.audiocraftCfgCoef)) ? Number(options.audiocraftCfgCoef) : 3,
    temperature: Number.isFinite(Number(options.audiocraftTemperature)) ? Number(options.audiocraftTemperature) : 1,
    topK: Math.max(0, Math.floor(Number(options.audiocraftTopK ?? 250) || 0)),
    topP: Math.max(0, Math.min(1, Number(options.audiocraftTopP || 0) || 0)),
    twoStepCfg: Boolean(options.audiocraftTwoStepCfg),
  };
}

function coerceContinuationRepeatCount(value) {
  const numericValue = Number(value ?? 1);
  const repeatCount = Number.isFinite(numericValue) ? Math.floor(numericValue) : 1;
  return Math.max(1, Math.min(10, repeatCount || 1));
}

function buildVoiceModelReference(voiceModel, fallbackModel) {
  if (voiceModel && typeof voiceModel === 'object') {
    return {
      fileName: String(voiceModel.fileName || '').trim(),
      indexFileName: String(voiceModel.indexFileName || '').trim(),
      indexPath: String(voiceModel.indexPath || '').trim(),
      indexRelativePath: String(voiceModel.indexRelativePath || '').trim(),
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
  const generationSettings = buildAudiocraftGenerationSettings(options);
  const response = await runLocalAudioTask(tool, {
    appendSource: Boolean(options.appendSource),
    audioMode: String(options.audioMode || 'music').trim() || 'music',
    continuationRepeatCount: coerceContinuationRepeatCount(options.continuationRepeatCount ?? options.repeatCount),
    continuationSeedSeconds: Math.max(0.25, Number(options.continuationSeedSeconds || 12) || 12),
    durationSeconds: Math.max(1, Number(options.durationSeconds || 8) || 8),
    generationSettings,
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

  const audioMode = String(response?.audioMode || options.audioMode || 'music').trim() || 'music';
  const continuationRepeatCount = audioMode === 'continuation'
    ? Number(response?.continuationRepeatCount || response?.repeatCount || options.continuationRepeatCount || 1) || 1
    : 0;
  const audioGeneration = {
    advancedSettings: response?.advancedSettings && typeof response.advancedSettings === 'object' ? response.advancedSettings : generationSettings,
    appendSource: Boolean(response?.appendSource),
    backend: 'audiocraft',
    backendLabel: 'AudioCraft',
    continuationRepeatCount,
    continuationRepeats: audioMode === 'continuation' && Array.isArray(response?.continuationRepeats) ? response.continuationRepeats : [],
    continuationSeedSeconds: Number(response?.continuationSeedSeconds || options.continuationSeedSeconds || 0) || 0,
    durationSeconds: Number(response?.durationSeconds || options.durationSeconds || 0) || 0,
    finalOutputDurationSeconds: Number(response?.finalOutputDurationSeconds || response?.durationSeconds || options.durationSeconds || 0) || 0,
    generatedDurationSeconds: Number(response?.generatedDurationSeconds || response?.durationSeconds || options.durationSeconds || 0) || 0,
    lineage: buildAudioSourceLineage(options.sourceAudioArtifact),
    mode: audioMode,
    model: String(response?.model || options.model || '').trim(),
    operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
    operationSubtype: audioMode,
    prompt: String(response?.prompt || options.prompt || '').trim(),
    promptStyle: serializePromptStyleApplication(options.promptStyle),
    repeatCount: continuationRepeatCount,
    requestedGeneratedDurationSeconds: audioMode === 'continuation' ? Number(response?.requestedGeneratedDurationSeconds || 0) || 0 : 0,
    sourceAudio: buildSourceAudioReference(options.sourceAudioArtifact),
    sourceAudioPath: String(response?.sourceAudioPath || options.sourceAudioPath || '').trim(),
    sourceDurationSeconds: Number(response?.sourceDurationSeconds || 0) || 0,
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

async function stitchAudioWithAudiocraftTool(tool, options = {}) {
  const toolLabel = getLocalAudioToolLabel(tool);
  const runDirectories = options.runDirectories || null;
  if (!runDirectories?.artifactsDir) {
    throw new Error('Local AI Hub could not prepare a pipeline run folder for the AudioCraft continuation chain.');
  }

  const sourceAudioPath = path.resolve(String(options.sourceAudioPath || '').trim());
  const segmentAudioPath = path.resolve(String(options.segmentAudioPath || '').trim());
  if (!sourceAudioPath || !(await fs.pathExists(sourceAudioPath))) {
    throw new Error('The current cumulative audio for this AudioCraft continuation chain could not be found anymore. Rerun the collection map from the beginning.');
  }
  if (!segmentAudioPath || !(await fs.pathExists(segmentAudioPath))) {
    throw new Error('The generated continuation segment for this AudioCraft chain could not be found. Rerun the collection map from the beginning.');
  }

  const nodeLabel = String(options.nodeLabel || options.displayName || 'AudioCraft continuation chain').trim() || 'AudioCraft continuation chain';
  const outputPath = buildAudioOutputPath(runDirectories, nodeLabel + '-cumulative', 'wav');
  const requestPath = buildJsonRequestPath(runDirectories, nodeLabel, 'audiocraft-stitch-request');
  const response = await runLocalAudioTask(tool, {
    audioTask: 'append-audio',
    nodeLabel,
    outputPath,
    requestPath,
    segmentAudioPath,
    sourceAudioPath,
    toolRoot: resolveLocalAudioToolRoot(tool),
  }, options.reportProgress, {
    run: 'Updating the cumulative AudioCraft continuation audio for ' + nodeLabel + '...',
    start: 'Preparing the next AudioCraft continuation-chain source.',
  });

  const finalOutputPath = path.resolve(String(response?.outputPath || outputPath).trim());
  if (!(await fs.pathExists(finalOutputPath))) {
    throw new Error(toolLabel + ' reported success, but the cumulative continuation-chain audio file could not be found.');
  }

  return {
    destinationPath: finalOutputPath,
    metadata: response,
    outputPath: finalOutputPath,
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

  await assertRvcRuntimeAssetsReady(tool);

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
    voiceModelIndexPath: voiceModel.indexPath,
    voiceModelIndexRelativePath: voiceModel.indexRelativePath,
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

async function stitchAudioWithLocalAudioTool(tool, options = {}) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  if (toolId === 'audiocraft-webui') {
    return stitchAudioWithAudiocraftTool(tool, options);
  }

  throw new Error((tool?.name || 'This local audio tool') + ' cannot update an AudioCraft continuation chain. Choose AudioCraft WebUI for chained text-to-audio maps.');
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
  stitchAudioWithLocalAudioTool,
  _test: {
    AUDIOCRAFT_PIPELINE_IMPORT_CHECKS,
    RVC_REQUIRED_RUNTIME_ASSETS,
    buildAudiocraftMissingPipelinePackagesMessage,
    buildAudiocraftPipelineLoadFailureMessage,
    buildAudiocraftPipelineProbeScript,
    parseCommandJson,
    parseCommandMessage,
    parseProbeJson,
    prepareLocalAudioRuntimeEnv,
    prependExecutableDirectoryToPath,
    resolveBundledFfmpegPath,
    resolveCommandFailureMessage,
  },
};
