const path = require('path');
const fs = require('fs-extra');

const { getLoadedToolManifest, loadToolManifest } = require('./manifestService');

let cachedToolDefinitions = null;
let cachedToolManifestKey = '';

const DEFAULT_EXTERNAL_CANDIDATES = {
  comfyui: {
    externalBatchCandidates: ['run_nvidia_gpu.bat', 'run_cpu.bat', '..\\run_nvidia_gpu.bat', '..\\run_cpu.bat'],
    externalPythonCandidates: [
      'python_embeded\\python.exe',
      'python_embedded\\python.exe',
      '..\\python_embeded\\python.exe',
      '..\\python_embedded\\python.exe',
      '.venv\\Scripts\\python.exe',
      'venv\\Scripts\\python.exe',
    ],
  },
  automatic1111: {
    externalBatchCandidates: ['webui-user.bat', 'webui.bat'],
  },
  forge: {
    externalBatchCandidates: ['webui-user.bat', 'webui.bat', 'run.bat'],
    externalPythonCandidates: ['venv\\Scripts\\python.exe', '.venv\\Scripts\\python.exe'],
  },
  invokeai: {
    externalExecutableCandidates: [
      '.venv\\Scripts\\invokeai-web.exe',
      'venv\\Scripts\\invokeai-web.exe',
      'Scripts\\invokeai-web.exe',
      'invokeai-web.exe',
      'invokeai.exe',
    ],
  },
  ollama: {
    externalExecutableCandidates: ['ollama.exe'],
  },
  lmstudio: {
    externalExecutableCandidates: ['LM Studio.exe'],
  },
  openwebui: {
    externalExecutableCandidates: ['open-webui.exe'],
    externalPythonCandidates: ['Scripts\\python.exe', '.venv\\Scripts\\python.exe', 'venv\\Scripts\\python.exe'],
  },
  whisper: {
    externalPythonCandidates: ['Scripts\\python.exe', '.venv\\Scripts\\python.exe', 'venv\\Scripts\\python.exe'],
  },
  koboldcpp: {
    externalExecutableCandidates: ['koboldcpp.exe', 'koboldcpp_nocuda.exe', 'koboldcpp_oldpc.exe'],
  },
};

const DEFAULT_DISCOVERY = {
  comfyui: {
    folderNames: ['ComfyUI', 'comfyui', 'ComfyUI-master', 'ComfyUI_windows_portable', 'ComfyUI_portable'],
    markerPaths: ['main.py', 'ComfyUI\\main.py', 'run_nvidia_gpu.bat', 'run_cpu.bat'],
    pathExecutables: [],
    pythonModules: [],
  },
  ollama: {
    folderNames: ['Ollama', 'ollama'],
    markerPaths: ['ollama.exe'],
    pathExecutables: ['ollama.exe'],
    pythonModules: [],
  },
  automatic1111: {
    folderNames: ['stable-diffusion-webui', 'stable-diffusion-webui-master', 'automatic1111', 'AUTOMATIC1111', 'sd-webui'],
    markerPaths: ['webui.py', 'webui-user.bat', 'webui.bat'],
    pathExecutables: [],
    pythonModules: [],
  },
  forge: {
    folderNames: ['stable-diffusion-webui-forge', 'stable-diffusion-webui-forge-master', 'webui_forge_cu121_torch231', 'webui_forge_cu124_torch24'],
    markerPaths: ['modules_forge\\shared.py', 'webui-user.bat', 'webui.py', 'run.bat'],
    pathExecutables: [],
    pythonModules: [],
  },
  invokeai: {
    folderNames: ['InvokeAI', 'invokeai', 'InvokeAI-main'],
    markerPaths: ['invokeai-web.exe', 'invokeai.exe', 'pyproject.toml'],
    pathExecutables: ['invokeai-web.exe', 'invokeai.exe'],
    pythonModules: [],
  },
  lmstudio: {
    folderNames: ['LM Studio', 'LMStudio', 'lm-studio'],
    markerPaths: ['LM Studio.exe'],
    pathExecutables: ['LM Studio.exe'],
    pythonModules: [],
  },
  openwebui: {
    folderNames: ['Open WebUI', 'open-webui', 'open_webui'],
    markerPaths: ['open-webui.exe', 'open_webui\\__init__.py', 'pyproject.toml'],
    pathExecutables: ['open-webui.exe'],
    pythonModules: ['open_webui'],
  },
  whisper: {
    folderNames: ['faster-whisper', 'faster_whisper', 'Whisper'],
    markerPaths: ['faster_whisper\\__init__.py', 'pyproject.toml'],
    pathExecutables: [],
    pythonModules: ['faster_whisper'],
  },
  koboldcpp: {
    folderNames: ['koboldcpp', 'KoboldCpp', 'KoboldAI'],
    markerPaths: ['koboldcpp.exe', 'koboldcpp_nocuda.exe', 'koboldcpp_oldpc.exe'],
    pathExecutables: ['koboldcpp.exe', 'koboldcpp_nocuda.exe', 'koboldcpp_oldpc.exe'],
    pythonModules: [],
  },
};

function mergeUnique(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

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
    if (!firstToken || firstToken.startsWith('embedded://')) {
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

function buildDiscoveryDefaults(tool) {
  const defaults = DEFAULT_DISCOVERY[tool.id] || {
    folderNames: [tool.name, tool.id],
    markerPaths: [],
    pathExecutables: [],
    pythonModules: [],
  };

  const manifestCommands = [tool.launchCommand, tool.externalLaunchCommand]
    .filter(Boolean)
    .map((command) => tokenizeCommand(command)[0])
    .filter((entry) => /\.(exe|cmd|bat)$/i.test(entry || ''))
    .map((entry) => path.basename(entry));

  return {
    folderNames: mergeUnique(defaults.folderNames),
    markerPaths: mergeUnique(defaults.markerPaths),
    pathExecutables: mergeUnique([...defaults.pathExecutables, ...manifestCommands]),
    pythonModules: mergeUnique(defaults.pythonModules),
  };
}

function normalizeToolDefinition(tool) {
  const installInstructions = tool.installInstructions || {};
  const defaultExternalCandidates = DEFAULT_EXTERNAL_CANDIDATES[tool.id] || {};
  const discoveryDefaults = buildDiscoveryDefaults(tool);
  const launchUrl = buildLaunchUrl(tool);

  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    icon: tool.icon || tool.name.slice(0, 2).toUpperCase(),
    category: tool.category || 'General',
    downloadUrl: tool.downloadUrl,
    interfaceMode: tool.interfaceMode || 'external-browser',
    launchEnv: tool.launchEnv || {},
    externalLaunchEnv: tool.externalLaunchEnv || tool.launchEnv || {},
    installInstructions: {
      kind: installInstructions.kind || 'zip',
      runtime: installInstructions.runtime || 'binary',
      archiveName: deriveArchiveName(tool.downloadUrl, installInstructions.archiveName),
      downloadFileName: installInstructions.downloadFileName || null,
      installSummary: installInstructions.installSummary || 'Downloads and configures this tool inside Local AI Hub.',
      venvFolder: installInstructions.venvFolder || '.venv',
      configTargets: installInstructions.configTargets || [],
      pythonRequirementDetection: installInstructions.pythonRequirementDetection || [],
      pipInstalls: installInstructions.pipInstalls || [],
      installerArgs: installInstructions.installerArgs || [],
      externalPythonCandidates: mergeUnique([
        ...(defaultExternalCandidates.externalPythonCandidates || []),
        ...(installInstructions.externalPythonCandidates || []),
      ]),
      externalExecutableCandidates: mergeUnique([
        ...(defaultExternalCandidates.externalExecutableCandidates || []),
        ...(installInstructions.externalExecutableCandidates || []),
      ]),
      externalBatchCandidates: mergeUnique([
        ...(defaultExternalCandidates.externalBatchCandidates || []),
        ...(installInstructions.externalBatchCandidates || []),
      ]),
      compatibility: installInstructions.compatibility || null,
    },
    launchCommand: tool.launchCommand,
    externalLaunchCommand: tool.externalLaunchCommand || tool.launchCommand,
    defaultPort: tool.defaultPort || null,
    detectionPaths: tool.detectionPaths || [],
    discovery: {
      folderNames: mergeUnique([...(tool.discovery?.folderNames || []), ...discoveryDefaults.folderNames]),
      markerPaths: mergeUnique([...(tool.discovery?.markerPaths || []), ...discoveryDefaults.markerPaths]),
      pathExecutables: mergeUnique([...(tool.discovery?.pathExecutables || []), ...discoveryDefaults.pathExecutables]),
      pythonModules: mergeUnique([...(tool.discovery?.pythonModules || []), ...discoveryDefaults.pythonModules]),
    },
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

function resolveCommandPath(token, baseDir, explicitPath = null, options = {}) {
  if (explicitPath) {
    return explicitPath;
  }

  if (!token) {
    return null;
  }

  if (options.allowBareCommandLookup && !path.isAbsolute(token) && !/[\\/]/.test(token)) {
    return token;
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

  if (tokens[0].startsWith('embedded://')) {
    return {
      kind: 'embedded',
      target: tokens[0].slice('embedded://'.length),
      pythonPath: context.pythonPath || null,
      workingDir: context.workingDir || context.baseDir,
      env: context.env || {},
    };
  }

  const head = tokens[0].toLowerCase();
  if (head === 'python' || head === 'py' || head.endsWith('python.exe')) {
    const pythonPath =
      context.pythonPath ||
      resolveCommandPath(tokens[0], context.baseDir, null, {
        allowBareCommandLookup: Boolean(context.allowBarePythonCommand),
      });

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
        env: context.env || {},
      };
    }

    return {
      kind: 'python-script',
      pythonPath,
      workingDir: context.workingDir || context.baseDir,
      target: tokens[1],
      args: tokens.slice(2),
      env: context.env || {},
    };
  }

  if (/\.(bat|cmd)$/i.test(tokens[0])) {
    return {
      kind: 'batch',
      command: resolveCommandPath(tokens[0], context.baseDir, context.executablePath),
      workingDir: context.workingDir || context.baseDir,
      args: tokens.slice(1),
      env: context.env || {},
    };
  }

  const executable = resolveCommandPath(tokens[0], context.baseDir, context.executablePath);
  return {
    kind: 'binary',
    executable,
    workingDir: context.workingDir || path.dirname(executable),
    args: tokens.slice(1),
    env: context.env || {},
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
    env: manifest.launchEnv || {},
  });
}

function buildExternalLaunchProfile(manifest, installDir, detectedPath = null) {
  const launchCommand = manifest.externalLaunchCommand || manifest.launchCommand;
  const installInstructions = manifest.installInstructions || {};
  const baseContext = {
    baseDir: installDir,
    workingDir: installDir,
    port: manifest.defaultPort,
    env: manifest.externalLaunchEnv || manifest.launchEnv || {},
  };
  const detectedPythonPath = detectedPath && /python(?:\.exe)?$/i.test(path.basename(detectedPath)) ? detectedPath : null;

  if (/^(python|py)(\s|$)/i.test(launchCommand)) {
    const pythonRelative = firstExistingRelativePath(installDir, installInstructions.externalPythonCandidates);
    const pythonPath = detectedPythonPath || (pythonRelative ? path.join(installDir, pythonRelative) : null);
    if (pythonPath) {
      return buildLaunchProfileFromCommand(launchCommand, {
        ...baseContext,
        pythonPath,
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
      pythonPath: detectedPythonPath,
    });

    if (profile) {
      return profile;
    }
  }

  const directProfile = buildLaunchProfileFromCommand(launchCommand, {
    ...baseContext,
    pythonPath: detectedPythonPath,
  });
  if (directProfile?.kind !== 'python-script' && directProfile?.kind !== 'python-module') {
    return directProfile;
  }

  const pathAwareProfile = buildLaunchProfileFromCommand(launchCommand, {
    ...baseContext,
    allowBarePythonCommand: true,
    pythonPath: detectedPythonPath,
  });
  if (pathAwareProfile) {
    return pathAwareProfile;
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
