import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatDiskAvailability } from '../lib/formatters';

function buildSuggestedRoot(mount) {
  const normalizedMount = String(mount || '').replace(/[\\/]*$/, '\\');
  return `${normalizedMount}LocalAIHub`;
}

function formatUpdateCheckedAt(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function CategoryList({ category }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">{category.label}</p>
          <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{formatBytes(category.totalBytes)} recoverable</p>
        </div>
        <span className="status-pill border-white/10 bg-white/5 text-slate-300">{category.entries.length} item{category.entries.length === 1 ? '' : 's'}</span>
      </div>

      <div className="mt-3 max-h-72 space-y-3 overflow-y-auto pr-1">
        {category.entries.map((entry) => (
          <div key={entry.path} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-medium text-white">{entry.label}</p>
              <p className="text-slate-300">{formatBytes(entry.sizeBytes)}</p>
            </div>
            <p className="mt-2 break-all text-xs leading-6 text-slate-400">{entry.path}</p>
            <p className="mt-2 text-sm leading-6 text-slate-300">{entry.reason}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsSection({ id, openSection, setOpenSection, eyebrow, title, summary, action, children }) {
  const open = openSection === id;
  return (
    <div className="panel overflow-hidden p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpenSection(open ? '' : id)} type="button">
          <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{eyebrow}</p>
          <h3 className="mt-1 text-xl font-semibold text-white">{title}</h3>
          <p className="mt-1 line-clamp-2 max-w-4xl text-sm leading-6 text-slate-300">{summary}</p>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {action}
          <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setOpenSection(open ? '' : id)} type="button">
            {open ? 'Collapse' : 'Open'}
          </button>
        </div>
      </div>
      {open ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

export default function SettingsPanel({
  appUpdate,
  busyMap,
  checkForUpdatesOnLaunch,
  cleanupPreview,
  initialSection = '',
  closeBehaviorDraft,
  liveResourcePollingDraft,
  pipelineOutputTrashDraft,
  onChangeCloseBehavior,
  onChangeLiveResourcePolling,
  onChangePipelineOutputTrash,
  onChangePreferredInstallRootDraft,
  onChangeScreenMode,
  onChangeStorageDraft,
  onChoosePreferredInstallFolder,
  onChooseStorageFolder,
  onDismissLegacyMigration,
  onMigrateLegacyStorage,
  onPreviewCleanup,
  onRunCleanup,
  onToast,
  onSaveWindowSettings,
  onSavePreferredInstallRoot,
  onSaveStorageLocation,
  preferredInstallRootDraft,
  screenMode = 'windowed',
  screenModeBusy = false,
  storage,
  storageDraft,
}) {
  const [openSection, setOpenSection] = useState(initialSection || 'storage');
  const [diagnosticsBusy, setDiagnosticsBusy] = useState('');
  const [diagnosticsStatus, setDiagnosticsStatus] = useState('');
  const [diagnosticsPath, setDiagnosticsPath] = useState('');
  const [updateBusy, setUpdateBusy] = useState('');
  const [updateState, setUpdateState] = useState(appUpdate || null);
  const [checkOnLaunchDraft, setCheckOnLaunchDraft] = useState(Boolean(checkForUpdatesOnLaunch));
  const updateRequestSequence = useRef(0);
  const legacyMigration = storage?.legacyMigration;
  const currentPreferredInstallRoot = storage?.preferredInstallRoot || storage?.managedRoot || '';
  const usingManagedStorageAsDefault = !storage?.customPreferredInstallRoot || currentPreferredInstallRoot === storage?.managedRoot;

  useEffect(() => {
    if (initialSection) {
      setOpenSection(initialSection);
    }
  }, [initialSection]);

  useEffect(() => {
    if (cleanupPreview && !initialSection) {
      setOpenSection('cleanup');
    }
  }, [cleanupPreview, initialSection]);

  useEffect(() => {
    setUpdateState(appUpdate || null);
  }, [appUpdate]);

  useEffect(() => {
    setCheckOnLaunchDraft(Boolean(checkForUpdatesOnLaunch));
  }, [checkForUpdatesOnLaunch]);

  useEffect(() => () => {
    updateRequestSequence.current += 1;
    window.localAIHub.cancelUpdateCheck().catch(() => null);
  }, []);

  async function runDiagnosticsAction(action, operation, fallbackMessage) {
    setDiagnosticsBusy(action);
    setDiagnosticsStatus('');
    try {
      const result = await operation();
      if (!result?.ok) {
        const message = result?.message || fallbackMessage;
        setDiagnosticsStatus(message);
        onToast?.(message, 'error');
        return null;
      }
      const message = result.data?.message || fallbackMessage;
      setDiagnosticsStatus(message);
      onToast?.(message, 'success');
      return result.data;
    } catch (error) {
      const message = error?.message || fallbackMessage;
      setDiagnosticsStatus(message);
      onToast?.(message, 'error');
      return null;
    } finally {
      setDiagnosticsBusy('');
    }
  }

  async function copySystemInfo() {
    await runDiagnosticsAction('copy', () => window.localAIHub.copySystemInfo(), 'Local AI Hub could not copy the system information.');
  }

  async function createDiagnostics() {
    const data = await runDiagnosticsAction('create', () => window.localAIHub.createDiagnosticsBundle(), 'Local AI Hub could not create the diagnostics bundle.');
    if (data?.bundlePath) setDiagnosticsPath(data.bundlePath);
  }

  async function openDiagnosticsFolder() {
    await runDiagnosticsAction('open', () => window.localAIHub.openDiagnosticsFolder(), 'Local AI Hub could not open the diagnostics folder.');
  }

  async function checkForUpdates() {
    const requestSequence = updateRequestSequence.current + 1;
    updateRequestSequence.current = requestSequence;
    setUpdateBusy('check');
    setUpdateState((current) => ({
      ...(current || {}),
      message: 'Checking GitHub Releases...',
      status: 'checking',
    }));

    try {
      const result = await window.localAIHub.checkForUpdates();
      if (requestSequence !== updateRequestSequence.current) return;
      if (result?.ok && result.data) {
        setUpdateState(result.data);
      } else {
        setUpdateState((current) => ({
          ...(current || {}),
          message: result?.message || 'Could not check for updates. Check your connection or try again later.',
          status: 'error',
        }));
      }
    } catch {
      if (requestSequence !== updateRequestSequence.current) return;
      setUpdateState((current) => ({
        ...(current || {}),
        message: 'Could not check for updates. Check your connection or try again later.',
        status: 'error',
      }));
    } finally {
      if (requestSequence === updateRequestSequence.current) setUpdateBusy('');
    }
  }

  async function toggleCheckOnLaunch() {
    const nextValue = !checkOnLaunchDraft;
    setUpdateBusy('preference');
    try {
      const result = await window.localAIHub.saveCheckForUpdatesOnLaunch(nextValue);
      if (result?.ok) {
        setCheckOnLaunchDraft(Boolean(result.data?.checkForUpdatesOnLaunch));
        if (result.data?.update) setUpdateState(result.data.update);
      } else {
        setUpdateState((current) => ({
          ...(current || {}),
          message: result?.message || 'Local AI Hub could not save that update-check setting.',
          status: 'error',
        }));
      }
    } catch {
      setUpdateState((current) => ({
        ...(current || {}),
        message: 'Local AI Hub could not save that update-check setting.',
        status: 'error',
      }));
    } finally {
      setUpdateBusy('');
    }
  }

  async function openUpdateTarget(target) {
    setUpdateBusy(target);
    try {
      const result = await window.localAIHub.openAppUpdateTarget(target);
      if (!result?.ok) {
        setUpdateState((current) => ({
          ...(current || {}),
          message: result?.message || 'Local AI Hub could not open that trusted GitHub release link.',
          status: 'error',
        }));
      }
    } catch {
      setUpdateState((current) => ({
        ...(current || {}),
        message: 'Local AI Hub could not open that trusted GitHub release link.',
        status: 'error',
      }));
    } finally {
      setUpdateBusy('');
    }
  }

  return (
    <section className="space-y-3">
      <SettingsSection
        action={(
          <button className="ghost-button" disabled={busyMap['settings:pick-folder']} onClick={onChooseStorageFolder} type="button">
            {busyMap['settings:pick-folder'] ? 'Opening...' : 'Browse storage folder'}
          </button>
        )}
        eyebrow="Storage"
        id="storage"
        openSection={openSection}
        setOpenSection={setOpenSection}
        summary="Manage the data root for snapshots, model downloads, cleanup caches, and the default Store install folder."
        title="Large-file storage and install defaults"
      >
        <div className="grid gap-3 xl:grid-cols-[1.05fr,1.05fr,0.9fr]">
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Managed storage folder</p>
            <input
              className="store-input mt-3"
              onChange={(event) => onChangeStorageDraft(event.target.value)}
              placeholder="D:\\LocalAIHub"
              type="text"
              value={storageDraft}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="primary-button" disabled={busyMap['settings:save-storage']} onClick={onSaveStorageLocation} type="button">
                {busyMap['settings:save-storage'] ? 'Saving...' : 'Save storage location'}
              </button>
              <button className="ghost-button" onClick={() => onChangeStorageDraft(storage?.defaultManagedRoot || '')} type="button">
                Use default folder
              </button>
            </div>
            <div className="mt-4 max-h-36 space-y-2 overflow-y-auto pr-1 text-sm text-slate-300">
              <p><span className="text-slate-500">Current location:</span> {storage?.managedRoot || 'Not available'}</p>
              <p><span className="text-slate-500">App install folder:</span> {storage?.appInstallDir || 'Not available'}</p>
              <p><span className="text-slate-500">Config folder:</span> {storage?.configRoot || 'Not available'}</p>
              <p><span className="text-slate-500">Executable:</span> {storage?.executablePath || 'Not available'}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Default tool install folder</p>
                <p className="mt-2 text-sm leading-6 text-slate-300">New Store installs start here when the tool supports a destination.</p>
              </div>
              <span className="status-pill border-white/10 bg-white/5 text-slate-300">
                {usingManagedStorageAsDefault ? 'Following managed storage' : 'Custom default'}
              </span>
            </div>
            <input
              className="store-input mt-3"
              onChange={(event) => onChangePreferredInstallRootDraft(event.target.value)}
              placeholder={storage?.managedRoot || 'D:\\LocalAIHub'}
              type="text"
              value={preferredInstallRootDraft}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="primary-button" disabled={busyMap['settings:save-preferred-install-root']} onClick={onSavePreferredInstallRoot} type="button">
                {busyMap['settings:save-preferred-install-root'] ? 'Saving...' : 'Save default install folder'}
              </button>
              <button className="ghost-button" disabled={busyMap['settings:pick-preferred-install-folder']} onClick={onChoosePreferredInstallFolder} type="button">
                {busyMap['settings:pick-preferred-install-folder'] ? 'Opening...' : 'Browse folder'}
              </button>
              <button className="ghost-button" onClick={() => onChangePreferredInstallRootDraft(storage?.managedRoot || '')} type="button">
                Use managed storage folder
              </button>
            </div>
            <div className="mt-4 space-y-2 text-sm text-slate-300">
              <p><span className="text-slate-500">Current default:</span> {currentPreferredInstallRoot || 'Not available'}</p>
              <p><span className="text-slate-500">Managed storage folder:</span> {storage?.managedRoot || 'Not available'}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Drive space</p>
            <p className="mt-2 text-sm leading-6 text-slate-300">Click a drive to fill the storage field.</p>
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pb-2 pr-1">
              {(storage?.drives || []).map((drive) => {
                const suggestedRoot = buildSuggestedRoot(drive.mount);
                return (
                  <button
                    key={drive.mount}
                    className={`w-full rounded-2xl border px-3 py-2 text-left transition ${drive.isManagedDrive ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
                    onClick={() => onChangeStorageDraft(suggestedRoot)}
                    type="button"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-white">{drive.mount}</p>
                        <p className="mt-1 text-xs text-slate-300">{formatDiskAvailability(drive.freeBytes, drive.sizeBytes)}</p>
                      </div>
                      <span className="status-pill border-white/10 bg-white/5 text-slate-300">
                        {drive.isManagedDrive ? 'Current drive' : drive.isInstallDrive ? 'App installed here' : 'Use this drive'}
                      </span>
                    </div>
                    <p className="mt-2 break-all text-xs leading-5 text-slate-500">Suggested folder: {suggestedRoot}</p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        action={(
          <button className="primary-button" disabled={Boolean(updateBusy)} onClick={checkForUpdates} type="button">
            {updateBusy === 'check' ? 'Checking...' : 'Check for updates'}
          </button>
        )}
        eyebrow="Updates"
        id="updates"
        openSection={openSection}
        setOpenSection={setOpenSection}
        summary="Check the public Local AI Hub GitHub Releases feed and open a newer Windows installer in your browser."
        title="App updates"
      >
        <div className="grid gap-3 xl:grid-cols-[0.8fr,1.2fr]">
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Current version</p>
                <p className="mt-2 text-lg font-semibold text-white">v{updateState?.currentVersion || '0.49.0'}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Latest version</p>
                <p className="mt-2 text-lg font-semibold text-white">{updateState?.latestVersion ? `v${updateState.latestVersion}` : 'Unknown'}</p>
              </div>
            </div>
            <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-3">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Update status</p>
              <p className="mt-2 text-sm leading-6 text-slate-200">{updateState?.message || 'Check GitHub Releases to see whether a newer version is available.'}</p>
              <p className="mt-2 text-xs text-slate-500">Last successful check: {formatUpdateCheckedAt(updateState?.checkedAt)}</p>
              {updateState?.status === 'error' && updateState?.latestVersion ? (
                <p className="mt-2 text-xs leading-5 text-slate-400">The last successful release result is still shown above.</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-4">
            <button
              aria-pressed={checkOnLaunchDraft}
              className={`w-full rounded-2xl border p-4 text-left transition ${checkOnLaunchDraft ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
              disabled={Boolean(updateBusy)}
              onClick={toggleCheckOnLaunch}
              type="button"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-white">Check for updates on launch</p>
                  <p className="mt-1 text-sm leading-6 text-slate-300">Runs a quiet, non-blocking GitHub check after startup.</p>
                </div>
                <span className="status-pill border-white/10 bg-white/5 text-slate-200">{checkOnLaunchDraft ? 'On' : 'Off'}</span>
              </div>
            </button>

            <div className="mt-4 flex flex-wrap gap-2">
              <button className="primary-button" disabled={Boolean(updateBusy) || !updateState?.installerUrlAvailable} onClick={() => openUpdateTarget('installer')} type="button">
                {updateBusy === 'installer' ? 'Opening...' : 'Download installer'}
              </button>

              <button className="ghost-button" disabled={Boolean(updateBusy) || !updateState?.releaseUrlAvailable} onClick={() => openUpdateTarget('notes')} type="button">
                {updateBusy === 'notes' ? 'Opening...' : 'Release notes'}
              </button>
            </div>

            <p className="mt-4 text-xs leading-5 text-slate-400">
              Update checks contact GitHub Releases to compare versions. No diagnostics, files, provider keys, or usage data are uploaded.
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Installer downloads open in your browser. Local AI Hub never runs or installs them automatically.
            </p>
          </div>
        </div>
      </SettingsSection>
      <SettingsSection
        eyebrow="Support"
        id="support-diagnostics"
        openSection={openSection}
        setOpenSection={setOpenSection}
        summary="Copy a safe support summary or create a local, reviewable diagnostics bundle. Nothing is uploaded automatically."
        title="Support and Diagnostics"
      >
        <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-4">
          <p className="max-w-4xl text-sm leading-6 text-slate-300">
            Create a local diagnostics bundle for bug reports. It includes app version, hardware summary, tool readiness, sanitized Model Manager health counts/status, recent sanitized logs, and recent run summaries. It does not intentionally include API keys, model files, source media, generated outputs, or prompt contents. Review it before sharing.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="primary-button" disabled={Boolean(diagnosticsBusy)} onClick={copySystemInfo} type="button">
              {diagnosticsBusy === 'copy' ? 'Copying...' : 'Copy system info'}
            </button>
            <button className="primary-button" disabled={Boolean(diagnosticsBusy)} onClick={createDiagnostics} type="button">
              {diagnosticsBusy === 'create' ? 'Creating bundle...' : 'Create diagnostics bundle'}
            </button>
            <button className="ghost-button" disabled={Boolean(diagnosticsBusy)} onClick={openDiagnosticsFolder} type="button">
              {diagnosticsBusy === 'open' ? 'Opening...' : 'Open diagnostics folder'}
            </button>
          </div>
          {diagnosticsStatus ? <p className="mt-3 text-sm text-slate-200">{diagnosticsStatus}</p> : null}
          {diagnosticsPath ? <p className="mt-2 break-all text-xs leading-5 text-slate-500">Latest bundle: {diagnosticsPath}</p> : null}
        </div>
      </SettingsSection>
      <SettingsSection
        action={(
          <button className="primary-button" disabled={busyMap['settings:save-window-settings']} onClick={onSaveWindowSettings} type="button">
            {busyMap['settings:save-window-settings'] ? 'Saving...' : 'Save window settings'}
          </button>
        )}
        eyebrow="Window behavior"
        id="window"
        openSection={openSection}
        setOpenSection={setOpenSection}
        summary="Choose the screen mode, close-button behavior, background resource polling, and pipeline output deletion behavior."
        title="Screen, close button, and background polling"
      >
        <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Screen mode</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">Current mode: {screenMode === 'fullscreen' ? 'Fullscreen mode' : 'Windowed mode'}. Press F11 anywhere in Local AI Hub to toggle.</p>
            </div>
            <span className="status-pill border-white/10 bg-white/5 text-slate-200">
              {screenMode === 'fullscreen' ? 'Fullscreen' : 'Windowed'}
            </span>
          </div>
          <div aria-label="Screen mode" className="mt-3 grid gap-3 md:grid-cols-2" role="radiogroup">
            <button
              aria-checked={screenMode === 'windowed'}
              className={`rounded-2xl border p-4 text-left transition ${screenMode === 'windowed' ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
              disabled={screenModeBusy}
              onClick={() => onChangeScreenMode('windowed')}
              role="radio"
              type="button"
            >
              <p className="text-base font-semibold text-white">Windowed mode</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">Use the normal Windows title bar, taskbar, and resize controls.</p>
            </button>
            <button
              aria-checked={screenMode === 'fullscreen'}
              className={`rounded-2xl border p-4 text-left transition ${screenMode === 'fullscreen' ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
              disabled={screenModeBusy}
              onClick={() => onChangeScreenMode('fullscreen')}
              role="radio"
              type="button"
            >
              <p className="text-base font-semibold text-white">Fullscreen mode</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">Hide the Windows title bar and taskbar while Local AI Hub is active.</p>
            </button>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">Click Save window settings to use the selected mode on the next launch. F11 changes the current session until you save.</p>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <button className={`rounded-2xl border p-4 text-left transition ${closeBehaviorDraft === 'tray' ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-slate-950/35 hover:bg-white/5'}`} onClick={() => onChangeCloseBehavior('tray')} type="button">
            <p className="text-base font-semibold text-white">Minimize to tray on close</p>
            <p className="mt-2 text-sm leading-6 text-slate-300">Clicking the X hides the window so your tools can keep running.</p>
          </button>
          <button className={`rounded-2xl border p-4 text-left transition ${closeBehaviorDraft === 'exit' ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-slate-950/35 hover:bg-white/5'}`} onClick={() => onChangeCloseBehavior('exit')} type="button">
            <p className="text-base font-semibold text-white">Exit app on close</p>
            <p className="mt-2 text-sm leading-6 text-slate-300">Clicking the X shuts down Local AI Hub and exits cleanly.</p>
          </button>
        </div>

        <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/35 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Live usage polling</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">Continuous polling can wake heavier GPU telemetry on some PCs.</p>
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <button className={`rounded-2xl border p-4 text-left transition ${!liveResourcePollingDraft ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-slate-950/35 hover:bg-white/5'}`} onClick={() => onChangeLiveResourcePolling(false)} type="button">
              <p className="text-base font-semibold text-white">Keep live polling off</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">The dashboard keeps the latest snapshot.</p>
            </button>
            <button className={`rounded-2xl border p-4 text-left transition ${liveResourcePollingDraft ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-slate-950/35 hover:bg-white/5'}`} onClick={() => onChangeLiveResourcePolling(true)} type="button">
              <p className="text-base font-semibold text-white">Enable live polling</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">RAM and VRAM refresh while the app stays open.</p>
            </button>
          </div>
        </div>

        <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/35 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Pipeline output deletion</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">Recycle Bin mode is easier to undo. Permanent delete removes output files and metadata sidecars from disk.</p>
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <button className={`rounded-2xl border p-4 text-left transition ${pipelineOutputTrashDraft ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-slate-950/35 hover:bg-white/5'}`} onClick={() => onChangePipelineOutputTrash(true)} type="button">
              <p className="text-base font-semibold text-white">Move deleted pipeline outputs to Recycle Bin</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">Default. Local AI Hub asks Windows to move output files or folders to the Recycle Bin.</p>
            </button>
            <button className={`rounded-2xl border p-4 text-left transition ${!pipelineOutputTrashDraft ? 'border-rose-300/40 bg-rose-400/10' : 'border-white/10 bg-slate-950/35 hover:bg-white/5'}`} onClick={() => onChangePipelineOutputTrash(false)} type="button">
              <p className="text-base font-semibold text-white">Permanently delete from disk</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">Aggressive cleanup. Deleted pipeline outputs cannot be easily restored.</p>
            </button>
          </div>
        </div>
      </SettingsSection>

      {legacyMigration?.available && !legacyMigration.dismissed ? (
        <div className="panel border border-amber-300/20 bg-amber-300/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-amber-100/80">Migration available</p>
              <h4 className="mt-2 text-xl font-semibold text-white">Older Local AI Hub files are still in another Local AI Hub folder</h4>
              <p className="mt-2 line-clamp-3 max-w-4xl text-sm leading-6 text-amber-50/90">
                Local AI Hub found {legacyMigration.toolCount || 0} managed tool folder{legacyMigration.toolCount === 1 ? '' : 's'} and other large files in {legacyMigration.sourceRoot}. You can move them into {legacyMigration.targetRoot}.
              </p>
              <p className="mt-2 text-sm text-amber-100/80">Estimated data to move: {formatBytes(legacyMigration.totalBytes)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="primary-button" disabled={busyMap['settings:migrate-legacy']} onClick={onMigrateLegacyStorage} type="button">
                {busyMap['settings:migrate-legacy'] ? 'Migrating...' : 'Migrate now'}
              </button>
              <button className="ghost-button" disabled={busyMap['settings:dismiss-migration']} onClick={onDismissLegacyMigration} type="button">
                Later
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <SettingsSection
        action={(
          <div className="flex flex-wrap gap-2">
            <button className="ghost-button" disabled={busyMap['settings:preview-cleanup']} onClick={onPreviewCleanup} type="button">
              {busyMap['settings:preview-cleanup'] ? 'Scanning...' : 'Preview cleanup'}
            </button>
            <button className="primary-button" disabled={busyMap['settings:run-cleanup'] || !cleanupPreview?.totalEntries} onClick={onRunCleanup} type="button">
              {busyMap['settings:run-cleanup'] ? 'Cleaning...' : 'Delete selected leftovers'}
            </button>
          </div>
        )}
        eyebrow="Cleanup"
        id="cleanup"
        openSection={openSection}
        setOpenSection={setOpenSection}
        summary="Scan only Local AI Hub AppData folders, the app install folder, and tracked tool locations."
        title="Safe leftover-file cleanup"
      >
        {cleanupPreview ? (
          cleanupPreview.totalEntries ? (
            <div className="space-y-3">
              <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3 text-sm text-slate-300">
                Local AI Hub can remove {cleanupPreview.totalEntries} leftover item{cleanupPreview.totalEntries === 1 ? '' : 's'} and recover about {formatBytes(cleanupPreview.totalBytes)}.
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                {cleanupPreview.categories.map((category) => <CategoryList category={category} key={category.id} />)}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-3 text-sm text-emerald-100">
              Local AI Hub did not find duplicate installs or approved leftover files in the scanned storage folders.
            </div>
          )
        ) : (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-4 text-sm leading-6 text-slate-400">
            Preview cleanup to see removable Local AI Hub leftovers before deleting anything.
          </div>
        )}
      </SettingsSection>
    </section>
  );
}
