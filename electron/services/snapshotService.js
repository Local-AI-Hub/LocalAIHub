const path = require('path');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const fs = require('fs-extra');
const archiver = require('archiver');
const extract = require('extract-zip');

const { getAppPaths } = require('./configService');
const { assertPathInside, sanitizeManifestId } = require('./pathSafetyService');

const activeTools = new Set();

async function withSnapshotLock(tool, operation) {
  const id = sanitizeManifestId(tool?.id);
  if (activeTools.has(id)) {
    throw new Error('Wait for the current snapshot operation to finish.');
  }
  activeTools.add(id);
  try {
    return await operation();
  } finally {
    activeTools.delete(id);
  }
}

function snapshotTargets(tool) {
  const targets = (tool.configTargets || []).map((name) => ({
    name,
    location: assertPathInside(tool.appDir, path.join(tool.appDir, name), 'A snapshot config path is outside the tool folder.'),
  }));
  if (tool.venvDir) {
    targets.unshift({
      name: '.venv',
      location: assertPathInside(tool.installDir, tool.venvDir, 'The virtual environment is outside the tool folder.'),
    });
  }
  return targets;
}

async function listSnapshots(toolId) {
  const snapshotDir = path.join(getAppPaths().snapshotsRoot, sanitizeManifestId(toolId));
  let files;
  try {
    files = await fs.readdir(snapshotDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return files
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
    .map((file) => ({
      id: file,
      fileName: file,
      fullPath: path.join(snapshotDir, file),
    }));
}

async function saveSnapshot(tool) {
  return withSnapshotLock(tool, async () => {
    const targets = [];
    for (const target of snapshotTargets(tool)) {
      try {
        targets.push({ ...target, stats: await fs.stat(target.location) });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!targets.length) throw new Error('This tool has no virtual environment or configured files to save yet.');

    const directory = path.join(getAppPaths().snapshotsRoot, sanitizeManifestId(tool.id));
    await fs.ensureDir(directory);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${timestamp}-${randomUUID().slice(0, 8)}.zip`;
    const fullPath = path.join(directory, fileName);
    const temporary = `${fullPath}.partial`;
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (error) => archive.destroy(error));
    try {
      for (const target of targets) {
        if (target.stats.isDirectory()) {
          archive.append('', { name: `${target.name}/`, type: 'directory' });
          archive.directory(target.location, target.name);
        } else {
          archive.file(target.location, { name: target.name });
        }
      }
      archive.append(JSON.stringify(tool, null, 2), { name: 'tool-state.json' });
      await Promise.all([
        pipeline(archive, fs.createWriteStream(temporary, { flags: 'wx' })),
        archive.finalize(),
      ]);
      await fs.rename(temporary, fullPath);
      return { fileName, fullPath };
    } finally {
      archive.destroy();
      await fs.remove(temporary);
    }
  });
}

async function restoreSnapshot(tool, fileName) {
  return withSnapshotLock(tool, async () => {
    if (['running', 'starting'].includes(tool.status)) throw new Error('Stop this tool before restoring its snapshot.');
    const directory = path.join(getAppPaths().snapshotsRoot, sanitizeManifestId(tool.id));
    if (!fileName || fileName !== path.basename(fileName) || !fileName.toLowerCase().endsWith('.zip')) {
      throw new Error('Choose a saved snapshot file.');
    }
    const snapshotPath = path.join(directory, fileName);
    if (!(await fs.pathExists(snapshotPath))) throw new Error('Local AI Hub could not find that snapshot file.');
    const temp = await fs.mkdtemp(path.join(directory, '__restore-'));
    const replacements = [];
    try {
      await extract(snapshotPath, { dir: temp });
      for (const { name, location } of snapshotTargets(tool)) {
        const source = assertPathInside(temp, path.join(temp, name));
        if (!(await fs.pathExists(source))) continue;
        const backup = await fs.pathExists(location) ? `${location}.restore-${randomUUID()}` : null;
        if (backup) await fs.rename(location, backup);
        replacements.push({ location, backup });
        await fs.ensureDir(path.dirname(location));
        await fs.move(source, location);
      }
      if (!replacements.length) throw new Error('This snapshot contains no environment or configuration files for this tool.');
    } catch (error) {
      let recoveryPath;
      for (const { location, backup } of replacements.reverse()) {
        try {
          await fs.remove(location);
          if (backup) await fs.rename(backup, location);
        } catch {
          recoveryPath = backup || location;
        }
      }
      if (recoveryPath) throw new Error(`Restore failed and Windows blocked full recovery. Check ${recoveryPath}.`);
      throw error;
    } finally {
      await fs.remove(temp);
    }
    for (const { backup } of replacements) {
      if (backup) await fs.remove(backup);
    }
  });
}

module.exports = { listSnapshots, restoreSnapshot, saveSnapshot };
