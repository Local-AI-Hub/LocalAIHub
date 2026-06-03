const path = require('path');
const fs = require('fs-extra');

const { ensureStorage, humanizeError } = require('./configService');
const { maskSecret, resolveProviderCredential, setProviderSecret } = require('./credentialService');
const { createLogger } = require('./logService');
const { redactSensitiveText } = require('./redactionService');
const { getProviderCatalog, getProviderManifest, initializeProviderRegistry, resolveProviderUrl } = require('./providerRegistry');
const { PIPELINE_OPERATION_IDS, doesProviderOperationRequireExplicitModel, getProviderModelCapabilities } = require('../shared/pipelineCapabilities.cjs');

const PROVIDER_SETTINGS_FILE = 'provider-connections.json';
const PROVIDER_SETTINGS_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15000;
const PROVIDER_DOWNLOAD_TIMEOUT_MS = 300000;
const OPENAI_VIDEO_STATUS_TIMEOUT_MS = 10 * 60 * 1000;
const OPENAI_VIDEO_STATUS_POLL_MS = 5000;
const GOOGLE_VIDEO_DEFAULT_MODEL = 'veo-3.1-generate-preview';
const GOOGLE_VIDEO_STATUS_TIMEOUT_MS = 10 * 60 * 1000;
const GOOGLE_VIDEO_STATUS_POLL_MS = 10000;
const XAI_VIDEO_DEFAULT_MODEL = 'grok-imagine-video';
const XAI_VIDEO_STATUS_TIMEOUT_MS = 10 * 60 * 1000;
const XAI_VIDEO_STATUS_POLL_MS = 5000;
const OPENAI_IMAGE_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto']);
const OPENAI_IMAGE_QUALITIES = new Set(['auto', 'low', 'medium', 'high']);
const OPENAI_IMAGE_BACKGROUNDS = new Set(['auto', 'opaque', 'transparent']);
const OPENAI_VIDEO_SIZES = new Set(['1280x720', '720x1280']);
const GOOGLE_VIDEO_ASPECT_RATIOS = new Set(['16:9', '9:16']);
const GOOGLE_VIDEO_RESOLUTIONS = new Set(['720p', '1080p', '4k']);
const XAI_VIDEO_ASPECT_RATIOS = new Set(['16:9', '9:16']);
const XAI_VIDEO_RESOLUTIONS = new Set(['480p', '720p']);
const DEFAULT_GOOGLE_TTS_VOICE = 'Kore';
const DEFAULT_OPENAI_TTS_VOICE = 'alloy';
const DEFAULT_XAI_TTS_VOICE = 'eve';
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
  const externalSignal = options.signal || null;
  const abortFromExternalSignal = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }
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
      throw new Error(redactSensitiveText(String(responseMessage).trim(), { additionalSecrets: [apiKey] }));
    }

    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new Error(String(options.cancelMessage || '').trim() || `${provider.name} request was cancelled.`);
      }

      const timeoutMessage = String(options.timeoutMessage || '').trim();
      if (timeoutMessage) {
        throw new Error(timeoutMessage);
      }

      throw new Error(`${provider.name} did not answer before Local AI Hub's connection check timed out.`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternalSignal);
    }
  }
}

async function requestProviderBuffer(provider, apiKey, endpoint, options = {}) {
  const controller = new AbortController();
  const externalSignal = options.signal || null;
  const abortFromExternalSignal = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }
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
      throw new Error(redactSensitiveText(String(responseMessage).trim(), { additionalSecrets: [apiKey] }));
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: String(response.headers.get('content-type') || '').trim() || 'application/octet-stream',
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new Error(String(options.cancelMessage || '').trim() || `${provider.name} download was cancelled.`);
      }

      throw new Error(`${provider.name} took too long to return the finished file.`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternalSignal);
    }
  }
}

function waitForProvider(ms, signal = null, cancelMessage = 'Provider request was cancelled.') {
  if (signal?.aborted) {
    return Promise.reject(new Error(cancelMessage));
  }

  return new Promise((resolve, reject) => {
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
      reject(new Error(cancelMessage));
    };
    const timer = setTimeout(finish, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
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

  const capabilities = getProviderModelCapabilities(provider.id, modelId);
  const blocked = matchesBlockedModel(provider, modelId);
  if (operationId) {
    const supportsOperation = Boolean(capabilities?.operations?.[operationId]);
    if (!supportsOperation) {
      return false;
    }

    return !blocked || capabilities?.capabilitySource === 'explicit';
  }

  return !blocked;
}

function getProviderModelPreferenceRank(provider, modelId) {
  const normalizedModelId = String(modelId || '').trim().toLowerCase();
  const prefixes = Array.isArray(provider?.configuration?.preferredModelPrefixes)
    ? provider.configuration.preferredModelPrefixes
    : [];
  const index = prefixes.findIndex((prefix) => normalizedModelId.startsWith(String(prefix || '').trim().toLowerCase()));
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function compareProviderModels(provider, left, right) {
  const leftRank = getProviderModelPreferenceRank(provider, left?.id);
  const rightRank = getProviderModelPreferenceRank(provider, right?.id);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return String(left?.label || left?.id || '').localeCompare(String(right?.label || right?.id || ''));
}

function finalizeProviderModels(provider, models = [], options = {}) {
  const operationId = normalizeProviderOperationId(options.operationId);
  return (Array.isArray(models) ? models : [])
    .filter((entry) => shouldIncludeProviderModel(provider, entry?.id, operationId))
    .map((entry) => ({
      ...entry,
      ...buildProviderModelMetadata(provider, entry.id),
    }))
    .sort((left, right) => compareProviderModels(provider, left, right));
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
      supportsPredictLongRunning: Array.isArray(entry?.supportedGenerationMethods)
        ? entry.supportedGenerationMethods.includes('predictLongRunning')
        : false,
    }))
    .filter((entry) => entry.id && (entry.supportsGenerateContent || entry.supportsPredictLongRunning));
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
  const credentialSource = String(options.credentialSource || '').trim();
  const envVarName = String(options.envVarName || '').trim();
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
      statusMessage: envVarName
        ? 'No saved credential was found, and Local AI Hub could not find the default environment variable ' + envVarName + ' in this app session.'
        : '',
    };
  }

  if (credentialSource === 'environment') {
    return {
      libraryStatus: 'connected',
      statusLabel: 'Using environment variable',
      statusMessage: 'Local AI Hub will use ' + envVarName + ' for ' + provider.name + ' on this PC. Saved credentials remain in Windows Credential Manager, but environment variables take precedence.',
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

function formatEnvVarList(envVarNames = []) {
  const names = (Array.isArray(envVarNames) ? envVarNames : []).map((entry) => String(entry || '').trim()).filter(Boolean);
  if (names.length <= 1) {
    return names[0] || '';
  }

  return names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
}

function normalizeProviderSummary(provider, settingsEntry = {}, credential = {}) {
  const apiKey = String(credential?.apiKey || '').trim();
  const hasKey = Boolean(apiKey);
  const credentialSource = String(credential?.credentialSource || (hasKey ? 'saved' : 'missing')).trim();
  const envVarNames = Array.isArray(credential?.envVarNames) ? credential.envVarNames : [];
  const envVarName = String(credential?.envVarName || envVarNames[0] || '').trim();
  const hasSavedCredential = credential?.hasSavedCredential === true;
  const lastTestSucceeded = settingsEntry.lastTestSucceeded === true
    ? true
    : settingsEntry.lastTestSucceeded === false
      ? false
      : undefined;
  const safeSettingsEntry = {
    ...settingsEntry,
    lastTestMessage: redactSensitiveText(settingsEntry.lastTestMessage || '', { additionalSecrets: [apiKey] }),
  };
  const status = buildProviderStatusMessage(provider, safeSettingsEntry, { credentialSource, envVarName, hasKey });
  const credentialStatusLabel = credentialSource === 'environment'
    ? 'Using environment variable: ' + envVarName
    : credentialSource === 'saved'
      ? 'Using saved credential'
      : 'No credential configured';
  const credentialStatusMessage = credentialSource === 'environment'
    ? 'Environment variable values are not shown or copied into saved credentials.'
    : credentialSource === 'saved'
      ? ''
      : credentialSource === 'missing' && envVarNames.length
        ? 'Default environment variable not found: ' + formatEnvVarList(envVarNames) + '.'
        : '';

  return {
    ...provider,
    kind: 'cloud-provider',
    source: 'cloud',
    cloudBadge: 'Cloud',
    isConnected: hasKey,
    libraryStatus: status.libraryStatus,
    credentialSource,
    credentialStatusLabel,
    credentialStatusMessage,
    envVarName,
    envVarNames,
    hasSavedCredential,
    maskedKey: hasSavedCredential && credentialSource !== 'environment' ? maskSecret(apiKey) : '',
    lastAvailableModelId: settingsEntry.lastAvailableModelId || '',
    lastConnectedAt: settingsEntry.lastConnectedAt || null,
    lastSuccessfulOperation: settingsEntry.lastSuccessfulOperation || '',
    lastSuccessfulUseAt: settingsEntry.lastSuccessfulUseAt || null,
    lastTestMessage: safeSettingsEntry.lastTestMessage || '',
    lastTestSucceeded,
    lastTestedAt: settingsEntry.lastTestedAt || null,
    modelCount: Number(settingsEntry.modelCount || 0),
    selectedModel: settingsEntry.selectedModel || '',
    statusLabel: status.statusLabel,
    statusMessage: status.statusMessage,
  };
}

async function loadProviderSecretOrThrow(providerId) {
  const credential = await resolveProviderCredential(providerId).catch(() => null);
  const apiKey = String(credential?.apiKey || '').trim();
  if (!apiKey) {
    const envVarName = String(credential?.envVarName || '').trim();
    throw new Error(envVarName
      ? 'Enter an API key for this provider first, or set ' + envVarName + ' before starting Local AI Hub.'
      : 'Enter an API key for this provider first.');
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

function getProviderChatTimeoutMs(payload = {}) {
  const timeoutMs = Number(payload.timeoutMs || 0);
  return timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS;
}

function getProviderChatTimeoutMessage(provider, payload = {}) {
  return String(payload.timeoutMessage || '').trim() || (provider.name + ' did not answer before Local AI Hub timed out waiting for this response.');
}

function normalizeProviderMaxOutputTokens(value, fallback = 0) {
  const tokens = Math.floor(Number(value || 0));
  if (tokens > 0) {
    return Math.max(128, Math.min(tokens, 8192));
  }
  const fallbackTokens = Math.floor(Number(fallback || 0));
  return fallbackTokens > 0 ? Math.max(128, Math.min(fallbackTokens, 8192)) : 0;
}

function normalizeStructuredResponseFormat(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  if (value.type !== 'json_schema' || !value.schema || typeof value.schema !== 'object' || Array.isArray(value.schema)) {
    return null;
  }
  return {
    type: 'json_schema',
    name: String(value.name || 'local_ai_hub_response').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'local_ai_hub_response',
    schema: value.schema,
  };
}

function buildGoogleGenerationConfig(provider, payload = {}) {
  const config = {};
  const maxOutputTokens = normalizeProviderMaxOutputTokens(payload.maxOutputTokens, provider.configuration?.maxOutputTokens);
  if (maxOutputTokens) {
    config.maxOutputTokens = maxOutputTokens;
  }
  const responseFormat = normalizeStructuredResponseFormat(payload.responseFormat);
  if (responseFormat) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = responseFormat.schema;
  }
  return config;
}

function buildOpenAiResponseFormat(payload = {}) {
  const responseFormat = normalizeStructuredResponseFormat(payload.responseFormat);
  if (!responseFormat) {
    return null;
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: responseFormat.name,
      schema: responseFormat.schema,
      strict: true,
    },
  };
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
  const structuredResponseFormat = provider.id === 'openai' ? buildOpenAiResponseFormat(payload) : null;
  const response = await requestProviderJson(provider, apiKey, provider.configuration?.chatEndpoint || '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: payload.model,
      messages: payload.messages.map((message) => ({
        role: message.role,
        content: toOpenAiCompatibleContent(message.content),
      })),
      stream: false,
      ...(normalizeProviderMaxOutputTokens(payload.maxOutputTokens) ? { max_tokens: normalizeProviderMaxOutputTokens(payload.maxOutputTokens) } : {}),
      ...(structuredResponseFormat ? { response_format: structuredResponseFormat } : {}),
    }),
    timeoutMessage: getProviderChatTimeoutMessage(provider, payload),
    timeoutMs: getProviderChatTimeoutMs(payload),
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
      max_tokens: normalizeProviderMaxOutputTokens(payload.maxOutputTokens, provider.configuration?.maxOutputTokens || 512),
      messages: conversation,
      ...(systemMessages.length ? { system: systemMessages.join('\n\n') } : {}),
    }),
    timeoutMessage: getProviderChatTimeoutMessage(provider, payload),
    timeoutMs: getProviderChatTimeoutMs(payload),
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
  const generationConfig = buildGoogleGenerationConfig(provider, payload);
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
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    }),
    timeoutMessage: getProviderChatTimeoutMessage(provider, payload),
    timeoutMs: getProviderChatTimeoutMs(payload),
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

async function sendOpenAiSpeechGeneration(provider, apiKey, payload) {
  if (provider.id !== 'openai') {
    throw new Error(provider.name + ' does not support cloud audio generation in Local AI Hub yet.');
  }

  const spokenText = String(payload.spokenText || payload.prompt || '').trim();
  if (!spokenText) {
    throw new Error('Enter text before generating speech.');
  }

  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose an OpenAI speech model before generating audio.');
  }

  const voice = String(payload.voice || payload.voiceName || DEFAULT_OPENAI_TTS_VOICE).trim() || DEFAULT_OPENAI_TTS_VOICE;
  const instructions = String(payload.instruction || '').trim();
  const body = {
    format: 'wav',
    input: spokenText,
    model,
    voice,
  };
  if (instructions) {
    body.instructions = instructions;
  }

  const response = await requestProviderBuffer(provider, apiKey, '/audio/speech', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.buffer.length) {
    throw new Error(provider.name + ' returned an empty audio file.');
  }

  return {
    createdAt: new Date().toISOString(),
    model,
    audios: [
      {
        buffer: response.buffer,
        extension: '.wav',
        mimeType: 'audio/wav',
        voice,
      },
    ],
  };
}

async function sendXaiSpeechGeneration(provider, apiKey, payload) {
  if (provider.id !== 'xai') {
    throw new Error(provider.name + ' does not support cloud audio generation in Local AI Hub yet.');
  }

  const spokenText = String(payload.spokenText || payload.prompt || '').trim();
  if (!spokenText) {
    throw new Error('Enter text before generating speech.');
  }

  const voice = String(payload.voice || payload.voiceName || DEFAULT_XAI_TTS_VOICE).trim() || DEFAULT_XAI_TTS_VOICE;
  const response = await requestProviderBuffer(provider, apiKey, '/tts', {
    method: 'POST',
    body: JSON.stringify({
      output_format: {
        codec: 'wav',
        sample_rate: 24000,
      },
      text: spokenText,
      voice_id: voice,
    }),
  });

  if (!response.buffer.length) {
    throw new Error(provider.name + ' returned an empty audio file.');
  }

  return {
    createdAt: new Date().toISOString(),
    model: '',
    audios: [
      {
        buffer: response.buffer,
        extension: '.wav',
        mimeType: 'audio/wav',
        sampleRate: 24000,
        voice,
      },
    ],
  };
}

async function sendProviderSpeechGeneration(provider, apiKey, payload) {
  if (provider.configuration?.protocol === 'google-gemini') {
    return sendGoogleSpeechGeneration(provider, apiKey, payload);
  }

  if (provider.id === 'openai') {
    return sendOpenAiSpeechGeneration(provider, apiKey, payload);
  }

  if (provider.id === 'xai') {
    return sendXaiSpeechGeneration(provider, apiKey, payload);
  }

  throw new Error(provider.name + ' does not support cloud audio generation in Local AI Hub yet.');
}

function normalizeProviderImageMimeType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'image/jpg') {
    return 'image/jpeg';
  }
  if (['image/png', 'image/jpeg', 'image/webp'].includes(normalized)) {
    return normalized;
  }
  return 'image/png';
}

function getProviderImageExtension(mimeType) {
  const normalized = normalizeProviderImageMimeType(mimeType);
  if (normalized === 'image/jpeg') {
    return '.jpg';
  }
  if (normalized === 'image/webp') {
    return '.webp';
  }
  return '.png';
}

function normalizeProviderImageBase64(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  const inlineData = parseInlineDataUrl(raw);
  return inlineData?.data || raw;
}

async function readProviderImageReference(payload = {}) {
  const reference = payload.imageReference && typeof payload.imageReference === 'object' ? payload.imageReference : null;
  if (!reference) {
    return null;
  }

  const mimeType = normalizeProviderImageMimeType(reference.mimeType || reference.contentType || 'image/png');
  const fileName = String(reference.fileName || ('source' + getProviderImageExtension(mimeType))).trim() || ('source' + getProviderImageExtension(mimeType));
  let buffer = Buffer.isBuffer(reference.buffer) ? reference.buffer : null;
  if (!buffer && reference.data) {
    buffer = Buffer.from(normalizeProviderImageBase64(reference.data), 'base64');
  }
  if (!buffer && reference.base64Data) {
    buffer = Buffer.from(normalizeProviderImageBase64(reference.base64Data), 'base64');
  }
  if (!buffer && reference.filePath) {
    const filePath = String(reference.filePath || '').trim();
    if (filePath && await fs.pathExists(filePath)) {
      buffer = await fs.readFile(filePath);
    }
  }

  if (!buffer?.length) {
    throw new Error('The source image could not be read. Choose a valid PNG, JPG, or WEBP image and try again.');
  }

  return {
    base64Data: buffer.toString('base64'),
    buffer,
    dataUrl: 'data:' + mimeType + ';base64,' + buffer.toString('base64'),
    fileName,
    mimeType,
  };
}

function getProviderImageSafetyNotes(provider, payload = {}) {
  const notes = [];
  const promptFeedback = payload?.promptFeedback || payload?.prompt_feedback || null;
  const blockReason = String(promptFeedback?.blockReason || promptFeedback?.block_reason || '').trim();
  if (blockReason) {
    notes.push(provider.name + ' reported a safety block: ' + blockReason + '.');
  }

  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  candidates.forEach((candidate) => {
    const finishReason = String(candidate?.finishReason || candidate?.finish_reason || '').trim();
    if (finishReason && /safety|blocked|prohibited|policy/i.test(finishReason)) {
      notes.push(provider.name + ' filtered the response: ' + finishReason + '.');
    }
    const safetyRatings = Array.isArray(candidate?.safetyRatings || candidate?.safety_ratings)
      ? (candidate.safetyRatings || candidate.safety_ratings)
      : [];
    safetyRatings.forEach((rating) => {
      const category = String(rating?.category || '').trim();
      const probability = String(rating?.probability || '').trim();
      const blocked = rating?.blocked === true;
      if (blocked || /high|medium/i.test(probability)) {
        notes.push([category, probability, blocked ? 'blocked' : 'flagged'].filter(Boolean).join(' '));
      }
    });
  });

  return [...new Set(notes.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

async function downloadProviderImageUrl(provider, apiKey, url) {
  const normalizedUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(normalizedUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(provider.name + ' returned an image URL, but Local AI Hub could not download it.');
    }
    const mimeType = normalizeProviderImageMimeType(String(response.headers.get('content-type') || 'image/png'));
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
      throw new Error(provider.name + ' returned an empty image file.');
    }
    return {
      base64Data: buffer.toString('base64'),
      extension: getProviderImageExtension(mimeType),
      mimeType,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function normalizeProviderImageEntry(provider, apiKey, entry, fallbackMimeType = 'image/png') {
  const inlineData = parseInlineDataUrl(entry?.url || entry?.image_url || entry?.data || '');
  const base64Data = normalizeProviderImageBase64(entry?.b64_json || entry?.base64Data || entry?.base64 || inlineData?.data || '');
  const mimeType = normalizeProviderImageMimeType(entry?.mimeType || entry?.mime_type || inlineData?.mimeType || fallbackMimeType);
  if (base64Data) {
    return {
      base64Data,
      extension: getProviderImageExtension(mimeType),
      mimeType,
      revisedPrompt: String(entry?.revised_prompt || entry?.revisedPrompt || '').trim(),
      safetyNotes: Array.isArray(entry?.safetyNotes) ? entry.safetyNotes : [],
    };
  }

  const url = String(entry?.url || entry?.image_url || '').trim();
  const downloaded = await downloadProviderImageUrl(provider, apiKey, url);
  if (downloaded) {
    return {
      ...downloaded,
      revisedPrompt: String(entry?.revised_prompt || entry?.revisedPrompt || '').trim(),
      safetyNotes: Array.isArray(entry?.safetyNotes) ? entry.safetyNotes : [],
    };
  }

  return null;
}

async function normalizeProviderImageDataResponse(provider, apiKey, response, options = {}) {
  const data = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.images)
      ? response.images
      : [];
  for (const entry of data) {
    const image = await normalizeProviderImageEntry(provider, apiKey, entry, options.fallbackMimeType || 'image/png');
    if (image?.base64Data) {
      return image;
    }
  }

  const safetyNotes = getProviderImageSafetyNotes(provider, response);
  if (safetyNotes.length) {
    throw new Error(provider.name + ' blocked or filtered that image request. Adjust the prompt or source image and try again.');
  }
  throw new Error(provider.name + ' finished the request, but it did not return an image.');
}

function buildProviderImageGenerationResult(provider, model, operation, image) {
  return {
    createdAt: new Date().toISOString(),
    images: [
      {
        base64Data: image.base64Data,
        extension: image.extension || getProviderImageExtension(image.mimeType),
        height: Number(image.height || 0) || 0,
        mimeType: normalizeProviderImageMimeType(image.mimeType),
        revisedPrompt: String(image.revisedPrompt || '').trim(),
        safetyNotes: Array.isArray(image.safetyNotes) ? image.safetyNotes : [],
        width: Number(image.width || 0) || 0,
      },
    ],
    model,
    operation,
    provider: provider.id,
  };
}

async function sendOpenAiImageGeneration(provider, apiKey, payload) {
  if (provider.id !== 'openai') {
    throw new Error(provider.name + ' does not support cloud image generation in Local AI Hub yet.');
  }

  const prompt = String(payload.prompt || '').trim();
  if (!prompt) {
    throw new Error('Enter a text prompt or edit instruction before generating an image.');
  }

  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose an OpenAI image model before generating an image.');
  }

  const imageReference = await readProviderImageReference(payload);
  if (imageReference) {
    const formData = new FormData();
    formData.append('background', normalizeAllowedValue(payload.background, OPENAI_IMAGE_BACKGROUNDS, 'auto'));
    formData.append('image', new Blob([imageReference.buffer], { type: imageReference.mimeType }), imageReference.fileName);
    formData.append('model', model);
    formData.append('n', '1');
    formData.append('output_format', 'png');
    formData.append('prompt', prompt);
    formData.append('quality', normalizeAllowedValue(payload.quality, OPENAI_IMAGE_QUALITIES, 'auto'));
    formData.append('size', normalizeAllowedValue(payload.size, OPENAI_IMAGE_SIZES, '1024x1024'));

    const response = await requestProviderJson(provider, apiKey, '/images/edits', {
      method: 'POST',
      body: formData,
      contentType: null,
      timeoutMs: PROVIDER_DOWNLOAD_TIMEOUT_MS,
    });
    const image = await normalizeProviderImageDataResponse(provider, apiKey, response);
    return buildProviderImageGenerationResult(provider, model, 'imageToImage', image);
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
    timeoutMs: PROVIDER_DOWNLOAD_TIMEOUT_MS,
  });
  const image = await normalizeProviderImageDataResponse(provider, apiKey, response);
  return buildProviderImageGenerationResult(provider, model, 'textToImage', image);
}

function collectGoogleInlineImageParts(response = {}) {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  return candidates.flatMap((candidate) => {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    return parts
      .map((part) => part?.inlineData || part?.inline_data || null)
      .filter((inlineData) => inlineData && String(inlineData.data || '').trim());
  });
}

async function sendGoogleImageGeneration(provider, apiKey, payload) {
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) {
    throw new Error('Enter a text prompt or edit instruction before generating an image.');
  }

  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose a Gemini image model before generating an image.');
  }

  const imageReference = await readProviderImageReference(payload);
  const modelPath = model.startsWith('models/') ? model : 'models/' + model;
  const parts = [{ text: prompt }];
  if (imageReference) {
    parts.push({ inlineData: { mimeType: imageReference.mimeType, data: imageReference.base64Data } });
  }

  const response = await requestProviderJson(provider, apiKey, modelPath + ':generateContent', {
    method: 'POST',
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    }),
    timeoutMs: PROVIDER_DOWNLOAD_TIMEOUT_MS,
  });

  const inlineImage = collectGoogleInlineImageParts(response)[0] || null;
  if (!inlineImage) {
    const safetyNotes = getProviderImageSafetyNotes(provider, response);
    if (safetyNotes.length) {
      throw new Error(provider.name + ' blocked or filtered that image request. Adjust the prompt or source image and try again.');
    }
    throw new Error(provider.name + ' finished the request, but it did not return an image.');
  }

  return buildProviderImageGenerationResult(provider, model, imageReference ? 'imageToImage' : 'textToImage', {
    base64Data: String(inlineImage.data || '').trim(),
    extension: getProviderImageExtension(inlineImage.mimeType || 'image/png'),
    mimeType: inlineImage.mimeType || 'image/png',
    safetyNotes: getProviderImageSafetyNotes(provider, response),
  });
}

async function sendXaiImageGeneration(provider, apiKey, payload) {
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) {
    throw new Error('Enter a text prompt or edit instruction before generating an image.');
  }

  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose an xAI image model before generating an image.');
  }

  const imageReference = await readProviderImageReference(payload);
  const endpoint = imageReference ? '/images/edits' : '/images/generations';
  const body = {
    model,
    prompt,
    response_format: 'b64_json',
  };
  if (imageReference) {
    body.image = {
      type: 'image_url',
      url: imageReference.dataUrl,
    };
  }

  const response = await requestProviderJson(provider, apiKey, endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: PROVIDER_DOWNLOAD_TIMEOUT_MS,
  });
  const image = await normalizeProviderImageDataResponse(provider, apiKey, response);
  return buildProviderImageGenerationResult(provider, model, imageReference ? 'imageToImage' : 'textToImage', image);
}

async function sendProviderImageGeneration(provider, apiKey, payload) {
  if (provider.id === 'openai') {
    return sendOpenAiImageGeneration(provider, apiKey, payload);
  }

  if (provider.configuration?.protocol === 'google-gemini') {
    return sendGoogleImageGeneration(provider, apiKey, payload);
  }

  if (provider.id === 'xai') {
    return sendXaiImageGeneration(provider, apiKey, payload);
  }

  throw new Error(provider.name + ' does not support cloud image generation in Local AI Hub yet.');
}

function normalizeProviderImageGenerationError(provider, error) {
  const rawMessage = redactSensitiveText(String(error?.message || error || '').trim(), { additionalSecrets: [] });
  const lower = rawMessage.toLowerCase();
  if (/api key|apikey|unauthorized|invalid key|forbidden|permission|401|403/.test(lower)) {
    return provider.name + ' could not run image generation because the API key is missing, invalid, or not allowed to use that model.';
  }
  if (/quota|billing|insufficient|credits|payment/.test(lower)) {
    return provider.name + ' says this account does not have enough image-generation quota or billing access for that request.';
  }
  if (/rate.?limit|too many requests|429/.test(lower)) {
    return provider.name + ' is rate limiting image generation right now. Wait a moment, then try again.';
  }
  if (/safety|policy|blocked|filtered|harm|prohibited/.test(lower)) {
    return provider.name + ' blocked or filtered that image request for safety. Adjust the prompt or source image and try again.';
  }
  if (/image|file|mime|png|jpg|jpeg|webp|base64|malformed/.test(lower)) {
    return rawMessage || 'Local AI Hub could not read or send the source image. Use a valid PNG, JPG, or WEBP image and try again.';
  }
  return humanizeError(error, 'Local AI Hub could not run that ' + provider.name + ' image generation step.');
}

function normalizeGoogleVideoModelPath(model) {
  const normalized = String(model || GOOGLE_VIDEO_DEFAULT_MODEL).trim() || GOOGLE_VIDEO_DEFAULT_MODEL;
  return normalized.startsWith('models/') ? normalized : 'models/' + normalized;
}

function normalizeGoogleVideoAspectRatio(value, size) {
  const normalized = String(value || '').trim();
  if (GOOGLE_VIDEO_ASPECT_RATIOS.has(normalized)) {
    return normalized;
  }

  const [width, height] = String(size || '').split('x').map((entry) => Number(entry || 0));
  if (width > 0 && height > 0) {
    return width > height ? '16:9' : '9:16';
  }

  return '16:9';
}

function normalizeGoogleVideoResolution(value) {
  return normalizeAllowedValue(value, GOOGLE_VIDEO_RESOLUTIONS, '720p');
}

function buildGoogleVideoRawStatusSummary(operation = {}) {
  const error = operation?.error && typeof operation.error === 'object' ? operation.error : null;
  const response = operation?.response && typeof operation.response === 'object' ? operation.response : null;
  const samples = response?.generateVideoResponse?.generatedSamples || response?.generatedVideos || [];
  return {
    done: operation?.done === true,
    errorCode: error?.code || null,
    errorMessage: error?.message ? redactSensitiveText(String(error.message).trim()) : '',
    name: String(operation?.name || '').trim(),
    sampleCount: Array.isArray(samples) ? samples.length : 0,
  };
}

function getGoogleVideoSafetyNotes(payload = {}) {
  const notes = [];
  const status = payload?.metadata?.status || payload?.response?.generateVideoResponse?.safetyAttributes || null;
  const errorMessage = String(payload?.error?.message || '').trim();
  if (/safety|policy|blocked|filtered|harm|prohibited/i.test(errorMessage)) {
    notes.push(errorMessage);
  }
  if (status && typeof status === 'object') {
    const blockReason = String(status.blockReason || status.block_reason || '').trim();
    if (blockReason) {
      notes.push('Google reported a safety block: ' + blockReason + '.');
    }
  }
  return [...new Set(notes.map((entry) => redactSensitiveText(String(entry || '').trim())).filter(Boolean))];
}

function getGoogleVideoFromOperation(operation = {}) {
  const generatedSamples = operation?.response?.generateVideoResponse?.generatedSamples;
  if (Array.isArray(generatedSamples) && generatedSamples.length) {
    return generatedSamples[0]?.video || null;
  }

  const generatedVideos = operation?.response?.generatedVideos || operation?.response?.generated_videos;
  if (Array.isArray(generatedVideos) && generatedVideos.length) {
    return generatedVideos[0]?.video || generatedVideos[0] || null;
  }

  return null;
}

function getProviderVideoExtension(mimeType, uri = '') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('webm') || /\.webm(?:$|[?#])/i.test(uri)) return '.webm';
  if (normalized.includes('quicktime') || /\.mov(?:$|[?#])/i.test(uri)) return '.mov';
  return '.mp4';
}

function getGoogleVideoDownloadUri(video = {}) {
  return String(video?.uri || video?.downloadUri || video?.download_uri || video?.fileUri || video?.file_uri || '').trim();
}

function getGoogleVideoBytes(video = {}) {
  const raw = String(video?.videoBytes || video?.video_bytes || '').trim();
  if (!raw) {
    return null;
  }
  try {
    const buffer = Buffer.from(raw, 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

async function cancelGoogleVideoOperation(provider, apiKey, operationName, signal) {
  const normalizedName = String(operationName || '').trim();
  if (!normalizedName || !signal?.aborted) {
    return false;
  }

  try {
    await requestProviderJson(provider, apiKey, normalizedName + ':cancel', {
      method: 'POST',
      timeoutMs: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

async function sendGoogleVideoGeneration(provider, apiKey, payload) {
  if (provider.id !== 'google') {
    throw new Error(provider.name + ' does not support cloud video generation in Local AI Hub yet.');
  }

  const prompt = String(payload.prompt || '').trim();
  if (!prompt) {
    throw new Error('Enter a prompt or motion instruction before generating a video.');
  }

  const model = String(payload.model || GOOGLE_VIDEO_DEFAULT_MODEL).trim() || GOOGLE_VIDEO_DEFAULT_MODEL;
  const modelPath = normalizeGoogleVideoModelPath(model);
  const signal = payload.signal || null;
  const onProgress = typeof payload.onProgress === 'function' ? payload.onProgress : null;
  const pollIntervalMs = Math.max(0, Number(payload.pollIntervalMs ?? GOOGLE_VIDEO_STATUS_POLL_MS) || 0);
  const statusTimeoutMs = Math.max(1, Number(payload.timeoutMs || GOOGLE_VIDEO_STATUS_TIMEOUT_MS) || GOOGLE_VIDEO_STATUS_TIMEOUT_MS);
  const imageReference = await readProviderImageReference(payload);
  const operation = imageReference ? 'imageToVideo' : 'textToVideo';
  const settings = {
    aspectRatio: normalizeGoogleVideoAspectRatio(payload.aspectRatio, payload.size),
    durationSeconds: Math.max(1, Number(payload.seconds || payload.durationSeconds || 8) || 8),
    negativePrompt: String(payload.negativePrompt || '').trim(),
    resolution: normalizeGoogleVideoResolution(payload.resolution),
  };
  const instance = { prompt };
  if (imageReference) {
    instance.image = {
      inlineData: {
        data: imageReference.base64Data,
        mimeType: imageReference.mimeType,
      },
    };
  }
  const parameters = {
    aspectRatio: settings.aspectRatio,
    resolution: settings.resolution,
  };
  if (settings.negativePrompt) {
    parameters.negativePrompt = settings.negativePrompt;
  }

  onProgress?.('Generating video with Google Veo...');
  const started = await requestProviderJson(provider, apiKey, modelPath + ':predictLongRunning', {
    cancelMessage: 'Google Veo video generation was cancelled before the request finished.',
    method: 'POST',
    body: JSON.stringify({
      instances: [instance],
      parameters,
    }),
    signal,
    timeoutMs: 60000,
  });

  const operationName = String(started?.name || '').trim();
  if (!operationName) {
    throw new Error(provider.name + ' accepted the request, but it did not return a video operation name.');
  }

  const startedAt = Date.now();
  let attempts = 0;
  let latestPayload = started;
  while (latestPayload?.done !== true) {
    if (signal?.aborted) {
      const providerCancelled = await cancelGoogleVideoOperation(provider, apiKey, operationName, signal);
      throw new Error(providerCancelled
        ? 'Google Veo video generation was cancelled.'
        : 'Google Veo polling stopped because the pipeline was cancelled. The cloud job may continue on Google for a short time.');
    }

    if (Date.now() - startedAt > statusTimeoutMs) {
      throw new Error(provider.name + ' is still generating that video after the timeout. Try again later or shorten the request.');
    }

    attempts += 1;
    onProgress?.('Waiting for Google Veo operation...');
    try {
      await waitForProvider(pollIntervalMs, signal, 'Google Veo polling stopped because the pipeline was cancelled.');
      latestPayload = await requestProviderJson(provider, apiKey, operationName, {
        cancelMessage: 'Google Veo polling stopped because the pipeline was cancelled.',
        method: 'GET',
        signal,
        timeoutMs: 60000,
      });
    } catch (error) {
      if (signal?.aborted) {
        const providerCancelled = await cancelGoogleVideoOperation(provider, apiKey, operationName, signal);
        throw new Error(providerCancelled
          ? 'Google Veo video generation was cancelled.'
          : 'Google Veo polling stopped because the pipeline was cancelled. The cloud job may continue on Google for a short time.');
      }
      throw error;
    }
  }

  if (latestPayload?.error) {
    const failureMessage = latestPayload.error.message || provider.name + ' could not finish that video request.';
    throw new Error(redactSensitiveText(String(failureMessage).trim(), { additionalSecrets: [apiKey] }));
  }

  const returnedVideo = getGoogleVideoFromOperation(latestPayload);
  if (!returnedVideo) {
    const safetyNotes = getGoogleVideoSafetyNotes(latestPayload);
    if (safetyNotes.length) {
      throw new Error(provider.name + ' blocked or filtered that video request for safety. Adjust the prompt or source image and try again.');
    }
    throw new Error(provider.name + ' finished the request, but it did not return a video.');
  }

  onProgress?.('Downloading generated video...');
  const inlineBuffer = getGoogleVideoBytes(returnedVideo);
  const downloadUri = getGoogleVideoDownloadUri(returnedVideo);
  let buffer = inlineBuffer;
  let mimeType = String(returnedVideo.mimeType || returnedVideo.mime_type || 'video/mp4').trim() || 'video/mp4';
  if (!buffer && downloadUri) {
    const downloaded = await requestProviderBuffer(provider, apiKey, downloadUri, {
      cancelMessage: 'Google Veo video download stopped because the pipeline was cancelled.',
      contentType: null,
      method: 'GET',
      signal,
      timeoutMs: PROVIDER_DOWNLOAD_TIMEOUT_MS,
    });
    buffer = downloaded.buffer;
    mimeType = downloaded.contentType.startsWith('video/') ? downloaded.contentType : mimeType;
  }

  if (!buffer?.length) {
    throw new Error(provider.name + ' finished the request, but the video file was empty.');
  }

  const extension = getProviderVideoExtension(mimeType, downloadUri);
  return {
    createdAt: new Date().toISOString(),
    model,
    operation,
    polling: {
      attemptCount: attempts,
      durationMs: Date.now() - startedAt,
    },
    provider: provider.id,
    providerOperationId: operationName,
    providerRawStatusSummary: buildGoogleVideoRawStatusSummary(latestPayload),
    requestedSettings: settings,
    safetyNotes: getGoogleVideoSafetyNotes(latestPayload),
    videos: [
      {
        buffer,
        extension,
        id: operationName,
        mimeType,
      },
    ],
  };
}

function normalizeXaiVideoAspectRatio(value, size) {
  const normalized = String(value || '').trim();
  if (XAI_VIDEO_ASPECT_RATIOS.has(normalized)) {
    return normalized;
  }

  const [width, height] = String(size || '').split('x').map((entry) => Number(entry || 0));
  if (width > 0 && height > 0) {
    return width > height ? '16:9' : '9:16';
  }

  return '16:9';
}

function normalizeXaiVideoResolution(value) {
  return normalizeAllowedValue(value, XAI_VIDEO_RESOLUTIONS, '720p');
}

function normalizeXaiVideoDuration(value) {
  const seconds = Math.max(1, Number(value || 8) || 8);
  return Math.min(15, Math.floor(seconds));
}

function buildXaiVideoRawStatusSummary(payload = {}) {
  const video = payload?.video && typeof payload.video === 'object' ? payload.video : null;
  const error = payload?.error && typeof payload.error === 'object' ? payload.error : null;
  return {
    errorCode: error?.code || null,
    errorMessage: error?.message ? redactSensitiveText(String(error.message).trim()) : '',
    hasVideo: Boolean(video?.url || video?.b64_json || video?.base64 || video?.data),
    model: String(payload?.model || '').trim(),
    requestId: String(payload?.request_id || payload?.requestId || payload?.id || '').trim(),
    status: String(payload?.status || '').trim(),
    videoDuration: Number(video?.duration || video?.duration_seconds || 0) || 0,
    videoResolution: String(video?.resolution || '').trim(),
  };
}

function getXaiVideoSafetyNotes(payload = {}) {
  const notes = [];
  const video = payload?.video && typeof payload.video === 'object' ? payload.video : null;
  const moderation = video?.respect_moderation;
  const status = String(payload?.status || '').trim();
  const errorMessage = String(payload?.error?.message || payload?.message || '').trim();
  if (moderation === false) {
    notes.push('xAI reported that the generated video did not pass moderation.');
  }
  if (/safety|policy|blocked|filtered|moderation|prohibited/i.test(status + ' ' + errorMessage)) {
    notes.push(errorMessage || 'xAI blocked or filtered that video request for safety.');
  }
  return [...new Set(notes.map((entry) => redactSensitiveText(String(entry || '').trim())).filter(Boolean))];
}

function getXaiVideoFromPayload(payload = {}) {
  if (payload?.video && typeof payload.video === 'object') {
    return payload.video;
  }

  const videos = Array.isArray(payload?.videos) ? payload.videos : [];
  if (videos.length) {
    return videos[0];
  }

  const data = Array.isArray(payload?.data) ? payload.data : [];
  if (data.length) {
    return data[0]?.video || data[0];
  }

  return null;
}

function getProviderVideoBytes(video = {}) {
  const raw = String(video?.b64_json || video?.base64 || video?.data || video?.videoBytes || video?.video_bytes || '').trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = parseInlineDataUrl(raw);
    const buffer = Buffer.from(parsed?.data || raw, 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

async function sendXaiVideoGeneration(provider, apiKey, payload) {
  if (provider.id !== 'xai') {
    throw new Error(provider.name + ' does not support cloud video generation in Local AI Hub yet.');
  }

  const prompt = String(payload.prompt || '').trim();
  if (!prompt) {
    throw new Error('Enter a prompt or motion instruction before generating a video.');
  }

  const model = String(payload.model || XAI_VIDEO_DEFAULT_MODEL).trim() || XAI_VIDEO_DEFAULT_MODEL;
  const signal = payload.signal || null;
  const onProgress = typeof payload.onProgress === 'function' ? payload.onProgress : null;
  const pollIntervalMs = Math.max(0, Number(payload.pollIntervalMs ?? XAI_VIDEO_STATUS_POLL_MS) || 0);
  const statusTimeoutMs = Math.max(1, Number(payload.timeoutMs || XAI_VIDEO_STATUS_TIMEOUT_MS) || XAI_VIDEO_STATUS_TIMEOUT_MS);
  const imageReference = await readProviderImageReference(payload);
  const operation = imageReference ? 'imageToVideo' : 'textToVideo';
  const settings = {
    aspectRatio: normalizeXaiVideoAspectRatio(payload.aspectRatio, payload.size),
    durationSeconds: normalizeXaiVideoDuration(payload.seconds || payload.durationSeconds || 8),
    resolution: normalizeXaiVideoResolution(payload.resolution),
  };
  const body = {
    model,
    prompt,
    duration: settings.durationSeconds,
    aspect_ratio: settings.aspectRatio,
    resolution: settings.resolution,
  };
  if (imageReference) {
    body.image = { url: imageReference.dataUrl };
  }

  onProgress?.('Generating video with xAI Grok Imagine...');
  const started = await requestProviderJson(provider, apiKey, '/videos/generations', {
    cancelMessage: 'xAI Grok Imagine video generation was cancelled before the request finished.',
    method: 'POST',
    body: JSON.stringify(body),
    signal,
    timeoutMs: 60000,
  });

  const startedVideo = getXaiVideoFromPayload(started);
  const requestId = String(started?.request_id || started?.requestId || started?.id || startedVideo?.id || '').trim();
  let attempts = 0;
  let latestPayload = started;
  const startedAt = Date.now();
  let latestStatus = String(latestPayload?.status || (startedVideo ? 'done' : '')).trim().toLowerCase();

  if (!startedVideo && !requestId) {
    throw new Error(provider.name + ' accepted the request, but it did not return a video operation ID.');
  }

  while (!getXaiVideoFromPayload(latestPayload) || !['done', 'completed', 'complete', 'succeeded', 'success'].includes(latestStatus || '')) {
    if (!requestId) {
      break;
    }

    if (['failed', 'failure', 'error', 'expired', 'cancelled', 'canceled', 'rejected', 'blocked'].includes(latestStatus)) {
      const failureMessage = latestPayload?.error?.message || latestPayload?.message || provider.name + ' could not finish that video request.';
      throw new Error(redactSensitiveText(String(failureMessage).trim(), { additionalSecrets: [apiKey] }));
    }

    if (signal?.aborted) {
      throw new Error('xAI Grok Imagine polling stopped because the pipeline was cancelled. The cloud job may continue on xAI for a short time.');
    }

    if (Date.now() - startedAt > statusTimeoutMs) {
      throw new Error(provider.name + ' is still generating that video after the timeout. Try again later or shorten the request.');
    }

    attempts += 1;
    onProgress?.('Waiting for xAI video operation...');
    await waitForProvider(pollIntervalMs, signal, 'xAI Grok Imagine polling stopped because the pipeline was cancelled.');
    latestPayload = await requestProviderJson(provider, apiKey, '/videos/' + encodeURIComponent(requestId), {
      cancelMessage: 'xAI Grok Imagine polling stopped because the pipeline was cancelled.',
      method: 'GET',
      signal,
      timeoutMs: 60000,
    });
    latestStatus = String(latestPayload?.status || '').trim().toLowerCase();
  }

  const returnedVideo = getXaiVideoFromPayload(latestPayload);
  if (!returnedVideo) {
    const safetyNotes = getXaiVideoSafetyNotes(latestPayload);
    if (safetyNotes.length) {
      throw new Error(provider.name + ' blocked or filtered that video request for safety. Adjust the prompt or source image and try again.');
    }
    throw new Error(provider.name + ' finished the request, but it did not return a video.');
  }

  if (returnedVideo.respect_moderation === false) {
    throw new Error(provider.name + ' blocked or filtered that video request for safety. Adjust the prompt or source image and try again.');
  }

  onProgress?.('Downloading generated video...');
  const downloadUri = String(returnedVideo.url || returnedVideo.uri || returnedVideo.downloadUrl || returnedVideo.download_url || '').trim();
  let buffer = getProviderVideoBytes(returnedVideo);
  let mimeType = String(returnedVideo.mimeType || returnedVideo.mime_type || 'video/mp4').trim() || 'video/mp4';
  if (!buffer && downloadUri) {
    const downloaded = await requestProviderBuffer(provider, apiKey, downloadUri, {
      cancelMessage: 'xAI Grok Imagine video download stopped because the pipeline was cancelled.',
      contentType: null,
      method: 'GET',
      signal,
      timeoutMs: PROVIDER_DOWNLOAD_TIMEOUT_MS,
    });
    buffer = downloaded.buffer;
    mimeType = downloaded.contentType.startsWith('video/') ? downloaded.contentType : mimeType;
  }

  if (!buffer?.length) {
    throw new Error(provider.name + ' finished the request, but the video file was empty.');
  }

  const extension = getProviderVideoExtension(mimeType, downloadUri);
  return {
    createdAt: new Date().toISOString(),
    model,
    operation,
    polling: {
      attemptCount: attempts,
      durationMs: Date.now() - startedAt,
    },
    provider: provider.id,
    providerOperationId: requestId,
    providerRawStatusSummary: buildXaiVideoRawStatusSummary(latestPayload),
    requestedSettings: settings,
    safetyNotes: getXaiVideoSafetyNotes(latestPayload),
    videos: [
      {
        buffer,
        durationSeconds: Number(returnedVideo.duration || returnedVideo.duration_seconds || 0) || settings.durationSeconds,
        extension,
        id: requestId,
        mimeType,
        resolution: String(returnedVideo.resolution || settings.resolution || '').trim(),
      },
    ],
  };
}
async function sendProviderVideoGeneration(provider, apiKey, payload) {
  if (provider.id === 'google') {
    return sendGoogleVideoGeneration(provider, apiKey, payload);
  }

  if (provider.id === 'xai') {
    return sendXaiVideoGeneration(provider, apiKey, payload);
  }

  throw new Error(provider.name + ' does not support cloud video generation in Local AI Hub yet.');
}

function normalizeProviderVideoGenerationError(provider, error) {
  const rawMessage = redactSensitiveText(String(error?.message || error || '').trim(), { additionalSecrets: [] });
  const lower = rawMessage.toLowerCase();
  if (/api key|apikey|unauthorized|invalid key|forbidden|permission|401|403/.test(lower)) {
    const providerRuntime = provider.id === 'xai' ? 'xAI Grok Imagine' : 'Google Veo';
    return provider.name + ' could not run video generation because the API key is missing, invalid, or not allowed to use ' + providerRuntime + '.';
  }
  if (/quota|billing|insufficient|credits|payment/.test(lower)) {
    return provider.name + ' says this account does not have enough video-generation quota or billing access for that request.';
  }
  if (/rate.?limit|too many requests|429/.test(lower)) {
    return provider.name + ' is rate limiting video generation right now. Wait a moment, then try again.';
  }
  if (/timeout|still generating|timed out/.test(lower)) {
    return provider.name + ' did not finish the video before Local AI Hub stopped waiting. Try again later or shorten the request.';
  }
  if (/safety|policy|blocked|filtered|harm|prohibited/.test(lower)) {
    return provider.name + ' blocked or filtered that video request for safety. Adjust the prompt or source image and try again.';
  }
  if (/unsupported|model|not found|404/.test(lower)) {
    return provider.id === 'xai'
      ? provider.name + ' does not appear to support that video model. Choose a current Grok Imagine video model and try again.'
      : provider.name + ' does not appear to support that video model. Choose a current Veo model and try again.';
  }
  if (/image|file|mime|png|jpg|jpeg|webp|base64|malformed|too large/.test(lower)) {
    return rawMessage || 'Local AI Hub could not read or send the source image. Use a valid PNG, JPG, or WEBP image and try again.';
  }
  if (/download|empty video|video file/.test(lower)) {
    return rawMessage || provider.name + ' finished the request, but Local AI Hub could not download the generated video.';
  }
  if (/cancel/.test(lower)) {
    return rawMessage || provider.name + ' video generation was cancelled.';
  }
  return humanizeError(error, 'Local AI Hub could not run that ' + provider.name + ' video generation step.');
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
      throw new Error(redactSensitiveText(String(failureMessage).trim(), { additionalSecrets: [apiKey] }));
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
      const credential = await resolveProviderCredential(provider.id).catch(() => ({ apiKey: '', credentialSource: 'missing' }));
      return normalizeProviderSummary(provider, settings.providers[provider.id] || {}, credential);
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
    const chatRequest = {
      messages,
      model,
      timeoutMessage: payload.timeoutMessage,
      timeoutMs: payload.timeoutMs,
      maxOutputTokens: payload.maxOutputTokens,
      responseFormat: payload.responseFormat,
    };
    let result = null;
    if (provider.configuration?.protocol === 'anthropic') {
      result = await sendAnthropicChat(provider, apiKey, chatRequest);
    } else if (provider.configuration?.protocol === 'google-gemini') {
      result = await sendGoogleChat(provider, apiKey, chatRequest);
    } else {
      result = await sendOpenAICompatibleChat(provider, apiKey, chatRequest);
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
  if (!model && doesProviderOperationRequireExplicitModel(provider.id, operationId)) {
    throw new Error('Choose a ' + provider.name + ' model before running this step.');
  }

  try {
    let result = null;
    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
      result = await sendProviderImageGeneration(provider, apiKey, payload);
    } else if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
      result = await sendProviderVideoGeneration(provider, apiKey, payload);
    } else if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
      result = await sendProviderSpeechGeneration(provider, apiKey, payload);
    } else {
      throw new Error(provider.name + ' does not support that pipeline operation yet.');
    }

    await recordProviderUsageSuccess(provider.id, result?.model || model, operationId);

    return result;
  } catch (error) {
    const message = operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
      ? normalizeProviderImageGenerationError(provider, error)
      : operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
        ? normalizeProviderVideoGenerationError(provider, error)
        : humanizeError(error, 'Local AI Hub could not run that ' + provider.name + ' provider step.');
    await logger.warn('Provider operation request failed.', {
      message,
      operationId,
    });
    throw new Error(message);
  }
}

module.exports = {
  buildGoogleGenerationConfig,
  buildOpenAiResponseFormat,
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


