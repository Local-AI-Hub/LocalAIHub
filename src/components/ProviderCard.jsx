import { memo } from 'react';

function isBusy(busyMap, key) {
  return Boolean(busyMap?.[key]);
}

function ProviderCard({ provider, busyMap, onOpenChat, onOpenSettings }) {
  const statusTone =
    provider.libraryStatus === 'attention'
      ? 'border-amber-300/30 bg-amber-300/10 text-amber-100'
      : 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100';

  return (
    <article className="library-card border border-cyan-400/15 bg-cyan-400/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex min-w-0 flex-1 items-start gap-5">
          <div className="tool-emblem bg-cyan-300/15 text-cyan-100">CL</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-3xl font-semibold tracking-tight text-white">{provider.name}</h3>
              <span className={`status-pill ${statusTone}`}>{provider.statusLabel}</span>
              <span className="status-pill border-cyan-300/25 bg-cyan-300/10 text-cyan-100">Cloud</span>
            </div>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
              Messages sent here are processed by {provider.name} and leave your machine. Use Settings to manage the API key stored in Windows Credential Manager.
            </p>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <div className="rounded-3xl border border-white/10 bg-slate-950/35 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Connection</p>
                <p className="mt-2 text-sm font-medium text-white">{provider.maskedKey || 'Not connected'}</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-slate-950/35 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Models</p>
                <p className="mt-2 text-sm font-medium text-white">{provider.modelCount ? `${provider.modelCount} available` : 'Refresh to load'}</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-slate-950/35 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Selected model</p>
                <p className="mt-2 text-sm font-medium text-white break-all">{provider.selectedModel || provider.lastAvailableModelId || 'Choose in chat'}</p>
              </div>
            </div>
            {provider.statusMessage || provider.lastTestMessage ? (
              <div className="mt-5 rounded-3xl border border-white/10 bg-white/5 p-4 text-sm leading-6 text-slate-300">
                {provider.statusMessage || provider.lastTestMessage}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button className="primary-button" disabled={busyMap[`provider-models:${provider.id}`]} onClick={() => onOpenChat(provider.id)} type="button">
            {busyMap[`provider-models:${provider.id}`] ? 'Opening...' : 'Open chat'}
          </button>
          <button className="ghost-button" onClick={() => onOpenSettings()} type="button">
            Manage connection
          </button>
        </div>
      </div>
    </article>
  );
}

function areProviderCardPropsEqual(prevProps, nextProps) {
  const providerId = prevProps.provider?.id;
  return (
    prevProps.provider === nextProps.provider &&
    isBusy(prevProps.busyMap, `provider-models:${providerId}`) === isBusy(nextProps.busyMap, `provider-models:${providerId}`)
  );
}

export default memo(ProviderCard, areProviderCardPropsEqual);
