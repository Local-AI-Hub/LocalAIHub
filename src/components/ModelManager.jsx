import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../lib/formatters';
const DEFAULT_SOURCE_OPTIONS = [{ id: 'huggingface', label: 'Hugging Face' }];
const MODEL_TYPE_OPTIONS = [
  { id: 'all', label: 'All types' },
  { id: 'checkpoint', label: 'Checkpoint' },
  { id: 'lora', label: 'LoRA' },
  { id: 'vae', label: 'VAE' },
  { id: 'embedding', label: 'Embedding' },
  { id: 'controlnet', label: 'ControlNet' },
  { id: 'hypernetwork', label: 'Hypernetwork' },
  { id: 'upscaler', label: 'Upscaler' },
  { id: 'gguf', label: 'GGUF / Quantized LLM' },
  { id: 'audio-speech', label: 'Audio / Speech' },
  { id: 'inpainting', label: 'Inpainting' },
];
const SORT_OPTIONS = [
  { id: 'most-downloaded', label: 'Most downloaded' },
  { id: 'newest', label: 'Newest' },
  { id: 'highest-rated', label: 'Highest rated' },
];
const TASK_OPTIONS = [
  { id: 'all', label: 'All tasks' },
  { id: 'image-generation', label: 'Image generation' },
  { id: 'image-to-image', label: 'Image-to-image' },
  { id: 'text-generation', label: 'Text generation' },
  { id: 'video-generation', label: 'Video generation' },
  { id: 'image-to-video', label: 'Image to video' },
  { id: 'audio-speech', label: 'Audio / Speech' },
];
const EMPTY_PAGINATION = {
  hasMore: false,
  nextCursor: null,
  nextPage: null,
};
function getModelManagerConfig(tool) {
  const config = tool?.modelManager;
  if (!config || config.enabled === false) {
    return null;
  }
  return config;
}
function normalizeOptionIds(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}
function filterDeclaredOptions(options, declaredValues = []) {
  const allowedIds = normalizeOptionIds(declaredValues);
  if (!allowedIds.length) {
    return options;
  }
  return options.filter((option) => allowedIds.includes(option.id));
}
function getModelManagerSources(tool) {
  const config = getModelManagerConfig(tool);
  if (!Array.isArray(config?.sources)) {
    return DEFAULT_SOURCE_OPTIONS;
  }
  const sources = config.sources
    .map((entry) => ({
      id: String(entry?.id || '').trim(),
      label: String(entry?.label || entry?.id || '').trim(),
    }))
    .filter((entry) => entry.id && entry.label);
  return sources.length ? sources : DEFAULT_SOURCE_OPTIONS;
}
function getToolModelTypeOptions(tool) {
  return filterDeclaredOptions(MODEL_TYPE_OPTIONS, getModelManagerConfig(tool)?.allowedModelTypes);
}
function getToolTaskOptions(tool, sourceId) {
  if (!['huggingface', 'tabby'].includes(sourceId)) {
    return [];
  }
  return filterDeclaredOptions(TASK_OPTIONS, getModelManagerConfig(tool)?.allowedTaskTypes);
}
function getToolDefaults(tool) {
  const config = getModelManagerConfig(tool);
  const sourceOptions = getModelManagerSources(tool);
  const modelTypeOptions = getToolModelTypeOptions(tool);
  const taskOptions = filterDeclaredOptions(TASK_OPTIONS, config?.allowedTaskTypes);
  const firstSourceId = sourceOptions[0]?.id || 'huggingface';
  const requestedSource = String(config?.defaults?.source || firstSourceId).trim();
  const requestedModelType = String(config?.defaults?.modelType || modelTypeOptions[0]?.id || 'all').trim().toLowerCase();
  const requestedTaskType = String(config?.defaults?.taskType || taskOptions[0]?.id || (firstSourceId === 'ollama' ? 'all' : 'image-generation')).trim().toLowerCase();
  return {
    modelType: modelTypeOptions.some((entry) => entry.id === requestedModelType) ? requestedModelType : modelTypeOptions[0]?.id || 'all',
    source: sourceOptions.some((entry) => entry.id === requestedSource) ? requestedSource : firstSourceId,
    taskType: taskOptions.some((entry) => entry.id === requestedTaskType) ? requestedTaskType : taskOptions[0]?.id || (firstSourceId === 'ollama' ? 'all' : 'image-generation'),
  };
}
function normalizeMatchKey(value) {
  return String(value || '').trim().replace(/[\\/]+/g, '/').toLowerCase();
}
function getRemoteMatchKeys(remoteItem) {
  if (remoteItem?.source === 'ollama') {
    return [remoteItem?.downloadPlan?.recommendedArtifactPath, remoteItem?.fileName, remoteItem?.name]
      .map((value) => normalizeMatchKey(value))
      .filter(Boolean);
  }
  return [remoteItem?.downloadIdentity].map((value) => normalizeMatchKey(value)).filter(Boolean);
}
function matchingLocalModel(remoteItem, localModels) {
  if (remoteItem?.downloadPlan?.runnable === false) {
    return null;
  }
  const remoteKeys = getRemoteMatchKeys(remoteItem);
  if (!remoteKeys.length) {
    return null;
  }
  return (localModels || []).find((model) => {
    const localKeys = remoteItem?.source === 'ollama'
      ? [model?.relativePath, model?.fileName, model?.name]
      : [model?.downloadIdentity, model?.metadata?.downloadIdentity];
    return localKeys.map((value) => normalizeMatchKey(value)).filter(Boolean).some((key) => remoteKeys.includes(key));
  }) || null;
}
function mergeRemoteItems(currentItems, nextItems) {
  const merged = [...currentItems];
  const knownIds = new Set(currentItems.map((item) => item.id));
  for (const item of nextItems) {
    if (knownIds.has(item.id)) {
      continue;
    }
    knownIds.add(item.id);
    merged.push(item);
  }
  return merged;
}
function buildBlockedDiskMessage(subject, preflight) {
  if (!preflight?.mount) {
    return `${subject} needs more free disk space before Local AI Hub can continue.`;
  }
  return `${subject} needs ${formatBytes(preflight.requiredBytes)}, but only ${formatBytes(preflight.availableBytes)} is free on ${preflight.mount}. Clear space and try again.`;
}
function buildLowDiskConfirmationMessage(subject, preflight) {
  if (!preflight?.mount) {
    return `${subject} may leave the target drive very low on free space. Continue?`;
  }
  if (preflight?.sizeKnown) {
    return `${subject} needs about ${formatBytes(preflight.requiredBytes)}. Only ${formatBytes(preflight.availableBytes)} is free on ${preflight.mount}, so this would leave less than 10% free. Continue?`;
  }
  return `${subject} may leave ${preflight.mount} very low on free space, and Local AI Hub could not confirm the file size first. Continue?`;
}
function badgeClass(tone) {
  if (tone === 'good') {
    return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100';
  }
  if (tone === 'warn') {
    return 'border-amber-400/25 bg-amber-400/10 text-amber-100';
  }
  if (tone === 'danger') {
    return 'border-rose-400/25 bg-rose-400/10 text-rose-100';
  }
  return 'border-white/10 bg-white/5 text-slate-300';
}
function PreviewFallback({ source }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-slate-950/50 text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">
      {source === 'ollama' ? 'OLL' : source === 'civitai' ? 'CV' : source === 'tabby' ? 'TB' : 'HF'}
    </div>
  );
}
function ModelPreview({ item }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setImageFailed(false);
  }, [item.previewUrl]);
  if (!item.previewUrl || imageFailed) {
    return <PreviewFallback source={item.source} />;
  }
  return (
    <img
      alt={item.name}
      className="h-full w-full object-cover"
      onError={() => setImageFailed(true)}
      src={item.previewUrl}
    />
  );
}
function ModelCard({ item, deleteBusy, downloadProgress, localMatch, onDelete, onDownload }) {
  const selectedArtifact = item.downloadPlan?.recommendedArtifactPath || item.installRelativePath || item.fileName || '';
  const artifactStatus = item.downloadPlan?.runnable === false ? 'Blocked' : item.downloadPlan?.warning ? 'Possible' : 'Selected';
  const targetDirectory = item.downloadPlan?.targetDirectory || item.downloadTarget || '';
  const artifactStatusClass = item.downloadPlan?.runnable === false
    ? 'border-rose-400/25 bg-rose-400/10 text-rose-100'
    : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100';
  return (
    <article className="rounded-[28px] border border-white/10 bg-slate-950/35 p-4">
      <div className="aspect-[16/9] overflow-hidden rounded-[22px] border border-white/10 bg-white/5">
        <ModelPreview item={item} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <h4 className="text-lg font-semibold text-white">{item.name}</h4>
        {item.catalogEntityLabel ? (
          <span className="status-pill border-cyan-400/20 bg-cyan-400/10 text-cyan-100">{item.catalogEntityLabel}</span>
        ) : null}
        <span className="status-pill border-white/10 bg-white/5 text-slate-300">{item.modelType}</span>
        {item.artifactLabel && item.artifactLabel !== item.modelType ? (
          <span className="status-pill border-cyan-400/20 bg-cyan-400/10 text-cyan-100">{item.artifactLabel}</span>
        ) : null}
        {item.downloadPlan?.runnable === false ? (
          <span className="status-pill border-rose-400/25 bg-rose-400/10 text-rose-100">Not compatible</span>
        ) : null}
        {item.hardwareFit ? <span className={`status-pill ${badgeClass(item.hardwareFit.tone)}`}>{item.hardwareFit.label}</span> : null}
        {item.highVramWarning ? (
          <span className="status-pill border-rose-400/25 bg-rose-400/10 text-rose-100">{item.highVramWarning.warningLabel}</span>
        ) : null}
        {localMatch ? <span className="status-pill border-emerald-400/20 bg-emerald-400/10 text-emerald-100">Downloaded</span> : null}
      </div>
      <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-300">{item.description}</p>
      {item.catalogParentLabel || item.catalogContext ? (
        <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
          <p className="text-sm font-medium text-white">{item.catalogParentLabel ? `From ${item.catalogParentLabel}` : item.catalogContext}</p>
          {item.catalogParentLabel && item.catalogContext ? <p className="mt-2 text-xs leading-5 text-slate-400">{item.catalogContext}</p> : null}
        </div>
      ) : null}
      <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Selected artifact</p>
          <span className={`status-pill ${artifactStatusClass}`}>{artifactStatus}</span>
        </div>
        <p className="mt-2 break-all text-sm font-medium text-white">{selectedArtifact || 'No compatible artifact selected'}</p>
        <p className="mt-2 text-xs leading-5 text-slate-400">{item.artifactLabel || item.modelType || 'Model artifact'}</p>
        <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500">Install target</p>
        <p className="mt-2 break-all text-xs leading-5 text-slate-400">{targetDirectory || 'No compatible install folder for this target.'}</p>
      </div>
      {item.highVramWarning ? (
        <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-3 py-3 text-sm text-rose-100">
          {item.highVramWarning.warningMessage}
        </div>
      ) : null}
      {item.downloadPlan?.blockingReason || item.downloadPlan?.warning ? (
        <div className={`mt-4 rounded-2xl border px-3 py-3 text-sm ${item.downloadPlan?.blockingReason ? 'border-rose-400/20 bg-rose-400/10 text-rose-100' : 'border-amber-400/25 bg-amber-400/10 text-amber-100'}`}>
          {item.downloadPlan.blockingReason || item.downloadPlan.warning}
        </div>
      ) : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Source</p>
          <p className="mt-2 text-sm font-medium capitalize text-white">{item.source}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">File size</p>
          <p className="mt-2 text-sm font-medium text-white">{item.sizeBytes ? formatBytes(item.sizeBytes) : item.sizeLabel || 'Unknown'}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Hardware fit</p>
          <p className="mt-2 text-sm font-medium text-white">{item.hardwareFit?.label || 'Unknown'}</p>
          <p className="mt-2 text-xs leading-5 text-slate-400">{item.hardwareFit?.message || 'No GPU fit estimate yet.'}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Disk headroom</p>
          <p className="mt-2 text-sm font-medium text-white">
            {item.diskWarning?.tone === 'danger' ? 'Low space' : item.diskWarning?.tone === 'warn' ? 'Watch space' : 'Looks safe'}
          </p>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            {item.diskWarning?.message || 'This download should leave enough free space on the target drive.'}
          </p>
        </div>
      </div>
      {downloadProgress ? (
        <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-3 text-sm text-cyan-50">
          <div className="flex items-center justify-between gap-3">
            <span>{downloadProgress.message}</span>
            <span>{Number.isFinite(downloadProgress.percent) ? `${downloadProgress.percent}%` : '...'}</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-950/40">
            <div
              className="h-full rounded-full bg-cyan-300 transition-all"
              style={{ width: `${Math.max(5, Math.min(100, downloadProgress.percent || 5))}%` }}
            />
          </div>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        {localMatch ? (
          <button className="ghost-button" disabled={deleteBusy} onClick={() => onDelete(localMatch, item)} type="button">
            {deleteBusy ? 'Deleting...' : 'Delete'}
          </button>
        ) : (
          <button className="primary-button" disabled={item.downloadPlan?.runnable === false} onClick={() => onDownload(item)} type="button">
            {item.downloadPlan?.runnable === false ? 'Not compatible' : 'Download'}
          </button>
        )}
      </div>
    </article>
  );
}export default function ModelManager({ tools, onToast }) {
  const modelTools = useMemo(() => (tools || []).filter((tool) => getModelManagerConfig(tool)), [tools]);
  const [selectedToolId, setSelectedToolId] = useState(modelTools[0]?.id || '');
  const [selectedSource, setSelectedSource] = useState(getToolDefaults(modelTools[0]).source);
  const [search, setSearch] = useState('');
  const [browseLoading, setBrowseLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [localLoading, setLocalLoading] = useState(false);
  const [remoteItems, setRemoteItems] = useState([]);
  const [catalogState, setCatalogState] = useState({ error: null, query: '', source: '' });
  const [localModels, setLocalModels] = useState([]);
  const [settings, setSettings] = useState({ civitaiApiKey: '', civitaiCredentialSource: 'missing', civitaiEnvVarName: 'CIVITAI_API_KEY', hasCivitaiApiKey: false, hasSavedCivitaiApiKey: false });
  const [civitaiApiKeyDraft, setCivitaiApiKeyDraft] = useState('');
  const [downloadProgressMap, setDownloadProgressMap] = useState({});
  const [pagination, setPagination] = useState(EMPTY_PAGINATION);
  const [modelType, setModelType] = useState(getToolDefaults(modelTools[0]).modelType);
  const [sort, setSort] = useState('most-downloaded');
  const [taskType, setTaskType] = useState(getToolDefaults(modelTools[0]).taskType);
  const [deleteBusyId, setDeleteBusyId] = useState(null);
  const browseRequestIdRef = useRef(0);
  const selectedTool = modelTools.find((tool) => tool.id === selectedToolId) || null;
  const sourceOptions = getModelManagerSources(selectedTool);
  const modelTypeOptions = getToolModelTypeOptions(selectedTool);
  const taskOptions = getToolTaskOptions(selectedTool, selectedSource);
  const taskFilteringEnabled = ['huggingface', 'tabby'].includes(selectedSource);
  const taskOptionsVisible = taskFilteringEnabled && taskOptions.length > 1;
  const effectiveTaskType = taskFilteringEnabled ? (taskOptions.length ? taskType : getToolDefaults(selectedTool).taskType) : 'all';
  const filterOptionsVisible = selectedSource !== 'ollama' && modelTypeOptions.length > 1;
  function applyToolDefaults(toolId) {
    const tool = modelTools.find((entry) => entry.id === toolId) || null;
    const defaults = getToolDefaults(tool);
    setSelectedToolId(toolId);
    setSelectedSource(defaults.source);
    setModelType(defaults.modelType);
    setTaskType(defaults.taskType);
    setSearch('');
    browseRequestIdRef.current += 1;
    setRemoteItems([]);
    setCatalogState({ error: null, query: '', source: defaults.source });
    setPagination(EMPTY_PAGINATION);
  }
  async function loadSettings() {
    const result = await window.localAIHub.getModelSettings();
    if (result?.ok) {
      setSettings(result.data || { civitaiApiKey: '', civitaiCredentialSource: 'missing', civitaiEnvVarName: 'CIVITAI_API_KEY', hasCivitaiApiKey: false, hasSavedCivitaiApiKey: false });
      setCivitaiApiKeyDraft('');
    }
  }
  async function loadLocalModels(toolId = selectedToolId) {
    if (!toolId) {
      setLocalModels([]);
      return;
    }
    setLocalLoading(true);
    const result = await window.localAIHub.listLocalModels(toolId);
    if (result?.ok) {
      setLocalModels(result.data || []);
    } else {
      onToast(result?.message || 'Local AI Hub could not load local models for that tool.', 'error');
      setLocalModels([]);
    }
    setLocalLoading(false);
  }
  async function browse(options = {}) {
    const toolId = options.toolId || selectedToolId;
    const source = options.source || selectedSource;
    const append = Boolean(options.append);
    const query = options.query !== undefined ? options.query : search;
    if (!toolId) {
      browseRequestIdRef.current += 1;
      setRemoteItems([]);
      setLocalModels([]);
      setPagination(EMPTY_PAGINATION);
      setCatalogState({ error: null, query: '', source });
      return;
    }
    if (append) {
      setLoadingMore(true);
    } else {
      setBrowseLoading(true);
      setRemoteItems([]);
      setPagination(EMPTY_PAGINATION);
      setCatalogState({ error: null, query, source });
    }
    const requestId = browseRequestIdRef.current + 1;
    browseRequestIdRef.current = requestId;
    const result = await window.localAIHub.browseModels({
      cursor: options.cursor || null,
      modelType,
      page: options.page || 1,
      query,
      sort,
      source,
      taskType: effectiveTaskType,
      toolId,
    });
    if (!result?.ok) {
      if (requestId !== browseRequestIdRef.current) {
        return;
      }
      const message = result?.message || 'Local AI Hub could not load remote models right now.';
      onToast(message, 'error');
      if (!append) {
        setRemoteItems([]);
        setPagination(EMPTY_PAGINATION);
        setCatalogState({ error: message, query, source });
      }
      setBrowseLoading(false);
      setLoadingMore(false);
      return;
    }
    if (requestId !== browseRequestIdRef.current) {
      return;
    }
    const nextItems = result.data?.items || [];
    setRemoteItems((current) => (append ? mergeRemoteItems(current, nextItems) : nextItems));
    if (!append) {
      setCatalogState({ error: null, query, source });
    }
    setLocalModels(result.data?.localModels || []);
    setPagination(result.data?.pagination || EMPTY_PAGINATION);
    if (result.data?.settings) {
      setSettings(result.data.settings);
      setCivitaiApiKeyDraft('');
    }
    setBrowseLoading(false);
    setLoadingMore(false);
  }
  async function handleLoadMore() {
    if (!pagination.hasMore) {
      return;
    }
    await browse({
      append: true,
      cursor: pagination.nextCursor,
      page: pagination.nextPage || 1,
    });
  }
  useEffect(() => {
    loadSettings();
    const unsubscribe = window.localAIHub.onModelDownloadProgress((payload) => {
      setDownloadProgressMap((current) => ({
        ...current,
        [payload.downloadId]: payload,
      }));
      if (payload.percent >= 100) {
        window.setTimeout(() => {
          setDownloadProgressMap((current) => {
            const next = { ...current };
            delete next[payload.downloadId];
            return next;
          });
        }, 2500);
      }
    });
    return () => unsubscribe();
  }, []);
  useEffect(() => {
    const nextToolId = modelTools[0]?.id || '';
    const hasSelectedTool = modelTools.some((tool) => tool.id === selectedToolId);
    if (!hasSelectedTool && nextToolId) {
      applyToolDefaults(nextToolId);
    }
  }, [modelTools, selectedToolId]);
  useEffect(() => {
    if (!selectedToolId || !selectedTool) {
      browseRequestIdRef.current += 1;
      setRemoteItems([]);
      setLocalModels([]);
      setPagination(EMPTY_PAGINATION);
      setCatalogState({ error: null, query: '', source });
      return;
    }
    const defaults = getToolDefaults(selectedTool);
    const supportedSources = getModelManagerSources(selectedTool);
    const hasSelectedSource = supportedSources.some((entry) => entry.id === selectedSource);
    if (!hasSelectedSource) {
      setSelectedSource(defaults.source);
      return;
    }
    const supportedModelTypes = getToolModelTypeOptions(selectedTool);
    if (supportedModelTypes.length && !supportedModelTypes.some((entry) => entry.id === modelType)) {
      setModelType(defaults.modelType);
      return;
    }
    const supportedTaskTypes = getToolTaskOptions(selectedTool, selectedSource);
    if (supportedTaskTypes.length && !supportedTaskTypes.some((entry) => entry.id === taskType)) {
      setTaskType(defaults.taskType);
      return;
    }
    setPagination(EMPTY_PAGINATION);
    browse({ page: 1, cursor: null });
  }, [selectedTool, selectedToolId, selectedSource, modelType, sort, taskType]);
  async function handleDownload(item) {
    const subject = item?.name || item?.fileName || 'This model';
    const preflightResult = await window.localAIHub.getModelDownloadPreflight({
      ...item,
      toolId: selectedToolId,
    });
    if (!preflightResult?.ok) {
      onToast(preflightResult?.message || 'Local AI Hub could not check disk space for that model download.', 'error');
      return;
    }
    const preflight = preflightResult.data;
    if (preflight?.blocked) {
      onToast(buildBlockedDiskMessage(subject, preflight), 'error');
      return;
    }
    let lowDiskConfirmed = false;
    if (preflight?.requiresConfirmation) {
      lowDiskConfirmed = window.confirm(buildLowDiskConfirmationMessage(subject, preflight));
      if (!lowDiskConfirmed) {
        return;
      }
    }
    const result = await window.localAIHub.downloadModel({
      ...item,
      lowDiskConfirmed,
      toolId: selectedToolId,
    });
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not download that model.', 'error');
      return;
    }
    onToast(result.data?.message || `${item.name} was downloaded.`, 'success');
    setLocalModels(result.data?.localModels || []);
    browse({ page: 1, cursor: null });
  }
  async function handleDelete(model, remoteItem = null) {
    const displayName = remoteItem?.name || model?.name || model?.fileName || 'this model';
    const toolName = selectedTool?.name || 'this tool';
    const deleteMessage =
      selectedToolId === 'ollama'
        ? `Delete ${displayName} from ${toolName}? Local AI Hub will run ollama rm and remove the local model.`
        : `Delete ${displayName} from ${toolName}? This removes the downloaded model file from your PC.`;
    if (!window.confirm(deleteMessage)) {
      return;
    }
    setDeleteBusyId(model.id);
    const result = await window.localAIHub.deleteModel({
      ...model,
      toolId: selectedToolId,
    });
    if (!result?.ok) {
      setDeleteBusyId(null);
      onToast(result?.message || 'Local AI Hub could not delete that model.', 'error');
      return;
    }
    onToast(result.data?.message || `${displayName} was deleted.`, 'success');
    setLocalModels(result.data?.localModels || []);
    setDeleteBusyId(null);
    browse({ page: 1, cursor: null });
  }
  async function handleSaveCivitaiKey(clearExisting = false) {
    const trimmedKey = civitaiApiKeyDraft.trim();
    if (!clearExisting && !trimmedKey) {
      onToast('Paste a CivitAI API key first, or use Clear key to remove the saved one.', 'error');
      return;
    }
    const result = await window.localAIHub.saveModelSettings({
      civitaiApiKey: clearExisting ? '' : trimmedKey,
    });
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not save the CivitAI API key.', 'error');
      return;
    }
    setSettings(result.data?.settings || { civitaiApiKey: '', civitaiCredentialSource: !clearExisting && Boolean(trimmedKey) ? 'saved' : 'missing', civitaiEnvVarName: 'CIVITAI_API_KEY', hasCivitaiApiKey: !clearExisting && Boolean(trimmedKey), hasSavedCivitaiApiKey: !clearExisting && Boolean(trimmedKey) });
    setCivitaiApiKeyDraft('');
    onToast(result.data?.message || (clearExisting ? 'CivitAI API key removed.' : 'CivitAI API key saved.'), 'success');
  }
  if (!modelTools.length) {
    return (
      <section className="panel p-10 text-center">
        <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Model Manager</p>
        <h3 className="mt-3 text-3xl font-semibold text-white">Install a supported tool first.</h3>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-slate-300">
          Model downloads are available once a supported model tool is installed or detected on this PC.
        </p>
      </section>
    );
  }
  const emptyQuery = String(catalogState.query || '').trim();
  const emptySource = catalogState.source || selectedSource;
  const selectedSourceLabel = sourceOptions.find((entry) => entry.id === emptySource)?.label || emptySource;
  const emptyCatalogMessage = catalogState.error
    ? `${catalogState.error} Previous catalog results were cleared for this search.`
    : emptyQuery
      ? `No ${selectedSourceLabel} results matched "${emptyQuery}". Local AI Hub searched with the selected source and filters; try another source or a shorter model-family query.`
      : 'No catalog results matched this search. Try another query or filter.';
  return (
    <section className="space-y-5">
      <div className="panel p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Model Manager</p>
            <h3 className="mt-3 text-3xl font-semibold text-white">Browse live model catalogs with local fit checks</h3>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
              Search full Hugging Face and CivitAI catalogs, keep normal model browsing intact, and surface exact downloadable artifacts when the provider data makes that possible before you download.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select className="store-input min-w-[220px]" onChange={(event) => applyToolDefaults(event.target.value)} value={selectedToolId}>
              {modelTools.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.name}
                </option>
              ))}
            </select>
            <select className="store-input min-w-[220px]" onChange={(event) => setSelectedSource(event.target.value)} value={selectedSource}>
              {sourceOptions.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
            {filterOptionsVisible ? (
              <select className="store-input min-w-[220px]" onChange={(event) => setModelType(event.target.value)} value={modelType}>
                {modelTypeOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : null}
            {taskOptionsVisible ? (
              <select className="store-input min-w-[220px]" onChange={(event) => setTaskType(event.target.value)} value={taskType}>
                {taskOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : null}
            <select className="store-input min-w-[190px]" onChange={(event) => setSort(event.target.value)} value={sort}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              className="store-input min-w-[260px]"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  browse({ page: 1, cursor: null, query: event.currentTarget.value });
                }
              }}
              placeholder={selectedSource === 'ollama' ? 'Search Ollama models' : 'Search remote catalogs'}
              type="search"
              value={search}
            />
            <button className="primary-button" disabled={browseLoading} onClick={() => browse({ page: 1, cursor: null })} type="button">
              {browseLoading ? 'Loading...' : 'Search'}
            </button>
          </div>
        </div>
        {selectedSource === 'civitai' ? (
          <div className="mt-5 rounded-[26px] border border-white/10 bg-slate-950/35 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[280px] flex-1">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">CivitAI API key</p>
                <input
                  className="store-input mt-3"
                  onChange={(event) => setCivitaiApiKeyDraft(event.target.value)}
                  placeholder={settings.hasSavedCivitaiApiKey ? 'Saved in Windows Credential Manager. Paste a new key to replace it.' : 'Paste your CivitAI API key'}
                  type="password"
                  value={civitaiApiKeyDraft}
                />
              </div>
              <button className="ghost-button" onClick={() => handleSaveCivitaiKey()} type="button">
                Save key
              </button>
              {settings.hasSavedCivitaiApiKey ? (
                <button className="ghost-button" onClick={() => handleSaveCivitaiKey(true)} type="button">
                  Clear saved key
                </button>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-slate-400">
              <p className="leading-6">Uses CIVITAI_API_KEY when it is present for this app session, otherwise uses Windows Credential Manager. Public browsing still works without a key.</p>
              {settings.civitaiCredentialSource === 'environment' ? <span className="status-pill border-cyan-300/25 bg-cyan-300/10 text-cyan-100">Using environment variable</span> : null}
              {settings.civitaiCredentialSource === 'saved' ? <span className="status-pill border-emerald-400/20 bg-emerald-400/10 text-emerald-100">Saved</span> : null}
            </div>
          </div>
        ) : null}
      </div>
      <div className="grid gap-5 xl:grid-cols-[320px,1fr]">
        <aside className="panel p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Downloaded</p>
              <h4 className="mt-2 text-xl font-semibold text-white">Downloaded models</h4>
            </div>
            <button className="ghost-button" disabled={localLoading} onClick={() => loadLocalModels()} type="button">
              {localLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
          <div className="mt-4 space-y-3">
            {localModels.length ? (
              localModels.map((model) => (
                <div key={model.id} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-white">{model.name}</p>
                    <span className="status-pill border-white/10 bg-slate-950/40 text-slate-300">{model.modelType}</span>
                  </div>
                  <p className="mt-2 break-all text-xs leading-6 text-slate-400">{model.relativePath || model.fileName}</p>
                  <p className="mt-2 text-sm text-slate-300">{model.sizeBytes ? formatBytes(model.sizeBytes) : 'Unknown size'}</p>
                  <button
                    className="ghost-button mt-3 w-full justify-center"
                    disabled={deleteBusyId === model.id}
                    onClick={() => handleDelete(model)}
                    type="button"
                  >
                    {deleteBusyId === model.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-6 text-sm leading-6 text-slate-400">
                No downloaded models were detected for this tool yet.
              </div>
            )}
          </div>
        </aside>
        <div className="panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Remote catalog</p>
              <h4 className="mt-2 text-xl font-semibold text-white">Available catalog results</h4>
            </div>
            <p className="text-sm text-slate-400">{remoteItems.length} loaded</p>
          </div>
          <div className="mt-5 grid gap-4 2xl:grid-cols-2">
            {remoteItems.length ? (
              remoteItems.map((item) => {
                const localMatch = matchingLocalModel(item, localModels);
                return (
                  <ModelCard
                    key={item.id}
                    deleteBusy={deleteBusyId === localMatch?.id}
                    downloadProgress={downloadProgressMap[item.id]}
                    item={item}
                    localMatch={localMatch}
                    onDelete={handleDelete}
                    onDownload={handleDownload}
                  />
                );
              })
            ) : (
              <div className="rounded-[28px] border border-dashed border-white/15 bg-white/5 p-10 text-center text-slate-400 2xl:col-span-2">
                {browseLoading ? 'Loading remote catalog results...' : emptyCatalogMessage}
              </div>
            )}
          </div>
          {pagination.hasMore ? (
            <div className="mt-5 flex justify-center">
              <button className="ghost-button" disabled={loadingMore} onClick={handleLoadMore} type="button">
                {loadingMore ? 'Loading more...' : 'Load more'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
