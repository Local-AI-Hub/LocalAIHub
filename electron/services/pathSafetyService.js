const fs = require('fs-extra');
const path = require('path');

const { getAppPaths, normalizePathList } = require('./configService');

const SAFE_MANIFEST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);
const FORBIDDEN_COMMAND_TOKENS = ['&&', '||', '|', ';', '>', '<', '`', '$('];

function normalizeResolvedPath(value) {
  return path.resolve(String(value || ''));
}

function normalizePathComparisonKey(value) {
  const resolved = normalizeResolvedPath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(parentPath, candidatePath) {
  const resolvedParent = normalizeResolvedPath(parentPath);
  const resolvedCandidate = normalizeResolvedPath(candidatePath);
  const parentKey = normalizePathComparisonKey(resolvedParent);
  const candidateKey = normalizePathComparisonKey(resolvedCandidate);
  return (
    candidateKey === parentKey ||
    candidateKey.startsWith(`${parentKey}${path.sep}`)
  );
}

function assertPathInside(parentPath, candidatePath, message) {
  if (!isPathInside(parentPath, candidatePath)) {
    throw new Error(message || 'Local AI Hub refused to use a path outside its expected folder.');
  }

  return normalizeResolvedPath(candidatePath);
}

function isReparsePointStats(stats) {
  return Boolean(stats && (
    (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) ||
    (typeof stats.isReparsePoint === 'function' && stats.isReparsePoint())
  ));
}

async function pathExists(targetPath) {
  return fs.pathExists(targetPath).catch(() => false);
}

async function findNearestExistingPath(parentPath, candidatePath) {
  let currentPath = normalizeResolvedPath(candidatePath);
  const resolvedParent = normalizeResolvedPath(parentPath);
  while (isPathInside(resolvedParent, currentPath)) {
    if (await pathExists(currentPath)) {
      return currentPath;
    }
    const nextPath = path.dirname(currentPath);
    if (nextPath === currentPath) {
      break;
    }
    currentPath = nextPath;
  }
  return (await pathExists(resolvedParent)) ? resolvedParent : null;
}

async function assertNoReparsePointTraversal(parentPath, candidatePath, message) {
  const resolvedParent = normalizeResolvedPath(parentPath);
  const resolvedCandidate = normalizeResolvedPath(candidatePath);
  if (!isPathInside(resolvedParent, resolvedCandidate)) {
    throw new Error(message || 'Local AI Hub refused to use a path outside its expected folder.');
  }

  const relativePath = path.relative(resolvedParent, resolvedCandidate);
  if (!relativePath || relativePath === '') {
    return resolvedCandidate;
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  let currentPath = resolvedParent;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stats = await fs.lstat(currentPath).catch(() => null);
    if (!stats) {
      break;
    }
    if (isReparsePointStats(stats)) {
      throw new Error(message || 'Local AI Hub refused to use that model path because it crosses a symlink or junction. Choose a normal folder inside the managed model directory.');
    }
  }

  return resolvedCandidate;
}

async function assertRealPathInside(parentPath, candidatePath, message, options = {}) {
  const resolvedParent = assertPathInside(parentPath, parentPath, message);
  const resolvedCandidate = assertPathInside(resolvedParent, candidatePath, message);
  const nearestExistingPath = await findNearestExistingPath(resolvedParent, resolvedCandidate);
  if (!nearestExistingPath) {
    throw new Error(message || 'Local AI Hub could not verify that folder before using it.');
  }

  if (options.rejectReparse !== false) {
    await assertNoReparsePointTraversal(resolvedParent, nearestExistingPath, message);
  }

  const realParent = await fs.realpath(resolvedParent).catch(() => null);
  const realExisting = await fs.realpath(nearestExistingPath).catch(() => null);
  if (!realParent || !realExisting || !isPathInside(realParent, realExisting)) {
    throw new Error(message || 'Local AI Hub refused to use a path outside its expected folder.');
  }

  return resolvedCandidate;
}

function sanitizeManifestId(toolId) {
  const normalized = String(toolId || '').trim().toLowerCase();
  if (!SAFE_MANIFEST_ID_PATTERN.test(normalized)) {
    throw new Error('Local AI Hub refused to use an invalid tool identifier.');
  }

  return normalized;
}

function getManagedToolsRoots() {
  const appPaths = getAppPaths();
  return normalizePathList([
    appPaths.toolsRoot,
    ...(appPaths.knownManagedRoots || []).map((rootPath) => path.join(rootPath, 'tools')),
  ]).map((entry) => normalizeResolvedPath(entry));
}

function findManagedToolsRootForPath(candidatePath) {
  const normalizedCandidatePath = normalizeResolvedPath(candidatePath);
  return getManagedToolsRoots().find((toolsRoot) => isPathInside(toolsRoot, normalizedCandidatePath)) || null;
}

function resolveManagedToolPaths(toolId, venvFolder = '.venv', options = {}) {
  const baseManagedRoot = options.managedRoot ? normalizeResolvedPath(options.managedRoot) : getAppPaths().managedRoot;
  const toolsRoot = normalizeResolvedPath(path.join(baseManagedRoot, 'tools'));
  const safeToolId = sanitizeManifestId(toolId);
  const installDir = path.join(toolsRoot, safeToolId);
  const safeInstallDir = assertPathInside(
    toolsRoot,
    installDir,
    'Local AI Hub refused to install a tool outside its managed tools folder.',
  );

  return {
    toolsRoot,
    installDir: safeInstallDir,
    appDir: path.join(safeInstallDir, 'app'),
    venvDir: path.join(safeInstallDir, venvFolder || '.venv'),
  };
}

function isLoopbackUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function assertLoopbackUrl(value, label = 'tool URL') {
  if (!value || !isLoopbackUrl(value)) {
    throw new Error(`Local AI Hub refused to use a non-local ${label}.`);
  }

  return value;
}

function assertSecureRemoteUrl(value, label = 'download URL') {
  let parsed = null;

  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error(`Local AI Hub could not read the ${label}.`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Local AI Hub refused to use a non-HTTPS ${label}.`);
  }

  return parsed.toString();
}

function assertSafeCommandString(value, label = 'command') {
  const command = String(value || '').trim();
  if (!command) {
    throw new Error(`Local AI Hub could not read the ${label}.`);
  }

  if (/[\r\n]/.test(command)) {
    throw new Error(`Local AI Hub refused to use a multi-line ${label}.`);
  }

  if (FORBIDDEN_COMMAND_TOKENS.some((token) => command.includes(token))) {
    throw new Error(`Local AI Hub refused to use an unsafe ${label}.`);
  }

  return command;
}

module.exports = {
  assertLoopbackUrl,
  assertNoReparsePointTraversal,
  assertPathInside,
  assertRealPathInside,
  assertSafeCommandString,
  assertSecureRemoteUrl,
  findManagedToolsRootForPath,
  getManagedToolsRoots,
  isLoopbackUrl,
  isPathInside,
  normalizePathComparisonKey,
  resolveManagedToolPaths,
  sanitizeManifestId,
};
