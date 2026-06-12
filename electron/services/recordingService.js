const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs-extra');

const { ensureStorage, getAppPaths } = require('./configService');
const { resolveFfmpegPath } = require('./mediaCompositionService');
const { isPathInside } = require('./pathSafetyService');

const SUPPORTED_MODES = new Set(['screen', 'microphone', 'webcam', 'screenMic', 'webcamMic']);
const VIDEO_MODES = new Set(['screen', 'webcam', 'screenMic', 'webcamMic']);
const MICROPHONE_MODES = new Set(['microphone', 'screenMic', 'webcamMic']);
const WEBCAM_MODES = new Set(['webcam', 'webcamMic']);
const SCREEN_MODES = new Set(['screen', 'screenMic']);
const SAFE_RECORDING_ID = /^[a-z0-9-]{12,80}$/;
const DEVICE_CACHE_MS = 30000;
const DEFAULT_FPS = 15;
const MIN_REGION_SIZE = 64;
const MAX_REGION_DIMENSION = 16384;
const MAX_REGION_OFFSET = 131072;
const MAX_REGION_PIXELS = 67108864;
const MAX_CAPTURE_OUTPUT = 64000;
const DEFAULT_GRACEFUL_STOP_MS = 7000;
const DEFAULT_TERMINATION_WAIT_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimOutput(value) {
  const text = String(value || '');
  return text.length > MAX_CAPTURE_OUTPUT ? text.slice(-MAX_CAPTURE_OUTPUT) : text;
}

function sanitizeDeviceName(value) {
  return String(value || '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, 300);
}

function buildDeviceId(kind, name, alternativeName, index) {
  const hash = crypto
    .createHash('sha256')
    .update(`${kind}\0${name}\0${alternativeName}\0${index}`)
    .digest('hex')
    .slice(0, 16);
  return `${kind}-${index}-${hash}`;
}

function parseDshowDevices(stderr) {
  const devices = [];
  let kind = '';
  let lastDevice = null;
  const lines = String(stderr || '').split(/\r?\n/);

  for (const line of lines) {
    if (/DirectShow video devices/i.test(line)) {
      kind = 'video';
      lastDevice = null;
      continue;
    }
    if (/DirectShow audio devices/i.test(line)) {
      kind = 'audio';
      lastDevice = null;
      continue;
    }
    const inlineKindMatch = line.match(/\((video|audio)\)\s*$/i);
    if (inlineKindMatch) {
      kind = inlineKindMatch[1].toLowerCase();
    }
    if (!kind) {
      continue;
    }

    const alternativeMatch = line.match(/Alternative name\s+"([^"]+)"/i);
    if (alternativeMatch && lastDevice) {
      lastDevice.alternativeName = sanitizeDeviceName(alternativeMatch[1]);
      continue;
    }

    const nameMatches = [...line.matchAll(/"([^"]+)"/g)];
    if (!nameMatches.length || /Alternative name/i.test(line)) {
      continue;
    }

    const name = sanitizeDeviceName(nameMatches[nameMatches.length - 1][1]);
    if (!name) {
      continue;
    }

    const device = { kind, name, alternativeName: '' };
    devices.push(device);
    lastDevice = device;
  }

  const occurrenceCounts = new Map();
  return devices.map((device) => {
    const duplicateKey = `${device.kind}\0${device.name}`.toLowerCase();
    const duplicateIndex = occurrenceCounts.get(duplicateKey) || 0;
    occurrenceCounts.set(duplicateKey, duplicateIndex + 1);
    return {
      ...device,
      duplicateIndex,
      id: buildDeviceId(device.kind, device.name, device.alternativeName, duplicateIndex),
    };
  });
}

function normalizeFps(value) {
  const fps = value === undefined || value === null || value === '' ? DEFAULT_FPS : Number(value);
  if (!Number.isInteger(fps) || fps < 10 || fps > 60) {
    throw new Error('Choose a recording frame rate between 10 and 60 FPS.');
  }
  return fps;
}

function normalizeMode(value) {
  const mode = String(value || '').trim();
  if (!SUPPORTED_MODES.has(mode)) {
    throw new Error('Choose one of the supported recording modes. Screen plus webcam recording is not available.');
  }
  return mode;
}

function findAllowedDevice(devices, kind, id, label) {
  const normalizedId = String(id || '').trim();
  const match = devices.find((device) => device.kind === kind && device.id === normalizedId);
  if (!match) {
    throw new Error(`Choose an available ${label} from the refreshed device list.`);
  }
  return match;
}

function normalizeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a whole number.`);
  }
  return value;
}

function normalizeDisplay(display) {
  const bounds = display?.captureBounds || display?.bounds || {};
  const id = String(display?.id ?? '').trim();
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (!id || ![x, y, width, height].every(Number.isInteger) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    id,
    name: sanitizeDeviceName(display?.name || display?.label || `Display ${id}`),
    primary: Boolean(display?.primary),
    bounds: { x, y, width, height },
  };
}

function normalizeCaptureTarget(value, mode, displays = []) {
  if (!SCREEN_MODES.has(mode)) {
    return null;
  }

  const target = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const type = String(target.type || 'desktop').trim().toLowerCase();
  if (type === 'desktop') {
    return { type: 'desktop' };
  }
  if (type === 'window') {
    throw new Error('Window capture is not available yet. Choose Full desktop or Region.');
  }
  if (type !== 'region') {
    throw new Error('Choose Full desktop or Region as the screen capture target.');
  }

  const x = normalizeInteger(target.x, 'Region X');
  const y = normalizeInteger(target.y, 'Region Y');
  const width = normalizeInteger(target.width, 'Region width');
  const height = normalizeInteger(target.height, 'Region height');
  if (width < MIN_REGION_SIZE || height < MIN_REGION_SIZE) {
    throw new Error(`Region width and height must each be at least ${MIN_REGION_SIZE} pixels.`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error('Region width and height must be even numbers for H.264 recording.');
  }
  if (Math.abs(x) > MAX_REGION_OFFSET || Math.abs(y) > MAX_REGION_OFFSET) {
    throw new Error('Those region coordinates are outside the supported virtual desktop range.');
  }
  if (width > MAX_REGION_DIMENSION || height > MAX_REGION_DIMENSION || width * height > MAX_REGION_PIXELS) {
    throw new Error('That recording region is too large. Choose a smaller area.');
  }

  const allowedDisplays = displays.map(normalizeDisplay).filter(Boolean);
  const displayId = String(target.displayId ?? '').trim();
  const display = allowedDisplays.find((entry) => entry.id === displayId) || null;
  if (allowedDisplays.length && !display) {
    throw new Error('Choose an available display for the recording region.');
  }
  if (display) {
    const right = x + width;
    const bottom = y + height;
    const displayRight = display.bounds.x + display.bounds.width;
    const displayBottom = display.bounds.y + display.bounds.height;
    if (x < display.bounds.x || y < display.bounds.y || right > displayRight || bottom > displayBottom) {
      throw new Error('The recording region must stay inside the selected display.');
    }
  }

  return {
    type: 'region',
    displayId: display?.id || null,
    displayName: display?.name || '',
    x,
    y,
    width,
    height,
  };
}

function normalizeRecordingOptions(input, devices, displays = []) {
  const mode = normalizeMode(input?.mode);
  const fps = VIDEO_MODES.has(mode) ? normalizeFps(input?.fps) : null;
  const microphone = MICROPHONE_MODES.has(mode)
    ? findAllowedDevice(devices, 'audio', input?.microphoneId, 'microphone')
    : null;
  const webcam = WEBCAM_MODES.has(mode)
    ? findAllowedDevice(devices, 'video', input?.webcamId, 'webcam')
    : null;
  const captureTarget = normalizeCaptureTarget(input?.captureTarget, mode, displays);

  return {
    mode,
    fps,
    microphone,
    webcam,
    captureTarget,
    container: VIDEO_MODES.has(mode) ? 'mkv' : 'wav',
    format: VIDEO_MODES.has(mode) ? 'matroska' : 'wav',
  };
}

function buildVideoEncodingArgs() {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
}

function buildScreenInputArgs(options) {
  const args = ['-thread_queue_size', '512', '-f', 'gdigrab', '-framerate', String(options.fps || DEFAULT_FPS), '-draw_mouse', '1'];
  if (options.captureTarget?.type === 'region') {
    args.push(
      '-offset_x', String(options.captureTarget.x),
      '-offset_y', String(options.captureTarget.y),
      '-video_size', `${options.captureTarget.width}x${options.captureTarget.height}`,
    );
  }
  args.push('-i', 'desktop');
  return args;
}

function buildRecordingCommand(options, outputPath) {
  const args = ['-hide_banner', '-y'];
  const fps = String(options.fps || DEFAULT_FPS);

  if (options.mode === 'screen') {
    args.push(...buildScreenInputArgs(options));
    args.push(...buildVideoEncodingArgs(), '-an', outputPath);
  } else if (options.mode === 'microphone') {
    args.push('-thread_queue_size', '512', '-f', 'dshow', '-i', `audio=${options.microphone.name}`);
    args.push('-vn', '-c:a', 'pcm_s16le', outputPath);
  } else if (options.mode === 'webcam') {
    args.push('-thread_queue_size', '512', '-f', 'dshow', '-framerate', fps, '-i', `video=${options.webcam.name}`);
    args.push(...buildVideoEncodingArgs(), '-an', outputPath);
  } else if (options.mode === 'screenMic') {
    args.push(...buildScreenInputArgs(options));
    args.push('-thread_queue_size', '512', '-f', 'dshow', '-i', `audio=${options.microphone.name}`);
    args.push('-map', '0:v:0', '-map', '1:a:0', ...buildVideoEncodingArgs(), '-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1:first_pts=0', outputPath);
  } else if (options.mode === 'webcamMic') {
    args.push('-thread_queue_size', '512', '-f', 'dshow', '-framerate', fps, '-i', `video=${options.webcam.name}`);
    args.push('-thread_queue_size', '512', '-f', 'dshow', '-i', `audio=${options.microphone.name}`);
    args.push('-map', '0:v:0', '-map', '1:a:0', ...buildVideoEncodingArgs(), '-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1:first_pts=0', outputPath);
  }

  return args;
}

function buildRecordingFailureMessage(stderr) {
  const text = String(stderr || '').toLowerCase();
  if (/access is denied|permission denied/.test(text)) {
    return 'Windows denied access to the selected recording device. Check privacy permissions and try again.';
  }
  if (/device.*busy|resource busy|already in use|could not open/.test(text)) {
    return 'Windows could not open one of the selected recording devices. Close other apps using it, then try again.';
  }
  if (/video device not found|audio device not found|could not find.*device|no such device/.test(text)) {
    return 'Windows could not find one of the selected recording devices. Refresh the device list and choose it again.';
  }
  if (/unknown encoder|encoder.*not found|error initializing output stream/.test(text)) {
    return 'FFmpeg could not start the local recording encoder. Reinstall Local AI Hub if this continues.';
  }
  return 'FFmpeg stopped before the recording was completed. Refresh the devices and try again.';
}

function createRecordingId(date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `recording-${timestamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function buildRecordingPaths(recordingsRoot, date, id, extension) {
  const year = String(date.getFullYear());
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const directoryPath = path.join(recordingsRoot, year, day);
  const outputPath = path.join(directoryPath, `${id}.${extension}`);
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

function runOneShot(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout = trimOutput(`${stdout}${chunk}`); });
    child.stderr?.on('data', (chunk) => { stderr = trimOutput(`${stderr}${chunk}`); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: Number(code), stdout, stderr }));
  });
}

async function defaultTerminateProcessTree(pid, force, runCommand = runOneShot) {
  if (!pid || process.platform !== 'win32') {
    return false;
  }
  const args = ['/pid', String(pid), '/t'];
  if (force) {
    args.push('/f');
  }
  await runCommand('taskkill', args).catch(() => null);
  return true;
}

async function assertNoLinks(fsApi, rootPath, candidatePath) {
  if (!isPathInside(rootPath, candidatePath)) {
    throw new Error('Local AI Hub refused to use a recording path outside its managed recordings folder.');
  }
  const relative = path.relative(rootPath, candidatePath);
  let currentPath = path.resolve(rootPath);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    if (!(await fsApi.pathExists(currentPath))) {
      continue;
    }
    const stat = await fsApi.lstat(currentPath);
    if (stat.isSymbolicLink()) {
      throw new Error('Local AI Hub refused to use a recording path that contains a link or reparse point.');
    }
  }
}

function createRecordingService(dependencies = {}) {
  const fsApi = dependencies.fs || fs;
  const spawnProcess = dependencies.spawn || spawn;
  const ensureStorageFn = dependencies.ensureStorage || ensureStorage;
  const getAppPathsFn = dependencies.getAppPaths || getAppPaths;
  const resolveFfmpegPathFn = dependencies.resolveFfmpegPath || resolveFfmpegPath;
  const runOneShotFn = dependencies.runOneShot || runOneShot;
  const now = dependencies.now || (() => new Date());
  const gracefulStopMs = dependencies.gracefulStopMs || DEFAULT_GRACEFUL_STOP_MS;
  const terminationWaitMs = dependencies.terminationWaitMs || DEFAULT_TERMINATION_WAIT_MS;
  const terminateProcessTree = dependencies.terminateProcessTree || ((pid, force) => defaultTerminateProcessTree(pid, force, runOneShotFn));

  let activeRecording = null;
  let eventSink = null;
  let deviceCache = { devices: [], checkedAt: 0 };
  let ffmpegVersion = '';

  function emit(payload) {
    if (typeof eventSink === 'function') {
      try {
        eventSink(payload);
      } catch {
        // Recorder state should remain healthy even if a UI listener has gone away.
      }
    }
  }

  function serializeRecording(metadata) {
    if (!metadata) {
      return null;
    }
    return JSON.parse(JSON.stringify(metadata));
  }

  function emitStatus(recording, message = '') {
    const publicRecording = recording?.metadata
      ? { ...recording.metadata, outputPath: recording.outputPath }
      : recording;
    emit({
      type: 'recording-status',
      active: recording?.metadata?.status === 'recording' ? serializeRecording(publicRecording) : null,
      recording: serializeRecording(publicRecording),
      message,
    });
  }

  async function getFfmpegVersion() {
    if (ffmpegVersion) {
      return ffmpegVersion;
    }
    const result = await runOneShotFn(resolveFfmpegPathFn(), ['-version']).catch(() => null);
    ffmpegVersion = String(result?.stdout || result?.stderr || '').split(/\r?\n/)[0].trim().slice(0, 240);
    return ffmpegVersion;
  }

  async function listDevices(options = {}) {
    const checkedAt = Date.now();
    if (!options.forceRefresh && deviceCache.checkedAt && checkedAt - deviceCache.checkedAt < DEVICE_CACHE_MS) {
      return {
        microphones: deviceCache.devices.filter((device) => device.kind === 'audio'),
        webcams: deviceCache.devices.filter((device) => device.kind === 'video'),
        checkedAt: new Date(deviceCache.checkedAt).toISOString(),
      };
    }

    const result = await runOneShotFn(resolveFfmpegPathFn(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    const devices = parseDshowDevices(`${result.stderr || ''}\n${result.stdout || ''}`);
    deviceCache = { devices, checkedAt };
    return {
      microphones: devices.filter((device) => device.kind === 'audio'),
      webcams: devices.filter((device) => device.kind === 'video'),
      checkedAt: new Date(checkedAt).toISOString(),
    };
  }

  async function getRecordingRoots() {
    const storage = await ensureStorageFn();
    const recordingsRoot = storage?.recordingsRoot || getAppPathsFn().recordingsRoot;
    await fsApi.ensureDir(recordingsRoot);
    return { recordingsRoot: path.resolve(recordingsRoot) };
  }

  async function updateMetadata(recording, patch = {}) {
    recording.metadata = { ...recording.metadata, ...patch };
    recording.metadataWriteQueue = (recording.metadataWriteQueue || Promise.resolve())
      .catch(() => null)
      .then(() => writeJsonAtomic(fsApi, recording.sidecarPath, { ...recording.metadata }));
    await recording.metadataWriteQueue;
    return recording.metadata;
  }

  async function finalizeRecording(recording, code, signal) {
    if (recording.finalized) {
      return recording.metadata;
    }
    recording.finalized = true;
    clearInterval(recording.timer);

    const stoppedAtDate = now();
    let sizeBytes = 0;
    if (await fsApi.pathExists(recording.outputPath)) {
      sizeBytes = Number((await fsApi.stat(recording.outputPath)).size || 0);
    }

    let status = 'failed';
    let errorSummary = '';
    if (recording.cancelRequested) {
      status = recording.forced ? 'interrupted' : 'canceled';
    } else if (recording.stopRequested && !recording.forced && Number(code) === 0 && sizeBytes > 0) {
      status = 'completed';
    } else if (recording.stopRequested || recording.forced) {
      status = 'interrupted';
      errorSummary = sizeBytes > 0
        ? 'Recording stopped before FFmpeg could confirm a clean finalization.'
        : 'Recording stopped before a usable file was finalized.';
    } else {
      errorSummary = buildRecordingFailureMessage(recording.stderr);
    }

    if (status === 'completed' && sizeBytes <= 0) {
      status = 'failed';
      errorSummary = 'FFmpeg closed without creating a usable recording file.';
    }

    await updateMetadata(recording, {
      status,
      stoppedAt: stoppedAtDate.toISOString(),
      durationSeconds: Math.max(0, Math.round((stoppedAtDate.getTime() - new Date(recording.metadata.startedAt).getTime()) / 100) / 10),
      sizeBytes,
      stopMethod: recording.stopMethod || (recording.stopRequested ? 'process-exit' : 'unexpected-exit'),
      exitCode: Number.isFinite(Number(code)) ? Number(code) : null,
      exitSignal: signal || null,
      errorSummary,
    });

    if (activeRecording === recording) {
      activeRecording = null;
    }
    emitStatus(recording, status === 'completed' ? 'Recording saved.' : status === 'canceled' ? 'Recording canceled.' : errorSummary);
    recording.resolveClose(recording.metadata);
    return recording.metadata;
  }

  async function startRecording(input = {}, context = {}) {
    if (activeRecording) {
      throw new Error('A recording is already active. Stop or cancel it before starting another one.');
    }

    const deviceResult = await listDevices({ forceRefresh: false });
    const allDevices = [...deviceResult.microphones, ...deviceResult.webcams];
    const options = normalizeRecordingOptions(input, allDevices, Array.isArray(context.displays) ? context.displays : []);
    const { recordingsRoot } = await getRecordingRoots();
    const startedAtDate = now();
    const id = createRecordingId(startedAtDate);
    const paths = buildRecordingPaths(recordingsRoot, startedAtDate, id, options.container);
    await fsApi.ensureDir(paths.directoryPath);

    const metadata = {
      schemaVersion: 2,
      id,
      status: 'recording',
      backend: 'ffmpeg',
      mode: options.mode,
      videoSource: SCREEN_MODES.has(options.mode) ? 'screen' : WEBCAM_MODES.has(options.mode) ? 'webcam' : 'none',
      audioSources: options.microphone ? ['microphone'] : [],
      sources: {
        screen: ['screen', 'screenMic'].includes(options.mode),
        microphone: options.microphone ? { displayName: options.microphone.name } : null,
        webcam: options.webcam ? { displayName: options.webcam.name } : null,
        systemAudio: false,
      },
      systemAudio: false,
      microphone: options.microphone ? { displayName: options.microphone.name } : null,
      screenCaptureTarget: options.captureTarget ? { ...options.captureTarget } : null,
      outputRelativePath: path.relative(recordingsRoot, paths.outputPath).replace(/\\/g, '/'),
      fileName: path.basename(paths.outputPath),
      container: options.container,
      format: options.format,
      fps: options.fps,
      dimensions: options.captureTarget?.type === 'region'
        ? { width: options.captureTarget.width, height: options.captureTarget.height }
        : null,
      captureTarget: options.captureTarget ? { ...options.captureTarget } : null,
      codecs: VIDEO_MODES.has(options.mode)
        ? { video: 'libx264', audio: MICROPHONE_MODES.has(options.mode) ? 'aac' : null }
        : { video: null, audio: 'pcm_s16le' },
      startedAt: startedAtDate.toISOString(),
      stoppedAt: null,
      durationSeconds: null,
      sizeBytes: 0,
      ffmpegVersion: await getFfmpegVersion(),
      stopMethod: null,
      errorSummary: '',
    };

    await writeJsonAtomic(fsApi, paths.sidecarPath, metadata);
    const ffmpegPath = resolveFfmpegPathFn();
    const args = buildRecordingCommand(options, paths.outputPath);
    let child;
    try {
      child = spawnProcess(ffmpegPath, args, {
        cwd: paths.directoryPath,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failed = { metadata, sidecarPath: paths.sidecarPath };
      await updateMetadata(failed, {
        status: 'failed',
        stoppedAt: now().toISOString(),
        errorSummary: 'Local AI Hub could not start the recording process.',
      });
      throw new Error('Local AI Hub could not start FFmpeg for this recording.');
    }

    let resolveClose;
    const closePromise = new Promise((resolve) => { resolveClose = resolve; });
    const recording = {
      child,
      closePromise,
      resolveClose,
      metadata,
      metadataWriteQueue: Promise.resolve(),
      options,
      outputPath: paths.outputPath,
      sidecarPath: paths.sidecarPath,
      recordingsRoot,
      stderr: '',
      stdout: '',
      stopRequested: false,
      cancelRequested: false,
      forced: false,
      finalized: false,
      stopMethod: '',
      timer: null,
    };
    activeRecording = recording;

    child.stdout?.on('data', (chunk) => { recording.stdout = trimOutput(`${recording.stdout}${chunk}`); });
    child.stderr?.on('data', (chunk) => { recording.stderr = trimOutput(`${recording.stderr}${chunk}`); });
    child.once('error', (error) => {
      recording.stderr = trimOutput(`${recording.stderr}\n${error.message || error}`);
    });
    child.once('close', (code, signal) => {
      finalizeRecording(recording, code, signal).catch(() => {
        if (activeRecording === recording) {
          activeRecording = null;
        }
        recording.resolveClose(recording.metadata);
      });
    });

    emitStatus(recording, 'Recording started.');
    return serializeRecording({ ...metadata, outputPath: paths.outputPath });
  }

  async function requestStop(cancelRequested = false, options = {}) {
    const recording = activeRecording;
    if (!recording) {
      throw new Error('There is no active recording to stop.');
    }
    if (recording.stopRequested) {
      return recording.closePromise;
    }

    recording.stopRequested = true;
    recording.cancelRequested = cancelRequested;
    recording.stopMethod = 'stdin-q';

    try {
      if (recording.child?.stdin?.writable) {
        recording.child.stdin.write('q\n');
      }
    } catch {
      // The termination fallback below will handle a closed stdin pipe.
    }

    await updateMetadata(recording, { stopMethod: 'stdin-q' });

    let closed = await Promise.race([
      recording.closePromise.then(() => true),
      sleep(options.gracefulStopMs || gracefulStopMs).then(() => false),
    ]);

    if (!closed && recording.child?.pid) {
      recording.stopMethod = 'taskkill';
      await terminateProcessTree(recording.child.pid, false);
      closed = await Promise.race([
        recording.closePromise.then(() => true),
        sleep(options.terminationWaitMs || terminationWaitMs).then(() => false),
      ]);
    }

    if (!closed && recording.child?.pid) {
      recording.forced = true;
      recording.stopMethod = 'taskkill-force';
      await terminateProcessTree(recording.child.pid, true);
      closed = await Promise.race([
        recording.closePromise.then(() => true),
        sleep(options.terminationWaitMs || terminationWaitMs).then(() => false),
      ]);
    }

    if (!closed) {
      recording.forced = true;
      await finalizeRecording(recording, null, 'termination-timeout');
    }
    return recording.closePromise;
  }

  async function stopRecording() {
    return requestStop(false);
  }

  async function cancelRecording() {
    return requestStop(true, { gracefulStopMs: Math.min(gracefulStopMs, 3000) });
  }

  function getActiveRecording() {
    return activeRecording ? serializeRecording({ ...activeRecording.metadata, outputPath: activeRecording.outputPath }) : null;
  }

  async function collectSidecars(directoryPath, results, recordingsRoot) {
    if (!(await fsApi.pathExists(directoryPath))) {
      return;
    }
    await assertNoLinks(fsApi, recordingsRoot, directoryPath);
    const entries = await fsApi.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await collectSidecars(entryPath, results, recordingsRoot);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.recording.json')) {
        results.push(entryPath);
      }
    }
  }

  async function readRecordingSidecar(sidecarPath, recordingsRoot) {
    try {
      await assertNoLinks(fsApi, recordingsRoot, sidecarPath);
      const metadata = await fsApi.readJson(sidecarPath);
      if (!SAFE_RECORDING_ID.test(String(metadata?.id || '')) || !String(metadata?.outputRelativePath || '').trim()) {
        return null;
      }
      const outputPath = path.resolve(recordingsRoot, metadata.outputRelativePath);
      const expectedSidecarName = `${metadata.id}.recording.json`.toLowerCase();
      const outputExtension = path.extname(outputPath).toLowerCase();
      const expectedOutputName = `${metadata.id}${outputExtension}`.toLowerCase();
      if (
        !isPathInside(recordingsRoot, outputPath)
        || path.basename(sidecarPath).toLowerCase() !== expectedSidecarName
        || !['.mkv', '.wav', '.webm'].includes(outputExtension)
        || path.basename(outputPath).toLowerCase() !== expectedOutputName
      ) {
        return null;
      }
      return {
        ...metadata,
        outputPath,
        sidecarPath,
        fileExists: await fsApi.pathExists(outputPath),
      };
    } catch {
      return null;
    }
  }

  async function listRecentRecordings(options = {}) {
    const { recordingsRoot } = await getRecordingRoots();
    const sidecars = [];
    await collectSidecars(recordingsRoot, sidecars, recordingsRoot);
    const records = (await Promise.all(sidecars.map((sidecarPath) => readRecordingSidecar(sidecarPath, recordingsRoot))))
      .filter(Boolean)
      .sort((left, right) => new Date(right.startedAt || 0).getTime() - new Date(left.startedAt || 0).getTime());
    return records.slice(0, Math.max(1, Math.min(250, Number(options.limit || 100))));
  }

  async function findRecording(id) {
    const normalizedId = String(id || '').trim();
    if (!SAFE_RECORDING_ID.test(normalizedId)) {
      throw new Error('Local AI Hub could not identify that recording.');
    }
    if (activeRecording?.metadata?.id === normalizedId) {
      return { ...activeRecording.metadata, outputPath: activeRecording.outputPath, sidecarPath: activeRecording.sidecarPath };
    }
    const records = await listRecentRecordings({ limit: 250 });
    const recording = records.find((entry) => entry.id === normalizedId);
    if (!recording) {
      throw new Error('Local AI Hub could not find that recording anymore.');
    }
    return recording;
  }

  async function openRecording(id, openPath) {
    const recording = await findRecording(id);
    if (!(await fsApi.pathExists(recording.outputPath))) {
      throw new Error('Local AI Hub could not find that recording file anymore.');
    }
    const result = await openPath(recording.outputPath);
    if (result) {
      throw new Error(result);
    }
    return { message: 'Recording opened.' };
  }

  async function revealRecording(id, revealPath) {
    const recording = await findRecording(id);
    if (!(await fsApi.pathExists(recording.outputPath))) {
      throw new Error('Local AI Hub could not find that recording file anymore.');
    }
    revealPath(recording.outputPath);
    return { message: 'Recording revealed in File Explorer.' };
  }

  async function openRecordingsFolder(openPath) {
    const { recordingsRoot } = await getRecordingRoots();
    const result = await openPath(recordingsRoot);
    if (result) {
      throw new Error(result);
    }
    return { message: 'Recordings folder opened.', recordingsRoot };
  }

  async function deleteRecording(id, options = {}) {
    if (activeRecording?.metadata?.id === id) {
      throw new Error('Stop or cancel the active recording before deleting it.');
    }
    const recording = await findRecording(id);
    const { recordingsRoot } = await getRecordingRoots();
    const deletionPaths = [recording.outputPath, recording.sidecarPath].filter(Boolean);
    for (const targetPath of deletionPaths) {
      if (!isPathInside(recordingsRoot, targetPath)) {
        throw new Error('Local AI Hub refused to delete a recording outside its managed recordings folder.');
      }
      await assertNoLinks(fsApi, recordingsRoot, targetPath);
    }

    const existingPaths = [];
    for (const targetPath of deletionPaths) {
      if (await fsApi.pathExists(targetPath)) {
        const stat = await fsApi.lstat(targetPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error('Local AI Hub can only delete regular recording files and their metadata.');
        }
        existingPaths.push(targetPath);
      }
    }

    if (options.deleteMode === 'trash') {
      if (typeof options.trashItem !== 'function') {
        throw new Error('The Windows Recycle Bin is unavailable for this recording.');
      }
      let completed = 0;
      try {
        for (const targetPath of existingPaths) {
          await options.trashItem(targetPath);
          completed += 1;
        }
      } catch {
        const partial = completed ? ` Windows moved ${completed} recording item${completed === 1 ? '' : 's'} before the error.` : '';
        throw new Error(`Windows could not move this recording to the Recycle Bin.${partial} No permanent-delete fallback was used.`);
      }
    } else {
      for (const targetPath of existingPaths) {
        await fsApi.remove(targetPath);
      }
    }

    emit({ type: 'recording-deleted', active: null, recording: { id }, message: 'Recording deleted.' });
    return { id, deletionMode: options.deleteMode === 'trash' ? 'trash' : 'permanent', message: 'Recording deleted.' };
  }

  async function disposeRecording() {
    if (!activeRecording) {
      return null;
    }
    return requestStop(false);
  }

  return {
    cancelRecording,
    deleteRecording,
    disposeRecording,
    getActiveRecording,
    listDevices,
    listRecentRecordings,
    openRecording,
    openRecordingsFolder,
    revealRecording,
    setRecordingEventSink(sink) { eventSink = typeof sink === 'function' ? sink : null; },
    startRecording,
    stopRecording,
  };
}

const defaultService = createRecordingService();

module.exports = {
  cancelRecording: (...args) => defaultService.cancelRecording(...args),
  deleteRecording: (...args) => defaultService.deleteRecording(...args),
  disposeRecording: (...args) => defaultService.disposeRecording(...args),
  getActiveRecording: (...args) => defaultService.getActiveRecording(...args),
  listRecordingDevices: (...args) => defaultService.listDevices(...args),
  listRecentRecordings: (...args) => defaultService.listRecentRecordings(...args),
  openRecording: (...args) => defaultService.openRecording(...args),
  openRecordingsFolder: (...args) => defaultService.openRecordingsFolder(...args),
  revealRecording: (...args) => defaultService.revealRecording(...args),
  setRecordingEventSink: (...args) => defaultService.setRecordingEventSink(...args),
  startRecording: (...args) => defaultService.startRecording(...args),
  stopRecording: (...args) => defaultService.stopRecording(...args),
  createRecordingService,
  _test: {
    buildRecordingCommand,
    buildRecordingFailureMessage,
    buildRecordingPaths,
    normalizeCaptureTarget,
    normalizeFps,
    normalizeMode,
    normalizeRecordingOptions,
    parseDshowDevices,
  },
};
