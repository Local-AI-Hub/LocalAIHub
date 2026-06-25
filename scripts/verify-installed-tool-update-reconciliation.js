const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const tempRoot = path.join(repoRoot, 'temp', 'verify-installed-tool-update-reconciliation');
const installerService = require('../electron/services/installerService');

const {
  buildIncompleteUpdateVersionMessage,
  reconcileInstalledToolUpdateVersion,
} = installerService._test;

async function runScenario(label, versions, options = {}) {
  const installDir = path.join(tempRoot, label);
  await fs.ensureDir(installDir);
  let invalidateCount = 0;
  let discoveryCount = 0;
  let attachCount = 0;
  const versionQueue = [...versions];
  const result = await reconcileInstalledToolUpdateVersion(
    { id: 'upscayl', name: 'Upscayl', installInstructions: { kind: 'installer-exe' } },
    {
      id: 'upscayl',
      name: 'Upscayl',
      source: 'external',
      installDir,
      downloadCachePath: path.join(tempRoot, 'upscayl-setup.exe'),
      launchProfile: { kind: 'folder' },
    },
    '2.15.1',
    { info: async () => null, warn: async () => null },
    {
      timeoutMs: options.timeoutMs ?? 1,
      pollMs: 0,
      sleep: async () => null,
      invalidateDiscoveryCache: () => { invalidateCount += 1; },
      discoverTools: async () => {
        discoveryCount += 1;
        return {
          upscayl: {
            id: 'upscayl',
            name: 'Upscayl',
            source: 'external',
            installDir,
            downloadCachePath: path.join(tempRoot, 'upscayl-setup.exe'),
            launchProfile: { kind: 'folder' },
            status: 'stopped',
          },
        };
      },
      attachWindowsUninstallMetadata: async (state) => {
        attachCount += 1;
        return {
          ...state,
          windowsUninstallDetected: true,
          windowsUninstallDisplayName: 'Upscayl',
          windowsUninstallDisplayVersion: options.registryVersion || '',
        };
      },
      readInstalledBinaryVersion: async (state) => {
        if (options.useRegistryVersion && state.windowsUninstallDisplayVersion) return state.windowsUninstallDisplayVersion;
        return versionQueue.length > 1 ? versionQueue.shift() : versionQueue[0] || '';
      },
    },
  );
  return { ...result, attachCount, discoveryCount, invalidateCount };
}

async function main() {
  await fs.remove(tempRoot);
  await fs.ensureDir(tempRoot);

  const retrySuccess = await runScenario('retry-success', ['2.15.0.0', '2.15.1'], { timeoutMs: 60000 });
  assert.strictEqual(retrySuccess.verified, true, 'stale immediate version followed by expected version succeeds');
  assert.strictEqual(retrySuccess.detectedVersion, '2.15.1', 'updated version is returned after retry');
  assert(retrySuccess.invalidateCount >= 2, 'discovery cache is invalidated before each re-probe');
  assert(retrySuccess.discoveryCount >= 2, 'discovery is retried instead of requiring app relaunch');
  assert(retrySuccess.attachCount >= 2, 'Windows uninstall metadata is refreshed during reconciliation');

  const executableSuccess = await runScenario('file-version-success', ['2.15.1'], { registryVersion: '2.15.0.0', timeoutMs: 1 });
  assert.strictEqual(executableSuccess.verified, true, 'updated executable product/file version can reconcile stale registry version');
  assert.strictEqual(executableSuccess.detectedVersion, '2.15.1');

  const registrySuccess = await runScenario('registry-success', [''], { registryVersion: '2.15.1', useRegistryVersion: true, timeoutMs: 1 });
  assert.strictEqual(registrySuccess.verified, true, 'updated registry DisplayVersion can reconcile the update');
  assert.strictEqual(registrySuccess.detectedVersion, '2.15.1');

  const pending = await runScenario('pending', ['2.15.0.0'], { timeoutMs: 0 });
  assert.strictEqual(pending.verified, false, 'never-updated version remains pending after bounded retries');
  assert.strictEqual(pending.detectedVersion, '2.15.0.0');
  const pendingMessage = buildIncompleteUpdateVersionMessage({ name: 'Upscayl' }, '2.15.1', pending.detectedVersion, '2.15.0.0');
  assert(/updater completed/i.test(pendingMessage), 'pending message says updater completed');
  assert(/Windows has not reported the new version yet/i.test(pendingMessage), 'pending message explains delayed Windows recognition');
  assert(/Relaunch Local AI Hub or open logs/i.test(pendingMessage), 'pending message gives relaunch/log guidance');

  const installerSource = await fs.readFile(path.join(repoRoot, 'electron', 'services', 'installerService.js'), 'utf8');
  const mainSource = await fs.readFile(path.join(repoRoot, 'electron', 'main.js'), 'utf8');
  assert(installerSource.includes('throw invocationError') && installerSource.includes('updater exited with code'), 'actual updater process failures remain hard failures');
  assert(installerSource.includes('refreshInstalledToolUpdates([updatedState])'), 'tool update cache is refreshed after success');
  assert(mainSource.includes('invalidateDiscoveryCache();') && mainSource.includes('buildAppState({ forceDiscovery: true })'), 'Library state refresh forces discovery after update');
  assert(!installerSource.includes('2.15.0.0') && !installerSource.includes('2.15.1'), 'reconciliation has no Upscayl-specific hard-coded version workaround');

  await fs.remove(tempRoot);
  console.log('verify-installed-tool-update-reconciliation: ok');
}

main().catch(async (error) => {
  await fs.remove(tempRoot).catch(() => null);
  console.error(error);
  process.exit(1);
});
