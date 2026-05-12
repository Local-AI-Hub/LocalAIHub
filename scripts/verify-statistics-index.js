const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-statistics-index');
process.env.APPDATA = path.join(TEST_STORAGE_ROOT, 'Roaming');
process.env.LOCALAPPDATA = path.join(TEST_STORAGE_ROOT, 'Local');
process.env.LOCALAIHUB_TEST_SECRET = 'statistics-index-secret-do-not-write';

let sizeCallCount = 0;
const fakeSizes = new Map();
function setFakeSize(targetPath, sizeBytes) {
  fakeSizes.set(path.resolve(targetPath).toLowerCase(), sizeBytes);
}
function getFakeSize(targetPath) {
  return fakeSizes.get(path.resolve(targetPath).toLowerCase()) || 0;
}

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'appData') return process.env.APPDATA;
          if (name === 'home') return TEST_STORAGE_ROOT;
          if (name === 'exe') return path.join(TEST_STORAGE_ROOT, 'Local AI Hub.exe');
          if (name === 'temp') return path.join(TEST_STORAGE_ROOT, 'Temp');
          return TEST_STORAGE_ROOT;
        },
        getVersion() {
          return '0.26.0-test';
        },
        isPackaged: false,
      },
    };
  }

  if (parent?.filename?.endsWith(path.join('electron', 'services', 'statisticsService.js'))) {
    if (request === './hardwareService') {
      return {
        detectStorageSnapshot: async () => [{ mount: path.parse(TEST_STORAGE_ROOT).root, freeBytes: 9000, sizeBytes: 12000 }],
        findDiskForPath: (disks) => disks[0] || null,
        getLiveResourceUsage: async () => null,
      };
    }
    if (request === './modelService') {
      return {
        listDownloadedModels: async (tool) => tool.fakeModels || [],
        supportsModelManager: (tool) => Boolean(tool.modelManager),
      };
    }
    if (request === './storageLocationService') {
      return {
        calculatePathSize: async (targetPath) => {
          sizeCallCount += 1;
          return getFakeSize(targetPath);
        },
      };
    }
  }

  return originalLoad.call(this, request, parent, isMain);
};

const { ensureStorage, getAppPaths } = require('../electron/services/configService');
const {
  getStatisticsStorageSnapshot,
  getStatisticsSnapshot,
  invalidateStatisticsIndexSections,
  _test,
} = require('../electron/services/statisticsService');

async function main() {
  fs.rmSync(TEST_STORAGE_ROOT, { force: true, recursive: true });
  await ensureStorage();
  const appPaths = getAppPaths();
  const tool = {
    id: 'comfyui',
    name: 'ComfyUI',
    installDir: path.join(appPaths.toolsRoot, 'comfyui'),
    modelManager: true,
    fakeModels: [{ name: 'safe-metadata-only', sizeBytes: 50 }],
    status: 'stopped',
  };

  setFakeSize(appPaths.configRoot, 100);
  setFakeSize(appPaths.localRoot, 200);
  setFakeSize(appPaths.managedRoot, 300);
  setFakeSize(appPaths.appInstallDir, 400);
  setFakeSize(tool.installDir, 300);

  const indexPath = await _test.getStatisticsIndexFilePath();
  sizeCallCount = 0;
  const created = await getStatisticsStorageSnapshot([tool], { forceRefresh: true });
  assert.strictEqual(created.sectionFreshness.storage.source, 'scan', 'Force refresh should rebuild from a direct scan.');
  assert(fs.existsSync(indexPath), 'Statistics index file should be created.');
  assert(sizeCallCount > 0, 'Initial rebuild should use sizing calls.');
  assert(created.sectionFreshness.storage.updatedAt, 'Storage freshness timestamp should be exposed.');
  assert.strictEqual(created.toolBreakdown[0].modelBytes, 50, 'Model summary bytes should be indexed by tool.');

  fs.rmSync(indexPath, { force: true });
  sizeCallCount = 0;
  const missing = await getStatisticsStorageSnapshot([tool]);
  assert.strictEqual(missing.sectionFreshness.storage.source, 'scan', 'Missing index should fall back to scan and rebuild.');
  assert(sizeCallCount > 0, 'Missing index fallback should scan.');

  fs.writeFileSync(indexPath, '{not json', 'utf8');
  sizeCallCount = 0;
  const corrupt = await getStatisticsStorageSnapshot([tool]);
  assert.strictEqual(corrupt.sectionFreshness.storage.source, 'scan', 'Corrupt index should be ignored and rebuilt.');
  assert(sizeCallCount > 0, 'Corrupt index recovery should scan.');

  sizeCallCount = 0;
  const indexed = await getStatisticsStorageSnapshot([tool]);
  assert.strictEqual(indexed.sectionFreshness.storage.source, 'index', 'Fresh index should be used.');
  assert.strictEqual(sizeCallCount, 0, 'Fresh index should avoid expensive sizing calls.');

  setFakeSize(tool.installDir, 500);
  sizeCallCount = 0;
  const refreshed = await getStatisticsStorageSnapshot([tool], { forceRefresh: true });
  assert.strictEqual(refreshed.sectionFreshness.storage.source, 'scan', 'Manual refresh should rebuild indexed sections.');
  assert(refreshed.toolBreakdown[0].installBytes >= 500, 'Manual refresh should update indexed tool size.');
  assert(sizeCallCount > 0, 'Manual refresh should perform sizing work.');

  await invalidateStatisticsIndexSections(['storage'], 'tool-installed', { toolId: tool.id });
  let indexResult = await _test.readStatisticsIndex();
  assert(indexResult.index.sections.storage.invalidatedAt, 'Tool lifecycle invalidation should mark storage stale.');
  sizeCallCount = 0;
  const afterToolInvalidation = await getStatisticsStorageSnapshot([tool]);
  assert.strictEqual(afterToolInvalidation.sectionFreshness.storage.source, 'scan', 'Invalidated storage section should rebuild on next request.');
  assert(sizeCallCount > 0, 'Invalidated storage rebuild should scan.');

  await invalidateStatisticsIndexSections(['storage'], 'model-downloaded', { toolId: tool.id });
  indexResult = await _test.readStatisticsIndex();
  assert(indexResult.index.sections.storage.invalidationReasons.some((entry) => entry.reason === 'model-downloaded'), 'Model lifecycle invalidation should be recorded.');

  const full = await getStatisticsSnapshot([tool]);
  assert(full.sectionFreshness.storage.updatedAt, 'Full compatibility endpoint should include storage freshness.');
  assert(Array.isArray(full.toolBreakdown), 'Full compatibility endpoint should still include tool breakdown.');

  const indexText = fs.readFileSync(indexPath, 'utf8');
  assert(!indexText.includes(process.env.LOCALAIHUB_TEST_SECRET), 'Statistics index must not write environment secrets.');
  assert(!indexText.includes('rawPrompt') && !indexText.includes('apiKey'), 'Statistics index should not include prompt or API key fields.');

  console.log('Statistics index verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
