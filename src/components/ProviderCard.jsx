import { memo } from 'react';
import HoverRevealText from './HoverRevealText';

function isBusy(busyMap, key) {
  return Boolean(busyMap?.[key]);
}

function ProviderCard({ provider, busyMap, onOpenChat, onOpenSettings }) {
  const providerDescription = `Messages sent here are processed by ${provider.name} and leave your machine. Use Settings to manage the API key stored in Windows Credential Manager.`;
  const statusTone =
    provider.libraryStatus === 'attention'
      ? 'border-amber-300/30 bg-amber-300/10 text-amber-100'
      : 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100';

  return (
    <article className="library-card h-full border border-cyan-400/15 bg-cyan-400/[0.04]">
      <div className="flex min-h-0 flex-wrap items-start justify-between gap-2 overflow-hidden">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="tool-emblem bg-cyan-300/15 text-cyan-100">CL</div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="min-w-0 max-w-full truncate text-lg font-semibold tracking-tight text-white" title={provider.name}>{provider.name}</h3>
              <span className={`status-pill ${statusTone}`}>{provider.statusLabel}</span>
              <span className="status-pill border-cyan-300/25 bg-cyan-300/10 text-cyan-100">Cloud</span>
            </div>
            <HoverRevealText className="line-clamp-2 text-sm leading-5 text-slate-300" revealClassName="hover-reveal-card-popover" rootClassName="mt-2 block min-w-0 max-w-3xl" text={providerDescription} />
            <div className="mt-2 grid min-w-0 gap-2 md:grid-cols-3">
              <div className="card-meta-box">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Connection</p>
                <p className="card-meta-value" title={provider.maskedKey ? 'Saved credential configured' : 'Not connected'}>{provider.maskedKey || 'Not connected'}</p>
              </div>
              <div className="card-meta-box">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Models</p>
                <p className="card-meta-value" title={provider.modelCount ? `${provider.modelCount} available` : 'Refresh to load'}>{provider.modelCount ? `${provider.modelCount} available` : 'Refresh to load'}</p>
              </div>
              <div className="card-meta-box">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Selected model</p>
                <p className="card-meta-value" title={provider.selectedModel || provider.lastAvailableModelId || 'Choose in chat'}>{provider.selectedModel || provider.lastAvailableModelId || 'Choose in chat'}</p>
              </div>
            </div>
            {provider.statusMessage || provider.lastTestMessage ? (
              <div className="mt-2 line-clamp-2 rounded-2xl border border-white/10 bg-white/5 p-2 text-xs leading-5 text-slate-300" title={provider.statusMessage || provider.lastTestMessage}>
                {provider.statusMessage || provider.lastTestMessage}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button className="primary-button compact-card-button" disabled={busyMap[`provider-models:${provider.id}`]} onClick={() => onOpenChat(provider.id)} type="button">
            {busyMap[`provider-models:${provider.id}`] ? 'Opening...' : 'Open chat'}
          </button>
          <button className="ghost-button compact-card-button" onClick={() => onOpenSettings()} type="button">
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
