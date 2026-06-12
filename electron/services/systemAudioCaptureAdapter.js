const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const START_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 10000;
const SAFE_MIME_PREFIX = /^(audio|video)\/webm(?:;|$)/i;

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function createSystemAudioCaptureAdapter(dependencies = {}) {
  const BrowserWindow = dependencies.BrowserWindow;
  const desktopCapturer = dependencies.desktopCapturer;
  const ipcMain = dependencies.ipcMain;
  const session = dependencies.session;
  const preloadPath = dependencies.preloadPath || path.join(__dirname, '..', 'systemAudioCapturePreload.js');
  const htmlPath = dependencies.htmlPath || path.join(__dirname, '..', 'system-audio-capture.html');
  let active = null;
  let handlersRegistered = false;

  function assertSender(event) {
    if (!active || !active.window || event.sender !== active.window.webContents) {
      throw new Error('Local AI Hub refused system-audio data from an unexpected window.');
    }
    return active;
  }

  async function closeOutput(capture) {
    if (capture.outputClosed) return;
    capture.outputClosed = true;
    await capture.writeQueue.catch(() => null);
    await capture.outputHandle?.sync().catch(() => null);
    await capture.outputHandle?.close().catch(() => null);
  }

  async function finish(capture, result = {}) {
    if (!capture || capture.finished) return capture?.closed.promise;
    capture.finished = true;
    const startupError = String(result.error || '').replace(/[\\r\\n\\0]+/g, ' ').trim().slice(0, 500);
    if (!capture.startedDone) {
      capture.startedDone = true;
      capture.started.reject(new Error(startupError || 'Electron system-audio capture stopped before it became active.'));
    }
    await closeOutput(capture);
    const payload = {
      clean: Boolean(result.clean),
      reason: result.reason || (result.clean ? 'media-recorder-stop' : 'capture-window-exit'),
      error: String(result.error || '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, 500),
      mimeType: String(result.mimeType || capture.mimeType || '').trim().slice(0, 120),
      stopMethod: result.stopMethod || '',
    };
    if (active === capture) active = null;
    capture.closed.resolve(payload);
    setImmediate(() => {
      if (capture.window && !capture.window.isDestroyed()) capture.window.destroy();
    });
    return payload;
  }

  function registerIpcHandlers() {
    if (handlersRegistered) return;
    handlersRegistered = true;

    ipcMain.handle('system-audio-capture:ready', async (event) => {
      const capture = assertSender(event);
      capture.ready.resolve({ ok: true });
      return { ok: true };
    });
    ipcMain.handle('system-audio-capture:configured', async (event) => {
      const capture = assertSender(event);
      capture.configured.resolve({ ok: true });
      return { ok: true };
    });
    ipcMain.handle('system-audio-capture:prepared', async (event) => {
      const capture = assertSender(event);
      if (capture.window && !capture.window.isDestroyed()) capture.window.hide();
      return { ok: true };
    });
    ipcMain.handle('system-audio-capture:started', async (event, payload) => {
      const capture = assertSender(event);
      const mimeType = String(payload?.mimeType || '').trim();
      if (!SAFE_MIME_PREFIX.test(mimeType)) {
        throw new Error('Electron selected an unsupported recording format.');
      }
      capture.mimeType = mimeType;
      capture.startedDone = true;
      capture.dimensions = payload?.dimensions && Number.isInteger(payload.dimensions.width) && Number.isInteger(payload.dimensions.height)
        ? { width: payload.dimensions.width, height: payload.dimensions.height }
        : null;
      capture.started.resolve({ mimeType, dimensions: capture.dimensions });
      return { ok: true };
    });
    ipcMain.handle('system-audio-capture:chunk', async (event, payload) => {
      const capture = assertSender(event);
      const bytes = Buffer.from(payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload || []);
      if (!bytes.length) return { ok: true };
      if (bytes.length > MAX_CHUNK_BYTES) {
        throw new Error('Electron produced an unexpectedly large recording chunk.');
      }
      capture.writeQueue = capture.writeQueue.then(() => capture.outputHandle.write(bytes));
      await capture.writeQueue;
      return { ok: true };
    });
    ipcMain.handle('system-audio-capture:complete', async (event, payload) => {
      const capture = assertSender(event);
      await finish(capture, {
        clean: true,
        reason: 'media-recorder-stop',
        mimeType: payload?.mimeType,
        stopMethod: capture.stopMethod || 'media-recorder-stop',
      });
      return { ok: true };
    });
    ipcMain.handle('system-audio-capture:error', async (event, payload) => {
      const capture = assertSender(event);
      await finish(capture, {
        clean: false,
        reason: 'capture-error',
        error: payload?.message || 'The Electron capture window reported an error.',
        mimeType: payload?.mimeType,
        stopMethod: capture.stopMethod || 'capture-error',
      });
      return { ok: true };
    });
  }

  async function requestStop(capture, canceled) {
    if (!capture || capture.finished) return capture?.closed.promise;
    capture.stopMethod = canceled ? 'media-recorder-cancel' : 'media-recorder-stop';
    if (!capture.window || capture.window.isDestroyed()) {
      await finish(capture, { clean: false, reason: 'window-closed', error: 'The system-audio capture window closed unexpectedly.', stopMethod: capture.stopMethod });
      return capture.closed.promise;
    }
    capture.window.webContents.send('system-audio-capture:stop');
    try {
      return await withTimeout(capture.closed.promise, STOP_TIMEOUT_MS, 'Electron took too long to finalize the system-audio recording.');
    } catch (error) {
      await finish(capture, { clean: false, reason: 'stop-timeout', error: error.message, stopMethod: capture.stopMethod });
      return capture.closed.promise;
    }
  }

  async function start(config) {
    if (active) throw new Error('An Electron system-audio capture session is already active.');
    if (!BrowserWindow || !desktopCapturer || !ipcMain || !session) {
      throw new Error('Electron system-audio capture dependencies are unavailable.');
    }
    registerIpcHandlers();

    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find((entry) => String(entry.display_id) === String(config.display?.id));
    if (!source) throw new Error('Electron could not find the selected display for system-audio capture.');

    const partition = `local-ai-hub-system-audio-${crypto.randomBytes(10).toString('hex')}`;
    const captureSession = session.fromPartition(partition, { cache: false });
    const outputHandle = await fs.promises.open(config.outputPath, 'w');
    const capture = {
      window: null,
      outputHandle,
      outputClosed: false,
      writeQueue: Promise.resolve(),
      ready: createDeferred(),
      configured: createDeferred(),
      started: createDeferred(),
      closed: createDeferred(),
      finished: false,
      startedDone: false,
      mimeType: '',
      dimensions: null,
      stopMethod: '',
    };
    active = capture;

    try {
      const captureWindow = new BrowserWindow({
        width: 420,
        height: 180,
        show: true,
        autoHideMenuBar: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        backgroundColor: '#0f172a',
        webPreferences: {
          partition,
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      capture.window = captureWindow;
      captureWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      captureWindow.webContents.on('will-navigate', (event) => event.preventDefault());
      captureWindow.webContents.on('preload-error', (_event, _preloadPath, error) => {
        finish(capture, { clean: false, reason: 'preload-error', error: error?.message || 'The system-audio capture preload could not start.', stopMethod: 'capture-start-failed' }).catch(() => null);
      });
      captureWindow.webContents.on('did-fail-load', (_event, _code, description) => {
        finish(capture, { clean: false, reason: 'load-error', error: description || 'The system-audio capture page could not load.', stopMethod: 'capture-start-failed' }).catch(() => null);
      });
      captureWindow.webContents.on('render-process-gone', (_event, details) => {
        finish(capture, { clean: false, reason: 'render-process-gone', error: 'The system-audio capture renderer stopped: ' + (details?.reason || 'unknown reason') + '.', stopMethod: 'capture-start-failed' }).catch(() => null);
      });
      captureWindow.once('closed', () => {
        if (!capture.finished) {
          finish(capture, { clean: false, reason: 'window-closed', error: 'The system-audio capture window closed unexpectedly.', stopMethod: capture.stopMethod || 'capture-window-exit' }).catch(() => null);
        }
      });

      captureSession.setPermissionCheckHandler((webContents, permission) => webContents === captureWindow.webContents && ['media', 'display-capture'].includes(permission));
      captureSession.setPermissionRequestHandler((webContents, permission, callback) => callback(webContents === captureWindow.webContents && ['media', 'display-capture'].includes(permission)));
      captureSession.setDisplayMediaRequestHandler((_request, callback) => callback({ video: source, audio: 'loopback' }));

      await captureWindow.loadFile(htmlPath);
      await withTimeout(capture.ready.promise, 5000, 'The secure system-audio capture renderer did not become ready.');
      captureWindow.show();
      captureWindow.focus();
      captureWindow.webContents.focus();
      captureWindow.webContents.send('system-audio-capture:configure', {
        includeVideo: Boolean(config.includeVideo),
        fps: config.fps || 15,
        displayBounds: config.display.bounds,
        captureTarget: config.captureTarget,
      });
      await withTimeout(capture.configured.promise, 5000, 'The secure system-audio capture renderer did not accept its configuration.');
      await new Promise((resolve) => setTimeout(resolve, 200));
      const buttonRect = await captureWindow.webContents.executeJavaScript("document.getElementById('start-capture').getBoundingClientRect().toJSON()", true);
      const x = Math.round(buttonRect.x + buttonRect.width / 2);
      const y = Math.round(buttonRect.y + buttonRect.height / 2);
      captureWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      captureWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      captureWindow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await captureWindow.webContents.executeJavaScript("document.getElementById('start-capture').click()", true);

      const started = await withTimeout(capture.started.promise, START_TIMEOUT_MS, 'Electron took too long to start system-audio capture.');
      return {
        mimeType: started.mimeType,
        dimensions: started.dimensions,
        closed: capture.closed.promise,
        stop: () => requestStop(capture, false),
        cancel: () => requestStop(capture, true),
      };
    } catch (error) {
      await finish(capture, { clean: false, reason: 'capture-start-failed', error: error?.message, stopMethod: 'capture-start-failed' });
      throw error;
    }
  }

  return {
    getActiveCapture: () => active,
    registerIpcHandlers,
    start,
  };
}

module.exports = {
  createSystemAudioCaptureAdapter,
  _test: { MAX_CHUNK_BYTES, SAFE_MIME_PREFIX },
};
