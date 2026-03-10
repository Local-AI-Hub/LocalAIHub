import pipelineShared from '../../electron/shared/pipelineSchema.cjs';

const {
  NODE_TYPE_LIST,
  WHISPER_MODELS,
  analyzePipeline,
  buildContextMaps,
  createNode,
  getNodeTypeDefinition,
  trimPreviewText,
} = pipelineShared;

export const PIPELINE_NODE_WIDTH = 272;
export const PIPELINE_NODE_HEADER_HEIGHT = 60;
export const PIPELINE_PORT_ROW_HEIGHT = 36;
export const PIPELINE_PORT_SECTION_OFFSET = 76;
export const PIPELINE_NODE_MIN_HEIGHT = 168;

export function buildPipelineDisplayContext({ hardware, manifests, providers, tools }) {
  return buildContextMaps({
    hardware,
    providers,
    toolCatalog: manifests,
    tools,
  });
}

export function analyzePipelineDraft(pipeline, context) {
  return analyzePipeline(pipeline, context);
}

export function getPipelineNodeDefinition(type) {
  return getNodeTypeDefinition(type);
}

export function getNodePaletteGroups() {
  const groups = {};
  for (const nodeType of NODE_TYPE_LIST) {
    if (!groups[nodeType.category]) {
      groups[nodeType.category] = [];
    }

    groups[nodeType.category].push(nodeType);
  }

  return Object.entries(groups).map(([label, entries]) => ({
    label,
    entries,
  }));
}

export function createPositionedNode(type, existingNodes = []) {
  const index = Array.isArray(existingNodes) ? existingNodes.length : 0;
  const row = Math.floor(index / 2);
  const column = index % 2;
  return createNode(type, {
    position: {
      x: 120 + column * 320,
      y: 120 + row * 220,
    },
  });
}

export function getNodePortCenter(node, direction, portIndex) {
  const definition = getNodeTypeDefinition(node.type);
  const rowCount = Math.max(definition?.inputPorts?.length || 0, definition?.outputPorts?.length || 0, 1);
  const baseY = node.position.y + PIPELINE_PORT_SECTION_OFFSET;
  const safeIndex = Number.isFinite(portIndex) ? portIndex : 0;
  return {
    x: direction === 'input' ? node.position.x : node.position.x + PIPELINE_NODE_WIDTH,
    y: baseY + safeIndex * PIPELINE_PORT_ROW_HEIGHT + PIPELINE_PORT_ROW_HEIGHT / 2,
    rowCount,
  };
}

export function getNodeCardHeight(node) {
  const definition = getNodeTypeDefinition(node.type);
  const portCount = Math.max(definition?.inputPorts?.length || 0, definition?.outputPorts?.length || 0, 1);
  return Math.max(PIPELINE_NODE_MIN_HEIGHT, PIPELINE_PORT_SECTION_OFFSET + portCount * PIPELINE_PORT_ROW_HEIGHT + 56);
}

export function toneToClassName(tone) {
  if (tone === 'good') {
    return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100';
  }

  if (tone === 'info') {
    return 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100';
  }

  if (tone === 'warn') {
    return 'border-amber-400/30 bg-amber-400/10 text-amber-100';
  }

  if (tone === 'danger' || tone === 'error') {
    return 'border-rose-400/30 bg-rose-400/10 text-rose-100';
  }

  return 'border-white/10 bg-white/5 text-slate-300';
}

export function runStatusClassName(status) {
  if (status === 'completed') {
    return 'border-emerald-400/30 bg-emerald-400/12 text-emerald-100';
  }

  if (status === 'running') {
    return 'border-cyan-400/30 bg-cyan-400/12 text-cyan-100';
  }

  if (status === 'failed') {
    return 'border-rose-400/30 bg-rose-400/12 text-rose-100';
  }

  if (status === 'cancelled' || status === 'skipped') {
    return 'border-amber-400/30 bg-amber-400/12 text-amber-100';
  }

  return 'border-white/10 bg-white/5 text-slate-300';
}

export function summarizePreview(value, limit = 160) {
  return trimPreviewText(value, limit);
}

export { WHISPER_MODELS };

