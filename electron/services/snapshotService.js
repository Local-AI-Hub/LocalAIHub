const path = require('path');
const fs = require('fs-extra');
const archiver = require('archiver');
const extract = require('extract-zip');

const { getAppPaths } = require('./configService');

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
    throw new Error('NestAI could not find that installed tool.');
  }

  const snapshotDir = path.join(getAppPaths().snapshotsRoot, toolState.id);
  await fs.ensureDir(snapshotDir);
  const snapshotPath = path.join(snapshotDir, createSnapshotFileName());

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
    const absoluteTarget = path.join(toolState.appDir, relativeTarget);
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
  const snapshotPath = path.join(snapshotDir, snapshotFileName);
  if (!(await fs.pathExists(snapshotPath))) {
    throw new Error('NestAI could not find that snapshot file.');
  }

  const restoreTemp = path.join(snapshotDir, '__restore');
  await fs.remove(restoreTemp);
  await fs.ensureDir(restoreTemp);
  await extract(snapshotPath, { dir: restoreTemp });

  if (toolState.venvDir && (await fs.pathExists(path.join(restoreTemp, '.venv')))) {
    await fs.remove(toolState.venvDir);
    await fs.copy(path.join(restoreTemp, '.venv'), toolState.venvDir, { overwrite: true });
  }

  for (const relativeTarget of toolState.configTargets || []) {
    const restoreSource = path.join(restoreTemp, relativeTarget);
    const restoreDestination = path.join(toolState.appDir, relativeTarget);
    if (!(await fs.pathExists(restoreSource))) {
      continue;
    }

    await fs.remove(restoreDestination);
    await fs.ensureDir(path.dirname(restoreDestination));
    await fs.copy(restoreSource, restoreDestination, { overwrite: true });
  }

  await fs.remove(restoreTemp);
}

module.exports = {
  listSnapshots,
  restoreSnapshot,
  saveSnapshot,
};