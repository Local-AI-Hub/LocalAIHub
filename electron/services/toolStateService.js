const path = require('path');
const fs = require('fs-extra');

const { readConfig } = require('./configService');
const { resolveManagedToolPaths } = require('./pathSafetyService');
const { resolveToolStatus } = require('./processService');
const { listSnapshots } = require('./snapshotService');
const { syncDiscoveredTools } = require('./toolDiscoveryService');
const { buildManagedLaunchProfile, getToolManifest, initializeToolRegistry } = require('./toolRegistry');
const { hydrateKoboldCppToolState } = require('./koboldCppService');
const { allowsLocalSnapshots, normalizeToolLifecycle } = require('./toolLifecycleService');

function refreshManagedLaunchState(tool, manifest) {
  if (!manifest?.id || tool?.source !== 'managed') {
    return tool;
  }

  const launchProfile = buildManagedLaunchProfile(tool, manifest);
  return {
    ...tool,
    configTargets: manifest.installInstructions?.configTargets || tool.configTargets || [],
    executablePath: launchProfile?.kind === 'binary' ? launchProfile.executable : tool.executablePath || null,
    healthUrl: manifest.healthUrl,
    interfaceMode: manifest.interfaceMode || tool.interfaceMode,
    launchCommand: manifest.launchCommand || tool.launchCommand,
    launchProfile,
    launchUrl: manifest.launchUrl,
    processNames: manifest.processNames || tool.processNames || [],
    startupTimeoutMs: manifest.startupTimeoutMs || null,
  };
}

async function externalLaunchProfileIsBroken(tool) {
  const launchProfile = tool?.launchProfile;
  if (!launchProfile || tool?.source !== 'external') {
    return false;
  }

  if (launchProfile.kind === 'python-script') {
    const targetPath = path.resolve(launchProfile.workingDir || tool.installDir || '', launchProfile.target || '');
    return !(await fs.pathExists(targetPath));
  }

  if (launchProfile.kind === 'batch') {
    return !(await fs.pathExists(launchProfile.command || ''));
  }

  if (launchProfile.kind === 'binary') {
    return !(await fs.pathExists(launchProfile.executable || ''));
  }

  return false;
}

async function recoverBrokenManagedToolState(tool, manifest) {
  const needsManagedRecovery =
    manifest?.installContract?.lifecycleMode === 'managed' &&
    tool?.source === 'external' &&
    tool?.actionSemantics?.repairAvailable === false &&
    /run repair or reinstall it\./i.test(String(tool?.lastError || '')) &&
    (await externalLaunchProfileIsBroken(tool));

  if (!needsManagedRecovery) {
    return tool;
  }

  const managedPaths = resolveManagedToolPaths(manifest.id, manifest.installInstructions?.venvFolder || '.venv');
  return normalizeToolLifecycle({
    ...tool,
    source: 'managed',
    installDir: managedPaths.installDir,
    appDir: managedPaths.appDir,
    venvDir: managedPaths.venvDir,
    detectedPath: managedPaths.installDir,
    displayPath: managedPaths.installDir,
    installRoot: path.dirname(managedPaths.toolsRoot),
    requestedInstallRoot: tool.requestedInstallRoot || path.dirname(managedPaths.toolsRoot),
    externalExecutablePath: null,
    externalPythonPath: null,
    executablePath: null,
    managedByLocalAIHub: true,
    installedByLocalAIHub: true,
    launchProfile: null,
    actionSemantics: null,
    lifecycleClass: null,
    lifecycleMode: null,
  }, manifest);
}

async function buildMergedToolStateList(options = {}) {
  if (!options.skipRegistryInit) {
    await initializeToolRegistry({ refreshRemote: Boolean(options.refreshManifest) });
  }

  if (options.syncDiscovered) {
    await syncDiscoveredTools({ force: Boolean(options.forceDiscovery) });
  }

  const config = options.config || (await readConfig());
  return Promise.all(
    Object.values(config.tools || {})
      .map((tool) => ({ tool, manifest: getToolManifest(tool?.id) }))
      .filter(({ manifest }) => Boolean(manifest?.id))
      .sort((left, right) => String(left.tool?.name || left.tool?.id || '').localeCompare(String(right.tool?.name || right.tool?.id || '')))
      .map(async ({ tool, manifest }) => {
        const normalizedTool = normalizeToolLifecycle({
          ...manifest,
          ...tool,
          compatibility: manifest.installInstructions?.compatibility || manifest.compatibility || tool.compatibility || null,
          modelManager: manifest.modelManager || tool.modelManager || null,
        }, manifest);
        const recoveredTool = await recoverBrokenManagedToolState(normalizedTool, manifest);
        const mergedTool = refreshManagedLaunchState(recoveredTool, manifest);
        const hydratedTool = await hydrateKoboldCppToolState(mergedTool);

        return {
          ...hydratedTool,
          status: options.resolveStatuses ? await resolveToolStatus(hydratedTool) : hydratedTool.status || 'stopped',
          snapshots: options.includeSnapshots && allowsLocalSnapshots(hydratedTool, manifest) ? await listSnapshots(hydratedTool.id) : [],
          updateSupported:
            hydratedTool.lifecycleMode === 'managed' ||
            manifest.installInstructions?.kind === 'installer-exe' ||
            manifest.installInstructions?.kind === 'single-file' ||
            manifest.installInstructions?.runtime === 'binary',
        };
      }),
  );
}

async function getResolvedToolState(toolId, options = {}) {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  if (!normalizedToolId) {
    return null;
  }

  const tools = await buildMergedToolStateList({
    ...options,
    includeSnapshots: false,
    resolveStatuses: true,
  });

  return tools.find((tool) => tool.id === normalizedToolId) || null;
}

module.exports = {
  buildMergedToolStateList,
  getResolvedToolState,
};


