import { memo } from 'react';
import { formatTimestamp, progressWidth, statusClass } from '../lib/formatters';
import HoverRevealText from './HoverRevealText';

function isPipelineOnlyTool(tool) {
  return String(tool?.interfaceMode || '').trim().toLowerCase() === 'pipeline-only';
}

function pipelineOnlyMessage(tool) {
  if (tool?.id === 'chatterbox-tts') {
    return 'Chatterbox-Turbo is used through Pipeline Builder. Create a Reference Voice TTS pipeline to generate audio.';
  }

  return `${tool?.name || 'This tool'} is used through Pipeline Builder.`;
}

function voiceCloneConsentMessage(tool) {
  return tool?.id === 'chatterbox-tts' ? 'Only clone voices you have permission to use.' : null;
}

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

function lifecycleMode(tool) {
  return String(tool?.lifecycleMode || (tool?.source === 'managed' ? 'managed' : 'external'))
    .trim()
    .toLowerCase();
}

function actionSemantics(tool) {
  if (tool?.actionSemantics) {
    return tool.actionSemantics;
  }

  const mode = lifecycleMode(tool);
  const uninstallKind = mode === 'managed'
    ? 'uninstall'
    : mode === 'official-installer' && tool?.installedByLocalAIHub
      ? 'official-uninstall'
      : 'remove-from-library';
  const lifecycleClass = mode === 'managed'
    ? 'managed-install'
    : mode === 'official-installer' && tool?.installedByLocalAIHub
      ? 'official-managed-install'
      : mode === 'official-installer'
        ? 'detected-official-install'
        : 'detected-external-install';

  return {
    lifecycleClass,
    repairKind: mode === 'managed' ? 'repair-managed' : tool?.installKind === 'installer-exe' ? 'repair-official' : 'repair-unavailable',
    uninstallKind,
    uninstallLabel:
      uninstallKind === 'uninstall'
        ? 'Uninstall'
        : uninstallKind === 'official-uninstall'
          ? 'Official Uninstall'
          : 'Remove from Library',
  };
}

function lifecycleClass(tool) {
  return actionSemantics(tool).lifecycleClass;
}

function isOfficialInstallerTracked(tool) {
  return actionSemantics(tool).uninstallKind === 'official-uninstall';
}

function installSourceLabel(tool) {
  const toolLifecycleClass = lifecycleClass(tool);
  if (toolLifecycleClass === 'managed-install' && tool?.externalInstallDetected) {
    return 'Local AI Hub managed + separate detected install';
  }

  if (toolLifecycleClass === 'managed-install') {
    return 'Local AI Hub managed install';
  }

  if (toolLifecycleClass === 'official-managed-install' && tool?.source === 'managed') {
    return 'Official installer in Local AI Hub folder';
  }

  if (toolLifecycleClass === 'official-managed-install') {
    return 'Official installer launched by Local AI Hub';
  }

  if (toolLifecycleClass === 'detected-official-install') {
    return 'Detected official install';
  }

  return 'Detected on this PC';
}

function installLocationLabel(tool) {
  const toolLifecycleClass = lifecycleClass(tool);
  if (toolLifecycleClass === 'managed-install') {
    return 'Managed location';
  }

  if (toolLifecycleClass === 'official-managed-install') {
    return 'Install location';
  }

  return 'Detected location';
}

function locationDisplayPath(tool) {
  return tool?.displayPath || tool?.installDir || tool?.windowsInstallLocation || 'Location not available';
}

function uninstallActionLabel(tool) {
  return actionSemantics(tool).uninstallLabel || 'Remove from Library';
}

function uninstallBusyLabel(tool) {
  const uninstallKind = actionSemantics(tool).uninstallKind;
  if (uninstallKind === 'remove-from-library') {
    return 'Removing...';
  }

  if (uninstallKind === 'official-uninstall') {
    return 'Official uninstalling...';
  }

  return 'Uninstalling...';
}

function installNote(tool) {
  const notes = [];
  const mode = lifecycleMode(tool);

  if (mode === 'managed' && tool?.externalInstallDetected) {
    const externalPath = tool.externalInstallDisplayPath || tool.externalInstallDir;
    notes.push(
      externalPath
        ? `Windows or another installer also has this tool at ${externalPath}. Local AI Hub is using the managed copy shown here.`
        : 'Windows or another installer also has a separate system install for this tool. Local AI Hub is using the managed copy shown here.',
    );
  }

  if (isOfficialInstallerTracked(tool)) {
    if (tool?.windowsUninstallBrokenCount > 0 && !tool?.windowsUninstallDetected) {
      notes.push('Windows uninstall data exists for this copy, but the official uninstaller is broken or missing. Local AI Hub can only remove the files and shortcuts it still owns until Repair recreates a working vendor uninstall path.');
    } else if (tool?.windowsUninstallPathState === 'present-with-stale') {
      notes.push('Local AI Hub found the working Windows uninstaller plus stale leftover Apps & Features data for another copy. It will run the official uninstaller, remove any Local AI Hub-owned leftovers it can, and clear stale dead entries when it can verify them safely.');
    } else if (tool?.windowsUninstallPathState === 'stale') {
      notes.push('Windows still has a broken Apps & Features entry for this copy. Local AI Hub will not let that stale metadata pretend the app is still installed, and Cleanup can clear it if it remains.');
    } else if (tool?.windowsUninstallDetected) {
      notes.push('Local AI Hub will use the official Windows uninstaller instead of deleting files directly. If Windows leaves a dead Apps & Features entry behind, Local AI Hub will report that honestly and Cleanup can clear it.');
    } else {
      notes.push('This copy came from an official installer. If Windows uninstall data is missing, Local AI Hub can only remove files and shortcuts it still owns and then reconcile any stale Apps & Features metadata it can verify.');
    }
  } else if (mode === 'official-installer') {
    notes.push('This install was detected on your PC. Local AI Hub can launch it, but it does not own the uninstall lifecycle.');
  }

  return notes.length ? notes.join(' ') : null;
}
function PrimaryAction({ tool, busyMap, onLaunch, onOpenInterface, onStop }) {
  if (isPipelineOnlyTool(tool)) {
    return (
      <button className="ghost-button compact-card-button" disabled type="button" title={pipelineOnlyMessage(tool)}>
        Pipeline Builder
      </button>
    );
  }

  if (tool.status === 'running' || tool.status === 'starting') {
    return (
      <button className="ghost-button compact-card-button" disabled={busyMap[`stop:${tool.id}`]} onClick={() => onStop(tool.id)} type="button">
        {busyMap[`stop:${tool.id}`] ? 'Stopping...' : 'Stop'}
      </button>
    );
  }

  if (tool.interfaceMode === 'embedded-terminal') {
    return (
      <button className="primary-button compact-card-button" onClick={() => onOpenInterface(tool.id)} type="button">
        Open console
      </button>
    );
  }

  return (
    <button className="primary-button compact-card-button" disabled={busyMap[`launch:${tool.id}`]} onClick={() => onLaunch(tool.id)} type="button">
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
    <div className={`mt-2 rounded-2xl border p-2 text-xs ${toneClass}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          {showSpinner ? (
            <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 ${accent === 'emerald' ? 'border-emerald-100/25 border-t-emerald-100' : 'border-cyan-100/25 border-t-cyan-100'} animate-spin`} />
          ) : null}
          <div className="min-w-0">
            <p>{progress.message}</p>
            {progress.detail ? <p className="mt-1 line-clamp-1 text-xs leading-5 opacity-80" title={progress.detail}>{progress.detail}</p> : null}
          </div>
        </div>
        <span className="shrink-0">{hasPercent ? `${progress.percent}%` : 'Working...'}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-950/35">
        {hasPercent ? (
          <div className={`h-full rounded-full transition-all ${barClass}`} style={{ width: progressWidth(progress.percent) }} />
        ) : (
          <div className={`h-full w-1/3 animate-pulse rounded-full ${barClass}/85`} />
        )}
      </div>
    </div>
  );
}

function isBusy(busyMap, key) {
  return Boolean(busyMap?.[key]);
}

function areLibraryCardPropsEqual(prevProps, nextProps) {
  const toolId = prevProps.tool?.id;
  const busyKeys = [
    `launch:${toolId}`,
    `stop:${toolId}`,
    `update:${toolId}`,
    `repair:${toolId}`,
    `snapshot:${toolId}`,
    `restore:${toolId}`,
    `uninstall:${toolId}`,
  ];

  return (
    prevProps.tool === nextProps.tool &&
    prevProps.launchProgress === nextProps.launchProgress &&
    prevProps.progress === nextProps.progress &&
    prevProps.updateProgress === nextProps.updateProgress &&
    prevProps.updateInfo === nextProps.updateInfo &&
    prevProps.settingsOpen === nextProps.settingsOpen &&
    prevProps.runningUsageLabel === nextProps.runningUsageLabel &&
    prevProps.migrationBusy === nextProps.migrationBusy &&
    prevProps.migrationEligible === nextProps.migrationEligible &&
    busyKeys.every((key) => isBusy(prevProps.busyMap, key) === isBusy(nextProps.busyMap, key))
  );
}

function LibraryCard({
  tool,
  launchProgress,
  progress,
  updateProgress,
  updateInfo,
  busyMap,
  migrationBusy,
  migrationEligible,
  runningUsageLabel,
  settingsOpen,
  onToggleSettings,
  onLaunch,
  onOpenKoboldSetup,
  onMigrateManagedData,
  onOpenInterface,
  onStop,
  onRepair,
  onSaveSnapshot,
  onRestoreSnapshot,
  onOpenFolder,
  onUninstall,
  onUpdate,
}) {
  const runningUsage = tool.status === 'running' ? runningUsageLabel : tool.status === 'starting' ? 'Starting up' : 'Idle';
  const canRepair = actionSemantics(tool).repairKind !== 'repair-unavailable';
  const canSnapshot = lifecycleMode(tool) === 'managed';
  const hasUpdate = Boolean(updateInfo?.updateAvailable);
  const note = installNote(tool);
  const consentNote = voiceCloneConsentMessage(tool);
  const uninstallLabel = uninstallActionLabel(tool);
  const installSource = installSourceLabel(tool);
  const lastSeen = formatTimestamp(tool.installedAt || tool.detectedAt);

  return (
    <article className={`library-card h-full ${settingsOpen ? 'library-card-expanded' : ''}`.trim()}>
      <div className="flex min-h-0 flex-wrap items-start justify-between gap-2 overflow-hidden">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="tool-emblem">{tool.icon || tool.name.slice(0, 2).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="min-w-0 max-w-full truncate text-lg font-semibold tracking-tight text-white" title={tool.name}>{tool.name}</h3>
              <span className={`status-pill ${statusClass(tool.status)}`}>{tool.status.charAt(0).toUpperCase() + tool.status.slice(1)}</span>
              <span className="status-pill max-w-[10rem] truncate border-white/10 bg-white/5 text-slate-300" title={tool.category || 'Tool'}>{tool.category || 'Tool'}</span>
              {hasUpdate ? <span className="status-pill border-cyan-300/25 bg-cyan-300/10 text-cyan-100">Update available</span> : null}
            </div>
            <HoverRevealText className="line-clamp-2 text-sm leading-5 text-slate-300" revealClassName="hover-reveal-card-popover" rootClassName="mt-2 block min-w-0" text={tool.description} />
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <div className="card-meta-box">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Install source</p>
                <p className="card-meta-value" title={installSource}>{installSource}</p>
              </div>
              <div className="card-meta-box">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Current VRAM load</p>
                <p className="card-meta-value" title={runningUsage}>{runningUsage}</p>
              </div>
              <div className="card-meta-box">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Last seen</p>
                <p className="card-meta-value" title={lastSeen}>{lastSeen}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <PrimaryAction busyMap={busyMap} onLaunch={onLaunch} onOpenInterface={onOpenInterface} onStop={onStop} tool={tool} />
          {tool.id === 'koboldcpp' ? (
            <button className="ghost-button compact-card-button" onClick={onOpenKoboldSetup} type="button">
              {tool.launchSelectionStatus?.actionLabel || 'Change model'}
            </button>
          ) : null}
          {String(tool.interfaceMode || '').startsWith('embedded-') && tool.interfaceMode !== 'embedded-terminal' ? (
            <button className="ghost-button compact-card-button" onClick={() => onOpenInterface(tool.id)} type="button">
              {embeddedActionLabel(tool)}
            </button>
          ) : null}
          {hasUpdate ? (
            <button className="ghost-button compact-card-button" disabled={busyMap[`update:${tool.id}`]} onClick={() => onUpdate(tool.id)} type="button">
              {busyMap[`update:${tool.id}`] ? 'Updating...' : 'Update'}
            </button>
          ) : null}
          <button className="ghost-button compact-card-button" onClick={() => onToggleSettings(tool.id)} type="button">
            {settingsOpen ? 'Hide settings' : 'Settings'}
          </button>
          <button
            className="ghost-button compact-card-button"
            disabled={busyMap[`uninstall:${tool.id}`]}
            onClick={() => onUninstall(tool)}
            type="button"
          >
            {busyMap[`uninstall:${tool.id}`] ? uninstallBusyLabel(tool) : uninstallLabel}
          </button>
        </div>
      </div>

      <ProgressNotice progress={launchProgress} showSpinner />
      <ProgressNotice progress={progress} />
      <ProgressNotice accent="emerald" progress={updateProgress} showSpinner />

      {isPipelineOnlyTool(tool) ? (
        <div className="mt-2 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-2 text-xs leading-5 text-cyan-50">
          {pipelineOnlyMessage(tool)}
        </div>
      ) : null}

      {consentNote ? (
        <div className="mt-2 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-2 text-xs leading-5 text-amber-50">
          {consentNote}
        </div>
      ) : null}

      {tool.lastError ? (
        <div className="mt-2 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-2 text-xs text-rose-100">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-rose-200/80">Launch issue</p>
              <p className="mt-1 line-clamp-2 leading-5" title={tool.lastError}>{tool.lastError}</p>
            </div>
            {canRepair ? (
              <button className="ghost-button compact-card-button" disabled={busyMap[`repair:${tool.id}`]} onClick={() => onRepair(tool.id)} type="button">
                {busyMap[`repair:${tool.id}`] ? 'Repairing...' : 'Repair'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}


      {tool.lastRepairMessage && !tool.lastError ? (
        <div className="mt-2 line-clamp-2 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-2 text-xs leading-5 text-emerald-100" title={tool.lastRepairMessage}>
          {tool.lastRepairMessage}
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="mt-2 grid gap-2 2xl:grid-cols-[0.8fr,1.2fr]">
          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{installLocationLabel(tool)}</p>
            <div className="mt-4 space-y-3 text-sm text-slate-300">
              <p className="break-all leading-6">{locationDisplayPath(tool)}</p>
              {note ? <p className="mt-3 text-xs leading-6 text-slate-400">{note}</p> : null}
              {migrationEligible ? (
                <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-3 text-sm leading-6 text-amber-50">
                  This tool is still in an older Local AI Hub storage folder. Migrating will move all eligible managed folders into the current storage root.
                </div>
              ) : null}
              {migrationEligible ? (
                <button className="ghost-button w-full justify-center" disabled={migrationBusy} onClick={onMigrateManagedData} type="button">
                  {migrationBusy ? 'Migrating...' : 'Migrate managed files'}
                </button>
              ) : null}
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
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Snapshots</p>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  Save and restore a local checkpoint before changing models, extensions, or dependencies.
                </p>
              </div>
              {canSnapshot ? (
                <button className="ghost-button compact-card-button" disabled={busyMap[`snapshot:${tool.id}`]} onClick={() => onSaveSnapshot(tool.id)} type="button">
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
                      className="ghost-button compact-card-button"
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
                    : 'Snapshots are only available for tools that Local AI Hub manages directly.'}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export default memo(LibraryCard, areLibraryCardPropsEqual);
