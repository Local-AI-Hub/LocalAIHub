const { version: PACKAGE_VERSION } = require('../../package.json');

const { readConfig, updateConfig } = require('./configService');
const { createLogger } = require('./logService');

const GITHUB_OWNER = 'Local-AI-Hub';
const GITHUB_REPO = 'LocalAIHub';
const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`;
const REQUEST_TIMEOUT_MS = 10000;
const LAUNCH_CHECK_DELAY_MS = 12000;
const INSTALLER_NAME_PATTERN = /^LocalAIHub-Setup-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.exe$/i;

class UpdateCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseSemanticVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i);
  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split('.') : [],
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`,
  };
}

function comparePrerelease(leftParts, rightParts) {
  if (!leftParts.length && !rightParts.length) return 0;
  if (!leftParts.length) return 1;
  if (!rightParts.length) return -1;

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = leftParts[index];
    const right = rightParts[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      return Number(left) < Number(right) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return left.localeCompare(right, undefined, { sensitivity: 'base' }) < 0 ? -1 : 1;
  }

  return 0;
}

function compareSemanticVersions(leftValue, rightValue) {
  const left = parseSemanticVersion(leftValue);
  const right = parseSemanticVersion(rightValue);
  if (!left || !right) {
    return null;
  }

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

function isNewerVersion(currentVersion, latestVersion) {
  return compareSemanticVersions(currentVersion, latestVersion) === -1;
}

function isTrustedGitHubReleaseUrl(value) {
  try {
    const url = new URL(value);
    const expectedPrefix = `/${GITHUB_OWNER}/${GITHUB_REPO}/releases/`.toLowerCase();
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'github.com'
      && url.pathname.toLowerCase().startsWith(expectedPrefix);
  } catch {
    return false;
  }
}

function normalizeTrustedUrl(value) {
  return isTrustedGitHubReleaseUrl(value) ? String(value) : '';
}

function selectLatestStableRelease(releases) {
  if (!Array.isArray(releases)) {
    throw new UpdateCheckError('malformed', 'GitHub returned release information Local AI Hub could not read.');
  }

  const candidates = releases
    .filter((release) => release && release.draft !== true && release.prerelease !== true)
    .map((release) => ({
      release,
      parsedVersion: parseSemanticVersion(release.tag_name || release.name),
    }))
    .filter((entry) => entry.parsedVersion && entry.parsedVersion.prerelease.length === 0);

  if (!candidates.length) {
    throw new UpdateCheckError('malformed', 'GitHub did not return a stable Local AI Hub release.');
  }

  candidates.sort((left, right) => compareSemanticVersions(right.parsedVersion.version, left.parsedVersion.version));
  return candidates[0].release;
}

function parseReleaseMetadata(releases) {
  const release = selectLatestStableRelease(releases);
  const parsedVersion = parseSemanticVersion(release.tag_name || release.name);
  const releaseUrl = normalizeTrustedUrl(release.html_url);
  if (!parsedVersion || !releaseUrl) {
    throw new UpdateCheckError('malformed', 'GitHub returned release information Local AI Hub could not verify.');
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installerAsset = assets.find((asset) => {
    const installerMatch = String(asset?.name || '').match(INSTALLER_NAME_PATTERN);
    return installerMatch
      && parseSemanticVersion(installerMatch[1])?.version === parsedVersion.version
      && normalizeTrustedUrl(asset?.browser_download_url);
  });
  const blockmapAsset = assets.find((asset) =>
    String(asset?.name || '').toLowerCase() === `localaihub-setup-${parsedVersion.version}.exe.blockmap`.toLowerCase()
      && normalizeTrustedUrl(asset?.browser_download_url),
  );
  const latestYmlAsset = assets.find((asset) =>
    String(asset?.name || '').toLowerCase() === 'latest.yml'
      && normalizeTrustedUrl(asset?.browser_download_url),
  );

  return {
    blockmapAvailable: Boolean(blockmapAsset),
    installerName: installerAsset?.name || '',
    installerUrl: normalizeTrustedUrl(installerAsset?.browser_download_url),
    latestYmlAvailable: Boolean(latestYmlAsset),
    latestVersion: parsedVersion.version,
    releaseName: String(release.name || release.tag_name || `v${parsedVersion.version}`),
    releaseUrl,
  };
}

function getFailureMessage(code) {
  if (code === 'rate-limit') {
    return 'GitHub is temporarily limiting update checks. Try again later.';
  }
  if (code === 'malformed') {
    return 'GitHub returned release information Local AI Hub could not read. Try again later.';
  }
  return 'Could not check for updates. Check your connection or try again later.';
}

function buildSnapshot(config, currentVersion, overrides = {}) {
  const latestVersion = parseSemanticVersion(config?.lastSeenLatestVersion)?.version || '';
  const releaseUrl = normalizeTrustedUrl(config?.lastSeenReleaseUrl);
  const installerUrl = normalizeTrustedUrl(config?.lastSeenInstallerUrl);
  const updateAvailable = Boolean(latestVersion && isNewerVersion(currentVersion, latestVersion));
  let status = 'unknown';
  let message = 'Check GitHub Releases to see whether a newer version is available.';

  if (latestVersion) {
    if (updateAvailable && installerUrl) {
      status = 'available';
      message = `Update available: v${latestVersion}`;
    } else if (updateAvailable) {
      status = 'no-installer';
      message = 'Latest release found, but no Windows installer asset was attached.';
    } else {
      status = 'current';
      message = 'You are up to date.';
    }
  }

  return {
    blockmapAvailable: Boolean(config?.lastSeenBlockmapAvailable),
    checkedAt: config?.lastSuccessfulUpdateCheckAt || null,
    currentVersion: parseSemanticVersion(currentVersion)?.version || String(currentVersion || ''),
    errorCode: '',
    installerName: installerUrl ? String(config?.lastSeenInstallerName || '') : '',
    installerUrlAvailable: Boolean(installerUrl),
    latestVersion,
    latestYmlAvailable: Boolean(config?.lastSeenLatestYmlAvailable),
    message,
    releaseName: releaseUrl ? String(config?.lastSeenReleaseName || '') : '',
    releaseUrlAvailable: Boolean(releaseUrl),
    status,
    updateAvailable,
    ...overrides,
  };
}

function classifyFetchError(error) {
  if (error instanceof UpdateCheckError) {
    return error;
  }
  return new UpdateCheckError('network', getFailureMessage('network'));
}

function createUpdateService(dependencies = {}) {
  const appVersion = dependencies.appVersion || PACKAGE_VERSION;
  const fetchImpl = dependencies.fetchImpl || global.fetch;
  const readConfigImpl = dependencies.readConfigImpl || readConfig;
  const updateConfigImpl = dependencies.updateConfigImpl || updateConfig;
  const openExternalImpl = dependencies.openExternalImpl || null;
  const setTimeoutImpl = dependencies.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl || clearTimeout;
  const logger = dependencies.logger || createLogger('updates');
  let activeController = null;
  let activeSequence = 0;
  let launchTimer = null;

  async function getSnapshot() {
    return buildSnapshot(await readConfigImpl(), appVersion);
  }

  async function fetchReleases(signal) {
    if (typeof fetchImpl !== 'function') {
      throw new UpdateCheckError('network', getFailureMessage('network'));
    }

    const timeoutController = new AbortController();
    const timeout = setTimeoutImpl(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
    const abort = () => timeoutController.abort();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await fetchImpl(GITHUB_RELEASES_API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `LocalAIHub/${appVersion}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: timeoutController.signal,
      });

      if (response?.status === 403 && response.headers?.get?.('x-ratelimit-remaining') === '0') {
        throw new UpdateCheckError('rate-limit', getFailureMessage('rate-limit'));
      }
      if (!response?.ok) {
        throw new UpdateCheckError('network', getFailureMessage('network'));
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new UpdateCheckError('malformed', getFailureMessage('malformed'));
      }
      return payload;
    } catch (error) {
      if (signal?.aborted) {
        throw new UpdateCheckError('cancelled', 'Update check stopped.');
      }
      throw classifyFetchError(error);
    } finally {
      clearTimeoutImpl(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function checkForUpdates() {
    activeController?.abort();
    const controller = new AbortController();
    const sequence = ++activeSequence;
    activeController = controller;
    const previousConfig = await readConfigImpl();

    try {
      const metadata = parseReleaseMetadata(await fetchReleases(controller.signal));
      if (sequence !== activeSequence) {
        return buildSnapshot(previousConfig, appVersion, { status: 'cancelled', message: 'Update check stopped.' });
      }

      const checkedAt = new Date().toISOString();
      const nextConfig = await updateConfigImpl((config) => ({
        ...config,
        lastSeenBlockmapAvailable: metadata.blockmapAvailable,
        lastSeenInstallerName: metadata.installerName,
        lastSeenInstallerUrl: metadata.installerUrl,
        lastSeenLatestVersion: metadata.latestVersion,
        lastSeenLatestYmlAvailable: metadata.latestYmlAvailable,
        lastSeenReleaseName: metadata.releaseName,
        lastSeenReleaseUrl: metadata.releaseUrl,
        lastSuccessfulUpdateCheckAt: checkedAt,
      }));
      return buildSnapshot(nextConfig, appVersion);
    } catch (error) {
      const classified = classifyFetchError(error);
      const cached = buildSnapshot(previousConfig, appVersion);
      if (classified.code === 'cancelled') {
        return { ...cached, errorCode: 'cancelled', status: 'cancelled', message: classified.message };
      }

      await logger.warn('App update check did not complete.', { code: classified.code, message: classified.message });
      return {
        ...cached,
        errorCode: classified.code,
        message: getFailureMessage(classified.code),
        status: 'error',
      };
    } finally {
      if (sequence === activeSequence) {
        activeController = null;
      }
    }
  }

  function cancelUpdateCheck() {
    activeSequence += 1;
    activeController?.abort();
    activeController = null;
  }

  async function saveCheckOnLaunch(enabled) {
    const config = await updateConfigImpl((current) => ({
      ...current,
      checkForUpdatesOnLaunch: Boolean(enabled),
    }));
    return {
      checkForUpdatesOnLaunch: Boolean(config.checkForUpdatesOnLaunch),
      message: config.checkForUpdatesOnLaunch
        ? 'Local AI Hub will check GitHub Releases after startup.'
        : 'Automatic launch checks are off. You can still check manually.',
      update: buildSnapshot(config, appVersion),
    };
  }

  async function openUpdateTarget(target) {
    const config = await readConfigImpl();
    const trustedTargets = {
      installer: normalizeTrustedUrl(config.lastSeenInstallerUrl),
      notes: normalizeTrustedUrl(config.lastSeenReleaseUrl),
    };
    if (!Object.prototype.hasOwnProperty.call(trustedTargets, target)) {
      throw new Error('Choose one of the available update links.');
    }

    const url = trustedTargets[target];
    if (!url) {
      throw new Error(target === 'installer'
        ? 'The latest release does not have a trusted Windows installer link.'
        : 'No trusted GitHub release link is available yet. Check for updates first.');
    }
    if (typeof openExternalImpl !== 'function') {
      throw new Error('Local AI Hub could not open that update link.');
    }

    await openExternalImpl(url);
    return {
      message: target === 'installer'
        ? 'The Windows installer download is open in your browser. Local AI Hub will not run it automatically.'
        : 'The Local AI Hub GitHub release is open in your browser.',
    };
  }

  function scheduleLaunchUpdateCheck(options = {}) {
    if (!options.enabled || launchTimer) {
      return false;
    }

    launchTimer = setTimeoutImpl(() => {
      launchTimer = null;
      checkForUpdates()
        .then((result) => options.onResult?.(result))
        .catch(() => null);
    }, options.delayMs || LAUNCH_CHECK_DELAY_MS);
    return true;
  }

  function dispose() {
    cancelUpdateCheck();
    if (launchTimer) {
      clearTimeoutImpl(launchTimer);
      launchTimer = null;
    }
  }

  return {
    cancelUpdateCheck,
    checkForUpdates,
    dispose,
    getSnapshot,
    openUpdateTarget,
    saveCheckOnLaunch,
    scheduleLaunchUpdateCheck,
  };
}

module.exports = {
  GITHUB_RELEASES_API_URL,
  INSTALLER_NAME_PATTERN,
  UpdateCheckError,
  compareSemanticVersions,
  createUpdateService,
  isNewerVersion,
  isTrustedGitHubReleaseUrl,
  parseReleaseMetadata,
  parseSemanticVersion,
};
