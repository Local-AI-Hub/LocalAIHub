const path = require('path');
const fs = require('fs-extra');

const { ensureStorage, getAppPaths, normalizeDirectoryPath, readConfig } = require('./configService');
const { calculatePathSize, normalizePathKey } = require('./storageLocationService');
const { getToolDefinitions, initializeToolRegistry } = require('./toolRegistry');
const { removePathWithRetries } = require('./storageMaintenanceService');
const {
  collectStaleToolWindowsShortcuts,
  collectStaleWindowsUninstallEntries,
  getWindowsShortcutRoots,
  removeWindowsUninstallEntry,
} = require('./windowsUninstallService');

const TEMP_FILE_PATTERNS = [/\.download$/i, /\.part$/i, /\.partial$/i, /\.tmp$/i, /\.temp$/i];
const TEMP_DIRECTORY_PATTERNS = [/__extract$/i, /__restore$/i, /\.tmp$/i, /\.temp$/i, /^tmp$/i];
const GENERIC_TOOL_MARKER_BASENAMES = new Set([
  '__init__.py',
  'app.py',
  'config.json',
  'main.py',
  'pyproject.toml',
  'requirements.txt',
  'run.bat',
  'server.py',
  'webui-user.bat',
  'webui.bat',
  'webui.py',
]);

const DEVELOPMENT_APP_INSTALL_DIR = normalizeDirectoryPath(path.resolve(__dirname, '..', '..'));

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

function isCleanupScopedToolState(tool) {
  return Boolean(tool && (tool.source === 'managed' || tool.installedByLocalAIHub));
}

function getCleanupScopedTools(config) {
  return Object.entries(config?.tools || {}).filter(([, tool]) => isCleanupScopedToolState(tool));
}

function shouldIncludeAppInstallDir(paths) {
  const appInstallDirKey = normalizePathKey(paths?.appInstallDir || '');
  return Boolean(appInstallDirKey) && appInstallDirKey !== normalizePathKey(DEVELOPMENT_APP_INSTALL_DIR);
}

function filterWorkspaceRoots(paths = []) {
  const workspaceRootKey = normalizePathKey(DEVELOPMENT_APP_INSTALL_DIR);
  return (paths || []).filter((entry) => normalizePathKey(entry) !== workspaceRootKey);
}

async function calculateCleanupEntrySize(targetPath) {
  const stats = await fs.stat(targetPath).catch(() => null);
  return stats?.isFile() ? Number(stats.size || 0) : 0;
}

function buildEntry(categoryId, label, targetPath, sizeBytes, reason) {
  return {
    categoryId,
    kind: 'filesystem',
    label,
    path: normalizeDirectoryPath(targetPath),
    reason,
    sizeBytes: Number(sizeBytes || 0),
  };
}

function buildRegistryEntry(categoryId, label, registryKeyPath, reason) {
  return {
    categoryId,
    kind: 'registry',
    label,
    path: 'Registry: ' + String(registryKeyPath || '').trim(),
    reason,
    registryKeyPath: String(registryKeyPath || '').trim(),
    sizeBytes: 0,
  };
}

function buildShortcutEntry(categoryId, label, shortcutPath, reason, targetPath = null) {
  return {
    categoryId,
    kind: 'shortcut',
    label,
    path: normalizeDirectoryPath(shortcutPath),
    reason,
    shortcutTargetPath: targetPath ? normalizeDirectoryPath(targetPath) : null,
    sizeBytes: 0,
  };
}

function dedupeEntries(entries = []) {
  const seen = new Set();
  const results = [];

  for (const entry of entries) {
    const key = entry?.kind === 'registry'
      ? String(entry?.registryKeyPath || '').trim().toLowerCase()
      : normalizePathKey(entry?.path || '');
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(entry);
  }

  return results;
}

function isSpecificToolMarkerPath(markerPath) {
  const normalizedMarkerPath = String(markerPath || '').trim().replace(/\//g, '\\');
  if (!normalizedMarkerPath) {
    return false;
  }

  const basename = path.basename(normalizedMarkerPath).toLowerCase();
  if (GENERIC_TOOL_MARKER_BASENAMES.has(basename)) {
    return false;
  }

  return /[\\]/.test(normalizedMarkerPath) || /\.(exe|bat|cmd|ps1)$/i.test(basename) || Boolean(basename);
}

async function pathLooksLikeToolInstall(candidatePath, manifest, options = {}) {
  const markerPaths = [
    ...(manifest?.discovery?.markerPaths || []),
    ...(manifest?.installInstructions?.externalExecutableCandidates || []),
    ...(manifest?.installInstructions?.externalBatchCandidates || []),
  ]
    .filter(Boolean)
    .filter((markerPath) => !options.requireSpecificMarkers || isSpecificToolMarkerPath(markerPath));

  if (!markerPaths.length) {
    return false;
  }

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

function normalizeTrackedInstallRoot(targetPath) {
  const normalizedPath = normalizeDirectoryPath(targetPath || '');
  if (!normalizedPath) {
    return '';
  }

  return path.basename(normalizedPath).toLowerCase() === 'app' ? path.dirname(normalizedPath) : normalizedPath;
}

function buildTrackedToolMap(config, manifestMap = {}) {
  return Object.fromEntries(
    getCleanupScopedTools(config).map(([toolId, tool]) => [
      toolId,
      {
        ...tool,
        installKey: normalizePathKey(normalizeTrackedInstallRoot(tool?.installDir || tool?.appDir || '')),
        manifest: manifestMap[toolId] || null,
      },
    ]),
  );
}

async function resolveCandidateToolMatch(context, candidatePath) {
  const candidateKey = normalizePathKey(candidatePath);
  const candidateToken = normalizeAliasToken(path.basename(candidatePath));

  if (candidateToken) {
    const exactIdMatch = context.manifests.find((manifest) => normalizeAliasToken(manifest.id) === candidateToken);
    if (exactIdMatch) {
      return {
        manifest: exactIdMatch,
        toolId: exactIdMatch.id,
      };
    }
  }

  const trackedMatch = Object.values(context.trackedTools || {}).find(
    (tool) => tool.installKey === candidateKey && tool.manifest,
  );
  if (trackedMatch?.manifest) {
    return {
      manifest: trackedMatch.manifest,
      toolId: trackedMatch.manifest.id,
    };
  }

  if (candidateToken) {
    const aliasMatches = context.manifests.filter((manifest) => getToolAliasTokens(manifest).has(candidateToken));
    if (aliasMatches.length === 1) {
      return {
        manifest: aliasMatches[0],
        toolId: aliasMatches[0].id,
      };
    }
  }

  const strongMarkerMatches = [];
  for (const manifest of context.manifests) {
    if (await pathLooksLikeToolInstall(candidatePath, manifest, { requireSpecificMarkers: true })) {
      strongMarkerMatches.push(manifest);
    }
  }

  if (strongMarkerMatches.length === 1) {
    return {
      manifest: strongMarkerMatches[0],
      toolId: strongMarkerMatches[0].id,
    };
  }

  return null;
}

function getAllowedScanRoots(paths, config) {
  const trackedInstallDirs = getCleanupScopedTools(config)
    .flatMap(([, tool]) => [tool?.installDir, tool?.appDir])
    .filter(Boolean)
    .map((entry) => normalizeTrackedInstallRoot(entry))
    .filter(Boolean);

  return uniquePaths([
    paths.configRoot,
    paths.localRoot,
    shouldIncludeAppInstallDir(paths) ? paths.appInstallDir : null,
    paths.managedRoot,
    ...filterWorkspaceRoots(paths.knownManagedRoots),
    ...paths.legacyConfigRoots,
    ...trackedInstallDirs,
  ]);
}

function getManagedScanRoots(paths) {
  return uniquePaths(filterWorkspaceRoots([
    paths.root,
    paths.managedRoot,
    ...paths.knownManagedRoots,
  ]));
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
  const duplicateKeys = new Set();
  const groupedCandidates = new Map();

  for (const candidatePath of candidateToolDirs) {
    const match = await resolveCandidateToolMatch(context, candidatePath);
    if (!match?.manifest) {
      continue;
    }

    const group = groupedCandidates.get(match.toolId) || {
      manifest: match.manifest,
      paths: [],
    };
    group.paths.push(candidatePath);
    groupedCandidates.set(match.toolId, group);
  }

  for (const [toolId, group] of groupedCandidates.entries()) {
    if (group.paths.length < 2) {
      continue;
    }

    const matchingKeys = new Set(group.paths.map((entry) => normalizePathKey(entry)).filter(Boolean));
    const trackedInstallKey = context.trackedTools[toolId]?.installKey || '';
    const preferredManagedKey = normalizePathKey(path.join(context.paths.managedRoot, 'tools', toolId));
    const canonicalManagedKey = normalizePathKey(
      group.paths.find((entry) => normalizeAliasToken(path.basename(entry)) === normalizeAliasToken(toolId)) || '',
    );
    let keeperKey = trackedInstallKey && matchingKeys.has(trackedInstallKey) ? trackedInstallKey : '';

    if (!keeperKey && matchingKeys.has(preferredManagedKey)) {
      keeperKey = preferredManagedKey;
    }

    if (!keeperKey && canonicalManagedKey && matchingKeys.has(canonicalManagedKey)) {
      keeperKey = canonicalManagedKey;
    }

    if (!keeperKey) {
      keeperKey = normalizePathKey(group.paths[0]);
    }

    for (const candidatePath of group.paths) {
      const candidateKey = normalizePathKey(candidatePath);
      if (!candidateKey || candidateKey === keeperKey || duplicateKeys.has(candidateKey)) {
        continue;
      }

      duplicateKeys.add(candidateKey);
      duplicates.push(buildEntry(
        'duplicates',
        group.manifest.name,
        candidatePath,
        await calculateCleanupEntrySize(candidatePath),
        `${group.manifest.name} also exists in another tracked or preferred Local AI Hub location.`,
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
        results.push(buildEntry(categoryId, path.basename(entryPath), entryPath, await calculateCleanupEntrySize(entryPath), reason));
      }
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    if (TEMP_DIRECTORY_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      results.push(buildEntry(categoryId, entry.name, entryPath, await calculateCleanupEntrySize(entryPath), reason));
      continue;
    }

    results.push(...(await collectTemporaryArtifacts(entryPath, categoryId, reason, depthRemaining - 1)));
  }

  return results;
}

function getTemporaryArtifactScanRoots(context, candidateToolDirs = []) {
  const trackedInstallDirs = Object.values(context.trackedTools || {})
    .flatMap((tool) => [
      normalizeTrackedInstallRoot(tool?.installDir || tool?.appDir || ''),
      tool?.appDir,
      tool?.downloadCachePath ? path.dirname(tool.downloadCachePath) : null,
    ])
    .filter(Boolean);

  return uniquePaths([
    context.paths.configRoot,
    context.paths.localRoot,
    shouldIncludeAppInstallDir(context.paths) ? context.paths.appInstallDir : null,
    context.paths.downloadsRoot,
    ...trackedInstallDirs,
    ...trackedInstallDirs.map((entry) => `${entry}__extract`),
    ...trackedInstallDirs.map((entry) => `${entry}__restore`),
    ...candidateToolDirs.map((entry) => `${entry}__extract`),
    ...candidateToolDirs.map((entry) => `${entry}__restore`),
  ]);
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
      .map((tool) => normalizePathKey(normalizeTrackedInstallRoot(tool?.installDir || tool?.appDir || '')))
      .filter(Boolean),
  );
  const results = [];

  for (const candidatePath of candidateToolDirs) {
    const candidateKey = normalizePathKey(candidatePath);
    if (!candidateKey || trackedInstallKeys.has(candidateKey) || excludedKeys.has(candidateKey)) {
      continue;
    }

    const match = await resolveCandidateToolMatch(context, candidatePath);
    if (!match?.manifest) {
      continue;
    }

    if (await hasValidToolRuntime(candidatePath, match.manifest)) {
      continue;
    }

    results.push(buildEntry(
      'partial',
      match.manifest.name,
      candidatePath,
      await calculateCleanupEntrySize(candidatePath),
      `${match.manifest.name} is missing a working runtime or launcher and looks like an incomplete install.`,
    ));
    excludedKeys.add(candidateKey);
  }

  return dedupeEntries(results);
}

async function collectOrphanedManagedFolders(context, excludedKeys) {
  const trackedToolIds = new Set(
    Object.values(context.trackedTools || {})
      .map((tool) => String(tool?.id || tool?.manifest?.id || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const trackedInstallKeys = new Set(
    Object.values(context.trackedTools || {})
      .map((tool) => normalizePathKey(normalizeTrackedInstallRoot(tool?.installDir || tool?.appDir || '')))
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
          await calculateCleanupEntrySize(entryPath),
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
      await calculateCleanupEntrySize(candidateRoot),
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
  const manifestMap = Object.fromEntries(manifests.map((manifest) => [manifest.id, manifest]));
  const trackedTools = buildTrackedToolMap(config, manifestMap);
  const allowedRoots = getAllowedScanRoots(paths, config);
  const context = {
    allowedRoots,
    config,
    manifests,
    paths,
    trackedTools,
  };

  const candidateToolDirs = await collectCandidateToolDirectories(paths, allowedRoots);
  const duplicateEntries = await collectDuplicateToolFolders(context, candidateToolDirs);
  const excludedKeys = new Set(duplicateEntries.map((entry) => normalizePathKey(entry.path)));
  const temporaryArtifactRoots = getTemporaryArtifactScanRoots(context, candidateToolDirs);
  const partialEntries = dedupeEntries([
    ...(await Promise.all(
      temporaryArtifactRoots.map((root) =>
        collectTemporaryArtifacts(root, 'partial', 'This looks like a failed download or temporary installer folder.', 2),
      ),
    )).flat(),
    ...(await collectIncompleteToolFolders(context, candidateToolDirs, excludedKeys)),
  ]);
  for (const entry of partialEntries) {
    excludedKeys.add(normalizePathKey(entry.path));
  }

  const orphanEntries = await collectOrphanedManagedFolders(context, excludedKeys);
  const legacyEntries = await collectLegacyNestAiFolders(context);
  const staleWindowsEntries = (await collectStaleWindowsUninstallEntries(allowedRoots, { manifests, trackedTools })).map((entry) =>
    buildRegistryEntry(
      'windows-uninstall',
      entry.displayName || 'Windows uninstall entry',
      entry.keyPath,
      'Windows still has an uninstall entry for this app, but the referenced files are already gone.',
    ),
  );
  const shortcutEntries = (await collectStaleToolWindowsShortcuts(allowedRoots, { manifests, trackedTools })).map((entry) =>
    buildShortcutEntry(
      'shortcuts',
      entry.displayName || 'Windows shortcut',
      entry.shortcutPath,
      entry.targetPath
        ? `This Windows shortcut still points to ${entry.targetPath}, but that target is gone.`
        : 'This Windows shortcut still points to a removed Local AI Hub tool location.',
      entry.targetPath,
    ),
  );
  const allowedShortcutRoots = getWindowsShortcutRoots();
  const categories = [
    categorizeEntries('duplicates', 'Duplicate tool installs', duplicateEntries),
    categorizeEntries('partial', 'Partial downloads and incomplete installs', partialEntries),
    categorizeEntries('orphans', 'Orphaned folders', orphanEntries),
    categorizeEntries('legacy', 'Old NestAI folders', legacyEntries),
    categorizeEntries('shortcuts', 'Stale Windows shortcuts', shortcutEntries),
    categorizeEntries('windows-uninstall', 'Broken Windows uninstall entries', staleWindowsEntries),
  ].filter((category) => category.entries.length > 0);

  return {
    allowedRoots,
    allowedShortcutRoots,
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

function assertShortcutPathAllowed(targetPath, allowedShortcutRoots = []) {
  const normalizedTargetPath = normalizeDirectoryPath(targetPath);
  if (!allowedShortcutRoots.some((root) => isPathInside(root, normalizedTargetPath))) {
    throw new Error('Local AI Hub refused to delete a shortcut outside the approved Windows shortcut roots.');
  }

  return normalizedTargetPath;
}

async function runCleanup() {
  const preview = await inspectCleanupTargets();
  const removedEntries = [];
  const failedEntries = [];

  for (const category of preview.categories) {
    for (const entry of category.entries) {
      try {
        if (entry.kind === 'registry') {
          if (!entry.registryKeyPath) {
            continue;
          }

          await removeWindowsUninstallEntry(entry.registryKeyPath);
          removedEntries.push(entry);
          continue;
        }

        if (entry.kind === 'shortcut') {
          const safeShortcutPath = assertShortcutPathAllowed(entry.path, preview.allowedShortcutRoots || []);
          if (!(await fs.pathExists(safeShortcutPath))) {
            continue;
          }

          await fs.remove(safeShortcutPath);
          removedEntries.push(entry);
          continue;
        }

        const safePath = assertCleanupPathAllowed(entry.path, preview.allowedRoots);
        if (!(await fs.pathExists(safePath))) {
          continue;
        }

        await removePathWithRetries(safePath, null, 'cleanup-preview');
        removedEntries.push(entry);
      } catch (error) {
        failedEntries.push({
          ...entry,
          message: String(error?.message || error || 'Local AI Hub could not remove that leftover item.'),
        });
      }
    }
  }

  return {
    categories: preview.categories.map((category) => ({
      ...category,
      removedEntries: category.entries.filter((entry) => removedEntries.some((removed) => normalizePathKey(removed.path) === normalizePathKey(entry.path))),
    })),
    failedEntries,
    removedBytes: removedEntries.reduce((total, entry) => total + Number(entry.sizeBytes || 0), 0),
    removedEntries,
  };
}

module.exports = {
  inspectCleanupTargets,
  runCleanup,
};

