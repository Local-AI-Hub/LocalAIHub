const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { open } = require('node:fs/promises');
const { app } = require('electron');
const extract = require('extract-zip');

const { version: APP_VERSION } = require('../../package.json');

const { getAppPaths, humanizeError, normalizeOptionalDirectoryPath, readConfig, removeTool, setToolIgnored, upsertTool } = require('./configService');
const { verifyDownloadedFileIntegrity } = require('./downloadIntegrityService');
const { compareVersions, resolvePythonCommand, runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const { detectHardwareSnapshot } = require('./hardwareService');
const { detectPythonRequirement, describePythonRequirement } = require('./pythonRequirementService');
const { ensureManagedPythonRuntime } = require('./pythonRuntimeService');
const { applyRepairCleanup, getDiskPreflight, inspectRepairCleanup, preflightPathRemoval, removePathWithRetries } = require('./storageMaintenanceService');
const { syncDiscoveredTools } = require('./toolDiscoveryService');
const { getCachedToolUpdateEntry, refreshInstalledToolUpdates } = require('./toolUpdateService');
const { buildLaunchModeState, buildManagedLaunchProfile, getToolManifest, initializeToolRegistry } = require('./toolRegistry');
const { INSTALL_DESTINATION_CONTROL, getToolActionSemantics, isDirectManagedTool, isOfficialInstallerTool, normalizeToolLifecycle } = require('./toolLifecycleService');
const {
  enrichToolWithWindowsUninstall,
  removeToolWindowsShortcuts,
  removeWindowsUninstallEntry,
  resolveToolUninstallContext,
  runWindowsUninstaller,
} = require('./windowsUninstallService');
const { assertPathInside, assertSecureRemoteUrl, findManagedToolsRootForPath, isPathInside, resolveManagedToolPaths } = require('./pathSafetyService');
const { appendSupportGuidance, recordSupportEvent } = require('./supportEventService');

const DOWNLOAD_TIMEOUT_MS = 30000;
const MIN_CACHE_BYTES = 1024;
const PACKAGE_SIGNATURE_BYTES = 8;
const PE_HEADER = Buffer.from([0x4d, 0x5a]);
const SEVEN_ZIP_HEADER = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const ZIP_HEADER = Buffer.from([0x50, 0x4b]);
const INSTALLER_MATERIALIZATION_TIMEOUT_MS = 180000;
const INSTALLER_MATERIALIZATION_POLL_MS = 1000;
const GUIDED_INSTALLER_LAUNCH_SETTLE_MS = 1500;
const OFFICIAL_DESKTOP_UPDATE_DETECTION_TIMEOUT_MS = 30000;
const OFFICIAL_DESKTOP_UPDATE_DETECTION_POLL_MS = 1000;
const OFFICIAL_UNINSTALL_SETTLE_TIMEOUT_MS = 45000;
const OFFICIAL_UNINSTALL_SETTLE_POLL_MS = 1000;
const MANAGED_CUDA_PYTORCH_INSTALL_TOOL_IDS = new Set(['comfyui']);
const PYTORCH_CUDA_INSTALL_BUILDS = [
  {
    channel: 'cu124',
    label: 'CUDA 12.4',
    minCudaVersion: [12, 4],
    torch: '2.6.0',
    torchvision: '0.21.0',
    torchaudio: '2.6.0',
    indexUrl: 'https://download.pytorch.org/whl/cu124',
  },
  {
    channel: 'cu121',
    label: 'CUDA 12.1',
    minCudaVersion: [12, 1],
    torch: '2.5.1',
    torchvision: '0.20.1',
    torchaudio: '2.5.1',
    indexUrl: 'https://download.pytorch.org/whl/cu121',
  },
  {
    channel: 'cu118',
    label: 'CUDA 11.8',
    minCudaVersion: [11, 8],
    torch: '2.6.0',
    torchvision: '0.21.0',
    torchaudio: '2.6.0',
    indexUrl: 'https://download.pytorch.org/whl/cu118',
  },
];
const VERSION_PATTERN = /v?(\d+(?:\.\d+){1,3})/i;
const activeToolInstallOperations = new Map();

async function withToolInstallOperationLock(toolId, operationLabel, action) {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  if (!normalizedToolId) {
    return action();
  }

  const activeLabel = activeToolInstallOperations.get(normalizedToolId);
  if (activeLabel) {
    throw new Error(`Local AI Hub is already ${activeLabel} this tool. Wait for that operation to finish before starting another install or repair.`);
  }

  activeToolInstallOperations.set(normalizedToolId, operationLabel || 'working on');
  try {
    return await action();
  } finally {
    if (activeToolInstallOperations.get(normalizedToolId) === (operationLabel || 'working on')) {
      activeToolInstallOperations.delete(normalizedToolId);
    }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[unitIndex]}`;
}

function pluralize(count, singular, plural = null) {
  return count === 1 ? singular : plural || `${singular}s`;
}

async function resolveRemoteDownloadSize(downloadUrl, logger) {
  const safeDownloadUrl = assertSecureRemoteUrl(downloadUrl, 'installer download URL');

  const readSizeFromResponse = (response) => {
    const contentLength = Number(response.headers.get('content-length')) || 0;
    if (contentLength > 0) {
      return contentLength;
    }

    const contentRange = String(response.headers.get('content-range') || '');
    const rangeMatch = contentRange.match(/\/(\d+)$/);
    if (rangeMatch?.[1]) {
      return Number(rangeMatch[1]) || 0;
    }

    return 0;
  };

  const requestSize = async (method, headers = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(safeDownloadUrl, {
        method,
        signal: controller.signal,
        headers: {
          'User-Agent': `LocalAIHub/${APP_VERSION}`,
          ...headers,
        },
      });

      return response.ok ? readSizeFromResponse(response) : 0;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const headSize = await requestSize('HEAD');
    if (headSize > 0) {
      return {
        requiredBytes: headSize,
        sizeKnown: true,
        source: 'head-request',
      };
    }
  } catch (error) {
    await logger.warn('Installer size preflight HEAD request failed.', {
      downloadUrl: safeDownloadUrl,
      error,
    });
  }

  try {
    const rangeSize = await requestSize('GET', {
      Range: 'bytes=0-0',
    });
    if (rangeSize > 0) {
      return {
        requiredBytes: rangeSize,
        sizeKnown: true,
        source: 'range-request',
      };
    }
  } catch (error) {
    await logger.warn('Installer size preflight range request failed.', {
      downloadUrl: safeDownloadUrl,
      error,
    });
  }

  return {
    requiredBytes: 0,
    sizeKnown: false,
    source: 'unknown',
  };
}
async function estimateToolInstallRequirement(manifest, archivePath, logger) {
  if (archivePath && (await fs.pathExists(archivePath))) {
    const stats = await fs.stat(archivePath).catch(() => null);
    if (stats?.size > MIN_CACHE_BYTES) {
      return {
        requiredBytes: stats.size,
        sizeKnown: true,
        source: 'cached-installer',
      };
    }
  }

  if (manifest.installInstructions.kind === 'pip-package') {
    return {
      requiredBytes: 0,
      sizeKnown: false,
      source: 'pip-package',
    };
  }

  return resolveRemoteDownloadSize(manifest.downloadUrl, logger);
}

function assertInstallPreflightApproved(preflight, confirmed) {
  if (!preflight) {
    return;
  }

  if (preflight.blocked) {
    throw new Error(
      `${preflight.toolName} needs ${formatBytes(preflight.requiredBytes)} but only ${formatBytes(preflight.availableBytes)} is free on ${preflight.mount}. Clear space and try again.`,
    );
  }

  if (preflight.requiresConfirmation && !confirmed) {
    const sizeMessage = preflight.sizeKnown
      ? `${preflight.toolName} needs about ${formatBytes(preflight.requiredBytes)} and Local AI Hub needs confirmation before continuing on ${preflight.mount}.`
      : `${preflight.toolName} may leave this drive very low on free space, and Local AI Hub needs confirmation before continuing on ${preflight.mount}.`;
    throw new Error(sizeMessage);
  }
}

function isLockedPathRepairError(error) {
  const errorCode = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();
  return (
    ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(errorCode) ||
    message.includes('still being used by windows') ||
    message.includes('resource busy or locked') ||
    message.includes('operation not permitted') ||
    message.includes('ebusy') ||
    message.includes('eperm')
  );
}

function buildRepairFailureMessage(error, manifest) {
  if (isLockedPathRepairError(error)) {
    return appendSupportGuidance(`${manifest.name} is still running or Windows is holding files open. Close ${manifest.name}, wait a few seconds, then run Repair again.`);
  }

  return appendSupportGuidance(humanizeError(error, `Local AI Hub could not repair ${manifest.name}.`));
}
function buildRepairCleanupNotes(cleanupSummary) {
  const notes = [];

  if (cleanupSummary.removedDuplicateFolders > 0) {
    notes.push(
      `removed ${cleanupSummary.removedDuplicateFolders} duplicate ${pluralize(cleanupSummary.removedDuplicateFolders, 'install folder')}`,
    );
  }

  if (cleanupSummary.removedTemporaryArtifacts > 0) {
    notes.push(
      `cleaned ${cleanupSummary.removedTemporaryArtifacts} leftover ${pluralize(cleanupSummary.removedTemporaryArtifacts, 'download or temp item')}`,
    );
  }

  if (cleanupSummary.removedOrphanedToolFolders > 0) {
    notes.push(
      `deleted ${cleanupSummary.removedOrphanedToolFolders} orphaned ${pluralize(cleanupSummary.removedOrphanedToolFolders, 'tool folder')}`,
    );
  }

  if (cleanupSummary.failedOrphanedToolFolders > 0) {
    notes.push(
      `skipped ${cleanupSummary.failedOrphanedToolFolders} locked orphaned ${pluralize(cleanupSummary.failedOrphanedToolFolders, 'tool folder')} so repair could continue`,
    );
  } else if (cleanupSummary.skippedOrphanedToolFolders > 0) {
    notes.push(
      `left ${cleanupSummary.skippedOrphanedToolFolders} orphaned ${pluralize(cleanupSummary.skippedOrphanedToolFolders, 'tool folder')} untouched`,
    );
  }
  if (cleanupSummary.recoveredBytes > 0) {
    notes.push(`recovered ${formatBytes(cleanupSummary.recoveredBytes)} of disk space`);
  }

  return notes;
}

function summarizeRepairPlan(cleanupPlan) {
  const duplicateRecoveryBytes = cleanupPlan.duplicateFolders.reduce(
    (total, entry) => total + Number(entry.sizeBytes || 0),
    0,
  );
  const orphanedRecoveryBytes = cleanupPlan.orphanedToolFolders.reduce(
    (total, entry) => total + Number(entry.sizeBytes || 0),
    0,
  );
  const temporaryRecoveryBytes = cleanupPlan.temporaryArtifacts.reduce(
    (total, entry) => total + Number(entry.sizeBytes || 0),
    0,
  );

  return {
    duplicateFolderCount: cleanupPlan.duplicateFolders.length,
    duplicateRecoveryBytes,
    orphanedToolFolderCount: cleanupPlan.orphanedToolFolders.length,
    orphanedRecoveryBytes,
    potentialRecoveryBytes: cleanupPlan.potentialRecoveryBytes,
    requiresOrphanConfirmation: cleanupPlan.requiresOrphanConfirmation,
    temporaryArtifactCount: cleanupPlan.temporaryArtifacts.length,
    temporaryRecoveryBytes,
  };
}

function buildRepairOutcomeMessage(toolName, notes = []) {
  if (!notes.length) {
    return `Local AI Hub repaired ${toolName}.`;
  }

  return `Local AI Hub repaired ${toolName}: ${notes.join(', ')}.`;
}

async function getToolInstallPreflight(toolRequest) {
  const payload = typeof toolRequest === 'string' ? { toolId: toolRequest } : toolRequest || {};
  const toolId = String(payload.toolId || '').trim().toLowerCase();
  const capability = String(payload.capability || payload.installCapability || 'webui').trim().toLowerCase();
  await initializeToolRegistry();
  const baseManifest = getToolManifest(toolId);
  if (!baseManifest) {
    throw new Error('Local AI Hub does not recognize that tool.');
  }
  const manifest = capability === 'desktop' && baseManifest.companionDesktop
    ? baseManifest.companionDesktop
    : baseManifest;

  const installRoot = await resolvePreferredInstallRoot(payload.installRoot || null);
  const logger = createLogger('installer', {
    toolId,
    toolName: manifest.name,
    mode: 'preflight',
  });
  const { archivePath } = buildManagedPaths(manifest, {
    installRoot,
  });
  const estimate = await estimateToolInstallRequirement(manifest, archivePath, logger);
  const preflight = await getDiskPreflight(installRoot, estimate.requiredBytes);

  return {
    ...preflight,
    destinationMessage: buildInstallerDestinationMessage(manifest, installRoot),
    estimateSource: estimate.source,
    installContract: manifest.installContract,
    installRoot,
    sizeKnown: estimate.sizeKnown,
    targetPath: installRoot,
    toolId,
    capability: manifest === baseManifest ? 'webui' : 'desktop',
    toolName: manifest.name,
  };
}

function getToolRuntime(manifest) {
  return manifest.installInstructions.runtime;
}
function isBareCommand(token) {
  return Boolean(token) && !path.isAbsolute(token) && !/[\\/]/.test(token);
}

const SAFE_PIP_PACKAGE_PATTERN = /^[A-Za-z0-9._+\-[\],=<>!~]+$/;
const SAFE_PIP_VCS_TARGET_PATTERN = /^git\+https:\/\/[A-Za-z0-9./:@_#?=&%-]+$/i;

function extractVersionSegments(versionText) {
  const match = String(versionText || '').match(VERSION_PATTERN);
  if (!match?.[1]) {
    return [];
  }

  return match[1].split('.').map((entry) => Number.parseInt(entry, 10)).filter(Number.isFinite);
}

function normalizeVersionText(versionText) {
  const match = String(versionText || '').match(VERSION_PATTERN);
  return match?.[1] || '';
}

function compareVersionText(left, right) {
  const leftSegments = extractVersionSegments(left);
  const rightSegments = extractVersionSegments(right);
  if (!leftSegments.length || !rightSegments.length) {
    return 0;
  }

  return compareVersions(leftSegments, rightSegments);
}

function isPinnedGitHubReleaseAsset(downloadUrl) {
  return /github\.com\/[^/]+\/[^/]+\/releases\/download\//i.test(String(downloadUrl || ''))
    && !/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\//i.test(String(downloadUrl || ''));
}

function resolveUpdateManifest(manifest, updateEntry) {
  const downloadUrl = String(updateEntry?.downloadUrl || '').trim();
  const downloadFileName = path.basename(String(updateEntry?.downloadFileName || '').trim());
  const downloadResolutionError = String(updateEntry?.downloadResolutionError || '').trim();
  if (downloadUrl) {
    return {
      ...manifest,
      downloadUrl: assertSecureRemoteUrl(downloadUrl, `${manifest.name} update download URL`),
      installInstructions: downloadFileName
        ? {
            ...manifest.installInstructions,
            archiveName: downloadFileName,
            downloadFileName,
          }
        : manifest.installInstructions,
    };
  }

  if (downloadResolutionError) {
    throw new Error(downloadResolutionError);
  }

  if (updateEntry?.availableVersion && isPinnedGitHubReleaseAsset(manifest.downloadUrl)) {
    throw new Error(`${manifest.name} has an available update to ${updateEntry.availableVersion}, but Local AI Hub could not resolve the matching release download yet.`);
  }

  return manifest;
}

function resolveUpdateDownloadCachePath(toolState, managedPaths, updateEntry) {
  const downloadFileName = path.basename(String(updateEntry?.downloadFileName || '').trim());
  if (!downloadFileName) {
    return toolState.downloadCachePath || managedPaths.archivePath;
  }

  const downloadsDir = path.dirname(managedPaths.archivePath);
  return assertPathInside(
    downloadsDir,
    path.join(downloadsDir, downloadFileName),
    'Local AI Hub refused to place the update download outside the managed downloads folder.',
  );
}

async function readExecutableProductVersion(targetPath) {
  if (!targetPath || !(await fs.pathExists(targetPath))) {
    return '';
  }

  const escapedPath = String(targetPath).replace(/'/g, "''");
  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${escapedPath}').VersionInfo.ProductVersion`], {
    allowFailure: true,
  }).catch(() => null);

  return normalizeVersionText(result?.stdout || '');
}

async function readInstalledBinaryVersion(toolState) {
  return normalizeVersionText(toolState?.installedVersion || '')
    || normalizeVersionText(toolState?.windowsUninstallDisplayName || '')
    || await readExecutableProductVersion(toolState?.launchProfile?.executable || toolState?.executablePath || '');
}

function buildIncompleteUpdateVersionMessage(manifest, expectedVersion, detectedVersion = '', previousVersion = '') {
  if (detectedVersion) {
    return `Local AI Hub ran the ${manifest.name} updater, but Windows still reports version ${detectedVersion} instead of ${expectedVersion}.`;
  }

  if (previousVersion) {
    return `Local AI Hub ran the ${manifest.name} updater, but it still appears to be on version ${previousVersion} instead of ${expectedVersion}.`;
  }

  return `Local AI Hub ran the ${manifest.name} updater, but it could not verify that version ${expectedVersion} was installed.`;
}

function buildUnverifiedExternalUpdateMessage(manifest, expectedVersion) {
  return expectedVersion
    ? `Local AI Hub ran the ${manifest.name} updater and detected the official app afterward, but Windows did not expose a version number for ${expectedVersion}.`
    : `Local AI Hub ran the ${manifest.name} updater and detected the official app afterward, but Windows did not expose a version number.`;
}

function buildOfficialDesktopUpdateVerificationLagMessage(manifest) {
  return `Updater finished, but Local AI Hub could not verify the updated desktop app yet. Relaunch or use Detect/Refresh.`;
}

function getEnvValueInsensitive(name) {
  const key = Object.keys(process.env).find((entry) => entry.toLowerCase() === String(name || '').toLowerCase());
  return key ? process.env[key] : '';
}

function expandManifestDetectionPath(template) {
  return String(template || '').replace(/%([^%]+)%/g, (_match, name) => getEnvValueInsensitive(name) || '');
}

function normalizePathKey(targetPath) {
  try {
    return path.resolve(String(targetPath || '')).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return String(targetPath || '').trim().toLowerCase();
  }
}

function officialDesktopPathMatchesManifest(manifest, toolState) {
  const candidates = [
    toolState?.detectedPath,
    toolState?.displayPath,
    toolState?.executablePath,
    toolState?.launchProfile?.executable,
    toolState?.installDir,
    toolState?.appDir,
  ]
    .map(normalizePathKey)
    .filter(Boolean);
  if (!candidates.length) {
    return false;
  }

  return (manifest?.detectionPaths || [])
    .filter((entry) => !String(entry || '').startsWith('PATH:'))
    .map((entry) => expandManifestDetectionPath(entry))
    .filter(Boolean)
    .some((expandedPath) => {
      const manifestPath = normalizePathKey(expandedPath);
      const manifestDir = normalizePathKey(path.dirname(expandedPath));
      return candidates.some((candidate) => candidate === manifestPath || candidate === manifestDir);
    });
}

function officialDesktopUpdateStateIsApproved(manifest, toolState) {
  if (!toolState) {
    return false;
  }

  return Boolean(toolState.windowsUninstallDetected) || officialDesktopPathMatchesManifest(manifest, toolState);
}

async function detectOfficialDesktopUpdateToolState(manifest, archivePath, logger, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, options.timeoutMs)
    : OFFICIAL_DESKTOP_UPDATE_DETECTION_TIMEOUT_MS;
  const pollMs = Number.isFinite(options.pollMs)
    ? Math.max(0, options.pollMs)
    : OFFICIAL_DESKTOP_UPDATE_DETECTION_POLL_MS;
  const discoverTools = typeof options.discoverTools === 'function'
    ? options.discoverTools
    : () => syncDiscoveredTools({ force: true });
  const wait = typeof options.sleep === 'function' ? options.sleep : sleep;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (true) {
    attempts += 1;
    const discoveredTools = await discoverTools();
    const detectedTool = discoveredTools?.[manifest.id];

    if (await toolIsAvailable(detectedTool)) {
      if (!officialDesktopUpdateStateIsApproved(manifest, detectedTool)) {
        await logger.warn('Official desktop updater found an external app, but it was not approved by manifest paths or Windows uninstall metadata.', {
          detectedPath: detectedTool.displayPath || detectedTool.installDir || detectedTool.detectedPath || null,
          toolId: manifest.id,
        });
      } else {
        const normalizedDetectedTool = normalizeToolLifecycle({
          ...detectedTool,
          downloadCachePath: archivePath,
          lastError: null,
          status: detectedTool.status === 'running' ? 'running' : 'stopped',
        }, manifest);
        const trackedToolState = await attachWindowsUninstallMetadata(normalizedDetectedTool, manifest, { refresh: true });
        await logger.info('Official desktop updater verified the detected app through startup discovery rules.', {
          attempts,
          detectedPath: trackedToolState.displayPath || trackedToolState.installDir || trackedToolState.detectedPath || null,
          windowsUninstallDetected: Boolean(trackedToolState.windowsUninstallDetected),
        });
        return trackedToolState;
      }
    }

    if (Date.now() >= deadline) {
      return null;
    }

    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}
function isGuidedOfficialInstallerManifest(manifest) {
  return manifest?.installContract?.destinationControl === INSTALL_DESTINATION_CONTROL.GUIDED
    && manifest?.installContract?.lifecycleMode === 'official-installer'
    && manifest?.installInstructions?.kind === 'installer-exe';
}
function assertSafePipInstallTarget(value) {
  const target = String(value || '').trim();
  if (!target || (!SAFE_PIP_PACKAGE_PATTERN.test(target) && !SAFE_PIP_VCS_TARGET_PATTERN.test(target))) {
    throw new Error('Local AI Hub refused to install an unsafe Python package target.');
  }

  return target;
}

async function resolvePreferredInstallRoot(requestedRoot = null) {
  const normalizedRequestedRoot = normalizeOptionalDirectoryPath(requestedRoot);
  if (normalizedRequestedRoot) {
    return normalizedRequestedRoot;
  }

  const config = await readConfig().catch(() => null);
  return normalizeOptionalDirectoryPath(config?.preferredInstallRoot) || getAppPaths().managedRoot;
}

function resolveStoredInstallRoot(toolState, fallbackRoot = null) {
  return normalizeOptionalDirectoryPath(toolState?.installRoot || toolState?.requestedInstallRoot || fallbackRoot) || getAppPaths().managedRoot;
}

function buildPlannedInstallPaths(manifest, installRoot) {
  const destinationRoot = normalizeOptionalDirectoryPath(installRoot) || getAppPaths().managedRoot;
  const installDir = path.join(destinationRoot, 'tools', manifest.id);
  return {
    appDir: path.join(installDir, 'app'),
    destinationRoot,
    downloadCacheDir: path.join(destinationRoot, 'downloads', manifest.id),
    installDir,
  };
}

function buildInstallerDestinationMessage(manifest, installRoot) {
  const plannedPaths = buildPlannedInstallPaths(manifest, installRoot);
  if (manifest.installContract?.destinationControl === INSTALL_DESTINATION_CONTROL.GUIDED) {
    return `${manifest.name}'s official installer decides the final app location. Local AI Hub will stage the installer under ${plannedPaths.downloadCacheDir} and ask you to choose or confirm the final destination in the installer window.`;
  }

  if (manifest.installContract?.lifecycleMode === 'official-installer') {
    return `${manifest.name} will be installed by its official Windows installer. Local AI Hub will ask that installer to use ${plannedPaths.appDir} and will use the official uninstaller later instead of deleting files directly.`;
  }

  return `${manifest.name} will be installed directly into ${plannedPaths.installDir}.`;
}
function ensureManagedToolStatePaths(toolState) {
  if (!toolState?.id) {
    throw new Error('Local AI Hub could not validate the managed tool path.');
  }

  const persistedInstallRoot = normalizeOptionalDirectoryPath(toolState.installRoot || toolState.requestedInstallRoot);
  const installPath = toolState.installDir || toolState.appDir || '';
  const toolsRootOverride = installPath ? findManagedToolsRootForPath(installPath) : null;
  const managedRootOverride = persistedInstallRoot || (toolsRootOverride ? path.dirname(toolsRootOverride) : null);
  const managedPaths = resolveManagedToolPaths(
    toolState.id,
    path.basename(toolState.venvDir || '.venv'),
    managedRootOverride ? { managedRoot: managedRootOverride } : {},
  );
  const allowedToolsRoot = toolsRootOverride || managedPaths.toolsRoot;
  const installDir = assertPathInside(
    allowedToolsRoot,
    toolState.installDir || managedPaths.installDir,
    'Local AI Hub refused to use a managed install outside its tools folder.',
  );
  const appDir = assertPathInside(
    installDir,
    toolState.appDir || managedPaths.appDir,
    'Local AI Hub refused to use a managed app folder outside the tool directory.',
  );
  const venvDir = toolState.venvDir
    ? assertPathInside(
        installDir,
        toolState.venvDir,
        'Local AI Hub refused to use a managed Python environment outside the tool directory.',
      )
    : null;

  return {
    ...toolState,
    installDir,
    appDir,
    venvDir,
  };
}

function isManagedToolState(toolState) {
  return Boolean(toolState && (toolState.source === 'managed' || toolState.managedByLocalAIHub));
}

function finalizeManagedInstallResult(toolState, manifest, existingTool = null) {
  const nextToolState = normalizeToolLifecycle(toolState, manifest);
  if (!isManagedToolState(nextToolState)) {
    return nextToolState;
  }

  if (isOfficialInstallerTool(nextToolState, manifest)) {
    const existingPath = existingTool?.displayPath || existingTool?.installDir || existingTool?.detectedPath || null;
    const installedPath = nextToolState.displayPath || nextToolState.installDir;
    return {
      ...nextToolState,
      installActionMessage: existingPath && existingTool?.source === 'external'
        ? `${manifest.name} now has an official-installer copy at ${installedPath}. Local AI Hub will track that copy honestly and leave the separate detected install at ${existingPath} alone.`
        : `${manifest.name} was installed by its official installer at ${installedPath}. Local AI Hub asked the installer to use that folder and will use the official uninstaller later instead of deleting files directly.`,
    };
  }

  if (existingTool?.source === 'external') {
    return {
      ...nextToolState,
      installActionMessage: `${manifest.name} is now managed by Local AI Hub in ${nextToolState.installDir}. Any separate detected copy on this PC was left untouched.`,
    };
  }

  return nextToolState;
}

async function attachWindowsUninstallMetadata(toolState, manifest, options = {}) {
  const normalizedToolState = normalizeToolLifecycle(toolState, manifest);
  if (manifest.installInstructions?.kind !== 'installer-exe') {
    return normalizedToolState;
  }

  const uninstallContext = await resolveToolUninstallContext(normalizedToolState, manifest, {
    refresh: Boolean(options.refresh),
  }).catch(() => null);
  return enrichToolWithWindowsUninstall(normalizedToolState, uninstallContext);
}

function buildManagedPlacementFailureMessage(manifest, installDir, detectedTool = null) {
  const detectedPath = detectedTool?.displayPath || detectedTool?.installDir || detectedTool?.detectedPath || null;
  if (detectedPath) {
    return `${manifest.name} is still installed outside Local AI Hub at ${detectedPath}. Its installer did not place a managed copy in ${installDir}, so Local AI Hub kept it labeled as detected instead of managed.`;
  }

  return `${manifest.name} finished running, but Local AI Hub could not find its launcher files inside ${installDir}.`;
}

function buildRepairVerificationFailureMessage(manifest, repairedTool, expectedInstallDir) {
  const detectedPath = repairedTool?.displayPath || repairedTool?.installDir || repairedTool?.detectedPath || null;
  if (detectedPath && !isManagedToolState(repairedTool)) {
    return `${manifest.name} is still attached to ${detectedPath}. Local AI Hub did not restore a managed copy inside ${expectedInstallDir}, so repair could not be confirmed as a managed repair.`;
  }

  return `${manifest.name} finished repairing, but Local AI Hub still could not find a working launcher afterward.`;
}

async function verifyRepairedToolState(manifest, expectedToolState, options = {}) {
  const discoveredTools = await syncDiscoveredTools({ force: true });
  const repairedTool = discoveredTools[expectedToolState.id];
  if (!(await toolIsAvailable(repairedTool))) {
    throw new Error(buildRepairVerificationFailureMessage(manifest, repairedTool, expectedToolState.installDir));
  }

  if (options.expectManaged && !isManagedToolState(repairedTool)) {
    throw new Error(buildRepairVerificationFailureMessage(manifest, repairedTool, expectedToolState.installDir));
  }

  return options.expectManaged ? ensureManagedToolStatePaths(repairedTool) : repairedTool;
}

function buildManagedProcessEnv(toolState, extraEnv = {}, options = {}) {
  const safeToolState = ensureManagedToolStatePaths(toolState);
  const stateRoot = path.join(safeToolState.installDir, '.localaihub');
  const cacheDir = path.join(stateRoot, 'cache');
  const tempDir = path.join(stateRoot, 'tmp');
  const pycacheDir = path.join(stateRoot, 'pycache');

  return {
    ...process.env,
    ...extraEnv,
    LOCALAIHUB_TOOL_ID: safeToolState.id,
    LOCALAIHUB_TOOL_ROOT: safeToolState.installDir,
    PIP_CACHE_DIR: cacheDir,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONPYCACHEPREFIX: pycacheDir,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    XDG_CACHE_HOME: cacheDir,
    ...(options.requireVirtualEnv ? { PIP_REQUIRE_VIRTUALENV: '1' } : {}),
  };
}

async function resolveCudaToolkitDetails() {
  const envRoots = [process.env.CUDA_HOME, process.env.CUDA_PATH]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);

  for (const root of envRoots) {
    const resolvedRoot = path.resolve(root);
    const nvccPath = path.join(resolvedRoot, 'bin', 'nvcc.exe');
    if (await fs.pathExists(nvccPath)) {
      return {
        cudaHome: resolvedRoot,
        nvccPath,
        source: 'environment',
      };
    }
  }

  const commonCudaRoot = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA GPU Computing Toolkit', 'CUDA');
  if (await fs.pathExists(commonCudaRoot)) {
    const versionEntries = await fs.readdir(commonCudaRoot).catch(() => []);
    const versionRoots = versionEntries
      .map((entry) => path.join(commonCudaRoot, entry))
      .sort()
      .reverse();

    for (const candidateRoot of versionRoots) {
      const nvccPath = path.join(candidateRoot, 'bin', 'nvcc.exe');
      if (await fs.pathExists(nvccPath)) {
        return {
          cudaHome: candidateRoot,
          nvccPath,
          source: 'common-install-path',
        };
      }
    }
  }

  const whereResult = await runCommand('where.exe', ['nvcc.exe'], {
    allowFailure: true,
  });
  if (whereResult.code === 0) {
    const nvccPath = String(whereResult.stdout || '')
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
    if (nvccPath && (await fs.pathExists(nvccPath))) {
      return {
        cudaHome: path.dirname(path.dirname(nvccPath)),
        nvccPath,
        source: 'path',
      };
    }
  }

  return null;
}

async function resolveInstallPreflightContext(manifest, logger) {
  const checks = Array.isArray(manifest?.installInstructions?.preflightChecks)
    ? manifest.installInstructions.preflightChecks
    : [];
  const env = {};

  for (const check of checks) {
    if (!check || check.kind !== 'cuda-toolkit') {
      continue;
    }

    const cudaToolkit = await resolveCudaToolkitDetails();
    if (!cudaToolkit) {
      throw new Error(
        check.message
          || `${manifest.name} needs the NVIDIA CUDA toolkit to build its Windows dependencies, but this PC does not currently expose nvcc or CUDA_HOME.`,
      );
    }

    env.CUDA_HOME = cudaToolkit.cudaHome;
    env.CUDA_PATH = cudaToolkit.cudaHome;

    await logger.info('Install preflight confirmed a usable CUDA toolkit.', {
      cudaHome: cudaToolkit.cudaHome,
      nvccPath: cudaToolkit.nvccPath,
      source: cudaToolkit.source,
    });
  }

  return { env };
}

function parseVersionParts(value) {
  return String(value || '')
    .split('.')
    .map((part) => Number.parseInt(part.replace(/[^0-9].*$/, ''), 10))
    .filter((part) => Number.isFinite(part));
}

function selectManagedCudaPyTorchBuild(hardware) {
  if (!hardware?.nvidiaSmiAvailable || !/nvidia/i.test(`${hardware.gpuVendor || ''} ${hardware.gpuModel || ''}`)) {
    return null;
  }

  const cudaVersion = parseVersionParts(hardware.nvidiaCudaVersion);
  if (!cudaVersion.length) {
    return null;
  }

  const candidates = PYTORCH_CUDA_INSTALL_BUILDS.filter((build) => compareVersions(cudaVersion, build.minCudaVersion) >= 0);
  if (!candidates.length) {
    return null;
  }

  return [...candidates].sort((left, right) => compareVersions(right.minCudaVersion, left.minCudaVersion))[0];
}

function buildManagedCudaPyTorchPackageSpec(build, packageName) {
  const version = build?.[packageName];
  const channel = String(build?.channel || '').trim();
  if (!version || !channel) {
    throw new Error('Local AI Hub could not identify the PyTorch CUDA package version to install.');
  }

  return `${packageName}==${version}+${channel}`;
}

function buildManagedCudaPyTorchUnsupportedMessage(manifest, hardware) {
  const gpuModel = String(hardware?.gpuModel || '').trim();
  const cudaVersion = String(hardware?.nvidiaCudaVersion || '').trim();
  const minimum = PYTORCH_CUDA_INSTALL_BUILDS[PYTORCH_CUDA_INSTALL_BUILDS.length - 1]?.label || 'a supported CUDA runtime';
  if (!hardware?.nvidiaSmiAvailable || !/nvidia/i.test(`${hardware?.gpuVendor || ''} ${gpuModel}`)) {
    return `${manifest.name} WebUI needs a CUDA-enabled PyTorch build for managed NVIDIA acceleration, but Local AI Hub could not detect a working NVIDIA driver on this PC. Install or update the NVIDIA driver, then run Repair again.`;
  }

  return `${manifest.name} WebUI needs a CUDA-enabled PyTorch build, but this PC reports NVIDIA CUDA runtime ${cudaVersion || 'unknown'}. Local AI Hub needs ${minimum} or newer from the NVIDIA driver. Update the NVIDIA driver, then run Repair again.`;
}

async function removeStaleManagedTorchArtifacts(toolState, logger) {
  const sitePackagesDir = path.join(toolState.venvDir || '', 'Lib', 'site-packages');
  if (!(await fs.pathExists(sitePackagesDir))) {
    return;
  }

  const entries = await fs.readdir(sitePackagesDir, { withFileTypes: true });
  const staleEntries = entries
    .filter((entry) => entry.name.startsWith('~') && /orch/i.test(entry.name))
    .map((entry) => path.join(sitePackagesDir, entry.name));

  for (const targetPath of staleEntries) {
    await fs.remove(targetPath).catch(() => null);
    await logger.info('Removed a stale PyTorch package artifact before installing CUDA wheels.', {
      targetPath,
    });
  }
}

async function verifyManagedCudaPyTorch(toolState, build, logger) {
  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  const verificationSnippet = [
    'import importlib, json',
    'info = {}',
    'import torch',
    "info['torchVersion'] = getattr(torch, '__version__', 'unknown')",
    "info['cudaAvailable'] = bool(torch.cuda.is_available())",
    "info['cudaVersion'] = getattr(torch.version, 'cuda', None)",
    "info['deviceName'] = torch.cuda.get_device_name(0) if info['cudaAvailable'] else None",
    "info['imports'] = {}",
    "for module_name in ['torchvision', 'torchaudio']:",
    "    try:",
    "        module = importlib.import_module(module_name)",
    "        info['imports'][module_name] = getattr(module, '__version__', 'imported')",
    "    except Exception as exc:",
    "        info['imports'][module_name] = exc.__class__.__name__ + ': ' + str(exc)",
    'print(json.dumps(info))',
  ].join('\n');
  const result = await runCommand(pythonPath, ['-c', verificationSnippet], {
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
    errorMessage: `Local AI Hub could not verify ${toolState.name || 'this tool'}'s CUDA PyTorch runtime.`,
  });
  const payload = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{'));
  if (!payload) {
    throw new Error('Local AI Hub could not read the PyTorch CUDA verification result.');
  }

  const verification = JSON.parse(payload);
  const torchVersion = String(verification.torchVersion || '').trim();
  const torchCudaVersion = String(verification.cudaVersion || '').trim();
  if (!torchCudaVersion || /\+cpu\b/i.test(torchVersion)) {
    throw new Error(`${toolState.name || 'This tool'} has a CPU-only PyTorch build (${torchVersion || 'unknown'}). Run Repair so Local AI Hub can reinstall the NVIDIA ${build.label} PyTorch wheels.`);
  }

  if (!verification.cudaAvailable) {
    throw new Error(`${toolState.name || 'This tool'} has NVIDIA PyTorch ${torchVersion || build.label}, but PyTorch still cannot use the GPU. Update the NVIDIA driver, close other GPU tools, then run Repair again.`);
  }

  const failedCompanionImports = Object.entries(verification.imports || {})
    .filter(([, value]) => /(?:error|exception|modulenotfound|importerror)/i.test(String(value || '')));
  if (failedCompanionImports.length) {
    throw new Error(`${toolState.name || 'This tool'} installed PyTorch CUDA, but torchvision or torchaudio does not match it. Run Repair so Local AI Hub can reinstall the matching NVIDIA PyTorch stack.`);
  }

  await logger.info('Managed CUDA PyTorch verification succeeded.', verification);
  return verification;
}

async function ensureManagedCudaPyTorch(toolState, manifest, logger, onProgress) {
  if (!MANAGED_CUDA_PYTORCH_INSTALL_TOOL_IDS.has(manifest?.id)) {
    return null;
  }

  const hardware = await detectHardwareSnapshot().catch(() => null);
  const build = selectManagedCudaPyTorchBuild(hardware);
  if (!build) {
    await logger.warn('Managed CUDA PyTorch install could not select a supported NVIDIA wheel.', {
      gpuModel: hardware?.gpuModel || null,
      gpuVendor: hardware?.gpuVendor || null,
      nvidiaCudaVersion: hardware?.nvidiaCudaVersion || null,
      nvidiaSmiAvailable: Boolean(hardware?.nvidiaSmiAvailable),
    });
    throw new Error(buildManagedCudaPyTorchUnsupportedMessage(manifest, hardware));
  }

  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  await advanceStep(logger, onProgress, {
    toolId: toolState.id,
    percent: 91,
    stage: 'dependencies',
    message: `Installing NVIDIA PyTorch ${build.label}.`,
  });
  await removeStaleManagedTorchArtifacts(toolState, logger);
  await runCommand(
    pythonPath,
    [
      '-m',
      'pip',
      'install',
      '--upgrade',
      '--force-reinstall',
      '--no-cache-dir',
      buildManagedCudaPyTorchPackageSpec(build, 'torch'),
      buildManagedCudaPyTorchPackageSpec(build, 'torchvision'),
      buildManagedCudaPyTorchPackageSpec(build, 'torchaudio'),
      '--index-url',
      build.indexUrl,
    ],
    {
      cwd: toolState.appDir,
      env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
      errorMessage: `Local AI Hub could not install NVIDIA PyTorch ${build.label} for ${manifest.name}.`,
    },
  );

  await logger.info('Managed CUDA PyTorch install finished.', {
    build: build.channel,
    gpuModel: hardware?.gpuModel || null,
    indexUrl: build.indexUrl,
  });
  return verifyManagedCudaPyTorch(toolState, build, logger);
}

async function verifyCachedDownload(manifest, archivePath, logger) {
  try {
    return await verifyDownloadedFileIntegrity(manifest.downloadUrl, archivePath, logger, `${manifest.name} installer`);
  } catch (error) {
    await fs.remove(archivePath).catch(() => null);
    throw error;
  }
}
function reportProgress(callback, payload) {
  if (typeof callback === 'function') {
    callback(payload);
  }
}

async function advanceStep(logger, callback, payload, context = {}) {
  await logger.info(payload.message, {
    stage: payload.stage,
    percent: payload.percent,
    ...context,
  });
  reportProgress(callback, payload);
}

async function fetchWithTimeout(url, logger) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    await logger.info('Opening installer download connection.', {
      url,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': `LocalAIHub/${APP_VERSION}`,
      },
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Local AI Hub could not reach the download server. Check your internet connection and try again.');
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function hasUsableArchiveCache(archivePath, logger) {
  if (!(await fs.pathExists(archivePath))) {
    return false;
  }

  const stats = await fs.stat(archivePath);
  if (stats.size < MIN_CACHE_BYTES) {
    await logger.warn('Discarding incomplete cached installer archive.', {
      archivePath,
      sizeBytes: stats.size,
    });
    await fs.remove(archivePath);
    return false;
  }

  await logger.info('Using cached installer archive.', {
    archivePath,
    sizeBytes: stats.size,
  });
  return true;
}

function buildPackageDownloadFailureMessage(response) {
  const status = Number(response?.status || 0);

  if (status === 404 || status === 410) {
    return 'Local AI Hub could not find the installer package at the publisher download URL.';
  }

  if (status === 403) {
    return 'Local AI Hub could not download the installer package because the source refused the request.';
  }

  if (status >= 500) {
    return 'Local AI Hub could not download the installer package because the source is unavailable right now.';
  }

  return 'Local AI Hub could not download the installer package from the publisher.';
}

async function readFileSignature(filePath, bytes = PACKAGE_SIGNATURE_BYTES) {
  const fileHandle = await open(filePath, 'r');
  const buffer = Buffer.alloc(bytes);

  try {
    const result = await fileHandle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await fileHandle.close().catch(() => null);
  }
}

function signatureStartsWith(signature, magic) {
  return signature.length >= magic.length && magic.every((byte, index) => signature[index] === byte);
}

function isLikelyMarkupPayload(signature) {
  const preview = signature.toString('utf8').trimStart().toLowerCase();
  return preview.startsWith('<!doctype') || preview.startsWith('<html') || preview.startsWith('<?xml');
}

function inferDownloadedPackageKind(manifest, archivePath) {
  const extension = path.extname(archivePath || '').toLowerCase();

  if (extension === '.zip') {
    return 'zip';
  }

  if (extension === '.7z') {
    return '7z';
  }

  if (extension === '.exe') {
    return 'exe';
  }

  if (manifest.installInstructions.kind === 'single-file' || manifest.installInstructions.kind === 'installer-exe') {
    return 'exe';
  }

  return 'unknown';
}

function describeDownloadedPackageKind(packageKind) {
  if (packageKind === 'zip') {
    return 'a ZIP archive';
  }

  if (packageKind === '7z') {
    return 'a 7-Zip archive';
  }

  if (packageKind === 'exe') {
    return 'a Windows executable';
  }

  return 'a supported installer package';
}

async function validateDownloadedPackage(manifest, archivePath, logger) {
  const stats = await fs.stat(archivePath).catch(() => null);
  if (!stats?.size || stats.size < MIN_CACHE_BYTES) {
    await fs.remove(archivePath).catch(() => null);
    throw new Error('Local AI Hub downloaded the installer package, but the file was incomplete.');
  }

  const packageKind = inferDownloadedPackageKind(manifest, archivePath);
  const signature = await readFileSignature(archivePath);
  const validSignature =
    packageKind === 'zip'
      ? signatureStartsWith(signature, ZIP_HEADER)
      : packageKind === '7z'
        ? signatureStartsWith(signature, SEVEN_ZIP_HEADER)
        : packageKind === 'exe'
          ? signatureStartsWith(signature, PE_HEADER)
          : true;

  if (validSignature) {
    return;
  }

  await logger.warn('Downloaded installer package did not match the expected file signature.', {
    archivePath,
    packageKind,
    signatureHex: signature.toString('hex'),
  });
  await fs.remove(archivePath).catch(() => null);

  if (isLikelyMarkupPayload(signature)) {
    throw new Error(`Local AI Hub reached the download source, but it returned a web page instead of ${describeDownloadedPackageKind(packageKind)}.`);
  }

  throw new Error(`Local AI Hub downloaded the installer package, but the file did not look like ${describeDownloadedPackageKind(packageKind)}.`);
}

async function downloadFile(url, destination, onProgress, logger, toolId) {
  assertSecureRemoteUrl(url, 'installer download URL');

  await advanceStep(
    logger,
    onProgress,
    {
      toolId,
      percent: 10,
      stage: 'downloading',
      message: 'Connecting to the download source.',
    },
    { url },
  );

  const response = await fetchWithTimeout(url, logger);
  if (!response.ok) {
    throw new Error(buildPackageDownloadFailureMessage(response));
  }

  if (!response.body) {
    throw new Error('Local AI Hub reached the download source, but it did not send the installer file.');
  }

  await fs.ensureDir(path.dirname(destination));
  const fileHandle = await open(destination, 'w');
  const reader = response.body.getReader();
  const total = Number(response.headers.get('content-length')) || 0;
  let downloaded = 0;
  let nextLogThreshold = 25;
  let nextUnknownLogBytes = 10 * 1024 * 1024;

  await logger.info('Installer download started.', {
    destination,
    totalBytes: total || null,
  });

  try {
    await advanceStep(
      logger,
      onProgress,
      {
        toolId,
        percent: 18,
        stage: 'downloading',
        message:
          total > 0
            ? 'Downloading the installer package.'
            : 'Downloading the installer package. The source did not report a file size.',
      },
      { totalBytes: total || null },
    );

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      downloaded += chunk.length;
      await fileHandle.write(chunk, 0, chunk.length);

      if (total > 0) {
        const percent = Math.min(45, 18 + Math.round((downloaded / total) * 27));
        reportProgress(onProgress, {
          toolId,
          percent,
          stage: 'downloading',
          message: 'Downloading the installer package.',
        });

        const percentComplete = Math.round((downloaded / total) * 100);
        if (percentComplete >= nextLogThreshold) {
          await logger.info('Installer download progress.', {
            downloadedBytes: downloaded,
            totalBytes: total,
            progressPercent: percentComplete,
          });
          nextLogThreshold += 25;
        }
      } else if (downloaded >= nextUnknownLogBytes) {
        await logger.info('Installer download progress.', {
          downloadedBytes: downloaded,
          totalBytes: null,
        });
        nextUnknownLogBytes += 10 * 1024 * 1024;
      }
    }

    await logger.info('Installer download finished.', {
      downloadedBytes: downloaded,
      totalBytes: total || null,
      destination,
    });
  } catch (error) {
    await logger.error('Installer download failed.', {
      destination,
      error,
    });
    await fs.remove(destination).catch(() => null);
    throw error;
  } finally {
    await fileHandle.close().catch(() => null);
  }
}

async function extractArchive(archivePath, targetDirectory, logger) {
  const tempDirectory = `${targetDirectory}__extract`;
  await logger.info('Extracting installer archive.', {
    archivePath,
    targetDirectory,
  });

  await fs.remove(tempDirectory);
  await fs.ensureDir(tempDirectory);

  const extension = path.extname(archivePath).toLowerCase();
  if (extension === '.7z' || extension === '.exe') {
    const sevenZipPath = app.isPackaged
      ? path.join(process.resourcesPath, 'bin', '7za.exe')
      : path.join(__dirname, '..', '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

    if (!(await fs.pathExists(sevenZipPath))) {
      throw new Error('Local AI Hub is missing its 7-Zip helper and could not unpack that installer package.');
    }

    await fs.emptyDir(tempDirectory);
    await runCommand(sevenZipPath, ['x', archivePath, '-y', `-o${tempDirectory}`], {
      cwd: path.dirname(archivePath),
      errorMessage: 'Local AI Hub could not unpack the installer package.',
    });
  } else {
    await extract(archivePath, { dir: tempDirectory });
  }

  const entries = await fs.readdir(tempDirectory);
  const firstEntryPath = entries.length === 1 ? path.join(tempDirectory, entries[0]) : null;
  const hasSingleRoot =
    firstEntryPath && (await fs.stat(firstEntryPath)).isDirectory() && entries.length === 1;

  await fs.remove(targetDirectory);

  if (hasSingleRoot) {
    await fs.move(firstEntryPath, targetDirectory, { overwrite: true });
    await fs.remove(tempDirectory);
    await logger.info('Installer archive extracted into a single root folder.', {
      targetDirectory,
    });
    return targetDirectory;
  }

  await fs.move(tempDirectory, targetDirectory, { overwrite: true });
  await logger.info('Installer archive extracted into the app directory.', {
    targetDirectory,
  });
  return targetDirectory;
}

function getUniqueDirectoryRoots(paths = []) {
  const unique = [];
  const seen = new Set();
  for (const entry of paths.map((value) => path.resolve(String(value || ''))).filter(Boolean).sort((left, right) => left.length - right.length)) {
    const key = entry.toLowerCase();
    if (seen.has(key) || unique.some((existing) => isPathInside(existing, entry))) {
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

async function existingDirectoryRoots(paths = []) {
  const results = [];
  for (const entry of getUniqueDirectoryRoots(paths)) {
    const stats = await fs.stat(entry).catch(() => null);
    if (stats?.isDirectory()) {
      results.push(entry);
    }
  }
  return results;
}

function getToolModelAssetDirectories(toolState) {
  try {
    const { getToolModelDirectories } = require('./modelService');
    return Object.values(getToolModelDirectories(toolState) || {}).filter(Boolean);
  } catch {
    return [];
  }
}

async function collectRepairPreservedModelAssetRoots(toolState) {
  if (!isManagedToolState(toolState)) {
    return [];
  }
  const appDir = normalizeOptionalDirectoryPath(toolState?.appDir || '');
  if (!appDir) {
    return [];
  }
  return existingDirectoryRoots(getToolModelAssetDirectories(toolState).filter((entry) => isPathInside(appDir, entry)));
}

async function collectManagedModelAssetRootsForUninstall(toolState) {
  if (!isManagedToolState(toolState)) {
    return [];
  }
  const installDir = normalizeOptionalDirectoryPath(toolState?.installDir || '');
  const modelsRoot = normalizeOptionalDirectoryPath(getAppPaths().modelsRoot || '');
  if (!modelsRoot) {
    return [];
  }
  return existingDirectoryRoots(
    getToolModelAssetDirectories(toolState).filter((entry) => {
      const resolvedEntry = path.resolve(entry);
      if (installDir && isPathInside(installDir, resolvedEntry)) {
        return false;
      }
      return isPathInside(modelsRoot, resolvedEntry) && path.resolve(modelsRoot) !== resolvedEntry;
    }),
  );
}

async function preserveModelManagerAssetsForAction(toolState, logger, operationLabel, action) {
  const appDir = normalizeOptionalDirectoryPath(toolState?.appDir || '');
  const installDir = normalizeOptionalDirectoryPath(toolState?.installDir || '') || (appDir ? path.dirname(appDir) : '');
  const assetRoots = await collectRepairPreservedModelAssetRoots(toolState);
  if (!assetRoots.length || !appDir || !installDir) {
    return action();
  }

  const preserveRoot = path.join(
    installDir,
    '.localaihub-' + String(operationLabel || 'repair').replace(/[^a-z0-9_-]+/gi, '-') + '-model-assets-' + Date.now(),
  );
  const preservedEntries = [];

  try {
    for (const assetRoot of assetRoots) {
      if (!(await fs.pathExists(assetRoot))) {
        continue;
      }
      const relativePath = path.relative(appDir, assetRoot);
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        continue;
      }
      const preservedPath = path.join(preserveRoot, relativePath);
      await fs.ensureDir(path.dirname(preservedPath));
      await fs.move(assetRoot, preservedPath, { overwrite: true });
      preservedEntries.push({ preservedPath, restorePath: assetRoot });
    }

    if (preservedEntries.length) {
      await logger?.info?.('Preserved Model Manager assets before repairing app files.', {
        operationLabel,
        preservedPaths: preservedEntries.map((entry) => entry.restorePath),
        toolId: toolState?.id || null,
      });
    }

    return await action();
  } finally {
    for (const entry of preservedEntries.reverse()) {
      if (!(await fs.pathExists(entry.preservedPath))) {
        continue;
      }
      await fs.ensureDir(path.dirname(entry.restorePath));
      if (await fs.pathExists(entry.restorePath)) {
        await mergeDirectoryContents(entry.preservedPath, entry.restorePath);
      } else {
        await fs.move(entry.preservedPath, entry.restorePath, { overwrite: false }).catch(async () => {
          await mergeDirectoryContents(entry.preservedPath, entry.restorePath);
        });
      }
    }
    await fs.remove(preserveRoot).catch(() => null);
    if (preservedEntries.length) {
      await logger?.info?.('Restored Model Manager assets after repairing app files.', {
        operationLabel,
        restoredPaths: preservedEntries.map((entry) => entry.restorePath),
        toolId: toolState?.id || null,
      });
    }
  }
}

async function removeManagedModelManagerAssets(toolState, logger, operationLabel) {
  const assetRoots = await collectManagedModelAssetRootsForUninstall(toolState);
  const removedPaths = [];
  for (const assetRoot of assetRoots) {
    if (!(await fs.pathExists(assetRoot))) {
      continue;
    }
    await removePathWithRetries(assetRoot, logger, operationLabel);
    removedPaths.push(assetRoot);
  }
  if (removedPaths.length) {
    await logger?.info?.('Removed managed Model Manager assets during uninstall.', {
      operationLabel,
      removedPaths,
      toolId: toolState?.id || null,
    });
  }
  return {
    removedModelAssetRootCount: removedPaths.length,
    removedModelAssetRoots: removedPaths,
  };
}

async function extractArchiveWithRecovery(manifest, archivePath, targetDirectory, onProgress, logger, toolId) {
  try {
    await extractArchive(archivePath, targetDirectory, logger);
  } catch (error) {
    await logger.warn('Installer archive extraction failed. Clearing the cached archive and retrying once.', {
      archivePath,
      error,
    });
    await fs.remove(archivePath).catch(() => null);

    await downloadFile(manifest.downloadUrl, archivePath, onProgress, logger, toolId);
    await verifyCachedDownload(manifest, archivePath, logger);
    await advanceStep(logger, onProgress, {
      toolId,
      percent: 50,
      stage: 'extracting',
      message: 'Expanding the installer package.',
    });

    try {
      await extractArchive(archivePath, targetDirectory, logger);
    } catch (retryError) {
      await logger.error('Installer archive extraction failed after retry.', {
        archivePath,
        error: retryError,
      });
      throw new Error('Local AI Hub could not unpack the installer package. The cached download was replaced, so try Install again.');
    }
  }
}

async function installPythonDependencies(toolState, manifest, onProgress, logger, pythonRuntime) {
  toolState = ensureManagedToolStatePaths(toolState);
  const python = pythonRuntime || (await resolvePythonCommand());
  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  const stateRoot = path.join(toolState.installDir, '.localaihub');

  await Promise.all([
    fs.ensureDir(toolState.installDir),
    fs.ensureDir(toolState.appDir),
    fs.ensureDir(path.join(stateRoot, 'cache')),
    fs.ensureDir(path.join(stateRoot, 'tmp')),
    fs.ensureDir(path.join(stateRoot, 'pycache')),
  ]);

  const preflightContext = await resolveInstallPreflightContext(manifest, logger);
  const optionalInstallWarnings = [];

  await advanceStep(
    logger,
    onProgress,
    {
      toolId: toolState.id,
      percent: 66,
      stage: 'environment',
      message: 'Creating a dedicated Python environment.',
    },
    {
      launcher: python.pythonPath || python.executable || python.launcher,
      version: python.versionString,
    },
  );

  if (python.pythonPath) {
    await runCommand(python.pythonPath, ['-m', 'venv', toolState.venvDir], {
      cwd: toolState.appDir,
      env: buildManagedProcessEnv(toolState),
      errorMessage: 'Local AI Hub could not create the Python virtual environment.',
    });
  } else {
    await runCommand(python.launcher, [...python.launcherArgs, '-m', 'venv', toolState.venvDir], {
      cwd: toolState.appDir,
      env: buildManagedProcessEnv(toolState),
      errorMessage: 'Local AI Hub could not create the Python virtual environment.',
    });
  }

  await logger.info('Python virtual environment created.', {
    venvDir: toolState.venvDir,
  });

  const packagingBootstrapPackages = resolvePackagingBootstrapPackages(manifest);
  await advanceStep(logger, onProgress, {
    toolId: toolState.id,
    percent: 72,
    stage: 'dependencies',
    message: 'Preparing pip, setuptools, and wheel inside the virtual environment.',
  });

  await runCommand(pythonPath, ['-m', 'pip', 'install', '--upgrade', ...packagingBootstrapPackages], {
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, preflightContext.env, { requireVirtualEnv: true }),
    errorMessage: 'Local AI Hub could not prepare the tool environment.',
  });

  await logger.info('The Python packaging tools were updated inside the tool environment.', {
    bootstrapPackages: packagingBootstrapPackages,
    pythonPath,
  });

  const instructions = manifest.installInstructions.pipInstalls || [];
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    const baseProgress = 78 + Math.round((index / Math.max(1, instructions.length)) * 14);
    const templateContext = resolveInstructionTemplateContext(toolState, pythonPath);
    const pipArgs = resolveInstructionList(instruction.pipArgs, templateContext);
    const instructionEnv = resolveInstructionEnv(instruction, templateContext);
    let instructionCudaToolkit = null;
    let args = ['-m', 'pip', 'install', ...pipArgs];
    let command = pythonPath;
    let errorMessage = instruction.errorMessage || `Local AI Hub could not install ${manifest.name} dependencies.`;
    let installTarget = instruction.value;
    let message = instruction.message || `Installing ${manifest.name} dependencies.`;
    let workingDir = toolState.appDir;

    if (instruction.kind === 'requirements') {
      const requirementsPath = assertPathInside(
        toolState.appDir,
        path.resolve(toolState.appDir, resolveInstructionText(instruction.value, templateContext)),
        'Local AI Hub refused to install dependencies from outside the tool folder.',
      );
      if (!(await fs.pathExists(requirementsPath))) {
        await logger.warn('Skipping missing requirements file.', {
          requirementsPath,
        });
        continue;
      }

      installTarget = await buildFilteredRequirementsPath(toolState, requirementsPath, instruction, logger, index);
      args = [...args, '-r', installTarget];
    } else if (instruction.kind === 'requirements-entry') {
      const requirementsPath = assertPathInside(
        toolState.appDir,
        path.resolve(toolState.appDir, resolveInstructionText(instruction.value, templateContext)),
        'Local AI Hub refused to install dependencies from outside the tool folder.',
      );
      if (!(await fs.pathExists(requirementsPath))) {
        throw new Error(`Local AI Hub could not find ${manifest.name}'s requirements file for ${instruction.packageName || 'the requested package'}.`);
      }

      installTarget = assertSafePipInstallTarget(await findRequirementEntry(requirementsPath, instruction.packageName));
      args = [...args, installTarget];
    } else if (instruction.kind === 'path') {
      installTarget = assertPathInside(
        toolState.appDir,
        path.resolve(toolState.appDir, resolveInstructionText(instruction.value, templateContext)),
        'Local AI Hub refused to install a Python package path outside the tool folder.',
      );
      args = [...args, installTarget];
    } else if (instruction.kind === 'python-script') {
      const scriptPath = assertPathInside(
        toolState.appDir,
        path.resolve(toolState.appDir, resolveInstructionText(instruction.value, templateContext)),
        'Local AI Hub refused to run a setup script outside the tool folder.',
      );
      if (!(await fs.pathExists(scriptPath))) {
        await logger.warn('Skipping missing Python setup script.', {
          scriptPath,
        });
        continue;
      }

      const scriptArgs = resolveInstructionList(instruction.args, templateContext);
      installTarget = scriptPath;
      args = [scriptPath, ...scriptArgs];
      message = instruction.message || `Running the ${manifest.name} setup script.`;
      errorMessage = instruction.errorMessage || `Local AI Hub could not finish the ${manifest.name} setup script.`;
      workingDir = instruction.workingDir
        ? assertPathInside(
            toolState.appDir,
            path.resolve(toolState.appDir, resolveInstructionText(instruction.workingDir, templateContext)),
            'Local AI Hub refused to use a setup working folder outside the tool directory.',
          )
        : toolState.appDir;
    } else {
      installTarget = assertSafePipInstallTarget(resolveInstructionText(instruction.value, templateContext));
      args = [...args, installTarget];
    }

    if (instruction.requiresCudaToolkit) {
      instructionCudaToolkit = await resolveCudaToolkitDetails();
      if (!instructionCudaToolkit) {
        const warningMessage = buildOptionalDependencyWarning(
          manifest,
          instruction,
          buildMissingCudaToolkitDependencyMessage(manifest, instruction),
        );
        if (isOptionalInstruction(instruction)) {
          optionalInstallWarnings.push(warningMessage);
          await logger.warn('Skipping optional dependency because the CUDA Toolkit is not available.', {
            installTarget,
            warningMessage,
          });
          await advanceStep(logger, onProgress, {
            toolId: toolState.id,
            percent: baseProgress,
            stage: 'dependencies',
            message: warningMessage,
          });
          continue;
        }

        throw new Error(buildMissingCudaToolkitDependencyMessage(manifest, instruction));
      }

      await logger.info('Dependency step confirmed a usable CUDA toolkit.', {
        cudaHome: instructionCudaToolkit.cudaHome,
        installTarget,
        nvccPath: instructionCudaToolkit.nvccPath,
        source: instructionCudaToolkit.source,
      });
    }

    const baseEnv = buildManagedProcessEnv(
      toolState,
      { ...preflightContext.env, ...buildCudaToolkitEnv(instructionCudaToolkit), ...instructionEnv },
      { requireVirtualEnv: true },
    );

    await advanceStep(
      logger,
      onProgress,
      {
        toolId: toolState.id,
        percent: baseProgress,
        stage: 'dependencies',
        message,
      },
      {
        installTarget,
        pipArgs: pipArgs.length ? pipArgs : undefined,
      },
    );

    try {
      await runCommand(command, args, {
        cwd: workingDir,
        env: baseEnv,
        errorMessage,
      });
    } catch (error) {
      const dependencyError = buildDependencyInstallFailure(manifest, error, errorMessage);
      if (isOptionalInstruction(instruction)) {
        const warningMessage = buildOptionalDependencyWarning(manifest, instruction, dependencyError.message);
        optionalInstallWarnings.push(warningMessage);
        await logger.warn('Optional dependency installation failed; continuing with fallback behavior.', {
          error: dependencyError,
          installTarget,
          warningMessage,
        });
        continue;
      }

      throw dependencyError;
    }

    await logger.info('Dependency installation step finished.', {
      installTarget,
      pipArgs: pipArgs.length ? pipArgs : undefined,
    });
  }

  toolState.optionalInstallWarnings = optionalInstallWarnings;
  return optionalInstallWarnings;
}

async function resolveManagedPythonRuntime(appDir, manifest, logger, onProgress, toolId) {
  if (getToolRuntime(manifest) !== 'python') {
    return null;
  }

  await advanceStep(logger, onProgress, {
    toolId,
    percent: 54,
    stage: 'runtime',
    message: 'Inspecting the downloaded tool for Python requirements.',
  });

  const requirement = await detectPythonRequirement(appDir, manifest, logger);
  await logger.info('Tool Python requirement resolved.', {
    requirement: describePythonRequirement(requirement),
  });

  const runtime = await ensureManagedPythonRuntime(requirement, {
    logger,
    onProgress,
    toolId,
    toolName: manifest.name,
  });

  return {
    requirement,
    runtime,
  };
}

function resolveLaunchProfileTargetPath(launchProfile) {
  if (!launchProfile?.target) {
    return null;
  }

  if (path.isAbsolute(launchProfile.target)) {
    return launchProfile.target;
  }

  const baseDir = launchProfile.workingDir || '';
  return baseDir ? path.resolve(baseDir, launchProfile.target) : null;
}

const CHATTERBOX_SERVER_LAUNCH_SHIM = '.localaihub_launch_chatterbox_server.py';

function buildChatterboxServerLaunchShimScript() {
  return String.raw`from __future__ import annotations

import argparse
import os
import runpy
import sys
import webbrowser
from pathlib import Path


def deep_update(target, patch):
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            deep_update(target[key], value)
        else:
            target[key] = value
    return target


def load_yaml(path):
    try:
        import yaml
        if path.exists():
            data = yaml.safe_load(path.read_text(encoding="utf-8-sig")) or {}
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}
    return {}


def save_yaml(path, data):
    import yaml
    path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=False), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8004)
    args, remaining = parser.parse_known_args()
    root = Path.cwd()
    server_py = root / "server.py"
    if not server_py.exists():
        raise SystemExit("Chatterbox-TTS-Server server.py is missing. Run Repair to restore the WebUI files.")

    for folder in ("voices", "reference_audio", "outputs", "model_cache", "logs"):
        (root / folder).mkdir(parents=True, exist_ok=True)

    config_path = root / "config.yaml"
    config = load_yaml(config_path)
    patch = {
        "server": {
            "host": "127.0.0.1",
            "port": int(args.port),
            "use_ngrok": False,
            "use_auth": False,
            "log_file_path": "logs/tts_server.log",
        },
        "model": {
            "repo_id": "chatterbox-turbo",
        },
        "tts_engine": {
            "device": "cuda",
            "predefined_voices_path": "voices",
            "reference_audio_path": "reference_audio",
        },
        "paths": {
            "model_cache": "model_cache",
            "output": "outputs",
        },
        "audio_output": {
            "format": "wav",
            "sample_rate": 24000,
            "save_to_disk": False,
        },
    }
    deep_update(config, patch)
    save_yaml(config_path, config)

    webbrowser.open = lambda *args, **kwargs: True
    os.environ.setdefault("TTS_BF16", "off")
    os.environ["LOCALAIHUB_CHATTERBOX_SERVER"] = "1"
    sys.argv = [str(server_py)] + remaining
    runpy.run_path(str(server_py), run_name="__main__")


if __name__ == "__main__":
    main()
`;
}

async function ensureChatterboxServerLaunchShim(toolState, manifest, logger) {
  if (manifest?.id !== 'chatterbox-tts') {
    return;
  }

  const appDir = toolState?.appDir || toolState?.installDir;
  if (!appDir) {
    return;
  }

  const serverPath = path.join(appDir, 'server.py');
  if (!(await fs.pathExists(serverPath))) {
    return;
  }

  const shimPath = path.join(appDir, CHATTERBOX_SERVER_LAUNCH_SHIM);
  await fs.outputFile(shimPath, buildChatterboxServerLaunchShimScript(), 'utf8');
  await logger.info('Prepared Chatterbox-TTS-Server localhost launch shim.', {
    path: shimPath,
    toolId: toolState.id,
  });
}

function buildChatterboxPipelineVerificationScript() {
  return [
    'import importlib, json, os, sys',
    'checks = [["torch", "torch"], ["torchaudio", "torchaudio"], ["pkg_resources", "pkg_resources"], ["chatterbox.tts_turbo", "ChatterboxTurboTTS"]]',
    'server_checks = [["fastapi", "fastapi"], ["uvicorn", "uvicorn"], ["yaml", "PyYAML"], ["jinja2", "Jinja2"], ["aiofiles", "aiofiles"], ["inflect", "inflect"], ["unidecode", "unidecode"], ["audiotsm", "audiotsm"], ["parselmouth", "praat-parselmouth"]]',
    'if os.path.exists("server.py"):',
    '    checks.extend(server_checks)',
    'missing = []',
    'failures = []',
    'torch_module = None',
    'server_turbo_available = None',
    'for module_name, label in checks:',
    '    try:',
    '        module = importlib.import_module(module_name)',
    '        if module_name == "torch":',
    '            torch_module = module',
    '    except ModuleNotFoundError as exc:',
    '        missing.append(str(getattr(exc, "name", "") or label))',
    '    except Exception as exc:',
    '        failures.append({"module": module_name, "label": label, "errorType": exc.__class__.__name__})',
    'if os.path.exists("server.py") and not missing:',
    '    try:',
    '        engine = importlib.import_module("engine")',
    '        server_turbo_available = bool(getattr(engine, "TURBO_AVAILABLE", False)) and "chatterbox-turbo" in getattr(engine, "MODEL_SELECTOR_MAP", {})',
    '        if not server_turbo_available:',
    '            failures.append({"module": "engine", "label": "Chatterbox-TTS-Server Turbo", "errorType": "TurboUnavailable"})',
    '    except Exception as exc:',
    '        failures.append({"module": "engine", "label": "Chatterbox-TTS-Server", "errorType": exc.__class__.__name__})',
    'cuda_available = bool(torch_module and torch_module.cuda.is_available())',
    'torch_version = str(getattr(torch_module, "__version__", "")) if torch_module else ""',
    'torch_cuda = str(getattr(getattr(torch_module, "version", None), "cuda", "")) if torch_module else ""',
    'gpu_name = torch_module.cuda.get_device_name(0) if cuda_available else ""',
    'payload = {"ready": not missing and not failures and cuda_available, "missing": sorted(set(missing)), "failures": failures, "cudaAvailable": cuda_available, "torchVersion": torch_version, "torchCudaVersion": torch_cuda, "gpuName": gpu_name, "serverTurboAvailable": server_turbo_available}',
    'print(json.dumps(payload))',
    'sys.exit(0 if payload["ready"] else 3)',
  ].join('\n');
}
function buildAudiocraftPipelineVerificationScript() {
  return [
    'import importlib, json, sys',
    'checks = [["numpy", "numpy"], ["torchaudio", "torchaudio"], ["audiocraft", "audiocraft"], ["audiocraft.data.audio", "audiocraft.data.audio"], ["audiocraft.models", "audiocraft.models"]]',
    'missing = []',
    'failures = []',
    'for module_name, label in checks:',
    '    try:',
    '        importlib.import_module(module_name)',
    '    except ModuleNotFoundError as exc:',
    '        missing.append(str(getattr(exc, "name", "") or label))',
    '    except Exception as exc:',
    '        failures.append({"module": module_name, "label": label, "errorType": exc.__class__.__name__})',
    'payload = {"ready": not missing and not failures, "missing": sorted(set(missing)), "failures": failures}',
    'print(json.dumps(payload))',
    'sys.exit(0 if payload["ready"] else 3)',
  ].join('\n');
}

function parseAudiocraftPipelineVerification(stdout) {
  const lastLine = String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find(Boolean);
  if (!lastLine) {
    return null;
  }
  try {
    return JSON.parse(lastLine);
  } catch {
    return null;
  }
}

function buildChatterboxPipelineInstallFailureMessage(probe) {
  const missing = [...new Set((probe?.missing || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (missing.length) {
    return 'Local AI Hub installed Chatterbox-Turbo TTS, but its Python environment is missing the packages needed for reference voice TTS: ' + missing.join(', ') + '. Run Repair or reinstall Chatterbox-Turbo TTS, then try again.';
  }

  if (probe && probe.cudaAvailable === false) {
    const torchVersion = String(probe?.torchVersion || '').trim();
    const suffix = torchVersion ? ' Current torch version: ' + torchVersion + '.' : '';
    return 'Local AI Hub installed Chatterbox-Turbo TTS, but PyTorch is not CUDA-enabled or CUDA is unavailable. Run Repair so Local AI Hub can install torch 2.6.0 with CUDA 12.4, then try again.' + suffix;
  }

  return 'Local AI Hub installed Chatterbox-Turbo TTS, but it could not load the Python packages needed for reference voice TTS. Run Repair or reinstall Chatterbox-Turbo TTS, then try again.';
}
function buildAudiocraftPipelineInstallFailureMessage(probe) {
  const missing = [...new Set((probe?.missing || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (missing.length) {
    return 'Local AI Hub installed AudioCraft WebUI, but its Python environment is missing the packages needed for pipeline audio generation: ' + missing.join(', ') + '. Run Repair or reinstall AudioCraft WebUI, then try again.';
  }

  return 'Local AI Hub installed AudioCraft WebUI, but it could not load the Python packages needed for pipeline audio generation. Run Repair or reinstall AudioCraft WebUI, then try again.';
}

function buildComfyUiDependencyVerificationScript() {
  return [
    'import importlib, json, os, sys',
    'checks = [["torchvision", "torchvision"], ["torchaudio", "torchaudio"], ["torchsde", "torchsde"], ["numpy", "NumPy"], ["PIL", "Pillow"], ["yaml", "PyYAML"], ["aiohttp", "aiohttp"], ["safetensors", "safetensors"], ["psutil", "psutil"], ["tqdm", "tqdm"]]',
    'missing = []',
    'failures = []',
    'versions = {}',
    'cuda_available = False',
    'cuda_version = ""',
    'torch_version = ""',
    'device_name = ""',
    'try:',
    '    torch = importlib.import_module("torch")',
    '    torch_version = str(getattr(torch, "__version__", "") or "")',
    '    cuda_version = str(getattr(getattr(torch, "version", None), "cuda", "") or "")',
    '    cuda_available = bool(torch.cuda.is_available())',
    '    device_name = str(torch.cuda.get_device_name(0)) if cuda_available else ""',
    'except ModuleNotFoundError as exc:',
    '    missing.append(str(getattr(exc, "name", "") or "torch"))',
    'except Exception as exc:',
    '    failures.append({"module": "torch", "errorType": exc.__class__.__name__, "message": str(exc)})',
    'for module_name, label in checks:',
    '    try:',
    '        module = importlib.import_module(module_name)',
    '        versions[module_name] = str(getattr(module, "__version__", "imported") or "imported")',
    '    except ModuleNotFoundError as exc:',
    '        missing.append(str(getattr(exc, "name", "") or label))',
    '    except Exception as exc:',
    '        failures.append({"module": module_name, "label": label, "errorType": exc.__class__.__name__, "message": str(exc)})',
    'main_present = os.path.exists("main.py")',
    'ready = bool(main_present and not missing and not failures and cuda_version and cuda_available and "+cpu" not in torch_version.lower())',
    'payload = {"ready": ready, "mainPresent": main_present, "missing": sorted(set(missing)), "failures": failures, "versions": versions, "cudaAvailable": cuda_available, "cudaVersion": cuda_version, "torchVersion": torch_version, "deviceName": device_name}',
    'print(json.dumps(payload))',
    'sys.exit(0 if payload["ready"] else 3)',
  ].join('\n');
}

function buildComfyUiDependencyFailureMessage(probe = null) {
  const torchVersion = String(probe?.torchVersion || '').trim();
  const cudaVersion = String(probe?.cudaVersion || '').trim();
  const missing = Array.isArray(probe?.missing) ? probe.missing.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
  const failures = Array.isArray(probe?.failures) ? probe.failures : [];

  if (probe?.mainPresent === false) {
    return 'ComfyUI WebUI finished installing, but main.py is missing from its managed source folder. Run Repair again while online, or reinstall ComfyUI WebUI.';
  }

  if (!cudaVersion || /\+cpu\b/i.test(torchVersion)) {
    const suffix = torchVersion ? ` Current torch version: ${torchVersion}.` : '';
    return 'ComfyUI WebUI is using a CPU-only PyTorch build instead of an NVIDIA CUDA build. Run Repair so Local AI Hub can reinstall CUDA PyTorch 2.6.0 from the CUDA 12.4 wheel index.' + suffix;
  }

  if (probe?.cudaAvailable === false) {
    return `ComfyUI WebUI has CUDA PyTorch${torchVersion ? ' ' + torchVersion : ''}, but PyTorch cannot use the NVIDIA GPU on this PC. Update the NVIDIA driver, close other GPU tools, then run Repair again.`;
  }

  if (missing.length) {
    return 'ComfyUI WebUI finished installing, but its Python environment is still missing: ' + missing.join(', ') + '. Run Repair again while online, or reinstall ComfyUI WebUI.';
  }

  if (failures.length) {
    const details = failures
      .map((entry) => String(entry?.module || entry?.label || '').trim())
      .filter(Boolean)
      .slice(0, 5)
      .join(', ');
    return 'ComfyUI WebUI finished installing, but some launch-critical Python packages could not import' + (details ? ': ' + details : '') + '. Run Repair again while online, or reinstall ComfyUI WebUI.';
  }

  return 'ComfyUI WebUI finished installing, but Local AI Hub could not verify its CUDA PyTorch runtime. Run Repair again while online, or reinstall ComfyUI WebUI.';
}

async function verifyComfyUiManagedRuntimeReadiness(toolState, manifest, logger) {
  if (manifest?.id !== 'comfyui') {
    return null;
  }

  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  if (!(await fs.pathExists(pythonPath))) {
    throw new Error('ComfyUI WebUI finished installing, but its Python environment is missing.');
  }

  const result = await runCommand(pythonPath, ['-c', buildComfyUiDependencyVerificationScript()], {
    allowFailure: true,
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
  });
  const probe = parseRvcDependencyProbe(result.stdout);
  if (Number(result.code || 0) === 0 && probe?.ready !== false) {
    await logger.info('ComfyUI WebUI CUDA and launch-critical Python dependencies verified.', {
      cudaAvailable: probe?.cudaAvailable,
      cudaVersion: probe?.cudaVersion || '',
      deviceName: probe?.deviceName || '',
      torchVersion: probe?.torchVersion || '',
    });
    return probe;
  }

  throw new Error(buildComfyUiDependencyFailureMessage(probe));
}

async function runManagedPipCheck(toolState, manifest, logger) {
  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  const options = {
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
    errorMessage: `Local AI Hub installed ${manifest.name}, but its Python environment still has dependency conflicts.`,
  };

  if (manifest?.id !== 'comfyui') {
    await runCommand(pythonPath, ['-m', 'pip', 'check'], options);
    return null;
  }

  const result = await runCommand(pythonPath, ['-m', 'pip', 'check'], {
    ...options,
    allowFailure: true,
  });
  if (Number(result.code || 0) === 0) {
    return null;
  }

  const pipCheckOutput = String(result.stdout || result.stderr || '').trim();
  await logger.warn('pip check reported ComfyUI dependency warnings; Local AI Hub will rely on CUDA launch-readiness validation before deciding whether repair succeeded.', {
    pipCheckOutput,
  });
  return {
    code: result.code,
    output: pipCheckOutput,
  };
}

function getRuntimeAssetLabel(asset = {}) {
  return String(asset.label || asset.relativePath || asset.url || 'runtime asset').trim() || 'runtime asset';
}

function getRuntimeAssetMinBytes(asset = {}) {
  return Math.max(1, Number(asset.minBytes || 1024) || 1024);
}

function getToolRuntimeAssets(manifest = {}) {
  const assets = Array.isArray(manifest?.installInstructions?.runtimeAssets)
    ? manifest.installInstructions.runtimeAssets
    : [];
  return assets
    .filter((asset) => asset && typeof asset === 'object')
    .map((asset) => ({
      label: getRuntimeAssetLabel(asset),
      minBytes: getRuntimeAssetMinBytes(asset),
      relativePath: String(asset.relativePath || '').trim().replace(/[\\/]+/g, path.sep),
      url: String(asset.url || '').trim(),
    }))
    .filter((asset) => asset.relativePath && asset.url);
}

function resolveRuntimeAssetPath(root, relativePath, safetyMessage) {
  return assertPathInside(
    root,
    path.resolve(root, relativePath),
    safetyMessage,
  );
}

async function validateRuntimeAssetFile(filePath, asset) {
  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.size < asset.minBytes) {
    throw new Error(`${asset.label} is missing or incomplete.`);
  }
  return stats;
}

async function downloadRuntimeAsset(asset, destination, onProgress, logger, toolId) {
  const safeUrl = assertSecureRemoteUrl(asset.url, `${asset.label} URL`);
  await advanceStep(logger, onProgress, {
    toolId,
    percent: 88,
    stage: 'runtime-assets',
    message: `Downloading ${asset.label}.`,
  }, { url: safeUrl });

  const response = await fetchWithTimeout(safeUrl, logger);
  if (!response.ok) {
    throw new Error(`Local AI Hub could not download ${asset.label}. The source returned HTTP ${response.status}.`);
  }

  if (!response.body) {
    throw new Error(`Local AI Hub reached the download source, but it did not send ${asset.label}.`);
  }

  await fs.ensureDir(path.dirname(destination));
  const tempDestination = `${destination}.download`;
  await fs.remove(tempDestination).catch(() => null);
  const fileHandle = await open(tempDestination, 'w');
  const reader = response.body.getReader();
  let downloaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      downloaded += chunk.length;
      await fileHandle.write(chunk);
    }
  } finally {
    await fileHandle.close();
  }

  await fs.move(tempDestination, destination, { overwrite: true });
  await logger.info('Downloaded runtime asset.', {
    downloadedBytes: downloaded,
    label: asset.label,
    path: destination,
    toolId,
  });
}

async function ensureToolRuntimeAssets(toolState, manifest, logger, onProgress = null) {
  const assets = getToolRuntimeAssets(manifest);
  if (!assets.length) {
    return [];
  }

  const safeToolState = ensureManagedToolStatePaths(toolState);
  const cacheRoot = assertPathInside(
    safeToolState.installDir,
    path.join(safeToolState.installDir, '.localaihub', 'runtime-assets'),
    'Local AI Hub refused to cache a runtime asset outside the managed tool folder.',
  );
  const restored = [];

  for (const asset of assets) {
    const destination = resolveRuntimeAssetPath(
      safeToolState.appDir,
      asset.relativePath,
      'Local AI Hub refused to install a runtime asset outside the tool folder.',
    );
    const cachePath = resolveRuntimeAssetPath(
      cacheRoot,
      asset.relativePath,
      'Local AI Hub refused to cache a runtime asset outside the runtime asset cache.',
    );

    try {
      await validateRuntimeAssetFile(destination, asset);
      continue;
    } catch {
      // Missing or partial app asset can be restored from cache or downloaded below.
    }

    let cacheReady = false;
    try {
      await validateRuntimeAssetFile(cachePath, asset);
      cacheReady = true;
    } catch {
      await fs.remove(cachePath).catch(() => null);
    }

    if (!cacheReady) {
      await downloadRuntimeAsset(asset, cachePath, onProgress, logger, safeToolState.id);
      await validateRuntimeAssetFile(cachePath, asset);
    }

    await fs.ensureDir(path.dirname(destination));
    await fs.copy(cachePath, destination, { overwrite: true });
    await validateRuntimeAssetFile(destination, asset);
    restored.push({ label: asset.label, path: destination });
  }

  if (restored.length) {
    await logger.info('Runtime assets restored for managed tool.', {
      restored,
      toolId: safeToolState.id,
    });
  }

  return restored;
}

function buildFaceFusionDependencyVerificationScript() {
  return [
    'import importlib, json, sys',
    'checks = [["cv2", "OpenCV (cv2)"], ["numpy", "NumPy"], ["onnxruntime", "ONNX Runtime"]]',
    'missing = []',
    'versions = {}',
    'for module_name, label in checks:',
    '    try:',
    '        module = importlib.import_module(module_name)',
    '        versions[module_name] = str(getattr(module, "__version__", ""))',
    '    except ModuleNotFoundError as exc:',
    '        missing.append(str(getattr(exc, "name", "") or module_name))',
    '    except Exception as exc:',
    '        missing.append(module_name + ":" + exc.__class__.__name__)',
    'payload = {"ready": not missing, "missing": sorted(set(missing)), "versions": versions}',
    'print(json.dumps(payload))',
    'sys.exit(0 if payload["ready"] else 3)',
  ].join('\n');
}

function buildFaceFusionDependencyFailureMessage(probe = null) {
  const missing = Array.isArray(probe?.missing) ? probe.missing.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
  if (missing.some((entry) => entry.toLowerCase() === 'cv2')) {
    return 'FaceFusion finished installing, but OpenCV (cv2) is still missing from its Python environment. Run Repair again while online, or reinstall FaceFusion.';
  }

  if (missing.length) {
    return 'FaceFusion finished installing, but its Python environment is still missing: ' + missing.join(', ') + '. Run Repair again while online, or reinstall FaceFusion.';
  }

  return 'FaceFusion finished installing, but Local AI Hub could not verify its Python dependencies. Run Repair again while online, or reinstall FaceFusion.';
}

async function verifyFaceFusionManagedRuntimeReadiness(toolState, manifest, logger) {
  if (manifest?.id !== 'facefusion') {
    return;
  }

  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  if (!(await fs.pathExists(pythonPath))) {
    throw new Error('FaceFusion finished installing, but its Python environment is missing.');
  }

  const result = await runCommand(pythonPath, ['-c', buildFaceFusionDependencyVerificationScript()], {
    allowFailure: true,
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
  });
  const probe = parseRvcDependencyProbe(result.stdout);
  if (Number(result.code || 0) === 0 && probe?.ready !== false) {
    await logger.info('FaceFusion Python dependencies verified.', {
      versions: probe?.versions || {},
    });
    return;
  }

  throw new Error(buildFaceFusionDependencyFailureMessage(probe));
}
function buildTripoSrDependencyVerificationScript() {
  return [
    'import importlib, json, sys',
    'checks = [["gradio", "Gradio"], ["rembg", "Rembg"], ["onnxruntime", "ONNX Runtime"], ["torch", "PyTorch"], ["torchmcubes", "torchmcubes"], ["transformers", "Transformers"], ["PIL", "Pillow"], ["xatlas", "xatlas"], ["moderngl", "ModernGL"], ["fastapi", "FastAPI"], ["starlette", "Starlette"], ["uvicorn", "Uvicorn"], ["pydantic", "Pydantic"]]',
    'expected_versions = {"fastapi": "0.104.1", "starlette": "0.27.0", "uvicorn": "0.24.0.post1", "pydantic": "2.5.3"}',
    'missing = []',
    'mismatched = []',
    'versions = {}',
    'for module_name, label in checks:',
    '    try:',
    '        module = importlib.import_module(module_name)',
    '        versions[module_name] = str(getattr(module, "__version__", ""))',
    '        expected = expected_versions.get(module_name)',
    '        if expected and versions[module_name] != expected:',
    '            mismatched.append(module_name + "==" + versions[module_name] + " (expected " + expected + ")")',
    '    except ModuleNotFoundError as exc:',
    '        missing.append(str(getattr(exc, "name", "") or module_name))',
    '    except Exception as exc:',
    '        missing.append(module_name + ":" + exc.__class__.__name__)',
    'payload = {"ready": not missing and not mismatched, "missing": sorted(set(missing)), "mismatched": sorted(set(mismatched)), "versions": versions}',
    'print(json.dumps(payload))',
    'sys.exit(0 if payload["ready"] else 3)',
  ].join('\n');
}

function buildTripoSrDependencyFailureMessage(probe = null) {
  const missing = Array.isArray(probe?.missing) ? probe.missing.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
  const mismatched = Array.isArray(probe?.mismatched) ? probe.mismatched.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
  if (missing.some((entry) => entry.toLowerCase() === 'onnxruntime')) {
    return 'TripoSR / Trellis finished installing, but ONNX Runtime is still missing from its Python environment. Run Repair again while online, or reinstall TripoSR / Trellis.';
  }

  if (mismatched.length) {
    return 'TripoSR / Trellis finished installing, but its Gradio web server dependency versions are not compatible: ' + mismatched.join(', ') + '. Run Repair again while online, or reinstall TripoSR / Trellis.';
  }

  if (missing.length) {
    return 'TripoSR / Trellis finished installing, but its Python environment is still missing: ' + missing.join(', ') + '. Run Repair again while online, or reinstall TripoSR / Trellis.';
  }

  return 'TripoSR / Trellis finished installing, but Local AI Hub could not verify its Python dependencies. Run Repair again while online, or reinstall TripoSR / Trellis.';
}

async function verifyTripoSrManagedRuntimeReadiness(toolState, manifest, logger) {
  if (manifest?.id !== 'triposr') {
    return;
  }

  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  if (!(await fs.pathExists(pythonPath))) {
    throw new Error('TripoSR / Trellis finished installing, but its Python environment is missing.');
  }

  const result = await runCommand(pythonPath, ['-c', buildTripoSrDependencyVerificationScript()], {
    allowFailure: true,
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
  });
  const probe = parseRvcDependencyProbe(result.stdout);
  if (Number(result.code || 0) === 0 && probe?.ready !== false) {
    await logger.info('TripoSR / Trellis Python dependencies verified.', {
      versions: probe?.versions || {},
    });
    return;
  }

  throw new Error(buildTripoSrDependencyFailureMessage(probe));
}

function buildWanDependencyVerificationScript() {
  return [
    'import importlib, json, sys',
    'checks = [["torch", "PyTorch"], ["gradio", "Gradio"], ["diffsynth", "DiffSynth"], ["transformers", "Transformers"], ["PIL", "Pillow"], ["numpy", "NumPy"]]',
    'missing = []',
    'versions = {}',
    'cuda_available = False',
    'cuda_version = ""',
    'device_name = ""',
    'for module_name, label in checks:',
    '    try:',
    '        module = importlib.import_module(module_name)',
    '        versions[module_name] = str(getattr(module, "__version__", ""))',
    '    except ModuleNotFoundError as exc:',
    '        missing.append(str(getattr(exc, "name", "") or module_name))',
    '    except Exception as exc:',
    '        missing.append(module_name + ":" + exc.__class__.__name__)',
    'try:',
    '    torch = importlib.import_module("torch")',
    '    cuda_available = bool(torch.cuda.is_available())',
    '    cuda_version = str(getattr(torch.version, "cuda", "") or "")',
    '    if cuda_available:',
    '        device_name = str(torch.cuda.get_device_name(0))',
    'except Exception as exc:',
    '    missing.append("torch-cuda:" + exc.__class__.__name__)',
    'payload = {"ready": not missing and cuda_available, "missing": sorted(set(missing)), "versions": versions, "cuda_available": cuda_available, "cuda_version": cuda_version, "device_name": device_name}',
    'print(json.dumps(payload))',
    'sys.exit(0 if payload["ready"] else 3)',
  ].join('\n');
}

function buildWanDependencyFailureMessage(probe = null) {
  const missing = Array.isArray(probe?.missing) ? probe.missing.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
  if (missing.length) {
    return 'Wan2.1 finished installing, but its Python environment is still missing or cannot import: ' + missing.join(', ') + '. Run Repair again while online, or reinstall Wan2.1.';
  }

  if (probe?.cuda_available === false) {
    return 'Wan2.1 finished installing, but its PyTorch runtime cannot use NVIDIA CUDA on this PC. Install a CUDA-capable NVIDIA driver, then run Repair again.';
  }

  return 'Wan2.1 finished installing, but Local AI Hub could not verify its Python and CUDA runtime. Run Repair again while online, or reinstall Wan2.1.';
}

async function verifyWanManagedRuntimeReadiness(toolState, manifest, logger) {
  if (manifest?.id !== 'wan21-webui') {
    return;
  }

  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  if (!(await fs.pathExists(pythonPath))) {
    throw new Error('Wan2.1 finished installing, but its Python environment is missing.');
  }

  const result = await runCommand(pythonPath, ['-c', buildWanDependencyVerificationScript()], {
    allowFailure: true,
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
  });
  const probe = parseRvcDependencyProbe(result.stdout);
  if (Number(result.code || 0) === 0 && probe?.ready !== false) {
    await logger.info('Wan2.1 Python and CUDA runtime verified.', {
      versions: probe?.versions || {},
      cudaVersion: probe?.cuda_version || '',
      deviceName: probe?.device_name || '',
    });
    return;
  }

  throw new Error(buildWanDependencyFailureMessage(probe));
}
function buildRvcDependencyVerificationScript() {
  return [
    'import importlib, json, sys',
    'payload = {"ready": False, "gradio": "", "gradio_client": "", "has_media_data": False, "error": ""}',
    'try:',
    '    gradio_client = importlib.import_module("gradio_client")',
    '    payload["gradio_client"] = str(getattr(gradio_client, "__version__", ""))',
    '    payload["has_media_data"] = hasattr(gradio_client, "media_data")',
    '    gradio = importlib.import_module("gradio")',
    '    payload["gradio"] = str(getattr(gradio, "__version__", ""))',
    '    payload["ready"] = bool(payload["has_media_data"])',
    'except Exception as exc:',
    '    payload["error"] = exc.__class__.__name__ + ": " + str(exc)',
    'print(json.dumps(payload))',
    'sys.exit(0 if payload["ready"] else 3)',
  ].join('\n');
}

function parseRvcDependencyProbe(stdout) {
  const lastLine = String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find(Boolean);
  if (!lastLine) {
    return null;
  }
  try {
    return JSON.parse(lastLine);
  } catch {
    return null;
  }
}

function buildRvcDependencyFailureMessage(probe = null) {
  const clientVersion = String(probe?.gradio_client || '').trim();
  const gradioVersion = String(probe?.gradio || '').trim();
  const detail = clientVersion || gradioVersion
    ? ` Detected gradio${gradioVersion ? ' ' + gradioVersion : ''} and gradio_client${clientVersion ? ' ' + clientVersion : ''}.`
    : '';
  return 'RVC finished installing, but its Gradio dependency set is incompatible. Run Repair to rebuild RVC with the pinned gradio_client version required by this RVC WebUI.' + detail;
}

async function verifyRvcManagedRuntimeReadiness(toolState, manifest, logger) {
  if (manifest?.id !== 'rvc') {
    return;
  }

  const assets = getToolRuntimeAssets(manifest);
  for (const asset of assets) {
    const destination = resolveRuntimeAssetPath(
      toolState.appDir,
      asset.relativePath,
      'Local AI Hub refused to validate a runtime asset outside the tool folder.',
    );
    try {
      await validateRuntimeAssetFile(destination, asset);
    } catch {
      throw new Error(`RVC finished installing, but ${asset.label} is still missing or incomplete at ${asset.relativePath}. Run Repair again while online, or reinstall RVC.`);
    }
  }

  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  if (!(await fs.pathExists(pythonPath))) {
    throw new Error('RVC finished installing, but its Python environment is missing.');
  }

  const result = await runCommand(pythonPath, ['-c', buildRvcDependencyVerificationScript()], {
    allowFailure: true,
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
  });
  const probe = parseRvcDependencyProbe(result.stdout);
  if (Number(result.code || 0) === 0 && probe?.ready !== false && probe?.has_media_data !== false) {
    await logger.info('RVC runtime assets and Gradio dependency compatibility verified.', {
      gradio: probe?.gradio || '',
      gradioClient: probe?.gradio_client || '',
    });
    return;
  }

  throw new Error(buildRvcDependencyFailureMessage(probe));
}
async function buildManagedLauncherValidationFailureMessage(toolState, manifest, launchProfile) {
  if (!launchProfile) {
    return `${manifest.name} finished installing, but its Store manifest did not produce a launch profile Local AI Hub can use.`;
  }

  if (launchProfile.kind === 'python-script') {
    const pythonPath = launchProfile.pythonPath;
    if (!pythonPath) {
      return `${manifest.name} finished installing, but its Store manifest did not identify a Python launcher.`;
    }

    if (!isBareCommand(pythonPath) && !(await fs.pathExists(pythonPath))) {
      return `${manifest.name} finished installing, but its Python launcher was not found at ${pythonPath}.`;
    }

    const targetPath = resolveLaunchProfileTargetPath(launchProfile);
    if (!targetPath) {
      return `${manifest.name} finished installing, but its Store manifest launch command does not identify a Python script.`;
    }

    if (!(await fs.pathExists(targetPath))) {
      const baseDir = toolState.appDir || toolState.installDir || '';
      const expectedLabel = baseDir && isPathInside(baseDir, targetPath)
        ? path.relative(baseDir, targetPath)
        : targetPath;
      return `${manifest.name} finished installing, but the expected launch script was not found at ${expectedLabel}. The downloaded package may be incomplete, nested differently than expected, or the Store manifest may be pointing at a stale upstream entry point.`;
    }
  }

  if (launchProfile.kind === 'binary' && launchProfile.executable && !(await fs.pathExists(launchProfile.executable))) {
    return `${manifest.name} finished installing, but the expected launcher executable was not found at ${launchProfile.executable}.`;
  }

  if (launchProfile.kind === 'batch' && launchProfile.command && !(await fs.pathExists(launchProfile.command))) {
    return `${manifest.name} finished installing, but the expected launcher script was not found at ${launchProfile.command}.`;
  }

  return `${manifest.name} finished installing, but Local AI Hub still could not find a usable launcher in the managed tool folder.`;
}
async function verifyChatterboxManagedPipelineReadiness(toolState, manifest, logger) {
  if (manifest?.id !== 'chatterbox-tts') {
    return;
  }

  await ensureChatterboxServerLaunchShim(toolState, manifest, logger);

  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  if (!(await fs.pathExists(pythonPath))) {
    throw new Error('Chatterbox-Turbo TTS finished installing, but its Python environment is missing.');
  }

  const result = await runCommand(pythonPath, ['-c', buildChatterboxPipelineVerificationScript()], {
    allowFailure: true,
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
  });
  const probe = parseAudiocraftPipelineVerification(result.stdout);
  if (Number(result.code || 0) === 0 && probe?.ready !== false) {
    await logger.info('Chatterbox-Turbo reference voice TTS Python packages and CUDA verified.', {
      gpuName: probe?.gpuName || '',
      torchVersion: probe?.torchVersion || '',
    });
    return;
  }

  throw new Error(buildChatterboxPipelineInstallFailureMessage(probe));
}
async function verifyAudiocraftManagedPipelineReadiness(toolState, manifest, logger) {
  if (manifest?.id !== 'audiocraft-webui') {
    return;
  }

  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  if (!(await fs.pathExists(pythonPath))) {
    throw new Error('AudioCraft WebUI finished installing, but its Python environment is missing.');
  }

  const result = await runCommand(pythonPath, ['-c', buildAudiocraftPipelineVerificationScript()], {
    allowFailure: true,
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
  });
  const probe = parseAudiocraftPipelineVerification(result.stdout);
  if (Number(result.code || 0) === 0 && probe?.ready !== false) {
    await logger.info('AudioCraft pipeline Python packages verified.');
    return;
  }

  throw new Error(buildAudiocraftPipelineInstallFailureMessage(probe));
}
async function verifyManagedToolInstall(toolState, manifest, logger) {
  const safeToolState = ensureManagedToolStatePaths(toolState);
  await ensureChatterboxServerLaunchShim(safeToolState, manifest, logger);
  const launchProfile = buildManagedLaunchProfile(safeToolState, manifest);
  const launchModeState = buildLaunchModeState(
    {
      ...safeToolState,
      launchProfile,
    },
    manifest,
    { source: 'managed' },
  );

  if (!(await toolIsAvailable({
    ...safeToolState,
    launchProfile: launchModeState.launchProfile || launchProfile,
  }))) {
    throw new Error(await buildManagedLauncherValidationFailureMessage(safeToolState, manifest, launchModeState.launchProfile || launchProfile));
  }

  if (getToolRuntime(manifest) === 'python' && safeToolState.venvDir) {
    const pythonPath = path.join(safeToolState.venvDir, 'Scripts', 'python.exe');
    if (!(await fs.pathExists(pythonPath))) {
      throw new Error(`${manifest.name} finished installing, but its Python environment is missing.`);
    }

    await ensureToolRuntimeAssets(safeToolState, manifest, logger);
    await ensureManagedCudaPyTorch(safeToolState, manifest, logger, null);

    await runManagedPipCheck(safeToolState, manifest, logger);
    await verifyComfyUiManagedRuntimeReadiness(safeToolState, manifest, logger);
    await verifyAudiocraftManagedPipelineReadiness(safeToolState, manifest, logger);
    await verifyChatterboxManagedPipelineReadiness(safeToolState, manifest, logger);
    await verifyRvcManagedRuntimeReadiness(safeToolState, manifest, logger);
    await verifyFaceFusionManagedRuntimeReadiness(safeToolState, manifest, logger);
    await verifyTripoSrManagedRuntimeReadiness(safeToolState, manifest, logger);
    await verifyWanManagedRuntimeReadiness(safeToolState, manifest, logger);
  }

  return {
    ...safeToolState,
    ...launchModeState,
    launchProfile: launchModeState.launchProfile || launchProfile,
  };
}

async function toolIsAvailable(toolState) {
  if (!toolState) {
    return false;
  }

  if (toolState.launchProfile?.kind === 'binary' && toolState.launchProfile?.executable) {
    return fs.pathExists(toolState.launchProfile.executable);
  }

  if ((toolState.launchProfile?.kind === 'python-script' || toolState.launchProfile?.kind === 'python-module') && toolState.launchProfile?.pythonPath) {
    const pythonExists = isBareCommand(toolState.launchProfile.pythonPath)
      ? toolState.installDir ? await fs.pathExists(toolState.installDir) : true
      : await fs.pathExists(toolState.launchProfile.pythonPath);

    if (!pythonExists) {
      return false;
    }

    if (toolState.launchProfile.kind === 'python-script') {
      const targetPath = resolveLaunchProfileTargetPath(toolState.launchProfile);
      return targetPath ? fs.pathExists(targetPath) : false;
    }

    return true;
  }

  if (toolState.launchProfile?.kind === 'embedded' && toolState.launchProfile?.pythonPath) {
    if (isBareCommand(toolState.launchProfile.pythonPath)) {
      return toolState.installDir ? fs.pathExists(toolState.installDir) : true;
    }

    return fs.pathExists(toolState.launchProfile.pythonPath);
  }

  if (toolState.launchProfile?.kind === 'batch' && toolState.launchProfile?.command) {
    return fs.pathExists(toolState.launchProfile.command);
  }

  return toolState.installDir ? fs.pathExists(toolState.installDir) : false;
}

function createManagedToolState(manifest, installDir, appDir, venvDir, archivePath, pythonResolution) {
  const runtime = pythonResolution?.runtime || null;
  const requirement = pythonResolution?.requirement || null;
  const managedRuntime = runtime?.source === 'managed' ? runtime : null;
  const toolsRoot = findManagedToolsRootForPath(installDir || appDir || '');
  const installRoot = normalizeOptionalDirectoryPath(toolsRoot ? path.dirname(toolsRoot) : null) || getAppPaths().managedRoot;
  const toolState = normalizeToolLifecycle({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    category: manifest.category,
    type: getToolRuntime(manifest),
    source: 'managed',
    managedByLocalAIHub: true,
    installDir,
    installRoot,
    installedByLocalAIHub: true,
    requestedInstallRoot: installRoot,
    appDir,
    venvDir: getToolRuntime(manifest) === 'python' ? venvDir : null,
    executablePath:
      getToolRuntime(manifest) === 'binary' ? path.join(appDir, path.basename(manifest.launchCommand.split(' ')[0])) : null,
    launchUrl: manifest.launchUrl,
    healthUrl: manifest.healthUrl,
    processNames: manifest.processNames,
    configTargets: manifest.installInstructions.configTargets,
    downloadCachePath: archivePath,
    installedAt: new Date().toISOString(),
    lastError: null,
    lastRepairMessage: null,
    status: 'stopped',
    launchSupported: true,
    displayPath: installDir,
    pythonRequirement: requirement,
    pythonBootstrapPath: runtime?.pythonPath || runtime?.executable || runtime?.launcher || null,
    pythonBootstrapSource: runtime?.source || null,
    pythonBootstrapVersion: runtime?.versionString || null,
    managedPythonVersion: managedRuntime?.versionString || null,
    managedPythonPath: managedRuntime?.pythonPath || null,
    managedPythonInstallDir: managedRuntime?.installDir || null,
  }, manifest);

  const launchModeState = buildLaunchModeState(toolState, manifest, { source: 'managed' });
  Object.assign(toolState, launchModeState);
  if (!toolState.launchProfile) {
    toolState.launchProfile = buildManagedLaunchProfile(toolState, manifest);
  }
  if (toolState.launchProfile?.kind === 'binary') {
    toolState.executablePath = toolState.launchProfile.executable;
  }
  return ensureManagedToolStatePaths(toolState);
}
function buildManagedPaths(manifest, options = {}) {
  const installRoot = resolveStoredInstallRoot(options, getAppPaths().managedRoot);
  const managedPaths = resolveManagedToolPaths(
    manifest.id,
    manifest.installInstructions.venvFolder || '.venv',
    {
      managedRoot: installRoot,
    },
  );
  const downloadsRoot = assertPathInside(
    installRoot,
    path.join(installRoot, 'downloads'),
    'Local AI Hub refused to stage an installer outside the selected install root.',
  );
  const cacheFileName =
    manifest.installInstructions.downloadFileName ||
    manifest.installInstructions.archiveName ||
    deriveCacheFileName(manifest.downloadUrl, manifest.id);
  const archivePath = assertPathInside(
    downloadsRoot,
    path.join(downloadsRoot, manifest.id, cacheFileName),
    'Local AI Hub refused to use a download cache path outside the selected install root.',
  );

  return {
    ...managedPaths,
    archivePath,
    downloadsRoot,
    installRoot,
  };
}
function deriveCacheFileName(downloadUrl, toolId) {
  try {
    const parsed = new URL(downloadUrl);
    const baseName = path.basename(parsed.pathname) || `${toolId}.bin`;
    return baseName.includes('.') ? baseName : `${toolId}.bin`;
  } catch {
    return `${toolId}.bin`;
  }
}

function replaceInstallerTemplate(value, replacements) {
  return String(value || '').replace(/\{([^}]+)\}/g, (_match, key) => {
    const resolvedValue = replacements[key];
    return resolvedValue === undefined || resolvedValue === null ? '' : String(resolvedValue);
  });
}

function resolveInstallerArgs(manifest, installDir, appDir) {
  return (manifest.installInstructions.installerArgs || [])
    .map((value) =>
      replaceInstallerTemplate(value, {
        appDir,
        installDir,
      }),
    )
    .filter(Boolean);
}

function resolveInstructionTemplateContext(toolState, pythonPath = null) {
  const sitePackagesDir = toolState?.venvDir ? path.join(toolState.venvDir, 'Lib', 'site-packages') : null;
  return {
    appDir: toolState?.appDir || null,
    installDir: toolState?.installDir || null,
    pythonPath: pythonPath || null,
    sitePackagesDir,
    torchConfigDir: sitePackagesDir ? path.join(sitePackagesDir, 'torch', 'share', 'cmake', 'Torch') : null,
    torchPackageDir: sitePackagesDir ? path.join(sitePackagesDir, 'torch') : null,
    venvDir: toolState?.venvDir || null,
  };
}

function resolveInstructionText(value, templateContext) {
  return replaceInstallerTemplate(value, templateContext);
}

function resolveInstructionList(values = [], templateContext) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => resolveInstructionText(value, templateContext))
    .filter((value) => String(value || '').trim());
}

function resolveInstructionEnv(instruction, templateContext) {
  const entries = Object.entries(instruction?.env || {});
  if (!entries.length) {
    return {};
  }

  return Object.fromEntries(
    entries
      .map(([key, value]) => [String(key || '').trim(), resolveInstructionText(value, templateContext)])
      .filter(([key]) => key),
  );
}

function isOptionalInstruction(instruction) {
  return Boolean(instruction?.optional || instruction?.optionalDependency);
}

function buildCudaToolkitEnv(cudaToolkit) {
  if (!cudaToolkit?.cudaHome) {
    return {};
  }

  return {
    CUDA_HOME: cudaToolkit.cudaHome,
    CUDA_PATH: cudaToolkit.cudaHome,
  };
}

function buildMissingCudaToolkitDependencyMessage(manifest, instruction) {
  return instruction?.cudaToolkitMissingMessage
    || `${manifest.name} needs the NVIDIA CUDA Toolkit only for the ${instruction?.value || 'selected'} acceleration package. Local AI Hub could not find nvcc or CUDA_HOME on this PC.`;
}

function buildOptionalDependencyWarning(manifest, instruction, fallbackMessage = '') {
  return String(
    instruction?.optionalFailureMessage
      || fallbackMessage
      || `${manifest.name} skipped an optional dependency. The tool can still install, but some acceleration or runtime paths may be limited.`,
  ).trim();
}

function attachOptionalInstallWarnings(toolState, manifest, warnings = []) {
  const normalizedWarnings = [...new Set((warnings || []).map((entry) => String(entry || '').trim()).filter(Boolean))];
  if (!normalizedWarnings.length) {
    return toolState;
  }

  return {
    ...toolState,
    optionalInstallWarnings: normalizedWarnings,
    installActionMessage: `${manifest.name} was installed. ${normalizedWarnings.join(' ')}`,
  };
}

function resolvePackagingBootstrapPackages(manifest) {
  const configuredPackages = Array.isArray(manifest?.installInstructions?.packagingBootstrapPackages)
    ? manifest.installInstructions.packagingBootstrapPackages.map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  return configuredPackages.length ? configuredPackages : ['pip', 'setuptools', 'wheel'];
}

function buildDependencyInstallFailure(manifest, error, fallbackMessage) {
  const rawOutput = `${error?.stderr || ''}
${error?.stdout || ''}`;
  const combinedOutput = rawOutput.toLowerCase();
  let message = fallbackMessage;
  const pipErrorLine = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => /^ERROR:/i.test(line) || /No matching distribution found|Could not find a version that satisfies|No such file or directory/i.test(line)) || '';

  if (manifest?.id === 'facefusion' && combinedOutput.includes('onnxruntime') && (combinedOutput.includes('no matching distribution') || combinedOutput.includes('could not find a version that satisfies'))) {
    message = `${manifest.name} could not install ONNX Runtime from FaceFusion's requirements. pip reported: ${pipErrorLine || 'no compatible onnxruntime wheel was found for this Python runtime.'}`;
  } else if (manifest?.id === 'facefusion' && pipErrorLine) {
    message = `${manifest.name} could not install its Python dependencies. pip reported: ${pipErrorLine}`;
  } else if (combinedOutput.includes('please use pip<24.1') || (combinedOutput.includes('omegaconf') && combinedOutput.includes('invalid metadata'))) {
    message = `${manifest.name} still relies on older Python package metadata, so this install needs pip 24.0 or older.`;
  } else if (combinedOutput.includes('flash_attn') && (combinedOutput.includes('cuda_home environment variable is not set') || combinedOutput.includes('nvcc was not found'))) {
    message = `${manifest.name} could not build flash_attn because this PC does not currently expose the NVIDIA CUDA Toolkit through nvcc or CUDA_HOME. flash_attn is acceleration-specific for Wan2.1 and should be optional when the manifest marks it optional.`;
  } else if (combinedOutput.includes('failed to build') && combinedOutput.includes('flash_attn')) {
    message = `${manifest.name} could not build flash_attn acceleration on this Windows setup. Local AI Hub only treats that as an install blocker when the dependency is marked required.`;
  } else if (combinedOutput.includes("cannot import 'scikit_build_core.build'")) {
    message = `${manifest.name} could not build torchmcubes because the scikit-build-core backend was not available in the tool environment.`;
  } else if (combinedOutput.includes('torchmcubes') && (combinedOutput.includes('torchconfig.cmake') || combinedOutput.includes('could not find a package configuration file provided by "torch"'))) {
    message = `${manifest.name} could not build its torchmcubes extension because the build step could not find PyTorch's CMake files.`;
  }
  if (message == fallbackMessage) {
    return error;
  }

  const wrapped = new Error(message);
  wrapped.code = error?.code;
  wrapped.stdout = error?.stdout;
  wrapped.stderr = error?.stderr;
  wrapped.cause = error;
  return wrapped;
}

async function findRequirementEntry(requirementsPath, packageName) {
  const normalizedPackageName = String(packageName || '').trim().toLowerCase();
  if (!normalizedPackageName) {
    throw new Error('Local AI Hub could not identify the required Python package name.');
  }

  const raw = await fs.readFile(requirementsPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const entryName = trimmed.split(/[<>=!~;\s\[]/, 1)[0].trim().toLowerCase();
    if (entryName === normalizedPackageName) {
      return trimmed;
    }
  }

  throw new Error(`Local AI Hub could not find ${packageName} in ${path.basename(requirementsPath)}.`);
}
async function buildFilteredRequirementsPath(toolState, requirementsPath, instruction, logger, index) {
  const excludePatterns = Array.isArray(instruction?.excludePatterns)
    ? instruction.excludePatterns.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!excludePatterns.length) {
    return requirementsPath;
  }

  const compiledPatterns = excludePatterns.map((pattern) => new RegExp(pattern, 'i'));
  const raw = await fs.readFile(requirementsPath, 'utf8');
  const lineEnding = raw.includes('\r\n') ? '\r\n' : '\n';
  const keptLines = [];
  const removedLines = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      keptLines.push(line);
      continue;
    }

    if (compiledPatterns.some((pattern) => pattern.test(trimmed))) {
      removedLines.push(trimmed);
      continue;
    }

    keptLines.push(line);
  }

  if (!removedLines.length) {
    return requirementsPath;
  }

  const filteredDir = path.join(toolState.installDir, '.localaihub', 'install');
  const filteredPath = path.join(
    filteredDir,
    `${path.basename(requirementsPath, path.extname(requirementsPath))}.filtered-${index + 1}${path.extname(requirementsPath)}`,
  );
  await fs.ensureDir(filteredDir);
  await fs.writeFile(filteredPath, `${keptLines.join(lineEnding)}${lineEnding}`, 'utf8');
  await logger.warn('Removed requirement entries before installation.', {
    filteredPath,
    removedRequirements: removedLines,
    requirementsPath,
  });
  return filteredPath;
}

function expectsManagedInstallerResult(manifest) {
  return manifest.installContract?.destinationControl !== INSTALL_DESTINATION_CONTROL.GUIDED;
}

function getInstallerMaterializationTimeout(manifest) {
  const configuredTimeout = Number(manifest.installInstructions.materializationTimeoutMs || 0);
  return configuredTimeout > 0 ? configuredTimeout : INSTALLER_MATERIALIZATION_TIMEOUT_MS;
}

function buildInstallerExpectationContext(manifest, paths) {
  const managedToolState = createManagedToolState(
    manifest,
    paths.installDir,
    paths.appDir,
    paths.venvDir,
    paths.archivePath,
    null,
  );
  return {
    expectedManagedExecutable:
      managedToolState.launchProfile?.executable || managedToolState.executablePath || null,
    detectionPaths: manifest.detectionPaths || [],
    expectsManagedInstall: expectsManagedInstallerResult(manifest),
  };
}

function quoteWindowsShellArgument(value) {
  const text = String(value || '');
  if (!text) {
    return '""';
  }

  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function isInstallerAccessError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '');
  return code === 'EACCES' || code === 'EPERM' || /\b(EACCES|EPERM)\b/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTrackedPromise(promise) {
  const tracked = {
    settled: false,
    value: null,
    error: null,
  };

  promise.then(
    (value) => {
      tracked.settled = true;
      tracked.value = value;
    },
    (error) => {
      tracked.settled = true;
      tracked.error = error;
    },
  );

  return tracked;
}

function spawnInstallerProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let spawned = false;
    let settleCompletion = null;
    let rejectCompletion = null;
    const completion = new Promise((resolveCompletion, rejectCompletionInner) => {
      settleCompletion = resolveCompletion;
      rejectCompletion = rejectCompletionInner;
    });

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...(options.env || {}),
        },
        windowsHide: options.windowsHide !== false,
        shell: Boolean(options.shell),
        stdio: 'ignore',
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once('spawn', () => {
      spawned = true;
      resolve({
        pid: child.pid,
        completion,
      });
    });

    child.once('error', (error) => {
      if (!spawned) {
        reject(error);
        return;
      }

      if (options.allowFailure) {
        settleCompletion({
          code: 1,
          signal: null,
          error,
        });
        return;
      }

      rejectCompletion(error);
    });

    child.once('exit', (code, signal) => {
      if (code === 0 || options.allowFailure) {
        settleCompletion({ code, signal });
        return;
      }

      const failure = new Error(options.errorMessage || `${command} failed.`);
      failure.code = code;
      failure.signal = signal;
      rejectCompletion(failure);
    });
  });
}

async function runInstallerExecutableFile(installerPath, installerArgs, logger, errorMessage, options = {}) {
  const commandOptions = {
    cwd: path.dirname(installerPath),
    errorMessage,
    windowsHide: options.windowsHide !== false,
  };

  try {
    const launchedProcess = await spawnInstallerProcess(installerPath, installerArgs, commandOptions);
    return {
      launchMethod: 'direct',
      ...launchedProcess,
    };
  } catch (error) {
    if (!isInstallerAccessError(error)) {
      throw error;
    }

    await logger.warn('The installer executable could not be launched directly. Retrying through cmd.exe.', {
      installerPath,
      error,
    });

    const commandLine = [quoteWindowsShellArgument(installerPath), ...installerArgs.map(quoteWindowsShellArgument)].join(' ');
    const launchedProcess = await spawnInstallerProcess('cmd.exe', ['/d', '/s', '/c', commandLine], commandOptions);
    return {
      launchMethod: 'cmd-wrapper',
      ...launchedProcess,
    };
  }
}

async function resolveInstalledExecutableToolState(manifest, installDir, appDir, venvDir, archivePath, logger, options = {}) {
  if (options.useOfficialDesktopDetection) {
    return detectOfficialDesktopUpdateToolState(manifest, archivePath, logger, options.officialDesktopDetection || {});
  }
  let toolState = createManagedToolState(manifest, installDir, appDir, venvDir, archivePath, null);
  if (await toolIsAvailable(toolState)) {
    return ensureManagedToolStatePaths(toolState);
  }

  const discoveredTools = await syncDiscoveredTools({ force: true });
  const detectedTool = discoveredTools[manifest.id];
  if (await toolIsAvailable(detectedTool)) {
    toolState = normalizeToolLifecycle({
      ...detectedTool,
      downloadCachePath: archivePath,
      installedByLocalAIHub: true,
      requestedInstallRoot: normalizeOptionalDirectoryPath(path.dirname(path.dirname(installDir))) || null,
    }, manifest);

    if (isManagedToolState(toolState)) {
      return ensureManagedToolStatePaths(toolState);
    }

    if (options.allowExternalResult) {
      await logger.info('Installer finished and Local AI Hub detected the tool outside managed storage.', {
        detectedPath: toolState.displayPath || toolState.installDir || toolState.detectedPath || null,
        installDir,
      });
      return toolState;
    }

    await logger.warn('Installer completed, but the tool is still only detected outside Local AI Hub storage.', {
      detectedPath: toolState.displayPath || toolState.installDir || toolState.detectedPath || null,
      installDir,
    });
  }

  return null;
}

async function logInstallerProcessCompletion(logger, installerRun, paths, trackedCompletion) {
  if (trackedCompletion.error) {
    await logger.warn('The official installer process exited with an error.', {
      archivePath: paths.archivePath,
      installDir: paths.installDir,
      appDir: paths.appDir,
      pid: installerRun.pid,
      error: trackedCompletion.error,
    });
    return;
  }

  await logger.info('The official installer process exited.', {
    archivePath: paths.archivePath,
    installDir: paths.installDir,
    appDir: paths.appDir,
    pid: installerRun.pid,
    exitCode: trackedCompletion.value?.code ?? 0,
    exitSignal: trackedCompletion.value?.signal || null,
  });
}

async function waitForInstallerMaterialization(manifest, paths, installerRun, logger) {
  const trackedCompletion = createTrackedPromise(installerRun.completion);
  const deadline = Date.now() + getInstallerMaterializationTimeout(manifest);
  const expectationContext = buildInstallerExpectationContext(manifest, paths);
  let completionLogged = false;

  while (Date.now() <= deadline) {
    const toolState = await resolveInstalledExecutableToolState(
      manifest,
      paths.installDir,
      paths.appDir,
      paths.venvDir,
      paths.archivePath,
      logger,
      {
        allowExternalResult: !expectsManagedInstallerResult(manifest),
      },
    );
    if (toolState) {
      if (trackedCompletion.settled && !completionLogged) {
        await logInstallerProcessCompletion(logger, installerRun, paths, trackedCompletion);
      }

      return {
        toolState,
        trackedCompletion,
        timedOut: false,
      };
    }

    if (trackedCompletion.settled) {
      if (!completionLogged) {
        await logInstallerProcessCompletion(logger, installerRun, paths, trackedCompletion);
        completionLogged = true;
      }
      break;
    }

    await sleep(INSTALLER_MATERIALIZATION_POLL_MS);
  }

  const finalToolState = await resolveInstalledExecutableToolState(
    manifest,
    paths.installDir,
    paths.appDir,
    paths.venvDir,
    paths.archivePath,
    logger,
    {
      allowExternalResult: !expectsManagedInstallerResult(manifest),
    },
  );
  if (finalToolState) {
    if (trackedCompletion.settled && !completionLogged) {
      await logInstallerProcessCompletion(logger, installerRun, paths, trackedCompletion);
    }

    return {
      toolState: finalToolState,
      trackedCompletion,
      timedOut: false,
    };
  }

  if (!trackedCompletion.settled) {
    await logger.warn('The installer process did not finish before Local AI Hub timed out waiting for the install to materialize.', {
      archivePath: paths.archivePath,
      installDir: paths.installDir,
      appDir: paths.appDir,
      pid: installerRun.pid,
      timeoutMs: getInstallerMaterializationTimeout(manifest),
      ...expectationContext,
    });
  }

  return {
    toolState: null,
    trackedCompletion,
    timedOut: !trackedCompletion.settled,
  };
}

async function recoverExecutableInstallerPayload(manifest, archivePath, appDir, onProgress, logger) {
  await logger.warn('The installer did not leave a verified launcher. Recovering the app files directly from the installer package.', {
    archivePath,
    appDir,
  });
  await advanceStep(logger, onProgress, {
    toolId: manifest.id,
    percent: 84,
    stage: 'installing',
    message: `Recovering ${manifest.name} directly from the installer package.`,
  });
  await extractArchive(archivePath, appDir, logger);
}

async function materializeExecutableInstallerTool(manifest, paths, options = {}) {
  const { appDir, archivePath, installDir, venvDir } = paths;
  const installerArgs = resolveInstallerArgs(manifest, installDir, appDir);
  const expectManagedInstall = expectsManagedInstallerResult(manifest);
  const errorMessage = options.errorMessage || `Local AI Hub could not run the ${manifest.name} installer.`;
  let installerRunError = null;
  let launchMethod = null;
  let recoveredFromArchive = false;
  let installerTimedOut = false;

  try {
    await options.logger.info('Launching the official installer executable.', {
      archivePath,
      installDir,
      appDir,
      installerArgs,
      expectsManagedInstall: expectManagedInstall,
    });
    const installerRun = await runInstallerExecutableFile(archivePath, installerArgs, options.logger, errorMessage);
    launchMethod = installerRun.launchMethod;
    await options.logger.info('The official installer process started.', {
      archivePath,
      installDir,
      appDir,
      launchMethod,
      pid: installerRun.pid,
      expectsManagedInstall: expectManagedInstall,
    });

    const materializationResult = await waitForInstallerMaterialization(manifest, paths, installerRun, options.logger);
    installerTimedOut = materializationResult.timedOut;
    if (materializationResult.trackedCompletion.error) {
      installerRunError = materializationResult.trackedCompletion.error;
    }

    let toolState = materializationResult.toolState;

    if (!toolState) {
      const discoveredTools = await syncDiscoveredTools({ force: true });
      const detectedTool = discoveredTools[manifest.id];
      if (await toolIsAvailable(detectedTool) && !isManagedToolState(detectedTool)) {
        if (!expectManagedInstall) {
          return {
            launchMethod,
            recoveredFromArchive,
            toolState: {
              ...detectedTool,
              downloadCachePath: archivePath,
            },
          };
        }

        throw new Error(buildManagedPlacementFailureMessage(manifest, installDir, detectedTool));
      }

      if (installerRunError) {
        throw installerRunError;
      }

      if (installerTimedOut) {
        throw new Error(`Local AI Hub launched the ${manifest.name} installer, but it did not finish or create a detectable install within ${Math.round(getInstallerMaterializationTimeout(manifest) / 1000)} seconds.`);
      }

      if (!expectManagedInstall) {
        await options.logger.warn('The official installer closed without leaving a detectable external install.', {
          archivePath,
          installDir,
          appDir,
          ...buildInstallerExpectationContext(manifest, paths),
        });
        throw new Error(`Local AI Hub launched the ${manifest.name} installer, but it closed without leaving a detectable install in the expected external locations.`);
      }

      throw new Error(buildManagedPlacementFailureMessage(manifest, installDir));
    }

    return {
      launchMethod,
      recoveredFromArchive,
      toolState,
    };
  } catch (error) {
    installerRunError = error;
    await options.logger.warn('Installer execution did not complete cleanly.', {
      archivePath,
      error,
      timedOut: installerTimedOut,
      expectsManagedInstall: expectManagedInstall,
    });
    throw installerRunError;
  }
}

async function updateExecutableInstallerTool(manifest, paths, options = {}) {
  const { appDir, archivePath, installDir, venvDir } = paths;
  const installerArgs = resolveInstallerArgs(manifest, installDir, appDir);
  const expectManagedInstall = options.expectManagedInstall !== false;
  const errorMessage = options.errorMessage || `Local AI Hub could not run the ${manifest.name} updater.`;
  const expectedVersion = normalizeVersionText(options.expectedVersion || '');
  const previousVersion = normalizeVersionText(options.previousVersion || '');
  const updateViaArchiveExtraction =
    expectManagedInstall
    && Boolean(manifest?.installInstructions?.updateViaArchiveExtraction)
    && path.extname(archivePath).toLowerCase() === '.exe';
  let recoveredFromArchive = updateViaArchiveExtraction;

  if (updateViaArchiveExtraction) {
    await options.logger.info('Applying the managed update directly from the downloaded package.', {
      archivePath,
      installDir,
      appDir,
      expectedVersion: expectedVersion || null,
      previousVersion: previousVersion || null,
    });
    await extractArchive(archivePath, appDir, options.logger);
  } else {
    await options.logger.info('Launching the official update installer executable.', {
      archivePath,
      installDir,
      appDir,
      installerArgs,
      expectsManagedInstall: expectManagedInstall,
      expectedVersion: expectedVersion || null,
      previousVersion: previousVersion || null,
    });

    const installerRun = await runInstallerExecutableFile(archivePath, installerArgs, options.logger, errorMessage);
    const trackedCompletion = createTrackedPromise(installerRun.completion);

    await options.logger.info('The official update installer process started.', {
      archivePath,
      installDir,
      appDir,
      launchMethod: installerRun.launchMethod,
      pid: installerRun.pid,
      expectsManagedInstall: expectManagedInstall,
      expectedVersion: expectedVersion || null,
      previousVersion: previousVersion || null,
    });

    await installerRun.completion.catch(() => null);
    await logInstallerProcessCompletion(options.logger, installerRun, paths, trackedCompletion);

    let installerRunError = trackedCompletion.error;

    if (installerRunError && expectManagedInstall && path.extname(archivePath).toLowerCase() === '.exe') {
      await options.logger.warn('The official update installer exited unsuccessfully. Trying to recover the managed app directly from the downloaded package.', {
        archivePath,
        installDir,
        appDir,
        error: installerRunError,
      });

      try {
        await extractArchive(archivePath, appDir, options.logger);
        recoveredFromArchive = true;
        installerRunError = null;
        await options.logger.info('Managed update files were recovered directly from the downloaded package after the installer exited.', {
          archivePath,
          installDir,
          appDir,
        });
      } catch (recoveryError) {
        await options.logger.warn('Direct archive recovery after the updater exit did not succeed.', {
          archivePath,
          installDir,
          appDir,
          error: recoveryError,
        });
      }
    }

    if (installerRunError) {
      const exitCode = Number(installerRunError.code);
      if (Number.isFinite(exitCode)) {
        const invocationError = new Error(`The ${manifest.name} updater exited with code ${exitCode} after Local AI Hub passed its managed-install arguments.`);
        invocationError.code = exitCode;
        throw invocationError;
      }

      throw installerRunError;
    }

    if (!recoveredFromArchive) {
      await sleep(GUIDED_INSTALLER_LAUNCH_SETTLE_MS);
    }
  }

  const useOfficialDesktopDetection = !expectManagedInstall && isGuidedOfficialInstallerManifest(manifest);
  const toolState = await resolveInstalledExecutableToolState(
    manifest,
    installDir,
    appDir,
    venvDir,
    archivePath,
    options.logger,
    {
      allowExternalResult: !expectManagedInstall,
      useOfficialDesktopDetection,
    },
  );

  if (!toolState) {
    if (useOfficialDesktopDetection) {
      throw new Error(buildOfficialDesktopUpdateVerificationLagMessage(manifest));
    }

    if (!expectManagedInstall) {
      throw new Error(`Local AI Hub launched the ${manifest.name} updater, but it closed without leaving a detectable install in the expected external locations.`);
    }

    throw new Error(buildManagedPlacementFailureMessage(manifest, installDir));
  }
  const detectedVersion = await readInstalledBinaryVersion(toolState);
  let detectionWarning = '';
  if (expectedVersion) {
    if (detectedVersion) {
      if (compareVersionText(detectedVersion, expectedVersion) < 0) {
        throw new Error(buildIncompleteUpdateVersionMessage(manifest, expectedVersion, detectedVersion, previousVersion));
      }
    } else if (previousVersion && compareVersionText(previousVersion, expectedVersion) < 0) {
      if (expectManagedInstall) {
        throw new Error(buildIncompleteUpdateVersionMessage(manifest, expectedVersion, '', previousVersion));
      }
      detectionWarning = buildUnverifiedExternalUpdateMessage(manifest, expectedVersion);
      await options.logger.warn('The official updater finished and the app was detected, but version verification was unavailable.', {
        detectedPath: toolState.displayPath || toolState.installDir || toolState.detectedPath || null,
        expectedVersion,
        previousVersion,
      });
    }
  }

  return {
    detectedVersion,
    detectionWarning,
    toolState,
  };
}
async function ensureCachedDownload(manifest, archivePath, logger, onProgress, toolId) {
  assertSecureRemoteUrl(manifest.downloadUrl, `${manifest.name} download URL`);

  const hasCachedArchive = await hasUsableArchiveCache(archivePath, logger);
  if (hasCachedArchive) {
    await advanceStep(
      logger,
      onProgress,
      {
        toolId,
        percent: 45,
        stage: 'downloading',
        message: 'Using the cached installer package.',
      },
      {
        archivePath,
      },
    );

    try {
      await verifyCachedDownload(manifest, archivePath, logger);
      await validateDownloadedPackage(manifest, archivePath, logger);
      return;
    } catch (error) {
      await logger.warn('Cached installer verification failed. Downloading a fresh copy.', {
        archivePath,
        error,
      });
    }
  }

  await downloadFile(manifest.downloadUrl, archivePath, onProgress, logger, toolId);
  await verifyCachedDownload(manifest, archivePath, logger);
  await validateDownloadedPackage(manifest, archivePath, logger);
}

async function installSingleFileTool(manifest, options, logger) {
  const { appDir, archivePath, installDir, venvDir } = buildManagedPaths(manifest, { installRoot: options.installRoot });
  const downloadFileName =
    manifest.installInstructions.downloadFileName ||
    path.basename(archivePath) ||
    `${manifest.id}.exe`;
  const destinationPath = assertPathInside(
    appDir,
    path.join(appDir, downloadFileName),
    'Local AI Hub refused to copy a launcher outside the managed app folder.',
  );

  await logger.info('Single-file install requested.', {
    archivePath,
    destinationPath,
    installDir,
  });

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 5,
    stage: 'preparing',
    message: `Preparing ${manifest.name}.`,
  });

  await fs.ensureDir(appDir);
  await ensureCachedDownload(manifest, archivePath, logger, options.onProgress, manifest.id);

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 68,
    stage: 'extracting',
    message: `Copying ${manifest.name} into Local AI Hub.`,
  });

  await fs.copy(archivePath, destinationPath, { overwrite: true });

  const toolState = await verifyManagedToolInstall(
    createManagedToolState(manifest, installDir, appDir, venvDir, archivePath, null),
    manifest,
    logger,
  );
  await upsertTool(toolState);

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 100,
    stage: 'complete',
    message: `${manifest.name} is ready.`,
  });

  return ensureManagedToolStatePaths(toolState);
}

function buildGuidedInstallerHandoffMessage(manifest) {
  return `Local AI Hub launched ${manifest.name}'s official installer. Finish setup there and Local AI Hub will detect it automatically when setup closes.`;
}

async function persistCompanionDesktopDetection(baseManifest, companionManifest, managedPaths, logger, options = {}) {
  const discoveredTools = await syncDiscoveredTools({ force: true }).catch(() => ({}));
  const detectedTool = discoveredTools[baseManifest.id];
  if (!detectedTool?.desktopCompanion?.installed) {
    await logger.warn('The companion desktop installer closed without leaving a detectable desktop app.', {
      baseToolId: baseManifest.id,
      detectionPaths: companionManifest.detectionPaths || [],
    });
    await advanceStep(logger, options.onProgress, {
      toolId: baseManifest.id,
      percent: 100,
      stage: 'complete',
      message: `${companionManifest.name} was not detected. Use Install Desktop App when setup is finished.`,
    });
    return null;
  }

  const trackedToolState = normalizeToolLifecycle({
    ...detectedTool,
    desktopCompanion: {
      ...detectedTool.desktopCompanion,
      downloadCachePath: managedPaths.archivePath,
      installedByLocalAIHub: true,
      source: 'official-installer',
    },
  }, baseManifest);
  await upsertTool(trackedToolState);
  await logger.info('Companion desktop installer detection succeeded after setup closed.', {
    baseToolId: baseManifest.id,
    detectedPath: trackedToolState.desktopCompanion?.displayPath || trackedToolState.desktopCompanion?.detectedPath || null,
  });
  await advanceStep(logger, options.onProgress, {
    toolId: baseManifest.id,
    percent: 100,
    stage: 'complete',
    message: `${companionManifest.name} is ready.`,
  });
  if (typeof options.onCompleted === 'function') {
    await options.onCompleted({
      manifest: baseManifest,
      toolState: trackedToolState,
    });
  }
  return trackedToolState;
}

function trackCompanionInstallerHandoff(baseManifest, companionManifest, managedPaths, installerRun, logger, options = {}) {
  void installerRun.completion
    .then(async (result) => {
      await logger.info('The companion desktop installer process exited.', {
        archivePath: managedPaths.archivePath,
        exitCode: result?.code ?? 0,
        exitSignal: result?.signal || null,
        launchMethod: installerRun.launchMethod,
        pid: installerRun.pid,
      });
      await persistCompanionDesktopDetection(baseManifest, companionManifest, managedPaths, logger, options);
    })
    .catch(async (error) => {
      await logger.warn('The companion desktop installer process exited with an error.', {
        archivePath: managedPaths.archivePath,
        error,
        launchMethod: installerRun.launchMethod,
        pid: installerRun.pid,
      });
    });
}

async function installCompanionDesktopTool(baseManifest, options, logger) {
  const companionManifest = baseManifest.companionDesktop;
  if (!companionManifest) {
    throw new Error(`${baseManifest.name} does not have an official desktop companion installer.`);
  }

  const managedPaths = buildManagedPaths(companionManifest, { installRoot: options.installRoot });
  const progress = (payload) => {
    if (typeof options.onProgress === 'function') {
      options.onProgress({
        ...payload,
        toolId: baseManifest.id,
      });
    }
  };

  await logger.info('Companion desktop installer requested.', {
    baseToolId: baseManifest.id,
    companionToolId: companionManifest.id,
    archivePath: managedPaths.archivePath,
  });

  await advanceStep(logger, progress, {
    toolId: baseManifest.id,
    percent: 5,
    stage: 'preparing',
    message: `Preparing ${companionManifest.name}.`,
  });
  await ensureCachedDownload(companionManifest, managedPaths.archivePath, logger, progress, baseManifest.id);
  await advanceStep(logger, progress, {
    toolId: baseManifest.id,
    percent: 72,
    stage: 'installing',
    message: `Finish the official ${companionManifest.name} installer. Local AI Hub will detect it after setup finishes.`,
  });

  const installerRun = await runInstallerExecutableFile(
    managedPaths.archivePath,
    resolveInstallerArgs(companionManifest, managedPaths.installDir, managedPaths.appDir),
    logger,
    `Local AI Hub could not run the ${companionManifest.name} installer.`,
    { windowsHide: false },
  );
  const trackedLaunch = createTrackedPromise(installerRun.completion);
  await sleep(GUIDED_INSTALLER_LAUNCH_SETTLE_MS);

  if (trackedLaunch.settled && trackedLaunch.error) {
    const launchError = new Error(`Local AI Hub tried to open ${companionManifest.name}'s official installer, but it exited before the setup window stayed open.`);
    launchError.cause = trackedLaunch.error;
    throw launchError;
  }

  if (trackedLaunch.settled && Number.isInteger(trackedLaunch.value?.code) && trackedLaunch.value.code > 0) {
    const launchError = new Error(`Local AI Hub tried to open ${companionManifest.name}'s official installer, but it exited immediately with code ${trackedLaunch.value.code}.`);
    launchError.code = trackedLaunch.value.code;
    throw launchError;
  }

  await setToolIgnored(baseManifest.id, false);
  trackCompanionInstallerHandoff(baseManifest, companionManifest, managedPaths, installerRun, logger, {
    onCompleted: options.onGuidedInstallerComplete,
    onProgress: progress,
  });

  return {
    handoffPending: true,
    id: baseManifest.id,
    installActionMessage: buildGuidedInstallerHandoffMessage(companionManifest),
    name: baseManifest.name,
  };
}

function trackGuidedInstallerHandoff(manifest, managedPaths, installerRun, logger, options = {}) {
  void installerRun.completion
    .then(async (result) => {
      await logger.info('The guided official installer process exited.', {
        appDir: managedPaths.appDir,
        archivePath: managedPaths.archivePath,
        exitCode: result?.code ?? 0,
        exitSignal: result?.signal || null,
        installDir: managedPaths.installDir,
        launchMethod: installerRun.launchMethod,
        pid: installerRun.pid,
      });

      const discoveredTools = await syncDiscoveredTools({ force: true }).catch(() => ({}));
      const detectedTool = discoveredTools[manifest.id];
      if (!(await toolIsAvailable(detectedTool))) {
        await logger.warn('The guided official installer closed without leaving a detectable install.', {
          appDir: managedPaths.appDir,
          archivePath: managedPaths.archivePath,
          detectionPaths: manifest.detectionPaths || [],
          installDir: managedPaths.installDir,
          pid: installerRun.pid,
        });
        return;
      }

      const trackedToolState = await attachWindowsUninstallMetadata(
        normalizeToolLifecycle({
          ...detectedTool,
          downloadCachePath: managedPaths.archivePath,
          installedByLocalAIHub: true,
          requestedInstallRoot: managedPaths.installRoot,
        }, manifest),
        manifest,
        { refresh: true },
      );
      await upsertTool(trackedToolState);
      await logger.info('Guided official installer detection succeeded after the installer closed.', {
        detectedPath: trackedToolState.displayPath || trackedToolState.installDir || trackedToolState.detectedPath || null,
        pid: installerRun.pid,
      });
      await advanceStep(logger, options.onProgress, {
        toolId: manifest.id,
        percent: 100,
        stage: 'complete',
        message: `${manifest.name} is ready.`,
      }, {
        detectedPath: trackedToolState.displayPath || trackedToolState.installDir || trackedToolState.detectedPath || null,
        pid: installerRun.pid,
      });
      if (typeof options.onCompleted === 'function') {
        await options.onCompleted({
          manifest,
          toolState: trackedToolState,
        });
      }
    })
    .catch(async (error) => {
      await logger.warn('The guided official installer process exited with an error.', {
        appDir: managedPaths.appDir,
        archivePath: managedPaths.archivePath,
        error,
        installDir: managedPaths.installDir,
        launchMethod: installerRun.launchMethod,
        pid: installerRun.pid,
      });
    });
}

async function installExecutableInstallerTool(manifest, options, logger) {
  const managedPaths = buildManagedPaths(manifest, { installRoot: options.installRoot });
  const { appDir, archivePath, installDir } = managedPaths;
  const expectManagedInstall = expectsManagedInstallerResult(manifest);

  await logger.info('Installer executable requested.', {
    archivePath,
    installDir,
    expectsManagedInstall: expectManagedInstall,
  });

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 5,
    stage: 'preparing',
    message: `Preparing ${manifest.name}.`,
  });

  if (expectManagedInstall) {
    await fs.ensureDir(installDir);
    await fs.ensureDir(appDir);
  }

  await ensureCachedDownload(manifest, archivePath, logger, options.onProgress, manifest.id);

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 72,
    stage: 'installing',
    message: expectManagedInstall
      ? `Running the official ${manifest.name} installer.`
      : `Finish the official ${manifest.name} installer. Local AI Hub will detect it after setup finishes.`,
  });

  if (!expectManagedInstall) {
    const installerRun = await runInstallerExecutableFile(
      archivePath,
      resolveInstallerArgs(manifest, installDir, appDir),
      logger,
      `Local AI Hub could not run the ${manifest.name} installer.`,
      { windowsHide: false },
    );
    const trackedLaunch = createTrackedPromise(installerRun.completion);
    await sleep(GUIDED_INSTALLER_LAUNCH_SETTLE_MS);

    if (trackedLaunch.settled && trackedLaunch.error) {
      await logger.warn('The guided official installer exited before Local AI Hub could confirm the handoff.', {
        appDir,
        archivePath,
        error: trackedLaunch.error,
        installDir,
        launchMethod: installerRun.launchMethod,
        pid: installerRun.pid,
      });
      const launchError = new Error(`Local AI Hub tried to open ${manifest.name}'s official installer, but it exited before the setup window stayed open.`);
      launchError.cause = trackedLaunch.error;
      throw launchError;
    }

    if (trackedLaunch.settled && Number.isInteger(trackedLaunch.value?.code) && trackedLaunch.value.code > 0) {
      await logger.warn('The guided official installer exited too quickly to complete the handoff.', {
        appDir,
        archivePath,
        exitCode: trackedLaunch.value.code,
        exitSignal: trackedLaunch.value?.signal || null,
        installDir,
        launchMethod: installerRun.launchMethod,
        pid: installerRun.pid,
      });
      const launchError = new Error(`Local AI Hub tried to open ${manifest.name}'s official installer, but it exited immediately with code ${trackedLaunch.value.code}.`);
      launchError.code = trackedLaunch.value.code;
      throw launchError;
    }

    await logger.info('Guided official installer handoff started.', {
      appDir,
      archivePath,
      installDir,
      launchMethod: installerRun.launchMethod,
      pid: installerRun.pid,
    });
    await setToolIgnored(manifest.id, false);
    trackGuidedInstallerHandoff(manifest, managedPaths, installerRun, logger, {
      onCompleted: options.onGuidedInstallerComplete,
      onProgress: options.onProgress,
    });

    return {
      handoffPending: true,
      id: manifest.id,
      installActionMessage: buildGuidedInstallerHandoffMessage(manifest),
      name: manifest.name,
    };
  }

  const materializedInstall = await materializeExecutableInstallerTool(manifest, managedPaths, {
    errorMessage: `Local AI Hub could not run the ${manifest.name} installer.`,
    logger,
    onProgress: options.onProgress,
  });
  const toolState =
    materializedInstall.toolState.source === 'managed'
      ? await verifyManagedToolInstall(materializedInstall.toolState, manifest, logger)
      : normalizeToolLifecycle({
          ...materializedInstall.toolState,
          downloadCachePath: archivePath,
          installedByLocalAIHub: true,
          requestedInstallRoot: managedPaths.installRoot,
        }, manifest);

  const trackedToolState = await attachWindowsUninstallMetadata(toolState, manifest, {
    refresh: true,
  });
  await upsertTool(trackedToolState);
  await logger.info('Installer executable materialized successfully.', {
    archivePath,
    installDir,
    launchMethod: materializedInstall.launchMethod,
    recoveredFromArchive: materializedInstall.recoveredFromArchive,
  });

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 100,
    stage: 'complete',
    message: `${manifest.name} is ready.`,
  });

  return trackedToolState.source === 'managed' ? ensureManagedToolStatePaths(trackedToolState) : trackedToolState;
}
async function installPipPackageTool(manifest, options, logger) {
  const { appDir, archivePath, installDir, venvDir } = buildManagedPaths(manifest, { installRoot: options.installRoot });

  await logger.info('Pip package install requested.', {
    installDir,
    archivePath,
  });

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 5,
    stage: 'preparing',
    message: `Preparing ${manifest.name}.`,
  });

  await fs.ensureDir(installDir);
  await fs.ensureDir(appDir);

  const pythonResolution = await resolveManagedPythonRuntime(
    appDir,
    manifest,
    logger,
    options.onProgress,
    manifest.id,
  );

  const toolState = createManagedToolState(
    manifest,
    installDir,
    appDir,
    venvDir,
    archivePath,
    pythonResolution,
  );

  const optionalInstallWarnings = await installPythonDependencies(
    toolState,
    manifest,
    options.onProgress,
    logger,
    pythonResolution.runtime,
  );

  const verifiedToolState = attachOptionalInstallWarnings(
    await verifyManagedToolInstall(toolState, manifest, logger),
    manifest,
    optionalInstallWarnings,
  );

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 98,
    stage: 'finalizing',
    message: `${manifest.name} is being registered in Local AI Hub.`,
  });

  await upsertTool(verifiedToolState);

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 100,
    stage: 'complete',
    message: `${manifest.name} is ready.`,
  });

  return ensureManagedToolStatePaths(verifiedToolState);
}

async function installTool(toolId, options = {}) {
  return withToolInstallOperationLock(toolId, 'installing or repairing', () => installToolUnlocked(toolId, options));
}

async function installToolUnlocked(toolId, options = {}) {
  await initializeToolRegistry();
  const manifest = getToolManifest(toolId);
  if (!manifest) {
    throw new Error('Local AI Hub does not recognize that tool.');
  }

  const logger = createLogger('installer', {
    toolId,
    toolName: manifest.name,
  });
  const capability = String(options.capability || options.installCapability || 'webui').trim().toLowerCase();
  const installRoot = await resolvePreferredInstallRoot(options.installRoot || null);
  const managedPaths = buildManagedPaths(manifest, { installRoot });
  let existingTool = null;
  let rollbackManagedInstallOnFailure = true;

  try {
    await setToolIgnored(toolId, false);
    if (capability === 'desktop' && manifest.companionDesktop) {
      return installCompanionDesktopTool(manifest, {
        ...options,
        installRoot,
      }, logger);
    }

    const discoveredTools = await syncDiscoveredTools({ force: true });
    existingTool = discoveredTools[toolId];
    rollbackManagedInstallOnFailure =
      !(existingTool?.source === 'managed' || existingTool?.managedByLocalAIHub) &&
      isDirectManagedTool({ source: 'managed' }, manifest);
    if (await toolIsAvailable(existingTool)) {
      const existingPath = existingTool.displayPath || existingTool.installDir;
      if (isManagedToolState(existingTool)) {
        const installActionMessage = `${manifest.name} is already installed inside Local AI Hub.`;

        await logger.info('Install request reused an existing managed tool installation.', {
          existingPath,
          source: existingTool.source,
        });

        return {
          ...existingTool,
          installActionMessage,
          reusedExistingInstall: true,
        };
      }

      await logger.info('Install request found a detected system install. Continuing with a managed install request.', {
        existingPath,
        source: existingTool.source,
      });
    }

    const installPreflight = await getToolInstallPreflight({ toolId, installRoot });
    assertInstallPreflightApproved(installPreflight, Boolean(options.lowDiskConfirmed));

    const { archivePath, installDir } = managedPaths;

    await logger.info('Install requested.', {
      installDir,
      archivePath,
      installRoot,
      logsPath: await logger.getFilePath(),
    });

    const installOptions = {
      ...options,
      installRoot,
    };

    const installKind = manifest.installInstructions.kind || 'zip';
    if (installKind === 'single-file') {
      const toolState = await installSingleFileTool(manifest, installOptions, logger);
      await logger.info('Single-file install completed successfully.');
      return finalizeManagedInstallResult(ensureManagedToolStatePaths(toolState), manifest, existingTool);
    }

    if (installKind === 'installer-exe') {
      const toolState = await installExecutableInstallerTool(manifest, installOptions, logger);
      if (toolState?.handoffPending) {
        await logger.info('Installer-based install was handed off to the vendor setup flow.');
        return toolState;
      }

      await logger.info('Installer-based install completed successfully.');
      return finalizeManagedInstallResult(
        toolState.source === 'managed' ? ensureManagedToolStatePaths(toolState) : toolState,
        manifest,
        existingTool,
      );
    }

    if (installKind === 'pip-package') {
      const toolState = await installPipPackageTool(manifest, installOptions, logger);
      await logger.info('Pip package install completed successfully.');
      return finalizeManagedInstallResult(ensureManagedToolStatePaths(toolState), manifest, existingTool);
    }

    const { appDir, venvDir } = managedPaths;

    await advanceStep(logger, options.onProgress, {
      toolId,
      percent: 5,
      stage: 'preparing',
      message: `Preparing ${manifest.name}.`,
    });

    await fs.ensureDir(installDir);
    await ensureCachedDownload(manifest, archivePath, logger, options.onProgress, toolId);

    await advanceStep(logger, options.onProgress, {
      toolId,
      percent: 50,
      stage: 'extracting',
      message: 'Expanding the installer package.',
    });

    await extractArchiveWithRecovery(manifest, archivePath, appDir, options.onProgress, logger, toolId);

    const pythonResolution = await resolveManagedPythonRuntime(
      appDir,
      manifest,
      logger,
      options.onProgress,
      toolId,
    );

    const toolState = createManagedToolState(
      manifest,
      installDir,
      appDir,
      venvDir,
      archivePath,
      pythonResolution,
    );

    let optionalInstallWarnings = [];
    if (getToolRuntime(manifest) === 'python') {
      optionalInstallWarnings = await installPythonDependencies(
        toolState,
        manifest,
        options.onProgress,
        logger,
        pythonResolution.runtime,
      );
    }

    await advanceStep(logger, options.onProgress, {
      toolId,
      percent: 98,
      stage: 'finalizing',
      message: `${manifest.name} is being registered in Local AI Hub.`,
    });

    const verifiedToolState = attachOptionalInstallWarnings(
      await verifyManagedToolInstall(toolState, manifest, logger),
      manifest,
      optionalInstallWarnings,
    );

    await upsertTool(verifiedToolState);
    await logger.info('Tool registration completed.', {
      installDir,
      launchProfile: verifiedToolState.launchProfile,
    });

    await advanceStep(logger, options.onProgress, {
      toolId,
      percent: 100,
      stage: 'complete',
      message: `${manifest.name} is ready.`,
    });
    await logger.info('Install completed successfully.');

    return finalizeManagedInstallResult(ensureManagedToolStatePaths(verifiedToolState), manifest, existingTool);
  } catch (error) {
    const readableMessage = humanizeError(error, `Local AI Hub could not install ${manifest.name}.`);
    const supportMessage = appendSupportGuidance(readableMessage);
    recordSupportEvent({
      area: 'installer',
      toolId,
      operation: 'install',
      error,
      message: readableMessage,
    });
    if (rollbackManagedInstallOnFailure) {
      await fs.remove(managedPaths.installDir).catch(() => null);
      await logger.warn('Removed incomplete managed install after a failed install attempt.', {
        installDir: managedPaths.installDir,
      });
    }

    await logger.error('Install failed.', {
      error,
      readableMessage: supportMessage,
    });
    throw new Error(supportMessage);
  }
}
async function removePythonCaches(directory) {
  if (!(await fs.pathExists(directory))) {
    return;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') {
          await fs.remove(entryPath);
          return;
        }
        await removePythonCaches(entryPath);
      }
    }),
  );
}

async function inspectToolRepair(toolState) {
  await initializeToolRegistry();
  const manifest = getToolManifest(toolState?.id);
  if (!manifest) {
    throw new Error('Local AI Hub could not find the tool definition for repair.');
  }

  const safeToolState = toolState?.source === 'managed' ? ensureManagedToolStatePaths(toolState) : toolState;
  const cleanupPlan = await inspectRepairCleanup(safeToolState, manifest);
  return {
    toolId: toolState.id,
    toolName: manifest.name,
    ...summarizeRepairPlan(cleanupPlan),
  };
}

async function repairToolInstallation(toolState, options = {}) {
  return withToolInstallOperationLock(toolState?.id, 'installing or repairing', () => repairToolInstallationUnlocked(toolState, options));
}

async function repairToolInstallationUnlocked(toolState, options = {}) {
  const manifest = getToolManifest(toolState.id);
  if (!manifest) {
    throw new Error('Local AI Hub could not find the tool definition for repair.');
  }

  const logger = createLogger('installer', {
    toolId: toolState.id,
    toolName: manifest.name,
    mode: 'repair',
  });

  try {
    const installRoot = resolveStoredInstallRoot(toolState);
    const managedPaths = buildManagedPaths(manifest, { installRoot });
    const installKind = manifest.installInstructions.kind || 'zip';
    const capability = String(options.capability || options.installCapability || 'webui').trim().toLowerCase();
    const lifecycleManaged = isDirectManagedTool(toolState, manifest);
    const usesOfficialInstaller = isOfficialInstallerTool(toolState, manifest);
    if (toolState.source === 'managed') {
      toolState = ensureManagedToolStatePaths(normalizeToolLifecycle(toolState, manifest));
    }

    await logger.info('Repair requested.', {
      installDir: toolState.installDir,
      archivePath: toolState.downloadCachePath || managedPaths.archivePath,
      installRoot,
      lifecycleMode: toolState.lifecycleMode || null,
    });

    if (capability === 'desktop' && manifest.companionDesktop) {
      const companionManifest = manifest.companionDesktop;
      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 15,
        stage: 'checking',
        message: `Checking for ${companionManifest.name}.`,
      });

      const discoveredTools = await syncDiscoveredTools({ force: true });
      const detectedTool = discoveredTools[toolState.id];
      if (detectedTool?.desktopCompanion?.installed) {
        const repairedTool = normalizeToolLifecycle({
          ...detectedTool,
          lastError: null,
          lastRepairMessage: `${companionManifest.name} was detected and is ready.`,
          status: detectedTool.status === 'error' || detectedTool.status === 'starting' ? 'stopped' : detectedTool.status || 'stopped',
        }, manifest);
        await upsertTool(repairedTool);
        await advanceStep(logger, options.onProgress, {
          toolId: toolState.id,
          percent: 100,
          stage: 'complete',
          message: repairedTool.lastRepairMessage,
        });
        return repairedTool;
      }

      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 40,
        stage: 'repairing',
        message: `Opening the ${companionManifest.name} installer again.`,
      });
      return installCompanionDesktopTool(manifest, {
        ...options,
        installRoot,
      }, logger);
    }

    await advanceStep(logger, options.onProgress, {
      toolId: toolState.id,
      percent: 12,
      stage: 'cleanup',
      message: 'Checking for duplicate folders and failed downloads.',
    });

    const cleanupPlan = await inspectRepairCleanup(toolState, manifest);
    const cleanupSummary = await applyRepairCleanup(cleanupPlan, {
      logger,
      removeOrphanedToolFolders: Boolean(options.removeOrphanedToolFolders),
    });
    const repairNotes = buildRepairCleanupNotes(cleanupSummary);
    let runtimeChanged = false;

    if (usesOfficialInstaller) {
      const uninstallContext = await resolveToolUninstallContext(toolState, manifest, { refresh: true });
      for (const staleEntry of uninstallContext?.staleEntries || []) {
        await removeWindowsUninstallEntry(staleEntry.entry).catch(() => null);
      }
      if ((uninstallContext?.staleEntries || []).length > 0) {
        repairNotes.push('cleared broken Windows uninstall entries');
      }
    }

    if (!lifecycleManaged) {
      if (installKind !== 'installer-exe') {
        throw new Error('Local AI Hub can only repair external installs when the official installer can be rerun safely.');
      }

      const downloadCachePath = toolState.downloadCachePath || managedPaths.archivePath;
      await ensureCachedDownload(manifest, downloadCachePath, logger, options.onProgress, toolState.id);

      await logger.info('Official installer repair requested.', {
        installDir: toolState.installDir,
        archivePath: downloadCachePath,
      });

      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 40,
        stage: 'repairing',
        message: `Running the ${manifest.name} installer again.`,
      });

      let repairedTool = null;
      if (toolState.source === 'managed') {
        const repairedInstaller = await preserveModelManagerAssetsForAction(
          toolState,
          logger,
          'official-installer-repair',
          () => materializeExecutableInstallerTool(
            manifest,
            {
              appDir: toolState.appDir || managedPaths.appDir,
              archivePath: downloadCachePath,
              installDir: toolState.installDir || managedPaths.installDir,
              venvDir: toolState.venvDir || managedPaths.venvDir,
            },
            {
              errorMessage: `Local AI Hub could not rerun the ${manifest.name} installer.`,
              logger,
              onProgress: options.onProgress,
            },
          ),
        );
        repairedTool =
          repairedInstaller.toolState.source === 'managed'
            ? await verifyManagedToolInstall(repairedInstaller.toolState, manifest, logger)
            : repairedInstaller.toolState;
      } else {
        await runInstallerExecutableFile(
          downloadCachePath,
          resolveInstallerArgs(
            manifest,
            toolState.installDir || managedPaths.installDir,
            toolState.appDir || toolState.installDir || managedPaths.appDir,
          ),
          logger,
          `Local AI Hub could not rerun the ${manifest.name} installer.`,
        );

        const discoveredTools = await syncDiscoveredTools({ force: true });
        repairedTool = discoveredTools[toolState.id];
      }

      if (!(await toolIsAvailable(repairedTool))) {
        throw new Error(`Local AI Hub reran the ${manifest.name} installer, but it still could not find the launcher afterward.`);
      }

      repairNotes.push('reran the official installer');
      const updatedExternalTool = normalizeToolLifecycle({
        ...repairedTool,
        downloadCachePath,
        installedByLocalAIHub: toolState.installedByLocalAIHub || toolState.source === 'managed',
        lastError: null,
        lastRepairMessage: buildRepairOutcomeMessage(manifest.name, repairNotes),
        requestedInstallRoot: toolState.requestedInstallRoot || installRoot,
        status: 'stopped',
      }, manifest);
      const trackedExternalTool = await attachWindowsUninstallMetadata(updatedExternalTool, manifest, {
        refresh: true,
      });
      await upsertTool(trackedExternalTool);

      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 100,
        stage: 'complete',
        message: trackedExternalTool.lastRepairMessage,
      });

      return trackedExternalTool;
    }

    toolState.downloadCachePath = managedPaths.archivePath;
    if (installKind !== 'pip-package') {
      await ensureCachedDownload(manifest, toolState.downloadCachePath, logger, options.onProgress, toolState.id);
    }

    if (installKind === 'single-file') {
      const destinationPath = assertPathInside(
        managedPaths.appDir,
        path.join(
          managedPaths.appDir,
          manifest.installInstructions.downloadFileName || path.basename(toolState.downloadCachePath),
        ),
        'Local AI Hub refused to restore a launcher outside the managed app folder.',
      );

      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 25,
        stage: 'repairing',
        message: 'Restoring the tool launcher from the cached installer.',
      });
      await fs.ensureDir(managedPaths.appDir);
      await fs.copy(toolState.downloadCachePath, destinationPath, { overwrite: true });
      repairNotes.push('restored the launcher file from the local cache');
    } else if (installKind === 'installer-exe') {
      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 25,
        stage: 'repairing',
        message: `Running the ${manifest.name} installer again.`,
      });
      const repairedInstaller = await preserveModelManagerAssetsForAction(
        toolState,
        logger,
        'installer-exe-repair',
        () => materializeExecutableInstallerTool(
          manifest,
          {
            appDir: toolState.appDir,
            archivePath: toolState.downloadCachePath,
            installDir: toolState.installDir,
            venvDir: toolState.venvDir,
          },
          {
            errorMessage: `Local AI Hub could not rerun the ${manifest.name} installer.`,
            logger,
            onProgress: options.onProgress,
          },
        ),
      );
      Object.assign(toolState, repairedInstaller.toolState);
      repairNotes.push(
        repairedInstaller.recoveredFromArchive
          ? 'restored the application files directly from the local installer package'
          : 'reran the official installer from the local cache',
      );
    } else if (installKind === 'zip') {
      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 25,
        stage: 'repairing',
        message: 'Restoring the tool files from the cached installer.',
      });
      await preserveModelManagerAssetsForAction(toolState, logger, 'zip-repair', () =>
        extractArchive(toolState.downloadCachePath, toolState.appDir, logger),
      );
      repairNotes.push('restored the application files from the local cache');
    } else if (installKind === 'pip-package') {
      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 25,
        stage: 'repairing',
        message: 'Refreshing the tool package inside its Python environment.',
      });
      repairNotes.push('refreshed the installed Python package');
    }

    if (getToolRuntime(manifest) === 'python') {
      await removePythonCaches(toolState.appDir);
      await logger.info('Cleared Python cache folders during repair.');
      repairNotes.push('cleared cached Python bytecode');

      const pythonResolution = await resolveManagedPythonRuntime(
        toolState.appDir,
        manifest,
        logger,
        options.onProgress,
        toolState.id,
      );

      const previousRuntimeVersion = toolState.pythonBootstrapVersion || toolState.managedPythonVersion || null;
      const previousRuntimeSource = toolState.pythonBootstrapSource || (toolState.managedPythonVersion ? 'managed' : null);
      runtimeChanged =
        previousRuntimeVersion !== pythonResolution.runtime.versionString ||
        previousRuntimeSource !== pythonResolution.runtime.source;
      if (toolState.venvDir) {
        await removePathWithRetries(toolState.venvDir, logger, 'repair-python-environment');
      }

      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 55,
        stage: 'repairing',
        message: 'Rebuilding the tool environment.',
      });

      const rebuiltState = createManagedToolState(
        manifest,
        toolState.installDir,
        toolState.appDir,
        toolState.venvDir,
        toolState.downloadCachePath,
        pythonResolution,
      );

      const optionalInstallWarnings = await installPythonDependencies(
        rebuiltState,
        manifest,
        options.onProgress,
        logger,
        pythonResolution.runtime,
      );
      if (optionalInstallWarnings.length) {
        repairNotes.push(...optionalInstallWarnings);
      }

      Object.assign(toolState, rebuiltState);
      repairNotes.push(
        pythonResolution.runtime.source === 'system'
          ? `recreated the virtual environment with Python ${pythonResolution.runtime.versionString} already installed on this PC`
          : runtimeChanged
            ? `recreated the virtual environment with Python ${pythonResolution.runtime.versionString}`
            : 'recreated the virtual environment',
      );
    }

    const updatedState = normalizeToolLifecycle({
      ...toolState,
      source: 'managed',
      installRoot,
      installedByLocalAIHub: true,
      lastError: null,
      lastRepairMessage: buildRepairOutcomeMessage(manifest.name, repairNotes),
      requestedInstallRoot: toolState.requestedInstallRoot || installRoot,
      status: 'stopped',
    }, manifest);

    Object.assign(updatedState, buildLaunchModeState(updatedState, manifest, { source: 'managed' }));
    if (!updatedState.launchProfile) {
      updatedState.launchProfile = buildManagedLaunchProfile(updatedState, manifest);
    }
    const verifiedUpdatedState = await verifyManagedToolInstall(updatedState, manifest, logger);
    await upsertTool(verifiedUpdatedState);

    const verifiedManagedTool = await verifyRepairedToolState(manifest, verifiedUpdatedState, {
      expectManaged: true,
    });
    const finalManagedTool = {
      ...verifiedManagedTool,
      lastError: null,
      lastRepairMessage: updatedState.lastRepairMessage,
      status: 'stopped',
    };
    const trackedManagedTool =
      installKind === 'installer-exe'
        ? await attachWindowsUninstallMetadata(finalManagedTool, manifest, {
            refresh: true,
          })
        : finalManagedTool;
    await upsertTool(trackedManagedTool);

    await advanceStep(logger, options.onProgress, {
      toolId: toolState.id,
      percent: 100,
      stage: 'complete',
      message: trackedManagedTool.lastRepairMessage,
    });
    await logger.info('Repair completed successfully.', {
      runtimeChanged,
      cleanupSummary,
      verifiedInstallDir: trackedManagedTool.installDir,
    });

    return trackedManagedTool;
  } catch (error) {
    const readableMessage = buildRepairFailureMessage(error, manifest);
    recordSupportEvent({
      area: 'repair',
      toolId: toolState.id,
      operation: 'repair',
      error,
      message: readableMessage,
    });
    await upsertTool({
      id: toolState.id,
      lastError: readableMessage,
      lastRepairMessage: null,
      status: 'error',
    }).catch(() => null);
    await logger.error('Repair failed.', {
      error,
      readableMessage,
    });
    throw new Error(readableMessage);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUninstallFollowupNotes(options = {}) {
  const notes = [];

  if (options.clearedWindowsEntries > 0) {
    notes.push(
      `cleared ${options.clearedWindowsEntries} broken Windows uninstall ${pluralize(options.clearedWindowsEntries, 'entry')}`,
    );
  }

  if (options.removedShortcutCount > 0) {
    notes.push(
      `removed ${options.removedShortcutCount} leftover Windows ${pluralize(options.removedShortcutCount, 'shortcut')}`,
    );
  }

  if (options.removedModelAssetRootCount > 0) {
    notes.push(
      `removed ${options.removedModelAssetRootCount} managed Model Manager asset ${pluralize(options.removedModelAssetRootCount, 'folder')}`,
    );
  }

  if (options.deferredCleanupCount > 0) {
    notes.push(
      `left ${options.deferredCleanupCount} Local AI Hub cleanup ${pluralize(options.deferredCleanupCount, 'item')} for Cleanup because Windows was still finishing with ${options.deferredCleanupCount === 1 ? 'it' : 'them'}`,
    );
  }

  return notes;
}

function appendUninstallFollowup(baseMessage, notes = [], options = {}) {
  const normalizedBase = String(baseMessage || '').trim();
  let nextMessage = normalizedBase;
  if (notes.length) {
    nextMessage = `${normalizedBase.replace(/[.\s]+$/, '')}. Local AI Hub also ${notes.join(' and ')}.`;
  }

  const remainingStaleWindowsEntries = Number(options.remainingStaleWindowsEntries || 0);
  if (remainingStaleWindowsEntries > 0) {
    const entryLabel = pluralize(
      remainingStaleWindowsEntries,
      'stale Windows Apps & Features entry',
      'stale Windows Apps & Features entries',
    );
    const pronoun = remainingStaleWindowsEntries === 1 ? 'it' : 'they';
    nextMessage = `${nextMessage.replace(/[.\s]+$/, '')}. Windows Apps & Features may still show ${remainingStaleWindowsEntries} ${entryLabel}. Run Cleanup if ${pronoun} stays there.`;
  }

  if (options.lingeringWindowsEntry) {
    nextMessage = `${nextMessage.replace(/[.\s]+$/, '')}. Windows Apps & Features may still show a dead entry for this tool even though Local AI Hub could no longer detect a usable install. Run Cleanup if it stays there.`;
  }

  return nextMessage;
}

function countRemainingStaleWindowsEntries(context = {}) {
  return Array.isArray(context?.staleEntries) ? context.staleEntries.length : 0;
}

function buildWindowsUninstallUnresolvedMessage(manifest, context = {}) {
  if (context?.entry) {
    return `${manifest.name} is still registered in Windows Apps & Features. Local AI Hub kept it in Library because the uninstall is not fully finished yet. Open Windows Apps & Features and finish the vendor uninstall, then try again.`;
  }

  if ((context?.staleEntries || []).length > 0) {
    return `${manifest.name}'s files are gone, but Windows Apps & Features still has a stale uninstall entry. Local AI Hub kept it in Library until that entry can be cleared. Run Cleanup and then try again if the entry remains.`;
  }

  return `${manifest.name} still appears to be installed in Windows Apps & Features.`;
}

async function preflightOwnedInstallRemoval(toolState, logger, operationLabel, actionLabel = 'uninstall') {
  const installDir = normalizeOptionalDirectoryPath(toolState?.installDir || '');
  if (!installDir || !(await fs.pathExists(installDir))) {
    return false;
  }

  await preflightPathRemoval(installDir, logger, operationLabel, {
    actionLabel,
  });
  await logger?.info?.('Verified that a Local AI Hub-owned install directory is ready for uninstall.', {
    operationLabel,
    path: installDir,
    toolId: toolState?.id || null,
  });
  return true;
}

async function removeOwnedInstallCopy(toolState, logger, operationLabel) {
  const installDir = normalizeOptionalDirectoryPath(toolState?.installDir || '');
  if (!installDir || !(await fs.pathExists(installDir))) {
    return {
      removedInstallDir: false,
    };
  }

  await removePathWithRetries(installDir, logger, operationLabel);
  await logger?.info?.('Removed a Local AI Hub-owned install directory.', {
    operationLabel,
    path: installDir,
    toolId: toolState?.id || null,
  });

  return {
    removedInstallDir: true,
  };
}

async function cleanupOwnedToolArtifacts(toolState, logger, operationLabel, options = {}) {
  const deferredCleanupEntries = [];
  let installCleanup = {
    removedInstallDir: false,
  };

  if (toolState?.source === 'managed') {
    try {
      installCleanup = await removeOwnedInstallCopy(toolState, logger, operationLabel);
    } catch (error) {
      const readableMessage = String(error?.message || '');
      if (!options.allowBusyInstallDirFailure || !/still being used by Windows/i.test(readableMessage)) {
        throw error;
      }

      const installDir = normalizeOptionalDirectoryPath(toolState?.installDir || '');
      if (installDir) {
        deferredCleanupEntries.push(installDir);
      }
      await logger?.warn?.('Local AI Hub left a managed install folder behind because Windows is still using it.', {
        operationLabel,
        path: installDir,
        toolId: toolState?.id || null,
        error,
      });
    }
  }

  const modelAssetCleanup = await removeManagedModelManagerAssets(toolState, logger, operationLabel + '-model-assets');
  const shortcutCleanup = await removeToolWindowsShortcuts(toolState, logger);

  return {
    deferredCleanupCount: deferredCleanupEntries.length,
    deferredCleanupEntries,
    removedInstallDir: Boolean(installCleanup?.removedInstallDir),
    removedModelAssetRootCount: modelAssetCleanup.removedModelAssetRootCount,
    removedModelAssetRoots: modelAssetCleanup.removedModelAssetRoots,
    removedShortcutCount: shortcutCleanup.removedCount,
    removedShortcutPaths: shortcutCleanup.removedPaths,
  };
}

async function waitForOfficialUninstallOutcome(toolState, manifest, matchesTrackedExternalInstall, logger) {
  const deadline = Date.now() + OFFICIAL_UNINSTALL_SETTLE_TIMEOUT_MS;
  let lastContext = null;
  let lastDetectedTool = null;

  while (Date.now() <= deadline) {
    lastContext = await resolveToolUninstallContext(toolState, manifest, { refresh: true }).catch(() => null);
    const discoveredTools = await syncDiscoveredTools({ force: true, persist: false });
    lastDetectedTool = discoveredTools[toolState.id];

    const detectedAvailable = await toolIsAvailable(lastDetectedTool);
    const switchedToDetected = detectedAvailable && matchesTrackedExternalInstall(lastDetectedTool);
    const vendorEntryStillPresent = Boolean(lastContext?.entry);

    if (!vendorEntryStillPresent && (!detectedAvailable || switchedToDetected)) {
      return {
        complete: true,
        detectedTool: lastDetectedTool,
        switchedToDetected,
        uninstallContext: lastContext,
      };
    }

    if (Date.now() + OFFICIAL_UNINSTALL_SETTLE_POLL_MS > deadline) {
      break;
    }

    await logger?.info?.('Waiting for the official Windows uninstaller to finish.', {
      toolId: toolState?.id || null,
      windowsUninstallKeyPath: lastContext?.entry?.keyPath || null,
    });
    await wait(OFFICIAL_UNINSTALL_SETTLE_POLL_MS);
  }

  if (!lastContext) {
    lastContext = await resolveToolUninstallContext(toolState, manifest, { refresh: true }).catch(() => null);
  }

  if (!lastDetectedTool) {
    const discoveredTools = await syncDiscoveredTools({ force: true, persist: false });
    lastDetectedTool = discoveredTools[toolState.id];
  }

  const detectedAvailable = await toolIsAvailable(lastDetectedTool);

  return {
    complete: false,
    detectedTool: lastDetectedTool,
    switchedToDetected: detectedAvailable && matchesTrackedExternalInstall(lastDetectedTool),
    uninstallContext: lastContext,
  };
}

async function getPostUninstallDetection(toolState, matchesTrackedExternalInstall) {
  const discoveredTools = await syncDiscoveredTools({ force: true, persist: false });
  const detectedTool = discoveredTools[toolState.id];
  const detectedAvailable = await toolIsAvailable(detectedTool);

  return {
    detectedAvailable,
    detectedTool,
    switchedToDetected: detectedAvailable && matchesTrackedExternalInstall(detectedTool),
  };
}

function normalizeDualCapabilityId(value) {
  const capability = String(value || '').trim().toLowerCase();
  return capability || null;
}

function assertKnownDualCapabilityId(manifest, capability) {
  if (!manifest?.companionDesktop || !capability) {
    return;
  }

  if (!['webui', 'desktop'].includes(capability)) {
    throw new Error('Local AI Hub only accepts WebUI or Desktop App as uninstall choices for this tool.');
  }
}

function getDesktopCompanionRoot(toolState) {
  return normalizeOptionalDirectoryPath(
    toolState?.desktopCompanion?.installDir ||
    toolState?.desktopCompanion?.appDir ||
    (toolState?.desktopCompanion?.detectedPath ? path.dirname(toolState.desktopCompanion.detectedPath) : '') ||
    '',
  );
}

function getWebuiCapabilityRoot(toolState) {
  return normalizeOptionalDirectoryPath(toolState?.installDir || toolState?.appDir || '');
}

function capabilitiesShareInstallPath(toolState) {
  const desktopRoot = getDesktopCompanionRoot(toolState);
  const webuiRoot = getWebuiCapabilityRoot(toolState);
  return Boolean(
    desktopRoot &&
    webuiRoot &&
    (isPathInside(webuiRoot, desktopRoot) || isPathInside(desktopRoot, webuiRoot)),
  );
}

function buildSharedCapabilityPathMessage(manifest, capability) {
  const targetLabel = capability === 'desktop' ? 'Desktop App' : 'WebUI';
  return `${manifest.name}'s ${targetLabel} shares a folder with the other install. Local AI Hub will not recursively delete or run an uninstaller against a shared folder because that could remove both capabilities. Open Windows Apps & Features or move one capability into its own folder before uninstalling it.`;
}

function buildDesktopCompanionUninstallState(toolState, baseManifest) {
  const companionManifest = baseManifest?.companionDesktop;
  const companion = toolState?.desktopCompanion || {};
  const executablePath = companion.executablePath || companion.detectedPath || null;
  const installDir = normalizeOptionalDirectoryPath(
    companion.installDir ||
    companion.appDir ||
    (executablePath ? path.dirname(executablePath) : '') ||
    '',
  );
  if (!companionManifest || !installDir || !executablePath) {
    throw new Error(`${baseManifest?.name || 'This tool'} does not have a detected Desktop App install to uninstall.`);
  }

  return normalizeToolLifecycle({
    id: toolState.id,
    name: companionManifest.name,
    source: 'external',
    installDir,
    appDir: installDir,
    detectedPath: executablePath,
    displayPath: companion.displayPath || executablePath,
    executablePath,
    installedByLocalAIHub: Boolean(companion.installedByLocalAIHub),
    windowsInstallLocation: companion.windowsInstallLocation || null,
    windowsUninstallCommand: companion.windowsUninstallCommand || null,
    windowsUninstallDisplayName: companion.windowsUninstallDisplayName || null,
    windowsUninstallKeyPath: companion.windowsUninstallKeyPath || null,
    windowsUninstallQuietCommand: companion.windowsUninstallQuietCommand || null,
  }, companionManifest);
}

function buildCompanionOnlyPreservedState(toolState, manifest) {
  const companion = toolState?.desktopCompanion || null;
  const executablePath = companion?.executablePath || companion?.detectedPath || null;
  const installDir = getDesktopCompanionRoot(toolState);
  if (!companion?.installed || !installDir || !executablePath) {
    return null;
  }

  const baseState = normalizeToolLifecycle({
    ...toolState,
    source: 'external',
    companionOnly: true,
    installDir,
    appDir: installDir,
    detectedPath: executablePath,
    displayPath: companion.displayPath || executablePath,
    executablePath,
    venvDir: null,
    desktopCompanion: companion,
    installedCapabilities: {
      webui: false,
      desktop: true,
    },
    externalInstallDetected: false,
    externalInstallDir: null,
    externalInstallDisplayPath: null,
    externalDetectedPath: null,
    lastError: null,
    lastRepairMessage: null,
    status: toolState.status === 'error' || toolState.status === 'starting' ? 'stopped' : toolState.status || 'stopped',
  }, manifest);
  const launchModeState = buildLaunchModeState(baseState, manifest, {
    detectedPath: executablePath,
    source: 'external',
  });

  return normalizeToolLifecycle({
    ...baseState,
    ...launchModeState,
    interfaceMode: launchModeState.interfaceMode || 'desktop-app',
    launchSupported: Boolean(launchModeState.launchProfile),
    processNames: manifest.processNames || launchModeState.launchModes.flatMap((mode) => mode.processNames || []) || [],
  }, manifest);
}

function buildWebuiOnlyPreservedState(toolState, manifest) {
  const baseState = normalizeToolLifecycle({
    ...toolState,
    desktopCompanion: null,
    installedCapabilities: {
      ...(toolState.installedCapabilities || {}),
      webui: true,
      desktop: false,
    },
    lastError: null,
    lastRepairMessage: null,
    status: toolState.status === 'error' || toolState.status === 'starting' ? 'stopped' : toolState.status || 'stopped',
  }, manifest);
  const launchModeState = buildLaunchModeState(baseState, manifest, {
    detectedPath: baseState.detectedPath || null,
    source: baseState.source || 'managed',
  });

  return normalizeToolLifecycle({
    ...baseState,
    ...launchModeState,
    interfaceMode: launchModeState.interfaceMode || manifest.interfaceMode,
    launchSupported: Boolean(launchModeState.launchProfile),
    processNames: manifest.processNames || launchModeState.launchModes.flatMap((mode) => mode.processNames || []) || baseState.processNames || [],
  }, manifest);
}

async function waitForCompanionDesktopUninstallOutcome(baseToolState, baseManifest, companionManifest, companionUninstallState, logger) {
  const deadline = Date.now() + OFFICIAL_UNINSTALL_SETTLE_TIMEOUT_MS;
  let lastContext = null;
  let lastDetectedTool = null;

  while (Date.now() <= deadline) {
    lastContext = await resolveToolUninstallContext(companionUninstallState, companionManifest, { refresh: true }).catch(() => null);
    const discoveredTools = await syncDiscoveredTools({ force: true, persist: false });
    lastDetectedTool = discoveredTools[baseManifest.id];
    const desktopStillDetected = Boolean(lastDetectedTool?.desktopCompanion?.installed);
    const vendorEntryStillPresent = Boolean(lastContext?.entry);

    if (!vendorEntryStillPresent && !desktopStillDetected) {
      return {
        complete: true,
        detectedTool: lastDetectedTool,
        uninstallContext: lastContext,
      };
    }

    if (Date.now() + OFFICIAL_UNINSTALL_SETTLE_POLL_MS > deadline) {
      break;
    }

    await logger?.info?.('Waiting for the official Desktop App uninstaller to finish.', {
      toolId: baseToolState?.id || null,
      windowsUninstallKeyPath: lastContext?.entry?.keyPath || null,
    });
    await wait(OFFICIAL_UNINSTALL_SETTLE_POLL_MS);
  }

  if (!lastContext) {
    lastContext = await resolveToolUninstallContext(companionUninstallState, companionManifest, { refresh: true }).catch(() => null);
  }

  if (!lastDetectedTool) {
    const discoveredTools = await syncDiscoveredTools({ force: true, persist: false });
    lastDetectedTool = discoveredTools[baseManifest.id];
  }

  return {
    complete: false,
    detectedTool: lastDetectedTool,
    uninstallContext: lastContext,
  };
}

async function refreshAfterCapabilityUninstall(toolId) {
  const discoveredTools = await syncDiscoveredTools({ force: true });
  return discoveredTools[toolId] || null;
}

async function uninstallDualWebuiCapability(safeToolState, manifest, logger, buildResultMessage) {
  if (!safeToolState.installedCapabilities?.webui) {
    throw new Error(`${manifest.name} WebUI is not installed.`);
  }

  if (safeToolState.source !== 'managed') {
    throw new Error(`${manifest.name} WebUI is not managed by Local AI Hub, so Local AI Hub will not delete its files.`);
  }

  if ((safeToolState.installedCapabilities?.desktop || safeToolState.desktopCompanion?.installed) && capabilitiesShareInstallPath(safeToolState)) {
    throw new Error(buildSharedCapabilityPathMessage(manifest, 'webui'));
  }

  const managedWebuiState = ensureManagedToolStatePaths(safeToolState);
  await logger.info('Capability-specific WebUI uninstall requested.', {
    installDir: managedWebuiState.installDir,
    toolId: managedWebuiState.id,
  });
  await preflightOwnedInstallRemoval(managedWebuiState, logger, 'managed-webui-capability-uninstall-preflight', 'uninstall WebUI');
  await removeOwnedInstallCopy(managedWebuiState, logger, 'managed-webui-capability-uninstall');
  const modelAssetCleanup = await removeManagedModelManagerAssets(managedWebuiState, logger, 'managed-webui-capability-uninstall-model-assets');
  const shortcutCleanup = await removeToolWindowsShortcuts(managedWebuiState, logger);
  const preservedCompanion = buildCompanionOnlyPreservedState(managedWebuiState, manifest);

  if (preservedCompanion) {
    await upsertTool(preservedCompanion);
  } else {
    await removeTool(managedWebuiState.id);
  }

  await setToolIgnored(managedWebuiState.id, false);
  const refreshedTool = await refreshAfterCapabilityUninstall(managedWebuiState.id);
  if (refreshedTool?.installedCapabilities?.desktop) {
    return {
      ...refreshedTool,
      lastError: null,
      status: refreshedTool.status || 'stopped',
      uninstallMessage: buildResultMessage(`${manifest.name} WebUI was uninstalled. The Desktop App was preserved.`, {
        removedModelAssetRootCount: modelAssetCleanup.removedModelAssetRootCount,
        removedShortcutCount: shortcutCleanup.removedCount,
      }),
    };
  }

  await removeTool(managedWebuiState.id);
  return {
    ...managedWebuiState,
    lastError: null,
    status: 'stopped',
    uninstallMessage: buildResultMessage(`${manifest.name} WebUI was uninstalled and no Desktop App was detected afterward.`, {
      removedModelAssetRootCount: modelAssetCleanup.removedModelAssetRootCount,
      removedShortcutCount: shortcutCleanup.removedCount,
    }),
  };
}

async function uninstallDualDesktopCapability(safeToolState, manifest, logger, clearStaleEntries) {
  const companionManifest = manifest.companionDesktop;
  if (!safeToolState.installedCapabilities?.desktop && !safeToolState.desktopCompanion?.installed) {
    throw new Error(`${companionManifest.name} is not installed.`);
  }

  if (safeToolState.installedCapabilities?.webui && capabilitiesShareInstallPath(safeToolState)) {
    throw new Error(buildSharedCapabilityPathMessage(manifest, 'desktop'));
  }

  const companionUninstallState = buildDesktopCompanionUninstallState(safeToolState, manifest);
  const uninstallContext = await resolveToolUninstallContext(companionUninstallState, companionManifest, { refresh: true }).catch(() => null);
  const staleCleanup = await clearStaleEntries(uninstallContext?.staleEntries || []);
  const refreshedContext = await resolveToolUninstallContext(companionUninstallState, companionManifest, { refresh: true }).catch(() => null);
  const workingUninstallEntry = refreshedContext?.entry || uninstallContext?.entry || null;

  if (!workingUninstallEntry) {
    const refreshedTool = await refreshAfterCapabilityUninstall(safeToolState.id);
    if (!refreshedTool?.desktopCompanion?.installed) {
      if (refreshedTool?.installedCapabilities?.webui) {
        return {
          ...refreshedTool,
          lastError: null,
          uninstallMessage: `${companionManifest.name} was already gone. Local AI Hub refreshed ${manifest.name} so only WebUI remains.`,
        };
      }

      await removeTool(safeToolState.id);
      await setToolIgnored(safeToolState.id, false);
      return {
        ...safeToolState,
        lastError: null,
        status: 'stopped',
        uninstallMessage: `${companionManifest.name} was already gone, so Local AI Hub removed ${manifest.name} from Library.`,
      };
    }

    const staleNote = staleCleanup.clearedCount > 0
      ? ` Local AI Hub cleared ${staleCleanup.clearedCount} stale Windows uninstall ${pluralize(staleCleanup.clearedCount, 'entry')} first.`
      : '';
    throw new Error(`${companionManifest.name} does not expose a safe Windows uninstall command Local AI Hub can run.${staleNote} Open Windows Apps & Features, uninstall ${companionManifest.name}, then refresh Local AI Hub. The WebUI folder was left untouched.`);
  }

  await logger.info('Capability-specific Desktop App official uninstall requested.', {
    baseToolId: safeToolState.id,
    companionName: companionManifest.name,
    desktopInstallDir: companionUninstallState.installDir,
    webuiInstallDir: safeToolState.installDir || null,
    windowsUninstallKeyPath: workingUninstallEntry.keyPath || null,
  });

  await runWindowsUninstaller(workingUninstallEntry, logger, companionManifest.name);
  const uninstallOutcome = await waitForCompanionDesktopUninstallOutcome(
    safeToolState,
    manifest,
    companionManifest,
    companionUninstallState,
    logger,
  );

  if (!uninstallOutcome.complete) {
    throw new Error(`${companionManifest.name} still appears to be installed after its official Windows uninstaller finished. Open Windows Apps & Features to finish removing it, then refresh Local AI Hub. The WebUI folder was left untouched.`);
  }

  await clearStaleEntries(uninstallOutcome.uninstallContext?.staleEntries || []);
  if (safeToolState.installedCapabilities?.webui) {
    const webuiOnlyState = buildWebuiOnlyPreservedState(safeToolState, manifest);
    await upsertTool(webuiOnlyState);
    await setToolIgnored(safeToolState.id, false);
    const refreshedTool = await refreshAfterCapabilityUninstall(safeToolState.id);
    return {
      ...(refreshedTool || webuiOnlyState),
      lastError: null,
      uninstallMessage: `${companionManifest.name} was uninstalled with its official Windows uninstaller. ${manifest.name} WebUI was preserved.`,
    };
  }

  await removeTool(safeToolState.id);
  await setToolIgnored(safeToolState.id, false);
  return {
    ...safeToolState,
    lastError: null,
    status: 'stopped',
    uninstallMessage: `${companionManifest.name} was uninstalled with its official Windows uninstaller.`,
  };
}
async function uninstallTool(toolState, options = {}) {
  await initializeToolRegistry();
  const manifest = getToolManifest(toolState?.id);
  if (!manifest) {
    throw new Error('Local AI Hub could not find the tool definition for uninstall.');
  }

  let safeToolState = normalizeToolLifecycle(toolState, manifest);
  if (safeToolState.source === 'managed') {
    safeToolState = ensureManagedToolStatePaths(safeToolState);
  }

  const capability = normalizeDualCapabilityId(options.capability || options.installCapability || '');
  assertKnownDualCapabilityId(manifest, capability);

  const actionSemantics = getToolActionSemantics(safeToolState, manifest, {
    installedByLocalAIHub: safeToolState.installedByLocalAIHub,
    lifecycleMode: safeToolState.lifecycleMode,
  });
  const logger = createLogger('installer', {
    toolId: safeToolState.id,
    toolName: manifest.name,
    mode: 'uninstall',
  });
  const normalizeComparablePath = (value) => {
    const normalized = normalizeOptionalDirectoryPath(value);
    return normalized ? normalized.toLowerCase() : '';
  };
  const matchesTrackedExternalInstall = (detectedTool) => {
    const expectedExternalPath = normalizeComparablePath(
      safeToolState.externalInstallDir || safeToolState.externalInstallDisplayPath || '',
    );
    const detectedPath = normalizeComparablePath(
      detectedTool?.installDir || detectedTool?.displayPath || detectedTool?.detectedPath || '',
    );
    return Boolean(expectedExternalPath) && Boolean(detectedPath) && expectedExternalPath === detectedPath;
  };
  const clearStaleEntries = async (entries = []) => {
    let clearedCount = 0;
    const failedEntries = [];

    for (const staleEntry of entries) {
      try {
        await removeWindowsUninstallEntry(staleEntry.entry);
        clearedCount += 1;
      } catch (error) {
        failedEntries.push(staleEntry);
        await logger.warn('Local AI Hub could not remove a stale Windows uninstall entry.', {
          error,
          keyPath: staleEntry?.entry?.keyPath || null,
        });
      }
    }

    return {
      clearedCount,
      failedEntries,
    };
  };
  const reconcileWindowsUninstallState = async () => {
    const refreshedContext = await resolveToolUninstallContext(safeToolState, manifest, { refresh: true }).catch(() => null);
    const staleCleanup = await clearStaleEntries(refreshedContext?.staleEntries || []);
    const finalContext = await resolveToolUninstallContext(safeToolState, manifest, { refresh: true }).catch(() => null);
    return {
      clearedWindowsEntries: staleCleanup.clearedCount,
      failedEntries: staleCleanup.failedEntries,
      uninstallContext: finalContext,
    };
  };

  try {
    const buildCapabilityResultMessage = (baseMessage, artifactCleanup = null) =>
      appendUninstallFollowup(
        baseMessage,
        buildUninstallFollowupNotes({
          deferredCleanupCount: Number(artifactCleanup?.deferredCleanupCount || 0),
          removedShortcutCount: Number(artifactCleanup?.removedShortcutCount || 0),
          removedModelAssetRootCount: Number(artifactCleanup?.removedModelAssetRootCount || 0),
        }),
      );

    if (manifest.companionDesktop && capability === 'webui') {
      return await uninstallDualWebuiCapability(safeToolState, manifest, logger, buildCapabilityResultMessage);
    }

    if (manifest.companionDesktop && capability === 'desktop') {
      return await uninstallDualDesktopCapability(safeToolState, manifest, logger, clearStaleEntries);
    }

    const uninstallContext =
      actionSemantics.ownsInstallFiles || manifest.installInstructions.kind === 'installer-exe'
        ? await resolveToolUninstallContext(safeToolState, manifest, { refresh: true }).catch(() => null)
        : null;
    const hadBrokenWindowsEntries = Boolean(
      (uninstallContext?.staleEntries || []).length || (uninstallContext?.brokenEntries || []).length,
    );
    const preflightWindowsReconciliation =
      actionSemantics.uninstallKind === 'remove-from-library'
        ? null
        : await reconcileWindowsUninstallState();
    const preflightClearedWindowsEntries = preflightWindowsReconciliation?.clearedWindowsEntries || 0;
    const preflightUninstallContext = preflightWindowsReconciliation?.uninstallContext || uninstallContext;
    const buildResultMessage = (baseMessage, artifactCleanup = null, windowsReconciliation = null, options = {}) =>
      appendUninstallFollowup(
        baseMessage,
        buildUninstallFollowupNotes({
          clearedWindowsEntries: preflightClearedWindowsEntries + Number(windowsReconciliation?.clearedWindowsEntries || 0),
          deferredCleanupCount: Number(artifactCleanup?.deferredCleanupCount || 0),
          removedShortcutCount: Number(artifactCleanup?.removedShortcutCount || 0),
          removedModelAssetRootCount: Number(artifactCleanup?.removedModelAssetRootCount || 0),
        }),
        {
          lingeringWindowsEntry: Boolean(options.lingeringWindowsEntry),
          remainingStaleWindowsEntries: countRemainingStaleWindowsEntries(
            windowsReconciliation?.uninstallContext || preflightUninstallContext,
          ),
        },
      );

    if (actionSemantics.uninstallKind === 'uninstall') {
      await logger.info('Direct Local AI Hub-managed uninstall requested.', {
        installDir: safeToolState.installDir,
      });

      await preflightOwnedInstallRemoval(safeToolState, logger, 'managed-uninstall-preflight', 'uninstall');
      if (preflightUninstallContext?.entry) {
        throw new Error(buildWindowsUninstallUnresolvedMessage(manifest, preflightUninstallContext));
      }

      await removeOwnedInstallCopy(safeToolState, logger, 'managed-uninstall');
      const modelAssetCleanup = await removeManagedModelManagerAssets(safeToolState, logger, 'managed-uninstall-model-assets');
      const shortcutCleanup = await removeToolWindowsShortcuts(safeToolState, logger);

      await removeTool(safeToolState.id);
      await setToolIgnored(safeToolState.id, false);
      const postUninstallDetection = await getPostUninstallDetection(safeToolState, matchesTrackedExternalInstall);
      if (postUninstallDetection.detectedAvailable) {
        const detectedPath =
          postUninstallDetection.detectedTool?.displayPath ||
          postUninstallDetection.detectedTool?.installDir ||
          postUninstallDetection.detectedTool?.detectedPath ||
          'another detected install';
        return {
          ...safeToolState,
          lastError: null,
          status: 'stopped',
          uninstallMessage: buildResultMessage(
            `${manifest.name}'s Local AI Hub-managed copy was removed. A separate install at ${detectedPath} is still available, so Local AI Hub switched back to showing it as a detected install.`,
            { removedModelAssetRootCount: modelAssetCleanup.removedModelAssetRootCount, removedShortcutCount: shortcutCleanup.removedCount },
          ),
        };
      }

      return {
        ...safeToolState,
        lastError: null,
        status: 'stopped',
        uninstallMessage: buildResultMessage(`${manifest.name} was uninstalled and moved back to Store.`, { removedModelAssetRootCount: modelAssetCleanup.removedModelAssetRootCount, removedShortcutCount: shortcutCleanup.removedCount }),
      };
    }

    if (actionSemantics.uninstallKind === 'official-uninstall') {
      await logger.info('Official-installer uninstall requested.', {
        installDir: safeToolState.installDir || null,
        windowsUninstallKeyPath: preflightUninstallContext?.entry?.keyPath || uninstallContext?.entry?.keyPath || null,
      });

      const workingUninstallEntry = preflightUninstallContext?.entry || uninstallContext?.entry || null;
      if (workingUninstallEntry) {
        await runWindowsUninstaller(workingUninstallEntry, logger, manifest.name);
        const uninstallOutcome = await waitForOfficialUninstallOutcome(
          safeToolState,
          manifest,
          matchesTrackedExternalInstall,
          logger,
        );

        if (!uninstallOutcome.complete) {
          throw new Error(
            `${manifest.name} still appears to be installed after its official Windows uninstall finished. Open Windows Apps & Features to check whether the installer reported a problem.`,
          );
        }

        const artifactCleanup = await cleanupOwnedToolArtifacts(safeToolState, logger, 'official-uninstall-cleanup', {
          allowBusyInstallDirFailure: true,
        });
        const windowsReconciliation = await reconcileWindowsUninstallState();
        const postUninstallDetection = await getPostUninstallDetection(safeToolState, matchesTrackedExternalInstall);
        const lingeringWindowsEntry = Boolean(windowsReconciliation.uninstallContext?.entry);

        if (lingeringWindowsEntry && postUninstallDetection.detectedAvailable && !postUninstallDetection.switchedToDetected) {
          throw new Error(buildWindowsUninstallUnresolvedMessage(manifest, windowsReconciliation.uninstallContext));
        }

        await removeTool(safeToolState.id);
        await setToolIgnored(safeToolState.id, false);

        if (postUninstallDetection.switchedToDetected || uninstallOutcome.switchedToDetected) {
          const detectedTool = postUninstallDetection.switchedToDetected ? postUninstallDetection.detectedTool : uninstallOutcome.detectedTool;
          const detectedPath =
            detectedTool?.displayPath ||
            detectedTool?.installDir ||
            detectedTool?.detectedPath ||
            'another detected install';
          return {
            ...safeToolState,
            lastError: null,
            status: 'stopped',
            uninstallMessage: buildResultMessage(
              `${manifest.name}'s official uninstall finished. A separate install at ${detectedPath} is still available, so Local AI Hub switched back to showing it as a detected install.`,
              artifactCleanup,
              windowsReconciliation,
              {
                lingeringWindowsEntry,
              },
            ),
          };
        }

        return {
          ...safeToolState,
          lastError: null,
          status: 'stopped',
          uninstallMessage: buildResultMessage(
            artifactCleanup.deferredCleanupCount > 0
              ? `${manifest.name}'s official uninstall finished, but Local AI Hub could not remove every leftover file yet.`
              : `${manifest.name} was uninstalled with its official Windows uninstaller.`,
            artifactCleanup,
            windowsReconciliation,
            {
              lingeringWindowsEntry,
            },
          ),
        };
      }

      if (safeToolState.source === 'managed') {
        await preflightOwnedInstallRemoval(safeToolState, logger, 'official-uninstall-fallback-preflight', 'official uninstall');
        const artifactCleanup = await cleanupOwnedToolArtifacts(safeToolState, logger, 'official-uninstall-fallback');
        const windowsReconciliation = await reconcileWindowsUninstallState();
        const postUninstallDetection = await getPostUninstallDetection(safeToolState, matchesTrackedExternalInstall);
        const lingeringWindowsEntry = Boolean(windowsReconciliation.uninstallContext?.entry);

        if (postUninstallDetection.detectedAvailable && !postUninstallDetection.switchedToDetected) {
          throw new Error(buildWindowsUninstallUnresolvedMessage(manifest, windowsReconciliation.uninstallContext || preflightUninstallContext));
        }

        await removeTool(safeToolState.id);
        await setToolIgnored(safeToolState.id, false);

        if (postUninstallDetection.switchedToDetected) {
          const detectedPath =
            postUninstallDetection.detectedTool?.displayPath ||
            postUninstallDetection.detectedTool?.installDir ||
            postUninstallDetection.detectedTool?.detectedPath ||
            'another detected install';
          return {
            ...safeToolState,
            lastError: null,
            status: 'stopped',
            uninstallMessage: buildResultMessage(
              `${manifest.name}'s Windows uninstall data was not usable, so Local AI Hub removed the Local AI Hub-owned files it still controlled and switched back to a separate detected install at ${detectedPath}.`,
              artifactCleanup,
              windowsReconciliation,
              {
                lingeringWindowsEntry,
              },
            ),
          };
        }

        const baseMessage = hadBrokenWindowsEntries
          ? `${manifest.name}'s Windows uninstall entry was broken, so Local AI Hub removed the remaining app files it still owned instead of claiming the official uninstaller ran.`
          : `${manifest.name}'s Windows uninstall data was missing, so Local AI Hub only removed the app files and shortcuts it still owned.`;

        return {
          ...safeToolState,
          lastError: null,
          status: 'stopped',
          uninstallMessage: buildResultMessage(baseMessage, artifactCleanup, windowsReconciliation, {
            lingeringWindowsEntry,
          }),
        };
      }

      const windowsReconciliation = preflightWindowsReconciliation || (await reconcileWindowsUninstallState());
      const postUninstallDetection = await getPostUninstallDetection(safeToolState, matchesTrackedExternalInstall);
      const lingeringWindowsEntry = Boolean(windowsReconciliation.uninstallContext?.entry);

      if (postUninstallDetection.detectedAvailable) {
        if (lingeringWindowsEntry) {
          throw new Error(buildWindowsUninstallUnresolvedMessage(manifest, windowsReconciliation.uninstallContext));
        }

        throw new Error(
          `Local AI Hub could not find a working Windows uninstall entry for ${manifest.name}. Reinstall it or remove it from Windows Apps & Features, then try again.`,
        );
      }

      await removeTool(safeToolState.id);
      await setToolIgnored(safeToolState.id, false);
      return {
        ...safeToolState,
        lastError: null,
        status: 'stopped',
        uninstallMessage: buildResultMessage(
          windowsReconciliation.clearedWindowsEntries > 0
            ? `${manifest.name} is already gone. Local AI Hub cleared the stale Windows uninstall entry and removed it from Library.`
            : `${manifest.name} is already gone, so Local AI Hub removed it from Library.`,
          null,
          windowsReconciliation,
          {
            lingeringWindowsEntry,
          },
        ),
      };
    }

    await logger.info('External install was removed from Local AI Hub tracking only.', {
      installDir: safeToolState.installDir || null,
      displayPath: safeToolState.displayPath || null,
    });
    await removeTool(safeToolState.id);
    await setToolIgnored(safeToolState.id, true);
    return {
      ...safeToolState,
      lastError: null,
      status: 'stopped',
      uninstallMessage:
        `${manifest.name} was removed from Local AI Hub. Its files were not deleted because Local AI Hub does not own that install.`,
    };
  } catch (error) {
    await logger.error('Uninstall failed.', {
      error,
      readableMessage: humanizeError(error, `Local AI Hub could not uninstall ${manifest.name}.`),
    });
    throw error;
  }
}
async function extractArchiveToDirectory(archivePath, targetDirectory, logger) {
  const extractionRoot = `${targetDirectory}__extract`;
  await logger.info('Extracting update archive into a staging folder.', {
    archivePath,
    targetDirectory,
  });

  await fs.remove(extractionRoot).catch(() => null);
  await fs.ensureDir(extractionRoot);

  const extension = path.extname(archivePath).toLowerCase();
  if (extension === '.7z') {
    const sevenZipPath = app.isPackaged
      ? path.join(process.resourcesPath, 'bin', '7za.exe')
      : path.join(__dirname, '..', '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

    if (!(await fs.pathExists(sevenZipPath))) {
      throw new Error('Local AI Hub is missing its 7-Zip helper and could not unpack that update package.');
    }

    await runCommand(sevenZipPath, ['x', archivePath, '-y', `-o${extractionRoot}`], {
      cwd: path.dirname(archivePath),
      errorMessage: 'Local AI Hub could not unpack the update package.',
    });
  } else {
    await extract(archivePath, { dir: extractionRoot });
  }

  const entries = await fs.readdir(extractionRoot).catch(() => []);
  const firstEntryPath = entries.length === 1 ? path.join(extractionRoot, entries[0]) : null;
  const hasSingleRoot = firstEntryPath && (await fs.stat(firstEntryPath)).isDirectory() && entries.length === 1;

  await fs.remove(targetDirectory).catch(() => null);
  if (hasSingleRoot) {
    await fs.move(firstEntryPath, targetDirectory, { overwrite: true });
    await fs.remove(extractionRoot).catch(() => null);
    return targetDirectory;
  }

  await fs.move(extractionRoot, targetDirectory, { overwrite: true });
  return targetDirectory;
}

async function mergeDirectoryContents(sourceDirectory, targetDirectory) {
  await fs.ensureDir(targetDirectory);
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const targetPath = path.join(targetDirectory, entry.name);

    if (entry.isDirectory()) {
      await mergeDirectoryContents(sourcePath, targetPath);
      continue;
    }

    await fs.ensureDir(path.dirname(targetPath));
    await fs.copy(sourcePath, targetPath, { overwrite: true });
  }
}

async function refreshAppDirectoryFromArchive(archivePath, targetDirectory, logger) {
  const stagingDirectory = `${targetDirectory}__update`;
  await extractArchiveToDirectory(archivePath, stagingDirectory, logger);
  await mergeDirectoryContents(stagingDirectory, targetDirectory);
  await fs.remove(stagingDirectory).catch(() => null);
}

async function updateToolInstallation(toolState, options = {}) {
  await initializeToolRegistry();
  const manifest = getToolManifest(toolState?.id);
  if (!manifest) {
    throw new Error('Local AI Hub could not find the tool definition for update.');
  }

  const logger = createLogger('installer', {
    toolId: toolState.id,
    toolName: manifest.name,
    mode: 'update',
  });

  try {
    const installRoot = resolveStoredInstallRoot(toolState, options.installRoot || null);
    const installKind = manifest.installInstructions.kind || 'zip';
    const runtimeKind = getToolRuntime(manifest);
    const managedPaths = buildManagedPaths(manifest, { installRoot });
    const usesGuidedOfficialInstaller = isGuidedOfficialInstallerManifest(manifest);
    const isManagedInstall = toolState.source === 'managed' && !usesGuidedOfficialInstaller;
    const safeToolState = isManagedInstall ? ensureManagedToolStatePaths(toolState) : { ...toolState };
    let updateEntry = await getCachedToolUpdateEntry(toolState.id).catch(() => null);

    if (updateEntry?.availableVersion && isPinnedGitHubReleaseAsset(manifest.downloadUrl) && !String(updateEntry.downloadUrl || '').trim()) {
      await refreshInstalledToolUpdates([safeToolState]).catch(() => null);
      updateEntry = await getCachedToolUpdateEntry(toolState.id).catch(() => null);
    }

    const expectedVersion = normalizeVersionText(updateEntry?.availableVersion || '');
    const previousVersion = normalizeVersionText(safeToolState.installedVersion || updateEntry?.currentVersion || '');
    const downloadManifest = resolveUpdateManifest(manifest, updateEntry);

    if (!isManagedInstall && runtimeKind === 'python') {
      throw new Error('Local AI Hub can update externally installed Python tools after they are reinstalled into Local AI Hub-managed storage.');
    }

    const downloadCachePath = resolveUpdateDownloadCachePath(safeToolState, managedPaths, updateEntry);

    await advanceStep(logger, options.onProgress, {
      toolId: safeToolState.id,
      percent: 6,
      stage: 'preparing',
      message: `Preparing the latest ${manifest.name} update.`,
    });

    if (installKind !== 'pip-package') {
      await fs.remove(downloadCachePath).catch(() => null);
      await ensureCachedDownload(downloadManifest, downloadCachePath, logger, options.onProgress, safeToolState.id);
    }

    let updatedState = {
      ...safeToolState,
      downloadCachePath,
    };
    let resolvedInstalledVersion = '';

    if (installKind === 'single-file') {
      const downloadFileName = manifest.installInstructions.downloadFileName || path.basename(downloadCachePath) || `${manifest.id}.exe`;
      const targetDirectory = safeToolState.appDir || safeToolState.installDir || managedPaths.appDir;
      const destinationPath = path.join(targetDirectory, downloadFileName);

      await advanceStep(logger, options.onProgress, {
        toolId: safeToolState.id,
        percent: 55,
        stage: 'updating',
        message: `Copying the latest ${manifest.name} build into place.`,
      });

      await fs.ensureDir(targetDirectory);
      await fs.copy(downloadCachePath, destinationPath, { overwrite: true });
      updatedState = {
        ...updatedState,
        appDir: targetDirectory,
        executablePath: destinationPath,
      };
      resolvedInstalledVersion = normalizeVersionText(updatedState.installedVersion || expectedVersion || '');
    } else if (installKind === 'installer-exe') {
      const installDir = safeToolState.installDir || managedPaths.installDir;
      const appDir = safeToolState.appDir || safeToolState.installDir || managedPaths.appDir;

      await advanceStep(logger, options.onProgress, {
        toolId: safeToolState.id,
        percent: 55,
        stage: 'updating',
        message: `Running the latest ${manifest.name} installer.`,
      });

      const materializedUpdate = await updateExecutableInstallerTool(
        downloadManifest,
        {
          appDir,
          archivePath: downloadCachePath,
          installDir,
          venvDir: safeToolState.venvDir || managedPaths.venvDir,
        },
        {
          errorMessage: `Local AI Hub could not run the ${manifest.name} updater.`,
          expectManagedInstall: isManagedInstall,
          expectedVersion,
          logger,
          previousVersion,
        },
      );
      updatedState = {
        ...updatedState,
        ...materializedUpdate.toolState,
        downloadCachePath,
      };
      if (usesGuidedOfficialInstaller && !isManagedInstall) {
        const discoveredTools = await syncDiscoveredTools({ force: true });
        const detectedTool = discoveredTools[manifest.id];
        if (detectedTool) {
          updatedState = {
            ...updatedState,
            ...detectedTool,
            downloadCachePath,
          };
        }
      }
      resolvedInstalledVersion = normalizeVersionText(materializedUpdate.detectedVersion || updatedState.installedVersion || '');
      if (materializedUpdate.detectionWarning) {
        updatedState.lastUpdateMessage = materializedUpdate.detectionWarning;
      }
    } else if (installKind === 'pip-package') {
      const pythonResolution = await resolveManagedPythonRuntime(
        safeToolState.appDir || managedPaths.appDir,
        manifest,
        logger,
        options.onProgress,
        safeToolState.id,
      );
      updatedState = createManagedToolState(
        manifest,
        safeToolState.installDir || managedPaths.installDir,
        safeToolState.appDir || managedPaths.appDir,
        safeToolState.venvDir || managedPaths.venvDir,
        downloadCachePath,
        pythonResolution,
      );
      if (updatedState.venvDir) {
        await fs.remove(updatedState.venvDir).catch(() => null);
      }

      await advanceStep(logger, options.onProgress, {
        toolId: safeToolState.id,
        percent: 48,
        stage: 'updating',
        message: `Refreshing ${manifest.name} inside its Python environment.`,
      });

      await installPythonDependencies(updatedState, manifest, options.onProgress, logger, pythonResolution.runtime);
      resolvedInstalledVersion = normalizeVersionText(updatedState.installedVersion || expectedVersion || '');
    } else {
      const targetDirectory = safeToolState.appDir || safeToolState.installDir || managedPaths.appDir;
      await advanceStep(logger, options.onProgress, {
        toolId: safeToolState.id,
        percent: 45,
        stage: 'updating',
        message: `Expanding the latest ${manifest.name} files.`,
      });
      await refreshAppDirectoryFromArchive(downloadCachePath, targetDirectory, logger);
      updatedState = {
        ...updatedState,
        appDir: targetDirectory,
      };

      if (isManagedInstall && runtimeKind === 'python') {
        const pythonResolution = await resolveManagedPythonRuntime(
          targetDirectory,
          manifest,
          logger,
          options.onProgress,
          safeToolState.id,
        );
        updatedState = createManagedToolState(
          manifest,
          safeToolState.installDir || managedPaths.installDir,
          targetDirectory,
          safeToolState.venvDir || managedPaths.venvDir,
          downloadCachePath,
          pythonResolution,
        );
        if (updatedState.venvDir) {
          await fs.remove(updatedState.venvDir).catch(() => null);
        }
        await installPythonDependencies(updatedState, manifest, options.onProgress, logger, pythonResolution.runtime);
      }

      resolvedInstalledVersion = normalizeVersionText(updatedState.installedVersion || expectedVersion || '');
    }

    if (isManagedInstall && runtimeKind !== 'python' && installKind !== 'pip-package') {
      const refreshedManagedState = createManagedToolState(
        manifest,
        safeToolState.installDir || managedPaths.installDir,
        updatedState.appDir || safeToolState.appDir || managedPaths.appDir,
        safeToolState.venvDir || managedPaths.venvDir,
        downloadCachePath,
        null,
      );
      updatedState = {
        ...refreshedManagedState,
        ...updatedState,
      };
    }

    const updateCompleteMessage = `Local AI Hub updated ${manifest.name}.`;

    updatedState = {
      ...updatedState,
      ...(resolvedInstalledVersion ? { installedVersion: resolvedInstalledVersion } : {}),
      downloadCachePath,
      lastError: null,
      lastRepairMessage: null,
      lastUpdateMessage: null,
      status: 'stopped',
    };

    if (isManagedInstall) {
      updatedState = ensureManagedToolStatePaths(normalizeToolLifecycle({
        ...updatedState,
        source: 'managed',
        installedByLocalAIHub: updatedState.installedByLocalAIHub !== false,
      }, manifest));

      if (runtimeKind === 'python') {
        updatedState = await verifyManagedToolInstall(updatedState, manifest, logger);
      }
    }

    await upsertTool(updatedState);
    await refreshInstalledToolUpdates([updatedState]).catch(() => null);

    await advanceStep(logger, options.onProgress, {
      toolId: safeToolState.id,
      percent: 100,
      stage: 'complete',
      message: updateCompleteMessage,
    });

    return {
      ...updatedState,
      lastUpdateMessage: updateCompleteMessage,
    };
  } catch (error) {
    const readableMessage = humanizeError(error, `Local AI Hub could not update ${manifest.name}.`);
    const failedState = toolState?.source === 'managed'
      ? ensureManagedToolStatePaths(toolState)
      : { ...(toolState || {}) };

    if (failedState?.id) {
      await upsertTool({
        ...failedState,
        lastError: readableMessage,
        lastUpdateMessage: null,
        status: failedState.status === 'running' ? 'running' : 'error',
      }).catch(() => null);
      await refreshInstalledToolUpdates([failedState]).catch(() => null);
    }

    await logger.error('Update failed.', {
      error,
      readableMessage,
    });
    throw error;
  }
}
module.exports = {
  getToolInstallPreflight,
  inspectToolRepair,
  installTool,
  repairToolInstallation,
  uninstallTool,
  updateToolInstallation,
  _test: {
    buildComfyUiDependencyFailureMessage,
    buildComfyUiDependencyVerificationScript,
    buildCompanionOnlyPreservedState,
    buildDesktopCompanionUninstallState,
    buildManagedCudaPyTorchPackageSpec,
    buildManagedCudaPyTorchUnsupportedMessage,
    buildWebuiOnlyPreservedState,
    capabilitiesShareInstallPath,
    buildFilteredRequirementsPath,
    buildIncompleteUpdateVersionMessage,
    buildOfficialDesktopUpdateVerificationLagMessage,
    buildUnverifiedExternalUpdateMessage,
    detectOfficialDesktopUpdateToolState,
    ensureManagedToolStatePaths,
    officialDesktopUpdateStateIsApproved,
    collectManagedModelAssetRootsForUninstall,
    collectRepairPreservedModelAssetRoots,
    normalizeDualCapabilityId,
    preserveModelManagerAssetsForAction,
    removeManagedModelManagerAssets,
    selectManagedCudaPyTorchBuild,
    isGuidedOfficialInstallerManifest,
  },
};
