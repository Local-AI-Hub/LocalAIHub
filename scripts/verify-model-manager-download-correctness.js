const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const modelService = require('../electron/services/modelService');
const { createModelDownloadPlan } = require('../electron/services/modelDownloadPlanService');

const { readOllamaPullStream } = modelService._test;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textStream(chunks, delayMs = 0) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs) {
          await sleep(delayMs);
        }
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function responseFromChunks(chunks, delayMs = 0, headers = {}) {
  return new Response(textStream(chunks, delayMs), {
    status: 200,
    headers,
  });
}

function remoteTool(root) {
  return {
    id: 'comfyui',
    name: 'ComfyUI',
    appDir: root,
    installDir: root,
    status: 'stopped',
    modelManager: {
      enabled: true,
      targetLayout: {
        basePath: 'app-dir',
        directories: {
          Checkpoint: 'models/checkpoints',
        },
      },
    },
  };
}

function remotePayload(id, fileName) {
  return {
    id,
    name: fileName.replace(/\.safetensors$/i, ''),
    modelType: 'Checkpoint',
    fileName,
    downloadUrl: `https://example.test/${fileName}`,
    sizeBytes: 4,
    source: 'huggingface',
    provider: 'huggingface',
    lowDiskConfirmed: true,
  };
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

async function verifyDownloadExecutionLocking() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-download-lock-'));
  const originalFetch = global.fetch;
  try {
    const tool = remoteTool(root);
    const payload = remotePayload('same-model', 'same-model.safetensors');
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      return responseFromChunks(['mo', 'del'], 20, { 'content-length': '4' });
    };

    const first = modelService.downloadModel(tool, payload);
    const second = modelService.downloadModel(tool, payload);
    const [firstResult, secondResult] = await Promise.all([
      first,
      second.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      ),
    ]);

    assert.strictEqual(firstResult.alreadyPresent, false, 'The first download should complete normally.');
    assert.strictEqual(secondResult.ok, false, 'The second concurrent download should be rejected by the lock.');
    assert.match(secondResult.error.message, /already in progress/i, 'The duplicate download should use a plain-English in-progress message.');
    assert.strictEqual(fetchCount, 1, 'The locked duplicate should not start a second network transfer.');

    const alreadyPresent = await modelService.downloadModel(tool, payload);
    assert.strictEqual(alreadyPresent.alreadyPresent, true, 'The lock should release after a successful download.');

    const failurePayload = remotePayload('failure-model', 'failure-model.safetensors');
    global.fetch = async () => new Response('temporary outage', { status: 503 });
    await expectRejectsWith(modelService.downloadModel(tool, failurePayload), /could not be downloaded|Download failed/i, 'A failed download');
    global.fetch = async () => responseFromChunks(['ok'], 0, { 'content-length': '2' });
    const retryResult = await modelService.downloadModel(tool, failurePayload);
    assert.strictEqual(retryResult.alreadyPresent, false, 'The lock should release after a failed download.');

    const payloadA = remotePayload('parallel-a', 'parallel-a.safetensors');
    const payloadB = remotePayload('parallel-b', 'parallel-b.safetensors');
    let parallelFetchCount = 0;
    global.fetch = async () => {
      parallelFetchCount += 1;
      return responseFromChunks(['data'], 10, { 'content-length': '4' });
    };
    await Promise.all([
      modelService.downloadModel(tool, payloadA),
      modelService.downloadModel(tool, payloadB),
    ]);
    assert.strictEqual(parallelFetchCount, 2, 'Different model destinations should not block one another.');
  } finally {
    global.fetch = originalFetch;
    await fs.remove(root).catch(() => null);
  }
}

async function verifyOllamaStreamedErrors() {
  assert.strictEqual(typeof readOllamaPullStream, 'function', 'Ollama stream parser should be exported for focused verification.');
  const payload = { id: 'ollama:tiny', name: 'tiny:latest' };
  const progress = [];
  await readOllamaPullStream(
    responseFromChunks([
      '{"status":"pulling manifest"}\n',
      '{"status":"downloading","completed":5,"total":10}\n',
      '{"status":"success"}\n',
    ]),
    payload,
    { onProgress: (event) => progress.push(event) },
  );
  assert(progress.some((event) => event.percent === 50), 'Ollama pull progress should still be emitted.');

  await expectRejectsWith(
    readOllamaPullStream(responseFromChunks(['{"error":"disk full"}\n']), payload),
    /could not be pulled from Ollama right now\. disk full/i,
    'A streamed Ollama error frame',
  );
  await expectRejectsWith(
    readOllamaPullStream(responseFromChunks(['{"error":"model not found"}']), payload),
    /model not found/i,
    'A trailing un-newlined Ollama error frame',
  );
  await expectRejectsWith(
    readOllamaPullStream(responseFromChunks(['not-json\n{"status":"downloading","completed":10,"total":10}\n']), payload),
    /before confirming the model was ready/i,
    'A stream without final success',
  );

  await readOllamaPullStream(responseFromChunks(['not-json\n{"status":"success"}\n']), payload);
}

function wanTool(root) {
  return {
    id: 'wan21-webui',
    name: 'Wan2.1 WebUI',
    appDir: root,
    installDir: root,
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
}

function artifact(rfilename, sizeBytes = 10) {
  return { rfilename, sizeBytes };
}

function wanPlan(root, artifacts, repositoryId = 'Wan-AI/Wan2.1-T2V-1.3B') {
  return createModelDownloadPlan({
    tool: wanTool(root),
    selectedType: 'Video',
    repositoryId,
    catalogRepositoryId: repositoryId,
    artifacts,
  });
}

function assertBlocked(plan, pattern, label) {
  assert.strictEqual(plan.runnable, false, `${label} should be blocked.`);
  assert.match(plan.blockingReason || '', pattern, label);
}

async function verifyWanShardCompleteness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-wan-shards-'));
  try {
    const base = [
      artifact('models_t5_umt5-xxl-enc-bf16.pth'),
      artifact('Wan2.1_VAE.pth'),
    ];
    const complete = wanPlan(root, [
      artifact('diffusion_pytorch_model-00001-of-00002.safetensors'),
      artifact('diffusion_pytorch_model-00002-of-00002.safetensors'),
      ...base,
    ]);
    assert.strictEqual(complete.runnable, true, 'A complete Wan shard set should be installable.');

    assertBlocked(
      wanPlan(root, [artifact('diffusion_pytorch_model-00001-of-00002.safetensors'), ...base]),
      /missing diffusion shard 00002/i,
      'An incomplete Wan shard set',
    );
    assertBlocked(
      wanPlan(root, [
        artifact('diffusion_pytorch_model-00001-of-00002.safetensors'),
        artifact('diffusion_pytorch_model-00001-of-00002.safetensors'),
        artifact('diffusion_pytorch_model-00002-of-00002.safetensors'),
        ...base,
      ]),
      /duplicate diffusion shard 00001/i,
      'A duplicate Wan shard set',
    );
    assertBlocked(
      wanPlan(root, [
        artifact('diffusion_pytorch_model-00001-of-00002.safetensors'),
        artifact('diffusion_pytorch_model-00002-of-00003.safetensors'),
        ...base,
      ]),
      /mixes diffusion shard counts/i,
      'A mixed-total Wan shard set',
    );
    assertBlocked(
      wanPlan(root, [
        artifact('diffusion_pytorch_model.safetensors'),
        artifact('diffusion_pytorch_model-00001-of-00001.safetensors'),
        ...base,
      ]),
      /mixes sharded and non-sharded/i,
      'A mixed sharded and non-sharded Wan snapshot',
    );

    const nonSharded = wanPlan(root, [artifact('diffusion_pytorch_model.safetensors'), ...base]);
    assert.strictEqual(nonSharded.runnable, true, 'A single-file Wan diffusion checkpoint should remain installable.');
  } finally {
    await fs.remove(root).catch(() => null);
  }
}

function verifyUiDownloadGuard() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelManager.jsx'), 'utf8');
  assert(source.includes('downloadBusyMap'), 'Model Manager UI should track a busy download map.');
  assert(source.includes('downloadBusy || Boolean(downloadProgress)'), 'Remote model download button should be disabled while a download is busy or reporting progress.');
  assert(source.includes('Downloading...'), 'Remote model download button should show an in-progress label.');
}

async function main() {
  await verifyDownloadExecutionLocking();
  console.log('Download execution locking checks passed.');
  await verifyOllamaStreamedErrors();
  console.log('Ollama streamed-error checks passed.');
  await verifyWanShardCompleteness();
  console.log('Wan shard completeness checks passed.');
  verifyUiDownloadGuard();
  console.log('Model Manager download correctness verifier passed.');
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});