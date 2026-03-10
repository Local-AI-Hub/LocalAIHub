const path = require('path');
const fs = require('fs-extra');

const { readConfig } = require('./configService');
const { chatWithOllama } = require('./ollamaService');
const { listProviderConnections, chatWithProvider } = require('./providerService');
const { initializeProviderRegistry } = require('./providerRegistry');
const { resolveToolStatus } = require('./processService');
const { getToolCatalog, getToolManifest, initializeToolRegistry } = require('./toolRegistry');
const { DEFAULT_WHISPER_MODEL, transcribeWithWhisper } = require('./whisperService');
const {
  analyzePipeline,
  buildPipelineGraph,
  buildContextMaps,
  trimPreviewText,
} = require('../shared/pipelineSchema.cjs');

let pipelineEventSink = null;
let activeRun = null;

function setPipelineEventSink(listener) {
  pipelineEventSink = typeof listener === 'function' ? listener : null;
}

function emitPipelineEvent() {
  if (typeof pipelineEventSink !== 'function' || !activeRun) {
    return;
  }

  try {
    pipelineEventSink({
      type: 'pipeline-run-update',
      run: getActiveRunSnapshot(),
    });
  } catch {
    return;
  }
}

async function buildPipelineContext() {
  await initializeToolRegistry();
  await initializeProviderRegistry();
  const config = await readConfig();
  const toolEntries = await Promise.all(
    Object.values(config.tools || {}).map(async (toolState) => {
      const manifest = getToolManifest(toolState.id) || {};
      const mergedTool = {
        ...manifest,
        ...toolState,
        compatibility: manifest.installInstructions?.compatibility || manifest.compatibility || toolState.compatibility || null,
      };

      return {
        ...mergedTool,
        status: await resolveToolStatus(mergedTool).catch(() => mergedTool.status || 'stopped'),
      };
    }),
  );

  return buildContextMaps({
    hardware: config.hardware || null,
    providers: await listProviderConnections(),
    toolCatalog: getToolCatalog(),
    tools: toolEntries,
  });
}

async function analyzeWithCurrentContext(definition) {
  const context = await buildPipelineContext();
  return {
    analysis: analyzePipeline(definition, context),
    context,
  };
}

function createInitialNodeStates(graph) {
  const nodeStates = {};

  for (const node of graph.pipeline.nodes) {
    nodeStates[node.id] = {
      nodeId: node.id,
      nodeLabel: node.label,
      type: node.type,
      status: graph.reachableNodeIds.has(node.id) ? 'queued' : 'skipped',
      startedAt: null,
      finishedAt: null,
      message: graph.reachableNodeIds.has(node.id) ? 'Waiting to run.' : 'Skipped because it is not connected to an output.',
      preview: '',
      outputs: {},
    };
  }

  return nodeStates;
}

function createRunRecord(analysis, graph) {
  return {
    runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    pipelineId: analysis.pipeline.id,
    pipelineName: analysis.pipeline.name,
    status: 'running',
    message: 'Local AI Hub is running the pipeline step by step.',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    currentNodeId: null,
    cancelRequested: false,
    executionOrder: [...analysis.executionOrder],
    reachableNodeIds: [...analysis.reachableNodeIds],
    terminalNodeIds: [...analysis.terminalNodeIds],
    nodeStates: createInitialNodeStates(graph),
    resultsByNodeId: {},
    terminalResults: [],
  };
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

function getNodeInputValue(nodeId, portId, graph, resultsByNodeId) {
  const edge = graph.incomingEdgeByPortKey.get(`${nodeId}:${portId}`);
  if (!edge) {
    return undefined;
  }

  return resultsByNodeId[edge.source.nodeId]?.outputs?.[edge.source.portId];
}

function buildLlmMessages(node, promptText) {
  const instruction = String(node.config?.instruction || '').trim();
  const systemPrompt = String(node.config?.systemPrompt || '').trim();
  const messages = [];
  const normalizedInput = String(promptText || '').trim();

  if (!normalizedInput) {
    throw new Error('This LLM step did not receive any text input.');
  }

  if (systemPrompt) {
    messages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  messages.push({
    role: 'user',
    content: instruction ? `${instruction}\n\nInput:\n${normalizedInput}` : normalizedInput,
  });

  return messages;
}

function getInstalledToolOrThrow(contextMaps, toolId, message) {
  const tool = contextMaps.toolsById[toolId] || null;
  if (!tool) {
    throw new Error(message);
  }

  return tool;
}

async function executeNode(node, graph, resultsByNodeId, contextMaps) {
  if (node.type === 'textInput') {
    const text = String(node.config?.text || '').trim();
    if (!text) {
      throw new Error('Enter some text for the Text Input node before running this pipeline.');
    }

    return {
      message: 'Prepared the text input.',
      preview: trimPreviewText(text),
      outputs: {
        text,
      },
    };
  }

  if (node.type === 'audioInput') {
    const filePath = path.resolve(String(node.config?.filePath || '').trim());
    if (!String(node.config?.filePath || '').trim()) {
      throw new Error('Choose an audio file for the Audio File node before running this pipeline.');
    }

    if (!(await fs.pathExists(filePath))) {
      throw new Error('The selected audio file could not be found anymore. Choose it again and try the pipeline one more time.');
    }

    return {
      message: 'Prepared the audio file input.',
      preview: trimPreviewText(filePath, 120),
      outputs: {
        audio: filePath,
      },
    };
  }

  if (node.type === 'llmPrompt') {
    const promptText = getNodeInputValue(node.id, 'prompt', graph, resultsByNodeId);
    const model = String(node.config?.model || '').trim();
    const executionMode = node.config?.executionMode === 'ollama' ? 'ollama' : 'cloud';
    if (!model) {
      throw new Error('Choose or enter a model for the LLM Prompt node before running this pipeline.');
    }

    const messages = buildLlmMessages(node, promptText);
    if (executionMode === 'ollama') {
      const ollamaTool = getInstalledToolOrThrow(
        contextMaps,
        'ollama',
        'Install Ollama before using a local LLM step in a pipeline.',
      );
      const result = await chatWithOllama(ollamaTool, {
        model,
        messages,
      });
      const content = String(result?.message?.content || '').trim();
      if (!content) {
        throw new Error('Ollama returned an empty reply for this pipeline step.');
      }

      return {
        message: 'Ollama returned a reply.',
        preview: trimPreviewText(content),
        outputs: {
          text: content,
        },
      };
    }

    const providerId = String(node.config?.providerId || '').trim();
    if (!providerId) {
      throw new Error('Choose a connected cloud provider before running this LLM step.');
    }

    const provider = contextMaps.providersById[providerId] || null;
    if (!provider?.isConnected) {
      throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
    }

    const result = await chatWithProvider(providerId, {
      providerId,
      model,
      messages,
    });
    const content = String(result?.message?.content || '').trim();
    if (!content) {
      throw new Error(`${provider.name} returned an empty reply for this pipeline step.`);
    }

    return {
      message: `${provider.name} returned a reply.`,
      preview: trimPreviewText(content),
      outputs: {
        text: content,
      },
    };
  }

  if (node.type === 'whisperTranscribe') {
    const audioPath = getNodeInputValue(node.id, 'audio', graph, resultsByNodeId);
    if (!audioPath) {
      throw new Error('This Whisper step did not receive an audio file.');
    }

    const whisperTool = getInstalledToolOrThrow(
      contextMaps,
      'whisper',
      'Install Whisper before using a transcription step in a pipeline.',
    );
    const result = await transcribeWithWhisper(whisperTool, {
      audioPath,
      model: node.config?.model || DEFAULT_WHISPER_MODEL,
    });
    const transcript = String(result?.text || '').trim();
    if (!transcript) {
      throw new Error('Whisper finished, but it did not return any transcript text for this pipeline step.');
    }

    return {
      message: 'Whisper finished transcribing the audio file.',
      preview: trimPreviewText(transcript),
      outputs: {
        text: transcript,
      },
    };
  }

  if (node.type === 'textOutput') {
    const text = String(getNodeInputValue(node.id, 'text', graph, resultsByNodeId) || '').trim();
    if (!text) {
      throw new Error('The output node did not receive any text to display.');
    }

    return {
      message: `${String(node.config?.title || 'Result').trim() || 'Result'} is ready.`,
      preview: trimPreviewText(text),
      outputs: {
        text,
      },
    };
  }

  throw new Error(`Local AI Hub does not support the ${node.type} node type in pipeline runs yet.`);
}

async function runPipeline(definition) {
  if (activeRun && activeRun.status === 'running') {
    throw new Error('A pipeline is already running. Wait for it to finish or cancel it before starting another one.');
  }

  const { analysis, context } = await analyzeWithCurrentContext(definition);
  if (!analysis.executable) {
    throw new Error(analysis.primaryIssue?.message || 'This pipeline is not ready to run yet.');
  }

  const graph = buildPipelineGraph(analysis.pipeline);
  activeRun = createRunRecord(analysis, graph);
  emitPipelineEvent();

  try {
    for (const nodeId of graph.executionOrder) {
      if (activeRun.cancelRequested) {
        markRemainingNodes(activeRun, graph, 'cancelled', 'Cancelled before this step started.');
        activeRun.status = 'cancelled';
        activeRun.message = 'Pipeline run cancelled.';
        activeRun.finishedAt = new Date().toISOString();
        activeRun.currentNodeId = null;
        emitPipelineEvent();
        return getActiveRunSnapshot();
      }

      const node = graph.nodeMap.get(nodeId);
      const nodeState = activeRun.nodeStates[nodeId];
      nodeState.status = 'running';
      nodeState.startedAt = new Date().toISOString();
      nodeState.message = 'Running now.';
      activeRun.currentNodeId = nodeId;
      activeRun.message = `Running ${node.label}...`;
      emitPipelineEvent();

      const result = await executeNode(node, graph, activeRun.resultsByNodeId, context);
      activeRun.resultsByNodeId[nodeId] = {
        outputs: result.outputs || {},
      };
      nodeState.status = 'completed';
      nodeState.finishedAt = new Date().toISOString();
      nodeState.message = result.message || 'Completed.';
      nodeState.preview = result.preview || '';
      nodeState.outputs = result.outputs || {};

      if (activeRun.terminalNodeIds.includes(nodeId)) {
        activeRun.terminalResults.push({
          nodeId,
          nodeLabel: node.label,
          title: String(node.config?.title || node.label || 'Output').trim(),
          value: String(result.outputs?.text || '').trim(),
        });
      }

      activeRun.currentNodeId = null;
      activeRun.message = `${node.label} finished.`;
      emitPipelineEvent();
    }

    activeRun.status = 'completed';
    activeRun.message = `${activeRun.pipelineName} finished successfully.`;
    activeRun.finishedAt = new Date().toISOString();
    emitPipelineEvent();
    return getActiveRunSnapshot();
  } catch (error) {
    const failedNodeId = activeRun.currentNodeId;
    if (failedNodeId && activeRun.nodeStates[failedNodeId]) {
      activeRun.nodeStates[failedNodeId].status = 'failed';
      activeRun.nodeStates[failedNodeId].finishedAt = new Date().toISOString();
      activeRun.nodeStates[failedNodeId].message = error.message || 'This step failed.';
    }

    markRemainingNodes(activeRun, graph, 'skipped', 'Skipped because an earlier step failed.');
    activeRun.status = 'failed';
    activeRun.message = error.message || 'Pipeline run failed.';
    activeRun.finishedAt = new Date().toISOString();
    activeRun.currentNodeId = null;
    emitPipelineEvent();
    throw error;
  }
}

function cancelPipelineRun(runId) {
  if (!activeRun || activeRun.status !== 'running') {
    throw new Error('There is no active pipeline run to cancel right now.');
  }

  if (runId && activeRun.runId !== runId) {
    throw new Error('Local AI Hub could not find that active pipeline run.');
  }

  activeRun.cancelRequested = true;
  activeRun.message = 'Local AI Hub will stop this pipeline after the current step finishes.';
  emitPipelineEvent();
  return getActiveRunSnapshot();
}

module.exports = {
  analyzeWithCurrentContext,
  cancelPipelineRun,
  getActiveRunSnapshot,
  runPipeline,
  setPipelineEventSink,
};

