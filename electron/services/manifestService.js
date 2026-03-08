const path = require('path');
const fs = require('fs-extra');
const { app } = require('electron');

const { ensureStorage } = require('./configService');
const { createLogger } = require('./logService');

const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/Local-AI-Hub/NestAI/main/electron/config/tools-manifest.json';

let loadedManifest = null;
let refreshPromise = null;

function getDevManifestPath() {
  return path.join(__dirname, '..', 'config', 'tools-manifest.json');
}

async function getManifestCachePath() {
  const { root } = await ensureStorage();
  return path.join(root, 'tools-manifest.cache.json');
}

function normalizeManifest(rawManifest) {
  if (!Array.isArray(rawManifest)) {
    throw new Error('NestAI received an invalid tool manifest payload.');
  }

  return rawManifest;
}

async function readManifestFile(filePath) {
  if (!(await fs.pathExists(filePath))) {
    return [];
  }

  const rawManifest = await fs.readJson(filePath);
  return normalizeManifest(rawManifest);
}

async function readCachedManifest() {
  try {
    return await readManifestFile(await getManifestCachePath());
  } catch {
    return [];
  }
}

async function writeCachedManifest(rawManifest) {
  const cachePath = await getManifestCachePath();
  await fs.writeJson(cachePath, rawManifest, { spaces: 2 });
  return cachePath;
}

async function fetchRemoteManifest(logger) {
  const response = await fetch(REMOTE_MANIFEST_URL, {
    headers: {
      'Cache-Control': 'no-cache',
      'User-Agent': `NestAI/${app.getVersion()}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Remote manifest request returned ${response.status}.`);
  }

  const rawManifest = normalizeManifest(await response.json());
  const cachePath = await writeCachedManifest(rawManifest);
  await logger.info('Remote tool manifest refreshed successfully.', {
    manifestUrl: REMOTE_MANIFEST_URL,
    cachePath,
    entryCount: rawManifest.length,
  });

  return rawManifest;
}

async function ensureManifestSeed(logger) {
  if (loadedManifest) {
    return loadedManifest;
  }

  const cachedManifest = await readCachedManifest();
  if (cachedManifest.length) {
    loadedManifest = cachedManifest;
    return loadedManifest;
  }

  if (!app.isPackaged) {
    try {
      loadedManifest = await readManifestFile(getDevManifestPath());
      return loadedManifest;
    } catch (error) {
      await logger.warn('Local development tool manifest could not be loaded.', {
        error,
      });
    }
  }

  loadedManifest = [];
  return loadedManifest;
}

async function loadToolManifest(options = {}) {
  const logger = createLogger('manifest');

  if (!options.refreshRemote && loadedManifest) {
    return loadedManifest;
  }

  const seededManifest = await ensureManifestSeed(logger);
  if (!options.refreshRemote) {
    return seededManifest;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      loadedManifest = await fetchRemoteManifest(logger);
      return loadedManifest;
    } catch (error) {
      await logger.warn('Remote tool manifest refresh failed. Using the last local manifest instead.', {
        error,
        hasCachedManifest: seededManifest.length > 0,
        manifestUrl: REMOTE_MANIFEST_URL,
      });
      return seededManifest;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function getLoadedToolManifest() {
  return Array.isArray(loadedManifest) ? loadedManifest : [];
}

function getRemoteManifestUrl() {
  return REMOTE_MANIFEST_URL;
}

module.exports = {
  getLoadedToolManifest,
  getRemoteManifestUrl,
  loadToolManifest,
};
