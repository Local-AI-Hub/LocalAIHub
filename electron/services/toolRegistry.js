const path = require('path');
const fs = require('fs-extra');

const { getLoadedToolManifest, loadToolManifest } = require('./manifestService');

let cachedToolDefinitions = null;
let cachedToolManifestKey = '';

function tokenizeCommand(command) {
  const matches = String(command || '').match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function replaceTemplateValue(token, replacements) {
  return String(token || '').replace(/\{([^}]+)\}/g, (_match, key) => {
    const value = replacements[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function deriveArchiveName(downloadUrl, explicitName) {
  if (explicitName) {
    return explicitName;
  }

  try {
    return path.basename(new URL(downloadUrl).pathname) || 'tool-package.zip';
  } catch {
    return 'tool-package.zip';
  }
}

function buildLaunchUrl(tool) {
  if (tool.launchUrl) {
    return tool.launchUrl;
  }

  if (!tool.defaultPort) {
    return null;
  }

  return `http://127.0.0.1:${tool.defaultPort}`;
}

function buildHealthUrl(tool, launchUrl) {
  if (tool.healthUrl) {
    return tool.healthUrl;
  }

  if (!launchUrl) {
    return null;
  }

  if (!tool.healthCheckPath) {
    return launchUrl;
  }

  try {
    return new URL(tool.healthCheckPath, `${launchUrl.replace(/\/$/, '')}/`).toString();
  } catch {
    return launchUrl;
  }
}

function deriveProcessNames(tool) {
  const candidates = [tool.launchCommand, tool.externalLaunchCommand].filter(Boolean);
  const names = new Set();

  for (const command of candidates) {
    const firstToken = tokenizeCommand(command)[0];
    if (!firstToken) {
      continue;
    }

    const baseName = path.basename(firstToken).toLowerCase();
    if (!baseName || baseName === 'python' || baseName === 'py' || baseName === 'python.exe') {
      continue;
    }

    names.add(baseName);
  }

  return [...names];
}

function normalizeToolDefinition(tool) {
  const installInstructions = tool.installInstructions || {};
  const launchUrl = buildLaunchUrl(tool);

  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    icon: tool.icon || tool.name.slice(0, 2).toUpperCase(),
    category: tool.category || 'General',
    downloadUrl: tool.downloadUrl,
    interfaceMode: tool.interfaceMode || 'external-browser',
    installInstructions: {
      kind: installInstructions.kind || 'zip',
      runtime: installInstructions.runtime || 'binary',
      archiveName: deriveArchiveName(tool.downloadUrl, installInstructions.archiveName),
      installSummary: installInstructions.installSummary || 'Downloads and configures this tool inside NestAI.',
      venvFolder: installInstructions.venvFolder || '.venv',
      configTargets: installInstructions.configTargets || [],
      pythonRequirementDetection: installInstructions.pythonRequirementDetection || [],
      pipInstalls: installInstructions.pipInstalls || [],
      externalPythonCandidates: installInstructions.externalPythonCandidates || [],
      externalExecutableCandidates: installInstructions.externalExecutableCandidates || [],
      externalBatchCandidates: installInstructions.externalBatchCandidates || [],
      compatibility: installInstructions.compatibility || null,
    },
    launchCommand: tool.launchCommand,
    externalLaunchCommand: tool.externalLaunchCommand || tool.launchCommand,
    defaultPort: tool.defaultPort || null,
    detectionPaths: tool.detectionPaths || [],
    launchUrl,
    healthUrl: buildHealthUrl(tool, launchUrl),
    processNames: tool.processNames || deriveProcessNames(tool),
  };
}

function loadToolDefinitions() {
  const rawTools = getLoadedToolManifest();
  const manifestKey = JSON.stringify(rawTools);

  if (!cachedToolDefinitions || cachedToolManifestKey !== manifestKey) {
    cachedToolDefinitions = rawTools.map(normalizeToolDefinition);
    cachedToolManifestKey = manifestKey;
  }

  return cachedToolDefinitions;
}

async function initializeToolRegistry(options = {}) {
  await loadToolManifest({ refreshRemote: Boolean(options.refreshRemote) });
  return loadToolDefinitions();
}

function getToolManifest(toolId) {
  return loadToolDefinitions().find((tool) => tool.id === toolId);
}

function getToolCatalog() {
  return loadToolDefinitions().map((tool) => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    icon: tool.icon,
    category: tool.category,
    defaultPort: tool.defaultPort,
    launchUrl: tool.launchUrl,
    interfaceMode: tool.interfaceMode,
    installSummary: tool.installInstructions.installSummary,
    downloadUrl: tool.downloadUrl,
    compatibility: tool.installInstructions.compatibility,
  }));
}

function getToolDefinitions() {
  return loadToolDefinitions();
}

function firstExistingRelativePath(basePath, relativePaths = []) {
  return relativePaths.find((relativePath) => fs.existsSync(path.join(basePath, relativePath))) || null;
}

function resolveCommandPath(token, baseDir, explicitPath = null) {
  if (explicitPath) {
    return explicitPath;
  }

  if (!token) {
    return null;
  }

  if (path.isAbsolute(token)) {
    return token;
  }

  return path.join(baseDir, token);
}

function createFolderOnlyProfile(installDir) {
  return {
    kind: 'folder',
    path: installDir,
  };
}

function buildLaunchProfileFromCommand(command, context = {}) {
  const replacements = {
    port: context.port,
    installDir: context.baseDir,
    workingDir: context.workingDir || context.baseDir,
  };
  const tokens = tokenizeCommand(command).map((token) => replaceTemplateValue(token, replacements)).filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  const head = tokens[0].toLowerCase();
  if (head === 'python' || head === 'py' || head.endsWith('python.exe')) {
    const pythonPath = context.pythonPath || resolveCommandPath(tokens[0], context.baseDir);
    if (!tokens[1]) {
      return null;
    }

    if (tokens[1] === '-m') {
      return {
        kind: 'python-module',
        pythonPath,
        workingDir: context.workingDir || context.baseDir,
        target: tokens[2],
        args: tokens.slice(3),
      };
    }

    return {
      kind: 'python-script',
      pythonPath,
      workingDir: context.workingDir || context.baseDir,
      target: tokens[1],
      args: tokens.slice(2),
    };
  }

  if (/\.(bat|cmd)$/i.test(tokens[0])) {
    return {
      kind: 'batch',
      command: resolveCommandPath(tokens[0], context.baseDir, context.executablePath),
      workingDir: context.workingDir || context.baseDir,
      args: tokens.slice(1),
    };
  }

  const executable = resolveCommandPath(tokens[0], context.baseDir, context.executablePath);
  return {
    kind: 'binary',
    executable,
    workingDir: context.workingDir || path.dirname(executable),
    args: tokens.slice(1),
  };
}

function buildManagedLaunchProfile(toolState, manifest) {
  const pythonPath =
    manifest.installInstructions.runtime === 'python'
      ? path.join(toolState.venvDir, 'Scripts', 'python.exe')
      : null;

  return buildLaunchProfileFromCommand(manifest.launchCommand, {
    baseDir: toolState.appDir,
    workingDir: toolState.appDir,
    pythonPath,
    port: manifest.defaultPort,
  });
}

function buildExternalLaunchProfile(manifest, installDir, detectedPath = null) {
  const launchCommand = manifest.externalLaunchCommand || manifest.launchCommand;
  const installInstructions = manifest.installInstructions || {};
  const baseContext = {
    baseDir: installDir,
    workingDir: installDir,
    port: manifest.defaultPort,
  };

  if (/^(python|py)(\s|$)/i.test(launchCommand)) {
    const pythonRelative = firstExistingRelativePath(installDir, installInstructions.externalPythonCandidates);
    if (pythonRelative) {
      return buildLaunchProfileFromCommand(launchCommand, {
        ...baseContext,
        pythonPath: path.join(installDir, pythonRelative),
      });
    }
  }

  const executableCandidates = [
    detectedPath,
    firstExistingRelativePath(installDir, installInstructions.externalExecutableCandidates),
    firstExistingRelativePath(installDir, installInstructions.externalBatchCandidates),
  ].filter(Boolean);

  for (const candidate of executableCandidates) {
    const executablePath = path.isAbsolute(candidate) ? candidate : path.join(installDir, candidate);
    const profile = buildLaunchProfileFromCommand(launchCommand, {
      ...baseContext,
      executablePath,
    });

    if (profile) {
      return profile;
    }
  }

  const directProfile = buildLaunchProfileFromCommand(launchCommand, baseContext);
  if (directProfile?.kind !== 'python-script' && directProfile?.kind !== 'python-module') {
    return directProfile;
  }

  return createFolderOnlyProfile(installDir);
}

module.exports = {
  buildExternalLaunchProfile,
  buildManagedLaunchProfile,
  buildLaunchProfileFromCommand,
  createFolderOnlyProfile,
  firstExistingRelativePath,
  getToolCatalog,
  getToolDefinitions,
  getToolManifest,
  initializeToolRegistry,
  tokenizeCommand,
};
