const path = require('path');
const fs = require('fs-extra');
const { open } = require('node:fs/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
const { version: APP_VERSION } = require('../../package.json');
const { ensureStorage, getAppPaths, humanizeError, readConfig, saveHardwareDetection } = require('./configService');
const {
  migrateLegacyModelManagerSecrets,
  readModelManagerSecrets,
  stripModelManagerSecrets,
  writeModelManagerSecrets,
} = require('./credentialService');
const { runCommand } = require('./commandService');
const { assessDiskSpace, detectHardwareSnapshot, detectStorageSnapshot, findDiskForPath, getDiskSnapshotForPath } = require('./hardwareService');
const { createLogger } = require('./logService');
const { buildOllamaUnavailableMessage, finishOllamaSession, listOllamaModels, prepareOllamaSession } = require('./ollamaService');
const { assertLoopbackUrl, assertSecureRemoteUrl } = require('./pathSafetyService');
const { getToolManifest } = require('./toolRegistry');
const { annotateArtifactsForDownloadPlan, artifactPath, createModelDownloadPlan, ollamaTagPlan } = require('./modelDownloadPlanService');
const { listStableDiffusionApiCheckpoints } = require('./workflowToolService');
const { isToolActive, isToolReady, launchToolFromUserAction, stopTool } = require('./processService');
const { getResolvedToolState } = require('./toolStateService');
const {
  findStableDiffusionCheckpointMatch,
  getRvcVoiceModels,
  getStableDiffusionCheckpointModels,
} = require('../shared/toolAssetSelection.cjs');
const APP_USER_AGENT = `LocalAIHub/${APP_VERSION}`;
const MODEL_BROWSE_CONTEXT = new AsyncLocalStorage();

function createModelBrowseAbortError() {
  const error = new Error('Model catalog loading was canceled.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function getModelBrowseSignal() {
  return MODEL_BROWSE_CONTEXT.getStore()?.signal || null;
}

function throwIfModelBrowseCanceled() {
  if (getModelBrowseSignal()?.aborted) {
    throw createModelBrowseAbortError();
  }
}

function rethrowModelBrowseCancellation(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || getModelBrowseSignal()?.aborted) {
    throw createModelBrowseAbortError();
  }
}

function withModelBrowseSignal(options = {}) {
  const signal = getModelBrowseSignal();
  return signal ? { ...options, signal } : options;
}

function throwIfSignalAborted(signal, message = 'Background loading was canceled.') {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}
const MODEL_SETTINGS_FILE = 'model-manager.settings.json';
const MODEL_DOWNLOAD_BUFFER_LIMIT = 10 * 1024 * 1024;
const PACKAGE_METADATA_FILE = '.localaihub-package.json';
const PACKAGE_METADATA_SUFFIX = '.localaihub-package.json';
const REMOTE_PAGE_SIZE = 24;
const OLLAMA_PAGE_SIZE = 40;
const TOOL_ASSET_REFRESH_POLL_INTERVAL_MS = 1500;
const TOOL_ASSET_REFRESH_STARTUP_GRACE_MS = 15000;
const INVOKEAI_MODEL_IMPORT_TIMEOUT_MS = 20 * 60 * 1000;
const INVOKEAI_MODEL_IMPORT_POLL_INTERVAL_MS = 2000;
const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';
const TABBY_MODEL_REGISTRY_URLS = ['https://models.tabbyml.com', 'https://tabby.tabbyml.com/docs/models/'];
const HUGGING_FACE_SEARCH_URL = 'https://huggingface.co/api/models';
const HUGGING_FACE_MODEL_URL = 'https://huggingface.co/api/models';
const CIVITAI_MODELS_URL = 'https://civitai.com/api/v1/models';
const MODEL_FILE_PATTERN = /\.(safetensors|ckpt|pt|pth|bin|gguf|param)$/i;
const PACKAGE_TOOL_IDS = new Set(['audiocraft-webui', 'wan21-webui', 'upscayl']);
const AUDIOCRAFT_PACKAGE_MODEL_IDS = ['facebook/musicgen-small', 'facebook/musicgen-medium', 'facebook/musicgen-large', 'facebook/musicgen-melody', 'facebook/audiogen-medium'];
const WAN_PACKAGE_MODEL_IDS = ['Wan-AI/Wan2.1-T2V-1.3B', 'Wan-AI/Wan2.1-T2V-14B', 'Wan-AI/Wan2.1-I2V-14B-480P', 'Wan-AI/Wan2.1-I2V-14B-720P'];
const PACKAGE_SUPPORT_FILE_PATTERN = /(?:^|\/)(?:config\.json|tokenizer\.model)$/i;
const RVC_REMOTE_ARTIFACT_FILE_PATTERN = /\.(pth|pt|index)$/i;
const RVC_INDEX_FILE_PATTERN = /\.index$/i;
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|gif)$/i;
const README_FILE_PATTERN = /(?:^|\/)README\.md$/i;
const HUGGING_FACE_FILE_SIZE_CACHE = new Map();
const HUGGING_FACE_PREVIEW_CACHE = new Map();
const HUGGING_FACE_TREE_CACHE = new Map();
const OLLAMA_FAMILY_CACHE = new Map();
const HF_SORT_MAP = {
  'most-downloaded': 'downloads',
  newest: 'created_at',
  'highest-rated': 'likes',
};
const CIVITAI_SORT_MAP = {
  'most-downloaded': 'Most Downloaded',
  newest: 'Newest',
  'highest-rated': 'Highest Rated',
};
const TABBY_SECTION_IDS = {
  chat: 'chat-models---chat-model',
  completion: 'completion-models---model',
  embedding: 'embedding-models',
};
const TABBY_SECTION_LABELS = {
  chat: 'Chat',
  completion: 'Completion',
  embedding: 'Embedding',
};
const VIDEO_TASK_TYPES = new Set(['video-generation', 'image-to-video']);
const HIGH_VRAM_VIDEO_REQUIREMENTS = {
  minimumVramMb: 16 * 1024,
  warningLabel: 'High VRAM Required',
  warningMessage: 'Video generation models usually need 16 GB or more of VRAM.',
};
const HUGGING_FACE_TASK_PROFILES = {
  all: { pipelineTags: [], searchTerms: [], seedModelIds: [] },
  'image-generation': { pipelineTags: ['text-to-image'], searchTerms: [], seedModelIds: [] },
  'image-to-image': { pipelineTags: ['image-to-image'], searchTerms: [], seedModelIds: [] },
  'text-generation': { pipelineTags: ['text-generation'], searchTerms: [], seedModelIds: [] },
  'video-generation': {
    pipelineTags: ['text-to-video'],
    searchTerms: ['video generation'],
    seedModelIds: [
      'Wan-AI/Wan2.1-T2V-1.3B',
      'Wan-AI/Wan2.1-T2V-14B',
      'THUDM/CogVideoX-5b',
      'genmo/mochi-1-preview',
      'Lightricks/LTX-Video',
    ],
    catalogRequirements: HIGH_VRAM_VIDEO_REQUIREMENTS,
  },
  'image-to-video': {
    pipelineTags: ['image-to-video'],
    searchTerms: ['image to video'],
    seedModelIds: [
      'Wan-AI/Wan2.1-I2V-14B-480P',
      'Wan-AI/Wan2.1-I2V-14B-720P',
      'THUDM/CogVideoX-5b-I2V',
      'Lightricks/LTX-Video',
    ],
    catalogRequirements: HIGH_VRAM_VIDEO_REQUIREMENTS,
  },
  'audio-speech': {
    pipelineTags: ['text-to-audio', 'automatic-speech-recognition', 'text-to-speech'],
    searchTerms: ['musicgen'],
    seedModelIds: AUDIOCRAFT_PACKAGE_MODEL_IDS,
  },
  'voice-conversion': {
    pipelineTags: [],
    searchTerms: ['rvc .pth', 'rvc .pt', 'rvc voice model', 'retrieval voice conversion'],
    seedModelIds: [],
  },
};
const MODEL_TYPE_PROFILES = {
  all: { civitaiTypes: [], hfPipelineTags: [], searchTerms: [] },
  checkpoint: { civitaiTypes: ['Checkpoint'], hfPipelineTags: ['text-to-image'], searchTerms: [] },
  lora: { civitaiTypes: ['LORA'], hfPipelineTags: ['text-to-image'], searchTerms: ['lora'] },
  vae: { civitaiTypes: ['VAE'], hfPipelineTags: ['text-to-image'], searchTerms: ['vae'] },
  embedding: { civitaiTypes: ['TextualInversion'], hfPipelineTags: ['text-to-image'], searchTerms: ['embedding'] },
  controlnet: { civitaiTypes: ['Controlnet'], hfPipelineTags: ['image-to-image'], searchTerms: ['controlnet'] },
  hypernetwork: { civitaiTypes: ['Hypernetwork'], hfPipelineTags: ['text-to-image'], searchTerms: ['hypernetwork'] },
  upscaler: { civitaiTypes: ['Upscaler'], hfPipelineTags: ['image-to-image'], searchTerms: ['upscayl custom models'] },
  video: { civitaiTypes: [], hfPipelineTags: ['text-to-video', 'image-to-video'], searchTerms: ['Wan2.1'] },
  gguf: { civitaiTypes: [], hfPipelineTags: ['text-generation'], searchTerms: ['gguf'] },
  'rvc-voice': { civitaiTypes: [], hfPipelineTags: [], searchTerms: ['rvc .pth', 'rvc .pt', 'rvc voice model'] },
  'audio-speech': {
    civitaiTypes: [],
    hfPipelineTags: ['text-to-audio', 'automatic-speech-recognition', 'text-to-speech'],
    searchTerms: ['musicgen'],
  },
  inpainting: { civitaiTypes: ['Checkpoint'], hfPipelineTags: ['image-to-image'], searchTerms: ['inpainting'] },
};
function getModelManagerConfig(tool) {
  const directConfig = tool?.modelManager && typeof tool.modelManager === 'object' ? tool.modelManager : null;
  const manifestConfig = !directConfig && tool?.id ? getToolManifest(tool.id)?.modelManager || null : null;
  const config = directConfig || manifestConfig;
  if (!config || config.enabled === false) {
    return null;
  }
  return config;
}
function getModelManagerSourceOptions(tool) {
  const config = getModelManagerConfig(tool);
  if (!Array.isArray(config?.sources)) {
    return [];
  }
  return config.sources
    .map((entry) => ({
      id: String(entry?.id || '').trim(),
      label: String(entry?.label || entry?.id || '').trim(),
    }))
    .filter((entry) => entry.id && entry.label);
}
function getAllowedModelManagerValues(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}
function coerceAllowedValue(value, allowedValues, fallbackValue) {
  if (!allowedValues.length) {
    return value || fallbackValue;
  }
  return allowedValues.includes(value) ? value : allowedValues[0] || fallbackValue;
}
function getModelManagerDefaults(tool) {
  const config = getModelManagerConfig(tool);
  const sourceOptions = getModelManagerSourceOptions(tool);
  const firstSourceId = sourceOptions[0]?.id || 'huggingface';
  const requestedSource = String(config?.defaults?.source || firstSourceId).trim();
  return {
    modelType: normalizeModelTypeFilter(config?.defaults?.modelType || 'all'),
    source: sourceOptions.some((entry) => entry.id === requestedSource) ? requestedSource : firstSourceId,
    taskType: normalizeTaskTypeFilter(config?.defaults?.taskType || (firstSourceId === 'ollama' ? 'all' : 'image-generation')),
  };
}
function getModelManagerTargetLayout(tool) {
  return getModelManagerConfig(tool)?.targetLayout || null;
}
function supportsModelManager(tool) {
  return Boolean(getModelManagerConfig(tool));
}
function mergeUniqueStrings(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}
function toFileSizeBytes(sizeValue) {
  if (!Number.isFinite(sizeValue)) {
    return 0;
  }
  if (sizeValue > 1024 * 1024) {
    return Math.round(sizeValue);
  }
  if (sizeValue > 1024) {
    return Math.round(sizeValue * 1024);
  }
  return Math.round(sizeValue * 1024 * 1024);
}
function parseHumanSizeToBytes(value) {
  const match = String(value || '').trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?B)$/i);
  if (!match) {
    return 0;
  }
  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const unitIndex = ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(unit);
  if (!Number.isFinite(amount) || unitIndex < 0) {
    return 0;
  }
  return Math.round(amount * 1024 ** unitIndex);
}
function normalizeModelType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return 'Checkpoint';
  }
  if (normalized.includes('rvc') || normalized.includes('retrieval voice conversion') || normalized.includes('voice conversion') || normalized.includes('voice model')) {
    return 'RVC Voice Model';
  }
  if (normalized.includes('gguf') || /\.gguf$/i.test(normalized)) {
    return 'GGUF';
  }
  if (normalized.includes('upscaler') || normalized.includes('esrgan') || normalized.includes('realesrgan')) {
    return 'Upscaler';
  }
  if (normalized.includes('video') || normalized.includes('wan2.1') || normalized.includes('wan-ai')) {
    return 'Video';
  }
  if (normalized.includes('audio') || normalized.includes('speech') || normalized.includes('musicgen') || normalized.includes('bark')) {
    return 'Audio / Speech';
  }
  if (normalized.includes('inpaint')) {
    return 'Inpainting';
  }
  if (normalized.includes('lora') || normalized.includes('locon')) {
    return 'LoRA';
  }
  if (normalized.includes('vae')) {
    return 'VAE';
  }
  if (normalized.includes('embedding') || normalized.includes('textual inversion') || normalized.includes('textualinversion')) {
    return 'Embedding';
  }
  if (normalized.includes('control')) {
    return 'ControlNet';
  }
  if (normalized.includes('hyper')) {
    return 'Hypernetwork';
  }
  return 'Checkpoint';
}
function normalizeModelTypeFilter(value) {
  const normalized = String(value || 'all').trim().toLowerCase();
  return normalized || 'all';
}
function normalizeTaskTypeFilter(value) {
  const normalized = String(value || 'all').trim().toLowerCase();
  const aliasMap = {
    'text-to-image': 'image-generation',
    'text-to-video': 'video-generation',
    'text-to-audio': 'audio-speech',
  };
  return aliasMap[normalized] || normalized || 'all';
}
function getTaskProfile(taskType) {
  return HUGGING_FACE_TASK_PROFILES[normalizeTaskTypeFilter(taskType)] || HUGGING_FACE_TASK_PROFILES.all;
}
function getModelTypeProfile(modelType) {
  return MODEL_TYPE_PROFILES[normalizeModelTypeFilter(modelType)] || MODEL_TYPE_PROFILES.all;
}
function matchesSelectedModelType(modelType, selectedType) {
  if (!selectedType || selectedType === 'all') {
    return true;
  }
  return normalizeModelType(modelType).toLowerCase() === normalizeModelType(selectedType).toLowerCase();
}
function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
function getEffectiveHuggingFacePipelineTags(browseOptions) {
  const taskProfile = getTaskProfile(browseOptions.taskType);
  const modelTypeProfile = getModelTypeProfile(browseOptions.modelType);
  return mergeUniqueStrings([...(taskProfile.pipelineTags || []), ...(modelTypeProfile.hfPipelineTags || [])]);
}
function isRvcBrowseTarget(tool, browseOptions = {}) {
  return String(tool?.id || '').trim().toLowerCase() === 'rvc' || normalizeModelTypeFilter(browseOptions.modelType) === 'rvc-voice' || normalizeTaskTypeFilter(browseOptions.taskType) === 'voice-conversion';
}
function getDerivedSearchTerms(browseOptions) {
  const taskProfile = getTaskProfile(browseOptions.taskType);
  const modelTypeProfile = getModelTypeProfile(browseOptions.modelType);
  const userQuery = String(browseOptions.query || '').trim();
  return mergeUniqueStrings([userQuery, ...(modelTypeProfile.searchTerms || []), ...(taskProfile.searchTerms || [])]);
}
function hasRvcArtifactSearchHint(value) {
  return /(?:^|[\s.])(pth|pt|index)(?:$|[\s.])/i.test(String(value || '')) || /\.(?:pth|pt|index)\b/i.test(String(value || ''));
}
function buildRvcArtifactSearchQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) {
    return 'rvc .pth';
  }
  if (/\.(?:pth|pt)\b/i.test(raw)) {
    return raw;
  }
  if (/\bpth\b/i.test(raw)) {
    return raw.replace(/\bpth\b/ig, '.pth').replace(/\s+/g, ' ').trim();
  }
  if (/\bpt\b/i.test(raw)) {
    return raw.replace(/\bpt\b/ig, '.pt').replace(/\s+/g, ' ').trim();
  }
  return raw + ' .pth';
}
function stripRvcArtifactSearchHints(query) {
  return String(query || '')
    .replace(/\.(?:pth|pt|index)\b/ig, ' ')
    .replace(/(?:^|\s)(?:pth|pt|index)(?=$|\s)/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function buildRvcHuggingFaceApiSearchQuery(query) {
  const broadQuery = stripRvcArtifactSearchHints(query);
  return broadQuery || 'rvc';
}
function resolveHuggingFaceSearchQuery(tool, browseOptions, queryOverride = null) {
  const derivedSearchTerms = getDerivedSearchTerms(browseOptions);
  const baseQuery = queryOverride === null ? derivedSearchTerms.find(Boolean) || '' : String(queryOverride || '').trim();
  if (queryOverride !== null) {
    return baseQuery;
  }
  return isRvcBrowseTarget(tool, browseOptions) ? buildRvcHuggingFaceApiSearchQuery(baseQuery) : baseQuery;
}
function getRvcHuggingFaceFallbackQueries(browseOptions, primaryQuery) {
  if (!isRvcBrowseTarget(null, browseOptions)) {
    return [];
  }
  const userQuery = String(browseOptions.query || '').trim();
  const artifactQuery = buildRvcArtifactSearchQuery(userQuery);
  const broadUserQuery = buildRvcHuggingFaceApiSearchQuery(userQuery);
  const broadArtifactVariants = getSearchQueryVariants(artifactQuery).map(stripRvcArtifactSearchHints);
  const baseQueries = [
    primaryQuery,
    broadUserQuery,
    ...broadArtifactVariants,
    userQuery && !hasRvcArtifactSearchHint(userQuery) ? buildRvcHuggingFaceApiSearchQuery(userQuery) : '',
    'rvc',
    'rvc voice',
    artifactQuery,
    'rvc .pth',
    'rvc .pt',
  ];
  return mergeUniqueStrings(baseQueries.map((value) => String(value || '').trim()).filter(Boolean)).filter((value) => value !== primaryQuery).slice(0, 6);
}
function getCatalogRequirements(browseOptions) {
  const taskProfile = getTaskProfile(browseOptions.taskType);
  const modelTypeProfile = getModelTypeProfile(browseOptions.modelType);
  const requirements = { ...(taskProfile.catalogRequirements || {}), ...(modelTypeProfile.catalogRequirements || {}) };
  return Object.keys(requirements).length ? requirements : null;
}
function buildModelSettingsDefaults() {
  return {
    civitaiApiKey: '',
    civitaiCredentialSource: 'missing',
    civitaiEnvVarName: 'CIVITAI_API_KEY',
    hasCivitaiApiKey: false,
    hasSavedCivitaiApiKey: false,
  };
}
async function getModelSettingsPath() {
  const { root } = await ensureStorage();
  return path.join(root, MODEL_SETTINGS_FILE);
}
async function readPublicModelSettingsFile() {
  const settingsPath = await getModelSettingsPath();
  if (!(await fs.pathExists(settingsPath))) {
    return {};
  }
  try {
    const settings = await fs.readJson(settingsPath);
    return stripModelManagerSecrets(settings || {});
  } catch {
    return {};
  }
}
async function writePublicModelSettingsFile(settings) {
  const settingsPath = await getModelSettingsPath();
  const nextSettings = {
    ...stripModelManagerSecrets(settings || {}),
  };
  await fs.writeJson(settingsPath, nextSettings, { spaces: 2 });
  return nextSettings;
}
async function readModelSettingsInternal() {
  const fileSettings = await readPublicModelSettingsFile();
  const migratedLegacySecret = await migrateLegacyModelManagerSecrets(fileSettings).catch(() => false);
  if (migratedLegacySecret) {
    await writePublicModelSettingsFile(fileSettings);
  }
  const secrets = await readModelManagerSecrets();
  return {
    ...buildModelSettingsDefaults(),
    ...stripModelManagerSecrets(fileSettings),
    civitaiApiKey: secrets.civitaiApiKey || '',
    civitaiCredentialSource: secrets.civitaiCredentialSource || 'missing',
    civitaiEnvVarName: secrets.civitaiEnvVarName || 'CIVITAI_API_KEY',
    hasCivitaiApiKey: Boolean(secrets.hasCivitaiApiKey),
    hasSavedCivitaiApiKey: Boolean(secrets.hasSavedCivitaiApiKey),
  };
}
async function readModelSettings() {
  const settings = await readModelSettingsInternal();
  return {
    ...stripModelManagerSecrets(settings),
    civitaiApiKey: '',
    civitaiCredentialSource: settings.civitaiCredentialSource || 'missing',
    civitaiEnvVarName: settings.civitaiEnvVarName || 'CIVITAI_API_KEY',
    hasCivitaiApiKey: Boolean(settings.hasCivitaiApiKey),
    hasSavedCivitaiApiKey: Boolean(settings.hasSavedCivitaiApiKey),
  };
}
async function saveModelManagerSettings(patch) {
  const currentPublicSettings = await readPublicModelSettingsFile();
  const nextPatch = patch || {};
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'civitaiApiKey')) {
    await writeModelManagerSecrets({
      civitaiApiKey: nextPatch.civitaiApiKey,
    });
  }
  const nextSettings = await writePublicModelSettingsFile({
    ...currentPublicSettings,
    ...stripModelManagerSecrets(nextPatch),
  });
  const secrets = await readModelManagerSecrets();
  return {
    ...buildModelSettingsDefaults(),
    ...nextSettings,
    civitaiApiKey: '',
    civitaiCredentialSource: secrets.civitaiCredentialSource || 'missing',
    civitaiEnvVarName: secrets.civitaiEnvVarName || 'CIVITAI_API_KEY',
    hasCivitaiApiKey: Boolean(secrets.hasCivitaiApiKey),
    hasSavedCivitaiApiKey: Boolean(secrets.hasSavedCivitaiApiKey),
  };
}
function getManagedModelRoot(tool, directoryName) {
  if (!tool || !(tool.source === 'managed' || tool.managedByLocalAIHub)) {
    return null;
  }
  return path.join(getAppPaths().modelsRoot, directoryName);
}
function getSharedManagedModelRoot(directoryName) {
  return path.join(getAppPaths().modelsRoot, sanitizePathSegment(directoryName) || 'models');
}
function getOllamaModelsRoot(tool = null) {
  const managedRoot = getManagedModelRoot(tool, 'ollama');
  if (managedRoot) {
    return managedRoot;
  }
  if (process.env.OLLAMA_MODELS) {
    return process.env.OLLAMA_MODELS;
  }
  return path.join(process.env.USERPROFILE || '', '.ollama', 'models');
}
function getLmStudioModelsRoot(tool = null) {
  return getManagedModelRoot(tool, 'lmstudio') || path.join(process.env.USERPROFILE || '', '.lmstudio', 'models');
}
function resolveModelManagerBasePath(tool, targetLayout) {
  const basePath = String(targetLayout?.basePath || '').trim().toLowerCase();
  if (basePath === 'app-dir') {
    return tool?.appDir || tool?.installDir || '';
  }
  if (basePath === 'install-dir') {
    return tool?.installDir || tool?.appDir || '';
  }
  if (basePath === 'ollama-models-root') {
    return getOllamaModelsRoot(tool);
  }
  if (basePath === 'lmstudio-models-root') {
    return getLmStudioModelsRoot(tool);
  }
  if (basePath === 'managed-models-root') {
    return getSharedManagedModelRoot(targetLayout?.baseSubdirectory || tool?.id || 'models');
  }
  return '';
}
function buildModelDirectoriesFromTargetLayout(tool, targetLayout) {
  const baseRoot = resolveModelManagerBasePath(tool, targetLayout);
  if (!baseRoot) {
    return {};
  }
  const directoryEntries = Object.entries(targetLayout?.directories || {}).filter(([modelType]) => Boolean(modelType));
  return Object.fromEntries(
    directoryEntries.map(([modelType, relativePath]) => {
      const segments = splitRelativePathSegments(relativePath);
      return [modelType, segments.length ? path.join(baseRoot, ...segments) : baseRoot];
    }),
  );
}
function normalizeBrowseOptions(options = {}, tool) {
  const defaults = getModelManagerDefaults(tool);
  const sourceOptions = getModelManagerSourceOptions(tool);
  const sourceIds = sourceOptions.map((entry) => entry.id);
  const allowedModelTypes = getAllowedModelManagerValues(getModelManagerConfig(tool)?.allowedModelTypes);
  const allowedTaskTypes = getAllowedModelManagerValues(getModelManagerConfig(tool)?.allowedTaskTypes);
  const sort = String(options.sort || 'most-downloaded').trim().toLowerCase();
  const defaultSource = sourceIds.includes(defaults.source) ? defaults.source : sourceIds[0] || defaults.source || 'huggingface';
  const defaultModelType = coerceAllowedValue(defaults.modelType, allowedModelTypes, defaults.modelType);
  const defaultTaskType = coerceAllowedValue(defaults.taskType, allowedTaskTypes, defaults.taskType);
  const requestedSource = String(options.source || defaultSource).trim();
  return {
    cursor: String(options.cursor || '').trim() || null,
    limit: Number(options.limit) > 0 ? Math.min(REMOTE_PAGE_SIZE, Number(options.limit)) : REMOTE_PAGE_SIZE,
    modelType: coerceAllowedValue(normalizeModelTypeFilter(options.modelType || defaultModelType), allowedModelTypes, defaultModelType),
    page: Math.max(1, Number(options.page) || 1),
    query: String(options.query || '').trim(),
    sort: HF_SORT_MAP[sort] || CIVITAI_SORT_MAP[sort] ? sort : 'most-downloaded',
    source: sourceIds.length && sourceIds.includes(requestedSource) ? requestedSource : defaultSource,
    taskType: coerceAllowedValue(normalizeTaskTypeFilter(options.taskType || defaultTaskType), allowedTaskTypes, defaultTaskType),
  };
}
async function loadHardwareContext() {
  const config = await readConfig();
  let hardware = config.hardware;
  if (!hardware || !Array.isArray(hardware.disks) || hardware.disks.length === 0) {
    hardware = await detectHardwareSnapshot();
    await saveHardwareDetection(hardware).catch(() => null);
  }
  const liveDisks = await detectStorageSnapshot().catch(() => hardware?.disks || []);
  return {
    disks: liveDisks?.length ? liveDisks : hardware?.disks || [],
    hardware,
  };
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[unitIndex]}`;
}
function buildDiskWarning(sizeBytes, disk) {
  if (!disk) {
    return null;
  }
  const preflight = assessDiskSpace(disk, sizeBytes);
  if (preflight.blocked) {
    return {
      tone: 'danger',
      message: `This download needs ${formatBytes(preflight.requiredBytes)}, but only ${formatBytes(preflight.availableBytes)} is free on ${preflight.mount}.`,
    };
  }
  if (preflight.requiresConfirmation) {
    return {
      tone: 'warn',
      message: preflight.sizeKnown
        ? `This download would leave less than 10% free on ${preflight.mount}.`
        : `${preflight.mount} is already below 10% free space.`,
    };
  }
  return {
    tone: 'good',
    message: `${preflight.mount} has enough free space for this download.`,
  };
}
function getHardwareRamMb(hardware) {
  for (const candidate of [hardware?.ramMb, hardware?.systemRamMb, hardware?.memoryMb, hardware?.totalRamMb]) {
    const ramMb = Number(candidate || 0);
    if (Number.isFinite(ramMb) && ramMb > 0) {
      return ramMb;
    }
  }
  return 0;
}
function bytesToMb(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024) : 0;
}
function inferRuntimeModelFamily(item = {}) {
  const text = [
    item.name,
    item.fileName,
    item.installRelativePath,
    item.catalogContext,
    item.catalogRepositoryId,
    item.description,
    item.modelType,
    item.source,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (normalizeModelType(item.modelType).toLowerCase() === 'gguf' || /\.gguf\b/i.test(text)) {
    return 'gguf';
  }
  if (/wan\d|cogvideo|mochi|ltx[-_\s]?video|video generation|image to video|text to video/.test(text)) {
    return 'video';
  }
  if (/flux|stable[-_\s]?diffusion[-_\s]?3|\bsd3\b/.test(text)) {
    return 'flux-sd3';
  }
  if (/pony|sdxl|stable[-_\s]?diffusion[-_\s]?xl|\bxl[-_\s]?(base|refiner)?\b/.test(text)) {
    return 'sdxl';
  }
  if (/sd[-_\s]?1\.?5|stable[-_\s]?diffusion[-_\s]?v?1[-_\s]?5|\bv1[-_\s]?5\b|1[-_\s]?5[-_\s]?pruned/.test(text)) {
    return 'sd15';
  }
  if (/lora|vae|controlnet|upscaler|embedding|hypernetwork/.test(text)) {
    return 'accessory';
  }
  if (/audio|speech|musicgen|bark|whisper|rvc|voice conversion/.test(text)) {
    return 'audio';
  }
  const sizeMb = bytesToMb(Number(item.sizeBytes || 0));
  if (normalizeModelType(item.modelType) === 'Checkpoint') {
    return sizeMb >= 6144 ? 'sdxl' : 'sd15';
  }
  return 'unknown';
}
function imageRuntimeProfile(item, tool) {
  const family = inferRuntimeModelFamily(item);
  const toolId = String(tool?.id || '').toLowerCase();
  if (family === 'video') {
    return { minimumMb: 16 * 1024, recommendedMb: 24 * 1024, label: 'video model' };
  }
  if (family === 'flux-sd3') {
    return { minimumMb: toolId === 'forge' ? 10 * 1024 : 12 * 1024, recommendedMb: 16 * 1024, label: 'Flux / SD3-class model' };
  }
  if (family === 'sdxl') {
    return {
      minimumMb: toolId === 'forge' || toolId === 'comfyui' ? 6 * 1024 : 8 * 1024,
      recommendedMb: toolId === 'forge' ? 10 * 1024 : 12 * 1024,
      label: 'SDXL / Pony XL-class model',
    };
  }
  if (family === 'sd15') {
    return {
      minimumMb: toolId === 'automatic1111' ? 5 * 1024 : 4 * 1024,
      recommendedMb: toolId === 'automatic1111' ? 6 * 1024 : 5 * 1024,
      label: 'SD 1.5-class model',
    };
  }
  if (family === 'accessory') {
    return { minimumMb: 0, recommendedMb: 0, label: 'support model' };
  }
  if (family === 'audio') {
    return { minimumMb: 6 * 1024, recommendedMb: 8 * 1024, label: 'audio model' };
  }
  return null;
}
function buildHardwareFit(itemOrSizeBytes, toolOrHardware, hardwareOrRequirements = null, maybeRequirements = null) {
  const item = typeof itemOrSizeBytes === 'object' && itemOrSizeBytes !== null ? itemOrSizeBytes : { sizeBytes: Number(itemOrSizeBytes || 0) };
  const tool = typeof itemOrSizeBytes === 'object' && itemOrSizeBytes !== null ? toolOrHardware : null;
  const hardware = typeof itemOrSizeBytes === 'object' && itemOrSizeBytes !== null ? hardwareOrRequirements : toolOrHardware;
  const requirements = typeof itemOrSizeBytes === 'object' && itemOrSizeBytes !== null ? maybeRequirements : hardwareOrRequirements;
  if (item?.downloadPlan?.runnable === false) {
    return {
      label: 'Incompatible',
      tone: 'danger',
      message: item.downloadPlan.blockingReason || 'This catalog item is not compatible with the selected target.',
    };
  }
  const sizeBytes = Number(item?.sizeBytes || 0);
  const vramMb = Number(hardware?.vramMb || 0);
  const ramMb = getHardwareRamMb(hardware);
  const minimumVramMb = Number(requirements?.minimumVramMb || 0);
  if (minimumVramMb > 0 && vramMb > 0 && vramMb < minimumVramMb) {
    return {
      label: 'Not recommended',
      tone: 'danger',
      message: requirements?.warningMessage || 'This model needs more GPU memory than Local AI Hub detected on this PC.',
    };
  }
  const family = inferRuntimeModelFamily(item);
  if (family === 'gguf') {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return {
        label: 'Unknown',
        tone: 'neutral',
        message: 'Local AI Hub could not estimate this GGUF file size yet.',
      };
    }
    const fileMb = bytesToMb(sizeBytes);
    const comfortableGpuMb = fileMb + 1536;
    const minimumRamMb = fileMb + 2048;
    if (vramMb > 0 && vramMb >= comfortableGpuMb) {
      return {
        label: 'Recommended',
        tone: 'good',
        message: `This GGUF is about ${formatBytes(sizeBytes)} and should fit with GPU offload overhead on this PC.`,
      };
    }
    if (ramMb > 0 && ramMb >= minimumRamMb) {
      return {
        label: 'Possible / may be slow',
        tone: 'warn',
        message: `This GGUF is about ${formatBytes(sizeBytes)}. It may need CPU/RAM offload because detected VRAM is below the file size plus runtime overhead.`,
      };
    }
    return {
      label: 'Not recommended',
      tone: 'danger',
      message: `This GGUF is about ${formatBytes(sizeBytes)} and likely needs more RAM or VRAM headroom than Local AI Hub detected.`,
    };
  }
  const runtimeProfile = imageRuntimeProfile(item, tool);
  if (runtimeProfile?.label === 'support model') {
    return {
      label: 'Unknown',
      tone: 'neutral',
      message: 'This support model depends on the base checkpoint and workflow loaded with it.',
    };
  }
  if (runtimeProfile && vramMb > 0) {
    if (vramMb >= runtimeProfile.recommendedMb) {
      return {
        label: 'Recommended',
        tone: 'good',
        message: `This looks like a ${runtimeProfile.label}; detected VRAM meets the recommended range for this target.`,
      };
    }
    if (vramMb >= runtimeProfile.minimumMb) {
      return {
        label: 'Possible / may be slow',
        tone: 'warn',
        message: `This looks like a ${runtimeProfile.label}. It may run with low-VRAM settings, but it is below the recommended VRAM range for this target.`,
      };
    }
    return {
      label: 'Not recommended',
      tone: 'danger',
      message: `This looks like a ${runtimeProfile.label} and likely needs more VRAM than Local AI Hub detected for this target.`,
    };
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || vramMb <= 0) {
    return {
      label: 'Unknown',
      tone: 'neutral',
      message: 'Local AI Hub could not compare this model to your GPU memory yet.',
    };
  }
  const availableVramBytes = vramMb * 1024 * 1024;
  if (sizeBytes <= availableVramBytes * 0.55) {
    return {
      label: 'Recommended',
      tone: 'good',
      message: 'This model leaves reasonable room for runtime overhead in your detected GPU memory.',
    };
  }
  if (sizeBytes <= availableVramBytes * 0.85) {
    return {
      label: 'Possible / may be slow',
      tone: 'warn',
      message: 'This model is close to your practical VRAM limit after runtime overhead.',
    };
  }
  return {
    label: 'Not recommended',
    tone: 'danger',
    message: 'This model is likely too large once runtime overhead is included.',
  };
}
function attachHardwareHints(item, tool, hardwareContext) {
  const targetDirectory = getTargetDirectory(tool, item.modelType, item);
  const disk = findDiskForPath(hardwareContext.disks, targetDirectory || tool.installDir || tool.appDir || getOllamaModelsRoot(tool));
  const requirements = item.catalogRequirements || null;
  return {
    ...item,
    diskWarning: buildDiskWarning(item.sizeBytes, disk),
    downloadTarget: targetDirectory,
    hardwareFit: buildHardwareFit(item, tool, hardwareContext.hardware, requirements),
    targetToolId: tool?.id || item.toolId || null,
    targetToolName: tool?.name || item.toolName || null,
    targetDisk: disk
      ? {
          freeBytes: disk.freeBytes,
          mount: disk.mount,
          sizeBytes: disk.sizeBytes,
        }
      : null,
  };
}
function serializeDownloadPlan(plan, targetDirectory = null) {
  if (!plan) {
    return null;
  }
  return {
    artifactLabel: plan.artifactLabel || null,
    blockingReason: plan.blockingReason || null,
    compatibleArtifacts: plan.compatibleArtifacts || [],
    downloadFiles: plan.downloadFiles || [],
    installStrategy: plan.installStrategy || null,
    modelType: plan.modelType || null,
    optionalArtifacts: plan.optionalArtifacts || [],
    packageIdentity: plan.packageIdentity || null,
    packageName: plan.packageName || null,
    packageRoot: plan.packageRoot || null,
    packageTargetMode: plan.packageTargetMode || null,
    planType: plan.planType || null,
    recommendedArtifactPath: plan.recommendedArtifactPath || null,
    rejectedArtifacts: plan.rejectedArtifacts || [],
    requiredArtifacts: plan.requiredArtifacts || [],
    requiredFiles: plan.requiredFiles || [],
    sizeBytes: Number(plan.sizeBytes || 0) || null,
    runnable: Boolean(plan.runnable),
    targetDirectory,
    warning: plan.warning || null,
  };
}
function attachDownloadPlanFields(item, plan, targetDirectory = null) {
  return {
    ...item,
    artifactKind: item.artifactKind || plan?.recommendedArtifact?.artifactKind || null,
    artifactLabel: item.artifactLabel || plan?.artifactLabel || item.modelType,
    compatibilityMessage: plan?.blockingReason || plan?.warning || null,
    downloadPlan: serializeDownloadPlan(plan, targetDirectory),
  };
}
function getToolModelDirectories(tool) {
  const targetLayout = getModelManagerTargetLayout(tool);
  if (targetLayout) {
    return buildModelDirectoriesFromTargetLayout(tool, targetLayout);
  }
  const appDir = tool?.appDir || tool?.installDir || '';
  if (tool?.id === 'rvc' && appDir) {
    return {
      'Audio / Speech': path.join(appDir, 'weights'),
    };
  }
  return {};
}
function sanitizePathSegment(value) {
  const sanitized = String(value || '')
    .replace(/[<>:"|?*]/g, '-')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return '';
  }
  return sanitized;
}
function splitRelativePathSegments(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .map((segment) => sanitizePathSegment(segment))
    .filter(Boolean);
}
function normalizeRelativeInstallPath(value) {
  const segments = splitRelativePathSegments(value);
  return segments.length ? path.join(...segments) : '';
}
function getCatalogRepositoryId(item = null) {
  const repositoryId = String(item?.catalogRepositoryId || '').trim();
  return repositoryId || null;
}
function getTargetDirectory(tool, modelType, item = null) {
  const directories = getToolModelDirectories(tool);
  const normalizedType = normalizeModelType(modelType);
  const targetDirectory = directories[normalizedType] || directories.Checkpoint || directories.Model || null;
  const targetLayout = getModelManagerTargetLayout(tool);
  if (targetDirectory && targetLayout?.repositoryScoped) {
    const repositorySegments = splitRelativePathSegments(getCatalogRepositoryId(item) || String(item?.name || ''));
    if (repositorySegments.length >= 2) {
      return path.join(targetDirectory, repositorySegments[0], repositorySegments[1]);
    }
  }
  return targetDirectory;
}
function resolveModelDestination(tool, payload = {}) {
  const targetDirectory = getTargetDirectory(tool, payload.modelType, payload);
  if (!targetDirectory) {
    throw new Error(`Local AI Hub could not determine where ${tool.name} stores ${payload.modelType || 'model'} files.`);
  }
  const installRelativePath = normalizeRelativeInstallPath(payload.installRelativePath || payload.fileName || payload.name || 'model.safetensors');
  const destinationPath = path.join(targetDirectory, installRelativePath || 'model.safetensors');
  if (!isSafeChildPath(targetDirectory, destinationPath)) {
    throw new Error('Local AI Hub refused to save a model outside the approved model folder.');
  }
  return {
    destinationPath,
    fileName: path.basename(destinationPath),
    installRelativePath: installRelativePath || path.basename(destinationPath),
    targetDirectory,
  };
}
function isSafeChildPath(parentPath, candidatePath) {
  const normalizedParent = path.resolve(parentPath || '');
  const normalizedCandidate = path.resolve(candidatePath || '');
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}
function normalizePathForId(value) {
  return String(value || '').replace(/[\\/]+/g, ':');
}
function getModelMetadataPath(modelPath) {
  return modelPath ? `${modelPath}.localaihub.json` : '';
}
function getPackageMetadataPath(packageRootPath, packageName = '') {
  if (!packageRootPath) {
    return '';
  }
  const safePackageName = sanitizePathSegment(packageName);
  return safePackageName ? path.join(packageRootPath, safePackageName + PACKAGE_METADATA_SUFFIX) : path.join(packageRootPath, PACKAGE_METADATA_FILE);
}
function isPackageDownloadPayload(payload = {}) {
  const plan = payload?.downloadPlan || {};
  if (plan.planType === 'package') {
    return true;
  }
  return Array.isArray(plan.downloadFiles) && plan.downloadFiles.length > 0;
}
function normalizeIdentityPart(value) {
  return normalizeLookupKey(value).replace(/\|/g, '%7c');
}
function buildSourceDownloadIdentity(item = {}) {
  const source = normalizeIdentityPart(item.source);
  const toolId = normalizeIdentityPart(item.toolId);
  if (!source || !toolId) {
    return null;
  }
  if (source === 'ollama') {
    const tag = normalizeIdentityPart(item.name || item.fileName || item.downloadPlan?.recommendedArtifactPath);
    return tag ? `${source}|${toolId}|tag:${tag}` : null;
  }
  const artifactPath = normalizeIdentityPart(
    item.packageIdentity ||
      item.downloadPlan?.packageIdentity ||
      item.sourceArtifactPath ||
      item.downloadPlan?.recommendedArtifactPath ||
      item.installRelativePath ||
      item.fileName,
  );
  if (!artifactPath) {
    return null;
  }
  if (source === 'huggingface' || source === 'tabby') {
    const repositoryId = normalizeIdentityPart(item.catalogRepositoryId || item.name);
    return repositoryId ? `${source}|${toolId}|repo:${repositoryId}|artifact:${artifactPath}` : null;
  }
  if (source === 'civitai') {
    const modelId = normalizeIdentityPart(item.catalogModelId || item.catalogRepositoryId || item.name);
    const versionId = normalizeIdentityPart(item.catalogVersionId || item.catalogVersionLabel || 'unknown-version');
    const fileId = normalizeIdentityPart(item.sourceFileId || artifactPath);
    return modelId ? `${source}|${toolId}|model:${modelId}|version:${versionId}|artifact:${fileId}` : null;
  }
  const repositoryId = normalizeIdentityPart(item.catalogRepositoryId || item.name || 'unknown-source');
  return `${source}|${toolId}|source:${repositoryId}|artifact:${artifactPath}`;
}
function buildExpectedDownloadIdentity(tool, payload, destination = {}) {
  return buildSourceDownloadIdentity({
    ...payload,
    fileName: destination.fileName || payload.fileName,
    installRelativePath: destination.installRelativePath || payload.installRelativePath,
    toolId: tool?.id || payload.toolId,
  });
}
function buildDownloadMetadata(tool, payload, destination = {}) {
  const identityPayload = {
    ...payload,
    fileName: destination.fileName || payload.fileName,
    installRelativePath: destination.installRelativePath || payload.installRelativePath,
    toolId: tool?.id || payload.toolId,
  };
  return {
    schemaVersion: 1,
    downloadedAt: new Date().toISOString(),
    downloadIdentity: buildSourceDownloadIdentity(identityPayload),
    source: payload.source || null,
    toolId: tool?.id || payload.toolId || null,
    catalogEntityType: payload.catalogEntityType || null,
    catalogRepositoryId: payload.catalogRepositoryId || null,
    catalogModelId: payload.catalogModelId || null,
    catalogVersionId: payload.catalogVersionId || null,
    catalogVersionLabel: payload.catalogVersionLabel || null,
    packageIdentity: payload.packageIdentity || payload.downloadPlan?.packageIdentity || null,
    packageName: payload.packageName || payload.downloadPlan?.packageName || null,
    packageRoot: payload.packageRoot || payload.downloadPlan?.packageRoot || null,
    planType: payload.downloadPlan?.planType || 'single-file',
    sourceArtifactPath: payload.sourceArtifactPath || payload.downloadPlan?.recommendedArtifactPath || payload.installRelativePath || payload.fileName || null,
    sourceFileId: payload.sourceFileId || null,
    installRelativePath: destination.installRelativePath || payload.installRelativePath || null,
    fileName: destination.fileName || payload.fileName || null,
    modelType: payload.modelType || null,
    sizeBytes: Number(payload.sizeBytes || payload.downloadPlan?.sizeBytes || 0) || null,
    downloadUrl: payload.downloadUrl || null,
  };
}
async function readModelMetadata(modelPath) {
  const metadataPath = getModelMetadataPath(modelPath);
  if (!metadataPath || !(await fs.pathExists(metadataPath))) {
    return null;
  }
  const metadata = await fs.readJson(metadataPath).catch(() => null);
  return metadata && typeof metadata === 'object' ? metadata : null;
}
async function writeModelMetadata(modelPath, metadata) {
  const metadataPath = getModelMetadataPath(modelPath);
  if (!metadataPath || !metadata?.downloadIdentity) {
    return null;
  }
  await fs.writeJson(metadataPath, metadata, { spaces: 2 });
  return metadata;
}
async function readPackageMetadata(manifestPath) {
  const metadata = await fs.readJson(manifestPath).catch(() => null);
  return metadata && typeof metadata === 'object' && metadata.downloadIdentity ? metadata : null;
}
async function writePackageMetadata(manifestPath, metadata) {
  if (!manifestPath || !metadata?.downloadIdentity) {
    return null;
  }
  await fs.ensureDir(path.dirname(manifestPath));
  await fs.writeJson(manifestPath, metadata, { spaces: 2 });
  return metadata;
}
function isPackageManifestPath(filePath) {
  return path.basename(String(filePath || '')).toLowerCase().endsWith(PACKAGE_METADATA_SUFFIX);
}
function packageInstalledRelativeFiles(metadata = {}) {
  return (metadata.installedFiles || metadata.downloadFiles || [])
    .map((entry) => String(entry.installRelativePath || entry.path || entry.fileName || '').trim())
    .filter(Boolean);
}
async function buildLocalPackageModel(tool, modelType, directory, manifestPath) {
  const metadata = await readPackageMetadata(manifestPath);
  if (!metadata) {
    return null;
  }
  const packageRoot = path.resolve(String(metadata.packageRootPath || path.dirname(manifestPath)).trim());
  const installedRelativeFiles = packageInstalledRelativeFiles(metadata);
  const existingFiles = [];
  for (const relativeFile of installedRelativeFiles) {
    const candidate = path.join(packageRoot, normalizeRelativeInstallPath(relativeFile));
    if (await fs.pathExists(candidate)) {
      existingFiles.push(candidate);
    }
  }
  if (!existingFiles.length) {
    return null;
  }
  const sizeBytes = (await Promise.all(existingFiles.map((filePath) => fs.stat(filePath).catch(() => null))))
    .filter(Boolean)
    .reduce((total, stat) => total + Number(stat.size || 0), 0);
  const relativePath = path.relative(directory, packageRoot) || metadata.packageName || metadata.packageRoot || '';
  return {
    id: tool.id + ':' + modelType + ':package:' + normalizePathForId(metadata.packageIdentity || relativePath || metadata.packageName),
    downloaded: true,
    downloadIdentity: metadata.downloadIdentity,
    fileName: metadata.packageName || path.basename(packageRoot),
    metadata,
    modelType: metadata.modelType || modelType,
    name: metadata.packageName || path.basename(packageRoot),
    packageIdentity: metadata.packageIdentity || null,
    packageManifestPath: manifestPath,
    packageRootPath: packageRoot,
    path: packageRoot,
    relativePath,
    sizeBytes,
    source: 'local',
    sourceArtifactPath: metadata.sourceArtifactPath || null,
    sourceCatalogRepositoryId: metadata.catalogRepositoryId || null,
    sourceCatalogModelId: metadata.catalogModelId || null,
    sourceName: metadata.source || 'local',
    toolId: tool.id,
  };
}
function normalizePhysicalPathKey(value) {
  const resolved = path.resolve(String(value || '').trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function uniqueNormalizedModelTypes(values = []) {
  const seen = new Set();
  const types = [];
  for (const value of values || []) {
    const type = normalizeModelType(value);
    const key = type.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    types.push(type);
  }
  return types;
}
function getUniqueModelDirectoryGroups(directories = {}) {
  const groups = new Map();
  for (const [modelType, directory] of Object.entries(directories || {})) {
    const resolvedDirectory = path.resolve(String(directory || '').trim());
    if (!resolvedDirectory) {
      continue;
    }
    const key = normalizePhysicalPathKey(resolvedDirectory);
    const group = groups.get(key) || { directory: resolvedDirectory, modelTypes: [] };
    group.modelTypes = uniqueNormalizedModelTypes([...group.modelTypes, modelType]);
    groups.set(key, group);
  }
  return [...groups.values()];
}
function localPathHasTypeEvidence(modelType, value) {
  const normalized = String(value || '').replace(/\\+/g, '/').toLowerCase();
  if (!normalized) {
    return false;
  }
  if (modelType === 'Inpainting') return /(^|[\/_.\s-])inpaint(?:ing)?([\/_.\s-]|$)/i.test(normalized);
  if (modelType === 'LoRA') return /(^|[\/_.\s-])(?:lora|locon|lycoris)([\/_.\s-]|$)/i.test(normalized);
  if (modelType === 'VAE') return /(^|[\/_.\s-])vae([\/_.\s-]|$)/i.test(normalized);
  if (modelType === 'ControlNet') return /(^|[\/_.\s-])control(?:net)?([\/_.\s-]|$)/i.test(normalized);
  if (modelType === 'Embedding') return /(^|[\/_.\s-])(?:embedding|embeddings|textual[_\s-]?inversion)([\/_.\s-]|$)/i.test(normalized);
  if (modelType === 'Hypernetwork') return /(^|[\/_.\s-])hyper(?:network)?([\/_.\s-]|$)/i.test(normalized);
  if (modelType === 'Upscaler') return /(^|[\/_.\s-])(?:upscaler|upscale|esrgan|realesrgan)([\/_.\s-]|$)/i.test(normalized) || /\.(?:param|bin)$/i.test(normalized);
  if (modelType === 'GGUF') return /\.gguf$/i.test(normalized);
  if (modelType === 'RVC Voice Model') return /(^|[\/_.\s-])(?:rvc|voice)([\/_.\s-]|$)/i.test(normalized) || /\.(?:pth|pt)$/i.test(normalized);
  if (modelType === 'Audio / Speech') return /(^|[\/_.\s-])(?:audio|speech|musicgen|audiogen|bark)([\/_.\s-]|$)/i.test(normalized);
  if (modelType === 'Video') return /(^|[\/_.\s-])(?:video|wan2\.1|wan-ai)([\/_.\s-]|$)/i.test(normalized);
  return false;
}
function inferLocalFileModelType(tool, fullPath, directory, modelTypes = [], metadata = null) {
  const allowedTypes = uniqueNormalizedModelTypes(modelTypes);
  const metadataType = metadata?.modelType ? normalizeModelType(metadata.modelType) : '';
  if (metadataType && (!allowedTypes.length || allowedTypes.some((type) => type.toLowerCase() === metadataType.toLowerCase()))) {
    return metadataType;
  }
  const relativePath = path.relative(directory, fullPath);
  const context = [relativePath, metadata?.sourceArtifactPath, metadata?.installRelativePath, metadata?.fileName]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  for (const type of allowedTypes) {
    if (type === 'Checkpoint') {
      continue;
    }
    if (localPathHasTypeEvidence(type, context)) {
      return type;
    }
  }
  if (allowedTypes.length === 1) {
    return allowedTypes[0];
  }
  if (allowedTypes.includes('Checkpoint')) {
    return 'Checkpoint';
  }
  if (allowedTypes.includes('Model')) {
    return 'Model';
  }
  if (allowedTypes.includes('GGUF')) {
    return 'GGUF';
  }
  return allowedTypes[0] || normalizeModelType(path.basename(fullPath));
}
async function listLocalFileModels(tool, options = {}) {
  throwIfSignalAborted(options.signal);
  const directoryGroups = getUniqueModelDirectoryGroups(getToolModelDirectories(tool));
  const localModels = [];
  for (const group of directoryGroups) {
    throwIfSignalAborted(options.signal);
    const directory = group.directory;
    if (!(await fs.pathExists(directory))) {
      continue;
    }
    const files = await walkDirectoryFiles(directory, options);
    const packageManifestPaths = files.filter(isPackageManifestPath);
    const packageFilePaths = new Set();
    const packageRootPaths = new Set();
    const fallbackPackageType = group.modelTypes.includes('Checkpoint') ? 'Checkpoint' : group.modelTypes[0] || 'Checkpoint';
    for (const manifestPath of packageManifestPaths) {
      throwIfSignalAborted(options.signal);
      const packageModel = await buildLocalPackageModel(tool, fallbackPackageType, directory, manifestPath);
      if (!packageModel) {
        continue;
      }
      localModels.push(packageModel);
      const packageRoot = path.resolve(packageModel.packageRootPath || packageModel.path || '');
      if (path.basename(manifestPath) === PACKAGE_METADATA_FILE) {
        packageRootPaths.add(packageRoot);
      }
      for (const relativeFile of packageInstalledRelativeFiles(packageModel.metadata)) {
        packageFilePaths.add(path.resolve(path.join(packageRoot, normalizeRelativeInstallPath(relativeFile))));
      }
    }
    for (const fullPath of files) {
      throwIfSignalAborted(options.signal);
      if (isPackageManifestPath(fullPath)) {
        continue;
      }
      const resolvedFullPath = path.resolve(fullPath);
      if (packageFilePaths.has(resolvedFullPath)) {
        continue;
      }
      if ([...packageRootPaths].some((packageRoot) => isSafeChildPath(packageRoot, resolvedFullPath))) {
        continue;
      }
      if (!MODEL_FILE_PATTERN.test(path.basename(fullPath))) {
        continue;
      }
      const stats = await fs.stat(fullPath);
      const metadata = await readModelMetadata(fullPath);
      const modelType = inferLocalFileModelType(tool, fullPath, directory, group.modelTypes, metadata);
      localModels.push({
        id: tool.id + ':' + modelType + ':' + normalizePathForId(path.relative(directory, fullPath)),
        downloaded: true,
        downloadIdentity: metadata?.downloadIdentity || null,
        fileName: path.basename(fullPath),
        metadata: metadata || null,
        modelType,
        name: path.parse(path.basename(fullPath)).name,
        path: fullPath,
        relativePath: path.relative(directory, fullPath),
        sizeBytes: stats.size,
        source: 'local',
        sourceArtifactPath: metadata?.sourceArtifactPath || null,
        sourceCatalogRepositoryId: metadata?.catalogRepositoryId || null,
        sourceCatalogModelId: metadata?.catalogModelId || null,
        sourceName: metadata?.source || 'local',
        toolId: tool.id,
      });
    }
  }
  return localModels.sort((left, right) => left.name.localeCompare(right.name));
}
async function walkDirectoryFiles(directory, options = {}) {
  throwIfSignalAborted(options.signal);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    throwIfSignalAborted(options.signal);
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDirectoryFiles(fullPath, options)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}function normalizeRvcCompanionToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function compactRvcCompanionToken(value) {
  return normalizeRvcCompanionToken(value).replace(/\s+/g, '');
}

function getRvcModelStem(model = {}) {
  const fileName = String(model.fileName || path.basename(model.path || model.relativePath || '') || '').trim();
  const extension = path.extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

function getRvcCompanionPathTokens(indexEntry = {}) {
  const relativePath = String(indexEntry.relativePath || indexEntry.path || '').replace(/\\+/g, '/');
  const segments = relativePath.split('/').filter(Boolean);
  const fileName = path.basename(relativePath);
  const withoutIndex = fileName.replace(/\.index$/i, '');
  return [...segments.slice(0, -1), withoutIndex]
    .map((entry) => ({ compact: compactRvcCompanionToken(entry), normalized: normalizeRvcCompanionToken(entry) }))
    .filter((entry) => entry.compact);
}

function rvcIndexMatchesModel(indexEntry, model, modelCount, indexCount) {
  const primaryCompact = compactRvcCompanionToken(getRvcModelStem(model));
  if (primaryCompact.length >= 3 && !['model', 'pytorchmodel', 'weight', 'weights'].includes(primaryCompact)) {
    if (getRvcCompanionPathTokens(indexEntry).some((token) => token.compact.includes(primaryCompact) || primaryCompact.includes(token.compact))) {
      return true;
    }
  }
  return modelCount === 1 && indexCount === 1;
}

async function listRvcIndexCompanionFiles(tool) {
  const rawAppRoot = String(tool?.appDir || tool?.installDir || '').trim();
  if (!rawAppRoot) {
    return [];
  }
  const appRoot = path.resolve(rawAppRoot);
  const logsRoot = path.join(appRoot, 'logs');
  if (!(await fs.pathExists(logsRoot))) {
    return [];
  }
  const files = await walkDirectoryFiles(logsRoot);
  const companions = [];
  for (const fullPath of files) {
    if (!RVC_INDEX_FILE_PATTERN.test(path.basename(fullPath))) {
      continue;
    }
    const stats = await fs.stat(fullPath).catch(() => null);
    const relativePath = path.relative(appRoot, fullPath);
    companions.push({
      fileName: path.basename(fullPath),
      logsRelativePath: path.relative(logsRoot, fullPath),
      path: fullPath,
      relativePath,
      sizeBytes: Number(stats?.size || 0) || 0,
    });
  }
  return companions.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function attachRvcIndexCompanionMetadata(tool, models = []) {
  const voiceModels = getRvcVoiceModels(models);
  if (!voiceModels.length) {
    return [];
  }
  const indexFiles = await listRvcIndexCompanionFiles(tool);
  if (!indexFiles.length) {
    return voiceModels;
  }
  return voiceModels.map((model) => {
    const matches = indexFiles.filter((indexEntry) => rvcIndexMatchesModel(indexEntry, model, voiceModels.length, indexFiles.length));
    if (matches.length !== 1) {
      return {
        ...model,
        indexCandidateCount: matches.length || indexFiles.length,
      };
    }
    const companion = matches[0];
    return {
      ...model,
      indexCandidateCount: 1,
      indexFileName: companion.fileName,
      indexPath: companion.path,
      indexRelativePath: companion.relativePath,
      indexSizeBytes: companion.sizeBytes,
    };
  });
}
function buildOllamaModelNameFromManifestPath(relativePath) {
  const parts = String(relativePath || '')
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return '';
  }
  const tag = parts.pop();
  let modelParts = parts;
  if (modelParts[0] === 'registry.ollama.ai') {
    modelParts = modelParts.slice(1);
  }
  if (modelParts[0] === 'library') {
    modelParts = modelParts.slice(1);
  }
  const modelName = modelParts.join('/');
  return modelName ? modelName + ':' + tag : tag;
}
function sumOllamaManifestSize(manifest = {}) {
  return [...(manifest.layers || []), manifest.config]
    .filter(Boolean)
    .reduce((total, entry) => total + (Number(entry.size || 0) || 0), 0);
}
async function listLocalOllamaModelsFromFilesystem(tool, options = {}) {
  throwIfSignalAborted(options.signal);
  const manifestsRoot = path.join(getOllamaModelsRoot(tool), 'manifests');
  if (!(await fs.pathExists(manifestsRoot))) {
    return [];
  }
  const manifestFiles = await walkDirectoryFiles(manifestsRoot, options);
  const models = await Promise.all(
    manifestFiles.map(async (manifestPath) => {
      throwIfSignalAborted(options.signal);
      const relativePath = path.relative(manifestsRoot, manifestPath);
      const name = buildOllamaModelNameFromManifestPath(relativePath);
      if (!name) {
        return null;
      }
      const [manifest, stats] = await Promise.all([
        fs.readJson(manifestPath).catch(() => null),
        fs.stat(manifestPath).catch(() => null),
      ]);
      return {
        id: 'ollama:' + name,
        downloaded: true,
        fileName: name,
        modelType: 'Model',
        name,
        path: name,
        sizeBytes: sumOllamaManifestSize(manifest || {}),
        source: 'ollama',
        toolId: tool.id,
        modifiedAt: stats?.mtime?.toISOString() || null,
      };
    }),
  );
  const uniqueModels = new Map();
  for (const model of models.filter(Boolean)) {
    uniqueModels.set(model.name, model);
  }
  return [...uniqueModels.values()].sort((left, right) => left.name.localeCompare(right.name));
}
async function listLocalOllamaModels(tool, options = {}) {
  throwIfSignalAborted(options.signal);
  if (String(tool?.status || '').trim().toLowerCase() !== 'running') {
    return listLocalOllamaModelsFromFilesystem(tool, options);
  }

  try {
    const response = await listOllamaModels(tool);
    throwIfSignalAborted(options.signal);
    return (response.models || []).map((model) => ({
      id: 'ollama:' + model.name,
      downloaded: true,
      fileName: model.name,
      modelType: 'Model',
      name: model.name,
      path: model.name,
      sizeBytes: Number(model.size || 0),
      source: 'ollama',
      toolId: tool.id,
      modifiedAt: model.modifiedAt,
    }));
  } catch {
    return listLocalOllamaModelsFromFilesystem(tool, options);
  }
}
async function listDownloadedModels(tool, options = {}) {
  throwIfSignalAborted(options.signal);
  let models = [];
  if (tool?.id === 'rvc') {
    models = attachRvcIndexCompanionMetadata(tool, await listLocalFileModels(tool, options));
  } else if (!supportsModelManager(tool)) {
    models = [];
  } else if (tool.id === 'ollama') {
    models = await listLocalOllamaModels(tool, options);
  } else if (tool.id === 'invokeai') {
    models = await listInvokeAiModels(tool);
  } else {
    models = await listLocalFileModels(tool, options);
  }
  throwIfSignalAborted(options.signal);
  return models;
}
function isStableDiffusionWebUiTool(tool) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  return toolId === 'automatic1111' || toolId === 'forge';
}

function mergeBackendAndLocalStableDiffusionModels(backendModels = [], localModels = []) {
  const merged = getStableDiffusionCheckpointModels(backendModels).map((entry) => ({
    ...entry,
    backendVisible: true,
    discoverySource: 'backend',
  }));

  for (const localModel of getStableDiffusionCheckpointModels(localModels)) {
    if (findStableDiffusionCheckpointMatch(merged, localModel.fileName || localModel.relativePath || localModel.name || localModel.id)) {
      continue;
    }

    merged.push({
      ...localModel,
      backendVisible: false,
      discoverySource: 'local-only',
    });
  }

  return merged;
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveFreshToolForAssetRefresh(tool) {
  const resolved = await getResolvedToolState(tool?.id, { includeSnapshots: false, resolveStatuses: true }).catch(() => null);
  return resolved || tool;
}

async function waitForToolReadyForAssetRefresh(tool, timeoutMs) {
  const startedAt = Date.now();
  let lastTool = tool;
  while (Date.now() - startedAt <= timeoutMs) {
    lastTool = await resolveFreshToolForAssetRefresh(lastTool);
    if (await isToolReady(lastTool).catch(() => false)) {
      return lastTool;
    }
    await sleep(TOOL_ASSET_REFRESH_POLL_INTERVAL_MS);
  }

  throw new Error((tool?.name || 'This tool') + ' did not become API-ready in time for model refresh. Start it from Library and try Refresh again if the first launch is still loading.');
}

async function prepareStableDiffusionBackendForAssetRefresh(tool) {
  const freshTool = await resolveFreshToolForAssetRefresh(tool);
  const wasActive = await isToolActive(freshTool).catch(() => false);
  const wasReady = wasActive ? await isToolReady(freshTool).catch(() => false) : false;
  if (!wasReady) {
    await launchToolFromUserAction(freshTool, {
      allowPendingStartup: true,
      launchContext: 'pipeline-checkpoint-refresh',
      skipOpenInterface: true,
    });
  }

  const timeoutMs = Math.max(
    Number(freshTool?.startupTimeoutMs || 0) || 0,
    Number(freshTool?.launchProfile?.startupTimeoutMs || 0) || 0,
    120000,
  ) + TOOL_ASSET_REFRESH_STARTUP_GRACE_MS;
  const readyTool = await waitForToolReadyForAssetRefresh(freshTool, timeoutMs);
  return {
    readyTool,
    startedForRefresh: !wasActive,
  };
}

async function stopStableDiffusionBackendAfterAssetRefresh(tool) {
  try {
    await stopTool(tool);
  } catch (error) {
    throw new Error((tool?.name || 'This image backend') + ' refreshed checkpoints, but Local AI Hub could not stop the backend it started for refresh: ' + humanizeError(error, 'Stop failed.'));
  }
}
function isInvokeAiTool(tool) {
  return String(tool?.id || '').trim().toLowerCase() === 'invokeai';
}
function getInvokeAiRoot(tool) {
  return path.resolve(String(tool?.installDir || tool?.appDir || '').trim());
}
function getInvokeAiModelsRoot(tool) {
  const root = getInvokeAiRoot(tool);
  return root ? path.join(root, 'models') : '';
}
function getInvokeAiApiUrl(tool, apiPath) {
  const launchUrl = assertLoopbackUrl(tool?.launchUrl, 'InvokeAI API URL');
  return new URL(apiPath, launchUrl.replace(/\/$/, '') + '/').toString();
}
async function fetchInvokeAiJson(tool, apiPath, options = {}) {
  const response = await fetch(getInvokeAiApiUrl(tool, apiPath), options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = String(payload?.detail || payload?.error || payload?.message || '').trim();
    throw new Error(detail ? 'InvokeAI answered with an error: ' + detail : 'InvokeAI answered with status ' + response.status + '.');
  }
  return payload;
}
function normalizeInvokeAiModelType(record = {}) {
  const type = String(record.type || record.model_type || '').trim().toLowerCase();
  const format = String(record.format || '').trim().toLowerCase();
  const combined = [record.name, record.path, record.base, record.description].filter(Boolean).join(' ').toLowerCase();
  if (type === 'main' && format === 'checkpoint' && /inpaint/.test(combined)) {
    return 'Inpainting';
  }
  if (type === 'main') {
    return 'Checkpoint';
  }
  if (type === 'lora' || type === 'control_lora') {
    return 'LoRA';
  }
  if (type === 'controlnet') {
    return 'ControlNet';
  }
  if (type === 'vae') {
    return 'VAE';
  }
  if (type === 'embedding' || type === 'textual_inversion' || type === 'textualinversion') {
    return 'Embedding';
  }
  return normalizeModelType(type || record.name || record.path || 'Checkpoint');
}
function resolveInvokeAiModelPath(tool, record = {}) {
  const rawPath = String(record.path || '').trim();
  if (!rawPath) {
    return '';
  }
  if (path.isAbsolute(rawPath)) {
    return path.resolve(rawPath);
  }
  return path.join(getInvokeAiModelsRoot(tool), ...splitRelativePathSegments(rawPath));
}
async function buildInvokeAiLocalModel(tool, record = {}) {
  const modelPath = resolveInvokeAiModelPath(tool, record);
  const stats = modelPath ? await fs.stat(modelPath).catch(() => null) : null;
  const metadata = modelPath ? await readModelMetadata(modelPath).catch(() => null) : null;
  const modelType = normalizeInvokeAiModelType(record);
  const fileName = path.basename(modelPath || record.path || record.name || 'model');
  return {
    id: tool.id + ':' + modelType + ':invokeai:' + normalizePathForId(record.key || record.path || record.name || fileName),
    downloaded: true,
    downloadIdentity: metadata?.downloadIdentity || null,
    fileName,
    invokeAiModelKey: record.key || null,
    metadata: metadata || null,
    modelType,
    name: String(record.name || path.parse(fileName).name || fileName).trim(),
    path: modelPath || String(record.path || '').trim(),
    relativePath: String(record.path || '').trim(),
    sizeBytes: Number(record.file_size || stats?.size || 0) || 0,
    source: 'invokeai',
    sourceArtifactPath: metadata?.sourceArtifactPath || null,
    sourceCatalogRepositoryId: metadata?.catalogRepositoryId || null,
    sourceCatalogModelId: metadata?.catalogModelId || null,
    sourceName: metadata?.source || record.source_type || record.source || 'invokeai',
    toolId: tool.id,
  };
}
async function listInvokeAiModels(tool) {
  if (!(await isToolReady(tool).catch(() => false))) {
    return listLocalFileModels(tool);
  }
  try {
    const payload = await fetchInvokeAiJson(tool, '/api/v2/models/');
    const records = Array.isArray(payload?.models) ? payload.models : [];
    const models = await Promise.all(records.map((record) => buildInvokeAiLocalModel(tool, record)));
    return models.sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return listLocalFileModels(tool);
  }
}
async function prepareInvokeAiModelImportSession(tool) {
  const freshTool = await resolveFreshToolForAssetRefresh(tool);
  const wasActive = await isToolActive(freshTool).catch(() => false);
  const wasReady = wasActive ? await isToolReady(freshTool).catch(() => false) : false;
  if (!wasReady) {
    await launchToolFromUserAction(freshTool, {
      allowPendingStartup: true,
      launchContext: 'invokeai-model-import',
      skipOpenInterface: true,
    });
  }
  const timeoutMs = Math.max(
    Number(freshTool?.startupTimeoutMs || 0) || 0,
    Number(freshTool?.launchProfile?.startupTimeoutMs || 0) || 0,
    120000,
  ) + TOOL_ASSET_REFRESH_STARTUP_GRACE_MS;
  const readyTool = await waitForToolReadyForAssetRefresh(freshTool, timeoutMs);
  return {
    readyTool,
    startedForImport: !wasActive,
  };
}
async function finishInvokeAiModelImportSession(session) {
  if (!session?.startedForImport || !session.readyTool) {
    return;
  }
  await stopTool(session.readyTool).catch(() => null);
}
function getInvokeAiImportStatus(job = {}) {
  return String(job.status || '').trim().toLowerCase();
}
function buildInvokeAiInstallErrorMessage(job = {}, fallback = '') {
  const detail = String(job.error || job.error_reason || fallback || '').trim();
  return detail ? 'InvokeAI could not import and register this model. ' + detail : 'InvokeAI could not import and register this model.';
}
async function waitForInvokeAiInstallJob(tool, job, options = {}) {
  const jobId = Number(job?.id);
  if (!Number.isFinite(jobId)) {
    throw new Error('InvokeAI accepted the import request, but did not return a model install job ID.');
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt <= INVOKEAI_MODEL_IMPORT_TIMEOUT_MS) {
    const latest = await fetchInvokeAiJson(tool, '/api/v2/models/install/' + encodeURIComponent(String(jobId)));
    const status = getInvokeAiImportStatus(latest);
    if (status === 'completed') {
      return latest;
    }
    if (status === 'error' || status === 'cancelled') {
      throw new Error(buildInvokeAiInstallErrorMessage(latest));
    }
    emitProgress(options.onProgress, {
      downloadId: options.downloadId,
      message: 'Waiting for InvokeAI to register the model.',
      percent: 95,
      receivedBytes: options.receivedBytes || 0,
      totalBytes: options.totalBytes || 0,
    });
    await sleep(INVOKEAI_MODEL_IMPORT_POLL_INTERVAL_MS);
  }
  throw new Error('InvokeAI is still importing this model. Open InvokeAI to check the model install job, then refresh Downloaded Models.');
}
function getInvokeAiImportStagePath(tool, payload = {}) {
  const fileName = sanitizePathSegment(payload.fileName || path.basename(payload.sourceArtifactPath || payload.name || 'model.safetensors')) || 'model.safetensors';
  return path.join(getAppPaths().tempRoot, 'invokeai-model-imports', sanitizePathSegment(tool?.id || 'invokeai') || 'invokeai', Date.now() + '-' + Math.random().toString(16).slice(2), fileName);
}
function buildInvokeAiModelInstallRequest(tool, sourcePath, config = {}) {
  const installUrl = new URL(getInvokeAiApiUrl(tool, '/api/v2/models/install'));
  installUrl.searchParams.set('source', sourcePath);
  installUrl.searchParams.set('inplace', 'false');
  return {
    body: JSON.stringify(config && typeof config === 'object' ? config : {}),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    url: installUrl.toString(),
  };
}
function buildInvokeAiModelImportConfig(payload = {}) {
  const modelType = normalizeModelType(payload?.downloadPlan?.modelType || payload?.modelType || '');
  const typeMap = {
    ControlNet: 'controlnet',
    Embedding: 'embedding',
    LoRA: 'lora',
    VAE: 'vae',
  };
  return typeMap[modelType] ? { type: typeMap[modelType] } : {};
}
async function writeInvokeAiImportMetadata(tool, payload, job) {
  const configOut = job?.config_out || job?.configOut || null;
  const modelPath = resolveInvokeAiModelPath(tool, configOut || {});
  if (!modelPath || !(await fs.pathExists(modelPath).catch(() => false))) {
    return null;
  }
  return writeModelMetadata(modelPath, buildDownloadMetadata(tool, payload, {
    destinationPath: modelPath,
    fileName: path.basename(modelPath),
    installRelativePath: String(configOut?.path || path.relative(getInvokeAiModelsRoot(tool), modelPath) || path.basename(modelPath)),
    targetDirectory: path.dirname(modelPath),
  })).catch(() => null);
}
function isInvokeAiApiImportPayload(tool, payload = {}) {
  return isInvokeAiTool(tool) && payload?.downloadPlan?.installStrategy === 'invokeai-api-import';
}
function getDirectorySummary(models = [], fallback = '') {
  const firstPath = String(models[0]?.path || '').trim();
  if (firstPath) {
    return path.dirname(firstPath);
  }
  return fallback;
}

async function listToolAssets(tool, options = {}) {
  if (isStableDiffusionWebUiTool(tool)) {
    const localModels = supportsModelManager(tool) ? await listLocalFileModels(tool).catch(() => []) : [];
    let prepared = null;
    try {
      prepared = await prepareStableDiffusionBackendForAssetRefresh(tool);
      const backendModels = await listStableDiffusionApiCheckpoints(prepared.readyTool);
      const models = mergeBackendAndLocalStableDiffusionModels(backendModels, localModels);
      const backendCheckpoints = getStableDiffusionCheckpointModels(backendModels);
      const localOnlyCount = models.filter((entry) => entry.backendVisible === false).length;
      const localFolder = getDirectorySummary(localModels, 'the WebUI checkpoint folder');
      let message = '';
      if (!backendModels.length) {
        message = (prepared.readyTool?.name || 'This image backend') + ' is API-ready, but /sdapi/v1/sd-models returned no checkpoints.';
      } else if (!backendCheckpoints.length) {
        message = (prepared.readyTool?.name || 'This image backend') + ' is API-ready, but its live model list only contains support files. Add a real .safetensors or .ckpt checkpoint.';
      } else if (localOnlyCount) {
        message = (prepared.readyTool?.name || 'This image backend') + ' listed ' + backendCheckpoints.length + ' usable checkpoint' + (backendCheckpoints.length === 1 ? '' : 's') + ', but ' + localOnlyCount + ' local checkpoint file' + (localOnlyCount === 1 ? ' is' : 's are') + ' not visible to the backend yet. Restart or refresh the WebUI if you expected files under ' + localFolder + ' to appear.';
      } else {
        message = (prepared.readyTool?.name || 'This image backend') + ' listed ' + backendCheckpoints.length + ' usable checkpoint' + (backendCheckpoints.length === 1 ? '' : 's') + ' from its live WebUI API.';
      }
      if (prepared.startedForRefresh) {
        message += ' Local AI Hub started the backend for this refresh and stopped it afterward.';
      }

      return {
        assetKind: 'stable-diffusion-checkpoint',
        live: true,
        message,
        models,
        startedForRefresh: prepared.startedForRefresh,
        toolId: prepared.readyTool?.id || tool?.id || '',
      };
    } catch (error) {
      throw new Error(humanizeError(error, (tool?.name || 'This image backend') + ' could not refresh checkpoints from the live WebUI API.'));
    } finally {
      if (prepared?.startedForRefresh && prepared.readyTool) {
        await stopStableDiffusionBackendAfterAssetRefresh(prepared.readyTool);
      }
    }
  }

  if (tool?.id === 'audiocraft-webui') {
    const models = await listDownloadedModels(tool);
    const folder = getDirectorySummary(models, tool?.appDir || tool?.installDir ? path.join(tool.appDir || tool.installDir, 'models') : 'the AudioCraft models folder');
    return {
      assetKind: 'audiocraft-snapshot',
      live: false,
      message: models.length
        ? 'Found ' + models.length + ' AudioCraft snapshot' + (models.length === 1 ? '' : 's') + ' under ' + folder + '.'
        : 'No downloaded AudioCraft snapshots were found. AudioCraft can still use upstream defaults when the model field is blank.',
      models,
      toolId: tool?.id || '',
    };
  }

  if (tool?.id === 'wan21-webui') {
    const models = await listDownloadedModels(tool);
    const folder = getDirectorySummary(models, tool?.appDir || tool?.installDir ? path.join(tool.appDir || tool.installDir, 'models', 'Wan-AI') : 'models\Wan-AI');
    return {
      assetKind: 'wan-model-folder',
      live: false,
      message: models.length
        ? 'Found ' + models.length + ' Wan model folder' + (models.length === 1 ? '' : 's') + ' under ' + folder + '.'
        : 'No Wan model folders were found under models\Wan-AI. Download a complete Wan package before running local Wan video.',
      models,
      toolId: tool?.id || '',
    };
  }

  if (tool?.id === 'upscayl') {
    const models = await listDownloadedModels(tool);
    return {
      assetKind: 'upscayl-model-set',
      live: false,
      message: models.length
        ? 'Found ' + models.length + ' Upscayl model set' + (models.length === 1 ? '' : 's') + '.'
        : 'No downloaded Upscayl paired model sets were found. Upscayl can still use its bundled default model.',
      models,
      toolId: tool?.id || '',
    };
  }

  if (tool?.id === 'invokeai') {
    const models = await listDownloadedModels(tool);
    const registeredCount = models.filter((model) => model.invokeAiModelKey).length;
    return {
      assetKind: 'invokeai-main-model',
      live: registeredCount > 0,
      message: registeredCount
        ? 'Found ' + registeredCount + ' registered InvokeAI model' + (registeredCount === 1 ? '' : 's') + ' through InvokeAI\'s model API.'
        : 'No registered InvokeAI main models were found. Launch InvokeAI and refresh after importing models if this list looks stale.',
      models,
      toolId: tool?.id || '',
    };
  }

  if (tool?.id === 'rvc') {
    const models = await listDownloadedModels(tool).catch(() => []);
    const weightsFolder = getDirectorySummary(models, tool?.appDir || tool?.installDir ? path.join(tool.appDir || tool.installDir, 'weights') : 'the RVC weights folder');
    return {
      assetKind: 'rvc-voice-model',
      live: false,
      message: models.length
        ? 'Found ' + models.length + ' RVC voice model' + (models.length === 1 ? '' : 's') + ' under ' + weightsFolder + '.'
        : 'No RVC voice models were found. Add .pth voice model files under ' + weightsFolder + ', then refresh voice models.',
      models,
      toolId: tool?.id || '',
    };
  }

  return {
    assetKind: String(options.assetKind || 'model').trim() || 'model',
    live: false,
    message: (tool?.name || 'This tool') + ' uses the regular Model Manager local model list.',
    models: await listDownloadedModels(tool),
    toolId: tool?.id || '',
  };
}
async function countDownloadedModels(tool) {
  if (tool?.id === 'rvc') {
    return (await listDownloadedModels(tool)).length;
  }
  if (!supportsModelManager(tool)) {
    return 0;
  }
  if (tool.id === 'ollama') {
    return (await listLocalOllamaModels(tool)).length;
  }
  return (await listLocalFileModels(tool)).length;
}
function normalizeLookupKey(value) {
  return String(value || '').trim().replace(/[\\/]+/g, '/').toLowerCase();
}
function buildDownloadedLookup(localModels) {
  const lookup = new Set();
  for (const model of localModels || []) {
    const identity = normalizeLookupKey(model.downloadIdentity || model.metadata?.downloadIdentity);
    if (identity) {
      lookup.add(identity);
    }
    if (model.source === 'ollama') {
      for (const value of [model.fileName, model.name, model.relativePath]) {
        const key = normalizeLookupKey(value);
        if (key) {
          lookup.add(key);
        }
      }
    }
  }
  return lookup;
}
function isDownloadedMatch(downloadedLookup, values = []) {
  return (values || []).some((value) => {
    const key = normalizeLookupKey(value);
    return key ? downloadedLookup.has(key) : false;
  });
}
function buildCatalogLookupValues(repositoryId, installRelativePath, extras = []) {
  const values = [...(extras || [])];
  if (repositoryId && !installRelativePath) {
    values.push(repositoryId);
  }
  if (installRelativePath) {
    values.push(installRelativePath);
  }
  if (repositoryId && installRelativePath) {
    values.push(`${String(repositoryId).replace(/[\\/]+/g, '/')}/${String(installRelativePath).replace(/[\\/]+/g, '/')}`);
  }
  return values.filter(Boolean);
}
function buildHuggingFaceResolveUrl(modelId, filePath) {
  const safePath = String(filePath || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://huggingface.co/${modelId}/resolve/main/${safePath}`;
}
function buildHuggingFaceDescription(detail) {
  const tags = (detail.tags || [])
    .filter((tag) => typeof tag === 'string' && !tag.includes(':'))
    .slice(0, 4)
    .join(', ');
  const detailParts = [detail.pipeline_tag, detail.library_name, tags].filter(Boolean);
  return detailParts.length
    ? 'Hugging Face ' + detailParts.join(' | ')
    : 'Hugging Face model by ' + (detail.author || 'the community');
}
function hasLikelyHuggingFaceRvcContext(detail, fileEntry) {
  const cardData = detail?.cardData || detail?.card_data || {};
  const combined = [
    detail?.id,
    detail?.author,
    detail?.pipeline_tag,
    detail?.library_name,
    ...(detail?.tags || []),
    cardData?.license,
    cardData?.base_model,
    fileEntry?.rfilename,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /(?:^|[^a-z0-9])(?:rvc|retrieval[-_\s]*based[-_\s]*voice[-_\s]*conversion|retrieval[-_\s]*voice[-_\s]*conversion|voice[-_\s]*conversion|voice[-_\s]*model)(?:[^a-z0-9]|$)/i.test(combined);
}
function inferHuggingFaceType(detail, fileEntry) {
  const combined = [detail.pipeline_tag || '', ...(detail.tags || []), fileEntry?.rfilename || '']
    .join(' ')
    .toLowerCase();
  if (/\.(?:pth|pt)$/i.test(fileEntry?.rfilename || '') && hasLikelyHuggingFaceRvcContext(detail, fileEntry)) {
    return 'RVC Voice Model';
  }
  return normalizeModelType(combined);
}
function isPackageTool(tool) {
  return PACKAGE_TOOL_IDS.has(String(tool?.id || '').trim().toLowerCase());
}
function isRemotePackageArtifactFile(tool, filePath) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  const normalizedPath = String(filePath || '').trim().replace(/\\+/g, '/');
  if (!normalizedPath) {
    return false;
  }
  if (toolId === 'audiocraft-webui') {
    return /\.(bin)$/i.test(normalizedPath) || PACKAGE_SUPPORT_FILE_PATTERN.test(normalizedPath);
  }
  if (toolId === 'wan21-webui') {
    return /\.(safetensors|pth)$/i.test(normalizedPath);
  }
  if (toolId === 'upscayl') {
    return /\.(param|bin)$/i.test(normalizedPath);
  }
  return false;
}
function isRemoteCatalogArtifactFile(tool, filePath) {
  if (tool?.id === 'rvc') {
    return RVC_REMOTE_ARTIFACT_FILE_PATTERN.test(filePath || '');
  }
  if (isPackageTool(tool)) {
    return isRemotePackageArtifactFile(tool, filePath);
  }
  return MODEL_FILE_PATTERN.test(filePath || '');
}
function getKnownHuggingFaceFileSize(entry) {
  const candidates = [entry?.lfs?.size, entry?.xet?.size, entry?.size, entry?.blob?.size, entry?.metadata?.size];
  for (const candidate of candidates) {
    const sizeBytes = Number(candidate || 0);
    if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
      return sizeBytes;
    }
  }
  return 0;
}
function normalizeHuggingFaceTreeEntry(entry) {
  const filePath = String(entry?.rfilename || entry?.path || '').trim();
  if (!filePath || String(entry?.type || 'file').toLowerCase() === 'directory') {
    return null;
  }
  return {
    ...entry,
    rfilename: filePath,
    size: Number(entry?.size || 0) || undefined,
  };
}
function mergeHuggingFaceSiblingEntries(siblings = [], expandedEntries = []) {
  const merged = new Map();
  for (const entry of [...(siblings || []), ...(expandedEntries || [])]) {
    const normalized = normalizeHuggingFaceTreeEntry(entry);
    if (!normalized) {
      continue;
    }
    const key = String(normalized.rfilename || '').replace(/\\+/g, '/');
    const existing = merged.get(key) || {};
    merged.set(key, {
      ...existing,
      ...normalized,
      rfilename: key,
    });
  }
  return [...merged.values()];
}
async function fetchHuggingFaceRepositoryTree(detail, logger) {
  const modelId = String(detail?.id || '').trim();
  if (!modelId) {
    return [];
  }
  if (HUGGING_FACE_TREE_CACHE.has(modelId)) {
    return HUGGING_FACE_TREE_CACHE.get(modelId);
  }
  const treeUrl = HUGGING_FACE_MODEL_URL + '/' + modelId + '/tree/main?recursive=true&expand=true';
  try {
    await logger.info('Expanding Hugging Face repository file tree for artifact planning.', { modelId }).catch(() => null);
    const { payload } = await fetchJsonResponse(treeUrl, {
      headers: {
        'User-Agent': APP_USER_AGENT,
      },
    });
    const entries = Array.isArray(payload) ? payload.map(normalizeHuggingFaceTreeEntry).filter(Boolean) : [];
    HUGGING_FACE_TREE_CACHE.set(modelId, entries);
    return entries;
  } catch (error) {
    rethrowModelBrowseCancellation(error);
    await logger.warn('A Hugging Face repository tree expansion failed.', { error, modelId }).catch(() => null);
    return [];
  }
}
async function expandHuggingFaceDetailForPlanning(detail, selectedType, tool, logger) {
  if (!tool) {
    return detail;
  }
  const existingCandidate = collectHuggingFaceDownloadFiles(detail, selectedType, tool)[0] || null;
  if (existingCandidate) {
    return detail;
  }
  const expandedEntries = await fetchHuggingFaceRepositoryTree(detail, logger);
  if (!expandedEntries.length) {
    return detail;
  }
  return {
    ...detail,
    siblings: mergeHuggingFaceSiblingEntries(detail.siblings || [], expandedEntries),
  };
}
function normalizeSearchQuery(value) {
  return String(value || '').trim().toLowerCase();
}
function normalizeSearchSeparators(value) {
  return normalizeSearchQuery(value)
    .replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|param)$/i, ' $1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function compactSearchText(value) {
  return normalizeSearchSeparators(value).replace(/\s+/g, '');
}
function searchTokens(value) {
  return normalizeSearchSeparators(value).split(/\s+/).filter(Boolean);
}
function stripSearchFileExtension(value) {
  return String(value || '').replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|param)$/i, '');
}
function stripQuantizationSuffix(value) {
  return String(value || '')
    .replace(/(?:[-_. ](?:q\d(?:_[a-z0-9]+)*|iq\d(?:_[a-z0-9]+)*|f\d{2}|k_[msl]|ks|km))+$/i, '')
    .replace(/[-_. ]+$/g, '');
}
function getSearchQueryVariants(query) {
  const raw = String(query || '').trim();
  const baseName = path.basename(raw.replace(/\\+/g, '/'));
  const withoutExtension = stripSearchFileExtension(baseName || raw);
  const withoutQuant = stripQuantizationSuffix(withoutExtension);
  const variants = [
    raw,
    baseName,
    withoutExtension,
    withoutQuant,
    normalizeSearchSeparators(raw),
    normalizeSearchSeparators(withoutExtension),
    normalizeSearchSeparators(withoutQuant),
  ];
  if (/\.gguf$/i.test(raw) && withoutQuant) {
    variants.push(`${normalizeSearchSeparators(withoutQuant)} gguf`);
  }
  return mergeUniqueStrings(variants.map((value) => String(value || '').trim()).filter(Boolean));
}
function matchesSearchQuery(query, values = []) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return true;
  }
  const queryVariants = getSearchQueryVariants(query);
  const queryCanonical = normalizeSearchSeparators(query);
  const queryCompact = compactSearchText(query);
  const queryTokens = searchTokens(query);
  return values.some((value) => {
    const normalizedValue = normalizeSearchQuery(value);
    const valueCanonical = normalizeSearchSeparators(value);
    const valueCompact = compactSearchText(value);
    const valueTokens = searchTokens(value);
    if (!normalizedValue && !valueCanonical) {
      return false;
    }
    if (
      queryVariants.some((variant) => {
        const normalizedVariant = normalizeSearchQuery(variant);
        const canonicalVariant = normalizeSearchSeparators(variant);
        return (
          normalizedVariant &&
          (normalizedValue.includes(normalizedVariant) ||
            valueCanonical.includes(canonicalVariant) ||
            valueCompact.includes(compactSearchText(variant)))
        );
      })
    ) {
      return true;
    }
    return queryTokens.length > 0 && queryTokens.every((queryToken) => valueTokens.some((valueToken) => valueToken.includes(queryToken)));
  });
}
function isFileLikeSearchQuery(query) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return false;
  }
  return MODEL_FILE_PATTERN.test(normalizedQuery) || /[\\/]/.test(normalizedQuery) || /\.[a-z0-9]{2,16}$/i.test(normalizedQuery);
}
function isArtifactLevelSearchQuery(query) {
  const normalizedQuery = normalizeSearchQuery(path.basename(String(query || '').replace(/\\+/g, '/')));
  return MODEL_FILE_PATTERN.test(normalizedQuery);
}
function isRepositoryIdSearchQuery(query) {
  const normalizedQuery = String(query || '').trim().replace(/\\+/g, '/');
  return /^[^/\s]+\/[^/\s]+$/.test(normalizedQuery) && !MODEL_FILE_PATTERN.test(normalizedQuery);
}
function collectHuggingFacePackageFiles(detail, selectedType, tool = null) {
  const artifacts = (detail.siblings || [])
    .filter((entry) => isRemoteCatalogArtifactFile(tool, entry.rfilename || ''))
    .map((entry) => ({
      ...entry,
      modelType: inferHuggingFaceType(detail, entry),
      sizeBytes: getKnownHuggingFaceFileSize(entry),
    }));
  const plan = createModelDownloadPlan({ artifacts, catalogRepositoryId: detail.id, selectedType, source: 'huggingface', tool });
  if (!plan?.runnable) {
    return [];
  }
  return [{
    artifactKind: plan.compatibleArtifacts?.[0]?.artifactKind || 'model-package',
    artifactLabel: plan.artifactLabel,
    downloadPlan: plan,
    modelType: plan.modelType || normalizeModelType(selectedType),
    packageIdentity: plan.packageIdentity,
    rfilename: plan.packageRoot || plan.recommendedArtifactPath || detail.id,
    sizeBytes: Number(plan.sizeBytes || 0),
  }];
}
function collectHuggingFaceDownloadFiles(detail, selectedType, tool = null) {
  if (tool && PACKAGE_TOOL_IDS.has(String(tool.id || '').trim().toLowerCase())) {
    return collectHuggingFacePackageFiles(detail, selectedType, tool);
  }
  const artifacts = (detail.siblings || [])
    .filter((entry) => isRemoteCatalogArtifactFile(tool, entry.rfilename || ''))
    .map((entry) => ({
      ...entry,
      modelType: inferHuggingFaceType(detail, entry),
      sizeBytes: getKnownHuggingFaceFileSize(entry),
    }));
  if (!tool) {
    return artifacts
      .filter((entry) => matchesSelectedModelType(entry.modelType, selectedType))
      .sort((left, right) => right.sizeBytes - left.sizeBytes || String(left.rfilename || '').localeCompare(String(right.rfilename || '')));
  }
  return annotateArtifactsForDownloadPlan({ artifacts, selectedType, source: 'huggingface', tool })
    .filter((entry) => entry.runnable)
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || String(left.rfilename || '').localeCompare(String(right.rfilename || '')));
}
function pickHuggingFaceDownloadFile(detail, selectedType, tool = null) {
  return collectHuggingFaceDownloadFiles(detail, selectedType, tool)[0] || null;
}
function normalizeHuggingFacePreviewCandidate(modelId, value) {
  const rawValue = String(value || '').trim();
  if (!rawValue || /^data:/i.test(rawValue)) {
    return null;
  }
  if (/^https?:\/\//i.test(rawValue)) {
    return rawValue;
  }
  if (/^\/\//.test(rawValue)) {
    return 'https:' + rawValue;
  }
  if (rawValue.startsWith('/')) {
    return 'https://huggingface.co' + rawValue;
  }
  const normalizedPath = rawValue.replace(/^\.\//, '').replace(/^\//, '');
  return normalizedPath ? buildHuggingFaceResolveUrl(modelId, normalizedPath) : null;
}
function collectHuggingFaceWidgetPreviewCandidates(entries = []) {
  const candidates = [];
  for (const entry of entries || []) {
    candidates.push(
      entry?.output?.url,
      entry?.output?.image?.url,
      entry?.exampleOutput?.url,
      entry?.exampleOutput?.image?.url,
      entry?.image?.url,
      entry?.src,
      entry?.url,
    );
  }
  return candidates.filter(Boolean);
}
function pickHuggingFacePreviewFromMetadata(detail) {
  const cardData = detail.cardData || detail.card_data || {};
  const previewCandidates = [
    cardData.thumbnail,
    cardData.banner,
    ...collectHuggingFaceWidgetPreviewCandidates(cardData.widget || []),
    ...collectHuggingFaceWidgetPreviewCandidates(detail.widgetData || detail.widget_data || []),
  ];
  for (const candidate of previewCandidates) {
    const normalizedPreview = normalizeHuggingFacePreviewCandidate(detail.id, candidate);
    if (normalizedPreview) {
      return normalizedPreview;
    }
  }
  return null;
}
function pickHuggingFacePreviewFromSiblings(detail) {
  const image = (detail.siblings || []).find((entry) => IMAGE_FILE_PATTERN.test(entry.rfilename || ''));
  if (!image) {
    return null;
  }
  return buildHuggingFaceResolveUrl(detail.id, image.rfilename);
}
function extractReadmeImageUrls(markdown) {
  const imageUrls = [];
  const markdownPattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const htmlPattern = /<img[^>]+src=["']([^"']+)["']/gi;
  let match = null;
  while ((match = markdownPattern.exec(String(markdown || ''))) !== null) {
    imageUrls.push(match[1]);
  }
  while ((match = htmlPattern.exec(String(markdown || ''))) !== null) {
    imageUrls.push(match[1]);
  }
  return [...new Set(imageUrls.filter(Boolean))];
}
async function fetchJsonResponse(url, options = {}) {
  throwIfModelBrowseCanceled();
  const response = await fetch(url, withModelBrowseSignal(options));
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = String(payload?.error || payload?.message || '').trim();
    throw new Error(detail ? `Request failed with status ${response.status}. ${detail}` : `Request failed with status ${response.status}.`);
  }
  return {
    response,
    payload,
  };
}
function extractCursorFromLinkHeader(linkHeader, rel) {
  const link = String(linkHeader || '')
    .split(',')
    .map((entry) => entry.trim())
    .find((entry) => entry.includes(`rel="${rel}"`));
  if (!link) {
    return null;
  }
  const match = link.match(/<([^>]+)>/);
  if (!match) {
    return null;
  }
  try {
    return new URL(match[1]).searchParams.get('cursor');
  } catch {
    return null;
  }
}
async function fetchHuggingFaceDetails(results, logger) {
  const eligibleResults = (results || []).filter((result) => !result.private && !result.gated);
  const detailResults = await Promise.allSettled(
    eligibleResults.map((result) =>
      fetchJsonResponse(HUGGING_FACE_MODEL_URL + '/' + result.id + '?files_metadata=true', {
        headers: {
          'User-Agent': APP_USER_AGENT,
        },
      }).then((payload) => payload.payload),
    ),
  );
  throwIfModelBrowseCanceled();
  return detailResults
    .map((entry, index) => {
      if (entry.status === 'fulfilled') {
        return entry.value;
      }
      logger.warn('A Hugging Face model detail request failed.', {
        error: entry.reason,
        modelId: eligibleResults[index]?.id,
      }).catch(() => null);
      return null;
    })
    .filter(Boolean);
}
function parseSizeHeader(response) {
  const contentRange = response.headers.get('content-range');
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/);
    if (match) {
      const sizeBytes = Number(match[1]);
      if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
        return sizeBytes;
      }
    }
  }
  const headerValues = [response.headers.get('x-linked-size'), response.headers.get('content-length')];
  for (const headerValue of headerValues) {
    const sizeBytes = Number(headerValue || 0);
    if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
      return sizeBytes;
    }
  }
  return 0;
}
async function fetchHuggingFaceFileSize(modelId, filePath, logger) {
  const cacheKey = modelId + '::' + filePath;
  if (HUGGING_FACE_FILE_SIZE_CACHE.has(cacheKey)) {
    return HUGGING_FACE_FILE_SIZE_CACHE.get(cacheKey);
  }
  const downloadUrl = buildHuggingFaceResolveUrl(modelId, filePath);
  let sizeBytes = 0;
  try {
    throwIfModelBrowseCanceled();
    let response = await fetch(downloadUrl, withModelBrowseSignal({
      method: 'HEAD',
      headers: {
        'User-Agent': APP_USER_AGENT,
      },
    }));
    sizeBytes = parseSizeHeader(response);
    if ((!response.ok || sizeBytes <= 0) && response.status !== 404) {
      response = await fetch(downloadUrl, withModelBrowseSignal({
        headers: {
          Range: 'bytes=0-0',
          'User-Agent': APP_USER_AGENT,
        },
      }));
      sizeBytes = parseSizeHeader(response);
      if (response.body && typeof response.body.cancel === 'function') {
        await response.body.cancel().catch(() => null);
      }
    }
  } catch (error) {
    rethrowModelBrowseCancellation(error);
    await logger.warn('A Hugging Face file size lookup failed.', {
      downloadUrl,
      error,
      modelId,
    }).catch(() => null);
  }
  HUGGING_FACE_FILE_SIZE_CACHE.set(cacheKey, sizeBytes || 0);
  return sizeBytes || 0;
}async function resolveHuggingFaceDownloadFile(detail, selectedType, logger, tool = null) {
  const planningDetail = await expandHuggingFaceDetailForPlanning(detail, selectedType, tool, logger);
  const downloadFile = pickHuggingFaceDownloadFile(planningDetail, selectedType, tool);
  if (!downloadFile) {
    return null;
  }
  if (downloadFile.sizeBytes > 0) {
    return downloadFile;
  }
  return {
    ...downloadFile,
    sizeBytes: await fetchHuggingFaceFileSize(planningDetail.id, downloadFile.rfilename, logger),
  };
}
async function resolveHuggingFaceDownloadPlan(detail, selectedType, logger, tool = null) {
  const planningDetail = await expandHuggingFaceDetailForPlanning(detail, selectedType, tool, logger);
  const artifacts = (planningDetail.siblings || [])
    .filter((entry) => isRemoteCatalogArtifactFile(tool, entry.rfilename || ''))
    .map((entry) => ({
      ...entry,
      modelType: inferHuggingFaceType(planningDetail, entry),
      sizeBytes: getKnownHuggingFaceFileSize(entry),
    }));
  return createModelDownloadPlan({ artifacts, catalogRepositoryId: planningDetail.id, selectedType, source: 'huggingface', tool });
}
async function fetchHuggingFaceReadmePreview(detail, logger) {
  const readmeEntry = (detail.siblings || []).find((entry) => README_FILE_PATTERN.test(entry.rfilename || ''));
  if (!readmeEntry) {
    return null;
  }
  try {
    const response = await fetch(buildHuggingFaceResolveUrl(detail.id, readmeEntry.rfilename), withModelBrowseSignal({
      headers: {
        'User-Agent': APP_USER_AGENT,
      },
    }));
    if (!response.ok) {
      return null;
    }
    const markdown = await response.text();
    for (const candidate of extractReadmeImageUrls(markdown)) {
      const normalizedPreview = normalizeHuggingFacePreviewCandidate(detail.id, candidate);
      if (normalizedPreview) {
        return normalizedPreview;
      }
    }
  } catch (error) {
    rethrowModelBrowseCancellation(error);
    await logger.warn('A Hugging Face README preview lookup failed.', {
      error,
      modelId: detail.id,
    }).catch(() => null);
  }
  return null;
}
async function resolveHuggingFacePreview(detail, logger) {
  if (HUGGING_FACE_PREVIEW_CACHE.has(detail.id)) {
    return HUGGING_FACE_PREVIEW_CACHE.get(detail.id);
  }
  const previewUrl =
    pickHuggingFacePreviewFromMetadata(detail) ||
    pickHuggingFacePreviewFromSiblings(detail) ||
    (await fetchHuggingFaceReadmePreview(detail, logger)) ||
    null;
  HUGGING_FACE_PREVIEW_CACHE.set(detail.id, previewUrl);
  return previewUrl;
}
function mergeUniqueDetailsById(details = []) {
  const unique = new Map();
  for (const detail of details.filter(Boolean)) {
    if (!unique.has(detail.id)) {
      unique.set(detail.id, detail);
    }
  }
  return [...unique.values()];
}
function getPackageDefaultSeedModelIds(tool) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  if (toolId === 'audiocraft-webui') {
    return AUDIOCRAFT_PACKAGE_MODEL_IDS;
  }
  if (toolId === 'wan21-webui') {
    return WAN_PACKAGE_MODEL_IDS;
  }
  return [];
}
function getPackageQuerySeedModelIds(tool, query) {
  const toolId = String(tool?.id || '').trim().toLowerCase();
  const normalizedQuery = String(query || '').trim().replace(/\\+/g, '/').toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  if (toolId === 'audiocraft-webui') {
    return AUDIOCRAFT_PACKAGE_MODEL_IDS.filter((id) => {
      const normalizedId = id.toLowerCase();
      const folderName = path.basename(id).toLowerCase();
      return normalizedId === normalizedQuery || normalizedId.includes(normalizedQuery) || folderName.includes(normalizedQuery);
    });
  }
  if (toolId === 'wan21-webui') {
    if (['wan-ai', 'wan2.1', 'wan-ai/wan2.1'].includes(normalizedQuery)) {
      return WAN_PACKAGE_MODEL_IDS;
    }
    return WAN_PACKAGE_MODEL_IDS.filter((id) => id.toLowerCase().includes(normalizedQuery));
  }
  return [];
}
async function fetchHuggingFaceSeedDetails(browseOptions, logger, tool = null) {
  if (browseOptions.cursor) {
    return [];
  }
  const query = String(browseOptions.query || '').trim();
  const seedModelIds = query
    ? mergeUniqueStrings([
        ...(isRepositoryIdSearchQuery(query) ? [query.replace(/\\+/g, '/')] : []),
        ...getPackageQuerySeedModelIds(tool, query),
      ])
    : mergeUniqueStrings([
        ...getPackageDefaultSeedModelIds(tool),
        ...(getTaskProfile(browseOptions.taskType).seedModelIds || []),
      ]);
  if (!seedModelIds.length) {
    return [];
  }
  return fetchHuggingFaceDetails(
    seedModelIds.map((id) => ({
      id,
      gated: false,
      private: false,
    })),
    logger,
  );
}
async function requestHuggingFacePage(tool, browseOptions, logger, pipelineTag = '', queryOverride = null) {
  const searchUrl = new URL(HUGGING_FACE_SEARCH_URL);
  const derivedSearchQuery = resolveHuggingFaceSearchQuery(tool, browseOptions, queryOverride);
  searchUrl.searchParams.set('limit', String(browseOptions.limit));
  searchUrl.searchParams.set('sort', HF_SORT_MAP[browseOptions.sort] || HF_SORT_MAP['most-downloaded']);
  searchUrl.searchParams.set('direction', '-1');
  if (derivedSearchQuery) {
    searchUrl.searchParams.set('search', derivedSearchQuery);
  }
  if (pipelineTag) {
    searchUrl.searchParams.set('pipeline_tag', pipelineTag);
  }
  if (browseOptions.cursor) {
    searchUrl.searchParams.set('cursor', browseOptions.cursor);
  }
  await logger.info('Searching Hugging Face models.', {
    modelType: browseOptions.modelType,
    pipelineTag: pipelineTag || null,
    query: derivedSearchQuery,
    sort: browseOptions.sort,
    taskType: browseOptions.taskType,
    toolId: tool.id,
  });
  const { response, payload } = await fetchJsonResponse(searchUrl, {
    headers: {
      'User-Agent': APP_USER_AGENT,
    },
  });
  return {
    nextCursor: extractCursorFromLinkHeader(response.headers.get('link'), 'next'),
    results: Array.isArray(payload) ? payload : [],
  };
}
function mergeUniqueRemoteEntriesById(entries = []) {
  const unique = new Map();
  for (const entry of entries.filter(Boolean)) {
    const id = String(entry?.id || '').trim();
    if (id && !unique.has(id)) {
      unique.set(id, entry);
    }
  }
  return [...unique.values()];
}
async function fetchHuggingFacePage(tool, browseOptions, logger) {
  const pipelineTags = getEffectiveHuggingFacePipelineTags(browseOptions);
  const derivedSearchQuery = resolveHuggingFaceSearchQuery(tool, browseOptions);
  const preferredPipelineTag = pipelineTags[0] || '';
  const primaryPage = await requestHuggingFacePage(tool, browseOptions, logger, preferredPipelineTag);
  const isRvcSearch = isRvcBrowseTarget(tool, browseOptions);
  if (isRvcSearch && primaryPage.nextCursor && (primaryPage.results || []).length >= browseOptions.limit) {
    return primaryPage;
  }
  const fallbackQueries = isRvcSearch
    ? getRvcHuggingFaceFallbackQueries(browseOptions, derivedSearchQuery)
    : derivedSearchQuery && isFileLikeSearchQuery(derivedSearchQuery)
      ? getSearchQueryVariants(derivedSearchQuery).slice(0, 6)
      : [];
  if (!fallbackQueries.length) {
    return primaryPage;
  }
  const fallbackPages = [];
  for (const variant of fallbackQueries) {
    fallbackPages.push(await requestHuggingFacePage(tool, browseOptions, logger, '', variant));
  }
  return {
    nextCursor: primaryPage.nextCursor || fallbackPages.find((page) => page.nextCursor)?.nextCursor || null,
    results: mergeUniqueRemoteEntriesById([primaryPage, ...fallbackPages].flatMap((page) => page.results || [])),
  };
}
async function resolveHuggingFaceArtifactFiles(detail, browseOptions, logger, tool = null) {
  const query = String(browseOptions.query || '').trim();
  if (!query) {
    return [];
  }
  const planningDetail = await expandHuggingFaceDetailForPlanning(detail, browseOptions.modelType, tool, logger);
  const matchingFiles = collectHuggingFaceDownloadFiles(planningDetail, browseOptions.modelType, tool).filter((file) =>
    matchesSearchQuery(query, [file.rfilename, path.basename(file.rfilename)]),
  );
  if (!matchingFiles.length) {
    return [];
  }
  return Promise.all(
    matchingFiles.map(async (file) =>
      file.sizeBytes > 0
        ? file
        : {
            ...file,
            sizeBytes: await fetchHuggingFaceFileSize(detail.id, file.rfilename, logger),
          },
    ),
  );
}
function mergeCatalogSearchItems(itemGroups, limit) {
  const merged = [];
  const seenIds = new Set();
  for (const group of itemGroups || []) {
    for (const item of group || []) {
      if (!item || seenIds.has(item.id)) {
        continue;
      }
      seenIds.add(item.id);
      merged.push(item);
      if (merged.length >= limit) {
        return merged;
      }
    }
  }
  return merged;
}
function getCatalogSearchGroups(modelItems, artifactItems, fileLevelSearch) {
  if (modelItems.length) {
    return [modelItems];
  }
  if (fileLevelSearch) {
    return [artifactItems];
  }
  return artifactItems.length ? [artifactItems] : [modelItems];
}
function buildHuggingFaceRepositoryResult(detail, file, tool, downloadedLookup, hardwareContext, catalogRequirements, previewUrl) {
  const plan = file.downloadPlan || null;
  const isPackagePlan = plan?.planType === 'package';
  const fileName = isPackagePlan ? (plan.packageName || path.basename(plan.packageRoot || detail.id)) : path.basename(file.rfilename || '');
  const installRelativePath = isPackagePlan
    ? normalizeRelativeInstallPath(plan.packageRoot || file.rfilename || fileName) || fileName
    : normalizeRelativeInstallPath(file.rfilename || fileName) || fileName;
  const identityPayload = {
    source: 'huggingface',
    toolId: tool.id,
    catalogRepositoryId: detail.id,
    packageIdentity: plan?.packageIdentity || file.packageIdentity || null,
    sourceArtifactPath: isPackagePlan ? (plan.packageRoot || detail.id) : file.rfilename,
    installRelativePath,
    fileName,
  };
  const identity = buildSourceDownloadIdentity(identityPayload);
  return attachHardwareHints(
    attachDownloadPlanFields({
      id: 'huggingface:repository:' + detail.id,
      author: detail.author || null,
      catalogEntityLabel: isPackagePlan ? 'Package' : 'Repository',
      catalogEntityType: isPackagePlan ? 'package' : 'repository',
      catalogContext: isPackagePlan ? (plan.artifactLabel + ': ' + (plan.packageRoot || fileName)) : (file.rfilename ? `Primary artifact: ${file.rfilename}` : null),
      catalogRepositoryId: detail.id,
      catalogRequirements,
      description: buildHuggingFaceDescription(detail),
      downloaded: isDownloadedMatch(downloadedLookup, [identity]),
      downloadIdentity: identity,
      downloadUrl: isPackagePlan ? null : buildHuggingFaceResolveUrl(detail.id, file.rfilename),
      fileName,
      highVramWarning: catalogRequirements,
      installRelativePath,
      modelType: plan?.modelType || file.modelType,
      name: detail.id,
      packageIdentity: plan?.packageIdentity || file.packageIdentity || null,
      packageName: plan?.packageName || null,
      packageRoot: plan?.packageRoot || null,
      sourceArtifactPath: isPackagePlan ? (plan.packageRoot || detail.id) : file.rfilename,
      previewUrl,
      sizeBytes: Number(plan?.sizeBytes || file.sizeBytes || 0),
      source: 'huggingface',
      toolId: tool.id,
    }, plan || file.downloadPlan, getTargetDirectory(tool, plan?.modelType || file.modelType, { ...file, catalogRepositoryId: detail.id })),
    tool,
    hardwareContext,
  );
}
function buildHuggingFaceBlockedRepositoryResult(detail, plan, tool, hardwareContext, catalogRequirements, previewUrl) {
  return attachHardwareHints(
    attachDownloadPlanFields({
      id: 'huggingface:repository:' + detail.id + ':blocked',
      author: detail.author || null,
      catalogEntityLabel: 'Repository',
      catalogEntityType: 'repository',
      catalogContext: 'No compatible primary artifact found for this target.',
      catalogRepositoryId: detail.id,
      catalogRequirements,
      description: buildHuggingFaceDescription(detail),
      downloaded: false,
      downloadUrl: null,
      fileName: '',
      highVramWarning: catalogRequirements,
      installRelativePath: '',
      modelType: 'Incompatible',
      name: detail.id,
      previewUrl,
      sizeBytes: 0,
      source: 'huggingface',
      toolId: tool.id,
    }, plan, null),
    tool,
    hardwareContext,
  );
}
function buildHuggingFaceArtifactResult(detail, file, tool, downloadedLookup, hardwareContext, catalogRequirements, previewUrl) {
  const fileName = path.basename(file.rfilename || '');
  const nestedPath = String(file.rfilename || '').trim();
  const installRelativePath = normalizeRelativeInstallPath(nestedPath || fileName) || fileName;
  return attachHardwareHints(
    attachDownloadPlanFields({
      id: 'huggingface:artifact:' + detail.id + ':' + normalizePathForId(nestedPath || fileName),
      author: detail.author || null,
      catalogEntityLabel: 'Artifact',
      catalogEntityType: 'artifact',
      catalogParentLabel: detail.id,
      catalogContext: nestedPath && nestedPath !== fileName ? `Repository path: ${nestedPath}` : null,
      catalogRepositoryId: detail.id,
      catalogRequirements,
      description: `File from ${detail.id} | ${buildHuggingFaceDescription(detail)}`,
      downloaded: isDownloadedMatch(downloadedLookup, [buildSourceDownloadIdentity({ source: 'huggingface', toolId: tool.id, catalogRepositoryId: detail.id, sourceArtifactPath: file.rfilename, installRelativePath, fileName })]),
      downloadIdentity: buildSourceDownloadIdentity({ source: 'huggingface', toolId: tool.id, catalogRepositoryId: detail.id, sourceArtifactPath: file.rfilename, installRelativePath, fileName }),
      downloadUrl: buildHuggingFaceResolveUrl(detail.id, file.rfilename),
      fileName,
      highVramWarning: catalogRequirements,
      installRelativePath,
      modelType: file.modelType,
      name: fileName,
      previewUrl,
      sizeBytes: Number(file.sizeBytes || 0),
      source: 'huggingface',
      sourceArtifactPath: file.rfilename,
      toolId: tool.id,
    }, file.downloadPlan, getTargetDirectory(tool, file.modelType, { ...file, catalogRepositoryId: detail.id })),
    tool,
    hardwareContext,
  );
}
async function searchHuggingFaceModels(tool, browseOptions, downloadedLookup, hardwareContext, logger) {
  const modelItems = [];
  const artifactItems = [];
  const catalogRequirements = getCatalogRequirements(browseOptions);
  const query = String(browseOptions.query || '').trim();
  if (String(tool?.id || '').trim().toLowerCase() === 'upscayl' && !isRepositoryIdSearchQuery(query)) {
    return {
      items: [],
      pagination: {
        hasMore: false,
        nextCursor: null,
        nextPage: null,
      },
    };
  }
  const defaultSeedModelIds = new Set(!query && isPackageTool(tool)
    ? getPackageDefaultSeedModelIds(tool).map((id) => String(id || '').trim().toLowerCase()).filter(Boolean)
    : []);
  let sawNonSeedCompatibleModel = false;
  const fileLevelSearch = Boolean(query) && isFileLikeSearchQuery(query);
  const artifactLevelSearch = Boolean(query) && isArtifactLevelSearchQuery(query);
  const repositoryIdSearch = Boolean(query) && isRepositoryIdSearchQuery(query);
  let rawCursor = browseOptions.cursor;
  let nextCursor = null;
  for (let scanCount = 0; scanCount < 3; scanCount += 1) {
    throwIfModelBrowseCanceled();
    const existingItems = mergeCatalogSearchItems(getCatalogSearchGroups(modelItems, artifactItems, fileLevelSearch), browseOptions.limit);
    if (existingItems.length >= browseOptions.limit) {
      break;
    }
    const page = await fetchHuggingFacePage(tool, { ...browseOptions, cursor: rawCursor }, logger);
    const pageDetails = await fetchHuggingFaceDetails(page.results, logger);
    const seedDetails = scanCount === 0 && !rawCursor ? await fetchHuggingFaceSeedDetails(browseOptions, logger, tool) : [];
    let details = mergeUniqueDetailsById([...seedDetails, ...pageDetails]);
    if (repositoryIdSearch) {
      const exactDetails = details.filter((detail) => String(detail.id || '').toLowerCase() === query.toLowerCase());
      if (exactDetails.length) {
        details = exactDetails;
      }
    }
    for (const detail of details) {
      throwIfModelBrowseCanceled();
      const detailId = String(detail?.id || '').trim().toLowerCase();
      const isDefaultSeedDetail = defaultSeedModelIds.has(detailId);
      const previewUrl = await resolveHuggingFacePreview(detail, logger);
      const matchingArtifacts = artifactLevelSearch ? await resolveHuggingFaceArtifactFiles(detail, browseOptions, logger, tool) : [];
      const primaryFile = matchingArtifacts[0] || (await resolveHuggingFaceDownloadFile(detail, browseOptions.modelType, logger, tool));
      if (primaryFile) {
        if (!isDefaultSeedDetail) {
          sawNonSeedCompatibleModel = true;
        }
        modelItems.push(
          buildHuggingFaceRepositoryResult(detail, primaryFile, tool, downloadedLookup, hardwareContext, catalogRequirements, previewUrl),
        );
      } else if (query) {
        const plan = await resolveHuggingFaceDownloadPlan(detail, browseOptions.modelType, logger, tool);
        if (plan && plan.runnable === false && plan.rejectedArtifacts?.length) {
          if (!isDefaultSeedDetail) {
            sawNonSeedCompatibleModel = true;
          }
          modelItems.push(buildHuggingFaceBlockedRepositoryResult(detail, plan, tool, hardwareContext, catalogRequirements, previewUrl));
        }
      }
      const mergedItems = mergeCatalogSearchItems(getCatalogSearchGroups(modelItems, artifactItems, fileLevelSearch), browseOptions.limit);
      if (mergedItems.length >= browseOptions.limit) {
        break;
      }
    }
    nextCursor = page.nextCursor;
    const mergedItems = mergeCatalogSearchItems(getCatalogSearchGroups(modelItems, artifactItems, fileLevelSearch), browseOptions.limit);
    if (!nextCursor || mergedItems.length >= browseOptions.limit) {
      break;
    }
    rawCursor = nextCursor;
  }
  const items = mergeCatalogSearchItems(getCatalogSearchGroups(modelItems, artifactItems, fileLevelSearch), browseOptions.limit);
  const suppressSeedOnlyLoadMore = defaultSeedModelIds.size > 0 && items.length > 0 && !sawNonSeedCompatibleModel;
  return {
    items,
    pagination: {
      hasMore: suppressSeedOnlyLoadMore ? false : Boolean(nextCursor),
      nextCursor: suppressSeedOnlyLoadMore ? null : nextCursor,
      nextPage: null,
    },
  };
}
function buildCivitaiHeaders(settings) {
  const apiKey = String(settings?.civitaiApiKey || '').trim();
  if (!apiKey) {
    return {
      'User-Agent': APP_USER_AGENT,
    };
  }
  return {
    'User-Agent': APP_USER_AGENT,
    Authorization: `Bearer ${apiKey}`,
  };
}
function isGenericCivitaiFileType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized === 'model' || normalized === 'file' || normalized === 'other' || normalized === 'unknown';
}
function resolveCivitaiVersionFileType(model, file) {
  const fileType = String(file?.type || '').trim();
  const parentType = String(model?.type || '').trim();
  if (fileType && !isGenericCivitaiFileType(fileType)) {
    return normalizeModelType(fileType);
  }
  if (parentType && !isGenericCivitaiFileType(parentType)) {
    return normalizeModelType(parentType);
  }
  return normalizeModelType(fileType || file?.name || parentType);
}
function collectCivitaiVersionFiles(model, selectedType, tool = null) {
  const entries = (model.modelVersions || []).flatMap((version) =>
    (version.files || []).map((file) => ({
      file: {
        ...file,
        name: String(file.name || '').trim(),
        normalizedType: resolveCivitaiVersionFileType(model, file),
        rfilename: String(file.name || '').trim(),
        sizeBytes: Number(file.sizeBytes || 0) || toFileSizeBytes(Number(file.sizeKB || 0)),
      },
      version,
    })),
  );
  const plannedPaths = tool
    ? new Set(
        annotateArtifactsForDownloadPlan({
          artifacts: entries.map((entry) => ({ ...entry.file, modelType: entry.file.normalizedType, primary: entry.file.primary })),
          selectedType,
          source: 'civitai',
          tool,
        })
          .filter((entry) => entry.runnable)
          .map((entry) => artifactPath(entry)),
      )
    : null;
  return entries
    .filter((entry) => (plannedPaths ? plannedPaths.has(artifactPath(entry.file)) : matchesSelectedModelType(entry.file.normalizedType, selectedType)))
    .map((entry) => ({
      ...entry,
      file: tool
        ? annotateArtifactsForDownloadPlan({ artifacts: [{ ...entry.file, modelType: entry.file.normalizedType }], selectedType, source: 'civitai', tool })[0]
        : entry.file,
    }))
    .sort((left, right) => {
      const primaryOrder = Number(Boolean(right.file.primary)) - Number(Boolean(left.file.primary));
      if (primaryOrder !== 0) {
        return primaryOrder;
      }
      const publishedDelta = parseSortableTimestamp(right.version?.publishedAt) - parseSortableTimestamp(left.version?.publishedAt);
      if (publishedDelta !== 0) {
        return publishedDelta;
      }
      return Number(right.file.sizeBytes || 0) - Number(left.file.sizeBytes || 0);
    });
}
function normalizeCivitaiNextCursor(metadata) {
  const directCursor = String(metadata?.nextCursor || '').trim();
  if (directCursor) {
    return directCursor;
  }
  if (typeof metadata?.nextPage === 'string') {
    try {
      return String(new URL(metadata.nextPage).searchParams.get('cursor') || '').trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}
function buildCivitaiDescription(model) {
  return stripHtml(model.description) || 'CivitAI ' + (model.type || 'model') + ' by ' + (model.creator?.username || 'the community');
}
function formatCivitaiVersionLabel(version) {
  return String(version?.name || version?.id || 'latest').trim() || 'latest';
}
function buildCivitaiModelResult(model, entry, tool, downloadedLookup, hardwareContext, catalogRequirements) {
  const fileName = String(entry?.file?.name || '').trim();
  const versionLabel = formatCivitaiVersionLabel(entry?.version);
  const previewImage = entry?.version?.images?.find((image) => image.type === 'image');
  const installRelativePath = normalizeRelativeInstallPath(fileName) || fileName;
  const identity = buildSourceDownloadIdentity({
    source: 'civitai',
    toolId: tool.id,
    catalogModelId: model.id,
    catalogVersionId: entry.version?.id,
    catalogVersionLabel: versionLabel,
    sourceFileId: entry.file.id,
    sourceArtifactPath: fileName,
    installRelativePath,
    fileName,
  });
  return attachHardwareHints(
    attachDownloadPlanFields({
      id: 'civitai:model:' + model.id,
      author: model.creator?.username || null,
      catalogEntityLabel: 'Model',
      catalogEntityType: 'model',
      catalogContext: `Primary version: ${versionLabel} | Primary artifact: ${fileName}`,
      catalogModelId: String(model.id || ''),
      catalogRequirements,
      catalogVersionId: entry.version?.id ? String(entry.version.id) : null,
      catalogVersionLabel: versionLabel,
      description: buildCivitaiDescription(model),
      downloaded: isDownloadedMatch(downloadedLookup, [identity]),
      downloadIdentity: identity,
      downloadUrl: entry.file.downloadUrl || entry.version.downloadUrl,
      fileName,
      highVramWarning: catalogRequirements,
      installRelativePath,
      modelType: entry.file.normalizedType,
      name: model.name,
      previewUrl: previewImage?.url || null,
      sizeBytes: entry.file.sizeBytes,
      source: 'civitai',
      sourceArtifactPath: fileName,
      sourceFileId: entry.file.id ? String(entry.file.id) : null,
      toolId: tool.id,
    }, entry.file.downloadPlan, getTargetDirectory(tool, entry.file.normalizedType, entry.file)),
    tool,
    hardwareContext,
  );
}
function buildCivitaiArtifactResult(model, entry, tool, downloadedLookup, hardwareContext, catalogRequirements) {
  const fileName = String(entry?.file?.name || '').trim();
  const versionLabel = formatCivitaiVersionLabel(entry?.version);
  const previewImage = entry?.version?.images?.find((image) => image.type === 'image');
  const installRelativePath = normalizeRelativeInstallPath(fileName) || fileName;
  const identity = buildSourceDownloadIdentity({
    source: 'civitai',
    toolId: tool.id,
    catalogModelId: model.id,
    catalogVersionId: entry.version?.id,
    catalogVersionLabel: versionLabel,
    sourceFileId: entry.file.id,
    sourceArtifactPath: fileName,
    installRelativePath,
    fileName,
  });
  return attachHardwareHints(
    attachDownloadPlanFields({
      id: 'civitai:artifact:' + model.id + ':' + String(entry?.version?.id || versionLabel) + ':' + fileName,
      author: model.creator?.username || null,
      catalogEntityLabel: 'Artifact',
      catalogEntityType: 'artifact',
      catalogParentLabel: model.name,
      catalogContext: `Version: ${versionLabel}`,
      catalogModelId: String(model.id || ''),
      catalogRequirements,
      catalogVersionId: entry.version?.id ? String(entry.version.id) : null,
      catalogVersionLabel: versionLabel,
      description: `File from ${model.name} | Version ${versionLabel} | ${buildCivitaiDescription(model)}`,
      downloaded: isDownloadedMatch(downloadedLookup, [identity]),
      downloadIdentity: identity,
      downloadUrl: entry.file.downloadUrl || entry.version.downloadUrl,
      fileName,
      highVramWarning: catalogRequirements,
      installRelativePath,
      modelType: entry.file.normalizedType,
      name: fileName,
      previewUrl: previewImage?.url || null,
      sizeBytes: entry.file.sizeBytes,
      source: 'civitai',
      sourceArtifactPath: fileName,
      sourceFileId: entry.file.id ? String(entry.file.id) : null,
      toolId: tool.id,
    }, entry.file.downloadPlan, getTargetDirectory(tool, entry.file.normalizedType, entry.file)),
    tool,
    hardwareContext,
  );
}async function searchCivitaiModels(tool, browseOptions, downloadedLookup, settings, hardwareContext, logger) {
  const selectedModelType = normalizeModelTypeFilter(browseOptions.modelType);
  const selectedTaskType = normalizeTaskTypeFilter(browseOptions.taskType);
  const modelTypeProfile = getModelTypeProfile(selectedModelType);
  const derivedSearchTerms = getDerivedSearchTerms(browseOptions);
  const derivedSearchQuery = derivedSearchTerms.find(Boolean) || '';
  const catalogRequirements = getCatalogRequirements(browseOptions);
  const fileLevelSearch = Boolean(derivedSearchQuery) && isFileLikeSearchQuery(derivedSearchQuery);
  const apiSearchQuery = fileLevelSearch
    ? getSearchQueryVariants(derivedSearchQuery).find((variant) => !MODEL_FILE_PATTERN.test(variant) && variant.length < derivedSearchQuery.length) || derivedSearchQuery
    : derivedSearchQuery;
  if (selectedModelType === 'gguf' || selectedModelType === 'audio-speech' || selectedModelType === 'rvc-voice' || selectedTaskType === 'audio-speech' || selectedTaskType === 'voice-conversion') {
    return {
      items: [],
      pagination: {
        hasMore: false,
        nextCursor: null,
        nextPage: null,
      },
    };
  }
  const searchUrl = new URL(CIVITAI_MODELS_URL);
  searchUrl.searchParams.set('limit', String(browseOptions.limit));
  searchUrl.searchParams.set('sort', CIVITAI_SORT_MAP[browseOptions.sort] || CIVITAI_SORT_MAP['most-downloaded']);
  searchUrl.searchParams.set('period', 'AllTime');
  if (browseOptions.cursor) {
    searchUrl.searchParams.set('cursor', browseOptions.cursor);
  }
  if (apiSearchQuery) {
    searchUrl.searchParams.set('query', apiSearchQuery);
  }
  const mappedTypes = [...(modelTypeProfile.civitaiTypes || [])];
  if (selectedTaskType === 'video-generation' || selectedTaskType === 'image-to-video') {
    mappedTypes.push('MotionModule');
  }
  for (const type of mergeUniqueStrings(mappedTypes)) {
    searchUrl.searchParams.append('types', type);
  }
  await logger.info('Searching CivitAI models.', {
    cursor: browseOptions.cursor,
    modelType: browseOptions.modelType,
    page: browseOptions.page,
    query: apiSearchQuery,
    sort: browseOptions.sort,
    taskType: browseOptions.taskType,
    toolId: tool.id,
    types: mergeUniqueStrings(mappedTypes),
  });
  const { payload } = await fetchJsonResponse(searchUrl, {
    headers: buildCivitaiHeaders(settings),
  });
  const modelItems = [];
  const artifactItems = [];
  for (const model of payload.items || []) {
    throwIfModelBrowseCanceled();
    const candidateFiles = collectCivitaiVersionFiles(model, browseOptions.modelType, tool);
    const matchingFiles = derivedSearchQuery
      ? candidateFiles.filter((entry) =>
          matchesSearchQuery(derivedSearchQuery, [
            entry.file.name,
            entry.version?.name,
            entry.version?.baseModel,
            entry.version?.baseModelType,
          ]),
        )
      : [];
    const primaryEntry = (fileLevelSearch && matchingFiles[0]) || candidateFiles[0] || null;
    if (primaryEntry) {
      modelItems.push(buildCivitaiModelResult(model, primaryEntry, tool, downloadedLookup, hardwareContext, catalogRequirements));
    }
    if (!primaryEntry && matchingFiles.length) {
      for (const entry of matchingFiles) {
        artifactItems.push(buildCivitaiArtifactResult(model, entry, tool, downloadedLookup, hardwareContext, catalogRequirements));
      }
    }
    const mergedItems = mergeCatalogSearchItems(getCatalogSearchGroups(modelItems, artifactItems, fileLevelSearch), browseOptions.limit);
    if (mergedItems.length >= browseOptions.limit) {
      break;
    }
  }
  const nextCursor = normalizeCivitaiNextCursor(payload.metadata);
  const items = mergeCatalogSearchItems(getCatalogSearchGroups(modelItems, artifactItems, fileLevelSearch), browseOptions.limit);
  return {
    items,
    pagination: {
      hasMore: Boolean(nextCursor),
      nextCursor,
      nextPage: null,
    },
  };
}
async function browseRemoteModels(tool, options = {}, context = {}) {
  return MODEL_BROWSE_CONTEXT.run({ signal: context.signal || null }, async () => {
    throwIfModelBrowseCanceled();
    const browseOptions = normalizeBrowseOptions(options, tool);
    const logger = createLogger('models', {
      toolId: tool?.id,
      mode: 'browse',
      source: browseOptions.source,
    });
    if (!supportsModelManager(tool)) {
      throw new Error('This tool does not have Model Manager browsing enabled yet.');
    }
    const settings = await readModelSettingsInternal();
    const publicSettings = {
      ...stripModelManagerSecrets(settings),
      civitaiApiKey: '',
      civitaiCredentialSource: settings.civitaiCredentialSource || 'missing',
      civitaiEnvVarName: settings.civitaiEnvVarName || 'CIVITAI_API_KEY',
      hasCivitaiApiKey: Boolean(settings.hasCivitaiApiKey),
      hasSavedCivitaiApiKey: Boolean(settings.hasSavedCivitaiApiKey),
    };
    const localModels = await listDownloadedModels(tool, { signal: context.signal }).catch((error) => {
      rethrowModelBrowseCancellation(error);
      return [];
    });
    throwIfModelBrowseCanceled();
    const downloadedLookup = buildDownloadedLookup(localModels);
    const hardwareContext = await loadHardwareContext();
    throwIfModelBrowseCanceled();
    if (tool.id === 'ollama') {
      const result = await searchOllamaLibrary(tool, browseOptions, downloadedLookup, hardwareContext, logger);
      return {
        items: result.items,
        localModels,
        pagination: result.pagination,
        settings: publicSettings,
      };
    }
    if (browseOptions.source === 'tabby') {
      const result = await searchTabbyRegistryModels(tool, browseOptions, downloadedLookup, hardwareContext, logger);
      return {
        items: result.items,
        localModels,
        pagination: result.pagination,
        settings: publicSettings,
      };
    }
    if (browseOptions.source === 'civitai') {
      const result = await searchCivitaiModels(tool, browseOptions, downloadedLookup, settings, hardwareContext, logger);
      return {
        items: result.items,
        localModels,
        pagination: result.pagination,
        settings: publicSettings,
      };
    }
    const result = await searchHuggingFaceModels(tool, browseOptions, downloadedLookup, hardwareContext, logger);
    return {
      items: result.items,
      localModels,
      pagination: result.pagination,
      settings: publicSettings,
    };
  });
}function parseOllamaCompactNumber(value) {
  const match = String(value || '').trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMBT])?$/i);
  if (!match) {
    return 0;
  }
  const amount = Number.parseFloat(match[1]);
  const suffix = String(match[2] || '').toUpperCase();
  const multiplier = {
    '': 1,
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
    T: 1_000_000_000_000,
  }[suffix];
  if (!Number.isFinite(amount) || !Number.isFinite(multiplier)) {
    return 0;
  }
  return Math.round(amount * multiplier);
}
function parseOllamaSizeBytes(sizeLabels = []) {
  for (const sizeLabel of sizeLabels || []) {
    if (!/[KMGT]B$/i.test(String(sizeLabel || '').trim())) {
      continue;
    }
    const sizeBytes = parseHumanSizeToBytes(sizeLabel);
    if (sizeBytes > 0) {
      return sizeBytes;
    }
  }
  return 0;
}
function buildOllamaAbsoluteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  if (raw.startsWith('/')) {
    return `https://ollama.com${raw}`;
  }
  return `https://ollama.com/${raw.replace(/^\/+/, '')}`;
}
function parseOllamaQueryTokens(value) {
  return [...new Set(
    String(value || '')
      .toLowerCase()
      .split(/[\s:\/_-]+/)
      .map((token) => token.trim())
      .filter(Boolean),
  )];
}
function matchesOllamaQuery(entry, query) {
  const queryTokens = parseOllamaQueryTokens(query);
  if (!queryTokens.length) {
    return true;
  }
  const candidateTokens = parseOllamaQueryTokens(
    [
      entry?.contextLabel,
      entry?.description,
      entry?.familyDescription,
      entry?.familyName,
      entry?.inputLabel,
      entry?.name,
      entry?.sizeLabel,
      entry?.updatedLabel,
      ...(entry?.capabilities || []),
      ...(entry?.sizeLabels || []),
    ]
      .filter(Boolean)
      .join(' '),
  );
  if (!candidateTokens.length) {
    return false;
  }
  return queryTokens.every((queryToken) => candidateTokens.some((candidateToken) => candidateToken.includes(queryToken)));
}
function isOllamaVariantQuery(query) {
  const normalized = String(query || '').trim();
  return normalized.includes(':') || /\b\d+(?:\.\d+)?\s*[bmkt]\b/i.test(normalized);
}
function extractOllamaFamilyDescription(html, fallbackDescription) {
  const metaDescription = String(html || '').match(/<meta name="description" content="([^"]*)"/i);
  return stripHtml(metaDescription?.[1]) || fallbackDescription;
}
function extractOllamaFamilySearchText(html) {
  const readmeMatch = String(html || '').match(/<div[^>]+id="display"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div id="editorContainer"/i);
  return stripHtml(readmeMatch?.[1] || '').slice(0, 4000);
}
function extractOllamaFamilyPreviewUrl(html) {
  const previewMatch =
    String(html || '').match(/<img[^>]+src="((?:https?:\/\/ollama\.com)?\/assets\/library\/[^"]+)"/i) ||
    String(html || '').match(/&lt;img src=&#34;((?:https?:\/\/ollama\.com)?\/assets\/library\/[^"&]+)&#34;/i);
  return buildOllamaAbsoluteUrl(previewMatch?.[1] || '');
}
function parseOllamaFamilyVariants(html, familyName) {
  const variants = [];
  const sectionMatch = String(html || '').match(/<section class="flex flex-1 flex-col">[\s\S]*?<h2 class="text-base font-semibold leading-6 text-neutral-900">Models<\/h2>[\s\S]*?<\/section>/i);
  const sectionHtml = sectionMatch?.[0] || '';
  if (!sectionHtml) {
    return variants;
  }
  const rowPattern = /<div class="hidden group[^"]*sm:grid[^"]*">[\s\S]*?<a href="\/library\/([^"#?]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<p class="col-span-2 text-neutral-500">([^<]+)<\/p>[\s\S]*?<p class="col-span-2 text-neutral-500">([^<]+)<\/p>[\s\S]*?<p class="col-span-2 text-neutral-500">\s*([^<]+?)\s*<\/p>[\s\S]*?<\/div>/gi;
  let match = null;
  while ((match = rowPattern.exec(sectionHtml)) !== null) {
    const variantName = stripHtml(match[2]);
    const sizeLabel = stripHtml(match[3]);
    const contextLabel = stripHtml(match[4]);
    const inputLabel = stripHtml(match[5]);
    if (!variantName) {
      continue;
    }
    variants.push({
      contextLabel: contextLabel ? `${contextLabel} context window` : null,
      familyName,
      inputLabel: inputLabel || null,
      isLatestAlias: /:latest$/i.test(variantName),
      libraryPath: `/library/${match[1]}`,
      latest: /text-blue-600">latest<\/span>/i.test(match[0]),
      name: variantName,
      sizeBytes: parseHumanSizeToBytes(sizeLabel),
      sizeLabel: sizeLabel || 'Unknown',
      updatedLabel: null,
    });
  }
  return variants;
}
async function fetchOllamaFamilyDetails(entry, logger) {
  const cacheKey = String(entry?.slug || entry?.name || '').trim().toLowerCase();
  if (!cacheKey) {
    return {
      description: entry?.description || 'Ollama model',
      previewUrl: entry?.previewUrl || null,
      variants: [],
    };
  }
  if (OLLAMA_FAMILY_CACHE.has(cacheKey)) {
    return OLLAMA_FAMILY_CACHE.get(cacheKey);
  }

  const familyUrl = buildOllamaAbsoluteUrl(entry.libraryPath || `/library/${entry.slug || entry.name}`);
  try {
    throwIfModelBrowseCanceled();
    const response = await fetch(familyUrl, withModelBrowseSignal({
      headers: {
        'User-Agent': APP_USER_AGENT,
      },
    }));
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}.`);
    }
    const html = await response.text();
    throwIfModelBrowseCanceled();
    const details = {
      description: extractOllamaFamilyDescription(html, entry.description || `Ollama model ${entry.name}`),
      previewUrl: extractOllamaFamilyPreviewUrl(html) || entry.previewUrl || null,
      searchText: extractOllamaFamilySearchText(html),
      variants: parseOllamaFamilyVariants(html, entry.name),
    };
    OLLAMA_FAMILY_CACHE.set(cacheKey, details);
    return details;
  } catch (error) {
    rethrowModelBrowseCancellation(error);
    await logger.warn('An Ollama family page could not be loaded.', {
      error,
      family: entry.name,
      url: familyUrl,
    }).catch(() => null);
    return {
      description: entry.description || `Ollama model ${entry.name}`,
      previewUrl: entry.previewUrl || null,
      searchText: '',
      variants: [],
    };
  }
}function getOllamaDefaultVariant(familyDetails) {
  const variants = familyDetails?.variants || [];
  return variants.find((variant) => variant.latest && !variant.isLatestAlias) || variants.find((variant) => variant.isLatestAlias) || variants.find((variant) => variant.latest) || variants[0] || null;
}
function buildOllamaFamilyCard(entry, familyDetails) {
  const defaultVariant = getOllamaDefaultVariant(familyDetails);
  const pullName = defaultVariant?.name || entry.fileName || entry.name;
  return {
    ...entry,
    artifactKind: 'ollama-tag',
    artifactLabel: 'Ollama tag',
    catalogContext: defaultVariant?.name && defaultVariant.name !== entry.name ? `Default variant: ${defaultVariant.name}` : null,
    catalogEntityLabel: 'Model',
    catalogEntityType: 'model',
    description: familyDetails?.description || entry.description,
    familySearchText: familyDetails?.searchText || '',
    downloadPlan: ollamaTagPlan(pullName),
    fileName: pullName,
    previewUrl: familyDetails?.previewUrl || entry.previewUrl || null,
    sizeBytes: defaultVariant?.sizeBytes || entry.sizeBytes || 0,
    sizeLabel: defaultVariant?.sizeLabel || entry.sizeLabel,
  };
}
function buildOllamaVariantCard(entry, familyDetails, variant) {
  return {
    artifactKind: 'ollama-tag',
    artifactLabel: 'Ollama tag',
    capabilities: entry.capabilities,
    catalogContext: [variant.sizeLabel, variant.contextLabel, variant.inputLabel].filter(Boolean).join(' | ') || null,
    catalogEntityLabel: 'Variant',
    catalogEntityType: 'variant',
    catalogParentLabel: entry.name,
    contextLabel: variant.contextLabel,
    description: familyDetails?.description || entry.description,
    downloadPlan: ollamaTagPlan(variant.name),
    downloadUrl: null,
    familyDescription: familyDetails?.description || entry.description,
    familyName: entry.name,
    familySearchText: familyDetails?.searchText || '',
    fileName: variant.name,
    id: `ollama:${variant.name}`,
    inputLabel: variant.inputLabel,
    libraryPath: variant.libraryPath,
    modelType: 'Model',
    name: variant.name,
    previewUrl: familyDetails?.previewUrl || entry.previewUrl || null,
    sizeBytes: variant.sizeBytes,
    sizeLabel: variant.sizeLabel,
    source: 'ollama',
    toolId: 'ollama',
    updatedLabel: variant.updatedLabel || entry.updatedLabel,
  };
}
function matchesOllamaVariantQuery(entry, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const [familyPart, suffixPart = ''] = normalizedQuery.split(':', 2);
  const normalizedFamilyName = String(entry?.familyName || '').trim().toLowerCase();
  if (familyPart && normalizedFamilyName && normalizedFamilyName !== familyPart) {
    return false;
  }
  const suffixTokens = parseOllamaQueryTokens(suffixPart);
  const requiredPrimaryTokens = [...new Set([...parseOllamaQueryTokens(familyPart), ...(suffixTokens[0] ? [suffixTokens[0]] : [])])];
  const primaryTokens = parseOllamaQueryTokens(
    [entry?.familyName, entry?.name, entry?.sizeLabel, entry?.contextLabel, entry?.inputLabel]
      .filter(Boolean)
      .join(' '),
  );
  const secondaryTokens = parseOllamaQueryTokens(
    [entry?.description, entry?.familyDescription, entry?.familySearchText, ...(entry?.capabilities || [])]
      .filter(Boolean)
      .join(' '),
  );
  const allTokens = parseOllamaQueryTokens(normalizedQuery);
  if (!requiredPrimaryTokens.every((queryToken) => primaryTokens.some((candidateToken) => candidateToken.includes(queryToken)))) {
    return false;
  }
  return allTokens.every(
    (queryToken) =>
      primaryTokens.some((candidateToken) => candidateToken.includes(queryToken)) ||
      secondaryTokens.some((candidateToken) => candidateToken.includes(queryToken)),
  );
}
function extractOllamaRepoMarkup(html) {
  const marker = '<div x-test-repos id="repo">';
  const startIndex = String(html || '').indexOf(marker);
  if (startIndex < 0) {
    return String(html || '');
  }
  const endIndex = html.indexOf('</main>', startIndex);
  return endIndex > startIndex ? html.slice(startIndex, endIndex) : html.slice(startIndex);
}
function extractOllamaTextValues(cardHtml, pattern) {
  const values = [];
  let match = null;
  while ((match = pattern.exec(cardHtml)) !== null) {
    values.push(stripHtml(match[1]));
  }
  return values.filter(Boolean);
}
function parseOllamaLibraryCards(html) {
  const repoMarkup = extractOllamaRepoMarkup(html);
  const results = [];
  const cardPattern = /<li[^>]*x-test-model[^>]*>[\s\S]*?<a href="\/library\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi;
  let match = null;
  while ((match = cardPattern.exec(repoMarkup)) !== null) {
    const slug = stripHtml(match[1]);
    const name = stripHtml(match[1]);
    const cardHtml = match[2];
    const descriptionMatch = cardHtml.match(/<p[^>]*text-neutral-800[^>]*>([\s\S]*?)<\/p>/i);
    const sizeLabels = extractOllamaTextValues(cardHtml, /x-test-size[^>]*>([^<]+)</gi);
    const capabilities = extractOllamaTextValues(cardHtml, /x-test-capability[^>]*>([^<]+)</gi);
    const pullsMatch = cardHtml.match(/x-test-pull-count>([^<]+)</i);
    const tagsMatch = cardHtml.match(/x-test-tag-count>([^<]+)</i);
    const updatedMatch = cardHtml.match(/x-test-updated>([^<]+)</i);
    const isCloudModel = /bg-cyan-50[^>]*>cloud</i.test(cardHtml);
    const sizeBytes = parseOllamaSizeBytes(sizeLabels);
    const sizeLabel = sizeLabels.length ? sizeLabels.join(' / ') : isCloudModel ? 'Cloud model' : 'Available from Ollama';
    if (!name) {
      continue;
    }
    results.push({
      capabilities,
      description: stripHtml(descriptionMatch?.[1]) || `Ollama model ${name}`,
      downloadUrl: null,
      fileName: name,
      id: `ollama:${name}`,
      libraryPath: `/library/${slug}`,
      modelType: 'Model',
      name,
      previewUrl: null,
      pulls: parseOllamaCompactNumber(pullsMatch?.[1] || ''),
      sizeBytes,
      sizeLabel,
      sizeLabels,
      slug,
      source: 'ollama',
      tagCount: Number.parseInt(String(tagsMatch?.[1] || '').replace(/[^0-9]/g, ''), 10) || 0,
      toolId: 'ollama',
      updatedLabel: stripHtml(updatedMatch?.[1]) || null,
    });
  }
  return results;
}
function normalizeOllamaSort(sort) {
  return sort === 'newest' ? 'newest' : 'popular';
}
async function searchOllamaLibrary(tool, browseOptions, downloadedLookup, hardwareContext, logger) {
  const searchUrl = new URL(OLLAMA_LIBRARY_URL);
  const normalizedQuery = String(browseOptions.query || '').trim();
  const normalizedSort = normalizeOllamaSort(browseOptions.sort);
  searchUrl.searchParams.set('sort', normalizedSort);
  await logger.info('Loading Ollama library page.', {
    page: browseOptions.page,
    query: normalizedQuery,
    sort: normalizedSort,
    url: searchUrl.toString(),
  });
  const response = await fetch(searchUrl, withModelBrowseSignal({
    headers: {
      'User-Agent': APP_USER_AGENT,
    },
  }));
  if (!response.ok) {
    throw new Error('Local AI Hub could not load the Ollama library list right now.');
  }
  const html = await response.text();
  const allFamilies = parseOllamaLibraryCards(html);
  const startIndex = (browseOptions.page - 1) * OLLAMA_PAGE_SIZE;
  const endIndex = startIndex + OLLAMA_PAGE_SIZE;
  if (!normalizedQuery) {
    const pageFamilies = allFamilies.slice(startIndex, endIndex);
    const items = await Promise.all(
      pageFamilies.map(async (entry) => {
        const familyDetails = await fetchOllamaFamilyDetails(entry, logger);
        const card = buildOllamaFamilyCard(entry, familyDetails);
        return attachHardwareHints(
          {
            ...card,
            downloaded:
              downloadedLookup.has(String(card.fileName || '').toLowerCase()) ||
              downloadedLookup.has(String(card.name || '').toLowerCase()),
          },
          tool,
          hardwareContext,
        );
      }),
    );
    return {
      items,
      pagination: {
        hasMore: endIndex < allFamilies.length,
        nextCursor: null,
        nextPage: endIndex < allFamilies.length ? browseOptions.page + 1 : null,
      },
    };
  }
  let matchedFamilies = allFamilies.filter((entry) => matchesOllamaQuery(entry, normalizedQuery));
  if (!matchedFamilies.length && normalizedQuery.includes(':')) {
    const familyQuery = normalizedQuery.split(':')[0].trim();
    matchedFamilies = allFamilies.filter((entry) => matchesOllamaQuery(entry, familyQuery));
  }
  const fullMatchCount = matchedFamilies.length;
  if (!matchedFamilies.length) {
    return {
      items: [],
      pagination: {
        hasMore: false,
        nextCursor: null,
        nextPage: null,
      },
    };
  }
  if (isOllamaVariantQuery(normalizedQuery)) {
    const variantItems = [];
    for (const entry of matchedFamilies) {
      const familyDetails = await fetchOllamaFamilyDetails(entry, logger);
      for (const variant of familyDetails.variants || []) {
        const card = buildOllamaVariantCard(entry, familyDetails, variant);
        if (!matchesOllamaVariantQuery(card, normalizedQuery)) {
          continue;
        }
        variantItems.push(
          attachHardwareHints(
            {
              ...card,
              downloaded:
                downloadedLookup.has(String(card.fileName || '').toLowerCase()) ||
                downloadedLookup.has(String(card.name || '').toLowerCase()) ||
                downloadedLookup.has(String(entry.name || '').toLowerCase()),
            },
            tool,
            hardwareContext,
          ),
        );
      }
    }
    if (variantItems.length) {
      return {
        items: variantItems.slice(startIndex, endIndex),
        pagination: {
          hasMore: endIndex < variantItems.length,
          nextCursor: null,
          nextPage: endIndex < variantItems.length ? browseOptions.page + 1 : null,
        },
      };
    }
  }
  const pageFamilies = matchedFamilies.slice(startIndex, endIndex);
  const items = await Promise.all(
    pageFamilies.map(async (entry) => {
      const familyDetails = await fetchOllamaFamilyDetails(entry, logger);
      const card = buildOllamaFamilyCard(entry, familyDetails);
      return attachHardwareHints(
        {
          ...card,
          downloaded:
            downloadedLookup.has(String(card.fileName || '').toLowerCase()) ||
            downloadedLookup.has(String(card.name || '').toLowerCase()),
        },
        tool,
        hardwareContext,
      );
    }),
  );
  return {
    items,
    pagination: {
      hasMore: endIndex < fullMatchCount,
      nextCursor: null,
      nextPage: endIndex < fullMatchCount ? browseOptions.page + 1 : null,
    },
  };
}
async function fetchTabbyRegistryHtml(logger) {
  let lastError = null;
  for (const registryUrl of TABBY_MODEL_REGISTRY_URLS) {
    try {
      await logger.info('Loading Tabby model registry.', {
        url: registryUrl,
      });
      const response = await fetch(registryUrl, withModelBrowseSignal({
        headers: {
          'User-Agent': APP_USER_AGENT,
        },
      }));
      if (!response.ok) {
        lastError = new Error(`Request failed with status ${response.status}.`);
        continue;
      }
      const html = await response.text();
      if (html.includes('<table>')) {
        return html;
      }
    } catch (error) {
      rethrowModelBrowseCancellation(error);
      lastError = error;
    }
  }
  throw new Error(humanizeError(lastError, 'Local AI Hub could not load the Tabby model registry right now.'));
}
function extractTabbyRepositoryId(urlValue) {
  try {
    const parsedUrl = new URL(urlValue);
    if (!/huggingface\.co$/i.test(parsedUrl.hostname)) {
      return null;
    }
    const parts = parsedUrl.pathname
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}
function extractTabbyRegistrySection(html, sectionId) {
  const sectionPattern = new RegExp(`<h2[^>]*id="${sectionId}"[^>]*>[\\s\\S]*?<table>[\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody><\\/table>`, 'i');
  const match = String(html || '').match(sectionPattern);
  return match?.[1] || '';
}
function parseTabbyRegistryEntries(html) {
  const mergedEntries = new Map();
  for (const [categoryId, sectionId] of Object.entries(TABBY_SECTION_IDS)) {
    const sectionMarkup = extractTabbyRegistrySection(html, sectionId);
    if (!sectionMarkup) {
      continue;
    }
    const rowPattern = /<tr>([\s\S]*?)<\/tr>/gi;
    let rowMatch = null;
    while ((rowMatch = rowPattern.exec(sectionMarkup)) !== null) {
      const rowHtml = rowMatch[1];
      const modelMatch = rowHtml.match(/<td>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/td>/i);
      if (!modelMatch) {
        continue;
      }
      const repoUrl = modelMatch[1];
      const repoId = extractTabbyRepositoryId(repoUrl);
      if (!repoId) {
        continue;
      }
      const name = stripHtml(modelMatch[2]) || repoId;
      const licenseText = stripHtml((rowHtml.match(/<td>\s*(?:<a[^>]*>)?([\s\S]*?)(?:<\/a>)?\s*<\/td>\s*$/i) || [])[1] || '');
      const existing = mergedEntries.get(repoId) || {
        categories: [],
        license: licenseText || 'License varies by model publisher.',
        name,
        repoId,
        repoUrl,
      };
      existing.categories = mergeUniqueStrings([...(existing.categories || []), categoryId]);
      existing.license = existing.license || licenseText || 'License varies by model publisher.';
      existing.name = existing.name || name;
      mergedEntries.set(repoId, existing);
    }
  }
  return [...mergedEntries.values()];
}
function getTabbyRegistryCategories(browseOptions, tool) {
  const selectedType = tool?.id === 'lmstudio' ? 'gguf' : normalizeModelTypeFilter(browseOptions.modelType);
  const selectedTaskType = normalizeTaskTypeFilter(browseOptions.taskType);
  if (selectedType === 'embedding') {
    return new Set(['embedding']);
  }
  if (selectedType === 'audio-speech' || !['all', 'text-generation'].includes(selectedTaskType)) {
    return new Set();
  }
  return new Set(['completion', 'chat']);
}
function matchesTabbyRegistryQuery(entry, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  return matchesSearchQuery(normalizedQuery, [entry.name, entry.repoId, entry.license, ...(entry.categories || []).map((category) => TABBY_SECTION_LABELS[category])]);
}
function parseSortableTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}
function compareTabbyRegistryDetails(left, right, sort) {
  if (sort === 'newest') {
    return (
      parseSortableTimestamp(right?.lastModified || right?.last_modified || right?.createdAt || right?.created_at) -
      parseSortableTimestamp(left?.lastModified || left?.last_modified || left?.createdAt || left?.created_at)
    );
  }
  if (sort === 'highest-rated') {
    return (Number(right?.likes || 0) || 0) - (Number(left?.likes || 0) || 0);
  }
  return (Number(right?.downloads || 0) || 0) - (Number(left?.downloads || 0) || 0);
}
async function searchTabbyRegistryModels(tool, browseOptions, downloadedLookup, hardwareContext, logger) {
  const registryHtml = await fetchTabbyRegistryHtml(logger);
  const allowedCategories = getTabbyRegistryCategories(browseOptions, tool);
  const fileLevelSearch = Boolean(browseOptions.query) && isFileLikeSearchQuery(browseOptions.query);
  if (!allowedCategories.size) {
    return {
      items: [],
      pagination: {
        hasMore: false,
        nextCursor: null,
        nextPage: null,
      },
    };
  }
  const entries = parseTabbyRegistryEntries(registryHtml)
    .filter((entry) => (entry.categories || []).some((category) => allowedCategories.has(category)))
    .filter((entry) => fileLevelSearch || matchesTabbyRegistryQuery(entry, browseOptions.query));
  if (!entries.length) {
    return {
      items: [],
      pagination: {
        hasMore: false,
        nextCursor: null,
        nextPage: null,
      },
    };
  }
  const details = await fetchHuggingFaceDetails(
    entries.map((entry) => ({
      gated: false,
      id: entry.repoId,
      private: false,
    })),
    logger,
  );
  const detailsById = new Map(details.map((detail) => [detail.id, detail]));
  const effectiveModelType = tool?.id === 'lmstudio' ? 'gguf' : browseOptions.modelType;
  const resolvedEntries = [];
  for (const entry of entries) {
    const detail = detailsById.get(entry.repoId);
    if (!detail) {
      continue;
    }
    const artifactMatches = fileLevelSearch
      ? await resolveHuggingFaceArtifactFiles(detail, { ...browseOptions, modelType: effectiveModelType }, logger, tool)
      : [];
    const file = artifactMatches[0] || (!fileLevelSearch ? await resolveHuggingFaceDownloadFile(detail, effectiveModelType, logger, tool) : null);
    if (!file) {
      continue;
    }
    resolvedEntries.push({
      detail,
      entry,
      file,
    });
  }
  resolvedEntries.sort((left, right) => {
    const detailSort = compareTabbyRegistryDetails(left.detail, right.detail, browseOptions.sort);
    if (detailSort !== 0) {
      return detailSort;
    }
    return String(left.entry.name || left.detail.id || '').localeCompare(String(right.entry.name || right.detail.id || ''));
  });
  const allItems = await Promise.all(
    resolvedEntries.map(async ({ detail, entry, file }) => {
      const fileName = path.basename(file.rfilename);
      const categoryLabels = mergeUniqueStrings((entry.categories || []).map((category) => TABBY_SECTION_LABELS[category])).join(' / ');
      const installRelativePath = normalizeRelativeInstallPath(file.rfilename || fileName) || fileName;
      const identity = buildSourceDownloadIdentity({ source: 'tabby', toolId: tool.id, catalogRepositoryId: detail.id, sourceArtifactPath: file.rfilename, installRelativePath, fileName });
      return attachHardwareHints(
        attachDownloadPlanFields({
          id: `tabby:repository:${detail.id}`,
          author: detail.author || null,
          catalogContext: [categoryLabels ? `Tabby ${categoryLabels}` : 'Tabby registry', `Repository: ${detail.id}`, file.rfilename ? `Primary artifact: ${file.rfilename}` : null]
            .filter(Boolean)
            .join(' | '),
          catalogEntityLabel: 'Repository',
          catalogEntityType: 'repository',
          catalogRepositoryId: detail.id,
          description: `Tabby ${categoryLabels || 'registry'} pick | ${buildHuggingFaceDescription(detail)} | ${entry.license}`,
          downloaded: isDownloadedMatch(downloadedLookup, [identity]),
          downloadIdentity: identity,
          downloadUrl: buildHuggingFaceResolveUrl(detail.id, file.rfilename),
          fileName,
          installRelativePath,
          modelType: file.modelType,
          name: entry.name || detail.id,
          previewUrl: await resolveHuggingFacePreview(detail, logger),
          sizeBytes: Number(file.sizeBytes || 0),
          source: 'tabby',
          sourceArtifactPath: file.rfilename,
          toolId: tool.id,
        }, file.downloadPlan, getTargetDirectory(tool, file.modelType, { ...file, catalogRepositoryId: detail.id })),
        tool,
        hardwareContext,
      );
    }),
  );
  const startIndex = (browseOptions.page - 1) * browseOptions.limit;
  const endIndex = startIndex + browseOptions.limit;
  return {
    items: allItems.slice(startIndex, endIndex),
    pagination: {
      hasMore: endIndex < allItems.length,
      nextCursor: null,
      nextPage: endIndex < allItems.length ? browseOptions.page + 1 : null,
    },
  };
}
function emitProgress(onProgress, payload) {
  if (typeof onProgress === 'function') {
    onProgress(payload);
  }
}
async function streamDownloadToFile(downloadUrl, destinationPath, options = {}) {
  const safeDownloadUrl = assertSecureRemoteUrl(downloadUrl, 'model download URL');
  const response = await fetch(safeDownloadUrl, {
    headers: options.headers || {},
  });
  if (!response.ok || !response.body) {
    throw new Error(options.errorMessage || `Download failed with status ${response.status}.`);
  }
  await fs.ensureDir(path.dirname(destinationPath));
  const tempPath = `${destinationPath}.download`;
  await fs.remove(tempPath).catch(() => null);
  const fileHandle = await open(tempPath, 'w');
  const reader = response.body.getReader();
  const reportedBytes = Number(response.headers.get('content-length')) || 0;
  const totalBytes = Number(options.expectedBytes || reportedBytes || 0);
  let downloadedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      downloadedBytes += chunk.length;
      await fileHandle.write(chunk, 0, chunk.length);
      emitProgress(options.onProgress, {
        downloadId: options.downloadId,
        message: options.progressMessage,
        percent: totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : null,
        receivedBytes: downloadedBytes,
        totalBytes,
      });
    }
  } finally {
    await fileHandle.close().catch(() => null);
  }
  await fs.move(tempPath, destinationPath, { overwrite: true });
  return {
    downloadedBytes,
    totalBytes,
    destinationPath,
  };
}
function assertRunnableDownloadPlan(payload = {}) {
  if (payload?.downloadPlan && payload.downloadPlan.runnable === false) {
    throw new Error(payload.downloadPlan.blockingReason || 'That catalog item is not compatible with the selected tool.');
  }
}
async function getModelDownloadPreflight(tool, payload = {}) {
  assertRunnableDownloadPlan(payload);
  const { targetDirectory } = resolveModelDestination(tool, payload);
  const sizeBytes = Number(payload.sizeBytes || 0);
  const { disk } = await getDiskSnapshotForPath(targetDirectory);
  return {
    ...assessDiskSpace(disk, sizeBytes),
    disk,
    modelName: String(payload.name || payload.fileName || 'This download').trim() || 'This download',
    sizeKnown: Number.isFinite(sizeBytes) && sizeBytes > 0,
    targetDirectory,
    toolId: tool.id,
    toolName: tool.name,
  };
}
function buildDiskBlockedMessage(preflight) {
  const subject = preflight.modelName || 'This download';
  return `${subject} needs ${formatBytes(preflight.requiredBytes)}, but only ${formatBytes(preflight.availableBytes)} is free on ${preflight.mount}. Clear space and try again.`;
}
function buildDiskConfirmationMessage(preflight) {
  const subject = preflight.modelName || 'This download';
  if (preflight.sizeKnown) {
    return `${subject} needs about ${formatBytes(preflight.requiredBytes)}. Only ${formatBytes(preflight.availableBytes)} is free on ${preflight.mount}, so this would leave less than 10% free. Confirm the download to continue.`;
  }
  return `Local AI Hub could not confirm the file size for ${subject}. ${preflight.mount} is already below 10% free space, so confirm the download before continuing.`;
}
async function ensureDiskHasCapacity(tool, payload) {
  const preflight = await getModelDownloadPreflight(tool, payload);
  if (preflight.blocked) {
    throw new Error(buildDiskBlockedMessage(preflight));
  }
  if (preflight.requiresConfirmation && !payload.lowDiskConfirmed) {
    throw new Error(buildDiskConfirmationMessage(preflight));
  }
  return preflight;
}
function isRvcIndexCompanion(tool, companion = {}) {
  return String(tool?.id || '').trim().toLowerCase() === 'rvc' && String(companion?.artifactKind || '').trim() === 'rvc-index' && /\.index$/i.test(String(companion?.path || companion?.fileName || ''));
}
function getRvcCompanionInstallRelativePath(payload = {}, companion = {}) {
  const sourcePath = normalizeRelativeInstallPath(companion.path || companion.sourceArtifactPath || companion.fileName || '');
  const sourceSegments = splitRelativePathSegments(sourcePath);
  if (sourceSegments[0] && sourceSegments[0].toLowerCase() === 'logs') {
    return path.join(...sourceSegments);
  }
  const primaryName = path.parse(String(payload.fileName || payload.installRelativePath || payload.name || 'voice').replace(/\\+/g, '/').split('/').pop() || 'voice').name;
  const voiceFolder = sanitizePathSegment(primaryName) || 'voice-model';
  const companionName = sanitizePathSegment(companion.fileName || path.basename(sourcePath) || 'model.index') || 'model.index';
  return path.join('logs', voiceFolder, companionName);
}
function resolveRvcCompanionDestination(tool, payload = {}, companion = {}) {
  const appRoot = path.resolve(String(tool?.appDir || tool?.installDir || '').trim());
  if (!appRoot) {
    throw new Error('Local AI Hub could not determine where RVC stores companion index files.');
  }
  const installRelativePath = getRvcCompanionInstallRelativePath(payload, companion);
  const destinationPath = path.join(appRoot, installRelativePath);
  if (!isSafeChildPath(appRoot, destinationPath)) {
    throw new Error('Local AI Hub refused to save an RVC companion file outside the RVC folder.');
  }
  return {
    destinationPath,
    fileName: path.basename(destinationPath),
    installRelativePath,
    targetDirectory: path.dirname(destinationPath),
  };
}
function buildOptionalCompanionDownloadUrl(payload = {}, companion = {}) {
  const source = String(payload.source || '').trim().toLowerCase();
  const companionPath = String(companion.path || companion.sourceArtifactPath || '').trim();
  if (source === 'huggingface' && payload.catalogRepositoryId && companionPath) {
    return buildHuggingFaceResolveUrl(payload.catalogRepositoryId, companionPath);
  }
  return '';
}
function buildOptionalCompanionPayload(tool, payload = {}, companion = {}, destination = {}) {
  const sourceArtifactPath = String(companion.path || companion.sourceArtifactPath || companion.fileName || '').trim();
  return {
    ...payload,
    artifactKind: companion.artifactKind || 'rvc-index',
    artifactLabel: companion.artifactLabel || 'RVC index',
    downloadPlan: null,
    downloadUrl: buildOptionalCompanionDownloadUrl(payload, companion),
    fileName: destination.fileName || companion.fileName || path.basename(sourceArtifactPath),
    installRelativePath: destination.installRelativePath,
    modelType: companion.modelType || 'RVC index',
    name: companion.fileName || path.basename(sourceArtifactPath) || payload.name,
    sizeBytes: Number(companion.sizeBytes || 0) || null,
    sourceArtifactPath,
    toolId: tool?.id || payload.toolId,
  };
}
async function downloadOptionalCompanionFiles(tool, payload, headers, logger, options = {}) {
  const companions = (payload?.downloadPlan?.optionalArtifacts || []).filter((companion) => isRvcIndexCompanion(tool, companion));
  const installed = [];
  const failed = [];
  for (const companion of companions) {
    const destination = resolveRvcCompanionDestination(tool, payload, companion);
    const companionPayload = buildOptionalCompanionPayload(tool, payload, companion, destination);
    const companionUrl = companionPayload.downloadUrl ? assertSecureRemoteUrl(companionPayload.downloadUrl, 'RVC companion download URL') : '';
    if (!companionUrl) {
      failed.push(companion.fileName || companion.path || 'RVC index');
      continue;
    }
    try {
      if (await fs.pathExists(destination.destinationPath)) {
        const existingMetadata = await readModelMetadata(destination.destinationPath);
        if (!existingMetadata?.downloadIdentity) {
          await writeModelMetadata(destination.destinationPath, buildDownloadMetadata(tool, companionPayload, destination)).catch(() => null);
        }
        installed.push(destination.fileName);
        continue;
      }
      await logger.info('Downloading optional RVC companion file.', {
        companionUrl,
        destinationPath: destination.destinationPath,
        sourceArtifactPath: companionPayload.sourceArtifactPath,
      });
      await streamDownloadToFile(companionUrl, destination.destinationPath, {
        downloadId: payload.id,
        expectedBytes: companionPayload.sizeBytes,
        headers,
        errorMessage: companionPayload.fileName + ' could not be downloaded right now.',
        onProgress: options.onProgress,
        progressMessage: 'Downloading optional RVC index companion.',
      });
      await writeModelMetadata(destination.destinationPath, buildDownloadMetadata(tool, companionPayload, destination)).catch(() => null);
      installed.push(destination.fileName);
    } catch (error) {
      await logger.warn('Optional RVC companion download failed.', {
        error,
        sourceArtifactPath: companion.path,
      });
      await fs.remove(destination.destinationPath).catch(() => null);
      await fs.remove(destination.destinationPath + '.download').catch(() => null);
      failed.push(companion.fileName || companion.path || 'RVC index');
    }
  }
  return { failed, installed };
}
function resolvePackageDestination(tool, payload = {}) {
  const plan = payload.downloadPlan || {};
  const targetDirectory = getTargetDirectory(tool, plan.modelType || payload.modelType, payload);
  if (!targetDirectory) {
    throw new Error(`Local AI Hub could not determine where ${tool.name} stores model packages.`);
  }
  const packageName = sanitizePathSegment(plan.packageName || payload.packageName || payload.fileName || payload.name || 'model-package') || 'model-package';
  const targetMode = String(plan.packageTargetMode || 'folder').trim().toLowerCase();
  const packageRootRelative = targetMode === 'flat' ? '' : normalizeRelativeInstallPath(plan.packageRoot || payload.installRelativePath || packageName);
  const packageRootPath = targetMode === 'flat' ? targetDirectory : path.join(targetDirectory, packageRootRelative || packageName);
  if (!isSafeChildPath(targetDirectory, packageRootPath)) {
    throw new Error('Local AI Hub refused to save a model package outside the approved model folder.');
  }
  const manifestPath = targetMode === 'flat' ? getPackageMetadataPath(targetDirectory, packageName) : getPackageMetadataPath(packageRootPath);
  return {
    manifestPath,
    packageName,
    packageRootPath,
    packageRootRelative: packageRootRelative || packageName,
    targetDirectory,
    targetMode,
  };
}
function buildPackageDownloadUrl(payload = {}, file = {}) {
  const source = String(payload.source || '').trim().toLowerCase();
  const sourcePath = String(file.path || file.sourceArtifactPath || '').trim();
  if (source === 'huggingface' && payload.catalogRepositoryId && sourcePath) {
    return buildHuggingFaceResolveUrl(payload.catalogRepositoryId, sourcePath);
  }
  return '';
}
function normalizePackageDownloadFiles(plan = {}) {
  return (plan.downloadFiles || []).map((file) => ({
    fileName: String(file.fileName || path.basename(file.path || file.installRelativePath || '')).trim(),
    installRelativePath: normalizeRelativeInstallPath(file.installRelativePath || file.path || file.fileName || ''),
    path: String(file.path || file.sourceArtifactPath || '').trim(),
    required: file.required !== false,
    sizeBytes: Number(file.sizeBytes || 0) || 0,
  })).filter((file) => file.path && file.installRelativePath && file.fileName);
}
function buildPackageMetadata(tool, payload, destination, installedFiles) {
  const metadata = buildDownloadMetadata(tool, payload, {
    fileName: destination.packageName,
    installRelativePath: destination.packageRootRelative,
    targetDirectory: destination.targetDirectory,
  });
  return {
    ...metadata,
    schemaVersion: 2,
    downloadFiles: installedFiles,
    installedFiles,
    modelType: payload.downloadPlan?.modelType || payload.modelType || null,
    packageIdentity: payload.downloadPlan?.packageIdentity || payload.packageIdentity || null,
    packageName: destination.packageName,
    packageRoot: payload.downloadPlan?.packageRoot || payload.packageRoot || destination.packageRootRelative,
    packageRootPath: destination.packageRootPath,
    planType: 'package',
    requiredFiles: (payload.downloadPlan?.requiredFiles || payload.downloadPlan?.requiredArtifacts || []),
  };
}
async function downloadPackageModel(tool, payload, options = {}) {
  assertRunnableDownloadPlan(payload);
  const logger = createLogger('models', {
    toolId: tool.id,
    mode: 'package-download',
    source: payload.source,
    modelId: payload.id,
  });
  const destination = resolvePackageDestination(tool, payload);
  const files = normalizePackageDownloadFiles(payload.downloadPlan || {});
  const requiredFiles = files.filter((file) => file.required);
  if (!requiredFiles.length) {
    throw new Error('Local AI Hub could not identify the required files for that model package.');
  }
  const existingMetadata = await readPackageMetadata(destination.manifestPath);
  if (existingMetadata?.downloadIdentity) {
    const present = requiredFiles.every((file) => fs.pathExistsSync(path.join(destination.packageRootPath, file.installRelativePath)));
    if (present) {
      return {
        destinationPath: destination.packageRootPath,
        fileName: destination.packageName,
        alreadyPresent: true,
        message: `${destination.packageName} is already installed for ${tool.name}.`,
      };
    }
  }
  await ensureDiskHasCapacity(tool, { ...payload, sizeBytes: Number(payload.downloadPlan?.sizeBytes || payload.sizeBytes || 0) });
  const settings = await readModelSettingsInternal();
  const headers = payload.source === 'civitai' ? buildCivitaiHeaders(settings) : { 'User-Agent': APP_USER_AGENT };
  const tempRoot = path.join(destination.targetDirectory, '.localaihub-download-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const installedFiles = [];
  let receivedBytes = 0;
  const totalBytes = Number(payload.downloadPlan?.sizeBytes || files.reduce((total, file) => total + Number(file.sizeBytes || 0), 0));
  try {
    await fs.ensureDir(tempRoot);
    for (const file of files) {
      const downloadUrl = assertSecureRemoteUrl(buildPackageDownloadUrl(payload, file), 'model package file URL');
      const tempDestination = path.join(tempRoot, file.installRelativePath);
      emitProgress(options.onProgress, {
        downloadId: payload.id,
        message: 'Downloading ' + file.fileName + ' for ' + (payload.name || destination.packageName) + '.',
        percent: totalBytes > 0 ? Math.min(98, Math.round((receivedBytes / totalBytes) * 100)) : null,
        receivedBytes,
        totalBytes,
      });
      const result = await streamDownloadToFile(downloadUrl, tempDestination, {
        downloadId: payload.id,
        expectedBytes: file.sizeBytes,
        headers,
        errorMessage: file.fileName + ' could not be downloaded right now.',
        onProgress: null,
        progressMessage: 'Downloading ' + file.fileName + '.',
      });
      receivedBytes += Number(result.downloadedBytes || file.sizeBytes || 0);
      installedFiles.push({ ...file, downloadedBytes: Number(result.downloadedBytes || 0) });
    }
    await fs.ensureDir(destination.packageRootPath);
    for (const file of installedFiles) {
      const sourcePath = path.join(tempRoot, file.installRelativePath);
      const finalPath = path.join(destination.packageRootPath, file.installRelativePath);
      if (!isSafeChildPath(destination.packageRootPath, finalPath)) {
        throw new Error('Local AI Hub refused to place a package file outside its package folder.');
      }
      await fs.ensureDir(path.dirname(finalPath));
      await fs.move(sourcePath, finalPath, { overwrite: true });
    }
    for (const file of requiredFiles) {
      const finalPath = path.join(destination.packageRootPath, file.installRelativePath);
      if (!(await fs.pathExists(finalPath))) {
        throw new Error('Local AI Hub could not verify every required package file after download.');
      }
    }
    const metadata = buildPackageMetadata(tool, payload, destination, installedFiles);
    await writePackageMetadata(destination.manifestPath, metadata);
    emitProgress(options.onProgress, {
      downloadId: payload.id,
      message: (payload.name || destination.packageName) + ' is ready.',
      percent: 100,
      receivedBytes: receivedBytes || totalBytes || 0,
      totalBytes,
    });
    return {
      destinationPath: destination.packageRootPath,
      fileName: destination.packageName,
      alreadyPresent: false,
      message: `${payload.name || destination.packageName} was installed as a complete package for ${tool.name}.`,
    };
  } catch (error) {
    await logger.warn('Model package download failed.', { error, packageName: destination.packageName });
    await fs.remove(tempRoot).catch(() => null);
    await fs.remove(destination.manifestPath).catch(() => null);
    throw new Error(humanizeError(error, (payload.name || destination.packageName) + ' could not be installed as a complete package.'));
  } finally {
    await fs.remove(tempRoot).catch(() => null);
  }
}
async function downloadInvokeAiImportedModel(tool, payload, options = {}) {
  assertRunnableDownloadPlan(payload);
  if (!isInvokeAiApiImportPayload(tool, payload)) {
    throw new Error('Local AI Hub only installs InvokeAI models through InvokeAI\'s own import API. This catalog item is not an InvokeAI import plan.');
  }
  if (isPackageDownloadPayload(payload)) {
    throw new Error('InvokeAI package or folder imports are not enabled in Local AI Hub yet. Choose a single .safetensors, .ckpt, .pt, or .pth file for a supported InvokeAI model type.');
  }
  const downloadUrl = assertSecureRemoteUrl(payload.downloadUrl, 'InvokeAI model download URL');
  const logger = createLogger('models', {
    toolId: tool.id,
    mode: 'invokeai-api-import',
    source: payload.source,
    modelId: payload.id,
  });
  await ensureDiskHasCapacity(tool, payload);
  const settings = await readModelSettingsInternal();
  const headers = payload.source === 'civitai' ? buildCivitaiHeaders(settings) : { 'User-Agent': APP_USER_AGENT };
  const stagePath = getInvokeAiImportStagePath(tool, payload);
  const stageRoot = path.dirname(stagePath);
  let session = null;
  try {
    await logger.info('Downloading InvokeAI model to a temporary import file.', {
      downloadUrl,
      stagePath,
      sourceArtifactPath: payload.sourceArtifactPath,
    });
    emitProgress(options.onProgress, {
      downloadId: payload.id,
      message: 'Downloading ' + (payload.name || payload.fileName || 'model') + ' for InvokeAI import.',
      percent: 2,
      receivedBytes: 0,
      totalBytes: payload.sizeBytes || 0,
    });
    const result = await streamDownloadToFile(downloadUrl, stagePath, {
      downloadId: payload.id,
      expectedBytes: payload.sizeBytes,
      headers,
      errorMessage: (payload.name || payload.fileName || 'That model') + ' could not be downloaded for InvokeAI right now.',
      onProgress: options.onProgress,
      progressMessage: 'Downloading ' + (payload.name || payload.fileName || 'model') + ' for InvokeAI import.',
    });
    emitProgress(options.onProgress, {
      downloadId: payload.id,
      message: 'Starting InvokeAI so it can register the model.',
      percent: 85,
      receivedBytes: result.downloadedBytes,
      totalBytes: result.totalBytes || payload.sizeBytes || 0,
    });
    session = await prepareInvokeAiModelImportSession(tool);
    const request = buildInvokeAiModelInstallRequest(session.readyTool, stagePath, buildInvokeAiModelImportConfig(payload));
    const response = await fetch(request.url, {
      body: request.body,
      headers: request.headers,
      method: request.method,
    });
    const job = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(buildInvokeAiInstallErrorMessage(job, 'InvokeAI answered with status ' + response.status + '.'));
    }
    emitProgress(options.onProgress, {
      downloadId: payload.id,
      message: 'InvokeAI is importing and registering the model.',
      percent: 90,
      receivedBytes: result.downloadedBytes,
      totalBytes: result.totalBytes || payload.sizeBytes || 0,
    });
    const completedJob = await waitForInvokeAiInstallJob(session.readyTool, job, {
      downloadId: payload.id,
      onProgress: options.onProgress,
      receivedBytes: result.downloadedBytes,
      totalBytes: result.totalBytes || payload.sizeBytes || 0,
    });
    await writeInvokeAiImportMetadata(session.readyTool, payload, completedJob);
    emitProgress(options.onProgress, {
      downloadId: payload.id,
      message: (payload.name || payload.fileName || 'The model') + ' is registered in InvokeAI.',
      percent: 100,
      receivedBytes: result.downloadedBytes,
      totalBytes: result.totalBytes || payload.sizeBytes || 0,
    });
    return {
      alreadyPresent: false,
      destinationPath: resolveInvokeAiModelPath(session.readyTool, completedJob?.config_out || {}) || null,
      fileName: payload.fileName || payload.name || 'model',
      message: (payload.name || payload.fileName || 'The model') + ' was imported into InvokeAI and registered in InvokeAI\'s model database.' + (session.startedForImport ? ' Local AI Hub started InvokeAI for this import and stopped it afterward.' : ''),
    };
  } catch (error) {
    await logger.warn('InvokeAI model import failed.', { error, stagePath });
    throw new Error(humanizeError(error, (payload.name || payload.fileName || 'That model') + ' could not be imported into InvokeAI.'));
  } finally {
    await finishInvokeAiModelImportSession(session);
    await fs.remove(stageRoot).catch(() => null);
  }
}
function assertExistingModelFileMatchesRequest(tool, payload, destination, existingMetadata) {
  const requestedIdentity = buildExpectedDownloadIdentity(tool, payload, destination);
  const existingIdentity = existingMetadata?.downloadIdentity || null;
  if (requestedIdentity && existingIdentity && normalizeLookupKey(requestedIdentity) === normalizeLookupKey(existingIdentity)) {
    return;
  }
  const fileName = destination.fileName || payload.fileName || payload.name || 'that model file';
  const requestedName = payload.name || payload.fileName || 'the requested model';
  if (!existingIdentity) {
    throw new Error(`${fileName} already exists in ${tool.name}, but Local AI Hub cannot confirm it is the same model. Rename or delete the existing file, then try downloading ${requestedName} again.`);
  }
  throw new Error(`A different model named ${fileName} is already in ${tool.name}. Local AI Hub will not overwrite or relabel it. Delete or rename the existing file, then try downloading ${requestedName} again.`);
}
async function downloadRemoteModel(tool, payload, options = {}) {
  if (isPackageDownloadPayload(payload)) {
    return downloadPackageModel(tool, payload, options);
  }
  assertRunnableDownloadPlan(payload);
  const logger = createLogger('models', {
    toolId: tool.id,
    mode: 'download',
    source: payload.source,
    modelId: payload.id,
  });
  const { destinationPath, fileName, installRelativePath, targetDirectory } = resolveModelDestination(tool, payload);
  const downloadUrl = assertSecureRemoteUrl(payload.downloadUrl, 'model download URL');
  const settings = await readModelSettingsInternal();
  const headers = payload.source === 'civitai' ? buildCivitaiHeaders(settings) : { 'User-Agent': APP_USER_AGENT };
  if (await fs.pathExists(destinationPath)) {
    const existingMetadata = await readModelMetadata(destinationPath);
    assertExistingModelFileMatchesRequest(tool, payload, { destinationPath, fileName, installRelativePath, targetDirectory }, existingMetadata);
    return {
      destinationPath,
      fileName,
      alreadyPresent: true,
      message: `${fileName} is already in ${tool.name}.`,
    };
  }
  await ensureDiskHasCapacity(tool, payload);
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await logger.info('Downloading model file.', {
        downloadUrl,
        destinationPath,
        installRelativePath,
        attempt,
        targetDirectory,
      });
      emitProgress(options.onProgress, {
        downloadId: payload.id,
        message: `Downloading ${payload.name}.`,
        percent: 2,
        receivedBytes: 0,
        totalBytes: payload.sizeBytes || 0,
      });
      const result = await streamDownloadToFile(downloadUrl, destinationPath, {
        downloadId: payload.id,
        expectedBytes: payload.sizeBytes,
        headers,
        errorMessage: `${payload.name} could not be downloaded right now.`,
        onProgress: options.onProgress,
        progressMessage: `Downloading ${payload.name}.`,
      });
      emitProgress(options.onProgress, {
        downloadId: payload.id,
        message: `${payload.name} is ready.`,
        percent: 100,
        receivedBytes: result.downloadedBytes,
        totalBytes: result.totalBytes || payload.sizeBytes || 0,
      });
      await writeModelMetadata(destinationPath, buildDownloadMetadata(tool, payload, { destinationPath, fileName, installRelativePath, targetDirectory })).catch(() => null);
      const companions = await downloadOptionalCompanionFiles(tool, payload, headers, logger, options);
      const companionMessage = companions.installed.length
        ? ' Optional companion installed: ' + companions.installed.join(', ') + '.'
        : companions.failed.length
          ? ' The voice weight was installed, but its optional index companion could not be downloaded. Add it manually if you need retrieval-index quality.'
          : '';
      return {
        destinationPath,
        fileName,
        alreadyPresent: false,
        message: `${payload.name} was added to ${tool.name}.` + companionMessage,
      };
    } catch (error) {
      lastError = error;
      await logger.warn('Model download attempt failed.', {
        attempt,
        error,
      });
      await fs.remove(destinationPath).catch(() => null);
      await fs.remove(`${destinationPath}.download`).catch(() => null);
    }
  }
  throw new Error(humanizeError(lastError, `${payload.name} could not be downloaded.`));
}
async function pullOllamaModel(tool, payload, options = {}) {
  assertRunnableDownloadPlan(payload);
  await ensureDiskHasCapacity(tool, payload);
  const logger = createLogger('models', {
    toolId: tool.id,
    mode: 'download',
    source: 'ollama',
    modelId: payload.id,
  });
  emitProgress(options.onProgress, {
    downloadId: payload.id,
    message: `Preparing ${tool.name || 'Ollama'} for the download.`,
    percent: 1,
    receivedBytes: 0,
    totalBytes: payload.sizeBytes || 0,
  });
  let session = null;
  try {
    session = await prepareOllamaSession(tool, {
      autoStart: true,
      launchContext: 'model-download',
    });
  } catch {
    throw new Error(buildOllamaUnavailableMessage(tool, {
      actionLabel: `download ${payload.name}`,
      autoStartAttempted: true,
    }));
  }
  const activeTool = session.tool || tool;
  const launchUrl = assertLoopbackUrl(activeTool.launchUrl, 'Ollama API URL');
  try {
    const response = await fetch(new URL('/api/pull', `${launchUrl.replace(/\/$/, '')}/`).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: payload.name,
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      const raw = await response.text().catch(() => '');
      let payloadLine = null;
      try {
        payloadLine = raw ? JSON.parse(raw) : null;
      } catch {
        payloadLine = null;
      }
      const detail = String(payloadLine?.error || payloadLine?.message || raw || '').trim();
      throw new Error(detail ? `${payload.name} could not be pulled from Ollama right now. ${detail}` : `${payload.name} could not be pulled from Ollama right now.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let latestPercent = 0;
    await logger.info('Ollama model pull started.', {
      autoStarted: Boolean(session.autoStarted),
      model: payload.name,
    });
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MODEL_DOWNLOAD_BUFFER_LIMIT) {
        buffer = buffer.slice(-MODEL_DOWNLOAD_BUFFER_LIMIT);
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let payloadLine = null;
        try {
          payloadLine = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const percent = payloadLine.total
          ? Math.max(latestPercent, Math.round(((payloadLine.completed || 0) / payloadLine.total) * 100))
          : latestPercent;
        latestPercent = percent;
        emitProgress(options.onProgress, {
          downloadId: payload.id,
          message: payloadLine.status || `Pulling ${payload.name}.`,
          percent: percent || null,
          receivedBytes: payloadLine.completed || 0,
          totalBytes: payloadLine.total || 0,
        });
      }
    }
    emitProgress(options.onProgress, {
      downloadId: payload.id,
      message: `${payload.name} is ready.`,
      percent: 100,
      receivedBytes: 0,
      totalBytes: 0,
    });
    return {
      alreadyPresent: false,
      message: session.autoStarted
        ? `${payload.name} was downloaded into Ollama. Local AI Hub started Ollama for this download and shut it down afterward.`
        : `${payload.name} was downloaded into Ollama.`,
    };
  } catch (error) {
    await logger.warn('Ollama model pull failed.', {
      autoStarted: Boolean(session?.autoStarted),
      error,
      model: payload.name,
    });
    if (error?.message?.includes('could not be pulled from Ollama right now.')) {
      throw error;
    }
    throw new Error(buildOllamaUnavailableMessage(activeTool, {
      actionLabel: `download ${payload.name}`,
      autoStartAttempted: Boolean(session?.autoStarted),
    }));
  } finally {
    await finishOllamaSession(session);
  }
}
async function downloadModel(tool, payload, options = {}) {
  if (tool.id === 'ollama') {
    return pullOllamaModel(tool, payload, options);
  }
  if (tool.id === 'invokeai') {
    return downloadInvokeAiImportedModel(tool, payload, options);
  }
  return downloadRemoteModel(tool, payload, options);
}
async function resolveOllamaCommand(tool) {
  const candidates = [
    tool.launchProfile?.kind === 'binary' ? tool.launchProfile.executable : null,
    tool.externalExecutablePath,
    tool.executablePath,
    tool.installDir ? path.join(tool.installDir, 'ollama.exe') : null,
    'ollama',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'ollama') {
      return candidate;
    }
    if (await fs.pathExists(candidate)) {
      return candidate;
    }
  }
  return 'ollama';
}
async function deletePackageModel(tool, payload = {}) {
  const manifestPath = path.resolve(String(payload.packageManifestPath || payload.path || '').trim());
  const directories = Object.values(getToolModelDirectories(tool)).map((entry) => path.resolve(entry));
  if (!manifestPath || !directories.some((directory) => isSafeChildPath(directory, manifestPath) || manifestPath === directory)) {
    throw new Error('Local AI Hub refused to delete a package outside the approved model folder.');
  }
  const metadata = await readPackageMetadata(manifestPath);
  if (!metadata) {
    throw new Error('Local AI Hub could not read the package manifest for that model.');
  }
  const packageRoot = path.resolve(String(metadata.packageRootPath || path.dirname(manifestPath)).trim());
  if (!directories.some((directory) => isSafeChildPath(directory, packageRoot) || packageRoot === directory)) {
    throw new Error('Local AI Hub refused to delete package files outside the approved model folder.');
  }
  for (const relativeFile of packageInstalledRelativeFiles(metadata)) {
    const filePath = path.join(packageRoot, normalizeRelativeInstallPath(relativeFile));
    if (isSafeChildPath(packageRoot, filePath)) {
      await fs.remove(filePath).catch(() => null);
    }
  }
  await fs.remove(manifestPath).catch(() => null);
  if (path.basename(manifestPath) === PACKAGE_METADATA_FILE) {
    await fs.remove(packageRoot).catch(() => null);
  }
  return {
    message: (metadata.packageName || payload.name || 'That model package') + ' was deleted from ' + (tool.name || 'this tool') + '.',
  };
}
async function deleteInvokeAiModel(tool, payload = {}) {
  const modelKey = String(payload.invokeAiModelKey || payload.key || '').trim();
  if (!modelKey) {
    throw new Error('Local AI Hub can only remove InvokeAI models through InvokeAI\'s model registry. Launch InvokeAI, refresh Downloaded Models, then try again.');
  }
  let session = null;
  try {
    session = await prepareInvokeAiModelImportSession(tool);
    const response = await fetch(getInvokeAiApiUrl(session.readyTool, '/api/v2/models/i/' + encodeURIComponent(modelKey)), {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 204) {
      const payloadBody = await response.json().catch(() => null);
      const detail = String(payloadBody?.detail || payloadBody?.error || payloadBody?.message || '').trim();
      throw new Error(detail || 'InvokeAI answered with status ' + response.status + '.');
    }
    const modelPath = String(payload.path || '').trim();
    if (modelPath) {
      await fs.remove(getModelMetadataPath(modelPath)).catch(() => null);
    }
    return {
      message: (payload.name || payload.fileName || 'That model') + ' was removed through InvokeAI\'s model registry.',
    };
  } catch (error) {
    throw new Error(humanizeError(error, (payload.name || payload.fileName || 'That InvokeAI model') + ' could not be removed.'));
  } finally {
    await finishInvokeAiModelImportSession(session);
  }
}
async function deleteModel(tool, payload) {
  if (tool.id === 'invokeai') {
    return deleteInvokeAiModel(tool, payload);
  }
  if (tool.id === 'ollama') {
    const modelName = String(payload.name || payload.fileName || '').trim();
    if (!modelName) {
      throw new Error('Local AI Hub could not tell which Ollama model should be removed.');
    }
    const command = await resolveOllamaCommand(tool);
    try {
      await runCommand(command, ['rm', modelName], {
        cwd: tool.installDir || undefined,
        errorMessage: modelName + ' could not be removed from Ollama.',
      });
    } catch (error) {
      const launchUrl = assertLoopbackUrl(tool.launchUrl, 'Ollama API URL');
      const response = await fetch(new URL('/api/delete', launchUrl.replace(/\/$/, '') + '/').toString(), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelName,
        }),
      }).catch(() => null);
      if (!response?.ok) {
        throw error;
      }
    }
    return {
      message: modelName + ' was removed from Ollama.',
    };
  }
  const resolvedPath = path.resolve(payload.path || '');
  const targetDirectory = getTargetDirectory(tool, payload.modelType, payload);
  if (!resolvedPath || !targetDirectory || !isSafeChildPath(targetDirectory, resolvedPath)) {
    throw new Error('Local AI Hub refused to delete a file outside the model folder.');
  }
  await fs.remove(resolvedPath);
  await fs.remove(getModelMetadataPath(resolvedPath)).catch(() => null);
  return {
    message: `${payload.fileName || payload.name} was deleted from ${tool.name}.`,
  };
}
module.exports = {
  browseRemoteModels,
  countDownloadedModels,
  deleteModel,
  downloadModel,
  getModelDownloadPreflight,
  getToolModelDirectories,
  listDownloadedModels,
  listToolAssets,
  readModelSettings,
  saveModelManagerSettings,
  supportsModelManager,
  _test: {
    buildDownloadedLookup,
    buildDownloadMetadata,
    buildHuggingFaceRepositoryResult,
    buildHardwareFit,
    buildSourceDownloadIdentity,
    buildExpectedDownloadIdentity,
    buildRvcArtifactSearchQuery,
    buildRvcHuggingFaceApiSearchQuery,
    collectCivitaiVersionFiles,
    collectHuggingFaceDownloadFiles,
    createModelDownloadPlan,
    downloadOptionalCompanionFiles,
    getToolModelDirectories,
    matchesSearchQuery,
    resolveHuggingFaceDownloadFile,
    searchHuggingFaceModels,
    buildInvokeAiInstallErrorMessage,
    buildInvokeAiModelImportConfig,
    buildInvokeAiModelInstallRequest,
    isInvokeAiApiImportPayload,
    normalizeInvokeAiModelType,
    resolveInvokeAiModelPath,
    resolveModelDestination,
    resolveRvcCompanionDestination,
    writeModelMetadata,
  }
};
