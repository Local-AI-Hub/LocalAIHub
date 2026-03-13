const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const {
  GRAPH_WORKFLOW_BINDING_MODE_IDS,
  parseGraphWorkflowDefinitionText,
} = require('../electron/shared/graphWorkflowContracts.cjs');

const invokeWorkflowFixture = {
  id: 'workflow-1',
  name: 'Invoke Fixture',
  author: 'Local AI Hub',
  description: 'Fixture for InvokeAI graph workflow parsing',
  version: '1.0.0',
  contact: '',
  tags: 'test',
  notes: '',
  exposedFields: [
    { nodeId: 'prompt-node', fieldName: 'prompt' },
    { nodeId: 'image-node', fieldName: 'image' },
  ],
  meta: {
    category: 'user',
    version: '3.0.0',
  },
  nodes: [
    {
      id: 'prompt-node',
      type: 'invocation',
      position: { x: 0, y: 0 },
      data: {
        id: 'prompt-node',
        type: 'compel',
        version: '1.0.0',
        label: 'Prompt',
        notes: '',
        isOpen: true,
        isIntermediate: true,
        useCache: true,
        nodePack: 'invokeai',
        inputs: {
          prompt: {
            name: 'prompt',
            label: 'Prompt',
            value: 'original prompt',
          },
        },
      },
    },
    {
      id: 'image-node',
      type: 'invocation',
      position: { x: 0, y: 160 },
      data: {
        id: 'image-node',
        type: 'flux_vae_encode',
        version: '1.0.0',
        label: 'Input Image',
        notes: '',
        isOpen: true,
        isIntermediate: true,
        useCache: true,
        nodePack: 'invokeai',
        inputs: {
          image: {
            name: 'image',
            label: 'Image',
          },
          vae: {
            name: 'vae',
            label: 'VAE',
          },
        },
      },
    },
    {
      id: 'output-node',
      type: 'invocation',
      position: { x: 240, y: 80 },
      data: {
        id: 'output-node',
        type: 'flux_vae_decode',
        version: '1.0.0',
        label: 'Output',
        notes: '',
        isOpen: true,
        isIntermediate: false,
        useCache: true,
        nodePack: 'invokeai',
        inputs: {
          latents: {
            name: 'latents',
            label: 'Latents',
          },
          vae: {
            name: 'vae',
            label: 'VAE',
          },
        },
      },
    },
  ],
  edges: [
    {
      id: 'edge-1',
      type: 'default',
      source: 'image-node',
      sourceHandle: 'latents',
      target: 'output-node',
      targetHandle: 'latents',
    },
  ],
  form: null,
};

function loadGraphWorkflowServiceWithStubs(stubs) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
    if (normalizedParent.endsWith('/electron/services/graphWorkflowService.js')) {
      if (request === './logService') {
        return stubs.logService;
      }

      if (request === './pipelineArtifactService') {
        return stubs.pipelineArtifactService;
      }
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = path.resolve(__dirname, '..', 'electron', 'services', 'graphWorkflowService.js');
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function createBufferResponse(buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buffer,
    text: async () => '',
  };
}

async function verifyInvokeAiParsing() {
  const parsed = parseGraphWorkflowDefinitionText('invokeai', JSON.stringify(invokeWorkflowFixture));
  assert.strictEqual(parsed.ok, true, 'Expected InvokeAI workflow fixture to parse successfully.');
  assert(parsed.executionGraph && parsed.executionGraph.nodes, 'Expected parser to build an executable graph.');
  assert.strictEqual(parsed.nodeEntries.length, 3, 'Expected three parsed workflow nodes.');
  assert(parsed.nodeEntries.some((entry) => entry.id === 'output-node' && entry.imageOutputCandidate), 'Expected non-intermediate output node to be marked as an image output candidate.');
  assert.deepStrictEqual(parsed.executionGraph.edges, [
    {
      source: { node_id: 'image-node', field: 'latents' },
      destination: { node_id: 'output-node', field: 'latents' },
    },
  ], 'Expected workflow edges to convert into InvokeAI graph edges.');
  assert.strictEqual(parsed.executionGraph.nodes['prompt-node'].prompt, 'original prompt', 'Expected text input values to transfer into the executable graph.');
}

async function verifyInvokeAiExecution() {
  const tempDir = path.resolve(__dirname, '..', 'temp', 'invokeai-graph-test');
  fs.mkdirSync(tempDir, { recursive: true });
  const inputImagePath = path.join(tempDir, 'input.png');
  fs.writeFileSync(inputImagePath, Buffer.from('input-image'));

  const progressMessages = [];
  let savedArtifactOptions = null;
  let enqueueBody = null;
  let batchStatusCalls = 0;
  let queueItemCalls = 0;

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const targetUrl = String(url);

    if (targetUrl.includes('/v1/images/upload')) {
      return createJsonResponse({ image_name: 'uploaded-input.png' }, 201);
    }

    if (targetUrl.includes('/v1/queue/default/enqueue_batch')) {
      enqueueBody = JSON.parse(String(options.body || '{}'));
      return createJsonResponse({
        item_ids: [42],
        batch: {
          batch_id: enqueueBody.batch.batch_id,
        },
      }, 201);
    }

    if (targetUrl.includes('/v1/queue/default/b/') && targetUrl.endsWith('/status')) {
      batchStatusCalls += 1;
      return createJsonResponse({
        queue_id: 'default',
        batch_id: enqueueBody.batch.batch_id,
        origin: 'local-ai-hub-pipeline',
        destination: 'local-ai-hub-pipeline',
        pending: batchStatusCalls === 1 ? 1 : 0,
        in_progress: batchStatusCalls === 1 ? 1 : 0,
        completed: batchStatusCalls === 1 ? 0 : 1,
        failed: 0,
        canceled: 0,
        total: 1,
      });
    }

    if (targetUrl.includes('/v1/queue/default/i/42')) {
      queueItemCalls += 1;
      if (queueItemCalls === 1) {
        return createJsonResponse({
          item_id: 42,
          batch_id: enqueueBody.batch.batch_id,
          queue_id: 'default',
          session_id: 'session-1',
          status: 'in_progress',
          session: {
            graph: {
              nodes: {
                'prompt-node': {},
                'image-node': {},
                'output-node': {},
              },
            },
            executed_history: ['prompt-node'],
            results: {},
            source_prepared_mapping: {
              'output-node': ['output-node'],
            },
          },
        });
      }

      return createJsonResponse({
        item_id: 42,
        batch_id: enqueueBody.batch.batch_id,
        queue_id: 'default',
        session_id: 'session-1',
        status: 'completed',
        session: {
          graph: {
            nodes: {
              'prompt-node': {},
              'image-node': {},
              'output-node': {},
            },
          },
          executed_history: ['prompt-node', 'image-node', 'output-node'],
          results: {
            'output-node': {
              image: {
                image_name: 'invoke-output.png',
              },
            },
          },
          source_prepared_mapping: {
            'output-node': ['output-node'],
          },
        },
      });
    }

    if (targetUrl.includes('/v1/images/i/invoke-output.png/full')) {
      return createBufferResponse(Buffer.from('invoke-output'));
    }

    throw new Error(`Unexpected fetch target: ${targetUrl}`);
  };

  try {
    const { executeGraphWorkflowNode } = loadGraphWorkflowServiceWithStubs({
      logService: {
        createLogger: () => ({
          info: async () => {},
          warn: async () => {},
        }),
      },
      pipelineArtifactService: {
        saveBufferArtifact: async (_runDirectories, buffer, options = {}) => {
          savedArtifactOptions = {
            buffer: Buffer.from(buffer).toString('utf8'),
            options,
          };
          return {
            filePath: path.join(tempDir, 'invoke-output.png'),
            fileName: 'invoke-output.png',
            fileUrl: 'file:///invoke-output.png',
            kind: 'image',
            summary: 'invoke-output.png',
          };
        },
        summarizeArtifact: (artifact) => artifact?.summary || artifact?.fileName || '',
      },
    });

    const result = await executeGraphWorkflowNode({
      inputArtifacts: {
        text: {
          kind: 'text',
          text: 'Prompt from pipeline',
        },
        image: {
          kind: 'image',
          filePath: inputImagePath,
          fileName: 'input.png',
          mimeType: 'image/png',
        },
      },
      node: {
        label: 'Invoke Graph',
        config: {
          toolId: 'invokeai',
          workflowText: JSON.stringify(invokeWorkflowFixture),
          inputBindings: {
            text: {
              mode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD,
              nodeId: 'prompt-node',
              field: 'prompt',
            },
            image: {
              mode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD,
              nodeId: 'image-node',
              field: 'image',
            },
          },
          outputBindings: {
            image: {
              mode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_OUTPUT,
              nodeId: 'output-node',
            },
          },
        },
      },
      reportProgress: (message) => progressMessages.push(message),
      runDirectories: {
        artifactsDir: tempDir,
      },
      tool: {
        id: 'invokeai',
        name: 'InvokeAI',
        launchUrl: 'http://127.0.0.1:9090',
      },
    });

    assert(enqueueBody, 'Expected InvokeAI adapter to enqueue a batch.');
    assert.strictEqual(enqueueBody.batch.graph.nodes['prompt-node'].prompt, 'original prompt', 'Expected saved workflow prompt to remain in the executable graph payload.');
    assert.deepStrictEqual(enqueueBody.batch.data, [
      [
        {
          node_path: 'prompt-node',
          field_name: 'prompt',
          items: ['Prompt from pipeline'],
        },
      ],
      [
        {
          node_path: 'image-node',
          field_name: 'image',
          items: [{ image_name: 'uploaded-input.png' }],
        },
      ],
    ], 'Expected pipeline boundary mappings to become InvokeAI batch data substitutions.');
    assert(savedArtifactOptions && savedArtifactOptions.buffer === 'invoke-output', 'Expected InvokeAI output image to be downloaded and saved as an artifact.');
    assert(progressMessages.some((message) => String(message).includes('Uploading the connected image')), 'Expected progress updates during image upload.');
    assert(progressMessages.some((message) => String(message).includes('accepted the graph workflow and added it to its queue')), 'Expected queue progress updates.');
    assert.strictEqual(result.outputs.image.fileName, 'invoke-output.png', 'Expected InvokeAI adapter to return an image artifact.');
  } finally {
    global.fetch = originalFetch;
  }
}

async function main() {
  await verifyInvokeAiParsing();
  await verifyInvokeAiExecution();
  console.log('InvokeAI graph workflow verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
