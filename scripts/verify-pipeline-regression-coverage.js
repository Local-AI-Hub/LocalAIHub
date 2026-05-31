const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-pipeline-regression-coverage');
const PIPELINE_EXECUTION_SERVICE_PATH = path.join(process.cwd(), 'electron', 'services', 'pipelineExecutionService.js');
const MEDIA_COMPOSITION_SERVICE_PATH = path.join(process.cwd(), 'electron', 'services', 'mediaCompositionService.js');
const PIPELINE_BUILDER_PANEL_PATH = path.join(process.cwd(), 'src', 'components', 'PipelineBuilderPanel.jsx');

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'home' || name === 'appData') return TEST_STORAGE_ROOT;
          if (name === 'exe') return process.execPath;
          return process.cwd();
        },
        isPackaged: false,
      },
      nativeImage: null,
    };
  }
  if (normalizedParent.endsWith('/electron/services/pipelineArtifactService.js') && request === './configService') {
    return { ensureStorage: async () => fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true }), getAppPaths: () => ({ runtimesRoot: TEST_STORAGE_ROOT }) };
  }
  if (normalizedParent.endsWith('/electron/services/pipelineExecutionService.js')) {
    if (request === './providerRegistry') return { initializeProviderRegistry: async () => {} };
    if (request === './providerService') return { chatWithProvider: async () => ({ message: { content: 'pass' } }), listProviderConnections: async () => ([]), runProviderOperation: async () => ({ message: { content: '' } }) };
    if (request === './toolRegistry') return { getToolCatalog: () => [], initializeToolRegistry: async () => {} };
    if (request === './toolStateService') return { buildMergedToolStateList: async () => [], getResolvedToolState: async () => null };
    if (request === './configService') return { listGraphWorkflowPresets: async () => [], listPromptStyles: async () => [] };
    if (request === './modelService') return { listDownloadedModels: async () => [] };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const pipelineSchema = require('../electron/shared/pipelineSchema.cjs');
const { buildFileArtifact } = require('../electron/services/pipelineArtifactService');
const { runCommand } = require('../electron/services/commandService');
const { resolveFfmpegPath } = require('../electron/services/mediaCompositionService');
const mediaUtilityService = require('../electron/services/mediaUtilityService');
const { cancelPipelineRun, getActiveRunSnapshot, resumePipelineValidation, runPipeline } = require('../electron/services/pipelineExecutionService');

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(label, predicate, timeoutMs = 45000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await wait(50);
  }
  throw new Error('Timed out while waiting for ' + label + '.');
}
async function cleanupActiveRun() {
  const activeRun = getActiveRunSnapshot();
  if (!activeRun || (activeRun.status !== 'running' && activeRun.status !== 'paused')) return;
  try { cancelPipelineRun(activeRun.runId); } catch { return; }
  await waitFor('the active pipeline run to stop', () => {
    const currentRun = getActiveRunSnapshot();
    return !currentRun || ['cancelled', 'completed', 'failed'].includes(currentRun.status) ? currentRun || true : null;
  });
}
async function runFfmpeg(args, label) {
  const result = await runCommand(resolveFfmpegPath(), args, { allowFailure: true });
  assert.strictEqual(Number(result.code || 0), 0, label + ' failed: ' + (result.stderr || result.stdout || 'ffmpeg returned a non-zero exit code.'));
}
function createImageBuffer() { return Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'); }
function createWaveBuffer(durationSeconds = 3, sampleRate = 8000) {
  const channelCount = 1;
  const bytesPerSample = 2;
  const frameCount = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = frameCount * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channelCount, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28); buffer.writeUInt16LE(channelCount * bytesPerSample, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
async function createSyntheticVideo(outputPath, { audio = true, size = '96x64', rate = 4, duration = 0.8 } = {}) {
  const baseArgs = ['-y', '-f', 'lavfi', '-i', 'testsrc=size=' + size + ':rate=' + String(rate) + ':duration=' + String(duration)];
  const audioArgs = audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=' + String(duration), '-shortest'] : [];
  const tailArgs = audio ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath];
  const firstAttempt = await runCommand(resolveFfmpegPath(), [...baseArgs, ...audioArgs, ...tailArgs], { allowFailure: true });
  if (Number(firstAttempt.code || 0) === 0) return;
  const fallbackTailArgs = audio ? ['-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath] : ['-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', outputPath];
  await runFfmpeg([...baseArgs, ...audioArgs, ...fallbackTailArgs], 'synthetic video fixture');
}
async function prepareAssets(durationSeconds = 4) {
  const assetRoot = path.join(TEST_STORAGE_ROOT, 'fixtures');
  fs.mkdirSync(assetRoot, { recursive: true });
  const imageOne = path.join(assetRoot, 'scene-1.gif');
  const imageTwo = path.join(assetRoot, 'scene-2.gif');
  const imageThree = path.join(assetRoot, 'scene-3.gif');
  const narration = path.join(assetRoot, 'narration.wav');
  const backgroundMusic = path.join(assetRoot, 'background-music.wav');
  fs.writeFileSync(imageOne, createImageBuffer()); fs.writeFileSync(imageTwo, createImageBuffer()); fs.writeFileSync(imageThree, createImageBuffer());
  fs.writeFileSync(narration, createWaveBuffer(durationSeconds)); fs.writeFileSync(backgroundMusic, createWaveBuffer(durationSeconds + 1));
  return { backgroundMusic, imageOne, imageThree, imageTwo, narration };
}
function analyzeExecutablePipeline(pipeline, label) {
  const analysis = pipelineSchema.analyzePipeline(pipeline, { hardware: null, providers: [], toolCatalog: [], tools: [] });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || label + ' should be executable.');
}
async function runUntilValidationPause(pipeline, validationNodeId, label) {
  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for ' + label + '.');
  const pause = await waitFor(label + ' validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === validationNodeId && run.runId === initialRun.runId ? run : null;
  });
  return { initialRun, pause };
}
async function waitForCompletedRun(runId, label) {
  return waitFor(label + ' to finish', () => {
    const run = getActiveRunSnapshot();
    return run && ['completed', 'failed'].includes(run.status) && run.runId === runId ? run : null;
  });
}
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function getVideoSidecar(artifact) {
  const sidecarPath = artifact?.metadataPaths?.find((entry) => String(entry).endsWith('.video.json'));
  assert(sidecarPath && fs.existsSync(sidecarPath), 'Expected the video artifact to include a saved video metadata sidecar.');
  return readJson(sidecarPath);
}
function createMediaCompositionValidationRetryPipeline(assetPaths) {
  const imageOne = pipelineSchema.createNode('imageInput', { id: 'image-one', label: 'Scene 1', config: { filePath: assetPaths.imageOne } });
  const imageTwo = pipelineSchema.createNode('imageInput', { id: 'image-two', label: 'Scene 2', config: { filePath: assetPaths.imageTwo } });
  const narration = pipelineSchema.createNode('audioInput', { id: 'narration-audio', label: 'Narration', config: { filePath: assetPaths.narration } });
  const backgroundMusic = pipelineSchema.createNode('audioInput', { id: 'background-music-audio', label: 'Background music', config: { filePath: assetPaths.backgroundMusic } });
  const collection = pipelineSchema.createNode('collectionBuilder', { id: 'visual-collection', label: 'Visual collection' });
  const composition = pipelineSchema.createNode('mediaComposition', { id: 'compose-scenes', label: 'Compose scenes', config: { backgroundMusicVolume: 0.22, narrationVolume: 1, secondsPerItem: 1 } });
  const exportNode = pipelineSchema.createNode('mediaExport', { id: 'export-scenes', label: 'Export scenes', config: { title: 'Retry override export', width: 320, height: 180, fps: 8, fitMode: 'contain', stopMode: 'shortest' } });
  const validation = pipelineSchema.createNode('validation', { id: 'review-export', label: 'Review exported video', config: { mode: 'user' } });
  const retryLoop = pipelineSchema.createNode('retryLoop', { id: 'retry-export', label: 'Retry export mix', config: { maxAttempts: 2, retryTargetNodeId: 'compose-scenes', stopWhenRetryArtifactRepeats: false, terminationAction: 'fail' } });
  const output = pipelineSchema.createNode('videoOutput', { id: 'video-output', label: 'Video output', config: { title: 'Retry override final' } });
  return pipelineSchema.createEmptyPipeline({
    id: 'verify-focused-media-composition-retry-overrides',
    name: 'Verify Focused Media Composition Retry Overrides',
    nodes: [imageOne, imageTwo, narration, backgroundMusic, collection, composition, exportNode, validation, retryLoop, output],
    edges: [
      pipelineSchema.createEdge(imageOne.id, 'image', collection.id, 'items'),
      pipelineSchema.createEdge(imageTwo.id, 'image', collection.id, 'items'),
      pipelineSchema.createEdge(collection.id, 'collection', composition.id, 'visuals'),
      pipelineSchema.createEdge(narration.id, 'audio', composition.id, 'audio'),
      pipelineSchema.createEdge(backgroundMusic.id, 'audio', composition.id, 'backgroundMusic'),
      pipelineSchema.createEdge(composition.id, 'composition', exportNode.id, 'composition'),
      pipelineSchema.createEdge(exportNode.id, 'video', validation.id, 'input'),
      pipelineSchema.createEdge(validation.id, 'pass', retryLoop.id, 'complete'),
      pipelineSchema.createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      pipelineSchema.createEdge(retryLoop.id, 'result', output.id, 'video'),
    ],
  });
}

async function verifyFocusedMediaCompositionRetryOverrides() {
  const assetPaths = await prepareAssets(3);
  const pipeline = createMediaCompositionValidationRetryPipeline(assetPaths);
  const savedCompositionNode = pipeline.nodes.find((node) => node.id === 'compose-scenes');
  analyzeExecutablePipeline(pipeline, 'focused Media Composition retry pipeline');
  const { initialRun, pause: firstPause } = await runUntilValidationPause(pipeline, 'review-export', 'the focused Media Composition review');
  assert.strictEqual(firstPause.pendingValidation?.retryControls?.mediaComposition?.temporary, true, 'Expected retry controls to identify temporary Media Composition overrides.');
  assert.strictEqual(firstPause.pendingValidation.retryControls.mediaComposition.nodeId, 'compose-scenes', 'Expected retry controls to be keyed to the Media Composition node id.');
  assert.strictEqual(firstPause.pendingValidation.artifact?.compositionExport?.audioMix?.narrationVolume, 1, 'Expected the first preview to use the saved narration volume.');
  assert.strictEqual(firstPause.pendingValidation.artifact?.compositionExport?.audioMix?.backgroundMusicVolume, 0.22, 'Expected the first preview to use the saved background volume.');
  resumePipelineValidation(firstPause.runId, { decision: 'fail', nodeId: firstPause.pendingValidation.nodeId, requestId: firstPause.pendingValidation.requestId, retryOverrides: { mediaComposition: { backgroundMusicVolume: 0.09, narrationVolume: 0.61 } } });
  const secondPause = await waitFor('the focused Media Composition retry preview', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'review-export' && run.pendingValidation.iteration === 2 ? run : null;
  });
  assert.deepStrictEqual(secondPause.retryOverridesByNodeId?.['compose-scenes']?.mediaComposition, { backgroundMusicVolume: 0.09, narrationVolume: 0.61 }, 'Expected retry overrides to be stored by target node id.');
  assert.strictEqual(secondPause.retryOverridesByNodeId?.['export-scenes'], undefined, 'Expected retry overrides not to be stored on the Media Export node.');
  assert.strictEqual(secondPause.pendingValidation.artifact?.compositionExport?.audioMix?.narrationVolume, 0.61, 'Expected retry-only narration override to affect the preview export.');
  assert.strictEqual(secondPause.pendingValidation.artifact?.compositionExport?.audioMix?.backgroundMusicVolume, 0.09, 'Expected retry-only background override to affect the preview export.');
  assert.strictEqual(secondPause.pendingValidation.retryControls.mediaComposition.narrationVolume, 0.61, 'Expected second review controls to reset to the effective retry narration value.');
  assert.strictEqual(savedCompositionNode.config.narrationVolume, 1, 'Expected retry override not to mutate the saved Media Composition config.');
  assert.strictEqual(savedCompositionNode.config.backgroundMusicVolume, 0.22, 'Expected retry override not to mutate the saved background music config.');
  resumePipelineValidation(secondPause.runId, { decision: 'pass', nodeId: secondPause.pendingValidation.nodeId, requestId: secondPause.pendingValidation.requestId });
  const completedRun = await waitForCompletedRun(initialRun.runId, 'the focused Media Composition retry pipeline');
  assert.strictEqual(completedRun.status, 'completed', completedRun.message || 'Expected focused Media Composition retry pipeline to complete.');
  assert.strictEqual(completedRun.pendingValidation, null, 'Expected validation state to be cleared after the pass decision.');
  const exportArtifact = completedRun.resultsByNodeId?.['export-scenes']?.outputs?.video || null;
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.narrationVolume, 0.61, 'Expected final export metadata to carry the effective retry narration volume.');
  assert.strictEqual(readJson(exportArtifact.metadataPaths[0]).audioMix?.backgroundMusicVolume, 0.09, 'Expected final export sidecar to carry the effective retry background volume.');
}
function createBurnSubtitlesValidationRetryPipeline(videoPath) {
  const videoInput = pipelineSchema.createNode('videoInput', { id: 'burn-video-input', label: 'Video Input', config: { filePath: videoPath } });
  const captionInput = pipelineSchema.createNode('textInput', { id: 'burn-caption-input', label: 'Caption Text', config: { text: 'First caption\nSecond caption' } });
  const burnSubtitles = pipelineSchema.createNode('burnSubtitles', { id: 'burn-captions', label: 'Burn captions', config: { captionMode: 'manualLines', durationPerCaptionSeconds: 0.25, fontSize: 28, outputFormat: 'mp4', position: 'bottomCenter' } });
  const validation = pipelineSchema.createNode('validation', { id: 'review-burned-video', label: 'Review burned captions', config: { mode: 'user' } });
  const retryLoop = pipelineSchema.createNode('retryLoop', { id: 'retry-burned-video', label: 'Retry burned captions', config: { maxAttempts: 2, retryTargetNodeId: burnSubtitles.id, stopWhenRetryArtifactRepeats: false, terminationAction: 'fail' } });
  const videoOutput = pipelineSchema.createNode('videoOutput', { id: 'burn-video-output', label: 'Video Output', config: { title: 'Captioned video retry output' } });
  return pipelineSchema.createEmptyPipeline({
    id: 'verify-focused-burn-subtitles-clean-source-retry',
    name: 'Verify Focused Burn Subtitles Clean Source Retry',
    nodes: [videoInput, captionInput, burnSubtitles, validation, retryLoop, videoOutput],
    edges: [
      pipelineSchema.createEdge(videoInput.id, 'video', burnSubtitles.id, 'video'),
      pipelineSchema.createEdge(captionInput.id, 'text', burnSubtitles.id, 'captions'),
      pipelineSchema.createEdge(burnSubtitles.id, 'video', validation.id, 'input'),
      pipelineSchema.createEdge(validation.id, 'pass', retryLoop.id, 'complete'),
      pipelineSchema.createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      pipelineSchema.createEdge(retryLoop.id, 'result', videoOutput.id, 'video'),
    ],
  });
}

async function verifyFocusedBurnSubtitlesCleanSourceRetry() {
  const videoPath = path.join(TEST_STORAGE_ROOT, 'burn-clean-source.mp4');
  await createSyntheticVideo(videoPath);
  const pipeline = createBurnSubtitlesValidationRetryPipeline(videoPath);
  const savedBurnNode = pipeline.nodes.find((node) => node.id === 'burn-captions');
  analyzeExecutablePipeline(pipeline, 'focused Burn Subtitles retry pipeline');
  const { initialRun, pause: firstPause } = await runUntilValidationPause(pipeline, 'review-burned-video', 'the focused Burn Subtitles review');
  const firstBurnedVideoPath = firstPause.pendingValidation.artifact.filePath;
  assert.strictEqual(firstPause.pendingValidation.retryControls?.burnSubtitles?.temporary, true, 'Expected Burn Subtitles retry controls to identify temporary overrides.');
  assert.strictEqual(firstPause.pendingValidation.retryControls.burnSubtitles.nodeId, 'burn-captions', 'Expected Burn Subtitles retry controls to be keyed to the burn node id.');
  assert.strictEqual(firstPause.pendingValidation.artifact.subtitleBurn?.sourceVideoPath, videoPath, 'Expected first burn to record the original clean source video.');
  await resumePipelineValidation(firstPause.runId, { decision: 'fail', nodeId: firstPause.pendingValidation.nodeId, requestId: firstPause.pendingValidation.requestId, retryOverrides: { burnSubtitles: { backgroundBox: true, fontSize: 38, position: 'topLeft', textColor: 'yellow' } } });
  const secondPause = await waitFor('the focused Burn Subtitles retry preview', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'review-burned-video' && run.pendingValidation.iteration === 2 ? run : null;
  });
  const retriedArtifact = secondPause.pendingValidation.artifact;
  assert.strictEqual(secondPause.retryOverridesByNodeId?.['burn-captions']?.burnSubtitles?.fontSize, 38, 'Expected Burn Subtitles retry override to be stored by node id.');
  assert.notStrictEqual(retriedArtifact.filePath, firstBurnedVideoPath, 'Expected retry to create a fresh burned-caption artifact.');
  assert.strictEqual(retriedArtifact.subtitleBurn?.sourceVideoPath, videoPath, 'Expected retry to rerender from the original clean upstream video.');
  assert.notStrictEqual(retriedArtifact.subtitleBurn?.sourceVideoPath, firstBurnedVideoPath, 'Expected retry not to stack captions over the previous burned artifact.');
  assert.strictEqual(retriedArtifact.subtitleBurn?.sourceVideoLineage?.ignoredLoopRetryVideo, true, 'Expected retry metadata to record that the loop-carried artifact was ignored.');
  assert.strictEqual(retriedArtifact.subtitleBurn?.sourceVideoLineage?.usedOriginalSourceVideo, true, 'Expected retry metadata to record that the original source was used.');
  assert.strictEqual(retriedArtifact.subtitleBurn?.sourceVideoLineage?.loopRetryVideoPath, firstBurnedVideoPath, 'Expected retry metadata to record the ignored loop artifact path.');
  assert.strictEqual(retriedArtifact.subtitleBurn?.style?.fontSize, 38, 'Expected retry override font size to affect only the retried artifact.');
  assert.strictEqual(savedBurnNode.config.fontSize, 28, 'Expected retry override not to mutate the saved Burn Subtitles config.');
  await resumePipelineValidation(secondPause.runId, { decision: 'pass', nodeId: secondPause.pendingValidation.nodeId, requestId: secondPause.pendingValidation.requestId });
  const completedRun = await waitForCompletedRun(initialRun.runId, 'the focused Burn Subtitles retry pipeline');
  assert.strictEqual(completedRun.status, 'completed', completedRun.message || 'Expected focused Burn Subtitles retry pipeline to complete.');
  const burnArtifact = completedRun.resultsByNodeId?.['burn-captions']?.outputs?.video || null;
  const burnSidecar = getVideoSidecar(burnArtifact);
  assert.strictEqual(burnSidecar.subtitleBurn?.sourceVideoPath, videoPath, 'Expected final Burn Subtitles sidecar to record the clean source path.');
  assert.strictEqual(burnSidecar.subtitleBurn?.sourceVideoLineage?.ignoredLoopRetryVideo, true, 'Expected final Burn Subtitles sidecar to record clean-source retry lineage.');
  assert.strictEqual(burnSidecar.subtitleBurn?.style?.fontSize, 38, 'Expected final Burn Subtitles sidecar to record effective retry style.');
}

async function verifyBurnSubtitlesFallbackWhenOriginalSourceUnavailable() {
  const sourcePath = path.join(TEST_STORAGE_ROOT, 'direct-burn-source.mp4');
  await createSyntheticVideo(sourcePath, { duration: 0.6 });
  const sourceArtifact = await buildFileArtifact(sourcePath, { displayName: 'Loop retry fallback source', kind: pipelineSchema.PORT_KIND_VIDEO, role: 'input' });
  const captionArtifact = { kind: pipelineSchema.PORT_KIND_TEXT, text: 'Fallback caption', displayName: 'Fallback captions' };
  const burnResult = await mediaUtilityService.burnSubtitlesIntoVideoArtifact(sourceArtifact, captionArtifact, {
    captionMode: 'manualLines', durationPerCaptionSeconds: 0.3, node: { id: 'burn-captions', label: 'Burn captions', type: 'burnSubtitles' }, runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
    sourceVideoLineage: { ignoredLoopRetryVideo: false, inputResolution: 'loop-retry-artifact-fallback', loopNodeId: 'retry-burned-video', retryAttempt: 2, usedOriginalSourceVideo: false },
  });
  assert.strictEqual(burnResult.outputs.video.subtitleBurn?.sourceVideoLineage?.inputResolution, 'loop-retry-artifact-fallback', 'Expected fallback burn metadata to record loop artifact fallback resolution.');
  assert.strictEqual(burnResult.outputs.video.subtitleBurn?.sourceVideoLineage?.usedOriginalSourceVideo, false, 'Expected fallback burn metadata to say the original source was unavailable.');
  assert.strictEqual(getVideoSidecar(burnResult.outputs.video).subtitleBurn?.sourceVideoLineage?.usedOriginalSourceVideo, false, 'Expected fallback lineage to be saved in the video sidecar.');
}
function createDynamicTransitionExportPipeline(assetPaths) {
  const durations = [0.6, 0.8, 1.1, 1.5];
  let cursorSeconds = 0;
  const items = durations.map((durationSeconds, index) => {
    const startSeconds = Number(cursorSeconds.toFixed(6));
    cursorSeconds += durationSeconds;
    const endSeconds = Number(cursorSeconds.toFixed(6));
    return { id: 'timed-scene-' + String(index + 1), filePath: index % 2 === 0 ? assetPaths.imageOne : assetPaths.imageTwo, metadata: { durationSeconds, endSeconds, sourceTranscriptSegmentIds: [String(index)], startSeconds } };
  });
  const collection = pipelineSchema.createNode('collectionInput', { id: 'timed-visual-collection', label: 'Timed visual collection', config: { itemType: 'image', items, metadata: { timing: { timingMode: 'dynamicFromPlanTiming', totalPlannedDurationSeconds: cursorSeconds } } } });
  const narration = pipelineSchema.createNode('audioInput', { id: 'timed-narration-audio', label: 'Timed narration', config: { filePath: assetPaths.narration } });
  const composition = pipelineSchema.createNode('mediaComposition', { id: 'timed-compose-scenes', label: 'Timed compose scenes', config: { imageTimingMode: 'dynamicFromImageMetadata', sceneTransitionDurationSeconds: 0.5, sceneTransitionMode: 'single', sceneTransitionName: 'fade', secondsPerItem: 9 } });
  const exportNode = pipelineSchema.createNode('mediaExport', { id: 'timed-export-scenes', label: 'Timed export scenes', config: { title: 'Focused dynamic transition export', width: 320, height: 180, fps: 8, fitMode: 'contain', stopMode: 'shortest' } });
  const output = pipelineSchema.createNode('videoOutput', { id: 'timed-video-output', label: 'Timed video output', config: { title: 'Focused dynamic transition final' } });
  return pipelineSchema.createEmptyPipeline({
    id: 'verify-focused-dynamic-transition-export',
    name: 'Verify Focused Dynamic Transition Export',
    nodes: [collection, narration, composition, exportNode, output],
    edges: [
      pipelineSchema.createEdge(collection.id, 'collection', composition.id, 'visuals'),
      pipelineSchema.createEdge(narration.id, 'audio', composition.id, 'audio'),
      pipelineSchema.createEdge(composition.id, 'composition', exportNode.id, 'composition'),
      pipelineSchema.createEdge(exportNode.id, 'video', output.id, 'video'),
    ],
  });
}
function assertFiniteIncreasingOffsets(boundaries, totalDurationSeconds) {
  const offsets = boundaries.map((boundary) => Number(boundary.offsetSeconds));
  assert(offsets.every((offset) => Number.isFinite(offset)), 'Expected every transition offset to be finite.');
  assert(offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]), 'Expected transition offsets to increase.');
  assert(offsets.every((offset) => offset >= 0 && offset < totalDurationSeconds), 'Expected transition offsets to remain bounded by the visual duration.');
}
async function verifyFocusedTransitionEnabledDynamicMediaExport() {
  const assetPaths = await prepareAssets(4);
  const pipeline = createDynamicTransitionExportPipeline(assetPaths);
  analyzeExecutablePipeline(pipeline, 'focused dynamic transition export pipeline');
  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for focused dynamic transition export.');
  const completedRun = await waitForCompletedRun(initialRun.runId, 'the focused dynamic transition export pipeline');
  assert.strictEqual(completedRun.status, 'completed', completedRun.message || 'Expected focused dynamic transition export pipeline to complete.');
  const visualTrack = completedRun.resultsByNodeId?.['timed-compose-scenes']?.outputs?.composition?.composition?.tracks?.find((track) => track.role === 'primary-visual') || null;
  assert.strictEqual(visualTrack?.timing?.timingMetadataUsed, true, 'Expected dynamic timing metadata to stay authoritative with transitions enabled.');
  assert.strictEqual(visualTrack.timing.totalVisualDurationSeconds, 4, 'Expected dynamic visual duration to remain bounded to the planned four seconds.');
  assert.strictEqual(visualTrack.sceneTransitions.boundaries.length, 3, 'Expected four timed scenes to create three transition boundaries.');
  assert(visualTrack.sceneTransitions.boundaries.some((boundary) => boundary.wasClamped === true), 'Expected short dynamic scenes to clamp transition duration.');
  assert(visualTrack.sceneTransitions.boundaries.every((boundary) => Number(boundary.effectiveDurationSeconds) <= Number(boundary.requestedDurationSeconds)), 'Expected transition durations not to exceed requested duration.');
  assertFiniteIncreasingOffsets(visualTrack.sceneTransitions.boundaries, 4);
  const exportArtifact = completedRun.resultsByNodeId?.['timed-export-scenes']?.outputs?.video || null;
  const exportMetadata = exportArtifact?.compositionExport || null;
  assert.strictEqual(exportMetadata?.visualTrack?.totalVisualDurationSeconds, 4, 'Expected Media Export metadata to preserve bounded visual duration.');
  assert.strictEqual(exportMetadata.visualTrack.timingMetadataUsed, true, 'Expected Media Export metadata to preserve dynamic timing use.');
  assert.strictEqual(exportMetadata.visualTrack.sceneTransitions.renderEnabled, true, 'Expected Media Export metadata to mark transition rendering enabled.');
  assert.strictEqual(exportMetadata.visualTrack.sceneTransitions.boundaries.length, 3, 'Expected Media Export metadata to carry the transition summary.');
  assert(exportMetadata.exportProfile.commandTimeoutMs >= 120000 && exportMetadata.exportProfile.commandTimeoutMs <= 900000, 'Expected transition export timeout metadata to stay bounded.');
  assert.strictEqual(exportMetadata.exportProfile.sceneTransitions?.totalVisualDurationSeconds, 4, 'Expected transition export profile not to grow beyond the dynamic visual duration.');
  const exportSidecar = readJson(exportArtifact.metadataPaths[0]);
  assert.strictEqual(exportSidecar.visualTrack?.sceneTransitions?.renderEnabled, true, 'Expected transition summary carry-forward in the export sidecar.');
  assert.strictEqual(exportSidecar.visualTrack?.totalVisualDurationSeconds, 4, 'Expected export sidecar to preserve bounded dynamic timing.');
}

function verifySourceGuardsForUnexportedRegressionPaths() {
  const pipelineExecutionSource = fs.readFileSync(PIPELINE_EXECUTION_SERVICE_PATH, 'utf8');
  const mediaCompositionSource = fs.readFileSync(MEDIA_COMPOSITION_SERVICE_PATH, 'utf8');
  const builderPanelSource = fs.readFileSync(PIPELINE_BUILDER_PANEL_PATH, 'utf8');
  assert(/run\.retryOverridesByNodeId\[nodeId\]\s*=\s*\{[\s\S]*mediaComposition:\s*overrideConfig/.test(pipelineExecutionSource), 'Expected Media Composition retry overrides to remain stored by target node id.');
  assert(/run\.retryOverridesByNodeId\[nodeId\]\s*=\s*\{[\s\S]*burnSubtitles:\s*overrideConfig/.test(pipelineExecutionSource), 'Expected Burn Subtitles retry overrides to remain stored by target node id.');
  assert(/getMediaCompositionEffectiveConfig\(node, run\)[\s\S]*\.\.\.\(node\.config \|\| \{\}\),[\s\S]*\.\.\.\(retryConfig \|\| \{\}\)/.test(pipelineExecutionSource), 'Expected Media Composition retry overrides to merge only into effective execution config.');
  assert(/getBurnSubtitlesEffectiveConfig\(node, run\)[\s\S]*\.\.\.\(node\.config \|\| \{\}\),[\s\S]*\.\.\.\(retryConfig \|\| \{\}\)/.test(pipelineExecutionSource), 'Expected Burn Subtitles retry overrides to merge only into effective execution config.');
  assert(/inputResolution:\s*'loop-retry-artifact-fallback'[\s\S]*usedOriginalSourceVideo:\s*false/.test(pipelineExecutionSource), 'Expected Burn Subtitles retry fallback metadata when the original clean source is unavailable.');
  assert(/ignoredLoopRetryVideo:\s*true[\s\S]*inputResolution:\s*'connected-input-for-retry'[\s\S]*usedOriginalSourceVideo:\s*true/.test(pipelineExecutionSource), 'Expected Burn Subtitles clean-source retry path to ignore loop-carried burned artifacts.');
  assert(/cancelSignal:\s*activeRunAbortController\?\.signal \|\| null/.test(pipelineExecutionSource), 'Expected Media Export execution to receive pipeline cancellation wiring.');
  assert(/timeoutMs:\s*commandTimeoutMs/.test(mediaCompositionSource), 'Expected Media Export ffmpeg commands to use a bounded timeout.');
  assert(/signal:\s*options\.cancelSignal \|\| null/.test(mediaCompositionSource), 'Expected Media Export ffmpeg commands to receive the cancel signal.');
  assert(/formatFfmpegSeconds\(visualDurationSeconds\)/.test(mediaCompositionSource), 'Expected transition-enabled Media Export to bound ffmpeg output duration.');
  assert(/setValidationRetryOverrides\(null\)/.test(builderPanelSource), 'Expected validation retry override form state to reset after a decision.');
}

async function main() {
  fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
  verifySourceGuardsForUnexportedRegressionPaths();
  await cleanupActiveRun();
  await verifyFocusedMediaCompositionRetryOverrides();
  await cleanupActiveRun();
  await verifyFocusedBurnSubtitlesCleanSourceRetry();
  await cleanupActiveRun();
  await verifyBurnSubtitlesFallbackWhenOriginalSourceUnavailable();
  await cleanupActiveRun();
  await verifyFocusedTransitionEnabledDynamicMediaExport();
  await cleanupActiveRun();
  console.log('Focused pipeline regression coverage verification passed.');
}
main().catch(async (error) => { await cleanupActiveRun(); console.error(error && error.stack ? error.stack : error); process.exit(1); });
