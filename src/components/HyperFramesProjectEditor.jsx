import React, { useEffect, useMemo, useState } from 'react';

function safeText(value, fallback = '') {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function normalizeSlash(value) {
  return safeText(value).replace(/\\/g, '/');
}

function formatBytes(value) {
  const bytes = Number(value || 0) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function getApiMethod(name) {
  const api = typeof window !== 'undefined' ? window.localAIHub : null;
  const method = api && typeof api[name] === 'function' ? api[name] : null;
  if (!method) throw new Error('HyperFrames project editing is not available in this Local AI Hub build.');
  return method;
}

function messageFrom(result, fallback) {
  return safeText(result?.message || result?.error || result?.data?.message, fallback);
}

function normalizeFile(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const relativePath = normalizeSlash(source.relativePath);
  return {
    kind: source.kind === 'directory' ? 'directory' : 'file',
    name: safeText(source.name, relativePath.split('/').pop() || relativePath),
    relativePath,
    sizeBytes: Number(source.sizeBytes || 0) || 0,
    extension: safeText(source.extension).toLowerCase(),
    editable: Boolean(source.editable),
    supported: source.supported !== false,
    reference: normalizeSlash(source.reference || relativePath),
  };
}

function normalizeHealth(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    runnable: Boolean(source.runnable),
    message: safeText(source.message, 'Project health has not been checked yet.'),
    entrypointExists: Boolean(source.entrypointExists),
    manifestValid: Boolean(source.manifestValid),
    localOnly: Boolean(source.localOnly),
    bounds: source.bounds && typeof source.bounds === 'object' ? source.bounds : {},
    damaged: Array.isArray(source.damaged) ? source.damaged.map((entry) => safeText(entry)).filter(Boolean) : [],
    unsafePaths: Array.isArray(source.unsafePaths) ? source.unsafePaths.map((entry) => safeText(entry)).filter(Boolean) : [],
    unsupportedAssets: Array.isArray(source.unsupportedAssets) ? source.unsupportedAssets.map(normalizeSlash).filter(Boolean) : [],
  };
}

function indentFor(relativePath) {
  const depth = normalizeSlash(relativePath).split('/').filter(Boolean).length - 1;
  return { paddingLeft: `${Math.max(0, depth) * 14}px` };
}

export default function HyperFramesProjectEditor({ project, onClose, onProjectsChanged, onToast }) {
  const projectId = safeText(project?.projectId);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [selectedFile, setSelectedFile] = useState('');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');

  const files = useMemo(() => (Array.isArray(state?.files) ? state.files.map(normalizeFile) : []), [state]);
  const assets = useMemo(() => (Array.isArray(state?.assets) ? state.assets.map(normalizeFile) : []), [state]);
  const health = useMemo(() => normalizeHealth(state?.health), [state]);
  const dirty = content !== savedContent;

  useEffect(() => {
    loadEditor({ selectDefault: true });
  }, [projectId]);

  function confirmDiscard() {
    return !dirty || window.confirm('Discard unsaved HyperFrames editor changes?');
  }

  async function loadEditor(options = {}) {
    if (!projectId) return null;
    setBusy('load');
    setError('');
    try {
      const result = await getApiMethod('getHyperFramesProjectEditorState')({ projectId });
      if (!result?.ok) throw new Error(messageFrom(result, 'Local AI Hub could not load that HyperFrames project editor.'));
      const nextState = result.data || {};
      setState(nextState);
      if (options.selectDefault) {
        const nextFiles = Array.isArray(nextState.files) ? nextState.files.map(normalizeFile) : [];
        const first = nextFiles.find((file) => file.relativePath === 'index.html' && file.editable) || nextFiles.find((file) => file.editable);
        if (first) await openFile(first.relativePath, { skipDirtyCheck: true });
      }
      return nextState;
    } catch (caught) {
      const message = safeText(caught?.message, 'Local AI Hub could not load that HyperFrames project editor.');
      setError(message);
      onToast?.(message, 'error');
      return null;
    } finally {
      setBusy('');
    }
  }

  async function openFile(relativePath, options = {}) {
    const safePath = normalizeSlash(relativePath);
    if (!safePath || (!options.skipDirtyCheck && !confirmDiscard())) return;
    setBusy(`open:${safePath}`);
    setError('');
    try {
      const result = await getApiMethod('readHyperFramesProjectFile')({ projectId, relativePath: safePath });
      if (!result?.ok) throw new Error(messageFrom(result, 'Local AI Hub could not open that HyperFrames project file.'));
      const text = String(result.data?.content ?? '');
      setSelectedFile(safePath);
      setContent(text);
      setSavedContent(text);
      setStatus(`Opened ${safePath}.`);
    } catch (caught) {
      const message = safeText(caught?.message, 'Local AI Hub could not open that HyperFrames project file.');
      setError(message);
      onToast?.(message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function saveFile() {
    if (!selectedFile) return;
    setBusy('save');
    setError('');
    try {
      const result = await getApiMethod('saveHyperFramesProjectFile')({ projectId, relativePath: selectedFile, content });
      if (!result?.ok) throw new Error(messageFrom(result, 'Local AI Hub could not save that HyperFrames project file.'));
      const text = String(result.data?.file?.content ?? content);
      setContent(text);
      setSavedContent(text);
      setStatus('HyperFrames project file saved.');
      await loadEditor();
      await onProjectsChanged?.();
      onToast?.('HyperFrames project file saved.', 'success');
    } catch (caught) {
      const message = safeText(caught?.message, 'Local AI Hub could not save that HyperFrames project file.');
      setError(message);
      onToast?.(message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function createFile() {
    if (!confirmDiscard()) return;
    const relativePath = window.prompt('New HyperFrames text file path inside this project', 'notes.txt');
    if (!relativePath) return;
    setBusy('create-file');
    setError('');
    try {
      const result = await getApiMethod('createHyperFramesProjectFile')({ projectId, relativePath, content: '' });
      if (!result?.ok) throw new Error(messageFrom(result, 'Local AI Hub could not create that HyperFrames project file.'));
      await loadEditor();
      await openFile(result.data?.file?.relativePath || relativePath, { skipDirtyCheck: true });
      await onProjectsChanged?.();
      onToast?.('HyperFrames project file created.', 'success');
    } catch (caught) {
      const message = safeText(caught?.message, 'Local AI Hub could not create that HyperFrames project file.');
      setError(message);
      onToast?.(message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function mutateFile(label, relativePath, action, options = {}) {
    if (!relativePath || !confirmDiscard()) return;
    if (options.confirm && !window.confirm(options.confirm)) return;
    setBusy(`${label}:${relativePath}`);
    setError('');
    try {
      const result = await action();
      if (!result?.ok) throw new Error(messageFrom(result, `Local AI Hub could not ${label} that HyperFrames project file.`));
      setSelectedFile('');
      setContent('');
      setSavedContent('');
      setStatus(messageFrom(result, 'HyperFrames project file updated.'));
      await loadEditor();
      await onProjectsChanged?.();
      onToast?.('HyperFrames project updated.', 'success');
    } catch (caught) {
      const message = safeText(caught?.message, `Local AI Hub could not ${label} that HyperFrames project file.`);
      setError(message);
      onToast?.(message, 'error');
    } finally {
      setBusy('');
    }
  }

  function renameFile(file) {
    const newName = window.prompt('Rename this HyperFrames project file', file.name);
    if (!newName) return;
    mutateFile('rename', file.relativePath, () => getApiMethod('renameHyperFramesProjectFile')({ projectId, relativePath: file.relativePath, newName }));
  }

  function duplicateFile(file) {
    mutateFile('duplicate', file.relativePath, () => getApiMethod('duplicateHyperFramesProjectFile')({ projectId, relativePath: file.relativePath }));
  }

  function deleteFile(file) {
    mutateFile('delete', file.relativePath, () => getApiMethod('deleteHyperFramesProjectFile')({ projectId, relativePath: file.relativePath }), {
      confirm: `Delete ${file.relativePath}?\n\nReferences are not dependency-analyzed in this editor pass, so deleting files can break the composition.`,
    });
  }

  async function importAssets() {
    setBusy('import-assets');
    setError('');
    try {
      const result = await getApiMethod('pickHyperFramesProjectAssets')({ projectId, targetSubfolder: 'assets' });
      if (!result?.ok) throw new Error(messageFrom(result, 'Local AI Hub could not copy those assets.'));
      if (!result.data?.canceled) {
        setStatus(messageFrom(result, 'Assets copied into the managed HyperFrames project.'));
        await loadEditor();
        await onProjectsChanged?.();
        onToast?.('Assets copied into the managed HyperFrames project.', 'success');
      }
    } catch (caught) {
      const message = safeText(caught?.message, 'Local AI Hub could not copy those assets.');
      setError(message);
      onToast?.(message, 'error');
    } finally {
      setBusy('');
    }
  }

  function renameAsset(asset) {
    const newName = window.prompt('Rename this HyperFrames project asset', asset.name);
    if (!newName) return;
    mutateFile('rename', asset.relativePath, () => getApiMethod('renameHyperFramesProjectAsset')({ projectId, relativePath: asset.relativePath, newName }));
  }

  function duplicateAsset(asset) {
    mutateFile('duplicate', asset.relativePath, () => getApiMethod('duplicateHyperFramesProjectAsset')({ projectId, relativePath: asset.relativePath }));
  }

  function deleteAsset(asset) {
    mutateFile('delete', asset.relativePath, () => getApiMethod('deleteHyperFramesProjectAsset')({ projectId, relativePath: asset.relativePath }), {
      confirm: `Delete ${asset.relativePath}?\n\nReferences are not dependency-analyzed in this editor pass, so deleting assets can break the composition.`,
    });
  }

  async function copyAssetReference(asset) {
    const result = await getApiMethod('getHyperFramesProjectAssetReference')({ relativePath: asset.relativePath });
    if (!result?.ok) {
      const message = messageFrom(result, 'Local AI Hub could not copy that asset reference.');
      setError(message);
      onToast?.(message, 'error');
      return;
    }
    const reference = result.data?.reference || asset.reference || asset.relativePath;
    try {
      await navigator.clipboard?.writeText(reference);
      setStatus(`Copied ${reference}`);
      onToast?.('Asset reference copied.', 'success');
    } catch {
      setStatus(reference);
    }
  }

  const editableLimit = state?.limits?.maxEditableTextFileBytes || 0;
  const assetLimit = state?.limits?.maxAssetFileBytes || 0;

  return (
    <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-slate-950/40 p-3" data-hyperframes-project-editor="true">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.22em] text-cyan-200">Safe composition editor</p>
          <h4 className="mt-1 truncate text-lg font-semibold text-white">{project?.displayName || projectId}</h4>
          <p className="mt-2 text-xs leading-5 text-slate-400">Project-scoped file editing and local asset management. No live preview, webview, Studio, or AI authoring controls are included.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="ghost-button px-3 py-1.5 text-xs" disabled={Boolean(busy)} onClick={() => loadEditor()} type="button">Refresh</button>
          <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => { if (confirmDiscard()) onClose?.(); }} type="button">Close Editor</button>
        </div>
      </div>

      {error ? <div className="mt-3 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-3 text-sm leading-6 text-rose-100">{error}</div> : null}
      {status ? <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-xs leading-5 text-slate-300">{status}</div> : null}

      <div className="mt-3 grid gap-3 xl:grid-cols-[0.8fr,1.2fr]">
        <div className="space-y-3">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Project files</p>
              <button className="ghost-button px-3 py-1.5 text-xs" disabled={Boolean(busy)} onClick={createFile} type="button">New Text File</button>
            </div>
            <div className="mt-3 max-h-80 space-y-1 overflow-y-auto pr-1">
              {files.length ? files.map((file) => (
                <div className={`rounded-xl border px-2 py-2 text-xs ${selectedFile === file.relativePath ? 'border-cyan-300/40 bg-cyan-300/10' : 'border-white/10 bg-slate-950/30'}`} key={file.relativePath} style={indentFor(file.relativePath)}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button className={`min-w-0 text-left ${file.editable ? 'text-slate-100' : 'text-slate-500'}`} disabled={!file.editable || Boolean(busy)} onClick={() => openFile(file.relativePath)} type="button">
                      <span className="truncate">{file.kind === 'directory' ? 'Folder: ' : ''}{file.relativePath}</span>
                    </button>
                    {file.kind === 'file' ? <span className="text-slate-500">{formatBytes(file.sizeBytes)}</span> : null}
                  </div>
                  {file.kind === 'file' && file.relativePath !== 'project.json' ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button className="ghost-button px-2 py-1 text-[11px]" disabled={file.relativePath === 'index.html' || Boolean(busy)} onClick={() => renameFile(file)} type="button">Rename</button>
                      <button className="ghost-button px-2 py-1 text-[11px]" disabled={Boolean(busy)} onClick={() => duplicateFile(file)} type="button">Duplicate</button>
                      <button className="ghost-button px-2 py-1 text-[11px]" disabled={file.relativePath === 'index.html' || Boolean(busy)} onClick={() => deleteFile(file)} type="button">Delete</button>
                    </div>
                  ) : null}
                </div>
              )) : <p className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-3 text-sm text-slate-400">No project files found.</p>}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Assets</p>
              <button className="primary-button px-3 py-1.5 text-xs" disabled={busy === 'import-assets'} onClick={importAssets} type="button">Import Assets</button>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">Assets are copied into this project&apos;s assets folder. Duplicate names get a safe suffix instead of being overwritten. Limit {formatBytes(assetLimit)} per file.</p>
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
              {assets.length ? assets.map((asset) => (
                <div className="rounded-xl border border-white/10 bg-slate-950/30 px-2 py-2 text-xs" key={asset.relativePath}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-slate-100">{asset.relativePath}</p>
                      <p className="mt-1 text-slate-500">{asset.kind === 'directory' ? 'Folder' : `${asset.extension || 'file'} / ${formatBytes(asset.sizeBytes)}`}</p>
                    </div>
                    {asset.kind === 'file' ? (
                      <div className="flex flex-wrap gap-2">
                        <button className="ghost-button px-2 py-1 text-[11px]" onClick={() => copyAssetReference(asset)} type="button">Copy Reference</button>
                        <button className="ghost-button px-2 py-1 text-[11px]" onClick={() => renameAsset(asset)} type="button">Rename</button>
                        <button className="ghost-button px-2 py-1 text-[11px]" onClick={() => duplicateAsset(asset)} type="button">Duplicate</button>
                        <button className="ghost-button px-2 py-1 text-[11px]" onClick={() => deleteAsset(asset)} type="button">Delete</button>
                      </div>
                    ) : null}
                  </div>
                </div>
              )) : <p className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-3 text-sm text-slate-400">No project assets yet.</p>}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Editor</p>
                <p className="mt-1 truncate text-sm font-semibold text-white">{selectedFile || 'Choose an editable file'}</p>
                <p className="mt-1 text-xs text-slate-500">Editable types: {state?.allowedEditableExtensions?.join(', ') || '.html, .css, .js, .md, .txt'} / Limit {formatBytes(editableLimit)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="primary-button px-3 py-1.5 text-xs" disabled={!selectedFile || !dirty || busy === 'save'} onClick={saveFile} type="button">Save</button>
                <button className="ghost-button px-3 py-1.5 text-xs" disabled={!selectedFile || !dirty} onClick={() => { setContent(savedContent); setStatus('Unsaved changes discarded.'); }} type="button">Revert</button>
              </div>
            </div>
            {selectedFile ? (
              <textarea
                className="mt-3 h-[34rem] w-full resize-y rounded-2xl border border-white/10 bg-slate-950/70 p-3 font-mono text-sm leading-6 text-slate-100 outline-none focus:border-cyan-300/35"
                onChange={(event) => setContent(event.target.value)}
                spellCheck={false}
                value={content}
              />
            ) : (
              <div className="mt-3 rounded-2xl border border-dashed border-white/10 bg-slate-950/35 p-6 text-sm leading-6 text-slate-400">Select index.html, styles.css, script.js, README.md, or another approved text file to edit.</div>
            )}
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Project health</p>
            <div className={`mt-3 rounded-2xl border p-3 text-sm leading-6 ${health.runnable ? 'border-emerald-300/25 bg-emerald-300/10 text-emerald-50' : 'border-amber-300/25 bg-amber-300/10 text-amber-50'}`}>
              <p className="font-semibold text-white">{health.runnable ? 'Editor health checks pass' : 'Needs attention'}</p>
              <p className="mt-1">{health.message}</p>
            </div>
            <div className="mt-3 grid gap-2 text-xs leading-5 text-slate-300 sm:grid-cols-2">
              <p>Entrypoint: {health.entrypointExists ? 'index.html exists' : 'missing'}</p>
              <p>Manifest: {health.manifestValid ? 'valid' : 'needs attention'}</p>
              <p>Local-only scan: {health.localOnly ? 'passed' : 'needs attention'}</p>
              <p>Bounds: {health.bounds?.ok ? `${health.bounds.fileCount || 0} files / ${formatBytes(health.bounds.totalBytes || 0)}` : 'needs attention'}</p>
            </div>
            {health.unsupportedAssets.length ? <p className="mt-2 text-xs leading-5 text-amber-100">Unsupported assets: {health.unsupportedAssets.join(', ')}</p> : null}
            {health.unsafePaths.length ? <p className="mt-2 text-xs leading-5 text-amber-100">Unsafe paths: {health.unsafePaths.join(' ')}</p> : null}
            {health.damaged.length ? <p className="mt-2 text-xs leading-5 text-amber-100">Attention: {health.damaged.join(', ')}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
