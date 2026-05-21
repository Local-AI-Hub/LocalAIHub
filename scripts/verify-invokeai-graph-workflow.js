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

  const executionFixture = JSON.parse(JSON.stringify(invokeWorkflowFixture));
  executionFixture.nodes.push({
    id: 'model-node',
    type: 'invocation',
    position: { x: 0, y: 320 },
    data: {
      id: 'model-node',
      type: 'main_model_loader',
      version: '1.0.4',
      label: 'Model',
      isIntermediate: true,
      useCache: true,
      nodePack: 'invokeai',
      inputs: {
        model: {
          name: 'model',
          label: 'Model',
          value: {
            key: 'v1-5-pruned-emaonly.safetensors',
            name: 'v1-5-pruned-emaonly.safetensors',
            base: 'sd-1',
            type: 'main',
          },
        },
      },
    },
  });
  const progressMessages = [];
  let savedArtifactOptions = null;
  let enqueueBody = null;
  let batchStatusCalls = 0;
  let queueItemCalls = 0;
  const requests = [];

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const targetUrl = String(url);
    requests.push({
      body: String(options.body || ''),
      method: String(options.method || 'GET').trim().toUpperCase() || 'GET',
      url: targetUrl,
    });

    if (targetUrl.includes('/api/v2/models/i/')) {
      return createJsonResponse({
        key: 'v1-5-pruned-emaonly.safetensors',
        hash: 'blake3-model-hash',
        name: 'v1-5-pruned-emaonly.safetensors',
        base: 'sd-1',
        type: 'main',
      });
    }

    if (targetUrl.includes('/api/v2/models/?model_type=main')) {
      return createJsonResponse({
        models: [
          {
            key: 'v1-5-pruned-emaonly.safetensors',
            hash: 'blake3-model-hash',
            name: 'v1-5-pruned-emaonly.safetensors',
            base: 'sd-1',
            type: 'main',
            path: 'models/sd-1/main/v1-5-pruned-emaonly.safetensors',
          },
        ],
      });
    }

    if (targetUrl.includes('/api/v1/images/upload')) {
      return createJsonResponse({ image_name: 'uploaded-input.png' }, 201);
    }

    if (targetUrl.includes('/api/v1/queue/default/enqueue_batch')) {
      enqueueBody = JSON.parse(String(options.body || '{}'));
      return createJsonResponse({
        item_ids: [42],
        batch: {
          batch_id: enqueueBody.batch.batch_id,
        },
      }, 201);
    }

    if (targetUrl.includes('/api/v1/queue/default/b/') && targetUrl.endsWith('/status')) {
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

    if (targetUrl.includes('/api/v1/queue/default/i/42')) {
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
                'model-node': {},
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
          executed_history: ['prompt-node', 'image-node', 'output-node', 'model-node'],
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

    if (targetUrl.includes('/api/v1/images/i/invoke-output.png/full')) {
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
          workflowText: JSON.stringify(executionFixture),
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
    assert(requests.some((entry) => entry.method === 'POST' && entry.url.includes('/api/v1/queue/default/enqueue_batch')), 'Expected InvokeAI graph execution to use POST /api/v1/queue/default/enqueue_batch.');
    assert(!requests.some((entry) => entry.url.includes('http://127.0.0.1:9090/v1/')), 'InvokeAI graph execution must not call stale routes without the /api prefix.');
    assert.strictEqual(enqueueBody.batch.graph.nodes['prompt-node'].prompt, 'original prompt', 'Expected saved workflow prompt to remain in the executable graph payload.');
    assert.strictEqual(enqueueBody.batch.graph.nodes['model-node'].model.hash, 'blake3-model-hash', 'Expected InvokeAI graph execution to hydrate incomplete registered model identifiers before enqueue.');
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
    assert.strictEqual(savedArtifactOptions.options.imageGeneration.backend, 'invokeai-graph-workflow', 'Expected InvokeAI image artifacts to include graph workflow generation metadata.');
    assert(progressMessages.some((message) => String(message).includes('Uploading the connected image')), 'Expected progress updates during image upload.');
    assert(progressMessages.some((message) => String(message).includes('accepted the graph workflow and added it to its queue')), 'Expected queue progress updates.');
    assert.strictEqual(result.outputs.image.fileName, 'invoke-output.png', 'Expected InvokeAI adapter to return an image artifact.');
  } finally {
    global.fetch = originalFetch;
  }
}

async function verifyInvokeAiApiErrors() {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const targetUrl = String(url);
    if (targetUrl.includes('http://127.0.0.1:9090/v1/')) {
      throw new Error('Stale InvokeAI route without /api prefix was called: ' + targetUrl);
    }
    if (targetUrl.includes('/api/v1/queue/default/enqueue_batch')) {
      assert.strictEqual(String(options.method || '').toUpperCase(), 'POST', 'InvokeAI enqueue must use POST.');
      return createJsonResponse({ detail: 'Route does not allow that method.' }, 405);
    }
    throw new Error(`Unexpected fetch target during InvokeAI API error verification: ${targetUrl}`);
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
        saveBufferArtifact: async () => {
          throw new Error('No artifact should be saved when InvokeAI rejects enqueue.');
        },
        summarizeArtifact: (artifact) => artifact?.summary || artifact?.fileName || '',
      },
    });

    await assert.rejects(
      () => executeGraphWorkflowNode({
        inputArtifacts: {
          text: {
            kind: 'text',
            text: 'Prompt from pipeline',
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
            },
            outputBindings: {
              image: {
                mode: GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_OUTPUT,
                nodeId: 'output-node',
              },
            },
          },
        },
        runDirectories: {
          artifactsDir: path.resolve(__dirname, '..', 'temp', 'invokeai-graph-test'),
        },
        tool: {
          id: 'invokeai',
          name: 'InvokeAI',
          launchUrl: 'http://127.0.0.1:9090',
        },
      }),
      (error) => {
        assert(String(error.message || '').includes('POST /api/v1/queue/default/enqueue_batch'), 'Expected InvokeAI route/method errors to name the failing endpoint and method.');
        assert(String(error.message || '').includes('does not allow this method'), 'Expected InvokeAI 405 errors to be translated into plain English.');
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
}

function verifyComfyUiExecutionPathUnchanged() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'services', 'graphWorkflowService.js'), 'utf8');
  assert(source.includes("requestGraphWorkflowJson(tool, '/prompt'"), 'ComfyUI graph workflow submission should still use the ComfyUI /prompt endpoint.');
  assert(source.includes('downloadComfyUiOutput') && source.includes('`/view?${params.toString()}`'), 'ComfyUI graph workflow output download should still use the ComfyUI /view endpoint.');
}
async function main() {
  await verifyInvokeAiParsing();
  await verifyInvokeAiExecution();
  await verifyInvokeAiApiErrors();
  verifyComfyUiExecutionPathUnchanged();
  console.log('InvokeAI graph workflow verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
