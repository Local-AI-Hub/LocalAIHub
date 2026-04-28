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
    <section className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Connections</p>
          <h3 className="mt-3 text-3xl font-semibold text-white">Manage cloud provider API keys</h3>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
            Keys can come from Windows Credential Manager or supported environment variables. Local AI Hub never shows raw key values after you save them.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        {(providers || []).map((provider) => (
          <div key={provider.id} className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-xl font-semibold text-white">{provider.name}</p>
                  <span className="status-pill border-cyan-300/25 bg-cyan-300/10 text-cyan-100">Cloud</span>
                </div>
                <p className="mt-2 text-sm text-slate-300">{provider.statusLabel}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{provider.credentialStatusLabel || 'No credential configured'}</p>
                {provider.maskedKey ? <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{provider.maskedKey}</p> : null}
              </div>
              <a className="ghost-button" href={provider.docsUrl} rel="noreferrer" target="_blank">
                Docs
              </a>
            </div>

            <input
              className="store-input mt-4"
              onChange={(event) => onChangeDraft(provider.id, event.target.value)}
              placeholder={`Paste your ${provider.name} API key`}
              type="password"
              value={drafts[provider.id] || ''}
            />

            <div className="mt-4 flex flex-wrap gap-3">
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
              <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm leading-6 text-slate-300">
                {provider.credentialStatusMessage || provider.statusMessage || provider.lastTestMessage}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
