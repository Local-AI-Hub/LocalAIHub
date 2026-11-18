const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

async function main() {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-pipeline-store-'));
  const configPath = require.resolve('../electron/services/configService');
  require.cache[configPath] = {
    id: configPath,
    loaded: true,
    exports: { ensureStorage: async () => {}, getAppPaths: () => ({ configRoot }) },
  };

  try {
    const store = require('../electron/services/pipelineStoreService');
    const [first, second] = await Promise.all([
      store.savePipeline({ name: 'Same name' }),
      store.savePipeline({ name: 'Same name' }),
    ]);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(await store.getPipeline(first.id), first);
    assert.deepEqual(await store.getPipeline(second.id), second);

    const directory = await store.ensurePipelineStorage();
    const legacy = { ...first, id: 'old-generated-id', name: 'Name used as filename' };
    await fs.writeJson(path.join(directory, 'name-used-as-filename.json'), legacy);
    const collision = await store.savePipeline({ id: 'name-used-as-filename', name: 'Separate pipeline' });
    assert.deepEqual(await store.getPipeline(legacy.id), legacy);
    await store.savePipeline({ ...legacy, name: 'Renamed' });
    assert.equal((await store.getPipeline(legacy.id)).name, 'Renamed');
    assert.equal((await store.listPipelines()).length, 4);
    await store.deletePipeline(legacy.id);
    assert.deepEqual(await store.getPipeline(collision.id), collision);
    await assert.rejects(store.getPipeline(legacy.id), /could not find/);

    const updates = Array.from({ length: 12 }, (_, index) => ({ ...first, name: 'Revision ' + index }));
    await Promise.all(updates.map((definition) => store.savePipeline(definition)));
    assert.equal((await store.getPipeline(first.id)).name, 'Revision 11');
    assert(!(await fs.readdir(directory)).some((entry) => entry.endsWith('.tmp')));

    const previous = await store.getPipeline(first.id);
    const rename = fs.rename;
    fs.rename = async () => { throw new Error('Simulated replacement failure'); };
    try {
      await assert.rejects(store.savePipeline({ ...first, name: 'Interrupted' }), /replacement failure/);
    } finally {
      fs.rename = rename;
    }
    assert.deepEqual(await store.getPipeline(first.id), previous);
    assert(!(await fs.readdir(directory)).some((entry) => entry.endsWith('.tmp')));
  } finally {
    await fs.remove(configRoot);
  }
}

main().then(() => console.log('Pipeline store verification passed.')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
