const PIPELINE_SCHEMA_VERSION = 1;
const DEFAULT_POSITION_X = 120;
const DEFAULT_POSITION_Y = 120;
const PORT_KIND_TEXT = 'text';
const PORT_KIND_AUDIO_FILE = 'audio-file';

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
  audioInput: Object.freeze({
    type: 'audioInput',
    label: 'Audio File',
    category: 'Inputs',
    description: 'Supplies an audio file path to later nodes.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'audio',
        kind: PORT_KIND_AUDIO_FILE,
        label: 'Audio',
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
        kind: PORT_KIND_AUDIO_FILE,
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
  textOutput: Object.freeze({
    type: 'textOutput',
    label: 'Text Output',
    category: 'Outputs',
    description: 'Collects the final text result from the workflow.',
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
      title: 'Result',
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
        y: normalizeNumber(node?.position?.y, DEFAULT_POSITION_Y + Math.floor(index / 3) * 200),
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

function arePortsCompatible(sourceKind, targetKind) {
  return Boolean(sourceKind) && Boolean(targetKind) && String(sourceKind) === String(targetKind);
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
  const outgoingEdgesByNode = new Map();
  const incomingEdgesByNode = new Map();
  const incomingEdgeByPortKey = new Map();

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
    outgoingEdgesByNode.set(node.id, []);
    incomingEdgesByNode.set(node.id, []);
  }

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

    if (!arePortsCompatible(sourcePort.kind, targetPort.kind)) {
      errors.push(`"${sourceNode.label}" cannot connect ${sourcePort.label} to ${targetNode.label}'s ${targetPort.label} input.`);
      continue;
    }

    const targetKey = `${targetNode.id}:${targetPort.id}`;
    if (incomingEdgeByPortKey.has(targetKey)) {
      errors.push(`"${targetNode.label}" already has a connection for ${targetPort.label}.`);
      continue;
    }

    incomingEdgeByPortKey.set(targetKey, edge);
    outgoingEdgesByNode.get(sourceNode.id).push(edge);
    incomingEdgesByNode.get(targetNode.id).push(edge);
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

  for (const nodeId of executionOrder) {
    const node = nodeMap.get(nodeId);
    const definition = getNodeTypeDefinition(node?.type);
    if (!node || !definition) {
      continue;
    }

    for (const port of definition.inputPorts || []) {
      if (!port.required) {
        continue;
      }

      const targetKey = `${node.id}:${port.id}`;
      if (!incomingEdgeByPortKey.has(targetKey)) {
        errors.push(`"${node.label}" is missing a connection for ${port.label}.`);
      }
    }
  }

  return {
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
  };
}

function getLocalToolRequirement(node) {
  if (node.type === 'whisperTranscribe') {
    return 'whisper';
  }

  if (node.type === 'llmPrompt' && node.config?.executionMode === 'ollama') {
    return 'ollama';
  }

  return null;
}

function getCompatibilityEntry(node, contextMaps) {
  const requiredToolId = getLocalToolRequirement(node);
  if (!requiredToolId) {
    return null;
  }

  const installedTool = contextMaps.toolsById[requiredToolId] || null;
  const catalogTool = contextMaps.toolCatalogById[requiredToolId] || installedTool || null;
  return {
    requiredToolId,
    installedTool,
    catalogTool,
    profile: catalogTool?.compatibility || installedTool?.compatibility || null,
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

function analyzePipeline(definition = {}, context = {}) {
  const graph = buildPipelineGraph(definition);
  const contextMaps = buildContextMaps(context);
  const issues = [];
  const nodeSummaries = {};
  const compatibilityEntries = [];

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

      if (node.type === 'audioInput' && !String(node.config?.filePath || '').trim()) {
        summary.readiness = {
          tone: 'error',
          message: 'Choose an audio file before running this pipeline.',
        };
        issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
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
          const providerId = String(node.config?.providerId || '').trim();
          if (!providerId) {
            summary.readiness = {
              tone: 'error',
              message: 'Choose a connected cloud provider for this LLM step.',
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else {
            const provider = contextMaps.providersById[providerId];
            if (!provider?.isConnected) {
              summary.readiness = {
                tone: 'error',
                message: 'That cloud provider is not connected on this PC yet.',
              };
              issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
            } else {
              summary.readiness = {
                tone: 'info',
                message: `${provider.name} will process this step outside your machine.`,
              };
            }
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
              message: 'Ollama is not marked as running. Start it from Library before running this pipeline.',
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
    }

    nodeSummaries[node.id] = summary;
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
      label: 'Lightweight',
      message: 'This pipeline does not include a local GPU-heavy step in Phase 1.',
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
  PORT_KIND_AUDIO_FILE,
  PORT_KIND_TEXT,
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
  getNodeTypeDefinition,
  getPortDefinition,
  normalizePipelineDefinition,
  trimPreviewText,
};

module.exports.default = module.exports;

