const path = require('path');
const fs = require('fs-extra');

let app = null;
try {
  ({ app } = require('electron'));
} catch {
  app = null;
}

let ffmpegStaticPath = '';
try {
  ffmpegStaticPath = require('ffmpeg-static') || '';
} catch {
  ffmpegStaticPath = '';
}

const { runCommand } = require('./commandService');
const { buildFileArtifact, isCompositionArtifact, serializeArtifactForUi, summarizeArtifact } = require('./pipelineArtifactService');
const { PORT_KIND_VIDEO } = require('../shared/pipelineSchema.cjs');

function sanitizeSegment(value, fallback = 'composition') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function firstNonEmptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function resolveFfmpegPath() {
  const packagedPath = app?.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe')
    : '';
  if (packagedPath && fs.existsSync(packagedPath)) {
    return packagedPath;
  }

  if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
    return ffmpegStaticPath;
  }

  throw new Error('Local AI Hub could not find its bundled ffmpeg runtime. Rebuild or reinstall the app, then try this export again.');
}

function getCompositionTracks(artifact) {
  return Array.isArray(artifact?.composition?.tracks) ? artifact.composition.tracks : [];
}

function getPrimaryVisualTrack(artifact) {
  return getCompositionTracks(artifact).find((track) => String(track?.role || '').trim() === 'primary-visual') || null;
}

function getPrimaryAudioTrack(artifact) {
  return getCompositionTracks(artifact).find((track) => String(track?.role || '').trim() === 'primary-audio') || null;
}

function formatConcatPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/'/g, "'\\''");
}

async function writeConcatManifest(directoryPath, visualTrack) {
  const manifestPath = path.join(directoryPath, 'visuals.ffconcat');
  const items = Array.isArray(visualTrack?.items) ? visualTrack.items : [];
  const lines = ['ffconcat version 1.0'];

  for (const entry of items) {
    const artifact = entry?.artifact || null;
    const filePath = String(artifact?.filePath || '').trim();
    const durationSeconds = Number(entry?.durationSeconds || visualTrack?.itemDurationSeconds || 0) || 0;
    if (!filePath) {
      continue;
    }

    lines.push(`file '${formatConcatPath(filePath)}'`);
    if (durationSeconds > 0) {
      lines.push(`duration ${Math.max(0.1, Math.round(durationSeconds * 1000) / 1000)}`);
    }
  }

  const lastArtifactPath = String(items[items.length - 1]?.artifact?.filePath || '').trim();
  if (lastArtifactPath) {
    lines.push(`file '${formatConcatPath(lastArtifactPath)}'`);
  }

  await fs.writeFile(manifestPath, lines.join('\n') + '\n', 'utf8');
  return manifestPath;
}

function buildVideoFilter(width, height, fitMode) {
  const numericWidth = Math.max(16, Number(width || 0) || 1280);
  const numericHeight = Math.max(16, Number(height || 0) || 720);
  if (fitMode === 'cover') {
    return `scale=${numericWidth}:${numericHeight}:force_original_aspect_ratio=increase,crop=${numericWidth}:${numericHeight},format=yuv420p`;
  }

  return `scale=${numericWidth}:${numericHeight}:force_original_aspect_ratio=decrease,pad=${numericWidth}:${numericHeight}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`;
}

function buildCompositionExportMetadata(compositionArtifact, visualTrack, audioTrack, exportProfile) {
  const audioArtifact = audioTrack?.artifact || null;
  return {
    schemaVersion: 1,
    recipeId: String(compositionArtifact?.composition?.recipeId || '').trim() || 'image-sequence-primary-audio',
    recipeLabel: String(compositionArtifact?.composition?.recipeLabel || '').trim() || 'Image sequence with primary audio',
    composition: serializeArtifactForUi({
      displayName: compositionArtifact?.displayName || '',
      manifestPath: compositionArtifact?.manifestPath || '',
      summary: compositionArtifact?.summary || '',
    }),
    exportProfile: serializeArtifactForUi(exportProfile),
    visualTrack: serializeArtifactForUi({
      itemCount: Number(visualTrack?.itemCount || visualTrack?.items?.length || 0) || 0,
      itemDurationSeconds: Number(visualTrack?.itemDurationSeconds || 0) || 0,
      sourceCollection: visualTrack?.sourceCollection || null,
      summary: visualTrack?.summary || '',
    }),
    audioTrack: audioArtifact
      ? serializeArtifactForUi({
          artifact: audioArtifact,
          summary: audioTrack?.summary || summarizeArtifact(audioArtifact),
        })
      : null,
  };
}

async function writeCompositionExportMetadata(outputPath, metadata) {
  const metadataPath = path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath, path.extname(outputPath))}.composition-export.json`,
  );
  await fs.writeJson(metadataPath, metadata, { spaces: 2 });
  return metadataPath;
}

async function exportCompositionArtifactToVideo(compositionArtifact, options = {}) {
  if (!isCompositionArtifact(compositionArtifact)) {
    throw new Error('This export step needs a saved media composition input before it can render a video.');
  }

  const runDirectories = options.runDirectories || null;
  if (!runDirectories?.artifactsDir) {
    throw new Error('Local AI Hub could not prepare a pipeline run folder for this media export.');
  }

  const visualTrack = getPrimaryVisualTrack(compositionArtifact);
  if (!visualTrack || String(visualTrack.kind || '').trim() !== 'visual-sequence') {
    throw new Error('This first media export pass needs one primary visual sequence track.');
  }

  const visualItems = Array.isArray(visualTrack.items) ? visualTrack.items.filter((entry) => String(entry?.artifact?.filePath || '').trim()) : [];
  if (!visualItems.length) {
    throw new Error('This composition does not have any saved visual items to export yet.');
  }

  const nonImageItem = visualItems.find((entry) => String(entry?.artifact?.kind || '').trim() !== 'image');
  if (nonImageItem) {
    throw new Error('This first media export pass only supports ordered image collections as the visual track.');
  }

  const title = String(options.title || compositionArtifact.displayName || 'Composed video').trim() || 'Composed video';
  const exportDirectoryPath = path.join(
    runDirectories.artifactsDir,
    `${sanitizeSegment(title, 'composed-video')}-export-${Date.now()}`,
  );
  await fs.ensureDir(exportDirectoryPath);

  const concatManifestPath = await writeConcatManifest(exportDirectoryPath, visualTrack);
  const outputPath = path.join(exportDirectoryPath, `${sanitizeSegment(title, 'composed-video')}.mp4`);
  const audioTrack = getPrimaryAudioTrack(compositionArtifact);
  const audioArtifact = audioTrack?.artifact || null;
  const exportProfile = {
    width: Math.max(16, Number(options.width || 0) || 1280),
    height: Math.max(16, Number(options.height || 0) || 720),
    fps: Math.max(1, Number(options.fps || 0) || 30),
    fitMode: String(options.fitMode || '').trim() === 'cover' ? 'cover' : 'contain',
    stopMode: String(options.stopMode || '').trim() === 'visuals' ? 'visuals' : 'shortest',
    videoCodec: 'libx264',
    audioCodec: audioArtifact ? 'aac' : 'none',
    container: 'mp4',
    pixelFormat: 'yuv420p',
    concatManifestPath,
  };

  options.reportProgress?.(
    'Preparing media export.',
    'Rendering the composition to video with the bundled ffmpeg runtime...',
  );

  const ffmpegPath = resolveFfmpegPath();
  const args = [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatManifestPath,
  ];
  if (audioArtifact?.filePath) {
    args.push('-i', audioArtifact.filePath);
  }
  args.push(
    '-vf',
    buildVideoFilter(exportProfile.width, exportProfile.height, exportProfile.fitMode),
    '-r',
    String(exportProfile.fps),
    '-c:v',
    exportProfile.videoCodec,
    '-pix_fmt',
    exportProfile.pixelFormat,
    '-movflags',
    '+faststart',
  );
  if (audioArtifact?.filePath) {
    args.push('-c:a', exportProfile.audioCodec);
    if (exportProfile.stopMode === 'shortest') {
      args.push('-shortest');
    }
  } else {
    args.push('-an');
  }
  args.push(outputPath);

  const commandResult = await runCommand(ffmpegPath, args, {
    allowFailure: true,
  });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    throw new Error(failureLine || 'Local AI Hub could not render the media composition to video.');
  }

  const compositionExport = buildCompositionExportMetadata(compositionArtifact, visualTrack, audioTrack, exportProfile);
  const metadataPath = await writeCompositionExportMetadata(outputPath, compositionExport);
  const artifact = await buildFileArtifact(outputPath, {
    compositionExport,
    displayName: title,
    kind: PORT_KIND_VIDEO,
    role: 'generated',
  });
  artifact.metadataPaths = [metadataPath];
  artifact.summary = summarizeArtifact(artifact);

  return {
    artifact,
    message: audioArtifact?.fileName
      ? `Media Export rendered a video from ${visualItems.length} images with ${audioArtifact.fileName} as the primary audio track.`
      : `Media Export rendered a silent video from ${visualItems.length} images.`,
    metadataPath,
  };
}

module.exports = {
  exportCompositionArtifactToVideo,
  resolveFfmpegPath,
};
