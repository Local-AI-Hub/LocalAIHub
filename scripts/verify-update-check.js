const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  compareSemanticVersions,
  createUpdateService,
  isNewerVersion,
  parseReleaseMetadata,
  parseSemanticVersion,
} = require('../electron/services/updateService');

const TRUSTED_RELEASE_URL = 'https://github.com/Local-AI-Hub/LocalAIHub/releases/tag/v0.50.0';
const TRUSTED_INSTALLER_URL = 'https://github.com/Local-AI-Hub/LocalAIHub/releases/download/v0.50.0/LocalAIHub-Setup-0.50.0.exe';

function release(version, options = {}) {
  const normalized = String(version).replace(/^v/i, '');
  return {
    assets: options.assets === undefined
      ? [{
          name: `LocalAIHub-Setup-${normalized}.exe`,
          browser_download_url: `https://github.com/Local-AI-Hub/LocalAIHub/releases/download/v${normalized}/LocalAIHub-Setup-${normalized}.exe`,
        }]
      : options.assets,
    draft: Boolean(options.draft),
    html_url: `https://github.com/Local-AI-Hub/LocalAIHub/releases/tag/v${normalized}`,
    name: `Local AI Hub v${normalized}`,
    prerelease: Boolean(options.prerelease),
    tag_name: `v${normalized}`,
  };
}

function response(payload, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    headers: {
      get: (name) => options.headers?.[String(name).toLowerCase()] ?? null,
    },
    json: async () => {
      if (options.jsonError) throw new Error('bad json');
      return payload;
    },
  };
}

function createHarness(options = {}) {
  let config = {
    checkForUpdatesOnLaunch: false,
    ...options.config,
  };
  const opened = [];
  const service = createUpdateService({
    appVersion: options.appVersion || '0.49.0',
    fetchImpl: options.fetchImpl || (async () => response([release('0.50.0')])),
    logger: { warn: async () => null },
    openExternalImpl: async (url) => opened.push(url),
    readConfigImpl: async () => ({ ...config }),
    updateConfigImpl: async (mutator) => {
      config = await mutator({ ...config });
      return { ...config };
    },
    setTimeoutImpl: options.setTimeoutImpl,
    clearTimeoutImpl: options.clearTimeoutImpl,
  });

  return {
    getConfig: () => ({ ...config }),
    opened,
    service,
  };
}

async function main() {
  assert.strictEqual(parseSemanticVersion('v0.49.0').version, '0.49.0');
  assert.strictEqual(compareSemanticVersions('v0.49.0', '0.49.0'), 0);
  assert.strictEqual(isNewerVersion('0.49.0', '0.49.0'), false);
  assert.strictEqual(isNewerVersion('0.50.0', '0.49.0'), false);
  assert.strictEqual(isNewerVersion('0.49.0', '0.50.0'), true);
  assert.strictEqual(isNewerVersion('0.50.0-dev', '0.50.0'), true);
  assert.strictEqual(isNewerVersion('0.50.0-dev', '0.49.0'), false);

  const filtered = parseReleaseMetadata([
    release('0.52.0', { draft: true }),
    release('0.51.0', { prerelease: true }),
    release('0.50.0'),
    release('0.48.0'),
  ]);
  assert.strictEqual(filtered.latestVersion, '0.50.0', 'Drafts and prereleases must be ignored.');
  assert.strictEqual(filtered.installerUrl, TRUSTED_INSTALLER_URL, 'The matching Windows installer asset should be selected.');

  const assetMetadata = parseReleaseMetadata([release('0.50.0', {
    assets: [
      { name: 'latest.yml', browser_download_url: 'https://github.com/Local-AI-Hub/LocalAIHub/releases/download/v0.50.0/latest.yml' },
      { name: 'LocalAIHub-Setup-0.50.0.exe.blockmap', browser_download_url: 'https://github.com/Local-AI-Hub/LocalAIHub/releases/download/v0.50.0/LocalAIHub-Setup-0.50.0.exe.blockmap' },
      { name: 'LocalAIHub-Setup-0.50.0.exe', browser_download_url: TRUSTED_INSTALLER_URL },
    ],
  })]);
  assert.strictEqual(assetMetadata.blockmapAvailable, true);
  assert.strictEqual(assetMetadata.latestYmlAvailable, true);
  const mismatchedInstaller = parseReleaseMetadata([release('0.50.0', {
    assets: [{
      name: 'LocalAIHub-Setup-0.49.0.exe',
      browser_download_url: 'https://github.com/Local-AI-Hub/LocalAIHub/releases/download/v0.50.0/LocalAIHub-Setup-0.49.0.exe',
    }],
  })]);
  assert.strictEqual(mismatchedInstaller.installerUrl, '', 'An installer for a different version must not be offered.');

  const noInstallerHarness = createHarness({
    fetchImpl: async () => response([release('0.50.0', { assets: [] })]),
  });
  const noInstaller = await noInstallerHarness.service.checkForUpdates();
  assert.strictEqual(noInstaller.status, 'no-installer');
  assert.match(noInstaller.message, /no Windows installer asset/i);

  const networkHarness = createHarness({
    config: {
      lastSeenLatestVersion: '0.50.0',
      lastSeenReleaseUrl: TRUSTED_RELEASE_URL,
      lastSuccessfulUpdateCheckAt: '2026-06-01T12:00:00.000Z',
    },
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  const networkFailure = await networkHarness.service.checkForUpdates();
  assert.strictEqual(networkFailure.status, 'error');
  assert.strictEqual(networkFailure.errorCode, 'network');
  assert.match(networkFailure.message, /Check your connection/i);
  assert.strictEqual(networkFailure.latestVersion, '0.50.0', 'A failed check should preserve the last successful result.');

  const malformedHarness = createHarness({
    fetchImpl: async () => response({ unexpected: true }),
  });
  const malformed = await malformedHarness.service.checkForUpdates();
  assert.strictEqual(malformed.errorCode, 'malformed');
  assert.match(malformed.message, /could not read/i);

  const rateLimitHarness = createHarness({
    fetchImpl: async () => response({}, {
      headers: { 'x-ratelimit-remaining': '0' },
      ok: false,
      status: 403,
    }),
  });
  const rateLimited = await rateLimitHarness.service.checkForUpdates();
  assert.strictEqual(rateLimited.errorCode, 'rate-limit');
  assert.match(rateLimited.message, /temporarily limiting/i);

  const persistenceHarness = createHarness();
  const savedPreference = await persistenceHarness.service.saveCheckOnLaunch(true);
  assert.strictEqual(savedPreference.checkForUpdatesOnLaunch, true);
  assert.strictEqual(persistenceHarness.getConfig().checkForUpdatesOnLaunch, true);
  await persistenceHarness.service.checkForUpdates();
  assert.strictEqual(persistenceHarness.getConfig().lastSeenLatestVersion, '0.50.0');
  assert(persistenceHarness.getConfig().lastSuccessfulUpdateCheckAt, 'Successful checks should persist a timestamp.');

  const scheduledCallbacks = [];
  const scheduledHarness = createHarness({
    setTimeoutImpl: (callback, delay) => {
      scheduledCallbacks.push({ callback, delay });
      return scheduledCallbacks.length;
    },
    clearTimeoutImpl: () => null,
  });
  const scheduled = scheduledHarness.service.scheduleLaunchUpdateCheck({ enabled: true });
  assert.strictEqual(scheduled, true);
  assert.strictEqual(scheduledCallbacks.length, 1, 'Launch update checks should be scheduled.');
  assert.strictEqual(scheduledCallbacks[0].delay, 12000);
  assert.strictEqual(scheduledHarness.getConfig().lastSuccessfulUpdateCheckAt, undefined, 'Scheduling must not block startup on a network check.');

  const trustedHarness = createHarness({
    config: {
      lastSeenInstallerUrl: TRUSTED_INSTALLER_URL,
      lastSeenReleaseUrl: TRUSTED_RELEASE_URL,
    },
  });
  await trustedHarness.service.openUpdateTarget('notes');
  await trustedHarness.service.openUpdateTarget('installer');
  assert.deepStrictEqual(trustedHarness.opened, [TRUSTED_RELEASE_URL, TRUSTED_INSTALLER_URL]);
  await assert.rejects(() => trustedHarness.service.openUpdateTarget('https://example.com'), /Choose one of the available update links/);

  const untrustedHarness = createHarness({
    config: {
      lastSeenInstallerUrl: 'https://example.com/LocalAIHub-Setup-0.50.0.exe',
      lastSeenReleaseUrl: 'https://example.com/release',
    },
  });
  await assert.rejects(() => untrustedHarness.service.openUpdateTarget('notes'), /No trusted GitHub release link/);
  await assert.rejects(() => untrustedHarness.service.openUpdateTarget('installer'), /trusted Windows installer link/);
  assert.deepStrictEqual(untrustedHarness.opened, []);

  const root = path.join(__dirname, '..');
  const serviceSource = fs.readFileSync(path.join(root, 'electron', 'services', 'updateService.js'), 'utf8');
  const configSource = fs.readFileSync(path.join(root, 'electron', 'services', 'configService.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(root, 'src', 'components', 'SettingsPanel.jsx'), 'utf8');
  const packageSource = fs.readFileSync(path.join(root, 'package.json'), 'utf8');

  assert(configSource.includes('checkForUpdatesOnLaunch: false'), 'Config should default launch checks off for the local-first app.');
  assert(mainSource.includes('appUpdateService.scheduleLaunchUpdateCheck({'), 'Main should schedule the launch check.');
  assert(!mainSource.includes('await appUpdateService.scheduleLaunchUpdateCheck'), 'The launch check must not block startup.');
  assert(preloadSource.includes("openAppUpdateTarget: (target) => invoke('updates:open-target', target)"));
  assert(!preloadSource.includes('openAppUpdateUrl'), 'Renderer IPC must not expose arbitrary update URLs.');
  assert(mainSource.includes("ipcMain.handle('updates:open-target'"), 'Trusted update links must open through the main process.');
  assert(serviceSource.includes("installer: normalizeTrustedUrl(config.lastSeenInstallerUrl)"));
  assert(!/GITHUB_TOKEN|github_pat_|Authorization\s*:/i.test(serviceSource), 'Update checks must not require GitHub credentials.');
  assert(settingsSource.includes('Current version'));
  assert(settingsSource.includes('Latest version'));
  assert(settingsSource.includes('Check for updates on launch'));
  assert(settingsSource.includes('Download installer'));
  assert(!settingsSource.includes('Open GitHub release'), 'Settings should not duplicate the release-notes destination.');
  assert(settingsSource.includes('Release notes'));
  assert(settingsSource.includes('No diagnostics, files, provider keys, or usage data are uploaded.'));
  assert(!packageSource.includes('electron-updater'), 'The silent auto-updater dependency should be removed.');

  console.log('Update check verifier passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
