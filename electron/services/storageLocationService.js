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
  const normalizedParent = normalizeDirectoryPath(parentPath);
  const normalizedCandidate = normalizeDirectoryPath(candidatePath);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

function assertNonOverlappingRoots(sourceRoot, targetRoot) {
  if (!sourceRoot || !targetRoot) {
    return;
  }

  const sourceManagedPaths = buildManagedSubdirectoryPaths(sourceRoot);
  const targetManagedPaths = buildManagedSubdirectoryPaths(targetRoot);

  for (const directoryName of ['tools', 'downloads', 'snapshots', 'models', 'runtimes', 'logs']) {
    const sourcePath = sourceManagedPaths[`${directoryName}Root`];
    const targetPath = targetManagedPaths[`${directoryName}Root`];
    if (!sourcePath || !targetPath) {
      continue;
    }

    if (isPathInside(sourcePath, targetPath) || isPathInside(targetPath, sourcePath)) {
      throw new Error('Choose a different storage folder so Local AI Hub can move your files safely.');
    }
  }
}

async function calculatePathSize(targetPath) {
  return runBackgroundTask('calculate-path-size', {
    targetPath,
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

async function buildMigrationEntries(sourceRoot, targetRoot, directoryName, trackedTools = null) {
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
    const trackedInstallMap = trackedTools || (await buildTrackedToolMap());
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

    return results.filter((entry) => entry.sizeBytes > 0);
  }

  return [{
    categoryId: directoryName,
    label: MIGRATABLE_DIRECTORY_LABELS[directoryName] || directoryName,
    sizeBytes: await calculatePathSize(sourcePath),
    sourcePath,
    targetPath,
  }].filter((entry) => entry.sizeBytes > 0);
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

  const trackedTools = await buildTrackedToolMap();
  const categoryEntries = [];
  for (const directoryName of ['tools', 'downloads', 'snapshots', 'models', 'runtimes', 'logs']) {
    const entries = await buildMigrationEntries(sourceRoot, targetRoot, directoryName, trackedTools);
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

async function moveEntryWithMerge(sourcePath, targetPath) {
  if (!(await fs.pathExists(sourcePath))) {
    return;
  }

  const sourceStats = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStats) {
    return;
  }

  if (!(await fs.pathExists(targetPath))) {
    await fs.ensureDir(path.dirname(targetPath));
    await fs.move(sourcePath, targetPath, { overwrite: false });
    return;
  }

  if (sourceStats.isFile()) {
    await fs.copy(sourcePath, targetPath, { overwrite: false, errorOnExist: false, preserveTimestamps: true });
    await fs.remove(sourcePath);
    return;
  }

  await fs.ensureDir(targetPath);
  const entries = await fs.readdir(sourcePath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    await moveEntryWithMerge(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
  }

  await fs.remove(sourcePath).catch(() => null);
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

  let pathMappings = [];
  if (migrationSourceRoot && !pathsMatch(migrationSourceRoot, normalizedTargetRoot)) {
    const migration = await inspectManagedDataMigration({
      sourceRoot: migrationSourceRoot,
      targetRoot: normalizedTargetRoot,
    });

    for (const category of migration.categories) {
      for (const entry of category.entries) {
        await moveEntryWithMerge(entry.sourcePath, entry.targetPath);
        pathMappings.push({
          from: entry.sourcePath,
          to: entry.targetPath,
        });
      }
    }
  }

  return persistManagedRoot(normalizedTargetRoot, {
    migrationSourceRoot,
    pathMappings,
  });
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
