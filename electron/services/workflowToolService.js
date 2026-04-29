const fs = require('fs-extra');
const path = require('path');

const { createLogger } = require('./logService');
const { IMAGE_WORKFLOW_TOOL_IDS, selectLocalImageBackend } = require('../shared/pipelineSchema.cjs');
const {
  findStableDiffusionCheckpointMatch,
  getCanonicalStableDiffusionCheckpointName,
  getStableDiffusionCheckpointModels,
  normalizeStableDiffusionCheckpointEntry,
} = require('../shared/toolAssetSelection.cjs');

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

function summarizeModelEntries(models = []) {
  return models
    .slice(0, 5)
    .map((entry) => getCanonicalStableDiffusionCheckpointName(entry))
    .filter(Boolean)
    .join(', ');
}

function summarizeModelEntriesForDiagnostics(models = []) {
  const entries = (Array.isArray(models) ? models : [])
    .slice(0, 8)
    .map((entry) => {
      const label = getCanonicalStableDiffusionCheckpointName(entry);
      const baseName = String(entry?.fileName || entry?.basename || path.basename(String(entry?.filename || '')) || '').trim();
      return [label, baseName && baseName !== label ? baseName : ''].filter(Boolean).join(' / ');
    })
    .filter(Boolean);
  return entries.join(', ');
}

function formatSelectedCheckpointDiagnostic(selectedValue) {
  const value = String(selectedValue || '').trim();
  return value ? ' Selected value: "' + value + '".' : '';
}

function getLocalCheckpointEntries(tool) {
  return getStableDiffusionCheckpointModels(Array.isArray(tool?.downloadedModels) ? tool.downloadedModels : [])
    .filter((entry) => entry?.backendVisible !== true);
}

function summarizeLocalCheckpointMismatch(tool) {
  const localCheckpoints = getLocalCheckpointEntries(tool);
  if (!localCheckpoints.length) {
    return '';
  }

  const firstPath = String(localCheckpoints[0]?.path || '').trim();
  const folder = firstPath ? path.dirname(firstPath) : 'the tool model folder';
  return ' Local AI Hub can see downloaded checkpoint files locally' + (folder ? ' under ' + folder : '') + ', but the live WebUI API is not listing them. Restart ' + (tool?.name || 'the backend') + ' or use its model refresh control so it scans the checkpoint folder.';
}

async function listStableDiffusionApiCheckpoints(tool) {
  const models = await requestToolJson(tool, '/sdapi/v1/sd-models', null, 'list-models', {
    method: 'GET',
  });
  if (!Array.isArray(models)) {
    throw new Error((tool?.name || 'This image tool') + ' API answered, but its Stable Diffusion checkpoint list was not readable.');
  }

  return models.map((entry) => normalizeStableDiffusionCheckpointEntry(entry, tool, { backendVisible: true }));
}

async function resolveUsableGenerationModel(tool, options = {}) {
  const requestedModel = String(options.model || '').trim();
  const models = await listStableDiffusionApiCheckpoints(tool);
  const usableModels = getStableDiffusionCheckpointModels(models, { requireBackendVisible: true });

  if (!models.length) {
    throw new Error(`${tool?.name || 'This image tool'} API is reachable, but it did not report any Stable Diffusion checkpoints. Add a real checkpoint to the WebUI checkpoint folder before running this pipeline step.${summarizeLocalCheckpointMismatch(tool)}`);
  }

  if (!usableModels.length) {
    const summary = summarizeModelEntries(models);
    throw new Error(`${tool?.name || 'This image tool'} API is reachable, but its model list only shows non-generation support files${summary ? ': ' + summary : ''}. Add a real Stable Diffusion checkpoint before running this pipeline step.${summarizeLocalCheckpointMismatch(tool)}`);
  }

  if (!requestedModel) {
    return { checkpoint: '', models: usableModels };
  }

  const matchedModel = findStableDiffusionCheckpointMatch(usableModels, requestedModel);
  if (!matchedModel) {
    const localMatch = findStableDiffusionCheckpointMatch(getLocalCheckpointEntries(tool), requestedModel);
    if (localMatch) {
      throw new Error('Selected checkpoint is downloaded locally, but ' + (tool?.name || 'the selected image backend') + ' does not list it through the live /sdapi/v1/sd-models response yet.' + formatSelectedCheckpointDiagnostic(requestedModel) + ' Restart the backend or use its model refresh control, then refresh checkpoints in Local AI Hub.');
    }

    const summary = summarizeModelEntriesForDiagnostics(usableModels);
    throw new Error('Selected checkpoint is not available in the live ' + (tool?.name || 'selected image backend') + ' model list.' + formatSelectedCheckpointDiagnostic(requestedModel) + ' Runtime source: live /sdapi/v1/sd-models.' + (summary ? ' Available checkpoints: ' + summary + '.' : '') + ' Refresh checkpoints or download that checkpoint before running this step.');
  }

  return {
    checkpoint: getCanonicalStableDiffusionCheckpointName(matchedModel) || requestedModel,
    models: usableModels,
  };
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
  const checkpointSelection = await resolveUsableGenerationModel(runningTool, options);
  const checkpointOverride = String(checkpointSelection.checkpoint || '').trim();
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
      ...(checkpointOverride
        ? {
            override_settings: {
              sd_model_checkpoint: checkpointOverride,
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
  listStableDiffusionApiCheckpoints,
  resolveSelectedImageTool,
};



