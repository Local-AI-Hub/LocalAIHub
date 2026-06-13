import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import pipelineShared from '../../electron/shared/pipelineSchema.cjs';
import pipelineWizardShared from '../../electron/shared/pipelineWizard.cjs';
import pipelineWizardLifecycleShared from '../../electron/shared/pipelineWizardLifecycle.cjs';
import pipelineTemplatesShared from '../../electron/shared/pipelineTemplates.cjs';
import toolAssetSelectionShared from '../../electron/shared/toolAssetSelection.cjs';
import HoverRevealText from './HoverRevealText';
import {
  AUDIO_WORKFLOW_TOOL_IDS,
  GRAPH_WORKFLOW_TOOL_IDS,
  IMAGE_WORKFLOW_TOOL_IDS,
  VIDEO_WORKFLOW_TOOL_IDS,
  PIPELINE_NODE_WIDTH,
  WHISPER_MODELS,
  analyzePipelineDraft,
  buildPipelineDisplayContext,
  createPositionedNode,
  getNodeCardHeight,
  getNodePaletteGroups,
  getNodePortCenter,
  getPipelineNodeDefinition,
  runStatusClassName,
  summarizePreview,
  toneToClassName,
} from '../lib/pipeline-ui';
import collectionInputState from '../lib/pipeline-collection-input-state.cjs';
import { expectNextPrintableKeyDiagnostic, isEditableTarget, logRendererActionDiagnostic } from '../lib/focus-guard';
import { formatBytes } from '../lib/formatters';

const {
  buildPipelineWizardContext,
  buildPipelineWizardDraft,
  buildPipelineWizardMessages,
  buildPipelineWizardStructuredOutputRequest,
  getPipelineWizardRequestProfile,
  parsePipelineWizardPlan,
} = pipelineWizardShared;

const {
  WIZARD_CLOUD_DRAFT_TIMEOUT_MS,
  WIZARD_CLIENT_TIMEOUT_GRACE_MS,
  WIZARD_LOCAL_DRAFT_TIMEOUT_MS,
  buildWizardFailureSummary,
  runPipelineWizardLifecycle,
} = pipelineWizardLifecycleShared;

const {
  BUILT_IN_PIPELINE_TEMPLATES,
  TEMPLATE_STATUS,
  getPipelineTemplateReadiness,
  instantiatePipelineTemplate,
} = pipelineTemplatesShared;

const {
  buildStableDiffusionCheckpointOption,
} = toolAssetSelectionShared;
const {
  applyMediaCompositionModeChange,
  applyRecordInputModeChange,
  arePortsCompatible,
  buildGraphWorkflowConfigFromPreset,
  buildPipelineGraph,
  createEdge,
  createEmptyPipeline,
  createPipelineDefinitionCopy,
  getDefaultGraphWorkflowBindings,
  getAudioModeOptionsForLocalTool,
  getGraphWorkflowContract,
  getGraphWorkflowFieldOptions,
  getGraphWorkflowInputBinding,
  getGraphWorkflowOutputBinding,
  getGraphWorkflowOutputNodeOptions,
  getGraphWorkflowOperationBackendSupport,
  getGraphWorkflowPresetContractSummary,
  getCollectionMapMapping,
  isGraphWorkflowPresetCompatibleWithOperation,
  resolveGraphWorkflowPresetNode,
  getPipelineNodePorts,
  COLLECTION_MAP_MAPPING_OPTIONS,
  getPortDefinition,
  parseGraphWorkflowDefinitionText,
  AUDIO_TRANSFORM_TOOL_IDS,
  IMAGE_TRANSFORM_TOOL_IDS,
  getModelStepOperationId,
  getMediaCompositionMode,
  getDefaultImageTransformSubtype,
  getImageTransformSubtypeOptions,
  PIPELINE_OPERATION_IDS,
  PIPELINE_PORT_KIND_LABELS,
  PIPELINE_RETRY_LOOP_MAX_ATTEMPTS,
  HEAVY_STEP_COOLDOWN_MAX_SECONDS,
  DEFAULT_PIPELINE_RUN_SETTINGS,
  DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS,
  DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS,
  RECORD_INPUT_MODE_IDS,
  RECORD_INPUT_MODE_OPTIONS,
  MEDIA_COMPOSITION_SOUND_EFFECTS_DENSITIES,
  MEDIA_COMPOSITION_SOUND_EFFECTS_SCHEDULING_MODES,
  MEDIA_COMPOSITION_MODES,
  MEDIA_COMPOSITION_TRANSITION_CATEGORIES,
  MEDIA_COMPOSITION_TRANSITION_MODES,
  normalizeAudioModeForLocalTool,
  normalizePipelineRunSettings,
  DEFAULT_PLANNING_SCHEMA_ID,
  getPlanningSchemaOptions,
  getRecordInputFormatLabel,
  getRecordInputModeDefinition,
  getRecordInputModeLabel,
  getRecordInputOutputKind,
} = pipelineShared;
const CANVAS_MIN_WIDTH = 1280;
const CANVAS_MIN_HEIGHT = 820;
const CANVAS_MIN_SCALE = 0.55;
const CANVAS_MAX_SCALE = 1.85;
const CANVAS_ZOOM_STEP = 0.14;
const CANVAS_PADDING_X = 360;
const CANVAS_PADDING_Y = 280;
const PIPELINE_SECTION_VISIBILITY_STORAGE_KEY = 'local-ai-hub.pipeline-builder.section-visibility.v1';
const DEFAULT_PIPELINE_SECTION_VISIBILITY = Object.freeze({
  pipelineInfo: false,
  canvas: true,
  inspector: false,
  nodePalette: false,
  pipelineWizard: false,
  starterTemplates: false,
  runStatus: false,
  savedPipelines: false,
});
const PLANNING_SCHEMA_OPTIONS = typeof getPlanningSchemaOptions === 'function' ? getPlanningSchemaOptions() : [];
const COLLECTION_MAP_TEXT_TO_IMAGE_DEFAULT_INSTRUCTION = 'Generate one image for each text item while preserving the source order.';
const EMPTY_GRAPH_WORKFLOW_PRESETS = Object.freeze([]);
const PIPELINE_TEMPLATE_CATEGORIES = Object.freeze(['Text', 'Image', 'Audio', 'Video']);
const MEDIA_COMPOSITION_TRANSITION_CATEGORY_OPTIONS = Array.isArray(MEDIA_COMPOSITION_TRANSITION_CATEGORIES) ? MEDIA_COMPOSITION_TRANSITION_CATEGORIES : [];
const MEDIA_COMPOSITION_TRANSITION_MODE_OPTIONS = Object.freeze([
  ['off', 'Off'],
  ['single', 'Single transition'],
  ['randomCategory', 'Random from category'],
  ['randomSelected', 'Random from selected list'],
]);
const MEDIA_COMPOSITION_SOUND_EFFECTS_MODE_OPTIONS = Object.freeze([
  ['randomInterval', 'Random intervals'],
  ['sceneAligned', 'Scene aligned'],
  ['both', 'Both'],
]);
const MEDIA_COMPOSITION_SOUND_EFFECTS_DENSITY_OPTIONS = Object.freeze([
  ['sparse', 'Sparse'],
  ['normal', 'Normal'],
  ['dense', 'Dense'],
]);
const MEDIA_COMPOSITION_MODE_OPTIONS = Object.freeze([
  ['imageSlideshow', 'Image slideshow'],
  ['videoSequence', 'Video sequence'],
  ['singleVideoMix', 'Single video mix'],
]);

function buildDefaultRecordInputRegion(display) {
  const bounds = display?.captureBounds || display?.bounds || { x: 0, y: 0, width: 1280, height: 720 };
  const width = Math.max(64, Math.floor(Math.min(1280, Number(bounds.width) || 1280) / 2) * 2);
  const height = Math.max(64, Math.floor(Math.min(720, Number(bounds.height) || 720) / 2) * 2);
  return {
    displayId: String(display?.id || ''),
    height,
    type: 'region',
    width,
    x: (Number(bounds.x) || 0) + Math.max(0, Math.floor(((Number(bounds.width) || width) - width) / 2)),
    y: (Number(bounds.y) || 0) + Math.max(0, Math.floor(((Number(bounds.height) || height) - height) / 2)),
  };
}

function formatRecordInputElapsed(startedAt, now) {
  const started = new Date(startedAt || 0).getTime();
  if (!Number.isFinite(started) || started <= 0) {
    return '00:00';
  }
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatMediaCompositionTransitionLabel(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-z]+)(left|right|up|down|black|white|grays|fast|slow)$/i, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function getMediaCompositionSoundEffectsMode(value) {
  const mode = String(value || '').trim();
  return Object.values(MEDIA_COMPOSITION_SOUND_EFFECTS_SCHEDULING_MODES || {}).includes(mode) ? mode : 'randomInterval';
}

function getMediaCompositionSoundEffectsDensity(value) {
  const density = String(value || '').trim();
  return (MEDIA_COMPOSITION_SOUND_EFFECTS_DENSITIES || []).includes(density) ? density : 'normal';
}

function normalizeSoundEffectsSpacing(value, fallback = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.round(numeric * 10) / 10);
}

function normalizeSoundEffectsGlobalMaxSimultaneous(value) {
  return Math.max(1, Math.min(8, Math.floor(Number(value || 0) || DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS)));
}

function createMediaCompositionSoundEffectsLayer(libraries = [], index = 0) {
  const layerNumber = Math.max(1, Number(index || 0) + 1);
  return {
    id: `sfx-layer-${Date.now().toString(36)}-${layerNumber}`,
    name: `Layer ${layerNumber}`,
    libraryId: libraries[0]?.id || '',
    schedulingMode: 'randomInterval',
    volume: DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME,
    density: 'normal',
    minSpacingSeconds: 4,
    maxSimultaneous: 2,
    avoidRepeats: true,
    fadeSeconds: 0.05,
    seed: '',
  };
}

function normalizeMediaCompositionSoundEffectsLayerForUi(layer = {}, index = 0, libraries = [], fallbackConfig = {}) {
  const fallbackLayer = createMediaCompositionSoundEffectsLayer(libraries, index);
  return {
    ...fallbackLayer,
    ...(layer && typeof layer === 'object' ? layer : {}),
    avoidRepeats: layer?.avoidRepeats !== false,
    density: getMediaCompositionSoundEffectsDensity(layer?.density ?? fallbackConfig.soundEffectsDensity),
    fadeSeconds: normalizeSoundEffectsSpacing(layer?.fadeSeconds ?? fallbackConfig.soundEffectsFadeSeconds ?? 0.05, 0.05),
    id: String(layer?.id || fallbackLayer.id).trim() || fallbackLayer.id,
    libraryId: String(layer?.libraryId ?? fallbackConfig.soundEffectsLibraryId ?? fallbackLayer.libraryId).trim(),
    maxSimultaneous: Math.max(1, Math.min(8, Math.floor(Number(layer?.maxSimultaneous ?? fallbackConfig.soundEffectsMaxSimultaneous ?? 2) || 2))),
    minSpacingSeconds: normalizeSoundEffectsSpacing(layer?.minSpacingSeconds ?? fallbackConfig.soundEffectsMinSpacingSeconds ?? 4, 4),
    name: String(layer?.name || `Layer ${index + 1}`).trim() || `Layer ${index + 1}`,
    schedulingMode: getMediaCompositionSoundEffectsMode(layer?.schedulingMode ?? layer?.mode ?? fallbackConfig.soundEffectsSchedulingMode),
    seed: String(layer?.seed ?? fallbackConfig.soundEffectsSeed ?? '').trim(),
    volume: normalizeVolumeGain(layer?.volume ?? fallbackConfig.soundEffectsVolume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME),
  };
}

function getMediaCompositionSoundEffectsLayersForUi(config = {}, libraries = []) {
  const layers = Array.isArray(config.soundEffectsLayers) ? config.soundEffectsLayers : [];
  if (layers.length) {
    return layers.map((layer, index) => normalizeMediaCompositionSoundEffectsLayerForUi(layer, index, libraries, config));
  }
  if (config.soundEffectsEnabled === true || config.soundEffectsLibraryId) {
    return [normalizeMediaCompositionSoundEffectsLayerForUi({
      libraryId: config.soundEffectsLibraryId || libraries[0]?.id || '',
      schedulingMode: config.soundEffectsSchedulingMode,
      volume: config.soundEffectsVolume,
      density: config.soundEffectsDensity,
      minSpacingSeconds: config.soundEffectsMinSpacingSeconds,
      maxSimultaneous: config.soundEffectsMaxSimultaneous,
      avoidRepeats: config.soundEffectsAvoidRepeats,
      fadeSeconds: config.soundEffectsFadeSeconds,
      seed: config.soundEffectsSeed,
      name: 'Layer 1',
    }, 0, libraries, config)];
  }
  return [];
}
function getMediaCompositionTransitionMode(value) {
  const mode = String(value || '').trim();
  return Object.values(MEDIA_COMPOSITION_TRANSITION_MODES || {}).includes(mode) ? mode : 'off';
}

function getMediaCompositionTransitionCategory(value) {
  const categoryId = String(value || '').trim();
  return MEDIA_COMPOSITION_TRANSITION_CATEGORY_OPTIONS.some((category) => category.id === categoryId) ? categoryId : 'fades';
}

function getMediaCompositionSelectedTransitions(value) {
  return Array.isArray(value) && value.length ? value : ['fade', 'dissolve'];
}

function isDraftSecondsValue(value) {
  return /^\d*(?:\.\d*)?$/.test(String(value || ''));
}

function normalizeVolumeGain(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(2, numeric));
}

function formatVolumePercent(value, fallback) {
  return Math.round(normalizeVolumeGain(value, fallback) * 100);
}

function formatAudioMixSummary(audioMix) {
  const narrationPercent = formatVolumePercent(audioMix?.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME);
  const backgroundPercent = formatVolumePercent(audioMix?.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME);
  const sfxPercent = formatVolumePercent(audioMix?.soundEffectsVolume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME);
  if (audioMix?.soundEffectsEnabled && Number(audioMix?.soundEffectsEventCount || 0) > 0) {
    return `This export mixed ${audioMix.soundEffectsEventCount} sound effect${audioMix.soundEffectsEventCount === 1 ? '' : 's'} at ${sfxPercent}%.`;
  }
  if (audioMix?.mode === 'mixed-with-background-music') {
    return `Background music was mixed beneath narration at ${backgroundPercent}%; narration was kept at ${narrationPercent}%.`;
  }
  if (audioMix?.mode === 'background-music-only') {
    return `This export used the connected background music track at ${backgroundPercent}% because no primary narration track was attached.`;
  }
  if (audioMix?.mode === 'primary-audio-only') {
    return `This export used the primary narration track at ${narrationPercent}%.`;
  }
  return 'This export did not include audio.';
}

const BURN_SUBTITLES_CAPTION_MODE_OPTIONS = Object.freeze([
  ['auto', 'Auto'], ['transcriptSegments', 'Transcript segments'], ['subtitleFile', 'Subtitle file'], ['manualLines', 'Manual text lines'],
]);
const BURN_SUBTITLES_TEXT_COLOR_OPTIONS = Object.freeze([
  ['white', 'White'], ['black', 'Black'], ['yellow', 'Yellow'], ['red', 'Red'], ['blue', 'Blue'], ['green', 'Green'], ['cyan', 'Cyan'], ['magenta', 'Magenta'], ['lightGray', 'Light gray'], ['darkGray', 'Dark gray'],
]);
const BURN_SUBTITLES_OUTLINE_COLOR_OPTIONS = Object.freeze([
  ['black', 'Black'], ['white', 'White'], ['darkGray', 'Dark gray'], ['lightGray', 'Light gray'], ['yellow', 'Yellow'], ['red', 'Red'], ['blue', 'Blue'],
]);
const BURN_SUBTITLES_POSITION_OPTIONS = Object.freeze([
  ['bottomCenter', 'Bottom center'], ['bottomLeft', 'Bottom left'], ['bottomRight', 'Bottom right'], ['topCenter', 'Top center'], ['topLeft', 'Top left'], ['topRight', 'Top right'], ['center', 'Center'],
]);
const BURN_SUBTITLES_FONT_PRESET_OPTIONS = Object.freeze([
  ['arial', 'Arial'], ['segoeUi', 'Segoe UI'], ['tahoma', 'Tahoma'], ['verdana', 'Verdana'],
]);
const BURN_SUBTITLES_BACKGROUND_OPACITY_OPTIONS = Object.freeze([
  ['25', '25%'], ['50', '50%'], ['75', '75%'], ['100', '100%'],
]);
const BURN_SUBTITLES_FONT_SOURCE_OPTIONS = Object.freeze([['preset', 'Built-in preset'], ['assetLibrary', 'Asset Library font']]);
const BURN_SUBTITLES_COLOR_SOURCE_OPTIONS = Object.freeze([['manual', 'Manual colors'], ['palette', 'Color Palette library']]);

function normalizeRetryNumber(value, fallback, minValue = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(Math.max(minValue, numeric) * 10) / 10;
}

function normalizeRetryOption(value, options, fallback) {
  const normalized = String(value || fallback).trim();
  return options.some(([optionValue]) => optionValue === normalized) ? normalized : fallback;
}

function normalizeRetryBackgroundOpacity(value, fallback = 50) {
  const numeric = Number(value);
  return [25, 50, 75, 100].includes(numeric) ? numeric : fallback;
}

function normalizeRetrySoundEffectsLayers(layers = []) {
  return (Array.isArray(layers) ? layers : []).map((layer, index) => ({
    ...layer,
    id: String(layer?.id || layer?.layerId || `sfx-layer-${index + 1}`).trim() || `sfx-layer-${index + 1}`,
    name: String(layer?.name || layer?.layerName || `Layer ${index + 1}`).trim() || `Layer ${index + 1}`,
    volume: normalizeVolumeGain(layer?.volume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME),
  }));
}

function normalizeRetryImageTimingMode(value) {
  return value === 'dynamicFromImageMetadata' ? 'dynamicFromImageMetadata' : 'fixedDurationPerImage';
}

function getPendingMediaCompositionRetryDefaults(pendingValidation) {
  const control = pendingValidation?.retryControls?.mediaComposition || null;
  if (!control) {
    return null;
  }

  return {
    backgroundMusicVolume: normalizeVolumeGain(control.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME),
    compositionMode: getMediaCompositionMode(control),
    imageTimingMode: normalizeRetryImageTimingMode(control.imageTimingMode),
    narrationVolume: normalizeVolumeGain(control.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME),
    sourceVideoVolume: normalizeVolumeGain(control.sourceVideoVolume, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME),
    sceneTransitionCategory: getMediaCompositionTransitionCategory(control.sceneTransitionCategory),
    sceneTransitionDurationSeconds: normalizeRetryNumber(control.sceneTransitionDurationSeconds, 0.5, 0.1),
    sceneTransitionMode: getMediaCompositionTransitionMode(control.sceneTransitionMode),
    sceneTransitionName: String(control.sceneTransitionName || 'fade').trim() || 'fade',
    secondsPerItem: normalizeRetryNumber(control.secondsPerItem, 4, 0.1),
    soundEffectsEnabled: control.soundEffectsEnabled === true,
    soundEffectsGlobalGuardEnabled: control.soundEffectsGlobalGuardEnabled === true,
    soundEffectsGlobalMaxSimultaneous: Math.max(1, Math.min(8, Math.floor(Number(control.soundEffectsGlobalMaxSimultaneous || DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS) || DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS))),
    soundEffectsGlobalMinSpacingSeconds: normalizeRetryNumber(control.soundEffectsGlobalMinSpacingSeconds, DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS, 0),
    soundEffectsLayers: normalizeRetrySoundEffectsLayers(control.soundEffectsLayers),
    soundEffectsGlobalVolume: normalizeVolumeGain(control.soundEffectsGlobalVolume, 1),
    soundEffectsVolume: normalizeVolumeGain(control.soundEffectsVolume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME),
  };
}

function getMediaCompositionRetryPayload(retryOverrides) {
  if (!retryOverrides || typeof retryOverrides !== 'object') {
    return null;
  }

  const compositionMode = getMediaCompositionMode(retryOverrides);
  return {
    backgroundMusicVolume: normalizeVolumeGain(retryOverrides.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME),
    compositionMode,
    ...(compositionMode === 'imageSlideshow' ? {
      imageTimingMode: normalizeRetryImageTimingMode(retryOverrides.imageTimingMode),
      secondsPerItem: normalizeRetryNumber(retryOverrides.secondsPerItem, 4, 0.1),
    } : {}),
    narrationVolume: normalizeVolumeGain(retryOverrides.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME),
    ...(compositionMode !== MEDIA_COMPOSITION_MODES.IMAGE_SLIDESHOW ? {
      sourceVideoVolume: normalizeVolumeGain(retryOverrides.sourceVideoVolume, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME),
    } : {}),
    ...(compositionMode !== 'singleVideoMix' ? {
      sceneTransitionCategory: getMediaCompositionTransitionCategory(retryOverrides.sceneTransitionCategory),
      sceneTransitionDurationSeconds: normalizeRetryNumber(retryOverrides.sceneTransitionDurationSeconds, 0.5, 0.1),
      sceneTransitionMode: getMediaCompositionTransitionMode(retryOverrides.sceneTransitionMode),
      sceneTransitionName: String(retryOverrides.sceneTransitionName || 'fade').trim() || 'fade',
    } : {}),
    soundEffectsEnabled: retryOverrides.soundEffectsEnabled === true,
    soundEffectsGlobalGuardEnabled: retryOverrides.soundEffectsGlobalGuardEnabled === true,
    soundEffectsGlobalMaxSimultaneous: Math.max(1, Math.min(8, Math.floor(Number(retryOverrides.soundEffectsGlobalMaxSimultaneous || DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS) || DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS))),
    soundEffectsGlobalMinSpacingSeconds: normalizeRetryNumber(retryOverrides.soundEffectsGlobalMinSpacingSeconds, DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS, 0),
    soundEffectsLayers: normalizeRetrySoundEffectsLayers(retryOverrides.soundEffectsLayers),
    soundEffectsGlobalVolume: normalizeVolumeGain(retryOverrides.soundEffectsGlobalVolume, 1),
    soundEffectsVolume: normalizeVolumeGain(retryOverrides.soundEffectsVolume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME),
  };
}
function getPendingBurnSubtitlesRetryDefaults(pendingValidation) {
  const settings = pendingValidation?.retryControls?.burnSubtitles?.settings || null;
  if (!settings) {
    return null;
  }

  return {
    backgroundBox: settings.backgroundBox === true,
    backgroundOpacity: normalizeRetryBackgroundOpacity(settings.backgroundOpacity, 50),
    bold: settings.bold === true,
    bottomMargin: normalizeRetryNumber(settings.bottomMargin, 32, 0),
    captionMode: normalizeRetryOption(settings.captionMode, BURN_SUBTITLES_CAPTION_MODE_OPTIONS, 'auto'),
    durationPerCaptionSeconds: normalizeRetryNumber(settings.durationPerCaptionSeconds, 3, 0.1),
    fontPreset: normalizeRetryOption(settings.fontPreset, BURN_SUBTITLES_FONT_PRESET_OPTIONS, 'arial'),
    fontSource: normalizeRetryOption(settings.fontSource, BURN_SUBTITLES_FONT_SOURCE_OPTIONS, 'preset'),
    fontLibraryId: String(settings.fontLibraryId || '').trim(),
    fontItemId: String(settings.fontItemId || '').trim(),
    fontSize: normalizeRetryNumber(settings.fontSize, 28, 1),
    italic: settings.italic === true,
    outline: normalizeRetryNumber(settings.outline, 2, 0),
    outlineColor: normalizeRetryOption(settings.outlineColor, BURN_SUBTITLES_OUTLINE_COLOR_OPTIONS, 'black'),
    backgroundColor: normalizeRetryOption(settings.backgroundColor, BURN_SUBTITLES_TEXT_COLOR_OPTIONS, 'black'),
    colorSource: normalizeRetryOption(settings.colorSource, BURN_SUBTITLES_COLOR_SOURCE_OPTIONS, 'manual'),
    colorPaletteLibraryId: String(settings.colorPaletteLibraryId || '').trim(),
    textColorPaletteItemId: String(settings.textColorPaletteItemId || '').trim(),
    outlineColorPaletteItemId: String(settings.outlineColorPaletteItemId || '').trim(),
    backgroundColorPaletteItemId: String(settings.backgroundColorPaletteItemId || '').trim(),
    position: normalizeRetryOption(settings.position, BURN_SUBTITLES_POSITION_OPTIONS, 'bottomCenter'),
    shadow: normalizeRetryNumber(settings.shadow, 1, 0),
    textColor: normalizeRetryOption(settings.textColor, BURN_SUBTITLES_TEXT_COLOR_OPTIONS, 'white'),
  };
}

function getBurnSubtitlesRetryPayload(retryOverrides) {
  if (!retryOverrides || typeof retryOverrides !== 'object') {
    return null;
  }

  return {
    backgroundBox: retryOverrides.backgroundBox === true,
    backgroundOpacity: normalizeRetryBackgroundOpacity(retryOverrides.backgroundOpacity, 50),
    bold: retryOverrides.bold === true,
    bottomMargin: normalizeRetryNumber(retryOverrides.bottomMargin, 32, 0),
    captionMode: normalizeRetryOption(retryOverrides.captionMode, BURN_SUBTITLES_CAPTION_MODE_OPTIONS, 'auto'),
    durationPerCaptionSeconds: normalizeRetryNumber(retryOverrides.durationPerCaptionSeconds, 3, 0.1),
    fontPreset: normalizeRetryOption(retryOverrides.fontPreset, BURN_SUBTITLES_FONT_PRESET_OPTIONS, 'arial'),
    fontSource: normalizeRetryOption(retryOverrides.fontSource, BURN_SUBTITLES_FONT_SOURCE_OPTIONS, 'preset'),
    fontLibraryId: String(retryOverrides.fontLibraryId || '').trim(),
    fontItemId: String(retryOverrides.fontItemId || '').trim(),
    fontSize: normalizeRetryNumber(retryOverrides.fontSize, 28, 1),
    italic: retryOverrides.italic === true,
    outline: normalizeRetryNumber(retryOverrides.outline, 2, 0),
    outlineColor: normalizeRetryOption(retryOverrides.outlineColor, BURN_SUBTITLES_OUTLINE_COLOR_OPTIONS, 'black'),
    backgroundColor: normalizeRetryOption(retryOverrides.backgroundColor, BURN_SUBTITLES_TEXT_COLOR_OPTIONS, 'black'),
    colorSource: normalizeRetryOption(retryOverrides.colorSource, BURN_SUBTITLES_COLOR_SOURCE_OPTIONS, 'manual'),
    colorPaletteLibraryId: String(retryOverrides.colorPaletteLibraryId || '').trim(),
    textColorPaletteItemId: String(retryOverrides.textColorPaletteItemId || '').trim(),
    outlineColorPaletteItemId: String(retryOverrides.outlineColorPaletteItemId || '').trim(),
    backgroundColorPaletteItemId: String(retryOverrides.backgroundColorPaletteItemId || '').trim(),
    position: normalizeRetryOption(retryOverrides.position, BURN_SUBTITLES_POSITION_OPTIONS, 'bottomCenter'),
    shadow: normalizeRetryNumber(retryOverrides.shadow, 1, 0),
    textColor: normalizeRetryOption(retryOverrides.textColor, BURN_SUBTITLES_TEXT_COLOR_OPTIONS, 'white'),
  };
}

function getPendingRecordInputRetryDefaults(pendingValidation) {
  const settings = pendingValidation?.retryControls?.recordInput?.settings;
  if (!settings || typeof settings !== 'object') {
    return null;
  }
  return {
    ...settings,
    captureTarget: settings.captureTarget && typeof settings.captureTarget === 'object'
      ? { ...settings.captureTarget }
      : { type: 'desktop' },
  };
}

function getRecordInputRetryPayload(retryOverrides) {
  if (!retryOverrides || typeof retryOverrides !== 'object') {
    return null;
  }
  return {
    captureTarget: retryOverrides.captureTarget && typeof retryOverrides.captureTarget === 'object'
      ? { ...retryOverrides.captureTarget }
      : undefined,
    displayId: String(retryOverrides.displayId || '').trim(),
    fps: Number(retryOverrides.fps),
    microphoneId: String(retryOverrides.microphoneId || '').trim(),
    mode: String(retryOverrides.mode || '').trim(),
    webcamId: String(retryOverrides.webcamId || '').trim(),
  };
}

function getPendingValidationRetryDefaults(pendingValidation) {
  return {
    mediaComposition: getPendingMediaCompositionRetryDefaults(pendingValidation),
    burnSubtitles: getPendingBurnSubtitlesRetryDefaults(pendingValidation),
    recordInput: getPendingRecordInputRetryDefaults(pendingValidation),
  };
}

function getPipelinePortCenterKey(nodeId, direction, portId) {
  return [String(nodeId || ''), String(direction || ''), String(portId || '')].join(':');
}

function arePipelinePortCenterMapsEqual(left = {}, right = {}) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => {
    const leftPoint = left[key];
    const rightPoint = right[key];
    return rightPoint && Math.abs(leftPoint.x - rightPoint.x) < 0.5 && Math.abs(leftPoint.y - rightPoint.y) < 0.5;
  });
}

const TEMPLATE_STATUS_LABELS = Object.freeze({
  [TEMPLATE_STATUS.READY]: 'Ready',
  [TEMPLATE_STATUS.CONFIGURABLE]: 'Ready to configure',
  [TEMPLATE_STATUS.MISSING_REQUIREMENTS]: 'Needs requirements',
  [TEMPLATE_STATUS.UNAVAILABLE]: 'Unavailable',
});

function getTemplateStatusLabel(readiness) {
  if (readiness?.missingTools?.length) return 'Needs tool install';
  if (readiness?.missingProviders?.length) return 'Needs provider/API key';
  if (readiness?.missingModels?.length) return 'Needs model';
  if (readiness?.warnings?.some((warning) => /hardware|below|vram|ram/i.test(warning))) return 'Hardware warning';
  return TEMPLATE_STATUS_LABELS[readiness?.status] || 'Ready to configure';
}

function getTemplateStatusTone(readiness) {
  if (readiness?.status === TEMPLATE_STATUS.READY) return 'good';
  if (readiness?.status === TEMPLATE_STATUS.UNAVAILABLE || readiness?.missingTools?.length || readiness?.missingProviders?.length) return 'warn';
  if (readiness?.warnings?.length) return 'warn';
  return 'info';
}

function getTemplateActionLabel(readiness) {
  if (readiness?.status === TEMPLATE_STATUS.UNAVAILABLE) return 'View requirements';
  if (readiness?.status === TEMPLATE_STATUS.MISSING_REQUIREMENTS) return 'Use anyway';
  return 'Use template';
}

function getTemplateDetailLines(readiness) {
  return [
    ...(readiness?.missingTools?.length ? ['Missing tools: ' + readiness.missingTools.join(', ')] : []),
    ...(readiness?.missingProviders?.length ? ['Missing providers/API keys: ' + readiness.missingProviders.join(', ')] : []),
    ...(readiness?.missingModels?.length ? readiness.missingModels : []),
    ...(readiness?.missingPresets?.length ? readiness.missingPresets : []),
    ...(readiness?.warnings || []),
    ...(readiness?.notes || []),
  ];
}
function getCollectionMapDefaultInstruction(operationId, mapping = null) {
  return operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE && mapping?.inputKind === 'text' ? COLLECTION_MAP_TEXT_TO_IMAGE_DEFAULT_INSTRUCTION : '';
}

function getCollectionMapInstructionValue(node, operationId) {
  const instruction = String(node?.config?.instruction || '');
  if (instruction.trim() === COLLECTION_MAP_TEXT_TO_IMAGE_DEFAULT_INSTRUCTION && (operationId !== PIPELINE_OPERATION_IDS.IMAGE_GENERATE || getCollectionMapMapping(node)?.inputKind !== 'text')) {
    return '';
  }
  return instruction;
}

function isPromptStyleCompatibleWithTarget(style, targetKind) {
  const target = String(targetKind || '').trim().toLowerCase();
  if (!target) return false;
  const rawKinds = Array.isArray(style?.targetKinds) ? style.targetKinds : [style?.targetKind || 'any'];
  const kinds = rawKinds.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean);
  return kinds.includes('any') || kinds.includes(target);
}

function getPromptStyleTargetKindForOperation(operationId) {
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) return 'image';
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) return 'audio';
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) return 'video';
  if (operationId === PIPELINE_OPERATION_IDS.LLM_PROMPT) return 'text';
  return '';
}

function getPromptStyleTargetKindForModelStep(node) {
  const operationId = getSelectedModelStepOperationId(node);
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE && node?.config?.executionMode === 'localTool' && (getModelStepLocalAudioModeForUi(node) === 'continuation' || getModelStepLocalAudioModeForUi(node) === 'referenceVoiceTts')) {
    return '';
  }
  return getPromptStyleTargetKindForOperation(operationId);
}

function getPromptStyleTargetKindForCollectionMap(mapping) {
  if (!mapping || mapping.inputKind !== 'text') return '';
  return getPromptStyleTargetKindForOperation(mapping.operationId);
}

function PromptStyleSelector({ id, onChange, promptStyles = [], targetKind, value }) {
  const compatibleStyles = (promptStyles || []).filter((style) => isPromptStyleCompatibleWithTarget(style, targetKind));
  const selectedStyle = value ? (promptStyles || []).find((style) => style.id === value) : null;
  if (!targetKind) {
    return null;
  }

  return (
    <div>
      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={id}>Prompt style</label>
      <select className="store-input mt-3" id={id} onChange={(event) => onChange(event.target.value)} value={value || ''}>
        <option value="">None</option>
        {selectedStyle && !compatibleStyles.some((style) => style.id === selectedStyle.id) ? <option disabled value={selectedStyle.id}>{selectedStyle.name} (not compatible)</option> : null}
        {compatibleStyles.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
      </select>
    </div>
  );
}

function getCollectionMapModelFieldLabel(operationId) {
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) return 'AudioCraft model';
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) return 'Voice model';
  if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) return 'Transcription model';
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) return 'Model set override';
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) return 'Analysis mode';
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) return 'Wan model folder';
  return 'Checkpoint';
}

function getCollectionMapModelPlaceholder(operationId) {
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) return 'Blank for default, or pick a downloaded AudioCraft snapshot';
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) return 'Enter or pick an RVC voice model file';
  if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) return 'base';
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) return 'Optional Upscayl paired model set';
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) return 'clip or deepdanbooru';
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) return 'Blank for auto-detect, or pick a Wan2.1 model folder';
  return 'Enter or pick a checkpoint file name';
}

function getCollectionMapRefreshLabel(operationId) {
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) return 'Refresh snapshots';
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) return 'Refresh voice models';
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) return 'Refresh model sets';
  if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) return 'Refresh models';
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) return 'Refresh modes';
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) return 'Refresh Wan models';
  return 'Refresh models';
}

function getCollectionMapInstructionLabel(operationId, executionMode, mapping = null) {
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE && mapping?.inputKind === 'image') return 'Shared image edit instruction';
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) return 'Prompt prefix / style guidance';
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) return executionMode === 'localTool' ? 'Prompt shaping / audio guidance' : 'Speech guidance / delivery hint';
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) return 'Transformation note';
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) return 'Analysis instruction';
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE && mapping?.inputKind === 'image') return 'Shared motion guidance';
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) return 'Motion guidance / prompt prefix';
  return 'Shared instruction';
}

function getCollectionMapInstructionPlaceholder(operationId, executionMode, mapping = null) {
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE && mapping?.inputKind === 'image') return 'Describe how each source image should be edited.';
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) return 'Optional style or scene guidance to prepend to each text prompt.';
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) return executionMode === 'localTool' ? 'Optional genre, mood, instrumentation, or sound-design guidance prepended to each text item.' : 'Optional delivery guidance for each speech request.';
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) return 'Optional note stored with each transformed audio item.';
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) return 'Optional analysis request for each image.';
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE && mapping?.inputKind === 'image') return 'Describe the motion to apply to every source image. Required for image-to-video.';
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) return 'Optional motion guidance prepended to each text prompt. Required when a clip uses a reference image.';
  return 'Optional instruction applied to each mapped item.';
}

const {
  COLLECTION_INPUT_ITEM_TYPE_OPTIONS: COLLECTION_INPUT_ITEM_BASE_OPTIONS,
  addCollectionInputFileItemToNode,
  addCollectionInputTextItemToNode,
  getCollectionInputItemId,
  getCollectionInputItems,
  moveCollectionInputItemInNode,
  normalizeCollectionInputItemType,
  removeCollectionInputItemFromNode,
  updateCollectionInputItemInNode,
} = collectionInputState;
const COLLECTION_INPUT_ITEM_TYPE_OPTIONS = Object.freeze(COLLECTION_INPUT_ITEM_BASE_OPTIONS.map((option) => ({
  ...option,
  label: PIPELINE_PORT_KIND_LABELS[option.kind] || option.kind,
})));
function formatRendererDiagnosticError(error) {
  if (!error) {
    return null;
  }

  return {
    message: String(error.message || error),
    name: String(error.name || 'Error'),
    stack: String(error.stack || ''),
  };
}

function logPipelineBuilderRendererEvent(message, context = {}, level = 'error') {
  try {
    const logger = window?.localAIHub?.logRendererEvent;
    if (typeof logger === 'function') {
      Promise.resolve(logger({ context, level, message, source: 'pipeline-builder' })).catch(() => {});
    }
  } catch {
    // Keep renderer diagnostics best-effort only.
  }
}

function clampValue(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizePipelineSectionVisibility(value) {
  const normalized = { ...DEFAULT_PIPELINE_SECTION_VISIBILITY };
  if (!value || typeof value !== 'object') {
    return normalized;
  }

  for (const key of Object.keys(normalized)) {
    normalized[key] = false;
  }

  const firstOpenKey = Object.keys(DEFAULT_PIPELINE_SECTION_VISIBILITY).find((key) => value[key] === true) || 'canvas';
  normalized[firstOpenKey] = true;

  return normalized;
}

function getPipelineSectionPanelClass(expanded) {
  return expanded ? 'panel p-4 xl:col-span-2 2xl:col-span-3' : 'panel p-3';
}

function getPlanningSchemaOptionById(schemaId) {
  const normalizedSchemaId = String(schemaId || '').trim();
  return PLANNING_SCHEMA_OPTIONS.find((entry) => entry.id === normalizedSchemaId)
    || PLANNING_SCHEMA_OPTIONS.find((entry) => entry.id === DEFAULT_PLANNING_SCHEMA_ID)
    || null;
}

function fileNameFromPath(value) {
  return String(value || '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

function formatDateLabel(value) {
  if (!value) {
    return 'Never';
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatArtifactKindLabel(kind, itemKind = '') {
  const normalizedKind = String(kind || '').trim();
  const normalizedItemKind = String(itemKind || '').trim();
  if (normalizedKind === 'collection') {
    return normalizedItemKind
      ? `${PIPELINE_PORT_KIND_LABELS[normalizedItemKind] || normalizedItemKind || 'Artifact'} Collection`
      : 'Collection';
  }

  return PIPELINE_PORT_KIND_LABELS[normalizedKind] || 'Artifact';
}

function isCollectionArtifact(artifact) {
  return artifact?.kind === 'collection' && Array.isArray(artifact?.items);
}

function getArtifactStoragePath(artifact) {
  return artifact?.destinationPath || artifact?.directoryPath || artifact?.filePath || '';
}

function getPrimaryNodeOutputArtifact(nodeState) {
  const outputs = Object.values(nodeState?.outputs || {}).filter(Boolean);
  return outputs[0] || null;
}

function shouldShowInlineNodeArtifactPreview(artifact) {
  const previewKind = getArtifactPreviewKind(artifact);
  return ['planning-packet', 'plan', 'preview', 'audit'].includes(previewKind);
}

function getArtifactPreviewKind(artifact) {
  if (!artifact) {
    return '';
  }

  if (artifact.previewKind) {
    return artifact.previewKind;
  }

  if (artifact.kind === 'text') {
    return 'text';
  }

  if (artifact.kind === 'audio') {
    return 'audio';
  }

  if (artifact.kind === 'planningPacket') {
    return 'planning-packet';
  }

  if (artifact.kind === 'plan') {
    return 'plan';
  }

  if (artifact.kind === 'preview') {
    return 'preview';
  }

  if (artifact.kind === 'audit') {
    return 'audit';
  }

  if (artifact.kind === 'video') {
    return String(artifact.mimeType || '').toLowerCase().startsWith('image/') ? 'animated-image' : 'video';
  }

  if (artifact.kind === 'image') {
    return artifact.isAnimated ? 'animated-image' : 'image';
  }

  return String(artifact.mimeType || '').toLowerCase().startsWith('image/')
    ? (artifact.isAnimated ? 'animated-image' : 'image')
    : 'file';
}

function formatFileSize(sizeBytes) {
  const numericSize = Number(sizeBytes || 0);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return '';
  }

  if (numericSize >= 1024 * 1024) {
    return `${Math.max(0.1, Math.round((numericSize / 1024 / 1024) * 10) / 10)} MB`;
  }

  return `${Math.max(1, Math.round(numericSize / 1024))} KB`;
}

function getIncomingConnectionCount(graph, nodeId, portId) {
  const portKey = `${nodeId}:${portId}`;
  const incomingEdges = graph?.incomingEdgesByPortKey?.get?.(portKey);
  if (Array.isArray(incomingEdges)) {
    return incomingEdges.length;
  }

  return graph?.incomingEdgeByPortKey?.has?.(portKey) ? 1 : 0;
}

function formatAttemptLabel(iteration, loopMaxAttempts) {
  const attemptNumber = Number(iteration || 0);
  const maxAttempts = Number(loopMaxAttempts || 0);
  if (maxAttempts > 0) {
    return `Attempt ${Math.max(1, attemptNumber || 1)} of ${maxAttempts}`;
  }

  if (attemptNumber > 1) {
    return `Attempt ${attemptNumber}`;
  }

  return '';
}

function getRetryLoopTargetOptions(nodes = [], graph, loopNodeId) {
  const loopNode = (Array.isArray(nodes) ? nodes : []).find((node) => node.id === loopNodeId);
  if (!loopNode) {
    return [];
  }

  const upstreamNodeIds = new Set();
  const queue = [loopNodeId];
  while (queue.length > 0) {
    const currentNodeId = queue.shift();
    for (const edge of graph?.incomingEdgesByNode?.get?.(currentNodeId) || []) {
      if (upstreamNodeIds.has(edge.source.nodeId)) {
        continue;
      }

      upstreamNodeIds.add(edge.source.nodeId);
      queue.push(edge.source.nodeId);
    }
  }

  const candidateNodes = (Array.isArray(nodes) ? nodes : []).filter((node) => {
    if (!node || node.id === loopNodeId || node.type === 'retryLoop') {
      return false;
    }

    if (getPipelineNodeDefinition(node.type)?.terminal) {
      return false;
    }

    return upstreamNodeIds.size === 0 || upstreamNodeIds.has(node.id);
  });

  if (candidateNodes.length) {
    return candidateNodes;
  }

  return (Array.isArray(nodes) ? nodes : []).filter((node) => node?.id !== loopNodeId && node?.type !== 'retryLoop' && !getPipelineNodeDefinition(node.type)?.terminal);
}

function formatAudioDurationLabel(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }

  if (numeric >= 60) {
    const minutes = Math.floor(numeric / 60);
    const seconds = Math.round((numeric - (minutes * 60)) * 10) / 10;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${Math.round(numeric * 10) / 10}s`;
}

function buildAudioChannelFact(channelCount) {
  const numeric = Number(channelCount || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }

  if (numeric === 1) {
    return 'Mono';
  }

  if (numeric === 2) {
    return 'Stereo';
  }

  return `${numeric} channels`;
}

function buildAudioFactLabels(artifact) {
  const audio = artifact?.audio && typeof artifact.audio === 'object' ? artifact.audio : null;
  const generation = artifact?.audioGeneration && typeof artifact.audioGeneration === 'object' ? artifact.audioGeneration : null;
  const transformation = artifact?.audioTransformation && typeof artifact.audioTransformation === 'object' ? artifact.audioTransformation : null;
  const mode = String(generation?.mode || '').trim().toLowerCase();
  const transformationType = String(transformation?.transformationType || '').trim().toLowerCase();
  return [
    formatAudioDurationLabel(audio?.durationSeconds || generation?.durationSeconds || transformation?.durationSeconds),
    audio?.sampleRate ? `${audio.sampleRate} Hz` : '',
    buildAudioChannelFact(audio?.channelCount),
    transformationType === 'voice-conversion' ? 'Voice conversion' : transformation?.transformationType ? transformation.transformationType : '',
    mode === 'music' ? 'Music mode' : mode === 'sound' ? 'Sound mode' : mode === 'continuation' ? 'Continuation mode' : mode === 'referenceVoiceTts' ? 'Reference Voice TTS' : mode === 'speech' ? 'Speech mode' : '',
    transformation?.toolLabel || transformation?.backendLabel || generation?.toolLabel || generation?.backendLabel || '',
    transformation?.targetVoice ? `Voice ${transformation.targetVoice}` : generation?.voice ? `Voice ${generation.voice}` : '',
  ].filter(Boolean);
}
function buildImageFactLabels(artifact) {
  const transformation = artifact?.imageTransformation && typeof artifact.imageTransformation === 'object' ? artifact.imageTransformation : null;
  const transformationType = String(transformation?.transformSubtype || transformation?.transformationType || '').trim().toLowerCase();
  return [
    transformationType === 'upscale' ? 'Upscale' : transformationType === 'enhance' ? 'Enhance' : transformationType === 'face-swap' ? 'Face swap' : transformationType ? transformationType.replace(/-/g, ' ') : '',
    transformation?.toolLabel || transformation?.backendLabel || '',
    transformation?.scale ? `${transformation.scale}x scale` : '',
    transformation?.sourceImage?.fileName ? `Target ${transformation.sourceImage.fileName}` : '',
    transformation?.referenceImage?.fileName ? `Reference ${transformation.referenceImage.fileName}` : '',
  ].filter(Boolean);
}

function buildCollectionFactLabels(artifact) {
  const itemCount = Number(artifact?.itemCount || artifact?.items?.length || 0) || 0;
  return [
    formatArtifactKindLabel('collection', artifact?.itemKind),
    itemCount ? `${itemCount} items` : '',
    'Ordered',
    artifact?.manifestPath ? 'Manifest saved' : '',
  ].filter(Boolean);
}

function buildCompositionFactLabels(artifact) {
  const tracks = Array.isArray(artifact?.composition?.tracks) ? artifact.composition.tracks : [];
  const visualTrack = tracks.find((track) => String(track?.role || '').trim() === 'primary-visual') || null;
  const audioTrack = tracks.find((track) => String(track?.role || '').trim() === 'primary-audio') || null;
  const backgroundMusicTrack = tracks.find((track) => String(track?.role || '').trim() === 'background-music') || null;
  const itemCount = Number(visualTrack?.itemCount || visualTrack?.items?.length || 0) || 0;
  const audioLabel = audioTrack && backgroundMusicTrack
    ? 'Narration + music'
    : audioTrack
      ? 'Primary audio'
      : backgroundMusicTrack
        ? 'Background music'
        : 'No audio';
  return [
    'Composition',
    itemCount ? `${itemCount} images` : '',
    Number(visualTrack?.itemDurationSeconds || 0) ? `${Math.round(Number(visualTrack.itemDurationSeconds) * 10) / 10}s each` : '',
    audioLabel,
    artifact?.manifestPath ? 'Manifest saved' : '',
  ].filter(Boolean);
}

function buildVideoFactLabels(artifact) {
  const exportProfile = artifact?.compositionExport && typeof artifact.compositionExport === 'object'
    ? artifact.compositionExport.exportProfile || null
    : null;
  const visualTrack = artifact?.compositionExport && typeof artifact.compositionExport === 'object'
    ? artifact.compositionExport.visualTrack || null
    : null;
  const audioMix = artifact?.compositionExport && typeof artifact.compositionExport === 'object'
    ? artifact.compositionExport.audioMix || null
    : null;
  if (!exportProfile && !visualTrack) {
    return [];
  }

  const audioLabel = audioMix?.mode === 'mixed-with-background-music'
    ? 'Narration + music'
    : audioMix?.mode === 'background-music-only'
      ? 'Background music'
      : artifact?.compositionExport?.audioTrack?.artifact
        ? 'Primary audio'
        : 'Silent export';

  return [
    'Composed video',
    exportProfile?.fps ? `${exportProfile.fps} fps` : '',
    exportProfile?.width && exportProfile?.height ? `${exportProfile.width}x${exportProfile.height}` : '',
    Number(visualTrack?.itemCount || 0) ? `${visualTrack.itemCount} images` : '',
    audioLabel,
  ].filter(Boolean);
}

function buildPlanningPacketFactLabels(artifact) {
  const packet = artifact?.packet && typeof artifact.packet === 'object' ? artifact.packet : {};
  const sourceCount = Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts.length : 0;
  const constraintCount = Array.isArray(packet.constraints) ? packet.constraints.length : 0;
  const riskCount = Array.isArray(packet.riskNotes) ? packet.riskNotes.length : 0;
  return [
    packet.schemaLabel || 'Planning packet',
    sourceCount ? sourceCount + ' source' + (sourceCount === 1 ? '' : 's') : '',
    constraintCount ? constraintCount + ' constraint' + (constraintCount === 1 ? '' : 's') : '',
    riskCount ? riskCount + ' risk note' + (riskCount === 1 ? '' : 's') : '',
  ].filter(Boolean);
}

function buildPlanFactLabels(artifact) {
  const plan = artifact?.plan && typeof artifact.plan === 'object' ? artifact.plan : {};
  const sceneCount = Array.isArray(plan.scenes) ? plan.scenes.length : Number(artifact?.sceneCount || 0) || 0;
  const sectionCount = Array.isArray(plan.sections) ? plan.sections.length : Number(artifact?.sectionCount || 0) || 0;
  const clipCount = Array.isArray(plan.clips) ? plan.clips.length : Number(artifact?.clipCount || 0) || 0;
  const openQuestionCount = Array.isArray(plan.openQuestions) ? plan.openQuestions.length : 0;
  return [
    artifact?.schemaLabel || getPlanningSchemaOptionById(plan.schemaId)?.label || 'Plan',
    sceneCount ? sceneCount + ' scene' + (sceneCount === 1 ? '' : 's') : '',
    sectionCount ? sectionCount + ' section' + (sectionCount === 1 ? '' : 's') : '',
    clipCount ? clipCount + ' clip' + (clipCount === 1 ? '' : 's') : '',
    openQuestionCount ? openQuestionCount + ' open question' + (openQuestionCount === 1 ? '' : 's') : '',
  ].filter(Boolean);
}

function buildPreviewFactLabels(artifact) {
  const preview = artifact?.preview && typeof artifact.preview === 'object' ? artifact.preview : {};
  const sceneCount = Array.isArray(preview.scenes) ? preview.scenes.length : Number(artifact?.sceneCount || 0) || 0;
  return [
    preview.schemaLabel || artifact?.schemaLabel || 'Preview',
    sceneCount ? sceneCount + ' scene' + (sceneCount === 1 ? '' : 's') : '',
    preview.previewMode ? 'Review cards' : '',
  ].filter(Boolean);
}

function buildAuditFactLabels(artifact) {
  const audit = artifact?.audit && typeof artifact.audit === 'object' ? artifact.audit : {};
  const summary = audit.summary && typeof audit.summary === 'object' ? audit.summary : {};
  const findingCount = Number(summary.errorCount || 0) + Number(summary.warningCount || 0) + Number(summary.infoCount || 0);
  return [
    audit.schemaLabel || artifact?.schemaLabel || 'Audit',
    audit.sceneCount ? audit.sceneCount + ' scene' + (audit.sceneCount === 1 ? '' : 's') : '',
    findingCount ? findingCount + ' finding' + (findingCount === 1 ? '' : 's') : 'No findings',
    audit.previewCoverage?.connected ? 'Preview checked' : 'Plan only',
  ].filter(Boolean);
}

function PlanningTextBlock({ title, value }) {
  if (!value) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</p>
      <p className="mt-3 text-sm leading-6 text-slate-200 whitespace-pre-wrap">{value}</p>
    </div>
  );
}

function PlanningListBlock({ title, items }) {
  const normalizedItems = (Array.isArray(items) ? items : []).map((entry) => String(entry || '').trim()).filter(Boolean);
  if (!normalizedItems.length) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</p>
      <div className="mt-3 space-y-2">
        {normalizedItems.map((entry, index) => (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm leading-6 text-slate-200" key={title + '-' + index}>
            {entry}
          </div>
        ))}
      </div>
    </div>
  );
}

function StructuredDataPreview({ value, className = '', minHeight = '220px' }) {
  return (
    <textarea
      className={'store-input resize-none font-mono text-[11px] leading-5 ' + className}
      readOnly
      style={{ minHeight }}
      value={JSON.stringify(value || {}, null, 2)}
    />
  );
}

function ArtifactFacts({ artifact, className = '' }) {
  if (!artifact) {
    return null;
  }

  const facts = artifact?.kind === 'composition'
    ? buildCompositionFactLabels(artifact)
    : isCollectionArtifact(artifact)
      ? buildCollectionFactLabels(artifact)
      : artifact?.kind === 'planningPacket'
        ? buildPlanningPacketFactLabels(artifact)
        : artifact?.kind === 'plan'
          ? buildPlanFactLabels(artifact)
          : artifact?.kind === 'preview'
            ? buildPreviewFactLabels(artifact)
            : artifact?.kind === 'audit'
              ? buildAuditFactLabels(artifact)
              : [
          formatArtifactKindLabel(artifact.kind, artifact.itemKind),
          artifact.formatLabel || '',
          artifact.mimeType || '',
          artifact.width && artifact.height ? `${artifact.width}x${artifact.height}` : '',
          formatFileSize(artifact.sizeBytes),
          artifact.fileName || '',
          ...buildImageFactLabels(artifact),
          ...buildVideoFactLabels(artifact),
        ].filter(Boolean);

  if (!facts.length) {
    return null;
  }

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {facts.map((fact, index) => (
        <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-300" key={`${fact}-${index}`}>
          {fact}
        </span>
      ))}
    </div>
  );
}

function buildNodePreview(node, runState) {
  const nodeRunState = runState?.nodeStates?.[node.id];
  if (nodeRunState?.preview) {
    return nodeRunState.preview;
  }

  if (node.type === 'textInput') {
    return summarizePreview(node.config?.text || '');
  }

  if (node.type === 'imageInput' || node.type === 'audioInput' || node.type === 'videoInput' || node.type === 'fileInput') {
    return fileNameFromPath(node.config?.filePath || '') || 'No file selected yet.';
  }
  if (node.type === 'collectionInput') {
    const itemType = normalizeCollectionInputItemType(node.config?.itemType);
    const itemCount = getCollectionInputItems(node).length;
    return itemCount
      ? itemCount + ' ' + (PIPELINE_PORT_KIND_LABELS[itemType] || itemType).toLowerCase() + ' item' + (itemCount === 1 ? '' : 's')
      : 'No collection items yet.';
  }
  if (node.type === 'llmPrompt') {
    const selectedOperationId = getSelectedModelStepOperationId(node);
    const localToolFallbackLabel = selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
      ? 'Local audio tool'
      : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
        ? 'Local audio transform tool'
        : selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
          ? 'Local image transform tool'
          : selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
            ? 'Local video tool'
            : 'Local image tool';
    const modeLabel = node.config?.executionMode === 'ollama'
      ? 'Ollama'
      : node.config?.executionMode === 'localTool'
        ? (node.config?.toolId || localToolFallbackLabel)
        : (node.config?.providerId || 'Cloud provider');
    return `${getModelStepOperationLabel(node)} | ${modeLabel}${node.config?.model ? ` | ${node.config.model}` : ''}`;
  }
  if (node.type === 'planningPacket') {
    const schema = getPlanningSchemaOptionById(node.config?.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
    return (schema?.label || 'Planning packet') + ' | ' + summarizePreview(node.config?.goal || 'Add a planning goal.');
  }

  if (node.type === 'planner') {
    const schema = getPlanningSchemaOptionById(node.config?.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
    const modeLabel = node.config?.executionMode === 'ollama' ? 'Ollama' : (node.config?.providerId || 'Cloud provider');
    return (schema?.label || 'Plan') + ' | ' + modeLabel + (node.config?.model ? ' | ' + node.config.model : '');
  }

  if (node.type === 'planScenes') {
    return 'Builds an ordered text collection from the connected Plan';
  }

  if (node.type === 'graphWorkflow') {
    const contract = getGraphWorkflowContract(node.config?.toolId);
    const workflowDefinition = parseGraphWorkflowDefinitionText(node.config?.toolId, node.config?.workflowText);
    const nodeCountLabel = workflowDefinition.ok
      ? workflowDefinition.nodeEntries.length + ' parsed nodes'
      : contract.supportsExecution
        ? contract.workflowFormat?.label || 'Workflow definition'
        : 'Planned contract';
    const configuredOutputNodeIds = (contract.outputPorts || [])
      .map((entry) => String(getGraphWorkflowOutputBinding(node, entry.portId)?.nodeId || '').trim())
      .filter(Boolean);
    const outputLabel = configuredOutputNodeIds.length ? ' | outputs ' + configuredOutputNodeIds.join(', ') : '';
    return (node.config?.toolId || 'Graph workflow tool') + ' | ' + nodeCountLabel + outputLabel;
  }
  if (node.type === 'validation') {
    return node.config?.mode === 'llm'
      ? `${node.config?.llmExecutionMode === 'ollama' ? 'Ollama' : node.config?.providerId || 'Cloud validator'}${node.config?.model ? ` | ${node.config.model}` : ''}`
      : 'Pauses for a pass or fail decision';
  }

  if (node.type === 'collectionBuilder') {
    return (node.config?.insertionMode || 'append') === 'prepend'
      ? 'Builds an ordered collection and places new items before the existing collection'
      : 'Builds an ordered collection and appends new items after the existing collection';
  }

  if (node.type === 'collectionAccumulator') {
    return 'Target ' + Math.max(1, Number(node.config?.targetCount || 3) || 3) + ' | keeps accepted items from one or more branches until the collection is ready';
  }
  if (node.type === 'collectionMap') {
    const mapping = getCollectionMapMapping(node);
    const modeLabel = node.config?.executionMode === 'graphWorkflow' ? 'Graph workflow' : node.config?.executionMode === 'localTool' ? (node.config?.toolId || 'Local tool') : (node.config?.providerId || 'Cloud provider');
    return (mapping?.label || 'Unsupported mapping') + ' | ' + modeLabel;
  }

  if (node.type === 'audioStitch') {
    const gapSeconds = Math.max(0, Number(node.config?.gapSeconds || 0) || 0);
    return gapSeconds > 0 ? gapSeconds + 's gaps | collection audio to WAV' : 'No gaps | collection audio to WAV';
  }


  if (node.type === 'videoStitch') {
    return 'Concatenate ordered video clips into MP4';
  }

  if (node.type === 'trimMedia') {
    const mode = String(node.config?.mode || 'duration').trim() === 'end' ? 'end' : 'duration';
    const startSeconds = Math.max(0, Number(node.config?.startSeconds || 0) || 0);
    const durationSeconds = Math.max(0, Number(node.config?.durationSeconds || 0) || 0);
    const endSeconds = Math.max(0, Number(node.config?.endSeconds || 0) || 0);
    return mode === 'end' ? 'Start ' + startSeconds + 's | end ' + endSeconds + 's' : 'Start ' + startSeconds + 's | duration ' + durationSeconds + 's';
  }

  if (node.type === 'burnSubtitles') {
    const mode = String(node.config?.captionMode || 'auto').trim() || 'auto';
    const fontSize = Math.max(1, Number(node.config?.fontSize || 28) || 28);
    return mode === 'manualLines' ? 'Manual lines | ' + Math.max(0.1, Number(node.config?.durationPerCaptionSeconds || 3) || 3) + 's each | ' + fontSize + 'px' : mode + ' captions | ' + fontSize + 'px';
  }

  if (node.type === 'exportSubtitles') {
    const mode = String(node.config?.captionMode || 'auto').trim() || 'auto';
    const format = String(node.config?.outputFormat || 'srt').trim().toUpperCase() || 'SRT';
    return mode === 'manualLines' ? format + ' | Manual lines | ' + Math.max(0.1, Number(node.config?.durationPerCaptionSeconds || 3) || 3) + 's each' : format + ' | ' + mode + ' captions';
  }


  if (node.type === 'normalizeAudioCollection') {
    const sampleRate = Math.max(1, Number(node.config?.sampleRate || 44100) || 44100);
    const channels = String(node.config?.channels || 'stereo').trim() === 'mono' ? 'mono' : 'stereo';
    const format = String(node.config?.outputFormat || 'auto').trim().toUpperCase() || 'AUTO';
    return sampleRate + ' Hz | ' + channels + ' | ' + format + ' audio';
  }

  if (node.type === 'normalizeVideoCollection') {
    const fps = Math.max(1, Number(node.config?.fps || 30) || 30);
    const sizeMode = String(node.config?.sizeMode || 'matchFirst').trim() === 'custom' ? 'custom size' : 'match first size';
    const format = String(node.config?.outputFormat || 'auto').trim().toUpperCase() || 'AUTO';
    return format + ' | ' + fps + ' fps | ' + sizeMode;
  }

  if (node.type === 'normalizeImage') {
    return String(node.config?.outputFormat || 'png').trim().toUpperCase() + ' image';
  }

  if (node.type === 'extractVideoFrame') {
    const framePosition = String(node.config?.framePosition || 'first').trim();
    if (framePosition === 'timestamp') {
      const timestampSeconds = Math.max(0, Number(node.config?.timestampSeconds || 0) || 0);
      return 'Timestamp ' + timestampSeconds + 's | video to PNG';
    }
    return (framePosition === 'last' ? 'Last' : 'First') + ' frame | video to PNG';
  }

  if (node.type === 'extractAudio') {
    return 'Video soundtrack to WAV';
  }

  if (node.type === 'mediaComposition') {
    const compositionMode = getMediaCompositionMode(node);
    if (compositionMode === 'videoSequence') {
      const transitionMode = getMediaCompositionTransitionMode(node.config?.sceneTransitionMode);
      return `video sequence${transitionMode === 'off' ? '' : ' | clip transitions'} | optional narration + music`;
    }
    if (compositionMode === 'singleVideoMix') {
      return 'single video mix | optional narration + music';
    }
    const timingMode = node.config?.imageTimingMode === 'dynamicFromImageMetadata' || node.config?.imageTimingMode === 'matchNarrationTiming' ? 'match narration timing' : `${Math.max(0.1, Number(node.config?.secondsPerItem || 0) || 4)}s per image`;
    const transitionMode = getMediaCompositionTransitionMode(node.config?.sceneTransitionMode);
    const transitionLabel = transitionMode === 'off' ? '' : ' | scene transitions';
    return `${timingMode}${transitionLabel} | optional narration + music`;
  }

  if (node.type === 'mediaExport') {
    return `${node.config?.width || 1280}x${node.config?.height || 720} | ${node.config?.fps || 30} fps | ${node.config?.stopMode === 'visuals' ? 'keep visuals and extend music if needed' : 'stop with the shortest narration or visual track'}`;
  }

  if (node.type === 'branchMerge') {
    return 'Waits for earlier branches to settle, then forwards the single active branch';
  }

  if (node.type === 'retryLoop') {
    const retryTerminationAction = String(node.config?.retryTerminationAction || 'fail').trim() === 'complete' ? 'keep retry on stop' : 'fail on stop';
    const repeatRuleLabel = node.config?.stopWhenRetryArtifactRepeats ? ' | stop if unchanged' : '';
    return (node.config?.retryTargetNodeId || 'Choose retry target') + ' | ' + Math.max(2, Number(node.config?.maxAttempts || 3) || 3) + ' attempts | ' + retryTerminationAction + repeatRuleLabel;
  }

  if (node.type.endsWith('Output')) {
    return node.config?.title || 'Result';
  }

  return '';
}

function getIssueCountText(count) {
  if (!count) {
    return 'No blocking issues';
  }

  return `${count} issue${count === 1 ? '' : 's'} to review`;
}

function getModelTargetConfig(node) {
  if (node?.type === 'llmPrompt') {
    return {
      executionModeKey: 'executionMode',
      providerIdKey: 'providerId',
    };
  }

  if (node?.type === 'validation' && node.config?.mode === 'llm') {
    return {
      executionModeKey: 'llmExecutionMode',
      providerIdKey: 'providerId',
    };
  }

  if (node?.type === 'planner') {
    return {
      executionModeKey: 'executionMode',
      providerIdKey: 'providerId',
    };
  }

  return null;
}

function getSelectedModelStepOperationId(node) {
  return getModelStepOperationId(node);
}
function providerSupportsPipelineOperation(provider, operationId) {
  const normalizedOperationId = String(operationId || '').trim();
  return Boolean(normalizedOperationId && provider?.pipelineCapabilities?.operations?.[normalizedOperationId]);
}

function getCloudProvidersForOperation(connectedProviders = [], operationId = '') {
  const normalizedOperationId = String(operationId || '').trim();
  if (!normalizedOperationId) {
    return connectedProviders || [];
  }
  return (connectedProviders || []).filter((provider) => providerSupportsPipelineOperation(provider, normalizedOperationId));
}

const MODEL_STEP_OPERATION_OPTIONS = Object.freeze([
  Object.freeze({ id: PIPELINE_OPERATION_IDS.LLM_PROMPT, label: 'Text response' }),
  Object.freeze({ id: PIPELINE_OPERATION_IDS.IMAGE_GENERATE, label: 'Image generation' }),
  Object.freeze({ id: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, label: 'Image transform' }),
  Object.freeze({ id: PIPELINE_OPERATION_IDS.AUDIO_GENERATE, label: 'Audio generation' }),
  Object.freeze({ id: PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE, label: 'Audio transcription' }),
  Object.freeze({ id: PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM, label: 'Audio transform' }),
  Object.freeze({ id: PIPELINE_OPERATION_IDS.VIDEO_GENERATE, label: 'Video generation' }),
]);

function getModelStepOperationOptionsForUi(node, connectedProviders = []) {
  const executionMode = node?.config?.executionMode === 'ollama'
    ? 'ollama'
    : node?.config?.executionMode === 'localTool'
      ? 'localTool'
      : 'cloud';
  if (executionMode === 'ollama') {
    return MODEL_STEP_OPERATION_OPTIONS.filter((entry) => entry.id === PIPELINE_OPERATION_IDS.LLM_PROMPT);
  }
  if (executionMode === 'localTool') {
    return MODEL_STEP_OPERATION_OPTIONS.filter((entry) => [
      PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
      PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM,
      PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE,
      PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM,
      PIPELINE_OPERATION_IDS.VIDEO_GENERATE,
    ].includes(entry.id));
  }

  const providerId = String(node?.config?.providerId || '').trim().toLowerCase();
  const selectedProvider = providerId ? (connectedProviders || []).find((provider) => String(provider.id || '').trim().toLowerCase() === providerId) : null;
  return MODEL_STEP_OPERATION_OPTIONS.filter((entry) => {
    if ([PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE, PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM].includes(entry.id)) {
      return false;
    }
    if (selectedProvider) {
      return providerSupportsPipelineOperation(selectedProvider, entry.id);
    }
    return getCloudProvidersForOperation(connectedProviders, entry.id).length > 0;
  });
}

function getModelStepLocalAudioToolIdForUi(node) {
  const selectedToolId = String(node?.config?.toolId || '').trim().toLowerCase();
  if (selectedToolId) {
    return selectedToolId;
  }

  return String(node?.config?.audioMode || '').trim().toLowerCase() === 'referencevoicetts'
    ? 'chatterbox-tts'
    : 'audiocraft-webui';
}

function getModelStepLocalAudioModeForUi(node) {
  return normalizeAudioModeForLocalTool(getModelStepLocalAudioToolIdForUi(node), node?.config?.audioMode);
}

function isModelStepChatterboxAudioMode(node) {
  return node?.config?.executionMode === 'localTool'
    && getSelectedModelStepOperationId(node) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
    && getModelStepLocalAudioToolIdForUi(node) === 'chatterbox-tts';
}

function getModelStepOperationLabel(node) {
  const operationId = getSelectedModelStepOperationId(node);
  return operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
    ? 'Audio transcription'
    : operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
      ? 'Audio generation'
      : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
        ? 'Audio transform'
        : operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE
          ? 'Image analysis'
          : operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
            ? 'Image generation'
            : operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
              ? 'Image transform'
              : operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                ? 'Video generation'
                : 'Text response';
}

function getCloudAudioModelPlaceholder(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'xai') {
    return 'Optional for xAI text-to-speech beta';
  }

  return 'Enter or pick a speech model';
}

function getCloudAudioModelRefreshHint(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'google') {
    return 'Loads Gemini speech models for this provider step.';
  }

  if (normalizedProviderId === 'openai') {
    return 'Loads OpenAI speech models for this provider step.';
  }

  if (normalizedProviderId === 'xai') {
    return "xAI's current TTS beta runs through a provider-managed speech runtime here. Leave Model blank unless xAI later exposes a selectable TTS model.";
  }

  return 'Loads cloud speech models for this provider step when the provider exposes them.';
}

function getCloudAudioModelHelp(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'google') {
    return 'Gemini speech uses TTS-capable Gemini models such as gemini-2.5-flash-preview-tts.';
  }

  if (normalizedProviderId === 'openai') {
    return 'OpenAI speech uses dedicated TTS models such as gpt-4o-mini-tts, tts-1, or tts-1-hd.';
  }

  if (normalizedProviderId === 'xai') {
    return 'xAI text-to-speech currently runs through a provider-managed speech runtime in this step, so model selection stays optional in this pass.';
  }

  return 'Choose a speech-capable model when the provider exposes one. Some providers may keep speech routing behind a provider-managed runtime instead.';
}

function getCloudVideoModelPlaceholder(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'xai') {
    return 'Blank for grok-imagine-video, or pick a Grok Imagine video model';
  }
  if (normalizedProviderId === 'google') {
    return 'Blank for veo-3.1-generate-preview, or pick a Veo model';
  }
  return 'Enter or pick a cloud video model';
}

function getCloudVideoResolutionOptions(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'xai') {
    return [
      { id: '720p', label: '720p' },
      { id: '480p', label: '480p' },
    ];
  }
  return [
    { id: '720p', label: '720p' },
    { id: '1080p', label: '1080p' },
  ];
}

function getCloudVideoHelp(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'xai') {
    return 'Cloud Video Generation uses xAI Grok Imagine. Text to video uses the connected text prompt; image to video uses the connected image and the motion guidance in the instruction box.';
  }
  if (normalizedProviderId === 'google') {
    return 'Cloud Video Generation uses Google Veo. Text to video uses the connected text prompt; image to video uses the connected image and the motion guidance in the instruction box.';
  }
  return 'Cloud Video Generation supports connected providers with text-to-video and image-to-video capability.';
}

function supportsCloudVideoNegativePrompt(providerId) {
  return String(providerId || '').trim().toLowerCase() === 'google';
}

function supportsCollectionMapCloudVideoChaining(providerId) {
  return ['google', 'xai'].includes(String(providerId || '').trim().toLowerCase());
}

function getCloudAudioVoicePlaceholder(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'openai') {
    return 'Optional voice name such as alloy';
  }

  if (normalizedProviderId === 'xai') {
    return 'Optional voice name such as eve';
  }

  return 'Optional voice name such as Kore';
}

function getCloudAudioVoiceHelp(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'openai') {
    return "OpenAI speech models save generated audio locally and keep it pipeline-usable. Leave voice blank to let Local AI Hub use OpenAI's default voice.";
  }

  if (normalizedProviderId === 'xai') {
    return "xAI speech saves generated audio locally and keeps it pipeline-usable. Leave voice blank to use xAI's default voice, or enter one such as eve, ara, rex, sal, or leo.";
  }

  if (normalizedProviderId === 'google') {
    return 'Gemini speech models save generated audio locally and keep it pipeline-usable. Leave voice blank to let Local AI Hub use the provider default.';
  }

  return 'Cloud speech providers save generated audio locally through the shared artifact path. Leave voice blank to use the provider default when available.';
}

function buildModelOptionDetail(model) {
  const detailParts = [];
  if (model?.detail) {
    detailParts.push(model.detail);
  }
  if (Array.isArray(model?.capabilityLabels) && model.capabilityLabels.length) {
    detailParts.push(model.capabilityLabels.join(' | '));
  }
  return detailParts.join(' | ');
}

function buildOllamaModelDetail(model) {
  const detailParts = [];
  if (model?.size) {
    detailParts.push(Math.round(Number(model.size) / 1024 / 1024) + ' MB');
  }
  if (model?.supportsImageInput === true) {
    detailParts.push('Vision');
  } else if (model?.supportsImageInput === false) {
    detailParts.push('Text only');
  }
  return detailParts.join(' | ');
}

function estimateModelSizeMb(model) {
  const size = Number(model?.size || model?.sizeBytes || 0);
  return Number.isFinite(size) && size > 0 ? Math.round(size / 1024 / 1024) : 0;
}

function getLocalWizardModelSuitability(model, hardware = {}) {
  const modelId = String(model?.id || model?.name || '').toLowerCase();
  const sizeMb = estimateModelSizeMb(model);
  const vramMb = Number(hardware?.vramMb || 0) || 0;
  const systemRamMb = Number(hardware?.systemRamMb || 0) || 0;
  if (/cloud/.test(modelId)) {
    return {
      label: 'Cloud via Ollama',
      message: 'This Ollama entry appears to require remote/cloud access. Prefer a downloaded local model for the local wizard.',
      score: -50,
      tone: 'warn',
    };
  }
  if (sizeMb > 0 && sizeMb < 900) {
    return {
      label: 'Fast but weak',
      message: 'This very small model may refresh quickly, but it may under-plan complex pipeline drafts. Best for simple drafts only.',
      score: 25,
      tone: 'warn',
    };
  }
  if (vramMb > 0 && sizeMb > Math.max(2800, vramMb * 0.5)) {
    return {
      label: 'May be slow here',
      message: 'This model is large for the detected VRAM once context memory is included, so local wizard drafting may be slow or fail on this PC.',
      score: 45,
      tone: 'warn',
    };
  }
  if (systemRamMb > 0 && sizeMb > systemRamMb * 0.55) {
    return {
      label: 'Memory-heavy',
      message: 'This model is large relative to detected system RAM. It may work, but drafts can be slow.',
      score: 40,
      tone: 'warn',
    };
  }
  if (sizeMb >= 1200) {
    return {
      label: 'Good for simple local drafts',
      message: 'This downloaded model is a reasonable local choice for simple or moderate drafts on this PC. Complex multi-stage workflows may still need a stronger or cloud wizard model and can fall back to a simple placeholder.',
      score: 100 - Math.max(0, Math.round((sizeMb - 4500) / 300)),
      tone: 'info',
    };
  }
  return {
    label: 'Usable for simple drafts',
    message: 'This model can be used for local wizard drafts, but a 1.5B-8B downloaded model is usually more reliable.',
    score: 60,
    tone: 'info',
  };
}

function rankLocalWizardModelOptions(models = [], hardware = {}) {
  return [...models]
    .map((model) => {
      const suitability = getLocalWizardModelSuitability(model, hardware);
      const detailParts = [model.detail, suitability.label].filter(Boolean);
      return {
        ...model,
        detail: detailParts.join(' | '),
        wizardSuitability: suitability,
      };
    })
    .sort((left, right) => Number(right.wizardSuitability?.score || 0) - Number(left.wizardSuitability?.score || 0));
}

function inferWizardRequestComplexity(intent = '') {
  const text = String(intent || '').toLowerCase();
  const signals = [
    /\b(plan|planning|planner|storyboard|scene|scenes|shot list)\b/,
    /\b(validat\w*|review|approve|approval|quality|qa)\b/,
    /\b(retry|regenerat\w*|revise|loop|on fail|until valid|until approved)\b/,
    /\b(prompt|prompts|per[-\s]?scene|scene prompt)\b/,
    /\b(image|images|visual|frame|thumbnail|illustration)\b/,
    /\b(video|sequence|sequencing|compose|composition|export|render|clip|movie)\b/,
    /\b(collection|batch|accumulat\w*)\b/,
  ].filter((pattern) => pattern.test(text)).length;
  const complex = signals >= 4 || /multi[-\s]?stage|pipeline.*validat|validat.*retry|retry.*validat/.test(text);
  return { complex, signals };
}

function getLocalWizardModelGuidance(modelOption, intent = '') {
  const suitability = modelOption?.wizardSuitability;
  if (!suitability) {
    return '';
  }
  const complexity = inferWizardRequestComplexity(intent);
  if (!complexity.complex) {
    return suitability.message;
  }
  if (suitability.tone === 'warn') {
    return suitability.message + ' For this complex multi-stage request, a cloud wizard model or a stronger downloaded local model is more likely to produce a meaningful draft; local mode may insert a simple placeholder if the model cannot complete.';
  }
  return suitability.message + ' For this complex multi-stage request, treat local drafting as best effort on this hardware; a cloud wizard model is more likely to compose the full workflow without falling back to a placeholder.';
}

function collectOllamaModelCapabilities(modelOptionsByNodeId) {
  const modelCapabilitiesByName = {};

  for (const modelOptions of Object.values(modelOptionsByNodeId || {})) {
    for (const model of Array.isArray(modelOptions) ? modelOptions : []) {
      const normalizedId = String(model?.id || '').trim().toLowerCase();
      if (!normalizedId || modelCapabilitiesByName[normalizedId] || typeof model?.supportsImageInput !== 'boolean') {
        continue;
      }

      modelCapabilitiesByName[normalizedId] = {
        capabilityLabels: Array.isArray(model.capabilityLabels) ? model.capabilityLabels : [],
        capabilitySource: String(model.capabilitySource || '').trim() || 'unknown',
        name: String(model.id || '').trim(),
        supportsImageInput: model.supportsImageInput,
      };
    }
  }

  return modelCapabilitiesByName;
}

function collectLocalToolModelsByToolId(modelOptionsByNodeId) {
  const localModelsByToolId = {};

  for (const modelOptions of Object.values(modelOptionsByNodeId || {})) {
    for (const model of Array.isArray(modelOptions) ? modelOptions : []) {
      const toolId = String(model?.toolId || '').trim();
      const modelId = String(model?.id || '').trim();
      if (!toolId || !modelId) {
        continue;
      }

      if (!localModelsByToolId[toolId]) {
        localModelsByToolId[toolId] = [];
      }

      if (localModelsByToolId[toolId].some((entry) => String(entry?.id || '').trim().toLowerCase() === modelId.toLowerCase())) {
        continue;
      }

      localModelsByToolId[toolId].push({
        ...model,
        downloaded: true,
        fileName: model.fileName || model.id,
        name: model.name || model.label || model.id,
        toolId,
      });
    }
  }

  return localModelsByToolId;
}

function getAssistantReplyText(result) {
  const message = result?.data?.message || null;
  if (typeof message?.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message?.content)) {
    return message.content.map((part) => part?.text || '').join('\n').trim();
  }

  return String(result?.data?.content || result?.data?.text || '').trim();
}

function getWizardModelId(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return String(value.id || value.model || value.modelId || value.name || value.label || '').trim();
  }
  return String(value || '').trim();
}

function getWizardTargetLabel(target, providers = []) {
  const model = getWizardModelId(target.model);
  if (target.mode === 'ollama') {
    return model ? `Ollama | ${model}` : 'Ollama';
  }

  const provider = providers.find((entry) => entry.id === target.providerId);
  return [provider?.name || target.providerId || 'Cloud provider', model].filter(Boolean).join(' | ');
}

function buildWizardModelOption(model) {
  const id = getWizardModelId(model);
  return {
    ...model,
    id,
    label: String(model?.label || model?.name || id || '').trim(),
    detail: buildModelOptionDetail(model) || model?.detail || '',
  };
}
function formatGraphWorkflowNodeLabel(entry) {
  const nodeId = String(entry?.id || '').trim();
  const classType = String(entry?.classType || '').trim();
  return classType ? nodeId + ' - ' + classType : nodeId || 'Workflow node';
}

function formatGraphWorkflowAdapterLabel(contract) {
  return contract?.supportsExecution ? 'Runs in Local AI Hub' : 'Planned adapter';
}

function formatGraphWorkflowPresetSummary(preset) {
  if (!preset) {
    return '';
  }

  const summary = getGraphWorkflowPresetContractSummary(preset);
  const toolId = String(preset.toolId || '').trim() || 'graph tool';
  return toolId + ' | ' + summary.label;
}
function ArtifactPreview({ artifact, className = '', compact = false }) {
  if (!artifact) {
    return <div className={`rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-400 ${className}`}>Nothing to preview yet.</div>;
  }

  const previewKind = getArtifactPreviewKind(artifact);

  if (previewKind === 'planning-packet') {
    const packet = artifact?.packet && typeof artifact.packet === 'object' ? artifact.packet : {};
    const sourceArtifacts = Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts : [];
    const visibleSources = compact ? sourceArtifacts.slice(0, 2) : sourceArtifacts.slice(0, 4);
    return (
      <div className={`space-y-3 ${className}`}>
        <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
          <p className="text-sm font-medium text-white">{artifact.displayName || packet.title || packet.schemaLabel || 'Planning packet'}</p>
          {artifact.summary ? <p className="mt-2 text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
        </div>
        <ArtifactFacts artifact={artifact} />
        <PlanningTextBlock title="Goal" value={packet.goal} />
        <PlanningTextBlock title="Source Summary" value={packet.sourceSummary} />
        <PlanningTextBlock title="Desired Output" value={packet.desiredOutput?.notes || packet.desiredOutput?.shapeSummary} />
        <div className="grid gap-3 xl:grid-cols-2">
          <PlanningListBlock title="Constraints" items={packet.constraints} />
          <PlanningListBlock title="Style / Policy" items={packet.stylePolicy} />
          <PlanningListBlock title="Available Tools" items={packet.availableTools} />
          <PlanningListBlock title="Readiness Notes" items={packet.readiness?.notes} />
          <PlanningListBlock title="Risk Notes" items={packet.riskNotes} />
          <PlanningListBlock title="Uncertainty Flags" items={packet.uncertaintyFlags} />
        </div>
        {packet.readiness?.hardwareSummary ? <PlanningTextBlock title="Hardware Context" value={packet.readiness.hardwareSummary} /> : null}
        {visibleSources.map((sourceArtifact, index) => (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4" key={(sourceArtifact?.filePath || sourceArtifact?.displayName || 'source') + '-' + index}>
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Source {index + 1}</p>
            <p className="mt-2 text-sm font-medium text-white">{sourceArtifact.displayName || sourceArtifact.fileName || sourceArtifact.kind || 'Source artifact'}</p>
            {sourceArtifact.summary ? <p className="mt-2 text-xs leading-5 text-slate-400">{sourceArtifact.summary}</p> : null}
            {sourceArtifact.textExcerpt ? <textarea className="store-input mt-3 min-h-[120px] resize-none" readOnly value={sourceArtifact.textExcerpt} /> : null}
          </div>
        ))}
        {sourceArtifacts.length > visibleSources.length ? <p className="text-xs leading-5 text-slate-500">Showing {visibleSources.length} of {sourceArtifacts.length} sources.</p> : null}
        {packet.workingNotes ? <PlanningTextBlock title="Working Notes" value={packet.workingNotes} /> : null}
        {!compact ? <StructuredDataPreview className="mt-1" minHeight="260px" value={packet} /> : null}
      </div>
    );
  }

  if (previewKind === 'plan') {
    const plan = artifact?.plan && typeof artifact.plan === 'object' ? artifact.plan : {};
    const overview = plan.overview && typeof plan.overview === 'object' ? plan.overview : {};
    const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
    const visibleScenes = compact ? scenes.slice(0, 2) : scenes.slice(0, 5);
    return (
      <div className={`space-y-3 ${className}`}>
        <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
          <p className="text-sm font-medium text-white">{artifact.displayName || plan.title || artifact.schemaLabel || 'Plan'}</p>
          {artifact.summary ? <p className="mt-2 text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
        </div>
        <ArtifactFacts artifact={artifact} />
        <div className="grid gap-3 xl:grid-cols-2">
          <PlanningTextBlock title="Overview Meaning / Intent" value={overview.meaningIntent} />
          <PlanningTextBlock title="Viewer Takeaway" value={overview.viewerTakeaway} />
          <PlanningTextBlock title="Narrative Arc" value={overview.narrativeArc} />
          <PlanningTextBlock title="Tone Strategy" value={overview.toneStrategy} />
          <PlanningListBlock title="Continuity Notes" items={overview.continuityNotes} />
          <PlanningListBlock title="Risk Notes" items={overview.riskNotes} />
        </div>
        {visibleScenes.map((scene, index) => (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4" key={(scene?.sceneId || 'scene') + '-' + index}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-white">{scene.sourceSpanLabel || scene.sceneId || 'Scene ' + (index + 1)}</p>
              {scene.sceneId ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">{scene.sceneId}</span> : null}
            </div>
            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              <PlanningTextBlock title="Meaning / Intent" value={scene.meaningIntent} />
              <PlanningTextBlock title="Viewer Takeaway" value={scene.viewerTakeaway} />
              <PlanningTextBlock title="Scene Concept" value={scene.sceneConcept} />
              <PlanningTextBlock title="Treatment / Approach" value={scene.treatmentApproach} />
            </div>
            {scene.narrationDraft ? <PlanningTextBlock title="Narration Draft" value={scene.narrationDraft} /> : null}
            {scene.imagePrompt || scene.visualPromptDraft ? <textarea className="store-input mt-3 min-h-[120px] resize-none" readOnly value={scene.imagePrompt || scene.visualPromptDraft} /> : null}
            <PlanningListBlock title="Scene Risk Notes" items={scene.riskNotes} />
          </div>
        ))}
        {scenes.length > visibleScenes.length ? <p className="text-xs leading-5 text-slate-500">Showing {visibleScenes.length} of {scenes.length} scenes.</p> : null}
        <PlanningListBlock title="Open Questions" items={plan.openQuestions} />
        {!compact ? <StructuredDataPreview className="mt-1" minHeight="280px" value={plan} /> : null}
      </div>
    );
  }

  if (previewKind === 'preview') {
    const preview = artifact?.preview && typeof artifact.preview === 'object' ? artifact.preview : {};
    const overview = preview.overview && typeof preview.overview === 'object' ? preview.overview : {};
    const scenes = Array.isArray(preview.scenes) ? preview.scenes : [];
    const visibleScenes = compact ? scenes.slice(0, 2) : scenes.slice(0, 4);
    return (
      <div className={`space-y-3 ${className}`}>
        <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
          <p className="text-sm font-medium text-white">{artifact.displayName || preview.planTitle || 'Preview'}</p>
          {artifact.summary ? <p className="mt-2 text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
        </div>
        <ArtifactFacts artifact={artifact} />
        <PlanningTextBlock title="Review Boundary" value={preview.limitationNote} />
        <div className="grid gap-3 xl:grid-cols-2">
          <PlanningTextBlock title="Overview Meaning / Intent" value={overview.meaningIntent} />
          <PlanningTextBlock title="Viewer Takeaway" value={overview.viewerTakeaway} />
          <PlanningTextBlock title="Narrative Arc" value={overview.narrativeArc} />
          <PlanningTextBlock title="Tone Strategy" value={overview.toneStrategy} />
        </div>
        {visibleScenes.map((scene, index) => (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4" key={(scene?.sceneId || 'preview-scene') + '-' + index}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-white">{scene.sourceSpanLabel || scene.sceneId || 'Scene ' + (index + 1)}</p>
              <div className="flex flex-wrap items-center gap-2">
                {scene.sceneId ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">{scene.sceneId}</span> : null}
                {scene.promptReadiness ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">{scene.promptReadiness.replace(/-/g, ' ')}</span> : null}
              </div>
            </div>
            {scene.summary ? <p className="mt-3 text-sm leading-6 text-slate-300">{scene.summary}</p> : null}
            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              <PlanningTextBlock title="Meaning / Intent" value={scene.meaningIntent} />
              <PlanningTextBlock title="Viewer Takeaway" value={scene.viewerTakeaway} />
              <PlanningTextBlock title="Scene Concept" value={scene.sceneConcept} />
              <PlanningTextBlock title="Treatment / Approach" value={scene.treatmentApproach} />
            </div>
            {scene.narrationDraft ? <PlanningTextBlock title="Narration Draft" value={scene.narrationDraft} /> : null}
            {scene.promptPreview ? <textarea className="store-input mt-3 min-h-[120px] resize-none" readOnly value={scene.promptPreview} /> : null}
            <PlanningListBlock title="Scene Risk Notes" items={scene.riskNotes} />
          </div>
        ))}
        {scenes.length > visibleScenes.length ? <p className="text-xs leading-5 text-slate-500">Showing {visibleScenes.length} of {scenes.length} preview cards.</p> : null}
        <PlanningListBlock title="Open Questions" items={preview.openQuestions} />
        {!compact ? <StructuredDataPreview className="mt-1" minHeight="280px" value={preview} /> : null}
      </div>
    );
  }

  if (previewKind === 'audit') {
    const audit = artifact?.audit && typeof artifact.audit === 'object' ? artifact.audit : {};
    const findings = Array.isArray(audit.findings) ? audit.findings : [];
    const visibleFindings = compact ? findings.slice(0, 3) : findings.slice(0, 8);
    const summary = audit.summary && typeof audit.summary === 'object' ? audit.summary : {};
    const totalFindingCount = Number(summary.errorCount || 0) + Number(summary.warningCount || 0) + Number(summary.infoCount || 0);
    return (
      <div className={`space-y-3 ${className}`}>
        <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
          <p className="text-sm font-medium text-white">{artifact.displayName || audit.planTitle || 'Audit'}</p>
          {artifact.summary ? <p className="mt-2 text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
        </div>
        <ArtifactFacts artifact={artifact} />
        <PlanningTextBlock title="Audit Boundary" value={audit.limitationNote} />
        <div className="grid gap-3 xl:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Structural grounding</p>
            <p className="mt-3 text-sm leading-6 text-slate-200">{audit.structuralValidation?.summary || 'No structural summary yet.'}</p>
            {Array.isArray(audit.structuralValidation?.errors) && audit.structuralValidation.errors.length ? (
              <div className="mt-3 space-y-2">
                {audit.structuralValidation.errors.map((entry, index) => (
                  <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-3 py-3 text-sm leading-6 text-rose-100" key={entry + '-' + index}>{entry}</div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Review summary</p>
            <p className="mt-3 text-sm leading-6 text-slate-200">
              {totalFindingCount
                ? `This pass surfaced ${totalFindingCount} bounded finding${totalFindingCount === 1 ? '' : 's'}.`
                : 'This pass did not surface any structural or heuristic findings.'}
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              {audit.previewCoverage?.connected
                ? (audit.previewCoverage.matchesPlan ? 'The connected preview lines up with the current plan.' : 'The connected preview only partially lines up with the current plan.')
                : 'This audit ran directly from the plan without a connected preview coverage check.'}
            </p>
          </div>
        </div>
        {visibleFindings.length ? visibleFindings.map((finding, index) => (
          <div className={`rounded-2xl border px-4 py-4 ${toneToClassName(finding.severity)}`} key={(finding?.title || 'finding') + '-' + index}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-white">{finding.title || 'Finding'}</p>
              <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-white/85">{finding.severity || 'info'}</span>
            </div>
            {finding.sceneLabel ? <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-200/80">{finding.sceneLabel}</p> : null}
            {finding.detail ? <p className="mt-3 text-sm leading-6 text-slate-100">{finding.detail}</p> : null}
            <p className="mt-2 text-xs leading-5 text-slate-200/80">
              {(finding.category || 'review').replace(/-/g, ' ')}
              {finding.approximate ? ' | approximate heuristic' : ''}
              {finding.heuristic ? ' | ' + finding.heuristic.replace(/-/g, ' ') : ''}
            </p>
          </div>
        )) : (
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-4 text-sm leading-6 text-emerald-100">
            No structural or heuristic findings were raised in this audit pass.
          </div>
        )}
        {findings.length > visibleFindings.length ? <p className="text-xs leading-5 text-slate-500">Showing {visibleFindings.length} of {findings.length} findings.</p> : null}
        <PlanningListBlock title="Heuristics Used" items={audit.heuristicsUsed} />
        {!compact ? <StructuredDataPreview className="mt-1" minHeight="280px" value={audit} /> : null}
      </div>
    );
  }

  if (previewKind === 'composition' && artifact?.composition) {
    const tracks = Array.isArray(artifact.composition.tracks) ? artifact.composition.tracks : [];
    const visualTrack = tracks.find((track) => String(track?.role || '').trim() === 'primary-visual') || null;
    const audioTrack = tracks.find((track) => String(track?.role || '').trim() === 'primary-audio') || null;
    const backgroundMusicTrack = tracks.find((track) => String(track?.role || '').trim() === 'background-music') || null;
    const visualItems = Array.isArray(visualTrack?.items) ? visualTrack.items : [];
    const visibleItems = compact ? visualItems.slice(0, 2) : visualItems.slice(0, 4);
    return (
      <div className={`space-y-3 ${className}`}>
        <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
          <p className="text-sm font-medium text-white">{artifact.displayName || 'Media composition'}</p>
          {artifact.summary ? <p className="mt-2 text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
          {artifact.manifestPath ? <input className="store-input mt-3" readOnly value={artifact.manifestPath} /> : null}
        </div>
        {visualTrack ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Primary visual track</p>
            <ArtifactFacts artifact={artifact} className="mt-3" />
            {visualTrack?.sourceCollection?.displayName ? <p className="mt-3 text-sm text-slate-200">Source collection: {visualTrack.sourceCollection.displayName}</p> : null}
            {visualTrack?.sourceCollection?.manifestPath ? <input className="store-input mt-3" readOnly value={visualTrack.sourceCollection.manifestPath} /> : null}
          </div>
        ) : null}
        {visibleItems.map((entry, index) => {
          const itemArtifact = entry?.artifact || null;
          const lineage = entry?.lineage || null;
          return (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4" key={entry?.itemId || `${index}-${itemArtifact?.fileName || itemArtifact?.displayName || 'visual'}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Visual item {index + 1}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {entry?.durationSeconds ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">{Math.round(Number(entry.durationSeconds) * 10) / 10}s</span> : null}
                  {lineage?.sourceNodeLabel ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">From {lineage.sourceNodeLabel}</span> : null}
                </div>
              </div>
              <ArtifactFacts artifact={itemArtifact} className="mt-3" />
              <ArtifactPreview artifact={itemArtifact} className="mt-3" compact />
            </div>
          );
        })}
        {visualItems.length > visibleItems.length ? <p className="text-xs leading-5 text-slate-500">Showing {visibleItems.length} of {visualItems.length} visual items.</p> : null}
        {audioTrack?.artifact ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Primary audio track</p>
            <ArtifactFacts artifact={audioTrack.artifact} className="mt-3" />
            <ArtifactPreview artifact={audioTrack.artifact} className="mt-3" compact />
          </div>
        ) : null}
        {backgroundMusicTrack?.artifact ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Background music track</p>
            <p className="mt-2 text-xs leading-5 text-slate-400">Exports use the background music level saved on the Media Composition node. If no primary narration track is attached, this track becomes the soundtrack at that level.</p>
            <ArtifactFacts artifact={backgroundMusicTrack.artifact} className="mt-3" />
            <ArtifactPreview artifact={backgroundMusicTrack.artifact} className="mt-3" compact />
          </div>
        ) : null}
      </div>
    );
  }

  if (previewKind === 'collection' && isCollectionArtifact(artifact)) {
    const items = Array.isArray(artifact.items) ? artifact.items : [];
    const visibleItems = compact ? items.slice(0, 3) : items.slice(0, 6);
    return (
      <div className={`space-y-3 ${className}`}>
        <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
          <p className="text-sm font-medium text-white">{artifact.displayName || formatArtifactKindLabel('collection', artifact.itemKind)}</p>
          {artifact.summary ? <p className="mt-2 text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
          {artifact.manifestPath ? <input className="store-input mt-3" readOnly value={artifact.manifestPath} /> : null}
        </div>
        {visibleItems.map((entry, index) => {
          const itemArtifact = entry?.artifact || null;
          const lineage = entry?.lineage || null;
          return (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4" key={entry?.itemId || `${index}-${itemArtifact?.fileName || itemArtifact?.displayName || 'item'}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Item {index + 1}</p>
                {lineage?.sourceNodeLabel ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">From {lineage.sourceNodeLabel}</span> : null}
              </div>
              <ArtifactFacts artifact={itemArtifact} className="mt-3" />
              <ArtifactPreview artifact={itemArtifact} className="mt-3" compact />
            </div>
          );
        })}
        {items.length > visibleItems.length ? <p className="text-xs leading-5 text-slate-500">Showing {visibleItems.length} of {items.length} ordered items.</p> : null}
      </div>
    );
  }

  if (previewKind === 'text') {
    return (
      <textarea
        className={`store-input resize-none ${className}`}
        readOnly
        style={{ minHeight: compact ? '120px' : '180px' }}
        value={artifact.text || ''}
      />
    );
  }

  if ((previewKind === 'image' || previewKind === 'animated-image') && artifact.fileUrl) {
    const transformation = artifact.imageTransformation && typeof artifact.imageTransformation === 'object' ? artifact.imageTransformation : null;
    const sourceImage = transformation?.sourceImage && typeof transformation.sourceImage === 'object' ? transformation.sourceImage : null;
    const referenceImage = transformation?.referenceImage && typeof transformation.referenceImage === 'object' ? transformation.referenceImage : null;
    return (
      <div className={`space-y-3 ${className}`}>
        <img alt={artifact.displayName || 'Pipeline image output'} className="max-h-[280px] w-full rounded-[24px] border border-white/10 bg-slate-950/40 object-contain" src={artifact.fileUrl} />
        {artifact.summary ? <p className="text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
        {transformation ? (
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Transformed image</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-300">
              {buildImageFactLabels(artifact).map((label, index) => (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1" key={`${label}-${index}`}>
                  {label}
                </span>
              ))}
            </div>
            {transformation.model ? <input className="store-input mt-3" readOnly value={transformation.model} /> : null}
            {transformation.instruction ? <textarea className="store-input mt-3 min-h-[120px] resize-none" readOnly value={transformation.instruction} /> : null}
            {sourceImage ? (
              <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-slate-300">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Target image</p>
                {sourceImage.fileName || sourceImage.displayName ? <p className="mt-2">{sourceImage.fileName || sourceImage.displayName}</p> : null}
                {sourceImage.filePath ? <input className="store-input mt-3" readOnly value={sourceImage.filePath} /> : null}
              </div>
            ) : null}
            {referenceImage ? (
              <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-slate-300">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Reference image</p>
                {referenceImage.fileName || referenceImage.displayName ? <p className="mt-2">{referenceImage.fileName || referenceImage.displayName}</p> : null}
                {referenceImage.filePath ? <input className="store-input mt-3" readOnly value={referenceImage.filePath} /> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (previewKind === 'audio' && artifact.fileUrl) {
    const generation = artifact.audioGeneration && typeof artifact.audioGeneration === 'object' ? artifact.audioGeneration : null;
    const transformation = artifact.audioTransformation && typeof artifact.audioTransformation === 'object' ? artifact.audioTransformation : null;
    const sourceAudio = transformation?.sourceAudio && typeof transformation.sourceAudio === 'object'
      ? transformation.sourceAudio
      : generation?.sourceAudio && typeof generation.sourceAudio === 'object'
        ? generation.sourceAudio
        : null;
    return (
      <div className={`space-y-3 ${className}`}>
        <audio className="w-full" controls src={artifact.fileUrl} />
        <p className="text-xs leading-5 text-slate-400">{artifact.summary || artifact.fileName || artifact.displayName}</p>
        {transformation ? (
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Transformed audio</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-300">
              {buildAudioFactLabels(artifact).map((label, index) => (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1" key={`${label}-${index}`}>
                  {label}
                </span>
              ))}
            </div>
            {transformation.model ? <input className="store-input mt-3" readOnly value={transformation.model} /> : null}
            {transformation.instruction ? <textarea className="store-input mt-3 min-h-[120px] resize-none" readOnly value={transformation.instruction} /> : null}
          </div>
        ) : null}
        {generation ? (
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Generated audio</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-300">
              {buildAudioFactLabels(artifact).map((label, index) => (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1" key={`${label}-${index}`}>
                  {label}
                </span>
              ))}
            </div>
            {generation.model ? <input className="store-input mt-3" readOnly value={generation.model} /> : null}
            {generation.prompt ? <textarea className="store-input mt-3 min-h-[120px] resize-none" readOnly value={generation.prompt} /> : null}
          </div>
        ) : null}
        {sourceAudio ? (
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Source audio</p>
            {sourceAudio.fileName || sourceAudio.displayName ? <p className="mt-2 text-sm text-slate-200">{sourceAudio.fileName || sourceAudio.displayName}</p> : null}
            {sourceAudio.fileUrl ? <audio className="mt-3 w-full" controls src={sourceAudio.fileUrl} /> : null}
            {!sourceAudio.fileUrl && sourceAudio.filePath ? <input className="store-input mt-3" readOnly value={sourceAudio.filePath} /> : null}
          </div>
        ) : null}
      </div>
    );
  }
  if (previewKind === 'video' && artifact.fileUrl) {
    const exportProfile = artifact.compositionExport && typeof artifact.compositionExport === 'object'
      ? artifact.compositionExport.exportProfile || null
      : null;
    return (
      <div className={`space-y-3 ${className}`}>
        <video className="max-h-[280px] w-full rounded-[24px] border border-white/10 bg-black/40" controls src={artifact.fileUrl} />
        <p className="text-xs leading-5 text-slate-400">{artifact.summary || artifact.fileName || artifact.displayName}</p>
        {artifact.compositionExport ? (
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Composition export</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-300">
              {buildVideoFactLabels(artifact).map((label, index) => (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1" key={`${label}-${index}`}>
                  {label}
                </span>
              ))}
            </div>
            {artifact.compositionExport?.audioMix ? (
              <p className="mt-3 text-xs leading-5 text-slate-400">
                {formatAudioMixSummary(artifact.compositionExport.audioMix)}
              </p>
            ) : null}
            {artifact.compositionExport?.composition?.manifestPath ? <input className="store-input mt-3" readOnly value={artifact.compositionExport.composition.manifestPath} /> : null}
            {exportProfile?.concatManifestPath ? <input className="store-input mt-3" readOnly value={exportProfile.concatManifestPath} /> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <input className="store-input" readOnly value={artifact.filePath || artifact.fileName || artifact.displayName || ''} />
      {artifact.previewText ? <textarea className="store-input min-h-[120px] resize-none" readOnly value={artifact.previewText} /> : null}
      {artifact.summary ? <p className="text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
    </div>
  );
}

function formatValidationEvidenceMode(validation) {
  const evidenceMode = String(validation?.evidenceMode || validation?.reviewContext?.evidenceMode || '').trim();
  if (!evidenceMode) {
    return '';
  }

  if (evidenceMode === 'direct-image') {
    return 'Reviewed attached image';
  }

  if (evidenceMode === 'direct-video') {
    return 'Reviewed attached video';
  }

  if (evidenceMode === 'direct-animated-image') {
    return 'Reviewed attached animated image';
  }

  if (evidenceMode === 'direct-file') {
    return 'Reviewed attached file';
  }

  if (evidenceMode === 'derived-file-text') {
    return 'Reviewed extracted document text';
  }

  if (evidenceMode === 'derived-image-description') {
    return 'Reviewed extracted image description';
  }

  if (evidenceMode === 'structured-collection') {
    return 'Reviewed whole collection';
  }

  if (evidenceMode === 'structured-plan') {
    return 'Reviewed structured Plan';
  }

  if (evidenceMode === 'whole-collection-review') {
    return 'User reviewed whole collection';
  }

  if (evidenceMode === 'text-only') {
    return 'Reviewed plain text';
  }

  return 'Reviewed supporting metadata';
}

function formatValidationConfidence(confidence) {
  const numeric = Number(confidence);
  if (!Number.isFinite(numeric)) {
    return '';
  }

  return `${Math.round(Math.max(0, Math.min(1, numeric)) * 100)}% confidence`;
}

function PlanReviewEvidence({ planReview }) {
  if (!planReview || typeof planReview !== 'object') {
    return null;
  }

  const summary = planReview.summary && typeof planReview.summary === 'object' ? planReview.summary : {};
  const findings = Array.isArray(planReview.findings) ? planReview.findings : [];
  const visibleFindings = findings.slice(0, 5);
  const totalFindingCount = Number(summary.errorCount || 0) + Number(summary.warningCount || 0) + Number(summary.infoCount || 0);

  return (
    <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-3 text-xs leading-5 text-slate-200">
      <p className="uppercase tracking-[0.18em] text-slate-400">Plan review evidence</p>
      <p className="mt-2 text-slate-300">{planReview.structuralValidation?.summary || (totalFindingCount ? `${totalFindingCount} bounded finding${totalFindingCount === 1 ? '' : 's'} recorded.` : 'No bounded findings recorded.')}</p>
      {visibleFindings.length ? (
        <div className="mt-2 space-y-2">
          {visibleFindings.map((finding, index) => (
            <div className={`rounded-xl border px-3 py-2 ${toneToClassName(finding.severity || 'info')}`} key={`${finding.title || 'finding'}-${index}`}>
              <p className="font-medium text-white">{finding.title || 'Finding'}</p>
              {finding.sceneLabel ? <p className="mt-1 uppercase tracking-[0.14em] text-slate-200/80">{finding.sceneLabel}</p> : null}
              {finding.detail ? <p className="mt-1 text-slate-100">{finding.detail}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      {findings.length > visibleFindings.length ? <p className="mt-2 text-slate-500">Showing {visibleFindings.length} of {findings.length} findings.</p> : null}
    </div>
  );
}
function ValidationResultSummary({ validation }) {
  if (!validation) {
    return null;
  }

  const evidenceMode = formatValidationEvidenceMode(validation);
  const confidenceLabel = formatValidationConfidence(validation.confidence);
  const criteriaResults = Array.isArray(validation.criteriaResults) ? validation.criteriaResults.slice(0, 3) : [];
  const reason = validation.summary || validation.reason || '';
  const limitations = validation.evidenceLimitations || '';

  return (
    <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-3 text-xs leading-5 text-slate-200">
      <p className="uppercase tracking-[0.18em] text-slate-400">Validation result</p>
      <p className="mt-2 text-sm font-medium text-white">{String(validation.decision || '').toUpperCase() || 'Decision recorded'}</p>
      {reason ? <p className="mt-2 text-slate-300">{reason}</p> : null}
      {evidenceMode || confidenceLabel ? <p className="mt-2 text-slate-400">{[evidenceMode, confidenceLabel].filter(Boolean).join(' | ')}</p> : null}
      {criteriaResults.length ? (
        <div className="mt-2 space-y-1 text-slate-300">
          {criteriaResults.map((entry, index) => (
            <p key={`${entry.criterion || 'criterion'}-${index}`}>
              {entry.criterion || 'Criterion'}: {entry.decision || 'not scored'}{entry.reason ? ` - ${entry.reason}` : ''}
            </p>
          ))}
        </div>
      ) : null}
      {limitations ? <p className="mt-2 text-amber-200/90">{limitations}</p> : null}
      <PlanReviewEvidence planReview={validation.planReview || validation.reviewContext?.planReview} />
    </div>
  );
}

function AttemptHistoryList({ entries, title }) {
  const historyEntries = Array.isArray(entries) ? entries.filter(Boolean).slice().reverse() : [];
  if (!historyEntries.length) {
    return null;
  }

  return (
    <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-3">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</p>
      <div className="mt-2 space-y-2">
        {historyEntries.map((entry, index) => {
          const attemptLabel = formatAttemptLabel(entry?.attempt, entry?.loopMaxAttempts) || 'Earlier attempt';
          return (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2" key={`${title}-${entry?.attempt || index}-${entry?.recordedAt || index}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">{attemptLabel}</p>
                <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{entry?.status || 'completed'}</span>
              </div>
              {entry?.message ? <p className="mt-2 text-xs leading-5 text-slate-300">{entry.message}</p> : null}
              {entry?.selectedBranch ? <p className="mt-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">Routed to {entry.selectedBranch}</p> : null}
              {entry?.loopPathLabel ? <p className="mt-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">Loop path: {entry.loopPathLabel}</p> : null}
              {entry?.preview ? <p className="mt-2 text-xs leading-5 text-slate-400">{entry.preview}</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PathButtons({ path, onOpenPath, onRevealPath }) {
  if (!path) {
    return null;
  }

  return (
    <div className="mt-3 flex flex-wrap gap-3">
      <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => onOpenPath(path, false)} type="button">
        Open
      </button>
      <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => onRevealPath(path)} type="button">
        Show in folder
      </button>
    </div>
  );
}

function PipelineOutputDeletionDialog({ busy, dialog, onClose, onConfirm, onToggleIntermediates }) {
  if (!dialog) {
    return null;
  }

  const { includeIntermediates, output, preview } = dialog;
  const outputLabel = output?.outputLabel || output?.fileName || 'Pipeline output';
  const modeLabel = preview?.deletionMode === 'permanent' ? 'Permanently delete from disk' : 'Move to Recycle Bin';
  const artifactFiles = Number(preview?.artifactSummary?.files || 0);
  const artifactDirectories = Number(preview?.artifactSummary?.directories || 0);
  const canCleanIntermediates = Boolean(preview?.artifactsExist) && !preview?.intermediateCleanupBlocked;

  return (
    <div aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-8 backdrop-blur-sm" role="dialog">
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-slate-950 p-6 shadow-soft">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Delete pipeline output</p>
            <h2 className="mt-2 text-xl font-semibold text-white">{outputLabel}</h2>
          </div>
          <button className="ghost-button px-3 py-1.5 text-xs" disabled={busy} onClick={onClose} type="button">Close</button>
        </div>

        <div className="mt-5 border-y border-white/10 py-4 text-sm text-slate-300">
          <div className="flex flex-wrap justify-between gap-3">
            <span>Selected saved output</span>
            <span>{Number(preview?.selectedSummary?.files || 0)} files, {formatBytes(Number(preview?.selectedSummary?.bytes || 0))}</span>
          </div>
          <p className="mt-2 break-all text-xs leading-5 text-slate-500">{preview?.outputPath}</p>
          <div className="mt-4 flex flex-wrap justify-between gap-3">
            <span>Deletion mode</span>
            <span>{modeLabel}</span>
          </div>
        </div>

        <label className={`mt-5 flex items-start gap-3 border p-4 ${includeIntermediates ? 'border-cyan-300/35 bg-cyan-300/10' : 'border-white/10 bg-white/5'} ${canCleanIntermediates ? 'cursor-pointer' : 'opacity-70'}`}>
          <input
            checked={includeIntermediates}
            className="mt-1 h-4 w-4 accent-cyan-300"
            disabled={!canCleanIntermediates || busy}
            onChange={(event) => onToggleIntermediates(event.target.checked)}
            type="checkbox"
          />
          <span>
            <span className="block text-sm font-semibold text-white">Also delete intermediate generated files from this run</span>
            <span className="mt-2 block text-xs leading-5 text-slate-300">
              Removes generated images, audio, plan collections, media compositions, media exports, manifests, and sidecars stored inside this run. User-provided input files, asset libraries, models, and files outside the run are not deleted.
            </span>
            <span className="mt-2 block text-xs text-slate-400">
              {preview?.intermediateCleanupBlocked
                ? (preview?.intermediateCleanupBlockedReason || 'Intermediate cleanup is unavailable for this run.')
                : preview?.artifactsExist
                  ? `${artifactFiles} generated files in ${artifactDirectories} folders, ${formatBytes(Number(preview?.artifactSummary?.bytes || 0))}`
                  : 'No intermediate generated files were found for this run.'}
            </span>
          </span>
        </label>

        <p className="mt-4 text-xs leading-5 text-slate-400">
          Leaving the checkbox off deletes only the visible saved output and its adjacent metadata sidecars. Other saved outputs from this run are always preserved.
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <button className="ghost-button" disabled={busy} onClick={onClose} type="button">Cancel</button>
          <button className="primary-button" disabled={busy} onClick={onConfirm} type="button">
            {busy ? 'Deleting...' : modeLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
function PipelineOutputRow({ busy, onDelete, onOpenPath, onRevealPath, output }) {
  const artifact = output?.artifact || null;
  const outputPath = output?.outputPath || getArtifactStoragePath(artifact);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Pipeline output</p>
          <p className="mt-2 text-sm font-semibold text-white">{output?.outputLabel || artifact?.displayName || artifact?.fileName || 'Saved output'}</p>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            Saved {formatDateLabel(output?.savedAt)}{output?.runId ? ` | ${output.runId}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {output?.isDirectory ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">Folder output</span> : null}
          {artifact?.kind ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">{formatArtifactKindLabel(artifact.kind, artifact.itemKind)}</span> : null}
        </div>
      </div>
      <ArtifactFacts artifact={artifact} className="mt-4" />
      <div className="mt-4">
        <ArtifactPreview artifact={artifact} compact />
      </div>
      {outputPath ? <input className="store-input mt-4" readOnly value={outputPath} /> : null}
      {artifact?.summary ? <p className="mt-3 text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => onOpenPath(outputPath, false)} type="button">
          Open
        </button>
        <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => onRevealPath(outputPath)} type="button">
          Show in folder
        </button>
        <button className="ghost-button px-3 py-1.5 text-xs text-rose-100" disabled={busy} onClick={() => onDelete(output)} type="button">
          {busy ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

function PipelineOutputsPanel({ busyPath, className = '', expanded, loading, onDelete, onOpenPath, onRefresh, onRevealPath, onToggleExpanded, outputs }) {
  const outputCount = Array.isArray(outputs) ? outputs.length : 0;
  const outputCountLabel = `${outputCount} saved output${outputCount === 1 ? '' : 's'}`;

  return (
    <div className={`panel ${expanded ? 'p-4' : 'p-3'} ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Pipeline outputs</p>
          <p className="mt-2 text-lg font-semibold text-white">Manage saved outputs any time</p>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
            {expanded
              ? 'Local AI Hub scans known pipeline output folders and lets you open or delete saved results here. This stays intentionally scoped to pipeline outputs, not a general media library.'
              : `${outputCountLabel}. Expand this section when you want to browse or clean up earlier pipeline results.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {expanded ? (
            <button className="ghost-button px-3 py-1.5 text-xs" disabled={loading} onClick={onRefresh} type="button">
              {loading ? 'Refreshing...' : 'Refresh list'}
            </button>
          ) : null}
          <button className="ghost-button px-3 py-1.5 text-xs" onClick={onToggleExpanded} type="button">
            {expanded ? 'Collapse outputs' : 'Expand outputs'}
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="mt-4 space-y-3">
          {outputCount ? (
            outputs.map((output) => (
              <PipelineOutputRow
                busy={busyPath === output.outputPath}
                key={output.id}
                onDelete={onDelete}
                onOpenPath={onOpenPath}
                onRevealPath={onRevealPath}
                output={output}
              />
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
              {loading
                ? 'Scanning saved pipeline outputs...'
                : "No saved pipeline outputs were found in Local AI Hub's known output folders yet."}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
function SavedPipelineRow({ active, hasPendingMetadataChanges = false, pipeline, onClick }) {
  return (
    <button
      className={`w-full rounded-[24px] border px-4 py-4 text-left transition ${
        active ? 'border-cyan-300/35 bg-cyan-300/12 text-cyan-50' : 'border-white/10 bg-white/5 text-slate-200 hover:border-cyan-300/20 hover:bg-white/10'
      }`}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-white">{pipeline.name}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {active && hasPendingMetadataChanges ? <span className="rounded-full border border-amber-300/30 bg-amber-300/12 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-amber-100">Unsaved metadata</span> : null}
          <span className="rounded-full border border-white/10 bg-slate-950/40 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400">
            {pipeline.nodeCount} node{pipeline.nodeCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{pipeline.description || 'No description yet.'}</p>
      <p className="mt-3 text-[11px] uppercase tracking-[0.2em] text-slate-500">Updated {formatDateLabel(pipeline.updatedAt)}</p>
    </button>
  );
}

function ResultCard({ result, onOpenPath, onRevealPath }) {
  const artifact = result?.artifact || null;
  const artifactPath = result.destinationPath || result.directoryPath || result.filePath || '';
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{result.title}</p>
          <p className="mt-2 text-sm font-semibold text-white">{formatArtifactKindLabel(result.kind || artifact?.kind, result.itemKind || artifact?.itemKind)}</p>
        </div>
        {artifactPath ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">Saved</span> : null}
      </div>
      <ArtifactFacts artifact={artifact} className="mt-4" />
      <div className="mt-4">
        <ArtifactPreview artifact={artifact} />
      </div>
      {artifactPath ? <input className="store-input mt-4" readOnly value={artifactPath} /> : null}
      <PathButtons onOpenPath={onOpenPath} onRevealPath={onRevealPath} path={artifactPath} />
    </div>
  );
}
function ValidationDecisionCard({ pendingValidation, comment, retryOverrides, fontLibraries = [], colorPaletteLibraries = [], recordingDevices = { microphones: [], webcams: [] }, recordingDisplays = [], recordingDevicesBusy = false, recordingDisplaysBusy = false, onChangeComment, onChangeRetryOverride, onDecide, onOpenPath, onRefreshRecordingDevices, onRefreshRecordingDisplays, onRevealPath, onSelectRecordInputRegion, busy }) {
  if (!pendingValidation) {
    return null;
  }

  const artifact = pendingValidation.artifact || null;
  const artifactLabel = formatArtifactKindLabel(artifact?.kind, artifact?.itemKind);
  const artifactName = artifact?.displayName || artifact?.fileName || '';
  const artifactPath = getArtifactStoragePath(artifact);
  const attemptLabel = formatAttemptLabel(pendingValidation.iteration, pendingValidation.loopMaxAttempts);
  const collectionMapContext = pendingValidation.collectionMap || pendingValidation.reviewContext?.mapCollection || null;
  const collectionMapLabel = collectionMapContext
    ? 'Map item ' + String(Number(collectionMapContext.itemIndex || 0) + 1) + ' of ' + collectionMapContext.itemCount + (collectionMapContext.itemId ? ' (' + collectionMapContext.itemId + ')' : '')
    : '';
  const recordInputRetryControl = pendingValidation.retryControls?.recordInput || null;
  const recordInputRetryValues = retryOverrides?.recordInput || getPendingRecordInputRetryDefaults(pendingValidation);
  const recordInputRetryMode = getRecordInputModeDefinition(recordInputRetryControl?.mode || recordInputRetryValues?.mode);
  const recordInputCaptureTargetType = String(recordInputRetryValues?.captureTarget?.type || 'desktop') === 'region' ? 'region' : 'desktop';
  const recordInputSelectedDisplay = recordingDisplays.find((display) => String(display.id) === String(recordInputRetryValues?.displayId || recordInputRetryValues?.captureTarget?.displayId || '')) || null;
  const mediaCompositionRetryControl = pendingValidation.retryControls?.mediaComposition || null;
  const mediaCompositionRetryValues = retryOverrides?.mediaComposition || getPendingMediaCompositionRetryDefaults(pendingValidation);
  const burnSubtitlesRetryControl = pendingValidation.retryControls?.burnSubtitles || null;
  const burnSubtitlesRetryValues = retryOverrides?.burnSubtitles || getPendingBurnSubtitlesRetryDefaults(pendingValidation);
  const burnSubtitlesCaptionModeOptions = BURN_SUBTITLES_CAPTION_MODE_OPTIONS.filter(([optionValue]) => {
    const allowedOptions = Array.isArray(burnSubtitlesRetryControl?.captionModeOptions) ? burnSubtitlesRetryControl.captionModeOptions : [];
    return !allowedOptions.length || allowedOptions.includes(optionValue);
  });
  const retryFontLibrary = fontLibraries.find((library) => library.id === burnSubtitlesRetryValues?.fontLibraryId) || fontLibraries[0] || null;
  const retryPaletteLibrary = colorPaletteLibraries.find((library) => library.id === burnSubtitlesRetryValues?.colorPaletteLibraryId) || colorPaletteLibraries[0] || null;  return (
    <div className="rounded-[26px] border border-violet-400/30 bg-violet-400/10 p-4 text-violet-50">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-violet-100/80">Awaiting validation</p>
          <p className="mt-2 text-lg font-semibold text-white">{pendingValidation.nodeLabel}</p>
          {attemptLabel ? <p className="mt-2 text-xs uppercase tracking-[0.18em] text-violet-100/80">{attemptLabel}</p> : null}
          {collectionMapLabel ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-violet-100/70">{collectionMapLabel}</p> : null}
          {pendingValidation.loopPathLabel ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-violet-100/70">Loop path: {pendingValidation.loopPathLabel}</p> : null}
          {artifactName ? <p className="mt-2 text-sm leading-6 text-violet-50/90">Reviewing {artifactLabel.toLowerCase()}: {artifactName}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {artifact ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/85">{artifactLabel}</span> : null}
          <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/85">
            Paused
          </span>
        </div>
      </div>
      <p className="mt-3 text-sm leading-6 text-violet-50/90">{collectionMapContext ? 'Review this mapped item attempt below. Pass accepts it into the final ordered collection; Fail retries only this source item while attempts remain.' : artifact?.kind === 'collection' ? 'Review the received collection as a whole below. Local AI Hub shows the ordered collection preview before you choose pass or fail.' : 'Review the received artifact below. If a preview is available, Local AI Hub shows it here before you choose pass or fail.'}</p>
      <ArtifactFacts artifact={artifact} className="mt-4" />
      <div className="mt-4">
        <ArtifactPreview artifact={artifact} />
      </div>
      <PlanReviewEvidence planReview={pendingValidation.planReview || pendingValidation.reviewContext?.planReview} />
      {artifactPath ? <input className="store-input mt-4" readOnly value={artifactPath} /> : null}
      <PathButtons onOpenPath={onOpenPath} onRevealPath={onRevealPath} path={artifactPath} />
      {recordInputRetryControl && recordInputRetryValues && recordInputRetryMode ? (
        <div className="mt-4 border-t border-violet-200/20 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-violet-100/80">Retry recording settings</p>
              <p className="mt-2 text-sm font-semibold text-white">{recordInputRetryControl.nodeLabel || 'Record Input'}</p>
            </div>
            <span className="rounded-full border border-white/10 bg-slate-950/50 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-violet-100/80">Temporary</span>
          </div>
          <p className="mt-3 text-xs leading-5 text-violet-50/80">These settings apply only to the fresh recording requested when you choose Fail. The recording mode and {recordInputRetryControl.outputKind} graph output stay locked for this run.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-record-input-mode">Recording mode</label>
              <input className="store-input mt-3" id="validation-record-input-mode" readOnly value={recordInputRetryControl.modeLabel || recordInputRetryMode.label} />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-record-input-output">Output contract</label>
              <input className="store-input mt-3" id="validation-record-input-output" readOnly value={`${recordInputRetryControl.outputKind} | ${recordInputRetryControl.formatLabel}`} />
            </div>
          </div>
          {recordInputRetryMode.needsScreen || recordInputRetryMode.needsSystemAudio ? <div className="mt-4 rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-xs leading-5 text-amber-100">Screen and system-audio capture can include notifications, passwords, private conversations, meeting audio, browser sounds, and confidential work. Retry recording still waits for an explicit Start Recording action.</div> : null}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {recordInputRetryControl.adjustable?.fps ? (
              <div>
                <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-record-input-fps">Frame rate</label>
                <select className="store-input mt-3" disabled={busy} id="validation-record-input-fps" onChange={(event) => onChangeRetryOverride?.('recordInput', { fps: Number(event.target.value) })} value={Number(recordInputRetryValues.fps || 15)}>
                  {[10, 15, 24, 30, 60].map((fps) => <option key={fps} value={fps}>{fps} FPS</option>)}
                </select>
              </div>
            ) : null}
            {recordInputRetryMode.needsScreen ? (
              <div>
                <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-record-input-target">Capture target</label>
                <select className="store-input mt-3" disabled={busy} id="validation-record-input-target" onChange={(event) => { const nextType = event.target.value === 'region' ? 'region' : 'desktop'; onChangeRetryOverride?.('recordInput', { captureTarget: nextType === 'region' ? buildDefaultRecordInputRegion(recordInputSelectedDisplay || recordingDisplays.find((display) => display.primary) || recordingDisplays[0]) : { type: 'desktop' } }); }} value={recordInputCaptureTargetType}>
                  <option value="desktop">{recordInputRetryMode.needsSystemAudio ? 'Selected display' : 'Full desktop'}</option>
                  <option value="region">Region</option>
                </select>
              </div>
            ) : null}
            {(recordInputRetryMode.needsDisplay || recordInputCaptureTargetType === 'region') ? (
              <div>
                <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-record-input-display">Display</label>
                <select className="store-input mt-3" disabled={busy || recordingDisplaysBusy || !recordingDisplays.length} id="validation-record-input-display" onChange={(event) => { const display = recordingDisplays.find((entry) => String(entry.id) === event.target.value) || null; onChangeRetryOverride?.('recordInput', { displayId: event.target.value, captureTarget: recordInputCaptureTargetType === 'region' ? buildDefaultRecordInputRegion(display) : recordInputRetryValues.captureTarget }); }} value={recordInputRetryValues.displayId || ''}>
                  <option value="">Choose display</option>
                  {recordingDisplays.map((display) => <option key={display.id} value={display.id}>{display.name}{display.primary ? ' (primary)' : ''}</option>)}
                </select>
              </div>
            ) : null}
            {recordInputRetryControl.adjustable?.microphone ? (
              <div>
                <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-record-input-microphone">Microphone</label>
                <select className="store-input mt-3" disabled={busy || recordingDevicesBusy || !recordingDevices.microphones.length} id="validation-record-input-microphone" onChange={(event) => onChangeRetryOverride?.('recordInput', { microphoneId: event.target.value })} value={recordInputRetryValues.microphoneId || ''}>
                  <option value="">Choose microphone</option>
                  {recordingDevices.microphones.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
                </select>
              </div>
            ) : null}
            {recordInputRetryControl.adjustable?.webcam ? (
              <div>
                <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-record-input-webcam">Webcam</label>
                <select className="store-input mt-3" disabled={busy || recordingDevicesBusy || !recordingDevices.webcams.length} id="validation-record-input-webcam" onChange={(event) => onChangeRetryOverride?.('recordInput', { webcamId: event.target.value })} value={recordInputRetryValues.webcamId || ''}>
                  <option value="">Choose webcam</option>
                  {recordingDevices.webcams.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
                </select>
              </div>
            ) : null}
          </div>
          {recordInputCaptureTargetType === 'region' ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              {['x', 'y', 'width', 'height'].map((key) => <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" key={key}>{key}<input className="store-input mt-3" disabled={busy} min={key === 'width' || key === 'height' ? 64 : undefined} onChange={(event) => onChangeRetryOverride?.('recordInput', { captureTarget: { ...(recordInputRetryValues.captureTarget || {}), displayId: recordInputRetryValues.displayId || '', [key]: Number(event.target.value), type: 'region' } })} step={key === 'width' || key === 'height' ? 2 : 1} type="number" value={recordInputRetryValues.captureTarget?.[key] ?? 0} /></label>)}
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            {(recordInputRetryMode.needsDisplay || recordInputCaptureTargetType === 'region') ? <button className="ghost-button" disabled={busy || recordingDisplaysBusy} onClick={onRefreshRecordingDisplays} type="button">{recordingDisplaysBusy ? 'Refreshing...' : 'Refresh displays'}</button> : null}
            {(recordInputRetryMode.needsMicrophone || recordInputRetryMode.needsWebcam) ? <button className="ghost-button" disabled={busy || recordingDevicesBusy} onClick={onRefreshRecordingDevices} type="button">{recordingDevicesBusy ? 'Scanning devices...' : 'Refresh devices'}</button> : null}
            {recordInputCaptureTargetType === 'region' ? <button className="ghost-button" disabled={busy || !recordInputRetryValues.displayId} onClick={() => onSelectRecordInputRegion?.(recordInputRetryControl, recordInputRetryValues)} type="button">Select region</button> : null}
          </div>
        </div>
      ) : null}
      {mediaCompositionRetryControl && mediaCompositionRetryValues ? (
        <div className="mt-4 border-t border-violet-200/20 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-violet-100/80">Retry settings</p>
              <p className="mt-2 text-sm font-semibold text-white">{mediaCompositionRetryControl.nodeLabel || 'Media Composition'}</p>
            </div>
            <span className="rounded-full border border-white/10 bg-slate-950/50 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-violet-100/80">Temporary</span>
          </div>
          <p className="mt-3 text-xs leading-5 text-violet-50/80">These settings apply only if you choose Fail to retry the next export. The saved pipeline stays unchanged.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {mediaCompositionRetryValues.compositionMode !== MEDIA_COMPOSITION_MODES.IMAGE_SLIDESHOW ? <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-source-video-volume">Source video volume</label>
              <div className="mt-3 flex items-center gap-3">
                <input className="min-w-0 flex-1 accent-cyan-300" disabled={busy} id="validation-media-composition-source-video-volume" max="200" min="0" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { sourceVideoVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME) })} step="1" type="range" value={formatVolumePercent(mediaCompositionRetryValues.sourceVideoVolume, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME)} />
                <input className="store-input w-24" disabled={busy} max="200" min="0" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { sourceVideoVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME) })} step="1" type="number" value={formatVolumePercent(mediaCompositionRetryValues.sourceVideoVolume, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME)} />
              </div>
            </div> : null}
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-narration-volume">Narration volume</label>
              <div className="mt-3 flex items-center gap-3">
                <input className="min-w-0 flex-1 accent-cyan-300" disabled={busy} id="validation-media-composition-narration-volume" max="200" min="0" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { narrationVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME) })} step="1" type="range" value={formatVolumePercent(mediaCompositionRetryValues.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME)} />
                <input className="store-input w-24" disabled={busy} max="200" min="0" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { narrationVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME) })} step="1" type="number" value={formatVolumePercent(mediaCompositionRetryValues.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME)} />
              </div>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-background-volume">Background music volume</label>
              <div className="mt-3 flex items-center gap-3">
                <input className="min-w-0 flex-1 accent-cyan-300" disabled={busy} id="validation-media-composition-background-volume" max="200" min="0" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { backgroundMusicVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME) })} step="1" type="range" value={formatVolumePercent(mediaCompositionRetryValues.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME)} />
                <input className="store-input w-24" disabled={busy} max="200" min="0" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { backgroundMusicVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME) })} step="1" type="number" value={formatVolumePercent(mediaCompositionRetryValues.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME)} />
              </div>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-sfx-enabled">SFX enabled</label>
              <label className="mt-3 flex items-center gap-3 text-sm text-violet-50/90" htmlFor="validation-media-composition-sfx-enabled"><input checked={mediaCompositionRetryValues.soundEffectsEnabled === true} className="h-4 w-4 accent-cyan-300" disabled={busy} id="validation-media-composition-sfx-enabled" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { soundEffectsEnabled: event.target.checked })} type="checkbox" />Use scheduled SFX</label>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-sfx-global-volume">Global SFX volume</label>
              <div className="mt-3 flex items-center gap-3">
                <input className="min-w-0 flex-1 accent-cyan-300" disabled={busy} id="validation-media-composition-sfx-global-volume" max="200" min="0" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { soundEffectsGlobalVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, 1) })} step="1" type="range" value={formatVolumePercent(mediaCompositionRetryValues.soundEffectsGlobalVolume, 1)} />
                <input className="store-input w-24" disabled={busy} max="200" min="0" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { soundEffectsGlobalVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, 1) })} step="1" type="number" value={formatVolumePercent(mediaCompositionRetryValues.soundEffectsGlobalVolume, 1)} />
              </div>
            </div>
            {mediaCompositionRetryValues.compositionMode === MEDIA_COMPOSITION_MODES.IMAGE_SLIDESHOW ? <>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-image-timing">Image timing</label>
              <select className="store-input mt-3" disabled={busy} id="validation-media-composition-image-timing" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { imageTimingMode: event.target.value })} value={mediaCompositionRetryValues.imageTimingMode || 'fixedDurationPerImage'}>
                <option value="fixedDurationPerImage">Fixed seconds per image</option>
                <option value="dynamicFromImageMetadata">Dynamic from metadata</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-seconds-per-item">Fallback seconds per image</label>
              <input className="store-input mt-3" disabled={busy} id="validation-media-composition-seconds-per-item" min="0.1" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { secondsPerItem: normalizeRetryNumber(event.target.value, 4, 0.1) })} step="0.1" type="number" value={mediaCompositionRetryValues.secondsPerItem ?? 4} />
            </div>
            </> : null}
            {mediaCompositionRetryValues.compositionMode !== MEDIA_COMPOSITION_MODES.SINGLE_VIDEO_MIX ? <>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-transition-mode">Transition mode</label>
              <select className="store-input mt-3" disabled={busy} id="validation-media-composition-transition-mode" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { sceneTransitionMode: event.target.value })} value={mediaCompositionRetryValues.sceneTransitionMode || 'off'}>
                {MEDIA_COMPOSITION_TRANSITION_MODE_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-transition-duration">Transition duration</label>
              <input className="store-input mt-3" disabled={busy} id="validation-media-composition-transition-duration" max="2" min="0.1" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { sceneTransitionDurationSeconds: normalizeRetryNumber(event.target.value, 0.5, 0.1) })} step="0.1" type="number" value={mediaCompositionRetryValues.sceneTransitionDurationSeconds ?? 0.5} />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-transition-name">Transition</label>
              <select className="store-input mt-3" disabled={busy} id="validation-media-composition-transition-name" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { sceneTransitionName: event.target.value })} value={mediaCompositionRetryValues.sceneTransitionName || 'fade'}>
                {MEDIA_COMPOSITION_TRANSITION_CATEGORY_OPTIONS.flatMap((category) => category.transitions || []).map((transitionName) => <option key={transitionName} value={transitionName}>{formatMediaCompositionTransitionLabel(transitionName)}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-transition-category">Transition category</label>
              <select className="store-input mt-3" disabled={busy} id="validation-media-composition-transition-category" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { sceneTransitionCategory: event.target.value })} value={mediaCompositionRetryValues.sceneTransitionCategory || 'fades'}>
                {MEDIA_COMPOSITION_TRANSITION_CATEGORY_OPTIONS.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}
              </select>
            </div>
            </> : null}
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-sfx-global-guard">Global SFX guard</label>
              <label className="mt-3 flex items-center gap-3 text-sm text-violet-50/90" htmlFor="validation-media-composition-sfx-global-guard"><input checked={mediaCompositionRetryValues.soundEffectsGlobalGuardEnabled === true} className="h-4 w-4 accent-cyan-300" disabled={busy} id="validation-media-composition-sfx-global-guard" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { soundEffectsGlobalGuardEnabled: event.target.checked })} type="checkbox" />Prevent overlaps</label>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-sfx-global-spacing">Global SFX min spacing</label>
              <input className="store-input mt-3" disabled={busy} id="validation-media-composition-sfx-global-spacing" min="0" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { soundEffectsGlobalMinSpacingSeconds: normalizeRetryNumber(event.target.value, DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS, 0) })} step="0.1" type="number" value={mediaCompositionRetryValues.soundEffectsGlobalMinSpacingSeconds ?? DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS} />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-media-composition-sfx-global-simultaneous">Global max simultaneous</label>
              <input className="store-input mt-3" disabled={busy} id="validation-media-composition-sfx-global-simultaneous" max="8" min="1" onChange={(event) => onChangeRetryOverride?.('mediaComposition', { soundEffectsGlobalMaxSimultaneous: Math.max(1, Math.min(8, Math.floor(Number(event.target.value || 0) || 1))) })} step="1" type="number" value={mediaCompositionRetryValues.soundEffectsGlobalMaxSimultaneous ?? DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS} />
            </div>
          </div>
          {mediaCompositionRetryValues.soundEffectsLayers?.length ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {mediaCompositionRetryValues.soundEffectsLayers.map((layer, index) => (
                <div key={layer.id || index}>
                  <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor={`validation-media-composition-sfx-layer-volume-${index}`}>{layer.name || `SFX layer ${index + 1}`} volume</label>
                  <div className="mt-3 flex items-center gap-3">
                    <input className="min-w-0 flex-1 accent-cyan-300" disabled={busy} id={`validation-media-composition-sfx-layer-volume-${index}`} max="200" min="0" onChange={(event) => { const nextLayers = mediaCompositionRetryValues.soundEffectsLayers.map((entry, entryIndex) => entryIndex === index ? { ...entry, volume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME) } : entry); onChangeRetryOverride?.('mediaComposition', { soundEffectsLayers: nextLayers }); }} step="1" type="range" value={formatVolumePercent(layer.volume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME)} />
                    <input className="store-input w-24" disabled={busy} max="200" min="0" onChange={(event) => { const nextLayers = mediaCompositionRetryValues.soundEffectsLayers.map((entry, entryIndex) => entryIndex === index ? { ...entry, volume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME) } : entry); onChangeRetryOverride?.('mediaComposition', { soundEffectsLayers: nextLayers }); }} step="1" type="number" value={formatVolumePercent(layer.volume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME)} />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {burnSubtitlesRetryControl && burnSubtitlesRetryValues ? (
        <div className="mt-4 border-t border-violet-200/20 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-violet-100/80">Retry caption settings</p>
              <p className="mt-2 text-sm font-semibold text-white">{burnSubtitlesRetryControl.nodeLabel || 'Burn Subtitles / Captions'}</p>
            </div>
            <span className="rounded-full border border-white/10 bg-slate-950/50 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-violet-100/80">Temporary</span>
          </div>
          <p className="mt-3 text-xs leading-5 text-violet-50/80">These settings apply only if you choose Fail to retry the next burned-caption video. The saved pipeline stays unchanged.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-burn-subtitles-mode">Caption timing</label>
              <select className="store-input mt-3" disabled={busy} id="validation-burn-subtitles-mode" onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { captionMode: event.target.value })} value={burnSubtitlesRetryValues.captionMode || 'auto'}>
                {burnSubtitlesCaptionModeOptions.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
              </select>
            </div>
            {burnSubtitlesRetryValues.captionMode === 'manualLines' ? (
              <div>
                <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-burn-subtitles-duration">Duration per caption</label>
                <input className="store-input mt-3" disabled={busy} id="validation-burn-subtitles-duration" inputMode="decimal" min="0.1" onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { durationPerCaptionSeconds: normalizeRetryNumber(event.target.value, 3, 0.1) })} step="0.1" type="number" value={burnSubtitlesRetryValues.durationPerCaptionSeconds ?? 3} />
              </div>
            ) : null}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            {[
              ['validation-burn-subtitles-font-size', 'Font size', 'fontSize', 28, 1],
              ['validation-burn-subtitles-outline', 'Outline', 'outline', 2, 0],
              ['validation-burn-subtitles-shadow', 'Shadow', 'shadow', 1, 0],
              ['validation-burn-subtitles-margin', 'Vertical margin', 'bottomMargin', 32, 0],
            ].map(([inputId, label, key, fallback, minValue]) => (
              <div key={inputId}>
                <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor={inputId}>{label}</label>
                <input className="store-input mt-3" disabled={busy} id={inputId} inputMode="decimal" min={String(minValue)} onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { [key]: normalizeRetryNumber(event.target.value, fallback, minValue) })} step="0.1" type="number" value={burnSubtitlesRetryValues[key] ?? fallback} />
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-burn-subtitles-font-source">Font source</label>
              <select className="store-input mt-3" disabled={busy} id="validation-burn-subtitles-font-source" onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { fontSource: event.target.value, fontLibraryId: event.target.value === 'assetLibrary' ? (retryFontLibrary?.id || '') : '', fontItemId: event.target.value === 'assetLibrary' ? (retryFontLibrary?.items?.[0]?.id || '') : '' })} value={burnSubtitlesRetryValues.fontSource || 'preset'}>
                {BURN_SUBTITLES_FONT_SOURCE_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
              </select>
            </div>
            {burnSubtitlesRetryValues.fontSource === 'assetLibrary' ? (
              <>
                <div>
                  <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-burn-subtitles-font-library">Font library</label>
                  <select className="store-input mt-3" disabled={busy || !fontLibraries.length} id="validation-burn-subtitles-font-library" onChange={(event) => { const library = fontLibraries.find((entry) => entry.id === event.target.value) || null; onChangeRetryOverride?.('burnSubtitles', { fontLibraryId: event.target.value, fontItemId: library?.items?.[0]?.id || '' }); }} value={burnSubtitlesRetryValues.fontLibraryId || retryFontLibrary?.id || ''}>
                    {!fontLibraries.length ? <option value="">No Font libraries</option> : null}
                    {fontLibraries.map((library) => <option key={library.id} value={library.id}>{library.name} ({library.items?.length || 0})</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-burn-subtitles-font-item">Imported font</label>
                  <select className="store-input mt-3" disabled={busy || !retryFontLibrary?.items?.length} id="validation-burn-subtitles-font-item" onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { fontItemId: event.target.value })} value={burnSubtitlesRetryValues.fontItemId || retryFontLibrary?.items?.[0]?.id || ''}>
                    {!retryFontLibrary?.items?.length ? <option value="">No imported fonts</option> : null}
                    {(retryFontLibrary?.items || []).map((item) => <option key={item.id} value={item.id}>{item.displayName || item.name}</option>)}
                  </select>
                </div>
              </>
            ) : null}
            {burnSubtitlesRetryValues.fontSource !== 'assetLibrary' ? (
              <div>
                <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-burn-subtitles-font-preset">Font preset</label>
                <select className="store-input mt-3" disabled={busy} id="validation-burn-subtitles-font-preset" onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { fontPreset: event.target.value })} value={String(burnSubtitlesRetryValues.fontPreset || 'arial')}>
                  {BURN_SUBTITLES_FONT_PRESET_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
                </select>
              </div>
            ) : null}
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-burn-subtitles-color-source">Color source</label>
              <select className="store-input mt-3" disabled={busy} id="validation-burn-subtitles-color-source" onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { colorSource: event.target.value, colorPaletteLibraryId: event.target.value === 'palette' ? (retryPaletteLibrary?.id || '') : '', textColorPaletteItemId: event.target.value === 'palette' ? (retryPaletteLibrary?.items?.[0]?.id || '') : '', outlineColorPaletteItemId: event.target.value === 'palette' ? (retryPaletteLibrary?.items?.[0]?.id || '') : '', backgroundColorPaletteItemId: event.target.value === 'palette' ? (retryPaletteLibrary?.items?.[0]?.id || '') : '' })} value={burnSubtitlesRetryValues.colorSource || 'manual'}>
                {BURN_SUBTITLES_COLOR_SOURCE_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
              </select>
            </div>
          </div>
          {burnSubtitlesRetryValues.colorSource === 'palette' ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              <div>
                <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-burn-subtitles-palette-library">Palette library</label>
                <select className="store-input mt-3" disabled={busy || !colorPaletteLibraries.length} id="validation-burn-subtitles-palette-library" onChange={(event) => { const library = colorPaletteLibraries.find((entry) => entry.id === event.target.value) || null; const itemId = library?.items?.[0]?.id || ''; onChangeRetryOverride?.('burnSubtitles', { colorPaletteLibraryId: event.target.value, textColorPaletteItemId: itemId, outlineColorPaletteItemId: itemId, backgroundColorPaletteItemId: itemId }); }} value={burnSubtitlesRetryValues.colorPaletteLibraryId || retryPaletteLibrary?.id || ''}>
                  {!colorPaletteLibraries.length ? <option value="">No Color Palette libraries</option> : null}
                  {colorPaletteLibraries.map((library) => <option key={library.id} value={library.id}>{library.name} ({library.items?.length || 0})</option>)}
                </select>
              </div>
              {[
                ['validation-burn-subtitles-palette-text', 'Text', 'textColorPaletteItemId'],
                ['validation-burn-subtitles-palette-outline', 'Outline', 'outlineColorPaletteItemId'],
                ['validation-burn-subtitles-palette-background', 'Background', 'backgroundColorPaletteItemId'],
              ].map(([inputId, label, key]) => (
                <div key={inputId}>
                  <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor={inputId}>{label}</label>
                  <select className="store-input mt-3" disabled={busy || !retryPaletteLibrary?.items?.length} id={inputId} onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { [key]: event.target.value })} value={burnSubtitlesRetryValues[key] || retryPaletteLibrary?.items?.[0]?.id || ''}>
                    {!retryPaletteLibrary?.items?.length ? <option value="">No colors</option> : null}
                    {(retryPaletteLibrary?.items || []).map((item) => <option key={item.id} value={item.id}>{item.name} ({item.hex})</option>)}
                  </select>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {[
                ['validation-burn-subtitles-text-color', 'Text color', 'textColor', 'white', BURN_SUBTITLES_TEXT_COLOR_OPTIONS],
                ['validation-burn-subtitles-outline-color', 'Outline color', 'outlineColor', 'black', BURN_SUBTITLES_OUTLINE_COLOR_OPTIONS],
                ['validation-burn-subtitles-background-color', 'Background color', 'backgroundColor', 'black', BURN_SUBTITLES_TEXT_COLOR_OPTIONS],
              ].map(([inputId, label, key, fallback, options]) => (
                <div key={inputId}>
                  <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor={inputId}>{label}</label>
                  <select className="store-input mt-3" disabled={busy} id={inputId} onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { [key]: event.target.value })} value={String(burnSubtitlesRetryValues[key] || fallback)}>
                    {options.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-burn-subtitles-position">Position</label>
              <select className="store-input mt-3" disabled={busy} id="validation-burn-subtitles-position" onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { position: event.target.value })} value={String(burnSubtitlesRetryValues.position || 'bottomCenter')}>
                {BURN_SUBTITLES_POSITION_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            {[
              ['validation-burn-subtitles-bold', 'Bold', 'bold'],
              ['validation-burn-subtitles-italic', 'Italic', 'italic'],
              ['validation-burn-subtitles-background-box', 'Background box', 'backgroundBox'],
            ].map(([inputId, label, key]) => (
              <label className="flex items-center gap-3 border border-white/10 bg-slate-950/30 px-3 py-3 text-sm text-violet-50/90" htmlFor={inputId} key={inputId}>
                <input checked={burnSubtitlesRetryValues[key] === true} className="h-4 w-4 accent-cyan-300" disabled={busy} id={inputId} onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { [key]: event.target.checked })} type="checkbox" />
                <span>{label}</span>
              </label>
            ))}
            {burnSubtitlesRetryValues.backgroundBox === true ? (
              <div>
                <label className="text-[11px] uppercase tracking-[0.16em] text-violet-100/75" htmlFor="validation-burn-subtitles-background-opacity">Background opacity</label>
                <select className="store-input mt-3" disabled={busy} id="validation-burn-subtitles-background-opacity" onChange={(event) => onChangeRetryOverride?.('burnSubtitles', { backgroundOpacity: Number(event.target.value) })} value={String(burnSubtitlesRetryValues.backgroundOpacity ?? 50)}>
                  {BURN_SUBTITLES_BACKGROUND_OPACITY_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
                </select>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}      <label className="mt-4 block text-xs uppercase tracking-[0.18em] text-violet-100/80" htmlFor="validation-comment">
        Optional note
      </label>
      <textarea
        className="store-input mt-3 min-h-[100px] resize-none"
        id="validation-comment"
        onChange={(event) => onChangeComment(event.target.value)}
        placeholder="Explain why this should pass or fail."
        value={comment}
      />
      <div className="mt-4 flex flex-wrap gap-3">
        <button className="primary-button" disabled={busy} onClick={() => onDecide('pass')} type="button">
          {busy ? 'Saving...' : 'Pass'}
        </button>
        <button className="ghost-button" disabled={busy} onClick={() => onDecide('fail')} type="button">
          Fail
        </button>
      </div>
    </div>
  );
}

function RecordInputDecisionCard({ busy, onCancel, onStart, onStop, pendingRecordInput }) {
  const [now, setNow] = useState(Date.now());
  const status = String(pendingRecordInput?.status || 'waiting').trim();
  const isRecording = status === 'recording';
  const isBusy = Boolean(busy) || ['starting', 'finalizing', 'canceling'].includes(status);

  useEffect(() => {
    if (!isRecording) {
      setNow(Date.now());
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRecording, pendingRecordInput?.requestId]);

  if (!pendingRecordInput) {
    return null;
  }

  return (
    <div className="rounded-[26px] border border-rose-400/35 bg-rose-400/10 p-5 text-rose-50">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-rose-100/75">Record Input pending</p>
          <p className="mt-2 text-lg font-semibold text-white">{pendingRecordInput.nodeLabel}</p>
          <p className="mt-2 text-sm leading-6 text-rose-50/90">{pendingRecordInput.modeLabel} | {pendingRecordInput.formatLabel} | {pendingRecordInput.outputKind}</p>
        </div>
        <span className="rounded-full border border-rose-200/20 bg-slate-950/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-50">
          {status === 'waiting' ? 'Waiting to start' : status}
        </span>
      </div>

      <div className="mt-4 rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-100">
        Screen and system-audio recording may capture notifications, private conversations, browser audio, passwords, or confidential content. Recording never starts automatically.
      </div>

      {isRecording ? (
        <p className="mt-4 text-3xl font-semibold tabular-nums text-white">
          {formatRecordInputElapsed(pendingRecordInput.startedAt || pendingRecordInput.recording?.startedAt, now)}
        </p>
      ) : null}
      {status === 'finalizing' ? <p className="mt-4 text-sm leading-6 text-rose-50/85">Finalizing the local file. The pipeline will continue only after the main-process recorder confirms a usable artifact.</p> : null}

      <div className="mt-4 flex flex-wrap gap-3">
        {status === 'waiting' ? <button className="primary-button" disabled={isBusy} onClick={onStart} type="button">{busy === 'start' ? 'Starting...' : 'Start Recording'}</button> : null}
        {status === 'recording' ? <button className="primary-button" disabled={isBusy} onClick={onStop} type="button">{busy === 'stop' ? 'Finalizing...' : 'Stop Recording'}</button> : null}
        {status === 'waiting' || status === 'recording' ? <button className="ghost-button" disabled={isBusy} onClick={onCancel} type="button">{busy === 'cancel' ? 'Canceling...' : 'Cancel / Fail'}</button> : null}
      </div>
    </div>
  );
}

function PipelineTimeline({ draft, runState, recordInputBusy, validationComment, validationRetryOverrides, fontLibraries = [], colorPaletteLibraries = [], recordingDevices = { microphones: [], webcams: [] }, recordingDisplays = [], recordingDevicesBusy = false, recordingDisplaysBusy = false, onCancelRecordInput, onChangeValidationComment, onChangeValidationRetryOverride, onDecideValidation, onOpenPath, onRefreshRecordingDevices, onRefreshRecordingDisplays, onRevealPath, onSelectRecordInputRegion, onStartRecordInput, onStopRecordInput, validationBusy }) {
  const activeNodeState = runState?.currentNodeId ? runState.nodeStates?.[runState.currentNodeId] || null : null;
  const activeAttemptLabel = formatAttemptLabel(activeNodeState?.iteration, activeNodeState?.loopMaxAttempts);
  const loopStates = Object.values(runState?.loopStates || {});
  const collectionControlStates = Object.values(runState?.collectionControlStates || {});

  if (!runState) {
    return (
      <div className="rounded-[26px] border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
        Run the current pipeline to see each step move from queued to running to finished.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className={`rounded-[26px] border px-4 py-4 ${runStatusClassName(runState.status)}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-300">Latest run</p>
            <p className="mt-2 text-lg font-semibold text-white">{runState.pipelineName}</p>
          </div>
          <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/85">
            {runState.status}
          </span>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-200">{runState.message}</p>
        {loopStates.length ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {loopStates.map((loopState) => {
              const attemptLabel = formatAttemptLabel(loopState.attempt, loopState.maxAttempts);
              return (
                <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-200" key={loopState.loopNodeId}>
                  {loopState.loopLabel}: {attemptLabel || 'Ready'}{loopState.status && loopState.status !== 'ready' ? ' | ' + loopState.status : ''}
                </span>
              );
            })}
          </div>
        ) : null}
        {collectionControlStates.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {collectionControlStates.map((collectionState) => (
              <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-200" key={collectionState.nodeId}>
                {collectionState.nodeLabel || collectionState.nodeId}: {collectionState.acceptedCount || 0}/{collectionState.targetCount || 0}{collectionState.status && collectionState.status !== 'idle' ? ' | ' + collectionState.status : ''}
              </span>
            ))}
          </div>
        ) : null}
        {loopStates.some((loopState) => Array.isArray(loopState.history) && loopState.history.length) ? (
          <div className="mt-3 space-y-3">
            {loopStates.map((loopState) => (
              <AttemptHistoryList entries={loopState.history} key={`${loopState.loopNodeId}-history`} title={`${loopState.loopLabel} activity`} />
            ))}
          </div>
        ) : null}
        {activeNodeState ? <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">Current step: {activeNodeState.nodeLabel || activeNodeState.nodeId}{activeAttemptLabel ? ` | ${activeAttemptLabel}` : ''}{activeNodeState?.loopPathLabel ? ` | ${activeNodeState.loopPathLabel}` : ''}</p> : null}
        <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
          Started {formatDateLabel(runState.startedAt)}{runState.finishedAt ? ` | Finished ${formatDateLabel(runState.finishedAt)}` : ''}
        </p>
        {runState.directories?.outputsDir ? <input className="store-input mt-4" readOnly value={runState.directories.outputsDir} /> : null}
        <PathButtons onOpenPath={onOpenPath} onRevealPath={onRevealPath} path={runState.directories?.outputsDir || ''} />
      </div>

      {runState.pendingValidation ? (
        <ValidationDecisionCard
          busy={validationBusy}
          comment={validationComment}
          onChangeComment={onChangeValidationComment}
          onChangeRetryOverride={onChangeValidationRetryOverride}
          onDecide={onDecideValidation}
          onOpenPath={onOpenPath}
          onRevealPath={onRevealPath}
          pendingValidation={runState.pendingValidation}
          retryOverrides={validationRetryOverrides}
          recordingDevices={recordingDevices}
          recordingDisplays={recordingDisplays}
          recordingDevicesBusy={recordingDevicesBusy}
          recordingDisplaysBusy={recordingDisplaysBusy}
          onRefreshRecordingDevices={onRefreshRecordingDevices}
          onRefreshRecordingDisplays={onRefreshRecordingDisplays}
          onSelectRecordInputRegion={onSelectRecordInputRegion}
          fontLibraries={fontLibraries}
          colorPaletteLibraries={colorPaletteLibraries}
        />
      ) : null}

      {runState.pendingRecordInput ? (
        <RecordInputDecisionCard
          busy={recordInputBusy}
          onCancel={onCancelRecordInput}
          onStart={onStartRecordInput}
          onStop={onStopRecordInput}
          pendingRecordInput={runState.pendingRecordInput}
        />
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[1.08fr,0.92fr]">
        <div className="rounded-[26px] border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Step-by-step status</p>
          <div className="mt-4 space-y-3">
            {runState.executionOrder.map((nodeId, index) => {
              const node = draft.nodes.find((entry) => entry.id === nodeId);
              const nodeState = runState.nodeStates?.[nodeId];
              const attemptLabel = formatAttemptLabel(nodeState?.iteration, nodeState?.loopMaxAttempts);
              const nodeArtifact = getPrimaryNodeOutputArtifact(nodeState);
              return (
                <div key={nodeId} className={`rounded-2xl border px-3 py-3 ${runStatusClassName(nodeState?.status || 'queued')}`}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-white">
                      {index + 1}. {node?.label || nodeState?.nodeLabel || nodeId}
                    </p>
                    <span className="text-[11px] uppercase tracking-[0.18em] text-slate-300">{nodeState?.status || 'queued'}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-100">{nodeState?.message || 'Waiting to run.'}</p>
                  {attemptLabel ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-400">{attemptLabel}</p> : null}
                  {nodeState?.loopPathLabel ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">Loop path: {nodeState.loopPathLabel}</p> : null}
                  {nodeState?.runCount > 1 ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">Ran {nodeState.runCount} times in this run</p> : null}
                  {nodeState?.collectionControl ? (
                    <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-400">
                      Collection progress: {nodeState.collectionControl.acceptedCount || 0} of {nodeState.collectionControl.targetCount || 0}{nodeState.collectionControl.status ? ' | ' + nodeState.collectionControl.status : ''}{nodeState.collectionControl.itemKind ? ' | ' + formatArtifactKindLabel(nodeState.collectionControl.itemKind) : ''}
                    </p>
                  ) : null}
                  {nodeState?.preview ? <p className="mt-2 text-xs leading-5 text-slate-300">{nodeState.preview}</p> : null}
                  {shouldShowInlineNodeArtifactPreview(nodeArtifact) ? (
                    <div className="mt-3">
                      <ArtifactFacts artifact={nodeArtifact} />
                      <ArtifactPreview artifact={nodeArtifact} className="mt-3" compact />
                    </div>
                  ) : null}
                  {nodeState?.selectedBranch ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-400">Routed to {nodeState.selectedBranch}</p> : null}
                  <ValidationResultSummary validation={nodeState?.validation} />
                  <AttemptHistoryList entries={nodeState?.history} title="Previous attempts" />
                  {nodeState?.destinationPath ? <input className="store-input mt-3" readOnly value={nodeState.destinationPath} /> : null}
                  <PathButtons onOpenPath={onOpenPath} onRevealPath={onRevealPath} path={nodeState?.destinationPath || ''} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-[26px] border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Outputs</p>
          <div className="mt-4 space-y-3">
            {runState.terminalResults?.length ? (
              runState.terminalResults.map((result) => (
                <ResultCard key={`${result.nodeId}-${result.title}`} onOpenPath={onOpenPath} onRevealPath={onRevealPath} result={result} />
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
                Final output cards appear here after the pipeline reaches an output node. Saved pipeline outputs still show up in the saved outputs panel below.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

class PipelineInspectorErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error, info) {
    logPipelineBuilderRendererEvent('Pipeline inspector render failed.', {
      componentStack: String(info?.componentStack || ''),
      error: formatRendererDiagnosticError(error),
      nodeId: String(this.props.nodeId || ''),
      nodeType: String(this.props.nodeType || ''),
      resetKey: String(this.props.resetKey || ''),
      section: 'inspector',
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-[24px] border border-amber-400/30 bg-amber-500/10 p-4 text-sm leading-6 text-amber-50">
          <p className="text-[11px] uppercase tracking-[0.18em] text-amber-200">Inspector issue</p>
          <p className="mt-2">
            Local AI Hub hit a problem while showing this node. Select another node or reopen the pipeline if this keeps happening.
          </p>
          <button className="ghost-button mt-3" onClick={this.props.onClearSelection} type="button">
            Clear selection
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

function ModelTargetFields({ allowLocalTool = false, connectedProviders, localAudioTools = [], localAudioTransformTools = [], localImageTools = [], localImageTransformTools = [], localTranscriptionTools = [], localVideoTools = [], modelOptions, modelsBusy, node, onRefreshModels, onUpdateNode, executionModeKey, providerIdKey }) {
  const executionMode = node.config?.[executionModeKey] === 'ollama'
    ? 'ollama'
    : allowLocalTool && node.config?.[executionModeKey] === 'localTool'
      ? 'localTool'
      : 'cloud';
  const selectedOperationId = node.type === 'llmPrompt' ? getSelectedModelStepOperationId(node) : PIPELINE_OPERATION_IDS.LLM_PROMPT;
  const selectedCloudProviderId = String(node.config?.[providerIdKey] || '').trim().toLowerCase();
  const cloudProviderOptions = node.type === 'llmPrompt' ? getCloudProvidersForOperation(connectedProviders, selectedOperationId) : connectedProviders;
  const localToolOptions = selectedOperationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
    ? localTranscriptionTools
    : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
      ? localAudioTools
      : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
        ? localAudioTransformTools
        : selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
          ? localImageTransformTools
          : selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
            ? localVideoTools
            : localImageTools;
  const localToolLabel = selectedOperationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
    ? 'Local transcription tool'
    : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
      ? 'Local audio tool'
      : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
        ? 'Local audio transform tool'
        : selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
          ? 'Local image transform tool'
          : selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
            ? 'Local video tool'
            : selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE
              ? 'Local image analysis tool'
              : 'Local image tool';
  const localToolEmptyLabel = selectedOperationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
    ? 'Choose Whisper'
    : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
      ? 'Choose AudioCraft or Chatterbox-Turbo'
      : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
        ? 'Choose RVC'
        : selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
          ? 'Choose Upscayl or FaceFusion'
          : selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
            ? 'Choose Wan2.1 WebUI'
            : 'Auto (best ready local backend)';
  const isLocalImageGenerationMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
  const isLocalImageAnalysisMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE;
  const isLocalTranscriptionMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE;
  const isLocalAudioMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE;
  const isLocalAudioTransformMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM;
  const isLocalImageTransformMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM;
  const isLocalVideoMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE;
  const selectedLocalToolId = String(node.config?.toolId || (isLocalImageGenerationMode || isLocalImageAnalysisMode ? '' : (isLocalAudioMode && node.config?.audioMode === 'referenceVoiceTts' ? localToolOptions.find((tool) => tool.id === 'chatterbox-tts')?.id || localToolOptions[0]?.id || '' : localToolOptions[0]?.id || ''))).trim();
  const selectedLocalTool = localToolOptions.find((tool) => tool.id === selectedLocalToolId) || null;
  const isLocalChatterboxAudioMode = isLocalAudioMode && selectedLocalToolId === 'chatterbox-tts';
  const isLocalAudiocraftAudioMode = isLocalAudioMode && !isLocalChatterboxAudioMode;
  const imageTransformSubtypeOptions = isLocalImageTransformMode ? getImageTransformSubtypeOptions(selectedLocalToolId) : [];
  const selectedImageTransformSubtype = isLocalImageTransformMode
    ? String(node.config?.transformSubtype || getDefaultImageTransformSubtype(selectedLocalToolId)).trim()
    : '';

  return (
    <>
      <div>
        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-execution-mode`}>
          Execution target
        </label>
        <select
          className="store-input mt-3"
          id={`${node.id}-execution-mode`}
          onChange={(event) => {
            const nextExecutionMode = event.target.value;
            onUpdateNode(node.id, (currentNode) => {
              const currentOperationId = currentNode.type === 'llmPrompt' ? getSelectedModelStepOperationId(currentNode) : PIPELINE_OPERATION_IDS.LLM_PROMPT;
              const nextOperationId = currentNode.type === 'llmPrompt' && nextExecutionMode === 'ollama'
                ? PIPELINE_OPERATION_IDS.LLM_PROMPT
                : currentNode.type === 'llmPrompt' && nextExecutionMode === 'localTool'
                  ? (currentOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                    ? PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                    : currentOperationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
                      ? PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
                      : currentOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                        ? PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                        : currentOperationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE
                          ? PIPELINE_OPERATION_IDS.IMAGE_ANALYZE
                          : currentOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                            ? PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                            : currentOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                              ? PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                              : PIPELINE_OPERATION_IDS.IMAGE_GENERATE)
                  : currentOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE || currentOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM || currentOperationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE || currentOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                    ? PIPELINE_OPERATION_IDS.LLM_PROMPT
                    : currentOperationId;
              const nextLocalToolOptions = nextOperationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
                ? localTranscriptionTools
                : nextOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                  ? localAudioTools
                  : nextOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                    ? localAudioTransformTools
                    : nextOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                      ? localImageTransformTools
                      : nextOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                        ? localVideoTools
                        : localImageTools;
              const currentToolId = String(currentNode.config?.toolId || '').trim();
              const nextToolId = nextExecutionMode === 'localTool'
                ? (nextOperationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE || nextOperationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE
                  ? (nextLocalToolOptions.some((tool) => tool.id === currentToolId) ? currentToolId : '')
                  : (nextLocalToolOptions.some((tool) => tool.id === currentToolId) ? currentToolId : nextLocalToolOptions[0]?.id || ''))
                : currentToolId;

              return {
                ...currentNode,
                config: {
                  ...currentNode.config,
                  [executionModeKey]: nextExecutionMode,
                  ...(currentNode.type === 'llmPrompt' ? { operationId: nextOperationId, toolId: nextToolId, ...(nextExecutionMode === 'localTool' && nextOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? { audioMode: normalizeAudioModeForLocalTool(nextToolId, currentNode.config?.audioMode) } : {}) } : {}),
                  [providerIdKey]: nextExecutionMode === 'cloud' && (currentNode.type !== 'llmPrompt' || providerSupportsPipelineOperation((connectedProviders || []).find((provider) => String(provider.id || '').trim().toLowerCase() === String(currentNode.config?.[providerIdKey] || '').trim().toLowerCase()), nextOperationId)) ? currentNode.config?.[providerIdKey] || '' : '',
                  model: '',
                },
              };
            });
          }}
          value={executionMode}
        >
          <option value="cloud">Cloud provider</option>
          <option value="ollama">Ollama (local)</option>
          {allowLocalTool ? <option value="localTool">Local media tool</option> : null}
        </select>
      </div>

      {executionMode === 'cloud' ? (
        <div>
          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-provider`}>
            Cloud provider
          </label>
          <select
            className="store-input mt-3"
            id={`${node.id}-provider`}
            onChange={(event) =>
              onUpdateNode(node.id, (currentNode) => ({
                ...currentNode,
                config: {
                  ...currentNode.config,
                  [providerIdKey]: event.target.value,
                  model: '',
                },
              }))
            }
            value={node.config?.[providerIdKey] || ''}
          >
            <option value="">Choose a connected provider</option>
            {cloudProviderOptions.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </div>
      ) : executionMode === 'localTool' ? (
        <div className="space-y-3">
          <div>
            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-local-tool`}>
              {localToolLabel}
            </label>
            <select
              className="store-input mt-3"
              id={`${node.id}-local-tool`}
              onChange={(event) => {
                const nextToolId = event.target.value;
                onUpdateNode(node.id, (currentNode) => ({
                  ...currentNode,
                  config: {
                    ...currentNode.config,
                    model: '',
                    toolId: nextToolId,
                    ...(isLocalAudioMode ? { audioMode: normalizeAudioModeForLocalTool(nextToolId, currentNode.config?.audioMode) } : {}),
                    ...(isLocalImageTransformMode ? { transformSubtype: getDefaultImageTransformSubtype(nextToolId) } : {}),
                  },
                }));
              }}
              value={node.config?.toolId || selectedLocalToolId || ''}
            >
              <option value="">{localToolEmptyLabel}</option>
              {localToolOptions.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.name}
                </option>
              ))}
            </select>
          </div>
          {isLocalImageTransformMode ? (
            <div>
              <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-transform-subtype`}>
                Transform subtype
              </label>
              <select
                className="store-input mt-3"
                id={`${node.id}-transform-subtype`}
                onChange={(event) =>
                  onUpdateNode(node.id, (currentNode) => ({
                    ...currentNode,
                    config: {
                      ...currentNode.config,
                      transformSubtype: event.target.value,
                    },
                  }))
                }
                value={selectedImageTransformSubtype}
              >
                {imageTransformSubtypeOptions.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                {selectedLocalToolId === 'facefusion'
                  ? 'FaceFusion is limited to image-only face swap here and needs a Reference Image connection.'
                  : selectedLocalToolId === 'upscayl'
                    ? 'Upscayl uses the same local upscaling adapter for upscale and enhancement requests in this pass.'
                    : 'Choose a transform tool to see the supported subtype for this local image transform.'}
              </p>
            </div>
          ) : null}
          <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
            {isLocalAudioMode
              ? (isLocalChatterboxAudioMode ? 'This mode runs a single Chatterbox-Turbo reference voice TTS request and returns a pipeline-usable speech artifact. Connect text plus a reference voice audio clip.' : 'This mode runs a single AudioCraft request inside the sequential pipeline and returns a pipeline-usable audio artifact. Use Music mode for text-to-music or audio-guided generation in this slice.')
              : isLocalAudioTransformMode
                ? 'This mode runs a single source-audio transformation through RVC and returns a transformed audio artifact with source lineage. Use it for offline voice conversion from one saved audio clip to another in this first pass.'
                : isLocalImageTransformMode
                  ? 'This mode runs a single local image-to-image transformation and returns a transformed image artifact with source lineage. Use Upscayl for enhancement and upscaling, or FaceFusion when you also connect a Reference Image.'
                  : isLocalVideoMode
                    ? 'This mode runs a single local Wan video request inside the sequential pipeline. Text input uses text-to-video; image input uses image-to-video and needs motion guidance. Wan generation needs a CUDA-enabled PyTorch runtime, local model folders, and substantially more VRAM than GTX 1060-class hardware. CUDA Toolkit/nvcc only affects optional acceleration packages such as flash_attn. Use the Graph Workflow step when you want graph-native video generation through ComfyUI.'
                    : isLocalImageAnalysisMode
                      ? 'This mode runs WebUI image interrogation through the best ready WebUI-compatible backend when Auto is selected and returns text from the Text output port.'
                      : 'This mode runs a single local image request through the best ready WebUI-compatible backend when Auto is selected. Use the Graph Workflow step when you need a graph-native tool such as ComfyUI.'}
          </div>
        </div>
      ) : (
        <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
          Local mode reuses the existing Ollama API path. Local AI Hub will launch Ollama automatically for this step when needed.
        </div>
      )}

      <div>
        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-model`}>
          {isLocalTranscriptionMode ? 'Transcription model' : isLocalAudioMode ? (isLocalChatterboxAudioMode ? 'Chatterbox model' : 'AudioCraft model') : isLocalAudioTransformMode ? 'Voice model' : isLocalImageAnalysisMode ? 'Analysis mode' : isLocalImageTransformMode ? 'Model set override' : isLocalVideoMode ? 'Model folder override' : executionMode === 'localTool' ? 'Checkpoint' : 'Model'}
        </label>
        <input
          className="store-input mt-3"
          id={`${node.id}-model`}
          onChange={(event) =>
            onUpdateNode(node.id, (currentNode) => ({
              ...currentNode,
              config: {
                ...currentNode.config,
                model: event.target.value,
              },
            }))
          }
          placeholder={isLocalTranscriptionMode ? 'base' : isLocalAudioMode ? (isLocalChatterboxAudioMode ? 'Managed Chatterbox-Turbo model' : 'Blank for default, or pick a downloaded AudioCraft snapshot') : isLocalAudioTransformMode ? 'Enter or pick an RVC voice model file' : isLocalImageAnalysisMode ? 'clip or deepdanbooru' : isLocalImageTransformMode ? 'Optional Upscayl paired model set' : isLocalVideoMode ? 'Optional Wan model folder name such as Wan2.1-T2V-1.3B' : executionMode === 'localTool' ? 'Enter or pick a checkpoint file name' : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? getCloudAudioModelPlaceholder(selectedCloudProviderId) : selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE ? getCloudVideoModelPlaceholder(selectedCloudProviderId) : 'Enter or pick a model'}
          value={node.config?.model || ''}
        />
        {isLocalAudiocraftAudioMode ? (
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-5 text-slate-500">
              AudioCraft can use upstream defaults when this is blank, or a downloaded local snapshot path from Model Manager when selected.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button className="ghost-button" disabled={modelsBusy} onClick={() => onRefreshModels(node)} type="button">
                {modelsBusy ? 'Refreshing...' : 'Refresh snapshots'}
              </button>
              <span className="text-xs text-slate-500">Loads downloaded AudioCraft snapshots from {selectedLocalTool?.name || 'the selected tool'}.</span>
            </div>
          </div>
        ) : isLocalChatterboxAudioMode ? (
          <p className="mt-3 text-xs leading-5 text-slate-500">
            Chatterbox-Turbo uses its managed local model cache for Reference Voice TTS. No AudioCraft snapshot is needed for this tool.
          </p>
        ) : isLocalAudioTransformMode ? (
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-5 text-slate-500">
              Choose an RVC voice model from the local weights folder. Clean single-speaker source clips work best in this first pass, and advanced pitch or index controls stay on the full RVC surface for now.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button className="ghost-button" disabled={modelsBusy} onClick={() => onRefreshModels(node)} type="button">
                {modelsBusy ? 'Refreshing...' : 'Refresh voice models'}
              </button>
              <span className="text-xs text-slate-500">Loads local RVC voice models from {selectedLocalTool?.name || 'the selected tool'}.</span>
            </div>
          </div>
        ) : isLocalImageTransformMode ? (
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-5 text-slate-500">
              Upscayl can use a downloaded paired model set when selected. Leave this blank to use the tool-managed default.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button className="ghost-button" disabled={modelsBusy} onClick={() => onRefreshModels(node)} type="button">
                {modelsBusy ? 'Refreshing...' : 'Refresh model sets'}
              </button>
              <span className="text-xs text-slate-500">Loads downloaded paired model sets from {selectedLocalTool?.name || 'the selected tool'}.</span>
            </div>
          </div>
        ) : isLocalVideoMode ? (
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-5 text-slate-500">
              Local AI Hub auto-detects Wan model folders from <code>models\Wan-AI</code>. Leave this blank unless you need to force a specific installed model folder.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button className="ghost-button" disabled={modelsBusy} onClick={() => onRefreshModels(node)} type="button">
                {modelsBusy ? 'Refreshing...' : 'Refresh folders'}
              </button>
              <span className="text-xs text-slate-500">Loads downloaded Wan model folders from {selectedLocalTool?.name || 'the selected tool'}.</span>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button className="ghost-button" disabled={modelsBusy} onClick={() => onRefreshModels(node)} type="button">
              {modelsBusy ? 'Refreshing...' : 'Refresh models'}
            </button>
            <span className="text-xs text-slate-500">
              {executionMode === 'ollama'
                ? 'Loads local Ollama models.'
                : executionMode === 'localTool'
                  ? isLocalAudioMode
                    ? 'AudioCraft uses built-in defaults in this first audio-output slice. Refresh is only needed for image checkpoints.'
                    : isLocalAudioTransformMode
                      ? `Loads local RVC voice models from ${selectedLocalTool?.name || 'the selected tool'}.`
                      : isLocalImageTransformMode
                        ? `${selectedLocalTool?.name || 'This tool'} uses tool-managed image transformation assets in this first pass, so refresh is not needed here.`
                        : isLocalTranscriptionMode
                          ? 'Shows local Whisper model size options.'
                          : isLocalImageAnalysisMode
                            ? 'WebUI image analysis uses CLIP or DeepDanbooru interrogation modes; checkpoint refresh is only needed for image generation.'
                            : `Loads local checkpoints from ${selectedLocalTool?.name || 'the selected tool'}.`
                  : node.type === 'llmPrompt' && getSelectedModelStepOperationId(node) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
                    ? 'Loads cloud image models for this provider step.'
                    : node.type === 'llmPrompt' && getSelectedModelStepOperationId(node) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                      ? getCloudAudioModelRefreshHint(selectedCloudProviderId)
                      : node.type === 'llmPrompt' && getSelectedModelStepOperationId(node) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                        ? 'Loads cloud video models for this provider step. Google Veo and xAI Grok Imagine are the supported cloud video providers here.'
                        : 'Loads models from the selected cloud provider.'}
            </span>
          </div>
        )}
        {modelOptions?.length ? (
          <div className="mt-3 grid gap-2">
            {modelOptions.slice(0, 8).map((model) => (
              <button
                className={`rounded-2xl border px-3 py-3 text-left transition ${String(node.config?.model || '').trim().toLowerCase() === String(model.id || '').trim().toLowerCase() ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-50' : 'border-white/10 bg-white/[0.03] text-slate-200 hover:border-cyan-300/20 hover:bg-white/10'}`}
                key={model.id}
                onClick={() =>
                  onUpdateNode(node.id, (currentNode) => ({
                    ...currentNode,
                    config: {
                      ...currentNode.config,
                      model: model.id,
                    },
                  }))
                }
                type="button"
              >
                <p className="text-sm font-medium text-white">{model.label || model.id}</p>
                {buildModelOptionDetail(model) ? <p className="mt-1 text-xs leading-5 text-slate-400">{buildModelOptionDetail(model)}</p> : null}
              </button>
            ))}
          </div>
        ) : null}
        {executionMode === 'cloud' && selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? (
          <p className="mt-3 text-xs leading-5 text-slate-500">
            {getCloudAudioModelHelp(selectedCloudProviderId)}
          </p>
        ) : null}
      </div>
    </>
  );
}
export default function PipelineBuilderPanel({ graphWorkflowPresets: initialGraphWorkflowPresets = EMPTY_GRAPH_WORKFLOW_PRESETS, hardware, manifests, moveDeletedPipelineOutputsToRecycleBin = true, onToast, promptStyles = [], providers, tools }) {
  const [pipelines, setPipelines] = useState([]);
  const [draft, setDraft] = useState(() => createEmptyPipeline());
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [pendingConnection, setPendingConnection] = useState(null);
  const [runState, setRunState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saveBusy, setSaveBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [recordInputBusy, setRecordInputBusy] = useState('');
  const [validationBusy, setValidationBusy] = useState(false);
  const [validationComment, setValidationComment] = useState('');
  const [validationRetryOverrides, setValidationRetryOverrides] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [modelOptionsByNodeId, setModelOptionsByNodeId] = useState({});
  const [graphWorkflowPresets, setGraphWorkflowPresets] = useState(() => (Array.isArray(initialGraphWorkflowPresets) ? initialGraphWorkflowPresets : []));
  const [soundEffectLibraries, setSoundEffectLibraries] = useState([]);
  const [fontLibraries, setFontLibraries] = useState([]);
  const [colorPaletteLibraries, setColorPaletteLibraries] = useState([]);
  const [recordingDevices, setRecordingDevices] = useState({ microphones: [], webcams: [] });
  const [recordingDisplays, setRecordingDisplays] = useState([]);
  const [recordingDevicesBusy, setRecordingDevicesBusy] = useState(false);
  const [recordingDisplaysBusy, setRecordingDisplaysBusy] = useState(false);
  const [graphWorkflowPresetName, setGraphWorkflowPresetName] = useState('');
  const [graphWorkflowPresetStatus, setGraphWorkflowPresetStatus] = useState(null);
  const [graphWorkflowPresetBusy, setGraphWorkflowPresetBusy] = useState(false);
  const [modelsBusyNodeId, setModelsBusyNodeId] = useState('');
  const [pipelineOutputs, setPipelineOutputs] = useState([]);
  const [outputsLoading, setOutputsLoading] = useState(false);
  const [outputsBusyPath, setOutputsBusyPath] = useState('');
  const [outputDeletionDialog, setOutputDeletionDialog] = useState(null);
  const [pipelineOutputsExpanded, setPipelineOutputsExpanded] = useState(false);
  const [templateSearch, setTemplateSearch] = useState('');
  const [sectionVisibility, setSectionVisibility] = useState(() => {
    if (typeof window === 'undefined') {
      return DEFAULT_PIPELINE_SECTION_VISIBILITY;
    }

    try {
      const storedValue = window.localStorage.getItem(PIPELINE_SECTION_VISIBILITY_STORAGE_KEY);
      return normalizePipelineSectionVisibility(storedValue ? JSON.parse(storedValue) : null);
    } catch {
      return DEFAULT_PIPELINE_SECTION_VISIBILITY;
    }
  });
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [canvasPanning, setCanvasPanning] = useState(false);
  const [measuredPortOffsets, setMeasuredPortOffsets] = useState({});
  const [wizardExecutionMode, setWizardExecutionMode] = useState('cloud');
  const [wizardProviderId, setWizardProviderId] = useState('');
  const [wizardModel, setWizardModel] = useState('');
  const [wizardModelOptions, setWizardModelOptions] = useState([]);
  const [wizardModelsBusy, setWizardModelsBusy] = useState(false);
  const [wizardIntent, setWizardIntent] = useState('');
  const [wizardBusy, setWizardBusy] = useState(false);
  const [wizardSummary, setWizardSummary] = useState(null);
  const canvasRef = useRef(null);
  const graphSurfaceRef = useRef(null);
  const portMeasurementFrameRef = useRef(0);
  const wizardRequestIdRef = useRef(0);
  const dragRef = useRef(null);
  const notifiedRunStateRef = useRef('');
  const outputRefreshKeyRef = useRef('');

  const ollamaModelCapabilitiesByName = useMemo(() => collectOllamaModelCapabilities(modelOptionsByNodeId), [modelOptionsByNodeId]);
  const localToolModelsByToolId = useMemo(() => collectLocalToolModelsByToolId(modelOptionsByNodeId), [modelOptionsByNodeId]);

  const pipelineTools = useMemo(
    () => (Object.keys(ollamaModelCapabilitiesByName).length || Object.keys(localToolModelsByToolId).length
      ? tools.map((tool) => {
          if (tool.id === 'ollama' && Object.keys(ollamaModelCapabilitiesByName).length) {
            return { ...tool, modelCapabilitiesByName: ollamaModelCapabilitiesByName };
          }

          if (localToolModelsByToolId[tool.id]) {
            return { ...tool, downloadedModels: localToolModelsByToolId[tool.id] };
          }

          return tool;
        })
      : tools),
    [localToolModelsByToolId, ollamaModelCapabilitiesByName, tools],
  );
  const contextMaps = useMemo(
    () => buildPipelineDisplayContext({ graphWorkflowPresets, hardware, manifests, providers, tools: pipelineTools }),
    [graphWorkflowPresets, hardware, manifests, pipelineTools, providers],
  );
  const analysis = useMemo(() => analyzePipelineDraft(draft, contextMaps), [draft, contextMaps]);
  const templateCards = useMemo(
    () => BUILT_IN_PIPELINE_TEMPLATES.map((template) => ({
      ...template,
      readiness: getPipelineTemplateReadiness(template, {
        graphWorkflowPresets,
        hardware,
        manifests,
        promptStyles,
        providers,
        tools: pipelineTools,
      }),
    })),
    [graphWorkflowPresets, hardware, manifests, pipelineTools, promptStyles, providers],
  );
  const templateGroups = useMemo(() => {
    const query = templateSearch.trim().toLowerCase();
    const visibleTemplates = query
      ? templateCards.filter((template) => [
          template.name,
          template.description,
          template.category,
          template.outputType,
          ...(template.tags || []),
          ...(template.requirements || []),
        ].some((value) => String(value || '').toLowerCase().includes(query)))
      : templateCards;
    return PIPELINE_TEMPLATE_CATEGORIES
      .map((category) => ({ category, templates: visibleTemplates.filter((template) => template.category === category) }))
      .filter((group) => group.templates.length > 0);
  }, [templateCards, templateSearch]);
  const graph = useMemo(() => buildPipelineGraph(draft), [draft]);
  const selectedNode = useMemo(() => draft.nodes.find((node) => node.id === selectedNodeId) || null, [draft.nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => draft.edges.find((edge) => edge.id === selectedEdgeId) || null, [draft.edges, selectedEdgeId]);
  const selectedSoundEffectsLibrary = useMemo(() => (selectedNode?.type === 'mediaComposition' ? soundEffectLibraries.find((library) => library.id === selectedNode.config?.soundEffectsLibraryId) || null : null), [selectedNode, soundEffectLibraries]);
  const selectedFontLibrary = useMemo(() => (selectedNode?.type === 'burnSubtitles' ? fontLibraries.find((library) => library.id === selectedNode.config?.fontLibraryId) || fontLibraries[0] || null : null), [fontLibraries, selectedNode]);
  const selectedColorPaletteLibrary = useMemo(() => (selectedNode?.type === 'burnSubtitles' ? colorPaletteLibraries.find((library) => library.id === selectedNode.config?.colorPaletteLibraryId) || colorPaletteLibraries[0] || null : null), [colorPaletteLibraries, selectedNode]);
  const selectedSoundEffectsLayers = useMemo(() => (selectedNode?.type === 'mediaComposition' ? getMediaCompositionSoundEffectsLayersForUi(selectedNode.config || {}, soundEffectLibraries) : []), [selectedNode, soundEffectLibraries]);
  const selectedRetryLoopMeta = useMemo(
    () => (selectedNode?.type === 'retryLoop' ? graph.retryLoopsByNodeId?.get?.(selectedNode.id) || null : null),
    [graph, selectedNode],
  );
  const retryLoopTargetOptions = useMemo(
    () => (selectedNode?.type === 'retryLoop' ? getRetryLoopTargetOptions(draft.nodes, graph, selectedNode.id) : []),
    [draft.nodes, graph, selectedNode],
  );
  const connectedProviders = useMemo(() => (providers || []).filter((provider) => provider.isConnected), [providers]);
  const wizardContext = useMemo(
    () => buildPipelineWizardContext({ hardware, manifests, providers, tools: pipelineTools, assetLibraries: { soundEffects: soundEffectLibraries, fonts: fontLibraries, colorPalettes: colorPaletteLibraries } }),
    [colorPaletteLibraries, fontLibraries, hardware, manifests, pipelineTools, providers, soundEffectLibraries],
  );
  const wizardTarget = useMemo(() => ({
    mode: wizardExecutionMode === 'ollama' ? 'ollama' : 'cloud',
    providerId: wizardExecutionMode === 'cloud' ? wizardProviderId : '',
    model: getWizardModelId(wizardModel),
  }), [wizardExecutionMode, wizardModel, wizardProviderId]);
  const selectedWizardModelOption = useMemo(
    () => wizardModelOptions.find((model) => model.id === getWizardModelId(wizardModel)) || null,
    [wizardModel, wizardModelOptions],
  );
  useEffect(() => {
    if (Array.isArray(initialGraphWorkflowPresets)) {
      setGraphWorkflowPresets(initialGraphWorkflowPresets);
    }
  }, [initialGraphWorkflowPresets]);

  useEffect(() => {
    let cancelled = false;
    window.localAIHub.listGraphWorkflowPresets?.().then((result) => {
      if (!cancelled && result?.ok) {
        setGraphWorkflowPresets(result.data?.presets || []);
      }
    }).catch(() => null);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.localAIHub.listAssetLibraries?.('soundEffects'),
      window.localAIHub.listAssetLibraries?.('fonts'),
      window.localAIHub.listAssetLibraries?.('colorPalettes'),
    ]).then(([soundResult, fontResult, paletteResult]) => {
      if (!cancelled) {
        if (soundResult?.ok) setSoundEffectLibraries(soundResult.data?.libraries || []);
        if (fontResult?.ok) setFontLibraries(fontResult.data?.libraries || []);
        if (paletteResult?.ok) setColorPaletteLibraries(paletteResult.data?.libraries || []);
      }
    }).catch(() => null);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedNode?.type !== 'recordInput') {
      return;
    }
    if (!recordingDevices.microphones.length && !recordingDevices.webcams.length) {
      loadRecordingDevices(false);
    }
    if (!recordingDisplays.length) {
      loadRecordingDisplays();
    }
  }, [selectedNode?.id, selectedNode?.type]);

  const audioTools = useMemo(() => (tools || []).filter((tool) => AUDIO_WORKFLOW_TOOL_IDS.includes(tool.id) && !AUDIO_TRANSFORM_TOOL_IDS.includes(tool.id)), [tools]);
  const audioTransformTools = useMemo(() => (tools || []).filter((tool) => AUDIO_TRANSFORM_TOOL_IDS.includes(tool.id)), [tools]);
  const imageTools = useMemo(() => (tools || []).filter((tool) => IMAGE_WORKFLOW_TOOL_IDS.includes(tool.id)), [tools]);
  const imageTransformTools = useMemo(() => (tools || []).filter((tool) => IMAGE_TRANSFORM_TOOL_IDS.includes(tool.id)), [tools]);
  const transcriptionTools = useMemo(() => (tools || []).filter((tool) => tool.id === 'whisper'), [tools]);
  const videoTools = useMemo(() => (tools || []).filter((tool) => VIDEO_WORKFLOW_TOOL_IDS.includes(tool.id)), [tools]);
  const graphWorkflowTools = useMemo(() => {
    const entries = [...(tools || []), ...(manifests || [])];
    const seenToolIds = new Set();
    return entries.filter((tool) => {
      const toolId = String(tool?.id || '').trim();
      if (!toolId || seenToolIds.has(toolId) || !GRAPH_WORKFLOW_TOOL_IDS.includes(toolId)) {
        return false;
      }

      seenToolIds.add(toolId);
      return true;
    });
  }, [manifests, tools]);
  const graphWorkflowPresetsById = useMemo(() => Object.fromEntries((graphWorkflowPresets || []).map((preset) => [preset.id, preset])), [graphWorkflowPresets]);
  const selectedGraphWorkflowPreset = selectedNode?.type === 'graphWorkflow' && selectedNode.config?.workflowSource === 'preset'
    ? graphWorkflowPresetsById[selectedNode.config?.graphWorkflowPresetId] || null
    : null;
  const selectedGraphWorkflowEffectiveNode = useMemo(
    () => (selectedNode?.type === 'graphWorkflow' ? resolveGraphWorkflowPresetNode(selectedNode, { graphWorkflowPresetsById }).node : selectedNode),
    [graphWorkflowPresetsById, selectedNode],
  );
  const collectionMapSelectedGraphWorkflowPreset = selectedNode?.type === 'collectionMap' && selectedNode.config?.workflowSource === 'preset'
    ? graphWorkflowPresetsById[selectedNode.config?.graphWorkflowPresetId] || null
    : null;
  const collectionMapEffectiveNode = useMemo(
    () => (selectedNode?.type === 'collectionMap' ? resolveGraphWorkflowPresetNode(selectedNode, { graphWorkflowPresetsById }).node : selectedNode),
    [graphWorkflowPresetsById, selectedNode],
  );
  const compatibleCollectionMapGraphWorkflowPresets = useMemo(() => (graphWorkflowPresets || []).filter((preset) => isGraphWorkflowPresetCompatibleWithOperation(preset)), [graphWorkflowPresets]);
  const selectedGraphWorkflowTool = useMemo(
    () => (selectedNode?.type === 'graphWorkflow'
      ? graphWorkflowTools.find((tool) => tool.id === (selectedGraphWorkflowEffectiveNode?.config?.toolId || graphWorkflowTools[0]?.id || '')) || null
      : null),
    [graphWorkflowTools, selectedNode],
  );
  const selectedGraphWorkflowToolContract = useMemo(
    () => (selectedNode?.type === 'graphWorkflow'
      ? getGraphWorkflowContract(selectedGraphWorkflowEffectiveNode?.config?.toolId || selectedGraphWorkflowTool?.id || graphWorkflowTools[0]?.id || '')
      : null),
    [graphWorkflowTools, selectedGraphWorkflowTool, selectedNode],
  );
  const selectedGraphWorkflowDefinition = useMemo(
    () => (selectedNode?.type === 'graphWorkflow'
      ? parseGraphWorkflowDefinitionText(selectedGraphWorkflowEffectiveNode?.config?.toolId || selectedGraphWorkflowTool?.id || '', selectedGraphWorkflowEffectiveNode?.config?.workflowText)
      : null),
    [selectedGraphWorkflowTool, selectedNode],
  );
  const graphWorkflowNodeOptions = selectedGraphWorkflowDefinition?.nodeEntries || [];
  const graphWorkflowTextBinding = useMemo(
    () => (selectedNode?.type === 'graphWorkflow' ? getGraphWorkflowInputBinding(selectedGraphWorkflowEffectiveNode, 'text') : null),
    [selectedNode],
  );
  const graphWorkflowImageBinding = useMemo(
    () => (selectedNode?.type === 'graphWorkflow' ? getGraphWorkflowInputBinding(selectedGraphWorkflowEffectiveNode, 'image') : null),
    [selectedNode],
  );
  const graphWorkflowImageOutputBinding = useMemo(
    () => (selectedNode?.type === 'graphWorkflow' ? getGraphWorkflowOutputBinding(selectedGraphWorkflowEffectiveNode, 'image') : null),
    [selectedNode],
  );
  const graphWorkflowVideoOutputBinding = useMemo(
    () => (selectedNode?.type === 'graphWorkflow' ? getGraphWorkflowOutputBinding(selectedGraphWorkflowEffectiveNode, 'video') : null),
    [selectedNode],
  );
  const graphWorkflowTextFieldOptions = useMemo(
    () => getGraphWorkflowFieldOptions(selectedGraphWorkflowDefinition, graphWorkflowTextBinding?.nodeId, 'text'),
    [graphWorkflowTextBinding?.nodeId, selectedGraphWorkflowDefinition],
  );
  const graphWorkflowImageFieldOptions = useMemo(
    () => getGraphWorkflowFieldOptions(selectedGraphWorkflowDefinition, graphWorkflowImageBinding?.nodeId, 'image'),
    [graphWorkflowImageBinding?.nodeId, selectedGraphWorkflowDefinition],
  );
  const graphWorkflowImageOutputNodeOptions = useMemo(
    () => getGraphWorkflowOutputNodeOptions(selectedGraphWorkflowDefinition, 'image'),
    [selectedGraphWorkflowDefinition],
  );
  const graphWorkflowVideoOutputNodeOptions = useMemo(
    () => getGraphWorkflowOutputNodeOptions(selectedGraphWorkflowDefinition, 'video'),
    [selectedGraphWorkflowDefinition],
  );
  const collectionMapGraphWorkflowTool = useMemo(
    () => (selectedNode?.type === 'collectionMap'
      ? graphWorkflowTools.find((tool) => tool.id === (selectedNode.config?.graphWorkflowToolId || graphWorkflowTools[0]?.id || '')) || null
      : null),
    [graphWorkflowTools, selectedNode],
  );
  const collectionMapGraphWorkflowContract = useMemo(
    () => (selectedNode?.type === 'collectionMap'
      ? getGraphWorkflowContract(selectedNode.config?.graphWorkflowToolId || collectionMapGraphWorkflowTool?.id || graphWorkflowTools[0]?.id || '')
      : null),
    [collectionMapGraphWorkflowTool, graphWorkflowTools, selectedNode],
  );
  const collectionMapGraphWorkflowDefinition = useMemo(
    () => (selectedNode?.type === 'collectionMap'
      ? parseGraphWorkflowDefinitionText(collectionMapEffectiveNode?.config?.graphWorkflowToolId || collectionMapEffectiveNode?.config?.toolId || collectionMapGraphWorkflowTool?.id || '', collectionMapEffectiveNode?.config?.workflowText)
      : null),
    [collectionMapGraphWorkflowTool, selectedNode],
  );
  const collectionMapGraphWorkflowSupport = useMemo(
    () => (selectedNode?.type === 'collectionMap' ? getGraphWorkflowOperationBackendSupport(selectedNode, undefined, { graphWorkflowPresetsById }) : null),
    [selectedNode],
  );
  const selectedCollectionMapMapping = useMemo(
    () => (selectedNode?.type === 'collectionMap' ? getCollectionMapMapping(selectedNode) : null),
    [selectedNode],
  );
  const collectionMapLocalTools = useMemo(() => {
    if (!selectedCollectionMapMapping) return [];
    if (selectedCollectionMapMapping.operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) return audioTools;
    if (selectedCollectionMapMapping.operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) return audioTransformTools;
    if (selectedCollectionMapMapping.operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) return transcriptionTools;
    if (selectedCollectionMapMapping.operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) return imageTransformTools.filter((tool) => tool.id === 'upscayl');
    if (selectedCollectionMapMapping.operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) return videoTools;
    return imageTools;
  }, [audioTools, audioTransformTools, imageTools, imageTransformTools, selectedCollectionMapMapping, transcriptionTools, videoTools]);
  const collectionMapGraphWorkflowNodeOptions = collectionMapGraphWorkflowDefinition?.nodeEntries || [];
  const collectionMapGraphWorkflowTextBinding = useMemo(
    () => (selectedNode?.type === 'collectionMap' ? getGraphWorkflowInputBinding(collectionMapEffectiveNode, 'text') : null),
    [collectionMapEffectiveNode, selectedNode],
  );
  const collectionMapGraphWorkflowImageOutputBinding = useMemo(
    () => (selectedNode?.type === 'collectionMap' ? getGraphWorkflowOutputBinding(collectionMapEffectiveNode, 'image') : null),
    [collectionMapEffectiveNode, selectedNode],
  );
  const collectionMapGraphWorkflowTextFieldOptions = useMemo(
    () => getGraphWorkflowFieldOptions(collectionMapGraphWorkflowDefinition, collectionMapGraphWorkflowTextBinding?.nodeId, 'text'),
    [collectionMapGraphWorkflowDefinition, collectionMapGraphWorkflowTextBinding?.nodeId],
  );
  const collectionMapGraphWorkflowImageOutputNodeOptions = useMemo(
    () => getGraphWorkflowOutputNodeOptions(collectionMapGraphWorkflowDefinition, 'image'),
    [collectionMapGraphWorkflowDefinition],
  );
  const currentPipelineSaved = useMemo(() => pipelines.some((pipeline) => pipeline.id === draft.id), [pipelines, draft.id]);
  const activeSavedPipeline = useMemo(() => pipelines.find((pipeline) => pipeline.id === draft.id) || null, [pipelines, draft.id]);
  const pipelineMetadataDirty = useMemo(() => {
    if (!activeSavedPipeline) {
      return false;
    }

    return String(activeSavedPipeline.name || '').trim() !== String(draft.name || '').trim()
      || String(activeSavedPipeline.description || '').trim() !== String(draft.description || '').trim();
  }, [activeSavedPipeline, draft.description, draft.name]);
  const visibleSavedPipelines = useMemo(
    () => pipelines.map((pipeline) => (
      pipeline.id === draft.id
        ? {
            ...pipeline,
            description: pipelineMetadataDirty ? draft.description : pipeline.description,
            name: pipelineMetadataDirty ? draft.name : pipeline.name,
          }
        : pipeline
    )),
    [draft.description, draft.id, draft.name, pipelineMetadataDirty, pipelines],
  );
  const currentNodeSummary = selectedNode ? analysis.nodeSummaries?.[selectedNode.id] || null : null;
  const canvasSize = useMemo(() => {
    if (!draft.nodes.length) {
      return { height: CANVAS_MIN_HEIGHT, width: CANVAS_MIN_WIDTH };
    }

    const bounds = draft.nodes.reduce((accumulator, node) => {
      const nodeBottom = node.position.y + getNodeCardHeight(node);
      const nodeRight = node.position.x + PIPELINE_NODE_WIDTH;
      return {
        maxX: Math.max(accumulator.maxX, nodeRight),
        maxY: Math.max(accumulator.maxY, nodeBottom),
        minX: Math.min(accumulator.minX, node.position.x),
        minY: Math.min(accumulator.minY, node.position.y),
      };
    }, {
      maxX: 0,
      maxY: 0,
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
    });
    const spanWidth = Math.max(0, bounds.maxX - bounds.minX);
    const spanHeight = Math.max(0, bounds.maxY - bounds.minY);
    const densityPaddingX = Math.min(3200, CANVAS_PADDING_X + draft.nodes.length * 88);
    const densityPaddingY = Math.min(2800, CANVAS_PADDING_Y + draft.nodes.length * 72);
    return {
      height: Math.max(CANVAS_MIN_HEIGHT, Math.round(bounds.maxY + densityPaddingY), Math.round(spanHeight + CANVAS_PADDING_Y * 2)),
      width: Math.max(CANVAS_MIN_WIDTH, Math.round(bounds.maxX + densityPaddingX), Math.round(spanWidth + CANVAS_PADDING_X * 2)),
    };
  }, [draft.nodes]);
  const scaledCanvasSize = useMemo(
    () => ({
      height: Math.round(canvasSize.height * canvasZoom),
      width: Math.round(canvasSize.width * canvasZoom),
    }),
    [canvasSize.height, canvasSize.width, canvasZoom],
  );
  const savePipelineLabel = saveBusy ? (currentPipelineSaved ? 'Updating...' : 'Saving...') : (currentPipelineSaved ? 'Update pipeline' : 'Save pipeline');

  function replaceDraft(nextPipeline, options = {}) {
    setDraft(nextPipeline);
    setSelectedNodeId((current) => {
      if (options.selectedNodeId !== undefined) {
        return options.selectedNodeId;
      }
      if (current && nextPipeline.nodes.some((node) => node.id === current)) {
        return current;
      }
      return nextPipeline.nodes[0]?.id || '';
    });
    setPendingConnection(null);
    setDirty(Boolean(options.dirty));
  }

  function applyRunSnapshot(nextRun) {
    setRunState((current) => {
      if (!nextRun) {
        return null;
      }

      if (!current || current.runId !== nextRun.runId) {
        return nextRun;
      }

      const currentRevision = Number(current.revision || 0);
      const nextRevision = Number(nextRun.revision || 0);
      return nextRevision < currentRevision ? current : nextRun;
    });
  }

  function rememberHistoricalRunNotification(nextRun) {
    if (!nextRun?.runId || !nextRun?.status) {
      return;
    }

    if (nextRun.status === 'completed' || nextRun.status === 'failed' || nextRun.status === 'cancelled') {
      notifiedRunStateRef.current = `${nextRun.runId}:${nextRun.status}`;
    }
  }
  function markDirty() {
    setDirty(true);
  }

  function updateNode(nodeId, updater) {
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
    }));
    markDirty();
  }

  function changeRecordInputMode(node, nextMode) {
    let change;
    try {
      change = applyRecordInputModeChange(draft, node.id, nextMode);
    } catch (error) {
      onToast(error?.message || 'Local AI Hub could not change that Record Input mode.', 'error');
      return;
    }
    if (change.requiresConfirmation) {
      const message = `Changing this recording mode will change the output from ${change.impact.oldOutputKind} to ${change.impact.newOutputKind} and remove incompatible connections.`;
      if (!window.confirm(`${message}\n\nChange mode and remove incompatible connections?`)) {
        return;
      }
    }
    setDraft((current) => applyRecordInputModeChange(current, node.id, nextMode, {
      removeIncompatibleConnections: change.requiresConfirmation,
    }).pipeline);
    markDirty();
    if (change.requiresConfirmation) {
      onToast('Record Input mode changed and incompatible outgoing connections were removed.', 'success');
    }
  }

  function changeMediaCompositionMode(node, nextMode) {
    let change;
    try {
      change = applyMediaCompositionModeChange(draft, node.id, nextMode);
    } catch (error) {
      onToast(error?.message || 'Local AI Hub could not change that Media Composition mode.', 'error');
      return;
    }
    if (change.requiresConfirmation) {
      if (!window.confirm('Changing this composition mode will remove incompatible visual input connections.\n\nChange mode and remove those connections?')) {
        return;
      }
    }
    setDraft((current) => applyMediaCompositionModeChange(current, node.id, nextMode, {
      removeIncompatibleConnections: change.requiresConfirmation,
    }).pipeline);
    markDirty();
    if (change.requiresConfirmation) {
      onToast('Media Composition mode changed and incompatible visual connections were removed.', 'success');
    }
  }

  function getDefaultCollectionMapLocalToolId(operationId) {
    if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) return audioTools[0]?.id || 'audiocraft-webui';
    if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) return audioTransformTools[0]?.id || 'rvc';
    if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) return transcriptionTools[0]?.id || 'whisper';
    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) return imageTransformTools.find((tool) => tool.id === 'upscayl')?.id || 'upscayl';
    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE || operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) return imageTools[0]?.id || '';
    if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) return videoTools[0]?.id || 'wan21-webui';
    return '';
  }

  function buildCollectionMapConfigForMapping(currentConfig = {}, mapping, executionMode) {
    const operationId = mapping?.operationId || PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
    const graphToolId = String(currentConfig.graphWorkflowToolId || graphWorkflowTools[0]?.id || 'comfyui').trim();
    const graphDefaults = getDefaultGraphWorkflowBindings(graphToolId);
    const nextConfig = {
      mappingId: mapping?.id || 'textToImage',
      operationId,
      executionMode,
      providerId: executionMode === 'cloud' ? currentConfig.providerId || '' : '',
      toolId: executionMode === 'localTool' ? getDefaultCollectionMapLocalToolId(operationId) : '',
      graphWorkflowToolId: executionMode === 'graphWorkflow' ? graphToolId : currentConfig.graphWorkflowToolId || '',
      workflowText: executionMode === 'graphWorkflow' ? currentConfig.workflowText || '' : currentConfig.workflowText || '',
      inputBindings: executionMode === 'graphWorkflow' ? currentConfig.inputBindings || graphDefaults.inputBindings : currentConfig.inputBindings,
      outputBindings: executionMode === 'graphWorkflow' ? currentConfig.outputBindings || graphDefaults.outputBindings : currentConfig.outputBindings,
      workflowFormat: executionMode === 'graphWorkflow' ? currentConfig.workflowFormat || graphDefaults.workflowFormat : currentConfig.workflowFormat,
      model: '',
      instruction: getCollectionMapDefaultInstruction(operationId, mapping),
      failureMode: currentConfig.failureMode === 'partial' ? 'partial' : 'fail-fast',
      perItemValidation: currentConfig.perItemValidation && typeof currentConfig.perItemValidation === 'object'
        ? currentConfig.perItemValidation
        : { enabled: false, mode: 'llm', llmExecutionMode: 'cloud', providerId: '', model: '', ruleset: '', systemPrompt: '', maxAttempts: 2, retryInstruction: '', failMode: 'fail-fast' },
    };

    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
      nextConfig.imageSize = currentConfig.imageSize || '1024x1024';
      nextConfig.imageQuality = currentConfig.imageQuality || 'auto';
      nextConfig.imageBackground = currentConfig.imageBackground || 'auto';
      nextConfig.negativePrompt = currentConfig.negativePrompt || '';
      nextConfig.width = Number(currentConfig.width || 832) || 832;
      nextConfig.height = Number(currentConfig.height || 832) || 832;
      nextConfig.steps = Number(currentConfig.steps || 24) || 24;
      nextConfig.cfgScale = Number(currentConfig.cfgScale || 7) || 7;
      nextConfig.seed = Number(currentConfig.seed ?? -1);
    } else if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
      nextConfig.audioMode = currentConfig.audioMode || 'music';
      nextConfig.audiocraftItemMode = currentConfig.audiocraftItemMode === 'sequentialContinuation' ? 'sequentialContinuation' : 'independent';
      nextConfig.audioChainFirstItemBehavior = 'scratch';
      nextConfig.audioChainOutputMode = 'segments';
      nextConfig.continuationRepeatCount = Math.max(1, Math.min(10, Math.floor(Number(currentConfig.continuationRepeatCount || 1) || 1)));
      nextConfig.continuationSeedSeconds = Number(currentConfig.continuationSeedSeconds || 12) || 12;
      nextConfig.appendSource = Boolean(currentConfig.appendSource);
      nextConfig.durationSeconds = Number(currentConfig.durationSeconds || 8) || 8;
      nextConfig.audiocraftTemperature = Number(currentConfig.audiocraftTemperature || 1) || 1;
      nextConfig.audiocraftTopK = Number(currentConfig.audiocraftTopK ?? 250) || 250;
      nextConfig.audiocraftTopP = Number(currentConfig.audiocraftTopP || 0) || 0;
      nextConfig.audiocraftCfgCoef = Number(currentConfig.audiocraftCfgCoef || 3) || 3;
      nextConfig.audiocraftTwoStepCfg = Boolean(currentConfig.audiocraftTwoStepCfg);
      nextConfig.audioVoice = currentConfig.audioVoice || '';
    } else if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
      nextConfig.videoSize = currentConfig.videoSize || '1280x720';
      nextConfig.videoAspectRatio = currentConfig.videoAspectRatio || (nextConfig.videoSize === '720x1280' ? '9:16' : '16:9');
      nextConfig.videoResolution = currentConfig.videoResolution || '720p';
      nextConfig.videoFps = Number(currentConfig.videoFps || 15) || 15;
      nextConfig.videoQuality = Number(currentConfig.videoQuality || 5) || 5;
      nextConfig.videoItemMode = currentConfig.videoItemMode === 'sequentialLastFrame' ? 'sequentialLastFrame' : 'independent';
      nextConfig.videoChainFirstItemBehavior = currentConfig.videoChainFirstItemBehavior === 'initialReferenceImage' ? 'initialReferenceImage' : 'textToVideo';
      nextConfig.videoInitialReferenceImagePath = currentConfig.videoInitialReferenceImagePath || '';
      nextConfig.negativePrompt = currentConfig.negativePrompt || '';
      nextConfig.steps = Number(currentConfig.steps || 24) || 24;
      nextConfig.seed = Number(currentConfig.seed ?? -1);
      nextConfig.durationSeconds = Number(currentConfig.durationSeconds || 8) || 8;

    } else if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
      nextConfig.transformSubtype = currentConfig.transformSubtype || 'upscale';
      nextConfig.scale = Number(currentConfig.scale || 4) || 4;
    } else if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
      nextConfig.analysisMode = currentConfig.analysisMode || 'clip';
    }

    return nextConfig;
  }

  function updateCollectionMapExecutionMode(nodeId, nextMode) {
    updateNode(nodeId, (currentNode) => {
      const mapping = getCollectionMapMapping(currentNode) || COLLECTION_MAP_MAPPING_OPTIONS[0];
      const requestedMode = nextMode === 'localTool' ? 'localTool' : nextMode === 'graphWorkflow' ? 'graphWorkflow' : 'cloud';
      const executionMode = mapping.modes.includes(requestedMode) ? requestedMode : mapping.modes[0] || 'cloud';
      return {
        ...currentNode,
        config: buildCollectionMapConfigForMapping(currentNode.config || {}, mapping, executionMode),
      };
    });
  }

  function updateCollectionMapMapping(nodeId, mappingId) {
    const mapping = COLLECTION_MAP_MAPPING_OPTIONS.find((entry) => entry.id === mappingId) || COLLECTION_MAP_MAPPING_OPTIONS[0];
    updateNode(nodeId, (currentNode) => {
      const currentMode = currentNode.config?.executionMode === 'graphWorkflow' ? 'graphWorkflow' : currentNode.config?.executionMode === 'localTool' ? 'localTool' : 'cloud';
      const executionMode = mapping.modes.includes(currentMode) ? currentMode : mapping.modes[0] || 'cloud';
      return {
        ...currentNode,
        config: buildCollectionMapConfigForMapping(currentNode.config || {}, mapping, executionMode),
      };
    });
  }

  function updateGraphWorkflowInputBinding(nodeId, portId, nextBinding) {
    updateNode(nodeId, (currentNode) => ({
      ...currentNode,
      config: {
        ...currentNode.config,
        inputBindings: {
          ...(currentNode.config?.inputBindings || {}),
          [portId]: {
            ...(currentNode.config?.inputBindings?.[portId] || {}),
            ...nextBinding,
          },
        },
      },
    }));
  }

  function updateGraphWorkflowOutputBinding(nodeId, portId, nextBinding) {
    updateNode(nodeId, (currentNode) => ({
      ...currentNode,
      config: {
        ...currentNode.config,
        outputBindings: {
          ...(currentNode.config?.outputBindings || {}),
          [portId]: {
            ...(currentNode.config?.outputBindings?.[portId] || {}),
            ...nextBinding,
          },
        },
      },
    }));
  }

  function buildGraphWorkflowPresetPayload(node, options = {}) {
    const config = node?.type === 'collectionMap'
      ? {
          ...(node.config || {}),
          toolId: node.config?.graphWorkflowToolId || node.config?.toolId || '',
        }
      : node?.config || {};
    return {
      description: String(options.description || '').trim(),
      id: String(options.id || '').trim(),
      inputBindings: config.inputBindings || {},
      name: String(options.name || '').trim(),
      outputBindings: config.outputBindings || {},
      toolId: config.toolId || config.graphWorkflowToolId || '',
      workflowFormat: config.workflowFormat || '',
      workflowText: config.workflowText || '',
    };
  }

  async function refreshGraphWorkflowPresets() {
    const result = await window.localAIHub.listGraphWorkflowPresets?.();
    if (result?.ok) {
      setGraphWorkflowPresets(result.data?.presets || []);
    }
    return result?.data?.presets || [];
  }

  async function saveGraphWorkflowPresetFromNode(node) {
    const defaultName = node?.label ? node.label + ' preset' : 'Graph workflow preset';
    const name = String(graphWorkflowPresetName || defaultName).trim();
    if (!name) {
      setGraphWorkflowPresetStatus({ kind: 'error', message: 'Enter a preset name before saving.' });
      return;
    }

    if (!window.localAIHub.saveGraphWorkflowPreset) {
      const message = 'Local AI Hub could not reach the graph workflow preset service.';
      setGraphWorkflowPresetStatus({ kind: 'error', message });
      onToast(message, 'error');
      return;
    }

    setGraphWorkflowPresetBusy(true);
    setGraphWorkflowPresetStatus({ kind: 'info', message: 'Saving graph workflow preset...' });
    try {
      const result = await window.localAIHub.saveGraphWorkflowPreset(buildGraphWorkflowPresetPayload(node, { name }));
      if (!result?.ok) {
        const message = result?.message || 'Local AI Hub could not save that graph workflow preset.';
        setGraphWorkflowPresetStatus({ kind: 'error', message });
        onToast(message, 'error');
        return;
      }

      let presets = result.data?.presets || result.data?.state?.graphWorkflowPresets || [];
      if (!Array.isArray(presets) || !presets.length) {
        presets = await refreshGraphWorkflowPresets();
      } else {
        setGraphWorkflowPresets(presets);
      }
      const savedPreset = presets.find((preset) => String(preset?.name || '').trim() === name) || presets[presets.length - 1] || null;
      const message = result.data?.message || 'Graph workflow preset saved.';
      setGraphWorkflowPresetName('');
      setGraphWorkflowPresetStatus({ kind: 'success', message: savedPreset?.name ? message + ' ' + savedPreset.name + ' is ready to select.' : message });
      onToast(message, 'success');
    } catch (error) {
      const message = error?.message || 'Local AI Hub could not save that graph workflow preset.';
      setGraphWorkflowPresetStatus({ kind: 'error', message });
      onToast(message, 'error');
    } finally {
      setGraphWorkflowPresetBusy(false);
    }
  }

  async function deleteGraphWorkflowPreset(presetId) {
    const preset = graphWorkflowPresetsById[presetId] || null;
    if (!preset || !window.confirm('Delete the graph workflow preset "' + preset.name + '"? Nodes using it will show a missing-preset readiness issue.')) {
      return;
    }

    const result = await window.localAIHub.deleteGraphWorkflowPreset(presetId);
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not delete that graph workflow preset.', 'error');
      return;
    }

    const presets = result.data?.presets || result.data?.state?.graphWorkflowPresets || [];
    setGraphWorkflowPresets(presets);
    onToast(result.data?.message || 'Graph workflow preset deleted.', 'success');
  }

  function applyGraphWorkflowPresetToNode(nodeId, presetId, mode = 'graphWorkflow') {
    const preset = graphWorkflowPresetsById[presetId] || null;
    updateNode(nodeId, (currentNode) => {
      if (!preset) {
        return {
          ...currentNode,
          config: {
            ...currentNode.config,
            graphWorkflowPresetId: '',
            workflowSource: 'local',
          },
        };
      }

      const presetConfig = buildGraphWorkflowConfigFromPreset(preset);
      return {
        ...currentNode,
        config: currentNode.type === 'collectionMap'
          ? {
              ...currentNode.config,
              graphWorkflowPresetId: preset.id,
              graphWorkflowToolId: preset.toolId,
              inputBindings: presetConfig.inputBindings,
              outputBindings: presetConfig.outputBindings,
              workflowFormat: presetConfig.workflowFormat,
              workflowSource: 'preset',
              workflowText: presetConfig.workflowText,
            }
          : {
              ...currentNode.config,
              ...presetConfig,
              workflowSource: 'preset',
            },
      };
    });
  }

  function detachGraphWorkflowPreset(nodeId, preset) {
    if (!preset) return;
    const presetConfig = buildGraphWorkflowConfigFromPreset(preset);
    updateNode(nodeId, (currentNode) => ({
      ...currentNode,
      config: currentNode.type === 'collectionMap'
        ? {
            ...currentNode.config,
            graphWorkflowPresetId: '',
            graphWorkflowToolId: preset.toolId,
            inputBindings: presetConfig.inputBindings,
            outputBindings: presetConfig.outputBindings,
            workflowFormat: presetConfig.workflowFormat,
            workflowSource: 'local',
            workflowText: presetConfig.workflowText,
          }
        : {
            ...currentNode.config,
            ...presetConfig,
            graphWorkflowPresetId: '',
            workflowSource: 'local',
          },
    }));
  }

  async function refreshPipelineList() {
    const result = await window.localAIHub.listPipelines();
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not load the saved pipelines.', 'error');
      return [];
    }

    const savedPipelines = result.data?.pipelines || [];
    setPipelines(savedPipelines);
    return savedPipelines;
  }

  async function loadRecordingDevices(forceRefresh = false) {
    setRecordingDevicesBusy(true);
    try {
      const result = await window.localAIHub.listRecordingDevices(forceRefresh);
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not refresh recording devices.', 'error');
        return;
      }
      setRecordingDevices(result.data || { microphones: [], webcams: [] });
    } finally {
      setRecordingDevicesBusy(false);
    }
  }

  async function loadRecordingDisplays() {
    setRecordingDisplaysBusy(true);
    try {
      const result = await window.localAIHub.listRecordingDisplays();
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not read the available displays.', 'error');
        return;
      }
      setRecordingDisplays(result.data?.displays || []);
    } finally {
      setRecordingDisplaysBusy(false);
    }
  }

  async function loadPipelineOutputs(options = {}) {
    if (!options.silent) {
      setOutputsLoading(true);
    }

    try {
      const result = await window.localAIHub.listPipelineOutputs();
      if (!result?.ok) {
        if (!options.silent) {
          onToast(result?.message || 'Local AI Hub could not load the saved pipeline outputs.', 'error');
        }
        return [];
      }

      const nextOutputs = result.data?.outputs || [];
      setPipelineOutputs(nextOutputs);
      return nextOutputs;
    } catch (error) {
      if (!options.silent) {
        onToast(error?.message || 'Local AI Hub could not load the saved pipeline outputs.', 'error');
      }
      return [];
    } finally {
      if (!options.silent) {
        setOutputsLoading(false);
      }
    }
  }

  async function loadSavedPipeline(pipelineId, options = {}) {
    if (!pipelineId) {
      return;
    }

    if (dirty && !options.force) {
      const confirmed = window.confirm('Discard the unsaved pipeline changes and load another saved pipeline?');
      if (!confirmed) {
        return;
      }
    }

    const result = await window.localAIHub.getPipeline(pipelineId);
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not load that pipeline.', 'error');
      return;
    }

    replaceDraft(result.data?.pipeline || createEmptyPipeline(), {
      dirty: false,
    });
  }

  async function openPath(pathValue, reveal = false) {
    if (!pathValue) {
      return;
    }

    const result = await window.localAIHub.openPath({ path: pathValue, reveal });
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not open that file or folder.', 'error');
    }
  }

  async function handleDeleteOutput(output) {
    const outputPath = output?.outputPath || getArtifactStoragePath(output?.artifact || null);
    if (!outputPath) {
      return;
    }

    const result = await window.localAIHub.getPipelineOutputDeletionPreview({ path: outputPath });
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not prepare that pipeline output cleanup preview.', 'error');
      return;
    }

    setOutputDeletionDialog({ includeIntermediates: false, output, preview: result.data });
  }

  async function confirmDeleteOutput() {
    const dialog = outputDeletionDialog;
    const output = dialog?.output;
    const outputPath = output?.outputPath || getArtifactStoragePath(output?.artifact || null);
    if (!dialog || !outputPath) {
      return;
    }

    const outputLabel = output?.outputLabel || output?.fileName || 'this pipeline output';
    setOutputsBusyPath(outputPath);
    logRendererActionDiagnostic('pipeline-output-delete', 'start', {
      hasOutputPath: Boolean(outputPath),
      includeIntermediates: dialog.includeIntermediates,
      outputId: String(output?.id || ''),
    });
    try {
      const result = await window.localAIHub.deletePipelineOutput({ includeIntermediates: dialog.includeIntermediates, path: outputPath });
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not delete that pipeline output.', 'error');
        await loadPipelineOutputs({ silent: true });
        return;
      }

      setOutputDeletionDialog(null);
      setPipelineOutputs((current) => current.filter((entry) => entry.id !== output.id));
      logRendererActionDiagnostic('pipeline-output-delete', 'success', { outputId: String(output?.id || '') });
      onToast(result.data?.message || `${outputLabel} was deleted.`, 'success');
      await loadPipelineOutputs({ silent: true });
    } catch (error) {
      logRendererActionDiagnostic('pipeline-output-delete', 'failure', { message: String(error?.message || '') }, 'warn');
      onToast(error?.message || 'Local AI Hub could not delete that pipeline output.', 'error');
      await loadPipelineOutputs({ silent: true });
    } finally {
      setOutputsBusyPath('');
      expectNextPrintableKeyDiagnostic('pipeline-output-delete', { outputId: String(output?.id || '') });
    }
  }
  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.localAIHub.onPipelineRunUpdate((payload) => {
      if (disposed || !payload?.run) {
        return;
      }

      applyRunSnapshot(payload.run);
      if (payload.run.status !== 'running') {
        setRunBusy(false);
      }
      if (payload.run.status !== 'running' && payload.run.status !== 'paused') {
        setCancelBusy(false);
        setRecordInputBusy('');
        setValidationBusy(false);
      }
    });

    async function loadInitialState() {
      setOutputsLoading(true);
      const [savedPipelines, activeRunResult, pipelineOutputsResult] = await Promise.all([
        refreshPipelineList(),
        window.localAIHub.getActivePipelineRun(),
        window.localAIHub.listPipelineOutputs(),
      ]);
      if (disposed) {
        return;
      }
      if (pipelineOutputsResult?.ok) {
        setPipelineOutputs(pipelineOutputsResult.data?.outputs || []);
      } else if (pipelineOutputsResult?.message) {
        onToast(pipelineOutputsResult.message, 'error');
      }
      setOutputsLoading(false);

      if (activeRunResult?.ok) {
        const historicalRun = activeRunResult.data?.run || null;
        rememberHistoricalRunNotification(historicalRun);
        applyRunSnapshot(historicalRun);
      } else if (activeRunResult?.message) {
        onToast(activeRunResult.message, 'error');
      }

      if (savedPipelines.length > 0) {
        const pipelineResult = await window.localAIHub.getPipeline(savedPipelines[0].id);
        if (!disposed && pipelineResult?.ok) {
          replaceDraft(pipelineResult.data?.pipeline || createEmptyPipeline(), {
            dirty: false,
          });
        }
      }

      if (!disposed) {
        setLoading(false);
      }
    }

    loadInitialState();

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!runState?.runId || !runState?.status) {
      return;
    }

    const notificationKey = `${runState.runId}:${runState.status}`;
    if (notifiedRunStateRef.current === notificationKey) {
      return;
    }

    if (runState.status === 'completed') {
      onToast(runState.message || `${runState.pipelineName} finished successfully.`, 'success');
      notifiedRunStateRef.current = `${runState.runId}:${runState.status}`;
    } else if (runState.status === 'failed' || runState.status === 'cancelled') {
      onToast(runState.message || 'Pipeline run stopped.', 'error');
      notifiedRunStateRef.current = `${runState.runId}:${runState.status}`;
    }
  }, [onToast, runState]);

  useEffect(() => {
    if (!runState?.runId || !['completed', 'failed', 'cancelled'].includes(runState.status)) {
      return;
    }

    const refreshKey = `${runState.runId}:${runState.status}`;
    if (outputRefreshKeyRef.current === refreshKey) {
      return;
    }

    outputRefreshKeyRef.current = refreshKey;
    loadPipelineOutputs({ silent: true });
  }, [runState?.runId, runState?.status]);

  useEffect(() => {
    if (wizardExecutionMode !== 'cloud') {
      return;
    }

    if (!connectedProviders.length) {
      if (wizardProviderId) {
        setWizardProviderId('');
      }
      return;
    }

    if (!wizardProviderId || !connectedProviders.some((provider) => provider.id === wizardProviderId)) {
      setWizardProviderId(connectedProviders[0].id);
      setWizardModel('');
      setWizardModelOptions([]);
    }
  }, [connectedProviders, wizardExecutionMode, wizardProviderId]);

  useEffect(() => {
    setValidationComment('');
    setValidationRetryOverrides(getPendingValidationRetryDefaults(runState?.pendingValidation));
  }, [runState?.pendingValidation?.requestId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(PIPELINE_SECTION_VISIBILITY_STORAGE_KEY, JSON.stringify(sectionVisibility));
    } catch {
      return;
    }
  }, [sectionVisibility]);

  useEffect(() => {
    function handleMouseMove(event) {
      if (!dragRef.current || !canvasRef.current) {
        return;
      }

      if (dragRef.current.type === 'pan') {
        canvasRef.current.scrollLeft = Math.max(0, dragRef.current.scrollLeft - (event.clientX - dragRef.current.startClientX));
        canvasRef.current.scrollTop = Math.max(0, dragRef.current.scrollTop - (event.clientY - dragRef.current.startClientY));
        return;
      }

      if (dragRef.current.type !== 'node') {
        return;
      }

      const nextPoint = getCanvasGraphPoint(event);
      if (!nextPoint) {
        return;
      }

      const { nodeId, offsetX, offsetY } = dragRef.current;
      const nextX = Math.max(24, nextPoint.x - offsetX);
      const nextY = Math.max(24, nextPoint.y - offsetY);

      setDraft((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                position: {
                  x: nextX,
                  y: nextY,
                },
              }
            : node,
        ),
      }));
      markDirty();
    }

    function handleMouseUp() {
      if (dragRef.current?.type === 'pan') {
        setCanvasPanning(false);
      }
      dragRef.current = null;
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [canvasZoom]);

  function toggleSection(sectionKey) {
    setSectionVisibility((current) => {
      const next = Object.fromEntries(Object.keys(DEFAULT_PIPELINE_SECTION_VISIBILITY).map((key) => [key, false]));
      next[sectionKey] = !current[sectionKey];
      return next;
    });
  }

  function updatePipelineMetadata(field, value) {
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
    markDirty();
  }

  function updatePipelineRunSettings(nextSettings) {
    setDraft((current) => ({
      ...current,
      runSettings: normalizePipelineRunSettings({
        ...(current.runSettings || DEFAULT_PIPELINE_RUN_SETTINGS),
        ...(nextSettings || {}),
      }),
    }));
    markDirty();
  }

  function getCanvasGraphPoint(event) {
    if (!canvasRef.current) {
      return null;
    }

    const canvasBounds = canvasRef.current.getBoundingClientRect();
    return {
      x: (event.clientX - canvasBounds.left + canvasRef.current.scrollLeft) / canvasZoom,
      y: (event.clientY - canvasBounds.top + canvasRef.current.scrollTop) / canvasZoom,
    };
  }

  function handleCanvasMouseDown(event) {
    if (event.button !== 0 || !canvasRef.current) {
      return;
    }

    const interactiveTarget = event.target instanceof Element ? event.target.closest('[data-canvas-interactive="true"]') : null;
    if (interactiveTarget || isEditableTarget(event.target)) {
      return;
    }

    dragRef.current = {
      type: 'pan',
      scrollLeft: canvasRef.current.scrollLeft,
      scrollTop: canvasRef.current.scrollTop,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    setCanvasPanning(true);
    event.preventDefault();
  }

  function handleCanvasWheel(event) {
    if (!canvasRef.current) {
      return;
    }

    const direction = Math.sign(event.deltaY);
    if (!direction) {
      return;
    }

    event.preventDefault();
    const nextZoom = clampValue(
      Number((canvasZoom * (direction > 0 ? (1 - CANVAS_ZOOM_STEP) : (1 + CANVAS_ZOOM_STEP))).toFixed(3)),
      CANVAS_MIN_SCALE,
      CANVAS_MAX_SCALE,
    );
    if (nextZoom === canvasZoom) {
      return;
    }

    const canvasElement = canvasRef.current;
    const canvasBounds = canvasElement.getBoundingClientRect();
    const pointerX = event.clientX - canvasBounds.left;
    const pointerY = event.clientY - canvasBounds.top;
    const graphX = (canvasElement.scrollLeft + pointerX) / canvasZoom;
    const graphY = (canvasElement.scrollTop + pointerY) / canvasZoom;

    setCanvasZoom(nextZoom);
    window.requestAnimationFrame(() => {
      if (!canvasRef.current) {
        return;
      }

      canvasRef.current.scrollLeft = Math.max(0, graphX * nextZoom - pointerX);
      canvasRef.current.scrollTop = Math.max(0, graphY * nextZoom - pointerY);
    });
  }

  function resetCanvasView() {
    setCanvasZoom(1);
    canvasRef.current?.scrollTo({
      left: 0,
      top: 0,
    });
  }

  function createNewPipeline() {
    if (dirty) {
      const confirmed = window.confirm('Discard the unsaved pipeline changes and start a new pipeline?');
      if (!confirmed) {
        return;
      }
    }

    replaceDraft(createEmptyPipeline(), {
      dirty: false,
      selectedNodeId: '',
    });
    setRunState((current) => (current?.status === 'running' || current?.status === 'paused' ? current : null));
  }

  async function handleCopyPipeline() {
    if (!draft) {
      onToast('Open or create a pipeline before copying it.', 'error');
      return;
    }

    const copiedPipeline = createPipelineDefinitionCopy(draft, pipelines);
    setCopyBusy(true);
    logRendererActionDiagnostic('pipeline-copy', 'start', { sourcePipelineId: String(draft.id || ''), targetPipelineId: String(copiedPipeline.id || '') });
    try {
      const result = await window.localAIHub.savePipeline(copiedPipeline);
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not copy that pipeline.', 'error');
        return;
      }

      setPipelines(result.data?.pipelines || []);
      replaceDraft(result.data?.pipeline || copiedPipeline, {
        dirty: false,
        selectedNodeId: selectedNodeId && copiedPipeline.nodes.some((node) => node.id === selectedNodeId) ? selectedNodeId : copiedPipeline.nodes[0]?.id || '',
      });
      setRunState((current) => (current?.status === 'running' || current?.status === 'paused' ? current : null));
      onToast(result.data?.message || `${copiedPipeline.name} was copied.`, 'success');
    } catch (error) {
      logRendererActionDiagnostic('pipeline-copy', 'failure', { message: String(error?.message || ''), sourcePipelineId: String(draft.id || '') }, 'warn');
      onToast(error?.message || 'Local AI Hub could not copy that pipeline.', 'error');
    } finally {
      setCopyBusy(false);
      expectNextPrintableKeyDiagnostic('pipeline-copy', { sourcePipelineId: String(draft.id || '') });
    }
  }

  function createPipelineFromTemplate(templateId) {
    const result = instantiatePipelineTemplate(templateId, {
      graphWorkflowPresets,
      hardware,
      manifests,
      promptStyles,
      providers,
      tools: pipelineTools,
    });
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not create that starter pipeline.', 'error');
      return;
    }

    if (result.readiness?.status === TEMPLATE_STATUS.UNAVAILABLE) {
      const details = getTemplateDetailLines(result.readiness)[0] || 'This starter template needs another saved preset or configuration first.';
      onToast(details, 'error');
      return;
    }

    if (dirty) {
      const confirmed = window.confirm('Discard the unsaved pipeline changes and create this starter pipeline?');
      if (!confirmed) {
        return;
      }
    }

    replaceDraft(result.pipeline || createEmptyPipeline(), {
      dirty: true,
      selectedNodeId: result.pipeline?.nodes?.[0]?.id || '',
    });
    setRunState((current) => (current?.status === 'running' || current?.status === 'paused' ? current : null));
    setSectionVisibility((current) => ({
      ...current,
      canvas: true,
      pipelineInfo: true,
      starterTemplates: false,
    }));
    const details = getTemplateDetailLines(result.readiness);
    onToast(details.length ? `${result.template?.name || 'Starter pipeline'} created. ${details[0]}` : `${result.template?.name || 'Starter pipeline'} created.`, result.readiness?.status === TEMPLATE_STATUS.MISSING_REQUIREMENTS ? 'error' : 'success');
  }
  function addNode(type) {
    const nextNode = createPositionedNode(type, draft.nodes);
    logPipelineBuilderRendererEvent('Pipeline node added from palette.', { nodeId: nextNode.id, nodeType: type }, 'info');
    setDraft((current) => ({
      ...current,
      nodes: [...current.nodes, nextNode],
    }));
    setSelectedNodeId(nextNode.id);
    markDirty();
  }

  function removeNode(nodeId) {
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      edges: current.edges.filter((edge) => edge.source.nodeId !== nodeId && edge.target.nodeId !== nodeId),
    }));
    setSelectedNodeId((current) => (current === nodeId ? '' : current));
    setSelectedEdgeId('');
    markDirty();
  }

  function removeEdge(edgeId) {
    setDraft((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edge.id !== edgeId),
    }));
    setSelectedEdgeId((current) => (current === edgeId ? '' : current));
    markDirty();
  }

  function startDrag(nodeId, event) {
    const node = draft.nodes.find((entry) => entry.id === nodeId);
    const pointer = getCanvasGraphPoint(event);
    if (!node || !pointer || isEditableTarget(event.target)) {
      return;
    }

    dragRef.current = {
      type: 'node',
      nodeId,
      offsetX: pointer.x - node.position.x,
      offsetY: pointer.y - node.position.y,
    };
    setSelectedEdgeId('');
    setSelectedNodeId(nodeId);
    event.preventDefault();
    event.stopPropagation();
  }
  function connectPorts(sourceNodeId, sourcePortId, targetNodeId, targetPortId) {
    const sourceNode = draft.nodes.find((node) => node.id === sourceNodeId);
    const targetNode = draft.nodes.find((node) => node.id === targetNodeId);
    const sourcePort = getPortDefinition(sourceNode, 'output', sourcePortId);
    const targetPort = getPortDefinition(targetNode, 'input', targetPortId);

    if (!sourceNode || !targetNode || !sourcePort || !targetPort) {
      onToast('Local AI Hub could not create that connection.', 'error');
      return;
    }

    if (sourceNodeId === targetNodeId) {
      onToast('A node cannot connect to itself.', 'error');
      return;
    }

    const existingExactEdge = draft.edges.find(
      (edge) =>
        edge.source.nodeId === sourceNodeId
        && edge.source.portId === sourcePortId
        && edge.target.nodeId === targetNodeId
        && edge.target.portId === targetPortId,
    );
    if (existingExactEdge) {
      onToast('Those ports are already connected.', 'error');
      return;
    }

    const existingTargetEdges = draft.edges.filter((edge) => edge.target.nodeId === targetNodeId && edge.target.portId === targetPortId);
    if (existingTargetEdges.length && !targetPort.allowMultipleConnections) {
      onToast(`${targetNode.label} already has a connection for ${targetPort.label}. Remove it first, or use a Branch Merge node to recombine multiple branches.`, 'error');
      return;
    }

    const nextDraft = {
      ...draft,
      edges: [...draft.edges, createEdge(sourceNodeId, sourcePortId, targetNodeId, targetPortId)],
    };
    const nextGraph = buildPipelineGraph(nextDraft);
    const newErrors = nextGraph.errors.filter((message) => !graph.errors.includes(message));
    if (newErrors.length) {
      const nextMessage = newErrors[0];
      onToast(
        nextMessage.toLowerCase().includes('cycle')
          ? 'That connection would create a raw cycle. Use a Retry Loop node when you want a bounded retry path.'
          : nextMessage,
        'error',
      );
      return;
    }

    replaceDraft(nextDraft, {
      dirty: true,
    });
    setSelectedEdgeId('');
    setSelectedNodeId(targetNodeId);
  }

  function isPendingConnectionCompatible(targetNode, targetPort) {
    if (!pendingConnection || !targetNode || !targetPort) {
      return false;
    }

    const sourceNode = draft.nodes.find((node) => node.id === pendingConnection.sourceNodeId);
    const sourcePort = getPortDefinition(sourceNode, 'output', pendingConnection.sourcePortId);
    if (!sourceNode || !sourcePort) {
      return false;
    }

    return arePortsCompatible(sourcePort, targetPort, {
      graph,
      sourceNode,
      targetNode,
    });
  }

  async function handleSavePipeline() {
    setSaveBusy(true);
    logRendererActionDiagnostic('pipeline-save', 'start', { edgeCount: draft.edges.length, nodeCount: draft.nodes.length, pipelineId: String(draft.id || '') });
    try {
      const result = await window.localAIHub.savePipeline(draft);
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not save that pipeline.', 'error');
        return;
      }

      setPipelines(result.data?.pipelines || []);
      logRendererActionDiagnostic('pipeline-save', 'success', { pipelineId: String(result.data?.pipeline?.id || draft.id || '') });
      replaceDraft(result.data?.pipeline || draft, {
        dirty: false,
      });
      onToast(result.data?.message || 'Pipeline saved.', 'success');
    } catch (error) {
      logRendererActionDiagnostic('pipeline-save', 'failure', { message: String(error?.message || ''), pipelineId: String(draft.id || '') }, 'warn');
      onToast(error?.message || 'Local AI Hub could not save that pipeline.', 'error');
    } finally {
      setSaveBusy(false);
      expectNextPrintableKeyDiagnostic('pipeline-save', { pipelineId: String(draft.id || '') });
    }
  }

  async function handleDeletePipeline() {
    if (!currentPipelineSaved) {
      createNewPipeline();
      return;
    }

    const confirmed = window.confirm(`Delete ${draft.name} from the saved pipeline list?`);
    if (!confirmed) {
      return;
    }

    setDeleteBusy(true);
    try {
      const result = await window.localAIHub.deletePipeline(draft.id);
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not delete that pipeline.', 'error');
        return;
      }

      const nextPipelines = result.data?.pipelines || [];
      setPipelines(nextPipelines);
      onToast(result.data?.message || 'Pipeline deleted.', 'success');

      if (nextPipelines.length > 0) {
        await loadSavedPipeline(nextPipelines[0].id, {
          force: true,
        });
        return;
      }

      createNewPipeline();
    } catch (error) {
      onToast(error?.message || 'Local AI Hub could not delete that pipeline.', 'error');
    } finally {
      setDeleteBusy(false);
    }
  }

  async function refreshNodeModels(node) {
    const modelConfig = getModelTargetConfig(node);
    if (!modelConfig) {
      const isCollectionMapLocalToolNode = node.type === 'collectionMap' && node.config?.executionMode === 'localTool';
      if (!isCollectionMapLocalToolNode) return;

      const operationId = getCollectionMapMapping(node)?.operationId || PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
      let models = [];
      if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) {
        const toolId = String(node.config?.toolId || transcriptionTools[0]?.id || 'whisper').trim();
        models = WHISPER_MODELS.map((model) => ({ ...model, detail: 'Local Whisper transcription model', toolId }));
        setModelOptionsByNodeId((current) => ({ ...current, [node.id]: models }));
        if (!String(node.config?.toolId || '').trim()) updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId } }));
        onToast('Whisper model sizes are ready for this collection map.', 'success');
        return;
      }
      if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
        const toolId = String(node.config?.toolId || imageTools[0]?.id || '').trim();
        if (!toolId) {
          onToast('Install Automatic1111 or Forge before configuring local image analysis for this collection map.', 'error');
          return;
        }
        models = [
          { id: 'clip', label: 'CLIP caption', detail: 'Stable Diffusion WebUI interrogate mode', toolId },
          { id: 'deepdanbooru', label: 'DeepDanbooru tags', detail: 'Stable Diffusion WebUI interrogate mode', toolId },
        ];
        setModelOptionsByNodeId((current) => ({ ...current, [node.id]: models }));
        if (!String(node.config?.toolId || '').trim()) updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId } }));
        onToast('Image analysis modes are ready for this collection map.', 'success');
        return;
      }

      const assetConfig = operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
        ? { assetKind: 'audiocraft-snapshot', defaultToolId: audioTools[0]?.id || '', emptyMessage: 'No downloaded AudioCraft snapshots were found.', errorMessage: 'Local AI Hub could not load downloaded AudioCraft snapshots for that collection map.', installMessage: 'Install AudioCraft WebUI before configuring local audio generation for this collection map.', successMessage: 'AudioCraft snapshots refreshed.' }
        : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
          ? { assetKind: 'rvc-voice-model', defaultToolId: audioTransformTools[0]?.id || 'rvc', emptyMessage: 'No RVC voice models were found.', errorMessage: 'Local AI Hub could not load local RVC voice models for that collection map.', installMessage: 'Install RVC before refreshing voice models for this collection map.', successMessage: 'RVC voice models refreshed.' }
          : operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
            ? { assetKind: 'upscayl-model-set', defaultToolId: imageTransformTools.find((tool) => tool.id === 'upscayl')?.id || imageTransformTools[0]?.id || 'upscayl', emptyMessage: 'No downloaded Upscayl model sets were found.', errorMessage: 'Local AI Hub could not load downloaded Upscayl model sets for that collection map.', installMessage: 'Install Upscayl before configuring image-to-image collection mapping.', successMessage: 'Upscayl model sets refreshed.' }
            : operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
              ? { assetKind: 'wan-model-folder', defaultToolId: videoTools[0]?.id || 'wan21-webui', emptyMessage: 'No downloaded Wan model folders were found.', errorMessage: 'Local AI Hub could not load downloaded Wan model folders for that collection map.', installMessage: 'Install Wan2.1 WebUI before configuring text-to-video collection mapping.', successMessage: 'Wan model folders refreshed.' }
              : { assetKind: 'stable-diffusion-checkpoint', defaultToolId: imageTools[0]?.id || '', emptyMessage: 'No backend-visible checkpoints were found.', errorMessage: 'Local AI Hub could not refresh live checkpoints for that image tool.', installMessage: 'Install Automatic1111 or Forge before refreshing local image checkpoints for this collection map.', successMessage: 'Checkpoints refreshed from the live backend.' };
      const toolId = String(node.config?.toolId || assetConfig.defaultToolId || '').trim();
      if (!toolId) {
        onToast(assetConfig.installMessage, 'error');
        return;
      }
      if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM && toolId !== 'upscayl') {
        const selectedTransformTool = imageTransformTools.find((tool) => tool.id === toolId) || null;
        onToast((selectedTransformTool?.name || 'This image transform tool') + ' does not expose selectable downloaded model sets yet.', 'info');
        return;
      }

      setModelsBusyNodeId(node.id);
      const result = await window.localAIHub.listToolAssets({ assetKind: assetConfig.assetKind, toolId });
      if (!result?.ok) {
        setModelsBusyNodeId('');
        onToast(result?.message || assetConfig.errorMessage, 'error');
        return;
      }
      const assetModels = Array.isArray(result.data?.models) ? result.data.models : Array.isArray(result.data) ? result.data : [];
      if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
        models = assetModels.map((model) => ({ ...model, id: String(model.path || model.packageRootPath || model.relativePath || model.name || model.id || '').trim(), label: model.sourceCatalogRepositoryId || model.name || model.fileName || model.relativePath || model.id, detail: [model.modelType, model.relativePath || model.path].filter(Boolean).join(' | '), toolId })).filter((model) => model.id);
      } else if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
        models = assetModels.map((model) => ({ ...model, id: String(model.relativePath || model.fileName || model.name || model.id || '').trim(), label: model.name || model.fileName || model.relativePath || model.id, detail: [model.modelType, model.relativePath].filter(Boolean).join(' | '), toolId })).filter((model) => model.id && model.backendVisible !== false);
      } else if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM || operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
        models = assetModels.map((model) => ({ ...model, id: String(model.name || model.fileName || model.relativePath || model.id || '').trim(), label: model.name || model.fileName || model.relativePath || model.id, detail: [model.modelType, model.relativePath].filter(Boolean).join(' | '), toolId })).filter((model) => model.id);
      } else {
        models = assetModels.filter((model) => {
          const modelType = String(model?.modelType || '').trim().toLowerCase();
          return (modelType === 'checkpoint' || modelType === 'inpainting') && model.backendVisible !== false;
        }).map((model) => buildStableDiffusionCheckpointOption(model, toolId)).filter((model) => model.id);
      }
      setModelOptionsByNodeId((current) => ({ ...current, [node.id]: models }));
      if (!String(node.config?.toolId || '').trim()) updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId } }));
      setModelsBusyNodeId('');
      onToast(result.data?.message || (models.length ? assetConfig.successMessage : assetConfig.emptyMessage), models.length ? 'success' : 'info');
      return;
    }

    setModelsBusyNodeId(node.id);
    const rawExecutionMode = String(node.config?.[modelConfig.executionModeKey] || '').trim();
    const executionMode = rawExecutionMode === 'ollama'
      ? 'ollama'
      : node.type === 'llmPrompt' && rawExecutionMode === 'localTool'
        ? 'localTool'
        : 'cloud';
    let models = [];
    if (executionMode === 'ollama') {
      const result = await window.localAIHub.listOllamaModels({ includeCapabilities: true, preferLocalLibrary: true });
      if (!result?.ok) {
        setModelsBusyNodeId('');
        onToast(result?.message || 'Local AI Hub could not load your local Ollama models.', 'error');
        return;
      }
      models = (result.data?.models || []).map((model) => ({
        id: model.name,
        label: model.name,
        detail: buildOllamaModelDetail(model),
        capabilityLabels: Array.isArray(model.capabilityLabels) ? model.capabilityLabels : [],
        capabilitySource: model.capabilitySource || '',
        supportsImageInput: typeof model.supportsImageInput === 'boolean' ? model.supportsImageInput : undefined,
      }));
    } else if (executionMode === 'localTool') {
      const operationId = getSelectedModelStepOperationId(node);
      if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) {
        const toolId = String(node.config?.toolId || transcriptionTools[0]?.id || 'whisper').trim();
        if (!toolId) { setModelsBusyNodeId(''); onToast('Install Whisper before configuring local audio transcription for this step.', 'error'); return; }
        models = WHISPER_MODELS.map((model) => ({ id: model.id, label: model.label, detail: 'Local Whisper transcription model', toolId }));
        if (!String(node.config?.toolId || '').trim()) updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId } }));
      } else if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
        const toolId = String(node.config?.toolId || imageTools[0]?.id || '').trim();
        if (!toolId) { setModelsBusyNodeId(''); onToast('Install Automatic1111 or Forge before configuring local image analysis for this step.', 'error'); return; }
        models = [
          { id: 'clip', label: 'CLIP caption', detail: 'Stable Diffusion WebUI interrogate mode', toolId },
          { id: 'deepdanbooru', label: 'DeepDanbooru tags', detail: 'Stable Diffusion WebUI interrogate mode', toolId },
        ];
        if (!String(node.config?.toolId || '').trim()) updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId } }));
      } else if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
        const toolId = String(node.config?.toolId || audioTools[0]?.id || '').trim();
        if (!toolId) { setModelsBusyNodeId(''); onToast('Install AudioCraft WebUI before configuring local audio generation for this step.', 'error'); return; }
        const result = await window.localAIHub.listToolAssets({ assetKind: 'audiocraft-snapshot', toolId });
        if (!result?.ok) { setModelsBusyNodeId(''); onToast(result?.message || 'Local AI Hub could not load downloaded AudioCraft snapshots for that step.', 'error'); return; }
        const assetModels = Array.isArray(result.data?.models) ? result.data.models : Array.isArray(result.data) ? result.data : [];
        if (result.data?.message) onToast(result.data.message, assetModels.length ? 'success' : 'info');
        models = assetModels.map((model) => ({ ...model, id: String(model.path || model.packageRootPath || model.relativePath || model.name || model.id || '').trim(), label: model.sourceCatalogRepositoryId || model.name || model.fileName || model.relativePath || model.id, detail: [model.modelType, model.relativePath || model.path].filter(Boolean).join(' | '), toolId })).filter((model) => model.id);
        if (!String(node.config?.toolId || '').trim()) updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId } }));
      } else if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
        const toolId = String(node.config?.toolId || audioTransformTools[0]?.id || '').trim();
        if (!toolId) { setModelsBusyNodeId(''); onToast('Install RVC before refreshing voice models for this audio transformation step.', 'error'); return; }
        const result = await window.localAIHub.listToolAssets({ assetKind: 'rvc-voice-model', toolId });
        if (!result?.ok) { setModelsBusyNodeId(''); onToast(result?.message || 'Local AI Hub could not load local RVC voice models for that step.', 'error'); return; }
        const assetModels = Array.isArray(result.data?.models) ? result.data.models : Array.isArray(result.data) ? result.data : [];
        if (result.data?.message) onToast(result.data.message, assetModels.length ? 'success' : 'info');
        models = assetModels.map((model) => ({ ...model, id: String(model.relativePath || model.fileName || model.name || model.id || '').trim(), label: model.name || model.fileName || model.relativePath || model.id, detail: [model.modelType, model.relativePath].filter(Boolean).join(' | '), toolId })).filter((model) => model.id && model.backendVisible !== false);
        if (!String(node.config?.toolId || '').trim()) updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId } }));
      } else if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
        const toolId = String(node.config?.toolId || imageTransformTools[0]?.id || '').trim();
        if (!toolId) { setModelsBusyNodeId(''); onToast('Install Upscayl or FaceFusion before configuring local image transformation for this step.', 'error'); return; }
        const selectedTransformTool = imageTransformTools.find((tool) => tool.id === toolId) || null;
        if (toolId === 'upscayl') {
          const result = await window.localAIHub.listToolAssets({ assetKind: 'upscayl-model-set', toolId });
          if (!result?.ok) { setModelsBusyNodeId(''); onToast(result?.message || 'Local AI Hub could not load downloaded Upscayl model sets for that step.', 'error'); return; }
          const assetModels = Array.isArray(result.data?.models) ? result.data.models : Array.isArray(result.data) ? result.data : [];
          if (result.data?.message) onToast(result.data.message, assetModels.length ? 'success' : 'info');
          models = assetModels.map((model) => ({ ...model, id: String(model.name || model.fileName || model.relativePath || model.id || '').trim(), label: model.name || model.fileName || model.relativePath || model.id, detail: [model.modelType, model.relativePath].filter(Boolean).join(' | '), toolId })).filter((model) => model.id);
        } else {
          onToast((selectedTransformTool?.name || 'This image transform tool') + ' does not expose selectable downloaded model sets yet.', 'info');
        }
        if (!String(node.config?.toolId || '').trim()) updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId } }));
      } else if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
        const toolId = String(node.config?.toolId || videoTools[0]?.id || '').trim();
        if (!toolId) { setModelsBusyNodeId(''); onToast('Install Wan2.1 WebUI before configuring local video generation for this step.', 'error'); return; }
        const result = await window.localAIHub.listToolAssets({ assetKind: 'wan-model-folder', toolId });
        if (!result?.ok) { setModelsBusyNodeId(''); onToast(result?.message || 'Local AI Hub could not load downloaded Wan model folders for that step.', 'error'); return; }
        const assetModels = Array.isArray(result.data?.models) ? result.data.models : Array.isArray(result.data) ? result.data : [];
        if (result.data?.message) onToast(result.data.message, assetModels.length ? 'success' : 'info');
        models = assetModels.map((model) => ({ ...model, id: String(model.name || model.fileName || model.relativePath || model.id || '').trim(), label: model.name || model.fileName || model.relativePath || model.id, detail: [model.modelType, model.relativePath].filter(Boolean).join(' | '), toolId })).filter((model) => model.id);
        if (!String(node.config?.toolId || '').trim()) updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId } }));
      } else {
        const toolId = String(node.config?.toolId || imageTools[0]?.id || '').trim();
        if (!toolId) { setModelsBusyNodeId(''); onToast('Install Automatic1111 or Forge before refreshing local image checkpoints for this step.', 'error'); return; }
        const result = await window.localAIHub.listToolAssets({ assetKind: 'stable-diffusion-checkpoint', toolId });
        if (!result?.ok) { setModelsBusyNodeId(''); onToast(result?.message || 'Local AI Hub could not refresh live checkpoints for that image tool.', 'error'); return; }
        const assetModels = Array.isArray(result.data?.models) ? result.data.models : Array.isArray(result.data) ? result.data : [];
        if (result.data?.message) onToast(result.data.message, assetModels.some((model) => model.backendVisible !== false) ? 'success' : 'info');
        models = assetModels.filter((model) => {
          const modelType = String(model?.modelType || '').trim().toLowerCase();
          return modelType === 'checkpoint' || modelType === 'inpainting';
        }).map((model) => buildStableDiffusionCheckpointOption(model, toolId)).filter((model) => model.id && model.backendVisible !== false);
        if (!String(node.config?.toolId || '').trim()) updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId } }));
      }
    } else {
      const providerId = String(node.config?.[modelConfig.providerIdKey] || '').trim();
      if (!providerId) { setModelsBusyNodeId(''); onToast('Choose a connected cloud provider before refreshing models for this step.', 'error'); return; }
      const modelRequest = node.type === 'llmPrompt'
        ? { operationId: getSelectedModelStepOperationId(node), providerId }
        : node.type === 'planner'
          ? { operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT, providerId }
          : providerId;
      const result = await window.localAIHub.listProviderModels(modelRequest);
      if (!result?.ok) { setModelsBusyNodeId(''); onToast(result?.message || 'Local AI Hub could not load models for that cloud provider.', 'error'); return; }
      models = result.data?.models || [];
      if (node.type === 'llmPrompt' && getSelectedModelStepOperationId(node) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE && providerId === 'xai' && !models.length) {
        onToast('xAI text-to-speech currently runs through a provider-managed speech runtime in this step. Leave Model blank and choose a voice if you want to use xAI.', 'info');
      }
      if (!String(node.config?.model || '').trim() && result.data?.selectedModel) {
        updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, model: result.data.selectedModel } }));
      }
    }

    setModelOptionsByNodeId((current) => ({ ...current, [node.id]: models }));
    const shouldAutoSelectModel = !(executionMode === 'localTool' && node.type === 'llmPrompt' && getSelectedModelStepOperationId(node) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE);
    if (shouldAutoSelectModel && !String(node.config?.model || '').trim() && models[0]?.id) {
      updateNode(node.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, model: models[0].id } }));
    }
    setModelsBusyNodeId('');
  }
  async function refreshWizardModels() {
    setWizardModelsBusy(true);
    setWizardSummary(null);
    try {
      let result = null;
      if (wizardExecutionMode === 'ollama') {
        result = await window.localAIHub.listOllamaModels({ includeCapabilities: true, autoStart: true, launchContext: 'pipeline-wizard-model-refresh' });
        if (!result?.ok) {
          onToast(result?.message || 'Local AI Hub could not load Ollama models for the wizard.', 'error');
          return;
        }

        const models = rankLocalWizardModelOptions((result.data?.models || []).map((model) => buildWizardModelOption({
          id: model.name,
          label: model.name,
          detail: buildOllamaModelDetail(model),
          size: model.size,
          capabilityLabels: Array.isArray(model.capabilityLabels) ? model.capabilityLabels : [],
          capabilitySource: model.capabilitySource || '',
          supportsImageInput: typeof model.supportsImageInput === 'boolean' ? model.supportsImageInput : undefined,
        })).filter((model) => model.id), hardware);
        setWizardModelOptions(models);
        if ((!wizardModel || !models.some((model) => model.id === wizardModel)) && models[0]?.id) {
          setWizardModel(models[0].id);
        }
        if (result.data?.stoppedAfterUse) {
          onToast('Local AI Hub started Ollama to inspect local models, then stopped it again.', 'info');
        }
        return;
      }

      if (!wizardProviderId) {
        onToast('Choose a connected cloud provider for the pipeline wizard first.', 'error');
        return;
      }

      result = await window.localAIHub.listProviderModels({ providerId: wizardProviderId, operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT });
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not load wizard models for that provider.', 'error');
        return;
      }

      const models = (result.data?.models || []).map((model) => buildWizardModelOption(model)).filter((model) => model.id);
      setWizardModelOptions(models);
      if (!wizardModel && (result.data?.selectedModel || models[0]?.id)) {
        setWizardModel(getWizardModelId(result.data?.selectedModel) || models[0].id);
      }
    } catch (error) {
      onToast(error?.message || 'Local AI Hub could not load wizard models.', 'error');
    } finally {
      setWizardModelsBusy(false);
    }
  }

  async function handleGenerateWizardDraft() {
    const normalizedIntent = String(wizardIntent || '').trim();
    if (!normalizedIntent) {
      onToast('Describe the workflow you want the wizard to draft first.', 'error');
      return;
    }

    if (wizardExecutionMode === 'cloud' && !wizardProviderId) {
      onToast('Choose a connected cloud provider for the wizard first.', 'error');
      return;
    }

    const wizardModelId = getWizardModelId(wizardModel);
    if (!wizardModelId) {
      onToast('Choose a model for the wizard first.', 'error');
      return;
    }

    if (dirty) {
      const confirmed = window.confirm('Replace the current unsaved draft with a wizard-generated pipeline?');
      if (!confirmed) {
        return;
      }
    }

    const requestId = wizardRequestIdRef.current + 1;
    wizardRequestIdRef.current = requestId;
    const isCurrentWizardRequest = () => wizardRequestIdRef.current === requestId;
    setWizardBusy(true);
    setWizardSummary(null);

    const targetLabel = getWizardTargetLabel({ ...wizardTarget, model: wizardModelId }, connectedProviders);
    const requestTimeoutMs = wizardExecutionMode === 'ollama'
      ? WIZARD_LOCAL_DRAFT_TIMEOUT_MS
      : WIZARD_CLOUD_DRAFT_TIMEOUT_MS;
    const timeoutMessage = wizardExecutionMode === 'ollama'
      ? 'Ollama took too long to draft the pipeline. Local AI Hub kept the request bounded; for complex workflows on this hardware, try a simpler request, a stronger downloaded model, or a cloud wizard model.'
      : 'The wizard model did not return a draft within the allowed time. Try a simpler request, a stronger model, or split the workflow into stages.';

    try {
      const requestProfile = getPipelineWizardRequestProfile({
        context: wizardContext,
        intent: normalizedIntent,
        wizardTarget: { ...wizardTarget, model: wizardModelId },
      });
      if (requestProfile.note) {
        onToast(requestProfile.note, 'info');
      }
      const messages = buildPipelineWizardMessages({
        context: wizardContext,
        intent: normalizedIntent,
        wizardTarget: { ...wizardTarget, model: wizardModelId, requestProfile },
      });
      const lifecycleResult = await runPipelineWizardLifecycle({
        context: wizardContext,
        intent: normalizedIntent,
        targetLabel,
        wizardTarget: { ...wizardTarget, model: wizardModelId },
        timeoutMessage,
        timeoutMs: requestTimeoutMs + WIZARD_CLIENT_TIMEOUT_GRACE_MS,
        getReplyText: getAssistantReplyText,
        parsePlan: parsePipelineWizardPlan,
        buildDraft: buildPipelineWizardDraft,
        requestModelDraft: () => wizardExecutionMode === 'ollama'
          ? window.localAIHub.chatWithOllama({
              messages,
              model: wizardModelId,
              timeoutMessage,
              timeoutMs: requestTimeoutMs,
              format: 'json',
              options: { temperature: 0.1, num_predict: 700, num_ctx: 2048 },
              autoStart: true,
              launchContext: 'pipeline-wizard-draft',
            })
          : window.localAIHub.chatWithProvider({
              messages,
              model: wizardModelId,
              providerId: wizardProviderId,
              timeoutMessage,
              timeoutMs: requestTimeoutMs,
              maxOutputTokens: requestProfile.maxOutputTokens || 4096,
              responseFormat: buildPipelineWizardStructuredOutputRequest({ compactMode: requestProfile.compactMode }),
            }),
      });

      if (!isCurrentWizardRequest()) {
        return;
      }

      if (!lifecycleResult?.ok || !lifecycleResult.draftResult?.pipeline) {
        const summary = lifecycleResult?.summary || buildWizardFailureSummary({
          category: lifecycleResult?.diagnosticCategory || 'ui-ipc-failure',
          message: 'Local AI Hub could not finish this wizard request.',
          targetLabel,
        });
        setWizardSummary(summary);
        onToast(summary.message || 'Local AI Hub could not finish this wizard request.', 'error');
        return;
      }

      const draftResult = lifecycleResult.draftResult;
      replaceDraft(draftResult.pipeline, {
        dirty: true,
        selectedNodeId: draftResult.pipeline.nodes[0]?.id || '',
      });
      setRunState((current) => (current?.status === 'running' || current?.status === 'paused' ? current : null));
      setWizardSummary(draftResult.summary);

      const needsAttention = draftResult.summary?.graphErrorCount > 0 || draftResult.analysis?.primaryIssue?.tone === 'error';
      const recovered = Boolean(lifecycleResult.recovered || draftResult.summary?.diagnosticCategory);
      onToast(
        recovered
          ? 'The wizard model path failed, but Local AI Hub recovered an editable draft from built-in rules.'
          : needsAttention
            ? 'The wizard created an editable draft, but it still needs attention before running.'
            : 'The wizard created an editable draft pipeline.',
        needsAttention || recovered ? 'info' : 'success',
      );
    } catch (error) {
      if (!isCurrentWizardRequest()) {
        return;
      }
      const message = error?.message || 'Local AI Hub could not finish this wizard request.';
      const summary = buildWizardFailureSummary({
        category: 'ui-ipc-failure',
        message,
        targetLabel,
      });
      setWizardSummary(summary);
      onToast(message, 'error');
    } finally {
      if (isCurrentWizardRequest()) {
        setWizardBusy(false);
      }
    }
  }
  async function chooseNodeFile(nodeId, kind) {
    const result = await window.localAIHub.pickPipelineFile({ kind });
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not open that file picker.', 'error');
      return;
    }

    if (result.data?.canceled || !result.data?.filePath) {
      return;
    }

    updateNode(nodeId, (currentNode) => ({
      ...currentNode,
      config: {
        ...currentNode.config,
        filePath: result.data.filePath,
      },
    }));
  }

  async function chooseCollectionMapInitialReferenceImage(nodeId) {
    const result = await window.localAIHub.pickPipelineFile({ kind: 'image' });
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not open that image picker.', 'error');
      return;
    }

    if (result.data?.canceled || !result.data?.filePath) {
      return;
    }

    updateNode(nodeId, (currentNode) => ({
      ...currentNode,
      config: {
        ...currentNode.config,
        videoInitialReferenceImagePath: result.data.filePath,
      },
    }));
  }
  function updateCollectionInputType(nodeId, nextItemType) {
    const normalizedItemType = normalizeCollectionInputItemType(nextItemType);
    updateNode(nodeId, (currentNode) => {
      const currentItemType = normalizeCollectionInputItemType(currentNode.config?.itemType);
      return {
        ...currentNode,
        config: {
          ...currentNode.config,
          itemType: normalizedItemType,
          items: currentItemType === normalizedItemType ? getCollectionInputItems(currentNode) : [],
        },
      };
    });
    onToast('Collection Input item type set to ' + (PIPELINE_PORT_KIND_LABELS[normalizedItemType] || normalizedItemType) + '.', 'info');
  }

  function addCollectionInputTextItem(nodeId) {
    updateNode(nodeId, (currentNode) => addCollectionInputTextItemToNode(currentNode));
  }

  async function addCollectionInputFileItem(nodeId, itemType) {
    const normalizedItemType = normalizeCollectionInputItemType(itemType);
    const result = await window.localAIHub.pickPipelineFile({ kind: normalizedItemType });
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not open that file picker.', 'error');
      return;
    }

    if (result.data?.canceled || !result.data?.filePath) {
      return;
    }

    updateNode(nodeId, (currentNode) => addCollectionInputFileItemToNode(currentNode, result.data.filePath, normalizedItemType, {
      displayName: fileNameFromPath(result.data.filePath),
    }));
  }

  function updateCollectionInputItem(nodeId, itemId, patch) {
    updateNode(nodeId, (currentNode) => updateCollectionInputItemInNode(currentNode, itemId, patch));
  }

  function removeCollectionInputItem(nodeId, itemId) {
    updateNode(nodeId, (currentNode) => removeCollectionInputItemFromNode(currentNode, itemId));
  }

  function moveCollectionInputItem(nodeId, itemId, direction) {
    updateNode(nodeId, (currentNode) => moveCollectionInputItemInNode(currentNode, itemId, direction));
  }
  async function handleRunPipeline() {
    if (!analysis.executable) {
      onToast(analysis.primaryIssue?.message || 'This pipeline is not ready to run yet.', 'error');
      return;
    }

    if (runState?.status === 'running' || runState?.status === 'paused') {
      onToast('A pipeline run is already active. Finish, resume, or cancel it before starting another one.', 'error');
      return;
    }

    if (analysis.compatibilitySummary && ['warn', 'danger'].includes(analysis.compatibilitySummary.tone)) {
      const confirmed = window.confirm(
        `${analysis.compatibilitySummary.message}\n\nThis pipeline still runs sequentially so only one heavy local step executes at a time. Continue anyway?`,
      );
      if (!confirmed) {
        return;
      }
    }

    setRunBusy(true);
    try {
      const result = await window.localAIHub.runPipeline(draft);
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not run that pipeline.', 'error');
        return;
      }

      applyRunSnapshot(result.data?.run || null);
      onToast(result.data?.message || 'Pipeline started. Local AI Hub will launch any required local tools as the run reaches them.', 'success');
    } catch (error) {
      onToast(error?.message || 'Local AI Hub could not run that pipeline.', 'error');
    } finally {
      setRunBusy(false);
    }
  }

  async function handleCancelRun() {
    if (!runState?.runId) {
      return;
    }

    setCancelBusy(true);
    const result = await window.localAIHub.cancelPipelineRun(runState.runId);
    if (!result?.ok) {
      setCancelBusy(false);
      onToast(result?.message || 'Local AI Hub could not cancel that pipeline run.', 'error');
      return;
    }

    if (result.data?.run) {
      applyRunSnapshot(result.data.run);
    }
    onToast(result.data?.message || 'Local AI Hub is stopping the active pipeline and will shut down any tool it started for the run.', 'success');
  }

  async function selectRecordInputRegion(node) {
    const displayId = String(node?.config?.displayId || node?.config?.captureTarget?.displayId || '').trim();
    if (!displayId) {
      onToast('Choose an available display before selecting a Record Input region.', 'error');
      return;
    }
    setRecordInputBusy('region');
    try {
      const result = await window.localAIHub.selectRecordingRegion(displayId);
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not open the region selector.', 'error');
        return;
      }
      const region = result.data?.region;
      if (!result.data?.canceled && region) {
        updateNode(node.id, (currentNode) => ({
          ...currentNode,
          config: {
            ...currentNode.config,
            displayId: region.displayId || displayId,
            captureTarget: {
              displayId: region.displayId || displayId,
              height: region.height,
              type: 'region',
              width: region.width,
              x: region.x,
              y: region.y,
            },
          },
        }));
        onToast('Record Input region selected.', 'success');
      }
    } finally {
      setRecordInputBusy('');
    }
  }

  async function selectValidationRecordInputRegion(_control, values) {
    const displayId = String(values?.displayId || values?.captureTarget?.displayId || '').trim();
    if (!displayId) {
      onToast('Choose an available display before selecting a retry region.', 'error');
      return;
    }
    setRecordInputBusy('validation-region');
    try {
      const result = await window.localAIHub.selectRecordingRegion(displayId);
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not open the region selector.', 'error');
        return;
      }
      const region = result.data?.region;
      if (!result.data?.canceled && region) {
        handleValidationRetryOverrideChange('recordInput', {
          displayId: region.displayId || displayId,
          captureTarget: {
            displayId: region.displayId || displayId,
            height: region.height,
            type: 'region',
            width: region.width,
            x: region.x,
            y: region.y,
          },
        });
        onToast('Retry recording region selected.', 'success');
      }
    } finally {
      setRecordInputBusy('');
    }
  }

  async function runRecordInputAction(action) {
    const pending = runState?.pendingRecordInput;
    if (!runState?.runId || !pending?.nodeId || !pending?.requestId) {
      return;
    }
    const api = action === 'start'
      ? window.localAIHub.startPipelineRecordInput
      : action === 'stop'
        ? window.localAIHub.stopPipelineRecordInput
        : window.localAIHub.cancelPipelineRecordInput;
    setRecordInputBusy(action);
    try {
      const result = await api({
        nodeId: pending.nodeId,
        requestId: pending.requestId,
        runId: runState.runId,
      });
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not update that Record Input step.', 'error');
        return;
      }
      if (result.data?.run) {
        applyRunSnapshot(result.data.run);
      }
      onToast(result.data?.message || (action === 'start' ? 'Record Input started.' : action === 'stop' ? 'Record Input is finalizing.' : 'Record Input was canceled.'), action === 'cancel' ? 'error' : 'success');
    } catch (error) {
      onToast(error?.message || 'Local AI Hub could not update that Record Input step.', 'error');
    } finally {
      setRecordInputBusy('');
    }
  }

  function handleValidationRetryOverrideChange(section, patch) {
    setValidationRetryOverrides((current) => {
      const defaults = getPendingValidationRetryDefaults(runState?.pendingValidation);
      const nextSection = String(section || '').trim();
      return {
        ...(current || defaults || {}),
        [nextSection]: {
          ...((current || defaults || {})[nextSection] || {}),
          ...(patch || {}),
        },
      };
    });
  }

  async function handleValidationDecision(decision) {
    const pendingValidation = runState?.pendingValidation;
    if (!runState?.runId || !pendingValidation?.nodeId) {
      return;
    }

    setValidationBusy(true);
    try {
      const retryDefaults = getPendingValidationRetryDefaults(pendingValidation);
      const retryPayload = decision === 'fail'
        ? {
            ...(pendingValidation.retryControls?.mediaComposition ? { mediaComposition: getMediaCompositionRetryPayload(validationRetryOverrides?.mediaComposition || retryDefaults.mediaComposition) } : {}),
            ...(pendingValidation.retryControls?.burnSubtitles ? { burnSubtitles: getBurnSubtitlesRetryPayload(validationRetryOverrides?.burnSubtitles || retryDefaults.burnSubtitles) } : {}),
            ...(pendingValidation.retryControls?.recordInput ? { recordInput: getRecordInputRetryPayload(validationRetryOverrides?.recordInput || retryDefaults.recordInput) } : {}),
          }
        : null;
      const result = await window.localAIHub.resumePipelineValidation({
        comment: validationComment,
        decision,
        nodeId: pendingValidation.nodeId,
        requestId: pendingValidation.requestId,
        retryOverrides: retryPayload && Object.keys(retryPayload).length ? retryPayload : null,
        runId: runState.runId,
      });
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not continue that validation step.', 'error');
        return;
      }

      if (result.data?.run) {
        applyRunSnapshot(result.data.run);
      }
      setValidationComment('');
      setValidationRetryOverrides(null);
      onToast(result.data?.message || 'Validation decision saved.', 'success');
    } catch (error) {
      onToast(error?.message || 'Local AI Hub could not continue that validation step.', 'error');
    } finally {
      setValidationBusy(false);
    }
  }

  const paletteGroups = getNodePaletteGroups();
  const graphEdges = draft.edges.filter((edge) => {
    const sourceNode = graph.nodeMap.get(edge.source.nodeId) || null;
    const targetNode = graph.nodeMap.get(edge.target.nodeId) || null;
    return Boolean(
      sourceNode
      && targetNode
      && getPortDefinition(sourceNode, 'output', edge.source.portId)
      && getPortDefinition(targetNode, 'input', edge.target.portId)
    );
  });

  function measureRenderedPortCenters() {
    const graphSurface = graphSurfaceRef.current;
    if (!graphSurface || !sectionVisibility.canvas || !canvasZoom) {
      setMeasuredPortOffsets((current) => (Object.keys(current).length ? {} : current));
      return;
    }

    const surfaceBounds = graphSurface.getBoundingClientRect();
    const nodePositionById = new Map(draft.nodes.map((node) => [node.id, node.position || { x: 0, y: 0 }]));
    const nextOffsets = {};
    graphSurface.querySelectorAll('[data-pipeline-port-dot="true"]').forEach((dot) => {
      const nodeId = dot.getAttribute('data-node-id');
      const direction = dot.getAttribute('data-port-direction');
      const portId = dot.getAttribute('data-port-id');
      const nodePosition = nodePositionById.get(nodeId);
      if (!nodeId || !direction || !portId || !nodePosition) {
        return;
      }

      const dotBounds = dot.getBoundingClientRect();
      const centerX = (dotBounds.left + dotBounds.width / 2 - surfaceBounds.left) / canvasZoom;
      const centerY = (dotBounds.top + dotBounds.height / 2 - surfaceBounds.top) / canvasZoom;
      nextOffsets[getPipelinePortCenterKey(nodeId, direction, portId)] = {
        x: centerX - Number(nodePosition.x || 0),
        y: centerY - Number(nodePosition.y || 0),
      };
    });

    setMeasuredPortOffsets((current) => (arePipelinePortCenterMapsEqual(current, nextOffsets) ? current : nextOffsets));
  }

  function scheduleRenderedPortCenterMeasurement() {
    if (typeof window === 'undefined') {
      return;
    }

    if (portMeasurementFrameRef.current) {
      window.cancelAnimationFrame(portMeasurementFrameRef.current);
    }

    portMeasurementFrameRef.current = window.requestAnimationFrame(() => {
      portMeasurementFrameRef.current = 0;
      measureRenderedPortCenters();
    });
  }

  function getRenderedOrEstimatedPortCenter(node, direction, portId, portIndex) {
    const measuredOffset = measuredPortOffsets[getPipelinePortCenterKey(node?.id, direction, portId)];
    return measuredOffset && node?.position
      ? { x: Number(node.position.x || 0) + measuredOffset.x, y: Number(node.position.y || 0) + measuredOffset.y }
      : getNodePortCenter(node, direction, portIndex);
  }

  useLayoutEffect(() => {
    measureRenderedPortCenters();
    scheduleRenderedPortCenterMeasurement();
    return () => {
      if (portMeasurementFrameRef.current && typeof window !== 'undefined') {
        window.cancelAnimationFrame(portMeasurementFrameRef.current);
        portMeasurementFrameRef.current = 0;
      }
    };
  }, [canvasZoom, draft.nodes, graphEdges.length, sectionVisibility.canvas]);

  useLayoutEffect(() => {
    const graphSurface = graphSurfaceRef.current;
    if (!graphSurface || !sectionVisibility.canvas || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(() => scheduleRenderedPortCenterMeasurement());
    observer.observe(graphSurface);
    graphSurface.querySelectorAll('[data-pipeline-node-card="true"], [data-pipeline-port-dot="true"]').forEach((element) => observer.observe(element));
    scheduleRenderedPortCenterMeasurement();

    return () => {
      observer.disconnect();
      if (portMeasurementFrameRef.current && typeof window !== 'undefined') {
        window.cancelAnimationFrame(portMeasurementFrameRef.current);
        portMeasurementFrameRef.current = 0;
      }
    };
  }, [canvasZoom, draft.nodes, graphEdges.length, runState?.revision, sectionVisibility.canvas]);
  if (loading) {
    return <section className="panel p-4 text-sm text-slate-300">Loading the Pipeline Builder...</section>;
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto pb-4 pr-1">
        <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
          <div className={getPipelineSectionPanelClass(sectionVisibility.pipelineInfo)}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <button className="min-w-0 flex-1 text-left" onClick={() => toggleSection('pipelineInfo')} type="button">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Pipeline setup</p>
                <p className="mt-1 truncate text-lg font-semibold text-white">{draft.name || 'Untitled pipeline'}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-300">
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{currentPipelineSaved ? 'Saved pipeline' : 'New pipeline'}</span>
                  {pipelineMetadataDirty ? <span className="rounded-full border border-amber-300/30 bg-amber-300/12 px-3 py-1 text-amber-100">Metadata changed</span> : null}
                  <span className={`rounded-full border px-3 py-1 ${toneToClassName(analysis.compatibilitySummary?.tone || analysis.primaryIssue?.tone || 'neutral')}`}>{analysis.compatibilitySummary?.label || (analysis.executable ? 'Ready to run' : 'Needs attention')}</span>
                  <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">{analysis.executionOrder.length} queued step{analysis.executionOrder.length === 1 ? '' : 's'}</span>
                </div>
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <button className="ghost-button px-3 py-1.5 text-xs" onClick={createNewPipeline} type="button">New pipeline</button>
                <button className="ghost-button px-3 py-1.5 text-xs" disabled={copyBusy || !draft} onClick={handleCopyPipeline} type="button">{copyBusy ? 'Copying...' : 'Copy pipeline'}</button>
                <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => toggleSection('starterTemplates')} type="button">New from template</button>
                <button className="ghost-button px-3 py-1.5 text-xs" disabled={!currentPipelineSaved || deleteBusy} onClick={handleDeletePipeline} type="button">
                  {deleteBusy ? 'Deleting...' : 'Delete'}
                </button>
                <button className="primary-button px-3 py-1.5 text-xs" disabled={saveBusy} onClick={handleSavePipeline} type="button">
                  {savePipelineLabel}
                </button>
                {runState?.status === 'running' || runState?.status === 'paused' ? (
                  <button className="ghost-button px-3 py-1.5 text-xs" disabled={cancelBusy} onClick={handleCancelRun} type="button">
                    {cancelBusy ? 'Cancelling...' : 'Cancel run'}
                  </button>
                ) : (
                  <button className="primary-button px-3 py-1.5 text-xs" disabled={runBusy} onClick={handleRunPipeline} type="button">
                    {runBusy ? 'Starting...' : 'Run pipeline'}
                  </button>
                )}
                <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => toggleSection('pipelineInfo')} type="button">
                  {sectionVisibility.pipelineInfo ? 'Collapse' : 'Expand'}
                </button>
              </div>
            </div>

            {sectionVisibility.pipelineInfo ? (
              <div className="mt-4 grid gap-3 xl:grid-cols-[1.1fr,1fr]">
                <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
                  <label className="block text-xs uppercase tracking-[0.2em] text-slate-500" htmlFor="pipeline-name">Pipeline name</label>
                  <input
                    className="store-input mt-3"
                    id="pipeline-name"
                    onChange={(event) => updatePipelineMetadata('name', event.target.value)}
                    placeholder="Untitled pipeline"
                    value={draft.name}
                  />
                  <label className="mt-3 block text-xs uppercase tracking-[0.2em] text-slate-500" htmlFor="pipeline-description">Description</label>
                  <textarea
                    className="store-input mt-2 min-h-[76px] resize-none"
                    id="pipeline-description"
                    onChange={(event) => updatePipelineMetadata('description', event.target.value)}
                    placeholder="What should this workflow do?"
                    value={draft.description}
                  />
                  <p className="mt-3 text-xs leading-5 text-slate-400">
                    {currentPipelineSaved
                      ? 'Editing the name or description updates this same saved pipeline when you click Update pipeline.'
                      : 'Set the name and description before the first save so this pipeline is easy to find later.'}
                  </p>
                  <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-3">
                    <label className="flex items-center gap-3 text-sm font-medium text-white" htmlFor="pipeline-heavy-step-cooldown">
                      <input
                        checked={Boolean((draft.runSettings || DEFAULT_PIPELINE_RUN_SETTINGS).enableHeavyStepCooldown)}
                        className="h-4 w-4 accent-cyan-300"
                        id="pipeline-heavy-step-cooldown"
                        onChange={(event) => updatePipelineRunSettings({
                          enableHeavyStepCooldown: event.target.checked,
                          heavyStepCooldownSeconds: event.target.checked && Number((draft.runSettings || DEFAULT_PIPELINE_RUN_SETTINGS).heavyStepCooldownSeconds || 0) <= 0 ? 30 : (draft.runSettings || DEFAULT_PIPELINE_RUN_SETTINGS).heavyStepCooldownSeconds,
                        })}
                        type="checkbox"
                      />
                      Cooldown between heavy local steps
                    </label>
                    <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr),auto] sm:items-end">
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="pipeline-heavy-step-cooldown-seconds">Cooldown seconds</label>
                        <input
                          className="store-input mt-3"
                          id="pipeline-heavy-step-cooldown-seconds"
                          inputMode="numeric"
                          max={HEAVY_STEP_COOLDOWN_MAX_SECONDS}
                          min="0"
                          onChange={(event) => updatePipelineRunSettings({ heavyStepCooldownSeconds: event.target.value })}
                          step="1"
                          type="number"
                          value={(draft.runSettings || DEFAULT_PIPELINE_RUN_SETTINGS).heavyStepCooldownSeconds ?? 0}
                        />
                      </div>
                      <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">0-{HEAVY_STEP_COOLDOWN_MAX_SECONDS}s</span>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-slate-400">Adds a pause between demanding local generations. Useful for lower-end PCs that overheat or become unstable during chained runs.</p>
                  </div>
                </div>

                <div className={`rounded-2xl border p-3 ${toneToClassName(analysis.compatibilitySummary?.tone || analysis.primaryIssue?.tone || 'neutral')}`}>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Readiness and suitability</p>
                  <p className="mt-3 text-lg font-semibold text-white">{analysis.compatibilitySummary?.label || (analysis.executable ? 'Ready to run' : 'Needs attention')}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-100">{analysis.primaryIssue?.message || analysis.compatibilitySummary?.message || 'This pipeline is ready to run.'}</p>
                  <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-slate-300">
                    <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">{analysis.executionOrder.length} queued step{analysis.executionOrder.length === 1 ? '' : 's'}</span>
                    <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">{getIssueCountText(analysis.issues.length)}</span>
                    <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">Sequential only</span>
                  </div>
                  {analysis.issues.length ? (
                    <div className="mt-4 max-h-56 space-y-2 overflow-y-auto pr-1">
                      {analysis.issues.map((issue, index) => (
                        <div key={`${issue.message}-${index}`} className={`rounded-2xl border px-3 py-2 text-sm ${toneToClassName(issue.tone)}`}>{issue.message}</div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
          <div className={getPipelineSectionPanelClass(sectionVisibility.starterTemplates)}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <button className="min-w-0 flex-1 text-left" onClick={() => toggleSection('starterTemplates')} type="button">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Starter templates</p>
                <p className="mt-2 text-lg font-semibold text-white">New from built-in workflows</p>
                <p className="mt-2 text-sm leading-6 text-slate-400">Templates stay visible when dependencies are missing, but Local AI Hub labels what is needed before the workflow can run.</p>
              </button>
              <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{templateCards.length} starters</span>
                <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => toggleSection('starterTemplates')} type="button">
                  {sectionVisibility.starterTemplates ? 'Collapse' : 'Expand'}
                </button>
              </div>
            </div>

            {sectionVisibility.starterTemplates ? (
              <div className="mt-4 space-y-5">
                <label className="block">
                  <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Search templates</span>
                  <input
                    className="store-input mt-2"
                    onChange={(event) => setTemplateSearch(event.target.value)}
                    placeholder="Search by name, output, tool, or requirement"
                    type="search"
                    value={templateSearch}
                  />
                </label>
                {templateGroups.length ? templateGroups.map((group) => (
                  <section key={group.category}>
                    <div className="mb-3 flex items-center gap-3">
                      <h3 className="text-sm font-semibold text-white">{group.category}</h3>
                      <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-slate-400">{group.templates.length}</span>
                    </div>
                    <div className="grid gap-3 xl:grid-cols-2">
                      {group.templates.map((template) => {
                        const readiness = template.readiness || {};
                        const detailLines = getTemplateDetailLines(readiness);
                        const unavailable = readiness.status === TEMPLATE_STATUS.UNAVAILABLE;
                        return (
                          <div className={`rounded-2xl border p-3 ${unavailable ? 'border-white/10 bg-white/[0.025] opacity-70' : 'border-white/10 bg-slate-950/35'}`} key={template.id}>
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-sm font-semibold text-white">{template.name}</p>
                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${toneToClassName(getTemplateStatusTone(readiness))}`}>{getTemplateStatusLabel(readiness)}</span>
                                </div>
                                <p className="mt-2 text-xs leading-5 text-slate-400">{template.description}</p>
                              </div>
                              <button className={unavailable ? 'ghost-button px-3 py-1.5 text-xs opacity-70' : 'primary-button px-3 py-1.5 text-xs'} disabled={unavailable} onClick={() => createPipelineFromTemplate(template.id)} type="button">
                                {getTemplateActionLabel(readiness)}
                              </button>
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">{template.outputType}</span>
                              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">{template.complexity}</span>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {(template.requirements || []).slice(0, 4).map((requirement) => (
                                <span className="rounded-full border border-white/10 bg-slate-950/40 px-2 py-1 text-[11px] text-slate-300" key={requirement}>{requirement}</span>
                              ))}
                            </div>
                            {detailLines.length ? (
                              <div className="mt-3 space-y-1 text-xs leading-5 text-amber-100">
                                {detailLines.slice(0, 3).map((line) => <p key={line}>{line}</p>)}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )) : (
                  <p className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-5 text-sm text-slate-400">No templates match that search.</p>
                )}
              </div>
            ) : null}
          </div>
          <div className={getPipelineSectionPanelClass(sectionVisibility.pipelineWizard)}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Pipeline wizard</p>
            <p className="mt-2 text-lg font-semibold text-white">Draft from plain English</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Grounded recipes</span>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Editable graph</span>
            <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => toggleSection('pipelineWizard')} type="button">
              {sectionVisibility.pipelineWizard ? 'Collapse' : 'Expand'}
            </button>
          </div>
        </div>

        {sectionVisibility.pipelineWizard ? (
          <div className="mt-4 grid gap-4 xl:grid-cols-[0.9fr,1.2fr]">
            <div className="space-y-4 rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
              <div>
                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="pipeline-wizard-mode">Wizard target</label>
                <select
                  className="store-input mt-3"
                  id="pipeline-wizard-mode"
                  onChange={(event) => {
                    setWizardExecutionMode(event.target.value === 'ollama' ? 'ollama' : 'cloud');
                    setWizardModel('');
                    setWizardModelOptions([]);
                    setWizardSummary(null);
                  }}
                  value={wizardExecutionMode}
                >
                  <option value="cloud">Cloud provider</option>
                  <option value="ollama">Ollama (local)</option>
                </select>
              </div>

              {wizardExecutionMode === 'cloud' ? (
                <div>
                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="pipeline-wizard-provider">Provider</label>
                  <select
                    className="store-input mt-3"
                    id="pipeline-wizard-provider"
                    onChange={(event) => {
                      setWizardProviderId(event.target.value);
                      setWizardModel('');
                      setWizardModelOptions([]);
                      setWizardSummary(null);
                    }}
                    value={wizardProviderId}
                  >
                    <option value="">Choose a connected provider</option>
                    {connectedProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>{provider.name}</option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div>
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="pipeline-wizard-model">Model</label>
                  <button className="ghost-button px-3 py-1.5 text-xs" disabled={wizardModelsBusy} onClick={refreshWizardModels} type="button">
                    {wizardModelsBusy ? 'Loading...' : 'Refresh'}
                  </button>
                </div>
                <input
                  className="store-input mt-3"
                  id="pipeline-wizard-model"
                  list="pipeline-wizard-model-options"
                  onChange={(event) => setWizardModel(event.target.value)}
                  placeholder={wizardExecutionMode === 'ollama' ? 'Choose an Ollama model' : 'Choose a provider model'}
                  value={wizardModel}
                />
                <datalist id="pipeline-wizard-model-options">
                  {wizardModelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </datalist>
                {wizardModelOptions.length ? (
                  <div className="mt-3 max-h-36 space-y-2 overflow-auto pr-1">
                    {wizardModelOptions.slice(0, 8).map((model) => (
                      <button
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-left text-xs transition hover:border-cyan-300/25 hover:bg-white/10"
                        key={model.id}
                        onClick={() => setWizardModel(model.id)}
                        type="button"
                      >
                        <span className="font-medium text-white">{model.label || model.id}</span>
                        {model.detail ? <span className="ml-2 text-slate-400">{model.detail}</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {wizardExecutionMode === 'ollama' && selectedWizardModelOption?.wizardSuitability ? (
                  <p className={`mt-3 text-xs leading-5 ${selectedWizardModelOption.wizardSuitability.tone === 'warn' ? 'text-amber-200' : 'text-slate-300'}`}>
                    {getLocalWizardModelGuidance(selectedWizardModelOption, wizardIntent)}
                  </p>
                ) : wizardExecutionMode === 'ollama' ? (
                  <p className="mt-3 text-xs leading-5 text-slate-400">Refresh to rank downloaded Ollama models for local wizard drafting on this PC.</p>
                ) : null}
              </div>
            </div>

            <div className="space-y-4 rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
              <div>
                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="pipeline-wizard-intent">Workflow request</label>
                <textarea
                  className="store-input mt-3 min-h-[152px] resize-none"
                  id="pipeline-wizard-intent"
                  onChange={(event) => {
                    setWizardIntent(event.target.value);
                    setWizardSummary(null);
                  }}
                  placeholder="Example: turn a product description into a short image generation pipeline with a final image output."
                  value={wizardIntent}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button className="primary-button" disabled={wizardBusy} onClick={handleGenerateWizardDraft} type="button">
                  {wizardBusy ? 'Drafting...' : 'Generate draft'}
                </button>
                <span className="text-xs leading-5 text-slate-400">{getWizardTargetLabel(wizardTarget, connectedProviders)}</span>
              </div>
              {wizardSummary ? (
                <div className={`rounded-[24px] border p-4 ${toneToClassName(wizardSummary.resultState === 'placeholder' || wizardSummary.graphErrorCount ? 'warn' : 'info')}`}>
                  <p className="text-sm font-semibold text-white">{wizardSummary.headline}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-100">{wizardSummary.message}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-200">
                    <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">{wizardSummary.recipeLabel}</span>
                    {wizardSummary.targetLabel ? <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">{wizardSummary.targetLabel}</span> : null}
                  </div>
                  {wizardSummary.gaps?.length ? (
                    <div className="mt-3 space-y-1 text-xs leading-5 text-slate-200">
                      {wizardSummary.gaps.slice(0, 3).map((gap) => <p key={gap}>{gap}</p>)}
                    </div>
                  ) : null}
                  {wizardSummary.manualRefinementNotes?.length ? (
                    <div className="mt-3 space-y-1 text-xs leading-5 text-slate-300">
                      {wizardSummary.manualRefinementNotes.slice(0, 3).map((note) => <p key={note}>{note}</p>)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <>
          <div className={getPipelineSectionPanelClass(sectionVisibility.savedPipelines)}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Saved pipelines</p>
                <p className="mt-2 text-lg font-semibold text-white">Load and reuse</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => refreshPipelineList()} type="button">Refresh list</button>
                <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => toggleSection('savedPipelines')} type="button">
                  {sectionVisibility.savedPipelines ? 'Collapse' : 'Expand'}
                </button>
              </div>
            </div>
            {sectionVisibility.savedPipelines ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {visibleSavedPipelines.length ? visibleSavedPipelines.map((pipeline) => (
                <SavedPipelineRow active={pipeline.id === draft.id} hasPendingMetadataChanges={pipeline.id === draft.id && pipelineMetadataDirty} key={pipeline.id} onClick={() => loadSavedPipeline(pipeline.id)} pipeline={pipeline} />
              )) : (
                <div className="rounded-[24px] border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
                  Save the current pipeline to build a reusable library here.
                </div>
              )}
            </div>
            ) : null}
          </div>

          <div className={getPipelineSectionPanelClass(sectionVisibility.nodePalette)}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Node palette</p>
                <p className="mt-2 text-lg font-semibold text-white">Inputs, AI, flow, validation, outputs</p>
              </div>
              <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => toggleSection('nodePalette')} type="button">
                {sectionVisibility.nodePalette ? 'Collapse' : 'Expand'}
              </button>
            </div>
            {sectionVisibility.nodePalette ? (
              <>
                <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs leading-6 text-slate-400">
                  Add nodes across text, image, audio, video, and file workflows. Connections stay typed, validation can branch to pass or fail, and Branch Merge recombines compatible paths explicitly.
                </div>
                <div className="mt-4 grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
                  {paletteGroups.map((group) => (
                    <div key={group.label} className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{group.label}</p>
                      <div className="mt-3 space-y-2">
                        {group.entries.map((entry) => (
                          <button
                            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:border-cyan-300/25 hover:bg-white/10"
                            key={entry.type}
                            onClick={() => addNode(entry.type)}
                            type="button"
                          >
                            <p className="text-sm font-semibold text-white">{entry.label}</p>
                            <p className="mt-1 text-xs leading-5 text-slate-400">{entry.description}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          <div className={getPipelineSectionPanelClass(sectionVisibility.inspector)}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Node inspector</p>
                <p className="mt-2 text-lg font-semibold text-white">{selectedNode ? selectedNode.label : 'Select a node'}</p>
              </div>
              <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => toggleSection('inspector')} type="button">
                {sectionVisibility.inspector ? 'Collapse' : 'Expand'}
              </button>
            </div>
            {sectionVisibility.inspector ? (selectedNode ? (
              <PipelineInspectorErrorBoundary nodeId={selectedNode.id} nodeType={selectedNode.type} onClearSelection={() => setSelectedNodeId('')} resetKey={selectedNode.id}>
                <div className="mt-4 space-y-4">
                <div>
                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="node-label">Node label</label>
                  <input className="store-input mt-3" id="node-label" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, label: event.target.value }))} value={selectedNode.label} />
                </div>

                <div className={`rounded-[24px] border p-4 ${toneToClassName(currentNodeSummary?.readiness?.tone || currentNodeSummary?.compatibility?.tone || 'neutral')}`}>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-300">Readiness</p>
                  <p className="mt-2 text-sm leading-6 text-slate-100">{currentNodeSummary?.readiness?.message || 'This node is ready.'}</p>
                  {currentNodeSummary?.capabilitySummary ? <p className="mt-2 text-xs leading-5 text-slate-200">{currentNodeSummary.capabilitySummary.message}</p> : null}
                  {currentNodeSummary?.compatibility ? <p className="mt-2 text-xs leading-5 text-slate-200">{currentNodeSummary.compatibility.source}: {currentNodeSummary.compatibility.message}</p> : null}
                </div>

                {selectedNode.type === 'textInput' ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="node-text-input">Text input</label><textarea className="store-input mt-3 min-h-[180px] resize-none" id="node-text-input" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, text: event.target.value } }))} placeholder="Write the initial text for this workflow." value={selectedNode.config?.text || ''} /></div> : null}

                {selectedNode.type === 'recordInput' ? (() => {
                  const mode = getRecordInputModeDefinition(selectedNode.config?.mode) || RECORD_INPUT_MODE_OPTIONS[0];
                  const captureTargetType = String(selectedNode.config?.captureTarget?.type || 'desktop').trim() === 'region' ? 'region' : 'desktop';
                  const selectedDisplay = recordingDisplays.find((display) => String(display.id) === String(selectedNode.config?.displayId || selectedNode.config?.captureTarget?.displayId || '')) || null;
                  const showDisplay = mode.needsDisplay || captureTargetType === 'region';
                  return (
                    <div className="space-y-4">
                      <div className="grid gap-4 lg:grid-cols-2">
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="record-input-mode">Capture source</label>
                          <select
                            className="store-input mt-3"
                            id="record-input-mode"
                            onChange={(event) => changeRecordInputMode(selectedNode, event.target.value)}
                            value={selectedNode.config?.mode || RECORD_INPUT_MODE_IDS.SCREEN}
                          >
                            {RECORD_INPUT_MODE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="record-input-format">Output</label>
                          <input className="store-input mt-3" id="record-input-format" readOnly value={`${getRecordInputOutputKind(selectedNode)} | ${getRecordInputFormatLabel(selectedNode)}`} />
                        </div>
                      </div>

                      {mode.needsScreen ? (
                        <div className="space-y-4 rounded-[20px] border border-white/10 bg-slate-950/30 p-4">
                          <div>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="record-input-target">Screen target</label>
                            <select
                              className="store-input mt-3"
                              id="record-input-target"
                              onChange={(event) => {
                                const nextType = event.target.value === 'region' ? 'region' : 'desktop';
                                updateNode(selectedNode.id, (currentNode) => ({
                                  ...currentNode,
                                  config: {
                                    ...currentNode.config,
                                    captureTarget: nextType === 'region'
                                      ? buildDefaultRecordInputRegion(selectedDisplay || recordingDisplays.find((display) => display.primary) || recordingDisplays[0])
                                      : { type: 'desktop' },
                                  },
                                }));
                              }}
                              value={captureTargetType}
                            >
                              <option value="desktop">{mode.needsSystemAudio ? 'Selected display' : 'Full desktop'}</option>
                              <option value="region">Region</option>
                            </select>
                          </div>

                          {showDisplay ? (
                            <div>
                              <div className="flex flex-wrap items-end gap-3">
                                <label className="min-w-[240px] flex-1 text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="record-input-display">
                                  Display
                                  <select
                                    className="store-input mt-3"
                                    disabled={recordingDisplaysBusy || !recordingDisplays.length}
                                    id="record-input-display"
                                    onChange={(event) => {
                                      const display = recordingDisplays.find((entry) => String(entry.id) === event.target.value) || null;
                                      updateNode(selectedNode.id, (currentNode) => ({
                                        ...currentNode,
                                        config: {
                                          ...currentNode.config,
                                          displayId: event.target.value,
                                          captureTarget: captureTargetType === 'region'
                                            ? buildDefaultRecordInputRegion(display)
                                            : currentNode.config?.captureTarget || { type: 'desktop' },
                                        },
                                      }));
                                    }}
                                    value={selectedNode.config?.displayId || ''}
                                  >
                                    <option value="">Choose display</option>
                                    {recordingDisplays.map((display) => {
                                      const bounds = display.captureBounds || display.bounds || {};
                                      return <option key={display.id} value={display.id}>{display.name}{display.primary ? ' (primary)' : ''} - {bounds.width}x{bounds.height}</option>;
                                    })}
                                  </select>
                                </label>
                                <button className="ghost-button" disabled={recordingDisplaysBusy} onClick={loadRecordingDisplays} type="button">{recordingDisplaysBusy ? 'Refreshing...' : 'Refresh displays'}</button>
                                {captureTargetType === 'region' ? <button className="ghost-button" disabled={!selectedNode.config?.displayId || recordInputBusy === 'region'} onClick={() => selectRecordInputRegion(selectedNode)} type="button">{recordInputBusy === 'region' ? 'Selecting...' : 'Select region'}</button> : null}
                              </div>
                            </div>
                          ) : null}

                          {captureTargetType === 'region' ? (
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                              {[
                                ['x', 'X'],
                                ['y', 'Y'],
                                ['width', 'Width'],
                                ['height', 'Height'],
                              ].map(([key, label]) => (
                                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" key={key}>
                                  {label}
                                  <input
                                    className="store-input mt-3"
                                    min={key === 'width' || key === 'height' ? 64 : undefined}
                                    onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                                      ...currentNode,
                                      config: {
                                        ...currentNode.config,
                                        captureTarget: {
                                          ...(currentNode.config?.captureTarget || { type: 'region' }),
                                          [key]: Number(event.target.value),
                                          displayId: currentNode.config?.displayId || '',
                                          type: 'region',
                                        },
                                      },
                                    }))}
                                    step={key === 'width' || key === 'height' ? 2 : 1}
                                    type="number"
                                    value={selectedNode.config?.captureTarget?.[key] ?? 0}
                                  />
                                </label>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : mode.needsDisplay ? (
                        <div className="flex flex-wrap items-end gap-3">
                          <label className="min-w-[240px] flex-1 text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="record-input-audio-display">
                            Display permission source
                            <select className="store-input mt-3" disabled={recordingDisplaysBusy || !recordingDisplays.length} id="record-input-audio-display" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, displayId: event.target.value } }))} value={selectedNode.config?.displayId || ''}>
                              <option value="">Choose display</option>
                              {recordingDisplays.map((display) => <option key={display.id} value={display.id}>{display.name}{display.primary ? ' (primary)' : ''}</option>)}
                            </select>
                          </label>
                          <button className="ghost-button" disabled={recordingDisplaysBusy} onClick={loadRecordingDisplays} type="button">{recordingDisplaysBusy ? 'Refreshing...' : 'Refresh displays'}</button>
                        </div>
                      ) : null}

                      {mode.needsMicrophone ? (
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="record-input-microphone">Microphone</label>
                          <select className="store-input mt-3" disabled={recordingDevicesBusy || !recordingDevices.microphones.length} id="record-input-microphone" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, microphoneId: event.target.value } }))} value={selectedNode.config?.microphoneId || ''}>
                            <option value="">Choose microphone</option>
                            {recordingDevices.microphones.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
                          </select>
                        </div>
                      ) : null}

                      {mode.needsWebcam ? (
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="record-input-webcam">Webcam</label>
                          <select className="store-input mt-3" disabled={recordingDevicesBusy || !recordingDevices.webcams.length} id="record-input-webcam" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, webcamId: event.target.value } }))} value={selectedNode.config?.webcamId || ''}>
                            <option value="">Choose webcam</option>
                            {recordingDevices.webcams.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
                          </select>
                        </div>
                      ) : null}

                      {mode.needsMicrophone || mode.needsWebcam ? <button className="ghost-button" disabled={recordingDevicesBusy} onClick={() => loadRecordingDevices(true)} type="button">{recordingDevicesBusy ? 'Scanning devices...' : 'Refresh devices'}</button> : null}

                      {mode.outputKind === 'video' ? (
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="record-input-fps">Frame rate</label>
                          <select className="store-input mt-3" id="record-input-fps" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, fps: Number(event.target.value) } }))} value={Number(selectedNode.config?.fps || 15)}>
                            <option value={10}>10 FPS</option>
                            <option value={15}>15 FPS (lower impact)</option>
                            <option value={24}>24 FPS</option>
                            <option value={30}>30 FPS</option>
                            <option value={60}>60 FPS</option>
                          </select>
                        </div>
                      ) : null}

                      {mode.needsScreen || mode.needsSystemAudio ? <div className="rounded-[18px] border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-xs leading-5 text-amber-100">Screen and system-audio capture can include notifications, passwords, private conversations, meeting audio, browser sounds, and confidential work. The pipeline pauses and waits for an explicit Start Recording action.</div> : null}
                      <div className="rounded-[18px] border border-white/10 bg-slate-950/35 px-4 py-3 text-xs leading-5 text-slate-400">Unsupported combinations stay unavailable: screen + webcam, window capture, system audio + microphone, webcam + system audio, and hardware encoder selection.</div>
                    </div>
                  );
                })() : null}

                {['imageInput', 'audioInput', 'videoInput', 'fileInput'].includes(selectedNode.type) ? (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="node-file-input">Selected file</label>
                      <input className="store-input mt-3" id="node-file-input" readOnly value={selectedNode.config?.filePath || ''} />
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <button className="ghost-button" onClick={() => chooseNodeFile(selectedNode.id, selectedNode.type === 'imageInput' ? 'image' : selectedNode.type === 'audioInput' ? 'audio' : selectedNode.type === 'videoInput' ? 'video' : 'file')} type="button">Choose file</button>
                      <button className="ghost-button" onClick={() => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, filePath: '' } }))} type="button">Clear</button>
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'collectionInput' ? (() => {
                  const itemType = normalizeCollectionInputItemType(selectedNode.config?.itemType);
                  const items = getCollectionInputItems(selectedNode);
                  const itemTypeLabel = PIPELINE_PORT_KIND_LABELS[itemType] || itemType;
                  return (
                    <div className="space-y-4">
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-input-type">Item type</label>
                        <select
                          className="store-input mt-3"
                          id="collection-input-type"
                          onChange={(event) => updateCollectionInputType(selectedNode.id, event.target.value)}
                          value={itemType}
                        >
                          {COLLECTION_INPUT_ITEM_TYPE_OPTIONS.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
                        </select>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{items.length} {itemTypeLabel.toLowerCase()} item{items.length === 1 ? '' : 's'}</p>
                        <button
                          className="ghost-button"
                          onClick={() => (itemType === 'text' ? addCollectionInputTextItem(selectedNode.id) : addCollectionInputFileItem(selectedNode.id, itemType))}
                          type="button"
                        >
                          Add item
                        </button>
                      </div>
                      {items.length ? (
                        <div className="space-y-3">
                          {items.map((item, index) => {
                            const itemId = getCollectionInputItemId(item, index);
                            const filePath = String(item.filePath || item.path || '').trim();
                            return (
                              <div className="rounded-[18px] border border-white/10 bg-slate-950/35 px-3 py-3" key={itemId}>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Item {index + 1}</p>
                                  <div className="flex flex-wrap gap-2">
                                    <button className="ghost-button px-2 py-1 text-xs" disabled={index === 0} onClick={() => moveCollectionInputItem(selectedNode.id, itemId, 'up')} type="button">Up</button>
                                    <button className="ghost-button px-2 py-1 text-xs" disabled={index === items.length - 1} onClick={() => moveCollectionInputItem(selectedNode.id, itemId, 'down')} type="button">Down</button>
                                    <button className="ghost-button px-2 py-1 text-xs" onClick={() => removeCollectionInputItem(selectedNode.id, itemId)} type="button">Remove</button>
                                  </div>
                                </div>
                                {itemType === 'text' ? (
                                  <textarea
                                    className="store-input mt-3 min-h-[88px] resize-none"
                                    onChange={(event) => updateCollectionInputItem(selectedNode.id, itemId, { text: event.target.value })}
                                    placeholder="Text item"
                                    value={item.text || item.value || ''}
                                  />
                                ) : (
                                  <div className="mt-3 space-y-2">
                                    <input className="store-input" readOnly value={filePath} />
                                    <p className="text-xs leading-5 text-slate-400">{fileNameFromPath(filePath) || 'No file selected.'}</p>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="rounded-[18px] border border-dashed border-white/10 bg-white/5 px-4 py-5 text-sm leading-6 text-slate-400">
                          Add one or more {itemTypeLabel.toLowerCase()} items before running this pipeline.
                        </div>
                      )}
                    </div>
                  );
                })() : null}
                {selectedNode.type === 'llmPrompt' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-operation">
                        Operation
                      </label>
                      <select
                        className="store-input mt-3"
                        disabled={selectedNode.config?.executionMode === 'ollama'}
                        id="llm-operation"
                        onChange={(event) =>
                          updateNode(selectedNode.id, (currentNode) => {
                            const nextOperationId = event.target.value;
                            const nextLocalToolOptions = nextOperationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
                              ? transcriptionTools
                              : nextOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                                ? audioTools
                                : nextOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                                  ? audioTransformTools
                                  : nextOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                                    ? imageTransformTools
                                    : nextOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                                      ? videoTools
                                      : imageTools;
                            const currentToolId = String(currentNode.config?.toolId || '').trim();
                            const currentProviderId = String(currentNode.config?.providerId || '').trim().toLowerCase();
                            const currentProvider = currentProviderId ? connectedProviders.find((provider) => String(provider.id || '').trim().toLowerCase() === currentProviderId) : null;
                            const nextProviderId = currentNode.config?.executionMode === 'cloud' && currentProvider && !providerSupportsPipelineOperation(currentProvider, nextOperationId) ? '' : currentNode.config?.providerId || '';
                            const nextToolId = currentNode.config?.executionMode === 'localTool'
                              ? (nextLocalToolOptions.some((tool) => tool.id === currentToolId) ? currentToolId : nextLocalToolOptions[0]?.id || '')
                              : currentToolId;
                            return {
                              ...currentNode,
                              config: {
                                ...currentNode.config,
                                model: '',
                                operationId: nextOperationId,
                                providerId: nextProviderId,
                                toolId: nextToolId,
                                ...(currentNode.config?.executionMode === 'localTool' && nextOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? { audioMode: normalizeAudioModeForLocalTool(nextToolId, currentNode.config?.audioMode) } : {}),
                              },
                            };
                          })
                        }
                        value={getSelectedModelStepOperationId(selectedNode)}
                      >
                        {getModelStepOperationOptionsForUi(selectedNode, connectedProviders).map((option) => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </select>
                      <p className="mt-2 text-xs leading-5 text-slate-400">
                        {selectedNode.config?.executionMode === 'ollama'
                          ? 'Local Ollama mode currently returns text only.'
                          : selectedNode.config?.executionMode === 'localTool'
                            ? getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                              ? 'Local audio tool mode returns a generated audio artifact from the Audio output port. Music mode can use upstream audio as guidance, and Continuation mode extends the end of a connected source clip.'
                              : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                                ? 'Local audio transform tool mode returns a transformed audio artifact from the Audio output port and keeps the source-audio lineage visible after the run.'
                                : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                                  ? 'Local image transform mode returns a transformed image artifact from the Image output port. FaceFusion also expects a connected Reference Image as the source face.'
                                  : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                                    ? 'Local video tool mode returns a video artifact from the Video output port. Use the Graph Workflow step for ComfyUI video workflows.'
                                    : 'Local image tool mode returns an image artifact from the Image output port.'
                            : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
                              ? 'Cloud Image Generation sends text, or a source image plus an edit instruction, to the selected provider and returns an image artifact from the Image output port.'
                              : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                                ? 'This step returns a saved audio artifact from the Audio output port.'
                                : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                                  ? 'Audio transform runs through the local-tool path and returns a saved transformed audio artifact from the Audio output port.'
                                  : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                                    ? 'This step returns a video artifact from the Video output port.'
                                    : 'This step returns a text artifact from the Text output port.'}
                      </p>
                    </div>
                    <ModelTargetFields allowLocalTool connectedProviders={connectedProviders} executionModeKey="executionMode" localAudioTools={audioTools} localAudioTransformTools={audioTransformTools} localImageTools={imageTools} localImageTransformTools={imageTransformTools} localTranscriptionTools={transcriptionTools} localVideoTools={videoTools} modelOptions={modelOptionsByNodeId[selectedNode.id]} modelsBusy={modelsBusyNodeId === selectedNode.id} node={selectedNode} onRefreshModels={refreshNodeModels} onUpdateNode={updateNode} providerIdKey="providerId" />
                    <PromptStyleSelector id="llm-prompt-style" onChange={(promptStyleId) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, promptStyleId } }))} promptStyles={promptStyles} targetKind={getPromptStyleTargetKindForModelStep(selectedNode)} value={selectedNode.config?.promptStyleId || ''} />
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-instruction">
                        {getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
                          ? (selectedNode.config?.executionMode === 'cloud' ? 'Prompt prefix / image edit instruction' : 'Prompt prefix / style guidance')
                          : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                            ? selectedNode.config?.executionMode === 'localTool'
                              ? (isModelStepChatterboxAudioMode(selectedNode) ? 'Reference voice speech guidance' : 'Prompt shaping / audio guidance')
                              : 'Speech guidance / delivery hint'
                            : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                              ? 'Transformation note'
                              : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                                ? 'Transformation note'
                                : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                                  ? 'Motion guidance / prompt shaping'
                                  : 'Task / instruction'}
                      </label>
                      <textarea
                        className="store-input mt-3 min-h-[120px] resize-none"
                        id="llm-instruction"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, instruction: event.target.value } }))}
                        placeholder={getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
                          ? (selectedNode.config?.executionMode === 'cloud' ? 'For text input, optional style guidance. For image input, describe how the source image should be edited.' : 'Optional style or scene guidance to prepend to the incoming prompt.')
                          : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                            ? selectedNode.config?.executionMode === 'localTool'
                              ? (isModelStepChatterboxAudioMode(selectedNode) ? 'Optional guidance for the spoken delivery. The connected text remains the words to speak, and the Reference Audio input supplies the voice sample.' : 'Optional guidance for the generated audio. In Music mode, use this for mood, style, or instrumentation. In Continuation mode, use this only as optional text conditioning for the continuation.')
                              : 'Optional guidance for how the provider should speak the connected text, such as tone, pacing, or delivery style.'
                            : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                              ? 'Optional note to save with this transformed audio result. Choose the source audio and RVC voice model through the connected input and local model field.'
                              : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                                ? 'Optional note to save with this transformed image result. The main image input becomes the target image, and FaceFusion also uses the Reference Image input as the source face.'
                                : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                                  ? 'For text-to-video, this is optional extra guidance. For image-to-video, use this box for the motion prompt.'
                                  : 'Optional guidance to apply to the incoming text.'}
                        value={selectedNode.config?.instruction || ''}
                      />
                      {getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? (
                        <p className="mt-2 text-xs leading-5 text-slate-400">
                          {selectedNode.config?.executionMode === 'localTool'
                            ? (isModelStepChatterboxAudioMode(selectedNode) ? 'Text input becomes the words to speak. Reference Voice TTS also requires a reference voice audio clip on the Reference Audio input.' : 'Text input becomes the base prompt for Music or Sound mode. Continuation mode requires an upstream audio artifact and uses the end of that clip as the generation seed.')
                            : 'Text input becomes the spoken content for this cloud audio step. Use the instruction box for optional delivery guidance, and choose a provider voice below when the model supports it.'}
                        </p>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM ? (
                        <p className="mt-2 text-xs leading-5 text-slate-400">
                          Connect a source audio artifact to this step and choose an RVC voice model. This instruction box is saved with the transformed result as a plain-English note in this first pass.
                        </p>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM ? (
                        <p className="mt-2 text-xs leading-5 text-slate-400">
                          Connect the target image to the main input for every local image transform step. FaceFusion also needs a source-face image on the Reference Image input, while Upscayl uses only the main image input.
                        </p>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE ? (
                        <p className="mt-2 text-xs leading-5 text-slate-400">
                          Text input becomes the base video prompt. If this step is connected to an image, use this box for the motion prompt that should animate that image.
                        </p>
                      ) : null}
                    </div>
                    {selectedNode.config?.executionMode === 'localTool' ? (
                      getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? (
                        <div className="space-y-4">
                          <div>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-audio-mode">Audio mode</label>
                            <select className="store-input mt-3" id="llm-local-audio-mode" onChange={(event) => {
                              const nextAudioMode = event.target.value;
                              updateNode(selectedNode.id, (currentNode) => {
                                const toolId = getModelStepLocalAudioToolIdForUi(currentNode);
                                const nextConfig = {
                                  ...currentNode.config,
                                  audioMode: normalizeAudioModeForLocalTool(toolId, nextAudioMode),
                                  toolId,
                                };
                                return { ...currentNode, config: nextConfig };
                              });
                            }} value={getModelStepLocalAudioModeForUi(selectedNode)}>
                              {getAudioModeOptionsForLocalTool(getModelStepLocalAudioToolIdForUi(selectedNode)).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                            </select>
                          </div>
                          <div className={getModelStepLocalAudioModeForUi(selectedNode) === 'continuation' ? 'grid gap-3 sm:grid-cols-3' : getModelStepLocalAudioModeForUi(selectedNode) === 'referenceVoiceTts' ? 'hidden' : ''}>
                            {getModelStepLocalAudioModeForUi(selectedNode) === 'continuation' ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-audio-seed">Seed from source ending (seconds)</label><input className="store-input mt-3" id="llm-local-audio-seed" max="30" min="0.25" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, continuationSeedSeconds: Number(event.target.value || 0) || 0 } }))} step="0.25" type="number" value={selectedNode.config?.continuationSeedSeconds || 12} /></div> : null}
                            {getModelStepLocalAudioModeForUi(selectedNode) === 'continuation' ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-audio-repeat">Repeat count</label><input className="store-input mt-3" id="llm-local-audio-repeat" max="10" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, continuationRepeatCount: Math.max(1, Math.min(10, Math.floor(Number(event.target.value || 1) || 1))) } }))} step="1" type="number" value={selectedNode.config?.continuationRepeatCount || 1} /></div> : null}
                            <div>
                              <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-audio-duration">{getModelStepLocalAudioModeForUi(selectedNode) === 'continuation' ? 'Generated continuation duration' : 'Duration'} (seconds)</label>
                              <input className="store-input mt-3" id="llm-local-audio-duration" max="60" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, durationSeconds: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.durationSeconds || 8} />
                            </div>
                          </div>
                          {getModelStepLocalAudioModeForUi(selectedNode) === 'continuation' ? <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-200" htmlFor="llm-local-audio-append"><input checked={Boolean(selectedNode.config?.appendSource)} className="h-4 w-4 accent-cyan-300" id="llm-local-audio-append" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, appendSource: event.target.checked } }))} type="checkbox" />Append source audio to continuation</label> : null}
                          {getModelStepLocalAudioModeForUi(selectedNode) === 'referenceVoiceTts' ? <div className="rounded-[18px] border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-50/90">Only clone voices you have permission to use.</div> : null}
                          <p className="text-xs leading-5 text-slate-400">
                            {getModelStepLocalAudioModeForUi(selectedNode) === 'sound'
                              ? 'Sound mode runs AudioGen and currently accepts text prompts only. Use it for environmental or effect-style clips rather than melody-guided output.'
                              : getModelStepLocalAudioModeForUi(selectedNode) === 'continuation'
                                ? (selectedNode.config?.appendSource ? 'Continuation mode will output one WAV containing the full source audio followed by each generated continuation segment. Higher repeat counts can take much longer.' : 'Continuation mode outputs only the generated continuation segments. Each repeat uses the end of the current audio as the next seed, and higher counts can take much longer.')
                                : getModelStepLocalAudioModeForUi(selectedNode) === 'referenceVoiceTts'
                                  ? 'Generates new speech from the text using the connected reference voice audio. Connect text to Input and the voice sample to Reference Audio.'
                                  : 'Music mode runs MusicGen. Connect text for text-to-music, or connect an audio artifact to guide melody and structure while keeping this instruction box as optional extra guidance.'}
                          </p>
                          {getModelStepLocalAudioModeForUi(selectedNode) !== 'referenceVoiceTts' ? <details className="rounded-[18px] border border-white/10 bg-white/5 px-4 py-3">
                            <summary className="cursor-pointer text-xs uppercase tracking-[0.18em] text-slate-400">Advanced AudioCraft settings</summary>
                            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-audio-temperature">Temperature</label><input className="store-input mt-3" id="llm-local-audio-temperature" min="0.01" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftTemperature: Number(event.target.value || 0) || 0 } }))} step="0.05" type="number" value={selectedNode.config?.audiocraftTemperature ?? 1} /></div>
                              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-audio-top-k">Top K</label><input className="store-input mt-3" id="llm-local-audio-top-k" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftTopK: Number(event.target.value || 0) || 0 } }))} step="1" type="number" value={selectedNode.config?.audiocraftTopK ?? 250} /></div>
                              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-audio-top-p">Top P</label><input className="store-input mt-3" id="llm-local-audio-top-p" max="1" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftTopP: Number(event.target.value || 0) || 0 } }))} step="0.05" type="number" value={selectedNode.config?.audiocraftTopP ?? 0} /></div>
                              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-audio-cfg">CFG coefficient</label><input className="store-input mt-3" id="llm-local-audio-cfg" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftCfgCoef: Number(event.target.value || 0) || 0 } }))} step="0.25" type="number" value={selectedNode.config?.audiocraftCfgCoef ?? 3} /></div>
                              <label className="flex items-center gap-3 pt-7 text-sm font-medium text-slate-200" htmlFor="llm-local-audio-two-step"><input checked={Boolean(selectedNode.config?.audiocraftTwoStepCfg)} className="h-4 w-4 accent-cyan-300" id="llm-local-audio-two-step" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftTwoStepCfg: event.target.checked } }))} type="checkbox" />Two-step CFG</label>
                            </div>
                          </details> : null}
                        </div>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM ? (
                        <div className="space-y-4">
                          <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                            This step converts one saved audio artifact into another with RVC. Connect a source audio clip, choose a voice model, and run the step when RVC is installed and ready.
                          </div>
                          <p className="text-xs leading-5 text-slate-400">
                            Keep source clips clean and single-speaker when possible. Advanced RVC controls such as pitch extraction, index rate, and protect tuning stay on the dedicated RVC surface for now.
                          </p>
                        </div>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM ? (
                        <div className="space-y-4">
                          <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                            This step transforms one saved image into another through a local image tool. Connect the target image to the main input. Use Upscayl for enhancement or upscaling, and use FaceFusion when you also connect a Reference Image.
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-[20px] border border-white/10 bg-slate-950/35 px-4 py-3 text-sm leading-6 text-slate-300">
                              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Upscayl</p>
                              <p className="mt-2">Uses the main image input and returns an enhanced or upscaled image.</p>
                            </div>
                            <div className="rounded-[20px] border border-white/10 bg-slate-950/35 px-4 py-3 text-sm leading-6 text-slate-300">
                              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">FaceFusion</p>
                              <p className="mt-2">Uses the main image input as the target image and the Reference Image input as the source face, then returns the transformed image.</p>
                            </div>
                          </div>
                          <p className="text-xs leading-5 text-slate-400">
                            Advanced Upscayl model choices and broader FaceFusion controls stay on the dedicated tool surfaces for now. This step keeps the transformed image pipeline-usable with clear source-image lineage.
                          </p>
                        </div>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE ? (
                        <div className="space-y-4">
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-video-size">Video size</label><select className="store-input mt-3" id="llm-local-video-size" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoSize: event.target.value } }))} value={selectedNode.config?.videoSize || '1280x720'}><option value="832x480">832 x 480</option><option value="1280x720">1280 x 720</option></select></div>
                          <div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-video-steps">Steps</label><input className="store-input mt-3" id="llm-local-video-steps" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, steps: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.steps || 24} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-video-seed">Seed</label><input className="store-input mt-3" id="llm-local-video-seed" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, seed: Number(event.target.value || -1) } }))} type="number" value={selectedNode.config?.seed ?? -1} /></div></div>
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-negative-prompt">Negative prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="llm-local-negative-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, negativePrompt: event.target.value } }))} placeholder="Optional negative prompt for this local video step." value={selectedNode.config?.negativePrompt || ''} /></div>
                          <p className="text-xs leading-5 text-slate-400">Wan local video is intentionally limited to 832x480 or 1280x720 in this first slice. Text input renders text-to-video. Image input renders image-to-video and requires motion guidance in the Instruction box. Missing CUDA-enabled PyTorch runtime support, missing model folders, or low VRAM will be surfaced before or during the run instead of reported as a fake success.</p>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-width">Width</label><input className="store-input mt-3" id="llm-local-width" min="256" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, width: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.width || 832} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-height">Height</label><input className="store-input mt-3" id="llm-local-height" min="256" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, height: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.height || 832} /></div></div>
                          <div className="grid gap-3 sm:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-steps">Steps</label><input className="store-input mt-3" id="llm-local-steps" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, steps: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.steps || 24} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-cfg">CFG scale</label><input className="store-input mt-3" id="llm-local-cfg" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, cfgScale: Number(event.target.value || 0) || 0 } }))} step="0.5" type="number" value={selectedNode.config?.cfgScale || 7} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-seed">Seed</label><input className="store-input mt-3" id="llm-local-seed" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, seed: Number(event.target.value || -1) } }))} type="number" value={selectedNode.config?.seed ?? -1} /></div></div>
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-negative-prompt">Negative prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="llm-local-negative-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, negativePrompt: event.target.value } }))} placeholder="Optional negative prompt for this local image step." value={selectedNode.config?.negativePrompt || ''} /></div>
                        </div>
                      )
                    ) : selectedNode.config?.executionMode !== 'ollama' && getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? (
                      <div className="space-y-3">
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-audio-voice">Voice</label>
                          <input
                            className="store-input mt-3"
                            id="llm-audio-voice"
                            onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audioVoice: event.target.value } }))}
                            placeholder={getCloudAudioVoicePlaceholder(selectedNode.config?.providerId)}
                            value={selectedNode.config?.audioVoice || ''}
                          />
                        </div>
                        <p className="text-xs leading-5 text-slate-400">{getCloudAudioVoiceHelp(selectedNode.config?.providerId)}</p>
                      </div>
                    ) : selectedNode.config?.executionMode !== 'ollama' && getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE ? (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-image-size">Image size</label><select className="store-input mt-3" id="llm-image-size" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, imageSize: event.target.value } }))} value={selectedNode.config?.imageSize || '1024x1024'}><option value="1024x1024">1024 x 1024</option><option value="1536x1024">1536 x 1024</option><option value="1024x1536">1024 x 1536</option><option value="auto">Auto</option></select></div>
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-image-quality">Quality</label><select className="store-input mt-3" id="llm-image-quality" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, imageQuality: event.target.value } }))} value={selectedNode.config?.imageQuality || 'auto'}><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-image-background">Background</label><select className="store-input mt-3" id="llm-image-background" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, imageBackground: event.target.value } }))} value={selectedNode.config?.imageBackground || 'auto'}><option value="auto">Auto</option><option value="opaque">Opaque</option><option value="transparent">Transparent</option></select></div>
                      </div>
                    ) : selectedNode.config?.executionMode !== 'ollama' && getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE ? (
                      <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-video-mode">Mode</label><select className="store-input mt-3" id="llm-video-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoOperationMode: event.target.value } }))} value={selectedNode.config?.videoOperationMode || 'auto'}><option value="auto">Auto from input</option><option value="textToVideo">Text to video</option><option value="imageToVideo">Image to video</option></select></div>
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-video-aspect">Aspect ratio</label><select className="store-input mt-3" id="llm-video-aspect" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoAspectRatio: event.target.value, videoSize: event.target.value === '9:16' ? '720x1280' : '1280x720' } }))} value={selectedNode.config?.videoAspectRatio || (selectedNode.config?.videoSize === '720x1280' ? '9:16' : '16:9')}><option value="16:9">16:9 landscape</option><option value="9:16">9:16 portrait</option></select></div>
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-video-duration">Duration seconds</label><input className="store-input mt-3" id="llm-video-duration" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, durationSeconds: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.durationSeconds || 8} /></div>
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-video-resolution">Resolution</label><select className="store-input mt-3" id="llm-video-resolution" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoResolution: event.target.value } }))} value={getCloudVideoResolutionOptions(selectedNode.config?.providerId).some((option) => option.id === selectedNode.config?.videoResolution) ? selectedNode.config?.videoResolution : '720p'}>{getCloudVideoResolutionOptions(selectedNode.config?.providerId).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div>
                        </div>
                        {supportsCloudVideoNegativePrompt(selectedNode.config?.providerId) ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-cloud-video-negative-prompt">Negative prompt</label><textarea className="store-input mt-3 min-h-[90px] resize-none" id="llm-cloud-video-negative-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, negativePrompt: event.target.value } }))} placeholder="Optional negative prompt for Google Veo." value={selectedNode.config?.negativePrompt || ''} /></div> : null}
                        <p className="text-xs leading-5 text-slate-400">{getCloudVideoHelp(selectedNode.config?.providerId)}</p>
                      </div>
                    ) : null}
                    {getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.LLM_PROMPT ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-system-prompt">System prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="llm-system-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, systemPrompt: event.target.value } }))} placeholder="Optional persistent instruction for this step." value={selectedNode.config?.systemPrompt || ''} /></div> : null}
                  </div>
                ) : null}
                {selectedNode.type === 'graphWorkflow' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-workflow-tool">Execution tool</label>
                      <select
                        className="store-input mt-3"
                        id="graph-workflow-tool"
                        onChange={(event) => {
                          const nextToolId = event.target.value;
                          const nextBindings = getDefaultGraphWorkflowBindings(nextToolId);
                          updateNode(selectedNode.id, (currentNode) => ({
                            ...currentNode,
                            config: {
                              ...currentNode.config,
                              graphWorkflowPresetId: '',
                              inputBindings: nextBindings.inputBindings,
                              outputBindings: nextBindings.outputBindings,
                              toolId: nextToolId,
                              workflowFormat: nextBindings.workflowFormat,
                              workflowSource: 'local',
                              workflowText: '',
                            },
                          }));
                        }}
                        value={selectedGraphWorkflowEffectiveNode?.config?.toolId || graphWorkflowTools[0]?.id || ''}
                      >
                        <option value="">Choose a graph workflow tool</option>
                        {graphWorkflowTools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}
                      </select>
                      <p className="mt-2 text-xs leading-5 text-slate-400">Use this step for graph-native local tools instead of flattening them into the model-step abstraction. Each tool keeps its own workflow contract and honest limitations.</p>
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-4">
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-workflow-preset-select">Saved preset</label>
                      <select className="store-input mt-3" id="graph-workflow-preset-select" onChange={(event) => applyGraphWorkflowPresetToNode(selectedNode.id, event.target.value)} value={selectedNode.config?.workflowSource === 'preset' ? selectedNode.config?.graphWorkflowPresetId || '' : ''}>
                        <option value="">Use node-local workflow config</option>
                        {graphWorkflowPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} - {formatGraphWorkflowPresetSummary(preset)}</option>)}
                      </select>
                      {selectedGraphWorkflowPreset ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs leading-5 text-slate-300">
                          <span className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-3 py-1 text-cyan-100">{formatGraphWorkflowPresetSummary(selectedGraphWorkflowPreset)}</span>
                          <button className="ghost-button" onClick={() => detachGraphWorkflowPreset(selectedNode.id, selectedGraphWorkflowPreset)} type="button">Detach to local copy</button>
                          <button className="ghost-button" onClick={() => deleteGraphWorkflowPreset(selectedGraphWorkflowPreset.id)} type="button">Delete preset</button>
                        </div>
                      ) : (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs leading-5 text-slate-400">
                          <input
                            className="store-input min-w-[220px] flex-1"
                            id="graph-workflow-preset-name"
                            onChange={(event) => setGraphWorkflowPresetName(event.target.value)}
                            placeholder={(selectedNode?.label || 'Graph Workflow') + ' preset'}
                            value={graphWorkflowPresetName}
                          />
                          <button className="ghost-button" disabled={graphWorkflowPresetBusy} onClick={() => saveGraphWorkflowPresetFromNode(selectedNode)} type="button">{graphWorkflowPresetBusy ? 'Saving preset...' : 'Save node config as preset'}</button>
                          <span>{graphWorkflowPresets.length ? 'Choose a saved preset or keep this node local.' : 'No graph workflow presets saved yet.'}</span>
                        </div>
                      )}
                      {graphWorkflowPresetStatus ? (
                        <p className={'mt-3 text-xs leading-5 ' + (graphWorkflowPresetStatus.kind === 'error' ? 'text-amber-200' : graphWorkflowPresetStatus.kind === 'success' ? 'text-emerald-200' : 'text-slate-300')}>
                          {graphWorkflowPresetStatus.message}
                        </p>
                      ) : null}
                    </div>
                    <div className="grid gap-4 xl:grid-cols-2">
                      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-300">
                        <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Graph Contract</p>
                        <p className="mt-3 text-base font-semibold text-white">{selectedGraphWorkflowTool?.name || 'Graph workflow tool'}</p>
                        <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">{formatGraphWorkflowAdapterLabel(selectedGraphWorkflowToolContract)}</p>
                        <p className="mt-3 text-sm leading-6 text-slate-300">{selectedGraphWorkflowToolContract?.notes}</p>
                      </div>
                      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-300">
                        <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Workflow Format</p>
                        <p className="mt-3 text-base font-semibold text-white">{selectedGraphWorkflowToolContract?.workflowFormat?.label || 'Workflow definition'}</p>
                        <p className="mt-3 text-sm leading-6 text-slate-300">{selectedGraphWorkflowToolContract?.workflowFormat?.summary}</p>
                      </div>
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      The main pipeline stays on this canvas. This node marks a clear boundary between the main pipeline and the graph-native sub-workflow that runs inside {selectedGraphWorkflowTool?.name || 'the selected tool'}. Local AI Hub still runs the overall pipeline sequentially and saves explicit typed outputs back into the run folder.
                    </div>
                    <div className="grid gap-3 md:grid-cols-3">
                      {(selectedGraphWorkflowToolContract?.inputPorts || []).map((entry) => (
                        <div className="rounded-[24px] border border-white/10 bg-slate-950/35 px-4 py-4" key={entry.portId}>
                          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Input Boundary</p>
                          <p className="mt-2 text-sm font-semibold text-white">{entry.label}</p>
                          <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">{entry.bindingMode}</p>
                          <p className="mt-3 text-xs leading-5 text-slate-400">{entry.description}</p>
                        </div>
                      ))}
                      {(selectedGraphWorkflowToolContract?.outputPorts || []).map((entry) => (
                        <div className="rounded-[24px] border border-white/10 bg-slate-950/35 px-4 py-4" key={entry.portId}>
                          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Output Boundary</p>
                          <p className="mt-2 text-sm font-semibold text-white">{entry.label}</p>
                          <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">{entry.bindingMode}</p>
                          <p className="mt-3 text-xs leading-5 text-slate-400">{entry.description}</p>
                        </div>
                      ))}
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-workflow-json">Workflow definition</label>
                      <textarea
                        className="store-input mt-3 min-h-[220px] resize-none font-mono text-xs leading-6"
                        id="graph-workflow-json"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            workflowText: event.target.value,
                          },
                        }))}
                        placeholder={selectedGraphWorkflowToolContract?.workflowFormat?.placeholder || 'Paste the workflow definition here.'}
                        value={selectedNode.config?.workflowText || ''}
                      />
                      {selectedGraphWorkflowDefinition ? (
                        <p className={'mt-2 text-xs leading-5 ' + (selectedGraphWorkflowDefinition.ok ? 'text-emerald-200' : 'text-amber-200')}>
                          {selectedGraphWorkflowDefinition.message}
                        </p>
                      ) : null}
                      {selectedGraphWorkflowToolContract?.limitations ? <p className="mt-2 text-xs leading-5 text-slate-400">{selectedGraphWorkflowToolContract.limitations}</p> : null}
                    </div>
                    {selectedGraphWorkflowToolContract?.workflowImportSupported ? (
                      <>
                        <div className="grid gap-4 xl:grid-cols-2">
                          <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Pipeline Text to Graph Boundary</p>
                            <div className="mt-3 space-y-3">
                              <div>
                                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-text-node">Workflow node</label>
                                {selectedGraphWorkflowDefinition?.ok ? (
                                  <select
                                    className="store-input mt-3"
                                    id="graph-text-node"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { field: '', nodeId: event.target.value })}
                                    value={graphWorkflowTextBinding?.nodeId || ''}
                                  >
                                    <option value="">Leave text input unused</option>
                                    {graphWorkflowNodeOptions.map((entry) => <option key={entry.id} value={entry.id}>{formatGraphWorkflowNodeLabel(entry)}</option>)}
                                  </select>
                                ) : (
                                  <input
                                    className="store-input mt-3"
                                    id="graph-text-node"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { nodeId: event.target.value })}
                                    placeholder="For example: 6"
                                    value={graphWorkflowTextBinding?.nodeId || ''}
                                  />
                                )}
                              </div>
                              <div>
                                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-text-field">Workflow field</label>
                                {graphWorkflowTextFieldOptions.length ? (
                                  <select
                                    className="store-input mt-3"
                                    id="graph-text-field"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { field: event.target.value })}
                                    value={graphWorkflowTextBinding?.field || ''}
                                  >
                                    <option value="">Choose a workflow field</option>
                                    {graphWorkflowTextFieldOptions.map((field) => <option key={field} value={field}>{field}</option>)}
                                  </select>
                                ) : (
                                  <input
                                    className="store-input mt-3"
                                    id="graph-text-field"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { field: event.target.value })}
                                    placeholder="For example: text"
                                    value={graphWorkflowTextBinding?.field || ''}
                                  />
                                )}
                              </div>
                            </div>
                            <p className="mt-3 text-xs leading-5 text-slate-400">Leave this mapping blank when the imported graph does not consume the main pipeline Text port.</p>
                          </div>
                          <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Pipeline Image to Graph Boundary</p>
                            <div className="mt-3 space-y-3">
                              <div>
                                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-image-node">Workflow node</label>
                                {selectedGraphWorkflowDefinition?.ok ? (
                                  <select
                                    className="store-input mt-3"
                                    id="graph-image-node"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'image', { field: '', nodeId: event.target.value })}
                                    value={graphWorkflowImageBinding?.nodeId || ''}
                                  >
                                    <option value="">Leave image input unused</option>
                                    {graphWorkflowNodeOptions.map((entry) => <option key={entry.id} value={entry.id}>{formatGraphWorkflowNodeLabel(entry)}</option>)}
                                  </select>
                                ) : (
                                  <input
                                    className="store-input mt-3"
                                    id="graph-image-node"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'image', { nodeId: event.target.value })}
                                    placeholder="For example: 12"
                                    value={graphWorkflowImageBinding?.nodeId || ''}
                                  />
                                )}
                              </div>
                              <div>
                                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-image-field">Workflow field</label>
                                {graphWorkflowImageFieldOptions.length ? (
                                  <select
                                    className="store-input mt-3"
                                    id="graph-image-field"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'image', { field: event.target.value })}
                                    value={graphWorkflowImageBinding?.field || ''}
                                  >
                                    <option value="">Choose a workflow field</option>
                                    {graphWorkflowImageFieldOptions.map((field) => <option key={field} value={field}>{field}</option>)}
                                  </select>
                                ) : (
                                  <input
                                    className="store-input mt-3"
                                    id="graph-image-field"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'image', { field: event.target.value })}
                                    placeholder="For example: image"
                                    value={graphWorkflowImageBinding?.field || ''}
                                  />
                                )}
                              </div>
                            </div>
                            <p className="mt-3 text-xs leading-5 text-slate-400">When this port is connected, Local AI Hub uploads the incoming image to the selected graph tool before the workflow runs.</p>
                          </div>
                        </div>
                        <div className="grid gap-4 xl:grid-cols-2">
                          {(selectedGraphWorkflowToolContract?.outputPorts || []).map((outputPort) => {
                            const outputBinding = outputPort.portId === 'video' ? graphWorkflowVideoOutputBinding : graphWorkflowImageOutputBinding;
                            const outputNodeOptions = outputPort.portId === 'video' ? graphWorkflowVideoOutputNodeOptions : graphWorkflowImageOutputNodeOptions;
                            const outputHint = outputPort.portId === 'video' ? 'video artifact' : 'image artifact';
                            const outputOptionSuffix = outputPort.portId === 'video' ? ' (likely video output)' : ' (likely image output)';
                            return (
                              <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4" key={outputPort.portId}>
                                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Graph Output Boundary to Main Pipeline</p>
                                <div className="mt-3">
                                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`graph-output-node-${outputPort.portId}`}>{outputPort.label}</label>
                                  {selectedGraphWorkflowDefinition?.ok ? (
                                    <select
                                      className="store-input mt-3"
                                      id={`graph-output-node-${outputPort.portId}`}
                                      onChange={(event) => updateGraphWorkflowOutputBinding(selectedNode.id, outputPort.portId, { nodeId: event.target.value })}
                                      value={outputBinding?.nodeId || ''}
                                    >
                                      <option value="">Choose the {outputPort.portId} output node</option>
                                      {(outputNodeOptions.length ? outputNodeOptions : graphWorkflowNodeOptions).map((entry) => <option key={`${outputPort.portId}-${entry.id}`} value={entry.id}>{formatGraphWorkflowNodeLabel(entry)}{outputPort.portId === 'video' ? (entry.videoOutputCandidate ? outputOptionSuffix : '') : (entry.imageOutputCandidate ? outputOptionSuffix : '')}</option>)}
                                    </select>
                                  ) : (
                                    <input
                                      className="store-input mt-3"
                                      id={`graph-output-node-${outputPort.portId}`}
                                      onChange={(event) => updateGraphWorkflowOutputBinding(selectedNode.id, outputPort.portId, { nodeId: event.target.value })}
                                      placeholder="For example: 19"
                                      value={outputBinding?.nodeId || ''}
                                    />
                                  )}
                                </div>
                                <p className="mt-3 text-xs leading-5 text-slate-400">Choose the node that emits the {outputHint} back into the main pipeline. Local AI Hub keeps that artifact explicit and typed after the graph step finishes.</p>
                              </div>
                            );
                          })}
                        </div>
                        {selectedGraphWorkflowDefinition?.ok ? (
                          <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Parsed Workflow Nodes</p>
                            <div className="mt-3 space-y-2 max-h-[260px] overflow-auto pr-1">
                              {graphWorkflowNodeOptions.slice(0, 18).map((entry) => (
                                <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3" key={entry.id}>
                                  <p className="text-sm font-medium text-white">{formatGraphWorkflowNodeLabel(entry)}</p>
                                  <p className="mt-1 text-xs leading-5 text-slate-400">
                                    {entry.inputFields.length ? 'Inputs: ' + entry.inputFields.join(', ') : 'No editable inputs detected.'}
                                  </p>
                                  {entry.boundaryFieldOptions?.text?.length ? <p className="mt-1 text-xs leading-5 text-cyan-100/90">Text-friendly fields: {entry.boundaryFieldOptions.text.slice(0, 4).join(', ')}</p> : null}
                                  {entry.boundaryFieldOptions?.image?.length ? <p className="mt-1 text-xs leading-5 text-sky-100/90">Image-friendly fields: {entry.boundaryFieldOptions.image.slice(0, 4).join(', ')}</p> : null}
                                  {entry.imageOutputCandidate ? <p className="mt-1 text-xs leading-5 text-emerald-200">Likely image output node</p> : null}
                                  {entry.videoOutputCandidate ? <p className="mt-1 text-xs leading-5 text-fuchsia-200">Likely video output node</p> : null}
                                </div>
                              ))}
                            </div>
                            {graphWorkflowNodeOptions.length > 18 ? <p className="mt-3 text-xs leading-5 text-slate-500">Showing the first 18 parsed nodes from the imported workflow.</p> : null}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div className="rounded-[24px] border border-amber-300/20 bg-amber-300/10 px-4 py-4 text-sm leading-6 text-amber-100">
                        {selectedGraphWorkflowToolContract?.executionBlockedMessage}
                      </div>
                    )}
                  </div>
                ) : null}
                {selectedNode.type === 'planningPacket' ? (
                  <div className="space-y-4">
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      This node turns upstream script or transcript artifacts plus your planning context into a reusable Planning Packet. Connect source text when you have it, then fill in the goal, constraints, style, readiness notes, and desired output shape.
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-schema">Planning schema</label>
                      <select className="store-input mt-3" id="planning-schema" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, schemaId: event.target.value } }))} value={selectedNode.config?.schemaId || DEFAULT_PLANNING_SCHEMA_ID}>
                        {PLANNING_SCHEMA_OPTIONS.map((schema) => <option key={schema.id} value={schema.id}>{schema.familyLabel ? schema.familyLabel + ' - ' + schema.label : schema.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-goal">Task goal</label>
                      <textarea className="store-input mt-3 min-h-[120px] resize-none" id="planning-goal" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, goal: event.target.value } }))} placeholder="Describe what the plan should accomplish." value={selectedNode.config?.goal || ''} />
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-source-summary">Manual source summary</label>
                      <textarea className="store-input mt-3 min-h-[120px] resize-none" id="planning-source-summary" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, sourceSummary: event.target.value } }))} placeholder="Optional fallback when your source is not connected as text." value={selectedNode.config?.sourceSummary || ''} />
                    </div>
                    <div className="grid gap-4 xl:grid-cols-2">
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-constraints">Constraints</label>
                        <textarea className="store-input mt-3 min-h-[120px] resize-none" id="planning-constraints" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, constraintsText: event.target.value } }))} placeholder="One line per constraint." value={selectedNode.config?.constraintsText || ''} />
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-style-policy">Style / policy context</label>
                        <textarea className="store-input mt-3 min-h-[120px] resize-none" id="planning-style-policy" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, stylePolicyText: event.target.value } }))} placeholder="One line per style or policy note." value={selectedNode.config?.stylePolicyText || ''} />
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-tools">Available tools</label>
                        <textarea className="store-input mt-3 min-h-[120px] resize-none" id="planning-tools" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, availableToolsText: event.target.value } }))} placeholder="Optional list of downstream tools or surfaces." value={selectedNode.config?.availableToolsText || ''} />
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-readiness">Readiness / hardware notes</label>
                        <textarea className="store-input mt-3 min-h-[120px] resize-none" id="planning-readiness" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, readinessNotesText: event.target.value } }))} placeholder="One line per readiness note." value={selectedNode.config?.readinessNotesText || ''} />
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-output-notes">Desired output notes</label>
                        <textarea className="store-input mt-3 min-h-[120px] resize-none" id="planning-output-notes" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, desiredOutputNotes: event.target.value } }))} placeholder="What shape or emphasis should the plan have?" value={selectedNode.config?.desiredOutputNotes || ''} />
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-risk-notes">Risk notes</label>
                        <textarea className="store-input mt-3 min-h-[120px] resize-none" id="planning-risk-notes" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, riskNotesText: event.target.value } }))} placeholder="One line per risk note." value={selectedNode.config?.riskNotesText || ''} />
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-uncertainty">Uncertainty flags</label>
                        <textarea className="store-input mt-3 min-h-[120px] resize-none" id="planning-uncertainty" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, uncertaintyFlagsText: event.target.value } }))} placeholder="One line per open uncertainty." value={selectedNode.config?.uncertaintyFlagsText || ''} />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planning-context">Additional working notes</label>
                      <textarea className="store-input mt-3 min-h-[140px] resize-none" id="planning-context" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, additionalContext: event.target.value } }))} placeholder="Optional extra context for the planner." value={selectedNode.config?.additionalContext || ''} />
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'planner' ? (
                  <div className="space-y-4">
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      This node is the structured reasoning layer for planning. It consumes a Planning Packet, runs the selected model inside the chosen planning schema contract, and emits a typed Plan artifact.
                    </div>
                    <ModelTargetFields connectedProviders={connectedProviders} executionModeKey="executionMode" modelOptions={modelOptionsByNodeId[selectedNode.id]} modelsBusy={modelsBusyNodeId === selectedNode.id} node={selectedNode} onRefreshModels={refreshNodeModels} onUpdateNode={updateNode} providerIdKey="providerId" />
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planner-schema">Planning schema</label>
                      <select className="store-input mt-3" id="planner-schema" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, schemaId: event.target.value } }))} value={selectedNode.config?.schemaId || DEFAULT_PLANNING_SCHEMA_ID}>
                        {PLANNING_SCHEMA_OPTIONS.map((schema) => <option key={schema.id} value={schema.id}>{schema.familyLabel ? schema.familyLabel + ' - ' + schema.label : schema.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planner-guidance">Planner guidance</label>
                      <textarea className="store-input mt-3 min-h-[140px] resize-none" id="planner-guidance" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, instruction: event.target.value } }))} placeholder="Optional extra guidance for how the planner should approach the packet." value={selectedNode.config?.instruction || ''} />
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="planner-system-prompt">System prompt</label>
                      <textarea className="store-input mt-3 min-h-[120px] resize-none" id="planner-system-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, systemPrompt: event.target.value } }))} placeholder="Optional planner-specific system instruction." value={selectedNode.config?.systemPrompt || ''} />
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'planScenes' ? (
                  <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                    This node turns a structured Plan into an ordered text collection using that plan's schema adapter. Scene plans produce scene prompt drafts; audio prompt plans produce ordered audio prompts with section metadata; video prompt plans produce ordered video prompts with duration, motion, continuity, and reference-frame metadata.
                  </div>
                ) : null}

                {selectedNode.type === 'validation' ? (
                  <div className="space-y-4">
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="validation-mode">Validation mode</label><select className="store-input mt-3" id="validation-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, mode: event.target.value } }))} value={selectedNode.config?.mode || 'user'}><option value="user">User approval</option><option value="llm">LLM validator</option></select></div>
                    {selectedNode.config?.mode === 'llm' ? (
                      <>
                        <ModelTargetFields connectedProviders={connectedProviders} executionModeKey="llmExecutionMode" modelOptions={modelOptionsByNodeId[selectedNode.id]} modelsBusy={modelsBusyNodeId === selectedNode.id} node={selectedNode} onRefreshModels={refreshNodeModels} onUpdateNode={updateNode} providerIdKey="providerId" />
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="validation-ruleset">Ruleset / rubric</label><textarea className="store-input mt-3 min-h-[140px] resize-none" id="validation-ruleset" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, ruleset: event.target.value } }))} placeholder="Describe what should count as pass versus fail." value={selectedNode.config?.ruleset || ''} /></div>
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="validation-system-prompt">System prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="validation-system-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, systemPrompt: event.target.value } }))} placeholder="Optional validator instruction." value={selectedNode.config?.systemPrompt || ''} /></div>
                      </>
                    ) : (
                      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">This run will pause at the validation node, show the connected artifact preview when possible, and wait for your pass or fail decision. Ordered collections are reviewed as whole collections in this pass.</div>
                    )}
                  </div>
                ) : null}

                {selectedNode.type === 'retryLoop' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="retry-loop-target">Retry from</label>
                      <select
                        className="store-input mt-3"
                        id="retry-loop-target"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            retryTargetNodeId: event.target.value,
                          },
                        }))}
                        value={selectedNode.config?.retryTargetNodeId || ''}
                      >
                        <option value="">Choose an earlier step</option>
                        {retryLoopTargetOptions.map((node) => (
                          <option key={node.id} value={node.id}>{node.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="retry-loop-max">Max attempts</label>
                      <input
                        className="store-input mt-3"
                        id="retry-loop-max"
                        max={PIPELINE_RETRY_LOOP_MAX_ATTEMPTS}
                        min="2"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            maxAttempts: Number(event.target.value || 0) || 0,
                          },
                        }))}
                        type="number"
                        value={selectedNode.config?.maxAttempts || 3}
                      />
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="retry-loop-repeat">Early stop rule</label>
                      <select
                        className="store-input mt-3"
                        id="retry-loop-repeat"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            stopWhenRetryArtifactRepeats: event.target.value === 'repeat',
                          },
                        }))}
                        value={selectedNode.config?.stopWhenRetryArtifactRepeats ? 'repeat' : 'limit-only'}
                      >
                        <option value="limit-only">Only stop on Complete or the attempt limit</option>
                        <option value="repeat">Also stop if the Retry artifact repeats</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="retry-loop-stop-action">When Retry is still active</label>
                      <select
                        className="store-input mt-3"
                        id="retry-loop-stop-action"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            retryTerminationAction: event.target.value === 'complete' ? 'complete' : 'fail',
                          },
                        }))}
                        value={selectedNode.config?.retryTerminationAction === 'complete' ? 'complete' : 'fail'}
                      >
                        <option value="fail">Stop the run with an error</option>
                        <option value="complete">Exit the loop and keep the Retry artifact</option>
                      </select>
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Connect the Complete input to the branch that should exit the loop and the Retry input to the branch that should trigger another attempt. {selectedRetryLoopMeta?.retryEntryMode === 'branchMerge'
                        ? 'Later attempts feed the retry artifact back through the target Branch Merge automatically.'
                        : selectedRetryLoopMeta?.retryEntryMode === 'inputPort'
                          ? 'Later attempts feed the retry artifact back into ' + selectedRetryLoopMeta.retryTargetLabel + ' through ' + (selectedRetryLoopMeta.retryEntryPortLabel || 'its selected input') + '.'
                          : selectedRetryLoopMeta?.retryEntryLimitation || 'Later attempts rerun the selected earlier step using its connected inputs when there is not one clear retry re-entry port.'} {selectedNode.config?.stopWhenRetryArtifactRepeats
                        ? 'Local AI Hub also stops early if the Retry branch produces the same artifact twice in a row.'
                        : 'By default, Local AI Hub keeps retrying until the Complete branch wins or the attempt limit is reached.'} {selectedNode.config?.retryTerminationAction === 'complete'
                        ? 'When a stop rule triggers while Retry is still active, the loop exits and keeps the latest Retry artifact.'
                        : 'When a stop rule triggers while Retry is still active, the run stops with a plain-English error.'}
                    </div>
                  </div>
                ) : null}

                                {selectedNode.type === 'collectionBuilder' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-builder-order">When an existing collection is connected</label>
                      <select
                        className="store-input mt-3"
                        id="collection-builder-order"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            insertionMode: event.target.value === 'prepend' ? 'prepend' : 'append',
                          },
                        }))}
                        value={selectedNode.config?.insertionMode === 'prepend' ? 'prepend' : 'append'}
                      >
                        <option value="append">Append new items after it</option>
                        <option value="prepend">Place new items before it</option>
                      </select>
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Connect one or more same-type single artifacts to the Items input in the order you want to keep. The optional Existing Collection input lets you extend a saved collection explicitly instead of relying on hidden automatic mapping.
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'collectionAccumulator' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-accumulator-target">Target accepted items</label>
                      <input
                        className="store-input mt-3"
                        id="collection-accumulator-target"
                        min="1"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            targetCount: Math.max(1, Number(event.target.value || 0) || 1),
                          },
                        }))}
                        type="number"
                        value={Math.max(1, Number(selectedNode.config?.targetCount || 3) || 3)}
                      />
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Connect one or more accepted branches into this step, then connect its Collection output directly into a Retry Loop Complete input. While the target has not been reached yet, Local AI Hub preserves each accepted item in order and the connected Retry Loop keeps collecting without treating that stored state as a finished exit. Once the target count is reached, this step emits one real ordered collection onward.
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'collectionMap' ? (() => {
                  const collectionMapOperationId = selectedCollectionMapMapping?.operationId || PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
                  const collectionMapExecutionMode = selectedNode.config?.executionMode === 'graphWorkflow' ? 'graphWorkflow' : selectedNode.config?.executionMode === 'localTool' ? 'localTool' : 'cloud';
                  const showCollectionMapImageGenerationFields = collectionMapOperationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
                  const showCollectionMapAudioGenerationFields = collectionMapOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE;
                  const showCollectionMapVideoGenerationFields = collectionMapOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE;
                  const showCollectionMapLocalImageGenerationFields = showCollectionMapImageGenerationFields && collectionMapExecutionMode === 'localTool';
                  const showCollectionMapCloudImageGenerationFields = showCollectionMapImageGenerationFields && collectionMapExecutionMode === 'cloud';
                  const showCollectionMapCloudVideoGenerationFields = showCollectionMapVideoGenerationFields && collectionMapExecutionMode === 'cloud';
                  const selectedCollectionMapToolId = String(selectedNode.config?.toolId || '').trim().toLowerCase();
                  const collectionMapAudioMode = normalizeAudioModeForLocalTool(selectedCollectionMapToolId || 'audiocraft-webui', selectedNode.config?.audioMode);
                  const showCollectionMapChatterboxReferenceVoiceFields = showCollectionMapAudioGenerationFields && collectionMapExecutionMode === 'localTool' && selectedCollectionMapToolId === 'chatterbox-tts';
                  const showCollectionMapAudiocraftItemMode = showCollectionMapAudioGenerationFields && collectionMapExecutionMode === 'localTool' && !showCollectionMapChatterboxReferenceVoiceFields && (!selectedCollectionMapToolId || selectedCollectionMapToolId === 'audiocraft-webui');
                  const collectionMapAudiocraftItemMode = selectedNode.config?.audiocraftItemMode === 'sequentialContinuation' ? 'sequentialContinuation' : 'independent';
                  const showCollectionMapAudiocraftChainFields = showCollectionMapAudiocraftItemMode && collectionMapAudiocraftItemMode === 'sequentialContinuation';
                  const showCollectionMapWanVideoItemMode = showCollectionMapVideoGenerationFields && collectionMapExecutionMode === 'localTool' && (!selectedCollectionMapToolId || selectedCollectionMapToolId === 'wan21-webui');
                  const collectionMapVideoItemMode = selectedNode.config?.videoItemMode === 'sequentialLastFrame' ? 'sequentialLastFrame' : 'independent';
                  const showCollectionMapVideoChainFields = showCollectionMapWanVideoItemMode && collectionMapVideoItemMode === 'sequentialLastFrame';
                  const selectedCollectionMapProviderId = String(selectedNode.config?.providerId || '').trim().toLowerCase();
                  const showCollectionMapCloudVideoChainToggle = showCollectionMapCloudVideoGenerationFields && supportsCollectionMapCloudVideoChaining(selectedCollectionMapProviderId);
                  const showCollectionMapCloudVideoChainFields = showCollectionMapCloudVideoChainToggle && collectionMapVideoItemMode === 'sequentialLastFrame';
                  const showCollectionMapImageTransformFields = collectionMapOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM;
                  const showCollectionMapTranscriptionFields = collectionMapOperationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE;
                  const showCollectionMapAudioTransformFields = collectionMapOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM;
                  const showCollectionMapImageAnalysisFields = collectionMapOperationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE;
                  const showCollectionMapLocalModelField = collectionMapExecutionMode === 'localTool' && !showCollectionMapChatterboxReferenceVoiceFields;
                  const showCollectionMapCloudModelField = collectionMapExecutionMode === 'cloud';
                  const showCollectionMapInstructionField = showCollectionMapImageGenerationFields || (showCollectionMapAudioGenerationFields && !showCollectionMapChatterboxReferenceVoiceFields) || showCollectionMapVideoGenerationFields || showCollectionMapAudioTransformFields || (showCollectionMapImageAnalysisFields && collectionMapExecutionMode === 'cloud');
                  const collectionMapTransformSubtypeOptions = getImageTransformSubtypeOptions(selectedNode.config?.toolId || 'upscayl');
                  const collectionMapInstructionValue = getCollectionMapInstructionValue(selectedNode, collectionMapOperationId);
                  const collectionMapModelOptions = modelOptionsByNodeId[selectedNode.id] || [];
                  const collectionMapFailureMode = selectedNode.config?.failureMode === 'partial' || selectedNode.config?.partialSuccess?.enabled ? 'partial' : 'fail-fast';
                  const perItemValidation = selectedNode.config?.perItemValidation || {};
                  const perItemValidationEnabled = Boolean(perItemValidation.enabled);
                  const perItemValidationOutputKind = selectedCollectionMapMapping?.outputKind || 'image';
                  const perItemValidationOutputLabel = PIPELINE_PORT_KIND_LABELS[perItemValidationOutputKind] || perItemValidationOutputKind;
                  const perItemValidationLlmSupported = perItemValidationOutputKind === 'text' || perItemValidationOutputKind === 'image' || perItemValidationOutputKind === 'file';
                  const updatePerItemValidation = (patch) => updateNode(selectedNode.id, (currentNode) => ({
                    ...currentNode,
                    config: {
                      ...currentNode.config,
                      perItemValidation: {
                        enabled: false,
                        mode: 'llm',
                        llmExecutionMode: 'cloud',
                        providerId: '',
                        model: '',
                        ruleset: '',
                        systemPrompt: '',
                        maxAttempts: 2,
                        retryInstruction: '',
                        failMode: 'fail-fast',
                        ...(currentNode.config?.perItemValidation || {}),
                        ...patch,
                      },
                    },
                  }));
                  return (
                  <div className="space-y-4">
                    <div className="grid gap-4 xl:grid-cols-2">
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-mapping">Mapping</label>
                        <select className="store-input mt-3" id="collection-map-mapping" onChange={(event) => updateCollectionMapMapping(selectedNode.id, event.target.value)} value={selectedCollectionMapMapping?.id || selectedNode.config?.mappingId || 'textToImage'}>
                          {COLLECTION_MAP_MAPPING_OPTIONS.map((mapping) => <option key={mapping.id} value={mapping.id}>{mapping.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-mode">Execution mode</label>
                        <select className="store-input mt-3" id="collection-map-mode" onChange={(event) => updateCollectionMapExecutionMode(selectedNode.id, event.target.value)} value={collectionMapExecutionMode}>
                          <option disabled={selectedCollectionMapMapping ? !selectedCollectionMapMapping.modes.includes('cloud') : false} value="cloud">Cloud provider</option>
                          <option disabled={selectedCollectionMapMapping ? !selectedCollectionMapMapping.modes.includes('localTool') : false} value="localTool">Local tool</option>
                          <option disabled={selectedCollectionMapMapping ? !selectedCollectionMapMapping.modes.includes('graphWorkflow') : false} value="graphWorkflow">Configured graph workflow</option>
                        </select>
                      </div>
                    </div>
                    {!showCollectionMapChatterboxReferenceVoiceFields ? <PromptStyleSelector id="collection-map-prompt-style" onChange={(promptStyleId) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, promptStyleId } }))} promptStyles={promptStyles} targetKind={getPromptStyleTargetKindForCollectionMap(selectedCollectionMapMapping)} value={selectedNode.config?.promptStyleId || ''} /> : null}
                    {collectionMapExecutionMode === 'graphWorkflow' ? (
                      <div className="space-y-4">
                        <div className="rounded-[24px] border border-cyan-300/20 bg-cyan-300/10 px-4 py-3 text-sm leading-6 text-cyan-100">Use a real graph workflow boundary here. Paste the workflow JSON, map the Text input, and choose a final Image output node; Local AI Hub will run that workflow once per collection item.</div>
                        <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-4">
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-graph-preset">Graph workflow preset</label>
                          <select className="store-input mt-3" id="collection-map-graph-preset" onChange={(event) => applyGraphWorkflowPresetToNode(selectedNode.id, event.target.value)} value={selectedNode.config?.workflowSource === 'preset' ? selectedNode.config?.graphWorkflowPresetId || '' : ''}>
                            <option value="">Use configured workflow below</option>
                            {compatibleCollectionMapGraphWorkflowPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} - {formatGraphWorkflowPresetSummary(preset)}</option>)}
                          </select>
                          {compatibleCollectionMapGraphWorkflowPresets.length ? null : <p className="mt-2 text-xs leading-5 text-amber-200">No compatible text-to-image graph workflow presets are saved yet.</p>}
                          {collectionMapSelectedGraphWorkflowPreset ? (
                            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs leading-5 text-slate-300">
                              <span className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-3 py-1 text-cyan-100">{formatGraphWorkflowPresetSummary(collectionMapSelectedGraphWorkflowPreset)}</span>
                              <button className="ghost-button" onClick={() => detachGraphWorkflowPreset(selectedNode.id, collectionMapSelectedGraphWorkflowPreset)} type="button">Detach to configured workflow</button>
                            </div>
                          ) : null}
                        </div>
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-graph-tool">Graph workflow tool</label><select className="store-input mt-3" id="collection-map-graph-tool" onChange={(event) => updateNode(selectedNode.id, (currentNode) => { const nextToolId = event.target.value; const nextBindings = getDefaultGraphWorkflowBindings(nextToolId); return { ...currentNode, config: { ...currentNode.config, graphWorkflowPresetId: '', workflowSource: 'local', graphWorkflowToolId: nextToolId, inputBindings: nextBindings.inputBindings, outputBindings: nextBindings.outputBindings, toolId: '', workflowFormat: nextBindings.workflowFormat, workflowText: '' } }; })} value={selectedNode.config?.graphWorkflowToolId || graphWorkflowTools[0]?.id || ''}><option value="">Choose a graph workflow tool</option>{graphWorkflowTools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select><p className="mt-2 text-xs leading-5 text-slate-500">ComfyUI and InvokeAI stay graph-native. They are only usable here after this workflow boundary is configured.</p></div>
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-graph-json">Workflow definition</label><textarea className="store-input mt-3 min-h-[180px] resize-none font-mono text-xs leading-6" id="collection-map-graph-json" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, workflowText: event.target.value } }))} placeholder={collectionMapGraphWorkflowContract?.workflowFormat?.placeholder || 'Paste the workflow definition here.'} value={selectedNode.config?.workflowText || ''} />{collectionMapGraphWorkflowDefinition ? <p className={'mt-2 text-xs leading-5 ' + (collectionMapGraphWorkflowDefinition.ok ? 'text-emerald-200' : 'text-amber-200')}>{collectionMapGraphWorkflowDefinition.message}</p> : null}</div>
                        <div className="grid gap-4 xl:grid-cols-2">
                          <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4"><p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Text Input Boundary</p><div className="mt-3 space-y-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-graph-text-node">Workflow node</label>{collectionMapGraphWorkflowDefinition?.ok ? <select className="store-input mt-3" id="collection-map-graph-text-node" onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { field: '', nodeId: event.target.value })} value={collectionMapGraphWorkflowTextBinding?.nodeId || ''}><option value="">Choose the text input node</option>{collectionMapGraphWorkflowNodeOptions.map((entry) => <option key={entry.id} value={entry.id}>{formatGraphWorkflowNodeLabel(entry)}</option>)}</select> : <input className="store-input mt-3" id="collection-map-graph-text-node" onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { nodeId: event.target.value })} placeholder="For example: 6" value={collectionMapGraphWorkflowTextBinding?.nodeId || ''} />}</div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-graph-text-field">Workflow field</label>{collectionMapGraphWorkflowTextFieldOptions.length ? <select className="store-input mt-3" id="collection-map-graph-text-field" onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { field: event.target.value })} value={collectionMapGraphWorkflowTextBinding?.field || ''}><option value="">Choose a prompt field</option>{collectionMapGraphWorkflowTextFieldOptions.map((field) => <option key={field} value={field}>{field}</option>)}</select> : <input className="store-input mt-3" id="collection-map-graph-text-field" onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { field: event.target.value })} placeholder="For example: text" value={collectionMapGraphWorkflowTextBinding?.field || ''} />}</div></div></div>
                          <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4"><p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Image Output Boundary</p><div className="mt-3"><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-graph-image-output">Workflow node</label>{collectionMapGraphWorkflowDefinition?.ok ? <select className="store-input mt-3" id="collection-map-graph-image-output" onChange={(event) => updateGraphWorkflowOutputBinding(selectedNode.id, 'image', { nodeId: event.target.value })} value={collectionMapGraphWorkflowImageOutputBinding?.nodeId || ''}><option value="">Choose the image output node</option>{(collectionMapGraphWorkflowImageOutputNodeOptions.length ? collectionMapGraphWorkflowImageOutputNodeOptions : collectionMapGraphWorkflowNodeOptions).map((entry) => <option key={entry.id} value={entry.id}>{formatGraphWorkflowNodeLabel(entry)}{entry.imageOutputCandidate ? ' (likely image output)' : ''}</option>)}</select> : <input className="store-input mt-3" id="collection-map-graph-image-output" onChange={(event) => updateGraphWorkflowOutputBinding(selectedNode.id, 'image', { nodeId: event.target.value })} placeholder="For example: 19" value={collectionMapGraphWorkflowImageOutputBinding?.nodeId || ''} />}</div><p className="mt-3 text-xs leading-5 text-slate-400">Choose a final node that saves or returns one image artifact.</p></div>
                        </div>
                        {collectionMapGraphWorkflowSupport ? <p className={'text-xs leading-5 ' + (collectionMapGraphWorkflowSupport.usable ? 'text-emerald-200' : 'text-amber-200')}>{collectionMapGraphWorkflowSupport.message}</p> : null}
                      </div>
                    ) : collectionMapExecutionMode === 'localTool' ? (
                      <div className="space-y-4">
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-tool">Local backend</label><select className="store-input mt-3" id="collection-map-tool" onChange={(event) => updateNode(selectedNode.id, (currentNode) => { const nextToolId = event.target.value; const currentAudioMode = currentNode.config?.audioMode; return { ...currentNode, config: { ...currentNode.config, audioMode: nextToolId === 'chatterbox-tts' ? 'referenceVoiceTts' : currentAudioMode === 'referenceVoiceTts' ? 'music' : currentAudioMode, audiocraftItemMode: nextToolId === 'chatterbox-tts' ? 'independent' : currentNode.config?.audiocraftItemMode, model: '', toolId: nextToolId } }; })} value={selectedNode.config?.toolId || ''}><option value="">Auto / required local backend</option>{collectionMapLocalTools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></div>
                        {showCollectionMapChatterboxReferenceVoiceFields ? <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-chatterbox-mode">Audio mode</label><select className="store-input mt-3" disabled id="collection-map-chatterbox-mode" value="referenceVoiceTts"><option value="referenceVoiceTts">Reference Voice TTS</option></select></div><div className="rounded-[18px] border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-50/90">Only clone voices you have permission to use.</div></div><p className="text-xs leading-5 text-slate-400">Reference Voice TTS uses one shared Reference Audio input for the whole collection.</p></div> : null}
                        {showCollectionMapLocalModelField ? (
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-model-local">{getCollectionMapModelFieldLabel(collectionMapOperationId)}</label><input className="store-input mt-3" id="collection-map-model-local" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, model: event.target.value, analysisMode: showCollectionMapImageAnalysisFields ? event.target.value || 'clip' : currentNode.config?.analysisMode } }))} placeholder={getCollectionMapModelPlaceholder(collectionMapOperationId)} value={selectedNode.config?.model || (showCollectionMapImageAnalysisFields ? selectedNode.config?.analysisMode || 'clip' : '')} /><div className="mt-3 flex flex-wrap items-center gap-3"><button className="ghost-button" disabled={modelsBusyNodeId === selectedNode.id} onClick={() => refreshNodeModels(selectedNode)} type="button">{modelsBusyNodeId === selectedNode.id ? 'Refreshing...' : getCollectionMapRefreshLabel(collectionMapOperationId)}</button><span className="text-xs text-slate-500">{showCollectionMapAudioGenerationFields ? 'Loads downloaded AudioCraft snapshots from the selected tool.' : showCollectionMapAudioTransformFields ? 'Loads local RVC voice models from the selected tool.' : showCollectionMapImageTransformFields ? 'Loads downloaded Upscayl model sets from the selected tool.' : showCollectionMapTranscriptionFields ? 'Shows local Whisper model size options.' : showCollectionMapImageAnalysisFields ? 'Shows WebUI interrogation modes.' : showCollectionMapVideoGenerationFields ? 'Loads local Wan model folders from the selected video backend.' : 'Loads local checkpoints from the selected image backend.'}</span></div>{collectionMapModelOptions.length ? <div className="mt-3 grid gap-2">{collectionMapModelOptions.slice(0, 8).map((model) => (<button className={'rounded-2xl border px-3 py-3 text-left transition ' + (String((showCollectionMapImageAnalysisFields ? selectedNode.config?.analysisMode || selectedNode.config?.model : selectedNode.config?.model) || '').trim().toLowerCase() === String(model.id || '').trim().toLowerCase() ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-50' : 'border-white/10 bg-white/[0.03] text-slate-200 hover:border-cyan-300/20 hover:bg-white/10')} key={model.id} onClick={() => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, analysisMode: showCollectionMapImageAnalysisFields ? model.id : currentNode.config?.analysisMode, model: model.id } }))} type="button"><p className="text-sm font-medium text-white">{model.label || model.id}</p>{buildModelOptionDetail(model) ? <p className="mt-1 text-xs leading-5 text-slate-400">{buildModelOptionDetail(model)}</p> : null}</button>))}</div> : null}</div>
                        ) : null}
                        {showCollectionMapAudiocraftItemMode ? <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-audiocraft-item-mode">AudioCraft item mode</label><select className="store-input mt-3" id="collection-map-audiocraft-item-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftItemMode: event.target.value === 'sequentialContinuation' ? 'sequentialContinuation' : 'independent' } }))} value={collectionMapAudiocraftItemMode}><option value="independent">Independent clips</option><option value="sequentialContinuation">Sequential continuation chain</option></select></div>{showCollectionMapAudiocraftChainFields ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-chain-first">First item behavior</label><select className="store-input mt-3" id="collection-map-chain-first" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audioChainFirstItemBehavior: 'scratch' } }))} value="scratch"><option value="scratch">Generate from scratch</option></select></div> : <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-audio-mode">Audio mode</label><select className="store-input mt-3" id="collection-map-audio-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audioMode: event.target.value === 'sound' ? 'sound' : 'music' } }))} value={selectedNode.config?.audioMode === 'sound' ? 'sound' : 'music'}><option value="music">Music</option><option value="sound">Sound</option></select></div>}</div>{showCollectionMapAudiocraftChainFields ? <div className="grid gap-3 sm:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-chain-seed">Seed seconds</label><input className="store-input mt-3" id="collection-map-chain-seed" min="0.25" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, continuationSeedSeconds: Number(event.target.value || 0) || 0 } }))} step="0.25" type="number" value={selectedNode.config?.continuationSeedSeconds || 12} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-duration">Segment duration</label><input className="store-input mt-3" id="collection-map-duration" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, durationSeconds: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.durationSeconds || 8} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-chain-output">Output mode</label><select className="store-input mt-3" id="collection-map-chain-output" onChange={() => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audioChainOutputMode: 'segments' } }))} value="segments"><option value="segments">Segments collection</option></select></div></div> : <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-duration">Duration</label><input className="store-input mt-3" id="collection-map-duration" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, durationSeconds: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.durationSeconds || 8} /></div>}<details className="rounded-[18px] border border-white/10 bg-white/5 px-4 py-3"><summary className="cursor-pointer text-xs uppercase tracking-[0.18em] text-slate-400">Advanced AudioCraft settings</summary><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-audio-temperature">Temperature</label><input className="store-input mt-3" id="collection-map-audio-temperature" min="0.01" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftTemperature: Number(event.target.value || 0) || 0 } }))} step="0.05" type="number" value={selectedNode.config?.audiocraftTemperature ?? 1} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-audio-top-k">Top K</label><input className="store-input mt-3" id="collection-map-audio-top-k" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftTopK: Number(event.target.value || 0) || 0 } }))} step="1" type="number" value={selectedNode.config?.audiocraftTopK ?? 250} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-audio-top-p">Top P</label><input className="store-input mt-3" id="collection-map-audio-top-p" max="1" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftTopP: Number(event.target.value || 0) || 0 } }))} step="0.05" type="number" value={selectedNode.config?.audiocraftTopP ?? 0} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-audio-cfg">CFG coefficient</label><input className="store-input mt-3" id="collection-map-audio-cfg" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftCfgCoef: Number(event.target.value || 0) || 0 } }))} step="0.25" type="number" value={selectedNode.config?.audiocraftCfgCoef ?? 3} /></div><label className="flex items-center gap-3 pt-7 text-sm font-medium text-slate-200" htmlFor="collection-map-audio-two-step"><input checked={Boolean(selectedNode.config?.audiocraftTwoStepCfg)} className="h-4 w-4 accent-cyan-300" id="collection-map-audio-two-step" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audiocraftTwoStepCfg: event.target.checked } }))} type="checkbox" />Two-step CFG</label></div></details></div> : showCollectionMapAudioGenerationFields && !showCollectionMapChatterboxReferenceVoiceFields ? <div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-audio-mode">Audio mode</label><select className="store-input mt-3" id="collection-map-audio-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audioMode: event.target.value === 'sound' ? 'sound' : 'music' } }))} value={selectedNode.config?.audioMode === 'sound' ? 'sound' : 'music'}><option value="music">Music</option><option value="sound">Sound</option></select></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-duration">Duration</label><input className="store-input mt-3" id="collection-map-duration" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, durationSeconds: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.durationSeconds || 8} /></div></div> : null}
                        {showCollectionMapWanVideoItemMode ? <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-video-item-mode">Video item mode</label><select className="store-input mt-3" id="collection-map-video-item-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoItemMode: event.target.value === 'sequentialLastFrame' ? 'sequentialLastFrame' : 'independent' } }))} value={collectionMapVideoItemMode}><option value="independent">Independent text-to-video clips</option><option value="sequentialLastFrame">Sequential previous-last-frame chain</option></select></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-video-size">Video size</label><select className="store-input mt-3" id="collection-map-video-size" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoSize: event.target.value } }))} value={selectedNode.config?.videoSize || '1280x720'}><option value="832x480">832 x 480</option><option value="1280x720">1280 x 720</option></select></div></div>{showCollectionMapVideoChainFields ? <div className="rounded-[18px] border border-cyan-300/20 bg-cyan-300/10 px-4 py-3"><div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-cyan-100/80" htmlFor="collection-map-video-first-behavior">First item</label><select className="store-input mt-3" id="collection-map-video-first-behavior" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoChainFirstItemBehavior: event.target.value === 'initialReferenceImage' ? 'initialReferenceImage' : 'textToVideo' } }))} value={selectedNode.config?.videoChainFirstItemBehavior === 'initialReferenceImage' ? 'initialReferenceImage' : 'textToVideo'}><option value="textToVideo">Start from text-to-video</option><option value="initialReferenceImage">Start from initial reference image</option></select></div><div><label className="text-xs uppercase tracking-[0.18em] text-cyan-100/80" htmlFor="collection-map-video-initial-reference">Initial reference image</label><div className="mt-3 flex gap-2"><input className="store-input" id="collection-map-video-initial-reference" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoInitialReferenceImagePath: event.target.value } }))} placeholder="Optional image path" value={selectedNode.config?.videoInitialReferenceImagePath || ''} /><button className="ghost-button" onClick={() => chooseCollectionMapInitialReferenceImage(selectedNode.id)} type="button">Choose</button></div></div></div><p className="mt-3 text-xs leading-5 text-cyan-100/80">Later accepted clips use the previous generated clip last frame as the next reference image. The current text item still becomes the prompt for each clip.</p></div> : null}</div> : null}
                        {showCollectionMapVideoGenerationFields ? <div className="grid gap-3 sm:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-video-fps">FPS</label><input className="store-input mt-3" id="collection-map-video-fps" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoFps: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.videoFps || 15} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-video-steps">Steps</label><input className="store-input mt-3" id="collection-map-video-steps" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, steps: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.steps || 24} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-video-seed">Seed</label><input className="store-input mt-3" id="collection-map-video-seed" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, seed: Number(event.target.value || -1) } }))} type="number" value={selectedNode.config?.seed ?? -1} /></div></div> : null}
                        {showCollectionMapImageTransformFields ? <div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-transform-subtype">Transform</label><select className="store-input mt-3" id="collection-map-transform-subtype" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, transformSubtype: event.target.value } }))} value={selectedNode.config?.transformSubtype || 'upscale'}>{collectionMapTransformSubtypeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-scale">Scale</label><input className="store-input mt-3" id="collection-map-scale" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, scale: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.scale || 4} /></div></div> : null}
                        {showCollectionMapLocalImageGenerationFields ? <><div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-width">Width</label><input className="store-input mt-3" id="collection-map-width" min="256" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, width: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.width || 832} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-height">Height</label><input className="store-input mt-3" id="collection-map-height" min="256" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, height: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.height || 832} /></div></div><div className="grid gap-3 sm:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-steps">Steps</label><input className="store-input mt-3" id="collection-map-steps" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, steps: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.steps || 24} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-cfg">CFG scale</label><input className="store-input mt-3" id="collection-map-cfg" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, cfgScale: Number(event.target.value || 0) || 0 } }))} step="0.5" type="number" value={selectedNode.config?.cfgScale || 7} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-seed">Seed</label><input className="store-input mt-3" id="collection-map-seed" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, seed: Number(event.target.value || -1) } }))} type="number" value={selectedNode.config?.seed ?? -1} /></div></div></> : null}
                      </div>
                    ) : (
                      <div className="space-y-4"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-provider">Provider</label><select className="store-input mt-3" id="collection-map-provider" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, providerId: event.target.value, model: '', videoItemMode: supportsCollectionMapCloudVideoChaining(event.target.value) ? currentNode.config?.videoItemMode : 'independent' } }))} value={selectedNode.config?.providerId || ''}><option value="">Choose provider</option>{getCloudProvidersForOperation(connectedProviders, collectionMapOperationId).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></div>{showCollectionMapCloudModelField ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-model">Model</label><input className="store-input mt-3" id="collection-map-model" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, model: event.target.value } }))} placeholder={showCollectionMapAudioGenerationFields ? 'Provider audio model' : showCollectionMapVideoGenerationFields ? getCloudVideoModelPlaceholder(selectedNode.config?.providerId) : showCollectionMapImageAnalysisFields ? 'Provider vision model' : 'Provider image model'} value={selectedNode.config?.model || ''} /></div> : null}{showCollectionMapCloudImageGenerationFields ? <div className="grid gap-3 sm:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-size">Image size</label><select className="store-input mt-3" id="collection-map-size" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, imageSize: event.target.value } }))} value={selectedNode.config?.imageSize || '1024x1024'}><option value="1024x1024">1024 x 1024</option><option value="1536x1024">1536 x 1024</option><option value="1024x1536">1024 x 1536</option><option value="auto">Auto</option></select></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-quality">Quality</label><select className="store-input mt-3" id="collection-map-quality" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, imageQuality: event.target.value } }))} value={selectedNode.config?.imageQuality || 'auto'}><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-background">Background</label><select className="store-input mt-3" id="collection-map-background" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, imageBackground: event.target.value } }))} value={selectedNode.config?.imageBackground || 'auto'}><option value="auto">Auto</option><option value="opaque">Opaque</option><option value="transparent">Transparent</option></select></div></div> : null}{showCollectionMapAudioGenerationFields ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-voice">Voice</label><input className="store-input mt-3" id="collection-map-voice" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audioVoice: event.target.value } }))} placeholder="Provider voice" value={selectedNode.config?.audioVoice || ''} /></div> : null}</div>
                    )}
                    {showCollectionMapCloudVideoGenerationFields ? <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-cloud-video-aspect">Aspect ratio</label><select className="store-input mt-3" id="collection-map-cloud-video-aspect" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoAspectRatio: event.target.value, videoSize: event.target.value === '9:16' ? '720x1280' : '1280x720' } }))} value={selectedNode.config?.videoAspectRatio || (selectedNode.config?.videoSize === '720x1280' ? '9:16' : '16:9')}><option value="16:9">16:9 landscape</option><option value="9:16">9:16 portrait</option></select></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-cloud-video-duration">Duration seconds</label><input className="store-input mt-3" id="collection-map-cloud-video-duration" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, durationSeconds: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.durationSeconds || 8} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-cloud-video-resolution">Resolution</label><select className="store-input mt-3" id="collection-map-cloud-video-resolution" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoResolution: event.target.value } }))} value={getCloudVideoResolutionOptions(selectedNode.config?.providerId).some((option) => option.id === selectedNode.config?.videoResolution) ? selectedNode.config?.videoResolution : '720p'}>{getCloudVideoResolutionOptions(selectedNode.config?.providerId).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div></div>{showCollectionMapCloudVideoChainToggle ? <div className="rounded-[18px] border border-cyan-300/20 bg-cyan-300/10 px-4 py-3"><label className="flex items-center gap-3 text-sm font-medium text-white" htmlFor="collection-map-cloud-video-chain"><input checked={collectionMapVideoItemMode === 'sequentialLastFrame'} className="h-4 w-4 accent-cyan-300" id="collection-map-cloud-video-chain" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoItemMode: event.target.checked ? 'sequentialLastFrame' : 'independent' } }))} type="checkbox" />Chain from previous video's last frame</label>{showCollectionMapCloudVideoChainFields ? <p className="mt-2 text-xs leading-5 text-cyan-100/80">{selectedCollectionMapProviderId === 'xai' ? 'xAI Grok Imagine receives the previous generated clip last frame as the next starting image. Current text items still provide the prompt; image items keep their source lineage.' : 'Google Veo receives the previous generated clip last frame as the next starting image. Current text items still provide the prompt; image items keep their source lineage.'}</p> : null}</div> : null}</div> : null}
                    {showCollectionMapInstructionField ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-instruction">{getCollectionMapInstructionLabel(collectionMapOperationId, collectionMapExecutionMode, selectedCollectionMapMapping)}</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="collection-map-instruction" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, instruction: event.target.value } }))} placeholder={getCollectionMapInstructionPlaceholder(collectionMapOperationId, collectionMapExecutionMode, selectedCollectionMapMapping)} value={collectionMapInstructionValue} /></div> : null}
                    {(showCollectionMapLocalImageGenerationFields || showCollectionMapWanVideoItemMode || (showCollectionMapCloudVideoGenerationFields && supportsCloudVideoNegativePrompt(selectedNode.config?.providerId))) ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-negative">Negative prompt</label><textarea className="store-input mt-3 min-h-[100px] resize-none" id="collection-map-negative" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, negativePrompt: event.target.value } }))} placeholder={showCollectionMapVideoGenerationFields ? 'Optional negative prompt for every mapped video.' : 'Optional negative prompt for every mapped image.'} value={selectedNode.config?.negativePrompt || ''} /></div> : null}
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-failure-mode">On item failure</label>
                      <select className="store-input mt-3" id="collection-map-failure-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, failureMode: event.target.value === 'partial' ? 'partial' : 'fail-fast', partialSuccess: { ...(currentNode.config?.partialSuccess || {}), enabled: event.target.value === 'partial' } } }))} value={collectionMapFailureMode}>
                        <option value="fail-fast">Fail entire map, no partial output</option>
                        <option value="partial">Output partial collection with successful items</option>
                      </select>
                      <p className="mt-2 text-xs leading-5 text-slate-400">Partial output contains only successful final items and records failed item details in the collection manifest. With per-item validation, this applies after max attempts are exhausted.</p>
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      <label className="flex items-center gap-3 text-sm font-medium text-white" htmlFor="collection-map-per-item-validation"><input checked={perItemValidationEnabled} className="h-4 w-4 accent-cyan-300" id="collection-map-per-item-validation" onChange={(event) => updatePerItemValidation({ enabled: event.target.checked })} type="checkbox" />Validate each mapped item</label>
                      <p className="mt-2 text-xs leading-5 text-slate-400">When enabled, Local AI Hub validates one mapped {perItemValidationOutputLabel.toLowerCase()} item at a time and retries only that source item. Final collection output follows the item failure setting above.</p>
                      {perItemValidationEnabled ? (
                        <div className="mt-4 space-y-3">
                          <div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-validation-mode">Validation mode</label><select className="store-input mt-3" id="collection-map-validation-mode" onChange={(event) => updatePerItemValidation({ mode: event.target.value === 'user' ? 'user' : 'llm' })} value={perItemValidation.mode === 'user' ? 'user' : 'llm'}><option disabled={!perItemValidationLlmSupported} value="llm">LLM validator</option><option value="user">User approval</option></select></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-validation-attempts">Max attempts per item</label><input className="store-input mt-3" id="collection-map-validation-attempts" max={PIPELINE_RETRY_LOOP_MAX_ATTEMPTS} min="1" onChange={(event) => updatePerItemValidation({ maxAttempts: Math.max(1, Math.min(PIPELINE_RETRY_LOOP_MAX_ATTEMPTS, Number(event.target.value || 1) || 1)) })} type="number" value={Math.max(1, Math.min(PIPELINE_RETRY_LOOP_MAX_ATTEMPTS, Number(perItemValidation.maxAttempts || 2) || 2))} /></div></div>
                          {perItemValidation.mode === 'user' ? <div className="rounded-[18px] border border-violet-300/20 bg-violet-300/10 px-4 py-3 text-xs leading-5 text-violet-100">The run will pause for each mapped item so you can choose Pass or Fail. A failed item retries only that item until the per-item attempt limit is reached.</div> : !perItemValidationLlmSupported ? <div className="rounded-[18px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-xs leading-5 text-amber-100">Per-item LLM validation for mapped {perItemValidationOutputLabel.toLowerCase()} artifacts is not supported by the current validator capability model. Validate manually here, validate the final collection after mapping, or map to text/image first.</div> : (
                            <>
                              <div className="grid gap-3 sm:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-validation-runtime">Validator runtime</label><select className="store-input mt-3" id="collection-map-validation-runtime" onChange={(event) => updatePerItemValidation({ llmExecutionMode: event.target.value === 'ollama' ? 'ollama' : 'cloud', providerId: event.target.value === 'ollama' ? '' : perItemValidation.providerId || '' })} value={perItemValidation.llmExecutionMode === 'ollama' ? 'ollama' : 'cloud'}><option value="cloud">Cloud provider</option><option value="ollama">Ollama (local)</option></select></div>{perItemValidation.llmExecutionMode === 'ollama' ? null : <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-validation-provider">Provider</label><select className="store-input mt-3" id="collection-map-validation-provider" onChange={(event) => updatePerItemValidation({ providerId: event.target.value })} value={perItemValidation.providerId || ''}><option value="">Choose provider</option>{connectedProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></div>}<div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-validation-model">Validator model</label><input className="store-input mt-3" id="collection-map-validation-model" onChange={(event) => updatePerItemValidation({ model: event.target.value })} placeholder={perItemValidation.llmExecutionMode === 'ollama' ? 'Vision/text model' : 'Provider validator model'} value={perItemValidation.model || ''} /></div></div>
                              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-validation-rules">Per-item validation rules</label><textarea className="store-input mt-3 min-h-[110px] resize-none" id="collection-map-validation-rules" onChange={(event) => updatePerItemValidation({ ruleset: event.target.value })} placeholder="Describe what should count as pass or fail for each mapped item." value={perItemValidation.ruleset || ''} /></div>
                              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="collection-map-validation-retry">Retry guidance</label><textarea className="store-input mt-3 min-h-[90px] resize-none" id="collection-map-validation-retry" onChange={(event) => updatePerItemValidation({ retryInstruction: event.target.value })} placeholder="Optional instruction appended only to retry attempts for a failed item." value={perItemValidation.retryInstruction || ''} /></div>
                            </>
                          )}
                          <div className="rounded-[18px] border border-white/10 bg-slate-950/35 px-4 py-3 text-xs leading-5 text-slate-400">User validation uses the same real pause/resume path as the standalone Validation node. LLM validation applies the same rules independently to each item and stays limited to validator-supported artifact kinds.</div>
                        </div>
                      ) : null}
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">This node maps an ordered typed collection into another ordered typed collection. Partial collections are explicit, marked partial in their manifest, and never include failed item artifacts as successful final items.</div>
                  </div>
                  );
                })() : null}
                {selectedNode.type === 'audioStitch' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="audio-stitch-gap">Gap seconds</label>
                      <input
                        className="store-input mt-3"
                        id="audio-stitch-gap"
                        min="0"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            gapSeconds: Math.max(0, Number(event.target.value || 0) || 0),
                          },
                        }))}
                        step="0.1"
                        type="number"
                        value={selectedNode.config?.gapSeconds ?? 0}
                      />
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Concatenate audio clips in collection order into one WAV artifact. Source clips must be matching PCM WAV files in this first pass.
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'videoStitch' ? (
                  <div className="space-y-4">
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Concatenate ordered video clips into one final video. This pass writes MP4 output with ffmpeg concat stream-copy, so source clips must already be concat-compatible MP4 files with matching codec, resolution, and fps.
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'normalizeImage' ? (
                  <div className="space-y-4">
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Convert image files and image collections while preserving collection order.
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="normalize-image-output-format">Output format</label>
                      <select
                        className="store-input mt-3"
                        id="normalize-image-output-format"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, outputFormat: event.target.value },
                        }))}
                        value={String(selectedNode.config?.outputFormat || 'png').trim().toLowerCase()}
                      >
                        <option value="png">PNG</option>
                        <option value="jpg">JPG / JPEG</option>
                        <option value="webp">WebP</option>
                        <option value="bmp">BMP</option>
                      </select>
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'trimMedia' ? (
                  <div className="space-y-4">
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Trim an audio or video artifact to a selected time range.
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="trim-media-mode">Range mode</label>
                      <select
                        className="store-input mt-3"
                        id="trim-media-mode"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, mode: event.target.value },
                        }))}
                        value={String(selectedNode.config?.mode || 'duration').trim() === 'end' ? 'end' : 'duration'}
                      >
                        <option value="duration">Start + duration</option>
                        <option value="end">Start + end</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="trim-media-start">Start time</label>
                        <input
                          className="store-input mt-3"
                          id="trim-media-start"
                          inputMode="decimal"
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            if (!isDraftSecondsValue(nextValue)) {
                              return;
                            }
                            updateNode(selectedNode.id, (currentNode) => ({
                              ...currentNode,
                              config: { ...currentNode.config, startSeconds: nextValue },
                            }));
                          }}
                          pattern="[0-9]*[.]?[0-9]*"
                          type="text"
                          value={selectedNode.config?.startSeconds ?? 0}
                        />
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="trim-media-endpoint">{String(selectedNode.config?.mode || 'duration').trim() === 'end' ? 'End time' : 'Duration seconds'}</label>
                        <input
                          className="store-input mt-3"
                          id="trim-media-endpoint"
                          inputMode="decimal"
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            if (!isDraftSecondsValue(nextValue)) {
                              return;
                            }
                            updateNode(selectedNode.id, (currentNode) => ({
                              ...currentNode,
                              config: String(currentNode.config?.mode || 'duration').trim() === 'end'
                                ? { ...currentNode.config, endSeconds: nextValue }
                                : { ...currentNode.config, durationSeconds: nextValue },
                            }));
                          }}
                          pattern="[0-9]*[.]?[0-9]*"
                          type="text"
                          value={String(selectedNode.config?.mode || 'duration').trim() === 'end' ? (selectedNode.config?.endSeconds ?? 5) : (selectedNode.config?.durationSeconds ?? 5)}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'exportSubtitles' ? (
                  <div className="space-y-4">
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Create a reusable .srt or .vtt subtitle file from transcript segments or caption lines.
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="export-subtitles-format">Output format</label>
                      <select
                        className="store-input mt-3"
                        id="export-subtitles-format"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, outputFormat: event.target.value },
                        }))}
                        value={String(selectedNode.config?.outputFormat || 'srt').trim() === 'vtt' ? 'vtt' : 'srt'}
                      >
                        <option value="srt">SRT</option>
                        <option value="vtt">VTT</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="export-subtitles-mode">Caption mode</label>
                      <select
                        className="store-input mt-3"
                        id="export-subtitles-mode"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, captionMode: event.target.value },
                        }))}
                        value={String(selectedNode.config?.captionMode || 'auto').trim() || 'auto'}
                      >
                        <option value="auto">Auto</option>
                        <option value="transcriptSegments">Transcript segments</option>
                        <option value="manualLines">Manual lines</option>
                      </select>
                    </div>
                    {String(selectedNode.config?.captionMode || 'auto').trim() === 'manualLines' ? (
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="export-subtitles-duration">Duration per caption seconds</label>
                        <input
                          className="store-input mt-3"
                          id="export-subtitles-duration"
                          inputMode="decimal"
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            if (!isDraftSecondsValue(nextValue)) {
                              return;
                            }
                            updateNode(selectedNode.id, (currentNode) => ({
                              ...currentNode,
                              config: { ...currentNode.config, durationPerCaptionSeconds: nextValue },
                            }));
                          }}
                          pattern="[0-9]*[.]?[0-9]*"
                          type="text"
                          value={selectedNode.config?.durationPerCaptionSeconds ?? 3}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {selectedNode.type === 'burnSubtitles' ? (
                  <div className="space-y-4">
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Render timed captions directly into a video. Use Whisper/transcript segments or subtitle files for timed captions. Manual text lines use a fixed duration per line.
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="burn-subtitles-mode">Caption timing</label>
                      <select
                        className="store-input mt-3"
                        id="burn-subtitles-mode"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, captionMode: event.target.value },
                        }))}
                        value={String(selectedNode.config?.captionMode || 'auto').trim() || 'auto'}
                      >
                        <option value="auto">Auto</option>
                        <option value="transcriptSegments">Transcript segments</option>
                        <option value="subtitleFile">Subtitle file</option>
                        <option value="manualLines">Manual text lines</option>
                      </select>
                    </div>
                    {String(selectedNode.config?.captionMode || 'auto').trim() === 'manualLines' ? (
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="burn-subtitles-duration">Duration per caption</label>
                        <input
                          className="store-input mt-3"
                          id="burn-subtitles-duration"
                          inputMode="decimal"
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            if (!isDraftSecondsValue(nextValue)) {
                              return;
                            }
                            updateNode(selectedNode.id, (currentNode) => ({
                              ...currentNode,
                              config: { ...currentNode.config, durationPerCaptionSeconds: nextValue },
                            }));
                          }}
                          pattern="[0-9]*[.]?[0-9]*"
                          type="text"
                          value={selectedNode.config?.durationPerCaptionSeconds ?? 3}
                        />
                      </div>
                    ) : null}
                    <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Style</p>
                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="burn-subtitles-font-source">Font source</label>
                          <select className="store-input mt-3" id="burn-subtitles-font-source" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, fontSource: event.target.value, fontLibraryId: event.target.value === 'assetLibrary' ? (selectedFontLibrary?.id || '') : '', fontItemId: event.target.value === 'assetLibrary' ? (selectedFontLibrary?.items?.[0]?.id || '') : '' } }))} value={String(selectedNode.config?.fontSource || 'preset').trim() === 'assetLibrary' ? 'assetLibrary' : 'preset'}>
                            {BURN_SUBTITLES_FONT_SOURCE_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="burn-subtitles-color-source">Color source</label>
                          <select className="store-input mt-3" id="burn-subtitles-color-source" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, colorSource: event.target.value, colorPaletteLibraryId: event.target.value === 'palette' ? (selectedColorPaletteLibrary?.id || '') : '', textColorPaletteItemId: event.target.value === 'palette' ? (selectedColorPaletteLibrary?.items?.[0]?.id || '') : '', outlineColorPaletteItemId: event.target.value === 'palette' ? (selectedColorPaletteLibrary?.items?.[0]?.id || '') : '', backgroundColorPaletteItemId: event.target.value === 'palette' ? (selectedColorPaletteLibrary?.items?.[0]?.id || '') : '' } }))} value={String(selectedNode.config?.colorSource || 'manual').trim() === 'palette' ? 'palette' : 'manual'}>
                            {BURN_SUBTITLES_COLOR_SOURCE_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
                          </select>
                        </div>
                      </div>
                      {String(selectedNode.config?.fontSource || 'preset').trim() === 'assetLibrary' ? (
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          <div>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="burn-subtitles-font-library">Font library</label>
                            <select className="store-input mt-3" disabled={!fontLibraries.length} id="burn-subtitles-font-library" onChange={(event) => { const library = fontLibraries.find((entry) => entry.id === event.target.value) || null; updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, fontLibraryId: event.target.value, fontItemId: library?.items?.[0]?.id || '' } })); }} value={selectedNode.config?.fontLibraryId || selectedFontLibrary?.id || ''}>
                              {!fontLibraries.length ? <option value="">No Font libraries</option> : null}
                              {fontLibraries.map((library) => <option key={library.id} value={library.id}>{library.name} ({library.items?.length || 0})</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="burn-subtitles-font-item">Imported font</label>
                            <select className="store-input mt-3" disabled={!selectedFontLibrary?.items?.length} id="burn-subtitles-font-item" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, fontItemId: event.target.value } }))} value={selectedNode.config?.fontItemId || selectedFontLibrary?.items?.[0]?.id || ''}>
                              {!selectedFontLibrary?.items?.length ? <option value="">No imported fonts</option> : null}
                              {(selectedFontLibrary?.items || []).map((item) => <option key={item.id} value={item.id}>{item.displayName || item.name}</option>)}
                            </select>
                          </div>
                        </div>
                      ) : null}
                      {String(selectedNode.config?.colorSource || 'manual').trim() === 'palette' ? (
                        <div className="mt-4 grid gap-3 md:grid-cols-4">
                          <div>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="burn-subtitles-palette-library">Palette library</label>
                            <select className="store-input mt-3" disabled={!colorPaletteLibraries.length} id="burn-subtitles-palette-library" onChange={(event) => { const library = colorPaletteLibraries.find((entry) => entry.id === event.target.value) || null; const itemId = library?.items?.[0]?.id || ''; updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, colorPaletteLibraryId: event.target.value, textColorPaletteItemId: itemId, outlineColorPaletteItemId: itemId, backgroundColorPaletteItemId: itemId } })); }} value={selectedNode.config?.colorPaletteLibraryId || selectedColorPaletteLibrary?.id || ''}>
                              {!colorPaletteLibraries.length ? <option value="">No Color Palette libraries</option> : null}
                              {colorPaletteLibraries.map((library) => <option key={library.id} value={library.id}>{library.name} ({library.items?.length || 0})</option>)}
                            </select>
                          </div>
                          {[
                            ['burn-subtitles-palette-text', 'Text', 'textColorPaletteItemId'],
                            ['burn-subtitles-palette-outline', 'Outline', 'outlineColorPaletteItemId'],
                            ['burn-subtitles-palette-background', 'Background', 'backgroundColorPaletteItemId'],
                          ].map(([inputId, label, configKey]) => (
                            <div key={inputId}>
                              <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={inputId}>{label}</label>
                              <select className="store-input mt-3" disabled={!selectedColorPaletteLibrary?.items?.length} id={inputId} onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, [configKey]: event.target.value } }))} value={selectedNode.config?.[configKey] || selectedColorPaletteLibrary?.items?.[0]?.id || ''}>
                                {!selectedColorPaletteLibrary?.items?.length ? <option value="">No colors</option> : null}
                                {(selectedColorPaletteLibrary?.items || []).map((item) => <option key={item.id} value={item.id}>{item.name} ({item.hex})</option>)}
                              </select>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        {[
                          ['burn-subtitles-font-size', 'Font size', 'fontSize', 28],
                          ['burn-subtitles-outline', 'Outline', 'outline', 2],
                          ['burn-subtitles-shadow', 'Shadow', 'shadow', 1],
                          ['burn-subtitles-bottom-margin', 'Vertical margin', 'bottomMargin', 32],
                        ].map(([inputId, label, configKey, fallbackValue]) => (
                          <div key={inputId}>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={inputId}>{label}</label>
                            <input
                              className="store-input mt-3"
                              id={inputId}
                              inputMode="decimal"
                              onChange={(event) => {
                                const nextValue = event.target.value;
                                if (!isDraftSecondsValue(nextValue)) {
                                  return;
                                }
                                updateNode(selectedNode.id, (currentNode) => ({
                                  ...currentNode,
                                  config: { ...currentNode.config, [configKey]: nextValue },
                                }));
                              }}
                              pattern="[0-9]*[.]?[0-9]*"
                              type="text"
                              value={selectedNode.config?.[configKey] ?? fallbackValue}
                            />
                          </div>
                        ))}
                        {[
                          ['burn-subtitles-text-color', 'Text color', 'textColor', 'white', [
                            ['white', 'White'], ['black', 'Black'], ['yellow', 'Yellow'], ['red', 'Red'], ['blue', 'Blue'], ['green', 'Green'], ['cyan', 'Cyan'], ['magenta', 'Magenta'], ['lightGray', 'Light gray'], ['darkGray', 'Dark gray'],
                          ]],
                          ['burn-subtitles-outline-color', 'Outline color', 'outlineColor', 'black', [
                            ['black', 'Black'], ['white', 'White'], ['darkGray', 'Dark gray'], ['lightGray', 'Light gray'], ['yellow', 'Yellow'], ['red', 'Red'], ['blue', 'Blue'],
                          ]],
                          ['burn-subtitles-background-color', 'Background color', 'backgroundColor', 'black', BURN_SUBTITLES_TEXT_COLOR_OPTIONS],
                          ['burn-subtitles-position', 'Position', 'position', 'bottomCenter', [
                            ['bottomCenter', 'Bottom center'], ['bottomLeft', 'Bottom left'], ['bottomRight', 'Bottom right'], ['topCenter', 'Top center'], ['topLeft', 'Top left'], ['topRight', 'Top right'], ['center', 'Center'],
                          ]],
                          ['burn-subtitles-font-preset', 'Font preset', 'fontPreset', 'arial', [
                            ['arial', 'Arial'], ['segoeUi', 'Segoe UI'], ['tahoma', 'Tahoma'], ['verdana', 'Verdana'],
                          ]],
                        ].map(([inputId, label, configKey, fallbackValue, options]) => (
                          <div key={inputId}>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={inputId}>{label}</label>
                            <select
                              className="store-input mt-3"
                              id={inputId}
                              onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                                ...currentNode,
                                config: { ...currentNode.config, [configKey]: event.target.value },
                              }))}
                              value={String(selectedNode.config?.[configKey] || fallbackValue).trim() || fallbackValue}
                            >
                              {options.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        {[
                          ['burn-subtitles-bold', 'Bold', 'bold'],
                          ['burn-subtitles-italic', 'Italic', 'italic'],
                          ['burn-subtitles-background-box', 'Background box', 'backgroundBox'],
                        ].map(([inputId, label, configKey]) => (
                          <label key={inputId} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/10 px-3 py-3 text-sm text-slate-300" htmlFor={inputId}>
                            <input
                              checked={selectedNode.config?.[configKey] === true}
                              className="h-4 w-4 rounded border-white/20 bg-slate-950 text-cyan-300"
                              id={inputId}
                              onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                                ...currentNode,
                                config: { ...currentNode.config, [configKey]: event.target.checked },
                              }))}
                              type="checkbox"
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                        {selectedNode.config?.backgroundBox === true ? (
                          <div>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="burn-subtitles-background-opacity">Background opacity</label>
                            <select
                              className="store-input mt-3"
                              id="burn-subtitles-background-opacity"
                              onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                                ...currentNode,
                                config: { ...currentNode.config, backgroundOpacity: Number(event.target.value) },
                              }))}
                              value={String(selectedNode.config?.backgroundOpacity ?? 50)}
                            >
                              <option value="25">25%</option>
                              <option value="50">50%</option>
                              <option value="75">75%</option>
                              <option value="100">100%</option>
                            </select>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'normalizeAudioCollection' ? (
                  <div className="space-y-4">
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Normalize or convert audio files and audio collections while preserving collection order.
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="normalize-audio-output-format">Output format</label>
                      <select
                        className="store-input mt-3"
                        id="normalize-audio-output-format"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, outputFormat: event.target.value },
                        }))}
                        value={String(selectedNode.config?.outputFormat || 'auto').trim().toLowerCase()}
                      >
                        <option value="auto">Auto / normalized</option>
                        <option value="wav">WAV</option>
                        <option value="mp3">MP3</option>
                        <option value="flac">FLAC</option>
                        <option value="ogg">OGG</option>
                        <option value="m4a">M4A</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="normalize-audio-sample-rate">Sample rate</label>
                      <input
                        className="store-input mt-3"
                        id="normalize-audio-sample-rate"
                        min="8000"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, sampleRate: Math.max(1, Number(event.target.value || 44100) || 44100) },
                        }))}
                        step="1000"
                        type="number"
                        value={Math.max(1, Number(selectedNode.config?.sampleRate || 44100) || 44100)}
                      />
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="normalize-audio-channels">Channels</label>
                      <select
                        className="store-input mt-3"
                        id="normalize-audio-channels"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, channels: event.target.value },
                        }))}
                        value={String(selectedNode.config?.channels || 'stereo').trim() === 'mono' ? 'mono' : 'stereo'}
                      >
                        <option value="stereo">Stereo</option>
                        <option value="mono">Mono</option>
                      </select>
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'normalizeVideoCollection' ? (
                  <div className="space-y-4">
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Normalize or convert video files and video collections while preserving collection order.
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="normalize-video-output-format">Output format</label>
                      <select
                        className="store-input mt-3"
                        id="normalize-video-output-format"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, outputFormat: event.target.value },
                        }))}
                        value={String(selectedNode.config?.outputFormat || 'auto').trim().toLowerCase()}
                      >
                        <option value="auto">Auto / normalized</option>
                        <option value="mp4">MP4</option>
                        <option value="webm">WebM</option>
                        <option value="mov">MOV</option>
                        <option value="mkv">MKV</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="normalize-video-size-mode">Target size</label>
                      <select
                        className="store-input mt-3"
                        id="normalize-video-size-mode"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, sizeMode: event.target.value },
                        }))}
                        value={String(selectedNode.config?.sizeMode || 'matchFirst').trim() === 'custom' ? 'custom' : 'matchFirst'}
                      >
                        <option value="matchFirst">Match first clip</option>
                        <option value="custom">Custom size</option>
                      </select>
                    </div>
                    {String(selectedNode.config?.sizeMode || 'matchFirst').trim() === 'custom' ? (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="normalize-video-width">Width</label>
                          <input
                            className="store-input mt-3"
                            id="normalize-video-width"
                            min="2"
                            onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                              ...currentNode,
                              config: { ...currentNode.config, width: Math.max(2, Number(event.target.value || 1280) || 1280) },
                            }))}
                            step="2"
                            type="number"
                            value={Math.max(2, Number(selectedNode.config?.width || 1280) || 1280)}
                          />
                        </div>
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="normalize-video-height">Height</label>
                          <input
                            className="store-input mt-3"
                            id="normalize-video-height"
                            min="2"
                            onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                              ...currentNode,
                              config: { ...currentNode.config, height: Math.max(2, Number(event.target.value || 720) || 720) },
                            }))}
                            step="2"
                            type="number"
                            value={Math.max(2, Number(selectedNode.config?.height || 720) || 720)}
                          />
                        </div>
                      </div>
                    ) : null}
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="normalize-video-fps">FPS</label>
                      <input
                        className="store-input mt-3"
                        id="normalize-video-fps"
                        min="1"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: { ...currentNode.config, fps: Math.max(1, Number(event.target.value || 30) || 30) },
                        }))}
                        step="1"
                        type="number"
                        value={Math.max(1, Number(selectedNode.config?.fps || 30) || 30)}
                      />
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'extractVideoFrame' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="extract-video-frame-position">Mode</label>
                      <select
                        className="store-input mt-3"
                        id="extract-video-frame-position"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            framePosition: event.target.value === 'last' || event.target.value === 'timestamp' ? event.target.value : 'first',
                          },
                        }))}
                        value={['last', 'timestamp'].includes(selectedNode.config?.framePosition) ? selectedNode.config.framePosition : 'first'}
                      >
                        <option value="first">First frame</option>
                        <option value="last">Last frame</option>
                        <option value="timestamp">Timestamp</option>
                      </select>
                    </div>
                    {selectedNode.config?.framePosition === 'timestamp' ? (
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="extract-video-frame-timestamp">Timestamp</label>
                        <input
                          className="store-input mt-3"
                          id="extract-video-frame-timestamp"
                          inputMode="decimal"
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            if (!isDraftSecondsValue(nextValue)) {
                              return;
                            }
                            updateNode(selectedNode.id, (currentNode) => ({
                              ...currentNode,
                              config: { ...currentNode.config, timestampSeconds: nextValue },
                            }));
                          }}
                          pattern="[0-9]*[.]?[0-9]*"
                          type="text"
                          value={selectedNode.config?.timestampSeconds ?? 0}
                        />
                      </div>
                    ) : null}
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      {selectedNode.config?.framePosition === 'timestamp' ? 'Extract the frame at the selected timestamp.' : 'Extract the first or last frame from a video as an image.'}
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'extractAudio' ? (
                  <div className="space-y-4">
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Extract the audio track from a video as a WAV file.
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'mediaComposition' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-mode">Composition mode</label>
                      <select className="store-input mt-3" id="media-composition-mode" onChange={(event) => changeMediaCompositionMode(selectedNode, event.target.value)} value={getMediaCompositionMode(selectedNode)}>
                        {MEDIA_COMPOSITION_MODE_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
                      </select>
                    </div>
                    {getMediaCompositionMode(selectedNode) === MEDIA_COMPOSITION_MODES.IMAGE_SLIDESHOW ? (
                      <>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-timing-mode">Image timing</label>
                      <select
                        className="store-input mt-3"
                        id="media-composition-timing-mode"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            imageTimingMode: event.target.value === 'dynamicFromImageMetadata' ? 'dynamicFromImageMetadata' : 'fixedDurationPerImage',
                          },
                        }))}
                        value={selectedNode.config?.imageTimingMode === 'dynamicFromImageMetadata' || selectedNode.config?.imageTimingMode === 'matchNarrationTiming' ? 'dynamicFromImageMetadata' : 'fixedDurationPerImage'}
                      >
                        <option value="fixedDurationPerImage">Fixed duration per image</option>
                        <option value="dynamicFromImageMetadata">Match narration/transcript timing</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-seconds">
                        {selectedNode.config?.imageTimingMode === 'dynamicFromImageMetadata' || selectedNode.config?.imageTimingMode === 'matchNarrationTiming' ? 'Fallback seconds per image' : 'Seconds per image'}
                      </label>
                      <input
                        className="store-input mt-3"
                        id="media-composition-seconds"
                        min="0.1"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            secondsPerItem: Number(event.target.value || 0) || 0,
                          },
                        }))}
                        step="0.1"
                        type="number"
                        value={selectedNode.config?.secondsPerItem || 4}
                      />
                      {selectedNode.config?.imageTimingMode === 'dynamicFromImageMetadata' || selectedNode.config?.imageTimingMode === 'matchNarrationTiming' ? (
                        <p className="mt-2 text-xs leading-5 text-slate-400">
                          Used only as a fallback if transcript/image timing metadata is unavailable or invalid.
                        </p>
                      ) : null}
                    </div>
                    {selectedNode.config?.imageTimingMode === 'dynamicFromImageMetadata' || selectedNode.config?.imageTimingMode === 'matchNarrationTiming' ? (
                      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                        Uses per-image timing from the longform plan/transcript when available.
                      </div>
                    ) : null}
                      </>
                    ) : (
                      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                        {getMediaCompositionMode(selectedNode) === MEDIA_COMPOSITION_MODES.VIDEO_SEQUENCE
                          ? 'Clip durations come from the connected videos. Image timing settings do not apply.'
                          : 'The connected video supplies the timeline. Image timing and scene transition settings do not apply.'}
                      </div>
                    )}
                    {getMediaCompositionMode(selectedNode) !== MEDIA_COMPOSITION_MODES.SINGLE_VIDEO_MIX ? (
                    <div className="space-y-3 border-t border-white/10 pt-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-transition-mode">Scene transitions</label>
                          <select
                            className="store-input mt-3"
                            id="media-composition-transition-mode"
                            onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                              ...currentNode,
                              config: {
                                ...currentNode.config,
                                sceneTransitionMode: getMediaCompositionTransitionMode(event.target.value),
                              },
                            }))}
                            value={getMediaCompositionTransitionMode(selectedNode.config?.sceneTransitionMode)}
                          >
                            {MEDIA_COMPOSITION_TRANSITION_MODE_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
                          </select>
                        </div>
                        {getMediaCompositionTransitionMode(selectedNode.config?.sceneTransitionMode) !== 'off' ? (
                          <div>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-transition-duration">Transition duration</label>
                            <input
                              className="store-input mt-3"
                              id="media-composition-transition-duration"
                              max="2"
                              min="0.1"
                              onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                                ...currentNode,
                                config: {
                                  ...currentNode.config,
                                  sceneTransitionDurationSeconds: Math.max(0.1, Math.min(2, Number(event.target.value || 0) || 0.5)),
                                },
                              }))}
                              step="0.1"
                              type="number"
                              value={selectedNode.config?.sceneTransitionDurationSeconds ?? 0.5}
                            />
                          </div>
                        ) : null}
                      </div>
                      {getMediaCompositionTransitionMode(selectedNode.config?.sceneTransitionMode) === 'single' ? (
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-transition-name">Transition</label>
                          <select
                            className="store-input mt-3"
                            id="media-composition-transition-name"
                            onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, sceneTransitionName: event.target.value } }))}
                            value={selectedNode.config?.sceneTransitionName || 'fade'}
                          >
                            {MEDIA_COMPOSITION_TRANSITION_CATEGORY_OPTIONS.map((category) => (
                              <optgroup key={category.id} label={category.label}>
                                {category.transitions.map((transitionName) => <option key={transitionName} value={transitionName}>{formatMediaCompositionTransitionLabel(transitionName)}</option>)}
                              </optgroup>
                            ))}
                          </select>
                        </div>
                      ) : null}
                      {getMediaCompositionTransitionMode(selectedNode.config?.sceneTransitionMode) === 'randomCategory' ? (
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-transition-category">Transition category</label>
                          <select
                            className="store-input mt-3"
                            id="media-composition-transition-category"
                            onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, sceneTransitionCategory: getMediaCompositionTransitionCategory(event.target.value) } }))}
                            value={getMediaCompositionTransitionCategory(selectedNode.config?.sceneTransitionCategory)}
                          >
                            {MEDIA_COMPOSITION_TRANSITION_CATEGORY_OPTIONS.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}
                          </select>
                        </div>
                      ) : null}
                      {getMediaCompositionTransitionMode(selectedNode.config?.sceneTransitionMode) === 'randomSelected' ? (
                        <div>
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Selected transitions</p>
                          <div className="mt-3 max-h-56 overflow-y-auto border border-white/10 bg-slate-950/30 p-3">
                            {MEDIA_COMPOSITION_TRANSITION_CATEGORY_OPTIONS.map((category) => (
                              <div className="mb-4 last:mb-0" key={category.id}>
                                <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{category.label}</p>
                                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                  {category.transitions.map((transitionName) => {
                                    const selectedTransitions = getMediaCompositionSelectedTransitions(selectedNode.config?.sceneTransitionSelected);
                                    return (
                                      <label className="flex items-center gap-2 text-sm text-slate-300" htmlFor={`media-composition-transition-selected-${transitionName}`} key={transitionName}>
                                        <input
                                          checked={selectedTransitions.includes(transitionName)}
                                          className="h-4 w-4 accent-cyan-300"
                                          id={`media-composition-transition-selected-${transitionName}`}
                                          onChange={(event) => updateNode(selectedNode.id, (currentNode) => {
                                            const currentSelected = getMediaCompositionSelectedTransitions(currentNode.config?.sceneTransitionSelected);
                                            const nextSelected = event.target.checked
                                              ? [...new Set([...currentSelected, transitionName])]
                                              : currentSelected.filter((entry) => entry !== transitionName);
                                            return { ...currentNode, config: { ...currentNode.config, sceneTransitionSelected: nextSelected.length ? nextSelected : ['fade'] } };
                                          })}
                                          type="checkbox"
                                        />
                                        <span>{formatMediaCompositionTransitionLabel(transitionName)}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {getMediaCompositionTransitionMode(selectedNode.config?.sceneTransitionMode) === 'randomCategory' || getMediaCompositionTransitionMode(selectedNode.config?.sceneTransitionMode) === 'randomSelected' ? (
                        <label className="flex items-center gap-3 text-sm text-slate-300" htmlFor="media-composition-transition-avoid-repeats">
                          <input
                            checked={selectedNode.config?.sceneTransitionAvoidRepeats !== false}
                            className="h-4 w-4 accent-cyan-300"
                            id="media-composition-transition-avoid-repeats"
                            onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, sceneTransitionAvoidRepeats: event.target.checked } }))}
                            type="checkbox"
                          />
                          <span>Avoid immediate repeats</span>
                        </label>
                      ) : null}
                    </div>
                    ) : null}
                    <div className="space-y-3 border-t border-white/10 pt-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <label className="flex items-center gap-3 text-sm font-medium text-slate-200" htmlFor="media-composition-sfx-enabled">
                          <input
                            checked={selectedNode.config?.soundEffectsEnabled === true}
                            className="h-4 w-4 accent-cyan-300"
                            id="media-composition-sfx-enabled"
                            onChange={(event) => updateNode(selectedNode.id, (currentNode) => {
                              const currentLayers = getMediaCompositionSoundEffectsLayersForUi(currentNode.config || {}, soundEffectLibraries);
                              const nextLayers = event.target.checked && !currentLayers.length
                                ? [createMediaCompositionSoundEffectsLayer(soundEffectLibraries, 0)]
                                : currentLayers;
                              return {
                                ...currentNode,
                                config: {
                                  ...currentNode.config,
                                  soundEffectsEnabled: event.target.checked,
                                  soundEffectsLayers: nextLayers,
                                },
                              };
                            })}
                            type="checkbox"
                          />
                          <span>Enable sound effects</span>
                        </label>
                        {selectedNode.config?.soundEffectsEnabled === true ? (
                          <button
                            className="ghost-button px-3 py-1.5 text-xs"
                            onClick={() => updateNode(selectedNode.id, (currentNode) => {
                              const currentLayers = getMediaCompositionSoundEffectsLayersForUi(currentNode.config || {}, soundEffectLibraries);
                              return {
                                ...currentNode,
                                config: {
                                  ...currentNode.config,
                                  soundEffectsEnabled: true,
                                  soundEffectsLayers: [...currentLayers, createMediaCompositionSoundEffectsLayer(soundEffectLibraries, currentLayers.length)],
                                },
                              };
                            })}
                            type="button"
                          >
                            Add SFX layer
                          </button>
                        ) : null}
                      </div>
                      {selectedNode.config?.soundEffectsEnabled === true ? (
                        <div className="space-y-3">
                          {!soundEffectLibraries.length ? <p className="text-xs leading-5 text-slate-400">Create a Sound Effects library in Settings &gt; Asset Libraries.</p> : null}
                          <div className="rounded-[18px] border border-white/10 bg-white/5 px-4 py-3">
                            <label className="flex items-center gap-3 text-sm text-slate-300" htmlFor="media-composition-sfx-global-guard">
                              <input
                                checked={selectedNode.config?.soundEffectsGlobalGuardEnabled === true}
                                className="h-4 w-4 accent-cyan-300"
                                id="media-composition-sfx-global-guard"
                                onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                                  ...currentNode,
                                  config: {
                                    ...currentNode.config,
                                    soundEffectsGlobalGuardEnabled: event.target.checked,
                                    soundEffectsGlobalMaxSimultaneous: currentNode.config?.soundEffectsGlobalMaxSimultaneous ?? DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS,
                                    soundEffectsGlobalMinSpacingSeconds: currentNode.config?.soundEffectsGlobalMinSpacingSeconds ?? DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS,
                                  },
                                }))}
                                type="checkbox"
                              />
                              <span>Prevent SFX from overlapping across layers</span>
                            </label>
                            {selectedNode.config?.soundEffectsGlobalGuardEnabled === true ? (
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <div>
                                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-sfx-global-spacing">Minimum seconds across layers</label>
                                  <input className="store-input mt-3" id="media-composition-sfx-global-spacing" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, soundEffectsGlobalMinSpacingSeconds: normalizeSoundEffectsSpacing(event.target.value, DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS) } }))} step="0.1" type="number" value={selectedNode.config?.soundEffectsGlobalMinSpacingSeconds ?? DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS} />
                                </div>
                                <div>
                                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-sfx-global-simultaneous">Max simultaneous across layers</label>
                                  <input className="store-input mt-3" id="media-composition-sfx-global-simultaneous" min="1" max="8" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, soundEffectsGlobalMaxSimultaneous: normalizeSoundEffectsGlobalMaxSimultaneous(event.target.value) } }))} step="1" type="number" value={selectedNode.config?.soundEffectsGlobalMaxSimultaneous ?? DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS} />
                                </div>
                              </div>
                            ) : null}
                          </div>
                          {selectedSoundEffectsLayers.length ? selectedSoundEffectsLayers.map((layer, index) => {
                            const updateLayer = (patch) => updateNode(selectedNode.id, (currentNode) => {
                              const currentLayers = getMediaCompositionSoundEffectsLayersForUi(currentNode.config || {}, soundEffectLibraries);
                              const nextLayers = currentLayers.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry));
                              return {
                                ...currentNode,
                                config: {
                                  ...currentNode.config,
                                  soundEffectsEnabled: true,
                                  soundEffectsLayers: nextLayers,
                                },
                              };
                            });
                            const selectedLayerLibrary = soundEffectLibraries.find((library) => library.id === layer.libraryId) || null;
                            return (
                              <div className="rounded-[18px] border border-white/10 bg-white/5 px-4 py-3" key={layer.id || index}>
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">SFX layer {index + 1}</p>
                                  <button
                                    className="ghost-button px-2 py-1 text-xs"
                                    onClick={() => updateNode(selectedNode.id, (currentNode) => {
                                      const currentLayers = getMediaCompositionSoundEffectsLayersForUi(currentNode.config || {}, soundEffectLibraries);
                                      return {
                                        ...currentNode,
                                        config: {
                                          ...currentNode.config,
                                          soundEffectsEnabled: true,
                                          soundEffectsLayers: currentLayers.filter((entry, entryIndex) => entryIndex !== index),
                                        },
                                      };
                                    })}
                                    type="button"
                                  >
                                    Remove
                                  </button>
                                </div>
                                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                  <div>
                                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`media-composition-sfx-layer-name-${index}`}>Layer name</label>
                                    <input className="store-input mt-3" id={`media-composition-sfx-layer-name-${index}`} onChange={(event) => updateLayer({ name: event.target.value })} value={layer.name || `Layer ${index + 1}`} />
                                  </div>
                                  <div>
                                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`media-composition-sfx-library-${index}`}>Sound Effects library</label>
                                    <select
                                      className="store-input mt-3"
                                      disabled={!soundEffectLibraries.length}
                                      id={`media-composition-sfx-library-${index}`}
                                      onChange={(event) => updateLayer({ libraryId: event.target.value })}
                                      value={layer.libraryId || soundEffectLibraries[0]?.id || ''}
                                    >
                                      {!soundEffectLibraries.length ? <option value="">No Sound Effects libraries</option> : null}
                                      {soundEffectLibraries.map((library) => <option key={library.id} value={library.id}>{library.name} ({library.items?.length || 0})</option>)}
                                    </select>
                                  </div>
                                  <div>
                                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`media-composition-sfx-mode-${index}`}>Scheduling mode</label>
                                    <select className="store-input mt-3" id={`media-composition-sfx-mode-${index}`} onChange={(event) => updateLayer({ schedulingMode: getMediaCompositionSoundEffectsMode(event.target.value) })} value={getMediaCompositionMode(selectedNode) === MEDIA_COMPOSITION_MODES.SINGLE_VIDEO_MIX ? 'randomInterval' : getMediaCompositionSoundEffectsMode(layer.schedulingMode)}>
                                      {MEDIA_COMPOSITION_SOUND_EFFECTS_MODE_OPTIONS.filter(([value]) => getMediaCompositionMode(selectedNode) !== MEDIA_COMPOSITION_MODES.SINGLE_VIDEO_MIX || value === 'randomInterval').map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
                                    </select>
                                    {getMediaCompositionMode(selectedNode) === MEDIA_COMPOSITION_MODES.SINGLE_VIDEO_MIX ? <p className="mt-2 text-xs leading-5 text-slate-400">Single video mix supports timeline-based random SFX timing only.</p> : null}
                                  </div>
                                  <div>
                                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`media-composition-sfx-density-${index}`}>Frequency</label>
                                    <select className="store-input mt-3" id={`media-composition-sfx-density-${index}`} onChange={(event) => updateLayer({ density: getMediaCompositionSoundEffectsDensity(event.target.value) })} value={getMediaCompositionSoundEffectsDensity(layer.density)}>
                                      {MEDIA_COMPOSITION_SOUND_EFFECTS_DENSITY_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}
                                    </select>
                                  </div>
                                  <div>
                                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`media-composition-sfx-spacing-${index}`}>Minimum seconds between effects</label>
                                    <input className="store-input mt-3" id={`media-composition-sfx-spacing-${index}`} min="0" onChange={(event) => updateLayer({ minSpacingSeconds: normalizeSoundEffectsSpacing(event.target.value, 4) })} step="0.5" type="number" value={layer.minSpacingSeconds ?? 4} />
                                  </div>
                                  <div>
                                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`media-composition-sfx-simultaneous-${index}`}>Max simultaneous effects</label>
                                    <input className="store-input mt-3" id={`media-composition-sfx-simultaneous-${index}`} min="1" max="8" onChange={(event) => updateLayer({ maxSimultaneous: Math.max(1, Math.min(8, Math.floor(Number(event.target.value || 0) || 2))) })} step="1" type="number" value={layer.maxSimultaneous ?? 2} />
                                  </div>
                                  <div>
                                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`media-composition-sfx-volume-${index}`}>Layer volume</label>
                                    <div className="mt-3 flex items-center gap-3">
                                      <input className="min-w-0 flex-1 accent-cyan-300" id={`media-composition-sfx-volume-${index}`} max="200" min="0" onChange={(event) => updateLayer({ volume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME) })} step="1" type="range" value={formatVolumePercent(layer.volume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME)} />
                                      <input className="store-input w-24" max="200" min="0" onChange={(event) => updateLayer({ volume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME) })} step="1" type="number" value={formatVolumePercent(layer.volume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME)} />
                                    </div>
                                  </div>
                                  <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="flex items-center gap-3 pt-7 text-sm text-slate-300" htmlFor={`media-composition-sfx-avoid-repeats-${index}`}><input checked={layer.avoidRepeats !== false} className="h-4 w-4 accent-cyan-300" id={`media-composition-sfx-avoid-repeats-${index}`} onChange={(event) => updateLayer({ avoidRepeats: event.target.checked })} type="checkbox" />Avoid repeats</label>
                                    <div>
                                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`media-composition-sfx-fade-${index}`}>Fade seconds</label>
                                      <input className="store-input mt-3" id={`media-composition-sfx-fade-${index}`} min="0" max="2" onChange={(event) => updateLayer({ fadeSeconds: normalizeSoundEffectsSpacing(event.target.value, 0.05) })} step="0.05" type="number" value={layer.fadeSeconds ?? 0.05} />
                                    </div>
                                  </div>
                                  <div>
                                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`media-composition-sfx-seed-${index}`}>Seed</label>
                                    <input className="store-input mt-3" id={`media-composition-sfx-seed-${index}`} onChange={(event) => updateLayer({ seed: event.target.value })} placeholder="Deterministic default" value={layer.seed || ''} />
                                  </div>
                                </div>
                                {selectedLayerLibrary?.items?.length ? <p className="mt-3 text-xs leading-5 text-slate-400">Uses managed files from {selectedLayerLibrary.name}; source import paths are not used.</p> : null}
                              </div>
                            );
                          }) : (
                            <div className="rounded-[18px] border border-dashed border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-400">
                              Add at least one SFX layer before running with sound effects enabled.
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {getMediaCompositionMode(selectedNode) !== MEDIA_COMPOSITION_MODES.IMAGE_SLIDESHOW ? <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-source-video-volume">Source video volume</label>
                        <div className="mt-3 flex items-center gap-3">
                          <input className="min-w-0 flex-1 accent-cyan-300" id="media-composition-source-video-volume" max="200" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, sourceVideoVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME) } }))} step="1" type="range" value={formatVolumePercent(selectedNode.config?.sourceVideoVolume, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME)} />
                          <input className="store-input w-24" max="200" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, sourceVideoVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME) } }))} step="1" type="number" value={formatVolumePercent(selectedNode.config?.sourceVideoVolume, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME)} />
                        </div>
                      </div> : null}
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-narration-volume">Narration volume</label>
                        <div className="mt-3 flex items-center gap-3">
                          <input className="min-w-0 flex-1 accent-cyan-300" id="media-composition-narration-volume" max="200" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, narrationVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME) } }))} step="1" type="range" value={formatVolumePercent(selectedNode.config?.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME)} />
                          <input className="store-input w-24" max="200" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, narrationVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME) } }))} step="1" type="number" value={formatVolumePercent(selectedNode.config?.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME)} />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-composition-background-volume">Background music volume</label>
                        <div className="mt-3 flex items-center gap-3">
                          <input className="min-w-0 flex-1 accent-cyan-300" id="media-composition-background-volume" max="200" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, backgroundMusicVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME) } }))} step="1" type="range" value={formatVolumePercent(selectedNode.config?.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME)} />
                          <input className="store-input w-24" max="200" min="0" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, backgroundMusicVolume: normalizeVolumeGain(Number(event.target.value || 0) / 100, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME) } }))} step="1" type="number" value={formatVolumePercent(selectedNode.config?.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME)} />
                        </div>
                      </div>
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      {getMediaCompositionMode(selectedNode) === MEDIA_COMPOSITION_MODES.VIDEO_SEQUENCE
                        ? 'Connect an ordered video collection. Export normalizes the clips, preserves available clip audio, applies optional transitions, and mixes connected narration, music, and sound effects.'
                        : getMediaCompositionMode(selectedNode) === MEDIA_COMPOSITION_MODES.SINGLE_VIDEO_MIX
                          ? 'Connect one existing video. Export preserves its video and available source audio, then mixes connected narration, background music, and timeline-based sound effects.'
                          : 'Connect an ordered image collection and optionally add narration plus background music. Export applies the selected timing, transition, and volume settings.'}
                    </div>
                  </div>
                ) : null}
                {selectedNode.type === 'mediaExport' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-export-title">Export title</label>
                      <input className="store-input mt-3" id="media-export-title" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, title: event.target.value } }))} value={selectedNode.config?.title || ''} />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-export-width">Width</label>
                        <input className="store-input mt-3" id="media-export-width" min="16" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, width: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.width || 1280} />
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-export-height">Height</label>
                        <input className="store-input mt-3" id="media-export-height" min="16" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, height: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.height || 720} />
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-export-fps">FPS</label>
                        <input className="store-input mt-3" id="media-export-fps" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, fps: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.fps || 30} />
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-export-fit">Image fit</label>
                        <select className="store-input mt-3" id="media-export-fit" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, fitMode: event.target.value === 'cover' ? 'cover' : 'contain' } }))} value={selectedNode.config?.fitMode === 'cover' ? 'cover' : 'contain'}>
                          <option value="contain">Contain and pad</option>
                          <option value="cover">Cover and crop</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="media-export-stop">When tracks differ</label>
                        <select className="store-input mt-3" id="media-export-stop" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, stopMode: event.target.value === 'visuals' ? 'visuals' : 'shortest' } }))} value={selectedNode.config?.stopMode === 'visuals' ? 'visuals' : 'shortest'}>
                          <option value="shortest">Stop when the shortest track ends</option>
                          <option value="visuals">Keep the full visual timing</option>
                        </select>
                      </div>
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Media Export renders image slideshows, normalized video sequences, or a single existing video to MP4. It preserves available source video audio and applies the narration, background music, and sound effect levels saved on Media Composition.
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'branchMerge' ? (
                  <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                    Connect compatible branches here. Local AI Hub waits for earlier branches to finish or skip, then forwards the single branch that still has an artifact. When this merge is the retry target for a Retry Loop, the first attempt uses the connected branch and later attempts can re-enter with the loop-carried retry artifact. If two unrelated live results arrive together, the run stops with a plain-English error so the merge stays explicit.
                  </div>
                ) : null}

                {selectedNode.type === 'collectionOutput' ? (
                  <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                    This output writes an ordered collection folder with a manifest and keeps each item in order so you can inspect or reuse the result later.
                  </div>
                ) : null}

                {selectedNode.type === 'planOutput' ? (
                  <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                    This output writes the typed Plan artifact to a local JSON file so you can inspect the plan, reuse it downstream, or version it outside the builder.
                  </div>
                ) : null}

                {selectedNode.type.endsWith('Output') ? (
                  <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="output-title">Output title</label><input className="store-input mt-3" id="output-title" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, title: event.target.value } }))} value={selectedNode.config?.title || ''} /></div>
                ) : null}

                <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Connections</p>
                  <div className="mt-3 space-y-3">
                    {draft.edges.filter((edge) => edge.source.nodeId === selectedNode.id || edge.target.nodeId === selectedNode.id).length ? draft.edges.filter((edge) => edge.source.nodeId === selectedNode.id || edge.target.nodeId === selectedNode.id).map((edge) => {
                      const sourceNode = draft.nodes.find((node) => node.id === edge.source.nodeId);
                      const targetNode = draft.nodes.find((node) => node.id === edge.target.nodeId);
                      const sourcePort = getPortDefinition(sourceNode, 'output', edge.source.portId);
                      const targetPort = getPortDefinition(targetNode, 'input', edge.target.portId);
                      return (
                        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3" key={edge.id}>
                          <p className="text-sm font-medium text-white">{sourceNode?.label || 'Unknown'}: <span className="text-slate-400">{sourcePort?.label || edge.source.portId}</span></p>
                          <p className="mt-1 text-sm text-slate-300">to {targetNode?.label || 'Unknown'}: <span className="text-slate-400">{targetPort?.label || edge.target.portId}</span></p>
                          <button className="ghost-button mt-3 px-3 py-1.5 text-xs" onClick={() => removeEdge(edge.id)} type="button">Remove connection</button>
                        </div>
                      );
                    }) : <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-3 py-4 text-sm leading-6 text-slate-400">This node has no connections yet.</div>}
                  </div>
                </div>

                <button className="ghost-button w-full justify-center" onClick={() => removeNode(selectedNode.id)} type="button">Delete node</button>
                </div>
              </PipelineInspectorErrorBoundary>
            ) : <div className="mt-4 rounded-[24px] border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">Select a node on the canvas to edit its settings and inspect its connections.</div>) : null}
          </div>

          <div className={getPipelineSectionPanelClass(sectionVisibility.canvas)}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Canvas</p>
                <p className="mt-2 text-lg font-semibold text-white">Navigate large pipeline graphs without losing node interaction</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                {sectionVisibility.canvas ? <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">Blank space drags the viewport. The mouse wheel zooms while the cursor is over the canvas.</span> : null}
                <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1.5 text-slate-200">{Math.round(canvasZoom * 100)}%</span>
                <button className="ghost-button px-3 py-1.5 text-xs" onClick={resetCanvasView} type="button">Reset view</button>
                {selectedEdge ? <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => removeEdge(selectedEdge.id)} type="button">Disconnect selected link</button> : null}
                {pendingConnection ? <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setPendingConnection(null)} type="button">Cancel connection</button> : null}
                <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => toggleSection('canvas')} type="button">
                  {sectionVisibility.canvas ? 'Collapse' : 'Expand'}
                </button>
              </div>
            </div>

            {sectionVisibility.canvas ? (
              <div className="mt-3 rounded-[24px] border border-white/10 bg-slate-950/30 p-2">
                <div
                  className="relative h-[min(66vh,760px)] min-h-[460px] overflow-auto rounded-[22px] border border-dashed border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(67,171,255,0.08),transparent_24%),linear-gradient(180deg,rgba(7,15,26,0.96),rgba(5,10,18,0.96))]"
                  onMouseDown={handleCanvasMouseDown}
                  onWheel={handleCanvasWheel}
                  ref={canvasRef}
                  style={{ cursor: canvasPanning ? 'grabbing' : 'grab' }}
                >
                  <div className="relative" style={{ height: `${scaledCanvasSize.height}px`, width: `${scaledCanvasSize.width}px` }}>
                    <div className="relative origin-top-left" ref={graphSurfaceRef} style={{ height: `${canvasSize.height}px`, transform: `scale(${canvasZoom})`, transformOrigin: 'top left', width: `${canvasSize.width}px` }}>
                      <svg className="absolute inset-0 h-full w-full">
                        {graphEdges.map((edge) => {
                          const sourceNode = graph.nodeMap.get(edge.source.nodeId);
                          const targetNode = graph.nodeMap.get(edge.target.nodeId);
                          const sourceIndex = getPipelineNodePorts(sourceNode, 'output').findIndex((port) => port.id === edge.source.portId);
                          const targetIndex = getPipelineNodePorts(targetNode, 'input').findIndex((port) => port.id === edge.target.portId);
                          const sourcePoint = getRenderedOrEstimatedPortCenter(sourceNode, 'output', edge.source.portId, sourceIndex);
                          const targetPoint = getRenderedOrEstimatedPortCenter(targetNode, 'input', edge.target.portId, targetIndex);
                          const curveOffset = Math.max(80, (targetPoint.x - sourcePoint.x) / 2);
                          const pathValue = `M ${sourcePoint.x} ${sourcePoint.y} C ${sourcePoint.x + curveOffset} ${sourcePoint.y}, ${targetPoint.x - curveOffset} ${targetPoint.y}, ${targetPoint.x} ${targetPoint.y}`;
                          const selected = selectedEdge?.id === edge.id;
                          return (
                            <g key={edge.id}>
                              <path
                                d={pathValue}
                                data-canvas-interactive="true"
                                fill="none"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setPendingConnection(null);
                                  setSelectedEdgeId(edge.id);
                                  setSelectedNodeId('');
                                }}
                                onMouseDown={(event) => event.stopPropagation()}
                                pointerEvents="stroke"
                                stroke="transparent"
                                strokeWidth="16"
                                style={{ cursor: 'pointer' }}
                              />
                              <path
                                d={pathValue}
                                fill="none"
                                pointerEvents="none"
                                stroke={selected ? 'rgba(147, 226, 255, 0.98)' : 'rgba(103, 214, 255, 0.58)'}
                                strokeWidth={selected ? '5' : '3'}
                              />
                            </g>
                          );
                        })}
                      </svg>

                      {draft.nodes.length ? draft.nodes.map((node) => {
                        const definition = getPipelineNodeDefinition(node.type);
                        const inputPorts = getPipelineNodePorts(node, 'input');
                        const outputPorts = getPipelineNodePorts(node, 'output');
                        const rowCount = Math.max(inputPorts.length, outputPorts.length, 1);
                        const nodeRunState = runState?.nodeStates?.[node.id];
                        const nodeSummary = analysis.nodeSummaries?.[node.id];
                        const preview = buildNodePreview(node, runState);
                        return (
                          <div
                            className={`absolute rounded-[28px] border bg-[#0f1825]/96 shadow-soft ${selectedNodeId === node.id ? 'border-cyan-300/45' : 'border-white/10'}`}
                            data-canvas-interactive="true"
                            data-pipeline-node-card="true"
                            key={node.id}
                            onClick={() => { setSelectedEdgeId(''); setSelectedNodeId(node.id); }}
                            style={{ left: `${node.position.x}px`, minHeight: `${getNodeCardHeight(node)}px`, top: `${node.position.y}px`, width: `${PIPELINE_NODE_WIDTH}px` }}
                          >
                            <div className="flex cursor-grab items-start justify-between gap-3 rounded-t-[28px] border-b border-white/10 px-4 py-4" onMouseDown={(event) => startDrag(node.id, event)} role="presentation">
                              <div>
                                <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{definition?.category || 'Node'}</p>
                                <p className="mt-1 text-sm font-semibold text-white">{node.label}</p>
                              </div>
                              <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${runStatusClassName(nodeRunState?.status || 'queued')}`}>
                                {nodeRunState?.status || 'idle'}
                              </span>
                            </div>
                            <div className="px-4 pt-4">
                              {Array.from({ length: rowCount }).map((_, index) => {
                                const inputPort = inputPorts[index] || null;
                                const outputPort = outputPorts[index] || null;
                                const inputConnectionCount = inputPort ? getIncomingConnectionCount(graph, node.id, inputPort.id) : 0;
                                const allowsMultipleInputConnections = Boolean(inputPort?.allowMultipleConnections);
                                return (
                                  <div className="grid h-9 grid-cols-2 items-center gap-4" key={`${node.id}-row-${index}`}>
                                    <div className="flex min-w-0 items-center gap-2">
                                      {inputPort ? (
                                        <button
                                          className={`flex max-w-full items-center gap-2 rounded-full border px-2 py-1 text-left text-[11px] uppercase tracking-[0.16em] transition ${pendingConnection && isPendingConnectionCompatible(node, inputPort) ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-400 hover:border-cyan-300/25 hover:bg-white/10'}`}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            if (!pendingConnection) {
                                              setSelectedEdgeId('');
                                              setSelectedNodeId(node.id);
                                              return;
                                            }
                                            connectPorts(pendingConnection.sourceNodeId, pendingConnection.sourcePortId, node.id, inputPort.id);
                                          }}
                                          type="button"
                                        >
                                          <span className="h-2.5 w-2.5 rounded-full bg-white/70" data-node-id={node.id} data-pipeline-port-dot="true" data-port-direction="input" data-port-id={inputPort.id} />
                                          <HoverRevealText className="min-w-0 truncate" revealClassName="hover-reveal-port-popover hover-reveal-port-popover-input" rootClassName="hover-reveal-port-text" text={inputPort.label} />
                                          {allowsMultipleInputConnections ? <span className="rounded-full border border-white/10 bg-slate-950/50 px-2 py-0.5 text-[10px] text-slate-200">{inputConnectionCount}</span> : null}
                                        </button>
                                      ) : null}
                                    </div>
                                    <div className="flex min-w-0 items-center justify-end gap-2">
                                      {outputPort ? (
                                        <button
                                          className={`flex max-w-full items-center gap-2 rounded-full border px-2 py-1 text-right text-[11px] uppercase tracking-[0.16em] transition ${pendingConnection?.sourceNodeId === node.id && pendingConnection?.sourcePortId === outputPort.id ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-400 hover:border-cyan-300/25 hover:bg-white/10'}`}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            setSelectedEdgeId('');
                                            setPendingConnection({
                                              isDynamic: outputPort.kind === 'passthrough' || outputPort.kind === 'any',
                                              kind: outputPort.kind,
                                              sourceNodeId: node.id,
                                              sourcePortId: outputPort.id,
                                            });
                                          }}
                                          type="button"
                                        >
                                          <HoverRevealText className="min-w-0 truncate" revealClassName="hover-reveal-port-popover hover-reveal-port-popover-output" rootClassName="hover-reveal-port-text" text={outputPort.label} />
                                          <span className="h-2.5 w-2.5 rounded-full bg-cyan-300" data-node-id={node.id} data-pipeline-port-dot="true" data-port-direction="output" data-port-id={outputPort.id} />
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <div className="mt-3 border-t border-white/10 px-4 py-3">
                              <div className={`rounded-2xl border px-3 py-2 text-xs ${toneToClassName(nodeSummary?.readiness?.tone || nodeSummary?.compatibility?.tone || 'neutral')}`}>
                                <p className="font-semibold text-white">{nodeSummary?.readiness?.message || nodeSummary?.compatibility?.message || 'Ready.'}</p>
                                {nodeSummary?.capabilitySummary ? <p className="mt-1 leading-5 text-slate-300">{nodeSummary.capabilitySummary.message}</p> : null}
                                {preview ? <p className="mt-1 leading-5 text-slate-200">{preview}</p> : null}
                              </div>
                            </div>
                          </div>
                        );
                      }) : (
                        <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-7 text-slate-400">Add a few nodes from the palette to start building a pipeline.</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className={getPipelineSectionPanelClass(sectionVisibility.runStatus)}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Runtime status</p>
                <p className="mt-2 text-lg font-semibold text-white">Sequential execution timeline</p>
              </div>
              <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => toggleSection('runStatus')} type="button">
                {sectionVisibility.runStatus ? 'Collapse' : 'Expand'}
              </button>
            </div>
            {sectionVisibility.runStatus ? (
              <div className="mt-4">
                <PipelineTimeline
                  draft={draft}
                  onCancelRecordInput={() => runRecordInputAction('cancel')}
                  onChangeValidationComment={setValidationComment}
                  onChangeValidationRetryOverride={handleValidationRetryOverrideChange}
                  onDecideValidation={handleValidationDecision}
                  onOpenPath={openPath}
                  onRevealPath={(pathValue) => openPath(pathValue, true)}
                  onStartRecordInput={() => runRecordInputAction('start')}
                  onStopRecordInput={() => runRecordInputAction('stop')}
                  recordInputBusy={recordInputBusy}
                  runState={runState}
                  validationBusy={validationBusy}
                  validationComment={validationComment}
                  validationRetryOverrides={validationRetryOverrides}
                  recordingDevices={recordingDevices}
                  recordingDisplays={recordingDisplays}
                  recordingDevicesBusy={recordingDevicesBusy}
                  recordingDisplaysBusy={recordingDisplaysBusy}
                  onRefreshRecordingDevices={() => loadRecordingDevices(true)}
                  onRefreshRecordingDisplays={loadRecordingDisplays}
                  onSelectRecordInputRegion={selectValidationRecordInputRegion}
                  fontLibraries={fontLibraries}
                  colorPaletteLibraries={colorPaletteLibraries}
                />
              </div>
            ) : null}
          </div>

          <PipelineOutputDeletionDialog
            busy={Boolean(outputsBusyPath)}
            dialog={outputDeletionDialog}
            onClose={() => setOutputDeletionDialog(null)}
            onConfirm={confirmDeleteOutput}
            onToggleIntermediates={(checked) => setOutputDeletionDialog((current) => current ? { ...current, includeIntermediates: checked } : current)}
          />
          <PipelineOutputsPanel
            className={pipelineOutputsExpanded ? 'xl:col-span-2 2xl:col-span-3' : ''}
            busyPath={outputsBusyPath}
            expanded={pipelineOutputsExpanded}
            loading={outputsLoading}
            onDelete={handleDeleteOutput}
            onOpenPath={openPath}
            onRefresh={() => loadPipelineOutputs()}
            onRevealPath={(pathValue) => openPath(pathValue, true)}
            onToggleExpanded={() => setPipelineOutputsExpanded((current) => !current)}
            outputs={pipelineOutputs}
          />
      </>
      </div>
        </div>
    </section>
  );
}


