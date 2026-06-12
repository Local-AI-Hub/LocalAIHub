const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createRecordingService, _test } = require('../electron/services/recordingService');
const { createSystemAudioRecordingService, normalizeSystemAudioOptions } = require('../electron/services/systemAudioRecordingService');
const { normalizeOverlaySelection } = require('../electron/services/regionSelectionService');
const { buildTrayMenuTemplate, getTrayTooltip } = require('../electron/services/trayMenuService');

const SAMPLE_DSHOW = [
  '[dshow @ 0001] "USB Camera" (video)',
  '[dshow @ 0001]   Alternative name "@device_pnp_camera"',
  '[dshow @ 0001] "Desk Microphone" (audio)',
  '[dshow @ 0001]   Alternative name "@device_cm_mic"',
].join('\n');
const SAMPLE_DISPLAYS = [
  { id: 'display-primary', name: 'Primary display', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
  { id: 'display-left', name: 'Left display', primary: false, bounds: { x: -1280, y: 0, width: 1280, height: 1024 }, scaleFactor: 1 },
];

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createSystemAudioHarness(recordingsRoot, options = {}) {
  let activeCapture = null;
  const starts = [];
  const events = [];
  const captureAdapter = {
    async start(config) {
      starts.push(config);
      const closed = createDeferred();
      const capture = {
        closed,
        async finish(clean, canceled = false) {
          if (options.writeOutput !== false) {
            await fs.ensureDir(path.dirname(config.outputPath));
            await fs.writeFile(config.outputPath, options.outputContent || 'electron-webm-data');
          }
          closed.resolve({
            clean,
            reason: clean ? 'media-recorder-stop' : 'capture-error',
            error: clean ? '' : 'Synthetic Electron capture failure.',
            mimeType: config.includeVideo ? 'video/webm;codecs=vp9,opus' : 'audio/webm;codecs=opus',
            stopMethod: canceled ? 'media-recorder-cancel' : 'media-recorder-stop',
          });
        },
      };
      activeCapture = capture;
      return {
        mimeType: config.includeVideo ? 'video/webm;codecs=vp9,opus' : 'audio/webm;codecs=opus',
        dimensions: config.includeVideo ? { width: config.captureTarget?.width || config.display.bounds.width, height: config.captureTarget?.height || config.display.bounds.height } : null,
        closed: closed.promise,
        stop: () => capture.finish(options.cleanStop !== false, false),
        cancel: () => capture.finish(options.cleanCancel !== false, true),
      };
    },
  };
  const service = createSystemAudioRecordingService({
    captureAdapter,
    ensureStorage: async () => ({ recordingsRoot }),
    getAppPaths: () => ({ recordingsRoot }),
    now: (() => {
      let clock = new Date('2026-06-12T13:00:00.000Z').getTime();
      return () => {
        const value = new Date(clock);
        clock += 3000;
        return value;
      };
    })(),
  });
  service.setRecordingEventSink((payload) => events.push(payload));
  return { events, getCapture: () => activeCapture, service, starts };
}
function createFakeChild(options = {}) {
  const child = new EventEmitter();
  child.pid = options.pid || 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.writes = [];
  child.stdin = {
    writable: true,
    write(value) {
      child.writes.push(String(value));
      options.onWrite?.(String(value), child);
    },
  };
  return child;
}

function createHarness(recordingsRoot, options = {}) {
  let currentChild = null;
  const terminationCalls = [];
  const events = [];
  const stopOrder = [];
  let recentScanCalls = 0;
  let clock = new Date('2026-06-12T12:00:00.000Z').getTime();
  const spawnCalls = [];
  const fsProxy = Object.create(fs);
  fsProxy.writeJson = async (...args) => {
    if (currentChild) stopOrder.push('metadata-write');
    return fs.writeJson(...args);
  };
  fsProxy.readdir = async (...args) => {
    recentScanCalls += 1;
    return fs.readdir(...args);
  };

  const service = createRecordingService({
    fs: fsProxy,
    ensureStorage: async () => ({ recordingsRoot }),
    getAppPaths: () => ({ recordingsRoot }),
    resolveFfmpegPath: () => 'C:\\LocalAIHub\\ffmpeg.exe',
    now: () => {
      const value = new Date(clock);
      clock += 3000;
      return value;
    },
    gracefulStopMs: options.gracefulStopMs || 100,
    terminationWaitMs: options.terminationWaitMs || 20,
    runOneShot: async (_command, args) => {
      if (args.includes('-list_devices')) return { code: 1, stdout: '', stderr: SAMPLE_DSHOW };
      if (args.includes('-version')) return { code: 0, stdout: 'ffmpeg version 6.1.1 test\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawn: (_command, args, spawnOptions) => {
      spawnCalls.push({ args, options: spawnOptions });
      const outputPath = args[args.length - 1];
      const child = createFakeChild({
        onWrite: async (value, target) => {
          stopOrder.push(`stdin:${String(value).trim()}`);
          if (value === 'q\n' && options.closeOnQ !== false) {
            await fs.ensureDir(path.dirname(outputPath));
            await fs.writeFile(outputPath, options.outputContent || 'recording-data');
            setImmediate(() => target.emit('close', options.gracefulExitCode ?? 0, null));
          }
        },
      });
      currentChild = child;
      return child;
    },
    terminateProcessTree: async (_pid, force) => {
      terminationCalls.push(force ? 'force' : 'graceful-tree');
      if (force && currentChild) {
        const outputPath = spawnCalls[spawnCalls.length - 1].args.at(-1);
        await fs.ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, 'interrupted-data');
        setImmediate(() => currentChild.emit('close', 1, 'SIGKILL'));
      }
      return true;
    },
  });
  service.setRecordingEventSink((payload) => events.push(payload));
  return {
    events,
    getChild: () => currentChild,
    getRecentScanCalls: () => recentScanCalls,
    service,
    spawnCalls,
    stopOrder,
    terminationCalls,
  };
}

async function getDevices(service) {
  const result = await service.listDevices({ forceRefresh: true });
  assert.strictEqual(result.microphones.length, 1, 'DirectShow parser should return one microphone.');
  assert.strictEqual(result.webcams.length, 1, 'DirectShow parser should return one webcam.');
  assert(result.microphones[0].id && result.webcams[0].id, 'Enumerated devices should have duplicate-safe IDs.');
  return result;
}

function verifyCommands() {
  const microphone = { id: 'audio-1', kind: 'audio', name: 'Desk Microphone' };
  const webcam = { id: 'video-1', kind: 'video', name: 'USB Camera' };
  const desktopTarget = { type: 'desktop' };
  const regionTarget = { type: 'region', displayId: 'display-primary', displayName: 'Primary display', x: 100, y: 120, width: 1280, height: 720 };
  const output = 'D:/recordings/capture.mkv';
  const modes = {
    screen: { mode: 'screen', fps: 15, microphone: null, webcam: null, captureTarget: desktopTarget },
    microphone: { mode: 'microphone', fps: null, microphone, webcam: null, captureTarget: null },
    webcam: { mode: 'webcam', fps: 30, microphone: null, webcam, captureTarget: null },
    screenMic: { mode: 'screenMic', fps: 15, microphone, webcam: null, captureTarget: desktopTarget },
    webcamMic: { mode: 'webcamMic', fps: 30, microphone, webcam, captureTarget: null },
  };

  for (const [mode, config] of Object.entries(modes)) {
    const args = _test.buildRecordingCommand(config, mode === 'microphone' ? output.replace('.mkv', '.wav') : output);
    assert.strictEqual(args.at(-1).includes('recordings'), true, `${mode} should end with the generated output path.`);
    assert(args.includes('-f'), `${mode} should select explicit input formats.`);
    if (mode !== 'microphone') assert(args.includes('libx264'), `${mode} should use software H.264 encoding.`);
  }

  const desktopArgs = _test.buildRecordingCommand(modes.screen, output);
  assert(desktopArgs.includes('gdigrab'), 'Screen mode should use GDIGrab.');
  assert.strictEqual(desktopArgs[desktopArgs.indexOf('-i') + 1], 'desktop', 'Desktop capture must use the fixed GDIGrab desktop source.');
  assert(!desktopArgs.includes('-offset_x') && !desktopArgs.includes('-video_size'), 'Desktop capture should remain the existing full-desktop command.');

  const regionArgs = _test.buildRecordingCommand({ ...modes.screen, captureTarget: regionTarget }, output);
  assert.deepStrictEqual(regionArgs.slice(regionArgs.indexOf('-offset_x'), regionArgs.indexOf('-i') + 2), [
    '-offset_x', '100', '-offset_y', '120', '-video_size', '1280x720', '-i', 'desktop',
  ], 'Region screen capture should use numeric offsets and video size before the fixed desktop input.');

  const regionMicArgs = _test.buildRecordingCommand({ ...modes.screenMic, captureTarget: regionTarget }, output);
  assert(regionMicArgs.includes('-offset_x') && regionMicArgs.includes('1280x720'), 'Screen plus microphone region capture should preserve region arguments.');
  assert.strictEqual(regionMicArgs.filter((entry) => entry === '-map').length, 2, 'Screen plus microphone region capture should map video and audio explicitly.');
  assert(regionMicArgs.includes('audio=Desk Microphone'), 'Screen plus microphone region capture should include the allowlisted microphone input.');

  assert(_test.buildRecordingCommand(modes.microphone, output).includes('pcm_s16le'), 'Microphone mode should use PCM WAV audio.');
  assert(_test.buildRecordingCommand(modes.screenMic, output).includes('aac'), 'Screen plus microphone should use AAC audio.');
  assert(_test.buildRecordingCommand(modes.webcamMic, output).filter((entry) => entry === '-map').length === 2, 'Webcam plus microphone should map video and audio explicitly.');

  assert.throws(() => _test.normalizeMode('screenWebcam'), /not available|supported recording modes/, 'Unsupported screen plus webcam mode should be rejected.');
  assert.throws(() => _test.normalizeFps(9), /between 10 and 60/, 'FPS below the safe bound should be rejected.');
  assert.throws(() => _test.normalizeFps(61), /between 10 and 60/, 'FPS above the safe bound should be rejected.');
  assert.strictEqual(_test.normalizeFps(undefined), 15, 'Recorder should default to the lower-impact 15 FPS setting.');
  assert.deepStrictEqual(_test.normalizeCaptureTarget(undefined, 'screen', SAMPLE_DISPLAYS), { type: 'desktop' }, 'Existing screen configs should default to full desktop capture.');
  assert.throws(() => _test.normalizeCaptureTarget({ type: 'region', displayId: 'display-primary', x: 0.5, y: 0, width: 640, height: 480 }, 'screen', SAMPLE_DISPLAYS), /whole number/, 'Fractional region coordinates should be rejected.');
  assert.throws(() => _test.normalizeCaptureTarget({ type: 'region', displayId: 'display-primary', x: 0, y: 0, width: 63, height: 480 }, 'screen', SAMPLE_DISPLAYS), /at least 64/, 'Undersized regions should be rejected.');
  assert.throws(() => _test.normalizeCaptureTarget({ type: 'region', displayId: 'display-primary', x: 0, y: 0, width: 16384, height: 16384 }, 'screen', SAMPLE_DISPLAYS), /too large/, 'Absurdly large regions should be rejected.');
  assert.throws(() => _test.normalizeCaptureTarget({ type: 'region', displayId: 'invented-display', x: 0, y: 0, width: 640, height: 480 }, 'screen', SAMPLE_DISPLAYS), /available display/, 'Region display IDs must come from the main-process allowlist.');
  assert.throws(() => _test.normalizeCaptureTarget({ type: 'region', displayId: 'display-primary', x: 1800, y: 900, width: 640, height: 480 }, 'screen', SAMPLE_DISPLAYS), /inside the selected display/, 'Regions outside the selected display should be rejected.');
  assert.throws(() => _test.normalizeCaptureTarget({ type: 'window', title: 'Calculator' }, 'screen', SAMPLE_DISPLAYS), /not available yet/, 'Unsupported window capture must not be accepted.');
  const rendererStringAttempt = _test.normalizeRecordingOptions({ mode: 'screen', captureTarget: { type: 'desktop', input: 'title=PowerShell' } }, [], SAMPLE_DISPLAYS);
  assert.deepStrictEqual(rendererStringAttempt.captureTarget, { type: 'desktop' }, 'Renderer-provided FFmpeg screen strings must be discarded.');
  const rendererStringArgs = _test.buildRecordingCommand(rendererStringAttempt, output);
  assert.strictEqual(rendererStringArgs[rendererStringArgs.indexOf('-i') + 1], 'desktop', 'Renderer input strings must never reach FFmpeg.');

  const devices = [microphone, webcam];
  assert.throws(
    () => _test.normalizeRecordingOptions({ mode: 'microphone', microphoneId: 'renderer-invented-device' }, devices, SAMPLE_DISPLAYS),
    /refreshed device list/,
    'Device IDs not present in the enumerated allowlist should be rejected.',
  );
}
function verifyRegionSelectionOverlay() {
  const display = { id: 'display-primary', name: 'Primary display', bounds: { x: 100, y: 50, width: 1280, height: 720 } };
  const identity = (rect) => rect;
  assert.deepStrictEqual(
    normalizeOverlaySelection({ startX: 420, startY: 330, endX: 20, endY: 30 }, display, identity),
    { displayId: 'display-primary', displayName: 'Primary display', x: 120, y: 80, width: 400, height: 300 },
    'Overlay selection should normalize reverse drags into absolute screen coordinates.',
  );

  const scaled = normalizeOverlaySelection(
    { startX: 10, startY: 20, endX: 210, endY: 120 },
    display,
    (rect) => ({ x: rect.x * 1.5, y: rect.y * 1.5, width: rect.width * 1.5, height: rect.height * 1.5 }),
  );
  assert.deepStrictEqual(scaled, {
    displayId: 'display-primary', displayName: 'Primary display', x: 165, y: 105, width: 300, height: 150,
  }, 'Overlay selection should convert display DIP coordinates to physical pixels through the supplied Electron converter.');

  const oddScaled = normalizeOverlaySelection(
    { startX: 0, startY: 0, endX: 101, endY: 101 },
    display,
    (rect) => ({ ...rect, width: 151.5, height: 151.5 }),
  );
  assert.strictEqual(oddScaled.width % 2, 0, 'Overlay width should be rounded down to an even H.264 dimension.');
  assert.strictEqual(oddScaled.height % 2, 0, 'Overlay height should be rounded down to an even H.264 dimension.');
  assert.throws(
    () => normalizeOverlaySelection({ startX: 0, startY: 0, endX: 20, endY: 20 }, display, identity),
    /at least 64 by 64/,
    'Overlay selections below the minimum physical size should be rejected.',
  );
}

async function verifyLifecycle(tempRoot) {
  const recordingsRoot = path.join(tempRoot, 'recordings');
  const graceful = createHarness(recordingsRoot);
  const devices = await getDevices(graceful.service);
  const metadata = await graceful.service.startRecording({
    mode: 'screen',
    fps: 15,
    outputPath: path.join(tempRoot, 'outside.mkv'),
  }, { displays: SAMPLE_DISPLAYS });
  assert(metadata.outputPath.startsWith(recordingsRoot + path.sep), 'Renderer-provided output paths must be ignored in favor of the recordings root.');
  assert.strictEqual(graceful.spawnCalls[0].options.shell, false, 'Recording processes must use shell: false.');
  assert.strictEqual(graceful.service.getActiveRecording().status, 'recording', 'Started metadata should be marked recording.');
  await assert.rejects(
    () => graceful.service.startRecording({ mode: 'screen', fps: 15 }),
    /already active/,
    'Concurrent recordings should be rejected.',
  );
  const recentScansBeforeStop = graceful.getRecentScanCalls();
  const completed = await graceful.service.stopRecording();
  assert.deepStrictEqual(graceful.getChild().writes, ['q\n'], 'Graceful stop should write q before considering process termination.');
  assert.strictEqual(graceful.stopOrder[0], 'stdin:q', 'FFmpeg should receive q before stop metadata or termination fallback work.');
  assert.strictEqual(graceful.getRecentScanCalls(), recentScansBeforeStop, 'Stop finalization must not scan the recent-recordings list.');
  assert.deepStrictEqual(graceful.terminationCalls, [], 'A clean q stop should not terminate the process tree.');
  assert.strictEqual(completed.status, 'completed', 'A clean nonempty output should be completed.');
  assert(completed.sizeBytes > 0, 'Completed metadata should include a nonzero size.');
  const completedSidecar = await fs.readJson(path.join(path.dirname(metadata.outputPath), `${metadata.id}.recording.json`));
  assert.strictEqual(completedSidecar.status, 'completed', 'Sidecar should transition from recording to completed.');
  assert.strictEqual(completedSidecar.backend, 'ffmpeg', 'Existing recording modes should retain the FFmpeg backend.');
  assert.deepStrictEqual(completedSidecar.audioSources, [], 'Screen-only FFmpeg metadata should use the composable audio source model.');
  assert.strictEqual(completedSidecar.stopMethod, 'stdin-q', 'Sidecar should record graceful stdin finalization.');
  assert.deepStrictEqual(completedSidecar.captureTarget, { type: 'desktop' }, 'Desktop sidecars should include the normalized capture target.');
  assert.strictEqual(graceful.events.at(-1)?.active, null, 'Completion events should clear active recording state for tray and renderer listeners.');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(completedSidecar, 'outputPath'), false, 'Sidecars should not persist absolute output paths.');
  assert.strictEqual(_test.buildRecordingFailureMessage('Access is denied'), 'Windows denied access to the selected recording device. Check privacy permissions and try again.', 'Raw FFmpeg permission errors should be converted to plain English.');

  const regionHarness = createHarness(path.join(tempRoot, 'region-recordings'));
  await getDevices(regionHarness.service);
  const regionStarted = await regionHarness.service.startRecording({
    mode: 'screen',
    fps: 15,
    captureTarget: { type: 'region', displayId: 'display-primary', x: 100, y: 120, width: 1280, height: 720 },
  }, { displays: SAMPLE_DISPLAYS });
  const regionCompleted = await regionHarness.service.stopRecording();
  const regionSidecar = await fs.readJson(path.join(path.dirname(regionStarted.outputPath), `${regionCompleted.id}.recording.json`));
  assert.deepStrictEqual(regionSidecar.captureTarget, {
    type: 'region', displayId: 'display-primary', displayName: 'Primary display', x: 100, y: 120, width: 1280, height: 720,
  }, 'Region sidecars should persist only the normalized display and coordinates.');
  assert.deepStrictEqual(regionSidecar.dimensions, { width: 1280, height: 720 }, 'Region metadata should record output dimensions.');
  assert(regionHarness.spawnCalls[0].args.includes('-offset_x') && regionHarness.spawnCalls[0].args.includes('1280x720'), 'Region lifecycle should launch FFmpeg with region arguments.');

  const canceledHarness = createHarness(path.join(tempRoot, 'cancel-recordings'));
  await getDevices(canceledHarness.service);
  await canceledHarness.service.startRecording({ mode: 'microphone', microphoneId: devices.microphones[0].id });
  const canceled = await canceledHarness.service.cancelRecording();
  assert.strictEqual(canceled.status, 'canceled', 'Graceful cancel should not be reported as completed.');

  const forcedHarness = createHarness(path.join(tempRoot, 'forced-recordings'), { closeOnQ: false });
  await getDevices(forcedHarness.service);
  await forcedHarness.service.startRecording({ mode: 'screen', fps: 15 });
  const interrupted = await forcedHarness.service.stopRecording();
  assert.deepStrictEqual(forcedHarness.getChild().writes, ['q\n'], 'Forced fallback must still attempt q first.');
  assert.deepStrictEqual(forcedHarness.terminationCalls, ['graceful-tree', 'force'], 'Stop should escalate from non-forced tree termination to forced termination.');
  assert.strictEqual(interrupted.status, 'interrupted', 'Forced termination must never be marked successful.');
  assert.strictEqual(interrupted.stopMethod, 'taskkill-force', 'Forced metadata should identify the final stop method.');
}

async function verifySystemAudioLifecycle(tempRoot) {
  const displays = SAMPLE_DISPLAYS.map((display) => ({ ...display, captureBounds: { ...display.bounds } }));
  const audioOnlyOptions = normalizeSystemAudioOptions({ mode: 'systemAudio', systemAudio: true, displayId: 'display-primary' }, [], displays);
  assert.strictEqual(audioOnlyOptions.videoSource, 'none', 'System-audio-only capture should discard the required display video track.');
  assert.deepStrictEqual(audioOnlyOptions.audioSources, ['systemAudio'], 'System-audio-only capture should use the composable audio source model.');
  const screenOptions = normalizeSystemAudioOptions({ mode: 'screen', systemAudio: true, displayId: 'display-primary', fps: 15, captureTarget: { type: 'desktop', displayId: 'display-primary' } }, [], displays);
  assert.strictEqual(screenOptions.videoSource, 'screen', 'Screen plus system audio should use the Electron screen backend.');
  assert.strictEqual(screenOptions.captureTarget.displayId, 'display-primary', 'Electron full-display capture should retain the selected display.');
  const regionOptions = normalizeSystemAudioOptions({ mode: 'screen', systemAudio: true, displayId: 'display-primary', fps: 15, captureTarget: { type: 'region', displayId: 'display-primary', x: 100, y: 120, width: 640, height: 480 } }, [], displays);
  assert.strictEqual(regionOptions.captureTarget.type, 'region', 'Electron screen plus system audio should accept validated regions.');
  assert.throws(() => normalizeSystemAudioOptions({ mode: 'screenMic', systemAudio: true, displayId: 'display-primary' }, [], displays), /cannot yet be combined/, 'Screen plus microphone plus system audio should remain explicitly unsupported.');
  assert.throws(() => normalizeSystemAudioOptions({ mode: 'screen', systemAudio: true, displayId: 'display-primary', microphoneId: 'renderer-device' }, [], displays), /cannot yet be combined/, 'Renderer microphone identifiers must not enter the Electron backend.');
  assert.throws(() => normalizeSystemAudioOptions({ mode: 'screen', systemAudio: true, displayId: 'display-primary', captureTarget: { type: 'window' } }, [], displays), /Window capture is not available/, 'Electron window capture should remain rejected.');
  assert.throws(() => normalizeSystemAudioOptions({ mode: 'systemAudio', systemAudio: true, displayId: 'invented' }, [], displays), /available display/, 'System audio must use a main-process enumerated display.');

  const recordingsRoot = path.join(tempRoot, 'system-audio-recordings');
  const harness = createSystemAudioHarness(recordingsRoot);
  const started = await harness.service.startRecording({ mode: 'systemAudio', systemAudio: true, displayId: 'display-primary' }, { displays });
  assert.strictEqual(started.backend, 'electron', 'Electron recording metadata should identify its backend.');
  assert.strictEqual(started.systemAudio, true, 'Electron recording metadata should identify system audio.');
  assert.deepStrictEqual(started.audioSources, ['systemAudio'], 'Electron recording metadata should contain composable audio sources.');
  assert.strictEqual(started.container, 'webm', 'Electron recordings should use WebM.');
  assert.match(started.mimeType, /^audio\/webm/, 'System-audio-only metadata should use an audio WebM MIME type.');
  await assert.rejects(() => harness.service.startRecording({ mode: 'systemAudio', systemAudio: true, displayId: 'display-primary' }, { displays }), /already active/, 'Only one Electron recording should run at a time.');
  const completed = await harness.service.stopRecording();
  assert.strictEqual(completed.status, 'completed', 'A clean Electron MediaRecorder stop with output should complete.');
  assert(completed.sizeBytes > 0, 'Completed Electron metadata should include output size.');
  assert.strictEqual(completed.stopMethod, 'media-recorder-stop', 'Electron metadata should identify MediaRecorder stop.');
  assert.strictEqual(harness.events.at(-1)?.active, null, 'Electron completion should clear shared active recording state.');
  const sidecarPath = path.join(path.dirname(started.outputPath), `${started.id}.recording.json`);
  const sidecar = await fs.readJson(sidecarPath);
  assert.strictEqual(sidecar.backend, 'electron', 'Electron sidecars should persist backend metadata.');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sidecar, 'outputPath'), false, 'Electron sidecars must not persist absolute output paths.');

  const listingService = createRecordingService({
    ensureStorage: async () => ({ recordingsRoot }),
    getAppPaths: () => ({ recordingsRoot }),
    resolveFfmpegPath: () => 'ffmpeg.exe',
    runOneShot: async () => ({ code: 1, stdout: '', stderr: '' }),
  });
  const listed = await listingService.listRecentRecordings();
  assert(listed.some((entry) => entry.id === started.id && entry.outputPath.endsWith('.webm')), 'Recent recordings should include Electron WebM output.');
  await listingService.deleteRecording(started.id, { deleteMode: 'permanent' });
  assert(!(await fs.pathExists(started.outputPath)) && !(await fs.pathExists(sidecarPath)), 'Deleting an Electron recording should remove WebM output and sidecar.');

  const cancelHarness = createSystemAudioHarness(path.join(tempRoot, 'system-audio-cancel'));
  await cancelHarness.service.startRecording({ mode: 'screen', systemAudio: true, displayId: 'display-primary', fps: 15, captureTarget: { type: 'desktop', displayId: 'display-primary' } }, { displays });
  const canceled = await cancelHarness.service.cancelRecording();
  assert.strictEqual(canceled.status, 'canceled', 'A clean Electron cancel must not be marked completed.');

  const interruptedHarness = createSystemAudioHarness(path.join(tempRoot, 'system-audio-interrupted'), { cleanCancel: false });
  await interruptedHarness.service.startRecording({ mode: 'systemAudio', systemAudio: true, displayId: 'display-primary' }, { displays });
  const interrupted = await interruptedHarness.service.cancelRecording();
  assert.strictEqual(interrupted.status, 'interrupted', 'An unclean Electron cancel must be marked interrupted.');
}
async function verifyListingAndDeletion(tempRoot) {
  const recordingsRoot = path.join(tempRoot, 'delete-recordings');
  const harness = createHarness(recordingsRoot);
  await getDevices(harness.service);
  const started = await harness.service.startRecording({ mode: 'screen', fps: 15 });
  const completed = await harness.service.stopRecording();
  const sidecarPath = path.join(path.dirname(started.outputPath), `${completed.id}.recording.json`);

  await fs.writeJson(path.join(recordingsRoot, 'malformed.recording.json'), { nope: true });
  await fs.writeJson(path.join(recordingsRoot, 'outside.recording.json'), {
    id: 'recording-outside-1234',
    outputRelativePath: '../../outside.mkv',
    startedAt: new Date().toISOString(),
  });
  await fs.writeJson(path.join(recordingsRoot, 'recording-misdirected-1234.recording.json'), {
    id: 'recording-misdirected-1234',
    outputRelativePath: path.relative(recordingsRoot, started.outputPath),
    startedAt: new Date().toISOString(),
  });
  const listed = await harness.service.listRecentRecordings();
  assert(listed.some((entry) => entry.id === completed.id), 'Valid completed recordings should be listed.');
  assert(!listed.some((entry) => entry.id === 'recording-outside-1234'), 'Outside metadata paths should be ignored.');
  assert(!listed.some((entry) => entry.id === 'recording-misdirected-1234'), 'A sidecar must not claim another recording file inside the managed root.');
  assert.strictEqual(listed.filter((entry) => entry.id).length, 1, 'Malformed sidecars should be ignored.');

  await harness.service.deleteRecording(completed.id, { deleteMode: 'permanent' });
  assert(!(await fs.pathExists(started.outputPath)), 'Permanent deletion should remove the recording file.');
  assert(!(await fs.pathExists(sidecarPath)), 'Permanent deletion should remove the recording sidecar.');

  const trashHarness = createHarness(path.join(tempRoot, 'trash-recordings'));
  await getDevices(trashHarness.service);
  const trashStarted = await trashHarness.service.startRecording({ mode: 'screen', fps: 15 });
  const trashCompleted = await trashHarness.service.stopRecording();
  let permanentRemoveCalled = false;
  const originalRemove = fs.remove;
  const fsProxy = Object.create(fs);
  fsProxy.remove = async (...args) => { permanentRemoveCalled = true; return originalRemove(...args); };
  const trashService = createRecordingService({
    fs: fsProxy,
    ensureStorage: async () => ({ recordingsRoot: path.join(tempRoot, 'trash-recordings') }),
    getAppPaths: () => ({ recordingsRoot: path.join(tempRoot, 'trash-recordings') }),
    resolveFfmpegPath: () => 'ffmpeg.exe',
    runOneShot: async () => ({ code: 1, stderr: SAMPLE_DSHOW, stdout: '' }),
  });
  await assert.rejects(
    () => trashService.deleteRecording(trashCompleted.id, { deleteMode: 'trash', trashItem: async () => { throw new Error('trash unavailable'); } }),
    /No permanent-delete fallback/,
    'Recycle Bin failure should surface without permanent fallback.',
  );
  assert.strictEqual(permanentRemoveCalled, false, 'Recycle Bin failure must not call permanent removal.');
  assert(await fs.pathExists(trashStarted.outputPath), 'Recycle Bin failure should preserve the recording file.');
}

function verifyTrayAndLayout() {
  const resourceStripText = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ResourceStrip.jsx'), 'utf8');
  const panelText = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'RecorderPanel.jsx'), 'utf8');
  const mainText = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

  assert(resourceStripText.includes("['library', 'store', 'models', 'recorder', 'pipelines', 'statistics', 'settings'].includes(activeTab)"), 'Recorder should use the same compact ResourceStrip shell as the other main tabs.');
  assert(resourceStripText.includes("activeTab === 'recorder'") && resourceStripText.includes("? 'Recorder'"), 'Recorder should have its own compact shared header label.');
  assert(panelText.includes('className="min-h-0 flex-1 overflow-y-auto pb-4 pr-1"'), 'Recorder content should use the same contained internal-scroll shell as Settings and other main tabs.');
  assert(panelText.includes('Finalizing recording; this can take a few seconds while the local capture backend writes the file.'), 'Slow finalization should describe the active local backend.');
  const stopFunctionSource = panelText.match(/async function stop\(\) \{([\s\S]*?)\n  \}\n\n  async function cancel/)?.[1] || '';
  assert(stopFunctionSource && !stopFunctionSource.includes('await loadRecordings()'), 'Recorder Stop should not wait for the recent-recordings scan.');

  let stopCalls = 0;
  const activeRecording = { id: 'recording-test-1234', fileName: 'recording-test-1234.mkv' };
  const buildActiveTemplate = () => buildTrayMenuTemplate({
    activeRecording,
    showWindow: () => {},
    stopRecording: () => { stopCalls += 1; },
    toolItems: [{ label: 'Launch ComfyUI' }],
    quit: () => {},
  });
  const firstTemplate = buildActiveTemplate();
  const secondTemplate = buildActiveTemplate();
  const stopItems = firstTemplate.filter((item) => item.label === 'Stop Recording');
  assert.strictEqual(stopItems.length, 1, 'Active tray menus should contain exactly one Stop Recording action.');
  assert.strictEqual(secondTemplate.filter((item) => item.label === 'Stop Recording').length, 1, 'Repeated tray status refreshes should not duplicate Stop Recording.');
  stopItems[0].click();
  assert.strictEqual(stopCalls, 1, 'Tray Stop Recording should call its main-process stop callback.');
  assert.strictEqual(getTrayTooltip(activeRecording), 'Local AI Hub - Recording in progress', 'Active tray tooltip should visibly identify recording state.');

  const inactiveTemplate = buildTrayMenuTemplate({ activeRecording: null, toolItems: [{ label: 'Launch ComfyUI' }] });
  assert.strictEqual(inactiveTemplate.filter((item) => item.label === 'Stop Recording').length, 0, 'Completed recording state should remove Stop Recording from the tray.');
  assert.strictEqual(getTrayTooltip(null), 'Local AI Hub', 'Inactive tray tooltip should return to normal.');
  assert(mainText.includes('tray?.popUpContextMenu();'), 'Left-clicking the tray during recording should expose the context menu.');
  assert(mainText.includes('trayRecordingStopPromise = stopRecording()'), 'Tray Stop should call the main-process recording service directly without RecorderPanel mounted.');
  assert(mainText.includes('updateTrayMenu({ refreshTools: false })'), 'Recording status should refresh tray state without waiting for tool discovery.');
}
function verifyScopedApiSurface() {
  const preloadText = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const mainText = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const panelText = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'RecorderPanel.jsx'), 'utf8');
  const capturePreloadText = fs.readFileSync(path.join(__dirname, '..', 'electron', 'systemAudioCapturePreload.js'), 'utf8');
  const captureRendererText = fs.readFileSync(path.join(__dirname, '..', 'electron', 'system-audio-capture.js'), 'utf8');
  const captureAdapterText = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'systemAudioCaptureAdapter.js'), 'utf8');
  const requiredChannels = ['select-region', 'list-displays', 'list-devices', 'get-active', 'list', 'start', 'stop', 'cancel', 'open', 'reveal', 'open-folder', 'delete'];
  for (const channel of requiredChannels) {
    assert(mainText.includes(`recordings:${channel}`), `Main process should register recordings:${channel}.`);
  }
  assert(preloadText.includes("listRecordingDisplays: () => invoke('recordings:list-displays')"), 'Preload should expose only the scoped display-list method.');
  assert(preloadText.includes("selectRecordingRegion: (displayId) => invoke('recordings:select-region', { displayId })"), 'Preload should expose only a scoped display-ID region selector.');
  assert(preloadText.includes("startRecording: (payload) => invoke('recordings:start', payload)"), 'Preload should expose the scoped start method.');
  assert(!preloadText.includes('recordings:command') && !preloadText.includes('recordings:output-path'), 'Preload must not expose raw commands or arbitrary output-path APIs.');
  assert(panelText.includes('No webcam detected. Webcam modes are disabled.'), 'Recorder UI should explain when webcam modes are unavailable.');
  assert(panelText.includes('disabled={!modeAvailability[entry.id]}'), 'Unavailable webcam modes should be disabled in the mode selector.');
  assert(panelText.includes('<option value="desktop">{usesSystemAudio') && panelText.includes('<option value="region">Region</option>'), 'Recorder UI should expose desktop/display and region capture targets.');
  assert(!panelText.includes('<option value="window">'), 'Recorder UI must not expose unsupported window capture.');
  assert(mainText.includes("{ displays: listRecordingDisplays() }"), 'Recording start should validate regions against main-process display enumeration.');
  assert(mainText.includes("preload: path.join(__dirname, 'regionSelectionPreload.js')"), 'Region selection should use a dedicated isolated preload.');
  assert(mainText.includes("sandbox: true") && mainText.includes("setWindowOpenHandler(() => ({ action: 'deny' }))"), 'Region selection should use a sandboxed window that denies new windows.');
  assert(mainText.includes("screen.dipToScreenRect(regionSelectionWindow, dipRect)"), 'Region selection should convert DIP coordinates through Electron before returning FFmpeg coordinates.');
  assert(mainText.includes("settleRecordingRegionSelection({ canceled: true, region: null })"), 'Closing or canceling the overlay should resolve as canceled.');
  const overlayText = fs.readFileSync(path.join(__dirname, '..', 'electron', 'region-selection.js'), 'utf8');
  const overlayHtml = fs.readFileSync(path.join(__dirname, '..', 'electron', 'region-selection.html'), 'utf8');
  assert(panelText.includes("'Select region'") || panelText.includes('Select region'), 'Recorder UI should expose a Select region action for region mode.');
  assert(overlayText.includes("event.key === 'Escape'") && overlayHtml.includes('id="cancel-button"'), 'The overlay should support Esc and a visible Cancel control.');
  assert(!overlayText.includes('startRecording') && !overlayHtml.includes('Start recording'), 'Region selection must not start recording automatically.');
  assert(panelText.includes("{ id: 'systemAudio', label: 'System audio only'") && panelText.includes('Include system audio'), 'Recorder UI should expose system-audio-only and screen plus system-audio choices.');
  assert(panelText.includes('Electron loopback capture') && panelText.includes('WebM (Opus audio)'), 'Recorder UI should identify the Electron backend and output format.');
  assert(panelText.includes('cross-backend audio synchronization is deferred'), 'Unsupported microphone/webcam plus system-audio combinations should have a clear explanation.');
  assert(mainText.includes('recordingStartInProgress || getActiveRecording()'), 'The main-process coordinator should reject overlapping FFmpeg and Electron starts.');
  assert(mainText.includes('systemAudioRecordingService.getActiveRecording()') && mainText.includes('systemAudioRecordingService.stopRecording()'), 'Shared Stop and tray lifecycle should route Electron recordings through the same coordinator.');
  assert(captureAdapterText.includes("audio: 'loopback'") && captureAdapterText.includes("setWindowOpenHandler(() => ({ action: 'deny' }))"), 'Electron capture should request loopback through a locked-down capture window.');
  assert(captureAdapterText.includes('event.sender !== active.window.webContents'), 'Electron capture IPC should reject unexpected renderer senders.');
  assert(capturePreloadText.includes("ipcRenderer.invoke('system-audio-capture:chunk', bytes)"), 'Capture preload should expose only scoped chunk transfer.');
  assert(!capturePreloadText.includes('outputPath') && !capturePreloadText.includes('command'), 'Capture renderer must not receive arbitrary paths or commands.');
  assert(captureRendererText.includes('getDisplayMedia') && captureRendererText.includes('MediaRecorder'), 'Capture renderer should use Chromium display media and MediaRecorder.');}

async function main() {
  verifyCommands();
  verifyRegionSelectionOverlay();
  verifyTrayAndLayout();
  verifyScopedApiSurface();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-recorder-'));
  try {
    await verifyLifecycle(tempRoot);
    await verifySystemAudioLifecycle(tempRoot);
    await verifyListingAndDeletion(tempRoot);
  } finally {
    await fs.remove(tempRoot);
  }
  console.log('Recorder verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
