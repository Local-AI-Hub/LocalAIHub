import { useEffect, useMemo, useRef, useState } from 'react';
import pipelineShared from '../../electron/shared/pipelineSchema.cjs';
import {
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
const CANVAS_MIN_HEIGHT = 760;

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

  if (node.type === 'audioInput') {
    return fileNameFromPath(node.config?.filePath || '') || 'No file selected yet.';
  }

  if (node.type === 'llmPrompt') {
    const modeLabel = node.config?.executionMode === 'ollama' ? 'Ollama' : (node.config?.providerId || 'Cloud provider');
    return `${modeLabel}${node.config?.model ? ` | ${node.config.model}` : ''}`;
  }

  if (node.type === 'whisperTranscribe') {
    return `Model: ${node.config?.model || 'base'}`;
  }

  if (node.type === 'textOutput') {
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

function PipelineTimeline({ draft, runState }) {
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
        <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
          Started {formatDateLabel(runState.startedAt)}{runState.finishedAt ? ` | Finished ${formatDateLabel(runState.finishedAt)}` : ''}
        </p>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.1fr,0.9fr]">
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
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-[26px] border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Output</p>
          <div className="mt-4 space-y-3">
            {runState.terminalResults?.length ? (
              runState.terminalResults.map((result) => (
                <div key={`${result.nodeId}-${result.title}`} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{result.title}</p>
                  <textarea className="store-input mt-3 min-h-[180px] resize-none" readOnly value={result.value || ''} />
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
                Final text output will appear here after the pipeline reaches an output node.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
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
  const [dirty, setDirty] = useState(false);
  const [modelOptionsByNodeId, setModelOptionsByNodeId] = useState({});
  const [modelsBusyNodeId, setModelsBusyNodeId] = useState('');
  const canvasRef = useRef(null);
  const dragRef = useRef(null);

  const contextMaps = useMemo(
    () => buildPipelineDisplayContext({ hardware, manifests, providers, tools }),
    [hardware, manifests, providers, tools],
  );
  const analysis = useMemo(() => analyzePipelineDraft(draft, contextMaps), [draft, contextMaps]);
  const graph = useMemo(() => buildPipelineGraph(draft), [draft]);
  const selectedNode = useMemo(() => draft.nodes.find((node) => node.id === selectedNodeId) || null, [draft.nodes, selectedNodeId]);
  const connectedProviders = useMemo(() => (providers || []).filter((provider) => provider.isConnected), [providers]);
  const currentPipelineSaved = useMemo(() => pipelines.some((pipeline) => pipeline.id === draft.id), [pipelines, draft.id]);
  const currentNodeSummary = selectedNode ? analysis.nodeSummaries?.[selectedNode.id] || null : null;
  const canvasSize = useMemo(() => {
    const width = Math.max(CANVAS_MIN_WIDTH, ...draft.nodes.map((node) => Math.round(node.position.x + PIPELINE_NODE_WIDTH + 180)));
    const height = Math.max(CANVAS_MIN_HEIGHT, ...draft.nodes.map((node) => Math.round(node.position.y + getNodeCardHeight(node) + 180)));
    return { width, height };
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

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.localAIHub.onPipelineRunUpdate((payload) => {
      if (disposed || !payload?.run) {
        return;
      }

      setRunState(payload.run);
      if (payload.run.status !== 'running') {
        setRunBusy(false);
        setCancelBusy(false);
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
        setRunState(activeRunResult.data?.run || null);
        if (activeRunResult.data?.run?.status === 'running') {
          setRunBusy(true);
        }
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
    setRunState((current) => (current?.status === 'running' ? current : null));
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

    const nextEdges = draft.edges.filter(
      (edge) => !(edge.target.nodeId === targetNodeId && edge.target.portId === targetPortId),
    );
    const nextDraft = {
      ...draft,
      edges: [...nextEdges, createEdge(sourceNodeId, sourcePortId, targetNodeId, targetPortId)],
    };
    const nextGraph = buildPipelineGraph(nextDraft);
    if (nextGraph.errors.some((message) => message.toLowerCase().includes('cycle'))) {
      onToast('That connection would create a loop. Phase 1 pipelines must stay sequential.', 'error');
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
    if (!node || node.type !== 'llmPrompt') {
      return;
    }

    setModelsBusyNodeId(node.id);
    let models = [];
    if (node.config?.executionMode === 'ollama') {
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
      const providerId = String(node.config?.providerId || '').trim();
      if (!providerId) {
        setModelsBusyNodeId('');
        onToast('Choose a connected cloud provider before refreshing models for this node.', 'error');
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

  async function handleChooseAudio(nodeId) {
    const result = await window.localAIHub.pickWhisperAudioFile();
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not open the audio picker.', 'error');
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

    if (runState?.status === 'running') {
      onToast('A pipeline is already running. Cancel it or wait for it to finish first.', 'error');
      return;
    }

    if (analysis.compatibilitySummary && ['warn', 'danger'].includes(analysis.compatibilitySummary.tone)) {
      const confirmed = window.confirm(
        `${analysis.compatibilitySummary.message}\n\nPhase 1 runs are sequential and only execute one step at a time. Continue anyway?`,
      );
      if (!confirmed) {
        return;
      }
    }

    setRunBusy(true);
    const result = await window.localAIHub.runPipeline(draft);
    if (!result?.ok) {
      setRunBusy(false);
      onToast(result?.message || 'Local AI Hub could not run that pipeline.', 'error');
      return;
    }

    setRunState(result.data?.run || null);
    onToast(result.data?.message || 'Pipeline finished.', 'success');
    setRunBusy(false);
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

    setRunState(result.data?.run || runState);
    onToast(result.data?.message || 'Local AI Hub will stop the active pipeline after the current step finishes.', 'success');
  }

  const paletteGroups = getNodePaletteGroups();
  const graphEdges = draft.edges.filter(
    (edge) => graph.nodeMap.has(edge.source.nodeId) && graph.nodeMap.has(edge.target.nodeId),
  );

  if (loading) {
    return <section className="panel p-6 text-sm text-slate-300">Loading the Pipeline Builder...</section>;
  }

  return (
    <section className="space-y-5">
      <div className="panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Pipeline Builder</p>
            <h3 className="mt-3 text-3xl font-semibold tracking-tight text-white">Build sequential Local AI Hub workflows</h3>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
              Phase 1 supports a focused vertical slice: text to LLM to text, plus audio to Whisper to text. Runs stay strictly step-by-step so Local AI Hub never tries to execute multiple heavy local steps at the same time.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button className="ghost-button" onClick={createNewPipeline} type="button">
              New pipeline
            </button>
            <button className="ghost-button" disabled={!currentPipelineSaved || deleteBusy} onClick={handleDeletePipeline} type="button">
              {deleteBusy ? 'Deleting...' : 'Delete'}
            </button>
            <button className="primary-button" disabled={saveBusy} onClick={handleSavePipeline} type="button">
              {saveBusy ? 'Saving...' : 'Save pipeline'}
            </button>
            {runState?.status === 'running' ? (
              <button className="ghost-button" disabled={cancelBusy} onClick={handleCancelRun} type="button">
                {cancelBusy ? 'Cancelling...' : 'Cancel run'}
              </button>
            ) : (
              <button className="primary-button" disabled={runBusy} onClick={handleRunPipeline} type="button">
                {runBusy ? 'Running...' : 'Run pipeline'}
              </button>
            )}
          </div>
        </div>

        <div className="mt-6 grid gap-4 xl:grid-cols-[1.1fr,1fr]">
          <div className="rounded-[28px] border border-white/10 bg-slate-950/35 p-4">
            <label className="text-xs uppercase tracking-[0.2em] text-slate-500" htmlFor="pipeline-name">
              Pipeline name
            </label>
            <input
              className="store-input mt-3"
              id="pipeline-name"
              onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({
                  ...current,
                  name: value,
                }));
                markDirty();
              }}
              placeholder="Untitled pipeline"
              value={draft.name}
            />
            <label className="mt-4 block text-xs uppercase tracking-[0.2em] text-slate-500" htmlFor="pipeline-description">
              Description
            </label>
            <textarea
              className="store-input mt-3 min-h-[120px] resize-none"
              id="pipeline-description"
              onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({
                  ...current,
                  description: value,
                }));
                markDirty();
              }}
              placeholder="What should this workflow do?"
              value={draft.description}
            />
          </div>

          <div className={`rounded-[28px] border p-4 ${toneToClassName(analysis.compatibilitySummary?.tone || analysis.primaryIssue?.tone || 'neutral')}`}>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Readiness and suitability</p>
            <p className="mt-3 text-lg font-semibold text-white">
              {analysis.compatibilitySummary?.label || (analysis.executable ? 'Ready to run' : 'Needs attention')}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-100">
              {analysis.primaryIssue?.message || analysis.compatibilitySummary?.message || 'This pipeline is ready to run.'}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-slate-300">
              <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">{analysis.executionOrder.length} queued step{analysis.executionOrder.length === 1 ? '' : 's'}</span>
              <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">{getIssueCountText(analysis.issues.length)}</span>
              <span className="rounded-full border border-white/10 bg-slate-950/35 px-3 py-1">Sequential only</span>
            </div>
            {analysis.issues.length ? (
              <div className="mt-4 space-y-2">
                {analysis.issues.slice(0, 4).map((issue, index) => (
                  <div key={`${issue.message}-${index}`} className={`rounded-2xl border px-3 py-2 text-sm ${toneToClassName(issue.tone)}`}>
                    {issue.message}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[280px,minmax(0,1fr),340px]">
        <aside className="space-y-5">
          <div className="panel p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Saved pipelines</p>
                <p className="mt-2 text-lg font-semibold text-white">Load and reuse</p>
              </div>
              <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => refreshPipelineList()} type="button">
                Refresh list
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {pipelines.length ? (
                pipelines.map((pipeline) => (
                  <SavedPipelineRow
                    active={pipeline.id === draft.id}
                    key={pipeline.id}
                    onClick={() => loadSavedPipeline(pipeline.id)}
                    pipeline={pipeline}
                  />
                ))
              ) : (
                <div className="rounded-[24px] border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
                  Save the current pipeline to build a reusable library here.
                </div>
              )}
            </div>
          </div>

          <div className="panel p-5">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Node palette</p>
            <p className="mt-2 text-lg font-semibold text-white">Add supported Phase 1 steps</p>
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
                <p className="mt-2 text-lg font-semibold text-white">Drag nodes and click ports to connect them</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">Click an output port, then an input port</span>
                {pendingConnection ? (
                  <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setPendingConnection(null)} type="button">
                    Cancel connection
                  </button>
                ) : null}
              </div>
            </div>

            <div className="mt-4 rounded-[28px] border border-white/10 bg-slate-950/30 p-3">
              <div className="relative h-[780px] overflow-auto rounded-[24px] border border-dashed border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(67,171,255,0.08),transparent_24%),linear-gradient(180deg,rgba(7,15,26,0.96),rgba(5,10,18,0.96))]" ref={canvasRef}>
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
                      const path = `M ${sourcePoint.x} ${sourcePoint.y} C ${sourcePoint.x + curveOffset} ${sourcePoint.y}, ${targetPoint.x - curveOffset} ${targetPoint.y}, ${targetPoint.x} ${targetPoint.y}`;
                      return <path d={path} fill="none" key={edge.id} stroke="rgba(103, 214, 255, 0.58)" strokeWidth="3" />;
                    })}
                  </svg>

                  {draft.nodes.length ? (
                    draft.nodes.map((node) => {
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
                          style={{
                            left: `${node.position.x}px`,
                            minHeight: `${getNodeCardHeight(node)}px`,
                            top: `${node.position.y}px`,
                            width: `${PIPELINE_NODE_WIDTH}px`,
                          }}
                        >
                          <div
                            className="flex cursor-grab items-start justify-between gap-3 rounded-t-[28px] border-b border-white/10 px-4 py-4"
                            onMouseDown={(event) => startDrag(node.id, event)}
                            role="presentation"
                          >
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
                                        className={`flex items-center gap-2 rounded-full border px-2 py-1 text-left text-[11px] uppercase tracking-[0.16em] transition ${pendingConnection && pendingConnection.kind === inputPort.kind ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-400 hover:border-cyan-300/25 hover:bg-white/10'}`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          if (!pendingConnection) {
                                            setSelectedNodeId(node.id);
                                            return;
                                          }

                                          connectPorts(
                                            pendingConnection.sourceNodeId,
                                            pendingConnection.sourcePortId,
                                            node.id,
                                            inputPort.id,
                                          );
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
                                            sourceNodeId: node.id,
                                            sourcePortId: outputPort.id,
                                            kind: outputPort.kind,
                                            label: outputPort.label,
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
                    })
                  ) : (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-7 text-slate-400">
                      Add a few nodes from the palette to start building a pipeline.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="panel p-5">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Run status</p>
            <p className="mt-2 text-lg font-semibold text-white">Sequential execution timeline</p>
            <div className="mt-4">
              <PipelineTimeline draft={draft} runState={runState} />
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
                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="node-label">
                    Node label
                  </label>
                  <input
                    className="store-input mt-3"
                    id="node-label"
                    onChange={(event) =>
                      updateNode(selectedNode.id, (currentNode) => ({
                        ...currentNode,
                        label: event.target.value,
                      }))
                    }
                    value={selectedNode.label}
                  />
                </div>

                <div className={`rounded-[24px] border p-4 ${toneToClassName(currentNodeSummary?.readiness?.tone || currentNodeSummary?.compatibility?.tone || 'neutral')}`}>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-300">Readiness</p>
                  <p className="mt-2 text-sm leading-6 text-slate-100">{currentNodeSummary?.readiness?.message || 'This node is ready.'}</p>
                  {currentNodeSummary?.compatibility ? (
                    <p className="mt-2 text-xs leading-5 text-slate-200">
                      {currentNodeSummary.compatibility.source}: {currentNodeSummary.compatibility.message}
                    </p>
                  ) : null}
                </div>

                {selectedNode.type === 'textInput' ? (
                  <div>
                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="node-text-input">
                      Text input
                    </label>
                    <textarea
                      className="store-input mt-3 min-h-[180px] resize-none"
                      id="node-text-input"
                      onChange={(event) =>
                        updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            text: event.target.value,
                          },
                        }))
                      }
                      placeholder="Write the initial text for this workflow."
                      value={selectedNode.config?.text || ''}
                    />
                  </div>
                ) : null}

                {selectedNode.type === 'audioInput' ? (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="node-audio-input">
                        Audio file
                      </label>
                      <input className="store-input mt-3" id="node-audio-input" readOnly value={selectedNode.config?.filePath || ''} />
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <button className="ghost-button" onClick={() => handleChooseAudio(selectedNode.id)} type="button">
                        Choose file
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() =>
                          updateNode(selectedNode.id, (currentNode) => ({
                            ...currentNode,
                            config: {
                              ...currentNode.config,
                              filePath: '',
                            },
                          }))
                        }
                        type="button"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'llmPrompt' ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-mode">
                        Execution target
                      </label>
                      <select
                        className="store-input mt-3"
                        id="llm-mode"
                        onChange={(event) => {
                          const nextMode = event.target.value;
                          updateNode(selectedNode.id, (currentNode) => ({
                            ...currentNode,
                            config: {
                              ...currentNode.config,
                              executionMode: nextMode,
                              providerId: nextMode === 'cloud' ? currentNode.config.providerId || '' : '',
                              model: '',
                            },
                          }));
                          setModelOptionsByNodeId((current) => ({
                            ...current,
                            [selectedNode.id]: [],
                          }));
                        }}
                        value={selectedNode.config?.executionMode || 'cloud'}
                      >
                        <option value="cloud">Cloud provider</option>
                        <option value="ollama">Ollama (local)</option>
                      </select>
                    </div>

                    {selectedNode.config?.executionMode === 'cloud' ? (
                      <div>
                        <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-provider">
                          Cloud provider
                        </label>
                        <select
                          className="store-input mt-3"
                          id="llm-provider"
                          onChange={(event) =>
                            updateNode(selectedNode.id, (currentNode) => ({
                              ...currentNode,
                              config: {
                                ...currentNode.config,
                                providerId: event.target.value,
                                model: '',
                              },
                            }))
                          }
                          value={selectedNode.config?.providerId || ''}
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
                        Local mode reuses the existing Ollama API path. Phase 1 does not auto-launch Ollama for a pipeline run, so start it from Library first.
                      </div>
                    )}

                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-model">
                        Model
                      </label>
                      <input
                        className="store-input mt-3"
                        id="llm-model"
                        onChange={(event) =>
                          updateNode(selectedNode.id, (currentNode) => ({
                            ...currentNode,
                            config: {
                              ...currentNode.config,
                              model: event.target.value,
                            },
                          }))
                        }
                        placeholder="Enter or pick a model"
                        value={selectedNode.config?.model || ''}
                      />
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <button className="ghost-button" disabled={modelsBusyNodeId === selectedNode.id} onClick={() => refreshNodeModels(selectedNode)} type="button">
                          {modelsBusyNodeId === selectedNode.id ? 'Refreshing...' : 'Refresh models'}
                        </button>
                        <span className="text-xs text-slate-500">
                          {selectedNode.config?.executionMode === 'ollama' ? 'Loads local Ollama models.' : 'Loads models from the selected cloud provider.'}
                        </span>
                      </div>
                      {modelOptionsByNodeId[selectedNode.id]?.length ? (
                        <div className="mt-3 grid gap-2">
                          {modelOptionsByNodeId[selectedNode.id].slice(0, 8).map((model) => (
                            <button
                              className={`rounded-2xl border px-3 py-3 text-left text-sm transition ${selectedNode.config?.model === model.id ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-50' : 'border-white/10 bg-white/5 text-slate-300 hover:border-cyan-300/20 hover:bg-white/10'}`}
                              key={model.id}
                              onClick={() =>
                                updateNode(selectedNode.id, (currentNode) => ({
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

                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-instruction">
                        Task / instruction
                      </label>
                      <textarea
                        className="store-input mt-3 min-h-[120px] resize-none"
                        id="llm-instruction"
                        onChange={(event) =>
                          updateNode(selectedNode.id, (currentNode) => ({
                            ...currentNode,
                            config: {
                              ...currentNode.config,
                              instruction: event.target.value,
                            },
                          }))
                        }
                        placeholder="Optional guidance to apply to the incoming text."
                        value={selectedNode.config?.instruction || ''}
                      />
                    </div>

                    <div>
                      <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="llm-system-prompt">
                        System prompt
                      </label>
                      <textarea
                        className="store-input mt-3 min-h-[120px] resize-none"
                        id="llm-system-prompt"
                        onChange={(event) =>
                          updateNode(selectedNode.id, (currentNode) => ({
                            ...currentNode,
                            config: {
                              ...currentNode.config,
                              systemPrompt: event.target.value,
                            },
                          }))
                        }
                        placeholder="Optional persistent instruction for this step."
                        value={selectedNode.config?.systemPrompt || ''}
                      />
                    </div>
                  </div>
                ) : null}

                {selectedNode.type === 'whisperTranscribe' ? (
                  <div>
                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="whisper-model">
                      Whisper model
                    </label>
                    <select
                      className="store-input mt-3"
                      id="whisper-model"
                      onChange={(event) =>
                        updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            model: event.target.value,
                          },
                        }))
                      }
                      value={selectedNode.config?.model || 'base'}
                    >
                      {WHISPER_MODELS.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {selectedNode.type === 'textOutput' ? (
                  <div>
                    <label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="output-title">
                      Output title
                    </label>
                    <input
                      className="store-input mt-3"
                      id="output-title"
                      onChange={(event) =>
                        updateNode(selectedNode.id, (currentNode) => ({
                          ...currentNode,
                          config: {
                            ...currentNode.config,
                            title: event.target.value,
                          },
                        }))
                      }
                      value={selectedNode.config?.title || ''}
                    />
                  </div>
                ) : null}

                <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Connections</p>
                  <div className="mt-3 space-y-3">
                    {draft.edges.filter((edge) => edge.source.nodeId === selectedNode.id || edge.target.nodeId === selectedNode.id).length ? (
                      draft.edges
                        .filter((edge) => edge.source.nodeId === selectedNode.id || edge.target.nodeId === selectedNode.id)
                        .map((edge) => {
                          const sourceNode = draft.nodes.find((node) => node.id === edge.source.nodeId);
                          const targetNode = draft.nodes.find((node) => node.id === edge.target.nodeId);
                          const sourcePort = getPortDefinition(sourceNode?.type, 'output', edge.source.portId);
                          const targetPort = getPortDefinition(targetNode?.type, 'input', edge.target.portId);
                          return (
                            <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3" key={edge.id}>
                              <p className="text-sm font-medium text-white">
                                {sourceNode?.label || 'Unknown'}: <span className="text-slate-400">{sourcePort?.label || edge.source.portId}</span>
                              </p>
                              <p className="mt-1 text-sm text-slate-300">
                                to {targetNode?.label || 'Unknown'}: <span className="text-slate-400">{targetPort?.label || edge.target.portId}</span>
                              </p>
                              <button className="ghost-button mt-3 px-3 py-1.5 text-xs" onClick={() => removeEdge(edge.id)} type="button">
                                Remove connection
                              </button>
                            </div>
                          );
                        })
                    ) : (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-3 py-4 text-sm leading-6 text-slate-400">
                        This node has no connections yet.
                      </div>
                    )}
                  </div>
                </div>

                <button className="ghost-button w-full justify-center" onClick={() => removeNode(selectedNode.id)} type="button">
                  Delete node
                </button>
              </div>
            ) : (
              <div className="mt-4 rounded-[24px] border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
                Select a node on the canvas to edit its settings and inspect its connections.
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}


