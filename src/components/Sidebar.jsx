import { formatMemory } from '../lib/formatters';

function NavButton({ active, label, count, onClick }) {
  return (
    <button className={`sidebar-tab ${active ? 'sidebar-tab-active' : ''}`} onClick={onClick} type="button">
      <span>{label}</span>
      {count === null || count === undefined ? null : <span className="sidebar-count">{count}</span>}
    </button>
  );
}

export default function Sidebar({
  activeTab,
  hardware,
  installedCount,
  modelManagerCount,
  storeCount,
  onChangeTab,
  onOpenLogs,
  logsBusy,
}) {
  return (
    <aside className="sidebar-shell">
      <div>
        <div className="rounded-[28px] border border-white/10 bg-white/5 p-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-400/15 text-lg font-semibold tracking-[0.22em] text-cyan-200">
              NA
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Local AI Hub</p>
              <h1 className="mt-1 text-2xl font-semibold text-white">Steam for local AI</h1>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-300">
            Keep installs, launches, repair, snapshots, and models in one Windows-native control center.
          </p>
        </div>

        <div className="mt-6 space-y-3">
          <NavButton active={activeTab === 'library'} count={installedCount} label="Library" onClick={() => onChangeTab('library')} />
          <NavButton active={activeTab === 'store'} count={storeCount} label="Store" onClick={() => onChangeTab('store')} />
          <NavButton active={activeTab === 'models'} count={modelManagerCount} label="Model Manager" onClick={() => onChangeTab('models')} />
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
