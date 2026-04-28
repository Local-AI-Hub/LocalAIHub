const assert = require('assert');
const path = require('path');
const Module = require('module');
const {
  buildPipelineGraph,
  createEdge,
  getNodeTypeDefinition,
  getPipelineNodePorts,
  getPortDefinition,
} = require('../electron/shared/pipelineSchema.cjs');

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

async function main() {
  verifyGraphWorkflowPortContracts();
  await verifyLateStartupWait();
  await verifySharedLaunchFailure();
  console.log('Graph workflow orchestration verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
