const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(os.tmpdir(), 'localaihub-hyperframes-runtime-contract');
process.env.APPDATA = path.join(TEST_STORAGE_ROOT, 'Roaming');
process.env.LOCALAPPDATA = path.join(TEST_STORAGE_ROOT, 'Local');
process.env.TEMP = path.join(TEST_STORAGE_ROOT, 'Temp');
process.env.TMP = process.env.TEMP;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'appData') return process.env.APPDATA;
          if (name === 'home') return TEST_STORAGE_ROOT;
          if (name === 'exe') return process.execPath;
          if (name === 'temp') return process.env.TEMP;
          return TEST_STORAGE_ROOT;
        },
        getVersion() { return '0.53.0-test'; },
        isPackaged: false,
      },
      shell: { openExternal: async () => {}, openPath: async () => '' },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const repoRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'electron/config/tools-manifest.json'), 'utf8'));
const hyperframes = manifest.find((tool) => tool.id === 'hyperframes');
assert(hyperframes, 'HyperFrames must be registered in the tool manifest.');

const servicePath = path.join(repoRoot, 'electron/services/hyperFramesService.js');
const serviceSource = fs.readFileSync(servicePath, 'utf8');
const processSource = fs.readFileSync(path.join(repoRoot, 'electron/services/processService.js'), 'utf8');
const installerSource = fs.readFileSync(path.join(repoRoot, 'electron/services/installerService.js'), 'utf8');

const {
  HYPERFRAMES_PACKAGE_SPEC,
  HYPERFRAMES_VERSION,
  MIN_INSTALL_FREE_BYTES,
  MIN_NODE_MAJOR,
  buildHyperFramesChildProcessEnv,
  buildHyperFramesRuntimePaths,
  getManagedHyperFramesExecutionRuntime,
  buildNodeMissingMessage,
  buildNodeTooOldMessage,
  buildNpmUnavailableMessage,
  getBrowserResourcesStatus,
  getHomeDriveAndPath,
  parseDoctorReadiness,
  validateManagedBrowserExecutable,
} = require('../electron/services/hyperFramesService');

async function main() {
  assert.strictEqual(HYPERFRAMES_VERSION, '0.6.112', 'HyperFrames version must stay pinned to the smoke-tested release.');
  assert.strictEqual(HYPERFRAMES_PACKAGE_SPEC, 'hyperframes@0.6.112', 'HyperFrames npm install must use an exact package spec.');
  assert.strictEqual(MIN_NODE_MAJOR, 22, 'HyperFrames must require external Node 22 or newer.');
  assert.strictEqual(MIN_INSTALL_FREE_BYTES, 2 * 1024 * 1024 * 1024, 'HyperFrames install preflight must reserve at least 2 GiB.');

  assert(serviceSource.includes('process.versions?.electron'), 'External Node detection must explicitly reject Electron embedded runtime as the managed Node runtime.');
  assert(serviceSource.includes('findExecutableOnPath(\'node\')'), 'External Node detection must use normal child-process lookup.');
  assert(serviceSource.includes('findExecutableOnPath(\'npm\')'), 'npm detection must use normal child-process lookup.');
  assert.strictEqual(typeof getManagedHyperFramesExecutionRuntime, 'function', 'Pipeline execution must have a readiness-only managed HyperFrames runtime helper.');
  assert(serviceSource.includes('npm_config_cache'), 'HyperFrames child processes must use a managed npm cache.');
  for (const variable of ['USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'HYPERFRAMES_NO_UPDATE_CHECK', 'HYPERFRAMES_BROWSER_PATH']) {
    assert(serviceSource.includes(variable), `HyperFrames child environment should manage ${variable}.`);
  }
  assert(!serviceSource.includes('PUPPETEER_CACHE_DIR ='), 'HyperFrames integration must not claim Puppeteer cache env as the browser-cache solution.');
  assert(!serviceSource.includes('PLAYWRIGHT_BROWSERS_PATH ='), 'HyperFrames integration must not claim Playwright cache env as the browser-cache solution.');
  assert(!/setx\s/i.test(serviceSource), 'HyperFrames integration must not mutate global PATH with setx.');
  assert(!/reg\s+add/i.test(serviceSource), 'HyperFrames integration must not mutate the Windows registry.');
  assert(!/process\.env\.(?:USERPROFILE|HOME|APPDATA|LOCALAPPDATA)\s*=/.test(serviceSource), 'HyperFrames integration must not mutate parent profile environment variables.');
  assert(!/process\.env\.PATH\s*=/.test(serviceSource), 'HyperFrames integration must not mutate parent PATH.');

  const paths = buildHyperFramesRuntimePaths({ managedRoot: path.join(TEST_STORAGE_ROOT, 'ManagedRoot') });
  assert.strictEqual(paths.installDir, path.join(TEST_STORAGE_ROOT, 'ManagedRoot', 'tools', 'hyperframes'), 'HyperFrames install root must derive from the configured managed root.');
  for (const key of ['runtimeDir', 'browserProfileDir', 'npmCacheDir', 'tempDir', 'logsDir', 'stateDir']) {
    assert(paths[key].startsWith(paths.installDir), `${key} must stay inside the HyperFrames managed tool root.`);
  }

  const beforePath = process.env.PATH;
  const fakeFfmpeg = path.join(paths.installDir, 'fake-bin');
  const env = buildHyperFramesChildProcessEnv(paths, { nodePath: path.join(paths.installDir, 'node', 'node.exe') }, {
    ffmpegPaths: {
      binDir: fakeFfmpeg,
      ffmpegPath: path.join(fakeFfmpeg, 'ffmpeg.exe'),
      ffprobePath: path.join(fakeFfmpeg, 'ffprobe.exe'),
    },
    browserExecutablePath: path.join(paths.browserProfileDir, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell.exe'),
  });
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  assert.strictEqual(path.resolve(env[pathKey].split(path.delimiter)[0]).toLowerCase(), path.resolve(fakeFfmpeg).toLowerCase(), 'Managed FFmpeg/FFprobe bin must be first in child PATH.');
  assert.strictEqual(env.TEMP, paths.tempDir, 'TEMP must be HyperFrames managed temp.');
  assert.strictEqual(env.TMP, paths.tempDir, 'TMP must be HyperFrames managed temp.');
  assert.strictEqual(env.npm_config_cache, paths.npmCacheDir, 'npm cache must be HyperFrames managed npm-cache.');
  assert.strictEqual(env.USERPROFILE, paths.browserProfileDir, 'USERPROFILE must point at the managed browser profile for child processes only.');
  assert.strictEqual(env.HOME, paths.browserProfileDir, 'HOME must point at the managed browser profile for child processes only.');
  assert.strictEqual(env.HYPERFRAMES_NO_UPDATE_CHECK, '1', 'HyperFrames update checks must be disabled for managed runtime calls.');
  assert(env.HYPERFRAMES_BROWSER_PATH.startsWith(paths.browserProfileDir), 'HYPERFRAMES_BROWSER_PATH must point inside managed browser storage after provisioning.');
  assert.strictEqual(process.env.PATH, beforePath, 'Building the child env must not mutate parent PATH.');

  const homeParts = getHomeDriveAndPath('D:\\LocalAIHub\\tools\\hyperframes\\browser-profile');
  assert.strictEqual(homeParts.HOMEDRIVE, 'D:', 'HOMEDRIVE should be derived from the managed profile drive.');
  assert.strictEqual(homeParts.HOMEPATH, '\\LocalAIHub\\tools\\hyperframes\\browser-profile', 'HOMEPATH should be derived from the managed profile path.');

  assert.strictEqual(buildNodeMissingMessage(), 'HyperFrames requires Node.js 22 or newer and npm. Install Node.js, then reopen or repair HyperFrames.');
  assert(buildNodeTooOldMessage('v20.11.1').includes('Detected Node.js v20.11.1'), 'Old Node remediation should include the detected version.');
  assert(buildNpmUnavailableMessage('npm failed').includes('working npm command'), 'npm failure should explain that npm must work.');

  const dockerOnly = parseDoctorReadiness('\u2713 Node.js\n\u2713 FFmpeg\n\u2713 FFprobe\n\u2713 Chrome\n\u2717 Docker\n\u2717 Docker running');
  assert.strictEqual(dockerOnly.ok, true, 'Docker missing must not fail HyperFrames readiness.');
  assert.strictEqual(dockerOnly.dockerOptional, true, 'Docker missing should be recorded as optional.');
  const missingChrome = parseDoctorReadiness('\u2713 Node.js\n\u2713 FFmpeg\n\u2713 FFprobe\n\u2717 Chrome');
  assert.strictEqual(missingChrome.ok, false, 'Missing Chrome must fail readiness.');
  assert(missingChrome.failedRequired.includes('Chrome'), 'Missing Chrome should be identified plainly.');

  const browserDir = path.join(paths.browserProfileDir, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell', 'win64-test', 'chrome-headless-shell-win64');
  fs.mkdirSync(path.join(browserDir, 'locales'), { recursive: true });
  fs.mkdirSync(path.join(browserDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(browserDir, 'chrome-headless-shell.exe'), 'placeholder');
  fs.writeFileSync(path.join(browserDir, 'icudtl.dat'), 'placeholder');
  fs.writeFileSync(path.join(browserDir, 'libEGL.dll'), 'placeholder');
  fs.writeFileSync(path.join(browserDir, 'libGLESv2.dll'), 'placeholder');
  fs.writeFileSync(path.join(browserDir, 'headless_lib_data.pak'), 'placeholder');
  const browserExe = await validateManagedBrowserExecutable(paths, path.join(browserDir, 'chrome-headless-shell.exe'));
  assert.strictEqual(browserExe, path.join(browserDir, 'chrome-headless-shell.exe'), 'Managed browser executable should validate inside the profile tree.');
  assert.strictEqual(getBrowserResourcesStatus(browserExe).ok, true, 'Browser resource validation should require sibling files/folders.');
  const outsideExe = path.join(TEST_STORAGE_ROOT, 'outside', 'chrome-headless-shell.exe');
  fs.mkdirSync(path.dirname(outsideExe), { recursive: true });
  fs.writeFileSync(outsideExe, 'placeholder');
  await assert.rejects(() => validateManagedBrowserExecutable(paths, outsideExe), /outside its managed browser profile/i, 'Browser executable outside managed storage must be rejected.');

  assert(installerSource.includes("manifest.installInstructions?.kind === 'npm-package'"), 'Installer must route npm-package tools through the HyperFrames managed runtime installer.');
  assert(installerSource.includes('repairManagedHyperFrames'), 'Repair must route HyperFrames through the managed runtime repair path.');
  assert(processSource.includes('Use the HyperFrames Render pipeline node for trusted local index.html projects'), 'Launch attempts should point to the narrow pipeline render node.');

  console.log('HyperFrames managed runtime verifier passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});