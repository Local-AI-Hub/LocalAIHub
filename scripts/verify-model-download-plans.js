const assert = require('assert');
const { createModelDownloadPlan, ollamaTagPlan } = require('../electron/services/modelDownloadPlanService');
const { _test: modelServiceTest } = require('../electron/services/modelService');

const forge = { id: 'forge', name: 'Stable Diffusion WebUI Forge' };
const automatic1111 = { id: 'automatic1111', name: 'Automatic1111' };
const comfyui = { id: 'comfyui', name: 'ComfyUI' };
const koboldcpp = { id: 'koboldcpp', name: 'KoboldCpp' };
const lmstudio = { id: 'lmstudio', name: 'LM Studio' };

function artifact(rfilename, sizeBytes = 0, extra = {}) {
  return { rfilename, sizeBytes, ...extra };
}

function assertRecommended(plan, expectedPath, message) {
  assert.strictEqual(plan.runnable, true, message + ' should be runnable.');
  assert.strictEqual(plan.recommendedArtifactPath, expectedPath, message + ' should pick the expected artifact.');
}

async function main() {
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
