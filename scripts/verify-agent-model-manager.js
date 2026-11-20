const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('fs-extra');
const { setTimeout: delay } = require('node:timers/promises');
const models = require('../electron/services/modelService');
const { createOperations } = require('../electron/agent/operations.cjs');
const { createModelManager } = require('../electron/agent/modelManager.cjs');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-models-'));
  process.env.APPDATA = path.join(root, 'roaming');
  process.env.LOCALAPPDATA = path.join(root, 'local');
  const { createBridge } = require('../electron/agent/bridge.cjs');
  const { callBridge } = require('../electron/agent/client.cjs');
  const descriptorPath = path.join(root, 'descriptor.json');
  let bridge;
  const originalFetch = global.fetch;
  try {
    const tool = { id: 'rvc', name: 'RVC', appDir: root, installDir: root, modelManager: {
      sources: [{ id: 'huggingface' }], targetLayout: { basePath: 'app-dir', directories: { 'RVC Voice Model': 'weights' } },
    } };
    const card = models._test.buildHuggingFaceRepositoryResult({ id: 'fixture/voice' },
      { rfilename: 'model.pth', modelType: 'RVC Voice Model', sizeBytes: 4 }, tool, new Set(), { disks: [], hardware: {} }, null, null);
    const choice = card.artifactChoices[0];
    card.artifactChoices.push({ ...choice, id: 'alternate', label: 'alternate.pth', payload: { ...choice.payload,
      fileName: 'alternate.pth', installRelativePath: 'alternate.pth', sourceArtifactPath: 'alternate.pth',
      downloadUrl: 'https://huggingface.co/fixture/voice/resolve/main/alternate.pth' } });
    card.artifactChoices.push({ id: 'blocked', disabled: true });
    let fetched = 0;
    global.fetch = async url => {
      assert.equal(String(url), card.artifactChoices[1].payload.downloadUrl);
      fetched++;
      return new Response('test', { headers: { 'content-length': '4' } });
    };
    const ollama = models._test.buildOllamaFamilyCard({ name: 'fixture', source: 'ollama' }, {
      variants: [{ name: 'fixture:latest', sizeBytes: 10 }, { name: 'fixture:tiny', sizeBytes: 2 }],
    });
    const { buildSelectedCatalogItem } = require('../electron/shared/modelArtifactSelection.cjs');
    const tiny = buildSelectedCatalogItem(ollama, ollama.artifactChoices[1].id);
    assert.equal(tiny.name, 'fixture:tiny');
    assert.equal(tiny.sizeBytes, 2);
    const changes = [];
    const listTools = async () => [tool];
    const modelManager = createModelManager({ models: { ...models, browseRemoteModels: async (_tool, args) => {
      assert.equal(args.query, 'voice');
      return { items: [card], pagination: { nextPage: 2 }, settings: { private: 'secret' } };
    } }, listTools, hardware: async () => ({ vramMb: 6144 }), storage: async () => [{ freeBytes: 1024 }],
    changed: async (_tool, reason) => changes.push(reason), withIdlePipeline: fn => fn() });
    const { dispatch } = createOperations({ modelManager, readConfig: async () => ({ hardware: { disks: [{ freeBytes: 3 }] } }), execution: { getActiveRunSnapshot: () => null }, listTools, listModels: models.listDownloadedModels, humanizeError: e => e.message });
    bridge = createBridge({ dispatch, descriptorPath, sanitizeError: error => error.message });
    await bridge.start();
    const call = (name, args) => callBridge(name, args, descriptorPath);
    async function waitJob(job) {
      for (let i = 0; i < 400; i++) {
        const current = await call('hub_job_status', { jobId: job.jobId });
        if (current.status !== 'running') return current;
        await delay(25);
      }
      throw Error('Model job timed out.');
    }
    const info = await call('hub_model_manager', {});
    assert.deepEqual((await call('hub_status', {})).hardware, info.hardware);
    assert.equal(info.hardware.vramMb, 6144);
    assert.equal(info.disks[0].freeBytes, 1024);
    assert.equal(info.targets[0].toolId, tool.id);
    const search = await call('hub_model_search', { toolId: tool.id, source: 'huggingface', query: 'voice' });
    assert.equal(search.pagination.nextPage, 2);
    assert(!JSON.stringify(search).includes('secret'));
    const selectionId = search.items[0].selectionId;
    const selection = { selectionId, choiceIndex: 1 };
    await assert.rejects(call('hub_model_preflight', { selectionId, choiceIndex: 2 }), /available artifact/);
    await assert.rejects(call('hub_model_preflight', { selectionId: 'expired' }), /Search the catalog/);
    const preflight = await call('hub_model_preflight', selection);
    assert.equal(preflight.requiredBytes, 4);
    const install = { ...selection, requestId: 'install-1', lowDiskConfirmed: true };
    const [first, retry] = await Promise.all([call('hub_model_install', install), call('hub_model_install', install)]);
    assert.equal(first.jobId, retry.jobId);
    const completed = await waitJob(first);
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.equal(fetched, 1);
    assert.equal(completed.progress.percent, 100);
    await assert.rejects(call('hub_model_install', { ...install, choiceIndex: 0 }), /another tool action/);
    const [local] = await call('hub_models', { toolId: tool.id, limit: 1 });
    assert.equal(await fs.readFile(local.path, 'utf8'), 'test');
    assert.equal(local.fileName, 'alternate.pth');
    const remove = { toolId: tool.id, removalId: local.removalId, requestId: 'remove-1' };
    await assert.rejects(call('hub_model_uninstall', { ...remove, path: root }), /Unknown argument/);
    const removed = await waitJob(await call('hub_model_uninstall', remove));
    assert.equal(removed.status, 'completed', JSON.stringify(removed));
    assert.equal(await fs.pathExists(local.path), false);
    assert.equal((await call('hub_model_uninstall', remove)).jobId, removed.jobId);
    assert.equal((await waitJob(await call('hub_model_uninstall', { ...remove, requestId: 'stale' }))).error.code, 'MODEL_NOT_FOUND');
    global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const cancel = await call('hub_model_install', { ...install, requestId: 'cancel' });
    assert.equal((await call('hub_model_cancel_download', { jobId: cancel.jobId })).canceled, true);
    assert.equal((await waitJob(cancel)).status, 'cancelled');
    assert.deepEqual(changes, ['model-downloaded', 'model-deleted']);
    console.log('Agent Model Manager passed discovery, catalog artifact selection, disk preflight, install, progress, retry, inventory, removal and cancellation.');
  } finally {
    await bridge?.stop();
    global.fetch = originalFetch;
    await fs.remove(root);
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
