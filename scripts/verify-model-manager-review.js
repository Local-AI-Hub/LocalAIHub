const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { transformSync } = require('esbuild');
const modelService = require('../electron/services/modelService');

async function verifyPackageDeletion() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-review-delete-'));
  try {
    const tool = { id: 'upscayl', name: 'Upscayl', appDir: root, modelManager: { enabled: true, targetLayout: { basePath: 'app-dir', directories: { Upscaler: 'models' } } } };
    const directory = path.join(root, 'models');
    for (const flat of [true, false]) {
      const packageRoot = flat ? directory : path.join(directory, 'folder-package');
      const manifest = path.join(packageRoot, flat ? 'fixture.localaihub-package.json' : '.localaihub-package.json');
      await fs.outputFile(path.join(packageRoot, 'model.bin'), 'weight');
      await fs.outputFile(path.join(packageRoot, 'model.param'), 'config');
      await fs.outputFile(path.join(packageRoot, 'unrelated.bin'), 'keep');
      await fs.writeJson(manifest, { schemaVersion: 2, downloadIdentity: 'fixture-package', planType: 'package', packageName: 'fixture', packageRootPath: packageRoot, installedFiles: [{ installRelativePath: 'model.bin' }, { installRelativePath: 'model.param' }] });
      await modelService.deleteModel(tool, { modelType: 'Upscaler', path: packageRoot, packageManifestPath: manifest });
      assert.equal(await fs.pathExists(path.join(packageRoot, 'model.bin')), false);
      assert.equal(await fs.pathExists(path.join(packageRoot, 'model.param')), false);
      assert.equal(await fs.pathExists(manifest), false);
      assert.equal(await fs.readFile(path.join(packageRoot, 'unrelated.bin'), 'utf8'), 'keep', 'Deleting a package must preserve files outside its manifest.');
    }
    await assert.rejects(modelService.deleteModel(tool, { modelType: 'Upscaler', path: directory }), /individual model files/);
    assert.equal(await fs.readFile(path.join(directory, 'unrelated.bin'), 'utf8'), 'keep');
  } finally {
    await fs.remove(root);
  }
}

async function verifyPackageDownloads() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-review-package-'));
  const originalFetch = global.fetch;
  try {
    const tool = { id: 'audiocraft-webui', name: 'AudioCraft', appDir: root, modelManager: { enabled: true, targetLayout: { basePath: 'app-dir', directories: { 'Audio / Speech': 'models' } } } };
    const payload = { id: 'fixture', name: 'fixture', source: 'huggingface', catalogRepositoryId: 'fixture/model', modelType: 'Audio / Speech', lowDiskConfirmed: true, downloadPlan: { planType: 'package', runnable: true, modelType: 'Audio / Speech', packageName: 'fixture', packageRoot: 'fixture', packageIdentity: 'fixture-package', sizeBytes: 8, downloadFiles: [ { path: 'first.bin', required: true, sizeBytes: 4 }, { path: 'second.bin', required: true, sizeBytes: 4 } ] } };
    const progress = [];
    let fetches = 0;
    global.fetch = async () => {
      fetches += 1;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('ab')); controller.enqueue(Buffer.from('cd')); controller.close(); } }), { headers: { 'content-length': '4' } });
    };
    await modelService.downloadModel(tool, payload, { onProgress: (entry) => progress.push(entry) });
    assert(progress.some((entry) => entry.receivedBytes === 2 && entry.totalBytes === 8 && entry.percent === 25), 'Large package files must report progress during transfer.');
    assert(progress.some((entry) => entry.receivedBytes === 6 && entry.percent === 75), 'Package progress must include earlier files.');
    await assert.rejects(modelService.downloadModel(tool, { ...payload, catalogRepositoryId: 'other/model' }), /different model/);
    assert.equal(fetches, 2, 'Conflicting package identities must be rejected before transfer.');
    const manifest = path.join(root, 'models', 'fixture', '.localaihub-package.json');
    const before = await fs.readFile(manifest, 'utf8');
    await fs.remove(path.join(root, 'models', 'fixture', 'second.bin'));
    global.fetch = async () => new Response('unavailable', { status: 503 });
    await assert.rejects(modelService.downloadModel(tool, payload), /could not/);
    assert.equal(await fs.readFile(manifest, 'utf8'), before, 'A failed repair must retain the original manifest.');
    await fs.remove(manifest);
    await assert.rejects(modelService.downloadModel(tool, payload), /cannot confirm it is the same model/);
    assert.equal(await fs.readFile(path.join(root, 'models', 'fixture', 'first.bin'), 'utf8'), 'abcd');
  } finally {
    global.fetch = originalFetch;
    await fs.remove(root);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Execute the component's actual handlers with persistent hook state, without a browser.
function makeHarness(api) {
  const hooks = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return hooks[index] ||= { current: initial };
    },
    useMemo(fn) { return fn(); },
    useEffect() {},
  };
  let source = fs.readFileSync(path.join(__dirname, '../src/components/ModelManager.jsx'), 'utf8');
  source = source.replace('  if (!modelTools.length) {', `  return { matchingLocalModel, applyToolDefaults, loadLocalModels, browse, handleDownload, handleDelete, handleLoadMore, setSearch, localModels, remoteItems, downloadBusyMap };\n  if (!modelTools.length) {`);
  const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
  const toasts = [];
  const context = { module: { exports: {} }, window: { localAIHub: api, confirm: () => true }, URL, console, require(name) {
    if (name.endsWith('/modelArtifactSelection.cjs')) return require('../electron/shared/modelArtifactSelection.cjs');
    if (name === 'react') return react;
    if (name.includes('PaginationControls')) return { clampPaginationPage: () => 1, getPaginatedItems: (items) => items };
    if (name.includes('formatters')) return { formatBytes: String };
    if (name.includes('focus-guard')) return { logRendererActionDiagnostic() {} };
    throw new Error('Unexpected import: ' + name);
  } };
  vm.runInNewContext(code, context);
  const tools = ['comfyui', 'forge'].map((id) => ({ id, name: id, modelManager: { enabled: true } }));
  return { toasts, render() { cursor = 0; return context.module.exports.default({ tools, onToast: (...args) => toasts.push(args) }); } };
}

async function verifyRendererRaces() {
  let pending;
  let localPending;
  const calls = [];
  const api = {
    cancelModelBrowse: async () => ({}),
    getModelDownloadPreflight: async () => ({ ok: true, data: {} }),
    downloadModel: () => pending.promise,
    deleteModel: () => pending.promise,
    listLocalModels: (payload) => { calls.push(payload); return localPending.promise; },
    browseModels: async (payload) => { calls.push(payload); return { ok: true, data: { items: [], localModels: [] } }; },
  };
  for (const operation of ['handleDownload', 'handleDelete', 'loadLocalModels']) {
    pending = deferred();
    localPending = deferred();
    const h = makeHarness(api);
    let view = h.render();
    const completion = operation === 'loadLocalModels' ? view[operation]() : view[operation]({ id: 'old', name: 'old', fileName: 'old.safetensors' });
    await Promise.resolve();
    view.applyToolDefaults('forge');
    h.render();
    pending.resolve({ ok: true, data: { localModels: [{ id: 'old-tool-model' }] } });
    localPending.resolve({ ok: true, data: [{ id: 'old-tool-model' }] });
    await completion;
    view = h.render();
    assert.equal(view.localModels.length, 0, operation + ' must not restore the previous tool inventory.');
  }
  assert(calls.some((entry) => entry.forceRefresh === true), 'Explicit refresh must bypass the inventory cache.');
  assert(!calls.some((entry) => entry.source), 'Completion in the old tool must not start a stale catalog search.');

  const browsePending = deferred();
  const h = makeHarness({ ...api, browseModels: () => browsePending.promise, listLocalModels: async () => ({ ok: true, data: [{ id: 'fresh' }] }) });
  let view = h.render();
  const browse = view.browse();
  await view.loadLocalModels();
  browsePending.resolve({ ok: true, data: { items: [], localModels: [{ id: 'stale' }] } });
  await browse;
  assert.equal(h.render().localModels[0].id, 'fresh', 'A slow catalog response must not overwrite an explicit refresh.');
  const refreshPending = deferred();
  const catalogPending = deferred();
  const concurrent = makeHarness({ ...api, listLocalModels: () => refreshPending.promise, browseModels: () => catalogPending.promise });
  const refreshing = concurrent.render().loadLocalModels();
  const browsing = concurrent.render().browse();
  refreshPending.resolve({ ok: true, data: [{ id: 'fresh' }] });
  await refreshing;
  catalogPending.resolve({ ok: true, data: { items: [], localModels: [{ id: 'stale' }] } });
  await browsing;
  assert.equal(concurrent.render().localModels[0].id, 'fresh', 'A catalog launched during refresh must not restore its older snapshot.');
  const damaged = { downloadIdentity: 'fixture', damaged: true, downloaded: false };
  assert.equal(h.render().matchingLocalModel({ downloadIdentity: 'fixture' }, [damaged]), null);
  assert.equal(modelService._test.buildDownloadedLookup([damaged]).size, 0, 'Incomplete packages must remain downloadable.');

  const failed = makeHarness({ ...api, getModelDownloadPreflight: async () => { throw new Error('IPC unavailable'); } });
  await failed.render().handleDownload({ id: 'failure', name: 'failure' });
  assert.equal(Object.keys(failed.render().downloadBusyMap).length, 0);
  assert(failed.toasts.some(([message]) => message === 'IPC unavailable'));

  const queries = [];
  const paging = makeHarness({ ...api, browseModels: async (payload) => { queries.push(payload.query); return { ok: true, data: { items: [], localModels: [], pagination: { hasMore: true, nextPage: 2 } } }; } });
  await paging.render().browse({ query: 'committed search' });
  paging.render().setSearch('unsubmitted draft');
  await paging.render().handleLoadMore();
  assert.deepEqual(queries, ['committed search', 'committed search'], 'Pagination must retain the submitted query.');
}

async function main() {
  await verifyPackageDeletion();
  await verifyPackageDownloads();
  await verifyRendererRaces();
  console.log('Model Manager review regression checks passed.');
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
