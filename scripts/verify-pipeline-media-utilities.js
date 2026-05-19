const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-pipeline-media-utilities');

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'home' || name === 'appData') return TEST_STORAGE_ROOT;
          if (name === 'exe') return process.execPath;
          return process.cwd();
        },
        isPackaged: false,
      },
      nativeImage: null,
    };
  }

  if (normalizedParent.endsWith('/electron/services/pipelineArtifactService.js') && request === './configService') {
    return {
      ensureStorage: async () => {
        fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
      },
      getAppPaths: () => ({ runtimesRoot: TEST_STORAGE_ROOT }),
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const pipelineSchema = require('../electron/shared/pipelineSchema.cjs');
const { buildFileArtifact, createArtifactCollection, createTextArtifact } = require('../electron/services/pipelineArtifactService');
const { runCommand } = require('../electron/services/commandService');
const { resolveFfmpegPath } = require('../electron/services/mediaCompositionService');
const mediaUtilityService = require('../electron/services/mediaUtilityService');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function runFfmpeg(args, label) {
  const result = await runCommand(resolveFfmpegPath(), args, { allowFailure: true });
  assert.strictEqual(Number(result.code || 0), 0, label + ' failed: ' + (result.stderr || result.stdout || 'ffmpeg returned a non-zero exit code.'));
}

async function createSyntheticAudio(outputPath, { sampleRate = 16000, channels = 1, duration = 0.35 } = {}) {
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=' + String(sampleRate) + ':duration=' + String(duration),
    '-ac', String(channels),
    '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le',
    outputPath,
  ], 'synthetic audio fixture');
}

async function createSyntheticVideo(outputPath, { audio = true, size = '96x64', rate = 2, duration = 0.6 } = {}) {
  const baseArgs = [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=' + size + ':rate=' + String(rate) + ':duration=' + String(duration),
  ];
  const audioArgs = audio
    ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=' + String(duration), '-shortest']
    : [];
  const tailArgs = audio
    ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath]
    : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath];

  const firstAttempt = await runCommand(resolveFfmpegPath(), [...baseArgs, ...audioArgs, ...tailArgs], { allowFailure: true });
  if (Number(firstAttempt.code || 0) === 0) {
    return;
  }

  const fallbackTailArgs = audio
    ? ['-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath]
    : ['-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', outputPath];
  await runFfmpeg([...baseArgs, ...audioArgs, ...fallbackTailArgs], 'synthetic ' + (audio ? 'audio/video' : 'silent video') + ' fixture');
}

function buildPipelineWithUtilityNode(utilityType, videoPath) {
  const videoInput = pipelineSchema.createNode('videoInput', {
    id: 'video-input',
    label: 'Video Input',
    config: { filePath: videoPath },
  });
  const utilityNode = pipelineSchema.createNode(utilityType, {
    id: utilityType,
    label: utilityType === 'extractVideoFrame' ? 'Extract Video Frame' : 'Extract Audio',
  });
  const outputNode = pipelineSchema.createNode(utilityType === 'extractVideoFrame' ? 'imageOutput' : 'audioOutput', {
    id: 'utility-output',
    label: 'Utility Output',
  });
  return pipelineSchema.createEmptyPipeline({
    id: 'media-utility-' + utilityType,
    name: 'Media Utility ' + utilityType,
    nodes: [videoInput, utilityNode, outputNode],
    edges: [
      pipelineSchema.createEdge(videoInput.id, 'video', utilityNode.id, 'video'),
      pipelineSchema.createEdge(utilityNode.id, utilityType === 'extractVideoFrame' ? 'image' : 'audio', outputNode.id, utilityType === 'extractVideoFrame' ? 'image' : 'audio'),
    ],
  });
}

function verifySchemaAndUiContracts() {
  const frameDefinition = pipelineSchema.getNodeTypeDefinition('extractVideoFrame');
  assert(frameDefinition, 'Extract Video Frame node should exist.');
  assert.strictEqual(frameDefinition.category, 'Deterministic Media Operations', 'Extract Video Frame should live under Deterministic Media Operations.');
  assert.strictEqual(frameDefinition.inputPorts[0].kind, pipelineSchema.PORT_KIND_VIDEO, 'Extract Video Frame should accept video input.');
  assert.strictEqual(frameDefinition.outputPorts[0].kind, pipelineSchema.PORT_KIND_IMAGE, 'Extract Video Frame should output image.');
  assert.strictEqual(frameDefinition.configDefaults.framePosition, 'first', 'Extract Video Frame should default to first-frame mode.');
  assert.strictEqual(frameDefinition.configDefaults.outputFormat, 'png', 'Extract Video Frame should default to PNG output.');

  const lastFrameNode = pipelineSchema.createNode('extractVideoFrame', { config: { framePosition: 'last' } });
  assert.strictEqual(lastFrameNode.config.framePosition, 'last', 'Extract Video Frame should support last-frame mode.');

  const audioDefinition = pipelineSchema.getNodeTypeDefinition('extractAudio');
  assert(audioDefinition, 'Extract Audio node should exist.');
  assert.strictEqual(audioDefinition.category, 'Deterministic Media Operations', 'Extract Audio should live under Deterministic Media Operations.');
  assert.strictEqual(audioDefinition.inputPorts[0].kind, pipelineSchema.PORT_KIND_VIDEO, 'Extract Audio should accept video input.');
  assert.strictEqual(audioDefinition.outputPorts[0].kind, pipelineSchema.PORT_KIND_AUDIO, 'Extract Audio should output audio.');
  assert.strictEqual(audioDefinition.configDefaults.outputFormat, 'wav', 'Extract Audio should default to WAV output.');

  const normalizeAudio = pipelineSchema.getNodeTypeDefinition('normalizeAudioCollection');
  assert(normalizeAudio, 'Normalize Audio Collection node should exist.');
  assert.strictEqual(normalizeAudio.category, 'Deterministic Media Operations', 'Normalize Audio Collection should live under Deterministic Media Operations.');
  assert.strictEqual(normalizeAudio.inputPorts[0].kind, pipelineSchema.PORT_KIND_AUDIO, 'Normalize Audio Collection should accept audio items.');
  assert.strictEqual(normalizeAudio.inputPorts[0].collectionBehavior, 'only', 'Normalize Audio Collection input should be collection:audio.');
  assert.strictEqual(normalizeAudio.outputPorts[0].kind, pipelineSchema.PORT_KIND_AUDIO, 'Normalize Audio Collection should output audio items.');
  assert.strictEqual(normalizeAudio.outputPorts[0].collectionBehavior, 'only', 'Normalize Audio Collection output should be collection:audio.');
  assert.notStrictEqual(normalizeAudio.outputPorts[0].id, 'audio', 'Normalize Audio Collection should not output a single audio artifact.');
  assert.strictEqual(normalizeAudio.outputPorts[0].label, 'Normalized', 'Normalize Audio Collection should use a short output display label.');
  assert.strictEqual(normalizeAudio.configDefaults.outputFormat, 'wav', 'Normalize Audio Collection should default to WAV.');
  assert.strictEqual(normalizeAudio.configDefaults.channels, 'stereo', 'Normalize Audio Collection should default to stereo.');

  const normalizeVideo = pipelineSchema.getNodeTypeDefinition('normalizeVideoCollection');
  assert(normalizeVideo, 'Normalize Video Collection node should exist.');
  assert.strictEqual(normalizeVideo.category, 'Deterministic Media Operations', 'Normalize Video Collection should live under Deterministic Media Operations.');
  assert.strictEqual(normalizeVideo.inputPorts[0].kind, pipelineSchema.PORT_KIND_VIDEO, 'Normalize Video Collection should accept video items.');
  assert.strictEqual(normalizeVideo.inputPorts[0].collectionBehavior, 'only', 'Normalize Video Collection input should be collection:video.');
  assert.strictEqual(normalizeVideo.outputPorts[0].kind, pipelineSchema.PORT_KIND_VIDEO, 'Normalize Video Collection should output video items.');
  assert.strictEqual(normalizeVideo.outputPorts[0].collectionBehavior, 'only', 'Normalize Video Collection output should be collection:video.');
  assert.notStrictEqual(normalizeVideo.outputPorts[0].id, 'video', 'Normalize Video Collection should not output a single video artifact.');
  assert.strictEqual(normalizeVideo.outputPorts[0].label, 'Normalized', 'Normalize Video Collection should use a short output display label.');
  assert.strictEqual(normalizeVideo.configDefaults.outputFormat, 'mp4', 'Normalize Video Collection should default to MP4.');

  const trimDefinition = pipelineSchema.getNodeTypeDefinition('trimMedia');
  assert(trimDefinition, 'Trim Media node should exist.');
  assert.strictEqual(trimDefinition.category, 'Deterministic Media Operations', 'Trim Media should live under Deterministic Media Operations.');
  assert.deepStrictEqual(trimDefinition.inputPorts[0].allowedKinds, [pipelineSchema.PORT_KIND_AUDIO, pipelineSchema.PORT_KIND_VIDEO], 'Trim Media should accept audio or video input.');
  assert.strictEqual(trimDefinition.outputPorts[0].kind, pipelineSchema.PORT_KIND_PASSTHROUGH, 'Trim Media should use passthrough typing.');
  assert.strictEqual(trimDefinition.outputPorts[0].passthroughFrom, 'media', 'Trim Media output should match the media input kind.');
  assert.strictEqual(trimDefinition.outputPorts[0].id, 'trimmed', 'Trim Media should expose a trimmed output port.');
  for (const entry of [
    { inputType: 'audioInput', inputPort: 'audio', itemKind: pipelineSchema.PORT_KIND_AUDIO },
    { inputType: 'videoInput', inputPort: 'video', itemKind: pipelineSchema.PORT_KIND_VIDEO },
  ]) {
    const input = pipelineSchema.createNode(entry.inputType, { id: 'trim-' + entry.itemKind + '-input', config: { filePath: entry.itemKind + '.bin' } });
    const trim = pipelineSchema.createNode('trimMedia', { id: 'trim-' + entry.itemKind });
    const pipeline = pipelineSchema.createEmptyPipeline({ nodes: [input, trim], edges: [pipelineSchema.createEdge(input.id, entry.inputPort, trim.id, 'media')] });
    const graph = pipelineSchema.buildPipelineGraph(pipeline);
    const outputKinds = pipelineSchema.resolveOutputKinds(trim, pipelineSchema.getPortDefinition(trim, 'output', 'trimmed'), graph);
    assert.deepStrictEqual(outputKinds, [entry.itemKind], 'Trim Media passthrough output should resolve to ' + entry.itemKind + '.');
  }

  const burnDefinition = pipelineSchema.getNodeTypeDefinition('burnSubtitles');
  assert(burnDefinition, 'Burn Subtitles / Captions node should exist.');
  assert.strictEqual(burnDefinition.category, 'Deterministic Media Operations', 'Burn Subtitles / Captions should live under Deterministic Media Operations.');
  assert.strictEqual(burnDefinition.inputPorts[0].kind, pipelineSchema.PORT_KIND_VIDEO, 'Burn Subtitles / Captions should accept video input.');
  assert.deepStrictEqual(burnDefinition.inputPorts[1].allowedKinds, [pipelineSchema.PORT_KIND_TEXT, pipelineSchema.PORT_KIND_FILE], 'Burn Subtitles / Captions should accept text or file captions.');
  assert.strictEqual(burnDefinition.outputPorts[0].kind, pipelineSchema.PORT_KIND_VIDEO, 'Burn Subtitles / Captions should output video.');

  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('videoStitch').category, 'Deterministic Media Operations', 'Video Stitch should live under Deterministic Media Operations.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('audioStitch').category, 'Deterministic Media Operations', 'Audio Stitch should live under Deterministic Media Operations.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('audioStitch').outputPorts[0].kind, pipelineSchema.PORT_KIND_AUDIO, 'Audio Stitch should still output one audio artifact.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('videoStitch').outputPorts[0].kind, pipelineSchema.PORT_KIND_VIDEO, 'Video Stitch should still output one video artifact.');

  const deterministicMediaCategory = 'Deterministic Media Operations';
  for (const type of ['collectionBuilder', 'audioStitch', 'videoStitch', 'mediaComposition', 'mediaExport', 'extractVideoFrame', 'extractAudio', 'normalizeAudioCollection', 'normalizeVideoCollection', 'trimMedia', 'burnSubtitles']) {
    assert.strictEqual(pipelineSchema.getNodeTypeDefinition(type).category, deterministicMediaCategory, type + ' should be grouped under Deterministic Media Operations.');
  }
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('mediaComposition').category, deterministicMediaCategory, 'Media Composition should live under Deterministic Media Operations.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('mediaExport').category, deterministicMediaCategory, 'Media Export should live under Deterministic Media Operations.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('collectionMap').category, 'AI Steps', 'Map Collection should live under AI Steps.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('collectionBuilder').type, 'collectionBuilder', 'Collection Builder type id should remain stable.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('collectionBuilder').category, deterministicMediaCategory, 'Collection Builder should live under Deterministic Media Operations.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('validation').type, 'validation', 'Validation type id should remain stable.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('validation').category, 'AI Steps', 'Validation should live under AI Steps.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('imageInput').type, 'imageInput', 'Image Input type id should remain stable.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('audioInput').type, 'audioInput', 'Audio Input type id should remain stable.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('videoInput').type, 'videoInput', 'Video Input type id should remain stable.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('imageInput').label, 'Image Input', 'Image file node should display as Image Input.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('audioInput').label, 'Audio Input', 'Audio file node should display as Audio Input.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('videoInput').label, 'Video Input', 'Video file node should display as Video Input.');

  const paletteSource = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'pipeline-ui.js'), 'utf8');
  const flowIndex = paletteSource.indexOf("'Flow'");
  const mediaIndex = paletteSource.indexOf("'Deterministic Media Operations'");
  const outputsIndex = paletteSource.indexOf("'Outputs'");
  assert(flowIndex !== -1 && mediaIndex !== -1 && outputsIndex !== -1 && flowIndex < mediaIndex && mediaIndex < outputsIndex, 'Palette order should place Deterministic Media Operations between Flow and Outputs.');

  const panelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'PipelineBuilderPanel.jsx'), 'utf8');
  assert(panelSource.includes("selectedNode.type === 'extractVideoFrame'"), 'Pipeline Builder should render Extract Video Frame inspector UI.');
  assert(panelSource.includes('extract-video-frame-position'), 'Extract Video Frame inspector should expose a mode selector.');
  assert(panelSource.includes('Extract the first or last frame from a video as an image.'), 'Extract Video Frame inspector should show the requested help text.');
  assert(panelSource.includes("selectedNode.type === 'extractAudio'"), 'Pipeline Builder should render Extract Audio inspector UI.');
  assert(panelSource.includes('Extract the audio track from a video as a WAV file.'), 'Extract Audio inspector should show the requested help text.');
  assert(panelSource.includes("selectedNode.type === 'trimMedia'"), 'Pipeline Builder should render Trim Media inspector UI.');
  assert(panelSource.includes('Trim an audio or video artifact to a selected time range.'), 'Trim Media inspector should show help text.');
  assert(panelSource.includes('>Start time</label>'), 'Trim Media should label the start field as Start time.');
  assert(panelSource.includes("'End time' : 'Duration seconds'"), 'Trim Media should label end mode as End time while keeping Duration seconds for duration mode.');
  assert(panelSource.includes('inputMode="decimal"'), 'Trim Media numeric fields should allow direct decimal text entry.');
  assert(panelSource.includes('isDraftSecondsValue(nextValue)'), 'Trim Media numeric fields should preserve typed decimal drafts before validation.');
  assert(panelSource.includes("selectedNode.type === 'burnSubtitles'"), 'Pipeline Builder should render Burn Subtitles / Captions inspector UI.');
  assert(panelSource.includes('Render timed captions directly into a video.'), 'Burn Subtitles / Captions inspector should show help text.');
  assert(panelSource.includes("selectedNode.type === 'normalizeAudioCollection'"), 'Pipeline Builder should render Normalize Audio Collection inspector UI.');
  assert(panelSource.includes('Convert every audio item in the collection to matching WAV settings while preserving collection order.'), 'Normalize Audio Collection inspector should show concise help text.');
  assert(panelSource.includes("selectedNode.type === 'normalizeVideoCollection'"), 'Pipeline Builder should render Normalize Video Collection inspector UI.');
  assert(panelSource.includes('Convert every video item in the collection to matching MP4 settings while preserving collection order.'), 'Normalize Video Collection inspector should show concise help text.');
  const normalizeAudioHelpIndex = panelSource.indexOf('Convert every audio item in the collection to matching WAV settings while preserving collection order.');
  const normalizeVideoHelpIndex = panelSource.indexOf('Convert every video item in the collection to matching MP4 settings while preserving collection order.');
  assert(!/stitch/i.test(panelSource.slice(normalizeAudioHelpIndex, normalizeAudioHelpIndex + 140)), 'Normalize Audio Collection help text should not mention stitching.');
  assert(!/stitch/i.test(panelSource.slice(normalizeVideoHelpIndex, normalizeVideoHelpIndex + 140)), 'Normalize Video Collection help text should not mention stitching.');
  assert(panelSource.includes('flex min-w-0 items-center gap-2'), 'Input port column should contain long labels inside its grid cell.');
  assert(panelSource.includes('flex min-w-0 items-center justify-end gap-2'), 'Output port column should contain long labels inside its grid cell.');
  assert(panelSource.includes('flex max-w-full items-center gap-2 rounded-full border'), 'Port buttons should not overflow across the opposite port hit area.');
  assert(panelSource.includes('className="min-w-0 truncate"'), 'Port labels should truncate inside their button hit area.');
}

function verifySafeFfmpegArgs() {
  const source = fs.readFileSync(path.join(process.cwd(), 'electron', 'services', 'mediaUtilityService.js'), 'utf8');
  assert(source.includes('runCommand(ffmpegPath, command.args'), 'Media utility runtime should pass argument arrays to runCommand.');
  assert(!/shell\s*:\s*true/.test(source), 'Media utility runtime should not enable shell execution for ffmpeg.');
  const firstFrameArgs = mediaUtilityService._test.buildFrameCommandArgs('input.mp4', 'first.png', 'first').args;
  const lastFrameArgs = mediaUtilityService._test.buildFrameCommandArgs('input.mp4', 'last.png', 'last').args;
  const audioArgs = mediaUtilityService._test.buildAudioCommandArgs('input.mp4', 'audio.wav').args;
  const audioNormalizeArgs = mediaUtilityService._test.buildAudioNormalizeCommandArgs('input.wav', 'output.wav', { channelCount: 2, sampleRate: 44100, pcmFormat: 'pcm_s16le' }).args;
  const videoNormalizeArgs = mediaUtilityService._test.buildVideoNormalizeCommandArgs('input.mp4', 'output.mp4', { audioCodec: 'aac', fps: 30, height: 64, outputFormat: 'mp4', pixelFormat: 'yuv420p', videoCodec: 'libx264', width: 96 }).args;
  const trimArgs = mediaUtilityService._test.buildTrimCommandArgs('input.mp4', 'trimmed.mp4', pipelineSchema.PORT_KIND_VIDEO, { startSeconds: 0, durationSeconds: 1 }).args;
  const burnArgs = mediaUtilityService._test.buildBurnSubtitlesCommandArgs('input.mp4', path.join(TEST_STORAGE_ROOT, 'captions.srt'), 'captioned.mp4').args;
  assert(Array.isArray(firstFrameArgs), 'First-frame extraction args should be an array.');
  assert(Array.isArray(lastFrameArgs) && lastFrameArgs.includes('reverse'), 'Last-frame extraction should use an explicit ffmpeg reverse filter args array.');
  assert(Array.isArray(audioArgs) && audioArgs.includes('0:a:0'), 'Audio extraction should map the first audio stream with an args array.');
  assert(Array.isArray(audioNormalizeArgs) && audioNormalizeArgs.includes('-ar') && audioNormalizeArgs.includes('44100'), 'Audio normalization should use an args array with target sample rate.');
  assert(Array.isArray(videoNormalizeArgs) && videoNormalizeArgs.includes('-map') && videoNormalizeArgs.includes('0:a:0?'), 'Video normalization should use safe optional audio stream mapping.');
  assert(Array.isArray(trimArgs) && trimArgs.includes('-ss') && trimArgs.includes('-t'), 'Trim Media should use explicit ffmpeg trim args.');
  assert(Array.isArray(burnArgs) && burnArgs.includes('-vf') && burnArgs.some((entry) => String(entry).startsWith('subtitles=')), 'Burn Subtitles should use the subtitles filter through an args array.');
}

async function verifyRuntimeExtraction() {
  await fsp.rm(TEST_STORAGE_ROOT, { recursive: true, force: true });
  await fsp.mkdir(TEST_STORAGE_ROOT, { recursive: true });
  const videoPath = path.join(TEST_STORAGE_ROOT, 'utility-source.mp4');
  const silentVideoPath = path.join(TEST_STORAGE_ROOT, 'utility-silent.mp4');
  await createSyntheticVideo(videoPath, { audio: true });
  await createSyntheticVideo(silentVideoPath, { audio: false });

  const videoArtifact = await buildFileArtifact(videoPath, {
    displayName: 'Utility source video',
    kind: pipelineSchema.PORT_KIND_VIDEO,
    role: 'input',
  });

  for (const utilityType of ['extractVideoFrame', 'extractAudio']) {
    const analysis = pipelineSchema.analyzePipeline(buildPipelineWithUtilityNode(utilityType, videoPath), {});
    assert.strictEqual(analysis.executable, true, utilityType + ' should analyze as executable with a connected video input.');
  }

  const firstFrame = await mediaUtilityService.extractVideoFrameArtifact(videoArtifact, {
    framePosition: 'first',
    node: { id: 'extract-first', label: 'Extract Video Frame', type: 'extractVideoFrame' },
    runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
  });
  assert.strictEqual(firstFrame.outputs.image.kind, pipelineSchema.PORT_KIND_IMAGE, 'First-frame extraction should output an image artifact.');
  assert(fs.existsSync(firstFrame.outputs.image.filePath), 'First-frame extraction should produce an image file.');
  assert.strictEqual(firstFrame.outputs.image.videoFrameExtraction.framePosition, 'first', 'First-frame artifact metadata should record frame position.');
  const firstFrameSidecarPath = firstFrame.outputs.image.metadataPaths.find((entry) => entry.endsWith('.image.json'));
  assert(firstFrameSidecarPath && fs.existsSync(firstFrameSidecarPath), 'First-frame extraction should save an image sidecar.');
  const firstFrameSidecar = readJson(firstFrameSidecarPath);
  assert.strictEqual(firstFrameSidecar.videoFrameExtraction.framePosition, 'first', 'First-frame sidecar should record frame position.');
  assert.strictEqual(firstFrameSidecar.videoFrameExtraction.sourceVideo.filePath, videoPath, 'First-frame sidecar should record source video path.');

  const lastFrame = await mediaUtilityService.extractVideoFrameArtifact(videoArtifact, {
    framePosition: 'last',
    node: { id: 'extract-last', label: 'Extract Video Frame', type: 'extractVideoFrame' },
    runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
  });
  assert.strictEqual(lastFrame.outputs.image.videoFrameExtraction.framePosition, 'last', 'Last-frame artifact metadata should record frame position.');
  assert(fs.existsSync(lastFrame.outputs.image.filePath), 'Last-frame extraction should produce an image file.');

  const extractedAudio = await mediaUtilityService.extractAudioFromVideoArtifact(videoArtifact, {
    node: { id: 'extract-audio', label: 'Extract Audio', type: 'extractAudio' },
    runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
  });
  assert.strictEqual(extractedAudio.outputs.audio.kind, pipelineSchema.PORT_KIND_AUDIO, 'Extract Audio should output an audio artifact.');
  assert(fs.existsSync(extractedAudio.outputs.audio.filePath), 'Extract Audio should produce a WAV file.');
  assert.strictEqual(extractedAudio.outputs.audio.audioExtraction.sourceVideo.filePath, videoPath, 'Audio artifact metadata should record source video path.');
  assert.strictEqual(extractedAudio.outputs.audio.audioExtraction.outputFormat, 'wav', 'Audio artifact metadata should record output format.');
  assert(extractedAudio.outputs.audio.audio?.sampleRate, 'Extract Audio should keep detected WAV sample rate metadata when available.');
  const audioSidecarPath = extractedAudio.outputs.audio.metadataPaths.find((entry) => entry.endsWith('.audio.json'));
  assert(audioSidecarPath && fs.existsSync(audioSidecarPath), 'Extract Audio should save an audio sidecar.');
  const audioSidecar = readJson(audioSidecarPath);
  assert.strictEqual(audioSidecar.audioExtraction.sourceVideo.filePath, videoPath, 'Audio sidecar should record source video path.');
  assert.strictEqual(audioSidecar.audioExtraction.ffmpegMode, 'first-audio-stream-to-pcm-wav', 'Audio sidecar should record ffmpeg extraction mode.');
  assert(audioSidecar.audioExtraction.sampleRate, 'Audio sidecar should record sample rate when known.');

  const missingVideoPath = path.join(TEST_STORAGE_ROOT, 'missing.mp4');
  await assert.rejects(
    () => mediaUtilityService.extractVideoFrameArtifact({ kind: pipelineSchema.PORT_KIND_VIDEO, filePath: missingVideoPath }, { runDirectories: { artifactsDir: TEST_STORAGE_ROOT } }),
    /could not find the connected video file/i,
    'Missing frame source should fail clearly.',
  );

  const silentArtifact = await buildFileArtifact(silentVideoPath, {
    displayName: 'Silent video',
    kind: pipelineSchema.PORT_KIND_VIDEO,
    role: 'input',
  });
  await assert.rejects(
    () => mediaUtilityService.extractAudioFromVideoArtifact(silentArtifact, { runDirectories: { artifactsDir: TEST_STORAGE_ROOT } }),
    /could not find an audio track/i,
    'Silent video audio extraction should fail clearly.',
  );
}

async function verifyRuntimeNormalization() {
  const audioAPath = path.join(TEST_STORAGE_ROOT, 'audio-a.wav');
  const audioBPath = path.join(TEST_STORAGE_ROOT, 'audio-b.wav');
  await createSyntheticAudio(audioAPath, { sampleRate: 16000, channels: 1 });
  await createSyntheticAudio(audioBPath, { sampleRate: 48000, channels: 2 });
  const audioA = await buildFileArtifact(audioAPath, { displayName: 'Audio A', kind: pipelineSchema.PORT_KIND_AUDIO, role: 'input' });
  const audioB = await buildFileArtifact(audioBPath, { displayName: 'Audio B', kind: pipelineSchema.PORT_KIND_AUDIO, role: 'input' });
  const audioCollection = createArtifactCollection([
    { artifact: audioA, index: 0, itemId: 'audio-a' },
    { artifact: audioB, index: 1, itemId: 'audio-b' },
  ], { displayName: 'Mixed audio collection', itemKind: pipelineSchema.PORT_KIND_AUDIO, role: 'input' });

  const normalizedAudio = await mediaUtilityService.normalizeAudioCollectionArtifact(audioCollection, {
    channels: 'stereo',
    node: { id: 'normalize-audio', label: 'Normalize Audio Collection', type: 'normalizeAudioCollection' },
    outputFormat: 'wav',
    runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
    sampleRate: 44100,
  });
  assert(!normalizedAudio.outputs.audio, 'Normalize Audio Collection should not output a single audio artifact.');
  assert.strictEqual(normalizedAudio.outputs.collection.kind, pipelineSchema.PORT_KIND_COLLECTION, 'Normalize Audio Collection should output a collection artifact.');
  assert.strictEqual(normalizedAudio.outputs.collection.itemKind, pipelineSchema.PORT_KIND_AUDIO, 'Normalize Audio Collection output should be collection:audio.');
  assert.strictEqual(normalizedAudio.outputs.collection.itemCount, 2, 'Normalize Audio Collection should keep item count.');
  assert.deepStrictEqual(normalizedAudio.outputs.collection.items.map((entry) => entry.itemId), ['audio-a', 'audio-b'], 'Normalize Audio Collection should preserve item order.');
  assert(fs.existsSync(normalizedAudio.outputs.collection.manifestPath), 'Normalize Audio Collection should persist a manifest.');
  const audioManifest = readJson(normalizedAudio.outputs.collection.manifestPath);
  assert.strictEqual(audioManifest.collectionNormalization.operation, 'normalizeAudioCollection', 'Audio collection manifest should record normalization operation.');
  assert.strictEqual(audioManifest.collectionNormalization.itemCount, 2, 'Audio collection manifest should record item count.');
  assert.strictEqual(audioManifest.collectionNormalization.targetSettings.sampleRate, 44100, 'Audio collection manifest should record sample rate.');
  assert.deepStrictEqual(audioManifest.collectionNormalization.orderedSourceItems.map((entry) => entry.itemId), ['audio-a', 'audio-b'], 'Audio collection manifest should preserve ordered source refs.');

  for (const entry of normalizedAudio.outputs.collection.items) {
    assert.strictEqual(entry.artifact.kind, pipelineSchema.PORT_KIND_AUDIO, 'Normalized audio item should remain audio.');
    assert.strictEqual(entry.artifact.audio?.sampleRate, 44100, 'Normalized audio item should use target sample rate.');
    assert.strictEqual(entry.artifact.audio?.channelCount, 2, 'Normalized audio item should use target channel count.');
    assert.strictEqual(entry.artifact.audioNormalization.operation, 'normalizeAudioCollection', 'Normalized audio item should record operation.');
    assert.strictEqual(entry.artifact.audioNormalization.sourceCollection.itemKind, pipelineSchema.PORT_KIND_AUDIO, 'Normalized audio item should record source collection.');
    const sidecarPath = entry.artifact.metadataPaths.find((candidate) => candidate.endsWith('.audio.json'));
    assert(sidecarPath && fs.existsSync(sidecarPath), 'Normalized audio item should save an audio sidecar.');
    const sidecar = readJson(sidecarPath);
    assert.strictEqual(sidecar.audioNormalization.sampleRate, 44100, 'Normalized audio sidecar should record target sample rate.');
    assert.strictEqual(sidecar.audioNormalization.sourceAudio.filePath, entry.metadata.sourceItem.artifactPath, 'Normalized audio sidecar should record source audio path.');
  }

  await assert.rejects(
    () => mediaUtilityService.normalizeAudioCollectionArtifact({ kind: pipelineSchema.PORT_KIND_COLLECTION, itemKind: pipelineSchema.PORT_KIND_AUDIO, items: [] }, { runDirectories: { artifactsDir: TEST_STORAGE_ROOT } }),
    /empty audio collection/i,
    'Empty audio collection should fail clearly.',
  );
  await assert.rejects(
    () => mediaUtilityService.normalizeAudioCollectionArtifact({ kind: pipelineSchema.PORT_KIND_COLLECTION, itemKind: pipelineSchema.PORT_KIND_AUDIO, items: [{ artifact: { kind: pipelineSchema.PORT_KIND_AUDIO, filePath: path.join(TEST_STORAGE_ROOT, 'missing-audio.wav') }, index: 0 }] }, { runDirectories: { artifactsDir: TEST_STORAGE_ROOT } }),
    /could not find an audio file/i,
    'Missing audio item should fail clearly.',
  );

  const videoAPath = path.join(TEST_STORAGE_ROOT, 'video-a.mp4');
  const videoBPath = path.join(TEST_STORAGE_ROOT, 'video-b.mp4');
  await createSyntheticVideo(videoAPath, { audio: true, size: '96x64', rate: 2 });
  await createSyntheticVideo(videoBPath, { audio: false, size: '128x72', rate: 3 });
  const videoA = await buildFileArtifact(videoAPath, { displayName: 'Video A', kind: pipelineSchema.PORT_KIND_VIDEO, role: 'input' });
  const videoB = await buildFileArtifact(videoBPath, { displayName: 'Video B', kind: pipelineSchema.PORT_KIND_VIDEO, role: 'input' });
  const videoCollection = createArtifactCollection([
    { artifact: videoA, index: 0, itemId: 'video-a' },
    { artifact: videoB, index: 1, itemId: 'video-b' },
  ], { displayName: 'Mixed video collection', itemKind: pipelineSchema.PORT_KIND_VIDEO, role: 'input' });

  const normalizedVideo = await mediaUtilityService.normalizeVideoCollectionArtifact(videoCollection, {
    fps: 2,
    height: 64,
    node: { id: 'normalize-video', label: 'Normalize Video Collection', type: 'normalizeVideoCollection' },
    outputFormat: 'mp4',
    runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
    sizeMode: 'custom',
    videoCodec: 'libx264',
    width: 96,
  });
  assert(!normalizedVideo.outputs.video, 'Normalize Video Collection should not output a single video artifact.');
  assert.strictEqual(normalizedVideo.outputs.collection.kind, pipelineSchema.PORT_KIND_COLLECTION, 'Normalize Video Collection should output a collection artifact.');
  assert.strictEqual(normalizedVideo.outputs.collection.itemKind, pipelineSchema.PORT_KIND_VIDEO, 'Normalize Video Collection output should be collection:video.');
  assert.strictEqual(normalizedVideo.outputs.collection.itemCount, 2, 'Normalize Video Collection should keep item count.');
  assert.deepStrictEqual(normalizedVideo.outputs.collection.items.map((entry) => entry.itemId), ['video-a', 'video-b'], 'Normalize Video Collection should preserve item order.');
  assert(fs.existsSync(normalizedVideo.outputs.collection.manifestPath), 'Normalize Video Collection should persist a manifest.');
  const videoManifest = readJson(normalizedVideo.outputs.collection.manifestPath);
  assert.strictEqual(videoManifest.collectionNormalization.operation, 'normalizeVideoCollection', 'Video collection manifest should record normalization operation.');
  assert.strictEqual(videoManifest.collectionNormalization.itemCount, 2, 'Video collection manifest should record item count.');
  assert.strictEqual(videoManifest.collectionNormalization.targetSettings.width, 96, 'Video collection manifest should record target width.');
  assert.deepStrictEqual(videoManifest.collectionNormalization.orderedSourceItems.map((entry) => entry.itemId), ['video-a', 'video-b'], 'Video collection manifest should preserve ordered source refs.');

  for (const entry of normalizedVideo.outputs.collection.items) {
    assert.strictEqual(entry.artifact.kind, pipelineSchema.PORT_KIND_VIDEO, 'Normalized video item should remain video.');
    assert.strictEqual(entry.artifact.videoNormalization.operation, 'normalizeVideoCollection', 'Normalized video item should record operation.');
    assert.strictEqual(entry.artifact.videoNormalization.width, 96, 'Normalized video item should record target width.');
    assert.strictEqual(entry.artifact.videoNormalization.height, 64, 'Normalized video item should record target height.');
    assert.strictEqual(entry.artifact.videoNormalization.sourceCollection.itemKind, pipelineSchema.PORT_KIND_VIDEO, 'Normalized video item should record source collection.');
    const sidecarPath = entry.artifact.metadataPaths.find((candidate) => candidate.endsWith('.video.json'));
    assert(sidecarPath && fs.existsSync(sidecarPath), 'Normalized video item should save a video sidecar.');
    const sidecar = readJson(sidecarPath);
    assert.strictEqual(sidecar.videoNormalization.width, 96, 'Normalized video sidecar should record target width.');
    assert.strictEqual(sidecar.videoNormalization.sourceVideo.filePath, entry.metadata.sourceItem.artifactPath, 'Normalized video sidecar should record source video path.');
  }

  await assert.rejects(
    () => mediaUtilityService.normalizeVideoCollectionArtifact({ kind: pipelineSchema.PORT_KIND_COLLECTION, itemKind: pipelineSchema.PORT_KIND_VIDEO, items: [] }, { runDirectories: { artifactsDir: TEST_STORAGE_ROOT } }),
    /empty video collection/i,
    'Empty video collection should fail clearly.',
  );
  await assert.rejects(
    () => mediaUtilityService.normalizeVideoCollectionArtifact({ kind: pipelineSchema.PORT_KIND_COLLECTION, itemKind: pipelineSchema.PORT_KIND_VIDEO, items: [{ artifact: { kind: pipelineSchema.PORT_KIND_VIDEO, filePath: path.join(TEST_STORAGE_ROOT, 'missing-video.mp4') }, index: 0 }] }, { runDirectories: { artifactsDir: TEST_STORAGE_ROOT } }),
    /could not find the connected video file/i,
    'Missing video item should fail clearly.',
  );
}

async function verifyRuntimePassCUtilities() {
  const trimAudioPath = path.join(TEST_STORAGE_ROOT, 'trim-audio-source.wav');
  const trimVideoPath = path.join(TEST_STORAGE_ROOT, 'trim-video-source.mp4');
  await createSyntheticAudio(trimAudioPath, { sampleRate: 44100, channels: 2, duration: 1 });
  await createSyntheticVideo(trimVideoPath, { audio: true, size: '96x64', rate: 4, duration: 1 });
  const audioArtifact = await buildFileArtifact(trimAudioPath, { displayName: 'Trim audio source', kind: pipelineSchema.PORT_KIND_AUDIO, role: 'input' });
  const videoArtifact = await buildFileArtifact(trimVideoPath, { displayName: 'Trim video source', kind: pipelineSchema.PORT_KIND_VIDEO, role: 'input' });

  const trimmedAudio = await mediaUtilityService.trimMediaArtifact(audioArtifact, {
    durationSeconds: 0.4,
    node: { id: 'trim-audio', label: 'Trim Media', type: 'trimMedia' },
    runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
    startSeconds: 0.1,
  });
  assert.strictEqual(trimmedAudio.outputs.trimmed.kind, pipelineSchema.PORT_KIND_AUDIO, 'Trim Media should output audio for audio input.');
  assert(fs.existsSync(trimmedAudio.outputs.trimmed.filePath), 'Trim Media should create trimmed audio.');
  assert.strictEqual(trimmedAudio.outputs.trimmed.mediaTrim.operation, 'trimMedia', 'Trimmed audio should record trim operation.');
  const trimAudioSidecar = readJson(trimmedAudio.outputs.trimmed.metadataPaths.find((entry) => entry.endsWith('.audio.json')));
  assert.strictEqual(trimAudioSidecar.mediaTrim.sourceKind, pipelineSchema.PORT_KIND_AUDIO, 'Trim audio sidecar should record source kind.');
  assert.strictEqual(trimAudioSidecar.mediaTrim.startSeconds, 0.1, 'Trim audio sidecar should record start seconds.');

  const trimmedVideo = await mediaUtilityService.trimMediaArtifact(videoArtifact, {
    endSeconds: 0.7,
    mode: 'end',
    node: { id: 'trim-video', label: 'Trim Media', type: 'trimMedia' },
    runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
    startSeconds: 0.1,
  });
  assert.strictEqual(trimmedVideo.outputs.trimmed.kind, pipelineSchema.PORT_KIND_VIDEO, 'Trim Media should output video for video input.');
  assert(fs.existsSync(trimmedVideo.outputs.trimmed.filePath), 'Trim Media should create trimmed video.');
  const trimVideoSidecar = readJson(trimmedVideo.outputs.trimmed.metadataPaths.find((entry) => entry.endsWith('.video.json')));
  assert.strictEqual(trimVideoSidecar.mediaTrim.sourceKind, pipelineSchema.PORT_KIND_VIDEO, 'Trim video sidecar should record source kind.');
  assert.strictEqual(trimVideoSidecar.mediaTrim.endSeconds, 0.7, 'Trim video sidecar should record end seconds.');

  await assert.rejects(
    () => mediaUtilityService.trimMediaArtifact(audioArtifact, { durationSeconds: 0, runDirectories: { artifactsDir: TEST_STORAGE_ROOT } }),
    /positive duration/i,
    'Trim Media should fail clearly for an invalid duration.',
  );

  const manualCaptions = createTextArtifact('First caption\nSecond caption', { displayName: 'Manual captions', role: 'input' });
  const manualBurn = await mediaUtilityService.burnSubtitlesIntoVideoArtifact(videoArtifact, manualCaptions, {
    captionMode: 'manualLines',
    durationPerCaptionSeconds: 0.25,
    node: { id: 'burn-manual', label: 'Burn Subtitles / Captions', type: 'burnSubtitles' },
    runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
  });
  assert.strictEqual(manualBurn.outputs.video.kind, pipelineSchema.PORT_KIND_VIDEO, 'Burn Subtitles should output video.');
  assert(fs.existsSync(manualBurn.outputs.video.filePath), 'Burn Subtitles should create a captioned video.');
  assert.strictEqual(manualBurn.outputs.video.subtitleBurn.captionMode, 'manualLines', 'Manual caption burn should record mode.');
  assert.strictEqual(manualBurn.outputs.video.subtitleBurn.captionCount, 2, 'Manual caption burn should count lines.');
  const manualSrt = fs.readFileSync(manualBurn.outputs.video.subtitleBurn.generatedSubtitlePath, 'utf8');
  assert(manualSrt.includes('00:00:00,000 --> 00:00:00,250'), 'Manual caption SRT should use duration per line.');
  const manualBurnSidecar = readJson(manualBurn.outputs.video.metadataPaths.find((entry) => entry.endsWith('.video.json')));
  assert.strictEqual(manualBurnSidecar.subtitleBurn.captionSource.kind, pipelineSchema.PORT_KIND_TEXT, 'Burn sidecar should record text caption source.');

  const transcriptCaptions = createTextArtifact('Hello world. Bye.', {
    displayName: 'Transcript captions',
    role: 'generated',
    transcription: {
      backend: 'whisper',
      segmentCount: 2,
      segments: [
        { start: 0, end: 0.25, text: 'Hello world.' },
        { start: 0.25, end: 0.5, text: 'Bye.' },
      ],
    },
  });
  const transcriptPrepared = await mediaUtilityService._test.prepareSubtitleSource(transcriptCaptions, {
    captionMode: 'transcriptSegments',
    node: { id: 'prepare-transcript', label: 'Burn Subtitles / Captions', type: 'burnSubtitles' },
    runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
  });
  assert.strictEqual(transcriptPrepared.mode, 'transcriptSegments', 'Transcript segments should prepare timed SRT.');
  assert.strictEqual(transcriptPrepared.captionCount, 2, 'Transcript segment SRT should count segments.');
  assert(fs.readFileSync(transcriptPrepared.subtitlePath, 'utf8').includes('Hello world.'), 'Transcript SRT should include segment text.');

  const subtitleFilePath = path.join(TEST_STORAGE_ROOT, 'fixture-captions.srt');
  fs.writeFileSync(subtitleFilePath, '1\n00:00:00,000 --> 00:00:00,300\nSubtitle file caption\n', 'utf8');
  const subtitleFileArtifact = await buildFileArtifact(subtitleFilePath, { displayName: 'Fixture captions', kind: pipelineSchema.PORT_KIND_FILE, role: 'input' });
  const subtitlePrepared = await mediaUtilityService._test.prepareSubtitleSource(subtitleFileArtifact, {
    captionMode: 'subtitleFile',
    node: { id: 'prepare-file', label: 'Burn Subtitles / Captions', type: 'burnSubtitles' },
    runDirectories: { artifactsDir: TEST_STORAGE_ROOT },
  });
  assert.strictEqual(subtitlePrepared.mode, 'subtitleFile', 'Subtitle file mode should accept SRT files.');
  assert.strictEqual(subtitlePrepared.subtitlePath, subtitleFilePath, 'Subtitle file mode should use the source SRT path.');

  await assert.rejects(
    () => mediaUtilityService.burnSubtitlesIntoVideoArtifact(videoArtifact, createTextArtifact('   ', { displayName: 'Empty captions' }), { captionMode: 'manualLines', runDirectories: { artifactsDir: TEST_STORAGE_ROOT } }),
    /at least one non-empty caption line/i,
    'Burn Subtitles should fail clearly for empty manual captions.',
  );
}

async function main() {
  verifySchemaAndUiContracts();
  verifySafeFfmpegArgs();
  await verifyRuntimeExtraction();
  await verifyRuntimeNormalization();
  await verifyRuntimePassCUtilities();
  console.log('Pipeline media utility verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
