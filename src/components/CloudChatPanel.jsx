function messageBubbleClass(role) {
  return role === 'user'
    ? 'ml-auto max-w-[85%] rounded-[26px] rounded-br-lg border border-cyan-300/30 bg-cyan-300/12 px-4 py-3 text-sm leading-7 text-cyan-50'
    : 'max-w-[85%] rounded-[26px] rounded-bl-lg border border-white/10 bg-white/5 px-4 py-3 text-sm leading-7 text-slate-100';
}

export default function CloudChatPanel({
  provider,
  busy,
  draft,
  messages,
  models,
  modelsLoading,
  notice,
  onChangeDraft,
  onChangeModel,
  onHide,
  onRefreshModels,
  onSend,
  selectedModel,
}) {
  return (
    <section className="panel border border-amber-300/20 bg-amber-300/[0.05] p-6">
      <div className="rounded-[28px] border border-amber-300/30 bg-amber-300/15 p-5 text-amber-50 shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-100/90">Cloud Provider In Use</p>
        <p className="mt-3 text-lg font-semibold text-white">
          This conversation is processed by {provider?.name || 'this provider'} and leaves your machine.
        </p>
        <p className="mt-2 text-sm leading-6 text-amber-50/90">
          Only send prompts here if you are comfortable sharing them with that third-party service.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Cloud chat</p>
          <h3 className="mt-3 text-3xl font-semibold tracking-tight text-white">Chat with {provider?.name}</h3>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
            Local AI Hub sends your prompt directly to {provider?.name} using the API key stored in Windows Credential Manager. The key never appears in the UI after you save it.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button className="ghost-button" disabled={modelsLoading || busy} onClick={onRefreshModels} type="button">
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
          <select className="store-input mt-4" disabled={!models.length || busy} onChange={(event) => onChangeModel(event.target.value)} value={selectedModel}>
            {models.length ? null : <option value="">No compatible models returned</option>}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>

          <p className="mt-4 text-sm leading-6 text-slate-300">
            {notice || 'Refresh models, choose one, and then send a prompt to this provider.'}
          </p>

          <div className="mt-4 space-y-2">
            {models.length ? (
              models.map((model) => (
                <button
                  key={model.id}
                  className={`w-full rounded-2xl border px-3 py-3 text-left text-sm transition ${
                    model.id === selectedModel
                      ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-50'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:border-cyan-300/25 hover:bg-white/10'
                  }`}
                  onClick={() => onChangeModel(model.id)}
                  type="button"
                >
                  <div className="font-medium text-white break-all">{model.label}</div>
                  {model.detail ? <div className="mt-1 text-xs text-slate-400">{model.detail}</div> : null}
                </button>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-3 py-4 text-sm leading-6 text-slate-400">
                Refresh this provider to load its available models.
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
                      {message.role === 'user' ? 'You' : provider?.name || 'Assistant'}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap">{message.content}</p>
                  </div>
                ))
              ) : (
                <div className="flex h-full min-h-[240px] items-center justify-center rounded-[26px] border border-dashed border-white/10 bg-white/5 px-6 text-center text-sm leading-7 text-slate-400">
                  Refresh models, choose one, and send your first cloud prompt.
                </div>
              )}
            </div>

            <div className="mt-4 rounded-[26px] border border-amber-300/20 bg-amber-300/[0.08] p-4">
              <p className="mb-3 rounded-2xl border border-amber-300/25 bg-amber-300/15 px-3 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-amber-100">
                This chat leaves your machine
              </p>
              <textarea
                className="store-input min-h-[120px] resize-none"
                disabled={!selectedModel || busy}
                onChange={(event) => onChangeDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    onSend();
                  }
                }}
                placeholder={selectedModel ? `Ask ${provider?.name || 'this provider'} something...` : 'Choose a model before sending a message.'}
                value={draft}
              />

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                  {selectedModel ? `Using ${selectedModel}` : 'No model selected'}
                </p>
                <button className="primary-button" disabled={!selectedModel || !draft.trim() || busy} onClick={onSend} type="button">
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
