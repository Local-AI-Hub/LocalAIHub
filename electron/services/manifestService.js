const path = require('path');
const fs = require('fs-extra');
const { app } = require('electron');

const { ensureStorage } = require('./configService');
const { createLogger } = require('./logService');
const {
  assertSafeCommandString,
  assertSecureRemoteUrl,
  sanitizeManifestId,
} = require('./pathSafetyService');
const {
  computeManifestDigest,
  getDefaultManifestSignaturePath,
  verifyManifestSignature,
} = require('./manifestSignatureService');

const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/Local-AI-Hub/LocalAIHub/main/electron/config/tools-manifest.json';
const REMOTE_MANIFEST_SIGNATURE_URL = `${REMOTE_MANIFEST_URL}.sig`;
const ALLOWED_INSTALL_KINDS = new Set(['zip', 'single-file', 'installer-exe']);
const ALLOWED_RUNTIME_KINDS = new Set(['python', 'binary']);

let loadedManifest = null;
let refreshPromise = null;
let lastManifestStatus = {
  hash: null,
  source: 'bundle',
  verified: false,
  warning: null,
};

function getBundledManifestPath() {
  return path.join(__dirname, '..', 'config', 'tools-manifest.json');
}

function getBundledManifestSignaturePath() {
  return getDefaultManifestSignaturePath(getBundledManifestPath());
}

async function getManifestCachePaths() {
  const { root } = await ensureStorage();
  const manifestPath = path.join(root, 'tools-manifest.cache.json');
  return {
    manifestPath,
    signaturePath: getDefaultManifestSignaturePath(manifestPath),
  };
}

function validateManifestTool(rawTool) {
  if (!rawTool || typeof rawTool !== 'object') {
    throw new Error('Local AI Hub received an invalid tool entry in the manifest.');
  }

  sanitizeManifestId(rawTool.id);

  if (!String(rawTool.name || '').trim()) {
    throw new Error('Local AI Hub received a manifest tool without a name.');
  }

  assertSecureRemoteUrl(rawTool.downloadUrl, `${rawTool.id} download URL`);
  assertSafeCommandString(rawTool.launchCommand, `${rawTool.id} launch command`);

  if (rawTool.externalLaunchCommand) {
    assertSafeCommandString(rawTool.externalLaunchCommand, `${rawTool.id} external launch command`);
  }

  if (
    rawTool.defaultPort !== undefined &&
    (!Number.isInteger(rawTool.defaultPort) || rawTool.defaultPort < 1 || rawTool.defaultPort > 65535)
  ) {
    throw new Error(`Local AI Hub received an invalid port for ${rawTool.id}.`);
  }

  const installInstructions = rawTool.installInstructions || {};
  if (!ALLOWED_INSTALL_KINDS.has(installInstructions.kind)) {
    throw new Error(`Local AI Hub rejected ${rawTool.id} because it uses an unsupported install method.`);
  }

  if (!ALLOWED_RUNTIME_KINDS.has(installInstructions.runtime)) {
    throw new Error(`Local AI Hub rejected ${rawTool.id} because it uses an unsupported runtime type.`);
  }

  for (const candidate of rawTool.detectionPaths || []) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error(`Local AI Hub rejected ${rawTool.id} because one of its detection paths was invalid.`);
    }
  }

  for (const arg of installInstructions.installerArgs || []) {
    if (typeof arg !== 'string' || /[\r\n]/.test(arg)) {
      throw new Error(`Local AI Hub rejected ${rawTool.id} because one of its installer arguments was invalid.`);
    }
  }

  return rawTool;
}

function normalizeManifest(rawManifest) {
  if (!Array.isArray(rawManifest)) {
    throw new Error('Local AI Hub received an invalid tool manifest payload.');
  }

  return rawManifest.map((tool) => validateManifestTool(tool));
}

async function readTextFile(filePath) {
  if (!(await fs.pathExists(filePath))) {
    return '';
  }

  return fs.readFile(filePath, 'utf8');
}

function verifySignedManifest(rawManifestText, rawSignatureText) {
  if (!String(rawSignatureText || '').trim()) {
    throw new Error('Local AI Hub could not verify the tool catalog because its detached signature file is missing.');
  }

  if (!verifyManifestSignature(rawManifestText, rawSignatureText)) {
    throw new Error('Local AI Hub rejected the tool catalog because its digital signature could not be verified.');
  }

  return computeManifestDigest(rawManifestText);
}

async function readManifestFile(manifestPath, signaturePath) {
  const rawManifestText = await readTextFile(manifestPath);
  if (!rawManifestText.trim()) {
    return {
      hash: null,
      manifest: [],
    };
  }

  const rawSignatureText = await readTextFile(signaturePath);
  const hash = verifySignedManifest(rawManifestText, rawSignatureText);
  return {
    hash,
    manifest: normalizeManifest(JSON.parse(rawManifestText)),
  };
}

async function readCachedManifest() {
  try {
    const cachePaths = await getManifestCachePaths();
    return await readManifestFile(cachePaths.manifestPath, cachePaths.signaturePath);
  } catch {
    return {
      hash: null,
      manifest: [],
    };
  }
}

async function writeCachedManifest(rawManifestText, rawSignatureText) {
  const cachePaths = await getManifestCachePaths();
  await fs.writeFile(cachePaths.manifestPath, rawManifestText, 'utf8');
  await fs.writeFile(cachePaths.signaturePath, rawSignatureText, 'utf8');
  return cachePaths;
}

async function fetchText(url, label) {
  const response = await fetch(assertSecureRemoteUrl(url, label), {
    headers: {
      'Cache-Control': 'no-cache',
      'User-Agent': `LocalAIHub/${app.getVersion()}`,
    },
  });

  if (!response.ok) {
    throw new Error(`${label} request returned ${response.status}.`);
  }

  return response.text();
}

async function fetchRemoteManifest(logger) {
  const [rawManifestText, rawSignatureText] = await Promise.all([
    fetchText(REMOTE_MANIFEST_URL, 'remote manifest URL'),
    fetchText(REMOTE_MANIFEST_SIGNATURE_URL, 'remote manifest signature URL'),
  ]);
  const hash = verifySignedManifest(rawManifestText, rawSignatureText);
  const manifest = normalizeManifest(JSON.parse(rawManifestText));
  const cachePaths = await writeCachedManifest(rawManifestText, rawSignatureText);

  lastManifestStatus = {
    hash,
    source: 'remote',
    verified: true,
    warning: null,
  };

  await logger.info('Remote tool manifest refreshed successfully.', {
    cacheManifestPath: cachePaths.manifestPath,
    cacheSignaturePath: cachePaths.signaturePath,
    entryCount: manifest.length,
    manifestHash: hash,
    manifestUrl: REMOTE_MANIFEST_URL,
    signatureUrl: REMOTE_MANIFEST_SIGNATURE_URL,
  });

  return manifest;
}

async function ensureManifestSeed(logger) {
  if (loadedManifest) {
    return loadedManifest;
  }

  const cachedManifest = await readCachedManifest();
  if (cachedManifest.manifest.length) {
    loadedManifest = cachedManifest.manifest;
    lastManifestStatus = {
      hash: cachedManifest.hash,
      source: 'cache',
      verified: true,
      warning: null,
    };
    return loadedManifest;
  }

  try {
    const bundledManifest = await readManifestFile(
      getBundledManifestPath(),
      getBundledManifestSignaturePath(),
    );
    loadedManifest = bundledManifest.manifest;
    lastManifestStatus = {
      hash: bundledManifest.hash,
      source: 'bundle',
      verified: true,
      warning: null,
    };
    return loadedManifest;
  } catch (error) {
    await logger.warn('The bundled tool manifest could not be loaded or verified.', {
      error,
    });
  }

  loadedManifest = [];
  lastManifestStatus = {
    hash: null,
    source: 'none',
    verified: false,
    warning: 'Local AI Hub could not load a trusted tool catalog.',
  };
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
      lastManifestStatus = {
        ...lastManifestStatus,
        verified: false,
        warning:
          'Local AI Hub could not verify the latest remote tool catalog signature, so it is using the last trusted local catalog instead.',
      };
      await logger.warn('Remote tool manifest refresh failed signature verification. Using a trusted local catalog instead.', {
        error,
        hasSeededManifest: seededManifest.length > 0,
        manifestUrl: REMOTE_MANIFEST_URL,
        signatureUrl: REMOTE_MANIFEST_SIGNATURE_URL,
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

function getManifestStatus() {
  return {
    ...lastManifestStatus,
  };
}

function getRemoteManifestUrl() {
  return REMOTE_MANIFEST_URL;
}

module.exports = {
  getLoadedToolManifest,
  getManifestStatus,
  getRemoteManifestUrl,
  loadToolManifest,
};
