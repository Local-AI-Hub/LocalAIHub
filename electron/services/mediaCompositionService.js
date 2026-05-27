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
const { createLogger } = require('./logService');
const { buildFileArtifact, isCompositionArtifact, serializeArtifactForUi, summarizeArtifact } = require('./pipelineArtifactService');
const {
  DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME,
  MEDIA_COMPOSITION_XFADE_TRANSITIONS,
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

function buildNormalizedXfadeVideoFilter(width, height, fitMode, fps) {
  const baseFilter = buildVideoFilter(width, height, fitMode);
  return `fps=${Math.max(1, Number(fps || 0) || 30)},${baseFilter},setsar=1,settb=AVTB,setpts=PTS-STARTPTS`;
}

function formatFfmpegSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '0';
  }
  return String(Math.round(Math.max(0, numeric) * 1000) / 1000);
}

function getBoundaryDurationSeconds(boundary) {
  return Math.max(0, Number(boundary?.effectiveDurationSeconds || 0) || 0);
}

function calculateMediaExportTimeoutMs(visualDurationSeconds, itemCount, transitionCount) {
  const durationSeconds = Math.max(1, Number(visualDurationSeconds || 0) || 1);
  const items = Math.max(1, Number(itemCount || 0) || 1);
  const transitions = Math.max(0, Number(transitionCount || 0) || 0);
  const estimatedMs = (durationSeconds * 10000) + (items * 5000) + (transitions * 3000);
  return Math.max(120000, Math.min(900000, Math.round(estimatedMs)));
}

function summarizeSceneTransitionPlanForLog(sceneTransitions) {
  const boundaries = Array.isArray(sceneTransitions?.boundaries) ? sceneTransitions.boundaries : [];
  return {
    enabled: Boolean(sceneTransitions?.enabled),
    renderEnabled: Boolean(sceneTransitions?.renderEnabled),
    mode: String(sceneTransitions?.mode || '').trim(),
    configuredDurationSeconds: Number(sceneTransitions?.configuredDurationSeconds || 0) || 0,
    transitionCount: boundaries.length,
    renderedTransitionCount: boundaries.filter((boundary) => getBoundaryDurationSeconds(boundary) > 0.001).length,
    totalVisualDurationSeconds: Number(sceneTransitions?.totalVisualDurationSeconds || 0) || 0,
    notes: Array.isArray(sceneTransitions?.notes) ? sceneTransitions.notes.slice(0, 4) : [],
  };
}

function parseSupportedXfadeTransitions(helpText) {
  const supported = new Set();
  const transitionSet = new Set(MEDIA_COMPOSITION_XFADE_TRANSITIONS);
  for (const line of String(helpText || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-z][a-z0-9]*)\s+-?\d+\s+/i);
    if (match && transitionSet.has(match[1])) {
      supported.add(match[1]);
    }
  }
  return supported;
}

async function detectSupportedXfadeTransitions(ffmpegPath) {
  const result = await runCommand(ffmpegPath, ['-hide_banner', '-h', 'filter=xfade'], {
    allowFailure: true,
    timeoutMs: 10000,
  });
  if (Number(result.code || 0) !== 0) {
    return {
      notes: ['This FFmpeg build did not report xfade transition support, so scene transitions were skipped.'],
      supported: new Set(),
    };
  }
  const supported = parseSupportedXfadeTransitions(String(result.stdout || '') + '\n' + String(result.stderr || ''));
  return {
    notes: supported.size ? [] : ['This FFmpeg build did not list any xfade transitions, so scene transitions were skipped.'],
    supported,
  };
}

function buildRenderableSceneTransitionPlan(visualTrack, supportInfo) {
  const sourcePlan = visualTrack?.sceneTransitions || visualTrack?.timing?.sceneTransitions || null;
  const notes = [...(Array.isArray(sourcePlan?.notes) ? sourcePlan.notes : []), ...(supportInfo?.notes || [])];
  if (!sourcePlan?.enabled) {
    return sourcePlan ? { ...sourcePlan, notes, renderEnabled: false } : null;
  }
  const boundaries = Array.isArray(sourcePlan.boundaries) ? sourcePlan.boundaries : [];
  const supported = supportInfo?.supported instanceof Set ? supportInfo.supported : new Set();
  if (!supported.size) {
    return {
      ...sourcePlan,
      boundaries,
      notes,
      renderEnabled: false,
    };
  }
  const fallbackTransition = supported.has('fade') ? 'fade' : MEDIA_COMPOSITION_XFADE_TRANSITIONS.find((name) => supported.has(name)) || '';
  const renderBoundaries = boundaries.map((boundary) => {
    const requestedTransition = String(boundary?.selectedTransition || '').trim();
    const selectedTransition = supported.has(requestedTransition) ? requestedTransition : fallbackTransition;
    const boundaryNotes = Array.isArray(boundary?.notes) ? [...boundary.notes] : [];
    if (requestedTransition && selectedTransition && requestedTransition !== selectedTransition) {
      boundaryNotes.push(`FFmpeg does not support ${requestedTransition} here, so ${selectedTransition} was used instead.`);
    }
    if (!selectedTransition) {
      boundaryNotes.push('No supported xfade transition was available for this boundary.');
    }
    return {
      ...boundary,
      notes: boundaryNotes,
      requestedTransition: requestedTransition || null,
      selectedTransition: selectedTransition || requestedTransition,
      unsupportedFallback: Boolean(requestedTransition && selectedTransition && requestedTransition !== selectedTransition),
    };
  });
  const renderEnabled = renderBoundaries.length === Math.max(0, (Array.isArray(visualTrack?.items) ? visualTrack.items.length : 0) - 1)
    && renderBoundaries.every((boundary) => String(boundary.selectedTransition || '').trim() && getBoundaryDurationSeconds(boundary) > 0.001);
  if (!renderEnabled) {
    notes.push('Scene transitions were skipped because at least one boundary could not be rendered safely.');
  }
  return {
    ...sourcePlan,
    boundaries: renderBoundaries,
    enabled: Boolean(sourcePlan.enabled),
    notes,
    renderEnabled,
  };
}

function getXfadeInputDurationSeconds(visualItems, transitionPlan, index) {
  const slotDurationSeconds = Math.max(0.1, Number(visualItems[index]?.durationSeconds || 0) || 0.1);
  if (index <= 0) {
    return slotDurationSeconds;
  }
  const previousBoundary = transitionPlan?.boundaries?.[index - 1] || null;
  return slotDurationSeconds + getBoundaryDurationSeconds(previousBoundary);
}

function buildXfadeFilterComplex(visualItems, exportProfile, transitionPlan, audioFilters = []) {
  const filters = [];
  for (let index = 0; index < visualItems.length; index += 1) {
    filters.push(`[${index}:v]${buildNormalizedXfadeVideoFilter(exportProfile.width, exportProfile.height, exportProfile.fitMode, exportProfile.fps)}[v${index}]`);
  }

  let currentLabel = 'v0';
  transitionPlan.boundaries.forEach((boundary, index) => {
    const outputLabel = `vx${index + 1}`;
    filters.push(
      `[${currentLabel}][v${index + 1}]xfade=transition=${boundary.selectedTransition}:duration=${formatFfmpegSeconds(boundary.effectiveDurationSeconds)}:offset=${formatFfmpegSeconds(boundary.offsetSeconds)}[${outputLabel}]`,
    );
    currentLabel = outputLabel;
  });

  return {
    filterComplex: [...filters, ...audioFilters].join(';'),
    videoMapTarget: `[${currentLabel}]`,
  };
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

function buildCompositionExportMetadata(compositionArtifact, visualTrack, audioPlan, exportProfile, options = {}) {
  const audioArtifact = audioPlan.primaryAudioArtifact;
  const backgroundMusicArtifact = audioPlan.backgroundMusicArtifact;
  const mediaCompositionNodeId = String(options.mediaCompositionNodeId || '').trim();
  const mediaCompositionNodeLabel = String(options.mediaCompositionNodeLabel || '').trim();
  const mediaExportNodeId = String(options.mediaExportNodeId || '').trim();
  const mediaExportNodeLabel = String(options.mediaExportNodeLabel || '').trim();
  return {
    schemaVersion: 1,
    recipeId: String(compositionArtifact?.composition?.recipeId || '').trim() || 'image-sequence-optional-audio-bed',
    recipeLabel: String(compositionArtifact?.composition?.recipeLabel || '').trim() || 'Image sequence with optional narration and background music',
    pipelineTrace: serializeArtifactForUi({
      mediaCompositionNodeId,
      mediaCompositionNodeLabel,
      mediaExportNodeId,
      mediaExportNodeLabel,
    }),
    composition: serializeArtifactForUi({
      displayName: compositionArtifact?.displayName || '',
      manifestPath: compositionArtifact?.manifestPath || '',
      nodeId: mediaCompositionNodeId,
      nodeLabel: mediaCompositionNodeLabel,
      summary: compositionArtifact?.summary || '',
    }),
    exportProfile: serializeArtifactForUi(exportProfile),
    visualTrack: serializeArtifactForUi({
      imageTimingMode: String(visualTrack?.imageTimingMode || visualTrack?.timing?.imageTimingMode || '').trim(),
      itemCount: Number(visualTrack?.itemCount || visualTrack?.items?.length || 0) || 0,
      itemDurationSeconds: Number(visualTrack?.itemDurationSeconds || 0) || 0,
      perImageDurations: Array.isArray(visualTrack?.timing?.perImageDurations) ? visualTrack.timing.perImageDurations : (Array.isArray(visualTrack?.items) ? visualTrack.items.map((entry, index) => ({
        durationSeconds: Number(entry?.durationSeconds || 0) || 0,
        endSeconds: Number(entry?.endSeconds || 0) || null,
        itemId: String(entry?.itemId || '').trim(),
        itemIndex: index,
        startSeconds: Number(entry?.startSeconds || 0) || 0,
      })) : []),
      sourceCollection: visualTrack?.sourceCollection || null,
      summary: visualTrack?.summary || '',
      sceneTransitions: options.sceneTransitions || visualTrack?.sceneTransitions || visualTrack?.timing?.sceneTransitions || null,
      timing: visualTrack?.timing || null,
      timingMetadataUsed: Boolean(visualTrack?.timing?.timingMetadataUsed),
      totalVisualDurationSeconds: Number(visualTrack?.timing?.totalVisualDurationSeconds || calculateVisualDurationSeconds(visualTrack) || 0) || 0,
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
  const logger = createLogger('pipeline-media-composition', {
    mediaCompositionNodeId: String(options.mediaCompositionNodeId || '').trim(),
    mediaExportNodeId: String(options.mediaExportNodeId || '').trim(),
    title,
  });
  const exportDirectoryPath = path.join(
    runDirectories.artifactsDir,
    `${sanitizeSegment(title, 'composed-video')}-export-${Date.now()}`,
  );
  await fs.ensureDir(exportDirectoryPath);

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
  const ffmpegPath = resolveFfmpegPath();
  const plannedSceneTransitions = visualTrack?.sceneTransitions || visualTrack?.timing?.sceneTransitions || null;
  const sceneTransitions = visualItems.length > 1 && plannedSceneTransitions?.enabled
    ? buildRenderableSceneTransitionPlan(visualTrack, await detectSupportedXfadeTransitions(ffmpegPath))
    : buildRenderableSceneTransitionPlan(visualTrack, { supported: new Set(), notes: [] });
  const shouldRenderSceneTransitions = Boolean(sceneTransitions?.renderEnabled);
  const transitionCount = Array.isArray(sceneTransitions?.boundaries) ? sceneTransitions.boundaries.length : 0;
  const commandTimeoutMs = calculateMediaExportTimeoutMs(visualDurationSeconds, visualItems.length, shouldRenderSceneTransitions ? transitionCount : 0);
  const concatManifestPath = shouldRenderSceneTransitions ? '' : await writeConcatManifest(exportDirectoryPath, visualTrack);
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
    concatManifestPath: concatManifestPath || null,
    sceneTransitions,
    commandTimeoutMs,
  };

  options.reportProgress?.(
    'Preparing media export.',
    shouldRenderSceneTransitions
      ? 'Rendering the composition with scene transitions using the bundled ffmpeg runtime...'
      : 'Rendering the composition to video with the bundled ffmpeg runtime...',
  );
  await logger.info('Media Export ffmpeg render starting.', {
    itemCount: visualItems.length,
    outputPath,
    renderMode: shouldRenderSceneTransitions ? 'xfade-transitions' : 'concat-sequence',
    timeoutMs: commandTimeoutMs,
    transitionPlan: summarizeSceneTransitionPlanForLog(sceneTransitions),
    visualDurationSeconds,
    width: exportProfile.width,
    height: exportProfile.height,
    fps: exportProfile.fps,
  }).catch(() => null);

  const args = ['-hide_banner', '-y'];
  let primaryAudioInputIndex = 1;
  let backgroundMusicInputIndex = audioPlan.hasPrimaryAudio ? 2 : 1;
  if (shouldRenderSceneTransitions) {
    visualItems.forEach((entry, index) => {
      args.push(
        '-stream_loop',
        '-1',
        '-t',
        formatFfmpegSeconds(getXfadeInputDurationSeconds(visualItems, sceneTransitions, index)),
        '-i',
        entry.artifact.filePath,
      );
    });
    primaryAudioInputIndex = visualItems.length;
    backgroundMusicInputIndex = visualItems.length + (audioPlan.hasPrimaryAudio ? 1 : 0);
  } else {
    args.push(
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatManifestPath,
    );
  }

  if (audioPlan.primaryAudioArtifact?.filePath) {
    args.push('-i', audioPlan.primaryAudioArtifact.filePath);
  }

  if (audioPlan.backgroundMusicArtifact?.filePath) {
    if (audioPlan.shouldLoopBackgroundMusic) {
      args.push('-stream_loop', '-1');
    }
    args.push('-i', audioPlan.backgroundMusicArtifact.filePath);
  }

  let audioMapTarget = '';
  const audioFilters = [];
  if (audioPlan.mode === 'mixed-with-background-music') {
    audioFilters.push(`[${primaryAudioInputIndex}:a]aresample=async=1:first_pts=0,volume=${formatVolumeFilterValue(audioPlan.narrationVolume)}[primary]`);
    audioFilters.push(`[${backgroundMusicInputIndex}:a]aresample=async=1:first_pts=0,volume=${formatVolumeFilterValue(audioPlan.backgroundMusicVolume)}[music]`);
    audioFilters.push('[primary][music]amix=inputs=2:duration=longest:dropout_transition=2[aout]');
    audioMapTarget = '[aout]';
  } else if (audioPlan.mode === 'primary-audio-only') {
    audioFilters.push(`[${primaryAudioInputIndex}:a]aresample=async=1:first_pts=0,volume=${formatVolumeFilterValue(audioPlan.narrationVolume)}[aout]`);
    audioMapTarget = '[aout]';
  } else if (audioPlan.mode === 'background-music-only') {
    audioFilters.push(`[${backgroundMusicInputIndex}:a]aresample=async=1:first_pts=0,volume=${formatVolumeFilterValue(audioPlan.backgroundMusicVolume)}[aout]`);
    audioMapTarget = '[aout]';
  }

  if (shouldRenderSceneTransitions) {
    const xfadeFilter = buildXfadeFilterComplex(visualItems, exportProfile, sceneTransitions, audioFilters);
    args.push('-filter_complex', xfadeFilter.filterComplex);
    args.push(
      '-map',
      xfadeFilter.videoMapTarget,
      '-r',
      String(exportProfile.fps),
      '-c:v',
      exportProfile.videoCodec,
      '-pix_fmt',
      exportProfile.pixelFormat,
      '-movflags',
      '+faststart',
    );
  } else {
    if (audioFilters.length) {
      args.push('-filter_complex', audioFilters.join(';'));
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
  }

  if (audioMapTarget) {
    args.push('-map', audioMapTarget);
  }

  if (audioPlan.hasPrimaryAudio || audioPlan.hasBackgroundMusic) {
    args.push('-c:a', exportProfile.audioCodec);
    if (audioPlan.outputDurationSeconds) {
      args.push('-t', String(audioPlan.outputDurationSeconds));
    } else {
      if (shouldRenderSceneTransitions && visualDurationSeconds > 0) {
        args.push('-t', formatFfmpegSeconds(visualDurationSeconds));
      }
      if (exportProfile.stopMode === 'shortest') {
        args.push('-shortest');
      }
    }
  } else {
    args.push('-an');
    if (shouldRenderSceneTransitions && visualDurationSeconds > 0) {
      args.push('-t', formatFfmpegSeconds(visualDurationSeconds));
    }
  }
  args.push(outputPath);

  const commandResult = await runCommand(ffmpegPath, args, {
    abortMessage: 'Media Export was cancelled while rendering the video.',
    allowFailure: true,
    signal: options.cancelSignal || null,
    timeoutMessage: 'Media Export took too long while rendering the video, so Local AI Hub stopped FFmpeg. Try shorter transitions, fewer scenes, or a lower export resolution.',
    timeoutMs: commandTimeoutMs,
  });
  if (Number(commandResult.code || 0) !== 0 || !(await fs.pathExists(outputPath))) {
    const failureLine = firstNonEmptyLine(commandResult.stderr) || firstNonEmptyLine(commandResult.stdout);
    await logger.warn('Media Export ffmpeg render failed.', {
      code: commandResult.code || 0,
      message: failureLine || '',
      outputPath,
      renderMode: shouldRenderSceneTransitions ? 'xfade-transitions' : 'concat-sequence',
      transitionPlan: summarizeSceneTransitionPlanForLog(sceneTransitions),
      visualDurationSeconds,
    }).catch(() => null);
    throw new Error(failureLine || 'Local AI Hub could not render the media composition to video.');
  }

  await logger.info('Media Export ffmpeg render finished.', {
    outputPath,
    renderMode: shouldRenderSceneTransitions ? 'xfade-transitions' : 'concat-sequence',
    sizeBytes: (await fs.stat(outputPath).catch(() => ({ size: 0 }))).size || 0,
    transitionPlan: summarizeSceneTransitionPlanForLog(sceneTransitions),
    visualDurationSeconds,
  }).catch(() => null);

  const compositionExport = buildCompositionExportMetadata(compositionArtifact, visualTrack, audioPlan, exportProfile, { ...options, sceneTransitions });
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
