const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-managed-launch-storage');
process.env.APPDATA = path.join(TEST_STORAGE_ROOT, 'Roaming');
process.env.LOCALAPPDATA = path.join(TEST_STORAGE_ROOT, 'Local');
process.env.TEMP = 'C:\\Users\\Test\\AppData\\Local\\Temp';
process.env.TMP = process.env.TEMP;
process.env.LOCALAIHUB_TEST_SECRET = 'should-not-be-logged';

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
          return '0.23.0-test';
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

const { getAppPaths } = require('../electron/services/configService');
const {
  assessManagedLaunchStoragePressure,
  buildLaunchRuntimeEnv,
  buildManagedLaunchRuntimePaths,
  summarizeLaunchRuntimeEnv,
} = require('../electron/services/processService');

function disk(mount, freeGiB, sizeGiB = 100) {
  const size = sizeGiB * 1024 * 1024 * 1024;
  const free = freeGiB * 1024 * 1024 * 1024;
  return {
    mount,
    sizeBytes: size,
    usedBytes: size - free,
    freeBytes: free,
  };
}

async function main() {
  fs.rmSync(TEST_STORAGE_ROOT, { force: true, recursive: true });
  const appPaths = getAppPaths();
  const forgeTool = {
    id: 'forge',
    name: 'Stable Diffusion WebUI Forge',
    installDir: path.join(appPaths.toolsRoot, 'forge'),
    appDir: path.join(appPaths.toolsRoot, 'forge', 'app'),
    source: 'managed',
    managedByLocalAIHub: true,
    installInstructions: { runtime: 'python' },
    launchProfile: { kind: 'python-script' },
  };

  const paths = buildManagedLaunchRuntimePaths(forgeTool);
  assert.strictEqual(paths.tempRoot, path.join(appPaths.managedRoot, 'temp'), 'Managed temp root should be under the configured managed root.');
  assert.strictEqual(paths.cacheRoot, path.join(appPaths.managedRoot, 'cache'), 'Managed cache root should be under the configured managed root.');

  const env = await buildLaunchRuntimeEnv(forgeTool, { PYTHONUTF8: '1' }, { launchProfile: forgeTool.launchProfile });
  assert(env.TEMP.startsWith(paths.tempRoot), 'Library/shared launch env should put TEMP under managed temp.');
  assert(env.TMP.startsWith(paths.tempRoot), 'Library/shared launch env should put TMP under managed temp.');
  assert.strictEqual(env.HF_HOME, path.join(paths.cacheRoot, 'huggingface'), 'HF_HOME should use managed Hugging Face cache.');
  assert.strictEqual(env.HUGGINGFACE_HUB_CACHE, path.join(paths.cacheRoot, 'huggingface', 'hub'), 'Hugging Face Hub cache should be managed.');
  assert.strictEqual(env.TRANSFORMERS_CACHE, path.join(paths.cacheRoot, 'huggingface', 'transformers'), 'Transformers cache should be managed.');
  assert.strictEqual(env.TORCH_HOME, path.join(paths.cacheRoot, 'torch'), 'Torch cache should be managed.');
  assert.strictEqual(env.XDG_CACHE_HOME, path.join(paths.cacheRoot, 'xdg'), 'XDG cache should be managed.');
  assert.strictEqual(env.GRADIO_TEMP_DIR, path.join(paths.cacheRoot, 'gradio'), 'Gradio temp dir should be managed.');
  assert.strictEqual(env.MPLCONFIGDIR, path.join(paths.cacheRoot, 'matplotlib'), 'Matplotlib config dir should be managed.');

  const pipelineOrchestrationSource = fs.readFileSync(path.join(process.cwd(), 'electron/services/pipelineToolOrchestrationService.js'), 'utf8');
  assert(pipelineOrchestrationSource.includes('launchToolFromUserAction'), 'Pipeline-orchestrated tools should use the shared process launch boundary.');
  const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron/main.js'), 'utf8');
  assert(mainSource.includes('launchToolFromExplicitUserAction'), 'Library launches should use the shared explicit launch wrapper.');
  for (const helper of ['localAudioService.js', 'localImageService.js', 'localVideoService.js']) {
    const helperSource = fs.readFileSync(path.join(process.cwd(), 'electron/services', helper), 'utf8');
    assert(helperSource.includes('buildLaunchRuntimeEnv'), `${helper} should inherit the shared managed launch environment.`);
  }

  const overrideEnv = await buildLaunchRuntimeEnv({
    ...forgeTool,
    launchEnvironment: {
      setHuggingFaceCacheEnv: false,
      setTorchCacheEnv: false,
      unsetEnv: ['HF_HOME', 'TORCH_HOME'],
    },
  }, {}, { launchProfile: forgeTool.launchProfile });
  assert.strictEqual(overrideEnv.HF_HOME, undefined, 'Tool policy should be able to opt out of HF_HOME.');
  assert.strictEqual(overrideEnv.TORCH_HOME, undefined, 'Tool policy should be able to opt out of TORCH_HOME.');
  assert(overrideEnv.TEMP.startsWith(paths.tempRoot), 'Opting out of model caches should not disable managed TEMP by default.');

  const summary = summarizeLaunchRuntimeEnv({ ...env, OPENAI_API_KEY: 'secret', LOCALAIHUB_TEST_SECRET: 'secret' });
  assert(!Object.prototype.hasOwnProperty.call(summary, 'OPENAI_API_KEY'), 'Launch env diagnostics must not dump API keys.');
  assert(!Object.prototype.hasOwnProperty.call(summary, 'LOCALAIHUB_TEST_SECRET'), 'Launch env diagnostics must use a whitelist, not the full env.');


  const manifestTools = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'electron/config/tools-manifest.json'), 'utf8'));
  const rvcManifest = manifestTools.find((tool) => tool.id === 'rvc');
  assert(rvcManifest, 'RVC should remain present in the tool manifest.');
  const rvcRuntimeAssets = rvcManifest.installInstructions?.runtimeAssets || [];
  assert(rvcRuntimeAssets.some((asset) => asset.relativePath === 'assets/hubert/hubert_base.pt' && /huggingface\.co\/lj1995\/VoiceConversionWebUI\/resolve\/main\/hubert_base\.pt/.test(asset.url)), 'RVC install/repair should know how to restore assets/hubert/hubert_base.pt.');
  assert(rvcRuntimeAssets.some((asset) => asset.relativePath === 'assets/rmvpe/rmvpe.pt' && /huggingface\.co\/lj1995\/VoiceConversionWebUI\/resolve\/main\/rmvpe\.pt/.test(asset.url)), 'RVC install/repair should know how to restore assets/rmvpe/rmvpe.pt.');
  const rvcPipInstalls = rvcManifest.installInstructions?.pipInstalls || [];
  assert(rvcPipInstalls.some((entry) => entry.kind === 'package' && entry.value === 'gradio_client==1.3.0'), 'RVC install/repair should pin gradio_client to the RVC-compatible media_data API.');
  const chatterboxManifest = manifestTools.find((tool) => tool.id === 'chatterbox-tts');
  assert(chatterboxManifest, 'Chatterbox-Turbo TTS should be present in the tool manifest.');
  assert.strictEqual(chatterboxManifest.interfaceMode, 'external-browser', 'Chatterbox-Turbo should expose a real managed WebUI launch surface.');
  assert.strictEqual(chatterboxManifest.launchCommand, 'python .localaihub_launch_chatterbox_server.py --port {port}', 'Chatterbox WebUI launch should use the Local AI Hub localhost shim.');
  assert.strictEqual(chatterboxManifest.defaultPort, 8004, 'Chatterbox WebUI should use the documented managed server port.');
  assert.strictEqual(chatterboxManifest.healthCheckPath, '/api/ui/initial-data', 'Chatterbox WebUI readiness should probe a UI data endpoint.');
  assert(/devnen\/Chatterbox-TTS-Server/.test(chatterboxManifest.downloadUrl), 'Chatterbox WebUI source should come from the audited Chatterbox-TTS-Server project.');
  assert.strictEqual(chatterboxManifest.installInstructions?.pythonRequirement, '>=3.11,<3.12', 'Chatterbox-Turbo should require the smoke-tested Python 3.11 line.');
  const chatterboxPipInstalls = chatterboxManifest.installInstructions?.pipInstalls || [];
  assert(chatterboxPipInstalls.some((entry) => entry.value === 'torch==2.6.0+cu124' && (entry.pipArgs || []).includes('https://download.pytorch.org/whl/cu124')), 'Chatterbox install should install CUDA torch 2.6.0 from the cu124 PyTorch index.');
  assert(chatterboxPipInstalls.some((entry) => entry.value === 'torchaudio==2.6.0+cu124' && (entry.pipArgs || []).includes('https://download.pytorch.org/whl/cu124')), 'Chatterbox install should install CUDA torchaudio 2.6.0 from the cu124 PyTorch index.');
  assert(chatterboxPipInstalls.some((entry) => entry.value === 'chatterbox-tts==0.1.7'), 'Chatterbox install should pin the smoke-tested chatterbox-tts package.');
  assert(chatterboxPipInstalls.some((entry) => entry.value === 'setuptools<81'), 'Chatterbox install should pin setuptools below 81 so pkg_resources remains available.');
  assert(chatterboxPipInstalls.some((entry) => entry.value === 'fastapi>=0.100.0,<0.116.0'), 'Chatterbox WebUI install should include FastAPI.');
  assert(chatterboxPipInstalls.some((entry) => entry.value === 'uvicorn[standard]>=0.27.0'), 'Chatterbox WebUI install should include uvicorn.');
  assert(chatterboxPipInstalls.some((entry) => entry.value === 'praat-parselmouth>=0.4.0'), 'Chatterbox WebUI install should include voice analysis dependencies.');
  assert.strictEqual(chatterboxManifest.launchEnvironment?.setHuggingFaceCacheEnv, true, 'Chatterbox launch should route Hugging Face cache to managed storage.');
  assert.strictEqual(chatterboxManifest.launchEnvironment?.setTorchCacheEnv, true, 'Chatterbox launch should route Torch cache to managed storage.');
  assert.strictEqual(chatterboxManifest.launchEnvironment?.setTempEnv, true, 'Chatterbox launch should route TEMP/TMP to managed storage.');
  assert.strictEqual(chatterboxManifest.launchEnvironment?.includeBundledFfmpeg, true, 'Chatterbox WebUI launch should expose bundled FFmpeg for pydub.');
  const processServiceSource = fs.readFileSync(path.join(process.cwd(), 'electron/services/processService.js'), 'utf8');
  assert(processServiceSource.includes('getPipelineOnlyLaunchMessage'), 'Process launch should have a plain-English message for pipeline-only tools.');
  assert(processServiceSource.includes("interfaceMode || '').trim().toLowerCase() === 'pipeline-only'"), 'Process launch should reject pipeline-only tools before marking them running.');
  const libraryCardSource = fs.readFileSync(path.join(process.cwd(), 'src/components/LibraryCard.jsx'), 'utf8');
  assert(libraryCardSource.includes('pipelineOnlyMessage'), 'Library cards should explain pipeline-only tools instead of silently launching them.');
  assert(libraryCardSource.includes('Pipeline Builder'), 'Library cards should keep a generic pipeline-only fallback for tools that need it.');
  assert(libraryCardSource.includes('Only clone voices you have permission to use.'), 'Library cards should surface the Chatterbox voice permission warning.');
  const installerGridSource = fs.readFileSync(path.join(process.cwd(), 'src/components/InstallerGrid.jsx'), 'utf8');
  assert(installerGridSource.includes('pipelineOnlyMessage'), 'Installed Store cards should explain pipeline-only tools instead of offering a silent launch.');
  assert(installerGridSource.includes('Pipeline Builder'), 'Installed Store cards should keep a generic pipeline-only fallback for tools that need it.');
  assert(installerGridSource.includes('Only clone voices you have permission to use.'), 'Installed Store cards should surface the Chatterbox voice permission warning.');
  const faceFusionManifest = manifestTools.find((tool) => tool.id === 'facefusion');
  assert(faceFusionManifest, 'FaceFusion should remain present in the tool manifest.');
  const faceFusionPipInstalls = faceFusionManifest.installInstructions?.pipInstalls || [];
  assert(faceFusionPipInstalls.some((entry) => entry.kind === 'requirements' && entry.value === 'requirements.txt'), 'FaceFusion install/repair should install the requirements file that declares opencv-python.');
  assert(faceFusionPipInstalls.some((entry) => entry.excludePatterns?.includes('^onnxruntime\\b')), 'FaceFusion requirements install should leave ONNX Runtime variant selection to the upstream setup step.');
  assert.strictEqual(faceFusionManifest.launchEnvironment?.includeBundledFfmpeg, true, 'FaceFusion launch should opt in to the bundled FFmpeg runtime.');

  const faceFusionLaunchTool = {
    ...forgeTool,
    id: 'facefusion',
    name: 'FaceFusion',
    installDir: path.join(appPaths.toolsRoot, 'facefusion'),
    appDir: path.join(appPaths.toolsRoot, 'facefusion', 'app'),
    launchEnvironment: faceFusionManifest.launchEnvironment,
  };
  const faceFusionEnv = await buildLaunchRuntimeEnv(faceFusionLaunchTool, {}, { launchProfile: faceFusionLaunchTool.launchProfile });
  assert(faceFusionEnv.FFMPEG_BINARY && /ffmpeg\.exe$/i.test(faceFusionEnv.FFMPEG_BINARY), 'FaceFusion launch env should expose the bundled ffmpeg.exe path.');
  assert.strictEqual(faceFusionEnv.IMAGEIO_FFMPEG_EXE, faceFusionEnv.FFMPEG_BINARY, 'FaceFusion launch env should set common FFmpeg env aliases consistently.');
  assert.strictEqual(faceFusionEnv.LOCALAIHUB_FFMPEG_DIR, path.dirname(faceFusionEnv.FFMPEG_BINARY), 'FaceFusion launch env should expose the FFmpeg directory for diagnostics.');
  const faceFusionPathKey = Object.keys(faceFusionEnv).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const faceFusionPathEntries = String(faceFusionEnv[faceFusionPathKey] || '').split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  assert(faceFusionPathEntries.some((entry) => path.resolve(entry).toLowerCase() === path.resolve(faceFusionEnv.LOCALAIHUB_FFMPEG_DIR).toLowerCase()), 'FaceFusion launch PATH should include the bundled FFmpeg directory so shutil.which("ffmpeg") succeeds.');
  const faceFusionSummary = summarizeLaunchRuntimeEnv({ ...faceFusionEnv, OPENAI_API_KEY: 'secret' });
  assert.strictEqual(faceFusionSummary.FFMPEG_BINARY, faceFusionEnv.FFMPEG_BINARY, 'Launch env diagnostics should show the FaceFusion FFmpeg runtime path.');
  assert(!Object.prototype.hasOwnProperty.call(faceFusionSummary, 'OPENAI_API_KEY'), 'FaceFusion launch env diagnostics must still hide unrelated secrets.');

  const toolRegistrySource = fs.readFileSync(path.join(process.cwd(), 'electron/services/toolRegistry.js'), 'utf8');
  assert(toolRegistrySource.includes('runtimeAssets: installInstructions.runtimeAssets || []'), 'Tool registry should preserve runtime asset declarations from the manifest.');
  const installerSource = fs.readFileSync(path.join(process.cwd(), 'electron/services/installerService.js'), 'utf8');
  assert(installerSource.includes('ensureToolRuntimeAssets'), 'Managed install/repair should restore declared runtime assets before reporting success.');
  assert(installerSource.includes('verifyRvcManagedRuntimeReadiness'), 'Managed install/repair should verify RVC runtime assets and dependency compatibility.');
  assert(installerSource.includes('verifyFaceFusionManagedRuntimeReadiness'), 'Managed install/repair should verify FaceFusion cv2/OpenCV dependency compatibility.');
  assert(installerSource.includes('findRequirementEntry') && installerSource.includes('requirements-entry'), 'Managed install/repair should support installing a package directly from a tool requirements file.');
  assert(installerSource.includes('activeToolInstallOperations'), 'Managed install/repair should guard against overlapping per-tool operations that can delete active pip temp folders.');
  assert(installerSource.includes('buildRepairFailureMessage'), 'Managed repair should convert locked-file failures into a clear repair message.');
  assert(installerSource.includes('repair-python-environment'), 'Managed repair should remove the old Python environment with retrying cleanup before rebuilding it.');
  assert(installerSource.includes('still running or Windows is holding files open'), 'Managed repair should tell users when a tool is still running or files are locked.');
  assert(installerSource.includes('gradio_client') && installerSource.includes('has_media_data'), 'RVC install verification should check the gradio_client media_data compatibility surface.');
  assert(installerSource.includes('verifyChatterboxManagedPipelineReadiness'), 'Managed install/repair should verify Chatterbox imports and CUDA readiness.');
  assert(installerSource.includes('buildChatterboxPipelineVerificationScript'), 'Managed install/repair should include a Chatterbox import probe.');
  assert(installerSource.includes('["pkg_resources", "pkg_resources"]'), 'Chatterbox install verification should check pkg_resources.');
  assert(installerSource.includes('cudaAvailable'), 'Chatterbox install verification should check CUDA availability.');
  assert(installerSource.includes('CHATTERBOX_SERVER_LAUNCH_SHIM'), 'Managed install/repair should write the Chatterbox WebUI localhost launch shim.');
  assert(installerSource.includes('serverTurboAvailable'), 'Managed install/repair should verify the Chatterbox-TTS-Server Turbo surface when server files are present.');

  const runtimeRecoverySource = fs.readFileSync(path.join(process.cwd(), 'electron/services/runtimeRecoveryService.js'), 'utf8');
  assert(runtimeRecoverySource.includes('rvc-gradio-client-media-data'), 'Runtime recovery should classify the RVC gradio_client media_data ImportError.');
  assert(runtimeRecoverySource.includes('facefusion-missing-opencv'), 'Runtime recovery should classify FaceFusion missing cv2/OpenCV errors.');
  assert(runtimeRecoverySource.includes('facefusion-missing-onnxruntime'), 'Runtime recovery should classify FaceFusion missing ONNX Runtime errors.');
  assert(runtimeRecoverySource.includes('facefusion-missing-ffmpeg-runtime'), 'Runtime recovery should classify FaceFusion missing FFmpeg launch-runtime errors.');
  assert(runtimeRecoverySource.includes('chatterbox-setuptools-pkg-resources'), 'Runtime recovery should classify Chatterbox setuptools/pkg_resources failures.');
  assert(runtimeRecoverySource.includes('chatterbox-insufficient-vram'), 'Runtime recovery should classify Chatterbox CUDA OOM failures.');
  assert(runtimeRecoverySource.includes('chatterbox-cuda-unavailable'), 'Runtime recovery should classify Chatterbox CUDA availability failures.');
  assert(runtimeRecoverySource.includes('chatterbox-port-in-use'), 'Runtime recovery should classify Chatterbox WebUI port conflicts.');
  assert(runtimeRecoverySource.includes('chatterbox-config-invalid'), 'Runtime recovery should classify Chatterbox WebUI config failures.');
  assert(runtimeRecoverySource.includes('chatterbox-model-download-failed'), 'Runtime recovery should classify Chatterbox model/cache download failures.');
  const { diagnoseLaunchFailure } = require('../electron/services/runtimeRecoveryService');
  const rvcDependencyDiagnosis = diagnoseLaunchFailure(
    { id: 'rvc', name: 'RVC (Retrieval Voice Cloning)' },
    "ImportError: cannot import name 'media_data' from 'gradio_client' (D:\\LocalAIHub\\tools\\rvc\\.venv\\lib\\site-packages\\gradio_client\\__init__.py)",
    {},
  );
  assert.strictEqual(rvcDependencyDiagnosis.id, 'rvc-gradio-client-media-data', 'Runtime recovery should identify the RVC gradio_client media_data import failure.');
  assert.strictEqual(rvcDependencyDiagnosis.action, 'repair-python-environment', 'Runtime recovery should route the RVC gradio_client media_data failure to managed repair.');

  const faceFusionOnnxDiagnosis = diagnoseLaunchFailure(
    { id: 'facefusion', name: 'FaceFusion' },
    "ModuleNotFoundError: No module named 'onnxruntime'",
    {},
  );
  assert.strictEqual(faceFusionOnnxDiagnosis.id, 'facefusion-missing-onnxruntime', 'Runtime recovery should identify the FaceFusion missing onnxruntime import failure.');
  assert.strictEqual(faceFusionOnnxDiagnosis.action, 'repair-python-environment', 'Runtime recovery should route missing FaceFusion onnxruntime to managed repair.');

  const chatterboxSetuptoolsDiagnosis = diagnoseLaunchFailure(
    { id: 'chatterbox-tts', name: 'Chatterbox-Turbo TTS' },
    'ModuleNotFoundError: No module named pkg_resources while loading PerthImplicitWatermarker',
    {},
  );
  assert.strictEqual(chatterboxSetuptoolsDiagnosis.id, 'chatterbox-setuptools-pkg-resources', 'Runtime recovery should identify Chatterbox pkg_resources failures.');
  assert.strictEqual(chatterboxSetuptoolsDiagnosis.action, 'repair-python-environment', 'Runtime recovery should route Chatterbox pkg_resources failures to managed repair.');

  const chatterboxOomDiagnosis = diagnoseLaunchFailure(
    { id: 'chatterbox-tts', name: 'Chatterbox-Turbo TTS' },
    'CUDA error: out of memory',
    {},
  );
  assert.strictEqual(chatterboxOomDiagnosis.id, 'chatterbox-insufficient-vram', 'Runtime recovery should identify Chatterbox CUDA OOM failures.');
  assert.strictEqual(chatterboxOomDiagnosis.action, 'none', 'Runtime recovery should not retry aggressively after Chatterbox CUDA OOM.');

  const chatterboxPortDiagnosis = diagnoseLaunchFailure(
    { id: 'chatterbox-tts', name: 'Chatterbox-Turbo TTS' },
    'OSError: [WinError 10048] Only one usage of each socket address is normally permitted',
    {},
  );
  assert.strictEqual(chatterboxPortDiagnosis.id, 'chatterbox-port-in-use', 'Runtime recovery should identify Chatterbox WebUI port conflicts.');
  assert.strictEqual(chatterboxPortDiagnosis.action, 'none', 'Runtime recovery should not repair Python for Chatterbox port conflicts.');

  const chatterboxConfigDiagnosis = diagnoseLaunchFailure(
    { id: 'chatterbox-tts', name: 'Chatterbox-Turbo TTS' },
    'yaml.parser.ParserError: while parsing config.yaml',
    {},
  );
  assert.strictEqual(chatterboxConfigDiagnosis.id, 'chatterbox-config-invalid', 'Runtime recovery should identify Chatterbox WebUI config failures.');

  const faceFusionFfmpegDiagnosis = diagnoseLaunchFailure(
    { id: 'facefusion', name: 'FaceFusion' },
    '[FACEFUSION.CORE] ffmpeg is not installed',
    {},
  );
  assert.strictEqual(faceFusionFfmpegDiagnosis.id, 'facefusion-missing-ffmpeg-runtime', 'Runtime recovery should identify the FaceFusion missing FFmpeg launch-runtime failure.');
  assert.strictEqual(faceFusionFfmpegDiagnosis.action, 'none', 'Missing FaceFusion FFmpeg runtime should not be routed to Python dependency repair.');

  const healthyManaged = await assessManagedLaunchStoragePressure(forgeTool, {
    disks: [disk('C:\\', 0.25), disk(path.parse(paths.tempRoot).root, 80)],
    osTempDir: 'C:\\Users\\Test\\AppData\\Local\\Temp',
  });
  assert.strictEqual(healthyManaged.blocked, false, 'Low C: space should not block when managed temp/cache are on a healthy different drive.');
  assert(healthyManaged.warnings.some((entry) => entry.kind === 'os-temp-low-space'), 'Low OS temp drive should still produce an honest warning.');

  const lowManaged = await assessManagedLaunchStoragePressure(forgeTool, {
    disks: [disk(path.parse(paths.tempRoot).root, 2)],
    osTempDir: paths.tempRoot,
  });
  assert.strictEqual(lowManaged.blocked, true, 'Heavy tools should block when the managed temp/cache drive is below the hard floor.');

  console.log('Managed launch temp/cache storage verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
