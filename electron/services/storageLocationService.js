const path = require('path');
const fs = require('fs-extra');

const {
  buildManagedSubdirectoryPaths,
  ensureStorage,
  getAppPaths,
  normalizeDirectoryPath,
  normalizeOptionalDirectoryPath,
  readConfig,
  updateConfig,
} = require('./configService');
const { detectStorageSnapshot, findDiskForPath } = require('./hardwareService');
const { runBackgroundTask } = require('./backgroundTaskService');
const { getToolManifest, initializeToolRegistry } = require('./toolRegistry');
const { isDirectManagedTool, normalizeToolLifecycle } = require('./toolLifecycleService');

const MIGRATABLE_DIRECTORY_LABELS = {
  downloads: 'Installer downloads',
  logs: 'Logs',
  models: 'Models',
  recordings: 'Recordings',
  projects: 'Projects',
  libraries: 'Libraries',
  runtimes: 'Managed Python runtimes',
  snapshots: 'Snapshots',
  tools: 'Installed tools',
};

function normalizePathKey(value) {
  return normalizeDirectoryPath(value).toLowerCase();
}

function pathsMatch(left, right) {
  return Boolean(left) && Boolean(right) && normalizePathKey(left) === normalizePathKey(right);
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNonOverlappingRoots(sourceRoot, targetRoot) {
  const source = buildManagedSubdirectoryPaths(sourceRoot);
  const target = buildManagedSubdirectoryPaths(targetRoot);
  for (const name of Object.keys(MIGRATABLE_DIRECTORY_LABELS)) {
    if (isPathInside(source[`${name}Root`], targetRoot) || isPathInside(target[`${name}Root`], sourceRoot)) {
      throw new Error('Choose a storage folder outside the data folders being moved.');
    }
  }
}

async function calculatePathSize(targetPath, options = {}) {
  return runBackgroundTask('calculate-path-size', {
    targetPath,
  }, {
    signal: options.signal,
  });
}

async function directoryHasChildren(targetPath) {
  const entries = await fs.readdir(targetPath).catch(() => []);
  return entries.length > 0;
}

function normalizeTrackedInstallDir(targetPath) {
  const normalizedPath = normalizeOptionalDirectoryPath(targetPath || '');
  if (!normalizedPath) {
    return '';
  }

  return path.basename(normalizedPath).toLowerCase() === 'app' ? path.dirname(normalizedPath) : normalizedPath;
}

async function buildTrackedToolMap() {
  await initializeToolRegistry();
  const config = await readConfig();
  return Object.fromEntries(
    Object.entries(config?.tools || {}).map(([toolId, toolState]) => {
      const manifest = getToolManifest(toolId) || null;
      const normalizedToolState = manifest ? normalizeToolLifecycle(toolState, manifest) : toolState;
      return [toolId, {
        manifest,
        toolState: normalizedToolState,
        installKey: normalizePathKey(normalizeTrackedInstallDir(normalizedToolState?.installDir || normalizedToolState?.appDir || '')),
      }];
    }),
  );
}

async function buildMigrationEntries(sourceRoot, targetRoot, directoryName) {
  const sourceDirectories = buildManagedSubdirectoryPaths(sourceRoot);
  const targetDirectories = buildManagedSubdirectoryPaths(targetRoot);
  const sourcePath = sourceDirectories[`${directoryName}Root`];
  const targetPath = targetDirectories[`${directoryName}Root`];
  if (!sourcePath || !targetPath || !(await fs.pathExists(sourcePath))) {
    return [];
  }

  if (!(await directoryHasChildren(sourcePath))) {
    return [];
  }

  if (directoryName === 'tools') {
    const entries = await fs.readdir(sourcePath, { withFileTypes: true }).catch(() => []);
    const trackedInstallMap = await buildTrackedToolMap();
    const trackedInstallEntries = Object.values(trackedInstallMap || {});
    const results = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(sourcePath, entry.name);
      const trackedTool =
        trackedInstallEntries.find((candidate) => candidate.installKey === normalizePathKey(entryPath))
        || trackedInstallMap[String(entry.name || '').trim().toLowerCase()]
        || null;
      if (!trackedTool?.manifest || !trackedTool?.toolState || !isDirectManagedTool(trackedTool.toolState, trackedTool.manifest)) {
        continue;
      }

      results.push({
        categoryId: directoryName,
        label: trackedTool.toolState.name || entry.name,
        sizeBytes: await calculatePathSize(entryPath),
        sourcePath: entryPath,
        targetPath: path.join(targetPath, entry.name),
        toolId: trackedTool.manifest.id,
      });
    }

    return results;
  }

  return [{
    categoryId: directoryName,
    label: MIGRATABLE_DIRECTORY_LABELS[directoryName] || directoryName,
    sizeBytes: await calculatePathSize(sourcePath),
    sourcePath,
    targetPath,
  }];
}

async function inspectManagedDataMigration(options = {}) {
  const paths = await ensureStorage();
  const sourceRoot = normalizeDirectoryPath(options.sourceRoot || paths.root);
  const targetRoot = normalizeDirectoryPath(options.targetRoot || paths.managedRoot);

  if (!sourceRoot || !targetRoot || pathsMatch(sourceRoot, targetRoot)) {
    return {
      available: false,
      categories: [],
      sourceRoot,
      targetRoot,
      totalBytes: 0,
      toolCount: 0,
    };
  }

  const categoryEntries = [];
  for (const directoryName of Object.keys(MIGRATABLE_DIRECTORY_LABELS)) {
    // A development checkout or an arbitrary installer directory can have its own projects.
    if (['projects', 'libraries', 'recordings'].includes(directoryName) && pathsMatch(sourceRoot, paths.appInstallDir)
      && !pathsMatch(sourceRoot, paths.managedRoot) && !pathsMatch(sourceRoot, paths.defaultManagedRoot)) continue;
    const entries = await buildMigrationEntries(sourceRoot, targetRoot, directoryName);
    if (!entries.length) {
      continue;
    }

    categoryEntries.push({
      id: directoryName,
      label: MIGRATABLE_DIRECTORY_LABELS[directoryName] || directoryName,
      entries,
      totalBytes: entries.reduce((total, entry) => total + Number(entry.sizeBytes || 0), 0),
    });
  }

  return {
    available: categoryEntries.length > 0,
    categories: categoryEntries,
    sourceRoot,
    targetRoot,
    totalBytes: categoryEntries.reduce((total, category) => total + Number(category.totalBytes || 0), 0),
    toolCount: categoryEntries
      .find((category) => category.id === 'tools')
      ?.entries.length || 0,
  };
}

async function planMigrationMoves(source, target, moves, mergedDirectories) {
  const targetStat = await fs.lstat(target).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!targetStat) {
    moves.push({ source, target });
    return;
  }
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || !targetStat.isDirectory()) {
    throw new Error(`A file or folder already exists at ${target}. Choose an empty destination or resolve the conflict before moving storage.`);
  }
  for (const name of await fs.readdir(source)) {
    await planMigrationMoves(path.join(source, name), path.join(target, name), moves, mergedDirectories);
  }
  mergedDirectories.push(source);
}

async function persistManagedRoot(targetRoot, options = {}) {
  const paths = getAppPaths();
  const normalizedTargetRoot = normalizeDirectoryPath(targetRoot);
  const managedDataRoot = pathsMatch(normalizedTargetRoot, paths.defaultManagedRoot) ? null : normalizedTargetRoot;
  const migrationSourceRoot = options.migrationSourceRoot ? normalizeDirectoryPath(options.migrationSourceRoot) : null;
  const pathMappings = Array.isArray(options.pathMappings) ? options.pathMappings : [];

  return updateConfig((config) => ({
    ...config,
    managedDataRoot,
    preferredInstallRoot: pathsMatch(config.preferredInstallRoot, paths.managedRoot) ? null : config.preferredInstallRoot,
    dismissedManagedMigrationRoots: (config.dismissedManagedMigrationRoots || []).filter(
      (entry) => normalizePathKey(entry) !== normalizePathKey(normalizedTargetRoot),
    ),
    managedDataRootHistory: [
      ...(config.managedDataRootHistory || []),
      paths.managedRoot,
      normalizedTargetRoot,
      migrationSourceRoot,
    ].filter(Boolean),
  }), {
    pathMappings,
  });
}

async function setManagedDataRoot(targetRoot, options = {}) {
  const paths = await ensureStorage();
  const normalizedTargetRoot = normalizeDirectoryPath(targetRoot || paths.defaultManagedRoot);
  const migrationSourceRoot = options.migrationSourceRoot
    ? normalizeDirectoryPath(options.migrationSourceRoot)
    : options.migrateExistingData && !pathsMatch(paths.managedRoot, normalizedTargetRoot)
      ? paths.managedRoot
      : null;

  if (!normalizedTargetRoot) {
    throw new Error('Choose a valid storage folder.');
  }

  if (migrationSourceRoot && !pathsMatch(migrationSourceRoot, normalizedTargetRoot)) {
    assertNonOverlappingRoots(migrationSourceRoot, normalizedTargetRoot);
  }

  await fs.ensureDir(normalizedTargetRoot);
  const nextManagedPaths = buildManagedSubdirectoryPaths(normalizedTargetRoot);
  await Promise.all([
    fs.ensureDir(nextManagedPaths.toolsRoot),
    fs.ensureDir(nextManagedPaths.downloadsRoot),
    fs.ensureDir(nextManagedPaths.snapshotsRoot),
    fs.ensureDir(nextManagedPaths.modelsRoot),
    fs.ensureDir(nextManagedPaths.runtimesRoot),
    fs.ensureDir(nextManagedPaths.logsRoot),
  ]);

  if (!migrationSourceRoot || pathsMatch(migrationSourceRoot, normalizedTargetRoot)) {
    return persistManagedRoot(normalizedTargetRoot);
  }

  const realSource = await fs.realpath(migrationSourceRoot);
  const realTarget = await fs.realpath(normalizedTargetRoot);
  if (pathsMatch(realSource, realTarget)) throw new Error('Choose a different destination folder.');
  assertNonOverlappingRoots(realSource, realTarget);

  const migration = await inspectManagedDataMigration({ sourceRoot: migrationSourceRoot, targetRoot: normalizedTargetRoot });
  const moves = [];
  const mergedDirectories = [];
  const pathMappings = [];
  for (const category of migration.categories) {
    for (const entry of category.entries) {
      const sourceParent = await fs.realpath(path.dirname(entry.sourcePath));
      const targetParent = await fs.realpath(path.dirname(entry.targetPath));
      if (!isPathInside(realSource, sourceParent) || !isPathInside(realTarget, targetParent)) {
        throw new Error('Storage migration stopped because a data folder points outside the selected location.');
      }
      await planMigrationMoves(entry.sourcePath, entry.targetPath, moves, mergedDirectories);
      pathMappings.push({ from: entry.sourcePath, to: entry.targetPath });
    }
  }
  const completed = [];
  let config;
  try {
    for (const move of moves) {
      await fs.move(move.source, move.target, { overwrite: false });
      completed.push(move);
    }
    config = await persistManagedRoot(normalizedTargetRoot, { migrationSourceRoot, pathMappings });
  } catch (error) {
    // Uninstall metadata is written after config.json. Keep the moved files if the new root was committed.
    if (!pathsMatch(paths.managedRoot, normalizedTargetRoot) && pathsMatch(getAppPaths().managedRoot, normalizedTargetRoot)) throw error;
    let rollbackFailed = false;
    for (const move of completed.reverse()) {
      try { await fs.move(move.target, move.source, { overwrite: false }); }
      catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new Error('Storage migration stopped. Some files remain in each location. Check both folders before retrying.');
    throw error;
  }
  for (const directory of mergedDirectories) {
    // Only remove empty directories. Another process may have added files during migration.
    await fs.rmdir(directory).catch(() => {});
  }
  return config;
}

async function dismissManagedDataMigration(sourceRoot) {
  const normalizedSourceRoot = normalizeDirectoryPath(sourceRoot);
  return updateConfig((config) => ({
    ...config,
    dismissedManagedMigrationRoots: [
      ...(config.dismissedManagedMigrationRoots || []),
      normalizedSourceRoot,
    ],
  }));
}

async function getStorageOverview() {
  const [paths, config, disks] = await Promise.all([
    ensureStorage(),
    readConfig(),
    detectStorageSnapshot().catch(() => []),
  ]);

  const currentDisk = findDiskForPath(disks, paths.managedRoot);
  const migrationCandidates = [...new Set(
    [paths.root, paths.localRoot, paths.appInstallDir, paths.defaultManagedRoot]
      .filter(Boolean)
      .filter((sourceRoot) => !pathsMatch(sourceRoot, paths.managedRoot))
      .map((sourceRoot) => normalizeDirectoryPath(sourceRoot)),
  )];
  const migrationResults = await Promise.all(
    migrationCandidates.map((sourceRoot) =>
      inspectManagedDataMigration({
        sourceRoot,
        targetRoot: paths.managedRoot,
      }),
    ),
  );
  const legacyMigration = migrationResults
    .filter((migration) => migration.available)
    .sort((left, right) => Number(right.totalBytes || 0) - Number(left.totalBytes || 0))[0] || {
    available: false,
    categories: [],
    sourceRoot: paths.root,
    targetRoot: paths.managedRoot,
    totalBytes: 0,
    toolCount: 0,
  };
  const dismissedMigrationRoots = new Set((config.dismissedManagedMigrationRoots || []).map((entry) => normalizePathKey(entry)));

  return {
    appInstallDir: paths.appInstallDir,
    configRoot: paths.configRoot,
    currentDisk,
    customManagedRoot: Boolean(config.managedDataRoot),
    customPreferredInstallRoot: Boolean(config.preferredInstallRoot),
    defaultManagedRoot: paths.defaultManagedRoot,
    executablePath: paths.executablePath,
    legacyMigration: {
      ...legacyMigration,
      dismissed: dismissedMigrationRoots.has(normalizePathKey(legacyMigration.sourceRoot || '')),
    },
    localAppDataRoot: paths.localRoot,
    managedRoot: paths.managedRoot,
    knownManagedRoots: paths.knownManagedRoots,
    preferredInstallRoot: normalizeOptionalDirectoryPath(config.preferredInstallRoot) || paths.preferredInstallRoot || paths.managedRoot,
    drives: (disks || []).map((disk) => ({
      ...disk,
      isInstallDrive: Boolean(paths.appInstallDir) && normalizePathKey(paths.appInstallDir).startsWith(normalizePathKey(disk.mount)),
      isManagedDrive: Boolean(paths.managedRoot) && normalizePathKey(paths.managedRoot).startsWith(normalizePathKey(disk.mount)),
    })),
  };
}

module.exports = {
  calculatePathSize,
  dismissManagedDataMigration,
  getStorageOverview,
  inspectManagedDataMigration,
  normalizePathKey,
  setManagedDataRoot,
};
