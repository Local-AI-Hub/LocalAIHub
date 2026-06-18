const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  collectSupportData,
  createDiagnosticsBundle,
} = require('../electron/services/diagnosticsService');

const SECRET = 'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II';
const USER_PATH = 'C:\\Users\\Matthew\\Private Models\\client-model.safetensors';

function fakePaths(tempRoot) {
  return {
    configRoot: path.join(tempRoot, 'config'),
    localRoot: path.join(tempRoot, 'local'),
    managedRoot: path.join(tempRoot, 'managed'),
    logsRoot: path.join(tempRoot, 'managed', 'logs'),
    toolsRoot: path.join(tempRoot, 'managed', 'tools'),
    modelsRoot: path.join(tempRoot, 'managed', 'models'),
    recordingsRoot: path.join(tempRoot, 'managed', 'recordings'),
    runtimesRoot: path.join(tempRoot, 'managed', 'runtimes'),
    appInstallDir: path.join(tempRoot, 'app'),
  };
}

function fakeDependencies(paths) {
  return {
    ensureStorage: async () => paths,
    readConfig: async () => ({ firstLaunchCompleted: true }),
    osInfo: async () => ({ platform: 'Windows', distro: 'Windows 11', release: '11', build: '26100', arch: 'x64' }),
    cpu: async () => ({ manufacturer: 'Test', brand: 'CPU', cores: 8 }),
    mem: async () => ({ total: 32 * 1024 * 1024 * 1024 }),
    detectHardwareSnapshot: async () => ({ gpuModel: 'Test RTX', gpuVendor: 'NVIDIA', systemRamMb: 32768, vramMb: 12288 }),
    getLiveResourceUsage: async () => ({ gpuName: 'Test RTX', vramTotalMb: 12288, vramUsedMb: 2048, diskFreeBytes: 1000, diskMount: 'D:\\' }),
    detectStorageSnapshot: async () => [{ mount: 'D:\\', freeBytes: 1000, sizeBytes: 2000 }],
    listTools: async () => [
      {
        id: 'comfyui',
        name: 'ComfyUI',
        installDir: path.join(paths.toolsRoot, 'comfyui'),
        appDir: path.join(paths.toolsRoot, 'comfyui', 'app'),
        modelManager: { enabled: true, sources: [{ id: 'huggingface', label: 'Hugging Face' }, { id: 'civitai', label: 'CivitAI' }] },
        status: 'stopped',
      },
      {
        id: 'wan21-webui',
        name: 'Wan',
        installDir: path.join(paths.toolsRoot, 'wan21-webui'),
        modelManager: { enabled: true, sources: [{ id: 'huggingface', label: 'Hugging Face' }] },
        status: 'stopped',
      },
    ],
    listProviders: async () => [],
    listRecordings: async () => [],
    listPipelineOutputs: async () => [],
    readModelSettings: async () => ({ hasCivitaiApiKey: true, civitaiCredentialSource: 'saved', civitaiApiKey: SECRET }),
    getFfmpegSummary: async () => ({ available: true, version: 'ffmpeg test' }),
    getModelManagerCacheSummary: () => ({
      inventoryCache: { enabled: true, ttlMs: 15000, maxEntries: 128, entryCount: 2 },
      providerCatalogCache: { enabled: true, ttlMs: 600000, maxEntries: 200, detailMaxEntries: 400, entryCounts: { civitaiSearch: 1 } },
    }),
    getRecentSupportEvents: () => [
      {
        timestamp: '2026-06-17T12:00:00.000Z',
        area: 'model-manager',
        toolId: 'comfyui',
        operation: 'integrity',
        category: 'integrity',
        message: `Checksum failed for ${USER_PATH} with token ${SECRET}`,
      },
    ],
    listDownloadedModels: async (tool) => {
      if (tool.id === 'wan21-webui') {
        throw new Error(`Cannot scan ${USER_PATH}`);
      }
      return [
        {
          toolId: 'comfyui',
          modelType: 'Checkpoint',
          fileName: 'client-model.safetensors',
          path: USER_PATH,
          name: 'client-model',
          downloaded: true,
          sizeBytes: 123,
          scanWarnings: ['Model scan skipped a symlink or junction inside the model folder.'],
        },
        {
          toolId: 'comfyui',
          modelType: 'Video',
          damaged: true,
          incomplete: true,
          missingRequiredFiles: ['private-shard.safetensors'],
          fileName: 'private-wan-package',
          statusMessage: 'This package is incomplete.',
        },
      ];
    },
  };
}

async function readBundleText(bundlePath) {
  const files = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(next);
      else files.push(next);
    }
  }
  await walk(bundlePath);
  return (await Promise.all(files.filter((file) => !file.endsWith('.zip')).map((file) => fs.readFile(file, 'utf8')))).join('\n');
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-health-'));
  const paths = fakePaths(tempRoot);
  await Promise.all(Object.values(paths).map((target) => fs.ensureDir(target)));
  const deps = fakeDependencies(paths);

  const data = await collectSupportData({ appVersion: '0.53.0' }, deps);
  const health = data.models.health;
  assert(health, 'Diagnostics should include Model Manager health.');
  assert.strictEqual(health.collection.liveProviderFetches, false, 'Health collection must not claim live provider fetches.');
  assert.strictEqual(health.collection.downloadsStarted, false, 'Health collection must not start downloads.');
  assert.strictEqual(health.credentials.civitaiConfigured, true, 'Health should report whether CivitAI credentials are configured.');
  assert.strictEqual(health.installedModelCounts.comfyui.Checkpoint, 1, 'Health should count installed models by broad type.');
  assert.strictEqual(health.damagedPackageCounts.comfyui.Video, 1, 'Health should count damaged packages by broad type.');
  assert.strictEqual(health.incompletePackageCounts.comfyui.Video, 1, 'Health should count incomplete packages by broad type.');
  assert.strictEqual(health.scanWarningCounts.comfyui['toolsRoot:reparse-point-skipped'], 1, 'Health should summarize scan warning categories.');
  assert(health.warnings.some((warning) => warning.includes('wan21-webui')), 'Per-tool health failures should become sanitized warnings.');
  assert.strictEqual(health.recentFailures[0].category, 'integrity', 'Recent failure summaries should include normalized categories.');

  const result = await createDiagnosticsBundle({ appVersion: '0.53.0' }, { ...deps, diagnosticsRoot: path.join(tempRoot, 'diagnostics') });
  const healthPath = path.join(result.bundlePath, 'model-manager-health.json');
  assert(await fs.pathExists(healthPath), 'Diagnostics bundle should write model-manager-health.json.');
  const combined = await readBundleText(result.bundlePath);
  assert(!combined.includes(SECRET), 'Diagnostics must redact provider keys and PATs.');
  assert(!combined.includes('C:\\Users\\Matthew'), 'Diagnostics must redact raw user paths.');
  assert(!combined.includes('client-model.safetensors'), 'Diagnostics must not include raw model filenames.');
  assert(!combined.includes('private-shard.safetensors'), 'Diagnostics must not include missing private shard filenames.');

  const diagnosticsSource = await fs.readFile(path.join(__dirname, '..', 'electron', 'services', 'diagnosticsService.js'), 'utf8');
  assert(!/browseRemoteModels/.test(diagnosticsSource), 'Diagnostics should not call remote model catalog browsing.');
  assert(!/downloadModel\(/.test(diagnosticsSource), 'Diagnostics should not start model downloads.');

  await fs.remove(tempRoot);
  console.log('Model Manager diagnostics health verifier passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
