import React, { useEffect, useMemo, useRef, useState } from 'react';
import pipelineShared from '../../electron/shared/pipelineSchema.cjs';
import {
  AUDIO_WORKFLOW_TOOL_IDS,
  GRAPH_WORKFLOW_TOOL_IDS,
  IMAGE_WORKFLOW_TOOL_IDS,
  VIDEO_WORKFLOW_TOOL_IDS,
  PIPELINE_NODE_WIDTH,
  WHISPER_MODELS,
  analyzePipelineDraft,
  buildPipelineDisplayContext,
  createPositionedNode,
  getNodeCardHeight,
  getNodePaletteGroups,
  getNodePortCenter,
  getPipelineNodeDefinition,
  runStatusClassName,
  summarizePreview,
  toneToClassName,
} from '../lib/pipeline-ui';

const {
  arePortsCompatible,
  buildPipelineGraph,
  createEdge,
  createEmptyPipeline,
  getDefaultGraphWorkflowBindings,
  getGraphWorkflowContract,
  getGraphWorkflowFieldOptions,
  getGraphWorkflowInputBinding,
  getGraphWorkflowOutputBinding,
  getGraphWorkflowOutputNodeOptions,
  getPortDefinition,
  parseGraphWorkflowDefinitionText,
  AUDIO_TRANSFORM_TOOL_IDS,
  IMAGE_TRANSFORM_TOOL_IDS,
  getModelStepOperationId,
  PIPELINE_OPERATION_IDS,
  PIPELINE_PORT_KIND_LABELS,
  PIPELINE_RETRY_LOOP_MAX_ATTEMPTS,
} = pipelineShared;
const CANVAS_MIN_WIDTH = 1280;
const CANVAS_MIN_HEIGHT = 820;

function fileNameFromPath(value) {
  return String(value || '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

function formatDateLabel(value) {
  if (!value) {
    return 'Never';
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatArtifactKindLabel(kind) {
  return PIPELINE_PORT_KIND_LABELS[String(kind || '').trim()] || 'Artifact';
}

function getArtifactPreviewKind(artifact) {
  if (!artifact) {
    return '';
  }

  if (artifact.previewKind) {
    return artifact.previewKind;
  }

  if (artifact.kind === 'text') {
    return 'text';
  }

  if (artifact.kind === 'audio') {
    return 'audio';
  }

  if (artifact.kind === 'video') {
    return String(artifact.mimeType || '').toLowerCase().startsWith('image/') ? 'animated-image' : 'video';
  }

  if (artifact.kind === 'image') {
    return artifact.isAnimated ? 'animated-image' : 'image';
  }

  return String(artifact.mimeType || '').toLowerCase().startsWith('image/')
    ? (artifact.isAnimated ? 'animated-image' : 'image')
    : 'file';
}

function formatFileSize(sizeBytes) {
  const numericSize = Number(sizeBytes || 0);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return '';
  }

  if (numericSize >= 1024 * 1024) {
    return `${Math.max(0.1, Math.round((numericSize / 1024 / 1024) * 10) / 10)} MB`;
  }

  return `${Math.max(1, Math.round(numericSize / 1024))} KB`;
}

function getIncomingConnectionCount(graph, nodeId, portId) {
  const portKey = `${nodeId}:${portId}`;
  const incomingEdges = graph?.incomingEdgesByPortKey?.get?.(portKey);
  if (Array.isArray(incomingEdges)) {
    return incomingEdges.length;
  }

  return graph?.incomingEdgeByPortKey?.has?.(portKey) ? 1 : 0;
}

function formatAttemptLabel(iteration, loopMaxAttempts) {
  const attemptNumber = Number(iteration || 0);
  const maxAttempts = Number(loopMaxAttempts || 0);
  if (maxAttempts > 0) {
    return `Attempt ${Math.max(1, attemptNumber || 1)} of ${maxAttempts}`;
  }

  if (attemptNumber > 1) {
    return `Attempt ${attemptNumber}`;
  }

  return '';
}

function getRetryLoopTargetOptions(nodes = [], graph, loopNodeId) {
  const loopNode = (Array.isArray(nodes) ? nodes : []).find((node) => node.id === loopNodeId);
  if (!loopNode) {
    return [];
  }

  const upstreamNodeIds = new Set();
  const queue = [loopNodeId];
  while (queue.length > 0) {
    const currentNodeId = queue.shift();
    for (const edge of graph?.incomingEdgesByNode?.get?.(currentNodeId) || []) {
      if (upstreamNodeIds.has(edge.source.nodeId)) {
        continue;
      }

      upstreamNodeIds.add(edge.source.nodeId);
      queue.push(edge.source.nodeId);
    }
  }

  const candidateNodes = (Array.isArray(nodes) ? nodes : []).filter((node) => {
    if (!node || node.id === loopNodeId || node.type === 'retryLoop') {
      return false;
    }

    if (getPipelineNodeDefinition(node.type)?.terminal) {
      return false;
    }

    return upstreamNodeIds.size === 0 || upstreamNodeIds.has(node.id);
  });

  if (candidateNodes.length) {
    return candidateNodes;
  }

  return (Array.isArray(nodes) ? nodes : []).filter((node) => node?.id !== loopNodeId && node?.type !== 'retryLoop' && !getPipelineNodeDefinition(node.type)?.terminal);
}

function formatAudioDurationLabel(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }

  if (numeric >= 60) {
    const minutes = Math.floor(numeric / 60);
    const seconds = Math.round((numeric - (minutes * 60)) * 10) / 10;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${Math.round(numeric * 10) / 10}s`;
}

function buildAudioChannelFact(channelCount) {
  const numeric = Number(channelCount || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }

  if (numeric === 1) {
    return 'Mono';
  }

  if (numeric === 2) {
    return 'Stereo';
  }

  return `${numeric} channels`;
}

function buildAudioFactLabels(artifact) {
  const audio = artifact?.audio && typeof artifact.audio === 'object' ? artifact.audio : null;
  const generation = artifact?.audioGeneration && typeof artifact.audioGeneration === 'object' ? artifact.audioGeneration : null;
  const transformation = artifact?.audioTransformation && typeof artifact.audioTransformation === 'object' ? artifact.audioTransformation : null;
  const mode = String(generation?.mode || '').trim().toLowerCase();
  const transformationType = String(transformation?.transformationType || '').trim().toLowerCase();
  return [
    formatAudioDurationLabel(audio?.durationSeconds || generation?.durationSeconds || transformation?.durationSeconds),
    audio?.sampleRate ? `${audio.sampleRate} Hz` : '',
    buildAudioChannelFact(audio?.channelCount),
    transformationType === 'voice-conversion' ? 'Voice conversion' : transformation?.transformationType ? transformation.transformationType : '',
    mode === 'music' ? 'Music mode' : mode === 'sound' ? 'Sound mode' : mode === 'speech' ? 'Speech mode' : '',
    transformation?.toolLabel || transformation?.backendLabel || generation?.toolLabel || generation?.backendLabel || '',
    transformation?.targetVoice ? `Voice ${transformation.targetVoice}` : generation?.voice ? `Voice ${generation.voice}` : '',
  ].filter(Boolean);
}
function buildImageFactLabels(artifact) {
  const transformation = artifact?.imageTransformation && typeof artifact.imageTransformation === 'object' ? artifact.imageTransformation : null;
  const transformationType = String(transformation?.transformationType || '').trim().toLowerCase();
  return [
    transformationType === 'upscale' ? 'Upscale' : transformationType === 'face-swap' ? 'Face swap' : transformation?.transformationType ? transformation.transformationType.replace(/-/g, ' ') : '',
    transformation?.toolLabel || transformation?.backendLabel || '',
    transformation?.scale ? `${transformation.scale}x scale` : '',
    transformation?.sourceImage?.fileName ? `Target ${transformation.sourceImage.fileName}` : '',
    transformation?.referenceImage?.fileName ? `Reference ${transformation.referenceImage.fileName}` : '',
  ].filter(Boolean);
}

function ArtifactFacts({ artifact, className = '' }) {
  if (!artifact) {
    return null;
  }

  const facts = [
    formatArtifactKindLabel(artifact.kind),
    artifact.formatLabel || '',
    artifact.mimeType || '',
    artifact.width && artifact.height ? `${artifact.width}x${artifact.height}` : '',
    formatFileSize(artifact.sizeBytes),
    artifact.fileName || '',
    ...buildImageFactLabels(artifact),
  ].filter(Boolean);

  if (!facts.length) {
    return null;
  }

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {facts.map((fact, index) => (
        <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-300" key={`${fact}-${index}`}>
          {fact}
        </span>
      ))}
    </div>
  );
}

function buildNodePreview(node, runState) {
  const nodeRunState = runState?.nodeStates?.[node.id];
  if (nodeRunState?.preview) {
    return nodeRunState.preview;
  }

  if (node.type === 'textInput') {
    return summarizePreview(node.config?.text || '');
  }

  if (node.type === 'imageInput' || node.type === 'audioInput' || node.type === 'videoInput' || node.type === 'fileInput') {
    return fileNameFromPath(node.config?.filePath || '') || 'No file selected yet.';
  }
  if (node.type === 'llmPrompt') {
    const selectedOperationId = getSelectedModelStepOperationId(node);
    const localToolFallbackLabel = selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
      ? 'Local audio tool'
      : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
        ? 'Local audio transform tool'
        : selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
          ? 'Local image transform tool'
          : selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
            ? 'Local video tool'
            : 'Local image tool';
    const modeLabel = node.config?.executionMode === 'ollama'
      ? 'Ollama'
      : node.config?.executionMode === 'localTool'
        ? (node.config?.toolId || localToolFallbackLabel)
        : (node.config?.providerId || 'Cloud provider');
    return `${getModelStepOperationLabel(node)} | ${modeLabel}${node.config?.model ? ` | ${node.config.model}` : ''}`;
  }
  if (node.type === 'whisperTranscribe') {
    return `Model: ${node.config?.model || 'base'}`;
  }

  if (node.type === 'imageAnalyze') {
    return `${node.config?.toolId || 'Auto image tool'} | ${node.config?.analysisMode || 'clip'}`;
  }

  if (node.type === 'imageGenerate') {
    return `${node.config?.toolId || 'Auto image tool'} | ${node.config?.width || 832}x${node.config?.height || 832}`;
  }

  if (node.type === 'graphWorkflow') {
    const contract = getGraphWorkflowContract(node.config?.toolId);
    const workflowDefinition = parseGraphWorkflowDefinitionText(node.config?.toolId, node.config?.workflowText);
    const nodeCountLabel = workflowDefinition.ok
      ? workflowDefinition.nodeEntries.length + ' parsed nodes'
      : contract.supportsExecution
        ? contract.workflowFormat?.label || 'Workflow definition'
        : 'Planned contract';
    const configuredOutputNodeIds = (contract.outputPorts || [])
      .map((entry) => String(getGraphWorkflowOutputBinding(node, entry.portId)?.nodeId || '').trim())
      .filter(Boolean);
    const outputLabel = configuredOutputNodeIds.length ? ' | outputs ' + configuredOutputNodeIds.join(', ') : '';
    return (node.config?.toolId || 'Graph workflow tool') + ' | ' + nodeCountLabel + outputLabel;
  }
  if (node.type === 'validation') {
    return node.config?.mode === 'llm'
      ? `${node.config?.llmExecutionMode === 'ollama' ? 'Ollama' : node.config?.providerId || 'Cloud validator'}${node.config?.model ? ` | ${node.config.model}` : ''}`
      : 'Pauses for a pass or fail decision';
  }

  if (node.type === 'branchMerge') {
    return 'Waits for earlier branches to settle, then forwards the single active branch';
  }

  if (node.type === 'retryLoop') {
    const retryTerminationAction = String(node.config?.retryTerminationAction || 'fail').trim() === 'complete' ? 'keep retry on stop' : 'fail on stop';
    const repeatRuleLabel = node.config?.stopWhenRetryArtifactRepeats ? ' | stop if unchanged' : '';
    return (node.config?.retryTargetNodeId || 'Choose retry target') + ' | ' + Math.max(2, Number(node.config?.maxAttempts || 3) || 3) + ' attempts | ' + retryTerminationAction + repeatRuleLabel;
  }

  if (node.type.endsWith('Output')) {
    return node.config?.title || 'Result';
  }

  return '';
}

function getIssueCountText(count) {
  if (!count) {
    return 'No blocking issues';
  }

  return `${count} issue${count === 1 ? '' : 's'} to review`;
}

function getModelTargetConfig(node) {
  if (node?.type === 'llmPrompt') {
    return {
      executionModeKey: 'executionMode',
      providerIdKey: 'providerId',
    };
  }

  if (node?.type === 'validation' && node.config?.mode === 'llm') {
    return {
      executionModeKey: 'llmExecutionMode',
      providerIdKey: 'providerId',
    };
  }

  return null;
}

function getSelectedModelStepOperationId(node) {
  return getModelStepOperationId(node);
}

function getModelStepOperationLabel(node) {
  const operationId = getSelectedModelStepOperationId(node);
  return operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
    ? 'Audio generation'
    : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
      ? 'Audio transform'
      : operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
        ? 'Image generation'
        : operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
          ? 'Image transform'
          : operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
            ? 'Video generation'
            : 'Text response';
}

function getCloudAudioModelPlaceholder(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'xai') {
    return 'Optional for xAI text-to-speech beta';
  }

  return 'Enter or pick a speech model';
}

function getCloudAudioModelRefreshHint(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'google') {
    return 'Loads Gemini speech models for this provider step.';
  }

  if (normalizedProviderId === 'openai') {
    return 'Loads OpenAI speech models for this provider step.';
  }

  if (normalizedProviderId === 'xai') {
    return "xAI's current TTS beta runs through a provider-managed speech runtime here. Leave Model blank unless xAI later exposes a selectable TTS model.";
  }

  return 'Loads cloud speech models for this provider step when the provider exposes them.';
}

function getCloudAudioModelHelp(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'google') {
    return 'Gemini speech uses TTS-capable Gemini models such as gemini-2.5-flash-preview-tts.';
  }

  if (normalizedProviderId === 'openai') {
    return 'OpenAI speech uses dedicated TTS models such as gpt-4o-mini-tts, tts-1, or tts-1-hd.';
  }

  if (normalizedProviderId === 'xai') {
    return 'xAI text-to-speech currently runs through a provider-managed speech runtime in this step, so model selection stays optional in this pass.';
  }

  return 'Choose a speech-capable model when the provider exposes one. Some providers may keep speech routing behind a provider-managed runtime instead.';
}

function getCloudAudioVoicePlaceholder(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'openai') {
    return 'Optional voice name such as alloy';
  }

  if (normalizedProviderId === 'xai') {
    return 'Optional voice name such as eve';
  }

  return 'Optional voice name such as Kore';
}

function getCloudAudioVoiceHelp(providerId) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (normalizedProviderId === 'openai') {
    return "OpenAI speech models save generated audio locally and keep it pipeline-usable. Leave voice blank to let Local AI Hub use OpenAI's default voice.";
  }

  if (normalizedProviderId === 'xai') {
    return "xAI speech saves generated audio locally and keeps it pipeline-usable. Leave voice blank to use xAI's default voice, or enter one such as eve, ara, rex, sal, or leo.";
  }

  if (normalizedProviderId === 'google') {
    return 'Gemini speech models save generated audio locally and keep it pipeline-usable. Leave voice blank to let Local AI Hub use the provider default.';
  }

  return 'Cloud speech providers save generated audio locally through the shared artifact path. Leave voice blank to use the provider default when available.';
}

function buildModelOptionDetail(model) {
  const detailParts = [];
  if (model?.detail) {
    detailParts.push(model.detail);
  }
  if (Array.isArray(model?.capabilityLabels) && model.capabilityLabels.length) {
    detailParts.push(model.capabilityLabels.join(' | '));
  }
  return detailParts.join(' | ');
}

function buildOllamaModelDetail(model) {
  const detailParts = [];
  if (model?.size) {
    detailParts.push(Math.round(Number(model.size) / 1024 / 1024) + ' MB');
  }
  if (model?.supportsImageInput === true) {
    detailParts.push('Vision');
  } else if (model?.supportsImageInput === false) {
    detailParts.push('Text only');
  }
  return detailParts.join(' | ');
}

function collectOllamaModelCapabilities(modelOptionsByNodeId) {
  const modelCapabilitiesByName = {};

  for (const modelOptions of Object.values(modelOptionsByNodeId || {})) {
    for (const model of Array.isArray(modelOptions) ? modelOptions : []) {
      const normalizedId = String(model?.id || '').trim().toLowerCase();
      if (!normalizedId || modelCapabilitiesByName[normalizedId] || typeof model?.supportsImageInput !== 'boolean') {
        continue;
      }

      modelCapabilitiesByName[normalizedId] = {
        capabilityLabels: Array.isArray(model.capabilityLabels) ? model.capabilityLabels : [],
        capabilitySource: String(model.capabilitySource || '').trim() || 'unknown',
        name: String(model.id || '').trim(),
        supportsImageInput: model.supportsImageInput,
      };
    }
  }

  return modelCapabilitiesByName;
}

function collectLocalToolModelsByToolId(modelOptionsByNodeId) {
  const localModelsByToolId = {};

  for (const modelOptions of Object.values(modelOptionsByNodeId || {})) {
    for (const model of Array.isArray(modelOptions) ? modelOptions : []) {
      const toolId = String(model?.toolId || '').trim();
      const modelId = String(model?.id || '').trim();
      if (!toolId || !modelId) {
        continue;
      }

      if (!localModelsByToolId[toolId]) {
        localModelsByToolId[toolId] = [];
      }

      if (localModelsByToolId[toolId].some((entry) => String(entry?.id || '').trim().toLowerCase() === modelId.toLowerCase())) {
        continue;
      }

      localModelsByToolId[toolId].push({
        ...model,
        downloaded: true,
        fileName: model.fileName || model.id,
        name: model.name || model.label || model.id,
        toolId,
      });
    }
  }

  return localModelsByToolId;
}

function formatGraphWorkflowNodeLabel(entry) {
  const nodeId = String(entry?.id || '').trim();
  const classType = String(entry?.classType || '').trim();
  return classType ? nodeId + ' - ' + classType : nodeId || 'Workflow node';
}

function formatGraphWorkflowAdapterLabel(contract) {
  return contract?.supportsExecution ? 'Runs in Local AI Hub' : 'Planned adapter';
}
function ArtifactPreview({ artifact, className = '', compact = false }) {
  if (!artifact) {
    return <div className={`rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-400 ${className}`}>Nothing to preview yet.</div>;
  }

  const previewKind = getArtifactPreviewKind(artifact);

  if (previewKind === 'text') {
    return (
      <textarea
        className={`store-input resize-none ${className}`}
        readOnly
        style={{ minHeight: compact ? '120px' : '180px' }}
        value={artifact.text || ''}
      />
    );
  }

  if ((previewKind === 'image' || previewKind === 'animated-image') && artifact.fileUrl) {
    const transformation = artifact.imageTransformation && typeof artifact.imageTransformation === 'object' ? artifact.imageTransformation : null;
    const sourceImage = transformation?.sourceImage && typeof transformation.sourceImage === 'object' ? transformation.sourceImage : null;
    const referenceImage = transformation?.referenceImage && typeof transformation.referenceImage === 'object' ? transformation.referenceImage : null;
    return (
      <div className={`space-y-3 ${className}`}>
        <img alt={artifact.displayName || 'Pipeline image output'} className="max-h-[280px] w-full rounded-[24px] border border-white/10 bg-slate-950/40 object-contain" src={artifact.fileUrl} />
        {artifact.summary ? <p className="text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
        {transformation ? (
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Transformed image</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-300">
              {buildImageFactLabels(artifact).map((label, index) => (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1" key={`${label}-${index}`}>
                  {label}
                </span>
              ))}
            </div>
            {transformation.model ? <input className="store-input mt-3" readOnly value={transformation.model} /> : null}
            {transformation.instruction ? <textarea className="store-input mt-3 min-h-[120px] resize-none" readOnly value={transformation.instruction} /> : null}
            {sourceImage ? (
              <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-slate-300">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Target image</p>
                {sourceImage.fileName || sourceImage.displayName ? <p className="mt-2">{sourceImage.fileName || sourceImage.displayName}</p> : null}
                {sourceImage.filePath ? <input className="store-input mt-3" readOnly value={sourceImage.filePath} /> : null}
              </div>
            ) : null}
            {referenceImage ? (
              <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-slate-300">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Reference image</p>
                {referenceImage.fileName || referenceImage.displayName ? <p className="mt-2">{referenceImage.fileName || referenceImage.displayName}</p> : null}
                {referenceImage.filePath ? <input className="store-input mt-3" readOnly value={referenceImage.filePath} /> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (previewKind === 'audio' && artifact.fileUrl) {
    const generation = artifact.audioGeneration && typeof artifact.audioGeneration === 'object' ? artifact.audioGeneration : null;
    const transformation = artifact.audioTransformation && typeof artifact.audioTransformation === 'object' ? artifact.audioTransformation : null;
    const sourceAudio = transformation?.sourceAudio && typeof transformation.sourceAudio === 'object'
      ? transformation.sourceAudio
      : generation?.sourceAudio && typeof generation.sourceAudio === 'object'
        ? generation.sourceAudio
        : null;
    return (
      <div className={`space-y-3 ${className}`}>
        <audio className="w-full" controls src={artifact.fileUrl} />
        <p className="text-xs leading-5 text-slate-400">{artifact.summary || artifact.fileName || artifact.displayName}</p>
        {transformation ? (
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Transformed audio</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-300">
              {buildAudioFactLabels(artifact).map((label, index) => (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1" key={`${label}-${index}`}>
                  {label}
                </span>
              ))}
            </div>
            {transformation.model ? <input className="store-input mt-3" readOnly value={transformation.model} /> : null}
            {transformation.instruction ? <textarea className="store-input mt-3 min-h-[120px] resize-none" readOnly value={transformation.instruction} /> : null}
          </div>
        ) : null}
        {generation ? (
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Generated audio</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-300">
              {buildAudioFactLabels(artifact).map((label, index) => (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1" key={`${label}-${index}`}>
                  {label}
                </span>
              ))}
            </div>
            {generation.model ? <input className="store-input mt-3" readOnly value={generation.model} /> : null}
            {generation.prompt ? <textarea className="store-input mt-3 min-h-[120px] resize-none" readOnly value={generation.prompt} /> : null}
          </div>
        ) : null}
        {sourceAudio ? (
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Source audio</p>
            {sourceAudio.fileName || sourceAudio.displayName ? <p className="mt-2 text-sm text-slate-200">{sourceAudio.fileName || sourceAudio.displayName}</p> : null}
            {sourceAudio.fileUrl ? <audio className="mt-3 w-full" controls src={sourceAudio.fileUrl} /> : null}
            {!sourceAudio.fileUrl && sourceAudio.filePath ? <input className="store-input mt-3" readOnly value={sourceAudio.filePath} /> : null}
          </div>
        ) : null}
      </div>
    );
  }
  if (previewKind === 'video' && artifact.fileUrl) {
    return (
      <div className={`space-y-3 ${className}`}>
        <video className="max-h-[280px] w-full rounded-[24px] border border-white/10 bg-black/40" controls src={artifact.fileUrl} />
        <p className="text-xs leading-5 text-slate-400">{artifact.summary || artifact.fileName || artifact.displayName}</p>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <input className="store-input" readOnly value={artifact.filePath || artifact.fileName || artifact.displayName || ''} />
      {artifact.previewText ? <textarea className="store-input min-h-[120px] resize-none" readOnly value={artifact.previewText} /> : null}
      {artifact.summary ? <p className="text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
    </div>
  );
}

function formatValidationEvidenceMode(validation) {
  const evidenceMode = String(validation?.evidenceMode || validation?.reviewContext?.evidenceMode || '').trim();
  if (!evidenceMode) {
    return '';
  }

  if (evidenceMode === 'direct-image') {
    return 'Reviewed attached image';
  }

  if (evidenceMode === 'direct-video') {
    return 'Reviewed attached video';
  }

  if (evidenceMode === 'direct-animated-image') {
    return 'Reviewed attached animated image';
  }

  if (evidenceMode === 'direct-file') {
    return 'Reviewed attached file';
  }

  if (evidenceMode === 'derived-file-text') {
    return 'Reviewed extracted document text';
  }

  if (evidenceMode === 'derived-image-description') {
    return 'Reviewed extracted image description';
  }

  if (evidenceMode === 'text-only') {
    return 'Reviewed plain text';
  }

  return 'Reviewed supporting metadata';
}

function formatValidationConfidence(confidence) {
  const numeric = Number(confidence);
  if (!Number.isFinite(numeric)) {
    return '';
  }

  return `${Math.round(Math.max(0, Math.min(1, numeric)) * 100)}% confidence`;
}

function ValidationResultSummary({ validation }) {
  if (!validation) {
    return null;
  }

  const evidenceMode = formatValidationEvidenceMode(validation);
  const confidenceLabel = formatValidationConfidence(validation.confidence);
  const criteriaResults = Array.isArray(validation.criteriaResults) ? validation.criteriaResults.slice(0, 3) : [];
  const reason = validation.summary || validation.reason || '';
  const limitations = validation.evidenceLimitations || '';

  return (
    <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-3 text-xs leading-5 text-slate-200">
      <p className="uppercase tracking-[0.18em] text-slate-400">Validation result</p>
      <p className="mt-2 text-sm font-medium text-white">{String(validation.decision || '').toUpperCase() || 'Decision recorded'}</p>
      {reason ? <p className="mt-2 text-slate-300">{reason}</p> : null}
      {evidenceMode || confidenceLabel ? <p className="mt-2 text-slate-400">{[evidenceMode, confidenceLabel].filter(Boolean).join(' | ')}</p> : null}
      {criteriaResults.length ? (
        <div className="mt-2 space-y-1 text-slate-300">
          {criteriaResults.map((entry, index) => (
            <p key={`${entry.criterion || 'criterion'}-${index}`}>
              {entry.criterion || 'Criterion'}: {entry.decision || 'not scored'}{entry.reason ? ` - ${entry.reason}` : ''}
            </p>
          ))}
        </div>
      ) : null}
      {limitations ? <p className="mt-2 text-amber-200/90">{limitations}</p> : null}
    </div>
  );
}

function AttemptHistoryList({ entries, title }) {
  const historyEntries = Array.isArray(entries) ? entries.filter(Boolean).slice().reverse() : [];
  if (!historyEntries.length) {
    return null;
  }

  return (
    <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-3">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</p>
      <div className="mt-2 space-y-2">
        {historyEntries.map((entry, index) => {
          const attemptLabel = formatAttemptLabel(entry?.attempt, entry?.loopMaxAttempts) || 'Earlier attempt';
          return (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2" key={`${title}-${entry?.attempt || index}-${entry?.recordedAt || index}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">{attemptLabel}</p>
                <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{entry?.status || 'completed'}</span>
              </div>
              {entry?.message ? <p className="mt-2 text-xs leading-5 text-slate-300">{entry.message}</p> : null}
              {entry?.selectedBranch ? <p className="mt-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">Routed to {entry.selectedBranch}</p> : null}
              {entry?.loopPathLabel ? <p className="mt-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">Loop path: {entry.loopPathLabel}</p> : null}
              {entry?.preview ? <p className="mt-2 text-xs leading-5 text-slate-400">{entry.preview}</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PathButtons({ path, onOpenPath, onRevealPath }) {
  if (!path) {
    return null;
  }

  return (
    <div className="mt-3 flex flex-wrap gap-3">
      <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => onOpenPath(path, false)} type="button">
        Open
      </button>
      <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => onRevealPath(path)} type="button">
        Show in folder
      </button>
    </div>
  );
}

function SavedPipelineRow({ active, pipeline, onClick }) {
  return (
    <button
      className={`w-full rounded-[24px] border px-4 py-4 text-left transition ${
        active ? 'border-cyan-300/35 bg-cyan-300/12 text-cyan-50' : 'border-white/10 bg-white/5 text-slate-200 hover:border-cyan-300/20 hover:bg-white/10'
      }`}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-white">{pipeline.name}</p>
        <span className="rounded-full border border-white/10 bg-slate-950/40 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400">
          {pipeline.nodeCount} node{pipeline.nodeCount === 1 ? '' : 's'}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{pipeline.description || 'No description yet.'}</p>
      <p className="mt-3 text-[11px] uppercase tracking-[0.2em] text-slate-500">Updated {formatDateLabel(pipeline.updatedAt)}</p>
    </button>
  );
}

function ResultCard({ result, onOpenPath, onRevealPath }) {
  const artifact = result?.artifact || null;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{result.title}</p>
          <p className="mt-2 text-sm font-semibold text-white">{formatArtifactKindLabel(result.kind || artifact?.kind)}</p>
        </div>
        {result.destinationPath ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">Saved</span> : null}
      </div>
      <ArtifactFacts artifact={artifact} className="mt-4" />
      <div className="mt-4">
        <ArtifactPreview artifact={artifact} />
      </div>
      {result.destinationPath ? <input className="store-input mt-4" readOnly value={result.destinationPath} /> : null}
      <PathButtons onOpenPath={onOpenPath} onRevealPath={onRevealPath} path={result.destinationPath || result.filePath} />
    </div>
  );
}
function ValidationDecisionCard({ pendingValidation, comment, onChangeComment, onDecide, onOpenPath, onRevealPath, busy }) {
  if (!pendingValidation) {
    return null;
  }

  const artifact = pendingValidation.artifact || null;
  const artifactLabel = formatArtifactKindLabel(artifact?.kind);
  const artifactName = artifact?.displayName || artifact?.fileName || '';
  const artifactPath = artifact?.filePath || '';
  const attemptLabel = formatAttemptLabel(pendingValidation.iteration, pendingValidation.loopMaxAttempts);
  return (
    <div className="rounded-[26px] border border-violet-400/30 bg-violet-400/10 p-4 text-violet-50">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-violet-100/80">Awaiting validation</p>
          <p className="mt-2 text-lg font-semibold text-white">{pendingValidation.nodeLabel}</p>
          {attemptLabel ? <p className="mt-2 text-xs uppercase tracking-[0.18em] text-violet-100/80">{attemptLabel}</p> : null}
          {pendingValidation.loopPathLabel ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-violet-100/70">Loop path: {pendingValidation.loopPathLabel}</p> : null}
          {artifactName ? <p className="mt-2 text-sm leading-6 text-violet-50/90">Reviewing {artifactLabel.toLowerCase()}: {artifactName}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {artifact ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/85">{artifactLabel}</span> : null}
          <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/85">
            Paused
          </span>
        </div>
      </div>
      <p className="mt-3 text-sm leading-6 text-violet-50/90">Review the received artifact below. If a preview is available, Local AI Hub shows it here before you choose pass or fail.</p>
      <ArtifactFacts artifact={artifact} className="mt-4" />
      <div className="mt-4">
        <ArtifactPreview artifact={artifact} />
      </div>
      {artifactPath ? <input className="store-input mt-4" readOnly value={artifactPath} /> : null}
      <PathButtons onOpenPath={onOpenPath} onRevealPath={onRevealPath} path={artifactPath} />
      <label className="mt-4 block text-xs uppercase tracking-[0.18em] text-violet-100/80" htmlFor="validation-comment">
        Optional note
      </label>
      <textarea
        className="store-input mt-3 min-h-[100px] resize-none"
        id="validation-comment"
        onChange={(event) => onChangeComment(event.target.value)}
        placeholder="Explain why this should pass or fail."
        value={comment}
      />
      <div className="mt-4 flex flex-wrap gap-3">
        <button className="primary-button" disabled={busy} onClick={() => onDecide('pass')} type="button">
          {busy ? 'Saving...' : 'Pass'}
        </button>
        <button className="ghost-button" disabled={busy} onClick={() => onDecide('fail')} type="button">
          Fail
        </button>
      </div>
    </div>
  );
}

function PipelineTimeline({ draft, runState, validationComment, onChangeValidationComment, onDecideValidation, onOpenPath, onRevealPath, validationBusy }) {
  const activeNodeState = runState?.currentNodeId ? runState.nodeStates?.[runState.currentNodeId] || null : null;
  const activeAttemptLabel = formatAttemptLabel(activeNodeState?.iteration, activeNodeState?.loopMaxAttempts);
  const loopStates = Object.values(runState?.loopStates || {});

  if (!runState) {
    return (
      <div className="rounded-[26px] border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
        Run the current pipeline to see each step move from queued to running to finished.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className={`rounded-[26px] border px-4 py-4 ${runStatusClassName(runState.status)}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-300">Latest run</p>
            <p className="mt-2 text-lg font-semibold text-white">{runState.pipelineName}</p>
          </div>
          <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/85">
            {runState.status}
          </span>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-200">{runState.message}</p>
        {loopStates.length ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {loopStates.map((loopState) => {
              const attemptLabel = formatAttemptLabel(loopState.attempt, loopState.maxAttempts);
              return (
                <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-200" key={loopState.loopNodeId}>
                  {loopState.loopLabel}: {attemptLabel || 'Ready'}{loopState.status && loopState.status !== 'ready' ? ` | ${loopState.status}` : ''}
                </span>
              );
            })}
          </div>
        ) : null}
        {loopStates.some((loopState) => Array.isArray(loopState.history) && loopState.history.length) ? (
          <div className="mt-3 space-y-3">
            {loopStates.map((loopState) => (
              <AttemptHistoryList entries={loopState.history} key={`${loopState.loopNodeId}-history`} title={`${loopState.loopLabel} activity`} />
            ))}
          </div>
        ) : null}
        {activeNodeState ? <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">Current step: {activeNodeState.nodeLabel || activeNodeState.nodeId}{activeAttemptLabel ? ` | ${activeAttemptLabel}` : ''}{activeNodeState?.loopPathLabel ? ` | ${activeNodeState.loopPathLabel}` : ''}</p> : null}
        <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
          Started {formatDateLabel(runState.startedAt)}{runState.finishedAt ? ` | Finished ${formatDateLabel(runState.finishedAt)}` : ''}
        </p>
        {runState.directories?.outputsDir ? <input className="store-input mt-4" readOnly value={runState.directories.outputsDir} /> : null}
        <PathButtons onOpenPath={onOpenPath} onRevealPath={onRevealPath} path={runState.directories?.outputsDir || ''} />
      </div>

      {runState.pendingValidation ? (
        <ValidationDecisionCard
          busy={validationBusy}
          comment={validationComment}
          onChangeComment={onChangeValidationComment}
          onDecide={onDecideValidation}
          onOpenPath={onOpenPath}
          onRevealPath={onRevealPath}
          pendingValidation={runState.pendingValidation}
        />
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[1.08fr,0.92fr]">
        <div className="rounded-[26px] border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Step-by-step status</p>
          <div className="mt-4 space-y-3">
            {runState.executionOrder.map((nodeId, index) => {
              const node = draft.nodes.find((entry) => entry.id === nodeId);
              const nodeState = runState.nodeStates?.[nodeId];
              const attemptLabel = formatAttemptLabel(nodeState?.iteration, nodeState?.loopMaxAttempts);
              return (
                <div key={nodeId} className={`rounded-2xl border px-3 py-3 ${runStatusClassName(nodeState?.status || 'queued')}`}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-white">
                      {index + 1}. {node?.label || nodeState?.nodeLabel || nodeId}
                    </p>
                    <span className="text-[11px] uppercase tracking-[0.18em] text-slate-300">{nodeState?.status || 'queued'}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-100">{nodeState?.message || 'Waiting to run.'}</p>
                  {attemptLabel ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-400">{attemptLabel}</p> : null}
                  {nodeState?.loopPathLabel ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">Loop path: {nodeState.loopPathLabel}</p> : null}
                  {nodeState?.runCount > 1 ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">Ran {nodeState.runCount} times in this run</p> : null}
                  {nodeState?.preview ? <p className="mt-2 text-xs leading-5 text-slate-300">{nodeState.preview}</p> : null}
                  {nodeState?.selectedBranch ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-400">Routed to {nodeState.selectedBranch}</p> : null}
                  <ValidationResultSummary validation={nodeState?.validation} />
                  <AttemptHistoryList entries={nodeState?.history} title="Previous attempts" />
                  {nodeState?.destinationPath ? <input className="store-input mt-3" readOnly value={nodeState.destinationPath} /> : null}
                  <PathButtons onOpenPath={onOpenPath} onRevealPath={onRevealPath} path={nodeState?.destinationPath || ''} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-[26px] border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Outputs</p>
          <div className="mt-4 space-y-3">
            {runState.terminalResults?.length ? (
              runState.terminalResults.map((result) => (
                <ResultCard key={`${result.nodeId}-${result.title}`} onOpenPath={onOpenPath} onRevealPath={onRevealPath} result={result} />
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
                Final outputs will appear here after the pipeline reaches an output node.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

class PipelineInspectorErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-[24px] border border-amber-400/30 bg-amber-500/10 p-4 text-sm leading-6 text-amber-50">
          <p className="text-[11px] uppercase tracking-[0.18em] text-amber-200">Inspector issue</p>
          <p className="mt-2">
            Local AI Hub hit a problem while showing this node. Select another node or reopen the pipeline if this keeps happening.
          </p>
          <button className="ghost-button mt-3" onClick={this.props.onClearSelection} type="button">
            Clear selection
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

function ModelTargetFields({ allowLocalTool = false, connectedProviders, localAudioTools = [], localAudioTransformTools = [], localImageTools = [], localImageTransformTools = [], localVideoTools = [], modelOptions, modelsBusy, node, onRefreshModels, onUpdateNode, executionModeKey, providerIdKey }) {
  const executionMode = node.config?.[executionModeKey] === 'ollama'
    ? 'ollama'
    : allowLocalTool && node.config?.[executionModeKey] === 'localTool'
      ? 'localTool'
      : 'cloud';
  const selectedOperationId = node.type === 'llmPrompt' ? getSelectedModelStepOperationId(node) : PIPELINE_OPERATION_IDS.LLM_PROMPT;
  const selectedCloudProviderId = String(node.config?.[providerIdKey] || '').trim().toLowerCase();
  const localToolOptions = selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
    ? localAudioTools
    : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
      ? localAudioTransformTools
      : selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
        ? localImageTransformTools
        : selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
          ? localVideoTools
          : localImageTools;
  const localToolLabel = selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
    ? 'Local audio tool'
    : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
      ? 'Local audio transform tool'
      : selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
        ? 'Local image transform tool'
        : selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
          ? 'Local video tool'
          : 'Local image tool';
  const localToolEmptyLabel = selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
    ? 'Choose AudioCraft WebUI'
    : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
      ? 'Choose RVC'
      : selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
        ? 'Choose Upscayl or FaceFusion'
        : selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
          ? 'Choose Wan2.1 WebUI'
          : 'Choose Automatic1111 or Forge';
  const selectedLocalToolId = String(node.config?.toolId || localToolOptions[0]?.id || '').trim();
  const selectedLocalTool = localToolOptions.find((tool) => tool.id === selectedLocalToolId) || null;
  const isLocalAudioMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE;
  const isLocalAudioTransformMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM;
  const isLocalImageTransformMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM;
  const isLocalVideoMode = executionMode === 'localTool' && selectedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE;

  return (
    <>
      <div>
        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-execution-mode`}>
          Execution target
        </label>
        <select
          className="store-input mt-3"
          id={`${node.id}-execution-mode`}
          onChange={(event) => {
            const nextExecutionMode = event.target.value;
            onUpdateNode(node.id, (currentNode) => {
              const currentOperationId = currentNode.type === 'llmPrompt' ? getSelectedModelStepOperationId(currentNode) : PIPELINE_OPERATION_IDS.LLM_PROMPT;
              const nextOperationId = currentNode.type === 'llmPrompt' && nextExecutionMode === 'ollama'
                ? PIPELINE_OPERATION_IDS.LLM_PROMPT
                : currentNode.type === 'llmPrompt' && nextExecutionMode === 'localTool'
                  ? (currentOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                    ? PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                    : currentOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                      ? PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                      : currentOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                        ? PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                        : currentOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                          ? PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                          : PIPELINE_OPERATION_IDS.IMAGE_GENERATE)
                  : currentOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE || currentOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM || currentOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                    ? PIPELINE_OPERATION_IDS.LLM_PROMPT
                    : currentOperationId;
              const nextLocalToolOptions = nextOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                ? localAudioTools
                : nextOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                  ? localAudioTransformTools
                  : nextOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                    ? localImageTransformTools
                    : nextOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                      ? localVideoTools
                      : localImageTools;
              const currentToolId = String(currentNode.config?.toolId || '').trim();
              const nextToolId = nextExecutionMode === 'localTool'
                ? (nextLocalToolOptions.some((tool) => tool.id === currentToolId) ? currentToolId : nextLocalToolOptions[0]?.id || '')
                : currentToolId;

              return {
                ...currentNode,
                config: {
                  ...currentNode.config,
                  [executionModeKey]: nextExecutionMode,
                  ...(currentNode.type === 'llmPrompt' ? { operationId: nextOperationId, toolId: nextToolId } : {}),
                  [providerIdKey]: nextExecutionMode === 'cloud' ? currentNode.config?.[providerIdKey] || '' : '',
                  model: '',
                },
              };
            });
          }}
          value={executionMode}
        >
          <option value="cloud">Cloud provider</option>
          <option value="ollama">Ollama (local)</option>
          {allowLocalTool ? <option value="localTool">Local media tool</option> : null}
        </select>
      </div>

      {executionMode === 'cloud' ? (
        <div>
          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-provider`}>
            Cloud provider
          </label>
          <select
            className="store-input mt-3"
            id={`${node.id}-provider`}
            onChange={(event) =>
              onUpdateNode(node.id, (currentNode) => ({
                ...currentNode,
                config: {
                  ...currentNode.config,
                  [providerIdKey]: event.target.value,
                  model: '',
                },
              }))
            }
            value={node.config?.[providerIdKey] || ''}
          >
            <option value="">Choose a connected provider</option>
            {connectedProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </div>
      ) : executionMode === 'localTool' ? (
        <div className="space-y-3">
          <div>
            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-local-tool`}>
              {localToolLabel}
            </label>
            <select
              className="store-input mt-3"
              id={`${node.id}-local-tool`}
              onChange={(event) =>
                onUpdateNode(node.id, (currentNode) => ({
                  ...currentNode,
                  config: {
                    ...currentNode.config,
                    model: '',
                    toolId: event.target.value,
                  },
                }))
              }
              value={node.config?.toolId || selectedLocalToolId || ''}
            >
              <option value="">{localToolEmptyLabel}</option>
              {localToolOptions.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.name}
                </option>
              ))}
            </select>
          </div>
          <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
            {isLocalAudioMode
              ? 'This mode runs a single AudioCraft request inside the sequential pipeline and returns a pipeline-usable audio artifact. Use Music mode for text-to-music or audio-guided generation in this slice.'
              : isLocalAudioTransformMode
                ? 'This mode runs a single source-audio transformation through RVC and returns a transformed audio artifact with source lineage. Use it for offline voice conversion from one saved audio clip to another in this first pass.'
                : isLocalImageTransformMode
                  ? 'This mode runs a single local image-to-image transformation and returns a transformed image artifact with source lineage. Use Upscayl for enhancement and upscaling, or FaceFusion when you also connect a Reference Image.'
                  : isLocalVideoMode
                    ? 'This mode runs a single local Wan video request inside the sequential pipeline. Use the Graph Workflow step when you want graph-native video generation through ComfyUI.'
                    : 'This mode runs a single Automatic1111 or Forge image request inside the current sequential pipeline. Use the Graph Workflow step when you need a graph-native tool such as ComfyUI.'}
          </div>
        </div>
      ) : (
        <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
          Local mode reuses the existing Ollama API path. Local AI Hub will launch Ollama automatically for this step when needed.
        </div>
      )}

      <div>
        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-model`}>
          {isLocalAudioMode ? 'Model override' : isLocalAudioTransformMode ? 'Voice model' : isLocalImageTransformMode ? 'Optional tool override' : isLocalVideoMode ? 'Model folder override' : executionMode === 'localTool' ? 'Checkpoint' : 'Model'}
        </label>
        <input
          className="store-input mt-3"
          id={`${node.id}-model`}
          onChange={(event) =>
            onUpdateNode(node.id, (currentNode) => ({
              ...currentNode,
              config: {
                ...currentNode.config,
                model: event.target.value,
              },
            }))
          }
          placeholder={isLocalAudioMode ? 'Optional AudioCraft model such as facebook/musicgen-melody' : isLocalAudioTransformMode ? 'Enter or pick an RVC voice model file' : isLocalImageTransformMode ? 'Optional future override when this tool exposes one' : isLocalVideoMode ? 'Optional Wan model folder name such as Wan2.1-T2V-1.3B' : executionMode === 'localTool' ? 'Enter or pick a checkpoint file name' : selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? getCloudAudioModelPlaceholder(selectedCloudProviderId) : 'Enter or pick a model'}
          value={node.config?.model || ''}
        />
        {isLocalAudioMode ? (
          <p className="mt-3 text-xs leading-5 text-slate-500">
            AudioCraft can use its built-in default models for this pass. Leave this blank unless you want to force a specific MusicGen or AudioGen model name.
          </p>
        ) : isLocalAudioTransformMode ? (
          <p className="mt-3 text-xs leading-5 text-slate-500">
            Choose an RVC voice model from the local weights folder. Clean single-speaker source clips work best in this first pass, and advanced pitch or index controls stay on the full RVC surface for now.
          </p>
        ) : isLocalImageTransformMode ? (
          <p className="mt-3 text-xs leading-5 text-slate-500">
            Upscayl and FaceFusion use tool-managed defaults in this first shared image-transform pass. Leave this blank unless a future tool build exposes a direct override here.
          </p>
        ) : isLocalVideoMode ? (
          <p className="mt-3 text-xs leading-5 text-slate-500">
            Local AI Hub auto-detects Wan model folders from <code>models\Wan-AI</code>. Leave this blank unless you need to force a specific installed model folder.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button className="ghost-button" disabled={modelsBusy} onClick={() => onRefreshModels(node)} type="button">
              {modelsBusy ? 'Refreshing...' : 'Refresh models'}
            </button>
            <span className="text-xs text-slate-500">
              {executionMode === 'ollama'
                ? 'Loads local Ollama models.'
                : executionMode === 'localTool'
                  ? isLocalAudioMode
                    ? 'AudioCraft uses built-in defaults in this first audio-output slice. Refresh is only needed for image checkpoints.'
                    : isLocalAudioTransformMode
                      ? `Loads local RVC voice models from ${selectedLocalTool?.name || 'the selected tool'}.`
                      : isLocalImageTransformMode
                        ? `${selectedLocalTool?.name || 'This tool'} uses tool-managed image transformation assets in this first pass, so refresh is not needed here.`
                        : `Loads local checkpoints from ${selectedLocalTool?.name || 'the selected tool'}.`
                  : node.type === 'llmPrompt' && getSelectedModelStepOperationId(node) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
                    ? 'Loads cloud image models for this provider step.'
                    : node.type === 'llmPrompt' && getSelectedModelStepOperationId(node) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                      ? getCloudAudioModelRefreshHint(selectedCloudProviderId)
                      : node.type === 'llmPrompt' && getSelectedModelStepOperationId(node) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                        ? 'Loads cloud video models for this provider step.'
                        : 'Loads models from the selected cloud provider.'}
            </span>
          </div>
        )}
        {!isLocalVideoMode && !isLocalAudioMode && !isLocalImageTransformMode && modelOptions?.length ? (
          <div className="mt-3 grid gap-2">
            {modelOptions.slice(0, 8).map((model) => (
              <button
                className={`rounded-2xl border px-3 py-3 text-left transition ${String(node.config?.model || '').trim().toLowerCase() === String(model.id || '').trim().toLowerCase() ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-50' : 'border-white/10 bg-white/[0.03] text-slate-200 hover:border-cyan-300/20 hover:bg-white/10'}`}
                key={model.id}
                onClick={() =>
                  onUpdateNode(node.id, (currentNode) => ({
                    ...currentNode,
                    config: {
                      ...currentNode.config,
                      model: model.id,
                    },
                  }))
                }
                type="button"
              >
                <p className="text-sm font-medium text-white">{model.label || model.id}</p>
                {buildModelOptionDetail(model) ? <p className="mt-1 text-xs leading-5 text-slate-400">{buildModelOptionDetail(model)}</p> : null}
              </button>
            ))}
          </div>
        ) : null}
        {executionMode === 'cloud' && selectedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? (
          <p className="mt-3 text-xs leading-5 text-slate-500">
            {getCloudAudioModelHelp(selectedCloudProviderId)}
          </p>
        ) : null}
      </div>
    </>
  );
}
export default function PipelineBuilderPanel({ hardware, manifests, onToast, providers, tools }) {
  const [pipelines, setPipelines] = useState([]);
  const [draft, setDraft] = useState(() => createEmptyPipeline());
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [pendingConnection, setPendingConnection] = useState(null);
  const [runState, setRunState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saveBusy, setSaveBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [validationBusy, setValidationBusy] = useState(false);
  const [validationComment, setValidationComment] = useState('');
  const [dirty, setDirty] = useState(false);
  const [modelOptionsByNodeId, setModelOptionsByNodeId] = useState({});
  const [modelsBusyNodeId, setModelsBusyNodeId] = useState('');
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const notifiedRunStateRef = useRef('');

  const ollamaModelCapabilitiesByName = useMemo(() => collectOllamaModelCapabilities(modelOptionsByNodeId), [modelOptionsByNodeId]);
  const localToolModelsByToolId = useMemo(() => collectLocalToolModelsByToolId(modelOptionsByNodeId), [modelOptionsByNodeId]);

  const pipelineTools = useMemo(
    () => (Object.keys(ollamaModelCapabilitiesByName).length || Object.keys(localToolModelsByToolId).length
      ? tools.map((tool) => {
          if (tool.id === 'ollama' && Object.keys(ollamaModelCapabilitiesByName).length) {
            return { ...tool, modelCapabilitiesByName: ollamaModelCapabilitiesByName };
          }

          if (localToolModelsByToolId[tool.id]) {
            return { ...tool, downloadedModels: localToolModelsByToolId[tool.id] };
          }

          return tool;
        })
      : tools),
    [localToolModelsByToolId, ollamaModelCapabilitiesByName, tools],
  );
  const contextMaps = useMemo(
    () => buildPipelineDisplayContext({ hardware, manifests, providers, tools: pipelineTools }),
    [hardware, manifests, pipelineTools, providers],
  );
  const analysis = useMemo(() => analyzePipelineDraft(draft, contextMaps), [draft, contextMaps]);
  const graph = useMemo(() => buildPipelineGraph(draft), [draft]);
  const selectedNode = useMemo(() => draft.nodes.find((node) => node.id === selectedNodeId) || null, [draft.nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => draft.edges.find((edge) => edge.id === selectedEdgeId) || null, [draft.edges, selectedEdgeId]);
  const selectedRetryLoopMeta = useMemo(
    () => (selectedNode?.type === 'retryLoop' ? graph.retryLoopsByNodeId?.get?.(selectedNode.id) || null : null),
    [graph, selectedNode],
  );
  const retryLoopTargetOptions = useMemo(
    () => (selectedNode?.type === 'retryLoop' ? getRetryLoopTargetOptions(draft.nodes, graph, selectedNode.id) : []),
    [draft.nodes, graph, selectedNode],
  );
  const connectedProviders = useMemo(() => (providers || []).filter((provider) => provider.isConnected), [providers]);
  const audioTools = useMemo(() => (tools || []).filter((tool) => AUDIO_WORKFLOW_TOOL_IDS.includes(tool.id) && !AUDIO_TRANSFORM_TOOL_IDS.includes(tool.id)), [tools]);
  const audioTransformTools = useMemo(() => (tools || []).filter((tool) => AUDIO_TRANSFORM_TOOL_IDS.includes(tool.id)), [tools]);
  const imageTools = useMemo(() => (tools || []).filter((tool) => IMAGE_WORKFLOW_TOOL_IDS.includes(tool.id)), [tools]);
  const imageTransformTools = useMemo(() => (tools || []).filter((tool) => IMAGE_TRANSFORM_TOOL_IDS.includes(tool.id)), [tools]);
  const videoTools = useMemo(() => (tools || []).filter((tool) => VIDEO_WORKFLOW_TOOL_IDS.includes(tool.id)), [tools]);
  const graphWorkflowTools = useMemo(() => {
    const entries = [...(tools || []), ...(manifests || [])];
    const seenToolIds = new Set();
    return entries.filter((tool) => {
      const toolId = String(tool?.id || '').trim();
      if (!toolId || seenToolIds.has(toolId) || !GRAPH_WORKFLOW_TOOL_IDS.includes(toolId)) {
        return false;
      }

      seenToolIds.add(toolId);
      return true;
    });
  }, [manifests, tools]);
  const selectedGraphWorkflowTool = useMemo(
    () => (selectedNode?.type === 'graphWorkflow'
      ? graphWorkflowTools.find((tool) => tool.id === (selectedNode.config?.toolId || graphWorkflowTools[0]?.id || '')) || null
      : null),
    [graphWorkflowTools, selectedNode],
  );
  const selectedGraphWorkflowToolContract = useMemo(
    () => (selectedNode?.type === 'graphWorkflow'
      ? getGraphWorkflowContract(selectedNode.config?.toolId || selectedGraphWorkflowTool?.id || graphWorkflowTools[0]?.id || '')
      : null),
    [graphWorkflowTools, selectedGraphWorkflowTool, selectedNode],
  );
  const selectedGraphWorkflowDefinition = useMemo(
    () => (selectedNode?.type === 'graphWorkflow'
      ? parseGraphWorkflowDefinitionText(selectedNode.config?.toolId || selectedGraphWorkflowTool?.id || '', selectedNode.config?.workflowText)
      : null),
    [selectedGraphWorkflowTool, selectedNode],
  );
  const graphWorkflowNodeOptions = selectedGraphWorkflowDefinition?.nodeEntries || [];
  const graphWorkflowTextBinding = useMemo(
    () => (selectedNode?.type === 'graphWorkflow' ? getGraphWorkflowInputBinding(selectedNode, 'text') : null),
    [selectedNode],
  );
  const graphWorkflowImageBinding = useMemo(
    () => (selectedNode?.type === 'graphWorkflow' ? getGraphWorkflowInputBinding(selectedNode, 'image') : null),
    [selectedNode],
  );
  const graphWorkflowImageOutputBinding = useMemo(
    () => (selectedNode?.type === 'graphWorkflow' ? getGraphWorkflowOutputBinding(selectedNode, 'image') : null),
    [selectedNode],
  );
  const graphWorkflowVideoOutputBinding = useMemo(
    () => (selectedNode?.type === 'graphWorkflow' ? getGraphWorkflowOutputBinding(selectedNode, 'video') : null),
    [selectedNode],
  );
  const graphWorkflowTextFieldOptions = useMemo(
    () => getGraphWorkflowFieldOptions(selectedGraphWorkflowDefinition, graphWorkflowTextBinding?.nodeId, 'text'),
    [graphWorkflowTextBinding?.nodeId, selectedGraphWorkflowDefinition],
  );
  const graphWorkflowImageFieldOptions = useMemo(
    () => getGraphWorkflowFieldOptions(selectedGraphWorkflowDefinition, graphWorkflowImageBinding?.nodeId, 'image'),
    [graphWorkflowImageBinding?.nodeId, selectedGraphWorkflowDefinition],
  );
  const graphWorkflowImageOutputNodeOptions = useMemo(
    () => getGraphWorkflowOutputNodeOptions(selectedGraphWorkflowDefinition, 'image'),
    [selectedGraphWorkflowDefinition],
  );
  const graphWorkflowVideoOutputNodeOptions = useMemo(
    () => getGraphWorkflowOutputNodeOptions(selectedGraphWorkflowDefinition, 'video'),
    [selectedGraphWorkflowDefinition],
  );
  const currentPipelineSaved = useMemo(() => pipelines.some((pipeline) => pipeline.id === draft.id), [pipelines, draft.id]);
  const currentNodeSummary = selectedNode ? analysis.nodeSummaries?.[selectedNode.id] || null : null;
  const canvasSize = useMemo(() => {
    const width = Math.max(CANVAS_MIN_WIDTH, ...draft.nodes.map((node) => Math.round(node.position.x + PIPELINE_NODE_WIDTH + 180)));
    const height = Math.max(CANVAS_MIN_HEIGHT, ...draft.nodes.map((node) => Math.round(node.position.y + getNodeCardHeight(node) + 200)));
    return { height, width };
  }, [draft.nodes]);

  function replaceDraft(nextPipeline, options = {}) {
    setDraft(nextPipeline);
    setSelectedNodeId((current) => {
      if (options.selectedNodeId !== undefined) {
        return options.selectedNodeId;
      }
      if (current && nextPipeline.nodes.some((node) => node.id === current)) {
        return current;
      }
      return nextPipeline.nodes[0]?.id || '';
    });
    setPendingConnection(null);
    setDirty(Boolean(options.dirty));
  }

  function applyRunSnapshot(nextRun) {
    setRunState((current) => {
      if (!nextRun) {
        return null;
      }

      if (!current || current.runId !== nextRun.runId) {
        return nextRun;
      }

      const currentRevision = Number(current.revision || 0);
      const nextRevision = Number(nextRun.revision || 0);
      return nextRevision < currentRevision ? current : nextRun;
    });
  }

  function rememberHistoricalRunNotification(nextRun) {
    if (!nextRun?.runId || !nextRun?.status) {
      return;
    }

    if (nextRun.status === 'completed' || nextRun.status === 'failed' || nextRun.status === 'cancelled') {
      notifiedRunStateRef.current = `${nextRun.runId}:${nextRun.status}`;
    }
  }
  function markDirty() {
    setDirty(true);
  }

  function updateNode(nodeId, updater) {
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
    }));
    markDirty();
  }

  function updateGraphWorkflowInputBinding(nodeId, portId, nextBinding) {
    updateNode(nodeId, (currentNode) => ({
      ...currentNode,
      config: {
        ...currentNode.config,
        inputBindings: {
          ...(currentNode.config?.inputBindings || {}),
          [portId]: {
            ...(currentNode.config?.inputBindings?.[portId] || {}),
            ...nextBinding,
          },
        },
      },
    }));
  }

  function updateGraphWorkflowOutputBinding(nodeId, portId, nextBinding) {
    updateNode(nodeId, (currentNode) => ({
      ...currentNode,
      config: {
        ...currentNode.config,
        outputBindings: {
          ...(currentNode.config?.outputBindings || {}),
          [portId]: {
            ...(currentNode.config?.outputBindings?.[portId] || {}),
            ...nextBinding,
          },
        },
      },
    }));
  }

  async function refreshPipelineList() {
    const result = await window.localAIHub.listPipelines();
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not load the saved pipelines.', 'error');
      return [];
    }

    const savedPipelines = result.data?.pipelines || [];
    setPipelines(savedPipelines);
    return savedPipelines;
  }

  async function loadSavedPipeline(pipelineId, options = {}) {
    if (!pipelineId) {
      return;
    }

    if (dirty && !options.force) {
      const confirmed = window.confirm('Discard the unsaved pipeline changes and load another saved pipeline?');
      if (!confirmed) {
        return;
      }
    }

    const result = await window.localAIHub.getPipeline(pipelineId);
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not load that pipeline.', 'error');
      return;
    }

    replaceDraft(result.data?.pipeline || createEmptyPipeline(), {
      dirty: false,
    });
  }

  async function openPath(pathValue, reveal = false) {
    if (!pathValue) {
      return;
    }

    const result = await window.localAIHub.openPath({ path: pathValue, reveal });
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not open that file or folder.', 'error');
    }
  }

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.localAIHub.onPipelineRunUpdate((payload) => {
      if (disposed || !payload?.run) {
        return;
      }

      applyRunSnapshot(payload.run);
      if (payload.run.status !== 'running') {
        setRunBusy(false);
      }
      if (payload.run.status !== 'running' && payload.run.status !== 'paused') {
        setCancelBusy(false);
        setValidationBusy(false);
      }
    });

    async function loadInitialState() {
      const [savedPipelines, activeRunResult] = await Promise.all([
        refreshPipelineList(),
        window.localAIHub.getActivePipelineRun(),
      ]);
      if (disposed) {
        return;
      }

      if (activeRunResult?.ok) {
        const historicalRun = activeRunResult.data?.run || null;
        rememberHistoricalRunNotification(historicalRun);
        applyRunSnapshot(historicalRun);
      } else if (activeRunResult?.message) {
        onToast(activeRunResult.message, 'error');
      }

      if (savedPipelines.length > 0) {
        const pipelineResult = await window.localAIHub.getPipeline(savedPipelines[0].id);
        if (!disposed && pipelineResult?.ok) {
          replaceDraft(pipelineResult.data?.pipeline || createEmptyPipeline(), {
            dirty: false,
          });
        }
      }

      if (!disposed) {
        setLoading(false);
      }
    }

    loadInitialState();

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!runState?.runId || !runState?.status) {
      return;
    }

    const notificationKey = `${runState.runId}:${runState.status}`;
    if (notifiedRunStateRef.current === notificationKey) {
      return;
    }

    if (runState.status === 'completed') {
      onToast(runState.message || `${runState.pipelineName} finished successfully.`, 'success');
      notifiedRunStateRef.current = `${runState.runId}:${runState.status}`;
    } else if (runState.status === 'failed' || runState.status === 'cancelled') {
      onToast(runState.message || 'Pipeline run stopped.', 'error');
      notifiedRunStateRef.current = `${runState.runId}:${runState.status}`;
    }
  }, [onToast, runState]);

  useEffect(() => {
    setValidationComment('');
  }, [runState?.pendingValidation?.requestId]);

  useEffect(() => {
    function handleMouseMove(event) {
      if (!dragRef.current || !canvasRef.current) {
        return;
      }

      const { nodeId, offsetX, offsetY } = dragRef.current;
      const canvasBounds = canvasRef.current.getBoundingClientRect();
      const nextX = Math.max(24, event.clientX - canvasBounds.left + canvasRef.current.scrollLeft - offsetX);
      const nextY = Math.max(24, event.clientY - canvasBounds.top + canvasRef.current.scrollTop - offsetY);

      setDraft((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                position: {
                  x: nextX,
                  y: nextY,
                },
              }
            : node,
        ),
      }));
      markDirty();
    }

    function handleMouseUp() {
      dragRef.current = null;
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  function createNewPipeline() {
    if (dirty) {
      const confirmed = window.confirm('Discard the unsaved pipeline changes and start a new pipeline?');
      if (!confirmed) {
        return;
      }
    }

    replaceDraft(createEmptyPipeline(), {
      dirty: false,
      selectedNodeId: '',
    });
    setRunState((current) => (current?.status === 'running' || current?.status === 'paused' ? current : null));
  }

  function addNode(type) {
    const nextNode = createPositionedNode(type, draft.nodes);
    setDraft((current) => ({
      ...current,
      nodes: [...current.nodes, nextNode],
    }));
    setSelectedNodeId(nextNode.id);
    markDirty();
  }

  function removeNode(nodeId) {
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      edges: current.edges.filter((edge) => edge.source.nodeId !== nodeId && edge.target.nodeId !== nodeId),
    }));
    setSelectedNodeId((current) => (current === nodeId ? '' : current));
    setSelectedEdgeId('');
    markDirty();
  }

  function removeEdge(edgeId) {
    setDraft((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edge.id !== edgeId),
    }));
    setSelectedEdgeId((current) => (current === edgeId ? '' : current));
    markDirty();
  }

  function startDrag(nodeId, event) {
    if (!canvasRef.current) {
      return;
    }

    const canvasBounds = canvasRef.current.getBoundingClientRect();
    const node = draft.nodes.find((entry) => entry.id === nodeId);
    if (!node) {
      return;
    }

    dragRef.current = {
      nodeId,
      offsetX: event.clientX - canvasBounds.left + canvasRef.current.scrollLeft - node.position.x,
      offsetY: event.clientY - canvasBounds.top + canvasRef.current.scrollTop - node.position.y,
    };
  }
  function connectPorts(sourceNodeId, sourcePortId, targetNodeId, targetPortId) {
    const sourceNode = draft.nodes.find((node) => node.id === sourceNodeId);
    const targetNode = draft.nodes.find((node) => node.id === targetNodeId);
    const sourcePort = getPortDefinition(sourceNode?.type, 'output', sourcePortId);
    const targetPort = getPortDefinition(targetNode?.type, 'input', targetPortId);

    if (!sourceNode || !targetNode || !sourcePort || !targetPort) {
      onToast('Local AI Hub could not create that connection.', 'error');
      return;
    }

    if (sourceNodeId === targetNodeId) {
      onToast('A node cannot connect to itself.', 'error');
      return;
    }

    const existingExactEdge = draft.edges.find(
      (edge) =>
        edge.source.nodeId === sourceNodeId
        && edge.source.portId === sourcePortId
        && edge.target.nodeId === targetNodeId
        && edge.target.portId === targetPortId,
    );
    if (existingExactEdge) {
      onToast('Those ports are already connected.', 'error');
      return;
    }

    const existingTargetEdges = draft.edges.filter((edge) => edge.target.nodeId === targetNodeId && edge.target.portId === targetPortId);
    if (existingTargetEdges.length && !targetPort.allowMultipleConnections) {
      onToast(`${targetNode.label} already has a connection for ${targetPort.label}. Remove it first, or use a Branch Merge node to recombine multiple branches.`, 'error');
      return;
    }

    const nextDraft = {
      ...draft,
      edges: [...draft.edges, createEdge(sourceNodeId, sourcePortId, targetNodeId, targetPortId)],
    };
    const nextGraph = buildPipelineGraph(nextDraft);
    const newErrors = nextGraph.errors.filter((message) => !graph.errors.includes(message));
    if (newErrors.length) {
      const nextMessage = newErrors[0];
      onToast(
        nextMessage.toLowerCase().includes('cycle')
          ? 'That connection would create a raw cycle. Use a Retry Loop node when you want a bounded retry path.'
          : nextMessage,
        'error',
      );
      return;
    }

    replaceDraft(nextDraft, {
      dirty: true,
    });
    setSelectedEdgeId('');
    setSelectedNodeId(targetNodeId);
  }

  function isPendingConnectionCompatible(targetNode, targetPort) {
    if (!pendingConnection || !targetNode || !targetPort) {
      return false;
    }

    const sourceNode = draft.nodes.find((node) => node.id === pendingConnection.sourceNodeId);
    const sourcePort = getPortDefinition(sourceNode?.type, 'output', pendingConnection.sourcePortId);
    if (!sourceNode || !sourcePort) {
      return false;
    }

    return arePortsCompatible(sourcePort, targetPort, {
      graph,
      sourceNode,
      targetNode,
    });
  }

  async function handleSavePipeline() {
    setSaveBusy(true);
    const result = await window.localAIHub.savePipeline(draft);
    setSaveBusy(false);

    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not save that pipeline.', 'error');
      return;
    }

    setPipelines(result.data?.pipelines || []);
    replaceDraft(result.data?.pipeline || draft, {
      dirty: false,
    });
    onToast(result.data?.message || 'Pipeline saved.', 'success');
  }

  async function handleDeletePipeline() {
    if (!currentPipelineSaved) {
      createNewPipeline();
      return;
    }

    const confirmed = window.confirm(`Delete ${draft.name} from the saved pipeline list?`);
    if (!confirmed) {
      return;
    }

    setDeleteBusy(true);
    const result = await window.localAIHub.deletePipeline(draft.id);
    setDeleteBusy(false);

    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not delete that pipeline.', 'error');
      return;
    }

    const nextPipelines = result.data?.pipelines || [];
    setPipelines(nextPipelines);
    onToast(result.data?.message || 'Pipeline deleted.', 'success');

    if (nextPipelines.length > 0) {
      await loadSavedPipeline(nextPipelines[0].id, {
        force: true,
      });
      return;
    }

    replaceDraft(createEmptyPipeline(), {
      dirty: false,
      selectedNodeId: '',
    });
  }

  async function refreshNodeModels(node) {
    const modelConfig = getModelTargetConfig(node);
    if (!modelConfig) {
      return;
    }

    setModelsBusyNodeId(node.id);
    const rawExecutionMode = String(node.config?.[modelConfig.executionModeKey] || '').trim();
    const executionMode = rawExecutionMode === 'ollama'
      ? 'ollama'
      : node.type === 'llmPrompt' && rawExecutionMode === 'localTool'
        ? 'localTool'
        : 'cloud';
    let models = [];
    if (executionMode === 'ollama') {
      const result = await window.localAIHub.listOllamaModels({ includeCapabilities: true, preferLocalLibrary: true });
      if (!result?.ok) {
        setModelsBusyNodeId('');
        onToast(result?.message || 'Local AI Hub could not load your local Ollama models.', 'error');
        return;
      }

      models = (result.data?.models || []).map((model) => ({
        id: model.name,
        label: model.name,
        detail: buildOllamaModelDetail(model),
        capabilityLabels: Array.isArray(model.capabilityLabels) ? model.capabilityLabels : [],
        capabilitySource: model.capabilitySource || '',
        supportsImageInput: typeof model.supportsImageInput === 'boolean' ? model.supportsImageInput : undefined,
      }));
    } else if (executionMode === 'localTool') {
      const operationId = getSelectedModelStepOperationId(node);
      if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
        const toolId = String(node.config?.toolId || audioTools[0]?.id || '').trim();
        if (!toolId) {
          setModelsBusyNodeId('');
          onToast('Install AudioCraft WebUI before configuring local audio generation for this step.', 'error');
          return;
        }

        setModelOptionsByNodeId((current) => ({
          ...current,
          [node.id]: [],
        }));
        setModelsBusyNodeId('');
        if (!String(node.config?.toolId || '').trim()) {
          updateNode(node.id, (currentNode) => ({
            ...currentNode,
            config: {
              ...currentNode.config,
              toolId,
            },
          }));
        }
        onToast('AudioCraft uses built-in MusicGen and AudioGen defaults in this first audio-output slice. Leave Model override blank unless you need to force a specific model name.', 'info');
        return;
      }

      if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
        const toolId = String(node.config?.toolId || audioTransformTools[0]?.id || '').trim();
        if (!toolId) {
          setModelsBusyNodeId('');
          onToast('Install RVC before refreshing voice models for this audio transformation step.', 'error');
          return;
        }

        const result = await window.localAIHub.listLocalModels(toolId);
        if (!result?.ok) {
          setModelsBusyNodeId('');
          onToast(result?.message || 'Local AI Hub could not load local RVC voice models for that step.', 'error');
          return;
        }

        models = (result.data || [])
          .map((model) => ({
            ...model,
            id: String(model.relativePath || model.fileName || model.name || model.id || '').trim(),
            label: model.name || model.fileName || model.relativePath || model.id,
            detail: [model.modelType, model.relativePath].filter(Boolean).join(' | '),
            toolId,
          }))
          .filter((model) => model.id);

        if (!String(node.config?.toolId || '').trim()) {
          updateNode(node.id, (currentNode) => ({
            ...currentNode,
            config: {
              ...currentNode.config,
              toolId,
            },
          }));
        }
      } else if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
        const toolId = String(node.config?.toolId || imageTransformTools[0]?.id || '').trim();
        if (!toolId) {
          setModelsBusyNodeId('');
          onToast('Install Upscayl or FaceFusion before configuring local image transformation for this step.', 'error');
          return;
        }

        setModelOptionsByNodeId((current) => ({
          ...current,
          [node.id]: [],
        }));
        setModelsBusyNodeId('');
        if (!String(node.config?.toolId || '').trim()) {
          updateNode(node.id, (currentNode) => ({
            ...currentNode,
            config: {
              ...currentNode.config,
              toolId,
            },
          }));
        }
        onToast('Upscayl and FaceFusion use tool-managed defaults and assets in this first shared image-transform slice. Leave Optional tool override blank unless a future tool build exposes one here.', 'info');
        return;
      } else if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
        setModelOptionsByNodeId((current) => ({
          ...current,
          [node.id]: [],
        }));
        setModelsBusyNodeId('');
        onToast('Local AI Hub auto-detects Wan model folders from models\\Wan-AI for this first video slice. Enter a model folder name only if you need to override the default.', 'info');
        return;
      } else {
        const toolId = String(node.config?.toolId || imageTools[0]?.id || '').trim();
        if (!toolId) {
          setModelsBusyNodeId('');
          onToast('Install Automatic1111 or Forge before refreshing local image checkpoints for this step.', 'error');
          return;
        }

        const result = await window.localAIHub.listLocalModels(toolId);
        if (!result?.ok) {
          setModelsBusyNodeId('');
          onToast(result?.message || 'Local AI Hub could not load local checkpoints for that image tool.', 'error');
          return;
        }

        models = (result.data || [])
          .filter((model) => {
            const modelType = String(model?.modelType || '').trim().toLowerCase();
            return modelType === 'checkpoint' || modelType === 'inpainting';
          })
          .map((model) => ({
            ...model,
            id: String(model.fileName || model.name || model.id || '').trim(),
            label: model.name || model.fileName || model.id,
            detail: [model.modelType, model.relativePath].filter(Boolean).join(' | '),
            toolId,
          }))
          .filter((model) => model.id);

        if (!String(node.config?.toolId || '').trim()) {
          updateNode(node.id, (currentNode) => ({
            ...currentNode,
            config: {
              ...currentNode.config,
              toolId,
            },
          }));
        }
      }
    } else {
      const providerId = String(node.config?.[modelConfig.providerIdKey] || '').trim();
      if (!providerId) {
        setModelsBusyNodeId('');
        onToast('Choose a connected cloud provider before refreshing models for this step.', 'error');
        return;
      }

      const result = await window.localAIHub.listProviderModels(node.type === 'llmPrompt' ? { operationId: getSelectedModelStepOperationId(node), providerId } : providerId);
      if (!result?.ok) {
        setModelsBusyNodeId('');
        onToast(result?.message || 'Local AI Hub could not load models for that cloud provider.', 'error');
        return;
      }

      models = result.data?.models || [];
      if (node.type === 'llmPrompt' && getSelectedModelStepOperationId(node) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE && providerId === 'xai' && !models.length) {
        onToast('xAI text-to-speech currently runs through a provider-managed speech runtime in this step. Leave Model blank and choose a voice if you want to use xAI.', 'info');
      }
      if (!String(node.config?.model || '').trim() && result.data?.selectedModel) {
        updateNode(node.id, (currentNode) => ({
          ...currentNode,
          config: {
            ...currentNode.config,
            model: result.data.selectedModel,
          },
        }));
      }
    }

    setModelOptionsByNodeId((current) => ({
      ...current,
      [node.id]: models,
    }));
    if (!String(node.config?.model || '').trim() && models[0]?.id) {
      updateNode(node.id, (currentNode) => ({
        ...currentNode,
        config: {
          ...currentNode.config,
          model: models[0].id,
        },
      }));
    }
    setModelsBusyNodeId('');
  }
  async function chooseNodeFile(nodeId, kind) {
    const result = await window.localAIHub.pickPipelineFile({ kind });
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not open that file picker.', 'error');
      return;
    }

    if (result.data?.canceled || !result.data?.filePath) {
      return;
    }

    updateNode(nodeId, (currentNode) => ({
      ...currentNode,
      config: {
        ...currentNode.config,
        filePath: result.data.filePath,
      },
    }));
  }

  async function handleRunPipeline() {
    if (!analysis.executable) {
      onToast(analysis.primaryIssue?.message || 'This pipeline is not ready to run yet.', 'error');
      return;
    }

    if (runState?.status === 'running' || runState?.status === 'paused') {
      onToast('A pipeline run is already active. Finish, resume, or cancel it before starting another one.', 'error');
      return;
    }

    if (analysis.compatibilitySummary && ['warn', 'danger'].includes(analysis.compatibilitySummary.tone)) {
      const confirmed = window.confirm(
        `${analysis.compatibilitySummary.message}\n\nThis pipeline still runs sequentially so only one heavy local step executes at a time. Continue anyway?`,
      );
      if (!confirmed) {
        return;
      }
    }

    setRunBusy(true);
    const result = await window.localAIHub.runPipeline(draft);
    setRunBusy(false);
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not run that pipeline.', 'error');
      return;
    }

    applyRunSnapshot(result.data?.run || null);
    onToast(result.data?.message || 'Pipeline started. Local AI Hub will launch any required local tools as the run reaches them.', 'success');
  }

  async function handleCancelRun() {
    if (!runState?.runId) {
      return;
    }

    setCancelBusy(true);
    const result = await window.localAIHub.cancelPipelineRun(runState.runId);
    if (!result?.ok) {
      setCancelBusy(false);
      onToast(result?.message || 'Local AI Hub could not cancel that pipeline run.', 'error');
      return;
    }

    if (result.data?.run) {
      applyRunSnapshot(result.data.run);
    }
    onToast(result.data?.message || 'Local AI Hub will stop the active pipeline after the current step finishes and shut down any tool it started for the run.', 'success');
  }

  async function handleValidationDecision(decision) {
    const pendingValidation = runState?.pendingValidation;
    if (!runState?.runId || !pendingValidation?.nodeId) {
      return;
    }

    setValidationBusy(true);
    const result = await window.localAIHub.resumePipelineValidation({
      comment: validationComment,
      decision,
      nodeId: pendingValidation.nodeId,
      requestId: pendingValidation.requestId,
      runId: runState.runId,
    });
    setValidationBusy(false);
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not continue that validation step.', 'error');
      return;
    }

    if (result.data?.run) {
      applyRunSnapshot(result.data.run);
    }
    setValidationComment('');
    onToast(result.data?.message || 'Validation decision saved.', 'success');
  }

  const paletteGroups = getNodePaletteGroups();
  const graphEdges = draft.edges.filter((edge) => graph.nodeMap.has(edge.source.nodeId) && graph.nodeMap.has(edge.target.nodeId));

  if (loading) {
    return <section className="panel p-6 text-sm text-slate-300">Loading the Pipeline Builder...</section>;
  }

  return (
    <section className="space-y-5">
      <div className="panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Pipeline Builder</p>
            <h3 className="mt-3 text-3xl font-semibold tracking-tight text-white">Build typed Local AI Hub workflows</h3>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
              Provider and tool nodes stay capability-aware across text, image, audio, video, and file artifacts while Local AI Hub launches heavy local tools one step at a time.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button className="ghost-button" onClick={createNewPipeline} type="button">New pipeline</button>
            <button className="ghost-button" disabled={!currentPipelineSaved || deleteBusy} onClick={handleDeletePipeline} type="button">
              {deleteBusy ? 'Deleting...' : 'Delete'}
            </button>
            <button className="primary-button" disabled={saveBusy} onClick={handleSavePipeline} type="button">
              {saveBusy ? 'Saving...' : 'Save pipeline'}
            </button>
            {runState?.status === 'running' || runState?.status === 'paused' ? (
              <button className="ghost-button" disabled={cancelBusy} onClick={handleCancelRun} type="button">
                {cancelBusy ? 'Cancelling...' : 'Cancel run'}
              </button>
            ) : (
              <button className="primary-button" disabled={runBusy} onClick={handleRunPipeline} type="button">
                {runBusy ? 'Starting...' : 'Run pipeline'}
              </button>
            )}
          </div>
        </div>

        <div className="mt-6 grid gap-4 xl:grid-cols-[1.1fr,1fr]">
          <div className="rounded-[28px] border border-white/10 bg-slate-950/35 p-4">
            <label className="text-xs uppercase tracking-[0.2em] text-slate-500" htmlFor="pipeline-name">Pipeline name</label>
            <input
              className="store-input mt-3"
              id="pipeline-name"
              onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({ ...current, name: value }));
                markDirty();
              }}
              placeholder="Untitled pipeline"
              value={draft.name}
            />
            <label className="mt-4 block text-xs uppercase tracking-[0.2em] text-slate-500" htmlFor="pipeline-description">Description</label>
            <textarea
              className="store-input mt-3 min-h-[120px] resize-none"
              id="pipeline-description"
              onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({ ...current, description: value }));
                markDirty();
              }}
              placeholder="What should this workflow do?"
              value={draft.description}
            />
          </div>

          <div className={`rounded-[28px] border p-4 ${toneToClassName(analysis.compatibilitySummary?.tone || analysis.primaryIssue?.tone || 'neutral')}`}>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Readiness and suitability</p>
            <p className="mt-3 text-lg font-semibold text-white">{analysis.compatibilitySummary?.label || (analysis.executable ? 'Ready to run' : 'Needs attention')}</p>
            <p className="mt-2 text-sm leading-6 text-slate-100">{analysis.primaryIssue?.message || analysis.compatibilitySummary?.message || 'This pipeline is ready to run.'}</p>
            <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-slate-300">
              <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">{analysis.executionOrder.length} queued step{analysis.executionOrder.length === 1 ? '' : 's'}</span>
              <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">{getIssueCountText(analysis.issues.length)}</span>
              <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">Sequential only</span>
            </div>
            {analysis.issues.length ? (
              <div className="mt-4 space-y-2">
                {analysis.issues.slice(0, 5).map((issue, index) => (
                  <div key={`${issue.message}-${index}`} className={`rounded-2xl border px-3 py-2 text-sm ${toneToClassName(issue.tone)}`}>{issue.message}</div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="space-y-5">
          <div className="panel p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Saved pipelines</p>
                <p className="mt-2 text-lg font-semibold text-white">Load and reuse</p>
              </div>
              <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => refreshPipelineList()} type="button">Refresh list</button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {pipelines.length ? pipelines.map((pipeline) => (
                <SavedPipelineRow active={pipeline.id === draft.id} key={pipeline.id} onClick={() => loadSavedPipeline(pipeline.id)} pipeline={pipeline} />
              )) : (
                <div className="rounded-[24px] border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
                  Save the current pipeline to build a reusable library here.
                </div>
              )}
            </div>
          </div>

          <div className="panel p-5">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Node palette</p>
            <p className="mt-2 text-lg font-semibold text-white">Inputs, AI, flow, validation, outputs</p>
            <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs leading-6 text-slate-400">
              Add nodes across text, image, audio, video, and file workflows. Connections stay typed, validation can branch to pass or fail, and Branch Merge recombines compatible paths explicitly.
            </div>
            <div className="mt-4 grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
              {paletteGroups.map((group) => (
                <div key={group.label} className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{group.label}</p>
                  <div className="mt-3 space-y-2">
                    {group.entries.map((entry) => (
                      <button
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:border-cyan-300/25 hover:bg-white/10"
                        key={entry.type}
                        onClick={() => addNode(entry.type)}
                        type="button"
                      >
                        <p className="text-sm font-semibold text-white">{entry.label}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">{entry.description}</p>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel p-5">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Inspector</p>
            <p className="mt-2 text-lg font-semibold text-white">{selectedNode ? selectedNode.label : 'Select a node'}</p>
            {selectedNode ? (
              <PipelineInspectorErrorBoundary onClearSelection={() => setSelectedNodeId('')} resetKey={selectedNode.id}>
                <div className="mt-4 space-y-4">
                <div>
                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="node-label">Node label</label>
                  <input className="store-input mt-3" id="node-label" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, label: event.target.value }))} value={selectedNode.label} />
                </div>

                <div className={`rounded-[24px] border p-4 ${toneToClassName(currentNodeSummary?.readiness?.tone || currentNodeSummary?.compatibility?.tone || 'neutral')}`}>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-300">Readiness</p>
                  <p className="mt-2 text-sm leading-6 text-slate-100">{currentNodeSummary?.readiness?.message || 'This node is ready.'}</p>
                  {currentNodeSummary?.capabilitySummary ? <p className="mt-2 text-xs leading-5 text-slate-200">{currentNodeSummary.capabilitySummary.message}</p> : null}
                  {currentNodeSummary?.compatibility ? <p className="mt-2 text-xs leading-5 text-slate-200">{currentNodeSummary.compatibility.source}: {currentNodeSummary.compatibility.message}</p> : null}
                </div>

                {selectedNode.type === 'textInput' ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="node-text-input">Text input</label><textarea className="store-input mt-3 min-h-[180px] resize-none" id="node-text-input" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, text: event.target.value } }))} placeholder="Write the initial text for this workflow." value={selectedNode.config?.text || ''} /></div> : null}

                {['imageInput', 'audioInput', 'videoInput', 'fileInput'].includes(selectedNode.type) ? (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="node-file-input">Selected file</label>
                      <input className="store-input mt-3" id="node-file-input" readOnly value={selectedNode.config?.filePath || ''} />
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <button className="ghost-button" onClick={() => chooseNodeFile(selectedNode.id, selectedNode.type === 'imageInput' ? 'image' : selectedNode.type === 'audioInput' ? 'audio' : selectedNode.type === 'videoInput' ? 'video' : 'file')} type="button">Choose file</button>
                      <button className="ghost-button" onClick={() => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, filePath: '' } }))} type="button">Clear</button>
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'llmPrompt' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-operation">
                        Operation
                      </label>
                      <select
                        className="store-input mt-3"
                        disabled={selectedNode.config?.executionMode === 'ollama'}
                        id="llm-operation"
                        onChange={(event) =>
                          updateNode(selectedNode.id, (currentNode) => {
                            const nextOperationId = event.target.value;
                            const nextLocalToolOptions = nextOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                              ? audioTools
                              : nextOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                                ? audioTransformTools
                                : nextOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                                  ? imageTransformTools
                                  : nextOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                                    ? videoTools
                                    : imageTools;
                            const currentToolId = String(currentNode.config?.toolId || '').trim();
                            const nextToolId = currentNode.config?.executionMode === 'localTool'
                              ? (nextLocalToolOptions.some((tool) => tool.id === currentToolId) ? currentToolId : nextLocalToolOptions[0]?.id || '')
                              : currentToolId;
                            return {
                              ...currentNode,
                              config: {
                                ...currentNode.config,
                                model: '',
                                operationId: nextOperationId,
                                toolId: nextToolId,
                              },
                            };
                          })
                        }
                        value={getSelectedModelStepOperationId(selectedNode)}
                      >
                        <option value={PIPELINE_OPERATION_IDS.LLM_PROMPT}>Text response</option>
                        <option value={PIPELINE_OPERATION_IDS.IMAGE_GENERATE}>Image generation</option>
                        {selectedNode.config?.executionMode === 'localTool' ? <option value={PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM}>Image transform</option> : null}
                        {selectedNode.config?.executionMode !== 'ollama' ? <option value={PIPELINE_OPERATION_IDS.AUDIO_GENERATE}>Audio generation</option> : null}
                        {selectedNode.config?.executionMode === 'localTool' ? <option value={PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM}>Audio transform</option> : null}
                        <option value={PIPELINE_OPERATION_IDS.VIDEO_GENERATE}>Video generation</option>
                      </select>
                      <p className="mt-2 text-xs leading-5 text-slate-400">
                        {selectedNode.config?.executionMode === 'ollama'
                          ? 'Local Ollama mode currently returns text only.'
                          : selectedNode.config?.executionMode === 'localTool'
                            ? getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                              ? 'Local audio tool mode returns a generated audio artifact from the Audio output port. Music mode can also use an upstream audio artifact as guidance in this slice.'
                              : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                                ? 'Local audio transform tool mode returns a transformed audio artifact from the Audio output port and keeps the source-audio lineage visible after the run.'
                                : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                                  ? 'Local image transform mode returns a transformed image artifact from the Image output port. FaceFusion also expects a connected Reference Image in this first image-only pass.'
                                  : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                                    ? 'Local video tool mode returns a video artifact from the Video output port. Use the Graph Workflow step for ComfyUI video workflows.'
                                    : 'Local image tool mode returns an image artifact from the Image output port.'
                            : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
                              ? 'This step returns an image artifact from the Image output port.'
                              : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                                ? 'This step returns a saved audio artifact from the Audio output port.'
                                : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                                  ? 'Audio transform runs through the local-tool path and returns a saved transformed audio artifact from the Audio output port.'
                                  : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                                    ? 'This step returns a video artifact from the Video output port.'
                                    : 'This step returns a text artifact from the Text output port.'}
                      </p>
                    </div>
                    <ModelTargetFields allowLocalTool connectedProviders={connectedProviders} executionModeKey="executionMode" localAudioTools={audioTools} localAudioTransformTools={audioTransformTools} localImageTools={imageTools} localImageTransformTools={imageTransformTools} localVideoTools={videoTools} modelOptions={modelOptionsByNodeId[selectedNode.id]} modelsBusy={modelsBusyNodeId === selectedNode.id} node={selectedNode} onRefreshModels={refreshNodeModels} onUpdateNode={updateNode} providerIdKey="providerId" />
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-instruction">
                        {getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
                          ? 'Prompt prefix / style guidance'
                          : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                            ? selectedNode.config?.executionMode === 'localTool'
                              ? 'Prompt shaping / audio guidance'
                              : 'Speech guidance / delivery hint'
                            : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                              ? 'Transformation note'
                              : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                                ? 'Transformation note'
                                : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                                  ? 'Motion guidance / prompt shaping'
                                  : 'Task / instruction'}
                      </label>
                      <textarea
                        className="store-input mt-3 min-h-[120px] resize-none"
                        id="llm-instruction"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, instruction: event.target.value } }))}
                        placeholder={getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
                          ? 'Optional style or scene guidance to prepend to the incoming prompt.'
                          : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                            ? selectedNode.config?.executionMode === 'localTool'
                              ? 'Optional guidance for the generated audio. In Music mode, use this for mood, style, or instrumentation. With upstream audio, this can steer how the result evolves.'
                              : 'Optional guidance for how the provider should speak the connected text, such as tone, pacing, or delivery style.'
                            : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
                              ? 'Optional note to save with this transformed audio result. Choose the source audio and RVC voice model through the connected input and local model field.'
                              : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
                                ? 'Optional note to save with this transformed image result. The main image input becomes the target image, and FaceFusion also uses the Reference Image input in this first pass.'
                                : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                                  ? 'For text-to-video, this is optional extra guidance. For image-to-video, use this box for the motion prompt.'
                                  : 'Optional guidance to apply to the incoming text.'}
                        value={selectedNode.config?.instruction || ''}
                      />
                      {getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? (
                        <p className="mt-2 text-xs leading-5 text-slate-400">
                          {selectedNode.config?.executionMode === 'localTool'
                            ? 'Text input becomes the base generation prompt. In Music mode, you can also connect an upstream audio artifact to guide the result. Sound mode stays text-only in this first shared audio-output slice.'
                            : 'Text input becomes the spoken content for this cloud audio step. Use the instruction box for optional delivery guidance, and choose a provider voice below when the model supports it.'}
                        </p>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM ? (
                        <p className="mt-2 text-xs leading-5 text-slate-400">
                          Connect a source audio artifact to this step and choose an RVC voice model. This instruction box is saved with the transformed result as a plain-English note in this first pass.
                        </p>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM ? (
                        <p className="mt-2 text-xs leading-5 text-slate-400">
                          Connect the target image to the main input for every local image transform step. FaceFusion also needs a source-face image on the Reference Image input, while Upscayl uses only the main image input in this pass.
                        </p>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE ? (
                        <p className="mt-2 text-xs leading-5 text-slate-400">
                          Text input becomes the base video prompt. If this step is connected to an image, use this box for the motion prompt that should animate that image.
                        </p>
                      ) : null}
                    </div>
                    {selectedNode.config?.executionMode === 'localTool' ? (
                      getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? (
                        <div className="space-y-4">
                          <div>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-audio-mode">Audio mode</label>
                            <select className="store-input mt-3" id="llm-local-audio-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audioMode: event.target.value } }))} value={selectedNode.config?.audioMode || 'music'}>
                              <option value="music">Music</option>
                              <option value="sound">Sound</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-audio-duration">Duration (seconds)</label>
                            <input className="store-input mt-3" id="llm-local-audio-duration" max="60" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, durationSeconds: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.durationSeconds || 8} />
                          </div>
                          <p className="text-xs leading-5 text-slate-400">
                            {selectedNode.config?.audioMode === 'sound'
                              ? 'Sound mode runs AudioGen and currently accepts text prompts only. Use it for environmental or effect-style clips rather than melody-guided output.'
                              : 'Music mode runs MusicGen. Connect text for text-to-music, or connect an audio artifact to guide melody and structure while keeping this instruction box as optional extra guidance.'}
                          </p>
                        </div>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM ? (
                        <div className="space-y-4">
                          <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                            This step converts one saved audio artifact into another with RVC. Connect a source audio clip, choose a voice model, and run the step when RVC is installed and ready.
                          </div>
                          <p className="text-xs leading-5 text-slate-400">
                            Keep source clips clean and single-speaker when possible. Advanced RVC controls such as pitch extraction, index rate, and protect tuning stay on the dedicated RVC surface for now.
                          </p>
                        </div>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM ? (
                        <div className="space-y-4">
                          <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                            This step transforms one saved image into another through a local image tool. Connect the target image to the main input. Use Upscayl for enhancement or upscaling, and use FaceFusion when you also connect a Reference Image.
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-[20px] border border-white/10 bg-slate-950/35 px-4 py-3 text-sm leading-6 text-slate-300">
                              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Upscayl</p>
                              <p className="mt-2">Uses the main image input only and currently applies the tool-managed upscale path for this first shared image-transform slice.</p>
                            </div>
                            <div className="rounded-[20px] border border-white/10 bg-slate-950/35 px-4 py-3 text-sm leading-6 text-slate-300">
                              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">FaceFusion</p>
                              <p className="mt-2">Uses the main image input as the target image and the Reference Image input as the source-face image in this image-only pass.</p>
                            </div>
                          </div>
                          <p className="text-xs leading-5 text-slate-400">
                            Advanced Upscayl model choices and broader FaceFusion controls stay on the dedicated tool surfaces for now. This step keeps the transformed image pipeline-usable with clear source-image lineage.
                          </p>
                        </div>
                      ) : getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE ? (
                        <div className="space-y-4">
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-video-size">Video size</label><select className="store-input mt-3" id="llm-local-video-size" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoSize: event.target.value } }))} value={selectedNode.config?.videoSize || '1280x720'}><option value="832x480">832 x 480</option><option value="1280x720">1280 x 720</option></select></div>
                          <div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-video-steps">Steps</label><input className="store-input mt-3" id="llm-local-video-steps" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, steps: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.steps || 24} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-video-seed">Seed</label><input className="store-input mt-3" id="llm-local-video-seed" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, seed: Number(event.target.value || -1) } }))} type="number" value={selectedNode.config?.seed ?? -1} /></div></div>
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-negative-prompt">Negative prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="llm-local-negative-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, negativePrompt: event.target.value } }))} placeholder="Optional negative prompt for this local video step." value={selectedNode.config?.negativePrompt || ''} /></div>
                          <p className="text-xs leading-5 text-slate-400">Wan local video is intentionally limited to 832x480 or 1280x720 in this first slice. Use the Graph Workflow step for ComfyUI video workflows or other layouts.</p>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-width">Width</label><input className="store-input mt-3" id="llm-local-width" min="256" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, width: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.width || 832} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-height">Height</label><input className="store-input mt-3" id="llm-local-height" min="256" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, height: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.height || 832} /></div></div>
                          <div className="grid gap-3 sm:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-steps">Steps</label><input className="store-input mt-3" id="llm-local-steps" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, steps: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.steps || 24} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-cfg">CFG scale</label><input className="store-input mt-3" id="llm-local-cfg" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, cfgScale: Number(event.target.value || 0) || 0 } }))} step="0.5" type="number" value={selectedNode.config?.cfgScale || 7} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-seed">Seed</label><input className="store-input mt-3" id="llm-local-seed" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, seed: Number(event.target.value || -1) } }))} type="number" value={selectedNode.config?.seed ?? -1} /></div></div>
                          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-local-negative-prompt">Negative prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="llm-local-negative-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, negativePrompt: event.target.value } }))} placeholder="Optional negative prompt for this local image step." value={selectedNode.config?.negativePrompt || ''} /></div>
                        </div>
                      )
                    ) : selectedNode.config?.executionMode !== 'ollama' && getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE ? (
                      <div className="space-y-3">
                        <div>
                          <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-audio-voice">Voice</label>
                          <input
                            className="store-input mt-3"
                            id="llm-audio-voice"
                            onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, audioVoice: event.target.value } }))}
                            placeholder={getCloudAudioVoicePlaceholder(selectedNode.config?.providerId)}
                            value={selectedNode.config?.audioVoice || ''}
                          />
                        </div>
                        <p className="text-xs leading-5 text-slate-400">{getCloudAudioVoiceHelp(selectedNode.config?.providerId)}</p>
                      </div>
                    ) : selectedNode.config?.executionMode !== 'ollama' && getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE ? (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-image-size">Image size</label><select className="store-input mt-3" id="llm-image-size" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, imageSize: event.target.value } }))} value={selectedNode.config?.imageSize || '1024x1024'}><option value="1024x1024">1024 x 1024</option><option value="1536x1024">1536 x 1024</option><option value="1024x1536">1024 x 1536</option><option value="auto">Auto</option></select></div>
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-image-quality">Quality</label><select className="store-input mt-3" id="llm-image-quality" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, imageQuality: event.target.value } }))} value={selectedNode.config?.imageQuality || 'auto'}><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-image-background">Background</label><select className="store-input mt-3" id="llm-image-background" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, imageBackground: event.target.value } }))} value={selectedNode.config?.imageBackground || 'auto'}><option value="auto">Auto</option><option value="opaque">Opaque</option><option value="transparent">Transparent</option></select></div>
                      </div>
                    ) : selectedNode.config?.executionMode !== 'ollama' && getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE ? (
                      <div className="space-y-3">
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-video-size">Video size</label><select className="store-input mt-3" id="llm-video-size" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, videoSize: event.target.value } }))} value={selectedNode.config?.videoSize || '1280x720'}><option value="1280x720">1280 x 720 (landscape)</option><option value="720x1280">720 x 1280 (portrait)</option></select></div>
                        <p className="text-xs leading-5 text-slate-400">Local AI Hub currently requests an 8 second Sora clip and saves the finished video locally. If you connect an image here, make sure it matches the selected video size.</p>
                      </div>
                    ) : null}
                    {getSelectedModelStepOperationId(selectedNode) === PIPELINE_OPERATION_IDS.LLM_PROMPT ? <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-system-prompt">System prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="llm-system-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, systemPrompt: event.target.value } }))} placeholder="Optional persistent instruction for this step." value={selectedNode.config?.systemPrompt || ''} /></div> : null}
                  </div>
                ) : null}
                {selectedNode.type === 'whisperTranscribe' ? (
                  <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="whisper-model">Transcription model</label><select className="store-input mt-3" id="whisper-model" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, model: event.target.value } }))} value={selectedNode.config?.model || 'base'}>{WHISPER_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></div>
                ) : null}

                {selectedNode.type === 'imageAnalyze' ? (
                  <div className="space-y-4">
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-analyze-tool">Execution tool</label><select className="store-input mt-3" id="image-analyze-tool" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId: event.target.value } }))} value={selectedNode.config?.toolId || ''}><option value="">Auto-detect running tool</option>{imageTools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></div>
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-analyze-mode">Analysis mode</label><select className="store-input mt-3" id="image-analyze-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, analysisMode: event.target.value } }))} value={selectedNode.config?.analysisMode || 'clip'}><option value="clip">CLIP caption</option><option value="deepdanbooru">DeepDanbooru tags</option></select></div>
                  </div>
                ) : null}

                {selectedNode.type === 'imageGenerate' ? (
                  <div className="space-y-4">
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-generate-tool">Execution tool</label><select className="store-input mt-3" id="image-generate-tool" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId: event.target.value } }))} value={selectedNode.config?.toolId || ''}><option value="">Auto-detect running tool</option>{imageTools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></div>
                    <div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-width">Width</label><input className="store-input mt-3" id="image-width" min="256" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, width: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.width || 832} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-height">Height</label><input className="store-input mt-3" id="image-height" min="256" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, height: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.height || 832} /></div></div>
                    <div className="grid gap-3 sm:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-steps">Steps</label><input className="store-input mt-3" id="image-steps" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, steps: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.steps || 24} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-cfg">CFG scale</label><input className="store-input mt-3" id="image-cfg" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, cfgScale: Number(event.target.value || 0) || 0 } }))} step="0.5" type="number" value={selectedNode.config?.cfgScale || 7} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-seed">Seed</label><input className="store-input mt-3" id="image-seed" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, seed: Number(event.target.value || -1) } }))} type="number" value={selectedNode.config?.seed ?? -1} /></div></div>
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="negative-prompt">Negative prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="negative-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, negativePrompt: event.target.value } }))} placeholder="Optional negative prompt for the image step." value={selectedNode.config?.negativePrompt || ''} /></div>
                  </div>
                ) : null}

                {selectedNode.type === 'graphWorkflow' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-workflow-tool">Execution tool</label>
                      <select
                        className="store-input mt-3"
                        id="graph-workflow-tool"
                        onChange={(event) => {
                          const nextToolId = event.target.value;
                          const nextBindings = getDefaultGraphWorkflowBindings(nextToolId);
                          updateNode(selectedNode.id, (currentNode) => ({
                            ...currentNode,
                            config: {
                              ...currentNode.config,
                              inputBindings: nextBindings.inputBindings,
                              outputBindings: nextBindings.outputBindings,
                              toolId: nextToolId,
                              workflowFormat: nextBindings.workflowFormat,
                              workflowText: '',
                            },
                          }));
                        }}
                        value={selectedNode.config?.toolId || graphWorkflowTools[0]?.id || ''}
                      >
                        <option value="">Choose a graph workflow tool</option>
                        {graphWorkflowTools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}
                      </select>
                      <p className="mt-2 text-xs leading-5 text-slate-400">Use this step for graph-native local tools instead of flattening them into the model-step abstraction. Each tool keeps its own workflow contract and honest limitations.</p>
                    </div>
                    <div className="grid gap-4 xl:grid-cols-2">
                      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-300">
                        <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Graph Contract</p>
                        <p className="mt-3 text-base font-semibold text-white">{selectedGraphWorkflowTool?.name || 'Graph workflow tool'}</p>
                        <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">{formatGraphWorkflowAdapterLabel(selectedGraphWorkflowToolContract)}</p>
                        <p className="mt-3 text-sm leading-6 text-slate-300">{selectedGraphWorkflowToolContract?.notes}</p>
                      </div>
                      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-300">
                        <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Workflow Format</p>
                        <p className="mt-3 text-base font-semibold text-white">{selectedGraphWorkflowToolContract?.workflowFormat?.label || 'Workflow definition'}</p>
                        <p className="mt-3 text-sm leading-6 text-slate-300">{selectedGraphWorkflowToolContract?.workflowFormat?.summary}</p>
                      </div>
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      The main pipeline stays on this canvas. This node marks a clear boundary between the main pipeline and the graph-native sub-workflow that runs inside {selectedGraphWorkflowTool?.name || 'the selected tool'}. Local AI Hub still runs the overall pipeline sequentially and saves explicit typed outputs back into the run folder.
                    </div>
                    <div className="grid gap-3 md:grid-cols-3">
                      {(selectedGraphWorkflowToolContract?.inputPorts || []).map((entry) => (
                        <div className="rounded-[24px] border border-white/10 bg-slate-950/35 px-4 py-4" key={entry.portId}>
                          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Input Boundary</p>
                          <p className="mt-2 text-sm font-semibold text-white">{entry.label}</p>
                          <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">{entry.bindingMode}</p>
                          <p className="mt-3 text-xs leading-5 text-slate-400">{entry.description}</p>
                        </div>
                      ))}
                      {(selectedGraphWorkflowToolContract?.outputPorts || []).map((entry) => (
                        <div className="rounded-[24px] border border-white/10 bg-slate-950/35 px-4 py-4" key={entry.portId}>
                          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Output Boundary</p>
                          <p className="mt-2 text-sm font-semibold text-white">{entry.label}</p>
                          <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">{entry.bindingMode}</p>
                          <p className="mt-3 text-xs leading-5 text-slate-400">{entry.description}</p>
                        </div>
                      ))}
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-workflow-json">Workflow definition</label>
                      <textarea
                        className="store-input mt-3 min-h-[220px] resize-none font-mono text-xs leading-6"
                        id="graph-workflow-json"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            workflowText: event.target.value,
                          },
                        }))}
                        placeholder={selectedGraphWorkflowToolContract?.workflowFormat?.placeholder || 'Paste the workflow definition here.'}
                        value={selectedNode.config?.workflowText || ''}
                      />
                      {selectedGraphWorkflowDefinition ? (
                        <p className={'mt-2 text-xs leading-5 ' + (selectedGraphWorkflowDefinition.ok ? 'text-emerald-200' : 'text-amber-200')}>
                          {selectedGraphWorkflowDefinition.message}
                        </p>
                      ) : null}
                      {selectedGraphWorkflowToolContract?.limitations ? <p className="mt-2 text-xs leading-5 text-slate-400">{selectedGraphWorkflowToolContract.limitations}</p> : null}
                    </div>
                    {selectedGraphWorkflowToolContract?.workflowImportSupported ? (
                      <>
                        <div className="grid gap-4 xl:grid-cols-2">
                          <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Pipeline Text to Graph Boundary</p>
                            <div className="mt-3 space-y-3">
                              <div>
                                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-text-node">Workflow node</label>
                                {selectedGraphWorkflowDefinition?.ok ? (
                                  <select
                                    className="store-input mt-3"
                                    id="graph-text-node"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { field: '', nodeId: event.target.value })}
                                    value={graphWorkflowTextBinding?.nodeId || ''}
                                  >
                                    <option value="">Leave text input unused</option>
                                    {graphWorkflowNodeOptions.map((entry) => <option key={entry.id} value={entry.id}>{formatGraphWorkflowNodeLabel(entry)}</option>)}
                                  </select>
                                ) : (
                                  <input
                                    className="store-input mt-3"
                                    id="graph-text-node"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { nodeId: event.target.value })}
                                    placeholder="For example: 6"
                                    value={graphWorkflowTextBinding?.nodeId || ''}
                                  />
                                )}
                              </div>
                              <div>
                                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-text-field">Workflow field</label>
                                {graphWorkflowTextFieldOptions.length ? (
                                  <select
                                    className="store-input mt-3"
                                    id="graph-text-field"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { field: event.target.value })}
                                    value={graphWorkflowTextBinding?.field || ''}
                                  >
                                    <option value="">Choose a workflow field</option>
                                    {graphWorkflowTextFieldOptions.map((field) => <option key={field} value={field}>{field}</option>)}
                                  </select>
                                ) : (
                                  <input
                                    className="store-input mt-3"
                                    id="graph-text-field"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'text', { field: event.target.value })}
                                    placeholder="For example: text"
                                    value={graphWorkflowTextBinding?.field || ''}
                                  />
                                )}
                              </div>
                            </div>
                            <p className="mt-3 text-xs leading-5 text-slate-400">Leave this mapping blank when the imported graph does not consume the main pipeline Text port.</p>
                          </div>
                          <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Pipeline Image to Graph Boundary</p>
                            <div className="mt-3 space-y-3">
                              <div>
                                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-image-node">Workflow node</label>
                                {selectedGraphWorkflowDefinition?.ok ? (
                                  <select
                                    className="store-input mt-3"
                                    id="graph-image-node"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'image', { field: '', nodeId: event.target.value })}
                                    value={graphWorkflowImageBinding?.nodeId || ''}
                                  >
                                    <option value="">Leave image input unused</option>
                                    {graphWorkflowNodeOptions.map((entry) => <option key={entry.id} value={entry.id}>{formatGraphWorkflowNodeLabel(entry)}</option>)}
                                  </select>
                                ) : (
                                  <input
                                    className="store-input mt-3"
                                    id="graph-image-node"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'image', { nodeId: event.target.value })}
                                    placeholder="For example: 12"
                                    value={graphWorkflowImageBinding?.nodeId || ''}
                                  />
                                )}
                              </div>
                              <div>
                                <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="graph-image-field">Workflow field</label>
                                {graphWorkflowImageFieldOptions.length ? (
                                  <select
                                    className="store-input mt-3"
                                    id="graph-image-field"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'image', { field: event.target.value })}
                                    value={graphWorkflowImageBinding?.field || ''}
                                  >
                                    <option value="">Choose a workflow field</option>
                                    {graphWorkflowImageFieldOptions.map((field) => <option key={field} value={field}>{field}</option>)}
                                  </select>
                                ) : (
                                  <input
                                    className="store-input mt-3"
                                    id="graph-image-field"
                                    onChange={(event) => updateGraphWorkflowInputBinding(selectedNode.id, 'image', { field: event.target.value })}
                                    placeholder="For example: image"
                                    value={graphWorkflowImageBinding?.field || ''}
                                  />
                                )}
                              </div>
                            </div>
                            <p className="mt-3 text-xs leading-5 text-slate-400">When this port is connected, Local AI Hub uploads the incoming image to the selected graph tool before the workflow runs.</p>
                          </div>
                        </div>
                        <div className="grid gap-4 xl:grid-cols-2">
                          {(selectedGraphWorkflowToolContract?.outputPorts || []).map((outputPort) => {
                            const outputBinding = outputPort.portId === 'video' ? graphWorkflowVideoOutputBinding : graphWorkflowImageOutputBinding;
                            const outputNodeOptions = outputPort.portId === 'video' ? graphWorkflowVideoOutputNodeOptions : graphWorkflowImageOutputNodeOptions;
                            const outputHint = outputPort.portId === 'video' ? 'video artifact' : 'image artifact';
                            const outputOptionSuffix = outputPort.portId === 'video' ? ' (likely video output)' : ' (likely image output)';
                            return (
                              <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4" key={outputPort.portId}>
                                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Graph Output Boundary to Main Pipeline</p>
                                <div className="mt-3">
                                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`graph-output-node-${outputPort.portId}`}>{outputPort.label}</label>
                                  {selectedGraphWorkflowDefinition?.ok ? (
                                    <select
                                      className="store-input mt-3"
                                      id={`graph-output-node-${outputPort.portId}`}
                                      onChange={(event) => updateGraphWorkflowOutputBinding(selectedNode.id, outputPort.portId, { nodeId: event.target.value })}
                                      value={outputBinding?.nodeId || ''}
                                    >
                                      <option value="">Choose the {outputPort.portId} output node</option>
                                      {(outputNodeOptions.length ? outputNodeOptions : graphWorkflowNodeOptions).map((entry) => <option key={`${outputPort.portId}-${entry.id}`} value={entry.id}>{formatGraphWorkflowNodeLabel(entry)}{outputPort.portId === 'video' ? (entry.videoOutputCandidate ? outputOptionSuffix : '') : (entry.imageOutputCandidate ? outputOptionSuffix : '')}</option>)}
                                    </select>
                                  ) : (
                                    <input
                                      className="store-input mt-3"
                                      id={`graph-output-node-${outputPort.portId}`}
                                      onChange={(event) => updateGraphWorkflowOutputBinding(selectedNode.id, outputPort.portId, { nodeId: event.target.value })}
                                      placeholder="For example: 19"
                                      value={outputBinding?.nodeId || ''}
                                    />
                                  )}
                                </div>
                                <p className="mt-3 text-xs leading-5 text-slate-400">Choose the node that emits the {outputHint} back into the main pipeline. Local AI Hub keeps that artifact explicit and typed after the graph step finishes.</p>
                              </div>
                            );
                          })}
                        </div>
                        {selectedGraphWorkflowDefinition?.ok ? (
                          <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Parsed Workflow Nodes</p>
                            <div className="mt-3 space-y-2 max-h-[260px] overflow-auto pr-1">
                              {graphWorkflowNodeOptions.slice(0, 18).map((entry) => (
                                <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3" key={entry.id}>
                                  <p className="text-sm font-medium text-white">{formatGraphWorkflowNodeLabel(entry)}</p>
                                  <p className="mt-1 text-xs leading-5 text-slate-400">
                                    {entry.inputFields.length ? 'Inputs: ' + entry.inputFields.join(', ') : 'No editable inputs detected.'}
                                  </p>
                                  {entry.boundaryFieldOptions?.text?.length ? <p className="mt-1 text-xs leading-5 text-cyan-100/90">Text-friendly fields: {entry.boundaryFieldOptions.text.slice(0, 4).join(', ')}</p> : null}
                                  {entry.boundaryFieldOptions?.image?.length ? <p className="mt-1 text-xs leading-5 text-sky-100/90">Image-friendly fields: {entry.boundaryFieldOptions.image.slice(0, 4).join(', ')}</p> : null}
                                  {entry.imageOutputCandidate ? <p className="mt-1 text-xs leading-5 text-emerald-200">Likely image output node</p> : null}
                                  {entry.videoOutputCandidate ? <p className="mt-1 text-xs leading-5 text-fuchsia-200">Likely video output node</p> : null}
                                </div>
                              ))}
                            </div>
                            {graphWorkflowNodeOptions.length > 18 ? <p className="mt-3 text-xs leading-5 text-slate-500">Showing the first 18 parsed nodes from the imported workflow.</p> : null}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div className="rounded-[24px] border border-amber-300/20 bg-amber-300/10 px-4 py-4 text-sm leading-6 text-amber-100">
                        {selectedGraphWorkflowToolContract?.executionBlockedMessage}
                      </div>
                    )}
                  </div>
                ) : null}
                {selectedNode.type === 'validation' ? (
                  <div className="space-y-4">
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="validation-mode">Validation mode</label><select className="store-input mt-3" id="validation-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, mode: event.target.value } }))} value={selectedNode.config?.mode || 'user'}><option value="user">User approval</option><option value="llm">LLM validator</option></select></div>
                    {selectedNode.config?.mode === 'llm' ? (
                      <>
                        <ModelTargetFields connectedProviders={connectedProviders} executionModeKey="llmExecutionMode" modelOptions={modelOptionsByNodeId[selectedNode.id]} modelsBusy={modelsBusyNodeId === selectedNode.id} node={selectedNode} onRefreshModels={refreshNodeModels} onUpdateNode={updateNode} providerIdKey="providerId" />
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="validation-ruleset">Ruleset / rubric</label><textarea className="store-input mt-3 min-h-[140px] resize-none" id="validation-ruleset" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, ruleset: event.target.value } }))} placeholder="Describe what should count as pass versus fail." value={selectedNode.config?.ruleset || ''} /></div>
                        <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="validation-system-prompt">System prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="validation-system-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, systemPrompt: event.target.value } }))} placeholder="Optional validator instruction." value={selectedNode.config?.systemPrompt || ''} /></div>
                      </>
                    ) : (
                      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">This run will pause at the validation node, show the connected artifact preview when possible, and wait for your pass or fail decision.</div>
                    )}
                  </div>
                ) : null}

                {selectedNode.type === 'retryLoop' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="retry-loop-target">Retry from</label>
                      <select
                        className="store-input mt-3"
                        id="retry-loop-target"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            retryTargetNodeId: event.target.value,
                          },
                        }))}
                        value={selectedNode.config?.retryTargetNodeId || ''}
                      >
                        <option value="">Choose an earlier step</option>
                        {retryLoopTargetOptions.map((node) => (
                          <option key={node.id} value={node.id}>{node.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="retry-loop-max">Max attempts</label>
                      <input
                        className="store-input mt-3"
                        id="retry-loop-max"
                        max={PIPELINE_RETRY_LOOP_MAX_ATTEMPTS}
                        min="2"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            maxAttempts: Number(event.target.value || 0) || 0,
                          },
                        }))}
                        type="number"
                        value={selectedNode.config?.maxAttempts || 3}
                      />
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="retry-loop-repeat">Early stop rule</label>
                      <select
                        className="store-input mt-3"
                        id="retry-loop-repeat"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            stopWhenRetryArtifactRepeats: event.target.value === 'repeat',
                          },
                        }))}
                        value={selectedNode.config?.stopWhenRetryArtifactRepeats ? 'repeat' : 'limit-only'}
                      >
                        <option value="limit-only">Only stop on Complete or the attempt limit</option>
                        <option value="repeat">Also stop if the Retry artifact repeats</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="retry-loop-stop-action">When Retry is still active</label>
                      <select
                        className="store-input mt-3"
                        id="retry-loop-stop-action"
                        onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            retryTerminationAction: event.target.value === 'complete' ? 'complete' : 'fail',
                          },
                        }))}
                        value={selectedNode.config?.retryTerminationAction === 'complete' ? 'complete' : 'fail'}
                      >
                        <option value="fail">Stop the run with an error</option>
                        <option value="complete">Exit the loop and keep the Retry artifact</option>
                      </select>
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      Connect the Complete input to the branch that should exit the loop and the Retry input to the branch that should trigger another attempt. {selectedRetryLoopMeta?.retryEntryMode === 'branchMerge'
                        ? 'Later attempts feed the retry artifact back through the target Branch Merge automatically.'
                        : selectedRetryLoopMeta?.retryEntryMode === 'inputPort'
                          ? 'Later attempts feed the retry artifact back into ' + selectedRetryLoopMeta.retryTargetLabel + ' through ' + (selectedRetryLoopMeta.retryEntryPortLabel || 'its selected input') + '.'
                          : selectedRetryLoopMeta?.retryEntryLimitation || 'Later attempts rerun the selected earlier step using its connected inputs when there is not one clear retry re-entry port.'} {selectedNode.config?.stopWhenRetryArtifactRepeats
                        ? 'Local AI Hub also stops early if the Retry branch produces the same artifact twice in a row.'
                        : 'By default, Local AI Hub keeps retrying until the Complete branch wins or the attempt limit is reached.'} {selectedNode.config?.retryTerminationAction === 'complete'
                        ? 'When a stop rule triggers while Retry is still active, the loop exits and keeps the latest Retry artifact.'
                        : 'When a stop rule triggers while Retry is still active, the run stops with a plain-English error.'}
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'branchMerge' ? (
                  <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                    Connect compatible branches here. Local AI Hub waits for earlier branches to finish or skip, then forwards the single branch that still has an artifact. When this merge is the retry target for a Retry Loop, the first attempt uses the connected branch and later attempts can re-enter with the loop-carried retry artifact. If two unrelated live results arrive together, the run stops with a plain-English error so the merge stays explicit.
                  </div>
                ) : null}

                {selectedNode.type.endsWith('Output') ? (
                  <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="output-title">Output title</label><input className="store-input mt-3" id="output-title" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, title: event.target.value } }))} value={selectedNode.config?.title || ''} /></div>
                ) : null}

                <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Connections</p>
                  <div className="mt-3 space-y-3">
                    {draft.edges.filter((edge) => edge.source.nodeId === selectedNode.id || edge.target.nodeId === selectedNode.id).length ? draft.edges.filter((edge) => edge.source.nodeId === selectedNode.id || edge.target.nodeId === selectedNode.id).map((edge) => {
                      const sourceNode = draft.nodes.find((node) => node.id === edge.source.nodeId);
                      const targetNode = draft.nodes.find((node) => node.id === edge.target.nodeId);
                      const sourcePort = getPortDefinition(sourceNode?.type, 'output', edge.source.portId);
                      const targetPort = getPortDefinition(targetNode?.type, 'input', edge.target.portId);
                      return (
                        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3" key={edge.id}>
                          <p className="text-sm font-medium text-white">{sourceNode?.label || 'Unknown'}: <span className="text-slate-400">{sourcePort?.label || edge.source.portId}</span></p>
                          <p className="mt-1 text-sm text-slate-300">to {targetNode?.label || 'Unknown'}: <span className="text-slate-400">{targetPort?.label || edge.target.portId}</span></p>
                          <button className="ghost-button mt-3 px-3 py-1.5 text-xs" onClick={() => removeEdge(edge.id)} type="button">Remove connection</button>
                        </div>
                      );
                    }) : <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-3 py-4 text-sm leading-6 text-slate-400">This node has no connections yet.</div>}
                  </div>
                </div>

                <button className="ghost-button w-full justify-center" onClick={() => removeNode(selectedNode.id)} type="button">Delete node</button>
                </div>
              </PipelineInspectorErrorBoundary>
            ) : <div className="mt-4 rounded-[24px] border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">Select a node on the canvas to edit its settings and inspect its connections.</div>}
          </div>

          <div className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Canvas</p>
                <p className="mt-2 text-lg font-semibold text-white">Drag nodes and connect typed ports</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">Click an output port, then an input port. Click a connection line to disconnect it.</span>
                {selectedEdge ? <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => removeEdge(selectedEdge.id)} type="button">Disconnect selected link</button> : null}
                {pendingConnection ? <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setPendingConnection(null)} type="button">Cancel connection</button> : null}
              </div>
            </div>

            <div className="mt-4 rounded-[28px] border border-white/10 bg-slate-950/30 p-2">
              <div className="relative h-[860px] overflow-auto rounded-[24px] border border-dashed border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(67,171,255,0.08),transparent_24%),linear-gradient(180deg,rgba(7,15,26,0.96),rgba(5,10,18,0.96))]" ref={canvasRef}>
                <div className="relative" style={{ height: `${canvasSize.height}px`, width: `${canvasSize.width}px` }}>
                  <svg className="absolute inset-0 h-full w-full">
                    {graphEdges.map((edge) => {
                      const sourceNode = graph.nodeMap.get(edge.source.nodeId);
                      const targetNode = graph.nodeMap.get(edge.target.nodeId);
                      const sourceDefinition = getPipelineNodeDefinition(sourceNode?.type);
                      const targetDefinition = getPipelineNodeDefinition(targetNode?.type);
                      const sourceIndex = (sourceDefinition?.outputPorts || []).findIndex((port) => port.id === edge.source.portId);
                      const targetIndex = (targetDefinition?.inputPorts || []).findIndex((port) => port.id === edge.target.portId);
                      const sourcePoint = getNodePortCenter(sourceNode, 'output', sourceIndex);
                      const targetPoint = getNodePortCenter(targetNode, 'input', targetIndex);
                      const curveOffset = Math.max(80, (targetPoint.x - sourcePoint.x) / 2);
                      const pathValue = `M ${sourcePoint.x} ${sourcePoint.y} C ${sourcePoint.x + curveOffset} ${sourcePoint.y}, ${targetPoint.x - curveOffset} ${targetPoint.y}, ${targetPoint.x} ${targetPoint.y}`;
                      const selected = selectedEdge?.id === edge.id;
                      return (
                        <g key={edge.id}>
                          <path
                            d={pathValue}
                            fill="none"
                            onClick={(event) => {
                              event.stopPropagation();
                              setPendingConnection(null);
                              setSelectedEdgeId(edge.id);
                              setSelectedNodeId('');
                            }}
                            pointerEvents="stroke"
                            stroke="transparent"
                            strokeWidth="16"
                            style={{ cursor: 'pointer' }}
                          />
                          <path
                            d={pathValue}
                            fill="none"
                            pointerEvents="none"
                            stroke={selected ? 'rgba(147, 226, 255, 0.98)' : 'rgba(103, 214, 255, 0.58)'}
                            strokeWidth={selected ? '5' : '3'}
                          />
                        </g>
                      );
                    })}
                  </svg>

                  {draft.nodes.length ? draft.nodes.map((node) => {
                    const definition = getPipelineNodeDefinition(node.type);
                    const inputPorts = definition?.inputPorts || [];
                    const outputPorts = definition?.outputPorts || [];
                    const rowCount = Math.max(inputPorts.length, outputPorts.length, 1);
                    const nodeRunState = runState?.nodeStates?.[node.id];
                    const nodeSummary = analysis.nodeSummaries?.[node.id];
                    const preview = buildNodePreview(node, runState);
                    return (
                      <div
                        className={`absolute rounded-[28px] border bg-[#0f1825]/96 shadow-soft ${selectedNodeId === node.id ? 'border-cyan-300/45' : 'border-white/10'}`}
                        key={node.id}
                        onClick={() => { setSelectedEdgeId(''); setSelectedNodeId(node.id); }}
                        style={{ left: `${node.position.x}px`, minHeight: `${getNodeCardHeight(node)}px`, top: `${node.position.y}px`, width: `${PIPELINE_NODE_WIDTH}px` }}
                      >
                        <div className="flex cursor-grab items-start justify-between gap-3 rounded-t-[28px] border-b border-white/10 px-4 py-4" onMouseDown={(event) => startDrag(node.id, event)} role="presentation">
                          <div>
                            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{definition?.category || 'Node'}</p>
                            <p className="mt-1 text-sm font-semibold text-white">{node.label}</p>
                          </div>
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${runStatusClassName(nodeRunState?.status || 'queued')}`}>
                            {nodeRunState?.status || 'idle'}
                          </span>
                        </div>
                        <div className="px-4 pt-4">
                          {Array.from({ length: rowCount }).map((_, index) => {
                            const inputPort = inputPorts[index] || null;
                            const outputPort = outputPorts[index] || null;
                            const inputConnectionCount = inputPort ? getIncomingConnectionCount(graph, node.id, inputPort.id) : 0;
                            const allowsMultipleInputConnections = Boolean(inputPort?.allowMultipleConnections);
                            return (
                              <div className="grid h-9 grid-cols-2 items-center gap-4" key={`${node.id}-row-${index}`}>
                                <div className="flex items-center gap-2">
                                  {inputPort ? (
                                    <button
                                      className={`flex items-center gap-2 rounded-full border px-2 py-1 text-left text-[11px] uppercase tracking-[0.16em] transition ${pendingConnection && isPendingConnectionCompatible(node, inputPort) ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-400 hover:border-cyan-300/25 hover:bg-white/10'}`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        if (!pendingConnection) {
                                          setSelectedEdgeId('');
                                          setSelectedNodeId(node.id);
                                          return;
                                        }
                                        connectPorts(pendingConnection.sourceNodeId, pendingConnection.sourcePortId, node.id, inputPort.id);
                                      }}
                                      type="button"
                                    >
                                      <span className="h-2.5 w-2.5 rounded-full bg-white/70" />
                                      <span className="truncate">{inputPort.label}</span>
                                      {allowsMultipleInputConnections ? <span className="rounded-full border border-white/10 bg-slate-950/50 px-2 py-0.5 text-[10px] text-slate-200">{inputConnectionCount}</span> : null}
                                    </button>
                                  ) : null}
                                </div>
                                <div className="flex items-center justify-end gap-2">
                                  {outputPort ? (
                                    <button
                                      className={`flex items-center gap-2 rounded-full border px-2 py-1 text-right text-[11px] uppercase tracking-[0.16em] transition ${pendingConnection?.sourceNodeId === node.id && pendingConnection?.sourcePortId === outputPort.id ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-400 hover:border-cyan-300/25 hover:bg-white/10'}`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setSelectedEdgeId('');
                                        setPendingConnection({
                                          isDynamic: outputPort.kind === 'passthrough' || outputPort.kind === 'any',
                                          kind: outputPort.kind,
                                          sourceNodeId: node.id,
                                          sourcePortId: outputPort.id,
                                        });
                                      }}
                                      type="button"
                                    >
                                      <span className="truncate">{outputPort.label}</span>
                                      <span className="h-2.5 w-2.5 rounded-full bg-cyan-300" />
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-3 border-t border-white/10 px-4 py-3">
                          <div className={`rounded-2xl border px-3 py-2 text-xs ${toneToClassName(nodeSummary?.readiness?.tone || nodeSummary?.compatibility?.tone || 'neutral')}`}>
                            <p className="font-semibold text-white">{nodeSummary?.readiness?.message || nodeSummary?.compatibility?.message || 'Ready.'}</p>
                            {nodeSummary?.capabilitySummary ? <p className="mt-1 leading-5 text-slate-300">{nodeSummary.capabilitySummary.message}</p> : null}
                            {preview ? <p className="mt-1 leading-5 text-slate-200">{preview}</p> : null}
                          </div>
                        </div>
                      </div>
                    );
                  }) : (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-7 text-slate-400">Add a few nodes from the palette to start building a pipeline.</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="panel p-5">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Run status</p>
            <p className="mt-2 text-lg font-semibold text-white">Sequential execution timeline</p>
            <div className="mt-4">
              <PipelineTimeline
                draft={draft}
                onChangeValidationComment={setValidationComment}
                onDecideValidation={handleValidationDecision}
                onOpenPath={openPath}
                onRevealPath={(pathValue) => openPath(pathValue, true)}
                runState={runState}
                validationBusy={validationBusy}
                validationComment={validationComment}
              />
            </div>
          </div>
      </div>
    </section>
  );
}



































