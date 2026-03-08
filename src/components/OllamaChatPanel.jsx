import { formatBytes } from '../lib/formatters';

function messageBubbleClass(role) {
  return role === 'user'
    ? 'ml-auto max-w-[85%] rounded-[26px] rounded-br-lg border border-cyan-300/30 bg-cyan-300/12 px-4 py-3 text-sm leading-7 text-cyan-50'
    : 'max-w-[85%] rounded-[26px] rounded-bl-lg border border-white/10 bg-white/5 px-4 py-3 text-sm leading-7 text-slate-100';
}

export default function OllamaChatPanel({
  busy,
  draft,
  messages,
  models,
  modelsLoading,
  notice,
  onChangeDraft,
  onChangeModel,
  onHide,
  onLaunch,
  onRefreshModels,
  onSend,
  onStop,
  selectedModel,
  tool,
}) {
  const isRunning = tool?.status === 'running';

  return (
    <section className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Ollama chat</p>
          <h3 className="mt-3 text-3xl font-semibold tracking-tight text-white">Chat with your local models inside Local AI Hub</h3>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
            Local AI Hub talks directly to Ollama on <span className="font-medium text-white">{tool?.launchUrl || 'http://127.0.0.1:11434'}</span>.
            Choose a local model, send a prompt, and keep the conversation inside the app.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {isRunning ? (
            <button className="ghost-button" disabled={busy} onClick={() => onStop(tool.id)} type="button">
              {busy ? 'Stopping...' : 'Stop Ollama'}
            </button>
          ) : (
            <button className="primary-button" disabled={busy} onClick={() => onLaunch(tool.id)} type="button">
              {busy ? 'Launching...' : 'Launch Ollama'}
            </button>
          )}
          <button className="ghost-button" disabled={modelsLoading || !isRunning} onClick={onRefreshModels} type="button">
            {modelsLoading ? 'Refreshing...' : 'Refresh models'}
          </button>
          <button className="ghost-button" onClick={onHide} type="button">
            Hide chat
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[280px,1fr]">
        <aside className="rounded-[30px] border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Models</p>
          <select
            className="store-input mt-4"
            disabled={!models.length || !isRunning}
            onChange={(event) => onChangeModel(event.target.value)}
            value={selectedModel}
          >
            {models.length ? null : <option value="">No local models found</option>}
            {models.map((model) => (
              <option key={model.name} value={model.name}>
                {model.name}
              </option>
            ))}
          </select>

          <p className="mt-4 text-sm leading-6 text-slate-300">
            {notice ||
              (isRunning
                ? 'Choose a local model and send a prompt.'
                : 'Launch Ollama to load its local models and start chatting.')}
          </p>

          <div className="mt-4 space-y-2">
            {models.length ? (
              models.map((model) => (
                <button
                  key={model.name}
                  className={`w-full rounded-2xl border px-3 py-3 text-left text-sm transition ${
                    model.name === selectedModel
                      ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-50'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:border-cyan-300/25 hover:bg-white/10'
                  }`}
                  onClick={() => onChangeModel(model.name)}
                  type="button"
                >
                  <div className="font-medium text-white">{model.name}</div>
                  <div className="mt-1 text-xs text-slate-400">{formatBytes(model.size)}</div>
                </button>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-3 py-4 text-sm leading-6 text-slate-400">
                Ollama is running, but no local models were returned yet.
              </div>
            )}
          </div>
        </aside>

        <div className="rounded-[30px] border border-white/10 bg-slate-950/35 p-4">
          <div className="flex min-h-[460px] flex-col">
            <div className="flex-1 space-y-3 overflow-y-auto pr-1">
              {messages.length ? (
                messages.map((message, index) => (
                  <div key={`${message.role}-${index}`} className={messageBubbleClass(message.role)}>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                      {message.role === 'user' ? 'You' : 'Ollama'}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap">{message.content}</p>
                  </div>
                ))
              ) : (
                <div className="flex h-full min-h-[240px] items-center justify-center rounded-[26px] border border-dashed border-white/10 bg-white/5 px-6 text-center text-sm leading-7 text-slate-400">
                  Start the local runtime, choose a model, and send your first message.
                </div>
              )}
            </div>

            <div className="mt-4 rounded-[26px] border border-white/10 bg-white/5 p-4">
              <textarea
                className="store-input min-h-[120px] resize-none"
                disabled={!isRunning || !selectedModel || busy}
                onChange={(event) => onChangeDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    onSend();
                  }
                }}
                placeholder={
                  isRunning
                    ? selectedModel
                      ? 'Ask your local model something...'
                      : 'Choose a model before sending a message.'
                    : 'Launch Ollama to begin.'
                }
                value={draft}
              />

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                  {selectedModel ? `Using ${selectedModel}` : 'No model selected'}
                </p>
                <button className="primary-button" disabled={!isRunning || !selectedModel || !draft.trim() || busy} onClick={onSend} type="button">
                  {busy ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

