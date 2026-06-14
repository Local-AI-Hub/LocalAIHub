import { memo } from 'react';
import { formatDiskAvailability, formatUsage } from '../lib/formatters';

function MetricCard({ label, value, detail, accent, compact = false }) {
  return (
    <div className={compact ? 'rounded-2xl border border-white/10 bg-slate-950/30 px-3 py-2.5' : 'metric-card'}>
      <p className={compact ? 'text-[10px] uppercase tracking-[0.18em] text-slate-500' : 'text-xs uppercase tracking-[0.22em] text-slate-500'}>{label}</p>
      <p className={compact ? 'mt-1 text-lg font-semibold text-white' : 'mt-3 text-2xl font-semibold text-white'}>{value}</p>
      <p className={`${compact ? 'mt-1 text-xs' : 'mt-2 text-sm'} ${accent}`}>{detail}</p>
    </div>
  );
}

function ResourceStrip({ resources, installedCount, runningCount, activeTab, storage, updateCount = 0 }) {
  const activeLabel =
    activeTab === 'home'
      ? 'Home'
      : activeTab === 'library'
      ? 'Library'
      : activeTab === 'store'
        ? 'Store'
        : activeTab === 'models'
          ? 'Model Manager'
          : activeTab === 'recorder'
            ? 'Recorder'
            : activeTab === 'pipelines'
              ? 'Pipeline Builder'
            : activeTab === 'statistics'
              ? 'Statistics'
              : 'Settings';
  const heading =
    activeTab === 'home'
      ? 'Your local AI workspace'
      : activeTab === 'library'
      ? 'Your local AI shelf'
      : activeTab === 'store'
        ? 'Browse installable local AI tools'
        : activeTab === 'models'
          ? 'Manage the models behind your tools'
          : activeTab === 'recorder'
            ? 'Capture screen, microphone, and camera locally'
            : activeTab === 'pipelines'
              ? 'Chain tools and providers into guided workflows'
            : activeTab === 'statistics'
              ? 'See what Local AI Hub is using on this PC'
              : 'Control storage, cleanup, and connections';
  const summary =
    activeTab === 'home'
      ? 'Start with a quick action, review local readiness, or pick up where you left off.'
      : activeTab === 'library'
      ? 'Launch, stop, snapshot, repair, and update the tools already on this machine.'
      : activeTab === 'store'
        ? 'Pick a tool, check whether this hardware is a good fit, and let Local AI Hub handle the setup locally.'
        : activeTab === 'models'
          ? 'Search remote catalogs, download models into the right folders, and remove what you no longer need.'
          : activeTab === 'recorder'
            ? 'Create local MKV and WAV recordings, manage recent captures, and keep every file on this PC.'
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
  const compact = ['home', 'library', 'store', 'models', 'recorder', 'pipelines', 'statistics', 'settings'].includes(activeTab);
  const metrics = [
    { accent: 'text-slate-400', detail: 'Installed now', label: 'Tools', value: String(installedCount) },
    { accent: 'text-emerald-300', detail: 'Active right now', label: 'Running', value: String(runningCount) },
    { accent: 'text-cyan-200', detail: 'Live system RAM', label: 'RAM', value: formatUsage(resources?.ramUsedMb, resources?.ramTotalMb) },
    {
      accent: 'text-cyan-200',
      detail: resources?.vramUsedMb ? 'Live GPU usage' : 'Total GPU memory',
      label: 'VRAM',
      value: formatUsage(resources?.vramUsedMb, resources?.vramTotalMb),
    },
    {
      accent: updateCount > 0 ? 'text-amber-200' : Number(resources?.diskUsePercent) >= 90 ? 'text-amber-200' : 'text-cyan-200',
      detail: updateCount > 0 ? `${updateCount} update${updateCount === 1 ? '' : 's'} available` : diskDetail,
      label: updateCount > 0 ? 'Updates' : 'Disk',
      value: updateCount > 0 ? String(updateCount) : formatDiskAvailability(resources?.diskFreeBytes, resources?.diskTotalBytes),
    },
  ];

  if (compact) {
    return (
      <section className="panel flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-[240px] flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">{activeLabel}</p>
            <h2 className="text-2xl font-semibold tracking-tight text-white">{heading}</h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-300">{summary}</p>
        </div>
        <div className="grid min-w-[280px] flex-[1.5] grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-5">
          {metrics.map((metric) => (
            <MetricCard key={metric.label} compact {...metric} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="hero-strip">
      <div>
        <p className="text-xs uppercase tracking-[0.28em] text-slate-500">{activeLabel}</p>
        <h2 className="mt-3 text-4xl font-semibold tracking-tight text-white">{heading}</h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">{summary}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} {...metric} />
        ))}
      </div>
    </section>
  );
}

export default memo(ResourceStrip);
