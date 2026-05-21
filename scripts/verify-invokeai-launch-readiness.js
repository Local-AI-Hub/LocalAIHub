const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-invokeai-launch-readiness');
process.env.APPDATA = path.join(TEST_STORAGE_ROOT, 'Roaming');
process.env.LOCALAPPDATA = path.join(TEST_STORAGE_ROOT, 'Local');
process.env.TEMP = path.join(TEST_STORAGE_ROOT, 'Temp');
process.env.TMP = process.env.TEMP;

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
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
        getVersion() {
          return '0.33.0-test';
        },
        isPackaged: false,
      },
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { buildManagedLaunchProfile } = require('../electron/services/toolRegistry');
const { diagnoseLaunchFailure } = require('../electron/services/runtimeRecoveryService');
const { __testing } = require('../electron/services/processService');

function main() {
  fs.rmSync(TEST_STORAGE_ROOT, { force: true, recursive: true });

  const manifestTools = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../electron/config/tools-manifest.json'), 'utf8'));
  const invokeManifest = manifestTools.find((tool) => tool.id === 'invokeai');
  assert(invokeManifest, 'Expected InvokeAI to remain in the tool manifest.');

  assert.strictEqual(invokeManifest.installInstructions.kind, 'pip-package', 'InvokeAI managed install/repair should use the packaged InvokeAI Python distribution.');
  assert.strictEqual(invokeManifest.installInstructions.pythonRequirement, '>=3.11,<3.13', 'InvokeAI should keep its supported Python requirement without needing a source pyproject checkout.');
  assert(invokeManifest.installInstructions.pipInstalls.some((entry) => entry.kind === 'package' && entry.value === 'invokeai'), 'InvokeAI install/repair should install the invokeai package.');
  assert(!/invokeai\.app\.run_app/i.test(invokeManifest.launchCommand), 'InvokeAI should not launch by importing invokeai.app.run_app as a module.');
  assert(/invokeai-web\.exe/i.test(invokeManifest.launchCommand), 'InvokeAI managed launch should use the invokeai-web console entrypoint.');
  assert(/--root\s+\.\./i.test(invokeManifest.launchCommand), 'InvokeAI managed launch should pass the managed tool root to InvokeAI.');
  assert(/--config\s+invokeai\.yaml/i.test(invokeManifest.launchCommand), 'InvokeAI managed launch should use a stable root-local invokeai.yaml config.');
  assert(!/--host\b|--port\b/i.test(invokeManifest.launchCommand), 'InvokeAI 6.x launch should not pass removed --host/--port CLI flags.');
  assert.strictEqual(invokeManifest.healthCheckPath, '/api/v1/app/version', 'InvokeAI readiness should use the stable app version API endpoint.');
  assert.strictEqual(invokeManifest.startupTimeoutMs, 240000, 'InvokeAI should have verifier-covered startup allowance for real first-launch initialization.');

  const managedToolState = {
    id: 'invokeai',
    name: 'InvokeAI',
    source: 'managed',
    installDir: 'D:\\LocalAIHub\\tools\\invokeai',
    appDir: 'D:\\LocalAIHub\\tools\\invokeai\\app',
    venvDir: 'D:\\LocalAIHub\\tools\\invokeai\\.venv',
  };
  const launchProfile = buildManagedLaunchProfile(managedToolState, invokeManifest);
  assert.strictEqual(launchProfile.kind, 'binary', 'InvokeAI managed launch should execute the console-script binary from its venv.');
  assert(/invokeai[\\/]\.venv[\\/]Scripts[\\/]invokeai-web\.exe$/i.test(launchProfile.executable), 'InvokeAI launch profile should resolve invokeai-web.exe inside the managed venv.');
  assert.deepStrictEqual(launchProfile.args, ['--root', '..', '--config', 'invokeai.yaml'], 'InvokeAI launch args should match the corrected root/config contract.');

  const unsupportedArgs = diagnoseLaunchFailure(
    { id: 'invokeai', name: 'InvokeAI' },
    'invokeai-web: error: unrecognized arguments: --host 127.0.0.1 --port 9090',
    {},
  );
  assert.strictEqual(unsupportedArgs.id, 'unsupported-launch-arguments', 'InvokeAI stale --host/--port failures should be classified before a generic readiness timeout.');
  assert(unsupportedArgs.summary.includes('--host'), 'Unsupported InvokeAI launch args should be named in the user-facing message.');

  const missingUi = diagnoseLaunchFailure(
    { id: 'invokeai', name: 'InvokeAI' },
    'No UI found at D:\\LocalAIHub\\tools\\invokeai\\.venv\\Lib\\site-packages\\invokeai\\frontend\\web/dist, skipping UI mount',
    {},
  );
  assert.strictEqual(missingUi.id, 'invokeai-missing-web-ui-assets', 'InvokeAI missing web UI assets should be classified specifically.');
  assert.strictEqual(missingUi.action, 'repair-python-environment', 'InvokeAI missing UI assets should point to managed Repair.');

  const staleModuleRuntime = {
    process: { exitCode: 0 },
    stdoutBuffer: '',
    stderrBuffer: '',
  };
  const staleMessage = __testing.buildConcreteLaunchFailureMessage(
    { id: 'invokeai', name: 'InvokeAI', launchUrl: 'http://127.0.0.1:9090', healthUrl: 'http://127.0.0.1:9090/api/v1/app/version', defaultPort: 9090 },
    staleModuleRuntime,
    'InvokeAI did not answer on http://127.0.0.1:9090/ before Local AI Hub\'s startup check finished.',
  );
  assert(/old InvokeAI launch entrypoint|invokeai-web/i.test(staleMessage), 'A clean InvokeAI exit before readiness should explain the stale entrypoint instead of only saying did not answer.');
  assert(!/^InvokeAI did not answer/.test(staleMessage), 'Specific InvokeAI launch classification should beat the generic did-not-answer message.');

  const postReadyMessage = __testing.buildPostReadyLaunchFailureMessage(
    { id: 'invokeai', name: 'InvokeAI' },
    { stdoutBuffer: '', stderrBuffer: 'No UI found at D:\\LocalAIHub\\tools\\invokeai\\.venv\\Lib\\site-packages\\invokeai\\frontend\\web/dist, skipping UI mount' },
  );
  assert(/web UI assets are missing/i.test(postReadyMessage), 'InvokeAI should not be marked Library-ready when its web UI assets are missing.');

  const rvcManifest = manifestTools.find((tool) => tool.id === 'rvc');
  assert(rvcManifest && /--noautoopen(?:\s|$)/.test(rvcManifest.launchCommand), 'RVC launch command should remain on the recently fixed no-auto-open path.');
  const faceFusionManifest = manifestTools.find((tool) => tool.id === 'facefusion');
  assert.strictEqual(faceFusionManifest?.launchEnvironment?.includeBundledFfmpeg, true, 'FaceFusion should still opt into the bundled FFmpeg launch environment.');
  const upscaylManifest = manifestTools.find((tool) => tool.id === 'upscayl');
  assert.strictEqual(upscaylManifest?.interfaceMode, 'desktop-app', 'Upscayl should remain a desktop-app launch.');

  console.log('InvokeAI launch/readiness verification passed.');
}

main();

