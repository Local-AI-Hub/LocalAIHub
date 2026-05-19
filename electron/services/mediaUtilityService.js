const path = require('path');
const fs = require('fs-extra');

const { runCommand } = require('./commandService');
const { resolveFfmpegPath } = require('./mediaCompositionService');
const {
  buildFileArtifact,
  createArtifactCollection,
  persistArtifactCollection,
  saveAudioArtifactMetadata,
  saveImageArtifactMetadata,
  saveVideoArtifactMetadata,
  summarizeArtifact,
} = require('./pipelineArtifactService');
const { PORT_KIND_AUDIO, PORT_KIND_COLLECTION, PORT_KIND_FILE, PORT_KIND_IMAGE, PORT_KIND_TEXT, PORT_KIND_VIDEO } = require('../shared/pipelineSchema.cjs');

function firstNonEmptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function sanitizeSegment(value, fallback = 'media-utility') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function normalizeFramePosition(value) {
  const normalized = String(value || 'first').trim().toLowerCase();
  if (normalized === 'first' || normalized === 'last') {
    return normalized;
  }
  throw new Error('Extract Video Frame can extract either the first frame or the last frame.');
}

function normalizeImageOutputFormat(value) {
  const normalized = String(value || 'png').trim().toLowerCase();
  if (!normalized || normalized === 'png') {
    return 'png';
  }
  throw new Error('Extract Video Frame writes PNG images in this pass. Leave the output format as png.');
}

function normalizeAudioOutputFormat(value, operationLabel = 'Extract Audio') {
  const normalized = String(value || 'wav').trim().toLowerCase();
  if (!normalized || normalized === 'wav') {
    return 'wav';
  }
  throw new Error(operationLabel + ' writes WAV output in this pass. Leave the output format as wav.');
}

function normalizeVideoOutputFormat(value, operationLabel = 'Normalize Video Collection') {
  const normalized = String(value || 'mp4').trim().toLowerCase();
  if (!normalized || normalized === 'mp4') {
    return 'mp4';
  }
  throw new Error(operationLabel + ' writes MP4 output in this pass. Leave the output format as mp4.');
}

function buildCreatedBy(node, fallbackType) {
  return {
    nodeId: String(node?.id || '').trim(),
    nodeLabel: String(node?.label || '').trim(),
    nodeType: String(node?.type || fallbackType || '').trim(),
  };
}

function buildArtifactReference(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return null;
  }

  return {
    displayName: String(artifact.displayName || '').trim(),
    fileName: String(artifact.fileName || '').trim(),
    filePath: String(artifact.filePath || '').trim(),
    fileUrl: String(artifact.fileUrl || '').trim(),
    formatLabel: String(artifact.formatLabel || '').trim(),
    id: String(artifact.id || artifact.artifactId || '').trim(),
    kind: String(artifact.kind || '').trim(),
    metadataPaths: Array.isArray(artifact.metadataPaths) ? artifact.metadataPaths : [],
    mimeType: String(artifact.mimeType || '').trim(),
    sizeBytes: Number(artifact.sizeBytes || 0) || 0,
    summary: summarizeArtifact(artifact),
  };
}

function buildVideoReference(artifact) {
  return buildArtifactReference(artifact);
}

function buildAudioReference(artifact) {
  return buildArtifactReference(artifact);
}

function buildCollectionReference(collection) {
  if (!collection || typeof collection !== 'object') {
    return null;
  }
  return {
    directoryPath: String(collection.directoryPath || '').trim(),
    displayName: String(collection.displayName || '').trim(),
    filePath: String(collection.filePath || '').trim(),
    id: String(collection.id || collection.artifactId || '').trim(),
    itemCount: Number(collection.itemCount || (Array.isArray(collection.items) ? collection.items.length : 0)) || 0,
    itemKind: String(collection.itemKind || '').trim(),
    kind: String(collection.kind || PORT_KIND_COLLECTION).trim() || PORT_KIND_COLLECTION,
    manifestPath: String(collection.manifestPath || '').trim(),
    summary: summarizeArtifact(collection),
  };
}

async function resolveSourceVideoPath(videoArtifact, operationLabel) {
  if (String(videoArtifact?.kind || '').trim() !== PORT_KIND_VIDEO) {
    throw new Error(operationLabel + ' needs a video input before it can run.');
  }

  const rawPath = String(videoArtifact?.filePath || '').trim();
  if (!rawPath) {
    throw new Error(operationLabel + ' needs a video file path, but the connected video artifact does not have one.');
  }

  const sourcePath = path.resolve(rawPath);
  if (!(await fs.pathExists(sourcePath))) {
    throw new Error(operationLabel + ' could not find the connected video file on disk. Regenerate it or choose the file again, then rerun the pipeline.');
  }

  return sourcePath;
}

async function resolveSourceAudioPath(audioArtifact, operationLabel) {
  if (String(audioArtifact?.kind || '').trim() !== PORT_KIND_AUDIO) {
    throw new Error(operationLabel + ' needs an audio input before it can run.');
  }

  const rawPath = String(audioArtifact?.filePath || '').trim();
  if (!rawPath) {
    throw new Error(operationLabel + ' needs an audio file path, but a collection item does not have one.');
  }

  const sourcePath = path.resolve(rawPath);
  if (!(await fs.pathExists(sourcePath))) {
    throw new Error(operationLabel + ' could not find an audio file from the connected collection. Regenerate that item or choose the file again, then rerun the pipeline.');
  }

  return sourcePath;
}

function getArtifactsDir(runDirectories, operationLabel) {
  const artifactsDir = String(runDirectories?.artifactsDir || '').trim();
  if (!artifactsDir) {
    throw new Error('Local AI Hub could not prepare a run folder for ' + operationLabel + '.');
  }
  return artifactsDir;
}

async function nextOutputPath(runDirectories, node, suffix, extension) {
  const artifactsDir = getArtifactsDir(runDirectories, String(node?.label || 'this media utility').trim() || 'this media utility');
  const baseName = sanitizeSegment([node?.label || 'media-utility', suffix].filter(Boolean).join('-'), suffix || 'media-utility');
  let attempt = 0;
  while (true) {
    const counter = attempt === 0 ? '' : '-' + String(attempt + 1);
    const outputPath = path.join(artifactsDir, baseName + counter + extension);
    if (!(await fs.pathExists(outputPath))) {
      return outputPath;
    }
    attempt += 1;
  }
}

function buildFrameCommandArgs(sourcePath, outputPath, framePosition) {
  if (framePosition === 'last') {
    return {
      args: ['-y', '-i', sourcePath, '-map', '0:v:0', '-vf', 'reverse', '-frames:v', '1', '-update', '1', outputPath],
      mode: 'reverse-filter-last-frame',
      timestampSeconds: null,
    };
  }

  return {
    args: ['-y', '-i', sourcePath, '-map', '0:v:0', '-frames:v', '1', '-update', '1', outputPath],
    mode: 'first-video-frame',
    timestampSeconds: 0,
  };
}

async function extractVideoFrameArtifact(videoArtifact, options = {}) {
  const operationLabel = 'Extract Video Frame';
  const framePosition = normalizeFramePosition(options.framePosition);
  const outputFormat = normalizeImageOutputFormat(options.outputFormat);
  const sourcePath = await resolveSourceVideoPath(videoArtifact, operationLabel);
  const outputPath = await nextOutputPath(options.runDirectories, options.node, framePosition + '-frame', '.' + outputFormat);

  options.reportProgress?.(
    'Extracting video frame.',
    'Saving the ' + framePosition + ' frame as a PNG image with the bundled ffmpeg runtime...',
  );

  const ffmpegPath = resolveFfmpegPath();
  const command = buildFrameCommandArgs(sourcePath, outputPath, framePosition);
  const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error('Extract Video Frame could not read a video frame from this file. ' + (failureLine || 'Try a different video file or regenerate the source clip.'));
  }

  const artifact = await buildFileArtifact(outputPath, {
    displayName: String(options.displayName || options.node?.label || 'Extracted video frame').trim() || 'Extracted video frame',
    kind: PORT_KIND_IMAGE,
    role: 'generated',
  });
  artifact.videoFrameExtraction = {
    backend: 'ffmpeg',
    backendLabel: 'Bundled ffmpeg',
    createdBy: buildCreatedBy(options.node, 'extractVideoFrame'),
    ffmpegMode: command.mode,
    framePosition,
    operationId: 'extractVideoFrame',
    outputFormat,
    sourceVideo: buildVideoReference(videoArtifact),
    timestampSeconds: command.timestampSeconds,
  };
  artifact.summary = summarizeArtifact(artifact);
  const metadataPaths = await saveImageArtifactMetadata(outputPath, artifact);
  if (metadataPaths.length) artifact.metadataPaths = metadataPaths;

  return {
    destinationPath: outputPath,
    message: 'Extract Video Frame saved the ' + framePosition + ' frame as a PNG image.',
    outputs: { image: artifact },
    preview: summarizeArtifact(artifact),
  };
}

function buildAudioCommandArgs(sourcePath, outputPath) {
  return {
    args: ['-y', '-i', sourcePath, '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', outputPath],
    mode: 'first-audio-stream-to-pcm-wav',
  };
}

function isMissingAudioStreamFailure(commandResult) {
  const combined = String(commandResult?.stderr || '') + '\n' + String(commandResult?.stdout || '');
  return /matches no streams|stream map.*0:a:0|does not contain any stream/i.test(combined);
}

async function extractAudioFromVideoArtifact(videoArtifact, options = {}) {
  const operationLabel = 'Extract Audio';
  const outputFormat = normalizeAudioOutputFormat(options.outputFormat, operationLabel);
  const sourcePath = await resolveSourceVideoPath(videoArtifact, operationLabel);
  const outputPath = await nextOutputPath(options.runDirectories, options.node, 'audio', '.' + outputFormat);

  options.reportProgress?.(
    'Extracting audio.',
    'Saving the first audio stream as a WAV artifact with the bundled ffmpeg runtime...',
  );

  const ffmpegPath = resolveFfmpegPath();
  const command = buildAudioCommandArgs(sourcePath, outputPath);
  const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    if (isMissingAudioStreamFailure(commandResult)) {
      throw new Error('Extract Audio could not find an audio track in this video. Choose a video with audio and try again.');
    }
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error('Extract Audio could not save a WAV file from this video. ' + (failureLine || 'Try a different video file or regenerate the source clip.'));
  }

  const artifact = await buildFileArtifact(outputPath, {
    displayName: String(options.displayName || options.node?.label || 'Extracted audio').trim() || 'Extracted audio',
    kind: PORT_KIND_AUDIO,
    role: 'generated',
  });
  artifact.audioExtraction = {
    audio: artifact.audio || null,
    backend: 'ffmpeg',
    backendLabel: 'Bundled ffmpeg',
    channelCount: artifact.audio?.channelCount || 0,
    createdBy: buildCreatedBy(options.node, 'extractAudio'),
    durationSeconds: artifact.audio?.durationSeconds || null,
    ffmpegMode: command.mode,
    operationId: 'extractAudio',
    outputFormat,
    sampleRate: artifact.audio?.sampleRate || 0,
    sourceVideo: buildVideoReference(videoArtifact),
  };
  artifact.summary = summarizeArtifact(artifact);
  const metadataPaths = await saveAudioArtifactMetadata(outputPath, artifact);
  if (metadataPaths.length) artifact.metadataPaths = metadataPaths;

  return {
    destinationPath: outputPath,
    message: 'Extract Audio saved the first audio stream as a WAV file.',
    outputs: { audio: artifact },
    preview: summarizeArtifact(artifact),
  };
}

function normalizeAudioSettings(options = {}) {
  const outputFormat = normalizeAudioOutputFormat(options.outputFormat, 'Normalize Audio Collection');
  const sampleRate = Math.max(1, Math.round(Number(options.sampleRate || 44100) || 44100));
  const channels = String(options.channels || 'stereo').trim().toLowerCase() === 'mono' ? 'mono' : 'stereo';
  return {
    channelCount: channels === 'mono' ? 1 : 2,
    channels,
    outputFormat,
    pcmFormat: String(options.pcmFormat || 'pcm_s16le').trim() || 'pcm_s16le',
    sampleRate,
  };
}

function buildAudioNormalizeCommandArgs(sourcePath, outputPath, settings) {
  return {
    args: ['-y', '-i', sourcePath, '-vn', '-ac', String(settings.channelCount), '-ar', String(settings.sampleRate), '-c:a', settings.pcmFormat, outputPath],
    mode: 'audio-collection-to-normalized-pcm-wav',
  };
}

function ensureCollection(sourceCollection, itemKind, operationLabel) {
  if (String(sourceCollection?.kind || '').trim() !== PORT_KIND_COLLECTION) {
    throw new Error(operationLabel + ' needs an ordered ' + itemKind + ' collection before it can run.');
  }
  if (String(sourceCollection?.itemKind || '').trim() !== itemKind) {
    throw new Error(operationLabel + ' only accepts collection:' + itemKind + ' input. Connect the matching collection type to this node.');
  }
  const orderedEntries = (Array.isArray(sourceCollection.items) ? sourceCollection.items : [])
    .filter((entry) => entry?.artifact)
    .sort((left, right) => (Number(left.index || 0) || 0) - (Number(right.index || 0) || 0));
  if (!orderedEntries.length) {
    throw new Error(operationLabel + ' received an empty ' + itemKind + ' collection. Add at least one ' + itemKind + ' item before normalizing.');
  }
  return orderedEntries;
}

function buildSourceItemReference(entry, artifact, sourcePath, index) {
  return {
    artifactId: String(artifact.id || artifact.artifactId || '').trim(),
    artifactPath: sourcePath,
    displayName: String(artifact.displayName || artifact.fileName || 'Collection item ' + String(index + 1)).trim(),
    fileName: String(artifact.fileName || path.basename(sourcePath)).trim(),
    index: Number(entry.index || index) || index,
    itemId: String(entry.itemId || '').trim(),
    kind: String(artifact.kind || '').trim(),
    metadataPaths: Array.isArray(artifact.metadataPaths) ? artifact.metadataPaths : [],
    summary: String(entry.summary || artifact.summary || summarizeArtifact(artifact)).trim(),
  };
}

async function normalizeAudioCollectionArtifact(sourceCollection, options = {}) {
  const operationLabel = 'Normalize Audio Collection';
  const settings = normalizeAudioSettings(options);
  const orderedEntries = ensureCollection(sourceCollection, PORT_KIND_AUDIO, operationLabel);
  const collectionRef = buildCollectionReference(sourceCollection);
  const ffmpegPath = resolveFfmpegPath();
  const normalizedItems = [];
  const orderedSourceItems = [];

  options.reportProgress?.(
    'Normalizing audio collection.',
    'Converting ' + orderedEntries.length + ' audio item' + (orderedEntries.length === 1 ? '' : 's') + ' to matching WAV settings...',
  );

  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    const sourceArtifact = entry.artifact;
    const sourcePath = await resolveSourceAudioPath(sourceArtifact, operationLabel);
    const sourceItem = buildSourceItemReference(entry, sourceArtifact, sourcePath, index);
    orderedSourceItems.push(sourceItem);
    const outputPath = await nextOutputPath(options.runDirectories, options.node, 'audio-' + String(index + 1).padStart(3, '0'), '.' + settings.outputFormat);
    const command = buildAudioNormalizeCommandArgs(sourcePath, outputPath, settings);
    const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true });
    if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
      const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
      throw new Error(operationLabel + ' could not normalize audio item ' + String(index + 1) + '. ' + (failureLine || 'Try a different audio file or regenerate the source item.'));
    }

    const artifact = await buildFileArtifact(outputPath, {
      displayName: String(options.displayName || options.node?.label || 'Normalized audio').trim() + ' ' + String(index + 1),
      kind: PORT_KIND_AUDIO,
      role: 'generated',
    });
    artifact.audioNormalization = {
      backend: 'ffmpeg',
      backendLabel: 'Bundled ffmpeg',
      channelCount: settings.channelCount,
      channels: settings.channels,
      codec: settings.pcmFormat,
      createdBy: buildCreatedBy(options.node, 'normalizeAudioCollection'),
      durationSeconds: artifact.audio?.durationSeconds || null,
      ffmpegMode: command.mode,
      operation: 'normalizeAudioCollection',
      operationId: 'normalizeAudioCollection',
      outputFormat: settings.outputFormat,
      sampleRate: settings.sampleRate,
      sourceAudio: buildAudioReference(sourceArtifact),
      sourceCollection: collectionRef,
      sourceItem,
    };
    artifact.summary = summarizeArtifact(artifact);
    const metadataPaths = await saveAudioArtifactMetadata(outputPath, artifact);
    if (metadataPaths.length) artifact.metadataPaths = metadataPaths;

    normalizedItems.push({
      artifact,
      index,
      itemId: String(entry.itemId || 'normalized-audio-' + String(index + 1)).trim(),
      lineage: {
        parentLineage: entry.lineage || null,
        sourceItemId: String(entry.itemId || '').trim(),
        sourceItemIndex: Number(entry.index || index) || index,
        sourceNodeId: String(options.node?.id || '').trim(),
        sourceNodeLabel: String(options.node?.label || operationLabel).trim(),
        sourcePortId: 'collection',
        sourcePortLabel: 'Normalized Audio Collection',
      },
      metadata: {
        normalization: artifact.audioNormalization,
        sourceItem,
      },
    });
  }

  const collection = createArtifactCollection(normalizedItems, {
    collectionNormalization: {
      createdBy: buildCreatedBy(options.node, 'normalizeAudioCollection'),
      itemCount: normalizedItems.length,
      operation: 'normalizeAudioCollection',
      operationId: 'normalizeAudioCollection',
      orderedSourceItems,
      outputFormat: settings.outputFormat,
      sampleRate: settings.sampleRate,
      channels: settings.channels,
      channelCount: settings.channelCount,
      codec: settings.pcmFormat,
      sourceCollection: collectionRef,
      targetSettings: settings,
    },
    collectionStatus: 'complete',
    displayName: String(options.displayName || options.node?.label || 'Normalized audio collection').trim() || 'Normalized audio collection',
    itemKind: PORT_KIND_AUDIO,
    role: 'generated',
    sourceCollection: collectionRef,
    sourceItemCount: orderedEntries.length,
  });
  const persisted = await persistArtifactCollection(options.runDirectories, collection, {
    baseName: String(options.node?.label || 'Normalize Audio Collection').trim() || 'Normalize Audio Collection',
    displayName: collection.displayName,
    role: 'generated',
    target: 'artifacts',
  });

  return {
    destinationPath: persisted.directoryPath,
    message: operationLabel + ' converted ' + normalizedItems.length + ' audio item' + (normalizedItems.length === 1 ? '' : 's') + ' into a normalized audio collection.',
    outputs: { collection: persisted },
    preview: summarizeArtifact(persisted),
  };
}

function parseSizeValue(value) {
  const match = String(value || '').match(/(\d{2,5})\s*x\s*(\d{2,5})/i);
  if (!match) return null;
  return { width: Number(match[1]) || 0, height: Number(match[2]) || 0 };
}

function roundEven(value, fallback) {
  const number = Math.max(2, Math.round(Number(value || fallback || 0) || fallback || 0));
  return number % 2 === 0 ? number : number - 1;
}

function getArtifactVideoMetric(artifact, key) {
  const direct = Number(artifact?.[key] || 0) || 0;
  if (direct > 0) return direct;
  const normalized = Number(artifact?.videoNormalization?.[key] || 0) || 0;
  if (normalized > 0) return normalized;
  if ((key === 'width' || key === 'height') && artifact?.videoGeneration?.size) {
    const size = parseSizeValue(artifact.videoGeneration.size);
    if (size?.[key]) return size[key];
  }
  if ((key === 'width' || key === 'height') && artifact?.size) {
    const size = parseSizeValue(artifact.size);
    if (size?.[key]) return size[key];
  }
  return 0;
}

async function probeVideoFile(sourcePath) {
  const result = await runCommand(resolveFfmpegPath(), ['-hide_banner', '-i', sourcePath], { allowFailure: true });
  const text = String(result.stderr || '') + '\n' + String(result.stdout || '');
  const videoLine = text.split(/\r?\n/).find((line) => /Video:/i.test(line)) || '';
  const sizeMatch = videoLine.match(/(\d{2,5})x(\d{2,5})/);
  const fpsMatch = videoLine.match(/,\s*([0-9.]+)\s*fps/i);
  return {
    audioPresent: /Audio:/i.test(text),
    fps: fpsMatch ? Number(fpsMatch[1]) || 0 : 0,
    height: sizeMatch ? Number(sizeMatch[2]) || 0 : 0,
    width: sizeMatch ? Number(sizeMatch[1]) || 0 : 0,
  };
}

async function normalizeVideoSettings(sourceArtifact, sourcePath, options = {}) {
  const outputFormat = normalizeVideoOutputFormat(options.outputFormat, 'Normalize Video Collection');
  const sizeMode = String(options.sizeMode || 'matchFirst').trim() === 'custom' ? 'custom' : 'matchFirst';
  const probe = await probeVideoFile(sourcePath);
  const width = sizeMode === 'custom'
    ? roundEven(options.width, 1280)
    : roundEven(getArtifactVideoMetric(sourceArtifact, 'width') || probe.width || options.width || 1280, 1280);
  const height = sizeMode === 'custom'
    ? roundEven(options.height, 720)
    : roundEven(getArtifactVideoMetric(sourceArtifact, 'height') || probe.height || options.height || 720, 720);
  const fps = Math.max(1, Number(options.fps || getArtifactVideoMetric(sourceArtifact, 'fps') || probe.fps || 30) || 30);
  return {
    audioCodec: String(options.audioCodec || 'aac').trim() || 'aac',
    outputFormat,
    pixelFormat: String(options.pixelFormat || 'yuv420p').trim() || 'yuv420p',
    videoCodec: String(options.videoCodec || 'libx264').trim() || 'libx264',
    fps: Math.round(fps * 1000) / 1000,
    height,
    sizeMode,
    width,
  };
}

function buildVideoNormalizeCommandArgs(sourcePath, outputPath, settings) {
  const filter = 'scale=' + settings.width + ':' + settings.height + ':force_original_aspect_ratio=decrease,pad=' + settings.width + ':' + settings.height + ':(ow-iw)/2:(oh-ih)/2:black,fps=' + settings.fps + ',format=' + settings.pixelFormat;
  return {
    args: [
      '-y',
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', filter,
      '-c:v', settings.videoCodec,
      '-preset', 'veryfast',
      '-crf', '20',
      '-c:a', settings.audioCodec,
      '-movflags', '+faststart',
      outputPath,
    ],
    mode: 'video-collection-to-normalized-mp4',
  };
}

async function normalizeVideoCollectionArtifact(sourceCollection, options = {}) {
  const operationLabel = 'Normalize Video Collection';
  const orderedEntries = ensureCollection(sourceCollection, PORT_KIND_VIDEO, operationLabel);
  const collectionRef = buildCollectionReference(sourceCollection);
  const firstSourcePath = await resolveSourceVideoPath(orderedEntries[0].artifact, operationLabel);
  const settings = await normalizeVideoSettings(orderedEntries[0].artifact, firstSourcePath, options);
  const ffmpegPath = resolveFfmpegPath();
  const normalizedItems = [];
  const orderedSourceItems = [];

  options.reportProgress?.(
    'Normalizing video collection.',
    'Converting ' + orderedEntries.length + ' video item' + (orderedEntries.length === 1 ? '' : 's') + ' to matching MP4 settings...',
  );

  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    const sourceArtifact = entry.artifact;
    const sourcePath = index === 0 ? firstSourcePath : await resolveSourceVideoPath(sourceArtifact, operationLabel);
    const sourceItem = buildSourceItemReference(entry, sourceArtifact, sourcePath, index);
    orderedSourceItems.push(sourceItem);
    const sourceProbe = await probeVideoFile(sourcePath);
    const outputPath = await nextOutputPath(options.runDirectories, options.node, 'video-' + String(index + 1).padStart(3, '0'), '.' + settings.outputFormat);
    const command = buildVideoNormalizeCommandArgs(sourcePath, outputPath, settings);
    const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true });
    if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
      const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
      throw new Error(operationLabel + ' could not normalize video item ' + String(index + 1) + '. ' + (failureLine || 'Try a different video file or regenerate the source item.'));
    }

    const videoNormalization = {
      audioCodec: settings.audioCodec,
      audioHandling: sourceProbe.audioPresent ? 'reencoded-aac' : 'none',
      backend: 'ffmpeg',
      backendLabel: 'Bundled ffmpeg',
      container: settings.outputFormat,
      createdBy: buildCreatedBy(options.node, 'normalizeVideoCollection'),
      ffmpegMode: command.mode,
      fps: settings.fps,
      height: settings.height,
      operation: 'normalizeVideoCollection',
      operationId: 'normalizeVideoCollection',
      outputFormat: settings.outputFormat,
      pixelFormat: settings.pixelFormat,
      sourceCollection: collectionRef,
      sourceItem,
      sourceVideo: buildVideoReference(sourceArtifact),
      videoCodec: settings.videoCodec,
      width: settings.width,
    };
    const artifact = await buildFileArtifact(outputPath, {
      displayName: String(options.displayName || options.node?.label || 'Normalized video').trim() + ' ' + String(index + 1),
      kind: PORT_KIND_VIDEO,
      role: 'generated',
      videoNormalization,
    });
    artifact.videoNormalization = videoNormalization;
    artifact.width = settings.width;
    artifact.height = settings.height;
    artifact.fps = settings.fps;
    artifact.size = String(settings.width) + 'x' + String(settings.height);
    artifact.summary = summarizeArtifact(artifact);
    const metadataPaths = await saveVideoArtifactMetadata(outputPath, artifact);
    if (metadataPaths.length) artifact.metadataPaths = metadataPaths;

    normalizedItems.push({
      artifact,
      index,
      itemId: String(entry.itemId || 'normalized-video-' + String(index + 1)).trim(),
      lineage: {
        parentLineage: entry.lineage || null,
        sourceItemId: String(entry.itemId || '').trim(),
        sourceItemIndex: Number(entry.index || index) || index,
        sourceNodeId: String(options.node?.id || '').trim(),
        sourceNodeLabel: String(options.node?.label || operationLabel).trim(),
        sourcePortId: 'collection',
        sourcePortLabel: 'Normalized Video Collection',
      },
      metadata: {
        normalization: videoNormalization,
        sourceItem,
      },
    });
  }

  const collection = createArtifactCollection(normalizedItems, {
    collectionNormalization: {
      audioCodec: settings.audioCodec,
      createdBy: buildCreatedBy(options.node, 'normalizeVideoCollection'),
      fps: settings.fps,
      height: settings.height,
      itemCount: normalizedItems.length,
      operation: 'normalizeVideoCollection',
      operationId: 'normalizeVideoCollection',
      orderedSourceItems,
      outputFormat: settings.outputFormat,
      pixelFormat: settings.pixelFormat,
      sourceCollection: collectionRef,
      targetSettings: settings,
      videoCodec: settings.videoCodec,
      width: settings.width,
    },
    collectionStatus: 'complete',
    displayName: String(options.displayName || options.node?.label || 'Normalized video collection').trim() || 'Normalized video collection',
    itemKind: PORT_KIND_VIDEO,
    role: 'generated',
    sourceCollection: collectionRef,
    sourceItemCount: orderedEntries.length,
  });
  const persisted = await persistArtifactCollection(options.runDirectories, collection, {
    baseName: String(options.node?.label || 'Normalize Video Collection').trim() || 'Normalize Video Collection',
    displayName: collection.displayName,
    role: 'generated',
    target: 'artifacts',
  });

  return {
    destinationPath: persisted.directoryPath,
    message: operationLabel + ' converted ' + normalizedItems.length + ' video item' + (normalizedItems.length === 1 ? '' : 's') + ' into a normalized video collection.',
    outputs: { collection: persisted },
    preview: summarizeArtifact(persisted),
  };
}


function normalizeTrimSettings(options = {}) {
  const mode = String(options.mode || 'duration').trim() === 'end' ? 'end' : 'duration';
  const startSeconds = Math.max(0, Number(options.startSeconds || 0) || 0);
  const rawDuration = Number(options.durationSeconds || 0) || 0;
  const rawEnd = Number(options.endSeconds || 0) || 0;
  const durationSeconds = mode === 'end' ? rawEnd - startSeconds : rawDuration;
  const endSeconds = startSeconds + durationSeconds;
  if (startSeconds < 0) {
    throw new Error('Trim Media start seconds cannot be negative.');
  }
  if (!(durationSeconds > 0)) {
    throw new Error(mode === 'end' ? 'Trim Media end seconds must be greater than start seconds.' : 'Trim Media needs a positive duration.');
  }
  return {
    durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    endSeconds: Math.round(endSeconds * 1000) / 1000,
    mode,
    startSeconds: Math.round(startSeconds * 1000) / 1000,
  };
}

async function resolveSourceMediaPath(mediaArtifact, operationLabel) {
  const kind = String(mediaArtifact?.kind || '').trim();
  if (kind !== PORT_KIND_AUDIO && kind !== PORT_KIND_VIDEO) {
    throw new Error(operationLabel + ' needs an audio or video input before it can run.');
  }
  const rawPath = String(mediaArtifact?.filePath || '').trim();
  if (!rawPath) {
    throw new Error(operationLabel + ' needs a media file path, but the connected artifact does not have one.');
  }
  const sourcePath = path.resolve(rawPath);
  if (!(await fs.pathExists(sourcePath))) {
    throw new Error(operationLabel + ' could not find the connected media file on disk. Regenerate it or choose the file again, then rerun the pipeline.');
  }
  return sourcePath;
}

function buildTrimCommandArgs(sourcePath, outputPath, kind, settings) {
  if (kind === PORT_KIND_AUDIO) {
    return {
      args: ['-y', '-ss', String(settings.startSeconds), '-i', sourcePath, '-t', String(settings.durationSeconds), '-vn', '-c:a', 'pcm_s16le', outputPath],
      mode: 'reencode-audio-pcm-wav',
    };
  }
  return {
    args: [
      '-y', '-ss', String(settings.startSeconds), '-i', sourcePath, '-t', String(settings.durationSeconds),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', outputPath,
    ],
    mode: 'reencode-video-mp4',
  };
}

async function trimMediaArtifact(mediaArtifact, options = {}) {
  const operationLabel = 'Trim Media';
  const kind = String(mediaArtifact?.kind || '').trim();
  const sourcePath = await resolveSourceMediaPath(mediaArtifact, operationLabel);
  const settings = normalizeTrimSettings(options);
  const outputFormat = kind === PORT_KIND_AUDIO ? 'wav' : 'mp4';
  const outputPath = await nextOutputPath(options.runDirectories, options.node, 'trimmed', '.' + outputFormat);
  options.reportProgress?.('Trimming media.', 'Saving a trimmed ' + kind + ' artifact with the bundled ffmpeg runtime...');
  const ffmpegPath = resolveFfmpegPath();
  const command = buildTrimCommandArgs(sourcePath, outputPath, kind, settings);
  const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error('Trim Media could not save the selected time range. ' + (failureLine || 'Check the source file and time range, then try again.'));
  }
  const mediaTrim = {
    backend: 'ffmpeg',
    backendLabel: 'Bundled ffmpeg',
    createdBy: buildCreatedBy(options.node, 'trimMedia'),
    durationSeconds: settings.durationSeconds,
    endSeconds: settings.endSeconds,
    ffmpegMode: command.mode,
    operation: 'trimMedia',
    operationId: 'trimMedia',
    outputFormat,
    outputKind: kind,
    sourceArtifact: buildArtifactReference(mediaArtifact),
    sourceKind: kind,
    startSeconds: settings.startSeconds,
  };
  const artifact = await buildFileArtifact(outputPath, {
    displayName: String(options.displayName || options.node?.label || 'Trimmed media').trim() || 'Trimmed media',
    kind,
    mediaTrim,
    role: 'generated',
  });
  artifact.mediaTrim = mediaTrim;
  artifact.summary = summarizeArtifact(artifact);
  const metadataPaths = kind === PORT_KIND_AUDIO
    ? await saveAudioArtifactMetadata(outputPath, artifact)
    : await saveVideoArtifactMetadata(outputPath, artifact);
  if (metadataPaths.length) artifact.metadataPaths = metadataPaths;
  return {
    destinationPath: outputPath,
    message: 'Trim Media saved a trimmed ' + kind + ' artifact.',
    outputs: { trimmed: artifact },
    preview: summarizeArtifact(artifact),
  };
}

function formatSrtTimestamp(seconds) {
  const safe = Math.max(0, Number(seconds || 0) || 0);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
}

function sanitizeSrtText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function buildSrtContent(captions) {
  return captions.map((caption, index) => {
    return [
      String(index + 1),
      formatSrtTimestamp(caption.startSeconds) + ' --> ' + formatSrtTimestamp(caption.endSeconds),
      sanitizeSrtText(caption.text),
      '',
    ].join('\n');
  }).join('\n');
}

function extractTranscriptSegments(captionArtifact) {
  return (Array.isArray(captionArtifact?.transcription?.segments) ? captionArtifact.transcription.segments : [])
    .map((segment) => ({
      endSeconds: Number(segment?.end),
      startSeconds: Number(segment?.start),
      text: String(segment?.text || '').trim(),
    }))
    .filter((segment) => segment.text && Number.isFinite(segment.startSeconds) && Number.isFinite(segment.endSeconds) && segment.endSeconds > segment.startSeconds);
}

function buildManualLineCaptions(text, durationPerCaptionSeconds) {
  const duration = Math.max(0.1, Number(durationPerCaptionSeconds || 3) || 3);
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      endSeconds: Math.round((index + 1) * duration * 1000) / 1000,
      startSeconds: Math.round(index * duration * 1000) / 1000,
      text: line,
    }));
}

async function nextSubtitlePath(runDirectories, node, suffix = 'captions') {
  return nextOutputPath(runDirectories, node, suffix, '.srt');
}

function escapeSubtitleFilterPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

async function prepareSubtitleSource(captionArtifact, options = {}) {
  const operationLabel = 'Burn Subtitles / Captions';
  const captionMode = String(options.captionMode || 'auto').trim() || 'auto';
  const durationPerCaptionSeconds = Math.max(0.1, Number(options.durationPerCaptionSeconds || 3) || 3);
  const captionKind = String(captionArtifact?.kind || '').trim();
  if (!captionArtifact) {
    throw new Error(operationLabel + ' needs captions, a transcript, or a subtitle file before it can run.');
  }

  if ((captionMode === 'auto' || captionMode === 'transcriptSegments') && captionKind === PORT_KIND_TEXT) {
    const segments = extractTranscriptSegments(captionArtifact);
    if (segments.length) {
      const subtitlePath = await nextSubtitlePath(options.runDirectories, options.node, 'transcript-captions');
      await fs.writeFile(subtitlePath, buildSrtContent(segments), 'utf8');
      return { captionCount: segments.length, mode: 'transcriptSegments', subtitleFormat: 'srt', subtitlePath };
    }
    if (captionMode === 'transcriptSegments') {
      throw new Error(operationLabel + ' was set to transcript segments, but the caption input does not contain timed transcript segments.');
    }
  }

  if ((captionMode === 'auto' || captionMode === 'subtitleFile') && captionKind === PORT_KIND_FILE) {
    const subtitlePath = path.resolve(String(captionArtifact.filePath || '').trim());
    const extension = path.extname(subtitlePath).toLowerCase();
    if (!subtitlePath || !(await fs.pathExists(subtitlePath))) {
      throw new Error(operationLabel + ' could not find the connected subtitle file on disk.');
    }
    if (extension === '.srt' || extension === '.vtt') {
      return { captionCount: 0, mode: 'subtitleFile', subtitleFormat: extension.slice(1), subtitlePath };
    }
    if (captionMode === 'subtitleFile') {
      throw new Error(operationLabel + ' supports .srt and .vtt subtitle files in this pass.');
    }
  }

  if ((captionMode === 'auto' || captionMode === 'manualLines') && captionKind === PORT_KIND_TEXT) {
    const captions = buildManualLineCaptions(captionArtifact.text, durationPerCaptionSeconds);
    if (!captions.length) {
      throw new Error(operationLabel + ' needs at least one non-empty caption line.');
    }
    const subtitlePath = await nextSubtitlePath(options.runDirectories, options.node, 'manual-captions');
    await fs.writeFile(subtitlePath, buildSrtContent(captions), 'utf8');
    return { captionCount: captions.length, mode: 'manualLines', subtitleFormat: 'srt', subtitlePath };
  }

  throw new Error(operationLabel + ' could not turn the caption input into timed subtitles. Use Whisper transcript segments, a text artifact with caption lines, or an .srt/.vtt file.');
}

function buildBurnSubtitlesCommandArgs(sourcePath, subtitlePath, outputPath) {
  const filter = "subtitles='" + escapeSubtitleFilterPath(subtitlePath) + "'";
  return {
    args: [
      '-y', '-i', sourcePath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', filter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', outputPath,
    ],
    mode: 'burn-subtitles-filter',
  };
}

async function burnSubtitlesIntoVideoArtifact(videoArtifact, captionArtifact, options = {}) {
  const operationLabel = 'Burn Subtitles / Captions';
  const outputFormat = normalizeVideoOutputFormat(options.outputFormat, operationLabel);
  const sourcePath = await resolveSourceVideoPath(videoArtifact, operationLabel);
  const subtitleSource = await prepareSubtitleSource(captionArtifact, options);
  const outputPath = await nextOutputPath(options.runDirectories, options.node, 'captioned', '.' + outputFormat);
  options.reportProgress?.('Burning captions.', 'Rendering timed captions directly into the video with the bundled ffmpeg runtime...');
  const ffmpegPath = resolveFfmpegPath();
  const command = buildBurnSubtitlesCommandArgs(sourcePath, subtitleSource.subtitlePath, outputPath);
  const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error(operationLabel + ' could not render captions into this video. ' + (failureLine || 'Check the video and caption timing input, then try again.'));
  }
  const subtitleBurn = {
    backend: 'ffmpeg',
    backendLabel: 'Bundled ffmpeg',
    captionCount: subtitleSource.captionCount,
    captionMode: subtitleSource.mode,
    captionSource: buildArtifactReference(captionArtifact),
    createdBy: buildCreatedBy(options.node, 'burnSubtitles'),
    durationPerCaptionSeconds: subtitleSource.mode === 'manualLines' ? Math.max(0.1, Number(options.durationPerCaptionSeconds || 3) || 3) : null,
    ffmpegMode: command.mode,
    generatedSubtitleFormat: subtitleSource.subtitleFormat,
    generatedSubtitlePath: subtitleSource.subtitlePath,
    operation: 'burnSubtitles',
    operationId: 'burnSubtitles',
    outputFormat,
    position: 'bottom',
    sourceVideo: buildVideoReference(videoArtifact),
  };
  const artifact = await buildFileArtifact(outputPath, {
    displayName: String(options.displayName || options.node?.label || 'Captioned video').trim() || 'Captioned video',
    kind: PORT_KIND_VIDEO,
    role: 'generated',
    subtitleBurn,
  });
  artifact.subtitleBurn = subtitleBurn;
  artifact.summary = summarizeArtifact(artifact);
  const metadataPaths = await saveVideoArtifactMetadata(outputPath, artifact);
  if (metadataPaths.length) artifact.metadataPaths = metadataPaths;
  return {
    destinationPath: outputPath,
    message: operationLabel + ' rendered captions into an MP4 video.',
    outputs: { video: artifact },
    preview: summarizeArtifact(artifact),
  };
}

module.exports = {
  extractAudioFromVideoArtifact,
  extractVideoFrameArtifact,
  normalizeAudioCollectionArtifact,
  normalizeVideoCollectionArtifact,
  trimMediaArtifact,
  burnSubtitlesIntoVideoArtifact,
  _test: {
    buildAudioCommandArgs,
    buildAudioNormalizeCommandArgs,
    buildFrameCommandArgs,
    buildVideoNormalizeCommandArgs,
    buildTrimCommandArgs,
    buildBurnSubtitlesCommandArgs,
    buildSrtContent,
    prepareSubtitleSource,
    normalizeFramePosition,
  },
};
