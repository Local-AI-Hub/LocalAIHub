import { formatBytes, formatDiskAvailability } from '../lib/formatters';

function buildSuggestedRoot(mount) {
  const normalizedMount = String(mount || '').replace(/[\\/]*$/, '\\');
  return `${normalizedMount}LocalAIHub`;
}

function CategoryList({ category }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">{category.label}</p>
          <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{formatBytes(category.totalBytes)} recoverable</p>
        </div>
        <span className="status-pill border-white/10 bg-white/5 text-slate-300">{category.entries.length} item{category.entries.length === 1 ? '' : 's'}</span>
      </div>

      <div className="mt-4 space-y-3">
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

export default function SettingsPanel({
  busyMap,
  cleanupPreview,
  closeBehaviorDraft,
  liveResourcePollingDraft,
  onChangeCloseBehavior,
  onChangeLiveResourcePolling,
  onChangeStorageDraft,
  onChooseStorageFolder,
  onDismissLegacyMigration,
  onMigrateLegacyStorage,
  onPreviewCleanup,
  onRunCleanup,
  onSaveCloseBehavior,
  onSaveLiveResourcePolling,
  onSaveStorageLocation,
  storage,
  storageDraft,
}) {
  const legacyMigration = storage?.legacyMigration;

  return (
    <section className="space-y-5">
      <div className="panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Storage</p>
            <h3 className="mt-3 text-3xl font-semibold text-white">Choose where Local AI Hub keeps large files</h3>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
              Tool installs, snapshots, model downloads, repair caches, and managed runtimes now live in your selected storage folder. Small config files and credentials stay in AppData.
            </p>
          </div>
          <button className="ghost-button" disabled={busyMap['settings:pick-folder']} onClick={onChooseStorageFolder} type="button">
            {busyMap['settings:pick-folder'] ? 'Opening...' : 'Browse folder'}
          </button>
        </div>

        <div className="mt-6 grid gap-4 xl:grid-cols-[1.4fr,1fr]">
          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Managed storage folder</p>
            <input
              className="store-input mt-4"
              onChange={(event) => onChangeStorageDraft(event.target.value)}
              placeholder="D:\\LocalAIHub"
              type="text"
              value={storageDraft}
            />
            <div className="mt-4 flex flex-wrap gap-3">
              <button className="primary-button" disabled={busyMap['settings:save-storage']} onClick={onSaveStorageLocation} type="button">
                {busyMap['settings:save-storage'] ? 'Saving...' : 'Save storage location'}
              </button>
              <button className="ghost-button" onClick={() => onChangeStorageDraft(storage?.defaultManagedRoot || '')} type="button">
                Use default folder
              </button>
            </div>
            <div className="mt-5 space-y-3 text-sm text-slate-300">
              <p>
                <span className="text-slate-500">Current location:</span> {storage?.managedRoot || 'Not available'}
              </p>
              <p>
                <span className="text-slate-500">App install folder:</span> {storage?.appInstallDir || 'Not available'}
              </p>
              <p>
                <span className="text-slate-500">Config folder:</span> {storage?.configRoot || 'Not available'}
              </p>
              <p>
                <span className="text-slate-500">Executable:</span> {storage?.executablePath || 'Not available'}
              </p>
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Drive space</p>
            <div className="mt-4 space-y-3">
              {(storage?.drives || []).map((drive) => {
                const suggestedRoot = buildSuggestedRoot(drive.mount);
                return (
                  <button
                    key={drive.mount}
                    className={`w-full rounded-2xl border px-4 py-3 text-left transition ${drive.isManagedDrive ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
                    onClick={() => onChangeStorageDraft(suggestedRoot)}
                    type="button"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-base font-medium text-white">{drive.mount}</p>
                        <p className="mt-1 text-sm text-slate-300">{formatDiskAvailability(drive.freeBytes, drive.sizeBytes)}</p>
                      </div>
                      <span className="status-pill border-white/10 bg-white/5 text-slate-300">
                        {drive.isManagedDrive ? 'Current drive' : drive.isInstallDrive ? 'App installed here' : 'Use this drive'}
                      </span>
                    </div>
                    <p className="mt-3 break-all text-xs leading-6 text-slate-500">Suggested folder: {suggestedRoot}</p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Window behavior</p>
            <h3 className="mt-3 text-3xl font-semibold text-white">Choose what the close button does</h3>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
              Decide whether the window close button hides Local AI Hub to the tray or fully exits the app and cleans up owned background helpers.
            </p>
          </div>
          <button className="primary-button" disabled={busyMap['settings:save-close-behavior']} onClick={onSaveCloseBehavior} type="button">
            {busyMap['settings:save-close-behavior'] ? 'Saving...' : 'Save close behavior'}
          </button>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <button
            className={`rounded-3xl border p-5 text-left transition ${closeBehaviorDraft === 'tray' ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-slate-950/35 hover:bg-white/5'}`}
            onClick={() => onChangeCloseBehavior('tray')}
            type="button"
          >
            <p className="text-lg font-semibold text-white">Minimize to tray on close</p>
            <p className="mt-2 text-sm leading-7 text-slate-300">Clicking the X hides the window so your tools can keep running in the background.</p>
          </button>
          <button
            className={`rounded-3xl border p-5 text-left transition ${closeBehaviorDraft === 'exit' ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-slate-950/35 hover:bg-white/5'}`}
            onClick={() => onChangeCloseBehavior('exit')}
            type="button"
          >
            <p className="text-lg font-semibold text-white">Exit app on close</p>
            <p className="mt-2 text-sm leading-7 text-slate-300">Clicking the X shuts down Local AI Hub, stops owned helpers, and exits cleanly.</p>
          </button>
        </div>

        <div className="mt-6 rounded-3xl border border-white/10 bg-slate-950/35 p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Live usage polling</p>
              <h4 className="mt-3 text-2xl font-semibold text-white">Choose whether Local AI Hub keeps sampling RAM and VRAM</h4>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
                Continuous live polling can wake up heavier GPU telemetry on some PCs. Keep it off for the quietest behavior, or turn it on if you want live readings in the dashboard.
              </p>
            </div>
            <button className="primary-button" disabled={busyMap['settings:save-live-resource-polling']} onClick={onSaveLiveResourcePolling} type="button">
              {busyMap['settings:save-live-resource-polling'] ? 'Saving...' : 'Save live polling'}
            </button>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <button
              className={`rounded-3xl border p-5 text-left transition ${!liveResourcePollingDraft ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-slate-950/35 hover:bg-white/5'}`}
              onClick={() => onChangeLiveResourcePolling(false)}
              type="button"
            >
              <p className="text-lg font-semibold text-white">Keep live polling off</p>
              <p className="mt-2 text-sm leading-7 text-slate-300">The dashboard keeps the latest snapshot instead of refreshing GPU and RAM usage in the background.</p>
            </button>
            <button
              className={`rounded-3xl border p-5 text-left transition ${liveResourcePollingDraft ? 'border-cyan-300/40 bg-cyan-400/10' : 'border-white/10 bg-slate-950/35 hover:bg-white/5'}`}
              onClick={() => onChangeLiveResourcePolling(true)}
              type="button"
            >
              <p className="text-lg font-semibold text-white">Enable live polling</p>
              <p className="mt-2 text-sm leading-7 text-slate-300">Local AI Hub refreshes live RAM and VRAM more gently while the app stays open.</p>
            </button>
          </div>
        </div>
      </div>
      {legacyMigration?.available && !legacyMigration.dismissed ? (
        <div className="panel border border-amber-300/20 bg-amber-300/10 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-amber-100/80">Migration available</p>
              <h4 className="mt-3 text-2xl font-semibold text-white">Older Local AI Hub files are still in another Local AI Hub folder</h4>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-amber-50/90">
                Local AI Hub found {legacyMigration.toolCount || 0} managed tool folder{legacyMigration.toolCount === 1 ? '' : 's'} and other large files in {legacyMigration.sourceRoot}. You can move them into {legacyMigration.targetRoot} so future installs, repairs, and app upgrades keep using one stable storage location.
              </p>
              <p className="mt-3 text-sm text-amber-100/80">Estimated data to move: {formatBytes(legacyMigration.totalBytes)}</p>
            </div>
            <div className="flex flex-wrap gap-3">
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

      <div className="panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Cleanup</p>
            <h3 className="mt-3 text-3xl font-semibold text-white">Scan leftover Local AI Hub files safely</h3>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
              Cleanup only scans Local AI Hub's AppData folders, the app install folder, and tracked tool locations. It never scans the whole machine.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="ghost-button" disabled={busyMap['settings:preview-cleanup']} onClick={onPreviewCleanup} type="button">
              {busyMap['settings:preview-cleanup'] ? 'Scanning...' : 'Preview cleanup'}
            </button>
            <button className="primary-button" disabled={busyMap['settings:run-cleanup'] || !cleanupPreview?.totalEntries} onClick={onRunCleanup} type="button">
              {busyMap['settings:run-cleanup'] ? 'Cleaning...' : 'Delete selected leftovers'}
            </button>
          </div>
        </div>

        {cleanupPreview ? (
          cleanupPreview.totalEntries ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4 text-sm text-slate-300">
                Local AI Hub can remove {cleanupPreview.totalEntries} leftover item{cleanupPreview.totalEntries === 1 ? '' : 's'} and recover about {formatBytes(cleanupPreview.totalBytes)}.
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                {cleanupPreview.categories.map((category) => (
                  <CategoryList category={category} key={category.id} />
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-6 rounded-3xl border border-emerald-300/20 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Local AI Hub did not find duplicate installs or approved leftover files in the scanned storage folders.
            </div>
          )
        ) : (
          <div className="mt-6 rounded-3xl border border-dashed border-white/15 bg-white/5 p-6 text-sm leading-7 text-slate-400">
            Run a preview to see exactly what Local AI Hub would delete, grouped by category and file path, before anything is removed.
          </div>
        )}
      </div>
    </section>
  );
}
