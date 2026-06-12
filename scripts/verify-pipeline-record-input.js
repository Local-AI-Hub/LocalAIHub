const assert = require('assert');
const fs = require('fs-extra');
const Module = require('module');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const TEST_ROOT = path.join(os.tmpdir(), 'local-ai-hub-verify-pipeline-record-input');
const RUNTIMES_ROOT = path.join(TEST_ROOT, 'runtimes');
const RECORDINGS_ROOT = path.join(TEST_ROOT, 'recordings');

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
  if (request === 'electron') {
    return {
      app: {
        getPath() {
          return TEST_ROOT;
        },
        isPackaged: false,
      },
      nativeImage: null,
    };
  }
  if (request === './configService' && normalizedParent.includes('/electron/services/')) {
    return {
      ensureStorage: async () => {
        await fs.ensureDir(RUNTIMES_ROOT);
        await fs.ensureDir(RECORDINGS_ROOT);
      },
      getAppPaths: () => ({
        recordingsRoot: RECORDINGS_ROOT,
        runtimesRoot: RUNTIMES_ROOT,
      }),
      listGraphWorkflowPresets: async () => [],
      listPromptStyles: async () => [],
    };
  }
  if (normalizedParent.endsWith('/electron/services/pipelineExecutionService.js')) {
    if (request === './providerRegistry') return { initializeProviderRegistry: async () => {} };
    if (request === './providerService') return { listProviderConnections: async () => [], chatWithProvider: async () => ({}), runProviderOperation: async () => ({}) };
    if (request === './toolRegistry') return { getToolCatalog: () => [], initializeToolRegistry: async () => {} };
    if (request === './toolStateService') return { buildMergedToolStateList: async () => [], getResolvedToolState: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const schema = require('../electron/shared/pipelineSchema.cjs');
const capabilities = require('../electron/shared/pipelineCapabilities.cjs');
const {
  cancelPipelineRecordInput,
  getActiveRunSnapshot,
  handlePipelineRecordingStatus,
  resumePipelineValidation,
  runPipeline,
  setPipelineRecordingController,
  startPipelineRecordInput,
  stopPipelineRecordInput,
} = require('../electron/services/pipelineExecutionService');
const { deletePipelineOutput } = require('../electron/services/pipelineOutputStoreService');
const { resolvePipelineRecordingPaths } = require('../electron/services/pipelineRecordingStorageService');
const { buildTrayMenuTemplate } = require('../electron/services/trayMenuService');
const { createRecordingService, _test: recorderTest } = require('../electron/services/recordingService');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(description, predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await wait(25);
  }
  throw new Error(`Timed out while waiting for ${description}.`);
}

function createRecordNode(mode, overrides = {}) {
  return schema.createNode('recordInput', {
    id: overrides.id || `record-${mode}`,
    config: {
      mode,
      microphoneId: 'audio-device',
      webcamId: 'video-device',
      displayId: 'display-primary',
      fps: 15,
      captureTarget: { type: 'desktop' },
      ...(overrides.config || {}),
    },
  });
}

function verifySchemaAndTyping() {
  const definition = schema.getNodeTypeDefinition('recordInput');
  assert(definition, 'Record Input should exist in the pipeline schema.');
  assert.strictEqual(definition.label, 'Record Input');
  assert(capabilities.PIPELINE_RECORD_INPUT_CAPABILITY?.interactive, 'Record Input should be represented in pipeline capabilities.');
  assert.strictEqual(capabilities.PIPELINE_RECORD_INPUT_CAPABILITY.autoStart, false, 'Record Input capability must prohibit auto-start.');
  assert(schema.NODE_TYPE_LIST.some((entry) => entry.type === 'recordInput' && entry.category === 'Inputs'), 'Record Input should flow into the Inputs palette.');

  const expectedKinds = {
    microphone: 'audio',
    systemAudio: 'audio',
    screen: 'video',
    screenMic: 'video',
    webcam: 'video',
    webcamMic: 'video',
    screenSystemAudio: 'video',
  };
  for (const [mode, expectedKind] of Object.entries(expectedKinds)) {
    const node = createRecordNode(mode);
    assert.strictEqual(schema.getRecordInputConfigValidationMessage(node), '', `${mode} should be a supported production config.`);
    assert.strictEqual(schema.getRecordInputOutputKind(node), expectedKind, `${mode} should emit ${expectedKind}.`);
    assert.deepStrictEqual(schema.getPipelineNodePorts(node, 'output').map((port) => port.id), [expectedKind], `${mode} should expose only its active output port.`);
  }

  const regionSystemAudio = createRecordNode('screenSystemAudio', {
    config: {
      captureTarget: { type: 'region', displayId: 'display-primary', x: 10, y: 20, width: 640, height: 480 },
    },
  });
  assert.strictEqual(schema.getRecordInputConfigValidationMessage(regionSystemAudio), '', 'Region plus system audio should validate.');
  assert.strictEqual(schema.buildRecordInputBackendRequest(regionSystemAudio).systemAudio, true, 'Region plus system audio should route to Electron loopback.');

  const invalidMode = createRecordNode('screenWebcam');
  assert(/not available|supported/i.test(schema.getRecordInputConfigValidationMessage(invalidMode)), 'Unsupported combinations should be rejected clearly.');
  const windowCapture = createRecordNode('screen', { config: { captureTarget: { type: 'window' } } });
  assert(/Window capture is not available/i.test(schema.getRecordInputConfigValidationMessage(windowCapture)), 'Window capture should stay unsupported.');

  const audioRecord = createRecordNode('microphone', { id: 'audio-record' });
  const videoOutput = schema.createNode('videoOutput', { id: 'video-output' });
  const invalidAudioToVideo = schema.analyzePipeline(schema.createEmptyPipeline({
    nodes: [audioRecord, videoOutput],
    edges: [schema.createEdge(audioRecord.id, 'video', videoOutput.id, 'video')],
  }));
  assert.strictEqual(invalidAudioToVideo.executable, false, 'An audio Record Input must not wire through the video port.');

  const videoRecord = createRecordNode('screen', { id: 'video-record' });
  const audioOutput = schema.createNode('audioOutput', { id: 'audio-output' });
  const invalidVideoToAudio = schema.analyzePipeline(schema.createEmptyPipeline({
    nodes: [videoRecord, audioOutput],
    edges: [schema.createEdge(videoRecord.id, 'audio', audioOutput.id, 'audio')],
  }));
  assert.strictEqual(invalidVideoToAudio.executable, false, 'A video Record Input must not wire through the audio port.');

  const microphoneRetry = schema.buildRecordInputRetryOverrideConfig(createRecordNode('microphone'), { microphoneId: 'audio-device-2' });
  assert.deepStrictEqual(microphoneRetry, { microphoneId: 'audio-device-2' }, 'Microphone retry should allow a temporary device change.');
  const regionRetry = schema.buildRecordInputRetryOverrideConfig(regionSystemAudio, {
    displayId: 'display-secondary',
    fps: 30,
    captureTarget: { type: 'region', displayId: 'display-secondary', x: 12, y: 24, width: 800, height: 600 },
  });
  assert.strictEqual(regionRetry.fps, 30, 'Video retry should allow an FPS adjustment.');
  assert.strictEqual(regionRetry.captureTarget.width, 800, 'Region retry should allow updated coordinates and dimensions.');
  assert.strictEqual(regionRetry.displayId, 'display-secondary', 'System-audio screen retry should allow a new display target.');
  assert.throws(
    () => schema.buildRecordInputRetryOverrideConfig(createRecordNode('microphone'), { mode: 'screen' }),
    /cannot change.*audio output|another recording mode/i,
    'Validation retry must not change audio output to video output.',
  );
  assert.throws(
    () => schema.buildRecordInputRetryOverrideConfig(createRecordNode('screen'), { mode: 'microphone' }),
    /cannot change.*video output|another recording mode/i,
    'Validation retry must not change video output to audio output.',
  );

  const validationNode = schema.createNode('validation', { id: 'mode-validation', config: { mode: 'user' } });
  const audioModePipeline = schema.createEmptyPipeline({
    nodes: [createRecordNode('microphone', { id: 'mode-record' }), validationNode],
    edges: [schema.createEdge('mode-record', 'audio', validationNode.id, 'input')],
  });
  const audioToAudio = schema.applyRecordInputModeChange(audioModePipeline, 'mode-record', 'systemAudio');
  assert.strictEqual(audioToAudio.changed, true, 'Audio-to-audio mode changes should apply immediately.');
  assert.strictEqual(audioToAudio.pipeline.edges.length, 1, 'Audio-to-audio mode changes should preserve compatible outgoing edges.');
  const audioToVideoBlocked = schema.applyRecordInputModeChange(audioModePipeline, 'mode-record', 'screen');
  assert.strictEqual(audioToVideoBlocked.requiresConfirmation, true, 'Audio-to-video mode changes with outgoing edges should require confirmation.');
  assert.strictEqual(audioToVideoBlocked.pipeline.edges.length, 1, 'Unconfirmed cross-kind mode changes should leave the graph untouched.');
  const audioToVideoConfirmed = schema.applyRecordInputModeChange(audioModePipeline, 'mode-record', 'screen', { removeIncompatibleConnections: true });
  assert.strictEqual(audioToVideoConfirmed.pipeline.edges.length, 0, 'Confirmed audio-to-video changes should remove incompatible outgoing edges.');
  assert.deepStrictEqual(schema.getPipelineNodePorts(audioToVideoConfirmed.pipeline.nodes.find((node) => node.id === 'mode-record'), 'output').map((port) => port.id), ['video'], 'Confirmed mode changes should expose only the new active port.');

  const videoModePipeline = schema.createEmptyPipeline({
    nodes: [createRecordNode('screen', { id: 'video-mode-record' }), validationNode],
    edges: [schema.createEdge('video-mode-record', 'video', validationNode.id, 'input')],
  });
  const videoToVideo = schema.applyRecordInputModeChange(videoModePipeline, 'video-mode-record', 'webcam');
  assert.strictEqual(videoToVideo.pipeline.edges.length, 1, 'Video-to-video mode changes should preserve compatible outgoing edges.');
  const videoToAudioBlocked = schema.applyRecordInputModeChange(videoModePipeline, 'video-mode-record', 'microphone');
  assert.strictEqual(videoToAudioBlocked.requiresConfirmation, true, 'Video-to-audio mode changes with outgoing edges should require confirmation.');
  const videoToAudioConfirmed = schema.applyRecordInputModeChange(videoModePipeline, 'video-mode-record', 'microphone', { removeIncompatibleConnections: true });
  assert.strictEqual(videoToAudioConfirmed.pipeline.edges.length, 0, 'Confirmed video-to-audio changes should remove incompatible outgoing edges.');

  const staleEdgeAnalysis = schema.analyzePipeline(schema.createEmptyPipeline({
    nodes: [createRecordNode('microphone', { id: 'stale-record' }), schema.createNode('videoOutput', { id: 'stale-video-output' })],
    edges: [schema.createEdge('stale-record', 'video', 'stale-video-output', 'video')],
  }));
  assert.strictEqual(staleEdgeAnalysis.executable, false, 'Saved Record Input edges attached to an inactive port should be rejected.');
  assert(staleEdgeAnalysis.issues.some((issue) => /inactive video port|stale Record Input edge/i.test(issue.message)), 'Stale Record Input edges should report a clear repair message.');

  assert.throws(
    () => recorderTest.normalizeRecordingOptions({ mode: 'microphone', microphoneId: 'missing' }, [], []),
    /available microphone|refreshed device list/i,
    'Missing microphones should produce an actionable error.',
  );
  assert.throws(
    () => recorderTest.normalizeRecordingOptions({ mode: 'webcam', webcamId: 'missing', fps: 15 }, [], []),
    /available webcam|refreshed device list/i,
    'Missing webcams should produce an actionable error.',
  );
}

function createFakeRecordingController() {
  const starts = [];
  let active = null;
  let sequence = 0;
  return {
    starts,
    async start({ config, nodeId, runId }) {
      sequence += 1;
      const outputKind = config.mode === 'microphone' || config.mode === 'systemAudio' ? 'audio' : 'video';
      const extension = config.systemAudio ? 'webm' : outputKind === 'audio' ? 'wav' : 'mkv';
      const id = `recording-20260612-${String(sequence).padStart(8, '0')}`;
      const outputPath = path.join(RUNTIMES_ROOT, 'pipeline-runs', runId, 'artifacts', 'record-input', nodeId, `${id}.${extension}`);
      active = {
        backend: config.systemAudio ? 'electron' : 'ffmpeg',
        fileName: path.basename(outputPath),
        id,
        mimeType: outputKind === 'audio' && extension === 'webm' ? 'audio/webm;codecs=opus' : '',
        mode: config.mode,
        nodeId,
        outputArtifactType: outputKind,
        outputPath,
        recordingContext: 'pipelineRun',
        runId,
        startedAt: new Date().toISOString(),
        status: 'recording',
      };
      starts.push({ ...active, config: { ...config, captureTarget: config.captureTarget ? { ...config.captureTarget } : config.captureTarget } });
      return { ...active };
    },
    async stop() {
      assert(active, 'A fake recording should be active before stop.');
      await fs.ensureDir(path.dirname(active.outputPath));
      await fs.writeFile(active.outputPath, `recording-${active.id}`);
      const completed = { ...active, sizeBytes: 32, status: 'completed' };
      active = null;
      await handlePipelineRecordingStatus({ type: 'recording-status', recording: completed, message: 'Recording saved.' });
      return completed;
    },
    async cancel() {
      if (!active) return null;
      const canceled = { ...active, status: 'canceled' };
      active = null;
      await handlePipelineRecordingStatus({ type: 'recording-status', recording: canceled, message: 'Recording canceled.' });
      return canceled;
    },
  };
}

function buildRetryPipeline() {
  const record = createRecordNode('microphone', { id: 'record-input' });
  const validation = schema.createNode('validation', {
    id: 'validation',
    config: { mode: 'user', ruleset: 'Approve a usable recording.' },
  });
  const retry = schema.createNode('retryLoop', {
    id: 'retry-loop',
    config: {
      maxAttempts: 2,
      retryTargetNodeId: record.id,
      retryTerminationAction: 'fail',
      stopWhenRetryArtifactRepeats: false,
    },
  });
  const output = schema.createNode('audioOutput', { id: 'audio-output', config: { title: 'Recorded audio' } });
  return schema.createEmptyPipeline({
    id: 'verify-record-input-retry',
    name: 'Verify Record Input Retry',
    nodes: [record, validation, retry, output],
    edges: [
      schema.createEdge(record.id, 'audio', validation.id, 'input'),
      schema.createEdge(validation.id, 'pass', retry.id, 'complete'),
      schema.createEdge(validation.id, 'fail', retry.id, 'retry'),
      schema.createEdge(retry.id, 'result', output.id, 'audio'),
    ],
  });
}

async function completePendingRecording() {
  const pendingRun = getActiveRunSnapshot();
  const pending = pendingRun.pendingRecordInput;
  assert(pending, 'Expected a pending Record Input step.');
  await startPipelineRecordInput(pendingRun.runId, { nodeId: pending.nodeId, requestId: pending.requestId });
  const recordingRun = getActiveRunSnapshot();
  assert.strictEqual(recordingRun.pendingRecordInput.status, 'recording', 'Record Input should become visibly active after explicit start.');
  await stopPipelineRecordInput(recordingRun.runId, { nodeId: pending.nodeId, requestId: pending.requestId });
}

async function verifyRuntimePauseAndRetry() {
  const controller = createFakeRecordingController();
  setPipelineRecordingController(controller);
  const pipeline = buildRetryPipeline();
  const analysis = schema.analyzePipeline(pipeline);
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Retry pipeline should be executable.');

  const started = await runPipeline(pipeline);
  const firstPending = await waitFor('the first Record Input pause', () => {
    const run = getActiveRunSnapshot();
    return run?.runId === started.runId && run.status === 'paused' && run.pendingRecordInput?.status === 'waiting' ? run : null;
  });
  assert.strictEqual(controller.starts.length, 0, 'Record Input must not auto-start.');
  assert(!Object.prototype.hasOwnProperty.call(firstPending.pendingRecordInput.backendRequest, 'outputPath'), 'Renderer-visible pending config must not contain an output path.');

  await completePendingRecording();
  const firstValidation = await waitFor('the first validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.pendingValidation ? run : null;
  });
  assert.strictEqual(firstValidation.nodeStates['record-input'].outputs.audio.kind, 'audio', 'Microphone Record Input should emit an audio artifact.');
  assert(firstValidation.nodeStates['record-input'].outputs.audio.filePath.startsWith(path.join(RUNTIMES_ROOT, 'pipeline-runs', started.runId, 'artifacts') + path.sep), 'Record Input artifact should stay under the current run artifact root.');
  assert.strictEqual(firstValidation.nodeStates['record-input'].outputs.audio.artifactRole, 'intermediate', 'Rejected Record Input artifacts should remain same-run intermediates.');
  const firstArtifactPath = firstValidation.nodeStates['record-input'].outputs.audio.filePath;
  const retryControl = firstValidation.pendingValidation.retryControls?.recordInput;
  assert(retryControl, 'Validation should expose Record Input retry settings.');
  assert.strictEqual(retryControl.mode, 'microphone', 'Validation retry should lock the broad recording mode.');
  assert.strictEqual(retryControl.outputKind, 'audio', 'Validation retry should lock the graph output kind.');
  assert.strictEqual(retryControl.adjustable.microphone, true, 'Microphone validation should expose microphone selection.');
  assert.throws(
    () => resumePipelineValidation(firstValidation.runId, {
      decision: 'fail',
      nodeId: firstValidation.pendingValidation.nodeId,
      requestId: firstValidation.pendingValidation.requestId,
      retryOverrides: { recordInput: { mode: 'screen' } },
    }),
    /cannot change.*audio output|another recording mode/i,
    'A paused audio validation must reject a video mode override.',
  );
  assert(getActiveRunSnapshot().pendingValidation, 'A rejected retry override should leave validation paused.');
  resumePipelineValidation(firstValidation.runId, {
    decision: 'fail',
    nodeId: firstValidation.pendingValidation.nodeId,
    requestId: firstValidation.pendingValidation.requestId,
    retryOverrides: { recordInput: { microphoneId: 'audio-device-2', mode: 'microphone' } },
  });

  const retryRecordingPause = await waitFor('the retry Record Input pause', () => {
    const run = getActiveRunSnapshot();
    return run?.pendingRecordInput?.status === 'waiting' && run.nodeStates['record-input']?.runCount === 2 ? run : null;
  });
  assert.strictEqual(retryRecordingPause.pendingRecordInput.backendRequest.microphoneId, 'audio-device-2', 'The next recording should use the temporary microphone override.');
  assert.strictEqual(retryRecordingPause.pendingRecordInput.retrySettingsApplied, true, 'The pending retry should identify temporary settings metadata.');
  assert(await fs.pathExists(firstArtifactPath), 'The rejected recording should remain available as a cleanup-eligible same-run intermediate.');
  await completePendingRecording();
  const secondValidation = await waitFor('the second validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.pendingValidation && run.nodeStates['record-input']?.runCount === 2 ? run : null;
  });
  assert.strictEqual(controller.starts.length, 2, 'A retry should request a fresh recording.');
  assert.notStrictEqual(controller.starts[0].outputPath, controller.starts[1].outputPath, 'A retry must not reuse the stale recording artifact.');
  assert.strictEqual(controller.starts[1].config.microphoneId, 'audio-device-2', 'The recorder backend should receive the adjusted microphone for the fresh attempt.');
  assert.strictEqual(secondValidation.nodeStates['record-input'].outputs.audio.recording.retrySettingsApplied, true, 'The fresh artifact metadata should identify that retry settings were applied.');
  resumePipelineValidation(secondValidation.runId, {
    decision: 'pass',
    nodeId: secondValidation.pendingValidation.nodeId,
    requestId: secondValidation.pendingValidation.requestId,
  });

  const completed = await waitFor('the retry pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' ? run : null;
  });
  assert.strictEqual(completed.terminalResults[0]?.artifact?.kind, 'audio', 'The completed retry pipeline should save an audio output.');
}

async function verifyVideoRegionValidationRetry() {
  const controller = createFakeRecordingController();
  setPipelineRecordingController(controller);
  const record = createRecordNode('screenSystemAudio', {
    id: 'region-record-input',
    config: {
      fps: 15,
      captureTarget: { type: 'region', displayId: 'display-primary', x: 10, y: 20, width: 640, height: 480 },
    },
  });
  const validation = schema.createNode('validation', { id: 'region-validation', config: { mode: 'user' } });
  const retry = schema.createNode('retryLoop', {
    id: 'region-retry-loop',
    config: { maxAttempts: 2, retryTargetNodeId: record.id, retryTerminationAction: 'fail', stopWhenRetryArtifactRepeats: false },
  });
  const output = schema.createNode('videoOutput', { id: 'region-video-output' });
  const pipeline = schema.createEmptyPipeline({
    id: 'verify-region-record-input-retry',
    name: 'Verify Region Record Input Retry',
    nodes: [record, validation, retry, output],
    edges: [
      schema.createEdge(record.id, 'video', validation.id, 'input'),
      schema.createEdge(validation.id, 'pass', retry.id, 'complete'),
      schema.createEdge(validation.id, 'fail', retry.id, 'retry'),
      schema.createEdge(retry.id, 'result', output.id, 'video'),
    ],
  });
  const started = await runPipeline(pipeline);
  await waitFor('the first region Record Input pause', () => getActiveRunSnapshot()?.pendingRecordInput || null);
  await completePendingRecording();
  const firstValidation = await waitFor('the first region validation pause', () => getActiveRunSnapshot()?.pendingValidation ? getActiveRunSnapshot() : null);
  const control = firstValidation.pendingValidation.retryControls?.recordInput;
  assert(control, 'Region validation should expose Record Input retry settings.');
  assert.strictEqual(control.adjustable.fps, true, 'Video validation retry should expose FPS.');
  assert.strictEqual(control.adjustable.captureTarget, true, 'Region validation retry should expose capture target settings.');
  assert.strictEqual(control.settings.captureTarget.type, 'region', 'Region validation retry should preserve the selected target type.');
  assert.throws(
    () => resumePipelineValidation(firstValidation.runId, {
      decision: 'fail',
      nodeId: firstValidation.pendingValidation.nodeId,
      requestId: firstValidation.pendingValidation.requestId,
      retryOverrides: { recordInput: { mode: 'systemAudio' } },
    }),
    /cannot change.*video output|another recording mode/i,
    'A paused video validation must reject an audio mode override.',
  );
  resumePipelineValidation(firstValidation.runId, {
    decision: 'fail',
    nodeId: firstValidation.pendingValidation.nodeId,
    requestId: firstValidation.pendingValidation.requestId,
    retryOverrides: {
      recordInput: {
        mode: 'screenSystemAudio',
        fps: 30,
        displayId: 'display-secondary',
        captureTarget: { type: 'region', displayId: 'display-secondary', x: 30, y: 40, width: 800, height: 600 },
      },
    },
  });
  const retryPause = await waitFor('the region retry recording pause', () => {
    const run = getActiveRunSnapshot();
    return run?.pendingRecordInput?.status === 'waiting' && run.nodeStates[record.id]?.runCount === 2 ? run : null;
  });
  assert.strictEqual(retryPause.pendingRecordInput.backendRequest.fps, 30, 'The next video recording should use the adjusted FPS.');
  assert.strictEqual(retryPause.pendingRecordInput.backendRequest.displayId, 'display-secondary', 'The next system-audio recording should use the adjusted display.');
  assert.deepStrictEqual(retryPause.pendingRecordInput.backendRequest.captureTarget, { type: 'region', displayId: 'display-secondary', x: 30, y: 40, width: 800, height: 600 }, 'The next recording should use the adjusted region coordinates.');
  await completePendingRecording();
  const secondValidation = await waitFor('the second region validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.pendingValidation && run.nodeStates[record.id]?.runCount === 2 ? run : null;
  });
  resumePipelineValidation(secondValidation.runId, {
    decision: 'pass',
    nodeId: secondValidation.pendingValidation.nodeId,
    requestId: secondValidation.pendingValidation.requestId,
  });
  const completed = await waitFor('the region retry pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.runId === started.runId && run.status === 'completed' ? run : null;
  });
  assert.strictEqual(completed.terminalResults[0]?.artifact?.kind, 'video', 'The completed region retry pipeline should save a video output.');
}

async function verifySystemAudioRuntime() {
  const controller = createFakeRecordingController();
  setPipelineRecordingController(controller);
  const record = createRecordNode('systemAudio', { id: 'system-audio-record' });
  const output = schema.createNode('audioOutput', { id: 'system-audio-output' });
  const pipeline = schema.createEmptyPipeline({
    id: 'verify-system-audio-record-input',
    name: 'Verify System Audio Record Input',
    nodes: [record, output],
    edges: [schema.createEdge(record.id, 'audio', output.id, 'audio')],
  });
  const started = await runPipeline(pipeline);
  await waitFor('system audio Record Input pause', () => getActiveRunSnapshot()?.pendingRecordInput || null);
  await completePendingRecording();
  const completed = await waitFor('system audio pipeline completion', () => {
    const run = getActiveRunSnapshot();
    return run?.runId === started.runId && run.status === 'completed' ? run : null;
  });
  const artifact = completed.nodeStates[record.id].outputs.audio;
  assert.strictEqual(artifact.kind, 'audio', 'System-audio-only should emit an audio artifact.');
  assert.strictEqual(artifact.previewKind, 'audio', 'System-audio WebM should keep audio preview typing.');
  assert(/^audio\/webm/i.test(artifact.mimeType), 'System-audio WebM should carry an audio MIME type.');
}

async function verifyManagedStorageAndCleanup() {
  const runId = 'run-storage-check';
  const nodeId = 'record-node';
  const artifactsRoot = path.join(RUNTIMES_ROOT, 'pipeline-runs', runId, 'artifacts');
  await fs.ensureDir(artifactsRoot);
  const paths = await resolvePipelineRecordingPaths({
    context: { recordingContext: { type: 'pipelineRun', runId, nodeId, outputPath: path.join(TEST_ROOT, 'outside.wav') } },
    extension: 'wav',
    fs,
    getAppPaths: () => ({ runtimesRoot: RUNTIMES_ROOT }),
    id: 'recording-20260612-abcd1234',
  });
  assert(paths.outputPath.startsWith(artifactsRoot + path.sep), 'Pipeline recording paths must be generated under the run artifacts root.');
  assert(!paths.outputPath.includes('outside.wav'), 'Caller-provided arbitrary paths must be ignored.');

  const serviceRunId = 'run-service-sidecar';
  const serviceNodeId = 'record-service-node';
  await fs.ensureDir(path.join(RUNTIMES_ROOT, 'pipeline-runs', serviceRunId, 'artifacts'));
  let child = null;
  const recordingService = createRecordingService({
    ensureStorage: async () => ({ recordingsRoot: RECORDINGS_ROOT }),
    getAppPaths: () => ({ recordingsRoot: RECORDINGS_ROOT, runtimesRoot: RUNTIMES_ROOT }),
    resolveFfmpegPath: () => 'ffmpeg.exe',
    runOneShot: async (_command, args) => args.includes('-version')
      ? { code: 0, stdout: 'ffmpeg version verify', stderr: '' }
      : { code: 1, stdout: '', stderr: '' },
    spawn: (_command, args) => {
      child = new EventEmitter();
      child.pid = 1234;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        writable: true,
        write(value) {
          if (value === 'q\n') {
            const outputPath = args.at(-1);
            fs.ensureDir(path.dirname(outputPath))
              .then(() => fs.writeFile(outputPath, 'pipeline-recording'))
              .then(() => setImmediate(() => child.emit('close', 0, null)));
          }
        },
      };
      return child;
    },
  });
  const started = await recordingService.startRecording({
    mode: 'screen',
    fps: 15,
    outputPath: path.join(TEST_ROOT, 'renderer-selected.mkv'),
  }, {
    displays: [],
    recordingContext: { type: 'pipelineRun', runId: serviceRunId, nodeId: serviceNodeId },
  });
  assert(started.outputPath.startsWith(path.join(RUNTIMES_ROOT, 'pipeline-runs', serviceRunId, 'artifacts') + path.sep), 'Recorder service should derive the pipeline output path in main-process storage.');
  const completed = await recordingService.stopRecording();
  const sidecarPath = path.join(path.dirname(started.outputPath), `${completed.id}.recording.json`);
  const sidecar = await fs.readJson(sidecarPath);
  assert.strictEqual(sidecar.runId, serviceRunId, 'Pipeline recording sidecar should include run ownership.');
  assert.strictEqual(sidecar.nodeId, serviceNodeId, 'Pipeline recording sidecar should include node ownership.');
  assert.strictEqual(sidecar.outputArtifactType, 'video', 'Pipeline recording sidecar should include artifact typing.');
  assert.strictEqual(sidecar.recordingContext, 'pipelineRun', 'Pipeline recording sidecar should identify pipeline ownership.');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sidecar, 'outputPath'), false, 'Pipeline sidecars must not persist absolute output paths.');

  const cleanupRun = path.join(RUNTIMES_ROOT, 'pipeline-runs', 'run-cleanup');
  const selectedOutput = path.join(cleanupRun, 'outputs', 'selected.wav');
  const siblingOutput = path.join(cleanupRun, 'outputs', 'sibling.wav');
  const recordArtifact = path.join(cleanupRun, 'artifacts', 'record-input', 'record-node', 'capture.wav');
  const standaloneRecording = path.join(RECORDINGS_ROOT, '2026', '2026-06-12', 'standalone.wav');
  const otherRunArtifact = path.join(RUNTIMES_ROOT, 'pipeline-runs', 'other-run', 'artifacts', 'record-input', 'node', 'capture.wav');
  for (const filePath of [selectedOutput, siblingOutput, recordArtifact, standaloneRecording, otherRunArtifact]) {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, 'data');
  }

  await deletePipelineOutput(selectedOutput, { deleteMode: 'permanent', includeIntermediates: true });
  assert(!(await fs.pathExists(selectedOutput)), 'Selected final output should be deleted.');
  assert(!(await fs.pathExists(recordArtifact)), 'Optional same-run cleanup should delete Record Input artifacts.');
  assert(await fs.pathExists(siblingOutput), 'Optional cleanup must not delete sibling outputs.');
  assert(await fs.pathExists(standaloneRecording), 'Pipeline cleanup must not delete standalone recordings.');
  assert(await fs.pathExists(otherRunArtifact), 'Pipeline cleanup must not delete recordings from other runs.');
}

function verifyTrayAndRendererSurface() {
  let stopped = false;
  const template = buildTrayMenuTemplate({
    activeRecording: {
      fileName: 'pipeline-capture.wav',
      recordingContext: 'pipelineRun',
    },
    stopRecording: () => {
      stopped = true;
    },
    toolItems: [],
  });
  const stopItem = template.find((entry) => entry.label === 'Stop Recording');
  assert(stopItem, 'Tray should expose Stop Recording for a pipeline recording.');
  stopItem.click();
  assert.strictEqual(stopped, true, 'Tray Stop Recording should route through the active recording action.');

  const preloadSource = fs.readFileSync(path.resolve(__dirname, '../electron/preload.js'), 'utf8');
  assert(preloadSource.includes("startPipelineRecordInput: (payload) => invoke('pipelines:start-record-input', payload)"), 'Preload should expose the bounded Record Input start action.');
  assert(!/startPipelineRecordInput:[^\n]*outputPath/.test(preloadSource), 'Renderer Record Input start surface must not expose an output path argument.');

  const panelSource = fs.readFileSync(path.resolve(__dirname, '../src/components/PipelineBuilderPanel.jsx'), 'utf8');
  assert(panelSource.includes('Retry recording settings'), 'Validation UI should render focused Record Input retry settings.');
  assert(panelSource.includes('The recording mode and {recordInputRetryControl.outputKind} graph output stay locked'), 'Validation UI should explain that broad mode and output kind stay locked.');
  assert(panelSource.includes('Changing this recording mode will change the output from ${change.impact.oldOutputKind} to ${change.impact.newOutputKind} and remove incompatible connections.'), 'Cross-kind graph mode changes should show the required confirmation warning.');
  assert(panelSource.includes("getPortDefinition(sourceNode, 'output', edge.source.portId)"), 'Canvas rendering should hide edges attached to inactive output ports.');
  assert(panelSource.includes('onChange={(event) => changeRecordInputMode(selectedNode, event.target.value)}'), 'Record Input mode selection should route through the safe mode-change helper.');
}

async function main() {
  await fs.remove(TEST_ROOT);
  await fs.ensureDir(RUNTIMES_ROOT);
  await fs.ensureDir(RECORDINGS_ROOT);
  verifySchemaAndTyping();
  verifyTrayAndRendererSurface();
  await verifyRuntimePauseAndRetry();
  await verifyVideoRegionValidationRetry();
  await verifySystemAudioRuntime();
  await verifyManagedStorageAndCleanup();
  await cancelPipelineRecordInput().catch(() => null);
  console.log('Pipeline Record Input verification passed.');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
