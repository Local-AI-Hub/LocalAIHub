const path = require('path');
const fs = require('fs-extra');
const { version: APP_VERSION } = require('../../package.json');

const { ensureStorage } = require('./configService');
const { compareVersions, runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const { getToolManifest, initializeToolRegistry } = require('./toolRegistry');

const TOOL_UPDATES_FILE = 'tool-updates.json';
const TOOL_UPDATES_VERSION = 1;
const REQUEST_TIMEOUT_MS = 12000;
const VERSION_PATTERN = /v?(\d+(?:\.\d+){1,3})/i;

let refreshPromise = null;

function createDefaultToolUpdates() {
  return {
    version: TOOL_UPDATES_VERSION,
    lastCheckedAt: null,
    tools: {},
  };
}

async function getToolUpdatesPath() {
  const { root } = await ensureStorage();
  return path.join(root, TOOL_UPDATES_FILE);
}

async function readToolUpdates() {
  const filePath = await getToolUpdatesPath();
  if (!(await fs.pathExists(filePath))) {
    return createDefaultToolUpdates();
  }

  try {
    const payload = await fs.readJson(filePath);
    return {
      ...createDefaultToolUpdates(),
      ...(payload || {}),
      tools: payload?.tools && typeof payload.tools === 'object' ? payload.tools : {},
    };
  } catch {
    return createDefaultToolUpdates();
  }
}

async function writeToolUpdates(payload) {
  const filePath = await getToolUpdatesPath();
  const nextPayload = {
    ...createDefaultToolUpdates(),
    ...(payload || {}),
    tools: payload?.tools && typeof payload.tools === 'object' ? payload.tools : {},
  };
  await fs.writeJson(filePath, nextPayload, { spaces: 2 });
  return nextPayload;
}

function extractVersionSegments(versionText) {
  const match = String(versionText || '').match(VERSION_PATTERN);
  if (!match?.[1]) {
    return [];
  }

  return match[1].split('.').map((entry) => Number.parseInt(entry, 10)).filter(Number.isFinite);
}

function normalizeVersion(versionText) {
  const match = String(versionText || '').match(VERSION_PATTERN);
  return match?.[1] || '';
}

function compareVersionStrings(left, right) {
  const leftSegments = extractVersionSegments(left);
  const rightSegments = extractVersionSegments(right);
  if (!leftSegments.length || !rightSegments.length) {
    return 0;
  }

  return compareVersions(leftSegments, rightSegments);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': `LocalAIHub/${APP_VERSION}`,
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function resolveFinalUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': `LocalAIHub/${APP_VERSION}`,
      },
      redirect: 'follow',
      signal: controller.signal,
    }).catch(() => null);

    if (response?.ok) {
      return response.url || url;
    }

    const fallbackResponse = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': `LocalAIHub/${APP_VERSION}`,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    return fallbackResponse.url || url;
  } finally {
    clearTimeout(timer);
  }
}

function deriveGitHubRepo(downloadUrl) {
  try {
    const parsed = new URL(downloadUrl);
    if (!/github\.com$/i.test(parsed.hostname)) {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    return {
      owner: parts[0],
      repo: parts[1],
    };
  } catch {
    return null;
  }
}

function derivePipPackageName(manifest) {
  const packageInstruction = (manifest?.installInstructions?.pipInstalls || []).find((entry) => entry.kind === 'package');
  return String(packageInstruction?.value || '').trim();
}

async function readPackageJsonVersion(targetPath) {
  if (!(await fs.pathExists(targetPath))) {
    return '';
  }

  const payload = await fs.readJson(targetPath).catch(() => null);
  return normalizeVersion(payload?.version || '');
}

async function readPyprojectVersion(targetPath) {
  if (!(await fs.pathExists(targetPath))) {
    return '';
  }

  const rawText = await fs.readFile(targetPath, 'utf8').catch(() => '');
  const match = rawText.match(/^version\s*=\s*["']([^"']+)["']/m);
  return normalizeVersion(match?.[1] || '');
}

async function readInitVersion(targetPath) {
  if (!(await fs.pathExists(targetPath))) {
    return '';
  }

  const rawText = await fs.readFile(targetPath, 'utf8').catch(() => '');
  const match = rawText.match(/__version__\s*=\s*["']([^"']+)["']/m);
  return normalizeVersion(match?.[1] || '');
}

async function readExecutableVersion(targetPath) {
  if (!targetPath || !(await fs.pathExists(targetPath))) {
    return '';
  }

  const escapedPath = String(targetPath).replace(/'/g, "''");
  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${escapedPath}').VersionInfo.ProductVersion`], {
    allowFailure: true,
  }).catch(() => null);

  return normalizeVersion(result?.stdout || '');
}

async function readPipShowVersion(pythonPath, packageName) {
  if (!pythonPath || !packageName || !(await fs.pathExists(pythonPath))) {
    return '';
  }

  const result = await runCommand(pythonPath, ['-m', 'pip', 'show', packageName], {
    allowFailure: true,
  }).catch(() => null);

  const versionLine = String(result?.stdout || '')
    .split(/\r?\n/)
    .find((line) => /^Version:/i.test(line));
  return normalizeVersion(versionLine || '');
}

function parseVersionFromPath(targetPath) {
  return normalizeVersion(path.basename(String(targetPath || '')));
}

async function detectInstalledVersion(tool, manifest) {
  const pythonPath = tool?.venvDir ? path.join(tool.venvDir, 'Scripts', 'python.exe') : '';
  const pipPackageName = derivePipPackageName(manifest);

  const candidateReaders = [
    () => readPipShowVersion(pythonPath, pipPackageName),
    () => readExecutableVersion(tool?.launchProfile?.executable || tool?.executablePath || ''),
    () => readExecutableVersion(tool?.installDir ? path.join(tool.installDir, path.basename(tool.launchProfile?.executable || tool.executablePath || '')) : ''),
    () => readPackageJsonVersion(path.join(tool?.appDir || tool?.installDir || '', 'package.json')),
    () => readPyprojectVersion(path.join(tool?.appDir || tool?.installDir || '', 'pyproject.toml')),
    () => readInitVersion(path.join(tool?.appDir || tool?.installDir || '', String(tool?.id || '').replace(/-/g, '_'), '__init__.py')),
    () => Promise.resolve(parseVersionFromPath(tool?.downloadCachePath || '')),
    () => Promise.resolve(parseVersionFromPath(tool?.launchProfile?.executable || tool?.executablePath || '')),
  ];

  for (const reader of candidateReaders) {
    const version = normalizeVersion(await reader());
    if (version) {
      return version;
    }
  }

  return '';
}

async function detectRemoteVersion(manifest) {
  const pipPackageName = derivePipPackageName(manifest);
  if (pipPackageName) {
    const payload = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(pipPackageName)}/json`);
    const version = normalizeVersion(payload?.info?.version || '');
    return {
      availableVersion: version,
      releaseUrl: `https://pypi.org/project/${pipPackageName}/`,
      sourceLabel: 'PyPI',
    };
  }

  const githubRepo = deriveGitHubRepo(manifest.downloadUrl);
  if (githubRepo) {
    try {
      const releasePayload = await fetchJson(`https://api.github.com/repos/${githubRepo.owner}/${githubRepo.repo}/releases/latest`, {
        headers: {
          Accept: 'application/vnd.github+json',
        },
      });
      return {
        availableVersion: normalizeVersion(releasePayload?.tag_name || releasePayload?.name || ''),
        releaseUrl: releasePayload?.html_url || `https://github.com/${githubRepo.owner}/${githubRepo.repo}/releases`,
        sourceLabel: 'GitHub release',
      };
    } catch {
      const tagsPayload = await fetchJson(`https://api.github.com/repos/${githubRepo.owner}/${githubRepo.repo}/tags?per_page=1`, {
        headers: {
          Accept: 'application/vnd.github+json',
        },
      }).catch(() => []);
      const firstTag = Array.isArray(tagsPayload) ? tagsPayload[0] : null;
      return {
        availableVersion: normalizeVersion(firstTag?.name || ''),
        releaseUrl: `https://github.com/${githubRepo.owner}/${githubRepo.repo}/tags`,
        sourceLabel: 'GitHub tag',
      };
    }
  }

  const finalUrl = await resolveFinalUrl(manifest.downloadUrl).catch(() => manifest.downloadUrl);
  return {
    availableVersion: normalizeVersion(finalUrl),
    releaseUrl: finalUrl,
    sourceLabel: 'Official download',
  };
}

async function refreshInstalledToolUpdates(tools = []) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    await initializeToolRegistry();
    const logger = createLogger('tool-updates');
    const currentCache = await readToolUpdates();
    const nextTools = {
      ...currentCache.tools,
    };

    for (const tool of tools || []) {
      const manifest = getToolManifest(tool.id);
      if (!manifest) {
        continue;
      }

      try {
        const [currentVersion, remoteVersion] = await Promise.all([
          detectInstalledVersion(tool, manifest),
          detectRemoteVersion(manifest),
        ]);
        const comparison = currentVersion && remoteVersion.availableVersion
          ? compareVersionStrings(currentVersion, remoteVersion.availableVersion)
          : 0;

        nextTools[tool.id] = {
          availableVersion: remoteVersion.availableVersion || '',
          checkedAt: new Date().toISOString(),
          currentVersion: currentVersion || '',
          releaseUrl: remoteVersion.releaseUrl || '',
          sourceLabel: remoteVersion.sourceLabel || '',
          status:
            currentVersion && remoteVersion.availableVersion
              ? comparison < 0
                ? 'available'
                : 'current'
              : remoteVersion.availableVersion
                ? 'unverified'
                : 'unknown',
          updateAvailable: Boolean(currentVersion && remoteVersion.availableVersion && comparison < 0),
        };
      } catch (error) {
        nextTools[tool.id] = {
          ...(nextTools[tool.id] || {}),
          checkedAt: new Date().toISOString(),
          status: 'unknown',
          updateAvailable: false,
        };
        await logger.warn('Tool update check failed silently.', {
          toolId: tool.id,
          message: error.message,
        });
      }
    }

    const nextCache = await writeToolUpdates({
      ...currentCache,
      lastCheckedAt: new Date().toISOString(),
      tools: nextTools,
    });

    return nextCache;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function getToolUpdateSnapshot(tools = []) {
  const cache = await readToolUpdates();
  const entries = (tools || []).map((tool) => ({
    availableVersion: cache.tools?.[tool.id]?.availableVersion || '',
    checkedAt: cache.tools?.[tool.id]?.checkedAt || null,
    currentVersion: cache.tools?.[tool.id]?.currentVersion || '',
    releaseUrl: cache.tools?.[tool.id]?.releaseUrl || '',
    sourceLabel: cache.tools?.[tool.id]?.sourceLabel || '',
    status: cache.tools?.[tool.id]?.status || 'unknown',
    toolId: tool.id,
    toolName: tool.name,
    updateAvailable: Boolean(cache.tools?.[tool.id]?.updateAvailable),
  }));

  return {
    availableCount: entries.filter((entry) => entry.updateAvailable).length,
    entries,
    lastCheckedAt: cache.lastCheckedAt,
  };
}

module.exports = {
  getToolUpdateSnapshot,
  refreshInstalledToolUpdates,
};
