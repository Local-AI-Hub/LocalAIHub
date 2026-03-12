const fs = require('fs-extra');
const path = require('path');

const { createLogger } = require('./logService');
const { IMAGE_WORKFLOW_TOOL_IDS, getImageToolIdForNode } = require('../shared/pipelineSchema.cjs');

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

async function requestToolJson(tool, endpoint, payload, actionLabel) {
  const baseUrl = getToolBaseUrl(tool);
  const logger = createLogger('pipeline-image-tool', {
    endpoint,
    toolId: tool?.id || 'image-tool',
  });

  try {
    const response = await fetch(new URL(endpoint, `${baseUrl}/`).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    });
    const rawText = await response.text();
    const data = rawText ? JSON.parse(rawText) : {};
    if (!response.ok) {
      const errorMessage = data?.error || data?.detail || `${tool?.name || 'This image tool'} returned ${response.status}.`;
      throw new Error(String(errorMessage).trim());
    }

    return data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${tool?.name || 'This image tool'} returned a reply Local AI Hub could not read.`);
    }

    if (String(error.message || '').includes('returned ')) {
      await logger.warn('Image tool request returned a non-success response.', {
        message: error.message,
      });
      throw error;
    }

    await logger.warn('Image tool request failed.', {
      actionLabel,
      baseUrl,
      message: error.message,
    });
    throw new Error(`${tool?.name || 'This image tool'} is not answering on ${baseUrl} yet. Try the step again after Local AI Hub finishes starting it, or open Library to inspect the tool if it still will not respond.`);
  }
}

function resolveSelectedImageTool(contextMaps = {}, node = {}) {
  const selectedToolId = String(node?.config?.toolId || '').trim();
  if (selectedToolId) {
    return contextMaps.toolsById?.[selectedToolId] || null;
  }

  const preferredToolId = getImageToolIdForNode(node, contextMaps);
  if (preferredToolId && contextMaps.toolsById?.[preferredToolId]) {
    return contextMaps.toolsById[preferredToolId];
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
  const data = await requestToolJson(
    assertRunningImageTool(tool, 'image generation'),
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


