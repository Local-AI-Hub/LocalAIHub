const GRAPH_WORKFLOW_ADAPTER_STATUS_IDS = Object.freeze({
  PLANNED: 'planned',
  RUNNABLE: 'runnable',
});

const GRAPH_WORKFLOW_BINDING_MODE_IDS = Object.freeze({
  NODE_FIELD: 'node-field',
  NODE_OUTPUT: 'node-output',
});

const GRAPH_WORKFLOW_BOUNDARY_DIRECTION_IDS = Object.freeze({
  INPUT: 'input',
  OUTPUT: 'output',
});

const PORT_KIND_TEXT = 'text';
const PORT_KIND_IMAGE = 'image';
const PORT_KIND_VIDEO = 'video';
const DEFAULT_GRAPH_WORKFLOW_TOOL_ID = 'comfyui';
const INVOKEAI_RESERVED_GRAPH_FIELDS = new Set(['id', 'is_intermediate', 'type', 'use_cache']);

const GRAPH_WORKFLOW_TOOL_CONTRACTS = Object.freeze({
  comfyui: Object.freeze({
    adapterStatus: GRAPH_WORKFLOW_ADAPTER_STATUS_IDS.RUNNABLE,
    executionBlockedMessage: 'only ComfyUI graph workflows run inside Local AI Hub in v0.9.8.',
    inputPorts: Object.freeze([
      Object.freeze({
        bindingMode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD,
        description: 'Map the main pipeline Text port to a ComfyUI node input field when the imported workflow expects text.',
        kind: PORT_KIND_TEXT,
        label: 'Pipeline Text',
        portId: 'text',
      }),
      Object.freeze({
        bindingMode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD,
        description: 'Map the main pipeline Image port to a ComfyUI node input field when the imported workflow expects an uploaded image reference.',
        kind: PORT_KIND_IMAGE,
        label: 'Pipeline Image',
        portId: 'image',
      }),
    ]),
    limitations: 'Local AI Hub still expects you to author and export the workflow in ComfyUI itself instead of embedding the full graph editor here.',
    notes: 'ComfyUI stays graph-native in Local AI Hub. The pipeline owns typed artifact boundaries while the imported ComfyUI graph stays tool-specific inside this node.',
    outputPorts: Object.freeze([
      Object.freeze({
        bindingMode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_OUTPUT,
        description: 'Choose the ComfyUI node whose saved image should return to the main pipeline as an explicit image artifact.',
        kind: PORT_KIND_IMAGE,
        label: 'Workflow Image',
        portId: 'image',
      }),
      Object.freeze({
        bindingMode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_OUTPUT,
        description: 'Choose the ComfyUI node whose saved video should return to the main pipeline as an explicit video artifact.',
        kind: PORT_KIND_VIDEO,
        label: 'Workflow Video',
        portId: 'video',
      }),
    ]),
    supportsExecution: true,
    toolId: 'comfyui',
    workflowFormat: Object.freeze({
      id: 'comfyui-api-json',
      label: 'ComfyUI API JSON',
      placeholder: 'Paste the exported ComfyUI API workflow JSON here.',
      summary: 'Paste the API-format workflow JSON exported from ComfyUI. Local AI Hub can inspect nodes and fields from that export.',
    }),
    workflowImportSupported: true,
  }),
  invokeai: Object.freeze({
    adapterStatus: GRAPH_WORKFLOW_ADAPTER_STATUS_IDS.RUNNABLE,
    executionBlockedMessage: 'InvokeAI runs here only when Local AI Hub can read a real executable graph from the pasted definition.',
    inputPorts: Object.freeze([
      Object.freeze({
        bindingMode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD,
        defaultField: 'prompt',
        description: 'Map the main pipeline Text port to an InvokeAI workflow field such as prompt when the imported graph expects text.',
        kind: PORT_KIND_TEXT,
        label: 'Pipeline Text',
        portId: 'text',
      }),
      Object.freeze({
        bindingMode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD,
        defaultField: 'image',
        description: 'Map the main pipeline Image port to an InvokeAI image field when the imported graph expects an uploaded image asset.',
        kind: PORT_KIND_IMAGE,
        label: 'Pipeline Image',
        portId: 'image',
      }),
    ]),
    limitations: 'Local AI Hub runs the imported InvokeAI graph through InvokeAI\'s own queue API. It does not embed the full InvokeAI node editor here.',
    notes: 'InvokeAI stays graph-native in Local AI Hub. This adapter accepts real InvokeAI workflow JSON, raw InvokeAI graph JSON, or a graph/workflow bundle and submits the executable graph through InvokeAI\'s queue.',
    outputPorts: Object.freeze([
      Object.freeze({
        bindingMode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_OUTPUT,
        description: 'Choose the InvokeAI node whose image output should return to the main pipeline as an explicit image artifact.',
        kind: PORT_KIND_IMAGE,
        label: 'Workflow Image',
        portId: 'image',
      }),
    ]),
    supportsExecution: true,
    toolId: 'invokeai',
    workflowFormat: Object.freeze({
      id: 'invokeai-workflow-or-graph-json',
      label: 'InvokeAI workflow or graph JSON',
      placeholder: 'Paste saved InvokeAI workflow JSON, raw InvokeAI graph JSON, or a graph/workflow bundle here.',
      summary: 'Paste a saved InvokeAI workflow JSON export, raw InvokeAI graph JSON, or a bundle that includes a graph. Local AI Hub converts saved workflows into the executable graph shape InvokeAI\'s queue expects.',
    }),
    workflowImportSupported: true,
  }),
});

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

function normalizeToolId(value) {
  return String(value || '').trim().toLowerCase();
}

function createGraphWorkflowId() {
  return 'graph-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function createDefaultBinding(spec, direction) {
  if (!spec || typeof spec !== 'object') {
    return {};
  }

  if (direction === GRAPH_WORKFLOW_BOUNDARY_DIRECTION_IDS.INPUT && spec.bindingMode === GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD) {
    return {
      field: String(spec.defaultField || (spec.kind === PORT_KIND_TEXT ? 'text' : spec.kind === PORT_KIND_IMAGE ? 'image' : '')).trim(),
      mode: spec.bindingMode,
      nodeId: '',
    };
  }

  return {
    mode: spec.bindingMode || (direction === GRAPH_WORKFLOW_BOUNDARY_DIRECTION_IDS.OUTPUT ? GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_OUTPUT : GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD),
    nodeId: '',
  };
}

function getDefaultGraphWorkflowBindings(toolId) {
  const contract = getGraphWorkflowContract(toolId);
  return {
    inputBindings: Object.fromEntries((contract.inputPorts || []).map((spec) => [spec.portId, createDefaultBinding(spec, GRAPH_WORKFLOW_BOUNDARY_DIRECTION_IDS.INPUT)])),
    outputBindings: Object.fromEntries((contract.outputPorts || []).map((spec) => [spec.portId, createDefaultBinding(spec, GRAPH_WORKFLOW_BOUNDARY_DIRECTION_IDS.OUTPUT)])),
    workflowFormat: contract.workflowFormat?.id || '',
  };
}

function buildGenericGraphWorkflowContract(toolId) {
  return {
    adapterStatus: GRAPH_WORKFLOW_ADAPTER_STATUS_IDS.PLANNED,
    executionBlockedMessage: 'Local AI Hub does not have a runnable graph-workflow adapter for this tool yet.',
    inputPorts: [
      {
        bindingMode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD,
        description: 'A future graph adapter can map pipeline text into the selected tool here.',
        kind: PORT_KIND_TEXT,
        label: 'Pipeline Text',
        portId: 'text',
      },
      {
        bindingMode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD,
        description: 'A future graph adapter can map pipeline images into the selected tool here.',
        kind: PORT_KIND_IMAGE,
        label: 'Pipeline Image',
        portId: 'image',
      },
    ],
    limitations: 'This graph-native tool is not wired into Local AI Hub yet.',
    notes: 'Graph-native tools keep explicit pipeline boundaries and stay distinct from model-step nodes.',
    outputPorts: [
      {
        bindingMode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_OUTPUT,
        description: 'A future graph adapter can route an image back into the main pipeline here.',
        kind: PORT_KIND_IMAGE,
        label: 'Workflow Image',
        portId: 'image',
      },
    ],
    supportsExecution: false,
    toolId: normalizeToolId(toolId) || DEFAULT_GRAPH_WORKFLOW_TOOL_ID,
    workflowFormat: {
      id: 'graph-workflow-definition',
      label: 'Graph workflow definition',
      placeholder: 'Graph workflow import is not wired into this Local AI Hub build yet.',
      summary: 'This tool is modeled as graph-native, but its workflow import contract is still pending.',
    },
    workflowImportSupported: false,
  };
}

function getGraphWorkflowContract(toolId) {
  const normalizedToolId = normalizeToolId(toolId) || DEFAULT_GRAPH_WORKFLOW_TOOL_ID;
  return cloneValue(GRAPH_WORKFLOW_TOOL_CONTRACTS[normalizedToolId] || buildGenericGraphWorkflowContract(normalizedToolId));
}

function getGraphWorkflowBoundarySpecs(toolId, direction) {
  const contract = getGraphWorkflowContract(toolId);
  return direction === GRAPH_WORKFLOW_BOUNDARY_DIRECTION_IDS.OUTPUT
    ? contract.outputPorts || []
    : contract.inputPorts || [];
}

function getGraphWorkflowBoundarySpec(toolId, direction, portId) {
  return getGraphWorkflowBoundarySpecs(toolId, direction).find((entry) => entry.portId === portId) || null;
}

function sortGraphWorkflowNodeEntries(entries = []) {
  return [...entries].sort((left, right) => {
    const leftNumber = Number(left.id);
    const rightNumber = Number(right.id);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber;
    }

    return String(left.id || '').localeCompare(String(right.id || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function prioritizeFields(inputFields = [], matcher) {
  const primary = [];
  const secondary = [];

  for (const field of inputFields) {
    if (matcher.test(field)) {
      primary.push(field);
    } else {
      secondary.push(field);
    }
  }

  return [...primary, ...secondary];
}

function buildComfyUiNodeEntry(id, entry) {
  const inputFields = Object.keys(entry.inputs || {}).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  const classType = String(entry.class_type || entry.classType || '').trim();
  return {
    boundaryFieldOptions: {
      image: prioritizeFields(inputFields, /(image|mask|file|path)/i),
      text: prioritizeFields(inputFields, /(text|prompt|string|value|caption|label)/i),
    },
    classType,
    id: String(id || '').trim(),
    imageOutputCandidate: /^(PreviewImage|SaveImage|SaveAnimatedWEBP)$/i.test(classType),
    inputFields,
    videoOutputCandidate: /^(SaveVideo|VHS_VideoCombine|VideoCombine|SaveAnimatedWEBP)$/i.test(classType),
  };
}

function parseComfyUiWorkflowDefinition(workflowText) {
  const raw = String(workflowText || '').trim();
  if (!raw) {
    return {
      message: 'Paste the exported ComfyUI API workflow JSON to configure this graph step.',
      nodeEntries: [],
      ok: false,
      workflow: null,
    };
  }

  let workflow = null;
  try {
    workflow = JSON.parse(raw);
  } catch {
    return {
      message: 'Local AI Hub could not read that ComfyUI API workflow JSON. Paste the exported API-format JSON for this graph step.',
      nodeEntries: [],
      ok: false,
      workflow: null,
    };
  }

  if (!workflow || Array.isArray(workflow) || typeof workflow !== 'object') {
    return {
      message: 'This graph workflow step needs a ComfyUI API workflow JSON object keyed by node ID.',
      nodeEntries: [],
      ok: false,
      workflow: null,
    };
  }

  const nodeEntries = sortGraphWorkflowNodeEntries(
    Object.entries(workflow)
      .filter(([, entry]) => entry && typeof entry === 'object')
      .map(([id, entry]) => buildComfyUiNodeEntry(id, entry))
      .filter((entry) => entry.id),
  );

  if (!nodeEntries.length) {
    return {
      message: 'This ComfyUI API workflow JSON does not contain any workflow nodes yet.',
      nodeEntries: [],
      ok: false,
      workflow,
    };
  }

  const imageOutputNodeOptions = nodeEntries.some((entry) => entry.imageOutputCandidate)
    ? nodeEntries.filter((entry) => entry.imageOutputCandidate)
    : nodeEntries;
  const videoOutputNodeOptions = nodeEntries.some((entry) => entry.videoOutputCandidate)
    ? nodeEntries.filter((entry) => entry.videoOutputCandidate)
    : nodeEntries;

  return {
    imageOutputNodeOptions,
    videoOutputNodeOptions,
    message: 'Loaded ' + nodeEntries.length + ' workflow nodes from ComfyUI API JSON.',
    nodeEntries,
    ok: true,
    workflow,
  };
}

function parseJsonObject(rawValue) {
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  }

  return isRecord(rawValue) ? cloneValue(rawValue) : null;
}

function buildInvokeAiGraphNodeFromWorkflowNode(node) {
  const graphNode = {
    id: String(node?.id || '').trim(),
    is_intermediate: Boolean(node?.data?.isIntermediate),
    type: String(node?.data?.type || '').trim(),
    use_cache: node?.data?.useCache !== undefined ? Boolean(node.data.useCache) : true,
  };

  for (const [fieldName, input] of Object.entries(node?.data?.inputs || {})) {
    if (!isRecord(input) || !Object.prototype.hasOwnProperty.call(input, 'value')) {
      continue;
    }

    graphNode[fieldName] = cloneValue(input.value);
  }

  return graphNode;
}

function buildInvokeAiGraphFromWorkflow(workflowDocument) {
  const workflowNodes = Array.isArray(workflowDocument?.nodes) ? workflowDocument.nodes : [];
  const graphNodes = {};

  for (const node of workflowNodes) {
    const nodeId = String(node?.id || '').trim();
    const nodeType = String(node?.data?.type || '').trim();
    if (!nodeId || node?.type !== 'invocation' || !nodeType) {
      continue;
    }

    graphNodes[nodeId] = buildInvokeAiGraphNodeFromWorkflowNode(node);
  }

  const graphEdges = (Array.isArray(workflowDocument?.edges) ? workflowDocument.edges : [])
    .filter((edge) => String(edge?.source || '').trim() && String(edge?.target || '').trim() && String(edge?.sourceHandle || '').trim() && String(edge?.targetHandle || '').trim())
    .map((edge) => ({
      source: {
        field: String(edge.sourceHandle || '').trim(),
        node_id: String(edge.source || '').trim(),
      },
      destination: {
        field: String(edge.targetHandle || '').trim(),
        node_id: String(edge.target || '').trim(),
      },
    }));

  for (const edge of graphEdges) {
    if (isRecord(graphNodes[edge.destination.node_id])) {
      delete graphNodes[edge.destination.node_id][edge.destination.field];
    }
  }

  return {
    edges: graphEdges,
    id: String(workflowDocument?.id || '').trim() || createGraphWorkflowId(),
    nodes: graphNodes,
  };
}

function getInvokeAiGraphInputFields(graphNode) {
  return Object.keys(graphNode || {})
    .filter((fieldName) => !INVOKEAI_RESERVED_GRAPH_FIELDS.has(fieldName))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

function buildInvokeAiNormalizedNode(nodeId, inputFields = [], type = '') {
  return {
    classType: String(type || '').trim(),
    id: String(nodeId || '').trim(),
    inputs: Object.fromEntries(inputFields.map((fieldName) => [fieldName, null])),
  };
}

function buildInvokeAiNodeEntry(nodeId, inputFields = [], type = '', outputCandidate = false) {
  return {
    boundaryFieldOptions: {
      image: prioritizeFields(inputFields, /(image|mask|control|reference|source|init)/i),
      text: prioritizeFields(inputFields, /(text|prompt|string|caption|label|positive|negative)/i),
    },
    classType: String(type || '').trim(),
    id: String(nodeId || '').trim(),
    imageOutputCandidate: Boolean(outputCandidate),
    inputFields: [...inputFields],
  };
}

function buildInvokeAiNodeOutputCandidate(nodeType, outgoingEdgeCount, graphNode, workflowNode) {
  if (workflowNode?.data?.isIntermediate === false) {
    return true;
  }

  if (graphNode?.is_intermediate === false) {
    return true;
  }

  const normalizedType = String(nodeType || '').trim();
  const inputFields = getInvokeAiGraphInputFields(graphNode);
  return outgoingEdgeCount === 0 && (
    /(decode|image|output|save|l2i)$/i.test(normalizedType)
    || inputFields.some((fieldName) => /(board|metadata|latents|vae)/i.test(fieldName))
  );
}

function buildInvokeAiDefinition({ executionGraph, importSource, workflowDocument = null }) {
  const graphNodes = isRecord(executionGraph?.nodes) ? executionGraph.nodes : null;
  if (!graphNodes || !Object.keys(graphNodes).length) {
    return {
      message: 'This InvokeAI definition does not contain any executable graph nodes yet.',
      nodeEntries: [],
      ok: false,
      workflow: null,
    };
  }

  const workflowNodesById = Array.isArray(workflowDocument?.nodes)
    ? Object.fromEntries(
        workflowDocument.nodes
          .filter((node) => String(node?.id || '').trim())
          .map((node) => [String(node.id).trim(), node]),
      )
    : {};
  const outgoingEdgeCounts = Object.create(null);
  for (const edge of Array.isArray(executionGraph?.edges) ? executionGraph.edges : []) {
    const sourceNodeId = String(edge?.source?.node_id || '').trim();
    if (!sourceNodeId) {
      continue;
    }

    outgoingEdgeCounts[sourceNodeId] = Number(outgoingEdgeCounts[sourceNodeId] || 0) + 1;
  }

  const normalizedWorkflow = {};
  const nodeEntries = sortGraphWorkflowNodeEntries(
    Object.entries(graphNodes)
      .filter(([, node]) => isRecord(node))
      .map(([nodeId, graphNode]) => {
        const workflowNode = workflowNodesById[String(nodeId || '').trim()] || null;
        const workflowInputFields = Object.keys(workflowNode?.data?.inputs || {}).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
        const inputFields = workflowInputFields.length ? workflowInputFields : getInvokeAiGraphInputFields(graphNode);
        const nodeType = String(workflowNode?.data?.type || graphNode?.type || '').trim();
        const outputCandidate = buildInvokeAiNodeOutputCandidate(nodeType, Number(outgoingEdgeCounts[nodeId] || 0), graphNode, workflowNode);
        normalizedWorkflow[nodeId] = buildInvokeAiNormalizedNode(nodeId, inputFields, nodeType);
        return buildInvokeAiNodeEntry(nodeId, inputFields, nodeType, outputCandidate);
      })
      .filter((entry) => entry.id),
  );

  if (!nodeEntries.length) {
    return {
      message: 'This InvokeAI definition does not contain any runnable graph nodes yet.',
      nodeEntries: [],
      ok: false,
      workflow: null,
    };
  }

  return {
    executionGraph,
    imageOutputNodeOptions: nodeEntries.some((entry) => entry.imageOutputCandidate)
      ? nodeEntries.filter((entry) => entry.imageOutputCandidate)
      : nodeEntries,
    importSource,
    invokeWorkflow: workflowDocument,
    message: 'Loaded ' + nodeEntries.length + ' workflow nodes from InvokeAI ' + (importSource === 'graph' ? 'graph JSON.' : importSource === 'bundle' ? 'workflow bundle JSON.' : 'workflow JSON.'),
    nodeEntries,
    ok: true,
    workflow: normalizedWorkflow,
  };
}

function parseInvokeAiWorkflowDefinition(workflowText) {
  const raw = String(workflowText || '').trim();
  if (!raw) {
    return {
      message: 'Paste saved InvokeAI workflow JSON, raw InvokeAI graph JSON, or a graph/workflow bundle before running this graph workflow step.',
      nodeEntries: [],
      ok: false,
      workflow: null,
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      message: 'Local AI Hub could not read that InvokeAI JSON. Paste saved workflow JSON, raw graph JSON, or a bundle that includes a graph.',
      nodeEntries: [],
      ok: false,
      workflow: null,
    };
  }

  if (!isRecord(parsed)) {
    return {
      message: 'This graph workflow step needs an InvokeAI JSON object, not a list or plain text.',
      nodeEntries: [],
      ok: false,
      workflow: null,
    };
  }

  const bundleGraph = parseJsonObject(parsed.graph);
  const bundleWorkflow = parseJsonObject(parsed.workflow);
  if (bundleGraph && isRecord(bundleGraph.nodes) && Array.isArray(bundleGraph.edges)) {
    return buildInvokeAiDefinition({
      executionGraph: bundleGraph,
      importSource: bundleWorkflow ? 'bundle' : 'graph',
      workflowDocument: bundleWorkflow,
    });
  }

  if (isRecord(parsed.nodes) && Array.isArray(parsed.edges)) {
    return buildInvokeAiDefinition({
      executionGraph: parsed,
      importSource: 'graph',
      workflowDocument: bundleWorkflow,
    });
  }

  if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
    return buildInvokeAiDefinition({
      executionGraph: buildInvokeAiGraphFromWorkflow(parsed),
      importSource: 'workflow',
      workflowDocument: parsed,
    });
  }

  return {
    message: 'Local AI Hub could not find an executable InvokeAI graph in that JSON. Paste saved InvokeAI workflow JSON, raw graph JSON, or a bundle that includes a graph.',
    nodeEntries: [],
    ok: false,
    workflow: null,
  };
}

function parseGraphWorkflowDefinitionText(toolId, workflowText) {
  const contract = getGraphWorkflowContract(toolId);
  if (contract.toolId === 'comfyui') {
    return {
      ...parseComfyUiWorkflowDefinition(workflowText),
      contract,
      toolId: contract.toolId,
      workflowFormat: contract.workflowFormat,
    };
  }

  if (contract.toolId === 'invokeai') {
    return {
      ...parseInvokeAiWorkflowDefinition(workflowText),
      contract,
      toolId: contract.toolId,
      workflowFormat: contract.workflowFormat,
    };
  }

  const raw = String(workflowText || '').trim();
  return {
    contract,
    imageOutputNodeOptions: [],
    videoOutputNodeOptions: [],
    message: raw
      ? contract.executionBlockedMessage
      : contract.workflowFormat?.summary || contract.executionBlockedMessage,
    nodeEntries: [],
    ok: false,
    toolId: contract.toolId,
    workflow: null,
    workflowFormat: contract.workflowFormat,
  };
}

function getGraphWorkflowNodeEntry(workflowOrDefinition, nodeId) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    return null;
  }

  const workflow = workflowOrDefinition && typeof workflowOrDefinition === 'object' && workflowOrDefinition.workflow && typeof workflowOrDefinition.workflow === 'object'
    ? workflowOrDefinition.workflow
    : workflowOrDefinition && typeof workflowOrDefinition === 'object' && workflowOrDefinition.nodes && typeof workflowOrDefinition.nodes === 'object' && !Array.isArray(workflowOrDefinition.nodes)
      ? workflowOrDefinition.nodes
      : workflowOrDefinition;
  return workflow && typeof workflow === 'object' ? workflow[normalizedNodeId] || null : null;
}

function getGraphWorkflowFieldOptions(definition, nodeId, portId = '') {
  if (!definition?.ok) {
    return [];
  }

  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    return [];
  }

  const nodeEntry = (definition.nodeEntries || []).find((entry) => entry.id === normalizedNodeId) || null;
  if (!nodeEntry) {
    return [];
  }

  const normalizedPortId = String(portId || '').trim();
  if (normalizedPortId && Array.isArray(nodeEntry.boundaryFieldOptions?.[normalizedPortId]) && nodeEntry.boundaryFieldOptions[normalizedPortId].length) {
    return [...nodeEntry.boundaryFieldOptions[normalizedPortId]];
  }

  return [...(nodeEntry.inputFields || [])];
}

function getGraphWorkflowOutputNodeOptions(definition, portId = 'image') {
  if (!definition?.ok) {
    return [];
  }

  const normalizedPortId = String(portId || '').trim();
  if (normalizedPortId === 'image' && Array.isArray(definition.imageOutputNodeOptions) && definition.imageOutputNodeOptions.length) {
    return [...definition.imageOutputNodeOptions];
  }

  if (normalizedPortId === 'video' && Array.isArray(definition.videoOutputNodeOptions) && definition.videoOutputNodeOptions.length) {
    return [...definition.videoOutputNodeOptions];
  }

  return [...(definition.nodeEntries || [])];
}

function getGraphWorkflowBinding(node, direction, portId) {
  const toolId = node?.config?.toolId || DEFAULT_GRAPH_WORKFLOW_TOOL_ID;
  const spec = getGraphWorkflowBoundarySpec(toolId, direction, portId);
  const defaults = createDefaultBinding(spec, direction);
  const collection = direction === GRAPH_WORKFLOW_BOUNDARY_DIRECTION_IDS.OUTPUT
    ? node?.config?.outputBindings
    : node?.config?.inputBindings;
  const current = collection?.[portId];
  return current && typeof current === 'object'
    ? {
        ...defaults,
        ...cloneValue(current),
      }
    : defaults;
}

function getGraphWorkflowInputBinding(node, portId) {
  return getGraphWorkflowBinding(node, GRAPH_WORKFLOW_BOUNDARY_DIRECTION_IDS.INPUT, portId);
}

function getGraphWorkflowOutputBinding(node, portId) {
  return getGraphWorkflowBinding(node, GRAPH_WORKFLOW_BOUNDARY_DIRECTION_IDS.OUTPUT, portId);
}

module.exports = {
  DEFAULT_GRAPH_WORKFLOW_TOOL_ID,
  GRAPH_WORKFLOW_ADAPTER_STATUS_IDS,
  GRAPH_WORKFLOW_BINDING_MODE_IDS,
  GRAPH_WORKFLOW_BOUNDARY_DIRECTION_IDS,
  getDefaultGraphWorkflowBindings,
  getGraphWorkflowBinding,
  getGraphWorkflowBoundarySpec,
  getGraphWorkflowBoundarySpecs,
  getGraphWorkflowContract,
  getGraphWorkflowFieldOptions,
  getGraphWorkflowInputBinding,
  getGraphWorkflowNodeEntry,
  getGraphWorkflowOutputBinding,
  getGraphWorkflowOutputNodeOptions,
  parseGraphWorkflowDefinitionText,
};

module.exports.default = module.exports;


