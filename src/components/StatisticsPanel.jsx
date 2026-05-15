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
    <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-3 text-sm leading-6 text-cyan-50">
      {children}
      {isTakingLong ? ' This section is still working through local files.' : ''}
    </div>
  );
}

function SectionErrorMessage({ children, onRetry }) {
  return (
    <div className="rounded-2xl border border-danger/40 bg-danger/10 p-3 text-sm leading-6 text-rose-100">
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
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
          <LoadingBlock className="h-4 w-48" />
          <LoadingBlock className="mt-3 h-3 w-36" />
          <LoadingBlock className="mt-3 h-2 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

function VramHistoryChart({ history, loading }) {
  if (loading && !history?.length) {
    return (
      <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
        <LoadingBlock className="h-3 w-32" />
        <LoadingBlock className="mt-4 h-4 w-80 max-w-full" />
        <LoadingBlock className="mt-4 h-48 w-full" />
      </div>
    );
  }

  if (!history?.length) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-6 py-8 text-center text-sm leading-7 text-slate-400">
        VRAM history will appear here while your tools are running.
      </div>
    );
  }

  const width = 640;
  const height = 200;
  const padding = 20;
  const maxValue = Math.max(...history.map((entry) => Number(entry.vramTotalMb || entry.vramUsedMb || 0)), 1);
  const points = history.map((entry, index) => {
    const x = padding + (index / Math.max(1, history.length - 1)) * (width - padding * 2);
    const y = height - padding - ((Number(entry.vramUsedMb || 0) / maxValue) * (height - padding * 2));
    return `${x},${y}`;
  });

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">VRAM history</p>
          <p className="mt-1 text-sm leading-6 text-slate-300">Updated locally while your tools are running.</p>
        </div>
        <p className="text-sm font-medium text-white">Peak {formatUsage(Math.max(...history.map((entry) => Number(entry.vramUsedMb || 0))), maxValue)}</p>
      </div>
      <svg className="mt-3 w-full" viewBox={`0 0 ${width} ${height}`}>
        <rect fill="rgba(15,23,42,0.45)" height={height} rx="20" width={width} />
        <polyline fill="none" points={points.join(' ')} stroke="#67e8f9" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs uppercase tracking-[0.18em] text-slate-500">
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


function formatRelativeFreshness(value) {
  if (!value) {
    return 'Freshness unknown';
  }

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return 'Freshness unknown';
  }

  const ageMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 1) {
    return 'Updated just now';
  }
  if (minutes < 60) {
    return `Updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `Updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return `Updated ${formatTimestamp(value)}`;
}

function formatStorageFreshness(freshness, loading) {
  if (loading && freshness?.updatedAt) {
    return `${formatRelativeFreshness(freshness.updatedAt)}; refreshing now.`;
  }
  if (!freshness?.updatedAt) {
    return loading ? 'Checking storage freshness...' : 'Storage freshness unknown.';
  }
  const sourceLabel = freshness.source === 'index' ? 'Indexed storage data' : 'Storage data';
  return `${sourceLabel} ${formatRelativeFreshness(freshness.updatedAt).toLowerCase()}.`;
}
function StorageValue({ data, loading }) {
  const value = data?.totalDiskUsage?.localAIHubBytes;
  if (loading && typeof value !== 'number') {
    return <LoadingBlock className="mt-2 h-7 w-40" />;
  }

  return <p className="mt-2 text-xl font-semibold text-white">{formatBytes(value || 0)}</p>;
}

function StatisticsPanel({ busy, data = null, error, loading, onOpenCleanup, onRefresh, sectionErrors = {}, sectionStatus = {} }) {
  const [expandedSection, setExpandedSection] = useState('vram');
  const coreLoading = sectionStatus.core === 'loading';
  const storageLoading = sectionStatus.storage === 'loading';
  const coreReady = sectionStatus.core === 'ready';
  const storageReady = sectionStatus.storage === 'ready';
  const coreError = sectionErrors.core || error || '';
  const storageError = sectionErrors.storage || '';
  const hasCoreData = Boolean(data?.generatedAt);
  const hasStorageData = Array.isArray(data?.toolBreakdown) || Array.isArray(data?.storageRoots) || typeof data?.totalDiskUsage?.localAIHubBytes === 'number';
  const launchRanking = data?.launchRanking || [];
  const toolBreakdown = data?.toolBreakdown || [];
  const maxLaunchCount = Math.max(...launchRanking.map((entry) => Number(entry.count || 0)), 1);
  const maxToolBytes = Math.max(...toolBreakdown.map((entry) => Number(entry.totalBytes || 0)), 1);
  const showEmptyState = coreReady && storageReady && !hasAnyStatistics(data);
  const launchesExpanded = expandedSection === 'launches';
  const diskExpanded = expandedSection === 'disk';
  const visibleLaunches = launchesExpanded ? launchRanking : launchRanking.slice(0, 4);
  const visibleTools = diskExpanded ? toolBreakdown : toolBreakdown.slice(0, 4);
  const storageFreshness = data?.sectionFreshness?.storage || data?.statisticsIndex?.storage || null;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden" aria-busy={loading ? 'true' : 'false'} aria-live="polite">
      <div className="panel shrink-0 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Local-only statistics</p>
            <p className="mt-1 text-sm leading-6 text-slate-300">Fast launch, drive, and VRAM data appear first; storage totals finish independently.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="ghost-button" disabled={busy} onClick={onRefresh} type="button">
              {busy ? 'Refreshing...' : 'Refresh stats'}
            </button>
            <button className="primary-button" onClick={onOpenCleanup} type="button">
              Open Cleanup
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Local AI Hub storage</p>
            <StorageValue data={data} loading={storageLoading || !hasStorageData} />
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-300">{formatStorageFreshness(storageFreshness, storageLoading)}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Storage drive</p>
            {coreLoading && !hasCoreData ? <LoadingBlock className="mt-2 h-7 w-44" /> : <p className="mt-2 text-xl font-semibold text-white">{data?.totalDiskUsage?.installDrive || 'Not available'}</p>}
            <p className="mt-1 text-xs leading-5 text-slate-300">
              {coreLoading && !hasCoreData ? 'Checking the storage drive...' : formatDiskAvailability(data?.totalDiskUsage?.freeBytes, data?.totalDiskUsage?.totalBytes)}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Updated</p>
            {coreLoading && !hasCoreData ? <LoadingBlock className="mt-2 h-7 w-52" /> : <p className="mt-2 text-xl font-semibold text-white">{formatTimestamp(data?.generatedAt)}</p>}
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-300">Latest local snapshot.</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4 pr-1">
        <div className="space-y-3">
          {coreLoading && !hasCoreData ? <SectionLoadingMessage>Loading launch history, drive details, and VRAM history first.</SectionLoadingMessage> : null}
          {busy && hasCoreData ? <SectionLoadingMessage>Updating statistics while keeping the current snapshot visible.</SectionLoadingMessage> : null}
          {storageLoading ? <SectionLoadingMessage>Loading storage and model sizes separately. Faster statistics are available while this continues.</SectionLoadingMessage> : null}
          {coreError && !hasCoreData ? <SectionErrorMessage onRetry={onRefresh}>{coreError}</SectionErrorMessage> : null}
          {showEmptyState ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-4 text-sm leading-7 text-slate-300">
              No usage statistics have been recorded yet. Launch tools, download models, or let VRAM sampling run to populate this page.
            </div>
          ) : null}

          <div className="grid min-h-0 gap-3 xl:grid-cols-[0.95fr,1.05fr]">
            <div className="panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Launches</p>
                  <h4 className="mt-1 text-xl font-semibold text-white">Most-used tools</h4>
                </div>
                <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setExpandedSection(launchesExpanded ? 'vram' : 'launches')} type="button">
                  {launchesExpanded ? 'Collapse' : 'Expand'}
                </button>
              </div>
              <div className={`${launchesExpanded ? 'max-h-[48vh] overflow-y-auto pb-3 pr-1' : ''} mt-3 space-y-3`}>
                {coreLoading && !hasCoreData ? (
                  <LoadingList />
                ) : launchRanking.length ? (
                  visibleLaunches.map((entry) => (
                    <div key={entry.toolId} className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-white">{entry.toolName}</p>
                          <p className="mt-1 text-xs text-slate-400">Last launch {formatTimestamp(entry.lastLaunchedAt)}</p>
                        </div>
                        <p className="text-lg font-semibold text-cyan-100">{entry.count}</p>
                      </div>
                      <MiniBar maxValue={maxLaunchCount} value={entry.count} />
                    </div>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-5 text-sm leading-7 text-slate-400">
                    Launch counts will appear after you start tools from Local AI Hub.
                  </div>
                )}
                {!launchesExpanded && launchRanking.length > visibleLaunches.length ? (
                  <button className="ghost-button w-full justify-center px-3 py-1.5 text-xs" onClick={() => setExpandedSection('launches')} type="button">
                    Show {launchRanking.length - visibleLaunches.length} more launch rows
                  </button>
                ) : null}
              </div>
            </div>

            <div className="panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Disk breakdown</p>
                  <h4 className="mt-1 text-xl font-semibold text-white">Installed tools and models</h4>
                  <p className="mt-1 text-xs leading-5 text-slate-400" aria-label="Installed tools and models freshness">{formatStorageFreshness(storageFreshness, storageLoading)}</p>
                </div>
                <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setExpandedSection(diskExpanded ? 'vram' : 'disk')} type="button">
                  {diskExpanded ? 'Collapse' : 'Expand'}
                </button>
              </div>
              <div className={`${diskExpanded ? 'max-h-[48vh] overflow-y-auto pb-3 pr-1' : ''} mt-3 space-y-3`}>
                {storageError && !hasStorageData ? (
                  <SectionErrorMessage onRetry={onRefresh}>{storageError}</SectionErrorMessage>
                ) : storageLoading && !hasStorageData ? (
                  <LoadingList />
                ) : toolBreakdown.length ? (
                  visibleTools.map((entry) => (
                    <div key={entry.toolId} className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-white">{entry.toolName}</p>
                          <p className="mt-1 text-xs text-slate-400">Install {formatBytes(entry.installBytes)} | Models {formatBytes(entry.modelBytes)}</p>
                        </div>
                        <p className="text-sm font-semibold text-cyan-100">{formatBytes(entry.totalBytes)}</p>
                      </div>
                      <MiniBar maxValue={maxToolBytes} value={entry.totalBytes} tone="bg-emerald-300" />
                    </div>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-5 text-sm leading-7 text-slate-400">
                    Install a tool to start tracking its local disk usage here.
                  </div>
                )}
                {!diskExpanded && toolBreakdown.length > visibleTools.length ? (
                  <button className="ghost-button w-full justify-center px-3 py-1.5 text-xs" onClick={() => setExpandedSection('disk')} type="button">
                    Show {toolBreakdown.length - visibleTools.length} more disk rows
                  </button>
                ) : null}
              </div>
              {storageError && hasStorageData ? (
                <div className="mt-3">
                  <SectionErrorMessage onRetry={onRefresh}>{storageError}</SectionErrorMessage>
                </div>
              ) : null}
            </div>
          </div>

          <VramHistoryChart history={data?.vramHistory || []} loading={coreLoading && !hasCoreData} />
        </div>
      </div>
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
