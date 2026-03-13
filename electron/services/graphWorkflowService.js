const fs = require('fs-extra');
const path = require('path');
const { randomUUID } = require('crypto');

const { createLogger } = require('./logService');
const { saveBufferArtifact, summarizeArtifact } = require('./pipelineArtifactService');
const {
  getGraphWorkflowContract,
  getGraphWorkflowInputBinding,
  getGraphWorkflowNodeEntry,
  getGraphWorkflowOutputBinding,
  parseGraphWorkflowDefinitionText,
} = require('../shared/graphWorkflowContracts.cjs');
const { PORT_KIND_IMAGE, PORT_KIND_TEXT } = require('../shared/pipelineSchema.cjs');

const COMFYUI_POLL_INTERVAL_MS = 1500;
const COMFYUI_TIMEOUT_MS = 5 * 60 * 1000;
const INVOKEAI_POLL_INTERVAL_MS = 1500;
const INVOKEAI_TIMEOUT_MS = 10 * 60 * 1000;
const INVOKEAI_DEFAULT_QUEUE_ID = 'default';

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

function parseGraphWorkflowText(toolId, workflowText) {
  const parsedWorkflow = parseGraphWorkflowDefinitionText(toolId, workflowText);
  if (!parsedWorkflow.ok) {
    throw new Error(parsedWorkflow.message);
  }

  return parsedWorkflow.executionGraph || parsedWorkflow.workflow;
}

function getWorkflowNodeEntry(workflow, nodeId, label) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    throw new Error(`Choose a workflow node for the ${label} mapping.`);
  }

  const entry = getGraphWorkflowNodeEntry(workflow, normalizedNodeId);
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

function buildInvokeAiBatchField(nodeId, field, value, label) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    throw new Error(`Choose a workflow node for the ${label} mapping.`);
  }

  const normalizedField = String(field || '').trim();
  if (!normalizedField) {
    throw new Error(`Choose a workflow field for the ${label} mapping.`);
  }

  return {
    field_name: normalizedField,
    items: [value],
    node_path: normalizedNodeId,
  };
}

async function uploadInvokeAiImage(tool, artifact) {
  const filePath = path.resolve(String(artifact?.filePath || '').trim());
  if (!filePath || !(await fs.pathExists(filePath))) {
    throw new Error('The image input for this graph workflow step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  const mimeType = String(artifact?.mimeType || 'image/png').trim() || 'image/png';
  const fileName = String(artifact?.fileName || path.basename(filePath)).trim() || path.basename(filePath);
  const formData = new FormData();
  formData.append('file', new Blob([await fs.readFile(filePath)], { type: mimeType }), fileName);

  const uploaded = await requestGraphWorkflowJson(tool, '/v1/images/upload?image_category=user&is_intermediate=false', {
    body: formData,
    contentType: null,
    method: 'POST',
  }, 'upload the graph workflow image input');

  const imageName = String(uploaded?.image_name || uploaded?.imageName || '').trim();
  if (!imageName) {
    throw new Error('InvokeAI accepted the uploaded image, but it did not return a usable image name for the graph input.');
  }

  return {
    fileName,
    imageName,
    response: uploaded,
  };
}

async function enqueueInvokeAiBatch(tool, batch) {
  const payload = await requestGraphWorkflowJson(tool, `/v1/queue/${encodeURIComponent(INVOKEAI_DEFAULT_QUEUE_ID)}/enqueue_batch`, {
    body: {
      batch,
      prepend: false,
    },
    method: 'POST',
  }, 'submit the InvokeAI graph workflow');

  const itemIds = Array.isArray(payload?.item_ids)
    ? payload.item_ids.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  if (!itemIds.length) {
    throw new Error('InvokeAI accepted the graph workflow, but it did not return any queue item IDs to track.');
  }

  const batchId = String(payload?.batch?.batch_id || batch?.batch_id || '').trim();
  if (!batchId) {
    throw new Error('InvokeAI accepted the graph workflow, but it did not return a batch ID to track.');
  }

  return {
    batchId,
    itemId: itemIds[0],
    itemIds,
    queueId: INVOKEAI_DEFAULT_QUEUE_ID,
    response: payload,
  };
}

function normalizeInvokeAiQueueItem(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.session && typeof payload.session === 'string') {
    try {
      return {
        ...payload,
        session: JSON.parse(payload.session),
      };
    } catch {
      return payload;
    }
  }

  return payload;
}

function buildInvokeAiQueueFailureMessage(queueItem) {
  const directMessage = String(queueItem?.error_message || queueItem?.error || '').trim();
  if (directMessage) {
    return directMessage;
  }

  return 'InvokeAI stopped before it finished the graph workflow.';
}

function buildInvokeAiProgressMessage(queueItem, batchStatus) {
  const executedCount = Array.isArray(queueItem?.session?.executed_history) ? queueItem.session.executed_history.length : 0;
  const totalNodeCount = queueItem?.session?.graph?.nodes && typeof queueItem.session.graph.nodes === 'object'
    ? Object.keys(queueItem.session.graph.nodes).length
    : 0;
  if (executedCount > 0 && totalNodeCount > 0) {
    return `InvokeAI is still processing the graph workflow (${executedCount} of ${totalNodeCount} graph nodes completed).`;
  }

  if (Number(batchStatus?.in_progress || 0) > 0 || String(queueItem?.status || '').trim().toLowerCase() === 'in_progress') {
    return 'InvokeAI is still processing the queued graph workflow.';
  }

  return 'InvokeAI has the graph workflow queued and Local AI Hub is still waiting for the final image output.';
}

async function getInvokeAiQueueItem(tool, queueId, itemId) {
  const payload = await requestGraphWorkflowJson(tool, `/v1/queue/${encodeURIComponent(queueId)}/i/${encodeURIComponent(String(itemId))}`, {
    method: 'GET',
  }, 'check the InvokeAI queue item');
  return normalizeInvokeAiQueueItem(payload);
}

async function getInvokeAiBatchStatus(tool, queueId, batchId) {
  return requestGraphWorkflowJson(tool, `/v1/queue/${encodeURIComponent(queueId)}/b/${encodeURIComponent(batchId)}/status`, {
    method: 'GET',
  }, 'check the InvokeAI batch status');
}

async function waitForInvokeAiWorkflow(tool, queueId, batchId, itemId, reportProgress, nodeLabel) {
  const startedAt = Date.now();
  let pollCount = 0;

  while (Date.now() - startedAt < INVOKEAI_TIMEOUT_MS) {
    const [queueItem, batchStatus] = await Promise.all([
      getInvokeAiQueueItem(tool, queueId, itemId),
      getInvokeAiBatchStatus(tool, queueId, batchId).catch(() => null),
    ]);

    const status = String(queueItem?.status || '').trim().toLowerCase();
    if (status === 'failed') {
      throw new Error(buildInvokeAiQueueFailureMessage(queueItem));
    }

    if (status === 'canceled') {
      throw new Error('InvokeAI canceled the graph workflow before it finished.');
    }

    if (status === 'completed') {
      return {
        batchStatus,
        queueItem,
      };
    }

    pollCount += 1;
    if (pollCount % 4 === 0) {
      reportProgress?.(
        buildInvokeAiProgressMessage(queueItem, batchStatus),
        `Running ${nodeLabel} with ${getToolLabel(tool)}...`,
      );
    }

    await sleep(INVOKEAI_POLL_INTERVAL_MS);
  }

  throw new Error(`${getToolLabel(tool)} is taking longer than expected to finish this graph workflow step. Open InvokeAI to inspect its queue, then try again.`);
}

function collectInvokeAiPreparedNodeIds(session, outputNodeId) {
  const directPrepared = session?.source_prepared_mapping?.[outputNodeId];
  if (Array.isArray(directPrepared)) {
    return directPrepared.map((value) => String(value || '').trim()).filter(Boolean);
  }

  if (directPrepared && typeof directPrepared === 'object') {
    return Object.values(directPrepared).map((value) => String(value || '').trim()).filter(Boolean);
  }

  return [];
}

function collectInvokeAiImageNames(value, results = [], seen = new Set()) {
  if (value === null || value === undefined) {
    return results;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectInvokeAiImageNames(entry, results, seen);
    }
    return results;
  }

  if (typeof value !== 'object') {
    return results;
  }

  if (seen.has(value)) {
    return results;
  }
  seen.add(value);

  const directImageName = String(value.image_name || '').trim();
  if (directImageName) {
    results.push(directImageName);
  }

  if (value.image && typeof value.image === 'object') {
    collectInvokeAiImageNames(value.image, results, seen);
  }

  for (const entry of Object.values(value)) {
    if (entry && typeof entry === 'object') {
      collectInvokeAiImageNames(entry, results, seen);
    }
  }

  return results;
}

function getInvokeAiOutputImageName(queueItem, outputNodeId) {
  const session = queueItem?.session || null;
  const preparedNodeIds = collectInvokeAiPreparedNodeIds(session, outputNodeId);
  const candidateNodeIds = [...new Set([String(outputNodeId || '').trim(), ...preparedNodeIds].filter(Boolean))];
  const imageNames = [];

  for (const nodeId of candidateNodeIds) {
    const result = session?.results?.[nodeId];
    if (!result || typeof result !== 'object') {
      continue;
    }

    collectInvokeAiImageNames(result, imageNames);
  }

  const uniqueImageNames = [...new Set(imageNames.map((value) => String(value || '').trim()).filter(Boolean))];
  if (uniqueImageNames.length > 1) {
    throw new Error(`The selected output node ${outputNodeId} produced multiple images. Choose a single final image node for this pipeline step.`);
  }

  if (!uniqueImageNames.length) {
    throw new Error(`The selected output node ${outputNodeId} finished in InvokeAI, but Local AI Hub could not find an image result for it. Choose a final image node such as a decode or image-output node.`);
  }

  return uniqueImageNames[0];
}

async function downloadInvokeAiImage(tool, imageName) {
  return requestGraphWorkflowBuffer(tool, `/v1/images/i/${encodeURIComponent(imageName)}/full`, {
    method: 'GET',
  }, 'download the InvokeAI graph workflow image output');
}

async function executeComfyUiGraphWorkflow({ inputArtifacts = {}, node, reportProgress, runDirectories, tool }) {
  const nodeLabel = String(node?.label || 'Graph Workflow').trim() || 'Graph Workflow';
  const workflow = parseGraphWorkflowText(tool?.id || node?.config?.toolId, node?.config?.workflowText);
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

async function executeInvokeAiGraphWorkflow({ inputArtifacts = {}, node, reportProgress, runDirectories, tool }) {
  const nodeLabel = String(node?.label || 'Graph Workflow').trim() || 'Graph Workflow';
  const parsedDefinition = parseGraphWorkflowDefinitionText(tool?.id || node?.config?.toolId, node?.config?.workflowText);
  if (!parsedDefinition.ok || !parsedDefinition.executionGraph) {
    throw new Error(parsedDefinition.message || 'Local AI Hub could not read an executable InvokeAI graph from this workflow definition.');
  }

  const executionGraph = JSON.parse(JSON.stringify(parsedDefinition.executionGraph));
  const textArtifact = getGraphInputArtifact(inputArtifacts, 'text');
  const imageArtifact = getGraphInputArtifact(inputArtifacts, 'image');
  const textBinding = getGraphWorkflowInputBinding(node, 'text');
  const imageBinding = getGraphWorkflowInputBinding(node, 'image');
  const outputBinding = getGraphWorkflowOutputBinding(node, 'image');
  const outputNodeId = String(outputBinding?.nodeId || '').trim();

  getGraphWorkflowNodeEntry(parsedDefinition.workflow, outputNodeId);

  const batchData = [];
  if (textArtifact) {
    const textValue = String(textArtifact.text || '').trim();
    if (!textValue) {
      throw new Error('The connected text input for this graph workflow step is empty.');
    }

    batchData.push([
      buildInvokeAiBatchField(textBinding.nodeId, textBinding.field, textValue, 'text input'),
    ]);
  }

  if (imageArtifact) {
    reportProgress?.(
      `Uploading the connected image to ${getToolLabel(tool)} for this graph workflow.`,
      `Running ${nodeLabel} with ${getToolLabel(tool)}...`,
    );
    const uploadedImage = await uploadInvokeAiImage(tool, imageArtifact);
    batchData.push([
      buildInvokeAiBatchField(imageBinding.nodeId, imageBinding.field, { image_name: uploadedImage.imageName }, 'image input'),
    ]);
  }

  const batch = {
    batch_id: randomUUID(),
    destination: 'local-ai-hub-pipeline',
    graph: executionGraph,
    origin: 'local-ai-hub-pipeline',
    runs: 1,
    ...(batchData.length ? { data: batchData } : {}),
    ...(parsedDefinition.invokeWorkflow ? { workflow: parsedDefinition.invokeWorkflow } : {}),
  };

  reportProgress?.(
    `Submitting the graph workflow to ${getToolLabel(tool)}.`,
    `Running ${nodeLabel} with ${getToolLabel(tool)}...`,
  );
  const enqueued = await enqueueInvokeAiBatch(tool, batch);

  reportProgress?.(
    `${getToolLabel(tool)} accepted the graph workflow and added it to its queue.`,
    `Running ${nodeLabel} with ${getToolLabel(tool)}...`,
  );
  const completedRun = await waitForInvokeAiWorkflow(tool, enqueued.queueId, enqueued.batchId, enqueued.itemId, reportProgress, nodeLabel);
  const imageName = getInvokeAiOutputImageName(completedRun.queueItem, outputNodeId);

  reportProgress?.(
    `Downloading the graph workflow image output from ${getToolLabel(tool)}.`,
    `Running ${nodeLabel} with ${getToolLabel(tool)}...`,
  );
  const imageBuffer = await downloadInvokeAiImage(tool, imageName);
  const artifact = await saveBufferArtifact(runDirectories, imageBuffer, {
    baseName: `${nodeLabel}-${Date.now()}`,
    displayName: nodeLabel,
    extension: buildOutputFileExtension(imageName),
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
  invokeai: Object.freeze({
    execute: executeInvokeAiGraphWorkflow,
    label: 'InvokeAI',
  }),
});

async function executeGraphWorkflowNode(options = {}) {
  const tool = options.tool || null;
  const contract = getGraphWorkflowContract(tool?.id || options?.node?.config?.toolId);
  const adapter = tool?.id ? GRAPH_WORKFLOW_ADAPTERS[String(tool.id || '').trim().toLowerCase()] || null : null;
  if (!contract?.supportsExecution || !adapter) {
    throw new Error(contract?.executionBlockedMessage || `${getToolLabel(tool)} does not have a graph workflow adapter in Local AI Hub yet.`);
  }

  return adapter.execute(options);
}

module.exports = {
  executeGraphWorkflowNode,
};
