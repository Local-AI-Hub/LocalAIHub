import { memo } from 'react';
import { formatMemory } from '../lib/formatters';

function NavButton({ active, label, count, onClick }) {
  return (
    <button className={`sidebar-tab ${active ? 'sidebar-tab-active' : ''}`} onClick={onClick} type="button">
      <span>{label}</span>
      {count === null || count === undefined ? null : <span className="sidebar-count">{count}</span>}
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
  storeCount,
}) {
  return (
    <aside className="sidebar-shell">
      <div>
        <div className="rounded-[28px] border border-white/10 bg-white/5 p-5">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Local AI Hub</p>
            <h1 className="mt-1 text-2xl font-semibold text-white">Steam for local AI</h1>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-300">
            Keep installs, launches, repair, snapshots, pipelines, models, and cloud connections in one Windows-native control center.
          </p>
        </div>

        <div className="mt-6 space-y-3">
          <NavButton active={activeTab === 'library'} count={installedCount} label="Library" onClick={() => onChangeTab('library')} />
          <NavButton active={activeTab === 'store'} count={storeCount} label="Store" onClick={() => onChangeTab('store')} />
          <NavButton active={activeTab === 'models'} count={modelManagerCount} label="Model Manager" onClick={() => onChangeTab('models')} />
          <NavButton active={activeTab === 'pipelines'} count={null} label="Pipelines" onClick={() => onChangeTab('pipelines')} />
          <NavButton active={activeTab === 'statistics'} count={null} label="Statistics" onClick={() => onChangeTab('statistics')} />
          <NavButton active={activeTab === 'settings'} count={null} label="Settings" onClick={() => onChangeTab('settings')} />
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-[28px] border border-white/10 bg-white/5 p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Hardware</p>
          <p className="mt-3 text-xl font-semibold text-white">{hardware?.gpuModel || 'Detecting GPU...'}</p>
          <div className="mt-4 grid gap-3">
            <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">VRAM</p>
              <p className="mt-2 text-sm font-medium text-white">{formatMemory(hardware?.vramMb)}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">System RAM</p>
              <p className="mt-2 text-sm font-medium text-white">{formatMemory(hardware?.systemRamMb)}</p>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-400">{hardware?.compatibilityMessage || 'Local AI Hub is building a local hardware profile.'}</p>
        </div>

        <button className="ghost-button w-full justify-center" disabled={logsBusy} onClick={onOpenLogs} type="button">
          {logsBusy ? 'Opening logs...' : 'Open logs folder'}
        </button>
      </div>
    </aside>
  );
}

function areSidebarPropsEqual(prevProps, nextProps) {
  return (
    prevProps.activeTab === nextProps.activeTab &&
    prevProps.hardware === nextProps.hardware &&
    prevProps.installedCount === nextProps.installedCount &&
    prevProps.modelManagerCount === nextProps.modelManagerCount &&
    prevProps.storeCount === nextProps.storeCount &&
    prevProps.logsBusy === nextProps.logsBusy
  );
}

export default memo(Sidebar, areSidebarPropsEqual);
