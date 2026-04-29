const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-model-step-local-image-runtime');
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const generatedRequests = [];
let mockedInstalledTools = [];

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
      shell: { openExternal: async () => {}, openPath: async () => '' },
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

  if (normalizedParent.endsWith('/electron/services/pipelineToolOrchestrationService.js') && request === './processService') {
    return {
      isToolActive: async () => true,
      isToolReady: async () => true,
      launchToolFromUserAction: async (tool) => ({ ...tool, status: 'running' }),
      stopTool: async () => {},
    };
  }

  if (normalizedParent.endsWith('/electron/services/pipelineExecutionService.js')) {
    if (request === './providerRegistry') return { initializeProviderRegistry: async () => {} };
    if (request === './providerService') {
      return {
        chatWithProvider: async () => ({ message: { content: 'ok' } }),
        listProviderConnections: async () => [],
        runProviderOperation: async () => { throw new Error('Local image runtime verifier should not use cloud image providers.'); },
      };
    }
    if (request === './toolRegistry') return { getToolCatalog: () => mockedInstalledTools, initializeToolRegistry: async () => {} };
    if (request === './toolStateService') return { buildMergedToolStateList: async () => mockedInstalledTools, getResolvedToolState: async (toolId) => mockedInstalledTools.find((tool) => tool.id === toolId) || null };
    if (request === './workflowToolService') {
      return {
        generateImageWithWorkflowTool: async (tool, options) => {
          generatedRequests.push({ toolId: tool.id, model: options.model, prompt: options.prompt });
          return { base64Image: ONE_PIXEL_PNG, info: '{}' };
        },
        interrogateImageWithWorkflowTool: async () => ({ text: 'mock caption' }),
        resolveSelectedImageTool: (_contextMaps, node) => mockedInstalledTools.find((tool) => tool.id === String(node?.config?.toolId || '').trim()) || mockedInstalledTools[0] || null,
      };
    }
  }

  return originalLoad.call(this, request, parent, isMain);
};

const {
  PIPELINE_OPERATION_IDS,
  createEdge,
  createEmptyPipeline,
  createNode,
} = require('../electron/shared/pipelineSchema.cjs');
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
  throw new Error('Timed out waiting for Model Step local image runtime verifier.');
}

function createForgeTool() {
  return {
    id: 'forge',
    name: 'Stable Diffusion WebUI Forge',
    appDir: 'C:/mock/forge/app',
    installDir: 'C:/mock/forge',
    launchProfile: { kind: 'folder', path: 'C:/mock/forge/app' },
    launchUrl: 'http://127.0.0.1:7860',
    status: 'running',
    downloadedModels: [{
      title: 'runtimeModel.safetensors [abcdef1234]',
      model_name: 'runtimeModel',
      filename: 'D:/LocalAIHub/tools/forge/app/models/Stable-diffusion/runtimeModel.safetensors',
      fileName: 'runtimeModel.safetensors',
      hash: 'abcdef1234',
      modelType: 'checkpoint',
      backendVisible: true,
    }],
    pipelineCapabilities: {
      operations: {
        [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: { inputKinds: ['text'], outputKinds: ['image'] },
      },
    },
  };
}

function buildModelStepLocalImagePipeline() {
  const prompt = createNode('textInput', { id: 'prompt', label: 'Prompt', config: { text: 'a quiet cabin' } });
  const model = createNode('llmPrompt', {
    id: 'model-step',
    label: 'Model Step',
    config: {
      executionMode: 'localTool',
      operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
      toolId: 'forge',
      model: 'runtimeModel.safetensors [abcdef1234]',
      width: 512,
      height: 512,
      steps: 4,
    },
  });
  const output = createNode('imageOutput', { id: 'output', label: 'Image Output', config: { title: 'Runtime image' } });
  return createEmptyPipeline({
    id: 'model-step-local-image-runtime',
    name: 'Model Step local image runtime verifier',
    nodes: [prompt, model, output],
    edges: [
      createEdge(prompt.id, 'text', model.id, 'prompt'),
      createEdge(model.id, 'image', output.id, 'image'),
    ],
  });
}

async function main() {
  fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
  mockedInstalledTools = [createForgeTool()];

  await runPipeline(buildModelStepLocalImagePipeline());
  const snapshot = await waitForRunToFinish();
  assert.strictEqual(snapshot.status, 'completed', snapshot.message);
  assert.strictEqual(generatedRequests.length, 1, 'Model Step local image generation should reach the shared workflow tool runtime path once.');
  assert.strictEqual(generatedRequests[0].toolId, 'forge');
  assert.strictEqual(generatedRequests[0].model, 'runtimeModel.safetensors [abcdef1234]', 'Runtime should pass the selected checkpoint value through to live backend validation/generation.');
  assert(/quiet cabin/i.test(generatedRequests[0].prompt), 'Runtime should pass the Text Input prompt to local image generation.');

  console.log('Model Step local image runtime verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});