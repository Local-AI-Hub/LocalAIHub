const { createLogger } = require('./logService');

function getBaseUrl(toolState) {
  const launchUrl = toolState?.launchUrl || `http://127.0.0.1:${toolState?.defaultPort || 11434}`;
  return String(launchUrl).replace(/\/$/, '');
}

async function requestOllama(toolState, endpoint, options = {}) {
  const baseUrl = getBaseUrl(toolState);
  const logger = createLogger('ollama', {
    toolId: toolState?.id || 'ollama',
    endpoint,
  });

  try {
    const response = await fetch(new URL(endpoint, `${baseUrl}/`).toString(), {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      body: options.body,
    });

    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { raw };
      }
    }

    if (!response.ok) {
      await logger.warn('Ollama API request returned a non-success status.', {
        status: response.status,
        statusText: response.statusText,
        payload,
      });

      const apiMessage =
        payload?.error ||
        payload?.message ||
        (typeof payload?.raw === 'string' ? payload.raw.trim() : '');
      const detail = apiMessage ? ` ${apiMessage}` : '';
      throw new Error(`${toolState?.name || 'Ollama'} returned ${response.status}.${detail}`.trim());
    }

    return {
      baseUrl,
      payload,
    };
  } catch (error) {
    if (error.message?.includes('returned ')) {
      throw error;
    }

    await logger.error('Ollama API request failed.', {
      error,
      baseUrl,
    });

    throw new Error(`${toolState?.name || 'Ollama'} is not answering on ${baseUrl} yet. Launch it from Library and try again.`);
  }
}

async function listOllamaModels(toolState) {
  const response = await requestOllama(toolState, '/api/tags');
  return {
    baseUrl: response.baseUrl,
    models: (response.payload.models || []).map((model) => ({
      digest: model.digest,
      modifiedAt: model.modified_at,
      name: model.name,
      size: model.size,
    })),
  };
}

async function chatWithOllama(toolState, payload = {}) {
  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose an Ollama model before sending a message.');
  }

  const messages = Array.isArray(payload.messages)
    ? payload.messages
        .map((message) => ({
          role: message?.role,
          content: String(message?.content || ''),
        }))
        .filter((message) => message.role && message.content)
    : [];

  if (!messages.length) {
    throw new Error('Type a message before sending it to Ollama.');
  }

  const response = await requestOllama(toolState, '/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });

  const content =
    response.payload?.message?.content ||
    response.payload?.response ||
    '';

  if (!String(content).trim()) {
    throw new Error('Ollama returned an empty reply.');
  }

  return {
    createdAt: response.payload?.created_at || new Date().toISOString(),
    model: response.payload?.model || model,
    message: {
      role: response.payload?.message?.role || 'assistant',
      content,
    },
  };
}

module.exports = {
  chatWithOllama,
  listOllamaModels,
};
