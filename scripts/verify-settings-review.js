const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

// Exercise the production services against disposable storage and an empty tool registry.
async function verify(root) {
  process.env.APPDATA = path.join(root, 'roaming');
  process.env.LOCALAPPDATA = path.join(root, 'local');
  const config = require('../electron/services/configService');
  const registry = require('../electron/services/toolRegistry');
  registry.initializeToolRegistry = async () => {};
  registry.getToolDefinitions = () => [];
  const windows = require('../electron/services/windowsUninstallService');
  windows.collectStaleToolWindowsShortcuts = async () => [];
  windows.collectStaleWindowsUninstallEntries = async () => [];
  const background = require('../electron/services/backgroundTaskService');
  const { setManagedDataRoot } = require('../electron/services/storageLocationService');
  const { inspectCleanupTargets, runCleanup } = require('../electron/services/storageCleanupService');

  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await setManagedDataRoot(source);
    const files = ['models/model.bin', 'recordings/clip.webm', 'projects/demo/index.html', 'libraries/empty.txt'];
    for (const name of files) await fs.outputFile(path.join(source, name), name.startsWith('libraries') ? '' : name);
    await fs.outputFile(path.join(target, files[1]), 'original destination');
    await assert.rejects(setManagedDataRoot(target, { migrateExistingData: true }), /already exists/);
    assert.equal(await fs.readFile(path.join(target, files[1]), 'utf8'), 'original destination');
    assert.equal((await config.readConfig()).managedDataRoot, source);
    for (const name of files) assert.ok(await fs.pathExists(path.join(source, name)));
    await fs.unlink(path.join(target, files[1]));
    const move = fs.move;
    let injected = false;
    fs.move = async (from, to, options) => {
      if (from === path.join(source, files[1])) {
        injected = true;
        throw new Error('simulated move failure');
      }
      return move(from, to, options);
    };
    try {
      await assert.rejects(setManagedDataRoot(target, { migrateExistingData: true }), /simulated move failure/);
      assert.ok(injected);
      for (const name of files) assert.ok(await fs.pathExists(path.join(source, name)));
      assert.equal((await config.readConfig()).managedDataRoot, source);
    } finally {
      fs.move = move;
    }
    await setManagedDataRoot(target, { migrateExistingData: true });
    for (const name of files) {
      assert.equal(await fs.readFile(path.join(target, name), 'utf8'), name.startsWith('libraries') ? '' : name);
      assert.equal(await fs.pathExists(path.join(source, name)), false);
    }
    const reviewed = path.join(target, 'downloads', 'reviewed.part');
    const later = path.join(target, 'downloads', 'later.part');
    const snapshot = path.join(target, 'snapshots', 'uninstalled-tool', 'backup.zip');
    await fs.outputFile(reviewed, 'old');
    await fs.outputFile(snapshot, 'backup');
    const preview = await inspectCleanupTargets();
    const paths = preview.categories.flatMap(category => category.entries.map(entry => entry.path));
    assert.ok(paths.includes(reviewed));
    assert.ok(!paths.includes(path.dirname(snapshot)));
    await fs.outputFile(later, 'new');
    const result = await runCleanup([reviewed]);
    assert.deepEqual(result.removedEntries.map(entry => entry.path), [reviewed]);
    assert.ok(await fs.pathExists(later));
    assert.ok(await fs.pathExists(snapshot));
  } finally {
    await background.disposeBackgroundTasks();
  }
}
(async () => {
  const base = os.tmpdir();
  const root = await fs.mkdtemp(path.join(base, 'hub-settings-verifier-'));
  try {
    await verify(root);
    console.log('Settings migration and preview-scoped cleanup passed.');
  } finally {
    assert.equal(path.dirname(root), path.resolve(base));
    await fs.remove(root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
