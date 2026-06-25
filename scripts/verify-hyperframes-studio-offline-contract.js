const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const {
  BLOCKED_ENDPOINT_PREFIXES,
  HYPERFRAMES_STUDIO_CONFIG_PATH,
  HYPERFRAMES_STUDIO_CONTRACT_VERSION,
  HYPERFRAMES_STUDIO_HOST,
  STUDIO_READINESS_TIMEOUT_MS,
  assertProjectIdPayload,
  buildStudioReadinessFailureMessage,
  evaluateStudioRequest,
  isAllowedStudioReadPath,
  waitForStudioReady,
} = require('../electron/services/hyperFramesStudioService');

const root = path.resolve(__dirname, '..');
const serviceSource = fs.readFileSync(path.join(root, 'electron', 'services', 'hyperFramesStudioService.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'src', 'components', 'HyperFramesProjectManager.jsx'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function decision(url, method = 'GET') {
  return evaluateStudioRequest({ method, url }, { port: 45678, projectName: 'managed-project' });
}

function createReadinessServer(projectDir) {
  const server = http.createServer((request, response) => {
    if (request.url === HYPERFRAMES_STUDIO_CONFIG_PATH) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        isHyperframes: true,
        projectName: 'managed-project',
        projectDir,
        serverBuildSignature: 'controlled-verifier',
        version: '0.6.112',
      }));
      return;
    }
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><div id="root">HyperFrames</div></body></html>');
      return;
    }
    if (request.url === '/api/runtime.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('window.__timelines = window.__timelines || {};');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HYPERFRAMES_STUDIO_HOST, () => resolve(server));
  });
}

async function assertControlledReadiness() {
  const stagedRoot = path.join(root, 'temp', 'studio-readiness-controlled', 'managed-project');
  const server = await createReadinessServer(stagedRoot);
  try {
    const port = server.address().port;
    const config = await waitForStudioReady(port, { exitCode: null, signalCode: null }, {
      projectName: 'managed-project',
      stagedRoot,
      timeoutMs: 5000,
    });
    assert.strictEqual(config.isHyperframes, true, 'controlled readiness returns HyperFrames config');
    assert.strictEqual(config.projectName, 'managed-project', 'controlled readiness verifies project name');
    assert.strictEqual(path.resolve(config.projectDir).toLowerCase(), path.resolve(stagedRoot).toLowerCase(), 'controlled readiness verifies disposable project dir');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  assert.strictEqual(HYPERFRAMES_STUDIO_CONTRACT_VERSION, 1, 'Studio contract version is explicit');
  assert.strictEqual(HYPERFRAMES_STUDIO_HOST, '127.0.0.1', 'Studio binds to exact IPv4 loopback');
  assert.strictEqual(HYPERFRAMES_STUDIO_CONFIG_PATH, '/__hyperframes_config', 'readiness uses the installed HyperFrames Studio config route');
  assert.strictEqual(assertProjectIdPayload({ projectId: 'managed-project' }), 'managed-project');
  assert.throws(() => assertProjectIdPayload({}), /managed .*project/i, 'missing project ID fails safely');
  assert.throws(() => assertProjectIdPayload({ projectId: 'managed-project', port: 1234 }), /only a managed project ID/i);
  assert.throws(() => assertProjectIdPayload({ projectId: 'managed-project', path: 'D:\\outside' }), /only a managed project ID/i);
  assert.throws(() => assertProjectIdPayload('managed-project'), /managed .*project/i);

  assert.strictEqual(decision('http://127.0.0.1:45678/').allowed, true, 'exact Studio origin is allowed');
  assert.strictEqual(decision('http://127.0.0.1:45678/__hyperframes_config').allowed, true, 'installed Studio config route is allowed on exact origin');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/config').allowed, false, 'obsolete API config route is not part of the contract');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/runtime.js').allowed, true, 'Studio runtime script is readable');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/events').allowed, true, 'Studio event stream is readable');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project').allowed, true, 'selected project metadata is readable');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/files/index.html').allowed, true, 'selected project files are readable');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/preview/comp/index.html').allowed, true, 'selected project preview is readable');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/gsap-animations/script.js').allowed, true, 'selected project animation metadata reads are allowed');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/other-project').allowed, false, 'other project APIs are blocked');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/files/index.html', 'HEAD').allowed, true, 'project files allow HEAD for safe startup probes');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/files/index.html', 'PUT').allowed, false, 'project writes are blocked');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/upload', 'POST').allowed, false, 'uploads are blocked');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/registry/blocks').allowed, false, 'registry is blocked');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/render', 'POST').allowed, false, 'Studio render is blocked');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/renders').allowed, false, 'render history is blocked');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/thumbnail/index').allowed, false, 'thumbnail writers are blocked');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/waveform/audio').allowed, false, 'waveform cache writers are blocked');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/fonts/google').allowed, false, 'remote font helpers are blocked');
  assert.strictEqual(decision('http://127.0.0.1:45678/api/posthog/capture').allowed, false, 'local-proxied telemetry names are blocked');
  assert.strictEqual(decision('http://localhost:45678/').allowed, false, 'alternate host is blocked');
  assert.strictEqual(decision('http://0.0.0.0:45678/').allowed, false, 'wildcard binding target is blocked');
  assert.strictEqual(decision('http://127.0.0.1:45679/').allowed, false, 'unselected loopback ports are blocked');
  assert.strictEqual(decision('https://us.i.posthog.com/batch/').allowed, false, 'PostHog is blocked');
  assert.strictEqual(decision('https://cdn.jsdelivr.net/npm/gsap').allowed, false, 'CDN is blocked');
  assert.strictEqual(decision('https://fonts.googleapis.com/css').allowed, false, 'remote fonts are blocked');
  assert.strictEqual(isAllowedStudioReadPath('/api/projects/managed-project/storyboard', 'managed-project'), false);
  assert.strictEqual(decision('http://127.0.0.1:45678/api/projects/managed-project/files/%2e%2e/secret').allowed, false, 'encoded path traversal is blocked');
  assert(BLOCKED_ENDPOINT_PREFIXES.some((entry) => entry.includes('upload')), 'blocked endpoint inventory documents upload');
  assert(BLOCKED_ENDPOINT_PREFIXES.some((entry) => entry.includes('render')), 'blocked endpoint inventory documents render');
  assert.strictEqual(STUDIO_READINESS_TIMEOUT_MS, 60000, 'packaged Studio readiness timeout is bounded but long enough for installed app startup');
  const readinessMessage = buildStudioReadinessFailureMessage('HyperFrames Studio did not become ready in time.', { port: 45678, lastProbe: 'GET /__hyperframes_config returned HTTP 503.', childExited: false, stderr: 'token=secret\nD:\\Private\\User\\path\\studio.js failed', stdout: 'ready soon' });
  assert(readinessMessage.includes('Port: 45678'), 'readiness failure includes selected port');
  assert(readinessMessage.includes('GET /__hyperframes_config returned HTTP 503'), 'readiness failure includes last HTTP status/error');
  assert(readinessMessage.includes('Recent Studio output'), 'readiness failure includes recent Studio output');
  assert(!readinessMessage.includes('secret') && !readinessMessage.includes('D:\\Private'), 'readiness diagnostics sanitize secrets and private paths');

  await assertControlledReadiness();

  assert(serviceSource.includes('prepareHyperFramesProjectForPipeline(projectId)'), 'main resolves and validates a managed project');
  assert(serviceSource.includes('verifyPinnedHyperFramesPackage(paths)') && serviceSource.includes('getHyperFramesCliPath(paths)'), 'Studio resolves the pinned managed HyperFrames CLI path before launch');
  assert(serviceSource.includes("requestJson(port, HYPERFRAMES_STUDIO_CONFIG_PATH)"), 'readiness probes the installed Studio config route');
  assert(!serviceSource.includes("requestJson(port, '/api/config')"), 'readiness no longer probes the removed API config route');
  assert(serviceSource.includes("requestText(port, '/')") && serviceSource.includes("requestText(port, '/api/runtime.js')"), 'readiness verifies app shell and runtime script');
  assert(serviceSource.includes('runStudioProjectPreflight(paths, runtime, stagedRoot, sourceRoot)'), 'Studio lints the disposable project before starting readiness');
  assert(serviceSource.includes('HYPERFRAMES_STUDIO_PROJECT_INVALID'), 'Studio classifies lint failures as project invalid');
  assert(serviceSource.includes('buildHyperFramesLintFailureMessage'), 'Studio preflight surfaces lint details');
  assert(serviceSource.includes('buildStudioReadinessFailureMessage'), 'readiness timeout path includes actionable diagnostics');
  assert(serviceSource.includes('copyCompositionProjectSafely(sourceRoot, stagedRoot'), 'Studio receives a safe disposable project copy');
  assert(serviceSource.includes('assertNoReparsePointTraversal'), 'Studio workspace has reparse-point checks');
  assert(serviceSource.includes("HYPERFRAMES_PREVIEW_HOST: HYPERFRAMES_STUDIO_HOST"), 'child host is process-controlled');
  assert(serviceSource.includes("'--port', String(port), '--no-open', '--force-new'"), 'child uses a selected controlled port and fixed flags');
  assert(serviceSource.includes("APPDATA: appDataDir") && serviceSource.includes("LOCALAPPDATA: localAppDataDir"), 'AppData is process-scoped');
  assert(serviceSource.includes("HYPERFRAMES_NO_TELEMETRY: '1'") && serviceSource.includes("DO_NOT_TRACK: '1'"), 'process telemetry flags are set');
  assert(serviceSource.includes("urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']"), 'session filters local and remote requests');
  assert(serviceSource.includes('setPermissionRequestHandler') && serviceSource.includes('setPermissionCheckHandler'), 'permissions are denied');
  assert(serviceSource.includes('contextIsolation: true'), 'Studio window enables context isolation');
  assert(serviceSource.includes('nodeIntegration: false'), 'Studio window disables Node integration');
  assert(serviceSource.includes('sandbox: true') && serviceSource.includes('webSecurity: true'), 'Studio renderer remains sandboxed');
  assert(!/webPreferences:[\s\S]{0,300}preload\s*:/.test(serviceSource), 'Studio window exposes no preload');
  assert(serviceSource.includes("setWindowOpenHandler(() => ({ action: 'deny' }))"), 'popups are denied');
  assert(serviceSource.includes("webContents.on('will-navigate'") && serviceSource.includes("webContents.on('will-redirect'"), 'external navigation is denied');
  assert(serviceSource.includes("child.kill('SIGTERM')") && serviceSource.includes('killProcessTree'), 'Studio supports clean stop with process-tree fallback');
  assert(serviceSource.includes('fs.remove(current.runRoot)') && !serviceSource.includes('fs.remove(sourceRoot)'), 'cleanup targets only run-owned state');

  assert(mainSource.includes("ipcMain.handle('hyperframes-studio:status'"));
  assert(mainSource.includes("ipcMain.handle('hyperframes-studio:open'"));
  assert(mainSource.includes("ipcMain.handle('hyperframes-studio:stop'"));
  assert.strictEqual((mainSource.match(/hyperFramesStudioService\.start\(/g) || []).length, 1, 'Studio starts only through explicit IPC');
  assert(mainSource.includes('await hyperFramesStudioService.dispose()'), 'app shutdown disposes Studio');

  assert(preloadSource.includes("openHyperFramesStudio: (payload) => invoke('hyperframes-studio:open', payload)"));
  assert(preloadSource.includes("stopHyperFramesStudio: (payload) => invoke('hyperframes-studio:stop', payload)"));
  assert(preloadSource.includes("getHyperFramesStudioStatus: () => invoke('hyperframes-studio:status')"));
  assert(uiSource.includes('Open in HyperFrames Studio (Experimental)'));
  assert(uiSource.includes('Studio previews project HTML/CSS/JavaScript. Open only projects you trust.'));
  assert(uiSource.includes('Studio is restricted to Local AI Hub-managed HyperFrames projects. Remote network requests are blocked by Local AI Hub.'));
  assert(uiSource.includes("openHyperFramesStudio')({ projectId })"), 'renderer sends projectId only');
  assert(uiSource.includes("stopHyperFramesStudio')({ projectId })"), 'renderer stop sends projectId only');
  assert(!/<(?:iframe|webview)\b/i.test(uiSource), 'main renderer has no Studio iframe or webview');
  assert.strictEqual(packageJson.version, '0.54.0', 'Studio pass does not bump the app version');

  console.log('HyperFrames Studio offline/no-telemetry contract verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});