import { memo } from 'react';
import { formatMemory } from '../lib/formatters';

function NavButton({ active, label, count, detail, onClick }) {
  return (
    <button className={`sidebar-tab ${active ? 'sidebar-tab-active' : ''}`} onClick={onClick} type="button">
      <span>{label}</span>
      {detail ? <span className="sidebar-count">{detail}</span> : count === null || count === undefined ? null : <span className="sidebar-count">{count}</span>}
    </button>
  );
}

function Sidebar({
  activeTab,
  collapsed,
  hardware,
  installedCount,
  modelManagerCount,
  onChangeTab,
  onCollapse,
  onExpand,
  onOpenLogs,
  onRequestClose,
  logsBusy,
  pipelineRunStatus,
  recordingStatus,
  storeCount,
}) {
  if (collapsed) {
    return (
      <aside className="justify-self-start" data-sidebar-collapsed="true">
        <button
          aria-label="Expand sidebar"
          className="rounded-xl border border-white/10 bg-[#0d1623]/90 px-3 py-2 text-xs font-semibold text-slate-200 shadow-soft transition hover:border-cyan-300/35 hover:bg-[#142235] focus:outline-none focus:ring-2 focus:ring-cyan-300/40"
          onClick={onExpand}
          type="button"
        >
          Expand sidebar
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar-shell xl:sticky xl:top-5 xl:max-h-full xl:self-stretch xl:overflow-hidden" data-sidebar-expanded="true">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Local AI Hub</p>
            <button className="ghost-button shrink-0 px-2.5 py-1.5 text-[10px]" onClick={onCollapse} type="button">
              Collapse sidebar
            </button>
          </div>
          <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-300">
            Keep installs, launches, repair, snapshots, pipelines, models, and cloud connections in one Windows-native control center.
          </p>
        </div>

        <nav aria-label="Main navigation" className="space-y-2">
          <NavButton active={activeTab === 'home'} count={null} label="Home" onClick={() => onChangeTab('home')} />
          <NavButton active={activeTab === 'library'} count={installedCount} label="Library" onClick={() => onChangeTab('library')} />
          <NavButton active={activeTab === 'store'} count={storeCount} label="Store" onClick={() => onChangeTab('store')} />
          <NavButton active={activeTab === 'models'} count={modelManagerCount} label="Model Manager" onClick={() => onChangeTab('models')} />
          <NavButton active={activeTab === 'recorder'} count={null} detail={recordingStatus} label="Recorder" onClick={() => onChangeTab('recorder')} />
          <NavButton active={activeTab === 'pipelines'} count={null} detail={pipelineRunStatus} label="Pipelines" onClick={() => onChangeTab('pipelines')} />
          <NavButton active={activeTab === 'statistics'} count={null} label="Statistics" onClick={() => onChangeTab('statistics')} />
          <NavButton active={activeTab === 'settings'} count={null} label="Settings" onClick={() => onChangeTab('settings')} />
        </nav>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Hardware</p>
          <p className="mt-2 text-base font-semibold leading-5 text-white">{hardware?.gpuModel || 'Detecting GPU...'}</p>
          <div className="mt-3 grid gap-2">
            <div className="rounded-xl border border-white/10 bg-slate-950/35 px-3 py-2">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">VRAM</p>
              <p className="mt-2 text-sm font-medium text-white">{formatMemory(hardware?.vramMb)}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-950/35 px-3 py-2">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">System RAM</p>
              <p className="mt-2 text-sm font-medium text-white">{formatMemory(hardware?.systemRamMb)}</p>
            </div>
          </div>
          <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-400">{hardware?.compatibilityMessage || 'Local AI Hub is building a local hardware profile.'}</p>
        </div>
      </div>

      <div className="mt-3 grid shrink-0 gap-2">
        <button className="ghost-button w-full justify-center" disabled={logsBusy} onClick={onOpenLogs} type="button">
          {logsBusy ? 'Opening logs...' : 'Open logs folder'}
        </button>
        <button
          className="inline-flex w-full items-center justify-center rounded-xl border border-rose-300/25 bg-rose-400/10 px-3 py-2 text-sm font-semibold text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-400/20"
          data-close-local-ai-hub="true"
          onClick={onRequestClose}
          type="button"
        >
          Close Local AI Hub
        </button>
      </div>
    </aside>
  );
}

function areSidebarPropsEqual(prevProps, nextProps) {
  return (
    prevProps.activeTab === nextProps.activeTab &&
    prevProps.collapsed === nextProps.collapsed &&
    prevProps.hardware === nextProps.hardware &&
    prevProps.installedCount === nextProps.installedCount &&
    prevProps.modelManagerCount === nextProps.modelManagerCount &&
    prevProps.pipelineRunStatus === nextProps.pipelineRunStatus &&
    prevProps.recordingStatus === nextProps.recordingStatus &&
    prevProps.storeCount === nextProps.storeCount &&
    prevProps.logsBusy === nextProps.logsBusy
  );
}

export default memo(Sidebar, areSidebarPropsEqual);
