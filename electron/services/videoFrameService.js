const path = require('path');
const fs = require('fs-extra');

const { runCommand } = require('./commandService');
const { resolveFfmpegPath } = require('./mediaCompositionService');
const { buildFileArtifact, summarizeArtifact } = require('./pipelineArtifactService');
const { PORT_KIND_IMAGE } = require('../shared/pipelineSchema.cjs');

function firstNonEmptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function sanitizeSegment(value, fallback = 'frame') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function buildVideoReference(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return null;
  }

  return {
    displayName: String(artifact.displayName || '').trim(),
    fileName: String(artifact.fileName || '').trim(),
    filePath: String(artifact.filePath || '').trim(),
    id: String(artifact.id || artifact.artifactId || '').trim(),
    kind: String(artifact.kind || '').trim(),
    summary: summarizeArtifact(artifact),
  };
}

async function extractVideoLastFrameArtifact(videoArtifact, options = {}) {
  const sourcePath = path.resolve(String(videoArtifact?.filePath || '').trim());
  if (!sourcePath || !(await fs.pathExists(sourcePath))) {
    throw new Error('Local AI Hub could not extract the last frame because the previous video clip is missing from disk.');
  }

  const artifactsDir = String(options.runDirectories?.artifactsDir || '').trim();
  if (!artifactsDir) {
    throw new Error('Local AI Hub could not prepare a run folder for the video continuity reference frame.');
  }

  const frameDir = path.join(artifactsDir, 'video-chain-frames');
  await fs.ensureDir(frameDir);
  const itemIndex = Math.max(0, Number(options.itemIndex || 0) || 0);
  const baseName = sanitizeSegment([
    options.nodeLabel || 'video-chain',
    'item-' + String(itemIndex + 1).padStart(3, '0'),
    'last-frame',
    Date.now(),
  ].filter(Boolean).join('-'), 'video-last-frame');
  const outputPath = path.join(frameDir, baseName + '.png');

  const ffmpegPath = resolveFfmpegPath();
  const commandResult = await runCommand(ffmpegPath, [
    '-y',
    '-sseof',
    '-0.1',
    '-i',
    sourcePath,
    '-frames:v',
    '1',
    '-update',
    '1',
    outputPath,
  ], { allowFailure: true });

  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error(failureLine || 'Local AI Hub could not extract the previous clip last frame for video continuity.');
  }

  const artifact = await buildFileArtifact(outputPath, {
    displayName: String(options.displayName || 'Previous clip last frame').trim() || 'Previous clip last frame',
    kind: PORT_KIND_IMAGE,
    role: 'generated',
  });
  artifact.videoFrameExtraction = {
    backend: 'ffmpeg',
    backendLabel: 'Bundled ffmpeg',
    frameRole: 'last-frame-reference',
    sourceVideo: buildVideoReference(videoArtifact),
  };
  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

module.exports = {
  extractVideoLastFrameArtifact,
};
