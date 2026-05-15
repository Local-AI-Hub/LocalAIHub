import { useEffect, useState } from 'react';
import { formatBytes, formatDiskAvailability } from '../lib/formatters';

const PROMPT_STYLE_EMPTY_DRAFT = Object.freeze({
  id: '',
  name: '',
  description: '',
  targetKind: 'image',
  positivePrefix: '',
  requiredTermsText: '',
  positiveSuffix: '',
  negativePrompt: '',
  placement: 'suffix',
});

function splitPromptStyleTerms(value) {
  return String(value || '').split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean);
}

function promptStyleToDraft(style = null) {
  if (!style) return { ...PROMPT_STYLE_EMPTY_DRAFT };
  return {
    id: style.id || '',
    name: style.name || '',
    description: style.description || '',
    targetKind: Array.isArray(style.targetKinds) ? style.targetKinds[0] || style.targetKind || 'any' : style.targetKind || 'any',
    positivePrefix: style.positivePrefix || '',
    requiredTermsText: Array.isArray(style.requiredTerms) ? style.requiredTerms.join('\n') : '',
    positiveSuffix: style.positiveSuffix || '',
    negativePrompt: style.negativePrompt || '',
    placement: style.placement || 'suffix',
  };
}

function buildPromptStylePayload(draft) {
  return {
    id: draft.id || undefined,
    name: draft.name,
    description: draft.description,
    targetKind: draft.targetKind || 'any',
    targetKinds: [draft.targetKind || 'any'],
    positivePrefix: draft.positivePrefix,
    requiredTerms: splitPromptStyleTerms(draft.requiredTermsText),
    positiveSuffix: draft.positiveSuffix,
    negativePrompt: draft.negativePrompt,
    placement: draft.placement || 'suffix',
    dedupe: true,
    lockRequiredTerms: true,
  };
}

function formatPromptStyleTarget(style) {
  const kinds = Array.isArray(style?.targetKinds) ? style.targetKinds : [style?.targetKind || 'any'];
  return kinds.join(', ');
}

function buildSuggestedRoot(mount) {
  const normalizedMount = String(mount || '').replace(/[\\/]*$/, '\\');
  return `${normalizedMount}LocalAIHub`;
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
  busyMap,
  cleanupPreview,
  closeBehaviorDraft,
  liveResourcePollingDraft,
  onChangeCloseBehavior,
  onChangeLiveResourcePolling,
  onChangePreferredInstallRootDraft,
  onChangeStorageDraft,
  onChoosePreferredInstallFolder,
  onChooseStorageFolder,
  onDismissLegacyMigration,
  onMigrateLegacyStorage,
  onPreviewCleanup,
  onRunCleanup,
  onDeletePromptStyle,
  onSaveCloseBehavior,
  onSavePromptStyle,
  onSaveLiveResourcePolling,
  onSavePreferredInstallRoot,
  onSaveStorageLocation,
  preferredInstallRootDraft,
  promptStyles = [],
  storage,
  storageDraft,
}) {
  const [openSection, setOpenSection] = useState('storage');
  const [promptStyleDraft, setPromptStyleDraft] = useState(() => promptStyleToDraft(null));
  const legacyMigration = storage?.legacyMigration;
  const currentPreferredInstallRoot = storage?.preferredInstallRoot || storage?.managedRoot || '';
  const usingManagedStorageAsDefault = !storage?.customPreferredInstallRoot || currentPreferredInstallRoot === storage?.managedRoot;

  useEffect(() => {
    if (cleanupPreview) {
      setOpenSection('cleanup');
    }
  }, [cleanupPreview]);

  async function savePromptStyleDraft() {
    if (!promptStyleDraft.name.trim()) {
      return;
    }
    const saved = await onSavePromptStyle?.(buildPromptStylePayload(promptStyleDraft));
    if (saved) {
      setPromptStyleDraft(promptStyleToDraft(null));
    }
  }

  async function deletePromptStyle(id) {
    const removed = await onDeletePromptStyle?.(id);
    if (removed && promptStyleDraft.id === id) {
      setPromptStyleDraft(promptStyleToDraft(null));
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
          <button className="primary-button" disabled={busyMap['settings:save-close-behavior']} onClick={onSaveCloseBehavior} type="button">
            {busyMap['settings:save-close-behavior'] ? 'Saving...' : 'Save close behavior'}
          </button>
        )}
        eyebrow="Window behavior"
        id="window"
        openSection={openSection}
        setOpenSection={setOpenSection}
        summary="Choose whether closing the window hides Local AI Hub to the tray or exits and cleans up owned helpers."
        title="Close button and background polling"
      >
        <div className="grid gap-3 md:grid-cols-2">
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
            <button className="primary-button" disabled={busyMap['settings:save-live-resource-polling']} onClick={onSaveLiveResourcePolling} type="button">
              {busyMap['settings:save-live-resource-polling'] ? 'Saving...' : 'Save live polling'}
            </button>
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
      </SettingsSection>

      <SettingsSection
        action={(
          <button className="primary-button" disabled={busyMap['settings:save-prompt-style'] || !promptStyleDraft.name.trim()} onClick={savePromptStyleDraft} type="button">
            {busyMap['settings:save-prompt-style'] ? 'Saving...' : promptStyleDraft.id ? 'Save style' : 'Create style'}
          </button>
        )}
        eyebrow="Prompt rules"
        id="prompt-styles"
        openSection={openSection}
        setOpenSection={setOpenSection}
        summary="Create deterministic prompt style presets for image, audio, video, text, or any prompt-driven step."
        title="Prompt Style Presets"
      >
        <div className="grid gap-3 xl:grid-cols-[0.9fr,1.1fr]">
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Saved styles</p>
              <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setPromptStyleDraft(promptStyleToDraft(null))} type="button">New style</button>
            </div>
            <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
              {promptStyles.length ? promptStyles.map((style) => (
                <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3" key={style.id}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-white">{style.name}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{formatPromptStyleTarget(style)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setPromptStyleDraft(promptStyleToDraft(style))} type="button">Edit</button>
                      <button className="ghost-button px-3 py-1.5 text-xs" disabled={busyMap['settings:delete-prompt-style']} onClick={() => deletePromptStyle(style.id)} type="button">Delete</button>
                    </div>
                  </div>
                  {style.requiredTerms?.length ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{style.requiredTerms.join(', ')}</p> : null}
                </div>
              )) : (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-4 text-sm leading-6 text-slate-400">No prompt styles saved yet.</div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-name">Name</label><input className="store-input mt-3" id="prompt-style-name" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, name: event.target.value }))} value={promptStyleDraft.name} /></div>
              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-target">Target</label><select className="store-input mt-3" id="prompt-style-target" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, targetKind: event.target.value }))} value={promptStyleDraft.targetKind}><option value="image">Image</option><option value="audio">Audio</option><option value="video">Video</option><option value="text">Text</option><option value="any">Any</option></select></div>
            </div>
            <div className="mt-3"><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-description">Description</label><input className="store-input mt-3" id="prompt-style-description" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, description: event.target.value }))} value={promptStyleDraft.description} /></div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-prefix">Positive prefix</label><textarea className="store-input mt-3 min-h-[84px] resize-none" id="prompt-style-prefix" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, positivePrefix: event.target.value }))} value={promptStyleDraft.positivePrefix} /></div>
              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-suffix">Positive suffix</label><textarea className="store-input mt-3 min-h-[84px] resize-none" id="prompt-style-suffix" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, positiveSuffix: event.target.value }))} value={promptStyleDraft.positiveSuffix} /></div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-terms">Required terms</label><textarea className="store-input mt-3 min-h-[130px] resize-none" id="prompt-style-terms" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, requiredTermsText: event.target.value }))} placeholder="anime film still\nhand-painted background" value={promptStyleDraft.requiredTermsText} /></div>
              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-negative">Negative prompt</label><textarea className="store-input mt-3 min-h-[130px] resize-none" id="prompt-style-negative" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, negativePrompt: event.target.value }))} placeholder="photorealistic, 3d render" value={promptStyleDraft.negativePrompt} /></div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-placement">Required term placement</label><select className="store-input mt-3" id="prompt-style-placement" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, placement: event.target.value }))} value={promptStyleDraft.placement}><option value="suffix">Suffix</option><option value="prefix">Prefix</option></select></div>
              <div className="flex items-end gap-2"><button className="primary-button" disabled={busyMap['settings:save-prompt-style'] || !promptStyleDraft.name.trim()} onClick={savePromptStyleDraft} type="button">{busyMap['settings:save-prompt-style'] ? 'Saving...' : promptStyleDraft.id ? 'Save style' : 'Create style'}</button><button className="ghost-button" onClick={() => setPromptStyleDraft(promptStyleToDraft(null))} type="button">Clear</button></div>
            </div>
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