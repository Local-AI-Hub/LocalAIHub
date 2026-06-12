const path = require('path');
const { Worker } = require('worker_threads');
const { app } = require('electron');

const { createLogger } = require('./logService');

let workerThread = null;
let nextRequestId = 0;
const pendingRequests = new Map();
const logger = createLogger('background-worker');

function isPackagedElectronApp() {
  return Boolean(app?.isPackaged);
}

function getWorkerModulePath() {
  return isPackagedElectronApp()
    ? path.join(process.resourcesPath, 'app.asar', 'electron', 'helpers', 'background_worker.js')
    : path.join(__dirname, '..', 'helpers', 'background_worker.js');
}

function getWorkerBootstrapSource() {
  return `require(${JSON.stringify(getWorkerModulePath())});`;
}

function createBackgroundTaskAbortError() {
  const error = new Error('The background task was canceled.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function settlePendingRequest(requestId, method, value) {
  const handlers = pendingRequests.get(requestId);
  if (!handlers) {
    return;
  }
  pendingRequests.delete(requestId);
  handlers.cleanup?.();
  handlers[method](value);
}

function rejectPendingRequests(message) {
  for (const requestId of [...pendingRequests.keys()]) {
    settlePendingRequest(requestId, 'reject', new Error(message));
  }
}

function handleWorkerMessage(message) {
  const requestId = Number(message?.requestId);
  if (!pendingRequests.has(requestId)) {
    return;
  }

  if (message?.ok) {
    settlePendingRequest(requestId, 'resolve', message.result);
    return;
  }

  settlePendingRequest(requestId, 'reject', new Error(message?.error || 'A Local AI Hub background task failed.'));
}

function attachWorkerListeners(worker) {
  worker.on('message', handleWorkerMessage);
  worker.on('error', (error) => {
    if (workerThread === worker) {
      workerThread = null;
    }

    logger.error('The background worker crashed.', {
      error,
      packaged: isPackagedElectronApp(),
      workerModulePath: getWorkerModulePath(),
    }).catch(() => null);

    rejectPendingRequests(error?.message || 'Local AI Hub lost its background worker.');
  });
  worker.on('exit', (code) => {
    if (workerThread === worker) {
      workerThread = null;
    }

    if (code !== 0) {
      logger.error('The background worker exited unexpectedly.', {
        code,
        packaged: isPackagedElectronApp(),
        pendingRequests: pendingRequests.size,
        workerModulePath: getWorkerModulePath(),
      }).catch(() => null);
    }

    if (pendingRequests.size > 0) {
      rejectPendingRequests(`Local AI Hub background worker exited with code ${code}.`);
    }
  });
}

function ensureWorkerThread() {
  if (workerThread) {
    return workerThread;
  }

  const worker = new Worker(getWorkerBootstrapSource(), {
    eval: true,
    name: 'local-ai-hub-background',
  });

  attachWorkerListeners(worker);
  workerThread = worker;
  return workerThread;
}

function runBackgroundTask(task, payload = {}, options = {}) {
  return new Promise((resolve, reject) => {
    let worker = null;
    try {
      worker = ensureWorkerThread();
    } catch (error) {
      reject(error);
      return;
    }

    const requestId = nextRequestId + 1;
    nextRequestId = requestId;
    const abortRequest = () => {
      if (!pendingRequests.has(requestId)) {
        return;
      }
      try {
        worker.postMessage({ cancelRequestId: requestId });
      } catch {
        // The worker may already be shutting down.
      }
      settlePendingRequest(requestId, 'reject', createBackgroundTaskAbortError());
    };
    const cleanup = () => options.signal?.removeEventListener('abort', abortRequest);
    pendingRequests.set(requestId, {
      cleanup,
      reject,
      resolve,
    });

    if (options.signal?.aborted) {
      abortRequest();
      return;
    }
    options.signal?.addEventListener('abort', abortRequest, { once: true });

    try {
      worker.postMessage({
        payload,
        requestId,
        task,
      });
    } catch (error) {
      settlePendingRequest(requestId, 'reject', error);
    }
  });
}
async function disposeBackgroundTasks() {
  if (!workerThread) {
    return;
  }

  const worker = workerThread;
  workerThread = null;
  rejectPendingRequests('Local AI Hub is shutting down its background worker.');

  await Promise.race([
    worker.terminate().catch(() => null),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
}

module.exports = {
  disposeBackgroundTasks,
  runBackgroundTask,
};
