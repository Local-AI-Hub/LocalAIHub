const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');

const { chatWithOllama, inspectOllamaModel, inspectOllamaModelCapabilities } = require('./ollamaService');
const { chatWithProvider, listProviderConnections, runProviderOperation } = require('./providerService');
const { initializeProviderRegistry } = require('./providerRegistry');
const { getToolCatalog } = require('./toolRegistry');
const { listDownloadedModels } = require('./modelService');
const { buildMergedToolStateList, getResolvedToolState } = require('./toolStateService');
const { DEFAULT_WHISPER_MODEL, transcribeWithWhisper } = require('./whisperService');
const {
  buildFileArtifact,
  buildTerminalResult,
  copyArtifactToOutput,
  createArtifactCollection,
  createCompositionArtifact,
  createPlanArtifact,
  createPlanningPacketArtifact,
  createTextArtifact,
  describeArtifactForLlm,
  ensureRunDirectories,
  isArtifactCollection,
  isCompositionArtifact,
  persistArtifactCollection,
  persistCompositionArtifact,
  saveBase64Artifact,
  saveBufferArtifact,
  serializeArtifactForUi,
  summarizeArtifact,
} = require('./pipelineArtifactService');
const {
  DEFAULT_PLANNING_SCHEMA_ID,
  buildPlanReviewDocument,
  buildPlanTextCollectionItems,
  buildPlanningPacketDocument,
  buildPlannerPrompt,
  getPlanningSchemaDefinition,
  validatePlanAgainstSchema,
  validatePlanningPacketShape,
} = require('../shared/planningSchema.cjs');
const {
  generateImageWithWorkflowTool,
  interrogateImageWithWorkflowTool,
  resolveSelectedImageTool,
} = require('./workflowToolService');
const { executeGraphWorkflowNode } = require('./graphWorkflowService');
const {
  GRAPH_WORKFLOW_OPERATION_BACKEND_IDS,
  buildGraphWorkflowOperationBackendNode,
  getGraphWorkflowOperationBackendSupport,
} = require('../shared/graphWorkflowContracts.cjs');
const { generateAudioWithLocalAudioTool } = require('./localAudioService');
const {
  findRvcVoiceModelMatch,
  findStableDiffusionCheckpointMatch,
  getRvcVoiceModels,
  getStableDiffusionCheckpointModels,
} = require('../shared/toolAssetSelection.cjs');
const { generateImageWithLocalImageTool } = require('./localImageService');
const { generateVideoWithLocalVideoTool } = require('./localVideoService');
const { exportCompositionArtifactToVideo } = require('./mediaCompositionService');
const { createPipelineToolOrchestrator } = require('./pipelineToolOrchestrationService');
const { doesProviderOperationRequireExplicitModel, getProviderModelCapabilities, getProviderPipelineOperation, getToolPipelineOperation } = require('../shared/pipelineCapabilities.cjs');
const {
  PIPELINE_OPERATION_IDS,
  PORT_KIND_AUDIO,
  PORT_KIND_COLLECTION,
  PORT_KIND_COMPOSITION,
  PORT_KIND_FILE,
  PORT_KIND_IMAGE,
  PORT_KIND_PLANNING_PACKET,
  PORT_KIND_PLAN,
  PORT_KIND_TEXT,
  PORT_KIND_VIDEO,
  analyzePipeline,
  buildPipelineGraph,
  buildContextMaps,
  createUniqueId,
  getGraphWorkflowToolId,
  getCollectionMapInputKind,
  getCollectionMapMapping,
  getCollectionMapOperationId,
  getCollectionMapOutputKind,
  getLocalImageBackendOperationId,
  getModelStepLocalToolId,
  getModelStepOperationId,
  normalizeImageTransformSubtype,
  getNodeTypeDefinition,
  getPortDefinition,
  trimPreviewText,
  selectLocalImageBackend,
} = require('../shared/pipelineSchema.cjs');

class PipelineCancelledError extends Error {
  constructor(message = 'Pipeline run cancelled.') {
    super(message);
    this.name = 'PipelineCancelledError';
  }
}

let pipelineEventSink = null;
let activeRun = null;
let pendingValidationControl = null;

const PLANNER_PROVIDER_TIMEOUT_MS = 60000;

function setPipelineEventSink(listener) {
  pipelineEventSink = typeof listener === 'function' ? listener : null;
}

function emitPipelineEvent() {
  if (typeof pipelineEventSink !== 'function' || !activeRun) {
    return;
  }

  activeRun.revision = Number(activeRun.revision || 0) + 1;

  try {
    pipelineEventSink({
      type: 'pipeline-run-update',
      run: getActiveRunSnapshot(),
    });
  } catch {
    return;
  }
}

function collectSelectedOllamaModels(definition = {}) {
  const selectedModels = new Set();

  for (const node of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    if (node?.type === 'llmPrompt' && node?.config?.executionMode === 'ollama') {
      const model = String(node.config?.model || '').trim();
      if (model) {
        selectedModels.add(model);
      }
    }

    if (node?.type === 'validation' && node?.config?.mode === 'llm' && node?.config?.llmExecutionMode === 'ollama') {
      const model = String(node.config?.model || '').trim();
      if (model) {
        selectedModels.add(model);
      }
    }

    if (node?.type === 'planner' && node?.config?.executionMode === 'ollama') {
      const model = String(node.config?.model || '').trim();
      if (model) {
        selectedModels.add(model);
      }
    }
  }

  return [...selectedModels];
}

function attachOllamaModelCapabilities(tools = [], modelCapabilitiesByName = {}) {
  if (!Object.keys(modelCapabilitiesByName).length) {
    return tools;
  }

  return tools.map((tool) =>
    tool?.id === 'ollama'
      ? {
          ...tool,
          modelCapabilitiesByName: {
            ...(tool.modelCapabilitiesByName || {}),
            ...modelCapabilitiesByName,
          },
        }
      : tool,
  );
}

function collectSelectedLocalImageToolIds(definition = {}) {
  const selectedToolIds = new Set();
  let hasLocalImageGenerationStep = false;

  for (const node of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    const isModelStepImageGeneration = node?.type === 'llmPrompt'
      && node?.config?.executionMode === 'localTool'
      && getModelStepOperationId(node) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
    const isDirectImageGeneration = false;
    const isLocalCollectionImageMap = node?.type === 'collectionMap'
      && node?.config?.executionMode === 'localTool'
      && String(node?.config?.operationId || PIPELINE_OPERATION_IDS.IMAGE_GENERATE).trim() === PIPELINE_OPERATION_IDS.IMAGE_GENERATE;

    if (!isModelStepImageGeneration && !isDirectImageGeneration && !isLocalCollectionImageMap) {
      continue;
    }

    hasLocalImageGenerationStep = true;
    const toolId = String(node?.config?.toolId || '').trim().toLowerCase();
    if (toolId) {
      selectedToolIds.add(toolId);
    }
  }

  if (!hasLocalImageGenerationStep) {
    return [];
  }

  return selectedToolIds.size ? [...selectedToolIds] : ['automatic1111', 'forge'];
}

function collectSelectedLocalAudioTransformToolIds(definition = {}) {
  const selectedToolIds = new Set();
  let hasLocalAudioTransformStep = false;

  for (const node of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    if (node?.type !== 'llmPrompt' || node?.config?.executionMode !== 'localTool' || getModelStepOperationId(node) !== PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
      continue;
    }

    hasLocalAudioTransformStep = true;
    const toolId = String(node?.config?.toolId || '').trim().toLowerCase();
    if (toolId) {
      selectedToolIds.add(toolId);
    }
  }

  if (!hasLocalAudioTransformStep) {
    return [];
  }

  return selectedToolIds.size ? [...selectedToolIds] : ['rvc'];
}

function filterLocalImageCheckpointModels(models = []) {
  return (Array.isArray(models) ? models : []).filter((model) => {
    const modelType = String(model?.modelType || '').trim().toLowerCase();
    return modelType === 'checkpoint' || modelType === 'inpainting';
  });
}

function attachDownloadedToolModels(tools = [], downloadedModelsByToolId = {}) {
  if (!Object.keys(downloadedModelsByToolId).length) {
    return tools;
  }

  return tools.map((tool) => {
    if (!tool?.id || !downloadedModelsByToolId[tool.id]) {
      return tool;
    }

    return {
      ...tool,
      downloadedModels: downloadedModelsByToolId[tool.id],
    };
  });
}

function getDownloadedToolModelEntry(tool, model) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel) {
    return null;
  }

  const downloadedModels = Array.isArray(tool?.downloadedModels) ? tool.downloadedModels : [];
  if (tool?.id === 'automatic1111' || tool?.id === 'forge') {
    return findStableDiffusionCheckpointMatch(getStableDiffusionCheckpointModels(downloadedModels), model);
  }

  if (tool?.id === 'rvc') {
    return findRvcVoiceModelMatch(getRvcVoiceModels(downloadedModels), model);
  }

  return downloadedModels.find((entry) => {
    const candidates = [entry?.id, entry?.name, entry?.fileName, entry?.relativePath, entry?.path]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    return candidates.includes(normalizedModel);
  }) || null;
}

function getOllamaModelCapabilityEntry(contextMaps, model) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel) {
    return null;
  }

  const lookup = contextMaps?.toolsById?.ollama?.modelCapabilitiesByName;
  if (!lookup || typeof lookup !== 'object') {
    return null;
  }

  return lookup[normalizedModel] || null;
}

async function ensureOllamaImageModelSupport(contextMaps, ollamaTool, model) {
  let capability = getOllamaModelCapabilityEntry(contextMaps, model);
  if (!capability) {
    capability = await inspectOllamaModel(ollamaTool, model).catch(() => null);
    if (capability) {
      const normalizedModel = String(model || '').trim().toLowerCase();
      if (!contextMaps.toolsById.ollama.modelCapabilitiesByName || typeof contextMaps.toolsById.ollama.modelCapabilitiesByName !== 'object') {
        contextMaps.toolsById.ollama.modelCapabilitiesByName = {};
      }
      contextMaps.toolsById.ollama.modelCapabilitiesByName[normalizedModel] = capability;
    }
  }

  if (capability?.supportsImageInput === false) {
    throw new Error('Selected model does not support image input. Choose a vision-capable Ollama model before running this step.');
  }
}

async function buildPipelineContext(definition = {}) {
  await initializeProviderRegistry();
  let toolEntries = await buildMergedToolStateList({
    resolveStatuses: true,
    syncDiscovered: true,
  });

  const selectedOllamaModels = collectSelectedOllamaModels(definition);
  if (selectedOllamaModels.length) {
    const ollamaTool = toolEntries.find((tool) => tool?.id === 'ollama') || null;
    if (ollamaTool) {
      const modelCapabilitiesByName = await inspectOllamaModelCapabilities(ollamaTool, selectedOllamaModels).catch(() => null);
      if (modelCapabilitiesByName && Object.keys(modelCapabilitiesByName).length) {
        toolEntries = attachOllamaModelCapabilities(toolEntries, modelCapabilitiesByName);
      }
    }
  }

  const selectedLocalImageToolIds = collectSelectedLocalImageToolIds(definition);
  const selectedLocalAudioTransformToolIds = collectSelectedLocalAudioTransformToolIds(definition);
  if (selectedLocalImageToolIds.length || selectedLocalAudioTransformToolIds.length) {
    const downloadedModelsByToolId = {};
    for (const toolId of selectedLocalImageToolIds) {
      downloadedModelsByToolId[toolId] = filterLocalImageCheckpointModels(await listDownloadedModels(toolId).catch(() => []));
    }
    for (const toolId of selectedLocalAudioTransformToolIds) {
      downloadedModelsByToolId[toolId] = await listDownloadedModels(toolId).catch(() => []);
    }

    toolEntries = attachDownloadedToolModels(toolEntries, downloadedModelsByToolId);
  }

  return buildContextMaps({
    hardware: null,
    providers: await listProviderConnections(),
    toolCatalog: getToolCatalog(),
    tools: toolEntries,
  });
}

async function analyzeWithCurrentContext(definition) {
  const context = await buildPipelineContext(definition);
  return {
    analysis: analyzePipeline(definition, context),
    context,
  };
}

function createInitialNodeStates(graph) {
  const nodeStates = {};

  for (const node of graph.pipeline.nodes) {
    nodeStates[node.id] = {
      activeLoops: [],
      collectionControl: null,
      destinationPath: '',
      finishedAt: null,
      history: [],
      iteration: 1,
      loopLabel: '',
      loopMaxAttempts: null,
      loopNodeId: '',
      loopPathLabel: '',
      message: graph.reachableNodeIds.has(node.id) ? 'Waiting for earlier steps to finish.' : 'Skipped because it is not connected to an output.',
      nodeId: node.id,
      nodeLabel: node.label,
      outputs: {},
      preview: '',
      runCount: 0,
      selectedBranch: '',
      startedAt: null,
      status: graph.reachableNodeIds.has(node.id) ? 'queued' : 'skipped',
      type: node.type,
      validation: null,
    };
  }

  return nodeStates;
}

function createLoopStateRecords(graph) {
  const loopStates = {};

  for (const [loopNodeId, loopMeta] of graph.retryLoopsByNodeId.entries()) {
    loopStates[loopNodeId] = {
      attempt: 1,
      carriedArtifact: null,
      history: [],
      lastRetryArtifactSignature: '',
      loopLabel: loopMeta.loopLabel,
      loopNodeId,
      maxAttempts: loopMeta.maxAttempts,
      retryTargetLabel: loopMeta.retryTargetLabel,
      retryTargetNodeId: loopMeta.retryTargetNodeId,
      status: 'ready',
    };
  }

  return loopStates;
}

function createCollectionControlStateRecords(graph) {
  const collectionControlStates = {};

  for (const [nodeId, meta] of graph.collectionAccumulatorsByNodeId.entries()) {
    const node = graph.nodeMap.get(nodeId) || null;
    collectionControlStates[nodeId] = {
      acceptedCount: 0,
      collection: null,
      itemKind: '',
      items: [],
      lastUpdatedAt: '',
      loopLabel: meta.loopLabel || '',
      loopNodeId: meta.loopNodeId || '',
      message: 'Waiting for accepted items.',
      nodeId,
      nodeLabel: node?.label || '',
      status: 'idle',
      targetCount: Number(meta.targetCount || 1) || 1,
    };
  }

  return collectionControlStates;
}

function createRunRecord(analysis, graph, runDirectories) {
  const runId = createUniqueId('run');
  const run = {
    cancelRequested: false,
    collectionControlStates: createCollectionControlStateRecords(graph),
    currentNodeId: null,
    directories: runDirectories,
    executionOrder: [...analysis.executionOrder],
    finishedAt: null,
    loopStates: createLoopStateRecords(graph),
    message: 'Local AI Hub is running the pipeline step by step and will launch local tools only when needed.',
    nodeStates: createInitialNodeStates(graph),
    pendingValidation: null,
    pipelineId: analysis.pipeline.id,
    pipelineName: analysis.pipeline.name,
    reachableNodeIds: [...analysis.reachableNodeIds],
    resultsByNodeId: {},
    revision: 0,
    runId,
    startedAt: new Date().toISOString(),
    status: 'running',
    terminalNodeIds: [...analysis.terminalNodeIds],
    terminalResults: [],
  };

  for (const nodeId of Object.keys(run.collectionControlStates || {})) {
    syncNodeCollectionControlState(run, nodeId);
  }

  return run;
}

function serializeRun(run) {
  if (!run) {
    return null;
  }

  return JSON.parse(JSON.stringify(run));
}

function getActiveRunSnapshot() {
  return serializeRun(activeRun);
}

function updateRunMessage(run, message) {
  const nextMessage = String(message || '').trim();
  if (!run || !nextMessage) {
    return;
  }

  run.message = nextMessage;
  emitPipelineEvent();
}

function createProgressReporter(run, nodeId = '') {
  return (message, runMessage = '') => {
    if (nodeId) {
      updateRunningNodeProgress(run, nodeId, message, runMessage);
      return;
    }

    updateRunMessage(run, runMessage || message);
  };
}

async function disposePipelineTools(orchestrator, run, nodeId, reason) {
  if (!orchestrator) {
    return null;
  }

  try {
    await orchestrator.dispose(createProgressReporter(run, nodeId), reason);
    return null;
  } catch (error) {
    return error;
  }
}

function updateRunningNodeProgress(run, nodeId, message, runMessage = '') {
  if (!run || !nodeId) {
    return;
  }

  const nodeState = run.nodeStates?.[nodeId];
  if (!nodeState) {
    return;
  }

  const nextMessage = String(message || '').trim();
  if (nextMessage) {
    nodeState.message = nextMessage;
  }

  if (runMessage) {
    run.message = runMessage;
  }

  emitPipelineEvent();
}

function markRemainingNodes(run, graph, status, message) {
  for (const nodeId of graph.executionOrder) {
    const nodeState = run.nodeStates[nodeId];
    if (!nodeState || nodeState.status !== 'queued') {
      continue;
    }

    nodeState.status = status;
    nodeState.finishedAt = new Date().toISOString();
    nodeState.message = message;
  }
}

function cloneLoopContexts(loopContexts = []) {
  return Array.isArray(loopContexts)
    ? loopContexts.filter(Boolean).map((entry) => ({ ...entry }))
    : [];
}

function formatLoopAttemptLabel(iteration, loopMaxAttempts) {
  const attemptNumber = Number(iteration || 0);
  const maxAttempts = Number(loopMaxAttempts || 0);
  if (maxAttempts > 0) {
    return 'attempt ' + Math.max(1, attemptNumber || 1) + ' of ' + maxAttempts;
  }

  if (attemptNumber > 1) {
    return 'attempt ' + attemptNumber;
  }

  return '';
}

function formatLoopPathLabel(loopContexts = []) {
  const entries = cloneLoopContexts(loopContexts);
  if (entries.length <= 1) {
    return '';
  }

  return entries
    .map((entry) => {
      const attemptLabel = formatLoopAttemptLabel(entry?.iteration, entry?.loopMaxAttempts);
      if (entry?.loopLabel && attemptLabel) {
        return entry.loopLabel + ' ' + attemptLabel;
      }

      return entry?.loopLabel || attemptLabel || '';
    })
    .filter(Boolean)
    .join(' -> ');
}

function getNodeLoopContexts(run, graph, nodeId) {
  const loopNodeIds = graph.retryLoopNodeIdsBySegmentNodeId?.get?.(nodeId);
  if (!Array.isArray(loopNodeIds) || !loopNodeIds.length) {
    return [];
  }

  return loopNodeIds
    .map((loopNodeId) => {
      const loopState = run.loopStates?.[loopNodeId] || null;
      if (!loopState) {
        return null;
      }

      return {
        iteration: loopState.attempt || 1,
        loopLabel: loopState.loopLabel || '',
        loopMaxAttempts: loopState.maxAttempts || null,
        loopNodeId,
        status: loopState.status || 'ready',
      };
    })
    .filter(Boolean);
}

function getNodeLoopState(run, graph, nodeId) {
  const activeLoops = getNodeLoopContexts(run, graph, nodeId);
  const primaryLoop = activeLoops.length ? activeLoops[activeLoops.length - 1] : null;
  return {
    activeLoops,
    iteration: primaryLoop?.iteration || 1,
    loopLabel: primaryLoop?.loopLabel || '',
    loopMaxAttempts: primaryLoop?.loopMaxAttempts || null,
    loopNodeId: primaryLoop?.loopNodeId || '',
    loopPathLabel: formatLoopPathLabel(activeLoops),
  };
}

function applyNodeLoopState(nodeState, loopState) {
  if (!nodeState) {
    return;
  }

  nodeState.activeLoops = cloneLoopContexts(loopState?.activeLoops);
  nodeState.iteration = loopState?.iteration || 1;
  nodeState.loopLabel = loopState?.loopLabel || '';
  nodeState.loopMaxAttempts = loopState?.loopMaxAttempts || null;
  nodeState.loopNodeId = loopState?.loopNodeId || '';
  nodeState.loopPathLabel = loopState?.loopPathLabel || '';
}

function buildCollectionControlSnapshot(collectionState) {
  if (!collectionState) {
    return null;
  }

  return {
    acceptedCount: Number(collectionState.acceptedCount || 0) || 0,
    itemKind: String(collectionState.itemKind || '').trim(),
    loopLabel: String(collectionState.loopLabel || '').trim(),
    loopNodeId: String(collectionState.loopNodeId || '').trim(),
    message: String(collectionState.message || '').trim(),
    status: String(collectionState.status || 'idle').trim() || 'idle',
    targetCount: Number(collectionState.targetCount || 0) || 0,
  };
}

function applyNodeCollectionControlState(nodeState, collectionState) {
  if (!nodeState) {
    return;
  }

  nodeState.collectionControl = buildCollectionControlSnapshot(collectionState);
}

function syncNodeCollectionControlState(run, nodeId) {
  if (!run || !nodeId) {
    return;
  }

  applyNodeCollectionControlState(run.nodeStates?.[nodeId], run.collectionControlStates?.[nodeId] || null);
}

function resetCollectionControlStateForFreshPass(collectionState) {
  if (!collectionState) {
    return;
  }

  collectionState.acceptedCount = 0;
  collectionState.collection = null;
  collectionState.itemKind = '';
  collectionState.items = [];
  collectionState.lastUpdatedAt = '';
  collectionState.message = 'Waiting for accepted items.';
  collectionState.status = 'idle';
}

function resetCollectionControlStatesForLoop(run, graph, loopNodeId) {
  if (!run?.collectionControlStates || !loopNodeId) {
    return;
  }

  for (const [nodeId, collectionState] of Object.entries(run.collectionControlStates)) {
    if (String(collectionState?.loopNodeId || '') !== String(loopNodeId)) {
      continue;
    }

    resetCollectionControlStateForFreshPass(collectionState);
    syncNodeCollectionControlState(run, nodeId);
  }
}

function appendHistoryEntry(entries, entry, maxEntries = 12) {
  const history = Array.isArray(entries) ? [...entries] : [];
  history.push(entry);
  return history.slice(-maxEntries);
}

function recordNodeAttemptHistory(nodeState) {
  if (!nodeState || (!nodeState.runCount && nodeState.status === 'queued')) {
    return;
  }

  nodeState.history = appendHistoryEntry(nodeState.history, {
    activeLoops: cloneLoopContexts(nodeState.activeLoops),
    attempt: Number(nodeState.iteration || 1),
    loopMaxAttempts: Number(nodeState.loopMaxAttempts || 0) || null,
    loopPathLabel: nodeState.loopPathLabel || '',
    message: nodeState.message || '',
    preview: nodeState.preview || '',
    recordedAt: new Date().toISOString(),
    selectedBranch: nodeState.selectedBranch || '',
    status: nodeState.status || 'queued',
    validation: nodeState.validation ? JSON.parse(JSON.stringify(nodeState.validation)) : null,
  });
}

function recordLoopHistory(loopState, entry) {
  if (!loopState) {
    return;
  }

  const activeLoops = cloneLoopContexts(entry?.activeLoops);
  loopState.history = appendHistoryEntry(loopState.history, {
    ...entry,
    activeLoops,
    loopPathLabel: entry?.loopPathLabel || formatLoopPathLabel(activeLoops),
    recordedAt: new Date().toISOString(),
  });
}

function resetLoopStateForFreshPass(loopState) {
  if (!loopState) {
    return;
  }

  loopState.attempt = 1;
  loopState.carriedArtifact = null;
  loopState.lastRetryArtifactSignature = '';
  loopState.status = 'ready';
}

function resetNestedLoopStatesForRetry(run, graph, loopNodeId) {
  const triggeringLoopMeta = graph.retryLoopsByNodeId.get(loopNodeId) || null;
  if (!triggeringLoopMeta) {
    return;
  }

  const segmentNodeIds = new Set(triggeringLoopMeta.segmentNodeIds || []);
  for (const [nestedLoopNodeId, nestedLoopMeta] of graph.retryLoopsByNodeId.entries()) {
    if (nestedLoopNodeId === loopNodeId || !segmentNodeIds.has(nestedLoopNodeId)) {
      continue;
    }

    const nestedLoopState = run.loopStates?.[nestedLoopNodeId] || null;
    if (!nestedLoopState) {
      continue;
    }

    if (Number(nestedLoopState.attempt || 1) > 1 || nestedLoopState.status !== 'ready' || nestedLoopState.carriedArtifact) {
      recordLoopHistory(nestedLoopState, {
        attempt: Number(nestedLoopState.attempt || 1),
        loopMaxAttempts: Number(nestedLoopState.maxAttempts || 0) || nestedLoopMeta.maxAttempts || null,
        message: triggeringLoopMeta.loopLabel + ' restarted ' + nestedLoopMeta.loopLabel + ' from its first attempt.',
        preview: '',
        selectedBranch: '',
        status: 'reset',
      });
    }

    resetLoopStateForFreshPass(nestedLoopState);
    resetCollectionControlStatesForLoop(run, graph, nestedLoopNodeId);
  }
}

function resetLoopSegmentForRetry(run, graph, loopNodeId, nextAttempt) {
  const loopMeta = graph.retryLoopsByNodeId.get(loopNodeId) || null;
  const loopState = run.loopStates?.[loopNodeId] || null;
  if (!loopMeta || !loopState) {
    return;
  }

  loopState.attempt = nextAttempt;
  loopState.status = 'retrying';
  resetNestedLoopStatesForRetry(run, graph, loopNodeId);
  if (isArtifactCollection(loopState.carriedArtifact)) {
    resetCollectionControlStatesForLoop(run, graph, loopNodeId);
  }

  for (const segmentNodeId of loopMeta.segmentExecutionOrder) {
    delete run.resultsByNodeId[segmentNodeId];
    const nodeState = run.nodeStates?.[segmentNodeId];
    if (!nodeState) {
      continue;
    }

    recordNodeAttemptHistory(nodeState);
    nodeState.status = 'queued';
    nodeState.startedAt = null;
    nodeState.finishedAt = null;
    nodeState.message = 'Waiting for attempt ' + nextAttempt + ' of ' + loopState.maxAttempts + '.';
    nodeState.outputs = {};
    nodeState.preview = '';
    nodeState.selectedBranch = '';
    nodeState.destinationPath = '';
    nodeState.validation = null;
    applyNodeLoopState(nodeState, getNodeLoopState(run, graph, segmentNodeId));
    applyNodeCollectionControlState(nodeState, run.collectionControlStates?.[segmentNodeId] || null);
  }
}

function getIncomingEdgesForPortKey(graph, portKey) {
  if (!graph || !portKey) {
    return [];
  }

  const incomingEdges = graph.incomingEdgesByPortKey?.get?.(portKey);
  if (Array.isArray(incomingEdges)) {
    return incomingEdges.filter(Boolean);
  }

  const incomingEdge = graph.incomingEdgeByPortKey?.get?.(portKey);
  return incomingEdge ? [incomingEdge] : [];
}

function getNodeInputArtifacts(nodeId, portId, graph, resultsByNodeId, run = null) {
  if (run) {
    const carriedEntries = getLoopCarriedArtifactsForNodePort(nodeId, portId, graph, run);
    if (carriedEntries.length) {
      const selectedEntry = carriedEntries[carriedEntries.length - 1];
      return [{
        artifact: selectedEntry.artifact,
        edge: null,
        isLoopRetry: true,
        loopMeta: selectedEntry.loopMeta,
        loopState: selectedEntry.loopState,
      }];
    }
  }

  return getIncomingEdgesForPortKey(graph, nodeId + ':' + portId)
    .map((edge) => ({
      artifact: resultsByNodeId[edge.source.nodeId]?.outputs?.[edge.source.portId] || null,
      edge,
    }))
    .filter((entry) => Boolean(entry.artifact));
}

function getNodeInputArtifact(nodeId, portId, graph, resultsByNodeId, run = null) {
  return getNodeInputArtifacts(nodeId, portId, graph, resultsByNodeId, run)[0]?.artifact;
}

function getLoopCarriedArtifactsForNode(nodeId, graph, run) {
  const loopNodeIds = graph.retryLoopNodeIdsByTargetNodeId?.get?.(nodeId);
  if (!Array.isArray(loopNodeIds) || !loopNodeIds.length) {
    return [];
  }

  return loopNodeIds
    .map((loopNodeId) => {
      const loopMeta = graph.retryLoopsByNodeId.get(loopNodeId) || null;
      const loopState = run.loopStates?.[loopNodeId] || null;
      if (!loopMeta || !loopState || loopMeta.retryEntryMode !== 'branchMerge') {
        return null;
      }

      if (Number(loopState.attempt || 1) <= 1 || !loopState.carriedArtifact) {
        return null;
      }

      return {
        artifact: loopState.carriedArtifact,
        loopMeta,
        loopState,
      };
    })
    .filter(Boolean);
}

function getLoopCarriedArtifactForNode(nodeId, graph, run) {
  const carriedEntries = getLoopCarriedArtifactsForNode(nodeId, graph, run);
  return carriedEntries.length ? carriedEntries[carriedEntries.length - 1] : null;
}

function getLoopCarriedArtifactsForNodePort(nodeId, portId, graph, run) {
  const loopNodeIds = graph.retryLoopNodeIdsByTargetNodeId?.get?.(nodeId);
  if (!Array.isArray(loopNodeIds) || !loopNodeIds.length) {
    return [];
  }

  return loopNodeIds
    .map((loopNodeId) => {
      const loopMeta = graph.retryLoopsByNodeId.get(loopNodeId) || null;
      const loopState = run.loopStates?.[loopNodeId] || null;
      if (!loopMeta || !loopState || loopMeta.retryEntryMode !== 'inputPort' || loopMeta.retryEntryPortId !== portId) {
        return null;
      }

      if (Number(loopState.attempt || 1) <= 1 || !loopState.carriedArtifact) {
        return null;
      }

      return {
        artifact: loopState.carriedArtifact,
        loopMeta,
        loopState,
      };
    })
    .filter(Boolean);
}

function resolveRetryLoopTerminationAction(loopMeta, node) {
  return String(loopMeta?.terminationAction || node?.config?.retryTerminationAction || '').trim() === 'complete' ? 'complete' : 'fail';
}

function shouldStopRetryLoopOnRepeatedArtifact(loopMeta, node) {
  const explicitValue = typeof loopMeta?.stopWhenRetryArtifactRepeats === 'boolean'
    ? loopMeta.stopWhenRetryArtifactRepeats
    : node?.config?.stopWhenRetryArtifactRepeats;
  return Boolean(explicitValue);
}

function createArtifactTerminationSignature(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return '';
  }

  const signatureParts = [
    String(artifact.kind || ''),
    String(artifact.text || ''),
    String(artifact.previewText || ''),
    String(artifact.summary || ''),
    String(artifact.fileName || ''),
    String(artifact.mimeType || ''),
    String(artifact.width || ''),
    String(artifact.height || ''),
    String(artifact.sizeBytes || ''),
  ];
  if (isCompositionArtifact(artifact)) {
    const trackSignature = (Array.isArray(artifact?.composition?.tracks) ? artifact.composition.tracks : [])
      .map((track, index) => {
        if (String(track?.kind || '').trim() === 'visual-sequence') {
          return [
            String(index),
            String(track?.role || ''),
            String(track?.itemDurationSeconds || ''),
            (Array.isArray(track?.items) ? track.items : []).map((entry, itemIndex) => [
              String(itemIndex),
              String(entry?.itemId || ''),
              String(entry?.summary || ''),
              createArtifactTerminationSignature(entry?.artifact || null),
            ].join('::')).join('|'),
          ].join('::');
        }

        return [
          String(index),
          String(track?.role || ''),
          createArtifactTerminationSignature(track?.artifact || null),
        ].join('::');
      })
      .join('|');
    return signatureParts.concat([
      String(artifact?.composition?.recipeId || ''),
      String(artifact?.composition?.exportKind || ''),
      trackSignature,
    ]).join('|');
  }

  if (isArtifactCollection(artifact)) {
    const itemSignature = (Array.isArray(artifact.items) ? artifact.items : [])
      .map((entry, index) => {
        const itemArtifact = entry?.artifact || null;
        return [
          String(index),
          String(entry?.itemId || ''),
          String(entry?.summary || ''),
          itemArtifact ? createArtifactTerminationSignature(itemArtifact) : '',
        ].join('::');
      })
      .join('|');
    return signatureParts.concat([
      String(artifact.itemKind || ''),
      String(artifact.itemCount || 0),
      itemSignature,
    ]).join('|');
  }

  const filePath = String(artifact.filePath || '').trim();
  if (!filePath) {
    return signatureParts.join('|');
  }

  try {
    if (!fs.existsSync(filePath)) {
      return signatureParts.join('|');
    }

    const stat = fs.statSync(filePath);
    const hash = crypto.createHash('sha1');
    const maxFullHashBytes = 8 * 1024 * 1024;
    const sampleBytes = 256 * 1024;
    if (stat.size <= maxFullHashBytes) {
      hash.update(fs.readFileSync(filePath));
    } else {
      const descriptor = fs.openSync(filePath, 'r');
      try {
        const headLength = Math.min(sampleBytes, stat.size);
        const headBuffer = Buffer.alloc(headLength);
        fs.readSync(descriptor, headBuffer, 0, headLength, 0);
        hash.update(headBuffer);

        const tailLength = Math.min(sampleBytes, stat.size);
        const tailBuffer = Buffer.alloc(tailLength);
        fs.readSync(descriptor, tailBuffer, 0, tailLength, Math.max(0, stat.size - tailLength));
        hash.update(tailBuffer);
        hash.update(String(stat.size));
      } finally {
        fs.closeSync(descriptor);
      }
    }

    signatureParts.push(hash.digest('hex'));
  } catch (error) {
    signatureParts.push(String(error?.message || 'hash-unavailable'));
  }

  return signatureParts.join('|');
}

function buildCollectionAccumulatorEntryKey(artifact, lineage, sourceRunCount = 0) {
  const sourceNodeId = String(lineage?.sourceNodeId || '').trim();
  const sourcePortId = String(lineage?.sourcePortId || '').trim();
  const artifactSignature = createArtifactTerminationSignature(artifact);
  const normalizedRunCount = Number(sourceRunCount || 0) || 0;
  if (!sourceNodeId && !sourcePortId && !artifactSignature) {
    return '';
  }

  return [sourceNodeId, sourcePortId, String(normalizedRunCount), artifactSignature].join('::');
}

function getRetryLoopAccumulatorCollectionState(node, graph, completeArtifact) {
  if (!node?.id || !graph || !completeArtifact || !isArtifactCollection(completeArtifact)) {
    return null;
  }

  const completeEdges = getIncomingEdgesForPortKey(graph, node.id + ':complete') || [];
  if (completeEdges.length !== 1) {
    return null;
  }

  const completeEdge = completeEdges[0];
  const sourceNode = graph.nodeMap.get(completeEdge.source.nodeId) || null;
  if (!sourceNode || sourceNode.type !== 'collectionAccumulator' || completeEdge.source.portId !== 'collection') {
    return null;
  }

  const accumulation = completeArtifact.accumulation && typeof completeArtifact.accumulation === 'object'
    ? completeArtifact.accumulation
    : null;
  const acceptedCount = Number(accumulation?.acceptedCount || completeArtifact.itemCount || 0) || 0;
  const targetCount = Number(accumulation?.targetCount || acceptedCount || 1) || 1;
  return {
    acceptedCount,
    nodeId: sourceNode.id,
    nodeLabel: String(accumulation?.nodeLabel || sourceNode.label || 'Accumulate Until Target').trim() || 'Accumulate Until Target',
    status: String(accumulation?.status || '').trim() || 'collecting',
    targetCount,
  };
}

function buildRetryLoopAccumulatorProgressMessage(loopNode, accumulatorState, suffix) {
  if (!accumulatorState) {
    return (loopNode?.label || 'Retry Loop') + (suffix ? ' ' + suffix : '.');
  }

  return accumulatorState.nodeLabel + ' is holding ' + accumulatorState.acceptedCount + ' of ' + accumulatorState.targetCount + ' accepted items' + (suffix ? ' ' + suffix : '.');
}
function finalizeRetryLoopTermination({ action, loopState, message, nodeLoopState, retryArtifact, maxAttempts }) {
  const completed = action === 'complete';
  loopState.carriedArtifact = null;
  loopState.lastRetryArtifactSignature = '';
  loopState.status = completed ? 'completed' : 'failed';
  recordLoopHistory(loopState, {
    activeLoops: nodeLoopState.activeLoops,
    attempt: Number(loopState.attempt || 1),
    loopMaxAttempts: maxAttempts,
    loopPathLabel: nodeLoopState.loopPathLabel,
    message,
    preview: retryArtifact ? summarizeArtifact(retryArtifact) : '',
    selectedBranch: 'retry-terminated',
    status: completed ? 'completed' : 'failed',
  });

  if (completed) {
    return {
      message,
      outputs: {
        result: retryArtifact,
      },
      preview: retryArtifact ? summarizeArtifact(retryArtifact) : '',
      selectedBranch: 'retry-terminated',
    };
  }

  throw new Error(message);
}

function getMissingRequiredInputs(node, graph, resultsByNodeId, run = null) {
  const definition = getNodeTypeDefinition(node?.type);
  if (!definition) {
    return [];
  }

  return (definition.inputPorts || [])
    .filter((port) => port.required)
    .filter((port) => getNodeInputArtifacts(node.id, port.id, graph, resultsByNodeId, run).length === 0)
    .map((port) => port.label);
}

async function buildArtifactMessageContentPart(artifact, partType = 'file') {
  const filePath = path.resolve(String(artifact?.filePath || '').trim());
  if (!filePath || !(await fs.pathExists(filePath))) {
    const missingLabel = partType === 'video'
      ? 'video'
      : partType === 'image'
        ? 'image'
        : 'file';
    throw new Error('The ' + missingLabel + ' for this step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  const fallbackMimeType = partType === 'video'
    ? 'video/mp4'
    : partType === 'image'
      ? 'image/png'
      : 'application/octet-stream';
  return {
    type: partType,
    data: (await fs.readFile(filePath)).toString('base64'),
    fileName: String(artifact?.fileName || path.basename(filePath)).trim() || path.basename(filePath),
    mimeType: String(artifact?.mimeType || fallbackMimeType).trim() || fallbackMimeType,
  };
}

async function buildImageMessageContentPart(artifact) {
  return buildArtifactMessageContentPart(artifact, 'image');
}

async function buildVideoMessageContentPart(artifact) {
  return buildArtifactMessageContentPart(artifact, 'video');
}

async function buildFileMessageContentPart(artifact) {
  return buildArtifactMessageContentPart(artifact, 'file');
}

function getArtifactBinaryPartType(artifact, fallbackType = 'file') {
  const partType = String(artifact?.attachmentKind || '').trim().toLowerCase();
  if (partType === 'image' || partType === 'video' || partType === 'file') {
    return partType;
  }

  return fallbackType;
}

function getArtifactReviewLabel(artifact) {
  if (!artifact) {
    return 'artifact';
  }

  if (artifact.kind === PORT_KIND_VIDEO && artifact.previewKind === 'animated-image') {
    return 'animated image';
  }

  if (artifact.kind === PORT_KIND_VIDEO) {
    return 'video';
  }

  if (artifact.kind === PORT_KIND_IMAGE) {
    return artifact.isAnimated ? 'animated image' : 'image';
  }

  if (artifact.kind === PORT_KIND_FILE) {
    return 'file';
  }

  return artifact.kind || 'artifact';
}

async function buildPreferredArtifactMessageContentPart(artifact, fallbackType = 'file') {
  const partType = getArtifactBinaryPartType(artifact, fallbackType);
  if (partType === 'image') {
    return buildImageMessageContentPart(artifact);
  }

  if (partType === 'video') {
    return buildVideoMessageContentPart(artifact);
  }

  return buildFileMessageContentPart(artifact);
}

function uniqueKinds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function getLlmPromptCapabilityProfile(node) {
  const executionMode = node?.config?.executionMode === 'ollama'
    ? 'ollama'
    : node?.config?.executionMode === 'localTool'
      ? 'localTool'
      : 'cloud';
  const operationId = executionMode === 'localTool'
    ? getModelStepOperationId(node)
    : PIPELINE_OPERATION_IDS.LLM_PROMPT;
  const providerId = String(node?.config?.providerId || '').trim();
  const modelId = String(node?.config?.model || '').trim();
  const capability = executionMode === 'ollama'
    ? getToolPipelineOperation('ollama', PIPELINE_OPERATION_IDS.LLM_PROMPT)
    : executionMode === 'cloud' && providerId
      ? getProviderModelCapabilities(providerId, modelId)?.operations?.[operationId] || getProviderPipelineOperation(providerId, operationId)
      : executionMode === 'cloud'
        ? getProviderPipelineOperation('', operationId)
        : null;
  const inputKinds = uniqueKinds(capability?.inputKinds || []);
  const directKinds = uniqueKinds(Array.isArray(capability?.directInputKinds) && capability.directInputKinds.length ? capability.directInputKinds : inputKinds);
  return {
    capability: capability || null,
    directKinds,
    inputKinds,
  };
}

function getValidationCapabilityProfile(node) {
  const capability = node?.config?.llmExecutionMode === 'ollama'
    ? getToolPipelineOperation('ollama', PIPELINE_OPERATION_IDS.VALIDATION_LLM)
    : getProviderPipelineOperation(String(node?.config?.providerId || '').trim(), PIPELINE_OPERATION_IDS.VALIDATION_LLM);
  const inputKinds = uniqueKinds(capability?.inputKinds || []);
  const directKinds = uniqueKinds(Array.isArray(capability?.directInputKinds) && capability.directInputKinds.length ? capability.directInputKinds : inputKinds);
  const derivedKinds = uniqueKinds(capability?.derivedInputKinds || []);
  return {
    capability: capability || null,
    derivedKinds,
    directKinds,
    inputKinds,
  };
}

function getValidationEvidenceModeLabel(reviewContext = {}) {
  switch (String(reviewContext?.evidenceMode || '').trim()) {
    case 'direct-image':
      return 'The validator can inspect the attached image directly.';
    case 'direct-video':
      return 'The validator can inspect the attached video directly.';
    case 'direct-animated-image':
      return 'The validator can inspect the attached animated image directly as motion evidence.';
    case 'direct-file':
      return 'The validator can inspect the attached file directly.';
    case 'derived-file-text':
      return 'The validator cannot open the raw file directly here, so Local AI Hub is sending extracted document text and metadata.';
    case 'derived-image-description':
      return 'The validator is relying on extracted image description and metadata instead of a direct image attachment.';
    case 'structured-collection':
      return 'The validator is reviewing an ordered collection as a whole using Local AI Hub collection evidence.';
    case 'structured-plan':
      return 'The validator is reviewing a structured Plan artifact with Local AI Hub plan-review evidence.';
    case 'whole-collection-review':
      return 'The validator is paused so you can review the ordered collection as a whole.';
    case 'text-only':
      return 'The validator is reviewing plain text only.';
    default:
      return 'The validator is reviewing metadata and any extracted supporting context only.';
  }
}

function getUserValidationEvidenceMode(artifact, planReview) {
  if (isArtifactCollection(artifact)) {
    return 'whole-collection-review';
  }

  return planReview ? 'structured-plan' : 'user-review';
}
function canAttachValidationFileDirectly(node, artifact, profile) {
  if (!profile?.directKinds?.includes(PORT_KIND_FILE) || !artifact?.filePath || node?.config?.llmExecutionMode === 'ollama') {
    return false;
  }

  const providerId = String(node?.config?.providerId || '').trim().toLowerCase();
  if (providerId === 'google') {
    return true;
  }

  return providerId === 'anthropic' && String(artifact?.mimeType || '').trim().toLowerCase() === 'application/pdf';
}

function canAttachValidationVideoDirectly(node, artifact, profile) {
  return Boolean(
    profile?.directKinds?.includes(PORT_KIND_VIDEO)
      && artifact?.filePath
      && node?.config?.llmExecutionMode !== 'ollama'
      && String(node?.config?.providerId || '').trim().toLowerCase() === 'google',
  );
}

function buildValidationPrompt(node, artifactDescription, reviewContext) {
  const ruleset = String(node.config?.ruleset || '').trim() || 'Decide whether this artifact should pass or fail based on the available evidence.';
  const sections = [
    'Validation rules:\n' + ruleset,
    reviewContext?.artifactKind === PORT_KIND_COLLECTION
      ? 'Collection scope:\nReview the ordered collection as a whole. Do not fan out into separate per-item pass or fail decisions unless the ruleset explicitly asks for commentary about individual items.'
      : '',
    'Evidence mode:\n' + getValidationEvidenceModeLabel(reviewContext),
    reviewContext?.limitations?.length ? 'Evidence limitations:\n- ' + reviewContext.limitations.join('\n- ') : '',
    'Artifact to review:\n' + artifactDescription,
    reviewContext?.attachedPartTypes?.length
      ? 'The actual ' + reviewContext.attachedPartTypes.join(' and ') + ' evidence is attached below. Review the attachment first and use the details above as supporting context.'
      : 'No binary attachment is included for this review. Use only the evidence described above.',
    'Return JSON only.',
  ].filter(Boolean);
  return sections.join('\n\n');
}
async function buildLlmMessages(node, inputArtifact) {
  const instruction = String(node.config?.instruction || '').trim();
  const systemPrompt = String(node.config?.systemPrompt || '').trim();
  const capabilityProfile = getLlmPromptCapabilityProfile(node);
  const messages = [];

  if (!inputArtifact) {
    throw new Error('This LLM step did not receive any input.');
  }

  if (systemPrompt) {
    messages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  if (inputArtifact.kind === PORT_KIND_TEXT) {
    const normalizedInput = String(inputArtifact.text || '').trim();
    if (!normalizedInput) {
      throw new Error('This LLM step did not receive any text input.');
    }

    messages.push({
      role: 'user',
      content: instruction ? instruction + '\n\nInput:\n' + normalizedInput : normalizedInput,
    });
    return messages;
  }

  if (inputArtifact.kind === PORT_KIND_IMAGE && inputArtifact.filePath) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: instruction || 'Describe this image in plain English.',
        },
        await buildImageMessageContentPart(inputArtifact),
      ],
    });
    return messages;
  }

  if ((inputArtifact.kind === PORT_KIND_FILE || inputArtifact.kind === PORT_KIND_VIDEO) && inputArtifact.filePath) {
    if (!capabilityProfile.directKinds.includes(inputArtifact.kind)) {
      throw new Error(
        inputArtifact.kind === PORT_KIND_VIDEO
          ? 'This model step does not accept video input with the selected target.'
          : 'This model step does not accept file input with the selected target.',
      );
    }

    const artifactDescription = await describeArtifactForLlm(inputArtifact);
    const attachmentPartType = inputArtifact.kind === PORT_KIND_VIDEO
      ? getArtifactBinaryPartType(inputArtifact, 'video')
      : getArtifactBinaryPartType(inputArtifact, 'file');
    const attachment = await buildPreferredArtifactMessageContentPart(inputArtifact, inputArtifact.kind === PORT_KIND_VIDEO ? 'video' : 'file');
    const reviewLabel = inputArtifact.kind === PORT_KIND_VIDEO && attachmentPartType === 'image'
      ? 'animated image'
      : getArtifactReviewLabel(inputArtifact);
    const defaultPrompt = 'Review this ' + reviewLabel + ' and respond in plain English.';

    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: (instruction || defaultPrompt) + '\n\nArtifact details:\n' + artifactDescription,
        },
        attachment,
      ],
    });
    return messages;
  }

  throw new Error('This LLM step currently supports only the artifact types allowed by the selected provider or model mode.');
}

function collectStructuredReplyCandidates(replyText) {
  const raw = String(replyText || '').trim();
  if (!raw) {
    return [];
  }

  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized || candidates.includes(normalized)) {
      return;
    }
    candidates.push(normalized);
  };

  pushCandidate(raw);

  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    pushCandidate(match[1]);
  }

  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    pushCandidate(objectMatch[0]);
  }

  return candidates;
}

function parsePlannerReply(schemaId, replyText) {
  const raw = String(replyText || '').trim();
  if (!raw) {
    throw new Error('The planner returned an empty reply.');
  }

  let schemaError = '';
  for (const candidate of collectStructuredReplyCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate);
      const validation = validatePlanAgainstSchema(schemaId, parsed);
      if (validation.ok) {
        return validation.value;
      }

      schemaError = validation.errors[0] || 'The planner reply did not match the expected plan shape.';
    } catch {
      continue;
    }
  }

  if (schemaError) {
    throw new Error(schemaError);
  }

  throw new Error('The planner reply was not valid JSON. Ask the model to return JSON only for this planner step.');
}

function buildPlanValidationReview(artifact) {
  if (!artifact || String(artifact.kind || '').trim() !== PORT_KIND_PLAN) {
    return null;
  }

  try {
    return buildPlanReviewDocument(artifact.plan || {}, {
      sourcePacket: artifact.sourcePacket || null,
    });
  } catch (error) {
    return {
      findings: [{
        approximate: false,
        category: 'schema-validation',
        detail: error?.message || 'Local AI Hub could not review this plan shape.',
        heuristic: 'schema-validation',
        sceneId: '',
        sceneLabel: '',
        severity: 'error',
        title: 'Plan review could not run',
      }],
      heuristicsUsed: ['Planning schema validation'],
      limitationNote: 'Local AI Hub could not complete the bounded plan review because the plan shape was not usable.',
      planTitle: String(artifact.displayName || 'Plan').trim() || 'Plan',
      reviewVersion: 1,
      sceneCount: 0,
      structuralValidation: {
        errors: [error?.message || 'Local AI Hub could not review this plan shape.'],
        ok: false,
        summary: 'The plan does not match the current planning schema shape yet.',
      },
      summary: {
        errorCount: 1,
        infoCount: 0,
        warningCount: 0,
      },
    };
  }
}

function formatPlanReviewEvidence(planReview, maxFindings = 8) {
  if (!planReview || typeof planReview !== 'object') {
    return '';
  }

  const summary = planReview.summary && typeof planReview.summary === 'object' ? planReview.summary : {};
  const findings = Array.isArray(planReview.findings) ? planReview.findings : [];
  const lines = [
    'Plan review summary: ' + [
      Number(summary.errorCount || 0) ? Number(summary.errorCount || 0) + ' error(s)' : '',
      Number(summary.warningCount || 0) ? Number(summary.warningCount || 0) + ' warning(s)' : '',
      Number(summary.infoCount || 0) ? Number(summary.infoCount || 0) + ' note(s)' : '',
    ].filter(Boolean).join(', ') || 'Plan review summary: no bounded findings.',
    planReview.structuralValidation?.summary ? 'Structural check: ' + planReview.structuralValidation.summary : '',
    planReview.limitationNote ? 'Review boundary: ' + planReview.limitationNote : '',
    findings.length ? 'Findings:' : '',
    ...findings.slice(0, maxFindings).map((finding, index) => {
      const sceneLabel = finding?.sceneLabel ? ' [' + finding.sceneLabel + ']' : '';
      const severity = String(finding?.severity || 'info').toUpperCase();
      const detail = String(finding?.detail || '').trim();
      return (index + 1) + '. ' + severity + sceneLabel + ': ' + (finding?.title || 'Finding') + (detail ? ' - ' + detail : '');
    }),
    findings.length > maxFindings ? '...and ' + (findings.length - maxFindings) + ' more finding(s).' : '',
  ].filter(Boolean);

  return lines.join('\n');
}

function attachPlanValidationResult(artifact, validationResult) {
  if (!artifact || String(artifact.kind || '').trim() !== PORT_KIND_PLAN) {
    return artifact;
  }

  const nextArtifact = serializeArtifactForUi(artifact);
  nextArtifact.lastValidation = serializeArtifactForUi(validationResult);
  nextArtifact.summary = summarizeArtifact(nextArtifact);
  return nextArtifact;
}

function getRetryCorrectionArtifactsForNode(nodeId, graph, run) {
  const loopNodeIds = graph?.retryLoopNodeIdsByTargetNodeId?.get?.(nodeId) || [];
  const artifacts = [];
  for (const loopNodeId of loopNodeIds) {
    const loopState = run?.loopStates?.[loopNodeId] || null;
    if (!loopState || Number(loopState.attempt || 1) <= 1 || !loopState.carriedArtifact) {
      continue;
    }

    artifacts.push(loopState.carriedArtifact);
  }

  return artifacts;
}

function buildPlannerRevisionGuidance(correctionArtifacts = []) {
  const failedPlans = (Array.isArray(correctionArtifacts) ? correctionArtifacts : [])
    .filter((artifact) => artifact && String(artifact.kind || '').trim() === PORT_KIND_PLAN);
  if (!failedPlans.length) {
    return '';
  }

  const sections = failedPlans.slice(-2).map((artifact, index) => {
    const validation = artifact.lastValidation && typeof artifact.lastValidation === 'object' ? artifact.lastValidation : null;
    const planReview = validation?.planReview || buildPlanValidationReview(artifact);
    return [
      'Failed plan review ' + (index + 1) + ':',
      validation?.summary || validation?.reason ? 'Validation reason: ' + (validation.summary || validation.reason) : '',
      formatPlanReviewEvidence(planReview, 6),
    ].filter(Boolean).join('\n');
  });

  return [
    'Revise the plan because a downstream validation step routed the previous Plan to Retry.',
    'Keep the same planning schema and source grounding, but address the review evidence below before returning JSON.',
    ...sections,
  ].join('\n\n');
}

function executePlanScenesNode(node, graph, run) {
  const planArtifact = getNodeInputArtifact(node.id, 'plan', graph, run.resultsByNodeId, run);
  if (!planArtifact || String(planArtifact.kind || '').trim() !== PORT_KIND_PLAN) {
    throw new Error('This Plan Scenes step needs a structured Plan input before it can run.');
  }

  const textItems = buildPlanTextCollectionItems(planArtifact.plan || {}, {
    sourcePlan: planArtifact,
  });
  if (!textItems.length) {
    throw new Error('This Plan does not contain any text items to export.');
  }

  const sceneArtifacts = textItems.map((item, index) => createTextArtifact(item.text || '', {
    displayName: item.displayName || 'Plan item ' + String(index + 1),
    role: 'generated',
  }));
  const collection = createArtifactCollection(sceneArtifacts.map((artifact, index) => ({
    artifact,
    lineage: {
      sourceNodeId: node.id,
      sourceNodeLabel: node.label,
      sourcePortId: 'collection',
      sourceRunCount: run.nodeStates?.[node.id]?.runCount || 1,
    },
    itemId: textItems[index]?.itemId || '',
  })), {
    displayName: node.label,
    itemKind: PORT_KIND_TEXT,
    role: 'generated',
  });

  return {
    message: 'Plan Scenes built an ordered text collection with ' + textItems.length + ' item' + (textItems.length === 1 ? '' : 's') + '.',
    outputs: {
      collection,
    },
    preview: summarizeArtifact(collection),
  };
}
function executePlanningPacketNode(node, graph, run, contextMaps) {
  const sourceArtifacts = getNodeInputArtifacts(node.id, 'source', graph, run.resultsByNodeId, run)
    .map((entry) => entry?.artifact || null)
    .filter(Boolean);
  const packetDocument = buildPlanningPacketDocument({
    ...node.config,
    title: node.label,
  }, sourceArtifacts, {
    hardware: contextMaps?.hardware || null,
    schemaId: node.config?.schemaId || DEFAULT_PLANNING_SCHEMA_ID,
  });
  const validation = validatePlanningPacketShape(packetDocument);
  if (!validation.ok) {
    throw new Error(validation.errors[0] || 'This planning packet is not ready yet.');
  }

  const packetArtifact = createPlanningPacketArtifact(validation.value, {
    displayName: node.label,
    role: 'generated',
  });
  const sourceCount = sourceArtifacts.length;
  const schema = getPlanningSchemaDefinition(validation.value.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
  const message = sourceCount > 0
    ? 'Planning Packet organized ' + sourceCount + ' source artifact' + (sourceCount === 1 ? '' : 's') + ' for the ' + (schema?.label || 'plan') + ' workflow.'
    : 'Planning Packet prepared the ' + (schema?.label || 'plan') + ' workflow from the manual source summary.';

  return {
    message,
    outputs: {
      packet: packetArtifact,
    },
    preview: summarizeArtifact(packetArtifact),
  };
}

async function executePlannerNode(node, graph, run, contextMaps, reportProgress) {
  const packetArtifact = getNodeInputArtifact(node.id, 'packet', graph, run.resultsByNodeId, run);
  if (!packetArtifact || String(packetArtifact.kind || '').trim() !== PORT_KIND_PLANNING_PACKET) {
    throw new Error('This Planner step needs a Planning Packet input before it can run.');
  }

  const packetValidation = validatePlanningPacketShape(packetArtifact.packet || {});
  if (!packetValidation.ok) {
    throw new Error(packetValidation.errors[0] || 'This planning packet is not ready yet.');
  }

  const executionMode = node.config?.executionMode === 'ollama' ? 'ollama' : 'cloud';
  const model = String(node.config?.model || '').trim();
  if (!model) {
    throw new Error('Choose or enter a model for the Planner node before running this pipeline.');
  }

  const schemaId = String(node.config?.schemaId || packetValidation.value.schemaId || packetValidation.value?.desiredOutput?.schemaId || DEFAULT_PLANNING_SCHEMA_ID).trim() || DEFAULT_PLANNING_SCHEMA_ID;
  const schema = getPlanningSchemaDefinition(schemaId);
  const plannerRevisionGuidance = buildPlannerRevisionGuidance(getRetryCorrectionArtifactsForNode(node.id, graph, run));
  const plannerGuidance = [node.config?.instruction, plannerRevisionGuidance].map((entry) => String(entry || '').trim()).filter(Boolean).join('\n\n');
  const plannerPrompt = buildPlannerPrompt(schemaId, packetValidation.value, {
    guidance: plannerGuidance,
    systemPrompt: node.config?.systemPrompt,
  });
  const messages = [];
  if (plannerPrompt.systemPrompt) {
    messages.push({
      role: 'system',
      content: plannerPrompt.systemPrompt,
    });
  }
  messages.push({
    role: 'user',
    content: plannerPrompt.userPrompt,
  });

  let providerId = '';
  let providerLabel = 'Cloud provider';
  let reply = '';

  if (executionMode === 'ollama') {
    const ollamaTool = await getInstalledToolOrThrow(
      contextMaps,
      'ollama',
      'Install Ollama before using a local Planner step in a pipeline.',
    );
    reportProgress?.('Sending the planning packet to Ollama for structured scene planning.', 'Running ' + node.label + ' with Ollama...');
    const result = await chatWithOllama(ollamaTool, {
      messages,
      model,
    });
    reply = String(result?.message?.content || '').trim();
    providerLabel = 'Ollama';
  } else {
    providerId = String(node.config?.providerId || '').trim();
    if (!providerId) {
      throw new Error('Choose a connected cloud provider before running this Planner step.');
    }

    const provider = contextMaps?.providersById?.[providerId] || null;
    if (!provider?.isConnected) {
      throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
    }

    providerLabel = String(provider.name || providerId).trim() || providerId;
    reportProgress?.('Sending the planning packet to ' + providerLabel + ' for structured planning.', 'Running ' + node.label + ' with ' + providerLabel + '...');
    const result = await chatWithProvider(providerId, {
      messages,
      model,
      timeoutMessage: providerLabel + ' took too long to answer this planner request. Try again or simplify the planning packet if the delay continues.',
      timeoutMs: PLANNER_PROVIDER_TIMEOUT_MS,
    });
    reply = String(result?.message?.content || '').trim();
  }

  const normalizedPlan = parsePlannerReply(schemaId, reply);
  if (!String(normalizedPlan.title || '').trim() || String(normalizedPlan.title || '').trim().toLowerCase() === 'scene plan') {
    normalizedPlan.title = String(packetValidation.value.title || schema?.label || 'Plan').replace(/\s+packet$/i, '').trim() || (schema?.label || 'Plan');
  }

  const planArtifact = createPlanArtifact(normalizedPlan, {
    displayName: node.label,
    planner: {
      executionMode,
      model,
      nodeId: node.id,
      nodeLabel: node.label,
      providerId,
      providerLabel,
      schemaId,
      schemaLabel: String(schema?.label || 'Plan').trim() || 'Plan',
    },
    role: 'generated',
    sourcePacket: packetValidation.value,
  });
  const sceneCount = Number(planArtifact.sceneCount || normalizedPlan.scenes?.length || 0) || 0;

  return {
    message: providerLabel + ' returned a structured ' + (schema?.label || 'plan').toLowerCase() + ' with ' + sceneCount + ' scene' + (sceneCount === 1 ? '' : 's') + '.',
    outputs: {
      plan: planArtifact,
    },
    preview: summarizeArtifact(planArtifact),
  };
}

function buildImageGenerationPrompt(node, inputArtifact) {
  if (!inputArtifact) {
    throw new Error('This image generation step did not receive any input.');
  }

  if (inputArtifact.kind !== PORT_KIND_TEXT) {
    throw new Error('This image generation step currently needs text input.');
  }

  const promptText = String(inputArtifact.text || '').trim();
  if (!promptText) {
    throw new Error('This image generation step did not receive any text prompt.');
  }

  const promptPrefix = String(node.config?.instruction || '').trim();
  return promptPrefix ? promptPrefix + '\n\nPrompt:\n' + promptText : promptText;

}

async function generateMappedImageArtifact(node, textArtifact, options = {}) {
  const contextMaps = options.contextMaps || {};
  const run = options.run || null;
  const reportProgress = options.reportProgress;
  const itemIndex = Number(options.itemIndex || 0) || 0;
  const itemCount = Number(options.itemCount || 0) || 0;
  const itemLabel = 'item ' + String(itemIndex + 1) + (itemCount ? ' of ' + itemCount : '');
  const prompt = buildImageGenerationPrompt(node, textArtifact);
  const executionMode = node.config?.executionMode === 'localTool'
    ? 'localTool'
    : node.config?.executionMode === 'graphWorkflow'
      ? 'graphWorkflow'
      : 'cloud';

  if (executionMode === 'graphWorkflow') {
    const support = getGraphWorkflowOperationBackendSupport(node, GRAPH_WORKFLOW_OPERATION_BACKEND_IDS.TEXT_TO_IMAGE);
    if (!support.usable) {
      throw new Error(support.message || 'Configure a compatible text-to-image graph workflow before using it for collection mapping.');
    }

    const tool = options.graphWorkflowTool || await getGraphWorkflowBackendToolOrThrow(contextMaps, node, 'collection image mapping');
    const graphNode = buildGraphWorkflowOperationBackendNode(node, {
      label: node.label + ' ' + itemLabel,
    });
    reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' through the configured graph workflow.', 'Running ' + node.label + '...');
    const result = await executeGraphWorkflowNode({
      inputArtifacts: {
        text: createTextArtifact(prompt, {
          displayName: node.label + ' ' + itemLabel,
          role: 'generated',
        }),
      },
      node: graphNode,
      reportProgress,
      runDirectories: run.directories,
      tool,
    });
    const imageArtifact = result?.outputs?.image || null;
    if (!imageArtifact || imageArtifact.kind !== PORT_KIND_IMAGE) {
      throw new Error((tool.name || 'The graph workflow tool') + ' finished the graph workflow, but it did not return an image artifact.');
    }

    return imageArtifact;
  }

  if (executionMode === 'localTool') {
    const tool = options.localTool || await getSelectedImageToolOrThrow(contextMaps, node, 'collection image mapping');
    reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for image generation.', 'Running ' + node.label + '...');
    const generated = await generateImageWithWorkflowTool(tool, {
      cfgScale: node.config?.cfgScale,
      height: node.config?.height,
      model: String(node.config?.model || '').trim(),
      negativePrompt: node.config?.negativePrompt,
      prompt,
      seed: node.config?.seed,
      steps: node.config?.steps,
      width: node.config?.width,
    });
    return saveBase64Artifact(run.directories, generated.base64Image, {
      baseName: node.label + '-item-' + String(itemIndex + 1).padStart(3, '0') + '-' + Date.now(),
      displayName: node.label + ' item ' + String(itemIndex + 1),
      extension: '.png',
      kind: PORT_KIND_IMAGE,
      role: 'generated',
    });
  }

  const providerId = String(node.config?.providerId || '').trim();
  if (!providerId) {
    throw new Error('Choose a connected cloud provider before running this collection map.');
  }
  const model = String(node.config?.model || '').trim();
  if (doesProviderOperationRequireExplicitModel(providerId, PIPELINE_OPERATION_IDS.IMAGE_GENERATE) && !model) {
    throw new Error('Choose or enter an image model before running this collection map.');
  }
  const provider = contextMaps.providersById[providerId] || null;
  if (!provider?.isConnected) {
    throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
  }

  reportProgress?.('Sending ' + itemLabel + ' to ' + provider.name + ' for image generation.', 'Running ' + node.label + '...');
  const result = await runProviderOperation(providerId, {
    background: node.config?.imageBackground,
    model,
    operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
    prompt,
    providerId,
    quality: node.config?.imageQuality,
    size: node.config?.imageSize,
  });
  const base64Image = String(result?.images?.[0]?.base64Data || '').trim();
  if (!base64Image) {
    throw new Error((provider.name || 'The selected provider') + ' finished the request, but it did not return an image.');
  }

  return saveBase64Artifact(run.directories, base64Image, {
    baseName: node.label + '-item-' + String(itemIndex + 1).padStart(3, '0') + '-' + Date.now(),
    displayName: node.label + ' item ' + String(itemIndex + 1),
    extension: '.png',
    kind: PORT_KIND_IMAGE,
    role: 'generated',
  });
}

function getCollectionMapExecutionModeForRun(node) {
  if (node?.config?.executionMode === 'localTool') {
    return 'localTool';
  }
  if (node?.config?.executionMode === 'graphWorkflow') {
    return 'graphWorkflow';
  }
  return 'cloud';
}


const COLLECTION_MAP_TEXT_TO_IMAGE_DEFAULT_INSTRUCTION = 'Generate one image for each text item while preserving the source order.';

function getCollectionMapEffectiveInstruction(node, operationId) {
  const instruction = String(node?.config?.instruction || '').trim();
  if (operationId !== PIPELINE_OPERATION_IDS.IMAGE_GENERATE && instruction === COLLECTION_MAP_TEXT_TO_IMAGE_DEFAULT_INSTRUCTION) {
    return '';
  }
  return instruction;
}

function buildCollectionMapOperationNode(node, operationId) {
  return {
    ...node,
    config: {
      ...(node?.config || {}),
      instruction: getCollectionMapEffectiveInstruction(node, operationId),
    },
  };
}

function buildCollectionMapMetadata(mapping, node, executionMode) {
  const perItemValidation = getCollectionMapPerItemValidationConfig(node);
  return {
    executionMode: String(executionMode || '').trim(),
    inputKind: String(mapping?.inputKind || '').trim(),
    label: String(mapping?.label || node?.label || 'Map Collection').trim(),
    mappingId: String(mapping?.id || node?.config?.mappingId || '').trim(),
    nodeId: String(node?.id || '').trim(),
    nodeLabel: String(node?.label || '').trim(),
    operationId: String(mapping?.operationId || getCollectionMapOperationId(node)).trim(),
    outputKind: String(mapping?.outputKind || getCollectionMapOutputKind(node)).trim(),
    perItemValidation: perItemValidation.enabled ? {
      enabled: true,
      failMode: perItemValidation.failMode,
      maxAttempts: perItemValidation.maxAttempts,
      mode: perItemValidation.mode,
    } : { enabled: false },
    toolId: String(node?.config?.toolId || '').trim(),
    providerId: String(node?.config?.providerId || '').trim(),
  };
}
const COLLECTION_MAP_PER_ITEM_VALIDATION_MAX_ATTEMPTS = 8;

function getCollectionMapPerItemValidationConfig(node) {
  const raw = node?.config?.perItemValidation && typeof node.config.perItemValidation === 'object'
    ? node.config.perItemValidation
    : {};
  const maxAttempts = Math.max(1, Math.min(
    COLLECTION_MAP_PER_ITEM_VALIDATION_MAX_ATTEMPTS,
    Math.floor(Number(raw.maxAttempts || 1) || 1),
  ));
  return {
    enabled: Boolean(raw.enabled),
    failMode: 'fail-fast',
    llmExecutionMode: raw.llmExecutionMode === 'ollama' ? 'ollama' : 'cloud',
    maxAttempts,
    mode: raw.mode === 'user' ? 'user' : 'llm',
    model: String(raw.model || '').trim(),
    providerId: String(raw.providerId || '').trim(),
    retryInstruction: String(raw.retryInstruction || '').trim(),
    ruleset: String(raw.ruleset || '').trim(),
    systemPrompt: String(raw.systemPrompt || '').trim(),
  };
}

function buildCollectionMapValidationNode(node, validationConfig) {
  return {
    id: node.id + ':perItemValidation',
    label: node.label + ' per-item validation',
    type: 'validation',
    config: {
      llmExecutionMode: validationConfig.llmExecutionMode,
      mode: 'llm',
      model: validationConfig.model,
      providerId: validationConfig.providerId,
      ruleset: validationConfig.ruleset,
      systemPrompt: validationConfig.systemPrompt,
    },
  };
}

function assertCollectionMapPerItemValidationSupported(node, outputKind, contextMaps) {
  const validationConfig = getCollectionMapPerItemValidationConfig(node);
  if (!validationConfig.enabled) {
    return validationConfig;
  }

  if (validationConfig.mode === 'user') {
    return validationConfig;
  }

  if (!validationConfig.ruleset) {
    throw new Error('Describe the pass and fail rules before enabling per-item validation for Map Collection.');
  }

  const validationNode = buildCollectionMapValidationNode(node, validationConfig);
  const profile = getValidationCapabilityProfile(validationNode);
  if (!profile.capability || !profile.inputKinds.includes(outputKind)) {
    const targetLabel = validationConfig.llmExecutionMode === 'ollama'
      ? 'Ollama'
      : (contextMaps.providersById[validationConfig.providerId]?.name || 'The selected validator');
    throw new Error(targetLabel + ' cannot validate ' + outputKind + ' items inside Map Collection yet. Choose a validator that supports this output kind or validate the collection after mapping.');
  }

  if (validationConfig.llmExecutionMode === 'ollama') {
    if (!validationConfig.model) {
      throw new Error('Choose or enter an Ollama model for per-item Map Collection validation.');
    }
    return validationConfig;
  }

  const providerId = validationConfig.providerId;
  if (!providerId) {
    throw new Error('Choose a connected cloud provider for per-item Map Collection validation.');
  }
  const provider = contextMaps.providersById[providerId] || null;
  if (!provider?.isConnected) {
    throw new Error('That per-item validation provider is not connected on this PC yet. Open Settings to save its API key first.');
  }
  if (doesProviderOperationRequireExplicitModel(providerId, PIPELINE_OPERATION_IDS.VALIDATION_LLM) && !validationConfig.model) {
    throw new Error('Choose or enter a model for per-item Map Collection validation.');
  }

  return validationConfig;
}

function buildCollectionMapAttemptNode(node, attemptNumber, validationConfig) {
  if (!validationConfig?.retryInstruction || attemptNumber <= 1) {
    return node;
  }

  const instruction = String(node?.config?.instruction || '').trim();
  return {
    ...node,
    config: {
      ...(node?.config || {}),
      instruction: [
        instruction,
        'Retry guidance for this mapped item attempt ' + attemptNumber + ':',
        validationConfig.retryInstruction,
      ].filter(Boolean).join('\n\n'),
    },
  };
}

function buildUserValidationResult(artifact, decision, reviewContext = {}) {
  const selectedBranch = decision?.decision === 'pass' ? 'pass' : 'fail';
  const reason = decision?.comment ? 'User note: ' + decision.comment : 'User selected ' + selectedBranch + '.';
  return {
    decision: selectedBranch,
    evidenceMode: String(reviewContext.evidenceMode || '').trim() || getUserValidationEvidenceMode(artifact, null),
    mode: 'user',
    reason,
    reviewContext: serializeArtifactForUi(reviewContext),
    summary: reason,
  };
}

function buildCollectionMapAttemptMetadata({ attemptNumber, artifact, mapping, node, sourceEntry, sourceIndex, validation, validationMode }) {
  return {
    attemptNumber,
    artifact: artifact ? {
      displayName: String(artifact.displayName || '').trim(),
      fileName: String(artifact.fileName || '').trim(),
      filePath: String(artifact.filePath || '').trim(),
      kind: String(artifact.kind || '').trim(),
      summary: summarizeArtifact(artifact),
    } : null,
    mappingId: String(mapping?.id || node?.config?.mappingId || '').trim(),
    operationId: String(mapping?.operationId || getCollectionMapOperationId(node)).trim(),
    sourceItemId: String(sourceEntry?.itemId || '').trim(),
    sourceItemIndex: sourceIndex,
    validation: validation ? {
      confidence: validation.confidence ?? null,
      decision: String(validation.decision || '').trim(),
      evidenceLimitations: String(validation.evidenceLimitations || '').trim(),
      evidenceMode: String(validation.evidenceMode || '').trim(),
      mode: validationMode || String(validation.mode || '').trim(),
      reason: String(validation.reason || validation.summary || '').trim(),
      summary: String(validation.summary || '').trim(),
    } : null,
    validationMode: validationMode || '',
    validationPassed: validation ? validation.decision === 'pass' : null,
  };
}

async function executeMappedCollectionItemWithPerItemValidation(node, sourceArtifact, options = {}) {
  const validationConfig = options.validationConfig || getCollectionMapPerItemValidationConfig(node);
  const mapping = options.mapping || getCollectionMapMapping(node);
  const outputKind = options.outputKind || getCollectionMapOutputKind(node);
  if (!validationConfig.enabled) {
    const mappedArtifact = await executeMappedCollectionItemArtifact(node, sourceArtifact, options);
    return {
      artifact: mappedArtifact,
      attempts: [],
      validation: null,
    };
  }

  const validationNode = buildCollectionMapValidationNode(node, validationConfig);
  const attempts = [];
  const itemIndex = Number(options.itemIndex || 0) || 0;
  const itemCount = Number(options.itemCount || 0) || 0;
  const sourceEntry = options.sourceEntry || null;
  const itemId = String(sourceEntry?.itemId || '').trim();
  const itemLabel = 'item ' + String(itemIndex + 1) + (itemCount ? ' of ' + itemCount : '') + (itemId ? ' (' + itemId + ')' : '');

  for (let attemptNumber = 1; attemptNumber <= validationConfig.maxAttempts; attemptNumber += 1) {
    const attemptNode = buildCollectionMapAttemptNode(node, attemptNumber, validationConfig);
    const mappedArtifact = await executeMappedCollectionItemArtifact(attemptNode, sourceArtifact, options);
    if (!mappedArtifact || mappedArtifact.kind !== outputKind) {
      throw new Error('The mapped operation finished, but it did not return a ' + outputKind + ' artifact.');
    }

    let review = null;
    if (validationConfig.mode === 'user') {
      const reviewContext = {
        artifactKind: String(mappedArtifact?.kind || '').trim(),
        evidenceMode: getUserValidationEvidenceMode(mappedArtifact, null),
        limitations: [],
        mapCollection: {
          attemptNumber,
          itemCount,
          itemId,
          itemIndex,
          maxAttempts: validationConfig.maxAttempts,
          nodeId: node.id,
          nodeLabel: node.label,
        },
      };
      const decision = await waitForUserValidation(options.run, node, mappedArtifact, {
        attemptNumber,
        itemCount,
        itemId,
        itemIndex,
        maxAttempts: validationConfig.maxAttempts,
        message: 'Paused at ' + node.label + ' for ' + itemLabel + ' attempt ' + attemptNumber + ' of ' + validationConfig.maxAttempts + '. Local AI Hub is waiting for your decision.',
        nodeMessage: 'Waiting for your pass or fail decision for ' + itemLabel + ' attempt ' + attemptNumber + ' of ' + validationConfig.maxAttempts + '.',
        pendingContext: {
          collectionMap: {
            attemptNumber,
            itemCount,
            itemId,
            itemIndex,
            maxAttempts: validationConfig.maxAttempts,
          },
        },
        reviewContext,
      });
      const validation = buildUserValidationResult(mappedArtifact, decision, reviewContext);
      review = {
        selectedBranch: validation.decision === 'pass' ? 'pass' : 'fail',
        validation,
      };
    } else {
      review = await executeLlmValidationReview(validationNode, mappedArtifact, options.contextMaps || {}, options.reportProgress, {
        progressMessage: 'Validating ' + itemLabel + ' attempt ' + attemptNumber + ' of ' + validationConfig.maxAttempts + '.',
        progressTitle: 'Running ' + node.label + ' per-item validation...',
      });
    }
    attempts.push(buildCollectionMapAttemptMetadata({
      attemptNumber,
      artifact: mappedArtifact,
      mapping,
      node,
      sourceEntry,
      sourceIndex: itemIndex,
      validation: review.validation,
      validationMode: validationConfig.mode,
    }));

    if (review.selectedBranch === 'pass') {
      return {
        artifact: mappedArtifact,
        attempts,
        validation: review.validation,
      };
    }

    if (attemptNumber < validationConfig.maxAttempts) {
      const failureReason = review.validation.reason || (validationConfig.mode === 'user' ? 'User selected fail.' : 'The validator selected fail.');
      options.reportProgress?.('Retrying ' + itemLabel + ' after validation failed: ' + failureReason, 'Running ' + node.label + '...');
      continue;
    }

    const reason = review.validation.reason || review.validation.summary || (validationConfig.mode === 'user' ? 'User selected fail.' : 'The validator selected fail.');
    const manualLabel = validationConfig.mode === 'user' ? 'manual ' : '';
    throw new Error('Map Collection item ' + String(itemIndex + 1) + ' of ' + itemCount + (itemId ? ' (' + itemId + ')' : '') + ' failed ' + manualLabel + 'validation after ' + validationConfig.maxAttempts + ' attempt' + (validationConfig.maxAttempts === 1 ? '' : 's') + ': ' + reason);
  }

  throw new Error('Map Collection could not finish validating ' + itemLabel + '.');
}

async function executeMappedCollectionItemArtifact(node, inputArtifact, options = {}) {
  const operationId = getCollectionMapOperationId(node);
  const outputKind = getCollectionMapOutputKind(node);
  const executionMode = getCollectionMapExecutionModeForRun(node);
  const contextMaps = options.contextMaps || {};
  const run = options.run || null;
  const reportProgress = options.reportProgress;
  const itemIndex = Number(options.itemIndex || 0) || 0;
  const itemCount = Number(options.itemCount || 0) || 0;
  const itemLabel = 'item ' + String(itemIndex + 1) + (itemCount ? ' of ' + itemCount : '');
  const operationNode = buildCollectionMapOperationNode(node, operationId);
  const model = String(operationNode.config?.model || '').trim();

  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
    return generateMappedImageArtifact(node, inputArtifact, options);
  }

  if (executionMode === 'graphWorkflow') {
    throw new Error('Configured graph workflow collection mapping is currently limited to text-to-image workflows.');
  }

  if (executionMode === 'localTool') {
    if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
      const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'collection audio generation');
      const audioRequest = await buildAudioGenerationRequest(operationNode, inputArtifact);
      reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for local audio generation.', 'Running ' + node.label + '...');
      const result = await generateAudioWithLocalAudioTool(tool, {
        audioMode: audioRequest.audioMode,
        displayName: node.label + ' item ' + String(itemIndex + 1),
        durationSeconds: audioRequest.durationSeconds,
        model,
        nodeLabel: node.label,
        operationId,
        prompt: audioRequest.prompt,
        reportProgress,
        runDirectories: run.directories,
        sourceAudioArtifact: audioRequest.sourceAudioArtifact,
        sourceAudioPath: audioRequest.sourceAudioPath,
      });
      return result?.outputs?.audio || null;
    }

    if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) {
      const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'collection audio transcription');
      if (!inputArtifact?.filePath || inputArtifact.kind !== PORT_KIND_AUDIO) {
        throw new Error('This mapped transcription item did not receive an audio file.');
      }
      reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for transcription.', 'Running ' + node.label + '...');
      const result = await transcribeWithWhisper(tool, {
        audioPath: inputArtifact.filePath,
        model: model || DEFAULT_WHISPER_MODEL,
      });
      const transcript = String(result?.text || '').trim();
      if (!transcript) {
        throw new Error(tool.name + ' finished, but it did not return any transcript text for this item.');
      }
      return buildWhisperTranscriptArtifact({ ...node, label: node.label + ' item ' + String(itemIndex + 1) }, inputArtifact, result);
    }

    if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
      const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'collection audio transformation');
      const audioRequest = await buildAudioTransformRequest(operationNode, inputArtifact);
      if (!model) {
        throw new Error('Choose an RVC voice model before mapping this audio collection.');
      }
      const selectedVoiceModel = getDownloadedToolModelEntry(tool, model);
      if (Array.isArray(tool?.downloadedModels) && tool.downloadedModels.length && !selectedVoiceModel) {
        throw new Error(tool.name + ' does not have the selected RVC voice model available locally. Refresh the local model list or choose a model file from the weights folder before running this map.');
      }
      reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for local audio transformation.', 'Running ' + node.label + '...');
      const result = await generateAudioWithLocalAudioTool(tool, {
        displayName: node.label + ' item ' + String(itemIndex + 1),
        instruction: audioRequest.instruction,
        model,
        nodeLabel: node.label,
        operationId,
        reportProgress,
        runDirectories: run.directories,
        sourceAudioArtifact: audioRequest.sourceAudioArtifact,
        sourceAudioPath: audioRequest.sourceAudioPath,
        voiceModel: selectedVoiceModel,
      });
      return result?.outputs?.audio || null;
    }

    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
      if (!inputArtifact?.filePath || inputArtifact.kind !== PORT_KIND_IMAGE) {
        throw new Error('This mapped image analysis item did not receive an image file.');
      }
      const tool = await getSelectedImageToolOrThrow(contextMaps, node, 'collection image analysis');
      reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for image analysis.', 'Running ' + node.label + '...');
      const result = await interrogateImageWithWorkflowTool(tool, {
        analysisMode: operationNode.config?.analysisMode || model || 'clip',
        imagePath: inputArtifact.filePath,
      });
      const description = String(result?.text || '').trim();
      if (!description) {
        throw new Error((tool?.name || 'The selected image tool') + ' did not return an image description for this item.');
      }
      return createTextArtifact(description, {
        displayName: node.label + ' item ' + String(itemIndex + 1),
        imageAnalysis: {
          backend: tool?.id || '',
          backendLabel: tool?.name || 'Image analysis tool',
          mode: operationNode.config?.analysisMode || model || 'clip',
          operationId,
          sourceImage: summarizeArtifact(inputArtifact),
        },
        role: 'generated',
      });
    }

    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
      const tool = await getInstalledToolOrThrow(contextMaps, 'upscayl', 'Install Upscayl before using image-to-image Map Collection. FaceFusion collection mapping is deferred until a shared reference image can be configured.');
      const imageRequest = await buildImageTransformRequest(operationNode, inputArtifact, null, tool);
      reportProgress?.('Sending ' + itemLabel + ' to ' + tool.name + ' for local image transformation.', 'Running ' + node.label + '...');
      const result = await generateImageWithLocalImageTool(tool, {
        displayName: node.label + ' item ' + String(itemIndex + 1),
        instruction: imageRequest.instruction,
        model,
        nodeLabel: node.label,
        operationId,
        referenceImageArtifact: null,
        referenceImagePath: '',
        reportProgress,
        runDirectories: run.directories,
        sourceImageArtifact: imageRequest.sourceImageArtifact,
        sourceImagePath: imageRequest.sourceImagePath,
        transformSubtype: imageRequest.transformSubtype,
      });
      return result?.outputs?.image || null;
    }

    throw new Error('Map Collection does not support that local operation yet.');
  }

  const providerId = String(node.config?.providerId || '').trim();
  if (!providerId) {
    throw new Error('Choose a connected cloud provider before running this collection map.');
  }
  if (doesProviderOperationRequireExplicitModel(providerId, operationId) && !model) {
    throw new Error('Choose or enter a model before running this collection map.');
  }
  const provider = contextMaps.providersById[providerId] || null;
  if (!provider?.isConnected) {
    throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
  }

  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
    const audioRequest = await buildCloudAudioGenerationRequest(operationNode, inputArtifact);
    reportProgress?.('Sending ' + itemLabel + ' to ' + provider.name + ' for speech generation.', 'Running ' + node.label + '...');
    const result = await runProviderOperation(providerId, {
      instruction: audioRequest.instruction,
      model,
      operationId,
      prompt: audioRequest.prompt,
      providerId,
      spokenText: audioRequest.spokenText,
      voice: audioRequest.voice,
    });
    const generatedAudio = result?.audios?.[0] || null;
    if (!generatedAudio?.buffer) {
      throw new Error(provider.name + ' finished the request, but it did not return an audio file for this item.');
    }
    return saveBufferArtifact(run.directories, generatedAudio.buffer, {
      audio: {
        bitDepth: generatedAudio.bitDepth,
        channelCount: generatedAudio.channelCount,
        sampleRate: generatedAudio.sampleRate,
      },
      audioGeneration: {
        backend: providerId,
        backendLabel: provider.name,
        mode: 'speech',
        model,
        operationId,
        operationSubtype: 'speech',
        prompt: audioRequest.spokenText,
        voice: generatedAudio.voice || audioRequest.voice,
      },
      baseName: node.label + '-item-' + String(itemIndex + 1).padStart(3, '0') + '-' + Date.now(),
      displayName: node.label + ' item ' + String(itemIndex + 1),
      extension: String(generatedAudio.extension || '.wav').trim() || '.wav',
      kind: PORT_KIND_AUDIO,
      role: 'generated',
    });
  }

  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
    const messages = await buildLlmMessages(operationNode, inputArtifact);
    reportProgress?.('Sending ' + itemLabel + ' to ' + provider.name + ' for image analysis.', 'Running ' + node.label + '...');
    const result = await runProviderOperation(providerId, {
      messages,
      model,
      operationId,
      providerId,
    });
    const content = String(result?.message?.content || '').trim();
    if (!content) {
      throw new Error(provider.name + ' returned an empty image description for this item.');
    }
    return createTextArtifact(content, {
      displayName: node.label + ' item ' + String(itemIndex + 1),
      imageAnalysis: {
        backend: providerId,
        backendLabel: provider.name,
        mode: 'vision',
        model,
        operationId,
        sourceImage: summarizeArtifact(inputArtifact),
      },
      role: 'generated',
    });
  }

  throw new Error('Map Collection does not support that cloud operation yet.');
}

async function executeCollectionMapNode(node, graph, run, contextMaps, reportProgress) {
  const mapping = getCollectionMapMapping(node);
  if (!mapping) {
    throw new Error('Map Collection does not support that input/output operation pair yet. Choose a listed mapping or use an explicit Model Step for a single artifact.');
  }

  const executionMode = getCollectionMapExecutionModeForRun(node);
  const outputKind = getCollectionMapOutputKind(node);
  if (!mapping.modes.includes(executionMode)) {
    throw new Error(mapping.label + ' is not available through the selected execution mode. Choose a supported mode for this mapping.');
  }

  const sourceCollection = getNodeInputArtifact(node.id, 'collection', graph, run.resultsByNodeId, run);
  if (!isArtifactCollection(sourceCollection)) {
    throw new Error('This Map Collection step needs an ordered ' + getCollectionMapInputKind(node) + ' collection before it can run.');
  }
  if (String(sourceCollection.itemKind || '').trim() !== mapping.inputKind) {
    throw new Error('This Map Collection step maps ' + mapping.inputKind + ' collections to ' + mapping.outputKind + ' collections. Connect an ordered ' + mapping.inputKind + ' collection.');
  }

  const sourceItems = Array.isArray(sourceCollection.items) ? sourceCollection.items.filter((entry) => entry?.artifact) : [];
  if (!sourceItems.length) {
    throw new Error('This Map Collection step received an empty collection. Add at least one item before mapping.');
  }

  const graphWorkflowTool = executionMode === 'graphWorkflow'
    ? await getGraphWorkflowBackendToolOrThrow(contextMaps, node, 'collection mapping')
    : null;
  const localTool = executionMode === 'localTool' && mapping.operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
    ? await getSelectedImageToolOrThrow(contextMaps, node, 'collection image mapping')
    : null;
  const validationConfig = assertCollectionMapPerItemValidationSupported(node, outputKind, contextMaps);
  const mappedItems = [];
  for (let index = 0; index < sourceItems.length; index += 1) {
    const entry = sourceItems[index];
    const sourceArtifact = entry?.artifact || null;
    try {
      if (!sourceArtifact || sourceArtifact.kind !== mapping.inputKind) {
        throw new Error('That collection item is not a ' + mapping.inputKind + ' artifact.');
      }
      const mappedResult = await executeMappedCollectionItemWithPerItemValidation(node, sourceArtifact, {
        contextMaps,
        itemCount: sourceItems.length,
        itemIndex: index,
        graphWorkflowTool,
        localTool,
        mapping,
        outputKind,
        reportProgress,
        run,
        sourceEntry: entry,
        validationConfig,
      });
      const mappedArtifact = mappedResult.artifact;
      if (!mappedArtifact || mappedArtifact.kind !== outputKind) {
        throw new Error('The mapped operation finished, but it did not return a ' + outputKind + ' artifact.');
      }
      const itemId = String(entry?.itemId || '').trim();
      mappedItems.push({
        artifact: mappedArtifact,
        attempts: mappedResult.attempts,
        itemId,
        lineage: {
          sourceNodeId: node.id,
          sourceNodeLabel: node.label,
          sourcePortId: 'collection',
          sourcePortLabel: formatArtifactCollectionLineageLabel(outputKind),
          sourceItemId: itemId,
          sourceItemIndex: index,
          parentLineage: entry?.lineage || null,
        },
        validation: mappedResult.validation,
      });
    } catch (error) {
      const itemId = String(entry?.itemId || '').trim();
      const itemLabel = 'item ' + String(index + 1) + ' of ' + sourceItems.length + (itemId ? ' (' + itemId + ')' : '');
      const message = String(error?.message || 'The mapped operation failed.');
      if (/^Map Collection item \d+ of \d+/.test(message)) {
        throw new Error(message);
      }
      throw new Error(node.label + ' failed on ' + itemLabel + ': ' + message);
    }
  }

  const collection = createArtifactCollection(mappedItems, {
    collectionMapping: buildCollectionMapMetadata(mapping, node, executionMode),
    displayName: node.label,
    itemKind: outputKind,
    role: 'generated',
  });
  const persistedCollection = await persistArtifactCollection(run.directories, collection, {
    baseName: node.label,
    displayName: node.label,
    role: 'generated',
    target: 'artifacts',
  });
  return {
    message: node.label + ' mapped ' + persistedCollection.itemCount + ' item' + (persistedCollection.itemCount === 1 ? '' : 's') + ' into an ordered ' + outputKind + ' collection.',
    outputs: {
      collection: persistedCollection,
    },
    preview: summarizeArtifact(persistedCollection),
  };
}

function formatArtifactCollectionLineageLabel(kind) {
  if (kind === PORT_KIND_IMAGE) return 'Image Collection';
  if (kind === PORT_KIND_AUDIO) return 'Audio Collection';
  if (kind === PORT_KIND_VIDEO) return 'Video Collection';
  if (kind === PORT_KIND_FILE) return 'File Collection';
  return 'Text Collection';
}
async function buildVideoGenerationRequest(node, inputArtifact) {
  if (!inputArtifact) {
    throw new Error('This video generation step did not receive any input.');
  }

  const size = String(node.config?.videoSize || '1280x720').trim() || '1280x720';
  const motionPrompt = String(node.config?.instruction || '').trim();

  if (inputArtifact.kind === PORT_KIND_TEXT) {
    const promptText = String(inputArtifact.text || '').trim();
    if (!promptText) {
      throw new Error('This video generation step did not receive any text prompt.');
    }

    return {
      negativePrompt: String(node.config?.negativePrompt || '').trim(),
      prompt: motionPrompt ? motionPrompt + '\n\nPrompt:\n' + promptText : promptText,
      referenceImage: null,
      referenceImagePath: '',
      sourceImageArtifact: null,
      size,
    };
  }

  if (inputArtifact.kind === PORT_KIND_IMAGE && inputArtifact.filePath) {
    if (!motionPrompt) {
      throw new Error('This video generation step is using an image input. Add motion guidance in the instruction box before running it.');
    }

    const filePath = path.resolve(String(inputArtifact.filePath || '').trim());
    if (!filePath || !(await fs.pathExists(filePath))) {
      throw new Error('The reference image for this video step could not be found anymore. Choose it again and rerun the pipeline.');
    }

    const [expectedWidth, expectedHeight] = size.split('x').map((value) => Number(value || 0));
    if (expectedWidth > 0 && expectedHeight > 0 && inputArtifact.width && inputArtifact.height) {
      if (Number(inputArtifact.width) !== expectedWidth || Number(inputArtifact.height) !== expectedHeight) {
        throw new Error('This video step is set to ' + size + ', but the connected image is ' + inputArtifact.width + 'x' + inputArtifact.height + '. Choose a matching video size or supply a matching image.');
      }
    }

    return {
      negativePrompt: String(node.config?.negativePrompt || '').trim(),
      prompt: motionPrompt,
      referenceImage: {
        buffer: await fs.readFile(filePath),
        fileName: String(inputArtifact.fileName || path.basename(filePath)).trim() || path.basename(filePath),
        mimeType: String(inputArtifact.mimeType || 'image/png').trim() || 'image/png',
      },
      referenceImagePath: filePath,
      sourceImageArtifact: inputArtifact,
      size,
    };
  }

  throw new Error('This video generation step currently accepts text or image input only.');
}

async function buildAudioGenerationRequest(node, inputArtifact) {
  if (!inputArtifact) {
    throw new Error('This audio generation step did not receive any input.');
  }

  const audioMode = String(node.config?.audioMode || 'music').trim() === 'sound' ? 'sound' : 'music';
  const durationSeconds = Math.max(1, Number(node.config?.durationSeconds || 8) || 8);
  const instruction = String(node.config?.instruction || '').trim();

  if (inputArtifact.kind === PORT_KIND_TEXT) {
    const promptText = String(inputArtifact.text || '').trim();
    if (!promptText) {
      throw new Error('This audio generation step did not receive any text prompt.');
    }

    return {
      audioMode,
      durationSeconds,
      prompt: instruction ? instruction + '\n\nPrompt:\n' + promptText : promptText,
      sourceAudioArtifact: null,
      sourceAudioPath: '',
    };
  }

  if (inputArtifact.kind === PORT_KIND_AUDIO && inputArtifact.filePath) {
    if (audioMode === 'sound') {
      throw new Error('This audio generation step is set to Sound mode, which currently needs text input. Switch to Music mode to guide generation from an audio file.');
    }

    const sourceAudioPath = path.resolve(String(inputArtifact.filePath || '').trim());
    if (!sourceAudioPath || !(await fs.pathExists(sourceAudioPath))) {
      throw new Error('The source audio for this generation step could not be found anymore. Choose it again and rerun the pipeline.');
    }

    return {
      audioMode,
      durationSeconds,
      prompt: instruction || 'Create music guided by the supplied audio.',
      sourceAudioArtifact: inputArtifact,
      sourceAudioPath,
    };
  }

  throw new Error('This audio generation step currently accepts text input or a source audio file only.');
}

async function buildAudioTransformRequest(node, inputArtifact) {
  if (!inputArtifact) {
    throw new Error('This audio transformation step did not receive any source audio.');
  }

  if (inputArtifact.kind !== PORT_KIND_AUDIO || !inputArtifact.filePath) {
    throw new Error('This audio transformation step currently accepts a source audio file only.');
  }

  const sourceAudioPath = path.resolve(String(inputArtifact.filePath || '').trim());
  if (!sourceAudioPath || !(await fs.pathExists(sourceAudioPath))) {
    throw new Error('The source audio for this transformation step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  return {
    instruction: String(node.config?.instruction || '').trim(),
    sourceAudioArtifact: inputArtifact,
    sourceAudioPath,
  };
}

async function buildImageTransformRequest(node, inputArtifact, referenceArtifact, tool) {
  const toolId = String(tool?.id || node?.config?.toolId || '').trim().toLowerCase();
  const transformSubtype = normalizeImageTransformSubtype(toolId, node.config?.transformSubtype);
  if (!transformSubtype) {
    throw new Error((tool?.name || 'This local image tool') + ' does not support the selected image transform subtype. Choose a supported transform subtype before running this step.');
  }

  if (!inputArtifact) {
    throw new Error('This image transformation step did not receive any source image.');
  }

  if (inputArtifact.kind !== PORT_KIND_IMAGE || !inputArtifact.filePath) {
    throw new Error('This image transformation step currently accepts an image input only.');
  }

  const sourceImagePath = path.resolve(String(inputArtifact.filePath || '').trim());
  if (!sourceImagePath || !(await fs.pathExists(sourceImagePath))) {
    throw new Error('The source image for this transformation step could not be found anymore. Choose it again and rerun the pipeline.');
  }

  let referenceImagePath = '';
  if (referenceArtifact) {
    if (referenceArtifact.kind !== PORT_KIND_IMAGE || !referenceArtifact.filePath) {
      throw new Error('The Reference Image input currently accepts an image file only.');
    }

    referenceImagePath = path.resolve(String(referenceArtifact.filePath || '').trim());
    if (!referenceImagePath || !(await fs.pathExists(referenceImagePath))) {
      throw new Error('The reference image for this transformation step could not be found anymore. Choose it again and rerun the pipeline.');
    }
  }

  if (toolId === 'facefusion' && !referenceImagePath) {
    throw new Error('FaceFusion needs a source face image on the Reference Image input before it can transform the target image.');
  }

  return {
    instruction: String(node.config?.instruction || '').trim(),
    referenceImageArtifact: referenceArtifact || null,
    referenceImagePath,
    sourceImageArtifact: inputArtifact,
    sourceImagePath,
    transformSubtype,
  };
}

async function buildCloudAudioGenerationRequest(node, inputArtifact) {
  if (!inputArtifact) {
    throw new Error('This cloud audio step did not receive any input.');
  }

  if (inputArtifact.kind !== PORT_KIND_TEXT) {
    throw new Error('This cloud audio step currently accepts text input only.');
  }

  const spokenText = String(inputArtifact.text || '').trim();
  if (!spokenText) {
    throw new Error('This cloud audio step did not receive any text to speak.');
  }

  const instruction = String(node.config?.instruction || '').trim();
  const voice = String(node.config?.audioVoice || '').trim();
  return {
    instruction,
    prompt: instruction ? instruction + '\n\nSpeak this text exactly:\n' + spokenText : spokenText,
    spokenText,
    voice,
  };
}

async function buildValidationMessages(node, artifact, contextMaps) {
  const systemPrompt = String(node.config?.systemPrompt || '').trim();
  const artifactDescription = await buildValidationArtifactDescription(artifact, contextMaps);
  const profile = getValidationCapabilityProfile(node);
  const attachments = [];
  const limitations = [];
  const planReview = buildPlanValidationReview(artifact);
  let evidenceMode = artifact?.kind === PORT_KIND_TEXT ? 'text-only' : artifact?.kind === PORT_KIND_PLAN ? 'structured-plan' : 'summary-only';

  if (isArtifactCollection(artifact)) {
    evidenceMode = 'structured-collection';
    if (artifact?.itemKind === PORT_KIND_FILE) {
      limitations.push('This validator is reviewing the ordered collection as a whole through collection metadata and extracted per-file evidence when available. It is not opening every file as a separate attachment in this step.');
    } else if (artifact?.itemKind === PORT_KIND_IMAGE || artifact?.itemKind === PORT_KIND_VIDEO || artifact?.itemKind === PORT_KIND_AUDIO) {
      limitations.push('This validator is reviewing the ordered collection as a whole through collection metadata and per-item summaries. It is not inspecting every media item as a separate attachment in this step.');
    }
  } else if (artifact?.kind === PORT_KIND_IMAGE) {
    if (profile.directKinds.includes(PORT_KIND_IMAGE) && artifact.filePath) {
      attachments.push(await buildImageMessageContentPart(artifact));
      evidenceMode = 'direct-image';
    } else {
      limitations.push('The selected validator cannot inspect the raw image directly in this step.');
      evidenceMode = 'derived-image-description';
    }
  } else if (artifact?.kind === PORT_KIND_VIDEO) {
    if (canAttachValidationVideoDirectly(node, artifact, profile)) {
      const attachmentPartType = getArtifactBinaryPartType(artifact, 'video');
      attachments.push(await buildPreferredArtifactMessageContentPart(artifact, 'video'));
      evidenceMode = attachmentPartType === 'image' ? 'direct-animated-image' : 'direct-video';
    } else {
      limitations.push('The selected validator cannot inspect this ' + getArtifactReviewLabel(artifact) + ' directly in this step. Only metadata and any extracted notes below are available.');
    }
  } else if (artifact?.kind === PORT_KIND_FILE) {
    if (canAttachValidationFileDirectly(node, artifact, profile)) {
      attachments.push(await buildFileMessageContentPart(artifact));
      evidenceMode = 'direct-file';
      if (String(artifact.previewText || '').trim()) {
        limitations.push('Use the attached file as the primary evidence. The extracted preview below is only supporting context.');
      }
    } else if (profile.derivedKinds.includes(PORT_KIND_FILE)) {
      limitations.push('The selected validator will review extracted document text and metadata. It will not inspect the raw file directly in this step.');
      evidenceMode = 'derived-file-text';
    } else {
      limitations.push('This validator can only use the metadata and preview text below for this file.');
    }
  }

  const reviewContext = {
    artifactKind: String(artifact?.kind || '').trim(),
    attachedPartTypes: attachments.map((part) => part.type),
    derivedKinds: profile.derivedKinds,
    directKinds: profile.directKinds,
    evidenceMode,
    limitations,
    planReview: planReview ? serializeArtifactForUi(planReview) : null,
  };

  const messages = [];
  messages.push({
    role: 'system',
    content:
      (systemPrompt ? systemPrompt + '\n\n' : '')
      + 'Return only valid JSON with keys decision, reason, summary, confidence, evidenceMode, evidenceLimitations, and criteriaResults. '
      + 'decision must be "pass" or "fail". confidence must be a number between 0 and 1. '
      + 'criteriaResults must be an array of objects with criterion, decision, and reason.',
  });
  messages.push({
    role: 'user',
    content: attachments.length
      ? [
          {
            type: 'text',
            text: buildValidationPrompt(node, artifactDescription, reviewContext),
          },
          ...attachments,
        ]
      : buildValidationPrompt(node, artifactDescription, reviewContext),
  });

  return {
    messages,
    reviewContext,
  };
}
function clampValidationConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.min(1, Math.max(0, numeric));
}

function normalizeValidationCriteriaResults(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const criterion = String(entry?.criterion || entry?.name || '').trim();
      const decision = String(entry?.decision || entry?.result || '').trim().toLowerCase();
      const reason = String(entry?.reason || entry?.explanation || '').trim();
      if (!criterion && !reason) {
        return null;
      }

      return {
        criterion,
        decision: decision === 'pass' || decision === 'fail' ? decision : '',
        reason,
      };
    })
    .filter(Boolean);
}

function parseValidationDecision(replyText) {
  const raw = String(replyText || '').trim();
  if (!raw) {
    throw new Error('The validator returned an empty reply.');
  }

  const candidates = [raw];
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    candidates.unshift(objectMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const decision = String(parsed?.decision || parsed?.result || '').trim().toLowerCase();
      if (decision === 'pass' || decision === 'fail') {
        return {
          confidence: clampValidationConfidence(parsed?.confidence ?? parsed?.score),
          criteriaResults: normalizeValidationCriteriaResults(parsed?.criteriaResults || parsed?.criteria || parsed?.checks),
          decision,
          evidenceLimitations: String(parsed?.evidenceLimitations || parsed?.limitations || '').trim(),
          evidenceMode: String(parsed?.evidenceMode || parsed?.reviewMode || '').trim(),
          reason: String(parsed?.reason || parsed?.explanation || parsed?.summary || raw).trim(),
          summary: String(parsed?.summary || parsed?.overallSummary || '').trim(),
        };
      }
    } catch {
      continue;
    }
  }

  const match = raw.match(/\b(pass|fail)\b/i);
  if (!match) {
    throw new Error('The validator reply did not clearly say pass or fail.');
  }

  return {
    confidence: null,
    criteriaResults: [],
    decision: match[1].toLowerCase(),
    evidenceLimitations: '',
    evidenceMode: '',
    reason: raw,
    summary: '',
  };
}

function buildValidationPreview(parsed, reviewContext) {
  const parts = [String(parsed?.decision || '').trim().toUpperCase()];
  if (parsed?.summary) {
    parts.push(parsed.summary);
  } else if (parsed?.reason) {
    parts.push(parsed.reason);
  }

  if (reviewContext?.evidenceMode && reviewContext.evidenceMode !== 'text-only') {
    parts.push(getValidationEvidenceModeLabel(reviewContext));
  }

  return trimPreviewText(parts.filter(Boolean).join(' | '), 220);
}

function buildWhisperTranscriptArtifact(node, audioArtifact, result = {}) {
  const segments = (Array.isArray(result?.segments) ? result.segments : [])
    .map((segment) => ({
      end: Number.isFinite(Number(segment?.end)) ? Math.round(Number(segment.end) * 100) / 100 : null,
      start: Number.isFinite(Number(segment?.start)) ? Math.round(Number(segment.start) * 100) / 100 : null,
      text: String(segment?.text || '').trim(),
    }))
    .filter((segment) => segment.text);
  const durationSeconds = Number(result?.durationSeconds || 0);
  const transcription = {
    backend: 'whisper',
    backendLabel: 'Whisper (faster-whisper)',
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 100) / 100 : null,
    language: String(result?.language || '').trim() || 'unknown',
    model: String(result?.model || node?.config?.model || DEFAULT_WHISPER_MODEL).trim() || DEFAULT_WHISPER_MODEL,
    runtime: {
      computeType: String(result?.computeType || '').trim(),
      device: String(result?.device || '').trim(),
    },
    segmentCount: segments.length,
    segments,
    sourceAudio: audioArtifact ? {
      displayName: audioArtifact.displayName || '',
      fileName: audioArtifact.fileName || '',
      filePath: audioArtifact.filePath || '',
      fileUrl: audioArtifact.fileUrl || '',
      formatLabel: audioArtifact.formatLabel || '',
      kind: audioArtifact.kind || 'audio',
      mimeType: audioArtifact.mimeType || '',
      sizeBytes: Number(audioArtifact.sizeBytes || 0) || 0,
      summary: audioArtifact.summary || '',
    } : null,
  };

  if (!transcription.runtime.computeType && !transcription.runtime.device) {
    delete transcription.runtime;
  }

  return createTextArtifact(String(result?.text || ''), {
    displayName: node.label,
    role: 'generated',
    transcription,
  });
}

function buildWhisperCompletionMessage(result = {}) {
  const details = [];
  const language = String(result?.language || '').trim();
  if (language && language.toLowerCase() !== 'unknown') {
    details.push('detected ' + language);
  }

  const device = String(result?.device || '').trim();
  const computeType = String(result?.computeType || '').trim();
  if (device) {
    details.push('used ' + device + (computeType ? ' ' + computeType : ''));
  }

  return details.length
    ? 'Whisper finished transcribing the audio file and ' + details.join(', ') + '.'
    : 'Whisper finished transcribing the audio file.';
}

async function getInstalledToolOrThrow(contextMaps, toolId, message) {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  const currentTool = await getResolvedToolState(normalizedToolId, {
    syncDiscovered: true,
  }).catch(() => null);
  const tool = currentTool || contextMaps.toolsById[normalizedToolId] || null;
  if (!tool) {
    throw new Error(message);
  }

  contextMaps.toolsById[normalizedToolId] = tool;
  return tool;
}

async function getGraphWorkflowBackendToolOrThrow(contextMaps, node, actionLabel) {
  const support = getGraphWorkflowOperationBackendSupport(node, GRAPH_WORKFLOW_OPERATION_BACKEND_IDS.TEXT_TO_IMAGE);
  if (!support.usable) {
    throw new Error(support.message || 'Configure a compatible text-to-image graph workflow before using it for ' + actionLabel + '.');
  }

  const label = support.contract?.toolId === 'comfyui'
    ? 'ComfyUI'
    : support.contract?.toolId === 'invokeai'
      ? 'InvokeAI'
      : 'the selected graph workflow tool';
  return getInstalledToolOrThrow(
    contextMaps,
    support.toolId,
    'Install ' + label + ' before using this graph workflow for ' + actionLabel + '.',
  );
}

async function getSelectedImageToolOrThrow(contextMaps, node, actionLabel) {
  const operationId = getLocalImageBackendOperationId(node, PIPELINE_OPERATION_IDS.IMAGE_GENERATE);
  const selection = selectLocalImageBackend(contextMaps, node, { operationId });
  const selectedTool = selection.tool || resolveSelectedImageTool(contextMaps, node);
  if (!selectedTool?.id || !selection.usable) {
    throw new Error(selection.message || 'No usable local image generation backend is ready. Install or repair Forge or Automatic1111, then refresh checkpoints.');
  }

  return getInstalledToolOrThrow(
    contextMaps,
    selectedTool.id,
    selection.message || 'Install or repair Forge or Automatic1111 before using the ' + actionLabel + ' step.',
  );
}

async function getSelectedLocalVideoToolOrThrow(contextMaps, node, actionLabel) {
  const selectedToolId = String(node?.config?.toolId || 'wan21-webui').trim().toLowerCase() || 'wan21-webui';
  return getInstalledToolOrThrow(
    contextMaps,
    selectedToolId,
    `Install Wan2.1 WebUI before using the ${actionLabel} step.`,
  );
}

async function getSelectedLocalAudioToolOrThrow(contextMaps, node, actionLabel) {
  const operationId = getModelStepOperationId(node);
  const fallbackToolId = operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
    ? 'whisper'
    : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
      ? 'rvc'
      : 'audiocraft-webui';
  const selectedToolId = String(getModelStepLocalToolId(node, contextMaps) || fallbackToolId).trim().toLowerCase() || fallbackToolId;
  const installMessage = operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
    ? 'Install Whisper before using the ' + actionLabel + ' step.'
    : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
      ? 'Install RVC before using the ' + actionLabel + ' step.'
      : 'Install AudioCraft WebUI before using the ' + actionLabel + ' step.';
  return getInstalledToolOrThrow(
    contextMaps,
    selectedToolId,
    installMessage,
  );
}

async function getSelectedLocalImageToolOrThrow(contextMaps, node, actionLabel) {
  const fallbackToolId = 'upscayl';
  const selectedToolId = String(getModelStepLocalToolId(node, contextMaps) || fallbackToolId).trim().toLowerCase() || fallbackToolId;
  const installMessage = selectedToolId === 'facefusion'
    ? 'Install FaceFusion before using the ' + actionLabel + ' step.'
    : 'Install Upscayl or FaceFusion before using the ' + actionLabel + ' step.';
  return getInstalledToolOrThrow(
    contextMaps,
    selectedToolId,
    installMessage,
  );
}

async function buildValidationArtifactDescription(artifact, contextMaps) {
  let description = await describeArtifactForLlm(artifact);
  if (artifact?.kind === PORT_KIND_PLAN) {
    const planReviewEvidence = formatPlanReviewEvidence(buildPlanValidationReview(artifact));
    if (planReviewEvidence) {
      description += '\n\nLocal AI Hub plan-review evidence:\n' + planReviewEvidence;
    }
  }

  if (artifact?.kind === PORT_KIND_COLLECTION) {
    if (artifact?.itemKind === PORT_KIND_FILE) {
      description += '\n\nLocal AI Hub is validating this ordered collection as a whole. Per-file extracted text is included when available, but the raw files are not attached one by one in this pass.';
    } else if (artifact?.itemKind === PORT_KIND_IMAGE || artifact?.itemKind === PORT_KIND_VIDEO || artifact?.itemKind === PORT_KIND_AUDIO) {
      description += '\n\nLocal AI Hub is validating this ordered collection as a whole using collection metadata and per-item summaries. It is not attaching every media item separately in this pass.';
    } else {
      description += '\n\nLocal AI Hub is validating this ordered collection as a whole rather than fanning out into separate per-item validation passes.';
    }
  }

  if (artifact?.kind === PORT_KIND_IMAGE && artifact.isAnimated) {
    description = `${description}\n\nThis image is animated rather than a single still frame.`;
  }

  if (artifact?.kind === PORT_KIND_IMAGE && artifact.filePath) {
    const imageTool = resolveSelectedImageTool(contextMaps, { config: {} });
    if (imageTool && String(imageTool.status || '').toLowerCase() === 'running') {
      try {
        const caption = await interrogateImageWithWorkflowTool(imageTool, {
          analysisMode: 'clip',
          imagePath: artifact.filePath,
        });
        description = `${description}\n\nDetected image description:\n${caption.text}`;
      } catch {
        // Fall back to file metadata when the image tool is unavailable.
      }
    }
  }

  if (artifact?.kind === PORT_KIND_FILE) {
    if (String(artifact.previewText || '').trim()) {
      description = `${description}\n\nExtracted document text:\n${artifact.previewText}`;
    } else {
      description = `${description}\n\nNo text excerpt could be extracted from this file in Local AI Hub.`;
    }
  }

  if (artifact?.kind === PORT_KIND_VIDEO) {
    description = artifact.previewKind === 'animated-image'
      ? `${description}\n\nThis motion artifact is stored as an animated image file rather than an mp4-style video container. Validators without direct motion support only receive the metadata above.`
      : `${description}\n\nLocal AI Hub does not extract video frames in this build. Validators without direct video support only receive the metadata above.`;
  }

  return description;
}
async function waitForUserValidation(run, node, artifact, options = {}) {
  if (pendingValidationControl) {
    throw new Error('Local AI Hub is already waiting on another validation decision.');
  }

  const nodeState = run.nodeStates[node.id];
  const planReview = buildPlanValidationReview(artifact);
  const reviewContext = options.reviewContext && typeof options.reviewContext === 'object'
    ? options.reviewContext
    : null;
  const evidenceMode = String(reviewContext?.evidenceMode || '').trim() || getUserValidationEvidenceMode(artifact, planReview);
  const iteration = Number(options.attemptNumber || nodeState?.iteration || 1) || 1;
  const loopMaxAttempts = Number(options.maxAttempts || nodeState?.loopMaxAttempts || 0) || null;
  const loopPathLabel = String(nodeState?.loopPathLabel || '').trim();
  const mapContext = options.pendingContext?.collectionMap || null;
  const mapAttemptLabel = mapContext
    ? 'Map item ' + String(Number(mapContext.itemIndex || 0) + 1) + ' of ' + mapContext.itemCount + (mapContext.itemId ? ' (' + mapContext.itemId + ')' : '') + ' | Attempt ' + mapContext.attemptNumber + ' of ' + mapContext.maxAttempts
    : '';
  const attemptLabel = mapAttemptLabel || loopPathLabel || (loopMaxAttempts ? 'Attempt ' + iteration + ' of ' + loopMaxAttempts : iteration > 1 ? 'Attempt ' + iteration : '');
  const pendingValidation = {
    activeLoops: cloneLoopContexts(nodeState?.activeLoops),
    artifact: serializeArtifactForUi(artifact),
    collectionMap: mapContext ? serializeArtifactForUi(mapContext) : null,
    iteration,
    loopMaxAttempts,
    loopPathLabel,
    mode: 'user',
    nodeId: node.id,
    planReview: planReview ? serializeArtifactForUi(planReview) : null,
    reviewContext: reviewContext ? serializeArtifactForUi(reviewContext) : {
      artifactKind: String(artifact?.kind || '').trim(),
      evidenceMode,
      limitations: [],
      planReview: planReview ? serializeArtifactForUi(planReview) : null,
    },
    nodeLabel: node.label,
    requestId: createUniqueId('validation'),
    requestedAt: new Date().toISOString(),
  };

  const decision = await new Promise((resolve) => {
    pendingValidationControl = {
      nodeId: node.id,
      requestId: pendingValidation.requestId,
      resolve,
      runId: run.runId,
    };
    run.status = 'paused';
    run.message = options.message || (attemptLabel
      ? `Paused at ${node.label} (${attemptLabel}). Local AI Hub is waiting for your decision.`
      : `Paused at ${node.label}. Local AI Hub is waiting for your decision.`);
    run.pendingValidation = pendingValidation;
    nodeState.status = 'paused';
    nodeState.message = options.nodeMessage || (attemptLabel
      ? 'Waiting for your pass or fail decision for ' + attemptLabel.toLowerCase() + '.'
      : 'Waiting for your pass or fail decision.');
    nodeState.pendingValidationContext = mapContext ? serializeArtifactForUi({ collectionMap: mapContext }) : null;
    nodeState.preview = summarizeArtifact(artifact);
    emitPipelineEvent();
  });

  run.pendingValidation = null;
  if (decision?.action === 'cancel') {
    throw new PipelineCancelledError('Pipeline run cancelled during validation.');
  }

  if (run.status !== 'running' || nodeState.status !== 'running') {
    run.status = 'running';
    run.message = `Continuing after ${node.label}.`;
    nodeState.status = 'running';
    nodeState.message = 'Validation decision received. Continuing the run.';
    emitPipelineEvent();
  }
  return decision;
}

async function executeLlmValidationReview(node, artifact, contextMaps, reportProgress, options = {}) {
  const validationRequest = await buildValidationMessages(node, artifact, contextMaps);
  const messages = validationRequest.messages;
  const reviewContext = validationRequest.reviewContext;
  const model = String(node.config?.model || '').trim();
  if (!model) {
    throw new Error('Choose or enter a model for this validator before running the pipeline.');
  }

  let reply = '';
  if (node.config?.llmExecutionMode === 'ollama') {
    reportProgress?.(options.progressMessage || 'Sending the content to Ollama for validation.', options.progressTitle || `Running ${node.label} with Ollama...`);
    const ollamaTool = await getInstalledToolOrThrow(
      contextMaps,
      'ollama',
      'Install Ollama before using a local validation step in a pipeline.',
    );
    if (artifact.kind === PORT_KIND_IMAGE) {
      await ensureOllamaImageModelSupport(contextMaps, ollamaTool, model);
    }
    const result = await chatWithOllama(ollamaTool, {
      messages,
      model,
    });
    reply = String(result?.message?.content || '').trim();
  } else {
    const providerId = String(node.config?.providerId || '').trim();
    if (!providerId) {
      throw new Error('Choose a connected cloud provider before running this validation step.');
    }

    const provider = contextMaps.providersById[providerId] || null;
    if (!provider?.isConnected) {
      throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
    }

    reportProgress?.(options.progressMessage || `Sending the content to ${provider.name} for validation.`, options.progressTitle || `Running ${node.label} with ${provider.name}...`);
    const result = await chatWithProvider(providerId, {
      messages,
      model,
      providerId,
    });
    reply = String(result?.message?.content || '').trim();
  }

  const parsed = parseValidationDecision(reply);
  const selectedBranch = parsed.decision === 'pass' ? 'pass' : 'fail';
  const reason = parsed.reason || `Validator selected ${selectedBranch}.`;
  const evidenceLimitations = parsed.evidenceLimitations || (reviewContext.limitations || []).join(' ');
  const validationResult = {
    confidence: parsed.confidence,
    criteriaResults: parsed.criteriaResults,
    decision: selectedBranch,
    evidenceLimitations,
    evidenceMode: parsed.evidenceMode || reviewContext.evidenceMode,
    mode: 'llm',
    planReview: reviewContext.planReview || null,
    rawReply: reply,
    reason,
    reviewContext,
    summary: parsed.summary || '',
  };
  return {
    preview: buildValidationPreview(parsed, reviewContext),
    selectedBranch,
    validation: validationResult,
  };
}

async function executeValidationNode(node, graph, run, contextMaps, reportProgress) {
  const artifact = getNodeInputArtifact(node.id, 'input', graph, run.resultsByNodeId, run);
  if (!artifact) {
    throw new Error('This validation step did not receive any content.');
  }

  if (node.config?.mode !== 'llm') {
    const planReview = buildPlanValidationReview(artifact);
    const evidenceMode = getUserValidationEvidenceMode(artifact, planReview);
    const decision = await waitForUserValidation(run, node, artifact);
    const selectedBranch = decision?.decision === 'pass' ? 'pass' : 'fail';
    const reason = decision?.comment ? `User note: ${decision.comment}` : `User selected ${selectedBranch}.`;
    const validationResult = {
      decision: selectedBranch,
      evidenceMode,
      mode: 'user',
      planReview: planReview ? serializeArtifactForUi(planReview) : null,
      reason,
      reviewContext: {
        artifactKind: String(artifact?.kind || '').trim(),
        evidenceMode,
        limitations: [],
        planReview: planReview ? serializeArtifactForUi(planReview) : null,
      },
      summary: reason,
    };
    return {
      message: `Validation routed this artifact to ${selectedBranch}.`,
      outputs: {
        [selectedBranch]: attachPlanValidationResult(artifact, validationResult),
      },
      preview: trimPreviewText(reason),
      selectedBranch,
      validation: validationResult,
    };
  }

  const review = await executeLlmValidationReview(node, artifact, contextMaps, reportProgress);
  return {
    message: `Validator routed this item to ${review.selectedBranch}.`,
    outputs: {
      [review.selectedBranch]: attachPlanValidationResult(artifact, review.validation),
    },
    preview: review.preview,
    selectedBranch: review.selectedBranch,
    validation: review.validation,
  };
}

function executeBranchMergeNode(node, graph, run) {
  const carriedEntries = getLoopCarriedArtifactsForNode(node.id, graph, run);
  if (carriedEntries.length > 1) {
    const loopLabels = carriedEntries.map((entry) => entry.loopMeta?.loopLabel || entry.loopMeta?.loopNodeId || 'Another retry loop');
    throw new Error('This merge step received retry artifacts from more than one active loop at the same time: ' + loopLabels.join(', ') + '. Route those loops through separate merge points so the re-entry path stays explicit.');
  }

  const carriedEntry = carriedEntries[0] || null;
  if (carriedEntry?.artifact) {
    const selectedArtifact = carriedEntry.artifact;
    return {
      message: (carriedEntry.loopMeta?.loopLabel || 'Retry loop') + ' fed its retry artifact back through this merge.',
      outputs: {
        result: selectedArtifact,
      },
      preview: summarizeArtifact(selectedArtifact),
      selectedBranch: 'loop-retry',
    };
  }

  const activeBranchEntries = getNodeInputArtifacts(node.id, 'branch', graph, run.resultsByNodeId);
  if (!activeBranchEntries.length) {
    throw new Error('This merge step did not receive any active branch output.');
  }

  if (activeBranchEntries.length > 1) {
    const sourceLabels = activeBranchEntries.map((entry) => {
      const sourceNode = graph.nodeMap.get(entry.edge.source.nodeId);
      const sourcePort = getPortDefinition(sourceNode?.type, 'output', entry.edge.source.portId);
      return `${sourceNode?.label || 'Another step'} (${sourcePort?.label || entry.edge.source.portId})`;
    });
    throw new Error('This merge step received more than one live branch result at once: ' + sourceLabels.join(', ') + '. Branch Merge currently expects exactly one active branch. Add another validation gate or restructure the flow before this merge.');
  }

  const selectedArtifact = activeBranchEntries[0].artifact;
  return {
    message: 'Branch Merge forwarded the active branch.',
    outputs: {
      result: selectedArtifact,
    },
    preview: summarizeArtifact(selectedArtifact),
    selectedBranch: 'connected-branch',
  };
}

function executeRetryLoopNode(node, graph, run) {
  const completeArtifact = getNodeInputArtifact(node.id, 'complete', graph, run.resultsByNodeId, run);
  const retryArtifact = getNodeInputArtifact(node.id, 'retry', graph, run.resultsByNodeId, run);
  const accumulatorCollectionState = getRetryLoopAccumulatorCollectionState(node, graph, completeArtifact);
  const accumulatorCollecting = accumulatorCollectionState?.status === 'collecting';
  const accumulatorEmitted = accumulatorCollectionState?.status === 'emitted';

  if (completeArtifact && retryArtifact && !accumulatorCollecting && !accumulatorEmitted) {
    throw new Error('This Retry Loop node received both the Complete and Retry branches at the same time. Keep the loop exit and retry paths mutually exclusive.');
  }

  if (!completeArtifact && !retryArtifact) {
    throw new Error('This Retry Loop node did not receive a live branch yet.');
  }

  const loopMeta = graph.retryLoopsByNodeId.get(node.id) || null;
  const loopState = run.loopStates?.[node.id] || null;
  if (!loopMeta || !loopState) {
    throw new Error('Local AI Hub could not prepare that retry loop. Reopen the pipeline and try again.');
  }

  const currentAttempt = Number(loopState.attempt || 1);
  const maxAttempts = Number(loopState.maxAttempts || loopMeta.maxAttempts || 1);
  const nodeLoopState = getNodeLoopState(run, graph, node.id);
  const terminationAction = resolveRetryLoopTerminationAction(loopMeta, node);

  if (completeArtifact && !accumulatorCollecting && (accumulatorEmitted || !retryArtifact)) {
    loopState.carriedArtifact = null;
    loopState.lastRetryArtifactSignature = '';
    loopState.status = 'completed';
    const completedMessage = accumulatorEmitted && retryArtifact
      ? node.label + ' completed because ' + accumulatorCollectionState.nodeLabel + ' reached ' + accumulatorCollectionState.acceptedCount + ' of ' + accumulatorCollectionState.targetCount + ' accepted items, so the live Retry branch was ignored.'
      : currentAttempt > 1
        ? node.label + ' exited the loop on attempt ' + currentAttempt + ' of ' + maxAttempts + '.'
        : node.label + ' exited the loop on the first attempt.';
    recordLoopHistory(loopState, {
      activeLoops: nodeLoopState.activeLoops,
      attempt: currentAttempt,
      loopMaxAttempts: maxAttempts,
      loopPathLabel: nodeLoopState.loopPathLabel,
      message: completedMessage,
      preview: summarizeArtifact(completeArtifact),
      selectedBranch: 'complete',
      status: 'completed',
    });
    return {
      message: completedMessage,
      outputs: {
        result: completeArtifact,
      },
      preview: summarizeArtifact(completeArtifact),
      selectedBranch: 'complete',
    };
  }

  const retrySignature = retryArtifact ? createArtifactTerminationSignature(retryArtifact) : '';
  const repeatedRetryArtifact = Boolean(
    shouldStopRetryLoopOnRepeatedArtifact(loopMeta, node)
    && retrySignature
    && loopState.lastRetryArtifactSignature
    && retrySignature === loopState.lastRetryArtifactSignature
  );

  if (accumulatorCollecting) {
    if (repeatedRetryArtifact) {
      const repeatedMessage = buildRetryLoopAccumulatorProgressMessage(
        node,
        accumulatorCollectionState,
        'but the Retry branch repeated the same artifact twice in a row. Adjust the loop or disable that stop rule before running it again.',
      );
      loopState.carriedArtifact = null;
      loopState.lastRetryArtifactSignature = '';
      loopState.status = 'failed';
      recordLoopHistory(loopState, {
        activeLoops: nodeLoopState.activeLoops,
        attempt: currentAttempt,
        loopMaxAttempts: maxAttempts,
        loopPathLabel: nodeLoopState.loopPathLabel,
        message: repeatedMessage,
        preview: retryArtifact ? summarizeArtifact(retryArtifact) : summarizeArtifact(completeArtifact),
        selectedBranch: 'retry-terminated',
        status: 'failed',
      });
      throw new Error(repeatedMessage);
    }

    if (currentAttempt >= maxAttempts) {
      const maxAttemptMessage = buildRetryLoopAccumulatorProgressMessage(
        node,
        accumulatorCollectionState,
        'before ' + node.label + ' reached its ' + maxAttempts + '-attempt limit. Raise the loop limit or lower the target count before running it again.',
      );
      loopState.carriedArtifact = null;
      loopState.lastRetryArtifactSignature = '';
      loopState.status = 'failed';
      recordLoopHistory(loopState, {
        activeLoops: nodeLoopState.activeLoops,
        attempt: currentAttempt,
        loopMaxAttempts: maxAttempts,
        loopPathLabel: nodeLoopState.loopPathLabel,
        message: maxAttemptMessage,
        preview: retryArtifact ? summarizeArtifact(retryArtifact) : summarizeArtifact(completeArtifact),
        selectedBranch: 'collecting',
        status: 'failed',
      });
      throw new Error(maxAttemptMessage);
    }

    const collectingMessage = retryArtifact
      ? buildRetryLoopAccumulatorProgressMessage(
          node,
          accumulatorCollectionState,
          'and the Retry branch is still active, so ' + node.label + ' is starting attempt ' + (currentAttempt + 1) + ' of ' + maxAttempts + ' from ' + loopMeta.retryTargetLabel + '.',
        )
      : buildRetryLoopAccumulatorProgressMessage(
          node,
          accumulatorCollectionState,
          'so ' + node.label + ' is starting attempt ' + (currentAttempt + 1) + ' of ' + maxAttempts + ' from ' + loopMeta.retryTargetLabel + '.',
        );
    loopState.carriedArtifact = retryArtifact || null;
    loopState.lastRetryArtifactSignature = retrySignature;
    loopState.status = 'retrying';
    recordLoopHistory(loopState, {
      activeLoops: nodeLoopState.activeLoops,
      attempt: currentAttempt,
      loopMaxAttempts: maxAttempts,
      loopPathLabel: nodeLoopState.loopPathLabel,
      message: collectingMessage,
      preview: retryArtifact ? summarizeArtifact(retryArtifact) : summarizeArtifact(completeArtifact),
      selectedBranch: retryArtifact ? 'retry' : 'collecting',
      status: 'retrying',
    });
    return {
      message: collectingMessage,
      outputs: {},
      preview: retryArtifact ? summarizeArtifact(retryArtifact) : summarizeArtifact(completeArtifact),
      selectedBranch: retryArtifact ? 'retry' : 'collecting',
      loopControl: {
        action: 'retry',
        loopNodeId: node.id,
        nextAttempt: currentAttempt + 1,
        retryTargetNodeId: loopMeta.retryTargetNodeId,
      },
    };
  }

  if (repeatedRetryArtifact) {
    const repeatedMessage = terminationAction === 'complete'
      ? node.label + ' stopped after attempt ' + currentAttempt + ' because the Retry branch produced the same artifact twice in a row, so Local AI Hub kept the latest retry artifact.'
      : node.label + ' stopped after attempt ' + currentAttempt + ' because the Retry branch produced the same artifact twice in a row. Adjust the loop or disable that stop rule before running it again.';
    return finalizeRetryLoopTermination({
      action: terminationAction,
      loopState,
      maxAttempts,
      message: repeatedMessage,
      nodeLoopState,
      retryArtifact,
    });
  }

  if (currentAttempt >= maxAttempts) {
    const maxAttemptMessage = terminationAction === 'complete'
      ? node.label + ' reached its ' + maxAttempts + '-attempt stop rule while the Retry branch was still active, so Local AI Hub kept the latest retry artifact.'
      : node.label + ' reached its ' + maxAttempts + '-attempt safety limit while the Retry branch was still active. Adjust the loop or raise the limit before running it again.';
    return finalizeRetryLoopTermination({
      action: terminationAction,
      loopState,
      maxAttempts,
      message: maxAttemptMessage,
      nodeLoopState,
      retryArtifact,
    });
  }

  loopState.carriedArtifact = retryArtifact || null;
  loopState.lastRetryArtifactSignature = retrySignature;
  loopState.status = 'retrying';
  recordLoopHistory(loopState, {
    activeLoops: nodeLoopState.activeLoops,
    attempt: currentAttempt,
    loopMaxAttempts: maxAttempts,
    loopPathLabel: nodeLoopState.loopPathLabel,
    message: node.label + ' is starting attempt ' + (currentAttempt + 1) + ' of ' + maxAttempts + ' from ' + loopMeta.retryTargetLabel + '.',
    preview: retryArtifact ? summarizeArtifact(retryArtifact) : '',
    selectedBranch: 'retry',
    status: 'retrying',
  });
  return {
    message: node.label + ' is starting attempt ' + (currentAttempt + 1) + ' of ' + maxAttempts + ' from ' + loopMeta.retryTargetLabel + '.',
    outputs: {},
    preview: retryArtifact ? summarizeArtifact(retryArtifact) : '',
    selectedBranch: 'retry',
    loopControl: {
      action: 'retry',
      loopNodeId: node.id,
      nextAttempt: currentAttempt + 1,
      retryTargetNodeId: loopMeta.retryTargetNodeId,
    },
  };
}
function buildCollectionLineageFromEntry(entry, graph) {
  if (!entry?.edge) {
    return null;
  }

  const sourceNode = graph.nodeMap.get(entry.edge.source.nodeId) || null;
  const sourcePort = getPortDefinition(sourceNode?.type, 'output', entry.edge.source.portId) || null;
  return {
    sourceNodeId: sourceNode?.id || String(entry.edge.source.nodeId || '').trim(),
    sourceNodeLabel: sourceNode?.label || '',
    sourcePortId: String(entry.edge.source.portId || '').trim(),
    sourcePortLabel: sourcePort?.label || '',
  };
}

async function executeCollectionAccumulatorNode(node, graph, run) {
  const itemEntries = getNodeInputArtifacts(node.id, 'item', graph, run.resultsByNodeId, run);
  if (!itemEntries.length) {
    throw new Error('This accumulation step did not receive any accepted items yet. Connect one or more validation pass branches here and try again.');
  }

  const acceptedItems = itemEntries.map((entry) => {
    const itemArtifact = entry?.artifact || null;
    if (!itemArtifact) {
      return null;
    }

    if (isArtifactCollection(itemArtifact)) {
      throw new Error('This first accumulation step only accepts single artifacts from accepted branches. Feed completed collections through Collection Builder or Collection Output instead.');
    }

    const itemKind = String(itemArtifact.kind || '').trim();
    if (!itemKind) {
      throw new Error('One accepted item for this accumulation step was missing its artifact type.');
    }

    const lineage = buildCollectionLineageFromEntry(entry, graph);
    const sourceRunCount = Number(run.nodeStates?.[String(lineage?.sourceNodeId || '')]?.runCount || 0) || 0;
    return {
      artifact: itemArtifact,
      entryKey: buildCollectionAccumulatorEntryKey(itemArtifact, lineage, sourceRunCount),
      itemKind,
      lineage,
    };
  }).filter(Boolean);

  if (!acceptedItems.length) {
    throw new Error('This accumulation step did not receive any accepted items yet. Connect one or more validation pass branches here and try again.');
  }

  const accumulationMeta = graph.collectionAccumulatorsByNodeId.get(node.id) || null;
  const collectionState = run.collectionControlStates?.[node.id] || null;
  if (!accumulationMeta || !collectionState) {
    throw new Error('Local AI Hub could not prepare that accumulation step. Reopen the pipeline and try again.');
  }

  const targetCount = Number(collectionState.targetCount || accumulationMeta.targetCount || 0) || 0;
  if (!Number.isInteger(targetCount) || targetCount < 1) {
    throw new Error('Enter a whole target count of at least 1 for this accumulation step.');
  }

  const itemKind = acceptedItems[0].itemKind;
  if (collectionState.itemKind && collectionState.itemKind !== itemKind) {
    throw new Error('This accumulation step can only keep one artifact type in this pass. Keep every accepted item on the same artifact type.');
  }

  if (acceptedItems.some((entry) => entry.itemKind !== itemKind)) {
    throw new Error('This accumulation step can only keep one artifact type in this pass. Keep every accepted item on the same artifact type.');
  }

  const acceptedEntryKeys = new Set(Array.isArray(collectionState.acceptedEntryKeys) ? collectionState.acceptedEntryKeys.filter(Boolean) : []);
  const newAcceptedItems = acceptedItems.filter((entry) => !entry.entryKey || !acceptedEntryKeys.has(entry.entryKey));
  const orderedItems = [
    ...(Array.isArray(collectionState.items) ? collectionState.items : []),
    ...newAcceptedItems.map((entry) => ({
      artifact: entry.artifact,
      lineage: entry.lineage,
    })),
  ];
  const acceptedCount = orderedItems.length;
  const newAcceptedCount = newAcceptedItems.length;
  const collectionStatus = acceptedCount >= targetCount ? 'emitted' : 'collecting';
  const collectionSnapshot = createArtifactCollection(orderedItems, {
    accumulation: {
      acceptedCount,
      mode: 'until-target',
      nodeId: node.id,
      nodeLabel: node.label,
      status: collectionStatus,
      targetCount,
    },
    displayName: node.label,
    role: 'generated',
  });

  collectionState.acceptedCount = acceptedCount;
  collectionState.acceptedEntryKeys = [
    ...acceptedEntryKeys,
    ...newAcceptedItems.map((entry) => entry.entryKey).filter(Boolean),
  ];
  collectionState.collection = collectionSnapshot;
  collectionState.itemKind = collectionSnapshot.itemKind;
  collectionState.items = collectionSnapshot.items.map((entry) => ({
    artifact: entry?.artifact || null,
    itemId: String(entry?.itemId || '').trim(),
    lineage: entry?.lineage || null,
  }));
  collectionState.lastUpdatedAt = new Date().toISOString();
  collectionState.status = collectionStatus;

  if (acceptedCount >= targetCount) {
    const persistedCollection = await persistArtifactCollection(run.directories, collectionSnapshot, {
      baseName: node.label,
      displayName: node.label,
      role: 'generated',
      target: 'artifacts',
    });
    collectionState.collection = persistedCollection;
    collectionState.items = persistedCollection.items.map((entry) => ({
      artifact: entry?.artifact || null,
      itemId: String(entry?.itemId || '').trim(),
      lineage: entry?.lineage || null,
    }));
    collectionState.message = node.label + ' kept ' + newAcceptedCount + ' new accepted item' + (newAcceptedCount === 1 ? '' : 's') + ' this pass, reached ' + acceptedCount + ' of ' + targetCount + ', and emitted the ordered collection.';
    syncNodeCollectionControlState(run, node.id);
    return {
      message: collectionState.message,
      outputs: {
        collection: persistedCollection,
      },
      preview: summarizeArtifact(persistedCollection),
      selectedBranch: 'emitted',
    };
  }

  collectionState.message = node.label + ' kept ' + newAcceptedCount + ' new accepted item' + (newAcceptedCount === 1 ? '' : 's') + ' this pass and is holding ' + acceptedCount + ' of ' + targetCount + ' while the loop keeps collecting.';
  syncNodeCollectionControlState(run, node.id);
  return {
    message: collectionState.message,
    outputs: {
      collection: collectionSnapshot,
    },
    preview: summarizeArtifact(collectionSnapshot),
    selectedBranch: 'collecting',
  };
}
async function executeCollectionBuilderNode(node, graph, run) {
  const itemEntries = getNodeInputArtifacts(node.id, 'items', graph, run.resultsByNodeId, run);
  if (!itemEntries.length) {
    throw new Error('This collection builder did not receive any items yet. Connect one or more upstream items and try again.');
  }

  const existingCollection = getNodeInputArtifact(node.id, 'existing', graph, run.resultsByNodeId, run);
  if (existingCollection && !isArtifactCollection(existingCollection)) {
    throw new Error('The Existing Collection input must receive a saved collection value, not a single artifact.');
  }

  const newItems = itemEntries.map((entry) => {
    if (isArtifactCollection(entry?.artifact)) {
      throw new Error('The Items input only accepts single artifacts. Connect an existing collection through the Existing Collection port instead.');
    }

    return {
      artifact: entry.artifact,
      lineage: buildCollectionLineageFromEntry(entry, graph),
    };
  });

  const existingItems = Array.isArray(existingCollection?.items)
    ? existingCollection.items.map((entry) => ({
        artifact: entry?.artifact || null,
        itemId: String(entry?.itemId || '').trim(),
        lineage: entry?.lineage || null,
      })).filter((entry) => entry.artifact)
    : [];
  const insertionMode = String(node.config?.insertionMode || '').trim() === 'prepend' ? 'prepend' : 'append';
  const orderedNewItems = insertionMode === 'prepend' ? [...newItems].reverse() : newItems;
  const orderedItems = insertionMode === 'prepend'
    ? [...orderedNewItems, ...existingItems]
    : [...existingItems, ...orderedNewItems];

  const collection = createArtifactCollection(orderedItems, {
    displayName: node.label,
    role: 'generated',
  });
  const persistedCollection = await persistArtifactCollection(run.directories, collection, {
    baseName: node.label,
    displayName: node.label,
    role: 'generated',
    target: 'artifacts',
  });
  const actionMessage = existingItems.length
    ? insertionMode === 'prepend'
      ? 'Collection Builder placed the new items before the existing collection.'
      : 'Collection Builder appended the new items to the existing collection.'
    : 'Collection Builder created an ordered collection.';
  return {
    message: actionMessage,
    outputs: {
      collection: persistedCollection,
    },
    preview: summarizeArtifact(persistedCollection),
  };
}

async function executeMediaCompositionNode(node, graph, run) {
  const visualCollection = getNodeInputArtifact(node.id, 'visuals', graph, run.resultsByNodeId, run);
  if (!isArtifactCollection(visualCollection)) {
    throw new Error('This media composition step needs an ordered image collection on the Visual Collection input.');
  }
  if (String(visualCollection.itemKind || '').trim() !== PORT_KIND_IMAGE) {
    throw new Error('This first media composition pass only accepts ordered image collections as the visual track input.');
  }

  const durationSeconds = Math.max(0.1, Number(node.config?.secondsPerItem || 0) || 4);
  const visualItems = (Array.isArray(visualCollection.items) ? visualCollection.items : [])
    .map((entry, index) => ({
      artifact: entry?.artifact || null,
      durationSeconds,
      itemId: String(entry?.itemId || '').trim() || `visual-${index + 1}`,
      lineage: entry?.lineage || null,
      summary: String(entry?.summary || summarizeArtifact(entry?.artifact || null)).trim(),
    }))
    .filter((entry) => entry.artifact);
  if (!visualItems.length) {
    throw new Error('This media composition does not have any saved images to assemble yet.');
  }

  const audioArtifact = getNodeInputArtifact(node.id, 'audio', graph, run.resultsByNodeId, run);
  if (audioArtifact && String(audioArtifact.kind || '').trim() !== PORT_KIND_AUDIO) {
    throw new Error('The Primary Audio input needs one audio artifact when it is connected.');
  }

  const backgroundMusicArtifact = getNodeInputArtifact(node.id, 'backgroundMusic', graph, run.resultsByNodeId, run);
  if (backgroundMusicArtifact && String(backgroundMusicArtifact.kind || '').trim() !== PORT_KIND_AUDIO) {
    throw new Error('The Background Music input needs one audio artifact when it is connected.');
  }

  const composition = createCompositionArtifact({
    displayName: node.label,
    exportKind: PORT_KIND_VIDEO,
    recipeId: 'image-sequence-optional-audio-bed',
    recipeLabel: 'Image sequence with optional narration and background music',
    tracks: [
      {
        id: 'visual-track',
        itemDurationSeconds: durationSeconds,
        itemKind: PORT_KIND_IMAGE,
        items: visualItems,
        kind: 'visual-sequence',
        role: 'primary-visual',
        sourceCollection: {
          directoryPath: String(visualCollection.directoryPath || '').trim(),
          displayName: String(visualCollection.displayName || '').trim(),
          itemCount: Number(visualCollection.itemCount || visualItems.length) || visualItems.length,
          itemKind: String(visualCollection.itemKind || '').trim() || PORT_KIND_IMAGE,
          manifestPath: String(visualCollection.manifestPath || '').trim(),
          summary: String(visualCollection.summary || '').trim(),
        },
      },
      ...(audioArtifact ? [{
        artifact: audioArtifact,
        id: 'audio-track',
        kind: 'audio',
        role: 'primary-audio',
      }] : []),
      ...(backgroundMusicArtifact ? [{
        artifact: backgroundMusicArtifact,
        id: 'background-music-track',
        kind: 'audio',
        role: 'background-music',
        summary: 'Background music track',
      }] : []),
    ],
  }, {
    displayName: node.label,
    role: 'generated',
  });
  const persistedComposition = await persistCompositionArtifact(run.directories, composition, {
    baseName: node.label,
    displayName: node.label,
    role: 'generated',
    target: 'artifacts',
  });

  return {
    message: audioArtifact && backgroundMusicArtifact
      ? 'Media Composition prepared the ordered images with primary narration and background music.'
      : audioArtifact
        ? 'Media Composition prepared the ordered images with the connected primary audio track.'
        : backgroundMusicArtifact
          ? 'Media Composition prepared the ordered images with background music and no primary narration yet.'
          : 'Media Composition prepared the ordered images without any audio tracks yet.',
    outputs: {
      composition: persistedComposition,
    },
    preview: summarizeArtifact(persistedComposition),
  };
}

async function executeMediaExportNode(node, graph, run, reportProgress) {
  const compositionArtifact = getNodeInputArtifact(node.id, 'composition', graph, run.resultsByNodeId, run);
  if (!isCompositionArtifact(compositionArtifact)) {
    throw new Error('This media export step needs a saved media composition before it can render a video.');
  }

  const exportResult = await exportCompositionArtifactToVideo(compositionArtifact, {
    fitMode: String(node.config?.fitMode || '').trim() === 'cover' ? 'cover' : 'contain',
    fps: Math.max(1, Number(node.config?.fps || 0) || 30),
    height: Math.max(16, Number(node.config?.height || 0) || 720),
    reportProgress,
    runDirectories: run.directories,
    stopMode: String(node.config?.stopMode || '').trim() === 'visuals' ? 'visuals' : 'shortest',
    title: String(node.config?.title || node.label || 'Composed video').trim() || 'Composed video',
    width: Math.max(16, Number(node.config?.width || 0) || 1280),
  });

  return {
    destinationPath: exportResult.artifact.filePath,
    message: exportResult.message,
    outputs: {
      video: exportResult.artifact,
    },
    preview: summarizeArtifact(exportResult.artifact),
  };
}

const COLLECTION_INPUT_ITEM_KINDS = new Set([
  PORT_KIND_TEXT,
  PORT_KIND_IMAGE,
  PORT_KIND_AUDIO,
  PORT_KIND_VIDEO,
  PORT_KIND_FILE,
]);

function isValidCollectionInputItemType(value) {
  return COLLECTION_INPUT_ITEM_KINDS.has(String(value || '').trim().toLowerCase());
}

function normalizeCollectionInputItemType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return COLLECTION_INPUT_ITEM_KINDS.has(normalized) ? normalized : PORT_KIND_TEXT;
}

function getCollectionInputItemId(node, item, index) {
  const explicitId = String(item?.id || item?.itemId || '').trim();
  if (explicitId) {
    return explicitId;
  }

  return String(node.id || 'collection-input') + '-item-' + String(index + 1).padStart(3, '0');
}

function buildCollectionInputLineage(node, itemId, index) {
  return {
    sourceItemId: itemId,
    sourceItemIndex: index,
    sourceNodeId: node.id,
    sourceNodeLabel: node.label,
    sourcePortId: 'collection',
    sourcePortLabel: 'Collection',
  };
}

async function executeCollectionInputNode(node, run) {
  if (!isValidCollectionInputItemType(node.config?.itemType)) {
    throw new Error('Choose a collection item type before running this pipeline.');
  }

  const itemType = normalizeCollectionInputItemType(node.config?.itemType);
  const rawItems = Array.isArray(node.config?.items) ? node.config.items : [];
  if (!rawItems.length) {
    throw new Error('Add at least one item to this Collection Input before running the pipeline.');
  }

  const collectionItems = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index] || {};
    const itemId = getCollectionInputItemId(node, item, index);
    if (itemType === PORT_KIND_TEXT) {
      const text = String(item.text || item.value || '').trim();
      if (!text) {
        throw new Error('Collection Input item ' + (index + 1) + ' needs text before running the pipeline.');
      }

      collectionItems.push({
        artifact: createTextArtifact(text, {
          displayName: String(item.label || item.title || node.label + ' item ' + (index + 1)).trim() || node.label,
          role: 'input',
        }),
        itemId,
        lineage: buildCollectionInputLineage(node, itemId, index),
      });
      continue;
    }

    const rawPath = String(item.filePath || item.path || '').trim();
    if (!rawPath) {
      throw new Error('Collection Input item ' + (index + 1) + ' needs a selected ' + itemType + ' file before running the pipeline.');
    }

    const filePath = path.resolve(rawPath);
    if (!(await fs.pathExists(filePath))) {
      throw new Error('Collection Input item ' + (index + 1) + ' points to a file Local AI Hub cannot find. Choose it again and try the pipeline one more time.');
    }

    collectionItems.push({
      artifact: await buildFileArtifact(filePath, {
        displayName: String(item.label || item.title || item.displayName || path.basename(filePath)).trim() || path.basename(filePath),
        kind: itemType,
        role: 'input',
      }),
      itemId,
      lineage: buildCollectionInputLineage(node, itemId, index),
    });
  }

  const collection = createArtifactCollection(collectionItems, {
    displayName: node.label,
    itemKind: itemType,
    role: 'input',
  });
  const persistedCollection = await persistArtifactCollection(run.directories, collection, {
    baseName: node.label,
    displayName: node.label,
    role: 'input',
    target: 'artifacts',
  });
  return {
    message: 'Prepared an ordered ' + itemType + ' collection with ' + persistedCollection.itemCount + ' item' + (persistedCollection.itemCount === 1 ? '' : 's') + '.',
    outputs: {
      collection: persistedCollection,
    },
    preview: summarizeArtifact(persistedCollection),
  };
}
async function executeOutputNode(node, inputPortId, graph, run) {
  const artifact = getNodeInputArtifact(node.id, inputPortId, graph, run.resultsByNodeId, run);
  if (!artifact) {
    throw new Error('This output step did not receive any content to save.');
  }

  const savedArtifact = await copyArtifactToOutput(artifact, run.directories, {
    outputKind: artifact.kind,
    outputNodeId: node.id,
    outputPortId: inputPortId,
    runId: run.runId,
    title: String(node.config?.title || node.label || 'output').trim() || 'output',
  });
  const destinationPath = savedArtifact.destinationPath || savedArtifact.directoryPath || savedArtifact.filePath || '';
  return {
    destinationPath,
    message: `${String(node.config?.title || node.label || 'Output').trim() || 'Output'} saved to ${destinationPath}.`,
    outputs: {
      [inputPortId]: savedArtifact,
    },
    preview: summarizeArtifact(savedArtifact),
    terminalResult: buildTerminalResult(node, savedArtifact),
  };
}

async function executeNode(node, graph, run, contextMaps, reportProgress) {
  if (node.type === 'collectionInput') {
    return executeCollectionInputNode(node, run);
  }
  if (node.type === 'textInput') {
    const text = String(node.config?.text || '').trim();
    if (!text) {
      throw new Error('Enter some text for the Text Input node before running this pipeline.');
    }

    const artifact = createTextArtifact(text, {
      displayName: node.label,
      role: 'input',
    });
    return {
      message: 'Prepared the text input.',
      outputs: {
        text: artifact,
      },
      preview: summarizeArtifact(artifact),
    };
  }

  if (node.type === 'imageInput' || node.type === 'audioInput' || node.type === 'videoInput' || node.type === 'fileInput') {
    const filePath = path.resolve(String(node.config?.filePath || '').trim());
    if (!String(node.config?.filePath || '').trim()) {
      throw new Error(`Choose a file for the ${node.label} node before running this pipeline.`);
    }

    if (!(await fs.pathExists(filePath))) {
      throw new Error('The selected file could not be found anymore. Choose it again and try the pipeline one more time.');
    }

    const outputPortId = node.type === 'imageInput' ? 'image' : node.type === 'audioInput' ? 'audio' : node.type === 'videoInput' ? 'video' : 'file';
    const kind = node.type === 'imageInput' ? 'image' : node.type === 'audioInput' ? 'audio' : node.type === 'videoInput' ? 'video' : 'file';
    const artifact = await buildFileArtifact(filePath, {
      displayName: node.label,
      kind,
      role: 'input',
    });
    return {
      message: `Prepared the ${node.label.toLowerCase()} input.`,
      outputs: {
        [outputPortId]: artifact,
      },
      preview: summarizeArtifact(artifact),
    };
  }

  if (node.type === 'planningPacket') {
    return executePlanningPacketNode(node, graph, run, contextMaps);
  }

  if (node.type === 'planner') {
    return executePlannerNode(node, graph, run, contextMaps, reportProgress);
  }

  if (node.type === 'planScenes') {
    return executePlanScenesNode(node, graph, run);
  }

  if (node.type === 'llmPrompt') {
    const promptArtifact = getNodeInputArtifact(node.id, 'prompt', graph, run.resultsByNodeId, run);
    const model = String(node.config?.model || '').trim();
    const executionMode = node.config?.executionMode === 'ollama' ? 'ollama' : node.config?.executionMode === 'localTool' ? 'localTool' : 'cloud';
    const operationId = getModelStepOperationId(node);
    if (!promptArtifact) {
      throw new Error('This LLM step did not receive any input.');
    }

    const requiresExplicitModel = !(executionMode === 'localTool'
      && (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE || operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE || operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM || operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM))
      && (executionMode !== 'cloud' || doesProviderOperationRequireExplicitModel(String(node.config?.providerId || '').trim(), operationId));
    if (!model && requiresExplicitModel) {
      throw new Error('Choose or enter a model for the model step before running this pipeline.');
    }

    let sourceLabel = 'This model';
    if (executionMode === 'ollama') {
      if (operationId !== PIPELINE_OPERATION_IDS.LLM_PROMPT) {
        throw new Error('Local AI Hub can only return text from Ollama model steps right now. Switch this step back to Text response or choose a cloud image or video model.');
      }

      const messages = await buildLlmMessages(node, promptArtifact);
      const inputLabel = promptArtifact.kind === PORT_KIND_IMAGE ? 'image' : 'prompt';
      reportProgress?.('Sending the ' + inputLabel + ' to Ollama and waiting for a reply.', 'Running ' + node.label + ' with Ollama...');
      const ollamaTool = await getInstalledToolOrThrow(
        contextMaps,
        'ollama',
        'Install Ollama before using a local LLM step in a pipeline.',
      );
      if (promptArtifact.kind === PORT_KIND_IMAGE) {
        await ensureOllamaImageModelSupport(contextMaps, ollamaTool, model);
      }
      const result = await chatWithOllama(ollamaTool, {
        messages,
        model,
      });
      const content = String(result?.message?.content || '').trim();
      sourceLabel = 'Ollama';
      if (!content) {
        throw new Error(sourceLabel + ' returned an empty reply for this pipeline step.');
      }

      const artifact = createTextArtifact(content, {
        displayName: node.label,
        role: 'generated',
      });
      return {
        message: sourceLabel + ' returned a reply.',
        outputs: {
          text: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }

    if (executionMode === 'localTool') {
      if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
        const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'local audio generation');
        const audioRequest = await buildAudioGenerationRequest(node, promptArtifact);
        reportProgress?.('Sending the request to ' + tool.name + ' for local audio generation.', 'Running ' + node.label + ' with ' + tool.name + '...');
        return generateAudioWithLocalAudioTool(tool, {
          audioMode: audioRequest.audioMode,
          displayName: node.label,
          durationSeconds: audioRequest.durationSeconds,
          model,
          nodeLabel: node.label,
          operationId,
          prompt: audioRequest.prompt,
          reportProgress,
          runDirectories: run.directories,
          sourceAudioArtifact: audioRequest.sourceAudioArtifact,
          sourceAudioPath: audioRequest.sourceAudioPath,
        });
      }

      if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) {
        const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'local audio transcription');
        if (!promptArtifact?.filePath || promptArtifact.kind !== PORT_KIND_AUDIO) {
          throw new Error('This model-step transcription did not receive an audio file.');
        }
        reportProgress?.('Sending the audio to ' + tool.name + ' for transcription.', 'Running ' + node.label + ' with ' + tool.name + '...');
        const result = await transcribeWithWhisper(tool, {
          audioPath: promptArtifact.filePath,
          model: model || DEFAULT_WHISPER_MODEL,
        });
        const transcript = String(result?.text || '').trim();
        if (!transcript) {
          throw new Error(tool.name + ' finished, but it did not return any transcript text for this pipeline step.');
        }

        const artifact = buildWhisperTranscriptArtifact(node, promptArtifact, result);
        return {
          message: buildWhisperCompletionMessage(result),
          outputs: {
            text: artifact,
          },
          preview: summarizeArtifact(artifact),
        };
      }

      if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
        const tool = await getSelectedLocalAudioToolOrThrow(contextMaps, node, 'local audio transformation');
        const audioRequest = await buildAudioTransformRequest(node, promptArtifact);
        if (!model) {
          throw new Error('Choose an RVC voice model before running this audio transformation step.');
        }
        const selectedVoiceModel = getDownloadedToolModelEntry(tool, model);
        if (Array.isArray(tool?.downloadedModels) && tool.downloadedModels.length && !selectedVoiceModel) {
          throw new Error(tool.name + ' does not have the selected RVC voice model available locally. Refresh the local model list or choose a model file from the weights folder before running this step.');
        }
        reportProgress?.('Sending the source audio to ' + tool.name + ' for local audio transformation.', 'Running ' + node.label + ' with ' + tool.name + '...');
        return generateAudioWithLocalAudioTool(tool, {
          displayName: node.label,
          instruction: audioRequest.instruction,
          model,
          nodeLabel: node.label,
          operationId,
          reportProgress,
          runDirectories: run.directories,
          sourceAudioArtifact: audioRequest.sourceAudioArtifact,
          sourceAudioPath: audioRequest.sourceAudioPath,
          voiceModel: selectedVoiceModel,
        });
      }

      if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
        const tool = await getSelectedLocalVideoToolOrThrow(contextMaps, node, 'local video generation');
        const videoRequest = await buildVideoGenerationRequest(node, promptArtifact);
        reportProgress?.('Sending the request to ' + tool.name + ' for local video generation.', 'Running ' + node.label + ' with ' + tool.name + '...');
        return generateVideoWithLocalVideoTool(tool, {
          displayName: node.label,
          fps: 15,
          model,
          negativePrompt: videoRequest.negativePrompt,
          nodeLabel: node.label,
          prompt: videoRequest.prompt,
          referenceImagePath: videoRequest.referenceImagePath,
          reportProgress,
          sourceImageArtifact: videoRequest.sourceImageArtifact,
          runDirectories: run.directories,
          seed: node.config?.seed,
          size: videoRequest.size,
          steps: node.config?.steps,
        });
      }

      if (operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
        if (!promptArtifact?.filePath || promptArtifact.kind !== PORT_KIND_IMAGE) {
          throw new Error('This model-step image analysis did not receive an image file.');
        }
        const tool = await getSelectedImageToolOrThrow(contextMaps, node, 'local image analysis');
        reportProgress?.('Sending the image to ' + tool.name + ' for analysis.', 'Running ' + node.label + ' with ' + tool.name + '...');
        const result = await interrogateImageWithWorkflowTool(tool, {
          analysisMode: node.config?.analysisMode || model || 'clip',
          imagePath: promptArtifact.filePath,
        });
        const description = String(result?.text || '').trim();
        if (!description) {
          throw new Error((tool?.name || 'The selected image tool') + ' did not return an image description.');
        }

        const artifact = createTextArtifact(description, {
          displayName: node.label,
          role: 'generated',
        });
        return {
          message: tool.name + ' described the image.',
          outputs: {
            text: artifact,
          },
          preview: summarizeArtifact(artifact),
        };
      }

      if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
        const tool = await getSelectedLocalImageToolOrThrow(contextMaps, node, 'local image transformation');
        const referenceArtifact = getNodeInputArtifact(node.id, 'referenceImage', graph, run.resultsByNodeId, run);
        const imageRequest = await buildImageTransformRequest(node, promptArtifact, referenceArtifact, tool);
        reportProgress?.('Sending the source image to ' + tool.name + ' for local image transformation.', 'Running ' + node.label + ' with ' + tool.name + '...');
        return generateImageWithLocalImageTool(tool, {
          displayName: node.label,
          instruction: imageRequest.instruction,
          model,
          nodeLabel: node.label,
          operationId,
          referenceImageArtifact: imageRequest.referenceImageArtifact,
          referenceImagePath: imageRequest.referenceImagePath,
          reportProgress,
          runDirectories: run.directories,
          sourceImageArtifact: imageRequest.sourceImageArtifact,
          sourceImagePath: imageRequest.sourceImagePath,
          transformSubtype: imageRequest.transformSubtype,
        });
      }

      if (operationId !== PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
        throw new Error('Local AI Hub currently supports audio transcription, audio generation, audio transformation, image analysis, image generation, image transformation, and video generation for operation-driven local tools in the model step. Use the Graph Workflow step for ComfyUI-style graph-native workflows.');
      }

      const prompt = buildImageGenerationPrompt(node, promptArtifact);
      const tool = await getSelectedImageToolOrThrow(contextMaps, node, 'local image generation');
      const checkpointOverride = String(model || '').trim();

      reportProgress?.('Sending the prompt to ' + tool.name + ' for local image generation.', 'Running ' + node.label + ' with ' + tool.name + '...');
      const generated = await generateImageWithWorkflowTool(tool, {
        cfgScale: node.config?.cfgScale,
        height: node.config?.height,
        model: checkpointOverride,
        negativePrompt: node.config?.negativePrompt,
        prompt,
        seed: node.config?.seed,
        steps: node.config?.steps,
        width: node.config?.width,
      });
      const artifact = await saveBase64Artifact(run.directories, generated.base64Image, {
        baseName: node.label + '-' + Date.now(),
        displayName: node.label,
        extension: '.png',
        kind: PORT_KIND_IMAGE,
        role: 'generated',
      });
      return {
        destinationPath: artifact.filePath,
        message: tool.name + ' generated an image locally and saved the intermediate file to ' + artifact.filePath + '.',
        outputs: {
          image: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }
    const providerId = String(node.config?.providerId || '').trim();
    if (!providerId) {
      throw new Error('Choose a connected cloud provider before running this model step.');
    }

    const provider = contextMaps.providersById[providerId] || null;
    if (!provider?.isConnected) {
      throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
    }

    sourceLabel = provider.name;
    if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
      const audioRequest = await buildCloudAudioGenerationRequest(node, promptArtifact);
      reportProgress?.('Sending the text to ' + provider.name + ' for speech generation.', 'Running ' + node.label + ' with ' + provider.name + '...');
      const result = await runProviderOperation(providerId, {
        instruction: audioRequest.instruction,
        model,
        operationId,
        prompt: audioRequest.prompt,
        providerId,
        spokenText: audioRequest.spokenText,
        voice: audioRequest.voice,
      });
      const generatedAudio = result?.audios?.[0] || null;
      if (!generatedAudio?.buffer) {
        throw new Error(sourceLabel + ' finished the request, but it did not return an audio file.');
      }

      const artifact = await saveBufferArtifact(run.directories, generatedAudio.buffer, {
        audio: {
          bitDepth: generatedAudio.bitDepth,
          channelCount: generatedAudio.channelCount,
          sampleRate: generatedAudio.sampleRate,
        },
        audioGeneration: {
          backend: providerId,
          backendLabel: provider.name,
          mode: 'speech',
          model,
          operationId,
          operationSubtype: 'speech',
          prompt: audioRequest.spokenText,
          voice: generatedAudio.voice || audioRequest.voice,
        },
        baseName: node.label + '-' + Date.now(),
        displayName: node.label,
        extension: String(generatedAudio.extension || '.wav').trim() || '.wav',
        kind: PORT_KIND_AUDIO,
        role: 'generated',
      });
      return {
        destinationPath: artifact.filePath,
        message: sourceLabel + ' generated speech and saved the intermediate file to ' + artifact.filePath + '.',
        outputs: {
          audio: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }

    if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
      const prompt = buildImageGenerationPrompt(node, promptArtifact);
      reportProgress?.('Sending the prompt to ' + provider.name + ' for image generation.', 'Running ' + node.label + ' with ' + provider.name + '...');
      const result = await runProviderOperation(providerId, {
        background: node.config?.imageBackground,
        model,
        operationId,
        prompt,
        providerId,
        quality: node.config?.imageQuality,
        size: node.config?.imageSize,
      });
      const base64Image = String(result?.images?.[0]?.base64Data || '').trim();
      if (!base64Image) {
        throw new Error(sourceLabel + ' finished the request, but it did not return an image.');
      }

      const artifact = await saveBase64Artifact(run.directories, base64Image, {
        baseName: node.label + '-' + Date.now(),
        displayName: node.label,
        extension: '.png',
        kind: 'image',
        role: 'generated',
      });
      return {
        destinationPath: artifact.filePath,
        message: sourceLabel + ' generated an image and saved the intermediate file to ' + artifact.filePath + '.',
        outputs: {
          image: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }

    if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
      const videoRequest = await buildVideoGenerationRequest(node, promptArtifact);
      reportProgress?.('Sending the prompt to ' + provider.name + ' for video generation.', 'Running ' + node.label + ' with ' + provider.name + '...');
      const result = await runProviderOperation(providerId, {
        imageReference: videoRequest.referenceImage,
        model,
        onProgress: (message) => reportProgress?.(message, 'Running ' + node.label + ' with ' + provider.name + '...'),
        operationId,
        prompt: videoRequest.prompt,
        providerId,
        seconds: 8,
        size: videoRequest.size,
      });
      const videoBuffer = result?.videos?.[0]?.buffer || null;
      if (!videoBuffer) {
        throw new Error(sourceLabel + ' finished the request, but it did not return a video file.');
      }

      const artifact = await saveBufferArtifact(run.directories, videoBuffer, {
        baseName: node.label + '-' + Date.now(),
        displayName: node.label,
        extension: String(result?.videos?.[0]?.extension || '.mp4').trim() || '.mp4',
        kind: PORT_KIND_VIDEO,
        role: 'generated',
      });
      return {
        destinationPath: artifact.filePath,
        message: sourceLabel + ' generated a video and saved the intermediate file to ' + artifact.filePath + '.',
        outputs: {
          video: artifact,
        },
        preview: summarizeArtifact(artifact),
      };
    }

    const messages = await buildLlmMessages(node, promptArtifact);
    const inputLabel = promptArtifact.kind === PORT_KIND_IMAGE ? 'image' : 'prompt';
    reportProgress?.('Sending the ' + inputLabel + ' to ' + provider.name + '.', 'Running ' + node.label + ' with ' + provider.name + '...');
    const result = await runProviderOperation(providerId, {
      messages,
      model,
      operationId,
      providerId,
    });
    const content = String(result?.message?.content || '').trim();
    if (!content) {
      throw new Error(sourceLabel + ' returned an empty reply for this pipeline step.');
    }

    const artifact = createTextArtifact(content, {
      displayName: node.label,
      role: 'generated',
    });
    return {
      message: sourceLabel + ' returned a reply.',
      outputs: {
        text: artifact,
      },
      preview: summarizeArtifact(artifact),
    };
  }
  if (node.type === 'graphWorkflow') {
    const toolId = getGraphWorkflowToolId(node);
    const installMessage = toolId === 'comfyui'
      ? 'Install ComfyUI before using a graph workflow step in a pipeline.'
      : 'Install the selected graph workflow tool before using this step in a pipeline.';
    const tool = await getInstalledToolOrThrow(contextMaps, toolId, installMessage);
    return executeGraphWorkflowNode({
      inputArtifacts: {
        image: getNodeInputArtifact(node.id, 'image', graph, run.resultsByNodeId, run),
        text: getNodeInputArtifact(node.id, 'text', graph, run.resultsByNodeId, run),
      },
      node,
      reportProgress,
      runDirectories: run.directories,
      tool,
    });
  }

  if (node.type === 'validation') {
    return executeValidationNode(node, graph, run, contextMaps, reportProgress);
  }

  if (node.type === 'collectionMap') {
    return executeCollectionMapNode(node, graph, run, contextMaps, reportProgress);
  }

  if (node.type === 'collectionBuilder') {
    return executeCollectionBuilderNode(node, graph, run);
  }

  if (node.type === 'collectionAccumulator') {
    return executeCollectionAccumulatorNode(node, graph, run);
  }

  if (node.type === 'mediaComposition') {
    return executeMediaCompositionNode(node, graph, run);
  }

  if (node.type === 'mediaExport') {
    return executeMediaExportNode(node, graph, run, reportProgress);
  }

  if (node.type === 'branchMerge') {
    return executeBranchMergeNode(node, graph, run);
  }

  if (node.type === 'retryLoop') {
    return executeRetryLoopNode(node, graph, run);
  }

  if (node.type === 'collectionOutput') {
    return executeOutputNode(node, 'collection', graph, run);
  }

  if (node.type === 'planOutput') {
    return executeOutputNode(node, 'plan', graph, run);
  }

  if (node.type === 'textOutput') {
    return executeOutputNode(node, 'text', graph, run);
  }

  if (node.type === 'imageOutput') {
    return executeOutputNode(node, 'image', graph, run);
  }

  if (node.type === 'audioOutput') {
    return executeOutputNode(node, 'audio', graph, run);
  }

  if (node.type === 'videoOutput') {
    return executeOutputNode(node, 'video', graph, run);
  }

  if (node.type === 'fileOutput') {
    return executeOutputNode(node, 'file', graph, run);
  }

  throw new Error(`Local AI Hub does not support the ${node.type} node type in pipeline runs yet.`);
}

async function executeActiveRun(graph, context) {
  const orchestrator = createPipelineToolOrchestrator(context);
  let orchestratorDisposed = false;

  const disposeOrchestrator = async (nodeId, reason) => {
    if (orchestratorDisposed) {
      return null;
    }

    orchestratorDisposed = true;
    return disposePipelineTools(orchestrator, activeRun, nodeId, reason);
  };

  try {
    let index = 0;
    while (index < graph.executionOrder.length) {
      const nodeId = graph.executionOrder[index];
      if (!activeRun) {
        await disposeOrchestrator('', 'this pipeline run');
        return;
      }

      if (activeRun.cancelRequested) {
        const cleanupError = await disposeOrchestrator('', 'this cancelled pipeline run');
        if (cleanupError) {
          throw cleanupError;
        }

        markRemainingNodes(activeRun, graph, 'cancelled', 'Cancelled before this step started.');
        activeRun.status = 'cancelled';
        activeRun.message = 'Pipeline run cancelled.';
        activeRun.finishedAt = new Date().toISOString();
        activeRun.currentNodeId = null;
        emitPipelineEvent();
        return;
      }

      const node = graph.nodeMap.get(nodeId);
      const nextNodeId = graph.executionOrder[index + 1] || '';
      const nextNode = nextNodeId ? graph.nodeMap.get(nextNodeId) : null;
      const nodeState = activeRun.nodeStates[nodeId];
      const nodeLoopState = getNodeLoopState(activeRun, graph, nodeId);
      applyNodeLoopState(nodeState, nodeLoopState);

      const missingInputs = getMissingRequiredInputs(node, graph, activeRun.resultsByNodeId, activeRun);
      if (missingInputs.length) {
        nodeState.status = 'skipped';
        nodeState.finishedAt = new Date().toISOString();
        nodeState.message = `Skipped because ${missingInputs.join(', ')} did not receive content from the active branch.`;
        emitPipelineEvent();
        index += 1;
        continue;
      }

      nodeState.status = 'running';
      nodeState.startedAt = new Date().toISOString();
      nodeState.runCount = Number(nodeState.runCount || 0) + 1;
      nodeState.message = 'Running now.';
      activeRun.currentNodeId = nodeId;
      activeRun.status = 'running';
      const loopRunLabel = nodeLoopState.loopPathLabel
        || (nodeLoopState.loopMaxAttempts
          ? `Attempt ${nodeLoopState.iteration} of ${nodeLoopState.loopMaxAttempts}`
          : nodeLoopState.iteration > 1
            ? `Attempt ${nodeLoopState.iteration}`
            : '');
      activeRun.message = loopRunLabel
        ? `Running ${node.label} (${loopRunLabel})...`
        : `Running ${node.label}...`;
      emitPipelineEvent();

      const progressReporter = createProgressReporter(activeRun, node.id);
      await orchestrator.ensureToolForNode(node, progressReporter);
      const result = await executeNode(node, graph, activeRun, context, progressReporter);
      await orchestrator.releaseToolForNode(node, nextNode, progressReporter);

      activeRun.resultsByNodeId[nodeId] = {
        outputs: Object.fromEntries(
          Object.entries(result.outputs || {}).map(([portId, artifact]) => [portId, serializeArtifactForUi(artifact)]),
        ),
        validation: result.validation || null,
      };
      nodeState.status = 'completed';
      nodeState.finishedAt = new Date().toISOString();
      nodeState.message = result.message || 'Completed.';
      nodeState.preview = result.preview || '';
      nodeState.outputs = activeRun.resultsByNodeId[nodeId].outputs;
      nodeState.validation = result.validation || null;
      nodeState.selectedBranch = result.selectedBranch || '';
      nodeState.destinationPath = result.destinationPath || '';
      syncNodeCollectionControlState(activeRun, nodeId);

      if (result.terminalResult) {
        activeRun.terminalResults.push(result.terminalResult);
      }

      activeRun.currentNodeId = null;
      activeRun.message = result.loopControl?.action === 'retry'
        ? (result.message || `${node.label} requested another attempt.`)
        : `${node.label} finished.`;
      emitPipelineEvent();

      if (result.loopControl?.action === 'retry') {
        resetLoopSegmentForRetry(activeRun, graph, result.loopControl.loopNodeId, result.loopControl.nextAttempt);
        const retryTargetIndex = Number(graph.executionIndexByNodeId.get(result.loopControl.retryTargetNodeId));
        if (!Number.isFinite(retryTargetIndex)) {
          throw new Error('Local AI Hub could not resume that retry loop. Reopen the pipeline and try again.');
        }

        activeRun.message = result.message || `Retrying ${node.label}.`;
        emitPipelineEvent();
        index = retryTargetIndex;
        continue;
      }

      index += 1;
    }

    if (!activeRun) {
      await disposeOrchestrator('', 'this pipeline run');
      return;
    }

    const cleanupError = await disposeOrchestrator('', 'this finished pipeline run');
    if (cleanupError) {
      throw cleanupError;
    }

    activeRun.status = 'completed';
    activeRun.message = `${activeRun.pipelineName} finished successfully.`;
    activeRun.finishedAt = new Date().toISOString();
    emitPipelineEvent();
  } catch (error) {
    if (!activeRun) {
      return;
    }

    const cleanupError = await disposeOrchestrator(
      activeRun.currentNodeId || '',
      activeRun.cancelRequested ? 'this cancelled pipeline run' : 'this pipeline run',
    );
    const finalError = cleanupError && !error ? cleanupError : error;
    const isCancelled = finalError instanceof PipelineCancelledError || activeRun.cancelRequested;
    const failedNodeId = activeRun.currentNodeId;
    if (failedNodeId && activeRun.nodeStates[failedNodeId]) {
      activeRun.nodeStates[failedNodeId].status = isCancelled ? 'cancelled' : 'failed';
      activeRun.nodeStates[failedNodeId].finishedAt = new Date().toISOString();
      activeRun.nodeStates[failedNodeId].message = finalError.message || (isCancelled ? 'Pipeline run cancelled.' : 'This step failed.');
    }

    pendingValidationControl = null;
    activeRun.pendingValidation = null;
    markRemainingNodes(activeRun, graph, isCancelled ? 'cancelled' : 'skipped', isCancelled ? 'Cancelled before this step started.' : 'Skipped because an earlier step failed.');
    activeRun.status = isCancelled ? 'cancelled' : 'failed';
    activeRun.message = isCancelled ? 'Pipeline run cancelled.' : finalError.message || 'Pipeline run failed.';
    activeRun.finishedAt = new Date().toISOString();
    activeRun.currentNodeId = null;
    emitPipelineEvent();
  }
}

async function runPipeline(definition) {
  if (activeRun && (activeRun.status === 'running' || activeRun.status === 'paused')) {
    throw new Error('A pipeline is already running. Wait for it to finish or cancel it before starting another one.');
  }

  const { analysis, context } = await analyzeWithCurrentContext(definition);
  if (!analysis.executable) {
    throw new Error(analysis.primaryIssue?.message || 'This pipeline is not ready to run yet.');
  }

  const graph = buildPipelineGraph(analysis.pipeline);
  activeRun = createRunRecord(analysis, graph, null);
  activeRun.directories = await ensureRunDirectories(activeRun.runId);
  emitPipelineEvent();
  executeActiveRun(graph, context).catch(() => null);
  return getActiveRunSnapshot();
}

function cancelPipelineRun(runId) {
  if (!activeRun || (activeRun.status !== 'running' && activeRun.status !== 'paused')) {
    throw new Error('There is no active pipeline run to cancel right now.');
  }

  if (runId && activeRun.runId !== runId) {
    throw new Error('Local AI Hub could not find that active pipeline run.');
  }

  activeRun.cancelRequested = true;
  activeRun.message = 'Local AI Hub will stop this pipeline after the current step finishes and shut down any tool it started for the run.';
  if (activeRun.status === 'paused' && pendingValidationControl?.resolve) {
    const resolve = pendingValidationControl.resolve;
    pendingValidationControl = null;
    resolve({ action: 'cancel' });
  }
  emitPipelineEvent();
  return getActiveRunSnapshot();
}

function resumePipelineValidation(runId, payload = {}) {
  if (!activeRun || activeRun.status !== 'paused' || !activeRun.pendingValidation) {
    throw new Error('There is no paused validation step waiting right now.');
  }

  if (runId && activeRun.runId !== runId) {
    throw new Error('Local AI Hub could not find that paused pipeline run.');
  }

  const pendingValidation = activeRun.pendingValidation;
  const requestId = String(payload.requestId || payload.validationRequestId || '').trim();
  if (requestId && pendingValidation.requestId && pendingValidation.requestId !== requestId) {
    throw new Error('Local AI Hub could not find that paused validation step anymore.');
  }

  const nodeId = String(payload.nodeId || '').trim();
  if (nodeId && pendingValidation.nodeId !== nodeId) {
    throw new Error('Local AI Hub could not find that paused validation step anymore.');
  }

  const decision = String(payload.decision || '').trim().toLowerCase();
  if (decision !== 'pass' && decision !== 'fail') {
    throw new Error('Choose pass or fail before continuing this validation step.');
  }

  if (!pendingValidationControl?.resolve) {
    throw new Error('Local AI Hub is still preparing that validation step. Try again.');
  }

  const comment = String(payload.comment || '').trim();
  const nodeState = activeRun.nodeStates?.[pendingValidation.nodeId] || null;
  activeRun.pendingValidation = null;
  activeRun.status = 'running';
  activeRun.message = `Continuing after ${pendingValidation.nodeLabel || nodeState?.nodeLabel || 'this validation step'}.`;
  if (nodeState) {
    nodeState.status = 'running';
    nodeState.message = 'Validation decision received. Continuing the run.';
  }

  const resolve = pendingValidationControl.resolve;
  pendingValidationControl = null;
  emitPipelineEvent();
  resolve({
    action: 'route',
    comment,
    decision,
  });
  return getActiveRunSnapshot();
}

module.exports = {
  analyzeWithCurrentContext,
  cancelPipelineRun,
  getActiveRunSnapshot,
  resumePipelineValidation,
  runPipeline,
  setPipelineEventSink,
};
