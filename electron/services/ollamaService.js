const { createLogger } = require('./logService');
const { launchToolFromUserAction, stopTool } = require('./processService');
const { getResolvedToolState } = require('./toolStateService');

const LIST_REQUEST_TIMEOUT_MS = 15000;
const CHAT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function getBaseUrl(toolState) {
  const launchUrl = toolState?.launchUrl || `http://127.0.0.1:${toolState?.defaultPort || 11434}`;
  return String(launchUrl).replace(/\/$/, '');
}

function buildOllamaUnavailableMessage(toolState, options = {}) {
  const toolName = toolState?.name || 'Ollama';
  const baseUrl = options.baseUrl || getBaseUrl(toolState);
  const actionLabel = String(options.actionLabel || '').trim();
  const followUp = options.autoStartAttempted
    ? ` Local AI Hub tried to start ${toolName} for you, but the API on ${baseUrl} is still not ready.`
    : ` Start ${toolName} from Library and try again.`;

  if (actionLabel) {
    return `${toolName} is not answering on ${baseUrl} yet, so Local AI Hub cannot ${actionLabel}.${followUp}`;
  }

  return `${toolName} is not answering on ${baseUrl} yet.${followUp}`;
}

async function prepareOllamaSession(toolState, options = {}) {
  const latestTool = toolState?.id ? await getResolvedToolState(toolState.id, { syncDiscovered: false }) : null;
  const resolvedTool = latestTool || toolState;
  if (String(resolvedTool?.status || '').toLowerCase() === 'running' || !options.autoStart) {
    return {
      autoStarted: false,
      startedByLocalAIHub: false,
      tool: resolvedTool,
    };
  }

  const startedTool = await launchToolFromUserAction(resolvedTool, {
    launchContext: options.launchContext || 'background-task',
    skipOpenInterface: true,
  });
  return {
    autoStarted: true,
    startedByLocalAIHub: true,
    tool: startedTool,
  };
}

async function finishOllamaSession(session) {
  if (!session?.startedByLocalAIHub || !session.tool) {
    return;
  }

  await stopTool(session.tool).catch(() => null);
}

async function requestOllama(toolState, endpoint, options = {}) {
  const baseUrl = getBaseUrl(toolState);
  const logger = createLogger('ollama', {
    toolId: toolState?.id || 'ollama',
    endpoint,
  });
  const timeoutMs = Number(options.timeoutMs || 0) > 0 ? Number(options.timeoutMs) : LIST_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(new URL(endpoint, `${baseUrl}/`).toString(), {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      body: options.body,
      signal: controller.signal,
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
    if (error.name === 'AbortError') {
      await logger.warn('Ollama API request timed out.', {
        baseUrl,
        timeoutMs,
      });
      throw new Error(
        options.timeoutMessage ||
          `${toolState?.name || 'Ollama'} is taking too long to answer on ${baseUrl}. If it is still loading a model, wait a little longer or try a smaller one.`,
      );
    }

    if (error.message?.includes('returned ')) {
      throw error;
    }

    await logger.error('Ollama API request failed.', {
      error,
      baseUrl,
    });

    throw new Error(buildOllamaUnavailableMessage(toolState, { baseUrl }));
  } finally {
    clearTimeout(timer);
  }
}

async function listOllamaModels(toolState) {
  const response = await requestOllama(toolState, '/api/tags', {
    timeoutMessage: `${toolState?.name || 'Ollama'} did not return its model list in time. Confirm that the Ollama API is ready and try again.`,
    timeoutMs: LIST_REQUEST_TIMEOUT_MS,
  });
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
    timeoutMessage: `${toolState?.name || 'Ollama'} is taking too long to answer. If this PC is struggling with ${model}, try a smaller model or give it more time to finish loading.`,
    timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
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
  buildOllamaUnavailableMessage,
  chatWithOllama,
  finishOllamaSession,
  listOllamaModels,
  prepareOllamaSession,
};




