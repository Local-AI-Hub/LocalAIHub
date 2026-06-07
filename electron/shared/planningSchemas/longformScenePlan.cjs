const {
  cloneValue,
  isRecord,
  normalizeString,
  normalizeStringList,
  normalizeTextBlock,
  trimPreviewText,
} = require('./planningSchemaUtils.cjs');

const PLANNING_SCHEMA_VERSION = 1;
const PLANNING_REVIEW_VERSION = 1;
const LONGFORM_MEDIA_SCHEMA_FAMILY_ID = 'longformMedia';
const LONGFORM_SCENE_PLAN_SCHEMA_ID = 'longformMedia.scenePlan.v1';

const COMMON_STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'with', 'while', 'over', 'under', 'through', 'across', 'after', 'before', 'during', 'then', 'than', 'still', 'very', 'more', 'most', 'some', 'any', 'each', 'every', 'keep', 'make', 'show', 'scene', 'scenes', 'shot', 'shots', 'image', 'images', 'visual', 'visuals', 'cinematic', 'grounded', 'continuity', 'realism', 'realistic', 'high', 'detail', 'details', 'plain', 'english',
]);
const GENERIC_PROMPT_WORDS = new Set([
  'beautiful', 'cinematic', 'cool', 'dramatic', 'good', 'great', 'nice', 'scene', 'shot', 'visual', 'image', 'detailed', 'high', 'quality', 'realistic', 'grounded', 'moody', 'epic', 'professional', 'lighting', 'composition',
]);
const CONSTRAINT_CONFLICT_RULES = Object.freeze([
  {
    trigger: /\bgrounded\b|\brealistic\b|\brealism\b/,
    conflictingTerms: ['surreal', 'fantastical', 'dreamlike', 'mythic', 'impossible'],
    label: 'grounded realism',
  },
  {
    trigger: /\bpractical\b/,
    conflictingTerms: ['abstract', 'floating', 'gravity-defying', 'impossible'],
    label: 'practical detail',
  },
  {
    trigger: /\bchronological\b|\blinear\b/,
    conflictingTerms: ['flashback', 'flash-forward', 'nonlinear', 'time jump'],
    label: 'chronological flow',
  },
]);

const SCENE_PLAN_RESPONSE_SHAPE_EXAMPLE = Object.freeze({
  title: 'Episode scene plan',
  timing: {
    timingMode: 'transcriptSegments',
    totalDurationSeconds: 40,
    fallbackSecondsPerImage: 8,
    minimumImageCount: 5,
    source: 'Whisper transcript segments',
    coverageNotes: 'Scenes cover the full timestamped narration without gaps or overlaps.',
  },
  overview: {
    meaningIntent: 'What the story section is really trying to communicate.',
    viewerTakeaway: 'What the viewer should remember after the sequence.',
    narrativeArc: 'How the sequence should progress from start to finish.',
    toneStrategy: 'How the visual and emotional tone should feel.',
    continuityNotes: ['How scenes should stay coherent across the sequence.'],
    riskNotes: ['Any source ambiguity or adaptation risk to keep visible.'],
  },
  scenes: [
    {
      sceneId: 'scene-1',
      sourceSpanLabel: 'Opening beat',
      meaningIntent: 'Why this beat matters.',
      viewerTakeaway: 'What the viewer should pick up from this beat.',
      sceneConcept: 'What happens visually in the scene.',
      treatmentApproach: 'How Local AI Hub should approach the scene.',
      narrationDraft: 'Optional narration or dialogue handling note.',
      narrationExcerpt: 'The source narration text covered by this scene.',
      sourceTranscriptSegmentIds: ['0', '1'],
      startSeconds: 0,
      endSeconds: 5.8,
      durationSeconds: 5.8,
      imagePrompt: 'Clean image-generation prompt only: concrete subject, setting, visual style, lighting, and composition.',
      visualPromptDraft: 'Optional planning draft or alternate prompt note for later image or video work.',
      riskNotes: ['Ambiguities or continuity risks for this scene.'],
    },
  ],
  openQuestions: ['Any missing detail the source still leaves unclear.'],
});

const SCENE_PLAN_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['title', 'timing', 'overview', 'scenes', 'openQuestions'],
  properties: {
    title: { type: 'string', description: 'Short title for the scene plan.' },
    timing: {
      type: 'object',
      additionalProperties: false,
      required: ['timingMode', 'totalDurationSeconds', 'source', 'coverageNotes'],
      properties: {
        timingMode: { type: 'string', description: 'Use transcriptSegments when timestamped narration exists, estimated when only text length is available, or untimed when no useful timing source exists.' },
        totalDurationSeconds: { type: ['number', 'null'], description: 'Total planned narration or visual duration in seconds when known.' },
        fallbackSecondsPerImage: { type: ['number', 'null'], description: 'Fallback seconds per image used to calculate the deterministic minimum image count when narration duration is known.' },
        minimumImageCount: { type: ['integer', 'null'], description: 'Deterministic lower bound for planned images: ceil(totalDurationSeconds / fallbackSecondsPerImage).' },
        source: { type: 'string', description: 'Timing source, such as Whisper transcript segments, audio duration, or estimated reading time.' },
        coverageNotes: { type: 'string', description: 'Explain whether the scenes cover the full narration duration and mention any intentional gap.' },
      },
    },
    overview: {
      type: 'object',
      additionalProperties: false,
      required: ['meaningIntent', 'viewerTakeaway', 'narrativeArc', 'toneStrategy', 'continuityNotes', 'riskNotes'],
      properties: {
        meaningIntent: { type: 'string' },
        viewerTakeaway: { type: 'string' },
        narrativeArc: { type: 'string' },
        toneStrategy: { type: 'string' },
        continuityNotes: { type: 'array', items: { type: 'string' } },
        riskNotes: { type: 'array', items: { type: 'string' } },
      },
    },
    scenes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId', 'sourceSpanLabel', 'meaningIntent', 'viewerTakeaway', 'sceneConcept', 'treatmentApproach', 'narrationDraft', 'narrationExcerpt', 'sourceTranscriptSegmentIds', 'startSeconds', 'endSeconds', 'durationSeconds', 'imagePrompt', 'riskNotes'],
        properties: {
          sceneId: { type: 'string' },
          sourceSpanLabel: { type: 'string' },
          meaningIntent: { type: 'string' },
          viewerTakeaway: { type: 'string' },
          sceneConcept: { type: 'string' },
          treatmentApproach: { type: 'string' },
          narrationDraft: { type: 'string' },
          narrationExcerpt: { type: 'string', description: 'Source narration or transcript excerpt covered by this visual scene.' },
          sourceTranscriptSegmentIds: { type: 'array', items: { type: 'string' }, description: 'Transcript segment indexes or ids used for this scene timing.' },
          startSeconds: { type: ['number', 'null'], description: 'Scene start time in seconds from narration start when known.' },
          endSeconds: { type: ['number', 'null'], description: 'Scene end time in seconds from narration start when known.' },
          durationSeconds: { type: ['number', 'null'], description: 'Scene duration in seconds. Prefer endSeconds - startSeconds when timestamps exist.' },
          imagePrompt: { type: 'string', description: 'Clean prompt intended for text-to-image generation only. Do not include meaning/intent labels, narrative analysis, timing, transcript ids, risk notes, or other scene-plan metadata.' },
          visualPromptDraft: { type: 'string', description: 'Optional planning draft or alternate prompt note. Downstream image generation uses imagePrompt, not this field.' },
          riskNotes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
});


const LONGFORM_SCENE_PLAN_SCHEMA = Object.freeze({
  familyId: LONGFORM_MEDIA_SCHEMA_FAMILY_ID,
  familyLabel: 'Longform media',
  id: LONGFORM_SCENE_PLAN_SCHEMA_ID,
  label: 'Scene plan',
  maturity: 'usable',
  promptSummary: 'Create a timing-aware longform-media scene plan. When transcript or narration timestamps exist, segment the narration by timestamped semantic beats, create enough visual scenes to cover the full duration, and put startSeconds, endSeconds, durationSeconds, narrationExcerpt, sourceTranscriptSegmentIds, and imagePrompt on every scene. imagePrompt must be clean text-to-image prompt text only; keep meaning, takeaway, timing, transcript ids, and risk notes in metadata fields.',
  shapeSummary: 'Timing summary plus ordered scenes with intent, takeaway, concept, treatment, narration excerpt, source segment ids, start/end/duration seconds, risk notes, and clean image prompts.',
  systemPrompt: 'You are the Local AI Hub Planner. Reason inside the provided planning schema, keep uncertainty explicit, do not invent source facts, and return JSON only. For timestamped narration, use transcript segment timing to cover the entire narration with ordered visual scenes: no zero-duration scenes, no overlaps, no accidental gaps, and the final scene should reach the narration end or target duration. Use semantic boundaries where possible instead of blindly dividing by a fixed image duration; if exact timestamps are unavailable, estimate reasonable durations and say so in timing.coverageNotes. Each scene must include imagePrompt as the clean image-generation prompt only, with no labels, narrative analysis, timing, transcript ids, risk notes, or explanatory scene-plan metadata.',
  responseShapeExample: SCENE_PLAN_RESPONSE_SHAPE_EXAMPLE,
  sourceRequirements: Object.freeze({
    requireTextContext: true,
  }),
});

function normalizeKeywordList(value) {
  return [...new Set(
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, ' ')
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 2 && !COMMON_STOPWORDS.has(entry)),
  )];
}

function countPromptSpecificityTerms(value) {
  return normalizeKeywordList(value).filter((entry) => !GENERIC_PROMPT_WORDS.has(entry)).length;
}

function buildScenePreviewSummary(scene) {
  return trimPreviewText([scene.sceneConcept, scene.treatmentApproach, scene.viewerTakeaway].filter(Boolean).join(' | '), 360);
}

function deriveCleanImagePrompt(input = {}) {
  const source = isRecord(input) ? input : {};
  const explicitPrompt = normalizeTextBlock(source.imagePrompt || source.cleanImagePrompt || source.visualPromptDraft || source.promptDraft || source.prompt);
  if (explicitPrompt) {
    return explicitPrompt;
  }

  const visualParts = [
    source.visualDescription,
    source.sceneConcept || source.concept,
    source.setting,
    source.subject,
    source.action,
    source.treatmentApproach || source.treatment,
    source.visualStyle,
    source.lighting,
    source.composition,
  ].map((entry) => normalizeTextBlock(entry)).filter(Boolean);
  if (visualParts.length) {
    return trimPreviewText(visualParts.join(', ') + '. Clear subject, readable setting, practical lighting, consistent continuity.', 700);
  }

  const narration = normalizeTextBlock(source.narrationExcerpt || source.sourceText || source.sourceExcerpt || source.narration);
  if (narration) {
    return trimPreviewText('Grounded documentary-style slideshow image for this narration beat: ' + narration + '. Clear subject, readable setting, practical lighting, consistent continuity.', 700);
  }

  return 'Grounded documentary-style slideshow image, clear subject, readable setting, practical lighting, consistent continuity.';
}

function extractConstraintSignals(constraints = []) {
  return (Array.isArray(constraints) ? constraints : []).flatMap((entry) => {
    const text = normalizeTextBlock(entry);
    if (!text) {
      return [];
    }

    const normalized = text.toLowerCase();
    const signals = [];
    const negativeMatch = normalized.match(/\b(?:avoid|do not|don't|never|without|no)\s+(.+)/i);
    if (negativeMatch) {
      const phrase = normalizeTextBlock(negativeMatch[1]).replace(/[.;:,]+$/g, '');
      const keywords = normalizeKeywordList(phrase).slice(0, 6);
      if (phrase || keywords.length) {
        signals.push({
          constraint: text,
          keywords,
          phrase,
          type: 'negative',
        });
      }
    }

    CONSTRAINT_CONFLICT_RULES.forEach((rule) => {
      if (rule.trigger.test(normalized)) {
        signals.push({
          constraint: text,
          conflictingTerms: [...rule.conflictingTerms],
          label: rule.label,
          type: 'conflict-rule',
        });
      }
    });

    return signals;
  });
}

function createReviewFinding(severity, category, title, detail, options = {}) {
  return {
    approximate: options.approximate === true,
    category: normalizeString(category, 'review'),
    detail: normalizeTextBlock(detail),
    heuristic: normalizeString(options.heuristic, 'bounded-heuristic'),
    sceneId: normalizeString(options.sceneId),
    sceneLabel: normalizeTextBlock(options.sceneLabel),
    severity: severity === 'error' ? 'error' : severity === 'info' ? 'info' : 'warn',
    title: normalizeTextBlock(title),
  };
}

function normalizeTimingSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return Math.round(numeric * 1000) / 1000;
}

function normalizeScenePlanTiming(value) {
  const input = isRecord(value) ? value : {};
  return {
    timingMode: normalizeString(input.timingMode || input.mode),
    totalDurationSeconds: normalizeTimingSeconds(input.totalDurationSeconds || input.durationSeconds),
    fallbackSecondsPerImage: normalizeFallbackSecondsPerImage(input.fallbackSecondsPerImage || input.fallbackSeconds || input.secondsPerImage),
    minimumImageCount: normalizePositiveInteger(input.minimumImageCount),
    source: normalizeTextBlock(input.source || input.timingSource),
    coverageNotes: normalizeTextBlock(input.coverageNotes || input.notes),
  };
}

function normalizeScenePlanOverview(value) {
  const input = isRecord(value) ? value : {};
  return {
    meaningIntent: normalizeTextBlock(input.meaningIntent || input.intent),
    viewerTakeaway: normalizeTextBlock(input.viewerTakeaway || input.takeaway),
    narrativeArc: normalizeTextBlock(input.narrativeArc || input.arc),
    toneStrategy: normalizeTextBlock(input.toneStrategy || input.tone),
    continuityNotes: normalizeStringList(input.continuityNotes),
    riskNotes: normalizeStringList(input.riskNotes),
  };
}

function normalizeFallbackSecondsPerImage(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return normalizeTimingSeconds(numeric);
}

function normalizePositiveInteger(value) {
  const numeric = Math.ceil(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getLongformMinimumImageCount(totalDurationSeconds, fallbackSecondsPerImage) {
  const total = normalizeTimingSeconds(totalDurationSeconds);
  const fallback = normalizeFallbackSecondsPerImage(fallbackSecondsPerImage) || 8;
  if (!total || total <= 0 || !fallback || fallback <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(total / fallback));
}
function normalizeScenePlanScene(value, index) {
  const input = isRecord(value) ? value : {};
  const imagePrompt = deriveCleanImagePrompt(input);
  return {
    sceneId: normalizeString(input.sceneId, 'scene-' + String(index + 1)),
    sourceSpanLabel: normalizeTextBlock(input.sourceSpanLabel || input.sourceSpan || input.beat || 'Scene ' + String(index + 1)),
    meaningIntent: normalizeTextBlock(input.meaningIntent || input.intent),
    viewerTakeaway: normalizeTextBlock(input.viewerTakeaway || input.takeaway),
    sceneConcept: normalizeTextBlock(input.sceneConcept || input.concept),
    treatmentApproach: normalizeTextBlock(input.treatmentApproach || input.treatment),
    narrationDraft: normalizeTextBlock(input.narrationDraft || input.narration),
    narrationExcerpt: normalizeTextBlock(input.narrationExcerpt || input.sourceText || input.sourceExcerpt || input.narration),
    sourceTranscriptSegmentIds: normalizeStringList(input.sourceTranscriptSegmentIds || input.transcriptSegmentIds || input.sourceSegmentIds),
    startSeconds: normalizeTimingSeconds(input.startSeconds ?? input.start),
    endSeconds: normalizeTimingSeconds(input.endSeconds ?? input.end),
    durationSeconds: normalizeTimingSeconds(input.durationSeconds ?? input.duration),
    imagePrompt,
    visualPromptDraft: normalizeTextBlock(input.visualPromptDraft || input.promptDraft || input.prompt || imagePrompt),
    riskNotes: normalizeStringList(input.riskNotes),
  };
}

function validatePlan(value, options = {}) {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: ['Planner output must be a JSON object.'],
      value: null,
    };
  }

  const normalized = {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    schemaFamilyId: LONGFORM_MEDIA_SCHEMA_FAMILY_ID,
    schemaId: LONGFORM_SCENE_PLAN_SCHEMA_ID,
    title: normalizeString(value.title, 'Scene plan'),
    timing: normalizeScenePlanTiming(value.timing),
    overview: normalizeScenePlanOverview(value.overview),
    scenes: (Array.isArray(value.scenes) ? value.scenes : []).map((scene, index) => normalizeScenePlanScene(scene, index)).filter(Boolean),
    openQuestions: normalizeStringList(value.openQuestions),
  };
  repairScenePlanMinimumCoverage(normalized, options);

  const errors = [];
  if (!normalized.overview.meaningIntent) {
    errors.push('Planner output must include an overview meaning or intent.');
  }
  if (!normalized.overview.viewerTakeaway) {
    errors.push('Planner output must include an overview viewer takeaway.');
  }
  if (!normalized.scenes.length) {
    errors.push('Planner output must include at least one scene.');
  }

  normalized.scenes.forEach((scene, index) => {
    const label = 'Scene ' + String(index + 1);
    if (!scene.meaningIntent) {
      errors.push(label + ' must include meaning or intent.');
    }
    if (!scene.viewerTakeaway) {
      errors.push(label + ' must include a viewer takeaway.');
    }
    if (!scene.sceneConcept) {
      errors.push(label + ' must include a scene concept.');
    }
    if (!scene.treatmentApproach) {
      errors.push(label + ' must include a treatment or approach.');
    }
    if (!scene.imagePrompt) {
      errors.push(label + ' must include a clean image prompt.');
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
    throw new Error(validation.errors[0] || 'Local AI Hub could not build a preview from this plan yet.');
  }

  const plan = validation.value;
  const scenes = plan.scenes.map((scene, index) => ({
    meaningIntent: scene.meaningIntent,
    narrationDraft: scene.narrationDraft,
    order: index + 1,
    promptPreview: scene.imagePrompt,
    promptReadiness: !scene.imagePrompt
      ? 'missing-prompt'
      : countPromptSpecificityTerms(scene.imagePrompt) >= 8
        ? 'usable-draft'
        : 'needs-more-specificity',
    promptWordCount: countPromptSpecificityTerms(scene.imagePrompt),
    riskNotes: normalizeStringList(scene.riskNotes),
    sceneConcept: scene.sceneConcept,
    sceneId: scene.sceneId,
    sourceSpanLabel: scene.sourceSpanLabel,
    summary: buildScenePreviewSummary(scene),
    treatmentApproach: scene.treatmentApproach,
    viewerTakeaway: scene.viewerTakeaway,
  }));

  return {
    limitationNote: normalizeTextBlock(options.limitationNote || 'This preview is a planning review artifact. It shows what the plan is about to become before later media generation exists.'),
    openQuestions: normalizeStringList(plan.openQuestions),
    overview: cloneValue(plan.overview) || {},
    planTitle: normalizeString(plan.title, LONGFORM_SCENE_PLAN_SCHEMA.label),
    previewMode: 'scenePromptCards.v1',
    reviewVersion: PLANNING_REVIEW_VERSION,
    sceneCount: scenes.length,
    scenes,
    schemaFamilyId: LONGFORM_MEDIA_SCHEMA_FAMILY_ID,
    schemaId: LONGFORM_SCENE_PLAN_SCHEMA_ID,
    schemaLabel: LONGFORM_SCENE_PLAN_SCHEMA.label,
    sourcePlanSummary: trimPreviewText([plan.overview?.viewerTakeaway, plan.scenes?.[0]?.sceneConcept].filter(Boolean).join(' | '), 240),
  };
}

function buildReviewDocument(planValue, options = {}) {
  const validation = validatePlan(planValue);
  const plan = validation.ok ? validation.value : null;
  const previewDocument = isRecord(options.preview) ? options.preview : null;
  const constraints = normalizeStringList(options.sourcePacket?.constraints);
  const findings = [];

  if (!validation.ok) {
    validation.errors.forEach((error) => {
      findings.push(createReviewFinding(
        'error',
        'schema-validation',
        'Plan does not match the selected planning schema',
        error,
        { approximate: false, heuristic: 'schema-validation' },
      ));
    });
  }

  if (plan) {
    const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
    const seenConcepts = [];
    const constraintSignals = extractConstraintSignals(constraints);
    scenes.forEach((scene, index) => {
      const sceneLabel = scene.sourceSpanLabel || scene.sceneId || 'Scene ' + String(index + 1);
      const promptSpecificityCount = countPromptSpecificityTerms(scene.imagePrompt);
      if (promptSpecificityCount < 7) {
        findings.push(createReviewFinding(
          'warn',
          'prompt-specificity',
          sceneLabel + ' prompt preview is still broad',
          'This prompt draft uses only ' + promptSpecificityCount + ' specific terms after simple filtering, so it may need more concrete visual anchors before later generation.',
          { approximate: true, heuristic: 'prompt-specificity', sceneId: scene.sceneId, sceneLabel },
        ));
      }

      const conceptKeywords = normalizeKeywordList(scene.sceneConcept).slice(0, 8);
      const duplicate = seenConcepts.find((entry) => entry.keywords.filter((token) => conceptKeywords.includes(token)).length >= Math.min(4, Math.max(2, conceptKeywords.length)));
      if (duplicate && conceptKeywords.length >= 3) {
        findings.push(createReviewFinding(
          'warn',
          'repeated-scene-concept',
          sceneLabel + ' may repeat an earlier scene concept',
          'This scene shares several concept keywords with ' + duplicate.label + '. Review whether the two beats are distinct enough before later generation.',
          { approximate: true, heuristic: 'concept-overlap', sceneId: scene.sceneId, sceneLabel },
        ));
      }
      seenConcepts.push({
        keywords: conceptKeywords,
        label: sceneLabel,
      });

      const sceneReviewText = [scene.sceneConcept, scene.treatmentApproach, scene.visualPromptDraft, scene.narrationDraft].filter(Boolean).join(' ').toLowerCase();
      constraintSignals.forEach((signal) => {
        if (signal.type === 'negative') {
          const exactPhrase = signal.phrase ? sceneReviewText.includes(signal.phrase.toLowerCase()) : false;
          const keywordHits = (signal.keywords || []).filter((keyword) => sceneReviewText.includes(keyword));
          if (exactPhrase || keywordHits.length >= Math.min(2, Math.max(1, signal.keywords.length))) {
            findings.push(createReviewFinding(
              'warn',
              'constraint-conflict',
              sceneLabel + ' may conflict with a stated constraint',
              exactPhrase
                ? 'This scene reuses wording that clashes with the constraint: ' + signal.constraint
                : 'This scene includes terms (' + keywordHits.join(', ') + ') that may conflict with the constraint: ' + signal.constraint,
              { approximate: !exactPhrase, heuristic: 'constraint-overlap', sceneId: scene.sceneId, sceneLabel },
            ));
          }
        }

        if (signal.type === 'conflict-rule') {
          const conflictHits = (signal.conflictingTerms || []).filter((term) => sceneReviewText.includes(term));
          if (conflictHits.length) {
            findings.push(createReviewFinding(
              'warn',
              'constraint-conflict',
              sceneLabel + ' may push against the ' + signal.label + ' constraint',
              'This scene includes ' + conflictHits.join(', ') + ', which can conflict with the stated constraint: ' + signal.constraint,
              { approximate: true, heuristic: 'bounded-conflict-rule', sceneId: scene.sceneId, sceneLabel },
            ));
          }
        }
      });
    });

    if (previewDocument) {
      const previewScenes = Array.isArray(previewDocument.scenes) ? previewDocument.scenes : [];
      const missingPreviewSceneIds = scenes
        .filter((scene) => !previewScenes.some((previewScene) => String(previewScene?.sceneId || '').trim() === String(scene.sceneId || '').trim()))
        .map((scene) => scene.sourceSpanLabel || scene.sceneId)
        .filter(Boolean);
      if (previewScenes.length !== scenes.length || missingPreviewSceneIds.length) {
        findings.push(createReviewFinding(
          'info',
          'preview-coverage',
          'Connected preview does not line up perfectly with the current plan',
          missingPreviewSceneIds.length
            ? 'The preview is missing scene coverage for: ' + missingPreviewSceneIds.join(' | ')
            : 'The preview scene count does not match the plan scene count yet.',
          { approximate: false, heuristic: 'preview-coverage' },
        ));
      }
    }
  }

  const summary = {
    errorCount: findings.filter((entry) => entry.severity === 'error').length,
    infoCount: findings.filter((entry) => entry.severity === 'info').length,
    warningCount: findings.filter((entry) => entry.severity === 'warn').length,
  };

  return {
    findings,
    heuristicsUsed: [
      'Planning schema validation',
      'Repeated scene concept overlap',
      'Prompt specificity count',
      constraints.length ? 'Constraint wording overlap' : '',
      previewDocument ? 'Preview coverage alignment' : '',
    ].filter(Boolean),
    limitationNote: 'This review combines plan-shape validation with a small set of bounded heuristics. It is useful for review, but it is not exhaustive or a semantic guarantee.',
    planTitle: normalizeString(plan?.title || planValue?.title, LONGFORM_SCENE_PLAN_SCHEMA.label),
    previewCoverage: {
      connected: Boolean(previewDocument),
      matchesPlan: !previewDocument || !findings.some((entry) => entry.category === 'preview-coverage'),
      sceneCount: Number(previewDocument?.sceneCount || previewDocument?.scenes?.length || 0) || 0,
    },
    reviewVersion: PLANNING_REVIEW_VERSION,
    sceneCount: Number(plan?.scenes?.length || 0) || 0,
    schemaFamilyId: LONGFORM_MEDIA_SCHEMA_FAMILY_ID,
    schemaId: LONGFORM_SCENE_PLAN_SCHEMA_ID,
    schemaLabel: LONGFORM_SCENE_PLAN_SCHEMA.label,
    sourceConstraintCount: constraints.length,
    structuralValidation: {
      errors: validation.ok ? [] : [...validation.errors],
      ok: validation.ok,
      summary: validation.ok
        ? 'The plan matches the current planning schema shape.'
        : 'The plan does not match the current planning schema shape yet.',
    },
    summary,
  };
}

function resolveSceneTiming(scene) {
  const startSeconds = normalizeTimingSeconds(scene.startSeconds);
  const endSeconds = normalizeTimingSeconds(scene.endSeconds);
  const derivedDuration = startSeconds !== null && endSeconds !== null && endSeconds > startSeconds
    ? normalizeTimingSeconds(endSeconds - startSeconds)
    : null;
  const durationSeconds = normalizeTimingSeconds(scene.durationSeconds) || derivedDuration;
  return {
    startSeconds,
    endSeconds,
    durationSeconds,
  };
}

function getTimingOverlapSeconds(leftStart, leftEnd, rightStart, rightEnd) {
  const start = Math.max(Number(leftStart || 0) || 0, Number(rightStart || 0) || 0);
  const end = Math.min(Number(leftEnd || 0) || 0, Number(rightEnd || 0) || 0);
  return Math.max(0, end - start);
}

function findSourceSceneForGroup(group, scenes = [], fallbackIndex = 0) {
  const groupStart = normalizeTimingSeconds(group?.startSeconds) ?? 0;
  const groupEnd = normalizeTimingSeconds(group?.endSeconds) ?? groupStart;
  let bestScene = null;
  let bestOverlap = 0;
  (Array.isArray(scenes) ? scenes : []).forEach((scene) => {
    const sceneStart = normalizeTimingSeconds(scene?.startSeconds) ?? 0;
    const sceneEnd = normalizeTimingSeconds(scene?.endSeconds) ?? sceneStart;
    const overlap = getTimingOverlapSeconds(groupStart, groupEnd, sceneStart, sceneEnd);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestScene = scene;
    }
  });

  return bestScene || scenes[fallbackIndex] || null;
}

function splitWordsForGroup(text, count) {
  const words = normalizeTextBlock(text).split(/\s+/).filter(Boolean);
  if (!words.length || count <= 1) {
    return [normalizeTextBlock(text)].filter(Boolean);
  }

  const wordsPerPart = Math.max(1, Math.ceil(words.length / count));
  const parts = [];
  for (let index = 0; index < words.length; index += wordsPerPart) {
    parts.push(words.slice(index, index + wordsPerPart).join(' '));
  }
  return parts.slice(0, count);
}

function splitTimedGroup(group) {
  const segments = Array.isArray(group?.segments) ? group.segments.filter(Boolean) : [];
  const startSeconds = normalizeTimingSeconds(group?.startSeconds) ?? 0;
  const endSeconds = normalizeTimingSeconds(group?.endSeconds) ?? normalizeTimingSeconds(startSeconds + 1) ?? startSeconds + 1;
  if (segments.length > 1) {
    const midpoint = Math.ceil(segments.length / 2);
    return [
      {
        segments: segments.slice(0, midpoint),
        startSeconds,
        endSeconds: normalizeTimingSeconds(segments[midpoint - 1]?.endSeconds) ?? normalizeTimingSeconds((startSeconds + endSeconds) / 2) ?? endSeconds,
      },
      {
        segments: segments.slice(midpoint),
        startSeconds: normalizeTimingSeconds(segments[midpoint]?.startSeconds) ?? normalizeTimingSeconds(segments[midpoint - 1]?.endSeconds) ?? normalizeTimingSeconds((startSeconds + endSeconds) / 2) ?? startSeconds,
        endSeconds,
      },
    ].map((entry) => ({
      ...entry,
      durationSeconds: normalizeTimingSeconds(Math.max(0.1, Number(entry.endSeconds || 0) - Number(entry.startSeconds || 0))) || 0.1,
    }));
  }

  const segment = segments[0] || { id: '', text: summarizeSceneExcerpt(group) };
  const midpointSeconds = normalizeTimingSeconds((startSeconds + endSeconds) / 2) ?? startSeconds;
  const textParts = splitWordsForGroup(segment.text, 2);
  return [
    {
      segments: [{ ...segment, text: textParts[0] || segment.text }],
      startSeconds,
      endSeconds: midpointSeconds,
    },
    {
      segments: [{ ...segment, text: textParts[1] || textParts[0] || segment.text }],
      startSeconds: midpointSeconds,
      endSeconds,
    },
  ].map((entry) => ({
    ...entry,
    durationSeconds: normalizeTimingSeconds(Math.max(0.1, Number(entry.endSeconds || 0) - Number(entry.startSeconds || 0))) || 0.1,
  }));
}

function expandTimedGroupsToMinimum(groups = [], minimumImageCount = 1) {
  const expanded = (Array.isArray(groups) ? groups : []).map((group) => ({ ...group }));
  while (expanded.length > 0 && expanded.length < minimumImageCount) {
    let splitIndex = 0;
    let longestDuration = -1;
    expanded.forEach((group, index) => {
      const duration = Number(group?.durationSeconds || 0) || Math.max(0, Number(group?.endSeconds || 0) - Number(group?.startSeconds || 0));
      if (duration > longestDuration) {
        longestDuration = duration;
        splitIndex = index;
      }
    });
    const parts = splitTimedGroup(expanded[splitIndex]);
    expanded.splice(splitIndex, 1, ...parts);
  }

  return expanded.slice(0, minimumImageCount).map((group, index, entries) => {
    const startSeconds = index === 0 ? 0 : normalizeTimingSeconds(group.startSeconds) ?? normalizeTimingSeconds(entries[index - 1]?.endSeconds) ?? 0;
    const endSeconds = normalizeTimingSeconds(group.endSeconds) ?? normalizeTimingSeconds(startSeconds + (group.durationSeconds || 1)) ?? startSeconds + 1;
    return {
      ...group,
      startSeconds,
      endSeconds,
      durationSeconds: normalizeTimingSeconds(Math.max(0.1, endSeconds - startSeconds)) || 0.1,
    };
  });
}

function buildRepairedSceneFromTranscriptGroup(group, index, sourceScene = null) {
  const fallbackScene = buildFallbackScene(group, index);
  const riskNotes = [
    ...normalizeStringList(sourceScene?.riskNotes),
    'Scene was rebuilt from the timed transcript segment range to meet the minimum image count without shifting narration topics.',
  ];
  return {
    ...fallbackScene,
    meaningIntent: normalizeTextBlock(sourceScene?.meaningIntent) || fallbackScene.meaningIntent,
    treatmentApproach: normalizeTextBlock(sourceScene?.treatmentApproach) || fallbackScene.treatmentApproach,
    viewerTakeaway: normalizeTextBlock(sourceScene?.viewerTakeaway) || fallbackScene.viewerTakeaway,
    visualPromptDraft: fallbackScene.imagePrompt,
    riskNotes,
  };
}

function splitSceneForMinimumCoverage(scene, splitCount, sceneIndex) {
  const count = Math.max(1, Math.ceil(Number(splitCount || 1) || 1));
  if (count <= 1) {
    return [scene];
  }
  const startSeconds = normalizeTimingSeconds(scene.startSeconds) ?? 0;
  const endSeconds = normalizeTimingSeconds(scene.endSeconds) ?? normalizeTimingSeconds(startSeconds + (scene.durationSeconds || count)) ?? (startSeconds + count);
  const totalDuration = Math.max(0.1, endSeconds - startSeconds);
  const excerpt = normalizeTextBlock(scene.narrationExcerpt || scene.narrationDraft || scene.sceneConcept);
  const excerptParts = splitWordsForGroup(excerpt, count);
  return Array.from({ length: count }, (_entry, index) => {
    const partStart = normalizeTimingSeconds(startSeconds + ((totalDuration / count) * index)) ?? startSeconds;
    const partEnd = index === count - 1
      ? endSeconds
      : normalizeTimingSeconds(startSeconds + ((totalDuration / count) * (index + 1))) ?? endSeconds;
    const label = (scene.sourceSpanLabel || scene.sceneId || 'Scene ' + String(sceneIndex + 1)) + ' part ' + String(index + 1);
    const narrationExcerpt = excerptParts[index] || excerpt;
    const imagePrompt = deriveCleanImagePrompt({
      ...scene,
      imagePrompt: '',
      narrationExcerpt,
      visualPromptDraft: '',
    });
    return {
      ...scene,
      sceneId: String(scene.sceneId || 'scene-' + String(sceneIndex + 1)) + '-' + String(index + 1),
      sourceSpanLabel: label,
      narrationExcerpt,
      startSeconds: partStart,
      endSeconds: partEnd,
      durationSeconds: normalizeTimingSeconds(Math.max(0.1, partEnd - partStart)) || 0.1,
      imagePrompt,
      visualPromptDraft: imagePrompt,
      riskNotes: [...normalizeStringList(scene.riskNotes), 'Scene was split deterministically to meet the minimum image count for the narration duration.'],
    };
  });
}

function repairScenePlanMinimumCoverage(plan, options = {}) {
  const timing = plan?.timing && typeof plan.timing === 'object' ? plan.timing : {};
  const sceneEndSeconds = Math.max(0, ...(Array.isArray(plan.scenes) ? plan.scenes : []).map((scene) => Number(scene.endSeconds || 0) || 0));
  const totalDurationSeconds = normalizeTimingSeconds(timing.totalDurationSeconds) || normalizeTimingSeconds(sceneEndSeconds);
  const fallbackSecondsPerImage = normalizeFallbackSecondsPerImage(timing.fallbackSecondsPerImage) || 8;
  const minimumImageCount = getLongformMinimumImageCount(totalDurationSeconds, fallbackSecondsPerImage);
  timing.fallbackSecondsPerImage = fallbackSecondsPerImage;
  timing.minimumImageCount = minimumImageCount;
  if (!Array.isArray(plan.scenes) || !plan.scenes.length || plan.scenes.length >= minimumImageCount) {
    if (totalDurationSeconds && plan.scenes?.length) {
      const lastScene = plan.scenes[plan.scenes.length - 1];
      if (normalizeTimingSeconds(lastScene.endSeconds) !== totalDurationSeconds) {
        lastScene.endSeconds = totalDurationSeconds;
        lastScene.durationSeconds = normalizeTimingSeconds(totalDurationSeconds - (normalizeTimingSeconds(lastScene.startSeconds) ?? 0)) || lastScene.durationSeconds;
      }
    }
    plan.timing = timing;
    return plan;
  }

  const sourceSegments = normalizeTranscriptSegmentsFromPacket(options.sourcePacket || plan.sourcePacket || {});
  const transcriptGroups = sourceSegments.length
    ? expandTimedGroupsToMinimum(groupTimedSegmentsIntoScenes(sourceSegments, totalDurationSeconds, fallbackSecondsPerImage), minimumImageCount)
    : [];
  const repaired = transcriptGroups.length >= minimumImageCount
    ? transcriptGroups.map((group, index) => buildRepairedSceneFromTranscriptGroup(group, index, findSourceSceneForGroup(group, plan.scenes, index)))
    : [];

  if (!repaired.length) {
    let remainingExtra = minimumImageCount - plan.scenes.length;
    plan.scenes.forEach((scene, index) => {
      const remainingScenes = plan.scenes.length - index;
      const splits = 1 + Math.ceil(remainingExtra / remainingScenes);
      const parts = splitSceneForMinimumCoverage(scene, splits, index);
      repaired.push(...parts);
      remainingExtra -= Math.max(0, parts.length - 1);
    });
  }

  plan.scenes = repaired.slice(0, minimumImageCount).map((scene, index) => ({
    ...scene,
    sceneId: 'scene-' + String(index + 1),
    sourceSpanLabel: scene.sourceSpanLabel || 'Scene ' + String(index + 1),
    imagePrompt: deriveCleanImagePrompt(scene),
  }));
  if (totalDurationSeconds && plan.scenes.length) {
    plan.scenes[0].startSeconds = 0;
    const lastScene = plan.scenes[plan.scenes.length - 1];
    lastScene.endSeconds = totalDurationSeconds;
    lastScene.durationSeconds = normalizeTimingSeconds(totalDurationSeconds - (normalizeTimingSeconds(lastScene.startSeconds) ?? 0)) || lastScene.durationSeconds;
  }
  timing.totalDurationSeconds = totalDurationSeconds;
  timing.coverageNotes = [
    timing.coverageNotes,
    'Local AI Hub repaired the scene count to meet the minimum image count of ' + minimumImageCount + ' for ' + totalDurationSeconds + ' seconds at ' + fallbackSecondsPerImage + ' seconds per image' + (transcriptGroups.length ? ' by rebuilding scenes from transcript segment timing.' : '.'),
  ].filter(Boolean).join(' ');
  plan.timing = timing;
  return plan;
}
function buildSceneText(scene, index, plan) {
  return normalizeTextBlock(scene.imagePrompt || scene.visualPromptDraft || scene.sceneConcept || 'Scene ' + String(index + 1));
}

function buildTextCollectionItems(planValue, options = {}) {
  const validation = validatePlan(planValue, {
    sourcePacket: options.sourcePacket || options.sourcePlan?.sourcePacket || planValue?.sourcePacket || null,
  });
  if (!validation.ok) {
    throw new Error(validation.errors[0] || 'This plan does not match the longform scene-planning schema.');
  }

  const plan = validation.value;
  const sceneTimings = plan.scenes.map((scene) => resolveSceneTiming(scene));
  const timedScenes = sceneTimings.filter((timing) => Number.isFinite(Number(timing.durationSeconds)) && Number(timing.durationSeconds) > 0);
  return plan.scenes.map((scene, index) => {
    const timing = sceneTimings[index] || {};
    return {
      displayName: scene.sourceSpanLabel || scene.sceneId || 'Scene ' + String(index + 1),
      itemId: scene.sceneId || '',
      metadata: {
        durationSeconds: timing.durationSeconds,
        endSeconds: timing.endSeconds,
        imagePrompt: scene.imagePrompt,
        meaningIntent: scene.meaningIntent,
        narrationExcerpt: scene.narrationExcerpt || scene.narrationDraft || '',
        plan: {
          schemaFamilyId: LONGFORM_MEDIA_SCHEMA_FAMILY_ID,
          schemaId: LONGFORM_SCENE_PLAN_SCHEMA_ID,
          schemaVersion: PLANNING_SCHEMA_VERSION,
          sourcePlanId: normalizeString(planValue?.id || planValue?.artifactId),
          sourcePlanTitle: plan.title,
        },
        sourceSpanLabel: scene.sourceSpanLabel,
        sourceTranscriptSegmentIds: scene.sourceTranscriptSegmentIds,
        startSeconds: timing.startSeconds,
        timingMode: timedScenes.length ? 'dynamicFromPlanTiming' : 'fixedDurationFallback',
        treatmentApproach: scene.treatmentApproach,
        viewerTakeaway: scene.viewerTakeaway,
        visualPromptText: scene.visualPromptDraft,
      },
      text: buildSceneText(scene, index, plan),
    };
  });
}

function splitTextIntoSentences(value) {
  return normalizeTextBlock(value)
    .split(/(?<=[.!?])\s+/)
    .map((entry) => normalizeTextBlock(entry))
    .filter(Boolean);
}

function estimateTextDurationSeconds(value) {
  const wordCount = normalizeTextBlock(value).split(/\s+/).filter(Boolean).length;
  if (!wordCount) {
    return 0;
  }

  return Math.max(6, Math.round((wordCount / 2.45) * 100) / 100);
}

function normalizeTranscriptSegmentsFromPacket(packet = {}) {
  const sourceArtifacts = Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts : [];
  const segments = [];
  for (const artifact of sourceArtifacts) {
    const transcription = artifact?.transcription && typeof artifact.transcription === 'object'
      ? artifact.transcription
      : null;
    if (!transcription) {
      continue;
    }

    (Array.isArray(transcription.segments) ? transcription.segments : []).forEach((segment, index) => {
      const text = normalizeTextBlock(segment?.text);
      if (!text) {
        return;
      }

      const startSeconds = normalizeTimingSeconds(segment?.start ?? segment?.startSeconds);
      const endSeconds = normalizeTimingSeconds(segment?.end ?? segment?.endSeconds);
      segments.push({
        artifactLabel: normalizeString(artifact.displayName || artifact.fileName || artifact.kind),
        endSeconds,
        id: normalizeString(segment?.id || segment?.segmentId || segment?.index, String(index)),
        startSeconds,
        text,
      });
    });
  }

  return segments
    .filter((segment) => segment.startSeconds !== null || segment.endSeconds !== null)
    .sort((left, right) => Number(left.startSeconds ?? 0) - Number(right.startSeconds ?? 0));
}

function getPacketNarrationText(packet = {}) {
  const sourceArtifacts = Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts : [];
  return [
    packet.sourceSummary,
    ...sourceArtifacts.map((artifact) => artifact?.transcription?.text || artifact?.textExcerpt || artifact?.summary || ''),
    packet.workingNotes,
  ].map((entry) => normalizeTextBlock(entry)).filter(Boolean).join('\n\n');
}

function getPacketDurationSeconds(packet = {}, segments = []) {
  const sourceArtifacts = Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts : [];
  const artifactDurations = sourceArtifacts
    .map((artifact) => normalizeTimingSeconds(artifact?.transcription?.durationSeconds))
    .filter((duration) => duration !== null && duration > 0);
  const segmentEnd = normalizeTimingSeconds(Math.max(0, ...segments.map((segment) => Number(segment.endSeconds || 0) || 0)));
  const estimatedTextDuration = estimateTextDurationSeconds(getPacketNarrationText(packet));
  return artifactDurations[0] || segmentEnd || estimatedTextDuration || null;
}

function groupTimedSegmentsIntoScenes(segments = [], totalDurationSeconds = null, fallbackSecondsPerImage = 8) {
  if (!segments.length) {
    return [];
  }

  const targetSceneSeconds = normalizeFallbackSecondsPerImage(fallbackSecondsPerImage) || 8;
  const maxSceneSeconds = Math.max(targetSceneSeconds + 1, targetSceneSeconds * 1.5);
  const groups = [];
  let current = [];
  let groupStartSeconds = normalizeTimingSeconds(segments[0].startSeconds) ?? 0;

  const closeGroup = () => {
    if (!current.length) {
      return;
    }

    const first = current[0];
    const last = current[current.length - 1];
    const startSeconds = groups.length ? groups[groups.length - 1].endSeconds : normalizeTimingSeconds(first.startSeconds) ?? 0;
    const endSeconds = normalizeTimingSeconds(last.endSeconds)
      ?? normalizeTimingSeconds(startSeconds + targetSceneSeconds)
      ?? startSeconds + targetSceneSeconds;
    groups.push({
      endSeconds,
      segments: current,
      startSeconds,
    });
    current = [];
    groupStartSeconds = endSeconds;
  };

  segments.forEach((segment, index) => {
    if (!current.length) {
      groupStartSeconds = groups.length ? groups[groups.length - 1].endSeconds : normalizeTimingSeconds(segment.startSeconds) ?? 0;
    }
    current.push(segment);
    const endSeconds = normalizeTimingSeconds(segment.endSeconds) ?? groupStartSeconds;
    const groupDuration = Math.max(0, endSeconds - groupStartSeconds);
    const nextSegment = segments[index + 1] || null;
    const nextWouldOverflow = nextSegment && normalizeTimingSeconds(nextSegment.endSeconds) !== null
      ? Number(nextSegment.endSeconds) - groupStartSeconds > maxSceneSeconds
      : false;
    if ((groupDuration >= targetSceneSeconds && current.length > 1) || nextWouldOverflow) {
      closeGroup();
    }
  });
  closeGroup();

  if (groups.length && totalDurationSeconds && totalDurationSeconds > groups[groups.length - 1].endSeconds) {
    groups[groups.length - 1].endSeconds = normalizeTimingSeconds(totalDurationSeconds) || totalDurationSeconds;
  }

  return groups.map((group, index) => ({
    ...group,
    startSeconds: index === 0 ? 0 : group.startSeconds,
    durationSeconds: normalizeTimingSeconds(Math.max(0.1, group.endSeconds - (index === 0 ? 0 : group.startSeconds))),
  }));
}

function groupUntimedTextIntoScenes(text, totalDurationSeconds = null) {
  const sentences = splitTextIntoSentences(text);
  const sourceParts = sentences.length ? sentences : [normalizeTextBlock(text)].filter(Boolean);
  if (!sourceParts.length) {
    return [];
  }

  const durationSeconds = totalDurationSeconds || estimateTextDurationSeconds(text) || Math.max(6, sourceParts.length * 6);
  const targetSceneCount = Math.max(1, Math.min(90, Math.ceil(durationSeconds / 8)));
  const wordsPerScene = Math.max(24, Math.ceil(normalizeTextBlock(text).split(/\s+/).filter(Boolean).length / targetSceneCount));
  const groups = [];
  let current = [];
  let currentWords = 0;
  const pushCurrent = () => {
    if (current.length) {
      groups.push(current);
      current = [];
      currentWords = 0;
    }
  };
  sourceParts.forEach((part) => {
    const partWords = part.split(/\s+/).filter(Boolean);
    if (partWords.length > wordsPerScene * 1.5) {
      pushCurrent();
      for (let index = 0; index < partWords.length; index += wordsPerScene) {
        groups.push([partWords.slice(index, index + wordsPerScene).join(' ')]);
      }
      return;
    }

    const words = partWords.length;
    if (current.length && currentWords + words > wordsPerScene) {
      pushCurrent();
    }
    current.push(part);
    currentWords += words;
  });
  pushCurrent();

  const sceneDuration = durationSeconds / groups.length;
  return groups.map((group, index) => {
    const startSeconds = normalizeTimingSeconds(index * sceneDuration) || 0;
    const endSeconds = index === groups.length - 1
      ? normalizeTimingSeconds(durationSeconds) || durationSeconds
      : normalizeTimingSeconds((index + 1) * sceneDuration) || (index + 1) * sceneDuration;
    return {
      durationSeconds: normalizeTimingSeconds(endSeconds - startSeconds),
      endSeconds,
      segments: group.map((textPart) => ({ id: '', text: textPart })),
      startSeconds,
    };
  });
}

function summarizeSceneExcerpt(group) {
  return trimPreviewText((group?.segments || []).map((segment) => segment.text).filter(Boolean).join(' '), 420);
}

function buildFallbackScene(group, index) {
  const narrationExcerpt = summarizeSceneExcerpt(group);
  const sceneLabel = 'Narration beat ' + String(index + 1);
  const segmentIds = (group?.segments || []).map((segment) => normalizeString(segment.id)).filter(Boolean);
  const durationSeconds = normalizeTimingSeconds(group.durationSeconds)
    || normalizeTimingSeconds(Number(group.endSeconds || 0) - Number(group.startSeconds || 0))
    || 0.1;
  const imagePrompt = narrationExcerpt
    ? 'Grounded documentary-style slideshow image for this narration beat: ' + narrationExcerpt + '. Clear subject, readable setting, practical lighting, consistent continuity.'
    : 'Grounded documentary-style slideshow image, clear subject, readable setting, practical lighting, consistent continuity.';
  return {
    sceneId: 'scene-' + String(index + 1),
    sourceSpanLabel: sceneLabel,
    meaningIntent: 'Represent this narration beat clearly without adding unsupported source facts.',
    viewerTakeaway: narrationExcerpt || 'The viewer should follow the next narration beat.',
    sceneConcept: narrationExcerpt
      ? 'A grounded slideshow visual that supports: ' + narrationExcerpt
      : 'A grounded slideshow visual for this narration beat.',
    treatmentApproach: 'Use a practical, readable composition with continuity from the surrounding narration.',
    narrationDraft: '',
    narrationExcerpt,
    sourceTranscriptSegmentIds: segmentIds,
    startSeconds: normalizeTimingSeconds(group.startSeconds) ?? 0,
    endSeconds: normalizeTimingSeconds(group.endSeconds) ?? durationSeconds,
    durationSeconds,
    imagePrompt,
    visualPromptDraft: imagePrompt,
    riskNotes: ['Deterministic fallback scene generated because the planner did not return usable JSON. Review and refine the visual prompt before final generation if needed.'],
  };
}

function getPacketFallbackSecondsPerImage(packet = {}, options = {}) {
  const explicit = normalizeFallbackSecondsPerImage(options.fallbackSecondsPerImage || packet?.desiredOutput?.fallbackSecondsPerImage || packet?.fallbackSecondsPerImage);
  if (explicit) {
    return explicit;
  }
  const text = [packet?.desiredOutput?.notes, packet?.workingNotes, packet?.goal].map((entry) => String(entry || '')).join(' ');
  const match = text.match(/fallback\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)?\s*(?:per|\/)?\s*(?:image|item|scene)/i);
  return normalizeFallbackSecondsPerImage(match?.[1]) || 8;
}
function buildDeterministicPlan(packet = {}, options = {}) {
  const timedSegments = normalizeTranscriptSegmentsFromPacket(packet);
  const narrationText = getPacketNarrationText(packet);
  const totalDurationSeconds = getPacketDurationSeconds(packet, timedSegments);
  const fallbackSecondsPerImage = getPacketFallbackSecondsPerImage(packet, options);
  const groups = timedSegments.length
    ? groupTimedSegmentsIntoScenes(timedSegments, totalDurationSeconds, fallbackSecondsPerImage)
    : groupUntimedTextIntoScenes(narrationText, totalDurationSeconds);
  const fallbackGroups = groups.length ? groups : [{
    durationSeconds: normalizeTimingSeconds(totalDurationSeconds) || 6,
    endSeconds: normalizeTimingSeconds(totalDurationSeconds) || 6,
    segments: [{ id: '', text: trimPreviewText(narrationText || packet.goal || packet.title || 'Narration beat', 420) }],
    startSeconds: 0,
  }];
  const scenes = fallbackGroups.map((group, index) => buildFallbackScene(group, index));
  if (scenes.length && totalDurationSeconds && scenes[scenes.length - 1].endSeconds < totalDurationSeconds) {
    const lastScene = scenes[scenes.length - 1];
    lastScene.endSeconds = normalizeTimingSeconds(totalDurationSeconds) || totalDurationSeconds;
    lastScene.durationSeconds = normalizeTimingSeconds(lastScene.endSeconds - lastScene.startSeconds) || lastScene.durationSeconds;
  }

  const reason = normalizeTextBlock(options.reason);
  const plan = {
    title: normalizeString(String(packet.title || '').replace(/\s+packet$/i, ''), 'Longform scene plan'),
    timing: {
      timingMode: timedSegments.length ? 'transcriptSegments' : totalDurationSeconds ? 'estimated' : 'untimed',
      totalDurationSeconds: normalizeTimingSeconds(totalDurationSeconds),
      fallbackSecondsPerImage,
      minimumImageCount: getLongformMinimumImageCount(totalDurationSeconds, fallbackSecondsPerImage),
      source: timedSegments.length ? 'Transcript segment fallback' : 'Estimated narration timing fallback',
      coverageNotes: 'Deterministic fallback scenes cover the available narration timeline from 0 seconds through ' + (normalizeTimingSeconds(totalDurationSeconds) ?? scenes[scenes.length - 1]?.endSeconds ?? 'the final beat') + ' seconds.',
    },
    overview: {
      meaningIntent: normalizeTextBlock(packet.goal) || 'Create a usable longform scene plan from the narration.',
      viewerTakeaway: trimPreviewText(packet.sourceSummary || narrationText || packet.goal, 360) || 'The viewer should follow the narration beat by beat.',
      narrativeArc: 'Follow the narration in source order and keep each visual scene aligned to its timed beat.',
      toneStrategy: normalizeStringList(packet.stylePolicy)[0] || 'Use grounded, clear slideshow visuals that can be refined later.',
      continuityNotes: ['Scenes are ordered by narration timing and should keep visual continuity across adjacent beats.'],
      riskNotes: [reason || 'Planner JSON was unavailable, so Local AI Hub generated this timing-aware fallback deterministically.'],
    },
    scenes,
    openQuestions: ['Review fallback visual prompt wording before final generation if the source needs a more specific art direction.'],
  };
  repairScenePlanMinimumCoverage(plan);

  const validation = validatePlan(plan);
  if (!validation.ok) {
    throw new Error(validation.errors[0] || 'Local AI Hub could not build a fallback scene plan.');
  }

  return validation.value;
}

const LONGFORM_SCENE_PLAN_ADAPTER = Object.freeze({
  definition: LONGFORM_SCENE_PLAN_SCHEMA,
  responseJsonSchema: SCENE_PLAN_RESPONSE_JSON_SCHEMA,
  buildDeterministicPlan,
  buildPreviewDocument,
  buildReviewDocument,
  buildTextCollectionItems,
  validatePlan,
});

module.exports = {
  LONGFORM_MEDIA_SCHEMA_FAMILY_ID,
  LONGFORM_SCENE_PLAN_ADAPTER,
  LONGFORM_SCENE_PLAN_SCHEMA_ID,
  buildDeterministicPlan,
  getLongformMinimumImageCount,
};

module.exports.default = module.exports;
