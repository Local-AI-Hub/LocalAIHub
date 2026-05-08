import { memo, useEffect, useState } from 'react';
import { formatBytes, formatDiskAvailability, formatTimestamp, formatUsage } from '../lib/formatters';

const LONG_LOAD_MS = 15000;

function MiniBar({ value, maxValue, tone = 'bg-cyan-300' }) {
  const percent = maxValue > 0 ? Math.max(6, Math.min(100, Math.round((value / maxValue) * 100))) : 0;
  return (
    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-950/35">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

function LoadingBlock({ className = '' }) {
  return <div className={`animate-pulse rounded-2xl bg-white/10 ${className}`} />;
}

function SectionLoadingMessage({ children }) {
  const [isTakingLong, setIsTakingLong] = useState(false);

  useEffect(() => {
    setIsTakingLong(false);
    const timerId = window.setTimeout(() => setIsTakingLong(true), LONG_LOAD_MS);
    return () => window.clearTimeout(timerId);
  }, []);

  return (
    <div className="rounded-3xl border border-cyan-300/20 bg-cyan-300/10 p-4 text-sm leading-7 text-cyan-50">
      {children}
      {isTakingLong ? ' This section is still working through local files.' : ''}
    </div>
  );
}

function SectionErrorMessage({ children, onRetry }) {
  return (
    <div className="rounded-3xl border border-danger/40 bg-danger/10 p-4 text-sm leading-7 text-rose-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{children}</span>
        <button className="ghost-button px-3 py-1.5 text-xs" onClick={onRetry} type="button">
          Retry
        </button>
      </div>
    </div>
  );
}

function LoadingList({ count = 3 }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
          <LoadingBlock className="h-5 w-48" />
          <LoadingBlock className="mt-3 h-3 w-36" />
          <LoadingBlock className="mt-4 h-2 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

function VramHistoryChart({ history, loading }) {
  if (loading && !history?.length) {
    return (
      <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
        <LoadingBlock className="h-3 w-32" />
        <LoadingBlock className="mt-4 h-4 w-80 max-w-full" />
        <LoadingBlock className="mt-4 h-52 w-full" />
      </div>
    );
  }

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

function hasAnyStatistics(data) {
  return Boolean(
    (data?.launchRanking || []).length ||
      (data?.toolBreakdown || []).some((entry) => Number(entry.totalBytes || 0) > 0) ||
      (data?.vramHistory || []).length ||
      Number(data?.totalDiskUsage?.localAIHubBytes || 0) > 0,
  );
}

function StorageValue({ data, loading }) {
  const value = data?.totalDiskUsage?.localAIHubBytes;
  if (loading && typeof value !== 'number') {
    return <LoadingBlock className="mt-3 h-8 w-40" />;
  }

  return <p className="mt-3 text-2xl font-semibold text-white">{formatBytes(value || 0)}</p>;
}

function StatisticsPanel({ busy, data = null, error, loading, onOpenCleanup, onRefresh, sectionErrors = {}, sectionStatus = {} }) {
  const coreLoading = sectionStatus.core === 'loading';
  const storageLoading = sectionStatus.storage === 'loading';
  const coreReady = sectionStatus.core === 'ready';
  const storageReady = sectionStatus.storage === 'ready';
  const coreError = sectionErrors.core || error || '';
  const storageError = sectionErrors.storage || '';
  const hasCoreData = Boolean(data?.generatedAt);
  const hasStorageData = Array.isArray(data?.toolBreakdown) || Array.isArray(data?.storageRoots) || typeof data?.totalDiskUsage?.localAIHubBytes === 'number';
  const maxLaunchCount = Math.max(...(data?.launchRanking || []).map((entry) => Number(entry.count || 0)), 1);
  const maxToolBytes = Math.max(...(data?.toolBreakdown || []).map((entry) => Number(entry.totalBytes || 0)), 1);
  const showEmptyState = coreReady && storageReady && !hasAnyStatistics(data);

  return (
    <section className="space-y-5" aria-busy={loading ? 'true' : 'false'} aria-live="polite">
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

        {coreLoading && !hasCoreData ? (
          <div className="mt-6">
            <SectionLoadingMessage>Loading launch history, drive details, and VRAM history first.</SectionLoadingMessage>
          </div>
        ) : null}

        {busy && hasCoreData ? (
          <div className="mt-6 rounded-3xl border border-cyan-300/20 bg-cyan-300/10 p-4 text-sm leading-7 text-cyan-50">
            Updating statistics while keeping the current snapshot visible.
          </div>
        ) : null}

        {storageLoading ? (
          <div className="mt-6">
            <SectionLoadingMessage>Loading storage and model sizes separately. Faster statistics are available while this continues.</SectionLoadingMessage>
          </div>
        ) : null}

        {coreError && !hasCoreData ? (
          <div className="mt-6">
            <SectionErrorMessage onRetry={onRefresh}>{coreError}</SectionErrorMessage>
          </div>
        ) : null}

        {showEmptyState ? (
          <div className="mt-6 rounded-3xl border border-dashed border-white/10 bg-white/5 p-5 text-sm leading-7 text-slate-300">
            No usage statistics have been recorded yet. Launch tools, download models, or let VRAM sampling run to populate this page.
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Local AI Hub storage</p>
            <StorageValue data={data} loading={storageLoading || !hasStorageData} />
            <p className="mt-2 text-sm text-slate-300">Tracked across Local AI Hub's current app, config, and managed storage roots.</p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Storage drive</p>
            {coreLoading && !hasCoreData ? <LoadingBlock className="mt-3 h-8 w-44" /> : <p className="mt-3 text-2xl font-semibold text-white">{data?.totalDiskUsage?.installDrive || 'Not available'}</p>}
            <p className="mt-2 text-sm text-slate-300">
              {coreLoading && !hasCoreData ? 'Checking the storage drive...' : formatDiskAvailability(data?.totalDiskUsage?.freeBytes, data?.totalDiskUsage?.totalBytes)}
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/35 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Updated</p>
            {coreLoading && !hasCoreData ? <LoadingBlock className="mt-3 h-8 w-52" /> : <p className="mt-3 text-2xl font-semibold text-white">{formatTimestamp(data?.generatedAt)}</p>}
            <p className="mt-2 text-sm text-slate-300">Latest local snapshot for launch counts, disk usage, and VRAM history.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[0.95fr,1.05fr]">
        <div className="panel p-6">
          <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Launches</p>
          <h4 className="mt-3 text-2xl font-semibold text-white">Most-used tools</h4>
          <div className="mt-5 space-y-4">
            {coreLoading && !hasCoreData ? (
              <LoadingList />
            ) : (data?.launchRanking || []).length ? (
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
            {storageError && !hasStorageData ? (
              <SectionErrorMessage onRetry={onRefresh}>{storageError}</SectionErrorMessage>
            ) : storageLoading && !hasStorageData ? (
              <LoadingList />
            ) : (data?.toolBreakdown || []).length ? (
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
          {storageError && hasStorageData ? (
            <div className="mt-5">
              <SectionErrorMessage onRetry={onRefresh}>{storageError}</SectionErrorMessage>
            </div>
          ) : null}
        </div>
      </div>

      <VramHistoryChart history={data?.vramHistory || []} loading={coreLoading && !hasCoreData} />
    </section>
  );
}

function areStatisticsPanelPropsEqual(prevProps, nextProps) {
  return (
    prevProps.busy === nextProps.busy &&
    prevProps.data === nextProps.data &&
    prevProps.error === nextProps.error &&
    prevProps.loading === nextProps.loading &&
    prevProps.sectionErrors === nextProps.sectionErrors &&
    prevProps.sectionStatus === nextProps.sectionStatus
  );
}

export default memo(StatisticsPanel, areStatisticsPanelPropsEqual);