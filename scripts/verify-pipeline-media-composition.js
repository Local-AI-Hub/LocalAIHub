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
  DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS,
  DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS,
  DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME,
  MEDIA_COMPOSITION_TRANSITION_CATEGORIES,
  MEDIA_COMPOSITION_UNSTABLE_XFADE_TRANSITIONS,
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
const {
  createAssetLibrary,
  importAssetLibraryItems,
  listAssetLibraries,
} = require('../electron/services/assetLibraryService');

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
      ...(options.imageTimingMode ? { imageTimingMode: options.imageTimingMode } : {}),
      ...(options.narrationVolume !== undefined ? { narrationVolume: options.narrationVolume } : {}),
      ...(options.backgroundMusicVolume !== undefined ? { backgroundMusicVolume: options.backgroundMusicVolume } : {}),
      ...(options.transitionConfig && typeof options.transitionConfig === 'object' ? options.transitionConfig : {}),
      ...(options.soundEffectsConfig && typeof options.soundEffectsConfig === 'object' ? options.soundEffectsConfig : {}),
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
      ...(options.soundEffectsConfig && typeof options.soundEffectsConfig === 'object' ? options.soundEffectsConfig : {}),
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
    includeThirdImage: options.includeThirdImage === true,
    imageTimingMode: options.imageTimingMode,
    outputTitle: options.outputTitle || 'Storyboard retry final',
    secondsPerItem: options.secondsPerItem,
    soundEffectsConfig: options.soundEffectsConfig,
    title: options.title || 'Storyboard retry export',
    transitionConfig: options.transitionConfig,
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
  const assetRoot = path.join(TEST_STORAGE_ROOT, 'fixtures', 'case-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
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

async function prepareSoundEffectsLibrary(assetPaths, name = 'Verify SFX', filenames = ['impact.wav', 'swell.wav'], durations = [0.75, 2.5]) {
  const existing = await listAssetLibraries('soundEffects');
  const shouldReuse = arguments.length < 4;
  const reusable = shouldReuse
    ? existing.find((library) => String(library.name || '') === name && Array.isArray(library.items) && library.items.length >= 2)
    : null;
  if (reusable) {
    return reusable;
  }
  const created = await createAssetLibrary('soundEffects', name);
  const sourceOne = path.join(path.dirname(assetPaths.narration), filenames[0] || 'impact.wav');
  const sourceTwo = path.join(path.dirname(assetPaths.narration), filenames[1] || 'swell.wav');
  fs.writeFileSync(sourceOne, createWaveBuffer(Array.isArray(durations) ? durations[0] ?? 0.75 : 0.75));
  fs.writeFileSync(sourceTwo, createWaveBuffer(Array.isArray(durations) ? durations[1] ?? 2.5 : 2.5));
  const imported = await importAssetLibraryItems('soundEffects', created.library.id, [sourceOne, sourceTwo]);
  return imported.library;
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
  assert.strictEqual(exportArtifact.compositionExport.audioMix?.effectiveGains?.narration, 1, 'Expected export metadata to record unity narration gain at 100%.');
  assert.strictEqual(exportArtifact.compositionExport.audioMix?.effectiveGains?.backgroundMusic, 0.22, 'Expected export metadata to record source-relative background music gain.');
  assert.strictEqual(exportArtifact.compositionExport.audioMix?.amixNormalize, false, 'Expected export metadata to record that amix normalization is disabled.');
  assert.strictEqual(exportArtifact.compositionExport.audioMix?.limiterApplied, false, 'Expected export metadata to record no hidden limiter.');
  assert.strictEqual(exportArtifact.compositionExport.audioMix?.clippingPreventionApplied, false, 'Expected export metadata to record no hidden clipping prevention.');
}

async function verifyMediaCompositionCustomMixLevels() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    backgroundMusicVolume: 0.22,
    includeBackgroundMusic: true,
    includeNarration: true,
    narrationVolume: 1.8,
    outputTitle: 'Storyboard export custom mix final',
    title: 'Storyboard export custom mix',
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);

  const compositionResult = completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition || null;
  assert.strictEqual(compositionResult?.composition?.audioMix?.narrationVolume, 1.8, 'Expected composition metadata to preserve selected narration level.');
  assert.strictEqual(compositionResult?.composition?.audioMix?.backgroundMusicVolume, 0.22, 'Expected composition metadata to preserve selected background music level.');
  assert.strictEqual(compositionResult?.composition?.audioMix?.gainStaging?.effectiveGains?.narration, 1.8, 'Expected composition metadata to record 180% as 1.8x source gain.');
  assert.strictEqual(compositionResult?.composition?.audioMix?.gainStaging?.effectiveGains?.backgroundMusic, 0.22, 'Expected composition metadata to record 22% as 0.22x source gain.');

  const exportArtifact = completedRun.resultsByNodeId?.['export-scenes']?.outputs?.video || null;
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.narrationVolume, 1.8, 'Expected export metadata to preserve selected narration level.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.backgroundMusicVolume, 0.22, 'Expected export metadata to preserve selected background music level.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.effectiveGains?.narration, 1.8, 'Expected export metadata to record 180% as 1.8x source gain.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.effectiveGains?.backgroundMusic, 0.22, 'Expected export metadata to record 22% as 0.22x source gain.');
  assert(/background music at 22% and narration at 180%/.test(completedRun.nodeStates?.['export-scenes']?.message || ''), 'Expected export status message to reflect selected mix levels.');
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
  const library = await prepareSoundEffectsLibrary(assetPaths, 'Verify Retry SFX ' + Date.now(), ['retry-hit.wav', 'retry-swell.wav'], [0.4, 0.4]);
  const savedLayer = {
    avoidRepeats: true,
    density: 'sparse',
    fadeSeconds: 0.05,
    id: 'retry-layer',
    libraryId: library.id,
    maxSimultaneous: 1,
    minSpacingSeconds: 0.25,
    name: 'Retry layer',
    schedulingMode: 'sceneAligned',
    seed: 'verify-retry-sfx',
    volume: 0.4,
  };
  const pipeline = buildMediaCompositionValidationRetryPipeline(assetPaths, {
    id: 'verify-pipeline-media-composition-retry-overrides',
    includeThirdImage: true,
    imageTimingMode: 'fixedDurationPerImage',
    name: 'Verify Pipeline Media Composition Retry Overrides',
    outputTitle: 'Storyboard retry override final',
    secondsPerItem: 1.5,
    soundEffectsConfig: {
      soundEffectsEnabled: true,
      soundEffectsGlobalGuardEnabled: false,
      soundEffectsGlobalMaxSimultaneous: 2,
      soundEffectsGlobalMinSpacingSeconds: 0.25,
      soundEffectsGlobalVolume: 1,
      soundEffectsLayers: [savedLayer],
      soundEffectsVolume: 0.4,
    },
    title: 'Storyboard retry override export',
    transitionConfig: {
      sceneTransitionCategory: 'fades',
      sceneTransitionDurationSeconds: 0.5,
      sceneTransitionMode: 'off',
      sceneTransitionName: 'fade',
    },
  });
  const savedCompositionNode = pipeline.nodes.find((node) => node.id === 'compose-scenes');
  assert.strictEqual(savedCompositionNode?.config?.narrationVolume, 1, 'Expected the saved pipeline to start with default narration volume.');
  assert.strictEqual(savedCompositionNode?.config?.backgroundMusicVolume, 0.22, 'Expected the saved pipeline to start with default background music volume.');
  assert.strictEqual(savedCompositionNode.config.secondsPerItem, 1.5, 'Expected saved fallback seconds per image to start unchanged.');
  assert.strictEqual(savedCompositionNode.config.sceneTransitionMode, 'off', 'Expected saved transition mode to start off.');
  assert.strictEqual(savedCompositionNode.config.soundEffectsGlobalVolume, 1, 'Expected saved global SFX gain to start at source volume.');
  assert.strictEqual(savedCompositionNode.config.soundEffectsLayers[0].volume, 0.4, 'Expected saved SFX layer gain to start at 40%.');

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
  const firstControls = firstPause.pendingValidation?.retryControls?.mediaComposition || null;
  assert.strictEqual(firstControls?.nodeId, 'compose-scenes', 'Expected Media Export validation to expose upstream Media Composition retry controls.');
  assert.strictEqual(firstControls.narrationVolume, 1, 'Expected retry controls to start from the effective narration volume.');
  assert.strictEqual(firstControls.backgroundMusicVolume, 0.22, 'Expected retry controls to start from the effective background volume.');
  assert.strictEqual(firstControls.secondsPerItem, 1.5, 'Expected retry controls to expose fallback seconds per image.');
  assert.strictEqual(firstControls.sceneTransitionMode, 'off', 'Expected retry controls to expose transition mode.');
  assert.strictEqual(firstControls.soundEffectsEnabled, true, 'Expected retry controls to expose SFX enabled.');
  assert.strictEqual(firstControls.soundEffectsGlobalGuardEnabled, false, 'Expected retry controls to expose global SFX guard.');
  assert.strictEqual(firstControls.soundEffectsGlobalMinSpacingSeconds, 0.25, 'Expected retry controls to expose global SFX spacing.');
  assert.strictEqual(firstControls.soundEffectsGlobalMaxSimultaneous, 2, 'Expected retry controls to expose global max simultaneous SFX.');
  assert.strictEqual(firstControls.soundEffectsGlobalVolume, 1, 'Expected retry controls to expose global SFX gain.');
  assert.strictEqual(firstControls.soundEffectsLayers?.[0]?.volume, 0.4, 'Expected retry controls to expose per-layer SFX gain.');

  resumePipelineValidation(firstPause.runId, {
    decision: 'fail',
    nodeId: firstPause.pendingValidation.nodeId,
    requestId: firstPause.pendingValidation.requestId,
    retryOverrides: {
      mediaComposition: {
        backgroundMusicVolume: 0.11,
        imageTimingMode: 'fixedDurationPerImage',
        narrationVolume: 0.55,
        sceneTransitionCategory: 'fades',
        sceneTransitionDurationSeconds: 0.3,
        sceneTransitionMode: 'single',
        sceneTransitionName: 'fade',
        secondsPerItem: 2.25,
        soundEffectsEnabled: true,
        soundEffectsGlobalGuardEnabled: true,
        soundEffectsGlobalMaxSimultaneous: 1,
        soundEffectsGlobalMinSpacingSeconds: 0.75,
        soundEffectsGlobalVolume: 0.5,
        soundEffectsLayers: firstControls.soundEffectsLayers.map((layer) => ({ ...layer, volume: 0.3 })),
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
  const retriedComposition = secondPause.nodeStates?.['compose-scenes']?.outputs?.composition?.composition || null;
  const retriedVisualTrack = retriedComposition?.tracks?.find((track) => track.role === 'primary-visual') || null;
  const retriedSoundEffects = retriedComposition?.soundEffects || null;
  const retriedExport = secondPause.nodeStates?.['export-scenes']?.outputs?.video?.compositionExport || null;
  assert.strictEqual(retriedComposition?.audioMix?.narrationVolume, 0.55, 'Expected retry override narration volume to affect the retried composition artifact.');
  assert.strictEqual(retriedComposition?.audioMix?.backgroundMusicVolume, 0.11, 'Expected retry override background music volume to affect the retried composition artifact.');
  assert.strictEqual(retriedComposition?.audioMix?.soundEffectsVolume, 0.5, 'Expected retry override global SFX gain to affect the retried composition artifact.');
  assert.strictEqual(retriedSoundEffects?.layers?.[0]?.volume, 0.3, 'Expected retry override per-layer SFX gain to affect the retried composition artifact.');
  assert.strictEqual(retriedSoundEffects?.globalGuard?.enabled, true, 'Expected retry override global SFX guard to affect the retried composition artifact.');
  assert.strictEqual(retriedSoundEffects?.globalGuard?.minSpacingSeconds, 0.75, 'Expected retry override global SFX spacing to affect the retried composition artifact.');
  assert.strictEqual(retriedSoundEffects?.globalGuard?.maxSimultaneous, 1, 'Expected retry override global SFX max simultaneous to affect the retried composition artifact.');
  assert.strictEqual(retriedVisualTrack?.timing?.fixedDurationSeconds, 2.25, 'Expected retry override fallback seconds per image to affect the retried composition artifact.');
  assert.strictEqual(retriedVisualTrack?.sceneTransitions?.enabled, true, 'Expected retry override transition mode to enable transitions for the retried composition artifact.');
  assert.strictEqual(retriedVisualTrack?.sceneTransitions?.boundaries?.[0]?.selectedTransition, 'fade', 'Expected retry override transition name to affect the retried composition artifact.');
  assert.strictEqual(retriedVisualTrack?.sceneTransitions?.boundaries?.[0]?.effectiveDurationSeconds, 0.3, 'Expected retry override transition duration to affect the retried composition artifact.');
  assert.strictEqual(retriedExport?.audioMix?.narrationVolume, 0.55, 'Expected retry override narration volume to affect the retried export artifact.');
  assert.strictEqual(retriedExport?.audioMix?.backgroundMusicVolume, 0.11, 'Expected retry override background music volume to affect the retried export artifact.');
  assert.strictEqual(retriedExport?.audioMix?.soundEffectsGlobalVolume, 0.5, 'Expected retry override global SFX gain to affect export metadata.');
  assert.strictEqual(retriedExport?.soundEffects?.layers?.[0]?.volume, 0.3, 'Expected retry override per-layer SFX gain to affect export metadata.');
  assert.strictEqual(retriedExport?.soundEffects?.scheduledEvents?.[0]?.effectiveGain, 0.15, 'Expected export metadata to record global times layer SFX effective gain.');
  assert.strictEqual(secondPause.pendingValidation?.artifact?.compositionExport?.audioMix?.narrationVolume, 0.55, 'Expected validation preview artifact to carry retried narration volume.');
  assert.strictEqual(secondPause.pendingValidation?.artifact?.compositionExport?.audioMix?.backgroundMusicVolume, 0.11, 'Expected validation preview artifact to carry retried background volume.');
  const secondControls = secondPause.pendingValidation?.retryControls?.mediaComposition || null;
  assert.strictEqual(secondControls?.narrationVolume, 0.55, 'Expected second review controls to show the retried narration volume.');
  assert.strictEqual(secondControls?.backgroundMusicVolume, 0.11, 'Expected second review controls to show the retried background volume.');
  assert.strictEqual(secondControls?.secondsPerItem, 2.25, 'Expected second review controls to show retried fallback seconds per image.');
  assert.strictEqual(secondControls?.sceneTransitionMode, 'single', 'Expected second review controls to show retried transition mode.');
  assert.strictEqual(secondControls?.soundEffectsGlobalVolume, 0.5, 'Expected second review controls to show retried global SFX gain.');
  assert.strictEqual(secondControls?.soundEffectsLayers?.[0]?.volume, 0.3, 'Expected second review controls to show retried per-layer SFX gain.');
  assert(/primary narration at 55% and background music at 11%/.test(secondPause.nodeStates?.['compose-scenes']?.message || ''), 'Expected composition status to show effective retry override values.');
  assert(/background music at 11% and narration at 55%/.test(secondPause.nodeStates?.['export-scenes']?.message || ''), 'Expected export status to show effective retry override values.');
  assert.strictEqual(savedCompositionNode.config.narrationVolume, 1, 'Expected retry override not to mutate saved narration volume.');
  assert.strictEqual(savedCompositionNode.config.backgroundMusicVolume, 0.22, 'Expected retry override not to mutate saved background music volume.');
  assert.strictEqual(savedCompositionNode.config.secondsPerItem, 1.5, 'Expected retry override not to mutate saved fallback seconds per image.');
  assert.strictEqual(savedCompositionNode.config.sceneTransitionMode, 'off', 'Expected retry override not to mutate saved transition mode.');
  assert.strictEqual(savedCompositionNode.config.soundEffectsGlobalGuardEnabled, false, 'Expected retry override not to mutate saved global SFX guard.');
  assert.strictEqual(savedCompositionNode.config.soundEffectsGlobalVolume, 1, 'Expected retry override not to mutate saved global SFX gain.');
  assert.strictEqual(savedCompositionNode.config.soundEffectsLayers[0].volume, 0.4, 'Expected retry override not to mutate saved SFX layer gain.');

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
  assert.strictEqual(compositionResult?.composition?.audioMix?.soundEffectsVolume, 0.5, 'Expected final composition metadata to record effective retry global SFX gain.');
  const compositionManifest = JSON.parse(fs.readFileSync(compositionResult.manifestPath, 'utf8'));
  assert.strictEqual(compositionManifest.composition?.audioMix?.narrationVolume, 0.55, 'Expected composition sidecar to record effective retry narration volume.');
  assert.strictEqual(compositionManifest.composition?.audioMix?.backgroundMusicVolume, 0.11, 'Expected composition sidecar to record effective retry background volume.');
  assert.strictEqual(compositionManifest.composition?.audioMix?.soundEffectsVolume, 0.5, 'Expected composition sidecar to record effective retry global SFX gain.');
  const exportArtifact = completedRun.resultsByNodeId?.['export-scenes']?.outputs?.video || null;
  assert.strictEqual(exportArtifact?.compositionExport?.pipelineTrace?.mediaCompositionNodeId, 'compose-scenes', 'Expected export metadata to keep the upstream Media Composition node id.');
  assert.strictEqual(exportArtifact?.compositionExport?.pipelineTrace?.mediaExportNodeId, 'export-scenes', 'Expected export metadata to keep the Media Export node id.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.narrationVolume, 0.55, 'Expected export metadata to carry retry override narration volume.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.backgroundMusicVolume, 0.11, 'Expected export metadata to carry retry override background volume.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.soundEffectsGlobalVolume, 0.5, 'Expected export metadata to carry retry override global SFX gain.');
  assert.strictEqual(exportArtifact?.compositionExport?.soundEffects?.scheduledEvents?.[0]?.effectiveGain, 0.15, 'Expected final export metadata to carry effective retry SFX gain.');
  const exportSidecar = JSON.parse(fs.readFileSync(exportArtifact.metadataPaths[0], 'utf8'));
  assert.strictEqual(exportSidecar.pipelineTrace?.mediaCompositionNodeId, 'compose-scenes', 'Expected export sidecar to keep the upstream Media Composition node id.');
  assert.strictEqual(exportSidecar.audioMix?.narrationVolume, 0.55, 'Expected export sidecar to record effective retry narration volume.');
  assert.strictEqual(exportSidecar.audioMix?.backgroundMusicVolume, 0.11, 'Expected export sidecar to record effective retry background volume.');
  assert.strictEqual(exportSidecar.audioMix?.soundEffectsGlobalVolume, 0.5, 'Expected export sidecar to record effective retry global SFX gain.');
  assert.strictEqual(exportSidecar.soundEffects?.scheduledEvents?.[0]?.effectiveGain, 0.15, 'Expected export sidecar to record effective retry SFX gain.');
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

function verifyMediaCompositionSoundEffectsDefaultsAndUi() {
  const definition = getNodeTypeDefinition('mediaComposition');
  assert.strictEqual(definition.configDefaults.soundEffectsEnabled, false, 'Media Composition should default sound effects off.');
  assert(Array.isArray(definition.configDefaults.soundEffectsLayers), 'Media Composition should default SFX layers to an array.');
  assert.strictEqual(definition.configDefaults.soundEffectsLayers.length, 0, 'Media Composition should default to no SFX layers.');
  assert.strictEqual(definition.configDefaults.soundEffectsVolume, DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME, 'Media Composition should default sound effects volume conservatively.');
  assert.strictEqual(definition.configDefaults.soundEffectsSchedulingMode, 'randomInterval', 'Media Composition should default to random interval SFX scheduling.');
  assert.strictEqual(definition.configDefaults.soundEffectsGlobalGuardEnabled, false, 'Media Composition should keep cross-layer SFX guards off by default for saved-project compatibility.');
  assert.strictEqual(definition.configDefaults.soundEffectsGlobalMinSpacingSeconds, DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MIN_SPACING_SECONDS, 'Media Composition should default global SFX spacing conservatively when enabled.');
  assert.strictEqual(definition.configDefaults.soundEffectsGlobalMaxSimultaneous, DEFAULT_MEDIA_COMPOSITION_GLOBAL_SOUND_EFFECTS_MAX_SIMULTANEOUS, 'Media Composition should default global SFX max simultaneous conservatively when enabled.');
  const uiSource = fs.readFileSync(PIPELINE_BUILDER_PANEL_PATH, 'utf8');
  assert(/media-composition-sfx-enabled/.test(uiSource), 'Expected the Media Composition inspector to expose the SFX enable control.');
  assert(/media-composition-sfx-global-guard/.test(uiSource), 'Expected the Media Composition inspector to expose the global SFX guard control.');
  assert(/media-composition-sfx-global-spacing/.test(uiSource), 'Expected the Media Composition inspector to expose global SFX spacing.');
  assert(/media-composition-sfx-global-simultaneous/.test(uiSource), 'Expected the Media Composition inspector to expose global SFX max simultaneous control.');
  assert(/validation-media-composition-sfx-global-volume/.test(uiSource), 'Expected retry UI to expose global SFX volume.');
  assert(/validation-media-composition-sfx-layer-volume/.test(uiSource), 'Expected retry UI to expose per-layer SFX volumes.');
  assert(/validation-media-composition-image-timing/.test(uiSource), 'Expected retry UI to expose image timing mode.');
  assert(/validation-media-composition-seconds-per-item/.test(uiSource), 'Expected retry UI to expose fallback seconds per image.');
  assert(/validation-media-composition-transition-mode/.test(uiSource), 'Expected retry UI to expose transition settings.');
  assert(/validation-media-composition-sfx-global-spacing/.test(uiSource), 'Expected retry UI to expose global SFX spacing.');
  assert(/Add SFX layer/.test(uiSource), 'Expected the Media Composition inspector to add SFX layers.');
  assert(/soundEffectsLayers/.test(uiSource), 'Expected the Media Composition inspector to write layered SFX config.');
  assert(/media-composition-sfx-library/.test(uiSource), 'Expected the Media Composition inspector to expose the SFX library dropdown.');
  assert(/Settings &gt; Asset Libraries/.test(uiSource), 'Expected the Media Composition inspector to point empty SFX libraries to Settings > Asset Libraries.');
  assert(/listAssetLibraries\?\.\('soundEffects'\)/.test(uiSource), 'Expected the Media Composition inspector to use Asset Library listing IPC.');
  assert(!/soundEffectsFilePath/.test(uiSource), 'Expected SFX controls not to accept arbitrary file paths.');
}

function verifyMediaExportAudioMixVolumeSemantics() {
  const mediaCompositionSource = fs.readFileSync(MEDIA_COMPOSITION_SERVICE_PATH, 'utf8');
  assert(/const MEDIA_COMPOSITION_AMIX_NORMALIZE = 0/.test(mediaCompositionSource), 'Expected Media Export to define amix normalization as disabled.');
  assert(/volume=\$\{formatVolumeFilterValue\(audioPlan\.narrationVolume\)\}\[primary\]/.test(mediaCompositionSource), 'Expected narration volume to map directly to the FFmpeg source gain.');
  assert(/volume=\$\{formatVolumeFilterValue\(audioPlan\.backgroundMusicVolume\)\}\[music\]/.test(mediaCompositionSource), 'Expected background music volume to map directly to the FFmpeg source gain.');
  assert(/volume=\$\{formatVolumeFilterValue\(volume\)\}`/.test(mediaCompositionSource), 'Expected SFX layer volume to map directly to the FFmpeg source gain.');
  assert(/getSoundEffectEffectiveGain\(event, audioPlan\.soundEffectsVolume\)/.test(mediaCompositionSource), 'Expected SFX export filters to use global times layer effective gain.');
  assert(/normalizeAudioVolume\(globalVolume, 1\)/.test(mediaCompositionSource), 'Expected missing global SFX gain to default to source volume.');
  assert(/audioMix\.soundEffectsVolume \?\? primaryConfigured\?\.globalVolume \?\? 1/.test(mediaCompositionSource), 'Expected export audio plan to avoid legacy layer gain as global gain.');
  assert(/amix=inputs=\$\{audioMixLabels\.length\}:duration=longest:dropout_transition=2:normalize=\$\{MEDIA_COMPOSITION_AMIX_NORMALIZE\}/.test(mediaCompositionSource), 'Expected amix normalization to be explicit and disabled.');
  assert(/amixNormalizeExplicit: true/.test(mediaCompositionSource), 'Expected export metadata to record explicit amix normalization behavior.');
  assert(/sourceRelative: true/.test(mediaCompositionSource), 'Expected export metadata to record source-relative gain staging.');
  assert(/limiterApplied: false/.test(mediaCompositionSource), 'Expected export metadata to avoid hidden limiter behavior.');
}

function assertSoundEffectSpacing(events, minSpacingSeconds) {
  for (let index = 1; index < events.length; index += 1) {
    assert(Number(events[index].timeSeconds) - Number(events[index - 1].timeSeconds) >= minSpacingSeconds - 0.001, 'Expected sound effect scheduling to respect minimum spacing.');
  }
}

function assertNoImmediateSoundEffectRepeats(events) {
  for (let index = 1; index < events.length; index += 1) {
    assert.notStrictEqual(events[index].itemId, events[index - 1].itemId, 'Expected sound effect scheduling to avoid immediate repeats when possible.');
  }
}

function getSoundEffectDurationSeconds(event) {
  return Math.max(0.05, Number(event?.durationSeconds || 0) || 0.5);
}

function assertNoSoundEffectOverlaps(events) {
  for (let leftIndex = 0; leftIndex < events.length; leftIndex += 1) {
    const left = events[leftIndex];
    const leftStart = Number(left.timeSeconds || 0) || 0;
    const leftEnd = leftStart + getSoundEffectDurationSeconds(left);
    for (let rightIndex = leftIndex + 1; rightIndex < events.length; rightIndex += 1) {
      const right = events[rightIndex];
      const rightStart = Number(right.timeSeconds || 0) || 0;
      const rightEnd = rightStart + getSoundEffectDurationSeconds(right);
      assert(leftEnd <= rightStart + 0.001 || rightEnd <= leftStart + 0.001, 'Expected global SFX guard to prevent cross-layer overlaps.');
    }
  }
}

async function verifySoundEffectsSchedulingAndExportMetadata() {
  const assetPaths = await prepareAssets();
  const library = await prepareSoundEffectsLibrary(assetPaths);
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeBackgroundMusic: false,
    includeNarration: false,
    includeThirdImage: true,
    secondsPerItem: 3,
    stopMode: 'visuals',
    title: 'Sound effects storyboard export',
    outputTitle: 'Sound effects storyboard final',
    soundEffectsConfig: {
      soundEffectsAvoidRepeats: true,
      soundEffectsDensity: 'dense',
      soundEffectsEnabled: true,
      soundEffectsFadeSeconds: 0.05,
      soundEffectsLibraryId: library.id,
      soundEffectsMaxSimultaneous: 1,
      soundEffectsMinSpacingSeconds: 0.5,
      soundEffectsSchedulingMode: 'both',
      soundEffectsSeed: 'verify-sfx-both',
      soundEffectsVolume: 0.3,
    },
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);

  const compositionResult = completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition || null;
  const soundEffects = compositionResult?.composition?.soundEffects || null;
  assert.strictEqual(soundEffects?.enabled, true, 'Expected sound effects to be enabled in composition metadata.');
  assert.strictEqual(soundEffects.layerCount, 1, 'Expected legacy single-library SFX config to normalize to one layer.');
  assert.strictEqual(soundEffects.layers?.[0]?.libraryId, library.id, 'Expected the selected Sound Effects library id in layer metadata.');
  assert.strictEqual(soundEffects.layers?.[0]?.libraryName, library.name, 'Expected the selected Sound Effects library name in layer metadata.');
  assert.strictEqual(soundEffects.layers?.[0]?.schedulingMode, 'both', 'Expected both scheduling mode in layer metadata.');
  assert.strictEqual(soundEffects.layers?.[0]?.volume, 0.3, 'Expected 30% legacy SFX volume to normalize as layer gain.');
  assert(soundEffects.scheduledEvents.length >= 2, 'Expected scheduled SFX events.');
  assert(soundEffects.scheduledEvents.every((event) => event.layerId && Number(event.layerIndex) === 0), 'Expected scheduled SFX events to record layer identity.');
  assert(soundEffects.scheduledEvents.some((event) => event.reason === 'sceneAligned'), 'Expected a scene-aligned SFX event.');
  assert(soundEffects.scheduledEvents.some((event) => event.reason === 'randomInterval'), 'Expected a random interval SFX event.');
  assert(soundEffects.scheduledEvents.every((event) => Number(event.timeSeconds) > 0 && Number(event.timeSeconds) < 9), 'Expected SFX events to stay inside the visual duration and avoid time zero.');
  assert(soundEffects.scheduledEvents.every((event) => !event.filePath), 'Expected composition metadata not to expose managed file paths.');
  assertSoundEffectSpacing(soundEffects.scheduledEvents, 0.5);
  assertNoImmediateSoundEffectRepeats(soundEffects.scheduledEvents);
  assert.strictEqual(compositionResult.composition.audioMix.soundEffectsVolume, 1, 'Expected composition audio mix to keep global SFX gain at source volume by default.');
  assert.strictEqual(soundEffects.globalGuard?.enabled, false, 'Expected legacy single-layer SFX behavior to leave the global guard disabled.');

  const exportArtifact = getExportArtifact(completedRun);
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.soundEffectsVolume, 1, 'Expected Media Export metadata to carry global SFX gain at source volume by default.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.effectiveGains?.soundEffects, 1, 'Expected Media Export metadata to record global SFX source-relative gain.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.soundEffectsGlobalVolume, 1, 'Expected Media Export metadata to separate global SFX gain.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.effectiveGains?.soundEffectsEvents?.[0]?.effectiveGain, 0.3, 'Expected 30% SFX layer volume to map to 0.3 effective source gain.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.effectiveGains?.soundEffectsEvents?.[0]?.layerGain, 0.3, 'Expected SFX event gain metadata to record layer gain.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.effectiveGains?.soundEffectsEvents?.[0]?.globalGain, 1, 'Expected SFX event gain metadata to record global gain.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.soundEffectsGlobalGuardEnabled, false, 'Expected Media Export metadata to record disabled global SFX guard.');
  assert.strictEqual(exportArtifact.compositionExport.audioMix.soundEffectsEventCount, soundEffects.scheduledEvents.length, 'Expected Media Export audio mix to count scheduled SFX events.');
  assert.strictEqual(exportArtifact.compositionExport.audioMix.soundEffectsLayerCount, 1, 'Expected Media Export audio mix to count SFX layers.');
  assert.strictEqual(exportArtifact.compositionExport.soundEffects?.enabled, true, 'Expected Media Export metadata to carry SFX summary.');
  assert.strictEqual(exportArtifact.compositionExport.soundEffects.layers?.length, 1, 'Expected Media Export metadata to carry per-layer SFX summary.');
  assert.strictEqual(exportArtifact.compositionExport.soundEffects.layers?.[0]?.effectiveVolume, 0.3, 'Expected SFX layer metadata to record effective gain.');
  assert.strictEqual(exportArtifact.compositionExport.soundEffects.scheduledEvents?.[0]?.effectiveGain, 0.3, 'Expected SFX event metadata to record effective gain.');
  assert(exportArtifact.compositionExport.soundEffects.scheduledEvents.every((event) => !event.filePath), 'Expected Media Export metadata not to expose managed file paths.');
  const exportSidecar = JSON.parse(fs.readFileSync(exportArtifact.metadataPaths[0], 'utf8'));
  assert.strictEqual(exportSidecar.soundEffects?.scheduledEvents?.length, soundEffects.scheduledEvents.length, 'Expected export sidecar to record the SFX schedule.');
}

function verifyFailedRunXfadeFallbackCoverage() {
  const mediaCompositionSource = fs.readFileSync(MEDIA_COMPOSITION_SERVICE_PATH, 'utf8');
  const pipelineExecutionSource = fs.readFileSync(PIPELINE_EXECUTION_SERVICE_PATH, 'utf8');
  assert(MEDIA_COMPOSITION_UNSTABLE_XFADE_TRANSITIONS.includes('squeezev'), 'Expected the failed-run squeezev transition to be marked unstable.');
  assert(/MEDIA_COMPOSITION_UNSTABLE_XFADE_TRANSITION_SET/.test(pipelineExecutionSource), 'Expected composition scheduling to exclude unstable xfade transitions.');
  assert(/MEDIA_COMPOSITION_UNSTABLE_XFADE_TRANSITIONS/.test(mediaCompositionSource), 'Expected Media Export support detection to exclude unstable xfade transitions.');
  assert(/buildFfmpegFailureMessage/.test(mediaCompositionSource) && /stderrTail/.test(mediaCompositionSource), 'Expected FFmpeg export failures to include useful diagnostic tails.');
}

async function verifyMultipleSoundEffectsLayers() {
  const assetPaths = await prepareAssets();
  const environmentalLibrary = await prepareSoundEffectsLibrary(assetPaths, 'Verify Environmental SFX', ['wind.wav', 'leaves.wav']);
  const accentLibrary = await prepareSoundEffectsLibrary(assetPaths, 'Verify Accent SFX', ['hit.wav', 'whisper.wav']);
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeBackgroundMusic: true,
    includeNarration: true,
    includeThirdImage: true,
    secondsPerItem: 2,
    stopMode: 'visuals',
    title: 'Layered sound effects export',
    outputTitle: 'Layered sound effects final',
    soundEffectsConfig: {
      soundEffectsEnabled: true,
      soundEffectsGlobalVolume: 0.5,
      soundEffectsLayers: [
        {
          avoidRepeats: true,
          density: 'sparse',
          fadeSeconds: 0.05,
          id: 'environment-layer',
          libraryId: environmentalLibrary.id,
          maxSimultaneous: 1,
          minSpacingSeconds: 0.25,
          name: 'Environmental',
          schedulingMode: 'sceneAligned',
          seed: 'verify-layer-scene',
          volume: 0.2,
        },
        {
          avoidRepeats: true,
          density: 'dense',
          fadeSeconds: 0.05,
          id: 'accent-layer',
          libraryId: accentLibrary.id,
          maxSimultaneous: 1,
          minSpacingSeconds: 0.25,
          name: 'Accent',
          schedulingMode: 'randomInterval',
          seed: 'verify-layer-random',
          volume: 0.25,
        },
      ],
    },
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);

  const compositionResult = completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition || null;
  const soundEffects = compositionResult?.composition?.soundEffects || null;
  assert.strictEqual(soundEffects?.enabled, true, 'Expected layered sound effects to be enabled.');
  assert.strictEqual(soundEffects.layers?.length, 2, 'Expected two SFX layers in composition metadata.');
  assert(soundEffects.layers.some((layer) => layer.layerId === 'environment-layer' && layer.schedulingMode === 'sceneAligned'), 'Expected the scene-aligned layer to be recorded.');
  assert(soundEffects.layers.some((layer) => layer.layerId === 'accent-layer' && layer.schedulingMode === 'randomInterval'), 'Expected the random interval layer to be recorded.');
  assert(soundEffects.scheduledEvents.some((event) => event.layerId === 'environment-layer' && event.reason === 'sceneAligned'), 'Expected scene-aligned layer events.');
  assert(soundEffects.scheduledEvents.some((event) => event.layerId === 'accent-layer' && event.reason === 'randomInterval'), 'Expected random interval layer events.');
  assert(soundEffects.scheduledEvents.every((event, index, events) => index === 0 || Number(events[index - 1].timeSeconds) <= Number(event.timeSeconds)), 'Expected combined SFX schedule to be sorted.');
  assert(soundEffects.scheduledEvents.every((event) => !event.filePath), 'Expected layered composition metadata not to expose managed file paths.');

  const exportArtifact = getExportArtifact(completedRun);
  const exportedSoundEffects = exportArtifact?.compositionExport?.soundEffects || null;
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.soundEffectsGlobalVolume, 0.5, 'Expected layered SFX export metadata to record global SFX gain.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.soundEffectsLayerCount, 2, 'Expected Media Export audio mix to record both SFX layers.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.soundEffectsInputCount, soundEffects.scheduledEvents.length, 'Expected each scheduled SFX event to become one FFmpeg audio input.');
  assert.strictEqual(exportedSoundEffects?.layers?.length, 2, 'Expected Media Export metadata to carry both SFX layers.');
  assert(exportedSoundEffects.layers.every((layer) => Array.isArray(layer.scheduledEvents)), 'Expected Media Export metadata to preserve per-layer schedules.');
  const environmentalEvent = exportedSoundEffects.scheduledEvents.find((event) => event.layerId === 'environment-layer');
  const accentEvent = exportedSoundEffects.scheduledEvents.find((event) => event.layerId === 'accent-layer');
  assert.strictEqual(environmentalEvent?.gain?.globalGain, 0.5, 'Expected layered SFX metadata to record global gain.');
  assert.strictEqual(environmentalEvent?.gain?.layerGain, 0.2, 'Expected layered SFX metadata to record layer gain.');
  assert.strictEqual(environmentalEvent?.effectiveGain, 0.1, 'Expected layered SFX effective gain to equal global times layer gain.');
  assert.strictEqual(accentEvent?.effectiveGain, 0.125, 'Expected second layered SFX effective gain to equal global times layer gain.');
  assert(exportedSoundEffects.scheduledEvents.every((event) => !event.filePath), 'Expected layered export metadata not to expose managed file paths.');
}

async function verifyGlobalSoundEffectsGuard() {
  const assetPaths = await prepareAssets();
  const sceneLibrary = await prepareSoundEffectsLibrary(assetPaths, 'Verify Scene Guard SFX ' + Date.now(), ['scene-hit.wav', 'scene-snap.wav'], [0.4, 0.4]);
  const randomLibrary = await prepareSoundEffectsLibrary(assetPaths, 'Verify Random Guard SFX ' + Date.now(), ['ambience-one.wav', 'ambience-two.wav'], [0.75, 0.75]);
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeBackgroundMusic: false,
    includeNarration: false,
    includeThirdImage: true,
    secondsPerItem: 2,
    stopMode: 'visuals',
    title: 'Guarded layered sound effects export',
    outputTitle: 'Guarded layered sound effects final',
    soundEffectsConfig: {
      soundEffectsEnabled: true,
      soundEffectsGlobalGuardEnabled: true,
      soundEffectsGlobalMaxSimultaneous: 1,
      soundEffectsGlobalMinSpacingSeconds: 0.5,
      soundEffectsLayers: [
        {
          avoidRepeats: false,
          density: 'dense',
          fadeSeconds: 0.05,
          id: 'scene-priority-layer',
          libraryId: sceneLibrary.id,
          maxSimultaneous: 8,
          minSpacingSeconds: 0,
          name: 'Scene Priority',
          schedulingMode: 'sceneAligned',
          seed: 'scene-priority-fixed',
          volume: 0.3,
        },
        {
          avoidRepeats: false,
          density: 'dense',
          fadeSeconds: 0.05,
          id: 'random-ambience-layer',
          libraryId: randomLibrary.id,
          maxSimultaneous: 8,
          minSpacingSeconds: 0,
          name: 'Random Ambience',
          schedulingMode: 'randomInterval',
          seed: 'short-4',
          volume: 0.2,
        },
      ],
    },
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);

  const compositionResult = completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition || null;
  const soundEffects = compositionResult?.composition?.soundEffects || null;
  assert.strictEqual(soundEffects?.enabled, true, 'Expected guarded SFX to be enabled.');
  assert.strictEqual(soundEffects.globalGuard?.enabled, true, 'Expected composition metadata to record enabled global SFX guard.');
  assert.strictEqual(soundEffects.globalGuard?.minSpacingSeconds, 0.5, 'Expected composition metadata to record global SFX spacing.');
  assert.strictEqual(soundEffects.globalGuard?.maxSimultaneous, 1, 'Expected composition metadata to record global SFX max simultaneous.');
  assert(soundEffects.scheduledEvents.some((event) => event.layerId === 'scene-priority-layer' && event.reason === 'sceneAligned'), 'Expected scene-aligned events to survive the global guard.');
  assert(soundEffects.scheduledEvents.some((event) => event.layerId === 'random-ambience-layer' && event.reason === 'randomInterval') || Number(soundEffects.globalGuard?.skippedEventCount || 0) > 0, 'Expected random events to be moved or skipped by the global guard.');
  assert(Number(soundEffects.globalGuard?.movedEventCount || 0) + Number(soundEffects.globalGuard?.skippedEventCount || 0) >= 1, 'Expected the forced random/scene collision to produce global guard metadata.');
  assert(soundEffects.globalGuard.collisionNotes?.some((note) => note.reason === 'randomInterval' && ['moved', 'skipped'].includes(note.action)), 'Expected global guard collision notes for random SFX.');
  assert(soundEffects.scheduledEvents.some((event) => event.layerId === 'scene-priority-layer' && Math.abs(Number(event.timeSeconds || 0) - 4) < 0.001 && !event.movedByGlobalGuard), 'Expected scene-aligned SFX at the transition to keep priority.');
  assertSoundEffectSpacing(soundEffects.scheduledEvents, 0.5);
  assertNoSoundEffectOverlaps(soundEffects.scheduledEvents);

  const exportArtifact = getExportArtifact(completedRun);
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.soundEffectsGlobalGuardEnabled, true, 'Expected export metadata to record enabled global SFX guard.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.soundEffectsGlobalMovedEventCount, soundEffects.globalGuard.movedEventCount, 'Expected export audio mix to record moved SFX count.');
  assert.strictEqual(exportArtifact?.compositionExport?.audioMix?.soundEffectsGlobalSkippedEventCount, soundEffects.globalGuard.skippedEventCount, 'Expected export audio mix to record skipped SFX count.');
  assert.strictEqual(exportArtifact?.compositionExport?.soundEffects?.globalGuard?.enabled, true, 'Expected export soundEffects metadata to carry the global guard.');
  assertNoSoundEffectOverlaps(exportArtifact.compositionExport.soundEffects.scheduledEvents || []);
}
async function verifySoundEffectsTrimNearEnd() {
  const assetPaths = await prepareAssets();
  const created = await createAssetLibrary('soundEffects', 'Verify Long SFX');
  const sourcePath = path.join(path.dirname(assetPaths.narration), 'long-effect.wav');
  fs.writeFileSync(sourcePath, createWaveBuffer(3));
  const imported = await importAssetLibraryItems('soundEffects', created.library.id, [sourcePath]);
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeBackgroundMusic: false,
    includeNarration: false,
    secondsPerItem: 1,
    stopMode: 'visuals',
    title: 'Trimmed sound effects export',
    outputTitle: 'Trimmed sound effects final',
    soundEffectsConfig: {
      soundEffectsEnabled: true,
      soundEffectsLibraryId: imported.library.id,
      soundEffectsMinSpacingSeconds: 0,
      soundEffectsSchedulingMode: 'sceneAligned',
      soundEffectsSeed: 'verify-trim-sfx',
      soundEffectsVolume: 0.25,
    },
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);
  const exportArtifact = getExportArtifact(completedRun);
  const events = exportArtifact?.compositionExport?.soundEffects?.scheduledEvents || [];
  assert(events.some((event) => event.trimmed === true), 'Expected SFX near the end to be trimmed in export metadata.');
  assert(events.every((event) => Number(event.timeSeconds || 0) + Number(event.durationSeconds || 0) <= 2.001), 'Expected trimmed SFX not to extend the visual duration.');
}

async function verifyMissingSoundEffectsLibrarySkipsClearly() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionPipeline(assetPaths, {
    includeBackgroundMusic: false,
    includeNarration: false,
    secondsPerItem: 1,
    stopMode: 'visuals',
    soundEffectsConfig: {
      soundEffectsEnabled: true,
      soundEffectsLibraryId: 'missing-sfx-library',
      soundEffectsSchedulingMode: 'randomInterval',
    },
  });
  const completedRun = await runAndWaitForPipeline(pipeline);
  verifyCompletedRun(completedRun);
  const soundEffects = completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition?.composition?.soundEffects || null;
  assert.strictEqual(soundEffects?.enabled, true, 'Expected missing-library metadata to preserve that SFX were requested.');
  assert.strictEqual(soundEffects.scheduledEvents.length, 0, 'Expected missing SFX library to produce no scheduled events.');
  assert(/could not find the selected Sound Effects library/i.test(soundEffects.notes.join(' ')), 'Expected a clear missing-library note.');
}

function verifySoundEffectsPathSafetyImplementation() {
  const mediaCompositionSource = fs.readFileSync(MEDIA_COMPOSITION_SERVICE_PATH, 'utf8');
  const pipelineExecutionSource = fs.readFileSync(PIPELINE_EXECUTION_SERVICE_PATH, 'utf8');
  assert(/resolveAssetLibraryPreviewFile\('soundEffects'/.test(mediaCompositionSource), 'Expected Media Export to resolve SFX through the managed asset library service.');
  assert(/resolveAssetLibraryPreviewFile\('soundEffects'/.test(pipelineExecutionSource), 'Expected Media Composition to validate SFX through the managed asset library service.');
  assert(/const \{ filePath, \.\.\.safeEvent \}/.test(mediaCompositionSource), 'Expected SFX export metadata to strip managed file paths.');
}

async function main() {
  verifyMediaCompositionInspectorFallbackField();
  verifyMediaCompositionTransitionDefaults();
  verifyMediaCompositionSoundEffectsDefaultsAndUi();
  verifyMediaExportAudioMixVolumeSemantics();
  verifyMediaExportTransitionRenderGuards();
  verifySoundEffectsPathSafetyImplementation();
  verifyFailedRunXfadeFallbackCoverage();
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
  await verifySoundEffectsSchedulingAndExportMetadata();
  await cleanupActiveRun();
  await verifyMultipleSoundEffectsLayers();
  await cleanupActiveRun();
  await verifyGlobalSoundEffectsGuard();
  await cleanupActiveRun();
  await verifySoundEffectsTrimNearEnd();
  await cleanupActiveRun();
  await verifyMissingSoundEffectsLibrarySkipsClearly();
  await cleanupActiveRun();
  console.log('Pipeline media composition verification passed.');
}

main().catch(async (error) => {
  await cleanupActiveRun();
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
