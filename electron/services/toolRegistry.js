const path = require('path');
const fs = require('fs-extra');

const { getLoadedToolManifest, loadToolManifest } = require('./manifestService');
const { assertSafeCommandString, assertSecureRemoteUrl, sanitizeManifestId } = require('./pathSafetyService');
const { getToolPipelineCapabilities } = require('../shared/pipelineCapabilities.cjs');
const { getManifestInstallContract } = require('./toolLifecycleService');

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

function getEffectiveHealthCheckPath(tool) {
  const requestedPath = String(tool?.healthCheckPath || '').trim();
  if (tool?.id === 'automatic1111' || tool?.id === 'forge') {
    return '/sdapi/v1/sd-models';
  }

  return requestedPath;
}

function buildHealthUrl(tool, launchUrl) {
  if (tool.healthUrl) {
    return tool.healthUrl;
  }

  if (!launchUrl) {
    return null;
  }

  const healthCheckPath = getEffectiveHealthCheckPath(tool);
  if (!healthCheckPath) {
    return launchUrl;
  }

  try {
    return new URL(healthCheckPath, `${launchUrl.replace(/\/$/, '')}/`).toString();
  } catch {
    return launchUrl;
  }
}

function normalizeLaunchModeId(value, fallback = 'default') {
  return sanitizeManifestId(String(value || fallback).trim().toLowerCase());
}

function hasOwnValue(target, key) {
  return Object.prototype.hasOwnProperty.call(target || {}, key);
}

function getLaunchModeLabel(modeId, interfaceMode) {
  if (modeId === 'webui') {
    return 'Web UI';
  }

  if (modeId === 'desktop') {
    return 'Desktop App';
  }

  if (modeId === 'service') {
    return 'Service';
  }

  if (modeId === 'cli') {
    return 'CLI';
  }

  if (String(interfaceMode || '').startsWith('embedded-')) {
    return 'Built-in Interface';
  }

  return 'Launch';
}

function normalizeLaunchMode(tool, rawMode, index = 0) {
  const mode = rawMode && typeof rawMode === 'object' ? rawMode : {};
  const interfaceMode = mode.interfaceMode || tool.interfaceMode || 'external-browser';
  const launchCommand = assertSafeCommandString(
    mode.launchCommand || tool.launchCommand,
    `${tool.id} launch mode ${mode.id || index + 1} command`,
  );
  const externalLaunchCommand = mode.externalLaunchCommand
    ? assertSafeCommandString(mode.externalLaunchCommand, `${tool.id} launch mode ${mode.id || index + 1} external command`)
    : tool.externalLaunchCommand || launchCommand;
  const defaultPort = hasOwnValue(mode, 'defaultPort') ? mode.defaultPort : tool.defaultPort || null;
  const launchUrl = hasOwnValue(mode, 'launchUrl')
    ? mode.launchUrl || null
    : interfaceMode === 'desktop-app'
      ? null
      : buildLaunchUrl({
          launchUrl: tool.launchUrl,
          defaultPort,
        });
  const healthUrl = hasOwnValue(mode, 'healthUrl')
    ? mode.healthUrl || null
    : launchUrl
      ? buildHealthUrl(
          {
            ...tool,
            healthCheckPath: hasOwnValue(mode, 'healthCheckPath') ? mode.healthCheckPath : tool.healthCheckPath,
            healthUrl: null,
          },
          launchUrl,
        )
      : null;
  const id = normalizeLaunchModeId(mode.id, index === 0 ? 'default' : `mode-${index + 1}`);

  return {
    id,
    capability: mode.capability || (id === 'desktop' ? 'desktop' : id === 'webui' ? 'webui' : id),
    label: mode.label || getLaunchModeLabel(id, interfaceMode),
    kind: mode.kind || id,
    interfaceMode,
    launchCommand,
    externalLaunchCommand,
    launchEnv: mode.launchEnv || tool.launchEnv || {},
    externalLaunchEnv: mode.externalLaunchEnv || tool.externalLaunchEnv || mode.launchEnv || tool.launchEnv || {},
    launchEnvironment: mode.launchEnvironment && typeof mode.launchEnvironment === 'object' && !Array.isArray(mode.launchEnvironment)
      ? mode.launchEnvironment
      : tool.launchEnvironment && typeof tool.launchEnvironment === 'object' && !Array.isArray(tool.launchEnvironment)
        ? tool.launchEnvironment
        : {},
    defaultPort,
    launchUrl,
    healthUrl,
    healthCheckPath: hasOwnValue(mode, 'healthCheckPath') ? mode.healthCheckPath : tool.healthCheckPath || '',
    executableCandidates: Array.isArray(mode.executableCandidates) ? mode.executableCandidates : null,
    batchCandidates: Array.isArray(mode.batchCandidates) ? mode.batchCandidates : null,
    pythonCandidates: Array.isArray(mode.pythonCandidates) ? mode.pythonCandidates : null,
    processNames: mode.processNames || deriveProcessNames({
      ...tool,
      launchCommand,
      externalLaunchCommand,
    }),
  };
}

function normalizeLaunchModes(tool) {
  const declaredModes = Array.isArray(tool.launchModes) ? tool.launchModes : [];
  const rawModes = declaredModes.length
    ? declaredModes
    : [
        {
          id: tool.interfaceMode === 'desktop-app' ? 'desktop' : tool.interfaceMode === 'embedded-chat' ? 'service' : 'webui',
          label: tool.interfaceMode === 'desktop-app' ? 'Desktop App' : null,
        },
      ];
  const seen = new Set();
  const modes = rawModes.map((mode, index) => normalizeLaunchMode(tool, mode, index)).filter((mode) => {
    if (seen.has(mode.id)) {
      return false;
    }

    seen.add(mode.id);
    return true;
  });
  const requestedPreferred = tool.preferredLaunchMode ? normalizeLaunchModeId(tool.preferredLaunchMode) : null;
  const preferredLaunchMode = modes.some((mode) => mode.id === requestedPreferred)
    ? requestedPreferred
    : modes[0]?.id || null;

  return {
    launchModes: modes,
    preferredLaunchMode,
  };
}

function normalizeCompanionDesktopDefinition(toolId, rawCompanion) {
  if (!rawCompanion || typeof rawCompanion !== 'object') {
    return null;
  }

  const companionId = sanitizeManifestId(`${toolId}-${rawCompanion.id || 'desktop'}`);
  const installInstructions = rawCompanion.installInstructions || {};
  const launchCommand = assertSafeCommandString(rawCompanion.launchCommand || `"${rawCompanion.name || 'Desktop App'}.exe"`, `${toolId} companion desktop launch command`);
  const externalLaunchCommand = rawCompanion.externalLaunchCommand
    ? assertSafeCommandString(rawCompanion.externalLaunchCommand, `${toolId} companion desktop external launch command`)
    : launchCommand;
  const normalizedInstallInstructions = {
    kind: installInstructions.kind || 'installer-exe',
    runtime: installInstructions.runtime || 'binary',
    archiveName: deriveArchiveName(rawCompanion.downloadUrl, installInstructions.archiveName),
    downloadFileName: installInstructions.downloadFileName || null,
    installSummary: installInstructions.installSummary || 'Downloads and opens the official desktop installer.',
    venvFolder: installInstructions.venvFolder || '.venv',
    pythonRequirement: installInstructions.pythonRequirement || null,
    configTargets: installInstructions.configTargets || [],
    pythonRequirementDetection: installInstructions.pythonRequirementDetection || [],
    pipInstalls: installInstructions.pipInstalls || [],
    runtimeAssets: installInstructions.runtimeAssets || [],
    packagingBootstrapPackages: installInstructions.packagingBootstrapPackages || [],
    preflightChecks: installInstructions.preflightChecks || [],
    installerArgs: installInstructions.installerArgs || [],
    managedInstallSupported: installInstructions.managedInstallSupported === true,
    materializationTimeoutMs: Number(installInstructions.materializationTimeoutMs) > 0
      ? Number(installInstructions.materializationTimeoutMs)
      : null,
    externalPythonCandidates: installInstructions.externalPythonCandidates || [],
    externalExecutableCandidates: installInstructions.externalExecutableCandidates || [],
    externalBatchCandidates: installInstructions.externalBatchCandidates || [],
    compatibility: installInstructions.compatibility || null,
  };
  const companion = {
    id: companionId,
    parentToolId: toolId,
    capability: rawCompanion.id || 'desktop',
    name: rawCompanion.name || 'Desktop App',
    description: rawCompanion.description || '',
    icon: rawCompanion.icon || null,
    category: rawCompanion.category || null,
    downloadUrl: assertSecureRemoteUrl(rawCompanion.downloadUrl, `${toolId} companion desktop download URL`),
    interfaceMode: 'desktop-app',
    launchCommand,
    externalLaunchCommand,
    launchEnv: rawCompanion.launchEnv || {},
    externalLaunchEnv: rawCompanion.externalLaunchEnv || rawCompanion.launchEnv || {},
    launchEnvironment: rawCompanion.launchEnvironment && typeof rawCompanion.launchEnvironment === 'object' && !Array.isArray(rawCompanion.launchEnvironment)
      ? rawCompanion.launchEnvironment
      : {},
    installInstructions: normalizedInstallInstructions,
    detectionPaths: rawCompanion.detectionPaths || [],
    discovery: {
      folderNames: mergeUnique(rawCompanion.discovery?.folderNames || []),
      markerPaths: mergeUnique(rawCompanion.discovery?.markerPaths || []),
      pathExecutables: mergeUnique(rawCompanion.discovery?.pathExecutables || []),
      pythonModules: mergeUnique(rawCompanion.discovery?.pythonModules || []),
    },
    defaultPort: null,
    launchUrl: null,
    healthUrl: null,
    processNames: rawCompanion.processNames || deriveProcessNames({
      launchCommand,
      externalLaunchCommand,
    }),
  };
  companion.launchModes = [
    normalizeLaunchMode(companion, {
      id: rawCompanion.id || 'desktop',
      capability: rawCompanion.id || 'desktop',
      label: 'Desktop App',
      kind: 'desktop',
      interfaceMode: 'desktop-app',
      launchCommand,
      externalLaunchCommand,
      executableCandidates: normalizedInstallInstructions.externalExecutableCandidates,
      processNames: companion.processNames,
    }),
  ];
  companion.preferredLaunchMode = companion.launchModes[0]?.id || 'desktop';
  companion.installContract = getManifestInstallContract(companion);
  return companion;
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
  const toolId = sanitizeManifestId(tool.id);
  const installInstructions = tool.installInstructions || {};
  const defaultExternalCandidates = DEFAULT_EXTERNAL_CANDIDATES[toolId] || {};
  const discoveryDefaults = buildDiscoveryDefaults({
    ...tool,
    id: toolId,
  });
  const launchUrl = buildLaunchUrl(tool);
  const launchCommand = assertSafeCommandString(tool.launchCommand, `${toolId} launch command`);
  const externalLaunchCommand = tool.externalLaunchCommand
    ? assertSafeCommandString(tool.externalLaunchCommand, `${toolId} external launch command`)
    : launchCommand;
  const launchModeConfig = normalizeLaunchModes({
    ...tool,
    id: toolId,
    launchCommand,
    externalLaunchCommand,
  });
  const normalizedInstallInstructions = {
    kind: installInstructions.kind || 'zip',
    runtime: installInstructions.runtime || 'binary',
    archiveName: deriveArchiveName(tool.downloadUrl, installInstructions.archiveName),
    downloadFileName: installInstructions.downloadFileName || null,
    installSummary: installInstructions.installSummary || 'Downloads and configures this tool inside Local AI Hub.',
    venvFolder: installInstructions.venvFolder || '.venv',
    pythonRequirement: installInstructions.pythonRequirement || null,
    configTargets: installInstructions.configTargets || [],
    pythonRequirementDetection: installInstructions.pythonRequirementDetection || [],
    pipInstalls: installInstructions.pipInstalls || [],
    runtimeAssets: installInstructions.runtimeAssets || [],
    packagingBootstrapPackages: installInstructions.packagingBootstrapPackages || [],
    preflightChecks: installInstructions.preflightChecks || [],
    installerArgs: installInstructions.installerArgs || [],
    managedInstallSupported: installInstructions.managedInstallSupported !== false,
    materializationTimeoutMs: Number(installInstructions.materializationTimeoutMs) > 0
      ? Number(installInstructions.materializationTimeoutMs)
      : null,
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
  };
  const installContract = getManifestInstallContract({
    ...tool,
    id: toolId,
    installInstructions: normalizedInstallInstructions,
  });
  const companionDesktop = normalizeCompanionDesktopDefinition(toolId, tool.companionDesktop);

  return {
    id: toolId,
    name: tool.name,
    description: tool.description,
    icon: tool.icon || tool.name.slice(0, 2).toUpperCase(),
    category: tool.category || 'General',
    downloadUrl: assertSecureRemoteUrl(tool.downloadUrl, `${toolId} download URL`),
    interfaceMode: tool.interfaceMode || 'external-browser',
    launchEnv: tool.launchEnv || {},
    externalLaunchEnv: tool.externalLaunchEnv || tool.launchEnv || {},
    launchEnvironment: tool.launchEnvironment && typeof tool.launchEnvironment === 'object' && !Array.isArray(tool.launchEnvironment) ? tool.launchEnvironment : {},
    launchModes: launchModeConfig.launchModes,
    preferredLaunchMode: launchModeConfig.preferredLaunchMode,
    installContract,
    companionDesktop,
    installInstructions: normalizedInstallInstructions,
    launchCommand,
    externalLaunchCommand,
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
    startupTimeoutMs: Number(tool.startupTimeoutMs) > 0 ? Number(tool.startupTimeoutMs) : null,
    modelManager: tool.modelManager && typeof tool.modelManager === 'object' ? tool.modelManager : null,
    pipelineCapabilities: getToolPipelineCapabilities(toolId),
    processNames: tool.processNames || mergeUnique(
      launchModeConfig.launchModes.flatMap((mode) => mode.processNames || []),
    ),
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
    launchModes: tool.launchModes,
    preferredLaunchMode: tool.preferredLaunchMode,
    installSummary: tool.installInstructions.installSummary,
    companionDesktop: tool.companionDesktop,
    installCapabilities: tool.companionDesktop
      ? [
          {
            id: 'webui',
            label: 'WebUI',
            installLabel: 'Install WebUI',
            installedLabel: 'WebUI Installed',
            installContract: tool.installContract,
            installKind: tool.installInstructions.kind,
            installSummary: tool.installInstructions.installSummary,
          },
          {
            id: 'desktop',
            label: 'Desktop App',
            installLabel: 'Install Desktop App',
            installedLabel: 'Desktop Installed',
            installContract: tool.companionDesktop.installContract,
            installKind: tool.companionDesktop.installInstructions.kind,
            installSummary: tool.companionDesktop.installInstructions.installSummary,
          },
        ]
      : null,
    installKind: tool.installInstructions.kind,
    installContract: tool.installContract,
    downloadUrl: tool.downloadUrl,
    compatibility: tool.installInstructions.compatibility,
    modelManager: tool.modelManager,
    pipelineCapabilities: tool.pipelineCapabilities,
  }));
}

function getToolDefinitions() {
  return loadToolDefinitions();
}

function firstExistingRelativePath(basePath, relativePaths = []) {
  return relativePaths.find((relativePath) => fs.existsSync(path.join(basePath, relativePath))) || null;
}

function listDirectoryFiles(basePath, matcher) {
  if (!basePath || !fs.existsSync(basePath)) {
    return [];
  }

  try {
    return fs
      .readdirSync(basePath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(basePath, entry.name))
      .filter((entryPath) => (typeof matcher === 'function' ? matcher(entryPath) : true));
  } catch {
    return [];
  }
}

function normalizeNameForMatch(value) {
  return String(value || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

function findExistingManagedCandidate(searchRoots = [], relativeCandidates = []) {
  for (const root of mergeUnique(searchRoots)) {
    if (!root) {
      continue;
    }

    for (const candidate of mergeUnique(relativeCandidates)) {
      if (!candidate) {
        continue;
      }

      const resolved = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
  }

  return null;
}

function findManagedBinaryExecutable(toolState, manifest) {
  const searchRoots = mergeUnique([toolState.appDir, toolState.installDir].filter(Boolean));
  if (!searchRoots.length) {
    return null;
  }

  const launchToken = tokenizeCommand(manifest.launchCommand)[0] || '';
  const directCandidate = findExistingManagedCandidate(searchRoots, [
    launchToken,
    ...(manifest.installInstructions?.externalExecutableCandidates || []),
  ]);
  if (directCandidate) {
    return directCandidate;
  }

  const normalizedExpectedNames = new Set(
    [
      normalizeNameForMatch(path.basename(launchToken, path.extname(launchToken))),
      normalizeNameForMatch(path.basename(manifest.id || '', path.extname(manifest.id || ''))),
      normalizeNameForMatch(manifest.name),
    ].filter(Boolean),
  );
  const ignoredExecutableNames = new Set(['elevate', 'squirrel', 'update', 'uninstall', 'unins000']);

  for (const root of searchRoots) {
    const executables = listDirectoryFiles(root, (entryPath) => /.exe$/i.test(entryPath));
    const namedMatch = executables.find((entryPath) => {
      const normalizedBaseName = normalizeNameForMatch(path.basename(entryPath, '.exe'));
      return normalizedExpectedNames.has(normalizedBaseName);
    });
    if (namedMatch) {
      return namedMatch;
    }

    const primaryExecutables = executables.filter((entryPath) => !ignoredExecutableNames.has(normalizeNameForMatch(path.basename(entryPath, '.exe'))));
    if (primaryExecutables.length === 1) {
      return primaryExecutables[0];
    }
  }

  return null;
}

function resolveCommandPath(token, baseDir, explicitPath = null, options = {}) {
  if (explicitPath) {
    return explicitPath;
  }

  if (!token) {
    return null;
  }

  if (options.allowBareCommandLookup && !path.isAbsolute(token) && !/[\\\\/]/.test(token)) {
    return token;
  }

  if (path.isAbsolute(token)) {
    return token;
  }

  return path.join(baseDir, token);
}

function isBareCommand(command) {
  return Boolean(command) && !path.isAbsolute(command) && !/[\\/]/.test(command);
}

function createFolderOnlyProfile(installDir) {
  return {
    kind: 'folder',
    path: installDir,
  };
}

function resolvePythonProfile(commandTokens, context = {}) {
  const token = commandTokens[0];
  const canUseBarePython = Boolean(context.allowBarePythonCommand);
  const pythonPath =
    context.pythonPath ||
    (canUseBarePython
      ? token
      : path.isAbsolute(token) || /[\\/]/.test(token)
        ? resolveCommandPath(token, context.baseDir)
        : null);

  if (!pythonPath) {
    return null;
  }

  const pythonArgs = [];
  let cursor = 1;

  while (cursor < commandTokens.length) {
    const currentToken = commandTokens[cursor];
    if (currentToken === '-m') {
      if (!commandTokens[cursor + 1]) {
        return null;
      }

      return {
        kind: 'python-module',
        pythonArgs,
        pythonPath,
        workingDir: context.workingDir || context.baseDir,
        allowExternalWorkingDir: Boolean(context.allowExternalWorkingDir),
        target: commandTokens[cursor + 1],
        args: commandTokens.slice(cursor + 2),
        env: context.env || {},
      };
    }

    if (!currentToken.startsWith('-') || currentToken === '-') {
      return {
        kind: 'python-script',
        pythonArgs,
        pythonPath,
        workingDir: context.workingDir || context.baseDir,
        allowExternalWorkingDir: Boolean(context.allowExternalWorkingDir),
        target: currentToken,
        args: commandTokens.slice(cursor + 1),
        env: context.env || {},
      };
    }

    pythonArgs.push(currentToken);
    cursor += 1;
  }

  return null;
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
      allowExternalWorkingDir: Boolean(context.allowExternalWorkingDir),
      env: context.env || {},
    };
  }

  const head = tokens[0].toLowerCase();
  if (head === 'python' || head === 'py' || head.endsWith('python.exe')) {
    return resolvePythonProfile(tokens, context);
  }

  if (/\.(bat|cmd)$/i.test(tokens[0])) {
    return {
      kind: 'batch',
        command: resolveCommandPath(tokens[0], context.baseDir, context.executablePath),
        workingDir: context.workingDir || context.baseDir,
        allowExternalWorkingDir: Boolean(context.allowExternalWorkingDir),
        allowExternalExecutable: Boolean(context.allowExternalExecutable),
        args: tokens.slice(1),
        env: context.env || {},
      };
  }

  const executable = resolveCommandPath(tokens[0], context.baseDir, context.executablePath);
  return {
    kind: 'binary',
    executable,
    workingDir: context.workingDir || path.dirname(executable),
    allowExternalWorkingDir: Boolean(context.allowExternalWorkingDir),
    allowExternalExecutable: Boolean(context.allowExternalExecutable),
    args: tokens.slice(1),
    env: context.env || {},
  };
}

function getModeCandidateList(launchMode, installInstructions, candidateKey, fallbackKey) {
  if (launchMode && launchMode[candidateKey] !== null) {
    return launchMode[candidateKey] || [];
  }

  return installInstructions[fallbackKey] || [];
}

function findManagedBinaryExecutableForMode(toolState, manifest, launchMode = null) {
  if (!launchMode) {
    return findManagedBinaryExecutable(toolState, manifest);
  }

  const searchRoots = mergeUnique([toolState.appDir, toolState.installDir].filter(Boolean));
  if (!searchRoots.length) {
    return null;
  }

  const launchToken = tokenizeCommand(launchMode.launchCommand || manifest.launchCommand)[0] || '';
  const candidates = mergeUnique([
    launchToken,
    ...getModeCandidateList(launchMode, manifest.installInstructions || {}, 'executableCandidates', 'externalExecutableCandidates'),
  ]);
  return findExistingManagedCandidate(searchRoots, candidates);
}

function detectedPathMatchesLaunchMode(detectedPath, launchMode, launchCommand) {
  if (!detectedPath || !launchMode) {
    return Boolean(detectedPath);
  }

  const expectedNames = mergeUnique([
    path.basename(tokenizeCommand(launchCommand)[0] || ''),
    ...(launchMode.executableCandidates || []),
    ...(launchMode.batchCandidates || []),
    ...(launchMode.pythonCandidates || []),
  ])
    .map((entry) => path.basename(String(entry || '')).toLowerCase())
    .filter(Boolean);
  if (!expectedNames.length) {
    return Boolean(detectedPath);
  }

  return expectedNames.includes(path.basename(detectedPath).toLowerCase());
}

function buildManagedLaunchProfile(toolState, manifest, launchMode = null) {
  const baseDir = toolState.appDir || toolState.installDir;
  const launchCommand = launchMode?.launchCommand || manifest.launchCommand;
  const launchToken = tokenizeCommand(launchCommand)[0] || '';
  const normalizedLaunchToken = launchToken.toLowerCase();
  const usesPythonLauncher =
    normalizedLaunchToken === 'python'
    || normalizedLaunchToken === 'py'
    || normalizedLaunchToken.endsWith('python.exe');
  const pythonPath =
    manifest.installInstructions.runtime === 'python'
      ? path.join(toolState.venvDir, 'Scripts', 'python.exe')
      : null;
  const executablePath = manifest.installInstructions.runtime === 'binary'
    ? findManagedBinaryExecutableForMode(toolState, manifest, launchMode)
    : null;

  return buildLaunchProfileFromCommand(launchCommand, {
    baseDir,
    workingDir: usesPythonLauncher ? baseDir : executablePath ? path.dirname(executablePath) : baseDir,
    executablePath,
    pythonPath,
    port: launchMode?.defaultPort || manifest.defaultPort,
    env: launchMode?.launchEnv || manifest.launchEnv || {},
  });
}

function buildCompanionDesktopLaunchProfile(toolState, manifest) {
  const companion = manifest?.companionDesktop;
  const companionState = toolState?.desktopCompanion;
  if (!companion || !companionState?.installed) {
    return null;
  }

  const installDir =
    companionState.installDir ||
    companionState.appDir ||
    (companionState.detectedPath ? path.dirname(companionState.detectedPath) : null);
  if (!installDir) {
    return null;
  }

  return buildExternalLaunchProfile(
    companion,
    installDir,
    companionState.detectedPath || companionState.executablePath || null,
    companion.launchModes?.[0] || null,
  );
}

function launchModeCapabilityIsInstalled(toolState, launchMode) {
  const capability = launchMode.capability || launchMode.id;
  const installedCapabilities = toolState?.installedCapabilities;
  if (!installedCapabilities || typeof installedCapabilities !== 'object') {
    return true;
  }

  if (Object.prototype.hasOwnProperty.call(installedCapabilities, capability)) {
    return Boolean(installedCapabilities[capability]);
  }

  return true;
}

function buildExternalLaunchProfile(manifest, installDir, detectedPath = null, launchMode = null) {
  const launchCommand = launchMode?.externalLaunchCommand || launchMode?.launchCommand || manifest.externalLaunchCommand || manifest.launchCommand;
  const installInstructions = manifest.installInstructions || {};
  const baseContext = {
    baseDir: installDir,
    workingDir: installDir,
    allowExternalWorkingDir: true,
    allowExternalExecutable: true,
    port: launchMode?.defaultPort || manifest.defaultPort,
    env: launchMode?.externalLaunchEnv || launchMode?.launchEnv || manifest.externalLaunchEnv || manifest.launchEnv || {},
  };
  const detectedPythonPath = detectedPath && /python(?:\.exe)?$/i.test(path.basename(detectedPath)) ? detectedPath : null;

  if (/^(python|py)(\s|$)/i.test(launchCommand)) {
    const pythonRelative = firstExistingRelativePath(
      installDir,
      getModeCandidateList(launchMode, installInstructions, 'pythonCandidates', 'externalPythonCandidates'),
    );
    const pythonPath = detectedPythonPath || (pythonRelative ? path.join(installDir, pythonRelative) : null);
    if (pythonPath) {
      return buildLaunchProfileFromCommand(launchCommand, {
        ...baseContext,
        pythonPath,
      });
    }
  }

  const executableCandidates = [
    detectedPathMatchesLaunchMode(detectedPath, launchMode, launchCommand) ? detectedPath : null,
    firstExistingRelativePath(
      installDir,
      getModeCandidateList(launchMode, installInstructions, 'executableCandidates', 'externalExecutableCandidates'),
    ),
    firstExistingRelativePath(
      installDir,
      getModeCandidateList(launchMode, installInstructions, 'batchCandidates', 'externalBatchCandidates'),
    ),
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

function resolveLaunchProfileTargetPath(launchProfile) {
  if (!launchProfile?.target) {
    return null;
  }

  if (path.isAbsolute(launchProfile.target)) {
    return launchProfile.target;
  }

  const baseDir = launchProfile.workingDir || '';
  return baseDir ? path.resolve(baseDir, launchProfile.target) : null;
}

function launchProfileExistsSync(launchProfile, fallbackDir = null) {
  if (!launchProfile) {
    return false;
  }

  if (launchProfile.kind === 'binary' && launchProfile.executable) {
    return fs.existsSync(launchProfile.executable);
  }

  if ((launchProfile.kind === 'python-script' || launchProfile.kind === 'python-module') && launchProfile.pythonPath) {
    if (!isBareCommand(launchProfile.pythonPath) && !fs.existsSync(launchProfile.pythonPath)) {
      return false;
    }

    if (launchProfile.kind === 'python-script') {
      const targetPath = resolveLaunchProfileTargetPath(launchProfile);
      return Boolean(targetPath && fs.existsSync(targetPath));
    }

    return true;
  }

  if (launchProfile.kind === 'embedded') {
    if (!launchProfile.pythonPath) {
      return Boolean(fallbackDir && fs.existsSync(fallbackDir));
    }

    return isBareCommand(launchProfile.pythonPath)
      ? Boolean(fallbackDir && fs.existsSync(fallbackDir))
      : fs.existsSync(launchProfile.pythonPath);
  }

  if (launchProfile.kind === 'batch' && launchProfile.command) {
    return fs.existsSync(launchProfile.command);
  }

  return Boolean(fallbackDir && fs.existsSync(fallbackDir));
}

function applyLaunchModeMetadata(launchMode, launchProfile) {
  return {
    id: launchMode.id,
    capability: launchMode.capability || launchMode.id,
    label: launchMode.label,
    kind: launchMode.kind,
    interfaceMode: launchMode.interfaceMode,
    launchUrl: launchMode.launchUrl,
    healthUrl: launchMode.healthUrl,
    defaultPort: launchMode.defaultPort,
    processNames: launchMode.processNames || [],
    profileKind: launchProfile?.kind || null,
  };
}

function buildLaunchModeState(toolState, manifest, options = {}) {
  const source = options.source || toolState?.source || 'managed';
  const detectedPath = options.detectedPath || toolState?.detectedPath || null;
  const fallbackDir = toolState?.installDir || toolState?.appDir || null;
  const availableModes = [];
  const declaredLaunchModes = (manifest.launchModes || []).map((launchMode) => ({
    id: launchMode.id,
    capability: launchMode.capability || launchMode.id,
    label: launchMode.label,
    kind: launchMode.kind,
    interfaceMode: launchMode.interfaceMode,
  }));
  const launchModeProfiles = {};

  for (const launchMode of manifest.launchModes || []) {
    if (!launchModeCapabilityIsInstalled(toolState, launchMode)) {
      continue;
    }

    const launchProfile = launchMode.id === 'desktop' && manifest.companionDesktop
      ? buildCompanionDesktopLaunchProfile(toolState, manifest)
      : source === 'external'
        ? buildExternalLaunchProfile(manifest, toolState.installDir || toolState.appDir, detectedPath, launchMode)
        : buildManagedLaunchProfile(toolState, manifest, launchMode);

    if (!launchProfileExistsSync(launchProfile, fallbackDir)) {
      continue;
    }

    availableModes.push(applyLaunchModeMetadata(launchMode, launchProfile));
    launchModeProfiles[launchMode.id] = launchProfile;
  }

  const preferredLaunchMode = availableModes.some((mode) => mode.id === manifest.preferredLaunchMode)
    ? manifest.preferredLaunchMode
    : availableModes[0]?.id || null;
  const launchProfile = preferredLaunchMode ? launchModeProfiles[preferredLaunchMode] : null;
  const preferredMode = availableModes.find((mode) => mode.id === preferredLaunchMode) || null;

  return {
    activeLaunchMode: preferredLaunchMode,
    declaredLaunchModes,
    interfaceMode: preferredMode?.interfaceMode || manifest.interfaceMode,
    launchModeProfiles,
    launchModes: availableModes,
    launchProfile,
    launchSupported: Boolean(launchProfile),
    preferredLaunchMode,
  };
}

module.exports = {
  buildLaunchModeState,
  buildExternalLaunchProfile,
  buildManagedLaunchProfile,
  buildCompanionDesktopLaunchProfile,
  buildLaunchProfileFromCommand,
  createFolderOnlyProfile,
  firstExistingRelativePath,
  getToolCatalog,
  getToolDefinitions,
  getToolManifest,
  initializeToolRegistry,
  tokenizeCommand,
};
