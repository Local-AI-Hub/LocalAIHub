const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-triposr-launch-readiness');
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
          return '0.34.0-test';
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

const manifestTools = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../electron/config/tools-manifest.json'), 'utf8'));
const triposrManifest = manifestTools.find((tool) => tool.id === 'triposr');
assert(triposrManifest, 'Expected TripoSR / Trellis to remain in the tool manifest.');

assert.strictEqual(triposrManifest.launchCommand, 'python gradio_app.py --port {port}', 'TripoSR launch should use the installed gradio_app.py --port argument.');
assert(!/--server-(name|port)\b/.test(triposrManifest.launchCommand), 'TripoSR gradio_app.py does not accept --server-name or --server-port.');
assert.strictEqual(triposrManifest.healthCheckPath, '/', 'TripoSR readiness should use the Gradio root endpoint.');

const pipInstalls = triposrManifest.installInstructions?.pipInstalls || [];
assert(pipInstalls.some((entry) => entry.kind === 'requirements' && entry.value === 'requirements.txt' && entry.excludePatterns?.includes('^git\\+https://github\\.com/tatsy/torchmcubes\\.git\\b')), 'TripoSR install should keep torchmcubes out of the bulk requirements pass.');
for (const pinnedPackage of ['fastapi==0.104.1', 'starlette==0.27.0', 'uvicorn==0.24.0.post1', 'pydantic==2.5.3']) {
  assert(pipInstalls.some((entry) => entry.kind === 'package' && entry.value === pinnedPackage), `TripoSR install/repair should pin ${pinnedPackage} for the Gradio web stack.`);
}
assert(pipInstalls.some((entry) => entry.kind === 'package' && /^onnxruntime>=1\.16,<2$/.test(entry.value)), 'TripoSR install/repair should explicitly install ONNX Runtime for rembg.');
assert(pipInstalls.some((entry) => entry.kind === 'package' && entry.value === 'git+https://github.com/tatsy/torchmcubes.git' && entry.pipArgs?.includes('--no-build-isolation')), 'TripoSR install/repair should build torchmcubes after PyTorch is installed.');

const managedToolState = {
  id: 'triposr',
  name: 'TripoSR / Trellis',
  source: 'managed',
  installDir: 'D:\\LocalAIHub\\tools\\triposr',
  appDir: 'D:\\LocalAIHub\\tools\\triposr\\app',
  venvDir: 'D:\\LocalAIHub\\tools\\triposr\\.venv',
};
const launchProfile = buildManagedLaunchProfile(managedToolState, triposrManifest);
assert.strictEqual(launchProfile.kind, 'python-script', 'TripoSR should launch as a managed Python script.');
assert.strictEqual(launchProfile.target, 'gradio_app.py', 'TripoSR launch target should use the installed gradio_app.py entrypoint.');
assert.deepStrictEqual(launchProfile.args, ['--port', '7860'], 'TripoSR launch args should match the installed argparse contract.');
assert(/triposr[\\/]app$/i.test(launchProfile.workingDir), 'TripoSR should launch with the app folder as its working directory.');

const missingOnnx = diagnoseLaunchFailure(
  { id: 'triposr', name: 'TripoSR / Trellis' },
  "ModuleNotFoundError: No module named 'onnxruntime'",
  {},
);
assert.strictEqual(missingOnnx.id, 'triposr-missing-onnxruntime', 'TripoSR missing ONNX Runtime should be classified before the generic missing-module diagnosis.');
assert.strictEqual(missingOnnx.action, 'repair-python-environment', 'TripoSR missing ONNX Runtime should route to managed repair.');
assert(/ONNX Runtime|background removal/i.test(missingOnnx.summary), 'TripoSR ONNX Runtime diagnosis should explain the dependency in plain English.');

const gradioStackMismatch = diagnoseLaunchFailure(
  { id: 'triposr', name: 'TripoSR / Trellis' },
  "AttributeError: 'FieldInfo' object has no attribute 'in_'",
  {},
);
assert.strictEqual(gradioStackMismatch.id, 'triposr-gradio-web-stack-mismatch', 'TripoSR Gradio web stack drift should be classified before a generic startup failure.');
assert.strictEqual(gradioStackMismatch.action, 'repair-python-environment', 'TripoSR Gradio web stack drift should route to managed repair.');
assert(/FastAPI|Starlette|Pydantic|Uvicorn/i.test(gradioStackMismatch.summary), 'TripoSR web stack diagnosis should name the pinned dependency set.');

const staleArgs = diagnoseLaunchFailure(
  { id: 'triposr', name: 'TripoSR / Trellis' },
  'gradio_app.py: error: unrecognized arguments: --server-name 127.0.0.1 --server-port 7860',
  {},
);
assert.strictEqual(staleArgs.id, 'unsupported-launch-arguments', 'TripoSR stale --server-name/--server-port failures should be classified before a generic readiness timeout.');
assert(staleArgs.summary.includes('--server-name'), 'Unsupported TripoSR launch args should be named in the message.');

const installerSource = fs.readFileSync(path.resolve(__dirname, '../electron/services/installerService.js'), 'utf8');
assert(installerSource.includes('verifyTripoSrManagedRuntimeReadiness'), 'Managed install/repair should verify TripoSR dependencies before reporting success.');
assert(installerSource.includes('["onnxruntime", "ONNX Runtime"]'), 'TripoSR install verification should check ONNX Runtime explicitly.');
assert(installerSource.includes('["torchmcubes", "torchmcubes"]'), 'TripoSR install verification should check the torchmcubes extension explicitly.');
assert(installerSource.includes('expected_versions = {"fastapi": "0.104.1", "starlette": "0.27.0", "uvicorn": "0.24.0.post1", "pydantic": "2.5.3"}'), 'TripoSR install verification should check the pinned Gradio web stack versions.');
assert(installerSource.includes('ONNX Runtime is still missing'), 'TripoSR repair should fail honestly when ONNX Runtime remains missing.');
assert(installerSource.includes('Gradio web server dependency versions are not compatible'), 'TripoSR repair should fail honestly when the web stack remains incompatible.');

console.log('TripoSR / Trellis launch/readiness verification passed.');