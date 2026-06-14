function StatusChip({ children, tone = 'neutral' }) {
  const toneClass = tone === 'good'
    ? 'border-emerald-300/25 bg-emerald-300/10 text-emerald-100'
    : tone === 'warn'
      ? 'border-amber-300/25 bg-amber-300/10 text-amber-100'
      : 'border-white/10 bg-white/5 text-slate-300';
  return <span className={`status-pill ${toneClass}`}>{children}</span>;
}

function ChecklistItem({ completed, label, optional = false }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-slate-950/30 px-3 py-3">
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${completed ? 'border-emerald-300/35 bg-emerald-300/15 text-emerald-100' : 'border-white/15 bg-white/5 text-slate-500'}`}>
        {completed ? 'OK' : ''}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className={`text-sm font-medium ${completed ? 'text-slate-400 line-through' : 'text-white'}`}>{label}</p>
          {optional ? <span className="status-pill border-white/10 bg-white/5 text-slate-500">Optional</span> : null}
        </div>
      </div>
    </div>
  );
}

function QuickAction({ description, label, onClick }) {
  return (
    <button className="rounded-2xl border border-white/10 bg-slate-950/30 p-4 text-left transition hover:border-cyan-300/30 hover:bg-white/5" onClick={onClick} type="button">
      <p className="text-base font-semibold text-white">{label}</p>
      <p className="mt-2 text-xs leading-5 text-slate-400">{description}</p>
    </button>
  );
}


export default function HomePanel({
  appVersion,
  checklistDismissed,
  connectedProviderCount,
  downloadedModelCount,
  onDismissChecklist,
  onNavigate,
  storage,
  tools,
  visitedActions,
  visitedTabs,
}) {
  const installedToolCount = tools.length;
  const readyToolCount = tools.filter((tool) => tool.status !== 'error').length;
  const managedRootReady = Boolean(storage?.managedRoot);
  const checklistItems = [
    { completed: managedRootReady, id: 'storage', label: 'Confirm storage location' },
    { completed: visitedTabs.has('recorder'), id: 'recorder', label: 'Try Recorder' },
    { completed: visitedTabs.has('pipelines'), id: 'pipelines', label: 'Run a starter pipeline' },
    { completed: visitedActions.has('outputs'), id: 'outputs', label: 'Open your outputs' },
    { completed: connectedProviderCount > 0, id: 'providers', label: 'Configure provider keys', optional: true },
    { completed: installedToolCount > 0, id: 'tools', label: 'Install a local tool', optional: true },
    { completed: downloadedModelCount > 0, id: 'models', label: 'Download a model', optional: true },
  ];
  const completedCoreCount = checklistItems.filter((item) => !item.optional && item.completed).length;
  const coreCount = checklistItems.filter((item) => !item.optional).length;
  const quickActions = [
    { description: 'Capture your screen, microphone, camera, or system audio locally.', label: 'Record something', tab: 'recorder' },
    { description: 'Open the node-based workflow builder.', label: 'Build a pipeline', tab: 'pipelines' },
    { description: 'Jump to the built-in starter workflows.', label: 'Open starter templates', tab: 'pipelines', target: 'templates' },
    { description: 'Review saved pipeline results.', label: 'View outputs', tab: 'pipelines', target: 'outputs' },
    { description: 'Browse supported local AI tools.', label: 'Install tools', tab: 'store' },
    { description: 'Review downloaded models or find another one.', label: 'Manage models', tab: 'models' },
    { description: 'Save or update cloud provider credentials.', label: 'Configure providers', tab: 'settings' },
    { description: 'Open the existing local support and diagnostics tools.', label: 'Create diagnostics bundle', tab: 'settings', target: 'diagnostics' },
  ];

  return (
    <section className="min-h-0 flex-1 overflow-y-auto pb-4 pr-1" data-home-page="true">
      <div className="space-y-4">
        <div className="panel overflow-hidden p-6">
          <div className="grid gap-6 xl:grid-cols-[1.35fr,0.65fr] xl:items-end">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-cyan-200/70">Welcome home</p>
              <h2 className="mt-3 max-w-4xl text-4xl font-semibold tracking-tight text-white">Your local AI workspace, ready when you are.</h2>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">
                Local AI Hub is a Windows desktop app for installing local AI tools, managing models, recording media, and building AI workflows.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <StatusChip>v{appVersion || '0.49.0'}</StatusChip>
                <StatusChip tone="good">Local-first</StatusChip>
                <StatusChip tone={readyToolCount > 0 ? 'good' : 'neutral'}>{readyToolCount} tool{readyToolCount === 1 ? '' : 's'} ready</StatusChip>
                <StatusChip tone="good">Recorder available</StatusChip>
                <StatusChip tone={connectedProviderCount > 0 ? 'good' : 'neutral'}>{connectedProviderCount} provider{connectedProviderCount === 1 ? '' : 's'} configured</StatusChip>
                <StatusChip tone={managedRootReady ? 'good' : 'warn'}>{managedRootReady ? 'Managed root ready' : 'Storage needs attention'}</StatusChip>
              </div>
            </div>
            <div className="rounded-[28px] border border-cyan-300/15 bg-cyan-300/10 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-cyan-100/70">Right now</p>
              <p className="mt-3 text-3xl font-semibold text-white">{installedToolCount}</p>
              <p className="mt-1 text-sm text-cyan-50/80">installed tool{installedToolCount === 1 ? '' : 's'} on this PC</p>
              <button className="primary-button mt-5" onClick={() => onNavigate('library')} type="button">Open Library</button>
            </div>
          </div>
        </div>

        {!checklistDismissed ? (
          <div className="panel p-5" data-home-checklist="true">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Getting Started</p>
                <h3 className="mt-2 text-2xl font-semibold text-white">A few useful first steps</h3>
                <p className="mt-2 text-sm leading-6 text-slate-300">{completedCoreCount} of {coreCount} core steps complete. Optional steps never block dismissal.</p>
              </div>
              <button className="ghost-button" onClick={onDismissChecklist} type="button">Dismiss checklist</button>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {checklistItems.map((item) => <ChecklistItem key={item.id} {...item} />)}
            </div>
          </div>
        ) : null}

        <div className="panel p-5">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Quick actions</p>
            <h3 className="mt-2 text-2xl font-semibold text-white">Choose what to do next</h3>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {quickActions.map((action) => (
              <QuickAction key={action.label} {...action} onClick={() => onNavigate(action.tab, action.target)} />
            ))}
          </div>
        </div>

      </div>
    </section>
  );
}