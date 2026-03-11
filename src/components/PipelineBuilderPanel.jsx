import { useEffect, useMemo, useRef, useState } from 'react';
import pipelineShared from '../../electron/shared/pipelineSchema.cjs';
import {
  IMAGE_WORKFLOW_TOOL_IDS,
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

const { buildPipelineGraph, createEdge, createEmptyPipeline, getPortDefinition } = pipelineShared;
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
    const modeLabel = node.config?.executionMode === 'ollama' ? 'Ollama' : (node.config?.providerId || 'Cloud provider');
    return `${modeLabel}${node.config?.model ? ` | ${node.config.model}` : ''}`;
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

  if (node.type === 'validation') {
    return node.config?.mode === 'llm'
      ? `${node.config?.llmExecutionMode === 'ollama' ? 'Ollama' : node.config?.providerId || 'Cloud validator'}${node.config?.model ? ` | ${node.config.model}` : ''}`
      : 'Pauses for a pass or fail decision';
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

function ArtifactPreview({ artifact, className = '', compact = false }) {
  if (!artifact) {
    return <div className={`rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-400 ${className}`}>Nothing to preview yet.</div>;
  }

  if (artifact.kind === 'text') {
    return (
      <textarea
        className={`store-input resize-none ${className}`}
        readOnly
        style={{ minHeight: compact ? '120px' : '180px' }}
        value={artifact.text || ''}
      />
    );
  }

  if (artifact.kind === 'image' && artifact.fileUrl) {
    return (
      <div className={`space-y-3 ${className}`}>
        <img alt={artifact.displayName || 'Pipeline image output'} className="max-h-[280px] w-full rounded-[24px] border border-white/10 bg-slate-950/40 object-contain" src={artifact.fileUrl} />
        {artifact.summary ? <p className="text-xs leading-5 text-slate-400">{artifact.summary}</p> : null}
      </div>
    );
  }

  if (artifact.kind === 'audio' && artifact.fileUrl) {
    return (
      <div className={`space-y-3 ${className}`}>
        <audio className="w-full" controls src={artifact.fileUrl} />
        <p className="text-xs leading-5 text-slate-400">{artifact.summary || artifact.fileName || artifact.displayName}</p>
      </div>
    );
  }

  if (artifact.kind === 'video' && artifact.fileUrl) {
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
          <p className="mt-2 text-sm font-semibold text-white">{result.kind || 'output'}</p>
        </div>
        {result.destinationPath ? <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">Saved</span> : null}
      </div>
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
  const artifactPath = artifact?.filePath || '';
  return (
    <div className="rounded-[26px] border border-violet-400/30 bg-violet-400/10 p-4 text-violet-50">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-violet-100/80">Awaiting validation</p>
          <p className="mt-2 text-lg font-semibold text-white">{pendingValidation.nodeLabel}</p>
        </div>
        <span className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/85">
          Paused
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-violet-50/90">Review the received content, then choose pass or fail to continue this run.</p>
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
        {activeNodeState ? <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">Current step: {activeNodeState.nodeLabel || activeNodeState.nodeId}</p> : null}
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
              return (
                <div key={nodeId} className={`rounded-2xl border px-3 py-3 ${runStatusClassName(nodeState?.status || 'queued')}`}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-white">
                      {index + 1}. {node?.label || nodeState?.nodeLabel || nodeId}
                    </p>
                    <span className="text-[11px] uppercase tracking-[0.18em] text-slate-300">{nodeState?.status || 'queued'}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-100">{nodeState?.message || 'Waiting to run.'}</p>
                  {nodeState?.preview ? <p className="mt-2 text-xs leading-5 text-slate-300">{nodeState.preview}</p> : null}
                  {nodeState?.selectedBranch ? <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-400">Routed to {nodeState.selectedBranch}</p> : null}
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

function ModelTargetFields({ connectedProviders, modelOptions, modelsBusy, node, onRefreshModels, onUpdateNode, executionModeKey, providerIdKey }) {
  const executionMode = node.config?.[executionModeKey] === 'ollama' ? 'ollama' : 'cloud';
  return (
    <>
      <div>
        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-execution-mode`}>
          Execution target
        </label>
        <select
          className="store-input mt-3"
          id={`${node.id}-execution-mode`}
          onChange={(event) =>
            onUpdateNode(node.id, (currentNode) => ({
              ...currentNode,
              config: {
                ...currentNode.config,
                [executionModeKey]: event.target.value,
                [providerIdKey]: event.target.value === 'cloud' ? currentNode.config?.[providerIdKey] || '' : '',
                model: '',
              },
            }))
          }
          value={executionMode}
        >
          <option value="cloud">Cloud provider</option>
          <option value="ollama">Ollama (local)</option>
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
      ) : (
        <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
          Local mode reuses the existing Ollama API path. Start Ollama from Library before running this step.
        </div>
      )}

      <div>
        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor={`${node.id}-model`}>
          Model
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
          placeholder="Enter or pick a model"
          value={node.config?.model || ''}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="ghost-button" disabled={modelsBusy} onClick={() => onRefreshModels(node)} type="button">
            {modelsBusy ? 'Refreshing...' : 'Refresh models'}
          </button>
          <span className="text-xs text-slate-500">
            {executionMode === 'ollama' ? 'Loads local Ollama models.' : 'Loads models from the selected cloud provider.'}
          </span>
        </div>
        {modelOptions?.length ? (
          <div className="mt-3 grid gap-2">
            {modelOptions.slice(0, 8).map((model) => (
              <button
                className={`rounded-2xl border px-3 py-3 text-left text-sm transition ${node.config?.model === model.id ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-50' : 'border-white/10 bg-white/5 text-slate-300 hover:border-cyan-300/20 hover:bg-white/10'}`}
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
                <div className="font-medium text-white">{model.label || model.id}</div>
                {model.detail ? <div className="mt-1 text-xs text-slate-400">{model.detail}</div> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
export default function PipelineBuilderPanel({ hardware, manifests, onToast, providers, tools }) {
  const [pipelines, setPipelines] = useState([]);
  const [draft, setDraft] = useState(() => createEmptyPipeline());
  const [selectedNodeId, setSelectedNodeId] = useState('');
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

  const contextMaps = useMemo(
    () => buildPipelineDisplayContext({ hardware, manifests, providers, tools }),
    [hardware, manifests, providers, tools],
  );
  const analysis = useMemo(() => analyzePipelineDraft(draft, contextMaps), [draft, contextMaps]);
  const graph = useMemo(() => buildPipelineGraph(draft), [draft]);
  const selectedNode = useMemo(() => draft.nodes.find((node) => node.id === selectedNodeId) || null, [draft.nodes, selectedNodeId]);
  const connectedProviders = useMemo(() => (providers || []).filter((provider) => provider.isConnected), [providers]);
  const imageTools = useMemo(() => tools.filter((tool) => IMAGE_WORKFLOW_TOOL_IDS.includes(tool.id)), [tools]);
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
        applyRunSnapshot(activeRunResult.data?.run || null);
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
      notifiedRunStateRef.current = notificationKey;
    } else if (runState.status === 'failed' || runState.status === 'cancelled') {
      onToast(runState.message || 'Pipeline run stopped.', 'error');
      notifiedRunStateRef.current = notificationKey;
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
    markDirty();
  }

  function removeEdge(edgeId) {
    setDraft((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edge.id !== edgeId),
    }));
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

    const nextEdges = draft.edges.filter((edge) => !(edge.target.nodeId === targetNodeId && edge.target.portId === targetPortId));
    const nextDraft = {
      ...draft,
      edges: [...nextEdges, createEdge(sourceNodeId, sourcePortId, targetNodeId, targetPortId)],
    };
    const nextGraph = buildPipelineGraph(nextDraft);
    const newErrors = nextGraph.errors.filter((message) => !graph.errors.includes(message));
    if (newErrors.length) {
      const nextMessage = newErrors[0];
      onToast(
        nextMessage.toLowerCase().includes('cycle')
          ? 'That connection would create a loop. Phase 2 still runs in a simple sequential order.'
          : nextMessage,
        'error',
      );
      return;
    }

    replaceDraft(nextDraft, {
      dirty: true,
    });
    setSelectedNodeId(targetNodeId);
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
    const executionMode = node.config?.[modelConfig.executionModeKey] === 'ollama' ? 'ollama' : 'cloud';
    let models = [];
    if (executionMode === 'ollama') {
      const result = await window.localAIHub.listOllamaModels();
      if (!result?.ok) {
        setModelsBusyNodeId('');
        onToast(result?.message || 'Local AI Hub could not load your local Ollama models.', 'error');
        return;
      }

      models = (result.data?.models || []).map((model) => ({
        id: model.name,
        label: model.name,
        detail: model.size ? `${Math.round(Number(model.size) / 1024 / 1024)} MB` : '',
      }));
    } else {
      const providerId = String(node.config?.[modelConfig.providerIdKey] || '').trim();
      if (!providerId) {
        setModelsBusyNodeId('');
        onToast('Choose a connected cloud provider before refreshing models for this step.', 'error');
        return;
      }

      const result = await window.localAIHub.listProviderModels(providerId);
      if (!result?.ok) {
        setModelsBusyNodeId('');
        onToast(result?.message || 'Local AI Hub could not load models for that cloud provider.', 'error');
        return;
      }

      models = result.data?.models || [];
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
        `${analysis.compatibilitySummary.message}\n\nPhase 2 still runs sequentially so only one heavy local step executes at a time. Continue anyway?`,
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
    onToast(result.data?.message || 'Pipeline started.', 'success');
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
    onToast(result.data?.message || 'Local AI Hub will stop the active pipeline after the current step finishes.', 'success');
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
              Phase 2 generalizes the workflow system across text, image, audio, video, and file artifacts while keeping execution strictly sequential so only one heavy local tool runs at a time.
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
      <div className="grid gap-5 xl:grid-cols-[280px,minmax(0,1fr),360px]">
        <aside className="space-y-5">
          <div className="panel p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Saved pipelines</p>
                <p className="mt-2 text-lg font-semibold text-white">Load and reuse</p>
              </div>
              <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => refreshPipelineList()} type="button">Refresh list</button>
            </div>
            <div className="mt-4 space-y-3">
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
            <p className="mt-2 text-lg font-semibold text-white">Inputs, AI, validation, outputs</p>
            <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs leading-6 text-slate-400">
              Add nodes across text, image, audio, video, and file workflows. Connections stay typed, and validation can branch to pass or fail.
            </div>
            <div className="mt-4 space-y-4">
              {paletteGroups.map((group) => (
                <div key={group.label}>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{group.label}</p>
                  <div className="mt-2 space-y-2">
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
        </aside>

        <div className="space-y-5">
          <div className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Canvas</p>
                <p className="mt-2 text-lg font-semibold text-white">Drag nodes and connect typed ports</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">Click an output port, then an input port</span>
                {pendingConnection ? <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setPendingConnection(null)} type="button">Cancel connection</button> : null}
              </div>
            </div>

            <div className="mt-4 rounded-[28px] border border-white/10 bg-slate-950/30 p-3">
              <div className="relative h-[820px] overflow-auto rounded-[24px] border border-dashed border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(67,171,255,0.08),transparent_24%),linear-gradient(180deg,rgba(7,15,26,0.96),rgba(5,10,18,0.96))]" ref={canvasRef}>
                <div className="relative" style={{ height: `${canvasSize.height}px`, width: `${canvasSize.width}px` }}>
                  <svg className="pointer-events-none absolute inset-0 h-full w-full">
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
                      return <path d={pathValue} fill="none" key={edge.id} stroke="rgba(103, 214, 255, 0.58)" strokeWidth="3" />;
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
                        onClick={() => setSelectedNodeId(node.id)}
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
                            return (
                              <div className="grid h-9 grid-cols-2 items-center gap-4" key={`${node.id}-row-${index}`}>
                                <div className="flex items-center gap-2">
                                  {inputPort ? (
                                    <button
                                      className={`flex items-center gap-2 rounded-full border px-2 py-1 text-left text-[11px] uppercase tracking-[0.16em] transition ${pendingConnection && (pendingConnection.isDynamic || pendingConnection.kind === inputPort.kind || inputPort.allowedKinds?.includes(pendingConnection.kind)) ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-400 hover:border-cyan-300/25 hover:bg-white/10'}`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        if (!pendingConnection) {
                                          setSelectedNodeId(node.id);
                                          return;
                                        }
                                        connectPorts(pendingConnection.sourceNodeId, pendingConnection.sourcePortId, node.id, inputPort.id);
                                      }}
                                      type="button"
                                    >
                                      <span className="h-2.5 w-2.5 rounded-full bg-white/70" />
                                      <span className="truncate">{inputPort.label}</span>
                                    </button>
                                  ) : null}
                                </div>
                                <div className="flex items-center justify-end gap-2">
                                  {outputPort ? (
                                    <button
                                      className={`flex items-center gap-2 rounded-full border px-2 py-1 text-right text-[11px] uppercase tracking-[0.16em] transition ${pendingConnection?.sourceNodeId === node.id && pendingConnection?.sourcePortId === outputPort.id ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-400 hover:border-cyan-300/25 hover:bg-white/10'}`}
                                      onClick={(event) => {
                                        event.stopPropagation();
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

        <aside className="space-y-5">
          <div className="panel p-5">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Inspector</p>
            <p className="mt-2 text-lg font-semibold text-white">{selectedNode ? selectedNode.label : 'Select a node'}</p>
            {selectedNode ? (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="node-label">Node label</label>
                  <input className="store-input mt-3" id="node-label" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, label: event.target.value }))} value={selectedNode.label} />
                </div>

                <div className={`rounded-[24px] border p-4 ${toneToClassName(currentNodeSummary?.readiness?.tone || currentNodeSummary?.compatibility?.tone || 'neutral')}`}>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-300">Readiness</p>
                  <p className="mt-2 text-sm leading-6 text-slate-100">{currentNodeSummary?.readiness?.message || 'This node is ready.'}</p>
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
                    <ModelTargetFields connectedProviders={connectedProviders} executionModeKey="executionMode" modelOptions={modelOptionsByNodeId[selectedNode.id]} modelsBusy={modelsBusyNodeId === selectedNode.id} node={selectedNode} onRefreshModels={refreshNodeModels} onUpdateNode={updateNode} providerIdKey="providerId" />
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-instruction">Task / instruction</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="llm-instruction" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, instruction: event.target.value } }))} placeholder="Optional guidance to apply to the incoming text." value={selectedNode.config?.instruction || ''} /></div>
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-system-prompt">System prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="llm-system-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, systemPrompt: event.target.value } }))} placeholder="Optional persistent instruction for this step." value={selectedNode.config?.systemPrompt || ''} /></div>
                  </div>
                ) : null}

                {selectedNode.type === 'whisperTranscribe' ? (
                  <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="whisper-model">Whisper model</label><select className="store-input mt-3" id="whisper-model" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, model: event.target.value } }))} value={selectedNode.config?.model || 'base'}>{WHISPER_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></div>
                ) : null}

                {selectedNode.type === 'imageAnalyze' ? (
                  <div className="space-y-4">
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-analyze-tool">Image tool</label><select className="store-input mt-3" id="image-analyze-tool" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId: event.target.value } }))} value={selectedNode.config?.toolId || ''}><option value="">Auto-detect running tool</option>{imageTools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></div>
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-analyze-mode">Analysis mode</label><select className="store-input mt-3" id="image-analyze-mode" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, analysisMode: event.target.value } }))} value={selectedNode.config?.analysisMode || 'clip'}><option value="clip">CLIP caption</option><option value="deepdanbooru">DeepDanbooru tags</option></select></div>
                  </div>
                ) : null}

                {selectedNode.type === 'imageGenerate' ? (
                  <div className="space-y-4">
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-generate-tool">Image tool</label><select className="store-input mt-3" id="image-generate-tool" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, toolId: event.target.value } }))} value={selectedNode.config?.toolId || ''}><option value="">Auto-detect running tool</option>{imageTools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></div>
                    <div className="grid gap-3 sm:grid-cols-2"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-width">Width</label><input className="store-input mt-3" id="image-width" min="256" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, width: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.width || 832} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-height">Height</label><input className="store-input mt-3" id="image-height" min="256" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, height: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.height || 832} /></div></div>
                    <div className="grid gap-3 sm:grid-cols-3"><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-steps">Steps</label><input className="store-input mt-3" id="image-steps" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, steps: Number(event.target.value || 0) || 0 } }))} type="number" value={selectedNode.config?.steps || 24} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-cfg">CFG scale</label><input className="store-input mt-3" id="image-cfg" min="1" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, cfgScale: Number(event.target.value || 0) || 0 } }))} step="0.5" type="number" value={selectedNode.config?.cfgScale || 7} /></div><div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="image-seed">Seed</label><input className="store-input mt-3" id="image-seed" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, seed: Number(event.target.value || -1) } }))} type="number" value={selectedNode.config?.seed ?? -1} /></div></div>
                    <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="negative-prompt">Negative prompt</label><textarea className="store-input mt-3 min-h-[120px] resize-none" id="negative-prompt" onChange={(event) => updateNode(selectedNode.id, (currentNode) => ({ ...currentNode, config: { ...currentNode.config, negativePrompt: event.target.value } }))} placeholder="Optional negative prompt for the image step." value={selectedNode.config?.negativePrompt || ''} /></div>
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
                      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">This run will pause at the validation node, show the received content, and wait for your pass or fail decision.</div>
                    )}
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
            ) : <div className="mt-4 rounded-[24px] border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">Select a node on the canvas to edit its settings and inspect its connections.</div>}
          </div>
        </aside>
      </div>
    </section>
  );
}




