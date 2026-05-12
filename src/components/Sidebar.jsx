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
  hardware,
  installedCount,
  modelManagerCount,
  onChangeTab,
  onOpenLogs,
  logsBusy,
  pipelineRunStatus,
  storeCount,
}) {
  return (
    <aside className="sidebar-shell xl:sticky xl:top-5 xl:max-h-full xl:self-stretch xl:overflow-hidden">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Local AI Hub</p>
          </div>
          <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-300">
            Keep installs, launches, repair, snapshots, pipelines, models, and cloud connections in one Windows-native control center.
          </p>
        </div>

        <div className="space-y-2">
          <NavButton active={activeTab === 'library'} count={installedCount} label="Library" onClick={() => onChangeTab('library')} />
          <NavButton active={activeTab === 'store'} count={storeCount} label="Store" onClick={() => onChangeTab('store')} />
          <NavButton active={activeTab === 'models'} count={modelManagerCount} label="Model Manager" onClick={() => onChangeTab('models')} />
          <NavButton active={activeTab === 'pipelines'} count={null} detail={pipelineRunStatus} label="Pipelines" onClick={() => onChangeTab('pipelines')} />
          <NavButton active={activeTab === 'statistics'} count={null} label="Statistics" onClick={() => onChangeTab('statistics')} />
          <NavButton active={activeTab === 'settings'} count={null} label="Settings" onClick={() => onChangeTab('settings')} />
        </div>

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

      <button className="ghost-button mt-3 w-full shrink-0 justify-center" disabled={logsBusy} onClick={onOpenLogs} type="button">
        {logsBusy ? 'Opening logs...' : 'Open logs folder'}
      </button>
    </aside>
  );
}

function areSidebarPropsEqual(prevProps, nextProps) {
  return (
    prevProps.activeTab === nextProps.activeTab &&
    prevProps.hardware === nextProps.hardware &&
    prevProps.installedCount === nextProps.installedCount &&
    prevProps.modelManagerCount === nextProps.modelManagerCount &&
    prevProps.pipelineRunStatus === nextProps.pipelineRunStatus &&
    prevProps.storeCount === nextProps.storeCount &&
    prevProps.logsBusy === nextProps.logsBusy
  );
}

export default memo(Sidebar, areSidebarPropsEqual);
