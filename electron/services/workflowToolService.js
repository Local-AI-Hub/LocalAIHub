const fs = require('fs-extra');
const path = require('path');

const { createLogger } = require('./logService');
const { IMAGE_WORKFLOW_TOOL_IDS, selectLocalImageBackend } = require('../shared/pipelineSchema.cjs');

const IMAGE_MIME_TYPES = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function isImageWorkflowTool(tool) {
  return Boolean(tool?.id) && IMAGE_WORKFLOW_TOOL_IDS.includes(tool.id);
}

function getToolBaseUrl(tool) {
  const launchUrl = tool?.launchUrl || `http://127.0.0.1:${tool?.defaultPort || 7860}`;
  return String(launchUrl || '').replace(/\/$/, '');
}

function formatApiDetail(detail) {
  if (Array.isArray(detail)) {
    return detail
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return String(entry || '').trim();
        }

        const location = Array.isArray(entry.loc) ? entry.loc.join('.') : String(entry.loc || '').trim();
        const message = String(entry.msg || entry.message || '').trim();
        return [location, message].filter(Boolean).join(': ');
      })
      .filter(Boolean)
      .join('; ');
  }

  if (detail && typeof detail === 'object') {
    return String(detail.message || detail.error || JSON.stringify(detail)).trim();
  }

  return String(detail || '').trim();
}

function buildApiErrorMessage(tool, response, data, rawText, endpoint) {
  const detailMessage = formatApiDetail(data?.error || data?.detail || data?.message || rawText);
  const statusText = String(response.statusText || '').trim();
  const statusLabel = `${response.status}${statusText ? ' ' + statusText : ''}`;
  return `${tool?.name || 'This image tool'} API request to ${endpoint} returned ${statusLabel}${detailMessage ? ': ' + detailMessage : '.'}`;
}

class ToolApiHttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolApiHttpError';
    this.details = details;
  }
}

function isLikelySafetyCheckerModel(entry) {
  const haystack = [entry?.title, entry?.model_name, entry?.filename, entry?.name]
    .map((value) => String(value || '').toLowerCase())
    .join('\n');
  return Boolean(haystack) && /(^|[\\/\s_-])safety[_ -]?checker([\\/\s_.-]|$)/i.test(haystack);
}

function summarizeModelEntries(models = []) {
  return models
    .slice(0, 5)
    .map((entry) => String(entry?.title || entry?.model_name || entry?.filename || entry?.name || '').trim())
    .filter(Boolean)
    .join(', ');
}

async function assertUsableGenerationModel(tool, options = {}) {
  if (String(options.model || '').trim()) {
    return;
  }

  const models = await requestToolJson(tool, '/sdapi/v1/sd-models', null, 'list-models', {
    method: 'GET',
  });
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(`${tool?.name || 'This image tool'} API is reachable, but it did not report any Stable Diffusion checkpoints. Add or select a generation checkpoint before running this pipeline step.`);
  }

  const usableModels = models.filter((entry) => !isLikelySafetyCheckerModel(entry));
  if (!usableModels.length) {
    const summary = summarizeModelEntries(models);
    throw new Error(`${tool?.name || 'This image tool'} API is reachable, but its model list only shows non-generation support files${summary ? ': ' + summary : ''}. Add a real Stable Diffusion checkpoint before running this pipeline step.`);
  }
}

async function requestToolJson(tool, endpoint, payload, actionLabel, options = {}) {
  const baseUrl = getToolBaseUrl(tool);
  const requestUrl = new URL(endpoint, `${baseUrl}/`).toString();
  const method = String(options.method || 'POST').trim().toUpperCase() || 'POST';
  const logger = createLogger('pipeline-image-tool', {
    endpoint,
    method,
    toolId: tool?.id || 'image-tool',
  });

  try {
    const response = await fetch(requestUrl, {
      method,
      headers: method === 'GET'
        ? undefined
        : {
            'Content-Type': 'application/json',
          },
      body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
    });
    const rawText = await response.text();
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (error) {
      throw new SyntaxError(`${tool?.name || 'This image tool'} returned non-JSON from ${requestUrl}: ${String(error.message || error).trim()}`);
    }

    if (!response.ok) {
      throw new ToolApiHttpError(buildApiErrorMessage(tool, response, data, rawText, endpoint), {
        actionLabel,
        baseUrl,
        endpoint,
        method,
        requestUrl,
        responseJson: data,
        status: response.status,
      });
    }

    await logger.info('Image tool API request succeeded.', {
      actionLabel,
      baseUrl,
      endpoint,
      requestUrl,
      status: response.status,
    });
    return data;
  } catch (error) {
    if (error instanceof ToolApiHttpError) {
      await logger.warn('Image tool API request returned a non-success response.', error.details || { message: error.message });
      throw error;
    }

    if (error instanceof SyntaxError) {
      await logger.warn('Image tool API returned unreadable JSON.', {
        actionLabel,
        baseUrl,
        endpoint,
        message: error.message,
        requestUrl,
      });
      throw new Error(`${tool?.name || 'This image tool'} answered on ${baseUrl}, but Local AI Hub could not read the API response from ${endpoint}.`);
    }

    await logger.warn('Image tool API request could not connect.', {
      actionLabel,
      baseUrl,
      endpoint,
      message: error.message,
      method,
      requestUrl,
    });
    throw new Error(`${tool?.name || 'This image tool'} is not answering on ${baseUrl} yet. Local AI Hub tried ${requestUrl} and got: ${String(error.message || error).trim() || 'no response'}. Try the step again after Local AI Hub finishes starting it, or open Library to inspect the tool if it still will not respond.`);
  }
}

function resolveSelectedImageTool(contextMaps = {}, node = {}) {
  const selection = selectLocalImageBackend(contextMaps, node);
  if (selection.tool?.id) {
    return selection.tool;
  }

  return IMAGE_WORKFLOW_TOOL_IDS.map((toolId) => contextMaps.toolsById?.[toolId] || null).find(Boolean) || null;
}

function assertRunningImageTool(tool, actionLabel) {
  if (!tool) {
    throw new Error(`Install Automatic1111 or Forge before using the ${actionLabel} step.`);
  }

  if (String(tool.status || '').toLowerCase() !== 'running') {
    throw new Error(`${tool.name} is not ready for the ${actionLabel} step yet. Let Local AI Hub finish starting it and try again.`);
  }

  return tool;
}

function getImageMimeType(filePath) {
  return IMAGE_MIME_TYPES[path.extname(String(filePath || '')).toLowerCase()] || 'image/png';
}

async function readImageAsDataUrl(filePath) {
  const resolvedPath = path.resolve(String(filePath || '').trim());
  const payload = await fs.readFile(resolvedPath);
  return `data:${getImageMimeType(resolvedPath)};base64,${payload.toString('base64')}`;
}

async function generateImageWithWorkflowTool(tool, options = {}) {
  const runningTool = assertRunningImageTool(tool, 'image generation');
  await assertUsableGenerationModel(runningTool, options);
  const data = await requestToolJson(
    runningTool,
    '/sdapi/v1/txt2img',
    {
      cfg_scale: Number(options.cfgScale || 7),
      height: Number(options.height || 832),
      negative_prompt: String(options.negativePrompt || ''),
      prompt: String(options.prompt || ''),
      seed: Number.isFinite(Number(options.seed)) ? Number(options.seed) : -1,
      steps: Number(options.steps || 24),
      width: Number(options.width || 832),
      ...(String(options.model || '').trim()
        ? {
            override_settings: {
              sd_model_checkpoint: String(options.model || '').trim(),
            },
            override_settings_restore_afterwards: true,
          }
        : {}),
    },
    'generate-image',
  );

  const base64Image = Array.isArray(data?.images) ? data.images[0] : '';
  if (!String(base64Image || '').trim()) {
    throw new Error(`${tool.name} finished, but it did not return an image.`);
  }

  return {
    base64Image,
    info: data?.info || '',
  };
}

async function interrogateImageWithWorkflowTool(tool, options = {}) {
  const image = await readImageAsDataUrl(options.imagePath);
  const data = await requestToolJson(
    assertRunningImageTool(tool, 'image analysis'),
    '/sdapi/v1/interrogate',
    {
      image,
      model: String(options.analysisMode || 'clip').trim() || 'clip',
    },
    'interrogate-image',
  );

  const caption = String(data?.caption || '').trim();
  if (!caption) {
    throw new Error(`${tool.name} finished, but it did not return an image description.`);
  }

  return {
    text: caption,
  };
}

module.exports = {
  assertRunningImageTool,
  generateImageWithWorkflowTool,
  interrogateImageWithWorkflowTool,
  isImageWorkflowTool,
  resolveSelectedImageTool,
};


