const path = require('path');
const fs = require('fs-extra');

const { ensureStorage, humanizeError } = require('./configService');
const { getProviderSecret, maskSecret, setProviderSecret } = require('./credentialService');
const { createLogger } = require('./logService');
const { getProviderCatalog, getProviderManifest, initializeProviderRegistry, resolveProviderUrl } = require('./providerRegistry');

const PROVIDER_SETTINGS_FILE = 'provider-connections.json';
const PROVIDER_SETTINGS_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15000;

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

function normalizeOpenAIModels(provider, payload) {
  return (payload?.data || [])
    .map((entry) => ({
      id: String(entry?.id || '').trim(),
      label: String(entry?.id || '').trim(),
      detail: String(entry?.owned_by || provider.name || '').trim() || null,
    }))
    .filter((entry) => entry.id && !matchesBlockedModel(provider, entry.id))
    .sort((left, right) => left.label.localeCompare(right.label));
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
    .filter((entry) => entry.id && entry.supportsGenerateContent && !matchesBlockedModel(provider, entry.id))
    .sort((left, right) => left.label.localeCompare(right.label));
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

function normalizeProviderSummary(provider, settingsEntry = {}, apiKey = '') {
  const hasKey = Boolean(String(apiKey || '').trim());
  const lastTestSucceeded = settingsEntry.lastTestSucceeded === true;
  const lastTestFailed = settingsEntry.lastTestSucceeded === false;

  return {
    ...provider,
    kind: 'cloud-provider',
    source: 'cloud',
    cloudBadge: 'Cloud',
    isConnected: hasKey,
    libraryStatus: hasKey ? (lastTestFailed ? 'attention' : 'connected') : 'disconnected',
    maskedKey: hasKey ? maskSecret(apiKey) : '',
    lastAvailableModelId: settingsEntry.lastAvailableModelId || '',
    lastConnectedAt: settingsEntry.lastConnectedAt || null,
    lastTestMessage: settingsEntry.lastTestMessage || '',
    lastTestSucceeded,
    lastTestedAt: settingsEntry.lastTestedAt || null,
    modelCount: Number(settingsEntry.modelCount || 0),
    selectedModel: settingsEntry.selectedModel || '',
    statusLabel: hasKey ? (lastTestFailed ? 'Needs attention' : lastTestSucceeded ? 'Connected' : 'Key saved') : 'Not connected',
  };
}

async function loadProviderSecretOrThrow(providerId) {
  const apiKey = await getProviderSecret(providerId).catch(() => '');
  if (!String(apiKey || '').trim()) {
    throw new Error('Enter an API key for this provider first.');
  }

  return apiKey;
}

async function fetchProviderModelsInternal(provider, apiKey) {
  const payload = await requestProviderJson(provider, apiKey, provider.modelsEndpoint, {
    method: 'GET',
  });

  if (provider.configuration?.protocol === 'anthropic') {
    return normalizeAnthropicModels(payload);
  }

  if (provider.configuration?.protocol === 'google-gemini') {
    return normalizeGoogleModels(provider, payload);
  }

  return normalizeOpenAIModels(provider, payload);
}

function normalizeChatMessages(messages = []) {
  return Array.isArray(messages)
    ? messages
        .map((message) => ({
          role: String(message?.role || '').trim(),
          content: String(message?.content || '').trim(),
        }))
        .filter((message) => message.role && message.content)
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

async function sendOpenAICompatibleChat(provider, apiKey, payload) {
  const response = await requestProviderJson(provider, apiKey, provider.configuration?.chatEndpoint || '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: payload.model,
      messages: payload.messages,
      stream: false,
    }),
  });

  const content = extractTextParts(response?.choices?.[0]?.message?.content || response?.choices?.[0]?.text || response?.output_text || '');
  if (!content) {
    throw new Error(`${provider.name} returned an empty reply.`);
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
  const systemMessages = payload.messages.filter((message) => message.role === 'system').map((message) => message.content);
  const conversation = payload.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: [{ type: 'text', text: message.content }],
    }));

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
    throw new Error(`${provider.name} returned an empty reply.`);
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
  const systemMessages = payload.messages.filter((message) => message.role === 'system').map((message) => message.content);
  const contents = payload.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));

  if (!contents.length) {
    throw new Error('Type a message before sending it to this provider.');
  }

  const modelPath = String(payload.model || '').startsWith('models/') ? payload.model : `models/${payload.model}`;
  const response = await requestProviderJson(provider, apiKey, `${modelPath}:generateContent`, {
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
    throw new Error(`${provider.name} returned an empty reply.`);
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

async function listProviderModels(providerId) {
  await initializeProviderRegistry();
  const provider = getProviderManifest(providerId);
  if (!provider) {
    throw new Error('Local AI Hub could not find that cloud provider.');
  }

  const apiKey = await loadProviderSecretOrThrow(provider.id);
  const logger = createLogger('providers', {
    providerId: provider.id,
    mode: 'list-models',
  });

  const settings = await readProviderSettings();
  try {
    const models = await fetchProviderModelsInternal(provider, apiKey);
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
    throw new Error(humanizeError(error, `Local AI Hub could not load models from ${provider.name}.`));
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
    throw new Error(`Choose a ${provider.name} model before sending a message.`);
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

    await updateProviderSettings((settings) => ({
      ...settings,
      providers: {
        ...settings.providers,
        [provider.id]: {
          ...(settings.providers[provider.id] || {}),
          selectedModel: model,
        },
      },
    }));

    return result;
  } catch (error) {
    const message = humanizeError(error, `Local AI Hub could not send that message to ${provider.name}.`);
    await logger.warn('Provider chat request failed.', {
      message,
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
  saveProviderConnection,
  testProviderConnection,
};
