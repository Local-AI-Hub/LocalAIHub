const path = require('path');
const fs = require('fs-extra');

const { getAppPaths, readConfig, updateConfig } = require('./configService');
const { resolveManagedToolPaths } = require('./pathSafetyService');
const { runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const {
  buildExternalLaunchProfile,
  buildManagedLaunchProfile,
  getToolDefinitions,
  initializeToolRegistry,
} = require('./toolRegistry');

const DISCOVERY_TTL_MS = 60000;
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const COMMON_LIBRARY_ROOTS = [
  '',
  'Apps',
  'Applications',
  'Programs',
  'Tools',
  'AI',
  'AI Tools',
  'Portable',
  'LocalAI',
  path.join('SteamLibrary', 'steamapps', 'common'),
  path.join('Steam', 'steamapps', 'common'),
  'Games',
  path.join('Games', 'SteamLibrary', 'steamapps', 'common'),
];

let discoveryCache = {
  timestamp: 0,
  tools: null,
};

function getEnvValueInsensitive(name) {
  const key = Object.keys(process.env).find((entry) => entry.toLowerCase() === String(name || '').toLowerCase());
  return key ? process.env[key] : null;
}

function expandDetectionPath(template) {
  return String(template || '').replace(/%([^%]+)%/g, (_match, name) => getEnvValueInsensitive(name) || '');
}

function normalizePathKey(targetPath) {
  try {
    return path.resolve(String(targetPath || '')).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return String(targetPath || '').trim().toLowerCase();
  }
}

function uniquePaths(paths = []) {
  const seen = new Set();
  const results = [];

  for (const entry of paths) {
    const normalized = normalizePathKey(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(entry);
  }

  return results;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function normalizeInstallDirCandidate(candidatePath) {
  if (!candidatePath) {
    return null;
  }

  return path.basename(candidatePath) === 'app' ? path.dirname(candidatePath) : candidatePath;
}

function getAllowedManagedInstallDirs(manifest) {
  const currentManagedPaths = resolveManagedToolPaths(
    manifest.id,
    manifest.installInstructions.venvFolder || '.venv',
  );
  return uniquePaths([
    currentManagedPaths.installDir,
    ...getAppPaths().legacyRoots.map((legacyRoot) => path.join(legacyRoot, 'tools', manifest.id)),
  ]);
}

function getAllowedManagedLocationKeys(manifest) {
  const locations = getAllowedManagedInstallDirs(manifest);
  return new Set(
    uniquePaths([
      ...locations,
      ...locations.map((installDir) => path.join(installDir, 'app')),
    ]).map((entry) => normalizePathKey(entry)),
  );
}

function resolveSafeManagedInstallDir(manifest, installDir) {
  const normalizedInstallDir = normalizeInstallDirCandidate(installDir);
  const safeCandidate = getAllowedManagedInstallDirs(manifest).find(
    (candidate) => normalizePathKey(candidate) === normalizePathKey(normalizedInstallDir),
  );

  return safeCandidate || resolveManagedToolPaths(manifest.id, manifest.installInstructions.venvFolder || '.venv').installDir;
}

async function findExecutableOnPath(executableName, logger) {
  const result = await runCommand('where', [executableName], {
    allowFailure: true,
  });

  if (result.code !== 0) {
    return null;
  }

  const candidate = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (candidate && (await fileExists(candidate))) {
    await logger.info('Tool executable found on PATH.', {
      executable: executableName,
      resolvedPath: candidate,
    });
    return candidate;
  }

  return null;
}

function parsePythonProbeResult(stdout) {
  const payload = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{'));

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function probePythonModule(moduleName, launcher, launcherArgs = [], logger) {
  const probeSnippet = [
    'import importlib.util, json, sys',
    `module_name = ${JSON.stringify(moduleName)}`,
    'spec = importlib.util.find_spec(module_name)',
    'print(json.dumps({"found": bool(spec), "python": sys.executable}))',
  ].join('; ');

  const result = await runCommand(launcher, [...launcherArgs, '-c', probeSnippet], {
    allowFailure: true,
  });

  if (result.code !== 0) {
    return null;
  }

  const payload = parsePythonProbeResult(result.stdout);
  if (!payload?.found || !payload.python) {
    return null;
  }

  await logger.info('A Python module probe found an existing tool install.', {
    moduleName,
    pythonPath: payload.python,
  });

  return {
    detectedPath: payload.python,
    displayPath: `${payload.python} (${moduleName})`,
    fromPath: true,
    installDir: path.dirname(path.dirname(payload.python)),
    pythonPath: payload.python,
    reason: 'python-module',
  };
}

async function discoverFromPythonModules(manifest, logger) {
  const pythonModules = manifest.discovery?.pythonModules || [];
  if (!pythonModules.length) {
    return null;
  }

  const launchers = [
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] },
  ];

  for (const moduleName of pythonModules) {
    for (const launcher of launchers) {
      const resolved = await probePythonModule(moduleName, launcher.command, launcher.args, logger);
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

async function resolveFilesystemCandidate(candidatePath, metadata = {}) {
  const expandedPath = expandDetectionPath(candidatePath);
  if (!expandedPath || !(await pathExists(expandedPath))) {
    return null;
  }

  const stats = await fs.stat(expandedPath);
  return {
    detectedPath: expandedPath,
    displayPath: expandedPath,
    fromPath: false,
    installDir: stats.isDirectory() ? expandedPath : path.dirname(expandedPath),
    reason: metadata.reason || 'filesystem',
  };
}

async function resolveDetectionPath(detectionPath, logger) {
  if (String(detectionPath || '').startsWith('PATH:')) {
    const executable = detectionPath.slice(5).trim();
    const resolved = await findExecutableOnPath(executable, logger);
    if (!resolved) {
      return null;
    }

    return {
      detectedPath: resolved,
      installDir: path.dirname(resolved),
      displayPath: resolved,
      fromPath: true,
      reason: 'manifest-path',
    };
  }

  return resolveFilesystemCandidate(detectionPath, {
    reason: 'manifest-path',
  });
}

function getTrackedPathCandidates(existingTool, manifest) {
  const appPaths = getAppPaths();
  const candidates = [
    existingTool?.detectedPath,
    existingTool?.displayPath,
    existingTool?.installDir,
    existingTool?.appDir,
    existingTool?.launchProfile?.executable,
    existingTool?.launchProfile?.command,
    existingTool?.launchProfile?.pythonPath,
    existingTool?.externalPythonPath,
    path.join(appPaths.toolsRoot, manifest.id),
    path.join(appPaths.toolsRoot, manifest.id, 'app'),
    ...appPaths.legacyRoots.flatMap((legacyRoot) => [
      path.join(legacyRoot, 'tools', manifest.id),
      path.join(legacyRoot, 'tools', manifest.id, 'app'),
    ]),
  ];

  return uniquePaths(candidates.filter(Boolean));
}

async function getDriveRoots() {
  const discovered = [];

  for (const letter of DRIVE_LETTERS) {
    const driveRoot = `${letter}:\\`;
    if (await directoryExists(driveRoot)) {
      discovered.push(driveRoot);
    }
  }

  const systemDrive = getEnvValueInsensitive('SystemDrive');
  if (systemDrive) {
    discovered.push(systemDrive.endsWith('\\') ? systemDrive : `${systemDrive}\\`);
  }

  return uniquePaths(discovered);
}

async function buildCommonSearchRoots() {
  const appPaths = getAppPaths();
  const userProfile = getEnvValueInsensitive('USERPROFILE');
  const oneDrive = getEnvValueInsensitive('OneDrive');
  const envRoots = [
    getEnvValueInsensitive('LOCALAPPDATA'),
    path.join(getEnvValueInsensitive('LOCALAPPDATA') || '', 'Programs'),
    getEnvValueInsensitive('APPDATA'),
    getEnvValueInsensitive('PROGRAMFILES'),
    getEnvValueInsensitive('ProgramFiles(x86)'),
    getEnvValueInsensitive('PROGRAMDATA'),
    userProfile,
    path.join(userProfile || '', 'Documents'),
    path.join(userProfile || '', 'Downloads'),
    path.join(userProfile || '', 'Desktop'),
    oneDrive,
    path.join(oneDrive || '', 'Documents'),
    path.join(oneDrive || '', 'Desktop'),
    getEnvValueInsensitive('PUBLIC'),
    path.join(getEnvValueInsensitive('PUBLIC') || '', 'Documents'),
    appPaths.toolsRoot,
    ...appPaths.legacyRoots.map((legacyRoot) => path.join(legacyRoot, 'tools')),
  ].filter(Boolean);

  const driveRoots = await getDriveRoots();
  const driveLibraries = driveRoots.flatMap((driveRoot) => COMMON_LIBRARY_ROOTS.map((relativeRoot) => path.join(driveRoot, relativeRoot)));

  return uniquePaths([...envRoots, ...driveLibraries]);
}

async function discoverFromManifestPaths(manifest, logger) {
  for (const detectionPath of manifest.detectionPaths || []) {
    const resolved = await resolveDetectionPath(detectionPath, logger);
    if (resolved) {
      await logger.info('Tool installation detected from manifest search paths.', {
        toolId: manifest.id,
        detectedPath: resolved.detectedPath,
      });
      return resolved;
    }
  }

  return null;
}

async function discoverFromTrackedPaths(manifest, existingTool, logger) {
  for (const candidatePath of getTrackedPathCandidates(existingTool, manifest)) {
    const resolved = await resolveFilesystemCandidate(candidatePath, {
      reason: 'tracked-path',
    });

    if (resolved) {
      await logger.info('Tool installation detected from a previously saved path.', {
        toolId: manifest.id,
        detectedPath: resolved.detectedPath,
      });
      return resolved;
    }
  }

  return null;
}

async function discoverFromPathExecutables(manifest, logger) {
  const executables = uniquePaths([
    ...(manifest.discovery?.pathExecutables || []),
    ...(manifest.installInstructions?.externalExecutableCandidates || [])
      .map((entry) => path.basename(entry))
      .filter((entry) => entry && entry !== '.'),
  ]);

  for (const executable of executables) {
    if (!executable || /[\\/]/.test(executable)) {
      continue;
    }

    const resolved = await findExecutableOnPath(executable, logger);
    if (resolved) {
      return {
        detectedPath: resolved,
        installDir: path.dirname(resolved),
        displayPath: resolved,
        fromPath: true,
        reason: 'path-executable',
      };
    }
  }

  return null;
}

async function discoverFromCommonRoots(manifest, logger) {
  const folderNames = uniquePaths(manifest.discovery?.folderNames || []);
  const markerPaths = uniquePaths(manifest.discovery?.markerPaths || []);
  const searchRoots = await buildCommonSearchRoots();

  for (const root of searchRoots) {
    for (const folderName of folderNames) {
      for (const markerPath of markerPaths) {
        const candidate = path.join(root, folderName, markerPath);
        const resolved = await resolveFilesystemCandidate(candidate, {
          reason: 'common-root-scan',
        });
        if (!resolved) {
          continue;
        }

        await logger.info('Tool installation detected from common search folders.', {
          toolId: manifest.id,
          detectedPath: resolved.detectedPath,
        });
        return resolved;
      }
    }
  }

  return null;
}

async function discoverInstallLocation(manifest, existingTool, logger) {
  const discoverySteps = [
    () => discoverFromTrackedPaths(manifest, existingTool, logger),
    () => discoverFromManifestPaths(manifest, logger),
    () => discoverFromPathExecutables(manifest, logger),
    () => discoverFromPythonModules(manifest, logger),
    () => discoverFromCommonRoots(manifest, logger),
  ];

  for (const discoverStep of discoverySteps) {
    const resolved = await discoverStep();
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function buildExternalToolState(manifest, existingTool, detected) {
  const launchProfile = buildExternalLaunchProfile(manifest, detected.installDir, detected.detectedPath || null);
  const launchSupported = launchProfile.kind !== 'folder';
  const externalPythonPath = detected.pythonPath || launchProfile?.pythonPath || existingTool?.externalPythonPath || null;
  const externalExecutablePath =
    launchProfile.kind === 'binary'
      ? launchProfile.executable
      : launchProfile.kind === 'batch'
        ? launchProfile.command
        : existingTool?.externalExecutablePath || null;

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    category: manifest.category,
    interfaceMode: manifest.interfaceMode,
    type: manifest.installInstructions.runtime,
    source: 'external',
    managedByLocalAIHub: false,
    installDir: detected.installDir,
    appDir: detected.installDir,
    detectedPath: detected.detectedPath,
    displayPath: detected.displayPath,
    externalExecutablePath,
    externalPythonPath,
    launchProfile,
    launchSupported,
    launchUrl: manifest.launchUrl,
    healthUrl: manifest.healthUrl,
    processNames: manifest.processNames || existingTool?.processNames || [],
    detectedAt: new Date().toISOString(),
    installedAt: existingTool?.installedAt || existingTool?.detectedAt || new Date().toISOString(),
    status: existingTool?.status === 'error' ? 'stopped' : existingTool?.status || 'stopped',
    lastError: null,
    lastRepairMessage: null,
    venvDir: null,
    configTargets: manifest.installInstructions.configTargets,
    executablePath: launchProfile.kind === 'binary' ? launchProfile.executable : detected.fromPath ? detected.detectedPath : null,
    snapshots: [],
  };
}

function toolUsesManagedInstallLocation(manifest, tool) {
  if (!tool) {
    return false;
  }

  if (tool.source === 'managed' || tool.managedByLocalAIHub) {
    return true;
  }

  const allowedLocations = getAllowedManagedLocationKeys(manifest);
  const candidates = uniquePaths([
    normalizeInstallDirCandidate(tool.installDir),
    tool.installDir,
    tool.appDir,
    normalizeInstallDirCandidate(tool.detectedPath),
    normalizeInstallDirCandidate(tool.displayPath),
  ].filter(Boolean));

  return candidates.some((candidate) => allowedLocations.has(normalizePathKey(candidate)));
}

async function managedInstallDirectoryExists(manifest, installDir) {
  const resolvedInstallDir = resolveSafeManagedInstallDir(manifest, installDir);
  const candidateDirs = uniquePaths([
    normalizeInstallDirCandidate(installDir),
    resolvedInstallDir,
    path.join(resolvedInstallDir, 'app'),
  ].filter(Boolean));

  for (const candidateDir of candidateDirs) {
    if (await directoryExists(candidateDir)) {
      return true;
    }
  }

  return false;
}

async function managedToolLauncherExists(tool) {
  if (!tool || tool.source !== 'managed') {
    return false;
  }

  if (tool.launchProfile?.kind === 'binary' && tool.launchProfile?.executable) {
    return fileExists(tool.launchProfile.executable);
  }

  if ((tool.launchProfile?.kind === 'python-script' || tool.launchProfile?.kind === 'python-module') && tool.launchProfile?.pythonPath) {
    return fileExists(tool.launchProfile.pythonPath);
  }

  if (tool.launchProfile?.kind === 'batch' && tool.launchProfile?.command) {
    return fileExists(tool.launchProfile.command);
  }

  return false;
}

function buildManagedToolState(existingTool, manifest, installDir = existingTool?.installDir) {
  const resolvedInstallDir = resolveSafeManagedInstallDir(manifest, installDir);
  const appDir = path.join(resolvedInstallDir || '', 'app');
  const venvDir = manifest.installInstructions.runtime === 'python'
    ? path.join(resolvedInstallDir || '', manifest.installInstructions.venvFolder || '.venv')
    : null;

  const nextState = {
    ...existingTool,
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    category: manifest.category,
    interfaceMode: manifest.interfaceMode,
    type: manifest.installInstructions.runtime,
    source: 'managed',
    managedByLocalAIHub: true,
    installDir: resolvedInstallDir,
    appDir,
    venvDir,
    launchUrl: manifest.launchUrl,
    healthUrl: manifest.healthUrl,
    processNames: manifest.processNames || existingTool?.processNames || [],
    configTargets: manifest.installInstructions.configTargets,
    displayPath: resolvedInstallDir,
    launchSupported: true,
  };

  nextState.launchProfile = buildManagedLaunchProfile(nextState, manifest);
  nextState.executablePath = nextState.launchProfile?.kind === 'binary' ? nextState.launchProfile.executable : nextState.executablePath || null;
  return nextState;
}

function buildMissingManagedToolState(existingTool, manifest) {
  const nextState = buildManagedToolState(existingTool, manifest, existingTool.installDir);
  return {
    ...nextState,
    status: 'error',
    lastRepairMessage: existingTool?.lastRepairMessage || null,
    lastError: `${manifest.name}'s saved install folder is missing. Local AI Hub rescanned this PC but could not find another copy yet. Run Repair or reinstall it.`,
  };
}

function buildBrokenManagedToolState(existingTool, manifest, installDir) {
  const nextState = buildManagedToolState(existingTool, manifest, installDir);
  const firstSeenAt = existingTool?.installedAt || existingTool?.detectedAt || new Date().toISOString();

  return {
    ...nextState,
    detectedPath: nextState.installDir,
    displayPath: nextState.installDir,
    detectedAt: existingTool?.detectedAt || firstSeenAt,
    installedAt: firstSeenAt,
    status: 'error',
    lastRepairMessage: existingTool?.lastRepairMessage || null,
    lastError: `${manifest.name}'s files are still on this PC, but its launcher or Python runtime is missing. Run Repair to rebuild it.`,
  };
}

function buildRecoveredManagedToolState(manifest, existingTool = {}, installDir) {
  const nextState = buildManagedToolState(existingTool || {}, manifest, installDir);
  const firstSeenAt = existingTool?.installedAt || existingTool?.detectedAt || new Date().toISOString();
  return {
    ...nextState,
    detectedPath: nextState.installDir,
    displayPath: nextState.installDir,
    detectedAt: existingTool?.detectedAt || firstSeenAt,
    installedAt: firstSeenAt,
    launchSupported: true,
    lastError: null,
    lastRepairMessage: existingTool?.lastRepairMessage || null,
    status: existingTool?.status === 'running' ? 'stopped' : existingTool?.status || 'stopped',
  };
}

async function discoverManagedRelocation(existingTool, manifest, logger) {
  const candidates = uniquePaths([
    normalizeInstallDirCandidate(existingTool?.installDir),
    normalizeInstallDirCandidate(existingTool?.appDir),
    path.join(getAppPaths().toolsRoot, manifest.id),
    path.join(getAppPaths().toolsRoot, manifest.id, 'app'),
    ...getAppPaths().legacyRoots.flatMap((legacyRoot) => [
      path.join(legacyRoot, 'tools', manifest.id),
      path.join(legacyRoot, 'tools', manifest.id, 'app'),
    ]),
  ].filter(Boolean));

  for (const candidate of candidates) {
    if (!(await managedInstallDirectoryExists(manifest, candidate))) {
      continue;
    }

    const nextState = buildRecoveredManagedToolState(manifest, existingTool, candidate);
    if (await managedToolLauncherExists(nextState)) {
      await logger.info('Managed tool files were relocated and have been reattached.', {
        toolId: manifest.id,
        installDir: nextState.installDir,
      });
      return nextState;
    }

    await logger.warn('Managed tool files were found, but the launcher is missing. Keeping the tool in Library for repair.', {
      toolId: manifest.id,
      installDir: nextState.installDir,
    });
    return buildBrokenManagedToolState(existingTool, manifest, candidate);
  }

  return null;
}

async function discoverManagedInstallOnDisk(manifest, existingTool, logger) {
  for (const candidate of getAllowedManagedInstallDirs(manifest)) {
    if (!(await managedInstallDirectoryExists(manifest, candidate))) {
      continue;
    }

    const nextState = buildRecoveredManagedToolState(manifest, existingTool, candidate);
    if (await managedToolLauncherExists(nextState)) {
      await logger.info('Managed tool files were found in Local AI Hub storage and reattached.', {
        toolId: manifest.id,
        installDir: nextState.installDir,
      });
      return nextState;
    }

    await logger.warn('Managed tool folder exists in Local AI Hub storage, but its launcher is missing. Keeping it attached for repair.', {
      toolId: manifest.id,
      installDir: nextState.installDir,
    });
    return buildBrokenManagedToolState(existingTool, manifest, candidate);
  }

  return null;
}

async function performDiscoveryScan() {
  await initializeToolRegistry();

  const logger = createLogger('discovery');
  const config = await readConfig();
  const nextTools = {};
  const ignoredToolIds = new Set(config.ignoredToolIds || []);

  for (const manifest of getToolDefinitions()) {
    const existingTool = config.tools[manifest.id];
    const shouldTreatAsManaged = toolUsesManagedInstallLocation(manifest, existingTool);

    if (shouldTreatAsManaged) {
      const refreshedManagedTool = buildManagedToolState(existingTool || {}, manifest, existingTool?.installDir || existingTool?.appDir);
      if (await managedToolLauncherExists(refreshedManagedTool)) {
        nextTools[manifest.id] = buildRecoveredManagedToolState(manifest, existingTool, refreshedManagedTool.installDir);
        continue;
      }

      if (await managedInstallDirectoryExists(manifest, refreshedManagedTool.installDir)) {
        await logger.warn('Managed tool folder still exists, but its launcher is missing. Keeping it tracked for repair.', {
          toolId: manifest.id,
          installDir: refreshedManagedTool.installDir,
        });
        nextTools[manifest.id] = buildBrokenManagedToolState(existingTool, manifest, refreshedManagedTool.installDir);
        continue;
      }

      await logger.warn('Managed tool is configured but its files were not found in the expected folder. Starting a rescan.', {
        toolId: manifest.id,
        installDir: refreshedManagedTool.installDir,
      });

      const relocatedManagedTool = await discoverManagedRelocation(existingTool, manifest, logger);
      if (relocatedManagedTool) {
        nextTools[manifest.id] = relocatedManagedTool;
        continue;
      }

      const discoveredExternalTool = await discoverInstallLocation(manifest, existingTool, logger);
      if (discoveredExternalTool) {
        nextTools[manifest.id] = buildExternalToolState(manifest, existingTool, discoveredExternalTool);
        continue;
      }

      nextTools[manifest.id] = buildMissingManagedToolState(existingTool || {}, manifest);
      continue;
    }

    const recoveredManagedTool = await discoverManagedInstallOnDisk(manifest, existingTool, logger);
    if (recoveredManagedTool) {
      nextTools[manifest.id] = recoveredManagedTool;
      continue;
    }

    if (ignoredToolIds.has(manifest.id)) {
      await logger.info('Skipping an ignored external tool during discovery.', {
        toolId: manifest.id,
      });
      continue;
    }

    const discovered = await discoverInstallLocation(manifest, existingTool, logger);
    if (discovered) {
      nextTools[manifest.id] = buildExternalToolState(manifest, existingTool, discovered);
    }
  }

  const currentJson = JSON.stringify(config.tools || {});
  const nextJson = JSON.stringify(nextTools);
  if (currentJson !== nextJson) {
    await updateConfig((current) => ({
      ...current,
      tools: nextTools,
    }));
  }

  discoveryCache = {
    timestamp: Date.now(),
    tools: nextTools,
  };

  return nextTools;
}

async function syncDiscoveredTools(options = {}) {
  const force = Boolean(options.force);
  if (!force && discoveryCache.tools && Date.now() - discoveryCache.timestamp < DISCOVERY_TTL_MS) {
    return discoveryCache.tools;
  }

  return performDiscoveryScan();
}

function invalidateDiscoveryCache() {
  discoveryCache = {
    timestamp: 0,
    tools: null,
  };
}

module.exports = {
  invalidateDiscoveryCache,
  syncDiscoveredTools,
};
