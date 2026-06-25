const crypto = require('crypto');
const fs = require('fs-extra');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const { killProcessTree } = require('./commandService');
const { prepareHyperFramesProjectForPipeline, PROJECT_TREE_LIMITS } = require('./hyperFramesProjectService');
const {
  buildCliSummary,
  buildHyperFramesLintFailureMessage,
  copyCompositionProjectSafely,
  inlineLocalScriptsForHyperFramesLint,
} = require('./hyperFramesRenderService');
const {
  buildHyperFramesChildProcessEnv,
  buildHyperFramesRuntimePaths,
  detectExternalNodeAndNpm,
  getHomeDriveAndPath,
  getHyperFramesCliPath,
  runHyperFramesCli,
  verifyPinnedHyperFramesPackage,
} = require('./hyperFramesService');
const { assertPathInside, assertRealPathInside, assertNoReparsePointTraversal } = require('./pathSafetyService');

const HYPERFRAMES_STUDIO_CONTRACT_VERSION = 1;
const HYPERFRAMES_STUDIO_HOST = '127.0.0.1';
const HYPERFRAMES_STUDIO_CONFIG_PATH = '/__hyperframes_config';
const HYPERFRAMES_STUDIO_WARNING = 'Studio previews project HTML/CSS/JavaScript. Open only projects you trust.';
const HYPERFRAMES_STUDIO_NETWORK_NOTICE = 'Studio is restricted to Local AI Hub-managed HyperFrames projects. Remote network requests are blocked by Local AI Hub.';
const BLOCKED_LOCAL_MARKERS = ['/posthog', '/telemetry', '/analytics', '/capture', '/identify'];
const BLOCKED_ENDPOINT_PREFIXES = [
  '/api/registry',
  '/api/fonts',
  '/api/render',
  '/api/projects/:project/upload',
  '/api/projects/:project/render',
  '/api/projects/:project/renders',
  '/api/projects/:project/thumbnail',
  '/api/projects/:project/waveform',
];
const MAX_CAPTURED_LOG_CHARS = 32768;
const STUDIO_READINESS_TIMEOUT_MS = 60000;

/*
 * Enforced Studio contract:
 * The renderer supplies exactly one managed projectId. Main owns every path, host, port, argument,
 * and environment value. Studio serves a disposable managed copy on 127.0.0.1. A non-persistent
 * Electron session allows only GET/HEAD requests to that exact port and the copy's read/preview
 * endpoints; writes, upload, registry, render, fonts, telemetry, CDNs, and all remote requests fail
 * closed. The isolated window has no preload or Node integration, denies permissions and popups,
 * and cannot navigate off its exact loopback origin. Run-specific profile/cache/temp data is removed
 * on stop. Studio never receives or modifies the original managed project.
 */

function assertProjectIdPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Choose a managed HyperFrames project before opening Studio.');
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== 'projectId') {
    throw new Error('HyperFrames Studio accepts only a managed project ID.');
  }
  const projectId = String(payload.projectId || '').trim();
  if (!projectId) throw new Error('Choose a managed HyperFrames project before opening Studio.');
  return projectId;
}

function isAllowedStudioReadPath(pathname, projectName) {
  if (pathname === '/' || pathname === '/favicon.ico') return true;
  if (pathname.startsWith('/assets/') || pathname.startsWith('/icons/')) return true;
  if (pathname === HYPERFRAMES_STUDIO_CONFIG_PATH || pathname === '/api/events' || pathname === '/api/projects' || pathname === '/api/runtime.js') return true;
  const projectBase = '/api/projects/' + encodeURIComponent(projectName);
  if (pathname === projectBase || pathname === projectBase + '/lint') return true;
  if (pathname.startsWith(projectBase + '/files/')) return true;
  if (pathname === projectBase + '/preview' || pathname.startsWith(projectBase + '/preview/')) return true;
  if (pathname.startsWith(projectBase + '/gsap-animations/')) return true;
  return false;
}

function evaluateStudioRequest(details, context) {
  const method = String(details && details.method || 'GET').toUpperCase();
  let parsed;
  try {
    parsed = new URL(String(details && details.url || ''));
  } catch {
    return { allowed: false, reason: 'invalid-url' };
  }
  const exactOrigin = parsed.protocol === 'http:'
    && parsed.hostname === HYPERFRAMES_STUDIO_HOST
    && parsed.port === String(context.port);
  if (!exactOrigin) return { allowed: false, reason: 'non-local' };
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return { allowed: false, reason: 'invalid-path' };
  }
  if (decodedPath.includes(String.fromCharCode(92)) || decodedPath.split('/').includes('..')) {
    return { allowed: false, reason: 'path-traversal' };
  }
  const lowerPath = decodedPath.toLowerCase();
  if (BLOCKED_LOCAL_MARKERS.some((marker) => lowerPath.includes(marker))) {
    return { allowed: false, reason: 'blocked-telemetry' };
  }
  if (method !== 'GET' && method !== 'HEAD') return { allowed: false, reason: 'blocked-method' };
  if (!isAllowedStudioReadPath(parsed.pathname, context.projectName)) {
    return { allowed: false, reason: 'blocked-local-path' };
  }
  return { allowed: true, reason: 'allowed-read' };
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, HYPERFRAMES_STUDIO_HOST, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function requestText(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: HYPERFRAMES_STUDIO_HOST, path: pathname, port, timeout: 1500 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers || {},
          statusCode: response.statusCode || 0,
        });
      });
    });
    request.on('error', (error) => reject(error));
    request.on('timeout', () => request.destroy(new Error(`GET ${pathname} timed out.`)));
  });
}

async function requestJson(port, pathname) {
  const response = await requestText(port, pathname);
  if (response.statusCode !== 200) {
    const error = new Error(`GET ${pathname} returned HTTP ${response.statusCode || 'unknown'}.`);
    error.httpStatus = response.statusCode || 0;
    throw error;
  }
  try {
    return JSON.parse(response.body);
  } catch (parseError) {
    const error = new Error(`GET ${pathname} returned invalid JSON.`);
    error.cause = parseError;
    throw error;
  }
}

function assertStudioTextResponse(response, pathname, pattern, description) {
  if (!response || response.statusCode !== 200) {
    throw new Error(`GET ${pathname} returned HTTP ${response?.statusCode || 'unknown'}.`);
  }
  if (pattern && !pattern.test(String(response.body || ''))) {
    throw new Error(`GET ${pathname} did not return the expected ${description}.`);
  }
}

function sanitizeStudioLogText(value, maxChars = 2000) {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/(token|secret|password|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .replace(/[A-Za-z]:\\[^\r\n\t"']+/g, '[local-path]')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-16)
    .join('\n')
    .slice(-maxChars);
}

function buildStudioReadinessFailureMessage(reason, diagnostics = {}) {
  const port = diagnostics.port ? ` Port: ${diagnostics.port}.` : '';
  const lastProbe = diagnostics.lastProbe ? ` Last readiness check: ${diagnostics.lastProbe}` : ' Last readiness check: no response yet.';
  const childState = diagnostics.childExited
    ? ` Studio process exited${diagnostics.exitCode !== null && diagnostics.exitCode !== undefined ? ` with code ${diagnostics.exitCode}` : ''}${diagnostics.signalCode ? ` and signal ${diagnostics.signalCode}` : ''}.`
    : ' Studio process was still running when readiness timed out.';
  const logTail = [
    sanitizeStudioLogText(diagnostics.stderr),
    sanitizeStudioLogText(diagnostics.stdout),
  ].filter(Boolean).join('\n');
  const logText = logTail ? ` Recent Studio output: ${logTail}` : ' Recent Studio output: no stdout/stderr was captured.';
  return `${reason}${port}${lastProbe}${childState}${logText}`;
}

async function waitForStudioReady(port, child, options = {}) {
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || STUDIO_READINESS_TIMEOUT_MS) || STUDIO_READINESS_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let lastProbe = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(buildStudioReadinessFailureMessage('HyperFrames Studio stopped before its local server became ready.', {
        childExited: true,
        exitCode: child.exitCode,
        lastProbe,
        port,
        signalCode: child.signalCode,
        stderr: typeof options.stderr === 'function' ? options.stderr() : options.stderr,
        stdout: typeof options.stdout === 'function' ? options.stdout() : options.stdout,
      }));
    }
    try {
      const config = await requestJson(port, HYPERFRAMES_STUDIO_CONFIG_PATH);
      lastProbe = `GET ${HYPERFRAMES_STUDIO_CONFIG_PATH} returned HyperFrames Studio config.`;
      if (config?.isHyperframes !== true) {
        throw new Error(`GET ${HYPERFRAMES_STUDIO_CONFIG_PATH} did not report HyperFrames Studio.`);
      }
      if (options.projectName && String(config.projectName || '') !== String(options.projectName)) {
        throw new Error(`GET ${HYPERFRAMES_STUDIO_CONFIG_PATH} returned a different project name.`);
      }
      if (options.stagedRoot && !samePath(config.projectDir, options.stagedRoot)) {
        throw new Error(`GET ${HYPERFRAMES_STUDIO_CONFIG_PATH} returned a project outside the disposable workspace.`);
      }
      const shell = await requestText(port, '/');
      assertStudioTextResponse(shell, '/', /<html|<div[^>]+id=["']root["']|HyperFrames/i, 'Studio app shell');
      const runtimeScript = await requestText(port, '/api/runtime.js');
      assertStudioTextResponse(runtimeScript, '/api/runtime.js', /window\.__timelines|hyperframes|runtime/i, 'Studio runtime script');
      return config;
    } catch (error) {
      lastProbe = error?.message || String(error || 'readiness request failed');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(buildStudioReadinessFailureMessage('HyperFrames Studio did not become ready in time.', {
    childExited: false,
    exitCode: child.exitCode,
    lastProbe,
    port,
    signalCode: child.signalCode,
    stderr: typeof options.stderr === 'function' ? options.stderr() : options.stderr,
    stdout: typeof options.stdout === 'function' ? options.stdout() : options.stdout,
  }));
}
function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function runStudioProjectPreflight(paths, runtime, stagedRoot, sourceRoot = '') {
  const lintRoot = path.join(path.dirname(stagedRoot), `.lint-${path.basename(stagedRoot)}`);
  try {
    await fs.remove(lintRoot).catch(() => null);
    await copyCompositionProjectSafely(stagedRoot, lintRoot, PROJECT_TREE_LIMITS);
    await inlineLocalScriptsForHyperFramesLint(lintRoot);
    const lintResult = await runHyperFramesCli(paths, runtime, ['lint', '--json', lintRoot], {
      allowFailure: true,
      cwd: lintRoot,
      errorMessage: 'Local AI Hub could not lint this HyperFrames project before opening Studio.',
      timeoutMs: 2 * 60 * 1000,
    });
    const lintSummary = buildCliSummary(lintResult, { managedRoot: paths.installDir, sourceRoot });
    if (Number(lintResult.code || 0) !== 0) {
      const error = new Error(buildHyperFramesLintFailureMessage(lintSummary));
      error.code = 'HYPERFRAMES_STUDIO_PROJECT_INVALID';
      error.hyperFramesLint = lintSummary;
      throw error;
    }
    return { lintSummary };
  } finally {
    await fs.remove(lintRoot).catch(() => null);
  }
}

function createHyperFramesStudioService(dependencies = {}) {
  const BrowserWindow = dependencies.BrowserWindow;
  const electronSession = dependencies.session;
  const spawnProcess = dependencies.spawn || spawn;
  if (!BrowserWindow || !electronSession) throw new Error('HyperFrames Studio requires Electron window and session controls.');

  let active = null;
  let status = { status: 'not-running', projectId: '', message: 'HyperFrames Studio is not running.' };

  function publicStatus() {
    return {
      status: status.status,
      projectId: String(status.projectId || ''),
      message: String(status.message || ''),
      contractVersion: HYPERFRAMES_STUDIO_CONTRACT_VERSION,
      warning: HYPERFRAMES_STUDIO_WARNING,
      networkNotice: HYPERFRAMES_STUDIO_NETWORK_NOTICE,
    };
  }

  async function stopActive(expectedProjectId, options = {}) {
    const current = active;
    if (!current) {
      status = { status: 'stopped', projectId: expectedProjectId || status.projectId || '', message: 'HyperFrames Studio is stopped.' };
      return publicStatus();
    }
    if (expectedProjectId && current.projectId !== expectedProjectId) {
      throw new Error('That project does not own the running HyperFrames Studio session.');
    }
    if (current.stopping) return publicStatus();
    current.stopping = true;
    if (current.child && current.child.exitCode === null && !current.child.signalCode) {
      try { current.child.kill('SIGTERM'); } catch {}
      await Promise.race([
        new Promise((resolve) => current.child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (current.child.exitCode === null && !current.child.signalCode) {
        await killProcessTree(current.child.pid).catch(() => null);
      }
    }
    if (!options.fromWindow && current.window && !current.window.isDestroyed()) current.window.destroy();
    await fs.remove(current.runRoot).catch(() => null);
    if (active === current) active = null;
    status = { status: 'stopped', projectId: current.projectId, message: 'HyperFrames Studio stopped cleanly.' };
    return publicStatus();
  }

  async function start(payload) {
    const projectId = assertProjectIdPayload(payload);
    if (active) {
      if (active.projectId === projectId && active.window && !active.window.isDestroyed()) {
        active.window.show();
        active.window.focus();
        return publicStatus();
      }
      throw new Error('Stop the running HyperFrames Studio session before opening another project.');
    }
    status = { status: 'starting', projectId, message: 'Starting the restricted HyperFrames Studio session...' };

    let child = null;
    let runRoot = '';
    let studioWindow = null;
    try {
      const prepared = await prepareHyperFramesProjectForPipeline(projectId);
      if (!prepared.project || !prepared.project.health || !prepared.project.health.runnable
        || !prepared.project.localAssetsOnly || !prepared.artifact.hyperFramesProject.trustedManagedProject) {
        throw new Error('This managed HyperFrames project did not pass the local-only Studio safety check.');
      }
      const sourceRoot = path.dirname(prepared.artifact.filePath);
      const paths = buildHyperFramesRuntimePaths();
      const packageReadiness = await verifyPinnedHyperFramesPackage(paths);
      if (!packageReadiness.ok) throw new Error(packageReadiness.error || 'Repair HyperFrames before opening Studio.');
      const runtime = await detectExternalNodeAndNpm();

      runRoot = path.join(paths.installDir, 'studio-sessions', Date.now() + '-' + crypto.randomBytes(6).toString('hex'));
      const stagedRoot = path.join(runRoot, projectId);
      assertPathInside(paths.installDir, runRoot, 'Local AI Hub refused to create Studio state outside managed HyperFrames storage.');
      await fs.ensureDir(runRoot);
      await assertRealPathInside(paths.installDir, runRoot, 'Local AI Hub refused a Studio folder that crosses a symlink or junction.');
      await assertNoReparsePointTraversal(paths.installDir, runRoot, 'Local AI Hub refused a Studio folder that crosses a symlink or junction.');
      await copyCompositionProjectSafely(sourceRoot, stagedRoot, PROJECT_TREE_LIMITS);
      await runStudioProjectPreflight(paths, runtime, stagedRoot, sourceRoot);

      const port = await allocateLoopbackPort();
      const processRoot = path.join(runRoot, 'process');
      const profileDir = path.join(processRoot, 'profile');
      const appDataDir = path.join(profileDir, 'AppData', 'Roaming');
      const localAppDataDir = path.join(profileDir, 'AppData', 'Local');
      const tempDir = path.join(processRoot, 'temp');
      const npmCacheDir = path.join(processRoot, 'npm-cache');
      await Promise.all([profileDir, appDataDir, localAppDataDir, tempDir, npmCacheDir].map((target) => fs.ensureDir(target)));
      const homeParts = getHomeDriveAndPath(profileDir);
      const env = buildHyperFramesChildProcessEnv(paths, runtime, { env: {
        HYPERFRAMES_NO_TELEMETRY: '1',
        DO_NOT_TRACK: '1',
        NO_UPDATE_NOTIFIER: '1',
        HYPERFRAMES_PREVIEW_HOST: HYPERFRAMES_STUDIO_HOST,
        VITE_STUDIO_ENABLE_PREVIEW_MANUAL_DRAGGING: '0',
        VITE_STUDIO_ENABLE_INSPECTOR_PANELS: '0',
        VITE_STUDIO_ENABLE_BLOCKS_PANEL: '0',
        VITE_STUDIO_ENABLE_GSAP_PANEL: '0',
        VITE_STUDIO_ENABLE_KEYFRAMES: '0',
        VITE_STUDIO_ENABLE_RAZOR_TOOL: '0',
        VITE_STUDIO_ENABLE_STORYBOARD: '0',
      } });
      Object.assign(env, {
        USERPROFILE: profileDir,
        HOME: profileDir,
        HOMEDRIVE: homeParts.HOMEDRIVE,
        HOMEPATH: homeParts.HOMEPATH,
        APPDATA: appDataDir,
        LOCALAPPDATA: localAppDataDir,
        TEMP: tempDir,
        TMP: tempDir,
        npm_config_cache: npmCacheDir,
      });

      const args = [getHyperFramesCliPath(paths), 'preview', stagedRoot, '--port', String(port), '--no-open', '--force-new'];
      child = spawnProcess(runtime.nodePath, args, { cwd: stagedRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout && child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-MAX_CAPTURED_LOG_CHARS); });
      child.stderr && child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-MAX_CAPTURED_LOG_CHARS); });

      const config = await waitForStudioReady(port, child, { projectName: path.basename(stagedRoot), stagedRoot, stdout: () => stdout, stderr: () => stderr });
      if (!samePath(config.projectDir, stagedRoot)) {
        throw new Error('HyperFrames Studio resolved a project outside its approved disposable workspace.');
      }

      const partition = 'hyperframes-studio-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
      const isolatedSession = electronSession.fromPartition(partition, { cache: false });
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolatedSession.setPermissionCheckHandler(() => false);
      isolatedSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
        const decision = evaluateStudioRequest(details, { port, projectName: path.basename(stagedRoot) });
        callback({ cancel: !decision.allowed });
      });

      studioWindow = new BrowserWindow({
        title: 'HyperFrames Studio (Experimental)',
        show: false,
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 620,
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          partition,
        },
      });
      studioWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const preventExternalNavigation = (event, targetUrl) => {
        try {
          const target = new URL(targetUrl);
          if (target.protocol !== 'http:' || target.hostname !== HYPERFRAMES_STUDIO_HOST || target.port !== String(port)) event.preventDefault();
        } catch {
          event.preventDefault();
        }
      };
      studioWindow.webContents.on('will-navigate', preventExternalNavigation);
      studioWindow.webContents.on('will-redirect', preventExternalNavigation);

      const current = { child, projectId, runRoot, session: isolatedSession, stopping: false, window: studioWindow };
      active = current;
      child.once('exit', () => {
        if (active !== current || current.stopping) return;
        active = null;
        status = { status: 'failed', projectId: current.projectId, message: 'HyperFrames Studio stopped unexpectedly. Repair HyperFrames and try again.' };
        fs.remove(current.runRoot).catch(() => null);
        if (current.window && !current.window.isDestroyed()) current.window.destroy();
      });
      studioWindow.once('closed', () => {
        if (active === current && !current.stopping) stopActive(current.projectId, { fromWindow: true }).catch(() => null);
      });

      const studioUrl = 'http://' + HYPERFRAMES_STUDIO_HOST + ':' + port + '/#project/' + encodeURIComponent(path.basename(stagedRoot));
      await studioWindow.loadURL(studioUrl);
      studioWindow.show();
      studioWindow.focus();
      status = { status: 'running', projectId, message: 'HyperFrames Studio is running in a restricted local-only window.' };
      return publicStatus();
    } catch (error) {
      if (active) active.stopping = true;
      active = null;
      if (studioWindow && !studioWindow.isDestroyed()) studioWindow.destroy();
      if (child && child.exitCode === null && !child.signalCode) {
        try { child.kill('SIGTERM'); } catch {}
        await killProcessTree(child.pid).catch(() => null);
      }
      if (runRoot) await fs.remove(runRoot).catch(() => null);
      active = null;
      status = { status: 'failed', projectId, message: error && error.message || 'Local AI Hub could not start the restricted HyperFrames Studio session.' };
      throw error;
    }
  }

  return {
    dispose: () => stopActive(''),
    getStatus: () => publicStatus(),
    start,
    stop: (payload) => stopActive(assertProjectIdPayload(payload)),
  };
}

module.exports = {
  BLOCKED_ENDPOINT_PREFIXES,
  HYPERFRAMES_STUDIO_CONTRACT_VERSION,
  HYPERFRAMES_STUDIO_HOST,
  HYPERFRAMES_STUDIO_CONFIG_PATH,
  HYPERFRAMES_STUDIO_NETWORK_NOTICE,
  HYPERFRAMES_STUDIO_WARNING,
  STUDIO_READINESS_TIMEOUT_MS,
  assertProjectIdPayload,
  createHyperFramesStudioService,
  buildStudioReadinessFailureMessage,
  evaluateStudioRequest,
  isAllowedStudioReadPath,
  requestJson,
  requestText,
  runStudioProjectPreflight,
  sanitizeStudioLogText,
  waitForStudioReady,
};
