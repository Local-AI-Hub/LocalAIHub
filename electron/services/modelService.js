const path = require('path');
const fs = require('fs-extra');
const { open } = require('node:fs/promises');

const { ensureStorage, humanizeError } = require('./configService');
const { createLogger } = require('./logService');
const { listOllamaModels } = require('./ollamaService');

const MODEL_SETTINGS_FILE = 'model-manager.settings.json';
const MODEL_DOWNLOAD_BUFFER_LIMIT = 10 * 1024 * 1024;
const HF_SEARCH_LIMIT = 10;
const CIVITAI_SEARCH_LIMIT = 18;
const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';
const HUGGING_FACE_SEARCH_URL = 'https://huggingface.co/api/models';
const HUGGING_FACE_MODEL_URL = 'https://huggingface.co/api/models';
const CIVITAI_MODELS_URL = 'https://civitai.com/api/v1/models';
const MODEL_FILE_PATTERN = /\.(safetensors|ckpt|pt|pth|bin)$/i;
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp)$/i;
const MODEL_MANAGER_TOOL_IDS = new Set(['ollama', 'comfyui', 'automatic1111']);

function supportsModelManager(tool) {
  return MODEL_MANAGER_TOOL_IDS.has(tool?.id);
}

function toFileSizeBytes(sizeKb) {
  return Number.isFinite(sizeKb) ? Math.round(sizeKb * 1024) : 0;
}

function normalizeModelType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return 'Checkpoint';
  }

  if (normalized.includes('lora')) {
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

function getToolModelDirectories(tool) {
  const appDir = tool?.appDir || tool?.installDir || '';

  if (tool?.id === 'comfyui') {
    return {
      Checkpoint: path.join(appDir, 'models', 'checkpoints'),
      LoRA: path.join(appDir, 'models', 'loras'),
      VAE: path.join(appDir, 'models', 'vae'),
      Embedding: path.join(appDir, 'models', 'embeddings'),
      ControlNet: path.join(appDir, 'models', 'controlnet'),
      Hypernetwork: path.join(appDir, 'models', 'hypernetworks'),
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
    };
  }

  return {};
}

function getTargetDirectory(tool, modelType) {
  const directories = getToolModelDirectories(tool);
  return directories[normalizeModelType(modelType)] || directories.Checkpoint || null;
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

async function listLocalOllamaModels(tool) {
  const response = await listOllamaModels(tool);
  return (response.models || []).map((model) => ({
    id: `ollama:${model.name}`,
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
    ? `Hugging Face ${detailParts.join(' | ')}`
    : `Hugging Face model by ${detail.author || 'the community'}`;
}

function inferHuggingFaceType(detail, fileEntry) {
  const combined = `${detail.pipeline_tag || ''} ${(detail.tags || []).join(' ')} ${fileEntry?.rfilename || ''}`.toLowerCase();
  return normalizeModelType(combined);
}

function pickHuggingFaceDownloadFile(detail) {
  const candidateFiles = (detail.siblings || [])
    .filter((entry) => MODEL_FILE_PATTERN.test(entry.rfilename || ''))
    .map((entry) => ({
      ...entry,
      modelType: inferHuggingFaceType(detail, entry),
      sizeBytes: Number(entry.lfs?.size || entry.size || 0),
    }));

  if (!candidateFiles.length) {
    return null;
  }

  return [...candidateFiles].sort((left, right) => {
    if (left.modelType !== right.modelType) {
      return left.modelType.localeCompare(right.modelType);
    }
    return right.sizeBytes - left.sizeBytes;
  })[0];
}

function pickHuggingFacePreview(detail) {
  const image = (detail.siblings || []).find((entry) => IMAGE_FILE_PATTERN.test(entry.rfilename || ''));
  if (!image) {
    return null;
  }

  return buildHuggingFaceResolveUrl(detail.id, image.rfilename);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  return response.json();
}

async function searchHuggingFaceModels(tool, query, downloadedLookup, logger) {
  const searchUrl = new URL(HUGGING_FACE_SEARCH_URL);
  searchUrl.searchParams.set('search', query || 'stable diffusion');
  searchUrl.searchParams.set('limit', String(HF_SEARCH_LIMIT));
  searchUrl.searchParams.set('sort', 'downloads');
  searchUrl.searchParams.set('direction', '-1');

  await logger.info('Searching Hugging Face models.', {
    toolId: tool.id,
    query: query || 'stable diffusion',
  });

  const searchResults = await fetchJson(searchUrl, {
    headers: {
      'User-Agent': 'LocalAIHub/0.2.0',
    },
  });

  const detailResults = await Promise.all(
    (searchResults || [])
      .filter((result) => !result.private && !result.gated)
      .slice(0, HF_SEARCH_LIMIT)
      .map(async (result) => {
        try {
          return await fetchJson(`${HUGGING_FACE_MODEL_URL}/${result.id}?files_metadata=true`, {
            headers: {
              'User-Agent': 'LocalAIHub/0.2.0',
            },
          });
        } catch (error) {
          await logger.warn('A Hugging Face model detail request failed.', {
            modelId: result.id,
            error,
          });
          return null;
        }
      }),
  );

  return detailResults
    .filter(Boolean)
    .map((detail) => {
      const file = pickHuggingFaceDownloadFile(detail);
      if (!file) {
        return null;
      }

      const fileName = path.basename(file.rfilename);
      return {
        id: `huggingface:${detail.id}:${fileName}`,
        author: detail.author || null,
        description: buildHuggingFaceDescription(detail),
        downloaded: downloadedLookup.has(fileName.toLowerCase()) || downloadedLookup.has(detail.id.toLowerCase()),
        downloadUrl: buildHuggingFaceResolveUrl(detail.id, file.rfilename),
        fileName,
        modelType: file.modelType,
        name: detail.id,
        previewUrl: pickHuggingFacePreview(detail),
        sizeBytes: file.sizeBytes,
        source: 'huggingface',
        toolId: tool.id,
      };
    })
    .filter(Boolean);
}

function buildCivitaiHeaders(settings) {
  const apiKey = String(settings?.civitaiApiKey || '').trim();
  if (!apiKey) {
    return {
      'User-Agent': 'LocalAIHub/0.2.0',
    };
  }

  return {
    'User-Agent': 'LocalAIHub/0.2.0',
    Authorization: `Bearer ${apiKey}`,
  };
}

function pickCivitaiPrimaryFile(model) {
  const version = model.modelVersions?.[0];
  if (!version) {
    return null;
  }

  const file = version.files?.find((entry) => entry.primary) || version.files?.[0];
  if (!file) {
    return null;
  }

  return {
    version,
    file,
  };
}

async function searchCivitaiModels(tool, query, downloadedLookup, settings, logger) {
  const searchUrl = new URL(CIVITAI_MODELS_URL);
  searchUrl.searchParams.set('limit', String(CIVITAI_SEARCH_LIMIT));
  searchUrl.searchParams.set('query', query || 'sdxl');
  ['Checkpoint', 'LORA', 'VAE', 'TextualInversion'].forEach((type) => searchUrl.searchParams.append('types', type));

  await logger.info('Searching CivitAI models.', {
    toolId: tool.id,
    query: query || 'sdxl',
  });

  const payload = await fetchJson(searchUrl, {
    headers: buildCivitaiHeaders(settings),
  });

  return (payload.items || [])
    .map((model) => {
      const primary = pickCivitaiPrimaryFile(model);
      if (!primary) {
        return null;
      }

      const fileName = primary.file.name;
      const previewImage = primary.version.images?.find((image) => image.type === 'image');
      return {
        id: `civitai:${model.id}:${primary.version.id}:${fileName}`,
        author: model.creator?.username || null,
        description:
          stripHtml(model.description) ||
          `CivitAI ${model.type || 'model'} by ${model.creator?.username || 'the community'}`,
        downloaded: downloadedLookup.has(fileName.toLowerCase()) || downloadedLookup.has(model.name.toLowerCase()),
        downloadUrl: primary.file.downloadUrl || primary.version.downloadUrl,
        fileName,
        modelType: normalizeModelType(model.type || primary.file.type),
        name: model.name,
        previewUrl: previewImage?.url || null,
        sizeBytes: toFileSizeBytes(primary.file.sizeKB),
        source: 'civitai',
        toolId: tool.id,
      };
    })
    .filter(Boolean);
}

async function browseRemoteModels(tool, options = {}) {
  const logger = createLogger('models', {
    toolId: tool?.id,
    mode: 'browse',
    source: options.source,
  });

  if (!supportsModelManager(tool)) {
    throw new Error('Local AI Hub can only browse models for Ollama, ComfyUI, and Automatic1111.');
  }

  const settings = await readModelSettings();
  const localModels = await listDownloadedModels(tool).catch(() => []);
  const downloadedLookup = buildDownloadedLookup(localModels);

  if (tool.id === 'ollama') {
    const items = await searchOllamaLibrary(options.query, downloadedLookup, logger);
    return {
      items,
      localModels,
      settings,
    };
  }

  if (options.source === 'civitai') {
    return {
      items: await searchCivitaiModels(tool, options.query, downloadedLookup, settings, logger),
      localModels,
      settings,
    };
  }

  return {
    items: await searchHuggingFaceModels(tool, options.query, downloadedLookup, logger),
    localModels,
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
      sizeBytes: 0,
      sizeLabel: sizeMatch ? sizeMatch[1].trim() : 'Available from Ollama',
      source: 'ollama',
      toolId: 'ollama',
    });
  }

  return results;
}

async function searchOllamaLibrary(query, downloadedLookup, logger) {
  await logger.info('Loading Ollama library page.', {
    query: query || '',
  });

  const response = await fetch(OLLAMA_LIBRARY_URL, {
    headers: {
      'User-Agent': 'LocalAIHub/0.2.0',
    },
  });

  if (!response.ok) {
    throw new Error('Local AI Hub could not load the Ollama library list right now.');
  }

  const html = await response.text();
  return parseOllamaLibraryCards(html, query)
    .map((entry) => ({
      ...entry,
      downloaded: downloadedLookup.has(entry.fileName.toLowerCase()) || downloadedLookup.has(entry.name.toLowerCase()),
    }))
    .slice(0, 40);
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
  const headers = payload.source === 'civitai' ? buildCivitaiHeaders(settings) : { 'User-Agent': 'LocalAIHub/0.2.0' };

  if (await fs.pathExists(destinationPath)) {
    return {
      destinationPath,
      fileName,
      alreadyPresent: true,
      message: `${fileName} is already in ${tool.name}.`,
    };
  }

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

async function deleteModel(tool, payload) {
  if (tool.id === 'ollama') {
    const response = await fetch(new URL('/api/delete', `${tool.launchUrl.replace(/\/$/, '')}/`).toString(), {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: payload.name || payload.fileName,
      }),
    });

    if (!response.ok) {
      throw new Error(`${payload.name || payload.fileName} could not be removed from Ollama.`);
    }

    return {
      message: `${payload.name || payload.fileName} was removed from Ollama.`,
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
  deleteModel,
  downloadModel,
  listDownloadedModels,
  readModelSettings,
  saveModelManagerSettings,
  supportsModelManager,
};
