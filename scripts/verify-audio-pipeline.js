const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const Module = require('module');

const pipelineSchema = require('../electron/shared/pipelineSchema.cjs');

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

function createWaveBuffer(options = {}) {
  const sampleRate = Math.max(8000, Number(options.sampleRate || 16000) || 16000);
  const durationSeconds = Math.max(1, Number(options.durationSeconds || 1) || 1);
  const frameCount = sampleRate * durationSeconds;
  const bytesPerSample = 2;
  const channelCount = Math.max(1, Number(options.channelCount || 1) || 1);
  const dataSize = frameCount * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  const frequency = Math.max(110, Number(options.frequency || 220) || 220);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < frameCount; index += 1) {
    const sample = Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * frequency) * 32767 * 0.15);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const offset = 44 + ((index * channelCount) + channelIndex) * bytesPerSample;
      buffer.writeInt16LE(sample, offset);
    }
  }

  return buffer;
}

function createTranscriptionFixture(audioPath, model) {
  return {
    audioPath,
    computeType: 'int8',
    device: 'cpu',
    durationSeconds: 4.2,
    language: 'en',
    model,
    segments: [
      { start: 0, end: 1.4, text: 'Local AI Hub' },
      { start: 1.4, end: 4.2, text: 'finished a Whisper pipeline test.' },
    ],
    text: 'Local AI Hub finished a Whisper pipeline test.',
  };
}

function createPipelineArtifactService(tempRoot) {
  return loadModuleWithStubs('electron/services/pipelineArtifactService.js', {
    '/electron/services/pipelineArtifactService.js': {
      './configService': {
        ensureStorage: async () => {},
        getAppPaths: () => ({ runtimesRoot: tempRoot }),
      },
    },
  });
}

function createPipelineExecutionService(tempRoot, toolEntries, options = {}) {
  const toolsById = Object.fromEntries((toolEntries || []).map((tool) => [tool.id, tool]));
  const artifactService = createPipelineArtifactService(tempRoot);
  const transcriptionFixtureFactory = options.transcriptionFixtureFactory || createTranscriptionFixture;
  const generateAudioFixture = options.generateAudioFixture || (async () => {
    throw new Error('Not used in this audio verification run.');
  });
  const providerEntries = Array.isArray(options.providerEntries) ? options.providerEntries : [];
  const runProviderOperationFixture = options.runProviderOperationFixture || (async () => {
    throw new Error('Not used in this audio verification run.');
  });

  return loadModuleWithStubs('electron/services/pipelineExecutionService.js', {
    '/electron/services/pipelineExecutionService.js': {
      './ollamaService': {
        chatWithOllama: async () => { throw new Error('Not used in audio verification.'); },
        inspectOllamaModel: async () => null,
        inspectOllamaModelCapabilities: async () => ({}),
      },
      './providerService': {
        chatWithProvider: async () => { throw new Error('Not used in audio verification.'); },
        listProviderConnections: async () => providerEntries,
        runProviderOperation: async (providerId, payload = {}) => runProviderOperationFixture(providerId, payload),
      },
      './providerRegistry': {
        initializeProviderRegistry: async () => {},
      },
      './toolRegistry': {
        getToolCatalog: () => toolEntries,
      },
      './modelService': {
        listDownloadedModels: async (toolOrId) => {
        const normalizedToolId = typeof toolOrId === 'string' ? toolOrId : toolOrId?.id;
        return toolsById[String(normalizedToolId || '').trim().toLowerCase()]?.downloadedModels || [];
      },
      },
      './toolStateService': {
        buildMergedToolStateList: async () => toolEntries,
        getResolvedToolState: async (toolId) => toolsById[String(toolId || '').trim().toLowerCase()] || null,
      },
      './whisperService': {
        DEFAULT_WHISPER_MODEL: 'base',
        transcribeWithWhisper: async (_tool, request = {}) => transcriptionFixtureFactory(request.audioPath, request.model || 'base'),
      },
      './workflowToolService': {
        generateImageWithWorkflowTool: async () => { throw new Error('Not used in audio verification.'); },
        interrogateImageWithWorkflowTool: async () => { throw new Error('Not used in audio verification.'); },
        resolveSelectedImageTool: () => null,
      },
      './graphWorkflowService': {
        executeGraphWorkflowNode: async () => { throw new Error('Not used in audio verification.'); },
      },
      './localAudioService': {
        generateAudioWithLocalAudioTool: async (tool, request = {}) => generateAudioFixture({ artifactService, request, tool }),
      },
      './localVideoService': {
        generateVideoWithLocalVideoTool: async () => { throw new Error('Not used in audio verification.'); },
      },
      './pipelineToolOrchestrationService': {
        createPipelineToolOrchestrator: () => ({
          dispose: async () => {},
          ensureToolForNode: async () => {},
          releaseToolForNode: async () => {},
        }),
      },
    },
    '/electron/services/pipelineArtifactService.js': {
      './configService': {
        ensureStorage: async () => {},
        getAppPaths: () => ({ runtimesRoot: tempRoot }),
      },
    },
  });
}

function createAudioTranscriptionPipeline(audioPath) {
  return {
    id: 'audio-transcription-pipeline',
    name: 'Audio Transcription Pipeline',
    nodes: [
      { id: 'audio-input', type: 'audioInput', label: 'Audio File', config: { filePath: audioPath } },
      { id: 'whisper-step', type: 'llmPrompt', label: 'Audio Transcription', config: { executionMode: 'localTool', operationId: pipelineSchema.PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE, toolId: 'whisper', model: 'base' } },
      { id: 'text-output', type: 'textOutput', label: 'Text Output', config: { title: 'Transcript result' } },
    ],
    edges: [
      { id: 'edge-audio', source: { nodeId: 'audio-input', portId: 'audio' }, target: { nodeId: 'whisper-step', portId: 'prompt' } },
      { id: 'edge-transcript', source: { nodeId: 'whisper-step', portId: 'text' }, target: { nodeId: 'text-output', portId: 'text' } },
    ],
  };
}

function createAudioOutputPipeline(audioPath) {
  return {
    id: 'audio-output-pipeline',
    name: 'Audio Output Pipeline',
    nodes: [
      { id: 'audio-input', type: 'audioInput', label: 'Audio File', config: { filePath: audioPath } },
      { id: 'audio-output', type: 'audioOutput', label: 'Audio Output', config: { title: 'Audio preview result' } },
    ],
    edges: [
      { id: 'edge-audio', source: { nodeId: 'audio-input', portId: 'audio' }, target: { nodeId: 'audio-output', portId: 'audio' } },
    ],
  };
}

function createAudioStitchPipeline(audioPaths, options = {}) {
  const nodes = [
    { id: 'audio-collection', type: 'collectionInput', label: 'Audio Collection', config: { itemType: pipelineSchema.PORT_KIND_AUDIO, items: audioPaths.map((audioPath, index) => ({ filePath: audioPath, id: 'clip-' + (index + 1), label: 'Clip ' + (index + 1) })) } },
    { id: 'audio-stitch', type: 'audioStitch', label: 'Audio Stitch', config: { gapSeconds: Number(options.gapSeconds || 0) || 0 } },
    { id: 'audio-output', type: 'audioOutput', label: 'Audio Output', config: { title: 'Stitched song' } },
  ];
  return { id: 'audio-stitch-pipeline', name: 'Audio Stitch Pipeline', nodes, edges: [
    { id: 'edge-collection-stitch', source: { nodeId: 'audio-collection', portId: 'collection' }, target: { nodeId: 'audio-stitch', portId: 'collection' } },
    { id: 'edge-stitch-output', source: { nodeId: 'audio-stitch', portId: 'audio' }, target: { nodeId: 'audio-output', portId: 'audio' } },
  ] };
}

function createAudiocraftTextToAudioPipeline(promptText) {
  return {
    id: 'audiocraft-text-pipeline',
    name: 'Audiocraft Text Pipeline',
    nodes: [
      { id: 'text-input', type: 'textInput', label: 'Prompt', config: { text: promptText } },
      {
        id: 'audio-generate',
        type: 'llmPrompt',
        label: 'Generate Audio',
        config: {
          executionMode: 'localTool',
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
          toolId: 'audiocraft-webui',
          audioMode: 'music',
          durationSeconds: 6,
          instruction: 'Warm synth layers with a gentle tape texture.',
          model: '',
        },
      },
      { id: 'audio-output', type: 'audioOutput', label: 'Generated Audio Output', config: { title: 'Generated audio result' } },
    ],
    edges: [
      { id: 'edge-text', source: { nodeId: 'text-input', portId: 'text' }, target: { nodeId: 'audio-generate', portId: 'prompt' } },
      { id: 'edge-audio', source: { nodeId: 'audio-generate', portId: 'audio' }, target: { nodeId: 'audio-output', portId: 'audio' } },
    ],
  };
}

function createAudiocraftAudioGuidancePipeline(audioPath, audioMode = 'music') {
  return {
    id: 'audiocraft-audio-guidance-pipeline',
    name: 'Audiocraft Audio Guidance Pipeline',
    nodes: [
      { id: 'audio-input', type: 'audioInput', label: 'Guide Audio', config: { filePath: audioPath } },
      {
        id: 'audio-generate',
        type: 'llmPrompt',
        label: 'Generate Audio',
        config: {
          executionMode: 'localTool',
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
          toolId: 'audiocraft-webui',
          audioMode,
          durationSeconds: 5,
          instruction: 'Keep the pacing steady and make it more cinematic.',
          model: '',
        },
      },
      { id: 'audio-output', type: 'audioOutput', label: 'Generated Audio Output', config: { title: 'Generated audio result' } },
    ],
    edges: [
      { id: 'edge-source-audio', source: { nodeId: 'audio-input', portId: 'audio' }, target: { nodeId: 'audio-generate', portId: 'prompt' } },
      { id: 'edge-audio-output', source: { nodeId: 'audio-generate', portId: 'audio' }, target: { nodeId: 'audio-output', portId: 'audio' } },
    ],
  };
}

function createAudiocraftContinuationPipeline(audioPath, overrides = {}) {
  return {
    id: 'audiocraft-continuation-pipeline',
    name: 'Audiocraft Continuation Pipeline',
    nodes: [
      { id: 'audio-input', type: 'audioInput', label: 'Source Audio', config: { filePath: audioPath } },
      {
        id: 'audio-generate',
        type: 'llmPrompt',
        label: 'Continue Audio',
        config: {
          executionMode: 'localTool',
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
          toolId: 'audiocraft-webui',
          audioMode: 'continuation',
          continuationSeedSeconds: 10,
          durationSeconds: 12,
          instruction: 'Keep the harmony stable and add a gentle new phrase.',
          model: 'facebook/musicgen-small',
          audiocraftTemperature: 0.85,
          audiocraftTopK: 120,
          audiocraftTopP: 0.2,
          audiocraftCfgCoef: 2.5,
          audiocraftTwoStepCfg: true,
          ...(overrides.config || {}),
        },
      },
      { id: 'audio-output', type: 'audioOutput', label: 'Continuation Output', config: { title: 'Continuation result' } },
    ],
    edges: [
      { id: 'edge-source-audio', source: { nodeId: 'audio-input', portId: 'audio' }, target: { nodeId: 'audio-generate', portId: 'prompt' } },
      { id: 'edge-audio-output', source: { nodeId: 'audio-generate', portId: 'audio' }, target: { nodeId: 'audio-output', portId: 'audio' } },
    ],
  };
}

function createRvcVoiceConversionPipeline(sourceAudioPath, overrides = {}) {
  return {
    id: 'rvc-voice-conversion-pipeline',
    name: 'RVC Voice Conversion Pipeline',
    nodes: [
      { id: 'audio-input', type: 'audioInput', label: 'Source Audio', config: { filePath: sourceAudioPath } },
      {
        id: 'audio-transform',
        type: 'llmPrompt',
        label: 'Transform Audio',
        config: {
          executionMode: 'localTool',
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM,
          toolId: 'rvc',
          instruction: 'Convert this clip into the selected voice while keeping it intelligible.',
          model: Object.prototype.hasOwnProperty.call(overrides, 'model') ? overrides.model : 'voices/test-voice.pth',
        },
      },
      { id: 'audio-output', type: 'audioOutput', label: 'Transformed Audio Output', config: { title: 'Transformed audio result' } },
    ],
    edges: [
      { id: 'edge-source-audio', source: { nodeId: 'audio-input', portId: 'audio' }, target: { nodeId: 'audio-transform', portId: 'prompt' } },
      { id: 'edge-audio-output', source: { nodeId: 'audio-transform', portId: 'audio' }, target: { nodeId: 'audio-output', portId: 'audio' } },
    ],
  };
}

function createCloudAudioPipeline(promptText, overrides = {}) {
  return {
    id: 'cloud-audio-pipeline',
    name: 'Cloud Audio Pipeline',
    nodes: [
      { id: 'text-input', type: 'textInput', label: 'Prompt', config: { text: promptText } },
      {
        id: 'audio-generate',
        type: 'llmPrompt',
        label: 'Generate Speech',
        config: {
          executionMode: 'cloud',
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
          providerId: 'google',
          model: 'models/gemini-2.5-flash-preview-tts',
          instruction: 'Speak in a calm, friendly tone.',
          audioVoice: 'Kore',
          ...overrides,
        },
      },
      { id: 'audio-output', type: 'audioOutput', label: 'Generated Audio Output', config: { title: 'Generated audio result' } },
    ],
    edges: [
      { id: 'edge-text', source: { nodeId: 'text-input', portId: 'text' }, target: { nodeId: 'audio-generate', portId: 'prompt' } },
      { id: 'edge-audio-output', source: { nodeId: 'audio-generate', portId: 'audio' }, target: { nodeId: 'audio-output', portId: 'audio' } },
    ],
  };
}

function createGoogleProvider(overrides = {}) {
  return {
    id: 'google',
    name: 'Google (Gemini)',
    isConnected: true,
    lastTestSucceeded: true,
    lastTestedAt: new Date('2026-03-18T12:00:00.000Z').toISOString(),
    statusLabel: 'Connected',
    ...overrides,
  };
}

function createOpenAiProvider(overrides = {}) {
  return {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    isConnected: true,
    lastTestSucceeded: true,
    lastTestedAt: new Date('2026-03-18T12:00:00.000Z').toISOString(),
    statusLabel: 'Connected',
    ...overrides,
  };
}

function createXaiProvider(overrides = {}) {
  return {
    id: 'xai',
    name: 'xAI (Grok)',
    isConnected: true,
    lastTestSucceeded: true,
    lastTestedAt: new Date('2026-03-18T12:00:00.000Z').toISOString(),
    statusLabel: 'Connected',
    ...overrides,
  };
}

function createWhisperTool(overrides = {}) {
  return {
    id: 'whisper',
    installDir: overrides.installDir || '',
    launchProfile: overrides.launchProfile || { kind: 'python-script', pythonPath: 'python' },
    launchSupported: overrides.launchSupported !== false,
    lastError: overrides.lastError || '',
    name: 'Whisper',
    pythonBootstrapPath: overrides.pythonBootstrapPath || 'python',
    status: overrides.status || 'stopped',
    ...overrides,
  };
}

function createAudiocraftTool(overrides = {}) {
  return {
    id: 'audiocraft-webui',
    appDir: overrides.appDir || overrides.installDir || '',
    installDir: overrides.installDir || '',
    launchProfile: overrides.launchProfile || { kind: 'python-script', pythonPath: 'python' },
    launchSupported: overrides.launchSupported !== false,
    lastError: overrides.lastError || '',
    name: 'AudioCraft WebUI',
    pythonBootstrapPath: overrides.pythonBootstrapPath || 'python',
    status: overrides.status || 'stopped',
    ...overrides,
  };
}

function createRvcModel(overrides = {}) {
  const modelPath = path.resolve(String(overrides.path || path.join(overrides.weightsRoot || overrides.appDir || overrides.installDir || process.cwd(), 'weights', 'voices', 'test-voice.pth')).trim());
  const weightsRoot = path.resolve(String(overrides.weightsRoot || path.join(path.dirname(modelPath), '..')).trim());
  const relativePath = String(overrides.relativePath || path.relative(weightsRoot, modelPath)).replace(/\\/g, '/');
  const fileName = String(overrides.fileName || path.basename(modelPath)).trim();
  const name = String(overrides.name || path.parse(fileName).name).trim();
  const modelType = String(overrides.modelType || 'Audio / Speech').trim();
  const modelId = overrides.id || ('rvc:' + modelType + ':' + relativePath.replace(/[\\/]+/g, ':'));
  return {
    downloaded: true,
    fileName,
    id: modelId,
    modelType,
    name,
    path: modelPath,
    relativePath,
    sizeBytes: Number(overrides.sizeBytes || 0) || 0,
    source: overrides.source || 'local',
    toolId: overrides.toolId || 'rvc',
    ...overrides,
    fileName,
    id: modelId,
    modelType,
    name,
    path: modelPath,
    relativePath,
  };
}

function createRvcTool(overrides = {}) {
  return {
    id: 'rvc',
    appDir: overrides.appDir || overrides.installDir || '',
    downloadedModels: Array.isArray(overrides.downloadedModels) ? overrides.downloadedModels : [],
    installDir: overrides.installDir || '',
    launchProfile: overrides.launchProfile || { kind: 'python-script', pythonPath: 'python' },
    launchSupported: overrides.launchSupported !== false,
    lastError: overrides.lastError || '',
    name: 'RVC',
    pythonBootstrapPath: overrides.pythonBootstrapPath || 'python',
    status: overrides.status || 'stopped',
    ...overrides,
  };
}

async function runPipelineToCompletion(service, definition) {
  const finalStatuses = new Set(['completed', 'failed', 'cancelled']);
  let runId = '';

  const completionPromise = new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      service.setPipelineEventSink(null);
      reject(new Error('Timed out while waiting for the pipeline run to finish.'));
    }, 15000);

    service.setPipelineEventSink((event) => {
      const run = event?.run || null;
      if (!run || (runId && run.runId !== runId)) {
        return;
      }

      if (!runId) {
        runId = run.runId || '';
      }

      if (!finalStatuses.has(run.status)) {
        return;
      }

      clearTimeout(timeoutHandle);
      service.setPipelineEventSink(null);
      resolve(run);
    });
  });

  const initialRun = await service.runPipeline(definition);
  runId = initialRun.runId;
  if (finalStatuses.has(initialRun.status)) {
    service.setPipelineEventSink(null);
    return initialRun;
  }

  return completionPromise;
}

function verifyWhisperReadinessStates(audioPath) {
  const definition = createAudioTranscriptionPipeline(audioPath);

  const missingWhisperAnalysis = pipelineSchema.analyzePipeline(definition, { tools: [] });
  assert.strictEqual(missingWhisperAnalysis.nodeSummaries['whisper-step'].readiness.tone, 'error', 'Expected Whisper readiness to fail when the tool is missing.');
  assert(missingWhisperAnalysis.nodeSummaries['whisper-step'].readiness.message.includes('Install Whisper'), 'Expected missing Whisper readiness to explain that Whisper must be installed.');

  const startableWhisperAnalysis = pipelineSchema.analyzePipeline(definition, {
    tools: [createWhisperTool({ installDir: path.dirname(audioPath), status: 'stopped' })],
  });
  assert.strictEqual(startableWhisperAnalysis.nodeSummaries['whisper-step'].readiness.tone, 'warn', 'Expected stopped Whisper readiness to stay runnable with an honest warning.');
  assert(startableWhisperAnalysis.nodeSummaries['whisper-step'].readiness.message.includes('start it automatically'), 'Expected stopped Whisper readiness to explain that Local AI Hub can start Whisper automatically.');

  const brokenWhisperAnalysis = pipelineSchema.analyzePipeline(definition, {
    tools: [createWhisperTool({ installDir: path.dirname(audioPath), lastError: 'Whisper needs repair before it can launch.', status: 'error' })],
  });
  assert.strictEqual(brokenWhisperAnalysis.nodeSummaries['whisper-step'].readiness.tone, 'error', 'Expected broken Whisper readiness to stay blocked.');
  assert.strictEqual(brokenWhisperAnalysis.nodeSummaries['whisper-step'].readiness.message, 'Whisper needs repair before it can launch.');
}

function verifyAudiocraftReadinessStates(tempRoot, audioPath) {
  const missingAnalysis = pipelineSchema.analyzePipeline(createAudiocraftTextToAudioPipeline('Build a gentle ambient loop.'), { tools: [] });
  assert.strictEqual(missingAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'error', 'Expected missing AudioCraft readiness to fail.');
  assert(missingAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('Install AudioCraft WebUI'), 'Expected missing AudioCraft readiness to explain that AudioCraft must be installed.');

  const emptyVoiceModelAnalysis = pipelineSchema.analyzePipeline(createRvcVoiceConversionPipeline(audioPath, { model: 'missing-voice.pth' }), {
    tools: [createRvcTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped', downloadedModels: [] })],
  });
  assert.strictEqual(emptyVoiceModelAnalysis.nodeSummaries['audio-transform'].readiness.tone, 'error', 'Expected empty RVC weights readiness to fail.');
  assert(emptyVoiceModelAnalysis.nodeSummaries['audio-transform'].readiness.message.includes('No RVC voice models were found'), 'Expected empty RVC weights readiness to explain the manual placement path.');
  const readyAnalysis = pipelineSchema.analyzePipeline(createAudiocraftTextToAudioPipeline('Build a gentle ambient loop.'), {
    tools: [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })],
  });
  const readySummary = readyAnalysis.nodeSummaries['audio-generate'];
  assert.strictEqual(readySummary.readiness.tone, 'info', 'Expected installed AudioCraft readiness to be positive in this direct-adapter path.');
  assert(readySummary.readiness.message.includes('dedicated local backend adapter'), 'Expected AudioCraft readiness to explain the dedicated backend adapter path.');
  assert.strictEqual(readySummary.capabilitySummary.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'Expected the AudioCraft model step to resolve to audio generation.');
  assert(readySummary.capabilitySummary.inputKinds.includes('text'), 'Expected AudioCraft capability summary to accept text input.');
  assert(readySummary.capabilitySummary.inputKinds.includes('audio'), 'Expected AudioCraft capability summary to accept audio guidance input.');
  assert(readySummary.capabilitySummary.outputKinds.includes('audio'), 'Expected AudioCraft capability summary to produce audio output.');
  assert.deepStrictEqual(readySummary.capabilitySummary.operationSubtypes, ['music', 'sound', 'continuation'], 'Expected AudioCraft capability summary to expose supported audio generation subtypes.');

  const continuationReadyAnalysis = pipelineSchema.analyzePipeline(createAudiocraftContinuationPipeline(audioPath), {
    tools: [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })],
  });
  assert.strictEqual(continuationReadyAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'info', 'Expected AudioCraft continuation readiness to pass when audio input is connected.');
  assert(continuationReadyAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('Continuation mode'), 'Expected AudioCraft continuation readiness to describe continuation mode.');

  const continuationWithoutAudio = createAudiocraftTextToAudioPipeline('Continue this idea.');
  continuationWithoutAudio.nodes.find((node) => node.id === 'audio-generate').config.audioMode = 'continuation';
  const continuationMissingSourceAnalysis = pipelineSchema.analyzePipeline(continuationWithoutAudio, {
    tools: [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })],
  });
  assert.strictEqual(continuationMissingSourceAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'error', 'Expected AudioCraft continuation readiness to require a source audio edge.');
  assert(continuationMissingSourceAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('connected source audio'), 'Expected continuation readiness to explain the missing source audio requirement.');

  const invalidSeedAnalysis = pipelineSchema.analyzePipeline(createAudiocraftContinuationPipeline(audioPath, { config: { continuationSeedSeconds: 0 } }), {
    tools: [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })],
  });
  assert.strictEqual(invalidSeedAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'error', 'Expected AudioCraft continuation readiness to reject invalid seed seconds.');
  assert(invalidSeedAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('seed seconds'), 'Expected invalid continuation seed readiness to explain the seed requirement.');

  const invalidRepeatAnalysis = pipelineSchema.analyzePipeline(createAudiocraftContinuationPipeline(audioPath, { config: { continuationRepeatCount: 0 } }), {
    tools: [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })],
  });
  assert.strictEqual(invalidRepeatAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'error', 'Expected AudioCraft continuation readiness to reject invalid repeat count.');
  assert(invalidRepeatAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('repeat count'), 'Expected invalid continuation repeat readiness to explain the repeat requirement.');

  const invalidDurationAnalysis = pipelineSchema.analyzePipeline(createAudiocraftContinuationPipeline(audioPath, { config: { durationSeconds: 0 } }), {
    tools: [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })],
  });
  assert.strictEqual(invalidDurationAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'error', 'Expected AudioCraft continuation readiness to reject invalid generation duration.');
  assert(invalidDurationAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('duration'), 'Expected invalid continuation duration readiness to explain the duration requirement.');

  const brokenAnalysis = pipelineSchema.analyzePipeline(createAudiocraftTextToAudioPipeline('Build a gentle ambient loop.'), {
    tools: [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, lastError: 'AudioCraft needs repair before it can launch.', status: 'error' })],
  });
  assert.strictEqual(brokenAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'error', 'Expected broken AudioCraft readiness to stay blocked.');
  assert.strictEqual(brokenAnalysis.nodeSummaries['audio-generate'].readiness.message, 'AudioCraft needs repair before it can launch.');

  const soundModeAnalysis = pipelineSchema.analyzePipeline(createAudiocraftAudioGuidancePipeline(audioPath, 'sound'), {
    tools: [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot })],
  });
  assert.strictEqual(soundModeAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'error', 'Expected Sound mode plus audio input to be rejected.');
  assert(soundModeAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('Sound mode currently accepts text prompts only'), 'Expected Sound mode validation to explain why audio guidance is blocked.');
}

async function verifyWhisperPipelineRun(tempRoot, audioPath) {
  const toolEntries = [createWhisperTool({ installDir: tempRoot, status: 'stopped' })];
  const service = createPipelineExecutionService(tempRoot, toolEntries, { transcriptionFixtureFactory: createTranscriptionFixture });
  const completedRun = await runPipelineToCompletion(service, createAudioTranscriptionPipeline(audioPath));

  assert.strictEqual(completedRun.status, 'completed', 'Expected the Whisper pipeline test run to complete successfully.');
  assert.strictEqual(completedRun.terminalResults.length, 1, 'Expected one terminal result from the Whisper pipeline.');

  const result = completedRun.terminalResults[0];
  assert.strictEqual(result.kind, 'text', 'Expected the transcription pipeline to end with a text artifact.');
  assert.strictEqual(result.artifact.previewKind, 'text', 'Expected transcript artifacts to stay on the text preview path.');
  assert.strictEqual(result.transcription.language, 'en', 'Expected the terminal result to expose detected transcription language.');
  assert.strictEqual(result.transcription.runtime.device, 'cpu', 'Expected the terminal result to expose Whisper runtime metadata.');
  assert.strictEqual(result.transcription.segmentCount, 2, 'Expected the terminal result to expose segment count metadata.');
  assert(result.transcription.sourceAudio.fileName.endsWith('.wav'), 'Expected the transcript metadata to retain the source audio file name.');
  assert.strictEqual(result.supportingPaths.length, 1, 'Expected the transcript output to save one supporting metadata file.');
  assert(result.supportingPaths[0].endsWith('.transcription.json'), 'Expected the supporting metadata file to use the transcription sidecar extension.');
  assert(fs.existsSync(result.destinationPath), 'Expected the transcript output file to be written to disk.');
  assert(fs.existsSync(result.supportingPaths[0]), 'Expected the transcription sidecar file to be written to disk.');

  const sidecar = JSON.parse(await fsp.readFile(result.supportingPaths[0], 'utf8'));
  assert.strictEqual(sidecar.segmentCount, 2, 'Expected the saved sidecar to preserve timed segment metadata.');
  assert.strictEqual(sidecar.runtime.device, 'cpu', 'Expected the saved sidecar to preserve runtime metadata.');
  assert.strictEqual(sidecar.sourceAudio.fileName, path.basename(audioPath), 'Expected the saved sidecar to preserve the source audio file name.');
}

async function verifyAudioOutputRun(tempRoot, audioPath) {
  const service = createPipelineExecutionService(tempRoot, [], { transcriptionFixtureFactory: createTranscriptionFixture });
  const completedRun = await runPipelineToCompletion(service, createAudioOutputPipeline(audioPath));

  assert.strictEqual(completedRun.status, 'completed', 'Expected the audio preview pipeline test run to complete successfully.');
  assert.strictEqual(completedRun.terminalResults.length, 1, 'Expected one terminal result from the audio preview pipeline.');

  const result = completedRun.terminalResults[0];
  assert.strictEqual(result.kind, 'audio', 'Expected the audio output pipeline to keep the audio modality.');
  assert.strictEqual(result.artifact.previewKind, 'audio', 'Expected the audio output pipeline to keep the audio preview kind.');
  assert(fs.existsSync(result.destinationPath), 'Expected the saved audio artifact to exist on disk.');
}

async function verifyAudioStitchRun(tempRoot) {
  const stitchDefinitionNode = pipelineSchema.getNodeTypeDefinition('audioStitch');
  assert(stitchDefinitionNode, 'Audio Stitch node should exist in the pipeline schema.');
  assert.strictEqual(stitchDefinitionNode.category, 'Flow', 'Audio Stitch should live in the existing Flow palette section.');
  assert.strictEqual(stitchDefinitionNode.inputPorts[0].kind, pipelineSchema.PORT_KIND_AUDIO, 'Audio Stitch should accept audio items.');
  assert.strictEqual(stitchDefinitionNode.inputPorts[0].collectionBehavior, 'only', 'Audio Stitch should require collection:audio input.');
  assert.strictEqual(stitchDefinitionNode.outputPorts[0].kind, pipelineSchema.PORT_KIND_AUDIO, 'Audio Stitch should output a single audio artifact.');

  const firstPath = path.join(tempRoot, 'stitch-first.wav');
  const secondPath = path.join(tempRoot, 'stitch-second.wav');
  await fsp.writeFile(firstPath, createWaveBuffer({ durationSeconds: 1, frequency: 220, sampleRate: 16000 }));
  await fsp.writeFile(secondPath, createWaveBuffer({ durationSeconds: 1, frequency: 330, sampleRate: 16000 }));
  const definition = createAudioStitchPipeline([firstPath, secondPath], { gapSeconds: 0.25 });
  const analysis = pipelineSchema.analyzePipeline(definition, {});
  assert.strictEqual(analysis.nodeSummaries['audio-stitch'].readiness.tone, 'info', 'Audio Stitch should be ready with a connected audio collection.');

  const service = createPipelineExecutionService(tempRoot, [], { transcriptionFixtureFactory: createTranscriptionFixture });
  const completedRun = await runPipelineToCompletion(service, definition);
  assert.strictEqual(completedRun.status, 'completed', 'Expected Audio Stitch pipeline to complete successfully.');
  const result = completedRun.terminalResults[0];
  assert.strictEqual(result.kind, 'audio', 'Audio Stitch should produce an audio terminal result through Audio Output.');
  assert.strictEqual(result.audioStitch.sourceItemCount, 2, 'Audio Stitch terminal metadata should record source item count.');
  assert.strictEqual(result.audioStitch.gapSeconds, 0.25, 'Audio Stitch metadata should preserve gap seconds.');
  assert.strictEqual(result.audioStitch.sourceItems[0].fileName, 'stitch-first.wav', 'Audio Stitch should preserve collection order for the first source item.');
  assert.strictEqual(result.audioStitch.sourceItems[1].fileName, 'stitch-second.wav', 'Audio Stitch should preserve collection order for the second source item.');
  assert(result.audioStitch.totalDurationSeconds >= 2.24 && result.audioStitch.totalDurationSeconds <= 2.26, 'Audio Stitch should include clip durations plus configured gap duration.');
  assert(fs.existsSync(result.destinationPath), 'Expected the stitched audio output file to exist.');
  const sidecarPath = result.supportingPaths.find((entry) => entry.endsWith('.audio.json'));
  assert(sidecarPath && fs.existsSync(sidecarPath), 'Expected Audio Stitch to save an audio metadata sidecar.');
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.audioStitch.sourceItemCount, 2, 'Audio Stitch sidecar should preserve source item count.');
  assert.strictEqual(sidecar.audioStitch.sourceItems[0].fileName, 'stitch-first.wav', 'Audio Stitch sidecar should preserve source item order.');

  const mismatchedPath = path.join(tempRoot, 'stitch-mismatched.wav');
  await fsp.writeFile(mismatchedPath, createWaveBuffer({ durationSeconds: 1, frequency: 440, sampleRate: 24000 }));
  const failedRun = await runPipelineToCompletion(service, createAudioStitchPipeline([firstPath, mismatchedPath]));
  assert.strictEqual(failedRun.status, 'failed', 'Expected Audio Stitch to fail clearly for mismatched WAV formats.');
  assert(/sample rate|normalize/i.test(failedRun.message || ''), 'Expected mismatched WAV failure to explain normalization or sample-rate mismatch.');
}

async function verifyAudiocraftTextPipelineRun(tempRoot) {
  const toolEntries = [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })];
  const audioCalls = [];
  const service = createPipelineExecutionService(tempRoot, toolEntries, {
    generateAudioFixture: async ({ artifactService, request, tool }) => {
      audioCalls.push({ request, tool });
      const outputPath = path.join(request.runDirectories.artifactsDir, 'audiocraft-text-result.wav');
      await fsp.writeFile(outputPath, createWaveBuffer({ channelCount: 2, durationSeconds: request.durationSeconds, frequency: 330, sampleRate: 32000 }));
      const artifact = await artifactService.buildFileArtifact(outputPath, {
        audioGeneration: {
          backend: 'audiocraft',
          backendLabel: 'AudioCraft',
          durationSeconds: request.durationSeconds,
          mode: request.audioMode,
          model: 'facebook/musicgen-medium',
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
          operationSubtype: request.audioMode,
          prompt: request.prompt,
          toolId: tool.id,
          toolLabel: tool.name,
        },
        displayName: request.displayName || request.nodeLabel || 'Generated Audio',
        kind: pipelineSchema.PORT_KIND_AUDIO,
        role: 'generated',
      });
      return {
        destinationPath: artifact.filePath,
        message: tool.name + ' generated audio locally.',
        outputs: { audio: artifact },
        preview: artifactService.summarizeArtifact(artifact),
      };
    },
  });

  const completedRun = await runPipelineToCompletion(service, createAudiocraftTextToAudioPipeline('Build a warm analog drone with a slow pulse.'));
  assert.strictEqual(completedRun.status, 'completed', 'Expected the Audiocraft text-to-audio pipeline to complete successfully.');
  assert.strictEqual(audioCalls.length, 1, 'Expected the local audio adapter to run exactly once for the text-to-audio pipeline.');
  assert.strictEqual(audioCalls[0].request.audioMode, 'music', 'Expected the text-to-audio pipeline to request Music mode.');
  assert(audioCalls[0].request.prompt.includes('Build a warm analog drone with a slow pulse.'), 'Expected the outgoing local audio request to include the incoming prompt text.');

  const result = completedRun.terminalResults[0];
  assert.strictEqual(result.kind, 'audio', 'Expected the Audiocraft text pipeline to end with an audio artifact.');
  assert.strictEqual(result.artifact.previewKind, 'audio', 'Expected the generated audio artifact to stay on the audio preview path.');
  assert.strictEqual(result.audioGeneration.mode, 'music', 'Expected the terminal result to expose the generation mode.');
  assert.strictEqual(result.audioGeneration.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'Expected the terminal result to expose the audio generation operation id.');
  assert.strictEqual(result.audioGeneration.operationSubtype, 'music', 'Expected the terminal result to expose the audio generation subtype.');
  assert.strictEqual(result.audioGeneration.toolId, 'audiocraft-webui', 'Expected the terminal result to expose the producing tool id.');
  assert.strictEqual(result.audio.channelCount, 2, 'Expected the generated audio metadata to preserve the stereo channel count.');
  assert(result.supportingPaths.some((entry) => entry.endsWith('.audio.json')), 'Expected generated audio outputs to save an audio metadata sidecar.');

  const sidecarPath = result.supportingPaths.find((entry) => entry.endsWith('.audio.json'));
  assert(fs.existsSync(sidecarPath), 'Expected the generated audio sidecar to exist on disk.');
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.audioGeneration.mode, 'music', 'Expected the saved audio sidecar to preserve the generation mode.');
  assert.strictEqual(sidecar.audioGeneration.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'Expected the saved audio sidecar to preserve the generation operation id.');
  assert.strictEqual(sidecar.audioGeneration.operationSubtype, 'music', 'Expected the saved audio sidecar to preserve the generation subtype.');
  assert.strictEqual(sidecar.audioGeneration.toolLabel, 'AudioCraft WebUI', 'Expected the saved audio sidecar to preserve the producing tool label.');
}

async function verifyAudiocraftGuidedPipelineRun(tempRoot, sourceAudioPath) {
  const toolEntries = [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })];
  const audioCalls = [];
  const service = createPipelineExecutionService(tempRoot, toolEntries, {
    generateAudioFixture: async ({ artifactService, request, tool }) => {
      audioCalls.push({ request, tool });
      const outputPath = path.join(request.runDirectories.artifactsDir, 'audiocraft-guided-result.wav');
      await fsp.writeFile(outputPath, createWaveBuffer({ channelCount: 2, durationSeconds: request.durationSeconds, frequency: 440, sampleRate: 32000 }));
      const artifact = await artifactService.buildFileArtifact(outputPath, {
        audioGeneration: {
          backend: 'audiocraft',
          backendLabel: 'AudioCraft',
          durationSeconds: request.durationSeconds,
          mode: request.audioMode,
          model: 'facebook/musicgen-melody',
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
          operationSubtype: request.audioMode,
          prompt: request.prompt,
          sourceAudio: request.sourceAudioArtifact ? {
            displayName: request.sourceAudioArtifact.displayName,
            fileName: request.sourceAudioArtifact.fileName,
            filePath: request.sourceAudioArtifact.filePath,
            fileUrl: request.sourceAudioArtifact.fileUrl,
            formatLabel: request.sourceAudioArtifact.formatLabel,
            kind: request.sourceAudioArtifact.kind,
            mimeType: request.sourceAudioArtifact.mimeType,
            sizeBytes: request.sourceAudioArtifact.sizeBytes,
            summary: request.sourceAudioArtifact.summary,
          } : null,
          toolId: tool.id,
          toolLabel: tool.name,
        },
        displayName: request.displayName || request.nodeLabel || 'Guided Audio',
        kind: pipelineSchema.PORT_KIND_AUDIO,
        role: 'generated',
      });
      return {
        destinationPath: artifact.filePath,
        message: tool.name + ' generated guided audio locally.',
        outputs: { audio: artifact },
        preview: artifactService.summarizeArtifact(artifact),
      };
    },
  });

  const completedRun = await runPipelineToCompletion(service, createAudiocraftAudioGuidancePipeline(sourceAudioPath, 'music'));
  assert.strictEqual(completedRun.status, 'completed', 'Expected the Audiocraft audio-guided pipeline to complete successfully.');
  assert.strictEqual(audioCalls.length, 1, 'Expected the local audio adapter to run exactly once for the audio-guided pipeline.');
  assert.strictEqual(audioCalls[0].request.audioMode, 'music', 'Expected the guided run to stay in Music mode.');
  assert.strictEqual(audioCalls[0].request.sourceAudioPath, sourceAudioPath, 'Expected the outgoing local audio request to retain the upstream audio file path.');
  assert.strictEqual(audioCalls[0].request.sourceAudioArtifact.fileName, path.basename(sourceAudioPath), 'Expected the outgoing local audio request to retain the upstream audio artifact metadata.');

  const result = completedRun.terminalResults[0];
  assert.strictEqual(result.audioGeneration.sourceAudio.fileName, path.basename(sourceAudioPath), 'Expected the terminal result to expose the routed source audio reference.');
  const sidecarPath = result.supportingPaths.find((entry) => entry.endsWith('.audio.json'));
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.audioGeneration.sourceAudio.fileName, path.basename(sourceAudioPath), 'Expected the saved audio sidecar to preserve the routed source audio reference.');
}

function verifyRvcReadinessStates(tempRoot, audioPath) {
  const readyModel = createRvcModel({ path: path.join(tempRoot, 'weights', 'voices', 'test-voice.pth') });
  const missingAnalysis = pipelineSchema.analyzePipeline(createRvcVoiceConversionPipeline(audioPath), { tools: [] });
  assert.strictEqual(missingAnalysis.nodeSummaries['audio-transform'].readiness.tone, 'error', 'Expected missing RVC readiness to fail.');
  assert(missingAnalysis.nodeSummaries['audio-transform'].readiness.message.includes('Install RVC'), 'Expected missing RVC readiness to explain that RVC must be installed.');
  const missingModelAnalysis = pipelineSchema.analyzePipeline(createRvcVoiceConversionPipeline(audioPath, { model: '' }), {
    tools: [createRvcTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped', downloadedModels: [readyModel] })],
  });
  assert.strictEqual(missingModelAnalysis.nodeSummaries['audio-transform'].readiness.tone, 'error', 'Expected RVC readiness to require a selected voice model.');
  assert(missingModelAnalysis.nodeSummaries['audio-transform'].readiness.message.includes('Choose an RVC voice model'), 'Expected missing RVC model readiness to explain that a voice model must be selected.');
  const unavailableModelAnalysis = pipelineSchema.analyzePipeline(createRvcVoiceConversionPipeline(audioPath, { model: 'missing-voice.pth' }), {
    tools: [createRvcTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped', downloadedModels: [readyModel] })],
  });
  assert.strictEqual(unavailableModelAnalysis.nodeSummaries['audio-transform'].readiness.tone, 'error', 'Expected unavailable RVC model readiness to fail.');
  assert(unavailableModelAnalysis.nodeSummaries['audio-transform'].readiness.message.includes('not available locally'), 'Expected unavailable RVC model readiness to explain the local-model requirement.');
  const readyAnalysis = pipelineSchema.analyzePipeline(createRvcVoiceConversionPipeline(audioPath), {
    tools: [createRvcTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped', downloadedModels: [readyModel] })],
  });
  const readySummary = readyAnalysis.nodeSummaries['audio-transform'];
  assert.strictEqual(readySummary.readiness.tone, 'info', 'Expected installed RVC readiness to be positive.');
  assert(readySummary.readiness.message.includes('dry single-speaker voice clip'), 'Expected RVC readiness to explain the first-pass source-audio suitability guidance.');
  assert.strictEqual(readySummary.capabilitySummary.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM, 'Expected the RVC model step to resolve to audio transform.');
  assert(readySummary.capabilitySummary.inputKinds.includes('audio'), 'Expected RVC capability summary to accept audio input.');
  assert(readySummary.capabilitySummary.outputKinds.includes('audio'), 'Expected RVC capability summary to produce audio output.');
  assert.deepStrictEqual(readySummary.capabilitySummary.operationSubtypes, ['voice-conversion'], 'Expected RVC capability summary to expose voice conversion as the audio transform subtype.');
  assert.deepStrictEqual(readySummary.capabilitySummary.transformSubtypes, ['voice-conversion'], 'Expected RVC capability summary to preserve voice conversion as a transform subtype.');

  const brokenAnalysis = pipelineSchema.analyzePipeline(createRvcVoiceConversionPipeline(audioPath), {
    tools: [createRvcTool({ appDir: tempRoot, installDir: tempRoot, lastError: 'RVC needs repair before it can launch.', status: 'error', downloadedModels: [readyModel] })],
  });
  assert.strictEqual(brokenAnalysis.nodeSummaries['audio-transform'].readiness.tone, 'error', 'Expected broken RVC readiness to stay blocked.');
  assert.strictEqual(brokenAnalysis.nodeSummaries['audio-transform'].readiness.message, 'RVC needs repair before it can launch.');

  const wrongSourcePipeline = {
    id: 'rvc-wrong-source-pipeline',
    name: 'RVC Wrong Source Pipeline',
    nodes: [
      { id: 'text-input', type: 'textInput', label: 'Source Text', config: { text: 'This is not audio.' } },
      createRvcVoiceConversionPipeline(audioPath).nodes[1],
      { id: 'audio-output', type: 'audioOutput', label: 'Transformed Audio Output', config: { title: 'Transformed audio result' } },
    ],
    edges: [
      { id: 'edge-text', source: { nodeId: 'text-input', portId: 'text' }, target: { nodeId: 'audio-transform', portId: 'prompt' } },
      { id: 'edge-audio-output', source: { nodeId: 'audio-transform', portId: 'audio' }, target: { nodeId: 'audio-output', portId: 'audio' } },
    ],
  };
  const wrongSourceAnalysis = pipelineSchema.analyzePipeline(wrongSourcePipeline, {
    tools: [createRvcTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped', downloadedModels: [readyModel] })],
  });
  assert.strictEqual(wrongSourceAnalysis.nodeSummaries['audio-transform'].readiness.tone, 'error', 'Expected RVC readiness to reject non-audio source input.');
  assert(wrongSourceAnalysis.nodeSummaries['audio-transform'].readiness.message.includes('does not accept Text'), 'Expected RVC wrong-source readiness to explain that audio input is required.');
}

async function verifyAudiocraftContinuationPipelineRun(tempRoot, sourceAudioPath) {
  const toolEntries = [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })];
  const audioCalls = [];
  const service = createPipelineExecutionService(tempRoot, toolEntries, {
    generateAudioFixture: async ({ artifactService, request, tool }) => {
      audioCalls.push({ request, tool });
      const repeatCount = Math.max(1, Number(request.continuationRepeatCount || 1) || 1);
      const generatedDurationSeconds = request.durationSeconds * repeatCount;
      const outputPath = path.join(request.runDirectories.artifactsDir, 'audiocraft-continuation-result.wav');
      await fsp.writeFile(outputPath, createWaveBuffer({ channelCount: 2, durationSeconds: generatedDurationSeconds, frequency: 510, sampleRate: 32000 }));
      const artifact = await artifactService.buildFileArtifact(outputPath, {
        audioGeneration: {
          advancedSettings: {
            cfgCoef: request.audiocraftCfgCoef,
            temperature: request.audiocraftTemperature,
            topK: request.audiocraftTopK,
            topP: request.audiocraftTopP,
            twoStepCfg: request.audiocraftTwoStepCfg,
          },
          appendSource: false,
          backend: 'audiocraft',
          backendLabel: 'AudioCraft',
          continuationRepeatCount: repeatCount,
          continuationRepeats: Array.from({ length: repeatCount }, (_entry, index) => ({
            repeatIndex: index + 1,
            seedStartSeconds: 8 + (index * request.durationSeconds),
            seedEndSeconds: 18 + (index * request.durationSeconds),
            seedSeconds: request.continuationSeedSeconds,
            generatedSegmentDurationSeconds: request.durationSeconds,
            cumulativeDurationAfterRepeatSeconds: 18 + ((index + 1) * request.durationSeconds),
          })),
          continuationSeedSeconds: request.continuationSeedSeconds,
          durationSeconds: generatedDurationSeconds,
          finalOutputDurationSeconds: generatedDurationSeconds,
          generatedDurationSeconds,
          lineage: {
            sourceFileName: request.sourceAudioArtifact?.fileName || '',
            sourceFilePath: request.sourceAudioPath,
            sourceKind: request.sourceAudioArtifact?.kind || '',
          },
          mode: request.audioMode,
          model: request.model,
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
          operationSubtype: request.audioMode,
          prompt: request.prompt,
          repeatCount,
          requestedGeneratedDurationSeconds: generatedDurationSeconds,
          sourceAudio: request.sourceAudioArtifact ? {
            displayName: request.sourceAudioArtifact.displayName,
            fileName: request.sourceAudioArtifact.fileName,
            filePath: request.sourceAudioArtifact.filePath,
            fileUrl: request.sourceAudioArtifact.fileUrl,
            formatLabel: request.sourceAudioArtifact.formatLabel,
            kind: request.sourceAudioArtifact.kind,
            mimeType: request.sourceAudioArtifact.mimeType,
            sizeBytes: request.sourceAudioArtifact.sizeBytes,
            summary: request.sourceAudioArtifact.summary,
          } : null,
          sourceAudioPath: request.sourceAudioPath,
          sourceDurationSeconds: 18,
          toolId: tool.id,
          toolLabel: tool.name,
        },
        displayName: request.displayName || request.nodeLabel || 'Continuation Audio',
        kind: pipelineSchema.PORT_KIND_AUDIO,
        role: 'generated',
      });
      return {
        destinationPath: artifact.filePath,
        message: tool.name + ' generated a continuation locally.',
        outputs: { audio: artifact },
        preview: artifactService.summarizeArtifact(artifact),
      };
    },
  });

  const completedRun = await runPipelineToCompletion(service, createAudiocraftContinuationPipeline(sourceAudioPath));
  assert.strictEqual(completedRun.status, 'completed', 'Expected the Audiocraft continuation pipeline to complete successfully.');
  assert.strictEqual(audioCalls.length, 1, 'Expected the local audio adapter to run exactly once for the continuation pipeline.');
  assert.strictEqual(audioCalls[0].request.audioMode, 'continuation', 'Expected the continuation run to request AudioCraft continuation mode.');
  assert.strictEqual(audioCalls[0].request.sourceAudioPath, sourceAudioPath, 'Expected continuation to pass the upstream source audio file path.');
  assert.strictEqual(audioCalls[0].request.continuationSeedSeconds, 10, 'Expected continuation to pass the configured seed seconds.');
  assert.strictEqual(audioCalls[0].request.durationSeconds, 12, 'Expected continuation to pass the generated duration separately from the seed.');
  assert.strictEqual(audioCalls[0].request.appendSource, false, 'Expected continuation-only mode to keep appendSource false by default.');
  assert.strictEqual(audioCalls[0].request.continuationRepeatCount, 1, 'Expected continuation to default to one repeat.');
  assert.strictEqual(audioCalls[0].request.model, 'facebook/musicgen-small', 'Expected continuation to preserve selected AudioCraft model/snapshot value.');
  assert.strictEqual(audioCalls[0].request.audiocraftTemperature, 0.85, 'Expected continuation to pass AudioCraft temperature.');
  assert.strictEqual(audioCalls[0].request.audiocraftTopK, 120, 'Expected continuation to pass AudioCraft top_k.');
  assert.strictEqual(audioCalls[0].request.audiocraftTopP, 0.2, 'Expected continuation to pass AudioCraft top_p.');
  assert.strictEqual(audioCalls[0].request.audiocraftCfgCoef, 2.5, 'Expected continuation to pass AudioCraft CFG coefficient.');
  assert.strictEqual(audioCalls[0].request.audiocraftTwoStepCfg, true, 'Expected continuation to pass AudioCraft two-step CFG.');

  const result = completedRun.terminalResults[0];
  assert.strictEqual(result.audioGeneration.mode, 'continuation', 'Expected terminal metadata to expose continuation mode.');
  assert.strictEqual(result.audioGeneration.operationSubtype, 'continuation', 'Expected terminal metadata to expose continuation subtype.');
  assert.strictEqual(result.audioGeneration.appendSource, false, 'Expected terminal metadata to preserve continuation-only appendSource false.');
  assert.strictEqual(result.audioGeneration.continuationSeedSeconds, 10, 'Expected terminal metadata to preserve continuation seed seconds.');
  assert.strictEqual(result.audioGeneration.finalOutputDurationSeconds, 12, 'Expected terminal metadata to keep continuation-only final duration equal to generated duration.');
  assert.strictEqual(result.audioGeneration.generatedDurationSeconds, 12, 'Expected terminal metadata to preserve generated continuation duration.');
  assert.strictEqual(result.audioGeneration.repeatCount, 1, 'Expected terminal metadata to preserve continuation repeat count.');
  assert.strictEqual(result.audioGeneration.requestedGeneratedDurationSeconds, 12, 'Expected terminal metadata to preserve requested generated duration.');
  assert.strictEqual(result.audioGeneration.continuationRepeats.length, 1, 'Expected terminal metadata to preserve per-repeat continuation details.');
  assert.strictEqual(result.audioGeneration.advancedSettings.topK, 120, 'Expected terminal metadata to preserve AudioCraft advanced settings.');
  assert.strictEqual(result.audioGeneration.sourceAudio.fileName, path.basename(sourceAudioPath), 'Expected terminal metadata to preserve source audio reference.');
  assert.strictEqual(result.audioGeneration.lineage.sourceFileName, path.basename(sourceAudioPath), 'Expected terminal metadata to preserve source lineage.');

  const sidecarPath = result.supportingPaths.find((entry) => entry.endsWith('.audio.json'));
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.audioGeneration.mode, 'continuation', 'Expected saved sidecar to preserve continuation mode.');
  assert.strictEqual(sidecar.audioGeneration.appendSource, false, 'Expected saved sidecar to preserve continuation-only appendSource false.');
  assert.strictEqual(sidecar.audioGeneration.continuationSeedSeconds, 10, 'Expected saved sidecar to preserve continuation seed seconds.');
  assert.strictEqual(sidecar.audioGeneration.finalOutputDurationSeconds, 12, 'Expected saved sidecar to keep continuation-only final duration equal to generated duration.');
  assert.strictEqual(sidecar.audioGeneration.generatedDurationSeconds, 12, 'Expected saved sidecar to preserve generated continuation duration.');
  assert.strictEqual(sidecar.audioGeneration.repeatCount, 1, 'Expected saved sidecar to preserve continuation repeat count.');
  assert.strictEqual(sidecar.audioGeneration.requestedGeneratedDurationSeconds, 12, 'Expected saved sidecar to preserve requested generated duration.');
  assert.strictEqual(sidecar.audioGeneration.continuationRepeats.length, 1, 'Expected saved sidecar to preserve per-repeat continuation details.');
  assert.strictEqual(sidecar.audioGeneration.advancedSettings.cfgCoef, 2.5, 'Expected saved sidecar to preserve CFG coefficient.');
  assert.strictEqual(sidecar.audioGeneration.sourceAudio.fileName, path.basename(sourceAudioPath), 'Expected saved sidecar to preserve source audio reference.');
  assert.strictEqual(sidecar.audioGeneration.lineage.sourceFilePath, sourceAudioPath, 'Expected saved sidecar to preserve source lineage path.');

  const repeatRun = await runPipelineToCompletion(service, createAudiocraftContinuationPipeline(sourceAudioPath, { config: { continuationRepeatCount: 3 } }));
  assert.strictEqual(repeatRun.status, 'completed', 'Expected repeated continuation-only pipeline to complete successfully.');
  assert.strictEqual(audioCalls.length, 2, 'Expected repeated continuation to call the local audio adapter once for the model step.');
  assert.strictEqual(audioCalls[1].request.continuationRepeatCount, 3, 'Expected repeat count greater than one to pass to the local audio adapter.');
  const repeatResult = repeatRun.terminalResults[0];
  assert.strictEqual(repeatResult.audioGeneration.repeatCount, 3, 'Expected repeated continuation terminal metadata to preserve repeat count.');
  assert.strictEqual(repeatResult.audioGeneration.generatedDurationSeconds, 36, 'Expected continuation-only repeat duration to equal generated duration times repeat count.');
  assert.strictEqual(repeatResult.audioGeneration.finalOutputDurationSeconds, 36, 'Expected continuation-only repeated final duration to exclude the source audio.');
  assert.strictEqual(repeatResult.audioGeneration.continuationRepeats.length, 3, 'Expected repeated continuation metadata to include each repeat.');
}

async function verifyAudiocraftAppendSourceContinuationPipelineRun(tempRoot, sourceAudioPath) {
  const toolEntries = [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })];
  const audioCalls = [];
  const sourceDurationSeconds = 1;
  const service = createPipelineExecutionService(tempRoot, toolEntries, {
    generateAudioFixture: async ({ artifactService, request, tool }) => {
      audioCalls.push({ request, tool });
      const repeatCount = Math.max(1, Number(request.continuationRepeatCount || 1) || 1);
      const generatedDurationSeconds = request.durationSeconds * repeatCount;
      const finalDurationSeconds = sourceDurationSeconds + generatedDurationSeconds;
      const outputPath = path.join(request.runDirectories.artifactsDir, 'audiocraft-append-continuation-result.wav');
      await fsp.writeFile(outputPath, createWaveBuffer({ channelCount: 2, durationSeconds: finalDurationSeconds, frequency: 510, sampleRate: 32000 }));
      const artifact = await artifactService.buildFileArtifact(outputPath, {
        audioGeneration: {
          advancedSettings: {
            cfgCoef: request.audiocraftCfgCoef,
            temperature: request.audiocraftTemperature,
            topK: request.audiocraftTopK,
            topP: request.audiocraftTopP,
            twoStepCfg: request.audiocraftTwoStepCfg,
          },
          appendSource: true,
          backend: 'audiocraft',
          backendLabel: 'AudioCraft',
          continuationRepeatCount: repeatCount,
          continuationRepeats: Array.from({ length: repeatCount }, (_entry, index) => ({
            repeatIndex: index + 1,
            seedStartSeconds: Math.max(0, sourceDurationSeconds + (index * request.durationSeconds) - request.continuationSeedSeconds),
            seedEndSeconds: sourceDurationSeconds + (index * request.durationSeconds),
            seedSeconds: request.continuationSeedSeconds,
            generatedSegmentDurationSeconds: request.durationSeconds,
            cumulativeDurationAfterRepeatSeconds: sourceDurationSeconds + ((index + 1) * request.durationSeconds),
          })),
          continuationSeedSeconds: request.continuationSeedSeconds,
          durationSeconds: finalDurationSeconds,
          finalOutputDurationSeconds: finalDurationSeconds,
          generatedDurationSeconds,
          lineage: {
            sourceFileName: request.sourceAudioArtifact?.fileName || '',
            sourceFilePath: request.sourceAudioPath,
            sourceKind: request.sourceAudioArtifact?.kind || '',
          },
          mode: request.audioMode,
          model: request.model,
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
          operationSubtype: request.audioMode,
          prompt: request.prompt,
          repeatCount,
          requestedGeneratedDurationSeconds: generatedDurationSeconds,
          sourceAudio: request.sourceAudioArtifact ? {
            displayName: request.sourceAudioArtifact.displayName,
            fileName: request.sourceAudioArtifact.fileName,
            filePath: request.sourceAudioArtifact.filePath,
            fileUrl: request.sourceAudioArtifact.fileUrl,
            formatLabel: request.sourceAudioArtifact.formatLabel,
            kind: request.sourceAudioArtifact.kind,
            mimeType: request.sourceAudioArtifact.mimeType,
            sizeBytes: request.sourceAudioArtifact.sizeBytes,
            summary: request.sourceAudioArtifact.summary,
          } : null,
          sourceAudioPath: request.sourceAudioPath,
          sourceDurationSeconds,
          toolId: tool.id,
          toolLabel: tool.name,
        },
        displayName: request.displayName || request.nodeLabel || 'Appended Continuation Audio',
        kind: pipelineSchema.PORT_KIND_AUDIO,
        role: 'generated',
      });
      return {
        destinationPath: artifact.filePath,
        message: tool.name + ' generated and appended a continuation locally.',
        outputs: { audio: artifact },
        preview: artifactService.summarizeArtifact(artifact),
      };
    },
  });

  const completedRun = await runPipelineToCompletion(service, createAudiocraftContinuationPipeline(sourceAudioPath, { config: { appendSource: true } }));
  assert.strictEqual(completedRun.status, 'completed', 'Expected the Audiocraft append-source continuation pipeline to complete successfully.');
  assert.strictEqual(audioCalls.length, 1, 'Expected the local audio adapter to run exactly once for append-source continuation.');
  assert.strictEqual(audioCalls[0].request.appendSource, true, 'Expected append-source continuation to pass appendSource true.');
  assert.strictEqual(audioCalls[0].request.durationSeconds, 12, 'Expected append-source continuation to keep generated duration separate from final duration.');

  const result = completedRun.terminalResults[0];
  assert.strictEqual(result.audioGeneration.mode, 'continuation', 'Expected append-source terminal metadata to expose continuation mode.');
  assert.strictEqual(result.audioGeneration.appendSource, true, 'Expected terminal metadata to preserve appendSource true.');
  assert.strictEqual(result.audioGeneration.sourceDurationSeconds, sourceDurationSeconds, 'Expected terminal metadata to preserve source duration.');
  assert.strictEqual(result.audioGeneration.generatedDurationSeconds, 12, 'Expected terminal metadata to preserve generated continuation duration.');
  assert.strictEqual(result.audioGeneration.repeatCount, 1, 'Expected terminal metadata to preserve append-source repeat count.');
  assert.strictEqual(result.audioGeneration.finalOutputDurationSeconds, 13, 'Expected terminal metadata to preserve final appended output duration.');
  assert.strictEqual(result.audioGeneration.durationSeconds, 13, 'Expected terminal metadata durationSeconds to describe final appended output duration.');

  const sidecarPath = result.supportingPaths.find((entry) => entry.endsWith('.audio.json'));
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.audioGeneration.appendSource, true, 'Expected saved append-source sidecar to preserve appendSource true.');
  assert.strictEqual(sidecar.audioGeneration.sourceDurationSeconds, sourceDurationSeconds, 'Expected saved append-source sidecar to preserve source duration.');
  assert.strictEqual(sidecar.audioGeneration.generatedDurationSeconds, 12, 'Expected saved append-source sidecar to preserve generated duration.');
  assert.strictEqual(sidecar.audioGeneration.repeatCount, 1, 'Expected saved append-source sidecar to preserve repeat count.');
  assert.strictEqual(sidecar.audioGeneration.finalOutputDurationSeconds, 13, 'Expected saved append-source sidecar to preserve final output duration.');
  assert.strictEqual(sidecar.audio.durationSeconds, 13, 'Expected saved append-source audio metadata to reflect the stitched WAV duration.');

  const repeatRun = await runPipelineToCompletion(service, createAudiocraftContinuationPipeline(sourceAudioPath, { config: { appendSource: true, continuationRepeatCount: 3 } }));
  assert.strictEqual(repeatRun.status, 'completed', 'Expected repeated append-source continuation pipeline to complete successfully.');
  assert.strictEqual(audioCalls[1].request.continuationRepeatCount, 3, 'Expected append-source repeat count greater than one to pass to the local audio adapter.');
  const repeatResult = repeatRun.terminalResults[0];
  assert.strictEqual(repeatResult.audioGeneration.repeatCount, 3, 'Expected repeated append-source terminal metadata to preserve repeat count.');
  assert.strictEqual(repeatResult.audioGeneration.generatedDurationSeconds, 36, 'Expected append-source generated duration to equal duration times repeat count.');
  assert.strictEqual(repeatResult.audioGeneration.finalOutputDurationSeconds, 37, 'Expected append-source final duration to equal source plus all generated repeats.');
  assert.strictEqual(repeatResult.audioGeneration.continuationRepeats.length, 3, 'Expected append-source repeat metadata to include each repeat.');
}

async function verifyAudiocraftMissingContinuationSourceFails(tempRoot) {
  const missingPath = path.join(tempRoot, 'missing-source.wav');
  const toolEntries = [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped' })];
  const service = createPipelineExecutionService(tempRoot, toolEntries, {
    generateAudioFixture: async () => {
      throw new Error('Continuation should fail before calling the local audio adapter when the source file is missing.');
    },
  });
  const completedRun = await runPipelineToCompletion(service, createAudiocraftContinuationPipeline(missingPath));
  assert.strictEqual(completedRun.status, 'failed', 'Expected missing continuation source audio to fail the pipeline.');
  assert(completedRun.message.includes('could not be found') || completedRun.message.includes('source audio'), 'Expected missing continuation source failure to be plain English.');
}

async function verifyRvcPipelineRun(tempRoot, sourceAudioPath) {
  const voiceModel = createRvcModel({ path: path.join(tempRoot, 'weights', 'voices', 'test-voice.pth') });
  const toolEntries = [createRvcTool({ appDir: tempRoot, installDir: tempRoot, status: 'stopped', downloadedModels: [voiceModel] })];
  const audioCalls = [];
  const service = createPipelineExecutionService(tempRoot, toolEntries, {
    generateAudioFixture: async ({ artifactService, request, tool }) => {
      audioCalls.push({ request, tool });
      const outputPath = path.join(request.runDirectories.artifactsDir, 'rvc-voice-conversion-result.wav');
      await fsp.mkdir(path.dirname(voiceModel.path), { recursive: true });
      await fsp.writeFile(outputPath, createWaveBuffer({ channelCount: 1, durationSeconds: 3, frequency: 280, sampleRate: 40000 }));
      const artifact = await artifactService.buildFileArtifact(outputPath, {
        audioTransformation: {
          backend: 'rvc',
          backendLabel: 'RVC',
          durationSeconds: 3,
          instruction: request.instruction,
          model: request.voiceModel?.relativePath || request.model,
          operationId: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM,
          operationSubtype: 'voice-conversion',
          sourceAudio: request.sourceAudioArtifact ? {
            displayName: request.sourceAudioArtifact.displayName,
            fileName: request.sourceAudioArtifact.fileName,
            filePath: request.sourceAudioArtifact.filePath,
            fileUrl: request.sourceAudioArtifact.fileUrl,
            formatLabel: request.sourceAudioArtifact.formatLabel,
            kind: request.sourceAudioArtifact.kind,
            mimeType: request.sourceAudioArtifact.mimeType,
            sizeBytes: request.sourceAudioArtifact.sizeBytes,
            summary: request.sourceAudioArtifact.summary,
          } : null,
          targetVoice: 'test-voice',
          toolId: tool.id,
          toolLabel: tool.name,
          transformationType: 'voice-conversion',
        },
        displayName: request.displayName || request.nodeLabel || 'Transformed Audio',
        kind: pipelineSchema.PORT_KIND_AUDIO,
        role: 'transformed',
      });
      return {
        destinationPath: artifact.filePath,
        message: tool.name + ' transformed audio locally.',
        outputs: { audio: artifact },
        preview: artifactService.summarizeArtifact(artifact),
      };
    },
  });

  const completedRun = await runPipelineToCompletion(service, createRvcVoiceConversionPipeline(sourceAudioPath));
  assert.strictEqual(completedRun.status, 'completed', 'Expected the RVC voice conversion pipeline to complete successfully.');
  assert.strictEqual(audioCalls.length, 1, 'Expected the local audio adapter to run exactly once for the RVC pipeline.');
  assert.strictEqual(audioCalls[0].request.sourceAudioPath, sourceAudioPath, 'Expected the RVC run to retain the upstream audio file path.');
  assert.strictEqual(audioCalls[0].request.model, 'voices/test-voice.pth', 'Expected the RVC run to retain the selected voice model id.');
  assert.strictEqual(audioCalls[0].request.voiceModel.relativePath, 'voices/test-voice.pth', 'Expected the RVC run to pass the resolved voice model metadata to the adapter.');

  const result = completedRun.terminalResults[0];
  assert.strictEqual(result.kind, 'audio', 'Expected the RVC pipeline to end with an audio artifact.');
  assert.strictEqual(result.artifact.previewKind, 'audio', 'Expected the transformed audio artifact to stay on the audio preview path.');
  assert.strictEqual(result.audioTransformation.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM, 'Expected the terminal result to expose the audio transform operation id.');
  assert.strictEqual(result.audioTransformation.operationSubtype, 'voice-conversion', 'Expected the terminal result to expose the audio transform subtype.');
  assert.strictEqual(result.audioTransformation.transformationType, 'voice-conversion', 'Expected the terminal result to expose the voice conversion transform type.');
  assert.strictEqual(result.audioTransformation.targetVoice, 'test-voice', 'Expected the terminal result to preserve the target voice label.');
  assert.strictEqual(result.audioTransformation.sourceAudio.fileName, path.basename(sourceAudioPath), 'Expected the terminal result to preserve the source audio lineage.');
  assert(result.supportingPaths.some((entry) => entry.endsWith('.audio.json')), 'Expected transformed audio outputs to save an audio metadata sidecar.');

  const sidecarPath = result.supportingPaths.find((entry) => entry.endsWith('.audio.json'));
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.audioTransformation.model, 'voices/test-voice.pth', 'Expected the saved transformed audio sidecar to preserve the selected voice model.');
  assert.strictEqual(sidecar.audioTransformation.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM, 'Expected the saved transformed audio sidecar to preserve the transform operation id.');
  assert.strictEqual(sidecar.audioTransformation.operationSubtype, 'voice-conversion', 'Expected the saved transformed audio sidecar to preserve the transform subtype.');
  assert.strictEqual(sidecar.audioTransformation.sourceAudio.fileName, path.basename(sourceAudioPath), 'Expected the saved transformed audio sidecar to preserve the source audio lineage.');
}

function verifyCloudAudioReadinessStates() {
  const missingProviderAnalysis = pipelineSchema.analyzePipeline(createCloudAudioPipeline('Say hello from Local AI Hub.'), { providers: [] });
  assert.strictEqual(missingProviderAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'error', 'Expected cloud audio readiness to fail when the provider is missing.');
  assert(missingProviderAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('Choose a connected cloud provider'), 'Expected missing provider readiness to explain that a provider must be selected.');

  const unvalidatedProviderAnalysis = pipelineSchema.analyzePipeline(createCloudAudioPipeline('Say hello from Local AI Hub.'), {
    providers: [createGoogleProvider({ lastTestSucceeded: undefined, lastTestedAt: '' })],
  });
  assert.strictEqual(unvalidatedProviderAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'warn', 'Expected saved-but-unvalidated provider readiness to warn.');
  assert(unvalidatedProviderAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('has not been validated on this PC yet'), 'Expected saved-but-unvalidated provider readiness to explain the validation gap.');

  const failedProviderAnalysis = pipelineSchema.analyzePipeline(createCloudAudioPipeline('Say hello from Local AI Hub.'), {
    providers: [createGoogleProvider({ lastTestSucceeded: false, lastTestedAt: new Date('2026-03-18T12:00:00.000Z').toISOString() })],
  });
  assert.strictEqual(failedProviderAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'warn', 'Expected failed provider validation to warn.');
  assert(failedProviderAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('last connection check failed'), 'Expected failed provider validation to explain the last failed check.');

  const recoveredProviderAnalysis = pipelineSchema.analyzePipeline(createCloudAudioPipeline('Say hello from Local AI Hub.'), {
    providers: [createGoogleProvider({
      lastSuccessfulOperation: pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
      lastSuccessfulUseAt: new Date('2026-03-18T12:05:00.000Z').toISOString(),
      lastTestSucceeded: false,
      lastTestedAt: new Date('2026-03-18T12:00:00.000Z').toISOString(),
    })],
  });
  assert.strictEqual(recoveredProviderAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'info', 'Expected a newer live provider success to clear the stale failed-check warning.');
  assert(recoveredProviderAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('completed a real provider request'), 'Expected recovered provider readiness to explain that a newer live success is now the source of truth.');

  const unsupportedModelAnalysis = pipelineSchema.analyzePipeline(createCloudAudioPipeline('Say hello from Local AI Hub.', { model: 'models/gemini-2.5-flash' }), {
    providers: [createGoogleProvider()],
  });
  assert.strictEqual(unsupportedModelAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'error', 'Expected unsupported cloud audio model selection to fail.');
  assert(unsupportedModelAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('gemini-2.5-flash-preview-tts'), 'Expected unsupported cloud audio model readiness to suggest a Gemini TTS model.');

  const openAiUnsupportedAnalysis = pipelineSchema.analyzePipeline(createCloudAudioPipeline('Say hello from Local AI Hub.', { model: 'gpt-4o', providerId: 'openai' }), {
    providers: [createOpenAiProvider()],
  });
  assert.strictEqual(openAiUnsupportedAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'error', 'Expected unsupported OpenAI speech model selection to fail.');
  assert(openAiUnsupportedAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('gpt-4o-mini-tts'), 'Expected unsupported OpenAI speech readiness to suggest a compatible OpenAI TTS model.');

  const xaiReadyAnalysis = pipelineSchema.analyzePipeline(createCloudAudioPipeline('Say hello from Local AI Hub.', { model: '', providerId: 'xai', audioVoice: 'eve' }), {
    providers: [createXaiProvider()],
  });
  assert.strictEqual(xaiReadyAnalysis.nodeSummaries['audio-generate'].readiness.tone, 'info', 'Expected xAI cloud speech readiness to stay positive without an explicit model.');
  assert(xaiReadyAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('saved audio artifact'), 'Expected xAI cloud speech readiness to keep the shared saved-audio artifact message.');

  const readyAnalysis = pipelineSchema.analyzePipeline(createCloudAudioPipeline('Say hello from Local AI Hub.'), {
    providers: [createGoogleProvider()],
  });
  const readySummary = readyAnalysis.nodeSummaries['audio-generate'];
  assert.strictEqual(readySummary.readiness.tone, 'info', 'Expected validated cloud audio readiness to be positive.');
  assert(readySummary.readiness.message.includes('saved audio artifact'), 'Expected validated cloud audio readiness to describe the saved audio artifact path.');
  assert.strictEqual(readySummary.capabilitySummary.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'Expected the cloud model step to resolve to audio generation.');
  assert(readySummary.capabilitySummary.inputKinds.includes('text'), 'Expected the cloud audio capability summary to accept text input.');
  assert(readySummary.capabilitySummary.outputKinds.includes('audio'), 'Expected the cloud audio capability summary to produce audio output.');
}

async function verifyAudiocraftPipelineEnvironmentContract(tempRoot) {
  const manifestPath = path.resolve(__dirname, '..', 'electron', 'config', 'tools-manifest.json');
  const manifestTools = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const audiocraftManifest = manifestTools.find((tool) => tool.id === 'audiocraft-webui');
  assert(audiocraftManifest, 'AudioCraft WebUI should remain present in the tool manifest.');
  const pipInstalls = audiocraftManifest.installInstructions?.pipInstalls || [];
  assert(pipInstalls.some((entry) => entry.kind === 'requirements' && entry.value === 'requirements.txt'), 'AudioCraft install/repair should install the upstream requirements file.');
  assert(pipInstalls.some((entry) => entry.kind === 'path' && entry.value === '.' && (entry.pipArgs || []).includes('--no-deps')), 'AudioCraft install/repair should install the local audiocraft package into the managed venv for pipeline imports.');

  const installerPath = path.resolve(__dirname, '..', 'electron', 'services', 'installerService.js');
  const installerSource = await fsp.readFile(installerPath, 'utf8');
  assert(installerSource.includes('verifyAudiocraftManagedPipelineReadiness'), 'AudioCraft install/repair finalization should verify pipeline imports before registering the tool as usable.');
  assert(installerSource.includes('buildAudiocraftPipelineInstallFailureMessage'), 'AudioCraft install/repair should report pipeline package failures with a Repair-oriented message.');
  assert(installerSource.includes('["numpy", "numpy"]'), 'AudioCraft install/repair should verify NumPy because Local AI Hub uses it for pipeline WAV export fallback.');

  const helperPath = path.resolve(__dirname, '..', 'electron', 'helpers', 'run_audiocraft_pipeline_task.py');
  const helperSource = await fsp.readFile(helperPath, 'utf8');
  assert(helperSource.includes("load_module('torchaudio'"), 'AudioCraft helper should verify torchaudio before pipeline generation.');
  assert(helperSource.includes("load_module('audiocraft.models'"), 'AudioCraft helper should verify AudioCraft model loaders before pipeline generation.');
  assert(helperSource.includes('format_missing_pipeline_packages'), 'AudioCraft helper should report missing pipeline package names without a raw stack trace.');
  assert(helperSource.includes('validate_requested_model_path'), 'AudioCraft helper should validate selected local snapshot paths before handing them to Hugging Face loaders.');
  assert(helperSource.includes('summarize_runtime_exception'), 'AudioCraft helper should report the actual runtime exception instead of a generic warning-shaped failure.');
  assert(helperSource.includes('write_pcm16_wav'), 'AudioCraft helper should save generated pipeline audio through Local AI Hub\'s PCM WAV fallback.');
  assert(helperSource.includes('load_audio_for_chroma'), 'AudioCraft helper should avoid TorchCodec-only loading for local WAV audio guidance when possible.');
  assert(helperSource.includes('generate_continuation'), 'AudioCraft helper should use the real AudioCraft continuation API for continuation mode.');
  assert(helperSource.includes('trim_end_seed'), 'AudioCraft helper should trim the end of the source clip for continuation seeding.');
  assert(helperSource.includes('normalize_source_for_append'), 'AudioCraft helper should normalize the source audio before append-source concatenation.');
  assert(helperSource.includes('torch.cat([source_for_append, waveform]'), 'AudioCraft helper should append full source audio to the stripped continuation without duplicating the seed segment.');
  assert(helperSource.includes('generationSettings'), 'AudioCraft helper should accept stable AudioCraft advanced generation settings.');
  assert(!/audio_write\s*\(/.test(helperSource), 'AudioCraft pipeline export should not depend on audiocraft.data.audio.audio_write because recent Torchaudio requires TorchCodec there.');

  const readinessService = loadModuleWithStubs('electron/services/localAudioService.js', {
    '/electron/services/localAudioService.js': {
      './commandService': {
        runCommand: async () => ({
          code: 3,
          stderr: '',
          stdout: '{"ready":false,"missing":["audiocraft","torchaudio"],"failures":[]}\n',
        }),
      },
      './logService': {
        createLogger: () => ({ info: async () => {}, warn: async () => {} }),
      },
      './pipelineArtifactService': {
        buildFileArtifact: async () => { throw new Error('Not used in AudioCraft readiness verification.'); },
        summarizeArtifact: () => ({}),
      },
      './processService': {
        buildLaunchRuntimeEnv: async () => ({ PYTHONUTF8: '1' }),
        summarizeLaunchRuntimeEnv: () => ({ pythonUtf8: true }),
      },
    },
  });
  const readiness = await readinessService.checkAudiocraftPipelineReadiness(createAudiocraftTool({
    appDir: tempRoot,
    installDir: tempRoot,
    launchProfile: { kind: 'python-script', pythonPath: 'python' },
    pythonBootstrapPath: 'python',
  }));
  assert.strictEqual(readiness.ready, false, 'AudioCraft readiness should fail when pipeline imports are missing.');
  assert.strictEqual(readiness.reason, 'missing-packages', 'AudioCraft readiness should distinguish missing pipeline packages.');
  assert(readiness.message.includes('audiocraft') && readiness.message.includes('torchaudio'), 'AudioCraft missing-package readiness should name the missing imports.');
  assert(readiness.message.includes('Run Repair'), 'AudioCraft missing-package readiness should guide users to Repair.');

  assert(readinessService._test.AUDIOCRAFT_PIPELINE_IMPORT_CHECKS.some((entry) => entry.moduleName === 'numpy'), 'AudioCraft runtime readiness should verify NumPy for the WAV export fallback.');
  const missingMessage = readinessService._test.buildAudiocraftMissingPipelinePackagesMessage(['audiocraft', 'torchaudio', 'audiocraft']);
  assert(missingMessage.includes('audiocraft') && missingMessage.includes('torchaudio'), 'AudioCraft missing package helper should keep package names in the user message.');
  const parsedProbe = readinessService._test.parseProbeJson('noise\n{"ready":false,"missing":["audiocraft"],"failures":[]}\n');
  assert.deepStrictEqual(parsedProbe.missing, ['audiocraft'], 'AudioCraft readiness should parse the final JSON line from the import probe.');

  const warningOnlyFailure = readinessService._test.resolveCommandFailureMessage({
    code: 1,
    stderr: 'WARNING[XFORMERS]: xFormers can\'t load C++/CUDA extensions.\nSet XFORMERS_MORE_DETAILS=1 for more details\n',
    stdout: '{"message":"The selected AudioCraft snapshot folder could not be found anymore."}\n',
  }, 'AudioCraft could not finish the local audio request.');
  assert.strictEqual(warningOnlyFailure, 'The selected AudioCraft snapshot folder could not be found anymore.', 'AudioCraft helper failures should prefer structured helper errors over warning-only stderr.');
}

async function verifyCloudAudioPipelineRun(tempRoot) {
  const cases = [
    { provider: createGoogleProvider(), providerId: 'google', model: 'models/gemini-2.5-flash-preview-tts', voice: 'Kore' },
    { provider: createOpenAiProvider(), providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' },
    { provider: createXaiProvider(), providerId: 'xai', model: '', voice: 'eve' },
  ];

  for (const testCase of cases) {
    const providerCalls = [];
    const service = createPipelineExecutionService(tempRoot, [], {
      providerEntries: [testCase.provider],
      runProviderOperationFixture: async (providerId, payload = {}) => {
        providerCalls.push({ providerId, payload });
        return {
          createdAt: new Date('2026-03-18T12:00:00.000Z').toISOString(),
          model: payload.model,
          audios: [
            {
              buffer: createWaveBuffer({ durationSeconds: 2, sampleRate: 24000, frequency: 260 }),
              extension: '.wav',
              mimeType: 'audio/wav',
              sampleRate: 24000,
              channelCount: 1,
              bitDepth: 16,
              voice: payload.voice || testCase.voice,
            },
          ],
        };
      },
    });

    const completedRun = await runPipelineToCompletion(service, createCloudAudioPipeline('Say hello from Local AI Hub.', { providerId: testCase.providerId, model: testCase.model, audioVoice: testCase.voice }));
    assert.strictEqual(completedRun.status, 'completed', 'Expected the cloud audio pipeline to complete successfully for ' + testCase.provider.name + '.');
    assert.strictEqual(providerCalls.length, 1, 'Expected the provider-backed audio operation to run exactly once for ' + testCase.provider.name + '.');
    assert.strictEqual(providerCalls[0].providerId, testCase.providerId, 'Expected the cloud audio pipeline to target ' + testCase.provider.name + '.');
    assert.strictEqual(providerCalls[0].payload.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'Expected the provider operation to stay on the audio generation boundary.');
    assert(providerCalls[0].payload.prompt.includes('Speak this text exactly:'), 'Expected the outgoing cloud audio prompt to preserve the shared speech wrapper.');
    assert(providerCalls[0].payload.prompt.includes('Say hello from Local AI Hub.'), 'Expected the outgoing cloud audio prompt to include the connected text.');
    assert.strictEqual(providerCalls[0].payload.spokenText, 'Say hello from Local AI Hub.', 'Expected the shared cloud audio request to preserve the exact spoken text for ' + testCase.provider.name + '.');
    assert.strictEqual(providerCalls[0].payload.instruction, 'Speak in a calm, friendly tone.', 'Expected the shared cloud audio request to keep delivery guidance separate for ' + testCase.provider.name + '.');
    assert.strictEqual(providerCalls[0].payload.voice, testCase.voice, 'Expected the outgoing cloud audio request to preserve the selected voice for ' + testCase.provider.name + '.');

    const result = completedRun.terminalResults[0];
    assert.strictEqual(result.kind, 'audio', 'Expected the cloud audio pipeline to end with an audio artifact for ' + testCase.provider.name + '.');
    assert.strictEqual(result.artifact.previewKind, 'audio', 'Expected the cloud audio artifact to stay on the audio preview path for ' + testCase.provider.name + '.');
    assert.strictEqual(result.audioGeneration.mode, 'speech', 'Expected the cloud audio terminal result to expose speech generation mode for ' + testCase.provider.name + '.');
    assert.strictEqual(result.audioGeneration.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'Expected the cloud audio terminal result to expose audio generation operation id for ' + testCase.provider.name + '.');
    assert.strictEqual(result.audioGeneration.operationSubtype, 'speech', 'Expected the cloud audio terminal result to expose speech as the audio generation subtype for ' + testCase.provider.name + '.');
    assert.strictEqual(result.audioGeneration.backend, testCase.providerId, 'Expected the cloud audio terminal result to expose the provider id for ' + testCase.provider.name + '.');
    assert.strictEqual(result.audioGeneration.backendLabel, testCase.provider.name, 'Expected the cloud audio terminal result to expose the provider label for ' + testCase.provider.name + '.');
    assert.strictEqual(result.audioGeneration.voice, testCase.voice, 'Expected the cloud audio terminal result to preserve the selected voice for ' + testCase.provider.name + '.');
    assert.strictEqual(result.audio.sampleRate, 24000, 'Expected the cloud audio artifact to retain the sample rate metadata for ' + testCase.provider.name + '.');
    assert(result.supportingPaths.some((entry) => entry.endsWith('.audio.json')), 'Expected cloud audio outputs to save an audio metadata sidecar for ' + testCase.provider.name + '.');

    const sidecarPath = result.supportingPaths.find((entry) => entry.endsWith('.audio.json'));
    assert(fs.existsSync(sidecarPath), 'Expected the cloud audio sidecar to exist on disk for ' + testCase.provider.name + '.');
    const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
    assert.strictEqual(sidecar.audioGeneration.mode, 'speech', 'Expected the saved cloud audio sidecar to preserve speech mode for ' + testCase.provider.name + '.');
    assert.strictEqual(sidecar.audioGeneration.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'Expected the saved cloud audio sidecar to preserve the operation id for ' + testCase.provider.name + '.');
    assert.strictEqual(sidecar.audioGeneration.operationSubtype, 'speech', 'Expected the saved cloud audio sidecar to preserve the operation subtype for ' + testCase.provider.name + '.');
    assert.strictEqual(sidecar.audioGeneration.backendLabel, testCase.provider.name, 'Expected the saved cloud audio sidecar to preserve the provider label for ' + testCase.provider.name + '.');
    assert.strictEqual(sidecar.audioGeneration.voice, testCase.voice, 'Expected the saved cloud audio sidecar to preserve the voice for ' + testCase.provider.name + '.');
  }
}

function verifyAudiocraftContinuationHelperSource() {
  const helperSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'helpers', 'run_audiocraft_pipeline_task.py'), 'utf8');
  assert(helperSource.includes('MAX_CONTINUATION_REPEAT_COUNT = 10'), 'AudioCraft helper should bound continuation repeat count.');
  assert(helperSource.includes('parse_continuation_repeat_count'), 'AudioCraft helper should validate continuation repeat count.');
  assert(helperSource.includes('for repeat_index in range(1, continuation_repeat_count + 1):'), 'AudioCraft helper should loop over continuation repeats.');
  assert(helperSource.includes('trim_end_seed(current_audio, current_sample_rate, continuation_seed_seconds)'), 'AudioCraft helper should seed each repeat from the current cumulative audio.');
  assert(helperSource.includes('continuation_segment = generated_waveform[..., prompt_frames:].contiguous()'), 'AudioCraft helper should strip the seed prompt from every repeat.');
  assert(helperSource.includes('current_audio = torch.cat([current_audio_for_repeat, continuation_segment], dim=-1).contiguous()'), 'AudioCraft helper should append each stripped segment before the next seed is selected.');
  assert(helperSource.includes("'continuationRepeats': continuation_repeat_details"), 'AudioCraft helper should return per-repeat metadata.');
  assert(helperSource.includes("'requestedGeneratedDurationSeconds': round(float(requested_generated_duration_seconds), 2)"), 'AudioCraft helper should return total requested generated duration.');
}

async function main() {
  const tempRoot = path.resolve(__dirname, '..', 'temp', 'audio-pipeline-verification');
  await fsp.rm(tempRoot, { force: true, recursive: true });
  await fsp.mkdir(tempRoot, { recursive: true });

  const audioPath = path.join(tempRoot, 'sample.wav');
  await fsp.writeFile(audioPath, createWaveBuffer());

  verifyWhisperReadinessStates(audioPath);
  verifyAudiocraftReadinessStates(tempRoot, audioPath);
  verifyAudiocraftContinuationHelperSource();
  await verifyAudiocraftPipelineEnvironmentContract(tempRoot);
  verifyRvcReadinessStates(tempRoot, audioPath);
  verifyCloudAudioReadinessStates();
  await verifyWhisperPipelineRun(tempRoot, audioPath);
  await verifyAudioOutputRun(tempRoot, audioPath);
  await verifyAudioStitchRun(tempRoot);
  await verifyAudiocraftTextPipelineRun(tempRoot);
  await verifyAudiocraftGuidedPipelineRun(tempRoot, audioPath);
  await verifyAudiocraftContinuationPipelineRun(tempRoot, audioPath);
  await verifyAudiocraftAppendSourceContinuationPipelineRun(tempRoot, audioPath);
  await verifyAudiocraftMissingContinuationSourceFails(tempRoot);
  await verifyRvcPipelineRun(tempRoot, audioPath);
  await verifyCloudAudioPipelineRun(tempRoot);

  console.log('Audio pipeline verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
