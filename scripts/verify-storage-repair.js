const { app } = require('electron');

async function main() {
  await app.whenReady();

  const { getAppPaths, readConfig } = require('../electron/services/configService');
  const { detectStorageSnapshot, findDiskForPath } = require('../electron/services/hardwareService');
  const { repairToolInstallation } = require('../electron/services/installerService');
  const { inspectManagedDataMigration, setManagedDataRoot } = require('../electron/services/storageLocationService');
  const { syncDiscoveredTools } = require('../electron/services/toolDiscoveryService');

  const targetRoot = 'D:\\LocalAIHub';
  const initialPaths = getAppPaths();
  const migration = await inspectManagedDataMigration({
    sourceRoot: initialPaths.root,
    targetRoot,
  });

  console.log(JSON.stringify({
    step: 'storage-before',
    initialPaths: {
      configRoot: initialPaths.configRoot,
      managedRoot: initialPaths.managedRoot,
      toolsRoot: initialPaths.toolsRoot,
    },
    migration,
  }, null, 2));

  await setManagedDataRoot(targetRoot, {
    migrationSourceRoot: migration.available ? initialPaths.root : null,
  });

  const migratedConfig = await readConfig();
  const discoveredTools = await syncDiscoveredTools({ force: true });

  for (const toolId of ['comfyui', 'fooocus']) {
    const toolState = discoveredTools[toolId] || migratedConfig.tools?.[toolId];
    if (!toolState) {
      throw new Error(`Missing tracked tool state for ${toolId}.`);
    }

    console.log(JSON.stringify({
      step: 'repair-start',
      toolId,
      installDir: toolState.installDir,
      downloadCachePath: toolState.downloadCachePath || null,
      source: toolState.source,
      status: toolState.status,
    }, null, 2));

    const repairedTool = await repairToolInstallation(toolState, {
      onProgress: (progress) => {
        console.log(JSON.stringify({ step: 'repair-progress', toolId, progress }, null, 2));
      },
    });

    console.log(JSON.stringify({
      step: 'repair-complete',
      toolId,
      installDir: repairedTool.installDir,
      downloadCachePath: repairedTool.downloadCachePath || null,
      lastRepairMessage: repairedTool.lastRepairMessage || null,
      status: repairedTool.status,
    }, null, 2));
  }

  const disks = await detectStorageSnapshot();
  const targetDisk = findDiskForPath(disks, targetRoot);
  console.log(JSON.stringify({
    step: 'storage-after',
    targetRoot,
    targetDisk,
  }, null, 2));
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    app.exit(1);
  });
