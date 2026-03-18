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

async function verifyCapabilityRegistration() {
  const wanOperation = pipelineCapabilities.getToolPipelineOperation('wan21-webui', pipelineCapabilities.PIPELINE_OPERATION_IDS.VIDEO_GENERATE);
  assert(wanOperation, 'Expected Wan to advertise a video generation capability.');
  assert.deepStrictEqual(wanOperation.inputKinds, ['text', 'image'], 'Expected Wan to accept text or image input for video generation.');
  assert.deepStrictEqual(wanOperation.outputKinds, ['video'], 'Expected Wan to produce video output.');
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
  await verifyComfyUiVideoExecution();
  await verifyComfyUiAnimatedVideoExecution();
  await verifyDirectVideoOrchestrationBypass();
  console.log('Local video pipeline verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
