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
const { resolveAssetLibraryPreviewFile } = require('./assetLibraryService');
const {
  DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME,
  DEFAULT_MEDIA_COMPOSITION_SOUND_EFFECTS_VOLUME,
  MEDIA_COMPOSITION_XFADE_TRANSITIONS,
  MEDIA_COMPOSITION_UNSTABLE_XFADE_TRANSITIONS,
  PORT_KIND_VIDEO,
} = require('../shared/pipelineSchema.cjs');

const MEDIA_COMPOSITION_AMIX_NORMALIZE = 0;

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
    sourceVideoVolume: normalizeAudioVolume(mix.sourceVideoVolume, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME),
    soundEffectsVolume: normalizeAudioVolume(mix.soundEffectsVolume, 1),
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

function getDiagnosticTail(value, limit = 12) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-Math.max(1, Number(limit || 0) || 12))
    .join('\n');
}

function normalizeProcessExitCode(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value;
  }
  return numeric > 0x7fffffff ? numeric - 0x100000000 : numeric;
}

function getFfmpegFailureDiagnostic(commandResult) {
  const lines = `${String(commandResult?.stderr || '')}\n${String(commandResult?.stdout || '')}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const meaningful = lines.filter((line) => /no space left|error|invalid|failed|unable|cannot|could not|conversion failed/i.test(line));
  return (meaningful.length ? meaningful.slice(-4) : lines.slice(-10)).join('\n');
}

function buildFfmpegFailureMessage(commandResult) {
  const code = normalizeProcessExitCode(commandResult?.code);
  const diagnostic = getFfmpegFailureDiagnostic(commandResult);
  const codeMessage = Number(code || 0) ? `FFmpeg stopped with exit code ${code}.` : 'FFmpeg stopped before producing a valid video.';
  const outputHint = code === -28
    ? ' FFmpeg could not finalize the output. Check free disk space; if space is available, retry after removing or shortening any endlessly looping media input.'
    : '';
  return diagnostic
    ? `Local AI Hub could not render the media composition to video. ${codeMessage}${outputHint} FFmpeg diagnostic: ${diagnostic}`
    : `Local AI Hub could not render the media composition to video. ${codeMessage}${outputHint}`;
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
  const unstableTransitionSet = new Set(MEDIA_COMPOSITION_UNSTABLE_XFADE_TRANSITIONS);
  const transitionSet = new Set(MEDIA_COMPOSITION_XFADE_TRANSITIONS.filter((transition) => !unstableTransitionSet.has(transition)));
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

async function probeVisualMediaFile(ffmpegPath, filePath) {
  const result = await runCommand(ffmpegPath, ['-hide_banner', '-i', filePath], { allowFailure: true, timeoutMs: 15000 });
  const text = String(result.stderr || '') + '\n' + String(result.stdout || '');
  const durationMatch = text.match(/Duration:\s*(\d+):(\d+):([0-9.]+)/i);
  const durationSeconds = durationMatch
    ? (Number(durationMatch[1]) * 3600) + (Number(durationMatch[2]) * 60) + Number(durationMatch[3])
    : 0;
  return {
    audioPresent: /Audio:/i.test(text),
    durationSeconds: Math.round(Math.max(0, durationSeconds) * 1000) / 1000,
  };
}

function buildVideoSequenceFilterComplex(visualItems, exportProfile, transitionPlan, probes, audioFilters = [], includeAudioTimeline = false) {
  const filters = [];
  visualItems.forEach((entry, index) => {
    const durationSeconds = Math.max(0.05, Number(entry?.durationSeconds || probes[index]?.durationSeconds || 0) || 0.05);
    filters.push(`[${index}:v]trim=duration=${formatFfmpegSeconds(durationSeconds)},${buildNormalizedXfadeVideoFilter(exportProfile.width, exportProfile.height, exportProfile.fitMode, exportProfile.fps)}[v${index}]`);
  });

  let videoMapTarget = '[v0]';
  if (visualItems.length > 1 && transitionPlan?.renderEnabled) {
    let currentLabel = 'v0';
    let renderedDurationSeconds = Math.max(0.05, Number(visualItems[0]?.durationSeconds || 0) || 0.05);
    transitionPlan.boundaries.forEach((boundary, index) => {
      const transitionDurationSeconds = getBoundaryDurationSeconds(boundary);
      const outputLabel = `vx${index + 1}`;
      const offsetSeconds = Math.max(0, renderedDurationSeconds - transitionDurationSeconds);
      filters.push(`[${currentLabel}][v${index + 1}]xfade=transition=${boundary.selectedTransition}:duration=${formatFfmpegSeconds(transitionDurationSeconds)}:offset=${formatFfmpegSeconds(offsetSeconds)}[${outputLabel}]`);
      renderedDurationSeconds = renderedDurationSeconds + Math.max(0.05, Number(visualItems[index + 1]?.durationSeconds || 0) || 0.05) - transitionDurationSeconds;
      currentLabel = outputLabel;
    });
    videoMapTarget = `[${currentLabel}]`;
  } else if (visualItems.length > 1) {
    filters.push(`${visualItems.map((entry, index) => `[v${index}]`).join('')}concat=n=${visualItems.length}:v=1:a=0[vout]`);
    videoMapTarget = '[vout]';
  }

  const anySourceAudio = probes.some((probe) => probe.audioPresent);
  let sourceAudioMapTarget = '';
  if (includeAudioTimeline) {
    visualItems.forEach((entry, index) => {
      const durationSeconds = Math.max(0.05, Number(entry?.durationSeconds || probes[index]?.durationSeconds || 0) || 0.05);
      if (probes[index]?.audioPresent) {
        filters.push(`[${index}:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${formatFfmpegSeconds(durationSeconds)},atrim=duration=${formatFfmpegSeconds(durationSeconds)},asetpts=PTS-STARTPTS[clipa${index}]`);
      } else {
        filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${formatFfmpegSeconds(durationSeconds)},asetpts=PTS-STARTPTS[clipa${index}]`);
      }
    });
    if (visualItems.length > 1 && transitionPlan?.renderEnabled) {
      let currentAudioLabel = 'clipa0';
      transitionPlan.boundaries.forEach((boundary, index) => {
        const outputLabel = `clipax${index + 1}`;
        filters.push(`[${currentAudioLabel}][clipa${index + 1}]acrossfade=d=${formatFfmpegSeconds(getBoundaryDurationSeconds(boundary))}:c1=tri:c2=tri[${outputLabel}]`);
        currentAudioLabel = outputLabel;
      });
      sourceAudioMapTarget = `[${currentAudioLabel}]`;
    } else if (visualItems.length > 1) {
      filters.push(`${visualItems.map((entry, index) => `[clipa${index}]`).join('')}concat=n=${visualItems.length}:v=0:a=1[sourceaudio]`);
      sourceAudioMapTarget = '[sourceaudio]';
    } else {
      sourceAudioMapTarget = '[clipa0]';
    }
  }

  return {
    filterComplex: [...filters, ...audioFilters].join(';'),
    anySourceAudio,
    sourceAudioMapTarget,
    videoMapTarget,
  };
}

function calculateVisualDurationSeconds(visualTrack) {
  const plannedDurationSeconds = Number(visualTrack?.timing?.totalVisualDurationSeconds || 0) || 0;
  if (plannedDurationSeconds > 0) {
    return plannedDurationSeconds;
  }
  const items = Array.isArray(visualTrack?.items) ? visualTrack.items : [];
  return items.reduce((total, entry) => total + Math.max(0, Number(entry?.durationSeconds || visualTrack?.itemDurationSeconds || 0) || 0), 0);
}

function buildAudioPlan(primaryAudioTrack, backgroundMusicTrack, stopMode, visualDurationSeconds, audioMix = {}, soundEffectsExport = null, soundEffectsPlan = null, sourceVisualAudio = null) {
  const primaryAudioArtifact = primaryAudioTrack?.artifact || null;
  const backgroundMusicArtifact = backgroundMusicTrack?.artifact || null;
  const soundEffectEvents = Array.isArray(soundEffectsExport?.events) ? soundEffectsExport.events : [];
  const primaryConfigured = soundEffectsPlan?.requested || soundEffectsPlan || null;
  const hasPrimaryAudio = Boolean(primaryAudioArtifact?.filePath);
  const hasBackgroundMusic = Boolean(backgroundMusicArtifact?.filePath);
  const hasSoundEffects = soundEffectEvents.length > 0;
  const hasSourceVisualAudio = sourceVisualAudio?.present === true;
  const hasSourceVisualTimeline = sourceVisualAudio?.timelinePresent === true;
  const shouldLoopBackgroundMusic = hasBackgroundMusic && (hasSourceVisualTimeline || hasPrimaryAudio || hasSoundEffects || stopMode === 'visuals');

  let baseMode = hasSourceVisualAudio ? 'source-video-audio' : 'silent';
  if (hasSourceVisualAudio && (hasPrimaryAudio || hasBackgroundMusic)) {
    baseMode = 'source-video-audio-mixed';
  } else if (hasPrimaryAudio && hasBackgroundMusic) {
    baseMode = 'mixed-with-background-music';
  } else if (hasPrimaryAudio) {
    baseMode = 'primary-audio-only';
  } else if (hasBackgroundMusic) {
    baseMode = 'background-music-only';
  }

  return {
    backgroundMusicArtifact,
    backgroundMusicTrack,
    backgroundMusicVolume: normalizeAudioVolume(audioMix.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME),
    narrationVolume: normalizeAudioVolume(audioMix.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME),
    sourceVideoVolume: normalizeAudioVolume(audioMix.sourceVideoVolume, DEFAULT_MEDIA_COMPOSITION_SOURCE_VIDEO_VOLUME),
    soundEffectsEnabled: soundEffectsPlan?.enabled === true,
    soundEffectsEvents: soundEffectEvents,
    soundEffectsFadeSeconds: Math.max(0, Math.min(2, Number(primaryConfigured?.fadeSeconds ?? soundEffectsPlan?.fadeSeconds ?? 0) || 0)),
    soundEffectsMetadata: buildSoundEffectsExportMetadata(soundEffectsPlan, soundEffectsExport),
    soundEffectsVolume: normalizeAudioVolume(audioMix.soundEffectsVolume ?? primaryConfigured?.globalVolume ?? 1, 1),
    hasBackgroundMusic,
    hasPrimaryAudio,
    hasSoundEffects,
    hasSourceVisualAudio,
    hasSourceVisualTimeline,
    hasAnyAudio: hasSourceVisualAudio || hasPrimaryAudio || hasBackgroundMusic || hasSoundEffects,
    mode: getSoundEffectsAudioMode(baseMode, hasSoundEffects),
    outputDurationSeconds: (hasSourceVisualTimeline || stopMode === 'visuals' || hasSoundEffects) && visualDurationSeconds > 0 ? Math.round(visualDurationSeconds * 1000) / 1000 : null,
    primaryAudioArtifact,
    primaryAudioTrack,
    shouldLoopBackgroundMusic,
    sourceVisualAudio,
    stopMode,
  };
}
function buildAudioMixMetadata(audioPlan) {
  const soundEffectsLayers = Array.isArray(audioPlan.soundEffectsMetadata?.layers) ? audioPlan.soundEffectsMetadata.layers : [];
  const soundEffectsGlobalGuard = audioPlan.soundEffectsMetadata?.globalGuard && typeof audioPlan.soundEffectsMetadata.globalGuard === 'object'
    ? audioPlan.soundEffectsMetadata.globalGuard
    : null;
  const amixInputCount = [
    audioPlan.hasSourceVisualTimeline && audioPlan.hasAnyAudio,
    audioPlan.hasPrimaryAudio,
    audioPlan.hasBackgroundMusic,
    ...audioPlan.soundEffectsEvents.map(() => true),
  ].filter(Boolean).length;
  const soundEffectsEffectiveGains = audioPlan.soundEffectsEvents.map((event, index) => ({
    effectiveGain: getSoundEffectEffectiveGain(event, audioPlan.soundEffectsVolume),
    eventIndex: index,
    itemId: String(event?.itemId || '').trim(),
    layerGain: normalizeAudioVolume(event?.volume ?? 1, 1),
    layerId: String(event?.layerId || '').trim(),
    layerIndex: Number.isFinite(Number(event?.layerIndex)) ? Number(event.layerIndex) : null,
    globalGain: audioPlan.soundEffectsVolume,
  }));
  const effectiveGains = {
    ...(audioPlan.hasSourceVisualTimeline ? { sourceVideoAudio: audioPlan.hasSourceVisualAudio ? audioPlan.sourceVideoVolume : null } : {}),
    backgroundMusic: audioPlan.hasBackgroundMusic ? audioPlan.backgroundMusicVolume : null,
    narration: audioPlan.hasPrimaryAudio ? audioPlan.narrationVolume : null,
    soundEffects: audioPlan.hasSoundEffects ? audioPlan.soundEffectsVolume : null,
    soundEffectsEvents: soundEffectsEffectiveGains,
  };
  return {
    amixInputCount,
    amixNormalize: false,
    amixNormalizeExplicit: true,
    backgroundMusicLooping: audioPlan.hasBackgroundMusic ? audioPlan.shouldLoopBackgroundMusic : false,
    backgroundMusicVolume: audioPlan.backgroundMusicVolume,
    clippingPreventionApplied: false,
    effectiveGains,
    gainStaging: {
      amixNormalize: false,
      amixNormalizeExplicit: true,
      clippingPreventionApplied: false,
      effectiveGains,
      limiterApplied: false,
      sourceRelative: true,
    },
    limiterApplied: false,
    narrationVolume: audioPlan.narrationVolume,
    ...(audioPlan.hasSourceVisualTimeline ? {
      sourceVideoAudioPreserved: audioPlan.hasSourceVisualAudio && audioPlan.sourceVideoVolume > 0,
      sourceVideoVolume: audioPlan.sourceVideoVolume,
    } : {}),
    soundEffectsEnabled: audioPlan.soundEffectsEnabled,
    soundEffectsEventCount: audioPlan.soundEffectsEvents.length,
    soundEffectsGlobalGuardEnabled: Boolean(soundEffectsGlobalGuard?.enabled),
    soundEffectsGlobalMaxSimultaneous: soundEffectsGlobalGuard?.maxSimultaneous ?? null,
    soundEffectsGlobalMinSpacingSeconds: soundEffectsGlobalGuard?.minSpacingSeconds ?? null,
    soundEffectsGlobalVolume: audioPlan.soundEffectsVolume,
    soundEffectsGlobalMovedEventCount: Number(soundEffectsGlobalGuard?.movedEventCount || 0) || 0,
    soundEffectsGlobalSkippedEventCount: Number(soundEffectsGlobalGuard?.skippedEventCount || 0) || 0,
    soundEffectsInputCount: audioPlan.soundEffectsEvents.length,
    soundEffectsLayerCount: soundEffectsLayers.length,
    soundEffectsVolume: audioPlan.soundEffectsVolume,
    mode: audioPlan.mode,
    outputDurationSeconds: audioPlan.outputDurationSeconds || null,
    stopMode: audioPlan.stopMode,
  };
}
function getCompositionSoundEffectsPlan(compositionArtifact) {
  const plan = compositionArtifact?.composition?.soundEffects && typeof compositionArtifact.composition.soundEffects === 'object'
    ? compositionArtifact.composition.soundEffects
    : null;
  if (!plan || plan.enabled !== true) {
    return { enabled: false, events: [], notes: plan?.notes || [], requested: plan?.requested || null };
  }
  const events = Array.isArray(plan.scheduledEvents) ? plan.scheduledEvents : [];
  return { ...plan, events };
}

async function resolveSoundEffectEventsForExport(soundEffectsPlan, visualDurationSeconds) {
  if (!soundEffectsPlan?.enabled) {
    return { events: [], notes: soundEffectsPlan?.notes || [] };
  }

  const notes = Array.isArray(soundEffectsPlan.notes) ? [...soundEffectsPlan.notes] : [];
  const resolvedEvents = [];
  for (const event of soundEffectsPlan.events || []) {
    const timeSeconds = Math.max(0, Number(event?.timeSeconds || 0) || 0);
    if (!Number.isFinite(timeSeconds) || timeSeconds >= visualDurationSeconds - 0.001) {
      notes.push(`Skipped ${event?.itemName || 'a sound effect'} because it would start after the composition ends.`);
      continue;
    }

    try {
      const preview = await resolveAssetLibraryPreviewFile('soundEffects', event.libraryId, event.itemId);
      const availableDurationSeconds = Number(event?.durationSeconds || preview.item?.durationSeconds || 0) || 0;
      const remainingSeconds = Math.max(0.05, visualDurationSeconds - timeSeconds);
      const durationSeconds = availableDurationSeconds > 0
        ? Math.max(0.05, Math.min(availableDurationSeconds, remainingSeconds))
        : remainingSeconds;
      const trimmed = availableDurationSeconds > 0 && availableDurationSeconds > remainingSeconds + 0.001;
      if (trimmed) {
        notes.push(`Trimmed ${event?.itemName || preview.item?.displayName || 'a sound effect'} so it ends with the composition.`);
      }
      resolvedEvents.push({
        ...event,
        durationSeconds: Math.round(durationSeconds * 1000) / 1000,
        filePath: preview.filePath,
        itemName: event?.itemName || preview.item?.displayName || preview.item?.originalFilename || preview.item?.id,
        libraryId: preview.libraryId,
        timeSeconds: Math.round(timeSeconds * 1000) / 1000,
        trimmed,
      });
    } catch (error) {
      notes.push(error?.message || `Skipped ${event?.itemName || 'a sound effect'} because Local AI Hub could not read the managed file.`);
    }
  }

  return { events: resolvedEvents, notes };
}

function buildSoundEffectsExportMetadata(soundEffectsPlan, soundEffectsExport) {
  const enabled = soundEffectsPlan?.enabled === true;
  const globalGain = normalizeAudioVolume(soundEffectsPlan?.volume ?? soundEffectsPlan?.requested?.globalVolume ?? 1, 1);
  const safeEvents = (soundEffectsExport?.events || []).map((event) => {
    const { filePath, ...safeEvent } = event || {};
    const layerGain = normalizeAudioVolume(event?.volume ?? 1, 1);
    const effectiveGain = getSoundEffectEffectiveGain(event, globalGain);
    return serializeArtifactForUi({
      ...safeEvent,
      effectiveGain,
      gain: {
        effectiveGain,
        globalGain,
        layerGain,
        sourceRelative: true,
      },
      globalVolume: globalGain,
      layerVolume: layerGain,
    });
  });
  const layers = Array.isArray(soundEffectsPlan?.layers)
    ? soundEffectsPlan.layers.map((layer, index) => {
      const layerId = String(layer?.layerId || layer?.id || '').trim();
      const layerIndex = Number(layer?.layerIndex ?? layer?.index ?? index);
      const scheduledEvents = safeEvents.filter((event) => {
        if (layerId && String(event?.layerId || '').trim() === layerId) {
          return true;
        }
        return Number(event?.layerIndex ?? -1) === layerIndex;
      });
      return serializeArtifactForUi({
        ...(layer || {}),
        effectiveVolume: normalizeAudioVolume(layer?.volume ?? 1, 1) * globalGain,
        globalVolume: globalGain,
        scheduledEventCount: scheduledEvents.length,
        scheduledEvents,
      });
    })
    : [];
  return {
    ...(soundEffectsPlan || {}),
    enabled,
    finalSfxInputCount: safeEvents.length,
    layers,
    notes: soundEffectsExport?.notes || soundEffectsPlan?.notes || [],
    scheduledEventCount: safeEvents.length,
    scheduledEvents: safeEvents,
  };
}
function getSoundEffectsAudioMode(baseMode, hasSoundEffects) {
  if (!hasSoundEffects) {
    return baseMode;
  }
  if (baseMode === 'silent') {
    return 'sound-effects-only';
  }
  return `${baseMode}-with-sound-effects`;
}

function formatDelayMilliseconds(value) {
  return String(Math.max(0, Math.round((Number(value || 0) || 0) * 1000)));
}

function getSoundEffectEffectiveGain(event, globalVolume) {
  const layerGain = normalizeAudioVolume(event?.volume ?? 1, 1);
  const globalGain = normalizeAudioVolume(globalVolume, 1);
  return Math.round(layerGain * globalGain * 1000) / 1000;
}

function buildSoundEffectFilterChain(inputIndex, event, index, volume, fadeSeconds) {
  const durationSeconds = Math.max(0.05, Number(event?.durationSeconds || 0) || 0.05);
  const safeFadeSeconds = Math.max(0, Math.min(Number(fadeSeconds || 0) || 0, durationSeconds / 2));
  const filters = [
    `[${inputIndex}:a]atrim=0:${formatFfmpegSeconds(durationSeconds)}`,
    'asetpts=PTS-STARTPTS',
    'aresample=async=1:first_pts=0',
    'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    `volume=${formatVolumeFilterValue(volume)}`,
  ];
  if (safeFadeSeconds > 0.001) {
    filters.push(`afade=t=in:st=0:d=${formatFfmpegSeconds(safeFadeSeconds)}`);
    filters.push(`afade=t=out:st=${formatFfmpegSeconds(Math.max(0, durationSeconds - safeFadeSeconds))}:d=${formatFfmpegSeconds(safeFadeSeconds)}`);
  }
  filters.push(`adelay=${formatDelayMilliseconds(event?.timeSeconds)}:all=1[sfx${index}]`);
  return filters.join(',');
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
      itemKind: String(visualTrack?.itemKind || '').trim(),
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
    soundEffects: serializeArtifactForUi(audioPlan.soundEffectsMetadata),
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

  const visualItemKind = String(visualTrack.itemKind || visualItems[0]?.artifact?.kind || '').trim();
  const unsupportedItem = visualItems.find((entry) => String(entry?.artifact?.kind || '').trim() !== visualItemKind);
  if (unsupportedItem || !['image', 'video'].includes(visualItemKind)) {
    throw new Error('Media Export needs a visual track containing only images or only videos.');
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
  const soundEffectsPlan = getCompositionSoundEffectsPlan(compositionArtifact);
  const soundEffectsExport = await resolveSoundEffectEventsForExport(soundEffectsPlan, visualDurationSeconds);
  const ffmpegPath = resolveFfmpegPath();
  const visualProbes = visualItemKind === 'video'
    ? await Promise.all(visualItems.map((entry) => probeVisualMediaFile(ffmpegPath, entry.artifact.filePath)))
    : [];
  const audioPlan = buildAudioPlan(
    getPrimaryAudioTrack(compositionArtifact),
    getBackgroundMusicTrack(compositionArtifact),
    stopMode,
    visualDurationSeconds,
    audioMix,
    soundEffectsExport,
    soundEffectsPlan,
    { present: visualProbes.some((probe) => probe.audioPresent), timelinePresent: visualItemKind === 'video', itemAudioPresence: visualProbes.map((probe) => probe.audioPresent) },
  );
  const plannedSceneTransitions = visualTrack?.sceneTransitions || visualTrack?.timing?.sceneTransitions || null;
  const sceneTransitions = visualItems.length > 1 && plannedSceneTransitions?.enabled
    ? buildRenderableSceneTransitionPlan(visualTrack, await detectSupportedXfadeTransitions(ffmpegPath))
    : buildRenderableSceneTransitionPlan(visualTrack, { supported: new Set(), notes: [] });
  const shouldRenderSceneTransitions = Boolean(sceneTransitions?.renderEnabled);
  const transitionCount = Array.isArray(sceneTransitions?.boundaries) ? sceneTransitions.boundaries.length : 0;
  const commandTimeoutMs = calculateMediaExportTimeoutMs(visualDurationSeconds, visualItems.length, shouldRenderSceneTransitions ? transitionCount : 0);
  const concatManifestPath = visualItemKind === 'image' && !shouldRenderSceneTransitions ? await writeConcatManifest(exportDirectoryPath, visualTrack) : '';
  const exportProfile = {
    width: Math.max(16, Number(options.width || 0) || 1280),
    height: Math.max(16, Number(options.height || 0) || 720),
    fps: Math.max(1, Number(options.fps || 0) || 30),
    fitMode: String(options.fitMode || '').trim() === 'cover' ? 'cover' : 'contain',
    stopMode,
    videoCodec: 'libx264',
    audioCodec: audioPlan.hasAnyAudio ? 'aac' : 'none',
    container: 'mp4',
    pixelFormat: 'yuv420p',
    concatManifestPath: concatManifestPath || null,
    compositionMode: String(compositionArtifact?.composition?.compositionMode || 'imageSlideshow').trim() || 'imageSlideshow',
    visualItemKind,
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
    renderMode: shouldRenderSceneTransitions ? 'xfade-transitions' : visualItemKind === 'video' ? 'normalized-video-sequence' : 'concat-sequence',
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
  if (visualItemKind === 'video') {
    visualItems.forEach((entry) => args.push('-i', entry.artifact.filePath));
    primaryAudioInputIndex = visualItems.length;
    backgroundMusicInputIndex = visualItems.length + (audioPlan.hasPrimaryAudio ? 1 : 0);
  } else if (shouldRenderSceneTransitions) {
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

  const firstSoundEffectInputIndex = (visualItemKind === 'video' || shouldRenderSceneTransitions ? visualItems.length : 1)
    + (audioPlan.hasPrimaryAudio ? 1 : 0)
    + (audioPlan.hasBackgroundMusic ? 1 : 0);
  audioPlan.soundEffectsEvents.forEach((event) => {
    args.push('-i', event.filePath);
  });

  let audioMapTarget = '';
  const audioFilters = [];
  const audioMixLabels = [];
  const videoSequenceFilter = visualItemKind === 'video'
    ? buildVideoSequenceFilterComplex(visualItems, exportProfile, sceneTransitions, visualProbes, [], audioPlan.hasAnyAudio)
    : null;
  if (videoSequenceFilter?.sourceAudioMapTarget && audioPlan.hasAnyAudio) {
    audioFilters.push(`${videoSequenceFilter.sourceAudioMapTarget}volume=${formatVolumeFilterValue(audioPlan.sourceVideoVolume)}[sourcevideo]`);
    audioMixLabels.push('[sourcevideo]');
  }
  if (audioPlan.hasPrimaryAudio) {
    audioFilters.push(`[${primaryAudioInputIndex}:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${formatVolumeFilterValue(audioPlan.narrationVolume)}[primary]`);
    audioMixLabels.push('[primary]');
  }
  if (audioPlan.hasBackgroundMusic) {
    audioFilters.push(`[${backgroundMusicInputIndex}:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${formatVolumeFilterValue(audioPlan.backgroundMusicVolume)}[music]`);
    audioMixLabels.push('[music]');
  }
  audioPlan.soundEffectsEvents.forEach((event, index) => {
    audioFilters.push(buildSoundEffectFilterChain(firstSoundEffectInputIndex + index, event, index, getSoundEffectEffectiveGain(event, audioPlan.soundEffectsVolume), event.fadeSeconds ?? audioPlan.soundEffectsFadeSeconds));
    audioMixLabels.push(`[sfx${index}]`);
  });
  if (audioMixLabels.length > 1) {
    audioFilters.push(`${audioMixLabels.join('')}amix=inputs=${audioMixLabels.length}:duration=${visualItemKind === 'video' ? 'first' : 'longest'}:dropout_transition=2:normalize=${MEDIA_COMPOSITION_AMIX_NORMALIZE}[aout]`);
    audioMapTarget = '[aout]';
  } else if (audioMixLabels.length === 1) {
    audioFilters.push(`${audioMixLabels[0]}anull[aout]`);
    audioMapTarget = '[aout]';
  }

  if (visualItemKind === 'video') {
    const filterComplex = [videoSequenceFilter.filterComplex, ...audioFilters].filter(Boolean).join(';');
    args.push('-filter_complex', filterComplex);
    args.push(
      '-map',
      videoSequenceFilter.videoMapTarget,
      '-r',
      String(exportProfile.fps),
      '-c:v',
      exportProfile.videoCodec,
      '-pix_fmt',
      exportProfile.pixelFormat,
      '-movflags',
      '+faststart',
    );
  } else if (shouldRenderSceneTransitions) {
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

  if (audioPlan.hasAnyAudio) {
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
      signedCode: normalizeProcessExitCode(commandResult.code),
      message: failureLine || '',
      stderrTail: getDiagnosticTail(commandResult.stderr, 16),
      stdoutTail: getDiagnosticTail(commandResult.stdout, 8),
      outputPath,
      renderMode: shouldRenderSceneTransitions ? 'xfade-transitions' : visualItemKind === 'video' ? 'normalized-video-sequence' : 'concat-sequence',
      transitionPlan: summarizeSceneTransitionPlanForLog(sceneTransitions),
      visualDurationSeconds,
    }).catch(() => null);
    throw new Error(buildFfmpegFailureMessage(commandResult));
  }

  await logger.info('Media Export ffmpeg render finished.', {
    outputPath,
    renderMode: shouldRenderSceneTransitions ? 'xfade-transitions' : visualItemKind === 'video' ? 'normalized-video-sequence' : 'concat-sequence',
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

  const soundEffectsSummary = audioPlan.hasSoundEffects
    ? ` Sound effects: ${audioPlan.soundEffectsEvents.length} scheduled at ${formatVolumePercent(audioPlan.soundEffectsVolume, 1)}%.`
    : '';
  const visualLabel = visualItemKind === 'video' ? `${visualItems.length} video clip${visualItems.length === 1 ? '' : 's'}` : `${visualItems.length} images`;
  const baseMessage = audioPlan.hasPrimaryAudio && audioPlan.hasBackgroundMusic
    ? `Media Export rendered a video from ${visualLabel} with background music at ${formatVolumePercent(audioPlan.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME)}% and narration at ${formatVolumePercent(audioPlan.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME)}%.`
    : audioPlan.hasPrimaryAudio
      ? `Media Export rendered a video from ${visualLabel} with ${audioPlan.primaryAudioArtifact.fileName} as the primary audio track at ${formatVolumePercent(audioPlan.narrationVolume, DEFAULT_MEDIA_COMPOSITION_NARRATION_VOLUME)}%.`
      : audioPlan.hasBackgroundMusic
        ? `Media Export rendered a video from ${visualLabel} with ${audioPlan.backgroundMusicArtifact.fileName} as the soundtrack at ${formatVolumePercent(audioPlan.backgroundMusicVolume, DEFAULT_MEDIA_COMPOSITION_BACKGROUND_MUSIC_VOLUME)}%.`
        : audioPlan.hasSoundEffects
          ? `Media Export rendered a video from ${visualLabel} with sound effects.`
          : audioPlan.hasSourceVisualAudio
            ? `Media Export rendered ${visualLabel} and preserved the source video audio.`
            : `Media Export rendered a silent video from ${visualLabel}.`;
  const message = baseMessage + soundEffectsSummary;

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
