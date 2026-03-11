const path = require('path');
const fs = require('fs-extra');

const { chatWithOllama } = require('./ollamaService');
const { listProviderConnections, chatWithProvider } = require('./providerService');
const { initializeProviderRegistry } = require('./providerRegistry');
const { getToolCatalog } = require('./toolRegistry');
const { buildMergedToolStateList, getResolvedToolState } = require('./toolStateService');
const { DEFAULT_WHISPER_MODEL, transcribeWithWhisper } = require('./whisperService');
const {
  buildFileArtifact,
  buildTerminalResult,
  copyArtifactToOutput,
  createTextArtifact,
  describeArtifactForLlm,
  ensureRunDirectories,
  saveBase64Artifact,
  serializeArtifactForUi,
  summarizeArtifact,
} = require('./pipelineArtifactService');
const {
  generateImageWithWorkflowTool,
  interrogateImageWithWorkflowTool,
  resolveSelectedImageTool,
} = require('./workflowToolService');
const {
  PORT_KIND_IMAGE,
  analyzePipeline,
  buildPipelineGraph,
  buildContextMaps,
  createUniqueId,
  getNodeTypeDefinition,
  trimPreviewText,
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

async function buildPipelineContext() {
  await initializeProviderRegistry();
  const toolEntries = await buildMergedToolStateList({
    resolveStatuses: true,
    syncDiscovered: true,
  });

  return buildContextMaps({
    hardware: null,
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
      destinationPath: '',
      finishedAt: null,
      message: graph.reachableNodeIds.has(node.id) ? 'Waiting for earlier steps to finish.' : 'Skipped because it is not connected to an output.',
      nodeId: node.id,
      nodeLabel: node.label,
      outputs: {},
      preview: '',
      selectedBranch: '',
      startedAt: null,
      status: graph.reachableNodeIds.has(node.id) ? 'queued' : 'skipped',
      type: node.type,
      validation: null,
    };
  }

  return nodeStates;
}

function createRunRecord(analysis, graph, runDirectories) {
  const runId = createUniqueId('run');
  return {
    cancelRequested: false,
    currentNodeId: null,
    directories: runDirectories,
    executionOrder: [...analysis.executionOrder],
    finishedAt: null,
    message: 'Local AI Hub is running the pipeline step by step.',
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

function getNodeInputArtifact(nodeId, portId, graph, resultsByNodeId) {
  const edge = graph.incomingEdgeByPortKey.get(`${nodeId}:${portId}`);
  if (!edge) {
    return undefined;
  }

  return resultsByNodeId[edge.source.nodeId]?.outputs?.[edge.source.portId];
}

function getMissingRequiredInputs(node, graph, resultsByNodeId) {
  const definition = getNodeTypeDefinition(node?.type);
  if (!definition) {
    return [];
  }

  return (definition.inputPorts || [])
    .filter((port) => port.required)
    .filter((port) => !getNodeInputArtifact(node.id, port.id, graph, resultsByNodeId))
    .map((port) => port.label);
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

function buildValidationMessages(node, artifactDescription) {
  const ruleset = String(node.config?.ruleset || '').trim();
  const systemPrompt = String(node.config?.systemPrompt || '').trim();
  const messages = [];

  messages.push({
    role: 'system',
    content: `${systemPrompt ? `${systemPrompt}\n\n` : ''}Return only valid JSON with keys decision and reason. decision must be "pass" or "fail".`,
  });
  messages.push({
    role: 'user',
    content: `Validation rules:\n${ruleset}\n\nArtifact to review:\n${artifactDescription}\n\nReturn JSON only.`,
  });

  return messages;
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
          decision,
          reason: String(parsed?.reason || parsed?.explanation || raw).trim(),
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
    decision: match[1].toLowerCase(),
    reason: raw,
  };
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

async function getSelectedImageToolOrThrow(contextMaps, node, actionLabel) {
  const selectedTool = resolveSelectedImageTool(contextMaps, node);
  if (!selectedTool?.id) {
    throw new Error(`Install Automatic1111 or Forge before using the ${actionLabel} step.`);
  }

  return getInstalledToolOrThrow(
    contextMaps,
    selectedTool.id,
    `Install Automatic1111 or Forge before using the ${actionLabel} step.`,
  );
}
async function buildValidationArtifactDescription(artifact, contextMaps) {
  let description = await describeArtifactForLlm(artifact);

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

  return description;
}

async function waitForUserValidation(run, node, artifact) {
  if (pendingValidationControl) {
    throw new Error('Local AI Hub is already waiting on another validation decision.');
  }

  const nodeState = run.nodeStates[node.id];
  const pendingValidation = {
    artifact: serializeArtifactForUi(artifact),
    mode: 'user',
    nodeId: node.id,
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
    run.message = `Paused at ${node.label}. Local AI Hub is waiting for your decision.`;
    run.pendingValidation = pendingValidation;
    nodeState.status = 'paused';
    nodeState.message = 'Waiting for your pass or fail decision.';
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

async function executeValidationNode(node, graph, run, contextMaps, reportProgress) {
  const artifact = getNodeInputArtifact(node.id, 'input', graph, run.resultsByNodeId);
  if (!artifact) {
    throw new Error('This validation step did not receive any content.');
  }

  if (node.config?.mode !== 'llm') {
    const decision = await waitForUserValidation(run, node, artifact);
    const selectedBranch = decision?.decision === 'pass' ? 'pass' : 'fail';
    const reason = decision?.comment ? `User note: ${decision.comment}` : `User selected ${selectedBranch}.`;
    return {
      message: `Validation routed this item to ${selectedBranch}.`,
      outputs: {
        [selectedBranch]: artifact,
      },
      preview: trimPreviewText(reason),
      selectedBranch,
      validation: {
        decision: selectedBranch,
        mode: 'user',
        reason,
      },
    };
  }

  const description = await buildValidationArtifactDescription(artifact, contextMaps);
  const messages = buildValidationMessages(node, description);
  const model = String(node.config?.model || '').trim();
  if (!model) {
    throw new Error('Choose or enter a model for this validator before running the pipeline.');
  }

  let reply = '';
  if (node.config?.llmExecutionMode === 'ollama') {
    reportProgress?.('Sending the content to Ollama for validation.', `Running ${node.label} with Ollama...`);
    const ollamaTool = await getInstalledToolOrThrow(
      contextMaps,
      'ollama',
      'Install Ollama before using a local validation step in a pipeline.',
    );
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

    reportProgress?.(`Sending the content to ${provider.name} for validation.`, `Running ${node.label} with ${provider.name}...`);
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
  return {
    message: `Validator routed this item to ${selectedBranch}.`,
    outputs: {
      [selectedBranch]: artifact,
    },
    preview: trimPreviewText(reason),
    selectedBranch,
    validation: {
      decision: selectedBranch,
      mode: 'llm',
      rawReply: reply,
      reason,
    },
  };
}

async function executeOutputNode(node, inputPortId, graph, run) {
  const artifact = getNodeInputArtifact(node.id, inputPortId, graph, run.resultsByNodeId);
  if (!artifact) {
    throw new Error('This output step did not receive any content to save.');
  }

  const savedArtifact = await copyArtifactToOutput(artifact, run.directories, {
    title: String(node.config?.title || node.label || 'output').trim() || 'output',
  });
  return {
    destinationPath: savedArtifact.destinationPath || savedArtifact.filePath || '',
    message: `${String(node.config?.title || node.label || 'Output').trim() || 'Output'} saved to ${savedArtifact.destinationPath || savedArtifact.filePath}.`,
    outputs: {
      [inputPortId]: savedArtifact,
    },
    preview: summarizeArtifact(savedArtifact),
    terminalResult: buildTerminalResult(node, savedArtifact),
  };
}

async function executeNode(node, graph, run, contextMaps, reportProgress) {
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

  if (node.type === 'llmPrompt') {
    const promptArtifact = getNodeInputArtifact(node.id, 'prompt', graph, run.resultsByNodeId);
    const promptText = String(promptArtifact?.text || '').trim();
    const model = String(node.config?.model || '').trim();
    const executionMode = node.config?.executionMode === 'ollama' ? 'ollama' : 'cloud';
    if (!promptText) {
      throw new Error('This LLM step did not receive any text input.');
    }

    if (!model) {
      throw new Error('Choose or enter a model for the LLM Prompt node before running this pipeline.');
    }

    const messages = buildLlmMessages(node, promptText);
    let content = '';
    let sourceLabel = 'This model';
    if (executionMode === 'ollama') {
      reportProgress?.('Sending the prompt to Ollama and waiting for a reply.', `Running ${node.label} with Ollama...`);
      const ollamaTool = await getInstalledToolOrThrow(
        contextMaps,
        'ollama',
        'Install Ollama before using a local LLM step in a pipeline.',
      );
      const result = await chatWithOllama(ollamaTool, {
        messages,
        model,
      });
      content = String(result?.message?.content || '').trim();
      sourceLabel = 'Ollama';
    } else {
      const providerId = String(node.config?.providerId || '').trim();
      if (!providerId) {
        throw new Error('Choose a connected cloud provider before running this LLM step.');
      }

      const provider = contextMaps.providersById[providerId] || null;
      if (!provider?.isConnected) {
        throw new Error('That cloud provider is not connected on this PC yet. Open Settings to save its API key first.');
      }

      reportProgress?.(`Sending the prompt to ${provider.name}.`, `Running ${node.label} with ${provider.name}...`);
      const result = await chatWithProvider(providerId, {
        messages,
        model,
        providerId,
      });
      content = String(result?.message?.content || '').trim();
      sourceLabel = provider.name;
    }

    if (!content) {
      throw new Error(`${sourceLabel} returned an empty reply for this pipeline step.`);
    }

    const artifact = createTextArtifact(content, {
      displayName: node.label,
      role: 'generated',
    });
    return {
      message: `${sourceLabel} returned a reply.`,
      outputs: {
        text: artifact,
      },
      preview: summarizeArtifact(artifact),
    };
  }
  if (node.type === 'whisperTranscribe') {
    const audioArtifact = getNodeInputArtifact(node.id, 'audio', graph, run.resultsByNodeId);
    if (!audioArtifact?.filePath) {
      throw new Error('This Whisper step did not receive an audio file.');
    }

    reportProgress?.('Sending the audio to Whisper for transcription.', `Running ${node.label} with Whisper...`);
    const whisperTool = await getInstalledToolOrThrow(
      contextMaps,
      'whisper',
      'Install Whisper before using a transcription step in a pipeline.',
    );
    const result = await transcribeWithWhisper(whisperTool, {
      audioPath: audioArtifact.filePath,
      model: node.config?.model || DEFAULT_WHISPER_MODEL,
    });
    const transcript = String(result?.text || '').trim();
    if (!transcript) {
      throw new Error('Whisper finished, but it did not return any transcript text for this pipeline step.');
    }

    const artifact = createTextArtifact(transcript, {
      displayName: node.label,
      role: 'generated',
    });
    return {
      message: 'Whisper finished transcribing the audio file.',
      outputs: {
        text: artifact,
      },
      preview: summarizeArtifact(artifact),
    };
  }

  if (node.type === 'imageAnalyze') {
    const imageArtifact = getNodeInputArtifact(node.id, 'image', graph, run.resultsByNodeId);
    if (!imageArtifact?.filePath) {
      throw new Error('This image analysis step did not receive an image file.');
    }

    const tool = await getSelectedImageToolOrThrow(contextMaps, node, 'image analysis');
    reportProgress?.(`Sending the image to ${tool.name} for analysis.`, `Running ${node.label} with ${tool.name}...`);
    const result = await interrogateImageWithWorkflowTool(tool, {
      analysisMode: node.config?.analysisMode || 'clip',
      imagePath: imageArtifact.filePath,
    });
    const description = String(result?.text || '').trim();
    if (!description) {
      throw new Error(`${tool?.name || 'The selected image tool'} did not return an image description.`);
    }

    const artifact = createTextArtifact(description, {
      displayName: node.label,
      role: 'generated',
    });
    return {
      message: `${tool.name} described the image.`,
      outputs: {
        text: artifact,
      },
      preview: summarizeArtifact(artifact),
    };
  }

  if (node.type === 'imageGenerate') {
    const promptArtifact = getNodeInputArtifact(node.id, 'prompt', graph, run.resultsByNodeId);
    const prompt = String(promptArtifact?.text || '').trim();
    if (!prompt) {
      throw new Error('This image generation step did not receive any text prompt.');
    }

    const tool = await getSelectedImageToolOrThrow(contextMaps, node, 'image generation');
    reportProgress?.(`Sending the prompt to ${tool.name} for image generation.`, `Running ${node.label} with ${tool.name}...`);
    const generated = await generateImageWithWorkflowTool(tool, {
      cfgScale: node.config?.cfgScale,
      height: node.config?.height,
      negativePrompt: node.config?.negativePrompt,
      prompt,
      seed: node.config?.seed,
      steps: node.config?.steps,
      width: node.config?.width,
    });
    const artifact = await saveBase64Artifact(run.directories, generated.base64Image, {
      baseName: `${node.label}-${Date.now()}`,
      displayName: node.label,
      extension: '.png',
      kind: 'image',
      role: 'generated',
    });
    return {
      destinationPath: artifact.filePath,
      message: `${tool.name} generated an image and saved the intermediate file to ${artifact.filePath}.`,
      outputs: {
        image: artifact,
      },
      preview: summarizeArtifact(artifact),
    };
  }

  if (node.type === 'validation') {
    return executeValidationNode(node, graph, run, contextMaps, reportProgress);
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
  try {
    for (const nodeId of graph.executionOrder) {
      if (!activeRun) {
        return;
      }

      if (activeRun.cancelRequested) {
        markRemainingNodes(activeRun, graph, 'cancelled', 'Cancelled before this step started.');
        activeRun.status = 'cancelled';
        activeRun.message = 'Pipeline run cancelled.';
        activeRun.finishedAt = new Date().toISOString();
        activeRun.currentNodeId = null;
        emitPipelineEvent();
        return;
      }

      const node = graph.nodeMap.get(nodeId);
      const nodeState = activeRun.nodeStates[nodeId];
      const missingInputs = getMissingRequiredInputs(node, graph, activeRun.resultsByNodeId);
      if (missingInputs.length) {
        nodeState.status = 'skipped';
        nodeState.finishedAt = new Date().toISOString();
        nodeState.message = `Skipped because ${missingInputs.join(', ')} did not receive content from the active branch.`;
        emitPipelineEvent();
        continue;
      }

      nodeState.status = 'running';
      nodeState.startedAt = new Date().toISOString();
      nodeState.message = 'Running now.';
      activeRun.currentNodeId = nodeId;
      activeRun.status = 'running';
      activeRun.message = `Running ${node.label}...`;
      emitPipelineEvent();

      const result = await executeNode(node, graph, activeRun, context, (message, runMessage) =>
        updateRunningNodeProgress(activeRun, node.id, message, runMessage),
      );
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

      if (result.terminalResult) {
        activeRun.terminalResults.push(result.terminalResult);
      }

      activeRun.currentNodeId = null;
      activeRun.message = `${node.label} finished.`;
      emitPipelineEvent();
    }

    if (!activeRun) {
      return;
    }

    activeRun.status = 'completed';
    activeRun.message = `${activeRun.pipelineName} finished successfully.`;
    activeRun.finishedAt = new Date().toISOString();
    emitPipelineEvent();
  } catch (error) {
    if (!activeRun) {
      return;
    }

    const isCancelled = error instanceof PipelineCancelledError || activeRun.cancelRequested;
    const failedNodeId = activeRun.currentNodeId;
    if (failedNodeId && activeRun.nodeStates[failedNodeId]) {
      activeRun.nodeStates[failedNodeId].status = isCancelled ? 'cancelled' : 'failed';
      activeRun.nodeStates[failedNodeId].finishedAt = new Date().toISOString();
      activeRun.nodeStates[failedNodeId].message = error.message || (isCancelled ? 'Pipeline run cancelled.' : 'This step failed.');
    }

    pendingValidationControl = null;
    activeRun.pendingValidation = null;
    markRemainingNodes(activeRun, graph, isCancelled ? 'cancelled' : 'skipped', isCancelled ? 'Cancelled before this step started.' : 'Skipped because an earlier step failed.');
    activeRun.status = isCancelled ? 'cancelled' : 'failed';
    activeRun.message = isCancelled ? 'Pipeline run cancelled.' : error.message || 'Pipeline run failed.';
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
  activeRun.message = 'Local AI Hub will stop this pipeline after the current step finishes.';
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




