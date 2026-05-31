import { useEffect, useMemo, useRef, useState } from 'react';

const LIBRARY_TABS = [
  {
    type: 'soundEffects',
    label: 'Sound Effects',
    copy: 'Import audio files you own or have permission to use. These libraries can be used by future Media Composition sound-effect tools.',
    emptyLibrary: 'No sound effect libraries yet.',
    emptyItems: 'No sound effects imported yet.',
  },
  {
    type: 'fonts',
    label: 'Fonts',
    copy: 'Import font files you own or have permission to use. These libraries can be used by future caption/title tools.',
    emptyLibrary: 'No font libraries yet.',
    emptyItems: 'No fonts imported yet.',
  },
  {
    type: 'colorPalettes',
    label: 'Color Palettes',
    copy: 'Create reusable color palettes for future caption/title styling.',
    emptyLibrary: 'No color palette libraries yet.',
    emptyItems: 'No colors saved yet.',
  },
];

const EMPTY_COLOR_DRAFT = Object.freeze({ id: '', name: '', hex: '#22D3EE' });
const FONT_SAMPLE_TEXT = 'The quick brown fox jumps over 13 lazy dogs.';

function formatTimestamp(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return '';
  }
}

function formatSoundMetadata(item) {
  const parts = [];
  if (Number.isFinite(Number(item.durationSeconds))) parts.push(`${Number(item.durationSeconds).toFixed(2)}s`);
  if (Number.isFinite(Number(item.sampleRate))) parts.push(`${item.sampleRate} Hz`);
  if (Number.isFinite(Number(item.channels))) parts.push(`${item.channels} channel${Number(item.channels) === 1 ? '' : 's'}`);
  return parts.join(' / ');
}

function getFontFormat(item) {
  return String(item?.extension || '').toLowerCase() === '.otf' ? 'opentype' : 'truetype';
}

function ColorSwatch({ hex }) {
  return <span className="h-6 w-6 shrink-0 rounded-lg border border-white/15" style={{ backgroundColor: hex || '#000000' }} />;
}

export default function AssetLibraryManager({ onToast }) {
  const [activeType, setActiveType] = useState('soundEffects');
  const [librariesByType, setLibrariesByType] = useState({ soundEffects: [], fonts: [], colorPalettes: [] });
  const [selectedByType, setSelectedByType] = useState({ soundEffects: '', fonts: '', colorPalettes: '' });
  const [newLibraryName, setNewLibraryName] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [colorDraft, setColorDraft] = useState({ ...EMPTY_COLOR_DRAFT });
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [previewingSoundId, setPreviewingSoundId] = useState('');
  const [previewBusyId, setPreviewBusyId] = useState('');
  const [fontPreviewStatus, setFontPreviewStatus] = useState({});
  const audioRef = useRef(null);

  const activeTab = useMemo(() => LIBRARY_TABS.find((tab) => tab.type === activeType) || LIBRARY_TABS[0], [activeType]);
  const libraries = librariesByType[activeType] || [];
  const selectedLibrary = libraries.find((library) => library.id === selectedByType[activeType]) || libraries[0] || null;
  const isPalette = activeType === 'colorPalettes';
  const fontPreviewItems = useMemo(() => {
    if (activeType !== 'fonts' || !selectedLibrary?.items?.length) return [];
    return selectedLibrary.items.filter((item) => item.previewUrl && item.fontPreviewFamily);
  }, [activeType, selectedLibrary]);
  const fontPreviewCss = useMemo(() => fontPreviewItems.map((item) => `@font-face { font-family: "${item.fontPreviewFamily}"; src: url("${item.previewUrl}") format("${getFontFormat(item)}"); font-display: swap; }`).join('\n'), [fontPreviewItems]);

  useEffect(() => {
    loadLibraries(activeType, { silent: true });
  }, [activeType]);

  useEffect(() => {
    if (selectedLibrary) {
      setRenameDraft(selectedLibrary.name || '');
    } else {
      setRenameDraft('');
    }
  }, [selectedLibrary?.id, selectedLibrary?.name]);

  useEffect(() => {
    if (activeType !== 'soundEffects') {
      stopSoundPreview();
      return;
    }
    if (previewingSoundId && !selectedLibrary?.items?.some((item) => item.id === previewingSoundId)) {
      stopSoundPreview();
    }
  }, [activeType, selectedLibrary?.id, selectedLibrary?.items, previewingSoundId]);

  useEffect(() => () => stopSoundPreview(), []);

  useEffect(() => {
    let cancelled = false;
    if (activeType !== 'fonts' || !fontPreviewItems.length || typeof document === 'undefined' || !document.fonts) {
      setFontPreviewStatus({});
      return () => {
        cancelled = true;
      };
    }

    setFontPreviewStatus(Object.fromEntries(fontPreviewItems.map((item) => [item.id, 'loading'])));
    fontPreviewItems.forEach((item) => {
      document.fonts.load(`18px "${item.fontPreviewFamily}"`, FONT_SAMPLE_TEXT)
        .then((faces) => {
          if (!cancelled) {
            setFontPreviewStatus((current) => ({ ...current, [item.id]: faces.length ? 'ready' : 'failed' }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFontPreviewStatus((current) => ({ ...current, [item.id]: 'failed' }));
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [activeType, fontPreviewItems]);

  function stopSoundPreview() {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
    }
    setPreviewingSoundId('');
    setPreviewBusyId('');
  }

  function applyLibraries(type, nextLibraries, preferredLibraryId = '') {
    const normalizedLibraries = Array.isArray(nextLibraries) ? nextLibraries : [];
    setLibrariesByType((current) => ({ ...current, [type]: normalizedLibraries }));
    setSelectedByType((current) => {
      const currentId = current[type];
      const nextId = preferredLibraryId && normalizedLibraries.some((library) => library.id === preferredLibraryId)
        ? preferredLibraryId
        : normalizedLibraries.some((library) => library.id === currentId)
          ? currentId
          : normalizedLibraries[0]?.id || '';
      return { ...current, [type]: nextId };
    });
  }

  async function runLibraryAction(key, action, successMessage = '') {
    setBusyKey(key);
    setError('');
    try {
      const result = await action();
      if (!result?.ok) {
        const message = result?.message || 'Local AI Hub could not update asset libraries.';
        setError(message);
        onToast?.(message, 'error');
        return null;
      }
      if (successMessage) onToast?.(successMessage, 'success');
      return result.data || {};
    } catch (caughtError) {
      const message = caughtError?.message || 'Local AI Hub could not update asset libraries.';
      setError(message);
      onToast?.(message, 'error');
      return null;
    } finally {
      setBusyKey('');
    }
  }

  async function loadLibraries(type = activeType, options = {}) {
    const data = await runLibraryAction(`load:${type}`, () => window.localAIHub.listAssetLibraries(type));
    if (data?.libraries) {
      applyLibraries(type, data.libraries);
      if (!options.silent) onToast?.('Asset libraries refreshed.', 'success');
    }
  }

  async function createLibrary() {
    if (!newLibraryName.trim()) {
      setError('Enter a library name first.');
      return;
    }
    const data = await runLibraryAction('create-library', () => window.localAIHub.createAssetLibrary({ type: activeType, name: newLibraryName }), 'Asset library created.');
    if (data?.libraries) {
      applyLibraries(activeType, data.libraries, data.library?.id);
      setNewLibraryName('');
    }
  }

  async function renameLibrary() {
    if (!selectedLibrary || !renameDraft.trim()) return;
    const data = await runLibraryAction('rename-library', () => window.localAIHub.renameAssetLibrary({ type: activeType, libraryId: selectedLibrary.id, name: renameDraft }), 'Asset library renamed.');
    if (data?.libraries) applyLibraries(activeType, data.libraries, data.library?.id);
  }

  async function deleteLibrary() {
    if (!selectedLibrary) return;
    const confirmed = window.localAIHub.showConfirmDialog?.({ message: `Delete ${selectedLibrary.name}? This only removes its managed library folder.` });
    if (!confirmed?.ok || !confirmed.data) return;
    if (activeType === 'soundEffects') stopSoundPreview();
    const data = await runLibraryAction('delete-library', () => window.localAIHub.deleteAssetLibrary({ type: activeType, libraryId: selectedLibrary.id }), 'Asset library deleted.');
    if (data?.libraries) applyLibraries(activeType, data.libraries);
  }

  async function importFiles() {
    if (!selectedLibrary || isPalette) return;
    const picked = await runLibraryAction('pick-files', () => window.localAIHub.pickAssetLibraryFiles({ type: activeType }));
    if (!picked || picked.canceled || !picked.filePaths?.length) return;
    const data = await runLibraryAction('import-items', () => window.localAIHub.importAssetLibraryItems({ type: activeType, libraryId: selectedLibrary.id, files: picked.filePaths }), 'Files imported into the managed library.');
    if (data?.libraries) applyLibraries(activeType, data.libraries, selectedLibrary.id);
  }

  async function removeItem(item) {
    if (!selectedLibrary || !item?.id) return;
    if (activeType === 'soundEffects' && previewingSoundId === item.id) stopSoundPreview();
    const data = await runLibraryAction('remove-item', () => window.localAIHub.removeAssetLibraryItem({ type: activeType, libraryId: selectedLibrary.id, itemId: item.id }), 'Library item removed.');
    if (data?.libraries) applyLibraries(activeType, data.libraries, selectedLibrary.id);
    if (colorDraft.id === item.id) setColorDraft({ ...EMPTY_COLOR_DRAFT });
  }

  async function playSoundPreview(item) {
    if (!selectedLibrary || !item?.id) return;
    if (previewingSoundId === item.id) {
      stopSoundPreview();
      return;
    }

    stopSoundPreview();
    setPreviewBusyId(item.id);
    setError('');
    const preview = await window.localAIHub.getAssetLibraryItemPreview({ type: 'soundEffects', libraryId: selectedLibrary.id, itemId: item.id });
    if (!preview?.ok || !preview.data?.previewUrl) {
      const message = preview?.message || 'Local AI Hub could not prepare that sound preview.';
      setError(message);
      onToast?.(message, 'error');
      setPreviewBusyId('');
      return;
    }

    const audio = new Audio(preview.data.previewUrl);
    audioRef.current = audio;
    audio.onended = () => stopSoundPreview();
    audio.onerror = () => {
      stopSoundPreview();
      const message = 'Local AI Hub could not play that sound preview. The managed file may be missing or unsupported.';
      setError(message);
      onToast?.(message, 'error');
    };

    try {
      await audio.play();
      setPreviewingSoundId(item.id);
      setPreviewBusyId('');
    } catch {
      stopSoundPreview();
      const message = 'Local AI Hub could not play that sound preview. The managed file may be missing or unsupported.';
      setError(message);
      onToast?.(message, 'error');
    }
  }

  async function saveColor() {
    if (!selectedLibrary) return;
    if (!colorDraft.name.trim()) {
      setError('Enter a color name first.');
      return;
    }
    const data = await runLibraryAction('save-color', () => window.localAIHub.updateColorPaletteItem({ libraryId: selectedLibrary.id, item: colorDraft }), colorDraft.id ? 'Color updated.' : 'Color added.');
    if (data?.libraries) {
      applyLibraries(activeType, data.libraries, selectedLibrary.id);
      setColorDraft({ ...EMPTY_COLOR_DRAFT });
    }
  }

  return (
    <div className="space-y-3">
      {fontPreviewCss ? <style>{fontPreviewCss}</style> : null}
      <div className="flex flex-wrap gap-2">
        {LIBRARY_TABS.map((tab) => (
          <button
            className={`ghost-button px-3 py-1.5 text-xs ${activeType === tab.type ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100' : ''}`}
            key={tab.type}
            onClick={() => setActiveType(tab.type)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-3 text-sm leading-6 text-cyan-50">
        {activeTab.copy}
      </div>
      {error ? <div className="rounded-2xl border border-rose-400/25 bg-rose-400/10 p-3 text-sm leading-6 text-rose-100">{error}</div> : null}

      <div className="grid gap-3 xl:grid-cols-[0.85fr,1.15fr]">
        <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{activeTab.label} libraries</p>
            <button className="ghost-button px-3 py-1.5 text-xs" disabled={busyKey === `load:${activeType}`} onClick={() => loadLibraries(activeType)} type="button">
              Refresh
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            <input className="store-input" onChange={(event) => setNewLibraryName(event.target.value)} placeholder="New library name" value={newLibraryName} />
            <button className="primary-button shrink-0" disabled={busyKey === 'create-library' || !newLibraryName.trim()} onClick={createLibrary} type="button">
              Create
            </button>
          </div>
          <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
            {libraries.length ? libraries.map((library) => (
              <button
                className={`w-full rounded-2xl border px-3 py-3 text-left transition ${selectedLibrary?.id === library.id ? 'border-cyan-300/40 bg-cyan-300/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
                key={library.id}
                onClick={() => setSelectedByType((current) => ({ ...current, [activeType]: library.id }))}
                type="button"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">{library.name}</p>
                    <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{library.items?.length || 0} item{library.items?.length === 1 ? '' : 's'}</p>
                  </div>
                  {library.manifestStatus && library.manifestStatus !== 'ok' ? <span className="status-pill border-amber-300/20 bg-amber-300/10 text-amber-100">{library.manifestStatus}</span> : null}
                </div>
              </button>
            )) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-4 text-sm leading-6 text-slate-400">{activeTab.emptyLibrary}</div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
          {selectedLibrary ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Selected library</p>
                  <h4 className="mt-1 truncate text-xl font-semibold text-white">{selectedLibrary.name}</h4>
                  {selectedLibrary.manifestMessage ? <p className="mt-2 text-sm leading-6 text-amber-100">{selectedLibrary.manifestMessage}</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {!isPalette ? <button className="primary-button" disabled={busyKey === 'pick-files' || busyKey === 'import-items'} onClick={importFiles} type="button">Import files</button> : null}
                  <button className="ghost-button" disabled={busyKey === 'delete-library'} onClick={deleteLibrary} type="button">Delete library</button>
                </div>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr,auto]">
                <input className="store-input" onChange={(event) => setRenameDraft(event.target.value)} value={renameDraft} />
                <button className="primary-button" disabled={busyKey === 'rename-library' || !renameDraft.trim()} onClick={renameLibrary} type="button">Rename</button>
              </div>

              {isPalette ? (
                <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{colorDraft.id ? 'Edit color' : 'Add color'}</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-[1fr,150px,auto,auto]">
                    <input className="store-input" onChange={(event) => setColorDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="Color name" value={colorDraft.name} />
                    <input className="store-input" onChange={(event) => setColorDraft((draft) => ({ ...draft, hex: event.target.value }))} placeholder="#22D3EE" value={colorDraft.hex} />
                    <button className="primary-button" disabled={busyKey === 'save-color' || !colorDraft.name.trim()} onClick={saveColor} type="button">{colorDraft.id ? 'Save' : 'Add'}</button>
                    <button className="ghost-button" onClick={() => setColorDraft({ ...EMPTY_COLOR_DRAFT })} type="button">Clear</button>
                  </div>
                </div>
              ) : null}

              <div className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                {selectedLibrary.items?.length ? selectedLibrary.items.map((item) => {
                  const fontReady = fontPreviewStatus[item.id] === 'ready';
                  const fontFailed = fontPreviewStatus[item.id] === 'failed';
                  return (
                    <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3" key={item.id}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            {isPalette ? <ColorSwatch hex={item.hex} /> : null}
                            <p className="truncate text-sm font-medium text-white">{isPalette ? item.name : item.displayName}</p>
                          </div>
                          {isPalette ? (
                            <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{item.hex}</p>
                          ) : (
                            <p className="mt-1 truncate text-xs uppercase tracking-[0.18em] text-slate-500">{item.extension} / {item.originalFilename}</p>
                          )}
                          {activeType === 'soundEffects' && formatSoundMetadata(item) ? <p className="mt-2 text-xs leading-5 text-slate-300">{formatSoundMetadata(item)}</p> : null}
                          {activeType === 'fonts' && item.fontFamily ? <p className="mt-2 text-xs leading-5 text-slate-300">Family: {item.fontFamily}</p> : null}
                          {activeType === 'fonts' ? (
                            <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-3">
                              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Preview</p>
                              <p className="mt-2 text-lg leading-7 text-white" style={fontReady ? { fontFamily: `"${item.fontPreviewFamily}", 'Segoe UI', sans-serif` } : undefined}>
                                {FONT_SAMPLE_TEXT}
                              </p>
                              {fontFailed ? <p className="mt-2 text-xs leading-5 text-amber-100">Local AI Hub could not render this font preview, so fallback text is shown.</p> : null}
                            </div>
                          ) : null}
                          {formatTimestamp(item.updatedAt) ? <p className="mt-2 text-xs leading-5 text-slate-500">Updated {formatTimestamp(item.updatedAt)}</p> : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {activeType === 'soundEffects' ? (
                            <button className="ghost-button px-3 py-1.5 text-xs" disabled={previewBusyId === item.id} onClick={() => playSoundPreview(item)} type="button">
                              {previewBusyId === item.id ? 'Loading...' : previewingSoundId === item.id ? 'Stop' : 'Play'}
                            </button>
                          ) : null}
                          {isPalette ? <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setColorDraft({ id: item.id, name: item.name, hex: item.hex })} type="button">Edit</button> : null}
                          <button className="ghost-button px-3 py-1.5 text-xs" disabled={busyKey === 'remove-item'} onClick={() => removeItem(item)} type="button">Remove</button>
                        </div>
                      </div>
                    </div>
                  );
                }) : (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-4 text-sm leading-6 text-slate-400">{activeTab.emptyItems}</div>
                )}
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-6 text-sm leading-6 text-slate-400">
              Create a {activeTab.label.toLowerCase()} library to start managing assets.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
