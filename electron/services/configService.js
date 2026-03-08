const path = require('path');
const fs = require('fs-extra');
const { app } = require('electron');

const CONFIG_VERSION = 1;
let configOperationQueue = Promise.resolve();

function getAppPaths() {
  const root = path.join(app.getPath('appData'), 'NestAI');
  return {
    root,
    configFile: path.join(root, 'config.json'),
    toolsRoot: path.join(root, 'tools'),
    snapshotsRoot: path.join(root, 'snapshots'),
    downloadsRoot: path.join(root, 'downloads'),
    logsRoot: path.join(root, 'logs'),
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

function normalizeConfig(config) {
  return {
    ...createDefaultConfig(),
    ...(config || {}),
    tools: config?.tools || {},
  };
}

async function ensureStorage() {
  const paths = getAppPaths();
  await Promise.all([
    fs.ensureDir(paths.root),
    fs.ensureDir(paths.toolsRoot),
    fs.ensureDir(paths.snapshotsRoot),
    fs.ensureDir(paths.downloadsRoot),
    fs.ensureDir(paths.logsRoot),
  ]);
  return paths;
}

function queueConfigOperation(operation) {
  const next = configOperationQueue.then(operation, operation);
  configOperationQueue = next.catch(() => null);
  return next;
}

async function writeConfigFile(paths, config) {
  const normalized = normalizeConfig(config);
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
      const recoveredConfig = normalizeConfig(JSON.parse(recoveredDocument));
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
    return normalizeConfig(JSON.parse(raw));
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
  createDefaultConfig,
  ensureStorage,
  getAppPaths,
  humanizeError,
  markFirstLaunchComplete,
  readConfig,
  saveHardwareDetection,
  updateConfig,
  upsertTool,
  writeConfig,
};
