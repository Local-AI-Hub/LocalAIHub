const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-pipeline-media-composition');

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
  analyzePipeline,
  createEdge,
  createEmptyPipeline,
  createNode,
} = require('../electron/shared/pipelineSchema.cjs');
const {
  cancelPipelineRun,
  getActiveRunSnapshot,
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

function buildMediaCompositionPipeline(assetPaths) {
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
  const audio = createNode('audioInput', {
    id: 'narration-audio',
    label: 'Narration',
    config: { filePath: assetPaths.audio },
  });
  const collection = createNode('collectionBuilder', {
    id: 'visual-collection',
    label: 'Visual collection',
  });
  const composition = createNode('mediaComposition', {
    id: 'compose-scenes',
    label: 'Compose scenes',
    config: {
      secondsPerItem: 1.5,
    },
  });
  const exportNode = createNode('mediaExport', {
    id: 'export-scenes',
    label: 'Export scenes',
    config: {
      title: 'Storyboard export',
      width: 640,
      height: 360,
      fps: 12,
      fitMode: 'contain',
      stopMode: 'shortest',
    },
  });
  const output = createNode('videoOutput', {
    id: 'video-output',
    label: 'Video output',
    config: {
      title: 'Storyboard export final',
    },
  });

  return createEmptyPipeline({
    id: 'verify-pipeline-media-composition',
    name: 'Verify Pipeline Media Composition',
    nodes: [firstImage, secondImage, audio, collection, composition, exportNode, output],
    edges: [
      createEdge(firstImage.id, 'image', collection.id, 'items'),
      createEdge(secondImage.id, 'image', collection.id, 'items'),
      createEdge(collection.id, 'collection', composition.id, 'visuals'),
      createEdge(audio.id, 'audio', composition.id, 'audio'),
      createEdge(composition.id, 'composition', exportNode.id, 'composition'),
      createEdge(exportNode.id, 'video', output.id, 'video'),
    ],
  });
}

async function prepareAssets() {
  const assetRoot = path.join(TEST_STORAGE_ROOT, 'fixtures');
  fs.mkdirSync(assetRoot, { recursive: true });
  const imageOne = path.join(assetRoot, 'scene-1.gif');
  const imageTwo = path.join(assetRoot, 'scene-2.gif');
  const audio = path.join(assetRoot, 'narration.wav');
  fs.writeFileSync(imageOne, createImageBuffer());
  fs.writeFileSync(imageTwo, createImageBuffer());
  fs.writeFileSync(audio, createWaveBuffer());
  return { imageOne, imageTwo, audio };
}

async function verifyMediaCompositionPipeline() {
  const assetPaths = await prepareAssets();
  const pipeline = buildMediaCompositionPipeline(assetPaths);
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected media composition pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the media composition pipeline.');

  const finishedRun = await waitFor('the media composition pipeline to finish', () => {
    const run = getActiveRunSnapshot();
    return run && ['completed', 'failed'].includes(run.status) && run.runId === initialRun.runId ? run : null;
  }, 45000);

  assert.strictEqual(
    finishedRun.status,
    'completed',
    `Expected the media composition pipeline to complete, but it ${finishedRun.status || 'stopped'} with: ${finishedRun.nodeStates?.['export-scenes']?.message || finishedRun.message || 'no message'}.`,
  );

  const completedRun = finishedRun;

  const compositionResult = completedRun.resultsByNodeId?.['compose-scenes']?.outputs?.composition || null;
  assert(compositionResult, 'Expected the media composition node to produce a composition artifact.');
  assert.strictEqual(compositionResult.kind, 'composition', 'Expected a first-class composition artifact from the composition node.');
  assert(compositionResult.manifestPath && fs.existsSync(compositionResult.manifestPath), 'Expected the composition manifest to exist.');

  const compositionManifest = JSON.parse(fs.readFileSync(compositionResult.manifestPath, 'utf8'));
  assert.strictEqual(compositionManifest.kind, 'composition', 'Expected the composition manifest to record the composition kind.');
  assert.strictEqual(compositionManifest.trackCount, 2, 'Expected the composition manifest to keep both visual and audio tracks.');
  assert.strictEqual(compositionManifest.tracks?.[0]?.itemCount, 2, 'Expected the visual track to keep both ordered images.');

  const exportArtifact = completedRun.resultsByNodeId?.['export-scenes']?.outputs?.video || null;
  assert(exportArtifact, 'Expected the media export node to produce a video artifact.');
  assert.strictEqual(exportArtifact.kind, 'video', 'Expected the export node to return a video artifact.');
  assert(exportArtifact.filePath && fs.existsSync(exportArtifact.filePath), 'Expected the exported video file to exist.');
  assert(exportArtifact.compositionExport, 'Expected the exported video artifact to keep composition export metadata.');
  assert.strictEqual(exportArtifact.compositionExport.visualTrack?.itemCount, 2, 'Expected the export metadata to keep visual track item count.');
  assert(exportArtifact.compositionExport.audioTrack?.artifact?.fileName, 'Expected the export metadata to keep the primary audio track reference.');

  const terminalResult = completedRun.terminalResults?.[0] || null;
  assert(terminalResult, 'Expected the pipeline to produce a terminal video result.');
  assert.strictEqual(terminalResult.kind, 'video', 'Expected the terminal result to stay video-typed.');
  assert(terminalResult.filePath && fs.existsSync(terminalResult.filePath), 'Expected the final saved video output to exist.');
  assert(Array.isArray(terminalResult.artifact?.metadataPaths) && terminalResult.artifact.metadataPaths.length, 'Expected the final video output to keep export metadata sidecars.');
  assert(fs.existsSync(terminalResult.artifact.metadataPaths[0]), 'Expected the final export metadata sidecar to exist.');
}

async function main() {
  await cleanupActiveRun();
  await verifyMediaCompositionPipeline();
  await cleanupActiveRun();
  console.log('Pipeline media composition verification passed.');
}

main().catch(async (error) => {
  await cleanupActiveRun();
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

