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
    const windowsRepo = await t.searchHuggingFaceModels(tool, { ...options, query: detail.id.replace('/', '\\') }, new Set(), hardware, logger);
    assert.equal(windowsRepo.items[0]?.name, detail.id);
    assert.equal(calls.length, before, 'A pasted Windows-style repository ID must use the exact lookup.');

    t.clearAllModelManagerCaches();
    const detailRequests = [];
    global.fetch = async url => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/models') return Response.json([detail, { id: 'author/aurora-unneeded' }]);
      if (pathname.startsWith('/api/models/')) {
        detailRequests.push(pathname);
        return pathname.endsWith(detail.id) ? Response.json(detail) : new Response('', { status: 429 });
      }
      return new Response('', { status: 404 });
    };
    const filledPage = await t.searchHuggingFaceModels(tool, { ...options, query: 'aurora' }, new Set(), hardware, logger);
    assert.equal(filledPage.items[0]?.name, detail.id);
    assert.deepEqual(detailRequests, ['/api/models/' + detail.id], 'A full page should stop requesting repository details.');
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
    const rvcTool = makeTool(tool.appDir);
    const rvcOptions = { ...options, query: 'aurora', limit: 2, modelType: 'rvc-voice', taskType: 'voice-conversion' };
    const voice = { id: 'author/aurora-rvc', tags: ['rvc'], siblings: [{ rfilename: 'model.pth', size: 8 }] };
    const other = { id: 'author/aurora-classifier', siblings: [{ rfilename: 'classifier.pt', size: 8 }] };
    global.fetch = async url => {
      const u = new URL(url);
      if (u.pathname === '/api/models') return Response.json([other, voice]);
      for (const repo of [other, voice]) {
        if (u.pathname === '/api/models/' + repo.id) return Response.json(repo);
      }
      return new Response('', { status: 404 });
    };
    const visible = await t.searchHuggingFaceModels(rvcTool, rvcOptions, new Set(), hardware, logger);
    assert.deepEqual(visible.items.map(item => item.name), [voice.id]);
    const all = await t.searchHuggingFaceModels(rvcTool, { ...rvcOptions, includeIncompatible: true }, new Set(), hardware, logger);
    assert.deepEqual(all.items.map(item => item.name), [voice.id, other.id]);
    assert.equal(all.items[1].downloadPlan.runnable, false);

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
async function verifyCollectionsAndVoiceBundles(root) {
  const tool = makeTool(root);
  const options = { limit: 1, source: 'huggingface', modelType: 'rvc-voice', taskType: 'voice-conversion' };
  const repos = {
    'former/alias': { id: 'author/language-model', tags: ['fill-mask'], siblings: [{ rfilename: 'model.safetensors', size: 42 }] },
    gpt2: { id: 'author/language-model', pipeline_tag: 'text-generation', siblings: [{ rfilename: 'model.safetensors', size: 42 }] },
    'author/language-model': { pipeline_tag: 'text-generation', siblings: [{ rfilename: 'model.safetensors', size: 42 }] },
    'author/encoder': { tags: ['transformers', 'fill-mask'], siblings: [{ rfilename: 'model.safetensors', size: 42 }] },
    'author/vision': { pipeline_tag: 'image-classification', siblings: [{ rfilename: 'model.safetensors', size: 42 }] },
    'author/speech': { pipeline_tag: 'automatic-speech-recognition', siblings: [{ rfilename: 'model.safetensors', size: 42 }] },
    'author/unknown': { siblings: [{ rfilename: 'model.safetensors', size: 42 }] },
    'author/image': { pipeline_tag: 'text-to-image', siblings: [{ rfilename: 'model.safetensors', size: 42 }, { rfilename: 'models/image_encoder/model.safetensors', size: 99 }] },
    'author/character': { siblings: [{ rfilename: 'Character.zip', size: 123 }] },
    'author/large-rvc': { siblings: Array.from({ length: 135 }, (_, i) => ({ rfilename: 'voices/speaker-' + String(i).padStart(3, '0') + '.zip', size: 123 })) },
    'author/gguf-only': { siblings: [{ rfilename: 'one.gguf', size: 8 }] },
    'author/training-rvc': { siblings: [{ rfilename: 'f0G40k.pth', size: 12 }] },
    'author/gated': { gated: 'auto', siblings: [{ rfilename: 'model.gguf', size: 12 }] },
  };
  const originalFetch = global.fetch;
  try {
    global.fetch = async url => {
      const u = new URL(url);
      if (u.pathname === '/api/collections/author/mixed') return Response.json({ items: [{ type: 'model', id: 'author/gguf-only' }] });
      if (u.pathname === '/api/collections' && u.searchParams.get('owner') === 'author') return Response.json([{ slug: 'author/voices-0123456789abcdef01234567' }]);
      if (u.pathname === '/api/collections/author/voices-0123456789abcdef01234567') return Response.json({ title: 'RVC voices', items: [
        { type: 'model', id: 'author/character' }, { type: 'dataset', id: 'author/dataset' }, { type: 'model', id: 'author/training-rvc' },
      ] });
      const id = u.pathname.replace('/api/models/', '');
      if (repos[id]) return Response.json({ id, ...repos[id] });
      return new Response('', { status: 404 });
    };
    const search = (query, target = tool, cursor = null) => t.searchHuggingFaceModels(target, { ...options, query, cursor }, new Set(), hardware, logger);
    for (const target of ['forge', 'automatic1111', 'invokeai', 'comfyui']) {
      const imageSearch = query => t.searchHuggingFaceCatalog(makeTool(root, target), { ...options, query, modelType: 'all', taskType: 'image-generation' }, new Set(), hardware, logger);
      for (const query of ['https://huggingface.co/gpt2', 'https://hf.co/gpt2/blob/main/model.safetensors', 'author/encoder model.safetensors', 'author/vision model.safetensors', 'author/speech model.safetensors', 'author/unknown model.safetensors', 'https://huggingface.co/former/alias/resolve/main/model.safetensors']) {
        const [item] = (await imageSearch(query)).items;
        assert.equal(item.downloadPlan.runnable, false, target + ' ' + query);
        assert.equal(item.hardwareFit.label, 'Incompatible');
        await assert.rejects(service.getModelDownloadPreflight(makeTool(root, target), item), /language model|compatible|artifact|weights/i);
        assert(item.artifactChoices.every(choice => choice.disabled));
        if (query.includes('gpt2')) assert.equal(item.catalogRepositoryId, 'author/language-model');
      }
      const [encoder] = (await imageSearch('https://huggingface.co/author/image/blob/main/models/image_encoder/model.safetensors')).items;
      assert.equal(encoder.downloadPlan.runnable, false);
      await assert.rejects(service.getModelDownloadPreflight(makeTool(root, target), encoder));
      assert.equal((await imageSearch('author/image model.safetensors')).items[0].downloadPlan.runnable, true);
    }
    const direct = await search('https://huggingface.co/author/character');
    assert.equal(direct.items[0].artifactKind, 'rvc-unverified-zip');
    for (const query of ['author/voices', 'https://huggingface.co/collections/author/voices']) {
      const first = await search(query);
      assert.equal(first.items[0].artifactKind, 'rvc-voice-zip');
      const second = await search(query, tool, first.pagination.nextCursor);
      assert.match(second.items[0].downloadPlan.blockingReason, /training/);
    }
    const large = await search('author/large-rvc');
    assert.equal(large.items[0].artifactChoices.length, 128);
    const rest = await search('author/large-rvc', tool, large.pagination.nextCursor);
    assert.equal(rest.items[0].artifactChoices.length, 7);
    assert.equal(rest.pagination.hasMore, false);
    const scoped = await search('author/large-rvc speaker-129');
    assert.equal(scoped.items[0].fileName, 'speaker-129.zip');
    const llmCollection = await t.searchHuggingFaceModels(makeTool(root, 'koboldcpp'), { ...options, modelType: 'gguf', query: 'collections/author/mixed' }, new Set(), hardware, logger);
    assert.equal(llmCollection.items[0].fileName, 'one.gguf');
    const gated = await search('author/gated', makeTool(root, 'koboldcpp'));
    assert.match(gated.items[0].downloadPlan.blockingReason, /restricts downloads/);
    repos['author/rvc-pack'] = { tags: ['rvc'], siblings: ['rogue_datasets.zip', 'voices/rogue.zip', 'embedders/chinese_hubert_base.pt', 'indices/可可.index', 'voices/可可.pth', 'indices/诗韵.index', 'voices/诗韵.pth', 'README.md'].map(rfilename => ({ rfilename, size: 42 })) };
    const provider = global.fetch;
    global.fetch = async url => String(url).endsWith('/resolve/main/README.md') ? new Response('| Akuma Nihmune | [numi](voices/rogue.zip) |') : provider(url);
    for (const input of ['author/rvc-pack rogue.zip', 'https://huggingface.co/author/rvc-pack/blob/main/voices/rogue.zip', 'https://huggingface.co/author/rvc-pack/resolve/main/voices/rogue.zip?download=true', 'https://hf.co/author/rvc-pack/raw/main/voices/rogue.zip', 'author/rvc-pack Akuma Nihmune']) {
      const result = await search(input);
      assert.equal(result.items[0]?.sourceArtifactPath, 'voices/rogue.zip', input);
      assert.equal(result.items[0].artifactChoices.length, 1, input);
    }
    for (const file of ['embedders/chinese_hubert_base.pt', 'rogue_datasets.zip', 'indices/可可.index']) {
      const result = await search('author/rvc-pack ' + file);
      assert.equal(result.items[0]?.fileName, file);
      assert.equal(result.items[0]?.downloadPlan.runnable, false);
    }
    assert.equal((await search('author/rvc-pack voices/可可.pth')).items[0].downloadPlan.optionalArtifacts[0].path, 'indices/可可.index');
    assert.equal((await search('https://huggingface.co/author/rvc-pack/blob/main/missing.zip')).items.length, 0);
    await assert.rejects(search('https://huggingface.co/author/rvc-pack/tree/bogus'), /revision/);
    await assert.rejects(search('https://huggingface.co/datasets/author/voices'), /dataset/);
    t.clearAllModelManagerCaches();
    global.fetch = async url => new URL(url).searchParams.has('expand') ? Response.json([{ id: 'author/rvc-pack', siblings: repos['author/rvc-pack'].siblings }]) : provider(url);
    const discovered = await t.searchHuggingFaceCatalog(tool, { ...options, query: 'rogue.zip' }, new Set(), hardware, logger);
    assert.equal(discovered.items[0]?.sourceArtifactPath, 'voices/rogue.zip');
    t.clearAllModelManagerCaches();
    const group = ['author/aurora-voice-one', 'author/aurora-voice-two', 'author/aurora-voice-three'];
    global.fetch = async url => {
      const u = new URL(url);
      if (u.pathname === '/api/models') {
        const term = u.searchParams.get('search');
        const ids = term === 'aurora voice' ? group.slice(0, 1) : term === 'aurora-voice' ? group.slice(1) : [];
        return Response.json(ids.map(id => ({ id })));
      }
      const id = u.pathname.slice('/api/models/'.length);
      return group.includes(id) ? Response.json({ id, tags: ['rvc'], siblings: [{rfilename: 'voice.pth', size: 12}] }) : new Response('', { status: 404 });
    };
    const lookup = cursor => t.searchHuggingFaceModels(tool, { ...options, limit: 2, query: 'aurora voice', cursor }, new Set(), hardware, logger);
    const firstPage = await lookup(null);
    assert.equal(firstPage.items.length, 2);
    const lastPage = await lookup(firstPage.pagination.nextCursor);
    assert.deepEqual([...firstPage.items, ...lastPage.items].map(item => item.name), group);
    assert.equal(lastPage.pagination.nextCursor, null);
    const archive = require('archiver')('zip');
    const chunks = [];
    archive.on('data', data => chunks.push(data));
    const ended = require('events').once(archive, 'end');
    archive.append('weight', { name: 'voice/character.pth' });
    archive.append('index', { name: 'voice/character.index' });
    archive.append('training', { name: 'voice/G_1000.pth' });
    await archive.finalize();
    await ended;
    const outer = require('archiver')('zip');
    const outerChunks = [];
    outer.on('data', chunk => outerChunks.push(chunk));
    const outerEnd = require('events').once(outer, 'end');
    outer.append(Buffer.concat(chunks), { name: 'voice data.zip' });
    await outer.finalize();
    await outerEnd;
    const data = Buffer.concat(outerChunks);
    global.fetch = async () => new Response(data, { headers: { 'content-length': String(data.length) } });
    const item = { ...direct.items[0], sizeBytes: data.length, lowDiskConfirmed: true };
    const preflight = bytes => t.buildModelDownloadPreflight(tool, { ...item, sizeBytes: bytes }, { disks: [] });
    const unknown = await preflight(data.length);
    assert.equal(unknown.sizeKnown, false);
    assert.equal(unknown.requiredBytes, data.length);
    const rangeResponse = zip => async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=0-' + (zip.length - 1));
      return new Response(zip, { status: 206, headers: { 'Content-Range': 'bytes 0-' + (zip.length - 1) + '/' + zip.length } });
    };
    const single = Buffer.concat(chunks);
    global.fetch = rangeResponse(single);
    const known = await preflight(single.length);
    assert.equal(known.requiredBytes, single.length + 11);
    assert.equal(known.sizeKnown, true);
    global.fetch = rangeResponse(data);
    const nested = await preflight(data.length);
    assert.equal(nested.requiredBytes, data.length + single.length);
    assert.equal(nested.sizeKnown, false);
    global.fetch = async () => new Response(data, { headers: { 'content-length': String(data.length) } });
    const installed = await service.downloadModel(tool, item);
    assert.match(installed.fileName, /\.pth$/);
    assert.equal(await fs.readFile(installed.destinationPath, 'utf8'), 'weight');
    const stem = path.parse(installed.fileName).name;
    const index = path.join(root, 'logs', stem, stem + '.index');
    assert.equal(await fs.readFile(index, 'utf8'), 'index');
    assert.equal((await service.downloadModel(tool, item)).alreadyPresent, true);
    await service.deleteModel(tool, { ...item, path: installed.destinationPath });
    assert.equal(await fs.pathExists(index), false);
    assert.equal(await fs.pathExists(installed.destinationPath), false);
  } finally { global.fetch = originalFetch; t.clearAllModelManagerCaches(); }
}
async function verifyProviderResults() {
  const tool = { id: 'ollama', name: 'Ollama', installDir: process.cwd() };
  const catalogHardware = { ...hardware, disks: [{ mount: path.parse(process.cwd()).root, sizeBytes: 100 * 1024 ** 3, freeBytes: 30 * 1024 ** 3 }] };
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
    const lookup = query => t.searchOllamaLibrary(tool, { ...options, query }, new Set(), catalogHardware, logger);
    const tagPageUrl = quantized.items[0].modelPageUrl;
    assert.equal(tagPageUrl, 'https://ollama.com/library/qwen2.5:0.5b-q4');
    for (const query of [tagPageUrl, tagPageUrl.replace('2.5:', '2.5%3A')]) {
      assert.deepEqual((await lookup(query)).items.map(item => item.name), ['qwen2.5:0.5b-q4']);
    }
    const libraryFetch = global.fetch;
    global.fetch = async url => new URL(url).pathname === '/publisher/family/tags'
      ? new Response('<a href="/publisher/family:latest">latest 1GB</a><a href="/publisher/family%3Aq3_k_m">q3_k_m 47GB</a>')
      : libraryFetch(url);
    const community = (await lookup('https://ollama.com/publisher/family/tags')).items[0];
    assert.deepEqual(community.artifactChoices.map(choice => choice.versionLabel), ['publisher/family:latest', 'publisher/family:q3_k_m']);
    for (const query of ['publisher/family:q3_k_m', 'https://ollama.com/publisher/family%3Aq3_k_m']) {
      const [item] = (await lookup(query)).items;
      assert.equal(item.modelPageUrl, 'https://ollama.com/publisher/family:q3_k_m');
      assert.equal(item.fileName, 'publisher/family:q3_k_m');
      assert.equal(item.sizeBytes, 47 * 1000 ** 3);
      assert.match(item.hardwareFit.message, /47 GB/);
      const savedFetch = global.fetch;
      try {
        global.fetch = async url => {
          assert.equal(String(url), 'https://registry.ollama.ai/v2/publisher/family/manifests/q3_k_m');
          return Response.json({ config: { size: 50 }, layers: [{ size: 46900123456 }] });
        };
        const exact = await t.buildModelDownloadPreflight(tool, item, { disks: [] });
        assert.equal(exact.requiredBytes, 46900123506);
        assert.equal(exact.sizeKnown, true);
        global.fetch = async () => new Response('', { status: 404 });
        const estimated = await t.buildModelDownloadPreflight(tool, item, { disks: [] });
        assert.equal(estimated.requiredBytes, 47000000000);
        assert.equal(estimated.sizeKnown, false);
        assert.match(estimated.spaceNote, /estimate/i);
      } finally { global.fetch = savedFetch; }
      const selected = require('../electron/shared/modelArtifactSelection.cjs').buildSelectedCatalogItem(community, community.artifactChoices[1].id);
      assert.deepEqual(selected.hardwareFit, item.hardwareFit);
      assert.equal(community.diskWarning.tone, 'good');
      assert.equal(selected.diskWarning.tone, 'danger');
      assert.deepEqual(selected.diskWarning, item.diskWarning);
      assert.notEqual(community.hardwareFit.label, selected.hardwareFit.label);
    }
    assert.equal((await lookup('publisher/family:q3_m_k')).items.length, 0);
    global.fetch = libraryFetch;

    const tagsPage = await t.searchOllamaLibrary(tool, { ...options, query: 'https://ollama.com/library/qwen2.5/tags' }, new Set(), hardware, logger);
    assert.equal(tagsPage.items.length, 1);
    assert(tagsPage.items[0].artifactChoices.some(choice => choice.versionLabel === 'qwen2.5:0.5b-q4'));
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
    assert.equal(desktopRow.items[0]?.sizeBytes, 850 * 1000 * 1000);
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
    global.fetch = async url => {
      assert.equal(new URL(url).pathname, '/api/v1/models/4384');
      const modelVersions = [7, 8].map(id => ({ id, files: [{ id, name: 'v' + id + '.safetensors', downloadUrl: 'https://civitai.com/api/download/models/' + id, sizeKB: 5 }] }));
      return Response.json({ id: 4384, name: 'Fixture', type: 'Checkpoint', modelVersions });
    };
    const direct = query => t.searchCivitaiModels({ id: 'forge' }, { ...options, query }, new Set(), {}, hardware, logger);
    const family = await direct('https://civitai.com/models/4384/dreamshaper');
    assert.equal(family.items.length, 1);
    assert.equal(family.items[0].artifactChoices.length, 2);
    const version = await direct(family.items[0].modelPageUrl);
    assert.equal(version.items[0].artifactChoices.length, 1);
    assert.equal(version.items[0].fileName, family.items[0].fileName);
    assert.equal((await direct('https://civitai.com/models/4384?modelVersionId=999')).items.length, 0);
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
  try { await verifyNames(root); await verifyOtherSources(root); await verifySearch(root); await verifyCollectionsAndVoiceBundles(root); await verifyProviderResults(); } finally { await fs.remove(root); }
  console.log('Model Manager filename and partial-search checks passed.');
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
