const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-pipeline-media-composition');
const MEDIA_COMPOSITION_SERVICE_PATH = path.join(process.cwd(), 'electron', 'services', 'mediaCompositionService.js');
const PIPELINE_BUILDER_PANEL_PATH = path.join(process.cwd(), 'src', 'components', 'PipelineBuilderPanel.jsx');
const PIPELINE_EXECUTION_SERVICE_PATH = path.join(process.cwd(), 'electron', 'services', 'pipelineExecutionService.js');

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'home' || name === 'appData') {
            return TEST_STORAGE_ROOT;
          }

          if (name === 'exe') {
            return process.execPath;
          }

          return process.cwd();
        },
        isPackaged: false,
      },
      nativeImage: null,
    };
  }

  if (normalizedParent.endsWith('/electron/services/pipelineArtifactService.js') && request === './configService') {
    return {
      ensureStorage: async () => {
        fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
      },
      getAppPaths: () => ({
        runtimesRoot: TEST_STORAGE_ROOT,
      }),
    };
  }

  if (normalizedParent.endsWith('/electron/services/pipelineExecutionService.js')) {
    if (request === './providerRegistry') {
      return {
        initializeProviderRegistry: async () => {},
      };
    }

    if (request === './providerService') {
      return {
        chatWithProvider: async () => ({ message: { content: 'pass' } }),
        listProviderConnections: async () => ([]),
        runProviderOperation: async () => ({ message: { content: '' } }),
      };
    }

    if (request === './toolRegistry') {
      return {
        getToolCatalog: () => [],
        initializeToolRegistry: async () => {},
      };
    }

    if (request === './toolStateService') {
      return {
        buildMergedToolStateList: async () => [],
        getResolvedToolState: async () => null,
      };
    }
  }

  return originalLoad.call(this, request, parent, isMain);
};

const {
  MEDIA_COMPOSITION_TRANSITION_CATEGORIES,
  analyzePipeline,
  createEdge,
  createEmptyPipeline,
  createNode,
  getNodeTypeDefinition,
} = require('../electron/shared/pipelineSchema.cjs');
const {
  cancelPipelineRun,
  getActiveRunSnapshot,
  resumePipelineValidation,
  runPipeline,
} = require('../electron/services/pipelineExecutionService');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }
    await wait(50);
  }

  throw new Error('Timed out while waiting for ' + label + '.');
}

async function cleanupActiveRun() {
  const activeRun = getActiveRunSnapshot();
  if (!activeRun || (activeRun.status !== 'running' && activeRun.status !== 'paused')) {
    return;
  }

  try {
    cancelPipelineRun(activeRun.runId);
  } catch {
    return;
  }

  await waitFor('the active pipeline run to stop', () => {
    const currentRun = getActiveRunSnapshot();
    return !currentRun || ['cancelled', 'completed', 'failed'].includes(currentRun.status) ? currentRun || true : null;
  });
}

function createImageBuffer() {
  return Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
}

function createWaveBuffer(durationSeconds = 3, sampleRate = 8000) {
  const channelCount = 1;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const frameCount = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = frameCount * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function buildMediaCompositionPipeline(assetPaths, options = {}) {
  const includeNarration = options.includeNarration !== false;
  const includeBackgroundMusic = options.includeBackgroundMusic === true;
  const firstImage = createNode('imageInput', {
    id: 'image-one',
    label: 'Scene 1',
    config: { filePath: assetPaths.imageOne },
  });
  const secondImage = createNode('imageInput', {
    id: 'image-two',
    label: 'Scene 2',
    config: { filePath: assetPaths.imageTwo },
  });
  const thirdImage = createNode('imageInput', {
    id: 'image-three',
    label: 'Scene 3',
    config: { filePath: assetPaths.imageThree || assetPaths.imageOne },
  });
  const narration = createNode('audioInput', {
    id: 'narration-audio',
    label: 'Narration',
    config: { filePath: assetPaths.narration },
  });
  const backgroundMusic = createNode('audioInput', {
    id: 'background-music-audio',
    label: 'Background music',
    config: { filePath: assetPaths.backgroundMusic },
  });
  const collection = createNode('collectionBuilder', {
    id: 'visual-collection',
    label: 'Visual collection',
  });
  const composition = createNode('mediaComposition', {
    id: 'compose-scenes',
    label: 'Compose scenes',
    config: {
      secondsPerItem: Number(options.secondsPerItem || 0) || 1.5,
      ...(options.narrationVolume !== undefined ? { narrationVolume: options.narrationVolume } : {}),
      ...(options.backgroundMusicVolume !== undefined ? { backgroundMusicVolume: options.backgroundMusicVolume } : {}),
      ...(options.transitionConfig && typeof options.transitionConfig === 'object' ? options.transitionConfig : {}),
    },
  });
  const exportNode = createNode('mediaExport', {
    id: 'export-scenes',
    label: 'Export scenes',
    config: {
      title: options.title || 'Storyboard export',
      width: 640,
      height: 360,
      fps: 12,
      fitMode: 'contain',
      stopMode: options.stopMode || 'shortest',
    },
  });
  const output = createNode('videoOutput', {
    id: 'video-output',
    label: 'Video output',
    config: {
      title: options.outputTitle || 'Storyboard export final',
    },
  });

  const nodes = [firstImage, secondImage, ...(options.includeThirdImage ? [thirdImage] : []), collection, composition, exportNode, output];
  if (includeNarration) {
    nodes.splice(2, 0, narration);
  }
  if (includeBackgroundMusic) {
    nodes.splice(includeNarration ? 3 : 2, 0, backgroundMusic);
  }

  const edges = [
    createEdge(firstImage.id, 'image', collection.id, 'items'),
    createEdge(secondImage.id, 'image', collection.id, 'items'),
    ...(options.includeThirdImage ? [createEdge(thirdImage.id, 'image', collection.id, 'items')] : []),
    createEdge(collection.id, 'collection', composition.id, 'visuals'),
    createEdge(composition.id, 'composition', exportNode.id, 'composition'),
    createEdge(exportNode.id, 'video', output.id, 'video'),
  ];
  if (includeNarration) {
    edges.splice(3, 0, createEdge(narration.id, 'audio', composition.id, 'audio'));
  }
  if (includeBackgroundMusic) {
    edges.splice(includeNarration ? 4 : 3, 0, createEdge(backgroundMusic.id, 'audio', composition.id, 'backgroundMusic'));
  }

  return createEmptyPipeline({
    id: 'verify-pipeline-media-composition',
    name: 'Verify Pipeline Media Composition',
    nodes,
    edges,
  });
}

function buildTimedMediaCompositionPipeline(assetPaths, options = {}) {
  const defaultDurations = [5, 5, 5, 5, 5, 5, 10];
  const requestedDurations = Array.isArray(options.timedDurations) && options.timedDurations.length
    ? options.timedDurations
    : defaultDurations;
  let cursorSeconds = 0;
  const timedItems = requestedDurations.map((rawDuration, index) => {
    const durationSeconds = Math.max(0.05, Number(rawDuration || 0) || defaultDurations[index % defaultDurations.length] || 5);
    const startSeconds = Number(cursorSeconds.toFixed(6));
    cursorSeconds += durationSeconds;
    const endSeconds = Number(cursorSeconds.toFixed(6));
    return {
      id: 'timed-scene-' + String(index + 1),
      filePath: index % 2 === 0 ? assetPaths.imageOne : assetPaths.imageTwo,
      metadata: {
        durationSeconds: Number(durationSeconds.toFixed(6)),
        endSeconds,
        narrationExcerpt: 'Narration section ' + String(index + 1),
        sourceTranscriptSegmentIds: [String(index)],
        startSeconds,
      },
    };
  });
  const collection = createNode('collectionInput', {
    id: 'timed-visual-collection',
    label: 'Timed visual collection',
    config: {
      itemType: 'image',
      items: timedItems,
      metadata: {
        timing: {
          timedItemCount: timedItems.length,
          timingMode: 'dynamicFromPlanTiming',
          totalPlannedDurationSeconds: Number(cursorSeconds.toFixed(6)),
        },
      },
    },
  });
  const narration = createNode('audioInput', {
    id: 'timed-narration-audio',
    label: 'Timed narration',
    config: { filePath: assetPaths.narration },
  });
  const composition = createNode('mediaComposition', {
    id: 'timed-compose-scenes',
    label: 'Timed compose scenes',
    config: {
      imageTimingMode: options.imageTimingMode || 'dynamicFromImageMetadata',
      secondsPerItem: Number(options.secondsPerItem || 0) || 4,
      ...(options.transitionConfig && typeof options.transitionConfig === 'object' ? options.transitionConfig : {}),
    },
  });
  const exportNode = createNode('mediaExport', {
    id: 'timed-export-scenes',
    label: 'Timed export scenes',
    config: {
      title: 'Timed storyboard export',
      width: 640,
      height: 360,
      fps: 12,
      fitMode: 'contain',
      stopMode: 'shortest',
    },
  });
  const output = createNode('videoOutput', {
    id: 'timed-video-output',
    label: 'Timed video output',
    config: { title: 'Timed storyboard export final' },
  });
  return createEmptyPipeline({
    id: 'verify-pipeline-media-composition-timed',
    name: 'Verify Pipeline Media Composition Timed',
    nodes: [collection, narration, composition, exportNode, output],
    edges: [
      createEdge(collection.id, 'collection', composition.id, 'visuals'),
      createEdge(narration.id, 'audio', composition.id, 'audio'),
      createEdge(composition.id, 'composition', exportNode.id, 'composition'),
      createEdge(exportNode.id, 'video', output.id, 'video'),
    ],
  });
}

function buildInvalidTimedMediaCompositionPipeline(assetPaths, options = {}) {
  const pipeline = buildTimedMediaCompositionPipeline(assetPaths, { ...options, imageTimingMode: 'dynamicFromImageMetadata' });
  const input = pipeline.nodes.find((node) => node.id === 'timed-visual-collection');
  input.config.items = input.config.items.map((item, index) => index === 1 ? { ...item, metadata: { narrationExcerpt: 'missing timing' } } : item);
  return pipeline;
}
function buildMediaCompositionValidationRetryPipeline(assetPaths, options = {}) {
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeBackgroundMusic: true,
    includeNarration: true,
    outputTitle: options.outputTitle || 'Storyboard retry final',
    title: options.title || 'Storyboard retry export',
  });
  const validation = createNode('validation', {
    id: 'review-export',
    label: 'Review exported video',
    config: {
      mode: 'user',
    },
  });
  const retryLoop = createNode('retryLoop', {
    id: 'retry-export',
    label: 'Retry export mix',
    config: {
      maxAttempts: 2,
      retryTargetNodeId: 'compose-scenes',
      stopWhenRetryArtifactRepeats: false,
      terminationAction: 'fail',
    },
  });

  return createEmptyPipeline({
    id: options.id || 'verify-pipeline-media-composition-retry',
    name: options.name || 'Verify Pipeline Media Composition Retry',
    nodes: [
      ...pipeline.nodes.filter((node) => node.id !== 'video-output'),
      validation,
      retryLoop,
      pipeline.nodes.find((node) => node.id === 'video-output'),
    ].filter(Boolean),
    edges: [
      ...pipeline.edges.filter((edge) => edge.target.nodeId !== 'video-output'),
      createEdge('export-scenes', 'video', validation.id, 'input'),
      createEdge(validation.id, 'pass', retryLoop.id, 'complete'),
      createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      createEdge(retryLoop.id, 'result', 'video-output', 'video'),
    ],
  });
}

async function prepareAssets() {
  const assetRoot = path.join(TEST_STORAGE_ROOT, 'fixtures');
  fs.mkdirSync(assetRoot, { recursive: true });
  const imageOne = path.join(assetRoot, 'scene-1.gif');
  const imageTwo = path.join(assetRoot, 'scene-2.gif');
  const imageThree = path.join(assetRoot, 'scene-3.gif');
  const narration = path.join(assetRoot, 'narration.wav');
  const backgroundMusic = path.join(assetRoot, 'background-music.wav');
  fs.writeFileSync(imageOne, createImageBuffer());
  fs.writeFileSync(imageTwo, createImageBuffer());
  fs.writeFileSync(imageThree, createImageBuffer());
  fs.writeFileSync(narration, createWaveBuffer(3));
  fs.writeFileSync(backgroundMusic, createWaveBuffer(5));
  return { backgroundMusic, imageOne, imageThree, imageTwo, narration };
}

async function runAndWaitForPipeline(pipeline) {
  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the media composition pipeline.');

  return waitFor('the media composition pipeline to finish', () => {
    const run = getActiveRunSnapshot();
    return run && ['completed', 'failed'].includes(run.status) && run.runId === initialRun.runId ? run : null;
  }, 45000);
}

function verifyCompletedRun(completedRun) {
  assert.strictEqual(
    completedRun.status,
    'completed',
    `Expected the media composition pipeline to complete, but it ${completedRun.status || 'stopped'} with: ${completedRun.nodeStates?.['export-scenes']?.message || completedRun.message || 'no message'}.`,
  );

  const terminalResult = completedRun.terminalResults?.[0] || null;
  assert(terminalResult, 'Expected the pipeline to produce a terminal video result.');
  assert.strictEqual(terminalResult.kind, 'video', 'Expected the terminal result to stay video-typed.');
  assert(terminalResult.filePath && fs.existsSync(terminalResult.filePath), 'Expected the final saved video output to exist.');
  assert(Array.isArray(terminalResult.artifact?.metadataPaths) && terminalResult.artifact.metadataPaths.length, 'Expected the final video output to keep export metadata sidecars.');
  assert(fs.existsSync(terminalResult.artifact.metadataPaths[0]), 'Expected the final export metadata sidecar to exist.');
}

async function verifyMediaCompositionWithBackgroundMusic() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeBackgroundMusic: true,
    includeNarration: true,
    outputTitle: 'Storyboard export with music final',
    title: 'Storyboard export with music',
  });
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected mixed media composition pipeline to be executable.');

  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);

  const compositionResult = completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition || null;
  assert(compositionResult, 'Expected the media composition node to produce a composition artifact.');
  assert.strictEqual(compositionResult.kind, 'composition', 'Expected a first-class composition artifact from the composition node.');
  assert(compositionResult.manifestPath && fs.existsSync(compositionResult.manifestPath), 'Expected the composition manifest to exist.');

  const compositionManifest = JSON.parse(fs.readFileSync(compositionResult.manifestPath, 'utf8'));
  assert.strictEqual(compositionManifest.kind, 'composition', 'Expected the composition manifest to record the composition kind.');
  assert.strictEqual(compositionManifest.trackCount, 3, 'Expected the composition manifest to keep visual, narration, and background-music tracks.');
  assert.strictEqual(compositionManifest.tracks?.[0]?.itemCount, 2, 'Expected the visual track to keep both ordered images.');
  assert.strictEqual(compositionManifest.tracks?.[2]?.role, 'background-music', 'Expected the composition manifest to label the background music track.');
  const visualTrack = compositionResult.composition?.tracks?.find((track) => track.role === 'primary-visual') || null;
  assert.strictEqual(visualTrack?.imageTimingMode, 'fixedDurationPerImage', 'Expected saved fixed-duration media composition behavior to remain unchanged.');
  assert.strictEqual(visualTrack?.items?.[0]?.durationSeconds, 1.5, 'Expected fixed mode to use secondsPerItem for each image.');
  assert.strictEqual(visualTrack?.timing?.fixedDurationSeconds, 1.5, 'Expected fixed mode timing metadata to record secondsPerItem.');

  const exportArtifact = completedRun.resultsByNodeId?.['export-scenes']?.outputs?.video || null;
  assert(exportArtifact, 'Expected the media export node to produce a video artifact.');
  assert.strictEqual(exportArtifact.kind, 'video', 'Expected the export node to return a video artifact.');
  assert(exportArtifact.filePath && fs.existsSync(exportArtifact.filePath), 'Expected the exported video file to exist.');
  assert(exportArtifact.compositionExport, 'Expected the exported video artifact to keep composition export metadata.');
  assert.strictEqual(exportArtifact.compositionExport.visualTrack?.itemCount, 2, 'Expected the export metadata to keep visual track item count.');
  assert(exportArtifact.compositionExport.audioTrack?.artifact?.fileName, 'Expected the export metadata to keep the primary audio track reference.');
  assert(exportArtifact.compositionExport.backgroundMusicTrack?.artifact?.fileName, 'Expected the export metadata to keep the background music track reference.');
  assert.strictEqual(exportArtifact.compositionExport.audioMix?.mode, 'mixed-with-background-music', 'Expected the export metadata to record the mixed-audio mode.');
  assert.strictEqual(exportArtifact.compositionExport.audioMix?.narrationVolume, 1, 'Expected the export metadata to record the default narration level.');
  assert.strictEqual(exportArtifact.compositionExport.audioMix?.backgroundMusicVolume, 0.22, 'Expected the export metadata to record the default background music level.');
}

async function verifyMediaCompositionCustomMixLevels() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    backgroundMusicVolume: 0.18,
    includeBackgroundMusic: true,
    includeNarration: true,
    narrationVolume: 0.73,
    outputTitle: 'Storyboard export custom mix final',
    title: 'Storyboard export custom mix',
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);

  const compositionResult = completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition || null;
  assert.strictEqual(compositionResult?.composition?.audioMix?.narrationVolume, 0.73, 'Expected composition metadata to preserve selected narration level.');
  assert.strictEqual(compositionResult?.composition?.audioMix?.backgroundMusicVolume, 0.18, 'Expected composition metadata to preserve selected background music level.');

  const exportArtifact = completedRun.resultsByNodeId?.['export-scenes']?.outputs?.video || null;
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.narrationVolume, 0.73, 'Expected export metadata to preserve selected narration level.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.backgroundMusicVolume, 0.18, 'Expected export metadata to preserve selected background music level.');
  assert(/background music at 18% and narration at 73%/.test(completedRun.nodeStates?.['export-scenes']?.message || ''), 'Expected export status message to reflect selected mix levels.');
}

function buildDirectCompositionValidationPipeline(assetPaths, options = {}) {
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeBackgroundMusic: true,
    includeNarration: true,
    outputTitle: options.outputTitle || 'Direct composition validation final',
    title: options.title || 'Direct composition validation export',
  });
  const validation = createNode('validation', {
    id: 'review-raw-composition',
    label: 'Review raw composition',
    config: {
      mode: 'user',
    },
  });
  const merge = createNode('branchMerge', {
    id: 'merge-raw-composition-review',
    label: 'Merge raw composition review',
  });

  return createEmptyPipeline({
    id: options.id || 'verify-direct-composition-validation',
    name: options.name || 'Verify Direct Composition Validation',
    nodes: [
      ...pipeline.nodes.filter((node) => node.id !== 'export-scenes' && node.id !== 'video-output'),
      validation,
      merge,
      pipeline.nodes.find((node) => node.id === 'export-scenes'),
      pipeline.nodes.find((node) => node.id === 'video-output'),
    ].filter(Boolean),
    edges: [
      ...pipeline.edges.filter((edge) => !(edge.source.nodeId === 'compose-scenes' && edge.target.nodeId === 'export-scenes')),
      createEdge('compose-scenes', 'composition', validation.id, 'input'),
      createEdge(validation.id, 'pass', merge.id, 'branch'),
      createEdge(validation.id, 'fail', merge.id, 'branch'),
      createEdge(merge.id, 'result', 'export-scenes', 'composition'),
    ],
  });
}

async function verifyDirectMediaCompositionValidationDoesNotExposeRetryControls() {
  const assetPaths = await prepareAssets();
  const pipeline = buildDirectCompositionValidationPipeline(assetPaths, {
    id: 'verify-direct-composition-validation-no-controls',
    name: 'Verify Direct Composition Validation No Controls',
  });
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected direct composition validation pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for direct composition validation.');
  const pause = await waitFor('the direct composition validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'review-raw-composition' ? run : null;
  }, 45000);
  assert.strictEqual(pause.pendingValidation?.artifact?.kind, 'composition', 'Expected direct validation to receive the intermediate composition artifact.');
  assert.strictEqual(pause.pendingValidation?.retryControls, null, 'Expected direct Media Composition validation not to expose export retry controls.');
}

async function verifyMediaCompositionRetryOverrides() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionValidationRetryPipeline(assetPaths, {
    id: 'verify-pipeline-media-composition-retry-overrides',
    name: 'Verify Pipeline Media Composition Retry Overrides',
    outputTitle: 'Storyboard retry override final',
    title: 'Storyboard retry override export',
  });
  const savedCompositionNode = pipeline.nodes.find((node) => node.id === 'compose-scenes');
  assert.strictEqual(savedCompositionNode?.config?.narrationVolume, 1, 'Expected the saved pipeline to start with default narration volume.');
  assert.strictEqual(savedCompositionNode?.config?.backgroundMusicVolume, 0.22, 'Expected the saved pipeline to start with default background music volume.');

  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected media composition validation retry pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the media composition retry pipeline.');

  const firstPause = await waitFor('the first media composition validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'review-export' ? run : null;
  }, 45000);
  assert.strictEqual(firstPause.pendingValidation?.artifact?.kind, 'video', 'Expected validation to review the previewable Media Export video.');
  assert.strictEqual(firstPause.pendingValidation?.artifact?.compositionExport?.pipelineTrace?.mediaCompositionNodeId, 'compose-scenes', 'Expected Media Export metadata to trace the upstream Media Composition node.');
  assert.strictEqual(firstPause.pendingValidation?.artifact?.compositionExport?.pipelineTrace?.mediaExportNodeId, 'export-scenes', 'Expected Media Export metadata to trace the export node.');
  assert.strictEqual(firstPause.pendingValidation?.retryControls?.mediaComposition?.nodeId, 'compose-scenes', 'Expected Media Export validation to expose upstream Media Composition retry controls.');
  assert.strictEqual(firstPause.pendingValidation.retryControls.mediaComposition.narrationVolume, 1, 'Expected retry controls to start from the effective narration volume.');
  assert.strictEqual(firstPause.pendingValidation.retryControls.mediaComposition.backgroundMusicVolume, 0.22, 'Expected retry controls to start from the effective background volume.');

  resumePipelineValidation(firstPause.runId, {
    decision: 'fail',
    nodeId: firstPause.pendingValidation.nodeId,
    requestId: firstPause.pendingValidation.requestId,
    retryOverrides: {
      mediaComposition: {
        backgroundMusicVolume: 0.11,
        narrationVolume: 0.55,
      },
    },
  });

  const secondPause = await waitFor('the retried media composition validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'review-export' && run?.pendingValidation?.iteration === 2 ? run : null;
  }, 45000);
  assert.strictEqual(secondPause.pendingValidation?.artifact?.kind, 'video', 'Expected retry validation to review the newly exported video.');
  assert.strictEqual(secondPause.nodeStates?.['compose-scenes']?.runCount, 2, 'Expected Media Composition to rerun after validation failure.');
  assert.strictEqual(secondPause.nodeStates?.['export-scenes']?.runCount, 2, 'Expected Media Export to rerun after validation failure.');
  assert.strictEqual(secondPause.nodeStates?.['compose-scenes']?.outputs?.composition?.composition?.audioMix?.narrationVolume, 0.55, 'Expected retry override narration volume to affect the retried composition artifact.');
  assert.strictEqual(secondPause.nodeStates?.['compose-scenes']?.outputs?.composition?.composition?.audioMix?.backgroundMusicVolume, 0.11, 'Expected retry override background music volume to affect the retried composition artifact.');
  assert.strictEqual(secondPause.nodeStates?.['export-scenes']?.outputs?.video?.compositionExport?.audioMix?.narrationVolume, 0.55, 'Expected retry override narration volume to affect the retried export artifact.');
  assert.strictEqual(secondPause.nodeStates?.['export-scenes']?.outputs?.video?.compositionExport?.audioMix?.backgroundMusicVolume, 0.11, 'Expected retry override background music volume to affect the retried export artifact.');
  assert.strictEqual(secondPause.pendingValidation?.artifact?.compositionExport?.audioMix?.narrationVolume, 0.55, 'Expected validation preview artifact to carry retried narration volume.');
  assert.strictEqual(secondPause.pendingValidation?.artifact?.compositionExport?.audioMix?.backgroundMusicVolume, 0.11, 'Expected validation preview artifact to carry retried background volume.');
  assert.strictEqual(secondPause.pendingValidation?.retryControls?.mediaComposition?.narrationVolume, 0.55, 'Expected second review controls to show the retried narration volume.');
  assert.strictEqual(secondPause.pendingValidation?.retryControls?.mediaComposition?.backgroundMusicVolume, 0.11, 'Expected second review controls to show the retried background volume.');
  assert(/primary narration at 55% and background music at 11%/.test(secondPause.nodeStates?.['compose-scenes']?.message || ''), 'Expected composition status to show effective retry override values.');
  assert(/background music at 11% and narration at 55%/.test(secondPause.nodeStates?.['export-scenes']?.message || ''), 'Expected export status to show effective retry override values.');
  assert.strictEqual(savedCompositionNode.config.narrationVolume, 1, 'Expected retry override not to mutate saved narration volume.');
  assert.strictEqual(savedCompositionNode.config.backgroundMusicVolume, 0.22, 'Expected retry override not to mutate saved background music volume.');

  resumePipelineValidation(secondPause.runId, {
    decision: 'pass',
    nodeId: secondPause.pendingValidation.nodeId,
    requestId: secondPause.pendingValidation.requestId,
  });

  const completedRun = await waitFor('the media composition retry override pipeline to finish', () => {
    const run = getActiveRunSnapshot();
    return run && ['completed', 'failed'].includes(run.status) && run.runId === initialRun.runId ? run : null;
  }, 45000);
  verifyCompletedRun(completedRun);

  const compositionResult = completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition || null;
  assert.strictEqual(compositionResult?.composition?.audioMix?.narrationVolume, 0.55, 'Expected final composition metadata to record the effective retry narration volume.');
  assert.strictEqual(compositionResult?.composition?.audioMix?.backgroundMusicVolume, 0.11, 'Expected final composition metadata to record the effective retry background volume.');
  const compositionManifest = JSON.parse(fs.readFileSync(compositionResult.manifestPath, 'utf8'));
  assert.strictEqual(compositionManifest.composition?.audioMix?.narrationVolume, 0.55, 'Expected composition sidecar to record effective retry narration volume.');
  assert.strictEqual(compositionManifest.composition?.audioMix?.backgroundMusicVolume, 0.11, 'Expected composition sidecar to record effective retry background volume.');
  const exportArtifact = completedRun.resultsByNodeId?.['export-scenes']?.outputs?.video || null;
  assert.strictEqual(exportArtifact?.compositionExport?.pipelineTrace?.mediaCompositionNodeId, 'compose-scenes', 'Expected export metadata to keep the upstream Media Composition node id.');
  assert.strictEqual(exportArtifact?.compositionExport?.pipelineTrace?.mediaExportNodeId, 'export-scenes', 'Expected export metadata to keep the Media Export node id.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.narrationVolume, 0.55, 'Expected export metadata to carry retry override narration volume.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.backgroundMusicVolume, 0.11, 'Expected export metadata to carry retry override background volume.');
  const exportSidecar = JSON.parse(fs.readFileSync(exportArtifact.metadataPaths[0], 'utf8'));
  assert.strictEqual(exportSidecar.pipelineTrace?.mediaCompositionNodeId, 'compose-scenes', 'Expected export sidecar to keep the upstream Media Composition node id.');
  assert.strictEqual(exportSidecar.audioMix?.narrationVolume, 0.55, 'Expected export sidecar to record effective retry narration volume.');
  assert.strictEqual(exportSidecar.audioMix?.backgroundMusicVolume, 0.11, 'Expected export sidecar to record effective retry background volume.');
  assert(/background music at 11% and narration at 55%/.test(completedRun.nodeStates?.['export-scenes']?.message || ''), 'Expected export summary to show effective retry override values.');
}

async function verifyMediaCompositionRetryWithoutOverridesUsesSavedConfig() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionValidationRetryPipeline(assetPaths, {
    id: 'verify-pipeline-media-composition-retry-defaults',
    name: 'Verify Pipeline Media Composition Retry Defaults',
    outputTitle: 'Storyboard retry default final',
    title: 'Storyboard retry default export',
  });
  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the default retry pipeline.');

  const firstPause = await waitFor('the default retry validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'review-export' ? run : null;
  }, 45000);
  resumePipelineValidation(firstPause.runId, {
    decision: 'fail',
    nodeId: firstPause.pendingValidation.nodeId,
    requestId: firstPause.pendingValidation.requestId,
  });

  const secondPause = await waitFor('the default retried validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'review-export' && run?.pendingValidation?.iteration === 2 ? run : null;
  }, 45000);
  assert.strictEqual(secondPause.pendingValidation?.artifact?.kind, 'video', 'Expected retry without override to review the exported video.');
  assert.strictEqual(secondPause.nodeStates?.['compose-scenes']?.runCount, 2, 'Expected Media Composition to rerun for retry without override.');
  assert.strictEqual(secondPause.nodeStates?.['export-scenes']?.runCount, 2, 'Expected Media Export to rerun for retry without override.');
  assert.strictEqual(secondPause.nodeStates?.['compose-scenes']?.outputs?.composition?.composition?.audioMix?.narrationVolume, 1, 'Expected retry without override to keep saved narration volume.');
  assert.strictEqual(secondPause.nodeStates?.['compose-scenes']?.outputs?.composition?.composition?.audioMix?.backgroundMusicVolume, 0.22, 'Expected retry without override to keep saved background music volume.');
  assert.strictEqual(secondPause.pendingValidation?.artifact?.compositionExport?.audioMix?.narrationVolume, 1, 'Expected exported retry without override to keep saved narration volume.');
  assert.strictEqual(secondPause.pendingValidation?.artifact?.compositionExport?.audioMix?.backgroundMusicVolume, 0.22, 'Expected exported retry without override to keep saved background music volume.');

  resumePipelineValidation(secondPause.runId, {
    decision: 'pass',
    nodeId: secondPause.pendingValidation.nodeId,
    requestId: secondPause.pendingValidation.requestId,
  });

  const completedRun = await waitFor('the default retry pipeline to finish', () => {
    const run = getActiveRunSnapshot();
    return run && ['completed', 'failed'].includes(run.status) && run.runId === initialRun.runId ? run : null;
  }, 45000);
  verifyCompletedRun(completedRun);
  assert.strictEqual(completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition?.composition?.audioMix?.narrationVolume, 1, 'Expected completed default retry to keep saved narration volume.');
  assert.strictEqual(completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition?.composition?.audioMix?.backgroundMusicVolume, 0.22, 'Expected completed default retry to keep saved background volume.');
  assert.strictEqual(completedRun.resultsByNodeId?.['export-scenes']?.outputs?.video?.compositionExport?.audioMix?.narrationVolume, 1, 'Expected completed default export retry to keep saved narration volume.');
  assert.strictEqual(completedRun.resultsByNodeId?.['export-scenes']?.outputs?.video?.compositionExport?.audioMix?.backgroundMusicVolume, 0.22, 'Expected completed default export retry to keep saved background volume.');
}

function verifyMediaCompositionInspectorFallbackField() {
  const source = fs.readFileSync(PIPELINE_BUILDER_PANEL_PATH, 'utf8');
  assert(/Fallback seconds per image/.test(source), 'Expected dynamic Media Composition mode to label seconds as a fallback field.');
  assert(/Used only as a fallback if transcript\/image timing metadata is unavailable or invalid\./.test(source), 'Expected dynamic Media Composition mode to explain fallback timing.');
  assert(/id="media-composition-seconds"/.test(source), 'Expected the seconds-per-image input to remain present in the Media Composition inspector.');
}

function verifyMediaExportTransitionRenderGuards() {
  const mediaCompositionSource = fs.readFileSync(MEDIA_COMPOSITION_SERVICE_PATH, 'utf8');
  const pipelineExecutionSource = fs.readFileSync(PIPELINE_EXECUTION_SERVICE_PATH, 'utf8');
  assert(/calculateMediaExportTimeoutMs/.test(mediaCompositionSource), 'Expected Media Export to calculate a bounded ffmpeg timeout.');
  assert(/timeoutMs:\s*commandTimeoutMs/.test(mediaCompositionSource), 'Expected Media Export ffmpeg commands to use the bounded timeout.');
  assert(/signal:\s*options\.cancelSignal \|\| null/.test(mediaCompositionSource), 'Expected Media Export ffmpeg commands to receive the pipeline cancel signal.');
  assert(/Media Export was cancelled while rendering the video\./.test(mediaCompositionSource), 'Expected transition exports to have a clear cancellation message.');
  assert(/Media Export took too long while rendering the video/.test(mediaCompositionSource), 'Expected transition exports to have a clear timeout message.');
  assert(/formatFfmpegSeconds\(visualDurationSeconds\)/.test(mediaCompositionSource), 'Expected transition renders to cap ffmpeg output to the planned visual duration.');
  assert(/Media Export ffmpeg render starting\./.test(mediaCompositionSource), 'Expected compact render-start logging for transition diagnostics.');
  assert(/Media Export ffmpeg render finished\./.test(mediaCompositionSource), 'Expected compact render-finish logging for transition diagnostics.');
  assert(/cancelSignal:\s*activeRunAbortController\?\.signal \|\| null/.test(pipelineExecutionSource), 'Expected Media Export execution to pass the active pipeline cancel signal.');
}

async function verifyDynamicMediaCompositionTiming() {
  const assetPaths = await prepareAssets();
  fs.writeFileSync(assetPaths.narration, createWaveBuffer(40));
  const pipeline = buildTimedMediaCompositionPipeline(assetPaths, { secondsPerItem: 9 });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);

  const compositionResult = completedRun.resultsByNodeId?.['timed-compose-scenes']?.outputs?.composition || null;
  const visualTrack = compositionResult?.composition?.tracks?.find((track) => track.role === 'primary-visual') || null;
  assert.strictEqual(visualTrack?.imageTimingMode, 'dynamicFromImageMetadata', 'Expected dynamic timing mode on the visual track.');
  assert.strictEqual(visualTrack?.timing?.timingMetadataUsed, true, 'Expected Media Composition to use image item timing metadata.');
  assert.strictEqual(visualTrack?.timing?.totalVisualDurationSeconds, 40, 'Expected seven timed images to cover forty seconds of narration.');
  assert.strictEqual(visualTrack?.timing?.fixedDurationSeconds, 9, 'Expected dynamic timing metadata to retain the configured fallback seconds.');
  assert.strictEqual(visualTrack?.timing?.fallbackDurationSeconds, null, 'Expected valid dynamic timing not to report a fallback duration.');
  assert.strictEqual(visualTrack?.items?.[0]?.durationSeconds, 5, 'Expected valid dynamic timing to ignore the fallback seconds value.');
  assert.strictEqual(visualTrack?.items?.length, 7, 'Expected all seven planned images to remain in the visual track.');
  assert.strictEqual(visualTrack.items[6].durationSeconds, 10, 'Expected the final timed image duration to come from metadata.');

  const exportArtifact = completedRun.resultsByNodeId?.['timed-export-scenes']?.outputs?.video || null;
  assert.strictEqual(exportArtifact?.compositionExport?.visualTrack?.imageTimingMode, 'dynamicFromImageMetadata', 'Expected Media Export metadata to record dynamic image timing mode.');
  assert.strictEqual(exportArtifact.compositionExport.visualTrack.timingMetadataUsed, true, 'Expected Media Export metadata to record that timing metadata was used.');
  assert.strictEqual(exportArtifact.compositionExport.visualTrack.totalVisualDurationSeconds, 40, 'Expected Media Export metadata to carry total visual duration.');
  assert.strictEqual(exportArtifact.compositionExport.visualTrack.timing.targetNarrationDurationSeconds, 40, 'Expected Media Export metadata to record narration target duration.');
}

async function verifyDynamicMediaCompositionFallback() {
  const assetPaths = await prepareAssets();
  const pipeline = buildInvalidTimedMediaCompositionPipeline(assetPaths, { secondsPerItem: 2.75 });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);

  const compositionResult = completedRun.resultsByNodeId?.['timed-compose-scenes']?.outputs?.composition || null;
  const visualTrack = compositionResult?.composition?.tracks?.find((track) => track.role === 'primary-visual') || null;
  assert.strictEqual(visualTrack?.imageTimingMode, 'fixedDurationPerImage', 'Expected invalid dynamic timing to fall back to fixed timing.');
  assert.strictEqual(visualTrack?.timing?.timingMetadataUsed, false, 'Expected fallback metadata to say timing metadata was not used.');
  assert(/missing|invalid|did not include valid/i.test(visualTrack?.timing?.fallbackReason || ''), 'Expected fallback metadata to include a plain-English reason.');
  assert.strictEqual(visualTrack?.timing?.fallbackDurationSeconds, 2.75, 'Expected fallback metadata to record the configured fallback duration.');
  assert(/2\.75 seconds per image/i.test(visualTrack?.timing?.fallbackReason || ''), 'Expected fallback reason to mention the fallback duration used.');
  assert.strictEqual(visualTrack?.items?.[0]?.durationSeconds, 2.75, 'Expected fallback timing to use the configured seconds-per-image value.');
}
function getCompositionVisualTrack(completedRun, nodeId = 'compose-scenes') {
  const compositionResult = completedRun.resultsByNodeId?.[nodeId]?.outputs?.composition || null;
  return compositionResult?.composition?.tracks?.find((track) => track.role === 'primary-visual') || null;
}

function getExportArtifact(completedRun, nodeId = 'export-scenes') {
  return completedRun.resultsByNodeId?.[nodeId]?.outputs?.video || null;
}

function verifyMediaCompositionTransitionDefaults() {
  const definition = getNodeTypeDefinition('mediaComposition');
  assert.strictEqual(definition.configDefaults.sceneTransitionMode, 'off', 'Media Composition should default scene transitions off.');
  assert.strictEqual(definition.configDefaults.sceneTransitionDurationSeconds, 0.5, 'Media Composition should default enabled transition duration to 0.5 seconds.');
  assert.strictEqual(definition.configDefaults.sceneTransitionName, 'fade', 'Media Composition should default single-transition selection to fade.');
  assert(Array.isArray(MEDIA_COMPOSITION_TRANSITION_CATEGORIES) && MEDIA_COMPOSITION_TRANSITION_CATEGORIES.length >= 10, 'Expected transition categories to be grouped for the UI.');
  const allTransitions = MEDIA_COMPOSITION_TRANSITION_CATEGORIES.flatMap((category) => category.transitions || []);
  for (const transitionName of ['fade', 'dissolve', 'wipeleft', 'slideleft', 'smoothleft', 'circlecrop', 'hblur', 'zoomin', 'coverleft', 'revealdown', 'radial']) {
    assert(allTransitions.includes(transitionName), 'Expected xfade transition catalog to include ' + transitionName + '.');
  }
}

async function verifySingleSceneTransitionMode() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeNarration: false,
    includeThirdImage: true,
    secondsPerItem: 2,
    stopMode: 'visuals',
    title: 'Single transition storyboard',
    transitionConfig: {
      sceneTransitionDurationSeconds: 0.5,
      sceneTransitionMode: 'single',
      sceneTransitionName: 'fade',
    },
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);

  const visualTrack = getCompositionVisualTrack(completedRun);
  assert.strictEqual(visualTrack?.sceneTransitions?.enabled, true, 'Expected single-transition mode to enable scene transitions.');
  assert.strictEqual(visualTrack.sceneTransitions.boundaries.length, 2, 'Expected three images to produce two transition boundaries.');
  assert(visualTrack.sceneTransitions.boundaries.every((boundary) => boundary.selectedTransition === 'fade'), 'Expected single-transition mode to use fade for every boundary.');
  assert(visualTrack.sceneTransitions.boundaries.every((boundary) => boundary.effectiveDurationSeconds === 0.5), 'Expected normal-length scenes to keep the configured transition duration.');
  assert.strictEqual(visualTrack.timing.totalVisualDurationSeconds, 6, 'Expected fixed-duration total visual time to remain three images times two seconds.');

  const exportArtifact = getExportArtifact(completedRun);
  assert.strictEqual(exportArtifact?.compositionExport?.visualTrack?.sceneTransitions?.renderEnabled, true, 'Expected Media Export to render the xfade transition chain.');
  assert.strictEqual(exportArtifact.compositionExport.visualTrack.sceneTransitions.boundaries[0].selectedTransition, 'fade', 'Expected export metadata to carry the selected transition.');
  assert.strictEqual(exportArtifact.compositionExport.visualTrack.totalVisualDurationSeconds, 6, 'Expected export metadata to preserve fixed visual duration.');
  assert.strictEqual(exportArtifact.compositionExport.exportProfile.concatManifestPath, null, 'Expected transition renders to bypass the no-transition concat manifest path.');
}

async function verifyRandomCategorySceneTransitions() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeNarration: false,
    includeThirdImage: true,
    secondsPerItem: 1,
    stopMode: 'visuals',
    title: 'Random category transition storyboard',
    transitionConfig: {
      sceneTransitionCategory: 'wipes',
      sceneTransitionDurationSeconds: 0.4,
      sceneTransitionMode: 'randomCategory',
    },
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);
  const visualTrack = getCompositionVisualTrack(completedRun);
  const wipeTransitions = new Set((MEDIA_COMPOSITION_TRANSITION_CATEGORIES.find((category) => category.id === 'wipes')?.transitions || []));
  assert(visualTrack?.sceneTransitions?.boundaries?.every((boundary) => wipeTransitions.has(boundary.selectedTransition)), 'Expected random category mode to select only wipe transitions.');
}

async function verifyRandomSelectedTransitionsAndClamping() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeNarration: false,
    includeThirdImage: true,
    secondsPerItem: 0.2,
    stopMode: 'visuals',
    title: 'Selected transition clamp storyboard',
    transitionConfig: {
      sceneTransitionAvoidRepeats: true,
      sceneTransitionDurationSeconds: 0.5,
      sceneTransitionMode: 'randomSelected',
      sceneTransitionSelected: ['fade', 'dissolve'],
    },
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);
  const visualTrack = getCompositionVisualTrack(completedRun);
  const boundaries = visualTrack?.sceneTransitions?.boundaries || [];
  assert.strictEqual(boundaries.length, 2, 'Expected selected-list mode to plan one transition per boundary.');
  assert(boundaries.every((boundary) => ['fade', 'dissolve'].includes(boundary.selectedTransition)), 'Expected selected-list mode to use only checked transitions.');
  assert.notStrictEqual(boundaries[0].selectedTransition, boundaries[1].selectedTransition, 'Expected repeat avoidance to prevent immediate repeats when possible.');
  assert(boundaries.every((boundary) => boundary.effectiveDurationSeconds < boundary.requestedDurationSeconds), 'Expected short scenes to clamp transition durations.');
  assert(boundaries.every((boundary) => boundary.wasClamped === true), 'Expected clamped transition boundaries to record their clamped state.');
  assert.strictEqual(visualTrack.timing.totalVisualDurationSeconds, 0.6, 'Expected clamped transitions to preserve the intended fixed visual duration.');
}

async function verifyDynamicSceneTransitionsPreserveTiming() {
  const assetPaths = await prepareAssets();
  fs.writeFileSync(assetPaths.narration, createWaveBuffer(40));
  const pipeline = buildTimedMediaCompositionPipeline(assetPaths, {
    secondsPerItem: 9,
    transitionConfig: {
      sceneTransitionCategory: 'fades',
      sceneTransitionDurationSeconds: 0.5,
      sceneTransitionMode: 'randomCategory',
    },
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);
  const visualTrack = getCompositionVisualTrack(completedRun, 'timed-compose-scenes');
  assert.strictEqual(visualTrack?.timing?.timingMetadataUsed, true, 'Expected dynamic transition run to keep image timing metadata authoritative.');
  assert.strictEqual(visualTrack.timing.totalVisualDurationSeconds, 40, 'Expected dynamic transition run to preserve narration-aligned duration.');
  assert.strictEqual(visualTrack.sceneTransitions.boundaries.length, 6, 'Expected seven timed images to produce six transition boundaries.');
  const offsets = visualTrack.sceneTransitions.boundaries.map((boundary) => Number(boundary.offsetSeconds));
  assert(offsets.every((offset) => Number.isFinite(offset)), 'Expected dynamic transition offsets to be finite.');
  assert(offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]), 'Expected dynamic transition offsets to increase.');
  assert(offsets.every((offset) => offset >= 0 && offset < 40), 'Expected dynamic transition offsets to stay within the planned duration.');
  const exportArtifact = getExportArtifact(completedRun, 'timed-export-scenes');
  assert.strictEqual(exportArtifact?.compositionExport?.visualTrack?.sceneTransitions?.renderEnabled, true, 'Expected dynamic transition export to render transitions.');
  assert.strictEqual(exportArtifact.compositionExport.visualTrack.totalVisualDurationSeconds, 40, 'Expected dynamic transition export metadata to preserve total visual duration.');
  assert.strictEqual(exportArtifact.compositionExport.visualTrack.sceneTransitions.boundaries.length, 6, 'Expected Media Export metadata to carry every transition boundary.');
  assert(exportArtifact.compositionExport.exportProfile.commandTimeoutMs >= 120000, 'Expected transition-enabled Media Export metadata to record a bounded ffmpeg timeout.');
}

async function verifyDynamicSceneTransitionsClampVariableDurations() {
  const assetPaths = await prepareAssets();
  fs.writeFileSync(assetPaths.narration, createWaveBuffer(40));
  const pipeline = buildTimedMediaCompositionPipeline(assetPaths, {
    secondsPerItem: 9,
    timedDurations: [0.6, 0.8, 7.6, 8, 7, 8, 8],
    transitionConfig: {
      sceneTransitionDurationSeconds: 0.5,
      sceneTransitionMode: 'single',
      sceneTransitionName: 'fade',
    },
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);
  const visualTrack = getCompositionVisualTrack(completedRun, 'timed-compose-scenes');
  const boundaries = visualTrack?.sceneTransitions?.boundaries || [];
  assert.strictEqual(visualTrack?.timing?.timingMetadataUsed, true, 'Expected variable dynamic transition run to keep image timing metadata authoritative.');
  assert.strictEqual(visualTrack.timing.totalVisualDurationSeconds, 40, 'Expected variable dynamic transition run to preserve narration-aligned duration.');
  assert(boundaries.some((boundary) => boundary.wasClamped === true), 'Expected short dynamic scenes to clamp transition durations.');
  assert(boundaries.every((boundary) => Number.isFinite(Number(boundary.offsetSeconds))), 'Expected variable dynamic transition offsets to be finite.');
  assert(boundaries.every((boundary, index) => index === 0 || Number(boundary.offsetSeconds) > Number(boundaries[index - 1].offsetSeconds)), 'Expected variable dynamic transition offsets to increase.');
  assert(boundaries.every((boundary) => Number(boundary.offsetSeconds) >= 0 && Number(boundary.offsetSeconds) < 40), 'Expected variable dynamic transition offsets to stay within the planned duration.');
  const exportArtifact = getExportArtifact(completedRun, 'timed-export-scenes');
  assert.strictEqual(exportArtifact?.compositionExport?.visualTrack?.sceneTransitions?.renderEnabled, true, 'Expected variable dynamic transition export to render transitions.');
  assert.strictEqual(exportArtifact.compositionExport.visualTrack.totalVisualDurationSeconds, 40, 'Expected variable dynamic transition export metadata to preserve total visual duration.');
}

function buildOneImageTransitionPipeline(assetPaths) {
  const collection = createNode('collectionInput', {
    id: 'one-image-transition-collection',
    label: 'One image transition collection',
    config: {
      itemType: 'image',
      items: [{ id: 'only-scene', filePath: assetPaths.imageOne }],
    },
  });
  const composition = createNode('mediaComposition', {
    id: 'one-image-compose-scenes',
    label: 'One image compose scenes',
    config: {
      sceneTransitionDurationSeconds: 0.5,
      sceneTransitionMode: 'single',
      sceneTransitionName: 'fade',
      secondsPerItem: 1,
    },
  });
  const exportNode = createNode('mediaExport', {
    id: 'one-image-export-scenes',
    label: 'One image export scenes',
    config: { title: 'One image transition export', width: 320, height: 180, fps: 12, fitMode: 'contain', stopMode: 'visuals' },
  });
  const output = createNode('videoOutput', {
    id: 'one-image-video-output',
    label: 'One image video output',
    config: { title: 'One image transition final' },
  });
  return createEmptyPipeline({
    id: 'verify-one-image-transition-composition',
    name: 'Verify One Image Transition Composition',
    nodes: [collection, composition, exportNode, output],
    edges: [
      createEdge(collection.id, 'collection', composition.id, 'visuals'),
      createEdge(composition.id, 'composition', exportNode.id, 'composition'),
      createEdge(exportNode.id, 'video', output.id, 'video'),
    ],
  });
}

async function verifyOneImageTransitionCompositionDoesNotFail() {
  const assetPaths = await prepareAssets();
  const pipeline = buildOneImageTransitionPipeline(assetPaths);
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);
  const visualTrack = getCompositionVisualTrack(completedRun, 'one-image-compose-scenes');
  assert.strictEqual(visualTrack?.sceneTransitions?.enabled, false, 'Expected one-image compositions to disable transitions without failing.');
  assert.strictEqual(visualTrack.sceneTransitions.boundaries.length, 0, 'Expected one-image compositions to have no transition boundaries.');
}
async function verifyMediaCompositionWithoutBackgroundMusic() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeBackgroundMusic: false,
    includeNarration: true,
    outputTitle: 'Storyboard export narration only final',
    title: 'Storyboard export narration only',
  });
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected narration-only media composition pipeline to be executable.');

  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);

  const compositionResult = completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition || null;
  assert(compositionResult, 'Expected the narration-only composition node to produce a composition artifact.');
  const compositionManifest = JSON.parse(fs.readFileSync(compositionResult.manifestPath, 'utf8'));
  assert.strictEqual(compositionManifest.trackCount, 2, 'Expected narration-only compositions to keep the existing visual and primary-audio tracks.');

  const exportArtifact = completedRun.resultsByNodeId?.['export-scenes']?.outputs?.video || null;
  assert(exportArtifact?.compositionExport, 'Expected narration-only export metadata to exist.');
  assert.strictEqual(exportArtifact.compositionExport.audioMix?.mode, 'primary-audio-only', 'Expected narration-only exports to preserve the original audio-only behavior.');
  assert.strictEqual(exportArtifact.compositionExport.backgroundMusicTrack, null, 'Expected narration-only exports to omit background music metadata.');
}

async function main() {
  verifyMediaCompositionInspectorFallbackField();
  verifyMediaCompositionTransitionDefaults();
  verifyMediaExportTransitionRenderGuards();
  await cleanupActiveRun();
  await verifyMediaCompositionWithBackgroundMusic();
  await cleanupActiveRun();
  await verifyMediaCompositionCustomMixLevels();
  await cleanupActiveRun();
  await verifyDirectMediaCompositionValidationDoesNotExposeRetryControls();
  await cleanupActiveRun();
  await verifyMediaCompositionRetryOverrides();
  await cleanupActiveRun();
  await verifyMediaCompositionRetryWithoutOverridesUsesSavedConfig();
  await cleanupActiveRun();
  await verifyDynamicMediaCompositionTiming();
  await cleanupActiveRun();
  await verifyDynamicMediaCompositionFallback();
  await cleanupActiveRun();
  await verifySingleSceneTransitionMode();
  await cleanupActiveRun();
  await verifyRandomCategorySceneTransitions();
  await cleanupActiveRun();
  await verifyRandomSelectedTransitionsAndClamping();
  await cleanupActiveRun();
  await verifyDynamicSceneTransitionsPreserveTiming();
  await cleanupActiveRun();
  await verifyDynamicSceneTransitionsClampVariableDurations();
  await cleanupActiveRun();
  await verifyOneImageTransitionCompositionDoesNotFail();
  await cleanupActiveRun();
  await verifyMediaCompositionWithoutBackgroundMusic();
  await cleanupActiveRun();
  console.log('Pipeline media composition verification passed.');
}

main().catch(async (error) => {
  await cleanupActiveRun();
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
