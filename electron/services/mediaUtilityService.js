const path = require('path');
const fs = require('fs-extra');

const { runCommand } = require('./commandService');
const { resolveAssetLibraryFontForUse, resolveColorPaletteItemForUse } = require('./assetLibraryService');
const { resolveFfmpegPath } = require('./mediaCompositionService');
const {
  buildFileArtifact,
  createArtifactCollection,
  persistArtifactCollection,
  saveAudioArtifactMetadata,
  saveImageArtifactMetadata,
  saveSubtitleExportArtifactMetadata,
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
  if (normalized === 'first' || normalized === 'last' || normalized === 'timestamp') {
    return normalized;
  }
  throw new Error('Extract Video Frame can extract the first frame, last frame, or a frame at a timestamp.');
}

function normalizeTimestampSeconds(value) {
  const timestampSeconds = Number(value || 0) || 0;
  if (timestampSeconds < 0) {
    throw new Error('Timestamp frame extraction needs a timestamp of zero seconds or later.');
  }
  return Math.round(timestampSeconds * 1000) / 1000;
}

const AUDIO_OUTPUT_FORMATS = Object.freeze(['wav', 'mp3', 'flac', 'ogg', 'm4a']);
const VIDEO_OUTPUT_FORMATS = Object.freeze(['mp4', 'webm', 'mov', 'mkv']);
const IMAGE_OUTPUT_FORMATS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'bmp']);

function normalizeMediaOutputFormat(value, defaultFormat, supportedFormats, operationLabel, mediaLabel) {
  const normalized = String(value || 'auto').trim().toLowerCase();
  if (!normalized || normalized === 'auto' || normalized === 'normalized') {
    return defaultFormat;
  }
  if (normalized === 'jpeg' && supportedFormats.includes('jpg')) {
    return 'jpg';
  }
  if (supportedFormats.includes(normalized)) {
    return normalized;
  }
  throw new Error(operationLabel + ' supports these ' + mediaLabel + ' output formats: auto, ' + supportedFormats.join(', ') + '.');
}

function normalizeImageOutputFormat(value, operationLabel = 'Extract Video Frame') {
  return normalizeMediaOutputFormat(value, 'png', IMAGE_OUTPUT_FORMATS, operationLabel, 'image');
}

function normalizeAudioOutputFormat(value, operationLabel = 'Extract Audio') {
  return normalizeMediaOutputFormat(value, 'wav', AUDIO_OUTPUT_FORMATS, operationLabel, 'audio');
}

function normalizeVideoOutputFormat(value, operationLabel = 'Normalize Video') {
  return normalizeMediaOutputFormat(value, 'mp4', VIDEO_OUTPUT_FORMATS, operationLabel, 'video');
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
    throw new Error(operationLabel + ' needs an audio file path, but the connected audio artifact does not have one.');
  }

  const sourcePath = path.resolve(rawPath);
  if (!(await fs.pathExists(sourcePath))) {
    throw new Error(operationLabel + ' could not find an audio file from the connected input. Regenerate that item or choose the file again, then rerun the pipeline.');
  }

  return sourcePath;
}

async function resolveSourceImagePath(imageArtifact, operationLabel) {
  if (String(imageArtifact?.kind || '').trim() !== PORT_KIND_IMAGE) {
    throw new Error(operationLabel + ' needs an image input before it can run.');
  }

  const rawPath = String(imageArtifact?.filePath || '').trim();
  if (!rawPath) {
    throw new Error(operationLabel + ' needs an image file path, but the connected image artifact does not have one.');
  }

  const sourcePath = path.resolve(rawPath);
  if (!(await fs.pathExists(sourcePath))) {
    throw new Error(operationLabel + ' could not find an image file from the connected input. Regenerate that item or choose the file again, then rerun the pipeline.');
  }

  return sourcePath;
}

function throwIfCancelled(options = {}, operationLabel = 'Media conversion') {
  if (options.cancelSignal?.aborted || options.signal?.aborted) {
    throw new Error(operationLabel + ' was cancelled.');
  }
}

function getCancelSignal(options = {}) {
  return options.cancelSignal || options.signal || null;
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

function buildFrameCommandArgs(sourcePath, outputPath, framePosition, timestampSeconds = 0) {
  if (framePosition === 'last') {
    return {
      args: ['-y', '-i', sourcePath, '-map', '0:v:0', '-vf', 'reverse', '-frames:v', '1', '-update', '1', outputPath],
      mode: 'reverse-filter-last-frame',
      timestampSeconds: null,
    };
  }

  if (framePosition === 'timestamp') {
    const normalizedTimestamp = normalizeTimestampSeconds(timestampSeconds);
    return {
      args: ['-y', '-ss', String(normalizedTimestamp), '-i', sourcePath, '-map', '0:v:0', '-frames:v', '1', '-update', '1', outputPath],
      mode: 'input-seek-timestamp-frame',
      timestampSeconds: normalizedTimestamp,
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
  const timestampSeconds = framePosition === 'timestamp' ? normalizeTimestampSeconds(options.timestampSeconds) : null;
  const outputPath = await nextOutputPath(options.runDirectories, options.node, framePosition + '-frame', '.' + outputFormat);

  options.reportProgress?.(
    'Extracting video frame.',
    framePosition === 'timestamp'
      ? 'Saving the frame at ' + timestampSeconds + ' seconds as a PNG image with the bundled ffmpeg runtime...'
      : 'Saving the ' + framePosition + ' frame as a PNG image with the bundled ffmpeg runtime...',
  );

  const ffmpegPath = resolveFfmpegPath();
  const command = buildFrameCommandArgs(sourcePath, outputPath, framePosition, timestampSeconds);
  const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true, signal: getCancelSignal(options), abortMessage: operationLabel + ' was cancelled.' });
  const outputExists = await fs.pathExists(outputPath);
  const outputSize = outputExists ? Number((await fs.stat(outputPath)).size || 0) : 0;
  if (Number(commandResult.code || 0) !== 0 || !outputExists || outputSize <= 0) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    if (framePosition === 'timestamp' && (!outputExists || outputSize <= 0)) {
      throw new Error('No frame was found at the requested timestamp. Choose a timestamp inside the video duration and try again.');
    }
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
    message: framePosition === 'timestamp'
      ? 'Extract Video Frame saved the frame at ' + command.timestampSeconds + ' seconds as a PNG image.'
      : 'Extract Video Frame saved the ' + framePosition + ' frame as a PNG image.',
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
  const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true, signal: getCancelSignal(options), abortMessage: operationLabel + ' was cancelled.' });
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

function getAudioCodecForFormat(outputFormat, settings) {
  if (outputFormat === 'mp3') return 'libmp3lame';
  if (outputFormat === 'flac') return 'flac';
  if (outputFormat === 'ogg') return 'libvorbis';
  if (outputFormat === 'm4a') return 'aac';
  return String(settings.pcmFormat || 'pcm_s16le').trim() || 'pcm_s16le';
}

function normalizeAudioSettings(options = {}) {
  const outputFormat = normalizeAudioOutputFormat(options.outputFormat, 'Normalize Audio');
  const sampleRate = Math.max(1, Math.round(Number(options.sampleRate || 44100) || 44100));
  const channels = String(options.channels || 'stereo').trim().toLowerCase() === 'mono' ? 'mono' : 'stereo';
  const settings = {
    channelCount: channels === 'mono' ? 1 : 2,
    channels,
    outputFormat,
    pcmFormat: String(options.pcmFormat || 'pcm_s16le').trim() || 'pcm_s16le',
    sampleRate,
  };
  settings.codec = getAudioCodecForFormat(outputFormat, settings);
  return settings;
}

function buildAudioNormalizeCommandArgs(sourcePath, outputPath, settings) {
  return {
    args: ['-y', '-i', sourcePath, '-vn', '-ac', String(settings.channelCount), '-ar', String(settings.sampleRate), '-c:a', settings.codec, outputPath],
    mode: 'audio-to-normalized-' + settings.outputFormat,
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

async function normalizeSingleAudioArtifact(audioArtifact, options = {}) {
  const operationLabel = 'Normalize Audio';
  const settings = normalizeAudioSettings(options);
  const sourcePath = await resolveSourceAudioPath(audioArtifact, operationLabel);
  const outputPath = await nextOutputPath(options.runDirectories, options.node, 'audio', '.' + settings.outputFormat);

  options.reportProgress?.(
    'Normalizing audio.',
    'Converting audio to ' + settings.outputFormat.toUpperCase() + ' with the bundled ffmpeg runtime...',
  );

  throwIfCancelled(options, operationLabel);
  const ffmpegPath = resolveFfmpegPath();
  const command = buildAudioNormalizeCommandArgs(sourcePath, outputPath, settings);
  const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true, signal: getCancelSignal(options), abortMessage: operationLabel + ' was cancelled.' });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error(operationLabel + ' could not normalize this audio file. ' + (failureLine || 'Try a different audio file or regenerate the source item.'));
  }

  const artifact = await buildFileArtifact(outputPath, {
    displayName: String(options.displayName || options.node?.label || 'Normalized audio').trim() || 'Normalized audio',
    kind: PORT_KIND_AUDIO,
    role: 'generated',
  });
  artifact.audioNormalization = {
    backend: 'ffmpeg',
    backendLabel: 'Bundled ffmpeg',
    channelCount: settings.channelCount,
    channels: settings.channels,
    codec: settings.codec,
    createdBy: buildCreatedBy(options.node, 'normalizeAudioCollection'),
    durationSeconds: artifact.audio?.durationSeconds || null,
    ffmpegMode: command.mode,
    operation: 'normalizeAudioCollection',
    operationId: 'normalizeAudioCollection',
    outputFormat: settings.outputFormat,
    sampleRate: settings.sampleRate,
    sourceAudio: buildAudioReference(audioArtifact),
  };
  artifact.summary = summarizeArtifact(artifact);
  const metadataPaths = await saveAudioArtifactMetadata(outputPath, artifact);
  if (metadataPaths.length) artifact.metadataPaths = metadataPaths;

  return {
    destinationPath: outputPath,
    message: operationLabel + ' saved a ' + settings.outputFormat.toUpperCase() + ' audio artifact.',
    outputs: { collection: artifact },
    preview: summarizeArtifact(artifact),
  };
}

async function normalizeAudioCollectionArtifact(sourceCollection, options = {}) {
  if (String(sourceCollection?.kind || '').trim() === PORT_KIND_AUDIO) {
    return normalizeSingleAudioArtifact(sourceCollection, options);
  }
  const operationLabel = 'Normalize Audio';
  const settings = normalizeAudioSettings(options);
  const orderedEntries = ensureCollection(sourceCollection, PORT_KIND_AUDIO, operationLabel);
  const collectionRef = buildCollectionReference(sourceCollection);
  const ffmpegPath = resolveFfmpegPath();
  const normalizedItems = [];
  const orderedSourceItems = [];

  options.reportProgress?.(
    'Normalizing audio collection.',
    'Converting ' + orderedEntries.length + ' audio item' + (orderedEntries.length === 1 ? '' : 's') + ' to matching ' + settings.outputFormat.toUpperCase() + ' settings...',
  );

  for (let index = 0; index < orderedEntries.length; index += 1) {
    throwIfCancelled(options, operationLabel);
    const entry = orderedEntries[index];
    const sourceArtifact = entry.artifact;
    const sourcePath = await resolveSourceAudioPath(sourceArtifact, operationLabel);
    const sourceItem = buildSourceItemReference(entry, sourceArtifact, sourcePath, index);
    orderedSourceItems.push(sourceItem);
    const outputPath = await nextOutputPath(options.runDirectories, options.node, 'audio-' + String(index + 1).padStart(3, '0'), '.' + settings.outputFormat);
    const command = buildAudioNormalizeCommandArgs(sourcePath, outputPath, settings);
    const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true, signal: getCancelSignal(options), abortMessage: operationLabel + ' was cancelled.' });
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
      codec: settings.codec,
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
      codec: settings.codec,
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
  const durationMatch = text.match(/Duration:\s*(\d+):(\d+):([0-9.]+)/i);
  const durationSeconds = durationMatch
    ? (Number(durationMatch[1]) * 3600) + (Number(durationMatch[2]) * 60) + Number(durationMatch[3])
    : 0;
  return {
    audioPresent: /Audio:/i.test(text),
    durationSeconds: Math.round(Math.max(0, durationSeconds) * 1000) / 1000,
    fps: fpsMatch ? Number(fpsMatch[1]) || 0 : 0,
    height: sizeMatch ? Number(sizeMatch[2]) || 0 : 0,
    width: sizeMatch ? Number(sizeMatch[1]) || 0 : 0,
  };
}

function getVideoDefaultsForFormat(outputFormat) {
  if (outputFormat === 'webm') {
    return { audioCodec: 'libopus', pixelFormat: 'yuv420p', videoCodec: 'libvpx-vp9' };
  }
  return { audioCodec: 'aac', pixelFormat: 'yuv420p', videoCodec: 'libx264' };
}

async function normalizeVideoSettings(sourceArtifact, sourcePath, options = {}) {
  const outputFormat = normalizeVideoOutputFormat(options.outputFormat, 'Normalize Video');
  const sizeMode = String(options.sizeMode || 'matchFirst').trim() === 'custom' ? 'custom' : 'matchFirst';
  const probe = await probeVideoFile(sourcePath);
  const width = sizeMode === 'custom'
    ? roundEven(options.width, 1280)
    : roundEven(getArtifactVideoMetric(sourceArtifact, 'width') || probe.width || options.width || 1280, 1280);
  const height = sizeMode === 'custom'
    ? roundEven(options.height, 720)
    : roundEven(getArtifactVideoMetric(sourceArtifact, 'height') || probe.height || options.height || 720, 720);
  const fps = Math.max(1, Number(options.fps || getArtifactVideoMetric(sourceArtifact, 'fps') || probe.fps || 30) || 30);
  const formatDefaults = getVideoDefaultsForFormat(outputFormat);
  return {
    audioCodec: formatDefaults.audioCodec,
    outputFormat,
    pixelFormat: formatDefaults.pixelFormat,
    videoCodec: formatDefaults.videoCodec,
    fps: Math.round(fps * 1000) / 1000,
    height,
    sizeMode,
    width,
  };
}

function buildVideoNormalizeCommandArgs(sourcePath, outputPath, settings) {
  const filter = 'scale=' + settings.width + ':' + settings.height + ':force_original_aspect_ratio=decrease,pad=' + settings.width + ':' + settings.height + ':(ow-iw)/2:(oh-ih)/2:black,fps=' + settings.fps + ',format=' + settings.pixelFormat;
  const args = [
    '-y',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', filter,
    '-c:v', settings.videoCodec,
  ];
  if (settings.videoCodec === 'libx264') {
    args.push('-preset', 'veryfast', '-crf', '20');
  } else if (settings.videoCodec === 'libvpx-vp9') {
    args.push('-deadline', 'realtime', '-cpu-used', '4', '-b:v', '0', '-crf', '32');
  }
  args.push('-c:a', settings.audioCodec);
  if (settings.outputFormat === 'mp4' || settings.outputFormat === 'mov') {
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  return {
    args,
    mode: 'video-to-normalized-' + settings.outputFormat,
  };
}

async function normalizeSingleVideoArtifact(videoArtifact, options = {}) {
  const operationLabel = 'Normalize Video';
  const sourcePath = await resolveSourceVideoPath(videoArtifact, operationLabel);
  const settings = await normalizeVideoSettings(videoArtifact, sourcePath, options);
  const sourceProbe = await probeVideoFile(sourcePath);
  const outputPath = await nextOutputPath(options.runDirectories, options.node, 'video', '.' + settings.outputFormat);

  options.reportProgress?.(
    'Normalizing video.',
    'Converting video to ' + settings.outputFormat.toUpperCase() + ' with the bundled ffmpeg runtime...',
  );

  throwIfCancelled(options, operationLabel);
  const ffmpegPath = resolveFfmpegPath();
  const command = buildVideoNormalizeCommandArgs(sourcePath, outputPath, settings);
  const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true, signal: getCancelSignal(options), abortMessage: operationLabel + ' was cancelled.' });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error(operationLabel + ' could not normalize this video file. ' + (failureLine || 'Try a different video file or regenerate the source item.'));
  }

  const videoNormalization = {
    audioCodec: settings.audioCodec,
    audioHandling: sourceProbe.audioPresent ? 'reencoded-' + settings.audioCodec : 'none',
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
    sourceVideo: buildVideoReference(videoArtifact),
    videoCodec: settings.videoCodec,
    width: settings.width,
  };
  const artifact = await buildFileArtifact(outputPath, {
    displayName: String(options.displayName || options.node?.label || 'Normalized video').trim() || 'Normalized video',
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

  return {
    destinationPath: outputPath,
    message: operationLabel + ' saved a ' + settings.outputFormat.toUpperCase() + ' video artifact.',
    outputs: { collection: artifact },
    preview: summarizeArtifact(artifact),
  };
}

async function normalizeVideoCollectionArtifact(sourceCollection, options = {}) {
  if (String(sourceCollection?.kind || '').trim() === PORT_KIND_VIDEO) {
    return normalizeSingleVideoArtifact(sourceCollection, options);
  }
  const operationLabel = 'Normalize Video';
  const orderedEntries = ensureCollection(sourceCollection, PORT_KIND_VIDEO, operationLabel);
  const collectionRef = buildCollectionReference(sourceCollection);
  const firstSourcePath = await resolveSourceVideoPath(orderedEntries[0].artifact, operationLabel);
  const settings = await normalizeVideoSettings(orderedEntries[0].artifact, firstSourcePath, options);
  const ffmpegPath = resolveFfmpegPath();
  const normalizedItems = [];
  const orderedSourceItems = [];

  options.reportProgress?.(
    'Normalizing video collection.',
    'Converting ' + orderedEntries.length + ' video item' + (orderedEntries.length === 1 ? '' : 's') + ' to matching ' + settings.outputFormat.toUpperCase() + ' settings...',
  );

  for (let index = 0; index < orderedEntries.length; index += 1) {
    throwIfCancelled(options, operationLabel);
    const entry = orderedEntries[index];
    const sourceArtifact = entry.artifact;
    const sourcePath = index === 0 ? firstSourcePath : await resolveSourceVideoPath(sourceArtifact, operationLabel);
    const sourceItem = buildSourceItemReference(entry, sourceArtifact, sourcePath, index);
    orderedSourceItems.push(sourceItem);
    const sourceProbe = await probeVideoFile(sourcePath);
    const outputPath = await nextOutputPath(options.runDirectories, options.node, 'video-' + String(index + 1).padStart(3, '0'), '.' + settings.outputFormat);
    const command = buildVideoNormalizeCommandArgs(sourcePath, outputPath, settings);
    const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true, signal: getCancelSignal(options), abortMessage: operationLabel + ' was cancelled.' });
    if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
      const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
      throw new Error(operationLabel + ' could not normalize video item ' + String(index + 1) + '. ' + (failureLine || 'Try a different video file or regenerate the source item.'));
    }

    const videoNormalization = {
      audioCodec: settings.audioCodec,
      audioHandling: sourceProbe.audioPresent ? 'reencoded-' + settings.audioCodec : 'none',
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


function buildImageNormalizeCommandArgs(sourcePath, outputPath, settings) {
  const args = ['-y', '-i', sourcePath, '-frames:v', '1'];
  if (settings.outputFormat === 'jpg') {
    args.push('-vf', 'format=rgb24');
  }
  args.push(outputPath);
  return {
    args,
    mode: 'image-to-normalized-' + settings.outputFormat,
  };
}

function normalizeImageSettings(options = {}) {
  const outputFormat = normalizeImageOutputFormat(options.outputFormat, 'Normalize Image');
  return { outputFormat };
}

async function normalizeSingleImageArtifact(imageArtifact, options = {}) {
  const operationLabel = 'Normalize Image';
  const settings = normalizeImageSettings(options);
  const sourcePath = await resolveSourceImagePath(imageArtifact, operationLabel);
  const outputPath = await nextOutputPath(options.runDirectories, options.node, 'image', '.' + settings.outputFormat);

  options.reportProgress?.(
    'Normalizing image.',
    'Converting image to ' + settings.outputFormat.toUpperCase() + ' with the bundled ffmpeg runtime...',
  );

  throwIfCancelled(options, operationLabel);
  const ffmpegPath = resolveFfmpegPath();
  const command = buildImageNormalizeCommandArgs(sourcePath, outputPath, settings);
  const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true, signal: getCancelSignal(options), abortMessage: operationLabel + ' was cancelled.' });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error(operationLabel + ' could not convert this image file. ' + (failureLine || 'Try a different image file or regenerate the source item.'));
  }

  const imageNormalization = {
    backend: 'ffmpeg',
    backendLabel: 'Bundled ffmpeg',
    createdBy: buildCreatedBy(options.node, 'normalizeImage'),
    ffmpegMode: command.mode,
    operation: 'normalizeImage',
    operationId: 'normalizeImage',
    outputFormat: settings.outputFormat,
    sourceImage: buildArtifactReference(imageArtifact),
  };
  const artifact = await buildFileArtifact(outputPath, {
    displayName: String(options.displayName || options.node?.label || 'Normalized image').trim() || 'Normalized image',
    imageNormalization,
    kind: PORT_KIND_IMAGE,
    role: 'generated',
  });
  artifact.imageNormalization = imageNormalization;
  artifact.summary = summarizeArtifact(artifact);
  const metadataPaths = await saveImageArtifactMetadata(outputPath, artifact);
  if (metadataPaths.length) artifact.metadataPaths = metadataPaths;

  return {
    destinationPath: outputPath,
    message: operationLabel + ' saved a ' + settings.outputFormat.toUpperCase() + ' image artifact.',
    outputs: { image: artifact },
    preview: summarizeArtifact(artifact),
  };
}

async function normalizeImageArtifact(sourceArtifact, options = {}) {
  const operationLabel = 'Normalize Image';
  if (String(sourceArtifact?.kind || '').trim() === PORT_KIND_IMAGE) {
    return normalizeSingleImageArtifact(sourceArtifact, options);
  }

  const settings = normalizeImageSettings(options);
  const orderedEntries = ensureCollection(sourceArtifact, PORT_KIND_IMAGE, operationLabel);
  const collectionRef = buildCollectionReference(sourceArtifact);
  const normalizedItems = [];
  const orderedSourceItems = [];

  options.reportProgress?.(
    'Normalizing image collection.',
    'Converting ' + orderedEntries.length + ' image item' + (orderedEntries.length === 1 ? '' : 's') + ' to ' + settings.outputFormat.toUpperCase() + '...',
  );

  for (let index = 0; index < orderedEntries.length; index += 1) {
    throwIfCancelled(options, operationLabel);
    const entry = orderedEntries[index];
    const sourceImage = entry.artifact;
    const sourcePath = await resolveSourceImagePath(sourceImage, operationLabel);
    const sourceItem = buildSourceItemReference(entry, sourceImage, sourcePath, index);
    orderedSourceItems.push(sourceItem);
    const outputPath = await nextOutputPath(options.runDirectories, options.node, 'image-' + String(index + 1).padStart(3, '0'), '.' + settings.outputFormat);
    const command = buildImageNormalizeCommandArgs(sourcePath, outputPath, settings);
    const commandResult = await runCommand(resolveFfmpegPath(), command.args, { allowFailure: true, signal: getCancelSignal(options), abortMessage: operationLabel + ' was cancelled.' });
    if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
      const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
      throw new Error(operationLabel + ' could not convert image item ' + String(index + 1) + '. ' + (failureLine || 'Try a different image file or regenerate the source item.'));
    }

    const imageNormalization = {
      backend: 'ffmpeg',
      backendLabel: 'Bundled ffmpeg',
      createdBy: buildCreatedBy(options.node, 'normalizeImage'),
      ffmpegMode: command.mode,
      operation: 'normalizeImage',
      operationId: 'normalizeImage',
      outputFormat: settings.outputFormat,
      sourceCollection: collectionRef,
      sourceImage: buildArtifactReference(sourceImage),
      sourceItem,
    };
    const artifact = await buildFileArtifact(outputPath, {
      displayName: String(options.displayName || options.node?.label || 'Normalized image').trim() + ' ' + String(index + 1),
      imageNormalization,
      kind: PORT_KIND_IMAGE,
      role: 'generated',
    });
    artifact.imageNormalization = imageNormalization;
    artifact.summary = summarizeArtifact(artifact);
    const metadataPaths = await saveImageArtifactMetadata(outputPath, artifact);
    if (metadataPaths.length) artifact.metadataPaths = metadataPaths;

    normalizedItems.push({
      artifact,
      index,
      itemId: String(entry.itemId || 'normalized-image-' + String(index + 1)).trim(),
      lineage: {
        parentLineage: entry.lineage || null,
        sourceItemId: String(entry.itemId || '').trim(),
        sourceItemIndex: Number(entry.index || index) || index,
        sourceNodeId: String(options.node?.id || '').trim(),
        sourceNodeLabel: String(options.node?.label || operationLabel).trim(),
        sourcePortId: 'image',
        sourcePortLabel: 'Normalized Image',
      },
      metadata: { normalization: imageNormalization, sourceItem },
    });
  }

  const collection = createArtifactCollection(normalizedItems, {
    collectionNormalization: {
      createdBy: buildCreatedBy(options.node, 'normalizeImage'),
      itemCount: normalizedItems.length,
      operation: 'normalizeImage',
      operationId: 'normalizeImage',
      orderedSourceItems,
      outputFormat: settings.outputFormat,
      sourceCollection: collectionRef,
      targetSettings: settings,
    },
    collectionStatus: 'complete',
    displayName: String(options.displayName || options.node?.label || 'Normalized image collection').trim() || 'Normalized image collection',
    itemKind: PORT_KIND_IMAGE,
    role: 'generated',
    sourceCollection: collectionRef,
    sourceItemCount: orderedEntries.length,
  });
  const persisted = await persistArtifactCollection(options.runDirectories, collection, {
    baseName: String(options.node?.label || 'Normalize Image').trim() || 'Normalize Image',
    displayName: collection.displayName,
    role: 'generated',
    target: 'artifacts',
  });

  return {
    destinationPath: persisted.directoryPath,
    message: operationLabel + ' converted ' + normalizedItems.length + ' image item' + (normalizedItems.length === 1 ? '' : 's') + ' into a normalized image collection.',
    outputs: { image: persisted },
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

function formatSubtitleTimestamp(seconds, millisecondSeparator) {
  const safe = Math.max(0, Number(seconds || 0) || 0);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + millisecondSeparator + String(ms).padStart(3, '0');
}

function formatSrtTimestamp(seconds) {
  return formatSubtitleTimestamp(seconds, ',');
}

function formatVttTimestamp(seconds) {
  return formatSubtitleTimestamp(seconds, '.');
}

function formatAssTimestamp(seconds) {
  const safe = Math.max(0, Number(seconds || 0) || 0);
  const totalCentiseconds = Math.round(safe * 100);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return String(hour) + ':' + String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + '.' + String(centiseconds).padStart(2, '0');
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

function buildVttContent(captions) {
  const body = captions.map((caption) => {
    return [
      formatVttTimestamp(caption.startSeconds) + ' --> ' + formatVttTimestamp(caption.endSeconds),
      sanitizeSrtText(caption.text),
      '',
    ].join('\n');
  }).join('\n');
  return 'WEBVTT\n\n' + body;
}

function sanitizeAssText(value) {
  return sanitizeSrtText(value)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N');
}

function buildAssContent(captions, style = {}) {
  const normalized = normalizeSubtitleStyle(style);
  const borderStyle = normalized.backgroundBox ? 3 : 1;
  const backColour = normalized.backgroundBox ? buildAssBackgroundColor(normalized.backgroundColorValue, String(normalized.backgroundOpacity)) : '&H00000000';
  const styleValues = [
    'Default',
    getSubtitleFontName(normalized),
    normalized.fontSize,
    getSubtitleColorAss(normalized, 'text'),
    '&H000000FF',
    getSubtitleColorAss(normalized, 'outline'),
    backColour,
    normalized.bold ? -1 : 0,
    normalized.italic ? -1 : 0,
    0,
    0,
    100,
    100,
    0,
    0,
    borderStyle,
    normalized.outline,
    normalized.shadow,
    getSubtitleAssAlignment(normalized.position),
    10,
    10,
    normalized.bottomMargin,
    1,
  ];
  const events = captions.map((caption) => [
    'Dialogue: 0',
    formatAssTimestamp(caption.startSeconds),
    formatAssTimestamp(caption.endSeconds),
    'Default',
    '',
    0,
    0,
    0,
    '',
    sanitizeAssText(caption.text),
  ].join(',')).join('\n');
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: ' + styleValues.join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    events,
    '',
  ].join('\n');
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
const SUBTITLE_COLOR_VALUES = Object.freeze({
  black: Object.freeze({ ass: '&H00000000', hex: '#000000', label: 'Black' }),
  blue: Object.freeze({ ass: '&H00FF0000', hex: '#0000FF', label: 'Blue' }),
  cyan: Object.freeze({ ass: '&H00FFFF00', hex: '#00FFFF', label: 'Cyan' }),
  darkGray: Object.freeze({ ass: '&H00404040', hex: '#404040', label: 'Dark gray' }),
  green: Object.freeze({ ass: '&H00008000', hex: '#008000', label: 'Green' }),
  lightGray: Object.freeze({ ass: '&H00C0C0C0', hex: '#C0C0C0', label: 'Light gray' }),
  magenta: Object.freeze({ ass: '&H00FF00FF', hex: '#FF00FF', label: 'Magenta' }),
  red: Object.freeze({ ass: '&H000000FF', hex: '#FF0000', label: 'Red' }),
  white: Object.freeze({ ass: '&H00FFFFFF', hex: '#FFFFFF', label: 'White' }),
  yellow: Object.freeze({ ass: '&H0000FFFF', hex: '#FFFF00', label: 'Yellow' }),
});

const SUBTITLE_OUTLINE_COLOR_KEYS = Object.freeze(['black', 'white', 'darkGray', 'lightGray', 'yellow', 'red', 'blue']);
const SUBTITLE_TEXT_COLOR_KEYS = Object.freeze(['white', 'black', 'yellow', 'red', 'blue', 'green', 'cyan', 'magenta', 'lightGray', 'darkGray']);
const SUBTITLE_FONT_PRESETS = Object.freeze({
  arial: Object.freeze({ ass: 'Arial', label: 'Arial' }),
  segoeUi: Object.freeze({ ass: 'Segoe UI', label: 'Segoe UI' }),
  tahoma: Object.freeze({ ass: 'Tahoma', label: 'Tahoma' }),
  verdana: Object.freeze({ ass: 'Verdana', label: 'Verdana' }),
});
const SUBTITLE_POSITION_VALUES = Object.freeze({
  bottomCenter: Object.freeze({ label: 'Bottom center' }),
  bottomLeft: Object.freeze({ label: 'Bottom left' }),
  bottomRight: Object.freeze({ label: 'Bottom right' }),
  center: Object.freeze({ label: 'Center' }),
  topCenter: Object.freeze({ label: 'Top center' }),
  topLeft: Object.freeze({ label: 'Top left' }),
  topRight: Object.freeze({ label: 'Top right' }),
});

const SUBTITLE_ASS_ALIGNMENT_BY_POSITION = Object.freeze({
  bottomLeft: 1,
  bottomCenter: 2,
  bottomRight: 3,
  center: 5,
  topLeft: 7,
  topCenter: 8,
  topRight: 9,
});

// FFmpeg's subtitles filter applies force_style to SRT/VTT inputs using legacy SSA alignment values.
// Generated burn-in captions use ASS files above, where the normal ASS numpad alignment values apply.
const SUBTITLE_FILTER_ALIGNMENT_BY_POSITION = Object.freeze({
  bottomLeft: 1,
  bottomCenter: 2,
  bottomRight: 3,
  center: 10,
  topLeft: 5,
  topCenter: 6,
  topRight: 7,
});
const SUBTITLE_BACKGROUND_OPACITY_VALUES = Object.freeze({
  25: Object.freeze({ alpha: 'BF', label: '25%' }),
  50: Object.freeze({ alpha: '80', label: '50%' }),
  75: Object.freeze({ alpha: '40', label: '75%' }),
  100: Object.freeze({ alpha: '00', label: '100%' }),
});

function normalizeSubtitleEnum(value, allowedKeys, fallback, label) {
  const normalized = String(value || fallback).trim();
  if (allowedKeys.includes(normalized)) {
    return normalized;
  }
  throw new Error('Burn Subtitles / Captions does not support that ' + label + ' style option. Choose one of the built-in presets.');
}

function normalizeSubtitleBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeHexColorValue(value, fallback = '#000000') {
  const raw = String(value || fallback).trim();
  const normalized = raw.startsWith('#') ? raw : '#' + raw;
  const match = normalized.match(/^#([0-9a-fA-F]{6})$/);
  if (!match) {
    throw new Error('Burn Subtitles / Captions could not use that palette color. Choose a valid saved color.');
  }
  return '#' + match[1].toUpperCase();
}

function hexToAssColor(value) {
  const hex = normalizeHexColorValue(value);
  const red = hex.slice(1, 3);
  const green = hex.slice(3, 5);
  const blue = hex.slice(5, 7);
  return '&H00' + blue + green + red;
}

function getSubtitleFontName(style = {}) {
  const normalized = normalizeSubtitleStyle(style);
  return String(normalized.fontFamily || SUBTITLE_FONT_PRESETS[normalized.fontPreset].ass).replace(/[\r\n,]+/g, ' ').trim() || SUBTITLE_FONT_PRESETS.arial.ass;
}

function getSubtitleColorAss(style = {}, slot = 'text') {
  const normalized = normalizeSubtitleStyle(style);
  const value = slot === 'outline'
    ? normalized.outlineColorValue
    : slot === 'background'
      ? normalized.backgroundColorValue
      : normalized.textColorValue;
  return hexToAssColor(value);
}

function buildAssBackgroundColor(colorValue, opacityKey) {
  const color = hexToAssColor(colorValue || SUBTITLE_COLOR_VALUES.black.hex);
  const alpha = SUBTITLE_BACKGROUND_OPACITY_VALUES[opacityKey]?.alpha || SUBTITLE_BACKGROUND_OPACITY_VALUES[50].alpha;
  return '&H' + alpha + color.slice(4);
}

function getSubtitleAssAlignment(position) {
  const normalized = normalizeSubtitleEnum(position, Object.keys(SUBTITLE_POSITION_VALUES), 'bottomCenter', 'position');
  return SUBTITLE_ASS_ALIGNMENT_BY_POSITION[normalized] || 2;
}

function getSubtitleFilterAlignment(position) {
  const normalized = normalizeSubtitleEnum(position, Object.keys(SUBTITLE_POSITION_VALUES), 'bottomCenter', 'position');
  return SUBTITLE_FILTER_ALIGNMENT_BY_POSITION[normalized] || 2;
}

function normalizeSubtitleStyle(options = {}) {
  const fontSize = Math.max(1, Number(options.fontSize || 28) || 28);
  const outline = Math.max(0, Number(options.outline ?? 2) || 0);
  const shadow = Math.max(0, Number(options.shadow ?? 1) || 0);
  const bottomMargin = Math.max(0, Number(options.bottomMargin ?? 32) || 0);
  const textColor = normalizeSubtitleEnum(options.textColor, SUBTITLE_TEXT_COLOR_KEYS, 'white', 'text color');
  const outlineColor = normalizeSubtitleEnum(options.outlineColor, SUBTITLE_OUTLINE_COLOR_KEYS, 'black', 'outline color');
  const backgroundColor = normalizeSubtitleEnum(options.backgroundColor, SUBTITLE_TEXT_COLOR_KEYS, 'black', 'background color');
  const position = normalizeSubtitleEnum(options.position, Object.keys(SUBTITLE_POSITION_VALUES), 'bottomCenter', 'position');
  const fontPreset = normalizeSubtitleEnum(options.fontPreset, Object.keys(SUBTITLE_FONT_PRESETS), 'arial', 'font preset');
  const fontSource = String(options.fontSource || '').trim() === 'assetLibrary' ? 'assetLibrary' : 'preset';
  const colorSource = String(options.colorSource || '').trim() === 'palette' ? 'palette' : 'manual';
  const backgroundBox = normalizeSubtitleBoolean(options.backgroundBox);
  const backgroundOpacity = normalizeSubtitleEnum(String(options.backgroundOpacity ?? 50), Object.keys(SUBTITLE_BACKGROUND_OPACITY_VALUES), '50', 'background opacity');
  const fontFamily = fontSource === 'assetLibrary'
    ? String(options.fontFamily || options.fontAsset?.fontFamily || '').replace(/[\r\n,]+/g, ' ').trim()
    : SUBTITLE_FONT_PRESETS[fontPreset].ass;
  const textColorValue = normalizeHexColorValue(options.textColorValue || options.resolvedTextColorHex || SUBTITLE_COLOR_VALUES[textColor].hex, SUBTITLE_COLOR_VALUES.white.hex);
  const outlineColorValue = normalizeHexColorValue(options.outlineColorValue || options.resolvedOutlineColorHex || SUBTITLE_COLOR_VALUES[outlineColor].hex, SUBTITLE_COLOR_VALUES.black.hex);
  const backgroundColorValue = normalizeHexColorValue(options.backgroundColorValue || options.resolvedBackgroundColorHex || SUBTITLE_COLOR_VALUES[backgroundColor].hex, SUBTITLE_COLOR_VALUES.black.hex);
  return {
    backgroundBox,
    backgroundColor,
    backgroundColorValue,
    backgroundOpacity: Number(backgroundOpacity),
    bottomMargin: Math.round(bottomMargin * 10) / 10,
    bold: normalizeSubtitleBoolean(options.bold),
    colorSource,
    fontAsset: options.fontAsset && typeof options.fontAsset === 'object' ? { ...options.fontAsset } : null,
    fontFamily: fontFamily || SUBTITLE_FONT_PRESETS[fontPreset].ass,
    fontPreset,
    fontSize: Math.round(fontSize * 10) / 10,
    fontSource,
    italic: normalizeSubtitleBoolean(options.italic),
    outline: Math.round(outline * 10) / 10,
    outlineColor,
    outlineColorValue,
    palette: options.palette && typeof options.palette === 'object' ? { ...options.palette } : null,
    position,
    shadow: Math.round(shadow * 10) / 10,
    textColor,
    textColorValue,
  };
}

function buildSubtitleForceStyle(style = {}, options = {}) {
  const normalized = normalizeSubtitleStyle(style);
  const alignment = options.alignmentMode === 'filter'
    ? getSubtitleFilterAlignment(normalized.position)
    : getSubtitleAssAlignment(normalized.position);
  const forceStyle = [
    'Alignment=' + alignment,
    'Fontname=' + getSubtitleFontName(normalized),
    'Fontsize=' + normalized.fontSize,
    'PrimaryColour=' + getSubtitleColorAss(normalized, 'text'),
    'OutlineColour=' + getSubtitleColorAss(normalized, 'outline'),
    'Bold=' + (normalized.bold ? -1 : 0),
    'Italic=' + (normalized.italic ? -1 : 0),
    'Outline=' + normalized.outline,
    'Shadow=' + normalized.shadow,
    'MarginV=' + normalized.bottomMargin,
  ];
  if (normalized.backgroundBox) {
    forceStyle.push('BorderStyle=3');
    forceStyle.push('BackColour=' + buildAssBackgroundColor(normalized.backgroundColorValue, String(normalized.backgroundOpacity)));
  }
  return forceStyle.join(',');
}

function escapeSubtitleForceStyle(value) {
  return String(value || '').replace(/'/g, "\\'");
}

async function nextSubtitlePath(runDirectories, node, suffix = 'captions', extension = '.srt') {
  return nextOutputPath(runDirectories, node, suffix, extension);
}

function escapeSubtitleFilterPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function normalizeSubtitleCaptionMode(value, supportedModes, operationLabel) {
  const mode = String(value || 'auto').trim() || 'auto';
  if (supportedModes.includes(mode)) {
    return mode;
  }
  throw new Error(operationLabel + ' needs a supported caption mode.');
}

function normalizeSubtitleOutputFormat(value, operationLabel) {
  const outputFormat = String(value || 'srt').trim().toLowerCase() || 'srt';
  if (outputFormat === 'srt' || outputFormat === 'vtt') {
    return outputFormat;
  }
  throw new Error(operationLabel + ' can export SRT or VTT subtitles.');
}

function buildSubtitleContent(captions, outputFormat) {
  return outputFormat === 'vtt' ? buildVttContent(captions) : buildSrtContent(captions);
}

function resolveSubtitleCaptions(captionArtifact, options = {}) {
  const operationLabel = String(options.operationLabel || 'Subtitles').trim() || 'Subtitles';
  const captionMode = normalizeSubtitleCaptionMode(options.captionMode, ['auto', 'transcriptSegments', 'manualLines'], operationLabel);
  const durationPerCaptionSeconds = Math.max(0.1, Number(options.durationPerCaptionSeconds || 3) || 3);
  const captionKind = String(captionArtifact?.kind || '').trim();
  if (!captionArtifact) {
    throw new Error(operationLabel + ' needs captions or a transcript before it can run.');
  }
  if (captionKind !== PORT_KIND_TEXT) {
    throw new Error(operationLabel + ' needs a text or transcript artifact for generated subtitle timing.');
  }

  if (captionMode === 'auto' || captionMode === 'transcriptSegments') {
    const segments = extractTranscriptSegments(captionArtifact);
    if (segments.length) {
      return {
        captionCount: segments.length,
        captions: segments,
        durationPerCaptionSeconds: null,
        mode: 'transcriptSegments',
        timingSource: 'transcriptSegments',
      };
    }
    if (captionMode === 'transcriptSegments') {
      throw new Error(operationLabel + ' was set to transcript segments, but the caption input does not contain timed transcript segments.');
    }
  }

  if (captionMode === 'auto' || captionMode === 'manualLines') {
    const captions = buildManualLineCaptions(captionArtifact.text, durationPerCaptionSeconds);
    if (!captions.length) {
      throw new Error(operationLabel + ' needs at least one non-empty caption line.');
    }
    return {
      captionCount: captions.length,
      captions,
      durationPerCaptionSeconds,
      mode: 'manualLines',
      timingSource: 'manualLines',
    };
  }

  throw new Error(operationLabel + ' could not turn the caption input into timed subtitles. Use Whisper transcript segments or a text artifact with caption lines.');
}

async function prepareSubtitleSource(captionArtifact, options = {}) {
  const operationLabel = 'Burn Subtitles / Captions';
  const captionMode = String(options.captionMode || 'auto').trim() || 'auto';
  const captionKind = String(captionArtifact?.kind || '').trim();
  if (!captionArtifact) {
    throw new Error(operationLabel + ' needs captions, a transcript, or a subtitle file before it can run.');
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

  const textMode = normalizeSubtitleCaptionMode(captionMode, ['auto', 'transcriptSegments', 'manualLines', 'subtitleFile'], operationLabel);
  if (textMode === 'subtitleFile') {
    throw new Error(operationLabel + ' needs an .srt or .vtt file for subtitle file mode.');
  }
  const resolved = resolveSubtitleCaptions(captionArtifact, {
    captionMode: textMode,
    durationPerCaptionSeconds: options.durationPerCaptionSeconds,
    operationLabel,
  });
  const suffix = resolved.mode === 'transcriptSegments' ? 'transcript-captions' : 'manual-captions';
  const subtitlePath = await nextSubtitlePath(options.runDirectories, options.node, suffix, '.ass');
  await fs.writeFile(subtitlePath, buildAssContent(resolved.captions, options.subtitleStyle || options), 'utf8');
  return { captionCount: resolved.captionCount, mode: resolved.mode, subtitleFormat: 'ass', subtitlePath };
}

async function exportSubtitlesArtifact(captionArtifact, options = {}) {
  const operationLabel = 'Export Subtitles';
  const outputFormat = normalizeSubtitleOutputFormat(options.outputFormat, operationLabel);
  const resolved = resolveSubtitleCaptions(captionArtifact, {
    captionMode: options.captionMode || 'auto',
    durationPerCaptionSeconds: options.durationPerCaptionSeconds,
    operationLabel,
  });
  const outputPath = await nextOutputPath(options.runDirectories, options.node, 'subtitles', '.' + outputFormat);
  const subtitleText = buildSubtitleContent(resolved.captions, outputFormat);
  await fs.writeFile(outputPath, subtitleText, 'utf8');
  if (!(await fs.pathExists(outputPath))) {
    throw new Error(operationLabel + ' could not write the subtitle file.');
  }
  const subtitleExport = {
    captionCount: resolved.captionCount,
    captionMode: resolved.mode,
    captionSource: buildArtifactReference(captionArtifact),
    createdBy: buildCreatedBy(options.node, 'exportSubtitles'),
    durationPerCaptionSeconds: resolved.mode === 'manualLines' ? resolved.durationPerCaptionSeconds : null,
    operation: 'exportSubtitles',
    operationId: 'exportSubtitles',
    outputFormat,
    segmentTimingSource: resolved.timingSource,
  };
  const artifact = await buildFileArtifact(outputPath, {
    displayName: String(options.displayName || options.node?.label || 'Exported subtitles').trim() || 'Exported subtitles',
    kind: PORT_KIND_FILE,
    role: 'generated',
    subtitleExport,
  });
  artifact.subtitleExport = subtitleExport;
  artifact.summary = summarizeArtifact(artifact);
  const metadataPaths = await saveSubtitleExportArtifactMetadata(outputPath, artifact);
  if (metadataPaths.length) artifact.metadataPaths = metadataPaths;
  return {
    destinationPath: outputPath,
    message: operationLabel + ' created a .' + outputFormat + ' subtitle file.',
    outputs: { subtitles: artifact },
    preview: summarizeArtifact(artifact),
  };
}

function buildBurnSubtitlesCommandArgs(sourcePath, subtitlePath, outputPath, style = {}, fontRuntime = null) {
  const extension = path.extname(String(subtitlePath || '')).toLowerCase();
  let filter = "subtitles='" + escapeSubtitleFilterPath(subtitlePath) + "'";
  if (fontRuntime?.fontsDir) {
    filter += ":fontsdir='" + escapeSubtitleFilterPath(fontRuntime.fontsDir) + "'";
  }
  if (extension !== '.ass') {
    filter += ":force_style='" + escapeSubtitleForceStyle(buildSubtitleForceStyle(style, { alignmentMode: 'filter' })) + "'";
  }
  return {
    args: [
      '-y', '-i', sourcePath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', filter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', outputPath,
    ],
    mode: extension === '.ass' ? 'burn-ass-subtitles-filter' : 'burn-subtitles-filter',
  };
}

async function resolveSubtitlePaletteStyle(options = {}) {
  const colorSource = String(options.colorSource || '').trim() === 'palette' ? 'palette' : 'manual';
  if (colorSource !== 'palette') {
    return { palette: null };
  }
  const libraryId = String(options.colorPaletteLibraryId || '').trim();
  if (!libraryId) {
    throw new Error('Burn Subtitles / Captions needs a Color Palette library before using palette colors.');
  }
  const slots = [
    ['text', 'textColorPaletteItemId', 'text color'],
    ['outline', 'outlineColorPaletteItemId', 'outline color'],
    ['background', 'backgroundColorPaletteItemId', 'background color'],
  ];
  const colors = {};
  let paletteLibrary = null;
  for (const [slot, key, label] of slots) {
    const itemId = String(options[key] || '').trim();
    if (!itemId) {
      throw new Error('Burn Subtitles / Captions needs a palette ' + label + ' before using palette colors.');
    }
    const resolved = await resolveColorPaletteItemForUse(libraryId, itemId);
    paletteLibrary = resolved.library;
    colors[slot] = {
      itemId: resolved.item.id,
      itemName: resolved.item.name,
      name: resolved.item.name,
      value: resolved.item.hex,
    };
  }
  return {
    backgroundColorValue: colors.background.value,
    outlineColorValue: colors.outline.value,
    palette: {
      colors,
      libraryId: paletteLibrary.id,
      libraryName: paletteLibrary.name,
      source: 'assetLibrary',
    },
    textColorValue: colors.text.value,
  };
}

async function resolveSubtitleFontStyle(options = {}) {
  const fontSource = String(options.fontSource || '').trim() === 'assetLibrary' ? 'assetLibrary' : 'preset';
  if (fontSource !== 'assetLibrary') {
    return { fontAsset: null, fontRuntime: null };
  }
  const libraryId = String(options.fontLibraryId || '').trim();
  const itemId = String(options.fontItemId || '').trim();
  if (!libraryId || !itemId) {
    throw new Error('Burn Subtitles / Captions needs a Font library and imported font before using an asset-library font.');
  }
  const resolved = await resolveAssetLibraryFontForUse(libraryId, itemId);
  const artifactsDir = path.resolve(String(options.runDirectories?.artifactsDir || '').trim());
  if (!artifactsDir) {
    throw new Error('Burn Subtitles / Captions could not prepare a run-scoped font folder.');
  }
  const fontsDir = path.join(artifactsDir, 'subtitle-fonts', sanitizeSegment(options.node?.id || 'burn-subtitles'));
  await fs.ensureDir(fontsDir);
  const extension = path.extname(resolved.filePath).toLowerCase();
  const copiedFontPath = path.join(fontsDir, sanitizeSegment(resolved.library.id) + '-' + sanitizeSegment(resolved.item.id) + extension);
  await fs.copy(resolved.filePath, copiedFontPath, { overwrite: true });
  return {
    fontAsset: {
      extension,
      fontFamily: resolved.item.fontFamily,
      itemId: resolved.item.id,
      itemName: resolved.item.displayName || resolved.item.name || resolved.item.id,
      libraryId: resolved.library.id,
      libraryName: resolved.library.name,
      source: 'assetLibrary',
    },
    fontFamily: resolved.item.fontFamily,
    fontRuntime: {
      copied: true,
      fontsDir,
      strategy: 'run-scoped-fontsdir',
    },
  };
}

async function resolveSubtitleStyleForRender(options = {}) {
  const paletteStyle = await resolveSubtitlePaletteStyle(options);
  const fontStyle = await resolveSubtitleFontStyle(options);
  const style = normalizeSubtitleStyle({
    ...options,
    ...paletteStyle,
    ...fontStyle,
  });
  return {
    fontRuntime: fontStyle.fontRuntime,
    style,
  };
}

async function burnSubtitlesIntoVideoArtifact(videoArtifact, captionArtifact, options = {}) {
  const operationLabel = 'Burn Subtitles / Captions';
  const outputFormat = normalizeVideoOutputFormat(options.outputFormat, operationLabel);
  const sourcePath = await resolveSourceVideoPath(videoArtifact, operationLabel);
  const styleResolution = await resolveSubtitleStyleForRender(options);
  const subtitleStyle = styleResolution.style;
  const subtitleSource = await prepareSubtitleSource(captionArtifact, { ...options, subtitleStyle });
  const outputPath = await nextOutputPath(options.runDirectories, options.node, 'captioned', '.' + outputFormat);
  options.reportProgress?.('Burning captions.', 'Rendering timed captions directly into the video with the bundled ffmpeg runtime...');
  const ffmpegPath = resolveFfmpegPath();
  const command = buildBurnSubtitlesCommandArgs(sourcePath, subtitleSource.subtitlePath, outputPath, subtitleStyle, styleResolution.fontRuntime);
  const commandResult = await runCommand(ffmpegPath, command.args, { allowFailure: true });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error(operationLabel + ' could not render captions into this video. ' + (failureLine || 'Check the video and caption timing input, then try again.'));
  }
  const createdBy = buildCreatedBy(options.node, 'burnSubtitles');
  const subtitleBurn = {
    backend: 'ffmpeg',
    backendLabel: 'Bundled ffmpeg',
    captionCount: subtitleSource.captionCount,
    captionMode: subtitleSource.mode,
    captionSource: buildArtifactReference(captionArtifact),
    createdBy,
    durationPerCaptionSeconds: subtitleSource.mode === 'manualLines' ? Math.max(0.1, Number(options.durationPerCaptionSeconds || 3) || 3) : null,
    ffmpegMode: command.mode,
    generatedSubtitleFormat: subtitleSource.subtitleFormat,
    generatedSubtitlePath: subtitleSource.subtitlePath,
    fontRuntime: styleResolution.fontRuntime ? { copied: true, strategy: styleResolution.fontRuntime.strategy } : null,
    operation: 'burnSubtitles',
    operationId: 'burnSubtitles',
    outputFormat,
    pipelineTrace: {
      burnSubtitlesNodeId: createdBy.nodeId,
      burnSubtitlesNodeLabel: createdBy.nodeLabel,
    },
    position: 'bottom',
    sourceVideo: buildVideoReference(videoArtifact),
    sourceVideoLineage: options.sourceVideoLineage && typeof options.sourceVideoLineage === 'object' ? { ...options.sourceVideoLineage } : null,
    sourceVideoPath: sourcePath,
    style: subtitleStyle,
    styleWarnings: [],
    retryOverride: options.retryOverride && typeof options.retryOverride === 'object' ? { ...options.retryOverride, temporary: true } : null,
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
    message: operationLabel + ' rendered captions into an MP4 video using ' + subtitleStyle.fontSize + 'px ' + (subtitleStyle.fontSource === 'assetLibrary' ? (subtitleStyle.fontAsset?.itemName || subtitleStyle.fontFamily || 'asset-library font') : subtitleStyle.fontPreset) + ' captions at ' + subtitleStyle.position + '.',
    outputs: { video: artifact },
    preview: summarizeArtifact(artifact),
  };
}

module.exports = {
  extractAudioFromVideoArtifact,
  extractVideoFrameArtifact,
  normalizeAudioCollectionArtifact,
  normalizeImageArtifact,
  normalizeVideoCollectionArtifact,
  probeVideoFile,
  trimMediaArtifact,
  burnSubtitlesIntoVideoArtifact,
  exportSubtitlesArtifact,
  _test: {
    buildAudioCommandArgs,
    buildAudioNormalizeCommandArgs,
    buildFrameCommandArgs,
    buildVideoNormalizeCommandArgs,
    buildTrimCommandArgs,
    buildBurnSubtitlesCommandArgs,
    buildAssContent,
    buildSrtContent,
    buildVttContent,
    resolveSubtitleCaptions,
    prepareSubtitleSource,
    normalizeFramePosition,
    normalizeTimestampSeconds,
    normalizeSubtitleStyle,
    resolveSubtitleStyleForRender,
    getSubtitleAssAlignment,
    getSubtitleFilterAlignment,
    buildSubtitleForceStyle,
    hexToAssColor,
  },
};
