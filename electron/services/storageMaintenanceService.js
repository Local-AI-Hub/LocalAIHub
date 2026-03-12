const path = require('path');
const fs = require('fs-extra');

const { getAppPaths, readConfig } = require('./configService');
const { assessDiskSpace, getDiskSnapshotForPath } = require('./hardwareService');

const TEMP_FILE_PATTERNS = [/\.download$/i, /\.part$/i, /\.partial$/i, /\.tmp$/i, /\.temp$/i];
const TEMP_DIRECTORY_PATTERNS = [/__extract$/i, /__restore$/i, /\.tmp$/i, /\.temp$/i, /^tmp$/i];
const RETRYABLE_REMOVE_ERROR_CODES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);
const REMOVE_RETRY_DELAYS_MS = [400, 1000, 2000, 4000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeInstallPathKey(targetPath) {
  if (!targetPath) {
    return '';
  }

  const resolvedPath = path.resolve(String(targetPath || ''));
  return resolvedPath.replace(/[\\/]+$/, '').toLowerCase();
}

function normalizeManagedRootPath(targetPath) {
  const resolvedPath = path.resolve(String(targetPath || ''));
  return path.basename(resolvedPath).toLowerCase() === 'app' ? path.dirname(resolvedPath) : resolvedPath;
}

function normalizeAliasToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function uniqueEntries(entries = []) {
  const seen = new Set();
  const results = [];

  for (const entry of entries) {
    const key = normalizeInstallPathKey(entry?.path || entry);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(typeof entry === 'string' ? { path: entry } : entry);
  }

  return results;
}

async function calculatePathSize(targetPath) {
  if (!(await fs.pathExists(targetPath))) {
    return 0;
  }

  const stats = await fs.stat(targetPath);
  if (stats.isFile()) {
    return stats.size;
  }

  if (!stats.isDirectory()) {
    return 0;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
  let total = 0;

  for (const entry of entries) {
    total += await calculatePathSize(path.join(targetPath, entry.name));
  }

  return total;
}

async function buildEntry(targetPath, reason) {
  return {
    path: targetPath,
    reason,
    sizeBytes: await calculatePathSize(targetPath),
  };
}

function getToolAliasTokens(manifest, toolState) {
  return new Set(
    [
      manifest?.id,
      manifest?.name,
      path.basename(toolState?.installDir || ''),
      ...(manifest?.discovery?.folderNames || []),
    ]
      .map((entry) => normalizeAliasToken(entry))
      .filter(Boolean),
  );
}

async function pathLooksLikeToolInstall(candidatePath, manifest) {
  const markerPaths = [
    ...(manifest?.discovery?.markerPaths || []),
    ...(manifest?.installInstructions?.externalExecutableCandidates || []),
    ...(manifest?.installInstructions?.externalBatchCandidates || []),
  ].filter(Boolean);

  const candidateRoots = [candidatePath, path.join(candidatePath, 'app')];
  for (const root of candidateRoots) {
    for (const markerPath of markerPaths) {
      if (await fs.pathExists(path.join(root, markerPath))) {
        return true;
      }
    }
  }

  return false;
}

async function listTrackedManagedInstallKeys() {
  const config = await readConfig();
  return new Set(
    Object.values(config.tools || {})
      .filter((tool) => tool && (tool.source === 'managed' || tool.managedByLocalAIHub))
      .map((tool) => normalizeInstallPathKey(normalizeManagedRootPath(tool.installDir || tool.appDir || '')))
      .filter(Boolean),
  );
}

async function collectDuplicateToolFolders(toolState, manifest, toolsRoot, trackedManagedInstallKeys) {
  if (!(await fs.pathExists(toolsRoot))) {
    return [];
  }

  const aliasTokens = getToolAliasTokens(manifest, toolState);
  const activeInstallKey = normalizeInstallPathKey(normalizeManagedRootPath(toolState.installDir || toolState.appDir || ''));
  const entries = await fs.readdir(toolsRoot, { withFileTypes: true }).catch(() => []);
  const duplicates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidatePath = path.join(toolsRoot, entry.name);
    const candidateKey = normalizeInstallPathKey(candidatePath);
    if (!candidateKey || candidateKey === activeInstallKey || trackedManagedInstallKeys.has(candidateKey)) {
      continue;
    }

    const nameLooksRelated = aliasTokens.has(normalizeAliasToken(entry.name));
    if (!nameLooksRelated && !(await pathLooksLikeToolInstall(candidatePath, manifest))) {
      continue;
    }

    duplicates.push(await buildEntry(candidatePath, 'duplicate-install-folder'));
  }

  return uniqueEntries(duplicates);
}

async function collectTemporaryArtifacts(rootPath, reason, depthRemaining = 4) {
  if (!rootPath || !(await fs.pathExists(rootPath)) || depthRemaining < 0) {
    return [];
  }

  const stats = await fs.stat(rootPath).catch(() => null);
  if (!stats?.isDirectory()) {
    return [];
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  const results = [];

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isFile()) {
      if (TEMP_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        results.push(await buildEntry(entryPath, reason));
      }
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    if (TEMP_DIRECTORY_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      results.push(await buildEntry(entryPath, reason));
      continue;
    }

    results.push(...(await collectTemporaryArtifacts(entryPath, reason, depthRemaining - 1)));
  }

  return results;
}

async function collectRepairArtifacts(toolState) {
  const { downloadsRoot } = getAppPaths();
  const managedTool = toolState?.source === 'managed' || toolState?.managedByLocalAIHub;
  const searchRoots = [
    managedTool ? toolState?.installDir : null,
    managedTool ? toolState?.appDir : null,
    managedTool && toolState?.installDir ? `${toolState.installDir}__extract` : null,
    managedTool && toolState?.appDir ? `${toolState.appDir}__extract` : null,
    toolState?.downloadCachePath,
    toolState?.downloadCachePath ? path.dirname(toolState.downloadCachePath) : null,
    toolState?.id ? path.join(downloadsRoot, toolState.id) : null,
  ].filter(Boolean);

  const artifacts = [];
  for (const rootPath of searchRoots) {
    if (!(await fs.pathExists(rootPath))) {
      continue;
    }

    const stats = await fs.stat(rootPath).catch(() => null);
    if (stats?.isFile()) {
      if (TEMP_FILE_PATTERNS.some((pattern) => pattern.test(path.basename(rootPath)))) {
        artifacts.push(await buildEntry(rootPath, 'partial-download-or-temp-file'));
      }
      continue;
    }

    if (stats?.isDirectory() && TEMP_DIRECTORY_PATTERNS.some((pattern) => pattern.test(path.basename(rootPath)))) {
      artifacts.push(await buildEntry(rootPath, 'failed-install-remnant'));
      continue;
    }

    artifacts.push(...(await collectTemporaryArtifacts(rootPath, 'partial-download-or-temp-file')));
  }

  return uniqueEntries(artifacts);
}

async function collectOrphanedToolFolders(toolsRoot, trackedManagedInstallKeys, excludedPaths = []) {
  if (!(await fs.pathExists(toolsRoot))) {
    return [];
  }

  const excludedKeys = new Set(excludedPaths.map((entry) => normalizeInstallPathKey(entry)).filter(Boolean));
  const entries = await fs.readdir(toolsRoot, { withFileTypes: true }).catch(() => []);
  const orphans = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }

    const candidatePath = path.join(toolsRoot, entry.name);
    const candidateKey = normalizeInstallPathKey(candidatePath);
    if (!candidateKey || trackedManagedInstallKeys.has(candidateKey) || excludedKeys.has(candidateKey)) {
      continue;
    }

    orphans.push(await buildEntry(candidatePath, 'orphaned-tool-folder'));
  }

  return uniqueEntries(orphans);
}

async function inspectRepairCleanup(toolState, manifest) {
  const { toolsRoot } = getAppPaths();
  const trackedManagedInstallKeys = await listTrackedManagedInstallKeys();
  const duplicateFolders = await collectDuplicateToolFolders(toolState, manifest, toolsRoot, trackedManagedInstallKeys);
  const duplicatePaths = duplicateFolders.map((entry) => entry.path);
  const temporaryArtifacts = await collectRepairArtifacts(toolState);
  const orphanedToolFolders = await collectOrphanedToolFolders(toolsRoot, trackedManagedInstallKeys, [
    toolState.installDir,
    toolState.appDir,
    ...duplicatePaths,
  ]);

  const potentialRecoveryBytes = [...duplicateFolders, ...temporaryArtifacts, ...orphanedToolFolders].reduce(
    (total, entry) => total + Number(entry.sizeBytes || 0),
    0,
  );

  return {
    duplicateFolders,
    orphanedToolFolders,
    potentialRecoveryBytes,
    requiresOrphanConfirmation: orphanedToolFolders.length > 0,
    temporaryArtifacts,
  };
}

function isRetryableRemoveError(error) {
  const errorCode = String(error?.code || '').trim().toUpperCase();
  return RETRYABLE_REMOVE_ERROR_CODES.has(errorCode);
}

async function removePathWithRetries(targetPath, logger, operationLabel) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= REMOVE_RETRY_DELAYS_MS.length) {
    if (!(await fs.pathExists(targetPath))) {
      return;
    }

    try {
      await fs.remove(targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRemoveError(error) || attempt === REMOVE_RETRY_DELAYS_MS.length) {
        const retryMessage = path.basename(targetPath) || targetPath;
        throw new Error(`Local AI Hub could not finish cleanup because ${retryMessage} is still being used by Windows. Let the tool finish closing, then try again.`);
      }

      await logger?.warn?.('Cleanup target is still busy. Retrying removal.', {
        operationLabel,
        path: targetPath,
        attempt: attempt + 1,
        error,
      });
      await sleep(REMOVE_RETRY_DELAYS_MS[attempt]);
      attempt += 1;
    }
  }

  if (lastError) {
    throw lastError;
  }
}

async function removeEntries(entries = [], logger, operationLabel) {
  let recoveredBytes = 0;
  let removedCount = 0;

  for (const entry of entries) {
    if (!(await fs.pathExists(entry.path))) {
      continue;
    }

    const sizeBytes = Number(entry.sizeBytes || (await calculatePathSize(entry.path)) || 0);
    await removePathWithRetries(entry.path, logger, operationLabel);
    removedCount += 1;
    recoveredBytes += sizeBytes;
    await logger?.info?.('Removed a Local AI Hub cleanup target.', {
      operationLabel,
      path: entry.path,
      reason: entry.reason,
      sizeBytes,
    });
  }

  return {
    recoveredBytes,
    removedCount,
  };
}

async function applyRepairCleanup(cleanupPlan, options = {}) {
  const logger = options.logger || null;
  const duplicateResult = await removeEntries(cleanupPlan.duplicateFolders, logger, 'duplicate-folders');
  const artifactResult = await removeEntries(cleanupPlan.temporaryArtifacts, logger, 'temporary-artifacts');
  const orphanResult = options.removeOrphanedToolFolders
    ? await removeEntries(cleanupPlan.orphanedToolFolders, logger, 'orphaned-tool-folders')
    : { recoveredBytes: 0, removedCount: 0 };

  return {
    recoveredBytes: duplicateResult.recoveredBytes + artifactResult.recoveredBytes + orphanResult.recoveredBytes,
    removedDuplicateFolders: duplicateResult.removedCount,
    removedOrphanedToolFolders: orphanResult.removedCount,
    removedTemporaryArtifacts: artifactResult.removedCount,
    skippedOrphanedToolFolders: options.removeOrphanedToolFolders ? 0 : cleanupPlan.orphanedToolFolders.length,
  };
}

async function getDiskPreflight(targetPath, requiredBytes) {
  const { disk } = await getDiskSnapshotForPath(targetPath);
  return {
    disk,
    ...(assessDiskSpace(disk, requiredBytes)),
  };
}

module.exports = {
  applyRepairCleanup,
  calculatePathSize,
  getDiskPreflight,
  inspectRepairCleanup,
  normalizeInstallPathKey,
  normalizeManagedRootPath,
};

