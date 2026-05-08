const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-pipeline-collection-input');
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

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
    return {
      ensureStorage: async () => {
        fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
      },
      getAppPaths: () => ({ runtimesRoot: TEST_STORAGE_ROOT }),
    };
  }

  if (normalizedParent.endsWith('/electron/services/pipelineExecutionService.js')) {
    if (request === './providerRegistry') return { initializeProviderRegistry: async () => {} };
    if (request === './providerService') {
      return {
        chatWithProvider: async () => ({ message: { content: 'ok' } }),
        listProviderConnections: async () => ([{ id: 'openai', name: 'OpenAI', isConnected: true }]),
        runProviderOperation: async () => ({ images: [{ base64Data: ONE_PIXEL_PNG }] }),
      };
    }
    if (request === './toolRegistry') return { getToolCatalog: () => [], initializeToolRegistry: async () => {} };
    if (request === './toolStateService') return { buildMergedToolStateList: async () => [], getResolvedToolState: async () => null };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const {
  PIPELINE_NODE_TYPES,
  PIPELINE_OPERATION_IDS,
  analyzePipeline,
  buildPipelineGraph,
  createEdge,
  createEmptyPipeline,
  createNode,
} = require('../electron/shared/pipelineSchema.cjs');
const { getActiveRunSnapshot, runPipeline } = require('../electron/services/pipelineExecutionService');
const collectionInputState = require('../src/lib/pipeline-collection-input-state.cjs');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunToFinish(runId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = getActiveRunSnapshot();
    if (snapshot?.runId === runId && ['completed', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot;
    await wait(50);
  }
  throw new Error('Timed out waiting for collection input pipeline run.');
}

function providerContext() {
  return {
    hardware: null,
    providers: [{ id: 'openai', name: 'OpenAI', isConnected: true }],
    toolCatalog: [],
    tools: [],
  };
}

function buildCollectionInputOutputPipeline(itemType, items, idSuffix = itemType) {
  const input = createNode('collectionInput', {
    id: 'collection-input-' + idSuffix,
    label: 'Manual ' + itemType + ' collection',
    config: { itemType, items },
  });
  const output = createNode('collectionOutput', {
    id: 'collection-output-' + idSuffix,
    label: 'Collection output',
    config: { title: 'Manual ' + itemType + ' output' },
  });
  return createEmptyPipeline({
    id: 'verify-collection-input-' + idSuffix,
    name: 'Verify Collection Input ' + itemType,
    nodes: [input, output],
    edges: [createEdge(input.id, 'collection', output.id, 'collection')],
  });
}

function buildCollectionInputMapPipeline() {
  const input = createNode('collectionInput', {
    id: 'collection-input-map-source',
    label: 'Manual prompt collection',
    config: {
      itemType: 'text',
      items: [
        { id: 'prompt-a', text: 'quiet mountain cabin' },
        { id: 'prompt-b', text: 'city street at sunrise' },
      ],
    },
  });
  const map = createNode('collectionMap', {
    id: 'map-manual-prompts',
    label: 'Generate prompt images',
    config: {
      executionMode: 'cloud',
      operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
      providerId: 'openai',
      model: 'gpt-image-1',
    },
  });
  const output = createNode('collectionOutput', {
    id: 'mapped-image-output',
    label: 'Image collection output',
    config: { title: 'Mapped manual images' },
  });
  return createEmptyPipeline({
    id: 'verify-collection-input-map',
    name: 'Verify Collection Input Map',
    nodes: [input, map, output],
    edges: [
      createEdge(input.id, 'collection', map.id, 'collection'),
      createEdge(map.id, 'collection', output.id, 'collection'),
    ],
  });
}

function buildCollectionBuilderPipeline() {
  const first = createNode('textInput', { id: 'builder-first', label: 'First', config: { text: 'one' } });
  const second = createNode('textInput', { id: 'builder-second', label: 'Second', config: { text: 'two' } });
  const builder = createNode('collectionBuilder', { id: 'existing-builder', label: 'Existing builder' });
  const output = createNode('collectionOutput', { id: 'existing-builder-output', label: 'Builder output', config: { title: 'Builder output' } });
  return createEmptyPipeline({
    id: 'verify-existing-builder-after-collection-input',
    name: 'Verify Existing Builder After Collection Input',
    nodes: [first, second, builder, output],
    edges: [
      createEdge(first.id, 'text', builder.id, 'items'),
      createEdge(second.id, 'text', builder.id, 'items'),
      createEdge(builder.id, 'collection', output.id, 'collection'),
    ],
  });
}

async function runAndAssertCompleted(pipeline, context = providerContext()) {
  const analysis = analyzePipeline(pipeline, context);
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected pipeline to analyze as executable.');
  const started = await runPipeline(pipeline);
  assert(started?.runId, 'Expected runPipeline to return a run id.');
  const completed = await waitForRunToFinish(started.runId);
  assert.strictEqual(completed.status, 'completed', completed.message);
  return completed;
}

function prepareFiles() {
  fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
  const files = {
    audio: path.join(TEST_STORAGE_ROOT, 'clip.wav'),
    file: path.join(TEST_STORAGE_ROOT, 'notes.bin'),
    image: path.join(TEST_STORAGE_ROOT, 'image.png'),
    video: path.join(TEST_STORAGE_ROOT, 'clip.mp4'),
  };
  fs.writeFileSync(files.image, Buffer.from(ONE_PIXEL_PNG, 'base64'));
  fs.writeFileSync(files.audio, Buffer.from('RIFF____WAVEfmt ', 'ascii'));
  fs.writeFileSync(files.video, Buffer.from('fake mp4 payload'));
  fs.writeFileSync(files.file, Buffer.from('generic file payload'));
  return files;
}

function verifyCollectionInputRendererStateHelpers(files) {
  let nextId = 0;
  const createId = () => 'state-item-' + (++nextId);
  let textNode = {
    id: 'state-text-node',
    type: 'collectionInput',
    config: { itemType: 'text', items: [] },
  };

  textNode = collectionInputState.addCollectionInputTextItemToNode(textNode, { createId });
  assert.deepStrictEqual(textNode.config.items, [{ id: 'state-item-1', kind: 'text', text: '' }], 'Text Add item should create a renderer-safe empty text item.');
  textNode = collectionInputState.updateCollectionInputItemInNode(textNode, 'state-item-1', { text: 'First prompt' });
  textNode = collectionInputState.addCollectionInputTextItemToNode(textNode, { createId });
  textNode = collectionInputState.updateCollectionInputItemInNode(textNode, 'state-item-2', { text: 'Second prompt' });
  assert.deepStrictEqual(textNode.config.items.map((item) => item.text), ['First prompt', 'Second prompt'], 'Text item edits should preserve controlled text values.');
  textNode = collectionInputState.moveCollectionInputItemInNode(textNode, 'state-item-2', 'up');
  assert.deepStrictEqual(textNode.config.items.map((item) => item.id), ['state-item-2', 'state-item-1'], 'Text item reorder should preserve item ids.');
  textNode = collectionInputState.removeCollectionInputItemFromNode(textNode, 'state-item-1');
  assert.deepStrictEqual(textNode.config.items.map((item) => item.text), ['Second prompt'], 'Text item removal should remove only the targeted item.');

  let imageNode = {
    id: 'state-image-node',
    type: 'collectionInput',
    config: { itemType: 'image', items: [] },
  };
  imageNode = collectionInputState.addCollectionInputFileItemToNode(imageNode, files.image, 'image', { createId, displayName: 'image.png' });
  assert.strictEqual(imageNode.config.itemType, 'image');
  assert.strictEqual(imageNode.config.items[0].id, 'state-item-3');
  assert.strictEqual(imageNode.config.items[0].kind, 'image');
  assert.strictEqual(imageNode.config.items[0].filePath, files.image);
  assert.strictEqual(imageNode.config.items[0].displayName, 'image.png');
}

async function verifyTextCollectionInput() {
  const pipeline = buildCollectionInputOutputPipeline('text', [
    { id: 'manual-a', text: 'Alpha' },
    { id: 'manual-b', text: 'Beta' },
    { id: 'manual-c', text: 'Gamma' },
  ]);
  const graph = buildPipelineGraph(pipeline);
  assert.deepStrictEqual(graph.errors, [], 'collection:text should connect to Collection Output.');

  const completed = await runAndAssertCompleted(pipeline, providerContext());
  const result = completed.terminalResults?.[0] || null;
  assert(result, 'Expected Collection Output to produce a terminal result.');
  assert.strictEqual(result.kind, 'collection');
  assert.strictEqual(result.itemKind, 'text');
  assert.deepStrictEqual((result.artifact?.items || []).map((entry) => entry.artifact.text), ['Alpha', 'Beta', 'Gamma']);
  assert.deepStrictEqual((result.artifact?.items || []).map((entry) => entry.itemId), ['manual-a', 'manual-b', 'manual-c']);
  assert.deepStrictEqual((result.artifact?.items || []).map((entry) => entry.lineage.sourceItemIndex), [0, 1, 2]);
  assert(result.manifestPath && fs.existsSync(result.manifestPath), 'Expected Collection Output to save a manifest.');
}

async function verifyFileBackedCollectionInput(itemType, filePath) {
  const pipeline = buildCollectionInputOutputPipeline(itemType, [
    { id: itemType + '-a', filePath },
    { id: itemType + '-b', filePath },
  ]);
  const graph = buildPipelineGraph(pipeline);
  assert.deepStrictEqual(graph.errors, [], 'collection:' + itemType + ' should connect to Collection Output.');

  const completed = await runAndAssertCompleted(pipeline, providerContext());
  const result = completed.terminalResults?.[0] || null;
  assert(result, 'Expected file-backed Collection Input to produce a terminal result.');
  assert.strictEqual(result.kind, 'collection');
  assert.strictEqual(result.itemKind, itemType);
  assert.deepStrictEqual((result.artifact?.items || []).map((entry) => entry.artifact.kind), [itemType, itemType]);
  const inputState = completed.nodeStates?.['collection-input-' + itemType] || null;
  assert.deepStrictEqual((inputState?.outputs?.collection?.items || []).map((entry) => path.basename(entry.artifact.filePath)), [path.basename(filePath), path.basename(filePath)]);
}

function verifyRejectedDrafts() {
  const emptyPipeline = buildCollectionInputOutputPipeline('text', [], 'empty');
  const emptyAnalysis = analyzePipeline(emptyPipeline, providerContext());
  assert.strictEqual(emptyAnalysis.executable, false, 'Expected an empty Collection Input to block execution.');
  assert(emptyAnalysis.issues.some((issue) => /Add at least one item/i.test(issue.message)), 'Expected a clear empty collection issue.');

  const missingFilePipeline = buildCollectionInputOutputPipeline('image', [{ id: 'missing-image', filePath: '' }], 'missing-file');
  const missingFileAnalysis = analyzePipeline(missingFilePipeline, providerContext());
  assert.strictEqual(missingFileAnalysis.executable, false, 'Expected a missing file path to block execution.');
  assert(missingFileAnalysis.issues.some((issue) => /needs a selected image file/i.test(issue.message)), 'Expected a clear missing file path issue.');
}

async function verifyCollectionInputMap() {
  const pipeline = buildCollectionInputMapPipeline();
  const graph = buildPipelineGraph(pipeline);
  assert.deepStrictEqual(graph.errors, [], 'collection:text from Collection Input should connect to collectionMap.');
  const completed = await runAndAssertCompleted(pipeline, providerContext());
  const mapState = completed.nodeStates?.['map-manual-prompts'] || null;
  assert.strictEqual(mapState?.outputs?.collection?.itemKind, 'image');
  assert.strictEqual(mapState?.outputs?.collection?.itemCount, 2);
  assert.deepStrictEqual((mapState.outputs.collection.items || []).map((entry) => entry.lineage.sourceItemIndex), [0, 1]);
}

async function verifyExistingCollectionBuilderStillWorks() {
  const completed = await runAndAssertCompleted(buildCollectionBuilderPipeline(), providerContext());
  const result = completed.terminalResults?.[0] || null;
  assert.strictEqual(result?.itemKind, 'text');
  assert.deepStrictEqual((result.artifact?.items || []).map((entry) => entry.artifact.text), ['one', 'two']);
}

async function main() {
  assert(PIPELINE_NODE_TYPES.collectionInput, 'Collection Input node type should be registered.');
  const files = prepareFiles();
  verifyRejectedDrafts();
  verifyCollectionInputRendererStateHelpers(files);
  await verifyTextCollectionInput();
  await verifyFileBackedCollectionInput('image', files.image);
  await verifyFileBackedCollectionInput('audio', files.audio);
  await verifyFileBackedCollectionInput('video', files.video);
  await verifyFileBackedCollectionInput('file', files.file);
  await verifyCollectionInputMap();
  await verifyExistingCollectionBuilderStillWorks();
  console.log('Collection input pipeline verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
