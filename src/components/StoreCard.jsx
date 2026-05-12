import { memo } from 'react';
import { progressWidth } from '../lib/formatters';
import { compatibilityClass, describeRequirements } from '../lib/tool-ui';

function installMethodLabel(manifest) {
  if (manifest?.installContract?.lifecycleMode === 'official-installer') {
    return manifest?.installContract?.destinationControl === 'guided'
      ? 'Official installer (guided)'
      : 'Official installer';
  }

  return 'Direct Local AI Hub install';
}

function installPlanText(manifest) {
  return manifest?.installContract?.locationSummary || manifest.installSummary;
}

function installButtonLabel(manifest) {
  return manifest?.installContract?.lifecycleMode === 'official-installer' ? 'Official Install' : 'Install';
}
function StoreCard({ manifest, compatibility, progress, busy, onInstall }) {
  return (
    <article className="store-card h-full">
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="tool-emblem">{manifest.icon}</div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-xl font-semibold text-white">{manifest.name}</h3>
                <span className="status-pill border-white/10 bg-white/5 text-slate-300">{manifest.category}</span>
                <span className={`status-pill ${compatibilityClass(compatibility.tone)}`}>{compatibility.label}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm leading-5 text-slate-300">{manifest.description}</p>
            </div>
          </div>

          <button className="primary-button shrink-0" disabled={busy} onClick={() => onInstall(manifest.id)} type="button">
            {busy ? 'Installing...' : installButtonLabel(manifest)}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <span className="status-pill border-amber-300/20 bg-amber-300/10 text-amber-100">{installMethodLabel(manifest)}</span>
          <span className="status-pill border-white/10 bg-white/5 text-slate-300">{describeRequirements(manifest)}</span>
        </div>

        <p className="text-sm leading-5 text-slate-300">{compatibility.message}</p>

        <details className="rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-2 text-sm text-slate-300">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Install details</summary>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Install plan</p>
              <p className="mt-1 leading-5">{installPlanText(manifest)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Hardware fit</p>
              <p className="mt-1 leading-5">{compatibility.message}</p>
            </div>
          </div>
        </details>

        {progress ? (
          <div className="mt-auto rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3">
            <div className="flex items-center justify-between gap-3 text-sm text-cyan-50">
              <span>{progress.message}</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-950/40">
              <div className="h-full rounded-full bg-cyan-300 transition-all" style={{ width: progressWidth(progress.percent) }} />
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function areStoreCardPropsEqual(prevProps, nextProps) {
  return (
    prevProps.manifest === nextProps.manifest &&
    prevProps.progress === nextProps.progress &&
    prevProps.busy === nextProps.busy &&
    prevProps.compatibility?.label === nextProps.compatibility?.label &&
    prevProps.compatibility?.message === nextProps.compatibility?.message &&
    prevProps.compatibility?.tone === nextProps.compatibility?.tone
  );
}

export default memo(StoreCard, areStoreCardPropsEqual);
