const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const {
  analyzePipeline,
  buildPipelineGraph,
  createEdge,
  createEmptyPipeline,
  createNode,
  getNodeTypeDefinition,
  getPipelineNodePorts,
  getPortDefinition,
} = require('../electron/shared/pipelineSchema.cjs');
const {
  getGraphWorkflowOperationBackendSupport,
  normalizeGraphWorkflowPresetRecord,
} = require('../electron/shared/graphWorkflowContracts.cjs');

function loadOrchestratorWithStubs(stubs) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
    if (normalizedParent.endsWith('/electron/services/pipelineToolOrchestrationService.js')) {
      if (request === '../shared/pipelineSchema.cjs') {
        return {
          getLocalToolRequirement: (node) => String(node?.config?.toolId || '').trim().toLowerCase(),
        };
      }

      if (request === './processService') {
        return stubs.processService;
      }

      if (request === './toolStateService') {
        return stubs.toolStateService;
      }
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = path.resolve(__dirname, '..', 'electron', 'services', 'pipelineToolOrchestrationService.js');
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createToolState(status, extra = {}) {
  return {
    defaultPort: 8188,
    healthUrl: 'http://127.0.0.1:8188/',
    id: 'comfyui',
    launchUrl: 'http://127.0.0.1:8188',
    name: 'ComfyUI',
    startupTimeoutMs: 500,
    status,
    ...extra,
  };
}

async function verifyLateStartupWait() {
  const stateSequence = [
    createToolState('starting'),
    createToolState('running'),
  ];
  let resolveCalls = 0;
  let launchCalls = 0;
  let stopCalls = 0;
  const progressMessages = [];

  const { createPipelineToolOrchestrator } = loadOrchestratorWithStubs({
    processService: {
      isToolActive: async (tool) => String(tool?.status || '').trim().toLowerCase() !== 'stopped',
      isToolReady: async (tool) => String(tool?.status || '').trim().toLowerCase() === 'running',
      launchToolFromUserAction: async () => {
        launchCalls += 1;
        return createToolState('starting');
      },
      stopTool: async () => {
        stopCalls += 1;
      },
    },
    toolStateService: {
      getResolvedToolState: async () => {
        const index = Math.min(resolveCalls, stateSequence.length - 1);
        const nextTool = stateSequence[index];
        resolveCalls += 1;
        return nextTool;
      },
    },
  });

  const orchestrator = createPipelineToolOrchestrator({
    toolsById: {
      comfyui: createToolState('stopped'),
    },
  });

  const session = await orchestrator.ensureToolForNode(
    {
      config: {
        toolId: 'comfyui',
      },
      label: 'Graph Workflow',
    },
    (message) => progressMessages.push(message),
  );

  assert.strictEqual(launchCalls, 1, 'Expected the orchestrator to launch the tool once.');
  assert.strictEqual(session.tool.status, 'running', 'Expected the orchestrator to wait until the tool became ready.');
  assert.strictEqual(stopCalls, 0, 'Expected the late-start path to keep the tool running.');
  assert(resolveCalls >= 2, 'Expected the orchestrator to poll tool state while waiting for readiness.');
  assert(progressMessages.some((message) => String(message).includes('Waiting for ComfyUI') || String(message).includes('ComfyUI is still starting')), 'Expected readiness progress updates while waiting.');
}

async function verifySharedLaunchFailure() {
  const stateSequence = [
    createToolState('starting'),
    createToolState('error', {
      lastError: 'ComfyUI stopped before it became available on http://127.0.0.1:8188/. Open the logs folder for the full launch details.',
    }),
  ];
  let resolveCalls = 0;

  const { createPipelineToolOrchestrator } = loadOrchestratorWithStubs({
    processService: {
      isToolActive: async (tool) => String(tool?.status || '').trim().toLowerCase() !== 'stopped',
      isToolReady: async (tool) => String(tool?.status || '').trim().toLowerCase() === 'running',
      launchToolFromUserAction: async () => createToolState('starting'),
      stopTool: async () => {},
    },
    toolStateService: {
      getResolvedToolState: async () => {
        const index = Math.min(resolveCalls, stateSequence.length - 1);
        const nextTool = stateSequence[index];
        resolveCalls += 1;
        return nextTool;
      },
    },
  });

  const orchestrator = createPipelineToolOrchestrator({
    toolsById: {
      comfyui: createToolState('stopped'),
    },
  });

  await assert.rejects(
    () => orchestrator.ensureToolForNode(
      {
        config: {
          toolId: 'comfyui',
        },
        label: 'Graph Workflow',
      },
      () => {},
    ),
    /ComfyUI stopped before it became available/,
    'Expected the orchestrator to surface the shared launcher failure once the tool entered an error state.',
  );
}

function createGraphWorkflowNode(toolId) {
  return {
    config: {
      toolId,
    },
    id: 'graph-1',
    label: 'Graph Workflow',
    position: { x: 0, y: 0 },
    type: 'graphWorkflow',
  };
}

function verifyGraphWorkflowPortContracts() {
  const staticOutputPortIds = (getNodeTypeDefinition('graphWorkflow')?.outputPorts || []).map((port) => port.id);
  assert.deepStrictEqual(staticOutputPortIds, ['image', 'video'], 'Expected the static Graph Workflow schema fallback to avoid unsupported audio output.');

  const comfyNode = createGraphWorkflowNode('comfyui');
  const comfyOutputPortIds = getPipelineNodePorts(comfyNode, 'output').map((port) => port.id);
  assert.deepStrictEqual(comfyOutputPortIds, ['image', 'video'], 'Expected ComfyUI graph workflows to expose image and video outputs.');
  assert.strictEqual(getPortDefinition(comfyNode, 'output', 'audio'), null, 'Expected ComfyUI graph workflows not to expose audio output.');

  const invokeNode = createGraphWorkflowNode('invokeai');
  const invokeOutputPortIds = getPipelineNodePorts(invokeNode, 'output').map((port) => port.id);
  assert.deepStrictEqual(invokeOutputPortIds, ['image'], 'Expected InvokeAI graph workflows to expose image output only.');
  assert.strictEqual(getPortDefinition(invokeNode, 'output', 'video'), null, 'Expected InvokeAI graph workflows not to expose video output.');
  assert.strictEqual(getPortDefinition(invokeNode, 'output', 'audio'), null, 'Expected InvokeAI graph workflows not to expose audio output.');

  const validComfyGraph = buildPipelineGraph({
    nodes: [
      comfyNode,
      { config: {}, id: 'video-out', label: 'Video Output', position: { x: 320, y: 0 }, type: 'videoOutput' },
    ],
    edges: [createEdge('graph-1', 'video', 'video-out', 'video')],
  });
  assert.deepStrictEqual(validComfyGraph.errors, [], 'Expected ComfyUI video graph workflow wiring to remain valid.');

  const invalidInvokeAudioGraph = buildPipelineGraph({
    nodes: [
      invokeNode,
      { config: {}, id: 'audio-out', label: 'Audio Output', position: { x: 320, y: 0 }, type: 'audioOutput' },
    ],
    edges: [createEdge('graph-1', 'audio', 'audio-out', 'audio')],
  });
  assert(invalidInvokeAudioGraph.errors.some((message) => message.includes('invalid connection')), 'Expected audio wiring from InvokeAI graph workflow to be rejected.');
}

function buildPresetWorkflowConfig() {
  return {
    toolId: 'comfyui',
    workflowFormat: 'comfyui-api-json',
    workflowText: JSON.stringify({
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'prompt' } },
      '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
    }),
    inputBindings: { text: { mode: 'node-field', nodeId: '6', field: 'text' } },
    outputBindings: { image: { mode: 'node-output', nodeId: '9' } },
  };
}

function loadConfigServiceWithTempRoots(tempRoot) {
  const originalLoad = Module._load;
  Module._load = function patchedElectronLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getPath(name) {
            if (name === 'appData') return path.join(tempRoot, 'Roaming');
            if (name === 'home') return path.join(tempRoot, 'Home');
            if (name === 'exe') return process.execPath;
            return path.join(tempRoot, String(name || 'path'));
          },
        },
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = path.resolve(__dirname, '..', 'electron', 'services', 'configService.js');
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

async function verifyGraphWorkflowPresetPersistence() {
  const tempRoot = path.join(process.cwd(), 'temp', 'verify-graph-workflow-presets');
  assert(tempRoot.startsWith(path.join(process.cwd(), 'temp')), 'Preset verifier temp path must stay under the repo temp directory.');
  fs.rmSync(tempRoot, { force: true, recursive: true });

  const configService = loadConfigServiceWithTempRoots(tempRoot);
  for (const functionName of ['listGraphWorkflowPresets', 'upsertGraphWorkflowPreset', 'deleteGraphWorkflowPreset']) {
    assert.strictEqual(typeof configService[functionName], 'function', 'configService should export ' + functionName + ' for graph workflow preset IPC handlers.');
  }
  await configService.ensureStorage();
  let presets = await configService.listGraphWorkflowPresets();
  assert.deepStrictEqual(presets, [], 'Expected a fresh config to start with an empty graph workflow preset list.');

  await configService.upsertGraphWorkflowPreset({
    ...buildPresetWorkflowConfig(),
    id: 'preset-persisted-text-image',
    name: 'Persisted text to image preset',
  });

  presets = await configService.listGraphWorkflowPresets();
  assert.strictEqual(presets.length, 1, 'Expected the saved graph workflow preset to appear in listGraphWorkflowPresets.');
  assert.strictEqual(presets[0].id, 'preset-persisted-text-image');
  assert.strictEqual(presets[0].validation.ok, true, presets[0].validation.message);

  const configPath = configService.getAppPaths().configFile;
  const persistedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(persistedConfig.graphWorkflowPresets.length, 1, 'Expected graphWorkflowPresets to persist into config.json.');

  await assert.rejects(
    () => configService.upsertGraphWorkflowPreset({ id: 'invalid-preset', name: 'Invalid preset', toolId: 'comfyui' }),
    /workflow JSON|workflow definition|typed input boundary|typed output boundary/i,
    'Expected invalid graph workflow presets to fail with a clear validation message.',
  );

  await configService.deleteGraphWorkflowPreset('preset-persisted-text-image');
  presets = await configService.listGraphWorkflowPresets();
  assert.deepStrictEqual(presets, [], 'Expected deleting the preset to refresh the persisted preset list.');
  fs.rmSync(tempRoot, { force: true, recursive: true });
}

function verifyGraphWorkflowPresetContracts() {
  const preset = normalizeGraphWorkflowPresetRecord({
    ...buildPresetWorkflowConfig(),
    id: 'preset-text-image',
    name: 'Text to image preset',
  }, { now: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(preset.validation.ok, true, preset.validation.message);
  assert.deepStrictEqual(preset.declaredContract.inputKinds, ['text']);
  assert.deepStrictEqual(preset.declaredContract.outputKinds, ['image']);
  assert.strictEqual(preset.declaredContract.operationFamily, 'textToImage');

  const source = createNode('textInput', { id: 'source', config: { text: 'hello' } });
  const graphNode = createNode('graphWorkflow', {
    id: 'graph-preset',
    config: {
      graphWorkflowPresetId: preset.id,
      toolId: 'comfyui',
      workflowSource: 'preset',
    },
  });
  const output = createNode('imageOutput', { id: 'output' });
  const pipeline = createEmptyPipeline({
    nodes: [source, graphNode, output],
    edges: [
      createEdge(source.id, 'text', graphNode.id, 'text'),
      createEdge(graphNode.id, 'image', output.id, 'image'),
    ],
  });
  const tools = [createToolState('running')];
  const analysis = analyzePipeline(pipeline, { graphWorkflowPresets: [preset], tools, toolCatalog: tools });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message);

  const missingPresetAnalysis = analyzePipeline(pipeline, { graphWorkflowPresets: [], tools, toolCatalog: tools });
  assert(missingPresetAnalysis.issues.some((issue) => /preset could not be found/i.test(issue.message)), 'Expected a clear missing preset readiness issue.');

  const incompatiblePreset = {
    ...preset,
    declaredContract: { inputKinds: ['image'], outputKinds: ['image'], operationFamily: 'imageToImage' },
  };
  const support = getGraphWorkflowOperationBackendSupport({
    config: { graphWorkflowPresetId: incompatiblePreset.id, workflowSource: 'preset' },
    id: 'map',
    label: 'Map',
    type: 'collectionMap',
  }, undefined, { graphWorkflowPresets: [incompatiblePreset] });
  assert.strictEqual(support.usable, false);
  assert(/not compatible/i.test(support.message), 'Expected incompatible preset support to be rejected clearly.');
}

function verifyPipelineBuilderGraphWorkflowPresetSourceGuards() {
  const panelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'PipelineBuilderPanel.jsx'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'App.jsx'), 'utf8');
  const configSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'services', 'configService.js'), 'utf8');
  const uiSource = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'pipeline-ui.js'), 'utf8');
  const sharedDestructure = panelSource.slice(panelSource.indexOf('const {', panelSource.indexOf('toolAssetSelectionShared')), panelSource.indexOf('} = pipelineShared;'));
  for (const identifier of [
    'buildGraphWorkflowConfigFromPreset',
    'getGraphWorkflowPresetContractSummary',
    'isGraphWorkflowPresetCompatibleWithOperation',
    'resolveGraphWorkflowPresetNode',
  ]) {
    assert(sharedDestructure.includes(identifier), 'PipelineBuilderPanel should import ' + identifier + ' from pipelineShared before using it in the Graph Workflow inspector.');
  }

  assert(panelSource.includes('function formatGraphWorkflowPresetSummary'), 'Graph Workflow preset summary helper should be declared before inspector render uses it.');
  assert(panelSource.includes('id="graph-workflow-preset-select"'), 'Graph Workflow inspector should render a saved preset selector.');
  assert(panelSource.includes('id="graph-workflow-preset-name"'), 'Graph Workflow inspector should render an inline preset name input instead of relying on unsupported prompt().');
  assert(panelSource.includes('graphWorkflowPresetStatus'), 'Graph Workflow inspector should keep visible preset save status for success and validation errors.');
  assert(!panelSource.includes('window.prompt('), 'Graph Workflow preset saving must not use window.prompt because Electron disables it in this app.');
  assert(panelSource.includes('saveGraphWorkflowPreset(buildGraphWorkflowPresetPayload'), 'Graph Workflow preset saving should call the preload IPC API with a normalized payload.');
  assert(panelSource.includes('buildPipelineDisplayContext({ graphWorkflowPresets,'), 'PipelineBuilderPanel should pass current graph workflow presets into renderer analysis.');
  assert(panelSource.includes('const EMPTY_GRAPH_WORKFLOW_PRESETS = Object.freeze([]);'), 'PipelineBuilderPanel should use a stable empty preset default so local preset state is not reset after save.');
  assert(!panelSource.includes('initialGraphWorkflowPresets = []'), 'PipelineBuilderPanel should not default graphWorkflowPresets to a fresh array on every render.');
  assert(panelSource.includes('setGraphWorkflowPresets(presets);'), 'PipelineBuilderPanel save/list/delete paths should update the renderer preset state.');
  assert(panelSource.includes('{graphWorkflowPresets.map((preset) => <option'), 'Graph Workflow dropdown should render saved preset options from renderer preset state.');
  assert(panelSource.includes('No graph workflow presets saved yet.'), 'Graph Workflow inspector should render a safe empty preset state.');
  assert(appSource.includes('graphWorkflowPresets: []'), 'App empty state should include graphWorkflowPresets for a stable prop shape.');
  assert(appSource.includes('graphWorkflowPresets={appState.graphWorkflowPresets}'), 'App should pass bootstrapped graph workflow presets into PipelineBuilderPanel.');
  assert(mainSource.includes('graphWorkflowPresets: latestConfig.graphWorkflowPresets || []'), 'buildAppState should include persisted graph workflow presets for newly mounted Pipeline Builder views.');
  for (const functionName of ['listGraphWorkflowPresets', 'upsertGraphWorkflowPreset', 'deleteGraphWorkflowPreset']) {
    assert(mainSource.includes(functionName), 'main.js should import/call ' + functionName + ' for graph workflow preset IPC.');
    assert(configSource.includes(functionName + ','), 'configService should export ' + functionName + '.');
  }
  assert(mainSource.includes("ipcMain.handle('graph-workflow-presets:list'") && mainSource.includes('await listGraphWorkflowPresets()'), 'main.js should wire graph workflow preset list IPC to listGraphWorkflowPresets.');
  assert(mainSource.includes("ipcMain.handle('graph-workflow-presets:save'") && mainSource.includes('await upsertGraphWorkflowPreset(payload || {})'), 'main.js should wire graph workflow preset save IPC to upsertGraphWorkflowPreset.');
  assert(mainSource.includes("ipcMain.handle('graph-workflow-presets:delete'") && mainSource.includes('await deleteGraphWorkflowPreset(presetId)'), 'main.js should wire graph workflow preset delete IPC to deleteGraphWorkflowPreset.');
  assert(preloadSource.includes("listGraphWorkflowPresets: () => invoke('graph-workflow-presets:list')"), 'preload should expose listGraphWorkflowPresets using the matching IPC channel.');
  assert(preloadSource.includes("saveGraphWorkflowPreset: (payload) => invoke('graph-workflow-presets:save', payload)"), 'preload should expose saveGraphWorkflowPreset using the matching IPC channel.');
  assert(preloadSource.includes("deleteGraphWorkflowPreset: (presetId) => invoke('graph-workflow-presets:delete', presetId)"), 'preload should expose deleteGraphWorkflowPreset using the matching IPC channel.');
  assert(uiSource.includes('graphWorkflowPresets,'), 'Pipeline display context should carry graph workflow presets into analysis.');
}

async function main() {
  verifyGraphWorkflowPortContracts();
  verifyGraphWorkflowPresetContracts();
  verifyPipelineBuilderGraphWorkflowPresetSourceGuards();
  await verifyGraphWorkflowPresetPersistence();
  await verifyLateStartupWait();
  await verifySharedLaunchFailure();
  console.log('Graph workflow orchestration verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
