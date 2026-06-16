const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const modelService = require('../electron/services/modelService');

const {
  buildProviderCacheKey,
  clearAllModelManagerCaches,
  createExpiringCache,
  fetchCachedJsonResponse,
  getModelInventoryCacheStats,
  invalidateModelInventoryCache,
  resolveModelDestination,
  buildExpectedDownloadIdentity,
  writeModelMetadata,
} = modelService._test;

function modelTool(root, id = 'comfyui') {
  return {
    id,
    name: id === 'comfyui' ? 'ComfyUI' : 'Model Fixture',
    appDir: root,
    installDir: root,
    status: 'stopped',
    modelManager: {
      enabled: true,
      targetLayout: {
        basePath: 'app-dir',
        directories: {
          Checkpoint: 'models/checkpoints',
        },
      },
    },
  };
}

function packageTool(root) {
  return {
    id: 'audiocraft-webui',
    name: 'AudioCraft WebUI',
    appDir: root,
    installDir: root,
    status: 'stopped',
    modelManager: {
      enabled: true,
      targetLayout: {
        basePath: 'app-dir',
        directories: {
          'Audio / Speech': 'models',
        },
      },
    },
  };
}

function responseFromBytes(bytes, headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(bytes));
      controller.close();
    },
  }), { status: 200, headers });
}

async function writeCheckpoint(tool, fileName, content = 'model') {
  const filePath = path.join(tool.appDir, 'models', 'checkpoints', fileName);
  await fs.outputFile(filePath, content);
  return filePath;
}

async function writePackageManifest(root, files = []) {
  const packageRoot = path.join(root, 'models', 'audiocraft', 'musicgen-medium');
  const manifestPath = path.join(packageRoot, '.localaihub-package.json');
  await fs.ensureDir(packageRoot);
  const installedFiles = [
    { fileName: 'state_dict.bin', installRelativePath: 'state_dict.bin', path: 'state_dict.bin', required: true, sizeBytes: 4 },
    { fileName: 'compression_state_dict.bin', installRelativePath: 'compression_state_dict.bin', path: 'compression_state_dict.bin', required: true, sizeBytes: 4 },
  ];
  await fs.writeJson(manifestPath, {
    schemaVersion: 2,
    downloadIdentity: 'huggingface|audiocraft-webui|repo:facebook/musicgen-medium|artifact:hf:facebook/musicgen-medium:audiocraft-snapshot',
    downloadFiles: installedFiles,
    installedFiles,
    modelType: 'Audio / Speech',
    packageIdentity: 'hf:facebook/musicgen-medium:audiocraft-snapshot',
    packageName: 'musicgen-medium',
    packageRoot: 'audiocraft/musicgen-medium',
    packageRootPath: packageRoot,
    requiredFiles: installedFiles.filter((entry) => entry.required).map((entry) => ({ installRelativePath: entry.installRelativePath })),
    source: 'huggingface',
    toolId: 'audiocraft-webui',
  }, { spaces: 2 });
  for (const file of files) {
    await fs.outputFile(path.join(packageRoot, file), file);
  }
  return { manifestPath, packageRoot };
}

function remotePayload(fileName) {
  return {
    id: 'huggingface:' + fileName,
    name: fileName.replace(/\.safetensors$/i, ''),
    modelType: 'Checkpoint',
    fileName,
    installRelativePath: fileName,
    downloadUrl: 'https://example.test/' + fileName,
    sizeBytes: 4,
    source: 'huggingface',
    provider: 'huggingface',
    lowDiskConfirmed: true,
  };
}

async function expectRejectsWith(promise, pattern, label) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert(error, label + ' should reject.');
  assert.match(String(error.message || error), pattern, label);
}

async function verifyInventoryCacheReuseAndRefresh() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-cache-reuse-'));
  const originalReaddir = fs.readdir;
  try {
    clearAllModelManagerCaches();
    const tool = modelTool(root);
    await writeCheckpoint(tool, 'first.safetensors');

    let readdirCount = 0;
    fs.readdir = async function patchedReaddir(targetPath, options) {
      if (String(targetPath).startsWith(root)) {
        readdirCount += 1;
      }
      return originalReaddir.call(this, targetPath, options);
    };

    const first = await modelService.listDownloadedModels(tool, { forceRefresh: true });
    assert(first.some((model) => model.fileName === 'first.safetensors'), 'Initial forced inventory should find the first model.');
    assert(readdirCount > 0, 'Initial inventory should walk the filesystem.');

    const countAfterScan = readdirCount;
    first[0].fileName = 'mutated-by-test.safetensors';
    const cached = await modelService.listDownloadedModels(tool);
    assert.strictEqual(readdirCount, countAfterScan, 'Cached inventory should avoid recounting the model folder.');
    assert(cached.some((model) => model.fileName === 'first.safetensors'), 'Cached inventory should return cloned values, not caller mutations.');

    await writeCheckpoint(tool, 'second.safetensors');
    const stillCached = await modelService.listDownloadedModels(tool);
    assert(!stillCached.some((model) => model.fileName === 'second.safetensors'), 'Ordinary cached inventory can stay stable until refresh or invalidation.');

    const refreshed = await modelService.listDownloadedModels(tool, { forceRefresh: true });
    assert(refreshed.some((model) => model.fileName === 'second.safetensors'), 'Manual refresh should bypass the inventory cache.');

    const siblingTool = modelTool(path.join(root, 'other-root'));
    await writeCheckpoint(siblingTool, 'third.safetensors');
    await modelService.listDownloadedModels(siblingTool, { forceRefresh: true });
    assert(getModelInventoryCacheStats().size >= 2, 'Different tool roots should have distinct inventory cache entries.');
  } finally {
    fs.readdir = originalReaddir;
    clearAllModelManagerCaches();
    await fs.remove(root).catch(() => null);
  }
}

async function verifyInventoryMutationInvalidation() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-cache-mutation-'));
  try {
    clearAllModelManagerCaches();
    const tool = modelTool(root);
    const payload = remotePayload('downloaded.safetensors');

    await modelService.listDownloadedModels(tool, { forceRefresh: true });
    const destination = resolveModelDestination(tool, payload);
    await fs.outputFile(destination.destinationPath, 'data');
    await writeModelMetadata(destination.destinationPath, {
      downloadIdentity: buildExpectedDownloadIdentity(tool, payload, destination),
      fileName: destination.fileName,
      installRelativePath: destination.installRelativePath,
      modelType: payload.modelType,
      source: payload.source,
      toolId: tool.id,
    });

    const alreadyPresent = await modelService.downloadModel(tool, payload);
    assert.strictEqual(alreadyPresent.alreadyPresent, true, 'Already-present download path should complete successfully.');
    let models = await modelService.listDownloadedModels(tool);
    assert(models.some((model) => model.fileName === 'downloaded.safetensors'), 'Download success paths should invalidate stale empty inventory.');

    const downloaded = models.find((model) => model.fileName === 'downloaded.safetensors');
    await modelService.deleteModel(tool, { modelType: downloaded.modelType, path: downloaded.path, fileName: downloaded.fileName });
    models = await modelService.listDownloadedModels(tool);
    assert(!models.some((model) => model.fileName === 'downloaded.safetensors'), 'Model deletion should invalidate cached local inventory.');
  } finally {
    clearAllModelManagerCaches();
    await fs.remove(root).catch(() => null);
  }
}

async function verifyDamagedPackageFreshness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-cache-package-'));
  try {
    clearAllModelManagerCaches();
    const tool = packageTool(root);
    const { packageRoot } = await writePackageManifest(root, ['state_dict.bin', 'compression_state_dict.bin']);
    let models = await modelService.listDownloadedModels(tool, { forceRefresh: true });
    let pkg = models.find((model) => model.packageIdentity === 'hf:facebook/musicgen-medium:audiocraft-snapshot');
    assert(pkg && pkg.downloaded && !pkg.damaged, 'Complete package should be cached as healthy.');

    await fs.remove(path.join(packageRoot, 'compression_state_dict.bin'));
    invalidateModelInventoryCache(tool);
    models = await modelService.listDownloadedModels(tool);
    pkg = models.find((model) => model.packageIdentity === 'hf:facebook/musicgen-medium:audiocraft-snapshot');
    assert(pkg, 'Damaged package should remain visible after cache invalidation.');
    assert.strictEqual(pkg.downloaded, false, 'Missing required package shards should clear downloaded status.');
    assert.strictEqual(pkg.damaged, true, 'Missing required package shards should mark the package damaged.');
    assert(pkg.missingRequiredFiles.includes('compression_state_dict.bin'), 'Damaged package should report the missing shard.');
  } finally {
    clearAllModelManagerCaches();
    await fs.remove(root).catch(() => null);
  }
}

async function verifyProviderCacheBoundsAndKeys() {
  const cache = createExpiringCache({ maxEntries: 2, ttlMs: 50 });
  cache.set('first', { value: 1 }, 100);
  cache.set('second', { value: 2 }, 110);
  assert.deepStrictEqual(cache.get('first', 120), { value: 1 }, 'Provider cache should return unexpired entries.');
  cache.set('third', { value: 3 }, 130);
  assert.strictEqual(cache.get('second', 131), undefined, 'Provider cache should evict the least recently used entry when bounded.');
  assert.strictEqual(cache.get('first', 151), undefined, 'Provider cache entries should expire by TTL.');

  const secretKey = buildProviderCacheKey('civitai-search', {
    apiKey: 'SECRET-KEY',
    authorization: 'Bearer SECRET-KEY',
    cursor: 'abc',
    query: 'pony',
    token: 'SECRET-TOKEN',
    toolId: 'comfyui',
  });
  assert(!secretKey.includes('SECRET'), 'Provider cache keys must not include API keys, tokens, or authorization headers.');
  assert(secretKey.includes('pony') && secretKey.includes('abc') && secretKey.includes('comfyui'), 'Provider cache keys should keep non-secret source dimensions.');

  const base = buildProviderCacheKey('huggingface-page', { source: 'huggingface', query: 'sdxl', toolId: 'comfyui', cursor: 'a' });
  assert.notStrictEqual(base, buildProviderCacheKey('huggingface-page', { source: 'huggingface', query: 'sdxl', toolId: 'forge', cursor: 'a' }), 'Tool id should partition provider cache entries.');
  assert.notStrictEqual(base, buildProviderCacheKey('huggingface-page', { source: 'huggingface', query: 'lora', toolId: 'comfyui', cursor: 'a' }), 'Search filters should partition provider cache entries.');
  assert.notStrictEqual(base, buildProviderCacheKey('huggingface-page', { source: 'huggingface', query: 'sdxl', toolId: 'comfyui', cursor: 'b' }), 'Pagination cursors should partition provider cache entries.');
  assert.notStrictEqual(base, buildProviderCacheKey('civitai-search', { source: 'civitai', query: 'sdxl', toolId: 'comfyui', cursor: 'a' }), 'Provider source should partition provider cache entries.');
}

async function verifyProviderFailureDoesNotPoisonCache() {
  const cache = createExpiringCache({ maxEntries: 10, ttlMs: 1000 });
  const originalFetch = global.fetch;
  let fetchCount = 0;
  try {
    global.fetch = async (url) => {
      fetchCount += 1;
      if (String(url).includes('fail')) {
        return new Response(JSON.stringify({ error: 'temporary' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, url: String(url) }), {
        status: 200,
        headers: { 'content-type': 'application/json', link: '<https://example.test/next>; rel="next"' },
      });
    };

    await expectRejectsWith(
      fetchCachedJsonResponse(cache, buildProviderCacheKey('provider', { url: 'https://example.test/fail' }), 'https://example.test/fail'),
      /status 503/i,
      'Failed provider response',
    );
    assert.strictEqual(cache.size(), 0, 'Failed provider responses should not be cached.');

    const key = buildProviderCacheKey('provider', { url: 'https://example.test/ok', cursor: 'a' });
    const first = await fetchCachedJsonResponse(cache, key, 'https://example.test/ok?cursor=a');
    assert.strictEqual(first.payload.ok, true, 'Successful provider response should parse JSON.');
    assert.strictEqual(first.response.headers.get('link'), '<https://example.test/next>; rel="next"', 'Cached JSON response should retain the pagination link header.');
    const countAfterSuccess = fetchCount;
    const second = await fetchCachedJsonResponse(cache, key, 'https://example.test/ok?cursor=a');
    assert.strictEqual(second.payload.ok, true, 'Repeated provider request should use the cached payload.');
    assert.strictEqual(fetchCount, countAfterSuccess, 'Repeated provider request should not fetch again within TTL.');

    await fetchCachedJsonResponse(cache, buildProviderCacheKey('provider', { url: 'https://example.test/ok', cursor: 'b' }), 'https://example.test/ok?cursor=b');
    assert.strictEqual(fetchCount, countAfterSuccess + 1, 'Different provider cache key should fetch a separate page.');
  } finally {
    global.fetch = originalFetch;
  }
}

async function main() {
  await verifyInventoryCacheReuseAndRefresh();
  await verifyInventoryMutationInvalidation();
  await verifyDamagedPackageFreshness();
  await verifyProviderCacheBoundsAndKeys();
  await verifyProviderFailureDoesNotPoisonCache();
  console.log('Model Manager performance cache verifier passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
