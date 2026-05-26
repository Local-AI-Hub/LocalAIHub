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
const {
  DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME,
  PORT_KIND_VIDEO,
} = require('../shared/pipelineSchema.cjs');

function normalizeAudioVolume(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(2, numeric));
}

function formatVolumeFilterValue(value) {
  return String(Math.round(normalizeAudioVolume(value, 1) * 1000) / 1000);
}

function formatVolumePercent(value, fallback) {
  return Math.round(normalizeAudioVolume(value, fallback) * 100);
}

function resolveCompositionAudioMix(compositionArtifact) {
  const mix = compositionArtifact?.composition?.audioMix && typeof compositionArtifact.composition.audioMix === 'object'
    ? compositionArtifact.composition.audioMix
    : {};
  return {
    backgroundMusicVolume: normalizeAudioVolume(mix.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME),
    narrationVolume: normalizeAudioVolume(mix.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME),
  };
}

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

function getCompositionTrackByRole(artifact, role) {
  return getCompositionTracks(artifact).find((track) => String(track?.role || '').trim() === role) || null;
}

function getPrimaryVisualTrack(artifact) {
  return getCompositionTrackByRole(artifact, 'primary-visual');
}

function getPrimaryAudioTrack(artifact) {
  return getCompositionTrackByRole(artifact, 'primary-audio');
}

function getBackgroundMusicTrack(artifact) {
  return getCompositionTrackByRole(artifact, 'background-music');
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

function calculateVisualDurationSeconds(visualTrack) {
  const items = Array.isArray(visualTrack?.items) ? visualTrack.items : [];
  return items.reduce((total, entry) => total + Math.max(0, Number(entry?.durationSeconds || visualTrack?.itemDurationSeconds || 0) || 0), 0);
}

function buildAudioPlan(primaryAudioTrack, backgroundMusicTrack, stopMode, visualDurationSeconds, audioMix = {}) {
  const primaryAudioArtifact = primaryAudioTrack?.artifact || null;
  const backgroundMusicArtifact = backgroundMusicTrack?.artifact || null;
  const hasPrimaryAudio = Boolean(primaryAudioArtifact?.filePath);
  const hasBackgroundMusic = Boolean(backgroundMusicArtifact?.filePath);
  const shouldLoopBackgroundMusic = hasBackgroundMusic && (hasPrimaryAudio || stopMode === 'visuals');

  let mode = 'silent';
  if (hasPrimaryAudio && hasBackgroundMusic) {
    mode = 'mixed-with-background-music';
  } else if (hasPrimaryAudio) {
    mode = 'primary-audio-only';
  } else if (hasBackgroundMusic) {
    mode = 'background-music-only';
  }

  return {
    backgroundMusicArtifact,
    backgroundMusicTrack,
    backgroundMusicVolume: normalizeAudioVolume(audioMix.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME),
    narrationVolume: normalizeAudioVolume(audioMix.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME),
    hasBackgroundMusic,
    hasPrimaryAudio,
    mode,
    outputDurationSeconds: stopMode === 'visuals' && visualDurationSeconds > 0 ? Math.round(visualDurationSeconds * 1000) / 1000 : null,
    primaryAudioArtifact,
    primaryAudioTrack,
    shouldLoopBackgroundMusic,
    stopMode,
  };
}

function buildAudioMixMetadata(audioPlan) {
  return {
    backgroundMusicLooping: audioPlan.hasBackgroundMusic ? audioPlan.shouldLoopBackgroundMusic : false,
    backgroundMusicVolume: audioPlan.backgroundMusicVolume,
    narrationVolume: audioPlan.narrationVolume,
    mode: audioPlan.mode,
    outputDurationSeconds: audioPlan.outputDurationSeconds || null,
    stopMode: audioPlan.stopMode,
  };
}

function buildCompositionExportMetadata(compositionArtifact, visualTrack, audioPlan, exportProfile) {
  const audioArtifact = audioPlan.primaryAudioArtifact;
  const backgroundMusicArtifact = audioPlan.backgroundMusicArtifact;
  return {
    schemaVersion: 1,
    recipeId: String(compositionArtifact?.composition?.recipeId || '').trim() || 'image-sequence-optional-audio-bed',
    recipeLabel: String(compositionArtifact?.composition?.recipeLabel || '').trim() || 'Image sequence with optional narration and background music',
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
          summary: audioPlan.primaryAudioTrack?.summary || summarizeArtifact(audioArtifact),
        })
      : null,
    backgroundMusicTrack: backgroundMusicArtifact
      ? serializeArtifactForUi({
          artifact: backgroundMusicArtifact,
          summary: audioPlan.backgroundMusicTrack?.summary || summarizeArtifact(backgroundMusicArtifact),
        })
      : null,
    audioMix: buildAudioMixMetadata(audioPlan),
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
  const stopMode = String(options.stopMode || '').trim() === 'visuals' ? 'visuals' : 'shortest';
  const visualDurationSeconds = calculateVisualDurationSeconds(visualTrack);
  const audioMix = resolveCompositionAudioMix(compositionArtifact);
  const audioPlan = buildAudioPlan(
    getPrimaryAudioTrack(compositionArtifact),
    getBackgroundMusicTrack(compositionArtifact),
    stopMode,
    visualDurationSeconds,
    audioMix,
  );
  const exportProfile = {
    width: Math.max(16, Number(options.width || 0) || 1280),
    height: Math.max(16, Number(options.height || 0) || 720),
    fps: Math.max(1, Number(options.fps || 0) || 30),
    fitMode: String(options.fitMode || '').trim() === 'cover' ? 'cover' : 'contain',
    stopMode,
    videoCodec: 'libx264',
    audioCodec: audioPlan.hasPrimaryAudio || audioPlan.hasBackgroundMusic ? 'aac' : 'none',
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

  if (audioPlan.primaryAudioArtifact?.filePath) {
    args.push('-i', audioPlan.primaryAudioArtifact.filePath);
  }

  if (audioPlan.backgroundMusicArtifact?.filePath) {
    if (audioPlan.shouldLoopBackgroundMusic) {
      args.push('-stream_loop', '-1');
    }
    args.push('-i', audioPlan.backgroundMusicArtifact.filePath);
  }

  const backgroundMusicInputIndex = audioPlan.hasPrimaryAudio ? 2 : 1;
  let audioMapTarget = '';
  if (audioPlan.mode === 'mixed-with-background-music') {
    args.push(
      '-filter_complex',
      `[1:a]aresample=async=1:first_pts=0,volume=${formatVolumeFilterValue(audioPlan.narrationVolume)}[primary];[${backgroundMusicInputIndex}:a]aresample=async=1:first_pts=0,volume=${formatVolumeFilterValue(audioPlan.backgroundMusicVolume)}[music];[primary][music]amix=inputs=2:duration=longest:dropout_transition=2[aout]`,
    );
    audioMapTarget = '[aout]';
  } else if (audioPlan.mode === 'primary-audio-only') {
    args.push('-filter_complex', `[1:a]aresample=async=1:first_pts=0,volume=${formatVolumeFilterValue(audioPlan.narrationVolume)}[aout]`);
    audioMapTarget = '[aout]';
  } else if (audioPlan.mode === 'background-music-only') {
    args.push('-filter_complex', `[${backgroundMusicInputIndex}:a]aresample=async=1:first_pts=0,volume=${formatVolumeFilterValue(audioPlan.backgroundMusicVolume)}[aout]`);
    audioMapTarget = '[aout]';
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
    '-map',
    '0:v:0',
  );

  if (audioMapTarget) {
    args.push('-map', audioMapTarget);
  } else if (audioPlan.hasPrimaryAudio) {
    args.push('-map', '1:a:0');
  } else if (audioPlan.hasBackgroundMusic) {
    args.push('-map', `${backgroundMusicInputIndex}:a:0`);
  }

  if (audioPlan.hasPrimaryAudio || audioPlan.hasBackgroundMusic) {
    args.push('-c:a', exportProfile.audioCodec);
    if (audioPlan.outputDurationSeconds) {
      args.push('-t', String(audioPlan.outputDurationSeconds));
    } else if (exportProfile.stopMode === 'shortest') {
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

  const compositionExport = buildCompositionExportMetadata(compositionArtifact, visualTrack, audioPlan, exportProfile);
  const metadataPath = await writeCompositionExportMetadata(outputPath, compositionExport);
  const artifact = await buildFileArtifact(outputPath, {
    compositionExport,
    displayName: title,
    kind: PORT_KIND_VIDEO,
    role: 'generated',
  });
  artifact.metadataPaths = [metadataPath];
  artifact.summary = summarizeArtifact(artifact);

  const message = audioPlan.mode === 'mixed-with-background-music'
    ? `Media Export rendered a video from ${visualItems.length} images with background music at ${formatVolumePercent(audioPlan.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME)}% and narration at ${formatVolumePercent(audioPlan.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME)}%.`
    : audioPlan.mode === 'primary-audio-only'
      ? `Media Export rendered a video from ${visualItems.length} images with ${audioPlan.primaryAudioArtifact.fileName} as the primary audio track at ${formatVolumePercent(audioPlan.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME)}%.`
      : audioPlan.mode === 'background-music-only'
        ? `Media Export rendered a video from ${visualItems.length} images with ${audioPlan.backgroundMusicArtifact.fileName} as the soundtrack at ${formatVolumePercent(audioPlan.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME)}%.`
        : `Media Export rendered a silent video from ${visualItems.length} images.`;

  return {
    artifact,
    message,
    metadataPath,
  };
}

module.exports = {
  exportCompositionArtifactToVideo,
  resolveFfmpegPath,
};
