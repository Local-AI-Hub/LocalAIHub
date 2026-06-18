const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');

const { ensureStorage, getAppPaths } = require('./configService');
const { DEFAULT_PLANNING_SCHEMA_ID, getPlanningSchemaDefinition } = require('../shared/planningSchema.cjs');
const { serializePromptStyleApplication } = require('../shared/promptStyles.cjs');
const {
  PORT_KIND_AUDIO,
  PORT_KIND_COLLECTION,
  PORT_KIND_COMPOSITION,
  PORT_KIND_FILE,
  PORT_KIND_IMAGE,
  PORT_KIND_PLANNING_PACKET,
  PORT_KIND_PLAN,
  PORT_KIND_PREVIEW,
  PORT_KIND_AUDIT,
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
  '.bmp': 'image/bmp',
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
  [PORT_KIND_PLANNING_PACKET]: '.packet.json',
  [PORT_KIND_PLAN]: '.plan.json',
  [PORT_KIND_PREVIEW]: '.preview.json',
  [PORT_KIND_AUDIT]: '.audit.json',
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

  if (kind === PORT_KIND_PLANNING_PACKET) {
    return 'planning-packet';
  }

  if (kind === PORT_KIND_PLAN) {
    return 'plan';
  }

  if (kind === PORT_KIND_PREVIEW) {
    return 'preview';
  }

  if (kind === PORT_KIND_AUDIT) {
    return 'audit';
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
    case '.bmp':
      return 'BMP image';
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
    id: String(reference.id || reference.artifactId || '').trim(),
    kind: String(reference.kind || '').trim(),
    mimeType: String(reference.mimeType || '').trim(),
    sizeBytes: Number(reference.sizeBytes || 0) || 0,
    summary: String(reference.summary || '').trim(),
    width: Number(reference.width || 0) || 0,
  };

  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function serializeAudioGenerationSettings(settings = null) {
  if (!settings || typeof settings !== 'object') {
    return null;
  }

  const normalized = {
    cfgCoef: Number(settings.cfgCoef || 0) || 0,
    temperature: Number(settings.temperature || 0) || 0,
    topK: Number.isFinite(Number(settings.topK)) ? Math.max(0, Math.floor(Number(settings.topK))) : 0,
    topP: Number(settings.topP || 0) || 0,
    twoStepCfg: Boolean(settings.twoStepCfg),
  };

  return Object.entries(normalized).some(([, value]) => Boolean(value)) ? normalized : null;
}

function serializeAudioGenerationForUi(generation = null) {
  if (!generation || typeof generation !== 'object') {
    return null;
  }

  const durationSeconds = roundAudioMetric(generation.durationSeconds);
  const normalized = {
    advancedSettings: serializeAudioGenerationSettings(generation.advancedSettings),
    appendSource: Boolean(generation.appendSource),
    backend: String(generation.backend || '').trim(),
    backendLabel: String(generation.backendLabel || '').trim(),
    consentWarning: String(generation.consentWarning || '').trim(),
    consentWarningAcknowledged: Boolean(generation.consentWarningAcknowledged),
    consentWarningDisplayed: Boolean(generation.consentWarningDisplayed),
    device: String(generation.device || '').trim(),
    gpuName: String(generation.gpuName || '').trim(),
    packageVersion: String(generation.packageVersion || '').trim(),
    peakAllocatedMb: Number(generation.peakAllocatedMb || 0) || 0,
    peakReservedMb: Number(generation.peakReservedMb || 0) || 0,
    referenceAudio: serializeAudioSourceReference(generation.referenceAudio),
    referenceAudioPath: String(generation.referenceAudioPath || '').trim(),
    referenceDurationSeconds: roundAudioMetric(generation.referenceDurationSeconds),
    sampleRate: Number(generation.sampleRate || 0) || 0,
    collectionMap: generation.collectionMap && typeof generation.collectionMap === 'object' ? serializeArtifactForUi(generation.collectionMap) : null,
    collectionMapAudioChain: generation.collectionMapAudioChain && typeof generation.collectionMapAudioChain === 'object' ? serializeArtifactForUi(generation.collectionMapAudioChain) : null,
    collectionMapItemMode: String(generation.collectionMapItemMode || '').trim(),
    textLength: Math.max(0, Math.floor(Number(generation.textLength || 0) || 0)),
    torchVersion: String(generation.torchVersion || '').trim(),
    continuationRepeatCount: Math.max(0, Math.floor(Number(generation.continuationRepeatCount || generation.repeatCount || 0) || 0)),
    continuationRepeats: Array.isArray(generation.continuationRepeats) && generation.continuationRepeats.length ? serializeArtifactForUi(generation.continuationRepeats) : null,
    continuationSeedSeconds: roundAudioMetric(generation.continuationSeedSeconds),
    durationSeconds,
    finalOutputDurationSeconds: roundAudioMetric(generation.finalOutputDurationSeconds || generation.durationSeconds),
    generatedDurationSeconds: roundAudioMetric(generation.generatedDurationSeconds),
    lineage: generation.lineage && typeof generation.lineage === 'object' ? serializeArtifactForUi(generation.lineage) : null,
    mode: String(generation.mode || '').trim(),
    model: String(generation.model || '').trim(),
    operationId: String(generation.operationId || '').trim(),
    operationSubtype: String(generation.operationSubtype || generation.mode || '').trim(),
    prompt: String(generation.prompt || '').trim(),
    promptStyle: serializePromptStyleApplication(generation.promptStyle),
    repeatCount: Math.max(0, Math.floor(Number(generation.repeatCount || generation.continuationRepeatCount || 0) || 0)),
    requestedGeneratedDurationSeconds: roundAudioMetric(generation.requestedGeneratedDurationSeconds),
    sourceAudio: serializeAudioSourceReference(generation.sourceAudio),
    sourceAudioPath: String(generation.sourceAudioPath || '').trim(),
    sourceDurationSeconds: roundAudioMetric(generation.sourceDurationSeconds),
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
    operationId: String(transformation.operationId || '').trim(),
    operationSubtype: String(transformation.operationSubtype || transformation.transformationType || '').trim(),
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

function serializeAudioStitchForUi(stitch = null) {
  if (!stitch || typeof stitch !== 'object') {
    return null;
  }

  const normalized = {
    createdBy: stitch.createdBy && typeof stitch.createdBy === 'object' ? serializeArtifactForUi(stitch.createdBy) : null,
    crossfadeSeconds: roundAudioMetric(stitch.crossfadeSeconds),
    gapSeconds: roundAudioMetric(stitch.gapSeconds) || 0,
    outputFormat: String(stitch.outputFormat || 'wav').trim() || 'wav',
    sourceCollection: stitch.sourceCollection && typeof stitch.sourceCollection === 'object' ? serializeArtifactForUi(stitch.sourceCollection) : null,
    sourceItemCount: Number(stitch.sourceItemCount || 0) || 0,
    sourceItems: Array.isArray(stitch.sourceItems) ? serializeArtifactForUi(stitch.sourceItems) : [],
    totalDurationSeconds: roundAudioMetric(stitch.totalDurationSeconds),
  };

  return Object.entries(normalized).some(([, value]) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
}

function serializeAudioExtractionForUi(extraction = null) {
  if (!extraction || typeof extraction !== 'object') {
    return null;
  }

  const audio = serializeAudioDetailsForUi(extraction.audio);
  const normalized = {
    audio,
    backend: String(extraction.backend || 'ffmpeg').trim() || 'ffmpeg',
    backendLabel: String(extraction.backendLabel || 'Bundled ffmpeg').trim() || 'Bundled ffmpeg',
    channelCount: Number(extraction.channelCount || audio?.channelCount || 0) || 0,
    createdBy: extraction.createdBy && typeof extraction.createdBy === 'object' ? serializeArtifactForUi(extraction.createdBy) : null,
    durationSeconds: roundAudioMetric(extraction.durationSeconds || audio?.durationSeconds),
    ffmpegMode: String(extraction.ffmpegMode || '').trim(),
    operationId: String(extraction.operationId || 'extractAudio').trim() || 'extractAudio',
    outputFormat: String(extraction.outputFormat || 'wav').trim() || 'wav',
    sampleRate: Number(extraction.sampleRate || audio?.sampleRate || 0) || 0,
    sourceVideo: extraction.sourceVideo && typeof extraction.sourceVideo === 'object' ? serializeArtifactForUi(extraction.sourceVideo) : null,
  };

  return Object.entries(normalized).some(([, value]) => {
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
}

function serializeAudioNormalizationForUi(normalization = null) {
  if (!normalization || typeof normalization !== 'object') {
    return null;
  }

  const normalized = {
    backend: String(normalization.backend || 'ffmpeg').trim() || 'ffmpeg',
    backendLabel: String(normalization.backendLabel || 'Bundled ffmpeg').trim() || 'Bundled ffmpeg',
    channelCount: Number(normalization.channelCount || 0) || 0,
    channels: String(normalization.channels || '').trim(),
    codec: String(normalization.codec || normalization.pcmFormat || 'pcm_s16le').trim() || 'pcm_s16le',
    createdBy: normalization.createdBy && typeof normalization.createdBy === 'object' ? serializeArtifactForUi(normalization.createdBy) : null,
    durationSeconds: roundAudioMetric(normalization.durationSeconds),
    ffmpegMode: String(normalization.ffmpegMode || '').trim(),
    operation: String(normalization.operation || 'normalizeAudioCollection').trim() || 'normalizeAudioCollection',
    operationId: String(normalization.operationId || 'normalizeAudioCollection').trim() || 'normalizeAudioCollection',
    outputFormat: String(normalization.outputFormat || 'wav').trim() || 'wav',
    sampleRate: Number(normalization.sampleRate || 0) || 0,
    sourceAudio: normalization.sourceAudio && typeof normalization.sourceAudio === 'object' ? serializeArtifactForUi(normalization.sourceAudio) : null,
    sourceCollection: normalization.sourceCollection && typeof normalization.sourceCollection === 'object' ? serializeArtifactForUi(normalization.sourceCollection) : null,
    sourceItem: normalization.sourceItem && typeof normalization.sourceItem === 'object' ? serializeArtifactForUi(normalization.sourceItem) : null,
  };

  return Object.entries(normalized).some(([, value]) => {
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
}

function serializeVideoNormalizationForUi(normalization = null) {
  if (!normalization || typeof normalization !== 'object') {
    return null;
  }

  const normalized = {
    audioCodec: String(normalization.audioCodec || '').trim(),
    audioHandling: String(normalization.audioHandling || '').trim(),
    backend: String(normalization.backend || 'ffmpeg').trim() || 'ffmpeg',
    backendLabel: String(normalization.backendLabel || 'Bundled ffmpeg').trim() || 'Bundled ffmpeg',
    container: String(normalization.container || normalization.outputFormat || 'mp4').trim() || 'mp4',
    createdBy: normalization.createdBy && typeof normalization.createdBy === 'object' ? serializeArtifactForUi(normalization.createdBy) : null,
    ffmpegMode: String(normalization.ffmpegMode || '').trim(),
    fps: Number(normalization.fps || 0) || 0,
    height: Number(normalization.height || 0) || 0,
    operation: String(normalization.operation || 'normalizeVideoCollection').trim() || 'normalizeVideoCollection',
    operationId: String(normalization.operationId || 'normalizeVideoCollection').trim() || 'normalizeVideoCollection',
    outputFormat: String(normalization.outputFormat || 'mp4').trim() || 'mp4',
    pixelFormat: String(normalization.pixelFormat || 'yuv420p').trim() || 'yuv420p',
    sourceCollection: normalization.sourceCollection && typeof normalization.sourceCollection === 'object' ? serializeArtifactForUi(normalization.sourceCollection) : null,
    sourceItem: normalization.sourceItem && typeof normalization.sourceItem === 'object' ? serializeArtifactForUi(normalization.sourceItem) : null,
    sourceVideo: normalization.sourceVideo && typeof normalization.sourceVideo === 'object' ? serializeArtifactForUi(normalization.sourceVideo) : null,
    videoCodec: String(normalization.videoCodec || 'libx264').trim() || 'libx264',
    width: Number(normalization.width || 0) || 0,
  };

  return Object.entries(normalized).some(([, value]) => {
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
}

function serializeImageNormalizationForUi(normalization = null) {
  if (!normalization || typeof normalization !== 'object') {
    return null;
  }

  const normalized = {
    backend: String(normalization.backend || 'ffmpeg').trim() || 'ffmpeg',
    backendLabel: String(normalization.backendLabel || 'Bundled ffmpeg').trim() || 'Bundled ffmpeg',
    createdBy: normalization.createdBy && typeof normalization.createdBy === 'object' ? serializeArtifactForUi(normalization.createdBy) : null,
    ffmpegMode: String(normalization.ffmpegMode || '').trim(),
    operation: String(normalization.operation || 'normalizeImage').trim() || 'normalizeImage',
    operationId: String(normalization.operationId || 'normalizeImage').trim() || 'normalizeImage',
    outputFormat: String(normalization.outputFormat || 'png').trim() || 'png',
    sourceCollection: normalization.sourceCollection && typeof normalization.sourceCollection === 'object' ? serializeArtifactForUi(normalization.sourceCollection) : null,
    sourceImage: normalization.sourceImage && typeof normalization.sourceImage === 'object' ? serializeArtifactForUi(normalization.sourceImage) : null,
    sourceItem: normalization.sourceItem && typeof normalization.sourceItem === 'object' ? serializeArtifactForUi(normalization.sourceItem) : null,
  };

  return Object.entries(normalized).some(([, value]) => {
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
}

function serializeCollectionNormalizationForUi(normalization = null) {
  if (!normalization || typeof normalization !== 'object') {
    return null;
  }
  const normalized = serializeArtifactForUi(normalization);
  normalized.operation = String(normalized.operation || normalized.operationId || '').trim();
  normalized.operationId = String(normalized.operationId || normalized.operation || '').trim();
  normalized.itemCount = Number(normalized.itemCount || 0) || 0;
  return Object.entries(normalized).some(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return true;
    return Boolean(value);
  }) ? normalized : null;
}

function serializeMediaTrimForUi(trim = null) {
  if (!trim || typeof trim !== 'object') {
    return null;
  }
  const normalized = serializeArtifactForUi(trim);
  normalized.operation = String(normalized.operation || normalized.operationId || 'trimMedia').trim() || 'trimMedia';
  normalized.operationId = String(normalized.operationId || normalized.operation || 'trimMedia').trim() || 'trimMedia';
  return Object.entries(normalized).some(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return true;
    return Boolean(value) || value === 0;
  }) ? normalized : null;
}

function serializeSubtitleBurnForUi(burn = null) {
  if (!burn || typeof burn !== 'object') {
    return null;
  }
  const normalized = serializeArtifactForUi(burn);
  normalized.operation = String(normalized.operation || normalized.operationId || 'burnSubtitles').trim() || 'burnSubtitles';
  normalized.operationId = String(normalized.operationId || normalized.operation || 'burnSubtitles').trim() || 'burnSubtitles';
  return Object.entries(normalized).some(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return true;
    return Boolean(value) || value === 0;
  }) ? normalized : null;
}

function serializeSubtitleExportForUi(exportData = null) {
  if (!exportData || typeof exportData !== 'object') {
    return null;
  }
  const normalized = serializeArtifactForUi(exportData);
  normalized.operation = String(normalized.operation || normalized.operationId || 'exportSubtitles').trim() || 'exportSubtitles';
  normalized.operationId = String(normalized.operationId || normalized.operation || 'exportSubtitles').trim() || 'exportSubtitles';
  return Object.entries(normalized).some(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return true;
    return Boolean(value) || value === 0;
  }) ? normalized : null;
}

function serializeVideoStitchForUi(stitch = null) {
  if (!stitch || typeof stitch !== 'object') {
    return null;
  }

  const normalized = {
    concatManifestPath: String(stitch.concatManifestPath || '').trim(),
    concatMode: String(stitch.concatMode || '').trim(),
    createdBy: stitch.createdBy && typeof stitch.createdBy === 'object' ? serializeArtifactForUi(stitch.createdBy) : null,
    ffmpegMode: String(stitch.ffmpegMode || '').trim(),
    operationId: String(stitch.operationId || '').trim(),
    outputFormat: String(stitch.outputFormat || 'mp4').trim() || 'mp4',
    sourceCollection: stitch.sourceCollection && typeof stitch.sourceCollection === 'object' ? serializeArtifactForUi(stitch.sourceCollection) : null,
    sourceItemCount: Number(stitch.sourceItemCount || 0) || 0,
    sourceItems: Array.isArray(stitch.sourceItems) ? serializeArtifactForUi(stitch.sourceItems) : [],
    totalDurationSeconds: roundAudioMetric(stitch.totalDurationSeconds),
  };

  return Object.entries(normalized).some(([, value]) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
}
function serializeVideoFrameExtractionForUi(extraction = null) {
  if (!extraction || typeof extraction !== 'object') {
    return null;
  }

  const timestamp = Number(extraction.timestampSeconds);
  const normalized = {
    backend: String(extraction.backend || 'ffmpeg').trim() || 'ffmpeg',
    backendLabel: String(extraction.backendLabel || 'Bundled ffmpeg').trim() || 'Bundled ffmpeg',
    createdBy: extraction.createdBy && typeof extraction.createdBy === 'object' ? serializeArtifactForUi(extraction.createdBy) : null,
    ffmpegMode: String(extraction.ffmpegMode || '').trim(),
    framePosition: ['last', 'timestamp'].includes(String(extraction.framePosition || 'first').trim()) ? String(extraction.framePosition || 'first').trim() : 'first',
    operationId: String(extraction.operationId || 'extractVideoFrame').trim() || 'extractVideoFrame',
    outputFormat: String(extraction.outputFormat || 'png').trim() || 'png',
    sourceVideo: extraction.sourceVideo && typeof extraction.sourceVideo === 'object' ? serializeArtifactForUi(extraction.sourceVideo) : null,
    timestampSeconds: Number.isFinite(timestamp) ? Math.round(timestamp * 1000) / 1000 : null,
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
    height: Number(reference.height || 0) || 0,
    id: String(reference.id || reference.artifactId || '').trim(),
    kind: String(reference.kind || '').trim(),
    mimeType: String(reference.mimeType || '').trim(),
    sizeBytes: Number(reference.sizeBytes || 0) || 0,
    summary: String(reference.summary || '').trim(),
    width: Number(reference.width || 0) || 0,
  };

  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function serializeImageGenerationForUi(generation = null) {
  if (!generation || typeof generation !== 'object') {
    return null;
  }

  const seed = Number(generation.seed || 0);
  const normalized = {
    backend: String(generation.backend || '').trim(),
    backendLabel: String(generation.backendLabel || '').trim(),
    cfgScale: Number(generation.cfgScale || 0) || 0,
    collectionMap: generation.collectionMap && typeof generation.collectionMap === 'object' ? serializeArtifactForUi(generation.collectionMap) : null,
    extension: String(generation.extension || '').trim(),
    height: Number(generation.height || 0) || 0,
    mimeType: String(generation.mimeType || '').trim(),
    model: String(generation.model || '').trim(),
    negativePrompt: String(generation.negativePrompt || '').trim(),
    operation: String(generation.operation || generation.operationSubtype || '').trim(),
    operationId: String(generation.operationId || '').trim(),
    operationSubtype: String(generation.operationSubtype || generation.operation || '').trim(),
    prompt: String(generation.prompt || '').trim(),
    promptStyle: serializePromptStyleApplication(generation.promptStyle),
    provider: String(generation.provider || generation.backend || '').trim(),
    quality: String(generation.quality || '').trim(),
    requestSettings: generation.requestSettings && typeof generation.requestSettings === 'object' ? serializeArtifactForUi(generation.requestSettings) : null,
    revisedPrompt: String(generation.revisedPrompt || '').trim(),
    safetyNotes: Array.isArray(generation.safetyNotes) ? generation.safetyNotes.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    seed: Number.isFinite(seed) ? seed : null,
    size: String(generation.size || '').trim(),
    sourceImage: serializeImageSourceReference(generation.sourceImage),
    sourceText: String(generation.sourceText || '').trim(),
    steps: Number(generation.steps || 0) || 0,
    toolId: String(generation.toolId || '').trim(),
    toolLabel: String(generation.toolLabel || '').trim(),
    width: Number(generation.width || 0) || 0,
  };

  return Object.entries(normalized).some(([, value]) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
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
    operationId: String(transformation.operationId || '').trim(),
    referenceImage: serializeImageSourceReference(transformation.referenceImage),
    scale: scale > 0 ? scale : null,
    sourceImage: serializeImageSourceReference(transformation.sourceImage),
    toolId: String(transformation.toolId || '').trim(),
    toolLabel: String(transformation.toolLabel || '').trim(),
    transformationType: String(transformation.transformationType || '').trim(),
    transformSubtype: String(transformation.transformSubtype || transformation.transformationType || '').trim(),
  };

  return Object.entries(normalized).some(([, value]) => {
    if (value && typeof value === 'object') {
      return true;
    }
    return Boolean(value);
  }) ? normalized : null;
}

function serializeVideoGenerationForUi(generation = null) {
  if (!generation || typeof generation !== 'object') {
    return null;
  }

  const fps = Number(generation.fps || 0) || 0;
  const seed = Number(generation.seed || 0);
  const steps = Number(generation.steps || 0) || 0;
  const normalized = {
    backend: String(generation.backend || '').trim(),
    backendLabel: String(generation.backendLabel || '').trim(),
    fps: fps > 0 ? fps : null,
    mode: String(generation.mode || generation.operationSubtype || '').trim(),
    model: String(generation.model || '').trim(),
    negativePrompt: String(generation.negativePrompt || '').trim(),
    operation: String(generation.operation || generation.operationSubtype || generation.mode || '').trim(),
    operationId: String(generation.operationId || '').trim(),
    operationSubtype: String(generation.operationSubtype || generation.mode || '').trim(),
    polling: generation.polling && typeof generation.polling === 'object' ? serializeArtifactForUi(generation.polling) : null,
    prompt: String(generation.prompt || '').trim(),
    promptStyle: serializePromptStyleApplication(generation.promptStyle),
    provider: String(generation.provider || generation.backend || '').trim(),
    providerOperationId: String(generation.providerOperationId || generation.operationName || '').trim(),
    providerRawStatusSummary: generation.providerRawStatusSummary && typeof generation.providerRawStatusSummary === 'object' ? serializeArtifactForUi(generation.providerRawStatusSummary) : null,
    quality: Number(generation.quality || 0) || null,
    collectionMap: generation.collectionMap && typeof generation.collectionMap === 'object' ? serializeArtifactForUi(generation.collectionMap) : null,
    collectionMapItemMode: String(generation.collectionMapItemMode || '').trim(),
    collectionMapVideoChain: generation.collectionMapVideoChain && typeof generation.collectionMapVideoChain === 'object' ? serializeArtifactForUi(generation.collectionMapVideoChain) : null,
    requestSettings: generation.requestSettings && typeof generation.requestSettings === 'object' ? serializeArtifactForUi(generation.requestSettings) : null,
    returnedVideo: generation.returnedVideo && typeof generation.returnedVideo === 'object' ? serializeArtifactForUi(generation.returnedVideo) : null,
    safetyNotes: Array.isArray(generation.safetyNotes) ? generation.safetyNotes.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    seed: Number.isFinite(seed) ? seed : null,
    size: String(generation.size || '').trim(),
    sourceInputImage: serializeImageSourceReference(generation.sourceInputImage),
    sourceImage: serializeImageSourceReference(generation.sourceImage),
    steps: steps > 0 ? steps : null,
    toolId: String(generation.toolId || '').trim(),
    toolLabel: String(generation.toolLabel || '').trim(),
    usedReferenceImage: Boolean(generation.usedReferenceImage),
    video: generation.video && typeof generation.video === 'object' ? serializeArtifactForUi(generation.video) : null,
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
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(extension)) {
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
    case PORT_KIND_PLANNING_PACKET:
      return 'Planning Packet';
    case PORT_KIND_PLAN:
      return 'Plan';
    case PORT_KIND_PREVIEW:
      return 'Preview';
    case PORT_KIND_AUDIT:
      return 'Audit';
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

function isPlanningPacketArtifact(artifact) {
  return artifact?.kind === PORT_KIND_PLANNING_PACKET && isRecord(artifact?.packet);
}

function isPlanArtifact(artifact) {
  return artifact?.kind === PORT_KIND_PLAN && isRecord(artifact?.plan);
}

function isPreviewArtifact(artifact) {
  return artifact?.kind === PORT_KIND_PREVIEW && isRecord(artifact?.preview);
}

function isAuditArtifact(artifact) {
  return artifact?.kind === PORT_KIND_AUDIT && isRecord(artifact?.audit);
}

function isCompositionArtifact(artifact) {
  return artifact?.kind === PORT_KIND_COMPOSITION && artifact?.composition && Array.isArray(artifact?.composition?.tracks);
}

function isRecord(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

function buildPlanningListSummary(values = [], limit = 3) {
  const entries = (Array.isArray(values) ? values : []).map((entry) => String(entry || '').trim()).filter(Boolean);
  if (!entries.length) {
    return '';
  }

  const visible = entries.slice(0, limit);
  const extraCount = entries.length > visible.length ? ' | +' + (entries.length - visible.length) + ' more' : '';
  return trimPreviewText(visible.join(' | ') + extraCount, 120);
}

function buildPlanningPacketSummary(artifact, limit = 180) {
  const packet = artifact?.packet && typeof artifact.packet === 'object' ? artifact.packet : {};
  const sourceCount = Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts.length : 0;
  const parts = [
    packet.schemaLabel || getPlanningSchemaDefinition(packet.schemaId || DEFAULT_PLANNING_SCHEMA_ID)?.label || 'Planning packet',
    sourceCount ? sourceCount + ' source' + (sourceCount === 1 ? '' : 's') : '',
    packet.goal || '',
    buildPlanningListSummary(packet.constraints),
  ].filter(Boolean);
  return trimPreviewText(parts.join(' | '), limit);
}

function buildPlanSummary(artifact, limit = 180) {
  const plan = artifact?.plan && typeof artifact.plan === 'object' ? artifact.plan : {};
  const schema = getPlanningSchemaDefinition(plan.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
  const sections = Array.isArray(plan.sections) ? plan.sections : [];
  const clips = Array.isArray(plan.clips) ? plan.clips : [];
  const overview = plan.overview && typeof plan.overview === 'object' ? plan.overview : {};
  const parts = [
    schema?.label || 'Plan',
    scenes.length ? scenes.length + ' scene' + (scenes.length === 1 ? '' : 's') : '',
    sections.length ? sections.length + ' section' + (sections.length === 1 ? '' : 's') : '',
    clips.length ? clips.length + ' clip' + (clips.length === 1 ? '' : 's') : '',
    overview.viewerTakeaway || '',
    plan.overallStyle || '',
    scenes[0]?.sceneConcept || sections[0]?.prompt || clips[0]?.prompt || '',
  ].filter(Boolean);
  return trimPreviewText(parts.join(' | '), limit);
}

function buildPreviewSummary(artifact, limit = 180) {
  const preview = artifact?.preview && typeof artifact.preview === 'object' ? artifact.preview : {};
  const scenes = Array.isArray(preview.scenes) ? preview.scenes : [];
  const parts = [
    preview.schemaLabel || 'Preview',
    scenes.length ? scenes.length + ' scene' + (scenes.length === 1 ? '' : 's') : '',
    scenes[0]?.summary || scenes[0]?.promptPreview || '',
    preview.limitationNote ? 'Review before generation' : '',
  ].filter(Boolean);
  return trimPreviewText(parts.join(' | '), limit);
}

function buildAuditSummary(artifact, limit = 180) {
  const audit = artifact?.audit && typeof artifact.audit === 'object' ? artifact.audit : {};
  const findings = Array.isArray(audit.findings) ? audit.findings : [];
  const summary = audit.summary && typeof audit.summary === 'object' ? audit.summary : {};
  const totalFlagCount = Number(summary.errorCount || 0) + Number(summary.warningCount || 0) + Number(summary.infoCount || 0);
  const parts = [
    audit.schemaLabel || 'Audit',
    audit.sceneCount ? audit.sceneCount + ' scene' + (audit.sceneCount === 1 ? '' : 's') : '',
    totalFlagCount ? totalFlagCount + ' finding' + (totalFlagCount === 1 ? '' : 's') : 'No findings',
    findings[0]?.title || '',
  ].filter(Boolean);
  return trimPreviewText(parts.join(' | '), limit);
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
  const sourceItemId = String(lineage.sourceItemId || '').trim();
  if (sourceItemId) {
    normalized.sourceItemId = sourceItemId;
  }
  const sourceItemIndex = Number(lineage.sourceItemIndex);
  if (Number.isInteger(sourceItemIndex) && sourceItemIndex >= 0) {
    normalized.sourceItemIndex = sourceItemIndex;
  }
  const parentLineage = normalizeCollectionLineage(lineage.parentLineage);
  if (parentLineage) {
    normalized.parentLineage = parentLineage;
  }

  return Object.values(normalized).some((value) => Boolean(value) || value === 0) ? normalized : null;
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
  const statusPrefix = artifact?.collectionStatus === 'partial' || artifact?.partial ? 'Partial collection: ' : '';
  const countLabel = statusPrefix + items.length + ' ' + itemKindLabel.toLowerCase() + (items.length === 1 ? ' item' : ' items');
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

  if (isPlanningPacketArtifact(artifact)) {
    return buildPlanningPacketSummary(artifact, limit);
  }

  if (isPlanArtifact(artifact)) {
    return buildPlanSummary(artifact, limit);
  }

  if (isPreviewArtifact(artifact)) {
    return buildPreviewSummary(artifact, limit);
  }

  if (isAuditArtifact(artifact)) {
    return buildAuditSummary(artifact, limit);
  }

  if (artifact.kind === PORT_KIND_TEXT) {
    const transcriptionSummary = buildTranscriptionSummary(artifact.transcription, limit);
    const imageAnalysis = artifact.imageAnalysis && typeof artifact.imageAnalysis === 'object' ? artifact.imageAnalysis : null;
    const imageAnalysisSummary = imageAnalysis ? ['Image analysis', imageAnalysis.backendLabel || imageAnalysis.backend || '', imageAnalysis.mode || ''].filter(Boolean).join(' | ') : '';
    const contextSummary = transcriptionSummary || imageAnalysisSummary;
    const textSummary = trimPreviewText(artifact.text || artifact.previewText || '', contextSummary ? Math.max(48, Math.floor(limit / 2)) : limit);
    return trimPreviewText([contextSummary, textSummary].filter(Boolean).join(' | '), limit);
  }

  if (artifact.kind === PORT_KIND_AUDIO) {
    const audio = artifact.audio && typeof artifact.audio === 'object' ? artifact.audio : null;
    const generation = artifact.audioGeneration && typeof artifact.audioGeneration === 'object' ? artifact.audioGeneration : null;
    const transformation = artifact.audioTransformation && typeof artifact.audioTransformation === 'object' ? artifact.audioTransformation : null;
    const stitch = artifact.audioStitch && typeof artifact.audioStitch === 'object' ? artifact.audioStitch : null;
    const extraction = artifact.audioExtraction && typeof artifact.audioExtraction === 'object' ? artifact.audioExtraction : null;
    const normalization = artifact.audioNormalization && typeof artifact.audioNormalization === 'object' ? artifact.audioNormalization : null;
    const details = [
      artifact.fileName || artifact.displayName || '',
      artifact.formatLabel || '',
      formatDurationSummary(audio?.durationSeconds || generation?.durationSeconds || transformation?.durationSeconds || stitch?.totalDurationSeconds),
      audio?.sampleRate ? `${audio.sampleRate} Hz` : '',
      buildAudioChannelLabel(audio?.channelCount),
      (transformation?.transformSubtype || transformation?.transformationType) ? String(transformation.transformSubtype || transformation.transformationType).replace(/-/g, ' ') : '',
      transformation?.toolLabel || transformation?.backendLabel || '',
      transformation?.targetVoice ? `Voice ${transformation.targetVoice}` : '',
      transformation?.sourceAudio?.fileName ? `Source ${transformation.sourceAudio.fileName}` : '',
      generation?.mode ? (generation.mode === 'sound' ? 'Sound generation' : generation.mode === 'speech' ? 'Speech generation' : 'Music generation') : '',
      generation?.toolLabel || generation?.backendLabel || '',
      generation?.voice ? `Voice ${generation.voice}` : '',
      generation?.sourceAudio?.fileName ? `Guided by ${generation.sourceAudio.fileName}` : '',
      extraction?.sourceVideo?.fileName ? `Extracted from ${extraction.sourceVideo.fileName}` : '',
      extraction?.ffmpegMode ? String(extraction.ffmpegMode).replace(/-/g, ' ') : '',
      normalization?.operationId ? 'normalized collection item' : '',
      normalization?.sampleRate ? `${normalization.sampleRate} Hz normalized` : '',
      stitch?.sourceItemCount ? `Stitched from ${stitch.sourceItemCount} clips` : '',
    ].filter(Boolean);
    return trimPreviewText(details.join(' | '), limit);
  }

  if (artifact.kind === PORT_KIND_IMAGE) {
    const transformation = artifact.imageTransformation && typeof artifact.imageTransformation === 'object' ? artifact.imageTransformation : null;
    const frameExtraction = artifact.videoFrameExtraction && typeof artifact.videoFrameExtraction === 'object' ? artifact.videoFrameExtraction : null;
    const normalization = artifact.imageNormalization && typeof artifact.imageNormalization === 'object' ? artifact.imageNormalization : null;
    const details = [
      artifact.fileName || artifact.displayName || '',
      artifact.formatLabel || '',
      artifact.width && artifact.height ? `${artifact.width}x${artifact.height}` : '',
      frameExtraction?.framePosition ? `${frameExtraction.framePosition} video frame` : '',
      frameExtraction?.sourceVideo?.fileName ? `Source ${frameExtraction.sourceVideo.fileName}` : '',
      (transformation?.transformSubtype || transformation?.transformationType) ? String(transformation.transformSubtype || transformation.transformationType).replace(/-/g, ' ') : '',
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

  if (artifact.kind === PORT_KIND_VIDEO && artifact.videoNormalization && typeof artifact.videoNormalization === 'object') {
    const normalization = artifact.videoNormalization;
    const details = [
      artifact.fileName || artifact.displayName || '',
      artifact.formatLabel || '',
      normalization.width && normalization.height ? String(normalization.width) + 'x' + String(normalization.height) : '',
      normalization.fps ? String(normalization.fps) + ' fps' : '',
      normalization.videoCodec || 'normalized video',
    ].filter(Boolean);
    return trimPreviewText(details.join(' | '), limit);
  }

  if (artifact.kind === PORT_KIND_VIDEO && artifact.videoStitch && typeof artifact.videoStitch === 'object') {
    const stitch = artifact.videoStitch;
    const details = [
      artifact.fileName || artifact.displayName || '',
      artifact.formatLabel || '',
      formatDurationSummary(stitch.totalDurationSeconds),
      stitch.sourceItemCount ? stitch.sourceItemCount + ' stitched clip' + (stitch.sourceItemCount === 1 ? '' : 's') : '',
      stitch.concatMode ? String(stitch.concatMode).replace(/-/g, ' ') : 'video stitch',
      stitch.ffmpegMode ? String(stitch.ffmpegMode).replace(/-/g, ' ') : '',
    ].filter(Boolean);
    return trimPreviewText(details.join(' | '), limit);
  }
  if (artifact.kind === PORT_KIND_VIDEO && artifact.videoGeneration && typeof artifact.videoGeneration === 'object') {
    const generation = artifact.videoGeneration;
    const details = [
      artifact.fileName || artifact.displayName || '',
      artifact.formatLabel || '',
      generation.size || (artifact.width && artifact.height ? artifact.width + 'x' + artifact.height : ''),
      generation.fps ? generation.fps + ' fps' : '',
      generation.operationSubtype ? String(generation.operationSubtype).replace(/-/g, ' ') : 'local video generation',
      generation.toolLabel || generation.backendLabel || '',
      generation.model ? 'Model ' + generation.model : '',
      generation.sourceImage?.fileName ? 'Source ' + generation.sourceImage.fileName : '',
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

function applyFinalOutputMetadata(artifact, options = {}) {
  if (!artifact || typeof artifact !== 'object') {
    return artifact;
  }

  const outputLabel = String(options.outputLabel || options.title || artifact.displayName || artifact.fileName || 'Output').trim() || 'Output';
  artifact.artifactRole = 'final';
  artifact.isFinalOutput = true;
  artifact.outputKind = String(options.outputKind || artifact.kind || '').trim();
  artifact.outputLabel = outputLabel;

  const outputNodeId = String(options.outputNodeId || '').trim();
  const outputPortId = String(options.outputPortId || '').trim();
  const runId = String(options.runId || '').trim();
  if (outputNodeId) {
    artifact.outputNodeId = outputNodeId;
  }
  if (outputPortId) {
    artifact.outputPortId = outputPortId;
  }
  if (runId) {
    artifact.runId = runId;
  }

  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

function createArtifactCollection(items, options = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const normalizedItems = sourceItems
    .map((entry, index) => {
      const itemArtifact = serializeArtifactForUi(entry?.artifact || entry);
      if (!itemArtifact) {
        return null;
      }

      const normalizedEntry = {
        artifact: itemArtifact,
        index,
        itemId: String(entry?.itemId || buildCollectionItemId(itemArtifact, index)).trim() || buildCollectionItemId(itemArtifact, index),
        lineage: normalizeCollectionLineage(entry?.lineage),
        summary: summarizeArtifact(itemArtifact),
      };
      if (entry?.metadata && typeof entry.metadata === 'object') {
        normalizedEntry.metadata = serializeArtifactForUi(entry.metadata);
      }
      if (Array.isArray(entry?.attempts) && entry.attempts.length) {
        normalizedEntry.attempts = serializeArtifactForUi(entry.attempts);
      }
      if (entry?.validation && typeof entry.validation === 'object') {
        normalizedEntry.validation = serializeArtifactForUi(entry.validation);
      }
      return normalizedEntry;
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

  const collectionStatus = String(options.collectionStatus || '').trim().toLowerCase() === 'partial' ? 'partial' : 'complete';
  const sourceItemCount = Math.max(0, Number(options.sourceItemCount || normalizedItems.length) || normalizedItems.length);
  const failedItems = Array.isArray(options.failedItems) ? serializeArtifactForUi(options.failedItems).filter(Boolean) : [];
  const collection = {
    kind: PORT_KIND_COLLECTION,
    itemKind,
    collectionStatus,
    partial: collectionStatus === 'partial',
    sourceItemCount,
    successfulItemCount: normalizedItems.length,
    failedItemCount: failedItems.length,
    failedItems,
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
  if (options.collectionMapping && typeof options.collectionMapping === 'object') {
    collection.collectionMapping = serializeArtifactForUi(options.collectionMapping);
  }
  if (options.metadata && typeof options.metadata === 'object') {
    collection.metadata = serializeArtifactForUi(options.metadata);
  }
  if (options.sourceCollection && typeof options.sourceCollection === 'object') {
    collection.sourceCollection = serializeArtifactForUi(options.sourceCollection);
  }
  const collectionNormalization = serializeCollectionNormalizationForUi(options.collectionNormalization);
  if (collectionNormalization) {
    collection.collectionNormalization = collectionNormalization;
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
              endSeconds: Number.isFinite(Number(entry?.endSeconds)) ? Math.round(Number(entry.endSeconds) * 1000) / 1000 : null,
              index,
              itemId: String(entry?.itemId || buildCollectionItemId(itemArtifact, index)).trim() || buildCollectionItemId(itemArtifact, index),
              lineage: normalizeCollectionLineage(entry?.lineage),
              metadata: entry?.metadata && typeof entry.metadata === 'object' ? serializeArtifactForUi(entry.metadata) : null,
              startSeconds: Number.isFinite(Number(entry?.startSeconds)) ? Math.round(Number(entry.startSeconds) * 1000) / 1000 : null,
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
              metadata: track.sourceCollection.metadata && typeof track.sourceCollection.metadata === 'object' ? serializeArtifactForUi(track.sourceCollection.metadata) : null,
              summary: String(track.sourceCollection.summary || '').trim(),
            }
          : null;

        return {
          id: String(track.id || 'visual-track').trim() || 'visual-track',
          itemCount: items.length,
          itemDurationSeconds: Number(track.itemDurationSeconds || items[0]?.durationSeconds || 0) || 0,
          imageTimingMode: String(track.imageTimingMode || '').trim(),
          itemKind: String(track.itemKind || PORT_KIND_IMAGE).trim() || PORT_KIND_IMAGE,
          items,
          kind: 'visual-sequence',
          order: 'explicit',
          role: trackRole || 'primary-visual',
          sceneTransitions: track.sceneTransitions && typeof track.sceneTransitions === 'object' ? serializeArtifactForUi(track.sceneTransitions) : (track.timing?.sceneTransitions && typeof track.timing.sceneTransitions === 'object' ? serializeArtifactForUi(track.timing.sceneTransitions) : null),
          sourceCollection,
          timing: track.timing && typeof track.timing === 'object' ? serializeArtifactForUi(track.timing) : null,
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
    compositionMode: String(compositionSpec.compositionMode || 'imageSlideshow').trim() || 'imageSlideshow',
    audioMix: compositionSpec.audioMix && typeof compositionSpec.audioMix === 'object' ? serializeArtifactForUi(compositionSpec.audioMix) : null,
    soundEffects: compositionSpec.soundEffects && typeof compositionSpec.soundEffects === 'object' ? serializeArtifactForUi(compositionSpec.soundEffects) : null,
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

  if (options.hyperFramesRender && typeof options.hyperFramesRender === 'object') {
    artifact.hyperFramesRender = serializeArtifactForUi(options.hyperFramesRender);
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

    const audioStitch = serializeAudioStitchForUi(options.audioStitch);
    if (audioStitch) {
      artifact.audioStitch = audioStitch;
      if (audioStitch.totalDurationSeconds && !artifact.audio?.durationSeconds) {
        artifact.audio = {
          ...(artifact.audio || {}),
          durationSeconds: audioStitch.totalDurationSeconds,
        };
      }
    }

    const audioExtraction = serializeAudioExtractionForUi(options.audioExtraction);
    if (audioExtraction) {
      artifact.audioExtraction = audioExtraction;
      if (audioExtraction.audio && !artifact.audio) {
        artifact.audio = audioExtraction.audio;
      }
    }

    const audioNormalization = serializeAudioNormalizationForUi(options.audioNormalization);
    if (audioNormalization) {
      artifact.audioNormalization = audioNormalization;
    }
    const mediaTrim = serializeMediaTrimForUi(options.mediaTrim);
    if (mediaTrim) {
      artifact.mediaTrim = mediaTrim;
    }
  }

  if (kind === PORT_KIND_IMAGE || String(mimeType || '').toLowerCase().startsWith('image/')) {
    const imageGeneration = serializeImageGenerationForUi(options.imageGeneration);
    if (imageGeneration) {
      artifact.imageGeneration = imageGeneration;
    }

    const imageTransformation = serializeImageTransformationForUi(options.imageTransformation);
    if (imageTransformation) {
      artifact.imageTransformation = imageTransformation;
    }

    const videoFrameExtraction = serializeVideoFrameExtractionForUi(options.videoFrameExtraction);
    if (videoFrameExtraction) {
      artifact.videoFrameExtraction = videoFrameExtraction;
    }

    const imageNormalization = serializeImageNormalizationForUi(options.imageNormalization);
    if (imageNormalization) {
      artifact.imageNormalization = imageNormalization;
    }
  }

  if (kind === PORT_KIND_FILE) {
    const subtitleExport = serializeSubtitleExportForUi(options.subtitleExport);
    if (subtitleExport) {
      artifact.subtitleExport = subtitleExport;
    }
  }

  if (kind === PORT_KIND_VIDEO || String(mimeType || '').toLowerCase().startsWith('video/')) {
    const videoGeneration = serializeVideoGenerationForUi(options.videoGeneration);
    if (videoGeneration) {
      artifact.videoGeneration = videoGeneration;
    }
    const videoStitch = serializeVideoStitchForUi(options.videoStitch);
    if (videoStitch) {
      artifact.videoStitch = videoStitch;
    }
    const videoNormalization = serializeVideoNormalizationForUi(options.videoNormalization);
    if (videoNormalization) {
      artifact.videoNormalization = videoNormalization;
      if (videoNormalization.width) artifact.width = videoNormalization.width;
      if (videoNormalization.height) artifact.height = videoNormalization.height;
      if (videoNormalization.fps) artifact.fps = videoNormalization.fps;
      if (videoNormalization.width && videoNormalization.height) artifact.size = String(videoNormalization.width) + 'x' + String(videoNormalization.height);
    }
    const mediaTrim = serializeMediaTrimForUi(options.mediaTrim);
    if (mediaTrim) {
      artifact.mediaTrim = mediaTrim;
    }
    const subtitleBurn = serializeSubtitleBurnForUi(options.subtitleBurn);
    if (subtitleBurn) {
      artifact.subtitleBurn = subtitleBurn;
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
  if (options.imageAnalysis) {
    artifact.imageAnalysis = serializeArtifactForUi(options.imageAnalysis);
  }

  if (Array.isArray(options.metadataPaths) && options.metadataPaths.length) {
    artifact.metadataPaths = [...new Set(options.metadataPaths.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }

  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

function createPlanningPacketArtifact(packet, options = {}) {
  const schema = getPlanningSchemaDefinition(packet?.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
  const artifact = {
    kind: PORT_KIND_PLANNING_PACKET,
    displayName: String(options.displayName || packet?.title || schema?.label || 'Planning Packet').trim() || 'Planning Packet',
    packet: serializeArtifactForUi(packet) || {},
    previewKind: 'planning-packet',
    role: options.role || 'artifact',
  };

  if (Array.isArray(options.metadataPaths) && options.metadataPaths.length) {
    artifact.metadataPaths = [...new Set(options.metadataPaths.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }

  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

function createPlanArtifact(plan, options = {}) {
  const schema = getPlanningSchemaDefinition(plan?.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
  const artifact = {
    kind: PORT_KIND_PLAN,
    displayName: String(options.displayName || plan?.title || schema?.label || 'Plan').trim() || 'Plan',
    plan: serializeArtifactForUi(plan) || {},
    previewKind: 'plan',
    role: options.role || 'artifact',
    sceneCount: Array.isArray(plan?.scenes) ? plan.scenes.length : 0,
    sectionCount: Array.isArray(plan?.sections) ? plan.sections.length : 0,
    clipCount: Array.isArray(plan?.clips) ? plan.clips.length : 0,
    schemaId: String(plan?.schemaId || schema?.id || DEFAULT_PLANNING_SCHEMA_ID).trim() || DEFAULT_PLANNING_SCHEMA_ID,
    schemaLabel: String(schema?.label || 'Plan').trim() || 'Plan',
  };

  if (options.planner) {
    artifact.planner = serializeArtifactForUi(options.planner);
  }

  if (options.sourcePacket) {
    artifact.sourcePacket = serializeArtifactForUi(options.sourcePacket);
  }

  if (Array.isArray(options.metadataPaths) && options.metadataPaths.length) {
    artifact.metadataPaths = [...new Set(options.metadataPaths.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }

  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

function createPreviewArtifact(preview, options = {}) {
  const schema = getPlanningSchemaDefinition(preview?.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
  const artifact = {
    kind: PORT_KIND_PREVIEW,
    displayName: String(options.displayName || preview?.planTitle || preview?.schemaLabel || 'Preview').trim() || 'Preview',
    preview: serializeArtifactForUi(preview) || {},
    previewKind: 'preview',
    role: options.role || 'artifact',
    sceneCount: Number(preview?.sceneCount || preview?.scenes?.length || 0) || 0,
    schemaId: String(preview?.schemaId || schema?.id || DEFAULT_PLANNING_SCHEMA_ID).trim() || DEFAULT_PLANNING_SCHEMA_ID,
    schemaLabel: String(preview?.schemaLabel || schema?.label || 'Preview').trim() || 'Preview',
  };

  if (options.sourcePlan) {
    artifact.sourcePlan = serializeArtifactForUi(options.sourcePlan);
  }

  if (options.sourcePacket) {
    artifact.sourcePacket = serializeArtifactForUi(options.sourcePacket);
  }

  if (Array.isArray(options.metadataPaths) && options.metadataPaths.length) {
    artifact.metadataPaths = [...new Set(options.metadataPaths.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }

  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

function createAuditArtifact(audit, options = {}) {
  const schema = getPlanningSchemaDefinition(audit?.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
  const artifact = {
    kind: PORT_KIND_AUDIT,
    audit: serializeArtifactForUi(audit) || {},
    displayName: String(options.displayName || audit?.planTitle || audit?.schemaLabel || 'Audit').trim() || 'Audit',
    findingCount: Array.isArray(audit?.findings) ? audit.findings.length : 0,
    previewKind: 'audit',
    role: options.role || 'artifact',
    sceneCount: Number(audit?.sceneCount || 0) || 0,
    schemaId: String(audit?.schemaId || schema?.id || DEFAULT_PLANNING_SCHEMA_ID).trim() || DEFAULT_PLANNING_SCHEMA_ID,
    schemaLabel: String(audit?.schemaLabel || schema?.label || 'Audit').trim() || 'Audit',
  };

  if (options.sourcePlan) {
    artifact.sourcePlan = serializeArtifactForUi(options.sourcePlan);
  }

  if (options.sourcePreview) {
    artifact.sourcePreview = serializeArtifactForUi(options.sourcePreview);
  }

  if (options.sourcePacket) {
    artifact.sourcePacket = serializeArtifactForUi(options.sourcePacket);
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
    imageGeneration: options.imageGeneration,
    imageTransformation: options.imageTransformation,
    kind: options.kind,
    role: options.role || 'generated',
    videoGeneration: options.videoGeneration,
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
    imageGeneration: options.imageGeneration,
    imageTransformation: options.imageTransformation,
    kind: options.kind,
    role: options.role || 'generated',
    videoGeneration: options.videoGeneration,
  });
}

async function saveTextArtifactMetadata(filePath, artifact) {
  const transcription = artifact?.transcription || null;
  const imageAnalysis = artifact?.imageAnalysis || null;
  if (!transcription && !imageAnalysis) {
    return [];
  }

  const metadataPaths = [];
  if (transcription) {
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
    metadataPaths.push(metadataPath);
  }

  if (imageAnalysis) {
    const metadataPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.image-analysis.json`);
    await fs.writeJson(metadataPath, {
      backend: String(imageAnalysis.backend || '').trim(),
      backendLabel: String(imageAnalysis.backendLabel || '').trim(),
      mode: String(imageAnalysis.mode || '').trim(),
      model: String(imageAnalysis.model || '').trim(),
      operationId: String(imageAnalysis.operationId || '').trim(),
      sourceImage: imageAnalysis.sourceImage ? serializeArtifactForUi(imageAnalysis.sourceImage) : null,
      text: String(artifact.text || ''),
    }, { spaces: 2 });
    metadataPaths.push(metadataPath);
  }

  return metadataPaths;
}


async function saveAudioArtifactMetadata(filePath, artifact) {
  const audio = serializeAudioDetailsForUi(artifact?.audio);
  const audioGeneration = serializeAudioGenerationForUi(artifact?.audioGeneration);
  const audioTransformation = serializeAudioTransformationForUi(artifact?.audioTransformation);
  const audioStitch = serializeAudioStitchForUi(artifact?.audioStitch);
  const audioExtraction = serializeAudioExtractionForUi(artifact?.audioExtraction);
  const audioNormalization = serializeAudioNormalizationForUi(artifact?.audioNormalization);
  const mediaTrim = serializeMediaTrimForUi(artifact?.mediaTrim);
  if (!audio && !audioGeneration && !audioTransformation && !audioStitch && !audioExtraction && !audioNormalization && !mediaTrim) {
    return [];
  }

  const metadataPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.audio.json`);
  await fs.writeJson(metadataPath, {
    audio,
    audioGeneration,
    audioTransformation,
    audioStitch,
    audioExtraction,
    audioNormalization,
    mediaTrim,
    displayName: String(artifact?.displayName || '').trim(),
    fileName: String(artifact?.fileName || '').trim(),
    formatLabel: String(artifact?.formatLabel || '').trim(),
    kind: String(artifact?.kind || PORT_KIND_AUDIO).trim() || PORT_KIND_AUDIO,
    summary: String(artifact?.summary || '').trim(),
  }, { spaces: 2 });

  return [metadataPath];
}

async function saveImageArtifactMetadata(filePath, artifact) {
  const imageGeneration = serializeImageGenerationForUi(artifact?.imageGeneration);
  const imageTransformation = serializeImageTransformationForUi(artifact?.imageTransformation);
  const videoFrameExtraction = serializeVideoFrameExtractionForUi(artifact?.videoFrameExtraction);
  const imageNormalization = serializeImageNormalizationForUi(artifact?.imageNormalization);
  if (!imageGeneration && !imageTransformation && !videoFrameExtraction && !imageNormalization) {
    return [];
  }

  const metadataPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.image.json`);
  await fs.writeJson(metadataPath, {
    displayName: String(artifact?.displayName || '').trim(),
    fileName: String(artifact?.fileName || '').trim(),
    formatLabel: String(artifact?.formatLabel || '').trim(),
    height: Number(artifact?.height || 0) || 0,
    imageGeneration,
    imageTransformation,
    imageNormalization,
    videoFrameExtraction,
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
  const videoGeneration = serializeVideoGenerationForUi(artifact?.videoGeneration);
  const videoStitch = serializeVideoStitchForUi(artifact?.videoStitch);
  const videoNormalization = serializeVideoNormalizationForUi(artifact?.videoNormalization);
  const mediaTrim = serializeMediaTrimForUi(artifact?.mediaTrim);
  const subtitleBurn = serializeSubtitleBurnForUi(artifact?.subtitleBurn);
  const hyperFramesRender = artifact?.hyperFramesRender && typeof artifact.hyperFramesRender === 'object'
    ? serializeArtifactForUi(artifact.hyperFramesRender)
    : null;
  if (!compositionExport && !videoGeneration && !videoStitch && !videoNormalization && !mediaTrim && !subtitleBurn && !hyperFramesRender) {
    return [];
  }

  const suffix = (videoGeneration || videoStitch || videoNormalization || mediaTrim || subtitleBurn || hyperFramesRender) ? '.video.json' : '.composition-export.json';
  const metadataPath = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + suffix);
  await fs.writeJson(metadataPath, {
    compositionExport,
    displayName: String(artifact?.displayName || '').trim(),
    fileName: String(artifact?.fileName || '').trim(),
    formatLabel: String(artifact?.formatLabel || '').trim(),
    kind: String(artifact?.kind || PORT_KIND_VIDEO).trim() || PORT_KIND_VIDEO,
    summary: String(artifact?.summary || '').trim(),
    videoGeneration,
    videoStitch,
    videoNormalization,
    mediaTrim,
    subtitleBurn,
    hyperFramesRender,
  }, { spaces: 2 });

  return [metadataPath];
}

async function saveSubtitleExportArtifactMetadata(filePath, artifact) {
  const subtitleExport = serializeSubtitleExportForUi(artifact?.subtitleExport);
  if (!subtitleExport) {
    return [];
  }

  const metadataPath = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + '.subtitle.json');
  await fs.writeJson(metadataPath, {
    displayName: String(artifact?.displayName || '').trim(),
    fileName: String(artifact?.fileName || '').trim(),
    formatLabel: String(artifact?.formatLabel || '').trim(),
    kind: String(artifact?.kind || PORT_KIND_FILE).trim() || PORT_KIND_FILE,
    subtitleExport,
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
      imageAnalysis: artifact.imageAnalysis,
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
        : artifact.kind === PORT_KIND_FILE
          ? await saveSubtitleExportArtifactMetadata(filePath, artifact)
          : [];

  const savedArtifact = await buildFileArtifact(filePath, {
    audio: artifact.audio,
    audioGeneration: artifact.audioGeneration,
    imageGeneration: artifact.imageGeneration,
    audioExtraction: artifact.audioExtraction,
    audioNormalization: artifact.audioNormalization,
    mediaTrim: artifact.mediaTrim,
    audioTransformation: artifact.audioTransformation,
    audioStitch: artifact.audioStitch,
    compositionExport: artifact.compositionExport,
    displayName: artifact.displayName || options.baseName || path.basename(filePath),
    imageTransformation: artifact.imageTransformation,
    videoFrameExtraction: artifact.videoFrameExtraction,
    videoGeneration: artifact.videoGeneration,
    videoNormalization: artifact.videoNormalization,
    mediaTrim: artifact.mediaTrim,
    subtitleBurn: artifact.subtitleBurn,
    subtitleExport: artifact.subtitleExport,
    videoStitch: artifact.videoStitch,
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
    attempts: Array.isArray(entry?.attempts) ? serializeArtifactForUi(entry.attempts) : [],
    validation: entry?.validation ? serializeArtifactForUi(entry.validation) : null,
    metadata: entry?.metadata ? serializeArtifactForUi(entry.metadata) : null,
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
      imageTimingMode: String(track?.imageTimingMode || '').trim(),
      itemKind: String(track?.itemKind || '').trim(),
      kind: 'visual-sequence',
      order: String(track?.order || 'explicit').trim() || 'explicit',
      role: String(track?.role || '').trim(),
      sceneTransitions: track?.sceneTransitions ? serializeArtifactForUi(track.sceneTransitions) : (track?.timing?.sceneTransitions ? serializeArtifactForUi(track.timing.sceneTransitions) : null),
      sourceCollection: track?.sourceCollection ? serializeArtifactForUi(track.sourceCollection) : null,
      summary: String(track?.summary || '').trim(),
      timing: track?.timing ? serializeArtifactForUi(track.timing) : null,
      items: (Array.isArray(track?.items) ? track.items : []).map((entry) => ({
        artifact: serializeArtifactForUi(entry?.artifact || null),
        artifactPath: String(entry?.artifact?.filePath || '').trim(),
        durationSeconds: Number(entry?.durationSeconds || 0) || 0,
        endSeconds: Number.isFinite(Number(entry?.endSeconds)) ? Math.round(Number(entry.endSeconds) * 1000) / 1000 : null,
        index: Number(entry?.index || 0) || 0,
        itemId: String(entry?.itemId || '').trim(),
        lineage: entry?.lineage ? serializeArtifactForUi(entry.lineage) : null,
        metadata: entry?.metadata ? serializeArtifactForUi(entry.metadata) : null,
        relativeArtifactPath: entry?.artifact?.filePath ? path.relative(directoryPath, entry.artifact.filePath) : '',
        startSeconds: Number.isFinite(Number(entry?.startSeconds)) ? Math.round(Number(entry.startSeconds) * 1000) / 1000 : null,
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
    compositionMode: artifact?.composition?.compositionMode,
    displayName: options.displayName || options.title || artifact?.displayName || 'Media Composition',
    exportKind: artifact?.composition?.exportKind,
    recipeId: artifact?.composition?.recipeId,
    audioMix: artifact?.composition?.audioMix,
    soundEffects: artifact?.composition?.soundEffects,
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
  if (options.isFinalOutput) {
    applyFinalOutputMetadata(savedComposition, options);
  }

  await fs.writeJson(manifestPath, {
    artifactRole: savedComposition.artifactRole || '',
    composition: serializeArtifactForUi(savedComposition.composition),
    displayName: savedComposition.displayName,
    isFinalOutput: Boolean(savedComposition.isFinalOutput),
    kind: PORT_KIND_COMPOSITION,
    outputKind: savedComposition.outputKind || '',
    outputLabel: savedComposition.outputLabel || '',
    outputNodeId: savedComposition.outputNodeId || '',
    outputPortId: savedComposition.outputPortId || '',
    role: savedComposition.role,
    runId: savedComposition.runId || '',
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
    const normalizedEntry = {
      artifact: savedArtifact,
      itemId: String(entry?.itemId || buildCollectionItemId(savedArtifact, index)).trim() || buildCollectionItemId(savedArtifact, index),
      lineage: normalizeCollectionLineage(entry?.lineage),
    };
    if (entry?.metadata && typeof entry.metadata === 'object') {
      normalizedEntry.metadata = serializeArtifactForUi(entry.metadata);
    }
    if (Array.isArray(entry?.attempts) && entry.attempts.length) {
      normalizedEntry.attempts = serializeArtifactForUi(entry.attempts);
    }
    if (entry?.validation && typeof entry.validation === 'object') {
      normalizedEntry.validation = serializeArtifactForUi(entry.validation);
    }
    normalizedItems.push(normalizedEntry);
  }

  const manifestPath = path.join(directoryPath, 'manifest.json');
  const savedCollection = createArtifactCollection(normalizedItems, {
    accumulation: artifact?.accumulation,
    collectionMapping: artifact?.collectionMapping,
    metadata: artifact?.metadata,
    collectionNormalization: artifact?.collectionNormalization,
    collectionStatus: artifact?.collectionStatus,
    failedItems: artifact?.failedItems,
    sourceCollection: artifact?.sourceCollection,
    sourceItemCount: artifact?.sourceItemCount,
    destinationPath: options.target === 'outputs' ? directoryPath : '',
    directoryPath,
    displayName: options.displayName || options.title || artifact?.displayName || 'Collection',
    itemKind: artifact?.itemKind,
    manifestPath,
    metadataPaths: [manifestPath],
    role: options.role || artifact?.role || (options.target === 'outputs' ? 'output' : 'artifact'),
  });
  if (options.isFinalOutput) {
    applyFinalOutputMetadata(savedCollection, options);
  }

  await fs.writeJson(manifestPath, {
    schemaVersion: 1,
    artifactRole: savedCollection.artifactRole || '',
    kind: PORT_KIND_COLLECTION,
    isFinalOutput: Boolean(savedCollection.isFinalOutput),
    collectionStatus: savedCollection.collectionStatus || 'complete',
    partial: Boolean(savedCollection.partial),
    sourceItemCount: Number(savedCollection.sourceItemCount || savedCollection.itemCount || 0) || 0,
    successfulItemCount: Number(savedCollection.successfulItemCount || savedCollection.itemCount || 0) || 0,
    failedItemCount: Number(savedCollection.failedItemCount || 0) || 0,
    failedItems: Array.isArray(savedCollection.failedItems) ? serializeArtifactForUi(savedCollection.failedItems) : [],
    itemCount: savedCollection.itemCount,
    itemKind: savedCollection.itemKind,
    displayName: savedCollection.displayName,
    order: savedCollection.order,
    outputKind: savedCollection.outputKind || '',
    outputLabel: savedCollection.outputLabel || '',
    outputNodeId: savedCollection.outputNodeId || '',
    outputPortId: savedCollection.outputPortId || '',
    role: savedCollection.role,
    runId: savedCollection.runId || '',
    summary: savedCollection.summary,
    accumulation: savedCollection.accumulation ? serializeArtifactForUi(savedCollection.accumulation) : null,
    collectionMapping: savedCollection.collectionMapping ? serializeArtifactForUi(savedCollection.collectionMapping) : null,
    metadata: savedCollection.metadata ? serializeArtifactForUi(savedCollection.metadata) : null,
    collectionNormalization: savedCollection.collectionNormalization ? serializeArtifactForUi(savedCollection.collectionNormalization) : null,
    sourceCollection: savedCollection.sourceCollection ? serializeArtifactForUi(savedCollection.sourceCollection) : null,
    items: savedCollection.items.map((entry) => buildCollectionManifestItem(entry, directoryPath)),
  }, { spaces: 2 });

  return savedCollection;
}

async function copyArtifactToOutput(artifact, runDirectories, options = {}) {
  const title = String(options.title || artifact?.displayName || 'result').trim() || 'result';
  const finalOutputOptions = {
    isFinalOutput: true,
    outputKind: String(options.outputKind || artifact?.kind || '').trim(),
    outputLabel: title,
    outputNodeId: String(options.outputNodeId || '').trim(),
    outputPortId: String(options.outputPortId || '').trim(),
    runId: String(options.runId || '').trim(),
    title,
  };
  if (isCompositionArtifact(artifact)) {
    return persistCompositionArtifact(runDirectories, artifact, {
      baseName: title,
      displayName: title,
      ...finalOutputOptions,
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
      ...finalOutputOptions,
      role: 'output',
      target: 'outputs',
      title,
    });
  }

  if (isPlanningPacketArtifact(artifact) || isPlanArtifact(artifact) || isPreviewArtifact(artifact) || isAuditArtifact(artifact)) {
    const extension = isPlanArtifact(artifact)
      ? '.plan.json'
      : isPlanningPacketArtifact(artifact)
        ? '.packet.json'
        : isPreviewArtifact(artifact)
          ? '.preview.json'
          : '.audit.json';
    const filePath = await nextAvailableFilePath(runDirectories.outputsDir, title, extension);
    const payload = isPlanArtifact(artifact)
      ? artifact.plan || {}
      : isPlanningPacketArtifact(artifact)
        ? artifact.packet || {}
        : isPreviewArtifact(artifact)
          ? artifact.preview || {}
          : artifact.audit || {};
    await fs.writeJson(filePath, payload, { spaces: 2 });

    const savedArtifact = isPlanArtifact(artifact)
      ? createPlanArtifact(payload, {
          displayName: title,
          planner: artifact.planner,
          role: 'output',
          sourcePacket: artifact.sourcePacket,
        })
      : isPlanningPacketArtifact(artifact)
        ? createPlanningPacketArtifact(payload, {
            displayName: title,
            role: 'output',
          })
        : isPreviewArtifact(artifact)
          ? createPreviewArtifact(payload, {
              displayName: title,
              role: 'output',
              sourcePacket: artifact.sourcePacket,
              sourcePlan: artifact.sourcePlan,
            })
          : createAuditArtifact(payload, {
              displayName: title,
              role: 'output',
              sourcePacket: artifact.sourcePacket,
              sourcePlan: artifact.sourcePlan,
              sourcePreview: artifact.sourcePreview,
            });

    savedArtifact.fileName = path.basename(filePath);
    savedArtifact.filePath = filePath;
    savedArtifact.fileUrl = pathToFileURL(filePath).toString();
    savedArtifact.mimeType = 'application/json';
    savedArtifact.destinationPath = filePath;
    savedArtifact.sourcePath = artifact.filePath || '';
    applyFinalOutputMetadata(savedArtifact, finalOutputOptions);
    return savedArtifact;
  }

  if (artifact.kind === PORT_KIND_TEXT) {
    const filePath = await nextAvailableFilePath(runDirectories.outputsDir, title, '.txt');
    await fs.writeFile(filePath, String(artifact.text || '') + '\n', 'utf8');
    const metadataPaths = await saveTextArtifactMetadata(filePath, artifact);
    const savedArtifact = createTextArtifact(artifact.text || '', {
      displayName: title,
      imageAnalysis: artifact.imageAnalysis,
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
    applyFinalOutputMetadata(savedArtifact, finalOutputOptions);
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
        : artifact.kind === PORT_KIND_FILE
          ? await saveSubtitleExportArtifactMetadata(filePath, artifact)
          : [];

  const savedArtifact = await buildFileArtifact(filePath, {
    audio: artifact.audio,
    audioGeneration: artifact.audioGeneration,
    imageGeneration: artifact.imageGeneration,
    audioExtraction: artifact.audioExtraction,
    audioNormalization: artifact.audioNormalization,
    mediaTrim: artifact.mediaTrim,
    audioTransformation: artifact.audioTransformation,
    audioStitch: artifact.audioStitch,
    compositionExport: artifact.compositionExport,
    displayName: title,
    hyperFramesRender: artifact.hyperFramesRender,
    imageTransformation: artifact.imageTransformation,
    videoFrameExtraction: artifact.videoFrameExtraction,
    videoGeneration: artifact.videoGeneration,
    videoNormalization: artifact.videoNormalization,
    mediaTrim: artifact.mediaTrim,
    subtitleBurn: artifact.subtitleBurn,
    subtitleExport: artifact.subtitleExport,
    videoStitch: artifact.videoStitch,
    kind: artifact.kind,
    role: 'output',
  });
  if (metadataPaths.length) {
    savedArtifact.metadataPaths = metadataPaths;
  }
  savedArtifact.destinationPath = filePath;
  savedArtifact.sourcePath = sourcePath;
  applyFinalOutputMetadata(savedArtifact, finalOutputOptions);
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
    audioExtraction: artifact?.audioExtraction ? serializeArtifactForUi(artifact.audioExtraction) : null,
    audioNormalization: artifact?.audioNormalization ? serializeArtifactForUi(artifact.audioNormalization) : null,
    mediaTrim: artifact?.mediaTrim ? serializeArtifactForUi(artifact.mediaTrim) : null,
    audioTransformation: artifact?.audioTransformation ? serializeArtifactForUi(artifact.audioTransformation) : null,
    audioStitch: artifact?.audioStitch ? serializeArtifactForUi(artifact.audioStitch) : null,
    destinationPath: artifact?.destinationPath || artifact?.directoryPath || artifact?.filePath || '',
    directoryPath: artifact?.directoryPath || '',
    imageTransformation: artifact?.imageTransformation ? serializeArtifactForUi(artifact.imageTransformation) : null,
    videoFrameExtraction: artifact?.videoFrameExtraction ? serializeArtifactForUi(artifact.videoFrameExtraction) : null,
    videoGeneration: artifact?.videoGeneration ? serializeArtifactForUi(artifact.videoGeneration) : null,
    videoNormalization: artifact?.videoNormalization ? serializeArtifactForUi(artifact.videoNormalization) : null,
    mediaTrim: artifact?.mediaTrim ? serializeArtifactForUi(artifact.mediaTrim) : null,
    subtitleBurn: artifact?.subtitleBurn ? serializeArtifactForUi(artifact.subtitleBurn) : null,
    subtitleExport: artifact?.subtitleExport ? serializeArtifactForUi(artifact.subtitleExport) : null,
    videoStitch: artifact?.videoStitch ? serializeArtifactForUi(artifact.videoStitch) : null,
    filePath: artifact?.filePath || '',
    fileUrl: artifact?.fileUrl || '',
    itemCount: Number(artifact?.itemCount || 0) || 0,
    itemKind: String(artifact?.itemKind || '').trim(),
    collectionMapping: artifact?.collectionMapping ? serializeArtifactForUi(artifact.collectionMapping) : null,
    collectionNormalization: artifact?.collectionNormalization ? serializeArtifactForUi(artifact.collectionNormalization) : null,
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

  if (isPlanningPacketArtifact(artifact)) {
    const packet = artifact.packet || {};
    const sourceArtifacts = Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts : [];
    const lines = [
      'Type: planning packet',
      packet.schemaLabel ? 'Schema: ' + packet.schemaLabel : '',
      packet.goal ? 'Goal: ' + packet.goal : '',
      packet.sourceSummary ? 'Source summary: ' + packet.sourceSummary : '',
      Array.isArray(packet.constraints) && packet.constraints.length ? 'Constraints: ' + packet.constraints.join(' | ') : '',
      Array.isArray(packet.stylePolicy) && packet.stylePolicy.length ? 'Style or policy: ' + packet.stylePolicy.join(' | ') : '',
      Array.isArray(packet.availableTools) && packet.availableTools.length ? 'Available tools: ' + packet.availableTools.join(' | ') : '',
      packet.readiness?.hardwareSummary ? 'Hardware: ' + packet.readiness.hardwareSummary : '',
      Array.isArray(packet.readiness?.notes) && packet.readiness.notes.length ? 'Readiness notes: ' + packet.readiness.notes.join(' | ') : '',
      packet.desiredOutput?.shapeSummary ? 'Desired output: ' + packet.desiredOutput.shapeSummary : '',
      Array.isArray(packet.riskNotes) && packet.riskNotes.length ? 'Risk notes: ' + packet.riskNotes.join(' | ') : '',
      Array.isArray(packet.uncertaintyFlags) && packet.uncertaintyFlags.length ? 'Uncertainty flags: ' + packet.uncertaintyFlags.join(' | ') : '',
      packet.workingNotes ? 'Working notes: ' + packet.workingNotes : '',
      sourceArtifacts.length ? 'Source artifacts:' : '',
      ...sourceArtifacts.slice(0, 8).map((sourceArtifact, index) => {
        const excerpt = String(sourceArtifact?.textExcerpt || '').trim();
        const summary = String(sourceArtifact?.summary || '').trim();
        const label = String(sourceArtifact?.displayName || sourceArtifact?.fileName || sourceArtifact?.kind || ('Source ' + (index + 1))).trim();
        const details = [summary, excerpt ? 'Excerpt: ' + excerpt : ''].filter(Boolean).join(' | ');
        return (index + 1) + '. ' + label + (details ? ' | ' + details : '');
      }),
      sourceArtifacts.length > 8 ? '...and ' + (sourceArtifacts.length - 8) + ' more sources.' : '',
    ].filter(Boolean);
    return lines.join('\n').trim();
  }

  if (isPlanArtifact(artifact)) {
    const plan = artifact.plan || {};
    const overview = plan.overview && typeof plan.overview === 'object' ? plan.overview : {};
    const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
    const sections = Array.isArray(plan.sections) ? plan.sections : [];
    const lines = [
      'Type: plan',
      plan.schemaId ? 'Schema: ' + plan.schemaId : '',
      plan.title ? 'Title: ' + plan.title : '',
      overview.meaningIntent ? 'Overview meaning: ' + overview.meaningIntent : '',
      overview.viewerTakeaway ? 'Overview takeaway: ' + overview.viewerTakeaway : '',
      overview.narrativeArc ? 'Narrative arc: ' + overview.narrativeArc : '',
      overview.toneStrategy ? 'Tone strategy: ' + overview.toneStrategy : '',
      plan.overallStyle ? 'Overall audio style: ' + plan.overallStyle : '',
      plan.targetUse ? 'Target use: ' + plan.targetUse : '',
      plan.estimatedTotalDurationSeconds ? 'Estimated duration: ' + plan.estimatedTotalDurationSeconds + ' seconds' : '',
      Array.isArray(overview.continuityNotes) && overview.continuityNotes.length ? 'Continuity notes: ' + overview.continuityNotes.join(' | ') : '',
      Array.isArray(overview.riskNotes) && overview.riskNotes.length ? 'Risk notes: ' + overview.riskNotes.join(' | ') : '',
      scenes.length ? 'Scenes:' : '',
      ...scenes.slice(0, 8).map((scene, index) => {
        const sceneLabel = String(scene?.sourceSpanLabel || scene?.sceneId || ('Scene ' + (index + 1))).trim() || ('Scene ' + (index + 1));
        const sceneSummary = [scene?.sceneConcept, scene?.treatmentApproach, scene?.imagePrompt ? 'Prompt: ' + scene.imagePrompt : scene?.visualPromptDraft ? 'Prompt: ' + scene.visualPromptDraft : '']
          .filter(Boolean)
          .join(' | ');
        return (index + 1) + '. ' + sceneLabel + (sceneSummary ? ' | ' + sceneSummary : '');
      }),
      scenes.length > 8 ? '...and ' + (scenes.length - 8) + ' more scenes.' : '',
      sections.length ? 'Audio sections:' : '',
      ...sections.slice(0, 8).map((section, index) => {
        const sectionLabel = String(section?.name || ('Section ' + (index + 1))).trim() || ('Section ' + (index + 1));
        const sectionSummary = [section?.durationSeconds ? section.durationSeconds + 's' : '', section?.energy, section?.mood, section?.prompt ? 'Prompt: ' + section.prompt : '', section?.negativePrompt ? 'Negative: ' + section.negativePrompt : '']
          .filter(Boolean)
          .join(' | ');
        return (index + 1) + '. ' + sectionLabel + (sectionSummary ? ' | ' + sectionSummary : '');
      }),
      sections.length > 8 ? '...and ' + (sections.length - 8) + ' more sections.' : '',
      Array.isArray(plan.openQuestions) && plan.openQuestions.length ? 'Open questions:' : '',
      ...(Array.isArray(plan.openQuestions) ? plan.openQuestions.slice(0, 6).map((entry, index) => (index + 1) + '. ' + entry) : []),
    ].filter(Boolean);
    return lines.join('\n').trim();
  }

  if (isPreviewArtifact(artifact)) {
    const preview = artifact.preview || {};
    const overview = preview.overview && typeof preview.overview === 'object' ? preview.overview : {};
    const scenes = Array.isArray(preview.scenes) ? preview.scenes : [];
    const lines = [
      'Type: preview',
      preview.schemaId ? 'Schema: ' + preview.schemaId : '',
      preview.planTitle ? 'Plan title: ' + preview.planTitle : '',
      preview.previewMode ? 'Mode: ' + preview.previewMode : '',
      preview.limitationNote ? 'Boundary: ' + preview.limitationNote : '',
      overview.viewerTakeaway ? 'Overview takeaway: ' + overview.viewerTakeaway : '',
      overview.narrativeArc ? 'Narrative arc: ' + overview.narrativeArc : '',
      scenes.length ? 'Scenes:' : '',
      ...scenes.slice(0, 8).map((scene, index) => {
        const sceneLabel = String(scene?.sourceSpanLabel || scene?.sceneId || ('Scene ' + (index + 1))).trim() || ('Scene ' + (index + 1));
        const sceneSummary = [scene?.summary, scene?.promptPreview ? 'Prompt: ' + scene.promptPreview : '', scene?.promptReadiness ? 'Readiness: ' + scene.promptReadiness : '']
          .filter(Boolean)
          .join(' | ');
        return (index + 1) + '. ' + sceneLabel + (sceneSummary ? ' | ' + sceneSummary : '');
      }),
      scenes.length > 8 ? '...and ' + (scenes.length - 8) + ' more scenes.' : '',
      Array.isArray(preview.openQuestions) && preview.openQuestions.length ? 'Open questions:' : '',
      ...(Array.isArray(preview.openQuestions) ? preview.openQuestions.slice(0, 6).map((entry, index) => (index + 1) + '. ' + entry) : []),
    ].filter(Boolean);
    return lines.join('\n').trim();
  }

  if (isAuditArtifact(artifact)) {
    const audit = artifact.audit || {};
    const summary = audit.summary && typeof audit.summary === 'object' ? audit.summary : {};
    const findings = Array.isArray(audit.findings) ? audit.findings : [];
    const lines = [
      'Type: audit',
      audit.schemaId ? 'Schema: ' + audit.schemaId : '',
      audit.planTitle ? 'Plan title: ' + audit.planTitle : '',
      audit.limitationNote ? 'Boundary: ' + audit.limitationNote : '',
      audit.structuralValidation?.summary ? 'Structural summary: ' + audit.structuralValidation.summary : '',
      audit.previewCoverage?.connected ? 'Preview coverage: connected' : 'Preview coverage: plan only',
      Number(summary.errorCount || 0) || Number(summary.warningCount || 0) || Number(summary.infoCount || 0)
        ? 'Finding counts: ' + Number(summary.errorCount || 0) + ' error, ' + Number(summary.warningCount || 0) + ' warning, ' + Number(summary.infoCount || 0) + ' info'
        : 'Finding counts: no findings',
      Array.isArray(audit.heuristicsUsed) && audit.heuristicsUsed.length ? 'Heuristics: ' + audit.heuristicsUsed.join(' | ') : '',
      findings.length ? 'Findings:' : '',
      ...findings.slice(0, 8).map((finding, index) => {
        const detail = [finding?.title, finding?.detail, finding?.approximate ? 'Approximate heuristic' : ''].filter(Boolean).join(' | ');
        return (index + 1) + '. ' + (finding?.severity || 'info') + (finding?.sceneLabel ? ' | ' + finding.sceneLabel : '') + (detail ? ' | ' + detail : '');
      }),
      findings.length > 8 ? '...and ' + (findings.length - 8) + ' more findings.' : '',
    ].filter(Boolean);
    return lines.join('\n').trim();
  }

  if (isArtifactCollection(artifact)) {
    const items = Array.isArray(artifact.items) ? artifact.items : [];
    const accumulation = artifact.accumulation && typeof artifact.accumulation === 'object' ? artifact.accumulation : null;
    const itemDescriptions = [];
    for (let index = 0; index < Math.min(items.length, 6); index += 1) {
      const entry = items[index];
      const itemArtifact = entry?.artifact || null;
      const lineage = entry?.lineage || null;
      const sourceLabel = lineage?.sourceNodeLabel || lineage?.sourceNodeId || '';
      const nestedDescription = trimPreviewText(await describeArtifactForLlm(itemArtifact), 220)
        || summarizeArtifact(itemArtifact, 140)
        || itemArtifact?.displayName
        || itemArtifact?.fileName
        || 'Item ' + (index + 1);
      itemDescriptions.push((index + 1) + '. ' + nestedDescription + (sourceLabel ? ' (from ' + sourceLabel + ')' : ''));
    }

    const lines = [
      'Type: ordered collection',
      'Review scope: validate the collection as a whole, not as separate per-item passes.',
      artifact.itemKind ? 'Item type: ' + artifact.itemKind : '',
      Number(artifact.itemCount || 0) ? 'Item count: ' + artifact.itemCount : '',
      artifact.displayName ? 'Name: ' + artifact.displayName : '',
      artifact.summary ? 'Summary: ' + artifact.summary : '',
      artifact.manifestPath ? 'Manifest: ' + artifact.manifestPath : '',
      artifact.collectionStatus ? 'Collection status: ' + artifact.collectionStatus : '',
      artifact.partial ? 'Partial output: yes' : '',
      Number(artifact.sourceItemCount || 0) ? 'Source item count: ' + Number(artifact.sourceItemCount || 0) : '',
      Number(artifact.failedItemCount || 0) ? 'Failed item count: ' + Number(artifact.failedItemCount || 0) : '',
      accumulation?.status ? 'Collection state: ' + accumulation.status : '',
      Number(accumulation?.acceptedCount || 0) ? 'Accepted count: ' + Number(accumulation.acceptedCount || 0) : '',
      Number(accumulation?.targetCount || 0) ? 'Target count: ' + Number(accumulation.targetCount || 0) : '',
      '',
      'Items:',
      ...itemDescriptions,
      items.length > itemDescriptions.length ? '...and ' + (items.length - itemDescriptions.length) + ' more items.' : '',
    ].filter(Boolean);
    return lines.join('\n').trim();
  }

  if (artifact.kind === PORT_KIND_TEXT) {
    const transcription = artifact.transcription || null;
    if (!transcription) {
      return ('Type: text\nContent:\n' + (artifact.text || '')).trim();
    }

    const lines = [
      'Type: text',
      'Origin: audio transcription',
      transcription.backendLabel ? 'Backend: ' + transcription.backendLabel : '',
      transcription.model ? 'Model: ' + transcription.model : '',
      transcription.language ? 'Language: ' + transcription.language : '',
      transcription.segmentCount ? 'Segments: ' + transcription.segmentCount : '',
      transcription.durationSeconds ? 'Duration: ' + transcription.durationSeconds + ' seconds' : '',
      transcription.sourceAudio?.fileName ? 'Source audio: ' + transcription.sourceAudio.fileName : '',
      transcription.sourceAudio?.filePath ? 'Source path: ' + transcription.sourceAudio.filePath : '',
      '',
      'Content:',
      artifact.text || '',
    ].filter((entry, index, entries) => entry || index === entries.length - 2);
    return lines.join('\n').trim();
  }

  const lines = [
    'Type: ' + artifact.kind,
    artifact.displayName ? 'Name: ' + artifact.displayName : '',
    artifact.fileName ? 'File name: ' + artifact.fileName : '',
    artifact.mimeType ? 'MIME type: ' + artifact.mimeType : '',
    artifact.extension ? 'Extension: ' + artifact.extension : '',
    artifact.formatLabel ? 'Format: ' + artifact.formatLabel : '',
    artifact.previewKind ? 'Preview kind: ' + artifact.previewKind : '',
    artifact.isAnimated ? 'Animation: animated' : '',
    artifact.role ? 'Role: ' + artifact.role : '',
    artifact.filePath ? 'Path: ' + artifact.filePath : '',
    artifact.width && artifact.height ? 'Dimensions: ' + artifact.width + 'x' + artifact.height : '',
    artifact.audio?.durationSeconds ? 'Duration: ' + artifact.audio.durationSeconds + ' seconds' : '',
    artifact.audio?.sampleRate ? 'Sample rate: ' + artifact.audio.sampleRate + ' Hz' : '',
    artifact.audio?.channelCount ? 'Channels: ' + artifact.audio.channelCount : '',
    artifact.audio?.bitDepth ? 'Bit depth: ' + artifact.audio.bitDepth : '',
    artifact.audioTransformation?.backendLabel ? 'Transformed by: ' + artifact.audioTransformation.backendLabel : '',
    artifact.audioTransformation?.toolLabel ? 'Transform tool: ' + artifact.audioTransformation.toolLabel : '',
    artifact.audioTransformation?.model ? 'Transform model: ' + artifact.audioTransformation.model : '',
    artifact.audioTransformation?.transformationType ? 'Transform type: ' + artifact.audioTransformation.transformationType : '',
    artifact.audioTransformation?.targetVoice ? 'Target voice: ' + artifact.audioTransformation.targetVoice : '',
    artifact.audioTransformation?.instruction ? 'Transform note: ' + artifact.audioTransformation.instruction : '',
    artifact.audioTransformation?.sourceAudio?.fileName ? 'Source audio: ' + artifact.audioTransformation.sourceAudio.fileName : '',
    artifact.audioExtraction?.sourceVideo?.fileName ? 'Extracted audio from: ' + artifact.audioExtraction.sourceVideo.fileName : '',
    artifact.audioNormalization?.sourceAudio?.fileName ? 'Normalized audio from: ' + artifact.audioNormalization.sourceAudio.fileName : '',
    artifact.mediaTrim?.sourceArtifact?.fileName ? 'Trimmed from: ' + artifact.mediaTrim.sourceArtifact.fileName : '',
    artifact.hyperFramesRender?.toolId ? 'Rendered by: HyperFrames' : '',
    artifact.hyperFramesRender?.fps ? 'Render FPS: ' + artifact.hyperFramesRender.fps : '',
    artifact.hyperFramesRender?.quality ? 'Render quality: ' + artifact.hyperFramesRender.quality : '',
    artifact.imageTransformation?.backendLabel ? 'Image transformed by: ' + artifact.imageTransformation.backendLabel : '',
    artifact.imageTransformation?.toolLabel ? 'Image transform tool: ' + artifact.imageTransformation.toolLabel : '',
    artifact.imageTransformation?.model ? 'Image transform model: ' + artifact.imageTransformation.model : '',
    artifact.imageTransformation?.transformSubtype ? 'Image transform subtype: ' + artifact.imageTransformation.transformSubtype : artifact.imageTransformation?.transformationType ? 'Image transform type: ' + artifact.imageTransformation.transformationType : '',
    artifact.imageTransformation?.scale ? 'Image transform scale: ' + artifact.imageTransformation.scale + 'x' : '',
    artifact.imageTransformation?.instruction ? 'Image transform note: ' + artifact.imageTransformation.instruction : '',
    artifact.imageTransformation?.sourceImage?.fileName ? 'Target image: ' + artifact.imageTransformation.sourceImage.fileName : '',
    artifact.imageTransformation?.referenceImage?.fileName ? 'Reference image: ' + artifact.imageTransformation.referenceImage.fileName : '',
    artifact.videoFrameExtraction?.framePosition ? 'Extracted frame: ' + artifact.videoFrameExtraction.framePosition : '',
    artifact.videoFrameExtraction?.sourceVideo?.fileName ? 'Source video: ' + artifact.videoFrameExtraction.sourceVideo.fileName : '',
    artifact.videoNormalization?.sourceVideo?.fileName ? 'Normalized video from: ' + artifact.videoNormalization.sourceVideo.fileName : '',
    artifact.subtitleBurn?.captionSource?.displayName ? 'Captions burned from: ' + artifact.subtitleBurn.captionSource.displayName : '',
    artifact.subtitleExport?.captionSource?.displayName ? 'Subtitles exported from: ' + artifact.subtitleExport.captionSource.displayName : '',
    artifact.audioGeneration?.backendLabel ? 'Generated by: ' + artifact.audioGeneration.backendLabel : '',
    artifact.audioGeneration?.toolLabel ? 'Tool: ' + artifact.audioGeneration.toolLabel : '',
    artifact.audioGeneration?.model ? 'Model: ' + artifact.audioGeneration.model : '',
    artifact.audioGeneration?.mode ? 'Generation mode: ' + artifact.audioGeneration.mode : '',
    artifact.audioGeneration?.prompt ? 'Prompt: ' + artifact.audioGeneration.prompt : '',
    artifact.audioGeneration?.voice ? 'Voice: ' + artifact.audioGeneration.voice : '',
    artifact.audioGeneration?.referenceAudio?.fileName ? 'Reference voice: ' + artifact.audioGeneration.referenceAudio.fileName : '',
    artifact.audioGeneration?.sourceAudio?.fileName ? 'Guided by: ' + artifact.audioGeneration.sourceAudio.fileName : '',
    artifact.audioStitch?.sourceItemCount ? 'Stitched clips: ' + artifact.audioStitch.sourceItemCount : '',
    artifact.sizeBytes ? 'Size: ' + artifact.sizeBytes + ' bytes' : '',
    artifact.previewText ? 'Excerpt: ' + artifact.previewText : '',
    artifact.summary ? 'Summary: ' + artifact.summary : '',
  ].filter(Boolean);
  return lines.join('\n');
}

module.exports = {
  buildFileArtifact,
  buildTerminalResult,
  copyArtifactToOutput,
  createArtifactCollection,
  createCompositionArtifact,
  createPlanArtifact,
  createPlanningPacketArtifact,
  createPreviewArtifact,
  createAuditArtifact,
  createTextArtifact,
  describeArtifactForLlm,
  ensureRunDirectories,
  inferKindFromPath,
  isArtifactCollection,
  isCompositionArtifact,
  isPlanArtifact,
  isPlanningPacketArtifact,
  isPreviewArtifact,
  isAuditArtifact,
  persistArtifactCollection,
  persistCompositionArtifact,
  saveBase64Artifact,
  saveBufferArtifact,
  sanitizeSegment,
  saveAudioArtifactMetadata,
  saveImageArtifactMetadata,
  saveSubtitleExportArtifactMetadata,
  saveVideoArtifactMetadata,
  serializeArtifactForUi,
  summarizeArtifact,
};
