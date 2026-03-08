const path = require('path');

const { getAppPaths } = require('./configService');

const SAFE_MANIFEST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);
const FORBIDDEN_COMMAND_TOKENS = ['&&', '||', '|', ';', '>', '<', '`', '$('];

function normalizeResolvedPath(value) {
  return path.resolve(String(value || ''));
}

function isPathInside(parentPath, candidatePath) {
  const resolvedParent = normalizeResolvedPath(parentPath);
  const resolvedCandidate = normalizeResolvedPath(candidatePath);
  return (
    resolvedCandidate === resolvedParent ||
    resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`)
  );
}

function assertPathInside(parentPath, candidatePath, message) {
  if (!isPathInside(parentPath, candidatePath)) {
    throw new Error(message || 'Local AI Hub refused to use a path outside its expected folder.');
  }

  return normalizeResolvedPath(candidatePath);
}

function sanitizeManifestId(toolId) {
  const normalized = String(toolId || '').trim().toLowerCase();
  if (!SAFE_MANIFEST_ID_PATTERN.test(normalized)) {
    throw new Error('Local AI Hub refused to use an invalid tool identifier.');
  }

  return normalized;
}

function resolveManagedToolPaths(toolId, venvFolder = '.venv') {
  const { toolsRoot } = getAppPaths();
  const safeToolId = sanitizeManifestId(toolId);
  const installDir = path.join(toolsRoot, safeToolId);
  const safeInstallDir = assertPathInside(
    toolsRoot,
    installDir,
    'Local AI Hub refused to install a tool outside its managed tools folder.',
  );

  return {
    toolsRoot: normalizeResolvedPath(toolsRoot),
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
  assertPathInside,
  assertSafeCommandString,
  assertSecureRemoteUrl,
  isLoopbackUrl,
  isPathInside,
  resolveManagedToolPaths,
  sanitizeManifestId,
};
