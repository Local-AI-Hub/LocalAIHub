const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-pipeline-collection-map');
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const COMFY_TEXT_TO_IMAGE_WORKFLOW = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'original prompt' } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
};
const COMFY_NO_IMAGE_OUTPUT_WORKFLOW = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'original prompt' } },
  '7': { class_type: 'KSampler', inputs: { seed: 1 } },
};
let mockedInstalledTools = [];
const graphWorkflowPrompts = [];

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

  if (normalizedParent.endsWith('/electron/services/pipelineToolOrchestrationService.js')) {
    if (request === './processService') {
      return {
        isToolActive: async () => true,
        isToolReady: async () => true,
        launchToolFromUserAction: async (tool) => ({ ...tool, status: 'running' }),
        stopTool: async () => {},
      };
    }
  }

  if (normalizedParent.endsWith('/electron/services/pipelineExecutionService.js')) {
    if (request === './providerRegistry') return { initializeProviderRegistry: async () => {} };
    if (request === './providerService') {
      return {
        chatWithProvider: async () => ({ message: { content: 'ok' } }),
        listProviderConnections: async () => ([{
          id: 'openai',
          name: 'OpenAI',
          isConnected: true,
          lastTestedAt: new Date().toISOString(),
          lastTestSucceeded: true,
        }]),
        runProviderOperation: async () => ({ images: [{ base64Data: ONE_PIXEL_PNG }] }),
      };
    }
    if (request === './toolRegistry') return { getToolCatalog: () => mockedInstalledTools, initializeToolRegistry: async () => {} };
    if (request === './toolStateService') return { buildMergedToolStateList: async () => mockedInstalledTools, getResolvedToolState: async (toolId) => mockedInstalledTools.find((tool) => tool.id === toolId) || null };
    if (request === './graphWorkflowService') {
      return {
        executeGraphWorkflowNode: async ({ inputArtifacts, node }) => {
          fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
          const outputPath = path.join(TEST_STORAGE_ROOT, 'graph-' + (graphWorkflowPrompts.length + 1) + '.png');
          fs.writeFileSync(outputPath, Buffer.from(ONE_PIXEL_PNG, 'base64'));
          graphWorkflowPrompts.push({
            label: node.label,
            prompt: inputArtifacts?.text?.text || '',
          });
          return {
            outputs: {
              image: {
                filePath: outputPath,
                fileName: 'graph-' + graphWorkflowPrompts.length + '.png',
                kind: 'image',
                role: 'generated',
              },
            },
            preview: 'graph image',
            message: 'Graph workflow generated an image.',
          };
        },
      };
    }
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
const { buildPipelineWizardDraft } = require('../electron/shared/pipelineWizard.cjs');
const { getActiveRunSnapshot, runPipeline } = require('../electron/services/pipelineExecutionService');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunToFinish(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = getActiveRunSnapshot();
    if (snapshot && ['completed', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot;
    await wait(50);
  }
  throw new Error('Timed out waiting for collection map pipeline run.');
}

function buildCollectionMapPipeline(overrides = {}) {
  const first = createNode('textInput', { id: 'prompt-one', label: 'Prompt one', config: { text: 'quiet mountain cabin' } });
  const second = createNode('textInput', { id: 'prompt-two', label: 'Prompt two', config: { text: 'city street at sunrise' } });
  const builder = createNode('collectionBuilder', { id: 'prompt-collection', label: 'Prompt collection' });
  const map = createNode('collectionMap', {
    id: 'map-prompts',
    label: 'Generate prompt images',
    config: {
      executionMode: 'cloud',
      operationId: overrides.operationId || PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
      providerId: 'openai',
      model: 'gpt-image-1',
      ...(overrides.mapConfig || {}),
    },
  });
  const output = createNode('collectionOutput', { id: 'image-output', label: 'Image collection output', config: { title: 'Mapped images' } });
  return createEmptyPipeline({
    id: 'collection-map-verify',
    name: 'Collection map verification',
    nodes: [first, second, builder, map, output],
    edges: [
      createEdge(first.id, 'text', builder.id, 'items'),
      createEdge(second.id, 'text', builder.id, 'items'),
      createEdge(builder.id, 'collection', map.id, 'collection'),
      createEdge(map.id, 'collection', output.id, 'collection'),
    ],
  });
}


function createComfyTool(patch = {}) {
  return {
    id: 'comfyui',
    name: 'ComfyUI',
    appDir: 'C:/mock/comfyui',
    installDir: 'C:/mock/comfyui',
    launchProfile: { kind: 'folder', path: 'C:/mock/comfyui' },
    launchUrl: 'http://127.0.0.1:8188',
    status: 'running',
    ...patch,
  };
}

function buildGraphCollectionMapConfig(workflow = COMFY_TEXT_TO_IMAGE_WORKFLOW, patch = {}) {
  return {
    executionMode: 'graphWorkflow',
    graphWorkflowToolId: 'comfyui',
    providerId: '',
    toolId: '',
    workflowText: JSON.stringify(workflow),
    inputBindings: {
      text: {
        mode: 'node-field',
        nodeId: '6',
        field: 'text',
      },
    },
    outputBindings: {
      image: {
        mode: 'node-output',
        nodeId: '9',
      },
    },
    ...patch,
  };
}

async function main() {
  fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
  assert(PIPELINE_NODE_TYPES.collectionMap, 'collectionMap node type should be registered');

  const pipeline = buildCollectionMapPipeline();
  const graph = buildPipelineGraph(pipeline);
  assert.deepStrictEqual(graph.errors, [], 'collection:text -> collectionMap -> collectionOutput should be structurally valid');
  const analysis = analyzePipeline(pipeline, { providers: [{ id: 'openai', name: 'OpenAI', isConnected: true, lastTestedAt: new Date().toISOString(), lastTestSucceeded: true }] });
  assert.strictEqual(analysis.executable, true, 'collection map pipeline should analyze as executable with a connected provider');

  const unsupportedPipeline = buildCollectionMapPipeline({ operationId: PIPELINE_OPERATION_IDS.VIDEO_GENERATE });
  const unsupportedAnalysis = analyzePipeline(unsupportedPipeline, { providers: [{ id: 'openai', name: 'OpenAI', isConnected: true }] });
  assert(unsupportedAnalysis.issues.some((issue) => /Map Collection currently supports text collection to image collection/.test(issue.message)) || buildPipelineGraph(unsupportedPipeline).errors.length, 'unsupported collection mappings should surface an honest issue');


  mockedInstalledTools = [createComfyTool()];
  const graphPipeline = buildCollectionMapPipeline({ mapConfig: buildGraphCollectionMapConfig() });
  const graphAnalysis = analyzePipeline(graphPipeline, { tools: mockedInstalledTools, toolCatalog: mockedInstalledTools });
  assert.strictEqual(graphAnalysis.executable, true, 'compatible ComfyUI text-to-image graph workflow should make collectionMap executable.');

  const missingWorkflowPipeline = buildCollectionMapPipeline({ mapConfig: buildGraphCollectionMapConfig({}, { workflowText: '' }) });
  const missingWorkflowAnalysis = analyzePipeline(missingWorkflowPipeline, { tools: mockedInstalledTools, toolCatalog: mockedInstalledTools });
  assert(missingWorkflowAnalysis.issues.some((issue) => /Paste the exported ComfyUI API workflow JSON|workflow definition/i.test(issue.message)), 'missing graph workflow JSON should not be treated as a fake ComfyUI backend.');

  const noTextBoundaryPipeline = buildCollectionMapPipeline({ mapConfig: buildGraphCollectionMapConfig(COMFY_TEXT_TO_IMAGE_WORKFLOW, { inputBindings: { text: { mode: 'node-field', nodeId: '', field: '' } } }) });
  const noTextBoundaryAnalysis = analyzePipeline(noTextBoundaryPipeline, { tools: mockedInstalledTools, toolCatalog: mockedInstalledTools });
  assert(noTextBoundaryAnalysis.issues.some((issue) => /Text input boundary/i.test(issue.message)), 'graph workflow collectionMap should reject missing text input boundary.');

  const noImageBoundaryPipeline = buildCollectionMapPipeline({ mapConfig: buildGraphCollectionMapConfig(COMFY_NO_IMAGE_OUTPUT_WORKFLOW, { outputBindings: { image: { mode: 'node-output', nodeId: '7' } } }) });
  const noImageBoundaryAnalysis = analyzePipeline(noImageBoundaryPipeline, { tools: mockedInstalledTools, toolCatalog: mockedInstalledTools });
  assert(noImageBoundaryAnalysis.issues.some((issue) => /Image output boundary|image-producing node/i.test(issue.message)), 'graph workflow collectionMap should reject workflows without a compatible image output boundary.');

  graphWorkflowPrompts.length = 0;
  await runPipeline(graphPipeline);
  const graphSnapshot = await waitForRunToFinish();
  assert.strictEqual(graphSnapshot.status, 'completed', graphSnapshot.message);
  assert.deepStrictEqual(graphWorkflowPrompts.map((entry) => entry.prompt), [
    'Generate one image for each text item while preserving the source order.\n\nPrompt:\nquiet mountain cabin',
    'Generate one image for each text item while preserving the source order.\n\nPrompt:\ncity street at sunrise',
  ], 'graph workflow collectionMap should execute once per item in source order.');
  const graphMapState = graphSnapshot.nodeStates['map-prompts'];
  assert.strictEqual(graphMapState.outputs.collection.itemKind, 'image');
  assert.strictEqual(graphMapState.outputs.collection.items[0].lineage.sourceItemIndex, 0);
  assert.strictEqual(graphMapState.outputs.collection.items[1].lineage.sourceItemIndex, 1);

  mockedInstalledTools = [];

  const wizardDraft = buildPipelineWizardDraft({
    intent: 'Take a script, plan scenes, generate one image for each scene, then prepare the result as a collection.',
    modelPlan: {
      title: 'Scene image collection',
      intentIr: {
        schemaVersion: 1,
        sources: [{ name: 'script', role: 'script', modality: 'text' }],
        stages: [
          { id: 'plan', kind: 'plan', inputs: ['script'], output: 'scenePlan' },
          { id: 'scenes', kind: 'plan_scenes', inputs: ['scenePlan'], output: 'scenePrompts' },
          { id: 'images', kind: 'generate_image', inputs: ['scenePrompts'], output: 'sceneImages' },
        ],
        outputs: [{ artifact: 'sceneImages', kind: 'collection:image', title: 'Scene images' }],
      },
    },
    context: {
      connectedProviders: [{ id: 'openai', name: 'OpenAI', isConnected: true, lastTestedAt: new Date().toISOString(), lastTestSucceeded: true }],
      availableTools: [],
    },
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-image-1' },
  });
  assert(wizardDraft.pipeline.nodes.some((node) => node.type === 'collectionMap'), 'wizard should lower collection:text image generation through collectionMap');

  await runPipeline(pipeline);
  const snapshot = await waitForRunToFinish();
  assert.strictEqual(snapshot.status, 'completed', snapshot.message);
  const mapState = snapshot.nodeStates['map-prompts'];
  assert.strictEqual(mapState.outputs.collection.itemKind, 'image');
  assert.strictEqual(mapState.outputs.collection.itemCount, 2);
  assert.strictEqual(mapState.outputs.collection.items[0].lineage.sourceItemIndex, 0);
  assert.strictEqual(mapState.outputs.collection.items[1].lineage.sourceItemIndex, 1);

  console.log('Collection map pipeline verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});