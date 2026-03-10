import { memo } from 'react';
import { formatDiskAvailability, formatUsage } from '../lib/formatters';

function MetricCard({ label, value, detail, accent }) {
  return (
    <div className="metric-card">
      <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-white">{value}</p>
      <p className={`mt-2 text-sm ${accent}`}>{detail}</p>
    </div>
  );
}

function ResourceStrip({ resources, installedCount, runningCount, activeTab, storage, updateCount = 0 }) {
  const activeLabel =
    activeTab === 'library'
      ? 'Library'
      : activeTab === 'store'
        ? 'Store'
        : activeTab === 'models'
          ? 'Model Manager'
          : activeTab === 'pipelines'
            ? 'Pipeline Builder'
            : activeTab === 'statistics'
              ? 'Statistics'
              : 'Settings';
  const heading =
    activeTab === 'library'
      ? 'Your local AI shelf'
      : activeTab === 'store'
        ? 'Browse installable local AI tools'
        : activeTab === 'models'
          ? 'Manage the models behind your tools'
          : activeTab === 'pipelines'
            ? 'Chain tools and providers into guided workflows'
            : activeTab === 'statistics'
              ? 'See what Local AI Hub is using on this PC'
              : 'Control storage, cleanup, and connections';
  const summary =
    activeTab === 'library'
      ? 'Launch, stop, snapshot, repair, and update the tools already on this machine.'
      : activeTab === 'store'
        ? 'Pick a tool, check whether this hardware is a good fit, and let Local AI Hub handle the setup locally.'
        : activeTab === 'models'
          ? 'Search remote catalogs, download models into the right folders, and remove what you no longer need.'
          : activeTab === 'pipelines'
            ? 'Design node-based workflows, review machine suitability, and execute supported steps one at a time.'
            : activeTab === 'statistics'
              ? 'Review launch counts, disk growth, live VRAM history, and how much space Local AI Hub is using locally.'
              : 'Choose a storage drive, manage cloud API keys, migrate older installs off C:, and safely remove leftover files.';
  const diskDetail = resources?.diskMount
    ? `Storage drive ${resources.diskMount}`
    : storage?.managedRoot
      ? 'Managed storage drive'
      : 'Storage drive';

  return (
    <section className="hero-strip">
      <div>
        <p className="text-xs uppercase tracking-[0.28em] text-slate-500">{activeLabel}</p>
        <h2 className="mt-3 text-4xl font-semibold tracking-tight text-white">{heading}</h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">{summary}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <MetricCard accent="text-slate-400" detail="Installed now" label="Tools" value={String(installedCount)} />
        <MetricCard accent="text-emerald-300" detail="Active right now" label="Running" value={String(runningCount)} />
        <MetricCard accent="text-cyan-200" detail="Live system RAM" label="RAM" value={formatUsage(resources?.ramUsedMb, resources?.ramTotalMb)} />
        <MetricCard
          accent="text-cyan-200"
          detail={resources?.vramUsedMb ? 'Live GPU usage' : 'Total GPU memory'}
          label="VRAM"
          value={formatUsage(resources?.vramUsedMb, resources?.vramTotalMb)}
        />
        <MetricCard
          accent={updateCount > 0 ? 'text-amber-200' : Number(resources?.diskUsePercent) >= 90 ? 'text-amber-200' : 'text-cyan-200'}
          detail={updateCount > 0 ? `${updateCount} update${updateCount === 1 ? '' : 's'} available` : diskDetail}
          label={updateCount > 0 ? 'Updates' : 'Disk'}
          value={updateCount > 0 ? String(updateCount) : formatDiskAvailability(resources?.diskFreeBytes, resources?.diskTotalBytes)}
        />
      </div>
    </section>
  );
}

export default memo(ResourceStrip);
