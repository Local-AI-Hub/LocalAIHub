import { formatBytes, formatTimestamp } from '../lib/formatters';

function toneClass(tone) {
  if (tone === 'good') {
    return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100';
  }

  if (tone === 'warn') {
    return 'border-amber-300/20 bg-amber-300/10 text-amber-50';
  }

  return 'border-white/10 bg-white/5 text-slate-300';
}

export default function KoboldCppSetupDialog({
  busy,
  candidates,
  confirmLabel,
  loading,
  notice,
  onBrowse,
  onClose,
  onOpenFolder,
  onRefresh,
  onSave,
  onSelectModel,
  selectedModelPath,
  selectionStatus,
}) {
  if (!selectionStatus) {
    return null;
  }

  const selectedCandidate = (candidates || []).find((candidate) => candidate.filePath === selectedModelPath) || null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-5xl rounded-[32px] border border-white/10 bg-slate-950/95 p-6 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">KoboldCpp setup</p>
            <h2 className="mt-3 text-3xl font-semibold text-white">Choose the GGUF model Local AI Hub should launch.</h2>
            <p className="mt-3 text-sm leading-7 text-slate-300">
              Local AI Hub owns this one-time model choice so Launch can hand you straight into KoboldCpp's native UI instead of the raw file picker.
            </p>
          </div>
          <button className="ghost-button" disabled={busy} onClick={onClose} type="button">
            Close
          </button>
        </div>

        <div className={`mt-5 rounded-3xl border p-4 text-sm ${toneClass(selectionStatus.tone)}`}>
          <p className="font-medium text-white">{selectionStatus.summary}</p>
          <p className="mt-2 leading-6 opacity-90">{notice || selectionStatus.detail}</p>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button className="ghost-button" disabled={busy} onClick={onRefresh} type="button">
            {loading ? 'Refreshing...' : 'Refresh local models'}
          </button>
          <button className="ghost-button" disabled={busy} onClick={onBrowse} type="button">
            Browse for GGUF file
          </button>
          {onOpenFolder ? (
            <button className="ghost-button" disabled={busy} onClick={onOpenFolder} type="button">
              Open install folder
            </button>
          ) : null}
        </div>

        <div className="mt-6 rounded-3xl border border-white/10 bg-slate-950/35 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Detected GGUF files</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                Local AI Hub scans its managed models folder and LM Studio's models folder, and you can still browse to any other GGUF on this PC.
              </p>
            </div>
            <span className="status-pill border-white/10 bg-white/5 text-slate-300">{(candidates || []).length} found</span>
          </div>

          {loading ? (
            <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-4 text-sm text-cyan-50">
              Local AI Hub is scanning for GGUF models on this PC.
            </div>
          ) : candidates?.length ? (
            <div className="mt-5 max-h-[360px] space-y-3 overflow-y-auto pr-1">
              {candidates.map((candidate) => {
                const checked = candidate.filePath === selectedModelPath;
                return (
                  <label
                    key={candidate.id}
                    className={`flex cursor-pointer items-start gap-4 rounded-2xl border px-4 py-4 transition ${
                      checked
                        ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-50'
                        : candidate.launchReady
                          ? 'border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10'
                          : 'border-amber-300/20 bg-amber-300/10 text-amber-50'
                    }`}
                  >
                    <input
                      checked={checked}
                      className="mt-1 h-4 w-4 accent-cyan-300"
                      disabled={busy || !candidate.launchReady}
                      name="koboldcpp-model"
                      onChange={() => onSelectModel(candidate.filePath)}
                      type="radio"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="break-all text-sm font-medium text-white">{candidate.fileName}</p>
                        {candidate.selected ? (
                          <span className="status-pill border-white/10 bg-white/10 text-slate-200">Saved</span>
                        ) : null}
                        {!candidate.exists ? (
                          <span className="status-pill border-amber-300/20 bg-amber-300/10 text-amber-50">Missing</span>
                        ) : null}
                        {candidate.incompleteSplit ? (
                          <span className="status-pill border-amber-300/20 bg-amber-300/10 text-amber-50">Incomplete split</span>
                        ) : null}
                      </div>
                      <p className="mt-2 break-all text-xs leading-6 text-slate-400">{candidate.filePath}</p>
                      {candidate.statusDetail ? (
                        <p className="mt-2 text-xs leading-6 text-amber-100">{candidate.statusDetail}</p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
                        <span>{candidate.locationLabel}</span>
                        <span>{candidate.sizeBytes ? formatBytes(candidate.sizeBytes) : 'Size unknown'}</span>
                        <span>{candidate.modifiedAt ? `Updated ${formatTimestamp(candidate.modifiedAt)}` : 'Timestamp unavailable'}</span>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-300">
              No GGUF files were detected in Local AI Hub's managed models folder or LM Studio's models folder yet. Use Browse to pick a GGUF file from anywhere on this PC.
            </div>
          )}
        </div>

        <div className="mt-6 rounded-3xl border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Selected model</p>
          <p className="mt-3 break-all text-sm font-medium text-white">
            {selectedCandidate?.fileName || selectionStatus.fileName || 'No GGUF file selected yet.'}
          </p>
          <p className="mt-2 break-all text-xs leading-6 text-slate-400">
            {selectedModelPath || selectionStatus.filePath || 'Choose a saved model above or browse to a GGUF file.'}
          </p>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button className="ghost-button" disabled={busy} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="primary-button" disabled={busy || !selectedModelPath} onClick={onSave} type="button">
            {busy ? 'Saving...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

