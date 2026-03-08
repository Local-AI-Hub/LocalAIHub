import { formatTimestamp, statusClass } from '../lib/formatters';

function primaryAction(tool, busyMap, handlers) {
  if (tool.status === 'running') {
    return {
      label: 'Stop',
      variant: 'ghost-button',
      disabled: Boolean(busyMap[`stop:${tool.id}`]),
      onClick: () => handlers.onStop(tool.id),
    };
  }

  if (tool.source === 'external') {
    return {
      label: 'Open',
      variant: 'primary-button',
      disabled: Boolean(busyMap[`launch:${tool.id}`] || busyMap[`folder:${tool.id}`]),
      onClick: () =>
        tool.launchSupported === false
          ? handlers.onOpenFolder(tool.id)
          : handlers.onLaunch(tool.id),
    };
  }

  return {
    label: busyMap[`launch:${tool.id}`] ? 'Launching...' : 'Launch',
    variant: 'primary-button',
    disabled: Boolean(busyMap[`launch:${tool.id}`]),
    onClick: () => handlers.onLaunch(tool.id),
  };
}

export default function ToolCard({
  tool,
  progress,
  busyMap,
  onLaunch,
  onStop,
  onRepair,
  onSaveSnapshot,
  onRestoreSnapshot,
  onOpenFolder,
}) {
  const action = primaryAction(tool, busyMap, {
    onLaunch,
    onStop,
    onOpenFolder,
  });
  const canRepair = tool.source === 'managed';
  const canSnapshot = tool.source === 'managed';

  return (
    <article className="rounded-3xl border border-white/10 bg-white/5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="text-2xl font-semibold text-white">{tool.name}</h3>
            <span className={`status-pill ${statusClass(tool.status)}`}>{tool.status}</span>
            <span
              className={`status-pill ${
                tool.source === 'managed'
                  ? 'border-signal/40 bg-signal/10 text-signal'
                  : 'border-accent/40 bg-accent/10 text-accent'
              }`}
            >
              {tool.source === 'managed' ? 'Local AI Hub install' : 'System install'}
            </span>
          </div>
          <p className="mt-3 text-sm text-slate-400">
            {tool.source === 'managed' ? 'Installed' : 'Detected'} {formatTimestamp(tool.installedAt || tool.detectedAt)}
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{tool.displayPath || tool.installDir}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={action.variant} disabled={action.disabled} onClick={action.onClick} type="button">
            {action.label}
          </button>
          <button className="ghost-button" onClick={() => onOpenFolder(tool.id)} type="button">
            Open folder
          </button>
        </div>
      </div>

      {tool.lastError && (
        <div className="mt-5 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-rose-100">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-rose-200/80">Launch issue</p>
              <p className="mt-2 leading-6">{tool.lastError}</p>
            </div>
            {canRepair ? (
              <button className="ghost-button" disabled={busyMap[`repair:${tool.id}`]} onClick={() => onRepair(tool.id)} type="button">
                {busyMap[`repair:${tool.id}`] ? 'Repairing...' : 'Repair'}
              </button>
            ) : null}
          </div>
        </div>
      )}

      {tool.lastRepairMessage && !tool.lastError && (
        <div className="mt-5 rounded-2xl border border-signal/30 bg-signal/10 p-4 text-sm text-emerald-100">
          {tool.lastRepairMessage}
        </div>
      )}

      {progress && (
        <div className="mt-5 rounded-2xl border border-accent/30 bg-accent/10 p-4 text-sm text-cyan-50">
          <div className="flex items-center justify-between gap-4">
            <span>{progress.message}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-950/30">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}

      {canSnapshot ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-[0.8fr,1.2fr]">
          <div className="rounded-2xl border border-white/10 bg-slate-950/25 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Snapshot system</p>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  Save the virtual environment and config state before upgrades or model changes.
                </p>
              </div>
              <button
                className="ghost-button"
                disabled={busyMap[`snapshot:${tool.id}`]}
                onClick={() => onSaveSnapshot(tool.id)}
                type="button"
              >
                {busyMap[`snapshot:${tool.id}`] ? 'Saving...' : 'Save snapshot'}
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/25 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Restore points</p>
              <span className="text-sm text-slate-400">{tool.snapshots?.length || 0} available</span>
            </div>
            <div className="mt-3 space-y-2">
              {tool.snapshots?.length ? (
                tool.snapshots.slice(0, 4).map((snapshot) => (
                  <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm">
                    <span className="text-slate-300">{snapshot.fileName}</span>
                    <button
                      className="ghost-button"
                      disabled={busyMap[`restore:${tool.id}`]}
                      onClick={() => onRestoreSnapshot(tool.id, snapshot.fileName)}
                      type="button"
                    >
                      Restore
                    </button>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-400">No snapshots yet.</p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/25 p-4 text-sm leading-6 text-slate-300">
          Local AI Hub detected this tool on your system and can launch it, but snapshots and automated repair are only available for tools installed inside Local AI Hub.
        </div>
      )}
    </article>
  );
}
