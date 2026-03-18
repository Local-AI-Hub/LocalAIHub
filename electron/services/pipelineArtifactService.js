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
    return trimPreviewText(artifact.text || artifact.previewText || '', limit);
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

  artifact.previewText = kind === PORT_KIND_FILE ? await readTextPreview(resolvedPath) : '';
  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

function createTextArtifact(text, options = {}) {
  const normalizedText = String(text || '');
  const artifact = {
    kind: PORT_KIND_TEXT,
    displayName: String(options.displayName || 'Text').trim() || 'Text',
    previewText: trimPreviewText(normalizedText),
    role: options.role || 'artifact',
    summary: trimPreviewText(normalizedText),
    text: normalizedText,
  };
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
    displayName: options.displayName,
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
    displayName: options.displayName,
    kind: options.kind,
    role: options.role || 'generated',
  });
}

async function copyArtifactToOutput(artifact, runDirectories, options = {}) {
  const title = String(options.title || artifact?.displayName || 'result').trim() || 'result';
  if (artifact.kind === PORT_KIND_TEXT) {
    const filePath = await nextAvailableFilePath(runDirectories.outputsDir, title, '.txt');
    await fs.writeFile(filePath, `${artifact.text || ''}\n`, 'utf8');
    const savedArtifact = createTextArtifact(artifact.text || '', {
      displayName: title,
      role: 'output',
    });
    savedArtifact.fileName = path.basename(filePath);
    savedArtifact.filePath = filePath;
    savedArtifact.fileUrl = pathToFileURL(filePath).toString();
    savedArtifact.mimeType = 'text/plain';
    savedArtifact.destinationPath = filePath;
    savedArtifact.summary = summarizeArtifact(savedArtifact);
    return savedArtifact;
  }

  const sourcePath = path.resolve(String(artifact.filePath || '').trim());
  const extension = path.extname(sourcePath) || KIND_EXTENSIONS[artifact.kind] || '.bin';
  const filePath = await nextAvailableFilePath(runDirectories.outputsDir, title, extension);
  await fs.copy(sourcePath, filePath, { overwrite: true });
  const savedArtifact = await buildFileArtifact(filePath, {
    displayName: title,
    kind: artifact.kind,
    role: 'output',
  });
  savedArtifact.destinationPath = filePath;
  savedArtifact.sourcePath = sourcePath;
  return savedArtifact;
}

function buildTerminalResult(node, artifact) {
  return {
    artifact: serializeArtifactForUi(artifact),
    destinationPath: artifact?.destinationPath || artifact?.filePath || '',
    filePath: artifact?.filePath || '',
    fileUrl: artifact?.fileUrl || '',
    kind: artifact?.kind || PORT_KIND_FILE,
    nodeId: node.id,
    nodeLabel: node.label,
    previewText: summarizeArtifact(artifact),
    textValue: artifact?.kind === PORT_KIND_TEXT ? String(artifact.text || '') : '',
    title: String(node.config?.title || node.label || 'Output').trim() || 'Output',
  };
}

async function describeArtifactForLlm(artifact) {
  if (!artifact) {
    return 'No artifact was available.';
  }

  if (artifact.kind === PORT_KIND_TEXT) {
    return `Type: text\nContent:\n${artifact.text || ''}`.trim();
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

