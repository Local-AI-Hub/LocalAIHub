const { readConfig } = require('./configService');
const { resolveToolStatus } = require('./processService');
const { listSnapshots } = require('./snapshotService');
const { syncDiscoveredTools } = require('./toolDiscoveryService');
const { getToolManifest, initializeToolRegistry } = require('./toolRegistry');

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
      .sort((left, right) => String(left?.name || left?.id || '').localeCompare(String(right?.name || right?.id || '')))
      .map(async (tool) => {
        const manifest = getToolManifest(tool.id) || {};
        const mergedTool = {
          ...manifest,
          ...tool,
          compatibility: manifest.installInstructions?.compatibility || manifest.compatibility || tool.compatibility || null,
        };

        return {
          ...mergedTool,
          status: options.resolveStatuses ? await resolveToolStatus(mergedTool) : mergedTool.status || 'stopped',
          snapshots: options.includeSnapshots && mergedTool.source === 'managed' ? await listSnapshots(mergedTool.id) : [],
          updateSupported:
            mergedTool.source === 'managed' ||
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
