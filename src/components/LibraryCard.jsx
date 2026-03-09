import { formatTimestamp, formatUsage, progressWidth, statusClass } from '../lib/formatters';

function embeddedActionLabel(tool) {
  if (tool?.interfaceMode === 'embedded-whisper') {
    return 'Open transcription';
  }

  if (tool?.interfaceMode === 'embedded-chat') {
    return 'Open chat';
  }

  if (tool?.interfaceMode === 'embedded-terminal') {
    return 'Open console';
  }

  return 'Open workspace';
}

function PrimaryAction({ tool, busyMap, onLaunch, onOpenInterface, onStop }) {
  if (tool.status === 'running') {
    return (
      <button className="ghost-button" disabled={busyMap[`stop:${tool.id}`]} onClick={() => onStop(tool.id)} type="button">
        {busyMap[`stop:${tool.id}`] ? 'Stopping...' : 'Stop'}
      </button>
    );
  }

  if (tool.interfaceMode === 'embedded-terminal') {
    return (
      <button className="primary-button" onClick={() => onOpenInterface(tool.id)} type="button">
        Open console
      </button>
    );
  }

  return (
    <button className="primary-button" disabled={busyMap[`launch:${tool.id}`]} onClick={() => onLaunch(tool.id)} type="button">
      {busyMap[`launch:${tool.id}`] ? 'Launching...' : 'Launch'}
    </button>
  );
}

function ProgressNotice({ progress, showSpinner = false, accent = 'cyan' }) {
  if (!progress) {
    return null;
  }

  const hasPercent = Number.isFinite(progress.percent);
  const toneClass =
    accent === 'emerald'
      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
      : 'border-cyan-400/20 bg-cyan-400/10 text-cyan-50';
  const barClass = accent === 'emerald' ? 'bg-emerald-300' : 'bg-cyan-300';

  return (
    <div className={`mt-5 rounded-3xl border p-4 text-sm ${toneClass}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {showSpinner ? (
            <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 ${accent === 'emerald' ? 'border-emerald-100/25 border-t-emerald-100' : 'border-cyan-100/25 border-t-cyan-100'} animate-spin`} />
          ) : null}
          <div className="min-w-0">
            <p>{progress.message}</p>
            {progress.detail ? <p className="mt-2 text-xs leading-5 opacity-80">{progress.detail}</p> : null}
          </div>
        </div>
        <span className="shrink-0">{hasPercent ? `${progress.percent}%` : 'Working...'}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-950/35">
        {hasPercent ? (
          <div className={`h-full rounded-full transition-all ${barClass}`} style={{ width: progressWidth(progress.percent) }} />
        ) : (
          <div className={`h-full w-1/3 animate-pulse rounded-full ${barClass}/85`} />
        )}
      </div>
    </div>
  );
}

export default function LibraryCard({
  tool,
  launchProgress,
  progress,
  updateProgress,
  updateInfo,
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
  onUninstall,
  onUpdate,
}) {
  const runningUsage = tool.status === 'running' ? formatUsage(resources?.vramUsedMb, resources?.vramTotalMb) : 'Idle';
  const canRepair = tool.source === 'managed' || tool.installKind === 'installer-exe';
  const canSnapshot = tool.source === 'managed';
  const hasUpdate = Boolean(updateInfo?.updateAvailable);

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
              {hasUpdate ? <span className="status-pill border-cyan-300/25 bg-cyan-300/10 text-cyan-100">Update available</span> : null}
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
          <PrimaryAction busyMap={busyMap} onLaunch={onLaunch} onOpenInterface={onOpenInterface} onStop={onStop} tool={tool} />
          {String(tool.interfaceMode || '').startsWith('embedded-') && tool.interfaceMode !== 'embedded-terminal' ? (
            <button className="ghost-button" onClick={() => onOpenInterface(tool.id)} type="button">
              {embeddedActionLabel(tool)}
            </button>
          ) : null}
          {hasUpdate ? (
            <button className="ghost-button" disabled={busyMap[`update:${tool.id}`]} onClick={() => onUpdate(tool.id)} type="button">
              {busyMap[`update:${tool.id}`] ? 'Updating...' : 'Update'}
            </button>
          ) : null}
          <button className="ghost-button" onClick={() => onToggleSettings(tool.id)} type="button">
            {settingsOpen ? 'Hide settings' : 'Settings'}
          </button>
          <button
            className="ghost-button"
            disabled={busyMap[`uninstall:${tool.id}`]}
            onClick={() => onUninstall(tool)}
            type="button"
          >
            {busyMap[`uninstall:${tool.id}`] ? 'Uninstalling...' : 'Uninstall'}
          </button>
        </div>
      </div>

      <ProgressNotice progress={launchProgress} showSpinner />
      <ProgressNotice progress={progress} />
      <ProgressNotice accent="emerald" progress={updateProgress} showSpinner />

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

      {tool.lastUpdateMessage && !tool.lastError ? (
        <div className="mt-5 rounded-3xl border border-cyan-300/20 bg-cyan-300/10 p-4 text-sm text-cyan-50">{tool.lastUpdateMessage}</div>
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
              {hasUpdate ? (
                <button className="ghost-button w-full justify-center" disabled={busyMap[`update:${tool.id}`]} onClick={() => onUpdate(tool.id)} type="button">
                  {busyMap[`update:${tool.id}`] ? 'Updating...' : `Update to ${updateInfo.availableVersion || 'latest'}`}
                </button>
              ) : null}
              {canRepair ? (
                <button className="ghost-button w-full justify-center" disabled={busyMap[`repair:${tool.id}`]} onClick={() => onRepair(tool.id)} type="button">
                  {busyMap[`repair:${tool.id}`] ? 'Repairing...' : 'Repair install'}
                </button>
              ) : null}
            </div>
            {hasUpdate ? (
              <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-3 text-sm text-cyan-50">
                Installed {updateInfo.currentVersion || 'Unknown'} | Available {updateInfo.availableVersion || 'Unknown'}
              </div>
            ) : null}
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
                    : 'Snapshots are only available for Local AI Hub-managed installs.'}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
