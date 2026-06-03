const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-comfyui-cuda-install');
const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'home' || name === 'appData') return TEST_STORAGE_ROOT;
          if (name === 'exe') return process.execPath;
          return process.cwd();
        },
        getVersion() {
          return '0.40.0-test';
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

const installerService = require('../electron/services/installerService');
const runtimeRecoveryService = require('../electron/services/runtimeRecoveryService');

async function main() {
  await fs.remove(TEST_STORAGE_ROOT);

  const manifest = await fs.readJson(path.join(process.cwd(), 'electron', 'config', 'tools-manifest.json'));
  const comfyui = manifest.find((tool) => tool.id === 'comfyui');
  assert(comfyui, 'ComfyUI manifest entry should exist.');
  assert(comfyui.companionDesktop, 'ComfyUI Desktop companion should remain separate from managed WebUI install.');

  const requirementsStep = comfyui.installInstructions.pipInstalls.find((step) => step.kind === 'requirements' && step.value === 'requirements.txt');
  assert(requirementsStep, 'ComfyUI WebUI should install upstream requirements through a filterable requirements step.');
  for (const pattern of ['^torch\\b', '^torchvision\\b', '^torchaudio\\b']) {
    assert(requirementsStep.excludePatterns.includes(pattern), `ComfyUI requirements filtering should exclude ${pattern}.`);
  }

  const appDir = path.join(TEST_STORAGE_ROOT, 'tools', 'comfyui', 'app');
  const installDir = path.join(TEST_STORAGE_ROOT, 'tools', 'comfyui');
  await fs.ensureDir(appDir);
  const requirementsPath = path.join(appDir, 'requirements.txt');
  await fs.writeFile(
    requirementsPath,
    [
      '# upstream requirements',
      'torch',
      'torchvision==0.27.0',
      'torchaudio; platform_system == "Windows"',
      'numpy>=1.25',
      '',
    ].join('\n'),
    'utf8',
  );

  const filteredPath = await installerService._test.buildFilteredRequirementsPath(
    { appDir, installDir },
    requirementsPath,
    requirementsStep,
    { warn: async () => {} },
    0,
  );
  const filtered = await fs.readFile(filteredPath, 'utf8');
  assert(!/^torch\b/im.test(filtered), 'Filtered ComfyUI requirements should remove torch.');
  assert(!/^torchvision\b/im.test(filtered), 'Filtered ComfyUI requirements should remove torchvision.');
  assert(!/^torchaudio\b/im.test(filtered), 'Filtered ComfyUI requirements should remove torchaudio.');
  assert(/^numpy>=1\.25/im.test(filtered), 'Filtered ComfyUI requirements should keep unrelated dependencies.');

  const gtx1060 = {
    gpuModel: 'NVIDIA GeForce GTX 1060 6GB',
    gpuVendor: 'NVIDIA',
    nvidiaCudaVersion: '13.0',
    nvidiaSmiAvailable: true,
  };
  const selectedBuild = installerService._test.selectManagedCudaPyTorchBuild(gtx1060);
  assert.strictEqual(selectedBuild.channel, 'cu124', 'GTX 1060-class systems with current drivers should use the CUDA 12.4 PyTorch wheel lane.');
  assert.strictEqual(installerService._test.buildManagedCudaPyTorchPackageSpec(selectedBuild, 'torch'), 'torch==2.6.0+cu124', 'ComfyUI should install an explicit CUDA torch wheel.');
  assert.strictEqual(installerService._test.buildManagedCudaPyTorchPackageSpec(selectedBuild, 'torchvision'), 'torchvision==0.21.0+cu124', 'ComfyUI should install an explicit CUDA torchvision wheel.');
  assert.strictEqual(installerService._test.buildManagedCudaPyTorchPackageSpec(selectedBuild, 'torchaudio'), 'torchaudio==2.6.0+cu124', 'ComfyUI should install an explicit CUDA torchaudio wheel.');
  assert.strictEqual(installerService._test.selectManagedCudaPyTorchBuild({ ...gtx1060, nvidiaCudaVersion: '12.1' }).channel, 'cu121', 'Older supported drivers should fall back to CUDA 12.1 wheels.');
  assert.strictEqual(installerService._test.selectManagedCudaPyTorchBuild({ ...gtx1060, nvidiaCudaVersion: '11.7' }), null, 'Drivers below the supported CUDA wheel floor should fail clearly.');

  const verificationScript = installerService._test.buildComfyUiDependencyVerificationScript();
  assert(verificationScript.includes('torch.cuda.is_available()'), 'ComfyUI verifier should require CUDA availability.');
  assert(verificationScript.includes('version", None), "cuda"'), 'ComfyUI verifier should inspect torch.version.cuda.');
  assert(verificationScript.includes('torchaudio'), 'ComfyUI verifier should import torchaudio.');
  assert(verificationScript.includes('torchvision'), 'ComfyUI verifier should import torchvision.');
  assert(installerService._test.buildComfyUiDependencyFailureMessage({ torchVersion: '2.12.0+cpu', cudaVersion: '', cudaAvailable: false }).includes('CPU-only PyTorch'), 'CPU-only ComfyUI torch should be rejected plainly.');
  assert(installerService._test.buildManagedCudaPyTorchUnsupportedMessage(comfyui, { ...gtx1060, nvidiaCudaVersion: '11.7' }).includes('Update the NVIDIA driver'), 'Unsupported CUDA runtime should produce driver guidance.');

  const installerSource = await fs.readFile(path.join(process.cwd(), 'electron', 'services', 'installerService.js'), 'utf8');
  assert(installerSource.includes("MANAGED_CUDA_PYTORCH_INSTALL_TOOL_IDS = new Set(['comfyui'])"), 'Managed CUDA PyTorch install should remain scoped to ComfyUI WebUI.');
  assert(installerSource.includes("buildManagedCudaPyTorchPackageSpec(build, 'torch')"), 'ComfyUI install/repair should explicitly install CUDA torch wheels.');
  assert(installerSource.includes("buildManagedCudaPyTorchPackageSpec(build, 'torchvision')"), 'ComfyUI install/repair should explicitly install CUDA torchvision wheels.');
  assert(installerSource.includes("buildManagedCudaPyTorchPackageSpec(build, 'torchaudio')"), 'ComfyUI install/repair should explicitly install CUDA torchaudio wheels.');
  assert(installerSource.includes('updatedState = await verifyManagedToolInstall(updatedState, manifest, logger)'), 'Managed Python update should run the same launch-readiness verification as install and repair.');
  assert(installerSource.includes('runManagedPipCheck(safeToolState, manifest, logger)'), 'pip check should run through the ComfyUI-aware dependency validation wrapper.');
  assert(installerSource.includes('allowFailure: true') && installerSource.includes('pip check reported ComfyUI dependency warnings'), 'ComfyUI pip check warnings should not override CUDA launch-readiness validation.');

  const runtimeCandidates = runtimeRecoveryService.selectPyTorchRepairCandidates(gtx1060);
  assert.strictEqual(runtimeCandidates[0].channel, 'cu124', 'Runtime repair should use the same CUDA 12.4-first policy.');
  assert.strictEqual(runtimeRecoveryService.buildPyTorchRepairPackageSpec(runtimeCandidates[0], 'torch'), 'torch==2.6.0+cu124', 'Runtime repair should reinstall explicit CUDA torch wheels.');

  const cpuDiagnosis = runtimeRecoveryService.diagnoseLaunchFailure({ id: 'comfyui', name: 'ComfyUI' }, 'ComfyUI is using a CPU-only PyTorch build instead of an NVIDIA CUDA build.', gtx1060);
  assert.strictEqual(cpuDiagnosis.action, 'repair-pytorch-cuda', 'CPU-only ComfyUI launch failures should trigger CUDA PyTorch repair.');
  const driverDiagnosis = runtimeRecoveryService.diagnoseLaunchFailure({ id: 'comfyui', name: 'ComfyUI' }, 'CUDA driver version is insufficient for CUDA runtime version', gtx1060);
  assert.strictEqual(driverDiagnosis.id, 'nvidia-driver-too-old-for-torch', 'Driver/CUDA runtime mismatch should be classified clearly.');

  assert(!installerSource.includes('comfyui-desktop') && comfyui.companionDesktop.installInstructions.kind === 'installer-exe', 'ComfyUI Desktop companion behavior should stay on the official installer path.');

  console.log('ComfyUI CUDA install verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
