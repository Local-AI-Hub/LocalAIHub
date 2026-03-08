import { useEffect, useMemo, useState } from 'react';
import HardwareGate from './components/HardwareGate';
import LibraryCard from './components/LibraryCard';
import ModelManager from './components/ModelManager';
import OllamaChatPanel from './components/OllamaChatPanel';
import WhisperPanel from './components/WhisperPanel';
import ResourceStrip from './components/ResourceStrip';
import Sidebar from './components/Sidebar';
import StoreCard from './components/StoreCard';
import { evaluateCompatibility, toolSearchText } from './lib/tool-ui';

const EMPTY_STATE = {
  appDataPath: '',
  downloadedModelCount: 0,
  firstLaunch: false,
  hardware: null,
  logsPath: '',
  manifests: [],
  resources: null,
  tools: [],
};

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
  const [toasts, setToasts] = useState([]);
  const [activeTab, setActiveTab] = useState('library');
  const [storeSearch, setStoreSearch] = useState('');
  const [storeCategory, setStoreCategory] = useState('All categories');
  const [settingsToolId, setSettingsToolId] = useState(null);
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
  const modelManagerCount = Number(appState.downloadedModelCount || 0);

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

  const runningCount = tools.filter((tool) => tool.status === 'running').length;

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

    if (toolId === 'ollama') {
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
      setOllamaChatOpen(false);
      setWhisperPanelOpen(true);
      setWhisperNotice((current) => current || 'Choose an audio file and start transcription.');
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

  function applyStateResponse(result) {
    if (!result?.ok) {
      throw new Error(result?.message || 'Local AI Hub could not complete that action.');
    }

    const payload = result.data?.state || result.data;
    if (payload?.hardware || Array.isArray(payload?.tools)) {
      setAppState(payload);
    }

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

    setAppState(result.data);
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
    markBusy(key, true);
    try {
      const result = await operation();
      applyStateResponse(result);

      if (key.startsWith('launch:') && ['ollama', 'whisper'].includes(toolId)) {
        openEmbeddedToolUi(toolId);
      }

      if (key.startsWith('stop:') && toolId === 'ollama') {
        setOllamaNotice('Ollama stopped. Launch it again to continue chatting.');
      }

      if (key.startsWith('stop:') && toolId === 'whisper') {
        setWhisperNotice('Whisper stopped. Launch it again to continue transcribing.');
      }
    } catch (error) {
      if (key.startsWith('install:') || key.startsWith('repair:')) {
        clearProgress(toolId);
      }

      const baseMessage = error.message || 'Local AI Hub could not complete that action.';
      const helpMessage =
        (key.startsWith('install:') || key.startsWith('repair:')) && appState.logsPath
          ? `${baseMessage} Open the logs folder for the full installer log.`
          : baseMessage;
      pushToast(helpMessage, 'error');
    } finally {
      markBusy(key, false);
    }
  }

  useEffect(() => {
    loadState();
    const unsubscribeInstallProgress = window.localAIHub.onInstallProgress((progress) => {
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

    const intervalId = window.setInterval(async () => {
      const result = await window.localAIHub.refresh();
      if (result?.ok) {
        setAppState(result.data);
      }
    }, 5000);

    return () => {
      unsubscribeInstallProgress();
      unsubscribeOpenToolUi();
      unsubscribeUpdateReady();
      window.clearInterval(intervalId);
    };
  }, []);

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
          installedCount={tools.length}
          logsBusy={busyMap['open-logs']}
          modelManagerCount={modelManagerCount}
          onChangeTab={setActiveTab}
          onOpenLogs={() => runAction('open-logs', () => window.localAIHub.openLogsFolder())}
          storeCount={availableStoreTools.length}
        />

        <main className="space-y-5">
          <ResourceStrip
            activeTab={activeTab}
            installedCount={tools.length}
            resources={appState.resources}
            runningCount={runningCount}
          />

          {activeTab === 'library' ? (
            <section className="space-y-4">
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

              {tools.length ? (
                tools.map((tool) => (
                  <LibraryCard
                    key={tool.id}
                    busyMap={busyMap}
                    onLaunch={(toolId) => runAction(`launch:${toolId}`, () => window.localAIHub.launchTool(toolId))}
                    onOpenFolder={(toolId) => runAction(`folder:${toolId}`, () => window.localAIHub.openToolFolder(toolId))}
                    onOpenInterface={openEmbeddedToolUi}
                    onRepair={(toolId) => runAction(`repair:${toolId}`, () => window.localAIHub.repairTool(toolId))}
                    onRestoreSnapshot={(toolId, snapshotFileName) =>
                      runAction(`restore:${toolId}`, () => window.localAIHub.restoreSnapshot({ toolId, snapshotFileName }))
                    }
                    onSaveSnapshot={(toolId) => runAction(`snapshot:${toolId}`, () => window.localAIHub.saveSnapshot(toolId))}
                    onStop={(toolId) => runAction(`stop:${toolId}`, () => window.localAIHub.stopTool(toolId))}
                    onToggleSettings={(toolId) => setSettingsToolId((current) => (current === toolId ? null : toolId))}
                    progress={progressMap[tool.id]}
                    resources={appState.resources}
                    settingsOpen={settingsToolId === tool.id}
                    tool={tool}
                  />
                ))
              ) : (
                <div className="panel p-10 text-center">
                  <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Library</p>
                  <h3 className="mt-3 text-3xl font-semibold text-white">Your shelf is empty.</h3>
                  <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-slate-300">
                    Switch to Store to install a supported local AI tool or let Local AI Hub detect software already installed on this machine.
                  </p>
                  <button className="primary-button mt-6" onClick={() => setActiveTab('store')} type="button">
                    Open Store
                  </button>
                </div>
              )}
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
                      onInstall={(toolId) => runAction(`install:${toolId}`, () => window.localAIHub.installTool(toolId))}
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
          ) : (
            <ModelManager onToast={pushToast} tools={tools} />
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
