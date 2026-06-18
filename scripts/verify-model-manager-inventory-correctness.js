const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const modelService = require('../electron/services/modelService');
const manifestTools = require('../electron/config/tools-manifest.json');

const {
  buildExpectedDownloadIdentity,
  collectCivitaiVersionFiles,
  resolveModelDestination,
  writeModelMetadata,
} = modelService._test;

function manifestTool(id, root) {
  const manifest = manifestTools.find((entry) => entry.id === id);
  assert(manifest, 'Missing manifest tool: ' + id);
  return {
    ...manifest,
    appDir: id === 'invokeai' ? path.join(root, 'app') : root,
    installDir: root,
    status: 'stopped',
  };
}

async function writeModel(filePath, content = 'model') {
  await fs.outputFile(filePath, content);
}

function countPath(models, fileName) {
  return models.filter((model) => model.fileName === fileName).length;
}

async function verifySharedDirectoryInventory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-inventory-'));
  try {
    const a1111 = manifestTool('automatic1111', path.join(root, 'automatic1111'));
    await writeModel(path.join(a1111.appDir, 'models', 'Stable-diffusion', 'plain.safetensors'));
    await writeModel(path.join(a1111.appDir, 'models', 'Stable-diffusion', 'portrait-inpainting.safetensors'));
    const a1111Models = await modelService.listDownloadedModels(a1111);
    assert.strictEqual(countPath(a1111Models, 'plain.safetensors'), 1, 'A1111 shared checkpoint/inpainting folder must list a plain checkpoint once.');
    assert.strictEqual(a1111Models.find((model) => model.fileName === 'plain.safetensors')?.modelType, 'Checkpoint', 'A1111 ambiguous shared-folder model should fall back to Checkpoint.');
    assert.strictEqual(a1111Models.find((model) => model.fileName === 'portrait-inpainting.safetensors')?.modelType, 'Inpainting', 'A1111 explicit inpainting evidence should still classify as Inpainting.');

    const forge = manifestTool('forge', path.join(root, 'forge'));
    await writeModel(path.join(forge.appDir, 'models', 'Stable-diffusion', 'plain.safetensors'));
    const forgeModels = await modelService.listDownloadedModels(forge);
    assert.strictEqual(countPath(forgeModels, 'plain.safetensors'), 1, 'Forge shared checkpoint/inpainting folder must list a plain checkpoint once.');
    assert.strictEqual(forgeModels[0]?.modelType, 'Checkpoint', 'Forge ambiguous shared-folder model should fall back to Checkpoint.');

    const comfy = manifestTool('comfyui', path.join(root, 'comfyui'));
    await writeModel(path.join(comfy.appDir, 'models', 'checkpoints', 'plain.safetensors'));
    const comfyModels = await modelService.listDownloadedModels(comfy);
    assert.strictEqual(countPath(comfyModels, 'plain.safetensors'), 1, 'ComfyUI shared checkpoint/inpainting folder must list a plain checkpoint once.');
    assert.strictEqual(comfyModels[0]?.modelType, 'Checkpoint', 'ComfyUI ambiguous shared-folder model should fall back to Checkpoint.');

    const invoke = manifestTool('invokeai', path.join(root, 'invokeai'));
    await writeModel(path.join(invoke.installDir, 'models', 'plain.safetensors'));
    await writeModel(path.join(invoke.installDir, 'models', 'loras', 'detail-lora.safetensors'));
    const invokeModels = await modelService.listDownloadedModels(invoke);
    assert.strictEqual(countPath(invokeModels, 'plain.safetensors'), 1, 'InvokeAI offline fallback must not list one flat file once per logical type.');
    assert.strictEqual(invokeModels.find((model) => model.fileName === 'plain.safetensors')?.modelType, 'Checkpoint', 'InvokeAI ambiguous offline file should fall back to Checkpoint.');
    assert.strictEqual(invokeModels.find((model) => model.fileName === 'detail-lora.safetensors')?.modelType, 'LoRA', 'InvokeAI offline fallback should use explicit path evidence when available.');
    assert.strictEqual(new Set(invokeModels.map((model) => model.path)).size, invokeModels.length, 'InvokeAI offline fallback should not duplicate physical paths.');

    const caseRoot = path.join(root, 'case-variant');
    const caseTool = {
      id: 'case-variant-tool',
      name: 'Case Variant Tool',
      appDir: caseRoot,
      installDir: caseRoot,
      modelManager: {
        enabled: true,
        targetLayout: {
          basePath: 'app-dir',
          directories: {
            Checkpoint: 'Models',
            Inpainting: 'models',
          },
        },
      },
    };
    await writeModel(path.join(caseRoot, 'Models', 'plain.safetensors'));
    const caseModels = await modelService.listDownloadedModels(caseTool);
    assert(caseModels.length <= 1, 'Case-variant physical paths should not multiply one model on Windows.');
  } finally {
    await fs.remove(root);
  }
}

function civitaiFixture(parentType, fileName, fileType = 'Model') {
  return {
    id: 'model-' + parentType,
    name: parentType + ' example',
    type: parentType,
    modelVersions: [
      {
        id: 'version-' + parentType,
        name: 'v1',
        publishedAt: '2026-01-01T00:00:00.000Z',
        files: [
          {
            id: 'file-' + parentType,
            name: fileName,
            type: fileType,
            primary: true,
            sizeKB: 1024,
            downloadUrl: 'https://example.invalid/' + encodeURIComponent(fileName),
          },
        ],
      },
    ],
  };
}

async function verifyCivitaiParentTypeClassification() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-civitai-'));
  try {
    const tool = manifestTool('automatic1111', root);
    const cases = [
      { parentType: 'Checkpoint', selectedType: 'checkpoint', expectedType: 'Checkpoint', fileName: 'neutral.safetensors' },
      { parentType: 'LORA', selectedType: 'lora', expectedType: 'LoRA', fileName: 'neutral.safetensors' },
      { parentType: 'VAE', selectedType: 'vae', expectedType: 'VAE', fileName: 'neutral.safetensors' },
      { parentType: 'ControlNet', selectedType: 'controlnet', expectedType: 'ControlNet', fileName: 'neutral.safetensors' },
      { parentType: 'TextualInversion', selectedType: 'embedding', expectedType: 'Embedding', fileName: 'neutral.pt' },
      { parentType: 'Upscaler', selectedType: 'upscaler', expectedType: 'Upscaler', fileName: 'neutral.safetensors' },
    ];
    for (const testCase of cases) {
      const files = collectCivitaiVersionFiles(civitaiFixture(testCase.parentType, testCase.fileName), testCase.selectedType, tool);
      assert.strictEqual(files.length, 1, testCase.parentType + ' with generic file.type=Model should produce a candidate.');
      assert.strictEqual(files[0].file.modelType, testCase.expectedType, testCase.parentType + ' should keep the parent-derived type.');
      assert.strictEqual(files[0].file.downloadPlan?.runnable, true, testCase.parentType + ' candidate should remain runnable for its supported filter.');
    }

    const unsupported = collectCivitaiVersionFiles(civitaiFixture('Other', 'neutral.safetensors'), 'lora', tool);
    assert.strictEqual(unsupported.length, 0, 'Generic unsupported CivitAI type should not be advertised as LoRA.');

    const specificFileType = collectCivitaiVersionFiles(civitaiFixture('LORA', 'actually-a-vae.safetensors', 'VAE'), 'vae', tool);
    assert.strictEqual(specificFileType.length, 1, 'Specific CivitAI file.type should override a broader parent type.');
    assert.strictEqual(specificFileType[0].file.modelType, 'VAE', 'Specific CivitAI file.type should be preserved when useful.');
  } finally {
    await fs.remove(root);
  }
}

function remotePayload(tool, repositoryId, name = 'Shared Name') {
  return {
    id: 'huggingface:repository:' + repositoryId,
    catalogEntityType: 'repository',
    catalogRepositoryId: repositoryId,
    downloadUrl: 'https://example.invalid/model.safetensors',
    fileName: 'model.safetensors',
    installRelativePath: 'model.safetensors',
    modelType: 'Checkpoint',
    name,
    sizeBytes: 1024,
    source: 'huggingface',
    sourceArtifactPath: 'model.safetensors',
    toolId: tool.id,
  };
}

async function verifySameFilenameIdentityConflicts() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-identity-'));
  try {
    const tool = manifestTool('automatic1111', root);
    const firstPayload = remotePayload(tool, 'publisher/first', 'First Model');
    const destination = resolveModelDestination(tool, firstPayload);
    await writeModel(destination.destinationPath, 'first');
    const firstIdentity = buildExpectedDownloadIdentity(tool, firstPayload, destination);
    await writeModelMetadata(destination.destinationPath, {
      downloadIdentity: firstIdentity,
      fileName: destination.fileName,
      installRelativePath: destination.installRelativePath,
      modelType: 'Checkpoint',
      source: 'huggingface',
      toolId: tool.id,
    });

    const already = await modelService.downloadModel(tool, firstPayload);
    assert.strictEqual(already.alreadyPresent, true, 'Same source identity should still be recognized as already installed.');

    const secondPayload = remotePayload(tool, 'publisher/second', 'Second Model');
    await assert.rejects(
      () => modelService.downloadModel(tool, secondPayload),
      /different model named (?:model\.safetensors|<private-file>).*will not overwrite or relabel/i,
      'Different source identity with the same filename should be blocked clearly.',
    );

    await fs.remove(destination.destinationPath + '.localaihub.json');
    await assert.rejects(
      () => modelService.downloadModel(tool, firstPayload),
      /cannot confirm it is the same model.*Rename or delete/i,
      'Existing file without identity metadata should not be silently relabelled.',
    );

    const safeDestination = resolveModelDestination(tool, { ...firstPayload, installRelativePath: '..\\outside.safetensors', fileName: '..\\outside.safetensors' });
    const relative = path.relative(safeDestination.targetDirectory, safeDestination.destinationPath);
    assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'Path normalization must keep suspicious install paths inside the target directory.');
  } finally {
    await fs.remove(root);
  }
}

async function main() {
  await verifySharedDirectoryInventory();
  await verifyCivitaiParentTypeClassification();
  await verifySameFilenameIdentityConflicts();
  console.log('Model Manager inventory and identity correctness verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});