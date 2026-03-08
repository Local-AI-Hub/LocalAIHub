const path = require('path');
const fs = require('fs-extra');
const { open } = require('node:fs/promises');

const { version: APP_VERSION } = require('../../package.json');
const { ensureStorage, humanizeError, readConfig, saveHardwareDetection } = require('./configService');
const { runCommand } = require('./commandService');
const { detectHardwareSnapshot, detectStorageSnapshot, findDiskForPath } = require('./hardwareService');
const { createLogger } = require('./logService');
const { listOllamaModels } = require('./ollamaService');

const APP_USER_AGENT = `LocalAIHub/${APP_VERSION}`;
const MODEL_SETTINGS_FILE = 'model-manager.settings.json';
const MODEL_DOWNLOAD_BUFFER_LIMIT = 10 * 1024 * 1024;
const REMOTE_PAGE_SIZE = 24;
const OLLAMA_PAGE_SIZE = 40;
const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';
const HUGGING_FACE_SEARCH_URL = 'https://huggingface.co/api/models';
const HUGGING_FACE_MODEL_URL = 'https://huggingface.co/api/models';
const CIVITAI_MODELS_URL = 'https://civitai.com/api/v1/models';
const MODEL_FILE_PATTERN = /\.(safetensors|ckpt|pt|pth|bin|gguf)$/i;
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|gif)$/i;
const README_FILE_PATTERN = /(?:^|\/)README\.md$/i;
const MODEL_MANAGER_TOOL_IDS = new Set(['ollama', 'comfyui', 'automatic1111']);
const HUGGING_FACE_FILE_SIZE_CACHE = new Map();
const HUGGING_FACE_PREVIEW_CACHE = new Map();
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
const HF_TASK_MAP = {
  'image-generation': 'text-to-image',
  'image-to-image': 'image-to-image',
  'text-generation': 'text-generation',
  'text-to-image': 'text-to-image',
};
const CIVITAI_TYPE_MAP = {
  checkpoint: ['Checkpoint'],
  lora: ['LORA'],
  vae: ['VAE'],
  embedding: ['TextualInversion'],
  controlnet: ['Controlnet'],
  hypernetwork: ['Hypernetwork'],
};

function supportsModelManager(tool) {
  return MODEL_MANAGER_TOOL_IDS.has(tool?.id);
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
    .replace(/\s+/g, ' ')
    .trim();
}

function buildModelSettingsDefaults() {
  return {
    civitaiApiKey: '',
  };
}

async function getModelSettingsPath() {
  const { root } = await ensureStorage();
  return path.join(root, MODEL_SETTINGS_FILE);
}

async function readModelSettings() {
  const settingsPath = await getModelSettingsPath();
  if (!(await fs.pathExists(settingsPath))) {
    return buildModelSettingsDefaults();
  }

  try {
    const settings = await fs.readJson(settingsPath);
    return {
      ...buildModelSettingsDefaults(),
      ...(settings || {}),
    };
  } catch {
    return buildModelSettingsDefaults();
  }
}

async function writeModelSettings(settings) {
  const settingsPath = await getModelSettingsPath();
  const nextSettings = {
    ...buildModelSettingsDefaults(),
    ...(settings || {}),
  };
  await fs.writeJson(settingsPath, nextSettings, { spaces: 2 });
  return nextSettings;
}

async function saveModelManagerSettings(patch) {
  const current = await readModelSettings();
  return writeModelSettings({
    ...current,
    ...(patch || {}),
  });
}

function getOllamaModelsRoot() {
  if (process.env.OLLAMA_MODELS) {
    return process.env.OLLAMA_MODELS;
  }

  return path.join(process.env.USERPROFILE || '', '.ollama', 'models');
}

function normalizeBrowseOptions(options = {}, tool) {
  const sort = String(options.sort || 'most-downloaded').trim().toLowerCase();
  return {
    cursor: String(options.cursor || '').trim() || null,
    limit: Number(options.limit) > 0 ? Math.min(REMOTE_PAGE_SIZE, Number(options.limit)) : REMOTE_PAGE_SIZE,
    modelType: normalizeModelTypeFilter(options.modelType),
    page: Math.max(1, Number(options.page) || 1),
    query: String(options.query || '').trim(),
    sort: HF_SORT_MAP[sort] || CIVITAI_SORT_MAP[sort] ? sort : 'most-downloaded',
    source: String(options.source || (tool?.id === 'ollama' ? 'ollama' : 'huggingface')).trim(),
    taskType: String(options.taskType || (tool?.id === 'ollama' ? 'all' : 'image-generation')).trim() || 'all',
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

function buildDiskWarning(sizeBytes, disk) {
  if (!disk || !Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isFinite(disk.sizeBytes) || disk.sizeBytes <= 0) {
    return null;
  }

  const remainingBytes = disk.freeBytes - sizeBytes;
  const remainingPercent = remainingBytes / disk.sizeBytes;
  if (remainingBytes < 0) {
    return {
      tone: 'danger',
      message: `This download is larger than the free space on ${disk.mount}.`,
    };
  }

  if (remainingPercent < 0.1) {
    return {
      tone: 'warn',
      message: `This download would leave less than 10% free on ${disk.mount}.`,
    };
  }

  return {
    tone: 'good',
    message: `${disk.mount} has enough free space for this download.`,
  };
}

function buildHardwareFit(sizeBytes, hardware) {
  const vramMb = Number(hardware?.vramMb || 0);
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
  const targetDirectory = getTargetDirectory(tool, item.modelType);
  const disk = findDiskForPath(hardwareContext.disks, targetDirectory || tool.installDir || tool.appDir || getOllamaModelsRoot());
  return {
    ...item,
    diskWarning: buildDiskWarning(item.sizeBytes, disk),
    downloadTarget: targetDirectory,
    hardwareFit: buildHardwareFit(item.sizeBytes, hardwareContext.hardware),
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
  const appDir = tool?.appDir || tool?.installDir || '';

  if (tool?.id !== 'ollama' && !appDir) {
    return {};
  }

  if (tool?.id === 'comfyui') {
    return {
      Checkpoint: path.join(appDir, 'models', 'checkpoints'),
      LoRA: path.join(appDir, 'models', 'loras'),
      VAE: path.join(appDir, 'models', 'vae'),
      Embedding: path.join(appDir, 'models', 'embeddings'),
      ControlNet: path.join(appDir, 'models', 'controlnet'),
      Hypernetwork: path.join(appDir, 'models', 'hypernetworks'),
      GGUF: path.join(appDir, 'models', 'gguf'),
    };
  }

  if (tool?.id === 'automatic1111') {
    return {
      Checkpoint: path.join(appDir, 'models', 'Stable-diffusion'),
      LoRA: path.join(appDir, 'models', 'Lora'),
      VAE: path.join(appDir, 'models', 'VAE'),
      Embedding: path.join(appDir, 'embeddings'),
      ControlNet: path.join(appDir, 'models', 'ControlNet'),
      Hypernetwork: path.join(appDir, 'models', 'hypernetworks'),
      GGUF: path.join(appDir, 'models', 'GGUF'),
    };
  }

  if (tool?.id === 'ollama') {
    return {
      Model: getOllamaModelsRoot(),
    };
  }

  return {};
}

function getTargetDirectory(tool, modelType) {
  const directories = getToolModelDirectories(tool);
  return directories[normalizeModelType(modelType)] || directories.Checkpoint || directories.Model || null;
}

function isSafeChildPath(parentPath, candidatePath) {
  const normalizedParent = path.resolve(parentPath || '');
  const normalizedCandidate = path.resolve(candidatePath || '');
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

async function listLocalFileModels(tool) {
  const directories = getToolModelDirectories(tool);
  const localModels = [];

  for (const [modelType, directory] of Object.entries(directories)) {
    if (!(await fs.pathExists(directory))) {
      continue;
    }

    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !MODEL_FILE_PATTERN.test(entry.name)) {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      const stats = await fs.stat(fullPath);
      localModels.push({
        id: `${tool.id}:${modelType}:${entry.name}`,
        downloaded: true,
        fileName: entry.name,
        modelType,
        name: path.parse(entry.name).name,
        path: fullPath,
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
  const manifestsRoot = path.join(getOllamaModelsRoot(), 'manifests');
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
  if (!supportsModelManager(tool)) {
    return [];
  }

  if (tool.id === 'ollama') {
    return listLocalOllamaModels(tool);
  }

  return listLocalFileModels(tool);
}

async function countDownloadedModels(tool) {
  if (!supportsModelManager(tool)) {
    return 0;
  }

  if (tool.id === 'ollama') {
    return (await listLocalOllamaModelsFromFilesystem(tool)).length;
  }

  return (await listLocalFileModels(tool)).length;
}

function buildDownloadedLookup(localModels) {
  const lookup = new Set();
  for (const model of localModels || []) {
    lookup.add(String(model.fileName || '').toLowerCase());
    lookup.add(String(model.name || '').toLowerCase());
  }
  return lookup;
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

function pickHuggingFaceDownloadFile(detail, selectedType) {
  const candidateFiles = (detail.siblings || [])
    .filter((entry) => MODEL_FILE_PATTERN.test(entry.rfilename || ''))
    .map((entry) => ({
      ...entry,
      modelType: inferHuggingFaceType(detail, entry),
      sizeBytes: getKnownHuggingFaceFileSize(entry),
    }))
    .filter((entry) => matchesSelectedModelType(entry.modelType, selectedType));

  if (!candidateFiles.length) {
    return null;
  }

  return [...candidateFiles].sort((left, right) => right.sizeBytes - left.sizeBytes)[0];
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
    throw new Error(`Request failed with status ${response.status}.`);
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

async function fetchHuggingFacePage(tool, browseOptions, logger) {
  const searchUrl = new URL(HUGGING_FACE_SEARCH_URL);
  searchUrl.searchParams.set('limit', String(browseOptions.limit));
  searchUrl.searchParams.set('sort', HF_SORT_MAP[browseOptions.sort] || HF_SORT_MAP['most-downloaded']);
  searchUrl.searchParams.set('direction', '-1');
  if (browseOptions.query) {
    searchUrl.searchParams.set('search', browseOptions.query);
  }

  const pipelineTag = HF_TASK_MAP[browseOptions.taskType];
  if (pipelineTag) {
    searchUrl.searchParams.set('pipeline_tag', pipelineTag);
  }

  if (browseOptions.cursor) {
    searchUrl.searchParams.set('cursor', browseOptions.cursor);
  }

  await logger.info('Searching Hugging Face models.', {
    query: browseOptions.query || '',
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

async function searchHuggingFaceModels(tool, browseOptions, downloadedLookup, hardwareContext, logger) {
  const items = [];
  let rawCursor = browseOptions.cursor;
  let nextCursor = null;

  for (let scanCount = 0; scanCount < 3 && items.length < browseOptions.limit; scanCount += 1) {
    const page = await fetchHuggingFacePage(tool, { ...browseOptions, cursor: rawCursor }, logger);
    const details = await fetchHuggingFaceDetails(page.results, logger);
    const resolvedItems = await Promise.all(
      details.map(async (detail) => {
        const file = await resolveHuggingFaceDownloadFile(detail, browseOptions.modelType, logger);
        if (!file) {
          return null;
        }

        const fileName = path.basename(file.rfilename);
        return attachHardwareHints(
          {
            id: 'huggingface:' + detail.id + ':' + fileName,
            author: detail.author || null,
            description: buildHuggingFaceDescription(detail),
            downloaded: downloadedLookup.has(fileName.toLowerCase()) || downloadedLookup.has(detail.id.toLowerCase()),
            downloadUrl: buildHuggingFaceResolveUrl(detail.id, file.rfilename),
            fileName,
            modelType: file.modelType,
            name: detail.id,
            previewUrl: await resolveHuggingFacePreview(detail, logger),
            sizeBytes: Number(file.sizeBytes || 0),
            source: 'huggingface',
            toolId: tool.id,
          },
          tool,
          hardwareContext,
        );
      }),
    );

    for (const item of resolvedItems.filter(Boolean)) {
      items.push(item);
      if (items.length >= browseOptions.limit) {
        break;
      }
    }

    nextCursor = page.nextCursor;
    if (!nextCursor || items.length >= browseOptions.limit) {
      break;
    }

    rawCursor = nextCursor;
  }

  return {
    items,
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

function pickCivitaiPrimaryFile(model, selectedType) {
  const version = model.modelVersions?.[0];
  if (!version) {
    return null;
  }

  const files = (version.files || [])
    .map((file) => ({
      ...file,
      normalizedType: normalizeModelType(file.type || file.name || model.type),
      sizeBytes: Number(file.sizeBytes || 0) || toFileSizeBytes(Number(file.sizeKB || 0)),
    }))
    .filter((file) => matchesSelectedModelType(file.normalizedType, selectedType));

  if (!files.length) {
    return null;
  }

  return {
    version,
    file: files.find((entry) => entry.primary) || files[0],
  };
}

function normalizeCivitaiNextPage(metadata, currentPage) {
  if (Number.isFinite(metadata?.nextPage)) {
    return metadata.nextPage;
  }

  if (typeof metadata?.nextPage === 'string') {
    try {
      const parsed = Number(new URL(metadata.nextPage).searchParams.get('page'));
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  if (Number.isFinite(metadata?.currentPage) && Number.isFinite(metadata?.totalPages) && metadata.currentPage < metadata.totalPages) {
    return currentPage + 1;
  }

  return null;
}

async function searchCivitaiModels(tool, browseOptions, downloadedLookup, settings, hardwareContext, logger) {
  const searchUrl = new URL(CIVITAI_MODELS_URL);
  searchUrl.searchParams.set('limit', String(browseOptions.limit));
  searchUrl.searchParams.set('page', String(browseOptions.page));
  searchUrl.searchParams.set('sort', CIVITAI_SORT_MAP[browseOptions.sort] || CIVITAI_SORT_MAP['most-downloaded']);
  searchUrl.searchParams.set('period', 'AllTime');
  if (browseOptions.query) {
    searchUrl.searchParams.set('query', browseOptions.query);
  }

  const mappedTypes = CIVITAI_TYPE_MAP[browseOptions.modelType];
  for (const type of mappedTypes || []) {
    searchUrl.searchParams.append('types', type);
  }

  await logger.info('Searching CivitAI models.', {
    modelType: browseOptions.modelType,
    page: browseOptions.page,
    query: browseOptions.query || '',
    sort: browseOptions.sort,
    toolId: tool.id,
  });

  const { payload } = await fetchJsonResponse(searchUrl, {
    headers: buildCivitaiHeaders(settings),
  });

  const items = (payload.items || [])
    .map((model) => {
      const primary = pickCivitaiPrimaryFile(model, browseOptions.modelType);
      if (!primary) {
        return null;
      }

      const fileName = primary.file.name;
      const previewImage = primary.version.images?.find((image) => image.type === 'image');
      return attachHardwareHints(
        {
          id: `civitai:${model.id}:${primary.version.id}:${fileName}`,
          author: model.creator?.username || null,
          description:
            stripHtml(model.description) ||
            `CivitAI ${model.type || 'model'} by ${model.creator?.username || 'the community'}`,
          downloaded: downloadedLookup.has(fileName.toLowerCase()) || downloadedLookup.has(model.name.toLowerCase()),
          downloadUrl: primary.file.downloadUrl || primary.version.downloadUrl,
          fileName,
          modelType: primary.file.normalizedType,
          name: model.name,
          previewUrl: previewImage?.url || null,
          sizeBytes: primary.file.sizeBytes,
          source: 'civitai',
          toolId: tool.id,
        },
        tool,
        hardwareContext,
      );
    })
    .filter(Boolean);

  const nextPage = normalizeCivitaiNextPage(payload.metadata, browseOptions.page);
  return {
    items,
    pagination: {
      hasMore: Boolean(nextPage),
      nextCursor: null,
      nextPage,
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
    throw new Error('Local AI Hub can only browse models for Ollama, ComfyUI, and Automatic1111.');
  }

  const settings = await readModelSettings();
  const localModels = await listDownloadedModels(tool).catch(() => []);
  const downloadedLookup = buildDownloadedLookup(localModels);
  const hardwareContext = await loadHardwareContext();

  if (tool.id === 'ollama') {
    const result = await searchOllamaLibrary(tool, browseOptions, downloadedLookup, hardwareContext, logger);
    return {
      items: result.items,
      localModels,
      pagination: result.pagination,
      settings,
    };
  }

  if (browseOptions.source === 'civitai') {
    const result = await searchCivitaiModels(tool, browseOptions, downloadedLookup, settings, hardwareContext, logger);
    return {
      items: result.items,
      localModels,
      pagination: result.pagination,
      settings,
    };
  }

  const result = await searchHuggingFaceModels(tool, browseOptions, downloadedLookup, hardwareContext, logger);
  return {
    items: result.items,
    localModels,
    pagination: result.pagination,
    settings,
  };
}

function parseOllamaLibraryCards(html, query) {
  const results = [];
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const cardPattern = /<li[^>]*>\s*<a[^>]+href="\/library\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi;
  let match = null;

  while ((match = cardPattern.exec(html)) !== null) {
    const name = match[1];
    const cardText = stripHtml(match[2]);
    const lines = cardText.split(/\s{2,}/).map((line) => line.trim()).filter(Boolean);
    const description = lines.slice(1).join(' ').replace(/\s+/g, ' ').trim();
    const sizeMatch = cardText.match(/\b([0-9.]+\s*[kmgt]?b(?:\s+[0-9.]+\s*[kmgt]?b)*)\b/i);
    const sizeLabel = sizeMatch ? sizeMatch[1].trim() : 'Available from Ollama';

    const combined = `${name} ${description}`.toLowerCase();
    if (normalizedQuery && !combined.includes(normalizedQuery)) {
      continue;
    }

    results.push({
      id: `ollama:${name}`,
      description: description || `Ollama model ${name}`,
      downloadUrl: null,
      fileName: name,
      modelType: 'Model',
      name,
      previewUrl: null,
      sizeBytes: parseHumanSizeToBytes(sizeLabel),
      sizeLabel,
      source: 'ollama',
      toolId: 'ollama',
    });
  }

  return results;
}

async function searchOllamaLibrary(tool, browseOptions, downloadedLookup, hardwareContext, logger) {
  await logger.info('Loading Ollama library page.', {
    page: browseOptions.page,
    query: browseOptions.query || '',
  });

  const response = await fetch(OLLAMA_LIBRARY_URL, {
    headers: {
      'User-Agent': APP_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error('Local AI Hub could not load the Ollama library list right now.');
  }

  const html = await response.text();
  const allItems = parseOllamaLibraryCards(html, browseOptions.query)
    .map((entry) =>
      attachHardwareHints(
        {
          ...entry,
          downloaded: downloadedLookup.has(entry.fileName.toLowerCase()) || downloadedLookup.has(entry.name.toLowerCase()),
        },
        tool,
        hardwareContext,
      ),
    );

  const startIndex = (browseOptions.page - 1) * OLLAMA_PAGE_SIZE;
  return {
    items: allItems.slice(startIndex, startIndex + OLLAMA_PAGE_SIZE),
    pagination: {
      hasMore: startIndex + OLLAMA_PAGE_SIZE < allItems.length,
      nextCursor: null,
      nextPage: startIndex + OLLAMA_PAGE_SIZE < allItems.length ? browseOptions.page + 1 : null,
    },
  };
}

function emitProgress(onProgress, payload) {
  if (typeof onProgress === 'function') {
    onProgress(payload);
  }
}

async function streamDownloadToFile(downloadUrl, destinationPath, options = {}) {
  const response = await fetch(downloadUrl, {
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
async function ensureDiskHasCapacity(targetDirectory, payload) {
  const disks = await detectStorageSnapshot().catch(() => []);
  const disk = findDiskForPath(disks, targetDirectory);
  if (!disk || !Number.isFinite(payload.sizeBytes) || payload.sizeBytes <= 0) {
    return;
  }

  if (disk.freeBytes < payload.sizeBytes) {
    throw new Error(`${payload.name} is larger than the free space on ${disk.mount}. Clear space and try again.`);
  }
}

async function downloadRemoteModel(tool, payload, options = {}) {
  const logger = createLogger('models', {
    toolId: tool.id,
    mode: 'download',
    source: payload.source,
    modelId: payload.id,
  });

  const targetDirectory = getTargetDirectory(tool, payload.modelType);
  if (!targetDirectory) {
    throw new Error(`Local AI Hub could not determine where ${tool.name} stores ${payload.modelType} files.`);
  }

  const fileName = path.basename(payload.fileName || payload.name || 'model.safetensors');
  const destinationPath = path.join(targetDirectory, fileName);
  const settings = await readModelSettings();
  const headers = payload.source === 'civitai' ? buildCivitaiHeaders(settings) : { 'User-Agent': APP_USER_AGENT };

  if (await fs.pathExists(destinationPath)) {
    return {
      destinationPath,
      fileName,
      alreadyPresent: true,
      message: `${fileName} is already in ${tool.name}.`,
    };
  }

  await ensureDiskHasCapacity(targetDirectory, payload);

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await logger.info('Downloading model file.', {
        downloadUrl: payload.downloadUrl,
        destinationPath,
        attempt,
      });

      emitProgress(options.onProgress, {
        downloadId: payload.id,
        message: `Downloading ${payload.name}.`,
        percent: 2,
        receivedBytes: 0,
        totalBytes: payload.sizeBytes || 0,
      });

      const result = await streamDownloadToFile(payload.downloadUrl, destinationPath, {
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
  const logger = createLogger('models', {
    toolId: tool.id,
    mode: 'download',
    source: 'ollama',
    modelId: payload.id,
  });

  const response = await fetch(new URL('/api/pull', `${tool.launchUrl.replace(/\/$/, '')}/`).toString(), {
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
    throw new Error(`${payload.name} could not be pulled from Ollama right now.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let latestPercent = 0;

  await logger.info('Ollama model pull started.', {
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
    message: `${payload.name} was downloaded into Ollama.`,
  };
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
      const response = await fetch(new URL('/api/delete', (tool.launchUrl || '').replace(/\/$/, '') + '/').toString(), {
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
  const targetDirectory = getTargetDirectory(tool, payload.modelType);
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
  listDownloadedModels,
  readModelSettings,
  saveModelManagerSettings,
  supportsModelManager,
};










