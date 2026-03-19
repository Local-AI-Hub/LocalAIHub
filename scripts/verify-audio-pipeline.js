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
        listDownloadedModels: async () => [],
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
      { id: 'whisper-step', type: 'whisperTranscribe', label: 'Audio Transcription', config: { model: 'base' } },
      { id: 'text-output', type: 'textOutput', label: 'Text Output', config: { title: 'Transcript result' } },
    ],
    edges: [
      { id: 'edge-audio', source: { nodeId: 'audio-input', portId: 'audio' }, target: { nodeId: 'whisper-step', portId: 'audio' } },
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

  const unsupportedToolAnalysis = pipelineSchema.analyzePipeline({
    ...createAudiocraftTextToAudioPipeline('Build a gentle ambient loop.'),
    nodes: createAudiocraftTextToAudioPipeline('Build a gentle ambient loop.').nodes.map((node) =>
      node.id === 'audio-generate'
        ? { ...node, config: { ...node.config, toolId: 'rvc' } }
        : node),
  }, {
    tools: [createAudiocraftTool({ appDir: tempRoot, installDir: tempRoot })],
  });
  assert(unsupportedToolAnalysis.nodeSummaries['audio-generate'].readiness.message.includes('RVC-style audio transformation is not wired into this model-step path yet'), 'Expected the RVC selection state to stay honest about the bounded audio-output scope.');

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
  assert.strictEqual(result.audioGeneration.toolId, 'audiocraft-webui', 'Expected the terminal result to expose the producing tool id.');
  assert.strictEqual(result.audio.channelCount, 2, 'Expected the generated audio metadata to preserve the stereo channel count.');
  assert(result.supportingPaths.some((entry) => entry.endsWith('.audio.json')), 'Expected generated audio outputs to save an audio metadata sidecar.');

  const sidecarPath = result.supportingPaths.find((entry) => entry.endsWith('.audio.json'));
  assert(fs.existsSync(sidecarPath), 'Expected the generated audio sidecar to exist on disk.');
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.audioGeneration.mode, 'music', 'Expected the saved audio sidecar to preserve the generation mode.');
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

async function verifyCloudAudioPipelineRun(tempRoot) {
  const providerEntries = [createGoogleProvider()];
  const providerCalls = [];
  const service = createPipelineExecutionService(tempRoot, [], {
    providerEntries,
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
            voice: payload.voice || 'Kore',
          },
        ],
      };
    },
  });

  const completedRun = await runPipelineToCompletion(service, createCloudAudioPipeline('Say hello from Local AI Hub.'));
  assert.strictEqual(completedRun.status, 'completed', 'Expected the cloud audio pipeline to complete successfully.');
  assert.strictEqual(providerCalls.length, 1, 'Expected the provider-backed audio operation to run exactly once.');
  assert.strictEqual(providerCalls[0].providerId, 'google', 'Expected the cloud audio pipeline to target Google (Gemini).');
  assert.strictEqual(providerCalls[0].payload.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'Expected the provider operation to stay on the audio generation boundary.');
  assert(providerCalls[0].payload.prompt.includes('Speak this text exactly:'), 'Expected the outgoing cloud audio prompt to preserve the shared speech wrapper.');
  assert(providerCalls[0].payload.prompt.includes('Say hello from Local AI Hub.'), 'Expected the outgoing cloud audio prompt to include the connected text.');
  assert.strictEqual(providerCalls[0].payload.voice, 'Kore', 'Expected the outgoing cloud audio request to preserve the selected voice.');

  const result = completedRun.terminalResults[0];
  assert.strictEqual(result.kind, 'audio', 'Expected the cloud audio pipeline to end with an audio artifact.');
  assert.strictEqual(result.artifact.previewKind, 'audio', 'Expected the cloud audio artifact to stay on the audio preview path.');
  assert.strictEqual(result.audioGeneration.mode, 'speech', 'Expected the cloud audio terminal result to expose speech generation mode.');
  assert.strictEqual(result.audioGeneration.backend, 'google', 'Expected the cloud audio terminal result to expose the provider id.');
  assert.strictEqual(result.audioGeneration.backendLabel, 'Google (Gemini)', 'Expected the cloud audio terminal result to expose the provider label.');
  assert.strictEqual(result.audioGeneration.voice, 'Kore', 'Expected the cloud audio terminal result to preserve the selected voice.');
  assert.strictEqual(result.audio.sampleRate, 24000, 'Expected the cloud audio artifact to retain the sample rate metadata.');
  assert(result.supportingPaths.some((entry) => entry.endsWith('.audio.json')), 'Expected cloud audio outputs to save an audio metadata sidecar.');

  const sidecarPath = result.supportingPaths.find((entry) => entry.endsWith('.audio.json'));
  assert(fs.existsSync(sidecarPath), 'Expected the cloud audio sidecar to exist on disk.');
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.audioGeneration.mode, 'speech', 'Expected the saved cloud audio sidecar to preserve speech mode.');
  assert.strictEqual(sidecar.audioGeneration.backendLabel, 'Google (Gemini)', 'Expected the saved cloud audio sidecar to preserve the provider label.');
  assert.strictEqual(sidecar.audioGeneration.voice, 'Kore', 'Expected the saved cloud audio sidecar to preserve the voice.');
}

async function main() {
  const tempRoot = path.resolve(__dirname, '..', 'temp', 'audio-pipeline-verification');
  await fsp.rm(tempRoot, { force: true, recursive: true });
  await fsp.mkdir(tempRoot, { recursive: true });

  const audioPath = path.join(tempRoot, 'sample.wav');
  await fsp.writeFile(audioPath, createWaveBuffer());

  verifyWhisperReadinessStates(audioPath);
  verifyAudiocraftReadinessStates(tempRoot, audioPath);
  verifyCloudAudioReadinessStates();
  await verifyWhisperPipelineRun(tempRoot, audioPath);
  await verifyAudioOutputRun(tempRoot, audioPath);
  await verifyAudiocraftTextPipelineRun(tempRoot);
  await verifyAudiocraftGuidedPipelineRun(tempRoot, audioPath);
  await verifyCloudAudioPipelineRun(tempRoot);

  console.log('Audio pipeline verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
