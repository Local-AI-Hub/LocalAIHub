const assert = require('assert');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const modelService = require('../electron/services/modelService');
const { createModelDownloadPlan } = require('../electron/services/modelDownloadPlanService');

const {
  buildDiskBlockedMessage,
  buildModelDownloadPreflight,
  streamDownloadToFile,
} = modelService._test;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseFromBytes(bytes, headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(bytes));
      controller.close();
    },
  }), { status: 200, headers });
}

async function expectRejectsWith(promise, pattern, label) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert(error, `${label} should reject.`);
  assert.match(String(error.message || error), pattern, label);
}

function audiocraftTool(root) {
  return {
    id: 'audiocraft-webui',
    name: 'AudioCraft WebUI',
    appDir: root,
    installDir: root,
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
}

async function writePackageManifest(root, options = {}) {
  const packageRoot = path.join(root, 'models', 'audiocraft', 'musicgen-medium');
  await fs.ensureDir(packageRoot);
  const manifestPath = path.join(packageRoot, '.localaihub-package.json');
  const installedFiles = [
    { fileName: 'state_dict.bin', installRelativePath: 'state_dict.bin', path: 'state_dict.bin', required: true, sizeBytes: 4 },
    { fileName: 'compression_state_dict.bin', installRelativePath: 'compression_state_dict.bin', path: 'compression_state_dict.bin', required: true, sizeBytes: 4 },
    { fileName: 'README.md', installRelativePath: 'README.md', path: 'README.md', required: false, sizeBytes: 4 },
  ];
  await fs.writeJson(manifestPath, {
    schemaVersion: 2,
    downloadIdentity: 'huggingface|audiocraft-webui|repo:facebook/musicgen-medium|artifact:hf:facebook/musicgen-medium:audiocraft-snapshot',
    installedFiles,
    downloadFiles: installedFiles,
    requiredFiles: installedFiles.filter((entry) => entry.required).map((entry) => ({ installRelativePath: entry.installRelativePath })),
    modelType: 'Audio / Speech',
    packageIdentity: 'hf:facebook/musicgen-medium:audiocraft-snapshot',
    packageName: 'musicgen-medium',
    packageRoot: 'audiocraft/musicgen-medium',
    packageRootPath: packageRoot,
    source: 'huggingface',
    toolId: 'audiocraft-webui',
  }, { spaces: 2 });
  for (const file of options.files || []) {
    await fs.outputFile(path.join(packageRoot, file), Buffer.from(file));
  }
  return { manifestPath, packageRoot };
}

async function verifyPackageReconciliation() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-package-integrity-'));
  try {
    const tool = audiocraftTool(root);

    await writePackageManifest(root, { files: ['state_dict.bin', 'compression_state_dict.bin'] });
    let models = await modelService.listDownloadedModels(tool);
    let pkg = models.find((model) => model.packageIdentity === 'hf:facebook/musicgen-medium:audiocraft-snapshot');
    assert(pkg, 'Complete package should be listed.');
    assert.strictEqual(pkg.downloaded, true, 'Complete package should be installed.');
    assert.strictEqual(pkg.damaged, false, 'Complete package should not be damaged when optional README is missing.');

    await fs.remove(root);
    await fs.ensureDir(root);
    await writePackageManifest(root, { files: ['state_dict.bin'] });
    models = await modelService.listDownloadedModels(tool);
    pkg = models.find((model) => model.packageIdentity === 'hf:facebook/musicgen-medium:audiocraft-snapshot');
    assert(pkg, 'Partial package with one required file should be visible for cleanup.');
    assert.strictEqual(pkg.downloaded, false, 'Partial package must not be marked installed.');
    assert.strictEqual(pkg.damaged, true, 'Partial package should be damaged/incomplete.');
    assert(pkg.missingRequiredFiles.includes('compression_state_dict.bin'), 'Damaged package should report the missing required file.');
    assert(/incomplete/i.test(pkg.statusMessage || ''), 'Damaged package should have an actionable plain-English message.');

    await fs.remove(root);
    await fs.ensureDir(root);
    await writePackageManifest(root, { files: [] });
    models = await modelService.listDownloadedModels(tool);
    pkg = models.find((model) => model.packageIdentity === 'hf:facebook/musicgen-medium:audiocraft-snapshot');
    assert.strictEqual(pkg, undefined, 'Package with no required files left should not be listed as installed.');

    const forgeRoot = path.join(root, 'forge');
    const forge = {
      id: 'forge',
      name: 'Forge',
      appDir: forgeRoot,
      installDir: forgeRoot,
      modelManager: { enabled: true, targetLayout: { basePath: 'app-dir', directories: { Checkpoint: 'models/Stable-diffusion' } } },
    };
    await fs.outputFile(path.join(forgeRoot, 'models', 'Stable-diffusion', 'plain.safetensors'), 'single');
    const forgeModels = await modelService.listDownloadedModels(forge);
    assert(forgeModels.some((model) => model.fileName === 'plain.safetensors' && model.downloaded === true), 'Single-file model detection should still work.');
  } finally {
    await fs.remove(root).catch(() => null);
  }
}

async function verifyTransferIntegrity() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-transfer-integrity-'));
  const originalFetch = global.fetch;
  try {
    const destination = path.join(root, 'model.safetensors');
    global.fetch = async () => responseFromBytes('abcd', { 'content-length': '4' });
    let result = await streamDownloadToFile('https://example.test/model.safetensors', destination, { expectedBytes: 4, displayName: 'model.safetensors' });
    assert.strictEqual(result.sizeVerified, true, 'Expected-size transfer should report size verification.');
    assert.strictEqual(await fs.readFile(destination, 'utf8'), 'abcd', 'Exact expected-size transfer should install final file.');

    await fs.remove(destination);
    global.fetch = async () => responseFromBytes('ab', { 'content-length': '2' });
    await expectRejectsWith(
      streamDownloadToFile('https://example.test/model.safetensors', destination, { expectedBytes: 4, displayName: 'model.safetensors' }),
      /integrity check.*Expected 4 B.*received 2 B/i,
      'Truncated transfer with expected size',
    );
    assert.strictEqual(await fs.pathExists(destination), false, 'Truncated transfer should not move into final location.');
    assert.strictEqual(await fs.pathExists(destination + '.download'), false, 'Truncated transfer should clean the temp file.');

    global.fetch = async () => responseFromBytes('abcdef', { 'content-length': '6' });
    await expectRejectsWith(
      streamDownloadToFile('https://example.test/model.safetensors', destination, { expectedBytes: 4, displayName: 'model.safetensors' }),
      /more data than expected/i,
      'Oversized transfer with expected size',
    );

    const sha = crypto.createHash('sha256').update('hash-ok').digest('hex');
    global.fetch = async () => responseFromBytes('hash-ok', { 'content-length': '7' });
    result = await streamDownloadToFile('https://example.test/hash.safetensors', destination, { expectedSha256: sha, displayName: 'hash.safetensors' });
    assert.strictEqual(result.hashVerified, true, 'Checksum match should report hash verification.');

    global.fetch = async () => responseFromBytes('hash-bad', { 'content-length': '8' });
    await expectRejectsWith(
      streamDownloadToFile('https://example.test/hash.safetensors', destination, { expectedSha256: sha, displayName: 'hash.safetensors' }),
      /sha-256 checksum did not match/i,
      'Checksum mismatch',
    );

    global.fetch = async () => responseFromBytes('unknown');
    result = await streamDownloadToFile('https://example.test/unknown.safetensors', destination, { displayName: 'unknown.safetensors' });
    assert.strictEqual(result.sizeVerified, false, 'No-size/no-hash transfer should not claim size verification.');
    assert.strictEqual(result.hashVerified, false, 'No-size/no-hash transfer should not claim hash verification.');

    const toolRoot = path.join(root, 'comfy');
    const tool = { id: 'comfyui', name: 'ComfyUI', appDir: toolRoot, installDir: toolRoot, modelManager: { enabled: true, targetLayout: { basePath: 'app-dir', directories: { Checkpoint: 'models/checkpoints' } } } };
    const payload = { id: 'integrity-lock', name: 'Integrity Lock', modelType: 'Checkpoint', fileName: 'integrity-lock.safetensors', downloadUrl: 'https://example.test/integrity-lock.safetensors', sizeBytes: 4, source: 'huggingface', toolId: 'comfyui', lowDiskConfirmed: true };
    global.fetch = async () => responseFromBytes('xx', { 'content-length': '2' });
    await expectRejectsWith(modelService.downloadModel(tool, payload), /integrity check/i, 'DownloadModel integrity failure');
    global.fetch = async () => responseFromBytes('good', { 'content-length': '4' });
    const retry = await modelService.downloadModel(tool, payload);
    assert.strictEqual(retry.alreadyPresent, false, 'Download lock should release after integrity failure.');
  } finally {
    global.fetch = originalFetch;
    await fs.remove(root).catch(() => null);
  }
}

function invokeTool() {
  return {
    id: 'invokeai',
    name: 'InvokeAI',
    installDir: 'D:\\InvokeAI',
    appDir: 'D:\\InvokeAI\\app',
    modelManager: {
      enabled: true,
      targetLayout: {
        basePath: 'install-dir',
        directories: {
          Checkpoint: 'models',
          LoRA: 'models',
        },
      },
    },
  };
}

function invokePayload(sizeBytes = 100) {
  return {
    id: 'invokeai-test',
    name: 'InvokeAI test',
    modelType: 'Checkpoint',
    fileName: 'model.safetensors',
    installRelativePath: 'model.safetensors',
    sizeBytes,
    downloadPlan: { installStrategy: 'invokeai-api-import', runnable: true, modelType: 'Checkpoint' },
  };
}

async function verifyInvokeAiPreflight() {
  const tool = invokeTool();
  const payload = invokePayload(100);
  const roomyD = { mount: 'D:\\', sizeBytes: 1000, usedBytes: 100, freeBytes: 900 };
  const tightD = { mount: 'D:\\', sizeBytes: 1000, usedBytes: 950, freeBytes: 50 };
  const roomyC = { mount: 'C:\\', sizeBytes: 1000, usedBytes: 100, freeBytes: 900 };
  const tightC = { mount: 'C:\\', sizeBytes: 1000, usedBytes: 950, freeBytes: 50 };

  let preflight = await buildModelDownloadPreflight(tool, payload, { disks: [tightC, roomyD], stagePath: 'C:\\LocalAIHub\\temp\\model.safetensors' });
  assert.strictEqual(preflight.blocked, true, 'Staging shortage should block InvokeAI import preflight.');
  assert.match(buildDiskBlockedMessage(preflight), /temporary staging folder.*C:\\/i, 'Staging shortage message should name staging path/drive.');

  preflight = await buildModelDownloadPreflight(tool, payload, { disks: [roomyC, tightD], stagePath: 'C:\\LocalAIHub\\temp\\model.safetensors' });
  assert.strictEqual(preflight.blocked, true, 'Final destination shortage should block InvokeAI import preflight.');
  assert.match(buildDiskBlockedMessage(preflight), /final model folder.*D:\\/i, 'Final shortage message should name final path/drive.');

  preflight = await buildModelDownloadPreflight(tool, payload, { disks: [roomyC, roomyD], stagePath: 'C:\\LocalAIHub\\temp\\model.safetensors' });
  assert.strictEqual(preflight.blocked, false, 'InvokeAI import preflight should pass when staging and final drives have space.');

  preflight = await buildModelDownloadPreflight(tool, invokePayload(300), { disks: [{ mount: 'D:\\', sizeBytes: 1000, usedBytes: 500, freeBytes: 500 }], stagePath: 'D:\\LocalAIHub\\temp\\model.safetensors' });
  assert.strictEqual(preflight.blocked, true, 'Same-drive InvokeAI workflow should account for temporary duplication.');
  assert.strictEqual(preflight.requiredBytes, 600, 'Same-drive staging/final preflight should sum staging and final requirements.');
}

function assertPlanBlocked(plan, pattern, label) {
  assert.strictEqual(plan.runnable, false, `${label} should be blocked.`);
  assert.match(plan.blockingReason || '', pattern, label);
}

function verifyPytorchClassification() {
  const forge = { id: 'forge', name: 'Forge' };
  let plan = createModelDownloadPlan({ tool: forge, source: 'huggingface', selectedType: 'upscaler', artifacts: [{ rfilename: 'arbitrary_weights.pt', sizeBytes: 1000 }] });
  assertPlanBlocked(plan, /not clearly labeled.*arbitrary PyTorch weight files as upscalers/i, 'Ambiguous .pt');

  plan = createModelDownloadPlan({ tool: forge, source: 'huggingface', selectedType: 'upscaler', artifacts: [{ rfilename: 'arbitrary_weights.pth', sizeBytes: 1000 }] });
  assertPlanBlocked(plan, /not clearly labeled.*arbitrary PyTorch weight files as upscalers/i, 'Ambiguous .pth');

  plan = createModelDownloadPlan({ tool: forge, source: 'huggingface', selectedType: 'upscaler', artifacts: [{ rfilename: 'arbitrary_weights.pt', sizeBytes: 1000, modelType: 'Upscaler' }] });
  assert.strictEqual(plan.runnable, true, 'Explicit upscaler .pt should remain supported.');
  assert.strictEqual(plan.modelType, 'Upscaler');

  plan = createModelDownloadPlan({ tool: forge, source: 'huggingface', selectedType: 'upscaler', artifacts: [{ rfilename: 'RealESRGAN_x4plus.pth', sizeBytes: 1000 }] });
  assert.strictEqual(plan.runnable, true, 'Strong filename/context upscaler .pth should remain supported.');
  assert.strictEqual(plan.modelType, 'Upscaler');

  plan = createModelDownloadPlan({ tool: forge, source: 'huggingface', selectedType: 'checkpoint', artifacts: [{ rfilename: 'model.safetensors', sizeBytes: 1000 }] });
  assert.strictEqual(plan.runnable, true, 'Supported safetensors checkpoint should remain green.');
  plan = createModelDownloadPlan({ tool: forge, source: 'huggingface', selectedType: 'lora', artifacts: [{ rfilename: 'loras/detail-lora.safetensors', sizeBytes: 1000 }] });
  assert.strictEqual(plan.runnable, true, 'Supported LoRA safetensors should remain green.');
}

async function main() {
  await verifyPackageReconciliation();
  console.log('Package reconciliation checks passed.');
  await verifyTransferIntegrity();
  console.log('Transfer integrity checks passed.');
  await verifyInvokeAiPreflight();
  console.log('InvokeAI staging/final preflight checks passed.');
  verifyPytorchClassification();
  console.log('PyTorch weight classification checks passed.');
  console.log('Model Manager integrity/preflight verifier passed.');
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});