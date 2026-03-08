const path = require('path');
const fs = require('fs-extra');

const { readConfig, updateConfig } = require('./configService');
const { runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const { buildExternalLaunchProfile, getToolDefinitions, initializeToolRegistry } = require('./toolRegistry');

const DISCOVERY_TTL_MS = 60000;
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

async function fileExists(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isFile();
  } catch {
    return false;
  }
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
    };
  }

  const expandedPath = expandDetectionPath(detectionPath);
  if (!expandedPath || !(await fs.pathExists(expandedPath))) {
    return null;
  }

  const stats = await fs.stat(expandedPath);
  return {
    detectedPath: expandedPath,
    installDir: stats.isDirectory() ? expandedPath : path.dirname(expandedPath),
    displayPath: expandedPath,
    fromPath: false,
  };
}

async function discoverInstallLocation(manifest, logger) {
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

async function discoverExternalTool(manifest, existingTool, logger) {
  const detected = await discoverInstallLocation(manifest, logger);
  if (!detected) {
    return null;
  }

  const launchProfile = buildExternalLaunchProfile(manifest, detected.installDir, detected.fromPath ? detected.detectedPath : null);
  const launchSupported = launchProfile.kind !== 'folder';

  return {
    ...existingTool,
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
    externalExecutablePath: detected.fromPath ? detected.detectedPath : null,
    launchProfile,
    launchSupported,
    launchUrl: manifest.launchUrl,
    healthUrl: manifest.healthUrl,
    processNames: manifest.processNames || existingTool?.processNames || [],
    detectedAt: new Date().toISOString(),
    installedAt: existingTool?.installedAt || new Date().toISOString(),
    status: existingTool?.status || 'stopped',
    lastRepairMessage: null,
    venvDir: null,
    configTargets: manifest.installInstructions.configTargets,
    executablePath:
      launchProfile.kind === 'binary'
        ? launchProfile.executable
        : detected.fromPath
          ? detected.detectedPath
          : existingTool?.executablePath || null,
    snapshots: existingTool?.snapshots || [],
  };
}

async function managedToolIsPresent(tool) {
  if (!tool || tool.source !== 'managed') {
    return false;
  }

  if (tool.launchProfile?.kind === 'binary' && tool.launchProfile?.executable) {
    return fs.pathExists(tool.launchProfile.executable);
  }

  if ((tool.launchProfile?.kind === 'python-script' || tool.launchProfile?.kind === 'python-module') && tool.launchProfile?.pythonPath) {
    return fs.pathExists(tool.launchProfile.pythonPath);
  }

  if (tool.installDir) {
    return fs.pathExists(tool.installDir);
  }

  return false;
}

async function performDiscoveryScan() {
  await initializeToolRegistry();

  const logger = createLogger('discovery');
  const config = await readConfig();
  const nextTools = {};

  for (const manifest of getToolDefinitions()) {
    const existingTool = config.tools[manifest.id];

    if (existingTool?.source === 'managed') {
      nextTools[manifest.id] = existingTool;
      const present = await managedToolIsPresent(existingTool);
      if (!present) {
        await logger.warn('Local AI Hub-managed tool is configured but its files are missing.', {
          toolId: manifest.id,
          installDir: existingTool.installDir,
        });
      }
      continue;
    }

    const discovered = await discoverExternalTool(manifest, existingTool, logger);
    if (discovered) {
      nextTools[manifest.id] = discovered;
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
