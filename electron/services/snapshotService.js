const path = require('path');
const fs = require('fs-extra');
const archiver = require('archiver');
const extract = require('extract-zip');

const { getAppPaths } = require('./configService');
const { assertPathInside } = require('./pathSafetyService');

function createSnapshotFileName() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
}

async function listSnapshots(toolId) {
  const snapshotDir = path.join(getAppPaths().snapshotsRoot, toolId);
  if (!(await fs.pathExists(snapshotDir))) {
    return [];
  }

  const files = await fs.readdir(snapshotDir);
  return files
    .filter((file) => file.endsWith('.zip'))
    .sort((left, right) => right.localeCompare(left))
    .map((file) => ({
      id: file,
      fileName: file,
      fullPath: path.join(snapshotDir, file),
    }));
}

async function archiveEntryIfPresent(archive, absolutePath, name) {
  if (!(await fs.pathExists(absolutePath))) {
    return;
  }

  const stats = await fs.stat(absolutePath);
  if (stats.isDirectory()) {
    archive.directory(absolutePath, name);
    return;
  }

  archive.file(absolutePath, { name });
}

async function saveSnapshot(toolState) {
  if (!toolState) {
    throw new Error('Local AI Hub could not find that installed tool.');
  }

  const snapshotDir = path.join(getAppPaths().snapshotsRoot, toolState.id);
  await fs.ensureDir(snapshotDir);
  const snapshotPath = assertPathInside(
    snapshotDir,
    path.join(snapshotDir, createSnapshotFileName()),
    'Local AI Hub refused to create a snapshot outside the snapshots folder.',
  );

  const output = fs.createWriteStream(snapshotPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const completed = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });

  archive.pipe(output);

  if (toolState.venvDir) {
    await archiveEntryIfPresent(archive, toolState.venvDir, '.venv');
  }

  for (const relativeTarget of toolState.configTargets || []) {
    const absoluteTarget = assertPathInside(
      toolState.appDir,
      path.join(toolState.appDir, relativeTarget),
      'Local AI Hub refused to snapshot a config path outside the tool folder.',
    );
    await archiveEntryIfPresent(archive, absoluteTarget, relativeTarget);
  }

  archive.append(JSON.stringify(toolState, null, 2), { name: 'tool-state.json' });
  await archive.finalize();
  await completed;

  return {
    fileName: path.basename(snapshotPath),
    fullPath: snapshotPath,
  };
}

async function restoreSnapshot(toolState, snapshotFileName) {
  const snapshotDir = path.join(getAppPaths().snapshotsRoot, toolState.id);
  const snapshotPath = assertPathInside(
    snapshotDir,
    path.join(snapshotDir, path.basename(snapshotFileName || '')),
    'Local AI Hub refused to restore a snapshot outside the snapshots folder.',
  );
  if (!(await fs.pathExists(snapshotPath))) {
    throw new Error('Local AI Hub could not find that snapshot file.');
  }

  const restoreTemp = assertPathInside(
    snapshotDir,
    path.join(snapshotDir, '__restore'),
    'Local AI Hub refused to use a restore folder outside the snapshots directory.',
  );
  await fs.remove(restoreTemp);
  await fs.ensureDir(restoreTemp);

  try {
    await extract(snapshotPath, { dir: restoreTemp });

    if (toolState.venvDir && (await fs.pathExists(path.join(restoreTemp, '.venv')))) {
      const safeVenvDir = assertPathInside(
        toolState.installDir,
        toolState.venvDir,
        'Local AI Hub refused to restore a virtual environment outside the managed tool folder.',
      );
      await fs.remove(safeVenvDir);
      await fs.copy(path.join(restoreTemp, '.venv'), safeVenvDir, { overwrite: true });
    }

    for (const relativeTarget of toolState.configTargets || []) {
      const restoreSource = assertPathInside(
        restoreTemp,
        path.join(restoreTemp, relativeTarget),
        'Local AI Hub refused to restore config files from outside the snapshot archive.',
      );
      const restoreDestination = assertPathInside(
        toolState.appDir,
        path.join(toolState.appDir, relativeTarget),
        'Local AI Hub refused to restore a config path outside the tool folder.',
      );
      if (!(await fs.pathExists(restoreSource))) {
        continue;
      }

      await fs.remove(restoreDestination);
      await fs.ensureDir(path.dirname(restoreDestination));
      await fs.copy(restoreSource, restoreDestination, { overwrite: true });
    }
  } finally {
    await fs.remove(restoreTemp);
  }
}

module.exports = {
  listSnapshots,
  restoreSnapshot,
  saveSnapshot,
};
