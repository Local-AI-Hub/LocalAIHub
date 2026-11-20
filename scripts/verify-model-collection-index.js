const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createCollectionIndex } = require('../electron/services/modelCollectionIndex');

async function searchPhase(phase) {
  const { _test: t } = require('../electron/services/modelService');
  const id = 'publisher/unremarkable-collection';
  const files = ['voices/opal.zip', 'voices/model.zip', 'README.md', 'a(1).zip', 'two words.zip', 'third.zip'];
  let scans = 0;
  global.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/models/' + id) {
      return Response.json({ id, sha: 'fixture', tags: ['rvc'], siblings: files.map(rfilename => ({rfilename, size: 100})) });
    }
    if (url.pathname.endsWith('/README.md')) return new Response('| Purple Gem | [download](voices/model.zip) |\n[opal](voices/model.zip)\n[Amber](a(1).zip) and [Violet](<two words.zip>)\n[Reference][export]\n[export]: third.zip\n[External library]((https://github.com/example/library))\n| Moonstone | [download](a(1).zip) | Citrine | [download](third.zip) |\nExample: `[PretendVoice](third.zip)`\nDouble ``sample\n[AcrossLines](third.zip)\nmore``\n\\[BeforeLiteral](two words.zip) [RealAfter](third.zip) and \\[AfterLiteral](a(1).zip)\n\n    [IndentedAlias](third.zip)\n\n\\[EscapedAlias](third.zip)\n[Missing file](missing.zip)');
    if (url.pathname === '/api/models') scans++;
    return Response.json([]);
  };
  const root = process.env.LOCALAPPDATA;
  const tool = { id: 'rvc', name: 'RVC', status: 'stopped', installDir: root, appDir: root, modelManager: { enabled: true, targetLayout: { basePath: 'app-dir', directories: { 'RVC Voice Model': 'weights' } } } };
  const search = query => t.searchHuggingFaceCatalog(tool, { query, limit: 5, source: 'huggingface', modelType: 'rvc-voice', taskType: 'voice-conversion' }, new Set(), { hardware: {}, disks: [] }, { warn: async () => {}, info: async () => {} });
  if (phase === 'seed') {
    assert.equal((await search(id)).items[0].catalogRepositoryId, id);
    // Exercise the same persistence barrier as a completed UI or MCP browse.
    await t.flushCollectionIndex();
    const { localRoot } = require('../electron/services/configService').getAppPaths();
    const file = path.join(localRoot, 'model-manager', 'hf-collections-v1.jsonl');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(record.labels.map(row => row.path), [files[1], files[1], files[3], files[4], files[5], files[3], files[5], files[5]]);
    record.labels.push({ path: '(https://github.com/example/library', label: 'External library' });
    await fs.writeFile(file, JSON.stringify(record) + '\n');
  } else if (phase === 'fresh') {
    const { localRoot } = require('../electron/services/configService').getAppPaths();
    const file = path.join(localRoot, 'model-manager', 'hf-collections-v1.jsonl');
    await t.flushCollectionIndex();
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).labels.map(row => row.path), [files[1], files[1], files[3], files[4], files[5], files[3], files[5], files[5]]);

    assert.equal((await search('Purple Gem')).items[0]?.sourceArtifactPath, files[1]);
    const choices = async query => (await search(query)).items[0].artifactChoices.map(choice => choice.label);
    assert.deepEqual((await choices('opal')).sort(), [files[0], files[1]].sort());
    assert.deepEqual(await choices('Amber'), [files[3]]);
    assert.deepEqual(await choices('Violet'), [files[4]]);
    assert.deepEqual(await choices('Reference'), [files[5]]);
    assert.deepEqual(await choices('Moonstone'), [files[3]]);
    assert.deepEqual(await choices('Citrine'), [files[5]]);
    assert.deepEqual(await choices('RealAfter'), [files[5]]);
    assert.equal(scans, 0);
    for (const alias of ['PretendVoice', 'AcrossLines', 'IndentedAlias', 'EscapedAlias', 'BeforeLiteral', 'AfterLiteral']) assert.equal((await search(id + ' ' + alias)).items.length, 0);
  } else {
    assert.equal((await search('opal')).items.length, 0);
    assert(scans > 0);
  }
}

async function main() {
  if (process.argv[2]) return searchPhase(process.argv[2]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-collection-index-'));
  try {
    for (const phase of ['seed', 'fresh', 'separate']) {
      const profile = path.join(root, phase === 'separate' ? 'other' : 'first');
      execFileSync(process.execPath, [__filename, phase], { env: { ...process.env, APPDATA: profile, LOCALAPPDATA: profile }, stdio: 'inherit' });
    }
    const file = path.join(root, 'stress.jsonl');
    const normalize = require('../electron/services/modelService')._test.normalizeSearchSeparators;
    const index = createCollectionIndex(() => file, normalize);
    for (let repo = 0; repo < 600; repo++) {
      await index.remember({ id: 'owner/repo-' + repo, siblings: Array.from({ length: 150 }, (_, i) => ({ rfilename: 'models/unique-character-r' + repo + 'x-variant-' + i + '.pth' })) });
    }
    await index.flush();
    const bytes = (await fs.stat(file)).size;
    assert(bytes <= 2 * 1024 * 1024);
    assert.deepEqual(await index.matchingIds('character r0x'), []);
    const reopened = createCollectionIndex(() => file, normalize);
    const start = performance.now();
    assert.deepEqual(await reopened.matchingIds('character r599x'), ['owner/repo-599']);
    const loaded = performance.now();
    for (let i = 0; i < 10; i++) assert.deepEqual(await reopened.matchingIds('missing-filename'), []);
    console.log('Index bytes:', bytes, 'cold load + lookup ms:', Math.round(loaded - start), 'mean warm miss ms:', ((performance.now() - loaded) / 10).toFixed(1));
    await fs.writeFile(file, 'damaged');
    const recovered = createCollectionIndex(() => file, value => value);
    assert.deepEqual(await recovered.matchingIds('anything'), []);
    await recovered.remember({ id: 'owner/recovered', siblings: [{ rfilename: 'first.zip' }] }, [{ label: 'old label', path: 'first.zip' }]);
    await recovered.remember({ id: 'owner/recovered', sha: 'updated', siblings: [{ rfilename: 'second.zip' }] });
    await recovered.flush();
    assert.deepEqual(await recovered.matchingIds('first'), []);
    assert.deepEqual(await recovered.matchingIds('old label'), []);
    assert.deepEqual(await recovered.matchingIds('second'), ['owner/recovered']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('Persistent collection index checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
