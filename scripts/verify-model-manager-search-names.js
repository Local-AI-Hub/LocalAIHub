const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const service = require('../electron/services/modelService');
const t = service._test;
const logger = { info: async () => {}, warn: async () => {} };
const hardware = { disks: [], hardware: { vramMb: 6144, ramMb: 16384 } };
function makeTool(root, id = 'rvc') {
  return { id, name: id, appDir: root, installDir: root, status: 'stopped', modelManager: { enabled: true, targetLayout: { basePath: 'app-dir', directories: id === 'rvc' ? { 'RVC Voice Model': 'weights' } : { GGUF: 'models' } } } };
}
async function verifyNames(root) {
  const tool = makeTool(root);
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => new Response('data', { headers: { 'content-length': '4' } });
    const payload = (repo) => ({ id: repo, name: repo, source: 'huggingface', catalogRepositoryId: repo, sourceArtifactPath: 'model.pth', fileName: 'model.pth', modelType: 'RVC Voice Model', downloadUrl: 'https://huggingface.co/' + repo + '/resolve/main/model.pth', sizeBytes: 4, lowDiskConfirmed: true });
    const first = payload('author/voice-one');
    const second = payload('author/voice-two');
    const a = await service.downloadModel(tool, first);
    const b = await service.downloadModel(tool, second);
    assert.notEqual(a.destinationPath, b.destinationPath);
    assert.equal(await fs.readFile(a.destinationPath, 'utf8'), 'data');
    assert.equal(await fs.readFile(b.destinationPath, 'utf8'), 'data');
    assert.equal((await service.downloadModel(tool, first)).alreadyPresent, true);
    const named = { ...first, fileName: 'ActualVoice.pth', sourceArtifactPath: 'ActualVoice.pth' };
    assert.equal(t.resolveModelDestination(tool, named).fileName, 'ActualVoice.pth');
    const card = t.buildHuggingFaceRepositoryResult({ id: first.catalogRepositoryId }, { rfilename: 'model.pth', modelType: 'RVC Voice Model', sizeBytes: 4 }, tool, new Set(), hardware, null, null);
    assert.equal(card.installRelativePath, t.resolveModelDestination(tool, first).installRelativePath);
    assert.equal(card.artifactChoices[0].payload.installRelativePath, card.installRelativePath);
    assert(card.downloadUrl.endsWith('/model.pth'), 'Upstream filename must remain intact.');
    assert.equal(card.sourceArtifactPath, 'model.pth');
    const derived = t.resolveModelDestination(tool, { ...card, ...card.artifactChoices[0].payload });
    assert.equal(derived.destinationPath, a.destinationPath, 'Naming must be stable across catalog and execution.');
  } finally { global.fetch = originalFetch; }
}
async function verifyOtherSources(root) {
  const tool = makeTool(root);
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => new Response('data', { headers: { 'content-length': '4' } });
    for (const source of ['huggingface', 'civitai', 'tabby']) {
      for (const fileName of ['weights.pth', 'checkpoint.ckpt', 'pytorch_model.bin', 'model.fp16.safetensors']) {
        const payload = (version) => ({ id: source + fileName + version, name: source + version, source, fileName, sourceArtifactPath: fileName, catalogRepositoryId: 'author/' + source + version, catalogModelId: '100', catalogVersionId: String(version), sourceFileId: String(version), modelType: 'RVC Voice Model', downloadUrl: 'https://example.test/' + fileName, sizeBytes: 4, lowDiskConfirmed: true });
        const a = await service.downloadModel(tool, payload(1));
        const b = await service.downloadModel(tool, payload(2));
        assert.notEqual(a.destinationPath, b.destinationPath, source + ' must distinguish generic files by provenance.');
        assert.equal(await fs.readFile(a.destinationPath, 'utf8'), 'data');
        assert.equal(await fs.readFile(b.destinationPath, 'utf8'), 'data');
        assert.equal((await service.downloadModel(tool, payload(1))).alreadyPresent, true);
      }
    }
    const entry = { version: { id: 2, name: 'v2' }, file: { id: 3, name: 'weights.pth', normalizedType: 'RVC Voice Model', sizeBytes: 4, downloadUrl: 'https://example.test/weights.pth' } };
    const card = t.buildCivitaiModelResult({ id: 1, name: 'voice' }, entry, tool, new Set(), hardware, null);
    const selected = { ...card, ...card.artifactChoices[0].payload };
    assert.equal(card.installRelativePath, t.resolveModelDestination(tool, selected).installRelativePath);
    assert.equal(card.sourceArtifactPath, 'weights.pth');
    assert.equal(card.fileName, 'weights.pth');
    const scoped = { ...tool, modelManager: { ...tool.modelManager, targetLayout: { ...tool.modelManager.targetLayout, repositoryScoped: true } } };
    const base = { source: 'tabby', catalogRepositoryId: 'author/one', fileName: 'weights.pth', sourceArtifactPath: 'weights.pth', modelType: 'RVC Voice Model' };
    const first = t.resolveModelDestination(scoped, base);
    const second = t.resolveModelDestination(scoped, { ...base, catalogRepositoryId: 'author/two' });
    assert.equal(first.fileName, 'weights.pth');
    assert.notEqual(first.destinationPath, second.destinationPath, 'Repository folders must isolate fixed filenames.');
    assert.equal(t.getModelInstallRelativePath(tool, { ...base, downloadPlan: { planType: 'package' } }), 'weights.pth');
    assert.equal(t.getModelInstallRelativePath({ ...tool, id: 'invokeai' }, base), 'weights.pth');
    const ollama = { id: 'ollama' };
    const keys = ['author/model:small', 'author/model:large', 'other/model:small'].map((name) => t.resolveModelDownloadLockKey(ollama, { source: 'ollama', name }));
    assert.equal(new Set(keys).size, 3, 'Ollama namespaces and tags must stay distinct.');
    assert.equal(t.getModelInstallRelativePath(ollama, { source: 'ollama', name: 'author/model:small', fileName: 'weights.pth' }), 'weights.pth', 'Never rename backend-owned Ollama blobs.');
  } finally { global.fetch = originalFetch; }
}
async function verifySearch(root) {
  const tool = makeTool(root, 'koboldcpp');
  const originalFetch = global.fetch;
  const calls = [];
  const detail = { id: 'author/aurora-voice-pack', tags: ['gguf'], siblings: [ { rfilename: 'model.gguf', size: 4 }, { rfilename: 'Aurora_Voice_Q4_K_M.gguf', size: 4 } ] };
  try {
    t.clearAllModelManagerCaches();
    global.fetch = async (url) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/models') {
        const query = u.searchParams.get('search');
        const cursor = u.searchParams.get('cursor');
        calls.push({ query, cursor });
        const matches = query === 'aurora-voice';
        return new Response(JSON.stringify(matches ? [{ id: detail.id }] : []), { headers: matches && !cursor ? { link: '<https://huggingface.co/api/models?cursor=next-aurora>; rel="next"' } : {} });
      }
      if (u.pathname === '/api/models/' + detail.id) return new Response(JSON.stringify(detail));
      return new Response('', { status: 404 });
    };
    const options = { query: 'aurora voice', limit: 1, modelType: 'gguf', taskType: 'text-generation', sort: 'most-downloaded', source: 'huggingface' };
    const result = await t.searchHuggingFaceModels(tool, options, new Set(), hardware, logger);
    assert.equal(result.items.length, 1, 'Spaces must discover hyphenated provider repository names.');
    assert.equal(result.items[0].fileName, 'Aurora_Voice_Q4_K_M.gguf', 'A partial filename must select its matching artifact ahead of generic model.gguf.');
    assert.equal(result.items[0].artifactChoices.find((choice) => choice.recommended).fileName, 'Aurora_Voice_Q4_K_M.gguf');
    assert(result.pagination.nextCursor, 'Fallback pagination must survive.');
    await t.searchHuggingFaceModels(tool, { ...options, cursor: result.pagination.nextCursor }, new Set(), hardware, logger);
    assert(calls.some((call) => call.query === 'aurora-voice' && call.cursor === 'next-aurora'));
    assert(!calls.some((call) => call.query === 'aurora voice' && call.cursor === 'next-aurora'));
    for (const query of ['Auror', 'aurora voice', 'Aurora_Voice', 'aurora-voice']) {
      assert(t.matchesSearchQuery(query, ['Aurora_Voice_Q4_K_M.gguf']), query);
    }
    assert(!t.matchesSearchQuery('unrelated singer', ['Aurora_Voice_Q4_K_M.gguf']));
    const before = calls.length;
    const exact = await t.searchHuggingFaceModels(tool, { ...options, query: detail.id }, new Set(), hardware, logger);
    assert.equal(exact.items[0]?.name, detail.id);
    assert.equal(exact.pagination.hasMore, false);
    assert.equal(calls.length, before);
    t.clearAllModelManagerCaches();
    const incompatible = { ...detail, id: 'author/aurora-unsupported', siblings: [{ rfilename: 'config.json' }, { rfilename: 'model.safetensors', size: 4 }] };
    global.fetch = async url => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/models') return new Response(JSON.stringify([incompatible, detail]));
      if (pathname === '/api/models/' + incompatible.id) return new Response(JSON.stringify(incompatible));
      if (pathname === '/api/models/' + detail.id) return new Response(JSON.stringify(detail));
      return new Response('', { status: 404 });
    };
    const ranked = await t.searchHuggingFaceModels(tool, { ...options, query: 'aurora', limit: 2 }, new Set(), hardware, logger);
    assert.deepEqual(ranked.items.map(item => item.name), [detail.id, incompatible.id], 'Runnable results should precede blocked repositories.');

    t.clearAllModelManagerCaches();
    global.fetch = async url => {
      const u = new URL(url);
      if (u.pathname === '/api/models') {
        return Response.json(u.searchParams.has('pipeline_tag') ? [] : [{ id: detail.id }]);
      }
      return Response.json(detail);
    };
    const untagged = await t.searchHuggingFaceModels(tool, { ...options, query: 'aurora' }, new Set(), hardware, logger);
    assert.equal(untagged.items[0]?.name, detail.id, 'A one-word search should discover untagged compatible repositories.');
    t.clearAllModelManagerCaches();
    global.fetch = async url => new URL(url).pathname === '/api/models'
      ? Response.json([{ id: detail.id }])
      : new Response('Too many requests', { status: 429 });
    await assert.rejects(t.searchHuggingFaceModels(tool, options, new Set(), hardware, logger), { code: 'CATALOG_RATE_LIMITED' });
  } finally { global.fetch = originalFetch; t.clearAllModelManagerCaches(); }
}
async function verifyProviderResults() {
  const tool = { id: 'ollama', name: 'Ollama' };
  const originalFetch = global.fetch;
  const options = { query: 'qwen2.5:0.5b', sort: 'most-downloaded', page: 1 };
  try {
    global.fetch = async url => new Response(new URL(url).pathname.endsWith('/tags')
      ? '<a href="/library/qwen2.5:0.5b-q4">qwen2.5:0.5b-q4</a>'
      : new URL(url).pathname === '/library'
      ? '<main><a class="card" href="/library/qwen2.5">Qwen2.5</a></main>'
      : '<a class="row" href="/library/qwen2.5%3A0.5b"><span>qwen2.5:0.5b</span> 398MB · 32K context window</a>');
    const tags = await t.searchOllamaLibrary(tool, options, new Set(), hardware, logger);
    assert.equal(tags.items[0]?.name, options.query);
    assert(tags.items[0].sizeBytes > 0);
    const quantized = await t.searchOllamaLibrary(tool, { ...options, query: 'qwen2.5:0.5b-q4' }, new Set(['qwen2.5']), hardware, logger);
    assert.equal(quantized.items[0]?.name, 'qwen2.5:0.5b-q4');
    assert.equal(quantized.items[0].downloaded, false);
    const spaced = await t.searchOllamaLibrary(tool, { ...options, query: 'qwen2.5 0.5b' }, new Set(), hardware, logger);
    assert.equal(spaced.items[0]?.name, options.query);
    const spacedFullTag = await t.searchOllamaLibrary(tool, { ...options, query: 'qwen2.5 0.5b-q4' }, new Set(), hardware, logger);
    assert.equal(spacedFullTag.items[0]?.name, 'qwen2.5:0.5b-q4', 'Spaced tags must also search the full tag list.');
    assert.match(tags.items[0].hardwareFit.message, /Ollama/);
    const missingSize = await t.searchOllamaLibrary(tool, { ...options, query: 'qwen2.5 999b' }, new Set(), hardware, logger);
    assert.equal(missingSize.items.length, 0, 'A missing size must not select a default family variant.');
    const missing = await t.searchOllamaLibrary(tool, { ...options, query: 'qwen2.5:unknown' }, new Set(), hardware, logger);
    assert.equal(missing.items.length, 0);
    t.clearAllModelManagerCaches();
    const familyHtml = [
      '<section class="flex flex-1 flex-col"><h2 class="text-base font-semibold leading-6 text-neutral-900">Models</h2>',
      '<div class="hidden group sm:grid"><a href="/library/example:1b">example:1b</a>',
      '<span>850MB</span><p class="col-span-2 text-neutral-500">32K</p>',
      '<p class="col-span-2 text-neutral-500">Text</p></div></section>',
    ].join('');
    global.fetch = async url => new Response(new URL(url).pathname === '/library'
      ? '<main><a class="card" href="/library/example">example</a></main>'
      : familyHtml);
    const desktopRow = await t.searchOllamaLibrary(tool, { ...options, query: 'example:1b' }, new Set(), hardware, logger);
    assert.equal(desktopRow.items[0]?.sizeBytes, 850 * 1024 * 1024);
    assert.equal(desktopRow.items[0]?.contextLabel, '32K context window');

  } finally { global.fetch = originalFetch; t.clearAllModelManagerCaches(); }
  try {
    let page;
    global.fetch = async url => {
      page = new URL(url).searchParams.get('page');
      const metadata = page ? {} : { nextPage: 'https://civitai.com/api/v1/models?page=2' };
      return new Response(JSON.stringify({ items: [], metadata }));
    };
    const options = { query: 'DreamShap', page: 1, limit: 24, modelType: 'all', taskType: 'image-generation' };
    const search = page => t.searchCivitaiModels({ id: 'forge' }, { ...options, page }, new Set(), {}, hardware, logger);
    const first = await search(1);
    assert.equal(first.pagination.nextPage, 2);
    assert.equal((await search(first.pagination.nextPage)).pagination.hasMore, false);
    assert.equal(page, '2');
  } finally { global.fetch = originalFetch; t.clearAllModelManagerCaches(); }
  for (const sizeKB of [0.5, 250, 2083794]) {
    const [result] = t.collectCivitaiVersionFiles({ type: 'Checkpoint', modelVersions: [{ files: [{ name: 'test.safetensors', sizeKB }] }] }, 'all');
    assert.equal(result.file.sizeBytes, Math.round(sizeKB * 1024));
  }
  assert(!t.matchesSearchQuery('初音', ['unrelated model']));
  assert(t.matchesSearchQuery('初音', ['初音ミク.pth']));
}
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-search-review-'));
  try { await verifyNames(root); await verifyOtherSources(root); await verifySearch(root); await verifyProviderResults(); } finally { await fs.remove(root); }
  console.log('Model Manager filename and partial-search checks passed.');
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
