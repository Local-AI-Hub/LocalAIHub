const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');

const { ensureStorage, getAppPaths } = require('./configService');
const {
  PORT_KIND_AUDIO,
  PORT_KIND_COLLECTION,
  PORT_KIND_COMPOSITION,
  PORT_KIND_FILE,
  PORT_KIND_IMAGE,
  PORT_KIND_TEXT,
  PORT_KIND_VIDEO,
  trimPreviewText,
} = require('../shared/pipelineSchema.cjs');

let nativeImage = null;
try {
  ({ nativeImage } = require('electron'));
} catch {
  nativeImage = null;
}

const TEXT_FILE_EXTENSIONS = new Set(['.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.log', '.html', '.xml', '.ini', '.rtf']);
const ANIMATED_IMAGE_EXTENSIONS = new Set(['.gif', '.webp']);
const MIME_TYPES = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.wma': 'audio/x-ms-wma',
};
const KIND_EXTENSIONS = {
  [PORT_KIND_AUDIO]: '.wav',
  [PORT_KIND_FILE]: '.bin',
  [PORT_KIND_IMAGE]: '.png',
  [PORT_KIND_TEXT]: '.txt',
  [PORT_KIND_VIDEO]: '.mp4',
};

function detectAnimatedGif(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 14) {
    return false;
  }

  const header = buffer.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') {
    return false;
  }

  let offset = 13;
  const packed = buffer[10];
  if ((packed & 0x80) !== 0) {
    offset += 3 * (2 ** ((packed & 0x07) + 1));
  }

  let imageCount = 0;
  while (offset < buffer.length) {
    const blockId = buffer[offset];
    if (blockId === 0x3b) {
      break;
    }

    if (blockId === 0x2c) {
      imageCount += 1;
      if (imageCount > 1) {
        return true;
      }

      offset += 10;
      if (offset >= buffer.length) {
        break;
      }

      const imagePacked = buffer[offset - 1];
      if ((imagePacked & 0x80) !== 0) {
        offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
      }

      offset += 1;
      while (offset < buffer.length) {
        const blockSize = buffer[offset];
        offset += 1;
        if (blockSize === 0) {
          break;
        }
        offset += blockSize;
      }
      continue;
    }

    if (blockId === 0x21) {
      offset += 2;
      while (offset < buffer.length) {
        const blockSize = buffer[offset];
        offset += 1;
        if (blockSize === 0) {
          break;
        }
        offset += blockSize;
      }
      continue;
    }

    break;
  }

  return false;
}

function detectAnimatedWebP(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    return false;
  }

  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return false;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'ANIM') {
      return true;
    }

    if (chunkId === 'VP8X' && offset + 9 <= buffer.length) {
      const featureFlags = buffer[offset + 8];
      if ((featureFlags & 0x02) !== 0) {
        return true;
      }
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return false;
}

async function detectAnimatedImage(filePath, extension) {
  if (!ANIMATED_IMAGE_EXTENSIONS.has(extension)) {
    return false;
  }

  try {
    const buffer = await fs.readFile(filePath);
    if (extension === '.gif') {
      return detectAnimatedGif(buffer);
    }

    if (extension === '.webp') {
      return detectAnimatedWebP(buffer);
    }
  } catch {
    return false;
  }

  return false;
}

function getArtifactPreviewKind(kind, mimeType, isAnimated) {
  if (kind === PORT_KIND_TEXT) {
    return 'text';
  }

  if (kind === PORT_KIND_AUDIO) {
    return 'audio';
  }

  if (kind === PORT_KIND_VIDEO) {
    if (isAnimated && String(mimeType || '').toLowerCase().startsWith('image/')) {
      return 'animated-image';
    }

    return String(mimeType || '').toLowerCase().startsWith('image/') ? 'image' : 'video';
  }

  if (kind === PORT_KIND_IMAGE) {
    return isAnimated ? 'animated-image' : 'image';
  }

  const normalizedMimeType = String(mimeType || '').toLowerCase();
  if (normalizedMimeType.startsWith('image/')) {
    return isAnimated ? 'animated-image' : 'image';
  }

  if (normalizedMimeType.startsWith('video/')) {
    return 'video';
  }

  if (normalizedMimeType.startsWith('audio/')) {
    return 'audio';
  }

  return 'file';
}

function getArtifactAttachmentKind(mimeType) {
  const normalizedMimeType = String(mimeType || '').toLowerCase();
  if (normalizedMimeType.startsWith('image/')) {
    return 'image';
  }

  if (normalizedMimeType.startsWith('video/')) {
    return 'video';
  }

  return 'file';
}

function getArtifactFormatLabel(extension, mimeType, isAnimated) {
  switch (extension) {
    case '.gif':
      return isAnimated ? 'Animated GIF' : 'GIF';
    case '.webp':
      return isAnimated ? 'Animated WebP' : 'WebP';
    case '.png':
      return 'PNG image';
    case '.jpg':
    case '.jpeg':
      return 'JPEG image';
    case '.mp4':
      return 'MP4 video';
    case '.webm':
      return 'WebM video';
    case '.mov':
      return 'MOV video';
    case '.mkv':
      return 'MKV video';
    default:
      break;
  }

  const normalizedMimeType = String(mimeType || '').toLowerCase();
  if (normalizedMimeType.startsWith('image/')) {
    return isAnimated ? 'Animated image' : 'Image';
  }

  if (normalizedMimeType.startsWith('video/')) {
    return 'Video';
  }

  if (normalizedMimeType.startsWith('audio/')) {
    return 'Audio';
  }

  return '';
}

function formatTranscriptionLanguage(language) {
  const normalized = String(language || '').trim();
  if (!normalized || normalized.toLowerCase() === 'unknown') {
    return '';
  }

  const commonLabels = {
    de: 'German',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    hi: 'Hindi',
    it: 'Italian',
    ja: 'Japanese',
    ko: 'Korean',
    pt: 'Portuguese',
    ru: 'Russian',
    zh: 'Chinese',
  };

  return commonLabels[normalized.toLowerCase()]
    || normalized
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function buildTranscriptionSummary(transcription = {}, limit = 180) {
  if (!transcription || typeof transcription !== 'object') {
    return '';
  }

  const runtime = transcription.runtime && typeof transcription.runtime === 'object' ? transcription.runtime : null;
  const sourceAudio = transcription.sourceAudio && typeof transcription.sourceAudio === 'object' ? transcription.sourceAudio : null;
  const durationSeconds = Number(transcription.durationSeconds || 0);
  const runtimeLabel = [String(runtime?.device || '').trim(), String(runtime?.computeType || '').trim()].filter(Boolean).join(' ');
  const rawSegmentCount = Array.isArray(transcription.segments) ? transcription.segments.length : 0;
  const segmentCount = Number(transcription.segmentCount || rawSegmentCount) || rawSegmentCount;
  const parts = [
    String(transcription.backendLabel || '').trim() || (String(transcription.backend || '').trim().toLowerCase() === 'whisper' ? 'Whisper transcript' : 'Transcript'),
    formatTranscriptionLanguage(transcription.language),
    String(transcription.model || '').trim(),
    segmentCount > 0 ? segmentCount + ' segments' : '',
    durationSeconds > 0 ? Math.round(durationSeconds * 10) / 10 + 's' : '',
    runtimeLabel,
    String(sourceAudio?.fileName || sourceAudio?.displayName || '').trim(),
  ].filter(Boolean);

  return trimPreviewText(parts.join(' | '), limit);
}
function formatDurationSummary(seconds) {
  const numeric = Number(seconds || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }

  if (numeric >= 60) {
    const minutes = Math.floor(numeric / 60);
    const remainder = Math.round((numeric - minutes * 60) * 10) / 10;
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }

  return `${Math.round(numeric * 10) / 10}s`;
}

function buildAudioChannelLabel(channelCount) {
  const numeric = Number(channelCount || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }

  if (numeric === 1) {
    return 'Mono';
  }

  if (numeric === 2) {
    return 'Stereo';
  }

  return numeric + ' channels';
}

function roundAudioMetric(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return Math.round(numeric * 100) / 100;
}

function serializeAudioDetailsForUi(audio = null) {
  if (!audio || typeof audio !== 'object') {
    return null;
  }

  const durationSeconds = roundAudioMetric(audio.durationSeconds);
  const sampleRate = Number(audio.sampleRate || 0) || 0;
  const channelCount = Number(audio.channelCount || 0) || 0;
  const bitDepth = Number(audio.bitDepth || 0) || 0;
  if (!durationSeconds && !sampleRate && !channelCount && !bitDepth) {
    return null;
  }

  return {
    ...(bitDepth ? { bitDepth } : {}),
    ...(channelCount ? { channelCount } : {}),
    ...(durationSeconds ? { durationSeconds } : {}),
    ...(sampleRate ? { sampleRate } : {}),
  };
}

function serializeAudioSourceReference(reference = null) {
  if (!reference || typeof reference !== 'object') {
    return null;
  }

  const normalized = {
    displayName: String(reference.displayName || '').trim(),
    fileName: String(reference.fileName || '').trim(),
    filePath: String(reference.filePath || '').trim(),
    fileUrl: String(reference.fileUrl || '').trim(),
    formatLabel: String(reference.formatLabel || '').trim(),
    kind: String(reference.kind || '').trim(),
    mimeType: String(reference.mimeType || '').trim(),
    sizeBytes: Number(reference.sizeBytes || 0) || 0,
    summary: String(reference.summary || '').trim(),
  };

  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function serializeAudioGenerationForUi(generation = null) {
  if (!generation || typeof generation !== 'object') {
    return null;
  }

  const durationSeconds = roundAudioMetric(generation.durationSeconds);
  const normalized = {
    backend: String(generation.backend || '').trim(),
    backendLabel: String(generation.backendLabel || '').trim(),
    durationSeconds,
    mode: String(generation.mode || '').trim(),
    model: String(generation.model || '').trim(),
    prompt: String(generation.prompt || '').trim(),
    sourceAudio: serializeAudioSourceReference(generation.sourceAudio),
    voice: String(generation.voice || '').trim(),
    toolId: String(generation.toolId || '').trim(),
    toolLabel: String(generation.toolLabel || '').trim(),
  };

  return Object.entries(normalized).some(([, value]) => {
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
}

function serializeAudioTransformationForUi(transformation = null) {
  if (!transformation || typeof transformation !== 'object') {
    return null;
  }

  const durationSeconds = roundAudioMetric(transformation.durationSeconds);
  const normalized = {
    backend: String(transformation.backend || '').trim(),
    backendLabel: String(transformation.backendLabel || '').trim(),
    durationSeconds,
    instruction: String(transformation.instruction || '').trim(),
    model: String(transformation.model || '').trim(),
    sourceAudio: serializeAudioSourceReference(transformation.sourceAudio),
    targetVoice: String(transformation.targetVoice || '').trim(),
    toolId: String(transformation.toolId || '').trim(),
    toolLabel: String(transformation.toolLabel || '').trim(),
    transformationType: String(transformation.transformationType || '').trim(),
  };

  return Object.entries(normalized).some(([, value]) => {
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
}

function serializeImageSourceReference(reference = null) {
  if (!reference || typeof reference !== 'object') {
    return null;
  }

  const normalized = {
    displayName: String(reference.displayName || '').trim(),
    fileName: String(reference.fileName || '').trim(),
    filePath: String(reference.filePath || '').trim(),
    fileUrl: String(reference.fileUrl || '').trim(),
    formatLabel: String(reference.formatLabel || '').trim(),
    kind: String(reference.kind || '').trim(),
    mimeType: String(reference.mimeType || '').trim(),
    sizeBytes: Number(reference.sizeBytes || 0) || 0,
    summary: String(reference.summary || '').trim(),
  };

  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function serializeImageTransformationForUi(transformation = null) {
  if (!transformation || typeof transformation !== 'object') {
    return null;
  }

  const scale = Number(transformation.scale || 0) || 0;
  const normalized = {
    backend: String(transformation.backend || '').trim(),
    backendLabel: String(transformation.backendLabel || '').trim(),
    instruction: String(transformation.instruction || '').trim(),
    model: String(transformation.model || '').trim(),
    referenceImage: serializeImageSourceReference(transformation.referenceImage),
    scale: scale > 0 ? scale : null,
    sourceImage: serializeImageSourceReference(transformation.sourceImage),
    toolId: String(transformation.toolId || '').trim(),
    toolLabel: String(transformation.toolLabel || '').trim(),
    transformationType: String(transformation.transformationType || '').trim(),
  };

  return Object.entries(normalized).some(([, value]) => {
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
}

async function readWaveAudioMetadata(filePath) {
  if (path.extname(String(filePath || '')).toLowerCase() !== '.wav') {
    return null;
  }

  let handle = null;
  try {
    handle = await require('fs').promises.open(filePath, 'r');
    const stats = await handle.stat();
    const byteLength = Math.min(Number(stats.size || 0), 65536);
    if (byteLength < 44) {
      return null;
    }

    const buffer = Buffer.alloc(byteLength);
    await handle.read(buffer, 0, byteLength, 0);
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      return null;
    }

    let offset = 12;
    let channelCount = 0;
    let sampleRate = 0;
    let bitDepth = 0;
    let dataSize = 0;
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const chunkOffset = offset + 8;
      if (chunkId === 'fmt ' && chunkOffset + 16 <= buffer.length) {
        channelCount = buffer.readUInt16LE(chunkOffset + 2);
        sampleRate = buffer.readUInt32LE(chunkOffset + 4);
        bitDepth = buffer.readUInt16LE(chunkOffset + 14);
      }

      if (chunkId === 'data') {
        dataSize = chunkSize;
        break;
      }

      offset = chunkOffset + chunkSize + (chunkSize % 2);
    }

    const bytesPerSample = bitDepth > 0 ? bitDepth / 8 : 0;
    const durationSeconds = sampleRate > 0 && channelCount > 0 && bytesPerSample > 0 && dataSize > 0
      ? roundAudioMetric(dataSize / sampleRate / channelCount / bytesPerSample)
      : null;

    return serializeAudioDetailsForUi({
      bitDepth,
      channelCount,
      durationSeconds,
      sampleRate,
    });
  } catch {
    return null;
  } finally {
    if (handle) {
      await handle.close().catch(() => null);
    }
  }
}


function sanitizeSegment(value, fallback = 'item') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function inferKindFromPath(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
    return PORT_KIND_IMAGE;
  }

  if (['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma'].includes(extension)) {
    return PORT_KIND_AUDIO;
  }

  if (['.mp4', '.mkv', '.mov', '.webm'].includes(extension)) {
    return PORT_KIND_VIDEO;
  }

  return PORT_KIND_FILE;
}

function getMimeType(filePath, kind) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  return MIME_TYPES[extension] || (kind === PORT_KIND_TEXT ? 'text/plain' : 'application/octet-stream');
}

async function readTextPreview(filePath, limit = 1200) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(extension)) {
    return '';
  }

  try {
    const text = await fs.readFile(filePath, 'utf8');
    return trimPreviewText(text, limit);
  } catch {
    return '';
  }
}

async function ensureRunDirectories(runId) {
  await ensureStorage();
  const { runtimesRoot } = getAppPaths();
  const root = path.join(runtimesRoot, 'pipeline-runs', sanitizeSegment(runId, 'run'));
  const artifactsDir = path.join(root, 'artifacts');
  const outputsDir = path.join(root, 'outputs');
  await Promise.all([fs.ensureDir(root), fs.ensureDir(artifactsDir), fs.ensureDir(outputsDir)]);
  return {
    root,
    artifactsDir,
    outputsDir,
  };
}

function formatArtifactKindLabel(kind) {
  switch (String(kind || '').trim()) {
    case PORT_KIND_TEXT:
      return 'Text';
    case PORT_KIND_IMAGE:
      return 'Image';
    case PORT_KIND_AUDIO:
      return 'Audio';
    case PORT_KIND_VIDEO:
      return 'Video';
    case PORT_KIND_FILE:
      return 'File';
    case PORT_KIND_COLLECTION:
      return 'Collection';
    case PORT_KIND_COMPOSITION:
      return 'Composition';
    default:
      return 'Artifact';
  }
}

function isArtifactCollection(artifact) {
  return artifact?.kind === PORT_KIND_COLLECTION && Array.isArray(artifact?.items);
}

function isCompositionArtifact(artifact) {
  return artifact?.kind === PORT_KIND_COMPOSITION && artifact?.composition && Array.isArray(artifact?.composition?.tracks);
}

function normalizeCollectionLineage(lineage) {
  if (!lineage || typeof lineage !== 'object') {
    return null;
  }

  const normalized = {
    sourceNodeId: String(lineage.sourceNodeId || '').trim(),
    sourceNodeLabel: String(lineage.sourceNodeLabel || '').trim(),
    sourcePortId: String(lineage.sourcePortId || '').trim(),
    sourcePortLabel: String(lineage.sourcePortLabel || '').trim(),
  };

  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function normalizeCollectionAccumulation(accumulation) {
  if (!accumulation || typeof accumulation !== 'object') {
    return null;
  }

  const targetCount = Number(accumulation.targetCount || 0);
  const acceptedCount = Number(accumulation.acceptedCount || 0);
  return {
    acceptedCount: Math.max(0, acceptedCount || 0),
    mode: String(accumulation.mode || 'until-target').trim() || 'until-target',
    nodeId: String(accumulation.nodeId || '').trim(),
    nodeLabel: String(accumulation.nodeLabel || '').trim(),
    status: String(accumulation.status || '').trim() || 'collecting',
    targetCount: Math.max(1, targetCount || acceptedCount || 1),
  };
}

function buildCollectionItemId(artifact, index) {
  const label = artifact?.displayName || artifact?.fileName || artifact?.kind || 'item';
  return sanitizeSegment(label + '-' + String(index + 1).padStart(3, '0'), 'item-' + String(index + 1).padStart(3, '0'));
}

function getCompositionTracks(artifact) {
  return Array.isArray(artifact?.composition?.tracks) ? artifact.composition.tracks.filter(Boolean) : [];
}

function getCompositionTrackByRole(artifact, role) {
  return getCompositionTracks(artifact).find((track) => String(track?.role || '').trim() === role) || null;
}

function buildCompositionSummary(artifact, limit = 180) {
  const visualTrack = getCompositionTrackByRole(artifact, 'primary-visual');
  const audioTrack = getCompositionTrackByRole(artifact, 'primary-audio');
  const backgroundMusicTrack = getCompositionTrackByRole(artifact, 'background-music');
  const visualItemCount = Number(visualTrack?.itemCount || visualTrack?.items?.length || 0) || 0;
  const itemDurationSeconds = Number(visualTrack?.itemDurationSeconds || 0) || 0;
  const parts = [
    String(artifact?.composition?.recipeLabel || '').trim() || 'Media composition',
    visualItemCount ? `${visualItemCount} image${visualItemCount === 1 ? '' : 's'}` : '',
    itemDurationSeconds > 0 ? `${Math.round(itemDurationSeconds * 10) / 10}s each` : '',
    audioTrack?.artifact?.fileName ? `Narration ${audioTrack.artifact.fileName}` : audioTrack ? 'Primary audio attached' : '',
    backgroundMusicTrack?.artifact?.fileName ? `Music ${backgroundMusicTrack.artifact.fileName}` : backgroundMusicTrack ? 'Background music attached' : '',
    !audioTrack && !backgroundMusicTrack ? 'No audio tracks' : '',
  ].filter(Boolean);
  return trimPreviewText(parts.join(' | '), limit);
}

function buildCollectionSummary(artifact, limit = 180) {
  const items = Array.isArray(artifact?.items) ? artifact.items.filter(Boolean) : [];
  const itemKindLabel = formatArtifactKindLabel(artifact?.itemKind || items[0]?.artifact?.kind || PORT_KIND_FILE);
  const countLabel = items.length + ' ' + itemKindLabel.toLowerCase() + (items.length === 1 ? ' item' : ' items');
  const itemPreview = items
    .slice(0, 4)
    .map((entry, index) => {
      const itemArtifact = entry?.artifact || null;
      const label = itemArtifact?.displayName || itemArtifact?.fileName || summarizeArtifact(itemArtifact, 64) || 'Item ' + (index + 1);
      return (index + 1) + '. ' + trimPreviewText(label, 64);
    })
    .filter(Boolean)
    .join(' | ');
  const extraCount = items.length > 4 ? ' | +' + (items.length - 4) + ' more' : '';
  return trimPreviewText([countLabel, itemPreview].filter(Boolean).join(' | ') + extraCount, limit);
}

function summarizeArtifact(artifact, limit = 180) {
  if (!artifact) {
    return '';
  }

  if (isCompositionArtifact(artifact)) {
    return buildCompositionSummary(artifact, limit);
  }

  if (isArtifactCollection(artifact)) {
    return buildCollectionSummary(artifact, limit);
  }

  if (artifact.kind === PORT_KIND_TEXT) {
    const transcriptionSummary = buildTranscriptionSummary(artifact.transcription, limit);
    const textSummary = trimPreviewText(artifact.text || artifact.previewText || '', transcriptionSummary ? Math.max(48, Math.floor(limit / 2)) : limit);
    return trimPreviewText([transcriptionSummary, textSummary].filter(Boolean).join(' | '), limit);
  }

  if (artifact.kind === PORT_KIND_AUDIO) {
    const audio = artifact.audio && typeof artifact.audio === 'object' ? artifact.audio : null;
    const generation = artifact.audioGeneration && typeof artifact.audioGeneration === 'object' ? artifact.audioGeneration : null;
    const transformation = artifact.audioTransformation && typeof artifact.audioTransformation === 'object' ? artifact.audioTransformation : null;
    const details = [
      artifact.fileName || artifact.displayName || '',
      artifact.formatLabel || '',
      formatDurationSummary(audio?.durationSeconds || generation?.durationSeconds || transformation?.durationSeconds),
      audio?.sampleRate ? `${audio.sampleRate} Hz` : '',
      buildAudioChannelLabel(audio?.channelCount),
      transformation?.transformationType ? transformation.transformationType.replace(/-/g, ' ') : '',
      transformation?.toolLabel || transformation?.backendLabel || '',
      transformation?.targetVoice ? `Voice ${transformation.targetVoice}` : '',
      transformation?.sourceAudio?.fileName ? `Source ${transformation.sourceAudio.fileName}` : '',
      generation?.mode ? (generation.mode === 'sound' ? 'Sound generation' : generation.mode === 'speech' ? 'Speech generation' : 'Music generation') : '',
      generation?.toolLabel || generation?.backendLabel || '',
      generation?.voice ? `Voice ${generation.voice}` : '',
      generation?.sourceAudio?.fileName ? `Guided by ${generation.sourceAudio.fileName}` : '',
    ].filter(Boolean);
    return trimPreviewText(details.join(' | '), limit);
  }

  if (artifact.kind === PORT_KIND_IMAGE) {
    const transformation = artifact.imageTransformation && typeof artifact.imageTransformation === 'object' ? artifact.imageTransformation : null;
    const details = [
      artifact.fileName || artifact.displayName || '',
      artifact.formatLabel || '',
      artifact.width && artifact.height ? `${artifact.width}x${artifact.height}` : '',
      transformation?.transformationType ? transformation.transformationType.replace(/-/g, ' ') : '',
      transformation?.toolLabel || transformation?.backendLabel || '',
      transformation?.scale ? `${transformation.scale}x scale` : '',
      transformation?.sourceImage?.fileName ? `Target ${transformation.sourceImage.fileName}` : '',
      transformation?.referenceImage?.fileName ? `Reference ${transformation.referenceImage.fileName}` : '',
      artifact.sizeBytes ? `${Math.max(1, Math.round(artifact.sizeBytes / 1024))} KB` : '',
    ].filter(Boolean);
    return trimPreviewText(details.join(' | '), limit);
  }

  if (artifact.kind === PORT_KIND_VIDEO && artifact.compositionExport && typeof artifact.compositionExport === 'object') {
    const exportProfile = artifact.compositionExport.exportProfile || null;
    const visualTrack = artifact.compositionExport.visualTrack || null;
    const audioMix = artifact.compositionExport.audioMix || null;
    const details = [
      artifact.fileName || artifact.displayName || '',
      artifact.formatLabel || '',
      exportProfile?.width && exportProfile?.height ? `${exportProfile.width}x${exportProfile.height}` : '',
      exportProfile?.fps ? `${exportProfile.fps} fps` : '',
      Number(visualTrack?.itemCount || 0) ? `${visualTrack.itemCount} image${visualTrack.itemCount === 1 ? '' : 's'}` : '',
      artifact.compositionExport.audioTrack?.artifact?.fileName ? `Narration ${artifact.compositionExport.audioTrack.artifact.fileName}` : '',
      artifact.compositionExport.backgroundMusicTrack?.artifact?.fileName ? `Music ${artifact.compositionExport.backgroundMusicTrack.artifact.fileName}` : '',
      audioMix?.mode === 'mixed-with-background-music' ? 'Mixed audio' : '',
    ].filter(Boolean);
    return trimPreviewText(details.join(' | '), limit);
  }

  const details = [];
  if (artifact.fileName) {
    details.push(artifact.fileName);
  }
  if (artifact.formatLabel) {
    details.push(artifact.formatLabel);
  }
  if (artifact.width && artifact.height) {
    details.push(`${artifact.width}x${artifact.height}`);
  }
  if (artifact.sizeBytes) {
    details.push(`${Math.max(1, Math.round(artifact.sizeBytes / 1024))} KB`);
  }
  if (artifact.previewText) {
    details.push(trimPreviewText(artifact.previewText, Math.max(40, limit - 40)));
  }
  return trimPreviewText(details.join(' | '), limit);
}

function serializeArtifactForUi(artifact) {
  return artifact ? JSON.parse(JSON.stringify(artifact)) : null;
}

function createArtifactCollection(items, options = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const normalizedItems = sourceItems
    .map((entry, index) => {
      const itemArtifact = serializeArtifactForUi(entry?.artifact || entry);
      if (!itemArtifact) {
        return null;
      }

      return {
        artifact: itemArtifact,
        index,
        itemId: String(entry?.itemId || buildCollectionItemId(itemArtifact, index)).trim() || buildCollectionItemId(itemArtifact, index),
        lineage: normalizeCollectionLineage(entry?.lineage),
        summary: summarizeArtifact(itemArtifact),
      };
    })
    .filter(Boolean);

  const itemKinds = [...new Set(normalizedItems.map((entry) => String(entry?.artifact?.kind || '').trim()).filter(Boolean))];
  const itemKind = String(options.itemKind || itemKinds[0] || '').trim();
  if (!itemKind) {
    throw new Error('Local AI Hub could not build a collection without at least one item.');
  }

  if (itemKinds.length > 1 || itemKinds.some((kind) => kind !== itemKind)) {
    throw new Error('This collection can only contain one artifact type in this pass. Connect only text, image, audio, video, or file items of the same kind.');
  }

  const collection = {
    kind: PORT_KIND_COLLECTION,
    itemKind,
    displayName: String(options.displayName || formatArtifactKindLabel(itemKind) + ' Collection').trim() || (formatArtifactKindLabel(itemKind) + ' Collection'),
    previewKind: 'collection',
    role: options.role || 'artifact',
    order: 'explicit',
    itemCount: normalizedItems.length,
    items: normalizedItems,
  };

  if (options.directoryPath) {
    collection.directoryPath = String(options.directoryPath || '').trim();
  }
  if (options.manifestPath) {
    collection.manifestPath = String(options.manifestPath || '').trim();
    collection.filePath = collection.manifestPath;
    collection.fileName = path.basename(collection.manifestPath);
    collection.fileUrl = pathToFileURL(collection.manifestPath).toString();
  }
  if (options.destinationPath) {
    collection.destinationPath = String(options.destinationPath || '').trim();
  }
  if (Array.isArray(options.metadataPaths) && options.metadataPaths.length) {
    collection.metadataPaths = [...new Set(options.metadataPaths.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }
  if (options.accumulation) {
    collection.accumulation = normalizeCollectionAccumulation(options.accumulation);
  }

  collection.summary = summarizeArtifact(collection);
  return collection;
}

function createCompositionArtifact(spec = {}, options = {}) {
  const compositionSpec = spec && typeof spec === 'object' ? spec : {};
  const sourceTracks = Array.isArray(compositionSpec.tracks) ? compositionSpec.tracks : [];
  const normalizedTracks = sourceTracks
    .map((track) => {
      if (!track || typeof track !== 'object') {
        return null;
      }

      const trackKind = String(track.kind || '').trim();
      const trackRole = String(track.role || '').trim();
      if (trackKind === 'visual-sequence') {
        const items = (Array.isArray(track.items) ? track.items : [])
          .map((entry, index) => {
            const itemArtifact = serializeArtifactForUi(entry?.artifact || null);
            if (!itemArtifact) {
              return null;
            }

            return {
              artifact: itemArtifact,
              durationSeconds: Number(entry?.durationSeconds || track.itemDurationSeconds || 0) || 0,
              index,
              itemId: String(entry?.itemId || buildCollectionItemId(itemArtifact, index)).trim() || buildCollectionItemId(itemArtifact, index),
              lineage: normalizeCollectionLineage(entry?.lineage),
              summary: String(entry?.summary || summarizeArtifact(itemArtifact)).trim() || summarizeArtifact(itemArtifact),
            };
          })
          .filter(Boolean);
        if (!items.length) {
          return null;
        }

        const sourceCollection = track.sourceCollection && typeof track.sourceCollection === 'object'
          ? {
              directoryPath: String(track.sourceCollection.directoryPath || '').trim(),
              displayName: String(track.sourceCollection.displayName || '').trim(),
              itemCount: Number(track.sourceCollection.itemCount || items.length) || items.length,
              itemKind: String(track.sourceCollection.itemKind || track.itemKind || PORT_KIND_IMAGE).trim() || PORT_KIND_IMAGE,
              manifestPath: String(track.sourceCollection.manifestPath || '').trim(),
              summary: String(track.sourceCollection.summary || '').trim(),
            }
          : null;

        return {
          id: String(track.id || 'visual-track').trim() || 'visual-track',
          itemCount: items.length,
          itemDurationSeconds: Number(track.itemDurationSeconds || items[0]?.durationSeconds || 0) || 0,
          itemKind: String(track.itemKind || PORT_KIND_IMAGE).trim() || PORT_KIND_IMAGE,
          items,
          kind: 'visual-sequence',
          order: 'explicit',
          role: trackRole || 'primary-visual',
          sourceCollection,
          summary: String(track.summary || '').trim(),
        };
      }

      if (trackKind === 'audio') {
        const audioArtifact = serializeArtifactForUi(track.artifact || null);
        if (!audioArtifact) {
          return null;
        }

        return {
          artifact: audioArtifact,
          id: String(track.id || 'audio-track').trim() || 'audio-track',
          kind: 'audio',
          role: trackRole || 'primary-audio',
          summary: String(track.summary || summarizeArtifact(audioArtifact)).trim() || summarizeArtifact(audioArtifact),
        };
      }

      return serializeArtifactForUi(track);
    })
    .filter(Boolean);

  const composition = {
    schemaVersion: 1,
    exportKind: String(compositionSpec.exportKind || PORT_KIND_VIDEO).trim() || PORT_KIND_VIDEO,
    recipeId: String(compositionSpec.recipeId || MEDIA_COMPOSITION_RECIPE_ID).trim() || MEDIA_COMPOSITION_RECIPE_ID,
    recipeLabel: String(compositionSpec.recipeLabel || MEDIA_COMPOSITION_RECIPE_LABEL).trim() || MEDIA_COMPOSITION_RECIPE_LABEL,
    tracks: normalizedTracks,
  };

  const artifact = {
    kind: PORT_KIND_COMPOSITION,
    composition,
    displayName: String(options.displayName || compositionSpec.displayName || 'Media Composition').trim() || 'Media Composition',
    previewKind: 'composition',
    role: options.role || compositionSpec.role || 'artifact',
    trackCount: normalizedTracks.length,
  };

  if (options.directoryPath) {
    artifact.directoryPath = String(options.directoryPath || '').trim();
  }
  if (options.manifestPath) {
    artifact.manifestPath = String(options.manifestPath || '').trim();
    artifact.filePath = artifact.manifestPath;
    artifact.fileName = path.basename(artifact.manifestPath);
    artifact.fileUrl = pathToFileURL(artifact.manifestPath).toString();
  }
  if (options.destinationPath) {
    artifact.destinationPath = String(options.destinationPath || '').trim();
  }
  if (Array.isArray(options.metadataPaths) && options.metadataPaths.length) {
    artifact.metadataPaths = [...new Set(options.metadataPaths.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }

  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

async function buildFileArtifact(filePath, options = {}) {
  const resolvedPath = path.resolve(String(filePath || '').trim());
  const stat = await fs.stat(resolvedPath);
  const kind = options.kind || inferKindFromPath(resolvedPath);
  const extension = path.extname(resolvedPath).toLowerCase();
  const mimeType = getMimeType(resolvedPath, kind);
  const isAnimated = await detectAnimatedImage(resolvedPath, extension);
  const previewKind = getArtifactPreviewKind(kind, mimeType, isAnimated);
  const artifact = {
    kind,
    attachmentKind: getArtifactAttachmentKind(mimeType),
    displayName: String(options.displayName || path.basename(resolvedPath)).trim() || path.basename(resolvedPath),
    fileName: path.basename(resolvedPath),
    filePath: resolvedPath,
    fileUrl: pathToFileURL(resolvedPath).toString(),
    extension,
    formatLabel: getArtifactFormatLabel(extension, mimeType, isAnimated),
    isAnimated,
    mimeType,
    previewKind,
    previewText: '',
    role: options.role || 'artifact',
    sizeBytes: Number(stat.size || 0),
  };

  if (options.compositionExport && typeof options.compositionExport === 'object') {
    artifact.compositionExport = serializeArtifactForUi(options.compositionExport);
  }

  if ((previewKind === 'image' || previewKind === 'animated-image') && nativeImage) {
    try {
      const image = nativeImage.createFromPath(resolvedPath);
      const size = image.getSize();
      if (size?.width && size?.height) {
        artifact.width = size.width;
        artifact.height = size.height;
      }
    } catch {
      // Ignore preview metadata issues.
    }
  }

  if (kind === PORT_KIND_AUDIO || String(mimeType || '').toLowerCase().startsWith('audio/')) {
    const detectedAudio = await readWaveAudioMetadata(resolvedPath);
    const providedAudio = serializeAudioDetailsForUi(options.audio);
    artifact.audio = detectedAudio || null;
    if (providedAudio) {
      artifact.audio = artifact.audio ? { ...artifact.audio, ...providedAudio } : providedAudio;
    }

    const audioGeneration = serializeAudioGenerationForUi(options.audioGeneration);
    if (audioGeneration) {
      artifact.audioGeneration = audioGeneration;
      if (audioGeneration.durationSeconds && !artifact.audio?.durationSeconds) {
        artifact.audio = {
          ...(artifact.audio || {}),
          durationSeconds: audioGeneration.durationSeconds,
        };
      }
    }

    const audioTransformation = serializeAudioTransformationForUi(options.audioTransformation);
    if (audioTransformation) {
      artifact.audioTransformation = audioTransformation;
      if (audioTransformation.durationSeconds && !artifact.audio?.durationSeconds) {
        artifact.audio = {
          ...(artifact.audio || {}),
          durationSeconds: audioTransformation.durationSeconds,
        };
      }
    }
  }

  if (kind === PORT_KIND_IMAGE || String(mimeType || '').toLowerCase().startsWith('image/')) {
    const imageTransformation = serializeImageTransformationForUi(options.imageTransformation);
    if (imageTransformation) {
      artifact.imageTransformation = imageTransformation;
    }
  }

  artifact.previewText = kind === PORT_KIND_FILE ? await readTextPreview(resolvedPath) : '';
  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

function createTextArtifact(text, options = {}) {
  const normalizedText = String(text || '');
  const artifact = {
    kind: PORT_KIND_TEXT,
    displayName: String(options.displayName || 'Text').trim() || 'Text',
    previewKind: 'text',
    previewText: trimPreviewText(normalizedText),
    role: options.role || 'artifact',
    text: normalizedText,
  };

  if (options.transcription) {
    artifact.transcription = serializeArtifactForUi(options.transcription);
  }

  if (Array.isArray(options.metadataPaths) && options.metadataPaths.length) {
    artifact.metadataPaths = [...new Set(options.metadataPaths.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }

  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

function normalizeBase64Payload(value) {
  return String(value || '').replace(/^data:[^;]+;base64,/, '').trim();
}

async function nextAvailableFilePath(directoryPath, baseName, extension) {
  const safeBaseName = sanitizeSegment(baseName, 'artifact');
  const safeExtension = extension || '.bin';
  let index = 0;
  while (true) {
    const fileName = index === 0 ? `${safeBaseName}${safeExtension}` : `${safeBaseName}-${index + 1}${safeExtension}`;
    const filePath = path.join(directoryPath, fileName);
    if (!(await fs.pathExists(filePath))) {
      return filePath;
    }

    index += 1;
  }
}

async function nextAvailableDirectoryPath(parentDirectoryPath, baseName) {
  const safeBaseName = sanitizeSegment(baseName, 'collection');
  let index = 0;
  while (true) {
    const directoryName = index === 0 ? safeBaseName : `${safeBaseName}-${index + 1}`;
    const directoryPath = path.join(parentDirectoryPath, directoryName);
    if (!(await fs.pathExists(directoryPath))) {
      return directoryPath;
    }

    index += 1;
  }
}

async function saveBase64Artifact(runDirectories, base64Payload, options = {}) {
  const extension = options.extension || KIND_EXTENSIONS[options.kind || PORT_KIND_FILE] || '.bin';
  const filePath = await nextAvailableFilePath(runDirectories.artifactsDir, options.baseName || options.displayName || 'artifact', extension);
  await fs.writeFile(filePath, Buffer.from(normalizeBase64Payload(base64Payload), 'base64'));
  return buildFileArtifact(filePath, {
    audio: options.audio,
    audioGeneration: options.audioGeneration,
    audioTransformation: options.audioTransformation,
    displayName: options.displayName,
    imageTransformation: options.imageTransformation,
    kind: options.kind,
    role: options.role || 'generated',
  });
}

async function saveBufferArtifact(runDirectories, bufferPayload, options = {}) {
  const extension = options.extension || KIND_EXTENSIONS[options.kind || PORT_KIND_FILE] || '.bin';
  const filePath = await nextAvailableFilePath(runDirectories.artifactsDir, options.baseName || options.displayName || 'artifact', extension);
  const buffer = Buffer.isBuffer(bufferPayload)
    ? bufferPayload
    : bufferPayload instanceof ArrayBuffer
      ? Buffer.from(bufferPayload)
      : ArrayBuffer.isView(bufferPayload)
        ? Buffer.from(bufferPayload.buffer, bufferPayload.byteOffset, bufferPayload.byteLength)
        : Buffer.from(bufferPayload || '');
  await fs.writeFile(filePath, buffer);
  return buildFileArtifact(filePath, {
    audio: options.audio,
    audioGeneration: options.audioGeneration,
    audioTransformation: options.audioTransformation,
    displayName: options.displayName,
    imageTransformation: options.imageTransformation,
    kind: options.kind,
    role: options.role || 'generated',
  });
}

async function saveTextArtifactMetadata(filePath, artifact) {
  const transcription = artifact?.transcription || null;
  if (!transcription) {
    return [];
  }

  const metadataPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.transcription.json`);
  const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
  await fs.writeJson(metadataPath, {
    backend: String(transcription.backend || '').trim() || 'whisper',
    backendLabel: String(transcription.backendLabel || '').trim() || 'Whisper (faster-whisper)',
    durationSeconds: Number.isFinite(Number(transcription.durationSeconds)) && Number(transcription.durationSeconds) > 0
      ? Math.round(Number(transcription.durationSeconds) * 100) / 100
      : null,
    language: String(transcription.language || '').trim() || 'unknown',
    model: String(transcription.model || '').trim() || '',
    runtime: transcription.runtime ? serializeArtifactForUi(transcription.runtime) : null,
    segmentCount: Number(transcription.segmentCount || segments.length) || segments.length,
    segments: serializeArtifactForUi(segments),
    sourceAudio: transcription.sourceAudio
      ? serializeArtifactForUi({
          displayName: transcription.sourceAudio.displayName || '',
          fileName: transcription.sourceAudio.fileName || '',
          filePath: transcription.sourceAudio.filePath || '',
          formatLabel: transcription.sourceAudio.formatLabel || '',
          mimeType: transcription.sourceAudio.mimeType || '',
          sizeBytes: Number(transcription.sourceAudio.sizeBytes || 0) || 0,
        })
      : null,
    text: String(artifact.text || ''),
  }, { spaces: 2 });

  return [metadataPath];
}


async function saveAudioArtifactMetadata(filePath, artifact) {
  const audio = serializeAudioDetailsForUi(artifact?.audio);
  const audioGeneration = serializeAudioGenerationForUi(artifact?.audioGeneration);
  const audioTransformation = serializeAudioTransformationForUi(artifact?.audioTransformation);
  if (!audio && !audioGeneration && !audioTransformation) {
    return [];
  }

  const metadataPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.audio.json`);
  await fs.writeJson(metadataPath, {
    audio,
    audioGeneration,
    audioTransformation,
    displayName: String(artifact?.displayName || '').trim(),
    fileName: String(artifact?.fileName || '').trim(),
    formatLabel: String(artifact?.formatLabel || '').trim(),
    kind: String(artifact?.kind || PORT_KIND_AUDIO).trim() || PORT_KIND_AUDIO,
    summary: String(artifact?.summary || '').trim(),
  }, { spaces: 2 });

  return [metadataPath];
}

async function saveImageArtifactMetadata(filePath, artifact) {
  const imageTransformation = serializeImageTransformationForUi(artifact?.imageTransformation);
  if (!imageTransformation) {
    return [];
  }

  const metadataPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.image.json`);
  await fs.writeJson(metadataPath, {
    displayName: String(artifact?.displayName || '').trim(),
    fileName: String(artifact?.fileName || '').trim(),
    formatLabel: String(artifact?.formatLabel || '').trim(),
    height: Number(artifact?.height || 0) || 0,
    imageTransformation,
    kind: String(artifact?.kind || PORT_KIND_IMAGE).trim() || PORT_KIND_IMAGE,
    summary: String(artifact?.summary || '').trim(),
    width: Number(artifact?.width || 0) || 0,
  }, { spaces: 2 });

  return [metadataPath];
}

async function saveVideoArtifactMetadata(filePath, artifact) {
  const compositionExport = artifact?.compositionExport && typeof artifact.compositionExport === 'object'
    ? serializeArtifactForUi(artifact.compositionExport)
    : null;
  if (!compositionExport) {
    return [];
  }

  const metadataPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.composition-export.json`);
  await fs.writeJson(metadataPath, {
    compositionExport,
    displayName: String(artifact?.displayName || '').trim(),
    fileName: String(artifact?.fileName || '').trim(),
    formatLabel: String(artifact?.formatLabel || '').trim(),
    kind: String(artifact?.kind || PORT_KIND_VIDEO).trim() || PORT_KIND_VIDEO,
    summary: String(artifact?.summary || '').trim(),
  }, { spaces: 2 });

  return [metadataPath];
}

async function saveArtifactIntoDirectory(directoryPath, artifact, options = {}) {
  const itemIndex = Number(options.itemIndex || 0) || 0;
  const baseName = `${String(itemIndex + 1).padStart(3, '0')}-${sanitizeSegment(options.baseName || artifact?.displayName || artifact?.fileName || artifact?.kind || 'item', 'item')}`;
  if (artifact.kind === PORT_KIND_TEXT) {
    const filePath = await nextAvailableFilePath(directoryPath, baseName, '.txt');
    await fs.writeFile(filePath, `${artifact.text || ''}\n`, 'utf8');
    const metadataPaths = await saveTextArtifactMetadata(filePath, artifact);
    const savedArtifact = createTextArtifact(artifact.text || '', {
      displayName: artifact.displayName || options.baseName || 'Text',
      role: options.role || artifact.role || 'artifact',
      transcription: artifact.transcription,
      metadataPaths,
    });
    savedArtifact.fileName = path.basename(filePath);
    savedArtifact.filePath = filePath;
    savedArtifact.fileUrl = pathToFileURL(filePath).toString();
    savedArtifact.mimeType = 'text/plain';
    savedArtifact.summary = summarizeArtifact(savedArtifact);
    return savedArtifact;
  }

  const sourcePath = path.resolve(String(artifact?.filePath || '').trim());
  if (!sourcePath) {
    throw new Error('Local AI Hub could not save one of the collection items because its file path is missing.');
  }

  const extension = path.extname(sourcePath) || KIND_EXTENSIONS[artifact.kind] || '.bin';
  const filePath = await nextAvailableFilePath(directoryPath, baseName, extension);
  await fs.copy(sourcePath, filePath, { overwrite: true });

  const metadataPaths = artifact.kind === PORT_KIND_AUDIO
    ? await saveAudioArtifactMetadata(filePath, artifact)
    : artifact.kind === PORT_KIND_IMAGE
      ? await saveImageArtifactMetadata(filePath, artifact)
      : artifact.kind === PORT_KIND_VIDEO
        ? await saveVideoArtifactMetadata(filePath, artifact)
        : [];

  const savedArtifact = await buildFileArtifact(filePath, {
    audio: artifact.audio,
    audioGeneration: artifact.audioGeneration,
    audioTransformation: artifact.audioTransformation,
    compositionExport: artifact.compositionExport,
    displayName: artifact.displayName || options.baseName || path.basename(filePath),
    imageTransformation: artifact.imageTransformation,
    kind: artifact.kind,
    role: options.role || artifact.role || 'artifact',
  });
  if (metadataPaths.length) {
    savedArtifact.metadataPaths = metadataPaths;
  }
  savedArtifact.sourcePath = sourcePath;
  savedArtifact.summary = summarizeArtifact(savedArtifact);
  return savedArtifact;
}

function buildCollectionManifestItem(entry, directoryPath) {
  const artifact = entry?.artifact || null;
  const metadataPaths = Array.isArray(artifact?.metadataPaths) ? artifact.metadataPaths : [];
  return {
    itemId: entry?.itemId || '',
    index: Number(entry?.index || 0) || 0,
    summary: String(entry?.summary || summarizeArtifact(artifact)).trim(),
    lineage: entry?.lineage ? serializeArtifactForUi(entry.lineage) : null,
    artifact: serializeArtifactForUi(artifact),
    artifactPath: String(artifact?.filePath || '').trim(),
    relativeArtifactPath: artifact?.filePath ? path.relative(directoryPath, artifact.filePath) : '',
    metadataPaths: metadataPaths.map((value) => String(value || '').trim()).filter(Boolean),
    relativeMetadataPaths: metadataPaths.map((value) => path.relative(directoryPath, value)).filter(Boolean),
  };
}

function buildCompositionManifestTrack(track, directoryPath) {
  if (String(track?.kind || '').trim() === 'visual-sequence') {
    return {
      id: String(track?.id || '').trim(),
      itemCount: Number(track?.itemCount || track?.items?.length || 0) || 0,
      itemDurationSeconds: Number(track?.itemDurationSeconds || 0) || 0,
      itemKind: String(track?.itemKind || '').trim(),
      kind: 'visual-sequence',
      order: String(track?.order || 'explicit').trim() || 'explicit',
      role: String(track?.role || '').trim(),
      sourceCollection: track?.sourceCollection ? serializeArtifactForUi(track.sourceCollection) : null,
      summary: String(track?.summary || '').trim(),
      items: (Array.isArray(track?.items) ? track.items : []).map((entry) => ({
        artifact: serializeArtifactForUi(entry?.artifact || null),
        artifactPath: String(entry?.artifact?.filePath || '').trim(),
        durationSeconds: Number(entry?.durationSeconds || 0) || 0,
        index: Number(entry?.index || 0) || 0,
        itemId: String(entry?.itemId || '').trim(),
        lineage: entry?.lineage ? serializeArtifactForUi(entry.lineage) : null,
        relativeArtifactPath: entry?.artifact?.filePath ? path.relative(directoryPath, entry.artifact.filePath) : '',
        summary: String(entry?.summary || summarizeArtifact(entry?.artifact || null)).trim(),
      })),
    };
  }

  if (String(track?.kind || '').trim() === 'audio') {
    const artifact = track?.artifact || null;
    const metadataPaths = Array.isArray(artifact?.metadataPaths) ? artifact.metadataPaths : [];
    return {
      artifact: serializeArtifactForUi(artifact),
      artifactPath: String(artifact?.filePath || '').trim(),
      id: String(track?.id || '').trim(),
      kind: 'audio',
      metadataPaths: metadataPaths.map((value) => String(value || '').trim()).filter(Boolean),
      relativeArtifactPath: artifact?.filePath ? path.relative(directoryPath, artifact.filePath) : '',
      relativeMetadataPaths: metadataPaths.map((value) => path.relative(directoryPath, value)).filter(Boolean),
      role: String(track?.role || '').trim(),
      summary: String(track?.summary || summarizeArtifact(artifact)).trim(),
    };
  }

  return serializeArtifactForUi(track);
}

async function persistCompositionArtifact(runDirectories, artifact, options = {}) {
  const targetRoot = options.target === 'outputs' ? runDirectories.outputsDir : runDirectories.artifactsDir;
  const directoryPath = await nextAvailableDirectoryPath(targetRoot, String(options.baseName || options.title || artifact?.displayName || 'composition') + '-composition');
  await fs.ensureDir(directoryPath);

  const manifestPath = path.join(directoryPath, 'manifest.json');
  const savedComposition = createCompositionArtifact({
    displayName: options.displayName || options.title || artifact?.displayName || 'Media Composition',
    exportKind: artifact?.composition?.exportKind,
    recipeId: artifact?.composition?.recipeId,
    recipeLabel: artifact?.composition?.recipeLabel,
    role: artifact?.role,
    tracks: serializeArtifactForUi(artifact?.composition?.tracks || []),
  }, {
    destinationPath: options.target === 'outputs' ? directoryPath : '',
    directoryPath,
    displayName: options.displayName || options.title || artifact?.displayName || 'Media Composition',
    manifestPath,
    metadataPaths: [manifestPath],
    role: options.role || artifact?.role || (options.target === 'outputs' ? 'output' : 'artifact'),
  });

  await fs.writeJson(manifestPath, {
    composition: serializeArtifactForUi(savedComposition.composition),
    displayName: savedComposition.displayName,
    kind: PORT_KIND_COMPOSITION,
    role: savedComposition.role,
    schemaVersion: 1,
    summary: savedComposition.summary,
    trackCount: savedComposition.trackCount,
    tracks: getCompositionTracks(savedComposition).map((track) => buildCompositionManifestTrack(track, directoryPath)),
  }, { spaces: 2 });

  return savedComposition;
}

async function persistArtifactCollection(runDirectories, artifact, options = {}) {
  const targetRoot = options.target === 'outputs' ? runDirectories.outputsDir : runDirectories.artifactsDir;
  const directoryPath = await nextAvailableDirectoryPath(targetRoot, String(options.baseName || options.title || artifact?.displayName || 'collection') + '-collection');
  const itemsDirectoryPath = path.join(directoryPath, 'items');
  await fs.ensureDir(directoryPath);
  if (options.copyItems) {
    await fs.ensureDir(itemsDirectoryPath);
  }

  const sourceItems = Array.isArray(artifact?.items) ? artifact.items : [];
  const normalizedItems = [];
  for (let index = 0; index < sourceItems.length; index += 1) {
    const entry = sourceItems[index];
    const itemArtifact = entry?.artifact || null;
    if (!itemArtifact) {
      continue;
    }

    const savedArtifact = options.copyItems
      ? await saveArtifactIntoDirectory(itemsDirectoryPath, itemArtifact, {
          baseName: itemArtifact.displayName || itemArtifact.fileName || artifact?.itemKind || 'item',
          itemIndex: index,
          role: options.itemRole || itemArtifact.role || 'artifact',
        })
      : serializeArtifactForUi(itemArtifact);
    if (savedArtifact) {
      savedArtifact.summary = summarizeArtifact(savedArtifact);
    }
    normalizedItems.push({
      artifact: savedArtifact,
      itemId: String(entry?.itemId || buildCollectionItemId(savedArtifact, index)).trim() || buildCollectionItemId(savedArtifact, index),
      lineage: normalizeCollectionLineage(entry?.lineage),
    });
  }

  const manifestPath = path.join(directoryPath, 'manifest.json');
  const savedCollection = createArtifactCollection(normalizedItems, {
    accumulation: artifact?.accumulation,
    destinationPath: options.target === 'outputs' ? directoryPath : '',
    directoryPath,
    displayName: options.displayName || options.title || artifact?.displayName || 'Collection',
    itemKind: artifact?.itemKind,
    manifestPath,
    metadataPaths: [manifestPath],
    role: options.role || artifact?.role || (options.target === 'outputs' ? 'output' : 'artifact'),
  });

  await fs.writeJson(manifestPath, {
    schemaVersion: 1,
    kind: PORT_KIND_COLLECTION,
    itemCount: savedCollection.itemCount,
    itemKind: savedCollection.itemKind,
    displayName: savedCollection.displayName,
    order: savedCollection.order,
    role: savedCollection.role,
    summary: savedCollection.summary,
    accumulation: savedCollection.accumulation ? serializeArtifactForUi(savedCollection.accumulation) : null,
    items: savedCollection.items.map((entry) => buildCollectionManifestItem(entry, directoryPath)),
  }, { spaces: 2 });

  return savedCollection;
}

async function copyArtifactToOutput(artifact, runDirectories, options = {}) {
  const title = String(options.title || artifact?.displayName || 'result').trim() || 'result';
  if (isCompositionArtifact(artifact)) {
    return persistCompositionArtifact(runDirectories, artifact, {
      baseName: title,
      displayName: title,
      role: 'output',
      target: 'outputs',
      title,
    });
  }

  if (isArtifactCollection(artifact)) {
    return persistArtifactCollection(runDirectories, artifact, {
      baseName: title,
      copyItems: true,
      displayName: title,
      itemRole: 'output',
      role: 'output',
      target: 'outputs',
      title,
    });
  }

  if (artifact.kind === PORT_KIND_TEXT) {
    const filePath = await nextAvailableFilePath(runDirectories.outputsDir, title, '.txt');
    await fs.writeFile(filePath, `${artifact.text || ''}\n`, 'utf8');
    const metadataPaths = await saveTextArtifactMetadata(filePath, artifact);
    const savedArtifact = createTextArtifact(artifact.text || '', {
      displayName: title,
      role: 'output',
      transcription: artifact.transcription,
      metadataPaths,
    });
    savedArtifact.fileName = path.basename(filePath);
    savedArtifact.filePath = filePath;
    savedArtifact.fileUrl = pathToFileURL(filePath).toString();
    savedArtifact.mimeType = 'text/plain';
    savedArtifact.destinationPath = filePath;
    savedArtifact.sourcePath = artifact.filePath || '';
    savedArtifact.summary = summarizeArtifact(savedArtifact);
    return savedArtifact;
  }

  const sourcePath = path.resolve(String(artifact.filePath || '').trim());
  const extension = path.extname(sourcePath) || KIND_EXTENSIONS[artifact.kind] || '.bin';
  const filePath = await nextAvailableFilePath(runDirectories.outputsDir, title, extension);
  await fs.copy(sourcePath, filePath, { overwrite: true });

  const metadataPaths = artifact.kind === PORT_KIND_AUDIO
    ? await saveAudioArtifactMetadata(filePath, artifact)
    : artifact.kind === PORT_KIND_IMAGE
      ? await saveImageArtifactMetadata(filePath, artifact)
      : artifact.kind === PORT_KIND_VIDEO
        ? await saveVideoArtifactMetadata(filePath, artifact)
        : [];

  const savedArtifact = await buildFileArtifact(filePath, {
    audio: artifact.audio,
    audioGeneration: artifact.audioGeneration,
    audioTransformation: artifact.audioTransformation,
    compositionExport: artifact.compositionExport,
    displayName: title,
    imageTransformation: artifact.imageTransformation,
    kind: artifact.kind,
    role: 'output',
  });
  if (metadataPaths.length) {
    savedArtifact.metadataPaths = metadataPaths;
  }
  savedArtifact.destinationPath = filePath;
  savedArtifact.sourcePath = sourcePath;
  savedArtifact.summary = summarizeArtifact(savedArtifact);
  return savedArtifact;
}

function buildTerminalResult(node, artifact) {
  const supportingPaths = [
    ...(Array.isArray(artifact?.metadataPaths) ? artifact.metadataPaths : []),
    ...((Array.isArray(artifact?.items)
      ? artifact.items.flatMap((entry) => Array.isArray(entry?.artifact?.metadataPaths) ? entry.artifact.metadataPaths : [])
      : [])),
  ].map((entry) => String(entry || '').trim()).filter(Boolean);
  return {
    artifact: serializeArtifactForUi(artifact),
    audio: artifact?.audio ? serializeArtifactForUi(artifact.audio) : null,
    audioGeneration: artifact?.audioGeneration ? serializeArtifactForUi(artifact.audioGeneration) : null,
    audioTransformation: artifact?.audioTransformation ? serializeArtifactForUi(artifact.audioTransformation) : null,
    destinationPath: artifact?.destinationPath || artifact?.directoryPath || artifact?.filePath || '',
    directoryPath: artifact?.directoryPath || '',
    imageTransformation: artifact?.imageTransformation ? serializeArtifactForUi(artifact.imageTransformation) : null,
    filePath: artifact?.filePath || '',
    fileUrl: artifact?.fileUrl || '',
    itemCount: Number(artifact?.itemCount || 0) || 0,
    itemKind: String(artifact?.itemKind || '').trim(),
    kind: artifact?.kind || PORT_KIND_FILE,
    manifestPath: artifact?.manifestPath || '',
    nodeId: node.id,
    nodeLabel: node.label,
    previewText: summarizeArtifact(artifact),
    supportingPaths: [...new Set(supportingPaths)],
    textValue: artifact?.kind === PORT_KIND_TEXT ? String(artifact.text || '') : '',
    title: String(node.config?.title || node.label || 'Output').trim() || 'Output',
    transcription: artifact?.transcription ? serializeArtifactForUi(artifact.transcription) : null,
  };
}

async function describeArtifactForLlm(artifact) {
  if (!artifact) {
    return 'No artifact was available.';
  }

  if (isArtifactCollection(artifact)) {
    const lines = [
      'Type: ordered collection',
      artifact.itemKind ? `Item type: ${artifact.itemKind}` : '',
      Number(artifact.itemCount || 0) ? `Item count: ${artifact.itemCount}` : '',
      artifact.displayName ? `Name: ${artifact.displayName}` : '',
      artifact.summary ? `Summary: ${artifact.summary}` : '',
      artifact.manifestPath ? `Manifest: ${artifact.manifestPath}` : '',
      '',
      'Items:',
      ...(artifact.items || []).slice(0, 8).map((entry, index) => {
        const itemArtifact = entry?.artifact || null;
        const lineage = entry?.lineage || null;
        const sourceLabel = lineage?.sourceNodeLabel || lineage?.sourceNodeId || '';
        const itemSummary = summarizeArtifact(itemArtifact, 120) || itemArtifact?.displayName || itemArtifact?.fileName || 'Item ' + (index + 1);
        return `${index + 1}. ${itemSummary}${sourceLabel ? ` (from ${sourceLabel})` : ''}`;
      }),
      (artifact.items || []).length > 8 ? `...and ${(artifact.items || []).length - 8} more items.` : '',
    ].filter(Boolean);
    return lines.join('\n').trim();
  }

  if (artifact.kind === PORT_KIND_TEXT) {
    const transcription = artifact.transcription || null;
    if (!transcription) {
      return `Type: text\nContent:\n${artifact.text || ''}`.trim();
    }

    const lines = [
      'Type: text',
      'Origin: audio transcription',
      transcription.backendLabel ? `Backend: ${transcription.backendLabel}` : '',
      transcription.model ? `Model: ${transcription.model}` : '',
      transcription.language ? `Language: ${transcription.language}` : '',
      transcription.segmentCount ? `Segments: ${transcription.segmentCount}` : '',
      transcription.durationSeconds ? `Duration: ${transcription.durationSeconds} seconds` : '',
      transcription.sourceAudio?.fileName ? `Source audio: ${transcription.sourceAudio.fileName}` : '',
      transcription.sourceAudio?.filePath ? `Source path: ${transcription.sourceAudio.filePath}` : '',
      '',
      'Content:',
      artifact.text || '',
    ].filter((entry, index, entries) => entry || index === entries.length - 2);
    return lines.join('\n').trim();
  }

  const lines = [
    `Type: ${artifact.kind}`,
    artifact.displayName ? `Name: ${artifact.displayName}` : '',
    artifact.fileName ? `File name: ${artifact.fileName}` : '',
    artifact.mimeType ? `MIME type: ${artifact.mimeType}` : '',
    artifact.extension ? `Extension: ${artifact.extension}` : '',
    artifact.formatLabel ? `Format: ${artifact.formatLabel}` : '',
    artifact.previewKind ? `Preview kind: ${artifact.previewKind}` : '',
    artifact.isAnimated ? 'Animation: animated' : '',
    artifact.role ? `Role: ${artifact.role}` : '',
    artifact.filePath ? `Path: ${artifact.filePath}` : '',
    artifact.width && artifact.height ? `Dimensions: ${artifact.width}x${artifact.height}` : '',
    artifact.audio?.durationSeconds ? `Duration: ${artifact.audio.durationSeconds} seconds` : '',
    artifact.audio?.sampleRate ? `Sample rate: ${artifact.audio.sampleRate} Hz` : '',
    artifact.audio?.channelCount ? `Channels: ${artifact.audio.channelCount}` : '',
    artifact.audio?.bitDepth ? `Bit depth: ${artifact.audio.bitDepth}` : '',
    artifact.audioTransformation?.backendLabel ? `Transformed by: ${artifact.audioTransformation.backendLabel}` : '',
    artifact.audioTransformation?.toolLabel ? `Transform tool: ${artifact.audioTransformation.toolLabel}` : '',
    artifact.audioTransformation?.model ? `Transform model: ${artifact.audioTransformation.model}` : '',
    artifact.audioTransformation?.transformationType ? `Transform type: ${artifact.audioTransformation.transformationType}` : '',
    artifact.audioTransformation?.targetVoice ? `Target voice: ${artifact.audioTransformation.targetVoice}` : '',
    artifact.audioTransformation?.instruction ? `Transform note: ${artifact.audioTransformation.instruction}` : '',
    artifact.audioTransformation?.sourceAudio?.fileName ? `Source audio: ${artifact.audioTransformation.sourceAudio.fileName}` : '',
    artifact.imageTransformation?.backendLabel ? `Image transformed by: ${artifact.imageTransformation.backendLabel}` : '',
    artifact.imageTransformation?.toolLabel ? `Image transform tool: ${artifact.imageTransformation.toolLabel}` : '',
    artifact.imageTransformation?.model ? `Image transform model: ${artifact.imageTransformation.model}` : '',
    artifact.imageTransformation?.transformationType ? `Image transform type: ${artifact.imageTransformation.transformationType}` : '',
    artifact.imageTransformation?.scale ? `Image transform scale: ${artifact.imageTransformation.scale}x` : '',
    artifact.imageTransformation?.instruction ? `Image transform note: ${artifact.imageTransformation.instruction}` : '',
    artifact.imageTransformation?.sourceImage?.fileName ? `Target image: ${artifact.imageTransformation.sourceImage.fileName}` : '',
    artifact.imageTransformation?.referenceImage?.fileName ? `Reference image: ${artifact.imageTransformation.referenceImage.fileName}` : '',
    artifact.audioGeneration?.backendLabel ? `Generated by: ${artifact.audioGeneration.backendLabel}` : '',
    artifact.audioGeneration?.toolLabel ? `Tool: ${artifact.audioGeneration.toolLabel}` : '',
    artifact.audioGeneration?.model ? `Model: ${artifact.audioGeneration.model}` : '',
    artifact.audioGeneration?.mode ? `Generation mode: ${artifact.audioGeneration.mode}` : '',
    artifact.audioGeneration?.prompt ? `Prompt: ${artifact.audioGeneration.prompt}` : '',
    artifact.audioGeneration?.voice ? `Voice: ${artifact.audioGeneration.voice}` : '',
    artifact.audioGeneration?.sourceAudio?.fileName ? `Guided by: ${artifact.audioGeneration.sourceAudio.fileName}` : '',
    artifact.sizeBytes ? `Size: ${artifact.sizeBytes} bytes` : '',
    artifact.previewText ? `Excerpt: ${artifact.previewText}` : '',
    artifact.summary ? `Summary: ${artifact.summary}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

module.exports = {
  buildFileArtifact,
  buildTerminalResult,
  copyArtifactToOutput,
  createArtifactCollection,
  createCompositionArtifact,
  createTextArtifact,
  describeArtifactForLlm,
  ensureRunDirectories,
  inferKindFromPath,
  isArtifactCollection,
  isCompositionArtifact,
  persistArtifactCollection,
  persistCompositionArtifact,
  saveBase64Artifact,
  saveBufferArtifact,
  sanitizeSegment,
  serializeArtifactForUi,
  summarizeArtifact,
};
