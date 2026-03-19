const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');

const { ensureStorage, getAppPaths } = require('./configService');
const {
  PORT_KIND_AUDIO,
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

function summarizeArtifact(artifact, limit = 180) {
  if (!artifact) {
    return '';
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

async function copyArtifactToOutput(artifact, runDirectories, options = {}) {
  const title = String(options.title || artifact?.displayName || 'result').trim() || 'result';
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
      : [];

  const savedArtifact = await buildFileArtifact(filePath, {
    audio: artifact.audio,
    audioGeneration: artifact.audioGeneration,
    audioTransformation: artifact.audioTransformation,
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
  return {
    artifact: serializeArtifactForUi(artifact),
    audio: artifact?.audio ? serializeArtifactForUi(artifact.audio) : null,
    audioGeneration: artifact?.audioGeneration ? serializeArtifactForUi(artifact.audioGeneration) : null,
    audioTransformation: artifact?.audioTransformation ? serializeArtifactForUi(artifact.audioTransformation) : null,
    destinationPath: artifact?.destinationPath || artifact?.filePath || '',
    imageTransformation: artifact?.imageTransformation ? serializeArtifactForUi(artifact.imageTransformation) : null,
    filePath: artifact?.filePath || '',
    fileUrl: artifact?.fileUrl || '',
    kind: artifact?.kind || PORT_KIND_FILE,
    nodeId: node.id,
    nodeLabel: node.label,
    previewText: summarizeArtifact(artifact),
    supportingPaths: Array.isArray(artifact?.metadataPaths) ? [...artifact.metadataPaths] : [],
    textValue: artifact?.kind === PORT_KIND_TEXT ? String(artifact.text || '') : '',
    title: String(node.config?.title || node.label || 'Output').trim() || 'Output',
    transcription: artifact?.transcription ? serializeArtifactForUi(artifact.transcription) : null,
  };
}

async function describeArtifactForLlm(artifact) {
  if (!artifact) {
    return 'No artifact was available.';
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
  createTextArtifact,
  describeArtifactForLlm,
  ensureRunDirectories,
  inferKindFromPath,
  saveBase64Artifact,
  saveBufferArtifact,
  sanitizeSegment,
  serializeArtifactForUi,
  summarizeArtifact,
};

