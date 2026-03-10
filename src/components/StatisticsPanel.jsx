import { memo } from 'react';
import { formatBytes, formatDiskAvailability, formatTimestamp, formatUsage } from '../lib/formatters';

function MiniBar({ value, maxValue, tone = 'bg-cyan-300' }) {
  const percent = maxValue > 0 ? Math.max(6, Math.min(100, Math.round((value / maxValue) * 100))) : 0;
  return (
    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-950/35">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

function VramHistoryChart({ history }) {
  if (!history?.length) {
    return (
      <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 px-6 py-10 text-center text-sm leading-7 text-slate-400">
        VRAM history will appear here while your tools are running.
      </div>
    );
  }

  const width = 640;
  const height = 220;
  const padding = 20;
  const maxValue = Math.max(...history.map((entry) => Number(entry.vramTotalMb || entry.vramUsedMb || 0)), 1);
  const points = history.map((entry, index) => {
    const x = padding + (index / Math.max(1, history.length - 1)) * (width - padding * 2);
    const y = height - padding - ((Number(entry.vramUsedMb || 0) / maxValue) * (height - padding * 2));
    return `${x},${y}`;
  });

  return (
    <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">VRAM history</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Updated locally while your tools are running.</p>
        </div>
        <p className="text-sm font-medium text-white">Peak {formatUsage(Math.max(...history.map((entry) => Number(entry.vramUsedMb || 0))), maxValue)}</p>
      </div>
      <svg className="mt-4 w-full" viewBox={`0 0 ${width} ${height}`}>
        <rect fill="rgba(15,23,42,0.45)" height={height} rx="22" width={width} />
        <polyline fill="none" points={points.join(' ')} stroke="#67e8f9" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs uppercase tracking-[0.18em] text-slate-500">
        <span>{formatTimestamp(history[0]?.timestamp)}</span>
        <span>{formatTimestamp(history[history.length - 1]?.timestamp)}</span>
      </div>
    </div>
  );
}

function StatisticsPanel({ busy, data, onOpenCleanup, onRefresh }) {
  const maxLaunchCount = Math.max(...(data?.launchRanking || []).map((entry) => Number(entry.count || 0)), 1);
  const maxToolBytes = Math.max(...(data?.toolBreakdown || []).map((entry) => Number(entry.totalBytes || 0)), 1);

  return (
    <section className="space-y-5">
      <div className="panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Statistics</p>
            <h3 className="mt-3 text-3xl font-semibold text-white">Local usage, disk, and VRAM history</h3>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
              Everything on this screen is calculated locally and stays on this PC.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="ghost-button" disabled={busy} onClick={onRefresh} type="button">
              {busy ? 'Refreshing...' : 'Refresh stats'}
            </button>
            <button className="primary-button" onClick={onOpenCleanup} type="button">
              Open Cleanup
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Local AI Hub storage</p>
            <p className="mt-3 text-2xl font-semibold text-white">{formatBytes(data?.totalDiskUsage?.localAIHubBytes || 0)}</p>
            <p className="mt-2 text-sm text-slate-300">Tracked across Local AI Hub's current app, config, and managed storage roots.</p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Storage drive</p>
            <p className="mt-3 text-2xl font-semibold text-white">{data?.totalDiskUsage?.installDrive || 'Not available'}</p>
            <p className="mt-2 text-sm text-slate-300">
              {formatDiskAvailability(data?.totalDiskUsage?.freeBytes, data?.totalDiskUsage?.totalBytes)}
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Updated</p>
            <p className="mt-3 text-2xl font-semibold text-white">{formatTimestamp(data?.generatedAt)}</p>
            <p className="mt-2 text-sm text-slate-300">Latest local snapshot for launch counts, disk usage, and VRAM history.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[0.95fr,1.05fr]">
        <div className="panel p-6">
          <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Launches</p>
          <h4 className="mt-3 text-2xl font-semibold text-white">Most-used tools</h4>
          <div className="mt-5 space-y-4">
            {(data?.launchRanking || []).length ? (
              data.launchRanking.map((entry) => (
                <div key={entry.toolId} className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-base font-medium text-white">{entry.toolName}</p>
                      <p className="mt-1 text-sm text-slate-400">Last launch {formatTimestamp(entry.lastLaunchedAt)}</p>
                    </div>
                    <p className="text-lg font-semibold text-cyan-100">{entry.count}</p>
                  </div>
                  <MiniBar maxValue={maxLaunchCount} value={entry.count} />
                </div>
              ))
            ) : (
              <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 p-6 text-sm leading-7 text-slate-400">
                Launch counts will appear after you start tools from Local AI Hub.
              </div>
            )}
          </div>
        </div>

        <div className="panel p-6">
          <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Disk breakdown</p>
          <h4 className="mt-3 text-2xl font-semibold text-white">Installed tool size and downloaded models</h4>
          <div className="mt-5 space-y-4">
            {(data?.toolBreakdown || []).length ? (
              data.toolBreakdown.map((entry) => (
                <div key={entry.toolId} className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-base font-medium text-white">{entry.toolName}</p>
                      <p className="mt-1 text-sm text-slate-400">Install {formatBytes(entry.installBytes)} | Models {formatBytes(entry.modelBytes)}</p>
                    </div>
                    <p className="text-sm font-semibold text-cyan-100">{formatBytes(entry.totalBytes)}</p>
                  </div>
                  <MiniBar maxValue={maxToolBytes} value={entry.totalBytes} tone="bg-emerald-300" />
                </div>
              ))
            ) : (
              <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 p-6 text-sm leading-7 text-slate-400">
                Install a tool to start tracking its local disk usage here.
              </div>
            )}
          </div>
        </div>
      </div>

      <VramHistoryChart history={data?.vramHistory || []} />
    </section>
  );
}

function areStatisticsPanelPropsEqual(prevProps, nextProps) {
  return prevProps.busy === nextProps.busy && prevProps.data === nextProps.data;
}

export default memo(StatisticsPanel, areStatisticsPanelPropsEqual);
