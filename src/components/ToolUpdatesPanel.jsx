import { memo } from 'react';
import { formatTimestamp } from '../lib/formatters';

function isBusy(busyMap, key) {
  return Boolean(busyMap?.[key]);
}

function ToolUpdatesPanel({ busyMap, summary, onUpdateTool }) {
  const entries = (summary?.entries || []).filter((entry) => entry.updateAvailable);
  if (!entries.length) {
    return null;
  }

  return (
    <section className="panel border border-cyan-300/20 bg-cyan-300/[0.05] p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Updates available</p>
          <h3 className="mt-3 text-3xl font-semibold text-white">{summary.availableCount} tool update{summary.availableCount === 1 ? '' : 's'} ready</h3>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
            Local AI Hub checks for newer releases when the app starts and then once a day. Nothing updates automatically until you choose Update.
          </p>
        </div>
        <p className="text-sm text-slate-400">Checked {formatTimestamp(summary.lastCheckedAt)}</p>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        {entries.map((entry) => (
          <div key={entry.toolId} className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-lg font-semibold text-white">{entry.toolName}</p>
                <p className="mt-2 text-sm text-slate-300">
                  Installed {entry.currentVersion || 'Unknown'} | Available {entry.availableVersion || 'Unknown'}
                </p>
                {entry.sourceLabel ? <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{entry.sourceLabel}</p> : null}
              </div>
              <button className="primary-button" disabled={busyMap[`update:${entry.toolId}`]} onClick={() => onUpdateTool(entry.toolId)} type="button">
                {busyMap[`update:${entry.toolId}`] ? 'Updating...' : 'Update'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function areToolUpdatePropsEqual(prevProps, nextProps) {
  const prevEntries = prevProps.summary?.entries || [];
  return (
    prevProps.summary === nextProps.summary &&
    prevEntries.every(
      (entry) => isBusy(prevProps.busyMap, `update:${entry.toolId}`) === isBusy(nextProps.busyMap, `update:${entry.toolId}`),
    )
  );
}

export default memo(ToolUpdatesPanel, areToolUpdatePropsEqual);
