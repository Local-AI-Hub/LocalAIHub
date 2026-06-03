const assert = require('assert');

process.env.OPENAI_API_KEY = 'verify-openai-key';
process.env.GOOGLE_API_KEY = 'verify-google-key';
process.env.GEMINI_API_KEY = 'verify-google-key';
process.env.XAI_API_KEY = 'verify-xai-key';

const capabilities = require('../electron/shared/pipelineCapabilities.cjs');
const schema = require('../electron/shared/pipelineSchema.cjs');
const { runProviderOperation } = require('../electron/services/providerService');

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const IMAGE_OPERATION = capabilities.PIPELINE_OPERATION_IDS.IMAGE_GENERATE;

function assertImageProviderCapabilities() {
  const providerIds = capabilities.getProviderIdsForPipelineOperation(IMAGE_OPERATION).sort();
  assert.deepStrictEqual(providerIds, ['google', 'openai', 'xai'], 'Cloud image generation providers should be OpenAI, Google, and xAI only.');
  for (const providerId of ['anthropic', 'mistral', 'groq', 'deepseek']) {
    assert.strictEqual(capabilities.getProviderPipelineOperation(providerId, IMAGE_OPERATION), null, providerId + ' must not expose cloud image generation.');
  }

  const imageModels = [
    ['openai', 'gpt-image-1'],
    ['openai', 'gpt-image-1.5'],
    ['google', 'models/gemini-2.0-flash-preview-image-generation'],
    ['google', 'models/gemini-2.5-flash-image'],
    ['xai', 'grok-imagine-image-quality'],
  ];
  for (const [providerId, modelId] of imageModels) {
    const operation = capabilities.getProviderModelOperation(providerId, modelId, IMAGE_OPERATION);
    assert(operation, providerId + ' ' + modelId + ' should expose image generation.');
    assert(operation.inputKinds.includes(capabilities.MODALITY_TEXT), providerId + ' ' + modelId + ' should support text-to-image input.');
    assert(operation.inputKinds.includes(capabilities.MODALITY_IMAGE), providerId + ' ' + modelId + ' should support image-to-image input.');
    assert(operation.operationSubtypes.includes('textToImage'), providerId + ' ' + modelId + ' should expose textToImage subtype.');
    assert(operation.operationSubtypes.includes('imageToImage'), providerId + ' ' + modelId + ' should expose imageToImage subtype.');
  }
  assert.strictEqual(capabilities.getProviderModelOperation('google', 'models/imagen-4.0-generate-001', IMAGE_OPERATION), null, 'Imagen should stay hidden until the Imagen generate-images path is implemented.');
}

function connectedProvider(id, name) {
  return {
    id,
    name,
    isConnected: true,
    lastTestedAt: new Date().toISOString(),
    lastTestSucceeded: true,
    pipelineCapabilities: capabilities.getProviderPipelineCapabilities(id),
  };
}

function assertSchemaSupport() {
  const providers = [connectedProvider('openai', 'OpenAI'), connectedProvider('google', 'Google'), connectedProvider('xai', 'xAI')];
  const textModelStep = {
    nodes: [
      { id: 'text', type: 'textInput', label: 'Text', config: { text: 'A clean product render.' } },
      { id: 'image-step', type: 'llmPrompt', label: 'Cloud Image', config: { executionMode: 'cloud', operationId: IMAGE_OPERATION, providerId: 'openai', model: 'gpt-image-1' } },
      { id: 'out', type: 'imageOutput', label: 'Image Output', config: {} },
    ],
    edges: [
      { id: 'e1', source: { nodeId: 'text', portId: 'text' }, target: { nodeId: 'image-step', portId: 'prompt' } },
      { id: 'e2', source: { nodeId: 'image-step', portId: 'image' }, target: { nodeId: 'out', portId: 'image' } },
    ],
  };
  let analysis = schema.analyzePipeline(textModelStep, { providers });
  assert(!analysis.issues.some((issue) => issue.tone === 'error'), 'Model Step cloud text-to-image should analyze without error issues.');
  assert(schema.getPipelineNodePorts(textModelStep.nodes[1], 'input')[0].allowedKinds.includes(schema.PORT_KIND_TEXT), 'Cloud image Model Step should accept text input.');
  assert(schema.getPipelineNodePorts(textModelStep.nodes[1], 'output').some((port) => port.id === 'image'), 'Cloud image Model Step should expose image output.');

  const imageModelStep = {
    nodes: [
      { id: 'image', type: 'imageInput', label: 'Source Image', config: { filePath: 'D:/source.png' } },
      { id: 'edit-step', type: 'llmPrompt', label: 'Cloud Edit', config: { executionMode: 'cloud', operationId: IMAGE_OPERATION, providerId: 'openai', model: 'gpt-image-1', instruction: 'Make it look like a watercolor poster.' } },
      { id: 'out', type: 'imageOutput', label: 'Image Output', config: {} },
    ],
    edges: [
      { id: 'e1', source: { nodeId: 'image', portId: 'image' }, target: { nodeId: 'edit-step', portId: 'prompt' } },
      { id: 'e2', source: { nodeId: 'edit-step', portId: 'image' }, target: { nodeId: 'out', portId: 'image' } },
    ],
  };
  analysis = schema.analyzePipeline(imageModelStep, { providers });
  assert(!analysis.issues.some((issue) => issue.tone === 'error'), 'Model Step cloud image-to-image should analyze without error issues when the provider supports image input and an edit instruction is present.');
  assert(schema.getPipelineNodePorts(imageModelStep.nodes[1], 'input')[0].allowedKinds.includes(schema.PORT_KIND_IMAGE), 'Cloud image Model Step should accept image input.');

  const textMap = {
    nodes: [
      { id: 'collection', type: 'collectionInput', label: 'Collection', config: { itemType: 'text', items: [{ text: 'first' }, { text: 'second' }] } },
      { id: 'map', type: 'collectionMap', label: 'Map', config: { mappingId: 'textToImage', executionMode: 'cloud', operationId: IMAGE_OPERATION, providerId: 'openai', model: 'gpt-image-1' } },
      { id: 'out', type: 'collectionOutput', label: 'Output', config: { itemKind: 'image' } },
    ],
    edges: [
      { id: 'e1', source: { nodeId: 'collection', portId: 'collection' }, target: { nodeId: 'map', portId: 'collection' } },
      { id: 'e2', source: { nodeId: 'map', portId: 'collection' }, target: { nodeId: 'out', portId: 'collection' } },
    ],
  };
  analysis = schema.analyzePipeline(textMap, { providers });
  assert(!analysis.issues.some((issue) => issue.tone === 'error'), 'collectionMap text collection to image collection should analyze without error issues.');

  const imageMap = {
    nodes: [
      { id: 'collection', type: 'collectionInput', label: 'Collection', config: { itemType: 'image', items: [{ filePath: 'D:/a.png' }, { filePath: 'D:/b.png' }] } },
      { id: 'map', type: 'collectionMap', label: 'Map', config: { mappingId: 'cloudImageToImage', executionMode: 'cloud', operationId: IMAGE_OPERATION, providerId: 'openai', model: 'gpt-image-1', instruction: 'Apply the same soft studio lighting.' } },
      { id: 'out', type: 'collectionOutput', label: 'Output', config: { itemKind: 'image' } },
    ],
    edges: [
      { id: 'e1', source: { nodeId: 'collection', portId: 'collection' }, target: { nodeId: 'map', portId: 'collection' } },
      { id: 'e2', source: { nodeId: 'map', portId: 'collection' }, target: { nodeId: 'out', portId: 'collection' } },
    ],
  };
  analysis = schema.analyzePipeline(imageMap, { providers });
  assert(!analysis.issues.some((issue) => issue.tone === 'error'), 'collectionMap image collection to image collection should analyze without error issues with a shared edit instruction.');

  const missingInstruction = JSON.parse(JSON.stringify(imageMap));
  missingInstruction.nodes[1].config.instruction = '';
  analysis = schema.analyzePipeline(missingInstruction, { providers });
  assert(analysis.issues.some((issue) => /shared image edit instruction/i.test(issue.message)), 'collectionMap cloud image-to-image should require a shared edit instruction.');
}

async function assertProviderAdapters() {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    requests.push({ body: options.body, method: options.method, url: String(url) });
    if (/quota/i.test(String(options.body || ''))) {
      return new Response(JSON.stringify({ error: { message: 'insufficient_quota: no credits left' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('/images/')) {
      return new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG, revised_prompt: 'verified prompt' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes(':generateContent')) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: ONE_PIXEL_PNG } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(Buffer.from(ONE_PIXEL_PNG, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
  };

  try {
    let result = await runProviderOperation('openai', { operationId: IMAGE_OPERATION, model: 'gpt-image-1', prompt: 'Verify text image.' });
    assert.strictEqual(result.operation, 'textToImage', 'OpenAI text input should route as textToImage.');
    assert(requests.some((request) => request.url.includes('/images/generations')), 'OpenAI text-to-image should call image generations.');

    result = await runProviderOperation('openai', { operationId: IMAGE_OPERATION, model: 'gpt-image-1', prompt: 'Verify image edit.', imageReference: { buffer: Buffer.from(ONE_PIXEL_PNG, 'base64'), mimeType: 'image/png', fileName: 'source.png' } });
    assert.strictEqual(result.operation, 'imageToImage', 'OpenAI image input should route as imageToImage.');
    assert(requests.some((request) => request.url.includes('/images/edits')), 'OpenAI image-to-image should call image edits.');

    result = await runProviderOperation('google', { operationId: IMAGE_OPERATION, model: 'models/gemini-2.0-flash-preview-image-generation', prompt: 'Verify Gemini edit.', imageReference: { buffer: Buffer.from(ONE_PIXEL_PNG, 'base64'), mimeType: 'image/png', fileName: 'source.png' } });
    assert.strictEqual(result.operation, 'imageToImage', 'Google image input should route as imageToImage.');
    const googleRequest = requests.find((request) => request.url.includes(':generateContent'));
    assert(googleRequest && String(googleRequest.body).includes('responseModalities'), 'Google image generation should use generateContent with response modalities.');

    result = await runProviderOperation('xai', { operationId: IMAGE_OPERATION, model: 'grok-imagine-image-quality', prompt: 'Verify xAI edit.', imageReference: { buffer: Buffer.from(ONE_PIXEL_PNG, 'base64'), mimeType: 'image/png', fileName: 'source.png' } });
    assert.strictEqual(result.operation, 'imageToImage', 'xAI image input should route as imageToImage.');
    const xaiEdit = requests.find((request) => request.url.includes('/images/edits') && String(request.body || '').includes('data:image/png;base64'));
    assert(xaiEdit, 'xAI image edit should send a data URL source image through the documented edits JSON shape.');

    await assert.rejects(
      () => runProviderOperation('openai', { operationId: IMAGE_OPERATION, model: 'gpt-image-1', prompt: 'quota failure' }),
      /quota|billing/i,
      'Provider image quota errors should be normalized to a clear plain-English message.',
    );
  } finally {
    global.fetch = originalFetch;
  }
}

function assertSourceGuards() {
  const executionSource = require('fs').readFileSync(require('path').resolve(__dirname, '../electron/services/pipelineExecutionService.js'), 'utf8');
  const artifactSource = require('fs').readFileSync(require('path').resolve(__dirname, '../electron/services/pipelineArtifactService.js'), 'utf8');
  const uiSource = require('fs').readFileSync(require('path').resolve(__dirname, '../src/components/PipelineBuilderPanel.jsx'), 'utf8');
  assert(executionSource.includes('sourceItemIndex'), 'Generated collection image metadata should preserve source item index lineage.');
  assert(executionSource.includes('sourceItemId'), 'Generated collection image metadata should preserve source item id lineage.');
  assert(executionSource.includes('buildCloudImageGenerationRequest'), 'Model Step and collectionMap should use a shared cloud image request builder.');
  assert(executionSource.includes('generateImageWithWorkflowTool'), 'Existing local image generation path should remain present.');
  assert(artifactSource.includes('sourceImage: serializeImageSourceReference(generation.sourceImage)'), 'Image generation sidecars should serialize source image lineage.');
  assert(artifactSource.includes('requestSettings'), 'Image generation sidecars should serialize request settings.');
  assert(uiSource.includes('getCloudProvidersForOperation(connectedProviders, collectionMapOperationId)'), 'collectionMap UI should filter cloud providers by operation capability.');
  assert(uiSource.includes('Cloud Image Generation sends text'), 'Model Step UI should clearly distinguish cloud image generation behavior.');
}

async function main() {
  assertImageProviderCapabilities();
  assertSchemaSupport();
  assertSourceGuards();
  await assertProviderAdapters();
  console.log('Cloud image generation verifier passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
