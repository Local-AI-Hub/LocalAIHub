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
