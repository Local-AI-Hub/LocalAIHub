import { useEffect, useRef } from 'react';

function fileNameFromPath(value) {
  return String(value || '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

export default function AiderPanel({
  busy,
  draft,
  notice,
  onChangeDraft,
  onChooseProject,
  onHide,
  onLaunch,
  onSend,
  onStop,
  output,
  projectDir,
  tool,
}) {
  const outputRef = useRef(null);
  const isRunning = tool?.status === 'running';
  const projectLabel = fileNameFromPath(projectDir);

  useEffect(() => {
    const element = outputRef.current;
    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [output]);

  return (
    <section className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Aider</p>
          <h3 className="mt-3 text-3xl font-semibold tracking-tight text-white">Code with Aider inside Local AI Hub</h3>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
            Pick a project folder, launch Aider in its own managed Python environment, and keep the live terminal output inside Local AI Hub.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {isRunning ? (
            <button className="ghost-button" disabled={busy} onClick={() => onStop(tool.id)} type="button">
              {busy ? 'Stopping...' : 'Stop Aider'}
            </button>
          ) : (
            <button className="primary-button" disabled={busy || !projectDir} onClick={onLaunch} type="button">
              {busy ? 'Launching...' : 'Launch Aider'}
            </button>
          )}
          <button className="ghost-button" onClick={onHide} type="button">
            Hide console
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[320px,1fr]">
        <aside className="rounded-[30px] border border-white/10 bg-slate-950/35 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Session setup</p>

          <div className="mt-4 space-y-4">
            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Project folder</p>
              <p className="mt-3 break-all text-sm leading-6 text-slate-300">
                {projectLabel || 'No project folder selected yet.'}
              </p>
              {projectDir ? <p className="mt-2 break-all text-xs leading-5 text-slate-500">{projectDir}</p> : null}
              <button className="ghost-button mt-4 w-full justify-center" disabled={busy} onClick={onChooseProject} type="button">
                {projectDir ? 'Choose another folder' : 'Choose project folder'}
              </button>
            </div>

            <p className="text-sm leading-6 text-slate-300">
              {notice ||
                (isRunning
                  ? 'Aider is running. Type a prompt below to continue the session.'
                  : 'Choose a project folder and launch Aider to begin.')}
            </p>
          </div>
        </aside>

        <div className="rounded-[30px] border border-white/10 bg-slate-950/35 p-4">
          <div className="rounded-[26px] border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Console output</p>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{isRunning ? 'Live' : 'Idle'}</p>
            </div>
            <pre
              ref={outputRef}
              className="mt-4 min-h-[320px] max-h-[420px] overflow-y-auto rounded-[22px] border border-white/10 bg-slate-950/80 p-4 font-mono text-xs leading-6 text-slate-200 whitespace-pre-wrap"
            >
              {output || 'Aider console output will appear here.'}
            </pre>

            <div className="mt-4 grid gap-3 md:grid-cols-[1fr,140px]">
              <textarea
                className="store-input min-h-[110px] resize-none"
                disabled={!isRunning || busy}
                onChange={(event) => onChangeDraft(event.target.value)}
                placeholder={isRunning ? 'Ask Aider to inspect files, suggest a fix, or apply a change.' : 'Launch Aider to enable console input.'}
                value={draft}
              />
              <button className="primary-button h-full justify-center" disabled={!isRunning || !draft.trim() || busy} onClick={onSend} type="button">
                {busy ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
