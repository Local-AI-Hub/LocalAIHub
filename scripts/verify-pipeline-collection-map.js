const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-pipeline-collection-map');
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const WAVE_FIXTURE = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=', 'base64');
let failSecondAudioGeneration = false;
const localAudioGenerationRequests = [];
const localAudioStitchRequests = [];
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
          localAudioGenerationRequests.push({ ...request });
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
                  promptStyle: request.promptStyle,
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
        stitchAudioWithLocalAudioTool: async (_tool, request = {}) => {
          fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
          const outputPath = path.join(TEST_STORAGE_ROOT, 'cumulative-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.wav');
          localAudioStitchRequests.push({ ...request, outputPath });
          fs.writeFileSync(outputPath, WAVE_FIXTURE);
          return {
            outputPath,
            destinationPath: outputPath,
            metadata: {
              finalOutputDurationSeconds: localAudioStitchRequests.length + 1,
              outputPath,
              segmentAudioPath: request.segmentAudioPath || '',
              segmentDurationSeconds: 1,
              sourceAudioPath: request.sourceAudioPath || '',
              sourceDurationSeconds: localAudioStitchRequests.length,
            },
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
const { normalizeGraphWorkflowPresetRecord } = require('../electron/shared/graphWorkflowContracts.cjs');
const { getActiveRunSnapshot, resumePipelineValidation, runPipeline } = require('../electron/services/pipelineExecutionService');
const configService = require('../electron/services/configService');

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
  assert(builderPanelSource.includes('collection-map-audiocraft-item-mode'), 'collectionMap inspector should expose AudioCraft item mode.');
  assert(builderPanelSource.includes('sequentialContinuation'), 'collectionMap inspector should expose sequential AudioCraft continuation mode.');
  assert(builderPanelSource.includes('collection-map-chain-seed'), 'collectionMap inspector should expose seed seconds for chained AudioCraft maps.');
  assert(builderPanelSource.includes("assetKind: 'audiocraft-snapshot'"), 'collectionMap refresh should load AudioCraft snapshots.');
  assert(builderPanelSource.includes("assetKind: 'upscayl-model-set'"), 'collectionMap refresh should load Upscayl model sets.');
  assert(!builderPanelSource.includes('This mapping uses the selected tool default settings here. No refreshable model list is needed.'), 'collectionMap refresh should not use the stale generic no-models message for refreshable mappings.');

  const pipeline = buildCollectionMapPipeline({ mapConfig: { promptStyleId: 'style-anime-test' } });
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

  const graphPreset = normalizeGraphWorkflowPresetRecord({
    ...buildGraphCollectionMapConfig(),
    id: 'collection-text-image-preset',
    name: 'Collection text to image preset',
    toolId: 'comfyui',
  });
  assert.strictEqual(graphPreset.validation.ok, true, graphPreset.validation.message);
  const graphPresetPipeline = buildCollectionMapPipeline({ mapConfig: { executionMode: 'graphWorkflow', graphWorkflowPresetId: graphPreset.id, workflowSource: 'preset' } });
  const graphPresetAnalysis = analyzePipeline(graphPresetPipeline, { graphWorkflowPresets: [graphPreset], tools: mockedInstalledTools, toolCatalog: mockedInstalledTools });
  assert.strictEqual(graphPresetAnalysis.executable, true, graphPresetAnalysis.primaryIssue?.message);

  const incompatibleGraphPreset = {
    ...graphPreset,
    id: 'collection-image-image-preset',
    declaredContract: { inputKinds: ['image'], outputKinds: ['image'], operationFamily: 'imageToImage' },
  };
  const incompatiblePresetPipeline = buildCollectionMapPipeline({ mapConfig: { executionMode: 'graphWorkflow', graphWorkflowPresetId: incompatibleGraphPreset.id, workflowSource: 'preset' } });
  const incompatiblePresetAnalysis = analyzePipeline(incompatiblePresetPipeline, { graphWorkflowPresets: [incompatibleGraphPreset], tools: mockedInstalledTools, toolCatalog: mockedInstalledTools });
  assert(incompatiblePresetAnalysis.issues.some((issue) => /not compatible|declares image -> image/i.test(issue.message)), 'collectionMap should reject incompatible graph workflow presets.');

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

  await configService.upsertPromptStyle({ id: 'style-anime-test', name: 'Anime Test', targetKind: 'image', requiredTerms: ['anime film still', 'hand-painted background', 'soft sunlight'], negativePrompt: 'photorealistic, 3d render' });
  providerImageGenerationPrompts.length = 0;
  await runPipeline(pipeline);
  const snapshot = await waitForRunToFinish();
  assert.strictEqual(snapshot.status, 'completed', snapshot.message);
  const mapState = snapshot.nodeStates['map-prompts'];
  assert.strictEqual(mapState.outputs.collection.itemKind, 'image');
  assert.strictEqual(mapState.outputs.collection.itemCount, 2);
  assert.strictEqual(mapState.outputs.collection.items[0].lineage.sourceItemIndex, 0);
  assert.strictEqual(mapState.outputs.collection.items[1].lineage.sourceItemIndex, 1);
  assert(providerImageGenerationPrompts.every((prompt) => prompt.includes('anime film still') && prompt.includes('hand-painted background') && prompt.includes('soft sunlight')), 'collection text-to-image prompt style should apply required terms to every item prompt.');
  assert.strictEqual(mapState.outputs.collection.items[0].artifact.imageGeneration.promptStyle.id, 'style-anime-test', 'collection text-to-image metadata should record selected prompt style.');

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
      promptStyleId: 'style-cinematic-music',
    },
  });
  assert.strictEqual(analyzePipeline(textToAudioPipeline, { tools: mockedInstalledTools, toolCatalog: mockedInstalledTools }).executable, true, 'text-to-audio collectionMap should analyze as executable with AudioCraft.');
  await configService.upsertPromptStyle({ id: 'style-cinematic-music', name: 'Cinematic Music', targetKind: 'audio', requiredTerms: ['cinematic orchestral', 'dark ambient'] });
  localAudioGenerationRequests.length = 0;
  localAudioStitchRequests.length = 0;
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
  assert(textToAudioCollection.items.every((entry) => /cinematic orchestral/.test(entry.artifact.audioGeneration.prompt) && /dark ambient/.test(entry.artifact.audioGeneration.prompt)), 'collection text-to-audio prompt style should apply required terms to every item prompt.');
  assert.strictEqual(textToAudioCollection.items[0].artifact.audioGeneration.promptStyle.id, 'style-cinematic-music', 'collection text-to-audio metadata should record selected prompt style.');
  assert.strictEqual(localAudioGenerationRequests.length, 2, 'independent text-to-audio should generate each item once.');
  assert(localAudioGenerationRequests.every((request) => request.audioMode === 'music' && !request.sourceAudioPath), 'independent text-to-audio should not pass continuation sources.');
  assert.strictEqual(localAudioStitchRequests.length, 0, 'independent text-to-audio should not stitch cumulative AudioCraft chain audio.');

  localAudioGenerationRequests.length = 0;
  localAudioStitchRequests.length = 0;
  const sequentialChainPipeline = buildCollectionInputMapPipeline({
    itemType: 'text',
    items: [
      { id: 'chain-a', text: 'ominous ambient intro, low strings' },
      { id: 'chain-b', text: 'add distant percussion and rising tension' },
      { id: 'chain-c', text: 'sparse fading outro' },
    ],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'textToAudio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      toolId: 'audiocraft-webui',
      audiocraftItemMode: 'sequentialContinuation',
      continuationSeedSeconds: 3,
      durationSeconds: 2,
      instruction: 'Long-form cinematic cue.',
      promptStyleId: 'style-cinematic-music',
    },
  });
  const sequentialAnalysis = analyzePipeline(sequentialChainPipeline, { tools: mockedInstalledTools, toolCatalog: mockedInstalledTools });
  assert.strictEqual(sequentialAnalysis.executable, true, 'sequential AudioCraft collectionMap should analyze as executable only for local AudioCraft text-to-audio.');
  await runPipeline(sequentialChainPipeline);
  const sequentialSnapshot = await waitForRunToFinish();
  assert.strictEqual(sequentialSnapshot.status, 'completed', sequentialSnapshot.message);
  const sequentialCollection = sequentialSnapshot.nodeStates['map-collection'].outputs.collection;
  assert.strictEqual(sequentialCollection.itemKind, 'audio');
  assert.strictEqual(sequentialCollection.itemCount, 3, 'sequential chain should still output one segment artifact per source prompt.');
  assert.strictEqual(sequentialCollection.collectionMapping.audioContinuationChain.enabled, true, 'manifest metadata should record enabled continuation chain mode.');
  assert.strictEqual(sequentialCollection.collectionMapping.audioContinuationChain.outputMode, 'segments', 'sequential chain should keep collection output as generated segments.');
  assert(sequentialCollection.collectionMapping.audioContinuationChain.finalCombinedAudioPath, 'sequential chain metadata should record the final cumulative track path.');
  assert.deepStrictEqual(localAudioGenerationRequests.map((request) => request.audioMode), ['music', 'continuation', 'continuation'], 'sequential chain should generate the first item from scratch and later items as continuations.');
  assert.strictEqual(localAudioGenerationRequests[1].sourceAudioPath, sequentialCollection.items[0].artifact.filePath, 'item 2 should use item 1 as the first continuation source.');
  assert.strictEqual(localAudioGenerationRequests[2].sourceAudioPath, localAudioStitchRequests[0].outputPath, 'item 3 should use the current cumulative output as continuation source.');
  assert.strictEqual(localAudioStitchRequests.length, 2, 'sequential chain should stitch a cumulative source after each continuation segment.');
  assert.notStrictEqual(sequentialCollection.items[1].artifact.filePath, localAudioStitchRequests[0].outputPath, 'item 2 output should remain the generated segment, not the cumulative WAV.');
  assert.strictEqual(sequentialCollection.items[1].metadata.audioContinuationChain.seedSeconds, 3, 'item metadata should record continuation seed seconds.');
  assert.strictEqual(sequentialCollection.items[1].metadata.audioContinuationChain.previousArtifact.filePath, sequentialCollection.items[0].artifact.filePath, 'item metadata should reference the previous accepted segment.');
  assert(sequentialCollection.items.every((entry) => /cinematic orchestral/.test(entry.artifact.audioGeneration.prompt)), 'prompt style should still apply to each chained AudioCraft item.');

  localAudioGenerationRequests.length = 0;
  localAudioStitchRequests.length = 0;
  const manualSequentialChainPipeline = buildCollectionInputMapPipeline({
    itemType: 'text',
    items: [
      { id: 'chain-retry-a', text: 'soft opening drone' },
      { id: 'chain-retry-b', text: 'rising percussion layer' },
    ],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'textToAudio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      toolId: 'audiocraft-webui',
      audiocraftItemMode: 'sequentialContinuation',
      continuationSeedSeconds: 4,
      durationSeconds: 2,
      perItemValidation: { enabled: true, mode: 'user', maxAttempts: 2 },
    },
  });
  await runPipeline(manualSequentialChainPipeline);
  let chainManualSnapshot = await waitForRunStatus('paused');
  resumePendingValidation(chainManualSnapshot, 'pass', 'first section works');
  chainManualSnapshot = await waitForRunStatus('paused');
  assert.strictEqual(chainManualSnapshot.pendingValidation.collectionMap.itemIndex, 1, 'chain validation should move to item 2 after item 1 passes.');
  const acceptedFirstChainPath = localAudioGenerationRequests[1].sourceAudioPath;
  resumePendingValidation(chainManualSnapshot, 'fail', 'retry the second section');
  chainManualSnapshot = await waitForRunStatus('paused');
  assert.strictEqual(chainManualSnapshot.pendingValidation.collectionMap.itemIndex, 1, 'chain validation retry should stay on item 2.');
  assert.strictEqual(localAudioGenerationRequests.filter((request) => /soft opening drone/i.test(request.prompt || '')).length, 1, 'chain validation retry should not rerun prior accepted items.');
  assert.strictEqual(localAudioGenerationRequests.filter((request) => /rising percussion layer/i.test(request.prompt || '')).length, 2, 'chain validation retry should regenerate only the failed chain item.');
  assert.strictEqual(localAudioGenerationRequests[1].sourceAudioPath, localAudioGenerationRequests[2].sourceAudioPath, 'chain retry should reuse the same previous accepted cumulative source.');
  assert.strictEqual(localAudioGenerationRequests[1].sourceAudioPath, acceptedFirstChainPath, 'chain retry source should be the previously accepted cumulative audio.');
  resumePendingValidation(chainManualSnapshot, 'pass', 'retry works');
  chainManualSnapshot = await waitForRunToFinish();
  assert.strictEqual(chainManualSnapshot.status, 'completed', chainManualSnapshot.message);

  localAudioGenerationRequests.length = 0;
  localAudioStitchRequests.length = 0;
  failSecondAudioGeneration = true;
  const partialSequentialChainPipeline = buildCollectionInputMapPipeline({
    itemType: 'text',
    items: [
      { id: 'chain-partial-a', text: 'soft rain on glass' },
      { id: 'chain-partial-b', text: 'city street at sunrise' },
      { id: 'chain-partial-c', text: 'distant thunder' },
    ],
    mapConfig: {
      executionMode: 'localTool',
      failureMode: 'partial',
      mappingId: 'textToAudio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      toolId: 'audiocraft-webui',
      audiocraftItemMode: 'sequentialContinuation',
      durationSeconds: 2,
    },
  });
  await runPipeline(partialSequentialChainPipeline);
  let partialSequentialSnapshot = await waitForRunToFinish();
  failSecondAudioGeneration = false;
  assert.strictEqual(partialSequentialSnapshot.status, 'completed', partialSequentialSnapshot.message);
  const partialSequentialCollection = partialSequentialSnapshot.nodeStates['map-collection'].outputs.collection;
  assert.strictEqual(partialSequentialCollection.itemCount, 1, 'partial chain output should contain only successful accepted segments before the broken item.');
  assert.strictEqual(partialSequentialCollection.failedItems[0].chainFailure, true, 'partial chain failure metadata should mark the chain as broken.');
  assert.strictEqual(localAudioGenerationRequests.length, 2, 'partial chain should stop at the failed item and skip later prompts.');

  localAudioGenerationRequests.length = 0;
  failSecondAudioGeneration = true;
  const failedSequentialChainPipeline = buildCollectionInputMapPipeline({
    itemType: 'text',
    items: [
      { id: 'chain-fail-a', text: 'soft rain on glass' },
      { id: 'chain-fail-b', text: 'city street at sunrise' },
    ],
    mapConfig: {
      executionMode: 'localTool',
      mappingId: 'textToAudio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      toolId: 'audiocraft-webui',
      audiocraftItemMode: 'sequentialContinuation',
      durationSeconds: 2,
    },
  });
  await runPipeline(failedSequentialChainPipeline);
  const failedSequentialSnapshot = await waitForRunToFinish();
  failSecondAudioGeneration = false;
  assert.strictEqual(failedSequentialSnapshot.status, 'failed', 'chain failure without partial success should fail the map normally.');
  assert(/item 2 of 2.*mock AudioCraft failure/i.test(failedSequentialSnapshot.message), 'failed chain should report the broken item and plain-English reason.');

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
  perItemValidationRequests.length = 0;
  perItemValidationDecisionsByItemLabel.clear();
  const partialValidationFailurePipeline = buildCollectionMapPipeline({
    mapConfig: {
      failureMode: 'partial',
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
  await runPipeline(partialValidationFailurePipeline);
  const partialValidationFailureSnapshot = await waitForRunToFinish();
  assert.strictEqual(partialValidationFailureSnapshot.status, 'completed', partialValidationFailureSnapshot.message);
  const partialValidationMapState = partialValidationFailureSnapshot.nodeStates['map-prompts'];
  assert.strictEqual(partialValidationMapState.selectedBranch, 'partial', 'partial validation failure should mark the map branch as partial.');
  const partialValidationCollection = partialValidationMapState.outputs.collection;
  assert.strictEqual(partialValidationCollection.collectionStatus, 'partial', 'partial validation output should be marked partial.');
  assert.strictEqual(partialValidationCollection.partial, true, 'partial validation output should carry a partial flag.');
  assert.strictEqual(partialValidationCollection.itemCount, 1, 'partial validation output should include only previous successful items.');
  assert.strictEqual(partialValidationCollection.sourceItemCount, 2, 'partial validation manifest should record the original source count.');
  assert.strictEqual(partialValidationCollection.failedItemCount, 1, 'partial validation manifest should record one failed item.');
  assert.strictEqual(partialValidationCollection.failedItems[0].sourceItemIndex, 1, 'failed validation metadata should preserve the failed source index.');
  assert(partialValidationCollection.failedItems[0].sourceItemId, 'failed validation metadata should include the failed source item id.');
  assert.strictEqual(partialValidationCollection.failedItems[0].failureKind, 'validation', 'failed validation metadata should identify validation failures.');
  assert.strictEqual(partialValidationCollection.failedItems[0].attempts.length, 1, 'failed validation metadata should keep attempt metadata.');
  assert.strictEqual(partialValidationCollection.items[0].lineage.sourceItemIndex, 0, 'partial validation output should preserve successful item lineage.');
  assert.strictEqual(partialValidationCollection.items.some((entry) => entry.lineage.sourceItemIndex === 1), false, 'failed validation artifact should not be included as a successful final item.');
  const partialValidationOutput = partialValidationFailureSnapshot.nodeStates['image-output'].outputs.collection;
  assert.strictEqual(partialValidationOutput.collectionStatus, 'partial', 'Collection Output should preserve partial status for explicit partial inputs.');
  assert.strictEqual(partialValidationOutput.failedItemCount, 1, 'Collection Output should preserve failed item metadata count.');
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
  const partialTextToAudioPipeline = buildCollectionInputMapPipeline({
    itemType: 'text',
    items: [
      { id: 'partial-a', text: 'soft rain on glass' },
      { id: 'partial-b', text: 'city street at sunrise' },
      { id: 'partial-c', text: 'distant thunder' },
    ],
    mapConfig: {
      executionMode: 'localTool',
      failureMode: 'partial',
      mappingId: 'textToAudio',
      operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      toolId: 'audiocraft-webui',
      audioMode: 'music',
      durationSeconds: 2,
      instruction: 'Short ambient loop.',
    },
  });
  failSecondAudioGeneration = true;
  await runPipeline(partialTextToAudioPipeline);
  const partialOperationSnapshot = await waitForRunToFinish();
  failSecondAudioGeneration = false;
  assert.strictEqual(partialOperationSnapshot.status, 'completed', partialOperationSnapshot.message);
  const partialOperationMapState = partialOperationSnapshot.nodeStates['map-collection'];
  assert.strictEqual(partialOperationMapState.selectedBranch, 'partial', 'partial operation failure should mark the map branch as partial.');
  const partialOperationCollection = partialOperationMapState.outputs.collection;
  assert.strictEqual(partialOperationCollection.collectionStatus, 'partial', 'partial operation output should be marked partial.');
  assert.strictEqual(partialOperationCollection.itemCount, 1, 'partial operation output should keep only successful items before the failure.');
  assert.strictEqual(partialOperationCollection.sourceItemCount, 3, 'partial operation manifest should record all source items.');
  assert.strictEqual(partialOperationCollection.successfulItemCount, 1, 'partial operation manifest should record successful item count.');
  assert.strictEqual(partialOperationCollection.failedItemCount, 1, 'partial operation manifest should record failed item count.');
  assert.strictEqual(partialOperationCollection.items[0].itemId, 'partial-a', 'partial operation output should preserve successful source item ids.');
  assert.deepStrictEqual(partialOperationCollection.items.map((entry) => entry.lineage.sourceItemIndex), [0], 'partial operation output should preserve successful item order.');
  assert.strictEqual(partialOperationCollection.failedItems[0].sourceItemIndex, 1, 'partial operation failure metadata should include failed item index.');
  assert.strictEqual(partialOperationCollection.failedItems[0].sourceItemId, 'partial-b', 'partial operation failure metadata should include failed item id.');
  assert(/mock AudioCraft failure/i.test(partialOperationCollection.failedItems[0].reason), 'partial operation failure metadata should include the plain-English reason.');
  assert.strictEqual(partialOperationCollection.items.some((entry) => /partial-b/.test(entry.itemId)), false, 'failed operation item should not be included as a successful final item.');
  const partialOperationOutput = partialOperationSnapshot.nodeStates['mapped-output'].outputs.collection;
  assert.strictEqual(partialOperationOutput.collectionStatus, 'partial', 'Collection Output should save partial operation collections honestly.');
  assert.strictEqual(partialOperationOutput.failedItems[0].sourceItemId, 'partial-b', 'Collection Output should preserve failed item details.');
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