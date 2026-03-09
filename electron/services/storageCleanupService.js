const path = require('path');
const fs = require('fs-extra');

const { ensureStorage, getAppPaths, normalizeDirectoryPath, readConfig } = require('./configService');
const { calculatePathSize, normalizePathKey } = require('./storageLocationService');
const { getToolDefinitions, initializeToolRegistry } = require('./toolRegistry');

const TEMP_FILE_PATTERNS = [/\.download$/i, /\.part$/i, /\.partial$/i, /\.tmp$/i, /\.temp$/i];
const TEMP_DIRECTORY_PATTERNS = [/__extract$/i, /__restore$/i, /\.tmp$/i, /\.temp$/i, /^tmp$/i];

function uniquePaths(paths = []) {
  const seen = new Set();
  const results = [];

  for (const entry of paths || []) {
    const normalizedEntry = String(entry || '').trim();
    if (!normalizedEntry) {
      continue;
    }

    const key = normalizePathKey(normalizedEntry);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(normalizeDirectoryPath(normalizedEntry));
  }

  return results;
}

function isPathInside(parentPath, candidatePath) {
  const normalizedParent = normalizeDirectoryPath(parentPath);
  const normalizedCandidate = normalizeDirectoryPath(candidatePath);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

function normalizeAliasToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function getToolAliasTokens(manifest) {
  return new Set(
    [manifest?.id, manifest?.name, ...(manifest?.discovery?.folderNames || [])]
      .map((entry) => normalizeAliasToken(entry))
      .filter(Boolean),
  );
}

async function pathExists(targetPath) {
  return fs.pathExists(targetPath);
}

async function directoryExists(targetPath) {
  const stats = await fs.stat(targetPath).catch(() => null);
  return Boolean(stats?.isDirectory());
}

async function safeReadDir(targetPath) {
  return fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
}

function buildEntry(categoryId, label, targetPath, sizeBytes, reason) {
  return {
    categoryId,
    label,
    path: normalizeDirectoryPath(targetPath),
    reason,
    sizeBytes: Number(sizeBytes || 0),
  };
}

function dedupeEntries(entries = []) {
  const seen = new Set();
  const results = [];

  for (const entry of entries) {
    const key = normalizePathKey(entry?.path || '');
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(entry);
  }

  return results;
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

function buildTrackedToolMap(config) {
  return Object.fromEntries(
    Object.entries(config?.tools || {}).map(([toolId, tool]) => [
      toolId,
      {
        ...tool,
        installKey: normalizePathKey(tool?.installDir || tool?.appDir || ''),
      },
    ]),
  );
}

function getAllowedScanRoots(paths, config) {
  const trackedInstallDirs = Object.values(config?.tools || {})
    .flatMap((tool) => [tool?.installDir, tool?.appDir])
    .filter(Boolean)
    .map((entry) => normalizeDirectoryPath(entry));

  return uniquePaths([
    paths.configRoot,
    paths.localRoot,
    paths.appInstallDir,
    paths.managedRoot,
    ...paths.knownManagedRoots,
    ...paths.legacyConfigRoots,
    ...trackedInstallDirs,
  ]);
}

function getManagedScanRoots(paths) {
  return uniquePaths([
    paths.root,
    paths.managedRoot,
    ...paths.knownManagedRoots,
  ]);
}

async function collectCandidateToolDirectories(paths, allowedRoots) {
  const candidates = [];
  const managedRoots = getManagedScanRoots(paths);

  for (const root of managedRoots) {
    const toolsRoot = path.join(root, 'tools');
    if (!(await directoryExists(toolsRoot))) {
      continue;
    }

    const entries = await safeReadDir(toolsRoot);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const candidatePath = path.join(toolsRoot, entry.name);
      if (!allowedRoots.some((rootPath) => isPathInside(rootPath, candidatePath))) {
        continue;
      }

      candidates.push(candidatePath);
    }
  }

  return uniquePaths(candidates);
}

async function collectDuplicateToolFolders(context, candidateToolDirs) {
  const duplicates = [];
  const trackedInstallMap = buildTrackedToolMap(context.config);
  const duplicateKeys = new Set();

  for (const manifest of context.manifests) {
    const aliasTokens = getToolAliasTokens(manifest);
    const matchingCandidates = [];

    for (const candidatePath of candidateToolDirs) {
      const candidateName = path.basename(candidatePath);
      const looksRelated = aliasTokens.has(normalizeAliasToken(candidateName));
      if (!looksRelated && !(await pathLooksLikeToolInstall(candidatePath, manifest))) {
        continue;
      }

      matchingCandidates.push(candidatePath);
    }

    if (matchingCandidates.length < 2 && !trackedInstallMap[manifest.id]?.installKey) {
      continue;
    }

    const trackedInstallKey = trackedInstallMap[manifest.id]?.installKey || '';
    let keeperKey = trackedInstallKey;

    if (!keeperKey) {
      const preferredManagedPath = path.join(context.paths.managedRoot, 'tools', manifest.id);
      const preferredManagedKey = normalizePathKey(preferredManagedPath);
      keeperKey = matchingCandidates.some((entry) => normalizePathKey(entry) === preferredManagedKey)
        ? preferredManagedKey
        : normalizePathKey(matchingCandidates[0]);
    }

    for (const candidatePath of matchingCandidates) {
      const candidateKey = normalizePathKey(candidatePath);
      if (!candidateKey || candidateKey === keeperKey || duplicateKeys.has(candidateKey)) {
        continue;
      }

      duplicateKeys.add(candidateKey);
      duplicates.push(buildEntry(
        'duplicates',
        manifest.name,
        candidatePath,
        await calculatePathSize(candidatePath),
        `${manifest.name} also exists in another tracked or preferred Local AI Hub location.`,
      ));
    }
  }

  return dedupeEntries(duplicates);
}

async function collectTemporaryArtifacts(rootPath, categoryId, reason, depthRemaining = 4) {
  if (!rootPath || !(await directoryExists(rootPath)) || depthRemaining < 0) {
    return [];
  }

  const entries = await safeReadDir(rootPath);
  const results = [];

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isFile()) {
      if (TEMP_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        results.push(buildEntry(categoryId, path.basename(entryPath), entryPath, await calculatePathSize(entryPath), reason));
      }
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    if (TEMP_DIRECTORY_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      results.push(buildEntry(categoryId, entry.name, entryPath, await calculatePathSize(entryPath), reason));
      continue;
    }

    results.push(...(await collectTemporaryArtifacts(entryPath, categoryId, reason, depthRemaining - 1)));
  }

  return results;
}

async function hasValidToolRuntime(candidatePath, manifest) {
  if (!candidatePath || !manifest) {
    return false;
  }

  if (manifest.installInstructions?.runtime !== 'python') {
    const executableCandidates = [
      ...(manifest.installInstructions?.externalExecutableCandidates || []),
      ...(manifest.installInstructions?.externalBatchCandidates || []),
    ];
    for (const relativePath of executableCandidates) {
      if (await fs.pathExists(path.join(candidatePath, relativePath))) {
        return true;
      }
    }

    return false;
  }

  const venvFolder = manifest.installInstructions?.venvFolder || '.venv';
  const pythonCandidates = [
    path.join(candidatePath, venvFolder, 'Scripts', 'python.exe'),
    path.join(candidatePath, '.venv', 'Scripts', 'python.exe'),
    path.join(candidatePath, 'venv', 'Scripts', 'python.exe'),
    path.join(candidatePath, 'python_embeded', 'python.exe'),
    path.join(candidatePath, 'python_embedded', 'python.exe'),
  ];

  for (const candidate of pythonCandidates) {
    if (await fs.pathExists(candidate)) {
      return true;
    }
  }

  return false;
}

async function collectIncompleteToolFolders(context, candidateToolDirs, excludedKeys) {
  const trackedInstallKeys = new Set(
    Object.values(context.config?.tools || {})
      .map((tool) => normalizePathKey(tool?.installDir || tool?.appDir || ''))
      .filter(Boolean),
  );
  const results = [];

  for (const candidatePath of candidateToolDirs) {
    const candidateKey = normalizePathKey(candidatePath);
    if (!candidateKey || trackedInstallKeys.has(candidateKey) || excludedKeys.has(candidateKey)) {
      continue;
    }

    for (const manifest of context.manifests) {
      const aliasTokens = getToolAliasTokens(manifest);
      const candidateName = path.basename(candidatePath);
      const looksRelated = aliasTokens.has(normalizeAliasToken(candidateName));
      if (!looksRelated && !(await pathLooksLikeToolInstall(candidatePath, manifest))) {
        continue;
      }

      if (await hasValidToolRuntime(candidatePath, manifest)) {
        break;
      }

      results.push(buildEntry(
        'partial',
        manifest.name,
        candidatePath,
        await calculatePathSize(candidatePath),
        `${manifest.name} is missing a working runtime or launcher and looks like an incomplete install.`,
      ));
      excludedKeys.add(candidateKey);
      break;
    }
  }

  return dedupeEntries(results);
}

async function collectOrphanedManagedFolders(context, excludedKeys) {
  const trackedToolIds = new Set(Object.keys(context.config?.tools || {}));
  const trackedInstallKeys = new Set(
    Object.values(context.config?.tools || {})
      .map((tool) => normalizePathKey(tool?.installDir || tool?.appDir || ''))
      .filter(Boolean),
  );
  const orphaned = [];

  for (const root of getManagedScanRoots(context.paths)) {
    const subdirectories = ['tools', 'downloads', 'snapshots'];
    for (const directoryName of subdirectories) {
      const directoryPath = path.join(root, directoryName);
      if (!(await directoryExists(directoryPath))) {
        continue;
      }

      const entries = await safeReadDir(directoryPath);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue;
        }

        const entryPath = path.join(directoryPath, entry.name);
        const entryKey = normalizePathKey(entryPath);
        if (!entryKey || trackedInstallKeys.has(entryKey) || excludedKeys.has(entryKey)) {
          continue;
        }

        if (directoryName !== 'tools' && trackedToolIds.has(entry.name.toLowerCase())) {
          continue;
        }

        orphaned.push(buildEntry(
          'orphans',
          entry.name,
          entryPath,
          await calculatePathSize(entryPath),
          'This folder is not linked to any tool Local AI Hub is currently tracking.',
        ));
      }
    }
  }

  return dedupeEntries(orphaned);
}

async function collectLegacyNestAiFolders(context) {
  const entries = [];
  const candidateRoots = uniquePaths([
    ...context.paths.legacyConfigRoots,
    path.join(context.paths.appInstallDir, 'NestAI'),
  ]);

  for (const candidateRoot of candidateRoots) {
    if (!(await pathExists(candidateRoot))) {
      continue;
    }

    if (!context.allowedRoots.some((root) => isPathInside(root, candidateRoot) || isPathInside(candidateRoot, root))) {
      continue;
    }

    entries.push(buildEntry(
      'legacy',
      path.basename(candidateRoot),
      candidateRoot,
      await calculatePathSize(candidateRoot),
      'This folder was left behind from the old NestAI app name.',
    ));
  }

  return dedupeEntries(entries);
}

function categorizeEntries(categoryId, label, entries) {
  const uniqueEntries = dedupeEntries(entries);
  return {
    id: categoryId,
    label,
    entries: uniqueEntries,
    totalBytes: uniqueEntries.reduce((total, entry) => total + Number(entry.sizeBytes || 0), 0),
  };
}

async function inspectCleanupTargets() {
  await initializeToolRegistry();
  const [paths, config] = await Promise.all([ensureStorage(), readConfig()]);
  const manifests = getToolDefinitions();
  const allowedRoots = getAllowedScanRoots(paths, config);
  const context = {
    allowedRoots,
    config,
    manifests,
    paths,
  };

  const candidateToolDirs = await collectCandidateToolDirectories(paths, allowedRoots);
  const duplicateEntries = await collectDuplicateToolFolders(context, candidateToolDirs);
  const excludedKeys = new Set(duplicateEntries.map((entry) => normalizePathKey(entry.path)));
  const partialEntries = dedupeEntries([
    ...(await Promise.all(allowedRoots.map((root) => collectTemporaryArtifacts(root, 'partial', 'This looks like a failed download or temporary installer folder.')))).flat(),
    ...(await collectIncompleteToolFolders(context, candidateToolDirs, excludedKeys)),
  ]);
  for (const entry of partialEntries) {
    excludedKeys.add(normalizePathKey(entry.path));
  }

  const orphanEntries = await collectOrphanedManagedFolders(context, excludedKeys);
  const legacyEntries = await collectLegacyNestAiFolders(context);
  const categories = [
    categorizeEntries('duplicates', 'Duplicate tool installs', duplicateEntries),
    categorizeEntries('partial', 'Partial downloads and incomplete installs', partialEntries),
    categorizeEntries('orphans', 'Orphaned folders', orphanEntries),
    categorizeEntries('legacy', 'Old NestAI folders', legacyEntries),
  ].filter((category) => category.entries.length > 0);

  return {
    allowedRoots,
    categories,
    totalBytes: categories.reduce((total, category) => total + Number(category.totalBytes || 0), 0),
    totalEntries: categories.reduce((total, category) => total + category.entries.length, 0),
  };
}

function assertCleanupPathAllowed(targetPath, allowedRoots) {
  const normalizedTargetPath = normalizeDirectoryPath(targetPath);
  if (!allowedRoots.some((root) => isPathInside(root, normalizedTargetPath))) {
    throw new Error('Local AI Hub refused to delete a path outside the approved cleanup roots.');
  }

  return normalizedTargetPath;
}

async function runCleanup() {
  const preview = await inspectCleanupTargets();
  const removedEntries = [];

  for (const category of preview.categories) {
    for (const entry of category.entries) {
      const safePath = assertCleanupPathAllowed(entry.path, preview.allowedRoots);
      if (!(await fs.pathExists(safePath))) {
        continue;
      }

      await fs.remove(safePath);
      removedEntries.push(entry);
    }
  }

  return {
    categories: preview.categories.map((category) => ({
      ...category,
      removedEntries: category.entries.filter((entry) => removedEntries.some((removed) => normalizePathKey(removed.path) === normalizePathKey(entry.path))),
    })),
    removedBytes: removedEntries.reduce((total, entry) => total + Number(entry.sizeBytes || 0), 0),
    removedEntries,
  };
}

module.exports = {
  inspectCleanupTargets,
  runCleanup,
};

