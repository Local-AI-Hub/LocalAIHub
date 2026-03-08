function fileNameFromPath(value) {
  return String(value || '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

const MODEL_OPTIONS = [
  { id: 'tiny', label: 'Tiny' },
  { id: 'base', label: 'Base' },
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large-v3', label: 'Large v3' },
];

export default function WhisperPanel({
  busy,
  filePath,
  modelName,
  notice,
  onChangeModel,
  onChooseFile,
  onHide,
  onLaunch,
  onStop,
  onTranscribe,
  segments,
  tool,
  transcript,
}) {
  const isRunning = tool?.status === 'running';
  const selectedFileName = fileNameFromPath(filePath);

  return (
    <section className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Whisper</p>
          <h3 className="mt-3 text-3xl font-semibold tracking-tight text-white">Transcribe audio locally inside Local AI Hub</h3>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
            Choose an audio file, pick a Whisper model size, and run local transcription without leaving the app.
            The first run for a model size may take longer while the model cache is prepared.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {isRunning ? (
            <button className="ghost-button" disabled={busy} onClick={() => onStop(tool.id)} type="button">
              {busy ? 'Stopping...' : 'Stop Whisper'}
            </button>
          ) : (
            <button className="primary-button" disabled={busy} onClick={() => onLaunch(tool.id)} type="button">
              {busy ? 'Launching...' : 'Launch Whisper'}
            </button>
          )}
          <button className="ghost-button" onClick={onHide} type="button">
            Hide transcription
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[320px,1fr]">
        <aside className="rounded-[30px] border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Transcription setup</p>

          <div className="mt-4 space-y-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Model size</p>
              <select className="store-input mt-3" disabled={busy} onChange={(event) => onChangeModel(event.target.value)} value={modelName}>
                {MODEL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Audio file</p>
              <p className="mt-3 break-all text-sm leading-6 text-slate-300">
                {selectedFileName || 'No audio file selected yet.'}
              </p>
              {filePath ? <p className="mt-2 break-all text-xs leading-5 text-slate-500">{filePath}</p> : null}
              <button className="ghost-button mt-4 w-full justify-center" disabled={busy} onClick={onChooseFile} type="button">
                {selectedFileName ? 'Choose another file' : 'Choose audio file'}
              </button>
            </div>

            <button
              className="primary-button w-full justify-center"
              disabled={!isRunning || !filePath || busy}
              onClick={onTranscribe}
              type="button"
            >
              {busy ? 'Transcribing...' : 'Transcribe'}
            </button>

            <p className="text-sm leading-6 text-slate-300">
              {notice || (isRunning ? 'Pick a file and start transcription.' : 'Launch Whisper to enable the built-in transcription tools.')}
            </p>
          </div>
        </aside>

        <div className="rounded-[30px] border border-white/10 bg-slate-950/35 p-4">
          <div className="grid gap-4 xl:grid-cols-[1fr,320px]">
            <div className="rounded-[26px] border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Transcript</p>
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{modelName}</p>
              </div>
              <textarea
                className="store-input mt-4 min-h-[380px] resize-none"
                readOnly
                value={transcript || ''}
                placeholder="Your local transcript will appear here."
              />
            </div>

            <div className="rounded-[26px] border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Segments</p>
              <div className="mt-4 space-y-3">
                {segments.length ? (
                  segments.map((segment, index) => (
                    <div key={`${segment.start}-${segment.end}-${index}`} className="rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                        {segment.start}s to {segment.end}s
                      </p>
                      <p className="mt-2 text-sm leading-6 text-slate-200">{segment.text}</p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/35 px-4 py-6 text-sm leading-6 text-slate-400">
                    Run a transcription to see timed segments here.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
