import { useEffect, useMemo, useRef, useState } from 'react';

const CONSOLE_OUTPUT_LIMIT = 48000;
const AIDER_SUPPORTED_PROVIDER_PROTOCOLS = new Set(['openai-compatible', 'anthropic', 'google-gemini']);

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

function fileNameFromPath(value) {
  return String(value || '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

function buildProviderOptions(ollamaTool, connectedProviders = []) {
  const options = [];

  if (ollamaTool) {
    options.push({
      id: 'ollama',
      label: ollamaTool.name || 'Ollama',
      source: 'local',
      supported: true,
      detail: 'Use a local Ollama model through Aider.',
    });
  }

  for (const provider of connectedProviders) {
    const protocol = String(provider?.configuration?.protocol || '').trim().toLowerCase();
    const supported = AIDER_SUPPORTED_PROVIDER_PROTOCOLS.has(protocol);
    const detail =
      protocol === 'openai-compatible'
        ? "Uses this provider through Aider's OpenAI-compatible adapter."
        : protocol === 'anthropic'
          ? "Uses Aider's Anthropic adapter."
          : protocol === 'google-gemini'
            ? "Uses Aider's Gemini adapter."
            : 'Local AI Hub cannot map this provider into Aider yet.';

    options.push({
      id: provider.id,
      label: provider.name,
      source: 'cloud',
      supported,
      detail,
    });
  }

  return options;
}

export default function AiderPanel({ connectedProviders, ollamaTool, onHide, pushToast, runAction, tool }) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [output, setOutput] = useState('');
  const [projectDir, setProjectDir] = useState('');
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectStatus, setProjectStatus] = useState(null);
  const [providerId, setProviderId] = useState('');
  const [models, setModels] = useState([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [initializeGit, setInitializeGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const outputRef = useRef(null);
  const isRunning = tool?.status === 'running';
  const projectLabel = fileNameFromPath(projectDir);

  const providerOptions = useMemo(() => buildProviderOptions(ollamaTool, connectedProviders), [connectedProviders, ollamaTool]);
  const selectedProvider = useMemo(
    () => providerOptions.find((provider) => provider.id === providerId) || null,
    [providerId, providerOptions],
  );
  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) || null,
    [models, selectedModelId],
  );

  useEffect(() => {
    const element = outputRef.current;
    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [output]);

  useEffect(() => {
    if (!tool) {
      return;
    }

    const supportedProviderIds = providerOptions.filter((provider) => provider.supported).map((provider) => provider.id);
    setProjectDir((current) => current || tool.lastProjectDir || '');
    setInitializeGit(tool.aiderInitializeGit !== false);
    setProviderId((current) => {
      if (current && supportedProviderIds.includes(current)) {
        return current;
      }
      if (tool.aiderProviderId && supportedProviderIds.includes(tool.aiderProviderId)) {
        return tool.aiderProviderId;
      }
      return supportedProviderIds[0] || '';
    });
    setSelectedModelId((current) => current || tool.aiderModelId || '');
  }, [providerOptions, tool]);

  useEffect(() => {
    if (!tool || !isRunning) {
      return;
    }

    setNotice((current) => current || `Aider is running in ${projectDir || tool.lastProjectDir || 'the selected project folder'}.`);

    window.localAIHub.getToolRuntimeOutput(tool.id).then((result) => {
      if (!result?.ok) {
        return;
      }

      setOutput(combineRuntimeOutput(result.data));
    });
  }, [isRunning, projectDir, tool]);

  useEffect(() => {
    const unsubscribeRuntimeOutput = window.localAIHub.onRuntimeOutput((payload) => {
      if (payload?.toolId !== 'aider' || typeof payload.chunk !== 'string') {
        return;
      }

      setOutput((current) => trimConsoleOutput(`${current}${payload.chunk}`));
    });

    return () => {
      unsubscribeRuntimeOutput?.();
    };
  }, []);

  useEffect(() => {
    if (!projectDir || isRunning) {
      return;
    }

    inspectProject(projectDir, { silent: true, preserveNotice: Boolean(models.length) });
  }, [isRunning, projectDir]);

  useEffect(() => {
    if (!providerId || isRunning) {
      return;
    }

    loadModels({ providerId, silent: true, preserveNotice: Boolean(projectStatus?.message) });
  }, [isRunning, providerId]);

  useEffect(() => {
    if (isRunning) {
      return;
    }

    if (!providerOptions.some((provider) => provider.supported)) {
      setNotice('Connect a supported cloud provider or install Ollama before launching Aider.');
      return;
    }

    if (selectedProvider && !selectedProvider.supported) {
      setNotice(`${selectedProvider.label} is connected in Local AI Hub, but it cannot be launched through Aider yet.`);
      return;
    }

    setNotice((current) => current || projectStatus?.message || 'Choose a project folder, provider, and model before launching Aider.');
  }, [isRunning, projectStatus?.message, providerOptions, selectedProvider]);

  async function inspectProject(folderPath, options = {}) {
    const normalizedPath = String(folderPath || '').trim();
    if (!normalizedPath) {
      setProjectStatus(null);
      return null;
    }

    setProjectLoading(true);
    const result = await window.localAIHub.inspectAiderProject(normalizedPath);
    if (!result?.ok) {
      const message = result?.message || 'Local AI Hub could not inspect that Aider project folder.';
      setProjectStatus(null);
      setNotice(message);
      if (!options.silent) {
        pushToast(message, 'error');
      }
      setProjectLoading(false);
      return null;
    }

    setProjectStatus(result.data || null);
    if (!options.preserveNotice) {
      setNotice(result.data?.message || `Aider will start in ${normalizedPath}.`);
    }
    setProjectLoading(false);
    return result.data || null;
  }

  async function loadModels(options = {}) {
    const nextProviderId = options.providerId || providerId;
    if (!nextProviderId) {
      setModels([]);
      setSelectedModelId('');
      return;
    }

    setModelsLoading(true);
    const result = await window.localAIHub.listAiderModels({
      providerId: nextProviderId,
      preferredModelId: options.preferredModelId || selectedModelId || tool?.aiderModelId || '',
    });

    if (!result?.ok) {
      const message = result?.message || 'Local AI Hub could not load models for that Aider provider.';
      setModels([]);
      setSelectedModelId('');
      setNotice(message);
      if (!options.silent) {
        pushToast(message, 'error');
      }
      setModelsLoading(false);
      return;
    }

    const nextModels = result.data?.models || [];
    setModels(nextModels);
    setSelectedModelId(result.data?.selectedModelId || nextModels[0]?.id || '');
    if (!options.preserveNotice) {
      setNotice(result.data?.message || 'Choose a model and launch Aider to begin.');
    }
    setModelsLoading(false);
  }

  async function chooseProjectFolder() {
    setBusy(true);
    const result = await window.localAIHub.pickAiderProjectFolder();
    if (!result?.ok) {
      pushToast(result?.message || 'Local AI Hub could not open the project folder picker.', 'error');
      setBusy(false);
      return;
    }

    if (!result.data?.canceled && result.data?.folderPath) {
      setProjectDir(result.data.folderPath);
      await inspectProject(result.data.folderPath);
    }

    setBusy(false);
  }

  async function launchSession() {
    if (!projectDir) {
      pushToast('Choose a project folder before launching Aider.', 'error');
      return;
    }

    if (!providerId || !selectedProvider?.supported) {
      pushToast('Choose an Aider-ready provider before launching.', 'error');
      return;
    }

    if (!selectedModelId) {
      pushToast('Choose a model before launching Aider.', 'error');
      return;
    }

    let currentProjectStatus = projectStatus;
    if (!currentProjectStatus || currentProjectStatus.projectDir !== projectDir) {
      currentProjectStatus = await inspectProject(projectDir, {
        preserveNotice: true,
        silent: true,
      });
      if (!currentProjectStatus) {
        return;
      }
    }

    if (!currentProjectStatus.hasGitRepo && !currentProjectStatus.gitAvailable && initializeGit) {
      pushToast('Git is not available on this PC, so Local AI Hub cannot initialize a repository for Aider.', 'error');
      return;
    }

    setOutput('');
    setBusy(true);
    const launched = await runAction('launch:aider', () =>
      window.localAIHub.launchTool({
        toolId: 'aider',
        projectDir,
        aiderSession: {
          providerId,
          modelId: selectedModelId,
          initializeGit: currentProjectStatus.hasGitRepo ? false : initializeGit,
        },
      }),
    );
    if (launched) {
      setNotice(`Aider is running in ${projectDir} with ${selectedModel?.label || selectedModelId} from ${selectedProvider?.label || 'the selected provider'}.`);
      const runtimeOutput = await window.localAIHub.getToolRuntimeOutput('aider');
      if (runtimeOutput?.ok) {
        setOutput(combineRuntimeOutput(runtimeOutput.data));
      }
    }
    setBusy(false);
  }

  async function stopSession() {
    if (!tool?.id) {
      return;
    }

    setBusy(true);
    const stopped = await runAction(`stop:${tool.id}`, () => window.localAIHub.stopTool(tool.id));
    if (stopped) {
      setNotice('Aider stopped. Launch it again to continue coding.');
    }
    setBusy(false);
  }

  async function sendInput() {
    const message = draft.trim();
    if (!message) {
      return;
    }

    if (!isRunning) {
      pushToast('Launch Aider before sending it a command.', 'error');
      return;
    }

    setSending(true);
    setOutput((current) => trimConsoleOutput(`${current}${current ? '\n' : ''}> ${message}\n`));

    const result = await window.localAIHub.sendToolInput({
      toolId: 'aider',
      input: message,
    });

    if (!result?.ok) {
      pushToast(result?.message || 'Local AI Hub could not send that input to Aider.', 'error');
      setSending(false);
      return;
    }

    setDraft('');
    setNotice(`Sent a command to ${tool?.name || 'Aider'}.`);
    setSending(false);
  }

  const launchDisabled =
    busy ||
    projectLoading ||
    modelsLoading ||
    !projectDir ||
    !selectedProvider?.supported ||
    !selectedModelId ||
    (!projectStatus?.hasGitRepo && !projectStatus?.gitAvailable && initializeGit);

  return (
    <section className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Aider</p>
          <h3 className="mt-3 text-3xl font-semibold tracking-tight text-white">Code with Aider inside Local AI Hub</h3>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
            Local AI Hub now owns the Aider setup flow here: choose a project folder, decide how to handle git, pick a provider and model, and then launch a managed coding session without Aider's raw first-run wizard.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {isRunning ? (
            <button className="ghost-button" disabled={busy} onClick={stopSession} type="button">
              {busy ? 'Stopping...' : 'Stop Aider'}
            </button>
          ) : (
            <button className="primary-button" disabled={launchDisabled} onClick={launchSession} type="button">
              {busy ? 'Launching...' : 'Launch Aider'}
            </button>
          )}
          <button className="ghost-button" onClick={onHide} type="button">
            Hide console
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[340px,1fr]">
        <aside className="rounded-[30px] border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Session setup</p>

          <div className="mt-4 space-y-4">
            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Project folder</p>
              <p className="mt-3 break-all text-sm leading-6 text-slate-300">{projectLabel || 'No project folder selected yet.'}</p>
              {projectDir ? <p className="mt-2 break-all text-xs leading-5 text-slate-500">{projectDir}</p> : null}
              {projectStatus?.message ? <p className="mt-3 text-xs leading-5 text-slate-400">{projectStatus.message}</p> : null}
              <button className="ghost-button mt-4 w-full justify-center" disabled={busy} onClick={chooseProjectFolder} type="button">
                {projectDir ? 'Choose another folder' : 'Choose project folder'}
              </button>
            </div>

            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Git handling</p>
                  <p className="mt-3 text-sm leading-6 text-slate-300">
                    {projectStatus?.hasGitRepo
                      ? 'Aider will use the git repository already found for this folder.'
                      : initializeGit
                        ? 'Local AI Hub will initialize a git repository before Aider starts if this folder does not have one yet.'
                        : 'Aider will launch without git if this folder does not already have a repository.'}
                  </p>
                </div>
                <label className="inline-flex items-center gap-2 text-sm text-slate-200">
                  <input
                    checked={initializeGit}
                    className="h-4 w-4 rounded border-white/20 bg-slate-950 text-cyan-400"
                    disabled={Boolean(projectStatus?.hasGitRepo) || !projectStatus?.gitAvailable || isRunning}
                    onChange={(event) => setInitializeGit(event.target.checked)}
                    type="checkbox"
                  />
                  Init git if missing
                </label>
              </div>
              {!projectStatus?.gitAvailable && !projectStatus?.hasGitRepo ? (
                <p className="mt-3 text-xs leading-5 text-amber-200">Git is not available on this PC, so Local AI Hub can only launch Aider in no-git mode for this folder.</p>
              ) : null}
            </div>

            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Provider</p>
              <select
                className="store-input mt-4"
                disabled={!providerOptions.length || isRunning}
                onChange={(event) => {
                  setProviderId(event.target.value);
                  setModels([]);
                  setSelectedModelId('');
                }}
                value={providerId}
              >
                {providerOptions.length ? null : <option value="">No Aider-ready providers found</option>}
                {providerOptions.map((provider) => (
                  <option disabled={!provider.supported} key={provider.id} value={provider.id}>
                    {provider.label}{provider.supported ? '' : ' (Not supported yet)'}
                  </option>
                ))}
              </select>
              {selectedProvider ? <p className="mt-3 text-xs leading-5 text-slate-400">{selectedProvider.detail}</p> : null}
            </div>

            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Model</p>
                <button className="ghost-button px-3 py-2 text-xs" disabled={!providerId || isRunning || modelsLoading} onClick={() => loadModels()} type="button">
                  {modelsLoading ? 'Refreshing...' : 'Refresh models'}
                </button>
              </div>
              <select
                className="store-input mt-4"
                disabled={!models.length || !selectedProvider?.supported || isRunning}
                onChange={(event) => setSelectedModelId(event.target.value)}
                value={selectedModelId}
              >
                {models.length ? null : <option value="">No Aider-ready models loaded</option>}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
              {selectedModel ? (
                <div className="mt-3 space-y-2 text-xs leading-5 text-slate-400">
                  <p>{selectedModel.compatibilityNote}</p>
                  {selectedModel.detail ? <p>{selectedModel.detail}</p> : null}
                </div>
              ) : (
                <p className="mt-3 text-xs leading-5 text-slate-400">Choose a provider and refresh models before launching Aider.</p>
              )}
            </div>

            <p className="text-sm leading-6 text-slate-300">
              {notice ||
                (isRunning
                  ? 'Aider is running. Type a prompt below to continue the session.'
                  : 'Choose a project folder, provider, and model before launching Aider.')}
            </p>
          </div>
        </aside>

        <div className="rounded-[30px] border border-white/10 bg-slate-950/35 p-4">
          <div className="rounded-[26px] border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Console output</p>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{isRunning ? 'Live' : 'Idle'}</p>
            </div>
            <pre
              ref={outputRef}
              className="mt-4 min-h-[320px] max-h-[420px] overflow-y-auto rounded-[22px] border border-white/10 bg-slate-950/80 p-4 font-mono text-xs leading-6 text-slate-200 whitespace-pre-wrap"
            >
              {output || 'Aider console output will appear here after launch.'}
            </pre>

            <div className="mt-4 grid gap-3 md:grid-cols-[1fr,140px]">
              <textarea
                className="store-input min-h-[110px] resize-none"
                disabled={!isRunning || busy || sending}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={isRunning ? 'Ask Aider to inspect files, suggest a fix, or apply a change.' : 'Launch Aider to enable console input.'}
                value={draft}
              />
              <button className="primary-button h-full justify-center" disabled={!isRunning || !draft.trim() || busy || sending} onClick={sendInput} type="button">
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
