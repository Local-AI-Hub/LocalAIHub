const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { createModelDownloadPlan } = require('../electron/services/modelDownloadPlanService');
const modelService = require('../electron/services/modelService');
const { buildMergedToolStateList } = require('../electron/services/toolStateService');

function artifact(rfilename, sizeBytes = 0, extra = {}) {
  return { rfilename, sizeBytes, ...extra };
}

function assertInvokeAiApiPlan(plan, expectedPath, expectedType, label) {
  assert.strictEqual(plan.runnable, true, label + ' should be runnable for InvokeAI.');
  assert.strictEqual(plan.planType, 'api-import', label + ' should be an InvokeAI API import plan.');
  assert.strictEqual(plan.installStrategy, 'invokeai-api-import', label + ' should carry the InvokeAI API import strategy.');
  assert.strictEqual(plan.recommendedArtifactPath, expectedPath, label + ' should select the expected artifact.');
  assert.strictEqual(plan.modelType, expectedType, label + ' should preserve the selected model role.');
  assert(/InvokeAI.*model API/i.test(plan.warning), label + ' should explain that InvokeAI performs registration.');
}

async function main() {
  const manifestPath = path.resolve(__dirname, '..', 'electron', 'config', 'tools-manifest.json');
  const manifestTools = await fs.readJson(manifestPath);
  const invokeManifest = manifestTools.find((tool) => tool.id === 'invokeai');
  assert(invokeManifest, 'Expected InvokeAI to remain in the tool manifest.');
  assert.strictEqual(modelService.supportsModelManager(invokeManifest), true, 'InvokeAI should be exposed as a Model Manager target.');
  assert.strictEqual(invokeManifest.modelManager.targetLayout.basePath, 'install-dir', 'InvokeAI models must resolve from the InvokeAI root, not the app subfolder.');
  assert.deepStrictEqual(invokeManifest.modelManager.allowedModelTypes, ['all', 'checkpoint', 'inpainting', 'lora', 'controlnet', 'vae', 'embedding'], 'InvokeAI should expose only model types Local AI Hub imports through InvokeAI.');
  for (const type of ['Checkpoint', 'Inpainting', 'LoRA', 'ControlNet', 'VAE', 'Embedding']) {
    assert.strictEqual(invokeManifest.modelManager.targetLayout.directories[type], 'models', type + ' staging/listing should align with the InvokeAI root models folder.');
  }

  const invokeRoot = path.join(os.tmpdir(), 'local-ai-hub-invokeai-mm-test');
  const invokeTool = {
    id: 'invokeai',
    name: 'InvokeAI',
    installDir: invokeRoot,
    appDir: path.join(invokeRoot, 'app'),
    launchUrl: 'http://127.0.0.1:9090',
    modelManager: invokeManifest.modelManager,
  };
  const directories = modelService.getToolModelDirectories(invokeTool);
  for (const type of ['Checkpoint', 'Inpainting', 'LoRA', 'ControlNet', 'VAE', 'Embedding']) {
    assert.strictEqual(directories[type], path.join(invokeRoot, 'models'), 'InvokeAI ' + type + ' target directory should use installDir/models.');
  }

  const staleState = await buildMergedToolStateList({
    config: {
      tools: {
        invokeai: {
          id: 'invokeai',
          name: 'InvokeAI',
          source: 'managed',
          installDir: invokeRoot,
          appDir: path.join(invokeRoot, 'app'),
          venvDir: path.join(invokeRoot, '.venv'),
          modelManager: null,
        },
      },
    },
    includeSnapshots: false,
    resolveStatuses: false,
  });
  assert.strictEqual(staleState[0]?.modelManager?.enabled, true, 'Merged InvokeAI state should inherit manifest Model Manager support.');

  const checkpointPlan = createModelDownloadPlan({
    tool: invokeTool,
    source: 'huggingface',
    selectedType: 'checkpoint',
    artifacts: [
      artifact('feature_extractor/preprocessor_config.json', 1024),
      artifact('unet/diffusion_pytorch_model.safetensors', 2_000_000_000),
      artifact('v1-5-pruned-emaonly.safetensors', 4_200_000_000),
    ],
  });
  assertInvokeAiApiPlan(checkpointPlan, 'v1-5-pruned-emaonly.safetensors', 'Checkpoint', 'InvokeAI checkpoint');

  const inpaintPlan = createModelDownloadPlan({
    tool: invokeTool,
    source: 'huggingface',
    selectedType: 'inpainting',
    artifacts: [artifact('sd-v1-5-inpainting.ckpt', 4_300_000_000)],
  });
  assertInvokeAiApiPlan(inpaintPlan, 'sd-v1-5-inpainting.ckpt', 'Inpainting', 'InvokeAI inpainting checkpoint');

  const loraPlan = createModelDownloadPlan({
    tool: invokeTool,
    source: 'huggingface',
    selectedType: 'lora',
    artifacts: [artifact('loras/detail-tuner.safetensors', 150_000_000)],
  });
  assertInvokeAiApiPlan(loraPlan, 'loras/detail-tuner.safetensors', 'LoRA', 'InvokeAI LoRA');

  const controlNetPlan = createModelDownloadPlan({
    tool: invokeTool,
    source: 'civitai',
    selectedType: 'controlnet',
    artifacts: [artifact('control_v11p_sd15_canny.safetensors', 1_400_000_000, { modelType: 'ControlNet' })],
  });
  assertInvokeAiApiPlan(controlNetPlan, 'control_v11p_sd15_canny.safetensors', 'ControlNet', 'InvokeAI ControlNet');

  const vaePlan = createModelDownloadPlan({
    tool: invokeTool,
    source: 'huggingface',
    selectedType: 'vae',
    artifacts: [artifact('sdxl_vae.safetensors', 335_000_000)],
  });
  assertInvokeAiApiPlan(vaePlan, 'sdxl_vae.safetensors', 'VAE', 'InvokeAI VAE');

  const embeddingPlan = createModelDownloadPlan({
    tool: invokeTool,
    source: 'civitai',
    selectedType: 'embedding',
    artifacts: [artifact('embeddings/bad-artist.pt', 40_000, { modelType: 'TextualInversion' })],
  });
  assertInvokeAiApiPlan(embeddingPlan, 'embeddings/bad-artist.pt', 'Embedding', 'InvokeAI embedding');

  const diffusersPlan = createModelDownloadPlan({
    tool: invokeTool,
    source: 'huggingface',
    selectedType: 'checkpoint',
    artifacts: [artifact('unet/diffusion_pytorch_model.safetensors', 3_000_000_000), artifact('scheduler/scheduler_config.json', 1024)],
  });
  assert.strictEqual(diffusersPlan.runnable, false, 'InvokeAI should not claim diffusers component folders are single-file checkpoints.');
  assert(/Diffusers component/i.test(diffusersPlan.blockingReason), 'InvokeAI diffusers rejection should keep the existing component safeguard.');

  const controlNetFolderMemberPlan = createModelDownloadPlan({
    tool: invokeTool,
    source: 'huggingface',
    selectedType: 'controlnet',
    artifacts: [artifact('controlnet/diffusion_pytorch_model.safetensors', 1_400_000_000)],
  });
  assert.strictEqual(controlNetFolderMemberPlan.runnable, false, 'InvokeAI should not fake diffusers-folder ControlNet support by downloading one component file.');
  assert(/diffusers folder imports are not enabled/i.test(controlNetFolderMemberPlan.blockingReason), 'InvokeAI ControlNet folder-member rejection should be explicit.');

  const upscalerPlan = createModelDownloadPlan({
    tool: invokeTool,
    source: 'huggingface',
    selectedType: 'upscaler',
    artifacts: [artifact('RealESRGAN_x4plus.pth', 67_000_000)],
  });
  assert.strictEqual(upscalerPlan.runnable, false, 'InvokeAI upscaler imports should remain deferred.');
  assert(/not enabled for InvokeAI yet/i.test(upscalerPlan.blockingReason), 'Deferred InvokeAI types should be blocked clearly.');

  const forgePlan = createModelDownloadPlan({
    tool: { id: 'forge', name: 'Forge' },
    source: 'huggingface',
    selectedType: 'checkpoint',
    artifacts: [artifact('v1-5-pruned-emaonly.safetensors', 4_200_000_000)],
  });
  assert.strictEqual(forgePlan.runnable, true, 'Forge checkpoint planning should remain runnable.');
  assert.notStrictEqual(forgePlan.installStrategy, 'invokeai-api-import', 'Forge must not inherit InvokeAI import behavior.');

  const a1111Plan = createModelDownloadPlan({
    tool: { id: 'automatic1111', name: 'Automatic1111' },
    source: 'huggingface',
    selectedType: 'checkpoint',
    artifacts: [artifact('v1-5-pruned-emaonly.safetensors', 4_200_000_000)],
  });
  assert.strictEqual(a1111Plan.runnable, true, 'Automatic1111 checkpoint planning should remain runnable.');
  assert.notStrictEqual(a1111Plan.installStrategy, 'invokeai-api-import', 'Automatic1111 must remain copy-layout based.');

  const rvcPlan = createModelDownloadPlan({
    tool: { id: 'rvc', name: 'RVC' },
    source: 'huggingface',
    selectedType: 'rvc-voice',
    artifacts: [artifact('voices/Alice_RVC.pth', 120_000_000)],
  });
  assert.strictEqual(rvcPlan.runnable, true, 'RVC .pth planning should remain unchanged.');
  assert.strictEqual(rvcPlan.compatibleArtifacts[0]?.artifactKind, 'rvc-voice-model');

  const request = modelService._test.buildInvokeAiModelInstallRequest(invokeTool, path.join(invokeRoot, 'temp', 'model.safetensors'), {});
  assert.strictEqual(request.method, 'POST', 'InvokeAI imports should use the API install route.');
  assert(request.url.startsWith('http://127.0.0.1:9090/api/v2/models/install?'), 'InvokeAI import URL should target the local v2 model install API.');
  assert(request.url.includes('inplace=false'), 'InvokeAI import should let InvokeAI copy/register into its managed models folder.');
  assert.strictEqual(request.body, '{}', 'InvokeAI checkpoint import should accept auto-probed model config by default.');
  const loraImportConfig = modelService._test.buildInvokeAiModelImportConfig({ downloadPlan: loraPlan });
  assert.deepStrictEqual(loraImportConfig, { type: 'lora' }, 'InvokeAI accessory imports should pass a guarded model type override.');
  const loraRequest = modelService._test.buildInvokeAiModelInstallRequest(invokeTool, path.join(invokeRoot, 'temp', 'detail-tuner.safetensors'), loraImportConfig);
  assert.strictEqual(loraRequest.body, JSON.stringify({ type: 'lora' }), 'InvokeAI API request should serialize the accessory type override.');
  assert.deepStrictEqual(modelService._test.buildInvokeAiModelImportConfig({ downloadPlan: checkpointPlan }), {}, 'InvokeAI checkpoints should preserve existing auto-probe behavior.');
  assert.deepStrictEqual(modelService._test.buildInvokeAiModelImportConfig({ downloadPlan: inpaintPlan }), {}, 'InvokeAI inpainting checkpoints should preserve existing sibling/auto-probe behavior.');
  assert.strictEqual(modelService._test.isInvokeAiApiImportPayload(invokeTool, { downloadPlan: checkpointPlan }), true, 'InvokeAI downloader should be guarded by the API import plan flag.');
  assert.strictEqual(modelService._test.isInvokeAiApiImportPayload({ id: 'forge' }, { downloadPlan: checkpointPlan }), false, 'InvokeAI import guard must not match other tools.');
  assert(/disk full/i.test(modelService._test.buildInvokeAiInstallErrorMessage({ error: 'disk full' })), 'InvokeAI import errors should preserve the plain-English detail.');
  assert.strictEqual(modelService._test.normalizeInvokeAiModelType({ type: 'main', format: 'checkpoint', path: 'sd-1/main/model.safetensors' }), 'Checkpoint');
  assert.strictEqual(modelService._test.normalizeInvokeAiModelType({ type: 'main', format: 'checkpoint', path: 'sd-1/main/inpaint.ckpt' }), 'Inpainting');
  assert.strictEqual(modelService._test.normalizeInvokeAiModelType({ type: 'lora', path: 'sdxl/lora/detail.safetensors' }), 'LoRA');
  assert.strictEqual(modelService._test.normalizeInvokeAiModelType({ type: 'controlnet', path: 'sd-1/controlnet/canny.safetensors' }), 'ControlNet');
  assert.strictEqual(modelService._test.normalizeInvokeAiModelType({ type: 'vae', path: 'sdxl/vae/vae.safetensors' }), 'VAE');
  assert.strictEqual(modelService._test.normalizeInvokeAiModelType({ type: 'embedding', path: 'sd-1/embedding/token.pt' }), 'Embedding');
  assert.strictEqual(modelService._test.resolveInvokeAiModelPath(invokeTool, { path: 'sd-1/main/model.safetensors' }), path.join(invokeRoot, 'models', 'sd-1', 'main', 'model.safetensors'));

  console.log('InvokeAI Model Manager verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});