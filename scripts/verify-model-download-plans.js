const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { createModelDownloadPlan, ollamaTagPlan } = require('../electron/services/modelDownloadPlanService');
const modelService = require('../electron/services/modelService');
const { getAppPaths } = require('../electron/services/configService');
const { _test: installerServiceTest } = require('../electron/services/installerService');
const { _test: modelServiceTest, listToolAssets } = modelService;
const { buildMergedToolStateList } = require('../electron/services/toolStateService');

const forge = { id: 'forge', name: 'Stable Diffusion WebUI Forge' };
const automatic1111 = { id: 'automatic1111', name: 'Automatic1111' };
const comfyui = { id: 'comfyui', name: 'ComfyUI' };
const koboldcpp = { id: 'koboldcpp', name: 'KoboldCpp' };
const lmstudio = { id: 'lmstudio', name: 'LM Studio' };
const rvcRoot = path.join(os.tmpdir(), 'local-ai-hub-rvc-plan-test');
const audiocraftRoot = path.join(os.tmpdir(), 'local-ai-hub-audiocraft-package-test');
const wanRoot = path.join(os.tmpdir(), 'local-ai-hub-wan-package-test');
const upscaylRoot = path.join(os.tmpdir(), 'local-ai-hub-upscayl-package-test');
const audiocraft = {
  id: 'audiocraft-webui',
  name: 'AudioCraft WebUI',
  appDir: audiocraftRoot,
  modelManager: {
    enabled: true,
    targetLayout: {
      basePath: 'app-dir',
      directories: {
        'Audio / Speech': 'models',
      },
    },
  },
};
const wan = {
  id: 'wan21-webui',
  name: 'Wan2.1 WebUI',
  appDir: wanRoot,
  modelManager: {
    enabled: true,
    targetLayout: {
      basePath: 'app-dir',
      directories: {
        Video: 'models/Wan-AI',
      },
    },
  },
};
const upscayl = {
  id: 'upscayl',
  name: 'Upscayl',
  appDir: upscaylRoot,
  modelManager: {
    enabled: true,
    targetLayout: {
      basePath: 'app-dir',
      directories: {
        Upscaler: 'resources/models',
      },
    },
  },
};
const rvc = {
  id: 'rvc',
  name: 'RVC',
  appDir: rvcRoot,
  modelManager: {
    enabled: true,
    targetLayout: {
      basePath: 'app-dir',
      directories: {
        'RVC Voice Model': 'weights',
      },
    },
  },
};

function artifact(rfilename, sizeBytes = 0, extra = {}) {
  return { rfilename, sizeBytes, ...extra };
}

function assertRecommended(plan, expectedPath, message) {
  assert.strictEqual(plan.runnable, true, message + ' should be runnable.');
  assert.strictEqual(plan.recommendedArtifactPath, expectedPath, message + ' should pick the expected artifact.');
}

async function verifyModelAssetLifecyclePolicy() {
  const logger = { info: async () => {}, warn: async () => {} };
  const repairRoot = path.join(os.tmpdir(), 'local-ai-hub-model-asset-repair-test');
  const audioTool = {
    ...audiocraft,
    source: 'managed',
    managedByLocalAIHub: true,
    installDir: repairRoot,
    appDir: path.join(repairRoot, 'app'),
  };
  const audioPackageRoot = path.join(audioTool.appDir, 'models', 'audiocraft', 'musicgen-small');
  const audioManifestPath = path.join(audioPackageRoot, '.localaihub-package.json');
  const audioIdentity = modelServiceTest.buildSourceDownloadIdentity({
    source: 'huggingface',
    toolId: audioTool.id,
    packageIdentity: 'hf:facebook/musicgen-small:audiocraft-snapshot',
    fileName: 'musicgen-small',
  });

  try {
    await fs.remove(repairRoot);
    await fs.ensureDir(audioPackageRoot);
    await fs.writeFile(path.join(audioPackageRoot, 'state_dict.bin'), 'state');
    await fs.writeFile(path.join(audioPackageRoot, 'compression_state_dict.bin'), 'compression');
    await fs.writeJson(audioManifestPath, {
      downloadIdentity: audioIdentity,
      installedFiles: [
        { installRelativePath: 'state_dict.bin' },
        { installRelativePath: 'compression_state_dict.bin' },
      ],
      modelType: 'Audio / Speech',
      packageIdentity: 'hf:facebook/musicgen-small:audiocraft-snapshot',
      packageName: 'musicgen-small',
      packageRootPath: audioPackageRoot,
      planType: 'package',
      source: 'huggingface',
    });

    await installerServiceTest.preserveModelManagerAssetsForAction(audioTool, logger, 'verify-audiocraft-repair', async () => {
      assert(!(await fs.pathExists(audioPackageRoot)), 'AudioCraft assets should be outside the disposable app folder while repair refreshes app files.');
      await fs.remove(audioTool.appDir);
      await fs.ensureDir(audioTool.appDir);
      await fs.writeFile(path.join(audioTool.appDir, 'repaired.txt'), 'ok');
    });

    assert(await fs.pathExists(path.join(audioPackageRoot, 'state_dict.bin')), 'Repair preservation should restore AudioCraft package files.');
    assert(await fs.pathExists(audioManifestPath), 'Repair preservation should restore AudioCraft package sidecar metadata.');
    const audioAssets = await listToolAssets(audioTool, { assetKind: 'audiocraft-snapshot' });
    assert(audioAssets.models.some((model) => model.downloadIdentity === audioIdentity), 'Downloaded-state identity should remain correct after AudioCraft repair preservation.');

    const rvcRepairRoot = path.join(os.tmpdir(), 'local-ai-hub-model-asset-rvc-repair-test');
    const rvcTool = { ...rvc, source: 'managed', managedByLocalAIHub: true, installDir: rvcRepairRoot, appDir: path.join(rvcRepairRoot, 'app') };
    const rvcWeight = path.join(rvcTool.appDir, 'weights', 'Alice.pth');
    await fs.remove(rvcRepairRoot);
    await fs.ensureDir(path.dirname(rvcWeight));
    await fs.writeFile(rvcWeight, 'voice');
    await fs.writeJson(rvcWeight + '.localaihub.json', {
      downloadIdentity: 'huggingface|rvc|repo:voice/alice|artifact:Alice.pth|file:Alice.pth',
      fileName: 'Alice.pth',
      modelType: 'RVC Voice Model',
      source: 'huggingface',
    });

    await installerServiceTest.preserveModelManagerAssetsForAction(rvcTool, logger, 'verify-rvc-repair', async () => {
      await fs.remove(rvcTool.appDir);
      await fs.ensureDir(rvcTool.appDir);
    });
    const rvcAssets = await listToolAssets(rvcTool, { assetKind: 'rvc-voice-model' });
    assert(rvcAssets.models.some((model) => model.fileName === 'Alice.pth'), 'RVC Model Step refresh should still see voice models after repair preservation.');

    const appPaths = getAppPaths();
    const uniqueAssetRootName = 'lifecycle-test-' + Date.now();
    const managedAssetRoot = path.join(appPaths.modelsRoot, uniqueAssetRootName);
    const unrelatedAssetRoot = path.join(appPaths.modelsRoot, uniqueAssetRootName + '-other');
    const managedAssetTool = {
      id: 'lifecycle-test-tool',
      name: 'Lifecycle Test Tool',
      source: 'managed',
      managedByLocalAIHub: true,
      installDir: path.join(os.tmpdir(), uniqueAssetRootName, 'tools', 'lifecycle-test-tool'),
      appDir: path.join(os.tmpdir(), uniqueAssetRootName, 'tools', 'lifecycle-test-tool', 'app'),
      modelManager: {
        enabled: true,
        targetLayout: {
          basePath: 'managed-models-root',
          baseSubdirectory: uniqueAssetRootName,
          directories: { GGUF: '' },
        },
      },
    };
    await fs.ensureDir(managedAssetRoot);
    await fs.writeFile(path.join(managedAssetRoot, 'model.gguf'), 'gguf');
    await fs.writeFile(path.join(managedAssetRoot, 'model.gguf.localaihub.json'), '{}');
    await fs.ensureDir(unrelatedAssetRoot);
    await fs.writeFile(path.join(unrelatedAssetRoot, 'keep.gguf'), 'keep');
    const cleanup = await installerServiceTest.removeManagedModelManagerAssets(managedAssetTool, logger, 'verify-uninstall-assets');
    assert.strictEqual(cleanup.removedModelAssetRootCount, 1, 'Uninstall cleanup should remove the tool-specific managed Model Manager asset root.');
    assert(!(await fs.pathExists(managedAssetRoot)), 'Uninstall cleanup should remove tool-associated managed Model Manager assets and sidecars.');
    assert(await fs.pathExists(path.join(unrelatedAssetRoot, 'keep.gguf')), 'Uninstall cleanup must not remove unrelated tool asset folders.');
    await fs.remove(unrelatedAssetRoot);
  } finally {
    await fs.remove(repairRoot);
    await fs.remove(path.join(os.tmpdir(), 'local-ai-hub-model-asset-rvc-repair-test'));
  }
}

async function main() {
  await verifyModelAssetLifecyclePolicy();

  const manifestPath = path.resolve(__dirname, '..', 'electron', 'config', 'tools-manifest.json');
  const manifestTools = await fs.readJson(manifestPath);
  const audiocraftManifest = manifestTools.find((tool) => tool.id === 'audiocraft-webui');
  const wanManifest = manifestTools.find((tool) => tool.id === 'wan21-webui');
  const upscaylManifest = manifestTools.find((tool) => tool.id === 'upscayl');
  assert(audiocraftManifest, 'AudioCraft WebUI should remain present in the tool manifest.');
  assert(wanManifest, 'Wan2.1 WebUI should remain present in the tool manifest.');
  assert(upscaylManifest, 'Upscayl should remain present in the tool manifest.');
  assert.strictEqual(modelService.supportsModelManager(audiocraftManifest), true, 'AudioCraft should be exposed only after package snapshot support is available.');
  assert.strictEqual(modelService.supportsModelManager(wanManifest), true, 'Wan should be exposed only for complete model-folder package support.');
  assert.strictEqual(modelService.supportsModelManager(upscaylManifest), true, 'Upscayl should be exposed only for paired .param/.bin model set support.');

  const staleWanState = await buildMergedToolStateList({
    config: {
      tools: {
        'wan21-webui': {
          id: 'wan21-webui',
          name: 'Wan2.1 WebUI',
          source: 'managed',
          appDir: wanRoot,
          installDir: wanRoot,
          venvDir: path.join(wanRoot, '.venv'),
          modelManager: null,
        },
      },
    },
    includeSnapshots: false,
    resolveStatuses: false,
  });
  assert.strictEqual(staleWanState[0]?.modelManager?.enabled, true, 'Merged installed tool state should inherit the manifest Model Manager config so Wan appears in the target dropdown after reinstall.');
  const audiocraftPlan = createModelDownloadPlan({
    tool: audiocraft,
    source: 'huggingface',
    selectedType: 'audio-speech',
    catalogRepositoryId: 'facebook/musicgen-medium',
    artifacts: [artifact('config.json', 2), artifact('state_dict.bin', 5), artifact('compression_state_dict.bin', 11), artifact('README.md', 1024)],
  });
  assert.strictEqual(audiocraftPlan.runnable, true, 'Complete known AudioCraft snapshots should be package-runnable.');
  assert.strictEqual(audiocraftPlan.planType, 'package', 'AudioCraft should use a package download plan.');
  assert.strictEqual(audiocraftPlan.downloadFiles.length, 3, 'AudioCraft should download the runtime-required files plus small MusicGen metadata, not the entire repository.');
  assert(audiocraftPlan.packageIdentity.includes('facebook/musicgen-medium'), 'AudioCraft package identity should include the source repository.');

  const audioGenPlan = createModelDownloadPlan({
    tool: audiocraft,
    source: 'huggingface',
    selectedType: 'audio-speech',
    catalogRepositoryId: 'facebook/audiogen-medium',
    artifacts: [artifact('state_dict.bin', 5), artifact('compression_state_dict.bin', 11), artifact('README.md', 1024)],
  });
  assert.strictEqual(audioGenPlan.runnable, true, 'AudioGen snapshots should be accepted when their runtime-required state/compression files are present even without config.json.');
  assert.strictEqual(audioGenPlan.downloadFiles.length, 2, 'AudioGen should download only the runtime-required snapshot files.');

  const incompleteAudiocraftPlan = createModelDownloadPlan({
    tool: audiocraft,
    source: 'huggingface',
    selectedType: 'audio-speech',
    catalogRepositoryId: 'facebook/musicgen-medium',
    artifacts: [artifact('config.json', 2), artifact('state_dict.bin', 5)],
  });
  assert.strictEqual(incompleteAudiocraftPlan.runnable, false, 'Incomplete AudioCraft snapshots must be blocked.');
  assert(/missing required files/i.test(incompleteAudiocraftPlan.blockingReason), 'Incomplete AudioCraft snapshots should explain missing required files.');

  const wanPlan = createModelDownloadPlan({
    tool: wan,
    source: 'huggingface',
    selectedType: 'video',
    catalogRepositoryId: 'Wan-AI/Wan2.1-I2V-14B-480P',
    artifacts: [
      artifact('diffusion_pytorch_model-00001-of-00002.safetensors', 12),
      artifact('diffusion_pytorch_model-00002-of-00002.safetensors', 12),
      artifact('models_t5_umt5-xxl-enc-bf16.pth', 12),
      artifact('Wan2.1_VAE.pth', 12),
      artifact('models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth', 12),
    ],
  });
  assert.strictEqual(wanPlan.runnable, true, 'Complete Wan model folders should be package-runnable.');
  assert.strictEqual(wanPlan.packageRoot, 'Wan2.1-I2V-14B-480P', 'Wan package roots should match the runtime folder name under models\Wan-AI.');
  assert(wanPlan.requiredArtifacts.some((entry) => /models_clip/i.test(entry)), 'Wan image-to-video packages should require the CLIP image encoder.');

  const incompleteWanPlan = createModelDownloadPlan({
    tool: wan,
    source: 'huggingface',
    selectedType: 'video',
    catalogRepositoryId: 'Wan-AI/Wan2.1-I2V-14B-480P',
    artifacts: [artifact('diffusion_pytorch_model.safetensors', 12), artifact('models_t5_umt5-xxl-enc-bf16.pth', 12), artifact('Wan2.1_VAE.pth', 12)],
  });
  assert.strictEqual(incompleteWanPlan.runnable, false, 'Wan image-to-video packages missing CLIP must be blocked.');

  const upscaylPlan = createModelDownloadPlan({
    tool: upscayl,
    source: 'huggingface',
    selectedType: 'upscaler',
    catalogRepositoryId: 'custom/upscayl-models',
    artifacts: [artifact('ultrasharp.param', 12), artifact('ultrasharp.bin', 12), artifact('preview.png', 20_000)],
  });
  assert.strictEqual(upscaylPlan.runnable, true, 'Upscayl paired .param/.bin sets should be package-runnable.');
  assert.strictEqual(upscaylPlan.packageTargetMode, 'flat', 'Upscayl model sets should install into the discovered models folder, not a nested runtime-invisible folder.');
  assert.strictEqual(upscaylPlan.downloadFiles.length, 2, 'Upscayl should download the paired assets only.');

  const paramOnlyUpscaylPlan = createModelDownloadPlan({
    tool: upscayl,
    source: 'huggingface',
    selectedType: 'upscaler',
    catalogRepositoryId: 'custom/upscayl-models',
    artifacts: [artifact('ultrasharp.param', 12)],
  });
  assert.strictEqual(paramOnlyUpscaylPlan.runnable, false, 'Upscayl .param-only assets must be blocked.');
  assert(/matching \.param and \.bin/i.test(paramOnlyUpscaylPlan.blockingReason), 'Upscayl pair blocking should explain the required paired files.');

  const packageSearchDetails = new Map([
    ['facebook/musicgen-small', { author: 'facebook', id: 'facebook/musicgen-small', pipeline_tag: 'text-to-audio', siblings: [artifact('config.json', 2), artifact('state_dict.bin', 5), artifact('compression_state_dict.bin', 11)], tags: ['musicgen'] }],
    ['facebook/musicgen-medium', { author: 'facebook', id: 'facebook/musicgen-medium', pipeline_tag: 'text-to-audio', siblings: [artifact('config.json', 2), artifact('state_dict.bin', 5), artifact('compression_state_dict.bin', 11)], tags: ['musicgen'] }],
    ['facebook/musicgen-large', { author: 'facebook', id: 'facebook/musicgen-large', pipeline_tag: 'text-to-audio', siblings: [artifact('config.json', 2), artifact('state_dict.bin', 5), artifact('compression_state_dict.bin', 11)], tags: ['musicgen'] }],
    ['facebook/musicgen-melody', { author: 'facebook', id: 'facebook/musicgen-melody', pipeline_tag: 'text-to-audio', siblings: [artifact('config.json', 2), artifact('state_dict.bin', 5), artifact('compression_state_dict.bin', 11), artifact('tokenizer.model', 500)], tags: ['musicgen'] }],
    ['facebook/audiogen-medium', { author: 'facebook', id: 'facebook/audiogen-medium', pipeline_tag: 'text-to-audio', siblings: [artifact('state_dict.bin', 5), artifact('compression_state_dict.bin', 11)], tags: ['audiogen'] }],
    ['Wan-AI/Wan2.1-T2V-1.3B', { author: 'Wan-AI', id: 'Wan-AI/Wan2.1-T2V-1.3B', pipeline_tag: 'text-to-video', siblings: [artifact('diffusion_pytorch_model.safetensors', 12), artifact('models_t5_umt5-xxl-enc-bf16.pth', 12), artifact('Wan2.1_VAE.pth', 12)], tags: ['wan2.1'] }],
    ['Wan-AI/Wan2.1-T2V-14B', { author: 'Wan-AI', id: 'Wan-AI/Wan2.1-T2V-14B', pipeline_tag: 'text-to-video', siblings: [artifact('diffusion_pytorch_model-00001-of-00002.safetensors', 12), artifact('diffusion_pytorch_model-00002-of-00002.safetensors', 12), artifact('models_t5_umt5-xxl-enc-bf16.pth', 12), artifact('Wan2.1_VAE.pth', 12)], tags: ['wan2.1'] }],
    ['Wan-AI/Wan2.1-I2V-14B-480P', { author: 'Wan-AI', id: 'Wan-AI/Wan2.1-I2V-14B-480P', pipeline_tag: 'image-to-video', siblings: [artifact('diffusion_pytorch_model.safetensors', 12), artifact('models_t5_umt5-xxl-enc-bf16.pth', 12), artifact('Wan2.1_VAE.pth', 12), artifact('models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth', 12)], tags: ['wan2.1'] }],
    ['Wan-AI/Wan2.1-I2V-14B-720P', { author: 'Wan-AI', id: 'Wan-AI/Wan2.1-I2V-14B-720P', pipeline_tag: 'image-to-video', siblings: [artifact('diffusion_pytorch_model.safetensors', 12), artifact('models_t5_umt5-xxl-enc-bf16.pth', 12), artifact('Wan2.1_VAE.pth', 12), artifact('models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth', 12)], tags: ['wan2.1'] }],
    ['custom/upscayl-models', { author: 'custom', id: 'custom/upscayl-models', pipeline_tag: 'image-to-image', siblings: [artifact('ultrasharp.param', 12), artifact('ultrasharp.bin', 12), artifact('preview.png', 20_000)], tags: ['upscayl'] }],
  ]);
  const originalPackageSearchFetch = global.fetch;
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    const urlText = String(url);
    if (parsed.pathname === '/api/models') {
      return {
        ok: true,
        headers: {
          get: (name) => String(name || '').toLowerCase() === 'link'
            ? '<https://huggingface.co/api/models?cursor=seed-page-2>; rel="next"'
            : null,
        },
        json: async () => [],
      };
    }
    if (urlText.includes('/tree/main')) {
      const modelId = decodeURIComponent(parsed.pathname.slice('/api/models/'.length).replace('/tree/main', ''));
      const detail = packageSearchDetails.get(modelId);
      return { ok: Boolean(detail), headers: { get: () => null }, json: async () => detail?.siblings || [] };
    }
    if (parsed.pathname.startsWith('/api/models/')) {
      const modelId = decodeURIComponent(parsed.pathname.slice('/api/models/'.length));
      const detail = packageSearchDetails.get(modelId);
      return { ok: Boolean(detail), headers: { get: () => null }, json: async () => detail || {} };
    }
    throw new Error('Unexpected fetch in package search verifier: ' + String(url));
  };
  try {
    const logger = { info: async () => {}, warn: async () => {} };
    const audioDefaultSearch = await modelServiceTest.searchHuggingFaceModels(
      audiocraft,
      { cursor: null, limit: 12, modelType: 'audio-speech', page: 1, query: '', sort: 'most-downloaded', source: 'huggingface', taskType: 'audio-speech' },
      new Set(),
      { disks: [], hardware: { vramMb: 8192, ramMb: 32768 } },
      logger,
    );
    const audioDefaultNames = new Set(audioDefaultSearch.items.map((entry) => entry.name));
    assert(audioDefaultNames.has('facebook/musicgen-small'), 'AudioCraft default browse should seed supported MusicGen small.');
    assert(audioDefaultNames.has('facebook/musicgen-large'), 'AudioCraft default browse should seed supported MusicGen large.');
    assert(audioDefaultSearch.items.every((entry) => entry.downloadPlan?.planType === 'package' && entry.downloadPlan.runnable === true), 'AudioCraft seeded results should be complete runnable packages.');
    assert.strictEqual(audioDefaultSearch.pagination.hasMore, false, 'AudioCraft seeded-only default browse should not show Load More without a compatible remote page.');
    assert.strictEqual(audioDefaultSearch.pagination.nextCursor, null, 'AudioCraft seeded-only default browse should not expose an unusable Hugging Face cursor.');

    const audioExactSearch = await modelServiceTest.searchHuggingFaceModels(
      audiocraft,
      { cursor: null, limit: 12, modelType: 'audio-speech', page: 1, query: 'facebook/musicgen-medium', sort: 'most-downloaded', source: 'huggingface', taskType: 'audio-speech' },
      new Set(),
      { disks: [], hardware: { vramMb: 8192, ramMb: 32768 } },
      logger,
    );
    assert.strictEqual(audioExactSearch.items.length, 1, 'Exact AudioCraft repo searches should return the matching repository card.');
    assert.strictEqual(audioExactSearch.items[0].name, 'facebook/musicgen-medium', 'Exact AudioCraft search should preserve the requested repo id.');

    const audioGenExactSearch = await modelServiceTest.searchHuggingFaceModels(
      audiocraft,
      { cursor: null, limit: 12, modelType: 'audio-speech', page: 1, query: 'facebook/audiogen-medium', sort: 'most-downloaded', source: 'huggingface', taskType: 'audio-speech' },
      new Set(),
      { disks: [], hardware: { vramMb: 8192, ramMb: 32768 } },
      logger,
    );
    assert.strictEqual(audioGenExactSearch.items[0]?.name, 'facebook/audiogen-medium', 'Exact AudioGen repo search should work.');
    assert.strictEqual(audioGenExactSearch.items[0]?.downloadPlan?.runnable, true, 'Exact AudioGen repo search should accept the real two-file AudioGen snapshot layout.');

    const wanFamilySearch = await modelServiceTest.searchHuggingFaceModels(
      wan,
      { cursor: null, limit: 12, modelType: 'video', page: 1, query: 'Wan-AI/Wan2.1', sort: 'most-downloaded', source: 'huggingface', taskType: 'video-generation' },
      new Set(),
      { disks: [], hardware: { vramMb: 24576, ramMb: 65536 } },
      logger,
    );
    assert(wanFamilySearch.items.some((entry) => entry.name === 'Wan-AI/Wan2.1-T2V-1.3B'), 'Wan family searches should seed known compatible Wan-AI folders.');
    assert(wanFamilySearch.items.every((entry) => entry.downloadPlan?.planType === 'package'), 'Wan search results should remain package plans.');

    const upscaylDefaultSearch = await modelServiceTest.searchHuggingFaceModels(
      upscayl,
      { cursor: null, limit: 12, modelType: 'upscaler', page: 1, query: '', sort: 'most-downloaded', source: 'huggingface', taskType: 'image-to-image' },
      new Set(),
      { disks: [], hardware: { vramMb: 8192, ramMb: 32768 } },
      logger,
    );
    assert.strictEqual(upscaylDefaultSearch.items.length, 0, 'Upscayl default remote browse should remain empty instead of pretending broad paired-model discovery is safe.');
    assert.strictEqual(upscaylDefaultSearch.pagination.hasMore, false, 'Upscayl default remote browse should not expose load-more for disabled broad discovery.');

    const upscaylBroadSearch = await modelServiceTest.searchHuggingFaceModels(
      upscayl,
      { cursor: null, limit: 12, modelType: 'upscaler', page: 1, query: 'upscayl custom models', sort: 'most-downloaded', source: 'huggingface', taskType: 'image-to-image' },
      new Set(),
      { disks: [], hardware: { vramMb: 8192, ramMb: 32768 } },
      logger,
    );
    assert.strictEqual(upscaylBroadSearch.items.length, 0, 'Upscayl broad remote searches should stay disabled until a safe paired-model source is explicitly supported.');

    const upscaylExactSearch = await modelServiceTest.searchHuggingFaceModels(
      upscayl,
      { cursor: null, limit: 12, modelType: 'upscaler', page: 1, query: 'custom/upscayl-models', sort: 'most-downloaded', source: 'huggingface', taskType: 'image-to-image' },
      new Set(),
      { disks: [], hardware: { vramMb: 8192, ramMb: 32768 } },
      logger,
    );
    assert.strictEqual(upscaylExactSearch.items.length, 1, 'Exact Upscayl Hugging Face repo searches should still work for complete paired model sets.');
    assert.strictEqual(upscaylExactSearch.items[0]?.downloadPlan?.runnable, true, 'Exact Upscayl paired repo search should produce a runnable package plan.');
  } finally {
    global.fetch = originalPackageSearchFetch;
  }


  const sd15Artifacts = [
    artifact('safety_checker/model.fp16.safetensors', 120 * 1024 * 1024),
    artifact('feature_extractor/preprocessor_config.json', 1024),
    artifact('v1-5-pruned-emaonly.safetensors', 4_200_000_000),
    artifact('sd-v1-5-inpainting.ckpt', 4_300_000_000),
  ];

  const forgePlan = createModelDownloadPlan({ tool: forge, source: 'huggingface', selectedType: 'all', artifacts: sd15Artifacts });
  assertRecommended(forgePlan, 'v1-5-pruned-emaonly.safetensors', 'Forge SD 1.5');
  assert(!forgePlan.compatibleArtifacts.some((entry) => entry.path === 'safety_checker/model.fp16.safetensors'), 'Forge must not treat safety_checker/model.fp16.safetensors as runnable.');
  assert(forgePlan.rejectedArtifacts.some((entry) => entry.path === 'safety_checker/model.fp16.safetensors'), 'Forge should record safety checker as rejected.');

  const a1111Plan = createModelDownloadPlan({ tool: automatic1111, source: 'huggingface', selectedType: 'all', artifacts: sd15Artifacts });
  assertRecommended(a1111Plan, 'v1-5-pruned-emaonly.safetensors', 'Automatic1111 SD 1.5');

  const inpaintPlan = createModelDownloadPlan({ tool: forge, source: 'huggingface', selectedType: 'inpainting', artifacts: sd15Artifacts });
  assertRecommended(inpaintPlan, 'sd-v1-5-inpainting.ckpt', 'Forge inpainting filter');

  const diffusersOnlyPlan = createModelDownloadPlan({
    tool: forge,
    source: 'huggingface',
    selectedType: 'all',
    artifacts: [
      artifact('unet/diffusion_pytorch_model.safetensors', 3_000_000_000),
      artifact('text_encoder/model.safetensors', 500_000_000),
      artifact('scheduler/scheduler_config.json', 1024),
    ],
  });
  assert.strictEqual(diffusersOnlyPlan.runnable, false, 'Diffusers component-only repos must not appear runnable for Forge/A1111 checkpoint installs.');
  assert(/Diffusers component/i.test(diffusersOnlyPlan.blockingReason), 'Diffusers component-only repos should explain the artifact mismatch.');

  const ponyArtifacts = [
    artifact('vae/diffusion_pytorch_model.fp16.safetensors', 335_000_000),
    artifact('text_encoder/model.fp16.safetensors', 246_000_000),
    artifact('ponyDiffusionV6XL_v6StartWithThisOne.safetensors', 6_900_000_000),
  ];
  const ponyForgePlan = createModelDownloadPlan({ tool: forge, source: 'huggingface', selectedType: 'all', artifacts: ponyArtifacts });
  assertRecommended(ponyForgePlan, 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors', 'Forge Pony/SDXL repository');
  assert(ponyForgePlan.rejectedArtifacts.some((entry) => entry.path === 'vae/diffusion_pytorch_model.fp16.safetensors'), 'Forge must reject Diffusers VAE component files as runnable primary artifacts.');

  const ponyComponentOnlyPlan = createModelDownloadPlan({
    tool: automatic1111,
    source: 'huggingface',
    selectedType: 'all',
    artifacts: [artifact('vae/diffusion_pytorch_model.fp16.safetensors', 335_000_000)],
  });
  assert.strictEqual(ponyComponentOnlyPlan.runnable, false, 'A1111 must block repos that only expose Diffusers component files.');
  assert(/Diffusers component/i.test(ponyComponentOnlyPlan.blockingReason), 'Component-only VAE repos should explain the artifact mismatch.');

  const comfyPlan = createModelDownloadPlan({ tool: comfyui, source: 'huggingface', selectedType: 'vae', artifacts: [artifact('vae/diffusion_pytorch_model.safetensors', 300_000_000), artifact('foo.vae.safetensors', 300_000_000)] });
  assertRecommended(comfyPlan, 'foo.vae.safetensors', 'ComfyUI VAE');

  const incompleteSplit = createModelDownloadPlan({
    tool: koboldcpp,
    source: 'huggingface',
    selectedType: 'gguf',
    artifacts: [artifact('model-00001-of-00002.gguf', 2_000_000_000)],
  });
  assert.strictEqual(incompleteSplit.runnable, false, 'Incomplete split GGUFs must be blocked.');
  assert(/incomplete/i.test(incompleteSplit.blockingReason), 'Incomplete split GGUFs should explain missing parts.');

  const completeSplit = createModelDownloadPlan({
    tool: lmstudio,
    source: 'huggingface',
    selectedType: 'gguf',
    artifacts: [artifact('model-00001-of-00002.gguf', 2_000_000_000), artifact('model-00002-of-00002.gguf', 2_000_000_000)],
  });
  assert.strictEqual(completeSplit.runnable, false, 'Split GGUF bundles stay blocked until the downloader can install multi-file bundles.');
  assert(/split GGUF bundle/i.test(completeSplit.blockingReason), 'Complete split GGUFs should be blocked honestly as multi-file bundles.');

  const singleGguf = createModelDownloadPlan({ tool: koboldcpp, source: 'huggingface', selectedType: 'gguf', artifacts: [artifact('llama.Q4_K_M.gguf', 4_000_000_000)] });
  assertRecommended(singleGguf, 'llama.Q4_K_M.gguf', 'single GGUF');

  assert.strictEqual(modelServiceTest.buildRvcArtifactSearchQuery(''), 'rvc .pth', 'RVC empty/default HF search should use an artifact-oriented query.');
  assert.strictEqual(modelServiceTest.buildRvcArtifactSearchQuery('rvc voice model'), 'rvc voice model .pth', 'Plain-language RVC searches should be nudged toward voice weights.');
  assert.strictEqual(modelServiceTest.buildRvcArtifactSearchQuery('rvc pth index'), 'rvc .pth index', 'RVC searches with pth tokens should preserve the artifact hint.');
  assert.strictEqual(modelServiceTest.buildRvcHuggingFaceApiSearchQuery(''), 'rvc', 'RVC default HF catalog query should stay broad.');
  assert.strictEqual(modelServiceTest.buildRvcHuggingFaceApiSearchQuery('rvc .pth'), 'rvc', 'RVC user query rvc .pth should not be narrowed to the literal HF .pth query.');
  assert.strictEqual(modelServiceTest.buildRvcHuggingFaceApiSearchQuery('rvc pth index'), 'rvc', 'RVC pth/index search terms should not force the narrow HF API path.');

  const rvcPlan = createModelDownloadPlan({
    tool: rvc,
    source: 'huggingface',
    selectedType: 'rvc-voice',
    artifacts: [
      artifact('weights/Alice.pth', 80_000_000, { modelType: 'RVC Voice Model' }),
      artifact('logs/Alice/added_IVF.index', 11, { modelType: 'RVC Voice Model' }),
      artifact('samples/alice-preview.wav', 2_000_000, { modelType: 'RVC Voice Model' }),
      artifact('config.json', 2048, { modelType: 'RVC Voice Model' }),
      artifact('pytorch_model.pth', 1_000_000_000, { modelType: 'Checkpoint' }),
    ],
  });
  assertRecommended(rvcPlan, 'weights/Alice.pth', 'RVC voice model');
  assert.strictEqual(rvcPlan.artifactLabel, 'RVC voice model', 'RVC cards should label weights as voice models.');
  assert(rvcPlan.optionalArtifacts.some((entry) => entry.path === 'logs/Alice/added_IVF.index'), 'RVC index files should be surfaced as optional companions.');
  assert(/will be downloaded/i.test(rvcPlan.warning), 'A confidently matched RVC index should be described as an installable optional companion.');
  assert(rvcPlan.rejectedArtifacts.some((entry) => entry.path === 'samples/alice-preview.wav'), 'RVC audio previews must not be runnable voice models.');
  assert(rvcPlan.rejectedArtifacts.some((entry) => entry.path === 'config.json'), 'RVC config-only files must not be runnable voice models.');
  assert(rvcPlan.rejectedArtifacts.some((entry) => entry.path === 'pytorch_model.pth'), 'Generic PyTorch weights must not be installed as RVC voice models.');

  const rvcPtPlan = createModelDownloadPlan({
    tool: rvc,
    source: 'huggingface',
    selectedType: 'rvc-voice',
    artifacts: [artifact('weights/Bob.pt', 80_000_000, { modelType: 'RVC Voice Model' })],
  });
  assertRecommended(rvcPtPlan, 'weights/Bob.pt', 'RVC .pt voice model');

  const rvcModelOnlyPlan = createModelDownloadPlan({
    tool: rvc,
    source: 'huggingface',
    selectedType: 'rvc-voice',
    artifacts: [artifact('model.pth', 80_000_000, { modelType: 'RVC Voice Model' })],
  });
  assertRecommended(rvcModelOnlyPlan, 'model.pth', 'RVC model.pth without index');
  assert.deepStrictEqual(rvcModelOnlyPlan.requiredArtifacts, ['model.pth'], 'RVC model.pth should be the required primary artifact.');
  assert.strictEqual(rvcModelOnlyPlan.optionalArtifacts.length, 0, 'RVC model.pth should remain downloadable without an index companion.');
  assert.strictEqual(rvcModelOnlyPlan.warning, null, 'RVC model.pth without an index should not claim an optional companion will download.');

  const rvcIndexOnlyPlan = createModelDownloadPlan({
    tool: rvc,
    source: 'huggingface',
    selectedType: 'rvc-voice',
    artifacts: [artifact('logs/Alice/added_IVF.index', 11, { modelType: 'RVC Voice Model' })],
  });
  assert.strictEqual(rvcIndexOnlyPlan.runnable, false, 'RVC index-only repositories must stay blocked.');
  assert(/optional companions/i.test(rvcIndexOnlyPlan.blockingReason), 'RVC index-only plans should explain that an index is not a primary weight.');

  const rvcGenericPthPlan = createModelDownloadPlan({
    tool: rvc,
    source: 'huggingface',
    selectedType: 'rvc-voice',
    artifacts: [artifact('pytorch_model.pth', 1_000_000_000, { modelType: 'Checkpoint' })],
  });
  assert.strictEqual(rvcGenericPthPlan.runnable, false, 'Unlabeled .pth files must not be treated as RVC voice models.');
  assert(/not clearly labeled/i.test(rvcGenericPthPlan.blockingReason), 'Generic .pth rejection should be plain English.');

  const ambiguousRvcIndexPlan = createModelDownloadPlan({
    tool: rvc,
    source: 'huggingface',
    selectedType: 'rvc-voice',
    artifacts: [
      artifact('Alice.pth', 12, { modelType: 'RVC Voice Model' }),
      artifact('logs/first/added_IVF.index', 4_000_000, { modelType: 'RVC Voice Model' }),
      artifact('logs/second/added_IVF.index', 4_000_000, { modelType: 'RVC Voice Model' }),
    ],
  });
  assertRecommended(ambiguousRvcIndexPlan, 'Alice.pth', 'RVC ambiguous index primary weight');
  assert.strictEqual(ambiguousRvcIndexPlan.optionalArtifacts.length, 0, 'Ambiguous RVC index matches must not be auto-installed.');
  assert(/could not match one confidently/i.test(ambiguousRvcIndexPlan.warning), 'Ambiguous RVC index matches should remain manual.');

  const rvcDestination = modelServiceTest.resolveModelDestination(rvc, {
    fileName: 'Alice.pth',
    installRelativePath: 'Alice.pth',
    modelType: 'RVC Voice Model',
  });
  assert.strictEqual(path.normalize(rvcDestination.targetDirectory), path.join(rvcRoot, 'weights'), 'RVC downloads should target the weights folder scanned by local discovery.');
  assert.strictEqual(path.normalize(rvcDestination.destinationPath), path.join(rvcRoot, 'weights', 'Alice.pth'), 'RVC destination should preserve the selected weight file name.');

  await fs.remove(rvcRoot);
  await fs.ensureDir(path.join(rvcRoot, 'weights'));
  await fs.ensureDir(path.join(rvcRoot, 'logs', 'Alice'));
  const localRvcModelPath = path.join(rvcRoot, 'weights', 'Alice.pth');
  const localRvcIndexPath = path.join(rvcRoot, 'logs', 'Alice', 'added_IVF.index');
  await fs.writeFile(localRvcModelPath, Buffer.from('rvc-test-weight'));
  await fs.writeFile(localRvcIndexPath, Buffer.from('rvc-test-index'));
  await fs.writeJson(localRvcModelPath + '.localaihub.json', {
    schemaVersion: 1,
    downloadIdentity: 'huggingface|rvc|repo:voice/alice-rvc|artifact:alice.pth',
    source: 'huggingface',
    toolId: 'rvc',
    catalogRepositoryId: 'voice/alice-rvc',
    sourceArtifactPath: 'Alice.pth',
    installRelativePath: 'Alice.pth',
    fileName: 'Alice.pth',
    modelType: 'RVC Voice Model',
  });
  try {
    const rvcAssets = await listToolAssets(rvc, { assetKind: 'rvc-voice-model' });
    const aliceModel = rvcAssets.models.find((model) => model.fileName === 'Alice.pth');
    assert(aliceModel?.metadata?.downloadIdentity, 'RVC local discovery should see downloaded voice model metadata.');
    assert.strictEqual(path.normalize(aliceModel.indexPath), localRvcIndexPath, 'RVC local discovery should attach a matching optional .index companion.');
    assert.strictEqual(path.normalize(aliceModel.indexRelativePath), path.join('logs', 'Alice', 'added_IVF.index'), 'RVC index metadata should stay relative to the RVC app root.');
  } finally {
    await fs.remove(rvcRoot);
  }

  await fs.remove(rvcRoot);
  await fs.ensureDir(path.join(rvcRoot, 'weights', 'repo-folder'));
  const nestedRvcModelPath = path.join(rvcRoot, 'weights', 'repo-folder', 'model.pth');
  await fs.writeFile(nestedRvcModelPath, Buffer.from('nested-rvc-test-weight'));
  try {
    const rvcAssets = await listToolAssets(rvc, { assetKind: 'rvc-voice-model' });
    const nestedModel = rvcAssets.models.find((model) => path.normalize(model.relativePath) === path.join('repo-folder', 'model.pth'));
    assert(nestedModel, 'RVC local discovery should find voice models in repository-specific weights subfolders.');
    assert.strictEqual(nestedModel.indexPath || '', '', 'RVC local discovery should allow .pth-only voice models without an index companion.');
  } finally {
    await fs.remove(rvcRoot);
  }

  await fs.remove(rvcRoot);
  const originalDownloadFetch = global.fetch;
  global.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.endsWith('/logs/Alice/added_IVF.index')) {
      return new Response(Buffer.from('voice-index'), { status: 200, headers: { 'content-length': '11' } });
    }
    throw new Error('Unexpected RVC companion download URL: ' + urlText);
  };
  try {
    await modelServiceTest.downloadOptionalCompanionFiles(
      rvc,
      {
        catalogEntityType: 'repository',
        catalogRepositoryId: 'voice-maker/alice-rvc-voice-model',
        downloadPlan: rvcPlan,
        fileName: 'Alice.pth',
        installRelativePath: 'Alice.pth',
        modelType: 'RVC Voice Model',
        name: 'Alice',
        source: 'huggingface',
        sourceArtifactPath: 'weights/Alice.pth',
        toolId: 'rvc',
      },
      { 'User-Agent': 'LocalAIHub/test' },
      { info: async () => {}, warn: async () => {} },
    );
    assert(await fs.pathExists(path.join(rvcRoot, 'logs', 'Alice', 'added_IVF.index')), 'RVC index companion should download into logs.');
    const companionMetadata = await fs.readJson(path.join(rvcRoot, 'logs', 'Alice', 'added_IVF.index.localaihub.json'));
    assert.strictEqual(companionMetadata.sourceArtifactPath, 'logs/Alice/added_IVF.index', 'RVC companion sidecar should preserve source artifact path.');
  } finally {
    global.fetch = originalDownloadFetch;
    await fs.remove(rvcRoot);
  }

  await fs.remove(rvcRoot);
  const originalRvcModelDownloadFetch = global.fetch;
  global.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.endsWith('/weights/Alice.pth')) {
      return new Response(Buffer.from('voice-weight'), { status: 200, headers: { 'content-length': '12' } });
    }
    if (urlText.endsWith('/logs/Alice/added_IVF.index')) {
      return new Response(Buffer.from('voice-index'), { status: 200, headers: { 'content-length': '11' } });
    }
    throw new Error('Unexpected RVC model download URL: ' + urlText);
  };
  try {
    const serializedRvcPlan = { ...rvcPlan, downloadFiles: [] };
    await modelService.downloadModel(rvc, {
      catalogEntityType: 'repository',
      catalogRepositoryId: 'voice-maker/alice-rvc-voice-model',
      downloadPlan: serializedRvcPlan,
      downloadUrl: 'https://huggingface.co/voice-maker/alice-rvc-voice-model/resolve/main/weights/Alice.pth',
      fileName: 'Alice.pth',
      installRelativePath: 'Alice.pth',
      modelType: 'RVC Voice Model',
      name: 'Alice',
      source: 'huggingface',
      sourceArtifactPath: 'weights/Alice.pth',
      toolId: 'rvc',
      lowDiskConfirmed: true,
    });
    assert(await fs.pathExists(path.join(rvcRoot, 'weights', 'Alice.pth')), 'Serialized RVC repository cards should download the required .pth as a single model file.');
    assert(await fs.pathExists(path.join(rvcRoot, 'logs', 'Alice', 'added_IVF.index')), 'Serialized RVC repository cards should still download a matched optional .index companion.');
    const downloadedRvcAssets = await listToolAssets(rvc, { assetKind: 'rvc-voice-model' });
    const downloadedAlice = downloadedRvcAssets.models.find((model) => model.fileName === 'Alice.pth');
    assert(downloadedAlice, 'Model Manager RVC download target path should be discoverable by Model Step voice-model refresh.');
    assert.strictEqual(path.normalize(downloadedAlice.indexRelativePath), path.join('logs', 'Alice', 'added_IVF.index'), 'Downloaded RVC voice models should retain matched optional index metadata for runtime.');
  } finally {
    global.fetch = originalRvcModelDownloadFetch;
    await fs.remove(rvcRoot);
  }

  const packageIdentity = modelServiceTest.buildSourceDownloadIdentity({ source: 'huggingface', toolId: audiocraft.id, catalogRepositoryId: 'facebook/musicgen-medium', packageIdentity: audiocraftPlan.packageIdentity, fileName: audiocraftPlan.packageName });
  const singleFileIdentity = modelServiceTest.buildSourceDownloadIdentity({ source: 'huggingface', toolId: audiocraft.id, catalogRepositoryId: 'facebook/musicgen-medium', sourceArtifactPath: 'state_dict.bin', fileName: 'state_dict.bin' });
  assert.notStrictEqual(packageIdentity, singleFileIdentity, 'Package downloaded-state identity should not match an individual component file identity.');

  await fs.remove(audiocraftRoot);
  const originalPackageFetch = global.fetch;
  global.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.endsWith('/config.json')) return new Response(Buffer.from('{}'), { status: 200, headers: { 'content-length': '2' } });
    if (urlText.endsWith('/state_dict.bin')) return new Response(Buffer.from('state'), { status: 200, headers: { 'content-length': '5' } });
    if (urlText.endsWith('/compression_state_dict.bin')) return new Response(Buffer.from('compression'), { status: 200, headers: { 'content-length': '11' } });
    throw new Error('Unexpected package download URL: ' + urlText);
  };
  try {
    await modelService.downloadModel(audiocraft, {
      catalogEntityType: 'package',
      catalogRepositoryId: 'facebook/musicgen-medium',
      downloadPlan: audiocraftPlan,
      fileName: audiocraftPlan.packageName,
      installRelativePath: audiocraftPlan.packageRoot,
      modelType: 'Audio / Speech',
      name: 'facebook/musicgen-medium',
      packageIdentity: audiocraftPlan.packageIdentity,
      source: 'huggingface',
      toolId: audiocraft.id,
      lowDiskConfirmed: true,
    });
    const manifestPath = path.join(audiocraftRoot, 'models', 'audiocraft', 'musicgen-medium', '.localaihub-package.json');
    assert(await fs.pathExists(manifestPath), 'Package installs should write a package sidecar manifest after every required file is present.');
    const localAudioCraftModels = await modelService.listDownloadedModels(audiocraft);
    assert(localAudioCraftModels.some((model) => model.packageManifestPath === manifestPath && model.downloadIdentity === packageIdentity), 'Package local discovery should expose package identity from the sidecar.');
    assert(!localAudioCraftModels.some((model) => model.fileName === 'state_dict.bin'), 'Package component files must not appear as runnable standalone models.');
    const audioCraftAssets = await listToolAssets(audiocraft, { assetKind: 'audiocraft-snapshot' });
    assert(audioCraftAssets.models.some((model) => model.path === path.join(audiocraftRoot, 'models', 'audiocraft', 'musicgen-medium')), 'AudioCraft Model Step refresh should expose the local snapshot path used by get_pretrained.');
  } finally {
    global.fetch = originalPackageFetch;
    await fs.remove(audiocraftRoot);
  }

  global.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.endsWith('/config.json')) return new Response(Buffer.from('{}'), { status: 200, headers: { 'content-length': '2' } });
    if (urlText.endsWith('/state_dict.bin')) return new Response(Buffer.from('state'), { status: 200, headers: { 'content-length': '5' } });
    if (urlText.endsWith('/compression_state_dict.bin')) return new Response(Buffer.from('nope'), { status: 500, headers: { 'content-length': '4' } });
    throw new Error('Unexpected package failure URL: ' + urlText);
  };
  try {
    await assert.rejects(
      () => modelService.downloadModel(audiocraft, {
        catalogEntityType: 'package',
        catalogRepositoryId: 'facebook/musicgen-medium',
        downloadPlan: audiocraftPlan,
        fileName: audiocraftPlan.packageName,
        installRelativePath: audiocraftPlan.packageRoot,
        modelType: 'Audio / Speech',
        name: 'facebook/musicgen-medium',
        packageIdentity: audiocraftPlan.packageIdentity,
        source: 'huggingface',
        toolId: audiocraft.id,
        lowDiskConfirmed: true,
      }),
      /could not be downloaded|could not be installed as a complete package/i,
      'Package install failures should reject clearly.',
    );
    assert(!(await fs.pathExists(path.join(audiocraftRoot, 'models', 'audiocraft', 'musicgen-medium', '.localaihub-package.json'))), 'Failed package installs must not claim downloaded success with a sidecar.');
  } finally {
    global.fetch = originalPackageFetch;
    await fs.remove(audiocraftRoot);
  }

  const originalRuntimePackageFetch = global.fetch;
  global.fetch = async (url) => {
    const urlText = String(url);
    const fileName = path.basename(new URL(urlText).pathname);
    return new Response(Buffer.from('package-file'), { status: 200, headers: { 'content-length': '12' } });
  };
  try {
    await fs.remove(wanRoot);
    await modelService.downloadModel(wan, {
      catalogEntityType: 'package',
      catalogRepositoryId: 'Wan-AI/Wan2.1-I2V-14B-480P',
      downloadPlan: wanPlan,
      fileName: wanPlan.packageName,
      installRelativePath: wanPlan.packageRoot,
      modelType: 'Video',
      name: 'Wan-AI/Wan2.1-I2V-14B-480P',
      packageIdentity: wanPlan.packageIdentity,
      source: 'huggingface',
      toolId: wan.id,
      lowDiskConfirmed: true,
    });
    const wanAssets = await listToolAssets(wan, { assetKind: 'wan-model-folder' });
    assert(wanAssets.models.some((model) => model.name === 'Wan2.1-I2V-14B-480P'), 'Wan Model Step refresh should expose downloaded model folder names.');

    await fs.remove(upscaylRoot);
    await modelService.downloadModel(upscayl, {
      catalogEntityType: 'package',
      catalogRepositoryId: 'custom/upscayl-models',
      downloadPlan: upscaylPlan,
      fileName: upscaylPlan.packageName,
      installRelativePath: upscaylPlan.packageRoot,
      modelType: 'Upscaler',
      name: 'custom/upscayl-models',
      packageIdentity: upscaylPlan.packageIdentity,
      source: 'huggingface',
      toolId: upscayl.id,
      lowDiskConfirmed: true,
    });
    const upscaylAssets = await listToolAssets(upscayl, { assetKind: 'upscayl-model-set' });
    assert(upscaylAssets.models.some((model) => model.name === 'ultrasharp'), 'Upscayl image transform refresh should expose downloaded paired model stems.');
  } finally {
    global.fetch = originalRuntimePackageFetch;
    await fs.remove(wanRoot);
    await fs.remove(upscaylRoot);
  }

  const civitaiPlan = createModelDownloadPlan({
    tool: forge,
    source: 'civitai',
    selectedType: 'checkpoint',
    artifacts: [artifact('preview.jpeg', 100_000), artifact('realisticVision.safetensors', 4_000_000_000, { primary: true })],
  });
  assertRecommended(civitaiPlan, 'realisticVision.safetensors', 'CivitAI primary checkpoint');
  assert(civitaiPlan.rejectedArtifacts.some((entry) => entry.path === 'preview.jpeg'), 'CivitAI previews must not be runnable model artifacts.');

  assert.strictEqual(
    modelServiceTest.matchesSearchQuery('pony-diffusion-v6-xl-Q4_K_M.gguf', ['Pony Diffusion V6 XL Q4_K_M.gguf']),
    true,
    'Search matching should tolerate punctuation, case, and underscore differences for exact GGUF filenames.',
  );

  const sd15Fit = modelServiceTest.buildHardwareFit(
    { fileName: 'v1-5-pruned-emaonly.safetensors', modelType: 'Checkpoint', sizeBytes: 4_265_146_304 },
    forge,
    { vramMb: 6144, ramMb: 16384 },
  );
  const ponyFit = modelServiceTest.buildHardwareFit(
    { fileName: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors', modelType: 'Checkpoint', sizeBytes: 6_900_000_000 },
    forge,
    { vramMb: 6144, ramMb: 16384 },
  );
  assert.strictEqual(sd15Fit.label, 'Recommended', 'SD 1.5 should remain recommended on a 6 GB Forge-class machine.');
  assert.notStrictEqual(ponyFit.label, 'Recommended', 'SDXL/Pony XL should not be marked Recommended on 6 GB VRAM.');

  const originalFetch = global.fetch;
  const rvcSearchRequests = [];
  const firstRvcPageIds = Array.from({ length: 24 }, (_, index) => 'voice-maker/rvc-voice-' + String(index + 1).padStart(2, '0'));
  const secondRvcPageIds = Array.from({ length: 24 }, (_, index) => 'voice-maker/rvc-voice-' + String(index + 25).padStart(2, '0'));
  const allRvcPageIds = [...firstRvcPageIds, ...secondRvcPageIds];
  const rvcDetails = new Map(allRvcPageIds.map((id, index) => [id, {
    author: id.split('/')[0],
    id,
    pipeline_tag: 'audio-to-audio',
    siblings: [artifact('voices/Voice' + String(index + 1).padStart(2, '0') + '.pth', 0, { lfs: { size: 80_000_000 } })],
    tags: ['rvc', 'voice-model'],
  }]));
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/models') {
      const search = parsed.searchParams.get('search') || '';
      const cursor = parsed.searchParams.get('cursor') || '';
      rvcSearchRequests.push({ cursor, search });
      if (search === 'rvc') {
        const ids = cursor === 'cursor-page-2' ? secondRvcPageIds : firstRvcPageIds;
        const nextCursor = cursor === 'cursor-page-2' ? 'cursor-page-3' : 'cursor-page-2';
        return {
          ok: true,
          headers: { get: (name) => String(name).toLowerCase() === 'link' ? '<https://huggingface.co/api/models?cursor=' + nextCursor + '>; rel="next"' : null },
          json: async () => ids.map((id) => ({ id })),
        };
      }
      return { ok: true, headers: { get: () => null }, json: async () => [] };
    }
    if (parsed.pathname.startsWith('/api/models/')) {
      const modelId = decodeURIComponent(parsed.pathname.slice('/api/models/'.length));
      if (rvcDetails.has(modelId)) {
        return { ok: true, headers: { get: () => null }, json: async () => rvcDetails.get(modelId) };
      }
    }
    throw new Error('Unexpected fetch in RVC broad search verifier: ' + String(url));
  };
  try {
    const logger = { info: async () => {}, warn: async () => {} };
    const firstRvcSearch = await modelServiceTest.searchHuggingFaceModels(
      rvc,
      { cursor: null, limit: 24, modelType: 'rvc-voice', page: 1, query: 'rvc .pth', sort: 'most-downloaded', source: 'huggingface', taskType: 'voice-conversion' },
      new Set(),
      { disks: [], hardware: { vramMb: 6144, ramMb: 16384 } },
      logger,
    );
    assert.strictEqual(rvcSearchRequests[0].search, 'rvc', 'RVC user query rvc .pth should use the broad HF catalog query, not the narrow literal .pth query.');
    assert.strictEqual(firstRvcSearch.items.length, 24, 'RVC broad search should keep a full page of distinct compatible repositories.');
    assert.strictEqual(firstRvcSearch.pagination.hasMore, true, 'RVC broad search should preserve Hugging Face load-more metadata.');
    assert.strictEqual(firstRvcSearch.pagination.nextCursor, 'cursor-page-2', 'RVC broad search should preserve the HF cursor.');
    assert(firstRvcSearch.items.every((entry) => entry.downloadPlan?.runnable === true), 'RVC broad search should not require .index companions for runnable voice weights.');
    assert(firstRvcSearch.items.every((entry) => !/matching RVC index file will be downloaded/i.test(entry.downloadPlan?.warning || '')), 'RVC weights without indexes should remain installable without claiming an index companion.');
    const secondRvcSearch = await modelServiceTest.searchHuggingFaceModels(
      rvc,
      { cursor: firstRvcSearch.pagination.nextCursor, limit: 24, modelType: 'rvc-voice', page: 1, query: 'rvc .pth', sort: 'most-downloaded', source: 'huggingface', taskType: 'voice-conversion' },
      new Set(),
      { disks: [], hardware: { vramMb: 6144, ramMb: 16384 } },
      logger,
    );
    const firstIds = new Set(firstRvcSearch.items.map((entry) => entry.id));
    assert.strictEqual(secondRvcSearch.items.length, 24, 'RVC load more should keep another page of compatible repositories.');
    assert(secondRvcSearch.items.every((entry) => !firstIds.has(entry.id)), 'RVC load more should not collapse distinct repositories into the first page.');
    assert(rvcSearchRequests.some((request) => request.search === 'rvc' && request.cursor === 'cursor-page-2'), 'RVC load more should pass the HF cursor back to the broad RVC query.');
  } finally {
    global.fetch = originalFetch;
  }

  global.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.includes('/tree/main?recursive=true&expand=true')) {
      return {
        ok: true,
        json: async () => [
          { path: 'safety_checker/model.fp16.safetensors', type: 'file', size: 608_018_440 },
          { path: 'v1-5-pruned-emaonly.safetensors', type: 'file', size: 4_265_146_304 },
          { path: 'v1-5-pruned.safetensors', type: 'file', size: 7_704_222_607 },
        ],
      };
    }
    throw new Error('Unexpected fetch in model download plan verifier: ' + urlText);
  };
  try {
    const shallowDetail = {
      author: 'runwayml',
      id: 'stable-diffusion-v1-5/stable-diffusion-v1-5',
      library_name: 'diffusers',
      pipeline_tag: 'text-to-image',
      siblings: [artifact('safety_checker/model.fp16.safetensors', 608_018_440)],
      tags: ['diffusers', 'safetensors', 'stable-diffusion'],
    };
    const logger = { info: async () => {}, warn: async () => {} };
    const rvcDetail = {
      author: 'voice-maker',
      id: 'voice-maker/alice-rvc-voice-model',
      pipeline_tag: 'audio-to-audio',
      siblings: [
        artifact('Alice.pth', 12),
        artifact('logs/Alice/added_IVF.index', 11),
        artifact('samples/preview.wav', 2_000_000),
      ],
      tags: ['rvc', 'voice-conversion'],
    };
    const resolvedRvc = await modelServiceTest.resolveHuggingFaceDownloadFile(rvcDetail, 'rvc-voice', logger, rvc);
    assert(resolvedRvc, 'Hugging Face RVC repositories should resolve a clear .pth voice model artifact.');
    assert.strictEqual(resolvedRvc.rfilename, 'Alice.pth', 'RVC Hugging Face planning should pick the voice weight, not the index or preview.');
    assert.strictEqual(resolvedRvc.modelType, 'RVC Voice Model', 'RVC Hugging Face planning should type the artifact as a voice model.');
    assert(resolvedRvc.downloadPlan.optionalArtifacts.some((entry) => entry.path === 'logs/Alice/added_IVF.index'), 'RVC Hugging Face planning should report optional index companions.');

    const resolved = await modelServiceTest.resolveHuggingFaceDownloadFile(shallowDetail, 'all', logger, forge);
    assert(resolved, 'Hugging Face repo expansion should find a compatible checkpoint when the shallow sibling list only contains support files.');
    assert.strictEqual(resolved.rfilename, 'v1-5-pruned-emaonly.safetensors', 'Expanded Hugging Face planning should prefer the root EMA checkpoint over safety checker support files.');
    assert.strictEqual(resolved.downloadPlan.recommendedArtifactPath, resolved.rfilename, 'Resolved file and download plan should agree on the recommended artifact.');

    const forgeTool = {
      ...forge,
      appDir: 'D:/LocalAIHub/tools/forge/app',
      modelManager: {
        enabled: true,
        targetLayout: {
          basePath: 'app-dir',
          directories: {
            Checkpoint: 'models/Stable-diffusion',
            Inpainting: 'models/Stable-diffusion',
          },
        },
      },
    };
    const item = modelServiceTest.buildHuggingFaceRepositoryResult(
      shallowDetail,
      resolved,
      forgeTool,
      new Set(['safety_checker/model.fp16.safetensors', 'model.fp16.safetensors']),
      { disks: [], hardware: {} },
      null,
      null,
    );
    assert.strictEqual(item.fileName, 'v1-5-pruned-emaonly.safetensors', 'Model card file name should use the same compatible artifact that download execution will use.');
    assert.strictEqual(item.installRelativePath, 'v1-5-pruned-emaonly.safetensors', 'Model card install path should match the recommended checkpoint.');
    assert(item.downloadUrl.endsWith('/v1-5-pruned-emaonly.safetensors'), 'Download URL should point at the recommended checkpoint.');
    assert.strictEqual(item.downloaded, false, 'A previously downloaded safety checker support file must not mark the Forge checkpoint repository as installed.');
    assert(/v1-5-pruned-emaonly\.safetensors/.test(item.catalogContext), 'Card context should display the compatible checkpoint as the primary artifact.');

    const exactIdentity = modelServiceTest.buildSourceDownloadIdentity(item);
    const exactLookup = modelServiceTest.buildDownloadedLookup([{ downloadIdentity: exactIdentity, fileName: item.fileName, name: 'v1-5-pruned-emaonly', relativePath: item.installRelativePath, source: 'local' }]);
    const exactDownloadedItem = modelServiceTest.buildHuggingFaceRepositoryResult(shallowDetail, resolved, forgeTool, exactLookup, { disks: [], hardware: {} }, null, null);
    assert.strictEqual(exactDownloadedItem.downloaded, true, 'An exact Hugging Face repo/artifact identity should mark that card as downloaded.');
    const metadata = modelServiceTest.buildDownloadMetadata(forgeTool, item, { fileName: item.fileName, installRelativePath: item.installRelativePath });
    assert.strictEqual(metadata.downloadIdentity, exactIdentity, 'New downloads should persist source/repo/artifact identity metadata for future matching.');

    const legacyFilenameLookup = modelServiceTest.buildDownloadedLookup([{ fileName: item.fileName, name: 'v1-5-pruned-emaonly', relativePath: item.installRelativePath, source: 'local' }]);
    const legacyFilenameItem = modelServiceTest.buildHuggingFaceRepositoryResult(shallowDetail, resolved, forgeTool, legacyFilenameLookup, { disks: [], hardware: {} }, null, null);
    assert.strictEqual(legacyFilenameItem.downloaded, false, 'Metadata-less older files should not mark remote cards downloaded by filename alone.');

    const unrelatedDetail = { ...shallowDetail, id: 'alpacaml/stable-diffusion-v1-5', author: 'alpacaml' };
    const unrelatedItem = modelServiceTest.buildHuggingFaceRepositoryResult(unrelatedDetail, { ...resolved, rfilename: item.installRelativePath }, forgeTool, exactLookup, { disks: [], hardware: {} }, null, null);
    assert.strictEqual(unrelatedItem.downloaded, false, 'Different Hugging Face repos with the same artifact filename must not inherit downloaded state.');
  } finally {
    global.fetch = originalFetch;
  }

  const coreMlPlan = createModelDownloadPlan({
    tool: forge,
    source: 'huggingface',
    selectedType: 'all',
    artifacts: [artifact('Resources/weight.bin', 900_000_000, { modelType: 'Checkpoint' })],
  });
  assert.strictEqual(coreMlPlan.runnable, false, 'CoreML package weight.bin files must not be treated as Forge/A1111 runnable checkpoints.');

  const ggufImageTargetPlan = createModelDownloadPlan({
    tool: forge,
    source: 'huggingface',
    selectedType: 'all',
    artifacts: [artifact('Qwen2.5-1.5B-Instruct-Q4_K_M.gguf', 1_200_000_000)],
  });
  assert.strictEqual(ggufImageTargetPlan.runnable, false, 'GGUF files must be blocked for Forge/A1111 image targets.');
  assert(/KoboldCpp|LM Studio/i.test(ggufImageTargetPlan.blockingReason), 'GGUF/image target mismatch should suggest LLM targets.');

  const dreamShaperModel = {
    id: 4384,
    name: 'DreamShaper',
    type: 'Checkpoint',
    modelVersions: [
      {
        id: 128713,
        name: '8',
        publishedAt: '2023-09-01T00:00:00Z',
        files: [
          { name: 'preview.jpeg', sizeKB: 100, type: 'Image' },
          { name: 'dreamshaper_8.safetensors', sizeKB: 2_097_152, type: 'Model', primary: true },
        ],
      },
    ],
  };
  const dreamShaperFiles = modelServiceTest.collectCivitaiVersionFiles(dreamShaperModel, 'checkpoint', forge);
  assert.strictEqual(dreamShaperFiles[0]?.version?.name, '8', 'CivitAI model cards should retain the selected version label.');
  assert.strictEqual(dreamShaperFiles[0]?.file?.name, 'dreamshaper_8.safetensors', 'CivitAI model cards should retain the selected primary artifact.');
  assert.strictEqual(dreamShaperFiles[0]?.file?.downloadPlan?.recommendedArtifactPath, 'dreamshaper_8.safetensors', 'CivitAI selected artifact and download plan should agree.');

  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    const urlText = String(url);
    if (parsed.pathname === '/api/models') {
      const search = parsed.searchParams.get('search') || '';
      const results = /stable-diffusion-v1-5\/stable-diffusion-v1-5/i.test(search)
        ? [
            { id: 'stable-diffusion-v1-5/stable-diffusion-v1-5', private: false, gated: false },
            { id: 'apple/coreml-stable-diffusion-v1-5-palettized', private: false, gated: false },
          ]
        : [];
      return { ok: true, headers: { get: () => null }, json: async () => results };
    }
    if (urlText.includes('/api/models/stable-diffusion-v1-5/stable-diffusion-v1-5')) {
      return {
        ok: true,
        json: async () => ({
          author: 'runwayml',
          id: 'stable-diffusion-v1-5/stable-diffusion-v1-5',
          library_name: 'diffusers',
          pipeline_tag: 'text-to-image',
          siblings: [artifact('safety_checker/model.fp16.safetensors', 608_018_440)],
          tags: ['diffusers', 'safetensors', 'stable-diffusion'],
        }),
      };
    }
    if (urlText.includes('/api/models/apple/coreml-stable-diffusion-v1-5-palettized')) {
      return {
        ok: true,
        json: async () => ({
          author: 'apple',
          id: 'apple/coreml-stable-diffusion-v1-5-palettized',
          library_name: 'coreml',
          pipeline_tag: 'text-to-image',
          siblings: [artifact('Resources/weight.bin', 900_000_000)],
          tags: ['coreml', 'stable-diffusion'],
        }),
      };
    }
    if (urlText.includes('/api/models/stable-diffusion-v1-5/stable-diffusion-v1-5/tree/main')) {
      return {
        ok: true,
        json: async () => [
          { path: 'safety_checker/model.fp16.safetensors', type: 'file', size: 608_018_440 },
          { path: 'v1-5-pruned-emaonly.safetensors', type: 'file', size: 4_265_146_304 },
        ],
      };
    }
    if (urlText.includes('/api/models/apple/coreml-stable-diffusion-v1-5-palettized/tree/main')) {
      return { ok: true, json: async () => [{ path: 'Resources/weight.bin', type: 'file', size: 900_000_000 }] };
    }
    throw new Error('Unexpected fetch in HF repo grouping verifier: ' + urlText);
  };
  try {
    const logger = { info: async () => {}, warn: async () => {} };
    const groupedSearch = await modelServiceTest.searchHuggingFaceModels(
      forge,
      { cursor: null, limit: 12, modelType: 'all', page: 1, query: 'stable-diffusion-v1-5/stable-diffusion-v1-5', sort: 'most-downloaded', source: 'huggingface', taskType: 'image-generation' },
      new Set(),
      { disks: [], hardware: { vramMb: 6144, ramMb: 16384 } },
      logger,
    );
    assert.strictEqual(groupedSearch.items.length, 1, 'Exact Hugging Face repository searches should show one clean repo card when that repo is present.');
    assert.strictEqual(groupedSearch.items[0].id, 'huggingface:repository:stable-diffusion-v1-5/stable-diffusion-v1-5', 'Exact repo search should prefer the matching repository over related artifact/package repos.');
    assert.strictEqual(groupedSearch.items[0].catalogEntityType, 'repository', 'Stable Diffusion repo search should return a repository-level card, not artifact-level duplicates.');
    assert.strictEqual(groupedSearch.items[0].fileName, 'v1-5-pruned-emaonly.safetensors', 'Stable Diffusion repo card should display the selected compatible checkpoint.');
    assert.strictEqual(groupedSearch.items[0].downloadPlan.recommendedArtifactPath, 'v1-5-pruned-emaonly.safetensors', 'Displayed artifact and download plan should agree for repo cards.');
  } finally {
    global.fetch = originalFetch;
  }
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    const urlText = String(url);
    if (parsed.pathname === '/api/models') {
      const search = parsed.searchParams.get('search') || '';
      const results = /pony diffusion v6 xl/i.test(search)
        ? [{ id: 'example/Pony-Diffusion-V6-XL-GGUF', private: false, gated: false }]
        : [];
      return { ok: true, headers: { get: () => null }, json: async () => results };
    }
    if (urlText.includes('/api/models/example/Pony-Diffusion-V6-XL-GGUF')) {
      return {
        ok: true,
        json: async () => ({
          author: 'example',
          id: 'example/Pony-Diffusion-V6-XL-GGUF',
          library_name: 'gguf',
          pipeline_tag: 'text-generation',
          siblings: [
            artifact('pony-diffusion-v6-xl-Q4_K_M.gguf', 4_200_000_000),
            artifact('pony-diffusion-v6-xl-00001-of-00002.gguf', 2_000_000_000),
          ],
          tags: ['gguf'],
        }),
      };
    }
    throw new Error('Unexpected fetch in GGUF search verifier: ' + urlText);
  };
  try {
    const logger = { info: async () => {}, warn: async () => {} };
    const searchResult = await modelServiceTest.searchHuggingFaceModels(
      koboldcpp,
      { cursor: null, limit: 12, modelType: 'gguf', page: 1, query: 'pony-diffusion-v6-xl-Q4_K_M.gguf', sort: 'most-downloaded', source: 'huggingface', taskType: 'text-generation' },
      new Set(),
      { disks: [], hardware: { vramMb: 6144, ramMb: 16384 } },
      logger,
    );
    assert(searchResult.items.some((entry) => entry.fileName === 'pony-diffusion-v6-xl-Q4_K_M.gguf'), 'Hugging Face GGUF search should find exact filename-style queries through normalized fallback search.');
    assert(searchResult.items.every((entry) => entry.downloadPlan?.runnable !== false), 'Exact GGUF search results should not include blocked split artifacts when a matching single GGUF exists.');
  } finally {
    global.fetch = originalFetch;
  }
  const ollamaPlan = ollamaTagPlan('llama3.2:3b');
  assert.strictEqual(ollamaPlan.runnable, true, 'Ollama Library entries should be pullable tags.');
  assert.strictEqual(ollamaPlan.recommendedArtifactPath, 'llama3.2:3b', 'Ollama plan should preserve pull tag semantics.');

  console.log('Model download plan verification passed.');
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
