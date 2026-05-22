const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'electron', 'config', 'tools-manifest.json');
const processServicePath = path.join(repoRoot, 'electron', 'services', 'processService.js');
const installerServicePath = path.join(repoRoot, 'electron', 'services', 'installerService.js');
const runtimeRecoveryPath = path.join(repoRoot, 'electron', 'services', 'runtimeRecoveryService.js');
const localVideoServicePath = path.join(repoRoot, 'electron', 'services', 'localVideoService.js');
const wanHelperPath = path.join(repoRoot, 'electron', 'helpers', 'run_wan_pipeline_task.py');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

const manifest = JSON.parse(read(manifestPath));
const wan = manifest.find((entry) => entry && entry.id === 'wan21-webui');
assert.ok(wan, 'Wan manifest entry should exist.');
assert.match(wan.launchCommand, /^python gradio\/t2v_1\.3B_singleGPU\.py --ckpt_dir models\/Wan-AI\/Wan2\.1-T2V-1\.3B$/, 'Wan Library launch command should target the managed T2V 1.3B model folder.');
assert.equal(wan.defaultPort, 7860, 'Wan should keep its upstream Gradio port.');
assert.equal(wan.healthCheckPath, '/', 'Wan readiness should probe the HTTP UI root, not process existence.');
assert.equal(wan.modelManager?.targetLayout?.directories?.Video, 'models/Wan-AI', 'Wan model downloads should land under models/Wan-AI.');

const processSource = read(processServicePath);
assert.match(processSource, /assertWanLibraryLaunchReadiness/, 'Wan launch should run a prerequisite preflight before spawning.');
assert.match(processSource, /inspectWanLibraryLaunchReadiness/, 'Wan launch readiness preflight should be testable.');
assert.match(processSource, /WAN_LIBRARY_MODEL_RELATIVE_PATH/, 'Wan launch should look for the managed model folder.');
assert.match(processSource, /waitForToolReady\(toolState/, 'Managed readiness should still use URL probing.');
assert.match(processSource, /probeUrl\(toolState\.healthUrl \|\| toolState\.launchUrl\)/, 'Readiness should probe the configured URL instead of trusting process existence.');
assert.match(processSource, /ensureWanManagedLaunchProfile/, 'Existing Wan installs should receive the corrected --ckpt_dir launch arg.');

const installerSource = read(installerServicePath);
assert.match(installerSource, /verifyWanManagedRuntimeReadiness/, 'Wan install and repair should verify the runtime.');
assert.match(installerSource, /buildWanDependencyVerificationScript/, 'Wan install and repair should include a dependency probe.');
assert.match(installerSource, /diffsynth/, 'Wan dependency probe should check DiffSynth.');
assert.match(installerSource, /torch\.cuda\.is_available\(\)/, 'Wan dependency probe should verify CUDA-backed PyTorch.');
assert.match(installerSource, /verifyWanManagedRuntimeReadiness\(safeToolState, manifest, logger\)/, 'Managed repair should fail if Wan remains unusable.');

const localVideoSource = read(localVideoServicePath);
assert.match(localVideoSource, /runWanLocalVideoTask/, 'Wan should remain available through the direct local video helper.');
assert.match(localVideoSource, /run_wan_pipeline_task\.py/, 'Wan pipeline execution should keep using the helper runtime path.');
assert.ok(fs.existsSync(wanHelperPath), 'Wan helper should exist.');

const { diagnoseLaunchFailure } = require(runtimeRecoveryPath);
const toolState = { id: 'wan21-webui', name: 'Wan2.1 WebUI' };
assert.equal(
  diagnoseLaunchFailure(toolState, "ModuleNotFoundError: No module named 'diffsynth'", {}).id,
  'wan-missing-diffsynth',
  'Wan missing DiffSynth should classify before generic missing-module repair.',
);
assert.equal(
  diagnoseLaunchFailure(toolState, 'ValueError: DASH_API_KEY is not set', {}).id,
  'wan-dashscope-api-key',
  'Wan DashScope prompt extension errors should be actionable.',
);
assert.equal(
  diagnoseLaunchFailure(toolState, 'FileNotFoundError: models/Wan-AI/Wan2.1-T2V-1.3B missing diffusion_pytorch_model.safetensors', {}).id,
  'wan-missing-model-assets',
  'Wan missing model folders should not collapse into a generic launch failure.',
);
assert.equal(
  diagnoseLaunchFailure(toolState, 'torch.cuda.OutOfMemoryError: CUDA out of memory', {}).id,
  'wan-insufficient-vram',
  'Wan GPU memory failures should be reported as hardware limits.',
);
assert.equal(
  diagnoseLaunchFailure(toolState, 'QwenPromptExpander failed while AutoModelForCausalLM.from_pretrained loaded Qwen2.5', {}).id,
  'wan-prompt-expander-unavailable',
  'Wan prompt-expander startup failures should be classified before generic readiness failure.',
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localaihub-wan-verify-'));
const fakeElectronRoot = path.join(tempRoot, 'electron-user-data');
const appDir = path.join(tempRoot, 'app');
fs.mkdirSync(appDir, { recursive: true });

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getName: () => 'Local AI Hub',
        getPath: () => fakeElectronRoot,
        isPackaged: false,
        on: () => {},
      },
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const processService = require(processServicePath);
    const readiness = await processService.__testing.inspectWanLibraryLaunchReadiness(
      { id: 'wan21-webui', name: 'Wan2.1 WebUI', appDir, installDir: tempRoot },
      { detectHardware: false, hardware: { gpuModel: 'NVIDIA GeForce GTX 1060 6GB', vramMb: 6144, systemRamMb: 16384 } },
    );
    assert.equal(readiness.ok, false, 'Wan Library preflight should fail on missing models and low VRAM.');
    assert.match(readiness.message, /models[\\/]Wan-AI[\\/]Wan2\.1-T2V-1\.3B/, 'Preflight should name the missing model folder.');
    assert.match(readiness.message, /GTX 1060/, 'Preflight should include detected GPU context.');
    assert.match(readiness.message, /instead of waiting on a generic startup timeout/, 'Preflight should replace the generic readiness timeout.');

    const normalized = processService.__testing.ensureWanManagedLaunchProfile(
      { id: 'wan21-webui' },
      { kind: 'python-script', target: 'gradio\\t2v_1.3B_singleGPU.py', args: [] },
    );
    assert.deepEqual(
      normalized.args.slice(-2),
      ['--ckpt_dir', path.join('models', 'Wan-AI', 'Wan2.1-T2V-1.3B')],
      'Wan launch profile should add the managed checkpoint directory for existing installs.',
    );

    fs.mkdirSync(path.join(appDir, 'models', 'Wan-AI', 'Wan2.1-T2V-1.3B'), { recursive: true });
    const ready = await processService.__testing.inspectWanLibraryLaunchReadiness(
      { id: 'wan21-webui', name: 'Wan2.1 WebUI', appDir, installDir: tempRoot },
      { detectHardware: false, hardware: { gpuModel: 'RTX 4090', vramMb: 24576, systemRamMb: 65536 } },
    );
    assert.equal(ready.ok, true, 'Wan Library preflight should pass when model folder and hardware floor are present.');

    console.log('Wan launch/readiness verifier passed.');
  } finally {
    Module._load = originalLoad;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
