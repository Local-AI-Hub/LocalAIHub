const assert = require('assert');

process.env.GOOGLE_API_KEY = 'verify-google-key';
process.env.GEMINI_API_KEY = 'verify-google-key';
process.env.XAI_API_KEY = 'verify-xai-key';

const keytar = require('keytar');
keytar.getPassword = async () => '';

const capabilities = require('../electron/shared/pipelineCapabilities.cjs');
const schema = require('../electron/shared/pipelineSchema.cjs');
const { runProviderOperation } = require('../electron/services/providerService');

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const VIDEO_OPERATION = capabilities.PIPELINE_OPERATION_IDS.VIDEO_GENERATE;

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

function assertVideoProviderCapabilities() {
  assert.deepStrictEqual(capabilities.getProviderIdsForPipelineOperation(VIDEO_OPERATION), ['google', 'xai'], 'Cloud video generation should expose Google and xAI only.');
  for (const providerId of ['openai', 'anthropic', 'mistral', 'groq', 'deepseek']) {
    assert.strictEqual(capabilities.getProviderPipelineOperation(providerId, VIDEO_OPERATION), null, providerId + ' must not expose cloud video generation.');
    assert.strictEqual(capabilities.getProviderModelOperation(providerId, 'sora-2', VIDEO_OPERATION), null, providerId + ' must not expose model-level video generation in this pass.');
  }

  const veoOperation = capabilities.getProviderModelOperation('google', 'models/veo-3.1-generate-preview', VIDEO_OPERATION);
  assert(veoOperation, 'Google Veo models should expose video generation.');
  assert(veoOperation.inputKinds.includes(capabilities.MODALITY_TEXT), 'Google Veo should support text-to-video input.');
  assert(veoOperation.inputKinds.includes(capabilities.MODALITY_IMAGE), 'Google Veo should support image-to-video input.');
  assert(veoOperation.operationSubtypes.includes('textToVideo'), 'Google Veo should expose textToVideo subtype.');
  assert(veoOperation.operationSubtypes.includes('imageToVideo'), 'Google Veo should expose imageToVideo subtype.');

  const xaiOperation = capabilities.getProviderModelOperation('xai', 'grok-imagine-video', VIDEO_OPERATION);
  assert(xaiOperation, 'xAI Grok Imagine video models should expose video generation.');
  assert(xaiOperation.inputKinds.includes(capabilities.MODALITY_TEXT), 'xAI Grok Imagine should support text-to-video input.');
  assert(xaiOperation.inputKinds.includes(capabilities.MODALITY_IMAGE), 'xAI Grok Imagine should support image-to-video input.');
  assert(xaiOperation.operationSubtypes.includes('textToVideo'), 'xAI Grok Imagine should expose textToVideo subtype.');
  assert(xaiOperation.operationSubtypes.includes('imageToVideo'), 'xAI Grok Imagine should expose imageToVideo subtype.');
}

function assertSchemaSupport() {
  const providers = [connectedProvider('google', 'Google (Gemini)'), connectedProvider('xai', 'xAI (Grok)'), connectedProvider('openai', 'OpenAI')];
  const textPipeline = {
    nodes: [
      { id: 'text', type: 'textInput', label: 'Text', config: { text: 'A cinematic shot of a calm lake.' } },
      { id: 'video-step', type: 'llmPrompt', label: 'Cloud Video', config: { executionMode: 'cloud', operationId: VIDEO_OPERATION, providerId: 'google', model: 'models/veo-3.1-generate-preview' } },
      { id: 'out', type: 'videoOutput', label: 'Video Output', config: {} },
    ],
    edges: [
      { id: 'e1', source: { nodeId: 'text', portId: 'text' }, target: { nodeId: 'video-step', portId: 'prompt' } },
      { id: 'e2', source: { nodeId: 'video-step', portId: 'video' }, target: { nodeId: 'out', portId: 'video' } },
    ],
  };
  let analysis = schema.analyzePipeline(textPipeline, { providers });
  assert(!analysis.issues.some((issue) => issue.tone === 'error'), 'Model Step cloud text-to-video should analyze without error issues.');
  assert(schema.getPipelineNodePorts(textPipeline.nodes[1], 'input')[0].allowedKinds.includes(schema.PORT_KIND_TEXT), 'Cloud video Model Step should accept text input.');
  assert(schema.getPipelineNodePorts(textPipeline.nodes[1], 'output').some((port) => port.id === 'video'), 'Cloud video Model Step should expose video output.');

  const imagePipeline = {
    nodes: [
      { id: 'image', type: 'imageInput', label: 'Source Image', config: { filePath: 'D:/source.png' } },
      { id: 'video-step', type: 'llmPrompt', label: 'Cloud Video', config: { executionMode: 'cloud', operationId: VIDEO_OPERATION, providerId: 'google', model: 'models/veo-3.1-generate-preview', instruction: 'A slow push-in with soft morning light.' } },
      { id: 'out', type: 'videoOutput', label: 'Video Output', config: {} },
    ],
    edges: [
      { id: 'e1', source: { nodeId: 'image', portId: 'image' }, target: { nodeId: 'video-step', portId: 'prompt' } },
      { id: 'e2', source: { nodeId: 'video-step', portId: 'video' }, target: { nodeId: 'out', portId: 'video' } },
    ],
  };
  analysis = schema.analyzePipeline(imagePipeline, { providers });
  assert(!analysis.issues.some((issue) => issue.tone === 'error'), 'Model Step cloud image-to-video should analyze without error issues when motion guidance is present.');

  const xaiTextPipeline = JSON.parse(JSON.stringify(textPipeline));
  xaiTextPipeline.nodes[1].config.providerId = 'xai';
  xaiTextPipeline.nodes[1].config.model = 'grok-imagine-video';
  analysis = schema.analyzePipeline(xaiTextPipeline, { providers });
  assert(!analysis.issues.some((issue) => issue.tone === 'error'), 'Model Step xAI cloud text-to-video should analyze without error issues.');

  const xaiImagePipeline = JSON.parse(JSON.stringify(imagePipeline));
  xaiImagePipeline.nodes[1].config.providerId = 'xai';
  xaiImagePipeline.nodes[1].config.model = 'grok-imagine-video';
  analysis = schema.analyzePipeline(xaiImagePipeline, { providers });
  assert(!analysis.issues.some((issue) => issue.tone === 'error'), 'Model Step xAI cloud image-to-video should analyze without error issues when motion guidance is present.');
  const unsupportedProvider = JSON.parse(JSON.stringify(textPipeline));
  unsupportedProvider.nodes[1].config.providerId = 'openai';
  analysis = schema.analyzePipeline(unsupportedProvider, { providers });
  assert(analysis.issues.some((issue) => /does not support video generation/i.test(issue.message)), 'Unsupported cloud video providers should not analyze as runnable.');
}

async function assertGoogleProviderAdapter() {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    requests.push({ body: options.body, method: options.method, url: String(url) });
    const target = String(url);
    if (target.includes(':predictLongRunning')) {
      return new Response(JSON.stringify({ name: 'operations/verify-video-op' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('/operations/verify-video-op') || target.includes('/operations/verify-video-op?')) {
      return new Response(JSON.stringify({
        name: 'operations/verify-video-op',
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/verify-video:download', mimeType: 'video/mp4' } },
            ],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.includes('/files/verify-video:download')) {
      return new Response(Buffer.from('verify mp4'), { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    return new Response(JSON.stringify({ error: { message: 'unexpected request ' + target } }), { status: 500, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await runProviderOperation('google', {
      aspectRatio: '16:9',
      durationSeconds: 8,
      model: 'models/veo-3.1-generate-preview',
      operationId: VIDEO_OPERATION,
      pollIntervalMs: 0,
      prompt: 'Verify Google Veo text video.',
      resolution: '720p',
    });
    assert.strictEqual(result.provider, 'google', 'Google video result should preserve provider id.');
    assert.strictEqual(result.operation, 'textToVideo', 'Text input should route as textToVideo.');
    assert.strictEqual(result.providerOperationId, 'operations/verify-video-op', 'Video result should include the provider operation name.');
    assert(result.polling && Number.isFinite(result.polling.attemptCount), 'Video result should include polling metadata.');
    assert(result.videos[0].buffer.length > 0, 'Video result should include the downloaded buffer.');
    assert(requests.some((request) => request.url.includes(':predictLongRunning')), 'Google video generation should submit a long-running operation.');
    assert(requests.some((request) => request.url.includes('/operations/verify-video-op')), 'Google video generation should poll the operation.');
    assert(requests.some((request) => request.url.includes('/files/verify-video:download')), 'Google video generation should download the generated video.');

    requests.length = 0;
    const imageResult = await runProviderOperation('google', {
      imageReference: { buffer: Buffer.from(ONE_PIXEL_PNG, 'base64'), fileName: 'source.png', mimeType: 'image/png' },
      model: 'models/veo-3.1-generate-preview',
      operationId: VIDEO_OPERATION,
      pollIntervalMs: 0,
      prompt: 'Animate this source image.',
    });
    assert.strictEqual(imageResult.operation, 'imageToVideo', 'Image input should route as imageToVideo.');
    const imageRequest = requests.find((request) => request.url.includes(':predictLongRunning'));
    assert(imageRequest && String(imageRequest.body).includes('"image"'), 'Google image-to-video should include inline image input.');
  } finally {
    global.fetch = originalFetch;
  }
}

async function assertXaiProviderAdapter() {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    requests.push({ body: options.body, method: options.method, url: String(url) });
    const target = String(url);
    if (target.endsWith('/videos/generations')) {
      return new Response(JSON.stringify({ request_id: 'xai-verify-video-op' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('/videos/xai-verify-video-op')) {
      return new Response(JSON.stringify({
        request_id: 'xai-verify-video-op',
        status: 'done',
        model: 'grok-imagine-video',
        video: { url: 'https://vidgen.x.ai/verify-video.mp4', duration: 8, resolution: '720p', respect_moderation: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target === 'https://vidgen.x.ai/verify-video.mp4') {
      return new Response(Buffer.from('verify xai mp4'), { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    return new Response(JSON.stringify({ error: { message: 'unexpected request ' + target } }), { status: 500, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await runProviderOperation('xai', {
      aspectRatio: '16:9',
      durationSeconds: 8,
      model: 'grok-imagine-video',
      operationId: VIDEO_OPERATION,
      pollIntervalMs: 0,
      prompt: 'Verify xAI Grok Imagine text video.',
      resolution: '720p',
    });
    assert.strictEqual(result.provider, 'xai', 'xAI video result should preserve provider id.');
    assert.strictEqual(result.operation, 'textToVideo', 'xAI text input should route as textToVideo.');
    assert.strictEqual(result.providerOperationId, 'xai-verify-video-op', 'xAI video result should include the provider request id.');
    assert(result.polling && Number.isFinite(result.polling.attemptCount), 'xAI video result should include polling metadata.');
    assert(result.videos[0].buffer.length > 0, 'xAI video result should include the downloaded buffer.');
    assert.strictEqual(result.videos[0].durationSeconds, 8, 'xAI returned video duration should be preserved.');
    assert.strictEqual(result.videos[0].resolution, '720p', 'xAI returned video resolution should be preserved.');
    assert(requests.some((request) => request.url.endsWith('/videos/generations')), 'xAI video generation should submit through the documented generations endpoint.');
    assert(requests.some((request) => request.url.endsWith('/videos/xai-verify-video-op')), 'xAI video generation should poll the operation.');
    assert(requests.some((request) => request.url === 'https://vidgen.x.ai/verify-video.mp4'), 'xAI video generation should download the generated video.');

    requests.length = 0;
    const imageResult = await runProviderOperation('xai', {
      imageReference: { buffer: Buffer.from(ONE_PIXEL_PNG, 'base64'), fileName: 'source.png', mimeType: 'image/png' },
      model: 'grok-imagine-video',
      operationId: VIDEO_OPERATION,
      pollIntervalMs: 0,
      prompt: 'Animate this source image with xAI.',
    });
    assert.strictEqual(imageResult.operation, 'imageToVideo', 'xAI image input should route as imageToVideo.');
    const imageRequest = requests.find((request) => request.url.endsWith('/videos/generations'));
    assert(imageRequest && String(imageRequest.body).includes('"image"') && String(imageRequest.body).includes('data:image/png;base64'), 'xAI image-to-video should include a local artifact image as a data URL.');
  } finally {
    global.fetch = originalFetch;
  }
}
async function assertAbortAndTimeout() {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes(':predictLongRunning')) {
      return new Response(JSON.stringify({ name: 'operations/slow-video-op' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.includes(':cancel')) {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ name: 'operations/slow-video-op', done: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await assert.rejects(
      () => runProviderOperation('google', {
        model: 'models/veo-3.1-generate-preview',
        operationId: VIDEO_OPERATION,
        pollIntervalMs: 0,
        prompt: 'This should time out.',
        timeoutMs: 1,
      }),
      /timeout|stopped waiting|did not finish/i,
      'Operation timeout should produce a clear error.',
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(
      () => runProviderOperation('google', {
        model: 'models/veo-3.1-generate-preview',
        operationId: VIDEO_OPERATION,
        pollIntervalMs: 50,
        prompt: 'This should cancel.',
        signal: controller.signal,
      }),
      /cancel|polling stopped/i,
      'Polling should be abort-aware and return a clear cancellation message.',
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function assertMissingCredentialMessage() {
  const previousGoogle = process.env.GOOGLE_API_KEY;
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousXai = process.env.XAI_API_KEY;
  process.env.GOOGLE_API_KEY = '';
  process.env.GEMINI_API_KEY = '';
  try {
    await assert.rejects(
      () => runProviderOperation('google', { operationId: VIDEO_OPERATION, prompt: 'No credential.' }),
      /api key|GOOGLE_API_KEY/i,
      'Missing Google credentials should produce a clear API-key message.',
    );
  } finally {
    process.env.GOOGLE_API_KEY = previousGoogle;
    process.env.GEMINI_API_KEY = previousGemini;
  }

  process.env.XAI_API_KEY = '';
  try {
    await assert.rejects(
      () => runProviderOperation('xai', { operationId: VIDEO_OPERATION, prompt: 'No xAI credential.' }),
      /api key|XAI_API_KEY/i,
      'Missing xAI credentials should produce a clear API-key message.',
    );
  } finally {
    process.env.XAI_API_KEY = previousXai;
  }
}

function assertSourceGuards() {
  const fs = require('fs');
  const path = require('path');
  const providerSource = fs.readFileSync(path.resolve(__dirname, '../electron/services/providerService.js'), 'utf8');
  const executionSource = fs.readFileSync(path.resolve(__dirname, '../electron/services/pipelineExecutionService.js'), 'utf8');
  const artifactSource = fs.readFileSync(path.resolve(__dirname, '../electron/services/pipelineArtifactService.js'), 'utf8');
  const uiSource = fs.readFileSync(path.resolve(__dirname, '../src/components/PipelineBuilderPanel.jsx'), 'utf8');
  assert(providerSource.includes(':predictLongRunning'), 'Google video provider should submit long-running operations.');
  assert(providerSource.includes('/videos/generations'), 'xAI video provider should submit through the existing providerService operation path.');
  assert(providerSource.includes('waitForProvider(pollIntervalMs, signal'), 'Cloud video polling should be abort-aware.');
  assert(providerSource.includes('xAI Grok Imagine polling stopped because the pipeline was cancelled'), 'xAI polling cancellation should be guarded.');
  assert(providerSource.includes('normalizeProviderVideoGenerationError'), 'Cloud video errors should be normalized.');
  assert(executionSource.includes('sourceImage: videoRequest.sourceImageArtifact'), 'Model Step video metadata should preserve source image lineage.');
  assert(executionSource.includes('durationSeconds: Number(result?.videos?.[0]?.durationSeconds || 0) || 0'), 'Model Step video metadata should preserve returned video duration when known.');
  assert(artifactSource.includes('providerOperationId'), 'Video sidecars should serialize provider operation names.');
  assert(uiSource.includes('Cloud Video Generation uses Google Veo'), 'Model Step UI should name Google Veo cloud video behavior.');
  assert(uiSource.includes('Cloud Video Generation uses xAI Grok Imagine'), 'Model Step UI should name xAI Grok Imagine cloud video behavior.');
  assert(uiSource.includes('textToVideo') && uiSource.includes('imageToVideo'), 'Model Step UI should expose textToVideo and imageToVideo modes.');
  assert(capabilities.getProviderIdsForPipelineOperation(capabilities.PIPELINE_OPERATION_IDS.IMAGE_GENERATE).sort().join(',') === 'google,openai,xai', 'Cloud image generation provider exposure should remain unchanged.');
  assert(capabilities.getToolPipelineOperation('wan21-webui', VIDEO_OPERATION), 'Existing local Wan video capability should remain present.');
}

async function main() {
  assertVideoProviderCapabilities();
  assertSchemaSupport();
  await assertGoogleProviderAdapter();
  await assertXaiProviderAdapter();
  await assertAbortAndTimeout();
  await assertMissingCredentialMessage();
  assertSourceGuards();
  console.log('Cloud video generation verifier passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});




