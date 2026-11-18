const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-snapshot-test-'));
  const snapshotsRoot = path.join(root, 'snapshots');
  const configPath = require.resolve('../electron/services/configService');
  require.cache[configPath] = { loaded: true, exports: { getAppPaths: () => ({ snapshotsRoot }) } };
  const { listSnapshots, saveSnapshot, restoreSnapshot } = require('../electron/services/snapshotService');
  const tool = {
    id: 'example', installDir: root, appDir: path.join(root, 'app'),
    venvDir: path.join(root, '.venv'), configTargets: ['settings.json', 'empty'],
  };
  const settings = path.join(tool.appDir, 'settings.json');
  const dependency = path.join(tool.venvDir, 'example.txt');
  try {
    await assert.rejects(saveSnapshot(tool), /no virtual environment or configured files/);
    await fs.outputFile(settings, 'saved settings');
    await fs.outputFile(dependency, 'saved dependency');
    await fs.ensureDir(path.join(tool.appDir, 'empty'));
    const saving = saveSnapshot(tool);
    await assert.rejects(saveSnapshot(tool), /current snapshot operation/);
    const { fileName } = await saving;
    await fs.outputFile(path.join(snapshotsRoot, tool.id, 'unfinished.zip.partial'), '');
    assert.deepEqual((await listSnapshots(tool.id)).map(item => item.fileName), [fileName]);
    await fs.outputFile(settings, 'current settings');
    await fs.outputFile(dependency, 'current dependency');
    await fs.outputFile(path.join(tool.appDir, 'empty', 'added.txt'), 'later');
    await assert.rejects(restoreSnapshot({ ...tool, status: 'running' }, fileName), /Stop this tool/);

    const move = fs.move;
    fs.move = async (source, destination, ...options) => {
      if (destination === settings) throw new Error('Simulated disk failure');
      return move(source, destination, ...options);
    };
    try {
      await assert.rejects(restoreSnapshot(tool, fileName), /Simulated disk failure/);
    } finally {
      fs.move = move;
    }
    assert.equal(await fs.readFile(settings, 'utf8'), 'current settings');
    assert.equal(await fs.readFile(dependency, 'utf8'), 'current dependency');

    // Existing timestamp-only filenames must remain restorable.
    const legacyName = '2026-01-01T00-00-00-000Z.zip';
    await fs.rename(path.join(snapshotsRoot, tool.id, fileName), path.join(snapshotsRoot, tool.id, legacyName));
    await restoreSnapshot(tool, legacyName);
    assert.equal(await fs.readFile(settings, 'utf8'), 'saved settings');
    assert.equal(await fs.readFile(dependency, 'utf8'), 'saved dependency');
    assert.deepEqual(await fs.readdir(path.join(tool.appDir, 'empty')), []);
    console.log('Snapshot save, list, concurrency, rollback and restore checks passed.');
  } finally {
    await fs.remove(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
