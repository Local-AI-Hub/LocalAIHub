const path = require('path');
const fs = require('fs-extra');

const { ensureStorage, humanizeError } = require('./configService');
const { getProviderSecret, maskSecret, setProviderSecret } = require('./credentialService');
const { createLogger } = require('./logService');
const { getProviderCatalog, getProviderManifest, initializeProviderRegistry, resolveProviderUrl } = require('./providerRegistry');
const { PIPELINE_OPERATION_IDS, getProviderModelCapabilities } = require('../shared/pipelineCapabilities.cjs');

const PROVIDER_SETTINGS_FILE = 'provider-connections.json';
const PROVIDER_SETTINGS_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15000;
const PROVIDER_DOWNLOAD_TIMEOUT_MS = 300000;
const OPENAI_VIDEO_STATUS_TIMEOUT_MS = 10 * 60 * 1000;
const OPENAI_VIDEO_STATUS_POLL_MS = 5000;
const OPENAI_IMAGE_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto']);
const OPENAI_IMAGE_QUALITIES = new Set(['auto', 'low', 'medium', 'high']);
const OPENAI_IMAGE_BACKGROUNDS = new Set(['auto', 'opaque', 'transparent']);
const OPENAI_VIDEO_SIZES = new Set(['1280x720', '720x1280']);
const DEFAULT_GOOGLE_TTS_VOICE = 'Kore';
const GOOGLE_TTS_WAVE_SAMPLE_RATE = 24000;
const GOOGLE_TTS_WAVE_CHANNEL_COUNT = 1;
const GOOGLE_TTS_WAVE_BIT_DEPTH = 16;

let providerStateChangeSink = null;
function createDefaultSettings() {
  return {
    version: PROVIDER_SETTINGS_VERSION,
    providers: {},
  };
}

async function getProviderSettingsPath() {
  const { root } = await ensureStorage();
  return path.join(root, PROVIDER_SETTINGS_FILE);
}

async function readProviderSettings() {
  const settingsPath = await getProviderSettingsPath();
  if (!(await fs.pathExists(settingsPath))) {
    return createDefaultSettings();
  }

  try {
    const settings = await fs.readJson(settingsPath);
    return {
      ...createDefaultSettings(),
      ...(settings || {}),
      providers: settings?.providers && typeof settings.providers === 'object' ? settings.providers : {},
    };
  } catch {
    return createDefaultSettings();
  }
}

async function writeProviderSettings(settings) {
  const settingsPath = await getProviderSettingsPath();
  const nextSettings = {
    ...createDefaultSettings(),
    ...(settings || {}),
    providers: settings?.providers && typeof settings.providers === 'object' ? settings.providers : {},
  };
  await fs.writeJson(settingsPath, nextSettings, { spaces: 2 });
  return nextSettings;
}

async function updateProviderSettings(mutator) {
  const currentSettings = await readProviderSettings();
  const nextSettings = (await mutator(currentSettings)) || currentSettings;
  return writeProviderSettings(nextSettings);
}

function setProviderStateChangeSink(listener) {
  providerStateChangeSink = typeof listener === 'function' ? listener : null;
}

async function notifyProviderStateChanged(details = {}) {
  if (typeof providerStateChangeSink !== 'function') {
    return;
  }

  try {
    await providerStateChangeSink({
      ...details,
      providers: await listProviderConnections(),
    });
  } catch {
    return;
  }
}

function buildProviderHeaders(provider, apiKey, contentType = 'application/json') {
  const headers = {
    ...(provider.configuration?.headers || {}),
  };

  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  if (provider.authType === 'bearer') {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (provider.authType === 'x-api-key') {
    headers['x-api-key'] = apiKey;
  } else if (provider.authType === 'x-goog-api-key') {
    headers['x-goog-api-key'] = apiKey;
  }

  if (provider.configuration?.protocol === 'anthropic') {
    headers['anthropic-version'] = provider.configuration.anthropicVersion || '2023-06-01';
  }

  return headers;
}

async function requestProviderJson(provider, apiKey, endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(resolveProviderUrl(provider, endpoint), {
      method: options.method || 'GET',
      headers: buildProviderHeaders(provider, apiKey, options.contentType === null ? null : options.contentType || 'application/json'),
      body: options.body,
      signal: controller.signal,
    });

    const rawText = await response.text();
    let payload = {};
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { rawText };
      }
    }

    if (!response.ok) {
      const responseMessage =
        payload?.error?.message ||
        payload?.error ||
        payload?.message ||
        payload?.detail ||
        payload?.rawText ||
        `${provider.name} returned ${response.status}.`;
      throw new Error(String(responseMessage).trim());
    }

    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${provider.name} did not answer before Local AI Hub's connection check timed out.`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestProviderBuffer(provider, apiKey, endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || PROVIDER_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(resolveProviderUrl(provider, endpoint), {
      method: options.method || 'GET',
      headers: buildProviderHeaders(provider, apiKey, options.contentType === null ? null : options.contentType || null),
      body: options.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const rawText = await response.text();
      let payload = {};
      if (rawText) {
        try {
          payload = JSON.parse(rawText);
        } catch {
          payload = { rawText };
        }
      }

      const responseMessage =
        payload?.error?.message ||
        payload?.error ||
        payload?.message ||
        payload?.detail ||
        payload?.rawText ||
        `${provider.name} returned ${response.status}.`;
      throw new Error(String(responseMessage).trim());
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: String(response.headers.get('content-type') || '').trim() || 'application/octet-stream',
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${provider.name} took too long to return the finished file.`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function waitForProvider(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function matchesBlockedModel(provider, modelId) {
  const blockedPatterns = provider.configuration?.blockedModelPatterns || [];
  const normalizedId = String(modelId || '').toLowerCase();
  return blockedPatterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(normalizedId);
    } catch {
      return normalizedId.includes(String(pattern || '').toLowerCase());
    }
  });
}

function normalizeProviderOperationId(value) {
  const normalized = String(value || '').trim();
  return Object.values(PIPELINE_OPERATION_IDS).includes(normalized) ? normalized : '';
}

function normalizeListProviderModelsRequest(request) {
  if (request && typeof request === 'object' && !Array.isArray(request)) {
    return {
      operationId: normalizeProviderOperationId(request.operationId),
      providerId: String(request.providerId || '').trim(),
    };
  }

  return {
    operationId: '',
    providerId: String(request || '').trim(),
  };
}

function buildProviderModelMetadata(provider, modelId) {
  const capabilities = getProviderModelCapabilities(provider.id, modelId);
  return {
    capabilityLabels: Array.isArray(capabilities?.capabilityLabels) ? capabilities.capabilityLabels : [],
    capabilitySource: String(capabilities?.capabilitySource || '').trim() || 'provider-default',
    supportedPipelineOperationIds: Object.keys(capabilities?.operations || {}),
  };
}

function shouldIncludeProviderModel(provider, modelId, operationId = '') {
  if (!String(modelId || '').trim()) {
    return false;
  }

  if (operationId) {
    return Boolean(getProviderModelCapabilities(provider.id, modelId)?.operations?.[operationId]);
  }

  return !matchesBlockedModel(provider, modelId);
}

function finalizeProviderModels(provider, models = [], options = {}) {
  const operationId = normalizeProviderOperationId(options.operationId);
  return (Array.isArray(models) ? models : [])
    .filter((entry) => shouldIncludeProviderModel(provider, entry?.id, operationId))
    .map((entry) => ({
      ...entry,
      ...buildProviderModelMetadata(provider, entry.id),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function normalizeAllowedValue(value, allowedValues, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowedValues.has(normalized) ? normalized : fallback;
}

function normalizeOpenAIModels(provider, payload) {
  return (payload?.data || []).map((entry) => ({
    id: String(entry?.id || '').trim(),
    label: String(entry?.id || '').trim(),
    detail: String(entry?.owned_by || provider.name || '').trim() || null,
  }));
}

function normalizeAnthropicModels(payload) {
  return (payload?.data || [])
    .map((entry) => ({
      id: String(entry?.id || '').trim(),
      label: String(entry?.display_name || entry?.id || '').trim(),
      detail: null,
    }))
    .filter((entry) => entry.id)
    .sort((left, right) => left.label.localeCompare(right.label));
}

function normalizeGoogleModels(provider, payload) {
  return (payload?.models || [])
    .map((entry) => ({
      id: String(entry?.name || '').trim(),
      label: String(entry?.displayName || entry?.name || '').replace(/^models\//, '').trim(),
      detail: Array.isArray(entry?.supportedGenerationMethods) ? entry.supportedGenerationMethods.join(', ') : null,
      supportsGenerateContent: Array.isArray(entry?.supportedGenerationMethods)
        ? entry.supportedGenerationMethods.includes('generateContent')
        : false,
    }))
    .filter((entry) => entry.id && entry.supportsGenerateContent);
}

function selectPreferredModel(provider, models, savedModel) {
  if (!Array.isArray(models) || !models.length) {
    return '';
  }

  const normalizedSavedModel = String(savedModel || '').trim();
  if (normalizedSavedModel && models.some((entry) => entry.id === normalizedSavedModel)) {
    return normalizedSavedModel;
  }

  const configuredDefault = String(provider.configuration?.defaultModel || '').trim();
  if (configuredDefault && models.some((entry) => entry.id === configuredDefault)) {
    return configuredDefault;
  }

  const preferredPrefixes = provider.configuration?.preferredModelPrefixes || [];
  for (const prefix of preferredPrefixes) {
    const match = models.find((entry) => entry.id.toLowerCase().startsWith(String(prefix).toLowerCase()));
    if (match) {
      return match.id;
    }
  }

  return models[0].id;
}

function parseProviderTimestamp(value) {
  const timestamp = Date.parse(String(value || '').trim());
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function describeProviderUsageOperation(operationId) {
  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
    return 'audio';
  }

  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
    return 'image';
  }

  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
    return 'video';
  }

  return 'text';
}

function buildProviderStatusMessage(provider, settingsEntry = {}, options = {}) {
  const hasKey = options.hasKey === true;
  const lastTestSucceeded = settingsEntry.lastTestSucceeded === true;
  const lastTestFailed = settingsEntry.lastTestSucceeded === false;
  const lastSuccessfulUseAt = String(settingsEntry.lastSuccessfulUseAt || '').trim();
  const lastSuccessfulOperation = String(settingsEntry.lastSuccessfulOperation || '').trim();
  const lastSuccessfulUseTimestamp = parseProviderTimestamp(lastSuccessfulUseAt);
  const lastTestedTimestamp = parseProviderTimestamp(settingsEntry.lastTestedAt);
  const liveSuccessOutranksFailedTest = Boolean(lastTestFailed && lastSuccessfulUseTimestamp && (!lastTestedTimestamp || lastSuccessfulUseTimestamp >= lastTestedTimestamp));
  const usageLabel = describeProviderUsageOperation(lastSuccessfulOperation);

  if (!hasKey) {
    return {
      libraryStatus: 'disconnected',
      statusLabel: 'Not connected',
      statusMessage: '',
    };
  }

  if (liveSuccessOutranksFailedTest) {
    return {
      libraryStatus: 'connected',
      statusLabel: 'Connected',
      statusMessage: provider.name + ' completed a real ' + usageLabel + ' request on this PC more recently than its last failed connection check. Re-test the provider if you want to refresh the saved check history.',
    };
  }

  if (lastTestFailed) {
    return {
      libraryStatus: 'attention',
      statusLabel: 'Needs attention',
      statusMessage: String(settingsEntry.lastTestMessage || '').trim() || (provider.name + ' has a saved API key, but the last connection check failed on this PC.'),
    };
  }

  if (lastTestSucceeded) {
    return {
      libraryStatus: 'connected',
      statusLabel: 'Connected',
      statusMessage: String(settingsEntry.lastTestMessage || '').trim() || (provider.name + ' connection verified on this PC.'),
    };
  }

  if (lastSuccessfulUseAt) {
    return {
      libraryStatus: 'connected',
      statusLabel: 'Connected',
      statusMessage: provider.name + ' completed a real ' + usageLabel + ' request on this PC, but it has not passed a saved connection check here yet.',
    };
  }

  return {
    libraryStatus: 'connected',
    statusLabel: 'Key saved',
    statusMessage: provider.name + ' has a saved API key, but it has not been validated on this PC yet.',
  };
}

function normalizeProviderSummary(provider, settingsEntry = {}, apiKey = '') {
  const hasKey = Boolean(String(apiKey || '').trim());
  const lastTestSucceeded = settingsEntry.lastTestSucceeded === true
    ? true
    : settingsEntry.lastTestSucceeded === false
      ? false
      : undefined;
  const status = buildProviderStatusMessage(provider, settingsEntry, { hasKey });

  return {
    ...provider,
    kind: 'cloud-provider',
    source: 'cloud',
    cloudBadge: 'Cloud',
    isConnected: hasKey,
    libraryStatus: status.libraryStatus,
    maskedKey: hasKey ? maskSecret(apiKey) : '',
    lastAvailableModelId: settingsEntry.lastAvailableModelId || '',
    lastConnectedAt: settingsEntry.lastConnectedAt || null,
    lastSuccessfulOperation: settingsEntry.lastSuccessfulOperation || '',
    lastSuccessfulUseAt: settingsEntry.lastSuccessfulUseAt || null,
    lastTestMessage: settingsEntry.lastTestMessage || '',
    lastTestSucceeded,
    lastTestedAt: settingsEntry.lastTestedAt || null,
    modelCount: Number(settingsEntry.modelCount || 0),
    selectedModel: settingsEntry.selectedModel || '',
    statusLabel: status.statusLabel,
    statusMessage: status.statusMessage,
  };
}

async function loadProviderSecretOrThrow(providerId) {
  const apiKey = await getProviderSecret(providerId).catch(() => '');
  if (!String(apiKey || '').trim()) {
    throw new Error('Enter an API key for this provider first.');
  }

  return apiKey;
}

async function fetchProviderModelsInternal(provider, apiKey, options = {}) {
  const payload = await requestProviderJson(provider, apiKey, provider.modelsEndpoint, {
    method: 'GET',
  });

  let models = [];
  if (provider.configuration?.protocol === 'anthropic') {
    models = normalizeAnthropicModels(payload);
  } else if (provider.configuration?.protocol === 'google-gemini') {
    models = normalizeGoogleModels(provider, payload);
  } else {
    models = normalizeOpenAIModels(provider, payload);
  }

  return finalizeProviderModels(provider, models, options);
}

function parseInlineDataUrl(value) {
  const match = String(value || '').trim().match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }

  return {
    data: match[2].trim(),
    mimeType: match[1].trim() || 'image/png',
  };
}

function normalizeBinaryContentPart(entry, fallbackType = 'file') {
  const normalizedType = String(entry?.type || fallbackType).trim().toLowerCase();
  const inlineData = typeof entry?.imageUrl === 'string' ? parseInlineDataUrl(entry.imageUrl) : null;
  const data = String(entry?.data || inlineData?.data || '').trim();
  if (!data) {
    return null;
  }

  const fallbackMimeType = normalizedType === 'video' ? 'video/mp4' : normalizedType === 'image' ? 'image/png' : 'application/octet-stream';
  return {
    type: normalizedType,
    data,
    fileName: String(entry?.fileName || '').trim(),
    mimeType: String(entry?.mimeType || inlineData?.mimeType || fallbackMimeType).trim() || fallbackMimeType,
  };
}

function normalizeChatContentParts(content) {
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [{ type: 'text', text }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((entry) => {
      if (typeof entry === 'string') {
        const text = entry.trim();
        return text ? { type: 'text', text } : null;
      }

      if (entry?.type === 'text' && typeof entry.text === 'string') {
        const text = entry.text.trim();
        return text ? { type: 'text', text } : null;
      }

      if (entry?.type === 'image' || entry?.type === 'video' || entry?.type === 'file') {
        return normalizeBinaryContentPart(entry, entry.type);
      }

      return null;
    })
    .filter(Boolean);
}

function normalizeChatMessages(messages = []) {
  return Array.isArray(messages)
    ? messages
        .map((message) => ({
          role: String(message?.role || '').trim(),
          content: normalizeChatContentParts(message?.content),
        }))
        .filter((message) => message.role && message.content.length)
    : [];
}

function extractTextParts(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }

        if (entry?.type === 'text' && typeof entry.text === 'string') {
          return entry.text;
        }

        if (typeof entry?.text === 'string') {
          return entry.text;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function toOpenAiCompatibleContent(parts = []) {
  const normalizedParts = Array.isArray(parts) ? parts : [];
  if (!normalizedParts.some((part) => part.type === 'image')) {
    return extractTextParts(normalizedParts);
  }

  return normalizedParts.map((part) =>
    part.type === 'image'
      ? {
          type: 'image_url',
          image_url: {
            url: 'data:' + (part.mimeType || 'image/png') + ';base64,' + part.data,
          },
        }
      : {
          type: 'text',
          text: part.text,
        }
  );
}

function toAnthropicContent(parts = []) {
  return (Array.isArray(parts) ? parts : []).map((part) =>
    part.type === 'image'
      ? {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mimeType || 'image/png',
            data: part.data,
          },
        }
      : part.type === 'file'
        ? {
            type: 'document',
            source: {
              type: 'base64',
              media_type: part.mimeType || 'application/pdf',
              data: part.data,
            },
            title: part.fileName || 'document',
          }
        : {
            type: 'text',
            text: part.text,
          }
  );
}

function toGoogleContentParts(parts = []) {
  return (Array.isArray(parts) ? parts : []).map((part) =>
    part.type === 'image' || part.type === 'video' || part.type === 'file'
      ? {
          inlineData: {
            mimeType: part.mimeType || (part.type === 'video' ? 'video/mp4' : part.type === 'image' ? 'image/png' : 'application/octet-stream'),
            data: part.data,
          },
        }
      : {
          text: part.text,
        }
  );
}

async function sendOpenAICompatibleChat(provider, apiKey, payload) {
  const response = await requestProviderJson(provider, apiKey, provider.configuration?.chatEndpoint || '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: payload.model,
      messages: payload.messages.map((message) => ({
        role: message.role,
        content: toOpenAiCompatibleContent(message.content),
      })),
      stream: false,
    }),
  });

  const content = extractTextParts(response?.choices?.[0]?.message?.content || response?.choices?.[0]?.text || response?.output_text || '');
  if (!content) {
    throw new Error(provider.name + ' returned an empty reply.');
  }

  return {
    createdAt: new Date().toISOString(),
    model: payload.model,
    message: {
      role: 'assistant',
      content,
    },
  };
}

async function sendAnthropicChat(provider, apiKey, payload) {
  const systemMessages = payload.messages
    .filter((message) => message.role === 'system')
    .map((message) => extractTextParts(message.content))
    .filter(Boolean);
  const conversation = payload.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: toAnthropicContent(message.content),
    }))
    .filter((message) => message.content.length);

  if (!conversation.length) {
    throw new Error('Type a message before sending it to this provider.');
  }

  const response = await requestProviderJson(provider, apiKey, provider.configuration?.chatEndpoint || '/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: payload.model,
      max_tokens: provider.configuration?.maxOutputTokens || 512,
      messages: conversation,
      ...(systemMessages.length ? { system: systemMessages.join('\n\n') } : {}),
    }),
  });

  const content = extractTextParts(response?.content || '');
  if (!content) {
    throw new Error(provider.name + ' returned an empty reply.');
  }

  return {
    createdAt: new Date().toISOString(),
    model: payload.model,
    message: {
      role: 'assistant',
      content,
    },
  };
}

async function sendGoogleChat(provider, apiKey, payload) {
  const systemMessages = payload.messages
    .filter((message) => message.role === 'system')
    .map((message) => extractTextParts(message.content))
    .filter(Boolean);
  const contents = payload.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: toGoogleContentParts(message.content),
    }))
    .filter((message) => message.parts.length);

  if (!contents.length) {
    throw new Error('Type a message before sending it to this provider.');
  }

  const modelPath = String(payload.model || '').startsWith('models/') ? payload.model : 'models/' + payload.model;
  const response = await requestProviderJson(provider, apiKey, modelPath + ':generateContent', {
    method: 'POST',
    body: JSON.stringify({
      contents,
      ...(systemMessages.length
        ? {
            systemInstruction: {
              parts: [{ text: systemMessages.join('\n\n') }],
            },
          }
        : {}),
    }),
  });

  const content = extractTextParts(response?.candidates?.[0]?.content?.parts || '');
  if (!content) {
    throw new Error(provider.name + ' returned an empty reply.');
  }

  return {
    createdAt: new Date().toISOString(),
    model: payload.model,
    message: {
      role: 'assistant',
      content,
    },
  };
}

function findGoogleInlineDataPart(parts) {
  if (!Array.isArray(parts)) {
    return null;
  }

  return (
    parts.find((part) => {
      const inlineData = part?.inlineData && typeof part.inlineData === 'object' ? part.inlineData : null;
      const base64Data = String(inlineData?.data || '').trim();
      return Boolean(base64Data);
    }) || null
  );
}

function buildWaveFileBufferFromPcm(pcmBuffer, options = {}) {
  const sampleRate = Math.max(1, Number(options.sampleRate || GOOGLE_TTS_WAVE_SAMPLE_RATE) || GOOGLE_TTS_WAVE_SAMPLE_RATE);
  const channelCount = Math.max(1, Number(options.channelCount || GOOGLE_TTS_WAVE_CHANNEL_COUNT) || GOOGLE_TTS_WAVE_CHANNEL_COUNT);
  const bitDepth = Math.max(8, Number(options.bitDepth || GOOGLE_TTS_WAVE_BIT_DEPTH) || GOOGLE_TTS_WAVE_BIT_DEPTH);
  const blockAlign = Math.max(1, channelCount * Math.ceil(bitDepth / 8));
  const byteRate = sampleRate * blockAlign;
  const dataLength = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, pcmBuffer]);
}

async function sendGoogleSpeechGeneration(provider, apiKey, payload) {
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) {
    throw new Error('Enter text before generating speech.');
  }

  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose a Gemini speech model before generating audio.');
  }

  const voice = String(payload.voice || payload.voiceName || DEFAULT_GOOGLE_TTS_VOICE).trim() || DEFAULT_GOOGLE_TTS_VOICE;
  const modelPath = model.startsWith('models/') ? model : 'models/' + model;
  const response = await requestProviderJson(provider, apiKey, modelPath + ':generateContent', {
    method: 'POST',
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      },
    }),
  });

  const inlineAudioPart = findGoogleInlineDataPart(response?.candidates?.[0]?.content?.parts);
  const inlineData = inlineAudioPart?.inlineData && typeof inlineAudioPart.inlineData === 'object' ? inlineAudioPart.inlineData : null;
  const base64Data = String(inlineData?.data || '').trim();
  if (!base64Data) {
    throw new Error(provider.name + ' finished the request, but it did not return audio.');
  }

  const audioBuffer = Buffer.from(base64Data, 'base64');
  if (!audioBuffer.length) {
    throw new Error(provider.name + ' returned an empty audio file.');
  }

  const mimeType = String(inlineData?.mimeType || '').trim().toLowerCase();
  const waveBuffer = mimeType === 'audio/wav' || mimeType === 'audio/x-wav'
    ? audioBuffer
    : buildWaveFileBufferFromPcm(audioBuffer, {
        sampleRate: GOOGLE_TTS_WAVE_SAMPLE_RATE,
        channelCount: GOOGLE_TTS_WAVE_CHANNEL_COUNT,
        bitDepth: GOOGLE_TTS_WAVE_BIT_DEPTH,
      });

  return {
    createdAt: new Date().toISOString(),
    model,
    audios: [
      {
        buffer: waveBuffer,
        extension: '.wav',
        mimeType: 'audio/wav',
        sampleRate: GOOGLE_TTS_WAVE_SAMPLE_RATE,
        channelCount: GOOGLE_TTS_WAVE_CHANNEL_COUNT,
        bitDepth: GOOGLE_TTS_WAVE_BIT_DEPTH,
        voice,
      },
    ],
  };
}

async function sendOpenAiImageGeneration(provider, apiKey, payload) {
  if (provider.id !== 'openai') {
    throw new Error(provider.name + ' does not support cloud image generation in Local AI Hub yet.');
  }

  const prompt = String(payload.prompt || '').trim();
  if (!prompt) {
    throw new Error('Enter a text prompt before generating an image.');
  }

  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose an OpenAI image model before generating an image.');
  }

  const response = await requestProviderJson(provider, apiKey, '/images/generations', {
    method: 'POST',
    body: JSON.stringify({
      background: normalizeAllowedValue(payload.background, OPENAI_IMAGE_BACKGROUNDS, 'auto'),
      model,
      n: 1,
      output_format: 'png',
      prompt,
      quality: normalizeAllowedValue(payload.quality, OPENAI_IMAGE_QUALITIES, 'auto'),
      size: normalizeAllowedValue(payload.size, OPENAI_IMAGE_SIZES, '1024x1024'),
    }),
  });

  const image = Array.isArray(response?.data)
    ? response.data.find((entry) => String(entry?.b64_json || '').trim())
    : null;
  const base64Data = String(image?.b64_json || '').trim();
  if (!base64Data) {
    throw new Error(provider.name + ' finished the request, but it did not return an image.');
  }

  return {
    createdAt: new Date().toISOString(),
    images: [
      {
        base64Data,
        mimeType: 'image/png',
      },
    ],
    model,
  };
}

async function sendOpenAiVideoGeneration(provider, apiKey, payload) {
  if (provider.id !== 'openai') {
    throw new Error(provider.name + ' does not support cloud video generation in Local AI Hub yet.');
  }

  const prompt = String(payload.prompt || '').trim();
  if (!prompt) {
    throw new Error('Enter a prompt before generating a video.');
  }

  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose an OpenAI video model before generating a video.');
  }

  const onProgress = typeof payload.onProgress === 'function' ? payload.onProgress : null;
  const formData = new FormData();
  formData.append('model', model);
  formData.append('prompt', prompt);
  formData.append('size', normalizeAllowedValue(payload.size, OPENAI_VIDEO_SIZES, '1280x720'));
  formData.append('seconds', String(Math.max(1, Number(payload.seconds || 8) || 8)));

  const referenceImage = payload.imageReference && typeof payload.imageReference === 'object' ? payload.imageReference : null;
  if (referenceImage?.buffer) {
    const mimeType = String(referenceImage.mimeType || 'image/png').trim() || 'image/png';
    const fileName = String(referenceImage.fileName || 'reference.png').trim() || 'reference.png';
    formData.append('input_reference', new Blob([referenceImage.buffer], { type: mimeType }), fileName);
  }

  onProgress?.('Submitting the video render request to OpenAI.');
  const started = await requestProviderJson(provider, apiKey, '/videos', {
    method: 'POST',
    body: formData,
    contentType: null,
    timeoutMs: 60000,
  });

  const videoId = String(started?.id || '').trim();
  if (!videoId) {
    throw new Error(provider.name + ' accepted the request, but it did not return a video job ID.');
  }

  const startedAt = Date.now();
  let latestPayload = started;
  let latestStatus = String(started?.status || '').trim().toLowerCase();
  while (latestStatus !== 'completed') {
    if (['failed', 'cancelled', 'canceled', 'rejected', 'error'].includes(latestStatus)) {
      const failureMessage =
        latestPayload?.error?.message ||
        latestPayload?.last_error?.message ||
        latestPayload?.failure?.message ||
        latestPayload?.message ||
        provider.name + ' could not finish that video request.';
      throw new Error(String(failureMessage).trim());
    }

    if (Date.now() - startedAt > OPENAI_VIDEO_STATUS_TIMEOUT_MS) {
      throw new Error(provider.name + ' is still rendering that video. Try again in a moment or shorten the request.');
    }

    onProgress?.(
      latestStatus === 'queued'
        ? 'OpenAI queued the video render. Waiting for the job to start.'
        : latestStatus === 'processing' || latestStatus === 'in_progress' || latestStatus === 'running'
          ? 'OpenAI is rendering the video now.'
          : 'Waiting for OpenAI to finish the video render.',
    );
    await waitForProvider(OPENAI_VIDEO_STATUS_POLL_MS);
    latestPayload = await requestProviderJson(provider, apiKey, `/videos/${videoId}`, {
      method: 'GET',
      timeoutMs: 60000,
    });
    latestStatus = String(latestPayload?.status || '').trim().toLowerCase();
  }

  onProgress?.('Downloading the finished video from OpenAI.');
  const content = await requestProviderBuffer(provider, apiKey, `/videos/${videoId}/content`, {
    method: 'GET',
    contentType: null,
    timeoutMs: PROVIDER_DOWNLOAD_TIMEOUT_MS,
  });

  if (!content.buffer?.length) {
    throw new Error(provider.name + ' finished the request, but the video file was empty.');
  }

  const mimeType = content.contentType.startsWith('video/') ? content.contentType : 'video/mp4';
  const extension = mimeType.includes('webm') ? '.webm' : mimeType.includes('quicktime') ? '.mov' : '.mp4';
  return {
    createdAt: new Date().toISOString(),
    model,
    videos: [
      {
        buffer: content.buffer,
        extension,
        id: videoId,
        mimeType,
      },
    ],
  };
}
async function listProviderConnections() {

  await initializeProviderRegistry();
  const settings = await readProviderSettings();

  return Promise.all(
    getProviderCatalog().map(async (provider) => {
      const apiKey = await getProviderSecret(provider.id).catch(() => '');
      return normalizeProviderSummary(provider, settings.providers[provider.id] || {}, apiKey);
    }),
  );
}

async function saveProviderConnection(providerId, apiKey) {
  await initializeProviderRegistry();
  const provider = getProviderManifest(providerId);
  if (!provider) {
    throw new Error('Local AI Hub could not find that cloud provider.');
  }

  const sanitizedKey = String(apiKey || '').trim();
  if (!sanitizedKey) {
    throw new Error(`Enter an API key for ${provider.name} before saving the connection.`);
  }

  await setProviderSecret(provider.id, sanitizedKey);
  await updateProviderSettings((settings) => ({
    ...settings,
    providers: {
      ...settings.providers,
      [provider.id]: {
        ...(settings.providers[provider.id] || {}),
        lastConnectedAt: new Date().toISOString(),
      },
    },
  }));

  const providers = await listProviderConnections();
  return providers.find((entry) => entry.id === provider.id) || null;
}

async function disconnectProvider(providerId) {
  await initializeProviderRegistry();
  const provider = getProviderManifest(providerId);
  if (!provider) {
    throw new Error('Local AI Hub could not find that cloud provider.');
  }

  await setProviderSecret(provider.id, '');
  await updateProviderSettings((settings) => {
    const nextProviders = {
      ...settings.providers,
    };
    delete nextProviders[provider.id];
    return {
      ...settings,
      providers: nextProviders,
    };
  });

  return {
    providerId: provider.id,
    providerName: provider.name,
  };
}

async function listProviderModels(request) {
  await initializeProviderRegistry();
  const normalizedRequest = normalizeListProviderModelsRequest(request);
  const provider = getProviderManifest(normalizedRequest.providerId);
  if (!provider) {
    throw new Error('Local AI Hub could not find that cloud provider.');
  }

  const apiKey = await loadProviderSecretOrThrow(provider.id);
  const logger = createLogger('providers', {
    operationId: normalizedRequest.operationId || 'default',
    providerId: provider.id,
    mode: 'list-models',
  });

  const settings = await readProviderSettings();
  try {
    const models = await fetchProviderModelsInternal(provider, apiKey, normalizedRequest);
    const selectedModel = selectPreferredModel(provider, models, settings.providers[provider.id]?.selectedModel || '');

    await updateProviderSettings((currentSettings) => ({
      ...currentSettings,
      providers: {
        ...currentSettings.providers,
        [provider.id]: {
          ...(currentSettings.providers[provider.id] || {}),
          lastAvailableModelId: models[0]?.id || '',
          modelCount: models.length,
          selectedModel,
        },
      },
    }));

    return {
      models,
      selectedModel,
    };
  } catch (error) {
    await logger.warn('Provider model list request failed.', {
      message: error.message,
    });
    throw new Error(humanizeError(error, 'Local AI Hub could not load models from ' + provider.name + '.'));
  }
}

async function testProviderConnection(providerId) {
  await initializeProviderRegistry();
  const provider = getProviderManifest(providerId);
  if (!provider) {
    throw new Error('Local AI Hub could not find that cloud provider.');
  }

  const apiKey = await loadProviderSecretOrThrow(provider.id);
  const logger = createLogger('providers', {
    providerId: provider.id,
    mode: 'test',
  });

  try {
    const models = await fetchProviderModelsInternal(provider, apiKey);
    const selectedModel = selectPreferredModel(provider, models, '');
    await updateProviderSettings((settings) => ({
      ...settings,
      providers: {
        ...settings.providers,
        [provider.id]: {
          ...(settings.providers[provider.id] || {}),
          lastAvailableModelId: models[0]?.id || '',
          lastTestMessage: models.length
            ? `${provider.name} is connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`
            : `${provider.name} accepted the API key, but it did not return any chat models.`,
          lastTestSucceeded: true,
          lastTestedAt: new Date().toISOString(),
          modelCount: models.length,
          selectedModel,
        },
      },
    }));

    return {
      message: models.length
        ? `${provider.name} connection succeeded. ${models.length} model${models.length === 1 ? '' : 's'} available.`
        : `${provider.name} accepted the API key, but it did not return any chat models.`,
      models,
      selectedModel,
    };
  } catch (error) {
    const message = humanizeError(error, `Local AI Hub could not verify the ${provider.name} key.`);
    await logger.warn('Provider connection test failed.', {
      message,
    });
    await updateProviderSettings((settings) => ({
      ...settings,
      providers: {
        ...settings.providers,
        [provider.id]: {
          ...(settings.providers[provider.id] || {}),
          lastTestMessage: message,
          lastTestSucceeded: false,
          lastTestedAt: new Date().toISOString(),
        },
      },
    }));
    throw new Error(message);
  }
}

async function recordProviderUsageSuccess(providerId, model, operationId) {
  const normalizedProviderId = String(providerId || '').trim();
  if (!normalizedProviderId) {
    return;
  }

  const normalizedModel = String(model || '').trim();
  const normalizedOperationId = normalizeProviderOperationId(operationId) || PIPELINE_OPERATION_IDS.LLM_PROMPT;
  await updateProviderSettings((settings) => ({
    ...settings,
    providers: {
      ...settings.providers,
      [normalizedProviderId]: {
        ...(settings.providers[normalizedProviderId] || {}),
        lastSuccessfulOperation: normalizedOperationId,
        lastSuccessfulUseAt: new Date().toISOString(),
        ...(normalizedModel ? { selectedModel: normalizedModel } : {}),
      },
    },
  }));
  await notifyProviderStateChanged({
    providerId: normalizedProviderId,
    reason: 'usage-success',
  });
}

async function chatWithProvider(providerId, payload = {}) {
  await initializeProviderRegistry();
  const provider = getProviderManifest(providerId);
  if (!provider) {
    throw new Error('Local AI Hub could not find that cloud provider.');
  }

  const apiKey = await loadProviderSecretOrThrow(provider.id);
  const logger = createLogger('providers', {
    providerId: provider.id,
    mode: 'chat',
  });
  const messages = normalizeChatMessages(payload.messages);
  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose a ' + provider.name + ' model before sending a message.');
  }

  if (!messages.length) {
    throw new Error('Type a message before sending it to this provider.');
  }

  try {
    let result = null;
    if (provider.configuration?.protocol === 'anthropic') {
      result = await sendAnthropicChat(provider, apiKey, { model, messages });
    } else if (provider.configuration?.protocol === 'google-gemini') {
      result = await sendGoogleChat(provider, apiKey, { model, messages });
    } else {
      result = await sendOpenAICompatibleChat(provider, apiKey, { model, messages });
    }

    await recordProviderUsageSuccess(provider.id, model, PIPELINE_OPERATION_IDS.LLM_PROMPT);

    return result;
  } catch (error) {
    const message = humanizeError(error, 'Local AI Hub could not send that message to ' + provider.name + '.');
    await logger.warn('Provider chat request failed.', {
      message,
    });
    throw new Error(message);
  }
}

async function runProviderOperation(providerId, payload = {}) {
  const operationId = normalizeProviderOperationId(payload.operationId);
  if (!operationId || operationId === PIPELINE_OPERATION_IDS.LLM_PROMPT) {
    return chatWithProvider(providerId, payload);
  }

  await initializeProviderRegistry();
  const provider = getProviderManifest(providerId);
  if (!provider) {
    throw new Error('Local AI Hub could not find that cloud provider.');
  }

  const apiKey = await loadProviderSecretOrThrow(provider.id);
  const logger = createLogger('providers', {
    providerId: provider.id,
    mode: operationId,
  });
  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose a ' + provider.name + ' model before running this step.');
  }

  try {
    let result = null;
    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
      result = await sendOpenAiImageGeneration(provider, apiKey, payload);
    } else if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
      result = await sendOpenAiVideoGeneration(provider, apiKey, payload);
    } else if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
      if (provider.configuration?.protocol === 'google-gemini') {
        result = await sendGoogleSpeechGeneration(provider, apiKey, payload);
      } else {
        throw new Error(provider.name + ' does not support cloud audio generation in Local AI Hub yet.');
      }
    } else {
      throw new Error(provider.name + ' does not support that pipeline operation yet.');
    }

    await recordProviderUsageSuccess(provider.id, model, operationId);

    return result;
  } catch (error) {
    const message = humanizeError(error, 'Local AI Hub could not run that ' + provider.name + ' provider step.');
    await logger.warn('Provider operation request failed.', {
      message,
      operationId,
    });
    throw new Error(message);
  }
}

module.exports = {
  chatWithProvider,
  disconnectProvider,
  listProviderConnections,
  listProviderModels,
  readProviderSettings,
  runProviderOperation,
  saveProviderConnection,
  setProviderStateChangeSink,
  testProviderConnection,
};




