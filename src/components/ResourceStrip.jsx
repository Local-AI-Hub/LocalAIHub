import { formatUsage } from '../lib/formatters';

function MetricCard({ label, value, detail, accent }) {
  return (
    <div className="metric-card">
      <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-white">{value}</p>
      <p className={`mt-2 text-sm ${accent}`}>{detail}</p>
    </div>
  );
}

export default function ResourceStrip({ resources, installedCount, runningCount, activeTab }) {
  return (
    <section className="hero-strip">
      <div>
        <p className="text-xs uppercase tracking-[0.28em] text-slate-500">{activeTab === 'library' ? 'Library' : 'Store'}</p>
        <h2 className="mt-3 text-4xl font-semibold tracking-tight text-white">
          {activeTab === 'library' ? 'Your local AI shelf' : 'Browse installable local AI tools'}
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
          {activeTab === 'library'
            ? 'Launch, stop, snapshot, and repair the tools already on this machine.'
            : 'Pick a tool, check whether this hardware is a good fit, and let NestAI handle the setup locally.'}
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        <MetricCard accent="text-slate-400" detail="Installed now" label="Tools" value={String(installedCount)} />
        <MetricCard accent="text-emerald-300" detail="Active right now" label="Running" value={String(runningCount)} />
        <MetricCard accent="text-cyan-200" detail="Live system RAM" label="RAM" value={formatUsage(resources?.ramUsedMb, resources?.ramTotalMb)} />
        <MetricCard accent="text-cyan-200" detail={resources?.vramUsedMb ? 'Live GPU usage' : 'Total GPU memory'} label="VRAM" value={formatUsage(resources?.vramUsedMb, resources?.vramTotalMb)} />
      </div>
    </section>
  );
}
