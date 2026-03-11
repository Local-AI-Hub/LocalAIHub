const PIPELINE_SCHEMA_VERSION = 2;
const DEFAULT_POSITION_X = 120;
const DEFAULT_POSITION_Y = 120;
const PORT_KIND_TEXT = 'text';
const PORT_KIND_IMAGE = 'image';
const PORT_KIND_AUDIO = 'audio';
const PORT_KIND_VIDEO = 'video';
const PORT_KIND_FILE = 'file';
const PORT_KIND_ANY = 'any';
const PORT_KIND_PASSTHROUGH = 'passthrough';
const PORT_KIND_AUDIO_FILE = PORT_KIND_AUDIO;
const SUPPORTED_PORT_KINDS = Object.freeze([
  PORT_KIND_TEXT,
  PORT_KIND_IMAGE,
  PORT_KIND_AUDIO,
  PORT_KIND_VIDEO,
  PORT_KIND_FILE,
]);
const PIPELINE_PORT_KIND_LABELS = Object.freeze({
  [PORT_KIND_TEXT]: 'Text',
  [PORT_KIND_IMAGE]: 'Image',
  [PORT_KIND_AUDIO]: 'Audio',
  [PORT_KIND_VIDEO]: 'Video',
  [PORT_KIND_FILE]: 'File',
});
const IMAGE_WORKFLOW_TOOL_IDS = Object.freeze(['automatic1111', 'forge']);

const WHISPER_MODELS = [
  { id: 'tiny', label: 'Tiny' },
  { id: 'base', label: 'Base' },
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large-v3', label: 'Large v3' },
];

const PIPELINE_NODE_TYPES = Object.freeze({
  textInput: Object.freeze({
    type: 'textInput',
    label: 'Text Input',
    category: 'Inputs',
    description: 'Adds plain text to a workflow run.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'text',
        kind: PORT_KIND_TEXT,
        label: 'Text',
      },
    ],
    configDefaults: {
      text: '',
    },
  }),
  imageInput: Object.freeze({
    type: 'imageInput',
    label: 'Image File',
    category: 'Inputs',
    description: 'Supplies an image file to later nodes.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'image',
        kind: PORT_KIND_IMAGE,
        label: 'Image',
      },
    ],
    configDefaults: {
      filePath: '',
    },
  }),
  audioInput: Object.freeze({
    type: 'audioInput',
    label: 'Audio File',
    category: 'Inputs',
    description: 'Supplies an audio file path to later nodes.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'audio',
        kind: PORT_KIND_AUDIO,
        label: 'Audio',
      },
    ],
    configDefaults: {
      filePath: '',
    },
  }),
  videoInput: Object.freeze({
    type: 'videoInput',
    label: 'Video File',
    category: 'Inputs',
    description: 'Supplies a video file to later nodes.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'video',
        kind: PORT_KIND_VIDEO,
        label: 'Video',
      },
    ],
    configDefaults: {
      filePath: '',
    },
  }),
  fileInput: Object.freeze({
    type: 'fileInput',
    label: 'File Input',
    category: 'Inputs',
    description: 'Passes a general file or artifact reference into the workflow.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'file',
        kind: PORT_KIND_FILE,
        label: 'File',
      },
    ],
    configDefaults: {
      filePath: '',
    },
  }),
  llmPrompt: Object.freeze({
    type: 'llmPrompt',
    label: 'LLM Prompt',
    category: 'AI Steps',
    description: 'Sends text to a cloud provider or Ollama and returns text.',
    inputPorts: [
      {
        id: 'prompt',
        kind: PORT_KIND_TEXT,
        label: 'Prompt',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'text',
        kind: PORT_KIND_TEXT,
        label: 'Text',
      },
    ],
    configDefaults: {
      executionMode: 'cloud',
      providerId: '',
      model: '',
      instruction: '',
      systemPrompt: '',
    },
    supportedExecutionModes: [
      {
        id: 'cloud',
        label: 'Cloud provider',
      },
      {
        id: 'ollama',
        label: 'Ollama (local)',
        requiredToolId: 'ollama',
      },
    ],
  }),
  whisperTranscribe: Object.freeze({
    type: 'whisperTranscribe',
    label: 'Whisper Transcribe',
    category: 'AI Steps',
    description: 'Runs the installed local Whisper transcription flow.',
    inputPorts: [
      {
        id: 'audio',
        kind: PORT_KIND_AUDIO,
        label: 'Audio',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'text',
        kind: PORT_KIND_TEXT,
        label: 'Transcript',
      },
    ],
    configDefaults: {
      model: 'base',
    },
    requiredToolId: 'whisper',
  }),
  imageAnalyze: Object.freeze({
    type: 'imageAnalyze',
    label: 'Image Analysis',
    category: 'AI Steps',
    description: 'Uses Automatic1111 or Forge to describe an incoming image.',
    inputPorts: [
      {
        id: 'image',
        kind: PORT_KIND_IMAGE,
        label: 'Image',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'text',
        kind: PORT_KIND_TEXT,
        label: 'Description',
      },
    ],
    configDefaults: {
      toolId: '',
      analysisMode: 'clip',
      instruction: '',
    },
    supportedToolIds: IMAGE_WORKFLOW_TOOL_IDS,
  }),
  imageGenerate: Object.freeze({
    type: 'imageGenerate',
    label: 'Image Generate',
    category: 'AI Steps',
    description: 'Uses Automatic1111 or Forge to turn text into an image file.',
    inputPorts: [
      {
        id: 'prompt',
        kind: PORT_KIND_TEXT,
        label: 'Prompt',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'image',
        kind: PORT_KIND_IMAGE,
        label: 'Image',
      },
    ],
    configDefaults: {
      toolId: '',
      negativePrompt: '',
      width: 832,
      height: 832,
      steps: 24,
      cfgScale: 7,
      seed: -1,
    },
    supportedToolIds: IMAGE_WORKFLOW_TOOL_IDS,
  }),
  validation: Object.freeze({
    type: 'validation',
    label: 'Validation',
    category: 'Validation',
    description: 'Evaluates incoming content and routes it to pass or fail.',
    inputPorts: [
      {
        id: 'input',
        kind: PORT_KIND_ANY,
        allowedKinds: SUPPORTED_PORT_KINDS,
        label: 'Input',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'pass',
        kind: PORT_KIND_PASSTHROUGH,
        label: 'Pass',
        passthroughFrom: 'input',
      },
      {
        id: 'fail',
        kind: PORT_KIND_PASSTHROUGH,
        label: 'Fail',
        passthroughFrom: 'input',
      },
    ],
    configDefaults: {
      mode: 'user',
      llmExecutionMode: 'cloud',
      providerId: '',
      model: '',
      ruleset: '',
      systemPrompt: '',
    },
    supportedExecutionModes: [
      {
        id: 'user',
        label: 'User approval',
      },
      {
        id: 'llm',
        label: 'LLM validator',
      },
    ],
    supportedLlmExecutionModes: [
      {
        id: 'cloud',
        label: 'Cloud provider',
      },
      {
        id: 'ollama',
        label: 'Ollama (local)',
        requiredToolId: 'ollama',
      },
    ],
  }),
  textOutput: Object.freeze({
    type: 'textOutput',
    label: 'Text Output',
    category: 'Outputs',
    description: 'Shows the final text result inline and saves a copy to the run folder.',
    inputPorts: [
      {
        id: 'text',
        kind: PORT_KIND_TEXT,
        label: 'Text',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'Text result',
    },
  }),
  imageOutput: Object.freeze({
    type: 'imageOutput',
    label: 'Image Output',
    category: 'Outputs',
    description: 'Shows the final image and saves a copy to the run folder.',
    inputPorts: [
      {
        id: 'image',
        kind: PORT_KIND_IMAGE,
        label: 'Image',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'Image result',
    },
  }),
  audioOutput: Object.freeze({
    type: 'audioOutput',
    label: 'Audio Output',
    category: 'Outputs',
    description: 'Keeps the final audio artifact and shows where it was saved.',
    inputPorts: [
      {
        id: 'audio',
        kind: PORT_KIND_AUDIO,
        label: 'Audio',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'Audio result',
    },
  }),
  videoOutput: Object.freeze({
    type: 'videoOutput',
    label: 'Video Output',
    category: 'Outputs',
    description: 'Keeps the final video artifact and shows where it was saved.',
    inputPorts: [
      {
        id: 'video',
        kind: PORT_KIND_VIDEO,
        label: 'Video',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'Video result',
    },
  }),
  fileOutput: Object.freeze({
    type: 'fileOutput',
    label: 'File Output',
    category: 'Outputs',
    description: 'Keeps the final file reference and shows where it was saved.',
    inputPorts: [
      {
        id: 'file',
        kind: PORT_KIND_FILE,
        label: 'File',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'File result',
    },
  }),
});

const NODE_TYPE_LIST = Object.freeze(Object.values(PIPELINE_NODE_TYPES));

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createUniqueId(prefix = 'item') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toNonEmptyString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeTimestamp(value) {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function normalizeNumber(value, fallback) {
  const nextValue = Number(value);
  return Number.isFinite(nextValue) ? nextValue : fallback;
}

function normalizePortKind(kind) {
  const normalized = String(kind || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  if (normalized === 'audio-file') {
    return PORT_KIND_AUDIO;
  }

  return normalized;
}

function getSupportedPortKinds() {
  return [...SUPPORTED_PORT_KINDS];
}

function getPortAllowedKinds(port) {
  if (!port || typeof port !== 'object') {
    return [];
  }

  if (Array.isArray(port.allowedKinds) && port.allowedKinds.length) {
    return [...new Set(port.allowedKinds.map((entry) => normalizePortKind(entry)).filter(Boolean))];
  }

  const kind = normalizePortKind(port.kind);
  if (kind === PORT_KIND_ANY) {
    return getSupportedPortKinds();
  }

  if (kind === PORT_KIND_PASSTHROUGH) {
    return [];
  }

  return kind ? [kind] : [];
}

function getNodeTypeDefinition(type) {
  return PIPELINE_NODE_TYPES[type] || null;
}

function getDefaultNodeConfig(type) {
  const definition = getNodeTypeDefinition(type);
  return cloneValue(definition?.configDefaults || {});
}

function normalizeNodeConfig(type, config) {
  return {
    ...getDefaultNodeConfig(type),
    ...(config && typeof config === 'object' ? cloneValue(config) : {}),
  };
}

function createNode(type, overrides = {}) {
  const definition = getNodeTypeDefinition(type);
  if (!definition) {
    throw new Error('Local AI Hub could not create that pipeline node type.');
  }

  return {
    id: toNonEmptyString(overrides.id, createUniqueId(type)),
    type,
    label: toNonEmptyString(overrides.label, definition.label),
    position: {
      x: normalizeNumber(overrides.position?.x, DEFAULT_POSITION_X),
      y: normalizeNumber(overrides.position?.y, DEFAULT_POSITION_Y),
    },
    config: normalizeNodeConfig(type, overrides.config),
  };
}

function normalizeNode(node, index = 0) {
  const definition = getNodeTypeDefinition(node?.type);
  if (!definition) {
    return {
      id: toNonEmptyString(node?.id, createUniqueId('node')),
      type: toNonEmptyString(node?.type, 'unknown'),
      label: toNonEmptyString(node?.label, 'Unknown node'),
      position: {
        x: normalizeNumber(node?.position?.x, DEFAULT_POSITION_X + (index % 3) * 280),
        y: normalizeNumber(node?.position?.y, DEFAULT_POSITION_Y + Math.floor(index / 3) * 220),
      },
      config: cloneValue(node?.config && typeof node.config === 'object' ? node.config : {}),
    };
  }

  return createNode(node.type, {
    id: node?.id,
    label: node?.label,
    position: node?.position,
    config: node?.config,
  });
}

function createEdge(sourceNodeId, sourcePortId, targetNodeId, targetPortId, overrides = {}) {
  return {
    id: toNonEmptyString(overrides.id, createUniqueId('edge')),
    source: {
      nodeId: toNonEmptyString(sourceNodeId),
      portId: toNonEmptyString(sourcePortId),
    },
    target: {
      nodeId: toNonEmptyString(targetNodeId),
      portId: toNonEmptyString(targetPortId),
    },
  };
}

function normalizeEdge(edge) {
  return createEdge(edge?.source?.nodeId, edge?.source?.portId, edge?.target?.nodeId, edge?.target?.portId, {
    id: edge?.id,
  });
}

function createEmptyPipeline(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    id: toNonEmptyString(overrides.id, createUniqueId('pipeline')),
    name: toNonEmptyString(overrides.name, 'Untitled pipeline'),
    description: String(overrides.description || '').trim(),
    createdAt: normalizeTimestamp(overrides.createdAt || now),
    updatedAt: normalizeTimestamp(overrides.updatedAt || now),
    nodes: Array.isArray(overrides.nodes) ? overrides.nodes.map((node, index) => normalizeNode(node, index)) : [],
    edges: Array.isArray(overrides.edges) ? overrides.edges.map((edge) => normalizeEdge(edge)) : [],
  };
}

function normalizePipelineDefinition(definition = {}, options = {}) {
  const now = new Date().toISOString();
  const createdAt = options.keepCreatedAt && definition?.createdAt ? normalizeTimestamp(definition.createdAt) : normalizeTimestamp(definition?.createdAt || now);
  const updatedAt = options.keepUpdatedAt && definition?.updatedAt ? normalizeTimestamp(definition.updatedAt) : normalizeTimestamp(now);

  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    id: toNonEmptyString(definition?.id, createUniqueId('pipeline')),
    name: toNonEmptyString(definition?.name, 'Untitled pipeline'),
    description: String(definition?.description || '').trim(),
    createdAt,
    updatedAt,
    nodes: Array.isArray(definition?.nodes) ? definition.nodes.map((node, index) => normalizeNode(node, index)) : [],
    edges: Array.isArray(definition?.edges) ? definition.edges.map((edge) => normalizeEdge(edge)) : [],
  };
}

function getPortDefinition(nodeType, direction, portId) {
  const definition = getNodeTypeDefinition(nodeType);
  const portList = direction === 'input' ? definition?.inputPorts : definition?.outputPorts;
  return (portList || []).find((port) => port.id === portId) || null;
}
function resolveOutputKinds(sourceNode, sourcePort, graph, visited = new Set()) {
  if (!sourcePort) {
    return [];
  }

  const normalizedKind = normalizePortKind(sourcePort.kind);
  if (normalizedKind && normalizedKind !== PORT_KIND_PASSTHROUGH && normalizedKind !== PORT_KIND_ANY) {
    return [normalizedKind];
  }

  if (normalizedKind === PORT_KIND_ANY) {
    return getSupportedPortKinds();
  }

  if (!sourceNode || !graph) {
    return [];
  }

  const visitKey = `${sourceNode.id}:${sourcePort.id}`;
  if (visited.has(visitKey)) {
    return [];
  }

  visited.add(visitKey);
  const passthroughPortId = sourcePort.passthroughFrom || 'input';
  const incomingEdge = graph.incomingEdgeByPortKey.get(`${sourceNode.id}:${passthroughPortId}`);
  if (!incomingEdge) {
    return [];
  }

  const upstreamNode = graph.nodeMap.get(incomingEdge.source.nodeId);
  const upstreamPort = getPortDefinition(upstreamNode?.type, 'output', incomingEdge.source.portId);
  return resolveOutputKinds(upstreamNode, upstreamPort, graph, visited);
}

function doesKindIntersect(leftKinds = [], rightKinds = []) {
  return leftKinds.some((kind) => rightKinds.includes(kind));
}

function arePortsCompatible(source, target, options = {}) {
  const targetKinds = typeof target === 'string' ? getPortAllowedKinds({ kind: target }) : getPortAllowedKinds(target);
  const sourceKinds =
    typeof source === 'string'
      ? getPortAllowedKinds({ kind: source })
      : resolveOutputKinds(options.sourceNode || null, source, options.graph);

  if (!targetKinds.length) {
    return false;
  }

  if (!sourceKinds.length) {
    return normalizePortKind(source?.kind) === PORT_KIND_PASSTHROUGH;
  }

  return doesKindIntersect(sourceKinds, targetKinds);
}

function compareIssueSeverity(leftTone = 'neutral', rightTone = 'neutral') {
  const priority = {
    neutral: 0,
    good: 0,
    info: 1,
    warn: 2,
    danger: 3,
    error: 4,
  };

  return (priority[leftTone] || 0) - (priority[rightTone] || 0);
}

function evaluateCompatibilityProfile(profile, hardware) {
  if (!profile || !hardware) {
    return {
      label: 'Hardware unknown',
      tone: 'neutral',
      message: 'Local AI Hub has not finished reading this machine yet.',
    };
  }

  const vramMb = Number(hardware.vramMb || 0);
  const ramMb = Number(hardware.systemRamMb || 0);
  const minimumVramMb = Number(profile.minimumVramMb || 0);
  const recommendedVramMb = Number(profile.recommendedVramMb || minimumVramMb);
  const minimumRamMb = Number(profile.minimumRamMb || 0);
  const recommendedRamMb = Number(profile.recommendedRamMb || minimumRamMb);

  if (vramMb >= recommendedVramMb && ramMb >= recommendedRamMb) {
    return {
      label: 'Recommended',
      tone: 'good',
      message: 'This machine has enough GPU and RAM headroom for normal use.',
    };
  }

  if (vramMb >= minimumVramMb && ramMb >= minimumRamMb) {
    return {
      label: minimumVramMb >= 6144 ? 'Low VRAM mode' : 'Supported',
      tone: 'info',
      message:
        recommendedVramMb >= 16384
          ? 'This workload can run here, but it is aimed at higher-VRAM GPUs and will need conservative settings.'
          : 'This workload should run, but expect smaller batches or lighter models.',
    };
  }

  if (vramMb >= minimumVramMb || ramMb >= minimumRamMb) {
    return {
      label: 'Limited',
      tone: 'warn',
      message:
        recommendedVramMb >= 16384
          ? 'This workload is best on a higher-VRAM GPU and may be heavily constrained on this machine.'
          : 'This workload may still run, but it will need conservative settings.',
    };
  }

  return {
    label: 'Below spec',
    tone: 'danger',
    message: 'This machine is below the normal target range for that local workload.',
  };
}

function buildContextMaps(context = {}) {
  const tools = Array.isArray(context.tools)
    ? context.tools
    : context.toolsById && typeof context.toolsById === 'object'
      ? Object.values(context.toolsById)
      : [];
  const providers = Array.isArray(context.providers)
    ? context.providers
    : context.providersById && typeof context.providersById === 'object'
      ? Object.values(context.providersById)
      : [];
  const toolCatalog = Array.isArray(context.toolCatalog)
    ? context.toolCatalog
    : context.toolCatalogById && typeof context.toolCatalogById === 'object'
      ? Object.values(context.toolCatalogById)
      : [];

  return {
    hardware: context.hardware || null,
    toolsById: Object.fromEntries(tools.map((tool) => [tool.id, tool])),
    providersById: Object.fromEntries(providers.map((provider) => [provider.id, provider])),
    toolCatalogById: Object.fromEntries(toolCatalog.map((tool) => [tool.id, tool])),
  };
}

function buildPipelineGraph(definition = {}) {
  const pipeline = normalizePipelineDefinition(definition, {
    keepCreatedAt: true,
    keepUpdatedAt: true,
  });
  const errors = [];
  const warnings = [];
  const nodeMap = new Map();
  const nodeOrder = pipeline.nodes.map((node) => node.id);

  if (!pipeline.nodes.length) {
    errors.push('Add at least one node before running this pipeline.');
  }

  for (const node of pipeline.nodes) {
    if (nodeMap.has(node.id)) {
      errors.push(`The pipeline contains two nodes with the ID "${node.id}".`);
      continue;
    }

    if (!getNodeTypeDefinition(node.type)) {
      errors.push(`"${node.label}" uses an unsupported node type.`);
    }

    nodeMap.set(node.id, node);
  }

  const structuralEdges = [];
  const targetPortKeys = new Set();
  for (const edge of pipeline.edges) {
    const sourceNode = nodeMap.get(edge.source.nodeId);
    const targetNode = nodeMap.get(edge.target.nodeId);
    if (!sourceNode || !targetNode) {
      errors.push('One of the connections points at a node that no longer exists.');
      continue;
    }

    if (sourceNode.id === targetNode.id) {
      errors.push(`"${sourceNode.label}" cannot connect to itself.`);
      continue;
    }

    const sourcePort = getPortDefinition(sourceNode.type, 'output', edge.source.portId);
    const targetPort = getPortDefinition(targetNode.type, 'input', edge.target.portId);
    if (!sourcePort || !targetPort) {
      errors.push(`Local AI Hub found an invalid connection between "${sourceNode.label}" and "${targetNode.label}".`);
      continue;
    }

    const targetKey = `${targetNode.id}:${targetPort.id}`;
    if (targetPortKeys.has(targetKey)) {
      errors.push(`"${targetNode.label}" already has a connection for ${targetPort.label}.`);
      continue;
    }

    targetPortKeys.add(targetKey);
    structuralEdges.push({
      edge,
      sourceNode,
      sourcePort,
      targetNode,
      targetPort,
    });
  }

  const outgoingEdgesByNode = new Map([...nodeMap.keys()].map((nodeId) => [nodeId, []]));
  const incomingEdgesByNode = new Map([...nodeMap.keys()].map((nodeId) => [nodeId, []]));
  const incomingEdgeByPortKey = new Map();
  const compatibilityIncomingEdgeByPortKey = new Map(
    structuralEdges.map((entry) => [`${entry.targetNode.id}:${entry.targetPort.id}`, entry.edge]),
  );
  const validEdges = [];
  const graphForCompatibility = {
    pipeline,
    nodeMap,
    incomingEdgeByPortKey: compatibilityIncomingEdgeByPortKey,
  };

  for (const entry of structuralEdges) {
    if (!arePortsCompatible(entry.sourcePort, entry.targetPort, {
      sourceNode: entry.sourceNode,
      targetNode: entry.targetNode,
      graph: graphForCompatibility,
    })) {
      errors.push(`"${entry.sourceNode.label}" cannot connect ${entry.sourcePort.label} to ${entry.targetNode.label}'s ${entry.targetPort.label} input.`);
      continue;
    }

    validEdges.push(entry.edge);
    incomingEdgeByPortKey.set(`${entry.targetNode.id}:${entry.targetPort.id}`, entry.edge);
    outgoingEdgesByNode.get(entry.sourceNode.id).push(entry.edge);
    incomingEdgesByNode.get(entry.targetNode.id).push(entry.edge);
  }

  const terminalNodeIds = pipeline.nodes.filter((node) => getNodeTypeDefinition(node.type)?.terminal).map((node) => node.id);
  if (!terminalNodeIds.length) {
    errors.push('Add at least one output node so Local AI Hub knows which result to keep.');
  }

  const reachableNodeIds = new Set();
  const reverseQueue = [...terminalNodeIds];
  while (reverseQueue.length > 0) {
    const nodeId = reverseQueue.shift();
    if (reachableNodeIds.has(nodeId)) {
      continue;
    }

    reachableNodeIds.add(nodeId);
    const incomingEdges = incomingEdgesByNode.get(nodeId) || [];
    for (const edge of incomingEdges) {
      reverseQueue.push(edge.source.nodeId);
    }
  }

  for (const node of pipeline.nodes) {
    if (!reachableNodeIds.has(node.id) && terminalNodeIds.length > 0) {
      warnings.push(`"${node.label}" is not connected to an output and will be skipped.`);
    }
  }

  const indegree = new Map();
  const executionOrder = [];
  const queuedNodeIds = [];
  for (const nodeId of nodeOrder) {
    if (!reachableNodeIds.has(nodeId)) {
      continue;
    }

    const incomingCount = (incomingEdgesByNode.get(nodeId) || []).filter((edge) => reachableNodeIds.has(edge.source.nodeId)).length;
    indegree.set(nodeId, incomingCount);
    if (incomingCount === 0) {
      queuedNodeIds.push(nodeId);
    }
  }

  while (queuedNodeIds.length > 0) {
    const currentNodeId = queuedNodeIds.shift();
    executionOrder.push(currentNodeId);

    for (const edge of outgoingEdgesByNode.get(currentNodeId) || []) {
      if (!reachableNodeIds.has(edge.target.nodeId)) {
        continue;
      }

      const nextDegree = Number(indegree.get(edge.target.nodeId) || 0) - 1;
      indegree.set(edge.target.nodeId, nextDegree);
      if (nextDegree === 0) {
        queuedNodeIds.push(edge.target.nodeId);
      }
    }
  }

  const reachableCount = [...reachableNodeIds].length;
  if (reachableCount > 0 && executionOrder.length !== reachableCount) {
    errors.push('Local AI Hub found a cycle in the connected part of this pipeline. Remove the loop before running it.');
  }

  const graph = {
    pipeline,
    errors,
    warnings,
    nodeMap,
    outgoingEdgesByNode,
    incomingEdgesByNode,
    incomingEdgeByPortKey,
    reachableNodeIds,
    terminalNodeIds,
    executionOrder,
    edges: validEdges,
  };

  for (const nodeId of executionOrder) {
    const node = nodeMap.get(nodeId);
    const definitionEntry = getNodeTypeDefinition(node?.type);
    if (!node || !definitionEntry) {
      continue;
    }

    for (const port of definitionEntry.inputPorts || []) {
      if (!port.required) {
        continue;
      }

      const targetKey = `${node.id}:${port.id}`;
      if (!incomingEdgeByPortKey.has(targetKey)) {
        errors.push(`"${node.label}" is missing a connection for ${port.label}.`);
      }
    }

    if (node.type === 'validation') {
      const passCount = (outgoingEdgesByNode.get(node.id) || []).filter((edge) => edge.source.portId === 'pass').length;
      const failCount = (outgoingEdgesByNode.get(node.id) || []).filter((edge) => edge.source.portId === 'fail').length;
      if (passCount === 0 || failCount === 0) {
        errors.push(`"${node.label}" must connect both the pass and fail outputs before it can run.`);
      }
    }
  }

  return graph;
}

function pickAvailableToolId(candidateToolIds = [], contextMaps = {}) {
  for (const toolId of candidateToolIds) {
    if (contextMaps.toolsById?.[toolId] || contextMaps.toolCatalogById?.[toolId]) {
      return toolId;
    }
  }

  return candidateToolIds[0] || null;
}

function getImageToolIdForNode(node, contextMaps = {}) {
  const selectedToolId = String(node?.config?.toolId || '').trim();
  if (selectedToolId) {
    return selectedToolId;
  }

  return pickAvailableToolId(IMAGE_WORKFLOW_TOOL_IDS, contextMaps);
}

function getLocalToolRequirement(node, contextMaps = {}) {
  if (node.type === 'whisperTranscribe') {
    return 'whisper';
  }

  if (node.type === 'llmPrompt' && node.config?.executionMode === 'ollama') {
    return 'ollama';
  }

  if (node.type === 'validation' && node.config?.mode === 'llm' && node.config?.llmExecutionMode === 'ollama') {
    return 'ollama';
  }

  if (node.type === 'imageAnalyze' || node.type === 'imageGenerate') {
    return getImageToolIdForNode(node, contextMaps);
  }

  return null;
}

function getCompatibilityEntry(node, contextMaps) {
  const requiredToolId = getLocalToolRequirement(node, contextMaps);
  if (!requiredToolId) {
    return null;
  }

  const installedTool = contextMaps.toolsById[requiredToolId] || null;
  const catalogTool = contextMaps.toolCatalogById[requiredToolId] || installedTool || null;
  return {
    requiredToolId,
    installedTool,
    catalogTool,
    profile: catalogTool?.compatibility || catalogTool?.installInstructions?.compatibility || installedTool?.compatibility || null,
  };
}

function trimPreviewText(value, limit = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}

function buildNodeIssue(node, tone, message, options = {}) {
  return {
    nodeId: node.id,
    nodeLabel: node.label,
    tone,
    message,
    kind: options.kind || 'readiness',
  };
}
function getSelectedProviderStatus(providerId, contextMaps) {
  const provider = contextMaps.providersById[String(providerId || '').trim()] || null;
  if (!provider) {
    return {
      provider: null,
      tone: 'error',
      message: 'Choose a connected cloud provider for this step.',
    };
  }

  if (!provider.isConnected) {
    return {
      provider,
      tone: 'error',
      message: 'That cloud provider is not connected on this PC yet.',
    };
  }

  return {
    provider,
    tone: 'info',
    message: `${provider.name} will process this step outside your machine.`,
  };
}

function analyzeInputFileNode(node, summary) {
  if (!String(node.config?.filePath || '').trim()) {
    summary.readiness = {
      tone: 'error',
      message: `Choose a file for ${node.label} before running this pipeline.`,
    };
    return false;
  }

  return true;
}

function analyzeImageToolNode(node, summary, contextMaps) {
  const selectedToolId = String(node.config?.toolId || '').trim();
  const effectiveToolId = getImageToolIdForNode(node, contextMaps);
  if (selectedToolId && !IMAGE_WORKFLOW_TOOL_IDS.includes(selectedToolId)) {
    summary.readiness = {
      tone: 'error',
      message: 'Choose Automatic1111 or Forge for this image step.',
    };
    return false;
  }

  if (!effectiveToolId) {
    summary.readiness = {
      tone: 'error',
      message: 'Install Automatic1111 or Forge before using this image step.',
    };
    return false;
  }

  const tool = contextMaps.toolsById[effectiveToolId] || null;
  if (!tool) {
    summary.readiness = {
      tone: 'error',
      message: 'Install Automatic1111 or Forge before using this image step.',
    };
    return false;
  }

  if (String(tool.status || '').toLowerCase() !== 'running') {
    summary.readiness = {
      tone: 'warn',
      message: `${tool.name} is not ready yet. Start it from Library and wait for it to finish starting before running this image step.`,
    };
    return true;
  }

  summary.readiness = {
    tone: 'info',
    message: `${tool.name} will handle this image step locally.`,
  };
  return true;
}

function analyzePipeline(definition = {}, context = {}) {
  const graph = buildPipelineGraph(definition);
  const contextMaps = buildContextMaps(context);
  const issues = [];
  const nodeSummaries = {};
  const compatibilityEntries = [];
  const localHeavyNodeIds = [];

  for (const message of graph.errors) {
    issues.push({ tone: 'error', message });
  }

  for (const message of graph.warnings) {
    issues.push({ tone: 'warn', message });
  }

  for (const node of graph.pipeline.nodes) {
    const summary = {
      nodeId: node.id,
      nodeLabel: node.label,
      type: node.type,
      readiness: {
        tone: 'good',
        message: 'This node is ready.',
      },
      compatibility: null,
    };
    const definitionEntry = getNodeTypeDefinition(node.type);

    if (!definitionEntry) {
      summary.readiness = {
        tone: 'error',
        message: 'This node type is not supported in the current app build.',
      };
      issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
      nodeSummaries[node.id] = summary;
      continue;
    }

    if (graph.reachableNodeIds.has(node.id)) {
      if (node.type === 'textInput' && !String(node.config?.text || '').trim()) {
        summary.readiness = {
          tone: 'error',
          message: 'Enter some text before running this pipeline.',
        };
        issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
      }

      if (node.type === 'imageInput' || node.type === 'audioInput' || node.type === 'videoInput' || node.type === 'fileInput') {
        if (!analyzeInputFileNode(node, summary)) {
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        }
      }

      if (node.type === 'llmPrompt') {
        const executionMode = node.config?.executionMode === 'ollama' ? 'ollama' : 'cloud';
        if (!String(node.config?.model || '').trim()) {
          summary.readiness = {
            tone: 'error',
            message: 'Choose or enter a model for this LLM step.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (executionMode === 'cloud') {
          const providerStatus = getSelectedProviderStatus(node.config?.providerId, contextMaps);
          summary.readiness = {
            tone: providerStatus.tone,
            message: providerStatus.message,
          };
          if (providerStatus.tone === 'error') {
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          }
        } else {
          const ollamaTool = contextMaps.toolsById.ollama || null;
          if (!ollamaTool) {
            summary.readiness = {
              tone: 'error',
              message: 'Install Ollama before using the local LLM mode in a pipeline.',
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (String(ollamaTool.status || '').toLowerCase() !== 'running') {
            summary.readiness = {
              tone: 'warn',
              message: 'Ollama is not ready yet. Start it from Library and wait for it to finish starting before running this pipeline.',
            };
            issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
          }
        }
      }

      if (node.type === 'whisperTranscribe') {
        if (!contextMaps.toolsById.whisper) {
          summary.readiness = {
            tone: 'error',
            message: 'Install Whisper before using this transcription step in a pipeline.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        }
      }

      if (node.type === 'imageAnalyze') {
        if (!String(node.config?.analysisMode || '').trim()) {
          summary.readiness = {
            tone: 'error',
            message: 'Choose an analysis mode for this image step.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          const ready = analyzeImageToolNode(node, summary, contextMaps);
          if (!ready || summary.readiness.tone === 'error') {
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (summary.readiness.tone === 'warn') {
            issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
          }
        }
      }

      if (node.type === 'imageGenerate') {
        if (Number(node.config?.width || 0) < 256 || Number(node.config?.height || 0) < 256) {
          summary.readiness = {
            tone: 'error',
            message: 'Use at least 256 by 256 for generated images.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          const ready = analyzeImageToolNode(node, summary, contextMaps);
          if (!ready || summary.readiness.tone === 'error') {
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (summary.readiness.tone === 'warn') {
            issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
          }
        }
      }

      if (node.type === 'validation') {
        const outgoingEdges = graph.outgoingEdgesByNode.get(node.id) || [];
        const passCount = outgoingEdges.filter((edge) => edge.source.portId === 'pass').length;
        const failCount = outgoingEdges.filter((edge) => edge.source.portId === 'fail').length;
        if (passCount === 0 || failCount === 0) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect both the pass and fail outputs before running this validation step.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (node.config?.mode === 'llm') {
          if (!String(node.config?.ruleset || '').trim()) {
            summary.readiness = {
              tone: 'error',
              message: 'Describe the pass and fail rules for this validation step.',
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (!String(node.config?.model || '').trim()) {
            summary.readiness = {
              tone: 'error',
              message: 'Choose or enter a model for this validator.',
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (node.config?.llmExecutionMode === 'ollama') {
            const ollamaTool = contextMaps.toolsById.ollama || null;
            if (!ollamaTool) {
              summary.readiness = {
                tone: 'error',
                message: 'Install Ollama before using a local validator.',
              };
              issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
            } else if (String(ollamaTool.status || '').toLowerCase() !== 'running') {
              summary.readiness = {
                tone: 'warn',
                message: 'Ollama is not ready yet. Start it from Library and wait for it to finish starting before running this validator.',
              };
              issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
            }
          } else {
            const providerStatus = getSelectedProviderStatus(node.config?.providerId, contextMaps);
            summary.readiness = {
              tone: providerStatus.tone,
              message: providerStatus.message,
            };
            if (providerStatus.tone === 'error') {
              issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
            }
          }
        } else {
          summary.readiness = {
            tone: 'info',
            message: 'This run will pause here and wait for your pass or fail decision.',
          };
        }
      }
    }

    const compatibilityEntry = getCompatibilityEntry(node, contextMaps);
    if (compatibilityEntry?.profile) {
      const compatibility = evaluateCompatibilityProfile(compatibilityEntry.profile, contextMaps.hardware);
      summary.compatibility = {
        ...compatibility,
        source: compatibilityEntry.catalogTool?.name || compatibilityEntry.requiredToolId,
      };
      compatibilityEntries.push({
        ...summary.compatibility,
        nodeId: node.id,
        nodeLabel: node.label,
      });
      localHeavyNodeIds.push(node.id);
    }

    nodeSummaries[node.id] = summary;
  }

  if (localHeavyNodeIds.length > 1) {
    issues.push({
      tone: compatibilityEntries.some((entry) => entry.tone === 'warn' || entry.tone === 'danger') ? 'warn' : 'info',
      message: `This workflow includes ${localHeavyNodeIds.length} local tool steps. Local AI Hub will still run them one at a time.`,
    });
  }

  const highestCompatibility = compatibilityEntries.reduce((current, entry) => {
    if (!current || compareIssueSeverity(entry.tone, current.tone) > 0) {
      return entry;
    }

    return current;
  }, null);

  let compatibilitySummary = null;
  if (!compatibilityEntries.length) {
    compatibilitySummary = {
      tone: 'good',
      label: 'Flexible typed flow',
      message: 'This workflow currently depends on text, file, or cloud steps more than a heavy local GPU run.',
    };
  } else if (highestCompatibility) {
    compatibilitySummary = {
      tone: highestCompatibility.tone,
      label: highestCompatibility.label,
      message: `${highestCompatibility.nodeLabel}: ${highestCompatibility.message}`,
    };
  }

  const highestIssue = issues.reduce((current, issue) => {
    if (!current || compareIssueSeverity(issue.tone, current.tone) > 0) {
      return issue;
    }

    return current;
  }, null);

  return {
    pipeline: graph.pipeline,
    executable: !issues.some((issue) => issue.tone === 'error') && graph.executionOrder.length > 0,
    issues,
    nodeSummaries,
    compatibilitySummary,
    executionOrder: graph.executionOrder,
    reachableNodeIds: [...graph.reachableNodeIds],
    terminalNodeIds: graph.terminalNodeIds,
    primaryIssue: highestIssue,
  };
}

module.exports = {
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_NODE_TYPES,
  NODE_TYPE_LIST,
  IMAGE_WORKFLOW_TOOL_IDS,
  PIPELINE_PORT_KIND_LABELS,
  PORT_KIND_ANY,
  PORT_KIND_AUDIO,
  PORT_KIND_AUDIO_FILE,
  PORT_KIND_FILE,
  PORT_KIND_IMAGE,
  PORT_KIND_PASSTHROUGH,
  PORT_KIND_TEXT,
  PORT_KIND_VIDEO,
  SUPPORTED_PORT_KINDS,
  WHISPER_MODELS,
  analyzePipeline,
  arePortsCompatible,
  buildContextMaps,
  buildPipelineGraph,
  cloneValue,
  compareIssueSeverity,
  createEdge,
  createEmptyPipeline,
  createNode,
  createUniqueId,
  evaluateCompatibilityProfile,
  getDefaultNodeConfig,
  getImageToolIdForNode,
  getLocalToolRequirement,
  getNodeTypeDefinition,
  getPortAllowedKinds,
  getPortDefinition,
  getSupportedPortKinds,
  normalizePipelineDefinition,
  normalizePortKind,
  resolveOutputKinds,
  trimPreviewText,
};

module.exports.default = module.exports;

