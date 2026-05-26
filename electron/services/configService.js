const path = require('path');
const fs = require('fs-extra');
const { app } = require('electron');

const { sanitizeUserMessage } = require('./redactionService');
const {
  normalizeGraphWorkflowPresetRecord,
  validateGraphWorkflowPresetConfig,
} = require('../shared/graphWorkflowContracts.cjs');
const {
  normalizePromptStylePreset,
  normalizePromptStylePresets,
} = require('../shared/promptStyles.cjs');

const CONFIG_VERSION = 4;
const APP_DATA_DIR_NAME = 'LocalAIHub';
const LEGACY_APP_DATA_DIR_NAMES = ['NestAI'];
const MANAGED_DATA_SUBDIRECTORIES = ['tools', 'downloads', 'models', 'snapshots', 'runtimes', 'logs', 'temp', 'cache'];
const UNINSTALL_METADATA_FILE = 'uninstall-cleanup.ini';

let configOperationQueue = Promise.resolve();
let storageReadyPromise = null;
let cachedConfigSnapshot = null;

function getEnvValueInsensitive(name) {
  const key = Object.keys(process.env).find((entry) => entry.toLowerCase() === String(name || '').toLowerCase());
  return key ? process.env[key] : '';
}

function stripTrailingSeparators(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    return parsed.root;
  }

  return resolved.replace(/[\\/]+$/, '');
}

function normalizeDirectoryPath(value) {
  return stripTrailingSeparators(String(value || '').trim());
}

function normalizeOptionalDirectoryPath(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return null;
  }

  return normalizeDirectoryPath(rawValue);
}

function normalizePathList(values = []) {
  const seen = new Set();
  const results = [];

  for (const entry of values || []) {
    const normalizedEntry = normalizeOptionalDirectoryPath(entry);
    if (!normalizedEntry) {
      continue;
    }

    const key = normalizedEntry.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(normalizedEntry);
  }

  return results;
}

function resolveHomePath() {
  try {
    return app.getPath('home');
  } catch {
    return getEnvValueInsensitive('USERPROFILE') || process.cwd();
  }
}

function resolveRoamingAppDataRoot() {
  try {
    return normalizeDirectoryPath(app.getPath('appData'));
  } catch {
    return normalizeDirectoryPath(
      getEnvValueInsensitive('APPDATA') || path.join(resolveHomePath(), 'AppData', 'Roaming'),
    );
  }
}

function resolveLocalAppDataRoot() {
  return normalizeDirectoryPath(
    getEnvValueInsensitive('LOCALAPPDATA') || path.join(resolveHomePath(), 'AppData', 'Local'),
  );
}

function resolveExecutablePath() {
  try {
    const electronExecutable = app.getPath('exe');
    if (electronExecutable) {
      return path.resolve(electronExecutable);
    }
  } catch {
    // Fall back to process.execPath below.
  }

  return path.resolve(process.execPath);
}

function resolveAppInstallDir(executablePath = resolveExecutablePath()) {
  if (app?.isPackaged) {
    return normalizeDirectoryPath(path.dirname(executablePath));
  }

  return normalizeDirectoryPath(path.resolve(__dirname, '..', '..'));
}

function resolveDefaultManagedRoot(appInstallDir, localRoot) {
  const normalizedLocalRoot = normalizeDirectoryPath(localRoot);
  const normalizedInstallDir = normalizeOptionalDirectoryPath(appInstallDir);

  if (!app?.isPackaged || !normalizedInstallDir) {
    return normalizedLocalRoot;
  }

  const installDriveRoot = normalizeOptionalDirectoryPath(path.parse(normalizedInstallDir).root);
  const localDriveRoot = normalizeOptionalDirectoryPath(path.parse(normalizedLocalRoot).root);
  if (!installDriveRoot || !localDriveRoot || installDriveRoot.toLowerCase() === localDriveRoot.toLowerCase()) {
    return normalizedLocalRoot;
  }

  const installParentDir = normalizeOptionalDirectoryPath(path.dirname(normalizedInstallDir));
  const parentName = installParentDir ? path.basename(installParentDir).replace(/\s+/g, '').toLowerCase() : '';
  const managedName = APP_DATA_DIR_NAME.replace(/\s+/g, '').toLowerCase();
  if (installParentDir && parentName === managedName) {
    return installParentDir;
  }

  return normalizeDirectoryPath(path.join(installDriveRoot, APP_DATA_DIR_NAME));
}

function buildManagedSubdirectoryPaths(rootPath) {
  const managedRoot = normalizeDirectoryPath(rootPath);
  return {
    managedRoot,
    cacheRoot: path.join(managedRoot, 'cache'),
    downloadsRoot: path.join(managedRoot, 'downloads'),
    logsRoot: path.join(managedRoot, 'logs'),
    modelsRoot: path.join(managedRoot, 'models'),
    runtimesRoot: path.join(managedRoot, 'runtimes'),
    snapshotsRoot: path.join(managedRoot, 'snapshots'),
    tempRoot: path.join(managedRoot, 'temp'),
    toolsRoot: path.join(managedRoot, 'tools'),
  };
}

function buildManagedPathMappings(sourceRoot, targetRoot) {
  const normalizedSourceRoot = normalizeOptionalDirectoryPath(sourceRoot);
  const normalizedTargetRoot = normalizeOptionalDirectoryPath(targetRoot);
  if (!normalizedSourceRoot || !normalizedTargetRoot) {
    return [];
  }

  return MANAGED_DATA_SUBDIRECTORIES.map((directoryName) => ({
    from: path.join(normalizedSourceRoot, directoryName),
    to: path.join(normalizedTargetRoot, directoryName),
  }));
}

function isPathInside(parentPath, candidatePath) {
  const normalizedParent = normalizeOptionalDirectoryPath(parentPath);
  const normalizedCandidate = normalizeOptionalDirectoryPath(candidatePath);
  if (!normalizedParent || !normalizedCandidate) {
    return false;
  }

  const parentKey = normalizedParent.toLowerCase();
  const candidateKey = normalizedCandidate.toLowerCase();
  return candidateKey === parentKey || candidateKey.startsWith(`${parentKey}${path.sep}`);
}

function escapeIniValue(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function buildUninstallCleanupTargets(paths) {
  const includeIfExternal = (targetPath) => {
    const normalizedTarget = normalizeOptionalDirectoryPath(targetPath);
    if (!normalizedTarget || isPathInside(paths.appInstallDir, normalizedTarget)) {
      return '';
    }

    return normalizedTarget;
  };

  const hasExternalManagedRoot = Boolean(paths.managedRoot) && !isPathInside(paths.appInstallDir, paths.managedRoot);
  return {
    configRoot: includeIfExternal(paths.configRoot),
    localRoot: includeIfExternal(paths.localRoot),
    cacheRoot: hasExternalManagedRoot ? includeIfExternal(paths.cacheRoot) : '',
    downloadsRoot: hasExternalManagedRoot ? includeIfExternal(paths.downloadsRoot) : '',
    logsRoot: hasExternalManagedRoot ? includeIfExternal(paths.logsRoot) : '',
    modelsRoot: hasExternalManagedRoot ? includeIfExternal(paths.modelsRoot) : '',
    runtimesRoot: hasExternalManagedRoot ? includeIfExternal(paths.runtimesRoot) : '',
    snapshotsRoot: hasExternalManagedRoot ? includeIfExternal(paths.snapshotsRoot) : '',
    tempRoot: hasExternalManagedRoot ? includeIfExternal(paths.tempRoot) : '',
    toolsRoot: hasExternalManagedRoot ? includeIfExternal(paths.toolsRoot) : '',
  };
}

async function writeUninstallCleanupMetadata(paths) {
  const targets = buildUninstallCleanupTargets(paths);
  const metadataPath = path.join(paths.configRoot, UNINSTALL_METADATA_FILE);
  const lines = [
    '[cleanup]',
    `ConfigRoot=${escapeIniValue(targets.configRoot)}`,
    `LocalRoot=${escapeIniValue(targets.localRoot)}`,
    `CacheRoot=${escapeIniValue(targets.cacheRoot)}`,
    `ToolsRoot=${escapeIniValue(targets.toolsRoot)}`,
    `ModelsRoot=${escapeIniValue(targets.modelsRoot)}`,
    `DownloadsRoot=${escapeIniValue(targets.downloadsRoot)}`,
    `SnapshotsRoot=${escapeIniValue(targets.snapshotsRoot)}`,
    `RuntimesRoot=${escapeIniValue(targets.runtimesRoot)}`,
    `TempRoot=${escapeIniValue(targets.tempRoot)}`,
    `LogsRoot=${escapeIniValue(targets.logsRoot)}`,
  ];

  await fs.ensureDir(paths.configRoot);
  await fs.writeFile(metadataPath, `${lines.join('\n')}\n`, 'utf8');
  return metadataPath;
}

function buildLegacyConfigRoots(appDataRoot, localAppDataRoot) {
  return normalizePathList(
    LEGACY_APP_DATA_DIR_NAMES.flatMap((name) => [
      path.join(appDataRoot, name),
      path.join(localAppDataRoot, name),
    ]),
  );
}

function normalizeIgnoredToolIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean))];
}

function normalizeCloseBehavior(value) {
  return String(value || '').trim().toLowerCase() === 'tray' ? 'tray' : 'exit';
}

function rewriteLegacyPathsInValue(value, pathMappings) {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteLegacyPathsInValue(entry, pathMappings));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteLegacyPathsInValue(entry, pathMappings)]),
    );
  }

  if (typeof value !== 'string') {
    return value;
  }

  let nextValue = value;
  for (const mapping of pathMappings || []) {
    const from = normalizeOptionalDirectoryPath(mapping?.from);
    const to = normalizeOptionalDirectoryPath(mapping?.to);
    if (!from || !to) {
      continue;
    }

    if (nextValue === from || nextValue.startsWith(`${from}${path.sep}`)) {
      nextValue = `${to}${nextValue.slice(from.length)}`;
    }
  }

  return nextValue;
}

function normalizeToolState(toolState, pathMappings) {
  if (!toolState || typeof toolState !== 'object') {
    return null;
  }

  const { managedByNestAI, managedByLocalAIHub, ...rest } = toolState;
  return rewriteLegacyPathsInValue(
    {
      ...rest,
      managedByLocalAIHub:
        managedByLocalAIHub !== undefined
          ? managedByLocalAIHub
          : managedByNestAI !== undefined
            ? managedByNestAI
            : toolState.source === 'managed',
    },
    pathMappings,
  );
}

function createDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    firstLaunchCompleted: false,
    hardware: null,
    ignoredToolIds: [],
    closeBehavior: 'exit',
    liveResourcePolling: false,
    moveDeletedPipelineOutputsToRecycleBin: true,
    graphWorkflowPresets: [],
    promptStyles: [],
    managedDataRoot: null,
    preferredInstallRoot: null,
    managedDataRootHistory: [],
    dismissedManagedMigrationRoots: [],
    tools: {},
  };
}

function normalizeGraphWorkflowPresets(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set();
  return value
    .map((entry) => {
      try {
        return normalizeGraphWorkflowPresetRecord(entry);
      } catch {
        return null;
      }
    })
    .filter((entry) => {
      if (!entry?.id || seenIds.has(entry.id)) {
        return false;
      }
      seenIds.add(entry.id);
      return true;
    });
}

function normalizeConfig(config, options = {}) {
  const pathMappings = options.pathMappings || [];
  const tools = Object.fromEntries(
    Object.entries(config?.tools || {})
      .map(([toolId, toolState]) => [toolId, normalizeToolState(toolState, pathMappings)])
      .filter(([, toolState]) => Boolean(toolState)),
  );

  return rewriteLegacyPathsInValue(
    {
      ...createDefaultConfig(),
      ...(config || {}),
      version: CONFIG_VERSION,
      ignoredToolIds: normalizeIgnoredToolIds(config?.ignoredToolIds),
      closeBehavior: normalizeCloseBehavior(config?.closeBehavior),
      liveResourcePolling: Boolean(config?.liveResourcePolling),
      moveDeletedPipelineOutputsToRecycleBin: config?.moveDeletedPipelineOutputsToRecycleBin !== false,
      graphWorkflowPresets: normalizeGraphWorkflowPresets(config?.graphWorkflowPresets),
      promptStyles: normalizePromptStylePresets(config?.promptStyles),
      managedDataRoot: normalizeOptionalDirectoryPath(config?.managedDataRoot),
      preferredInstallRoot: normalizeOptionalDirectoryPath(config?.preferredInstallRoot),
      managedDataRootHistory: normalizePathList([
        ...(config?.managedDataRootHistory || []),
        config?.managedDataRoot,
      ]),
      dismissedManagedMigrationRoots: normalizePathList(config?.dismissedManagedMigrationRoots || []),
      tools,
    },
    pathMappings,
  );
}

function readStoredConfigSnapshotSync(configFile) {
  if (cachedConfigSnapshot) {
    return cachedConfigSnapshot;
  }

  try {
    if (!fs.existsSync(configFile)) {
      return null;
    }

    const raw = fs.readFileSync(configFile, 'utf8');
    if (!String(raw || '').trim()) {
      return null;
    }

    cachedConfigSnapshot = normalizeConfig(JSON.parse(raw));
    return cachedConfigSnapshot;
  } catch {
    return null;
  }
}

function getStorageRoots(configOverride = null) {
  const appDataRoot = resolveRoamingAppDataRoot();
  const localAppDataRoot = resolveLocalAppDataRoot();
  const root = normalizeDirectoryPath(path.join(appDataRoot, APP_DATA_DIR_NAME));
  const localRoot = normalizeDirectoryPath(path.join(localAppDataRoot, APP_DATA_DIR_NAME));
  const configFile = path.join(root, 'config.json');
  const executablePath = resolveExecutablePath();
  const appInstallDir = resolveAppInstallDir(executablePath);
  const defaultManagedRoot = resolveDefaultManagedRoot(appInstallDir, localRoot);
  const storedConfig = configOverride || readStoredConfigSnapshotSync(configFile) || null;
  const configuredManagedRoot = normalizeOptionalDirectoryPath(storedConfig?.managedDataRoot);
  const managedRoot = configuredManagedRoot || defaultManagedRoot;
  const preferredInstallRoot = normalizeOptionalDirectoryPath(storedConfig?.preferredInstallRoot);
  const legacyConfigRoots = buildLegacyConfigRoots(appDataRoot, localAppDataRoot).filter(
    (entry) => entry !== root && entry !== localRoot,
  );
  const managedDataRootHistory = normalizePathList(storedConfig?.managedDataRootHistory || []);
  const knownManagedRoots = normalizePathList([
    root,
    localRoot,
    appInstallDir,
    defaultManagedRoot,
    managedRoot,
    preferredInstallRoot,
    ...managedDataRootHistory,
    ...legacyConfigRoots,
  ]);

  return {
    appDataRoot,
    appInstallDir,
    configFile,
    defaultManagedRoot,
    executablePath,
    knownManagedRoots,
    legacyConfigRoots,
    legacyRoots: normalizePathList([root, localRoot, appInstallDir, preferredInstallRoot, ...legacyConfigRoots, ...managedDataRootHistory]),
    localAppDataRoot,
    localRoot,
    managedDataRootHistory,
    managedRoot,
    preferredInstallRoot,
    root,
  };
}

function getAppPaths(configOverride = null) {
  const storage = getStorageRoots(configOverride);
  return {
    ...storage,
    configRoot: storage.root,
    ...buildManagedSubdirectoryPaths(storage.managedRoot),
  };
}

async function mergeJsonFiles(targetPath, sourcePath, mergeJson) {
  if (!(await fs.pathExists(sourcePath))) {
    return;
  }

  const sourceJson = await fs.readJson(sourcePath).catch(() => null);
  if (!sourceJson) {
    return;
  }

  const targetJson = (await fs.pathExists(targetPath)) ? await fs.readJson(targetPath).catch(() => null) : null;
  const mergedJson = mergeJson(targetJson, sourceJson);
  await fs.writeJson(targetPath, mergedJson, { spaces: 2 });
}

async function mergeLegacyConfigRoot(paths, legacyRoot) {
  if (!legacyRoot || !(await fs.pathExists(legacyRoot))) {
    return;
  }

  await mergeJsonFiles(paths.configFile, path.join(legacyRoot, 'config.json'), (targetJson, sourceJson) => ({
    ...normalizeConfig(sourceJson),
    ...normalizeConfig(targetJson),
    tools: {
      ...(normalizeConfig(sourceJson).tools || {}),
      ...(normalizeConfig(targetJson).tools || {}),
    },
  }));

  await mergeJsonFiles(
    path.join(paths.configRoot, 'model-manager.settings.json'),
    path.join(legacyRoot, 'model-manager.settings.json'),
    (targetJson, sourceJson) => ({
      ...(sourceJson || {}),
      ...(targetJson || {}),
    }),
  );
}

function queueConfigOperation(operation) {
  const next = configOperationQueue.then(operation, operation);
  configOperationQueue = next.catch(() => null);
  return next;
}

async function writeConfigFile(paths, config, options = {}) {
  const normalized = normalizeConfig(config, {
    pathMappings: options.pathMappings || [],
  });
  const tempFile = `${paths.configFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.ensureDir(path.dirname(paths.configFile));
  await fs.writeFile(tempFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.move(tempFile, paths.configFile, { overwrite: true });
  cachedConfigSnapshot = normalized;
  storageReadyPromise = null;
  await writeUninstallCleanupMetadata(getAppPaths(normalized));
  return normalized;
}

function extractFirstJsonDocument(raw) {
  const text = String(raw || '');
  let startIndex = 0;

  while (startIndex < text.length && /\s/.test(text[startIndex])) {
    startIndex += 1;
  }

  if (startIndex >= text.length || !['{', '['].includes(text[startIndex])) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === '\\') {
        escaped = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{' || character === '[') {
      depth += 1;
      continue;
    }

    if (character === '}' || character === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, index + 1);
      }
    }
  }

  return null;
}

async function recoverConfigFile(paths, raw, options = {}) {
  const backupPath = path.join(paths.configRoot, `config.corrupt-${Date.now()}.json`);
  await fs.writeFile(backupPath, raw, 'utf8');

  const recoveredDocument = extractFirstJsonDocument(raw);
  if (recoveredDocument) {
    try {
      const recoveredConfig = normalizeConfig(JSON.parse(recoveredDocument), {
        pathMappings: options.pathMappings || [],
      });
      await writeConfigFile(paths, recoveredConfig, options);
      return recoveredConfig;
    } catch {
      // Fall back to a clean config file below.
    }
  }

  const replacement = createDefaultConfig();
  await writeConfigFile(paths, replacement, options);
  return replacement;
}

async function readConfigFile(paths, options = {}) {
  if (!(await fs.pathExists(paths.configFile))) {
    const config = createDefaultConfig();
    await writeConfigFile(paths, config, options);
    return config;
  }

  const raw = await fs.readFile(paths.configFile, 'utf8');
  if (!raw.trim()) {
    const config = createDefaultConfig();
    await writeConfigFile(paths, config, options);
    return config;
  }

  try {
    const config = normalizeConfig(JSON.parse(raw), {
      pathMappings: options.pathMappings || [],
    });
    cachedConfigSnapshot = config;
    return config;
  } catch {
    return recoverConfigFile(paths, raw, options);
  }
}

async function prepareStorage() {
  const initialPaths = getAppPaths();
  await Promise.all([
    fs.ensureDir(initialPaths.configRoot),
    fs.ensureDir(initialPaths.localRoot),
  ]);

  for (const legacyRoot of initialPaths.legacyConfigRoots) {
    await mergeLegacyConfigRoot(initialPaths, legacyRoot);
  }

  const config = await readConfigFile(initialPaths);
  const paths = getAppPaths(config);
  await Promise.all([
    fs.ensureDir(paths.configRoot),
    fs.ensureDir(paths.toolsRoot),
    fs.ensureDir(paths.snapshotsRoot),
    fs.ensureDir(paths.downloadsRoot),
    fs.ensureDir(paths.modelsRoot),
    fs.ensureDir(paths.runtimesRoot),
    fs.ensureDir(paths.logsRoot),
    fs.ensureDir(paths.tempRoot),
    fs.ensureDir(paths.cacheRoot),
  ]);

  await writeUninstallCleanupMetadata(paths);
  return paths;
}

async function ensureStorage() {
  if (!storageReadyPromise) {
    storageReadyPromise = prepareStorage().catch((error) => {
      storageReadyPromise = null;
      throw error;
    });
  }

  return storageReadyPromise;
}

async function readConfig() {
  return queueConfigOperation(async () => {
    const paths = await ensureStorage();
    return readConfigFile(paths);
  });
}

async function writeConfig(config, options = {}) {
  return queueConfigOperation(async () => {
    const paths = await ensureStorage();
    return writeConfigFile(paths, config, options);
  });
}

async function updateConfig(mutator, options = {}) {
  return queueConfigOperation(async () => {
    const paths = await ensureStorage();
    const current = await readConfigFile(paths);
    const next = (await mutator(current)) || current;
    return writeConfigFile(paths, next, options);
  });
}

async function listGraphWorkflowPresets() {
  const config = await readConfig();
  return normalizeGraphWorkflowPresets(config.graphWorkflowPresets);
}

async function upsertGraphWorkflowPreset(preset) {
  const validation = validateGraphWorkflowPresetConfig(preset || {});
  if (!validation.ok) {
    throw new Error(validation.message || 'Fix the graph workflow preset contract before saving it.');
  }

  const normalizedPreset = normalizeGraphWorkflowPresetRecord(preset || {}, { touch: true });
  return updateConfig((config) => {
    const currentPresets = normalizeGraphWorkflowPresets(config.graphWorkflowPresets);
    const nextPresets = [
      ...currentPresets.filter((entry) => entry.id !== normalizedPreset.id),
      normalizedPreset,
    ].sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' }));
    return {
      ...config,
      graphWorkflowPresets: nextPresets,
    };
  });
}

async function deleteGraphWorkflowPreset(presetId) {
  const normalizedPresetId = String(presetId || '').trim();
  if (!normalizedPresetId) {
    throw new Error('Choose a graph workflow preset before deleting it.');
  }

  return updateConfig((config) => {
    const currentPresets = normalizeGraphWorkflowPresets(config.graphWorkflowPresets);
    const nextPresets = currentPresets.filter((entry) => entry.id !== normalizedPresetId);
    if (nextPresets.length === currentPresets.length) {
      throw new Error('That graph workflow preset could not be found.');
    }

    return {
      ...config,
      graphWorkflowPresets: nextPresets,
    };
  });
}

async function listPromptStyles() {
  const config = await readConfig();
  return normalizePromptStylePresets(config.promptStyles);
}

async function upsertPromptStyle(promptStyle) {
  const normalizedStyle = normalizePromptStylePreset(promptStyle || {}, { touch: true });
  if (!String(normalizedStyle.name || '').trim()) {
    throw new Error('Enter a prompt style name before saving it.');
  }

  return updateConfig((config) => {
    const currentStyles = normalizePromptStylePresets(config.promptStyles);
    const nextStyles = [
      ...currentStyles.filter((entry) => entry.id !== normalizedStyle.id),
      normalizedStyle,
    ].sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' }));
    return {
      ...config,
      promptStyles: nextStyles,
    };
  });
}

async function deletePromptStyle(promptStyleId) {
  const normalizedStyleId = String(promptStyleId || '').trim();
  if (!normalizedStyleId) {
    throw new Error('Choose a prompt style before deleting it.');
  }

  return updateConfig((config) => {
    const currentStyles = normalizePromptStylePresets(config.promptStyles);
    const nextStyles = currentStyles.filter((entry) => entry.id !== normalizedStyleId);
    if (nextStyles.length === currentStyles.length) {
      throw new Error('That prompt style could not be found.');
    }

    return {
      ...config,
      promptStyles: nextStyles,
    };
  });
}

async function saveHardwareDetection(hardware) {
  return updateConfig((config) => ({
    ...config,
    hardware,
  }));
}

async function markFirstLaunchComplete() {
  return updateConfig((config) => ({
    ...config,
    firstLaunchCompleted: true,
  }));
}

async function upsertTool(toolState) {
  return updateConfig((config) => ({
    ...config,
    ignoredToolIds: normalizeIgnoredToolIds(config.ignoredToolIds).filter((toolId) => toolId !== toolState.id),
    tools: {
      ...config.tools,
      [toolState.id]: {
        ...config.tools[toolState.id],
        ...toolState,
      },
    },
  }));
}

async function removeTool(toolId) {
  return updateConfig((config) => {
    const nextTools = {
      ...config.tools,
    };
    delete nextTools[toolId];

    return {
      ...config,
      tools: nextTools,
    };
  });
}

async function setToolIgnored(toolId, ignored) {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  if (!normalizedToolId) {
    return readConfig();
  }

  return updateConfig((config) => {
    const currentIgnoredToolIds = normalizeIgnoredToolIds(config.ignoredToolIds);
    const nextIgnoredToolIds = ignored
      ? [...new Set([...currentIgnoredToolIds, normalizedToolId])]
      : currentIgnoredToolIds.filter((entry) => entry !== normalizedToolId);

    return {
      ...config,
      ignoredToolIds: nextIgnoredToolIds,
    };
  });
}

function humanizeError(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) {
    return fallback;
  }

  return sanitizeUserMessage(error.message || error, fallback);
}

module.exports = {
  APP_DATA_DIR_NAME,
  LEGACY_APP_DATA_DIR_NAMES,
  MANAGED_DATA_SUBDIRECTORIES,
  buildManagedPathMappings,
  buildManagedSubdirectoryPaths,
  createDefaultConfig,
  deleteGraphWorkflowPreset,
  deletePromptStyle,
  ensureStorage,
  getAppPaths,
  getStorageRoots,
  humanizeError,
  listGraphWorkflowPresets,
  listPromptStyles,
  markFirstLaunchComplete,
  normalizeDirectoryPath,
  normalizeOptionalDirectoryPath,
  normalizePathList,
  readConfig,
  removeTool,
  saveHardwareDetection,
  setToolIgnored,
  updateConfig,
  upsertGraphWorkflowPreset,
  upsertPromptStyle,
  upsertTool,
  writeConfig,
};

