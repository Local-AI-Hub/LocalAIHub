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
    <article className="library-card h-full border border-cyan-400/15 bg-cyan-400/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="tool-emblem bg-cyan-300/15 text-cyan-100">CL</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-semibold tracking-tight text-white">{provider.name}</h3>
              <span className={`status-pill ${statusTone}`}>{provider.statusLabel}</span>
              <span className="status-pill border-cyan-300/25 bg-cyan-300/10 text-cyan-100">Cloud</span>
            </div>
            <p className="mt-2 line-clamp-2 max-w-3xl text-sm leading-5 text-slate-300">
              Messages sent here are processed by {provider.name} and leave your machine. Use Settings to manage the API key stored in Windows Credential Manager.
            </p>
            <div className="mt-3 grid min-w-0 gap-2 md:grid-cols-3">
              <div className="min-w-0 rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Connection</p>
                <p className="mt-1 min-w-0 truncate text-xs font-medium text-white" title={provider.maskedKey ? 'Saved credential configured' : 'Not connected'}>{provider.maskedKey || 'Not connected'}</p>
              </div>
              <div className="min-w-0 rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Models</p>
                <p className="mt-1 truncate text-xs font-medium text-white">{provider.modelCount ? `${provider.modelCount} available` : 'Refresh to load'}</p>
              </div>
              <div className="min-w-0 rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Selected model</p>
                <p className="mt-1 min-w-0 truncate text-xs font-medium text-white" title={provider.selectedModel || provider.lastAvailableModelId || 'Choose in chat'}>{provider.selectedModel || provider.lastAvailableModelId || 'Choose in chat'}</p>
              </div>
            </div>
            {provider.statusMessage || provider.lastTestMessage ? (
              <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm leading-5 text-slate-300">
                {provider.statusMessage || provider.lastTestMessage}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
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
