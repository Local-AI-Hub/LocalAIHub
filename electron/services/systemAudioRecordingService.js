const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');

const { ensureStorage, getAppPaths } = require('./configService');
const { isPathInside } = require('./pathSafetyService');

const MIN_REGION_SIZE = 64;
const MAX_REGION_DIMENSION = 16384;
const MAX_REGION_OFFSET = 131072;
const MAX_REGION_PIXELS = 67108864;

const SAFE_MIME_TYPES = new Set([
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'audio/webm;codecs=opus',
  'audio/webm',
]);

function sanitizeText(value, maximum = 300) {
  return String(value || '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, maximum);
}

function normalizeFps(value) {
  const fps = value === undefined || value === null || value === '' ? 15 : Number(value);
  if (!Number.isInteger(fps) || fps < 10 || fps > 60) {
    throw new Error('Choose a recording frame rate between 10 and 60 FPS.');
  }
  return fps;
}

function normalizeRegionTarget(target, display) {
  const values = {
    x: Number(target?.x),
    y: Number(target?.y),
    width: Number(target?.width),
    height: Number(target?.height),
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value)) throw new Error(`Region ${key} must be a whole number.`);
  }
  if (values.width < MIN_REGION_SIZE || values.height < MIN_REGION_SIZE) {
    throw new Error(`Region width and height must each be at least ${MIN_REGION_SIZE} pixels.`);
  }
  if (values.width % 2 !== 0 || values.height % 2 !== 0) {
    throw new Error('Region width and height must be even numbers for recording.');
  }
  if (Math.abs(values.x) > MAX_REGION_OFFSET || Math.abs(values.y) > MAX_REGION_OFFSET) {
    throw new Error('Those region coordinates are outside the supported virtual desktop range.');
  }
  if (values.width > MAX_REGION_DIMENSION || values.height > MAX_REGION_DIMENSION || values.width * values.height > MAX_REGION_PIXELS) {
    throw new Error('That recording region is too large. Choose a smaller area.');
  }
  const right = values.x + values.width;
  const bottom = values.y + values.height;
  if (values.x < display.bounds.x || values.y < display.bounds.y || right > display.bounds.x + display.bounds.width || bottom > display.bounds.y + display.bounds.height) {
    throw new Error('The recording region must stay inside the selected display.');
  }
  return {
    type: 'region',
    displayId: display.id,
    displayName: display.name,
    ...values,
  };
}
function createRecordingId(date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `recording-${timestamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function buildRecordingPaths(recordingsRoot, date, id) {
  const year = String(date.getFullYear());
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const directoryPath = path.join(recordingsRoot, year, day);
  const outputPath = path.join(directoryPath, `${id}.webm`);
  const sidecarPath = path.join(directoryPath, `${id}.recording.json`);
  if (!isPathInside(recordingsRoot, outputPath) || !isPathInside(recordingsRoot, sidecarPath)) {
    throw new Error('Local AI Hub refused to create a recording outside its managed recordings folder.');
  }
  return { directoryPath, outputPath, sidecarPath };
}

async function writeJsonAtomic(fsApi, filePath, payload) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsApi.ensureDir(path.dirname(filePath));
  await fsApi.writeJson(temporaryPath, payload, { spaces: 2 });
  await fsApi.move(temporaryPath, filePath, { overwrite: true });
}

function normalizeDisplay(display) {
  const bounds = display?.captureBounds || display?.bounds || {};
  const id = String(display?.id ?? '').trim();
  const normalizedBounds = {
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width),
    height: Number(bounds.height),
  };
  if (!id || !Object.values(normalizedBounds).every(Number.isInteger) || normalizedBounds.width <= 0 || normalizedBounds.height <= 0) {
    return null;
  }
  return {
    id,
    name: sanitizeText(display?.name || display?.label || `Display ${id}`),
    primary: Boolean(display?.primary),
    bounds: normalizedBounds,
  };
}

function normalizeSystemAudioOptions(input = {}, devices = [], displays = []) {
  if (!input?.systemAudio && input?.mode !== 'systemAudio') {
    throw new Error('Choose system audio before using the Electron recording backend.');
  }

  const mode = String(input.mode || '').trim();
  if (!['systemAudio', 'screen'].includes(mode)) {
    throw new Error('System audio currently supports audio-only or screen recording. It cannot yet be combined with microphone or webcam capture.');
  }
  if (input.microphoneId || input.webcamId) {
    throw new Error('System audio cannot yet be combined with microphone or webcam capture.');
  }

  const allowedDisplays = displays.map(normalizeDisplay).filter(Boolean);
  const requestedDisplayId = String(input.displayId || input.captureTarget?.displayId || '').trim();
  const display = allowedDisplays.find((entry) => entry.id === requestedDisplayId)
    || (requestedDisplayId ? null : allowedDisplays.find((entry) => entry.primary) || allowedDisplays[0] || null);
  if (!display) {
    throw new Error('Choose an available display for system audio capture. Chromium requires a display source even when the final recording is audio-only.');
  }

  const includeVideo = mode === 'screen';
  const fps = includeVideo ? normalizeFps(input.fps) : null;
  let captureTarget = null;
  if (includeVideo) {
    if (input.captureTarget?.type === 'window') {
      throw new Error('Window capture is not available yet. Choose a display or region.');
    }
    if (input.captureTarget?.type === 'region') {
      if (String(input.captureTarget.displayId || '') !== display.id) {
        throw new Error('The selected region must belong to the display used for system audio capture.');
      }
      captureTarget = normalizeRegionTarget(input.captureTarget, display);
    } else {
      captureTarget = {
        type: 'desktop',
        displayId: display.id,
        displayName: display.name,
      };
    }
  }

  return {
    backend: 'electron',
    mode,
    videoSource: includeVideo ? 'screen' : 'none',
    audioSources: ['systemAudio'],
    includeVideo,
    fps,
    display,
    captureTarget,
    container: 'webm',
    format: 'webm',
  };
}

function createSystemAudioRecordingService(dependencies = {}) {
  const fsApi = dependencies.fs || fs;
  const ensureStorageFn = dependencies.ensureStorage || ensureStorage;
  const getAppPathsFn = dependencies.getAppPaths || getAppPaths;
  const captureAdapter = dependencies.captureAdapter;
  const now = dependencies.now || (() => new Date());
  let activeRecording = null;
  let eventSink = null;

  function serialize(value) {
    return value ? JSON.parse(JSON.stringify(value)) : null;
  }

  function emit(recording, message = '') {
    if (typeof eventSink !== 'function') return;
    const publicRecording = recording?.metadata ? { ...recording.metadata, outputPath: recording.outputPath } : recording;
    eventSink({
      type: 'recording-status',
      active: recording?.metadata?.status === 'recording' ? serialize(publicRecording) : null,
      recording: serialize(publicRecording),
      message,
    });
  }

  async function updateMetadata(recording, patch = {}) {
    recording.metadata = { ...recording.metadata, ...patch };
    recording.metadataWriteQueue = (recording.metadataWriteQueue || Promise.resolve())
      .catch(() => null)
      .then(() => writeJsonAtomic(fsApi, recording.sidecarPath, recording.metadata));
    await recording.metadataWriteQueue;
    return recording.metadata;
  }

  async function finalize(recording, result = {}) {
    if (recording.finalized) return recording.metadata;
    recording.finalized = true;
    let sizeBytes = 0;
    if (await fsApi.pathExists(recording.outputPath)) {
      sizeBytes = Number((await fsApi.stat(recording.outputPath)).size || 0);
    }

    let status = 'failed';
    let errorSummary = sanitizeText(result.error, 500);
    if (recording.cancelRequested) {
      status = result.clean === false ? 'interrupted' : 'canceled';
      errorSummary = status === 'interrupted' ? errorSummary || 'The system-audio recording was interrupted while canceling.' : '';
    } else if (recording.stopRequested && result.clean && sizeBytes > 0) {
      status = 'completed';
      errorSummary = '';
    } else if (recording.stopRequested || result.reason === 'window-closed') {
      status = 'interrupted';
      errorSummary = errorSummary || (sizeBytes > 0
        ? 'The Electron recorder stopped before it could confirm clean finalization.'
        : 'The Electron recorder stopped before creating a usable file.');
    } else {
      errorSummary = errorSummary || 'The Electron system-audio recorder stopped unexpectedly.';
    }

    const stoppedAt = now();
    await updateMetadata(recording, {
      status,
      stoppedAt: stoppedAt.toISOString(),
      durationSeconds: Math.max(0, Math.round((stoppedAt.getTime() - new Date(recording.metadata.startedAt).getTime()) / 100) / 10),
      sizeBytes,
      mimeType: sanitizeText(result.mimeType || recording.metadata.mimeType, 120),
      stopMethod: recording.stopMethod || result.stopMethod || 'capture-window-exit',
      errorSummary,
    });

    if (activeRecording === recording) activeRecording = null;
    emit(recording, status === 'completed' ? 'Recording saved.' : status === 'canceled' ? 'Recording canceled.' : errorSummary);
    recording.resolveClose(recording.metadata);
    return recording.metadata;
  }

  async function startRecording(input = {}, context = {}) {
    if (activeRecording) {
      throw new Error('A recording is already active. Stop or cancel it before starting another one.');
    }
    if (!captureAdapter || typeof captureAdapter.start !== 'function') {
      throw new Error('The Electron system-audio capture backend is unavailable.');
    }

    const options = normalizeSystemAudioOptions(input, context.devices || [], context.displays || []);
    const storage = await ensureStorageFn();
    const recordingsRoot = path.resolve(storage?.recordingsRoot || getAppPathsFn().recordingsRoot);
    await fsApi.ensureDir(recordingsRoot);
    const startedAt = now();
    const id = createRecordingId(startedAt);
    const paths = buildRecordingPaths(recordingsRoot, startedAt, id);
    await fsApi.ensureDir(paths.directoryPath);

    const metadata = {
      schemaVersion: 2,
      id,
      status: 'recording',
      backend: 'electron',
      mode: options.mode,
      videoSource: options.videoSource,
      audioSources: options.audioSources,
      sources: {
        screen: options.includeVideo,
        microphone: null,
        webcam: null,
        systemAudio: true,
      },
      systemAudio: true,
      microphone: null,
      screenCaptureTarget: options.captureTarget ? { ...options.captureTarget } : null,
      captureTarget: options.captureTarget ? { ...options.captureTarget } : null,
      outputRelativePath: path.relative(recordingsRoot, paths.outputPath).replace(/\\/g, '/'),
      fileName: path.basename(paths.outputPath),
      container: 'webm',
      format: 'webm',
      mimeType: '',
      fps: options.fps,
      dimensions: options.captureTarget?.type === 'region'
        ? { width: options.captureTarget.width, height: options.captureTarget.height }
        : options.includeVideo ? { width: options.display.bounds.width, height: options.display.bounds.height } : null,
      codecs: { video: options.includeVideo ? 'MediaRecorder' : null, audio: 'opus' },
      startedAt: startedAt.toISOString(),
      stoppedAt: null,
      durationSeconds: null,
      sizeBytes: 0,
      stopMethod: null,
      errorSummary: '',
    };

    let resolveClose;
    const closePromise = new Promise((resolve) => { resolveClose = resolve; });
    const recording = {
      metadata,
      metadataWriteQueue: Promise.resolve(),
      outputPath: paths.outputPath,
      sidecarPath: paths.sidecarPath,
      closePromise,
      resolveClose,
      stopRequested: false,
      cancelRequested: false,
      stopMethod: '',
      finalized: false,
      captureSession: null,
    };
    activeRecording = recording;
    await writeJsonAtomic(fsApi, paths.sidecarPath, metadata);

    try {
      const captureSession = await captureAdapter.start({
        outputPath: paths.outputPath,
        includeVideo: options.includeVideo,
        fps: options.fps,
        display: options.display,
        captureTarget: options.captureTarget,
      });
      recording.captureSession = captureSession;
      await updateMetadata(recording, {
        mimeType: sanitizeText(captureSession.mimeType, 120),
        dimensions: captureSession.dimensions || metadata.dimensions,
      });
      captureSession.closed.then((result) => finalize(recording, result)).catch((error) => finalize(recording, { clean: false, error: error?.message }));
      emit(recording, 'Recording started.');
      return serialize({ ...recording.metadata, outputPath: recording.outputPath });
    } catch (error) {
      recording.stopMethod = 'capture-start-failed';
      await finalize(recording, { clean: false, error: sanitizeText(error?.message, 500), stopMethod: 'capture-start-failed' });
      throw new Error(sanitizeText(error?.message, 500) || 'Local AI Hub could not start Electron system-audio capture.');
    }
  }

  async function requestStop(cancelRequested) {
    const recording = activeRecording;
    if (!recording) throw new Error('There is no active recording to stop.');
    if (recording.stopRequested) return recording.closePromise;
    recording.stopRequested = true;
    recording.cancelRequested = cancelRequested;
    recording.stopMethod = cancelRequested ? 'media-recorder-cancel' : 'media-recorder-stop';
    await updateMetadata(recording, { stopMethod: recording.stopMethod });
    try {
      if (cancelRequested) await recording.captureSession?.cancel();
      else await recording.captureSession?.stop();
    } catch (error) {
      await finalize(recording, { clean: false, error: error?.message, stopMethod: recording.stopMethod });
    }
    return recording.closePromise;
  }

  return {
    cancelRecording: () => requestStop(true),
    disposeRecording: async () => activeRecording ? requestStop(false) : null,
    getActiveRecording: () => activeRecording ? serialize({ ...activeRecording.metadata, outputPath: activeRecording.outputPath }) : null,
    setRecordingEventSink(sink) { eventSink = typeof sink === 'function' ? sink : null; },
    startRecording,
    stopRecording: () => requestStop(false),
  };
}

module.exports = {
  createSystemAudioRecordingService,
  normalizeSystemAudioOptions,
  _test: {
    buildRecordingPaths,
    normalizeDisplay,
    SAFE_MIME_TYPES,
  },
};
