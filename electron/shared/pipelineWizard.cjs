const {
  AUDIO_TRANSFORM_TOOL_IDS,
  AUDIO_WORKFLOW_TOOL_IDS,
  DEFAULT_PLANNING_SCHEMA_ID,
  GRAPH_WORKFLOW_TOOL_IDS,
  IMAGE_TRANSFORM_TOOL_IDS,
  IMAGE_WORKFLOW_TOOL_IDS,
  NODE_TYPE_LIST,
  PIPELINE_OPERATION_IDS,
  PIPELINE_RETRY_LOOP_MAX_ATTEMPTS,
  VIDEO_WORKFLOW_TOOL_IDS,
  analyzePipeline,
  buildContextMaps,
  buildPipelineGraph,
  createEdge,
  createEmptyPipeline,
  createNode,
  evaluateCompatibilityProfile,
  getNodeTypeDefinition,
  getPlanningSchemaOptions,
  normalizePipelineDefinition,
  selectLocalImageBackend,
  trimPreviewText,
} = require('./pipelineSchema.cjs');
const {
  doesProviderOperationRequireExplicitModel,
  getProviderModelCapabilities,
  getProviderPipelineOperation,
  getToolPipelineOperation,
} = require('./pipelineCapabilities.cjs');

const WIZARD_PLAN_SCHEMA_VERSION = 1;
const WIZARD_INTENT_IR_SCHEMA_VERSION = 1;

const WIZARD_RECIPE_IDS = Object.freeze({
  TEXT_RESPONSE: 'text-response',
  TEXT_TO_IMAGE: 'text-to-image',
  TEXT_TO_AUDIO: 'text-to-audio',
  TEXT_TO_VIDEO: 'text-to-video',
  IMAGE_TO_TEXT: 'image-to-text',
  IMAGE_TRANSFORM: 'image-transform',
  AUDIO_TRANSCRIBE: 'audio-transcribe',
  AUDIO_TRANSFORM: 'audio-transform',
  SCENE_PLAN: 'scene-plan',
});

const OUTPUT_NODE_BY_KIND = Object.freeze({
  audio: 'audioOutput',
  image: 'imageOutput',
  text: 'textOutput',
  video: 'videoOutput',
  file: 'fileOutput',
  'collection:text': 'collectionOutput',
  'collection:image': 'collectionOutput',
  'collection:audio': 'collectionOutput',
  'collection:video': 'collectionOutput',
  'collection:file': 'collectionOutput',
});

const WIZARD_INTENT_STAGE_KINDS = Object.freeze([
  'plan',
  'plan_scenes',
  'build_collection',
  'llm_generate_text',
  'generate_image',
  'generate_audio',
  'transform_audio',
  'generate_video',
  'transform_image',
  'transcribe_audio',
  'validate',
  'retry',
  'normalize_media',
  'trim_media',
  'extract_audio',
  'extract_video_frame',
  'export_subtitles',
  'stitch_audio',
  'stitch_video',
  'compose_media',
  'burn_subtitles',
  'export',
]);

const WIZARD_CLOUD_IMAGE_PROVIDER_IDS = Object.freeze(['openai', 'google', 'xai']);
const WIZARD_CLOUD_VIDEO_PROVIDER_IDS = Object.freeze(['google', 'xai']);
const WIZARD_OPERATION_SUBTYPES = Object.freeze(['textToImage', 'imageToImage', 'textToVideo', 'imageToVideo', 'referenceVoiceTts']);
const WIZARD_COLLECTION_MAPPING_MODES = Object.freeze(['textToImage', 'cloudImageToImage', 'textToVideo', 'cloudImageToVideo', 'textToAudio']);
const WIZARD_NORMALIZE_MEDIA_KINDS = Object.freeze(['audio', 'video', 'image']);
const WIZARD_NORMALIZE_FORMATS_BY_KIND = Object.freeze({
  audio: Object.freeze(['auto', 'normalized', 'wav', 'mp3', 'flac', 'ogg', 'm4a']),
  video: Object.freeze(['auto', 'normalized', 'mp4', 'webm', 'mov', 'mkv']),
  image: Object.freeze(['auto', 'normalized', 'png', 'jpg', 'jpeg', 'webp', 'bmp']),
});
const WIZARD_INTENT_SOURCE_MODALITIES = Object.freeze(['text', 'image', 'audio', 'video', 'file', 'collection:text', 'collection:image', 'collection:audio', 'collection:video', 'collection:file']);

const WIZARD_RECIPE_OPTIONS = Object.freeze([
  Object.freeze({
    id: WIZARD_RECIPE_IDS.TEXT_RESPONSE,
    label: 'Text response',
    summary: 'Text input to one Model Step, then Text Output.',
    mature: true,
  }),
  Object.freeze({
    id: WIZARD_RECIPE_IDS.TEXT_TO_IMAGE,
    label: 'Text to image',
    summary: 'Text input to image generation, then Image Output. Prefers the healthiest compatible local image backend, otherwise a compatible connected provider draft.',
    mature: true,
  }),
  Object.freeze({
    id: WIZARD_RECIPE_IDS.TEXT_TO_AUDIO,
    label: 'Text to audio',
    summary: 'Text input to audio generation, then Audio Output. Prefers installed AudioCraft for music/sound drafts, otherwise compatible connected speech providers.',
    mature: true,
  }),
  Object.freeze({
    id: WIZARD_RECIPE_IDS.TEXT_TO_VIDEO,
    label: 'Text to video',
    summary: 'Text input to video generation, then Video Output. Prefers installed Wan2.1 WebUI, otherwise compatible connected video providers.',
    mature: true,
  }),
  Object.freeze({
    id: WIZARD_RECIPE_IDS.IMAGE_TO_TEXT,
    label: 'Image to text',
    summary: 'Image File input to a vision-capable Model Step, then Text Output. Model vision support may still need user confirmation.',
    mature: true,
  }),
  Object.freeze({
    id: WIZARD_RECIPE_IDS.IMAGE_TRANSFORM,
    label: 'Image transform',
    summary: 'Image File input to local image transform, then Image Output. Prefers installed Upscayl; FaceFusion needs an extra reference image.',
    mature: true,
  }),
  Object.freeze({
    id: WIZARD_RECIPE_IDS.AUDIO_TRANSCRIBE,
    label: 'Audio transcription',
    summary: 'Audio File input to Whisper transcription, then Text Output.',
    mature: true,
  }),
  Object.freeze({
    id: WIZARD_RECIPE_IDS.AUDIO_TRANSFORM,
    label: 'Audio transform',
    summary: 'Audio File input to local audio transformation, then Audio Output. Prefers installed RVC and leaves voice model selection editable.',
    mature: true,
  }),
  Object.freeze({
    id: WIZARD_RECIPE_IDS.SCENE_PLAN,
    label: 'Longform scene plan',
    summary: 'Text input to Planning Packet, Planner, Plan Output, Plan Scenes, and Collection Output. Uses the mature longform scene-planning family only.',
    mature: true,
  }),
]);

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeString(value, fallback = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}

function normalizeModelId(value, fallback = '') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return normalizeString(value.id || value.model || value.modelId || value.name || value.label, fallback);
  }
  return normalizeString(value, fallback);
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeProviderPreference(value) {
  const normalized = normalizeId(value);
  return [...WIZARD_CLOUD_IMAGE_PROVIDER_IDS].includes(normalized) ? normalized : '';
}

function normalizeWizardOperationSubtype(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (normalized === 'texttoimage') return 'textToImage';
  if (normalized === 'imagetoimage' || normalized === 'imageedit' || normalized === 'imageediting') return 'imageToImage';
  if (normalized === 'texttovideo') return 'textToVideo';
  if (normalized === 'imagetovideo') return 'imageToVideo';
  if (normalized === 'referencevoicetts' || normalized === 'voicecloning' || normalized === 'clonevoice') return 'referenceVoiceTts';
  return '';
}

function normalizeWizardCollectionMappingMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (normalized === 'texttoimage') return 'textToImage';
  if (normalized === 'cloudimagetoimage' || normalized === 'imagetoimage') return 'cloudImageToImage';
  if (normalized === 'texttovideo') return 'textToVideo';
  if (normalized === 'cloudimagetovideo' || normalized === 'imagetovideo') return 'cloudImageToVideo';
  if (normalized === 'texttoaudio') return 'textToAudio';
  return '';
}

function normalizeWizardTimingMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (['dynamic', 'dynamicfromimagemetadata', 'matchnarration', 'matchnarrationtiming', 'transcripttiming', 'narrationtiming'].includes(normalized)) return 'dynamicFromImageMetadata';
  if (['fixed', 'fixeddurationperimage', 'secondsperimage'].includes(normalized)) return 'fixedDurationPerImage';
  return '';
}

function normalizeWizardTransitionMode(value, enabled = false) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!normalized && enabled) return 'randomCategory';
  if (['off', 'none', 'false'].includes(normalized)) return 'off';
  if (['single', 'fade', 'fixed'].includes(normalized)) return 'single';
  if (['random', 'randomcategory', 'category'].includes(normalized)) return 'randomCategory';
  if (['randomselected', 'selected'].includes(normalized)) return 'randomSelected';
  return enabled ? 'randomCategory' : '';
}

function normalizeWizardTransitionCategory(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (['wipe', 'wipes'].includes(normalized)) return 'wipes';
  if (['slide', 'slides'].includes(normalized)) return 'slides';
  if (['smoothwipe', 'smoothwipes'].includes(normalized)) return 'smoothWipes';
  if (['shape', 'shapes', 'crop', 'crops', 'shapescrops'].includes(normalized)) return 'shapesCrops';
  if (['open', 'close', 'openscloses'].includes(normalized)) return 'opensCloses';
  if (['diagonal', 'diag'].includes(normalized)) return 'diagonal';
  if (['slice', 'slices'].includes(normalized)) return 'slices';
  if (['blur', 'pixel', 'pixelize', 'blurpixel'].includes(normalized)) return 'blurPixel';
  if (['zoom', 'squeeze', 'squeezezoom'].includes(normalized)) return 'squeezeZoom';
  if (['wind'].includes(normalized)) return 'wind';
  if (['cover'].includes(normalized)) return 'cover';
  if (['reveal'].includes(normalized)) return 'reveal';
  if (['distance', 'radial', 'distanceradial'].includes(normalized)) return 'distanceRadial';
  return 'fades';
}

function normalizeWizardVolume(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(2, Math.round(numeric * 100) / 100));
}

function normalizeWizardSeconds(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0.1, Math.min(60, Math.round(numeric * 10) / 10));
}

function normalizeWizardStringList(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/[,;|]/);
  return entries.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 6);
}

function normalizeWizardMediaCompositionOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const transitionsEnabled = source.transitionsEnabled === true || source.transitions === true || source.sceneTransitions === true;
  const soundEffectsEnabled = source.soundEffectsEnabled === true || source.soundEffects === true;
  return {
    timingMode: normalizeWizardTimingMode(source.timingMode || source.imageTimingMode),
    fallbackSecondsPerImage: normalizeWizardSeconds(source.fallbackSecondsPerImage ?? source.secondsPerImage ?? source.secondsPerItem),
    fixedSecondsPerImage: normalizeWizardSeconds(source.fixedSecondsPerImage ?? source.secondsPerImage ?? source.secondsPerItem),
    transitionsEnabled,
    transitionMode: normalizeWizardTransitionMode(source.transitionMode || source.sceneTransitionMode, transitionsEnabled),
    transitionCategory: normalizeWizardTransitionCategory(source.transitionCategory || source.sceneTransitionCategory),
    narrationVolume: normalizeWizardVolume(source.narrationVolume),
    backgroundMusicVolume: normalizeWizardVolume(source.backgroundMusicVolume),
    soundEffectsEnabled,
    soundEffectsVolume: normalizeWizardVolume(source.soundEffectsVolume),
    soundEffectLibraryRefs: normalizeWizardStringList(source.soundEffectLibraryRefs || source.soundEffectsLibraryRefs || source.soundEffectsLibraries || source.soundEffectLibraries || source.soundEffectsLibrary || source.soundEffectLibraryRef),
  };
}

function normalizeWizardBurnSubtitlesOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const position = String(source.position || '').trim();
  return {
    enabled: source.enabled !== false,
    fontLibraryRef: String(source.fontLibraryRef || source.fontLibrary || source.font || '').trim(),
    colorPaletteRef: String(source.colorPaletteRef || source.colorPalette || source.palette || '').trim(),
    position: ['topLeft', 'topCenter', 'topRight', 'middleLeft', 'middleCenter', 'middleRight', 'bottomLeft', 'bottomCenter', 'bottomRight'].includes(position) ? position : '',
    styleIntent: String(source.styleIntent || source.style || '').trim(),
  };
}

function normalizeWizardMediaKind(value) {
  const normalized = normalizeId(value).replace(/[^a-z0-9]+/g, '');
  if (['audio', 'sound', 'music', 'voice', 'voiceover'].includes(normalized)) return 'audio';
  if (['video', 'movie', 'clip'].includes(normalized)) return 'video';
  if (['image', 'photo', 'picture', 'visual'].includes(normalized)) return 'image';
  return '';
}

function normalizeWizardFormatToken(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/^\.+/, '').replace(/[^a-z0-9]+/g, '');
  if (normalized === 'jpeg') return 'jpg';
  if (normalized === 'normalised') return 'normalized';
  return normalized;
}

function getWizardFormatMediaKind(format) {
  const normalized = normalizeWizardFormatToken(format);
  for (const [kind, formats] of Object.entries(WIZARD_NORMALIZE_FORMATS_BY_KIND)) {
    if (formats.map(normalizeWizardFormatToken).includes(normalized)) {
      return kind;
    }
  }
  return '';
}

function normalizeWizardOutputFormatForKind(kind, value) {
  const mediaKind = normalizeWizardMediaKind(kind);
  const normalized = normalizeWizardFormatToken(value);
  const supported = WIZARD_NORMALIZE_FORMATS_BY_KIND[mediaKind] || [];
  if (!normalized) return { outputFormat: 'auto', unsupportedFormat: '' };
  const matched = supported.find((format) => normalizeWizardFormatToken(format) === normalized);
  if (matched) return { outputFormat: matched === 'jpeg' ? 'jpg' : matched, unsupportedFormat: '' };
  return { outputFormat: 'auto', unsupportedFormat: normalized };
}

function normalizeWizardNormalizeMediaOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mediaKind = normalizeWizardMediaKind(source.mediaKind || source.kind || source.modality);
  const formatResult = normalizeWizardOutputFormatForKind(mediaKind, source.outputFormat || source.format || source.targetFormat);
  return {
    mediaKind,
    outputFormat: formatResult.outputFormat,
    unsupportedFormat: normalizeWizardFormatToken(source.unsupportedFormat || formatResult.unsupportedFormat),
  };
}

function normalizeWizardCollectionValidationOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawScope = String(source.scope || source.validationScope || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const enabled = source.enabled === true || rawScope === 'peritem' || source.perItem === true;
  return {
    enabled,
    scope: enabled ? 'perItem' : rawScope === 'wholecollection' ? 'wholeCollection' : '',
    mode: 'user',
    ruleset: trimPreviewText(normalizeString(source.ruleset || source.rules || ''), 220),
    retryInstruction: trimPreviewText(normalizeString(source.retryInstruction || source.retry || ''), 220),
    maxAttempts: Math.max(1, Math.min(PIPELINE_RETRY_LOOP_MAX_ATTEMPTS, Number(source.maxAttempts || source.attempts || 2) || 2)),
    failMode: normalizeId(source.failMode || source.failureMode) === 'partial' ? 'partial' : 'fail-fast',
  };
}

function parseWizardTimeSeconds(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  const clock = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(raw);
  if (clock) {
    const hours = clock[1] ? Number(clock[1]) : 0;
    return Math.max(0, hours * 3600 + Number(clock[2]) * 60 + Number(clock[3]));
  }
  const numberWordPattern = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?';
  const wordDuration = new RegExp('\\b(' + numberWordPattern + ')\\s*(seconds?|secs?|sec|s|minutes?|mins?|min)\\b').exec(raw);
  if (wordDuration) {
    const amount = parseWizardSmallNumberWord(wordDuration[1]);
    if (amount !== null) return /min/.test(wordDuration[2]) ? amount * 60 : amount;
  }
  const minutesSeconds = /\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min|m)\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|sec|s)\b/.exec(raw);
  if (minutesSeconds) return Math.max(0, Number(minutesSeconds[1]) * 60 + Number(minutesSeconds[2]));
  const minutes = /\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min)\b/.exec(raw);
  if (minutes) return Math.max(0, Number(minutes[1]) * 60);
  const seconds = /\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|sec|s)\b/.exec(raw);
  if (seconds) return Math.max(0, Number(seconds[1]));
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : null;
}

function extractWizardTimeTokenSeconds(token = '') {
  const trimmed = String(token || '').trim();
  if (!trimmed) return null;
  return parseWizardTimeSeconds(trimmed);
}

function extractWizardFirstTimeAfter(text = '', pattern) {
  const match = pattern.exec(String(text || ''));
  return match ? extractWizardTimeTokenSeconds(match[1]) : null;
}

function normalizeWizardTrimMediaOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const startSeconds = parseWizardTimeSeconds(source.startSeconds ?? source.start ?? source.from) ?? 0;
  const endSeconds = parseWizardTimeSeconds(source.endSeconds ?? source.end ?? source.to);
  const durationSeconds = parseWizardTimeSeconds(source.durationSeconds ?? source.duration ?? source.length);
  const mode = normalizeId(source.mode) === 'end' || endSeconds !== null ? 'end' : 'duration';
  return {
    mode,
    startSeconds: Math.max(0, Math.round(startSeconds * 100) / 100),
    durationSeconds: Math.max(0.1, Math.round((durationSeconds ?? Math.max(0.1, (endSeconds ?? 5) - startSeconds)) * 100) / 100),
    endSeconds: Math.max(0.1, Math.round((endSeconds ?? startSeconds + (durationSeconds ?? 5)) * 100) / 100),
    assumedTiming: source.assumedTiming === true,
  };
}

function normalizeWizardExtractVideoFrameOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawPosition = normalizeId(source.framePosition || source.position || source.mode);
  const timestampSeconds = parseWizardTimeSeconds(source.timestampSeconds ?? source.timestamp ?? source.time);
  const assumedFrame = source.assumedFrame === true;
  const framePosition = assumedFrame ? 'first' : rawPosition === 'last' ? 'last' : timestampSeconds !== null || rawPosition === 'timestamp' ? 'timestamp' : 'first';
  return {
    framePosition,
    timestampSeconds: Math.max(0, Math.round((timestampSeconds ?? 0) * 100) / 100),
    outputFormat: normalizeWizardFormatToken(source.outputFormat || source.format) || 'png',
    assumedFrame,
  };
}

function normalizeWizardExportSubtitlesOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const outputFormat = normalizeWizardFormatToken(source.outputFormat || source.format) === 'vtt' ? 'vtt' : 'srt';
  const captionMode = normalizeId(source.captionMode || source.mode) === 'manuallines' || normalizeId(source.captionMode || source.mode) === 'manual_lines' ? 'manualLines' : 'auto';
  const durationPerCaptionSeconds = parseWizardTimeSeconds(source.durationPerCaptionSeconds ?? source.secondsPerCaption ?? source.duration) ?? 3;
  return {
    outputFormat,
    captionMode,
    durationPerCaptionSeconds: Math.max(0.1, Math.min(60, Math.round(durationPerCaptionSeconds * 100) / 100)),
  };
}

const WIZARD_SMALL_NUMBER_WORDS = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
});

function parseWizardSmallNumberWord(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, ' ');
  if (Object.prototype.hasOwnProperty.call(WIZARD_SMALL_NUMBER_WORDS, normalized)) {
    return WIZARD_SMALL_NUMBER_WORDS[normalized];
  }
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 2 && Object.prototype.hasOwnProperty.call(WIZARD_SMALL_NUMBER_WORDS, parts[0]) && Object.prototype.hasOwnProperty.call(WIZARD_SMALL_NUMBER_WORDS, parts[1])) {
    const tens = WIZARD_SMALL_NUMBER_WORDS[parts[0]];
    const ones = WIZARD_SMALL_NUMBER_WORDS[parts[1]];
    if (tens >= 20 && ones > 0 && ones < 10) {
      return tens + ones;
    }
  }
  return null;
}
function normalizeWizardMediaStitchOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    gapSeconds: Math.max(0, Math.min(60, Math.round((parseWizardTimeSeconds(source.gapSeconds ?? source.gap ?? 0) ?? 0) * 100) / 100)),
    outputFormat: normalizeWizardFormatToken(source.outputFormat || source.format) || 'mp4',
  };
}

function extractWizardDeterministicUtilityIntent(intent = '') {
  const text = String(intent || '').toLowerCase();
  const numberWordToken = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?';
  const timeToken = '((?:\\d{1,2}:)?\\d{1,2}:\\d{2}|(?:\\d+(?:\\.\\d+)?|' + numberWordToken + ')\\s*(?:seconds?|secs?|sec|s|minutes?|mins?|min))';
  const hasBurnSubtitles = /\b(burn(?:ed)? subtitles?|burn(?:ed)? captions?|hardcoded captions?|hardcoded subtitles?|captions? into the video|subtitles? into the video)\b/.test(text);
  const wantsExportSubtitles = !hasBurnSubtitles && /\b(export|save|make|create|turn)\b[^.]{0,80}\b(subtitles?|captions?|srt|vtt|subtitle file|caption file)\b/.test(text)
    || !hasBurnSubtitles && /\b(transcript|transcription|captions?)\b[^.]{0,80}\b(subtitles?|srt|vtt|subtitle file)\b/.test(text);
  const wantsExtractAudio = /\b(extract|separate|isolate|pull|rip)\b[^.]{0,80}\b(audio|soundtrack|audio track)\b[^.]{0,80}\b(video|clip|movie)\b/.test(text)
    || /\b(video|clip|movie)\b[^.]{0,80}\b(into|to|as)\b[^.]{0,40}\b(audio file|wav|mp3|audio)\b/.test(text)
    || /\bseparate the audio track\b/.test(text);
  const wantsExtractFrame = /\b(extract|grab|pull|capture|save|make|create)\b[^.]{0,80}\b(frame|thumbnail|still)\b[^.]{0,80}\b(video|clip|movie)\b/.test(text)
    || /\b(video|clip|movie)\b[^.]{0,80}\b(frame|thumbnail|still)\b/.test(text)
    || /\b(first|last) frame\b/.test(text);
  const wantsTrim = /\b(trim|cut|clip|shorten)\b[^.]{0,100}\b(audio|video|clip|movie|recording|file)\b/.test(text)
    || /\bextract\b[^.]{0,40}\b\d+(?:\.\d+)?\s*(?:second|sec|s|minute|min)\b[^.]{0,30}\bclip\b/.test(text)
    || /\b(start at|end at|from)\b[^.]{0,80}\b(to|until|through|end at)\b/.test(text)
    || /\bremove (?:the )?(beginning|start|intro|ending|end|outro)\b/.test(text);
  const wantsAudioStitch = /\b(stitch|combine|append|join|concatenate|merge)\b[^.]{0,80}\b(audio|sound|clips?|files?)\b/.test(text)
    || /\b(audio|sound)\b[^.]{0,80}\b(stitch|combine|append|join|concatenate|merge)\b/.test(text);
  const wantsVideoStitch = !wantsAudioStitch && !/\b(slideshow|slide show|image sequence|images? to video|media composition)\b/.test(text)
    && (/\b(stitch|combine|append|join|concatenate|merge)\b[^.]{0,80}\b(videos?|clips?|movies?)\b/.test(text)
      || /\b(videos?|clips?|movies?)\b[^.]{0,80}\b(stitch|combine|append|join|concatenate|merge)\b/.test(text));

  let trimKind = /\baudio|recording|voice memo|podcast\b/.test(text) ? 'audio' : 'video';
  if (/\bvideo|movie|clip\b/.test(text)) trimKind = 'video';
  const fromTo = new RegExp('\\bfrom\\s+' + timeToken + '\\s+(?:to|until|through)\\s+' + timeToken).exec(text);
  const startAt = new RegExp('\\bstart(?:s|ing)?\\s+at\\s+' + timeToken).exec(text);
  const endAt = new RegExp('\\bend(?:s|ing)?\\s+at\\s+' + timeToken).exec(text);
  const firstDuration = new RegExp('\\bfirst\\s+' + timeToken).exec(text);
  const durationClip = new RegExp(timeToken + '\\s+(?:clip|excerpt|segment)').exec(text);
  const trimToDuration = new RegExp('\\b(?:trim|cut|clip|shorten)\\b[^.]{0,80}\\b(?:to|for)\\s+' + timeToken).exec(text);
  const hasExplicitFrameTimestamp = /\b(?:at|timestamp|time)\s+/.test(text);
  const timestamp = hasExplicitFrameTimestamp ? extractWizardFirstTimeAfter(text, new RegExp('\\b(?:at|timestamp|time)\\s+' + timeToken)) : null;
  const startSeconds = fromTo ? extractWizardTimeTokenSeconds(fromTo[1]) : startAt ? extractWizardTimeTokenSeconds(startAt[1]) : /\bremove (?:the )?(beginning|start|intro)\b/.test(text) ? 5 : 0;
  const endSeconds = fromTo ? extractWizardTimeTokenSeconds(fromTo[2]) : endAt ? extractWizardTimeTokenSeconds(endAt[1]) : null;
  const durationSeconds = firstDuration ? extractWizardTimeTokenSeconds(firstDuration[1]) : durationClip ? extractWizardTimeTokenSeconds(durationClip[1]) : trimToDuration ? extractWizardTimeTokenSeconds(trimToDuration[1]) : null;
  const assumedTiming = wantsTrim && endSeconds === null && durationSeconds === null && !firstDuration && !durationClip;

  return {
    wantsTrimMedia: Boolean(wantsTrim && !wantsAudioStitch && !wantsVideoStitch),
    trimMediaKind: trimKind,
    trimMediaOptions: normalizeWizardTrimMediaOptions({ startSeconds, endSeconds, durationSeconds, assumedTiming }),
    wantsExtractAudio,
    wantsExtractVideoFrame: wantsExtractFrame,
    extractVideoFrameOptions: normalizeWizardExtractVideoFrameOptions({
      framePosition: /\blast frame\b/.test(text) ? 'last' : timestamp !== null ? 'timestamp' : 'first',
      timestampSeconds: timestamp,
      assumedFrame: wantsExtractFrame && !/\b(first|last) frame\b/.test(text) && timestamp === null,
    }),
    wantsExportSubtitles,
    exportSubtitlesOptions: normalizeWizardExportSubtitlesOptions({
      outputFormat: /\bvtt\b/.test(text) ? 'vtt' : 'srt',
      captionMode: /\b(manual lines?|line by line)\b/.test(text) ? 'manualLines' : 'auto',
    }),
    wantsAudioStitch,
    wantsVideoStitch,
    mediaStitchOptions: normalizeWizardMediaStitchOptions({}),
  };
}
function extractWizardNormalizeMediaIntent(intent = '') {
  const text = String(intent || '').toLowerCase();
  const knownFormats = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'mp4', 'webm', 'mov', 'mkv', 'png', 'jpg', 'jpeg', 'webp', 'bmp'];
  const unsupportedFormats = ['aac', 'aiff', 'wma', 'avi', 'wmv', 'gif', 'tiff', 'tif', 'heic'];
  const outputMatch = /\b(?:to|into|as|output(?:\s+as)?|make(?:\s+all)?(?:\s+\w+){0,3})\s+\.?([a-z0-9]{2,5})\b/.exec(text);
  const explicitOutputFormat = outputMatch ? normalizeWizardFormatToken(outputMatch[1]) : '';
  const formatMentions = [...text.matchAll(/\b(mp3|wav|flac|ogg|m4a|mp4|webm|mov|mkv|png|jpe?g|webp|bmp|aac|aiff|wma|avi|wmv|gif|tiff|tif|heic)\b/g)].map((match) => normalizeWizardFormatToken(match[1]));
  const outputFormat = explicitOutputFormat && [...knownFormats, ...unsupportedFormats].includes(explicitOutputFormat)
    ? explicitOutputFormat
    : formatMentions.length > 1 ? formatMentions[formatMentions.length - 1] : '';
  let mediaKind = '';
  if (/\b(audio|sound|music|voice|voiceover)\b/.test(text)) mediaKind = 'audio';
  if (/\b(video|movie|clip)\b/.test(text)) mediaKind = 'video';
  if (/\b(images?|photos?|pictures?|visuals?)\b/.test(text)) mediaKind = 'image';
  if (!mediaKind) {
    mediaKind = getWizardFormatMediaKind(formatMentions[0]) || getWizardFormatMediaKind(outputFormat);
  }
  const hasFormatIntent = Boolean(outputFormat || formatMentions.length > 1);
  const wants = /\bnormali[sz]e\b/.test(text)
    || /\bconvert\b[^.]{0,100}\b(audio|video|images?|photos?|pictures?|format|mp3|wav|flac|ogg|m4a|mp4|webm|mov|mkv|png|jpe?g|webp|bmp|aac|avi|gif|tiff|heic)\b/.test(text)
    || (/\b(turn|make)\b/.test(text) && hasFormatIntent && mediaKind);
  const formatResult = normalizeWizardOutputFormatForKind(mediaKind, outputFormat);
  return {
    wants: Boolean(wants && mediaKind),
    mediaKind,
    outputFormat: formatResult.outputFormat,
    unsupportedFormat: formatResult.unsupportedFormat,
    collection: /\b(these|all|collection|batch|list|multiple|many|several|each|whole collection)\b/.test(text),
  };
}

function inferWizardHeavyCooldown(intent = '') {
  const text = String(intent || '').toLowerCase();
  const wants = /\b(cooldown|cool down|wait|pause|delay|overheat|overheats|overheating|slow down|low[-\s]?end)\b/.test(text);
  const secondsMatch = /\b(\d{1,3})\s*(?:seconds?|secs?|sec|s)\b/.exec(text);
  const minutesMatch = /\b(\d{1,2})\s*(?:minutes?|mins?|min)\b/.exec(text);
  const seconds = secondsMatch ? Number(secondsMatch[1]) : minutesMatch ? Number(minutesMatch[1]) * 60 : 30;
  return {
    enabled: Boolean(wants),
    seconds: Math.max(0, Math.min(300, Math.round(Number(seconds) || 30))),
  };
}

function inferWizardCollectionValidationIntent(intent = '') {
  const text = String(intent || '').toLowerCase();
  return {
    perItem: /\b(validate|review|check|approve|reject|qa)\b[^.]{0,80}\b(each|every|per[-\s]?item|each item|generated item|generated image|failed items?|items?)\b/.test(text)
      || /\b(each|every|per[-\s]?item|generated item|generated image|failed items?)\b[^.]{0,80}\b(validate|review|check|approve|reject|retry|regenerate)\b/.test(text)
      || /\bretry failed items?\b/.test(text),
    wholeCollection: /\b(whole[-\s]?collection|entire collection|collection as a whole|final collection)\b/.test(text),
  };
}
function normalizeTone(value) {
  return String(value || '').trim().toLowerCase();
}

function hasAuthoringLanguage(value) {
  const text = String(value || '').toLowerCase();
  return /\b(build|create|make|draft|generate|design|compose|construct|set up|wire)\b.{0,80}\b(pipeline|workflow|graph|nodes?|builder|wizard)\b/.test(text)
    || /\b(pipeline|workflow|graph|nodes?|builder|wizard)\b.{0,80}\b(build|create|make|draft|generate|design|compose|construct|set up|wire)\b/.test(text);
}

function isLikelyCopiedAuthoringRequest(value, intent) {
  const normalizedValue = normalizeString(value).toLowerCase();
  const normalizedIntent = normalizeString(intent).toLowerCase();
  if (!normalizedValue) {
    return false;
  }
  if (normalizedIntent && normalizedValue === normalizedIntent) {
    return true;
  }
  return hasAuthoringLanguage(normalizedValue);
}

function sanitizeRuntimeTextDefault(value, intent) {
  const normalized = normalizeString(value);
  return isLikelyCopiedAuthoringRequest(normalized, intent) ? '' : normalized;
}

function sanitizeRuntimeConfigValue(value, intent) {
  if (typeof value === 'string') {
    return sanitizeRuntimeTextDefault(value, intent);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeRuntimeConfigValue(entry, intent));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeRuntimeConfigValue(entry, intent)]));
  }
  return value;
}

function sanitizeRuntimeConfigObject(config, intent) {
  return config && typeof config === 'object' && !Array.isArray(config)
    ? sanitizeRuntimeConfigValue(config, intent)
    : {};
}

function sanitizeRuntimeLabel(value, intent, fallback = 'Wizard result') {
  const sanitizedFallback = sanitizeRuntimeTextDefault(fallback, intent);
  return normalizeString(sanitizeRuntimeTextDefault(value, intent), sanitizedFallback || 'Wizard result');
}

function getDefaultValidationRuleset(kind = 'artifact') {
  if (kind === 'image') {
    return 'Pass only when the image is suitable for the next pipeline stage. Fail for mismatched content, obvious artifacts, or unusable framing.';
  }
  if (kind === 'plan') {
    return 'Pass only when the plan is structured, coherent, and specific enough for the next pipeline stage.';
  }
  if (kind === 'prompt') {
    return 'Pass only when the prompt is concrete, visual, and usable for the next generation stage.';
  }
  return 'Review the connected runtime artifact and choose Pass only when it is ready for the next stage.';
}

function inferIntentFeatures(intent) {
  const text = String(intent || '').toLowerCase();
  const normalizeMediaIntent = extractWizardNormalizeMediaIntent(text);
  const utilityIntent = extractWizardDeterministicUtilityIntent(text);
  const wantsDeterministicUtility = utilityIntent.wantsTrimMedia || utilityIntent.wantsExtractAudio || utilityIntent.wantsExtractVideoFrame || utilityIntent.wantsExportSubtitles || utilityIntent.wantsAudioStitch || utilityIntent.wantsVideoStitch;
  const heavyCooldown = inferWizardHeavyCooldown(text);
  const collectionValidation = inferWizardCollectionValidationIntent(text);
  const wantsMediaComposition = /\b(slideshow|slide show|sequence images?|image sequence|media composition|compose media|compose (?:an? )?(?:image )?(?:collection|sequence|slideshow|video)|compose\b[^.]{0,120}\b(images?|photos?|pictures?|image collection)\b[^.]{0,120}\b(video|slideshow|slide show)|turn .*images?.*video|images? .*to .*video|image collection .*into .*slideshow|image collection .*into .*video)\b/.test(text);
  const wantsNarrationSyncedTiming = /\b(sync(?:ed)? to narration|narration[-\s]?sync(?:ed)?|narration[-\s]?synced|match .*transcript timing|match .*narration timing|dynamic .*timing|transcript timing|voiceover timing|timed to (?:the )?(?:narration|transcript))\b/.test(text);
  return {
    wantsVoiceoverSource: /\b(voice\s*over|voiceover|script|narration|spoken)\b/.test(text),
    wantsImageInput: /\b(image input|input image|source image|image file|uploaded image|photo input)\b/.test(text),
    wantsDescription: /\b(describ\w*|description|caption|analy[sz]\w*|summari[sz]\w*)\b/.test(text),
    wantsPlanning: /\b(plan|planning|scene plan|storyboard|shot list|scene[s]?|beats?)\b/.test(text),
    wantsValidation: /\b(validat\w*|approval|approve|review|check|qa|quality)\b/.test(text),
    wantsRetry: /\b(retry|regenerat\w*|revise|repair|loop|on fail|fail|until approved|until valid)\b/.test(text),
    wantsPromptGeneration: /\b(prompts?|per[-\s]?scene|scene prompts?|prompt generation)\b/.test(text),
    wantsImageGeneration: /\b(images?|illustrations?|visuals?|frames?|thumbnails?|pictures?)\b/.test(text),
    wantsAudioGeneration: !wantsMediaComposition && !normalizeMediaIntent.wants && !wantsDeterministicUtility && (/\b(generat\w*|creat\w*|mak\w*|produc\w*|draft\w*)\b[^.]{0,80}\b(audio|music|song|sound effects?|sfx|speech|tts|narration|voiceover|voice over)\b/.test(text)
      || /\b(text[-\s]?to[-\s]?(audio|speech|music)|background music|sound effects?|generated audio)\b/.test(text)),
    wantsAudioTransform: /\b(rvc|voice conversion|convert (?:a |the )?voice|change (?:an? )?audio[^.]{0,60}voice|different voice|audio transform|transform audio|voice model)\b/.test(text)
      || /\b(audio file|audio input|voiceover|voice over|recording)\b[^.]{0,80}\b(convert|change|transform)\b[^.]{0,80}\b(voice|rvc)\b/.test(text),
    wantsVideoGeneration: !normalizeMediaIntent.wants && !wantsDeterministicUtility && (/\b(text[-\s]?to[-\s]?video|image[-\s]?to[-\s]?video|wan2?\.?1|wan webui|generate video|video generation)\b/.test(text)
      || /\b(generat\w*|creat\w*|mak\w*|turn|convert|animate)\b[^.]{0,90}\b(video|clip|animation|movie)\b/.test(text)),
    wantsImageToVideo: /\b(image|photo|picture)\b[^.]{0,80}\b(video|clip|animation|animate|motion)\b/.test(text),
    wantsImageTransform: /\b(upscale|enhance|restore|face.?swap|swap[^.]{0,30}face|facefusion|transform image|image transform|clean up an image|improve an image|image enhancement|upscayl)\b/.test(text),
    wantsFaceFusionTransform: /\b(face.?swap|swap[^.]{0,30}face|facefusion|source face|reference face)\b/.test(text),
    wantsReferenceVoiceTts: /\b(reference voice tts|clone this voice|clone (?:the |a )?voice|provided voice|same voice|reference voice|use this audio as (?:the )?voice|make (?:the )?reference voice say|text to speech in (?:the |a )?provided voice)\b/.test(text),
    wantsVoiceLineCollection: /\b(many|multiple|several|batch|collection|list|lines?|clips?)\b[^.]{0,80}\b(voice lines?|tts|speech|spoken|say)\b/.test(text)
      || /\b(voice lines?|tts clips?|speech clips?)\b[^.]{0,80}\b(many|multiple|several|batch|collection|list)\b/.test(text),
    wantsPreviousLastFrameChaining: /\b(previous[-\s]?last[-\s]?frame|last[-\s]?frame chain|chain(?:ing)? from (?:the )?previous|continuous scenes?|continuity|use (?:the )?previous frame|previous clip(?:'s)? last frame)\b/.test(text),
    wantsMediaComposition,
    wantsNarrationSyncedTiming,
    wantsSceneTransitions: /\b(transitions?|crossfade|xfade|fade|dissolve|wipes?|slides?|cinematic transitions?|random transitions?|random wipes?|scene transitions?)\b/.test(text),
    wantsSoundEffects: /\b(sound effects?|sfx|ambience|ambient sounds?|environmental sounds?|spooky sounds?|halloween sounds?|transition sounds?)\b/.test(text),
    wantsBurnSubtitles: /\b(burn(?:ed)? subtitles?|burn(?:ed)? captions?|hardcoded captions?|hardcoded subtitles?|caption burn|subtitle burn|subtitles? into the video|captions? into the video)\b/.test(text),
    wantsDeterministicUtility,
    wantsTrimMedia: utilityIntent.wantsTrimMedia,
    trimMediaKind: utilityIntent.trimMediaKind,
    trimMediaOptions: utilityIntent.trimMediaOptions,
    wantsExtractAudio: utilityIntent.wantsExtractAudio,
    wantsExtractVideoFrame: utilityIntent.wantsExtractVideoFrame,
    extractVideoFrameOptions: utilityIntent.extractVideoFrameOptions,
    wantsExportSubtitles: utilityIntent.wantsExportSubtitles,
    exportSubtitlesOptions: utilityIntent.exportSubtitlesOptions,
    wantsAudioStitch: utilityIntent.wantsAudioStitch,
    wantsVideoStitch: utilityIntent.wantsVideoStitch,
    mediaStitchOptions: utilityIntent.mediaStitchOptions,
    wantsNormalizeMedia: normalizeMediaIntent.wants,    normalizeMediaKind: normalizeMediaIntent.mediaKind,
    normalizeMediaOutputFormat: normalizeMediaIntent.outputFormat,
    normalizeMediaUnsupportedFormat: normalizeMediaIntent.unsupportedFormat,
    wantsNormalizeMediaCollection: normalizeMediaIntent.collection,
    wantsHeavyStepCooldown: heavyCooldown.enabled,
    heavyStepCooldownSeconds: heavyCooldown.seconds,
    wantsPerItemCollectionValidation: collectionValidation.perItem,
    wantsWholeCollectionValidation: collectionValidation.wholeCollection,
    wantsVideo: /\b(video|slideshow|slide show|sequence|sequencing|compose|composition|export|render|movie|clip|animation|animate)\b/.test(text),
  };
}

function shouldUseStoryboardVideoScaffold(intent) {
  const features = inferIntentFeatures(intent);
  return features.wantsPlanning
    && features.wantsValidation
    && features.wantsRetry
    && features.wantsImageGeneration
    && features.wantsVideo;
}

function getRuntimeSourceLabel(intent) {
  const features = inferIntentFeatures(intent);
  if (features.wantsVoiceoverSource) {
    return 'Voiceover script';
  }
  if (features.wantsPlanning) {
    return 'Source brief';
  }
  return 'Runtime input';
}

function buildDistilledPlanningGoal(intent) {
  const features = inferIntentFeatures(intent);
  if (features.wantsVoiceoverSource && features.wantsVideo) {
    return 'Create an ordered scene plan from the runtime voiceover script for an image-based video draft.';
  }
  if (features.wantsVideo) {
    return 'Create an ordered scene plan for a short image-based video draft.';
  }
  if (features.wantsImageGeneration) {
    return 'Create a structured visual plan and scene prompt set for downstream image generation.';
  }
  return 'Create a grounded longform scene plan from the runtime source text.';
}

function buildRuntimeSourceSummary(intent) {
  const features = inferIntentFeatures(intent);
  if (features.wantsVoiceoverSource) {
    return 'The runtime source is a voiceover script supplied in the Text Input node at run time.';
  }
  return 'The runtime source is text supplied in the Text Input node at run time.';
}

function sanitizePlanSummary(value, recipeId) {
  const normalized = normalizeString(value);
  if (normalized && !hasAuthoringLanguage(normalized)) {
    return trimPreviewText(normalized, 360);
  }
  const recipe = getRecipeOption(recipeId);
  return trimPreviewText(recipe?.summary || 'Editable draft workflow with grounded Local AI Hub nodes and wiring.', 360);
}

function sanitizePlanTitle(value, intent, recipeId) {
  const normalized = trimPreviewText(normalizeString(value), 80);
  if (normalized && !hasAuthoringLanguage(normalized)) {
    return normalized;
  }
  return buildPipelineTitle(intent, recipeId);
}

function buildPlanningPacketConfig({ intent, context, requestedConfig = {}, title = 'Scene planning packet' } = {}) {
  const requestedGoal = normalizeString(requestedConfig.goal);
  const requestedSummary = normalizeString(requestedConfig.sourceSummary);
  return {
    ...requestedConfig,
    schemaId: DEFAULT_PLANNING_SCHEMA_ID,
    title: normalizeString(requestedConfig.title, title),
    goal: isLikelyCopiedAuthoringRequest(requestedGoal, intent) ? buildDistilledPlanningGoal(intent) : normalizeString(requestedGoal, buildDistilledPlanningGoal(intent)),
    sourceSummary: isLikelyCopiedAuthoringRequest(requestedSummary, intent) ? buildRuntimeSourceSummary(intent) : normalizeString(requestedSummary, buildRuntimeSourceSummary(intent)),
    availableToolsText: normalizeString(requestedConfig.availableToolsText, (context.availableTools || []).map((tool) => tool.name).join('\n')),
    readinessNotesText: normalizeString(requestedConfig.readinessNotesText, [context.hardwareSummary, 'Longform scene planning and audio prompt planning are available planning schemas in this draft.'].filter(Boolean).join('\n')),
    desiredOutputNotes: normalizeString(requestedConfig.desiredOutputNotes, 'Create a structured scene plan and scene prompt collection. Downstream media generation settings remain editable.'),
  };
}

function getDefaultInstructionForOperation(operationId) {
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
    return 'Generate an image from the connected approved prompt. Leave detailed image settings editable for manual refinement.';
  }
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
    return 'Create a video artifact from the connected prompt or image. Leave detailed motion settings editable for manual refinement.';
  }
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
    return 'Transform the connected image according to the configured node settings. Leave detailed settings editable for manual refinement.';
  }
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
    return 'Generate audio from the connected text. Leave voice, style, and duration settings editable for manual refinement.';
  }
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
    return 'Transform the connected source audio. Leave voice model and conversion settings editable for manual refinement.';
  }
  return 'Process the connected runtime input and produce the requested text result.';
}

function sanitizeRuntimeInstruction(value, intent, operationId) {
  const normalized = normalizeString(value);
  return isLikelyCopiedAuthoringRequest(normalized, intent) ? getDefaultInstructionForOperation(operationId) : normalizeString(normalized, getDefaultInstructionForOperation(operationId));
}

function summarizeHardware(hardware = {}) {
  const gpuModel = normalizeString(hardware.gpuModel, 'Unknown GPU');
  const vramMb = Number(hardware.vramMb || 0) || 0;
  const systemRamMb = Number(hardware.systemRamMb || 0) || 0;
  const memoryParts = [];
  if (vramMb > 0) {
    memoryParts.push(Math.round(vramMb / 1024) + ' GB VRAM');
  }
  if (systemRamMb > 0) {
    memoryParts.push(Math.round(systemRamMb / 1024) + ' GB RAM');
  }
  return [gpuModel, memoryParts.join(' | '), normalizeString(hardware.compatibilityMessage)].filter(Boolean).join(' | ') || 'Hardware profile unavailable';
}

function getToolDisplayName(tool) {
  return normalizeString(tool?.name || tool?.label || tool?.id, 'Local tool');
}

function getProviderDisplayName(provider) {
  return normalizeString(provider?.name || provider?.label || provider?.id, 'Provider');
}

function getToolCompatibility(tool, hardware) {
  const profile = tool?.compatibility || tool?.installInstructions?.compatibility || null;
  return profile ? evaluateCompatibilityProfile(profile, hardware) : null;
}

function isCompatibilityPractical(entry) {
  const tone = normalizeTone(entry?.hardwareSuitability?.tone);
  return tone !== 'danger' && tone !== 'error';
}

function buildAvailableToolEntries(tools = [], manifests = [], hardware = {}) {
  const manifestsById = Object.fromEntries((Array.isArray(manifests) ? manifests : [])
    .map((tool) => [normalizeId(tool?.id), tool])
    .filter(([toolId]) => toolId));

  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const toolId = normalizeId(tool?.id);
      if (!toolId) {
        return null;
      }
      const catalog = manifestsById[toolId] || null;
      const merged = { ...(catalog || {}), ...(tool || {}) };
      const hardwareSuitability = getToolCompatibility(merged, hardware);
      return {
        ...merged,
        id: toolId,
        name: getToolDisplayName(merged),
        status: normalizeString(tool?.status || merged?.status, 'installed'),
        installed: true,
        running: normalizeId(tool?.status) === 'running',
        hardwareSuitability,
      };
    })
    .filter(Boolean);
}

function getToolEntry(context, toolId) {
  const normalizedToolId = normalizeId(toolId);
  return (context.availableTools || []).find((tool) => tool.id === normalizedToolId) || null;
}

function getProviderEntry(context, providerId) {
  const normalizedProviderId = normalizeId(providerId);
  return (context.connectedProviders || []).find((provider) => provider.id === normalizedProviderId) || null;
}

function isProviderUsableForOperation(provider, operationId) {
  return Boolean(provider?.isConnected && getProviderPipelineOperation(provider.id, operationId));
}

function compactWizardAssetLibraries(assetLibraries = {}) {
  const compact = (entries) => (Array.isArray(entries) ? entries : []).map((library) => ({
    id: String(library?.id || '').trim(),
    name: String(library?.name || library?.displayName || '').trim(),
    items: (Array.isArray(library?.items) ? library.items : []).slice(0, 8).map((item) => ({
      id: String(item?.id || '').trim(),
      name: String(item?.name || item?.displayName || item?.fileName || '').trim(),
      hex: String(item?.hex || item?.value || '').trim(),
    })).filter((item) => item.id || item.name),
  })).filter((library) => library.id || library.name);
  return {
    soundEffects: compact(assetLibraries.soundEffects),
    fonts: compact(assetLibraries.fonts),
    colorPalettes: compact(assetLibraries.colorPalettes),
  };
}

function buildPipelineWizardContext({ hardware = {}, manifests = [], providers = [], tools = [], assetLibraries = {} } = {}) {
  const availableTools = buildAvailableToolEntries(tools, manifests, hardware);
  const connectedProviders = (Array.isArray(providers) ? providers : [])
    .filter((provider) => provider?.isConnected)
    .map((provider) => ({
      id: normalizeId(provider.id),
      name: getProviderDisplayName(provider),
      isConnected: true,
      lastTestSucceeded: provider.lastTestSucceeded,
      lastSuccessfulUseAt: provider.lastSuccessfulUseAt || '',
      supportedOperations: Object.values(PIPELINE_OPERATION_IDS).filter((operationId) => getProviderPipelineOperation(provider.id, operationId)),
    }))
    .filter((provider) => provider.id);

  const toolOperationSupport = Object.values(PIPELINE_OPERATION_IDS).reduce((accumulator, operationId) => {
    accumulator[operationId] = availableTools
      .filter((tool) => getToolPipelineOperation(tool.id, operationId))
      .map((tool) => ({
        id: tool.id,
        name: tool.name,
        hardwareSuitability: tool.hardwareSuitability,
        status: tool.status,
      }));
    return accumulator;
  }, {});

  const wizardAssetLibraries = {
    soundEffects: Array.isArray(assetLibraries.soundEffects) ? assetLibraries.soundEffects : [],
    fonts: Array.isArray(assetLibraries.fonts) ? assetLibraries.fonts : [],
    colorPalettes: Array.isArray(assetLibraries.colorPalettes) ? assetLibraries.colorPalettes : [],
  };

  return {
    schemaVersion: WIZARD_PLAN_SCHEMA_VERSION,
    hardware: cloneValue(hardware || {}),
    hardwareSummary: summarizeHardware(hardware),
    recipes: cloneValue(WIZARD_RECIPE_OPTIONS),
    connectedProviders,
    availableTools,
    assetLibraries: cloneValue(wizardAssetLibraries),
    toolOperationSupport,
    maturePlanningSchemas: getPlanningSchemaOptions().map((schema) => ({ id: schema.id, label: schema.label, family: schema.familyLabel })),
    nodeTypes: NODE_TYPE_LIST
      .map((definition) => definition ? {
        type: definition.type,
        label: definition.label,
        category: definition.category,
        description: definition.description,
        terminal: Boolean(definition.terminal),
        persistsOutput: Boolean(definition.persistsOutput),
        inputs: (definition.inputPorts || []).map((port) => ({
          id: port.id,
          kind: port.kind,
          allowedKinds: port.allowedKinds || [],
          allowMultipleConnections: Boolean(port.allowMultipleConnections),
          required: Boolean(port.required),
        })),
        outputs: (definition.outputPorts || []).map((port) => ({
          id: port.id,
          kind: port.kind,
          allowedKinds: port.allowedKinds || [],
        })),
      } : null)
      .filter(Boolean),
  };
}

function compactWizardContextForPrompt(context = {}) {
  return {
    hardwareSummary: context.hardwareSummary,
    patternHints: (context.recipes || []).map((recipe) => ({ id: recipe.id, label: recipe.label, summary: recipe.summary })),
    nodeTypes: (context.nodeTypes || []).map((node) => ({
      type: node.type,
      label: node.label,
      category: node.category,
      inputs: node.inputs,
      outputs: node.outputs,
      terminal: node.terminal,
      persistsOutput: node.persistsOutput,
    })),
    connectedProviders: (context.connectedProviders || []).map((provider) => ({
      id: provider.id,
      name: provider.name,
      supportedOperations: provider.supportedOperations,
    })),
    availableTools: (context.availableTools || []).map((tool) => ({
      id: tool.id,
      name: tool.name,
      status: tool.status,
      hardwareSuitability: tool.hardwareSuitability ? {
        label: tool.hardwareSuitability.label,
        tone: tool.hardwareSuitability.tone,
        message: tool.hardwareSuitability.message,
      } : null,
    })),
    assetLibraries: compactWizardAssetLibraries(context.assetLibraries),
    maturePlanningSchemas: context.maturePlanningSchemas || [],
  };
}

function formatPortSignature(port = {}) {
  const kinds = Array.isArray(port.allowedKinds) && port.allowedKinds.length ? port.allowedKinds.join('/') : port.kind;
  return port.id + ':' + kinds + (port.required ? '*' : '') + (port.allowMultipleConnections ? '+' : '');
}

function compactWizardContextForLocalPrompt(context = {}) {
  return {
    hardware: context.hardwareSummary,
    patternHints: (context.recipes || []).map((recipe) => recipe.id + '=' + recipe.label),
    nodeTypes: (context.nodeTypes || []).map((node) => [
      node.type,
      'in:' + (node.inputs || []).map(formatPortSignature).join(','),
      'out:' + (node.outputs || []).map(formatPortSignature).join(','),
      node.terminal ? 'terminal' : '',
      node.persistsOutput ? 'persists' : '',
    ].filter(Boolean).join('|')),
    connectedProviders: (context.connectedProviders || []).map((provider) => provider.id + '[' + (provider.supportedOperations || []).join(',') + ']'),
    availableTools: (context.availableTools || []).map((tool) => [
      tool.id,
      tool.status,
      tool.hardwareSuitability?.tone || '',
    ].filter(Boolean).join('|')),
    assetLibraries: compactWizardAssetLibraries(context.assetLibraries),
    toolOperationSupport: Object.fromEntries(Object.entries(context.toolOperationSupport || {}).map(([operationId, entries]) => [
      operationId,
      (entries || []).map((entry) => entry.id + (entry.hardwareSuitability?.tone ? ':' + entry.hardwareSuitability.tone : '')),
    ])),
    maturePlanningSchemas: (context.maturePlanningSchemas || []).map((schema) => schema.id),
  };
}

function getWizardCompactRelevantNodeTypes(intent = '') {
  const features = inferIntentFeatures(intent);
  const obligations = extractWizardRequestObligations(intent);
  const nodeTypes = new Set([
    'textInput', 'imageInput', 'audioInput', 'videoInput', 'fileInput', 'collectionInput',
    'textOutput', 'imageOutput', 'audioOutput', 'videoOutput', 'fileOutput', 'collectionOutput',
    'llmPrompt', 'collectionMap',
  ]);
  const add = (...types) => types.forEach((type) => nodeTypes.add(type));
  if (features.wantsPlanning || obligations.wantsPlanning || obligations.wantsPromptCollection) {
    add('planningPacket', 'planner', 'planScenes', 'planOutput');
  }
  if (features.wantsValidation || features.wantsRetry || obligations.wantsValidation || obligations.wantsRetry) {
    add('validation', 'retryLoop');
  }
  if (features.wantsMediaComposition || features.wantsNarrationSyncedTiming || features.wantsSoundEffects || obligations.wantsComposition || obligations.wantsExport) {
    add('mediaComposition', 'mediaExport');
  }
  if (features.wantsBurnSubtitles || obligations.wantsBurnSubtitles) {
    add('burnSubtitles');
  }
  if (features.wantsNormalizeMedia || obligations.wantsNormalizeMedia) {
    add('normalizeAudioCollection', 'normalizeVideoCollection', 'normalizeImage');
  }
  if (features.wantsTrimMedia || obligations.wantsTrimMedia) add('trimMedia');
  if (features.wantsExtractAudio || obligations.wantsExtractAudio) add('extractAudio');
  if (features.wantsExtractVideoFrame || obligations.wantsExtractVideoFrame) add('extractVideoFrame');
  if (features.wantsExportSubtitles || obligations.wantsExportSubtitles) add('exportSubtitles');
  if (features.wantsAudioStitch || obligations.wantsAudioStitch) add('audioStitch');
  if (features.wantsVideoStitch || obligations.wantsVideoStitch) add('videoStitch');
  return nodeTypes;
}

function filterWizardContextForIntent(context = {}, intent = '') {
  const relevantNodeTypes = getWizardCompactRelevantNodeTypes(intent);
  const selectedProviderIds = new Set(['openai', 'google', 'xai', 'groq']);
  const features = inferIntentFeatures(intent);
  const obligations = extractWizardRequestObligations(intent);
  const wantsAssetLibraries = features.wantsSoundEffects || features.wantsBurnSubtitles || obligations.wantsComposition || obligations.wantsBurnSubtitles;
  return {
    ...context,
    nodeTypes: (context.nodeTypes || []).filter((node) => relevantNodeTypes.has(node.type)),
    connectedProviders: (context.connectedProviders || []).filter((provider) => selectedProviderIds.has(normalizeId(provider.id))),
    availableTools: (context.availableTools || []).filter((tool) => ['automatic1111', 'comfyui', 'ollama', 'audiocraft', 'chatterboxTurbo', 'chatterbox-turbo', 'wan', 'wan21', 'upscayl', 'facefusion'].includes(normalizeId(tool.id))),
    assetLibraries: wantsAssetLibraries ? compactWizardAssetLibraries(context.assetLibraries) : {},
    maturePlanningSchemas: features.wantsPlanning ? (context.maturePlanningSchemas || []) : [],
  };
}

function estimatePipelineWizardTokens(value) {
  return Math.ceil(String(value || '').length / 4);
}

function isPipelineWizardConstrainedModel(target = {}) {
  const providerId = normalizeId(target.providerId);
  const model = normalizeModelId(target.model).toLowerCase();
  if (target.mode === 'ollama') {
    return false;
  }
  if (providerId === 'groq' && /gpt[-_\s]?oss|openai\/gpt[-_\s]?oss/.test(model)) {
    return true;
  }
  if (providerId === 'google' && /gemini[-_\s]?2\.5[-_\s]?flash|models\/gemini-2\.5-flash/.test(model)) {
    return true;
  }
  return false;
}

function getPipelineWizardRequestProfile({ intent = '', context = {}, wizardTarget = {} } = {}) {
  const target = {
    mode: wizardTarget.mode === 'ollama' ? 'ollama' : 'cloud',
    providerId: normalizeId(wizardTarget.providerId),
    model: normalizeModelId(wizardTarget.model),
  };
  const compactContext = filterWizardContextForIntent(context, intent);
  const fullPromptTokens = estimatePipelineWizardTokens(JSON.stringify(compactWizardContextForPrompt(context))) + 1400;
  const compactPromptTokens = estimatePipelineWizardTokens(JSON.stringify(compactWizardContextForLocalPrompt(compactContext))) + 1200;
  const constrained = isPipelineWizardConstrainedModel(target);
  const isGroqGptOss = target.providerId === 'groq' && /gpt[-_\s]?oss|openai\/gpt[-_\s]?oss/i.test(target.model);
  const isGeminiFlash = target.providerId === 'google' && /gemini[-_\s]?2\.5[-_\s]?flash|models\/gemini-2\.5-flash/i.test(target.model);
  const compactMode = constrained || (target.mode === 'cloud' && fullPromptTokens > 6500);
  const maxOutputTokens = target.mode === 'ollama'
    ? 700
    : isGroqGptOss
      ? 1024
      : isGeminiFlash
        ? 1536
        : compactMode
          ? 2048
          : 4096;
  return {
    compactMode,
    constrainedModel: constrained,
    note: compactMode ? 'Using compact wizard mode for this model.' : '',
    maxOutputTokens,
    estimatedFullPromptTokens: fullPromptTokens,
    estimatedCompactPromptTokens: compactPromptTokens,
    promptBudgetTokens: isGroqGptOss ? 6000 : isGeminiFlash ? 9000 : 12000,
    responseBudgetTokens: maxOutputTokens,
  };
}
function buildPipelineWizardIntentIrJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'summary', 'intentIr', 'gaps', 'userRefinementNotes'],
    properties: {
      title: { type: 'string', description: 'Short user-facing draft title. Do not copy the full request.' },
      summary: { type: 'string', description: 'One concise sentence describing the abstract workflow intent.' },
      recipeId: { type: 'string', enum: Object.values(WIZARD_RECIPE_IDS), description: 'Optional broad recipe hint only.' },
      gaps: { type: 'array', items: { type: 'string' }, description: 'Honest unsupported or manual follow-up items.' },
      userRefinementNotes: { type: 'array', items: { type: 'string' }, description: 'Short notes for settings the user should review.' },
      intentIr: {
        type: 'object',
        additionalProperties: false,
        required: ['sources', 'artifacts', 'stages', 'outputs', 'assumptions', 'gaps'],
        properties: {
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'modality', 'role'],
              properties: {
                name: { type: 'string' },
                modality: { type: 'string', enum: WIZARD_INTENT_SOURCE_MODALITIES },
                role: { type: 'string' },
              },
            },
          },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'kind', 'role'],
              properties: {
                name: { type: 'string' },
                kind: { type: 'string', enum: ['text', 'image', 'audio', 'video', 'file', 'plan', 'planningPacket', 'composition', 'collection', 'collection:text', 'collection:image', 'collection:audio', 'collection:video', 'collection:file'] },
                role: { type: 'string' },
              },
            },
          },
          stages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'kind', 'inputs', 'outputs', 'purpose'],
              properties: {
                id: { type: 'string' },
                kind: { type: 'string', enum: WIZARD_INTENT_STAGE_KINDS },
                input: { type: 'string' },
                inputs: { type: 'array', items: { type: 'string' } },
                output: { type: 'string' },
                outputs: { type: 'array', items: { type: 'string' } },
                purpose: { type: 'string' },
                operationSubtype: { type: 'string', enum: ['', ...WIZARD_OPERATION_SUBTYPES] },
                providerPreference: { type: 'string', enum: ['', ...WIZARD_CLOUD_IMAGE_PROVIDER_IDS] },
                mappingMode: { type: 'string', enum: ['', ...WIZARD_COLLECTION_MAPPING_MODES] },
                referenceAudio: { type: 'string' },
                previousLastFrameChaining: { type: 'boolean' },
                mediaComposition: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    timingMode: { type: 'string', enum: ['', 'fixedDurationPerImage', 'dynamicFromImageMetadata'] },
                    fallbackSecondsPerImage: { type: 'number' },
                    fixedSecondsPerImage: { type: 'number' },
                    transitionsEnabled: { type: 'boolean' },
                    transitionMode: { type: 'string', enum: ['', 'off', 'single', 'randomCategory', 'randomSelected'] },
                    transitionCategory: { type: 'string' },
                    narrationVolume: { type: 'number' },
                    backgroundMusicVolume: { type: 'number' },
                    soundEffectsEnabled: { type: 'boolean' },
                    soundEffectsVolume: { type: 'number' },
                    soundEffectLibraryRefs: { type: 'array', items: { type: 'string' } },
                  },
                },
                burnSubtitles: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    enabled: { type: 'boolean' },
                    fontLibraryRef: { type: 'string' },
                    colorPaletteRef: { type: 'string' },
                    position: { type: 'string' },
                    styleIntent: { type: 'string' },
                  },
                },
                normalizeMedia: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mediaKind: { type: 'string', enum: ['', ...WIZARD_NORMALIZE_MEDIA_KINDS] },
                    outputFormat: { type: 'string' },
                    unsupportedFormat: { type: 'string' },
                  },
                },
                collectionValidation: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    enabled: { type: 'boolean' },
                    scope: { type: 'string', enum: ['', 'perItem', 'wholeCollection'] },
                    mode: { type: 'string', enum: ['', 'user', 'manual', 'approval'] },
                    ruleset: { type: 'string' },
                    retryInstruction: { type: 'string' },
                    maxAttempts: { type: 'integer', minimum: 1, maximum: PIPELINE_RETRY_LOOP_MAX_ATTEMPTS },
                    failMode: { type: 'string', enum: ['', 'fail-fast', 'partial'] },
                  },
                },
                validationMode: { type: 'string', enum: ['', 'llm', 'user', 'manual', 'approval'] },
                retryTarget: { type: 'string' },
                maxAttempts: { type: 'integer', minimum: 2, maximum: PIPELINE_RETRY_LOOP_MAX_ATTEMPTS },
              },
            },
          },
          outputs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['artifact', 'kind', 'title'],
              properties: {
                artifact: { type: 'string' },
                kind: { type: 'string', enum: ['text', 'image', 'audio', 'video', 'file', 'plan', 'composition', 'collection', 'collection:text', 'collection:image', 'collection:audio', 'collection:video', 'collection:file'] },
                title: { type: 'string' },
              },
            },
          },
          assumptions: { type: 'array', items: { type: 'string' } },
          gaps: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  };
}

function stripWizardSchemaDescriptions(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stripWizardSchemaDescriptions(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'description')
    .map(([key, entry]) => [key, stripWizardSchemaDescriptions(entry)]));
}

function buildPipelineWizardStructuredOutputRequest(options = {}) {
  const compactMode = options?.compactMode === true;
  const schema = buildPipelineWizardIntentIrJsonSchema();
  return {
    type: 'json_schema',
    name: compactMode ? 'local_ai_hub_pipeline_wizard_compact_intent_ir' : 'local_ai_hub_pipeline_wizard_intent_ir',
    schema: compactMode ? stripWizardSchemaDescriptions(schema) : schema,
  };
}

function buildPipelineWizardMessages({ intent = '', context = {}, wizardTarget = {} } = {}) {
  const normalizedIntent = normalizeString(intent);
  const selectedTarget = {
    mode: wizardTarget.mode === 'ollama' ? 'ollama' : 'cloud',
    providerId: normalizeId(wizardTarget.providerId),
    model: normalizeModelId(wizardTarget.model),
  };
  const localWizard = selectedTarget.mode === 'ollama';
  const requestProfile = wizardTarget.requestProfile || getPipelineWizardRequestProfile({ intent: normalizedIntent, context, wizardTarget: selectedTarget });
  const compactCloudWizard = !localWizard && requestProfile.compactMode === true;
  const promptContext = compactCloudWizard ? filterWizardContextForIntent(context, normalizedIntent) : context;
  const systemLines = localWizard
    ? [
        'You are the Local AI Hub Pipeline Wizard planner.',
        'Return one compact JSON object only: {"title","summary","intentIr","recipeId","gaps","userRefinementNotes"}.',
        'Prefer intentIr. Use recipeId only as a broad hint. Avoid draftGraph unless the user needs a simple custom text chain.',
        'intentIr is abstract, not node wiring: sources, artifacts, stages, controls, outputs, gaps, assumptions.',
        'Use stage kinds only from supportedIntentStageKinds. Do not emit node ids or port ids in intentIr.',
        'Never copy the authoring request into runtime node defaults, labels, titles, rules, workflow text, or instructions.',
        'Leave runtime source content empty unless actual source content was supplied.',
        'Preserve requested modality, validation, retry, planning, collection, generation, transformation, composition, utility, and export intent.',
        'Use optional stage controls only when needed: operationSubtype, providerPreference, mappingMode, referenceAudio, previousLastFrameChaining, mediaComposition, burnSubtitles, normalizeMedia, collectionValidation.',
        'Cloud image providers are OpenAI, Google, and xAI. Cloud video providers are Google and xAI only; do not claim OpenAI/Sora video support.',
        'Use referenceVoiceTts with a referenceAudio source for Chatterbox-Turbo reference voice requests.',
        'For deterministic utilities use trim_media, extract_audio, extract_video_frame, export_subtitles, stitch_audio, stitch_video, or normalize_media; do not use Model Step.',
        'Recipe ids are hints, not required templates. Local AI Hub will compile, validate, and instantiate the graph.',
        'Local AI Hub will restore explicit source/output modality plus planning, validation, retry, composition, and export obligations before graph compilation when the request clearly requires them.',
        'Use only planning schemas listed in maturePlanningSchemas.',
      ]
    : [
        'You are the Local AI Hub Pipeline Wizard planner.',
        compactCloudWizard ? 'Using compact wizard mode for this model.' : '',
        'Convert the request into a grounded Wizard Intent IR first. Local AI Hub will compile it into real nodes and wiring.',
        'Recipe ids are optional broad hints only. Prefer intentIr over recipeId. Do not emit draftGraph unless explicitly asked for legacy debugging.',
        'Do not invent node types, ports, tools, providers, or full pipeline schema JSON.',
        'Keep authoring-time requests separate from runtime pipeline content: do not copy the user request into runtime node defaults, input content, Planning Packet fields, validation rules, labels, output titles, workflow text, or runtime instructions.',
        'For runtime source nodes, leave content empty unless the user supplied actual source content rather than a request to build a pipeline.',
        'For complex requests, decompose into intentIr stages for transcription, planning, plan_scenes, validation, retry, generate_image, generate_audio, transform_audio, generate_video, transform_image, normalize_media, trim_media, extract_audio, extract_video_frame, export_subtitles, stitch_audio, stitch_video, compose_media, export, and outputs when requested.',
        'Return JSON only. The JSON must be an object with: title, summary, intentIr, recipeId, gaps, userRefinementNotes. draftGraph is legacy fallback only.',
        'intentIr shape: {sources:[{name,modality,role}], artifacts:[{name,kind}], stages:[{id,kind,input,output,inputs,outputs,purpose,operationSubtype,providerPreference,mappingMode,referenceAudio,previousLastFrameChaining,mediaComposition,burnSubtitles,normalizeMedia,trimMedia,extractVideoFrame,exportSubtitles,mediaStitch,collectionValidation,validationMode,retryTarget,maxAttempts}], outputs:[{artifact,kind,title}], gaps, assumptions}.',
        'Cloud image generation is limited to OpenAI, Google, and xAI. Cloud video generation is limited to Google and xAI; never plan OpenAI/Sora video.',
        'For cloud image/video collection maps, use mappingMode textToImage, cloudImageToImage, textToVideo, or cloudImageToVideo. Set previousLastFrameChaining only when the user asks for continuity/last-frame chaining.',
        'For Chatterbox-Turbo reference voice TTS, use operationSubtype referenceVoiceTts and include/connect a referenceAudio source. Paralinguistic tags stay inline in text.',
        'For deterministic utilities, use trim_media, extract_audio, extract_video_frame, export_subtitles, stitch_audio, or stitch_video instead of Model Step. Export subtitles creates a file; Burn Subtitles renders captions into video. For narration-synced slideshows, use compose_media with mediaComposition.timingMode dynamicFromImageMetadata and fallbackSecondsPerImage. For transitions, set mediaComposition.transitionsEnabled with randomCategory unless a simple fade is requested.',
        'For sound effects, set mediaComposition.soundEffectsEnabled and soundEffectLibraryRefs using only available asset library ids/names. For captions, use burn_subtitles with burnSubtitles font/color/position intent.',
        'Use stage kinds only from supportedIntentStageKinds. Local AI Hub will choose exact nodes, ports, tools, providers, validation, and wiring.',
        'For collectionMap item generation, prefer collectionValidation.scope perItem when the user asks to validate/review every generated item or retry failed items. Use whole-collection validation only when explicitly requested.',
        'Local AI Hub will repair missing explicit source/output modality and requested planning/validation/retry/composition/export structure before graph compilation, so keep intentIr compact and honest.',
        'If the request is only partly possible, draft the closest honest graph and put the missing pieces in gaps.',
        'Use only planning schemas listed in maturePlanningSchemas. Do not claim other planning schema families are mature.',
      ];
  return [
    {
      role: 'system',
      content: systemLines.join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify(localWizard ? {
        intent: normalizedIntent,
        target: selectedTarget,
        ctx: compactWizardContextForLocalPrompt(promptContext),
        recipeIds: WIZARD_RECIPE_OPTIONS.map((recipe) => recipe.id),
        supportedIntentStageKinds: WIZARD_INTENT_STAGE_KINDS,
        supportedSourceModalities: WIZARD_INTENT_SOURCE_MODALITIES,
        operationIds: Object.values(PIPELINE_OPERATION_IDS),
        intentFeatures: Object.fromEntries(Object.entries(inferIntentFeatures(normalizedIntent)).filter(([, value]) => value === true || (typeof value === 'string' && value) || (typeof value === 'number' && value !== 0))),
      } : {
        intent: normalizedIntent,
        selectedWizardModel: selectedTarget,
        localAIHubContext: compactCloudWizard ? compactWizardContextForLocalPrompt(promptContext) : compactWizardContextForPrompt(promptContext),
        compactMode: compactCloudWizard,
        requestBudget: { promptTokens: requestProfile.promptBudgetTokens, responseTokens: requestProfile.responseBudgetTokens },
        patternHintIds: WIZARD_RECIPE_OPTIONS.map((recipe) => recipe.id),
        supportedIntentStageKinds: WIZARD_INTENT_STAGE_KINDS,
        supportedSourceModalities: WIZARD_INTENT_SOURCE_MODALITIES,
        allowedNodeTypes: (promptContext.nodeTypes || []).map((node) => node.type),
        allowedOperationIds: Object.values(PIPELINE_OPERATION_IDS),
        intentIrContract: {
          stageGuidance: {
            audioVoiceoverToVideo: ['audio source', 'transcribe_audio', 'plan', 'plan_scenes', 'validate', 'retry', 'generate_image', 'compose_media', 'export', 'video output'],
            collectionImageGeneration: 'Use generate_image with collection:text input; Local AI Hub compiles that to collectionMap. Use mappingMode cloudImageToImage for collection:image to collection:image cloud edits.',
            cloudImageProviders: 'Cloud image generation providers: openai, google, xai only.',
            cloudVideoProviders: 'Cloud video generation providers: google, xai only. Do not use OpenAI/Sora video.',
            cloudVideoCollectionChaining: 'For requested continuity or previous-last-frame behavior, set previousLastFrameChaining true on textToVideo or cloudImageToVideo collection maps for google/xai.',
            referenceVoiceTts: 'Use generate_audio with operationSubtype referenceVoiceTts and referenceAudio for Chatterbox-Turbo. For many voice lines, use collection:text to collection:audio mappingMode textToAudio with shared reference audio.',
            mediaComposition: 'Use compose_media for collection:image slideshows. For narration or transcript sync set mediaComposition.timingMode dynamicFromImageMetadata and fallbackSecondsPerImage. For transitions set transitionsEnabled true and transitionMode randomCategory or single.',
            soundEffectsLibraries: 'For ambience/SFX, set mediaComposition.soundEffectsEnabled true and soundEffectLibraryRefs to existing Sound Effects library ids/names only. Multiple refs become multiple SFX layers.',
            burnSubtitles: 'Use burn_subtitles after a video artifact and a text/file captions artifact. Set burnSubtitles fontLibraryRef, colorPaletteRef, position, and styleIntent only when requested and only from existing libraries.',
            localAudioGeneration: 'Use generate_audio for text-to-audio/music/sound requests; Local AI Hub prefers AudioCraft when installed or compatible provider speech where available.',
            localAudioTransform: 'Use transform_audio for RVC/voice-conversion requests with an audio source placeholder and manual voice-model selection.',
            localVideoGeneration: 'Use generate_video for text-to-video or image-to-video requests; image-to-video uses an image source placeholder and editable motion guidance.',
            localImageTransform: 'Use transform_image for Upscayl/FaceFusion image transformation; FaceFusion needs target and reference image source placeholders.',
            normalizeMedia: 'Use normalize_media for deterministic audio/video/image format conversion. Supported audio formats: auto,wav,mp3,flac,ogg,m4a. Video: auto,mp4,webm,mov,mkv. Image: png,jpg,webp,bmp.',
            mediaUtilities: 'Use trim_media for audio/video time ranges, extract_audio for video soundtrack extraction, extract_video_frame for thumbnails/stills, export_subtitles for SRT/VTT files from caption text, stitch_audio for audio collections, and stitch_video for video collections. Do not use these utility stages for generation.',
            collectionValidation: 'For collectionMap item generation, set collectionValidation.scope perItem when the user asks to validate/review every generated item, approve/reject each item, or retry failed items. Use validate/retry stages after the collection only for whole-collection review.',
          },
          outputKinds: ['text', 'image', 'audio', 'video', 'plan', 'composition', 'collection:text', 'collection:image', 'collection:audio', 'collection:video'],
        },
      }, null, localWizard || compactCloudWizard ? 0 : 2),
    },
  ];
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Continue below and try to rescue the first JSON object from a chatty response.
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function inferRecipeIdFromIntent(intent) {
  const text = String(intent || '').toLowerCase();
  if (/\b(rvc|voice conversion|convert (?:a |the )?voice|change (?:an? )?audio[^.]{0,60}voice|different voice|audio transform|transform audio|voice model)\b/.test(text)) {
    return WIZARD_RECIPE_IDS.AUDIO_TRANSFORM;
  }
  if (/\b(transcribe|transcription|captions?|subtitle|speech to text|audio to text)\b/.test(text)) {
    return WIZARD_RECIPE_IDS.AUDIO_TRANSCRIBE;
  }
  if (/\b(scene plan|storyboard|shot list|visual beats?|episode plan|longform|narrative plan|plan scenes?)\b/.test(text)) {
    return WIZARD_RECIPE_IDS.SCENE_PLAN;
  }
  if (/\b(upscale|enhance|restore|face.?swap|swap[^.]{0,30}face|facefusion|transform image|image transform|clean up an image|improve an image)\b/.test(text)) {
    return WIZARD_RECIPE_IDS.IMAGE_TRANSFORM;
  }
  if (/\b(describe image|caption image|analy[sz]e image|image to text|vision|image input|input image|source image|image file)\b/.test(text) && /\b(describ\w*|description|caption|analy[sz]\w*|text|vision|model)\b/.test(text)) {
    return WIZARD_RECIPE_IDS.IMAGE_TO_TEXT;
  }
  if (/\b(video|animation|animate|motion|clip|movie)\b/.test(text)) {
    return WIZARD_RECIPE_IDS.TEXT_TO_VIDEO;
  }
  if (/\b(audio|music|song|sound effect|voiceover|voice over|speech|tts|narration)\b/.test(text)) {
    return WIZARD_RECIPE_IDS.TEXT_TO_AUDIO;
  }
  if (/\b(image|picture|illustration|artwork|photo|render|poster|thumbnail)\b/.test(text)) {
    return WIZARD_RECIPE_IDS.TEXT_TO_IMAGE;
  }
  return WIZARD_RECIPE_IDS.TEXT_RESPONSE;
}

function normalizeGraphNodeId(value, fallback) {
  return normalizeString(value, fallback).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function normalizeDraftGraph(value) {
  const graph = value && typeof value === 'object' ? value : {};
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : Array.isArray(graph.connections) ? graph.connections : [];
  const seenNodeIds = new Set();
  const nodes = rawNodes
    .map((node, index) => {
      const type = normalizeString(node?.type || node?.nodeType);
      if (!getNodeTypeDefinition(type)) {
        return null;
      }

      let id = normalizeGraphNodeId(node?.id || node?.nodeId, 'node-' + String(index + 1));
      while (seenNodeIds.has(id)) {
        id = id + '-' + String(seenNodeIds.size + 1);
      }
      seenNodeIds.add(id);

      return {
        id,
        type,
        label: trimPreviewText(normalizeString(node?.label), 80),
        purpose: trimPreviewText(normalizeString(node?.purpose || node?.description), 220),
        config: node?.config && typeof node.config === 'object' && !Array.isArray(node.config) ? cloneValue(node.config) : {},
      };
    })
    .filter(Boolean);
  const validNodeIds = new Set(nodes.map((node) => node.id));
  const edges = rawEdges
    .map((edge) => ({
      sourceNodeId: normalizeGraphNodeId(edge?.sourceNodeId || edge?.source?.nodeId || edge?.sourceId || edge?.from, ''),
      sourcePortId: normalizeString(edge?.sourcePortId || edge?.source?.portId || edge?.sourcePort || edge?.fromPort),
      targetNodeId: normalizeGraphNodeId(edge?.targetNodeId || edge?.target?.nodeId || edge?.targetId || edge?.to, ''),
      targetPortId: normalizeString(edge?.targetPortId || edge?.target?.portId || edge?.targetPort || edge?.toPort),
    }))
    .filter((edge) => edge.sourceNodeId && edge.targetNodeId && edge.sourcePortId && edge.targetPortId && validNodeIds.has(edge.sourceNodeId) && validNodeIds.has(edge.targetNodeId));

  return {
    nodes,
    edges,
  };
}

function normalizeArtifactKey(value, fallback = '') {
  return normalizeString(value, fallback).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function normalizeArtifactRef(value, fallback = '') {
  if (value && typeof value === 'object') {
    return normalizeArtifactKey(value.name || value.id || value.artifact || value.ref || value.role, fallback);
  }
  return normalizeArtifactKey(value, fallback);
}

function normalizeIntentKind(value, fallback = 'text') {
  const normalized = normalizeId(value).replace(/-/g, '_');
  if (['text', 'prompt', 'script', 'brief', 'description'].includes(normalized)) return 'text';
  if (['image', 'photo', 'picture', 'visual'].includes(normalized)) return 'image';
  if (['audio', 'speech', 'voiceover', 'voice_over', 'music'].includes(normalized)) return 'audio';
  if (['video', 'movie', 'clip'].includes(normalized)) return 'video';
  if (['file', 'document'].includes(normalized)) return 'file';
  if (['plan', 'scene_plan'].includes(normalized)) return 'plan';
  if (['planning_packet', 'planningpacket', 'packet'].includes(normalized)) return 'planningPacket';
  if (['composition', 'media_composition'].includes(normalized)) return 'composition';
  if (normalized.startsWith('collection')) {
    const itemKind = normalized.split(/[:_]/).find((part) => ['text', 'image', 'audio', 'video', 'file'].includes(part));
    return itemKind ? 'collection:' + itemKind : 'collection';
  }
  return fallback;
}

function normalizeIntentStageKind(value) {
  const normalized = normalizeId(value).replace(/-/g, '_');
  if (['plan', 'planning', 'planner', 'scene_plan', 'storyboard'].includes(normalized)) return 'plan';
  if (['plan_scenes', 'scene_prompts', 'scenes_from_plan', 'plan_to_scenes', 'derive_scene_prompts'].includes(normalized)) return 'plan_scenes';
  if (['build_collection', 'collection_builder', 'collect_items', 'collect_prompts', 'prompt_collection', 'make_collection'].includes(normalized)) return 'build_collection';
  if (['llm_generate_text', 'generate_text', 'text_generate', 'text_generation', 'model_text', 'summarize', 'rewrite', 'prompt_generation'].includes(normalized)) return 'llm_generate_text';
  if (['generate_image', 'image_generate', 'text_to_image', 'image_generation'].includes(normalized)) return 'generate_image';
  if (['generate_audio', 'audio_generate', 'text_to_audio', 'text_to_music', 'audio_generation', 'music_generation', 'sound_generation'].includes(normalized)) return 'generate_audio';
  if (['transform_audio', 'audio_transform', 'voice_conversion', 'convert_voice', 'rvc'].includes(normalized)) return 'transform_audio';
  if (['generate_video', 'video_generate', 'text_to_video', 'image_to_video', 'video_generation'].includes(normalized)) return 'generate_video';
  if (['transform_image', 'image_transform', 'upscale_image', 'image_upscale', 'enhance_image', 'face_swap', 'facefusion', 'upscayl'].includes(normalized)) return 'transform_image';
  if (['transcribe_audio', 'audio_transcribe', 'transcription', 'speech_to_text'].includes(normalized)) return 'transcribe_audio';
  if (['validate', 'validation', 'review', 'approval', 'quality_check', 'qa'].includes(normalized)) return 'validate';
  if (['retry', 'retry_loop', 'regenerate', 'revise_on_fail'].includes(normalized)) return 'retry';
  if (['normalize_media', 'normalize', 'convert_media', 'convert_audio', 'convert_video', 'convert_image', 'normalize_audio', 'normalize_video', 'normalize_image'].includes(normalized)) return 'normalize_media';
  if (['trim_media', 'trim', 'trim_audio', 'trim_video', 'cut_media', 'cut_clip'].includes(normalized)) return 'trim_media';
  if (['extract_audio', 'audio_extract', 'video_to_audio', 'separate_audio'].includes(normalized)) return 'extract_audio';
  if (['extract_video_frame', 'extract_frame', 'grab_frame', 'video_thumbnail', 'make_thumbnail', 'thumbnail'].includes(normalized)) return 'extract_video_frame';
  if (['export_subtitles', 'export_captions', 'subtitle_export', 'caption_export', 'make_subtitle_file'].includes(normalized)) return 'export_subtitles';
  if (['stitch_audio', 'audio_stitch', 'combine_audio', 'join_audio', 'append_audio'].includes(normalized)) return 'stitch_audio';
  if (['stitch_video', 'video_stitch', 'combine_video', 'join_video', 'append_video'].includes(normalized)) return 'stitch_video';
  if (['compose_media', 'media_composition', 'compose_video', 'sequence_media', 'sequence_images'].includes(normalized)) return 'compose_media';
  if (['burn_subtitles', 'burn_captions', 'caption_burn', 'subtitle_burn', 'hardcoded_captions', 'hardcoded_subtitles'].includes(normalized)) return 'burn_subtitles';
  if (['export', 'media_export', 'export_video', 'render'].includes(normalized)) return 'export';
  return '';
}

function normalizeIntentRefList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((entry) => normalizeArtifactRef(entry)).filter(Boolean);
}

function normalizeWizardIntentIr(value, options = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!input) {
    return { schemaVersion: WIZARD_INTENT_IR_SCHEMA_VERSION, sources: [], artifacts: [], stages: [], outputs: [], gaps: [], assumptions: [] };
  }
  const seenSources = new Set();
  const sources = (Array.isArray(input.sources) ? input.sources : []).map((source, index) => {
    const name = normalizeArtifactRef(source?.name || source?.id || source?.role, 'source-' + String(index + 1));
    if (!name || seenSources.has(name)) return null;
    seenSources.add(name);
    return {
      name,
      modality: normalizeIntentKind(source?.modality || source?.type || source?.kind, 'text'),
      role: trimPreviewText(normalizeString(source?.role || source?.label || source?.description, name), 80),
    };
  }).filter((source) => source && WIZARD_INTENT_SOURCE_MODALITIES.includes(source.modality));
  const seenArtifacts = new Set();
  const artifacts = (Array.isArray(input.artifacts) ? input.artifacts : []).map((artifact, index) => {
    const name = normalizeArtifactRef(artifact?.name || artifact?.id || artifact?.artifact, 'artifact-' + String(index + 1));
    if (!name || seenArtifacts.has(name)) return null;
    seenArtifacts.add(name);
    return {
      name,
      kind: normalizeIntentKind(artifact?.kind || artifact?.type || artifact?.modality, 'text'),
      role: trimPreviewText(normalizeString(artifact?.role || artifact?.label || artifact?.description), 120),
    };
  }).filter(Boolean);
  const seenStages = new Set();
  const stages = (Array.isArray(input.stages) ? input.stages : Array.isArray(input.steps) ? input.steps : []).map((stage, index) => {
    const kind = normalizeIntentStageKind(stage?.kind || stage?.type || stage?.operation || stage?.operationId || stage?.stageKind);
    if (!kind) return null;
    let id = normalizeArtifactKey(stage?.id || stage?.name, 'stage-' + String(index + 1));
    while (seenStages.has(id)) id = id + '-' + String(seenStages.size + 1);
    seenStages.add(id);
    const inputs = normalizeIntentRefList(stage?.inputs || stage?.inputArtifacts || stage?.input || stage?.source || stage?.from);
    const outputs = normalizeIntentRefList(stage?.outputs || stage?.outputArtifacts || stage?.output || stage?.artifact || stage?.to);
    return {
      id,
      kind,
      input: inputs[0] || '',
      inputs,
      output: outputs[0] || '',
      outputs,
      purpose: trimPreviewText(normalizeString(stage?.purpose || stage?.description || stage?.instruction), 220),
      operationSubtype: normalizeWizardOperationSubtype(stage?.operationSubtype || stage?.subtype || stage?.mode),
      providerPreference: normalizeProviderPreference(stage?.providerPreference || stage?.providerId || stage?.provider),
      mappingMode: normalizeWizardCollectionMappingMode(stage?.mappingMode || stage?.collectionMappingMode || stage?.mappingId),
      referenceAudio: normalizeArtifactRef(stage?.referenceAudio || stage?.referenceAudioSource || stage?.referenceAudioArtifact || stage?.voiceReference || stage?.voiceReferenceAudio),
      previousLastFrameChaining: stage?.previousLastFrameChaining === true || stage?.lastFrameChaining === true || stage?.chainPreviousLastFrame === true,
      mediaComposition: normalizeWizardMediaCompositionOptions({
        ...(stage?.mediaComposition && typeof stage.mediaComposition === 'object' ? stage.mediaComposition : {}),
        timingMode: stage?.timingMode || stage?.imageTimingMode || stage?.mediaComposition?.timingMode,
        fallbackSecondsPerImage: stage?.fallbackSecondsPerImage ?? stage?.mediaComposition?.fallbackSecondsPerImage,
        fixedSecondsPerImage: stage?.fixedSecondsPerImage ?? stage?.mediaComposition?.fixedSecondsPerImage,
        transitionsEnabled: stage?.transitionsEnabled ?? stage?.mediaComposition?.transitionsEnabled,
        transitionMode: stage?.transitionMode || stage?.mediaComposition?.transitionMode,
        transitionCategory: stage?.transitionCategory || stage?.mediaComposition?.transitionCategory,
        narrationVolume: stage?.narrationVolume ?? stage?.mediaComposition?.narrationVolume,
        backgroundMusicVolume: stage?.backgroundMusicVolume ?? stage?.mediaComposition?.backgroundMusicVolume,
        soundEffectsEnabled: stage?.soundEffectsEnabled ?? stage?.mediaComposition?.soundEffectsEnabled,
        soundEffectsVolume: stage?.soundEffectsVolume ?? stage?.mediaComposition?.soundEffectsVolume,
        soundEffectLibraryRefs: stage?.soundEffectLibraryRefs || stage?.mediaComposition?.soundEffectLibraryRefs,
      }),
      burnSubtitles: normalizeWizardBurnSubtitlesOptions({
        ...(stage?.burnSubtitles && typeof stage.burnSubtitles === 'object' ? stage.burnSubtitles : {}),
        fontLibraryRef: stage?.fontLibraryRef || stage?.burnSubtitles?.fontLibraryRef,
        colorPaletteRef: stage?.colorPaletteRef || stage?.burnSubtitles?.colorPaletteRef,
        position: stage?.position || stage?.burnSubtitles?.position,
        styleIntent: stage?.styleIntent || stage?.burnSubtitles?.styleIntent,
      }),
      normalizeMedia: normalizeWizardNormalizeMediaOptions({
        ...(stage?.normalizeMedia && typeof stage.normalizeMedia === 'object' ? stage.normalizeMedia : {}),
        mediaKind: stage?.mediaKind || stage?.normalizeMedia?.mediaKind,
        outputFormat: stage?.outputFormat || stage?.format || stage?.targetFormat || stage?.normalizeMedia?.outputFormat,
        unsupportedFormat: stage?.unsupportedFormat || stage?.normalizeMedia?.unsupportedFormat,
      }),
      collectionValidation: normalizeWizardCollectionValidationOptions({
        ...(stage?.collectionValidation && typeof stage.collectionValidation === 'object' ? stage.collectionValidation : {}),
        enabled: stage?.perItemValidation === true || stage?.collectionValidation?.enabled,
        scope: stage?.validationScope || stage?.collectionValidation?.scope || (stage?.perItemValidation === true ? 'perItem' : ''),
        ruleset: stage?.collectionValidation?.ruleset || stage?.validationRules,
        retryInstruction: stage?.collectionValidation?.retryInstruction || stage?.retryInstruction,
        maxAttempts: stage?.collectionValidation?.maxAttempts || stage?.maxAttempts,
        failMode: stage?.collectionValidation?.failMode || stage?.failureMode,
      }),
      validationMode: normalizeId(stage?.validationMode || stage?.mode),
      retryTarget: normalizeArtifactRef(stage?.retryTarget || stage?.targetStageId || stage?.target || stage?.retryTargetStageId),
      maxAttempts: Math.max(2, Math.min(PIPELINE_RETRY_LOOP_MAX_ATTEMPTS, Number(stage?.maxAttempts || stage?.attempts || 3) || 3)),
    };
  }).filter(Boolean);
  const outputs = (Array.isArray(input.outputs) ? input.outputs : []).map((output, index) => {
    const artifact = normalizeArtifactRef(output?.artifact || output?.name || output?.id || output?.source, 'output-' + String(index + 1));
    return artifact ? {
      artifact,
      kind: normalizeIntentKind(output?.kind || output?.type || output?.modality, ''),
      title: sanitizeRuntimeLabel(output?.title || output?.label || output?.name, options.intent, 'Wizard result'),
    } : null;
  }).filter(Boolean);
  return {
    schemaVersion: WIZARD_INTENT_IR_SCHEMA_VERSION,
    sources,
    artifacts,
    stages,
    outputs,
    gaps: (Array.isArray(input.gaps) ? input.gaps : []).map((gap) => trimPreviewText(normalizeString(gap), 220)).filter(Boolean),
    assumptions: normalizeWizardIntentAssumptions(input.assumptions),
  };
}

function isMisleadingCollectionMapAssumption(value) {
  const text = String(value || '').toLowerCase();
  return /collectionmap/.test(text)
    && /internal workflow/.test(text)
    && /llmprompt|llm prompt|model step/.test(text);
}

function normalizeWizardIntentAssumptions(value) {
  return (Array.isArray(value) ? value : [])
    .map((assumption) => trimPreviewText(normalizeString(assumption), 220))
    .filter((assumption) => assumption && !isMisleadingCollectionMapAssumption(assumption));
}

function buildIntentMatcher(pattern) {
  if (pattern instanceof RegExp) {
    const flags = pattern.flags.includes('i') ? pattern.flags : pattern.flags + 'i';
    return new RegExp(pattern.source, flags);
  }
  return new RegExp(String(pattern || ''), 'i');
}

function findIntentKeywordIndex(text, patterns = []) {
  const raw = String(text || '');
  for (const pattern of patterns) {
    const matcher = buildIntentMatcher(pattern);
    const match = matcher.exec(raw);
    if (match) {
      return match.index;
    }
  }
  return -1;
}

function intentHasPattern(text, patterns = []) {
  return findIntentKeywordIndex(text, patterns) >= 0;
}

function buildWizardSourceObligation(intent, features) {
  const text = String(intent || '');
  if (features.wantsTrimMedia) {
    const mediaKind = features.trimMediaKind === 'audio' ? 'audio' : 'video';
    return { name: 'source' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1), modality: mediaKind, role: 'Source ' + mediaKind, explicit: true };
  }
  if (features.wantsExtractAudio || features.wantsExtractVideoFrame) {
    return { name: 'sourceVideo', modality: 'video', role: 'Source video', explicit: true };
  }
  if (features.wantsBurnSubtitles) {
    return { name: 'sourceVideo', modality: 'video', role: 'Source video', explicit: true };
  }
  if (features.wantsExportSubtitles) {
    return { name: 'captionText', modality: 'text', role: 'Transcript or caption text', explicit: true };
  }
  if (features.wantsAudioStitch) {
    return { name: 'sourceAudioCollection', modality: 'collection:audio', role: 'Source audio collection', explicit: true };
  }
  if (features.wantsVideoStitch) {
    return { name: 'sourceVideoCollection', modality: 'collection:video', role: 'Source video collection', explicit: true };
  }  if (features.wantsNormalizeMedia && features.normalizeMediaKind) {
    const mediaKind = features.normalizeMediaKind;
    const isCollection = features.wantsNormalizeMediaCollection === true;
    const name = isCollection ? 'source' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1) + 'Collection' : 'source' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1);
    const role = (isCollection ? 'Source ' + mediaKind + ' collection' : 'Source ' + mediaKind);
    return { name, modality: isCollection ? 'collection:' + mediaKind : mediaKind, role, explicit: true };
  }
  if (features.wantsImageTransform || (features.wantsImageToVideo && !features.wantsPlanning) || intentHasPattern(text, [/\b(image input|input image|source image|image file|uploaded image|photo input|photo file)\b/])) {
    return { name: 'sourceImage', modality: 'image', role: features.wantsFaceFusionTransform ? 'Target image' : 'Source image', explicit: true };
  }
  if (features.wantsAudioTransform || intentHasPattern(text, [/\b(audio input|input audio|audio file|source audio|uploaded audio|interview audio|recording|voice memo|voice note|podcast audio)\b/])) {
    return { name: 'sourceAudio', modality: 'audio', role: 'Source audio', explicit: true };
  }
  if (intentHasPattern(text, [/\b(video input|input video|source video|video file|uploaded video|clip input)\b/])) {
    return { name: 'sourceVideo', modality: 'video', role: 'Source video', explicit: true };
  }
  if (intentHasPattern(text, [/\b(file input|source file|uploaded file|document|pdf|spreadsheet|csv)\b/])) {
    return { name: 'sourceFile', modality: 'file', role: 'Source file', explicit: true };
  }
  if (features.wantsVoiceoverSource) {
    return { name: 'voiceoverScript', modality: 'text', role: 'Voiceover script', explicit: true };
  }
  return { name: 'runtimeSource', modality: 'text', role: getRuntimeSourceLabel(intent), explicit: false };
}

function isTextDescriptionGenerationRequest(intent) {
  const text = String(intent || '');
  return intentHasPattern(text, [
    /\b(generat\w*|creat\w*|mak\w*|write|draft|produc\w*)\b[^.]{0,40}\b(text|description|caption|summary|transcript)\b[^.]{0,40}\b(of|about|for)\b[^.]{0,20}\b(images?|photo|picture)\b/,
    /\b(description|caption|summary|transcript)\b[^.]{0,40}\b(of|about|for)\b[^.]{0,20}\b(images?|photo|picture)\b/,
  ]);
}
function hasExplicitImageGenerationRequest(intent) {
  const text = String(intent || '');
  if (isTextDescriptionGenerationRequest(text)) {
    return false;
  }
  return intentHasPattern(text, [
    /\b(generat\w*|creat\w*|mak\w*|render\w*|produc\w*)\b[^.]{0,60}\b(images?|thumbnail|illustration|poster|visuals?|frames?)\b/,
    /\b(thumbnail|illustration|poster|visuals?|frames?)\b[^.]{0,60}\b(generat\w*|creat\w*|mak\w*|render\w*|produc\w*)\b/,
    /\b(text to image|image generation)\b/,
    /\b(turn|convert|transform|map)\b[^.]{0,80}\b(prompts?|text)\b[^.]{0,80}\b(images?|pictures?|visuals?)\b/,
    /\b(make|create|generate|produce)\b[^.]{0,60}\bone image\b[^.]{0,40}\b(each|per[-\s]?prompt|per[-\s]?scene)\b/,
  ]);
}
function isTextCollectionSourceRequest(intent) {
  const text = String(intent || '');
  return intentHasPattern(text, [
    /\b(collection|list|set|batch|multiple|many|several)\b[^.]{0,50}\b(text\s+)?prompts?\b/,
    /\b(text\s+)?prompts?\b[^.]{0,50}\b(collection|list|set|batch)\b/,
    /\b(each|per[-\s]?prompt|for each prompt|one image for each)\b/,
  ]);
}

function isImageCollectionSourceRequest(intent) {
  const text = String(intent || '');
  return intentHasPattern(text, [
    /\b(collection|list|set|batch|multiple|many|several)\b[^.]{0,60}\b(images?|photos?|pictures?)\b/,
    /\b(images?|photos?|pictures?)\b[^.]{0,60}\b(collection|list|set|batch)\b/,
    /\bthese\s+(images?|photos?|pictures?)\b/,
  ]);
}

function isCloudImageToImageRequest(intent) {
  const text = String(intent || '');
  return intentHasPattern(text, [
    /\b(image[-\s]?to[-\s]?image|image edit(?:ing)?|edit (?:an? |the )?image|modify (?:an? |the )?image)\b/,
    /\b(openai|google|gemini|xai|grok)\b[^.]{0,80}\b(edit|modify|image[-\s]?to[-\s]?image)\b/,
    /\b(edit|modify)\b[^.]{0,80}\b(images?|photos?|pictures?)\b[^.]{0,80}\b(openai|google|gemini|xai|grok)\b/,
  ]);
}

function inferProviderPreferenceFromIntent(intent) {
  const text = String(intent || '').toLowerCase();
  if (/\b(openai|gpt-image|chatgpt image|sora)\b/.test(text)) return 'openai';
  if (/\b(google|gemini|veo)\b/.test(text)) return 'google';
  if (/\b(xai|grok)\b/.test(text)) return 'xai';
  return '';
}

function isVideoSourceAnalysisRequest(intent) {
  const text = String(intent || '');
  return intentHasPattern(text, [
    /\b(summariz\w*|analy[sz]\w*|review|caption|describe|validate)\b[^.]{0,80}\b(video file|video input|source video|uploaded video|clip input|clip)\b/,
    /\b(video file|video input|source video|uploaded video|clip input|clip)\b[^.]{0,80}\b(summariz\w*|analy[sz]\w*|review|caption|describe|validate)\b/,
  ]);
}

function buildWizardSourceObligation(intent, features) {
  const text = String(intent || '');
  if (features.wantsTrimMedia) {
    const mediaKind = features.trimMediaKind === 'audio' ? 'audio' : 'video';
    return { name: 'source' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1), modality: mediaKind, role: 'Source ' + mediaKind, explicit: true };
  }
  if (features.wantsExtractAudio || features.wantsExtractVideoFrame) {
    return { name: 'sourceVideo', modality: 'video', role: 'Source video', explicit: true };
  }
  if (features.wantsBurnSubtitles) {
    return { name: 'sourceVideo', modality: 'video', role: 'Source video', explicit: true };
  }
  if (features.wantsExportSubtitles) {
    return { name: 'captionText', modality: 'text', role: 'Transcript or caption text', explicit: true };
  }
  if (features.wantsAudioStitch) {
    return { name: 'sourceAudioCollection', modality: 'collection:audio', role: 'Source audio collection', explicit: true };
  }
  if (features.wantsVideoStitch) {
    return { name: 'sourceVideoCollection', modality: 'collection:video', role: 'Source video collection', explicit: true };
  }  if (features.wantsNormalizeMedia && features.normalizeMediaKind) {
    const mediaKind = features.normalizeMediaKind;
    const isCollection = features.wantsNormalizeMediaCollection === true;
    const name = isCollection ? 'source' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1) + 'Collection' : 'source' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1);
    const role = (isCollection ? 'Source ' + mediaKind + ' collection' : 'Source ' + mediaKind);
    return { name, modality: isCollection ? 'collection:' + mediaKind : mediaKind, role, explicit: true };
  }
  if (features.wantsReferenceVoiceTts && features.wantsVoiceLineCollection) {
    return { name: 'voiceLineTexts', modality: 'collection:text', role: 'Voice line text collection', explicit: true };
  }
  if (features.wantsReferenceVoiceTts) {
    return { name: 'speechText', modality: 'text', role: 'Text to speak', explicit: true };
  }
  if (features.wantsAudioTransform || features.wantsTranscription || intentHasPattern(text, [/\b(audio input|input audio|source audio|audio file|uploaded audio|voice sample|reference audio|reference voice)\b/])) {
    return { name: features.wantsReferenceVoiceTts ? 'referenceVoiceAudio' : 'sourceAudio', modality: 'audio', role: features.wantsReferenceVoiceTts ? 'Reference voice audio' : 'Source audio', explicit: true };
  }
  if (isImageCollectionSourceRequest(text) && (features.wantsMediaComposition || isCloudImageToImageRequest(text) || features.wantsImageToVideo || features.wantsVideoGeneration)) {
    return { name: 'sourceImages', modality: 'collection:image', role: 'Source image collection', explicit: true };
  }
  if (features.wantsImageTransform || isCloudImageToImageRequest(text) || (features.wantsImageToVideo && !features.wantsPlanning) || intentHasPattern(text, [/\b(image input|input image|source image|image file|uploaded image|photo input|photo file)\b/])) {
    return { name: 'sourceImage', modality: 'image', role: 'Source image', explicit: true };
  }
  if (isVideoSourceAnalysisRequest(text)) {
    return { name: 'sourceVideo', modality: 'video', role: 'Source video', explicit: true };
  }
  if (features.wantsAudioTransform || features.wantsTranscription || intentHasPattern(text, [/\b(audio input|input audio|source audio|audio file|uploaded audio|voice sample|reference audio|reference voice)\b/])) {
    return { name: features.wantsReferenceVoiceTts ? 'referenceVoiceAudio' : 'sourceAudio', modality: 'audio', role: features.wantsReferenceVoiceTts ? 'Reference voice audio' : 'Source audio', explicit: true };
  }
  if (features.wantsFileInput || intentHasPattern(text, [/\b(file input|input file|document input|uploaded file|document file|source document|uploaded document)\b/])) {
    return { name: 'sourceFile', modality: 'file', role: 'Source file', explicit: true };
  }
  if (!features.wantsPlanning && isTextCollectionSourceRequest(text)) {
    return { name: 'promptCollection', modality: 'collection:text', role: 'Prompt collection', explicit: true };
  }
  return { name: 'userRequest', modality: 'text', role: 'User prompt', explicit: false };
}
function buildWizardOutputObligations(intent, features) {
  const text = String(intent || '');
  const outputs = [];
  const seen = new Set();
  const add = (artifact, kind, title, explicit = true) => {
    const normalizedKind = normalizeIntentKind(kind, '');
    const normalizedArtifact = normalizeArtifactRef(artifact, 'wizard-output');
    const key = normalizedArtifact + '|' + normalizedKind;
    if (!normalizedKind || !normalizedArtifact || seen.has(key)) {
      return;
    }
    seen.add(key);
    outputs.push({ artifact: normalizedArtifact, kind: normalizedKind, title: sanitizeRuntimeLabel(title, intent, 'Wizard result'), explicit });
  };
  const wantsScenePrompts = intentHasPattern(text, [/\b(scene prompts?|per[-\s]?scene prompts?|prompt collection|ordered collection|collection of prompts?)\b/])
    || (features.wantsPlanning && features.wantsPromptGeneration);
  const wantsExplicitTextOutput = intentHasPattern(text, [
    /\b(text output|output text|text result|approved text|approved description|approved transcript|transcript text)\b/,
    /\b(send|route|deliver|return|output)\b[^.]{0,100}\b(description|summary|transcript|text)\b/,
    /\b(send|route|deliver|return|output)\b[^.]{0,80}\b(description|summary|transcript|text)\b[^.]{0,40}\b(text output|text result|output)\b/,
    /\b(description|caption|summary|transcript)\b[^.]{0,40}\bto\b[^.]{0,30}\btext output\b/,
  ]);
  if (features.wantsTrimMedia && !wantsExplicitTextOutput && !features.wantsNormalizeMedia && !features.wantsExtractAudio && !features.wantsExtractVideoFrame) {
    const mediaKind = features.trimMediaKind === 'audio' ? 'audio' : 'video';
    add('trimmed' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1), mediaKind, 'Trimmed ' + mediaKind, true);
  }
  if (features.wantsExtractAudio && !wantsExplicitTextOutput) {
    add('extractedAudio', 'audio', 'Extracted audio', true);
  }
  if (features.wantsExtractVideoFrame && !hasExplicitImageGenerationRequest(text)) {
    add('extractedFrame', 'image', 'Extracted frame', true);
  }
  if (features.wantsExportSubtitles) {
    add('subtitleFile', 'file', 'Subtitle file', true);
  }
  if (features.wantsNormalizeMedia && features.normalizeMediaKind && !wantsExplicitTextOutput) {
    const mediaKind = features.normalizeMediaKind;
    add('normalized' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1), mediaKind, 'Normalized ' + mediaKind, true);
  }
  if (features.wantsAudioStitch) {
    add('stitchedAudio', 'audio', 'Stitched audio', true);
  }
  if (features.wantsVideoStitch) {
    add('stitchedVideo', 'video', 'Stitched video', true);
  }
  if (features.wantsPlanning && (intentHasPattern(text, [/\b(scene plan|approved plan|longform scene plan|shot list|storyboard plan)\b/]) || wantsScenePrompts)) {
    add('approvedPlan', 'plan', 'Approved scene plan');
  }
  if (wantsScenePrompts) {
    add('approvedScenePrompts', 'collection:text', 'Approved scene prompts');
  }
  if (wantsExplicitTextOutput) {
    add(
      features.wantsDescription ? 'approvedDescription' : 'textResult',
      'text',
      features.wantsDescription ? 'Approved description' : 'Text output',
      true,
    );
  }
  const wantsExplicitVideoOutput = intentHasPattern(text, [/\b(video output|output video|final video|storyboard video|export(?:ed)? video|render(?:ed)? video|final clip|captioned video|subtitled video)\b/]);
  if (wantsExplicitVideoOutput || features.wantsVideoGeneration || (!features.wantsDeterministicUtility && features.wantsVideo && !isVideoSourceAnalysisRequest(text))) {
    add(features.wantsBurnSubtitles ? 'captionedVideo' : features.wantsVideoGeneration && (!features.wantsMediaComposition || features.wantsImageToVideo) ? 'generatedVideo' : 'exportedVideo', 'video', features.wantsBurnSubtitles ? 'Captioned video' : 'Video output', wantsExplicitVideoOutput || features.wantsVideo);
  }
  const wantsImageCollection = hasExplicitImageGenerationRequest(text)
    && !features.wantsVideo
    && (wantsScenePrompts || features.wantsPlanning || intentHasPattern(text, [/\b(each|per[-\s]?(scene|item|prompt)|collection of images?|image collection|images? for each)\b/]));
  if (wantsImageCollection) {
    add('generatedImages', 'collection:image', 'Generated image collection', true);
  } else if (intentHasPattern(text, [/\b(image output|output image|final image|thumbnail|illustration|poster|generated image)\b/]) || (hasExplicitImageGenerationRequest(text) && !features.wantsVideoGeneration && !features.wantsMediaComposition)) {
    add('generatedImage', 'image', 'Generated image', true);
  }
  if (features.wantsReferenceVoiceTts && features.wantsVoiceLineCollection) {
    add('generatedVoiceLines', 'collection:audio', 'Generated voice lines', true);
  } else if (!features.wantsMediaComposition && !features.wantsDeterministicUtility && (features.wantsAudioGeneration || features.wantsAudioTransform || features.wantsReferenceVoiceTts || intentHasPattern(text, [/\b(audio output|output audio|narration audio|music|speech audio|generated audio|converted audio|voice conversion)\b/]))) {
    add(features.wantsAudioTransform ? 'transformedAudio' : 'generatedAudio', 'audio', 'Audio output', true);
  }
  if (features.wantsImageTransform) {
    add('transformedImage', 'image', 'Image output', true);
  }
  if (!outputs.length) {
    if (features.wantsBurnSubtitles) {
      add('captionedVideo', 'video', 'Captioned video', true);
    } else if (hasExplicitImageGenerationRequest(text) || features.wantsImageTransform) {
      add(features.wantsImageTransform ? 'transformedImage' : 'generatedImage', 'image', 'Image output', true);
    } else {
      add(
        features.wantsDescription ? 'approvedDescription' : features.wantsPlanning ? 'approvedPlan' : 'textResult',
        'text',
        features.wantsDescription ? 'Approved description' : 'Text output',
        false,
      );
    }
  }
  return outputs;
}

function buildWizardMediaCompositionOptions(intent, features = {}) {
  const text = String(intent || '').toLowerCase();
  const fallbackSecondsMatch = /\bfallback\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)?\s*(?:per|\/)?\s*(?:image|slide|item)\b/.exec(text)
    || /\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\s*(?:per|each)\s*(?:image|slide|item)\b/.exec(text);
  const fallbackSeconds = fallbackSecondsMatch ? Number(fallbackSecondsMatch[1]) : null;
  const narrationPercentMatch = /\bnarration\b[^.]{0,50}\b(\d{1,3})\s*%/.exec(text);
  const narrationVolume = narrationPercentMatch ? Math.max(0, Math.min(2, Number(narrationPercentMatch[1]) / 100)) : (/narration[^.]{0,40}(quiet|soft|low)|quiet[^.]{0,40}narration/.test(text) ? 0.8 : 1);
  const soundEffectLibraryRefs = [];
  if (/\bhalloween\b/.test(text)) soundEffectLibraryRefs.push('Halloween Sounds');
  if (/\b(spooky|horror)\b/.test(text)) soundEffectLibraryRefs.push('Spooky Sounds');
  return normalizeWizardMediaCompositionOptions({
    timingMode: features.wantsNarrationSyncedTiming ? 'dynamicFromImageMetadata' : '',
    fallbackSecondsPerImage: features.wantsNarrationSyncedTiming ? (fallbackSeconds || 4) : fallbackSeconds,
    fixedSecondsPerImage: features.wantsNarrationSyncedTiming ? null : (fallbackSeconds || 4),
    transitionsEnabled: Boolean(features.wantsSceneTransitions),
    transitionMode: features.wantsSceneTransitions ? (/\brandom\b/.test(text) ? 'randomCategory' : 'single') : '',
    transitionCategory: /wipe/.test(text) ? 'wipes' : /slide/.test(text) ? 'slides' : /horror|spooky|halloween/.test(text) ? 'blurPixel' : 'fades',
    narrationVolume,
    backgroundMusicVolume: /background music|music/.test(text) ? (/quiet|quietly|beneath|under|low|soft/.test(text) ? 0.18 : 0.22) : null,
    soundEffectsEnabled: Boolean(features.wantsSoundEffects),
    soundEffectsVolume: features.wantsSoundEffects ? 0.35 : null,
    soundEffectLibraryRefs,
  });
}

function buildWizardBurnSubtitlesOptions(intent, features = {}) {
  const text = String(intent || '').toLowerCase();
  return normalizeWizardBurnSubtitlesOptions({
    enabled: Boolean(features.wantsBurnSubtitles),
    position: /\btop\b/.test(text) ? 'topCenter' : /\bmiddle|center\b/.test(text) ? 'middleCenter' : 'bottomCenter',
    styleIntent: [
      /\blarge\b/.test(text) ? 'large' : '',
      /\bhorror|spooky|halloween\b/.test(text) ? 'horror' : '',
      /\bbold\b/.test(text) ? 'bold' : '',
    ].filter(Boolean).join(' '),
  });
}
function buildWizardNormalizeMediaOptions(features = {}) {
  return normalizeWizardNormalizeMediaOptions({
    mediaKind: features.normalizeMediaKind,
    outputFormat: features.normalizeMediaOutputFormat,
    unsupportedFormat: features.normalizeMediaUnsupportedFormat,
  });
}

function buildWizardPerItemValidationOptions(features = {}, wantsRetry = false) {
  if (!features.wantsPerItemCollectionValidation || features.wantsWholeCollectionValidation) {
    return normalizeWizardCollectionValidationOptions({});
  }
  return normalizeWizardCollectionValidationOptions({
    enabled: true,
    scope: 'perItem',
    mode: 'user',
    ruleset: 'Pass each mapped item only when it matches its source item and is usable for the next pipeline stage.',
    retryInstruction: 'Regenerate only the failed item and preserve the accepted items in collection order.',
    maxAttempts: wantsRetry ? 3 : 2,
    failMode: 'fail-fast',
  });
}
function buildWizardValidationTargets(intent, features) {
  const text = String(intent || '');
  const targets = [];
  const add = (target) => {
    if (target && !targets.includes(target)) {
      targets.push(target);
    }
  };

  if (intentHasPattern(text, [/\bvalidat\w*[^.]{0,60}\bplan\b/, /\bplan\b[^.]{0,60}\bvalidat\w*/])) add('plan');
  if (intentHasPattern(text, [/\bvalidat\w*[^.]{0,60}\b(prompt|scene prompts?|prompt collection)\b/, /\b(prompt|scene prompts?|prompt collection)\b[^.]{0,60}\bvalidat\w*/])) add('plan_scenes');
  if (features.wantsPromptGeneration && intentHasPattern(text, [/\b(validat\w*|review|check)\b[^.]{0,80}\b(each|each one|them|prompts?)\b/, /\bprompts?\b[^.]{0,80}\b(validat\w*|review|check)\b/])) add('plan_scenes');
  if (intentHasPattern(text, [/\bvalidat\w*[^.]{0,60}\bimages?\b/, /\bimages?\b[^.]{0,60}\bvalidat\w*/])) add('generate_image');
  if (intentHasPattern(text, [/\bvalidat\w*[^.]{0,80}\b(composition|slideshow|composed video|media)\b/, /\b(composition|slideshow|composed video|media)\b[^.]{0,80}\bvalidat\w*/])) add('compose_media');
  if (intentHasPattern(text, [/\bvalidat\w*[^.]{0,80}\b(captions?|subtitles?)\b/, /\b(captions?|subtitles?)\b[^.]{0,80}\bvalidat\w*/])) add('burn_subtitles');
  if (intentHasPattern(text, [/\bvalidat\w*[^.]{0,60}\b(description|caption|summary|text|transcript)\b/, /\b(description|caption|summary|text|transcript)\b[^.]{0,60}\bvalidat\w*/])) add('llm_generate_text');
  if (!targets.length && features.wantsValidation) add('latest');

  return targets;
}

function extractWizardRequestObligations(intent = '') {
  const normalizedIntent = normalizeString(intent);
  const features = inferIntentFeatures(normalizedIntent);
  const source = buildWizardSourceObligation(normalizedIntent, features);
  const outputs = buildWizardOutputObligations(normalizedIntent, features);
  const rawWantsImageGeneration = hasExplicitImageGenerationRequest(normalizedIntent);
  const wantsNormalizeMedia = Boolean(features.wantsNormalizeMedia && features.normalizeMediaKind);
  const wantsVideoGeneration = Boolean(!wantsNormalizeMedia && (!features.wantsMediaComposition || features.wantsImageToVideo) && features.wantsVideoGeneration && !isVideoSourceAnalysisRequest(normalizedIntent) && !(features.wantsPlanning && rawWantsImageGeneration));
  const wantsCloudImageToImage = isCloudImageToImageRequest(normalizedIntent);
  const wantsImageGeneration = (rawWantsImageGeneration || wantsCloudImageToImage) && !wantsVideoGeneration && !(features.wantsImageTransform && !wantsCloudImageToImage);
  const wantsTextCollectionSource = isTextCollectionSourceRequest(normalizedIntent);
  const wantsPromptCollection = outputs.some((output) => output.kind === 'collection:text')
    || wantsTextCollectionSource
    || (features.wantsPlanning && wantsImageGeneration)
    || intentHasPattern(normalizedIntent, [/\b(scene prompts?|per[-\s]?scene prompts?|prompt collection|prompt set|scene prompt set)\b/]);
  const wantsTextLikeOutput = outputs.some((output) => ['text', 'plan', 'collection:text'].includes(output.kind));
  const wantsAudioGeneration = Boolean((features.wantsAudioGeneration || features.wantsReferenceVoiceTts) && !features.wantsAudioTransform && !features.wantsTranscription && !(source.modality === 'audio' && wantsTextLikeOutput) && !/\btranscrib\w*|speech to text|audio to text\b/i.test(normalizedIntent));
  const wantsAudioTransform = Boolean(features.wantsAudioTransform);
  const wantsImageTransform = Boolean(features.wantsImageTransform && !wantsCloudImageToImage);
  const wantsVideoOutput = outputs.some((output) => output.kind === 'video') || intentHasPattern(normalizedIntent, [/\b(video output|output video|final video|storyboard video|export(?:ed)? video|render(?:ed)? video|final clip|captioned video|subtitled video)\b/]);
  const wantsComposition = !wantsVideoGeneration && (features.wantsMediaComposition || features.wantsNarrationSyncedTiming || features.wantsSoundEffects || ((wantsVideoOutput && wantsImageGeneration)
    || intentHasPattern(normalizedIntent, [/\b(sequence|sequenc\w+|compose|composition|slideshow|timeline)\b/])));
  const wantsExport = !features.wantsExportSubtitles && !features.wantsBurnSubtitles && !wantsVideoGeneration && features.wantsVideo && source.modality !== 'video' && !isVideoSourceAnalysisRequest(normalizedIntent);
  const transformKind = (source.modality === 'audio' || (source.modality === 'video' && features.wantsExtractAudio)) && (wantsTextLikeOutput || features.wantsPlanning || intentHasPattern(normalizedIntent, [/\btranscrib\w*|speech to text|audio to text\b/]))
    ? 'transcribe_audio'
    : source.modality !== 'text' && (features.wantsDescription || wantsTextLikeOutput) && !features.wantsPlanning && !features.wantsBurnSubtitles && !wantsImageGeneration && !wantsVideoGeneration && !wantsAudioGeneration
      ? 'llm_generate_text'
      : '';

  return {
    source,
    outputs,
    transformKind,
    wantsPlanning: Boolean(features.wantsPlanning),
    wantsPromptCollection,
    wantsTextCollectionSource,
    wantsValidation: Boolean(features.wantsValidation),
    wantsRetry: Boolean(features.wantsRetry),
    wantsImageGeneration,
    wantsTrimMedia: Boolean(features.wantsTrimMedia),
    trimMediaKind: features.trimMediaKind === 'audio' ? 'audio' : 'video',
    trimMediaOptions: normalizeWizardTrimMediaOptions(features.trimMediaOptions || {}),
    wantsExtractAudio: Boolean(features.wantsExtractAudio),
    wantsExtractVideoFrame: Boolean(features.wantsExtractVideoFrame),
    extractVideoFrameOptions: normalizeWizardExtractVideoFrameOptions(features.extractVideoFrameOptions || {}),
    wantsExportSubtitles: Boolean(features.wantsExportSubtitles),
    exportSubtitlesOptions: normalizeWizardExportSubtitlesOptions(features.exportSubtitlesOptions || {}),
    wantsAudioStitch: Boolean(features.wantsAudioStitch),
    wantsVideoStitch: Boolean(features.wantsVideoStitch),
    mediaStitchOptions: normalizeWizardMediaStitchOptions(features.mediaStitchOptions || {}),
    utilityAssumptions: [
      features.trimMediaOptions?.assumedTiming && !/\b(to|first|last|from|until|through)\b[^.]{0,40}\b\d/i.test(normalizedIntent) ? 'Trim Media uses a conservative 5 second duration because the request did not specify a complete time range.' : '',
      features.wantsAudioGeneration && source.modality === 'audio' && wantsTextLikeOutput ? 'The request mentions text-to-speech, but it starts from audio and asks for text output, so the wizard drafts transcription and leaves speech generation out.' : '',
      features.extractVideoFrameOptions?.assumedFrame ? 'Extract Video Frame defaults to the first frame because the request did not specify a timestamp or first/last frame.' : '',
    ].filter(Boolean),
    wantsNormalizeMedia,
    normalizeMediaOptions: buildWizardNormalizeMediaOptions(features),
    wantsAudioGeneration,
    wantsReferenceVoiceTts: Boolean(features.wantsReferenceVoiceTts),
    wantsVoiceLineCollection: Boolean(features.wantsVoiceLineCollection),
    wantsCloudImageToImage,
    wantsAudioTransform,
    wantsVideoGeneration,
    wantsImageTransform,
    wantsComposition,
    wantsBurnSubtitles: Boolean(features.wantsBurnSubtitles),
    collectionValidationOptions: buildWizardPerItemValidationOptions(features, features.wantsRetry),
    wantsHeavyStepCooldown: Boolean(features.wantsHeavyStepCooldown),
    heavyStepCooldownSeconds: features.heavyStepCooldownSeconds || 30,
    mediaCompositionOptions: buildWizardMediaCompositionOptions(normalizedIntent, features),
    burnSubtitlesOptions: buildWizardBurnSubtitlesOptions(normalizedIntent, features),
    wantsExport,
    wantsFaceFusionTransform: Boolean(features.wantsFaceFusionTransform),
    imageTransformReferenceRequired: Boolean(features.wantsFaceFusionTransform),
    extraSources: [
      ...(features.wantsFaceFusionTransform ? [{ name: 'referenceFaceImage', modality: 'image', role: 'Reference face image', explicit: true }] : []),
      ...(features.wantsReferenceVoiceTts ? [{ name: 'referenceVoiceAudio', modality: 'audio', role: 'Reference voice audio', explicit: true }] : []),
      ...(features.wantsBurnSubtitles ? [{ name: 'captionText', modality: 'text', role: 'Caption text', explicit: true }] : []),
      ...(wantsComposition && features.wantsVoiceoverSource && source.modality !== 'audio' ? [{ name: 'narrationAudio', modality: 'audio', role: 'Narration audio', explicit: true }] : []),
      ...(wantsComposition && /\b(background music|music bed|music track)\b/i.test(normalizedIntent) ? [{ name: 'backgroundMusic', modality: 'audio', role: 'Background music', explicit: true }] : []),
    ],
    providerPreference: inferProviderPreferenceFromIntent(normalizedIntent),
    previousLastFrameChaining: Boolean(features.wantsPreviousLastFrameChaining),
    forceLocalVideo: /\b(wan2?\.?1|wan webui|local video|locally)\b/i.test(normalizedIntent),
    prefersDescription: Boolean(features.wantsDescription),
    validationTargets: buildWizardValidationTargets(normalizedIntent, features),
  };
}

function hasStructuralRequestObligations(obligations = {}) {
  return Boolean(
    (obligations.source?.explicit && obligations.source?.modality !== 'text')
    || obligations.transformKind
    || obligations.wantsPlanning
    || obligations.wantsPromptCollection
    || obligations.wantsValidation
    || obligations.wantsRetry
    || obligations.wantsImageGeneration
    || obligations.wantsNormalizeMedia
    || obligations.wantsTrimMedia
    || obligations.wantsExtractAudio
    || obligations.wantsExtractVideoFrame
    || obligations.wantsExportSubtitles
    || obligations.wantsAudioStitch
    || obligations.wantsVideoStitch
    || obligations.wantsAudioGeneration
    || obligations.wantsAudioTransform
    || obligations.wantsVideoGeneration
    || obligations.wantsImageTransform
    || obligations.wantsComposition
    || obligations.wantsBurnSubtitles
    || obligations.wantsExport
    || (obligations.outputs || []).some((output) => output.kind && output.kind !== 'text'),
  );
}

function buildRequiredObligationStageKinds(obligations = {}) {
  const kinds = [];
  const validationTargets = Array.isArray(obligations.validationTargets) ? obligations.validationTargets : [];
  const addValidationPair = (target) => {
    if (validationTargets.includes(target)) {
      kinds.push('validate');
      if (obligations.wantsRetry) {
        kinds.push('retry');
      }
    }
  };
  const add = (kind, target = kind) => {
    kinds.push(kind);
    addValidationPair(target);
  };

  if (obligations.wantsTrimMedia) add('trim_media');
  if (obligations.wantsExtractAudio) add('extract_audio');
  if (obligations.wantsExtractVideoFrame) add('extract_video_frame');
  if (obligations.wantsAudioStitch) add('stitch_audio');
  if (obligations.wantsVideoStitch) add('stitch_video');
  if (obligations.wantsNormalizeMedia) add('normalize_media');
  if (obligations.transformKind) add(obligations.transformKind);
  if (obligations.wantsExportSubtitles) add('export_subtitles');
  if (obligations.wantsAudioGeneration) add('generate_audio');
  if (obligations.wantsAudioTransform) add('transform_audio');
  if (obligations.wantsVideoGeneration) add('generate_video');
  if (obligations.wantsImageTransform) add('transform_image');
  if (obligations.wantsPlanning) add('plan');
  if (obligations.wantsPromptCollection) add(obligations.wantsPlanning ? 'plan_scenes' : 'build_collection', obligations.wantsPlanning ? 'plan_scenes' : 'build_collection');
  if (obligations.wantsImageGeneration) add('generate_image');
  if (obligations.wantsValidation && validationTargets.includes('latest')) {
    kinds.push('validate');
    if (obligations.wantsRetry) {
      kinds.push('retry');
    }
  }
  if (obligations.wantsComposition) add('compose_media');
  if (obligations.wantsBurnSubtitles) add('burn_subtitles');
  if (obligations.wantsExport) {
    kinds.push('export');
  }
  return kinds;
}

function getIntentIrOutputKinds(intentIr = {}) {
  const artifactKinds = new Map((Array.isArray(intentIr.artifacts) ? intentIr.artifacts : []).map((artifact) => [artifact.name, artifact.kind]));
  return (Array.isArray(intentIr.outputs) ? intentIr.outputs : [])
    .map((output) => normalizeIntentKind(output?.kind || artifactKinds.get(output?.artifact) || '', ''))
    .filter(Boolean);
}

function doesIntentIrCoverObligations(intentIr, obligations) {
  const reasons = [];
  const normalizedIr = normalizeWizardIntentIr(intentIr);
  if (obligations.source?.explicit && !normalizedIr.sources.some((source) => source.modality === obligations.source.modality)) {
    reasons.push('source:' + obligations.source.modality);
  }
  for (const extraSource of obligations.extraSources || []) {
    if (extraSource?.modality && !normalizedIr.sources.some((source) => source.name === extraSource.name || (source.modality === extraSource.modality && source.role === extraSource.role))) {
      reasons.push('source:' + extraSource.modality + ':' + extraSource.name);
      break;
    }
  }

  const outputKinds = getIntentIrOutputKinds(normalizedIr);
  for (const output of obligations.outputs || []) {
    if (output.kind && !outputKinds.includes(output.kind)) {
      reasons.push('output:' + output.kind);
      break;
    }
  }

  const stageKinds = normalizedIr.stages.map((stage) => stage.kind).filter(Boolean);
  let cursor = -1;
  for (const requiredKind of buildRequiredObligationStageKinds(obligations)) {
    const nextIndex = stageKinds.findIndex((kind, index) => index > cursor && kind === requiredKind);
    if (nextIndex < 0) {
      reasons.push('stage:' + requiredKind);
      break;
    }
    cursor = nextIndex;
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}

function findIntentIrArtifactNameByKind(intentIr = {}, kind = '') {
  const normalizedKind = normalizeIntentKind(kind, '');
  if (!normalizedKind) {
    return '';
  }
  const artifact = (Array.isArray(intentIr.artifacts) ? intentIr.artifacts : []).find((entry) => normalizeIntentKind(entry?.kind, '') === normalizedKind);
  if (artifact?.name) {
    return artifact.name;
  }
  const output = (Array.isArray(intentIr.outputs) ? intentIr.outputs : []).find((entry) => normalizeIntentKind(entry?.kind, '') === normalizedKind);
  return normalizeArtifactRef(output?.artifact, '');
}

function applySimpleObligationRepairs(intentIr, obligations, options = {}) {
  const normalizedIr = normalizeWizardIntentIr(intentIr, options);
  const sources = [...normalizedIr.sources];
  if (obligations.source?.explicit && !sources.some((source) => source.modality === obligations.source.modality)) {
    sources.unshift({
      name: normalizeArtifactRef(obligations.source.name, 'runtimeSource'),
      modality: obligations.source.modality,
      role: trimPreviewText(normalizeString(obligations.source.role || obligations.source.name), 80),
    });
  }
  for (const extraSource of obligations.extraSources || []) {
    if (!sources.some((source) => source.name === extraSource.name)) {
      sources.push({
        name: normalizeArtifactRef(extraSource.name, 'runtimeSource'),
        modality: normalizeIntentKind(extraSource.modality, 'text'),
        role: trimPreviewText(normalizeString(extraSource.role || extraSource.name), 80),
      });
    }
  }

  const outputs = [...normalizedIr.outputs];
  const outputKinds = new Set(getIntentIrOutputKinds(normalizedIr));
  for (const output of obligations.outputs || []) {
    if (!output.kind || outputKinds.has(output.kind)) {
      continue;
    }
    outputs.push({
      artifact: findIntentIrArtifactNameByKind(normalizedIr, output.kind) || output.artifact,
      kind: output.kind,
      title: output.title,
    });
    outputKinds.add(output.kind);
  }

  return {
    ...normalizedIr,
    sources,
    outputs,
  };
}

function buildIntentIrStageLookup(stages = []) {
  const lookup = new Map();
  for (const stage of Array.isArray(stages) ? stages : []) {
    if (!lookup.has(stage.kind)) {
      lookup.set(stage.kind, []);
    }
    lookup.get(stage.kind).push(cloneValue(stage));
  }
  return lookup;
}

function getWizardIntentStageSupport(kind, artifactKind, options = {}) {
  const normalizedKind = normalizeIntentKind(artifactKind, artifactKind || '');
  if (kind === 'transcribe_audio') {
    return normalizedKind === 'audio'
      ? { ok: true, outputKind: 'text' }
      : { ok: false, message: 'Local AI Hub can only transcribe from an audio source artifact in this wizard pass.' };
  }
  if (kind === 'llm_generate_text') {
    return ['text', 'image', 'video', 'file'].includes(normalizedKind)
      ? { ok: true, outputKind: 'text' }
      : { ok: false, message: 'Local AI Hub does not yet route ' + normalizedKind + ' artifacts directly into a text-generation step in this wizard pass.' };
  }
  if (kind === 'plan') {
    return ['text', 'image', 'audio', 'video', 'file'].includes(normalizedKind)
      ? { ok: true, outputKind: 'plan' }
      : { ok: false, message: 'Local AI Hub could not preserve the requested planning stage because the source bridge is not yet supported.' };
  }
  if (kind === 'plan_scenes') {
    return normalizedKind === 'plan'
      ? { ok: true, outputKind: 'collection:text' }
      : { ok: false, message: 'Local AI Hub can only derive ordered scene prompts from a structured Plan artifact in this wizard pass.' };
  }
  if (kind === 'build_collection') {
    return ['text', 'image', 'audio', 'video', 'file'].includes(normalizedKind)
      ? { ok: true, outputKind: 'collection:' + normalizedKind }
      : { ok: false, message: 'Local AI Hub can only build collections from concrete runtime artifacts in this wizard pass.' };
  }
  if (kind === 'validate') {
    return normalizedKind
      ? { ok: true, outputKind: normalizedKind }
      : { ok: false, message: 'Local AI Hub could not place the requested validation stage because no supported upstream artifact was available.' };
  }
  if (kind === 'retry') {
    return options.hasValidation
      ? { ok: true, outputKind: normalizedKind || 'text' }
      : { ok: false, message: 'Local AI Hub can only add retry after a validation stage with pass/fail branches.' };
  }
  if (kind === 'generate_audio') {
    if (normalizedKind === 'collection:text' && options.operationSubtype === 'referenceVoiceTts') {
      return { ok: true, outputKind: 'collection:audio' };
    }
    return ['text', 'audio'].includes(normalizedKind)
      ? { ok: true, outputKind: 'audio' }
      : { ok: false, message: 'Local AI Hub can only generate audio from a text prompt, reference voice text collection, or supported audio guidance artifact in this wizard pass.' };
  }
  if (kind === 'transform_audio') {
    return normalizedKind === 'audio'
      ? { ok: true, outputKind: 'audio' }
      : { ok: false, message: 'Local AI Hub can only transform audio from an audio source artifact in this wizard pass.' };
  }
  if (kind === 'generate_video') {
    if (['collection:text', 'collection:image'].includes(normalizedKind)) {
      return { ok: true, outputKind: 'collection:video' };
    }
    return ['text', 'image'].includes(normalizedKind)
      ? { ok: true, outputKind: 'video' }
      : { ok: false, message: 'Local AI Hub can only generate video from a text prompt, image source, or supported text/image collection in this wizard pass.' };
  }
  if (kind === 'transform_image') {
    return normalizedKind === 'image'
      ? { ok: true, outputKind: 'image' }
      : { ok: false, message: 'Local AI Hub can only transform images from an image source artifact in this wizard pass.' };
  }
  if (kind === 'normalize_media') {
    return ['audio', 'video', 'image', 'collection:audio', 'collection:video', 'collection:image'].includes(normalizedKind)
      ? { ok: true, outputKind: normalizedKind }
      : { ok: false, message: 'Local AI Hub can only normalize or convert audio, video, image, or matching media collection artifacts in this wizard pass.' };
  }
  if (kind === 'trim_media') {
    return ['audio', 'video'].includes(normalizedKind)
      ? { ok: true, outputKind: normalizedKind }
      : { ok: false, message: 'Local AI Hub can only trim single audio or video artifacts in this wizard pass.' };
  }
  if (kind === 'extract_audio') {
    return normalizedKind === 'video'
      ? { ok: true, outputKind: 'audio' }
      : { ok: false, message: 'Local AI Hub can only extract audio from a video artifact.' };
  }
  if (kind === 'extract_video_frame') {
    return normalizedKind === 'video'
      ? { ok: true, outputKind: 'image' }
      : { ok: false, message: 'Local AI Hub can only extract thumbnails or frames from a video artifact.' };
  }
  if (kind === 'export_subtitles') {
    return normalizedKind === 'text'
      ? { ok: true, outputKind: 'file' }
      : { ok: false, message: 'Local AI Hub can export subtitle files from transcript or caption text in this wizard pass.' };
  }
  if (kind === 'stitch_audio') {
    return normalizedKind === 'collection:audio'
      ? { ok: true, outputKind: 'audio' }
      : { ok: false, message: 'Local AI Hub can only stitch an ordered audio collection.' };
  }
  if (kind === 'stitch_video') {
    return normalizedKind === 'collection:video'
      ? { ok: true, outputKind: 'video' }
      : { ok: false, message: 'Local AI Hub can only stitch an ordered video collection.' };
  }
  if (kind === 'generate_image') {
    if (normalizedKind === 'text' || normalizedKind === 'image') {
      return { ok: true, outputKind: 'image' };
    }
    if (normalizedKind === 'collection:text' || normalizedKind === 'collection:image') {
      return { ok: true, outputKind: 'collection:image' };
    }
    if (String(normalizedKind).startsWith('collection:')) {
      return { ok: false, message: 'Local AI Hub can only map text or image collections through image generation in this wizard pass. It preserved the collection and left the unsupported mapped operation as an explicit gap.' };
    }
    return { ok: false, message: 'Local AI Hub can only generate images from text prompts or image sources in this wizard pass.' };
  }
  if (kind === 'compose_media') {
    return normalizedKind === 'image' || normalizedKind === 'collection:image'
      ? { ok: true, outputKind: 'composition' }
      : { ok: false, message: 'Local AI Hub needs an ordered image collection before media composition can be compiled.' };
  }
  if (kind === 'burn_subtitles') {
    return normalizedKind === 'video'
      ? { ok: true, outputKind: 'video' }
      : { ok: false, message: 'Local AI Hub needs a video artifact before Burn Subtitles / Captions can be compiled.' };
  }
  if (kind === 'export') {
    return normalizedKind === 'composition'
      ? { ok: true, outputKind: 'video' }
      : { ok: false, message: 'Local AI Hub needs a media composition artifact before video export can be compiled.' };
  }
  return { ok: false, message: 'Local AI Hub does not support the requested stage kind yet.' };
}

function getWizardStagePurpose(kind, obligations) {
  if (kind === 'plan') {
    return 'Create a grounded structured plan from the connected runtime source.';
  }
  if (kind === 'plan_scenes') {
    return 'Derive ordered scene prompts from the approved plan.';
  }
  if (kind === 'build_collection') {
    return 'Build an ordered collection from the connected runtime prompt inputs.';
  }
  if (kind === 'llm_generate_text') {
    return obligations.prefersDescription
      ? 'Describe the connected runtime input in clear, specific text.'
      : 'Generate text from the connected runtime input.';
  }
  if (kind === 'generate_image') {
    return 'Generate an image from the connected prompt artifact.';
  }
  if (kind === 'generate_audio') {
    return 'Generate an audio artifact from the connected prompt or guidance.';
  }
  if (kind === 'transform_audio') {
    return 'Transform the connected source audio with editable voice-conversion settings.';
  }
  if (kind === 'generate_video') {
    return 'Generate a video artifact from the connected prompt or image source.';
  }
  if (kind === 'transform_image') {
    return 'Transform the connected source image with editable local image settings.';
  }
  if (kind === 'normalize_media') {
    return 'Normalize or convert the connected media format without changing its content.';
  }
  if (kind === 'trim_media') {
    return 'Trim the connected audio or video to the requested time range.';
  }
  if (kind === 'extract_audio') {
    return 'Extract the soundtrack from the connected video as an audio artifact.';
  }
  if (kind === 'extract_video_frame') {
    return 'Extract a still frame from the connected video.';
  }
  if (kind === 'export_subtitles') {
    return 'Export the connected transcript or caption text as a reusable subtitle file.';
  }
  if (kind === 'stitch_audio') {
    return 'Concatenate the ordered audio collection into one audio artifact.';
  }
  if (kind === 'stitch_video') {
    return 'Concatenate the ordered video collection into one video artifact.';
  }
  if (kind === 'compose_media') {
    return 'Sequence the connected approved images into a reusable composition.';
  }
  if (kind === 'burn_subtitles') {
    return 'Render the connected captions into the connected video with editable caption styling.';
  }
  if (kind === 'export') {
    return 'Export the connected composition as a video artifact.';
  }
  return '';
}
function getWizardValidationPurpose(targetKind, artifactKind) {
  if (targetKind === 'plan') {
    return 'Pass only if the plan is ordered, specific, and ready for downstream scene derivation.';
  }
  if (targetKind === 'plan_scenes') {
    return 'Pass only if the scene prompt collection is ordered, concrete, and ready for downstream generation.';
  }
  if (targetKind === 'generate_image') {
    return 'Pass only if the image matches the approved prompt and is usable for the next stage.';
  }
  if (targetKind === 'transcribe_audio' || targetKind === 'llm_generate_text') {
    return 'Pass only if the text is specific, accurate, and usable for the next stage.';
  }
  return getDefaultValidationRuleset(artifactKind);
}

function synthesizeIntentIrFromObligations(intentIr, obligations, options = {}) {
  const normalizedIr = normalizeWizardIntentIr(intentIr, options);
  const borrowedStages = buildIntentIrStageLookup(normalizedIr.stages);
  const sources = [];
  const artifacts = [];
  const artifactKindsByName = new Map();
  const stages = [];
  const outputs = [];
  const outputKeys = new Set();
  const gaps = new Set(normalizedIr.gaps || []);
  const assumptions = new Set([...(normalizedIr.assumptions || []), ...(obligations.utilityAssumptions || [])]);
  const remainingValidationTargets = new Set(obligations.validationTargets || []);
  let bridgeBroken = false;
  let currentArtifact = null;
  let lastStage = null;
  let lastValidationStage = null;
  let planArtifactName = '';
  let promptArtifactName = '';
  let imageArtifactName = '';
  let audioArtifactName = '';
  let compositionArtifactName = '';
  let videoArtifactName = '';
  let textArtifactName = '';
  let transcriptArtifactName = '';
  let fileArtifactName = '';
  let sourceArtifactName = '';
  let referenceImageArtifactName = '';

  const takeBorrowedStage = (kind) => {
    const list = borrowedStages.get(kind) || [];
    return list.length ? list.shift() : null;
  };

  const addSource = (entry) => {
    const sourceEntry = {
      name: normalizeArtifactRef(entry?.name || 'runtimeSource', 'runtimeSource'),
      modality: normalizeIntentKind(entry?.modality, 'text'),
      role: trimPreviewText(normalizeString(entry?.role || entry?.name || 'Runtime source'), 80),
    };
    if (!sources.some((source) => source.name === sourceEntry.name)) {
      sources.push(sourceEntry);
    }
    return sourceEntry;
  };

  const addArtifact = (name, kind, role = '') => {
    const normalizedName = normalizeArtifactRef(name, 'artifact-' + String(artifacts.length + 1));
    const normalizedKind = normalizeIntentKind(kind, 'text');
    if (!normalizedName || !normalizedKind) {
      return { name: normalizedName, kind: normalizedKind };
    }
    if (!artifactKindsByName.has(normalizedName)) {
      artifactKindsByName.set(normalizedName, normalizedKind);
      artifacts.push({
        name: normalizedName,
        kind: normalizedKind,
        role: trimPreviewText(normalizeString(role), 120),
      });
    }
    return { name: normalizedName, kind: artifactKindsByName.get(normalizedName) };
  };

  const addOutput = (artifact, kind, title) => {
    const normalizedKind = normalizeIntentKind(kind, '');
    const normalizedArtifact = normalizeArtifactRef(artifact, 'wizard-result');
    const key = normalizedArtifact + '|' + normalizedKind;
    if (!normalizedKind || !normalizedArtifact || outputKeys.has(key)) {
      return;
    }
    outputKeys.add(key);
    outputs.push({
      artifact: normalizedArtifact,
      kind: normalizedKind,
      title: sanitizeRuntimeLabel(title, options.intent, 'Wizard result'),
    });
  };

  const source = addSource(normalizedIr.sources[0] || obligations.source || { name: 'runtimeSource', modality: 'text', role: 'Runtime source' });
  addArtifact(source.name, source.modality, source.role);
  sourceArtifactName = source.name;
  currentArtifact = { name: source.name, kind: source.modality };
  for (const extraSource of obligations.extraSources || []) {
    const addedExtraSource = addSource(extraSource);
    addArtifact(addedExtraSource.name, addedExtraSource.modality, addedExtraSource.role);
    if (addedExtraSource.modality === 'image' && !referenceImageArtifactName) {
      referenceImageArtifactName = addedExtraSource.name;
    }
  }
  const collectionSourceInputNames = [];
  if (obligations.wantsTextCollectionSource && !obligations.wantsPlanning && source.modality === 'text') {
    for (const entry of [
      { name: 'promptItem2', modality: 'text', role: 'Additional prompt placeholder' },
      { name: 'promptItem3', modality: 'text', role: 'Additional prompt placeholder' },
    ]) {
      const extraSource = addSource(entry);
      addArtifact(extraSource.name, extraSource.modality, extraSource.role);
      collectionSourceInputNames.push(extraSource.name);
    }
  }

  const addStage = (kind, preferredId, outputName, extra = {}) => {
    const inputName = normalizeArtifactRef(extra.inputName || currentArtifact?.name, currentArtifact?.name || 'runtimeSource');
    const inputKind = normalizeIntentKind(extra.inputKind || currentArtifact?.kind, currentArtifact?.kind || 'text');
    const support = getWizardIntentStageSupport(kind, inputKind, {
      hasValidation: extra.hasValidation || Boolean(lastValidationStage),
      operationSubtype: normalizeWizardOperationSubtype(extra.operationSubtype || borrowedStages.get(kind)?.[0]?.operationSubtype),
    });
    if (!support.ok) {
      gaps.add(support.message);
      if (extra.breaksBridge !== false) {
        bridgeBroken = true;
      }
      return null;
    }

    const borrowed = takeBorrowedStage(kind);
    const outputArtifact = addArtifact(outputName, support.outputKind, extra.outputRole || outputName);
    const stage = {
      id: normalizeArtifactKey(borrowed?.id || preferredId, preferredId),
      kind,
      input: inputName,
      inputs: [...new Set([inputName, ...(Array.isArray(extra.inputNames) ? extra.inputNames : [])].filter(Boolean))],
      output: outputArtifact.name,
      outputs: outputArtifact.name ? [outputArtifact.name] : [],
      purpose: trimPreviewText(normalizeString(extra.purpose || borrowed?.purpose), 220),
      operationSubtype: normalizeWizardOperationSubtype(extra.operationSubtype || borrowed?.operationSubtype),
      providerPreference: normalizeProviderPreference(extra.providerPreference || borrowed?.providerPreference),
      mappingMode: normalizeWizardCollectionMappingMode(extra.mappingMode || borrowed?.mappingMode),
      referenceAudio: normalizeArtifactRef(extra.referenceAudio || borrowed?.referenceAudio, ''),
      previousLastFrameChaining: extra.previousLastFrameChaining === true || borrowed?.previousLastFrameChaining === true,
      normalizeMedia: normalizeWizardNormalizeMediaOptions({ ...(borrowed?.normalizeMedia || {}), ...(extra.normalizeMedia || {}) }),
      trimMedia: normalizeWizardTrimMediaOptions({ ...(borrowed?.trimMedia || {}), ...(extra.trimMedia || {}) }),
      extractVideoFrame: normalizeWizardExtractVideoFrameOptions({ ...(borrowed?.extractVideoFrame || {}), ...(extra.extractVideoFrame || {}) }),
      exportSubtitles: normalizeWizardExportSubtitlesOptions({ ...(borrowed?.exportSubtitles || {}), ...(extra.exportSubtitles || {}) }),
      mediaStitch: normalizeWizardMediaStitchOptions({ ...(borrowed?.mediaStitch || {}), ...(extra.mediaStitch || {}) }),
      collectionValidation: normalizeWizardCollectionValidationOptions({ ...(borrowed?.collectionValidation || {}), ...(extra.collectionValidation || {}) }),
      mediaComposition: normalizeWizardMediaCompositionOptions({ ...(borrowed?.mediaComposition || {}), ...(extra.mediaComposition || {}) }),
      burnSubtitles: normalizeWizardBurnSubtitlesOptions({ ...(borrowed?.burnSubtitles || {}), ...(extra.burnSubtitles || {}) }),
      validationMode: normalizeId(extra.validationMode || borrowed?.validationMode),
      retryTarget: normalizeArtifactRef(extra.retryTarget || borrowed?.retryTarget, ''),
      maxAttempts: Math.max(2, Math.min(PIPELINE_RETRY_LOOP_MAX_ATTEMPTS, Number(extra.maxAttempts || borrowed?.maxAttempts || 3) || 3)),
    };
    stages.push(stage);
    currentArtifact = { name: outputArtifact.name, kind: outputArtifact.kind };
    lastStage = stage;
    if (kind === 'validate') {
      lastValidationStage = stage;
    }
    return stage;
  };

  const addValidationPair = (targetKind, targetStage, reviewedName, approvedName) => {
    const shouldAdd = remainingValidationTargets.has(targetKind) || (targetKind === 'latest' && remainingValidationTargets.has('latest'));
    if (!shouldAdd || bridgeBroken || !currentArtifact) {
      return;
    }
    const targetArtifact = { ...currentArtifact };
    const validationStage = addStage('validate', 'validate-' + targetKind.replace(/_/g, '-'), reviewedName, {
      inputName: targetArtifact.name,
      inputKind: targetArtifact.kind,
      purpose: getWizardValidationPurpose(targetKind, targetArtifact.kind),
      validationMode: targetKind === 'generate_image' ? 'user' : '',
    });
    remainingValidationTargets.delete(targetKind);
    if (!validationStage) {
      remainingValidationTargets.delete('latest');
      return;
    }
    if (obligations.wantsRetry) {
      addStage('retry', 'retry-' + targetKind.replace(/_/g, '-'), approvedName, {
        inputName: validationStage.output,
        inputKind: targetArtifact.kind,
        retryTarget: targetStage?.id || '',
        maxAttempts: 3,
        hasValidation: true,
      });
    }
  };

  if (obligations.wantsTrimMedia && !bridgeBroken) {
    const mediaKind = currentArtifact?.kind === 'audio' || obligations.trimMediaKind === 'audio' ? 'audio' : 'video';
    const trimStage = addStage('trim_media', 'trim-' + mediaKind, 'trimmed' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1), {
      trimMedia: obligations.trimMediaOptions || {},
      purpose: getWizardStagePurpose('trim_media', obligations),
    });
    if (trimStage) {
      if (mediaKind === 'audio') audioArtifactName = currentArtifact.name;
      if (mediaKind === 'video') videoArtifactName = currentArtifact.name;
      addValidationPair('trim_media', trimStage, 'reviewedTrimmed' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1), 'approvedTrimmed' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1));
    }
  }

  if (obligations.wantsExtractAudio && !bridgeBroken) {
    const extractStage = addStage('extract_audio', 'extract-audio', 'extractedAudio', {
      purpose: getWizardStagePurpose('extract_audio', obligations),
    });
    if (extractStage) {
      audioArtifactName = currentArtifact.name;
      addValidationPair('extract_audio', extractStage, 'reviewedExtractedAudio', 'approvedExtractedAudio');
    }
  }

  if (obligations.wantsExtractVideoFrame && !bridgeBroken) {
    const frameStage = addStage('extract_video_frame', 'extract-video-frame', 'extractedFrame', {
      extractVideoFrame: obligations.extractVideoFrameOptions || {},
      purpose: getWizardStagePurpose('extract_video_frame', obligations),
    });
    if (frameStage) {
      imageArtifactName = currentArtifact.name;
      addValidationPair('extract_video_frame', frameStage, 'reviewedExtractedFrame', 'approvedExtractedFrame');
    }
  }

  if (obligations.wantsAudioStitch && !bridgeBroken) {
    const stitchStage = addStage('stitch_audio', 'stitch-audio', 'stitchedAudio', {
      mediaStitch: obligations.mediaStitchOptions || {},
      purpose: getWizardStagePurpose('stitch_audio', obligations),
    });
    if (stitchStage) {
      audioArtifactName = currentArtifact.name;
      addValidationPair('stitch_audio', stitchStage, 'reviewedStitchedAudio', 'approvedStitchedAudio');
    }
  }

  if (obligations.wantsVideoStitch && !bridgeBroken) {
    const stitchStage = addStage('stitch_video', 'stitch-video', 'stitchedVideo', {
      mediaStitch: obligations.mediaStitchOptions || {},
      purpose: getWizardStagePurpose('stitch_video', obligations),
    });
    if (stitchStage) {
      videoArtifactName = currentArtifact.name;
      addValidationPair('stitch_video', stitchStage, 'reviewedStitchedVideo', 'approvedStitchedVideo');
    }
  }

  if (obligations.wantsNormalizeMedia && !bridgeBroken) {
    const normalizedKind = currentArtifact?.kind || obligations.source?.modality || obligations.normalizeMediaOptions?.mediaKind || 'audio';
    const mediaKind = getIntentCollectionItemKind(normalizedKind) || normalizedKind;
    const outputName = String(normalizedKind).startsWith('collection:')
      ? 'normalized' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1) + 'Collection'
      : 'normalized' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1);
    const normalizeStage = addStage('normalize_media', 'normalize-' + mediaKind, outputName, {
      normalizeMedia: obligations.normalizeMediaOptions || {},
      purpose: getWizardStagePurpose('normalize_media', obligations),
    });
    if (normalizeStage) {
      if (mediaKind === 'audio') audioArtifactName = currentArtifact.name;
      if (mediaKind === 'video') videoArtifactName = currentArtifact.name;
      if (mediaKind === 'image') imageArtifactName = currentArtifact.name;
      addValidationPair('normalize_media', normalizeStage, 'reviewedNormalized' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1), 'approvedNormalized' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1));
    }
  }

  const borrowedTranscriptionStages = borrowedStages.get('transcribe_audio') || [];
  const transformKind = obligations.transformKind || (currentArtifact?.kind === 'audio' && borrowedTranscriptionStages.length ? 'transcribe_audio' : '');
  if (transformKind) {
    const transformOutputName = transformKind === 'transcribe_audio'
      ? 'transcript'
      : obligations.prefersDescription
        ? 'description'
        : 'textResult';
    const transformStage = addStage(transformKind, transformKind.replace(/_/g, '-'), transformOutputName, {
      purpose: getWizardStagePurpose(transformKind, obligations),
    });
    if (transformStage) {
      if (transformKind === 'transcribe_audio') {
        transcriptArtifactName = currentArtifact.name;
      } else {
        textArtifactName = currentArtifact.name;
      }
      addValidationPair(transformKind, transformStage, 'reviewed-' + transformOutputName, obligations.prefersDescription ? 'approvedDescription' : 'approvedText');
      if (transformKind === 'transcribe_audio' && currentArtifact?.kind === 'text') {
        transcriptArtifactName = currentArtifact.name;
      }
      if (transformKind === 'llm_generate_text' && currentArtifact?.kind === 'text') {
        textArtifactName = currentArtifact.name;
      }
    }
  }

  if (obligations.wantsExportSubtitles && !bridgeBroken) {
    const subtitlesStage = addStage('export_subtitles', 'export-subtitles', 'subtitleFile', {
      exportSubtitles: obligations.exportSubtitlesOptions || {},
      purpose: getWizardStagePurpose('export_subtitles', obligations),
    });
    if (subtitlesStage) {
      fileArtifactName = currentArtifact.name;
      addValidationPair('export_subtitles', subtitlesStage, 'reviewedSubtitleFile', 'approvedSubtitleFile');
    }
  }

  if (obligations.wantsAudioGeneration && !bridgeBroken) {
    const audioStage = addStage('generate_audio', 'generate-audio', obligations.wantsVoiceLineCollection ? 'generatedVoiceLines' : 'generatedAudio', {
      inputName: sourceArtifactName,
      inputKind: source.modality,
      inputNames: obligations.wantsReferenceVoiceTts ? ['referenceVoiceAudio'] : [],
      operationSubtype: obligations.wantsReferenceVoiceTts ? 'referenceVoiceTts' : '',
      mappingMode: obligations.wantsReferenceVoiceTts && source.modality === 'collection:text' ? 'textToAudio' : '',
      referenceAudio: obligations.wantsReferenceVoiceTts ? 'referenceVoiceAudio' : '',
      purpose: obligations.wantsReferenceVoiceTts ? 'Generate speech from the connected text using the shared reference voice audio.' : getWizardStagePurpose('generate_audio', obligations),
    });
    if (audioStage) {
      audioArtifactName = currentArtifact.name;
      addValidationPair('generate_audio', audioStage, 'reviewedAudio', 'approvedAudio');
    }
  }

  if (obligations.wantsAudioTransform && !bridgeBroken) {
    const audioStage = addStage('transform_audio', 'transform-audio', 'transformedAudio', {
      inputName: sourceArtifactName,
      inputKind: source.modality,
      purpose: getWizardStagePurpose('transform_audio', obligations),
    });
    if (audioStage) {
      audioArtifactName = currentArtifact.name;
      addValidationPair('transform_audio', audioStage, 'reviewedAudio', 'approvedAudio');
    }
  }

  if (obligations.wantsVideoGeneration && !bridgeBroken) {
    const videoStage = addStage('generate_video', 'generate-video', String(source.modality).startsWith('collection:') ? 'generatedVideos' : 'generatedVideo', {
      inputName: sourceArtifactName,
      inputKind: source.modality,
      operationSubtype: source.modality === 'image' || source.modality === 'collection:image' ? 'imageToVideo' : 'textToVideo',
      mappingMode: source.modality === 'collection:image' ? 'cloudImageToVideo' : source.modality === 'collection:text' ? 'textToVideo' : '',
      providerPreference: obligations.providerPreference,
      previousLastFrameChaining: obligations.previousLastFrameChaining,
      purpose: getWizardStagePurpose('generate_video', obligations),
    });
    if (videoStage) {
      videoArtifactName = currentArtifact.name;
      addValidationPair('generate_video', videoStage, 'reviewedVideo', 'approvedVideo');
    }
  }

  if (obligations.wantsImageTransform && !bridgeBroken) {
    const inputNames = referenceImageArtifactName ? [referenceImageArtifactName] : [];
    const imageStage = addStage('transform_image', 'transform-image', 'transformedImage', {
      inputName: sourceArtifactName,
      inputKind: source.modality,
      inputNames,
      purpose: obligations.wantsFaceFusionTransform ? 'Transform the target image using a reference face image placeholder.' : getWizardStagePurpose('transform_image', obligations),
    });
    if (imageStage) {
      imageArtifactName = currentArtifact.name;
      addValidationPair('transform_image', imageStage, 'reviewedImage', 'approvedImage');
    }
  }

  if (obligations.wantsPlanning && !bridgeBroken) {
    const planStage = addStage('plan', 'plan-stage', 'scenePlan', {
      purpose: getWizardStagePurpose('plan', obligations),
    });
    if (planStage) {
      planArtifactName = currentArtifact.name;
      addValidationPair('plan', planStage, 'reviewedPlan', 'approvedPlan');
      if (currentArtifact?.kind === 'plan') {
        planArtifactName = currentArtifact.name;
      }
    }
  }

  if (obligations.wantsPromptCollection && source.modality !== 'collection:text' && !bridgeBroken) {
    const promptStageKind = obligations.wantsPlanning ? 'plan_scenes' : 'build_collection';
    const promptStage = addStage(promptStageKind, obligations.wantsPlanning ? 'plan-scenes' : 'build-collection', 'scenePrompts', {
      inputNames: obligations.wantsPlanning ? [] : collectionSourceInputNames,
      purpose: getWizardStagePurpose(promptStageKind, obligations),
    });
    if (promptStage) {
      promptArtifactName = currentArtifact.name;
      if (remainingValidationTargets.has('plan_scenes') && obligations.wantsRetry) {
        gaps.add('Prompt collection validation before mapping remains a whole-collection review. Per-item validation and retry are available on downstream Map Collection item-generation steps.');
      }
      addValidationPair('plan_scenes', promptStage, 'reviewedScenePrompts', 'approvedScenePrompts');
      if (String(currentArtifact?.kind || '').startsWith('collection:')) {
        promptArtifactName = currentArtifact.name;
      }
    }
  }

  if (obligations.wantsImageGeneration && !bridgeBroken) {
    const imageOutputName = (obligations.outputs || []).some((output) => output.kind === 'collection:image') || String(currentArtifact?.kind || '').startsWith('collection:') ? 'generatedImages' : 'generatedImage';
    const imageStage = addStage('generate_image', 'generate-image', imageOutputName, {
      operationSubtype: currentArtifact?.kind === 'image' || currentArtifact?.kind === 'collection:image' ? 'imageToImage' : 'textToImage',
      mappingMode: currentArtifact?.kind === 'collection:image' ? 'cloudImageToImage' : currentArtifact?.kind === 'collection:text' ? 'textToImage' : '',
      providerPreference: obligations.providerPreference,
      collectionValidation: obligations.collectionValidationOptions || {},
      purpose: getWizardStagePurpose('generate_image', obligations),
    });
    if (imageStage) {
      imageArtifactName = currentArtifact.name;
      if (!imageStage.collectionValidation?.enabled) {
        addValidationPair('generate_image', imageStage, 'reviewedImage', 'approvedImage');
      }
      if (currentArtifact?.kind === 'image') {
        imageArtifactName = currentArtifact.name;
      }
    }
  }

  if (remainingValidationTargets.has('latest') && !bridgeBroken && lastStage && currentArtifact) {
    addValidationPair('latest', lastStage, 'reviewedResult', 'approvedResult');
    remainingValidationTargets.delete('latest');
  }
  if (obligations.wantsComposition && !bridgeBroken) {
    const compositionStage = addStage('compose_media', 'compose-media', 'mediaComposition', {
      inputNames: [source.modality === 'audio' ? sourceArtifactName : '', 'narrationAudio', 'backgroundMusic'].filter(Boolean),
      mediaComposition: obligations.mediaCompositionOptions || {},
      purpose: getWizardStagePurpose('compose_media', obligations),
    });
    if (compositionStage) {
      compositionArtifactName = currentArtifact.name;
      addValidationPair('compose_media', compositionStage, 'reviewedMediaComposition', 'approvedMediaComposition');
    }
  }

  if (obligations.wantsExport && !bridgeBroken) {
    const exportStage = addStage('export', 'export-video', 'exportedVideo', {
      purpose: getWizardStagePurpose('export', obligations),
    });
    if (exportStage) {
      videoArtifactName = currentArtifact.name;
    }
  }

  if (obligations.wantsBurnSubtitles && !bridgeBroken) {
    const burnVideoInputName = videoArtifactName || (source.modality === 'video' ? sourceArtifactName : '') || (currentArtifact?.kind === 'video' ? currentArtifact.name : '');
    const burnStage = addStage('burn_subtitles', 'burn-subtitles', 'captionedVideo', {
      inputName: burnVideoInputName || currentArtifact?.name,
      inputKind: burnVideoInputName ? 'video' : currentArtifact?.kind,
      inputNames: ['captionText', transcriptArtifactName, textArtifactName].filter(Boolean),
      burnSubtitles: obligations.burnSubtitlesOptions || {},
      purpose: getWizardStagePurpose('burn_subtitles', obligations),
    });
    if (burnStage) {
      videoArtifactName = currentArtifact.name;
      addValidationPair('burn_subtitles', burnStage, 'reviewedCaptionedVideo', 'approvedCaptionedVideo');
    }
  }
  for (const output of obligations.outputs || []) {
    let artifactName = output.artifact;
    if (output.kind === 'plan') {
      artifactName = planArtifactName || output.artifact;
    } else if (output.kind === 'collection:text') {
      artifactName = promptArtifactName || output.artifact;
    } else if (output.kind === 'image') {
      artifactName = imageArtifactName || output.artifact;
    } else if (output.kind === 'audio') {
      artifactName = audioArtifactName || output.artifact;
    } else if (output.kind === 'video') {
      artifactName = videoArtifactName || output.artifact;
    } else if (output.kind === 'text') {
      artifactName = textArtifactName || transcriptArtifactName || output.artifact;
    } else if (output.kind === 'file') {
      artifactName = fileArtifactName || output.artifact;
    }
    addOutput(artifactName, output.kind, output.title);
  }

  if (!outputs.length && currentArtifact?.name) {
    addOutput(currentArtifact.name, currentArtifact.kind, 'Wizard result');
  }

  return {
    schemaVersion: WIZARD_INTENT_IR_SCHEMA_VERSION,
    sources,
    artifacts,
    stages,
    outputs,
    gaps: [...gaps],
    assumptions: normalizeWizardIntentAssumptions([...assumptions]),
  };
}

function repairPipelineWizardPlan(plan = {}, options = {}) {
  const obligations = extractWizardRequestObligations(options.intent || '');
  const hasDraftGraph = Array.isArray(plan?.draftGraph?.nodes) && plan.draftGraph.nodes.length > 0;
  if (hasDraftGraph || !hasStructuralRequestObligations(obligations)) {
    return {
      ...plan,
      requestObligations: obligations,
      intentIrRepair: {
        applied: false,
        reasons: hasDraftGraph ? ['draftGraph-preserved'] : [],
      },
    };
  }

  const coverage = doesIntentIrCoverObligations(plan.intentIr, obligations);
  const repairedIntentIr = coverage.ok
    ? applySimpleObligationRepairs(plan.intentIr, obligations, options)
    : synthesizeIntentIrFromObligations(plan.intentIr, obligations, options);

  return {
    ...plan,
    intentIr: repairedIntentIr,
    requestObligations: obligations,
    intentIrRepair: {
      applied: !coverage.ok,
      reasons: coverage.reasons,
      sourceModality: repairedIntentIr.sources?.[0]?.modality || '',
      stageKinds: repairedIntentIr.stages.map((stage) => stage.kind),
      outputKinds: repairedIntentIr.outputs.map((output) => output.kind).filter(Boolean),
    },
  };
}

function parsePipelineWizardPlan(replyText, options = {}) {
  const parsed = extractJsonObject(replyText);
  const allowedRecipeIds = new Set(WIZARD_RECIPE_OPTIONS.map((recipe) => recipe.id));
  const fallbackRecipeId = inferRecipeIdFromIntent(options.intent || '');
  const recipeId = allowedRecipeIds.has(String(parsed?.recipeId || '').trim())
    ? String(parsed.recipeId).trim()
    : fallbackRecipeId;
  const intentIr = normalizeWizardIntentIr(parsed?.intentIr || parsed?.intentIR || parsed?.wizardIntent || parsed?.ir, { intent: options.intent });

  return {
    schemaVersion: WIZARD_PLAN_SCHEMA_VERSION,
    recipeId,
    title: sanitizePlanTitle(parsed?.title, options.intent, recipeId),
    summary: sanitizePlanSummary(parsed?.summary, recipeId),
    draftGraph: normalizeDraftGraph(parsed?.draftGraph || parsed?.graph || parsed),
    intentIr,
    steps: Array.isArray(parsed?.steps)
      ? parsed.steps.map((step) => ({
          operationId: Object.values(PIPELINE_OPERATION_IDS).includes(step?.operationId) ? step.operationId : '',
          purpose: trimPreviewText(normalizeString(step?.purpose), 220),
          targetId: normalizeId(step?.targetId),
          targetKind: normalizeId(step?.targetKind),
        })).filter((step) => step.operationId || step.purpose || step.targetId)
      : [],
    gaps: Array.isArray(parsed?.gaps)
      ? parsed.gaps.map((gap) => trimPreviewText(normalizeString(gap), 220)).filter(Boolean)
      : [],
    userRefinementNotes: Array.isArray(parsed?.userRefinementNotes)
      ? parsed.userRefinementNotes.map((note) => trimPreviewText(normalizeString(note), 220)).filter(Boolean)
      : [],
    usedFallback: !parsed || !allowedRecipeIds.has(String(parsed?.recipeId || '').trim()),
  };
}

function getRecipeOption(recipeId) {
  return WIZARD_RECIPE_OPTIONS.find((recipe) => recipe.id === recipeId) || null;
}

function buildPipelineTitle(intent, recipeId) {
  const features = inferIntentFeatures(intent);

  if (features.wantsPlanning && features.wantsValidation && features.wantsImageGeneration && features.wantsVideo) {
    return 'Validated storyboard video draft';
  }
  if (features.wantsVoiceoverSource && features.wantsPlanning) {
    return 'Voiceover scene planning draft';
  }

  if (features.wantsPlanning && features.wantsVideo) {
    return 'Scene-to-video planning draft';
  }
  if (features.wantsImageGeneration) {
    return 'Image generation draft';
  }
  return getRecipeOption(recipeId)?.label || 'Wizard draft pipeline';
}

function getTargetLabel(target = {}, context = {}) {
  const model = normalizeModelId(target.model);
  if (target.executionMode === 'ollama') {
    return ['Ollama', model].filter(Boolean).join(' / ');
  }
  if (target.executionMode === 'localTool' || target.executionMode === 'localTool') {
    return getToolEntry(context, target.toolId)?.name || target.toolId || 'local tool';
  }
  const providerLabel = getProviderEntry(context, target.providerId)?.name || target.providerId || 'provider';
  return [providerLabel, model].filter(Boolean).join(' / ');
}

function normalizeWizardTarget(wizardTarget = {}) {
  return {
    mode: wizardTarget.mode === 'ollama' ? 'ollama' : 'cloud',
    providerId: normalizeId(wizardTarget.providerId),
    model: normalizeModelId(wizardTarget.model),
  };
}

function getPreferredToolId(operationId, context, candidateToolIds = []) {
  const candidates = candidateToolIds.length ? candidateToolIds : (context.availableTools || []).map((tool) => tool.id);
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
    const selection = selectLocalImageBackend(buildContextMaps({
      hardware: context.hardware,
      toolCatalog: context.availableTools || [],
      tools: context.availableTools || [],
    }), { config: {} }, { candidateToolIds: candidates, operationId });
    if (selection.usable && selection.toolId) {
      return selection.toolId;
    }
  }

  for (const toolId of candidates.map(normalizeId)) {
    const tool = getToolEntry(context, toolId);
    if (tool && getToolPipelineOperation(tool.id, operationId) && isCompatibilityPractical(tool)) {
      return tool.id;
    }
  }
  for (const toolId of candidates.map(normalizeId)) {
    const tool = getToolEntry(context, toolId);
    if (tool && getToolPipelineOperation(tool.id, operationId)) {
      return tool.id;
    }
  }
  return '';
}

function getPreferredProviderId(operationId, context, preferredProviderId = '', allowedProviderIds = []) {
  const allowed = (Array.isArray(allowedProviderIds) ? allowedProviderIds : []).map(normalizeId).filter(Boolean);
  const isAllowed = (providerId) => !allowed.length || allowed.includes(normalizeId(providerId));
  const preferred = getProviderEntry(context, preferredProviderId);
  if (isAllowed(preferred?.id) && isProviderUsableForOperation(preferred, operationId)) {
    return preferred.id;
  }
  const provider = (context.connectedProviders || []).find((entry) => isAllowed(entry.id) && isProviderUsableForOperation(entry, operationId));
  return provider?.id || '';
}

function wizardModelSupportsOperation(wizardTarget, operationId) {
  if (wizardTarget.mode === 'ollama') {
    return operationId === PIPELINE_OPERATION_IDS.LLM_PROMPT;
  }
  if (!wizardTarget.providerId || !wizardTarget.model) {
    return false;
  }
  return Boolean(getProviderModelCapabilities(wizardTarget.providerId, wizardTarget.model)?.operations?.[operationId]);
}

function chooseTargetForOperation(operationId, context, wizardTarget = {}, options = {}) {
  const normalizedWizardTarget = normalizeWizardTarget(wizardTarget);
  const preferredProviderId = normalizeProviderPreference(options.providerPreference || normalizedWizardTarget.providerId);
  const allowedProviderIds = Array.isArray(options.allowedProviderIds) ? options.allowedProviderIds.map(normalizeId).filter(Boolean) : [];
  if (operationId === PIPELINE_OPERATION_IDS.LLM_PROMPT) {
    if (normalizedWizardTarget.mode === 'ollama') {
      return {
        executionMode: 'ollama',
        model: normalizedWizardTarget.model,
        providerId: '',
        toolId: '',
      };
    }
    return {
      executionMode: 'cloud',
      model: normalizedWizardTarget.model,
      providerId: normalizedWizardTarget.providerId,
      toolId: '',
    };
  }

  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE && !options.preferCloud) {
    const localToolId = getPreferredToolId(operationId, context, IMAGE_WORKFLOW_TOOL_IDS);
    if (localToolId) {
      return {
        executionMode: 'localTool',
        model: '',
        providerId: '',
        toolId: localToolId,
      };
    }
  }

  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
    const preferredToolIds = Array.isArray(options.preferredToolIds) && options.preferredToolIds.length
      ? options.preferredToolIds.map(normalizeId).filter(Boolean)
      : IMAGE_TRANSFORM_TOOL_IDS.filter((toolId) => toolId !== 'facefusion');
    const localToolId = getPreferredToolId(operationId, context, preferredToolIds)
      || getPreferredToolId(operationId, context, IMAGE_TRANSFORM_TOOL_IDS);
    if (localToolId) {
      return {
        executionMode: 'localTool',
        model: '',
        providerId: '',
        toolId: localToolId,
      };
    }
  }

  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
    const audioCandidates = Array.isArray(options.preferredToolIds) && options.preferredToolIds.length ? options.preferredToolIds : AUDIO_WORKFLOW_TOOL_IDS;
    const localToolId = getPreferredToolId(operationId, context, audioCandidates);
    if (localToolId && !options.preferCloud) {
      return {
        executionMode: 'localTool',
        model: '',
        providerId: '',
        toolId: localToolId,
      };
    }
  }

  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
    const localToolId = getPreferredToolId(operationId, context, AUDIO_TRANSFORM_TOOL_IDS);
    if (localToolId) {
      return {
        executionMode: 'localTool',
        model: '',
        providerId: '',
        toolId: localToolId,
      };
    }
  }

  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
    const localToolId = getPreferredToolId(operationId, context, VIDEO_WORKFLOW_TOOL_IDS);
    if (localToolId && !options.preferCloud) {
      return {
        executionMode: 'localTool',
        model: '',
        providerId: '',
        toolId: localToolId,
      };
    }
  }

  const providerId = getPreferredProviderId(operationId, context, preferredProviderId || normalizedWizardTarget.providerId, allowedProviderIds);
  if (providerId) {
    return {
      executionMode: 'cloud',
      model: providerId === normalizedWizardTarget.providerId || wizardModelSupportsOperation(normalizedWizardTarget, operationId) ? normalizedWizardTarget.model : '',
      providerId,
      toolId: '',
    };
  }

  return {
    executionMode: 'cloud',
    model: '',
    providerId: '',
    toolId: '',
  };
}

function positionFor(index) {
  return {
    x: 96 + index * 300,
    y: 132 + (index % 2) * 42,
  };
}

function makeNode(type, index, config = {}, label = '') {
  return createNode(type, {
    ...(label ? { label } : {}),
    config,
    position: positionFor(index),
  });
}

function makeOutputNode(kind, index, title) {
  const nodeType = OUTPUT_NODE_BY_KIND[kind] || 'textOutput';
  return makeNode(nodeType, index, {
    title: title || (kind.charAt(0).toUpperCase() + kind.slice(1) + ' result'),
  });
}

function connect(edges, sourceNode, sourcePortId, targetNode, targetPortId) {
  edges.push(createEdge(sourceNode.id, sourcePortId, targetNode.id, targetPortId));
}

function buildLlmStepConfig(operationId, target, intent, extraConfig = {}) {
  return {
    executionMode: target.executionMode === 'ollama' ? 'ollama' : (target.executionMode === 'localTool' || target.executionMode === 'localTool') ? 'localTool' : 'cloud',
    operationId,
    providerId: target.executionMode === 'cloud' ? target.providerId : '',
    toolId: target.executionMode === 'localTool' || target.executionMode === 'localTool' ? target.toolId : '',
    model: target.model || '',
    ...extraConfig,
    instruction: sanitizeRuntimeInstruction(extraConfig.instruction, intent, operationId),
  };
}

function getStageProviderPreference(stage = {}, plan = {}) {
  return normalizeProviderPreference(stage.providerPreference || plan?.requestObligations?.providerPreference || '');
}

function getProviderRestrictionWarning(requestedProviderId, target, operationId) {
  const requested = normalizeProviderPreference(requestedProviderId);
  if (!requested || target?.providerId === requested) return '';
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE && !WIZARD_CLOUD_VIDEO_PROVIDER_IDS.includes(requested)) {
    return 'OpenAI/Sora video is not available in this wizard pass. Choose Google or xAI for cloud video generation, or install Wan2.1 WebUI for local video.';
  }
  return 'The requested provider does not support this media operation in the wizard capability map, so Local AI Hub chose the closest supported editable target.';
}

function inferImageMappingId(inputKind, stage = {}) {
  const explicit = normalizeWizardCollectionMappingMode(stage.mappingMode);
  if (explicit === 'cloudImageToImage' || explicit === 'textToImage') return explicit;
  return inputKind === 'collection:image' ? 'cloudImageToImage' : 'textToImage';
}

function inferVideoMappingId(inputKind, stage = {}) {
  const explicit = normalizeWizardCollectionMappingMode(stage.mappingMode);
  if (explicit === 'cloudImageToVideo' || explicit === 'textToVideo') return explicit;
  return inputKind === 'collection:image' ? 'cloudImageToVideo' : 'textToVideo';
}

function isReferenceVoiceStage(stage = {}, plan = {}) {
  return normalizeWizardOperationSubtype(stage.operationSubtype) === 'referenceVoiceTts'
    || plan?.requestObligations?.wantsReferenceVoiceTts === true;
}

function findReferenceAudioArtifact(stage = {}, artifactMap = {}, inputArtifact = null) {
  const explicit = normalizeArtifactRef(stage.referenceAudio);
  if (explicit && artifactMap.get(explicit)?.kind === 'audio') return artifactMap.get(explicit);
  const inputNames = Array.isArray(stage.inputs) ? stage.inputs : [];
  for (const inputName of inputNames) {
    const artifact = artifactMap.get(inputName);
    if (artifact && artifact !== inputArtifact && artifact.kind === 'audio') return artifact;
  }
  for (const artifact of artifactMap.values()) {
    if (artifact?.kind === 'audio' && /reference|voice/i.test(String(artifact.name || artifact.label || ''))) return artifact;
  }
  return null;
}

function buildWizardCollectionMapPerItemValidationConfig(options = {}, outputKind = 'image') {
  const normalized = normalizeWizardCollectionValidationOptions(options);
  if (!normalized.enabled || normalized.scope !== 'perItem') {
    return null;
  }
  return {
    enabled: true,
    mode: 'user',
    llmExecutionMode: 'cloud',
    providerId: '',
    model: '',
    ruleset: normalized.ruleset || 'Pass each mapped ' + outputKind + ' item only when it matches its source item and is usable for the next pipeline stage.',
    systemPrompt: '',
    maxAttempts: normalized.maxAttempts || 2,
    retryInstruction: normalized.retryInstruction || 'Regenerate only the failed item and preserve the accepted items in collection order.',
    failMode: normalized.failMode || 'fail-fast',
  };
}
function makeCollectionMapOperationNode(index, operationId, inputKind, context, wizardTarget, intent, options = {}) {
  const outputKind = operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
    ? 'video'
    : operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
      ? 'audio'
      : 'image';
  const mappingId = options.mappingId || (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
    ? (inputKind === 'collection:image' ? 'cloudImageToVideo' : 'textToVideo')
    : operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
      ? 'textToAudio'
      : (inputKind === 'collection:image' ? 'cloudImageToImage' : 'textToImage'));
  const preferCloud = options.preferCloud === true || ['cloudImageToImage', 'cloudImageToVideo'].includes(mappingId);
  const target = options.target || chooseTargetForOperation(operationId, context, wizardTarget, {
    allowedProviderIds: options.allowedProviderIds || [],
    preferredToolIds: options.preferredToolIds || [],
    providerPreference: options.providerPreference || '',
    preferCloud,
  });
  const perItemValidation = buildWizardCollectionMapPerItemValidationConfig(options.perItemValidation, outputKind);
  const config = buildLlmStepConfig(operationId, target, intent, {
    mappingId,
    instruction: options.instruction || getDefaultInstructionForOperation(operationId),
    ...(options.config || {}),
    ...(perItemValidation ? { perItemValidation, failureMode: perItemValidation.failMode } : {}),
  });
  if (target.executionMode === 'localTool') {
    config.providerId = '';
    config.model = '';
  }
  const warnings = [];
  const providerWarning = getProviderRestrictionWarning(options.providerPreference, target, operationId);
  if (providerWarning) warnings.push(providerWarning);
  if (!target.providerId && !target.toolId) {
    warnings.push(operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
      ? 'Choose Google or xAI for cloud video collection mapping, or install Wan2.1 WebUI for local video mapping before this draft can run.'
      : operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
        ? 'Install Chatterbox-Turbo TTS before this reference voice collection map can run.'
        : 'Choose OpenAI, Google, or xAI for cloud image collection mapping, or install a local image generator before this draft can run.');
  }
  return {
    node: makeNode('collectionMap', index, config, options.label || 'Map collection'),
    outputPortId: 'collection',
    target,
    warnings,
  };
}

function buildSimpleModelPipeline({ intent, operationId, outputKind, context, wizardTarget, plan }) {
  const nodes = [];
  const edges = [];
  const sourceKind = operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
    ? 'audio'
    : operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM || plan.recipeId === WIZARD_RECIPE_IDS.IMAGE_TO_TEXT
      ? 'image'
      : 'text';
  const inputNode = makeNode(sourceNodeTypeForKind(sourceKind), 0, sourceKind === 'text' ? { text: '' } : {}, sourceKind === 'image' ? 'Source image' : sourceKind === 'audio' ? 'Source audio' : getRuntimeSourceLabel(intent));
  nodes.push(inputNode);

  const target = chooseTargetForOperation(operationId, context, wizardTarget);
  const stepNode = makeNode('llmPrompt', 1, buildLlmStepConfig(operationId, target, intent, {
    instruction: operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
      ? 'Create the requested video draft from the connected prompt. Leave detailed settings for manual refinement.'
      : operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
        ? 'Transform the connected image according to the configured node settings. Leave detailed settings for manual refinement.'
        : getDefaultInstructionForOperation(operationId),
  }), operationId === PIPELINE_OPERATION_IDS.LLM_PROMPT ? 'Model response' : getRecipeOption(plan.recipeId)?.label || 'Model step');
  const outputNode = makeOutputNode(outputKind, 2, outputKind === 'text' ? 'Text result' : outputKind === 'audio' ? 'Audio result' : outputKind === 'video' ? 'Video result' : 'Image result');
  nodes.push(stepNode, outputNode);
  connect(edges, inputNode, sourcePortForKind(sourceKind), stepNode, 'prompt');
  connect(edges, stepNode, outputKind, outputNode, outputKind);

  return { nodes, edges, target, warnings: [] };
}

function buildTranscriptionPipeline({ context }) {
  const nodes = [];
  const edges = [];
  const inputNode = makeNode('audioInput', 0, {}, 'Source audio');
  const whisperNode = makeNode('llmPrompt', 1, buildLlmStepConfig(PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE, { executionMode: 'localTool', toolId: 'whisper', model: 'base', providerId: '' }, '', {
    instruction: 'Transcribe the connected source audio into text.',
  }), 'Transcribe audio');
  const outputNode = makeOutputNode('text', 2, 'Transcript');
  nodes.push(inputNode, whisperNode, outputNode);
  connect(edges, inputNode, 'audio', whisperNode, 'prompt');
  connect(edges, whisperNode, 'text', outputNode, 'text');
  return {
    nodes,
    edges,
    target: { executionMode: 'localTool', toolId: 'whisper', model: 'base', providerId: '' },
    warnings: getToolEntry(context, 'whisper') ? [] : ['Install Whisper before this transcription draft can run.'],
  };
}

function buildScenePlanPipeline({ intent, context, wizardTarget }) {
  const nodes = [];
  const edges = [];
  const normalizedWizardTarget = normalizeWizardTarget(wizardTarget);
  const plannerTarget = normalizedWizardTarget.mode === 'ollama'
    ? { executionMode: 'ollama', providerId: '', model: normalizedWizardTarget.model }
    : { executionMode: 'cloud', providerId: normalizedWizardTarget.providerId, model: normalizedWizardTarget.model };
  const inputNode = makeNode('textInput', 0, { text: '' }, getRuntimeSourceLabel(intent));
  const packetNode = makeNode('planningPacket', 1, buildPlanningPacketConfig({
    intent,
    context,
    title: 'Scene planning packet',
  }), 'Planning packet');
  const plannerNode = makeNode('planner', 2, {
    executionMode: plannerTarget.executionMode,
    providerId: plannerTarget.executionMode === 'cloud' ? plannerTarget.providerId : '',
    model: plannerTarget.model || '',
    schemaId: DEFAULT_PLANNING_SCHEMA_ID,
    instruction: 'Create a grounded longform scene plan. Keep uncertainties and manual refinement needs explicit.',
  }, 'Planner');
  const planOutputNode = makeNode('planOutput', 3, { title: 'Scene plan' }, 'Plan output');
  const scenesNode = makeNode('planScenes', 3, {}, 'Plan scenes');
  scenesNode.position.y += 220;
  const collectionOutputNode = makeNode('collectionOutput', 4, { title: 'Scene text collection' }, 'Scene text output');
  collectionOutputNode.position.y += 220;
  nodes.push(inputNode, packetNode, plannerNode, planOutputNode, scenesNode, collectionOutputNode);
  connect(edges, inputNode, 'text', packetNode, 'source');
  connect(edges, packetNode, 'packet', plannerNode, 'packet');
  connect(edges, plannerNode, 'plan', planOutputNode, 'plan');
  connect(edges, plannerNode, 'plan', scenesNode, 'plan');
  connect(edges, scenesNode, 'collection', collectionOutputNode, 'collection');
  return {
    nodes,
    edges,
    target: plannerTarget,
    warnings: ['This draft uses the mature longform scene-planning substrate. Detailed downstream generation remains manual.'],
  };
}

function buildValidationConfig(kind, wizardTarget, ruleset, options = {}) {
  if (options.mode === 'user') {
    return {
      mode: 'user',
      ruleset,
    };
  }

  const target = normalizeWizardTarget(wizardTarget);
  return {
    mode: 'llm',
    llmExecutionMode: target.mode === 'ollama' ? 'ollama' : 'cloud',
    providerId: target.mode === 'cloud' ? target.providerId : '',
    model: target.model,
    ruleset,
    systemPrompt: kind === 'image'
      ? 'Evaluate the image against the connected prompt and return pass or fail with a short reason.'
      : 'Evaluate the connected pipeline artifact against the rules and return pass or fail with a short reason.',
  };
}

function getPreferredImageTransformToolIds(intent, options = {}) {
  if (Array.isArray(options.preferredToolIds) && options.preferredToolIds.length) {
    return options.preferredToolIds;
  }
  return inferIntentFeatures(intent).wantsFaceFusionTransform
    ? ['facefusion', ...IMAGE_TRANSFORM_TOOL_IDS.filter((toolId) => toolId !== 'facefusion')]
    : [...IMAGE_TRANSFORM_TOOL_IDS.filter((toolId) => toolId !== 'facefusion'), 'facefusion'];
}

function getLocalOnlyOperationFallbackTarget(operationId) {
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM || operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
    return { executionMode: 'localTool', model: '', providerId: '', toolId: '' };
  }
  return null;
}

function makeOperationModelStepNode(index, operationId, outputKind, context, wizardTarget, intent, options = {}) {
  const target = chooseTargetForOperation(operationId, context, wizardTarget, options);
  const localOnlyFallback = getLocalOnlyOperationFallbackTarget(operationId);
  const effectiveTarget = (target.executionMode === 'cloud' && !target.providerId && localOnlyFallback)
    || (options.forceLocal && target.executionMode === 'cloud' ? { executionMode: 'localTool', model: '', providerId: '', toolId: '' } : null)
    || target;
  const warnings = [];
  const providerWarning = getProviderRestrictionWarning(options.providerPreference, effectiveTarget, operationId);
  if (providerWarning) warnings.push(providerWarning);
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM && !effectiveTarget.toolId) {
    warnings.push('Install RVC and choose a voice model before this audio transformation draft can run.');
  } else if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM && !effectiveTarget.toolId) {
    warnings.push('Install Upscayl or FaceFusion before this image transformation draft can run.');
  } else if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE && !effectiveTarget.toolId && !effectiveTarget.providerId) {
    warnings.push('Install Wan2.1 WebUI or choose a video-capable provider before this video generation draft can run.');
  } else if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE && !effectiveTarget.toolId && !effectiveTarget.providerId) {
    warnings.push('Install AudioCraft WebUI or choose a speech-capable provider before this audio generation draft can run.');
  }
  if (effectiveTarget.toolId) {
    const tool = getToolEntry(context, effectiveTarget.toolId);
    const suitabilityTone = normalizeTone(tool?.hardwareSuitability?.tone);
    const suitabilityMessage = normalizeString(tool?.hardwareSuitability?.message || tool?.hardwareSuitability?.label);
    if (['danger', 'error'].includes(suitabilityTone) && suitabilityMessage) {
      warnings.push((tool?.name || effectiveTarget.toolId) + ' is not a practical fit for this hardware: ' + suitabilityMessage);
    } else if (suitabilityTone === 'warn' && suitabilityMessage) {
      warnings.push((tool?.name || effectiveTarget.toolId) + ' may need reduced settings on this hardware: ' + suitabilityMessage);
    }
  }
  const label = operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
    ? 'Generate audio'
    : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
      ? 'Transform audio'
      : operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
        ? 'Generate video'
        : operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
          ? 'Transform image'
          : 'Model step';
  return {
    node: makeNode('llmPrompt', index, buildLlmStepConfig(operationId, effectiveTarget, intent, {
      instruction: options.instruction || getDefaultInstructionForOperation(operationId),
      ...(options.config || {}),
    }), label),
    outputPortId: outputKind,
    target: effectiveTarget,
    warnings,
  };
}

function makeImageGenerationNode(index, context, wizardTarget, intent, options = {}) {
  const target = chooseTargetForOperation(PIPELINE_OPERATION_IDS.IMAGE_GENERATE, context, wizardTarget, {
    allowedProviderIds: options.allowedProviderIds || [],
    providerPreference: options.providerPreference || '',
    preferCloud: options.preferCloud === true,
  });
  return {
    node: makeNode('llmPrompt', index, buildLlmStepConfig(PIPELINE_OPERATION_IDS.IMAGE_GENERATE, target, intent, {
      instruction: options.instruction || 'Generate an image from the connected approved scene prompt. Leave detailed image settings editable for manual refinement.',
    }), options.label || 'Generate image'),
    outputPortId: 'image',
    target,
    warnings: [
      ...(target.providerId || target.toolId ? [] : ['Choose OpenAI, Google, or xAI for cloud image generation, or install a local image generator before this image step can run.']),
      ...([getProviderRestrictionWarning(options.providerPreference, target, PIPELINE_OPERATION_IDS.IMAGE_GENERATE)].filter(Boolean)),
    ],
  };
}

function makeCollectionMapImageNode(index, context, wizardTarget, intent, options = {}) {
  const inputKind = options.inputKind || 'collection:text';
  return makeCollectionMapOperationNode(index, PIPELINE_OPERATION_IDS.IMAGE_GENERATE, inputKind, context, wizardTarget, intent, {
    allowedProviderIds: options.allowedProviderIds || [],
    config: options.config || {},
    instruction: options.instruction || 'Generate one image for each collection item while preserving the source order. Leave detailed image settings editable for manual refinement.',
    label: options.label || 'Generate images for collection',
    mappingId: inferImageMappingId(inputKind, options.stage || {}),
    providerPreference: options.providerPreference || '',
    preferCloud: options.preferCloud === true,
  });
}
function buildStoryboardVideoScaffoldPipeline({ intent, context, wizardTarget }) {
  const nodes = [];
  const edges = [];
  const normalizedWizardTarget = normalizeWizardTarget(wizardTarget);
  const plannerTarget = normalizedWizardTarget.mode === 'ollama'
    ? { executionMode: 'ollama', providerId: '', model: normalizedWizardTarget.model }
    : { executionMode: 'cloud', providerId: normalizedWizardTarget.providerId, model: normalizedWizardTarget.model };
  const add = (node) => {
    nodes.push(node);
    return node;
  };

  const sourceNode = add(makeNode('textInput', 0, { text: '' }, getRuntimeSourceLabel(intent)));
  const packetNode = add(makeNode('planningPacket', 1, buildPlanningPacketConfig({
    intent,
    context,
    title: 'Voiceover-to-video planning packet',
  }), 'Planning packet'));
  const plannerNode = add(makeNode('planner', 2, {
    executionMode: plannerTarget.executionMode,
    providerId: plannerTarget.executionMode === 'cloud' ? plannerTarget.providerId : '',
    model: plannerTarget.model || '',
    schemaId: DEFAULT_PLANNING_SCHEMA_ID,
    instruction: 'Create an ordered scene plan from the connected runtime script. Include visual intent, scene beats, and prompt-ready details for each scene.',
  }, 'Generate scene plan'));
  const planValidationNode = add(makeNode('validation', 3, buildValidationConfig('plan', wizardTarget, 'Pass only if the plan has ordered scenes, clear visual intent, and enough detail to derive image prompts. Fail if scenes are missing, vague, or inconsistent with the runtime script.'), 'Validate plan'));
  const planLoopNode = add(makeNode('retryLoop', 4, {
    retryTargetNodeId: plannerNode.id,
    maxAttempts: 3,
    retryTerminationAction: 'fail',
  }, 'Retry plan until valid'));
  const planOutputNode = add(makeNode('planOutput', 5, { title: 'Approved scene plan' }, 'Approved plan'));
  planOutputNode.position.y -= 160;
  const scenesNode = add(makeNode('planScenes', 5, {}, 'Scene prompts'));
  scenesNode.position.y += 120;
  const promptValidationNode = add(makeNode('validation', 6, buildValidationConfig('prompt', wizardTarget, 'Pass only if the scene prompt collection is concrete, visual, ordered, and usable for image generation. Fail if prompts are too vague or miss required scene details.'), 'Validate prompt collection'));
  promptValidationNode.position.y += 120;
  const promptLoopNode = add(makeNode('retryLoop', 7, {
    retryTargetNodeId: scenesNode.id,
    maxAttempts: 3,
    retryTerminationAction: 'fail',
  }, 'Retry prompts until valid'));
  promptLoopNode.position.y += 120;
  const promptOutputNode = add(makeNode('collectionOutput', 8, { title: 'Approved scene prompts' }, 'Approved prompts'));
  promptOutputNode.position.y += 20;

  const imageMapStep = makeCollectionMapImageNode(8, context, wizardTarget, intent);
  const imageMapNode = add(imageMapStep.node);
  imageMapNode.position.y += 320;
  const imageValidationNode = add(makeNode('validation', 9, buildValidationConfig('image collection', wizardTarget, 'Pass only if the generated image collection is ordered, complete, visually usable, and suitable for the final video. Fail if the collection is incomplete, mismatched, or unusable.', { mode: 'user' }), 'Validate image collection'));
  imageValidationNode.position.y += 320;
  const imageLoopNode = add(makeNode('retryLoop', 10, {
    retryTargetNodeId: imageMapNode.id,
    maxAttempts: 3,
    retryTerminationAction: 'fail',
    stopWhenRetryArtifactRepeats: true,
  }, 'Regenerate image collection until approved'));
  imageLoopNode.position.y += 320;
  const compositionNode = add(makeNode('mediaComposition', 11, { secondsPerItem: 4 }, 'Sequence approved images'));
  compositionNode.position.y += 320;
  const exportNode = add(makeNode('mediaExport', 12, { title: 'Storyboard video' }, 'Export video'));
  exportNode.position.y += 320;
  const videoOutputNode = add(makeNode('videoOutput', 13, { title: 'Storyboard video' }, 'Video output'));
  videoOutputNode.position.y += 320;

  connect(edges, sourceNode, 'text', packetNode, 'source');
  connect(edges, packetNode, 'packet', plannerNode, 'packet');
  connect(edges, plannerNode, 'plan', planValidationNode, 'input');
  connect(edges, planValidationNode, 'pass', planLoopNode, 'complete');
  connect(edges, planValidationNode, 'fail', planLoopNode, 'retry');
  connect(edges, planLoopNode, 'result', planOutputNode, 'plan');
  connect(edges, planLoopNode, 'result', scenesNode, 'plan');
  connect(edges, scenesNode, 'collection', promptValidationNode, 'input');
  connect(edges, promptValidationNode, 'pass', promptLoopNode, 'complete');
  connect(edges, promptValidationNode, 'fail', promptLoopNode, 'retry');
  connect(edges, promptLoopNode, 'result', promptOutputNode, 'collection');
  connect(edges, promptLoopNode, 'result', imageMapNode, 'collection');
  connect(edges, imageMapNode, imageMapStep.outputPortId, imageValidationNode, 'input');
  connect(edges, imageValidationNode, 'pass', imageLoopNode, 'complete');
  connect(edges, imageValidationNode, 'fail', imageLoopNode, 'retry');
  connect(edges, imageLoopNode, 'result', compositionNode, 'visuals');
  connect(edges, compositionNode, 'composition', exportNode, 'composition');
  connect(edges, exportNode, 'video', videoOutputNode, 'video');

  return {
    nodes,
    edges,
    target: plannerTarget,
    operationTargets: [
      { nodeLabel: plannerNode.label, operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT, target: plannerTarget },
      { nodeLabel: imageMapNode.label, operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE, target: imageMapStep.target },
    ],
    scaffold: 'validated-storyboard-video',
    warnings: [
      ...imageMapStep.warnings,
      'Image validation reviews the generated collection as a whole in this pass. Per-item approval can be added later when item-wise validation has a real execution bridge.',
    ],
  };
}

function resultCoversStoryboardVideoDepth(result) {
  const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
  const typeCounts = nodes.reduce((accumulator, node) => {
    accumulator[node.type] = Number(accumulator[node.type] || 0) + 1;
    return accumulator;
  }, {});
  const hasImageGeneration = nodes.some((node) => node.type === 'collectionMap' || (node.type === 'llmPrompt' && node.config?.operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE));
  return Number(typeCounts.validation || 0) >= 2
    && Number(typeCounts.retryLoop || 0) >= 2
    && hasImageGeneration
    && Number(typeCounts.mediaComposition || 0) >= 1
    && Number(typeCounts.mediaExport || 0) >= 1;
}

function isPlanningOnlyStoryboardCandidate(result) {
  const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
  if (!nodes.length) {
    return true;
  }

  const planningOnlyTypes = new Set(['textInput', 'planningPacket', 'planner', 'planOutput', 'planScenes', 'collectionOutput']);
  const hasComposableDownstreamWork = nodes.some((node) => {
    if (['validation', 'retryLoop', 'imageGenerate', 'graphWorkflow', 'collectionAccumulator', 'mediaComposition', 'mediaExport'].includes(node.type)) {
      return true;
    }
    return node.type === 'llmPrompt' && normalizeOperationId(node.config?.operationId, PIPELINE_OPERATION_IDS.LLM_PROMPT) !== PIPELINE_OPERATION_IDS.LLM_PROMPT;
  });

  return !hasComposableDownstreamWork && nodes.every((node) => planningOnlyTypes.has(node.type));
}

function isGenericTextResponseCandidate(result) {
  const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
  if (!nodes.length || nodes.length > 3) {
    return false;
  }
  const typeList = nodes.map((node) => node.type).join('>');
  return typeList === 'textInput>llmPrompt>textOutput'
    && !nodes.some((node) => normalizeOperationId(node.config?.operationId, PIPELINE_OPERATION_IDS.LLM_PROMPT) !== PIPELINE_OPERATION_IDS.LLM_PROMPT);
}

function buildImageDescriptionValidationPipeline({ intent, context, wizardTarget }) {
  const nodes = [];
  const edges = [];
  const target = chooseTargetForOperation(PIPELINE_OPERATION_IDS.LLM_PROMPT, context, wizardTarget);
  const sourceNode = makeNode('imageInput', 0, {}, 'Source image');
  const descriptionNode = makeNode('llmPrompt', 1, buildLlmStepConfig(PIPELINE_OPERATION_IDS.LLM_PROMPT, target, intent, {
    instruction: 'Describe the connected runtime image in clear, specific text. Leave exact description style editable for manual refinement.',
  }), 'Describe image');
  const validationNode = makeNode('validation', 2, buildValidationConfig('artifact', wizardTarget, 'Pass only if the image description is specific, accurate, and useful for the next pipeline stage. Fail if it is vague, empty, or does not describe the image.'), 'Validate description');
  const retryNode = makeNode('retryLoop', 3, {
    retryTargetNodeId: descriptionNode.id,
    maxAttempts: 3,
    retryTerminationAction: 'fail',
  }, 'Retry description until valid');
  const outputNode = makeOutputNode('text', 4, 'Approved description');
  nodes.push(sourceNode, descriptionNode, validationNode, retryNode, outputNode);
  connect(edges, sourceNode, 'image', descriptionNode, 'prompt');
  connect(edges, descriptionNode, 'text', validationNode, 'input');
  connect(edges, validationNode, 'pass', retryNode, 'complete');
  connect(edges, validationNode, 'fail', retryNode, 'retry');
  connect(edges, retryNode, 'result', outputNode, 'text');
  return {
    nodes,
    edges,
    target,
    harness: 'image-description-validation',
    operationTargets: [
      { nodeLabel: descriptionNode.label, operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT, target },
    ],
    warnings: [
      'This draft preserves the requested image-description validation/retry structure. The selected runtime model must be able to read image inputs, or you should switch the model step to a vision-capable provider/model before running.',
    ],
  };
}

function buildHarnessPipelineForIntent({ intent, context, wizardTarget, candidateResult }) {
  if (candidateResult?.intentIr) {
    return null;
  }
  const features = inferIntentFeatures(intent);
  if (features.wantsImageInput && features.wantsDescription && features.wantsValidation && features.wantsRetry && isGenericTextResponseCandidate(candidateResult)) {
    return buildImageDescriptionValidationPipeline({ intent, context, wizardTarget });
  }

  if (!shouldUseStoryboardVideoScaffold(intent)) {
    return null;
  }
  if (resultCoversStoryboardVideoDepth(candidateResult)) {
    return null;
  }
  if (!isPlanningOnlyStoryboardCandidate(candidateResult) && !isGenericTextResponseCandidate(candidateResult)) {
    return null;
  }
  return buildStoryboardVideoScaffoldPipeline({ intent, context, wizardTarget });
}
function normalizeOperationId(value, fallback = PIPELINE_OPERATION_IDS.LLM_PROMPT) {
  return Object.values(PIPELINE_OPERATION_IDS).includes(value) ? value : fallback;
}

function getConfiguredOperationForNode(type, config = {}) {
  if (type === 'imageGenerate') {
    return PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
  }
  if (type === 'imageAnalyze') {
    return PIPELINE_OPERATION_IDS.IMAGE_ANALYZE;
  }
  if (type === 'whisperTranscribe') {
    return PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE;
  }
  if (type === 'planner') {
    return PIPELINE_OPERATION_IDS.LLM_PROMPT;
  }
  if (type === 'graphWorkflow') {
    return PIPELINE_OPERATION_IDS.GRAPH_WORKFLOW;
  }
  if (type === 'llmPrompt') {
    return normalizeOperationId(config.operationId, PIPELINE_OPERATION_IDS.LLM_PROMPT);
  }
  return '';
}

function buildFlexibleNodeConfig(type, proposedNode, intent, context, wizardTarget) {
  const rawConfig = proposedNode?.config && typeof proposedNode.config === 'object' ? cloneValue(proposedNode.config) : {};
  const requestedConfig = sanitizeRuntimeConfigObject(rawConfig, intent);
  if (type === 'textInput') {
    return {
      ...requestedConfig,
      text: sanitizeRuntimeTextDefault(requestedConfig.text, intent),
    };
  }

  if (type === 'planningPacket') {
    return buildPlanningPacketConfig({ intent, context, requestedConfig });
  }

  if (type === 'planner') {
    const target = normalizeWizardTarget(wizardTarget);
    return {
      ...requestedConfig,
      executionMode: target.mode === 'ollama' ? 'ollama' : 'cloud',
      providerId: target.mode === 'cloud' ? target.providerId : '',
      model: target.model,
      schemaId: DEFAULT_PLANNING_SCHEMA_ID,
      instruction: normalizeString(
        sanitizeRuntimeTextDefault(requestedConfig.instruction || proposedNode?.purpose, intent),
        'Create a grounded structured plan from the connected Planning Packet and keep manual refinement needs explicit.'
      ),
    };
  }

  if (type === 'llmPrompt') {
    const operationId = normalizeOperationId(requestedConfig.operationId || proposedNode?.operationId, PIPELINE_OPERATION_IDS.LLM_PROMPT);
    const target = chooseTargetForOperation(operationId, context, wizardTarget);
    return buildLlmStepConfig(operationId, target, intent, {
      ...requestedConfig,
      instruction: sanitizeRuntimeInstruction(requestedConfig.instruction || proposedNode?.purpose, intent, operationId),
    });
  }

  if (type === 'imageGenerate') {
    const selectedToolId = normalizeId(requestedConfig.toolId);
    const toolId = selectedToolId && getToolEntry(context, selectedToolId) && getToolPipelineOperation(selectedToolId, PIPELINE_OPERATION_IDS.IMAGE_GENERATE)
      ? selectedToolId
      : getPreferredToolId(PIPELINE_OPERATION_IDS.IMAGE_GENERATE, context, IMAGE_WORKFLOW_TOOL_IDS);
    return {
      ...requestedConfig,
      toolId,
    };
  }

  if (type === 'graphWorkflow') {
    const selectedToolId = normalizeId(requestedConfig.toolId);
    const toolId = selectedToolId && GRAPH_WORKFLOW_TOOL_IDS.includes(selectedToolId)
      ? selectedToolId
      : getPreferredToolId(PIPELINE_OPERATION_IDS.GRAPH_WORKFLOW, context, GRAPH_WORKFLOW_TOOL_IDS) || GRAPH_WORKFLOW_TOOL_IDS[0] || '';
    return {
      ...requestedConfig,
      toolId,
    };
  }

  if (type === 'validation') {
    const mode = requestedConfig.mode === 'llm' ? 'llm' : 'user';
    const baseConfig = {
      ...requestedConfig,
      mode,
      ruleset: normalizeString(requestedConfig.ruleset, getDefaultValidationRuleset()),
      systemPrompt: mode === 'llm'
        ? normalizeString(requestedConfig.systemPrompt, 'Evaluate the connected runtime artifact against the rules and return pass or fail with a short reason.')
        : '',
    };
    if (mode !== 'llm') {
      return baseConfig;
    }
    const target = normalizeWizardTarget(wizardTarget);
    return {
      ...baseConfig,
      llmExecutionMode: target.mode === 'ollama' ? 'ollama' : 'cloud',
      providerId: target.mode === 'cloud' ? target.providerId : '',
      model: target.model,
    };
  }

  if (type.endsWith('Output') || type === 'collectionOutput' || type === 'planOutput') {
    const fallbackTitle = sanitizeRuntimeLabel(proposedNode?.label, intent, getNodeTypeDefinition(type)?.label || 'Wizard result');
    return {
      ...requestedConfig,
      title: sanitizeRuntimeLabel(requestedConfig.title, intent, fallbackTitle),
    };
  }

  return requestedConfig;
}

function createFlexibleNodes(plan, intent, context, wizardTarget) {
  const graphNodes = plan?.draftGraph?.nodes || [];
  return graphNodes.map((proposedNode, index) => createNode(proposedNode.type, {
    id: proposedNode.id,
    label: sanitizeRuntimeLabel(proposedNode.label, intent, getNodeTypeDefinition(proposedNode.type)?.label),
    position: positionFor(index),
    config: buildFlexibleNodeConfig(proposedNode.type, proposedNode, intent, context, wizardTarget),
  }));
}

function isInvalidFlexibleEdgeError(message) {
  return /invalid connection|cannot connect|already has a connection|already connected|cycle|does not exist|can only merge branches/i.test(String(message || ''));
}

function createValidatedFlexibleEdges(nodes, proposedEdges = []) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const retainedEdges = [];
  const skipped = [];

  for (const edge of proposedEdges) {
    const sourceNode = nodeMap.get(edge.sourceNodeId);
    const targetNode = nodeMap.get(edge.targetNodeId);
    const sourcePort = sourceNode ? getNodeTypeDefinition(sourceNode.type)?.outputPorts?.find((port) => port.id === edge.sourcePortId) : null;
    const targetPort = targetNode ? getNodeTypeDefinition(targetNode.type)?.inputPorts?.find((port) => port.id === edge.targetPortId) : null;
    if (!sourceNode || !targetNode || !sourcePort || !targetPort) {
      skipped.push('Skipped a wizard connection because it referenced a node or port Local AI Hub does not expose.');
      continue;
    }

    const candidate = createEdge(sourceNode.id, sourcePort.id, targetNode.id, targetPort.id);
    const candidateGraph = buildPipelineGraph(createEmptyPipeline({ nodes, edges: [...retainedEdges, candidate] }));
    const invalidError = candidateGraph.errors.find(isInvalidFlexibleEdgeError);
    if (invalidError) {
      skipped.push(invalidError);
      continue;
    }

    retainedEdges.push(candidate);
  }

  return {
    edges: retainedEdges,
    skipped,
  };
}

function appendOutputForLastResult(nodes, edges) {
  if (nodes.some((node) => getNodeTypeDefinition(node.type)?.terminal || getNodeTypeDefinition(node.type)?.persistsOutput)) {
    return { nodes, edges };
  }

  const node = [...nodes].reverse().find((entry) => (getNodeTypeDefinition(entry.type)?.outputPorts || []).length);
  const outputPort = (getNodeTypeDefinition(node?.type)?.outputPorts || []).find((port) => OUTPUT_NODE_BY_KIND[port.kind]);
  if (!node || !outputPort) {
    return { nodes, edges };
  }

  const outputNode = makeOutputNode(outputPort.kind, nodes.length, 'Wizard result');
  return {
    nodes: [...nodes, outputNode],
    edges: [...edges, createEdge(node.id, outputPort.id, outputNode.id, outputPort.kind)],
  };
}


function getPrimaryStageInput(stage, artifactMap) {
  const inputNames = Array.isArray(stage?.inputs) && stage.inputs.length ? stage.inputs : stage?.input ? [stage.input] : [];
  for (const inputName of inputNames) {
    const artifact = artifactMap.get(inputName);
    if (artifact) return artifact;
  }
  return null;
}

function getStageOutputName(stage, fallback) {
  return normalizeArtifactRef(stage?.output || stage?.outputs?.[0], fallback);
}

function registerArtifact(artifactMap, name, value) {
  const artifactName = normalizeArtifactRef(name);
  if (!artifactName || !value) return null;
  const entry = { ...value, name: artifactName };
  artifactMap.set(artifactName, entry);
  return entry;
}

function inferOutputKindFromArtifact(artifact, requestedKind = '') {
  const artifactKind = artifact?.kind || '';
  if (String(artifactKind).startsWith('collection:') && !String(requestedKind || '').startsWith('collection:')) return artifactKind;
  return requestedKind || artifactKind || 'text';
}

function getIntentCollectionItemKind(kind) {
  const normalizedKind = normalizeIntentKind(kind, '');
  return String(normalizedKind || '').startsWith('collection:') ? normalizedKind.slice('collection:'.length) : '';
}

function sourcePortForKind(kind) {
  if (String(kind || '').startsWith('collection:')) return 'collection';
  if (kind === 'image') return 'image';
  if (kind === 'audio') return 'audio';
  if (kind === 'video') return 'video';
  if (kind === 'file') return 'file';
  return 'text';
}

function sourceNodeTypeForKind(kind) {
  if (String(kind || '').startsWith('collection:')) return 'collectionInput';
  if (kind === 'image') return 'imageInput';
  if (kind === 'audio') return 'audioInput';
  if (kind === 'video') return 'videoInput';
  if (kind === 'file') return 'fileInput';
  return 'textInput';
}

function sourceNodeConfigForKind(kind) {
  const itemType = getIntentCollectionItemKind(kind);
  if (itemType) return { itemType, items: [] };
  return kind === 'text' ? { text: '' } : {};
}

function getWizardAssetLibraryEntries(context = {}, type = '') {
  const entries = context?.assetLibraries?.[type];
  return Array.isArray(entries) ? entries : [];
}

function normalizeWizardAssetRef(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getWizardAssetLibraryItems(library = {}) {
  const itemGroups = [library.items, library.assets, library.sounds, library.fonts, library.colors];
  return itemGroups.flatMap((items) => (Array.isArray(items) ? items : [])).filter(Boolean);
}

function getWizardAssetItemId(library = {}, index = 0) {
  const items = getWizardAssetLibraryItems(library);
  const item = items[Math.max(0, Math.min(items.length - 1, index))] || items[0] || null;
  return normalizeId(item?.id || item?.assetId || item?.fileId || item?.name || item?.displayName);
}

function findWizardAssetLibrary(context = {}, type = '', ref = '') {
  const normalizedRef = normalizeWizardAssetRef(ref);
  if (!normalizedRef) return null;
  const libraries = getWizardAssetLibraryEntries(context, type);
  return libraries.find((library) => normalizeWizardAssetRef(library?.id) === normalizedRef)
    || libraries.find((library) => normalizeWizardAssetRef(library?.name || library?.displayName) === normalizedRef)
    || libraries.find((library) => {
      const libraryText = normalizeWizardAssetRef([library?.id, library?.name, library?.displayName].filter(Boolean).join(' '));
      return libraryText && (libraryText.includes(normalizedRef) || normalizedRef.includes(libraryText));
    })
    || null;
}

function resolveWizardAssetLibraryRefs(context = {}, type = '', refs = [], warnings = [], label = 'asset') {
  const libraries = [];
  const seen = new Set();
  for (const ref of normalizeWizardStringList(refs)) {
    const library = findWizardAssetLibrary(context, type, ref);
    if (!library) {
      warnings.push('Could not resolve ' + label + ' library "' + ref + '". Choose an existing ' + label + ' library before running this wizard draft.');
      continue;
    }
    const libraryId = normalizeId(library.id || library.name || library.displayName);
    if (libraryId && !seen.has(libraryId)) {
      seen.add(libraryId);
      libraries.push({ ...library, id: libraryId });
    }
  }
  return libraries;
}

function buildWizardMediaCompositionConfig(stage = {}, context = {}, warnings = []) {
  const options = normalizeWizardMediaCompositionOptions(stage.mediaComposition || {});
  const secondsPerItem = normalizeWizardSeconds(options.fallbackSecondsPerImage || options.fixedSecondsPerImage, 4, { min: 0.25, max: 60 });
  const config = {
    imageTimingMode: options.timingMode || 'fixedDurationPerImage',
    secondsPerItem,
    sceneTransitionMode: 'off',
    sceneTransitionDurationSeconds: 0.5,
    sceneTransitionCategory: options.transitionCategory || 'fades',
    sceneTransitionName: 'fade',
    sceneTransitionSelected: ['fade', 'dissolve'],
    sceneTransitionAvoidRepeats: true,
    narrationVolume: options.narrationVolume == null ? 1 : options.narrationVolume,
    backgroundMusicVolume: options.backgroundMusicVolume == null ? 0.22 : options.backgroundMusicVolume,
    soundEffectsEnabled: false,
    soundEffectsLibraryId: '',
    soundEffectsSchedulingMode: 'randomInterval',
    soundEffectsVolume: options.soundEffectsVolume == null ? 0.35 : options.soundEffectsVolume,
    soundEffectsDensity: 'normal',
    soundEffectsMinSpacingSeconds: 4,
    soundEffectsMaxSimultaneous: 2,
    soundEffectsAvoidRepeats: true,
    soundEffectsFadeSeconds: 0.05,
    soundEffectsSeed: '',
    soundEffectsLayers: [],
  };

  if (options.timingMode === 'dynamicFromImageMetadata') {
    config.imageTimingMode = 'dynamicFromImageMetadata';
  }
  if (options.transitionsEnabled) {
    config.sceneTransitionMode = options.transitionMode && options.transitionMode !== 'off' ? options.transitionMode : 'randomCategory';
  }
  if (options.soundEffectsEnabled) {
    const libraries = resolveWizardAssetLibraryRefs(context, 'soundEffects', options.soundEffectLibraryRefs, warnings, 'Sound Effects');
    config.soundEffectsEnabled = true;
    if (libraries.length) {
      config.soundEffectsLibraryId = normalizeId(libraries[0].id);
      config.soundEffectsLayers = libraries.map((library, index) => ({
        id: 'wizard-sfx-layer-' + String(index + 1),
        name: normalizeString(library.name || library.displayName || library.id, 'SFX layer ' + String(index + 1)),
        libraryId: normalizeId(library.id),
        schedulingMode: 'randomInterval',
        volume: config.soundEffectsVolume,
        density: 'normal',
        minSpacingSeconds: 4,
        maxSimultaneous: 2,
        avoidRepeats: true,
        fadeSeconds: 0.05,
        seed: '',
      }));
    } else {
      warnings.push(options.soundEffectLibraryRefs.length
        ? 'Sound effects were requested, but no requested Sound Effects library could be resolved.'
        : 'Sound effects were requested. Choose an existing Sound Effects asset library before running this wizard draft.');
    }
  }
  return config;
}

function buildWizardBurnSubtitlesConfig(stage = {}, context = {}, warnings = []) {
  const options = normalizeWizardBurnSubtitlesOptions(stage.burnSubtitles || {});
  const styleIntent = normalizeString(options.styleIntent).toLowerCase();
  const config = {
    captionMode: 'auto',
    durationPerCaptionSeconds: 3,
    fontSize: /\blarge\b/.test(styleIntent) ? 36 : 28,
    outline: 2,
    shadow: 1,
    bottomMargin: 32,
    textColor: 'white',
    outlineColor: 'black',
    backgroundColor: 'black',
    fontPreset: 'arial',
    fontSource: 'preset',
    fontLibraryId: '',
    fontItemId: '',
    colorSource: 'manual',
    colorPaletteLibraryId: '',
    textColorPaletteItemId: '',
    outlineColorPaletteItemId: '',
    backgroundColorPaletteItemId: '',
    bold: /\bbold\b/.test(styleIntent),
    italic: /\bitalic\b/.test(styleIntent),
    position: options.position || 'bottomCenter',
    backgroundBox: /\b(box|background|horror|spooky|halloween)\b/.test(styleIntent),
    backgroundOpacity: /\b(box|background|horror|spooky|halloween)\b/.test(styleIntent) ? 45 : 50,
    outputFormat: 'mp4',
  };

  if (options.fontLibraryRef) {
    const fontLibrary = findWizardAssetLibrary(context, 'fonts', options.fontLibraryRef);
    config.fontSource = 'assetLibrary';
    if (fontLibrary) {
      config.fontLibraryId = normalizeId(fontLibrary.id || fontLibrary.name || fontLibrary.displayName);
      config.fontItemId = getWizardAssetItemId(fontLibrary, 0);
    } else {
      warnings.push('Could not resolve Font library "' + options.fontLibraryRef + '". Choose an existing Font library before running this wizard draft.');
    }
  }

  if (options.colorPaletteRef) {
    const colorPalette = findWizardAssetLibrary(context, 'colorPalettes', options.colorPaletteRef);
    config.colorSource = 'palette';
    if (colorPalette) {
      config.colorPaletteLibraryId = normalizeId(colorPalette.id || colorPalette.name || colorPalette.displayName);
      config.textColorPaletteItemId = getWizardAssetItemId(colorPalette, 0);
      config.outlineColorPaletteItemId = getWizardAssetItemId(colorPalette, 1) || config.textColorPaletteItemId;
      config.backgroundColorPaletteItemId = getWizardAssetItemId(colorPalette, 2) || config.outlineColorPaletteItemId || config.textColorPaletteItemId;
    } else {
      warnings.push('Could not resolve Color Palette library "' + options.colorPaletteRef + '". Choose an existing Color Palette library before running this wizard draft.');
    }
  }
  return config;
}
function buildWizardNormalizeMediaConfig(stage = {}, inputKind = '', warnings = []) {
  const itemKind = getIntentCollectionItemKind(inputKind) || inputKind;
  const options = normalizeWizardNormalizeMediaOptions({
    ...(stage.normalizeMedia || {}),
    mediaKind: stage.normalizeMedia?.mediaKind || itemKind,
  });
  const mediaKind = normalizeWizardMediaKind(options.mediaKind || itemKind);
  const formatResult = normalizeWizardOutputFormatForKind(mediaKind, options.outputFormat);
  const unsupportedFormat = options.unsupportedFormat || formatResult.unsupportedFormat;
  if (unsupportedFormat) {
    warnings.push('The requested .' + unsupportedFormat + ' format is not supported by Normalize ' + mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1) + '. Local AI Hub left this as an editable normalized-format draft using ' + formatResult.outputFormat + '.');
  }
  if (mediaKind === 'audio') {
    return { outputFormat: formatResult.outputFormat || 'auto', sampleRate: 44100, channels: 'stereo', pcmFormat: 'pcm_s16le' };
  }
  if (mediaKind === 'video') {
    return { outputFormat: formatResult.outputFormat || 'auto', sizeMode: 'matchFirst', width: 1280, height: 720, fps: 30, videoCodec: 'libx264', audioCodec: 'aac', pixelFormat: 'yuv420p' };
  }
  return { outputFormat: formatResult.outputFormat || 'auto' };
}

function getWizardNormalizeNodeTypeForKind(kind = '') {
  const itemKind = getIntentCollectionItemKind(kind) || kind;
  if (itemKind === 'audio') return 'normalizeAudioCollection';
  if (itemKind === 'video') return 'normalizeVideoCollection';
  if (itemKind === 'image') return 'normalizeImage';
  return '';
}

function getWizardNormalizePortIdForKind(kind = '') {
  const itemKind = getIntentCollectionItemKind(kind) || kind;
  return itemKind === 'image' ? 'image' : 'collection';
}
function buildWizardTrimMediaConfig(stage = {}) {
  const options = normalizeWizardTrimMediaOptions(stage.trimMedia || {});
  return {
    mode: options.mode,
    startSeconds: options.startSeconds,
    durationSeconds: options.durationSeconds,
    endSeconds: options.endSeconds,
  };
}

function buildWizardExtractVideoFrameConfig(stage = {}) {
  const options = normalizeWizardExtractVideoFrameOptions(stage.extractVideoFrame || {});
  return {
    framePosition: options.framePosition,
    timestampSeconds: options.timestampSeconds,
    outputFormat: 'png',
  };
}

function buildWizardExportSubtitlesConfig(stage = {}) {
  const options = normalizeWizardExportSubtitlesOptions(stage.exportSubtitles || {});
  return {
    outputFormat: options.outputFormat,
    captionMode: options.captionMode,
    durationPerCaptionSeconds: options.durationPerCaptionSeconds,
  };
}

function buildWizardAudioStitchConfig(stage = {}) {
  const options = normalizeWizardMediaStitchOptions(stage.mediaStitch || {});
  return { gapSeconds: options.gapSeconds };
}

function buildWizardVideoStitchConfig(stage = {}) {
  const options = normalizeWizardMediaStitchOptions(stage.mediaStitch || {});
  return { outputFormat: options.outputFormat === 'webm' ? 'webm' : 'mp4' };
}
function getTargetOperationInputKinds(target = {}, operationId, context = {}) {
  if (target.executionMode === 'ollama') {
    return getToolPipelineOperation('ollama', operationId)?.inputKinds || [];
  }
  if (target.executionMode === 'localTool' || target.executionMode === 'localTool') {
    return getToolPipelineOperation(target.toolId, operationId)?.inputKinds || [];
  }
  if (target.executionMode === 'cloud') {
    const providerId = normalizeId(target.providerId);
    const model = normalizeModelId(target.model);
    if (!providerId) {
      return [];
    }
    return (model ? getProviderModelCapabilities(providerId, model)?.operations?.[operationId] : null)?.inputKinds
      || getProviderPipelineOperation(providerId, operationId)?.inputKinds
      || [];
  }
  return (context.connectedProviders || [])
    .flatMap((provider) => getProviderPipelineOperation(provider.id, operationId)?.inputKinds || []);
}

function canModelPromptReadKind(kind, target = null, context = {}) {
  const normalizedKind = normalizeIntentKind(kind, '');
  if (!['text', 'image', 'video', 'file'].includes(normalizedKind)) {
    return false;
  }
  if (!target) {
    return true;
  }
  return getTargetOperationInputKinds(target, PIPELINE_OPERATION_IDS.LLM_PROMPT, context).includes(normalizedKind);
}

function addIntentOutputNode(nodes, edges, artifact, outputRequest = {}) {
  const kind = inferOutputKindFromArtifact(artifact, normalizeIntentKind(outputRequest.kind, ''));
  if (!artifact?.node || !artifact?.portId) return false;
  if (kind === 'plan') {
    const outputNode = makeNode('planOutput', nodes.length, { title: outputRequest.title || 'Plan result' }, outputRequest.title || 'Plan output');
    nodes.push(outputNode);
    connect(edges, artifact.node, artifact.portId, outputNode, 'plan');
    return true;
  }
  if (kind === 'collection' || String(kind).startsWith('collection:')) {
    const outputNode = makeNode('collectionOutput', nodes.length, { title: outputRequest.title || 'Collection result' }, outputRequest.title || 'Collection output');
    nodes.push(outputNode);
    connect(edges, artifact.node, artifact.portId, outputNode, 'collection');
    return true;
  }
  const outputNodeType = OUTPUT_NODE_BY_KIND[kind];
  if (!outputNodeType) return false;
  const outputNode = makeOutputNode(kind, nodes.length, outputRequest.title || (kind.charAt(0).toUpperCase() + kind.slice(1) + ' result'));
  nodes.push(outputNode);
  connect(edges, artifact.node, artifact.portId, outputNode, kind);
  return true;
}


function buildIntentIrPipeline({ intent, plan, context, wizardTarget }) {
  const intentIr = plan?.intentIr || null;
  if (!intentIr || (!intentIr.sources.length && !intentIr.stages.length && !intentIr.outputs.length)) return null;
  const nodes = [];
  const edges = [];
  const warnings = [...(intentIr.gaps || []), ...(intentIr.assumptions || []).map((entry) => 'Assumption: ' + entry)];
  const artifactMap = new Map();
  const stagePrimaryNodes = new Map();
  const stageOutputArtifacts = new Map();
  const validationByStageId = new Map();
  const operationTargets = [];
  let lastArtifact = null;
  let lastValidation = null;

  for (const artifact of intentIr.artifacts || []) {
    registerArtifact(artifactMap, artifact.name, { kind: artifact.kind || 'text', node: null, portId: '', label: artifact.role || artifact.name });
  }
  for (const source of intentIr.sources || []) {
    const nodeType = sourceNodeTypeForKind(source.modality);
    const node = makeNode(nodeType, nodes.length, sourceNodeConfigForKind(source.modality), sanitizeRuntimeLabel(source.role || source.name, intent, getNodeTypeDefinition(nodeType)?.label));
    nodes.push(node);
    lastArtifact = registerArtifact(artifactMap, source.name, { kind: source.modality, node, portId: sourcePortForKind(source.modality), label: source.role || source.name });
  }
  const defaultInputArtifact = () => lastArtifact || [...artifactMap.values()].find((entry) => entry?.node && entry?.portId) || null;

  for (const stage of intentIr.stages || []) {
    const inputArtifact = getPrimaryStageInput(stage, artifactMap) || defaultInputArtifact();
    const outputName = getStageOutputName(stage, stage.id + '-output');
    if (stage.kind !== 'retry' && !inputArtifact) {
      warnings.push('Skipped ' + stage.kind.replace(/_/g, ' ') + ' because the IR did not provide a supported input artifact.');
      continue;
    }

    if (stage.kind === 'plan') {
      const normalizedTarget = normalizeWizardTarget(wizardTarget);
      const plannerTarget = normalizedTarget.mode === 'ollama'
        ? { executionMode: 'ollama', providerId: '', model: normalizedTarget.model }
        : { executionMode: 'cloud', providerId: normalizedTarget.providerId, model: normalizedTarget.model };
      const packetNode = makeNode('planningPacket', nodes.length, buildPlanningPacketConfig({ intent, context, title: 'Planning packet' }), 'Planning packet');
      const plannerNode = makeNode('planner', nodes.length + 1, {
        executionMode: plannerTarget.executionMode,
        providerId: plannerTarget.executionMode === 'cloud' ? plannerTarget.providerId : '',
        model: plannerTarget.model || '',
        schemaId: DEFAULT_PLANNING_SCHEMA_ID,
        instruction: normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), 'Create a grounded structured plan from the connected Planning Packet and keep manual refinement needs explicit.'),
      }, 'Planner');
      nodes.push(packetNode, plannerNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, packetNode, 'source');
      connect(edges, packetNode, 'packet', plannerNode, 'packet');
      stagePrimaryNodes.set(stage.id, plannerNode);
      operationTargets.push({ nodeLabel: plannerNode.label, operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT, target: plannerTarget });
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'plan', node: plannerNode, portId: 'plan', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'plan_scenes') {
      if (inputArtifact.kind !== 'plan') {
        warnings.push('Skipped plan scenes because the connected artifact is not a structured Plan.');
        continue;
      }
      const scenesNode = makeNode('planScenes', nodes.length, {}, 'Plan scenes');
      nodes.push(scenesNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, scenesNode, 'plan');
      stagePrimaryNodes.set(stage.id, scenesNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'collection:text', node: scenesNode, portId: 'collection', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'llm_generate_text') {
      const target = chooseTargetForOperation(PIPELINE_OPERATION_IDS.LLM_PROMPT, context, wizardTarget);
      if (!canModelPromptReadKind(inputArtifact.kind)) {
        warnings.push('Skipped text generation because ' + inputArtifact.kind + ' is not a supported Model Step input in this pass.');
        continue;
      }
      if (!canModelPromptReadKind(inputArtifact.kind, target, context)) {
        warnings.push('The selected text-generation runtime does not accept ' + inputArtifact.kind + ' inputs. Switch this step to a provider/model whose declared capabilities include ' + inputArtifact.kind + ' before running.');
      }
      if (inputArtifact.kind === 'image') {
        const normalizedTarget = normalizeWizardTarget(wizardTarget);
        const targetCapabilities = normalizedTarget.mode === 'cloud' && normalizedTarget.providerId && normalizedTarget.model
          ? getProviderModelCapabilities(normalizedTarget.providerId, normalizedTarget.model)
          : null;
        if (normalizedTarget.mode === 'ollama' || targetCapabilities?.supportsImageInput === false) {
          warnings.push('The selected runtime model must be able to read image inputs, or you should switch this step to a vision-capable provider/model before running.');
        }
      }
      const textNode = makeNode('llmPrompt', nodes.length, buildLlmStepConfig(PIPELINE_OPERATION_IDS.LLM_PROMPT, target, intent, {
        instruction: normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), 'Process the connected runtime input and return text.'),
      }), stage.purpose ? 'Generate text' : 'Model response');
      nodes.push(textNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, textNode, 'prompt');
      stagePrimaryNodes.set(stage.id, textNode);
      operationTargets.push({ nodeLabel: textNode.label, operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT, target });
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'text', node: textNode, portId: 'text', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'build_collection') {
      const inputArtifacts = (Array.isArray(stage.inputs) && stage.inputs.length ? stage.inputs : [stage.input])
        .map((inputName) => artifactMap.get(inputName))
        .filter((artifact) => artifact?.node && artifact?.portId);
      const itemKinds = [...new Set(inputArtifacts.map((artifact) => artifact.kind).filter((kind) => kind && !String(kind).startsWith('collection:')))]
      if (!inputArtifacts.length || itemKinds.length !== 1) {
        warnings.push('Skipped collection building because it needs one or more single artifacts of the same kind.');
        continue;
      }
      const collectionNode = makeNode('collectionBuilder', nodes.length, { insertionMode: 'append' }, 'Build prompt collection');
      nodes.push(collectionNode);
      for (const artifact of inputArtifacts) {
        connect(edges, artifact.node, artifact.portId, collectionNode, 'items');
      }
      stagePrimaryNodes.set(stage.id, collectionNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'collection:' + itemKinds[0], node: collectionNode, portId: 'collection', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'normalize_media') {
      const normalizeNodeType = getWizardNormalizeNodeTypeForKind(inputArtifact.kind);
      const portId = getWizardNormalizePortIdForKind(inputArtifact.kind);
      if (!normalizeNodeType || !portId) {
        warnings.push('Skipped media normalization because it needs an audio, video, image, or matching media collection input.');
        continue;
      }
      const normalizeNode = makeNode(normalizeNodeType, nodes.length, buildWizardNormalizeMediaConfig(stage, inputArtifact.kind, warnings), 'Normalize ' + (getIntentCollectionItemKind(inputArtifact.kind) || inputArtifact.kind));
      nodes.push(normalizeNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, normalizeNode, portId);
      stagePrimaryNodes.set(stage.id, normalizeNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: inputArtifact.kind, node: normalizeNode, portId, label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }
    if (stage.kind === 'trim_media') {
      if (!['audio', 'video'].includes(inputArtifact.kind)) {
        warnings.push('Skipped Trim Media because it needs a single audio or video artifact.');
        continue;
      }
      const trimNode = makeNode('trimMedia', nodes.length, buildWizardTrimMediaConfig(stage), 'Trim media');
      nodes.push(trimNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, trimNode, 'media');
      stagePrimaryNodes.set(stage.id, trimNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: inputArtifact.kind, node: trimNode, portId: 'trimmed', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'extract_audio') {
      if (inputArtifact.kind !== 'video') {
        warnings.push('Skipped Extract Audio because it needs a video artifact.');
        continue;
      }
      const extractNode = makeNode('extractAudio', nodes.length, { outputFormat: 'wav' }, 'Extract audio');
      nodes.push(extractNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, extractNode, 'video');
      stagePrimaryNodes.set(stage.id, extractNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'audio', node: extractNode, portId: 'audio', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'extract_video_frame') {
      if (inputArtifact.kind !== 'video') {
        warnings.push('Skipped Extract Video Frame because it needs a video artifact.');
        continue;
      }
      const frameNode = makeNode('extractVideoFrame', nodes.length, buildWizardExtractVideoFrameConfig(stage), 'Extract video frame');
      nodes.push(frameNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, frameNode, 'video');
      stagePrimaryNodes.set(stage.id, frameNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'image', node: frameNode, portId: 'image', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'export_subtitles') {
      if (inputArtifact.kind !== 'text') {
        warnings.push('Skipped Export Subtitles because it needs transcript or caption text.');
        continue;
      }
      const subtitlesNode = makeNode('exportSubtitles', nodes.length, buildWizardExportSubtitlesConfig(stage), 'Export subtitles');
      nodes.push(subtitlesNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, subtitlesNode, 'captions');
      stagePrimaryNodes.set(stage.id, subtitlesNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'file', node: subtitlesNode, portId: 'subtitles', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'stitch_audio') {
      if (inputArtifact.kind !== 'collection:audio') {
        warnings.push('Skipped Audio Stitch because it needs an ordered audio collection.');
        continue;
      }
      const stitchNode = makeNode('audioStitch', nodes.length, buildWizardAudioStitchConfig(stage), 'Stitch audio');
      nodes.push(stitchNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, stitchNode, 'collection');
      stagePrimaryNodes.set(stage.id, stitchNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'audio', node: stitchNode, portId: 'audio', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'stitch_video') {
      if (inputArtifact.kind !== 'collection:video') {
        warnings.push('Skipped Video Stitch because it needs an ordered video collection.');
        continue;
      }
      const stitchNode = makeNode('videoStitch', nodes.length, buildWizardVideoStitchConfig(stage), 'Stitch video');
      nodes.push(stitchNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, stitchNode, 'collection');
      stagePrimaryNodes.set(stage.id, stitchNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'video', node: stitchNode, portId: 'video', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }
    if (stage.kind === 'generate_image') {
      const providerPreference = getStageProviderPreference(stage, plan);
      if (inputArtifact.kind === 'collection:text' || inputArtifact.kind === 'collection:image') {
        const mappingId = inferImageMappingId(inputArtifact.kind, stage);
        const mapStep = makeCollectionMapImageNode(nodes.length, context, wizardTarget, intent, {
          allowedProviderIds: WIZARD_CLOUD_IMAGE_PROVIDER_IDS,
          inputKind: inputArtifact.kind,
          providerPreference,
          preferCloud: Boolean(providerPreference) || mappingId === 'cloudImageToImage',
          stage,
          perItemValidation: stage.collectionValidation,
          instruction: mappingId === 'cloudImageToImage'
            ? normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), 'Edit each source image using one shared instruction and preserve source order.')
            : normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), 'Generate one image for each collection item while preserving the source order.'),
        });
        nodes.push(mapStep.node);
        connect(edges, inputArtifact.node, inputArtifact.portId, mapStep.node, 'collection');
        stagePrimaryNodes.set(stage.id, mapStep.node);
        operationTargets.push({ nodeLabel: mapStep.node.label, operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE, target: mapStep.target });
        warnings.push(...mapStep.warnings);
        lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'collection:image', node: mapStep.node, portId: mapStep.outputPortId, label: stage.purpose || outputName });
        stageOutputArtifacts.set(stage.id, lastArtifact);
        continue;
      }
      if (!['text', 'image'].includes(inputArtifact.kind)) {
        warnings.push('Skipped image generation because it needs a text prompt or image source artifact in this pass.');
        continue;
      }
      const wantsImageEdit = inputArtifact.kind === 'image' || normalizeWizardOperationSubtype(stage.operationSubtype) === 'imageToImage';
      const imageStep = makeImageGenerationNode(nodes.length, context, wizardTarget, intent, {
        allowedProviderIds: WIZARD_CLOUD_IMAGE_PROVIDER_IDS,
        providerPreference,
        preferCloud: Boolean(providerPreference) || wantsImageEdit,
        instruction: wantsImageEdit
          ? normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), 'Edit the connected image according to the prompt. Leave detailed image settings editable for manual refinement.')
          : normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), 'Generate an image from the connected prompt. Leave detailed image settings editable for manual refinement.'),
      });
      nodes.push(imageStep.node);
      connect(edges, inputArtifact.node, inputArtifact.portId, imageStep.node, 'prompt');
      stagePrimaryNodes.set(stage.id, imageStep.node);
      operationTargets.push({ nodeLabel: imageStep.node.label, operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE, target: imageStep.target });
      warnings.push(...imageStep.warnings);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'image', node: imageStep.node, portId: imageStep.outputPortId, label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'generate_audio') {
      const isReferenceVoice = isReferenceVoiceStage(stage, plan);
      const referenceArtifact = isReferenceVoice ? findReferenceAudioArtifact(stage, artifactMap, inputArtifact) : null;
      if (isReferenceVoice && inputArtifact.kind === 'collection:text') {
        const mapStep = makeCollectionMapOperationNode(nodes.length, PIPELINE_OPERATION_IDS.AUDIO_GENERATE, inputArtifact.kind, context, wizardTarget, intent, {
          preferredToolIds: ['chatterbox-tts'],
          mappingId: 'textToAudio',
          label: 'Generate voice lines',
          instruction: normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), 'Generate speech for each text item using the shared reference voice audio.'),
          config: { audioMode: 'referenceVoiceTts' },
          perItemValidation: stage.collectionValidation,
        });
        nodes.push(mapStep.node);
        connect(edges, inputArtifact.node, inputArtifact.portId, mapStep.node, 'collection');
        if (referenceArtifact) {
          connect(edges, referenceArtifact.node, referenceArtifact.portId, mapStep.node, 'referenceAudio');
        } else {
          warnings.push('Reference Voice TTS needs a shared reference audio input before the generated voice lines can run.');
        }
        stagePrimaryNodes.set(stage.id, mapStep.node);
        operationTargets.push({ nodeLabel: mapStep.node.label, operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE, target: mapStep.target });
        warnings.push(...mapStep.warnings);
        lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'collection:audio', node: mapStep.node, portId: mapStep.outputPortId, label: stage.purpose || outputName });
        stageOutputArtifacts.set(stage.id, lastArtifact);
        continue;
      }
      if (isReferenceVoice && inputArtifact.kind !== 'text') {
        warnings.push('Skipped Reference Voice TTS because it needs text or a text collection plus shared reference audio.');
        continue;
      }
      if (!isReferenceVoice && !['text', 'audio'].includes(inputArtifact.kind)) {
        warnings.push('Skipped audio generation because it needs a text prompt or supported audio guidance artifact.');
        continue;
      }
      const audioStep = makeOperationModelStepNode(nodes.length, PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'audio', context, wizardTarget, intent, {
        preferredToolIds: isReferenceVoice ? ['chatterbox-tts'] : [],
        instruction: normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), isReferenceVoice ? 'Generate speech from the connected text using the shared reference voice audio.' : getDefaultInstructionForOperation(PIPELINE_OPERATION_IDS.AUDIO_GENERATE)),
        config: isReferenceVoice ? { audioMode: 'referenceVoiceTts' } : {},
      });
      if (!getTargetOperationInputKinds(audioStep.target, PIPELINE_OPERATION_IDS.AUDIO_GENERATE, context).includes(inputArtifact.kind)) {
        warnings.push('The selected audio-generation runtime does not accept ' + inputArtifact.kind + ' inputs. Switch this step to AudioCraft, Chatterbox-Turbo, or a compatible provider before running.');
      }
      nodes.push(audioStep.node);
      connect(edges, inputArtifact.node, inputArtifact.portId, audioStep.node, 'prompt');
      if (isReferenceVoice) {
        if (referenceArtifact) {
          connect(edges, referenceArtifact.node, referenceArtifact.portId, audioStep.node, 'referenceAudio');
        } else {
          warnings.push('Reference Voice TTS needs a reference audio input before this Model Step can run.');
        }
      }
      stagePrimaryNodes.set(stage.id, audioStep.node);
      operationTargets.push({ nodeLabel: audioStep.node.label, operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE, target: audioStep.target });
      warnings.push(...audioStep.warnings);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'audio', node: audioStep.node, portId: 'audio', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }
    if (stage.kind === 'transform_audio') {
      if (inputArtifact.kind !== 'audio') {
        warnings.push('Skipped audio transformation because it needs an audio source artifact.');
        continue;
      }
      const audioStep = makeOperationModelStepNode(nodes.length, PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM, 'audio', context, wizardTarget, intent, {
        instruction: normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), getDefaultInstructionForOperation(PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM)),
      });
      nodes.push(audioStep.node);
      connect(edges, inputArtifact.node, inputArtifact.portId, audioStep.node, 'prompt');
      stagePrimaryNodes.set(stage.id, audioStep.node);
      operationTargets.push({ nodeLabel: audioStep.node.label, operationId: PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM, target: audioStep.target });
      warnings.push(...audioStep.warnings, 'Choose an RVC voice model before running this audio transformation step.');
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'audio', node: audioStep.node, portId: 'audio', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'generate_video') {
      const providerPreference = getStageProviderPreference(stage, plan);
      if (inputArtifact.kind === 'collection:text' || inputArtifact.kind === 'collection:image') {
        const mappingId = inferVideoMappingId(inputArtifact.kind, stage);
        const mapStep = makeCollectionMapOperationNode(nodes.length, PIPELINE_OPERATION_IDS.VIDEO_GENERATE, inputArtifact.kind, context, wizardTarget, intent, {
          allowedProviderIds: WIZARD_CLOUD_VIDEO_PROVIDER_IDS,
          config: {
            videoItemMode: stage.previousLastFrameChaining || plan?.requestObligations?.previousLastFrameChaining ? 'sequentialLastFrame' : 'independent',
          },
          instruction: mappingId === 'cloudImageToVideo'
            ? normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), 'Create one video from each source image and preserve source order.')
            : normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), 'Create one video from each text prompt and preserve source order.'),
          label: 'Generate videos for collection',
          mappingId,
          providerPreference,
          preferCloud: Boolean(providerPreference) || mappingId === 'cloudImageToVideo',
        });
        nodes.push(mapStep.node);
        connect(edges, inputArtifact.node, inputArtifact.portId, mapStep.node, 'collection');
        stagePrimaryNodes.set(stage.id, mapStep.node);
        operationTargets.push({ nodeLabel: mapStep.node.label, operationId: PIPELINE_OPERATION_IDS.VIDEO_GENERATE, target: mapStep.target });
        warnings.push(...mapStep.warnings);
        lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'collection:video', node: mapStep.node, portId: mapStep.outputPortId, label: stage.purpose || outputName });
        stageOutputArtifacts.set(stage.id, lastArtifact);
        continue;
      }
      if (!['text', 'image'].includes(inputArtifact.kind)) {
        warnings.push('Skipped video generation because it needs a text prompt or image source artifact.');
        continue;
      }
      const videoStep = makeOperationModelStepNode(nodes.length, PIPELINE_OPERATION_IDS.VIDEO_GENERATE, 'video', context, wizardTarget, intent, {
        allowedProviderIds: WIZARD_CLOUD_VIDEO_PROVIDER_IDS,
        forceLocal: Boolean(plan?.requestObligations?.forceLocalVideo),
        providerPreference,
        preferCloud: Boolean(providerPreference),
        instruction: inputArtifact.kind === 'image' || normalizeWizardOperationSubtype(stage.operationSubtype) === 'imageToVideo'
          ? 'Create a short video from the connected image. Leave motion guidance and generation settings editable for manual refinement.'
          : normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), getDefaultInstructionForOperation(PIPELINE_OPERATION_IDS.VIDEO_GENERATE)),
      });
      if (!getTargetOperationInputKinds(videoStep.target, PIPELINE_OPERATION_IDS.VIDEO_GENERATE, context).includes(inputArtifact.kind)) {
        warnings.push('The selected video-generation runtime does not accept ' + inputArtifact.kind + ' inputs. Switch this step to Google, xAI, Wan2.1 WebUI, or a compatible video provider before running.');
      }
      nodes.push(videoStep.node);
      connect(edges, inputArtifact.node, inputArtifact.portId, videoStep.node, 'prompt');
      stagePrimaryNodes.set(stage.id, videoStep.node);
      operationTargets.push({ nodeLabel: videoStep.node.label, operationId: PIPELINE_OPERATION_IDS.VIDEO_GENERATE, target: videoStep.target });
      warnings.push(...videoStep.warnings);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'video', node: videoStep.node, portId: 'video', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }
    if (stage.kind === 'transform_image') {
      if (inputArtifact.kind !== 'image') {
        warnings.push('Skipped image transformation because it needs an image source artifact.');
        continue;
      }
      const inputArtifacts = (Array.isArray(stage.inputs) && stage.inputs.length ? stage.inputs : [stage.input])
        .map((inputName) => artifactMap.get(inputName))
        .filter((artifact) => artifact?.node && artifact?.portId);
      const referenceArtifact = inputArtifacts.find((artifact) => artifact !== inputArtifact && artifact.kind === 'image') || null;
      const wantsFaceFusion = inferIntentFeatures(intent).wantsFaceFusionTransform || Boolean(referenceArtifact);
      const imageStep = makeOperationModelStepNode(nodes.length, PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, 'image', context, wizardTarget, intent, {
        preferredToolIds: wantsFaceFusion ? ['facefusion', ...IMAGE_TRANSFORM_TOOL_IDS.filter((toolId) => toolId !== 'facefusion')] : getPreferredImageTransformToolIds(intent),
        instruction: normalizeString(sanitizeRuntimeTextDefault(stage.purpose, intent), getDefaultInstructionForOperation(PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM)),
      });
      nodes.push(imageStep.node);
      connect(edges, inputArtifact.node, inputArtifact.portId, imageStep.node, 'prompt');
      if (wantsFaceFusion && referenceArtifact) {
        connect(edges, referenceArtifact.node, referenceArtifact.portId, imageStep.node, 'referenceImage');
      }
      stagePrimaryNodes.set(stage.id, imageStep.node);
      operationTargets.push({ nodeLabel: imageStep.node.label, operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, target: imageStep.target });
      warnings.push(...imageStep.warnings);
      if (wantsFaceFusion && !referenceArtifact) {
        warnings.push('FaceFusion image mode needs a reference face image placeholder before running.');
      }
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'image', node: imageStep.node, portId: 'image', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'transcribe_audio') {
      if (!inputArtifact || inputArtifact.kind !== 'audio') {
        warnings.push('Skipped audio transcription because it needs an audio source artifact.');
        continue;
      }
      const whisperNode = makeNode('llmPrompt', nodes.length, buildLlmStepConfig(PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE, { executionMode: 'localTool', toolId: 'whisper', model: 'base', providerId: '' }, '', { instruction: 'Transcribe the connected source audio into text.' }), 'Transcribe audio');
      nodes.push(whisperNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, whisperNode, 'prompt');
      stagePrimaryNodes.set(stage.id, whisperNode);
      operationTargets.push({ nodeLabel: whisperNode.label, operationId: PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE, target: { executionMode: 'localTool', toolId: 'whisper', model: 'base', providerId: '' } });
      if (!getToolEntry(context, 'whisper')) warnings.push('Install Whisper before this transcription draft can run.');
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'text', node: whisperNode, portId: 'text', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'validate') {
      const mode = ['user', 'manual', 'approval'].includes(stage.validationMode) ? 'user' : 'llm';
      const validationNode = makeNode('validation', nodes.length, buildValidationConfig(inputArtifact.kind, wizardTarget, normalizeString(stage.purpose, getDefaultValidationRuleset(inputArtifact.kind)), { mode }), 'Validate ' + (inputArtifact.label || inputArtifact.kind || 'artifact'));
      nodes.push(validationNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, validationNode, 'input');
      stagePrimaryNodes.set(stage.id, validationNode);
      lastValidation = { node: validationNode, inputArtifact, stageId: stage.id };
      validationByStageId.set(stage.id, lastValidation);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: inputArtifact.kind, node: validationNode, portId: 'pass', label: stage.purpose || outputName, validationNode, validationInputArtifact: inputArtifact });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'retry') {
      const validationArtifact = inputArtifact?.validationNode ? inputArtifact : null;
      const validationMeta = validationArtifact ? { node: validationArtifact.validationNode, inputArtifact: validationArtifact.validationInputArtifact || inputArtifact } : validationByStageId.get(stage.retryTarget) || lastValidation;
      if (!validationMeta?.node) {
        warnings.push('Skipped retry because it needs a preceding validation stage with pass/fail branches.');
        continue;
      }
      const retryTargetNode = stagePrimaryNodes.get(stage.retryTarget) || stagePrimaryNodes.get(validationMeta.stageId) || validationMeta.inputArtifact?.node || null;
      const retryNode = makeNode('retryLoop', nodes.length, {
        retryTargetNodeId: retryTargetNode?.id || '',
        maxAttempts: stage.maxAttempts || 3,
        retryTerminationAction: 'fail',
      }, 'Retry until valid');
      nodes.push(retryNode);
      connect(edges, validationMeta.node, 'pass', retryNode, 'complete');
      connect(edges, validationMeta.node, 'fail', retryNode, 'retry');
      stagePrimaryNodes.set(stage.id, retryNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: validationMeta.inputArtifact?.kind || inputArtifact?.kind || 'text', node: retryNode, portId: 'result', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }
    if (stage.kind === 'compose_media') {
      let visualArtifact = inputArtifact;
      if (visualArtifact.kind === 'image') {
        const collectionNode = makeNode('collectionBuilder', nodes.length, { insertionMode: 'append' }, 'Collect images');
        nodes.push(collectionNode);
        connect(edges, visualArtifact.node, visualArtifact.portId, collectionNode, 'items');
        visualArtifact = { kind: 'collection:image', node: collectionNode, portId: 'collection', label: 'Image collection' };
      }
      if (visualArtifact.kind !== 'collection:image') {
        warnings.push('Skipped media composition because it needs an ordered image collection.');
        continue;
      }
      const compositionNode = makeNode('mediaComposition', nodes.length, buildWizardMediaCompositionConfig(stage, context, warnings), 'Sequence media');
      nodes.push(compositionNode);
      connect(edges, visualArtifact.node, visualArtifact.portId, compositionNode, 'visuals');
      const stageInputArtifacts = (Array.isArray(stage.inputs) && stage.inputs.length ? stage.inputs : [stage.input])
        .map((inputName) => artifactMap.get(inputName))
        .filter((artifact) => artifact?.kind === 'audio' && artifact?.node && artifact?.portId);
      const allAudioArtifacts = [...stageInputArtifacts, ...[...artifactMap.values()].filter((artifact) => artifact?.kind === 'audio' && artifact?.node && artifact?.portId)];
      const seenAudio = new Set();
      const audioArtifacts = allAudioArtifacts.filter((artifact) => {
        const key = artifact.name || artifact.node.id + ':' + artifact.portId;
        if (seenAudio.has(key)) return false;
        seenAudio.add(key);
        return true;
      });
      const isBackgroundAudio = (artifact) => /\b(background|music|bed|soundtrack)\b/i.test([artifact.name, artifact.label].filter(Boolean).join(' '));
      const backgroundMusicArtifact = audioArtifacts.find(isBackgroundAudio) || null;
      const primaryAudioArtifact = audioArtifacts.find((artifact) => artifact !== backgroundMusicArtifact && !isBackgroundAudio(artifact)) || null;
      if (primaryAudioArtifact) {
        connect(edges, primaryAudioArtifact.node, primaryAudioArtifact.portId, compositionNode, 'audio');
      }
      if (backgroundMusicArtifact) {
        connect(edges, backgroundMusicArtifact.node, backgroundMusicArtifact.portId, compositionNode, 'backgroundMusic');
      }
      stagePrimaryNodes.set(stage.id, compositionNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'composition', node: compositionNode, portId: 'composition', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'burn_subtitles') {
      const inputArtifacts = (Array.isArray(stage.inputs) && stage.inputs.length ? stage.inputs : [stage.input])
        .map((inputName) => artifactMap.get(inputName))
        .filter((artifact) => artifact?.node && artifact?.portId);
      const videoArtifact = inputArtifacts.find((artifact) => artifact.kind === 'video') || (inputArtifact.kind === 'video' ? inputArtifact : null) || [...artifactMap.values()].reverse().find((artifact) => artifact?.kind === 'video' && artifact?.node && artifact?.portId);
      const captionsArtifact = inputArtifacts.find((artifact) => ['text', 'file'].includes(artifact.kind) && artifact !== videoArtifact)
        || [...artifactMap.values()].find((artifact) => ['text', 'file'].includes(artifact?.kind) && /\b(caption|subtitle|transcript)\b/i.test([artifact.name, artifact.label].filter(Boolean).join(' ')));
      if (!videoArtifact) {
        warnings.push('Skipped Burn Subtitles / Captions because it needs a video artifact.');
        continue;
      }
      if (!captionsArtifact) {
        warnings.push('Skipped Burn Subtitles / Captions because it needs transcript text, caption lines, or a subtitle file.');
        continue;
      }
      const burnNode = makeNode('burnSubtitles', nodes.length, buildWizardBurnSubtitlesConfig(stage, context, warnings), 'Burn captions');
      nodes.push(burnNode);
      connect(edges, videoArtifact.node, videoArtifact.portId, burnNode, 'video');
      connect(edges, captionsArtifact.node, captionsArtifact.portId, burnNode, 'captions');
      stagePrimaryNodes.set(stage.id, burnNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'video', node: burnNode, portId: 'video', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
      continue;
    }

    if (stage.kind === 'export') {
      if (inputArtifact.kind !== 'composition') {
        warnings.push('Skipped export because it needs a media composition artifact.');
        continue;
      }
      const exportNode = makeNode('mediaExport', nodes.length, { title: 'Composed video' }, 'Export video');
      nodes.push(exportNode);
      connect(edges, inputArtifact.node, inputArtifact.portId, exportNode, 'composition');
      stagePrimaryNodes.set(stage.id, exportNode);
      lastArtifact = registerArtifact(artifactMap, outputName, { kind: 'video', node: exportNode, portId: 'video', label: stage.purpose || outputName });
      stageOutputArtifacts.set(stage.id, lastArtifact);
    }
  }

  let addedOutput = false;
  for (const outputRequest of intentIr.outputs || []) {
    const artifact = artifactMap.get(outputRequest.artifact) || stageOutputArtifacts.get(outputRequest.artifact);
    if (!artifact) {
      warnings.push('Skipped output "' + outputRequest.artifact + '" because the IR did not produce that artifact.');
      continue;
    }
    addedOutput = addIntentOutputNode(nodes, edges, artifact, outputRequest) || addedOutput;
  }
  if (!addedOutput && lastArtifact) {
    addedOutput = addIntentOutputNode(nodes, edges, lastArtifact, { kind: lastArtifact.kind, title: 'Wizard result' });
  }
  const completed = addedOutput ? { nodes, edges } : appendOutputForLastResult(nodes, edges);
  const firstTarget = operationTargets.find((entry) => entry.target)?.target || null;
  if (!completed.nodes.length) return null;
  return {
    nodes: completed.nodes,
    edges: completed.edges,
    target: firstTarget,
    operationTargets,
    intentIr: true,
    warnings: [...new Set(warnings.map((warning) => normalizeString(warning)).filter(Boolean))],
  };
}

function buildFlexibleGraphPipeline({ intent, plan, context, wizardTarget }) {
  if (!Array.isArray(plan?.draftGraph?.nodes) || !plan.draftGraph.nodes.length) {
    return null;
  }

  const initialNodes = createFlexibleNodes(plan, intent, context, wizardTarget);
  const edgeResult = createValidatedFlexibleEdges(initialNodes, plan.draftGraph.edges || []);
  const completed = appendOutputForLastResult(initialNodes, edgeResult.edges);
  const operationTargets = completed.nodes
    .map((node) => {
      const operationId = getConfiguredOperationForNode(node.type, node.config || {});
      return operationId ? {
        nodeLabel: node.label,
        operationId,
        target: node.type === 'llmPrompt'
          ? {
              executionMode: node.config?.executionMode,
              model: node.config?.model,
              providerId: node.config?.providerId,
              toolId: node.config?.toolId,
            }
          : node.type === 'planner'
            ? {
                executionMode: node.config?.executionMode,
                model: node.config?.model,
                providerId: node.config?.providerId,
                toolId: '',
              }
            : node.type === 'graphWorkflow'
              ? { executionMode: 'localTool', model: '', providerId: '', toolId: node.config?.toolId || '' }
              : null,
      } : null;
    })
    .filter(Boolean);
  const firstTarget = operationTargets.find((entry) => entry.target)?.target || null;

  return {
    nodes: completed.nodes,
    edges: completed.edges,
    target: firstTarget,
    operationTargets,
    flexible: true,
    warnings: edgeResult.skipped,
  };
}
function buildDraftNodesForPlan({ intent, plan, context, wizardTarget }) {
  switch (plan.recipeId) {
    case WIZARD_RECIPE_IDS.TEXT_TO_IMAGE:
      return buildSimpleModelPipeline({ intent, operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE, outputKind: 'image', context, wizardTarget, plan });
    case WIZARD_RECIPE_IDS.TEXT_TO_AUDIO:
      return buildSimpleModelPipeline({ intent, operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE, outputKind: 'audio', context, wizardTarget, plan });
    case WIZARD_RECIPE_IDS.TEXT_TO_VIDEO:
      return buildSimpleModelPipeline({ intent, operationId: PIPELINE_OPERATION_IDS.VIDEO_GENERATE, outputKind: 'video', context, wizardTarget, plan });
    case WIZARD_RECIPE_IDS.IMAGE_TO_TEXT:
      return buildSimpleModelPipeline({ intent, operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT, outputKind: 'text', context, wizardTarget, plan });
    case WIZARD_RECIPE_IDS.IMAGE_TRANSFORM:
      return buildSimpleModelPipeline({ intent, operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, outputKind: 'image', context, wizardTarget, plan });
    case WIZARD_RECIPE_IDS.AUDIO_TRANSCRIBE:
      return buildTranscriptionPipeline({ context });
    case WIZARD_RECIPE_IDS.AUDIO_TRANSFORM:
      return buildSimpleModelPipeline({ intent, operationId: PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM, outputKind: 'audio', context, wizardTarget, plan });
    case WIZARD_RECIPE_IDS.SCENE_PLAN:
      return buildScenePlanPipeline({ intent, context, wizardTarget });
    case WIZARD_RECIPE_IDS.TEXT_RESPONSE:
    default:
      return buildSimpleModelPipeline({ intent, operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT, outputKind: 'text', context, wizardTarget, plan });
  }
}

function summarizeDraftTarget(result, context) {
  if (!result?.target) {
    return '';
  }
  return getTargetLabel(result.target, context);
}

function summarizeResultShape(result) {
  const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
  if (!nodes.length) {
    return 'no instantiated nodes';
  }
  const labels = nodes.map((node) => getNodeTypeDefinition(node.type)?.label || node.type).filter(Boolean);
  if (labels.length <= 6) {
    return labels.join(' -> ');
  }
  const counts = labels.reduce((accumulator, label) => {
    accumulator[label] = Number(accumulator[label] || 0) + 1;
    return accumulator;
  }, {});
  return nodes.length + ' nodes including ' + Object.entries(counts)
    .slice(0, 8)
    .map(([label, count]) => count > 1 ? label + ' x' + count : label)
    .join(', ');
}

function classifyWizardDraftResult(plan = {}, result = {}) {
  const hasDraftGraph = Array.isArray(plan?.draftGraph?.nodes) && plan.draftGraph.nodes.length > 0;
  const usedFallbackPlan = Boolean(plan?.usedFallback);
  const repairedIntent = Boolean(plan?.intentIrRepair?.applied);
  const expandedByHub = Boolean(result?.harness || result?.scaffold);
  const compiledIntent = Boolean(result?.intentIr);
  const directModelGraph = Boolean(result?.flexible || hasDraftGraph);
  const resultState = expandedByHub || repairedIntent || (compiledIntent && usedFallbackPlan)
    ? 'repaired'
    : directModelGraph || compiledIntent || !usedFallbackPlan
      ? 'direct'
      : 'placeholder';
  return {
    resultState,
    usedFallbackPlan,
    repairedIntent,
    expandedByHub,
    compiledIntent,
    directModelGraph,
  };
}
function buildResultMessage(plan, result, classification = classifyWizardDraftResult(plan, result)) {
  if (classification.resultState === 'placeholder') {
    return 'Local AI Hub inserted a simple editable placeholder from built-in node and wiring rules: ' + summarizeResultShape(result) + '. Treat it as a starting graph, not a completed wizard draft for the full request.';
  }
  if (result?.scaffold === 'validated-storyboard-video') {
    return 'Local AI Hub expanded the request into an editable multi-stage storyboard/video scaffold with planning, validation, retry loops, collection image mapping, whole-collection image validation, media composition, and video export where the current node system supports them.';
  }
  if (result?.harness === 'image-description-validation') {
    return 'Local AI Hub created an editable image-description draft with image input, model description, validation, retry, and approved text output. The runtime image is still supplied by the user, and the selected runtime model must support image input before this can run successfully.';
  }
  if (result?.intentIr) {
    return classification.resultState === 'repaired'
      ? 'Local AI Hub repaired and compiled the requested workflow into an editable grounded graph: ' + summarizeResultShape(result) + '.'
      : 'Local AI Hub compiled the model intent into an editable grounded graph: ' + summarizeResultShape(result) + '.';
  }
  if (result?.flexible) {
    return 'Local AI Hub instantiated the model plan as an editable grounded graph: ' + summarizeResultShape(result) + '.';
  }
  const recipe = getRecipeOption(plan.recipeId);
  return 'Local AI Hub created an editable ' + (recipe?.label || 'draft') + ' graph: ' + summarizeResultShape(result) + '.';
}
function buildPipelineDescription(plan, result) {
  const runtimeNote = 'Runtime source nodes are intentionally left empty unless actual source content was supplied; add the real script, prompt, file, or media before running.';
  return [buildResultMessage(plan, result), runtimeNote, 'Generated by the bounded Local AI Hub Pipeline Wizard. Nodes and settings remain editable.'].filter(Boolean).join('\n\n');
}
function getManualRefinementNotes(plan, result, graph, analysis) {
  const notes = [...(plan.userRefinementNotes || [])];
  if (plan.recipeId !== WIZARD_RECIPE_IDS.TEXT_RESPONSE || result?.intentIr || result?.flexible || result?.harness || result?.scaffold) {
    notes.push('Review node settings before running. This first wizard pass drafts structure and wiring, not full parameter tuning.');
  }
  if (graph.errors.length) {
    notes.push('The draft still needs attention before it can run: ' + graph.errors[0]);
  } else if (analysis.primaryIssue?.tone === 'error') {
    notes.push('The draft is editable but needs attention before running: ' + analysis.primaryIssue.message);
  }
  return [...new Set(notes.map((note) => normalizeString(note)).filter(Boolean))];
}

function buildWizardRunSettings(plan = {}) {
  const obligations = plan?.requestObligations || {};
  if (!obligations.wantsHeavyStepCooldown) {
    return undefined;
  }
  return {
    enableHeavyStepCooldown: true,
    heavyStepCooldownSeconds: Math.max(0, Math.min(300, Math.round(Number(obligations.heavyStepCooldownSeconds || 30) || 30))),
  };
}
function buildPipelineWizardDraft({ intent = '', modelPlan = null, replyText = '', context = {}, wizardTarget = {} } = {}) {
  const normalizedIntent = normalizeString(intent);
  const parsedPlan = modelPlan || parsePipelineWizardPlan(replyText, { intent: normalizedIntent });
  const plan = repairPipelineWizardPlan(parsedPlan, { intent: normalizedIntent });
  const modelBuildResult = buildIntentIrPipeline({ intent: normalizedIntent, plan, context, wizardTarget }) || buildFlexibleGraphPipeline({ intent: normalizedIntent, plan, context, wizardTarget }) || buildDraftNodesForPlan({ intent: normalizedIntent, plan, context, wizardTarget });
  const runSettings = buildWizardRunSettings(plan);
  const buildResult = buildHarnessPipelineForIntent({
    intent: normalizedIntent,
    context,
    wizardTarget,
    candidateResult: modelBuildResult,
  }) || modelBuildResult;
  let pipeline = createEmptyPipeline({
    name: plan.title || buildPipelineTitle(normalizedIntent, plan.recipeId),
    description: buildPipelineDescription(plan, buildResult),
    nodes: buildResult.nodes,
    edges: buildResult.edges,
    runSettings,
  });
  let graph = buildPipelineGraph(pipeline);
  let analysis = analyzePipeline(pipeline, buildContextMaps({
    hardware: context.hardware || {},
    providers: context.connectedProviders || [],
    toolCatalog: [],
    tools: context.availableTools || [],
  }));

  if (graph.errors.some((message) => /unsupported node type|invalid connection|cycle|missing a connection|Add at least one output|Add at least one node/i.test(message))) {
    const fallbackPlan = {
      ...plan,
      recipeId: WIZARD_RECIPE_IDS.TEXT_RESPONSE,
      usedFallback: true,
      gaps: [...(plan.gaps || []), 'Local AI Hub fell back to a text-response draft because the requested structure could not be instantiated safely.'],
    };
    const fallbackResult = buildDraftNodesForPlan({ intent: normalizedIntent, plan: fallbackPlan, context, wizardTarget });
    pipeline = createEmptyPipeline({
      name: fallbackPlan.title || buildPipelineTitle(normalizedIntent, fallbackPlan.recipeId),
      description: buildPipelineDescription(fallbackPlan, fallbackResult),
      nodes: fallbackResult.nodes,
      edges: fallbackResult.edges,
      runSettings,
    });
    graph = buildPipelineGraph(pipeline);
    analysis = analyzePipeline(pipeline, buildContextMaps({
      hardware: context.hardware || {},
      providers: context.connectedProviders || [],
      toolCatalog: [],
      tools: context.availableTools || [],
    }));
    return {
      ok: true,
      analysis,
      graphErrors: graph.errors,
      graphWarnings: graph.warnings,
      pipeline: normalizePipelineDefinition(pipeline),
      plan: fallbackPlan,
      summary: buildWizardDraftSummary(fallbackPlan, fallbackResult, context, graph, analysis),
    };
  }

  return {
    ok: true,
    analysis,
    graphErrors: graph.errors,
    graphWarnings: graph.warnings,
    pipeline: normalizePipelineDefinition(pipeline),
    plan,
    summary: buildWizardDraftSummary(plan, buildResult, context, graph, analysis),
  };
}

function buildWizardDraftSummary(plan, result, context, graph, analysis) {
  const recipe = getRecipeOption(plan.recipeId);
  const classification = classifyWizardDraftResult(plan, result);
  const gaps = [...(plan.gaps || []), ...(result.warnings || [])].map((gap) => normalizeString(gap)).filter(Boolean);
  return {
    recipeId: plan.recipeId,
    recipeLabel: classification.resultState === 'placeholder'
      ? 'Fallback placeholder'
      : result?.scaffold === 'validated-storyboard-video'
        ? 'Validated storyboard/video scaffold'
        : result?.harness === 'image-description-validation'
          ? 'Image description with validation/retry'
          : result?.intentIr
            ? 'Intent IR graph'
            : result?.flexible
              ? 'Flexible grounded graph'
              : recipe?.label || plan.recipeId,
    resultState: classification.resultState,
    targetLabel: summarizeDraftTarget(result, context),
    headline: classification.resultState === 'placeholder'
      ? 'Simple fallback placeholder inserted'
      : result?.scaffold === 'validated-storyboard-video'
        ? 'Multi-stage storyboard draft created'
        : result?.harness === 'image-description-validation'
          ? 'Image description validation draft created'
          : result?.intentIr
            ? classification.resultState === 'repaired'
              ? 'Repaired intent draft created'
              : 'Intent graph draft created'
            : result?.flexible
              ? 'Flexible graph draft created'
              : recipe?.label ? recipe.label + ' draft created' : 'Draft pipeline created',
    message: buildResultMessage(plan, result, classification),
    gaps: [...new Set(gaps)],
    manualRefinementNotes: getManualRefinementNotes(plan, result, graph, analysis),
    graphErrorCount: graph.errors.length,
    graphWarningCount: graph.warnings.length,
  };
}

module.exports = {
  WIZARD_PLAN_SCHEMA_VERSION,
  WIZARD_INTENT_IR_SCHEMA_VERSION,
  WIZARD_INTENT_STAGE_KINDS,
  WIZARD_RECIPE_IDS,
  WIZARD_RECIPE_OPTIONS,
  buildPipelineWizardIntentIrJsonSchema,
  buildPipelineWizardStructuredOutputRequest,
  buildPipelineWizardContext,
  buildPipelineWizardDraft,
  buildPipelineWizardMessages,
  getPipelineWizardRequestProfile,
  inferRecipeIdFromIntent,
  parsePipelineWizardPlan,
};

module.exports.default = module.exports;