const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');

const { chatWithOllama, inspectOllamaModel, inspectOllamaModelCapabilities } = require('./ollamaService');
const { chatWithProvider, listProviderConnections, runProviderOperation } = require('./providerService');
const { initializeProviderRegistry } = require('./providerRegistry');
const { getToolCatalog } = require('./toolRegistry');
const { listGraphWorkflowPresets, listPromptStyles } = require('./configService');
const { listAssetLibraries, resolveAssetLibraryPreviewFile } = require('./assetLibraryService');
const { listDownloadedModels } = require('./modelService');
const { buildMergedToolStateList, getResolvedToolState } = require('./toolStateService');
const { DEFAULT_WHISPER_MODEL, transcribeWithWhisper } = require('./whisperService');
const {
  buildFileArtifact,
  buildTerminalResult,
  copyArtifactToOutput,
  createArtifactCollection,
  createCompositionArtifact,
  createPlanArtifact,
  createPlanningPacketArtifact,
  createTextArtifact,
  describeArtifactForLlm,
  ensureRunDirectories,
  isArtifactCollection,
  isCompositionArtifact,
  persistArtifactCollection,
  persistCompositionArtifact,
  saveAudioArtifactMetadata,
  saveVideoArtifactMetadata,
  saveBase64Artifact,
  saveBufferArtifact,
  sanitizeSegment,
  serializeArtifactForUi,
  summarizeArtifact,
} = require('./pipelineArtifactService');
const {
  DEFAULT_PLANNING_SCHEMA_ID,
  LONGFORM_SCENE_PLAN_SCHEMA_ID,
  buildPlanReviewDocument,
  buildPlanTextCollectionItems,
  buildDeterministicPlanFromPacket,
  buildPlanningPacketDocument,
  buildPlanningSchemaStructuredOutputRequest,
  buildPlannerPrompt,
  getPlanningSchemaDefinition,
  validatePlanAgainstSchema,
  validatePlanningPacketShape,
} = require('../shared/planningSchema.cjs');
const {
  generateImageWithWorkflowTool,
  interrogateImageWithWorkflowTool,
  resolveSelectedImageTool,
} = require('./workflowToolService');
const { executeGraphWorkflowNode } = require('./graphWorkflowService');
const {
  GRAPH_WORKFLOW_OPERATION_BACKEND_IDS,
  buildGraphWorkflowOperationBackendNode,
  getGraphWorkflowOperationBackendSupport,
  resolveGraphWorkflowPresetNode,
} = require('../shared/graphWorkflowContracts.cjs');
const { generateAudioWithLocalAudioTool, stitchAudioWithLocalAudioTool } = require('./localAudioService');
const {
  findRvcVoiceModelMatch,
  findStableDiffusionCheckpointMatch,
  getRvcVoiceModels,
  getStableDiffusionCheckpointModels,
} = require('../shared/toolAssetSelection.cjs');
const { generateImageWithLocalImageTool } = require('./localImageService');
const { generateVideoWithLocalVideoTool } = require('./localVideoService');
const { extractVideoLastFrameArtifact } = require('./videoFrameService');
const {
  applyPromptStyleToPrompt,
  isPromptStyleCompatibleWithTarget,
  serializePromptStyleApplication,
} = require('../shared/promptStyles.cjs');
const { exportCompositionArtifactToVideo, resolveFfmpegPath } = require('./mediaCompositionService');
const {
  extractAudioFromVideoArtifact,
  extractVideoFrameArtifact,
  normalizeAudioCollectionArtifact,
  normalizeImageArtifact,
  normalizeVideoCollectionArtifact,
  trimMediaArtifact,
  burnSubtitlesIntoVideoArtifact,
  exportSubtitlesArtifact,
} = require('./mediaUtilityService');
const { runCommand } = require('./commandService');
const { createPipelineToolOrchestrator } = require('./pipelineToolOrchestrationService');
const { doesProviderOperationRequireExplicitModel, getProviderModelCapabilities, getProviderPipelineOperation, getToolPipelineOperation } = require('../shared/pipelineCapabilities.cjs');
const {
  DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS,
  DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS,
  DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME,
  MEDIA_COMPOSITION_SOUND_EFFECTS_DENSITIES,
  MEDIA_COMPOSITION_SOUND_EFFECTS_SCHEDULING_MODES,
  MEDIA_COMPOSITION_TRANSITION_CATEGORIES,
  MEDIA_COMPOSITION_TRANSITION_MODES,
  MEDIA_COMPOSITION_XFADE_TRANSITIONS,
  MEDIA_COMPOSITION_UNSTABLE_XFADE_TRANSITIONS,
  PIPELINE_OPERATION_IDS,
  PORT_KIND_AUDIO,
  PORT_KIND_COLLECTION,
  PORT_KIND_COMPOSITION,
  PORT_KIND_FILE,
  PORT_KIND_IMAGE,
  PORT_KIND_PLANNING_PACKET,
  PORT_KIND_PLAN,
  PORT_KIND_TEXT,
  PORT_KIND_VIDEO,
  analyzePipeline,
  buildPipelineGraph,
  buildContextMaps,
  createUniqueId,
  getGraphWorkflowToolId,
  getCollectionMapInputKind,
  getCollectionMapMapping,
  getCollectionMapOperationId,
  getCollectionMapOutputKind,
  getLocalImageBackendOperationId,
  getModelStepExecutionMode,
  getModelStepLocalToolId,
  getModelStepOperationId,
  normalizeImageTransformSubtype,
  normalizePipelineRunSettings,
  getNodeTypeDefinition,
  getPortDefinition,
  trimPreviewText,
  selectLocalImageBackend,
} = require('../shared/pipelineSchema.cjs');

class PipelineCancelledError extends Error {
  constructor(message = 'Pipeline run cancelled.') {
    super(message);
    this.name = 'PipelineCancelledError';
  }
}

let pipelineEventSink = null;
let activeRun = null;
let activeRunAbortController = null;
let pendingValidationControl = null;

const PLANNER_PROVIDER_TIMEOUT_MS = 60000;
const LONGFORM_CHUNKED_PLANNER_THRESHOLD_SECONDS = 60;
const LONGFORM_CHUNK_TARGET_DURATION_SECONDS = 60;
const LONGFORM_CHUNK_MAX_DURATION_SECONDS = 90;
const LONGFORM_CHUNK_CONTEXT_OVERLAP_SECONDS = 5;
const LONGFORM_CHUNK_RECENT_PROMPT_COUNT = 5;
const LONGFORM_CHUNK_MAX_REQUEST_CHARACTERS = 14000;
const MEDIA_COMPOSITION_TRANSITION_CATEGORY_BY_ID = new Map(
  MEDIA_COMPOSITION_TRANSITION_CATEGORIES.map((category) => [String(category.id || '').trim(), category]),
);
const MEDIA_COMPOSITION_UNSTABLE_XFADE_TRANSITION_SET = new Set(MEDIA_COMPOSITION_UNSTABLE_XFADE_TRANSITIONS || []);
const MEDIA_COMPOSITION_XFADE_TRANSITION_SET = new Set(MEDIA_COMPOSITION_XFADE_TRANSITIONS.filter((transition) => !MEDIA_COMPOSITION_UNSTABLE_XFADE_TRANSITION_SET.has(transition)));
function normalizeMediaCompositionVolume(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(2, numeric));
}

function formatMediaCompositionVolumePercent(value, fallback) {
  return Math.round(normalizeMediaCompositionVolume(value, fallback) * 100);
}

function buildMediaCompositionAudioMixConfig(effectiveConfig, soundEffectsPlan) {
  const backgroundMusicVolume = normalizeMediaCompositionVolume(effectiveConfig.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME);
  const narrationVolume = normalizeMediaCompositionVolume(effectiveConfig.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME);
  const soundEffectsVolume = normalizeMediaCompositionVolume(effectiveConfig.soundEffectsGlobalVolume ?? soundEffectsPlan.volume, 1);
  return {
    backgroundMusicVolume,
    narrationVolume,
    soundEffectsVolume,
    gainStaging: {
      amixNormalize: false,
      clippingPreventionApplied: false,
      effectiveGains: {
        backgroundMusic: backgroundMusicVolume,
        narration: narrationVolume,
        soundEffects: soundEffectsVolume,
      },
      limiterApplied: false,
      sourceRelative: true,
    },
  };
}

function normalizeMediaCompositionBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeMediaCompositionSeconds(value, fallback, minValue = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(Math.max(minValue, numeric) * 1000) / 1000;
}

function normalizeMediaCompositionSoundEffectsRetryLayers(value, fallbackLayers = []) {
  const sourceLayers = Array.isArray(value) ? value : [];
  const fallbackByIndex = Array.isArray(fallbackLayers) ? fallbackLayers : [];
  return sourceLayers.map((layer, index) => {
    const fallback = fallbackByIndex[index] && typeof fallbackByIndex[index] === 'object' ? fallbackByIndex[index] : {};
    const source = layer && typeof layer === 'object' ? layer : {};
    return {
      ...fallback,
      ...source,
      volume: normalizeMediaCompositionVolume(source.volume ?? fallback.volume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME),
    };
  });
}

function buildMediaCompositionRetryOverrideConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const config = {};
  if (Object.prototype.hasOwnProperty.call(source, 'narrationVolume')) {
    config.narrationVolume = normalizeMediaCompositionVolume(source.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'backgroundMusicVolume')) {
    config.backgroundMusicVolume = normalizeMediaCompositionVolume(source.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'soundEffectsEnabled')) {
    config.soundEffectsEnabled = normalizeMediaCompositionBoolean(source.soundEffectsEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'soundEffectsVolume')) {
    config.soundEffectsVolume = normalizeMediaCompositionVolume(source.soundEffectsVolume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'soundEffectsGlobalVolume')) {
    config.soundEffectsGlobalVolume = normalizeMediaCompositionVolume(source.soundEffectsGlobalVolume, 1);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'soundEffectsLayers')) {
    config.soundEffectsLayers = normalizeMediaCompositionSoundEffectsRetryLayers(source.soundEffectsLayers);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'soundEffectsGlobalGuardEnabled')) {
    config.soundEffectsGlobalGuardEnabled = normalizeMediaCompositionBoolean(source.soundEffectsGlobalGuardEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'soundEffectsGlobalMinSpacingSeconds')) {
    config.soundEffectsGlobalMinSpacingSeconds = normalizeMediaCompositionSeconds(source.soundEffectsGlobalMinSpacingSeconds, DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS, 0);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'soundEffectsGlobalMaxSimultaneous')) {
    config.soundEffectsGlobalMaxSimultaneous = Math.max(1, Math.min(8, Math.floor(Number(source.soundEffectsGlobalMaxSimultaneous || 1) || 1)));
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sceneTransitionMode')) {
    config.sceneTransitionMode = normalizeMediaCompositionTransitionMode(source.sceneTransitionMode);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sceneTransitionName')) {
    config.sceneTransitionName = normalizeMediaCompositionTransitionName(source.sceneTransitionName);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sceneTransitionCategory')) {
    config.sceneTransitionCategory = normalizeMediaCompositionTransitionCategory(source.sceneTransitionCategory);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sceneTransitionDurationSeconds')) {
    config.sceneTransitionDurationSeconds = normalizeMediaCompositionTransitionDuration(source.sceneTransitionDurationSeconds);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'imageTimingMode')) {
    config.imageTimingMode = normalizeMediaCompositionImageTimingMode(source.imageTimingMode);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'secondsPerItem')) {
    config.secondsPerItem = normalizeMediaCompositionSeconds(source.secondsPerItem, 4, 0.1);
  }
  return Object.keys(config).length ? config : null;
}
function getMediaCompositionEffectiveConfig(node, run) {
  const retryOverride = run?.retryOverridesByNodeId?.[node.id]?.mediaComposition || null;
  const retryConfig = buildMediaCompositionRetryOverrideConfig(retryOverride);
  return {
    ...(node.config || {}),
    ...(retryConfig || {}),
  };
}

function getCompositionAudioMixForRetryControls(artifact) {
  const audioMix = artifact?.compositionExport?.audioMix && typeof artifact.compositionExport.audioMix === 'object'
    ? artifact.compositionExport.audioMix
    : null;
  return {
    narrationVolume: normalizeMediaCompositionVolume(audioMix?.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME),
    backgroundMusicVolume: normalizeMediaCompositionVolume(audioMix?.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME),
    soundEffectsGlobalVolume: normalizeMediaCompositionVolume(audioMix?.soundEffectsVolume, 1),
  };
}

const BURN_SUBTITLES_CAPTION_MODES = Object.freeze(['auto', 'transcriptSegments', 'subtitleFile', 'manualLines']);
const BURN_SUBTITLES_TEXT_COLORS = Object.freeze(['white', 'black', 'yellow', 'red', 'blue', 'green', 'cyan', 'magenta', 'lightGray', 'darkGray']);
const BURN_SUBTITLES_OUTLINE_COLORS = Object.freeze(['black', 'white', 'darkGray', 'lightGray', 'yellow', 'red', 'blue']);
const BURN_SUBTITLES_FONT_PRESETS = Object.freeze(['arial', 'segoeUi', 'tahoma', 'verdana']);
const BURN_SUBTITLES_POSITIONS = Object.freeze(['bottomCenter', 'bottomLeft', 'bottomRight', 'topCenter', 'topLeft', 'topRight', 'center']);
const BURN_SUBTITLES_BACKGROUND_OPACITIES = Object.freeze([25, 50, 75, 100]);
const BURN_SUBTITLES_FONT_SOURCES = Object.freeze(['preset', 'assetLibrary']);
const BURN_SUBTITLES_COLOR_SOURCES = Object.freeze(['manual', 'palette']);

function normalizeBurnSubtitlesNumber(value, fallback, minValue = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(Math.max(minValue, numeric) * 10) / 10;
}

function normalizeBurnSubtitlesBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeBurnSubtitlesEnum(value, allowedValues, fallback) {
  const normalized = String(value || fallback).trim();
  return allowedValues.includes(normalized) ? normalized : fallback;
}

function normalizeBurnSubtitlesBackgroundOpacity(value, fallback = 50) {
  const numeric = Number(value);
  return BURN_SUBTITLES_BACKGROUND_OPACITIES.includes(numeric) ? numeric : fallback;
}

function normalizeBurnSubtitlesAssetId(value) {
  return String(value || '').trim();
}

function buildBurnSubtitlesRetryOverrideConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const config = {};
  if (Object.prototype.hasOwnProperty.call(source, 'captionMode')) config.captionMode = normalizeBurnSubtitlesEnum(source.captionMode, BURN_SUBTITLES_CAPTION_MODES, 'auto');
  if (Object.prototype.hasOwnProperty.call(source, 'durationPerCaptionSeconds')) config.durationPerCaptionSeconds = normalizeBurnSubtitlesNumber(source.durationPerCaptionSeconds, 3, 0.1);
  if (Object.prototype.hasOwnProperty.call(source, 'fontSize')) config.fontSize = normalizeBurnSubtitlesNumber(source.fontSize, 28, 1);
  if (Object.prototype.hasOwnProperty.call(source, 'outline')) config.outline = normalizeBurnSubtitlesNumber(source.outline, 2, 0);
  if (Object.prototype.hasOwnProperty.call(source, 'shadow')) config.shadow = normalizeBurnSubtitlesNumber(source.shadow, 1, 0);
  if (Object.prototype.hasOwnProperty.call(source, 'bottomMargin')) config.bottomMargin = normalizeBurnSubtitlesNumber(source.bottomMargin, 32, 0);
  if (Object.prototype.hasOwnProperty.call(source, 'textColor')) config.textColor = normalizeBurnSubtitlesEnum(source.textColor, BURN_SUBTITLES_TEXT_COLORS, 'white');
  if (Object.prototype.hasOwnProperty.call(source, 'outlineColor')) config.outlineColor = normalizeBurnSubtitlesEnum(source.outlineColor, BURN_SUBTITLES_OUTLINE_COLORS, 'black');
  if (Object.prototype.hasOwnProperty.call(source, 'backgroundColor')) config.backgroundColor = normalizeBurnSubtitlesEnum(source.backgroundColor, BURN_SUBTITLES_TEXT_COLORS, 'black');
  if (Object.prototype.hasOwnProperty.call(source, 'fontPreset')) config.fontPreset = normalizeBurnSubtitlesEnum(source.fontPreset, BURN_SUBTITLES_FONT_PRESETS, 'arial');
  if (Object.prototype.hasOwnProperty.call(source, 'fontSource')) config.fontSource = normalizeBurnSubtitlesEnum(source.fontSource, BURN_SUBTITLES_FONT_SOURCES, 'preset');
  if (Object.prototype.hasOwnProperty.call(source, 'fontLibraryId')) config.fontLibraryId = normalizeBurnSubtitlesAssetId(source.fontLibraryId);
  if (Object.prototype.hasOwnProperty.call(source, 'fontItemId')) config.fontItemId = normalizeBurnSubtitlesAssetId(source.fontItemId);
  if (Object.prototype.hasOwnProperty.call(source, 'colorSource')) config.colorSource = normalizeBurnSubtitlesEnum(source.colorSource, BURN_SUBTITLES_COLOR_SOURCES, 'manual');
  if (Object.prototype.hasOwnProperty.call(source, 'colorPaletteLibraryId')) config.colorPaletteLibraryId = normalizeBurnSubtitlesAssetId(source.colorPaletteLibraryId);
  if (Object.prototype.hasOwnProperty.call(source, 'textColorPaletteItemId')) config.textColorPaletteItemId = normalizeBurnSubtitlesAssetId(source.textColorPaletteItemId);
  if (Object.prototype.hasOwnProperty.call(source, 'outlineColorPaletteItemId')) config.outlineColorPaletteItemId = normalizeBurnSubtitlesAssetId(source.outlineColorPaletteItemId);
  if (Object.prototype.hasOwnProperty.call(source, 'backgroundColorPaletteItemId')) config.backgroundColorPaletteItemId = normalizeBurnSubtitlesAssetId(source.backgroundColorPaletteItemId);
  if (Object.prototype.hasOwnProperty.call(source, 'bold')) config.bold = normalizeBurnSubtitlesBoolean(source.bold);
  if (Object.prototype.hasOwnProperty.call(source, 'italic')) config.italic = normalizeBurnSubtitlesBoolean(source.italic);
  if (Object.prototype.hasOwnProperty.call(source, 'position')) config.position = normalizeBurnSubtitlesEnum(source.position, BURN_SUBTITLES_POSITIONS, 'bottomCenter');
  if (Object.prototype.hasOwnProperty.call(source, 'backgroundBox')) config.backgroundBox = normalizeBurnSubtitlesBoolean(source.backgroundBox);
  if (Object.prototype.hasOwnProperty.call(source, 'backgroundOpacity')) config.backgroundOpacity = normalizeBurnSubtitlesBackgroundOpacity(source.backgroundOpacity, 50);
  return Object.keys(config).length ? config : null;
}

function getBurnSubtitlesEffectiveConfig(node, run) {
  const retryOverride = run?.retryOverridesByNodeId?.[node.id]?.burnSubtitles || null;
  const retryConfig = buildBurnSubtitlesRetryOverrideConfig(retryOverride);
  return {
    ...(node.config || {}),
    ...(retryConfig || {}),
  };
}

function getSubtitleBurnSettingsForRetryControls(artifact) {
  const burn = artifact?.subtitleBurn && typeof artifact.subtitleBurn === 'object' ? artifact.subtitleBurn : {};
  const style = burn.style && typeof burn.style === 'object' ? burn.style : {};
  return {
    backgroundBox: normalizeBurnSubtitlesBoolean(style.backgroundBox),
    backgroundOpacity: normalizeBurnSubtitlesBackgroundOpacity(style.backgroundOpacity, 50),
    bold: normalizeBurnSubtitlesBoolean(style.bold),
    bottomMargin: normalizeBurnSubtitlesNumber(style.bottomMargin, 32, 0),
    captionMode: normalizeBurnSubtitlesEnum(burn.captionMode, BURN_SUBTITLES_CAPTION_MODES, 'auto'),
    durationPerCaptionSeconds: normalizeBurnSubtitlesNumber(burn.durationPerCaptionSeconds, 3, 0.1),
    fontPreset: normalizeBurnSubtitlesEnum(style.fontPreset, BURN_SUBTITLES_FONT_PRESETS, 'arial'),
    fontSource: normalizeBurnSubtitlesEnum(style.fontSource, BURN_SUBTITLES_FONT_SOURCES, 'preset'),
    fontLibraryId: normalizeBurnSubtitlesAssetId(style.fontAsset?.libraryId),
    fontItemId: normalizeBurnSubtitlesAssetId(style.fontAsset?.itemId),
    fontSize: normalizeBurnSubtitlesNumber(style.fontSize, 28, 1),
    italic: normalizeBurnSubtitlesBoolean(style.italic),
    outline: normalizeBurnSubtitlesNumber(style.outline, 2, 0),
    outlineColor: normalizeBurnSubtitlesEnum(style.outlineColor, BURN_SUBTITLES_OUTLINE_COLORS, 'black'),
    backgroundColor: normalizeBurnSubtitlesEnum(style.backgroundColor, BURN_SUBTITLES_TEXT_COLORS, 'black'),
    colorSource: normalizeBurnSubtitlesEnum(style.colorSource, BURN_SUBTITLES_COLOR_SOURCES, 'manual'),
    colorPaletteLibraryId: normalizeBurnSubtitlesAssetId(style.palette?.libraryId),
    textColorPaletteItemId: normalizeBurnSubtitlesAssetId(style.palette?.colors?.text?.itemId),
    outlineColorPaletteItemId: normalizeBurnSubtitlesAssetId(style.palette?.colors?.outline?.itemId),
    backgroundColorPaletteItemId: normalizeBurnSubtitlesAssetId(style.palette?.colors?.background?.itemId),
    position: normalizeBurnSubtitlesEnum(style.position, BURN_SUBTITLES_POSITIONS, 'bottomCenter'),
    shadow: normalizeBurnSubtitlesNumber(style.shadow, 1, 0),
    textColor: normalizeBurnSubtitlesEnum(style.textColor, BURN_SUBTITLES_TEXT_COLORS, 'white'),
  };
}

const HEAVY_LOCAL_PIPELINE_OPERATION_IDS = new Set([
  PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
  PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM,
  PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
  PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM,
  PIPELINE_OPERATION_IDS.VIDEO_GENERATE,
]);

function getRunCooldownSettings(run) {
  return normalizePipelineRunSettings(run?.runSettings);
}

function getActiveRunHeavyStepCooldownSeconds() {
  const settings = getRunCooldownSettings(activeRun);
  return settings.enableHeavyStepCooldown ? settings.heavyStepCooldownSeconds : 0;
}

function isHeavyLocalPipelineNode(node) {
  if (!node) {
    return false;
  }

  if (node.type === 'llmPrompt') {
    return getModelStepExecutionMode(node) === 'localTool'
      && HEAVY_LOCAL_PIPELINE_OPERATION_IDS.has(getModelStepOperationId(node));
  }

  if (node.type === 'collectionMap') {
    const executionMode = getCollectionMapExecutionModeForRun(node);
    return (executionMode === 'localTool' || executionMode === 'graphWorkflow')
      && HEAVY_LOCAL_PIPELINE_OPERATION_IDS.has(getCollectionMapOperationId(node));
  }

  if (node.type === 'graphWorkflow') {
    const toolId = String(getGraphWorkflowToolId(node) || '').trim().toLowerCase();
    return toolId === 'comfyui' || toolId === 'invokeai';
  }

  return false;
}

function formatCooldownMessage(targetLabel, remainingSeconds) {
  return 'Cooling down before the next heavy local step... ' + remainingSeconds + 's';
}

async function waitForHeavyStepCooldown(run, nodeId, targetLabel = 'the next heavy local step') {
  const settings = getRunCooldownSettings(run);
  const seconds = settings.enableHeavyStepCooldown ? settings.heavyStepCooldownSeconds : 0;
  if (!run || seconds <= 0) {
    return;
  }

  const signal = activeRunAbortController?.signal || null;
  run.cooldownWaitCount = Number(run.cooldownWaitCount || 0) + 1;
  run.cooldown = {
    nodeId: String(nodeId || '').trim(),
    seconds,
    startedAt: new Date().toISOString(),
    targetLabel: String(targetLabel || 'the next heavy local step').trim(),
  };

  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    if (run.cancelRequested || signal?.aborted) {
      run.cooldown = null;
      throw new PipelineCancelledError('Pipeline run cancelled during cooldown.');
    }

    const message = formatCooldownMessage(targetLabel, remaining);
    if (nodeId) {
      updateRunningNodeProgress(run, nodeId, message, message);
    } else {
      updateRunMessage(run, message);
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new PipelineCancelledError('Pipeline run cancelled during cooldown.'));
      };
      const timer = setTimeout(finish, 1000);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }).catch((error) => {
      run.cooldown = null;
      throw error;
    });
  }

  run.cooldown = null;
  emitPipelineEvent();
}

function setPipelineEventSink(listener) {
  pipelineEventSink = typeof listener === 'function' ? listener : null;
}

function emitPipelineEvent() {
  if (typeof pipelineEventSink !== 'function' || !activeRun) {
    return;
  }

  activeRun.revision = Number(activeRun.revision || 0) + 1;

  try {
    pipelineEventSink({
      type: 'pipeline-run-update',
      run: getActiveRunSnapshot(),
    });
  } catch {
    return;
  }
}

function collectSelectedOllamaModels(definition = {}) {
  const selectedModels = new Set();

  for (const node of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    if (node?.type === 'llmPrompt' && node?.config?.executionMode === 'ollama') {
      const model = String(node.config?.model || '').trim();
      if (model) {
        selectedModels.add(model);
      }
    }

    if (node?.type === 'validation' && node?.config?.mode === 'llm' && node?.config?.llmExecutionMode === 'ollama') {
      const model = String(node.config?.model || '').trim();
      if (model) {
        selectedModels.add(model);
      }
    }

    if (node?.type === 'planner' && node?.config?.executionMode === 'ollama') {
      const model = String(node.config?.model || '').trim();
      if (model) {
        selectedModels.add(model);
      }
    }
  }

  return [...selectedModels];
}

function attachOllamaModelCapabilities(tools = [], modelCapabilitiesByName = {}) {
  if (!Object.keys(modelCapabilitiesByName).length) {
    return tools;
  }

  return tools.map((tool) =>
    tool?.id === 'ollama'
      ? {
          ...tool,
          modelCapabilitiesByName: {
            ...(tool.modelCapabilitiesByName || {}),
            ...modelCapabilitiesByName,
          },
        }
      : tool,
  );
}

function collectSelectedLocalImageToolIds(definition = {}) {
  const selectedToolIds = new Set();
  let hasLocalImageGenerationStep = false;

  for (const node of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    const isModelStepImageGeneration = node?.type === 'llmPrompt'
      && node?.config?.executionMode === 'localTool'
      && getModelStepOperationId(node) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
    const isDirectImageGeneration = false;
    const isLocalCollectionImageMap = node?.type === 'collectionMap'
      && node?.config?.executionMode === 'localTool'
      && String(node?.config?.operationId || PIPELINE_OPERATION_IDS.IMAGE_GENERATE).trim() === PIPELINE_OPERATION_IDS.IMAGE_GENERATE;

    if (!isModelStepImageGeneration && !isDirectImageGeneration && !isLocalCollectionImageMap) {
      continue;
    }

    hasLocalImageGenerationStep = true;
    const toolId = String(node?.config?.toolId || '').trim().toLowerCase();
    if (toolId) {
      selectedToolIds.add(toolId);
    }
  }

  if (!hasLocalImageGenerationStep) {
    return [];
  }

  return selectedToolIds.size ? [...selectedToolIds] : ['automatic1111', 'forge'];
}

function collectSelectedLocalAudioTransformToolIds(definition = {}) {
  const selectedToolIds = new Set();
  let hasLocalAudioTransformStep = false;

  for (const node of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    if (node?.type !== 'llmPrompt' || node?.config?.executionMode !== 'localTool' || getModelStepOperationId(node) !== PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
      continue;
    }

    hasLocalAudioTransformStep = true;
    const toolId = String(node?.config?.toolId || '').trim().toLowerCase();
    if (toolId) {
      selectedToolIds.add(toolId);
    }
  }

  if (!hasLocalAudioTransformStep) {
    return [];
  }

  return selectedToolIds.size ? [...selectedToolIds] : ['rvc'];
}

function collectSelectedLocalVideoToolIds(definition = {}) {
  const selectedToolIds = new Set();
  let hasLocalVideoStep = false;

  for (const node of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    const isModelStepVideo = node?.type === 'llmPrompt'
      && node?.config?.executionMode === 'localTool'
      && getModelStepOperationId(node) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE;
    const isCollectionVideoMap = node?.type === 'collectionMap'
      && node?.config?.executionMode === 'localTool'
      && getCollectionMapOperationId(node) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE;

    if (!isModelStepVideo && !isCollectionVideoMap) {
      continue;
    }

    hasLocalVideoStep = true;
    const toolId = String(node?.config?.toolId || '').trim().toLowerCase();
    if (toolId) {
      selectedToolIds.add(toolId);
    }
  }

  if (!hasLocalVideoStep) {
    return [];
  }

  return selectedToolIds.size ? [...selectedToolIds] : ['wan21-webui'];
}
function filterLocalImageCheckpointModels(models = []) {
  return (Array.isArray(models) ? models : []).filter((model) => {
    const modelType = String(model?.modelType || '').trim().toLowerCase();
    return modelType === 'checkpoint' || modelType === 'inpainting';
  });
}

function attachDownloadedToolModels(tools = [], downloadedModelsByToolId = {}) {
  if (!Object.keys(downloadedModelsByToolId).length) {
    return tools;
  }

  return tools.map((tool) => {
    if (!tool?.id || !downloadedModelsByToolId[tool.id]) {
      return tool;
    }

    return {
      ...tool,
      downloadedModels: downloadedModelsByToolId[tool.id],
    };
  });
}

function findToolEntryById(tools = [], toolId = '') {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  if (!normalizedToolId) {
    return null;
  }
  return (tools || []).find((tool) => String(tool?.id || '').trim().toLowerCase() === normalizedToolId) || null;
}

async function listDownloadedModelsForToolId(tools = [], toolId = '') {
  const tool = findToolEntryById(tools, toolId);
  if (!tool) {
    return [];
  }
  return listDownloadedModels(tool).catch(() => []);
}

function getDownloadedToolModelEntry(tool, model) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel) {
    return null;
  }

  const downloadedModels = Array.isArray(tool?.downloadedModels) ? tool.downloadedModels : [];
  if (tool?.id === 'automatic1111' || tool?.id === 'forge') {
    return findStableDiffusionCheckpointMatch(getStableDiffusionCheckpointModels(downloadedModels), model);
  }

  if (tool?.id === 'rvc') {
    return findRvcVoiceModelMatch(getRvcVoiceModels(downloadedModels), model);
  }

  return downloadedModels.find((entry) => {
    const candidates = [entry?.id, entry?.name, entry?.fileName, entry?.relativePath, entry?.path]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    return candidates.includes(normalizedModel);
  }) || null;
}

function getOllamaModelCapabilityEntry(contextMaps, model) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel) {
    return null;
  }

  const lookup = contextMaps?.toolsById?.ollama?.modelCapabilitiesByName;
  if (!lookup || typeof lookup !== 'object') {
    return null;
  }

  return lookup[normalizedModel] || null;
}

async function ensureOllamaImageModelSupport(contextMaps, ollamaTool, model) {
  let capability = getOllamaModelCapabilityEntry(contextMaps, model);
  if (!capability) {
    capability = await inspectOllamaModel(ollamaTool, model).catch(() => null);
    if (capability) {
      const normalizedModel = String(model || '').trim().toLowerCase();
      if (!contextMaps.toolsById.ollama.modelCapabilitiesByName || typeof contextMaps.toolsById.ollama.modelCapabilitiesByName !== 'object') {
        contextMaps.toolsById.ollama.modelCapabilitiesByName = {};
      }
      contextMaps.toolsById.ollama.modelCapabilitiesByName[normalizedModel] = capability;
    }
  }

  if (capability?.supportsImageInput === false) {
    throw new Error('Selected model does not support image input. Choose a vision-capable Ollama model before running this step.');
  }
}

async function buildPipelineContext(definition = {}) {
  await initializeProviderRegistry();
  let toolEntries = await buildMergedToolStateList({
    resolveStatuses: true,
    syncDiscovered: true,
  });

  const selectedOllamaModels = collectSelectedOllamaModels(definition);
  if (selectedOllamaModels.length) {
    const ollamaTool = toolEntries.find((tool) => tool?.id === 'ollama') || null;
    if (ollamaTool) {
      const modelCapabilitiesByName = await inspectOllamaModelCapabilities(ollamaTool, selectedOllamaModels).catch(() => null);
      if (modelCapabilitiesByName && Object.keys(modelCapabilitiesByName).length) {
        toolEntries = attachOllamaModelCapabilities(toolEntries, modelCapabilitiesByName);
      }
    }
  }

  const selectedLocalImageToolIds = collectSelectedLocalImageToolIds(definition);
  const selectedLocalAudioTransformToolIds = collectSelectedLocalAudioTransformToolIds(definition);
  const selectedLocalVideoToolIds = collectSelectedLocalVideoToolIds(definition);
  if (selectedLocalImageToolIds.length || selectedLocalAudioTransformToolIds.length || selectedLocalVideoToolIds.length) {
    const downloadedModelsByToolId = {};
    for (const toolId of selectedLocalImageToolIds) {
      downloadedModelsByToolId[toolId] = filterLocalImageCheckpointModels(await listDownloadedModelsForToolId(toolEntries, toolId));
    }
    for (const toolId of selectedLocalAudioTransformToolIds) {
      downloadedModelsByToolId[toolId] = await listDownloadedModelsForToolId(toolEntries, toolId);
    }
    for (const toolId of selectedLocalVideoToolIds) {
      downloadedModelsByToolId[toolId] = await listDownloadedModelsForToolId(toolEntries, toolId);
    }

    toolEntries = attachDownloadedToolModels(toolEntries, downloadedModelsByToolId);
  }

  const promptStyles = typeof listPromptStyles === 'function' ? await listPromptStyles() : [];
  const context = buildContextMaps({
    hardware: null,
    graphWorkflowPresets: await listGraphWorkflowPresets(),
    providers: await listProviderConnections(),
    toolCatalog: getToolCatalog(),
    tools: toolEntries,
  });
  context.promptStyles = promptStyles;
  context.promptStylesById = Object.fromEntries(promptStyles.map((entry) => [entry.id, entry]));
  return context;
}

async function analyzeWithCurrentContext(definition) {
  const context = await buildPipelineContext(definition);
  return {
    analysis: analyzePipeline(definition, context),
    context,
  };
}

function createInitialNodeStates(graph) {
  const nodeStates = {};

  for (const node of graph.pipeline.nodes) {
    nodeStates[node.id] = {
      activeLoops: [],
      collectionControl: null,
      destinationPath: '',
      finishedAt: null,
      history: [],
      iteration: 1,
      loopLabel: '',
      loopMaxAttempts: null,
      loopNodeId: '',
      loopPathLabel: '',
      message: graph.reachableNodeIds.has(node.id) ? 'Waiting for earlier steps to finish.' : 'Skipped because it is not connected to an output.',
      nodeId: node.id,
      nodeLabel: node.label,
      outputs: {},
      preview: '',
      runCount: 0,
      selectedBranch: '',
      startedAt: null,
      status: graph.reachableNodeIds.has(node.id) ? 'queued' : 'skipped',
      type: node.type,
      validation: null,
    };
  }

  return nodeStates;
}

function createLoopStateRecords(graph) {
  const loopStates = {};

  for (const [loopNodeId, loopMeta] of graph.retryLoopsByNodeId.entries()) {
    loopStates[loopNodeId] = {
      attempt: 1,
      carriedArtifact: null,
      history: [],
      lastRetryArtifactSignature: '',
      loopLabel: loopMeta.loopLabel,
      loopNodeId,
      maxAttempts: loopMeta.maxAttempts,
      retryTargetLabel: loopMeta.retryTargetLabel,
      retryTargetNodeId: loopMeta.retryTargetNodeId,
      status: 'ready',
    };
  }

  return loopStates;
}

function createCollectionControlStateRecords(graph) {
  const collectionControlStates = {};

  for (const [nodeId, meta] of graph.collectionAccumulatorsByNodeId.entries()) {
    const node = graph.nodeMap.get(nodeId) || null;
    collectionControlStates[nodeId] = {
      acceptedCount: 0,
      collection: null,
      itemKind: '',
      items: [],
      lastUpdatedAt: '',
      loopLabel: meta.loopLabel || '',
      loopNodeId: meta.loopNodeId || '',
      message: 'Waiting for accepted items.',
      nodeId,
      nodeLabel: node?.label || '',
      status: 'idle',
      targetCount: Number(meta.targetCount || 1) || 1,
    };
  }

  return collectionControlStates;
}

function createRunRecord(analysis, graph, runDirectories) {
  const runId = createUniqueId('run');
  const run = {
    cancelRequested: false,
    collectionControlStates: createCollectionControlStateRecords(graph),
    currentNodeId: null,
    directories: runDirectories,
    executionOrder: [...analysis.executionOrder],
    finishedAt: null,
    loopStates: createLoopStateRecords(graph),
    message: 'Local AI Hub is running the pipeline step by step and will launch local tools only when needed.',
    nodeStates: createInitialNodeStates(graph),
    pendingValidation: null,
    runSettings: normalizePipelineRunSettings(analysis.pipeline?.runSettings),
    cooldown: null,
    cooldownWaitCount: 0,
    pipelineId: analysis.pipeline.id,
    pipelineName: analysis.pipeline.name,
    reachableNodeIds: [...analysis.reachableNodeIds],
    resultsByNodeId: {},
    retryOverridesByNodeId: {},
    revision: 0,
    runId,
    startedAt: new Date().toISOString(),
    status: 'running',
    terminalNodeIds: [...analysis.terminalNodeIds],
    terminalResults: [],
  };

  for (const nodeId of Object.keys(run.collectionControlStates || {})) {
    syncNodeCollectionControlState(run, nodeId);
  }

  return run;
}

function serializeRun(run) {
  if (!run) {
    return null;
  }

  return JSON.parse(JSON.stringify(run));
}

function getActiveRunSnapshot() {
  return serializeRun(activeRun);
}

function updateRunMessage(run, message) {
  const nextMessage = String(message || '').trim();
  if (!run || !nextMessage) {
    return;
  }

  run.message = nextMessage;
  emitPipelineEvent();
}

function createProgressReporter(run, nodeId = '') {
  return (message, runMessage = '') => {
    if (nodeId) {
      updateRunningNodeProgress(run, nodeId, message, runMessage);
      return;
    }

    updateRunMessage(run, runMessage || message);
  };
}

async function disposePipelineTools(orchestrator, run, nodeId, reason) {
  if (!orchestrator) {
    return null;
  }

  try {
    await orchestrator.dispose(createProgressReporter(run, nodeId), reason);
    return null;
  } catch (error) {
    return error;
  }
}

function updateRunningNodeProgress(run, nodeId, message, runMessage = '') {
  if (!run || !nodeId) {
    return;
  }

  const nodeState = run.nodeStates?.[nodeId];
  if (!nodeState) {
    return;
  }

  const nextMessage = String(message || '').trim();
  if (nextMessage) {
    nodeState.message = nextMessage;
  }

  if (runMessage) {
    run.message = runMessage;
  }

  emitPipelineEvent();
}

function markRemainingNodes(run, graph, status, message) {
  for (const nodeId of graph.executionOrder) {
    const nodeState = run.nodeStates[nodeId];
    if (!nodeState || nodeState.status !== 'queued') {
      continue;
    }

    nodeState.status = status;
    nodeState.finishedAt = new Date().toISOString();
    nodeState.message = message;
  }
}

function cloneLoopContexts(loopContexts = []) {
  return Array.isArray(loopContexts)
    ? loopContexts.filter(Boolean).map((entry) => ({ ...entry }))
    : [];
}

function formatLoopAttemptLabel(iteration, loopMaxAttempts) {
  const attemptNumber = Number(iteration || 0);
  const maxAttempts = Number(loopMaxAttempts || 0);
  if (maxAttempts > 0) {
    return 'attempt ' + Math.max(1, attemptNumber || 1) + ' of ' + maxAttempts;
  }

  if (attemptNumber > 1) {
    return 'attempt ' + attemptNumber;
  }

  return '';
}

function formatLoopPathLabel(loopContexts = []) {
  const entries = cloneLoopContexts(loopContexts);
  if (entries.length <= 1) {
    return '';
  }

  return entries
    .map((entry) => {
      const attemptLabel = formatLoopAttemptLabel(entry?.iteration, entry?.loopMaxAttempts);
      if (entry?.loopLabel && attemptLabel) {
        return entry.loopLabel + ' ' + attemptLabel;
      }

      return entry?.loopLabel || attemptLabel || '';
    })
    .filter(Boolean)
    .join(' -> ');
}

function getNodeLoopContexts(run, graph, nodeId) {
  const loopNodeIds = graph.retryLoopNodeIdsBySegmentNodeId?.get?.(nodeId);
  if (!Array.isArray(loopNodeIds) || !loopNodeIds.length) {
    return [];
  }

  return loopNodeIds
    .map((loopNodeId) => {
      const loopState = run.loopStates?.[loopNodeId] || null;
      if (!loopState) {
        return null;
      }

      return {
        iteration: loopState.attempt || 1,
        loopLabel: loopState.loopLabel || '',
        loopMaxAttempts: loopState.maxAttempts || null,
        loopNodeId,
        status: loopState.status || 'ready',
      };
    })
    .filter(Boolean);
}

function getNodeLoopState(run, graph, nodeId) {
  const activeLoops = getNodeLoopContexts(run, graph, nodeId);
  const primaryLoop = activeLoops.length ? activeLoops[activeLoops.length - 1] : null;
  return {
    activeLoops,
    iteration: primaryLoop?.iteration || 1,
    loopLabel: primaryLoop?.loopLabel || '',
    loopMaxAttempts: primaryLoop?.loopMaxAttempts || null,
    loopNodeId: primaryLoop?.loopNodeId || '',
    loopPathLabel: formatLoopPathLabel(activeLoops),
  };
}

function applyNodeLoopState(nodeState, loopState) {
  if (!nodeState) {
    return;
  }

  nodeState.activeLoops = cloneLoopContexts(loopState?.activeLoops);
  nodeState.iteration = loopState?.iteration || 1;
  nodeState.loopLabel = loopState?.loopLabel || '';
  nodeState.loopMaxAttempts = loopState?.loopMaxAttempts || null;
  nodeState.loopNodeId = loopState?.loopNodeId || '';
  nodeState.loopPathLabel = loopState?.loopPathLabel || '';
}

function buildCollectionControlSnapshot(collectionState) {
  if (!collectionState) {
    return null;
  }

  return {
    acceptedCount: Number(collectionState.acceptedCount || 0) || 0,
    itemKind: String(collectionState.itemKind || '').trim(),
    loopLabel: String(collectionState.loopLabel || '').trim(),
    loopNodeId: String(collectionState.loopNodeId || '').trim(),
    message: String(collectionState.message || '').trim(),
    status: String(collectionState.status || 'idle').trim() || 'idle',
    targetCount: Number(collectionState.targetCount || 0) || 0,
  };
}

function applyNodeCollectionControlState(nodeState, collectionState) {
  if (!nodeState) {
    return;
  }

  nodeState.collectionControl = buildCollectionControlSnapshot(collectionState);
}

function syncNodeCollectionControlState(run, nodeId) {
  if (!run || !nodeId) {
    return;
  }

  applyNodeCollectionControlState(run.nodeStates?.[nodeId], run.collectionControlStates?.[nodeId] || null);
}

function resetCollectionControlStateForFreshPass(collectionState) {
  if (!collectionState) {
    return;
  }

  collectionState.acceptedCount = 0;
  collectionState.collection = null;
  collectionState.itemKind = '';
  collectionState.items = [];
  collectionState.lastUpdatedAt = '';
  collectionState.message = 'Waiting for accepted items.';
  collectionState.status = 'idle';
}

function resetCollectionControlStatesForLoop(run, graph, loopNodeId) {
  if (!run?.collectionControlStates || !loopNodeId) {
    return;
  }

  for (const [nodeId, collectionState] of Object.entries(run.collectionControlStates)) {
    if (String(collectionState?.loopNodeId || '') !== String(loopNodeId)) {
      continue;
    }

    resetCollectionControlStateForFreshPass(collectionState);
    syncNodeCollectionControlState(run, nodeId);
  }
}

function appendHistoryEntry(entries, entry, maxEntries = 12) {
  const history = Array.isArray(entries) ? [...entries] : [];
  history.push(entry);
  return history.slice(-maxEntries);
}

function recordNodeAttemptHistory(nodeState) {
  if (!nodeState || (!nodeState.runCount && nodeState.status === 'queued')) {
    return;
  }

  nodeState.history = appendHistoryEntry(nodeState.history, {
    activeLoops: cloneLoopContexts(nodeState.activeLoops),
    attempt: Number(nodeState.iteration || 1),
    loopMaxAttempts: Number(nodeState.loopMaxAttempts || 0) || null,
    loopPathLabel: nodeState.loopPathLabel || '',
    message: nodeState.message || '',
    preview: nodeState.preview || '',
    recordedAt: new Date().toISOString(),
    selectedBranch: nodeState.selectedBranch || '',
    status: nodeState.status || 'queued',
    validation: nodeState.validation ? JSON.parse(JSON.stringify(nodeState.validation)) : null,
  });
}

function recordLoopHistory(loopState, entry) {
  if (!loopState) {
    return;
  }

  const activeLoops = cloneLoopContexts(entry?.activeLoops);
  loopState.history = appendHistoryEntry(loopState.history, {
    ...entry,
    activeLoops,
    loopPathLabel: entry?.loopPathLabel || formatLoopPathLabel(activeLoops),
    recordedAt: new Date().toISOString(),
  });
}

function resetLoopStateForFreshPass(loopState) {
  if (!loopState) {
    return;
  }

  loopState.attempt = 1;
  loopState.carriedArtifact = null;
  loopState.lastRetryArtifactSignature = '';
  loopState.status = 'ready';
}

function resetNestedLoopStatesForRetry(run, graph, loopNodeId) {
  const triggeringLoopMeta = graph.retryLoopsByNodeId.get(loopNodeId) || null;
  if (!triggeringLoopMeta) {
    return;
  }

  const segmentNodeIds = new Set(triggeringLoopMeta.segmentNodeIds || []);
  for (const [nestedLoopNodeId, nestedLoopMeta] of graph.retryLoopsByNodeId.entries()) {
    if (nestedLoopNodeId === loopNodeId || !segmentNodeIds.has(nestedLoopNodeId)) {
      continue;
    }

    const nestedLoopState = run.loopStates?.[nestedLoopNodeId] || null;
    if (!nestedLoopState) {
      continue;
    }

    if (Number(nestedLoopState.attempt || 1) > 1 || nestedLoopState.status !== 'ready' || nestedLoopState.carriedArtifact) {
      recordLoopHistory(nestedLoopState, {
        attempt: Number(nestedLoopState.attempt || 1),
        loopMaxAttempts: Number(nestedLoopState.maxAttempts || 0) || nestedLoopMeta.maxAttempts || null,
        message: triggeringLoopMeta.loopLabel + ' restarted ' + nestedLoopMeta.loopLabel + ' from its first attempt.',
        preview: '',
        selectedBranch: '',
        status: 'reset',
      });
    }

    resetLoopStateForFreshPass(nestedLoopState);
    resetCollectionControlStatesForLoop(run, graph, nestedLoopNodeId);
  }
}

function resetLoopSegmentForRetry(run, graph, loopNodeId, nextAttempt) {
  const loopMeta = graph.retryLoopsByNodeId.get(loopNodeId) || null;
  const loopState = run.loopStates?.[loopNodeId] || null;
  if (!loopMeta || !loopState) {
    return;
  }

  loopState.attempt = nextAttempt;
  loopState.status = 'retrying';
  resetNestedLoopStatesForRetry(run, graph, loopNodeId);
  if (isArtifactCollection(loopState.carriedArtifact)) {
    resetCollectionControlStatesForLoop(run, graph, loopNodeId);
  }

  for (const segmentNodeId of loopMeta.segmentExecutionOrder) {
    delete run.resultsByNodeId[segmentNodeId];
    const nodeState = run.nodeStates?.[segmentNodeId];
    if (!nodeState) {
      continue;
    }

    recordNodeAttemptHistory(nodeState);
    nodeState.status = 'queued';
    nodeState.startedAt = null;
    nodeState.finishedAt = null;
    nodeState.message = 'Waiting for attempt ' + nextAttempt + ' of ' + loopState.maxAttempts + '.';
    nodeState.outputs = {};
    nodeState.preview = '';
    nodeState.selectedBranch = '';
    nodeState.destinationPath = '';
    nodeState.validation = null;
    applyNodeLoopState(nodeState, getNodeLoopState(run, graph, segmentNodeId));
    applyNodeCollectionControlState(nodeState, run.collectionControlStates?.[segmentNodeId] || null);
  }
}

function getIncomingEdgesForPortKey(graph, portKey) {
  if (!graph || !portKey) {
    return [];
  }

  const incomingEdges = graph.incomingEdgesByPortKey?.get?.(portKey);
  if (Array.isArray(incomingEdges)) {
    return incomingEdges.filter(Boolean);
  }

  const incomingEdge = graph.incomingEdgeByPortKey?.get?.(portKey);
  return incomingEdge ? [incomingEdge] : [];
}

function getNodeInputArtifacts(nodeId, portId, graph, resultsByNodeId, run = null) {
  if (run) {
    const carriedEntries = getLoopCarriedArtifactsForNodePort(nodeId, portId, graph, run);
    if (carriedEntries.length) {
      const selectedEntry = carriedEntries[carriedEntries.length - 1];
      return [{
        artifact: selectedEntry.artifact,
        edge: null,
        isLoopRetry: true,
        loopMeta: selectedEntry.loopMeta,
        loopState: selectedEntry.loopState,
      }];
    }
  }

  return getIncomingEdgesForPortKey(graph, nodeId + ':' + portId)
    .map((edge) => ({
      artifact: resultsByNodeId[edge.source.nodeId]?.outputs?.[edge.source.portId] || null,
      edge,
    }))
    .filter((entry) => Boolean(entry.artifact));
}

function getNodeInputArtifact(nodeId, portId, graph, resultsByNodeId, run = null) {
  return getNodeInputArtifacts(nodeId, portId, graph, resultsByNodeId, run)[0]?.artifact;
}

function getLoopCarriedArtifactsForNode(nodeId, graph, run) {
  const loopNodeIds = graph.retryLoopNodeIdsByTargetNodeId?.get?.(nodeId);
  if (!Array.isArray(loopNodeIds) || !loopNodeIds.length) {
    return [];
  }

  return loopNodeIds
    .map((loopNodeId) => {
      const loopMeta = graph.retryLoopsByNodeId.get(loopNodeId) || null;
      const loopState = run.loopStates?.[loopNodeId] || null;
      if (!loopMeta || !loopState || loopMeta.retryEntryMode !== 'branchMerge') {
        return null;
      }

      if (Number(loopState.attempt || 1) <= 1 || !loopState.carriedArtifact) {
        return null;
      }

      return {
        artifact: loopState.carriedArtifact,
        loopMeta,
        loopState,
      };
    })
    .filter(Boolean);
}

function getLoopCarriedArtifactForNode(nodeId, graph, run) {
  const carriedEntries = getLoopCarriedArtifactsForNode(nodeId, graph, run);
  return carriedEntries.length ? carriedEntries[carriedEntries.length - 1] : null;
}

function getLoopCarriedArtifactsForNodePort(nodeId, portId, graph, run) {
  const loopNodeIds = graph.retryLoopNodeIdsByTargetNodeId?.get?.(nodeId);
  if (!Array.isArray(loopNodeIds) || !loopNodeIds.length) {
    return [];
  }

  return loopNodeIds
    .map((loopNodeId) => {
      const loopMeta = graph.retryLoopsByNodeId.get(loopNodeId) || null;
      const loopState = run.loopStates?.[loopNodeId] || null;
      if (!loopMeta || !loopState || loopMeta.retryEntryMode !== 'inputPort' || loopMeta.retryEntryPortId !== portId) {
        return null;
      }

      if (Number(loopState.attempt || 1) <= 1 || !loopState.carriedArtifact) {
        return null;
      }

      return {
        artifact: loopState.carriedArtifact,
        loopMeta,
        loopState,
      };
    })
    .filter(Boolean);
}

function resolveRetryLoopTerminationAction(loopMeta, node) {
  return String(loopMeta?.terminationAction || node?.config?.retryTerminationAction || '').trim() === 'complete' ? 'complete' : 'fail';
}

function shouldStopRetryLoopOnRepeatedArtifact(loopMeta, node) {
  const explicitValue = typeof loopMeta?.stopWhenRetryArtifactRepeats === 'boolean'
    ? loopMeta.stopWhenRetryArtifactRepeats
    : node?.config?.stopWhenRetryArtifactRepeats;
  return Boolean(explicitValue);
}

function createArtifactTerminationSignature(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return '';
  }

  const signatureParts = [
    String(artifact.kind || ''),
    String(artifact.text || ''),
    String(artifact.previewText || ''),
    String(artifact.summary || ''),
    String(artifact.fileName || ''),
    String(artifact.mimeType || ''),
    String(artifact.width || ''),
    String(artifact.height || ''),
    String(artifact.sizeBytes || ''),
  ];
  if (isCompositionArtifact(artifact)) {
    const trackSignature = (Array.isArray(artifact?.composition?.tracks) ? artifact.composition.tracks : [])
      .map((track, index) => {
        if (String(track?.kind || '').trim() === 'visual-sequence') {
          return [
            String(index),
            String(track?.role || ''),
            String(track?.itemDurationSeconds || ''),
            (Array.isArray(track?.items) ? track.items : []).map((entry, itemIndex) => [
              String(itemIndex),
              String(entry?.itemId || ''),
              String(entry?.summary || ''),
              createArtifactTerminationSignature(entry?.artifact || null),
            ].join('::')).join('|'),
          ].join('::');
        }

        return [
          String(index),
          String(track?.role || ''),
          createArtifactTerminationSignature(track?.artifact || null),
        ].join('::');
      })
      .join('|');
    return signatureParts.concat([
      String(artifact?.composition?.recipeId || ''),
      String(artifact?.composition?.exportKind || ''),
      trackSignature,
    ]).join('|');
  }

  if (isArtifactCollection(artifact)) {
    const itemSignature = (Array.isArray(artifact.items) ? artifact.items : [])
      .map((entry, index) => {
        const itemArtifact = entry?.artifact || null;
        return [
          String(index),
          String(entry?.itemId || ''),
          String(entry?.summary || ''),
          itemArtifact ? createArtifactTerminationSignature(itemArtifact) : '',
        ].join('::');
      })
      .join('|');
    return signatureParts.concat([
      String(artifact.itemKind || ''),
      String(artifact.itemCount || 0),
      itemSignature,
    ]).join('|');
  }

  const filePath = String(artifact.filePath || '').trim();
  if (!filePath) {
    return signatureParts.join('|');
  }

  try {
    if (!fs.existsSync(filePath)) {
      return signatureParts.join('|');
    }

    const stat = fs.statSync(filePath);
    const hash = crypto.createHash('sha1');
    const maxFullHashBytes = 8 * 1024 * 1024;
    const sampleBytes = 256 * 1024;
    if (stat.size <= maxFullHashBytes) {
      hash.update(fs.readFileSync(filePath));
    } else {
      const descriptor = fs.openSync(filePath, 'r');
      try {
        const headLength = Math.min(sampleBytes, stat.size);
        const headBuffer = Buffer.alloc(headLength);
        fs.readSync(descriptor, headBuffer, 0, headLength, 0);
        hash.update(headBuffer);

        const tailLength = Math.min(sampleBytes, stat.size);
        const tailBuffer = Buffer.alloc(tailLength);
        fs.readSync(descriptor, tailBuffer, 0, tailLength, Math.max(0, stat.size - tailLength));
        hash.update(tailBuffer);
        hash.update(String(stat.size));
      } finally {
        fs.closeSync(descriptor);
      }
    }

    signatureParts.push(hash.digest('hex'));
  } catch (error) {
    signatureParts.push(String(error?.message || 'hash-unavailable'));
  }

  return signatureParts.join('|');
}

function buildCollectionAccumulatorEntryKey(artifact, lineage, sourceRunCount = 0) {
  const sourceNodeId = String(lineage?.sourceNodeId || '').trim();
  const sourcePortId = String(lineage?.sourcePortId || '').trim();
  const artifactSignature = createArtifactTerminationSignature(artifact);
  const normalizedRunCount = Number(sourceRunCount || 0) || 0;
  if (!sourceNodeId && !sourcePortId && !artifactSignature) {
    return '';
  }

  return [sourceNodeId, sourcePortId, String(normalizedRunCount), artifactSignature].join('::');
}

function getRetryLoopAccumulatorCollectionState(node, graph, completeArtifact) {
  if (!node?.id || !graph || !completeArtifact || !isArtifactCollection(completeArtifact)) {
    return null;
  }

  const completeEdges = getIncomingEdgesForPortKey(graph, node.id + ':complete') || [];
  if (completeEdges.length !== 1) {
    return null;
  }

  const completeEdge = completeEdges[0];
  const sourceNode = graph.nodeMap.get(completeEdge.source.nodeId) || null;
  if (!sourceNode || sourceNode.type !== 'collectionAccumulator' || completeEdge.source.portId !== 'collection') {
    return null;
  }

  const accumulation = completeArtifact.accumulation && typeof completeArtifact.accumulation === 'object'
    ? completeArtifact.accumulation
    : null;
  const acceptedCount = Number(accumulation?.acceptedCount || completeArtifact.itemCount || 0) || 0;
  const targetCount = Number(accumulation?.targetCount || acceptedCount || 1) || 1;
  return {
    acceptedCount,
    nodeId: sourceNode.id,
    nodeLabel: String(accumulation?.nodeLabel || sourceNode.label || 'Accumulate Until Target').trim() || 'Accumulate Until Target',
    status: String(accumulation?.status || '').trim() || 'collecting',
    targetCount,
  };
}

function buildRetryLoopAccumulatorProgressMessage(loopNode, accumulatorState, suffix) {
  if (!accumulatorState) {
    return (loopNode?.label || 'Retry Loop') + (suffix ? ' ' + suffix : '.');
  }

  return accumulatorState.nodeLabel + ' is holding ' + accumulatorState.acceptedCount + ' of ' + accumulatorState.targetCount + ' accepted items' + (suffix ? ' ' + suffix : '.');
}
function finalizeRetryLoopTermination({ action, loopState, message, nodeLoopState, retryArtifact, maxAttempts }) {
  const completed = action === 'complete';
  loopState.carriedArtifact = null;
  loopState.lastRetryArtifactSignature = '';
  loopState.status = completed ? 'completed' : 'failed';
  recordLoopHistory(loopState, {
    activeLoops: nodeLoopState.activeLoops,
    attempt: Number(loopState.attempt || 1),
    loopMaxAttempts: maxAttempts,
    loopPathLabel: nodeLoopState.loopPathLabel,
    message,
    preview: retryArtifact ? summarizeArtifact(retryArtifact) : '',
    selectedBranch: 'retry-terminated',
    status: completed ? 'completed' : 'failed',
  });

  if (completed) {
    return {
      message,
      outputs: {
        result: retryArtifact,
      },
      preview: retryArtifact ? summarizeArtifact(retryArtifact) : '',
      selectedBranch: 'retry-terminated',
    };
  }

  throw new Error(message);
}

function getMissingRequiredInputs(node, graph, resultsByNodeId, run = null) {
  const definition = getNodeTypeDefinition(node?.type);
  if (!definition) {
    return [];
  }

  return (definition.inputPorts || [])
    .filter((port) => port.required)
    .filter((port) => getNodeInputArtifacts(node.id, port.id, graph, resultsByNodeId, run).length === 0)
    .map((port) => port.label);
}

async function buildArtifactMessageContentPart(artifact, partType = 'file') {
  const filePath = path.resolve(String(artifact?.filePath || '').trim());
  if (!filePath || !(await fs.pathExists(filePath))) {
    const missingLabel = partType === 'video'
      ? 'video'
      : partType === 'image'
        ? 'image'
        : 'file';
    throw new Error('The ' + missingLabel + ' for this step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  const fallbackMimeType = partType === 'video'
    ? 'video/mp4'
    : partType === 'image'
      ? 'image/png'
      : 'application/octet-stream';
  return {
    type: partType,
    data: (await fs.readFile(filePath)).toString('base64'),
    fileName: String(artifact?.fileName || path.basename(filePath)).trim() || path.basename(filePath),
    mimeType: String(artifact?.mimeType || fallbackMimeType).trim() || fallbackMimeType,
  };
}

async function buildImageMessageContentPart(artifact) {
  return buildArtifactMessageContentPart(artifact, 'image');
}

async function buildVideoMessageContentPart(artifact) {
  return buildArtifactMessageContentPart(artifact, 'video');
}

async function buildFileMessageContentPart(artifact) {
  return buildArtifactMessageContentPart(artifact, 'file');
}

function getArtifactBinaryPartType(artifact, fallbackType = 'file') {
  const partType = String(artifact?.attachmentKind || '').trim().toLowerCase();
  if (partType === 'image' || partType === 'video' || partType === 'file') {
    return partType;
  }

  return fallbackType;
}

function getArtifactReviewLabel(artifact) {
  if (!artifact) {
    return 'artifact';
  }

  if (artifact.kind === PORT_KIND_VIDEO && artifact.previewKind === 'animated-image') {
    return 'animated image';
  }

  if (artifact.kind === PORT_KIND_VIDEO) {
    return 'video';
  }

  if (artifact.kind === PORT_KIND_IMAGE) {
    return artifact.isAnimated ? 'animated image' : 'image';
  }

  if (artifact.kind === PORT_KIND_FILE) {
    return 'file';
  }

  return artifact.kind || 'artifact';
}

async function buildPreferredArtifactMessageContentPart(artifact, fallbackType = 'file') {
  const partType = getArtifactBinaryPartType(artifact, fallbackType);
  if (partType === 'image') {
    return buildImageMessageContentPart(artifact);
  }

  if (partType === 'video') {
    return buildVideoMessageContentPart(artifact);
  }

  return buildFileMessageContentPart(artifact);
}

function uniqueKinds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function getLlmPromptCapabilityProfile(node) {
  const executionMode = node?.config?.executionMode === 'ollama'
    ? 'ollama'
    : node?.config?.executionMode === 'localTool'
      ? 'localTool'
      : 'cloud';
  const operationId = executionMode === 'localTool'
    ? getModelStepOperationId(node)
    : PIPELINE_OPERATION_IDS.LLM_PROMPT;
  const providerId = String(node?.config?.providerId || '').trim();
  const modelId = String(node?.config?.model || '').trim();
  const capability = executionMode === 'ollama'
    ? getToolPipelineOperation('ollama', PIPELINE_OPERATION_IDS.LLM_PROMPT)
    : executionMode === 'cloud' && providerId
      ? getProviderModelCapabilities(providerId, modelId)?.operations?.[operationId] || getProviderPipelineOperation(providerId, operationId)
      : executionMode === 'cloud'
        ? getProviderPipelineOperation('', operationId)
        : null;
  const inputKinds = uniqueKinds(capability?.inputKinds || []);
  const directKinds = uniqueKinds(Array.isArray(capability?.directInputKinds) && capability.directInputKinds.length ? capability.directInputKinds : inputKinds);
  return {
    capability: capability || null,
    directKinds,
    inputKinds,
  };
}

function getValidationCapabilityProfile(node) {
  const capability = node?.config?.llmExecutionMode === 'ollama'
    ? getToolPipelineOperation('ollama', PIPELINE_OPERATION_IDS.VALIDATION_LLM)
    : getProviderPipelineOperation(String(node?.config?.providerId || '').trim(), PIPELINE_OPERATION_IDS.VALIDATION_LLM);
  const inputKinds = uniqueKinds(capability?.inputKinds || []);
  const directKinds = uniqueKinds(Array.isArray(capability?.directInputKinds) && capability.directInputKinds.length ? capability.directInputKinds : inputKinds);
  const derivedKinds = uniqueKinds(capability?.derivedInputKinds || []);
  return {
    capability: capability || null,
    derivedKinds,
    directKinds,
    inputKinds,
  };
}

function getValidationEvidenceModeLabel(reviewContext = {}) {
  switch (String(reviewContext?.evidenceMode || '').trim()) {
    case 'direct-image':
      return 'The validator can inspect the attached image directly.';
    case 'direct-video':
      return 'The validator can inspect the attached video directly.';
    case 'direct-animated-image':
      return 'The validator can inspect the attached animated image directly as motion evidence.';
    case 'direct-file':
      return 'The validator can inspect the attached file directly.';
    case 'derived-file-text':
      return 'The validator cannot open the raw file directly here, so Local AI Hub is sending extracted document text and metadata.';
    case 'derived-image-description':
      return 'The validator is relying on extracted image description and metadata instead of a direct image attachment.';
    case 'structured-collection':
      return 'The validator is reviewing an ordered collection as a whole using Local AI Hub collection evidence.';
    case 'structured-plan':
      return 'The validator is reviewing a structured Plan artifact with Local AI Hub plan-review evidence.';
    case 'whole-collection-review':
      return 'The validator is paused so you can review the ordered collection as a whole.';
    case 'text-only':
      return 'The validator is reviewing plain text only.';
    default:
      return 'The validator is reviewing metadata and any extracted supporting context only.';
  }
}

function getUserValidationEvidenceMode(artifact, planReview) {
  if (isArtifactCollection(artifact)) {
    return 'whole-collection-review';
  }

  return planReview ? 'structured-plan' : 'user-review';
}
function canAttachValidationFileDirectly(node, artifact, profile) {
  if (!profile?.directKinds?.includes(PORT_KIND_FILE) || !artifact?.filePath || node?.config?.llmExecutionMode === 'ollama') {
    return false;
  }

  const providerId = String(node?.config?.providerId || '').trim().toLowerCase();
  if (providerId === 'google') {
    return true;
  }

  return providerId === 'anthropic' && String(artifact?.mimeType || '').trim().toLowerCase() === 'application/pdf';
}

function canAttachValidationVideoDirectly(node, artifact, profile) {
  return Boolean(
    profile?.directKinds?.includes(PORT_KIND_VIDEO)
      && artifact?.filePath
      && node?.config?.llmExecutionMode !== 'ollama'
      && String(node?.config?.providerId || '').trim().toLowerCase() === 'google',
  );
}

function buildValidationPrompt(node, artifactDescription, reviewContext) {
  const ruleset = String(node.config?.ruleset || '').trim() || 'Decide whether this artifact should pass or fail based on the available evidence.';
  const sections = [
    'Validation rules:\n' + ruleset,
    reviewContext?.artifactKind === PORT_KIND_COLLECTION
      ? 'Collection scope:\nReview the ordered collection as a whole. Do not fan out into separate per-item pass or fail decisions unless the ruleset explicitly asks for commentary about individual items.'
      : '',
    'Evidence mode:\n' + getValidationEvidenceModeLabel(reviewContext),
    reviewContext?.limitations?.length ? 'Evidence limitations:\n- ' + reviewContext.limitations.join('\n- ') : '',
    'Artifact to review:\n' + artifactDescription,
    reviewContext?.attachedPartTypes?.length
      ? 'The actual ' + reviewContext.attachedPartTypes.join(' and ') + ' evidence is attached below. Review the attachment first and use the details above as supporting context.'
      : 'No binary attachment is included for this review. Use only the evidence described above.',
    'Return JSON only.',
  ].filter(Boolean);
  return sections.join('\n\n');
}
async function buildLlmMessages(node, inputArtifact) {
  const instruction = String(node.config?.instruction || '').trim();
  const systemPrompt = String(node.config?.systemPrompt || '').trim();
  const capabilityProfile = getLlmPromptCapabilityProfile(node);
  const messages = [];

  if (!inputArtifact) {
    throw new Error('This LLM step did not receive any input.');
  }

  if (systemPrompt) {
    messages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  if (inputArtifact.kind === PORT_KIND_TEXT) {
    const normalizedInput = String(inputArtifact.text || '').trim();
    if (!normalizedInput) {
      throw new Error('This LLM step did not receive any text input.');
    }

    messages.push({
      role: 'user',
      content: instruction ? instruction + '\n\nInput:\n' + normalizedInput : normalizedInput,
    });
    return messages;
  }

  if (inputArtifact.kind === PORT_KIND_IMAGE && inputArtifact.filePath) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: instruction || 'Describe this image in plain English.',
        },
        await buildImageMessageContentPart(inputArtifact),
      ],
    });
    return messages;
  }

  if ((inputArtifact.kind === PORT_KIND_FILE || inputArtifact.kind === PORT_KIND_VIDEO) && inputArtifact.filePath) {
    if (!capabilityProfile.directKinds.includes(inputArtifact.kind)) {
      throw new Error(
        inputArtifact.kind === PORT_KIND_VIDEO
          ? 'This model step does not accept video input with the selected target.'
          : 'This model step does not accept file input with the selected target.',
      );
    }

    const artifactDescription = await describeArtifactForLlm(inputArtifact);
    const attachmentPartType = inputArtifact.kind === PORT_KIND_VIDEO
      ? getArtifactBinaryPartType(inputArtifact, 'video')
      : getArtifactBinaryPartType(inputArtifact, 'file');
    const attachment = await buildPreferredArtifactMessageContentPart(inputArtifact, inputArtifact.kind === PORT_KIND_VIDEO ? 'video' : 'file');
    const reviewLabel = inputArtifact.kind === PORT_KIND_VIDEO && attachmentPartType === 'image'
      ? 'animated image'
      : getArtifactReviewLabel(inputArtifact);
    const defaultPrompt = 'Review this ' + reviewLabel + ' and respond in plain English.';

    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: (instruction || defaultPrompt) + '\n\nArtifact details:\n' + artifactDescription,
        },
        attachment,
      ],
    });
    return messages;
  }

  throw new Error('This LLM step currently supports only the artifact types allowed by the selected provider or model mode.');
}

function collectStructuredReplyCandidates(replyText) {
  const raw = String(replyText || '').trim();
  if (!raw) {
    return [];
  }

  const candidates = [];
  const pushCandidate = (value, repaired = false) => {
    const normalized = String(value || '').trim();
    if (!normalized || candidates.some((candidate) => candidate.text === normalized)) {
      return;
    }
    candidates.push({
      repaired,
      text: normalized,
    });
  };

  pushCandidate(raw);

  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    pushCandidate(match[1]);
  }

  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    pushCandidate(objectMatch[0]);
  }

  const firstObjectIndex = raw.indexOf('{');
  const lastObjectIndex = raw.lastIndexOf('}');
  if (firstObjectIndex >= 0 && lastObjectIndex > firstObjectIndex) {
    pushCandidate(raw.slice(firstObjectIndex, lastObjectIndex + 1));
  }

  for (const candidate of [...candidates]) {
    pushCandidate(candidate.text.replace(/,\s*([}\]])/g, '$1'), true);
  }

  return candidates;
}

function classifyPlannerValidationFailure(errors = []) {
  const text = (Array.isArray(errors) ? errors : []).join(' ').toLowerCase();
  if (/image prompt|imageprompt/.test(text)) {
    return 'missing-image-prompt';
  }
  if (/startseconds|endseconds|durationseconds|timing|duration|start|end/.test(text)) {
    return 'missing-timing-fields';
  }
  if (/scene|scenes|minimum|at least|too few/.test(text)) {
    return 'too-few-scenes';
  }
  return 'schema-invalid';
}

function parsePlannerReplyDetailed(schemaId, replyText, options = {}) {
  const raw = String(replyText || '').trim();
  if (!raw) {
    const error = new Error('The planner returned an empty reply.');
    error.failureReason = 'empty-response';
    error.userMessage = 'The planner returned an empty reply.';
    throw error;
  }

  let schemaError = '';
  let schemaFailureReason = 'schema-invalid';
  let parsedJson = false;
  for (const candidate of collectStructuredReplyCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate.text);
      parsedJson = true;
      const validation = validatePlanAgainstSchema(schemaId, parsed, options);
      if (validation.ok) {
        return {
          jsonRepairAttempted: Boolean(candidate.repaired),
          plan: validation.value,
          rawPlan: parsed,
          repairedBySchema: Array.isArray(parsed.scenes) && Array.isArray(validation.value?.scenes)
            ? validation.value.scenes.length > parsed.scenes.length
            : false,
        };
      }

      schemaError = validation.errors[0] || 'The planner reply did not match the expected plan shape.';
      schemaFailureReason = classifyPlannerValidationFailure(validation.errors);
    } catch {
      continue;
    }
  }

  if (schemaError) {
    const error = new Error(schemaError);
    error.failureReason = schemaFailureReason;
    error.userMessage = schemaFailureReason === 'missing-image-prompt'
      ? 'The planner returned JSON, but one or more scenes were missing clean image prompts.'
      : schemaFailureReason === 'missing-timing-fields'
        ? 'The planner returned JSON, but one or more scenes were missing usable timing fields.'
        : 'The planner returned JSON, but it did not match the required plan schema.';
    throw error;
  }

  const error = new Error('The planner reply was not valid JSON. Ask the model to return JSON only for this planner step.');
  error.failureReason = parsedJson ? 'malformed-json' : 'invalid-json';
  error.userMessage = 'The planner reply was not valid JSON.';
  throw error;
}

function parsePlannerReply(schemaId, replyText, options = {}) {
  return parsePlannerReplyDetailed(schemaId, replyText, options).plan;
}

function getPlannerRequestTextLength(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => {
    const content = message?.content;
    if (Array.isArray(content)) {
      return total + content.reduce((innerTotal, part) => innerTotal + String(part?.text || '').length, 0);
    }

    return total + String(content || '').length;
  }, 0);
}

function getPacketTranscriptDurationSeconds(packet = {}) {
  const sourceArtifacts = Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts : [];
  const candidates = sourceArtifacts
    .map((artifact) => Number(artifact?.transcription?.durationSeconds || 0) || 0)
    .filter((duration) => duration > 0);
  if (candidates.length) {
    return Math.max(...candidates);
  }

  const segmentEnds = sourceArtifacts.flatMap((artifact) => (
    Array.isArray(artifact?.transcription?.segments)
      ? artifact.transcription.segments.map((segment) => Number(segment?.end ?? segment?.endSeconds ?? 0) || 0)
      : []
  )).filter((duration) => duration > 0);
  return segmentEnds.length ? Math.max(...segmentEnds) : 0;
}

function estimatePlannerSceneCount(packet = {}) {
  const durationSeconds = getPacketTranscriptDurationSeconds(packet);
  if (durationSeconds > 0) {
    return Math.max(1, Math.min(90, Math.ceil(durationSeconds / 8)));
  }

  const sourceText = [
    packet.sourceSummary,
    ...(Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts : []).map((artifact) => artifact?.textExcerpt || artifact?.summary || ''),
    packet.workingNotes,
  ].join(' ');
  const wordCount = sourceText.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.min(90, Math.ceil(Math.max(1, wordCount) / 70)));
}

function estimatePlannerMaxOutputTokens(schemaId, packet = {}) {
  if (String(schemaId || '').trim() !== DEFAULT_PLANNING_SCHEMA_ID && String(packet?.schemaId || '').trim() !== DEFAULT_PLANNING_SCHEMA_ID) {
    return 4096;
  }

  const sceneCount = estimatePlannerSceneCount(packet);
  return Math.max(4096, Math.min(8192, 1600 + (sceneCount * 420)));
}

function clonePlannerValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizePlannerSeconds(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 1000) / 1000 : null;
}

function getPlannerFallbackSecondsPerImage(packet = {}) {
  const notes = [
    packet?.desiredOutput?.notes,
    packet?.workingNotes,
    packet?.goal,
  ].map((entry) => String(entry || '')).join(' ');
  const match = notes.match(/fallback\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)?\s*(?:per|\/)?\s*(?:image|item|scene)/i);
  const numeric = Number(packet?.desiredOutput?.fallbackSecondsPerImage || packet?.fallbackSecondsPerImage || match?.[1]);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric * 1000) / 1000 : 8;
}

function getLongformTranscriptSegments(packet = {}) {
  const segments = [];
  (Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts : []).forEach((artifact) => {
    const transcription = artifact?.transcription && typeof artifact.transcription === 'object'
      ? artifact.transcription
      : null;
    if (!transcription) {
      return;
    }

    (Array.isArray(transcription.segments) ? transcription.segments : []).forEach((segment, index) => {
      const text = String(segment?.text || '').replace(/\s+/g, ' ').trim();
      if (!text) {
        return;
      }
      const startSeconds = normalizePlannerSeconds(segment?.start ?? segment?.startSeconds) ?? 0;
      const endSeconds = normalizePlannerSeconds(segment?.end ?? segment?.endSeconds) ?? startSeconds;
      segments.push({
        artifactDisplayName: String(artifact.displayName || artifact.fileName || artifact.kind || 'Transcript').trim(),
        endSeconds,
        id: String(segment?.id || segment?.segmentId || segment?.index || index).trim() || String(index),
        index: segments.length,
        startSeconds,
        text,
      });
    });
  });

  return segments
    .filter((segment) => segment.endSeconds > segment.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

function getLongformPlannerDurationSeconds(packet = {}, segments = getLongformTranscriptSegments(packet)) {
  return normalizePlannerSeconds(getPacketTranscriptDurationSeconds(packet))
    || normalizePlannerSeconds(Math.max(0, ...segments.map((segment) => segment.endSeconds)))
    || 0;
}

function shouldUseChunkedLongformPlanner(schemaId, packet = {}) {
  if (String(schemaId || '').trim() !== LONGFORM_SCENE_PLAN_SCHEMA_ID) {
    return false;
  }
  const segments = getLongformTranscriptSegments(packet);
  const durationSeconds = getLongformPlannerDurationSeconds(packet, segments);
  return durationSeconds > LONGFORM_CHUNKED_PLANNER_THRESHOLD_SECONDS && segments.length > 0;
}

function normalizeGlobalSummaryList(entries = [], limit = 5) {
  return [...new Set((Array.isArray(entries) ? entries : [])
    .map((entry) => String(entry || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))]
    .slice(0, limit);
}

function extractCapitalizedPlannerEntities(text, limit = 6) {
  const counts = new Map();
  for (const match of String(text || '').matchAll(/\b[A-Z][a-zA-Z0-9'-]{2,}(?:\s+[A-Z][a-zA-Z0-9'-]{2,}){0,2}\b/g)) {
    const value = match[0].trim();
    if (/^(The|This|That|Local AI Hub|Windows)$/.test(value)) {
      continue;
    }
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([value]) => value)
    .slice(0, limit);
}

function buildLongformGlobalSummary(packet = {}, segments = [], totalDurationSeconds = 0) {
  const transcriptPreview = trimPreviewText(segments.map((segment) => segment.text).join(' '), 900);
  const goal = String(packet.goal || '').trim();
  const sourceSummary = String(packet.sourceSummary || '').trim();
  const stylePolicy = normalizeGlobalSummaryList(packet.stylePolicy, 4);
  const constraints = normalizeGlobalSummaryList(packet.constraints, 4);
  const workingNotes = String(packet.workingNotes || '').trim();
  const allText = [goal, sourceSummary, transcriptPreview, workingNotes].filter(Boolean).join(' ');
  return {
    overallSubject: trimPreviewText(goal || sourceSummary || transcriptPreview || 'Longform narration slideshow', 220),
    toneStyle: trimPreviewText(stylePolicy.join(' | ') || constraints.join(' | ') || 'Clear, grounded, timing-aware slideshow visuals.', 220),
    recurringCharactersEntities: extractCapitalizedPlannerEntities(allText, 6),
    recurringLocationsSettings: normalizeGlobalSummaryList((allText.match(/\b(?:forest|city|room|studio|street|home|office|lab|school|kitchen|porch|gate|path|garden|workshop|market|beach|mountain|village)\b/gi) || []), 6),
    visualMotifs: normalizeGlobalSummaryList((allText.match(/\b(?:light|shadow|window|camera|screen|map|hands|portrait|night|sunrise|rain|smoke|candle|moon|machine|tool)\b/gi) || []), 6),
    continuityNotes: [
      'Keep recurring subjects visually consistent across chunks.',
      'Use previous chunk context only for continuity; do not duplicate planned time.',
      'Total narration duration is ' + String(totalDurationSeconds) + ' seconds.',
    ],
    desiredVisualStyle: trimPreviewText([stylePolicy.join(' | '), constraints.join(' | '), packet?.desiredOutput?.notes].filter(Boolean).join(' | '), 260),
  };
}

function splitLongformTranscriptChunks(segments = [], totalDurationSeconds = 0, targetDurationSeconds = LONGFORM_CHUNK_TARGET_DURATION_SECONDS) {
  const durationSeconds = normalizePlannerSeconds(totalDurationSeconds) || normalizePlannerSeconds(Math.max(0, ...segments.map((segment) => segment.endSeconds))) || 0;
  const chunks = [];
  let chunkStart = 0;
  while (chunkStart < durationSeconds - 0.001) {
    const chunkEnd = Math.min(durationSeconds, chunkStart + Math.min(targetDurationSeconds, LONGFORM_CHUNK_MAX_DURATION_SECONDS));
    const currentSegments = segments.filter((segment) => segment.startSeconds < chunkEnd && segment.endSeconds > chunkStart);
    const contextSegments = segments.filter((segment) => segment.endSeconds <= chunkStart && segment.endSeconds >= chunkStart - LONGFORM_CHUNK_CONTEXT_OVERLAP_SECONDS).slice(-1);
    chunks.push({
      contextSegments,
      durationSeconds: normalizePlannerSeconds(chunkEnd - chunkStart) || (chunkEnd - chunkStart),
      endSeconds: normalizePlannerSeconds(chunkEnd) || chunkEnd,
      index: chunks.length,
      segments: currentSegments,
      startSeconds: normalizePlannerSeconds(chunkStart) || 0,
    });
    chunkStart = chunkEnd;
  }
  return chunks.filter((chunk) => chunk.segments.length);
}

function getChunkMinimumImageCount(chunk, fallbackSecondsPerImage) {
  const fallback = Number(fallbackSecondsPerImage || 0) > 0 ? Number(fallbackSecondsPerImage) : 8;
  return Math.max(1, Math.ceil((Number(chunk?.durationSeconds || 0) || 0) / fallback));
}

function buildChunkPacket(packet, chunk, options = {}) {
  const fallbackSecondsPerImage = options.fallbackSecondsPerImage || getPlannerFallbackSecondsPerImage(packet);
  const chunkMinimumImageCount = getChunkMinimumImageCount(chunk, fallbackSecondsPerImage);
  const relativeSegments = (Array.isArray(chunk.segments) ? chunk.segments : []).map((segment) => ({
    id: segment.id,
    start: normalizePlannerSeconds(Math.max(0, segment.startSeconds - chunk.startSeconds)) ?? 0,
    end: normalizePlannerSeconds(Math.min(chunk.durationSeconds, segment.endSeconds - chunk.startSeconds)) ?? chunk.durationSeconds,
    text: segment.text,
  })).filter((segment) => segment.end > segment.start);
  const contextSegments = (Array.isArray(chunk.contextSegments) ? chunk.contextSegments : []).map((segment) => ({
    id: segment.id,
    originalStartSeconds: segment.startSeconds,
    originalEndSeconds: segment.endSeconds,
    text: trimPreviewText(segment.text, 220),
  }));
  const previousChunkSummary = options.previousChunkSummary || null;
  const recentImagePrompts = normalizeGlobalSummaryList(options.recentImagePrompts, LONGFORM_CHUNK_RECENT_PROMPT_COUNT);
  const globalSummary = options.globalSummary || {};
  const chunkNotes = {
    chunkIndex: chunk.index + 1,
    chunkStartSeconds: chunk.startSeconds,
    chunkEndSeconds: chunk.endSeconds,
    chunkDurationSeconds: chunk.durationSeconds,
    chunkMinimumImageCount,
    timingInstruction: 'Return scene startSeconds and endSeconds relative to this chunk: 0 through ' + chunk.durationSeconds + '. Local AI Hub will offset them back to the full narration timeline.',
    previousContextOnlySegments: contextSegments,
    previousChunkSummary,
    recentImagePrompts,
  };
  return {
    ...clonePlannerValue(packet),
    sourceSummary: 'Compact global summary / visual continuity packet:\n' + JSON.stringify(globalSummary),
    sourceArtifacts: [{
      displayName: 'Chunk ' + String(chunk.index + 1) + ' timed transcript',
      kind: 'text',
      textExcerpt: relativeSegments.map((segment) => segment.text).join(' '),
      transcription: {
        durationSeconds: chunk.durationSeconds,
        segmentCount: relativeSegments.length,
        segments: relativeSegments,
      },
    }],
    desiredOutput: {
      ...(packet.desiredOutput || {}),
      fallbackSecondsPerImage,
      notes: [
        packet?.desiredOutput?.notes,
        'This is chunk ' + String(chunk.index + 1) + '. Return at least chunkMinimumImageCount=' + String(chunkMinimumImageCount) + ' scenes for this chunk only.',
      ].filter(Boolean).join('\n'),
    },
    workingNotes: 'Chunk planning packet:\n' + JSON.stringify(chunkNotes),
  };
}

function buildChunkPlannerGuidance(chunk, chunkMinimumImageCount, fallbackSecondsPerImage) {
  return [
    'Chunked longform planner instructions:',
    'Plan only this chunk. Do not plan before chunkStartSeconds or after chunkEndSeconds.',
    'Return at least chunkMinimumImageCount scenes for this chunk: ' + String(chunkMinimumImageCount) + '.',
    'fallbackSecondsPerImage for this chunk is ' + String(fallbackSecondsPerImage) + '.',
    'Use previous context only for visual continuity. Do not duplicate overlap/context segments as output scenes.',
    'Every scene must include imagePrompt, startSeconds, endSeconds, durationSeconds, narrationExcerpt, and sourceTranscriptSegmentIds.',
    'Scene timing must be relative to the chunk packet transcript, from 0 to ' + String(chunk.durationSeconds) + ' seconds.',
    'Keep imagePrompt clean: no labels, timing metadata, transcript ids, or narrative-analysis fields.',
    'Return JSON only.',
  ].join('\n');
}

function summarizeChunkPlan(plan) {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  return trimPreviewText(scenes.map((scene) => scene.sceneConcept || scene.narrationExcerpt || scene.imagePrompt || '').filter(Boolean).join(' | '), 480);
}

function offsetChunkScenes(plan, chunk) {
  return (Array.isArray(plan?.scenes) ? plan.scenes : []).map((scene, index) => {
    const relativeStart = normalizePlannerSeconds(scene.startSeconds) ?? 0;
    const relativeEnd = normalizePlannerSeconds(scene.endSeconds) ?? normalizePlannerSeconds(relativeStart + (scene.durationSeconds || 0.1)) ?? relativeStart + 0.1;
    const startSeconds = normalizePlannerSeconds(Math.max(chunk.startSeconds, Math.min(chunk.endSeconds, chunk.startSeconds + relativeStart))) ?? chunk.startSeconds;
    const endSeconds = normalizePlannerSeconds(Math.max(startSeconds + 0.1, Math.min(chunk.endSeconds, chunk.startSeconds + relativeEnd))) ?? (startSeconds + 0.1);
    return {
      ...scene,
      sceneId: 'chunk-' + String(chunk.index + 1) + '-scene-' + String(index + 1),
      startSeconds,
      endSeconds,
      durationSeconds: normalizePlannerSeconds(endSeconds - startSeconds) || 0.1,
    };
  });
}

function reconcileMergedLongformScenes(scenes = [], totalDurationSeconds = 0) {
  const durationSeconds = normalizePlannerSeconds(totalDurationSeconds) || Math.max(0, ...scenes.map((scene) => Number(scene.endSeconds || 0) || 0));
  const sortedScenes = (Array.isArray(scenes) ? scenes : [])
    .filter((scene) => scene && typeof scene === 'object')
    .sort((left, right) => (Number(left.startSeconds || 0) || 0) - (Number(right.startSeconds || 0) || 0));
  let cursor = 0;
  return sortedScenes.map((scene, index) => {
    let startSeconds = normalizePlannerSeconds(scene.startSeconds) ?? cursor;
    let endSeconds = normalizePlannerSeconds(scene.endSeconds) ?? normalizePlannerSeconds(startSeconds + (scene.durationSeconds || 0.1)) ?? startSeconds + 0.1;
    if (index === 0) {
      startSeconds = 0;
    } else if (Math.abs(startSeconds - cursor) > 0.001) {
      startSeconds = cursor;
    }
    if (endSeconds <= startSeconds) {
      endSeconds = normalizePlannerSeconds(startSeconds + 0.1) ?? (startSeconds + 0.1);
    }
    if (durationSeconds && endSeconds > durationSeconds) {
      endSeconds = durationSeconds;
    }
    cursor = endSeconds;
    return {
      ...scene,
      sceneId: 'scene-' + String(index + 1),
      startSeconds,
      endSeconds,
      durationSeconds: normalizePlannerSeconds(Math.max(0.1, endSeconds - startSeconds)) || 0.1,
    };
  }).map((scene, index, entries) => {
    if (index === entries.length - 1 && durationSeconds && scene.endSeconds !== durationSeconds) {
      const endSeconds = durationSeconds;
      return {
        ...scene,
        endSeconds,
        durationSeconds: normalizePlannerSeconds(Math.max(0.1, endSeconds - scene.startSeconds)) || scene.durationSeconds,
      };
    }
    return scene;
  });
}

function classifyPlannerFailure(error) {
  const rawMessage = String(error?.userMessage || error?.message || error || '').trim();
  const lower = rawMessage.toLowerCase();
  if (/request too large|too large|context length|context.?window|maximum context|token limit|tpm limit|requested \d+|reduce the length|input is too long/.test(lower)) {
    return {
      failureReason: 'request-too-large',
      userMessage: 'The planner request was too large for the selected provider or model.',
    };
  }
  if (/rate.?limit|too many requests|429|tpm|tokens per minute|requests per minute/.test(lower)) {
    return {
      failureReason: 'rate-limit',
      userMessage: 'The provider rate-limited this planner request.',
    };
  }
  if (/quota|billing|credit|insufficient|payment/.test(lower)) {
    return {
      failureReason: 'quota',
      userMessage: 'The provider reported a quota or billing limit for this planner request.',
    };
  }
  if (/overload|high demand|capacity|temporarily unavailable|503|unavailable|busy/.test(lower)) {
    return {
      failureReason: 'provider-overload',
      userMessage: 'The provider reported high demand or temporary overload for this planner request.',
    };
  }
  if (/max.?output|max_tokens|output token|finish_reason|length/.test(lower)) {
    return {
      failureReason: 'output-token-limit',
      userMessage: 'The planner response hit the model output limit before a complete plan was returned.',
    };
  }
  if (/schema|response.?format|json schema|json mode|unsupported/.test(lower)) {
    return {
      failureReason: 'provider-schema-unsupported',
      userMessage: 'The selected provider or model did not accept the requested JSON/schema planner mode.',
    };
  }
  if (error?.failureReason) {
    return {
      failureReason: error.failureReason,
      userMessage: error.userMessage || rawMessage,
    };
  }
  return {
    failureReason: 'planner-error',
    userMessage: rawMessage || 'The planner could not complete this request.',
  };
}

function estimateChunkPlannerMaxOutputTokens(chunkMinimumImageCount) {
  return Math.max(2048, Math.min(8192, 1400 + (Math.max(1, chunkMinimumImageCount) * 520)));
}

function buildPlanValidationReview(artifact) {
  if (!artifact || String(artifact.kind || '').trim() !== PORT_KIND_PLAN) {
    return null;
  }

  try {
    return buildPlanReviewDocument(artifact.plan || {}, {
      sourcePacket: artifact.sourcePacket || null,
    });
  } catch (error) {
    return {
      findings: [{
        approximate: false,
        category: 'schema-validation',
        detail: error?.message || 'Local AI Hub could not review this plan shape.',
        heuristic: 'schema-validation',
        sceneId: '',
        sceneLabel: '',
        severity: 'error',
        title: 'Plan review could not run',
      }],
      heuristicsUsed: ['Planning schema validation'],
      limitationNote: 'Local AI Hub could not complete the bounded plan review because the plan shape was not usable.',
      planTitle: String(artifact.displayName || 'Plan').trim() || 'Plan',
      reviewVersion: 1,
      sceneCount: 0,
      structuralValidation: {
        errors: [error?.message || 'Local AI Hub could not review this plan shape.'],
        ok: false,
        summary: 'The plan does not match the current planning schema shape yet.',
      },
      summary: {
        errorCount: 1,
        infoCount: 0,
        warningCount: 0,
      },
    };
  }
}

function formatPlanReviewEvidence(planReview, maxFindings = 8) {
  if (!planReview || typeof planReview !== 'object') {
    return '';
  }

  const summary = planReview.summary && typeof planReview.summary === 'object' ? planReview.summary : {};
  const findings = Array.isArray(planReview.findings) ? planReview.findings : [];
  const lines = [
    'Plan review summary: ' + [
      Number(summary.errorCount || 0) ? Number(summary.errorCount || 0) + ' error(s)' : '',
      Number(summary.warningCount || 0) ? Number(summary.warningCount || 0) + ' warning(s)' : '',
      Number(summary.infoCount || 0) ? Number(summary.infoCount || 0) + ' note(s)' : '',
    ].filter(Boolean).join(', ') || 'Plan review summary: no bounded findings.',
    planReview.structuralValidation?.summary ? 'Structural check: ' + planReview.structuralValidation.summary : '',
    planReview.limitationNote ? 'Review boundary: ' + planReview.limitationNote : '',
    findings.length ? 'Findings:' : '',
    ...findings.slice(0, maxFindings).map((finding, index) => {
      const sceneLabel = finding?.sceneLabel ? ' [' + finding.sceneLabel + ']' : '';
      const severity = String(finding?.severity || 'info').toUpperCase();
      const detail = String(finding?.detail || '').trim();
      return (index + 1) + '. ' + severity + sceneLabel + ': ' + (finding?.title || 'Finding') + (detail ? ' - ' + detail : '');
    }),
    findings.length > maxFindings ? '...and ' + (findings.length - maxFindings) + ' more finding(s).' : '',
  ].filter(Boolean);

  return lines.join('\n');
}

function attachPlanValidationResult(artifact, validationResult) {
  if (!artifact || String(artifact.kind || '').trim() !== PORT_KIND_PLAN) {
    return artifact;
  }

  const nextArtifact = serializeArtifactForUi(artifact);
  nextArtifact.lastValidation = serializeArtifactForUi(validationResult);
  nextArtifact.summary = summarizeArtifact(nextArtifact);
  return nextArtifact;
}

function getRetryCorrectionArtifactsForNode(nodeId, graph, run) {
  const loopNodeIds = graph?.retryLoopNodeIdsByTargetNodeId?.get?.(nodeId) || [];
  const artifacts = [];
  for (const loopNodeId of loopNodeIds) {
    const loopState = run?.loopStates?.[loopNodeId] || null;
    if (!loopState || Number(loopState.attempt || 1) <= 1 || !loopState.carriedArtifact) {
      continue;
    }

    artifacts.push(loopState.carriedArtifact);
  }

  return artifacts;
}

function buildPlannerRevisionGuidance(correctionArtifacts = []) {
  const failedPlans = (Array.isArray(correctionArtifacts) ? correctionArtifacts : [])
    .filter((artifact) => artifact && String(artifact.kind || '').trim() === PORT_KIND_PLAN);
  if (!failedPlans.length) {
    return '';
  }

  const sections = failedPlans.slice(-2).map((artifact, index) => {
    const validation = artifact.lastValidation && typeof artifact.lastValidation === 'object' ? artifact.lastValidation : null;
    const planReview = validation?.planReview || buildPlanValidationReview(artifact);
    return [
      'Failed plan review ' + (index + 1) + ':',
      validation?.summary || validation?.reason ? 'Validation reason: ' + (validation.summary || validation.reason) : '',
      formatPlanReviewEvidence(planReview, 6),
    ].filter(Boolean).join('\n');
  });

  return [
    'Revise the plan because a downstream validation step routed the previous Plan to Retry.',
    'Keep the same planning schema and source grounding, but address the review evidence below before returning JSON.',
    ...sections,
  ].join('\n\n');
}

function normalizeTimelineSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return Math.round(numeric * 1000) / 1000;
}

function getTimingMetadataFromCollectionItemMetadata(metadata) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const startSeconds = normalizeTimelineSeconds(source.startSeconds);
  const endSeconds = normalizeTimelineSeconds(source.endSeconds);
  const durationSeconds = normalizeTimelineSeconds(source.durationSeconds)
    || (startSeconds !== null && endSeconds !== null && endSeconds > startSeconds ? normalizeTimelineSeconds(endSeconds - startSeconds) : null);
  return {
    durationSeconds,
    endSeconds,
    hasTiming: Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0,
    startSeconds,
  };
}

function buildPlanSceneCollectionMetadata(planArtifact, textItems) {
  const items = Array.isArray(textItems) ? textItems : [];
  const timings = items.map((item) => getTimingMetadataFromCollectionItemMetadata(item?.metadata));
  const timedItemCount = timings.filter((timing) => timing.hasTiming).length;
  const maxEndSeconds = normalizeTimelineSeconds(Math.max(0, ...timings.map((timing) => Number(timing.endSeconds || 0) || 0)));
  const summedDurationSeconds = normalizeTimelineSeconds(timings.reduce((total, timing) => total + (Number(timing.durationSeconds || 0) || 0), 0));
  const planTiming = planArtifact?.plan?.timing && typeof planArtifact.plan.timing === 'object' ? planArtifact.plan.timing : {};
  const totalPlannedDurationSeconds = normalizeTimelineSeconds(planTiming.totalDurationSeconds) || maxEndSeconds || summedDurationSeconds;
  return {
    plan: {
      schemaFamilyId: String(planArtifact?.plan?.schemaFamilyId || '').trim(),
      schemaId: String(planArtifact?.plan?.schemaId || '').trim(),
      schemaVersion: Number(planArtifact?.plan?.schemaVersion || 0) || null,
      sourcePlanId: String(planArtifact?.id || planArtifact?.artifactId || '').trim(),
      sourcePlanTitle: String(planArtifact?.plan?.title || planArtifact?.displayName || '').trim(),
    },
    timing: {
      itemCount: items.length,
      timingMode: timedItemCount ? 'dynamicFromPlanTiming' : 'fixedDurationFallback',
      timedItemCount,
      totalPlannedDurationSeconds,
      source: String(planTiming.source || 'longform scene plan').trim(),
      coverageNotes: String(planTiming.coverageNotes || '').trim(),
    },
  };
}

function mergeCollectionItemMetadata(sourceMetadata, additions = {}) {
  const base = sourceMetadata && typeof sourceMetadata === 'object' ? serializeArtifactForUi(sourceMetadata) : {};
  const extra = additions && typeof additions === 'object' ? serializeArtifactForUi(additions) : {};
  const merged = {
    ...base,
    ...extra,
  };
  return Object.keys(merged).length ? merged : null;
}

function buildMappedCollectionRootMetadata(sourceCollection, mapping, node, outputKind) {
  const sourceMetadata = sourceCollection?.metadata && typeof sourceCollection.metadata === 'object'
    ? serializeArtifactForUi(sourceCollection.metadata)
    : null;
  if (!sourceMetadata) {
    return null;
  }

  return {
    ...sourceMetadata,
    collectionMap: {
      mappingId: String(mapping?.id || node?.config?.mappingId || '').trim(),
      nodeId: String(node?.id || '').trim(),
      nodeLabel: String(node?.label || '').trim(),
      operationId: String(mapping?.operationId || getCollectionMapOperationId(node)).trim(),
      outputKind: String(outputKind || mapping?.outputKind || '').trim(),
    },
  };
}

function executePlanScenesNode(node, graph, run) {
  const planArtifact = getNodeInputArtifact(node.id, 'plan', graph, run.resultsByNodeId, run);
  if (!planArtifact || String(planArtifact.kind || '').trim() !== PORT_KIND_PLAN) {
    throw new Error('This Plan Scenes step needs a structured Plan input before it can run.');
  }

  const textItems = buildPlanTextCollectionItems(planArtifact.plan || {}, {
    sourcePlan: planArtifact,
  });
  if (!textItems.length) {
    throw new Error('This Plan does not contain any text items to export.');
  }

  const sceneArtifacts = textItems.map((item, index) => createTextArtifact(item.text || '', {
    displayName: item.displayName || 'Plan item ' + String(index + 1),
    role: 'generated',
  }));
  const collectionMetadata = buildPlanSceneCollectionMetadata(planArtifact, textItems);
  const collection = createArtifactCollection(sceneArtifacts.map((artifact, index) => ({
    artifact,
    lineage: {
      sourceNodeId: node.id,
      sourceNodeLabel: node.label,
      sourcePortId: 'collection',
      sourceRunCount: run.nodeStates?.[node.id]?.runCount || 1,
    },
    itemId: textItems[index]?.itemId || '',
    metadata: textItems[index]?.metadata || null,
  })), {
    displayName: node.label,
    itemKind: PORT_KIND_TEXT,
    metadata: collectionMetadata,
    role: 'generated',
  });

  return {
    message: (node.label || 'Plan text bridge') + ' built an ordered text collection with ' + textItems.length + ' item' + (textItems.length === 1 ? '' : 's') + '.',
    outputs: {
      collection,
    },
    preview: summarizeArtifact(collection),
  };
}
function executePlanningPacketNode(node, graph, run, contextMaps) {
  const sourceArtifacts = getNodeInputArtifacts(node.id, 'source', graph, run.resultsByNodeId, run)
    .map((entry) => entry?.artifact || null)
    .filter(Boolean);
  const packetDocument = buildPlanningPacketDocument({
    ...node.config,
    title: node.label,
  }, sourceArtifacts, {
    hardware: contextMaps?.hardware || null,
    schemaId: node.config?.schemaId || DEFAULT_PLANNING_SCHEMA_ID,
  });
  const validation = validatePlanningPacketShape(packetDocument);
  if (!validation.ok) {
    throw new Error(validation.errors[0] || 'This planning packet is not ready yet.');
  }

  const packetArtifact = createPlanningPacketArtifact(validation.value, {
    displayName: node.label,
    role: 'generated',
  });
  const sourceCount = sourceArtifacts.length;
  const schema = getPlanningSchemaDefinition(validation.value.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
  const message = sourceCount > 0
    ? 'Planning Packet organized ' + sourceCount + ' source artifact' + (sourceCount === 1 ? '' : 's') + ' for the ' + (schema?.label || 'plan') + ' workflow.'
    : 'Planning Packet prepared the ' + (schema?.label || 'plan') + ' workflow from the manual source summary.';

  return {
    message,
    outputs: {
      packet: packetArtifact,
    },
    preview: summarizeArtifact(packetArtifact),
  };
}

async function executeChunkedLongformPlanner(options = {}) {
  const {
    buildPromptMessages,
    fallbackSecondsPerImage,
    model,
    node,
    packet,
    plannerGuidance,
    providerId,
    providerLabel,
    reportProgress,
    schema,
    schemaId,
    sendPlannerRequest,
  } = options;
  const segments = getLongformTranscriptSegments(packet);
  const totalDurationSeconds = getLongformPlannerDurationSeconds(packet, segments);
  const globalSummary = buildLongformGlobalSummary(packet, segments, totalDurationSeconds);
  let chunks = splitLongformTranscriptChunks(segments, totalDurationSeconds);
  const chunkPlans = [];
  const chunkFailures = [];
  const chunkDiagnostics = [];
  const recentImagePrompts = [];
  let previousChunkSummary = null;
  let retryAttempted = false;
  let jsonRepairAttempted = false;
  let deterministicFallbackUsed = false;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const chunkMinimumImageCount = getChunkMinimumImageCount(chunk, fallbackSecondsPerImage);
    const chunkPacket = buildChunkPacket(packet, chunk, {
      fallbackSecondsPerImage,
      globalSummary,
      previousChunkSummary,
      recentImagePrompts,
    });
    const chunkGuidance = [
      plannerGuidance,
      buildChunkPlannerGuidance(chunk, chunkMinimumImageCount, fallbackSecondsPerImage),
    ].filter(Boolean).join('\n\n');
    const request = buildPromptMessages(chunkPacket, chunkGuidance);
    const chunkLabel = 'chunk ' + String(chunk.index + 1) + ' of ' + String(chunks.length);

    if (request.promptStats.requestCharacters > LONGFORM_CHUNK_MAX_REQUEST_CHARACTERS && chunk.durationSeconds > 20 && chunk.segments.length > 1) {
      const midpoint = normalizePlannerSeconds(chunk.startSeconds + (chunk.durationSeconds / 2)) || ((chunk.startSeconds + chunk.endSeconds) / 2);
      const replacement = [
        {
          contextSegments: chunk.contextSegments,
          durationSeconds: normalizePlannerSeconds(midpoint - chunk.startSeconds) || (midpoint - chunk.startSeconds),
          endSeconds: midpoint,
          index: chunk.index,
          segments: chunk.segments.filter((segment) => segment.startSeconds < midpoint && segment.endSeconds > chunk.startSeconds),
          startSeconds: chunk.startSeconds,
        },
        {
          contextSegments: chunk.segments.filter((segment) => segment.endSeconds <= midpoint).slice(-1),
          durationSeconds: normalizePlannerSeconds(chunk.endSeconds - midpoint) || (chunk.endSeconds - midpoint),
          endSeconds: chunk.endSeconds,
          index: chunk.index + 1,
          segments: chunk.segments.filter((segment) => segment.startSeconds < chunk.endSeconds && segment.endSeconds > midpoint),
          startSeconds: midpoint,
        },
      ].filter((entry) => entry.durationSeconds > 0 && entry.segments.length);
      if (replacement.length > 1) {
        chunks.splice(chunkIndex, 1, ...replacement);
        chunkIndex -= 1;
        continue;
      }
    }

    let parsed = null;
    let fallbackReason = '';
    try {
      reportProgress?.('Planning ' + chunkLabel + ' with the compact global summary.', 'Running ' + node.label + ' with ' + providerLabel + '...');
      const reply = await sendPlannerRequest(request.messages, false, {
        chunkLabel,
        maxOutputTokens: estimateChunkPlannerMaxOutputTokens(chunkMinimumImageCount),
        statusMessage: 'Planning ' + chunkLabel + ' with ' + providerLabel + '.',
      });
      parsed = parsePlannerReplyDetailed(schemaId, reply, { sourcePacket: chunkPacket });
      jsonRepairAttempted = jsonRepairAttempted || parsed.jsonRepairAttempted;
    } catch (error) {
      const classified = classifyPlannerFailure(error);
      fallbackReason = classified.userMessage || classified.failureReason;
      const shouldRetry = classified.failureReason !== 'request-too-large'
        && request.promptStats.requestCharacters <= LONGFORM_CHUNK_MAX_REQUEST_CHARACTERS;
      if (shouldRetry) {
        retryAttempted = true;
        const retryGuidance = [
          chunkGuidance,
          'Retry repair: the previous chunk planner attempt failed because ' + fallbackReason,
          'Return one valid JSON object only for this chunk. Keep scenes concise and satisfy chunkMinimumImageCount.',
        ].join('\n\n');
        const retryRequest = buildPromptMessages(chunkPacket, retryGuidance);
        try {
          const retryReply = await sendPlannerRequest(retryRequest.messages, true, {
            chunkLabel,
            maxOutputTokens: estimateChunkPlannerMaxOutputTokens(chunkMinimumImageCount),
            statusMessage: 'Retrying ' + chunkLabel + ' with stricter JSON-only guidance in ' + providerLabel + '.',
          });
          parsed = parsePlannerReplyDetailed(schemaId, retryReply, { sourcePacket: chunkPacket });
          jsonRepairAttempted = jsonRepairAttempted || parsed.jsonRepairAttempted;
          fallbackReason = '';
        } catch (retryError) {
          const retryClassified = classifyPlannerFailure(retryError);
          fallbackReason = retryClassified.userMessage || retryClassified.failureReason;
        }
      }
    }

    let chunkPlan = parsed?.plan || null;
    const rawSceneCount = Array.isArray(parsed?.rawPlan?.scenes) ? parsed.rawPlan.scenes.length : null;
    const repairedTooFewScenes = Boolean(parsed?.repairedBySchema) || (rawSceneCount !== null && rawSceneCount < chunkMinimumImageCount);
    if (!chunkPlan) {
      deterministicFallbackUsed = true;
      chunkFailures.push({
        chunkIndex: chunk.index,
        chunkStartSeconds: chunk.startSeconds,
        chunkEndSeconds: chunk.endSeconds,
        failureReason: fallbackReason || 'chunk-planner-failed',
      });
      chunkPlan = buildDeterministicPlanFromPacket(schemaId, chunkPacket, {
        reason: fallbackReason || 'The planner could not produce a usable JSON plan for this chunk.',
      });
      reportProgress?.('Local AI Hub built a fallback plan for ' + chunkLabel + ' only.', 'Built fallback chunk plan.');
    }

    const offsetScenes = offsetChunkScenes(chunkPlan, chunk);
    chunkPlans.push({
      chunk,
      chunkPlan,
      scenes: offsetScenes,
    });
    previousChunkSummary = summarizeChunkPlan(chunkPlan);
    recentImagePrompts.push(...offsetScenes.map((scene) => scene.imagePrompt).filter(Boolean));
    while (recentImagePrompts.length > LONGFORM_CHUNK_RECENT_PROMPT_COUNT) {
      recentImagePrompts.shift();
    }
    chunkDiagnostics.push({
      chunkIndex: chunk.index,
      chunkMinimumImageCount,
      chunkStartSeconds: chunk.startSeconds,
      chunkEndSeconds: chunk.endSeconds,
      deterministicFallbackUsed: !parsed,
      jsonRepairAttempted: Boolean(parsed?.jsonRepairAttempted),
      requestCharacters: request.promptStats.requestCharacters,
      returnedSceneCount: offsetScenes.length,
      tooFewScenesRepaired: repairedTooFewScenes,
    });
  }

  const mergedScenes = reconcileMergedLongformScenes(chunkPlans.flatMap((entry) => entry.scenes), totalDurationSeconds);
  const mergedPlan = {
    schemaId,
    title: String(packet.title || schema?.label || 'Plan').replace(/\s+packet$/i, '').trim() || (schema?.label || 'Plan'),
    timing: {
      timingMode: 'transcriptSegments',
      totalDurationSeconds,
      fallbackSecondsPerImage,
      minimumImageCount: Math.max(1, Math.ceil(totalDurationSeconds / fallbackSecondsPerImage)),
      source: 'Chunked transcript planner',
      coverageNotes: 'Chunked planner merged ' + String(chunks.length) + ' non-overlapping chunk plan(s) and reconciled the timeline from 0 to ' + String(totalDurationSeconds) + ' seconds.',
    },
    overview: {
      meaningIntent: globalSummary.overallSubject || 'Create a usable longform scene plan from the narration.',
      viewerTakeaway: globalSummary.overallSubject || 'The viewer should follow the narration beat by beat.',
      narrativeArc: 'Follow the narration in source order across chunked planner passes.',
      toneStrategy: globalSummary.toneStyle || 'Use grounded, clear slideshow visuals.',
      continuityNotes: normalizeGlobalSummaryList(globalSummary.continuityNotes, 8),
      riskNotes: chunkFailures.length
        ? ['One or more chunks used deterministic fallback while the rest of the plan kept model-planned chunks.']
        : ['Chunked planner used compact global context to preserve continuity without repeating the full transcript.'],
    },
    scenes: mergedScenes,
    openQuestions: [],
  };
  const validation = validatePlanAgainstSchema(schemaId, mergedPlan, { sourcePacket: packet });
  if (!validation.ok) {
    throw new Error(validation.errors[0] || 'Local AI Hub could not merge the chunked scene plan.');
  }

  return {
    diagnostics: {
      chunkDiagnostics,
      chunkFailures,
      chunksPlanned: chunks.length,
      deterministicFallbackUsed,
      failureReason: chunkFailures.length ? 'chunk-fallback-used' : '',
      fallbackReason: chunkFailures.length ? chunkFailures.map((entry) => entry.failureReason).filter(Boolean).join(' | ') : '',
      globalSummary,
      jsonRepairAttempted,
      plannerMode: 'chunked',
      retryAttempted,
    },
    firstRequestCharacters: chunkDiagnostics[0]?.requestCharacters || 0,
    normalizedPlan: validation.value,
  };
}

async function executePlannerNode(node, graph, run, contextMaps, reportProgress) {
  const packetArtifact = getNodeInputArtifact(node.id, 'packet', graph, run.resultsByNodeId, run);
  if (!packetArtifact || String(packetArtifact.kind || '').trim() !== PORT_KIND_PLANNING_PACKET) {
    throw new Error('This Planner step needs a Planning Packet input before it can run.');
  }

  const packetValidation = validatePlanningPacketShape(packetArtifact.packet || {});
  if (!packetValidation.ok) {
    throw new Error(packetValidation.errors[0] || 'This planning packet is not ready yet.');
  }

  const executionMode = node.config?.executionMode === 'ollama' ? 'ollama' : 'cloud';
  const model = String(node.config?.model || '').trim();
  if (!model) {
    throw new Error('Choose or enter a model for the Planner node before running this pipeline.');
  }

  const schemaId = String(node.config?.schemaId || packetValidation.value.schemaId || packetValidation.value?.desiredOutput?.schemaId || DEFAULT_PLANNING_SCHEMA_ID).trim() || DEFAULT_PLANNING_SCHEMA_ID;
  const schema = getPlanningSchemaDefinition(schemaId);
  const plannerRevisionGuidance = buildPlannerRevisionGuidance(getRetryCorrectionArtifactsForNode(node.id, graph, run));
  const plannerGuidance = [node.config?.instruction, plannerRevisionGuidance].map((entry) => String(entry || '').trim()).filter(Boolean).join('\n\n');
  const plannerResponseFormat = buildPlanningSchemaStructuredOutputRequest(schemaId);

  let providerId = '';
  let providerLabel = 'Cloud provider';
  const plannerMaxOutputTokens = estimatePlannerMaxOutputTokens(schemaId, packetValidation.value);

  if (executionMode !== 'ollama') {
    providerId = String(node.config?.providerId || '').trim();
    if (!providerId) {
      throw new Error('Choose a connected cloud provider before running this Planner step.');
    }

    const provider = contextMaps?.providersById?.[providerId] || null;
    if (!provider?.isConnected) {
      throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
    }

    providerLabel = String(provider.name || providerId).trim() || providerId;
  } else {
    providerLabel = 'Ollama';
  }

  const fallbackSecondsPerImage = getPlannerFallbackSecondsPerImage(packetValidation.value);
  const buildPromptMessages = (promptPacket, extraGuidance = '') => {
    const guidance = [extraGuidance].map((entry) => String(entry || '').trim()).filter(Boolean).join('\n\n');
    const plannerPrompt = buildPlannerPrompt(schemaId, promptPacket, {
      compact: true,
      guidance,
      systemPrompt: node.config?.systemPrompt,
    });
    const messages = [];
    if (plannerPrompt.systemPrompt) {
      messages.push({
        role: 'system',
        content: plannerPrompt.systemPrompt,
      });
    }
    messages.push({
      role: 'user',
      content: plannerPrompt.userPrompt,
    });
    return {
      messages,
      promptStats: {
        ...plannerPrompt.promptStats,
        requestCharacters: getPlannerRequestTextLength(messages),
      },
    };
  };

  const buildMessages = (extraGuidance = '') => buildPromptMessages(packetValidation.value, [plannerGuidance, extraGuidance].filter(Boolean).join('\n\n'));

  const sendPlannerRequest = async (messages, retry = false, requestOptions = {}) => {
    if (executionMode === 'ollama') {
      const ollamaTool = await getInstalledToolOrThrow(
        contextMaps,
        'ollama',
        'Install Ollama before using a local Planner step in a pipeline.',
      );
      reportProgress?.(
        requestOptions.statusMessage || (retry ? 'Retrying the planner with stricter JSON-only guidance in Ollama.' : 'Sending the planning packet to Ollama for structured planning.'),
        'Running ' + node.label + ' with Ollama...',
      );
      const result = await chatWithOllama(ollamaTool, {
        messages,
        model,
        ...(plannerResponseFormat ? { format: 'json' } : {}),
      });
      return String(result?.message?.content || '').trim();
    }

    reportProgress?.(
      requestOptions.statusMessage || (retry ? 'Retrying the planner with stricter JSON-only guidance in ' + providerLabel + '.' : 'Sending the planning packet to ' + providerLabel + ' for structured planning.'),
      'Running ' + node.label + ' with ' + providerLabel + '...',
    );
    const result = await chatWithProvider(providerId, {
      messages,
      model,
      timeoutMessage: providerLabel + ' took too long to answer this planner request. Try again or simplify the planning packet if the delay continues.',
      timeoutMs: PLANNER_PROVIDER_TIMEOUT_MS,
      maxOutputTokens: requestOptions.maxOutputTokens || plannerMaxOutputTokens,
      ...(plannerResponseFormat ? { responseFormat: plannerResponseFormat } : {}),
    });
    return String(result?.message?.content || '').trim();
  };

  let normalizedPlan = null;
  let plannerDiagnostics = {
    chunkFailures: [],
    chunksPlanned: 0,
    deterministicFallbackUsed: false,
    failureReason: '',
    fallbackReason: '',
    jsonRepairAttempted: false,
    plannerMode: 'singleShot',
    retryAttempted: false,
  };
  let firstRequest = null;

  if (shouldUseChunkedLongformPlanner(schemaId, packetValidation.value)) {
    const chunkedResult = await executeChunkedLongformPlanner({
      buildPromptMessages,
      fallbackSecondsPerImage,
      model,
      node,
      packet: packetValidation.value,
      plannerGuidance,
      providerId,
      providerLabel,
      reportProgress,
      schema,
      schemaId,
      sendPlannerRequest,
    });
    normalizedPlan = chunkedResult.normalizedPlan;
    plannerDiagnostics = {
      ...plannerDiagnostics,
      ...chunkedResult.diagnostics,
    };
    firstRequest = {
      promptStats: {
        requestCharacters: chunkedResult.firstRequestCharacters,
      },
    };
  } else {
    firstRequest = buildMessages();
    let reply = '';
    let plannerFallbackReason = '';
    try {
      reply = await sendPlannerRequest(firstRequest.messages, false);
    } catch (error) {
      const classified = classifyPlannerFailure(error);
      plannerDiagnostics.failureReason = classified.failureReason;
      throw new Error(classified.userMessage || error?.message || 'The planner request failed.');
    }
    try {
      const parsed = parsePlannerReplyDetailed(schemaId, reply, { sourcePacket: packetValidation.value });
      normalizedPlan = parsed.plan;
      plannerDiagnostics.jsonRepairAttempted = parsed.jsonRepairAttempted;
    } catch (error) {
      const firstErrorMessage = error?.message || 'The planner reply was not usable JSON.';
      plannerDiagnostics.failureReason = error?.failureReason || classifyPlannerFailure(error).failureReason;
      const retryGuidance = [
        'The previous planner reply was not accepted: ' + firstErrorMessage,
        'Return one complete JSON object only. Do not include Markdown, comments, explanations, or partial JSON.',
        'Keep every scene concise, but preserve startSeconds, endSeconds, durationSeconds, narrationExcerpt, sourceTranscriptSegmentIds, and imagePrompt. imagePrompt must be clean prompt text only.',
      ].join('\n');
      const retryRequest = buildMessages(retryGuidance);
      try {
        plannerDiagnostics.retryAttempted = true;
        reply = await sendPlannerRequest(retryRequest.messages, true);
        const parsed = parsePlannerReplyDetailed(schemaId, reply, { sourcePacket: packetValidation.value });
        normalizedPlan = parsed.plan;
        plannerDiagnostics.jsonRepairAttempted = plannerDiagnostics.jsonRepairAttempted || parsed.jsonRepairAttempted;
      } catch (retryError) {
        const retryClassified = classifyPlannerFailure(retryError);
        plannerFallbackReason = retryError?.message || firstErrorMessage;
        plannerDiagnostics.failureReason = retryClassified.failureReason || plannerDiagnostics.failureReason;
        plannerDiagnostics.fallbackReason = plannerFallbackReason;
        const fallbackPlan = buildDeterministicPlanFromPacket(schemaId, packetValidation.value, {
          reason: plannerFallbackReason,
        });
        if (!fallbackPlan) {
          throw retryError;
        }
        normalizedPlan = fallbackPlan;
        plannerDiagnostics.deterministicFallbackUsed = true;
        reportProgress?.('The planner reply was not usable JSON, so Local AI Hub built a timing-aware fallback plan from the transcript.', 'Built fallback scene plan.');
      }
    }
  }

  if (!String(normalizedPlan.title || '').trim() || String(normalizedPlan.title || '').trim().toLowerCase() === 'scene plan') {
    normalizedPlan.title = String(packetValidation.value.title || schema?.label || 'Plan').replace(/\s+packet$/i, '').trim() || (schema?.label || 'Plan');
  }

  const planArtifact = createPlanArtifact(normalizedPlan, {
    displayName: node.label,
    planner: {
      executionMode,
      model,
      nodeId: node.id,
      nodeLabel: node.label,
      providerId,
      providerLabel,
      requestCharacters: firstRequest.promptStats.requestCharacters,
      schemaId,
      schemaLabel: String(schema?.label || 'Plan').trim() || 'Plan',
      plannerMode: plannerDiagnostics.plannerMode,
      failureReason: plannerDiagnostics.failureReason,
      fallbackReason: plannerDiagnostics.fallbackReason,
      jsonRepairAttempted: Boolean(plannerDiagnostics.jsonRepairAttempted),
      retryAttempted: Boolean(plannerDiagnostics.retryAttempted),
      deterministicFallbackUsed: Boolean(plannerDiagnostics.deterministicFallbackUsed),
      usedDeterministicFallback: Boolean(plannerDiagnostics.deterministicFallbackUsed),
      chunksPlanned: Number(plannerDiagnostics.chunksPlanned || 0) || 0,
      chunkFailures: plannerDiagnostics.chunkFailures || [],
      chunkDiagnostics: plannerDiagnostics.chunkDiagnostics || [],
      globalSummary: plannerDiagnostics.globalSummary || null,
    },
    role: 'generated',
    sourcePacket: packetValidation.value,
  });
  const planItemCount = Number(planArtifact.sceneCount || planArtifact.sectionCount || planArtifact.clipCount || normalizedPlan.scenes?.length || normalizedPlan.sections?.length || normalizedPlan.clips?.length || 0) || 0;
  const plannerResultMessage = plannerDiagnostics.deterministicFallbackUsed
    ? plannerDiagnostics.plannerMode === 'chunked'
      ? providerLabel + ' planned the longform scene plan in ' + Number(plannerDiagnostics.chunksPlanned || 0) + ' chunk(s); Local AI Hub used deterministic fallback for ' + Number(plannerDiagnostics.chunkFailures?.length || 0) + ' chunk(s) and merged ' + planItemCount + ' item' + (planItemCount === 1 ? '' : 's') + '.'
      : 'The planner could not return a usable structured plan, so Local AI Hub built a timing-aware deterministic fallback with ' + planItemCount + ' item' + (planItemCount === 1 ? '' : 's') + '.'
    : plannerDiagnostics.plannerMode === 'chunked'
      ? providerLabel + ' returned a chunked structured ' + (schema?.label || 'plan').toLowerCase() + ' with ' + planItemCount + ' item' + (planItemCount === 1 ? '' : 's') + ' across ' + Number(plannerDiagnostics.chunksPlanned || 0) + ' chunk(s).'
      : providerLabel + ' returned a structured ' + (schema?.label || 'plan').toLowerCase() + ' with ' + planItemCount + ' item' + (planItemCount === 1 ? '' : 's') + '.';

  return {
    message: plannerResultMessage,
    outputs: {
      plan: planArtifact,
    },
    preview: summarizeArtifact(planArtifact),
  };
}

function resolveNodePromptStyle(contextMaps = {}, node = {}, targetKind = '') {
  const promptStyleId = String(node?.config?.promptStyleId || '').trim();
  if (!promptStyleId || !targetKind) {
    return null;
  }
  const style = contextMaps.promptStylesById?.[promptStyleId] || null;
  return style && isPromptStyleCompatibleWithTarget(style, targetKind) ? style : null;
}

function applyNodePromptStyle(contextMaps = {}, node = {}, prompt = '', targetKind = '', options = {}) {
  const originalNegativePrompt = String(options.negativePrompt || '').trim();
  const style = resolveNodePromptStyle(contextMaps, node, targetKind);
  if (!style) {
    return {
      prompt: String(prompt || '').trim(),
      negativePrompt: originalNegativePrompt,
      promptStyle: null,
    };
  }

  const application = applyPromptStyleToPrompt(prompt, style, {
    negativePrompt: originalNegativePrompt,
    supportNegativePrompt: Boolean(options.supportNegativePrompt),
    targetKind,
  });
  return {
    prompt: application.finalPrompt,
    negativePrompt: application.finalNegativePrompt,
    promptStyle: serializePromptStyleApplication(application),
  };
}

function buildImageGenerationMetadata(node, executionTarget, promptRequest = {}, options = {}) {
  const operation = String(options.operation || options.operationSubtype || 'textToImage').trim() || 'textToImage';
  return {
    backend: String(options.backend || executionTarget?.id || '').trim(),
    backendLabel: String(options.backendLabel || executionTarget?.name || '').trim(),
    cfgScale: node.config?.cfgScale,
    collectionMap: options.collectionMap && typeof options.collectionMap === 'object' ? serializeArtifactForUi(options.collectionMap) : null,
    extension: String(options.extension || '').trim(),
    height: Number(options.height || node.config?.height || 0) || 0,
    mimeType: String(options.mimeType || '').trim(),
    model: String(options.model || node.config?.model || '').trim(),
    negativePrompt: promptRequest.negativePrompt,
    operation,
    operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
    operationSubtype: operation,
    prompt: promptRequest.prompt,
    promptStyle: promptRequest.promptStyle,
    provider: String(options.provider || options.backend || executionTarget?.id || '').trim(),
    quality: node.config?.imageQuality,
    requestSettings: options.requestSettings && typeof options.requestSettings === 'object' ? serializeArtifactForUi(options.requestSettings) : null,
    revisedPrompt: String(options.revisedPrompt || '').trim(),
    safetyNotes: Array.isArray(options.safetyNotes) ? options.safetyNotes.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    seed: node.config?.seed,
    size: node.config?.imageSize,
    sourceImage: buildImageArtifactReference(options.sourceImageArtifact || options.sourceImage),
    sourceText: String(options.sourceText || promptRequest.sourceText || '').trim(),
    steps: node.config?.steps,
    toolId: String(executionTarget?.id || '').trim(),
    toolLabel: String(executionTarget?.name || '').trim(),
    width: Number(options.width || node.config?.width || 0) || 0,
  };
}

function buildImageGenerationPrompt(node, inputArtifact) {
  if (!inputArtifact) {
    throw new Error('This image generation step did not receive any input.');
  }

  if (inputArtifact.kind !== PORT_KIND_TEXT) {
    throw new Error('This image generation step currently needs text input.');
  }

  const promptText = String(inputArtifact.text || '').trim();
  if (!promptText) {
    throw new Error('This image generation step did not receive any text prompt.');
  }

  const promptPrefix = String(node.config?.instruction || '').trim();
  return promptPrefix ? promptPrefix + '\n\nPrompt:\n' + promptText : promptText;
}

async function buildCloudImageGenerationRequest(node, inputArtifact, contextMaps = {}) {
  if (!inputArtifact) {
    throw new Error('This cloud image generation step did not receive any input.');
  }

  if (inputArtifact.kind === PORT_KIND_TEXT) {
    const basePrompt = buildImageGenerationPrompt(node, inputArtifact);
    const promptRequest = applyNodePromptStyle(contextMaps, node, basePrompt, 'image');
    promptRequest.sourceText = String(inputArtifact.text || '').trim();
    return {
      imageReference: null,
      operation: 'textToImage',
      prompt: promptRequest.prompt,
      promptRequest,
      sourceImageArtifact: null,
      sourceText: promptRequest.sourceText,
    };
  }

  if (inputArtifact.kind !== PORT_KIND_IMAGE) {
    throw new Error('Cloud image generation can use either text input or an image input plus an edit instruction.');
  }

  const instruction = String(node.config?.instruction || '').trim();
  if (!instruction) {
    throw new Error('Add an image edit instruction before running cloud image-to-image generation.');
  }

  const imagePart = await buildImageMessageContentPart(inputArtifact);
  const promptRequest = applyNodePromptStyle(contextMaps, node, instruction, 'image');
  return {
    imageReference: {
      base64Data: imagePart.data,
      buffer: Buffer.from(imagePart.data, 'base64'),
      fileName: imagePart.fileName,
      mimeType: imagePart.mimeType,
    },
    operation: 'imageToImage',
    prompt: promptRequest.prompt,
    promptRequest,
    sourceImageArtifact: inputArtifact,
    sourceText: '',
  };
}

function buildCollectionMapImageItemMetadata({ imageRequest, inputArtifact, itemCount, itemIndex, mapping, node, sourceEntry }) {
  return {
    inputKind: String(mapping?.inputKind || inputArtifact?.kind || '').trim(),
    itemCount,
    itemId: String(sourceEntry?.itemId || inputArtifact?.id || '').trim(),
    itemIndex,
    mappingId: String(mapping?.id || node?.config?.mappingId || '').trim(),
    nodeId: String(node?.id || '').trim(),
    nodeLabel: String(node?.label || '').trim(),
    operation: String(imageRequest?.operation || '').trim(),
    operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
    outputKind: String(mapping?.outputKind || PORT_KIND_IMAGE).trim(),
    sourceItemId: String(sourceEntry?.itemId || inputArtifact?.id || '').trim(),
    sourceItemIndex: itemIndex,
    sourceText: String(imageRequest?.sourceText || '').trim(),
  };
}

async function generateMappedImageArtifact(node, inputArtifact, options = {}) {
  const contextMaps = options.contextMaps || {};
  const run = options.run || null;
  const reportProgress = options.reportProgress;
  const itemIndex = Number(options.itemIndex || 0) || 0;
  const itemCount = Number(options.itemCount || 0) || 0;
  const itemLabel = 'item ' + String(itemIndex + 1) + (itemCount ? ' of ' + itemCount : '');
  const executionMode = node.config?.executionMode === 'localTool'
    ? 'localTool'
    : node.config?.executionMode === 'graphWorkflow'
      ? 'graphWorkflow'
      : 'cloud';
  const mapping = options.mapping || getCollectionMapMapping(node) || null;

  if (executionMode !== 'cloud' && inputArtifact?.kind !== PORT_KIND_TEXT) {
    throw new Error('Local and graph image generation collection maps currently need text items. Choose Cloud image to image for image items.');
  }

  if (executionMode === 'graphWorkflow') {
    const basePrompt = buildImageGenerationPrompt(node, inputArtifact);
    const promptRequest = applyNodePromptStyle(contextMaps, node, basePrompt, 'image');
    const prompt = promptRequest.prompt;
    const support = getGraphWorkflowOperationBackendSupport(node, GRAPH_WORKFLOW_OPERATION_BACKEND_IDS.TEXT_TO_IMAGE, contextMaps);
    if (!support.usable) {
      throw new Error(support.message || 'Configure a compatible text-to-image graph workflow before using it for collection mapping.');
    }

    const tool = options.graphWorkflowTool || await getGraphWorkflowBackendToolOrThrow(contextMaps, node, 'collection image mapping');
    const graphNode = buildGraphWorkflowOperationBackendNode(resolveGraphWorkflowPresetNode(node, contextMaps).node, {
      label: node.label + ' ' + itemLabel,
    });
    reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' through the configured graph workflow.', 'Running ' + node.label + '...');
    const result = await executeGraphWorkflowNode({
      inputArtifacts: {
        text: createTextArtifact(prompt, {
          displayName: node.label + ' ' + itemLabel,
          role: 'generated',
        }),
      },
      node: graphNode,
      reportProgress,
      runDirectories: run.directories,
      tool,
    });
    const imageArtifact = result?.outputs?.image || null;
    if (!imageArtifact || imageArtifact.kind !== PORT_KIND_IMAGE) {
      throw new Error((tool.name || 'The graph workflow tool') + ' finished the graph workflow, but it did not return an image artifact.');
    }
    imageArtifact.imageGeneration = buildImageGenerationMetadata(node, tool, promptRequest, { backend: 'graphWorkflow', backendLabel: tool.name, operation: 'textToImage', sourceText: String(inputArtifact?.text || '').trim() });

    return imageArtifact;
  }

  if (executionMode === 'localTool') {
    const basePrompt = buildImageGenerationPrompt(node, inputArtifact);
    const promptRequest = applyNodePromptStyle(contextMaps, node, basePrompt, 'image', {
      negativePrompt: node.config?.negativePrompt,
      supportNegativePrompt: true,
    });
    const tool = options.localTool || await getSelectedImageToolOrThrow(contextMaps, node, 'collection image mapping');
    reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for image generation.', 'Running ' + node.label + '...');
    const generated = await generateImageWithWorkflowTool(tool, {
      cfgScale: node.config?.cfgScale,
      height: node.config?.height,
      model: String(node.config?.model || '').trim(),
      negativePrompt: promptRequest.negativePrompt,
      prompt: promptRequest.prompt,
      seed: node.config?.seed,
      steps: node.config?.steps,
      width: node.config?.width,
    });
    return saveBase64Artifact(run.directories, generated.base64Image, {
      baseName: node.label + '-item-' + String(itemIndex + 1).padStart(3, '0') + '-' + Date.now(),
      displayName: node.label + ' item ' + String(itemIndex + 1),
      extension: '.png',
      kind: PORT_KIND_IMAGE,
      role: 'generated',
      imageGeneration: buildImageGenerationMetadata(node, tool, promptRequest, { model: String(node.config?.model || '').trim(), operation: 'textToImage', sourceText: String(inputArtifact?.text || '').trim() }),
    });
  }

  const providerId = String(node.config?.providerId || '').trim();
  if (!providerId) {
    throw new Error('Choose a connected cloud provider before running this collection map.');
  }
  const model = String(node.config?.model || '').trim();
  if (doesProviderOperationRequireExplicitModel(providerId, PIPELINE_OPERATION_IDS.IMAGE_GENERATE) && !model) {
    throw new Error('Choose or enter an image model before running this collection map.');
  }
  const provider = contextMaps.providersById[providerId] || null;
  if (!provider?.isConnected) {
    throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
  }

  const imageRequest = await buildCloudImageGenerationRequest(node, inputArtifact, contextMaps);
  const requestSettings = {
    background: node.config?.imageBackground,
    imageReference: imageRequest.imageReference ? { fileName: imageRequest.imageReference.fileName, mimeType: imageRequest.imageReference.mimeType } : null,
    quality: node.config?.imageQuality,
    size: node.config?.imageSize,
  };
  reportProgress?.('Sending ' + itemLabel + ' to ' + provider.name + (imageRequest.operation === 'imageToImage' ? ' for cloud image editing.' : ' for cloud image generation.'), 'Running ' + node.label + '...');
  const result = await runProviderOperation(providerId, {
    background: node.config?.imageBackground,
    imageReference: imageRequest.imageReference,
    model,
    operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
    operationSubtype: imageRequest.operation,
    prompt: imageRequest.prompt,
    providerId,
    quality: node.config?.imageQuality,
    size: node.config?.imageSize,
  });
  const generatedImage = result?.images?.[0] || null;
  const base64Image = String(generatedImage?.base64Data || '').trim();
  if (!base64Image) {
    throw new Error((provider.name || 'The selected provider') + ' finished the request, but it did not return an image.');
  }

  return saveBase64Artifact(run.directories, base64Image, {
    baseName: node.label + '-item-' + String(itemIndex + 1).padStart(3, '0') + '-' + Date.now(),
    displayName: node.label + ' item ' + String(itemIndex + 1),
    extension: String(generatedImage.extension || '.png').trim() || '.png',
    kind: PORT_KIND_IMAGE,
    role: 'generated',
    imageGeneration: buildImageGenerationMetadata(node, provider, imageRequest.promptRequest, {
      backend: providerId,
      backendLabel: provider.name,
      collectionMap: buildCollectionMapImageItemMetadata({ imageRequest, inputArtifact, itemCount, itemIndex, mapping, node, sourceEntry: options.sourceEntry }),
      extension: String(generatedImage.extension || '.png').trim() || '.png',
      height: generatedImage.height,
      mimeType: generatedImage.mimeType,
      model,
      operation: imageRequest.operation,
      provider: providerId,
      requestSettings,
      revisedPrompt: generatedImage.revisedPrompt,
      safetyNotes: generatedImage.safetyNotes,
      sourceImageArtifact: imageRequest.sourceImageArtifact,
      sourceText: imageRequest.sourceText,
      width: generatedImage.width,
    }),
  });
}

function getCollectionMapExecutionModeForRun(node) {
  if (node?.config?.executionMode === 'localTool') {
    return 'localTool';
  }
  if (node?.config?.executionMode === 'graphWorkflow') {
    return 'graphWorkflow';
  }
  return 'cloud';
}


const COLLECTION_MAP_TEXT_TO_IMAGE_DEFAULT_INSTRUCTION = 'Generate one image for each text item while preserving the source order.';

function getCollectionMapEffectiveInstruction(node, operationId) {
  const instruction = String(node?.config?.instruction || '').trim();
  if (instruction === COLLECTION_MAP_TEXT_TO_IMAGE_DEFAULT_INSTRUCTION && (operationId !== PIPELINE_OPERATION_IDS.IMAGE_GENERATE || getCollectionMapInputKind(node) !== PORT_KIND_TEXT)) {
    return '';
  }
  return instruction;
}

function buildCollectionMapOperationNode(node, operationId) {
  return {
    ...node,
    config: {
      ...(node?.config || {}),
      instruction: getCollectionMapEffectiveInstruction(node, operationId),
    },
  };
}

function getCollectionMapAudiocraftItemMode(node) {
  return String(node?.config?.audiocraftItemMode || '').trim() === 'sequentialContinuation'
    ? 'sequentialContinuation'
    : 'independent';
}

function isCollectionMapAudioContinuationChainEnabledForRun(node, mapping, executionMode) {
  const toolId = String(node?.config?.toolId || '').trim().toLowerCase();
  return executionMode === 'localTool'
    && getCollectionMapAudiocraftItemMode(node) === 'sequentialContinuation'
    && String(mapping?.id || node?.config?.mappingId || '').trim() === 'textToAudio'
    && String(mapping?.inputKind || '').trim() === PORT_KIND_TEXT
    && String(mapping?.outputKind || '').trim() === PORT_KIND_AUDIO
    && String(mapping?.operationId || getCollectionMapOperationId(node)).trim() === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
    && (!toolId || toolId === 'audiocraft-webui');
}

function isCollectionMapChatterboxReferenceVoiceTtsForRun(node, mapping, executionMode) {
  const toolId = String(node?.config?.toolId || '').trim().toLowerCase();
  const requestedAudioMode = String(node?.config?.audioMode || '').trim().toLowerCase();
  const audioMode = requestedAudioMode === 'referencevoicetts' || requestedAudioMode === 'reference-voice-tts' ? 'referenceVoiceTts' : requestedAudioMode;
  return executionMode === 'localTool'
    && String(mapping?.id || node?.config?.mappingId || '').trim() === 'textToAudio'
    && String(mapping?.inputKind || '').trim() === PORT_KIND_TEXT
    && String(mapping?.outputKind || '').trim() === PORT_KIND_AUDIO
    && String(mapping?.operationId || getCollectionMapOperationId(node)).trim() === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
    && (toolId === 'chatterbox-tts' || (!toolId && audioMode === 'referenceVoiceTts'));
}

function buildCollectionMapAudioContinuationChainState(node) {
  const seedSeconds = Math.max(0.25, Number(node?.config?.continuationSeedSeconds || 12) || 12);
  const segmentDurationSeconds = Math.max(1, Number(node?.config?.durationSeconds || 8) || 8);
  return {
    currentCumulativeAudioPath: '',
    enabled: true,
    finalCombinedAudioPath: '',
    finalCombinedDurationSeconds: 0,
    firstItemBehavior: 'scratch',
    itemMode: 'sequentialContinuation',
    items: [],
    lastAcceptedArtifact: null,
    outputMode: 'segments',
    seedSeconds,
    segmentDurationSeconds,
  };
}

function buildAudioArtifactReference(artifact) {
  if (!artifact) {
    return null;
  }

  return {
    displayName: String(artifact.displayName || '').trim(),
    fileName: String(artifact.fileName || '').trim(),
    filePath: String(artifact.filePath || '').trim(),
    id: String(artifact.id || artifact.artifactId || '').trim(),
    kind: String(artifact.kind || '').trim(),
    summary: summarizeArtifact(artifact),
  };
}

function buildCollectionMapAudioItemMetadata({ audioRequest, executionMode, inputArtifact, itemCount, itemId, itemIndex, mapping, node, referenceAudioArtifact, tool }) {
  const toolId = String(tool?.id || node?.config?.toolId || '').trim().toLowerCase();
  const isChatterbox = toolId === 'chatterbox-tts' || String(audioRequest?.audioMode || '').trim() === 'referenceVoiceTts';
  const audioMode = isChatterbox ? 'referenceVoiceTts' : String(audioRequest?.audioMode || node?.config?.audioMode || 'music').trim() || 'music';
  const sourceText = String(inputArtifact?.text || '').trim();
  const collectionMap = {
    backend: isChatterbox ? 'chatterbox-tts' : 'audiocraft',
    backendLabel: isChatterbox ? 'Chatterbox-Turbo' : 'AudioCraft',
    executionMode: String(executionMode || '').trim(),
    finalPrompt: String(audioRequest?.prompt || '').trim(),
    inputKind: String(mapping?.inputKind || '').trim(),
    itemCount,
    itemIndex,
    mapping: String(mapping?.id || node?.config?.mappingId || '').trim(),
    mappingId: String(mapping?.id || node?.config?.mappingId || '').trim(),
    mode: audioMode,
    nodeId: String(node?.id || '').trim(),
    nodeLabel: String(node?.label || '').trim(),
    operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
    operationSubtype: audioMode,
    outputKind: String(mapping?.outputKind || '').trim(),
    sourceItemId: String(itemId || '').trim(),
    sourceItemIndex: itemIndex,
    sourceTextPreview: trimPreviewText(sourceText, 160),
    tool: isChatterbox ? 'Chatterbox-Turbo' : (tool?.name || 'AudioCraft'),
    toolId,
    toolLabel: String(tool?.name || (isChatterbox ? 'Chatterbox-Turbo' : 'AudioCraft')).trim(),
  };
  if (isChatterbox) {
    collectionMap.referenceAudio = buildAudioArtifactReference(referenceAudioArtifact || audioRequest?.referenceAudioArtifact);
    collectionMap.referenceAudioPath = String(audioRequest?.referenceAudioPath || referenceAudioArtifact?.filePath || '').trim();
  }
  return {
    collectionMap,
    collectionMapItemMode: 'independent',
  };
}

async function persistAudioGenerationMetadataSidecar(artifact) {
  if (!artifact?.filePath || artifact.kind !== PORT_KIND_AUDIO || typeof saveAudioArtifactMetadata !== 'function') {
    return artifact;
  }

  const metadataPaths = await saveAudioArtifactMetadata(artifact.filePath, artifact);
  if (metadataPaths.length) {
    artifact.metadataPaths = [...new Set([...(Array.isArray(artifact.metadataPaths) ? artifact.metadataPaths : []), ...metadataPaths])];
  }
  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

function getAudioDurationSeconds(artifact, fallback = 0) {
  const candidates = [
    artifact?.audio?.durationSeconds,
    artifact?.audioGeneration?.generatedDurationSeconds,
    artifact?.audioGeneration?.finalOutputDurationSeconds,
    artifact?.audioGeneration?.durationSeconds,
    fallback,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) {
      return Math.round(value * 100) / 100;
    }
  }
  return 0;
}

function serializeCollectionMapAudioContinuationChainState(chainState, patch = {}) {
  if (!chainState?.enabled) {
    return null;
  }

  return {
    enabled: true,
    finalCombinedAudioPath: String(chainState.finalCombinedAudioPath || '').trim(),
    finalCombinedDurationSeconds: Number(chainState.finalCombinedDurationSeconds || 0) || 0,
    firstItemBehavior: chainState.firstItemBehavior || 'scratch',
    itemMode: 'sequentialContinuation',
    items: Array.isArray(chainState.items) ? serializeArtifactForUi(chainState.items) : [],
    outputMode: chainState.outputMode || 'segments',
    seedSeconds: Number(chainState.seedSeconds || 0) || 0,
    segmentDurationSeconds: Number(chainState.segmentDurationSeconds || 0) || 0,
    ...patch,
  };
}

function getCollectionMapVideoItemModeForRun(node) {
  return String(node?.config?.videoItemMode || '').trim() === 'sequentialLastFrame'
    ? 'sequentialLastFrame'
    : 'independent';
}

function getCollectionMapVideoFirstItemBehaviorForRun(node) {
  return String(node?.config?.videoChainFirstItemBehavior || '').trim() === 'initialReferenceImage'
    ? 'initialReferenceImage'
    : 'textToVideo';
}

function isCollectionMapVideoContinuationChainEnabledForRun(node, mapping, executionMode) {
  const toolId = String(node?.config?.toolId || '').trim().toLowerCase();
  const inputKind = String(mapping?.inputKind || '').trim();
  const isVideoMap = getCollectionMapVideoItemModeForRun(node) === 'sequentialLastFrame'
    && (inputKind === PORT_KIND_TEXT || inputKind === PORT_KIND_IMAGE);
  if (!isVideoMap || String(mapping?.outputKind || '').trim() !== PORT_KIND_VIDEO) {
    return false;
  }

  if (String(mapping?.operationId || getCollectionMapOperationId(node)).trim() !== PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
    return false;
  }

  if (executionMode === 'cloud') {
    return true;
  }

  return executionMode === 'localTool'
    && String(mapping?.id || node?.config?.mappingId || '').trim() === 'textToVideo'
    && String(mapping?.inputKind || '').trim() === PORT_KIND_TEXT
    && String(mapping?.operationId || getCollectionMapOperationId(node)).trim() === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
    && (!toolId || toolId === 'wan21-webui');
}

function getProviderVideoOperationForConfiguredModel(providerId, model) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  const normalizedModel = String(model || '').trim();
  if (!normalizedProviderId) {
    return null;
  }

  return normalizedModel
    ? getProviderModelCapabilities(normalizedProviderId, normalizedModel)?.operations?.[PIPELINE_OPERATION_IDS.VIDEO_GENERATE] || null
    : getProviderPipelineOperation(normalizedProviderId, PIPELINE_OPERATION_IDS.VIDEO_GENERATE);
}

function assertCollectionMapVideoContinuationChainSupportedForRun(node, mapping, executionMode) {
  if (!isCollectionMapVideoContinuationChainEnabledForRun(node, mapping, executionMode)) {
    return;
  }

  if (executionMode === 'localTool') {
    return;
  }

  if (executionMode !== 'cloud') {
    throw new Error('Previous-last-frame video chaining is only available for Wan local video maps, Google Veo cloud video maps, and xAI Grok Imagine cloud video maps.');
  }

  const providerId = String(node?.config?.providerId || '').trim().toLowerCase();
  if (!['google', 'xai'].includes(providerId)) {
    throw new Error('Collection video chaining is available for Google Veo and xAI Grok Imagine only. Choose a supported cloud video provider or turn chaining off.');
  }

  const operation = getProviderVideoOperationForConfiguredModel(providerId, node?.config?.model);
  if (!operation?.inputKinds?.includes(PORT_KIND_IMAGE)) {
    throw new Error('Previous-last-frame chaining needs a cloud video model that accepts image input. Choose a Google Veo or xAI Grok Imagine image-to-video model, or turn chaining off.');
  }
}

function getCollectionMapVideoProviderChainSupportStatus(node, executionMode) {
  if (String(executionMode || '').trim() !== 'cloud') {
    return 'not-applicable';
  }

  const providerId = String(node?.config?.providerId || '').trim().toLowerCase();
  if (!providerId) {
    return 'unknown';
  }
  if (!['google', 'xai'].includes(providerId)) {
    return 'unsupported';
  }

  const operation = getProviderVideoOperationForConfiguredModel(providerId, node?.config?.model);
  return operation?.inputKinds?.includes(PORT_KIND_IMAGE) ? 'supported' : 'unsupported';
}

function buildCollectionMapVideoContinuationChainState(node) {
  const firstItemBehavior = getCollectionMapVideoFirstItemBehaviorForRun(node);
  return {
    enabled: true,
    finalLastFramePath: '',
    firstItemBehavior,
    fps: Math.max(1, Number(node?.config?.videoFps || 15) || 15),
    initialReferenceImagePath: String(node?.config?.videoInitialReferenceImagePath || '').trim(),
    itemMode: 'sequentialLastFrame',
    items: [],
    lastAcceptedArtifact: null,
    previousLastFrameArtifact: null,
    size: String(node?.config?.videoSize || '1280x720').trim() || '1280x720',
  };
}

function buildVideoArtifactReference(artifact) {
  if (!artifact) {
    return null;
  }

  return {
    displayName: String(artifact.displayName || '').trim(),
    fileName: String(artifact.fileName || '').trim(),
    filePath: String(artifact.filePath || '').trim(),
    id: String(artifact.id || artifact.artifactId || '').trim(),
    kind: String(artifact.kind || '').trim(),
    operationSubtype: String(artifact.videoGeneration?.operationSubtype || artifact.videoGeneration?.mode || '').trim(),
    summary: summarizeArtifact(artifact),
  };
}

function buildImageArtifactReference(artifact) {
  if (!artifact) {
    return null;
  }

  return {
    displayName: String(artifact.displayName || '').trim(),
    fileName: String(artifact.fileName || '').trim(),
    filePath: String(artifact.filePath || '').trim(),
    height: Number(artifact.height || 0) || 0,
    id: String(artifact.id || artifact.artifactId || '').trim(),
    kind: String(artifact.kind || '').trim(),
    summary: summarizeArtifact(artifact),
    width: Number(artifact.width || 0) || 0,
  };
}

function serializeCollectionMapVideoContinuationChainState(chainState, patch = {}) {
  if (!chainState?.enabled) {
    return null;
  }

  return {
    enabled: true,
    finalLastFramePath: String(chainState.finalLastFramePath || '').trim(),
    firstItemBehavior: chainState.firstItemBehavior || 'textToVideo',
    fps: Number(chainState.fps || 0) || 0,
    initialReferenceImagePath: String(chainState.initialReferenceImagePath || '').trim(),
    itemMode: 'sequentialLastFrame',
    items: Array.isArray(chainState.items) ? serializeArtifactForUi(chainState.items) : [],
    size: String(chainState.size || '').trim(),
    ...patch,
  };
}

function buildCollectionMapVideoItemMetadata({ chainState, executionMode, inputArtifact, itemCount, itemId, itemIndex, mapping, node, referenceImageArtifact, referenceRole, videoRequest }) {
  const base = {
    executionMode: String(executionMode || '').trim(),
    finalPrompt: String(videoRequest?.prompt || '').trim(),
    inputKind: String(mapping?.inputKind || '').trim(),
    itemCount,
    itemIndex,
    mappingId: String(mapping?.id || node?.config?.mappingId || '').trim(),
    nodeId: String(node?.id || '').trim(),
    nodeLabel: String(node?.label || '').trim(),
    operationId: PIPELINE_OPERATION_IDS.VIDEO_GENERATE,
    originalPrompt: String(inputArtifact?.text || '').trim(),
    outputKind: String(mapping?.outputKind || '').trim(),
    promptStyle: videoRequest?.promptStyle || null,
    sourceItemId: String(itemId || '').trim(),
    sourceItemIndex: itemIndex,
  };
  if (inputArtifact?.kind === PORT_KIND_IMAGE) {
    base.sourceImage = buildImageArtifactReference(inputArtifact);
    base.sourceImageLineage = inputArtifact?.lineage ? serializeArtifactForUi(inputArtifact.lineage) : null;
  }

  if (!chainState?.enabled) {
    return {
      collectionMap: base,
      collectionMapItemMode: 'independent',
      collectionMapVideoChain: null,
    };
  }

  const referenceImage = buildImageArtifactReference(referenceImageArtifact);
  return {
    collectionMap: base,
    collectionMapItemMode: 'sequentialLastFrame',
    collectionMapVideoChain: {
      chainIndex: itemIndex,
      chainMode: 'previousLastFrameAsNextStartImage',
      chainSourceItemId: String(itemId || '').trim(),
      chainSourceItemIndex: itemIndex,
      enabled: true,
      firstItemBehavior: chainState.firstItemBehavior || 'textToVideo',
      itemMode: 'sequentialLastFrame',
      previousClip: buildVideoArtifactReference(chainState.lastAcceptedArtifact),
      previousVideoArtifactId: String(chainState.lastAcceptedArtifact?.id || chainState.lastAcceptedArtifact?.artifactId || '').trim(),
      previousVideoArtifactPath: String(chainState.lastAcceptedArtifact?.filePath || '').trim(),
      previousLastFrame: referenceRole === 'previousLastFrame' ? referenceImage : null,
      previousLastFrameArtifactPath: referenceRole === 'previousLastFrame' ? String(referenceImageArtifact?.filePath || '').trim() : '',
      referenceImage,
      referenceRole: String(referenceRole || '').trim() || 'none',
    },
  };
}

async function persistVideoGenerationMetadataSidecar(artifact) {
  if (!artifact?.filePath || artifact.kind !== PORT_KIND_VIDEO || typeof saveVideoArtifactMetadata !== 'function') {
    return artifact;
  }

  const metadataPaths = await saveVideoArtifactMetadata(artifact.filePath, artifact);
  if (metadataPaths.length) {
    artifact.metadataPaths = [...new Set([...(Array.isArray(artifact.metadataPaths) ? artifact.metadataPaths : []), ...metadataPaths])];
  }
  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}
function buildCollectionMapMetadata(mapping, node, executionMode, options = {}) {
  const perItemValidation = getCollectionMapPerItemValidationConfig(node);
  const failureMode = getCollectionMapFailureMode(node);
  const audioContinuationChain = serializeCollectionMapAudioContinuationChainState(options.audioContinuationChain);
  const videoContinuationChain = serializeCollectionMapVideoContinuationChainState(options.videoContinuationChain);
  const sourceCollection = options.sourceCollection && typeof options.sourceCollection === 'object' ? {
    directoryPath: String(options.sourceCollection.directoryPath || '').trim(),
    displayName: String(options.sourceCollection.displayName || '').trim(),
    itemCount: Number(options.sourceCollection.itemCount || 0) || 0,
    itemKind: String(options.sourceCollection.itemKind || mapping?.inputKind || '').trim(),
    manifestPath: String(options.sourceCollection.manifestPath || '').trim(),
    metadata: options.sourceCollection.metadata && typeof options.sourceCollection.metadata === 'object' ? serializeArtifactForUi(options.sourceCollection.metadata) : null,
    summary: String(options.sourceCollection.summary || '').trim(),
  } : null;
  const orderedOutputItemRefs = Array.isArray(options.outputItems) ? options.outputItems.map((entry, index) => ({
    artifactId: String(entry?.artifact?.id || entry?.artifact?.artifactId || '').trim(),
    fileName: String(entry?.artifact?.fileName || '').trim(),
    filePath: String(entry?.artifact?.filePath || '').trim(),
    itemId: String(entry?.itemId || '').trim(),
    itemIndex: index,
    kind: String(entry?.artifact?.kind || '').trim(),
  })) : [];
  const selectedToolId = String(node?.config?.toolId || '').trim().toLowerCase();
  const isChatterbox = executionMode === 'localTool'
    && String(mapping?.operationId || getCollectionMapOperationId(node)).trim() === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
    && (selectedToolId === 'chatterbox-tts' || String(node?.config?.audioMode || '').trim().toLowerCase() === 'referencevoicetts');
  return {
    completionStatus: String(options.collectionStatus || '').trim() || '',
    executionMode: String(executionMode || '').trim(),
    inputKind: String(mapping?.inputKind || '').trim(),
    itemCount: Number(options.itemCount || orderedOutputItemRefs.length || 0) || 0,
    label: String(mapping?.label || node?.label || 'Map Collection').trim(),
    mapping: String(mapping?.id || node?.config?.mappingId || '').trim(),
    mappingId: String(mapping?.id || node?.config?.mappingId || '').trim(),
    model: String(node?.config?.model || '').trim(),
    nodeId: String(node?.id || '').trim(),
    nodeLabel: String(node?.label || '').trim(),
    operation: 'collectionMap',
    operationId: String(mapping?.operationId || getCollectionMapOperationId(node)).trim(),
    orderedOutputItemRefs,
    ordering: 'source-order',
    outputKind: String(mapping?.outputKind || getCollectionMapOutputKind(node)).trim(),
    sourceCollection,
    failureMode,
    partialSuccess: {
      enabled: failureMode === 'partial',
    },
    perItemValidation: perItemValidation.enabled ? {
      enabled: true,
      failMode: perItemValidation.failMode,
      maxAttempts: perItemValidation.maxAttempts,
      mode: perItemValidation.mode,
    } : { enabled: false },
    ...(audioContinuationChain ? { audioContinuationChain } : {}),
    ...(videoContinuationChain ? { videoContinuationChain } : {}),
    ...(isChatterbox ? {
      backend: 'chatterbox-tts',
      backendLabel: 'Chatterbox-Turbo',
      mode: 'referenceVoiceTts',
      operationSubtype: 'referenceVoiceTts',
      referenceAudio: buildAudioArtifactReference(options.referenceAudioArtifact),
      referenceAudioPath: String(options.referenceAudioArtifact?.filePath || '').trim(),
      tool: 'Chatterbox-Turbo',
    } : {}),
    toolId: String(node?.config?.toolId || '').trim(),
    providerId: String(node?.config?.providerId || '').trim(),
    videoChain: String(mapping?.operationId || getCollectionMapOperationId(node)).trim() === PIPELINE_OPERATION_IDS.VIDEO_GENERATE ? {
      chainMode: videoContinuationChain ? 'previousLastFrameAsNextStartImage' : '',
      enabled: Boolean(videoContinuationChain),
      itemMode: videoContinuationChain?.itemMode || getCollectionMapVideoItemModeForRun(node),
      providerChainingSupportStatus: getCollectionMapVideoProviderChainSupportStatus(node, executionMode),
    } : null,
  };
}
const COLLECTION_MAP_PER_ITEM_VALIDATION_MAX_ATTEMPTS = 8;

function getCollectionMapPerItemValidationConfig(node) {
  const raw = node?.config?.perItemValidation && typeof node.config.perItemValidation === 'object'
    ? node.config.perItemValidation
    : {};
  const maxAttempts = Math.max(1, Math.min(
    COLLECTION_MAP_PER_ITEM_VALIDATION_MAX_ATTEMPTS,
    Math.floor(Number(raw.maxAttempts || 1) || 1),
  ));
  return {
    enabled: Boolean(raw.enabled),
    failMode: 'fail-fast',
    llmExecutionMode: raw.llmExecutionMode === 'ollama' ? 'ollama' : 'cloud',
    maxAttempts,
    mode: raw.mode === 'user' ? 'user' : 'llm',
    model: String(raw.model || '').trim(),
    providerId: String(raw.providerId || '').trim(),
    retryInstruction: String(raw.retryInstruction || '').trim(),
    ruleset: String(raw.ruleset || '').trim(),
    systemPrompt: String(raw.systemPrompt || '').trim(),
  };
}

function getCollectionMapFailureMode(node) {
  const explicitMode = String(node?.config?.failureMode || '').trim();
  if (explicitMode === 'partial') {
    return 'partial';
  }

  const partialSuccess = node?.config?.partialSuccess && typeof node.config.partialSuccess === 'object'
    ? node.config.partialSuccess
    : null;
  return partialSuccess?.enabled ? 'partial' : 'fail-fast';
}

function isCollectionMapPartialOutputEnabled(node) {
  return getCollectionMapFailureMode(node) === 'partial';
}

function buildCollectionMapValidationNode(node, validationConfig) {
  return {
    id: node.id + ':perItemValidation',
    label: node.label + ' per-item validation',
    type: 'validation',
    config: {
      llmExecutionMode: validationConfig.llmExecutionMode,
      mode: 'llm',
      model: validationConfig.model,
      providerId: validationConfig.providerId,
      ruleset: validationConfig.ruleset,
      systemPrompt: validationConfig.systemPrompt,
    },
  };
}

function assertCollectionMapPerItemValidationSupported(node, outputKind, contextMaps) {
  const validationConfig = getCollectionMapPerItemValidationConfig(node);
  if (!validationConfig.enabled) {
    return validationConfig;
  }

  if (validationConfig.mode === 'user') {
    return validationConfig;
  }

  if (!validationConfig.ruleset) {
    throw new Error('Describe the pass and fail rules before enabling per-item validation for Map Collection.');
  }

  const validationNode = buildCollectionMapValidationNode(node, validationConfig);
  const profile = getValidationCapabilityProfile(validationNode);
  if (!profile.capability || !profile.inputKinds.includes(outputKind)) {
    const targetLabel = validationConfig.llmExecutionMode === 'ollama'
      ? 'Ollama'
      : (contextMaps.providersById[validationConfig.providerId]?.name || 'The selected validator');
    throw new Error(targetLabel + ' cannot validate ' + outputKind + ' items inside Map Collection yet. Choose a validator that supports this output kind or validate the collection after mapping.');
  }

  if (validationConfig.llmExecutionMode === 'ollama') {
    if (!validationConfig.model) {
      throw new Error('Choose or enter an Ollama model for per-item Map Collection validation.');
    }
    return validationConfig;
  }

  const providerId = validationConfig.providerId;
  if (!providerId) {
    throw new Error('Choose a connected cloud provider for per-item Map Collection validation.');
  }
  const provider = contextMaps.providersById[providerId] || null;
  if (!provider?.isConnected) {
    throw new Error('That per-item validation provider is not connected on this PC yet. Open Settings to save its API key first.');
  }
  if (doesProviderOperationRequireExplicitModel(providerId, PIPELINE_OPERATION_IDS.VALIDATION_LLM) && !validationConfig.model) {
    throw new Error('Choose or enter a model for per-item Map Collection validation.');
  }

  return validationConfig;
}

function buildCollectionMapAttemptNode(node, attemptNumber, validationConfig) {
  if (!validationConfig?.retryInstruction || attemptNumber <= 1) {
    return node;
  }

  const instruction = String(node?.config?.instruction || '').trim();
  return {
    ...node,
    config: {
      ...(node?.config || {}),
      instruction: [
        instruction,
        'Retry guidance for this mapped item attempt ' + attemptNumber + ':',
        validationConfig.retryInstruction,
      ].filter(Boolean).join('\n\n'),
    },
  };
}

function buildUserValidationResult(artifact, decision, reviewContext = {}) {
  const selectedBranch = decision?.decision === 'pass' ? 'pass' : 'fail';
  const reason = decision?.comment ? 'User note: ' + decision.comment : 'User selected ' + selectedBranch + '.';
  return {
    decision: selectedBranch,
    evidenceMode: String(reviewContext.evidenceMode || '').trim() || getUserValidationEvidenceMode(artifact, null),
    mode: 'user',
    reason,
    reviewContext: serializeArtifactForUi(reviewContext),
    summary: reason,
  };
}

function buildCollectionMapAttemptMetadata({ attemptNumber, artifact, mapping, node, sourceEntry, sourceIndex, validation, validationMode }) {
  return {
    attemptNumber,
    artifact: artifact ? {
      displayName: String(artifact.displayName || '').trim(),
      fileName: String(artifact.fileName || '').trim(),
      filePath: String(artifact.filePath || '').trim(),
      kind: String(artifact.kind || '').trim(),
      summary: summarizeArtifact(artifact),
    } : null,
    mappingId: String(mapping?.id || node?.config?.mappingId || '').trim(),
    operationId: String(mapping?.operationId || getCollectionMapOperationId(node)).trim(),
    sourceItemId: String(sourceEntry?.itemId || '').trim(),
    sourceItemIndex: sourceIndex,
    validation: validation ? {
      confidence: validation.confidence ?? null,
      decision: String(validation.decision || '').trim(),
      evidenceLimitations: String(validation.evidenceLimitations || '').trim(),
      evidenceMode: String(validation.evidenceMode || '').trim(),
      mode: validationMode || String(validation.mode || '').trim(),
      reason: String(validation.reason || validation.summary || '').trim(),
      summary: String(validation.summary || '').trim(),
    } : null,
    validationMode: validationMode || '',
    validationPassed: validation ? validation.decision === 'pass' : null,
  };
}
function getCollectionMapFailureMetadataFromError(error) {
  return error?.collectionMapItemFailure && typeof error.collectionMapItemFailure === 'object'
    ? serializeArtifactForUi(error.collectionMapItemFailure)
    : null;
}

function attachCollectionMapFailureMetadata(error, metadata = {}) {
  if (error && typeof error === 'object') {
    error.collectionMapItemFailure = serializeArtifactForUi(metadata);
  }
  return error;
}

function buildCollectionMapFailedItemMetadata({ error, failureKind, itemCount, itemId, itemIndex, mapping, node, sourceEntry }) {
  const embedded = getCollectionMapFailureMetadataFromError(error) || {};
  const sourceIndex = Number.isInteger(Number(embedded.sourceItemIndex)) ? Number(embedded.sourceItemIndex) : itemIndex;
  const sourceItemId = String(embedded.sourceItemId || itemId || sourceEntry?.itemId || '').trim();
  const attempts = Array.isArray(embedded.attempts) ? serializeArtifactForUi(embedded.attempts) : [];
  const message = String(error?.message || embedded.reason || 'The mapped operation failed.').trim();
  const reason = String(embedded.reason || message).trim();
  return {
    itemId: sourceItemId,
    itemIndex: sourceIndex,
    sourceItemId,
    sourceItemIndex: sourceIndex,
    itemCount: Number(itemCount || 0) || 0,
    failureKind: String(embedded.failureKind || failureKind || 'operation').trim() || 'operation',
    reason,
    message,
    attemptCount: Number(embedded.attemptCount || attempts.length || 1) || 1,
    attempts,
    validationMode: String(embedded.validationMode || '').trim(),
    validationFailure: Boolean(embedded.validationFailure),
    mappingId: String(mapping?.id || node?.config?.mappingId || '').trim(),
    operationId: String(mapping?.operationId || getCollectionMapOperationId(node)).trim(),
    inputKind: String(mapping?.inputKind || getCollectionMapInputKind(node)).trim(),
    outputKind: String(mapping?.outputKind || getCollectionMapOutputKind(node)).trim(),
  };
}

async function persistPartialCollectionMapArtifact({ audioContinuationChain, executionMode, failedItems, mappedItems, mapping, node, outputKind, referenceAudioArtifact, run, sourceCollection, sourceItems, videoContinuationChain }) {
  const collection = createArtifactCollection(mappedItems, {
    collectionMapping: {
      ...buildCollectionMapMetadata(mapping, node, executionMode, {
        audioContinuationChain,
        collectionStatus: 'partial',
        itemCount: sourceItems.length,
        outputItems: mappedItems,
        referenceAudioArtifact,
        sourceCollection,
        videoContinuationChain,
      }),
      partialReason: String(failedItems?.[0]?.reason || '').trim(),
    },
    collectionStatus: 'partial',
    displayName: node.label,
    failedItems,
    itemKind: outputKind,
    metadata: buildMappedCollectionRootMetadata(sourceCollection, mapping, node, outputKind),
    role: 'generated',
    sourceCollection: {
      directoryPath: String(sourceCollection?.directoryPath || '').trim(),
      displayName: String(sourceCollection?.displayName || '').trim(),
      itemCount: Number(sourceCollection?.itemCount || sourceItems.length) || sourceItems.length,
      itemKind: String(sourceCollection?.itemKind || mapping?.inputKind || '').trim(),
      manifestPath: String(sourceCollection?.manifestPath || '').trim(),
      metadata: sourceCollection?.metadata ? serializeArtifactForUi(sourceCollection.metadata) : null,
    },
    sourceItemCount: sourceItems.length,
  });
  collection.sourceCollection = {
    directoryPath: String(sourceCollection?.directoryPath || '').trim(),
    displayName: String(sourceCollection?.displayName || '').trim(),
    itemCount: Number(sourceCollection?.itemCount || sourceItems.length) || sourceItems.length,
    itemKind: String(sourceCollection?.itemKind || mapping?.inputKind || '').trim(),
    manifestPath: String(sourceCollection?.manifestPath || '').trim(),
  };
  return persistArtifactCollection(run.directories, collection, {
    baseName: node.label + '-partial',
    displayName: node.label + ' partial',
    role: 'generated',
    target: 'artifacts',
  });
}

async function executeMappedCollectionItemWithPerItemValidation(node, sourceArtifact, options = {}) {
  const validationConfig = options.validationConfig || getCollectionMapPerItemValidationConfig(node);
  const mapping = options.mapping || getCollectionMapMapping(node);
  const outputKind = options.outputKind || getCollectionMapOutputKind(node);
  if (!validationConfig.enabled) {
    const mappedArtifact = await executeMappedCollectionItemArtifact(node, sourceArtifact, options);
    return {
      artifact: mappedArtifact,
      attempts: [],
      validation: null,
    };
  }

  const validationNode = buildCollectionMapValidationNode(node, validationConfig);
  const attempts = [];
  const itemIndex = Number(options.itemIndex || 0) || 0;
  const itemCount = Number(options.itemCount || 0) || 0;
  const sourceEntry = options.sourceEntry || null;
  const itemId = String(sourceEntry?.itemId || '').trim();
  const itemLabel = 'item ' + String(itemIndex + 1) + (itemCount ? ' of ' + itemCount : '') + (itemId ? ' (' + itemId + ')' : '');

  for (let attemptNumber = 1; attemptNumber <= validationConfig.maxAttempts; attemptNumber += 1) {
    const attemptNode = buildCollectionMapAttemptNode(node, attemptNumber, validationConfig);
    let mappedArtifact = null;
    try {
      mappedArtifact = await executeMappedCollectionItemArtifact(attemptNode, sourceArtifact, options);
      if (!mappedArtifact || mappedArtifact.kind !== outputKind) {
        throw new Error('The mapped operation finished, but it did not return a ' + outputKind + ' artifact.');
      }
    } catch (error) {
      throw attachCollectionMapFailureMetadata(error, {
        attemptCount: attemptNumber,
        attempts,
        failureKind: 'operation',
        reason: String(error?.message || 'The mapped operation failed.').trim(),
        sourceItemId: itemId,
        sourceItemIndex: itemIndex,
      });
    }

    let review = null;
    if (validationConfig.mode === 'user') {
      const reviewContext = {
        artifactKind: String(mappedArtifact?.kind || '').trim(),
        evidenceMode: getUserValidationEvidenceMode(mappedArtifact, null),
        limitations: [],
        mapCollection: {
          attemptNumber,
          itemCount,
          itemId,
          itemIndex,
          maxAttempts: validationConfig.maxAttempts,
          nodeId: node.id,
          nodeLabel: node.label,
        },
      };
      const decision = await waitForUserValidation(options.run, node, mappedArtifact, {
        attemptNumber,
        itemCount,
        itemId,
        itemIndex,
        maxAttempts: validationConfig.maxAttempts,
        message: 'Paused at ' + node.label + ' for ' + itemLabel + ' attempt ' + attemptNumber + ' of ' + validationConfig.maxAttempts + '. Local AI Hub is waiting for your decision.',
        nodeMessage: 'Waiting for your pass or fail decision for ' + itemLabel + ' attempt ' + attemptNumber + ' of ' + validationConfig.maxAttempts + '.',
        pendingContext: {
          collectionMap: {
            attemptNumber,
            itemCount,
            itemId,
            itemIndex,
            maxAttempts: validationConfig.maxAttempts,
          },
        },
        reviewContext,
      });
      const validation = buildUserValidationResult(mappedArtifact, decision, reviewContext);
      review = {
        selectedBranch: validation.decision === 'pass' ? 'pass' : 'fail',
        validation,
      };
    } else {
      review = await executeLlmValidationReview(validationNode, mappedArtifact, options.contextMaps || {}, options.reportProgress, {
        progressMessage: 'Validating ' + itemLabel + ' attempt ' + attemptNumber + ' of ' + validationConfig.maxAttempts + '.',
        progressTitle: 'Running ' + node.label + ' per-item validation...',
      });
    }
    attempts.push(buildCollectionMapAttemptMetadata({
      attemptNumber,
      artifact: mappedArtifact,
      mapping,
      node,
      sourceEntry,
      sourceIndex: itemIndex,
      validation: review.validation,
      validationMode: validationConfig.mode,
    }));

    if (review.selectedBranch === 'pass') {
      return {
        artifact: mappedArtifact,
        attempts,
        validation: review.validation,
      };
    }

    if (attemptNumber < validationConfig.maxAttempts) {
      const failureReason = review.validation.reason || (validationConfig.mode === 'user' ? 'User selected fail.' : 'The validator selected fail.');
      options.reportProgress?.('Retrying ' + itemLabel + ' after validation failed: ' + failureReason, 'Running ' + node.label + '...');
      continue;
    }

    const reason = review.validation.reason || review.validation.summary || (validationConfig.mode === 'user' ? 'User selected fail.' : 'The validator selected fail.');
    const manualLabel = validationConfig.mode === 'user' ? 'manual ' : '';
    const error = new Error('Map Collection item ' + String(itemIndex + 1) + ' of ' + itemCount + (itemId ? ' (' + itemId + ')' : '') + ' failed ' + manualLabel + 'validation after ' + validationConfig.maxAttempts + ' attempt' + (validationConfig.maxAttempts === 1 ? '' : 's') + ': ' + reason);
    throw attachCollectionMapFailureMetadata(error, {
      attemptCount: validationConfig.maxAttempts,
      attempts,
      failureKind: 'validation',
      reason,
      sourceItemId: itemId,
      sourceItemIndex: itemIndex,
      validationFailure: true,
      validationMode: validationConfig.mode,
    });
  }

  throw new Error('Map Collection could not finish validating ' + itemLabel + '.');
}

async function generateMappedAudiocraftContinuationChainArtifact(node, inputArtifact, options = {}) {
  const contextMaps = options.contextMaps || {};
  const run = options.run || null;
  const reportProgress = options.reportProgress;
  const chainState = options.audioContinuationChain || null;
  const itemIndex = Number(options.itemIndex || 0) || 0;
  const itemCount = Number(options.itemCount || 0) || 0;
  if (!chainState?.enabled) {
    throw new Error('Local AI Hub could not prepare the AudioCraft continuation chain state for this mapped item.');
  }

  const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'collection AudioCraft continuation chaining');
  const operationNode = buildCollectionMapOperationNode({
    ...node,
    config: {
      ...(node.config || {}),
      audioMode: 'music',
    },
  }, PIPELINE_OPERATION_IDS.AUDIO_GENERATE);
  const audioRequest = await buildAudioGenerationRequest(operationNode, inputArtifact, contextMaps);
  const model = String(operationNode.config?.model || '').trim();
  const hasPreviousCumulative = Boolean(chainState.currentCumulativeAudioPath);
  const audioMode = hasPreviousCumulative ? 'continuation' : 'music';
  const itemLabel = 'item ' + String(itemIndex + 1) + (itemCount ? ' of ' + itemCount : '');
  const previousArtifactReference = buildAudioArtifactReference(chainState.lastAcceptedArtifact);
  const previousCumulativeAudioPath = String(chainState.currentCumulativeAudioPath || '').trim();

  reportProgress?.(
    hasPreviousCumulative
      ? 'Generating ' + itemLabel + ' as an AudioCraft continuation from the current cumulative track.'
      : 'Generating the first AudioCraft chain item from scratch.',
    'Running ' + node.label + ' as a sequential AudioCraft chain...',
  );

  const result = await generateAudioWithLocalAudioTool(tool, {
    appendSource: false,
    audioMode,
    audiocraftCfgCoef: audioRequest.audiocraftCfgCoef,
    audiocraftTemperature: audioRequest.audiocraftTemperature,
    audiocraftTopK: audioRequest.audiocraftTopK,
    audiocraftTopP: audioRequest.audiocraftTopP,
    audiocraftTwoStepCfg: audioRequest.audiocraftTwoStepCfg,
    continuationRepeatCount: 1,
    continuationSeedSeconds: chainState.seedSeconds,
    displayName: node.label + ' section ' + String(itemIndex + 1),
    durationSeconds: chainState.segmentDurationSeconds,
    model,
    nodeLabel: node.label + ' section ' + String(itemIndex + 1),
    operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
    prompt: audioRequest.prompt,
    promptStyle: audioRequest.promptStyle,
    reportProgress,
    runDirectories: run.directories,
    cancelSignal: activeRunAbortController?.signal || null,
    heavyStepCooldownSeconds: getActiveRunHeavyStepCooldownSeconds(),
    sourceAudioArtifact: chainState.lastAcceptedArtifact,
    sourceAudioPath: previousCumulativeAudioPath,
  });
  const segmentArtifact = result?.outputs?.audio || null;
  if (!segmentArtifact?.filePath || segmentArtifact.kind !== PORT_KIND_AUDIO) {
    throw new Error('AudioCraft finished this chain item, but it did not return a generated audio segment.');
  }

  let cumulativeAudioPath = segmentArtifact.filePath;
  let cumulativeDurationAfterItemSeconds = getAudioDurationSeconds(segmentArtifact, chainState.segmentDurationSeconds);
  let stitchMetadata = null;
  if (hasPreviousCumulative) {
    const stitched = await stitchAudioWithLocalAudioTool(tool, {
      nodeLabel: node.label + ' section ' + String(itemIndex + 1),
      reportProgress,
      runDirectories: run.directories,
      segmentAudioPath: segmentArtifact.filePath,
      sourceAudioPath: previousCumulativeAudioPath,
    });
    stitchMetadata = stitched?.metadata || null;
    cumulativeAudioPath = String(stitched?.outputPath || stitched?.destinationPath || '').trim();
    cumulativeDurationAfterItemSeconds = Number(stitchMetadata?.finalOutputDurationSeconds || 0) || cumulativeDurationAfterItemSeconds;
  }

  const segmentDurationSeconds = getAudioDurationSeconds(segmentArtifact, result?.metadata?.generatedDurationSeconds || chainState.segmentDurationSeconds);
  const chainMetadata = {
    cumulativeAudioPath,
    cumulativeDurationAfterItemSeconds,
    enabled: true,
    finalPrompt: audioRequest.prompt,
    firstItemBehavior: chainState.firstItemBehavior || 'scratch',
    itemCount,
    itemIndex,
    itemMode: 'sequentialContinuation',
    outputMode: chainState.outputMode || 'segments',
    previousArtifact: previousArtifactReference,
    previousCumulativeAudioPath,
    seedSeconds: hasPreviousCumulative ? Number(result?.metadata?.continuationSeedSeconds || chainState.seedSeconds || 0) || 0 : 0,
    segmentAudioPath: segmentArtifact.filePath,
    segmentDurationSeconds,
    sourcePrompt: String(inputArtifact?.text || '').trim(),
    stitch: stitchMetadata ? {
      outputPath: String(stitchMetadata.outputPath || '').trim(),
      segmentDurationSeconds: Number(stitchMetadata.segmentDurationSeconds || 0) || 0,
      sourceDurationSeconds: Number(stitchMetadata.sourceDurationSeconds || 0) || 0,
    } : null,
  };

  segmentArtifact.audioGeneration = {
    ...(segmentArtifact.audioGeneration || {}),
    collectionMapAudioChain: chainMetadata,
    collectionMapItemMode: 'sequentialContinuation',
  };
  return segmentArtifact;
}

async function buildInitialVideoChainReferenceArtifact(node, chainState) {
  const referencePath = path.resolve(String(chainState?.initialReferenceImagePath || '').trim());
  if (!referencePath || !(await fs.pathExists(referencePath))) {
    throw new Error('The initial reference image for this video chain could not be found. Choose the image again or start the first item as text-to-video.');
  }

  return buildFileArtifact(referencePath, {
    displayName: String(node?.label || 'Video chain') + ' initial reference image',
    kind: PORT_KIND_IMAGE,
    role: 'reference',
  });
}

async function resolveCollectionMapVideoReferenceArtifact(node, options = {}) {
  const chainState = options.videoContinuationChain || null;
  const itemIndex = Number(options.itemIndex || 0) || 0;
  if (!chainState?.enabled) {
    return { artifact: null, role: 'none' };
  }

  if (itemIndex === 0) {
    if (getCollectionMapInputKind(node) === PORT_KIND_IMAGE) {
      return { artifact: null, role: 'firstImageInput' };
    }

    if (chainState.firstItemBehavior === 'initialReferenceImage') {
      const artifact = await buildInitialVideoChainReferenceArtifact(node, chainState);
      return { artifact, role: 'initialReferenceImage' };
    }

    return { artifact: null, role: 'firstTextToVideo' };
  }

  if (!chainState.previousLastFrameArtifact?.filePath) {
    throw new Error('Local AI Hub could not continue the video chain because the previous accepted clip did not produce a last-frame reference image.');
  }

  return {
    artifact: chainState.previousLastFrameArtifact,
    role: 'previousLastFrame',
  };
}

async function generateMappedVideoArtifact(node, inputArtifact, options = {}) {
  const contextMaps = options.contextMaps || {};
  const run = options.run || null;
  const reportProgress = options.reportProgress;
  const itemIndex = Number(options.itemIndex || 0) || 0;
  const itemCount = Number(options.itemCount || 0) || 0;
  const itemId = String(options.sourceEntry?.itemId || '').trim();
  const itemLabel = 'item ' + String(itemIndex + 1) + (itemCount ? ' of ' + itemCount : '');
  const mapping = options.mapping || getCollectionMapMapping(node);
  const operationNode = buildCollectionMapOperationNode(node, PIPELINE_OPERATION_IDS.VIDEO_GENERATE);
  const executionMode = getCollectionMapExecutionModeForRun(operationNode);
  const reference = await resolveCollectionMapVideoReferenceArtifact(operationNode, options);
  const videoRequest = await buildVideoGenerationRequest(operationNode, inputArtifact, contextMaps, {
    referenceImageArtifact: reference.artifact,
  });
  const videoMapMetadata = buildCollectionMapVideoItemMetadata({
    chainState: options.videoContinuationChain || null,
    executionMode,
    inputArtifact,
    itemCount,
    itemId,
    itemIndex,
    mapping,
    node,
    referenceImageArtifact: reference.artifact,
    referenceRole: reference.role,
    videoRequest,
  });
  const model = String(operationNode.config?.model || '').trim();
  const fps = Math.max(1, Number(operationNode.config?.videoFps || 15) || 15);
  const quality = Math.max(1, Number(operationNode.config?.videoQuality || 5) || 5);

  if (executionMode === 'localTool') {
    const tool = await getSelectedLocalVideoToolOrThrow(contextMaps, operationNode, 'collection video generation');
    reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for local video generation.', 'Running ' + node.label + '...');
    const result = await generateVideoWithLocalVideoTool(tool, {
      collectionMap: videoMapMetadata.collectionMap,
      collectionMapItemMode: videoMapMetadata.collectionMapItemMode,
      collectionMapVideoChain: videoMapMetadata.collectionMapVideoChain,
      displayName: node.label + ' item ' + String(itemIndex + 1),
      fps,
      model,
      negativePrompt: videoRequest.negativePrompt,
      nodeLabel: node.label + ' item ' + String(itemIndex + 1),
      prompt: videoRequest.prompt,
      promptStyle: videoRequest.promptStyle,
      quality,
      referenceImagePath: videoRequest.referenceImagePath,
      reportProgress,
      runDirectories: run.directories,
      seed: operationNode.config?.seed,
      size: videoRequest.size,
      sourceImageArtifact: videoRequest.sourceImageArtifact,
      steps: operationNode.config?.steps,
    });
    return result?.outputs?.video || null;
  }

  const providerId = String(operationNode.config?.providerId || '').trim();
  if (!providerId) {
    throw new Error('Choose a connected cloud provider before running this video collection map.');
  }
  const providerVideoOperation = getProviderVideoOperationForConfiguredModel(providerId, model);
  if (!providerVideoOperation) {
    throw new Error('That cloud provider does not support collection video generation in Local AI Hub yet. Choose Google Veo or xAI Grok Imagine.');
  }
  if (doesProviderOperationRequireExplicitModel(providerId, PIPELINE_OPERATION_IDS.VIDEO_GENERATE) && !model) {
    throw new Error('Choose or enter a video model before running this collection map.');
  }
  const provider = contextMaps.providersById[providerId] || null;
  if (!provider?.isConnected) {
    throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
  }

  reportProgress?.('Sending ' + itemLabel + ' to ' + provider.name + ' for video generation.', 'Running ' + node.label + '...');
  const result = await runProviderOperation(providerId, {
    aspectRatio: operationNode.config?.videoAspectRatio,
    durationSeconds: operationNode.config?.durationSeconds,
    imageReference: videoRequest.referenceImage,
    model,
    onProgress: (message) => reportProgress?.(message, 'Running ' + node.label + '...'),
    operationId: PIPELINE_OPERATION_IDS.VIDEO_GENERATE,
    operationSubtype: videoRequest.referenceImage ? 'imageToVideo' : 'textToVideo',
    negativePrompt: providerId.toLowerCase() === 'google' ? videoRequest.negativePrompt : '',
    prompt: videoRequest.prompt,
    providerId,
    resolution: operationNode.config?.videoResolution,
    seconds: Math.max(1, Number(operationNode.config?.durationSeconds || 8) || 8),
    signal: activeRunAbortController?.signal || null,
    size: videoRequest.size,
  });
  const generatedVideo = result?.videos?.[0] || null;
  if (!generatedVideo?.buffer) {
    throw new Error(provider.name + ' finished the request, but it did not return a video file for this item.');
  }

  const artifact = await saveBufferArtifact(run.directories, generatedVideo.buffer, {
    baseName: node.label + '-item-' + String(itemIndex + 1).padStart(3, '0') + '-' + Date.now(),
    displayName: node.label + ' item ' + String(itemIndex + 1),
    extension: String(generatedVideo.extension || '.mp4').trim() || '.mp4',
    kind: PORT_KIND_VIDEO,
    role: 'generated',
    videoGeneration: {
      backend: providerId,
      backendLabel: provider.name,
      collectionMap: videoMapMetadata.collectionMap,
      collectionMapItemMode: videoMapMetadata.collectionMapItemMode,
      collectionMapVideoChain: videoMapMetadata.collectionMapVideoChain,
      mode: videoRequest.referenceImage ? 'image-to-video' : 'text-to-video',
      model: result?.model || model,
      negativePrompt: providerId.toLowerCase() === 'google' ? videoRequest.negativePrompt : '',
      operation: videoRequest.referenceImage ? 'imageToVideo' : 'textToVideo',
      operationId: PIPELINE_OPERATION_IDS.VIDEO_GENERATE,
      provider: providerId,
      providerOperationId: result?.providerOperationId || generatedVideo.id || '',
      providerRawStatusSummary: result?.providerRawStatusSummary || null,
      polling: result?.polling || null,
      requestSettings: result?.requestedSettings || null,
      returnedVideo: {
        extension: String(generatedVideo.extension || '.mp4').trim() || '.mp4',
        mimeType: String(generatedVideo.mimeType || '').trim(),
      },
      safetyNotes: Array.isArray(result?.safetyNotes) ? result.safetyNotes : [],
      operationSubtype: videoRequest.referenceImage ? 'imageToVideo' : 'textToVideo',
      prompt: videoRequest.prompt,
      promptStyle: videoRequest.promptStyle,
      size: videoRequest.size,
      sourceInputImage: videoRequest.sourceInputImageArtifact || null,
      sourceImage: videoRequest.sourceImageArtifact,
      usedReferenceImage: Boolean(videoRequest.referenceImage),
      video: {
        durationSeconds: Number(result?.durationSeconds || generatedVideo.durationSeconds || 0) || null,
        resolution: String(result?.requestedSettings?.resolution || operationNode.config?.videoResolution || '').trim(),
      },
    },
  });
  return persistVideoGenerationMetadataSidecar(artifact);
}
async function executeMappedCollectionItemArtifact(node, inputArtifact, options = {}) {
  const operationId = getCollectionMapOperationId(node);
  const outputKind = getCollectionMapOutputKind(node);
  const executionMode = getCollectionMapExecutionModeForRun(node);
  const contextMaps = options.contextMaps || {};
  const run = options.run || null;
  const reportProgress = options.reportProgress;
  const itemIndex = Number(options.itemIndex || 0) || 0;
  const itemCount = Number(options.itemCount || 0) || 0;
  const itemLabel = 'item ' + String(itemIndex + 1) + (itemCount ? ' of ' + itemCount : '');
  const operationNode = buildCollectionMapOperationNode(node, operationId);
  const model = String(operationNode.config?.model || '').trim();

  if (options.audioContinuationChain?.enabled && executionMode === 'localTool' && operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
    return generateMappedAudiocraftContinuationChainArtifact(node, inputArtifact, options);
  }

  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
    return generateMappedImageArtifact(operationNode, inputArtifact, { ...options, mapping: options.mapping || getCollectionMapMapping(node) });
  }

  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
    return generateMappedVideoArtifact(node, inputArtifact, options);
  }

  if (executionMode === 'graphWorkflow') {
    throw new Error('Configured graph workflow collection mapping is currently limited to text-to-image workflows.');
  }

  if (executionMode === 'localTool') {
    if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
      const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'collection audio generation');
      const referenceAudioArtifact = options.referenceAudioArtifact || null;
      const audioRequest = await buildAudioGenerationRequest(operationNode, inputArtifact, contextMaps, { referenceAudioArtifact });
      reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for local audio generation.', 'Running ' + node.label + '...');
      const result = await generateAudioWithLocalAudioTool(tool, {
        appendSource: audioRequest.appendSource,
        audioMode: audioRequest.audioMode,
        audiocraftCfgCoef: audioRequest.audiocraftCfgCoef,
        audiocraftTemperature: audioRequest.audiocraftTemperature,
        audiocraftTopK: audioRequest.audiocraftTopK,
        audiocraftTopP: audioRequest.audiocraftTopP,
        audiocraftTwoStepCfg: audioRequest.audiocraftTwoStepCfg,
        continuationRepeatCount: audioRequest.continuationRepeatCount,
        cancelSignal: activeRunAbortController?.signal || null,
        displayName: node.label + ' item ' + String(itemIndex + 1),
        heavyStepCooldownSeconds: getActiveRunHeavyStepCooldownSeconds(),
        continuationSeedSeconds: audioRequest.continuationSeedSeconds,
        durationSeconds: audioRequest.durationSeconds,
        model,
        nodeLabel: node.label,
        operationId,
        prompt: audioRequest.prompt,
        promptStyle: audioRequest.promptStyle,
        referenceAudioArtifact: audioRequest.referenceAudioArtifact,
        referenceAudioPath: audioRequest.referenceAudioPath,
        reportProgress,
        runDirectories: run.directories,
        sourceAudioArtifact: audioRequest.sourceAudioArtifact,
        sourceAudioPath: audioRequest.sourceAudioPath,
      });
      const audioArtifact = result?.outputs?.audio || null;
      if (audioArtifact?.audioGeneration) {
        const itemId = String(options.sourceEntry?.itemId || '').trim();
        audioArtifact.audioGeneration = {
          ...(audioArtifact.audioGeneration || {}),
          ...buildCollectionMapAudioItemMetadata({
            audioRequest,
            executionMode,
            inputArtifact,
            itemCount,
            itemId,
            itemIndex,
            mapping: options.mapping || getCollectionMapMapping(node),
            node,
            referenceAudioArtifact,
            tool,
          }),
        };
        await persistAudioGenerationMetadataSidecar(audioArtifact);
      }
      return audioArtifact;
    }

    if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) {
      const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'collection audio transcription');
      if (!inputArtifact?.filePath || inputArtifact.kind !== PORT_KIND_AUDIO) {
        throw new Error('This mapped transcription item did not receive an audio file.');
      }
      reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for transcription.', 'Running ' + node.label + '...');
      const result = await transcribeWithWhisper(tool, {
        audioPath: inputArtifact.filePath,
        model: model || DEFAULT_WHISPER_MODEL,
      });
      const transcript = String(result?.text || '').trim();
      if (!transcript) {
        throw new Error(tool.name + ' finished, but it did not return any transcript text for this item.');
      }
      return buildWhisperTranscriptArtifact({ ...node, label: node.label + ' item ' + String(itemIndex + 1) }, inputArtifact, result);
    }

    if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
      const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'collection audio transformation');
      const audioRequest = await buildAudioTransformRequest(operationNode, inputArtifact);
      if (!model) {
        throw new Error('Choose an RVC voice model before mapping this audio collection.');
      }
      const selectedVoiceModel = getDownloadedToolModelEntry(tool, model);
      if (Array.isArray(tool?.downloadedModels) && tool.downloadedModels.length && !selectedVoiceModel) {
        throw new Error(tool.name + ' does not have the selected RVC voice model available locally. Refresh the local model list or choose a model file from the weights folder before running this map.');
      }
      reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for local audio transformation.', 'Running ' + node.label + '...');
      const result = await generateAudioWithLocalAudioTool(tool, {
        displayName: node.label + ' item ' + String(itemIndex + 1),
        instruction: audioRequest.instruction,
        model,
        nodeLabel: node.label,
        operationId,
        reportProgress,
        runDirectories: run.directories,
        sourceAudioArtifact: audioRequest.sourceAudioArtifact,
        sourceAudioPath: audioRequest.sourceAudioPath,
        voiceModel: selectedVoiceModel,
      });
      return result?.outputs?.audio || null;
    }

    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
      if (!inputArtifact?.filePath || inputArtifact.kind !== PORT_KIND_IMAGE) {
        throw new Error('This mapped image analysis item did not receive an image file.');
      }
      const tool = await getSelectedImageToolOrThrow(contextMaps, node, 'collection image analysis');
      reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for image analysis.', 'Running ' + node.label + '...');
      const result = await interrogateImageWithWorkflowTool(tool, {
        analysisMode: operationNode.config?.analysisMode || model || 'clip',
        imagePath: inputArtifact.filePath,
      });
      const description = String(result?.text || '').trim();
      if (!description) {
        throw new Error((tool?.name || 'The selected image tool') + ' did not return an image description for this item.');
      }
      return createTextArtifact(description, {
        displayName: node.label + ' item ' + String(itemIndex + 1),
        imageAnalysis: {
          backend: tool?.id || '',
          backendLabel: tool?.name || 'Image analysis tool',
          mode: operationNode.config?.analysisMode || model || 'clip',
          operationId,
          sourceImage: summarizeArtifact(inputArtifact),
        },
        role: 'generated',
      });
    }

    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
      const tool = await getInstalledToolOrThrow(contextMaps, 'upscayl', 'Install Upscayl before using image-to-image Map Collection. FaceFusion collection mapping is deferred until a shared reference image can be configured.');
      const imageRequest = await buildImageTransformRequest(operationNode, inputArtifact, null, tool);
      reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for local image transformation.', 'Running ' + node.label + '...');
      const result = await generateImageWithLocalImageTool(tool, {
        displayName: node.label + ' item ' + String(itemIndex + 1),
        instruction: imageRequest.instruction,
        model,
        nodeLabel: node.label,
        operationId,
        referenceImageArtifact: null,
        referenceImagePath: '',
        cancelSignal: activeRunAbortController?.signal || null,
        reportProgress,
        runDirectories: run.directories,
        sourceImageArtifact: imageRequest.sourceImageArtifact,
        sourceImagePath: imageRequest.sourceImagePath,
        transformSubtype: imageRequest.transformSubtype,
      });
      return result?.outputs?.image || null;
    }

    throw new Error('Map Collection does not support that local operation yet.');
  }

  const providerId = String(node.config?.providerId || '').trim();
  if (!providerId) {
    throw new Error('Choose a connected cloud provider before running this collection map.');
  }
  if (doesProviderOperationRequireExplicitModel(providerId, operationId) && !model) {
    throw new Error('Choose or enter a model before running this collection map.');
  }
  const provider = contextMaps.providersById[providerId] || null;
  if (!provider?.isConnected) {
    throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
  }

  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
    const audioRequest = await buildCloudAudioGenerationRequest(operationNode, inputArtifact, contextMaps);
    reportProgress?.('Sending ' + itemLabel + ' to ' + provider.name + ' for speech generation.', 'Running ' + node.label + '...');
    const result = await runProviderOperation(providerId, {
      instruction: audioRequest.instruction,
      model,
      operationId,
      prompt: audioRequest.prompt,
      providerId,
      spokenText: audioRequest.spokenText,
      voice: audioRequest.voice,
    });
    const generatedAudio = result?.audios?.[0] || null;
    if (!generatedAudio?.buffer) {
      throw new Error(provider.name + ' finished the request, but it did not return an audio file for this item.');
    }
    return saveBufferArtifact(run.directories, generatedAudio.buffer, {
      audio: {
        bitDepth: generatedAudio.bitDepth,
        channelCount: generatedAudio.channelCount,
        sampleRate: generatedAudio.sampleRate,
      },
      audioGeneration: {
        backend: providerId,
        backendLabel: provider.name,
        mode: 'speech',
        model,
        operationId,
        operationSubtype: 'speech',
        prompt: audioRequest.prompt,
        promptStyle: audioRequest.promptStyle,
        spokenText: audioRequest.spokenText,
        voice: generatedAudio.voice || audioRequest.voice,
      },
      baseName: node.label + '-item-' + String(itemIndex + 1).padStart(3, '0') + '-' + Date.now(),
      displayName: node.label + ' item ' + String(itemIndex + 1),
      extension: String(generatedAudio.extension || '.wav').trim() || '.wav',
      kind: PORT_KIND_AUDIO,
      role: 'generated',
    });
  }

  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
    const messages = await buildLlmMessages(operationNode, inputArtifact);
    reportProgress?.('Sending ' + itemLabel + ' to ' + provider.name + ' for image analysis.', 'Running ' + node.label + '...');
    const result = await runProviderOperation(providerId, {
      messages,
      model,
      operationId,
      providerId,
    });
    const content = String(result?.message?.content || '').trim();
    if (!content) {
      throw new Error(provider.name + ' returned an empty image description for this item.');
    }
    return createTextArtifact(content, {
      displayName: node.label + ' item ' + String(itemIndex + 1),
      imageAnalysis: {
        backend: providerId,
        backendLabel: provider.name,
        mode: 'vision',
        model,
        operationId,
        sourceImage: summarizeArtifact(inputArtifact),
      },
      role: 'generated',
    });
  }

  throw new Error('Map Collection does not support that cloud operation yet.');
}

async function executeCollectionMapNode(node, graph, run, contextMaps, reportProgress) {
  const mapping = getCollectionMapMapping(node);
  if (!mapping) {
    throw new Error('Map Collection does not support that input/output operation pair yet. Choose a listed mapping or use an explicit Model Step for a single artifact.');
  }

  const executionMode = getCollectionMapExecutionModeForRun(node);
  const outputKind = getCollectionMapOutputKind(node);
  if (!mapping.modes.includes(executionMode)) {
    throw new Error(mapping.label + ' is not available through the selected execution mode. Choose a supported mode for this mapping.');
  }

  const sourceCollection = getNodeInputArtifact(node.id, 'collection', graph, run.resultsByNodeId, run);
  if (!isArtifactCollection(sourceCollection)) {
    throw new Error('This Map Collection step needs an ordered ' + getCollectionMapInputKind(node) + ' collection before it can run.');
  }
  if (String(sourceCollection.itemKind || '').trim() !== mapping.inputKind) {
    throw new Error('This Map Collection step maps ' + mapping.inputKind + ' collections to ' + mapping.outputKind + ' collections. Connect an ordered ' + mapping.inputKind + ' collection.');
  }

  const sourceItems = Array.isArray(sourceCollection.items) ? sourceCollection.items.filter((entry) => entry?.artifact) : [];
  if (!sourceItems.length) {
    throw new Error('This Map Collection step received an empty collection. Add at least one item before mapping.');
  }

  const graphWorkflowTool = executionMode === 'graphWorkflow'
    ? await getGraphWorkflowBackendToolOrThrow(contextMaps, node, 'collection mapping')
    : null;
  const localTool = executionMode === 'localTool' && mapping.operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
    ? await getSelectedImageToolOrThrow(contextMaps, node, 'collection image mapping')
    : null;
  const usesChatterboxReferenceVoice = isCollectionMapChatterboxReferenceVoiceTtsForRun(node, mapping, executionMode);
  const referenceAudioArtifact = usesChatterboxReferenceVoice
    ? getNodeInputArtifact(node.id, 'referenceAudio', graph, run.resultsByNodeId, run)
    : null;
  if (usesChatterboxReferenceVoice && (!referenceAudioArtifact || referenceAudioArtifact.kind !== PORT_KIND_AUDIO || !referenceAudioArtifact.filePath)) {
    throw new Error('Reference Voice TTS collection maps need one connected Reference Audio clip for the whole collection. Connect an Audio Input node to the Reference Audio input.');
  }
  const validationConfig = assertCollectionMapPerItemValidationSupported(node, outputKind, contextMaps);
  const partialOutputEnabled = isCollectionMapPartialOutputEnabled(node);
  const mappedItems = [];
  const failedItems = [];
  const audioContinuationChain = isCollectionMapAudioContinuationChainEnabledForRun(node, mapping, executionMode)
    ? buildCollectionMapAudioContinuationChainState(node)
    : null;
  const videoContinuationChain = isCollectionMapVideoContinuationChainEnabledForRun(node, mapping, executionMode)
    ? buildCollectionMapVideoContinuationChainState(node)
    : null;
  assertCollectionMapVideoContinuationChainSupportedForRun(node, mapping, executionMode);
  const useItemCooldown = isHeavyLocalPipelineNode(node);
  for (let index = 0; index < sourceItems.length; index += 1) {
    if (run.cancelRequested || activeRunAbortController?.signal?.aborted) {
      throw new PipelineCancelledError('Pipeline run cancelled before mapping item ' + String(index + 1) + '.');
    }
    if (useItemCooldown && index > 0) {
      await waitForHeavyStepCooldown(run, node.id, node.label + ' item ' + String(index + 1));
    }

    const entry = sourceItems[index];
    const sourceArtifact = entry?.artifact || null;
    try {
      if (!sourceArtifact || sourceArtifact.kind !== mapping.inputKind) {
        throw new Error('That collection item is not a ' + mapping.inputKind + ' artifact.');
      }
      const mappedResult = await executeMappedCollectionItemWithPerItemValidation(node, sourceArtifact, {
        contextMaps,
        itemCount: sourceItems.length,
        itemIndex: index,
        graphWorkflowTool,
        localTool,
        mapping,
        outputKind,
        reportProgress,
        run,
        sourceEntry: entry,
        validationConfig,
        audioContinuationChain,
        referenceAudioArtifact,
        videoContinuationChain,
      });
      const mappedArtifact = mappedResult.artifact;
      if (!mappedArtifact || mappedArtifact.kind !== outputKind) {
        throw new Error('The mapped operation finished, but it did not return a ' + outputKind + ' artifact.');
      }
      const itemId = String(entry?.itemId || '').trim();
      const itemChainMetadata = mappedArtifact?.audioGeneration?.collectionMapAudioChain || null;
      if (audioContinuationChain?.enabled && itemChainMetadata?.cumulativeAudioPath) {
        audioContinuationChain.currentCumulativeAudioPath = String(itemChainMetadata.cumulativeAudioPath || '').trim();
        audioContinuationChain.finalCombinedAudioPath = audioContinuationChain.currentCumulativeAudioPath;
        audioContinuationChain.finalCombinedDurationSeconds = Number(itemChainMetadata.cumulativeDurationAfterItemSeconds || 0) || 0;
        audioContinuationChain.lastAcceptedArtifact = mappedArtifact;
        audioContinuationChain.items.push({
          cumulativeAudioPath: audioContinuationChain.currentCumulativeAudioPath,
          cumulativeDurationAfterItemSeconds: audioContinuationChain.finalCombinedDurationSeconds,
          itemId,
          itemIndex: index,
          previousCumulativeAudioPath: String(itemChainMetadata.previousCumulativeAudioPath || '').trim(),
          segmentAudioPath: String(itemChainMetadata.segmentAudioPath || mappedArtifact.filePath || '').trim(),
          segmentDurationSeconds: Number(itemChainMetadata.segmentDurationSeconds || 0) || 0,
        });
      }
      let videoChainItemMetadata = mappedArtifact?.videoGeneration?.collectionMapVideoChain || null;
      if (videoContinuationChain?.enabled) {
        let lastFrameArtifact = null;
        if (index < sourceItems.length - 1) {
          lastFrameArtifact = await extractVideoLastFrameArtifact(mappedArtifact, {
            displayName: node.label + ' item ' + String(index + 1) + ' last frame',
            itemIndex: index,
            nodeLabel: node.label,
            runDirectories: run.directories,
          });
          videoContinuationChain.previousLastFrameArtifact = lastFrameArtifact;
          videoContinuationChain.finalLastFramePath = String(lastFrameArtifact.filePath || '').trim();
        }
        videoContinuationChain.lastAcceptedArtifact = mappedArtifact;
        videoChainItemMetadata = {
          ...(videoChainItemMetadata || {}),
          extractedLastFrameArtifactPath: String(lastFrameArtifact?.filePath || '').trim(),
          lastFrameReference: buildImageArtifactReference(lastFrameArtifact),
          lastFrameReferencePrepared: Boolean(lastFrameArtifact),
        };
        mappedArtifact.videoGeneration = {
          ...(mappedArtifact.videoGeneration || {}),
          collectionMapVideoChain: videoChainItemMetadata,
        };
        videoContinuationChain.items.push({
          clip: buildVideoArtifactReference(mappedArtifact),
          itemId,
          itemIndex: index,
          lastFrameReference: buildImageArtifactReference(lastFrameArtifact),
          previousClip: videoChainItemMetadata.previousClip || null,
          previousLastFrame: videoChainItemMetadata.previousLastFrame || null,
          referenceRole: String(videoChainItemMetadata.referenceRole || '').trim(),
        });
        await persistVideoGenerationMetadataSidecar(mappedArtifact);
      } else if (mappedArtifact?.kind === PORT_KIND_VIDEO) {
        await persistVideoGenerationMetadataSidecar(mappedArtifact);
      }
      const mappedItemMetadata = mergeCollectionItemMetadata(entry?.metadata, {
        ...(itemChainMetadata ? { audioContinuationChain: itemChainMetadata } : {}),
        ...(videoChainItemMetadata ? { videoContinuationChain: videoChainItemMetadata } : {}),
        collectionMap: {
          mappingId: String(mapping?.id || node?.config?.mappingId || '').trim(),
          nodeId: node.id,
          nodeLabel: node.label,
          operationId: String(mapping?.operationId || getCollectionMapOperationId(node)).trim(),
          sourceItemId: itemId,
          sourceItemIndex: index,
        },
      });
      mappedItems.push({
        artifact: mappedArtifact,
        attempts: mappedResult.attempts,
        itemId,
        lineage: {
          sourceNodeId: node.id,
          sourceNodeLabel: node.label,
          sourcePortId: 'collection',
          sourcePortLabel: formatArtifactCollectionLineageLabel(outputKind),
          sourceItemId: itemId,
          sourceItemIndex: index,
          parentLineage: entry?.lineage || null,
        },
        ...(mappedItemMetadata ? { metadata: mappedItemMetadata } : {}),
        validation: mappedResult.validation,
      });
    } catch (error) {
      const itemId = String(entry?.itemId || '').trim();
      const itemLabel = 'item ' + String(index + 1) + ' of ' + sourceItems.length + (itemId ? ' (' + itemId + ')' : '');
      const rawMessage = String(error?.message || 'The mapped operation failed.');
      const message = /^Map Collection item \d+ of \d+/.test(rawMessage)
        ? rawMessage
        : node.label + ' failed on ' + itemLabel + ': ' + rawMessage;
      const failedItem = buildCollectionMapFailedItemMetadata({
        error,
        failureKind: getCollectionMapFailureMetadataFromError(error)?.failureKind || 'operation',
        itemCount: sourceItems.length,
        itemId,
        itemIndex: index,
        mapping,
        node,
        sourceEntry: entry,
      });
      failedItem.message = message;
      failedItem.reason = String(failedItem.reason || rawMessage).trim();
      if (audioContinuationChain?.enabled) {
        failedItem.chainFailure = true;
        failedItem.audioContinuationChain = serializeCollectionMapAudioContinuationChainState(audioContinuationChain, {
          chainBrokenAtItemIndex: index,
          chainBrokenAtItemId: itemId,
          status: 'failed',
        });
      }
      if (videoContinuationChain?.enabled) {
        failedItem.chainFailure = true;
        failedItem.videoContinuationChain = serializeCollectionMapVideoContinuationChainState(videoContinuationChain, {
          brokenAtItemId: itemId,
          brokenAtItemIndex: index,
          status: 'failed',
        });
      }
      failedItems.push(failedItem);

      if (!partialOutputEnabled || !mappedItems.length) {
        throw new Error(message);
      }

      const persistedPartialCollection = await persistPartialCollectionMapArtifact({
        audioContinuationChain,
        executionMode,
        failedItems,
        mappedItems,
        mapping,
        node,
        outputKind,
        referenceAudioArtifact,
        run,
        sourceCollection,
        sourceItems,
        videoContinuationChain,
      });
      return {
        message: node.label + ' stopped on ' + itemLabel + ' and output a partial ' + outputKind + ' collection with ' + persistedPartialCollection.itemCount + ' successful item' + (persistedPartialCollection.itemCount === 1 ? '' : 's') + '. Failed item details are recorded in the collection manifest.',
        outputs: {
          collection: persistedPartialCollection,
        },
        preview: summarizeArtifact(persistedPartialCollection),
        selectedBranch: 'partial',
      };
    }
  }

  const collection = createArtifactCollection(mappedItems, {
    collectionMapping: buildCollectionMapMetadata(mapping, node, executionMode, {
      audioContinuationChain,
      collectionStatus: 'complete',
      itemCount: sourceItems.length,
      outputItems: mappedItems,
      referenceAudioArtifact,
      sourceCollection,
      videoContinuationChain,
    }),
    collectionStatus: 'complete',
    sourceCollection: {
      directoryPath: String(sourceCollection?.directoryPath || '').trim(),
      displayName: String(sourceCollection?.displayName || '').trim(),
      itemCount: Number(sourceCollection?.itemCount || sourceItems.length) || sourceItems.length,
      itemKind: String(sourceCollection?.itemKind || mapping?.inputKind || '').trim(),
      manifestPath: String(sourceCollection?.manifestPath || '').trim(),
      metadata: sourceCollection?.metadata ? serializeArtifactForUi(sourceCollection.metadata) : null,
    },
    sourceItemCount: sourceItems.length,
    displayName: node.label,
    itemKind: outputKind,
    metadata: buildMappedCollectionRootMetadata(sourceCollection, mapping, node, outputKind),
    role: 'generated',
  });
  const persistedCollection = await persistArtifactCollection(run.directories, collection, {
    baseName: node.label,
    displayName: node.label,
    role: 'generated',
    target: 'artifacts',
  });
  return {
    message: node.label + ' mapped ' + persistedCollection.itemCount + ' item' + (persistedCollection.itemCount === 1 ? '' : 's') + ' into an ordered ' + outputKind + ' collection.',
    outputs: {
      collection: persistedCollection,
    },
    preview: summarizeArtifact(persistedCollection),
  };
}

function formatArtifactCollectionLineageLabel(kind) {
  if (kind === PORT_KIND_IMAGE) return 'Image Collection';
  if (kind === PORT_KIND_AUDIO) return 'Audio Collection';
  if (kind === PORT_KIND_VIDEO) return 'Video Collection';
  if (kind === PORT_KIND_FILE) return 'File Collection';
  return 'Text Collection';
}
async function buildVideoReferenceImageRequest(referenceArtifact, size, options = {}) {
  if (!referenceArtifact) {
    return {
      referenceImage: null,
      referenceImagePath: '',
      sourceImageArtifact: null,
    };
  }

  if (referenceArtifact.kind !== PORT_KIND_IMAGE || !referenceArtifact.filePath) {
    throw new Error('The video reference for this item is not a usable image artifact.');
  }

  const filePath = path.resolve(String(referenceArtifact.filePath || '').trim());
  if (!filePath || !(await fs.pathExists(filePath))) {
    throw new Error('The reference image for this video step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  const enforceSize = options.enforceSize !== false;
  const [expectedWidth, expectedHeight] = String(size || '').split('x').map((value) => Number(value || 0));
  if (enforceSize && expectedWidth > 0 && expectedHeight > 0 && referenceArtifact.width && referenceArtifact.height) {
    if (Number(referenceArtifact.width) !== expectedWidth || Number(referenceArtifact.height) !== expectedHeight) {
      throw new Error('This video step is set to ' + size + ', but the reference image is ' + referenceArtifact.width + 'x' + referenceArtifact.height + '. Choose a matching video size or supply a matching image.');
    }
  }

  return {
    referenceImage: {
      buffer: await fs.readFile(filePath),
      fileName: String(referenceArtifact.fileName || path.basename(filePath)).trim() || path.basename(filePath),
      mimeType: String(referenceArtifact.mimeType || 'image/png').trim() || 'image/png',
    },
    referenceImagePath: filePath,
    sourceImageArtifact: referenceArtifact,
  };
}
async function buildVideoGenerationRequest(node, inputArtifact, contextMaps = {}, options = {}) {
  if (!inputArtifact) {
    throw new Error('This video generation step did not receive any input.');
  }

  const size = String(node.config?.videoSize || '1280x720').trim() || '1280x720';
  const motionPrompt = String(node.config?.instruction || '').trim();
  const referenceImageArtifact = options.referenceImageArtifact || null;
  const enforceReferenceImageSize = node.config?.executionMode !== 'cloud';

  if (inputArtifact.kind === PORT_KIND_TEXT) {
    const promptText = String(inputArtifact.text || '').trim();
    if (!promptText) {
      throw new Error('This video generation step did not receive any text prompt.');
    }

    const basePrompt = motionPrompt ? motionPrompt + '\n\nPrompt:\n' + promptText : promptText;
    const promptRequest = applyNodePromptStyle(contextMaps, node, basePrompt, 'video', {
      negativePrompt: String(node.config?.negativePrompt || '').trim(),
      supportNegativePrompt: true,
    });
    const referenceRequest = await buildVideoReferenceImageRequest(referenceImageArtifact, size, { enforceSize: enforceReferenceImageSize });
    return {
      negativePrompt: promptRequest.negativePrompt,
      prompt: promptRequest.prompt,
      promptStyle: promptRequest.promptStyle,
      referenceImage: referenceRequest.referenceImage,
      referenceImagePath: referenceRequest.referenceImagePath,
      sourceImageArtifact: referenceRequest.sourceImageArtifact,
      size,
    };
  }

  if (inputArtifact.kind === PORT_KIND_IMAGE && (inputArtifact.filePath || referenceImageArtifact?.filePath)) {
    if (!motionPrompt) {
      throw new Error('This video generation step is using an image input. Add motion guidance in the instruction box before running it.');
    }

    const effectiveImageArtifact = referenceImageArtifact?.filePath ? referenceImageArtifact : inputArtifact;
    const filePath = path.resolve(String(effectiveImageArtifact.filePath || '').trim());
    if (!filePath || !(await fs.pathExists(filePath))) {
      throw new Error('The reference image for this video step could not be found anymore. Choose it again and rerun the pipeline.');
    }

    const [expectedWidth, expectedHeight] = size.split('x').map((value) => Number(value || 0));
    if (enforceReferenceImageSize && expectedWidth > 0 && expectedHeight > 0 && effectiveImageArtifact.width && effectiveImageArtifact.height) {
      if (Number(effectiveImageArtifact.width) !== expectedWidth || Number(effectiveImageArtifact.height) !== expectedHeight) {
        throw new Error('This video step is set to ' + size + ', but the connected image is ' + effectiveImageArtifact.width + 'x' + effectiveImageArtifact.height + '. Choose a matching video size or supply a matching image.');
      }
    }

    return {
      negativePrompt: String(node.config?.negativePrompt || '').trim(),
      prompt: motionPrompt,
      referenceImage: {
        buffer: await fs.readFile(filePath),
        fileName: String(effectiveImageArtifact.fileName || path.basename(filePath)).trim() || path.basename(filePath),
        mimeType: String(effectiveImageArtifact.mimeType || 'image/png').trim() || 'image/png',
      },
      referenceImagePath: filePath,
      sourceImageArtifact: effectiveImageArtifact,
      sourceInputImageArtifact: inputArtifact,
      size,
    };
  }

  throw new Error('This video generation step currently accepts text or image input only.');
}

function getAudiocraftGenerationSettings(node) {
  return {
    audiocraftCfgCoef: Number.isFinite(Number(node.config?.audiocraftCfgCoef)) ? Number(node.config.audiocraftCfgCoef) : 3,
    audiocraftTemperature: Number.isFinite(Number(node.config?.audiocraftTemperature)) ? Number(node.config.audiocraftTemperature) : 1,
    audiocraftTopK: Math.max(0, Math.floor(Number(node.config?.audiocraftTopK ?? 250) || 0)),
    audiocraftTopP: Math.max(0, Math.min(1, Number(node.config?.audiocraftTopP || 0) || 0)),
    audiocraftTwoStepCfg: Boolean(node.config?.audiocraftTwoStepCfg),
    appendSource: Boolean(node.config?.appendSource),
    continuationRepeatCount: Math.max(1, Math.min(10, Math.floor(Number(node.config?.continuationRepeatCount ?? 1) || 1))),
  };
}

async function buildAudioGenerationRequest(node, inputArtifact, contextMaps = {}, options = {}) {
  if (!inputArtifact) {
    throw new Error('This audio generation step did not receive any input.');
  }

  const requestedAudioMode = String(node.config?.audioMode || 'music').trim().toLowerCase();
  const audioMode = requestedAudioMode === 'referencevoicetts'
    ? 'referenceVoiceTts'
    : requestedAudioMode === 'sound'
      ? 'sound'
      : requestedAudioMode === 'continuation'
        ? 'continuation'
        : 'music';
  const durationSeconds = Math.max(1, Number(node.config?.durationSeconds || 8) || 8);
  const continuationSeedSeconds = Math.max(0.25, Number(node.config?.continuationSeedSeconds || 12) || 12);
  const instruction = String(node.config?.instruction || '').trim();
  const generationSettings = getAudiocraftGenerationSettings(node);

  if (audioMode === 'referenceVoiceTts') {
    if (inputArtifact.kind !== PORT_KIND_TEXT) {
      throw new Error('Reference Voice TTS needs connected text to speak. Connect a Text Input node to the main Model Step input.');
    }

    const promptText = String(inputArtifact.text || '').trim();
    if (!promptText) {
      throw new Error('Reference Voice TTS needs connected text to speak.');
    }

    const referenceAudioArtifact = options.referenceAudioArtifact || null;
    if (!referenceAudioArtifact || referenceAudioArtifact.kind !== PORT_KIND_AUDIO || !referenceAudioArtifact.filePath) {
      throw new Error('Reference Voice TTS needs a connected reference voice audio clip. Connect an Audio Input node to the Reference Audio input.');
    }

    const referenceAudioPath = path.resolve(String(referenceAudioArtifact.filePath || '').trim());
    if (!referenceAudioPath || !(await fs.pathExists(referenceAudioPath))) {
      throw new Error('The reference voice audio clip could not be found anymore. Choose it again and rerun the pipeline.');
    }

    return {
      ...generationSettings,
      audioMode,
      continuationSeedSeconds,
      durationSeconds,
      prompt: promptText,
      promptStyle: null,
      referenceAudioArtifact,
      referenceAudioPath,
      sourceAudioArtifact: referenceAudioArtifact,
      sourceAudioPath: referenceAudioPath,
    };
  }

  if (inputArtifact.kind === PORT_KIND_TEXT) {
    const promptText = String(inputArtifact.text || '').trim();
    if (!promptText) {
      throw new Error('This audio generation step did not receive any text prompt.');
    }

    if (audioMode === 'continuation') {
      throw new Error('AudioCraft continuation mode needs a source audio clip. Connect an Audio File node or an earlier audio output to this Model Step.');
    }

    const basePrompt = instruction ? instruction + '\n\nPrompt:\n' + promptText : promptText;
    const promptRequest = applyNodePromptStyle(contextMaps, node, basePrompt, 'audio');
    return {
      ...generationSettings,
      audioMode,
      continuationSeedSeconds,
      durationSeconds,
      prompt: promptRequest.prompt,
      promptStyle: promptRequest.promptStyle,
      sourceAudioArtifact: null,
      sourceAudioPath: '',
    };
  }

  if (inputArtifact.kind === PORT_KIND_AUDIO && inputArtifact.filePath) {
    if (audioMode === 'sound') {
      throw new Error('This audio generation step is set to Sound mode, which currently needs text input. Switch to Music or Continuation mode to use an audio file.');
    }

    const sourceAudioPath = path.resolve(String(inputArtifact.filePath || '').trim());
    if (!sourceAudioPath || !(await fs.pathExists(sourceAudioPath))) {
      throw new Error('The source audio for this generation step could not be found anymore. Choose it again and rerun the pipeline.');
    }

    return {
      ...generationSettings,
      audioMode,
      continuationSeedSeconds,
      durationSeconds,
      prompt: audioMode === 'continuation' ? instruction : instruction || 'Create music guided by the supplied audio.',
      sourceAudioArtifact: inputArtifact,
      sourceAudioPath,
    };
  }

  throw new Error('This audio generation step currently accepts text input or a source audio file only.');
}

async function buildAudioTransformRequest(node, inputArtifact) {
  if (!inputArtifact) {
    throw new Error('This audio transformation step did not receive any source audio.');
  }

  if (inputArtifact.kind !== PORT_KIND_AUDIO || !inputArtifact.filePath) {
    throw new Error('This audio transformation step currently accepts a source audio file only.');
  }

  const sourceAudioPath = path.resolve(String(inputArtifact.filePath || '').trim());
  if (!sourceAudioPath || !(await fs.pathExists(sourceAudioPath))) {
    throw new Error('The source audio for this transformation step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  return {
    instruction: String(node.config?.instruction || '').trim(),
    sourceAudioArtifact: inputArtifact,
    sourceAudioPath,
  };
}

async function buildImageTransformRequest(node, inputArtifact, referenceArtifact, tool) {
  const toolId = String(tool?.id || node?.config?.toolId || '').trim().toLowerCase();
  const transformSubtype = normalizeImageTransformSubtype(toolId, node.config?.transformSubtype);
  if (!transformSubtype) {
    throw new Error((tool?.name || 'This local image tool') + ' does not support the selected image transform subtype. Choose a supported transform subtype before running this step.');
  }

  if (!inputArtifact) {
    throw new Error('This image transformation step did not receive any source image.');
  }

  if (inputArtifact.kind !== PORT_KIND_IMAGE || !inputArtifact.filePath) {
    throw new Error('This image transformation step currently accepts an image input only.');
  }

  const sourceImagePath = path.resolve(String(inputArtifact.filePath || '').trim());
  if (!sourceImagePath || !(await fs.pathExists(sourceImagePath))) {
    throw new Error('The source image for this transformation step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  let referenceImagePath = '';
  if (referenceArtifact) {
    if (referenceArtifact.kind !== PORT_KIND_IMAGE || !referenceArtifact.filePath) {
      throw new Error('The Reference Image input currently accepts an image file only.');
    }

    referenceImagePath = path.resolve(String(referenceArtifact.filePath || '').trim());
    if (!referenceImagePath || !(await fs.pathExists(referenceImagePath))) {
      throw new Error('The reference image for this transformation step could not be found anymore. Choose it again and rerun the pipeline.');
    }
  }

  if (toolId === 'facefusion' && !referenceImagePath) {
    throw new Error('FaceFusion needs a source face image on the Reference Image input before it can transform the target image.');
  }

  return {
    instruction: String(node.config?.instruction || '').trim(),
    referenceImageArtifact: referenceArtifact || null,
    referenceImagePath,
    sourceImageArtifact: inputArtifact,
    sourceImagePath,
    transformSubtype,
  };
}

async function buildCloudAudioGenerationRequest(node, inputArtifact, contextMaps = {}) {
  if (!inputArtifact) {
    throw new Error('This cloud audio step did not receive any input.');
  }

  if (inputArtifact.kind !== PORT_KIND_TEXT) {
    throw new Error('This cloud audio step currently accepts text input only.');
  }

  const spokenText = String(inputArtifact.text || '').trim();
  if (!spokenText) {
    throw new Error('This cloud audio step did not receive any text to speak.');
  }

  const instruction = String(node.config?.instruction || '').trim();
  const voice = String(node.config?.audioVoice || '').trim();
  const basePrompt = instruction ? instruction + '\n\nSpeak this text exactly:\n' + spokenText : spokenText;
  const promptRequest = applyNodePromptStyle(contextMaps, node, basePrompt, 'audio');
  return {
    instruction,
    prompt: promptRequest.prompt,
    promptStyle: promptRequest.promptStyle,
    spokenText,
    voice,
  };
}

async function buildValidationMessages(node, artifact, contextMaps) {
  const systemPrompt = String(node.config?.systemPrompt || '').trim();
  const artifactDescription = await buildValidationArtifactDescription(artifact, contextMaps);
  const profile = getValidationCapabilityProfile(node);
  const attachments = [];
  const limitations = [];
  const planReview = buildPlanValidationReview(artifact);
  let evidenceMode = artifact?.kind === PORT_KIND_TEXT ? 'text-only' : artifact?.kind === PORT_KIND_PLAN ? 'structured-plan' : 'summary-only';

  if (isArtifactCollection(artifact)) {
    evidenceMode = 'structured-collection';
    if (artifact?.itemKind === PORT_KIND_FILE) {
      limitations.push('This validator is reviewing the ordered collection as a whole through collection metadata and extracted per-file evidence when available. It is not opening every file as a separate attachment in this step.');
    } else if (artifact?.itemKind === PORT_KIND_IMAGE || artifact?.itemKind === PORT_KIND_VIDEO || artifact?.itemKind === PORT_KIND_AUDIO) {
      limitations.push('This validator is reviewing the ordered collection as a whole through collection metadata and per-item summaries. It is not inspecting every media item as a separate attachment in this step.');
    }
  } else if (artifact?.kind === PORT_KIND_IMAGE) {
    if (profile.directKinds.includes(PORT_KIND_IMAGE) && artifact.filePath) {
      attachments.push(await buildImageMessageContentPart(artifact));
      evidenceMode = 'direct-image';
    } else {
      limitations.push('The selected validator cannot inspect the raw image directly in this step.');
      evidenceMode = 'derived-image-description';
    }
  } else if (artifact?.kind === PORT_KIND_VIDEO) {
    if (canAttachValidationVideoDirectly(node, artifact, profile)) {
      const attachmentPartType = getArtifactBinaryPartType(artifact, 'video');
      attachments.push(await buildPreferredArtifactMessageContentPart(artifact, 'video'));
      evidenceMode = attachmentPartType === 'image' ? 'direct-animated-image' : 'direct-video';
    } else {
      limitations.push('The selected validator cannot inspect this ' + getArtifactReviewLabel(artifact) + ' directly in this step. Only metadata and any extracted notes below are available.');
    }
  } else if (artifact?.kind === PORT_KIND_FILE) {
    if (canAttachValidationFileDirectly(node, artifact, profile)) {
      attachments.push(await buildFileMessageContentPart(artifact));
      evidenceMode = 'direct-file';
      if (String(artifact.previewText || '').trim()) {
        limitations.push('Use the attached file as the primary evidence. The extracted preview below is only supporting context.');
      }
    } else if (profile.derivedKinds.includes(PORT_KIND_FILE)) {
      limitations.push('The selected validator will review extracted document text and metadata. It will not inspect the raw file directly in this step.');
      evidenceMode = 'derived-file-text';
    } else {
      limitations.push('This validator can only use the metadata and preview text below for this file.');
    }
  }

  const reviewContext = {
    artifactKind: String(artifact?.kind || '').trim(),
    attachedPartTypes: attachments.map((part) => part.type),
    derivedKinds: profile.derivedKinds,
    directKinds: profile.directKinds,
    evidenceMode,
    limitations,
    planReview: planReview ? serializeArtifactForUi(planReview) : null,
  };

  const messages = [];
  messages.push({
    role: 'system',
    content:
      (systemPrompt ? systemPrompt + '\n\n' : '')
      + 'Return only valid JSON with keys decision, reason, summary, confidence, evidenceMode, evidenceLimitations, and criteriaResults. '
      + 'decision must be "pass" or "fail". confidence must be a number between 0 and 1. '
      + 'criteriaResults must be an array of objects with criterion, decision, and reason.',
  });
  messages.push({
    role: 'user',
    content: attachments.length
      ? [
          {
            type: 'text',
            text: buildValidationPrompt(node, artifactDescription, reviewContext),
          },
          ...attachments,
        ]
      : buildValidationPrompt(node, artifactDescription, reviewContext),
  });

  return {
    messages,
    reviewContext,
  };
}
function clampValidationConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.min(1, Math.max(0, numeric));
}

function normalizeValidationCriteriaResults(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const criterion = String(entry?.criterion || entry?.name || '').trim();
      const decision = String(entry?.decision || entry?.result || '').trim().toLowerCase();
      const reason = String(entry?.reason || entry?.explanation || '').trim();
      if (!criterion && !reason) {
        return null;
      }

      return {
        criterion,
        decision: decision === 'pass' || decision === 'fail' ? decision : '',
        reason,
      };
    })
    .filter(Boolean);
}

function parseValidationDecision(replyText) {
  const raw = String(replyText || '').trim();
  if (!raw) {
    throw new Error('The validator returned an empty reply.');
  }

  const candidates = [raw];
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    candidates.unshift(objectMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const decision = String(parsed?.decision || parsed?.result || '').trim().toLowerCase();
      if (decision === 'pass' || decision === 'fail') {
        return {
          confidence: clampValidationConfidence(parsed?.confidence ?? parsed?.score),
          criteriaResults: normalizeValidationCriteriaResults(parsed?.criteriaResults || parsed?.criteria || parsed?.checks),
          decision,
          evidenceLimitations: String(parsed?.evidenceLimitations || parsed?.limitations || '').trim(),
          evidenceMode: String(parsed?.evidenceMode || parsed?.reviewMode || '').trim(),
          reason: String(parsed?.reason || parsed?.explanation || parsed?.summary || raw).trim(),
          summary: String(parsed?.summary || parsed?.overallSummary || '').trim(),
        };
      }
    } catch {
      continue;
    }
  }

  const match = raw.match(/\b(pass|fail)\b/i);
  if (!match) {
    throw new Error('The validator reply did not clearly say pass or fail.');
  }

  return {
    confidence: null,
    criteriaResults: [],
    decision: match[1].toLowerCase(),
    evidenceLimitations: '',
    evidenceMode: '',
    reason: raw,
    summary: '',
  };
}

function buildValidationPreview(parsed, reviewContext) {
  const parts = [String(parsed?.decision || '').trim().toUpperCase()];
  if (parsed?.summary) {
    parts.push(parsed.summary);
  } else if (parsed?.reason) {
    parts.push(parsed.reason);
  }

  if (reviewContext?.evidenceMode && reviewContext.evidenceMode !== 'text-only') {
    parts.push(getValidationEvidenceModeLabel(reviewContext));
  }

  return trimPreviewText(parts.filter(Boolean).join(' | '), 220);
}

function buildWhisperTranscriptArtifact(node, audioArtifact, result = {}) {
  const segments = (Array.isArray(result?.segments) ? result.segments : [])
    .map((segment) => ({
      end: Number.isFinite(Number(segment?.end)) ? Math.round(Number(segment.end) * 100) / 100 : null,
      start: Number.isFinite(Number(segment?.start)) ? Math.round(Number(segment.start) * 100) / 100 : null,
      text: String(segment?.text || '').trim(),
    }))
    .filter((segment) => segment.text);
  const durationSeconds = Number(result?.durationSeconds || 0);
  const transcription = {
    backend: 'whisper',
    backendLabel: 'Whisper (faster-whisper)',
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 100) / 100 : null,
    language: String(result?.language || '').trim() || 'unknown',
    model: String(result?.model || node?.config?.model || DEFAULT_WHISPER_MODEL).trim() || DEFAULT_WHISPER_MODEL,
    runtime: {
      computeType: String(result?.computeType || '').trim(),
      device: String(result?.device || '').trim(),
    },
    segmentCount: segments.length,
    segments,
    sourceAudio: audioArtifact ? {
      displayName: audioArtifact.displayName || '',
      fileName: audioArtifact.fileName || '',
      filePath: audioArtifact.filePath || '',
      fileUrl: audioArtifact.fileUrl || '',
      formatLabel: audioArtifact.formatLabel || '',
      kind: audioArtifact.kind || 'audio',
      mimeType: audioArtifact.mimeType || '',
      sizeBytes: Number(audioArtifact.sizeBytes || 0) || 0,
      summary: audioArtifact.summary || '',
    } : null,
  };

  if (!transcription.runtime.computeType && !transcription.runtime.device) {
    delete transcription.runtime;
  }

  return createTextArtifact(String(result?.text || ''), {
    displayName: node.label,
    role: 'generated',
    transcription,
  });
}

function buildWhisperCompletionMessage(result = {}) {
  const details = [];
  const language = String(result?.language || '').trim();
  if (language && language.toLowerCase() !== 'unknown') {
    details.push('detected ' + language);
  }

  const device = String(result?.device || '').trim();
  const computeType = String(result?.computeType || '').trim();
  if (device) {
    details.push('used ' + device + (computeType ? ' ' + computeType : ''));
  }

  return details.length
    ? 'Whisper finished transcribing the audio file and ' + details.join(', ') + '.'
    : 'Whisper finished transcribing the audio file.';
}

async function getInstalledToolOrThrow(contextMaps, toolId, message) {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  const currentTool = await getResolvedToolState(normalizedToolId, {
    syncDiscovered: true,
  }).catch(() => null);
  const tool = currentTool || contextMaps.toolsById[normalizedToolId] || null;
  if (!tool) {
    throw new Error(message);
  }

  contextMaps.toolsById[normalizedToolId] = tool;
  return tool;
}

async function getGraphWorkflowBackendToolOrThrow(contextMaps, node, actionLabel) {
  const support = getGraphWorkflowOperationBackendSupport(node, GRAPH_WORKFLOW_OPERATION_BACKEND_IDS.TEXT_TO_IMAGE, contextMaps);
  if (!support.usable) {
    throw new Error(support.message || 'Configure a compatible text-to-image graph workflow before using it for ' + actionLabel + '.');
  }

  const label = support.contract?.toolId === 'comfyui'
    ? 'ComfyUI'
    : support.contract?.toolId === 'invokeai'
      ? 'InvokeAI'
      : 'the selected graph workflow tool';
  return getInstalledToolOrThrow(
    contextMaps,
    support.toolId,
    'Install ' + label + ' before using this graph workflow for ' + actionLabel + '.',
  );
}

async function getSelectedImageToolOrThrow(contextMaps, node, actionLabel) {
  const operationId = getLocalImageBackendOperationId(node, PIPELINE_OPERATION_IDS.IMAGE_GENERATE);
  const selection = selectLocalImageBackend(contextMaps, node, { operationId });
  const selectedTool = selection.tool || resolveSelectedImageTool(contextMaps, node);
  if (!selectedTool?.id || !selection.usable) {
    throw new Error(selection.message || 'No usable local image generation backend is ready. Install or repair Forge or Automatic1111, then refresh checkpoints.');
  }

  return getInstalledToolOrThrow(
    contextMaps,
    selectedTool.id,
    selection.message || 'Install or repair Forge or Automatic1111 before using the ' + actionLabel + ' step.',
  );
}

async function getSelectedLocalVideoToolOrThrow(contextMaps, node, actionLabel) {
  const selectedToolId = String(node?.config?.toolId || 'wan21-webui').trim().toLowerCase() || 'wan21-webui';
  return getInstalledToolOrThrow(
    contextMaps,
    selectedToolId,
    `Install Wan2.1 WebUI before using the ${actionLabel} step.`,
  );
}

async function getSelectedLocalAudioToolOrThrow(contextMaps, node, actionLabel) {
  const operationId = node?.type === 'collectionMap' ? getCollectionMapOperationId(node) : getModelStepOperationId(node);
  const fallbackToolId = operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
    ? 'whisper'
    : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
      ? 'rvc'
      : 'audiocraft-webui';
  const configuredToolId = String(node?.config?.toolId || '').trim().toLowerCase();
  const referenceVoiceRequested = String(node?.config?.audioMode || '').trim().toLowerCase() === 'referencevoicetts';
  const inferredToolId = node?.type === 'collectionMap'
    ? fallbackToolId
    : String(getModelStepLocalToolId(node, contextMaps) || fallbackToolId).trim().toLowerCase();
  const selectedToolId = configuredToolId
    || (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE && referenceVoiceRequested ? 'chatterbox-tts' : '')
    || inferredToolId
    || fallbackToolId;
  const installMessage = operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
    ? 'Install Whisper before using the ' + actionLabel + ' step.'
    : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
      ? 'Install RVC before using the ' + actionLabel + ' step.'
      : selectedToolId === 'chatterbox-tts'
        ? 'Install Chatterbox-Turbo TTS before using the ' + actionLabel + ' step.'
        : 'Install AudioCraft WebUI before using the ' + actionLabel + ' step.';
  return getInstalledToolOrThrow(
    contextMaps,
    selectedToolId,
    installMessage,
  );
}

async function getSelectedLocalImageToolOrThrow(contextMaps, node, actionLabel) {
  const fallbackToolId = 'upscayl';
  const selectedToolId = String(getModelStepLocalToolId(node, contextMaps) || fallbackToolId).trim().toLowerCase() || fallbackToolId;
  const installMessage = selectedToolId === 'facefusion'
    ? 'Install FaceFusion before using the ' + actionLabel + ' step.'
    : 'Install Upscayl or FaceFusion before using the ' + actionLabel + ' step.';
  return getInstalledToolOrThrow(
    contextMaps,
    selectedToolId,
    installMessage,
  );
}

async function buildValidationArtifactDescription(artifact, contextMaps) {
  let description = await describeArtifactForLlm(artifact);
  if (artifact?.kind === PORT_KIND_PLAN) {
    const planReviewEvidence = formatPlanReviewEvidence(buildPlanValidationReview(artifact));
    if (planReviewEvidence) {
      description += '\n\nLocal AI Hub plan-review evidence:\n' + planReviewEvidence;
    }
  }

  if (artifact?.kind === PORT_KIND_COLLECTION) {
    if (artifact?.itemKind === PORT_KIND_FILE) {
      description += '\n\nLocal AI Hub is validating this ordered collection as a whole. Per-file extracted text is included when available, but the raw files are not attached one by one in this pass.';
    } else if (artifact?.itemKind === PORT_KIND_IMAGE || artifact?.itemKind === PORT_KIND_VIDEO || artifact?.itemKind === PORT_KIND_AUDIO) {
      description += '\n\nLocal AI Hub is validating this ordered collection as a whole using collection metadata and per-item summaries. It is not attaching every media item separately in this pass.';
    } else {
      description += '\n\nLocal AI Hub is validating this ordered collection as a whole rather than fanning out into separate per-item validation passes.';
    }
  }

  if (artifact?.kind === PORT_KIND_IMAGE && artifact.isAnimated) {
    description = `${description}\n\nThis image is animated rather than a single still frame.`;
  }

  if (artifact?.kind === PORT_KIND_IMAGE && artifact.filePath) {
    const imageTool = resolveSelectedImageTool(contextMaps, { config: {} });
    if (imageTool && String(imageTool.status || '').toLowerCase() === 'running') {
      try {
        const caption = await interrogateImageWithWorkflowTool(imageTool, {
          analysisMode: 'clip',
          imagePath: artifact.filePath,
        });
        description = `${description}\n\nDetected image description:\n${caption.text}`;
      } catch {
        // Fall back to file metadata when the image tool is unavailable.
      }
    }
  }

  if (artifact?.kind === PORT_KIND_FILE) {
    if (String(artifact.previewText || '').trim()) {
      description = `${description}\n\nExtracted document text:\n${artifact.previewText}`;
    } else {
      description = `${description}\n\nNo text excerpt could be extracted from this file in Local AI Hub.`;
    }
  }

  if (artifact?.kind === PORT_KIND_VIDEO) {
    description = artifact.previewKind === 'animated-image'
      ? `${description}\n\nThis motion artifact is stored as an animated image file rather than an mp4-style video container. Validators without direct motion support only receive the metadata above.`
      : `${description}\n\nLocal AI Hub does not extract video frames in this build. Validators without direct video support only receive the metadata above.`;
  }

  return description;
}
function isMediaCompositionExportArtifact(artifact) {
  return String(artifact?.kind || '').trim() === PORT_KIND_VIDEO
    && artifact?.compositionExport
    && typeof artifact.compositionExport === 'object';
}

function getMediaCompositionNodeFromExportNode(graph, exportNode) {
  if (!graph || exportNode?.type !== 'mediaExport') {
    return null;
  }

  const compositionInputEdge = getIncomingEdgesForPortKey(graph, exportNode.id + ':composition')[0] || null;
  if (!compositionInputEdge?.source?.nodeId) {
    return null;
  }

  const sourceNode = graph.nodeMap.get(compositionInputEdge.source.nodeId) || null;
  return sourceNode?.type === 'mediaComposition' ? sourceNode : null;
}

function findMediaCompositionRetryTargetForValidation(graph, validationNode, run, artifact) {
  if (!isMediaCompositionExportArtifact(artifact)) {
    return null;
  }

  const traceNodeId = String(
    artifact?.compositionExport?.pipelineTrace?.mediaCompositionNodeId
      || artifact?.compositionExport?.composition?.nodeId
      || '',
  ).trim();
  if (traceNodeId) {
    const traceNode = graph.nodeMap.get(traceNodeId) || null;
    if (traceNode?.type === 'mediaComposition') {
      return traceNode;
    }
  }

  const directInput = getNodeInputArtifacts(validationNode.id, 'input', graph, run.resultsByNodeId, run)[0] || null;
  const directSourceNode = directInput?.edge?.source?.nodeId ? graph.nodeMap.get(directInput.edge.source.nodeId) : null;
  const directCompositionNode = getMediaCompositionNodeFromExportNode(graph, directSourceNode);
  if (directCompositionNode) {
    return directCompositionNode;
  }

  const artifactPath = String(artifact?.filePath || artifact?.destinationPath || '').trim();
  const activeLoopNodeIds = cloneLoopContexts(run.nodeStates?.[validationNode.id]?.activeLoops)
    .map((entry) => String(entry?.loopNodeId || '').trim())
    .filter(Boolean);
  const searchNodeIds = activeLoopNodeIds.length
    ? activeLoopNodeIds.flatMap((loopNodeId) => graph.retryLoopsByNodeId.get(loopNodeId)?.segmentExecutionOrder || [])
    : graph.executionOrder;

  for (const nodeId of searchNodeIds) {
    const candidateNode = graph.nodeMap.get(nodeId) || null;
    if (candidateNode?.type !== 'mediaExport') {
      continue;
    }

    const candidateArtifact = run.resultsByNodeId?.[nodeId]?.outputs?.video || null;
    const candidatePath = String(candidateArtifact?.filePath || candidateArtifact?.destinationPath || '').trim();
    if (!candidateArtifact || (artifactPath && candidatePath !== artifactPath)) {
      continue;
    }

    const compositionNode = getMediaCompositionNodeFromExportNode(graph, candidateNode);
    if (compositionNode) {
      return compositionNode;
    }
  }

  return null;
}

function buildMediaCompositionRetryControls(graph, validationNode, run, artifact) {
  const targetNode = findMediaCompositionRetryTargetForValidation(graph, validationNode, run, artifact);
  if (!targetNode) {
    return null;
  }

  const audioMix = getCompositionAudioMixForRetryControls(artifact);
  const effectiveConfig = getMediaCompositionEffectiveConfig(targetNode, run);
  const soundEffectsPlan = artifact?.compositionExport?.soundEffects && typeof artifact.compositionExport.soundEffects === 'object'
    ? artifact.compositionExport.soundEffects
    : null;
  const visualTrack = artifact?.compositionExport?.visualTrack && typeof artifact.compositionExport.visualTrack === 'object'
    ? artifact.compositionExport.visualTrack
    : null;
  return {
    mediaComposition: {
      backgroundMusicVolume: audioMix.backgroundMusicVolume,
      imageTimingMode: normalizeMediaCompositionImageTimingMode(effectiveConfig.imageTimingMode || visualTrack?.imageTimingMode),
      nodeConfig: serializeArtifactForUi(effectiveConfig),
      nodeId: targetNode.id,
      nodeLabel: targetNode.label || 'Media Composition',
      narrationVolume: audioMix.narrationVolume,
      sceneTransitionCategory: normalizeMediaCompositionTransitionCategory(effectiveConfig.sceneTransitionCategory || visualTrack?.sceneTransitions?.category),
      sceneTransitionDurationSeconds: normalizeMediaCompositionTransitionDuration(effectiveConfig.sceneTransitionDurationSeconds || visualTrack?.sceneTransitions?.configuredDurationSeconds),
      sceneTransitionMode: normalizeMediaCompositionTransitionMode(effectiveConfig.sceneTransitionMode || visualTrack?.sceneTransitions?.mode),
      sceneTransitionName: normalizeMediaCompositionTransitionName(effectiveConfig.sceneTransitionName || visualTrack?.sceneTransitions?.singleTransition),
      secondsPerItem: normalizeMediaCompositionSeconds(effectiveConfig.secondsPerItem ?? visualTrack?.timing?.fixedDurationSeconds, 4, 0.1),
      soundEffectsEnabled: effectiveConfig.soundEffectsEnabled === true || soundEffectsPlan?.enabled === true,
      soundEffectsGlobalGuardEnabled: effectiveConfig.soundEffectsGlobalGuardEnabled === true || soundEffectsPlan?.globalGuard?.enabled === true,
      soundEffectsGlobalMaxSimultaneous: Math.max(1, Math.min(8, Math.floor(Number(effectiveConfig.soundEffectsGlobalMaxSimultaneous ?? soundEffectsPlan?.globalGuard?.maxSimultaneous ?? DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS) || DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS))),
      soundEffectsGlobalMinSpacingSeconds: normalizeMediaCompositionSeconds(effectiveConfig.soundEffectsGlobalMinSpacingSeconds ?? soundEffectsPlan?.globalGuard?.minSpacingSeconds, DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS, 0),
      soundEffectsGlobalVolume: audioMix.soundEffectsGlobalVolume,
      soundEffectsLayers: normalizeMediaCompositionSoundEffectsRetryLayers(effectiveConfig.soundEffectsLayers || soundEffectsPlan?.layers || [], soundEffectsPlan?.layers || []),
      soundEffectsVolume: normalizeMediaCompositionVolume(effectiveConfig.soundEffectsVolume ?? soundEffectsPlan?.layers?.[0]?.volume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME),
      temporary: true,
    },
  };
}
function applyMediaCompositionRetryOverride(run, pendingValidation, payload) {
  const mediaCompositionControl = pendingValidation?.retryControls?.mediaComposition || null;
  if (!mediaCompositionControl?.nodeId) {
    return null;
  }

  const overrideConfig = buildMediaCompositionRetryOverrideConfig(payload?.retryOverrides?.mediaComposition);
  if (!overrideConfig) {
    return null;
  }

  if (!run.retryOverridesByNodeId || typeof run.retryOverridesByNodeId !== 'object') {
    run.retryOverridesByNodeId = {};
  }

  const nodeId = String(mediaCompositionControl.nodeId || '').trim();
  run.retryOverridesByNodeId[nodeId] = {
    ...(run.retryOverridesByNodeId[nodeId] || {}),
    mediaComposition: overrideConfig,
  };
  return overrideConfig;
}

function isBurnSubtitlesArtifact(artifact) {
  return String(artifact?.kind || '').trim() === PORT_KIND_VIDEO
    && artifact?.subtitleBurn
    && typeof artifact.subtitleBurn === 'object'
    && String(artifact.subtitleBurn.operationId || artifact.subtitleBurn.operation || '').trim() === 'burnSubtitles';
}

function findBurnSubtitlesRetryTargetForValidation(graph, validationNode, run, artifact) {
  if (!isBurnSubtitlesArtifact(artifact)) {
    return null;
  }

  const traceNodeId = String(
    artifact?.subtitleBurn?.pipelineTrace?.burnSubtitlesNodeId
      || artifact?.subtitleBurn?.createdBy?.nodeId
      || '',
  ).trim();
  if (traceNodeId) {
    const traceNode = graph.nodeMap.get(traceNodeId) || null;
    if (traceNode?.type === 'burnSubtitles') {
      return traceNode;
    }
  }

  const directInput = getNodeInputArtifacts(validationNode.id, 'input', graph, run.resultsByNodeId, run)[0] || null;
  const directSourceNode = directInput?.edge?.source?.nodeId ? graph.nodeMap.get(directInput.edge.source.nodeId) : null;
  if (directSourceNode?.type === 'burnSubtitles') {
    return directSourceNode;
  }

  const artifactPath = String(artifact?.filePath || artifact?.destinationPath || '').trim();
  const activeLoopNodeIds = cloneLoopContexts(run.nodeStates?.[validationNode.id]?.activeLoops)
    .map((entry) => String(entry?.loopNodeId || '').trim())
    .filter(Boolean);
  const searchNodeIds = activeLoopNodeIds.length
    ? activeLoopNodeIds.flatMap((loopNodeId) => graph.retryLoopsByNodeId.get(loopNodeId)?.segmentExecutionOrder || [])
    : graph.executionOrder;

  for (const nodeId of searchNodeIds) {
    const candidateNode = graph.nodeMap.get(nodeId) || null;
    if (candidateNode?.type !== 'burnSubtitles') {
      continue;
    }

    const candidateArtifact = run.resultsByNodeId?.[nodeId]?.outputs?.video || null;
    const candidatePath = String(candidateArtifact?.filePath || candidateArtifact?.destinationPath || '').trim();
    if (candidateArtifact && (!artifactPath || candidatePath === artifactPath)) {
      return candidateNode;
    }
  }

  return null;
}

function getBurnSubtitlesSafeCaptionModeOptions(settings) {
  const resolvedMode = normalizeBurnSubtitlesEnum(settings?.captionMode, BURN_SUBTITLES_CAPTION_MODES, 'auto');
  if (resolvedMode === 'subtitleFile') {
    return ['auto', 'subtitleFile'];
  }
  if (resolvedMode === 'transcriptSegments') {
    return ['auto', 'transcriptSegments'];
  }
  if (resolvedMode === 'manualLines') {
    return ['auto', 'manualLines'];
  }
  return ['auto'];
}

function buildBurnSubtitlesRetryControls(graph, validationNode, run, artifact) {
  const targetNode = findBurnSubtitlesRetryTargetForValidation(graph, validationNode, run, artifact);
  if (!targetNode) {
    return null;
  }

  const settings = getSubtitleBurnSettingsForRetryControls(artifact);
  return {
    burnSubtitles: {
      captionModeOptions: getBurnSubtitlesSafeCaptionModeOptions(settings),
      nodeId: targetNode.id,
      nodeLabel: targetNode.label || 'Burn Subtitles / Captions',
      settings,
      temporary: true,
    },
  };
}
function applyBurnSubtitlesRetryOverride(run, pendingValidation, payload) {
  const burnSubtitlesControl = pendingValidation?.retryControls?.burnSubtitles || null;
  if (!burnSubtitlesControl?.nodeId) {
    return null;
  }

  const overrideConfig = buildBurnSubtitlesRetryOverrideConfig(payload?.retryOverrides?.burnSubtitles);
  if (!overrideConfig) {
    return null;
  }

  if (!run.retryOverridesByNodeId || typeof run.retryOverridesByNodeId !== 'object') {
    run.retryOverridesByNodeId = {};
  }

  const nodeId = String(burnSubtitlesControl.nodeId || '').trim();
  run.retryOverridesByNodeId[nodeId] = {
    ...(run.retryOverridesByNodeId[nodeId] || {}),
    burnSubtitles: overrideConfig,
  };
  return overrideConfig;
}

function buildValidationRetryControls(graph, validationNode, run, artifact) {
  const controls = {
    ...(buildMediaCompositionRetryControls(graph, validationNode, run, artifact) || {}),
    ...(buildBurnSubtitlesRetryControls(graph, validationNode, run, artifact) || {}),
  };
  return Object.keys(controls).length ? controls : null;
}

function applyValidationRetryOverrides(run, pendingValidation, payload) {
  const mediaComposition = applyMediaCompositionRetryOverride(run, pendingValidation, payload);
  const burnSubtitles = applyBurnSubtitlesRetryOverride(run, pendingValidation, payload);
  return {
    ...(mediaComposition ? { mediaComposition } : {}),
    ...(burnSubtitles ? { burnSubtitles } : {}),
  };
}

async function waitForUserValidation(run, node, artifact, options = {}) {
  if (pendingValidationControl) {
    throw new Error('Local AI Hub is already waiting on another validation decision.');
  }

  const nodeState = run.nodeStates[node.id];
  const planReview = buildPlanValidationReview(artifact);
  const reviewContext = options.reviewContext && typeof options.reviewContext === 'object'
    ? options.reviewContext
    : null;
  const evidenceMode = String(reviewContext?.evidenceMode || '').trim() || getUserValidationEvidenceMode(artifact, planReview);
  const iteration = Number(options.attemptNumber || nodeState?.iteration || 1) || 1;
  const loopMaxAttempts = Number(options.maxAttempts || nodeState?.loopMaxAttempts || 0) || null;
  const loopPathLabel = String(nodeState?.loopPathLabel || '').trim();
  const mapContext = options.pendingContext?.collectionMap || null;
  const mapAttemptLabel = mapContext
    ? 'Map item ' + String(Number(mapContext.itemIndex || 0) + 1) + ' of ' + mapContext.itemCount + (mapContext.itemId ? ' (' + mapContext.itemId + ')' : '') + ' | Attempt ' + mapContext.attemptNumber + ' of ' + mapContext.maxAttempts
    : '';
  const attemptLabel = mapAttemptLabel || loopPathLabel || (loopMaxAttempts ? 'Attempt ' + iteration + ' of ' + loopMaxAttempts : iteration > 1 ? 'Attempt ' + iteration : '');
  const pendingValidation = {
    activeLoops: cloneLoopContexts(nodeState?.activeLoops),
    artifact: serializeArtifactForUi(artifact),
    collectionMap: mapContext ? serializeArtifactForUi(mapContext) : null,
    iteration,
    loopMaxAttempts,
    loopPathLabel,
    mode: 'user',
    nodeId: node.id,
    planReview: planReview ? serializeArtifactForUi(planReview) : null,
    reviewContext: reviewContext ? serializeArtifactForUi(reviewContext) : {
      artifactKind: String(artifact?.kind || '').trim(),
      evidenceMode,
      limitations: [],
      planReview: planReview ? serializeArtifactForUi(planReview) : null,
    },
    nodeLabel: node.label,
    requestId: createUniqueId('validation'),
    requestedAt: new Date().toISOString(),
    retryControls: options.retryControls ? serializeArtifactForUi(options.retryControls) : null,
  };

  const decision = await new Promise((resolve) => {
    pendingValidationControl = {
      nodeId: node.id,
      requestId: pendingValidation.requestId,
      resolve,
      runId: run.runId,
    };
    run.status = 'paused';
    run.message = options.message || (attemptLabel
      ? `Paused at ${node.label} (${attemptLabel}). Local AI Hub is waiting for your decision.`
      : `Paused at ${node.label}. Local AI Hub is waiting for your decision.`);
    run.pendingValidation = pendingValidation;
    nodeState.status = 'paused';
    nodeState.message = options.nodeMessage || (attemptLabel
      ? 'Waiting for your pass or fail decision for ' + attemptLabel.toLowerCase() + '.'
      : 'Waiting for your pass or fail decision.');
    nodeState.pendingValidationContext = mapContext ? serializeArtifactForUi({ collectionMap: mapContext }) : null;
    nodeState.preview = summarizeArtifact(artifact);
    emitPipelineEvent();
  });

  run.pendingValidation = null;
  if (decision?.action === 'cancel') {
    throw new PipelineCancelledError('Pipeline run cancelled during validation.');
  }

  if (run.status !== 'running' || nodeState.status !== 'running') {
    run.status = 'running';
    run.message = `Continuing after ${node.label}.`;
    nodeState.status = 'running';
    nodeState.message = 'Validation decision received. Continuing the run.';
    emitPipelineEvent();
  }
  return decision;
}

async function executeLlmValidationReview(node, artifact, contextMaps, reportProgress, options = {}) {
  const validationRequest = await buildValidationMessages(node, artifact, contextMaps);
  const messages = validationRequest.messages;
  const reviewContext = validationRequest.reviewContext;
  const model = String(node.config?.model || '').trim();
  if (!model) {
    throw new Error('Choose or enter a model for this validator before running the pipeline.');
  }

  let reply = '';
  if (node.config?.llmExecutionMode === 'ollama') {
    reportProgress?.(options.progressMessage || 'Sending the content to Ollama for validation.', options.progressTitle || `Running ${node.label} with Ollama...`);
    const ollamaTool = await getInstalledToolOrThrow(
      contextMaps,
      'ollama',
      'Install Ollama before using a local validation step in a pipeline.',
    );
    if (artifact.kind === PORT_KIND_IMAGE) {
      await ensureOllamaImageModelSupport(contextMaps, ollamaTool, model);
    }
    const result = await chatWithOllama(ollamaTool, {
      messages,
      model,
    });
    reply = String(result?.message?.content || '').trim();
  } else {
    const providerId = String(node.config?.providerId || '').trim();
    if (!providerId) {
      throw new Error('Choose a connected cloud provider before running this validation step.');
    }

    const provider = contextMaps.providersById[providerId] || null;
    if (!provider?.isConnected) {
      throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
    }

    reportProgress?.(options.progressMessage || `Sending the content to ${provider.name} for validation.`, options.progressTitle || `Running ${node.label} with ${provider.name}...`);
    const result = await chatWithProvider(providerId, {
      messages,
      model,
      providerId,
    });
    reply = String(result?.message?.content || '').trim();
  }

  const parsed = parseValidationDecision(reply);
  const selectedBranch = parsed.decision === 'pass' ? 'pass' : 'fail';
  const reason = parsed.reason || `Validator selected ${selectedBranch}.`;
  const evidenceLimitations = parsed.evidenceLimitations || (reviewContext.limitations || []).join(' ');
  const validationResult = {
    confidence: parsed.confidence,
    criteriaResults: parsed.criteriaResults,
    decision: selectedBranch,
    evidenceLimitations,
    evidenceMode: parsed.evidenceMode || reviewContext.evidenceMode,
    mode: 'llm',
    planReview: reviewContext.planReview || null,
    rawReply: reply,
    reason,
    reviewContext,
    summary: parsed.summary || '',
  };
  return {
    preview: buildValidationPreview(parsed, reviewContext),
    selectedBranch,
    validation: validationResult,
  };
}

async function executeValidationNode(node, graph, run, contextMaps, reportProgress) {
  const artifact = getNodeInputArtifact(node.id, 'input', graph, run.resultsByNodeId, run);
  if (!artifact) {
    throw new Error('This validation step did not receive any content.');
  }

  if (node.config?.mode !== 'llm') {
    const planReview = buildPlanValidationReview(artifact);
    const evidenceMode = getUserValidationEvidenceMode(artifact, planReview);
    const decision = await waitForUserValidation(run, node, artifact, {
      retryControls: buildValidationRetryControls(graph, node, run, artifact),
    });
    const selectedBranch = decision?.decision === 'pass' ? 'pass' : 'fail';
    const reason = decision?.comment ? `User note: ${decision.comment}` : `User selected ${selectedBranch}.`;
    const validationResult = {
      decision: selectedBranch,
      evidenceMode,
      mode: 'user',
      planReview: planReview ? serializeArtifactForUi(planReview) : null,
      reason,
      reviewContext: {
        artifactKind: String(artifact?.kind || '').trim(),
        evidenceMode,
        limitations: [],
        planReview: planReview ? serializeArtifactForUi(planReview) : null,
      },
      summary: reason,
    };
    return {
      message: `Validation routed this artifact to ${selectedBranch}.`,
      outputs: {
        [selectedBranch]: attachPlanValidationResult(artifact, validationResult),
      },
      preview: trimPreviewText(reason),
      selectedBranch,
      validation: validationResult,
    };
  }

  const review = await executeLlmValidationReview(node, artifact, contextMaps, reportProgress);
  return {
    message: `Validator routed this item to ${review.selectedBranch}.`,
    outputs: {
      [review.selectedBranch]: attachPlanValidationResult(artifact, review.validation),
    },
    preview: review.preview,
    selectedBranch: review.selectedBranch,
    validation: review.validation,
  };
}

function executeBranchMergeNode(node, graph, run) {
  const carriedEntries = getLoopCarriedArtifactsForNode(node.id, graph, run);
  if (carriedEntries.length > 1) {
    const loopLabels = carriedEntries.map((entry) => entry.loopMeta?.loopLabel || entry.loopMeta?.loopNodeId || 'Another retry loop');
    throw new Error('This merge step received retry artifacts from more than one active loop at the same time: ' + loopLabels.join(', ') + '. Route those loops through separate merge points so the re-entry path stays explicit.');
  }

  const carriedEntry = carriedEntries[0] || null;
  if (carriedEntry?.artifact) {
    const selectedArtifact = carriedEntry.artifact;
    return {
      message: (carriedEntry.loopMeta?.loopLabel || 'Retry loop') + ' fed its retry artifact back through this merge.',
      outputs: {
        result: selectedArtifact,
      },
      preview: summarizeArtifact(selectedArtifact),
      selectedBranch: 'loop-retry',
    };
  }

  const activeBranchEntries = getNodeInputArtifacts(node.id, 'branch', graph, run.resultsByNodeId);
  if (!activeBranchEntries.length) {
    throw new Error('This merge step did not receive any active branch output.');
  }

  if (activeBranchEntries.length > 1) {
    const sourceLabels = activeBranchEntries.map((entry) => {
      const sourceNode = graph.nodeMap.get(entry.edge.source.nodeId);
      const sourcePort = getPortDefinition(sourceNode?.type, 'output', entry.edge.source.portId);
      return `${sourceNode?.label || 'Another step'} (${sourcePort?.label || entry.edge.source.portId})`;
    });
    throw new Error('This merge step received more than one live branch result at once: ' + sourceLabels.join(', ') + '. Branch Merge currently expects exactly one active branch. Add another validation gate or restructure the flow before this merge.');
  }

  const selectedArtifact = activeBranchEntries[0].artifact;
  return {
    message: 'Branch Merge forwarded the active branch.',
    outputs: {
      result: selectedArtifact,
    },
    preview: summarizeArtifact(selectedArtifact),
    selectedBranch: 'connected-branch',
  };
}

function executeRetryLoopNode(node, graph, run) {
  const completeArtifact = getNodeInputArtifact(node.id, 'complete', graph, run.resultsByNodeId, run);
  const retryArtifact = getNodeInputArtifact(node.id, 'retry', graph, run.resultsByNodeId, run);
  const accumulatorCollectionState = getRetryLoopAccumulatorCollectionState(node, graph, completeArtifact);
  const accumulatorCollecting = accumulatorCollectionState?.status === 'collecting';
  const accumulatorEmitted = accumulatorCollectionState?.status === 'emitted';

  if (completeArtifact && retryArtifact && !accumulatorCollecting && !accumulatorEmitted) {
    throw new Error('This Retry Loop node received both the Complete and Retry branches at the same time. Keep the loop exit and retry paths mutually exclusive.');
  }

  if (!completeArtifact && !retryArtifact) {
    throw new Error('This Retry Loop node did not receive a live branch yet.');
  }

  const loopMeta = graph.retryLoopsByNodeId.get(node.id) || null;
  const loopState = run.loopStates?.[node.id] || null;
  if (!loopMeta || !loopState) {
    throw new Error('Local AI Hub could not prepare that retry loop. Reopen the pipeline and try again.');
  }

  const currentAttempt = Number(loopState.attempt || 1);
  const maxAttempts = Number(loopState.maxAttempts || loopMeta.maxAttempts || 1);
  const nodeLoopState = getNodeLoopState(run, graph, node.id);
  const terminationAction = resolveRetryLoopTerminationAction(loopMeta, node);

  if (completeArtifact && !accumulatorCollecting && (accumulatorEmitted || !retryArtifact)) {
    loopState.carriedArtifact = null;
    loopState.lastRetryArtifactSignature = '';
    loopState.status = 'completed';
    const completedMessage = accumulatorEmitted && retryArtifact
      ? node.label + ' completed because ' + accumulatorCollectionState.nodeLabel + ' reached ' + accumulatorCollectionState.acceptedCount + ' of ' + accumulatorCollectionState.targetCount + ' accepted items, so the live Retry branch was ignored.'
      : currentAttempt > 1
        ? node.label + ' exited the loop on attempt ' + currentAttempt + ' of ' + maxAttempts + '.'
        : node.label + ' exited the loop on the first attempt.';
    recordLoopHistory(loopState, {
      activeLoops: nodeLoopState.activeLoops,
      attempt: currentAttempt,
      loopMaxAttempts: maxAttempts,
      loopPathLabel: nodeLoopState.loopPathLabel,
      message: completedMessage,
      preview: summarizeArtifact(completeArtifact),
      selectedBranch: 'complete',
      status: 'completed',
    });
    return {
      message: completedMessage,
      outputs: {
        result: completeArtifact,
      },
      preview: summarizeArtifact(completeArtifact),
      selectedBranch: 'complete',
    };
  }

  const retrySignature = retryArtifact ? createArtifactTerminationSignature(retryArtifact) : '';
  const repeatedRetryArtifact = Boolean(
    shouldStopRetryLoopOnRepeatedArtifact(loopMeta, node)
    && retrySignature
    && loopState.lastRetryArtifactSignature
    && retrySignature === loopState.lastRetryArtifactSignature
  );

  if (accumulatorCollecting) {
    if (repeatedRetryArtifact) {
      const repeatedMessage = buildRetryLoopAccumulatorProgressMessage(
        node,
        accumulatorCollectionState,
        'but the Retry branch repeated the same artifact twice in a row. Adjust the loop or disable that stop rule before running it again.',
      );
      loopState.carriedArtifact = null;
      loopState.lastRetryArtifactSignature = '';
      loopState.status = 'failed';
      recordLoopHistory(loopState, {
        activeLoops: nodeLoopState.activeLoops,
        attempt: currentAttempt,
        loopMaxAttempts: maxAttempts,
        loopPathLabel: nodeLoopState.loopPathLabel,
        message: repeatedMessage,
        preview: retryArtifact ? summarizeArtifact(retryArtifact) : summarizeArtifact(completeArtifact),
        selectedBranch: 'retry-terminated',
        status: 'failed',
      });
      throw new Error(repeatedMessage);
    }

    if (currentAttempt >= maxAttempts) {
      const maxAttemptMessage = buildRetryLoopAccumulatorProgressMessage(
        node,
        accumulatorCollectionState,
        'before ' + node.label + ' reached its ' + maxAttempts + '-attempt limit. Raise the loop limit or lower the target count before running it again.',
      );
      loopState.carriedArtifact = null;
      loopState.lastRetryArtifactSignature = '';
      loopState.status = 'failed';
      recordLoopHistory(loopState, {
        activeLoops: nodeLoopState.activeLoops,
        attempt: currentAttempt,
        loopMaxAttempts: maxAttempts,
        loopPathLabel: nodeLoopState.loopPathLabel,
        message: maxAttemptMessage,
        preview: retryArtifact ? summarizeArtifact(retryArtifact) : summarizeArtifact(completeArtifact),
        selectedBranch: 'collecting',
        status: 'failed',
      });
      throw new Error(maxAttemptMessage);
    }

    const collectingMessage = retryArtifact
      ? buildRetryLoopAccumulatorProgressMessage(
          node,
          accumulatorCollectionState,
          'and the Retry branch is still active, so ' + node.label + ' is starting attempt ' + (currentAttempt + 1) + ' of ' + maxAttempts + ' from ' + loopMeta.retryTargetLabel + '.',
        )
      : buildRetryLoopAccumulatorProgressMessage(
          node,
          accumulatorCollectionState,
          'so ' + node.label + ' is starting attempt ' + (currentAttempt + 1) + ' of ' + maxAttempts + ' from ' + loopMeta.retryTargetLabel + '.',
        );
    loopState.carriedArtifact = retryArtifact || null;
    loopState.lastRetryArtifactSignature = retrySignature;
    loopState.status = 'retrying';
    recordLoopHistory(loopState, {
      activeLoops: nodeLoopState.activeLoops,
      attempt: currentAttempt,
      loopMaxAttempts: maxAttempts,
      loopPathLabel: nodeLoopState.loopPathLabel,
      message: collectingMessage,
      preview: retryArtifact ? summarizeArtifact(retryArtifact) : summarizeArtifact(completeArtifact),
      selectedBranch: retryArtifact ? 'retry' : 'collecting',
      status: 'retrying',
    });
    return {
      message: collectingMessage,
      outputs: {},
      preview: retryArtifact ? summarizeArtifact(retryArtifact) : summarizeArtifact(completeArtifact),
      selectedBranch: retryArtifact ? 'retry' : 'collecting',
      loopControl: {
        action: 'retry',
        loopNodeId: node.id,
        nextAttempt: currentAttempt + 1,
        retryTargetNodeId: loopMeta.retryTargetNodeId,
      },
    };
  }

  if (repeatedRetryArtifact) {
    const repeatedMessage = terminationAction === 'complete'
      ? node.label + ' stopped after attempt ' + currentAttempt + ' because the Retry branch produced the same artifact twice in a row, so Local AI Hub kept the latest retry artifact.'
      : node.label + ' stopped after attempt ' + currentAttempt + ' because the Retry branch produced the same artifact twice in a row. Adjust the loop or disable that stop rule before running it again.';
    return finalizeRetryLoopTermination({
      action: terminationAction,
      loopState,
      maxAttempts,
      message: repeatedMessage,
      nodeLoopState,
      retryArtifact,
    });
  }

  if (currentAttempt >= maxAttempts) {
    const maxAttemptMessage = terminationAction === 'complete'
      ? node.label + ' reached its ' + maxAttempts + '-attempt stop rule while the Retry branch was still active, so Local AI Hub kept the latest retry artifact.'
      : node.label + ' reached its ' + maxAttempts + '-attempt safety limit while the Retry branch was still active. Adjust the loop or raise the limit before running it again.';
    return finalizeRetryLoopTermination({
      action: terminationAction,
      loopState,
      maxAttempts,
      message: maxAttemptMessage,
      nodeLoopState,
      retryArtifact,
    });
  }

  loopState.carriedArtifact = retryArtifact || null;
  loopState.lastRetryArtifactSignature = retrySignature;
  loopState.status = 'retrying';
  recordLoopHistory(loopState, {
    activeLoops: nodeLoopState.activeLoops,
    attempt: currentAttempt,
    loopMaxAttempts: maxAttempts,
    loopPathLabel: nodeLoopState.loopPathLabel,
    message: node.label + ' is starting attempt ' + (currentAttempt + 1) + ' of ' + maxAttempts + ' from ' + loopMeta.retryTargetLabel + '.',
    preview: retryArtifact ? summarizeArtifact(retryArtifact) : '',
    selectedBranch: 'retry',
    status: 'retrying',
  });
  return {
    message: node.label + ' is starting attempt ' + (currentAttempt + 1) + ' of ' + maxAttempts + ' from ' + loopMeta.retryTargetLabel + '.',
    outputs: {},
    preview: retryArtifact ? summarizeArtifact(retryArtifact) : '',
    selectedBranch: 'retry',
    loopControl: {
      action: 'retry',
      loopNodeId: node.id,
      nextAttempt: currentAttempt + 1,
      retryTargetNodeId: loopMeta.retryTargetNodeId,
    },
  };
}
function buildCollectionLineageFromEntry(entry, graph) {
  if (!entry?.edge) {
    return null;
  }

  const sourceNode = graph.nodeMap.get(entry.edge.source.nodeId) || null;
  const sourcePort = getPortDefinition(sourceNode?.type, 'output', entry.edge.source.portId) || null;
  return {
    sourceNodeId: sourceNode?.id || String(entry.edge.source.nodeId || '').trim(),
    sourceNodeLabel: sourceNode?.label || '',
    sourcePortId: String(entry.edge.source.portId || '').trim(),
    sourcePortLabel: sourcePort?.label || '',
  };
}

async function executeCollectionAccumulatorNode(node, graph, run) {
  const itemEntries = getNodeInputArtifacts(node.id, 'item', graph, run.resultsByNodeId, run);
  if (!itemEntries.length) {
    throw new Error('This accumulation step did not receive any accepted items yet. Connect one or more validation pass branches here and try again.');
  }

  const acceptedItems = itemEntries.map((entry) => {
    const itemArtifact = entry?.artifact || null;
    if (!itemArtifact) {
      return null;
    }

    if (isArtifactCollection(itemArtifact)) {
      throw new Error('This first accumulation step only accepts single artifacts from accepted branches. Feed completed collections through Collection Builder or Collection Output instead.');
    }

    const itemKind = String(itemArtifact.kind || '').trim();
    if (!itemKind) {
      throw new Error('One accepted item for this accumulation step was missing its artifact type.');
    }

    const lineage = buildCollectionLineageFromEntry(entry, graph);
    const sourceRunCount = Number(run.nodeStates?.[String(lineage?.sourceNodeId || '')]?.runCount || 0) || 0;
    return {
      artifact: itemArtifact,
      entryKey: buildCollectionAccumulatorEntryKey(itemArtifact, lineage, sourceRunCount),
      itemKind,
      lineage,
    };
  }).filter(Boolean);

  if (!acceptedItems.length) {
    throw new Error('This accumulation step did not receive any accepted items yet. Connect one or more validation pass branches here and try again.');
  }

  const accumulationMeta = graph.collectionAccumulatorsByNodeId.get(node.id) || null;
  const collectionState = run.collectionControlStates?.[node.id] || null;
  if (!accumulationMeta || !collectionState) {
    throw new Error('Local AI Hub could not prepare that accumulation step. Reopen the pipeline and try again.');
  }

  const targetCount = Number(collectionState.targetCount || accumulationMeta.targetCount || 0) || 0;
  if (!Number.isInteger(targetCount) || targetCount < 1) {
    throw new Error('Enter a whole target count of at least 1 for this accumulation step.');
  }

  const itemKind = acceptedItems[0].itemKind;
  if (collectionState.itemKind && collectionState.itemKind !== itemKind) {
    throw new Error('This accumulation step can only keep one artifact type in this pass. Keep every accepted item on the same artifact type.');
  }

  if (acceptedItems.some((entry) => entry.itemKind !== itemKind)) {
    throw new Error('This accumulation step can only keep one artifact type in this pass. Keep every accepted item on the same artifact type.');
  }

  const acceptedEntryKeys = new Set(Array.isArray(collectionState.acceptedEntryKeys) ? collectionState.acceptedEntryKeys.filter(Boolean) : []);
  const newAcceptedItems = acceptedItems.filter((entry) => !entry.entryKey || !acceptedEntryKeys.has(entry.entryKey));
  const orderedItems = [
    ...(Array.isArray(collectionState.items) ? collectionState.items : []),
    ...newAcceptedItems.map((entry) => ({
      artifact: entry.artifact,
      lineage: entry.lineage,
    })),
  ];
  const acceptedCount = orderedItems.length;
  const newAcceptedCount = newAcceptedItems.length;
  const collectionStatus = acceptedCount >= targetCount ? 'emitted' : 'collecting';
  const collectionSnapshot = createArtifactCollection(orderedItems, {
    accumulation: {
      acceptedCount,
      mode: 'until-target',
      nodeId: node.id,
      nodeLabel: node.label,
      status: collectionStatus,
      targetCount,
    },
    displayName: node.label,
    role: 'generated',
  });

  collectionState.acceptedCount = acceptedCount;
  collectionState.acceptedEntryKeys = [
    ...acceptedEntryKeys,
    ...newAcceptedItems.map((entry) => entry.entryKey).filter(Boolean),
  ];
  collectionState.collection = collectionSnapshot;
  collectionState.itemKind = collectionSnapshot.itemKind;
  collectionState.items = collectionSnapshot.items.map((entry) => ({
    artifact: entry?.artifact || null,
    itemId: String(entry?.itemId || '').trim(),
    lineage: entry?.lineage || null,
  }));
  collectionState.lastUpdatedAt = new Date().toISOString();
  collectionState.status = collectionStatus;

  if (acceptedCount >= targetCount) {
    const persistedCollection = await persistArtifactCollection(run.directories, collectionSnapshot, {
      baseName: node.label,
      displayName: node.label,
      role: 'generated',
      target: 'artifacts',
    });
    collectionState.collection = persistedCollection;
    collectionState.items = persistedCollection.items.map((entry) => ({
      artifact: entry?.artifact || null,
      itemId: String(entry?.itemId || '').trim(),
      lineage: entry?.lineage || null,
    }));
    collectionState.message = node.label + ' kept ' + newAcceptedCount + ' new accepted item' + (newAcceptedCount === 1 ? '' : 's') + ' this pass, reached ' + acceptedCount + ' of ' + targetCount + ', and emitted the ordered collection.';
    syncNodeCollectionControlState(run, node.id);
    return {
      message: collectionState.message,
      outputs: {
        collection: persistedCollection,
      },
      preview: summarizeArtifact(persistedCollection),
      selectedBranch: 'emitted',
    };
  }

  collectionState.message = node.label + ' kept ' + newAcceptedCount + ' new accepted item' + (newAcceptedCount === 1 ? '' : 's') + ' this pass and is holding ' + acceptedCount + ' of ' + targetCount + ' while the loop keeps collecting.';
  syncNodeCollectionControlState(run, node.id);
  return {
    message: collectionState.message,
    outputs: {
      collection: collectionSnapshot,
    },
    preview: summarizeArtifact(collectionSnapshot),
    selectedBranch: 'collecting',
  };
}
async function executeCollectionBuilderNode(node, graph, run) {
  const itemEntries = getNodeInputArtifacts(node.id, 'items', graph, run.resultsByNodeId, run);
  if (!itemEntries.length) {
    throw new Error('This collection builder did not receive any items yet. Connect one or more upstream items and try again.');
  }

  const existingCollection = getNodeInputArtifact(node.id, 'existing', graph, run.resultsByNodeId, run);
  if (existingCollection && !isArtifactCollection(existingCollection)) {
    throw new Error('The Existing Collection input must receive a saved collection value, not a single artifact.');
  }

  const newItems = itemEntries.map((entry) => {
    if (isArtifactCollection(entry?.artifact)) {
      throw new Error('The Items input only accepts single artifacts. Connect an existing collection through the Existing Collection port instead.');
    }

    return {
      artifact: entry.artifact,
      lineage: buildCollectionLineageFromEntry(entry, graph),
    };
  });

  const existingItems = Array.isArray(existingCollection?.items)
    ? existingCollection.items.map((entry) => ({
        artifact: entry?.artifact || null,
        itemId: String(entry?.itemId || '').trim(),
        lineage: entry?.lineage || null,
      })).filter((entry) => entry.artifact)
    : [];
  const insertionMode = String(node.config?.insertionMode || '').trim() === 'prepend' ? 'prepend' : 'append';
  const orderedNewItems = insertionMode === 'prepend' ? [...newItems].reverse() : newItems;
  const orderedItems = insertionMode === 'prepend'
    ? [...orderedNewItems, ...existingItems]
    : [...existingItems, ...orderedNewItems];

  const collection = createArtifactCollection(orderedItems, {
    displayName: node.label,
    role: 'generated',
  });
  const persistedCollection = await persistArtifactCollection(run.directories, collection, {
    baseName: node.label,
    displayName: node.label,
    role: 'generated',
    target: 'artifacts',
  });
  const actionMessage = existingItems.length
    ? insertionMode === 'prepend'
      ? 'Collection Builder placed the new items before the existing collection.'
      : 'Collection Builder appended the new items to the existing collection.'
    : 'Collection Builder created an ordered collection.';
  return {
    message: actionMessage,
    outputs: {
      collection: persistedCollection,
    },
    preview: summarizeArtifact(persistedCollection),
  };
}


function ensurePcmWaveChunk(buffer, start, size, fileLabel, chunkLabel) {
  const end = start + size;
  if (end > buffer.length) {
    throw new Error(fileLabel + ' has a damaged WAV ' + chunkLabel + ' chunk. Export it again as a standard PCM WAV and try Audio Stitch again.');
  }
  return buffer.subarray(start, end);
}

async function readPcmWaveFile(filePath, fileLabel) {
  const buffer = await fs.readFile(filePath);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(fileLabel + ' is not a readable WAV file. Audio Stitch currently expects standard PCM WAV clips.');
  }
  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunk = ensurePcmWaveChunk(buffer, chunkStart, chunkSize, fileLabel, chunkId.trim() || 'unknown');
    if (chunkId === 'fmt ') {
      if (chunk.length < 16) throw new Error(fileLabel + ' has a damaged WAV format header. Export it again as PCM WAV and try Audio Stitch again.');
      format = { audioFormat: chunk.readUInt16LE(0), channelCount: chunk.readUInt16LE(2), sampleRate: chunk.readUInt32LE(4), byteRate: chunk.readUInt32LE(8), blockAlign: chunk.readUInt16LE(12), bitsPerSample: chunk.readUInt16LE(14) };
    } else if (chunkId === 'data') {
      data = chunk;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (!format || !data) throw new Error(fileLabel + ' is missing WAV audio data. Export it again as PCM WAV and try Audio Stitch again.');
  if (format.audioFormat !== 1) throw new Error(fileLabel + ' is not PCM WAV audio. Audio Stitch currently supports uncompressed PCM WAV clips.');
  if (![8, 16, 24, 32].includes(format.bitsPerSample) || format.channelCount <= 0 || format.sampleRate <= 0 || format.blockAlign <= 0) {
    throw new Error(fileLabel + ' uses a WAV format Audio Stitch cannot safely combine yet. Export each clip as matching PCM WAV and try again.');
  }
  const frameCount = Math.floor(data.length / format.blockAlign);
  return { ...format, data, durationSeconds: frameCount / format.sampleRate, filePath };
}

function ensureMatchingWaveFormat(reference, candidate, fileLabel) {
  const mismatches = [];
  if (candidate.sampleRate !== reference.sampleRate) mismatches.push('sample rate');
  if (candidate.channelCount !== reference.channelCount) mismatches.push('channel count');
  if (candidate.bitsPerSample !== reference.bitsPerSample) mismatches.push('bit depth');
  if (candidate.blockAlign !== reference.blockAlign) mismatches.push('block alignment');
  if (mismatches.length) throw new Error(fileLabel + ' does not match the first clip ' + mismatches.join(', ') + '. Audio Stitch can combine matching PCM WAV clips; normalize the collection to one WAV format and try again.');
}

function createPcmSilence(format, seconds) {
  const durationSeconds = Math.max(0, Number(seconds || 0) || 0);
  if (durationSeconds <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(Math.round(durationSeconds * format.sampleRate) * format.blockAlign);
  if (format.bitsPerSample === 8) buffer.fill(128);
  return buffer;
}

function writePcmWaveBuffer(format, dataChunks) {
  const dataSize = dataChunks.reduce((total, chunk) => total + chunk.length, 0);
  if (dataSize > 0xffffffff - 44) throw new Error('The stitched audio is too large for a standard WAV file. Split the collection into smaller groups and stitch those results.');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channelCount, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * format.blockAlign, 28);
  header.writeUInt16LE(format.blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, ...dataChunks], 44 + dataSize);
}

async function createAudioStitchOutputPath(runDirectories, node) {
  const baseName = sanitizeSegment(node.label || 'stitched-audio', 'stitched-audio');
  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? '' : '-' + String(attempt + 1);
    const outputPath = path.join(runDirectories.artifactsDir, baseName + suffix + '.wav');
    if (!(await fs.pathExists(outputPath))) return outputPath;
    attempt += 1;
  }
}

function firstNonEmptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function formatFfmpegConcatPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/'/g, "'\\''");
}

async function createVideoStitchOutputPath(runDirectories, node) {
  const baseName = sanitizeSegment(node.label || 'stitched-video', 'stitched-video');
  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? '' : '-' + String(attempt + 1);
    const outputPath = path.join(runDirectories.artifactsDir, baseName + suffix + '.mp4');
    if (!(await fs.pathExists(outputPath))) return outputPath;
    attempt += 1;
  }
}

function getVideoMetric(artifact, key) {
  if (!artifact || typeof artifact !== 'object') return null;
  const generation = artifact.videoGeneration && typeof artifact.videoGeneration === 'object' ? artifact.videoGeneration : null;
  const direct = artifact.video && typeof artifact.video === 'object' ? artifact.video : null;
  const value = generation?.[key] ?? direct?.[key] ?? artifact[key];
  if (key === 'fps' || key === 'durationSeconds') {
    const numeric = Number(value || 0) || 0;
    return numeric > 0 ? numeric : null;
  }
  return String(value || '').trim() || null;
}

function buildVideoStitchSourceReference(entry, artifact, sourcePath, index) {
  const generation = artifact.videoGeneration && typeof artifact.videoGeneration === 'object' ? artifact.videoGeneration : null;
  return {
    artifactPath: sourcePath,
    displayName: String(artifact.displayName || artifact.fileName || 'Video collection item ' + String(index + 1)).trim(),
    durationSeconds: getVideoMetric(artifact, 'durationSeconds'),
    fileName: String(artifact.fileName || path.basename(sourcePath)).trim(),
    fps: getVideoMetric(artifact, 'fps'),
    index: Number(entry.index || index) || index,
    itemId: String(entry.itemId || '').trim(),
    metadataPaths: Array.isArray(artifact.metadataPaths) ? artifact.metadataPaths : [],
    operationSubtype: String(generation?.operationSubtype || generation?.mode || '').trim(),
    prompt: String(generation?.prompt || '').trim(),
    promptStyle: generation?.promptStyle || null,
    size: getVideoMetric(artifact, 'size'),
    summary: String(entry.summary || artifact.summary || '').trim(),
    toolId: String(generation?.toolId || '').trim(),
    toolLabel: String(generation?.toolLabel || generation?.backendLabel || '').trim(),
    videoChain: generation?.collectionMapVideoChain || null,
  };
}

function ensureCompatibleVideoClip(reference, candidate, itemLabel) {
  const mismatches = [];
  const refExtension = String(path.extname(reference.artifactPath || '') || '').toLowerCase();
  const candidateExtension = String(path.extname(candidate.artifactPath || '') || '').toLowerCase();
  if (candidateExtension !== '.mp4') mismatches.push('MP4 container');
  if (refExtension && candidateExtension && candidateExtension !== refExtension) mismatches.push('container extension');
  if (reference.size && candidate.size && reference.size !== candidate.size) mismatches.push('frame size');
  if (reference.fps && candidate.fps && Number(reference.fps) !== Number(candidate.fps)) mismatches.push('fps');
  if (mismatches.length) {
    throw new Error(itemLabel + ' is not concat-compatible with the first clip (' + mismatches.join(', ') + '). Video Stitch currently stream-copies matching MP4 clips only; regenerate or normalize the collection before stitching.');
  }
}

async function writeVideoConcatManifest(directoryPath, sourceItems) {
  const manifestPath = path.join(directoryPath, 'video-stitch.ffconcat');
  const lines = ['ffconcat version 1.0'];
  for (const item of sourceItems) {
    lines.push("file '" + formatFfmpegConcatPath(item.artifactPath) + "'");
  }
  await fs.writeFile(manifestPath, lines.join('\n') + '\n', 'utf8');
  return manifestPath;
}

async function executeVideoStitchNode(node, graph, run) {
  const sourceCollection = getNodeInputArtifact(node.id, 'collection', graph, run.resultsByNodeId, run);
  if (!isArtifactCollection(sourceCollection)) throw new Error('Video Stitch needs an ordered video collection before it can create one MP4 file.');
  if (String(sourceCollection.itemKind || '').trim() !== PORT_KIND_VIDEO) throw new Error('Video Stitch only accepts ordered video collections. Connect collection:video to this node.');
  const orderedEntries = (Array.isArray(sourceCollection.items) ? sourceCollection.items : []).filter((entry) => entry?.artifact).sort((left, right) => (Number(left.index || 0) || 0) - (Number(right.index || 0) || 0));
  if (!orderedEntries.length) throw new Error('Video Stitch received an empty video collection. Generate or select at least one video clip before stitching.');
  const sourceItems = [];
  let referenceItem = null;
  let totalDurationSeconds = 0;
  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    const artifact = entry.artifact || null;
    const itemLabel = 'Video collection item ' + String(index + 1);
    if (String(artifact?.kind || '').trim() !== PORT_KIND_VIDEO) throw new Error(itemLabel + ' is not a video artifact. Video Stitch can only combine collection:video items.');
    const rawPath = String(artifact.filePath || '').trim();
    if (!rawPath) throw new Error(itemLabel + ' is missing a video file path. Regenerate that item or choose the file again before stitching.');
    const sourcePath = path.resolve(rawPath);
    if (!(await fs.pathExists(sourcePath))) throw new Error(itemLabel + ' points to a video file Local AI Hub cannot find. Regenerate that item or choose the file again before stitching.');
    if (String(path.extname(sourcePath) || '').toLowerCase() !== '.mp4') {
      throw new Error(itemLabel + ' is not an MP4 file. Video Stitch currently uses ffmpeg concat stream-copy for matching MP4 clips only.');
    }
    const sourceRef = buildVideoStitchSourceReference(entry, artifact, sourcePath, index);
    if (!referenceItem) referenceItem = sourceRef;
    else ensureCompatibleVideoClip(referenceItem, sourceRef, itemLabel);
    const durationSeconds = Number(sourceRef.durationSeconds || 0) || 0;
    if (durationSeconds > 0) totalDurationSeconds += durationSeconds;
    sourceItems.push(sourceRef);
  }

  const outputPath = await createVideoStitchOutputPath(run.directories, node);
  const manifestPath = await writeVideoConcatManifest(run.directories.artifactsDir, sourceItems);
  const ffmpegPath = resolveFfmpegPath();
  const commandResult = await runCommand(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', manifestPath, '-c', 'copy', '-movflags', '+faststart', outputPath], { allowFailure: true });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error('Video Stitch could not concatenate these clips with ffmpeg stream-copy concat. In this pass, clips need matching MP4 container, codec, resolution, and fps. ' + (failureLine || 'Normalize the clips and try again.'));
  }

  const roundedTotalDuration = totalDurationSeconds > 0 ? Math.round(totalDurationSeconds * 100) / 100 : null;
  const videoStitch = {
    concatManifestPath: manifestPath,
    concatMode: 'ffmpeg-concat-demuxer',
    createdBy: { nodeId: String(node.id || '').trim(), nodeLabel: String(node.label || '').trim(), nodeType: String(node.type || 'videoStitch').trim() },
    ffmpegMode: 'stream-copy',
    operationId: 'videoStitch',
    outputFormat: 'mp4',
    sourceCollection: { directoryPath: String(sourceCollection.directoryPath || '').trim(), displayName: String(sourceCollection.displayName || '').trim(), itemCount: Number(sourceCollection.itemCount || orderedEntries.length) || orderedEntries.length, itemKind: String(sourceCollection.itemKind || PORT_KIND_VIDEO).trim() || PORT_KIND_VIDEO, manifestPath: String(sourceCollection.manifestPath || '').trim(), summary: String(sourceCollection.summary || '').trim() },
    sourceItemCount: sourceItems.length,
    sourceItems,
    totalDurationSeconds: roundedTotalDuration,
  };
  const artifact = await buildFileArtifact(outputPath, { displayName: node.label || 'Stitched video', kind: PORT_KIND_VIDEO, role: 'generated', videoStitch });
  const metadataPaths = await saveVideoArtifactMetadata(outputPath, artifact);
  if (metadataPaths.length) artifact.metadataPaths = metadataPaths;
  artifact.summary = summarizeArtifact(artifact);
  return { destinationPath: outputPath, message: 'Video Stitch combined ' + sourceItems.length + ' video clip' + (sourceItems.length === 1 ? '' : 's') + ' into one MP4 file.', outputs: { video: artifact }, preview: summarizeArtifact(artifact) };
}
async function executeAudioStitchNode(node, graph, run) {
  const sourceCollection = getNodeInputArtifact(node.id, 'collection', graph, run.resultsByNodeId, run);
  if (!isArtifactCollection(sourceCollection)) throw new Error('Audio Stitch needs an ordered audio collection before it can create one WAV file.');
  if (String(sourceCollection.itemKind || '').trim() !== PORT_KIND_AUDIO) throw new Error('Audio Stitch only accepts ordered audio collections. Connect collection:audio to this node.');
  const orderedEntries = (Array.isArray(sourceCollection.items) ? sourceCollection.items : []).filter((entry) => entry?.artifact).sort((left, right) => (Number(left.index || 0) || 0) - (Number(right.index || 0) || 0));
  if (!orderedEntries.length) throw new Error('Audio Stitch received an empty audio collection. Add at least one generated or selected audio clip before stitching.');
  const gapSeconds = Math.max(0, Number(node.config?.gapSeconds || 0) || 0);
  const dataChunks = [];
  const sourceItems = [];
  let referenceFormat = null;
  let totalDurationSeconds = 0;
  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    const artifact = entry.artifact || null;
    const itemLabel = 'Audio collection item ' + String(index + 1);
    if (String(artifact?.kind || '').trim() !== PORT_KIND_AUDIO) throw new Error(itemLabel + ' is not an audio artifact. Audio Stitch can only combine collection:audio items.');
    const sourcePath = path.resolve(String(artifact.filePath || '').trim());
    if (!sourcePath || !(await fs.pathExists(sourcePath))) throw new Error(itemLabel + ' points to an audio file Local AI Hub cannot find. Regenerate that item or choose the file again before stitching.');
    const wave = await readPcmWaveFile(sourcePath, itemLabel);
    if (!referenceFormat) referenceFormat = wave;
    else ensureMatchingWaveFormat(referenceFormat, wave, itemLabel);
    if (index > 0 && gapSeconds > 0) {
      const silence = createPcmSilence(referenceFormat, gapSeconds);
      dataChunks.push(silence);
      totalDurationSeconds += silence.length / referenceFormat.blockAlign / referenceFormat.sampleRate;
    }
    dataChunks.push(wave.data);
    totalDurationSeconds += wave.durationSeconds;
    sourceItems.push({ artifactPath: sourcePath, bitDepth: wave.bitsPerSample, channelCount: wave.channelCount, displayName: String(artifact.displayName || artifact.fileName || itemLabel).trim(), durationSeconds: Math.round(wave.durationSeconds * 100) / 100, fileName: String(artifact.fileName || path.basename(sourcePath)).trim(), index: Number(entry.index || index) || index, itemId: String(entry.itemId || '').trim(), metadataPaths: Array.isArray(artifact.metadataPaths) ? artifact.metadataPaths : [], sampleRate: wave.sampleRate, summary: String(entry.summary || artifact.summary || '').trim() });
  }
  const outputPath = await createAudioStitchOutputPath(run.directories, node);
  await fs.writeFile(outputPath, writePcmWaveBuffer(referenceFormat, dataChunks));
  const roundedTotalDuration = Math.round(totalDurationSeconds * 100) / 100;
  const audioStitch = { createdBy: { nodeId: String(node.id || '').trim(), nodeLabel: String(node.label || '').trim(), nodeType: String(node.type || 'audioStitch').trim() }, crossfadeSeconds: 0, gapSeconds, outputFormat: 'wav', sourceCollection: { directoryPath: String(sourceCollection.directoryPath || '').trim(), displayName: String(sourceCollection.displayName || '').trim(), itemCount: Number(sourceCollection.itemCount || orderedEntries.length) || orderedEntries.length, itemKind: String(sourceCollection.itemKind || PORT_KIND_AUDIO).trim() || PORT_KIND_AUDIO, manifestPath: String(sourceCollection.manifestPath || '').trim(), summary: String(sourceCollection.summary || '').trim() }, sourceItemCount: sourceItems.length, sourceItems, totalDurationSeconds: roundedTotalDuration };
  const artifact = await buildFileArtifact(outputPath, { audio: { bitDepth: referenceFormat.bitsPerSample, channelCount: referenceFormat.channelCount, durationSeconds: roundedTotalDuration, sampleRate: referenceFormat.sampleRate }, audioStitch, displayName: node.label || 'Stitched audio', kind: PORT_KIND_AUDIO, role: 'generated' });
  const metadataPaths = await saveAudioArtifactMetadata(outputPath, artifact);
  if (metadataPaths.length) artifact.metadataPaths = metadataPaths;
  artifact.summary = summarizeArtifact(artifact);
  return { destinationPath: outputPath, message: 'Audio Stitch combined ' + sourceItems.length + ' audio clip' + (sourceItems.length === 1 ? '' : 's') + ' into one WAV file.', outputs: { audio: artifact }, preview: summarizeArtifact(artifact) };
}

async function executeExtractVideoFrameNode(node, graph, run, reportProgress) {
  const sourceVideo = getNodeInputArtifact(node.id, 'video', graph, run.resultsByNodeId, run);
  return extractVideoFrameArtifact(sourceVideo, {
    displayName: node.label || 'Extracted video frame',
    framePosition: node.config?.framePosition || 'first',
    node,
    outputFormat: node.config?.outputFormat || 'png',
    timestampSeconds: node.config?.timestampSeconds || 0,
    reportProgress,
    runDirectories: run.directories,
  });
}

async function executeExtractAudioNode(node, graph, run, reportProgress) {
  const sourceVideo = getNodeInputArtifact(node.id, 'video', graph, run.resultsByNodeId, run);
  return extractAudioFromVideoArtifact(sourceVideo, {
    displayName: node.label || 'Extracted audio',
    node,
    outputFormat: node.config?.outputFormat || 'auto',
    reportProgress,
    runDirectories: run.directories,
  });
}

async function executeNormalizeAudioCollectionNode(node, graph, run, reportProgress) {
  const sourceCollection = getNodeInputArtifact(node.id, 'collection', graph, run.resultsByNodeId, run);
  return normalizeAudioCollectionArtifact(sourceCollection, {
    channels: node.config?.channels || 'stereo',
    displayName: node.label || 'Normalize Audio',
    node,
    outputFormat: node.config?.outputFormat || 'wav',
    pcmFormat: node.config?.pcmFormat || 'pcm_s16le',
    reportProgress,
    runDirectories: run.directories,
    sampleRate: node.config?.sampleRate || 44100,
    cancelSignal: activeRunAbortController?.signal || null,
  });
}

async function executeNormalizeVideoCollectionNode(node, graph, run, reportProgress) {
  const sourceCollection = getNodeInputArtifact(node.id, 'collection', graph, run.resultsByNodeId, run);
  return normalizeVideoCollectionArtifact(sourceCollection, {
    audioCodec: node.config?.audioCodec || 'aac',
    displayName: node.label || 'Normalize Video',
    fps: node.config?.fps || 30,
    height: node.config?.height || 720,
    node,
    outputFormat: node.config?.outputFormat || 'auto',
    pixelFormat: node.config?.pixelFormat || 'yuv420p',
    reportProgress,
    runDirectories: run.directories,
    sizeMode: node.config?.sizeMode || 'matchFirst',
    cancelSignal: activeRunAbortController?.signal || null,
    videoCodec: node.config?.videoCodec || 'libx264',
    width: node.config?.width || 1280,
  });
}

async function executeNormalizeImageNode(node, graph, run, reportProgress) {
  const sourceImage = getNodeInputArtifact(node.id, 'image', graph, run.resultsByNodeId, run);
  return normalizeImageArtifact(sourceImage, {
    cancelSignal: activeRunAbortController?.signal || null,
    displayName: node.label || 'Normalize Image',
    node,
    outputFormat: node.config?.outputFormat || 'png',
    reportProgress,
    runDirectories: run.directories,
  });
}

async function executeTrimMediaNode(node, graph, run, reportProgress) {
  const mediaArtifact = getNodeInputArtifact(node.id, 'media', graph, run.resultsByNodeId, run);
  return trimMediaArtifact(mediaArtifact, {
    displayName: node.label || 'Trim Media',
    durationSeconds: node.config?.durationSeconds || 5,
    endSeconds: node.config?.endSeconds || 5,
    mode: node.config?.mode || 'duration',
    node,
    reportProgress,
    runDirectories: run.directories,
    startSeconds: node.config?.startSeconds || 0,
  });
}

function resolveBurnSubtitlesVideoInputForRun(node, graph, run) {
  const retryAwareEntries = getNodeInputArtifacts(node.id, 'video', graph, run.resultsByNodeId, run);
  const loopRetryEntry = retryAwareEntries.find((entry) => entry?.isLoopRetry && entry.artifact) || null;
  if (!loopRetryEntry) {
    return {
      artifact: retryAwareEntries[0]?.artifact || null,
      sourceVideoLineage: {
        ignoredLoopRetryVideo: false,
        inputResolution: 'connected-input',
        retryAttempt: 1,
        usedOriginalSourceVideo: true,
      },
    };
  }

  const connectedEntries = getNodeInputArtifacts(node.id, 'video', graph, run.resultsByNodeId, null);
  const connectedEntry = connectedEntries[0] || null;
  if (!connectedEntry?.artifact) {
    return {
      artifact: loopRetryEntry.artifact,
      sourceVideoLineage: {
        ignoredLoopRetryVideo: false,
        inputResolution: 'loop-retry-artifact-fallback',
        loopNodeId: String(loopRetryEntry.loopMeta?.loopNodeId || '').trim(),
        retryAttempt: Number(loopRetryEntry.loopState?.attempt || 1) || 1,
        usedOriginalSourceVideo: false,
      },
    };
  }

  return {
    artifact: connectedEntry.artifact,
    sourceVideoLineage: {
      ignoredLoopRetryVideo: true,
      inputResolution: 'connected-input-for-retry',
      loopNodeId: String(loopRetryEntry.loopMeta?.loopNodeId || '').trim(),
      loopRetryVideoPath: String(loopRetryEntry.artifact?.filePath || '').trim(),
      retryAttempt: Number(loopRetryEntry.loopState?.attempt || 1) || 1,
      usedOriginalSourceVideo: true,
    },
  };
}

async function executeBurnSubtitlesNode(node, graph, run, reportProgress) {
  const effectiveConfig = getBurnSubtitlesEffectiveConfig(node, run);
  const videoInput = resolveBurnSubtitlesVideoInputForRun(node, graph, run);
  const videoArtifact = videoInput.artifact;
  const captionArtifact = getNodeInputArtifact(node.id, 'captions', graph, run.resultsByNodeId, run);
  return burnSubtitlesIntoVideoArtifact(videoArtifact, captionArtifact, {
    captionMode: effectiveConfig.captionMode || 'auto',
    displayName: node.label || 'Burn Subtitles / Captions',
    durationPerCaptionSeconds: effectiveConfig.durationPerCaptionSeconds || 3,
    fontSize: effectiveConfig.fontSize || 28,
    outline: effectiveConfig.outline ?? 2,
    shadow: effectiveConfig.shadow ?? 1,
    bottomMargin: effectiveConfig.bottomMargin ?? 32,
    textColor: effectiveConfig.textColor || 'white',
    outlineColor: effectiveConfig.outlineColor || 'black',
    backgroundColor: effectiveConfig.backgroundColor || 'black',
    fontPreset: effectiveConfig.fontPreset || 'arial',
    fontSource: effectiveConfig.fontSource || 'preset',
    fontLibraryId: effectiveConfig.fontLibraryId || '',
    fontItemId: effectiveConfig.fontItemId || '',
    colorSource: effectiveConfig.colorSource || 'manual',
    colorPaletteLibraryId: effectiveConfig.colorPaletteLibraryId || '',
    textColorPaletteItemId: effectiveConfig.textColorPaletteItemId || '',
    outlineColorPaletteItemId: effectiveConfig.outlineColorPaletteItemId || '',
    backgroundColorPaletteItemId: effectiveConfig.backgroundColorPaletteItemId || '',
    bold: effectiveConfig.bold || false,
    italic: effectiveConfig.italic || false,
    position: effectiveConfig.position || 'bottomCenter',
    backgroundBox: effectiveConfig.backgroundBox || false,
    backgroundOpacity: effectiveConfig.backgroundOpacity ?? 50,
    node,
    outputFormat: effectiveConfig.outputFormat || 'mp4',
    reportProgress,
    retryOverride: buildBurnSubtitlesRetryOverrideConfig(run?.retryOverridesByNodeId?.[node.id]?.burnSubtitles),
    sourceVideoLineage: videoInput.sourceVideoLineage,
    runDirectories: run.directories,
  });
}

async function executeExportSubtitlesNode(node, graph, run, reportProgress) {
  const captionArtifact = getNodeInputArtifact(node.id, 'captions', graph, run.resultsByNodeId, run);
  return exportSubtitlesArtifact(captionArtifact, {
    captionMode: node.config?.captionMode || 'auto',
    displayName: node.label || 'Export Subtitles',
    durationPerCaptionSeconds: node.config?.durationPerCaptionSeconds || 3,
    node,
    outputFormat: node.config?.outputFormat || 'srt',
    reportProgress,
    runDirectories: run.directories,
  });
}

function normalizeMediaCompositionImageTimingMode(value) {
  const mode = String(value || '').trim();
  if (mode === 'dynamicFromImageMetadata' || mode === 'matchNarrationTiming') {
    return 'dynamicFromImageMetadata';
  }
  return 'fixedDurationPerImage';
}

function normalizeMediaCompositionTransitionMode(value) {
  const mode = String(value || '').trim();
  return Object.values(MEDIA_COMPOSITION_TRANSITION_MODES).includes(mode) ? mode : MEDIA_COMPOSITION_TRANSITION_MODES.OFF;
}

function normalizeMediaCompositionTransitionDuration(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0.5;
  }
  return normalizeTimelineSeconds(Math.max(0.1, Math.min(2, numeric))) || 0.5;
}

function normalizeMediaCompositionTransitionName(value, fallback = 'fade') {
  const name = String(value || '').trim();
  return MEDIA_COMPOSITION_XFADE_TRANSITION_SET.has(name) ? name : fallback;
}

function normalizeMediaCompositionTransitionCategory(value) {
  const categoryId = String(value || '').trim();
  return MEDIA_COMPOSITION_TRANSITION_CATEGORY_BY_ID.has(categoryId) ? categoryId : 'fades';
}

function normalizeMediaCompositionSelectedTransitions(value) {
  const selected = Array.isArray(value) ? value : [];
  const normalized = [];
  for (const entry of selected) {
    const name = String(entry || '').trim();
    if (MEDIA_COMPOSITION_XFADE_TRANSITION_SET.has(name) && !normalized.includes(name)) {
      normalized.push(name);
    }
  }
  return normalized.length ? normalized : ['fade', 'dissolve'];
}

function getMediaCompositionTransitionConfig(config = {}) {
  const mode = normalizeMediaCompositionTransitionMode(config.sceneTransitionMode);
  return {
    avoidRepeats: config.sceneTransitionAvoidRepeats !== false,
    category: normalizeMediaCompositionTransitionCategory(config.sceneTransitionCategory),
    configuredDurationSeconds: normalizeMediaCompositionTransitionDuration(config.sceneTransitionDurationSeconds),
    mode,
    selectedTransitions: normalizeMediaCompositionSelectedTransitions(config.sceneTransitionSelected),
    singleTransition: normalizeMediaCompositionTransitionName(config.sceneTransitionName),
  };
}

function hashMediaCompositionTransitionSeed(seedParts) {
  return crypto.createHash('sha256').update(seedParts.map((part) => String(part || '')).join('|')).digest('hex');
}

function selectDeterministicTransition(candidates, seed, boundaryIndex, previousTransition, avoidRepeats) {
  const options = candidates.filter((name) => MEDIA_COMPOSITION_XFADE_TRANSITION_SET.has(name));
  if (!options.length) {
    return 'fade';
  }
  const digest = hashMediaCompositionTransitionSeed([seed, boundaryIndex, options.join(',')]);
  let selected = options[parseInt(digest.slice(0, 8), 16) % options.length];
  if (avoidRepeats && previousTransition && options.length > 1 && selected === previousTransition) {
    const currentIndex = options.indexOf(selected);
    selected = options[(currentIndex + 1) % options.length];
  }
  return selected;
}

function getTransitionCandidatesForBoundary(transitionConfig) {
  if (transitionConfig.mode === MEDIA_COMPOSITION_TRANSITION_MODES.SINGLE) {
    return [transitionConfig.singleTransition];
  }
  if (transitionConfig.mode === MEDIA_COMPOSITION_TRANSITION_MODES.RANDOM_CATEGORY) {
    return [...(MEDIA_COMPOSITION_TRANSITION_CATEGORY_BY_ID.get(transitionConfig.category)?.transitions || ['fade'])];
  }
  if (transitionConfig.mode === MEDIA_COMPOSITION_TRANSITION_MODES.RANDOM_SELECTED) {
    return transitionConfig.selectedTransitions;
  }
  return [];
}

function normalizeMediaCompositionSoundEffectsMode(value) {
  const mode = String(value || '').trim();
  return Object.values(MEDIA_COMPOSITION_SOUND_EFFECTS_SCHEDULING_MODES).includes(mode)
    ? mode
    : MEDIA_COMPOSITION_SOUND_EFFECTS_SCHEDULING_MODES.RANDOM_INTERVAL;
}

function normalizeMediaCompositionSoundEffectsDensity(value) {
  const density = String(value || '').trim();
  return MEDIA_COMPOSITION_SOUND_EFFECTS_DENSITIES.includes(density) ? density : 'normal';
}

function normalizeMediaCompositionSoundEffectsLayer(layer = {}, index = 0, fallback = {}) {
  const source = layer && typeof layer === 'object' ? layer : {};
  const fallbackSource = fallback && typeof fallback === 'object' ? fallback : {};
  const layerIndex = Math.max(0, Number(index || 0) || 0);
  return {
    avoidRepeats: source.avoidRepeats !== undefined ? source.avoidRepeats !== false : fallbackSource.soundEffectsAvoidRepeats !== false,
    density: normalizeMediaCompositionSoundEffectsDensity(source.density ?? fallbackSource.soundEffectsDensity),
    enabled: source.enabled !== false,
    fadeSeconds: Math.max(0, Math.min(2, Number(source.fadeSeconds ?? fallbackSource.soundEffectsFadeSeconds ?? 0.05) || 0)),
    id: String(source.id || `sfx-layer-${layerIndex + 1}`).trim() || `sfx-layer-${layerIndex + 1}`,
    index: layerIndex,
    libraryId: String(source.libraryId ?? fallbackSource.soundEffectsLibraryId ?? '').trim(),
    maxSimultaneous: Math.max(1, Math.min(8, Math.floor(Number(source.maxSimultaneous ?? fallbackSource.soundEffectsMaxSimultaneous ?? 2) || 2))),
    minSpacingSeconds: normalizeTimelineSeconds(Math.max(0, Number(source.minSpacingSeconds ?? fallbackSource.soundEffectsMinSpacingSeconds ?? 4) || 0)) ?? 4,
    mode: normalizeMediaCompositionSoundEffectsMode(source.schedulingMode ?? source.mode ?? fallbackSource.soundEffectsSchedulingMode),
    name: String(source.name || `Layer ${layerIndex + 1}`).trim() || `Layer ${layerIndex + 1}`,
    seed: String(source.seed ?? fallbackSource.soundEffectsSeed ?? '').trim(),
    volume: normalizeMediaCompositionVolume(source.volume ?? fallbackSource.soundEffectsVolume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME),
  };
}

function getMediaCompositionSoundEffectsLayers(config = {}) {
  const nested = config.soundEffects && typeof config.soundEffects === 'object' ? config.soundEffects : null;
  const rawLayers = Array.isArray(config.soundEffectsLayers)
    ? config.soundEffectsLayers
    : Array.isArray(nested?.layers)
      ? nested.layers
      : [];
  if (rawLayers.length) {
    return rawLayers.map((layer, index) => normalizeMediaCompositionSoundEffectsLayer(layer, index, config)).filter((layer) => layer.enabled !== false);
  }
  const legacyLibraryId = String(config.soundEffectsLibraryId || nested?.libraryId || '').trim();
  if (config.soundEffectsEnabled === true || nested?.enabled === true || legacyLibraryId) {
    return [normalizeMediaCompositionSoundEffectsLayer({
      avoidRepeats: config.soundEffectsAvoidRepeats,
      density: config.soundEffectsDensity,
      fadeSeconds: config.soundEffectsFadeSeconds,
      libraryId: legacyLibraryId,
      maxSimultaneous: config.soundEffectsMaxSimultaneous,
      minSpacingSeconds: config.soundEffectsMinSpacingSeconds,
      name: 'Layer 1',
      schedulingMode: config.soundEffectsSchedulingMode || nested?.schedulingMode,
      seed: config.soundEffectsSeed,
      volume: config.soundEffectsVolume,
    }, 0, config)];
  }
  return [];
}

function normalizeMediaCompositionSoundEffectsConfig(config = {}) {
  const enabled = config.soundEffectsEnabled === true || config.soundEffects?.enabled === true;
  const layers = enabled ? getMediaCompositionSoundEffectsLayers(config) : [];
  const nestedGlobalGuard = config.soundEffects?.globalGuard && typeof config.soundEffects.globalGuard === 'object'
    ? config.soundEffects.globalGuard
    : {};
  const globalGuardEnabled = config.soundEffectsGlobalGuardEnabled === true
    || config.enableGlobalSoundEffectSpacing === true
    || nestedGlobalGuard.enabled === true;
  return {
    enabled,
    globalGuard: {
      enabled: globalGuardEnabled,
      maxSimultaneous: Math.max(1, Math.min(8, Math.floor(Number(
        config.soundEffectsGlobalMaxSimultaneous
        ?? nestedGlobalGuard.maxSimultaneous
        ?? DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS,
      ) || DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS))),
      minSpacingSeconds: normalizeTimelineSeconds(Math.max(0, Number(
        config.soundEffectsGlobalMinSpacingSeconds
        ?? nestedGlobalGuard.minSpacingSeconds
        ?? DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS,
      ) || 0)) ?? DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS,
    },
    layers,
    globalVolume: normalizeMediaCompositionVolume(config.soundEffectsGlobalVolume ?? config.soundEffects?.globalVolume, 1),
    legacy: {
      avoidRepeats: config.soundEffectsAvoidRepeats !== false,
      density: normalizeMediaCompositionSoundEffectsDensity(config.soundEffectsDensity),
      fadeSeconds: Math.max(0, Math.min(2, Number(config.soundEffectsFadeSeconds ?? 0.05) || 0)),
      libraryId: String(config.soundEffectsLibraryId || '').trim(),
      maxSimultaneous: Math.max(1, Math.min(8, Math.floor(Number(config.soundEffectsMaxSimultaneous ?? 2) || 2))),
      minSpacingSeconds: normalizeTimelineSeconds(Math.max(0, Number(config.soundEffectsMinSpacingSeconds ?? 4) || 0)) ?? 4,
      mode: normalizeMediaCompositionSoundEffectsMode(config.soundEffectsSchedulingMode),
      seed: String(config.soundEffectsSeed || '').trim(),
      volume: normalizeMediaCompositionVolume(config.soundEffectsVolume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME),
    },
  };
}

function deterministicFloat(seedParts) {
  const digest = hashMediaCompositionTransitionSeed(seedParts);
  return parseInt(digest.slice(0, 8), 16) / 0xffffffff;
}

function getSoundEffectDensityIntervalSeconds(density) {
  if (density === 'dense') {
    return 7;
  }
  if (density === 'sparse') {
    return 18;
  }
  return 11;
}

function getSceneBoundarySeconds(visualItems) {
  const boundaries = [];
  let cursorSeconds = 0;
  for (let index = 0; index < visualItems.length - 1; index += 1) {
    const item = visualItems[index];
    const nextItem = visualItems[index + 1];
    const boundarySeconds = Number.isFinite(Number(item?.endSeconds))
      ? Number(item.endSeconds)
      : cursorSeconds + (Number(item?.durationSeconds || 0) || 0);
    cursorSeconds = boundarySeconds;
    if (boundarySeconds > 0.05 && Number(nextItem?.durationSeconds || 0) >= 0.35) {
      boundaries.push({ boundaryIndex: index, boundarySeconds: normalizeTimelineSeconds(boundarySeconds) || boundarySeconds });
    }
  }
  return boundaries;
}

function canPlaceSoundEffectEvent(events, timeSeconds, itemId, layerConfig) {
  const minSpacingSeconds = Math.max(0, Number(layerConfig.minSpacingSeconds || 0) || 0);
  if (events.some((event) => Math.abs(Number(event.timeSeconds || 0) - timeSeconds) < minSpacingSeconds - 0.001)) {
    return false;
  }
  if (layerConfig.avoidRepeats) {
    const ordered = [...events, { itemId, timeSeconds }].sort((left, right) => Number(left.timeSeconds || 0) - Number(right.timeSeconds || 0));
    const candidateIndex = ordered.findIndex((event) => event.itemId === itemId && Number(event.timeSeconds || 0) === timeSeconds);
    const previous = candidateIndex > 0 ? ordered[candidateIndex - 1] : null;
    const next = candidateIndex >= 0 && candidateIndex < ordered.length - 1 ? ordered[candidateIndex + 1] : null;
    if (previous?.itemId === itemId || next?.itemId === itemId) {
      return false;
    }
  }
  const sameTimeCount = events.filter((event) => Math.abs(Number(event.timeSeconds || 0) - timeSeconds) < 0.5).length;
  return sameTimeCount < layerConfig.maxSimultaneous;
}

function createSoundEffectEvent(item, library, timeSeconds, mode, layerConfig, notes = []) {
  const durationSeconds = Number(item.durationSeconds || 0) > 0 ? normalizeTimelineSeconds(item.durationSeconds) : null;
  return {
    durationSeconds,
    fadeSeconds: layerConfig.fadeSeconds,
    itemId: item.id,
    itemName: item.displayName || item.originalFilename || item.id,
    layerId: layerConfig.id,
    layerIndex: layerConfig.index,
    layerName: layerConfig.name,
    libraryId: library.id,
    libraryName: library.name,
    reason: mode,
    sourceLibrary: library.name,
    timeSeconds: normalizeTimelineSeconds(timeSeconds) || 0,
    volume: layerConfig.volume,
    ...(notes.length ? { notes } : {}),
  };
}

function addSoundEffectEvent(events, item, library, timeSeconds, mode, layerConfig, notes = []) {
  if (!item || !Number.isFinite(Number(timeSeconds))) {
    return false;
  }
  const normalizedTime = normalizeTimelineSeconds(Math.max(0, Number(timeSeconds) || 0)) || 0;
  if (!canPlaceSoundEffectEvent(events, normalizedTime, item.id, layerConfig)) {
    return false;
  }
  events.push(createSoundEffectEvent(item, library, normalizedTime, mode, layerConfig, notes));
  events.sort((left, right) => Number(left.timeSeconds || 0) - Number(right.timeSeconds || 0));
  return true;
}

function addDeterministicSoundEffectEvent(events, items, library, timeSeconds, mode, layerConfig, seedParts, notes = []) {
  if (!Array.isArray(items) || !items.length) {
    return null;
  }
  const startIndex = Math.floor(deterministicFloat(seedParts) * items.length) % items.length;
  for (let offset = 0; offset < items.length; offset += 1) {
    const item = items[(startIndex + offset) % items.length];
    if (addSoundEffectEvent(events, item, library, timeSeconds, mode, layerConfig, notes)) {
      return item;
    }
  }
  return null;
}

function getSoundEffectEventPriority(event) {
  return String(event?.reason || '').trim() === 'sceneAligned' ? 2 : 1;
}

function getSoundEffectEventDurationSeconds(event) {
  return Math.max(0.05, Number(event?.durationSeconds || 0) || 0.5);
}

function doSoundEffectEventsOverlap(left, right) {
  const leftStart = Number(left?.timeSeconds || 0) || 0;
  const rightStart = Number(right?.timeSeconds || 0) || 0;
  const leftEnd = leftStart + getSoundEffectEventDurationSeconds(left);
  const rightEnd = rightStart + getSoundEffectEventDurationSeconds(right);
  return leftStart < rightEnd - 0.001 && rightStart < leftEnd - 0.001;
}

function canPlaceGlobalSoundEffectEvent(events, candidate, timeSeconds, globalGuard) {
  if (!globalGuard?.enabled) {
    return true;
  }
  const normalizedTime = normalizeTimelineSeconds(Math.max(0, Number(timeSeconds || 0) || 0)) || 0;
  const candidateAtTime = { ...candidate, timeSeconds: normalizedTime };
  const minSpacingSeconds = Math.max(0, Number(globalGuard.minSpacingSeconds || 0) || 0);
  if (minSpacingSeconds > 0 && events.some((event) => Math.abs(Number(event.timeSeconds || 0) - normalizedTime) < minSpacingSeconds - 0.001)) {
    return false;
  }
  const maxSimultaneous = Math.max(1, Math.floor(Number(globalGuard.maxSimultaneous || 1) || 1));
  const overlappingCount = events.filter((event) => doSoundEffectEventsOverlap(event, candidateAtTime)).length;
  return overlappingCount < maxSimultaneous;
}

function findNearestGlobalSoundEffectSlot(candidate, placedEvents, globalGuard, totalDurationSeconds) {
  const safeEndSeconds = Math.max(0.1, Number(totalDurationSeconds || 0) - 0.1);
  const originalTimeSeconds = normalizeTimelineSeconds(Math.min(Math.max(0.1, Number(candidate?.timeSeconds || 0) || 0.1), safeEndSeconds)) || 0.1;
  const stepSeconds = 0.1;
  const maxSteps = Math.max(1, Math.ceil(safeEndSeconds / stepSeconds));
  for (let step = 0; step <= maxSteps; step += 1) {
    const offset = normalizeTimelineSeconds(step * stepSeconds) || 0;
    const candidates = step === 0
      ? [originalTimeSeconds]
      : [originalTimeSeconds - offset, originalTimeSeconds + offset];
    for (const candidateTime of candidates) {
      if (candidateTime < 0.1 || candidateTime > safeEndSeconds) {
        continue;
      }
      const normalizedTime = normalizeTimelineSeconds(candidateTime) || 0.1;
      if (canPlaceGlobalSoundEffectEvent(placedEvents, candidate, normalizedTime, globalGuard)) {
        return normalizedTime;
      }
    }
  }
  return null;
}

function applyGlobalSoundEffectsGuard(events, config, totalDurationSeconds) {
  const globalGuard = {
    ...(config?.globalGuard || {}),
    collisionNotes: [],
    movedEventCount: 0,
    skippedEventCount: 0,
  };
  if (!globalGuard.enabled) {
    return {
      events: [...events].sort((left, right) => Number(left.timeSeconds || 0) - Number(right.timeSeconds || 0)),
      globalGuard,
    };
  }

  const orderedCandidates = [...events]
    .map((event, originalIndex) => ({ ...event, originalIndex }))
    .sort((left, right) => {
      const priorityDelta = getSoundEffectEventPriority(right) - getSoundEffectEventPriority(left);
      if (priorityDelta) {
        return priorityDelta;
      }
      const timeDelta = Number(left.timeSeconds || 0) - Number(right.timeSeconds || 0);
      return Math.abs(timeDelta) > 0.001 ? timeDelta : Number(left.originalIndex || 0) - Number(right.originalIndex || 0);
    });
  const placedEvents = [];
  for (const candidate of orderedCandidates) {
    const originalTimeSeconds = normalizeTimelineSeconds(candidate.timeSeconds) || 0;
    if (canPlaceGlobalSoundEffectEvent(placedEvents, candidate, originalTimeSeconds, globalGuard)) {
      placedEvents.push(candidate);
      continue;
    }

    const canMove = String(candidate.reason || '').trim() === 'randomInterval';
    const movedTimeSeconds = canMove
      ? findNearestGlobalSoundEffectSlot(candidate, placedEvents, globalGuard, totalDurationSeconds)
      : null;
    if (movedTimeSeconds !== null) {
      const movedEvent = {
        ...candidate,
        movedByGlobalGuard: true,
        notes: [
          ...(Array.isArray(candidate.notes) ? candidate.notes : []),
          `Moved by the global SFX guard from ${originalTimeSeconds}s to ${movedTimeSeconds}s.`,
        ],
        originalTimeSeconds,
        timeSeconds: movedTimeSeconds,
      };
      placedEvents.push(movedEvent);
      globalGuard.movedEventCount += 1;
      globalGuard.collisionNotes.push({
        action: 'moved',
        fromSeconds: originalTimeSeconds,
        itemName: candidate.itemName || candidate.itemId || 'Sound effect',
        layerId: candidate.layerId,
        layerName: candidate.layerName,
        reason: candidate.reason,
        toSeconds: movedTimeSeconds,
      });
      continue;
    }

    globalGuard.skippedEventCount += 1;
    globalGuard.collisionNotes.push({
      action: 'skipped',
      itemName: candidate.itemName || candidate.itemId || 'Sound effect',
      layerId: candidate.layerId,
      layerName: candidate.layerName,
      reason: candidate.reason,
      timeSeconds: originalTimeSeconds,
    });
  }

  return {
    events: placedEvents
      .map(({ originalIndex, ...event }) => event)
      .sort((left, right) => {
        const timeDelta = Number(left.timeSeconds || 0) - Number(right.timeSeconds || 0);
        return Math.abs(timeDelta) > 0.001 ? timeDelta : Number(left.layerIndex || 0) - Number(right.layerIndex || 0);
      }),
    globalGuard,
  };
}

function applyFinalSoundEffectsScheduleToLayers(layers, finalEvents) {
  for (const layerPlan of layers) {
    const layerEvents = finalEvents.filter((event) => {
      if (String(event.layerId || '').trim() && String(layerPlan.layerId || '').trim()) {
        return String(event.layerId || '').trim() === String(layerPlan.layerId || '').trim();
      }
      return Number(event.layerIndex ?? -1) === Number(layerPlan.layerIndex ?? -2);
    });
    layerPlan.scheduledEvents = layerEvents;
    layerPlan.scheduledEventCount = layerEvents.length;
  }
}

async function resolveManagedSoundEffectItems(library, notes) {
  const sourceItems = Array.isArray(library?.items) ? library.items : [];
  const resolvedItems = [];
  for (const item of sourceItems) {
    try {
      const preview = await resolveAssetLibraryPreviewFile('soundEffects', library.id, item.id);
      resolvedItems.push({
        channels: preview.item?.channels || item.channels || null,
        durationSeconds: Number(preview.item?.durationSeconds || item.durationSeconds || 0) || null,
        extension: preview.item?.extension || item.extension || '',
        id: preview.item.id,
        displayName: preview.item?.displayName || item.displayName || item.originalFilename || item.id,
        originalFilename: preview.item?.originalFilename || item.originalFilename || '',
        sampleRate: preview.item?.sampleRate || item.sampleRate || null,
      });
    } catch (error) {
      notes.push(error?.message || 'Skipped a sound effect because the managed library file could not be read.');
    }
  }
  return resolvedItems;
}

async function buildSoundEffectsLayerSchedule(visualItems, timingPlan, layerConfig, librariesById) {
  const totalDurationSeconds = normalizeTimelineSeconds(timingPlan.totalVisualDurationSeconds) || 0;
  const layerPlan = {
    avoidRepeats: layerConfig.avoidRepeats,
    density: layerConfig.density,
    enabled: layerConfig.enabled !== false,
    fadeSeconds: layerConfig.fadeSeconds,
    layerId: layerConfig.id,
    layerIndex: layerConfig.index,
    layerName: layerConfig.name,
    libraryId: layerConfig.libraryId,
    libraryName: '',
    maxSimultaneous: layerConfig.maxSimultaneous,
    minSpacingSeconds: layerConfig.minSpacingSeconds,
    notes: [],
    scheduledEvents: [],
    schedulingMode: layerConfig.mode,
    seed: layerConfig.seed,
    totalDurationSeconds,
    volume: layerConfig.volume,
  };
  if (!layerConfig.libraryId) {
    layerPlan.notes.push('Choose a Sound Effects library for this layer.');
    return layerPlan;
  }
  if (totalDurationSeconds <= 0.05) {
    layerPlan.notes.push('Sound effects were skipped because the composition duration is too short.');
    return layerPlan;
  }

  const library = librariesById.get(layerConfig.libraryId) || null;
  if (!library) {
    layerPlan.notes.push('Local AI Hub could not find the selected Sound Effects library.');
    return layerPlan;
  }
  layerPlan.libraryName = library.name || library.id;
  const items = await resolveManagedSoundEffectItems(library, layerPlan.notes);
  if (!items.length) {
    layerPlan.notes.push('The selected Sound Effects library does not have any valid managed audio files.');
    return layerPlan;
  }

  const seed = layerConfig.seed || hashMediaCompositionTransitionSeed([
    layerConfig.id,
    layerConfig.libraryId,
    layerConfig.mode,
    layerConfig.density,
    layerConfig.minSpacingSeconds,
    visualItems.map((item) => String(item.itemId || item.artifact?.fileName || '')).join(','),
    visualItems.map((item) => String(item.durationSeconds || '')).join(','),
  ]);

  if (layerConfig.mode === MEDIA_COMPOSITION_SOUND_EFFECTS_SCHEDULING_MODES.SCENE_ALIGNED || layerConfig.mode === MEDIA_COMPOSITION_SOUND_EFFECTS_SCHEDULING_MODES.BOTH) {
    getSceneBoundarySeconds(visualItems).forEach((boundary, index) => {
      const sceneDurationSeconds = Number(visualItems[index + 1]?.durationSeconds || 0) || 0;
      if (sceneDurationSeconds < Math.max(0.5, layerConfig.minSpacingSeconds * 0.5)) {
        layerPlan.notes.push('Skipped a scene-aligned sound effect because one scene was too short.');
        return;
      }
      const offsetSeconds = (deterministicFloat([seed, 'scene', index]) - 0.5) * Math.min(0.8, layerConfig.minSpacingSeconds * 0.25);
      const timeSeconds = Math.min(Math.max(0.1, boundary.boundarySeconds + offsetSeconds), Math.max(0.1, totalDurationSeconds - 0.1));
      addDeterministicSoundEffectEvent(layerPlan.scheduledEvents, items, library, timeSeconds, 'sceneAligned', layerConfig, [seed, 'scene-item', index]);
    });
  }

  if (layerConfig.mode === MEDIA_COMPOSITION_SOUND_EFFECTS_SCHEDULING_MODES.RANDOM_INTERVAL || layerConfig.mode === MEDIA_COMPOSITION_SOUND_EFFECTS_SCHEDULING_MODES.BOTH) {
    const intervalSeconds = Math.max(layerConfig.minSpacingSeconds, getSoundEffectDensityIntervalSeconds(layerConfig.density));
    const targetCount = Math.max(1, Math.floor(totalDurationSeconds / intervalSeconds));
    for (let index = 0; index < targetCount; index += 1) {
      const segmentStart = (totalDurationSeconds / targetCount) * index;
      const segmentEnd = (totalDurationSeconds / targetCount) * (index + 1);
      const jitter = deterministicFloat([seed, 'random-time', index]);
      const timeSeconds = Math.min(Math.max(0.1, segmentStart + ((segmentEnd - segmentStart) * jitter)), Math.max(0.1, totalDurationSeconds - 0.1));
      addDeterministicSoundEffectEvent(layerPlan.scheduledEvents, items, library, timeSeconds, 'randomInterval', layerConfig, [seed, 'random-item', index]);
    }
  }

  if (!layerPlan.scheduledEvents.length) {
    layerPlan.notes.push('No sound effects were scheduled after spacing and timing rules were applied.');
  }
  return layerPlan;
}

async function buildSoundEffectsSchedule(visualItems, effectiveConfig, timingPlan) {
  const config = normalizeMediaCompositionSoundEffectsConfig(effectiveConfig);
  const totalDurationSeconds = normalizeTimelineSeconds(timingPlan.totalVisualDurationSeconds) || 0;
  const plan = {
    enabled: config.enabled,
    globalGuard: {
      ...config.globalGuard,
      collisionNotes: [],
      movedEventCount: 0,
      skippedEventCount: 0,
    },
    layerCount: config.layers.length,
    layers: [],
    notes: [],
    requested: config,
    scheduledEvents: [],
    totalDurationSeconds,
    volume: config.globalVolume,
  };
  if (!config.enabled) {
    plan.notes.push('Sound effects are off.');
    return plan;
  }
  if (!config.layers.length) {
    plan.notes.push('Add at least one Sound Effects layer before enabling sound effects.');
    return plan;
  }

  const libraries = await listAssetLibraries('soundEffects');
  const librariesById = new Map((libraries || []).map((library) => [library.id, library]));
  for (const layerConfig of config.layers) {
    const layerPlan = await buildSoundEffectsLayerSchedule(visualItems, timingPlan, layerConfig, librariesById);
    plan.layers.push(layerPlan);
    plan.notes.push(...(layerPlan.notes || []).map((note) => `${layerPlan.layerName}: ${note}`));
    plan.scheduledEvents.push(...(layerPlan.scheduledEvents || []));
  }
  const guardedSchedule = applyGlobalSoundEffectsGuard(plan.scheduledEvents, config, totalDurationSeconds);
  plan.scheduledEvents = guardedSchedule.events;
  plan.globalGuard = guardedSchedule.globalGuard;
  applyFinalSoundEffectsScheduleToLayers(plan.layers, plan.scheduledEvents);
  plan.layerCount = plan.layers.length;
  plan.scheduledEventCount = plan.scheduledEvents.length;
  if (plan.globalGuard.enabled && (plan.globalGuard.movedEventCount || plan.globalGuard.skippedEventCount)) {
    plan.notes.push(`Global SFX guard moved ${plan.globalGuard.movedEventCount} event(s) and skipped ${plan.globalGuard.skippedEventCount} event(s).`);
  }
  if (!plan.scheduledEvents.length) {
    plan.notes.push('No sound effects were scheduled across enabled layers.');
  }
  return plan;
}
function buildSceneTransitionPlan(visualItems, effectiveConfig, timingPlan) {
  const transitionConfig = getMediaCompositionTransitionConfig(effectiveConfig);
  const totalVisualDurationSeconds = normalizeTimelineSeconds(timingPlan.totalVisualDurationSeconds) || 0;
  const basePlan = {
    avoidRepeats: transitionConfig.avoidRepeats,
    boundaries: [],
    category: transitionConfig.category,
    configuredDurationSeconds: transitionConfig.configuredDurationSeconds,
    enabled: false,
    mode: transitionConfig.mode,
    notes: [],
    requested: transitionConfig,
    selectedTransitions: transitionConfig.selectedTransitions,
    singleTransition: transitionConfig.singleTransition,
    timingModeInteraction: timingPlan.timingMetadataUsed
      ? 'Transitions are applied at timed image boundaries while preserving dynamic narration/transcript timing.'
      : 'Transitions are applied at fixed-duration image boundaries while preserving the intended slideshow duration.',
    totalVisualDurationSeconds,
  };

  if (transitionConfig.mode === MEDIA_COMPOSITION_TRANSITION_MODES.OFF) {
    basePlan.notes.push('Scene transitions are off.');
    return basePlan;
  }
  if (!Array.isArray(visualItems) || visualItems.length < 2) {
    basePlan.notes.push('A single image does not need scene transitions.');
    return basePlan;
  }

  const seed = hashMediaCompositionTransitionSeed([
    transitionConfig.mode,
    transitionConfig.category,
    transitionConfig.singleTransition,
    transitionConfig.selectedTransitions.join(','),
    transitionConfig.configuredDurationSeconds,
    visualItems.map((item) => String(item.itemId || item.artifact?.filePath || '')).join(','),
    visualItems.map((item) => String(item.durationSeconds || '')).join(','),
  ]);
  let previousTransition = '';
  let cumulativeBoundarySeconds = 0;
  for (let index = 0; index < visualItems.length - 1; index += 1) {
    const outgoing = visualItems[index];
    const incoming = visualItems[index + 1];
    const outgoingDurationSeconds = Math.max(0, Number(outgoing?.durationSeconds || 0) || 0);
    const incomingDurationSeconds = Math.max(0, Number(incoming?.durationSeconds || 0) || 0);
    cumulativeBoundarySeconds = normalizeTimelineSeconds(cumulativeBoundarySeconds + outgoingDurationSeconds) || (cumulativeBoundarySeconds + outgoingDurationSeconds);
    const maxBoundaryDuration = Math.min(
      transitionConfig.configuredDurationSeconds,
      outgoingDurationSeconds * 0.45,
      incomingDurationSeconds * 0.45,
    );
    const effectiveDurationSeconds = normalizeTimelineSeconds(Math.max(0, maxBoundaryDuration)) || 0;
    const candidates = getTransitionCandidatesForBoundary(transitionConfig);
    const selectedTransition = transitionConfig.mode === MEDIA_COMPOSITION_TRANSITION_MODES.SINGLE
      ? normalizeMediaCompositionTransitionName(transitionConfig.singleTransition)
      : selectDeterministicTransition(candidates, seed, index, previousTransition, transitionConfig.avoidRepeats);
    const notes = [];
    if (effectiveDurationSeconds < transitionConfig.configuredDurationSeconds - 0.001) {
      notes.push('Transition duration was clamped because one or both scenes are short.');
    }
    if (effectiveDurationSeconds <= 0.001) {
      notes.push('Transition was skipped because a scene duration was too short.');
    }
    basePlan.boundaries.push({
      boundaryIndex: index,
      boundarySeconds: cumulativeBoundarySeconds,
      incomingDurationSeconds: normalizeTimelineSeconds(incomingDurationSeconds),
      incomingItemId: String(incoming?.itemId || '').trim(),
      notes,
      offsetSeconds: normalizeTimelineSeconds(Math.max(0, cumulativeBoundarySeconds - effectiveDurationSeconds)),
      outgoingDurationSeconds: normalizeTimelineSeconds(outgoingDurationSeconds),
      outgoingItemId: String(outgoing?.itemId || '').trim(),
      requestedDurationSeconds: transitionConfig.configuredDurationSeconds,
      selectedTransition,
      effectiveDurationSeconds,
      wasClamped: effectiveDurationSeconds < transitionConfig.configuredDurationSeconds - 0.001,
    });
    if (effectiveDurationSeconds > 0.001) {
      previousTransition = selectedTransition;
    }
  }

  basePlan.enabled = basePlan.boundaries.some((boundary) => Number(boundary.effectiveDurationSeconds || 0) > 0.001);
  if (!basePlan.enabled) {
    basePlan.notes.push('All scene transitions were skipped because the image durations were too short.');
  }
  return basePlan;
}

function getAudioArtifactDurationSeconds(artifact) {
  const candidates = [
    artifact?.audio?.durationSeconds,
    artifact?.transcription?.durationSeconds,
    artifact?.audioGeneration?.finalOutputDurationSeconds,
    artifact?.audioGeneration?.generatedDurationSeconds,
    artifact?.audioGeneration?.durationSeconds,
    artifact?.audioStitch?.finalOutputDurationSeconds,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTimelineSeconds(candidate);
    if (normalized && normalized > 0) {
      return normalized;
    }
  }
  return null;
}

function getCollectionPlannedDurationSeconds(collection) {
  const timing = collection?.metadata?.timing && typeof collection.metadata.timing === 'object'
    ? collection.metadata.timing
    : null;
  return normalizeTimelineSeconds(timing?.totalPlannedDurationSeconds || timing?.totalDurationSeconds);
}

function buildFixedVisualTimingItems(visualCollection, durationSeconds) {
  return (Array.isArray(visualCollection.items) ? visualCollection.items : [])
    .map((entry, index) => ({
      artifact: entry?.artifact || null,
      durationSeconds,
      endSeconds: normalizeTimelineSeconds((index + 1) * durationSeconds),
      itemId: String(entry?.itemId || '').trim() || `visual-${index + 1}`,
      lineage: entry?.lineage || null,
      metadata: entry?.metadata || null,
      startSeconds: normalizeTimelineSeconds(index * durationSeconds),
      summary: String(entry?.summary || summarizeArtifact(entry?.artifact || null)).trim(),
    }))
    .filter((entry) => entry.artifact);
}

function buildDynamicVisualTiming(visualCollection, fixedDurationSeconds, primaryAudioArtifact, backgroundMusicArtifact) {
  const sourceEntries = Array.isArray(visualCollection.items) ? visualCollection.items : [];
  const validTiming = [];
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const entry = sourceEntries[index];
    const timing = getTimingMetadataFromCollectionItemMetadata(entry?.metadata);
    if (!timing.hasTiming) {
      return {
        fallbackReason: 'One or more image items did not include valid start/end or duration timing metadata.',
        items: buildFixedVisualTimingItems(visualCollection, fixedDurationSeconds),
        metadataUsed: false,
      };
    }
    if (timing.startSeconds !== null && timing.endSeconds !== null && timing.endSeconds <= timing.startSeconds) {
      return {
        fallbackReason: 'One or more image items had an end time that was not after its start time.',
        items: buildFixedVisualTimingItems(visualCollection, fixedDurationSeconds),
        metadataUsed: false,
      };
    }
    if (index > 0 && timing.startSeconds !== null && validTiming[index - 1]?.endSeconds !== null && timing.startSeconds < validTiming[index - 1].endSeconds - 0.05) {
      return {
        fallbackReason: 'Image timing metadata overlaps between adjacent items.',
        items: buildFixedVisualTimingItems(visualCollection, fixedDurationSeconds),
        metadataUsed: false,
      };
    }
    validTiming.push(timing);
  }

  let cursorSeconds = 0;
  const items = sourceEntries
    .map((entry, index) => {
      const timing = validTiming[index] || {};
      const startSeconds = timing.startSeconds !== null ? timing.startSeconds : normalizeTimelineSeconds(cursorSeconds);
      const durationSeconds = normalizeTimelineSeconds(timing.durationSeconds) || fixedDurationSeconds;
      const endSeconds = timing.endSeconds !== null ? timing.endSeconds : normalizeTimelineSeconds(startSeconds + durationSeconds);
      cursorSeconds = normalizeTimelineSeconds(cursorSeconds + durationSeconds) || cursorSeconds + durationSeconds;
      return {
        artifact: entry?.artifact || null,
        durationSeconds,
        endSeconds,
        itemId: String(entry?.itemId || '').trim() || `visual-${index + 1}`,
        lineage: entry?.lineage || null,
        metadata: entry?.metadata || null,
        startSeconds,
        summary: String(entry?.summary || summarizeArtifact(entry?.artifact || null)).trim(),
      };
    })
    .filter((entry) => entry.artifact);

  const targetNarrationDurationSeconds = getAudioArtifactDurationSeconds(primaryAudioArtifact);
  const targetBackgroundMusicDurationSeconds = getAudioArtifactDurationSeconds(backgroundMusicArtifact);
  const targetPlannedDurationSeconds = getCollectionPlannedDurationSeconds(visualCollection);
  const targetDurationSeconds = targetNarrationDurationSeconds || targetPlannedDurationSeconds || targetBackgroundMusicDurationSeconds;
  let totalVisualDurationSeconds = normalizeTimelineSeconds(items.reduce((total, entry) => total + (Number(entry.durationSeconds || 0) || 0), 0)) || 0;
  let extendedFinalImageSeconds = 0;
  if (items.length && targetDurationSeconds && targetDurationSeconds > totalVisualDurationSeconds + 0.05) {
    extendedFinalImageSeconds = normalizeTimelineSeconds(targetDurationSeconds - totalVisualDurationSeconds) || 0;
    const lastItem = items[items.length - 1];
    const lastStartSeconds = normalizeTimelineSeconds(lastItem.startSeconds)
      ?? normalizeTimelineSeconds(totalVisualDurationSeconds - (Number(lastItem.durationSeconds || 0) || 0))
      ?? 0;
    lastItem.durationSeconds = normalizeTimelineSeconds(Number(lastItem.durationSeconds || 0) + extendedFinalImageSeconds) || lastItem.durationSeconds;
    lastItem.startSeconds = lastStartSeconds;
    lastItem.endSeconds = normalizeTimelineSeconds(lastStartSeconds + lastItem.durationSeconds);
    totalVisualDurationSeconds = normalizeTimelineSeconds(items.reduce((total, entry) => total + (Number(entry.durationSeconds || 0) || 0), 0)) || totalVisualDurationSeconds;
  }

  return {
    extendedFinalImageSeconds,
    items,
    metadataUsed: true,
    targetBackgroundMusicDurationSeconds,
    targetNarrationDurationSeconds,
    targetPlannedDurationSeconds,
    targetDurationSeconds,
    totalVisualDurationSeconds,
  };
}

function buildVisualTimingPlan(visualCollection, effectiveConfig, primaryAudioArtifact, backgroundMusicArtifact) {
  const fixedDurationSeconds = Math.max(0.1, Number(effectiveConfig.secondsPerItem || 0) || 4);
  const requestedMode = normalizeMediaCompositionImageTimingMode(effectiveConfig.imageTimingMode);
  const dynamicTiming = requestedMode === 'dynamicFromImageMetadata'
    ? buildDynamicVisualTiming(visualCollection, fixedDurationSeconds, primaryAudioArtifact, backgroundMusicArtifact)
    : null;
  const visualItems = dynamicTiming?.items || buildFixedVisualTimingItems(visualCollection, fixedDurationSeconds);
  const effectiveMode = dynamicTiming?.metadataUsed ? 'dynamicFromImageMetadata' : 'fixedDurationPerImage';
  const fallbackDurationSeconds = requestedMode === 'dynamicFromImageMetadata' && !dynamicTiming?.metadataUsed ? fixedDurationSeconds : null;
  const fallbackReason = dynamicTiming?.fallbackReason && fallbackDurationSeconds !== null
    ? dynamicTiming.fallbackReason + ' Fallback used ' + fallbackDurationSeconds + ' seconds per image.'
    : dynamicTiming?.fallbackReason || '';
  const totalVisualDurationSeconds = normalizeTimelineSeconds(visualItems.reduce((total, entry) => total + (Number(entry.durationSeconds || 0) || 0), 0));
  const perImageDurations = visualItems.map((entry, index) => ({
    durationSeconds: normalizeTimelineSeconds(entry.durationSeconds),
    endSeconds: normalizeTimelineSeconds(entry.endSeconds),
    itemId: String(entry.itemId || '').trim(),
    itemIndex: index,
    startSeconds: normalizeTimelineSeconds(entry.startSeconds),
  }));

  return {
    effectiveMode,
    fallbackDurationSeconds,
    fallbackReason,
    fixedDurationSeconds,
    perImageDurations,
    requestedMode,
    targetBackgroundMusicDurationSeconds: dynamicTiming?.targetBackgroundMusicDurationSeconds || getAudioArtifactDurationSeconds(backgroundMusicArtifact),
    targetNarrationDurationSeconds: dynamicTiming?.targetNarrationDurationSeconds || getAudioArtifactDurationSeconds(primaryAudioArtifact),
    targetPlannedDurationSeconds: dynamicTiming?.targetPlannedDurationSeconds || getCollectionPlannedDurationSeconds(visualCollection),
    targetDurationSeconds: dynamicTiming?.targetDurationSeconds || null,
    timingMetadataUsed: Boolean(dynamicTiming?.metadataUsed),
    totalVisualDurationSeconds,
    extendedFinalImageSeconds: dynamicTiming?.extendedFinalImageSeconds || 0,
    visualItems,
  };
}
async function executeMediaCompositionNode(node, graph, run) {
  const effectiveConfig = getMediaCompositionEffectiveConfig(node, run);
  const visualCollection = getNodeInputArtifact(node.id, 'visuals', graph, run.resultsByNodeId, run);
  if (!isArtifactCollection(visualCollection)) {
    throw new Error('This media composition step needs an ordered image collection on the Visual Collection input.');
  }
  if (String(visualCollection.itemKind || '').trim() !== PORT_KIND_IMAGE) {
    throw new Error('This first media composition pass only accepts ordered image collections as the visual track input.');
  }

  const audioArtifact = getNodeInputArtifact(node.id, 'audio', graph, run.resultsByNodeId, run);
  if (audioArtifact && String(audioArtifact.kind || '').trim() !== PORT_KIND_AUDIO) {
    throw new Error('The Primary Audio input needs one audio artifact when it is connected.');
  }

  const backgroundMusicArtifact = getNodeInputArtifact(node.id, 'backgroundMusic', graph, run.resultsByNodeId, run);
  if (backgroundMusicArtifact && String(backgroundMusicArtifact.kind || '').trim() !== PORT_KIND_AUDIO) {
    throw new Error('The Background Music input needs one audio artifact when it is connected.');
  }

  const timingPlan = buildVisualTimingPlan(visualCollection, effectiveConfig, audioArtifact, backgroundMusicArtifact);
  const visualItems = timingPlan.visualItems;
  const sceneTransitionPlan = buildSceneTransitionPlan(visualItems, effectiveConfig, timingPlan);
  if (!visualItems.length) {
    throw new Error('This media composition does not have any saved images to assemble yet.');
  }
  const soundEffectsPlan = await buildSoundEffectsSchedule(visualItems, effectiveConfig, timingPlan);

  const composition = createCompositionArtifact({
    audioMix: buildMediaCompositionAudioMixConfig(effectiveConfig, soundEffectsPlan),
    soundEffects: soundEffectsPlan,
    displayName: node.label,
    exportKind: PORT_KIND_VIDEO,
    recipeId: 'image-sequence-optional-audio-bed',
    recipeLabel: 'Image sequence with optional narration, background music, and sound effects',
    tracks: [
      {
        id: 'visual-track',
        imageTimingMode: timingPlan.effectiveMode,
        itemDurationSeconds: timingPlan.fixedDurationSeconds,
        itemKind: PORT_KIND_IMAGE,
        items: visualItems,
        kind: 'visual-sequence',
        role: 'primary-visual',
        sceneTransitions: sceneTransitionPlan,
        sourceCollection: {
          directoryPath: String(visualCollection.directoryPath || '').trim(),
          displayName: String(visualCollection.displayName || '').trim(),
          itemCount: Number(visualCollection.itemCount || visualItems.length) || visualItems.length,
          itemKind: String(visualCollection.itemKind || '').trim() || PORT_KIND_IMAGE,
          manifestPath: String(visualCollection.manifestPath || '').trim(),
          metadata: visualCollection.metadata ? serializeArtifactForUi(visualCollection.metadata) : null,
          summary: String(visualCollection.summary || '').trim(),
        },
        timing: {
          effectiveMode: timingPlan.effectiveMode,
          extendedFinalImageSeconds: timingPlan.extendedFinalImageSeconds,
          fallbackDurationSeconds: timingPlan.fallbackDurationSeconds,
          fallbackReason: timingPlan.fallbackReason,
          fixedDurationSeconds: timingPlan.fixedDurationSeconds,
          imageTimingMode: timingPlan.effectiveMode,
          perImageDurations: timingPlan.perImageDurations,
          requestedMode: timingPlan.requestedMode,
          targetBackgroundMusicDurationSeconds: timingPlan.targetBackgroundMusicDurationSeconds,
          targetNarrationDurationSeconds: timingPlan.targetNarrationDurationSeconds,
          targetPlannedDurationSeconds: timingPlan.targetPlannedDurationSeconds,
          timingMetadataUsed: timingPlan.timingMetadataUsed,
          totalVisualDurationSeconds: timingPlan.totalVisualDurationSeconds,
          sceneTransitions: sceneTransitionPlan,
        },
      },
      ...(audioArtifact ? [{
        artifact: audioArtifact,
        id: 'audio-track',
        kind: 'audio',
        role: 'primary-audio',
      }] : []),
      ...(backgroundMusicArtifact ? [{
        artifact: backgroundMusicArtifact,
        id: 'background-music-track',
        kind: 'audio',
        role: 'background-music',
        summary: 'Background music track',
      }] : []),
    ],
  }, {
    displayName: node.label,
    role: 'generated',
  });
  const persistedComposition = await persistCompositionArtifact(run.directories, composition, {
    baseName: node.label,
    displayName: node.label,
    role: 'generated',
    target: 'artifacts',
  });

  const timingMessage = timingPlan.timingMetadataUsed
    ? ' using per-image timing metadata'
    : timingPlan.requestedMode === 'dynamicFromImageMetadata'
      ? ' using fixed image timing because timing metadata was missing or invalid'
      : ' using fixed image timing';
  const fallbackMessage = timingPlan.fallbackReason ? ' Fallback reason: ' + timingPlan.fallbackReason : '';
  const soundEffectsLayerLabel = Number(soundEffectsPlan.layerCount || 0) === 1 ? '1 layer' : `${soundEffectsPlan.layerCount || 0} layers`;
  const soundEffectsMessage = soundEffectsPlan.enabled
    ? ` Sound effects: ${soundEffectsPlan.scheduledEvents.length} scheduled across ${soundEffectsLayerLabel}.` + (soundEffectsPlan.notes?.length ? ' Note: ' + soundEffectsPlan.notes[0] : '')
    : '';
  return {
    message: audioArtifact && backgroundMusicArtifact
      ? `Media Composition prepared the ordered images${timingMessage} with primary narration at ${formatMediaCompositionVolumePercent(effectiveConfig.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME)}% and background music at ${formatMediaCompositionVolumePercent(effectiveConfig.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME)}%.${fallbackMessage}${soundEffectsMessage}`
      : audioArtifact
        ? 'Media Composition prepared the ordered images' + timingMessage + ' with the connected primary audio track.' + fallbackMessage + soundEffectsMessage
        : backgroundMusicArtifact
          ? 'Media Composition prepared the ordered images' + timingMessage + ' with background music and no primary narration yet.' + fallbackMessage + soundEffectsMessage
          : 'Media Composition prepared the ordered images' + timingMessage + ' without any audio tracks yet.' + fallbackMessage + soundEffectsMessage,
    outputs: {
      composition: persistedComposition,
    },
    preview: summarizeArtifact(persistedComposition),
  };
}
async function executeMediaExportNode(node, graph, run, reportProgress) {
  const compositionInput = getNodeInputArtifacts(node.id, 'composition', graph, run.resultsByNodeId, run)[0] || null;
  const compositionArtifact = compositionInput?.artifact || null;
  if (!isCompositionArtifact(compositionArtifact)) {
    throw new Error('This media export step needs a saved media composition before it can render a video.');
  }

  const mediaCompositionNode = compositionInput?.edge?.source?.nodeId
    ? graph.nodeMap.get(compositionInput.edge.source.nodeId) || null
    : null;
  const exportResult = await exportCompositionArtifactToVideo(compositionArtifact, {
    fitMode: String(node.config?.fitMode || '').trim() === 'cover' ? 'cover' : 'contain',
    fps: Math.max(1, Number(node.config?.fps || 0) || 30),
    height: Math.max(16, Number(node.config?.height || 0) || 720),
    mediaCompositionNodeId: mediaCompositionNode?.type === 'mediaComposition' ? mediaCompositionNode.id : '',
    mediaCompositionNodeLabel: mediaCompositionNode?.type === 'mediaComposition' ? mediaCompositionNode.label : '',
    mediaExportNodeId: node.id,
    mediaExportNodeLabel: node.label,
    cancelSignal: activeRunAbortController?.signal || null,
    reportProgress,
    runDirectories: run.directories,
    stopMode: String(node.config?.stopMode || '').trim() === 'visuals' ? 'visuals' : 'shortest',
    title: String(node.config?.title || node.label || 'Composed video').trim() || 'Composed video',
    width: Math.max(16, Number(node.config?.width || 0) || 1280),
  });

  return {
    destinationPath: exportResult.artifact.filePath,
    message: exportResult.message,
    outputs: {
      video: exportResult.artifact,
    },
    preview: summarizeArtifact(exportResult.artifact),
  };
}

const COLLECTION_INPUT_ITEM_KINDS = new Set([
  PORT_KIND_TEXT,
  PORT_KIND_IMAGE,
  PORT_KIND_AUDIO,
  PORT_KIND_VIDEO,
  PORT_KIND_FILE,
]);

function isValidCollectionInputItemType(value) {
  return COLLECTION_INPUT_ITEM_KINDS.has(String(value || '').trim().toLowerCase());
}

function normalizeCollectionInputItemType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return COLLECTION_INPUT_ITEM_KINDS.has(normalized) ? normalized : PORT_KIND_TEXT;
}

function getCollectionInputItemId(node, item, index) {
  const explicitId = String(item?.id || item?.itemId || '').trim();
  if (explicitId) {
    return explicitId;
  }

  return String(node.id || 'collection-input') + '-item-' + String(index + 1).padStart(3, '0');
}

function buildCollectionInputLineage(node, itemId, index) {
  return {
    sourceItemId: itemId,
    sourceItemIndex: index,
    sourceNodeId: node.id,
    sourceNodeLabel: node.label,
    sourcePortId: 'collection',
    sourcePortLabel: 'Collection',
  };
}

async function executeCollectionInputNode(node, run) {
  if (!isValidCollectionInputItemType(node.config?.itemType)) {
    throw new Error('Choose a collection item type before running this pipeline.');
  }

  const itemType = normalizeCollectionInputItemType(node.config?.itemType);
  const rawItems = Array.isArray(node.config?.items) ? node.config.items : [];
  if (!rawItems.length) {
    throw new Error('Add at least one item to this Collection Input before running the pipeline.');
  }

  const collectionItems = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index] || {};
    const itemId = getCollectionInputItemId(node, item, index);
    if (itemType === PORT_KIND_TEXT) {
      const text = String(item.text || item.value || '').trim();
      if (!text) {
        throw new Error('Collection Input item ' + (index + 1) + ' needs text before running the pipeline.');
      }

      collectionItems.push({
        artifact: createTextArtifact(text, {
          displayName: String(item.label || item.title || node.label + ' item ' + (index + 1)).trim() || node.label,
          role: 'input',
        }),
        itemId,
        lineage: buildCollectionInputLineage(node, itemId, index),
        metadata: item.metadata && typeof item.metadata === 'object' ? serializeArtifactForUi(item.metadata) : null,
      });
      continue;
    }

    const rawPath = String(item.filePath || item.path || '').trim();
    if (!rawPath) {
      throw new Error('Collection Input item ' + (index + 1) + ' needs a selected ' + itemType + ' file before running the pipeline.');
    }

    const filePath = path.resolve(rawPath);
    if (!(await fs.pathExists(filePath))) {
      throw new Error('Collection Input item ' + (index + 1) + ' points to a file Local AI Hub cannot find. Choose it again and try the pipeline one more time.');
    }

    collectionItems.push({
      artifact: await buildFileArtifact(filePath, {
        displayName: String(item.label || item.title || item.displayName || path.basename(filePath)).trim() || path.basename(filePath),
        kind: itemType,
        role: 'input',
      }),
      itemId,
      lineage: buildCollectionInputLineage(node, itemId, index),
      metadata: item.metadata && typeof item.metadata === 'object' ? serializeArtifactForUi(item.metadata) : null,
    });
  }

  const collection = createArtifactCollection(collectionItems, {
    displayName: node.label,
    itemKind: itemType,
    metadata: node.config?.metadata && typeof node.config.metadata === 'object' ? serializeArtifactForUi(node.config.metadata) : null,
    role: 'input',
  });
  const persistedCollection = await persistArtifactCollection(run.directories, collection, {
    baseName: node.label,
    displayName: node.label,
    role: 'input',
    target: 'artifacts',
  });
  return {
    message: 'Prepared an ordered ' + itemType + ' collection with ' + persistedCollection.itemCount + ' item' + (persistedCollection.itemCount === 1 ? '' : 's') + '.',
    outputs: {
      collection: persistedCollection,
    },
    preview: summarizeArtifact(persistedCollection),
  };
}
async function executeOutputNode(node, inputPortId, graph, run) {
  const artifact = getNodeInputArtifact(node.id, inputPortId, graph, run.resultsByNodeId, run);
  if (!artifact) {
    throw new Error('This output step did not receive any content to save.');
  }

  const savedArtifact = await copyArtifactToOutput(artifact, run.directories, {
    outputKind: artifact.kind,
    outputNodeId: node.id,
    outputPortId: inputPortId,
    runId: run.runId,
    title: String(node.config?.title || node.label || 'output').trim() || 'output',
  });
  const destinationPath = savedArtifact.destinationPath || savedArtifact.directoryPath || savedArtifact.filePath || '';
  const outputTitle = String(node.config?.title || node.label || 'Output').trim() || 'Output';
  const outputMessage = isArtifactCollection(savedArtifact) && savedArtifact.partial
    ? `${outputTitle} saved as a partial collection to ${destinationPath}.`
    : `${outputTitle} saved to ${destinationPath}.`;
  return {
    destinationPath,
    message: outputMessage,
    outputs: {
      [inputPortId]: savedArtifact,
    },
    preview: summarizeArtifact(savedArtifact),
    terminalResult: buildTerminalResult(node, savedArtifact),
  };
}

async function executeNode(node, graph, run, contextMaps, reportProgress) {
  if (node.type === 'collectionInput') {
    return executeCollectionInputNode(node, run);
  }
  if (node.type === 'textInput') {
    const text = String(node.config?.text || '').trim();
    if (!text) {
      throw new Error('Enter some text for the Text Input node before running this pipeline.');
    }

    const artifact = createTextArtifact(text, {
      displayName: node.label,
      role: 'input',
    });
    return {
      message: 'Prepared the text input.',
      outputs: {
        text: artifact,
      },
      preview: summarizeArtifact(artifact),
    };
  }

  if (node.type === 'imageInput' || node.type === 'audioInput' || node.type === 'videoInput' || node.type === 'fileInput') {
    const filePath = path.resolve(String(node.config?.filePath || '').trim());
    if (!String(node.config?.filePath || '').trim()) {
      throw new Error(`Choose a file for the ${node.label} node before running this pipeline.`);
    }

    if (!(await fs.pathExists(filePath))) {
      throw new Error('The selected file could not be found anymore. Choose it again and try the pipeline one more time.');
    }

    const outputPortId = node.type === 'imageInput' ? 'image' : node.type === 'audioInput' ? 'audio' : node.type === 'videoInput' ? 'video' : 'file';
    const kind = node.type === 'imageInput' ? 'image' : node.type === 'audioInput' ? 'audio' : node.type === 'videoInput' ? 'video' : 'file';
    const artifact = await buildFileArtifact(filePath, {
      displayName: node.label,
      kind,
      role: 'input',
    });
    return {
      message: `Prepared the ${node.label.toLowerCase()} input.`,
      outputs: {
        [outputPortId]: artifact,
      },
      preview: summarizeArtifact(artifact),
    };
  }

  if (node.type === 'planningPacket') {
    return executePlanningPacketNode(node, graph, run, contextMaps);
  }

  if (node.type === 'planner') {
    return executePlannerNode(node, graph, run, contextMaps, reportProgress);
  }

  if (node.type === 'planScenes') {
    return executePlanScenesNode(node, graph, run);
  }

  if (node.type === 'llmPrompt') {
    const promptArtifact = getNodeInputArtifact(node.id, 'prompt', graph, run.resultsByNodeId, run);
    const model = String(node.config?.model || '').trim();
    const executionMode = node.config?.executionMode === 'ollama' ? 'ollama' : node.config?.executionMode === 'localTool' ? 'localTool' : 'cloud';
    const operationId = getModelStepOperationId(node);
    if (!promptArtifact) {
      throw new Error('This LLM step did not receive any input.');
    }

    const requiresExplicitModel = !(executionMode === 'localTool'
      && (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE || operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE || operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM || operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM))
      && (executionMode !== 'cloud' || doesProviderOperationRequireExplicitModel(String(node.config?.providerId || '').trim(), operationId));
    if (!model && requiresExplicitModel) {
      throw new Error('Choose or enter a model for the model step before running this pipeline.');
    }

    let sourceLabel = 'This model';
    if (executionMode === 'ollama') {
      if (operationId !== PIPELINE_OPERATION_IDS.LLM_PROMPT) {
        throw new Error('Local AI Hub can only return text from Ollama model steps right now. Switch this step back to Text response or choose a cloud image or video model.');
      }

      const messages = await buildLlmMessages(node, promptArtifact);
      const inputLabel = promptArtifact.kind === PORT_KIND_IMAGE ? 'image' : 'prompt';
      reportProgress?.('Sending the ' + inputLabel + ' to Ollama and waiting for a reply.', 'Running ' + node.label + ' with Ollama...');
      const ollamaTool = await getInstalledToolOrThrow(
        contextMaps,
        'ollama',
        'Install Ollama before using a local LLM step in a pipeline.',
      );
      if (promptArtifact.kind === PORT_KIND_IMAGE) {
        await ensureOllamaImageModelSupport(contextMaps, ollamaTool, model);
      }
      const result = await chatWithOllama(ollamaTool, {
        messages,
        model,
      });
      const content = String(result?.message?.content || '').trim();
      sourceLabel = 'Ollama';
      if (!content) {
        throw new Error(sourceLabel + ' returned an empty reply for this pipeline step.');
      }

      const artifact = createTextArtifact(content, {
        displayName: node.label,
        role: 'generated',
      });
      return {
        message: sourceLabel + ' returned a reply.',
        outputs: {
          text: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }

    if (executionMode === 'localTool') {
      if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
        const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'local audio generation');
        const referenceAudioArtifact = getNodeInputArtifact(node.id, 'referenceAudio', graph, run.resultsByNodeId, run);
        const audioRequest = await buildAudioGenerationRequest(node, promptArtifact, contextMaps, { referenceAudioArtifact });
        reportProgress?.('Sending the request to ' + tool.name + ' for local audio generation.', 'Running ' + node.label + ' with ' + tool.name + '...');
        return generateAudioWithLocalAudioTool(tool, {
          appendSource: audioRequest.appendSource,
          audioMode: audioRequest.audioMode,
          continuationRepeatCount: audioRequest.continuationRepeatCount,
          heavyStepCooldownSeconds: getActiveRunHeavyStepCooldownSeconds(),
          audiocraftCfgCoef: audioRequest.audiocraftCfgCoef,
          audiocraftTemperature: audioRequest.audiocraftTemperature,
          audiocraftTopK: audioRequest.audiocraftTopK,
          audiocraftTopP: audioRequest.audiocraftTopP,
          audiocraftTwoStepCfg: audioRequest.audiocraftTwoStepCfg,
          continuationSeedSeconds: audioRequest.continuationSeedSeconds,
          displayName: node.label,
          durationSeconds: audioRequest.durationSeconds,
          model,
          nodeLabel: node.label,
          operationId,
          prompt: audioRequest.prompt,
          promptStyle: audioRequest.promptStyle,
          referenceAudioArtifact: audioRequest.referenceAudioArtifact,
          referenceAudioPath: audioRequest.referenceAudioPath,
          cancelSignal: activeRunAbortController?.signal || null,
          reportProgress,
          runDirectories: run.directories,
          sourceAudioArtifact: audioRequest.sourceAudioArtifact,
          sourceAudioPath: audioRequest.sourceAudioPath,
        });
      }

      if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) {
        const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'local audio transcription');
        if (!promptArtifact?.filePath || promptArtifact.kind !== PORT_KIND_AUDIO) {
          throw new Error('This model-step transcription did not receive an audio file.');
        }
        reportProgress?.('Sending the audio to ' + tool.name + ' for transcription.', 'Running ' + node.label + ' with ' + tool.name + '...');
        const result = await transcribeWithWhisper(tool, {
          audioPath: promptArtifact.filePath,
          model: model || DEFAULT_WHISPER_MODEL,
        });
        const transcript = String(result?.text || '').trim();
        if (!transcript) {
          throw new Error(tool.name + ' finished, but it did not return any transcript text for this pipeline step.');
        }

        const artifact = buildWhisperTranscriptArtifact(node, promptArtifact, result);
        return {
          message: buildWhisperCompletionMessage(result),
          outputs: {
            text: artifact,
          },
          preview: summarizeArtifact(artifact),
        };
      }

      if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
        const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'local audio transformation');
        const audioRequest = await buildAudioTransformRequest(node, promptArtifact);
        if (!model) {
          throw new Error('Choose an RVC voice model before running this audio transformation step.');
        }
        const selectedVoiceModel = getDownloadedToolModelEntry(tool, model);
        if (Array.isArray(tool?.downloadedModels) && tool.downloadedModels.length && !selectedVoiceModel) {
          throw new Error(tool.name + ' does not have the selected RVC voice model available locally. Refresh the local model list or choose a model file from the weights folder before running this step.');
        }
        reportProgress?.('Sending the source audio to ' + tool.name + ' for local audio transformation.', 'Running ' + node.label + ' with ' + tool.name + '...');
        return generateAudioWithLocalAudioTool(tool, {
          displayName: node.label,
          instruction: audioRequest.instruction,
          model,
          nodeLabel: node.label,
          operationId,
          reportProgress,
          runDirectories: run.directories,
          sourceAudioArtifact: audioRequest.sourceAudioArtifact,
          sourceAudioPath: audioRequest.sourceAudioPath,
          voiceModel: selectedVoiceModel,
        });
      }

      if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
        const tool = await getSelectedLocalVideoToolOrThrow(contextMaps, node, 'local video generation');
        const videoRequest = await buildVideoGenerationRequest(node, promptArtifact, contextMaps);
        reportProgress?.('Sending the request to ' + tool.name + ' for local video generation.', 'Running ' + node.label + ' with ' + tool.name + '...');
        return generateVideoWithLocalVideoTool(tool, {
          displayName: node.label,
          fps: 15,
          model,
          negativePrompt: videoRequest.negativePrompt,
          nodeLabel: node.label,
          prompt: videoRequest.prompt,
          promptStyle: videoRequest.promptStyle,
          referenceImagePath: videoRequest.referenceImagePath,
          reportProgress,
          sourceImageArtifact: videoRequest.sourceImageArtifact,
          runDirectories: run.directories,
          seed: node.config?.seed,
          size: videoRequest.size,
          steps: node.config?.steps,
        });
      }

      if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
        if (!promptArtifact?.filePath || promptArtifact.kind !== PORT_KIND_IMAGE) {
          throw new Error('This model-step image analysis did not receive an image file.');
        }
        const tool = await getSelectedImageToolOrThrow(contextMaps, node, 'local image analysis');
        reportProgress?.('Sending the image to ' + tool.name + ' for analysis.', 'Running ' + node.label + ' with ' + tool.name + '...');
        const result = await interrogateImageWithWorkflowTool(tool, {
          analysisMode: node.config?.analysisMode || model || 'clip',
          imagePath: promptArtifact.filePath,
        });
        const description = String(result?.text || '').trim();
        if (!description) {
          throw new Error((tool?.name || 'The selected image tool') + ' did not return an image description.');
        }

        const artifact = createTextArtifact(description, {
          displayName: node.label,
          role: 'generated',
        });
        return {
          message: tool.name + ' described the image.',
          outputs: {
            text: artifact,
          },
          preview: summarizeArtifact(artifact),
        };
      }

      if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
        const tool = await getSelectedLocalImageToolOrThrow(contextMaps, node, 'local image transformation');
        const referenceArtifact = getNodeInputArtifact(node.id, 'referenceImage', graph, run.resultsByNodeId, run);
        const imageRequest = await buildImageTransformRequest(node, promptArtifact, referenceArtifact, tool);
        reportProgress?.('Sending the source image to ' + tool.name + ' for local image transformation.', 'Running ' + node.label + ' with ' + tool.name + '...');
        return generateImageWithLocalImageTool(tool, {
          displayName: node.label,
          instruction: imageRequest.instruction,
          model,
          nodeLabel: node.label,
          operationId,
          referenceImageArtifact: imageRequest.referenceImageArtifact,
          referenceImagePath: imageRequest.referenceImagePath,
          cancelSignal: activeRunAbortController?.signal || null,
          reportProgress,
          runDirectories: run.directories,
          sourceImageArtifact: imageRequest.sourceImageArtifact,
          sourceImagePath: imageRequest.sourceImagePath,
          transformSubtype: imageRequest.transformSubtype,
        });
      }

      if (operationId !== PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
        throw new Error('Local AI Hub currently supports audio transcription, audio generation, audio transformation, image analysis, image generation, image transformation, and video generation for operation-driven local tools in the model step. Use the Graph Workflow step for ComfyUI-style graph-native workflows.');
      }

      const basePrompt = buildImageGenerationPrompt(node, promptArtifact);
      const tool = await getSelectedImageToolOrThrow(contextMaps, node, 'local image generation');
      const promptRequest = applyNodePromptStyle(contextMaps, node, basePrompt, 'image', {
        negativePrompt: node.config?.negativePrompt,
        supportNegativePrompt: true,
      });
      const prompt = promptRequest.prompt;
      const checkpointOverride = String(model || '').trim();

      reportProgress?.('Sending the prompt to ' + tool.name + ' for local image generation.', 'Running ' + node.label + ' with ' + tool.name + '...');
      const generated = await generateImageWithWorkflowTool(tool, {
        cfgScale: node.config?.cfgScale,
        height: node.config?.height,
        model: checkpointOverride,
        negativePrompt: promptRequest.negativePrompt,
        prompt,
        seed: node.config?.seed,
        steps: node.config?.steps,
        width: node.config?.width,
      });
      const artifact = await saveBase64Artifact(run.directories, generated.base64Image, {
        baseName: node.label + '-' + Date.now(),
        displayName: node.label,
        extension: '.png',
        kind: PORT_KIND_IMAGE,
        role: 'generated',
        imageGeneration: buildImageGenerationMetadata(node, tool, promptRequest, { model: checkpointOverride }),
      });
      return {
        destinationPath: artifact.filePath,
        message: tool.name + ' generated an image locally and saved the intermediate file to ' + artifact.filePath + '.',
        outputs: {
          image: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }
    const providerId = String(node.config?.providerId || '').trim();
    if (!providerId) {
      throw new Error('Choose a connected cloud provider before running this model step.');
    }

    const provider = contextMaps.providersById[providerId] || null;
    if (!provider?.isConnected) {
      throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
    }

    sourceLabel = provider.name;
    if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
      const audioRequest = await buildCloudAudioGenerationRequest(node, promptArtifact, contextMaps);
      reportProgress?.('Sending the text to ' + provider.name + ' for speech generation.', 'Running ' + node.label + ' with ' + provider.name + '...');
      const result = await runProviderOperation(providerId, {
        instruction: audioRequest.instruction,
        model,
        operationId,
        prompt: audioRequest.prompt,
        providerId,
        spokenText: audioRequest.spokenText,
        voice: audioRequest.voice,
      });
      const generatedAudio = result?.audios?.[0] || null;
      if (!generatedAudio?.buffer) {
        throw new Error(sourceLabel + ' finished the request, but it did not return an audio file.');
      }

      const artifact = await saveBufferArtifact(run.directories, generatedAudio.buffer, {
        audio: {
          bitDepth: generatedAudio.bitDepth,
          channelCount: generatedAudio.channelCount,
          sampleRate: generatedAudio.sampleRate,
        },
        audioGeneration: {
          backend: providerId,
          backendLabel: provider.name,
          mode: 'speech',
          model,
          operationId,
          operationSubtype: 'speech',
          prompt: audioRequest.prompt,
          promptStyle: audioRequest.promptStyle,
          spokenText: audioRequest.spokenText,
          voice: generatedAudio.voice || audioRequest.voice,
        },
        baseName: node.label + '-' + Date.now(),
        displayName: node.label,
        extension: String(generatedAudio.extension || '.wav').trim() || '.wav',
        kind: PORT_KIND_AUDIO,
        role: 'generated',
      });
      return {
        destinationPath: artifact.filePath,
        message: sourceLabel + ' generated speech and saved the intermediate file to ' + artifact.filePath + '.',
        outputs: {
          audio: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }

    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
      const imageRequest = await buildCloudImageGenerationRequest(node, promptArtifact, contextMaps);
      const requestSettings = {
        background: node.config?.imageBackground,
        imageReference: imageRequest.imageReference ? { fileName: imageRequest.imageReference.fileName, mimeType: imageRequest.imageReference.mimeType } : null,
        quality: node.config?.imageQuality,
        size: node.config?.imageSize,
      };
      reportProgress?.(
        imageRequest.operation === 'imageToImage'
          ? 'Sending the source image and instruction to ' + provider.name + ' for cloud image editing.'
          : 'Sending the prompt to ' + provider.name + ' for cloud image generation.',
        'Running ' + node.label + ' with ' + provider.name + '...',
      );
      const result = await runProviderOperation(providerId, {
        background: node.config?.imageBackground,
        imageReference: imageRequest.imageReference,
        model,
        operationId,
        operationSubtype: imageRequest.operation,
        prompt: imageRequest.prompt,
        providerId,
        quality: node.config?.imageQuality,
        size: node.config?.imageSize,
      });
      const generatedImage = result?.images?.[0] || null;
      const base64Image = String(generatedImage?.base64Data || '').trim();
      if (!base64Image) {
        throw new Error(sourceLabel + ' finished the request, but it did not return an image.');
      }

      const extension = String(generatedImage.extension || '.png').trim() || '.png';
      const artifact = await saveBase64Artifact(run.directories, base64Image, {
        baseName: node.label + '-' + Date.now(),
        displayName: node.label,
        extension,
        kind: PORT_KIND_IMAGE,
        role: 'generated',
        imageGeneration: buildImageGenerationMetadata(node, provider, imageRequest.promptRequest, {
          backend: providerId,
          backendLabel: provider.name,
          extension,
          height: generatedImage.height,
          mimeType: generatedImage.mimeType,
          model,
          operation: imageRequest.operation,
          provider: providerId,
          requestSettings,
          revisedPrompt: generatedImage.revisedPrompt,
          safetyNotes: generatedImage.safetyNotes,
          sourceImageArtifact: imageRequest.sourceImageArtifact,
          sourceText: imageRequest.sourceText,
          width: generatedImage.width,
        }),
      });
      return {
        destinationPath: artifact.filePath,
        message: sourceLabel + (imageRequest.operation === 'imageToImage' ? ' generated an edited image' : ' generated an image') + ' and saved the intermediate file to ' + artifact.filePath + '.',
        outputs: {
          image: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }

    if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
      const videoRequest = await buildVideoGenerationRequest(node, promptArtifact, contextMaps);
      reportProgress?.('Sending the prompt to ' + provider.name + ' for video generation.', 'Running ' + node.label + ' with ' + provider.name + '...');
      const result = await runProviderOperation(providerId, {
        aspectRatio: node.config?.videoAspectRatio,
        durationSeconds: node.config?.durationSeconds,
        imageReference: videoRequest.referenceImage,
        model,
        negativePrompt: videoRequest.negativePrompt,
        onProgress: (message) => reportProgress?.(message, 'Running ' + node.label + ' with ' + provider.name + '...'),
        operationId,
        operationSubtype: videoRequest.referenceImage ? 'imageToVideo' : 'textToVideo',
        prompt: videoRequest.prompt,
        providerId,
        resolution: node.config?.videoResolution,
        seconds: Math.max(1, Number(node.config?.durationSeconds || 8) || 8),
        signal: activeRunAbortController?.signal || null,
        size: videoRequest.size,
      });
      const videoBuffer = result?.videos?.[0]?.buffer || null;
      if (!videoBuffer) {
        throw new Error(sourceLabel + ' finished the request, but it did not return a video file.');
      }

      const artifact = await saveBufferArtifact(run.directories, videoBuffer, {
        baseName: node.label + '-' + Date.now(),
        displayName: node.label,
        extension: String(result?.videos?.[0]?.extension || '.mp4').trim() || '.mp4',
        kind: PORT_KIND_VIDEO,
        role: 'generated',
        videoGeneration: {
          backend: providerId,
          backendLabel: provider.name,
          mode: videoRequest.referenceImage ? 'image-to-video' : 'text-to-video',
          model: result?.model || model,
          negativePrompt: videoRequest.negativePrompt,
          operationId,
          provider: providerId,
          providerOperationId: result?.providerOperationId || result?.videos?.[0]?.id || '',
          providerRawStatusSummary: result?.providerRawStatusSummary || null,
          polling: result?.polling || null,
          requestSettings: result?.requestedSettings || null,
          returnedVideo: {
            durationSeconds: Number(result?.videos?.[0]?.durationSeconds || 0) || 0,
            extension: String(result?.videos?.[0]?.extension || '.mp4').trim() || '.mp4',
            mimeType: String(result?.videos?.[0]?.mimeType || '').trim(),
            resolution: String(result?.videos?.[0]?.resolution || '').trim(),
          },
          safetyNotes: Array.isArray(result?.safetyNotes) ? result.safetyNotes : [],
          operationSubtype: videoRequest.referenceImage ? 'imageToVideo' : 'textToVideo',
          prompt: videoRequest.prompt,
          promptStyle: videoRequest.promptStyle,
          size: videoRequest.size,
          sourceImage: videoRequest.sourceImageArtifact,
          usedReferenceImage: Boolean(videoRequest.referenceImage),
        },
      });
      return {
        destinationPath: artifact.filePath,
        message: sourceLabel + ' generated a video and saved the intermediate file to ' + artifact.filePath + '.',
        outputs: {
          video: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }

    const messages = await buildLlmMessages(node, promptArtifact);
    const inputLabel = promptArtifact.kind === PORT_KIND_IMAGE ? 'image' : 'prompt';
    reportProgress?.('Sending the ' + inputLabel + ' to ' + provider.name + '.', 'Running ' + node.label + ' with ' + provider.name + '...');
    const result = await runProviderOperation(providerId, {
      messages,
      model,
      operationId,
      providerId,
    });
    const content = String(result?.message?.content || '').trim();
    if (!content) {
      throw new Error(sourceLabel + ' returned an empty reply for this pipeline step.');
    }

    const artifact = createTextArtifact(content, {
      displayName: node.label,
      role: 'generated',
    });
    return {
      message: sourceLabel + ' returned a reply.',
      outputs: {
        text: artifact,
      },
      preview: summarizeArtifact(artifact),
    };
  }
  if (node.type === 'graphWorkflow') {
    const resolvedPreset = resolveGraphWorkflowPresetNode(node, contextMaps);
    if (resolvedPreset.missingPreset) {
      throw new Error('The selected graph workflow preset could not be found. Choose another preset or switch this node back to local workflow config.');
    }
    const effectiveNode = resolvedPreset.node;
    const toolId = getGraphWorkflowToolId(effectiveNode);
    const installMessage = toolId === 'comfyui'
      ? 'Install ComfyUI before using a graph workflow step in a pipeline.'
      : 'Install the selected graph workflow tool before using this step in a pipeline.';
    const tool = await getInstalledToolOrThrow(contextMaps, toolId, installMessage);
    return executeGraphWorkflowNode({
      inputArtifacts: {
        image: getNodeInputArtifact(node.id, 'image', graph, run.resultsByNodeId, run),
        text: getNodeInputArtifact(node.id, 'text', graph, run.resultsByNodeId, run),
      },
      node: effectiveNode,
      reportProgress,
      runDirectories: run.directories,
      tool,
    });
  }

  if (node.type === 'validation') {
    return executeValidationNode(node, graph, run, contextMaps, reportProgress);
  }

  if (node.type === 'collectionMap') {
    return executeCollectionMapNode(node, graph, run, contextMaps, reportProgress);
  }

  if (node.type === 'collectionBuilder') {
    return executeCollectionBuilderNode(node, graph, run);
  }

  if (node.type === 'collectionAccumulator') {
    return executeCollectionAccumulatorNode(node, graph, run);
  }

  if (node.type === 'audioStitch') {
    return executeAudioStitchNode(node, graph, run);
  }

  if (node.type === 'videoStitch') {
    return executeVideoStitchNode(node, graph, run);
  }

  if (node.type === 'trimMedia') {
    return executeTrimMediaNode(node, graph, run, reportProgress);
  }

  if (node.type === 'burnSubtitles') {
    return executeBurnSubtitlesNode(node, graph, run, reportProgress);
  }

  if (node.type === 'exportSubtitles') {
    return executeExportSubtitlesNode(node, graph, run, reportProgress);
  }

  if (node.type === 'normalizeAudioCollection') {
    return executeNormalizeAudioCollectionNode(node, graph, run, reportProgress);
  }

  if (node.type === 'normalizeVideoCollection') {
    return executeNormalizeVideoCollectionNode(node, graph, run, reportProgress);
  }

  if (node.type === 'normalizeImage') {
    return executeNormalizeImageNode(node, graph, run, reportProgress);
  }

  if (node.type === 'extractVideoFrame') {
    return executeExtractVideoFrameNode(node, graph, run, reportProgress);
  }

  if (node.type === 'extractAudio') {
    return executeExtractAudioNode(node, graph, run, reportProgress);
  }

  if (node.type === 'mediaComposition') {
    return executeMediaCompositionNode(node, graph, run);
  }

  if (node.type === 'mediaExport') {
    return executeMediaExportNode(node, graph, run, reportProgress);
  }

  if (node.type === 'branchMerge') {
    return executeBranchMergeNode(node, graph, run);
  }

  if (node.type === 'retryLoop') {
    return executeRetryLoopNode(node, graph, run);
  }

  if (node.type === 'collectionOutput') {
    return executeOutputNode(node, 'collection', graph, run);
  }

  if (node.type === 'planOutput') {
    return executeOutputNode(node, 'plan', graph, run);
  }

  if (node.type === 'textOutput') {
    return executeOutputNode(node, 'text', graph, run);
  }

  if (node.type === 'imageOutput') {
    return executeOutputNode(node, 'image', graph, run);
  }

  if (node.type === 'audioOutput') {
    return executeOutputNode(node, 'audio', graph, run);
  }

  if (node.type === 'videoOutput') {
    return executeOutputNode(node, 'video', graph, run);
  }

  if (node.type === 'fileOutput') {
    return executeOutputNode(node, 'file', graph, run);
  }

  throw new Error(`Local AI Hub does not support the ${node.type} node type in pipeline runs yet.`);
}

async function executeActiveRun(graph, context) {
  const orchestrator = createPipelineToolOrchestrator(context);
  let orchestratorDisposed = false;

  const disposeOrchestrator = async (nodeId, reason) => {
    if (orchestratorDisposed) {
      return null;
    }

    orchestratorDisposed = true;
    return disposePipelineTools(orchestrator, activeRun, nodeId, reason);
  };

  try {
    let index = 0;
    let completedHeavyLocalStep = false;
    while (index < graph.executionOrder.length) {
      const nodeId = graph.executionOrder[index];
      if (!activeRun) {
        await disposeOrchestrator('', 'this pipeline run');
        return;
      }

      if (activeRun.cancelRequested) {
        const cleanupError = await disposeOrchestrator('', 'this cancelled pipeline run');
        if (cleanupError) {
          throw cleanupError;
        }

        markRemainingNodes(activeRun, graph, 'cancelled', 'Cancelled before this step started.');
        activeRun.status = 'cancelled';
        activeRun.message = 'Pipeline run cancelled.';
        activeRun.finishedAt = new Date().toISOString();
        activeRun.currentNodeId = null;
        activeRunAbortController = null;
        emitPipelineEvent();
        return;
      }

      const node = graph.nodeMap.get(nodeId);
      const nextNodeId = graph.executionOrder[index + 1] || '';
      const nextNode = nextNodeId ? graph.nodeMap.get(nextNodeId) : null;
      const nodeState = activeRun.nodeStates[nodeId];
      const nodeLoopState = getNodeLoopState(activeRun, graph, nodeId);
      applyNodeLoopState(nodeState, nodeLoopState);

      const missingInputs = getMissingRequiredInputs(node, graph, activeRun.resultsByNodeId, activeRun);
      const nodeIsHeavyLocal = isHeavyLocalPipelineNode(node);
      if (missingInputs.length) {
        nodeState.status = 'skipped';
        nodeState.finishedAt = new Date().toISOString();
        nodeState.message = `Skipped because ${missingInputs.join(', ')} did not receive content from the active branch.`;
        emitPipelineEvent();
        index += 1;
        continue;
      }

      if (nodeIsHeavyLocal && completedHeavyLocalStep) {
        await waitForHeavyStepCooldown(activeRun, node.id, node.label);
      }

      nodeState.status = 'running';
      nodeState.startedAt = new Date().toISOString();
      nodeState.runCount = Number(nodeState.runCount || 0) + 1;
      nodeState.message = 'Running now.';
      activeRun.currentNodeId = nodeId;
      activeRun.status = 'running';
      const loopRunLabel = nodeLoopState.loopPathLabel
        || (nodeLoopState.loopMaxAttempts
          ? `Attempt ${nodeLoopState.iteration} of ${nodeLoopState.loopMaxAttempts}`
          : nodeLoopState.iteration > 1
            ? `Attempt ${nodeLoopState.iteration}`
            : '');
      activeRun.message = loopRunLabel
        ? `Running ${node.label} (${loopRunLabel})...`
        : `Running ${node.label}...`;
      emitPipelineEvent();

      const progressReporter = createProgressReporter(activeRun, node.id);
      await orchestrator.ensureToolForNode(node, progressReporter);
      const result = await executeNode(node, graph, activeRun, context, progressReporter);
      await orchestrator.releaseToolForNode(node, nextNode, progressReporter);

      activeRun.resultsByNodeId[nodeId] = {
        outputs: Object.fromEntries(
          Object.entries(result.outputs || {}).map(([portId, artifact]) => [portId, serializeArtifactForUi(artifact)]),
        ),
        validation: result.validation || null,
      };
      nodeState.status = 'completed';
      nodeState.finishedAt = new Date().toISOString();
      nodeState.message = result.message || 'Completed.';
      nodeState.preview = result.preview || '';
      nodeState.outputs = activeRun.resultsByNodeId[nodeId].outputs;
      nodeState.validation = result.validation || null;
      nodeState.selectedBranch = result.selectedBranch || '';
      nodeState.destinationPath = result.destinationPath || '';
      syncNodeCollectionControlState(activeRun, nodeId);

      if (result.terminalResult) {
        activeRun.terminalResults.push(result.terminalResult);
      }

      activeRun.currentNodeId = null;
      if (nodeIsHeavyLocal) {
        completedHeavyLocalStep = true;
      }
      activeRun.message = result.loopControl?.action === 'retry'
        ? (result.message || `${node.label} requested another attempt.`)
        : `${node.label} finished.`;
      emitPipelineEvent();

      if (result.loopControl?.action === 'retry') {
        resetLoopSegmentForRetry(activeRun, graph, result.loopControl.loopNodeId, result.loopControl.nextAttempt);
        const retryTargetIndex = Number(graph.executionIndexByNodeId.get(result.loopControl.retryTargetNodeId));
        if (!Number.isFinite(retryTargetIndex)) {
          throw new Error('Local AI Hub could not resume that retry loop. Reopen the pipeline and try again.');
        }

        activeRun.message = result.message || `Retrying ${node.label}.`;
        emitPipelineEvent();
        index = retryTargetIndex;
        continue;
      }

      index += 1;
    }

    if (!activeRun) {
      await disposeOrchestrator('', 'this pipeline run');
      return;
    }

    const cleanupError = await disposeOrchestrator('', 'this finished pipeline run');
    if (cleanupError) {
      throw cleanupError;
    }

    activeRun.status = 'completed';
    activeRun.message = `${activeRun.pipelineName} finished successfully.`;
    activeRun.finishedAt = new Date().toISOString();
    activeRunAbortController = null;
    emitPipelineEvent();
  } catch (error) {
    if (!activeRun) {
      return;
    }

    const cleanupError = await disposeOrchestrator(
      activeRun.currentNodeId || '',
      activeRun.cancelRequested ? 'this cancelled pipeline run' : 'this pipeline run',
    );
    const finalError = cleanupError && !error ? cleanupError : error;
    const isCancelled = finalError instanceof PipelineCancelledError || activeRun.cancelRequested;
    const failedNodeId = activeRun.currentNodeId;
    if (failedNodeId && activeRun.nodeStates[failedNodeId]) {
      activeRun.nodeStates[failedNodeId].status = isCancelled ? 'cancelled' : 'failed';
      activeRun.nodeStates[failedNodeId].finishedAt = new Date().toISOString();
      activeRun.nodeStates[failedNodeId].message = finalError.message || (isCancelled ? 'Pipeline run cancelled.' : 'This step failed.');
    }

    pendingValidationControl = null;
    activeRun.pendingValidation = null;
    markRemainingNodes(activeRun, graph, isCancelled ? 'cancelled' : 'skipped', isCancelled ? 'Cancelled before this step started.' : 'Skipped because an earlier step failed.');
    activeRun.status = isCancelled ? 'cancelled' : 'failed';
    activeRun.message = isCancelled ? 'Pipeline run cancelled.' : finalError.message || 'Pipeline run failed.';
    activeRun.finishedAt = new Date().toISOString();
    activeRun.currentNodeId = null;
    activeRunAbortController = null;
    emitPipelineEvent();
  }
}

async function runPipeline(definition) {
  if (activeRun && (activeRun.status === 'running' || activeRun.status === 'paused')) {
    throw new Error('A pipeline is already running. Wait for it to finish or cancel it before starting another one.');
  }

  const { analysis, context } = await analyzeWithCurrentContext(definition);
  if (!analysis.executable) {
    throw new Error(analysis.primaryIssue?.message || 'This pipeline is not ready to run yet.');
  }

  const graph = buildPipelineGraph(analysis.pipeline);
  activeRun = createRunRecord(analysis, graph, null);
  activeRunAbortController = new AbortController();
  activeRun.directories = await ensureRunDirectories(activeRun.runId);
  emitPipelineEvent();
  executeActiveRun(graph, context).catch(() => null);
  return getActiveRunSnapshot();
}

function cancelPipelineRun(runId) {
  if (!activeRun || (activeRun.status !== 'running' && activeRun.status !== 'paused')) {
    throw new Error('There is no active pipeline run to cancel right now.');
  }

  if (runId && activeRun.runId !== runId) {
    throw new Error('Local AI Hub could not find that active pipeline run.');
  }

  activeRun.cancelRequested = true;
  activeRunAbortController?.abort();
  activeRun.message = 'Local AI Hub is stopping this pipeline and will shut down any tool it started for the run.';
  if (activeRun.status === 'paused' && pendingValidationControl?.resolve) {
    const resolve = pendingValidationControl.resolve;
    pendingValidationControl = null;
    resolve({ action: 'cancel' });
  }
  emitPipelineEvent();
  return getActiveRunSnapshot();
}

function resumePipelineValidation(runId, payload = {}) {
  if (!activeRun || activeRun.status !== 'paused' || !activeRun.pendingValidation) {
    throw new Error('There is no paused validation step waiting right now.');
  }

  if (runId && activeRun.runId !== runId) {
    throw new Error('Local AI Hub could not find that paused pipeline run.');
  }

  const pendingValidation = activeRun.pendingValidation;
  const requestId = String(payload.requestId || payload.validationRequestId || '').trim();
  if (requestId && pendingValidation.requestId && pendingValidation.requestId !== requestId) {
    throw new Error('Local AI Hub could not find that paused validation step anymore.');
  }

  const nodeId = String(payload.nodeId || '').trim();
  if (nodeId && pendingValidation.nodeId !== nodeId) {
    throw new Error('Local AI Hub could not find that paused validation step anymore.');
  }

  const decision = String(payload.decision || '').trim().toLowerCase();
  if (decision !== 'pass' && decision !== 'fail') {
    throw new Error('Choose pass or fail before continuing this validation step.');
  }

  if (!pendingValidationControl?.resolve) {
    throw new Error('Local AI Hub is still preparing that validation step. Try again.');
  }

  const comment = String(payload.comment || '').trim();
  const retryOverrideConfig = decision === 'fail'
    ? applyValidationRetryOverrides(activeRun, pendingValidation, payload)
    : null;
  const nodeState = activeRun.nodeStates?.[pendingValidation.nodeId] || null;
  activeRun.pendingValidation = null;
  activeRun.status = 'running';
  activeRun.message = `Continuing after ${pendingValidation.nodeLabel || nodeState?.nodeLabel || 'this validation step'}.`;
  if (nodeState) {
    nodeState.status = 'running';
    nodeState.message = 'Validation decision received. Continuing the run.';
  }

  const resolve = pendingValidationControl.resolve;
  pendingValidationControl = null;
  emitPipelineEvent();
  resolve({
    action: 'route',
    comment,
    decision,
    retryOverrides: retryOverrideConfig && Object.keys(retryOverrideConfig).length ? retryOverrideConfig : null,
  });
  return getActiveRunSnapshot();
}

module.exports = {
  analyzeWithCurrentContext,
  cancelPipelineRun,
  getActiveRunSnapshot,
  resumePipelineValidation,
  runPipeline,
  setPipelineEventSink,
};

