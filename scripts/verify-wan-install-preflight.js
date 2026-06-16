const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const manifest = require(path.join(repoRoot, 'electron', 'config', 'tools-manifest.json'));
const installerSource = fs.readFileSync(path.join(repoRoot, 'electron', 'services', 'installerService.js'), 'utf8');
const helperSource = fs.readFileSync(path.join(repoRoot, 'electron', 'helpers', 'run_wan_pipeline_task.py'), 'utf8');
const pipelineSchemaSource = fs.readFileSync(path.join(repoRoot, 'electron', 'shared', 'pipelineSchema.cjs'), 'utf8');
const { buildManagedLaunchProfile } = require(path.join(repoRoot, 'electron', 'services', 'toolRegistry'));

const wan = manifest.find((entry) => entry.id === 'wan21-webui');
assert(wan, 'Wan2.1 WebUI must stay declared in the Store manifest.');

const wanLaunchCommand = String(wan.launchCommand || '');
assert.strictEqual(wanLaunchCommand, 'python gradio/t2v_1.3B_singleGPU.py --ckpt_dir models/Wan-AI/Wan2.1-T2V-1.3B', 'Wan managed launch command should target the real upstream 1.3B Gradio entrypoint and managed model folder.');
assert(!wanLaunchCommand.includes('gradio/app.py'), 'Wan managed launch command must not point to the stale gradio/app.py entrypoint.');
assert(!/--server-(name|port)/.test(wanLaunchCommand), 'Wan t2v Gradio launcher does not accept server-name/server-port flags.');
assert((wan.discovery?.markerPaths || []).includes('gradio\\t2v_1.3B_singleGPU.py'), 'Wan discovery markers should include the launcher that exists in the current upstream archive.');
assert(!(wan.discovery?.markerPaths || []).includes('gradio\\app.py'), 'Wan discovery markers must not require the stale gradio/app.py entrypoint.');
assert(!(wan.detectionPaths || []).some((entry) => /gradio\\app\.py/i.test(entry)), 'Wan external detection paths must not point to the stale gradio/app.py entrypoint.');

const sampleLaunchProfile = buildManagedLaunchProfile({
  appDir: path.join('D:', 'LocalAIHub', 'tools', 'wan21-webui', 'app'),
  installDir: path.join('D:', 'LocalAIHub', 'tools', 'wan21-webui'),
  venvDir: path.join('D:', 'LocalAIHub', 'tools', 'wan21-webui', '.venv'),
}, wan);
assert.strictEqual(sampleLaunchProfile.kind, 'python-script', 'Wan should register as a Python script launcher.');
assert.strictEqual(sampleLaunchProfile.target, 'gradio/t2v_1.3B_singleGPU.py', 'Wan launch profile should validate the actual upstream Gradio script.');
assert.deepStrictEqual(sampleLaunchProfile.args, ['--ckpt_dir', 'models/Wan-AI/Wan2.1-T2V-1.3B'], 'Wan launch profile should pass the managed checkpoint directory without unsupported Gradio server arguments.');

const installs = wan.installInstructions.pipInstalls || [];
const flashAttn = installs.find((entry) => entry.value === 'flash_attn');
assert(flashAttn, 'Wan2.1 should keep a flash_attn install step so machines with the CUDA Toolkit can use it.');
assert.strictEqual(flashAttn.optional, true, 'flash_attn must be optional, not an install blocker.');
assert.strictEqual(flashAttn.requiresCudaToolkit, true, 'flash_attn should be the only Wan step gated on the CUDA Toolkit/nvcc.');
assert(/fallback/i.test(flashAttn.optionalFailureMessage || ''), 'The optional flash_attn warning should mention fallback behavior.');

assert(installs.some((entry) => entry.value === 'diffsynth'), 'Wan2.1 install must include the DiffSynth runtime used by the Local AI Hub Wan adapter.');
assert(installs.some((entry) => entry.kind === 'requirements' && (entry.excludePatterns || []).some((pattern) => /flash_attn/.test(pattern))), 'Wan requirements should exclude flash_attn so the optional step owns that dependency.');
assert(!(wan.installInstructions.preflightChecks || []).some((entry) => entry.kind === 'cuda-toolkit'), 'Wan install must not hard-block at preflight solely because nvcc/CUDA_HOME is missing.');

assert(installerSource.includes('Skipping optional dependency because the CUDA Toolkit is not available.'), 'Installer must skip optional CUDA Toolkit dependencies when nvcc is missing.');
assert(installerSource.includes('Dependency step confirmed a usable CUDA toolkit.'), 'Installer must attempt CUDA Toolkit-gated optional dependencies when nvcc is present.');
assert(installerSource.includes('repairNotes.push(...optionalInstallWarnings)'), 'Repair must surface the same optional dependency warning policy as install.');
assert(installerSource.includes('installActionMessage'), 'Install success should surface optional dependency warnings to the UI toast.');
assert(installerSource.includes('buildManagedLauncherValidationFailureMessage'), 'Installer should provide a specific launcher validation failure instead of a generic missing-launcher message.');
assert(installerSource.includes('expected launch script was not found'), 'Installer launcher validation should name the missing expected script.');
const wanInstallVerifyIndex = installerSource.indexOf('await verifyManagedToolInstall(toolState, manifest, logger)');
const wanInstallUpsertIndex = installerSource.indexOf('await upsertTool(verifiedToolState)', wanInstallVerifyIndex);
assert(wanInstallVerifyIndex !== -1 && wanInstallUpsertIndex > wanInstallVerifyIndex, 'Managed installs must validate the launcher before marking a tool installed.');

assert(helperSource.includes('missing the DiffSynth runtime'), 'Wan runtime helper must distinguish missing DiffSynth from CUDA or model availability.');
assert(helperSource.includes('CUDA-enabled PyTorch runtime'), 'Wan runtime helper must distinguish NVIDIA driver/CUDA runtime from CUDA Toolkit/nvcc.');
assert(helperSource.includes('12 GB or more'), 'Wan runtime helper must block clearly on below-target VRAM instead of pretending GTX 1060-class hardware is practical.');
assert(pipelineSchemaSource.includes('CUDA Toolkit/nvcc is only relevant to optional acceleration packages such as flash_attn'), 'Pipeline readiness should describe CUDA Toolkit/nvcc as optional acceleration, not an install requirement.');
assert(pipelineSchemaSource.includes('models\\\\Wan-AI'), 'Pipeline readiness should continue to report missing Wan model folders separately.');

const nonWanToolsWithCudaPreflight = manifest
  .filter((entry) => entry.id !== 'wan21-webui')
  .filter((entry) => (entry.installInstructions?.preflightChecks || []).some((check) => check.kind === 'cuda-toolkit'))
  .map((entry) => entry.id);
assert.deepStrictEqual(nonWanToolsWithCudaPreflight, [], 'No unrelated Store tool should gain a CUDA Toolkit preflight from the Wan fix.');

console.log('Wan install preflight verifier passed.');