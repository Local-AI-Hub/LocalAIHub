const {
  isRecord,
  normalizeString,
  normalizeTextBlock,
  trimPreviewText,
} = require('./planningSchemaUtils.cjs');

const PLANNING_SCHEMA_VERSION = 1;
const PLANNING_REVIEW_VERSION = 1;
const VIDEO_PROMPT_SCHEMA_FAMILY_ID = 'videoPromptPlanning';
const VIDEO_PROMPT_PLAN_SCHEMA_ID = 'videoPromptPlan.v1';
const VIDEO_PROMPT_PLAN_KIND = 'videoPromptPlan';
const TARGET_USE_OPTIONS = new Set(['short-film', 'b-roll', 'music-video', 'explainer', 'social-video', 'cinematic-sequence', 'product-video', 'other']);
const CONTINUITY_STRATEGY_OPTIONS = new Set(['independentClips', 'continueFromPreviousClip', 'initialImageThenContinue', 'firstAndLastFrameGuided', 'other']);
const REFERENCE_MODE_OPTIONS = new Set(['none', 'initialReferenceImage', 'continueFromPreviousClip', 'previousClipLastFrame', 'firstAndLastFrame', 'other']);
const REFERENCE_FRAME_ROLE_OPTIONS = new Set(['none', 'firstFrame', 'lastFrame', 'previousClipLastFrame', 'firstAndLastFrame']);

const VIDEO_PROMPT_PLAN_RESPONSE_SHAPE_EXAMPLE = Object.freeze({
  schemaVersion: 1,
  kind: 'videoPromptPlan',
  title: 'Abandoned space station establishing sequence',
  overallStyle: 'Moody cinematic sci-fi, cold practical light, slow suspenseful pacing, realistic orbital scale.',
  targetUse: 'cinematic-sequence',
  continuityStrategy: 'continueFromPreviousClip',
  estimatedTotalDurationSeconds: 30,
  globalNegativePrompt: 'flicker, jitter, warped anatomy, low quality, text artifacts, abrupt cuts',
  clips: [
    {
      index: 1,
      name: 'Exterior drift',
      durationSeconds: 6,
      prompt: 'slow cinematic exterior drift past an abandoned space station above a dark planet, cold rim light, debris rotating slowly, gentle lateral camera move',
      negativePrompt: 'flicker, jitter, warped geometry, unreadable text, low quality',
      cameraMotion: 'slow lateral dolly with slight push-in',
      subjectMotion: 'small debris tumbles slowly while station lights blink faintly',
      setting: 'abandoned orbital station above a shadowed planet',
      action: 'the camera reveals the station silhouette and damaged docking ring',
      referenceMode: 'none',
      referenceFrameRole: 'none',
      needsInitialReferenceImage: false,
      usesPreviousClipLastFrame: false,
      continuityNotes: 'establish the station shape, cold blue-gray palette, and slow suspenseful motion for later clips',
      transitionNotes: 'cut on the docking ring moving across frame',
      sourceText: 'Create a 30-second moody sci-fi establishing sequence of an abandoned space station.',
    },
  ],
  notes: 'Planning-only video prompts. Downstream text-to-video, image-to-video, reference frame extraction, and generation settings remain separate.',
});

const VIDEO_PROMPT_PLAN_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'kind', 'title', 'overallStyle', 'targetUse', 'continuityStrategy', 'estimatedTotalDurationSeconds', 'globalNegativePrompt', 'clips', 'notes'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    kind: { type: 'string', enum: ['videoPromptPlan'] },
    title: { type: 'string', description: 'Short title for the planned video prompt sequence.' },
    overallStyle: { type: 'string', description: 'Overall visual style, pacing, lighting, and motion language.' },
    targetUse: { type: 'string', enum: ['short-film', 'b-roll', 'music-video', 'explainer', 'social-video', 'cinematic-sequence', 'product-video', 'other'] },
    continuityStrategy: { type: 'string', enum: ['independentClips', 'continueFromPreviousClip', 'initialImageThenContinue', 'firstAndLastFrameGuided', 'other'] },
    estimatedTotalDurationSeconds: { type: 'number', minimum: 1 },
    globalNegativePrompt: { type: 'string', description: 'Global avoid list for future video generation; use an empty string if none.' },
    clips: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'name', 'durationSeconds', 'prompt', 'negativePrompt', 'cameraMotion', 'subjectMotion', 'setting', 'action', 'referenceMode', 'referenceFrameRole', 'needsInitialReferenceImage', 'usesPreviousClipLastFrame', 'continuityNotes', 'transitionNotes', 'sourceText'],
        properties: {
          index: { type: 'integer', minimum: 1 },
          name: { type: 'string' },
          durationSeconds: { type: 'number', minimum: 1 },
          prompt: { type: 'string', description: 'Final main text prompt intended for video generation.' },
          negativePrompt: { type: 'string', description: 'Clip-specific avoid list for future video generation; use an empty string if none.' },
          cameraMotion: { type: 'string', description: 'How the camera moves during this clip.' },
          subjectMotion: { type: 'string', description: 'What moves inside the scene.' },
          setting: { type: 'string' },
          action: { type: 'string', description: 'What visibly happens during the clip.' },
          referenceMode: { type: 'string', enum: ['none', 'initialReferenceImage', 'continueFromPreviousClip', 'previousClipLastFrame', 'firstAndLastFrame', 'other'] },
          referenceFrameRole: { type: 'string', enum: ['none', 'firstFrame', 'lastFrame', 'previousClipLastFrame', 'firstAndLastFrame'] },
          needsInitialReferenceImage: { type: 'boolean' },
          usesPreviousClipLastFrame: { type: 'boolean' },
          continuityNotes: { type: 'string' },
          transitionNotes: { type: 'string' },
          sourceText: { type: 'string' },
        },
      },
    },
    notes: { type: 'string', description: 'Planning-only notes. Do not claim video was generated.' },
  },
});

const VIDEO_PROMPT_PLAN_SCHEMA = Object.freeze({
  familyId: VIDEO_PROMPT_SCHEMA_FAMILY_ID,
  familyLabel: 'Video prompt planning',
  id: VIDEO_PROMPT_PLAN_SCHEMA_ID,
  label: 'Video prompt plan',
  maturity: 'usable',
  promptSummary: 'Create an ordered video prompt plan from a script, narration, scene description, or concept. The plan should divide the source into useful clip prompts with duration, camera motion, subject motion, setting, action, negative prompts, continuity strategy, transition notes, and reference-frame intent for future image-to-video or clip chaining. This schema plans text prompts only and must not execute video generation.',
  shapeSummary: 'Title, overall style, target use, continuity strategy, total duration, and ordered clips with prompt text plus duration, camera/subject motion, action, negative prompt, transition, continuity, and reference-frame metadata.',
  systemPrompt: 'You are the Local AI Hub Planner. Reason inside the provided planning schema, keep uncertainty explicit, do not invent source facts, and return JSON only. For video prompt plans, produce ordered text prompts only; include motion, duration, continuity, and reference-frame metadata, but do not claim to generate video, extract frames, or run image-to-video chaining.',
  responseShapeExample: VIDEO_PROMPT_PLAN_RESPONSE_SHAPE_EXAMPLE,
  sourceRequirements: Object.freeze({
    requireTextContext: true,
  }),
});

function normalizeEnum(value, options, fallback) {
  const normalized = normalizeString(value);
  return options.has(normalized) ? normalized : fallback;
}

function normalizeDurationSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.round(numeric * 10) / 10;
}

function normalizeBoolean(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function normalizeVideoClip(value, index) {
  const input = isRecord(value) ? value : {};
  const clipIndex = Math.max(1, Math.floor(Number(input.index || index + 1) || index + 1));
  return {
    index: clipIndex,
    name: normalizeTextBlock(input.name || input.clipName || 'Clip ' + String(clipIndex)),
    durationSeconds: normalizeDurationSeconds(input.durationSeconds || input.duration || input.seconds),
    prompt: normalizeTextBlock(input.prompt || input.videoPrompt || input.text),
    negativePrompt: normalizeTextBlock(input.negativePrompt || input.negative),
    cameraMotion: normalizeTextBlock(input.cameraMotion || input.camera || input.cameraMovement),
    subjectMotion: normalizeTextBlock(input.subjectMotion || input.motion || input.internalMotion),
    setting: normalizeTextBlock(input.setting || input.location),
    action: normalizeTextBlock(input.action || input.visibleAction),
    referenceMode: normalizeEnum(input.referenceMode, REFERENCE_MODE_OPTIONS, 'none'),
    referenceFrameRole: normalizeEnum(input.referenceFrameRole, REFERENCE_FRAME_ROLE_OPTIONS, 'none'),
    needsInitialReferenceImage: normalizeBoolean(input.needsInitialReferenceImage),
    usesPreviousClipLastFrame: normalizeBoolean(input.usesPreviousClipLastFrame),
    continuityNotes: normalizeTextBlock(input.continuityNotes || input.continuity),
    transitionNotes: normalizeTextBlock(input.transitionNotes || input.transition),
    sourceText: normalizeTextBlock(input.sourceText || input.source || input.scriptReference),
  };
}

function validatePlan(value) {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: ['Planner output must be a JSON object.'],
      value: null,
    };
  }

  const clips = (Array.isArray(value.clips) ? value.clips : [])
    .map((clip, index) => normalizeVideoClip(clip, index));
  const durationTotal = clips.reduce((total, clip) => total + (Number(clip.durationSeconds || 0) || 0), 0);
  const normalized = {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    schemaFamilyId: VIDEO_PROMPT_SCHEMA_FAMILY_ID,
    schemaId: VIDEO_PROMPT_PLAN_SCHEMA_ID,
    kind: VIDEO_PROMPT_PLAN_KIND,
    title: normalizeString(value.title, 'Video prompt plan'),
    overallStyle: normalizeTextBlock(value.overallStyle || value.style || value.styleSummary),
    targetUse: normalizeEnum(value.targetUse || value.useCase, TARGET_USE_OPTIONS, 'other'),
    continuityStrategy: normalizeEnum(value.continuityStrategy || value.continuity, CONTINUITY_STRATEGY_OPTIONS, 'independentClips'),
    estimatedTotalDurationSeconds: normalizeDurationSeconds(value.estimatedTotalDurationSeconds || value.totalDurationSeconds) || normalizeDurationSeconds(durationTotal),
    globalNegativePrompt: normalizeTextBlock(value.globalNegativePrompt || value.negativePrompt),
    clips,
    notes: normalizeTextBlock(value.notes),
  };

  const errors = [];
  if (value.kind && normalizeString(value.kind) !== VIDEO_PROMPT_PLAN_KIND) {
    errors.push('Video prompt plan kind must be videoPromptPlan.');
  }
  if (!normalized.title) {
    errors.push('Video prompt plan must include a title.');
  }
  if (!normalized.overallStyle) {
    errors.push('Video prompt plan must include an overall style.');
  }
  if (!normalized.clips.length) {
    errors.push('Video prompt plan must include at least one clip.');
  }
  normalized.clips.forEach((clip, index) => {
    const label = 'Clip ' + String(index + 1);
    if (!clip.name) {
      errors.push(label + ' must include a name.');
    }
    if (!clip.durationSeconds) {
      errors.push(label + ' must include a positive durationSeconds value.');
    }
    if (!clip.prompt) {
      errors.push(label + ' must include a usable video prompt.');
    }
    if (!clip.cameraMotion) {
      errors.push(label + ' must include cameraMotion.');
    }
    if (!clip.subjectMotion) {
      errors.push(label + ' must include subjectMotion.');
    }
    if (!clip.setting) {
      errors.push(label + ' must include a setting.');
    }
    if (!clip.action) {
      errors.push(label + ' must include an action.');
    }
    if (!REFERENCE_MODE_OPTIONS.has(clip.referenceMode)) {
      errors.push(label + ' referenceMode must be one of the supported reference modes.');
    }
    if (!REFERENCE_FRAME_ROLE_OPTIONS.has(clip.referenceFrameRole)) {
      errors.push(label + ' referenceFrameRole must be one of the supported reference frame roles.');
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    value: normalized,
  };
}

function buildPreviewDocument(planValue, options = {}) {
  const validation = validatePlan(planValue);
  if (!validation.ok) {
    throw new Error(validation.errors[0] || 'Local AI Hub could not build a preview from this video prompt plan yet.');
  }

  const plan = validation.value;
  const clips = plan.clips.map((clip, index) => ({
    action: clip.action,
    cameraMotion: clip.cameraMotion,
    continuityNotes: clip.continuityNotes,
    durationSeconds: clip.durationSeconds,
    index: clip.index || index + 1,
    name: clip.name,
    negativePrompt: clip.negativePrompt,
    order: index + 1,
    promptPreview: clip.prompt,
    referenceFrameRole: clip.referenceFrameRole,
    referenceMode: clip.referenceMode,
    setting: clip.setting,
    subjectMotion: clip.subjectMotion,
    summary: trimPreviewText([clip.name, clip.setting, clip.action, clip.prompt].filter(Boolean).join(' | '), 360),
    transitionNotes: clip.transitionNotes,
  }));

  return {
    clipCount: clips.length,
    continuityStrategy: plan.continuityStrategy,
    estimatedTotalDurationSeconds: plan.estimatedTotalDurationSeconds,
    globalNegativePrompt: plan.globalNegativePrompt,
    limitationNote: normalizeTextBlock(options.limitationNote || 'This preview is a planning artifact. It creates ordered video prompt text only; video generation, image-to-video chaining, and frame extraction remain downstream.'),
    notes: plan.notes,
    overallStyle: plan.overallStyle,
    planTitle: normalizeString(plan.title, VIDEO_PROMPT_PLAN_SCHEMA.label),
    previewMode: 'videoPromptClips.v1',
    reviewVersion: PLANNING_REVIEW_VERSION,
    schemaFamilyId: VIDEO_PROMPT_SCHEMA_FAMILY_ID,
    schemaId: VIDEO_PROMPT_PLAN_SCHEMA_ID,
    schemaLabel: VIDEO_PROMPT_PLAN_SCHEMA.label,
    clips,
    sourcePlanSummary: trimPreviewText([plan.overallStyle, clips[0]?.summary].filter(Boolean).join(' | '), 240),
    targetUse: plan.targetUse,
  };
}

function createReviewFinding(severity, category, title, detail, options = {}) {
  return {
    approximate: options.approximate === true,
    category: normalizeString(category, 'review'),
    clipIndex: Number.isInteger(options.clipIndex) ? options.clipIndex : null,
    clipName: normalizeTextBlock(options.clipName),
    detail: normalizeTextBlock(detail),
    heuristic: normalizeString(options.heuristic, 'schema-validation'),
    severity: severity === 'error' ? 'error' : severity === 'info' ? 'info' : 'warn',
    title: normalizeTextBlock(title),
  };
}

function buildReviewDocument(planValue) {
  const validation = validatePlan(planValue);
  const plan = validation.ok ? validation.value : null;
  const findings = [];

  if (!validation.ok) {
    validation.errors.forEach((error) => {
      findings.push(createReviewFinding('error', 'schema-validation', 'Plan does not match the video prompt planning schema', error));
    });
  }

  if (plan) {
    plan.clips.forEach((clip, index) => {
      const label = clip.name || 'Clip ' + String(index + 1);
      const promptWordCount = String(clip.prompt || '').split(/\s+/).map((entry) => entry.trim()).filter(Boolean).length;
      if (promptWordCount < 8) {
        findings.push(createReviewFinding(
          'warn',
          'prompt-specificity',
          label + ' prompt may be too short',
          'This clip prompt is brief, so it may need more concrete visual action, motion, setting, or camera language before downstream video generation.',
          { approximate: true, heuristic: 'prompt-word-count', clipIndex: index + 1, clipName: label },
        ));
      }
      if (clip.durationSeconds > 20) {
        findings.push(createReviewFinding(
          'info',
          'duration-check',
          label + ' is a long generated-video clip',
          'This clip duration may be long for a single generated video. Consider splitting it downstream if the selected video backend works better with shorter clips.',
          { approximate: true, heuristic: 'duration-threshold', clipIndex: index + 1, clipName: label },
        ));
      }
      if (clip.usesPreviousClipLastFrame && index === 0) {
        findings.push(createReviewFinding(
          'warn',
          'reference-frame-intent',
          label + ' cannot continue from a previous clip',
          'The first clip says it uses the previous clip last frame, but there is no previous clip. Use initialReferenceImage if a user-provided starting frame is intended.',
          { approximate: false, heuristic: 'first-clip-reference', clipIndex: index + 1, clipName: label },
        ));
      }
    });
  }

  const summary = {
    errorCount: findings.filter((entry) => entry.severity === 'error').length,
    infoCount: findings.filter((entry) => entry.severity === 'info').length,
    warningCount: findings.filter((entry) => entry.severity === 'warn').length,
  };

  return {
    clipCount: Number(plan?.clips?.length || 0) || 0,
    continuityStrategy: normalizeString(plan?.continuityStrategy),
    estimatedTotalDurationSeconds: Number(plan?.estimatedTotalDurationSeconds || 0) || 0,
    findings,
    heuristicsUsed: ['Planning schema validation', 'Prompt length check', 'Long clip duration check', 'Reference-frame intent check'],
    limitationNote: 'This review checks the video prompt plan shape and a few simple prompt-readiness signals. It does not run video generation, image-to-video chaining, or last-frame extraction.',
    planTitle: normalizeString(plan?.title || planValue?.title, VIDEO_PROMPT_PLAN_SCHEMA.label),
    reviewVersion: PLANNING_REVIEW_VERSION,
    schemaFamilyId: VIDEO_PROMPT_SCHEMA_FAMILY_ID,
    schemaId: VIDEO_PROMPT_PLAN_SCHEMA_ID,
    schemaLabel: VIDEO_PROMPT_PLAN_SCHEMA.label,
    structuralValidation: {
      errors: validation.ok ? [] : [...validation.errors],
      ok: validation.ok,
      summary: validation.ok
        ? 'The plan matches the current video prompt planning schema shape.'
        : 'The plan does not match the current video prompt planning schema shape yet.',
    },
    summary,
    targetUse: normalizeString(plan?.targetUse),
  };
}

function extractSourceIdea(sourcePlan) {
  const packet = sourcePlan?.sourcePacket && typeof sourcePlan.sourcePacket === 'object'
    ? sourcePlan.sourcePacket
    : null;
  if (!packet) {
    return '';
  }
  const sourceArtifactText = Array.isArray(packet.sourceArtifacts)
    ? packet.sourceArtifacts.map((artifact) => artifact?.textExcerpt || artifact?.summary || '').filter(Boolean).join('\n\n')
    : '';
  return trimPreviewText(packet.sourceSummary || sourceArtifactText || packet.goal || '', 1200);
}

function buildVideoPromptMetadata(clip, index, plan, options = {}) {
  const sourcePlan = options.sourcePlan || null;
  return {
    videoPromptPlan: {
      clip: {
        action: clip.action,
        cameraMotion: clip.cameraMotion,
        continuityNotes: clip.continuityNotes,
        durationSeconds: clip.durationSeconds,
        index: clip.index || index + 1,
        name: clip.name,
        referenceFrameRole: clip.referenceFrameRole,
        referenceMode: clip.referenceMode,
        setting: clip.setting,
        subjectMotion: clip.subjectMotion,
        transitionNotes: clip.transitionNotes,
      },
      continuityStrategy: plan.continuityStrategy,
      globalNegativePrompt: plan.globalNegativePrompt,
      lineage: {
        planKind: VIDEO_PROMPT_PLAN_KIND,
        planSchemaId: VIDEO_PROMPT_PLAN_SCHEMA_ID,
        planTitle: plan.title,
        sourceIdea: extractSourceIdea(sourcePlan),
        sourcePlanId: normalizeString(sourcePlan?.id || sourcePlan?.artifactId),
      },
      needsInitialReferenceImage: clip.needsInitialReferenceImage,
      negativePrompt: clip.negativePrompt,
      referenceFrameRole: clip.referenceFrameRole,
      referenceMode: clip.referenceMode,
      sourceText: clip.sourceText,
      targetUse: plan.targetUse,
      usesPreviousClipLastFrame: clip.usesPreviousClipLastFrame,
    },
  };
}

function buildTextCollectionItems(planValue, options = {}) {
  const validation = validatePlan(planValue);
  if (!validation.ok) {
    throw new Error(validation.errors[0] || 'This plan does not match the video prompt planning schema.');
  }

  const plan = validation.value;
  return plan.clips.map((clip, index) => ({
    displayName: clip.name || 'Video clip ' + String(index + 1),
    itemId: 'video-clip-' + String(index + 1).padStart(3, '0'),
    metadata: buildVideoPromptMetadata(clip, index, plan, options),
    text: clip.prompt,
  }));
}

const VIDEO_PROMPT_PLAN_ADAPTER = Object.freeze({
  definition: VIDEO_PROMPT_PLAN_SCHEMA,
  responseJsonSchema: VIDEO_PROMPT_PLAN_RESPONSE_JSON_SCHEMA,
  buildPreviewDocument,
  buildReviewDocument,
  buildTextCollectionItems,
  validatePlan,
});

module.exports = {
  VIDEO_PROMPT_PLAN_ADAPTER,
  VIDEO_PROMPT_PLAN_KIND,
  VIDEO_PROMPT_PLAN_SCHEMA_ID,
  VIDEO_PROMPT_SCHEMA_FAMILY_ID,
};

module.exports.default = module.exports;
