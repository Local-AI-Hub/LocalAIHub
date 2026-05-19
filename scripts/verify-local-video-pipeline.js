const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const Module = require('module');

const pipelineCapabilities = require('../electron/shared/pipelineCapabilities.cjs');
const pipelineSchema = require('../electron/shared/pipelineSchema.cjs');
const graphContracts = require('../electron/shared/graphWorkflowContracts.cjs');

function loadModuleWithStubs(moduleRelativePath, stubs = {}) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
    for (const [suffix, stubMap] of Object.entries(stubs)) {
      if (normalizedParent.endsWith(suffix) && Object.prototype.hasOwnProperty.call(stubMap, request)) {
        return stubMap[request];
      }
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = path.resolve(__dirname, '..', moduleRelativePath);
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createAnimatedGifBuffer() {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
    0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x3b,
  ]);
}

function createWanTool(overrides = {}) {
  return {
    appDir: 'C:/mock/wan21',
    compatibility: {
      minimumRamMb: 32768,
      minimumVramMb: 12288,
      recommendedRamMb: 65536,
      recommendedVramMb: 16384,
    },
    downloadedModels: [
      {
        id: 'wan21-webui:Model:Wan2.1-T2V-1.3B/diffusion_pytorch_model.safetensors',
        fileName: 'diffusion_pytorch_model.safetensors',
        modelType: 'Model',
        name: 'diffusion_pytorch_model',
        relativePath: 'Wan2.1-T2V-1.3B/diffusion_pytorch_model.safetensors',
      },
    ],
    id: 'wan21-webui',
    installDir: 'C:/mock/wan21',
    launchProfile: { kind: 'python-script', pythonPath: 'C:/mock/python.exe' },
    name: 'Wan2.1 WebUI',
    status: 'stopped',
    ...overrides,
  };
}

function createTextToVideoPipeline(config = {}) {
  return {
    id: 'wan-text-video-pipeline',
    name: 'Wan Text Video Pipeline',
    nodes: [
      { id: 'text-input', type: 'textInput', label: 'Prompt', config: { text: 'A sunrise over a quiet city.' } },
      {
        id: 'video-step',
        type: 'llmPrompt',
        label: 'Wan Video Step',
        config: {
          executionMode: 'localTool',
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.VIDEO_GENERATE,
          toolId: 'wan21-webui',
          videoSize: '832x480',
          ...config,
        },
      },
      { id: 'video-output', type: 'videoOutput', label: 'Video Output', config: { title: 'Wan video' } },
    ],
    edges: [
      { id: 'edge-prompt', source: { nodeId: 'text-input', portId: 'text' }, target: { nodeId: 'video-step', portId: 'prompt' } },
      { id: 'edge-video', source: { nodeId: 'video-step', portId: 'video' }, target: { nodeId: 'video-output', portId: 'video' } },
    ],
  };
}

function createImageToVideoPipeline(config = {}) {
  return {
    id: 'wan-image-video-pipeline',
    name: 'Wan Image Video Pipeline',
    nodes: [
      { id: 'image-input', type: 'imageInput', label: 'Source Image', config: { filePath: 'C:/mock/source.png' } },
      {
        id: 'video-step',
        type: 'llmPrompt',
        label: 'Wan Image Video Step',
        config: {
          executionMode: 'localTool',
          instruction: 'Slow cinematic push-in with soft light.',
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.VIDEO_GENERATE,
          toolId: 'wan21-webui',
          videoSize: '832x480',
          ...config,
        },
      },
      { id: 'video-output', type: 'videoOutput', label: 'Video Output', config: { title: 'Wan image video' } },
    ],
    edges: [
      { id: 'edge-image', source: { nodeId: 'image-input', portId: 'image' }, target: { nodeId: 'video-step', portId: 'prompt' } },
      { id: 'edge-video', source: { nodeId: 'video-step', portId: 'video' }, target: { nodeId: 'video-output', portId: 'video' } },
    ],
  };
}

function analyzeWanPipeline(pipeline, options = {}) {
  const tool = createWanTool(options.tool || {});
  return pipelineSchema.analyzePipeline(pipeline, {
    hardware: options.hardware || { gpuModel: 'NVIDIA GTX 1060', systemRamMb: 16384, vramMb: 6144 },
    toolCatalog: [tool],
    tools: options.tools || [tool],
  });
}


async function verifyCapabilityRegistration() {
  const wanOperation = pipelineCapabilities.getToolPipelineOperation('wan21-webui', pipelineCapabilities.PIPELINE_OPERATION_IDS.VIDEO_GENERATE);
  assert(wanOperation, 'Expected Wan to advertise a video generation capability.');
  assert.deepStrictEqual(wanOperation.inputKinds, ['text', 'image'], 'Expected Wan to accept text or image input for video generation.');
  assert.deepStrictEqual(wanOperation.outputKinds, ['video'], 'Expected Wan to produce video output.');
  assert.deepStrictEqual(wanOperation.operationSubtypes, ['text-to-video', 'image-to-video'], 'Expected Wan to expose text-to-video and image-to-video generation modes.');
  assert(pipelineSchema.VIDEO_WORKFLOW_TOOL_IDS.includes('wan21-webui'), 'Expected the pipeline schema to expose Wan as an operation-driven video tool.');
}

function verifyComfyUiVideoContracts() {
  const comfyContract = graphContracts.getGraphWorkflowContract('comfyui');
  assert(comfyContract.outputPorts.some((entry) => entry.portId === 'video' && entry.kind === 'video'), 'Expected ComfyUI graph contract to expose a video output port.');

  const workflowDefinition = {
    '1': { class_type: 'KSampler', inputs: { prompt: 'hello' } },
    '2': { class_type: 'SaveVideo', inputs: { images: ['1', 0] } },
    '3': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    '4': { class_type: 'SaveAnimatedWEBP', inputs: { images: ['1', 0] } },
  };
  const parsed = graphContracts.parseGraphWorkflowDefinitionText('comfyui', JSON.stringify(workflowDefinition));
  assert.strictEqual(parsed.ok, true, 'Expected the ComfyUI video workflow fixture to parse.');
  assert(graphContracts.getGraphWorkflowOutputNodeOptions(parsed, 'video').some((entry) => entry.id === '2'), 'Expected SaveVideo to be preferred for the video boundary.');
  assert(graphContracts.getGraphWorkflowOutputNodeOptions(parsed, 'video').some((entry) => entry.id === '4'), 'Expected SaveAnimatedWEBP to remain selectable for the video boundary.');
  assert(graphContracts.getGraphWorkflowOutputNodeOptions(parsed, 'image').some((entry) => entry.id === '3'), 'Expected SaveImage to be preferred for the image boundary.');
}

async function verifyAnimatedArtifactSemantics() {
  const tempDir = path.resolve(__dirname, '..', 'temp', 'animated-artifact-test');
  await fsp.mkdir(tempDir, { recursive: true });
  const gifPath = path.join(tempDir, 'animated.gif');
  await fsp.writeFile(gifPath, createAnimatedGifBuffer());

  const { buildFileArtifact } = loadModuleWithStubs('electron/services/pipelineArtifactService.js', {
    '/electron/services/pipelineArtifactService.js': {
      './configService': {
        ensureStorage: async () => {},
        getAppPaths: () => ({ runtimesRoot: tempDir }),
      },
    },
  });

  const imageArtifact = await buildFileArtifact(gifPath);
  assert.strictEqual(imageArtifact.kind, 'image', 'Expected plain GIF detection to stay image-typed by default.');
  assert.strictEqual(imageArtifact.isAnimated, true, 'Expected GIF artifacts to record animation metadata.');
  assert.strictEqual(imageArtifact.previewKind, 'animated-image', 'Expected animated GIFs to preview as animated images.');

  const videoArtifact = await buildFileArtifact(gifPath, { kind: 'video', displayName: 'Animated Video' });
  assert.strictEqual(videoArtifact.kind, 'video', 'Expected video-bound animated GIFs to stay on the video modality path.');
  assert.strictEqual(videoArtifact.previewKind, 'animated-image', 'Expected video-bound animated GIFs to keep animated-image preview metadata.');
  assert.strictEqual(videoArtifact.attachmentKind, 'image', 'Expected animated GIF motion artifacts to attach through image transport.');
  assert.strictEqual(videoArtifact.formatLabel, 'Animated GIF', 'Expected animated GIF motion artifacts to keep a readable format label.');
}

async function verifyLocalVideoService() {
  const tempDir = path.resolve(__dirname, '..', 'temp', 'local-video-service-test');
  await fsp.mkdir(tempDir, { recursive: true });
  const requestPayloads = [];

  const { generateVideoWithLocalVideoTool } = loadModuleWithStubs('electron/services/localVideoService.js', {
    '/electron/services/localVideoService.js': {
      './commandService': {
        runCommand: async (_command, args) => {
          const requestPath = args[1];
          const request = JSON.parse(await fsp.readFile(requestPath, 'utf8'));
          requestPayloads.push(request);
          await fsp.writeFile(request.outputPath, Buffer.from('video-output'));
          return {
            code: 0,
            stderr: '',
            stdout: JSON.stringify({
              message: 'Wan2.1 rendered a test video locally.',
              outputPath: request.outputPath,
            }),
          };
        },
      },
      './logService': {
        createLogger: () => ({
          warn: async () => {},
        }),
      },
      './pipelineArtifactService': {
        buildFileArtifact: async (filePath, options = {}) => ({
          displayName: options.displayName || 'Video',
          filePath,
          fileName: path.basename(filePath),
          kind: options.kind || 'video',
          role: options.role || 'generated',
          videoGeneration: options.videoGeneration || null,
          summary: path.basename(filePath),
        }),
        summarizeArtifact: (artifact) => artifact?.summary || '',
      },
    },
  });

  const result = await generateVideoWithLocalVideoTool(
    {
      appDir: tempDir,
      id: 'wan21-webui',
      launchProfile: { pythonPath: 'python' },
      name: 'Wan2.1 WebUI',
    },
    {
      displayName: 'Video Step',
      model: '',
      negativePrompt: 'low quality',
      nodeLabel: 'Video Step',
      prompt: 'Animate this scene',
      reportProgress: () => {},
      runDirectories: {
        artifactsDir: tempDir,
      },
      seed: 7,
      size: '832x480',
      steps: 12,
    },
  );

  assert.strictEqual(requestPayloads.length, 1, 'Expected the local video service to invoke the Wan helper once.');
  assert.strictEqual(requestPayloads[0].size, '832x480', 'Expected the local video request to preserve the selected video size.');
  assert.strictEqual(result.outputs.video.kind, 'video', 'Expected the local video service to return a video artifact.');
  assert(fs.existsSync(result.outputs.video.filePath), 'Expected the stubbed local video output file to exist.');
  assert.strictEqual(requestPayloads[0].generationMode, 'text-to-video', 'Expected the Wan request to mark text-to-video mode.');
  assert.strictEqual(result.outputs.video.videoGeneration.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.VIDEO_GENERATE, 'Expected the local video artifact to preserve the operation id.');
  assert.strictEqual(result.outputs.video.videoGeneration.operationSubtype, 'text-to-video', 'Expected the local video artifact to preserve text-to-video subtype.');
  assert.strictEqual(result.outputs.video.videoGeneration.toolId, 'wan21-webui', 'Expected the local video artifact to preserve the producing tool id.');

  const imageResult = await generateVideoWithLocalVideoTool(
    {
      appDir: tempDir,
      id: 'wan21-webui',
      launchProfile: { pythonPath: 'python' },
      name: 'Wan2.1 WebUI',
    },
    {
      displayName: 'Image Video Step',
      nodeLabel: 'Image Video Step',
      prompt: 'Slow cinematic push-in.',
      referenceImagePath: path.join(tempDir, 'source.png'),
      reportProgress: () => {},
      runDirectories: {
        artifactsDir: tempDir,
      },
      size: '832x480',
      sourceImageArtifact: {
        displayName: 'Source Image',
        fileName: 'source.png',
        filePath: path.join(tempDir, 'source.png'),
        kind: 'image',
      },
    },
  );

  assert.strictEqual(requestPayloads[1].generationMode, 'image-to-video', 'Expected the Wan request to mark image-to-video mode.');
  assert.strictEqual(imageResult.outputs.video.videoGeneration.operationSubtype, 'image-to-video', 'Expected the local video artifact to preserve image-to-video subtype.');
  assert.strictEqual(imageResult.outputs.video.videoGeneration.sourceImage.fileName, 'source.png', 'Expected the local video artifact to preserve source image lineage.');
}

async function verifyComfyUiVideoExecution() {
  const savedArtifacts = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const targetUrl = String(url);
    if (targetUrl.endsWith('/prompt')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ prompt_id: 'prompt-1' }),
      };
    }

    if (targetUrl.includes('/history/prompt-1')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          'prompt-1': {
            outputs: {
              '2': {
                videos: [
                  {
                    filename: 'rendered.mp4',
                    subfolder: '',
                    type: 'output',
                  },
                ],
              },
            },
            status: {
              status_str: 'success',
            },
          },
        }),
      };
    }

    if (targetUrl.includes('/view?')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('video-bytes'),
        text: async () => '',
      };
    }

    throw new Error('Unexpected fetch target: ' + targetUrl + ' with method ' + String(options.method || 'GET'));
  };

  try {
    const { executeGraphWorkflowNode } = loadModuleWithStubs('electron/services/graphWorkflowService.js', {
      '/electron/services/graphWorkflowService.js': {
        './logService': {
          createLogger: () => ({
            warn: async () => {},
          }),
        },
        './pipelineArtifactService': {
          saveBufferArtifact: async (_runDirectories, bufferPayload, options = {}) => {
            const artifact = {
              attachmentKind: 'video',
              fileName: 'rendered' + (options.extension || '.mp4'),
              filePath: path.join('temp', 'graph-video-test' + (options.extension || '.mp4')),
              formatLabel: 'MP4 video',
              kind: options.kind || 'video',
              previewKind: options.kind === 'video' ? 'video' : 'image',
              role: options.role || 'generated',
              sizeBytes: Buffer.from(bufferPayload).length,
            };
            savedArtifacts.push(artifact);
            return artifact;
          },
          summarizeArtifact: (artifact) => artifact?.fileName || '',
        },
      },
    });

    const workflowText = JSON.stringify({
      '1': { class_type: 'KSampler', inputs: { prompt: 'hello' } },
      '2': { class_type: 'SaveVideo', inputs: { images: ['1', 0] } },
    });
    const result = await executeGraphWorkflowNode({
      inputArtifacts: {},
      node: {
        config: {
          inputBindings: {
            image: { field: '', mode: 'node-field', nodeId: '' },
            text: { field: '', mode: 'node-field', nodeId: '' },
          },
          outputBindings: {
            video: { mode: 'node-output', nodeId: '2' },
          },
          toolId: 'comfyui',
          workflowText,
        },
        label: 'Graph Video',
      },
      reportProgress: () => {},
      runDirectories: {
        artifactsDir: path.resolve(__dirname, '..', 'temp', 'graph-video-artifacts'),
      },
      tool: {
        id: 'comfyui',
        launchUrl: 'http://127.0.0.1:8188',
        name: 'ComfyUI',
      },
    });

    assert.strictEqual(result.outputs.video.kind, 'video', 'Expected ComfyUI graph execution to return a video artifact.');
    assert.strictEqual(savedArtifacts.length, 1, 'Expected one saved graph video artifact.');
  } finally {
    global.fetch = originalFetch;
  }
}

async function verifyComfyUiAnimatedVideoExecution() {
  const savedArtifacts = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const targetUrl = String(url);
    if (targetUrl.endsWith('/prompt')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ prompt_id: 'prompt-animated' }),
      };
    }

    if (targetUrl.includes('/history/prompt-animated')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          'prompt-animated': {
            outputs: {
              '2': {
                gifs: [
                  {
                    filename: 'loop.gif',
                    subfolder: '',
                    type: 'output',
                  },
                ],
              },
            },
            status: {
              status_str: 'success',
            },
          },
        }),
      };
    }

    if (targetUrl.includes('/view?')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => createAnimatedGifBuffer(),
        text: async () => '',
      };
    }

    throw new Error('Unexpected fetch target: ' + targetUrl);
  };

  try {
    const { executeGraphWorkflowNode } = loadModuleWithStubs('electron/services/graphWorkflowService.js', {
      '/electron/services/graphWorkflowService.js': {
        './logService': {
          createLogger: () => ({
            warn: async () => {},
          }),
        },
        './pipelineArtifactService': {
          saveBufferArtifact: async (_runDirectories, bufferPayload, options = {}) => {
            const artifact = {
              attachmentKind: 'image',
              fileName: 'loop' + (options.extension || '.gif'),
              filePath: path.join('temp', 'graph-animated-video-test' + (options.extension || '.gif')),
              formatLabel: 'Animated GIF',
              kind: options.kind || 'video',
              previewKind: 'animated-image',
              role: options.role || 'generated',
              sizeBytes: Buffer.from(bufferPayload).length,
            };
            savedArtifacts.push(artifact);
            return artifact;
          },
          summarizeArtifact: (artifact) => artifact?.fileName || '',
        },
      },
    });

    const workflowText = JSON.stringify({
      '1': { class_type: 'KSampler', inputs: { prompt: 'hello' } },
      '2': { class_type: 'SaveAnimatedWEBP', inputs: { images: ['1', 0] } },
    });
    const result = await executeGraphWorkflowNode({
      inputArtifacts: {},
      node: {
        config: {
          inputBindings: {
            image: { field: '', mode: 'node-field', nodeId: '' },
            text: { field: '', mode: 'node-field', nodeId: '' },
          },
          outputBindings: {
            video: { mode: 'node-output', nodeId: '2' },
          },
          toolId: 'comfyui',
          workflowText,
        },
        label: 'Graph Animated Video',
      },
      reportProgress: () => {},
      runDirectories: {
        artifactsDir: path.resolve(__dirname, '..', 'temp', 'graph-animated-video-artifacts'),
      },
      tool: {
        id: 'comfyui',
        launchUrl: 'http://127.0.0.1:8188',
        name: 'ComfyUI',
      },
    });

    assert.strictEqual(result.outputs.video.kind, 'video', 'Expected animated graph motion output to stay video-typed.');
    assert.strictEqual(result.outputs.video.previewKind, 'animated-image', 'Expected animated graph motion output to keep animated-image preview metadata.');
    assert.strictEqual(savedArtifacts.length, 1, 'Expected one saved animated graph motion artifact.');
  } finally {
    global.fetch = originalFetch;
  }
}


async function verifyVideoGenerationArtifactMetadata() {
  const tempDir = path.resolve(__dirname, '..', 'temp', 'video-generation-metadata-test');
  await fsp.mkdir(tempDir, { recursive: true });
  const videoPath = path.join(tempDir, 'wan-output.mp4');
  await fsp.writeFile(videoPath, Buffer.from('video-output'));

  const { buildFileArtifact, copyArtifactToOutput } = loadModuleWithStubs('electron/services/pipelineArtifactService.js', {
    '/electron/services/pipelineArtifactService.js': {
      './configService': {
        ensureStorage: async () => {},
        getAppPaths: () => ({ runtimesRoot: tempDir }),
      },
    },
  });

  const artifact = await buildFileArtifact(videoPath, {
    displayName: 'Wan Video',
    kind: 'video',
    role: 'generated',
    videoGeneration: {
      backend: 'local-video',
      fps: 15,
      model: 'Wan2.1-T2V-1.3B',
      operationId: pipelineSchema.PIPELINE_OPERATION_IDS.VIDEO_GENERATE,
      operationSubtype: 'text-to-video',
      prompt: 'A sunrise over a quiet city.',
      seed: 7,
      size: '832x480',
      steps: 12,
      toolId: 'wan21-webui',
      toolLabel: 'Wan2.1 WebUI',
    },
  });

  assert.strictEqual(artifact.kind, 'video', 'Expected Wan artifacts to stay video-typed.');
  assert.strictEqual(artifact.videoGeneration.operationSubtype, 'text-to-video', 'Expected generated video metadata to preserve the operation subtype.');
  assert(artifact.summary.includes('text to video'), 'Expected generated video summary to include the operation mode.');

  const outputDir = path.join(tempDir, 'pipeline-runs', 'run-video-output', 'outputs');
  await fsp.mkdir(outputDir, { recursive: true });
  const saved = await copyArtifactToOutput(artifact, { outputsDir: outputDir }, { title: 'Final Wan Video' });
  const sidecarPath = saved.metadataPaths.find((entry) => entry.endsWith('.video.json'));
  assert(sidecarPath, 'Expected generated video outputs to save a video metadata sidecar.');
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.videoGeneration.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.VIDEO_GENERATE, 'Expected the saved video sidecar to preserve the operation id.');
  assert.strictEqual(sidecar.videoGeneration.operationSubtype, 'text-to-video', 'Expected the saved video sidecar to preserve the operation subtype.');

  const { listPipelineOutputs } = loadModuleWithStubs('electron/services/pipelineOutputStoreService.js', {
    '/electron/services/pipelineArtifactService.js': {
      './configService': {
        ensureStorage: async () => {},
        getAppPaths: () => ({ runtimesRoot: tempDir }),
      },
    },
    '/electron/services/pipelineOutputStoreService.js': {
      './configService': {
        ensureStorage: async () => {},
        getAppPaths: () => ({ runtimesRoot: tempDir }),
      },
    },
  });
  const discoveredOutputs = await listPipelineOutputs();
  const runOutputs = discoveredOutputs.filter((entry) => entry.runId === 'run-video-output');
  assert(runOutputs.some((entry) => entry.kind === 'video' && entry.outputPath === saved.destinationPath), 'Expected the Outputs manager to list the final video output.');
  assert(!runOutputs.some((entry) => entry.outputPath.endsWith('.video.json')), 'Expected the Outputs manager to hide video metadata sidecars.');
}

async function verifyVideoStitchArtifactMetadata() {
  const tempDir = path.resolve(__dirname, '..', 'temp', 'video-stitch-metadata-test');
  await fsp.mkdir(tempDir, { recursive: true });
  const videoPath = path.join(tempDir, 'stitched-output.mp4');
  await fsp.writeFile(videoPath, Buffer.from('stitched-video-output'));

  const { buildFileArtifact, copyArtifactToOutput } = loadModuleWithStubs('electron/services/pipelineArtifactService.js', {
    '/electron/services/pipelineArtifactService.js': {
      './configService': {
        ensureStorage: async () => {},
        getAppPaths: () => ({ runtimesRoot: tempDir }),
      },
    },
  });

  const artifact = await buildFileArtifact(videoPath, {
    displayName: 'Stitched Video',
    kind: 'video',
    role: 'generated',
    videoStitch: {
      concatMode: 'ffmpeg-concat-demuxer',
      ffmpegMode: 'stream-copy',
      operationId: 'videoStitch',
      outputFormat: 'mp4',
      sourceCollection: { itemKind: 'video', itemCount: 2, manifestPath: path.join(tempDir, 'manifest.json') },
      sourceItemCount: 2,
      sourceItems: [
        { itemId: 'clip-a', artifactPath: path.join(tempDir, 'a.mp4'), prompt: 'first clip' },
        { itemId: 'clip-b', artifactPath: path.join(tempDir, 'b.mp4'), prompt: 'second clip' },
      ],
    },
  });

  assert.strictEqual(artifact.kind, 'video', 'Expected stitched videos to stay video-typed.');
  assert.strictEqual(artifact.videoStitch.operationId, 'videoStitch', 'Expected stitched video artifacts to preserve operation metadata.');
  assert(artifact.summary.includes('stitched clip'), 'Expected stitched video summary to describe source clips.');

  const outputDir = path.join(tempDir, 'pipeline-runs', 'run-video-stitch-output', 'outputs');
  await fsp.mkdir(outputDir, { recursive: true });
  const saved = await copyArtifactToOutput(artifact, { outputsDir: outputDir }, { title: 'Final Stitched Video' });
  const sidecarPath = saved.metadataPaths.find((entry) => entry.endsWith('.video.json'));
  assert(sidecarPath, 'Expected stitched video outputs to save a video metadata sidecar.');
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.videoStitch.operationId, 'videoStitch', 'Expected stitched video sidecar to preserve operation id.');
  assert.deepStrictEqual(sidecar.videoStitch.sourceItems.map((entry) => entry.itemId), ['clip-a', 'clip-b'], 'Expected stitched video sidecar to preserve ordered item refs.');
}
function verifyWanReadinessStates() {
  const textAnalysis = analyzeWanPipeline(createTextToVideoPipeline());
  const textSummary = textAnalysis.nodeSummaries['video-step'];
  assert.deepStrictEqual(textSummary.capabilitySummary.operationSubtypes, ['text-to-video', 'image-to-video'], 'Expected Wan capability summary to expose video generation modes.');
  assert.strictEqual(textSummary.readiness.tone, 'warn', 'Expected GTX 1060-class Wan readiness to warn instead of looking comfortable.');
  assert(/text-to-video|CUDA toolkit|model folders/i.test(textSummary.readiness.message), 'Expected Wan text readiness to name mode and runtime requirements.');
  assert.strictEqual(textAnalysis.compatibilitySummary.tone, 'danger', 'Expected Wan workflow compatibility to remain below spec on GTX 1060-class hardware.');

  const imageMissingMotion = analyzeWanPipeline(createImageToVideoPipeline({ instruction: '' }), { hardware: { gpuModel: 'NVIDIA RTX 4090', systemRamMb: 65536, vramMb: 24576 } });
  assert.strictEqual(imageMissingMotion.nodeSummaries['video-step'].readiness.tone, 'error', 'Expected Wan image-to-video to require motion guidance.');
  assert(/motion guidance/i.test(imageMissingMotion.nodeSummaries['video-step'].readiness.message), 'Expected missing image-to-video guidance to be actionable.');

  const imageReady = analyzeWanPipeline(createImageToVideoPipeline(), { hardware: { gpuModel: 'NVIDIA RTX 4090', systemRamMb: 65536, vramMb: 24576 } });
  assert.strictEqual(imageReady.nodeSummaries['video-step'].readiness.tone, 'info', 'Expected configured Wan image-to-video to be structurally ready on high-end mock hardware.');
  assert(/image-to-video/i.test(imageReady.nodeSummaries['video-step'].readiness.message), 'Expected Wan image readiness to name image-to-video mode.');

  const missingModels = analyzeWanPipeline(createTextToVideoPipeline(), { tool: { downloadedModels: [] }, hardware: { gpuModel: 'NVIDIA RTX 4090', systemRamMb: 65536, vramMb: 24576 } });
  assert.strictEqual(missingModels.nodeSummaries['video-step'].readiness.tone, 'error', 'Expected Wan readiness to block when model assets are known missing.');
  assert(/models\\Wan-AI|model assets/i.test(missingModels.nodeSummaries['video-step'].readiness.message), 'Expected missing Wan models to point at the model folder.');

  const unsupportedTool = analyzeWanPipeline(createTextToVideoPipeline({ toolId: 'comfyui' }), { tools: [createWanTool(), { id: 'comfyui', name: 'ComfyUI', status: 'stopped' }] });
  assert.strictEqual(unsupportedTool.nodeSummaries['video-step'].readiness.tone, 'error', 'Expected unsupported video tool selection to fail honestly.');
  assert(/does not support video generation/i.test(unsupportedTool.nodeSummaries['video-step'].readiness.message), 'Expected unsupported video tool selection to explain the unsupported local video path.');
}

async function verifyDirectVideoOrchestrationBypass() {
  let launchCalls = 0;
  const { createPipelineToolOrchestrator } = loadModuleWithStubs('electron/services/pipelineToolOrchestrationService.js', {
    '/electron/services/pipelineToolOrchestrationService.js': {
      '../shared/pipelineSchema.cjs': {
        PIPELINE_OPERATION_IDS: {
          VIDEO_GENERATE: 'videoGenerate',
        },
        getLocalToolRequirement: (node) => String(node?.config?.toolId || '').trim().toLowerCase(),
        getModelStepExecutionMode: () => 'localTool',
        getModelStepOperationId: () => 'videoGenerate',
      },
      './localVideoService': {
        LOCAL_VIDEO_RUNTIME_MODE_IDS: {
          DIRECT_COMMAND: 'direct-command',
        },
        getLocalVideoToolRuntimeMode: () => 'direct-command',
      },
      './processService': {
        isToolActive: async () => false,
        isToolReady: async () => false,
        launchToolFromUserAction: async () => {
          launchCalls += 1;
          return null;
        },
        stopTool: async () => {},
      },
      './toolStateService': {
        getResolvedToolState: async () => null,
      },
    },
  });

  const orchestrator = createPipelineToolOrchestrator({ toolsById: {} });
  const session = await orchestrator.ensureToolForNode(
    {
      config: {
        executionMode: 'localTool',
        toolId: 'wan21-webui',
      },
      label: 'Video Step',
      type: 'llmPrompt',
    },
    () => {},
  );

  assert.strictEqual(session, null, 'Expected direct-command local video nodes to bypass managed tool launching.');
  assert.strictEqual(launchCalls, 0, 'Expected orchestration bypass to avoid launching a long-running tool process.');
}

async function main() {
  await verifyCapabilityRegistration();
  verifyComfyUiVideoContracts();
  await verifyAnimatedArtifactSemantics();
  await verifyLocalVideoService();
  await verifyVideoGenerationArtifactMetadata();
  await verifyVideoStitchArtifactMetadata();
  verifyWanReadinessStates();
  await verifyComfyUiVideoExecution();
  await verifyComfyUiAnimatedVideoExecution();
  await verifyDirectVideoOrchestrationBypass();
  console.log('Local video pipeline verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
