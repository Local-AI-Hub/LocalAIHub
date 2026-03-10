import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AiderPanel from './components/AiderPanel';
import CloudChatPanel from './components/CloudChatPanel';
import ConnectionsPanel from './components/ConnectionsPanel';
import HardwareGate from './components/HardwareGate';
import LibraryCard from './components/LibraryCard';
import ModelManager from './components/ModelManager';
import OllamaChatPanel from './components/OllamaChatPanel';
import PipelineBuilderPanel from './components/PipelineBuilderPanel';
import ProviderCard from './components/ProviderCard';
import ResourceStrip from './components/ResourceStrip';
import SettingsPanel from './components/SettingsPanel';
import Sidebar from './components/Sidebar';
import StatisticsPanel from './components/StatisticsPanel';
import StoreCard from './components/StoreCard';
import ToolUpdatesPanel from './components/ToolUpdatesPanel';
import WhisperPanel from './components/WhisperPanel';
import { formatBytes, formatUsage } from './lib/formatters';
import { evaluateCompatibility, toolSearchText } from './lib/tool-ui';

const EMPTY_STATE = {
  appDataPath: '',
  appInstallPath: '',
  downloadedModelCount: 0,
  executablePath: '',
  firstLaunch: false,
  hardware: null,
  logsPath: '',
  managedDataPath: '',
  manifests: [],
  manifestStatus: null,
  providerManifestStatus: null,
  providers: [],
  resources: null,
  settings: {
    closeBehavior: 'tray',
  },
  storage: null,
  toolUpdates: {
    availableCount: 0,
    entries: [],
    lastCheckedAt: null,
  },
  tools: [],
};

const CONSOLE_OUTPUT_LIMIT = 48000;
const FOCUSED_RESOURCE_REFRESH_INTERVAL_MS = 3000;
const UNFOCUSED_RESOURCE_REFRESH_INTERVAL_MS = 10000;
const DISK_RESOURCE_REFRESH_INTERVAL_MS = 30000;

function trimConsoleOutput(value) {
  const text = String(value || '');
  return text.length > CONSOLE_OUTPUT_LIMIT ? text.slice(-CONSOLE_OUTPUT_LIMIT) : text;
}

function combineRuntimeOutput(payload) {
  const stdout = String(payload?.stdout || '');
  const stderr = String(payload?.stderr || '');
  if (stdout && stderr) {
    return trimConsoleOutput(`${stdout}\n${stderr}`);
  }

  return trimConsoleOutput(stdout || stderr || '');
}

function pluralizeLabel(count, singular) {
  return count === 1 ? singular : `${singular}s`;
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

function Toast({ toast, onDismiss }) {
  const toneClass =
    toast.tone === 'error'
      ? 'border-danger/40 bg-danger/10 text-rose-100'
      : 'border-signal/40 bg-signal/10 text-emerald-100';

  return (
    <div className={`pointer-events-auto max-w-md rounded-2xl border px-4 py-3 text-sm shadow-soft ${toneClass}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          <p className="leading-6">{toast.message}</p>
          {toast.actionLabel ? (
            <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => toast.onAction?.()} type="button">
              {toast.actionLabel}
            </button>
          ) : null}
        </div>
        <button
          className="rounded-full border border-white/15 px-2 py-1 text-xs font-semibold text-white/80 transition hover:bg-white/10"
          onClick={() => onDismiss(toast.id)}
          type="button"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [appState, setAppState] = useState(EMPTY_STATE);
  const [isLoading, setIsLoading] = useState(true);
  const [busyMap, setBusyMap] = useState({});
  const [progressMap, setProgressMap] = useState({});
  const [launchProgressMap, setLaunchProgressMap] = useState({});
  const [updateProgressMap, setUpdateProgressMap] = useState({});
  const [toasts, setToasts] = useState([]);
  const [activeTab, setActiveTab] = useState('library');
  const [storeSearch, setStoreSearch] = useState('');
  const [storeCategory, setStoreCategory] = useState('All categories');
  const [settingsToolId, setSettingsToolId] = useState(null);
  const [cleanupPreview, setCleanupPreview] = useState(null);
  const [storageDraft, setStorageDraft] = useState('');
  const [closeBehaviorDraft, setCloseBehaviorDraft] = useState('tray');
  const [ollamaChatOpen, setOllamaChatOpen] = useState(false);
  const [ollamaModels, setOllamaModels] = useState([]);
  const [ollamaSelectedModel, setOllamaSelectedModel] = useState('');
  const [ollamaMessages, setOllamaMessages] = useState([]);
  const [ollamaDraft, setOllamaDraft] = useState('');
  const [ollamaNotice, setOllamaNotice] = useState('');
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [ollamaChatBusy, setOllamaChatBusy] = useState(false);
  const [whisperPanelOpen, setWhisperPanelOpen] = useState(false);
  const [whisperBusy, setWhisperBusy] = useState(false);
  const [whisperFilePath, setWhisperFilePath] = useState('');
  const [whisperModelName, setWhisperModelName] = useState('base');
  const [whisperTranscript, setWhisperTranscript] = useState('');
  const [whisperSegments, setWhisperSegments] = useState([]);
  const [whisperNotice, setWhisperNotice] = useState('');
  const [aiderPanelOpen, setAiderPanelOpen] = useState(false);
  const [aiderBusy, setAiderBusy] = useState(false);
  const [aiderDraft, setAiderDraft] = useState('');
  const [aiderNotice, setAiderNotice] = useState('');
  const [aiderOutput, setAiderOutput] = useState('');
  const [aiderProjectDir, setAiderProjectDir] = useState('');
  const [statisticsData, setStatisticsData] = useState(null);
  const [statisticsManualBusy, setStatisticsManualBusy] = useState(false);
  const statisticsRefreshInFlightRef = useRef(false);
  const [cloudChatProviderId, setCloudChatProviderId] = useState('');
  const [cloudModels, setCloudModels] = useState([]);
  const [cloudSelectedModel, setCloudSelectedModel] = useState('');
  const [cloudMessages, setCloudMessages] = useState([]);
  const [cloudDraft, setCloudDraft] = useState('');
  const [cloudNotice, setCloudNotice] = useState('');
  const [cloudModelsLoading, setCloudModelsLoading] = useState(false);
  const [cloudChatBusy, setCloudChatBusy] = useState(false);
  const [providerKeyDrafts, setProviderKeyDrafts] = useState({});
  const [toolUpdateToastCount, setToolUpdateToastCount] = useState(0);
  const [liveResources, setLiveResources] = useState(null);
  const [windowActivity, setWindowActivity] = useState({
    focused: true,
    visible: true,
  });
  const liveResourcesRef = useRef(null);
  const lastDiskRefreshAtRef = useRef(0);

  const applyLiveResources = useCallback((nextResources, options = {}) => {
    if (!nextResources) {
      liveResourcesRef.current = null;
      setLiveResources(null);
      if (!options.preserveDisk) {
        lastDiskRefreshAtRef.current = 0;
      }
      return;
    }

    setLiveResources((current) => {
      const previousResources = current || liveResourcesRef.current;
      const mergedResources =
        options.preserveDisk && previousResources
          ? {
              ...nextResources,
              diskFreeBytes: previousResources.diskFreeBytes ?? null,
              diskMount: previousResources.diskMount ?? null,
              diskTotalBytes: previousResources.diskTotalBytes ?? null,
              diskUsePercent: previousResources.diskUsePercent ?? null,
              diskUsedBytes: previousResources.diskUsedBytes ?? null,
            }
          : nextResources;

      liveResourcesRef.current = mergedResources;
      if (!options.preserveDisk) {
        lastDiskRefreshAtRef.current = Date.now();
      }
      return mergedResources;
    });
  }, []);

  const applyStatePayload = useCallback(
    (payload) => {
      if (!payload?.hardware && !Array.isArray(payload?.tools)) {
        return;
      }

      setAppState(payload);
      if (Object.prototype.hasOwnProperty.call(payload, 'resources')) {
        applyLiveResources(payload.resources || null);
      }
    },
    [applyLiveResources],
  );

  const manifestMap = useMemo(
    () => Object.fromEntries((appState.manifests || []).map((manifest) => [manifest.id, manifest])),
    [appState.manifests],
  );

  const tools = useMemo(
    () =>
      (appState.tools || []).map((tool) => ({
        ...manifestMap[tool.id],
        ...tool,
      })),
    [appState.tools, manifestMap],
  );

  const toolMap = useMemo(() => Object.fromEntries(tools.map((tool) => [tool.id, tool])), [tools]);
  const ollamaTool = toolMap.ollama || null;
  const whisperTool = toolMap.whisper || null;
  const aiderTool = toolMap.aider || null;
  const providers = useMemo(() => appState.providers || [], [appState.providers]);
  const providerMap = useMemo(() => Object.fromEntries(providers.map((provider) => [provider.id, provider])), [providers]);
  const connectedProviders = useMemo(() => providers.filter((provider) => provider.isConnected), [providers]);
  const toolUpdateSummary = useMemo(
    () =>
      appState.toolUpdates || {
        availableCount: 0,
        entries: [],
        lastCheckedAt: null,
      },
    [appState.toolUpdates],
  );
  const toolUpdateMap = useMemo(
    () => Object.fromEntries((toolUpdateSummary.entries || []).map((entry) => [entry.toolId, entry])),
    [toolUpdateSummary.entries],
  );
  const activeCloudProvider = cloudChatProviderId ? providerMap[cloudChatProviderId] || null : null;
  const currentResources = liveResources || appState.resources;
  const modelManagerCount = Number(appState.downloadedModelCount || 0);
  const libraryCount = tools.length + connectedProviders.length;

  const storeCategories = useMemo(() => {
    const values = [...new Set((appState.manifests || []).map((manifest) => manifest.category).filter(Boolean))];
    return ['All categories', ...values.sort((left, right) => left.localeCompare(right))];
  }, [appState.manifests]);

  const availableStoreTools = useMemo(() => {
    const installedToolIds = new Set(tools.map((tool) => tool.id));
    return (appState.manifests || []).filter((manifest) => !installedToolIds.has(manifest.id));
  }, [appState.manifests, tools]);

  const storeTools = useMemo(() => {
    return availableStoreTools.filter((manifest) => {
      if (storeCategory !== 'All categories' && manifest.category !== storeCategory) {
        return false;
      }

      if (storeSearch.trim() && !toolSearchText(manifest).includes(storeSearch.trim().toLowerCase())) {
        return false;
      }

      return true;
    });
  }, [availableStoreTools, storeCategory, storeSearch]);

  const runningCount = useMemo(() => tools.filter((tool) => tool.status === 'running').length, [tools]);
  const runningUsageLabel = useMemo(
    () => formatUsage(currentResources?.vramUsedMb, currentResources?.vramTotalMb),
    [currentResources?.vramTotalMb, currentResources?.vramUsedMb],
  );

  function dismissToast(id) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function clearProgress(toolId) {
    if (!toolId) {
      return;
    }

    setProgressMap((current) => {
      const next = { ...current };
      delete next[toolId];
      return next;
    });
  }

  function clearLaunchProgress(toolId) {
    if (!toolId) {
      return;
    }

    setLaunchProgressMap((current) => {
      const next = { ...current };
      delete next[toolId];
      return next;
    });
  }

  function clearUpdateProgress(toolId) {
    if (!toolId) {
      return;
    }

    setUpdateProgressMap((current) => {
      const next = { ...current };
      delete next[toolId];
      return next;
    });
  }

  function resetCloudChat() {
    setCloudChatProviderId('');
    setCloudModels([]);
    setCloudSelectedModel('');
    setCloudMessages([]);
    setCloudDraft('');
    setCloudNotice('');
    setCloudModelsLoading(false);
    setCloudChatBusy(false);
  }

  function toolIdFromActionKey(key) {
    if (!key || !key.includes(':')) {
      return null;
    }

    return key.split(':').slice(1).join(':');
  }

  function pushToast(message, tone = 'success', options = {}) {
    const id = options.id || `${Date.now()}-${Math.random()}`;
    setToasts((current) => {
      const nextToast = {
        id,
        message,
        tone,
        actionLabel: options.actionLabel,
        onAction: options.onAction,
        persistent: Boolean(options.persistent),
        tag: options.tag || null,
      };

      const filtered = options.tag ? current.filter((toast) => toast.tag !== options.tag) : current;
      return [...filtered, nextToast];
    });

    if (tone === 'error' || options.persistent || options.actionLabel) {
      return;
    }

    window.setTimeout(() => {
      dismissToast(id);
    }, 6000);
  }

  function openEmbeddedToolUi(toolId) {
    setActiveTab('library');
    resetCloudChat();

    if (toolId === 'ollama') {
      setAiderPanelOpen(false);
      setWhisperPanelOpen(false);
      setOllamaChatOpen(true);
      setOllamaMessages((current) =>
        current.length
          ? current
          : [
              {
                role: 'assistant',
                content: 'Ollama is ready. Choose a local model and start chatting.',
              },
            ],
      );
      return;
    }

    if (toolId === 'whisper') {
      setAiderPanelOpen(false);
      setOllamaChatOpen(false);
      setWhisperPanelOpen(true);
      setWhisperNotice((current) => current || 'Choose an audio file and start transcription.');
      return;
    }

    if (toolId === 'aider') {
      setOllamaChatOpen(false);
      setWhisperPanelOpen(false);
      setAiderPanelOpen(true);
      setAiderNotice((current) => current || 'Choose a project folder and launch Aider to start coding.');
    }
  }

  async function loadOllamaModels(options = {}) {
    if (!ollamaTool) {
      return;
    }

    setOllamaModelsLoading(true);
    const result = await window.localAIHub.listOllamaModels();

    if (!result?.ok) {
      const message = result?.message || 'Local AI Hub could not load your local Ollama models.';
      setOllamaNotice(message);
      setOllamaModels([]);
      setOllamaSelectedModel('');
      if (!options.silent) {
        pushToast(message, 'error');
      }
      setOllamaModelsLoading(false);
      return;
    }

    const models = result.data?.models || [];
    setOllamaModels(models);
    setOllamaSelectedModel((current) =>
      current && models.some((model) => model.name === current) ? current : models[0]?.name || '',
    );
    setOllamaNotice(
      models.length
        ? `Connected to ${result.data?.baseUrl || ollamaTool.launchUrl || 'http://127.0.0.1:11434'}.`
        : 'Ollama is running, but no local models are installed yet. Pull a model with "ollama pull <model>" and then refresh models.',
    );
    setOllamaModelsLoading(false);
  }

  async function sendOllamaMessage() {
    const trimmedDraft = ollamaDraft.trim();
    if (!trimmedDraft) {
      return;
    }

    if (!ollamaSelectedModel) {
      pushToast('Choose an Ollama model before sending a message.', 'error');
      return;
    }

    const userMessage = {
      role: 'user',
      content: trimmedDraft,
    };

    const nextMessages = [...ollamaMessages, userMessage];
    setOllamaMessages(nextMessages);
    setOllamaDraft('');
    setOllamaChatBusy(true);

    const result = await window.localAIHub.chatWithOllama({
      model: ollamaSelectedModel,
      messages: nextMessages,
    });

    if (!result?.ok) {
      const message = result?.message || 'Local AI Hub could not get a reply from Ollama.';
      pushToast(message, 'error');
      setOllamaMessages((current) => [...current, { role: 'assistant', content: message }]);
      setOllamaChatBusy(false);
      return;
    }

    setOllamaMessages((current) => [
      ...current,
      result.data?.message || { role: 'assistant', content: 'Ollama returned an empty reply.' },
    ]);
    setOllamaNotice(`Connected to ${ollamaTool?.launchUrl || 'http://127.0.0.1:11434'}.`);
    setOllamaChatBusy(false);
  }

  async function chooseWhisperAudioFile() {
    const result = await window.localAIHub.pickWhisperAudioFile();
    if (!result?.ok) {
      pushToast(result?.message || 'Local AI Hub could not open the audio picker.', 'error');
      return;
    }

    if (!result.data?.canceled && result.data?.filePath) {
      setWhisperFilePath(result.data.filePath);
      setWhisperNotice(`Ready to transcribe ${result.data.filePath.split(/[\\/]/).pop()}.`);
    }
  }

  async function transcribeWhisperAudio() {
    if (!whisperFilePath) {
      pushToast('Choose an audio file before starting transcription.', 'error');
      return;
    }

    setWhisperBusy(true);
    const result = await window.localAIHub.transcribeWithWhisper({
      audioPath: whisperFilePath,
      model: whisperModelName,
    });

    if (!result?.ok) {
      pushToast(result?.message || 'Local AI Hub could not transcribe that audio file.', 'error');
      setWhisperBusy(false);
      return;
    }

    setWhisperTranscript(result.data?.text || '');
    setWhisperSegments(result.data?.segments || []);
    setWhisperNotice(
      result.data?.language
        ? `Transcription finished. Detected language: ${result.data.language}.`
        : 'Transcription finished.',
    );
    pushToast('Whisper finished transcribing the selected file.', 'success');
    setWhisperBusy(false);
  }

  async function loadAiderRuntimeOutput(options = {}) {
    if (!aiderTool) {
      return;
    }

    const result = await window.localAIHub.getToolRuntimeOutput(aiderTool.id);
    if (!result?.ok) {
      if (!options.silent) {
        pushToast(result?.message || 'Local AI Hub could not load the Aider console.', 'error');
      }
      return;
    }

    setAiderOutput(combineRuntimeOutput(result.data));
  }

  async function chooseAiderProjectFolder() {
    const result = await window.localAIHub.pickAiderProjectFolder();
    if (!result?.ok) {
      pushToast(result?.message || 'Local AI Hub could not open the project folder picker.', 'error');
      return;
    }

    if (!result.data?.canceled && result.data?.folderPath) {
      setAiderProjectDir(result.data.folderPath);
      setAiderNotice(`Aider will start in ${result.data.folderPath}.`);
    }
  }

  async function launchAiderTool() {
    if (!aiderProjectDir) {
      pushToast('Choose a project folder before launching Aider.', 'error');
      return;
    }

    setAiderOutput('');
    const launched = await runAction('launch:aider', () =>
      window.localAIHub.launchTool({ toolId: 'aider', projectDir: aiderProjectDir }),
    );
    if (!launched) {
      return;
    }

    setAiderNotice(`Aider is running in ${aiderProjectDir}.`);
    await loadAiderRuntimeOutput({ silent: true });
  }

  async function sendAiderInput() {
    const message = aiderDraft.trim();
    if (!message) {
      return;
    }

    if (aiderTool?.status !== 'running') {
      pushToast('Launch Aider before sending it a command.', 'error');
      return;
    }

    setAiderBusy(true);
    setAiderOutput((current) => trimConsoleOutput(`${current}${current ? '\n' : ''}> ${message}\n`));

    const result = await window.localAIHub.sendToolInput({
      toolId: 'aider',
      input: message,
    });

    if (!result?.ok) {
      pushToast(result?.message || 'Local AI Hub could not send that input to Aider.', 'error');
      setAiderBusy(false);
      return;
    }

    setAiderDraft('');
    setAiderNotice(`Sent a command to ${aiderTool?.name || 'Aider'}.`);
    setAiderBusy(false);
  }

  async function loadStatistics(options = {}) {
    const manual = Boolean(options.manual);
    const silent = Boolean(options.silent);

    if (statisticsRefreshInFlightRef.current) {
      return false;
    }

    statisticsRefreshInFlightRef.current = true;
    if (manual) {
      setStatisticsManualBusy(true);
    }

    try {
      const result = await window.localAIHub.getStatistics();
      if (!result?.ok) {
        if (!silent) {
          pushToast(result?.message || 'Local AI Hub could not load the statistics screen right now.', 'error');
        }
        return false;
      }

      setStatisticsData(result.data);
      return true;
    } catch (error) {
      if (!silent) {
        pushToast(error?.message || 'Local AI Hub could not load the statistics screen right now.', 'error');
      }
      return false;
    } finally {
      statisticsRefreshInFlightRef.current = false;
      if (manual) {
        setStatisticsManualBusy(false);
      }
    }
  }

  function changeProviderDraft(providerId, value) {
    setProviderKeyDrafts((current) => ({
      ...current,
      [providerId]: value,
    }));
  }

  async function saveProviderKey(providerId) {
    const apiKey = String(providerKeyDrafts[providerId] || '').trim();
    if (!apiKey) {
      pushToast('Paste an API key before saving this connection.', 'error');
      return;
    }

    const saved = await runAction(`provider-save:${providerId}`, () =>
      window.localAIHub.saveProviderKey({ providerId, apiKey }),
    );
    if (saved) {
      setProviderKeyDrafts((current) => ({
        ...current,
        [providerId]: '',
      }));
    }
  }

  async function testProvider(providerId) {
    markBusy(`provider-test:${providerId}`, true);
    try {
      const result = await window.localAIHub.testProviderConnection(providerId);
      applyStateResponse(result);
      if (cloudChatProviderId === providerId) {
        await loadCloudModels({ providerId, silent: true });
      }
    } catch (error) {
      pushToast(error.message || 'Local AI Hub could not test that cloud provider connection.', 'error');
    } finally {
      markBusy(`provider-test:${providerId}`, false);
    }
  }

  async function disconnectProviderConnection(providerId) {
    const disconnected = await runAction(`provider-disconnect:${providerId}`, () =>
      window.localAIHub.disconnectProvider(providerId),
    );
    if (disconnected && cloudChatProviderId === providerId) {
      resetCloudChat();
    }
  }

  async function loadCloudModels(options = {}) {
    const providerId = options.providerId || cloudChatProviderId;
    if (!providerId) {
      return;
    }

    markBusy(`provider-models:${providerId}`, true);
    setCloudModelsLoading(true);
    const result = await window.localAIHub.listProviderModels(providerId);

    if (!result?.ok) {
      const message = result?.message || 'Local AI Hub could not load models for that cloud provider.';
      setCloudNotice(message);
      setCloudModels([]);
      setCloudSelectedModel('');
      if (!options.silent) {
        pushToast(message, 'error');
      }
      setCloudModelsLoading(false);
      markBusy(`provider-models:${providerId}`, false);
      return;
    }

    setCloudModels(result.data?.models || []);
    setCloudSelectedModel(result.data?.selectedModel || result.data?.models?.[0]?.id || '');
    setCloudNotice(`Connected to ${providerMap[providerId]?.name || 'this provider'}.`);
    setCloudModelsLoading(false);
    markBusy(`provider-models:${providerId}`, false);
  }

  async function openCloudProviderChat(providerId) {
    setActiveTab('library');
    setOllamaChatOpen(false);
    setWhisperPanelOpen(false);
    setAiderPanelOpen(false);
    setCloudChatProviderId(providerId);
    setCloudDraft('');
    setCloudMessages([
      {
        role: 'assistant',
        content: `This conversation is processed by ${providerMap[providerId]?.name || 'this provider'} and leaves your machine.`,
      },
    ]);
    await loadCloudModels({ providerId, silent: false });
  }

  async function sendCloudMessage() {
    const trimmedDraft = cloudDraft.trim();
    if (!trimmedDraft || !cloudChatProviderId) {
      return;
    }

    if (!cloudSelectedModel) {
      pushToast('Choose a cloud model before sending a message.', 'error');
      return;
    }

    const userMessage = {
      role: 'user',
      content: trimmedDraft,
    };
    const nextMessages = [...cloudMessages, userMessage];
    setCloudMessages(nextMessages);
    setCloudDraft('');
    setCloudChatBusy(true);

    const result = await window.localAIHub.chatWithProvider({
      providerId: cloudChatProviderId,
      model: cloudSelectedModel,
      messages: nextMessages,
    });

    if (!result?.ok) {
      const message = result?.message || 'Local AI Hub could not send that cloud provider message.';
      pushToast(message, 'error');
      setCloudMessages((current) => [...current, { role: 'assistant', content: message }]);
      setCloudChatBusy(false);
      return;
    }

    setCloudMessages((current) => [
      ...current,
      result.data?.message || { role: 'assistant', content: 'The provider returned an empty reply.' },
    ]);
    setCloudNotice(`Connected to ${providerMap[cloudChatProviderId]?.name || 'this provider'}.`);
    setCloudChatBusy(false);
  }

  function patchToolState(payload) {
    if (!payload?.toolId) {
      return;
    }

    setAppState((current) => ({
      ...current,
      tools: (current.tools || []).map((tool) =>
        tool.id === payload.toolId
          ? {
              ...tool,
              ...(payload.status ? { status: payload.status } : {}),
              ...(Object.prototype.hasOwnProperty.call(payload, 'lastError') ? { lastError: payload.lastError } : {}),
            }
          : tool,
      ),
    }));
  }

  async function updateLibraryTool(toolId) {
    await runAction(`update:${toolId}`, () => window.localAIHub.updateTool({ toolId }));
  }

  async function uninstallLibraryTool(tool) {
    if (!tool?.id) {
      return;
    }

    const confirmationMessage =
      tool.source === 'managed'
        ? `Uninstall ${tool.name} from Local AI Hub? This will delete its managed files from ${tool.installDir} and move it back to Store.`
        : `Remove ${tool.name} from Local AI Hub? Its files will stay on this PC because Local AI Hub did not install them.`;

    if (!window.confirm(confirmationMessage)) {
      return;
    }

    if (settingsToolId === tool.id) {
      setSettingsToolId(null);
    }

    await runAction(`uninstall:${tool.id}`, () => window.localAIHub.uninstallTool(tool.id));
  }

  async function chooseStorageFolder() {
    markBusy('settings:pick-folder', true);
    try {
      const result = await window.localAIHub.pickStorageFolder();
      if (!result?.ok) {
        pushToast(result?.message || 'Local AI Hub could not open the storage folder picker.', 'error');
        return;
      }

      if (!result.data?.canceled && result.data?.folderPath) {
        setStorageDraft(result.data.folderPath);
      }
    } finally {
      markBusy('settings:pick-folder', false);
    }
  }

  async function saveStorageLocation(options = {}) {
    const targetPath = String(options.targetPath || storageDraft || '').trim();
    if (!targetPath) {
      pushToast('Choose a storage folder before saving the new location.', 'error');
      return;
    }

    let migrateExistingData = false;
    let migrationSourceRoot = options.migrationSourceRoot || null;
    if (!migrationSourceRoot && appState.managedDataPath && targetPath !== appState.managedDataPath) {
      const managedToolCount = tools.filter((tool) => tool.source === 'managed').length;
      if (managedToolCount > 0) {
        migrateExistingData = window.confirm(
          `Move your existing managed Local AI Hub files from ${appState.managedDataPath} into ${targetPath} now? Click OK to move them, or Cancel to keep the current files where they are and use the new folder for future installs.`,
        );
      }
    }

    const saved = await runAction('settings:save-storage', () =>
      window.localAIHub.setStorageLocation({
        targetPath,
        migrateExistingData,
        migrationSourceRoot,
      }),
    );
    if (saved) {
      setCleanupPreview(null);
    }
  }
  async function saveCloseBehaviorPreference() {
    await runAction('settings:save-close-behavior', () => window.localAIHub.saveCloseBehavior(closeBehaviorDraft));
  }

  async function migrateLegacyStorage() {
    const migration = appState.storage?.legacyMigration;
    if (!migration?.available) {
      return;
    }

    const confirmed = window.confirm(
      `Move about ${formatBytes(migration.totalBytes)} from ${migration.sourceRoot} into ${migration.targetRoot}? Local AI Hub will keep your tracked tools attached and move the managed files into one stable storage location for future repairs and upgrades.`,
    );
    if (!confirmed) {
      return;
    }

    const migrated = await runAction('settings:migrate-legacy', () =>
      window.localAIHub.setStorageLocation({
        targetPath: migration.targetRoot,
        migrationSourceRoot: migration.sourceRoot,
      }),
    );
    if (migrated) {
      setCleanupPreview(null);
    }
  }

  async function dismissLegacyMigration() {
    const sourceRoot = appState.storage?.legacyMigration?.sourceRoot;
    if (!sourceRoot) {
      return;
    }

    await runAction('settings:dismiss-migration', () => window.localAIHub.dismissLegacyMigration(sourceRoot));
  }

  async function previewCleanup(options = {}) {
    markBusy('settings:preview-cleanup', true);
    try {
      const result = await window.localAIHub.getCleanupPreview();
      if (!result?.ok) {
        if (!options.silent) {
          pushToast(result?.message || 'Local AI Hub could not scan the approved cleanup folders right now.', 'error');
        }
        return null;
      }

      setCleanupPreview(result.data);
      return result.data;
    } finally {
      markBusy('settings:preview-cleanup', false);
    }
  }

  async function runCleanupNow() {
    const preview = cleanupPreview || (await previewCleanup({ silent: true }));
    if (!preview?.totalEntries) {
      pushToast('Local AI Hub did not find approved leftover files to delete.', 'success');
      return;
    }

    const confirmed = window.confirm(
      `Delete ${preview.totalEntries} leftover item${preview.totalEntries === 1 ? '' : 's'} and recover about ${formatBytes(preview.totalBytes)}? Local AI Hub will only remove the exact paths shown in the cleanup preview.`,
    );
    if (!confirmed) {
      return;
    }

    const cleaned = await runAction('settings:run-cleanup', () => window.localAIHub.runCleanup());
    if (cleaned) {
      setCleanupPreview(null);
      await previewCleanup({ silent: true });
    }
  }

  function applyStateResponse(result) {
    if (!result?.ok) {
      throw new Error(result?.message || 'Local AI Hub could not complete that action.');
    }

    const payload = result.data?.state || result.data;
    applyStatePayload(payload);

    if (result.data?.message) {
      pushToast(result.data.message, 'success');
    }
  }

  async function loadState() {
    const result = await window.localAIHub.bootstrap();
    if (!result?.ok) {
      pushToast(result?.message || 'Local AI Hub could not load the dashboard.', 'error');
      setIsLoading(false);
      return;
    }

    applyStatePayload(result.data);
    setIsLoading(false);
  }

  function markBusy(key, value) {
    setBusyMap((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function runAction(key, operation) {
    const toolId = toolIdFromActionKey(key);
    let succeeded = false;
    markBusy(key, true);
    try {
      const result = await operation();
      applyStateResponse(result);
      succeeded = true;
    } catch (error) {
      if (key.startsWith('install:') || key.startsWith('repair:')) {
        clearProgress(toolId);
      }

      if (key.startsWith('launch:')) {
        clearLaunchProgress(toolId);
      }

      if (key.startsWith('update:')) {
        clearUpdateProgress(toolId);
      }

      const baseMessage = error.message || 'Local AI Hub could not complete that action.';
      const helpMessage =
        (key.startsWith('install:') || key.startsWith('repair:') || key.startsWith('update:')) && appState.logsPath
          ? `${baseMessage} Open the logs folder for the full installer log.`
          : baseMessage;
      pushToast(helpMessage, 'error');
    } finally {
      if (key.startsWith('stop:') || key.startsWith('uninstall:')) {
        clearLaunchProgress(toolId);
      }

      if (key.startsWith('stop:') && toolId === 'ollama') {
        setOllamaNotice('Ollama stopped. Launch it again to continue chatting.');
      }

      if (key.startsWith('stop:') && toolId === 'whisper') {
        setWhisperNotice('Whisper stopped. Launch it again to continue transcribing.');
      }

      if (key.startsWith('stop:') && toolId === 'aider') {
        setAiderNotice('Aider stopped. Launch it again to continue coding.');
      }

      markBusy(key, false);
    }

    return succeeded;
  }

  async function installStoreTool(toolId) {
    const manifest = manifestMap[toolId];
    const subject = manifest?.name || 'This tool';
    const preflightResult = await window.localAIHub.getToolInstallPreflight(toolId);
    if (!preflightResult?.ok) {
      pushToast(preflightResult?.message || 'Local AI Hub could not check disk space for that install.', 'error');
      return;
    }

    const preflight = preflightResult.data;
    if (preflight?.blocked) {
      pushToast(buildBlockedDiskMessage(subject, preflight), 'error');
      return;
    }

    let lowDiskConfirmed = false;
    if (preflight?.requiresConfirmation) {
      lowDiskConfirmed = window.confirm(buildLowDiskConfirmationMessage(subject, preflight));
      if (!lowDiskConfirmed) {
        return;
      }
    }

    await runAction(`install:${toolId}`, () => window.localAIHub.installTool({ toolId, lowDiskConfirmed }));
  }

  async function repairLibraryTool(tool) {
    if (!tool?.id) {
      return;
    }

    const previewResult = await window.localAIHub.getRepairPreview(tool.id);
    if (!previewResult?.ok) {
      pushToast(previewResult?.message || 'Local AI Hub could not inspect that repair right now.', 'error');
      return;
    }

    const preview = previewResult.data || {};
    let removeOrphanedToolFolders = false;
    if (preview.orphanedToolFolderCount > 0) {
      const automaticCleanup = [];
      if (preview.duplicateFolderCount > 0) {
        automaticCleanup.push(`${preview.duplicateFolderCount} duplicate ${pluralizeLabel(preview.duplicateFolderCount, 'install folder')}`);
      }
      if (preview.temporaryArtifactCount > 0) {
        automaticCleanup.push(`${preview.temporaryArtifactCount} leftover ${pluralizeLabel(preview.temporaryArtifactCount, 'download or temp item')}`);
      }

      const automaticMessage = automaticCleanup.length
        ? `Local AI Hub will also clean ${automaticCleanup.join(' and ')} automatically.`
        : 'Local AI Hub did not find duplicate install folders or failed downloads for this repair.';
      const orphanRecovery = preview.orphanedRecoveryBytes > 0 ? formatBytes(preview.orphanedRecoveryBytes) : 'some disk space';
      const orphanMessage = `${automaticMessage} It also found ${preview.orphanedToolFolderCount} orphaned ${pluralizeLabel(preview.orphanedToolFolderCount, 'tool folder')} in Local AI Hub's managed storage roots. Click OK to delete those orphaned folders too and recover about ${orphanRecovery}. Click Cancel to keep them and continue the repair.`;
      removeOrphanedToolFolders = window.confirm(orphanMessage);
    }

    await runAction(`repair:${tool.id}`, () =>
      window.localAIHub.repairTool({ toolId: tool.id, removeOrphanedToolFolders }),
    );
  }

  useEffect(() => {
    loadState();
    window.localAIHub.getWindowActivity().then((result) => {
      if (result?.ok && result.data) {
        setWindowActivity(result.data);
      }
    });

    const unsubscribeInstallProgress = window.localAIHub.onInstallProgress((progress) => {
      if (!progress?.toolId) {
        return;
      }

      setProgressMap((current) => ({
        ...current,
        [progress.toolId]: progress,
      }));

      if (progress.percent >= 100) {
        window.setTimeout(() => {
          clearProgress(progress.toolId);
        }, 2000);
      }
    });

    const unsubscribeOpenToolUi = window.localAIHub.onOpenToolUi((payload) => {
      openEmbeddedToolUi(payload?.toolId);
    });

    const unsubscribeWindowActivity = window.localAIHub.onWindowActivity((payload) => {
      if (payload) {
        setWindowActivity(payload);
      }
    });

    const unsubscribeLaunchProgress = window.localAIHub.onLaunchProgress((progress) => {
      if (!progress?.toolId) {
        return;
      }

      if (!progress.active) {
        clearLaunchProgress(progress.toolId);
        return;
      }

      setLaunchProgressMap((current) => ({
        ...current,
        [progress.toolId]: progress,
      }));
    });

    const unsubscribeRuntimeOutput = window.localAIHub.onRuntimeOutput((payload) => {
      if (payload?.toolId !== 'aider' || !payload.chunk) {
        return;
      }

      setAiderOutput((current) => trimConsoleOutput(`${current}${payload.chunk}`));
    });

    const unsubscribeToolState = window.localAIHub.onToolState((payload) => {
      patchToolState(payload);
    });

    const unsubscribeUnexpectedStop = window.localAIHub.onUnexpectedStop((payload) => {
      if (payload?.status || Object.prototype.hasOwnProperty.call(payload || {}, 'lastError')) {
        patchToolState(payload);
      }

      if (!payload?.toolId) {
        return;
      }

      pushToast(payload.message || `${payload.toolName || 'A tool'} stopped unexpectedly.`, 'error', {
        tag: `unexpected-stop:${payload.toolId}`,
        persistent: true,
        actionLabel: payload.canRelaunch ? 'Relaunch' : 'Open Library',
        onAction: () => {
          setActiveTab('library');
          if (payload.canRelaunch) {
            runAction(`launch:${payload.toolId}`, () => window.localAIHub.launchTool(payload.toolId));
          }
        },
      });
    });

    const unsubscribeToolUpdateSummary = window.localAIHub.onToolUpdateSummary((payload) => {
      setAppState((current) => ({
        ...current,
        toolUpdates: payload || current.toolUpdates,
      }));
    });

    const unsubscribeUpdateProgress = window.localAIHub.onUpdateProgress((progress) => {
      if (!progress?.toolId) {
        return;
      }

      setUpdateProgressMap((current) => ({
        ...current,
        [progress.toolId]: progress,
      }));

      if (progress.percent >= 100) {
        window.setTimeout(() => {
          clearUpdateProgress(progress.toolId);
        }, 2000);
      }
    });

    const unsubscribeUpdateReady = window.localAIHub.onUpdateReady((payload) => {
      pushToast(payload?.message || 'An update is ready. Restart Local AI Hub to install.', 'success', {
        tag: 'update-ready',
        persistent: true,
        actionLabel: 'Restart Now',
        onAction: async () => {
          const result = await window.localAIHub.restartToUpdate();
          if (!result?.ok) {
            pushToast(result?.message || 'Local AI Hub could not restart to install the update.', 'error');
          }
        },
      });
    });

    return () => {
      unsubscribeInstallProgress();
      unsubscribeOpenToolUi();
      unsubscribeWindowActivity();
      unsubscribeLaunchProgress();
      unsubscribeRuntimeOutput();
      unsubscribeToolState();
      unsubscribeUnexpectedStop();
      unsubscribeToolUpdateSummary();
      unsubscribeUpdateProgress();
      unsubscribeUpdateReady();
    };
  }, []);

  useEffect(() => {
    if (!appState.manifestStatus?.warning) {
      dismissToast('manifest-status');
      return;
    }

    pushToast(appState.manifestStatus.warning, 'error', {
      id: 'manifest-status',
      persistent: true,
      tag: 'manifest-status',
    });
  }, [appState.manifestStatus?.warning]);

  useEffect(() => {
    if (!appState.providerManifestStatus?.warning) {
      dismissToast('provider-manifest-status');
      return;
    }

    pushToast(appState.providerManifestStatus.warning, 'error', {
      id: 'provider-manifest-status',
      persistent: true,
      tag: 'provider-manifest-status',
    });
  }, [appState.providerManifestStatus?.warning]);

  useEffect(() => {
    const migration = appState.storage?.legacyMigration;
    if (!migration?.available || migration.dismissed) {
      dismissToast('legacy-migration');
      return;
    }

    pushToast(
      `Local AI Hub found about ${formatBytes(migration.totalBytes)} in older managed files at ${migration.sourceRoot}. Open Settings to move them off your system drive.`,
      'success',
      {
        id: 'legacy-migration',
        persistent: true,
        tag: 'legacy-migration',
        actionLabel: 'Open Settings',
        onAction: () => setActiveTab('settings'),
      },
    );
  }, [
    appState.storage?.legacyMigration?.available,
    appState.storage?.legacyMigration?.dismissed,
    appState.storage?.legacyMigration?.sourceRoot,
    appState.storage?.legacyMigration?.totalBytes,
  ]);

  useEffect(() => {
    const updateCount = Number(toolUpdateSummary.availableCount || 0);
    if (!updateCount) {
      dismissToast('tool-updates');
      if (toolUpdateToastCount !== 0) {
        setToolUpdateToastCount(0);
      }
      return;
    }

    if (toolUpdateToastCount === updateCount) {
      return;
    }

    setToolUpdateToastCount(updateCount);
    pushToast(`Updates available for ${updateCount} ${pluralizeLabel(updateCount, 'tool')}.`, 'success', {
      id: 'tool-updates',
      persistent: true,
      tag: 'tool-updates',
      actionLabel: 'View updates',
      onAction: () => setActiveTab('library'),
    });
  }, [toolUpdateSummary.availableCount, toolUpdateToastCount]);

  useEffect(() => {
    if (!ollamaTool) {
      setOllamaChatOpen(false);
      setOllamaModels([]);
      setOllamaSelectedModel('');
      return;
    }

    if (ollamaChatOpen && ollamaTool.status === 'running') {
      loadOllamaModels({ silent: true });
    }
  }, [ollamaChatOpen, ollamaTool?.status]);

  useEffect(() => {
    if (!whisperTool) {
      setWhisperPanelOpen(false);
      setWhisperFilePath('');
      setWhisperTranscript('');
      setWhisperSegments([]);
      return;
    }

    if (!whisperPanelOpen) {
      return;
    }

    if (whisperTool.status === 'running') {
      setWhisperNotice((current) => current || 'Choose an audio file and start transcription.');
      return;
    }

    setWhisperNotice('Launch Whisper to enable the built-in transcription tools.');
  }, [whisperPanelOpen, whisperTool?.status]);

  useEffect(() => {
    if (!aiderTool) {
      setAiderPanelOpen(false);
      setAiderDraft('');
      setAiderOutput('');
      setAiderProjectDir('');
      return;
    }

    setAiderProjectDir((current) => current || aiderTool.lastProjectDir || '');

    if (!aiderPanelOpen) {
      return;
    }

    if (aiderTool.status === 'running') {
      setAiderNotice((current) =>
        current || `Aider is running in ${aiderProjectDir || aiderTool.lastProjectDir || 'the selected project folder'}.`,
      );
      loadAiderRuntimeOutput({ silent: true });
      return;
    }

    setAiderNotice((current) => current || 'Choose a project folder and launch Aider to start coding.');
  }, [aiderPanelOpen, aiderTool?.status, aiderTool?.lastProjectDir, aiderProjectDir]);

  useEffect(() => {
    setStorageDraft(appState.storage?.managedRoot || '');
  }, [appState.storage?.managedRoot]);

  useEffect(() => {
    setCloseBehaviorDraft(appState.settings?.closeBehavior || 'tray');
  }, [appState.settings?.closeBehavior]);

  useEffect(() => {
    if (activeTab !== 'settings' || cleanupPreview) {
      return;
    }

    previewCleanup({ silent: true });
  }, [activeTab, cleanupPreview]);

  useEffect(() => {
    let cancelled = false;
    let timerId = null;
    const pollIntervalMs = windowActivity.focused && windowActivity.visible
      ? FOCUSED_RESOURCE_REFRESH_INTERVAL_MS
      : UNFOCUSED_RESOURCE_REFRESH_INTERVAL_MS;

    const pollResources = async () => {
      const shouldIncludeDisk =
        windowActivity.focused &&
        windowActivity.visible &&
        (Date.now() - lastDiskRefreshAtRef.current >= DISK_RESOURCE_REFRESH_INTERVAL_MS || !liveResourcesRef.current?.diskMount);
      const result = await window.localAIHub.getLiveResources({ includeDisk: shouldIncludeDisk });
      if (!cancelled && result?.ok && result.data) {
        applyLiveResources(result.data, {
          preserveDisk: !shouldIncludeDisk,
        });
      }

      if (!cancelled) {
        timerId = window.setTimeout(pollResources, pollIntervalMs);
      }
    };

    pollResources();

    return () => {
      cancelled = true;
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [applyLiveResources, windowActivity.focused, windowActivity.visible]);

  useEffect(() => {
    if (activeTab !== 'statistics' || !windowActivity.focused || !windowActivity.visible) {
      return;
    }

    loadStatistics({ silent: true });
  }, [activeTab, windowActivity.focused, windowActivity.visible]);

  useEffect(() => {
    if (!cloudChatProviderId) {
      return;
    }

    if (activeCloudProvider?.isConnected) {
      return;
    }

    resetCloudChat();
  }, [cloudChatProviderId, activeCloudProvider?.isConnected]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-shell text-white">
        <div className="panel px-8 py-6 text-lg font-medium">Loading Local AI Hub...</div>
      </div>
    );
  }

  if (appState.firstLaunch && appState.hardware) {
    return (
      <HardwareGate
        busy={busyMap['first-launch']}
        hardware={appState.hardware}
        onContinue={() => runAction('first-launch', () => window.localAIHub.completeFirstLaunch())}
      />
    );
  }

  return (
    <div className="min-h-screen bg-shell px-5 py-5 text-white lg:px-6">
      <div className="mx-auto grid max-w-[1600px] gap-5 xl:grid-cols-[280px,1fr]">
        <Sidebar
          activeTab={activeTab}
          hardware={appState.hardware}
          installedCount={libraryCount}
          logsBusy={busyMap['open-logs']}
          modelManagerCount={modelManagerCount}
          onChangeTab={setActiveTab}
          onOpenLogs={() => runAction('open-logs', () => window.localAIHub.openLogsFolder())}
          storeCount={availableStoreTools.length}
        />

        <main className="space-y-5">
          <ResourceStrip
            activeTab={activeTab}
            installedCount={libraryCount}
            resources={currentResources}
            runningCount={runningCount}
            storage={appState.storage}
            updateCount={toolUpdateSummary.availableCount || 0}
          />

          {activeTab === 'library' ? (
            <section className="space-y-4">
              <ToolUpdatesPanel busyMap={busyMap} onUpdateTool={updateLibraryTool} summary={toolUpdateSummary} />

              {activeCloudProvider ? (
                <CloudChatPanel
                  busy={busyMap[`provider-models:${cloudChatProviderId}`] || cloudChatBusy}
                  draft={cloudDraft}
                  messages={cloudMessages}
                  models={cloudModels}
                  modelsLoading={cloudModelsLoading}
                  notice={cloudNotice}
                  onChangeDraft={setCloudDraft}
                  onChangeModel={setCloudSelectedModel}
                  onHide={resetCloudChat}
                  onRefreshModels={() => loadCloudModels()}
                  onSend={sendCloudMessage}
                  provider={activeCloudProvider}
                  selectedModel={cloudSelectedModel}
                />
              ) : null}

              {ollamaTool && ollamaChatOpen ? (
                <OllamaChatPanel
                  busy={busyMap['launch:ollama'] || busyMap['stop:ollama'] || ollamaChatBusy}
                  draft={ollamaDraft}
                  messages={ollamaMessages}
                  models={ollamaModels}
                  modelsLoading={ollamaModelsLoading}
                  notice={ollamaNotice}
                  onChangeDraft={setOllamaDraft}
                  onChangeModel={setOllamaSelectedModel}
                  onHide={() => setOllamaChatOpen(false)}
                  onLaunch={(toolId) => runAction(`launch:${toolId}`, () => window.localAIHub.launchTool(toolId))}
                  onRefreshModels={() => loadOllamaModels()}
                  onSend={sendOllamaMessage}
                  onStop={(toolId) => runAction(`stop:${toolId}`, () => window.localAIHub.stopTool(toolId))}
                  selectedModel={ollamaSelectedModel}
                  tool={ollamaTool}
                />
              ) : null}

              {whisperTool && whisperPanelOpen ? (
                <WhisperPanel
                  busy={busyMap['launch:whisper'] || busyMap['stop:whisper'] || whisperBusy}
                  filePath={whisperFilePath}
                  modelName={whisperModelName}
                  notice={whisperNotice}
                  onChangeModel={setWhisperModelName}
                  onChooseFile={chooseWhisperAudioFile}
                  onHide={() => setWhisperPanelOpen(false)}
                  onLaunch={(toolId) => runAction(`launch:${toolId}`, () => window.localAIHub.launchTool(toolId))}
                  onStop={(toolId) => runAction(`stop:${toolId}`, () => window.localAIHub.stopTool(toolId))}
                  onTranscribe={transcribeWhisperAudio}
                  segments={whisperSegments}
                  tool={whisperTool}
                  transcript={whisperTranscript}
                />
              ) : null}

              {aiderTool && aiderPanelOpen ? (
                <AiderPanel
                  busy={busyMap['launch:aider'] || busyMap['stop:aider'] || aiderBusy}
                  draft={aiderDraft}
                  notice={aiderNotice}
                  onChangeDraft={setAiderDraft}
                  onChooseProject={chooseAiderProjectFolder}
                  onHide={() => setAiderPanelOpen(false)}
                  onLaunch={launchAiderTool}
                  onSend={sendAiderInput}
                  onStop={(toolId) => runAction(`stop:${toolId}`, () => window.localAIHub.stopTool(toolId))}
                  output={aiderOutput}
                  projectDir={aiderProjectDir}
                  tool={aiderTool}
                />
              ) : null}

              {connectedProviders.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  busyMap={busyMap}
                  onOpenChat={openCloudProviderChat}
                  onOpenSettings={() => setActiveTab('settings')}
                  provider={provider}
                />
              ))}

              {tools.map((tool) => (
                <LibraryCard
                  key={tool.id}
                  busyMap={busyMap}
                  launchProgress={launchProgressMap[tool.id]}
                  onLaunch={(toolId) => runAction(`launch:${toolId}`, () => window.localAIHub.launchTool(toolId))}
                  onOpenFolder={(toolId) => runAction(`folder:${toolId}`, () => window.localAIHub.openToolFolder(toolId))}
                  onOpenInterface={openEmbeddedToolUi}
                  onRepair={() => repairLibraryTool(tool)}
                  onRestoreSnapshot={(toolId, snapshotFileName) =>
                    runAction(`restore:${toolId}`, () => window.localAIHub.restoreSnapshot({ toolId, snapshotFileName }))
                  }
                  onSaveSnapshot={(toolId) => runAction(`snapshot:${toolId}`, () => window.localAIHub.saveSnapshot(toolId))}
                  onStop={(toolId) => runAction(`stop:${toolId}`, () => window.localAIHub.stopTool(toolId))}
                  onToggleSettings={(toolId) => setSettingsToolId((current) => (current === toolId ? null : toolId))}
                  onUninstall={uninstallLibraryTool}
                  onUpdate={updateLibraryTool}
                  progress={progressMap[tool.id]}
                  runningUsageLabel={runningUsageLabel}
                  settingsOpen={settingsToolId === tool.id}
                  tool={tool}
                  updateInfo={toolUpdateMap[tool.id]}
                  updateProgress={updateProgressMap[tool.id]}
                />
              ))}

              {!libraryCount ? (
                <div className="panel p-10 text-center">
                  <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Library</p>
                  <h3 className="mt-3 text-3xl font-semibold text-white">Your shelf is empty.</h3>
                  <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-slate-300">
                    Switch to Store to install a supported local AI tool, or open Settings to connect a supported cloud provider.
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-3">
                    <button className="primary-button" onClick={() => setActiveTab('store')} type="button">
                      Open Store
                    </button>
                    <button className="ghost-button" onClick={() => setActiveTab('settings')} type="button">
                      Open Settings
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : activeTab === 'store' ? (
            <section className="panel p-6">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Store</p>
                  <h3 className="mt-3 text-3xl font-semibold text-white">Browse tools that Local AI Hub can install for you</h3>
                </div>
                <div className="grid gap-3 md:grid-cols-[1fr,220px]">
                  <input
                    className="store-input"
                    onChange={(event) => setStoreSearch(event.target.value)}
                    placeholder="Search tools"
                    type="search"
                    value={storeSearch}
                  />
                  <select className="store-input" onChange={(event) => setStoreCategory(event.target.value)} value={storeCategory}>
                    {storeCategories.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mt-6 grid gap-4 2xl:grid-cols-2">
                {storeTools.length ? (
                  storeTools.map((manifest) => (
                    <StoreCard
                      key={manifest.id}
                      busy={busyMap[`install:${manifest.id}`]}
                      compatibility={evaluateCompatibility(manifest, appState.hardware)}
                      manifest={manifest}
                      onInstall={(toolId) => installStoreTool(toolId)}
                      progress={progressMap[manifest.id]}
                    />
                  ))
                ) : (
                  <div className="rounded-[28px] border border-dashed border-white/15 bg-white/5 p-10 text-center text-slate-400 2xl:col-span-2">
                    No Store results match that filter. Clear the search or category filter to see the full catalog.
                  </div>
                )}
              </div>
            </section>
          ) : activeTab === 'models' ? (
            <ModelManager onToast={pushToast} tools={tools} />
          ) : activeTab === 'pipelines' ? (
            <PipelineBuilderPanel
              hardware={appState.hardware}
              manifests={appState.manifests}
              onToast={pushToast}
              providers={providers}
              tools={tools}
            />
          ) : activeTab === 'statistics' ? (
            <StatisticsPanel
              busy={statisticsManualBusy}
              data={statisticsData || {}}
              onOpenCleanup={() => setActiveTab('settings')}
              onRefresh={() => loadStatistics({ manual: true })}
            />
          ) : (
            <section className="space-y-5">
              <SettingsPanel
                busyMap={busyMap}
                cleanupPreview={cleanupPreview}
                closeBehaviorDraft={closeBehaviorDraft}
                onChangeCloseBehavior={setCloseBehaviorDraft}
                onChangeStorageDraft={setStorageDraft}
                onChooseStorageFolder={chooseStorageFolder}
                onDismissLegacyMigration={dismissLegacyMigration}
                onMigrateLegacyStorage={migrateLegacyStorage}
                onPreviewCleanup={() => previewCleanup()}
                onRunCleanup={runCleanupNow}
                onSaveCloseBehavior={saveCloseBehaviorPreference}
                onSaveStorageLocation={() => saveStorageLocation()}
                storage={appState.storage}
                storageDraft={storageDraft}
              />
              <ConnectionsPanel
                busyMap={busyMap}
                drafts={providerKeyDrafts}
                onChangeDraft={changeProviderDraft}
                onDisconnect={disconnectProviderConnection}
                onSave={saveProviderKey}
                onTest={testProvider}
                providers={providers}
              />
            </section>
          )}
        </main>
      </div>

      <div className="pointer-events-none fixed right-5 top-5 z-50 space-y-3">
        {toasts.map((toast) => (
          <Toast key={toast.id} onDismiss={dismissToast} toast={toast} />
        ))}
      </div>
    </div>
  );
}
