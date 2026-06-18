const fs = require('fs-extra');
const path = require('path');

const { runCommand } = require('./commandService');
const { getAppPaths, normalizeOptionalDirectoryPath } = require('./configService');
const { getDiskPreflight } = require('./storageMaintenanceService');
const { normalizeToolLifecycle } = require('./toolLifecycleService');
const { buildLaunchModeState, buildManagedLaunchProfile } = require('./toolRegistry');
const { getManagedFfmpegReadiness, prependManagedFfmpegBinToPath, resolveManagedFfmpegPaths } = require('./managedFfmpegService');
const { assertPathInside, assertRealPathInside, isPathInside, resolveManagedToolPaths } = require('./pathSafetyService');

const HYPERFRAMES_TOOL_ID = 'hyperframes';
const HYPERFRAMES_PACKAGE_NAME = 'hyperframes';
const HYPERFRAMES_VERSION = '0.6.112';
const HYPERFRAMES_PACKAGE_SPEC = `${HYPERFRAMES_PACKAGE_NAME}@${HYPERFRAMES_VERSION}`;
const MIN_NODE_MAJOR = 22;
const MIN_INSTALL_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const DOCTOR_TIMEOUT_MS = 3 * 60 * 1000;

function firstNonEmptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function normalizePathKey(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function parseNodeVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) {
    return { major: 0, version: String(value || '').trim() };
  }
  return {
    major: Number(match[1]) || 0,
    version: `v${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
  };
}

function buildNodeMissingMessage() {
  return 'HyperFrames requires Node.js 22 or newer and npm. Install Node.js, then reopen or repair HyperFrames.';
}

function buildNodeTooOldMessage(version) {
  return `HyperFrames requires Node.js 22 or newer. Detected Node.js ${version || 'unknown'}.`;
}

function buildNpmUnavailableMessage(detail = '') {
  const suffix = detail ? ` ${detail}` : '';
  return `HyperFrames requires a working npm command from the detected Node.js installation.${suffix}`.trim();
}

function getHomeDriveAndPath(profileDir) {
  const resolved = path.resolve(profileDir);
  const parsed = path.parse(resolved);
  const root = parsed.root || '';
  const homeDrive = root.endsWith('\\') ? root.slice(0, -1) : root;
  const relativeFromRoot = resolved.slice(root.length).replace(/\//g, '\\');
  return {
    HOMEDRIVE: homeDrive || '',
    HOMEPATH: `\\${relativeFromRoot}`.replace(/\\+/g, '\\'),
  };
}

function buildHyperFramesRuntimePaths(options = {}) {
  const managedRoot = normalizeOptionalDirectoryPath(options.managedRoot || options.installRoot || '') || getAppPaths().managedRoot;
  const base = resolveManagedToolPaths(HYPERFRAMES_TOOL_ID, '.venv', { managedRoot });
  const installDir = base.installDir;
  const runtimeDir = path.join(installDir, 'runtime');
  const browserProfileDir = path.join(installDir, 'browser-profile');
  const npmCacheDir = path.join(installDir, 'npm-cache');
  const tempDir = path.join(installDir, 'temp');
  const logsDir = path.join(installDir, 'logs');
  const stateDir = path.join(installDir, 'state');
  return {
    ...base,
    appDir: runtimeDir,
    browserProfileDir,
    browserStatePath: path.join(stateDir, 'browser.json'),
    installDir,
    logsDir,
    managedRoot,
    npmCacheDir,
    packageJsonPath: path.join(runtimeDir, 'package.json'),
    packageLockPath: path.join(runtimeDir, 'package-lock.json'),
    runtimeDir,
    stateDir,
    tempDir,
  };
}

async function ensureHyperFramesRuntimeDirectories(paths) {
  for (const targetPath of [paths.installDir, paths.runtimeDir, paths.browserProfileDir, paths.npmCacheDir, paths.tempDir, paths.logsDir, paths.stateDir]) {
    assertPathInside(paths.installDir, targetPath, 'Local AI Hub refused to use a HyperFrames runtime path outside its managed tool folder.');
    await fs.ensureDir(targetPath);
    await assertRealPathInside(paths.installDir, targetPath, 'Local AI Hub refused to use a HyperFrames runtime folder that crosses a symlink or junction.');
  }
}

async function findExecutableOnPath(commandName) {
  const result = await runCommand('where.exe', [commandName], {
    allowFailure: true,
    timeoutMs: 10000,
  }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  if (Number(result.code || 0) !== 0) {
    return null;
  }
  const candidates = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!candidates.length) {
    return null;
  }
  const preferred = candidates.find((candidate) => /\.(?:cmd|exe)$/i.test(candidate)) || candidates[0];
  return path.resolve(preferred);
}

async function detectExternalNodeAndNpm() {
  const nodeCommandPath = await findExecutableOnPath('node');
  if (!nodeCommandPath) {
    throw new Error(buildNodeMissingMessage());
  }

  const metadataResult = await runCommand(nodeCommandPath, ['-p', 'JSON.stringify({executable:process.execPath,version:process.version,versions:process.versions})'], {
    allowFailure: true,
    timeoutMs: 15000,
  });
  if (Number(metadataResult.code || 0) !== 0) {
    throw new Error(buildNodeMissingMessage());
  }

  let metadata = null;
  try {
    metadata = JSON.parse(firstNonEmptyLine(metadataResult.stdout));
  } catch {
    throw new Error(buildNodeMissingMessage());
  }

  const nodePath = path.resolve(metadata.executable || nodeCommandPath);
  if (process.versions?.electron && normalizePathKey(nodePath) === normalizePathKey(process.execPath)) {
    throw new Error('HyperFrames requires an external Node.js 22 or newer installation. Electron\'s embedded runtime is not used for managed HyperFrames setup.');
  }

  const nodeVersion = parseNodeVersion(metadata.version || '');
  if (nodeVersion.major < MIN_NODE_MAJOR) {
    throw new Error(buildNodeTooOldMessage(nodeVersion.version || metadata.version));
  }

  const npmPath = await findExecutableOnPath('npm');
  if (!npmPath) {
    throw new Error(buildNpmUnavailableMessage('Install Node.js with npm, then reopen or repair HyperFrames.'));
  }

  const npmEnv = prependNodeDirectoryToPath({ ...process.env }, nodePath);
  const npmResult = await runCommand(npmPath, ['--version'], {
    allowFailure: true,
    env: npmEnv,
    shell: commandNeedsShell(npmPath),
    timeoutMs: 30000,
  });
  if (Number(npmResult.code || 0) !== 0) {
    throw new Error(buildNpmUnavailableMessage(firstNonEmptyLine(npmResult.stderr) || 'Repair the Node.js/npm installation and try again.'));
  }

  return {
    nodePath,
    nodeVersion: nodeVersion.version || metadata.version,
    nodeMajor: nodeVersion.major,
    npmPath,
    npmVersion: firstNonEmptyLine(npmResult.stdout),
  };
}

function commandNeedsShell(commandPath) {
  return /\.(?:cmd|bat)$/i.test(String(commandPath || ''));
}
function prependNodeDirectoryToPath(env = {}, nodePath) {
  const nextEnv = { ...env };
  const nodeDir = path.dirname(path.resolve(nodePath));
  const pathKey = Object.keys(nextEnv).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const entries = String(nextEnv[pathKey] || process.env[pathKey] || '').split(path.delimiter).filter(Boolean);
  const nodeKey = normalizePathKey(nodeDir);
  const filtered = entries.filter((entry) => normalizePathKey(entry) !== nodeKey);
  nextEnv[pathKey] = [nodeDir, ...filtered].join(path.delimiter);
  return nextEnv;
}

function buildHyperFramesChildProcessEnv(paths, runtime = {}, options = {}) {
  const managedFfmpegPaths = options.ffmpegPaths || resolveManagedFfmpegPaths();
  let env = { ...process.env, ...(options.env || {}) };
  if (runtime.nodePath) {
    env = prependNodeDirectoryToPath(env, runtime.nodePath);
  }
  env = prependManagedFfmpegBinToPath(env, managedFfmpegPaths);

  const profileDir = path.resolve(paths.browserProfileDir);
  const homeParts = getHomeDriveAndPath(profileDir);
  env.USERPROFILE = profileDir;
  env.HOME = profileDir;
  env.HOMEDRIVE = homeParts.HOMEDRIVE;
  env.HOMEPATH = homeParts.HOMEPATH;
  env.TEMP = path.resolve(paths.tempDir);
  env.TMP = path.resolve(paths.tempDir);
  env.npm_config_cache = path.resolve(paths.npmCacheDir);
  env.HYPERFRAMES_NO_UPDATE_CHECK = '1';
  delete env.PUPPETEER_CACHE_DIR;
  delete env.PLAYWRIGHT_BROWSERS_PATH;

  if (options.browserExecutablePath) {
    env.HYPERFRAMES_BROWSER_PATH = path.resolve(options.browserExecutablePath);
  } else {
    delete env.HYPERFRAMES_BROWSER_PATH;
  }

  return env;
}

async function assertManagedFfmpegReady() {
  const paths = resolveManagedFfmpegPaths();
  const readiness = await getManagedFfmpegReadiness(paths);
  if (!readiness.ok) {
    throw new Error(readiness.error || 'Local AI Hub could not verify its managed FFmpeg and FFprobe runtime. Reinstall Local AI Hub, then repair HyperFrames.');
  }
  return readiness;
}

async function writeRuntimePackageJson(paths) {
  await fs.ensureDir(paths.runtimeDir);
  const packageJson = {
    private: true,
    name: 'local-ai-hub-managed-hyperframes-runtime',
    version: '0.0.0',
    description: 'Local AI Hub managed HyperFrames runtime. Do not edit by hand.',
    dependencies: {
      [HYPERFRAMES_PACKAGE_NAME]: HYPERFRAMES_VERSION,
    },
  };
  await fs.writeJson(paths.packageJsonPath, packageJson, { spaces: 2 });
}

async function readInstalledHyperFramesPackage(paths) {
  const packagePath = path.join(paths.runtimeDir, 'node_modules', HYPERFRAMES_PACKAGE_NAME, 'package.json');
  if (!(await fs.pathExists(packagePath))) {
    return null;
  }
  return fs.readJson(packagePath).catch(() => null);
}

async function getInstalledHyperFramesVersion(paths) {
  const packageJson = await readInstalledHyperFramesPackage(paths);
  return String(packageJson?.version || '').trim();
}

function getHyperFramesCliPath(paths) {
  return path.join(paths.runtimeDir, 'node_modules', HYPERFRAMES_PACKAGE_NAME, 'dist', 'cli.js');
}

async function verifyPinnedHyperFramesPackage(paths) {
  const version = await getInstalledHyperFramesVersion(paths);
  const cliPath = getHyperFramesCliPath(paths);
  if (version !== HYPERFRAMES_VERSION || !(await fs.pathExists(cliPath))) {
    return {
      ok: false,
      version,
      cliPath,
      error: version
        ? `HyperFrames ${version} is installed, but Local AI Hub requires ${HYPERFRAMES_VERSION}.`
        : 'HyperFrames is not installed in the managed runtime folder.',
    };
  }
  return { ok: true, version, cliPath };
}

async function installPinnedHyperFramesPackage(paths, runtime, logger, onProgress) {
  await writeRuntimePackageJson(paths);
  await logger?.info?.('Installing pinned HyperFrames npm package.', {
    packageSpec: HYPERFRAMES_PACKAGE_SPEC,
    runtimeDir: paths.runtimeDir,
    npmCacheDir: paths.npmCacheDir,
  });
  if (typeof onProgress === 'function') {
    onProgress({ toolId: HYPERFRAMES_TOOL_ID, percent: 40, stage: 'installing', message: 'Installing HyperFrames 0.6.112.' });
  }
  const env = buildHyperFramesChildProcessEnv(paths, runtime);
  const result = await runCommand(runtime.npmPath, ['install', HYPERFRAMES_PACKAGE_SPEC, '--save-exact', '--no-audit', '--no-fund', '--omit=dev'], {
    cwd: paths.runtimeDir,
    env,
    shell: commandNeedsShell(runtime.npmPath),
    timeoutMs: COMMAND_TIMEOUT_MS,
    errorMessage: 'Local AI Hub could not install the pinned HyperFrames runtime.',
  });
  await logger?.info?.('Pinned HyperFrames npm package install finished.', {
    stdout: firstNonEmptyLine(result.stdout),
  });
  const installed = await verifyPinnedHyperFramesPackage(paths);
  if (!installed.ok) {
    throw new Error(installed.error || 'Local AI Hub could not verify the pinned HyperFrames package after npm install.');
  }
  return installed;
}

async function runHyperFramesCli(paths, runtime, args, options = {}) {
  const cliPath = getHyperFramesCliPath(paths);
  if (!(await fs.pathExists(cliPath))) {
    throw new Error('HyperFrames is not installed in the managed runtime folder. Run Repair to reinstall it.');
  }
  const env = buildHyperFramesChildProcessEnv(paths, runtime, {
    browserExecutablePath: options.browserExecutablePath || null,
  });
  return runCommand(runtime.nodePath, [cliPath, ...args], {
    allowFailure: Boolean(options.allowFailure),
    cwd: paths.runtimeDir,
    env,
    timeoutMs: options.timeoutMs || COMMAND_TIMEOUT_MS,
    errorMessage: options.errorMessage || 'Local AI Hub could not run the managed HyperFrames CLI.',
  });
}

function getBrowserResourcesStatus(executablePath) {
  const executableDir = path.dirname(path.resolve(executablePath || ''));
  const required = [
    'chrome-headless-shell.exe',
    'icudtl.dat',
    'libEGL.dll',
    'libGLESv2.dll',
    'headless_lib_data.pak',
    'locales',
    'resources',
  ];
  const missing = required.filter((entry) => !fs.existsSync(path.join(executableDir, entry)));
  return {
    executableDir,
    ok: missing.length === 0,
    missing,
  };
}

async function validateManagedBrowserExecutable(paths, executablePath) {
  const candidate = path.resolve(String(executablePath || '').trim());
  if (!candidate) {
    throw new Error('HyperFrames did not report a Chrome Headless Shell executable path.');
  }
  if (!(await fs.pathExists(candidate))) {
    throw new Error('HyperFrames reported a Chrome Headless Shell path, but the executable is missing. Run Repair to provision it again.');
  }
  await assertRealPathInside(paths.browserProfileDir, candidate, 'Local AI Hub refused to use a HyperFrames browser executable outside its managed browser profile.');
  if (!isPathInside(paths.browserProfileDir, candidate)) {
    throw new Error('Local AI Hub refused to use a HyperFrames browser executable outside its managed browser profile.');
  }
  const resources = getBrowserResourcesStatus(candidate);
  if (!resources.ok) {
    throw new Error(`Chrome Headless Shell is incomplete. Missing: ${resources.missing.join(', ')}. Run Repair to provision it again.`);
  }
  return candidate;
}

async function readPersistedBrowserState(paths) {
  if (!(await fs.pathExists(paths.browserStatePath))) {
    return null;
  }
  return fs.readJson(paths.browserStatePath).catch(() => null);
}

async function writeBrowserState(paths, browserExecutablePath) {
  const payload = {
    browserExecutablePath,
    provisionedAt: new Date().toISOString(),
  };
  await fs.ensureDir(paths.stateDir);
  await fs.writeJson(paths.browserStatePath, payload, { spaces: 2 });
  return payload;
}

async function getValidPersistedBrowserPath(paths) {
  const state = await readPersistedBrowserState(paths);
  const browserPath = String(state?.browserExecutablePath || '').trim();
  if (!browserPath) {
    return null;
  }
  try {
    return await validateManagedBrowserExecutable(paths, browserPath);
  } catch {
    return null;
  }
}

async function provisionManagedBrowser(paths, runtime, logger, onProgress, options = {}) {
  const existingBrowserPath = options.reuseExisting !== false ? await getValidPersistedBrowserPath(paths) : null;
  if (existingBrowserPath) {
    await logger?.info?.('Reusing verified managed HyperFrames browser executable.', {
      browserExecutablePath: existingBrowserPath,
    });
    return existingBrowserPath;
  }

  if (typeof onProgress === 'function') {
    onProgress({ toolId: HYPERFRAMES_TOOL_ID, percent: 68, stage: 'provisioning-browser', message: 'Provisioning Chrome Headless Shell.' });
  }
  await logger?.info?.('Running HyperFrames browser ensure with managed profile.', {
    browserProfileDir: paths.browserProfileDir,
  });
  await runHyperFramesCli(paths, runtime, ['browser', 'ensure'], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    errorMessage: 'Local AI Hub could not provision Chrome Headless Shell for HyperFrames.',
  });
  const pathResult = await runHyperFramesCli(paths, runtime, ['browser', 'path'], {
    timeoutMs: DOCTOR_TIMEOUT_MS,
    errorMessage: 'Local AI Hub could not read the managed Chrome Headless Shell path from HyperFrames.',
  });
  const browserExecutablePath = await validateManagedBrowserExecutable(paths, firstNonEmptyLine(pathResult.stdout));
  await writeBrowserState(paths, browserExecutablePath);
  await logger?.info?.('Managed HyperFrames browser executable verified.', {
    browserExecutablePath,
  });
  return browserExecutablePath;
}

function parseDoctorReadiness(output) {
  const text = String(output || '');
  const failedRequired = [];
  for (const label of ['Node.js', 'FFmpeg', 'FFprobe', 'Chrome']) {
    const failurePattern = new RegExp(`(?:\u2717|x|X)\\s+${label.replace('.', '\\.')}`, 'i');
    if (failurePattern.test(text)) {
      failedRequired.push(label);
    }
  }
  const dockerMissing = /(?:\u2717|x|X)\s+Docker\b/i.test(text) || /Docker running\s+Not running/i.test(text);
  return {
    dockerOptional: dockerMissing,
    failedRequired,
    ok: failedRequired.length === 0,
  };
}

async function runHyperFramesDoctor(paths, runtime, browserExecutablePath, logger) {
  const result = await runHyperFramesCli(paths, runtime, ['doctor'], {
    allowFailure: true,
    browserExecutablePath,
    timeoutMs: DOCTOR_TIMEOUT_MS,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const parsed = parseDoctorReadiness(output);
  await logger?.info?.('HyperFrames doctor completed.', {
    code: result.code,
    dockerOptional: parsed.dockerOptional,
    failedRequired: parsed.failedRequired,
  });
  if (!parsed.ok) {
    throw new Error(`HyperFrames doctor reported a required runtime problem: ${parsed.failedRequired.join(', ')}. Run Repair after fixing the prerequisite.`);
  }
  return {
    code: result.code,
    dockerOptional: parsed.dockerOptional,
    output,
    requiredReady: true,
  };
}

async function getHyperFramesInstallPreflight(manifest, options = {}) {
  const installRoot = normalizeOptionalDirectoryPath(options.installRoot || '') || getAppPaths().managedRoot;
  const paths = buildHyperFramesRuntimePaths({ installRoot });
  const preflight = await getDiskPreflight(paths.installDir, MIN_INSTALL_FREE_BYTES);
  return {
    ...preflight,
    destinationMessage: `${manifest.name} will be installed directly into ${paths.installDir}. First setup downloads npm dependencies and Chrome Headless Shell into Local AI Hub-managed storage.`,
    estimateSource: 'hyperframes-managed-runtime-floor',
    installContract: manifest.installContract,
    installRoot,
    requiredBytes: MIN_INSTALL_FREE_BYTES,
    sizeKnown: true,
    targetPath: paths.installDir,
    toolId: HYPERFRAMES_TOOL_ID,
    capability: 'webui',
    toolName: manifest.name,
  };
}

function buildHyperFramesToolState(manifest, paths, runtime, browserExecutablePath, ffmpegReadiness, doctorReadiness) {
  const baseState = normalizeToolLifecycle({
    id: HYPERFRAMES_TOOL_ID,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    category: manifest.category,
    type: 'npm-package',
    source: 'managed',
    managedByLocalAIHub: true,
    installedByLocalAIHub: true,
    installDir: paths.installDir,
    installRoot: paths.managedRoot,
    requestedInstallRoot: paths.managedRoot,
    appDir: paths.runtimeDir,
    venvDir: null,
    displayPath: paths.installDir,
    installedAt: new Date().toISOString(),
    installedVersion: HYPERFRAMES_VERSION,
    configTargets: manifest.installInstructions?.configTargets || [],
    lastError: null,
    lastRepairMessage: null,
    status: 'stopped',
    launchSupported: false,
    interfaceMode: manifest.interfaceMode || 'pipeline-only',
    hyperframes: {
      browserExecutablePath,
      browserReady: true,
      doctorReady: true,
      dockerRequired: false,
      dockerOptional: Boolean(doctorReadiness?.dockerOptional),
      ffmpegReady: Boolean(ffmpegReadiness?.ok),
      ffmpegVersion: ffmpegReadiness?.ffmpegVersion || '',
      ffprobeVersion: ffmpegReadiness?.ffprobeVersion || '',
      nodePath: runtime.nodePath,
      nodeVersion: runtime.nodeVersion,
      npmPath: runtime.npmPath,
      npmVersion: runtime.npmVersion,
      packageName: HYPERFRAMES_PACKAGE_NAME,
      pinnedVersion: HYPERFRAMES_VERSION,
      runtimeDir: paths.runtimeDir,
      browserProfileDir: paths.browserProfileDir,
      npmCacheDir: paths.npmCacheDir,
      tempDir: paths.tempDir,
      logsDir: paths.logsDir,
      stateDir: paths.stateDir,
      setupSummary: `HyperFrames ${HYPERFRAMES_VERSION}, ${runtime.nodeVersion}, Chrome Headless Shell ready, FFmpeg/FFprobe ready.`,
    },
  }, manifest);
  const launchProfile = buildManagedLaunchProfile(baseState, manifest);
  const launchModeState = buildLaunchModeState({ ...baseState, launchProfile }, manifest, { source: 'managed' });
  return normalizeToolLifecycle({
    ...baseState,
    ...launchModeState,
    interfaceMode: 'pipeline-only',
    launchSupported: false,
    launchProfile: launchModeState.launchProfile || launchProfile,
  }, manifest);
}

async function assertWritableManagedRoot(paths) {
  await fs.ensureDir(paths.installDir);
  const probePath = path.join(paths.installDir, `.localaihub-write-probe-${process.pid}-${Date.now()}`);
  await fs.writeFile(probePath, 'ok', 'utf8');
  await fs.remove(probePath).catch(() => null);
}

async function installManagedHyperFrames(manifest, options = {}, logger = null) {
  const installRoot = normalizeOptionalDirectoryPath(options.installRoot || '') || getAppPaths().managedRoot;
  const paths = buildHyperFramesRuntimePaths({ installRoot });
  await ensureHyperFramesRuntimeDirectories(paths);

  options.onProgress?.({ toolId: HYPERFRAMES_TOOL_ID, percent: 8, stage: 'checking-node', message: 'Checking Node.js and npm.' });
  const runtime = await detectExternalNodeAndNpm();
  options.onProgress?.({ toolId: HYPERFRAMES_TOOL_ID, percent: 18, stage: 'checking-ffmpeg', message: 'Checking FFmpeg and FFprobe.' });
  const ffmpegReadiness = await assertManagedFfmpegReady();
  await assertWritableManagedRoot(paths);
  const preflight = await getHyperFramesInstallPreflight(manifest, { installRoot });
  if (preflight.blocked) {
    throw new Error(`${manifest.name} needs at least 2 GB free on ${preflight.mount || 'the managed storage drive'} for its runtime, npm cache, temporary files, and Chrome Headless Shell.`);
  }

  const packageReadiness = await verifyPinnedHyperFramesPackage(paths);
  if (!packageReadiness.ok) {
    await installPinnedHyperFramesPackage(paths, runtime, logger, options.onProgress);
  }

  const browserExecutablePath = await provisionManagedBrowser(paths, runtime, logger, options.onProgress, { reuseExisting: true });
  options.onProgress?.({ toolId: HYPERFRAMES_TOOL_ID, percent: 88, stage: 'verifying', message: 'Verifying HyperFrames runtime.' });
  const doctorReadiness = await runHyperFramesDoctor(paths, runtime, browserExecutablePath, logger);
  const toolState = buildHyperFramesToolState(manifest, paths, runtime, browserExecutablePath, ffmpegReadiness, doctorReadiness);
  options.onProgress?.({ toolId: HYPERFRAMES_TOOL_ID, percent: 100, stage: 'complete', message: 'HyperFrames is ready.' });
  return toolState;
}

async function inspectHyperFramesRepairState(toolState, manifest) {
  const installRoot = normalizeOptionalDirectoryPath(toolState?.installRoot || toolState?.requestedInstallRoot || '') || getAppPaths().managedRoot;
  const paths = buildHyperFramesRuntimePaths({ installRoot });
  const issues = [];

  try {
    await detectExternalNodeAndNpm();
  } catch (error) {
    issues.push({ id: 'node-npm', message: error.message });
  }

  const packageReadiness = await verifyPinnedHyperFramesPackage(paths);
  if (!packageReadiness.ok) {
    issues.push({ id: 'package', message: packageReadiness.error });
  }

  try {
    await assertManagedFfmpegReady();
  } catch (error) {
    issues.push({ id: 'ffmpeg', message: error.message });
  }

  const browserPath = await getValidPersistedBrowserPath(paths);
  if (!browserPath) {
    issues.push({ id: 'browser', message: 'The managed Chrome Headless Shell executable is missing or outside HyperFrames managed storage.' });
  }

  return {
    issues,
    needsRepair: issues.length > 0,
    paths,
    toolId: HYPERFRAMES_TOOL_ID,
    toolName: manifest.name,
  };
}

async function repairManagedHyperFrames(toolState, manifest, options = {}, logger = null) {
  const repairState = await inspectHyperFramesRepairState(toolState, manifest);
  const notes = repairState.issues.map((issue) => issue.id);
  const repairedState = await installManagedHyperFrames(manifest, {
    ...options,
    installRoot: repairState.paths.managedRoot,
  }, logger);
  return {
    ...repairedState,
    installedAt: toolState.installedAt || repairedState.installedAt,
    lastRepairMessage: notes.length
      ? `Local AI Hub repaired HyperFrames: ${notes.join(', ')}.`
      : 'Local AI Hub checked HyperFrames and it is ready.',
  };
}

module.exports = {
  HYPERFRAMES_PACKAGE_NAME,
  HYPERFRAMES_PACKAGE_SPEC,
  HYPERFRAMES_TOOL_ID,
  HYPERFRAMES_VERSION,
  MIN_INSTALL_FREE_BYTES,
  MIN_NODE_MAJOR,
  buildHyperFramesChildProcessEnv,
  buildHyperFramesRuntimePaths,
  buildNodeMissingMessage,
  buildNodeTooOldMessage,
  buildNpmUnavailableMessage,
  commandNeedsShell,
  detectExternalNodeAndNpm,
  getBrowserResourcesStatus,
  getHyperFramesCliPath,
  getHyperFramesInstallPreflight,
  getHomeDriveAndPath,
  getInstalledHyperFramesVersion,
  inspectHyperFramesRepairState,
  installManagedHyperFrames,
  parseDoctorReadiness,
  provisionManagedBrowser,
  repairManagedHyperFrames,
  runHyperFramesDoctor,
  runHyperFramesCli,
  validateManagedBrowserExecutable,
  verifyPinnedHyperFramesPackage,
};