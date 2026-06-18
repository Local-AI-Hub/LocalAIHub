const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const modelService = require('../electron/services/modelService');

const {
  isModelDownloadCancellationError,
  readOllamaPullStream,
  resolveModelDestination,
} = modelService._test;

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function assertIncludes(source, needle, label) {
  assert(source.includes(needle), label || `Expected source to include ${needle}`);
}

function tempTool(root) {
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
    installRelativePath: fileName,
    downloadUrl: `https://example.test/${fileName}`,
    sizeBytes: 4,
    source: 'huggingface',
    lowDiskConfirmed: true,
  };
}

function packagePayload(id = 'package-cancel') {
  return {
    id,
    name: 'Cancel Package',
    catalogRepositoryId: 'local/test-package',
    installRelativePath: 'cancel-package',
    modelType: 'Checkpoint',
    source: 'huggingface',
    lowDiskConfirmed: true,
    downloadPlan: {
      artifactLabel: 'Test package',
      downloadFiles: [
        { fileName: 'first.bin', installRelativePath: 'first.bin', path: 'first.bin', required: true, sizeBytes: 4 },
        { fileName: 'second.bin', installRelativePath: 'second.bin', path: 'second.bin', required: true, sizeBytes: 4 },
      ],
      modelType: 'Checkpoint',
      packageName: 'cancel-package',
      packageRoot: 'cancel-package',
      planType: 'package',
      requiredArtifacts: ['first.bin', 'second.bin'],
      requiredFiles: ['first.bin', 'second.bin'],
      runnable: true,
      sizeBytes: 8,
    },
  };
}

function cancellableResponse(signal, firstChunk = 'da') {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
      if (signal) {
        signal.addEventListener('abort', () => {
          controller.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }
    },
  }), {
    headers: { 'content-length': '4' },
    status: 200,
  });
}

function completeResponse(body = 'data') {
  return new Response(body, {
    headers: { 'content-length': String(Buffer.byteLength(body)) },
    status: 200,
  });
}

async function waitForCondition(predicate, label, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(label + ' did not happen in time.');
}
async function expectCancelled(promise, label, timeoutMs = 5000) {
  let error = null;
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} did not settle after cancellation.`)), timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } catch (caught) {
    error = caught;
  }
  assert(error, `${label} should reject after cancellation.`);
  assert(isModelDownloadCancellationError(error) || /cancelled|canceled/i.test(String(error.message || error)), `${label} should use a cancellation error.`);
}

async function verifySingleFileCancellation() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-cancel-file-'));
  const originalFetch = global.fetch;
  try {
    const tool = tempTool(root);
    const payload = remotePayload('cancel-http', 'cancel-http.safetensors');
    const destination = resolveModelDestination(tool, payload);
    let fetchCount = 0;
    global.fetch = async (_url, options = {}) => {
      fetchCount += 1;
      return cancellableResponse(options.signal);
    };
    const activeDownload = modelService.downloadModel(tool, payload);
    await waitForCondition(() => fetchCount > 0, 'single-file fetch start');
    const cancelResult = modelService.cancelModelDownload(tool, { downloadId: payload.id });
    assert.strictEqual(cancelResult.canceled, true, 'Active single-file download should be cancellable.');
    await expectCancelled(activeDownload, 'Single-file download');

    assert.strictEqual(fetchCount, 1, 'Cancelled transfer should not retry as a network failure.');
    assert.strictEqual(await fs.pathExists(destination.destinationPath), false, 'Cancelled transfer must not move a partial file to the final destination.');
    assert.strictEqual(await fs.pathExists(destination.destinationPath + '.download'), false, 'Cancelled transfer should clean the .download temp file.');
    assert.strictEqual((await modelService.listDownloadedModels(tool)).some((model) => model.fileName === payload.fileName), false, 'Cancelled transfer must not appear installed.');

    const harmless = modelService.cancelModelDownload(tool, { downloadId: payload.id });
    assert.strictEqual(harmless.canceled, false, 'Cancelling an already-finished operation should be harmless.');
    assert(/No active model download/i.test(harmless.message), 'Harmless cancellation should explain there is no active download.');

    global.fetch = async () => completeResponse('data');
    const retry = await modelService.downloadModel(tool, payload);
    assert.strictEqual(retry.alreadyPresent, false, 'Cancelled download lock should release so the user can retry.');
    assert.strictEqual(await fs.pathExists(destination.destinationPath), true, 'Retry after cancellation should install the model normally.');
  } finally {
    global.fetch = originalFetch;
    await fs.remove(root).catch(() => null);
  }
}

async function verifyUnrelatedDownloadContinues() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-cancel-parallel-'));
  const originalFetch = global.fetch;
  try {
    const tool = tempTool(root);
    const cancelPayload = remotePayload('parallel-cancel', 'parallel-cancel.safetensors');
    const keepPayload = remotePayload('parallel-keep', 'parallel-keep.safetensors');
    const keepDestination = resolveModelDestination(tool, keepPayload);
    let cancelDownload = null;
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('parallel-cancel')) {
        return cancellableResponse(options.signal);
      }
      return completeResponse('data');
    };
    cancelDownload = modelService.downloadModel(tool, cancelPayload);
    const keepDownload = modelService.downloadModel(tool, keepPayload);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cancelResult = modelService.cancelModelDownload(tool, { downloadId: cancelPayload.id });
    assert.strictEqual(cancelResult.canceled, true, 'Cancelling one destination should find only that active operation.');
    await expectCancelled(cancelDownload, 'Parallel cancelled download');
    const keepResult = await keepDownload;
    assert.strictEqual(keepResult.alreadyPresent, false, 'Unrelated download should continue after cancelling another destination.');
    assert.strictEqual(await fs.pathExists(keepDestination.destinationPath), true, 'Unrelated download should still finalize.');
  } finally {
    global.fetch = originalFetch;
    await fs.remove(root).catch(() => null);
  }
}

async function verifyPackageCancellation() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-cancel-package-'));
  const originalFetch = global.fetch;
  try {
    const tool = tempTool(root);
    const payload = packagePayload();
    const targetRoot = path.join(root, 'models', 'checkpoints', 'cancel-package');
    let fetchCount = 0;
    let cancelResult = null;
    global.fetch = async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        queueMicrotask(() => {
          cancelResult = modelService.cancelModelDownload(tool, { downloadId: payload.id });
        });
      }
      return completeResponse('data');
    };
    const packageDownload = modelService.downloadModel(tool, payload);
    await expectCancelled(packageDownload, 'Package download');
    assert.strictEqual(cancelResult?.canceled, true, 'Active package download should be cancellable.');
    assert.strictEqual(fetchCount, 1, 'Package cancellation should stop before requesting remaining package files.');
    assert.strictEqual(await fs.pathExists(targetRoot), false, 'Cancelled package should not leave a partial installed package folder.');
    assert.strictEqual((await modelService.listDownloadedModels(tool)).some((model) => model.name === 'cancel-package'), false, 'Cancelled package must not appear installed.');

    let retryFetchCount = 0;
    global.fetch = async () => {
      retryFetchCount += 1;
      return completeResponse('data');
    };
    const retry = await modelService.downloadModel(tool, payload);
    assert.strictEqual(retry.alreadyPresent, false, 'Package lock should release after cancellation.');
    assert.strictEqual(retryFetchCount, 2, 'Package retry should download every required package file.');
    assert.strictEqual(await fs.pathExists(path.join(targetRoot, '.localaihub-package.json')), true, 'Successful retry should write the package manifest.');
  } finally {
    global.fetch = originalFetch;
    await fs.remove(root).catch(() => null);
  }
}

async function verifyPackageCancellationPreservesExistingFolder() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-cancel-existing-package-'));
  const originalFetch = global.fetch;
  try {
    const tool = tempTool(root);
    const payload = packagePayload('package-cancel-existing');
    const targetRoot = path.join(root, 'models', 'checkpoints', 'cancel-package');
    const sentinelPath = path.join(targetRoot, 'keep-user-file.txt');
    await fs.ensureDir(targetRoot);
    await fs.writeFile(sentinelPath, 'pre-existing user data');

    let fetchCount = 0;
    let cancelResult = null;
    global.fetch = async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        queueMicrotask(() => {
          cancelResult = modelService.cancelModelDownload(tool, { downloadId: payload.id });
        });
      }
      return completeResponse('data');
    };

    await expectCancelled(modelService.downloadModel(tool, payload), 'Package download with pre-existing folder');
    assert.strictEqual(cancelResult?.canceled, true, 'Active package download with a pre-existing folder should be cancellable.');
    assert.strictEqual(fetchCount, 1, 'Pre-existing package cancellation should stop before remaining package files.');
    assert.strictEqual(await fs.pathExists(targetRoot), true, 'Cancelled package must not delete a pre-existing package folder.');
    assert.strictEqual(await fs.readFile(sentinelPath, 'utf8'), 'pre-existing user data', 'Cancelled package must preserve pre-existing package folder contents.');
    assert.strictEqual(await fs.pathExists(path.join(targetRoot, '.localaihub-package.json')), false, 'Cancelled package should not create an installed package manifest.');
  } finally {
    global.fetch = originalFetch;
    await fs.remove(root).catch(() => null);
  }
}

async function verifyOllamaCancellationStream() {
  assert.strictEqual(typeof readOllamaPullStream, 'function', 'Ollama stream parser should be exported.');
  const controller = new AbortController();
  const streamPromise = readOllamaPullStream(cancellableResponse(controller.signal, '{"status":"pulling"}\n'), { id: 'ollama:cancel', name: 'tiny:latest' }, { cancelSignal: controller.signal });
  controller.abort();
  await expectCancelled(streamPromise, 'Ollama pull stream');
}

function verifyStaticWiring() {
  const ui = read('src/components/ModelManager.jsx');
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');
  const service = read('electron/services/modelService.js');

  assertIncludes(preload, "cancelModelDownload: (payload) => invoke('models:cancel-download', payload)", 'Preload should expose a scoped model download cancel API.');
  assertIncludes(main, "ipcMain.handle('models:cancel-download'", 'Main should register a model download cancel IPC.');
  assertIncludes(main, 'downloadId: payload.downloadId', 'Cancel IPC should pass a stable download ID, not a path.');
  assert(!/cancel-download[\s\S]{0,500}(path|filePath|destinationPath)/.test(main), 'Cancel IPC must not accept arbitrary paths.');
  assertIncludes(service, 'MODEL_DOWNLOAD_ACTIVE_BY_ID', 'Service should own the active download cancellation registry.');
  assertIncludes(service, 'packageRootExistedBeforeDownload', 'Package cancellation should preserve pre-existing package folders.');
  assertIncludes(service, 'controller.abort(createModelDownloadCancelledError())', 'Service cancellation should abort the active operation.');
  assertIncludes(service, 'signal: options.cancelSignal || undefined', 'HTTP/provider fetches should receive the cancellation signal.');
  assertIncludes(service, 'waitForInvokeAiInstallJob(session.readyTool, job', 'InvokeAI import should keep explicit job waiting logic.');
  assertIncludes(service, 'cancelSignal: options.cancelSignal', 'InvokeAI/package/RVC paths should pass the cancellation signal through nested work.');
  assertIncludes(ui, 'onCancelDownload={handleCancelDownload}', 'Model cards should receive a cancel handler.');
  assertIncludes(ui, "{cancelBusy ? 'Cancelling...' : 'Cancel'}", 'UI should render a distinct Cancel button only while active.');
  assertIncludes(ui, 'isModelCancellationMessage', 'UI should treat cancellation as a neutral message, not a failure.');
}

async function main() {
  verifyStaticWiring();
  await verifySingleFileCancellation();
  await verifyUnrelatedDownloadContinues();
  await verifyPackageCancellation();
  await verifyPackageCancellationPreservesExistingFolder();
  await verifyOllamaCancellationStream();
  console.log('Model Manager download cancellation verifier passed.');
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
