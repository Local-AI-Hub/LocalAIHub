const path = require('path');
const fs = require('fs-extra');
const { open } = require('node:fs/promises');
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
const APP_USER_AGENT = `LocalAIHub/${APP_VERSION}`;
const MODEL_SETTINGS_FILE = 'model-manager.settings.json';
const MODEL_DOWNLOAD_BUFFER_LIMIT = 10 * 1024 * 1024;
const REMOTE_PAGE_SIZE = 24;
const OLLAMA_PAGE_SIZE = 40;
const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';
const TABBY_MODEL_REGISTRY_URLS = ['https://models.tabbyml.com', 'https://tabby.tabbyml.com/docs/models/'];
const HUGGING_FACE_SEARCH_URL = 'https://huggingface.co/api/models';
const HUGGING_FACE_MODEL_URL = 'https://huggingface.co/api/models';
const CIVITAI_MODELS_URL = 'https://civitai.com/api/v1/models';
const MODEL_FILE_PATTERN = /\.(safetensors|ckpt|pt|pth|bin|gguf)$/i;
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|gif)$/i;
const README_FILE_PATTERN = /(?:^|\/)README\.md$/i;
const HUGGING_FACE_FILE_SIZE_CACHE = new Map();
const HUGGING_FACE_PREVIEW_CACHE = new Map();
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
      'Wan-AI/Wan2.1-T2V-14B-Diffusers',
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
      'Wan-AI/Wan2.1-I2V-14B-480P-Diffusers',
      'THUDM/CogVideoX-5b-I2V',
      'Lightricks/LTX-Video',
    ],
    catalogRequirements: HIGH_VRAM_VIDEO_REQUIREMENTS,
  },
  'audio-speech': {
    pipelineTags: ['text-to-audio', 'automatic-speech-recognition', 'text-to-speech'],
    searchTerms: ['musicgen'],
    seedModelIds: ['facebook/musicgen-large', 'suno/bark', 'facebook/audiocraft-large'],
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
  upscaler: { civitaiTypes: ['Upscaler'], hfPipelineTags: ['image-to-image'], searchTerms: ['realesrgan'] },
  gguf: { civitaiTypes: [], hfPipelineTags: ['text-generation'], searchTerms: ['gguf'] },
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
  if (normalized.includes('gguf') || /\.gguf$/i.test(normalized)) {
    return 'GGUF';
  }
  if (normalized.includes('upscaler') || normalized.includes('esrgan') || normalized.includes('realesrgan')) {
    return 'Upscaler';
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
  if (normalized.includes('embedding') || normalized.includes('textual inversion')) {
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
function getDerivedSearchTerms(browseOptions) {
  const taskProfile = getTaskProfile(browseOptions.taskType);
  const modelTypeProfile = getModelTypeProfile(browseOptions.modelType);
  const userQuery = String(browseOptions.query || '').trim();
  return mergeUniqueStrings([userQuery, ...(modelTypeProfile.searchTerms || []), ...(taskProfile.searchTerms || [])]);
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
    hasCivitaiApiKey: false,
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
    hasCivitaiApiKey: Boolean(secrets.hasCivitaiApiKey),
  };
}
async function readModelSettings() {
  const settings = await readModelSettingsInternal();
  return {
    ...stripModelManagerSecrets(settings),
    civitaiApiKey: '',
    hasCivitaiApiKey: Boolean(settings.hasCivitaiApiKey),
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
    hasCivitaiApiKey: Boolean(secrets.hasCivitaiApiKey),
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
function buildHardwareFit(sizeBytes, hardware, requirements = null) {
  const vramMb = Number(hardware?.vramMb || 0);
  const minimumVramMb = Number(requirements?.minimumVramMb || 0);
  if (minimumVramMb > 0 && vramMb > 0 && vramMb < minimumVramMb) {
    return {
      label: 'Too Large',
      tone: 'danger',
      message: requirements?.warningMessage || 'This model needs more GPU memory than Local AI Hub detected on this PC.',
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
  if (sizeBytes <= availableVramBytes * 0.75) {
    return {
      label: 'Recommended',
      tone: 'good',
      message: 'This model should fit comfortably in your GPU memory.',
    };
  }
  if (sizeBytes <= availableVramBytes) {
    return {
      label: 'Possible',
      tone: 'warn',
      message: 'This model is close to your VRAM limit and may run slowly.',
    };
  }
  return {
    label: 'Too Large',
    tone: 'danger',
    message: 'This model is larger than your detected VRAM capacity.',
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
    hardwareFit: buildHardwareFit(item.sizeBytes, hardwareContext.hardware, requirements),
    targetDisk: disk
      ? {
          freeBytes: disk.freeBytes,
          mount: disk.mount,
          sizeBytes: disk.sizeBytes,
        }
      : null,
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
async function listLocalFileModels(tool) {
  const directories = getToolModelDirectories(tool);
  const localModels = [];
  for (const [modelType, directory] of Object.entries(directories)) {
    if (!(await fs.pathExists(directory))) {
      continue;
    }
    const files = await walkDirectoryFiles(directory);
    for (const fullPath of files) {
      if (!MODEL_FILE_PATTERN.test(path.basename(fullPath))) {
        continue;
      }
      const stats = await fs.stat(fullPath);
      localModels.push({
        id: tool.id + ':' + modelType + ':' + normalizePathForId(path.relative(directory, fullPath)),
        downloaded: true,
        fileName: path.basename(fullPath),
        modelType,
        name: path.parse(path.basename(fullPath)).name,
        path: fullPath,
        relativePath: path.relative(directory, fullPath),
        sizeBytes: stats.size,
        source: 'local',
        toolId: tool.id,
      });
    }
  }
  return localModels.sort((left, right) => left.name.localeCompare(right.name));
}
async function walkDirectoryFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDirectoryFiles(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
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
async function listLocalOllamaModelsFromFilesystem(tool) {
  const manifestsRoot = path.join(getOllamaModelsRoot(tool), 'manifests');
  if (!(await fs.pathExists(manifestsRoot))) {
    return [];
  }
  const manifestFiles = await walkDirectoryFiles(manifestsRoot);
  const models = await Promise.all(
    manifestFiles.map(async (manifestPath) => {
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
async function listLocalOllamaModels(tool) {
  if (String(tool?.status || '').trim().toLowerCase() !== 'running') {
    return listLocalOllamaModelsFromFilesystem(tool);
  }

  try {
    const response = await listOllamaModels(tool);
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
    return listLocalOllamaModelsFromFilesystem(tool);
  }
}
async function listDownloadedModels(tool) {
  if (tool?.id === 'rvc') {
    return listLocalFileModels(tool);
  }
  if (!supportsModelManager(tool)) {
    return [];
  }
  if (tool.id === 'ollama') {
    return listLocalOllamaModels(tool);
  }
  return listLocalFileModels(tool);
}
async function countDownloadedModels(tool) {
  if (tool?.id === 'rvc') {
    return (await listLocalFileModels(tool)).length;
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
    for (const value of [model.fileName, model.name, model.relativePath]) {
      const key = normalizeLookupKey(value);
      if (key) {
        lookup.add(key);
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
  if (repositoryId) {
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
function inferHuggingFaceType(detail, fileEntry) {
  const combined = [detail.pipeline_tag || '', ...(detail.tags || []), fileEntry?.rfilename || '']
    .join(' ')
    .toLowerCase();
  return normalizeModelType(combined);
}
function getKnownHuggingFaceFileSize(entry) {
  const candidates = [entry?.lfs?.size, entry?.size, entry?.blob?.size, entry?.metadata?.size];
  for (const candidate of candidates) {
    const sizeBytes = Number(candidate || 0);
    if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
      return sizeBytes;
    }
  }
  return 0;
}
function normalizeSearchQuery(value) {
  return String(value || '').trim().toLowerCase();
}
function matchesSearchQuery(query, values = []) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return true;
  }
  return values.some((value) => normalizeSearchQuery(value).includes(normalizedQuery));
}
function isFileLikeSearchQuery(query) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return false;
  }
  return MODEL_FILE_PATTERN.test(normalizedQuery) || /[\\/]/.test(normalizedQuery) || /\.[a-z0-9]{2,16}$/i.test(normalizedQuery);
}
function collectHuggingFaceDownloadFiles(detail, selectedType) {
  return (detail.siblings || [])
    .filter((entry) => MODEL_FILE_PATTERN.test(entry.rfilename || ''))
    .map((entry) => ({
      ...entry,
      modelType: inferHuggingFaceType(detail, entry),
      sizeBytes: getKnownHuggingFaceFileSize(entry),
    }))
    .filter((entry) => matchesSelectedModelType(entry.modelType, selectedType))
    .sort((left, right) => right.sizeBytes - left.sizeBytes || String(left.rfilename || '').localeCompare(String(right.rfilename || '')));
}
function pickHuggingFaceDownloadFile(detail, selectedType) {
  return collectHuggingFaceDownloadFiles(detail, selectedType)[0] || null;
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
  const response = await fetch(url, options);
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
    let response = await fetch(downloadUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': APP_USER_AGENT,
      },
    });
    sizeBytes = parseSizeHeader(response);
    if ((!response.ok || sizeBytes <= 0) && response.status !== 404) {
      response = await fetch(downloadUrl, {
        headers: {
          Range: 'bytes=0-0',
          'User-Agent': APP_USER_AGENT,
        },
      });
      sizeBytes = parseSizeHeader(response);
      if (response.body && typeof response.body.cancel === 'function') {
        await response.body.cancel().catch(() => null);
      }
    }
  } catch (error) {
    await logger.warn('A Hugging Face file size lookup failed.', {
      downloadUrl,
      error,
      modelId,
    }).catch(() => null);
  }
  HUGGING_FACE_FILE_SIZE_CACHE.set(cacheKey, sizeBytes || 0);
  return sizeBytes || 0;
}
async function resolveHuggingFaceDownloadFile(detail, selectedType, logger) {
  const downloadFile = pickHuggingFaceDownloadFile(detail, selectedType);
  if (!downloadFile) {
    return null;
  }
  if (downloadFile.sizeBytes > 0) {
    return downloadFile;
  }
  return {
    ...downloadFile,
    sizeBytes: await fetchHuggingFaceFileSize(detail.id, downloadFile.rfilename, logger),
  };
}
async function fetchHuggingFaceReadmePreview(detail, logger) {
  const readmeEntry = (detail.siblings || []).find((entry) => README_FILE_PATTERN.test(entry.rfilename || ''));
  if (!readmeEntry) {
    return null;
  }
  try {
    const response = await fetch(buildHuggingFaceResolveUrl(detail.id, readmeEntry.rfilename), {
      headers: {
        'User-Agent': APP_USER_AGENT,
      },
    });
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
async function fetchHuggingFaceSeedDetails(browseOptions, logger) {
  if (browseOptions.cursor || browseOptions.query) {
    return [];
  }
  const seedModelIds = getTaskProfile(browseOptions.taskType).seedModelIds || [];
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
async function requestHuggingFacePage(tool, browseOptions, logger, pipelineTag = '') {
  const searchUrl = new URL(HUGGING_FACE_SEARCH_URL);
  const derivedSearchTerms = getDerivedSearchTerms(browseOptions);
  const derivedSearchQuery = derivedSearchTerms.find(Boolean) || '';
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
  const derivedSearchTerms = getDerivedSearchTerms(browseOptions);
  const derivedSearchQuery = derivedSearchTerms.find(Boolean) || '';
  const preferredPipelineTag = pipelineTags[0] || '';
  const primaryPage = await requestHuggingFacePage(tool, browseOptions, logger, preferredPipelineTag);
  if (!derivedSearchQuery || !preferredPipelineTag || !isFileLikeSearchQuery(derivedSearchQuery)) {
    return primaryPage;
  }
  const fallbackPage = await requestHuggingFacePage(tool, browseOptions, logger, '');
  return {
    nextCursor: primaryPage.nextCursor || fallbackPage.nextCursor,
    results: mergeUniqueRemoteEntriesById([...primaryPage.results, ...fallbackPage.results]),
  };
}
async function resolveHuggingFaceArtifactFiles(detail, browseOptions, logger) {
  const query = String(browseOptions.query || '').trim();
  if (!query) {
    return [];
  }
  const matchingFiles = collectHuggingFaceDownloadFiles(detail, browseOptions.modelType).filter((file) =>
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
  if (fileLevelSearch) {
    return [artifactItems];
  }
  return artifactItems.length ? [modelItems, artifactItems] : [modelItems];
}
function buildHuggingFaceRepositoryResult(detail, file, tool, downloadedLookup, hardwareContext, catalogRequirements, previewUrl) {
  const fileName = path.basename(file.rfilename || '');
  const installRelativePath = normalizeRelativeInstallPath(file.rfilename || fileName) || fileName;
  return attachHardwareHints(
    {
      id: 'huggingface:repository:' + detail.id,
      author: detail.author || null,
      catalogEntityLabel: 'Repository',
      catalogEntityType: 'repository',
      catalogContext: file.rfilename ? `Primary artifact: ${file.rfilename}` : null,
      catalogRepositoryId: detail.id,
      catalogRequirements,
      description: buildHuggingFaceDescription(detail),
      downloaded: isDownloadedMatch(downloadedLookup, buildCatalogLookupValues(detail.id, installRelativePath, [fileName, detail.id])),
      downloadUrl: buildHuggingFaceResolveUrl(detail.id, file.rfilename),
      fileName,
      highVramWarning: catalogRequirements,
      installRelativePath,
      modelType: file.modelType,
      name: detail.id,
      previewUrl,
      sizeBytes: Number(file.sizeBytes || 0),
      source: 'huggingface',
      toolId: tool.id,
    },
    tool,
    hardwareContext,
  );
}
function buildHuggingFaceArtifactResult(detail, file, tool, downloadedLookup, hardwareContext, catalogRequirements, previewUrl) {
  const fileName = path.basename(file.rfilename || '');
  const nestedPath = String(file.rfilename || '').trim();
  const installRelativePath = normalizeRelativeInstallPath(nestedPath || fileName) || fileName;
  return attachHardwareHints(
    {
      id: 'huggingface:artifact:' + detail.id + ':' + normalizePathForId(nestedPath || fileName),
      author: detail.author || null,
      catalogEntityLabel: 'Artifact',
      catalogEntityType: 'artifact',
      catalogParentLabel: detail.id,
      catalogContext: nestedPath && nestedPath !== fileName ? `Repository path: ${nestedPath}` : null,
      catalogRepositoryId: detail.id,
      catalogRequirements,
      description: `File from ${detail.id} | ${buildHuggingFaceDescription(detail)}`,
      downloaded: isDownloadedMatch(downloadedLookup, buildCatalogLookupValues(detail.id, installRelativePath, [fileName, detail.id, nestedPath])),
      downloadUrl: buildHuggingFaceResolveUrl(detail.id, file.rfilename),
      fileName,
      highVramWarning: catalogRequirements,
      installRelativePath,
      modelType: file.modelType,
      name: fileName,
      previewUrl,
      sizeBytes: Number(file.sizeBytes || 0),
      source: 'huggingface',
      toolId: tool.id,
    },
    tool,
    hardwareContext,
  );
}
async function searchHuggingFaceModels(tool, browseOptions, downloadedLookup, hardwareContext, logger) {
  const modelItems = [];
  const artifactItems = [];
  const catalogRequirements = getCatalogRequirements(browseOptions);
  const query = String(browseOptions.query || '').trim();
  const fileLevelSearch = Boolean(query) && isFileLikeSearchQuery(query);
  let rawCursor = browseOptions.cursor;
  let nextCursor = null;
  for (let scanCount = 0; scanCount < 3; scanCount += 1) {
    const existingItems = mergeCatalogSearchItems(getCatalogSearchGroups(modelItems, artifactItems, fileLevelSearch), browseOptions.limit);
    if (existingItems.length >= browseOptions.limit) {
      break;
    }
    const page = await fetchHuggingFacePage(tool, { ...browseOptions, cursor: rawCursor }, logger);
    const pageDetails = await fetchHuggingFaceDetails(page.results, logger);
    const seedDetails = scanCount === 0 && !rawCursor ? await fetchHuggingFaceSeedDetails(browseOptions, logger) : [];
    const details = mergeUniqueDetailsById([...seedDetails, ...pageDetails]);
    for (const detail of details) {
      const previewUrl = await resolveHuggingFacePreview(detail, logger);
      const primaryFile = await resolveHuggingFaceDownloadFile(detail, browseOptions.modelType, logger);
      if (primaryFile) {
        modelItems.push(
          buildHuggingFaceRepositoryResult(detail, primaryFile, tool, downloadedLookup, hardwareContext, catalogRequirements, previewUrl),
        );
      }
      const matchingArtifacts = await resolveHuggingFaceArtifactFiles(detail, browseOptions, logger);
      for (const file of matchingArtifacts) {
        artifactItems.push(
          buildHuggingFaceArtifactResult(detail, file, tool, downloadedLookup, hardwareContext, catalogRequirements, previewUrl),
        );
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
  return {
    items: mergeCatalogSearchItems(getCatalogSearchGroups(modelItems, artifactItems, fileLevelSearch), browseOptions.limit),
    pagination: {
      hasMore: Boolean(nextCursor),
      nextCursor,
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
function collectCivitaiVersionFiles(model, selectedType) {
  return (model.modelVersions || [])
    .flatMap((version) =>
      (version.files || [])
        .map((file) => ({
          file: {
            ...file,
            normalizedType: normalizeModelType(file.type || file.name || model.type),
            sizeBytes: Number(file.sizeBytes || 0) || toFileSizeBytes(Number(file.sizeKB || 0)),
          },
          version,
        }))
        .filter((entry) => matchesSelectedModelType(entry.file.normalizedType, selectedType)),
    )
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
  return attachHardwareHints(
    {
      id: 'civitai:model:' + model.id,
      author: model.creator?.username || null,
      catalogEntityLabel: 'Model',
      catalogEntityType: 'model',
      catalogContext: `Primary version: ${versionLabel} | Primary artifact: ${fileName}`,
      catalogRequirements,
      description: buildCivitaiDescription(model),
      downloaded: isDownloadedMatch(downloadedLookup, buildCatalogLookupValues(null, installRelativePath, [fileName, model.name])),
      downloadUrl: entry.file.downloadUrl || entry.version.downloadUrl,
      fileName,
      highVramWarning: catalogRequirements,
      installRelativePath,
      modelType: entry.file.normalizedType,
      name: model.name,
      previewUrl: previewImage?.url || null,
      sizeBytes: entry.file.sizeBytes,
      source: 'civitai',
      toolId: tool.id,
    },
    tool,
    hardwareContext,
  );
}
function buildCivitaiArtifactResult(model, entry, tool, downloadedLookup, hardwareContext, catalogRequirements) {
  const fileName = String(entry?.file?.name || '').trim();
  const versionLabel = formatCivitaiVersionLabel(entry?.version);
  const previewImage = entry?.version?.images?.find((image) => image.type === 'image');
  const installRelativePath = normalizeRelativeInstallPath(fileName) || fileName;
  return attachHardwareHints(
    {
      id: 'civitai:artifact:' + model.id + ':' + String(entry?.version?.id || versionLabel) + ':' + fileName,
      author: model.creator?.username || null,
      catalogEntityLabel: 'Artifact',
      catalogEntityType: 'artifact',
      catalogParentLabel: model.name,
      catalogContext: `Version: ${versionLabel}`,
      catalogRequirements,
      description: `File from ${model.name} | Version ${versionLabel} | ${buildCivitaiDescription(model)}`,
      downloaded: isDownloadedMatch(downloadedLookup, buildCatalogLookupValues(null, installRelativePath, [fileName, model.name])),
      downloadUrl: entry.file.downloadUrl || entry.version.downloadUrl,
      fileName,
      highVramWarning: catalogRequirements,
      installRelativePath,
      modelType: entry.file.normalizedType,
      name: fileName,
      previewUrl: previewImage?.url || null,
      sizeBytes: entry.file.sizeBytes,
      source: 'civitai',
      toolId: tool.id,
    },
    tool,
    hardwareContext,
  );
}
async function searchCivitaiModels(tool, browseOptions, downloadedLookup, settings, hardwareContext, logger) {
  const selectedModelType = normalizeModelTypeFilter(browseOptions.modelType);
  const selectedTaskType = normalizeTaskTypeFilter(browseOptions.taskType);
  const modelTypeProfile = getModelTypeProfile(selectedModelType);
  const derivedSearchTerms = getDerivedSearchTerms(browseOptions);
  const derivedSearchQuery = derivedSearchTerms.find(Boolean) || '';
  const catalogRequirements = getCatalogRequirements(browseOptions);
  const fileLevelSearch = Boolean(derivedSearchQuery) && isFileLikeSearchQuery(derivedSearchQuery);
  if (selectedModelType === 'gguf' || selectedModelType === 'audio-speech' || selectedTaskType === 'audio-speech') {
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
  if (derivedSearchQuery) {
    searchUrl.searchParams.set('query', derivedSearchQuery);
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
    query: derivedSearchQuery,
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
    const candidateFiles = collectCivitaiVersionFiles(model, browseOptions.modelType);
    const primaryEntry = candidateFiles[0] || null;
    if (primaryEntry) {
      modelItems.push(buildCivitaiModelResult(model, primaryEntry, tool, downloadedLookup, hardwareContext, catalogRequirements));
    }
    if (derivedSearchQuery) {
      const matchingFiles = candidateFiles.filter((entry) =>
        matchesSearchQuery(derivedSearchQuery, [
          entry.file.name,
          entry.version?.name,
          entry.version?.baseModel,
          entry.version?.baseModelType,
        ]),
      );
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
  return {
    items: mergeCatalogSearchItems(getCatalogSearchGroups(modelItems, artifactItems, fileLevelSearch), browseOptions.limit),
    pagination: {
      hasMore: Boolean(nextCursor),
      nextCursor,
      nextPage: null,
    },
  };
}
async function browseRemoteModels(tool, options = {}) {
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
    hasCivitaiApiKey: Boolean(settings.hasCivitaiApiKey),
  };
  const localModels = await listDownloadedModels(tool).catch(() => []);
  const downloadedLookup = buildDownloadedLookup(localModels);
  const hardwareContext = await loadHardwareContext();
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
}
function parseOllamaCompactNumber(value) {
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
  if (!OLLAMA_FAMILY_CACHE.has(cacheKey)) {
    OLLAMA_FAMILY_CACHE.set(
      cacheKey,
      (async () => {
        const familyUrl = buildOllamaAbsoluteUrl(entry.libraryPath || `/library/${entry.slug || entry.name}`);
        try {
          const response = await fetch(familyUrl, {
            headers: {
              'User-Agent': APP_USER_AGENT,
            },
          });
          if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}.`);
          }
          const html = await response.text();
          return {
            description: extractOllamaFamilyDescription(html, entry.description || `Ollama model ${entry.name}`),
            previewUrl: extractOllamaFamilyPreviewUrl(html) || entry.previewUrl || null,
            searchText: extractOllamaFamilySearchText(html),
            variants: parseOllamaFamilyVariants(html, entry.name),
          };
        } catch (error) {
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
      })(),
    );
  }
  return OLLAMA_FAMILY_CACHE.get(cacheKey);
}
function getOllamaDefaultVariant(familyDetails) {
  const variants = familyDetails?.variants || [];
  return variants.find((variant) => variant.latest && !variant.isLatestAlias) || variants.find((variant) => variant.isLatestAlias) || variants.find((variant) => variant.latest) || variants[0] || null;
}
function buildOllamaFamilyCard(entry, familyDetails) {
  const defaultVariant = getOllamaDefaultVariant(familyDetails);
  return {
    ...entry,
    catalogContext: defaultVariant?.name && defaultVariant.name !== entry.name ? `Default variant: ${defaultVariant.name}` : null,
    catalogEntityLabel: 'Model',
    catalogEntityType: 'model',
    description: familyDetails?.description || entry.description,
    familySearchText: familyDetails?.searchText || '',
    fileName: defaultVariant?.name || entry.fileName,
    previewUrl: familyDetails?.previewUrl || entry.previewUrl || null,
    sizeBytes: defaultVariant?.sizeBytes || entry.sizeBytes || 0,
    sizeLabel: defaultVariant?.sizeLabel || entry.sizeLabel,
  };
}
function buildOllamaVariantCard(entry, familyDetails, variant) {
  return {
    capabilities: entry.capabilities,
    catalogContext: [variant.sizeLabel, variant.contextLabel, variant.inputLabel].filter(Boolean).join(' | ') || null,
    catalogEntityLabel: 'Variant',
    catalogEntityType: 'variant',
    catalogParentLabel: entry.name,
    contextLabel: variant.contextLabel,
    description: familyDetails?.description || entry.description,
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
  const response = await fetch(searchUrl, {
    headers: {
      'User-Agent': APP_USER_AGENT,
    },
  });
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
      const response = await fetch(registryUrl, {
        headers: {
          'User-Agent': APP_USER_AGENT,
        },
      });
      if (!response.ok) {
        lastError = new Error(`Request failed with status ${response.status}.`);
        continue;
      }
      const html = await response.text();
      if (html.includes('<table>')) {
        return html;
      }
    } catch (error) {
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
  const haystack = [entry.name, entry.repoId, entry.license, ...(entry.categories || []).map((category) => TABBY_SECTION_LABELS[category])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(normalizedQuery);
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
    .filter((entry) => matchesTabbyRegistryQuery(entry, browseOptions.query));
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
    const file = await resolveHuggingFaceDownloadFile(detail, effectiveModelType, logger);
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
      return attachHardwareHints(
        {
          id: `tabby:repository:${detail.id}`,
          author: detail.author || null,
          catalogContext: [categoryLabels ? `Tabby ${categoryLabels}` : 'Tabby registry', `Repository: ${detail.id}`, file.rfilename ? `Primary artifact: ${file.rfilename}` : null]
            .filter(Boolean)
            .join(' | '),
          catalogEntityLabel: 'Repository',
          catalogEntityType: 'repository',
          catalogRepositoryId: detail.id,
          description: `Tabby ${categoryLabels || 'registry'} pick | ${buildHuggingFaceDescription(detail)} | ${entry.license}`,
          downloaded: isDownloadedMatch(downloadedLookup, buildCatalogLookupValues(detail.id, installRelativePath, [fileName, detail.id, entry.name])),
          downloadUrl: buildHuggingFaceResolveUrl(detail.id, file.rfilename),
          fileName,
          installRelativePath,
          modelType: file.modelType,
          name: entry.name || detail.id,
          previewUrl: await resolveHuggingFacePreview(detail, logger),
          sizeBytes: Number(file.sizeBytes || 0),
          source: 'tabby',
          toolId: tool.id,
        },
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
async function getModelDownloadPreflight(tool, payload = {}) {
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
async function downloadRemoteModel(tool, payload, options = {}) {
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
      return {
        destinationPath,
        fileName,
        alreadyPresent: false,
        message: `${payload.name} was added to ${tool.name}.`,
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
async function deleteModel(tool, payload) {
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
  listDownloadedModels,
  readModelSettings,
  saveModelManagerSettings,
  supportsModelManager
};
