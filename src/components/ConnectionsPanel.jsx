export default function ConnectionsPanel({
  busyMap,
  drafts,
  onChangeDraft,
  onDisconnect,
  onSave,
  onTest,
  providers,
}) {
  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Connections</p>
          <h3 className="mt-1 text-xl font-semibold text-white">Cloud provider API keys</h3>
          <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-300">
            Keys can come from Windows Credential Manager or supported environment variables. Local AI Hub never shows raw key values after you save them.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
        {(providers || []).map((provider) => (
          <div key={provider.id} className="min-w-0 rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-lg font-semibold text-white">{provider.name}</p>
                  <span className="status-pill border-cyan-300/25 bg-cyan-300/10 text-cyan-100">Cloud</span>
                </div>
                <p className="mt-1 text-sm text-slate-300">{provider.statusLabel}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{provider.credentialStatusLabel || 'No credential configured'}</p>
                {provider.maskedKey ? <p className="mt-1 max-w-full truncate text-xs uppercase tracking-[0.18em] text-slate-500" title="Saved credential configured">{provider.maskedKey}</p> : null}
              </div>
              <a className="ghost-button px-3 py-1.5 text-xs" href={provider.docsUrl} rel="noreferrer" target="_blank">
                Docs
              </a>
            </div>

            <input
              className="store-input mt-3"
              onChange={(event) => onChangeDraft(provider.id, event.target.value)}
              placeholder={`Paste your ${provider.name} API key`}
              type="password"
              value={drafts[provider.id] || ''}
            />

            <div className="mt-3 flex flex-wrap gap-2">
              <button className="primary-button" disabled={busyMap[`provider-save:${provider.id}`] || !(drafts[provider.id] || '').trim()} onClick={() => onSave(provider.id)} type="button">
                {busyMap[`provider-save:${provider.id}`] ? 'Saving...' : provider.hasSavedCredential ? 'Replace saved key' : 'Save key'}
              </button>
              <button className="ghost-button" disabled={busyMap[`provider-test:${provider.id}`] || !provider.isConnected} onClick={() => onTest(provider.id)} type="button">
                {busyMap[`provider-test:${provider.id}`] ? 'Testing...' : 'Test connection'}
              </button>
              <button className="ghost-button" disabled={busyMap[`provider-disconnect:${provider.id}`] || !provider.hasSavedCredential} onClick={() => onDisconnect(provider.id)} type="button">
                {busyMap[`provider-disconnect:${provider.id}`] ? 'Clearing...' : 'Clear saved key'}
              </button>
            </div>

            {provider.credentialStatusMessage || provider.statusMessage || provider.lastTestMessage ? (
              <div className="mt-3 max-h-24 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm leading-6 text-slate-300">
                {provider.credentialStatusMessage || provider.statusMessage || provider.lastTestMessage}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}