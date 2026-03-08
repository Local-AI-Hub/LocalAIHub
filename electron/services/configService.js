const path = require('path');
const fs = require('fs-extra');
const { app } = require('electron');

const CONFIG_VERSION = 2;
const APP_DATA_DIR_NAME = 'LocalAIHub';
const LEGACY_APP_DATA_DIR_NAMES = ['NestAI'];
let configOperationQueue = Promise.resolve();
let storageReadyPromise = null;

function getStorageRoots() {
  const appDataRoot = app.getPath('appData');
  const root = path.join(appDataRoot, APP_DATA_DIR_NAME);
  return {
    appDataRoot,
    root,
    legacyRoots: LEGACY_APP_DATA_DIR_NAMES.map((name) => path.join(appDataRoot, name)).filter((entry) => entry !== root),
  };
}

function getAppPaths() {
  const storage = getStorageRoots();
  return {
    ...storage,
    configFile: path.join(storage.root, 'config.json'),
    toolsRoot: path.join(storage.root, 'tools'),
    snapshotsRoot: path.join(storage.root, 'snapshots'),
    downloadsRoot: path.join(storage.root, 'downloads'),
    logsRoot: path.join(storage.root, 'logs'),
  };
}

function createDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    firstLaunchCompleted: false,
    hardware: null,
    tools: {},
  };
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
  for (const mapping of pathMappings) {
    if (!mapping.from || !mapping.to) {
      continue;
    }

    if (nextValue === mapping.from || nextValue.startsWith(`${mapping.from}${path.sep}`)) {
      nextValue = `${mapping.to}${nextValue.slice(mapping.from.length)}`;
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
      tools,
    },
    pathMappings,
  );
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

async function migrateLegacyRoot(paths, legacyRoot) {
  if (!legacyRoot || !(await fs.pathExists(legacyRoot))) {
    return;
  }

  if (!(await fs.pathExists(paths.root))) {
    await fs.move(legacyRoot, paths.root, { overwrite: false });
  } else {
    await fs.copy(legacyRoot, paths.root, { overwrite: false, errorOnExist: false, preserveTimestamps: true });

    await mergeJsonFiles(paths.configFile, path.join(legacyRoot, 'config.json'), (targetJson, sourceJson) => ({
      ...normalizeConfig(sourceJson),
      ...normalizeConfig(targetJson),
      tools: {
        ...(normalizeConfig(sourceJson).tools || {}),
        ...(normalizeConfig(targetJson).tools || {}),
      },
    }));

    await mergeJsonFiles(
      path.join(paths.root, 'model-manager.settings.json'),
      path.join(legacyRoot, 'model-manager.settings.json'),
      (targetJson, sourceJson) => ({
        ...(sourceJson || {}),
        ...(targetJson || {}),
      }),
    );

    await fs.remove(legacyRoot);
  }

  const pathMappings = [{ from: legacyRoot, to: paths.root }];
  if (await fs.pathExists(paths.configFile)) {
    const rawConfig = await fs.readJson(paths.configFile).catch(() => createDefaultConfig());
    await fs.writeJson(paths.configFile, normalizeConfig(rawConfig, { pathMappings }), { spaces: 2 });
  }
}

async function prepareStorage() {
  const paths = getAppPaths();

  for (const legacyRoot of paths.legacyRoots) {
    await migrateLegacyRoot(paths, legacyRoot);
  }

  await Promise.all([
    fs.ensureDir(paths.root),
    fs.ensureDir(paths.toolsRoot),
    fs.ensureDir(paths.snapshotsRoot),
    fs.ensureDir(paths.downloadsRoot),
    fs.ensureDir(paths.logsRoot),
  ]);

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

function queueConfigOperation(operation) {
  const next = configOperationQueue.then(operation, operation);
  configOperationQueue = next.catch(() => null);
  return next;
}

async function writeConfigFile(paths, config) {
  const normalized = normalizeConfig(config, {
    pathMappings: paths.legacyRoots.map((legacyRoot) => ({ from: legacyRoot, to: paths.root })),
  });
  const tempFile = `${paths.configFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.move(tempFile, paths.configFile, { overwrite: true });
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

async function recoverConfigFile(paths, raw) {
  const backupPath = path.join(paths.root, `config.corrupt-${Date.now()}.json`);
  await fs.writeFile(backupPath, raw, 'utf8');

  const recoveredDocument = extractFirstJsonDocument(raw);
  if (recoveredDocument) {
    try {
      const recoveredConfig = normalizeConfig(JSON.parse(recoveredDocument), {
        pathMappings: paths.legacyRoots.map((legacyRoot) => ({ from: legacyRoot, to: paths.root })),
      });
      await writeConfigFile(paths, recoveredConfig);
      return recoveredConfig;
    } catch {
      // Fall back to a clean config file below.
    }
  }

  const replacement = createDefaultConfig();
  await writeConfigFile(paths, replacement);
  return replacement;
}

async function readConfigFile(paths) {
  if (!(await fs.pathExists(paths.configFile))) {
    const config = createDefaultConfig();
    await writeConfigFile(paths, config);
    return config;
  }

  const raw = await fs.readFile(paths.configFile, 'utf8');
  if (!raw.trim()) {
    const config = createDefaultConfig();
    await writeConfigFile(paths, config);
    return config;
  }

  try {
    return normalizeConfig(JSON.parse(raw), {
      pathMappings: paths.legacyRoots.map((legacyRoot) => ({ from: legacyRoot, to: paths.root })),
    });
  } catch {
    return recoverConfigFile(paths, raw);
  }
}

async function readConfig() {
  return queueConfigOperation(async () => {
    const paths = await ensureStorage();
    return readConfigFile(paths);
  });
}

async function writeConfig(config) {
  return queueConfigOperation(async () => {
    const paths = await ensureStorage();
    return writeConfigFile(paths, config);
  });
}

async function updateConfig(mutator) {
  return queueConfigOperation(async () => {
    const paths = await ensureStorage();
    const current = await readConfigFile(paths);
    const next = (await mutator(current)) || current;
    return writeConfigFile(paths, next);
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
    tools: {
      ...config.tools,
      [toolState.id]: {
        ...config.tools[toolState.id],
        ...toolState,
      },
    },
  }));
}

function humanizeError(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) {
    return fallback;
  }

  const rawMessage = String(error.message || error).trim();
  if (!rawMessage) {
    return fallback;
  }

  const firstLine = rawMessage.split(/\r?\n/).find(Boolean) || fallback;
  return firstLine.replace(/^Error:\s*/i, '');
}

module.exports = {
  APP_DATA_DIR_NAME,
  LEGACY_APP_DATA_DIR_NAMES,
  createDefaultConfig,
  ensureStorage,
  getAppPaths,
  getStorageRoots,
  humanizeError,
  markFirstLaunchComplete,
  readConfig,
  saveHardwareDetection,
  updateConfig,
  upsertTool,
  writeConfig,
};
