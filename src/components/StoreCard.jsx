import { progressWidth } from '../lib/formatters';
import { compatibilityClass, describeRequirements } from '../lib/tool-ui';

export default function StoreCard({ manifest, compatibility, progress, busy, onInstall }) {
  return (
    <article className="store-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="tool-emblem">{manifest.icon}</div>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-2xl font-semibold text-white">{manifest.name}</h3>
              <span className="status-pill border-white/10 bg-white/5 text-slate-300">{manifest.category}</span>
              <span className={`status-pill ${compatibilityClass(compatibility.tone)}`}>{compatibility.label}</span>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">{manifest.description}</p>
          </div>
        </div>

        <button className="primary-button" disabled={busy} onClick={() => onInstall(manifest.id)} type="button">
          {busy ? 'Installing...' : 'Install'}
        </button>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
        <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Install plan</p>
          <p className="mt-3 text-sm leading-6 text-slate-300">{manifest.installSummary}</p>
        </div>
        <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Hardware fit</p>
          <p className="mt-3 text-sm leading-6 text-slate-300">{compatibility.message}</p>
          <p className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-500">{describeRequirements(manifest)}</p>
        </div>
      </div>

      {progress ? (
        <div className="mt-5 rounded-3xl border border-cyan-400/20 bg-cyan-400/10 p-4">
          <div className="flex items-center justify-between gap-4 text-sm text-cyan-50">
            <span>{progress.message}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-950/40">
            <div className="h-full rounded-full bg-cyan-300 transition-all" style={{ width: progressWidth(progress.percent) }} />
          </div>
        </div>
      ) : null}
    </article>
  );
}
