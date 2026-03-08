import { formatTimestamp, formatUsage, progressWidth, statusClass } from '../lib/formatters';

function PrimaryAction({ tool, busyMap, onLaunch, onStop }) {
  if (tool.status === 'running') {
    return (
      <button className="ghost-button" disabled={busyMap[`stop:${tool.id}`]} onClick={() => onStop(tool.id)} type="button">
        {busyMap[`stop:${tool.id}`] ? 'Stopping...' : 'Stop'}
      </button>
    );
  }

  return (
    <button className="primary-button" disabled={busyMap[`launch:${tool.id}`]} onClick={() => onLaunch(tool.id)} type="button">
      {busyMap[`launch:${tool.id}`] ? 'Launching...' : 'Launch'}
    </button>
  );
}

export default function LibraryCard({
  tool,
  progress,
  busyMap,
  resources,
  settingsOpen,
  onToggleSettings,
  onLaunch,
  onOpenInterface,
  onStop,
  onRepair,
  onSaveSnapshot,
  onRestoreSnapshot,
  onOpenFolder,
}) {
  const runningUsage = tool.status === 'running' ? formatUsage(resources?.vramUsedMb, resources?.vramTotalMb) : 'Idle';
  const canRepair = tool.source === 'managed';
  const canSnapshot = tool.source === 'managed';

  return (
    <article className="library-card">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex min-w-0 flex-1 items-start gap-5">
          <div className="tool-emblem">{tool.icon || tool.name.slice(0, 2).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-3xl font-semibold tracking-tight text-white">{tool.name}</h3>
              <span className={`status-pill ${statusClass(tool.status)}`}>{tool.status.charAt(0).toUpperCase() + tool.status.slice(1)}</span>
              <span className="status-pill border-white/10 bg-white/5 text-slate-300">{tool.category || 'Tool'}</span>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-300">{tool.description}</p>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <div className="rounded-3xl border border-white/10 bg-slate-950/35 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Install source</p>
                <p className="mt-2 text-sm font-medium text-white">{tool.source === 'managed' ? 'Local AI Hub managed' : 'Detected on this PC'}</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-slate-950/35 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Current VRAM load</p>
                <p className="mt-2 text-sm font-medium text-white">{runningUsage}</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-slate-950/35 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Last seen</p>
                <p className="mt-2 text-sm font-medium text-white">{formatTimestamp(tool.installedAt || tool.detectedAt)}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <PrimaryAction busyMap={busyMap} onLaunch={onLaunch} onStop={onStop} tool={tool} />
          {tool.interfaceMode === 'embedded-chat' ? (
            <button className="ghost-button" onClick={() => onOpenInterface(tool.id)} type="button">
              Open chat
            </button>
          ) : null}
          <button className="ghost-button" onClick={() => onToggleSettings(tool.id)} type="button">
            {settingsOpen ? 'Hide settings' : 'Settings'}
          </button>
        </div>
      </div>

      {progress ? (
        <div className="mt-5 rounded-3xl border border-cyan-400/20 bg-cyan-400/10 p-4 text-sm text-cyan-50">
          <div className="flex items-center justify-between gap-4">
            <span>{progress.message}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-950/35">
            <div className="h-full rounded-full bg-cyan-300 transition-all" style={{ width: progressWidth(progress.percent) }} />
          </div>
        </div>
      ) : null}

      {tool.lastError ? (
        <div className="mt-5 rounded-3xl border border-rose-400/25 bg-rose-400/10 p-4 text-sm text-rose-100">
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
      ) : null}

      {tool.lastRepairMessage && !tool.lastError ? (
        <div className="mt-5 rounded-3xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">
          {tool.lastRepairMessage}
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="mt-5 grid gap-4 xl:grid-cols-[0.8fr,1.2fr]">
          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Settings</p>
            <div className="mt-4 space-y-3 text-sm text-slate-300">
              <p className="break-all leading-6">{tool.displayPath || tool.installDir}</p>
              <button className="ghost-button w-full justify-center" onClick={() => onOpenFolder(tool.id)} type="button">
                Open folder
              </button>
              {canRepair ? (
                <button className="ghost-button w-full justify-center" disabled={busyMap[`repair:${tool.id}`]} onClick={() => onRepair(tool.id)} type="button">
                  {busyMap[`repair:${tool.id}`] ? 'Repairing...' : 'Repair install'}
                </button>
              ) : null}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Snapshots</p>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  Save and restore a local checkpoint before changing models, extensions, or dependencies.
                </p>
              </div>
              {canSnapshot ? (
                <button className="ghost-button" disabled={busyMap[`snapshot:${tool.id}`]} onClick={() => onSaveSnapshot(tool.id)} type="button">
                  {busyMap[`snapshot:${tool.id}`] ? 'Saving...' : 'Save snapshot'}
                </button>
              ) : null}
            </div>

            <div className="mt-4 space-y-2">
              {canSnapshot && tool.snapshots?.length ? (
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
                <p className="text-sm leading-6 text-slate-400">
                  {canSnapshot
                    ? 'No snapshots saved for this tool yet.'
                    : 'Snapshots and automated repair are only available for Local AI Hub-managed installs.'}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
