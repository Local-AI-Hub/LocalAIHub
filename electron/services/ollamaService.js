const { spawn } = require('child_process');
const fs = require('fs');
const { createLogger } = require('./logService');
const { buildOllamaAllocationFailureMessage, isOllamaAllocationFailureMessage } = require('./ollamaFailureService');
const { isToolActive, launchToolFromUserAction, stopTool } = require('./processService');
const { getResolvedToolState } = require('./toolStateService');

const LIST_REQUEST_TIMEOUT_MS = 15000;
const MODEL_INSPECT_TIMEOUT_MS = 15000;
const CHAT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const OLLAMA_READY_TIMEOUT_MS = 90 * 1000;
const OLLAMA_READY_PROBE_TIMEOUT_MS = 3000;
const OLLAMA_READY_POLL_INTERVAL_MS = 1000;

function getBaseUrl(toolState) {
  const launchUrl = toolState?.launchUrl || `http://127.0.0.1:${toolState?.defaultPort || 11434}`;
  return String(launchUrl).replace(/\/$/, '');
}

function getOllamaServeToolState(toolState) {
  if (String(toolState?.id || '').trim().toLowerCase() !== 'ollama') {
    return toolState;
  }
  const launchProfile = toolState?.launchProfile && typeof toolState.launchProfile === 'object' ? toolState.launchProfile : null;
  if (launchProfile?.kind !== 'binary') {
    return toolState;
  }
  const args = Array.isArray(launchProfile.args) ? launchProfile.args.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
  if (args.some((entry) => entry.toLowerCase() === 'serve')) {
    return toolState;
  }
  return {
    ...toolState,
    launchProfile: {
      ...launchProfile,
      args: ['serve', ...args],
    },
  };
}

function getOllamaExecutablePath(toolState = {}) {
  const launchProfile = toolState.launchProfile && typeof toolState.launchProfile === 'object' ? toolState.launchProfile : null;
  return String(
    launchProfile?.executable
      || toolState.executablePath
      || toolState.externalExecutablePath
      || toolState.detectedPath
      || '',
  ).trim();
}

function startOllamaServeProcess(toolState = {}) {
  const executable = getOllamaExecutablePath(toolState);
  if (!executable || !fs.existsSync(executable)) {
    throw new Error('Local AI Hub could not find the Ollama executable needed to start the local model API.');
  }
  const launchProfile = toolState.launchProfile && typeof toolState.launchProfile === 'object' ? toolState.launchProfile : null;
  const child = spawn(executable, ['serve'], {
    cwd: launchProfile?.workingDir || toolState.appDir || toolState.installDir || undefined,
    env: {
      ...process.env,
      ...(launchProfile?.env && typeof launchProfile.env === 'object' && !Array.isArray(launchProfile.env) ? launchProfile.env : {}),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getPositiveNumber(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback;
}

function buildOllamaUnavailableMessage(toolState, options = {}) {
  const toolName = toolState?.name || 'Ollama';
  const baseUrl = options.baseUrl || getBaseUrl(toolState);
  const actionLabel = String(options.actionLabel || '').trim();
  const followUp = options.autoStartAttempted
    ? ` Local AI Hub tried to start ${toolName} for you, but the API on ${baseUrl} is still not ready.`
    : options.alreadyActive
      ? ` ${toolName} appears to be running, but the API on ${baseUrl} is not ready. Restart ${toolName} from Library and try again.`
      : ` Start ${toolName} from Library and try again.`;

  if (actionLabel) {
    return `${toolName} is not answering on ${baseUrl} yet, so Local AI Hub cannot ${actionLabel}.${followUp}`;
  }

  return `${toolName} is not answering on ${baseUrl} yet.${followUp}`;
}

async function prepareOllamaSession(toolState, options = {}) {
  const latestTool = toolState?.id ? await getResolvedToolState(toolState.id, { syncDiscovered: false }) : null;
  const resolvedTool = latestTool || toolState;
  if (!options.autoStart) {
    return {
      alreadyActive: false,
      autoStarted: false,
      launchAttempted: false,
      startedByLocalAIHub: false,
      tool: resolvedTool,
    };
  }

  const apiAlreadyReady = await probeOllamaReady(resolvedTool, { timeoutMs: 1000 });
  if (apiAlreadyReady) {
    return {
      alreadyActive: true,
      autoStarted: false,
      launchAttempted: false,
      startedByLocalAIHub: false,
      tool: resolvedTool,
    };
  }

  const wasAlreadyActive = await isToolActive(resolvedTool).catch(() => false);
  if (String(resolvedTool?.id || '').trim().toLowerCase() === 'ollama') {
    const serveProcess = startOllamaServeProcess(resolvedTool);
    return {
      alreadyActive: wasAlreadyActive,
      autoStarted: true,
      launchAttempted: true,
      serveProcess,
      startedByLocalAIHub: true,
      tool: resolvedTool,
    };
  }

  const launchTool = getOllamaServeToolState(resolvedTool);
  const startedTool = await launchToolFromUserAction(launchTool, {
    launchContext: options.launchContext || 'background-task',
    skipOpenInterface: true,
  });
  return {
    alreadyActive: wasAlreadyActive,
    autoStarted: true,
    launchAttempted: true,
    startedByLocalAIHub: true,
    tool: startedTool,
  };
}

async function finishOllamaSession(session) {
  if (!session?.startedByLocalAIHub) {
    return;
  }

  if (session.serveProcess && !session.serveProcess.killed) {
    session.serveProcess.kill();
    return;
  }

  if (!session.tool) {
    return;
  }
  await stopTool(session.tool).catch(() => null);
}

async function probeOllamaReady(toolState, options = {}) {
  const baseUrl = getBaseUrl(toolState);
  const endpoint = options.endpoint || '/api/tags';
  const timeoutMs = getPositiveNumber(options.timeoutMs, OLLAMA_READY_PROBE_TIMEOUT_MS);
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(new URL(endpoint, `${baseUrl}/`).toString(), {
      method: 'GET',
      signal: controller.signal,
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForOllamaReady(toolState, options = {}) {
  const baseUrl = getBaseUrl(toolState);
  const timeoutMs = getPositiveNumber(options.timeoutMs, OLLAMA_READY_TIMEOUT_MS);
  const intervalMs = getPositiveNumber(options.intervalMs, OLLAMA_READY_POLL_INTERVAL_MS);
  const probeTimeoutMs = getPositiveNumber(options.probeTimeoutMs, OLLAMA_READY_PROBE_TIMEOUT_MS);
  const sleepImpl = typeof options.sleep === 'function' ? options.sleep : sleep;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const ready = await probeOllamaReady(toolState, {
      endpoint: options.endpoint || '/api/tags',
      fetch: options.fetch,
      timeoutMs: probeTimeoutMs,
    });
    if (ready) {
      return {
        baseUrl,
        ready: true,
      };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(buildOllamaUnavailableMessage(toolState, {
        actionLabel: options.actionLabel,
        alreadyActive: Boolean(options.alreadyActive),
        autoStartAttempted: Boolean(options.autoStartAttempted),
        baseUrl,
      }));
    }

    await sleepImpl(Math.min(intervalMs, remainingMs));
  }
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
    const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch;
    const response = await fetchImpl(new URL(endpoint, `${baseUrl}/`).toString(), {
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
      if (response.status === 500 && isOllamaAllocationFailureMessage(apiMessage)) {
        throw new Error(buildOllamaAllocationFailureMessage({
          modelName: options.modelName,
        }));
      }
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

    throw new Error(options.unavailableMessage || buildOllamaUnavailableMessage(toolState, { baseUrl }));
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOllamaCapabilityLabels(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function buildOllamaModelCapabilityRecord(model, payload = {}) {
  const capabilityLabels = normalizeOllamaCapabilityLabels(payload.capabilities);
  const modelInfoKeys = payload?.model_info && typeof payload.model_info === 'object'
    ? Object.keys(payload.model_info).map((key) => String(key || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const projectorInfoKeys = payload?.projector_info && typeof payload.projector_info === 'object'
    ? Object.keys(payload.projector_info).map((key) => String(key || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const metadataText = [
    payload?.modelfile,
    payload?.template,
    payload?.parameters,
    payload?.details?.family,
    ...(Array.isArray(payload?.details?.families) ? payload.details.families : []),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  let supportsImageInput = null;
  let capabilitySource = 'unknown';

  if (capabilityLabels.length) {
    supportsImageInput = capabilityLabels.includes('vision');
    capabilitySource = 'capabilities';
  } else if (
    projectorInfoKeys.length ||
    modelInfoKeys.some((key) => /(clip|projector|vision|mmproj)/i.test(key)) ||
    /(clip|projector|vision|mmproj)/i.test(metadataText)
  ) {
    supportsImageInput = true;
    capabilitySource = 'metadata';
  }

  return {
    capabilityLabels,
    capabilitySource,
    name: String(model || '').trim(),
    supportsImageInput,
  };
}

async function inspectOllamaModel(toolState, model) {
  const modelName = String(model || '').trim();
  if (!modelName) {
    throw new Error('Choose an Ollama model before Local AI Hub inspects its capabilities.');
  }

  const response = await requestOllama(toolState, '/api/show', {
    method: 'POST',
    body: JSON.stringify({
      model: modelName,
      verbose: true,
    }),
    timeoutMessage: `${toolState?.name || 'Ollama'} is taking too long to describe ${modelName}. Wait a little longer and try again.`,
    timeoutMs: MODEL_INSPECT_TIMEOUT_MS,
  });

  return buildOllamaModelCapabilityRecord(modelName, response.payload || {});
}

async function inspectOllamaModelCapabilities(toolState, modelNames = []) {
  const uniqueModelNames = [...new Set((modelNames || []).map((modelName) => String(modelName || '').trim()).filter(Boolean))];
  if (!uniqueModelNames.length) {
    return {};
  }

  const results = await Promise.all(
    uniqueModelNames.map(async (modelName) => {
      try {
        const record = await inspectOllamaModel(toolState, modelName);
        return [modelName.toLowerCase(), record];
      } catch {
        return null;
      }
    }),
  );

  return Object.fromEntries(results.filter(Boolean));
}

async function listOllamaModels(toolState, options = {}) {
  const response = await requestOllama(toolState, '/api/tags', {
    timeoutMessage: `${toolState?.name || 'Ollama'} did not return its model list in time. Confirm that the Ollama API is ready and try again.`,
    timeoutMs: LIST_REQUEST_TIMEOUT_MS,
  });

  let models = (response.payload.models || []).map((model) => ({
    digest: model.digest,
    modifiedAt: model.modified_at,
    name: model.name,
    size: model.size,
  }));

  if (options?.includeCapabilities && models.length) {
    const modelCapabilitiesByName = await inspectOllamaModelCapabilities(toolState, models.map((model) => model.name));
    models = models.map((model) => {
      const capabilityRecord = modelCapabilitiesByName[String(model.name || '').trim().toLowerCase()] || null;
      return capabilityRecord
        ? {
            ...model,
            capabilityLabels: capabilityRecord.capabilityLabels,
            capabilitySource: capabilityRecord.capabilitySource,
            supportsImageInput: capabilityRecord.supportsImageInput,
          }
        : model;
    });
  }

  return {
    baseUrl: response.baseUrl,
    models,
  };
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

function normalizeOllamaContentParts(content) {
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

      if (entry?.type === 'image') {
        const inlineImage = typeof entry.imageUrl === 'string' ? parseInlineDataUrl(entry.imageUrl) : null;
        const data = String(entry.data || inlineImage?.data || '').trim();
        return data ? { type: 'image', data } : null;
      }

      return null;
    })
    .filter(Boolean);
}

function normalizeOllamaMessages(messages = []) {
  return Array.isArray(messages)
    ? messages
        .map((message) => {
          const parts = normalizeOllamaContentParts(message?.content);
          return {
            role: String(message?.role || '').trim(),
            content: parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n').trim(),
            images: parts.filter((part) => part.type === 'image').map((part) => part.data),
          };
        })
        .filter((message) => message.role && (message.content || message.images.length))
        .map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.images.length ? { images: message.images } : {}),
        }))
    : [];
}

async function chatWithOllama(toolState, payload = {}) {
  const model = String(payload.model || '').trim();
  if (!model) {
    throw new Error('Choose an Ollama model before sending a message.');
  }

  const messages = normalizeOllamaMessages(payload.messages);
  if (!messages.length) {
    throw new Error('Type a message before sending it to Ollama.');
  }

  const requestBody = {
    model,
    messages,
    stream: false,
  };
  if (payload.format) {
    requestBody.format = payload.format;
  }
  if (payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options)) {
    requestBody.options = payload.options;
  }

  const baseUrl = getBaseUrl(toolState);
  const response = await requestOllama(toolState, '/api/chat', {
    method: 'POST',
    body: JSON.stringify(requestBody),
    fetch: payload.fetch,
    modelName: model,
    timeoutMessage: payload.timeoutMessage || (toolState?.name || 'Ollama') + ' is taking too long to answer. If this PC is struggling with ' + model + ', try a smaller model or give it more time to finish loading.',
    timeoutMs: Number(payload.timeoutMs || 0) > 0 ? Number(payload.timeoutMs) : CHAT_REQUEST_TIMEOUT_MS,
    unavailableMessage: (toolState?.name || 'Ollama') + ' could not complete the chat request on ' + baseUrl + '. If Ollama is still open, the selected model may have crashed or stopped responding while loading. Try a smaller model or restart Ollama and try again.',
  });

  const content = response.payload?.message?.content || response.payload?.response || '';
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
  buildOllamaModelCapabilityRecord,
  buildOllamaUnavailableMessage,
  chatWithOllama,
  finishOllamaSession,
  inspectOllamaModel,
  inspectOllamaModelCapabilities,
  listOllamaModels,
  prepareOllamaSession,
  waitForOllamaReady,
};
