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
  const activeLabel = activeTab === 'library' ? 'Library' : activeTab === 'store' ? 'Store' : 'Model Manager';
  const heading =
    activeTab === 'library'
      ? 'Your local AI shelf'
      : activeTab === 'store'
        ? 'Browse installable local AI tools'
        : 'Manage the models behind your tools';
  const summary =
    activeTab === 'library'
      ? 'Launch, stop, snapshot, and repair the tools already on this machine.'
      : activeTab === 'store'
        ? 'Pick a tool, check whether this hardware is a good fit, and let Local AI Hub handle the setup locally.'
        : 'Search remote catalogs, download models into the right folders, and remove what you no longer need.';

  return (
    <section className="hero-strip">
      <div>
        <p className="text-xs uppercase tracking-[0.28em] text-slate-500">{activeLabel}</p>
        <h2 className="mt-3 text-4xl font-semibold tracking-tight text-white">{heading}</h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">{summary}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        <MetricCard accent="text-slate-400" detail="Installed now" label="Tools" value={String(installedCount)} />
        <MetricCard accent="text-emerald-300" detail="Active right now" label="Running" value={String(runningCount)} />
        <MetricCard accent="text-cyan-200" detail="Live system RAM" label="RAM" value={formatUsage(resources?.ramUsedMb, resources?.ramTotalMb)} />
        <MetricCard
          accent="text-cyan-200"
          detail={resources?.vramUsedMb ? 'Live GPU usage' : 'Total GPU memory'}
          label="VRAM"
          value={formatUsage(resources?.vramUsedMb, resources?.vramTotalMb)}
        />
      </div>
    </section>
  );
}
