const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-pipeline-collection-map');
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const WAVE_FIXTURE = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=', 'base64');
let failSecondAudioGeneration = false;
const providerImageGenerationPrompts = [];
const perItemValidationRequests = [];
const perItemValidationDecisionsByItemLabel = new Map();
function flattenMockProviderText(value) {
  if (Array.isArray(value)) return value.map((entry) => flattenMockProviderText(entry)).filter(Boolean).join(' ');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string' || Array.isArray(value.content)) return flattenMockProviderText(value.content);
    return '';
  }
  return typeof value === 'string' ? value : '';
}
function buildMockValidationReply(payload = {}) {
  const text = flattenMockProviderText(payload.messages || []);
  perItemValidationRequests.push(text);
  const itemLabel = /item 2/i.test(text) ? 'item-2' : /item 1/i.test(text) ? 'item-1' : 'unknown';
  const seen = perItemValidationDecisionsByItemLabel.get(itemLabel) || 0;
  perItemValidationDecisionsByItemLabel.set(itemLabel, seen + 1);
  if (itemLabel === 'item-2' && seen === 0) {
    return JSON.stringify({ decision: 'fail', reason: 'Mock validator rejected item 2 on the first attempt.', summary: 'Retry item 2.', confidence: 0.9, criteriaResults: [{ criterion: 'mock retry', decision: 'fail', reason: 'first attempt' }] });
  }
  return JSON.stringify({ decision: 'pass', reason: 'Mock validator accepted this item.', summary: 'Accepted.', confidence: 0.95, criteriaResults: [{ criterion: 'mock retry', decision: 'pass', reason: 'acceptable' }] });
}
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
        chatWithProvider: async (_providerId, payload = {}) => ({ message: { content: buildMockValidationReply(payload) } }),
        listProviderConnections: async () => ([{
          id: 'openai',
          name: 'OpenAI',
          isConnected: true,
          lastTestedAt: new Date().toISOString(),
          lastTestSucceeded: true,
        }]),
        runProviderOperation: async (_providerId, payload = {}) => {
          if (payload.operationId === 'audioGenerate') return { audios: [{ buffer: WAVE_FIXTURE, extension: '.wav', sampleRate: 16000, channelCount: 1, bitDepth: 16 }] };
          if (payload.operationId === 'imageAnalyze') return { message: { content: 'cloud image description' } };
          providerImageGenerationPrompts.push(String(payload.prompt || ''));
          return { images: [{ base64Data: ONE_PIXEL_PNG }] };
        },
      };
    }
    if (request === './toolRegistry') return { getToolCatalog: () => mockedInstalledTools, initializeToolRegistry: async () => {} };
    if (request === './toolStateService') return { buildMergedToolStateList: async () => mockedInstalledTools, getResolvedToolState: async (toolId) => mockedInstalledTools.find((tool) => tool.id === toolId) || null };
    if (request === './workflowToolService') {
      return {
        generateImageWithWorkflowTool: async () => ({ base64Image: ONE_PIXEL_PNG }),
        interrogateImageWithWorkflowTool: async (_tool, request = {}) => ({ text: 'description for ' + (request.imagePath ? path.basename(request.imagePath) : 'image') }),
        resolveSelectedImageTool: (_contextMaps, node = {}) => mockedInstalledTools.find((tool) => tool.id === String(node.config?.toolId || '').trim()) || mockedInstalledTools.find((tool) => tool.id === 'forge') || mockedInstalledTools.find((tool) => tool.id === 'automatic1111') || null,
      };
    }
    if (request === './localAudioService') {
      return {
        generateAudioWithLocalAudioTool: async (_tool, request = {}) => {
          const prompt = String(request.prompt || '');
          if (failSecondAudioGeneration && /city street/i.test(prompt)) {
            throw new Error('mock AudioCraft failure');
          }
          fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
          const outputPath = path.join(TEST_STORAGE_ROOT, 'audio-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.wav');
          fs.writeFileSync(outputPath, WAVE_FIXTURE);
          return {
            outputs: {
              audio: {
                audioGeneration: request.operationId === 'audioGenerate' ? {
                  mode: request.audioMode || 'music',
                  model: request.model || '',
                  operationId: request.operationId,
                  prompt: request.prompt || '',
                  toolLabel: _tool.name,
                } : undefined,
                audioTransformation: request.operationId === 'audioTransform' ? {
                  operationId: request.operationId,
                  targetVoice: request.model || '',
                  toolLabel: _tool.name,
                  transformationType: 'voice-conversion',
                } : undefined,
                filePath: outputPath,
                fileName: path.basename(outputPath),
                kind: 'audio',
                role: 'generated',
              },
            },
            preview: 'audio',
            message: 'Generated audio.',
          };
        },
      };
    }
    if (request === './localImageService') {
      return {
        generateImageWithLocalImageTool: async (_tool, request = {}) => {
          fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
          const outputPath = path.join(TEST_STORAGE_ROOT, 'upscayl-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.png');
          fs.writeFileSync(outputPath, Buffer.from(ONE_PIXEL_PNG, 'base64'));
          return { outputs: { image: { filePath: outputPath, fileName: path.basename(outputPath), imageTransformation: { operationId: request.operationId, toolLabel: _tool.name, transformSubtype: request.transformSubtype || 'upscale' }, kind: 'image', role: 'generated' } }, preview: 'image', message: 'Transformed image.' };
        },
      };
    }
    if (request === './whisperService') {
      return {
        DEFAULT_WHISPER_MODEL: 'base',
        transcribeWithWhisper: async (_tool, request = {}) => ({ text: 'transcript for ' + path.basename(request.audioPath || 'audio.wav'), model: request.model || 'base', language: 'en', segments: [{ start: 0, end: 1, text: 'transcript' }] }),
      };
    }
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
const { getActiveRunSnapshot, resumePipelineValidation, runPipeline } = require('../electron/services/pipelineExecutionService');

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

async function waitForRunStatus(status, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = getActiveRunSnapshot();
    if (snapshot?.status === status) return snapshot;
    if (snapshot && ['completed', 'failed', 'cancelled'].includes(snapshot.status) && snapshot.status !== status) {
      throw new Error('Expected run status ' + status + ', got ' + snapshot.status + ': ' + snapshot.message);
    }
    await wait(50);
  }
  throw new Error('Timed out waiting for collection map pipeline status ' + status + '.');
}

function resumePendingValidation(snapshot, decision, comment = '') {
  assert(snapshot?.runId, 'run should have a run id before resuming validation');
  assert(snapshot?.pendingValidation?.requestId, 'run should be paused on a validation request');
  return resumePipelineValidation(snapshot.runId, {
    comment,
    decision,
    nodeId: snapshot.pendingValidation.nodeId,
    requestId: snapshot.pendingValidation.requestId,
  });
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


function createTool(id, name, patch = {}) {
  return {
    id,
    name,
    appDir: 'C:/mock/' + id,
    installDir: 'C:/mock/' + id,
    launchProfile: { kind: 'folder', path: 'C:/mock/' + id },
    status: 'running',
    ...patch,
  };
}

function writeFixtureFile(name, buffer) {
  fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
  const filePath = path.join(TEST_STORAGE_ROOT, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function buildCollectionInputMapPipeline({ itemType, items, mapConfig, outputId = 'mapped-output' }) {
  const input = createNode('collectionInput', { id: 'collection-input', label: 'Collection input', config: { itemType, items } });
  const map = createNode('collectionMap', {
    id: 'map-collection',
    label: 'Map Collection',
    config: mapConfig,
  });
  const output = createNode('collectionOutput', { id: outputId, label: 'Collection output', config: { title: 'Mapped collection' } });
  return createEmptyPipeline({
    id: 'collection-input-map-' + itemType,
    name: 'Collection input map ' + itemType,
    nodes: [input, map, output],
    edges: [
      createEdge(input.id, 'collection', map.id, 'collection'),
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

  const builderPanelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'PipelineBuilderPanel.jsx'), 'utf8');
  assert(builderPanelSource.includes('showCollectionMapAudioGenerationFields'), 'collectionMap inspector should render operation-specific audio-generation fields.');
  assert(builderPanelSource.includes("assetKind: 'audiocraft-snapshot'"), 'collectionMap refresh should load AudioCraft snapshots.');
  assert(builderPanelSource.includes("assetKind: 'upscayl-model-set'"), 'collectionMap refresh should load Upscayl model sets.');
  assert(!builderPanelSource.includes('This mapping uses the selected tool default settings here. No refreshable model list is needed.'), 'collectionMap refresh should not use the stale generic no-models message for refreshable mappings.');

  const pipeline = buildCollectionMapPipeline();
  const graph = buildPipelineGraph(pipeline);
  assert.deepStrictEqual(graph.errors, [], 'collection:text -> collectionMap -> collectionOutput should be structurally valid');
  const analysis = analyzePipeline(pipeline, { providers: [{ id: 'openai', name: 'OpenAI', isConnected: true, lastTestedAt: new Date().toISOString(), lastTestSucceeded: true }] });
  assert.strictEqual(analysis.executable, true, 'collection map pipeline should analyze as executable with a connected provider');

  const unsupportedPipeline = buildCollectionMapPipeline({ operationId: PIPELINE_OPERATION_IDS.VIDEO_GENERATE });
  const unsupportedAnalysis = analyzePipeline(unsupportedPipeline, { providers: [{ id: 'openai', name: 'OpenAI', isConnected: true }] });
  assert(unsupportedAnalysis.issues.some((issue) => /Map Collection does not support that input\/output operation pair/.test(issue.message)) || buildPipelineGraph(unsupportedPipeline).errors.length, 'unsupported collection mappings should surface an honest issue');


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

  mockedInstalledTools = [createTool('audiocraft-webui', 'AudioCraft WebUI')];
  const textToAudioPipeline = buildCollectionInputMapPipeline({
    itemType: 'text',
    items: [
      { id: 'prompt-a', text: 'soft rain on glass' },
      { id: 'prompt-b', text: 'city street at sunrise' },
    ],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'textToAudio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      toolId: 'audiocraft-webui',
      audioMode: 'music',
      durationSeconds: 2,
      instruction: 'Short ambient loop.',
    },
  });
  assert.strictEqual(analyzePipeline(textToAudioPipeline, { tools: mockedInstalledTools, toolCatalog: mockedInstalledTools }).executable, true, 'text-to-audio collectionMap should analyze as executable with AudioCraft.');
  await runPipeline(textToAudioPipeline);
  const textToAudioSnapshot = await waitForRunToFinish();
  assert.strictEqual(textToAudioSnapshot.status, 'completed', textToAudioSnapshot.message);
  const textToAudioCollection = textToAudioSnapshot.nodeStates['map-collection'].outputs.collection;
  assert.strictEqual(textToAudioCollection.itemKind, 'audio');
  assert.strictEqual(textToAudioCollection.collectionMapping.mappingId, 'textToAudio', 'text-to-audio collection should preserve mapping metadata.');
  assert.strictEqual(textToAudioCollection.collectionMapping.operationId, PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'text-to-audio collection should preserve operation metadata.');
  assert.deepStrictEqual(textToAudioCollection.items.map((entry) => entry.lineage.sourceItemIndex), [0, 1], 'text-to-audio should preserve source order lineage.');
  assert(/Short ambient loop/.test(textToAudioCollection.items[0].artifact.audioGeneration.prompt), 'text-to-audio prompt should use audio wording when configured.');
  assert(!/Generate one image/.test(textToAudioCollection.items[0].artifact.audioGeneration.prompt), 'text-to-audio metadata must not inherit stale image-generation instructions.');

  const staleInstructionTextToAudioPipeline = buildCollectionInputMapPipeline({
    itemType: 'text',
    items: [{ id: 'prompt-stale', text: 'hard rock' }],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'textToAudio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      toolId: 'audiocraft-webui',
      audioMode: 'music',
      durationSeconds: 2,
      instruction: 'Generate one image for each text item while preserving the source order.',
    },
  });
  await runPipeline(staleInstructionTextToAudioPipeline);
  const staleTextToAudioSnapshot = await waitForRunToFinish();
  assert.strictEqual(staleTextToAudioSnapshot.status, 'completed', staleTextToAudioSnapshot.message);
  const staleAudioPrompt = staleTextToAudioSnapshot.nodeStates['map-collection'].outputs.collection.items[0].artifact.audioGeneration.prompt;
  assert.strictEqual(staleAudioPrompt, 'hard rock', 'stale text-to-image default instruction should be ignored for text-to-audio metadata.');

  const sourceImageA = writeFixtureFile('source-a.png', Buffer.from(ONE_PIXEL_PNG, 'base64'));
  const sourceImageB = writeFixtureFile('source-b.png', Buffer.from(ONE_PIXEL_PNG, 'base64'));
  mockedInstalledTools = [createTool('upscayl', 'Upscayl')];
  const imageToImagePipeline = buildCollectionInputMapPipeline({
    itemType: 'image',
    items: [
      { id: 'image-a', filePath: sourceImageA },
      { id: 'image-b', filePath: sourceImageB },
    ],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'imageToImage',
      operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM,
      toolId: 'upscayl',
      transformSubtype: 'upscale',
    },
  });
  assert.strictEqual(analyzePipeline(imageToImagePipeline, { tools: mockedInstalledTools, toolCatalog: mockedInstalledTools }).executable, true, 'image-to-image collectionMap should analyze as executable with Upscayl.');
  await runPipeline(imageToImagePipeline);
  const imageToImageSnapshot = await waitForRunToFinish();
  assert.strictEqual(imageToImageSnapshot.status, 'completed', imageToImageSnapshot.message);
  const imageToImageCollection = imageToImageSnapshot.nodeStates['map-collection'].outputs.collection;
  assert.strictEqual(imageToImageCollection.itemKind, 'image');
  assert.strictEqual(imageToImageCollection.collectionMapping.mappingId, 'imageToImage');
  assert.strictEqual(imageToImageCollection.items[0].artifact.imageTransformation.operationId, PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, 'image-to-image item metadata should name image transformation.');

  const sourceAudioA = writeFixtureFile('source-a.wav', WAVE_FIXTURE);
  const sourceAudioB = writeFixtureFile('source-b.wav', WAVE_FIXTURE);
  mockedInstalledTools = [createTool('whisper', 'Whisper')];
  const audioToTextPipeline = buildCollectionInputMapPipeline({
    itemType: 'audio',
    items: [
      { id: 'audio-a', filePath: sourceAudioA },
      { id: 'audio-b', filePath: sourceAudioB },
    ],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'audioToText',
      operationId: PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE,
      toolId: 'whisper',
      model: 'base',
    },
  });
  await runPipeline(audioToTextPipeline);
  const audioToTextSnapshot = await waitForRunToFinish();
  assert.strictEqual(audioToTextSnapshot.status, 'completed', audioToTextSnapshot.message);
  const audioToTextCollection = audioToTextSnapshot.nodeStates['map-collection'].outputs.collection;
  assert.strictEqual(audioToTextCollection.itemKind, 'text');
  assert.strictEqual(audioToTextCollection.collectionMapping.mappingId, 'audioToText');
  assert.strictEqual(audioToTextCollection.items[0].artifact.transcription.backend, 'whisper', 'audio-to-text item metadata should name Whisper transcription.');
  assert(/source-a/.test(audioToTextCollection.items[0].artifact.text), 'audio-to-text should emit transcript text in order.');

  mockedInstalledTools = [createTool('rvc', 'RVC', { downloadedModels: [{ id: 'voice.pth', name: 'voice.pth', fileName: 'voice.pth', modelType: 'rvc-voice' }] })];
  const audioToAudioPipeline = buildCollectionInputMapPipeline({
    itemType: 'audio',
    items: [
      { id: 'voice-a', filePath: sourceAudioA },
      { id: 'voice-b', filePath: sourceAudioB },
    ],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'audioToAudio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM,
      toolId: 'rvc',
      model: 'voice.pth',
    },
  });
  assert.strictEqual(analyzePipeline(audioToAudioPipeline, { tools: mockedInstalledTools, toolCatalog: mockedInstalledTools }).executable, true, 'audio-to-audio collectionMap should analyze as executable with RVC and a voice model.');
  await runPipeline(audioToAudioPipeline);
  const audioToAudioSnapshot = await waitForRunToFinish();
  assert.strictEqual(audioToAudioSnapshot.status, 'completed', audioToAudioSnapshot.message);
  const audioToAudioCollection = audioToAudioSnapshot.nodeStates['map-collection'].outputs.collection;
  assert.strictEqual(audioToAudioCollection.itemKind, 'audio');
  assert.strictEqual(audioToAudioCollection.collectionMapping.mappingId, 'audioToAudio');
  assert.strictEqual(audioToAudioCollection.items[0].artifact.audioTransformation.operationId, PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM, 'audio-to-audio item metadata should name RVC audio transform.');

  mockedInstalledTools = [createTool('forge', 'Forge')];
  const imageToTextPipeline = buildCollectionInputMapPipeline({
    itemType: 'image',
    items: [
      { id: 'describe-a', filePath: sourceImageA },
      { id: 'describe-b', filePath: sourceImageB },
    ],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'imageToText',
      operationId: PIPELINE_OPERATION_IDS.IMAGE_ANALYZE,
      toolId: 'forge',
      analysisMode: 'clip',
    },
  });
  await runPipeline(imageToTextPipeline);
  const imageToTextSnapshot = await waitForRunToFinish();
  assert.strictEqual(imageToTextSnapshot.status, 'completed', imageToTextSnapshot.message);
  const imageToTextCollection = imageToTextSnapshot.nodeStates['map-collection'].outputs.collection;
  assert.strictEqual(imageToTextCollection.itemKind, 'text');
  assert.strictEqual(imageToTextCollection.collectionMapping.mappingId, 'imageToText');
  assert.strictEqual(imageToTextCollection.items[0].artifact.imageAnalysis.operationId, PIPELINE_OPERATION_IDS.IMAGE_ANALYZE, 'image-to-text item metadata should name image analysis.');

  providerImageGenerationPrompts.length = 0;
  perItemValidationRequests.length = 0;
  perItemValidationDecisionsByItemLabel.clear();
  const perItemValidationPipeline = buildCollectionMapPipeline({
    mapConfig: {
      perItemValidation: {
        enabled: true,
        mode: 'llm',
        llmExecutionMode: 'cloud',
        providerId: 'openai',
        model: 'gpt-4o',
        ruleset: 'Pass only if the generated image satisfies the source prompt.',
        retryInstruction: 'Revise only the failed mapped item.',
        maxAttempts: 2,
        failMode: 'fail-fast',
      },
    },
  });
  assert.strictEqual(analyzePipeline(perItemValidationPipeline, { providers: [{ id: 'openai', name: 'OpenAI', isConnected: true }] }).executable, true, 'per-item LLM validation should analyze as executable for mapped images.');
  await runPipeline(perItemValidationPipeline);
  const perItemValidationSnapshot = await waitForRunToFinish();
  assert.strictEqual(perItemValidationSnapshot.status, 'completed', perItemValidationSnapshot.message);
  const perItemValidatedCollection = perItemValidationSnapshot.nodeStates['map-prompts'].outputs.collection;
  assert.strictEqual(perItemValidatedCollection.itemCount, 2, 'per-item validation should still emit one final ordered collection.');
  assert.deepStrictEqual(perItemValidatedCollection.items.map((entry) => entry.lineage.sourceItemIndex), [0, 1], 'per-item validation should preserve output order and lineage after retry.');
  assert.strictEqual(providerImageGenerationPrompts.filter((prompt) => /quiet mountain cabin/i.test(prompt)).length, 1, 'passed earlier items should not be rerun when a later item retries.');
  assert.strictEqual(providerImageGenerationPrompts.filter((prompt) => /city street at sunrise/i.test(prompt)).length, 2, 'only the failed mapped item should be regenerated on validation retry.');
  assert.strictEqual(perItemValidationRequests.length, 3, 'LLM validation should run independently for each mapped attempt.');
  assert.strictEqual(perItemValidatedCollection.items[0].attempts.length, 1, 'passing items should record one validation attempt.');
  assert.strictEqual(perItemValidatedCollection.items[1].attempts.length, 2, 'retried items should record failed and passed attempts.');
  assert.strictEqual(perItemValidatedCollection.items[1].attempts[0].validationPassed, false, 'failed attempt metadata should record validation failure.');
  assert.strictEqual(perItemValidatedCollection.items[1].attempts[1].validationPassed, true, 'final attempt metadata should record validation pass.');
  assert.strictEqual(perItemValidatedCollection.items[1].artifact.filePath, perItemValidatedCollection.items[1].attempts[1].artifact.filePath, 'final output should use the passed retry artifact, not the failed attempt.');
  assert.notStrictEqual(perItemValidatedCollection.items[1].artifact.filePath, perItemValidatedCollection.items[1].attempts[0].artifact.filePath, 'failed attempt artifacts should not be exposed as final item artifacts.');

  providerImageGenerationPrompts.length = 0;
  perItemValidationRequests.length = 0;
  perItemValidationDecisionsByItemLabel.clear();
  const perItemValidationFailurePipeline = buildCollectionMapPipeline({
    mapConfig: {
      perItemValidation: {
        enabled: true,
        mode: 'llm',
        llmExecutionMode: 'cloud',
        providerId: 'openai',
        model: 'gpt-4o',
        ruleset: 'Pass only if the generated image satisfies the source prompt.',
        maxAttempts: 1,
      },
    },
  });
  await runPipeline(perItemValidationFailurePipeline);
  const perItemValidationFailureSnapshot = await waitForRunToFinish();
  assert.strictEqual(perItemValidationFailureSnapshot.status, 'failed', 'validation failure after max attempts should fail the map node.');
  assert(/Map Collection item 2 of 2.*failed validation after 1 attempt.*Mock validator rejected item 2/i.test(perItemValidationFailureSnapshot.message), 'validation failure should report item index/id and reason: ' + perItemValidationFailureSnapshot.message);

  providerImageGenerationPrompts.length = 0;
  const manualPerItemValidationPipeline = buildCollectionMapPipeline({
    mapConfig: {
      perItemValidation: {
        enabled: true,
        mode: 'user',
        maxAttempts: 2,
        retryInstruction: 'Revise only this failed item.',
      },
    },
  });
  const manualPerItemValidationAnalysis = analyzePipeline(manualPerItemValidationPipeline, { providers: [{ id: 'openai', name: 'OpenAI', isConnected: true }] });
  assert.strictEqual(manualPerItemValidationAnalysis.executable, true, 'manual per-item validation should analyze as executable for mapped images.');
  await runPipeline(manualPerItemValidationPipeline);
  let manualSnapshot = await waitForRunStatus('paused');
  assert.strictEqual(manualSnapshot.pendingValidation.collectionMap.itemIndex, 0, 'manual validation should first pause on item 1.');
  assert.strictEqual(manualSnapshot.pendingValidation.collectionMap.attemptNumber, 1, 'manual validation should show item 1 attempt 1.');
  resumePendingValidation(manualSnapshot, 'pass', 'looks good');
  manualSnapshot = await waitForRunStatus('paused');
  assert.strictEqual(manualSnapshot.pendingValidation.collectionMap.itemIndex, 1, 'manual validation should next pause on item 2 without rerunning item 1.');
  assert.strictEqual(providerImageGenerationPrompts.filter((prompt) => /quiet mountain cabin/i.test(prompt)).length, 1, 'manual validation should not rerun accepted item 1 when item 2 is waiting.');
  resumePendingValidation(manualSnapshot, 'fail', 'needs another try');
  manualSnapshot = await waitForRunStatus('paused');
  assert.strictEqual(manualSnapshot.pendingValidation.collectionMap.itemIndex, 1, 'manual fail should retry only item 2.');
  assert.strictEqual(manualSnapshot.pendingValidation.collectionMap.attemptNumber, 2, 'manual fail should advance item 2 to attempt 2.');
  assert.strictEqual(providerImageGenerationPrompts.filter((prompt) => /quiet mountain cabin/i.test(prompt)).length, 1, 'manual retry should still not rerun item 1.');
  assert.strictEqual(providerImageGenerationPrompts.filter((prompt) => /city street at sunrise/i.test(prompt)).length, 2, 'manual retry should regenerate only item 2.');
  resumePendingValidation(manualSnapshot, 'pass', 'second try works');
  manualSnapshot = await waitForRunToFinish();
  assert.strictEqual(manualSnapshot.status, 'completed', manualSnapshot.message);
  const manualCollection = manualSnapshot.nodeStates['map-prompts'].outputs.collection;
  assert.deepStrictEqual(manualCollection.items.map((entry) => entry.lineage.sourceItemIndex), [0, 1], 'manual validation should preserve output order and lineage.');
  assert.strictEqual(manualCollection.items[0].attempts.length, 1, 'manual pass item should record one attempt.');
  assert.strictEqual(manualCollection.items[1].attempts.length, 2, 'manual retried item should record both attempts.');
  assert.strictEqual(manualCollection.items[1].attempts[0].validation.mode, 'user', 'manual failed attempt should record user validation mode.');
  assert.strictEqual(manualCollection.items[1].attempts[0].validationPassed, false, 'manual failed attempt should record fail.');
  assert.strictEqual(manualCollection.items[1].attempts[1].validationPassed, true, 'manual retry pass should record pass.');
  assert.notStrictEqual(manualCollection.items[1].artifact.filePath, manualCollection.items[1].attempts[0].artifact.filePath, 'manual failed attempt artifact should not become the final output item.');

  providerImageGenerationPrompts.length = 0;
  const manualFailPipeline = buildCollectionMapPipeline({
    mapConfig: {
      perItemValidation: {
        enabled: true,
        mode: 'user',
        maxAttempts: 1,
      },
    },
  });
  await runPipeline(manualFailPipeline);
  let manualFailSnapshot = await waitForRunStatus('paused');
  resumePendingValidation(manualFailSnapshot, 'pass');
  manualFailSnapshot = await waitForRunStatus('paused');
  assert.strictEqual(manualFailSnapshot.pendingValidation.collectionMap.itemIndex, 1, 'manual fail-after-limit fixture should pause on item 2.');
  resumePendingValidation(manualFailSnapshot, 'fail', 'not acceptable');
  manualFailSnapshot = await waitForRunToFinish();
  assert.strictEqual(manualFailSnapshot.status, 'failed', 'manual fail after max attempts should fail the map node.');
  assert(/Map Collection item 2 of 2.*failed manual validation after 1 attempt/i.test(manualFailSnapshot.message), 'manual failure should report item index/id and manual validation reason: ' + manualFailSnapshot.message);

  mockedInstalledTools = [createTool('audiocraft-webui', 'AudioCraft WebUI')];
  const manualAudioPipeline = buildCollectionInputMapPipeline({
    itemType: 'text',
    items: [{ id: 'audio-manual-a', text: 'soft rain on glass' }],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'textToAudio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      toolId: 'audiocraft-webui',
      audioMode: 'music',
      durationSeconds: 2,
      perItemValidation: { enabled: true, mode: 'user', maxAttempts: 2 },
    },
  });
  assert.strictEqual(analyzePipeline(manualAudioPipeline, { tools: mockedInstalledTools, toolCatalog: mockedInstalledTools }).executable, true, 'manual user validation should be available for mapped audio artifacts.');
  await runPipeline(manualAudioPipeline);
  const manualAudioPaused = await waitForRunStatus('paused');
  assert.strictEqual(manualAudioPaused.pendingValidation.artifact.kind, 'audio', 'manual audio validation should pause with the mapped audio artifact.');
  resumePendingValidation(manualAudioPaused, 'pass', 'audio is acceptable');
  const manualAudioFinished = await waitForRunToFinish();
  assert.strictEqual(manualAudioFinished.status, 'completed', manualAudioFinished.message);
  const manualAudioCollection = manualAudioFinished.nodeStates['map-collection'].outputs.collection;
  assert.strictEqual(manualAudioCollection.itemKind, 'audio');
  assert.strictEqual(manualAudioCollection.items[0].attempts[0].validation.mode, 'user', 'manual audio attempt metadata should record user validation.');

  const audioPerItemValidationAnalysis = analyzePipeline(buildCollectionInputMapPipeline({
    itemType: 'text',
    items: [{ id: 'audio-validation-prompt', text: 'rain' }],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'textToAudio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      toolId: 'audiocraft-webui',
      perItemValidation: { enabled: true, mode: 'llm', llmExecutionMode: 'cloud', providerId: 'openai', model: 'gpt-4o', ruleset: 'validate audio', maxAttempts: 2 },
    },
  }), { providers: [{ id: 'openai', name: 'OpenAI', isConnected: true }], tools: [createTool('audiocraft-webui', 'AudioCraft WebUI')], toolCatalog: [createTool('audiocraft-webui', 'AudioCraft WebUI')] });
  assert(audioPerItemValidationAnalysis.issues.some((issue) => /cannot validate mapped audio items inside Map Collection yet/i.test(issue.message)), 'unsupported mapped output validators should produce a clear capability issue.');

  const unsupportedImageAudio = buildCollectionInputMapPipeline({
    itemType: 'image',
    items: [{ id: 'bad-image', filePath: sourceImageA }],
    mapConfig: {
      executionMode: 'localTool',
      inputItemKind: 'image',
      outputItemKind: 'audio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      toolId: 'audiocraft-webui',
    },
  });
  const unsupportedImageAudioAnalysis = analyzePipeline(unsupportedImageAudio, { tools: [createTool('audiocraft-webui', 'AudioCraft WebUI')], toolCatalog: [createTool('audiocraft-webui', 'AudioCraft WebUI')] });
  assert(unsupportedImageAudioAnalysis.issues.some((issue) => /does not support that input\/output operation pair|does not accept image/i.test(issue.message)), 'unsupported collection mappings should be rejected honestly.');

  mockedInstalledTools = [createTool('audiocraft-webui', 'AudioCraft WebUI')];
  failSecondAudioGeneration = true;
  await runPipeline(textToAudioPipeline);
  const failedMapSnapshot = await waitForRunToFinish();
  failSecondAudioGeneration = false;
  assert.strictEqual(failedMapSnapshot.status, 'failed', 'per-item collectionMap failure should fail the node and run.');
  assert(/item 2 of 2.*prompt-b.*mock AudioCraft failure/i.test(failedMapSnapshot.message), 'per-item failure should identify item index and id: ' + failedMapSnapshot.message);

  console.log('Collection map pipeline verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});