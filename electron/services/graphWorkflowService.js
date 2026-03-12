const fs = require('fs-extra');
const path = require('path');
const { randomUUID } = require('crypto');

const { createLogger } = require('./logService');
const { saveBufferArtifact, summarizeArtifact } = require('./pipelineArtifactService');
const { PORT_KIND_IMAGE, PORT_KIND_TEXT } = require('../shared/pipelineSchema.cjs');

const COMFYUI_POLL_INTERVAL_MS = 1500;
const COMFYUI_TIMEOUT_MS = 5 * 60 * 1000;

function getToolBaseUrl(tool) {
  const launchUrl = tool?.launchUrl || `http://127.0.0.1:${tool?.defaultPort || 8188}`;
  return String(launchUrl || '').replace(/\/$/, '');
}

function getToolLabel(tool) {
  return String(tool?.name || 'This graph workflow tool').trim() || 'This graph workflow tool';
}

function buildToolUrl(tool, endpoint) {
  return new URL(endpoint, `${getToolBaseUrl(tool)}/`).toString();
}

function extractRemoteErrorMessage(tool, rawText, fallbackStatus, parsedData = null) {
  const directMessage = parsedData && typeof parsedData === 'object'
    ? String(parsedData.error || parsedData.detail || parsedData.message || '').trim()
    : '';
  if (directMessage) {
    return directMessage;
  }

  const trimmedText = String(rawText || '').trim();
  if (trimmedText) {
    return trimmedText;
  }

  return `${getToolLabel(tool)} returned ${fallbackStatus}.`;
}

function buildUnavailableToolError(tool) {
  return `${getToolLabel(tool)} is not answering on ${getToolBaseUrl(tool)} yet. Let Local AI Hub finish starting it and try this graph workflow step again.`;
}

function buildHandledGraphWorkflowError(message) {
  const error = new Error(message);
  error.localAiHubHandled = true;
  return error;
}

async function requestGraphWorkflowJson(tool, endpoint, options = {}, actionLabel = 'run this graph workflow step') {
  const logger = createLogger('pipeline-graph-workflow', {
    endpoint,
    toolId: tool?.id || 'graph-workflow-tool',
  });

  const method = String(options.method || (options.body ? 'POST' : 'GET')).trim().toUpperCase() || 'GET';
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body !== undefined && body !== null && !(body instanceof FormData)) {
    const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
    if (contentType && !headers['Content-Type']) {
      headers['Content-Type'] = contentType;
    }

    if (headers['Content-Type'] === 'application/json' && typeof body !== 'string') {
      body = JSON.stringify(body);
    }
  }

  try {
    const response = await fetch(buildToolUrl(tool, endpoint), {
      method,
      headers,
      body,
    });
    const rawText = await response.text();
    const allowedStatuses = Array.isArray(options.allowedStatuses) ? options.allowedStatuses : [];
    if (allowedStatuses.includes(response.status)) {
      return null;
    }

    let parsedData = {};
    if (rawText) {
      try {
        parsedData = JSON.parse(rawText);
      } catch {
        if (response.ok) {
          throw buildHandledGraphWorkflowError(`${getToolLabel(tool)} returned a reply Local AI Hub could not read.`);
        }
      }
    }

    if (!response.ok) {
      const message = extractRemoteErrorMessage(tool, rawText, response.status, parsedData);
      throw buildHandledGraphWorkflowError(message);
    }

    return parsedData;
  } catch (error) {
    if (error?.localAiHubHandled) {
      await logger.warn('Graph workflow request returned a non-success response.', {
        actionLabel,
        message: error.message,
      });
      throw error;
    }

    await logger.warn('Graph workflow request failed.', {
      actionLabel,
      baseUrl: getToolBaseUrl(tool),
      message: error.message,
    });
    throw new Error(buildUnavailableToolError(tool));
  }
}

async function requestGraphWorkflowBuffer(tool, endpoint, options = {}, actionLabel = 'download this graph workflow output') {
  const logger = createLogger('pipeline-graph-workflow', {
    endpoint,
    toolId: tool?.id || 'graph-workflow-tool',
  });

  try {
    const response = await fetch(buildToolUrl(tool, endpoint), {
      headers: {
        ...(options.headers || {}),
      },
      method: String(options.method || 'GET').trim().toUpperCase() || 'GET',
    });

    if (!response.ok) {
      const rawText = await response.text();
      throw buildHandledGraphWorkflowError(extractRemoteErrorMessage(tool, rawText, response.status, null));
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error?.localAiHubHandled) {
      await logger.warn('Graph workflow buffer request returned a non-success response.', {
        actionLabel,
        message: error.message,
      });
      throw error;
    }

    await logger.warn('Graph workflow buffer request failed.', {
      actionLabel,
      baseUrl: getToolBaseUrl(tool),
      message: error.message,
    });
    throw new Error(buildUnavailableToolError(tool));
  }
}

function parseGraphWorkflowText(workflowText) {
  const raw = String(workflowText || '').trim();
  if (!raw) {
    throw new Error('Paste the exported ComfyUI API workflow JSON before running this graph workflow step.');
  }

  let workflow = null;
  try {
    workflow = JSON.parse(raw);
  } catch {
    throw new Error('Local AI Hub could not read that graph workflow JSON. Paste the exported ComfyUI API workflow JSON for this step.');
  }

  if (!workflow || Array.isArray(workflow) || typeof workflow !== 'object') {
    throw new Error('This graph workflow step needs a ComfyUI API workflow JSON object keyed by node ID.');
  }

  const nodeIds = Object.keys(workflow);
  if (!nodeIds.length) {
    throw new Error('This graph workflow JSON does not contain any workflow nodes yet.');
  }

  return workflow;
}

function getWorkflowNodeEntry(workflow, nodeId, label) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    throw new Error(`Choose a workflow node for the ${label} mapping.`);
  }

  const entry = workflow[normalizedNodeId];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`The selected workflow node ${normalizedNodeId} for the ${label} mapping is missing from the pasted graph JSON.`);
  }

  return entry;
}

function setWorkflowInput(workflow, nodeId, field, value, label) {
  const entry = getWorkflowNodeEntry(workflow, nodeId, label);
  const normalizedField = String(field || '').trim();
  if (!normalizedField) {
    throw new Error(`Choose a workflow field for the ${label} mapping.`);
  }

  if (!entry.inputs || typeof entry.inputs !== 'object') {
    entry.inputs = {};
  }

  entry.inputs[normalizedField] = value;
}

function buildComfyUiPromptError(payload) {
  const directMessage = String(payload?.error || payload?.detail || payload?.message || '').trim();
  if (directMessage) {
    return directMessage;
  }

  const nodeErrors = payload?.node_errors;
  if (nodeErrors && typeof nodeErrors === 'object') {
    const firstEntry = Object.entries(nodeErrors).find(([, value]) => value && typeof value === 'object');
    if (firstEntry) {
      const [nodeId, detail] = firstEntry;
      const detailMessage = String(detail.errors?.[0]?.message || detail.message || '').trim();
      return detailMessage
        ? `ComfyUI rejected the graph workflow around node ${nodeId}: ${detailMessage}`
        : `ComfyUI rejected the graph workflow around node ${nodeId}. Check the mapped fields and exported API JSON.`;
    }
  }

  return 'ComfyUI could not start that graph workflow. Check the exported API JSON and boundary mappings.';
}

function buildComfyUiHistoryError(historyEntry) {
  const statusMessage = Array.isArray(historyEntry?.status?.messages)
    ? historyEntry.status.messages
        .map((entry) => {
          if (Array.isArray(entry) && entry[1] && typeof entry[1] === 'object') {
            return String(entry[1].message || entry[1].details || '').trim();
          }
          return Array.isArray(entry) ? String(entry[1] || '').trim() : String(entry || '').trim();
        })
        .find(Boolean)
    : '';

  return statusMessage
    ? `ComfyUI stopped while running the graph workflow: ${statusMessage}`
    : 'ComfyUI stopped before it produced the requested graph workflow output.';
}

function buildUploadedImageReference(uploadedFile) {
  const fileName = String(uploadedFile?.name || uploadedFile?.filename || '').trim();
  if (!fileName) {
    throw new Error('ComfyUI accepted the uploaded image, but it did not return a usable file name for the workflow.');
  }

  const subfolder = String(uploadedFile?.subfolder || '').trim().replace(/^\\+|\\+$/g, '').replace(/^\/+|\/+$/g, '');
  return subfolder ? `${subfolder}/${fileName}` : fileName;
}

async function uploadComfyUiImage(tool, artifact) {
  const filePath = path.resolve(String(artifact?.filePath || '').trim());
  if (!filePath || !(await fs.pathExists(filePath))) {
    throw new Error('The image input for this graph workflow step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  const mimeType = String(artifact?.mimeType || 'image/png').trim() || 'image/png';
  const fileName = String(artifact?.fileName || path.basename(filePath)).trim() || path.basename(filePath);
  const formData = new FormData();
  formData.append('image', new Blob([await fs.readFile(filePath)], { type: mimeType }), fileName);
  formData.append('type', 'input');
  formData.append('overwrite', 'true');

  const uploaded = await requestGraphWorkflowJson(tool, '/upload/image', {
    body: formData,
    contentType: null,
    method: 'POST',
  }, 'upload the graph workflow image input');

  return {
    fileName,
    reference: buildUploadedImageReference(uploaded),
    response: uploaded,
  };
}

async function submitComfyUiWorkflow(tool, workflow) {
  const payload = await requestGraphWorkflowJson(tool, '/prompt', {
    body: {
      client_id: randomUUID(),
      prompt: workflow,
    },
    method: 'POST',
  }, 'submit the graph workflow');

  const promptId = String(payload?.prompt_id || '').trim();
  if (!promptId) {
    throw new Error(buildComfyUiPromptError(payload));
  }

  return promptId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForComfyUiWorkflow(tool, promptId, reportProgress, nodeLabel) {
  const startedAt = Date.now();
  let pollCount = 0;

  while (Date.now() - startedAt < COMFYUI_TIMEOUT_MS) {
    const payload = await requestGraphWorkflowJson(tool, `/history/${encodeURIComponent(promptId)}`, {
      allowedStatuses: [404],
      method: 'GET',
    }, 'check the graph workflow progress');

    const historyEntry = payload && typeof payload === 'object'
      ? (payload[promptId] && typeof payload[promptId] === 'object' ? payload[promptId] : payload)
      : null;

    if (historyEntry) {
      const status = String(historyEntry?.status?.status_str || '').trim().toLowerCase();
      if (status === 'error') {
        throw new Error(buildComfyUiHistoryError(historyEntry));
      }

      if (historyEntry.outputs && Object.keys(historyEntry.outputs).length) {
        return historyEntry;
      }
    }

    pollCount += 1;
    if (pollCount % 4 === 0) {
      reportProgress?.(
        'ComfyUI is still rendering the graph workflow.',
        `Running ${nodeLabel} with ${getToolLabel(tool)}...`,
      );
    }

    await sleep(COMFYUI_POLL_INTERVAL_MS);
  }

  throw new Error(`${getToolLabel(tool)} is taking longer than expected to finish this graph workflow step. Open the tool to inspect its queue, then try again.`);
}

function getOutputImageReference(historyEntry, outputNodeId) {
  const outputEntry = historyEntry?.outputs?.[outputNodeId] || null;
  if (!outputEntry || typeof outputEntry !== 'object') {
    throw new Error(`The selected output node ${outputNodeId} did not produce any saved graph workflow output. Choose a node that emits images, such as PreviewImage or SaveImage.`);
  }

  const imageEntry = Array.isArray(outputEntry.images) ? outputEntry.images[0] || null : null;
  if (!imageEntry) {
    throw new Error(`The selected output node ${outputNodeId} finished, but it did not return an image. This first graph workflow slice expects an image-emitting ComfyUI node.`);
  }

  const fileName = String(imageEntry.filename || imageEntry.name || '').trim();
  if (!fileName) {
    throw new Error(`The selected output node ${outputNodeId} returned an image record without a file name.`);
  }

  return {
    fileName,
    subfolder: String(imageEntry.subfolder || '').trim(),
    type: String(imageEntry.type || 'output').trim() || 'output',
  };
}

async function downloadComfyUiImage(tool, imageReference) {
  const params = new URLSearchParams();
  params.set('filename', imageReference.fileName);
  params.set('type', imageReference.type || 'output');
  if (imageReference.subfolder) {
    params.set('subfolder', imageReference.subfolder);
  }

  return requestGraphWorkflowBuffer(tool, `/view?${params.toString()}`, {
    method: 'GET',
  }, 'download the graph workflow image output');
}

function getGraphInputArtifact(inputArtifacts, portId) {
  const artifact = inputArtifacts?.[portId] || null;
  if (!artifact) {
    return null;
  }

  if (portId === 'text' && artifact.kind !== PORT_KIND_TEXT) {
    throw new Error('This graph workflow step expected text input on the Text port.');
  }

  if (portId === 'image' && artifact.kind !== PORT_KIND_IMAGE) {
    throw new Error('This graph workflow step expected image input on the Image port.');
  }

  return artifact;
}

function buildOutputFileExtension(fileName) {
  const extension = path.extname(String(fileName || '').trim()).toLowerCase();
  return extension || '.png';
}

async function executeComfyUiGraphWorkflow({ inputArtifacts = {}, node, reportProgress, runDirectories, tool }) {
  const nodeLabel = String(node?.label || 'Graph Workflow').trim() || 'Graph Workflow';
  const workflow = parseGraphWorkflowText(node?.config?.workflowText);
  const workingWorkflow = JSON.parse(JSON.stringify(workflow));
  const textArtifact = getGraphInputArtifact(inputArtifacts, 'text');
  const imageArtifact = getGraphInputArtifact(inputArtifacts, 'image');
  const textBinding = node?.config?.inputBindings?.text || {};
  const imageBinding = node?.config?.inputBindings?.image || {};
  const outputNodeId = String(node?.config?.outputBindings?.image?.nodeId || '').trim();

  if (textArtifact) {
    const textValue = String(textArtifact.text || '').trim();
    if (!textValue) {
      throw new Error('The connected text input for this graph workflow step is empty.');
    }

    setWorkflowInput(workingWorkflow, textBinding.nodeId, textBinding.field, textValue, 'text input');
  }

  if (imageArtifact) {
    reportProgress?.(
      `Uploading the connected image to ${getToolLabel(tool)} for this graph workflow.`,
      `Running ${nodeLabel} with ${getToolLabel(tool)}...`,
    );
    const uploadedImage = await uploadComfyUiImage(tool, imageArtifact);
    setWorkflowInput(workingWorkflow, imageBinding.nodeId, imageBinding.field, uploadedImage.reference, 'image input');
  }

  getWorkflowNodeEntry(workingWorkflow, outputNodeId, 'image output');

  reportProgress?.(
    `Submitting the graph workflow to ${getToolLabel(tool)}.`,
    `Running ${nodeLabel} with ${getToolLabel(tool)}...`,
  );
  const promptId = await submitComfyUiWorkflow(tool, workingWorkflow);

  reportProgress?.(
    `${getToolLabel(tool)} accepted the graph workflow and is now rendering it.`,
    `Running ${nodeLabel} with ${getToolLabel(tool)}...`,
  );
  const historyEntry = await waitForComfyUiWorkflow(tool, promptId, reportProgress, nodeLabel);
  const outputImage = getOutputImageReference(historyEntry, outputNodeId);

  reportProgress?.(
    `Downloading the graph workflow image output from ${getToolLabel(tool)}.`,
    `Running ${nodeLabel} with ${getToolLabel(tool)}...`,
  );
  const imageBuffer = await downloadComfyUiImage(tool, outputImage);
  const artifact = await saveBufferArtifact(runDirectories, imageBuffer, {
    baseName: `${nodeLabel}-${Date.now()}`,
    displayName: nodeLabel,
    extension: buildOutputFileExtension(outputImage.fileName),
    kind: PORT_KIND_IMAGE,
    role: 'generated',
  });

  return {
    destinationPath: artifact.filePath,
    message: `${getToolLabel(tool)} finished the graph workflow and saved the image output to ${artifact.filePath}.`,
    outputs: {
      image: artifact,
    },
    preview: summarizeArtifact(artifact),
  };
}

const GRAPH_WORKFLOW_ADAPTERS = Object.freeze({
  comfyui: Object.freeze({
    execute: executeComfyUiGraphWorkflow,
    label: 'ComfyUI',
  }),
});

async function executeGraphWorkflowNode(options = {}) {
  const tool = options.tool || null;
  const adapter = tool?.id ? GRAPH_WORKFLOW_ADAPTERS[String(tool.id || '').trim().toLowerCase()] || null : null;
  if (!adapter) {
    throw new Error(`${getToolLabel(tool)} does not have a graph workflow adapter in Local AI Hub yet. Choose ComfyUI for this first graph-native pipeline slice.`);
  }

  return adapter.execute(options);
}

module.exports = {
  executeGraphWorkflowNode,
};
