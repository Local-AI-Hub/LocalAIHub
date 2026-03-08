import { progressWidth } from '../lib/formatters';

function resolveAction(toolState, busyMap, handlers, tool) {
  if (!toolState) {
    return {
      label: busyMap[`install:${tool.id}`] ? 'Installing...' : 'Install',
      disabled: Boolean(busyMap[`install:${tool.id}`]),
      onClick: () => handlers.onInstall(tool.id),
      variant: 'primary-button',
    };
  }

  if (toolState.status === 'running') {
    return {
      label: 'Stop',
      disabled: Boolean(busyMap[`stop:${tool.id}`]),
      onClick: () => handlers.onStop(tool.id),
      variant: 'ghost-button',
    };
  }

  if (toolState.source === 'external') {
    return {
      label: 'Open',
      disabled: Boolean(busyMap[`launch:${tool.id}`] || busyMap[`folder:${tool.id}`]),
      onClick: () =>
        toolState.launchSupported === false
          ? handlers.onOpenFolder(tool.id)
          : handlers.onLaunch(tool.id),
      variant: 'primary-button',
    };
  }

  return {
    label: busyMap[`launch:${tool.id}`] ? 'Launching...' : 'Launch',
    disabled: Boolean(busyMap[`launch:${tool.id}`]),
    onClick: () => handlers.onLaunch(tool.id),
    variant: 'primary-button',
  };
}

export default function InstallerGrid({
  manifests,
  toolMap,
  progressMap,
  busyMap,
  onInstall,
  onLaunch,
  onStop,
  onOpenFolder,
}) {
  return (
    <section className="panel p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-[0.22em] text-slate-400">Tool installer</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">
            Install, open, or launch each supported tool from one grid.
          </h2>
        </div>
        <p className="max-w-xl text-sm leading-6 text-slate-400">
          NestAI checks for existing installs first, then falls back to its own managed install path only when the tool is not already present.
        </p>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        {manifests.map((tool) => {
          const toolState = toolMap[tool.id];
          const progress = progressMap[tool.id];
          const action = resolveAction(
            toolState,
            busyMap,
            { onInstall, onLaunch, onStop, onOpenFolder },
            tool,
          );

          return (
            <article key={tool.id} className="rounded-3xl border border-white/10 bg-white/5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3">
                    <h3 className="text-2xl font-semibold text-white">{tool.name}</h3>
                    <span
                      className={`status-pill ${
                        toolState
                          ? toolState.source === 'managed'
                            ? 'border-signal/40 bg-signal/10 text-signal'
                            : 'border-accent/40 bg-accent/10 text-accent'
                          : 'border-white/10 bg-white/5 text-slate-300'
                      }`}
                    >
                      {toolState
                        ? toolState.source === 'managed'
                          ? 'Managed by NestAI'
                          : 'Detected on system'
                        : 'Available'}
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-300">{tool.description}</p>
                </div>

                <button className={action.variant} disabled={action.disabled} onClick={action.onClick} type="button">
                  {action.label}
                </button>
              </div>

              <div className="mt-5 rounded-2xl border border-white/10 bg-slate-950/25 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                  {toolState ? 'Location' : 'Install plan'}
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  {toolState ? toolState.displayPath || toolState.installDir : tool.installSummary}
                </p>
              </div>

              {progress && (
                <div className="mt-5 space-y-3">
                  <div className="flex items-center justify-between gap-4 text-sm text-slate-300">
                    <span>{progress.message}</span>
                    <span>{progress.percent}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-accent transition-all" style={{ width: progressWidth(progress.percent) }} />
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
