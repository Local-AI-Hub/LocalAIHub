import { memo } from 'react';
import { progressWidth } from '../lib/formatters';
import { compatibilityClass, describeRequirements } from '../lib/tool-ui';
import HoverRevealText from './HoverRevealText';

function installMethodLabel(manifest) {
  if (manifest?.installContract?.lifecycleMode === 'official-installer') {
    return manifest?.installContract?.destinationControl === 'guided'
      ? 'Official installer (guided)'
      : 'Official installer';
  }

  return 'Direct Local AI Hub install';
}

function installPlanText(manifest) {
  return manifest?.installContract?.locationSummary || manifest.installSummary;
}

function installButtonLabel(manifest) {
  return manifest?.installContract?.lifecycleMode === 'official-installer' ? 'Install Desktop App' : 'Install';
}

function installCapabilities(manifest) {
  return Array.isArray(manifest?.installCapabilities) && manifest.installCapabilities.length
    ? manifest.installCapabilities
    : [{ id: 'default', installLabel: installButtonLabel(manifest), installedLabel: 'Installed' }];
}

function capabilityInstalled(tool, capabilityId) {
  if (!tool) {
    return false;
  }

  const capability = String(capabilityId || 'webui').trim().toLowerCase();
  if (capability === 'default') {
    return Boolean(tool);
  }

  if (tool.installedCapabilities && Object.prototype.hasOwnProperty.call(tool.installedCapabilities, capability)) {
    return Boolean(tool.installedCapabilities[capability]);
  }

  if (capability === 'desktop') {
    return Boolean(tool.desktopCompanion?.installed || (tool.launchModes || []).some((mode) => mode.id === 'desktop'));
  }

  if (capability === 'webui') {
    return Boolean(tool.source === 'managed' || (tool.launchModes || []).some((mode) => mode.id === 'webui'));
  }

  return true;
}

function StoreCard({ manifest, compatibility, progress, busy, busyMap, installedTool, onInstall }) {
  const capabilities = installCapabilities(manifest);
  const hasCapabilityChoices = capabilities.length > 1;
  return (
    <article className="store-card h-full">
      <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
        <div className="flex min-h-0 items-start justify-between gap-2 overflow-hidden">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="tool-emblem">{manifest.icon}</div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="min-w-0 max-w-full truncate text-lg font-semibold text-white" title={manifest.name}>{manifest.name}</h3>
                <span className="status-pill max-w-[10rem] truncate border-white/10 bg-white/5 text-slate-300" title={manifest.category}>{manifest.category}</span>
                <span className={`status-pill ${compatibilityClass(compatibility.tone)}`}>{compatibility.label}</span>
              </div>
              <HoverRevealText className="line-clamp-2 text-sm leading-5 text-slate-300" revealClassName="hover-reveal-card-popover" rootClassName="mt-2 block min-w-0" text={manifest.description} />
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            {capabilities.map((capability) => {
              const installed = capabilityInstalled(installedTool, capability.id);
              const capabilityBusy = hasCapabilityChoices
                ? Boolean(busyMap?.[`install:${manifest.id}:${capability.id}`])
                : busy;
              return (
                <button
                  key={capability.id}
                  className={installed ? 'ghost-button compact-card-button' : 'primary-button compact-card-button'}
                  disabled={installed || capabilityBusy}
                  onClick={() => onInstall(manifest.id, capability.id)}
                  type="button"
                >
                  {capabilityBusy ? 'Installing...' : installed ? capability.installedLabel || 'Installed' : capability.installLabel || installButtonLabel(manifest)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 overflow-hidden">
          <span className="status-pill max-w-[14rem] truncate border-amber-300/20 bg-amber-300/10 text-amber-100" title={installMethodLabel(manifest)}>{installMethodLabel(manifest)}</span>
          <span className="status-pill max-w-[18rem] truncate border-white/10 bg-white/5 text-slate-300" title={describeRequirements(manifest)}>{describeRequirements(manifest)}</span>
        </div>

        <p className="line-clamp-2 text-sm leading-5 text-slate-300" title={compatibility.message}>{compatibility.message}</p>

        <details className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-2 text-sm text-slate-300">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Install details</summary>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Install plan</p>
              <p className="mt-1 line-clamp-3 leading-5" title={installPlanText(manifest)}>{installPlanText(manifest)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Hardware fit</p>
              <p className="mt-1 line-clamp-3 leading-5" title={compatibility.message}>{compatibility.message}</p>
            </div>
          </div>
        </details>

        {progress ? (
          <div className="mt-auto rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-2">
            <div className="flex items-center justify-between gap-3 text-xs text-cyan-50">
              <span className="min-w-0 truncate" title={progress.message}>{progress.message}</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-950/40">
              <div className="h-full rounded-full bg-cyan-300 transition-all" style={{ width: progressWidth(progress.percent) }} />
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function areStoreCardPropsEqual(prevProps, nextProps) {
  return (
    prevProps.manifest === nextProps.manifest &&
    prevProps.installedTool === nextProps.installedTool &&
    prevProps.progress === nextProps.progress &&
    prevProps.busy === nextProps.busy &&
    prevProps.busyMap === nextProps.busyMap &&
    prevProps.compatibility?.label === nextProps.compatibility?.label &&
    prevProps.compatibility?.message === nextProps.compatibility?.message &&
    prevProps.compatibility?.tone === nextProps.compatibility?.tone
  );
}

export default memo(StoreCard, areStoreCardPropsEqual);
