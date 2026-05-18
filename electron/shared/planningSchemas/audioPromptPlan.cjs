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
const AUDIO_PROMPT_SCHEMA_FAMILY_ID = 'audioPromptPlanning';
const AUDIO_PROMPT_PLAN_SCHEMA_ID = 'audioPromptPlan.v1';
const AUDIO_PROMPT_PLAN_KIND = 'audioPromptPlan';
const TARGET_USE_OPTIONS = new Set(['music', 'ambience', 'soundscape', 'game-loop', 'cinematic', 'other']);
const ENERGY_OPTIONS = new Set(['low', 'medium', 'high']);

const AUDIO_PROMPT_PLAN_RESPONSE_SHAPE_EXAMPLE = Object.freeze({
  schemaVersion: 1,
  kind: 'audioPromptPlan',
  title: 'Dark fantasy battle theme prompt plan',
  overallStyle: 'Dark fantasy orchestral, ominous low strings, distant choir, slow rhythmic build.',
  targetUse: 'music',
  estimatedTotalDurationSeconds: 90,
  sections: [
    {
      index: 1,
      name: 'intro',
      purpose: 'establish mood',
      durationSeconds: 20,
      prompt: 'dark ambient pads, low strings, distant choir, slow rise, restrained percussion',
      negativePrompt: 'vocals, upbeat pop drums',
      mood: 'ominous',
      energy: 'low',
      continuityNotes: 'introduce the main descending motif',
      transitionNotes: 'fade into a stronger rhythmic pulse',
    },
  ],
  globalNegativePrompt: 'modern pop vocals, cheerful ukulele, bright dance beat',
  notes: 'Prompts are ordered planning text only. Downstream audio generation settings remain separate.',
});

const AUDIO_PROMPT_PLAN_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'kind', 'title', 'overallStyle', 'targetUse', 'estimatedTotalDurationSeconds', 'sections', 'globalNegativePrompt', 'notes'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    kind: { type: 'string', enum: ['audioPromptPlan'] },
    title: { type: 'string', description: 'Short title for the planned audio or music piece.' },
    overallStyle: { type: 'string', description: 'Overall sonic style, instrumentation, texture, and mood.' },
    targetUse: { type: 'string', enum: ['music', 'ambience', 'soundscape', 'game-loop', 'cinematic', 'other'] },
    estimatedTotalDurationSeconds: { type: 'number', minimum: 1 },
    sections: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'name', 'purpose', 'durationSeconds', 'prompt', 'negativePrompt', 'mood', 'energy', 'continuityNotes', 'transitionNotes'],
        properties: {
          index: { type: 'integer', minimum: 1 },
          name: { type: 'string' },
          purpose: { type: 'string' },
          durationSeconds: { type: 'number', minimum: 1 },
          prompt: { type: 'string', description: 'Usable text-to-audio prompt for this ordered section.' },
          negativePrompt: { type: 'string', description: 'Sounds, styles, or artifacts to avoid; use an empty string if none.' },
          mood: { type: 'string' },
          energy: { type: 'string', enum: ['low', 'medium', 'high'] },
          continuityNotes: { type: 'string' },
          transitionNotes: { type: 'string' },
        },
      },
    },
    globalNegativePrompt: { type: 'string', description: 'Global avoid list for downstream generation; use an empty string if none.' },
    notes: { type: 'string', description: 'Planning-only notes. Do not claim audio was generated.' },
  },
});


const AUDIO_PROMPT_PLAN_SCHEMA = Object.freeze({
  familyId: AUDIO_PROMPT_SCHEMA_FAMILY_ID,
  familyLabel: 'Audio prompt planning',
  id: AUDIO_PROMPT_PLAN_SCHEMA_ID,
  label: 'Audio prompt plan',
  maturity: 'usable',
  promptSummary: 'Create an ordered audio prompt plan from a text idea. The plan should divide a longer music, ambience, soundscape, game-loop, or cinematic audio concept into useful prompt sections with durations, mood, energy, negative prompts, and continuity or transition notes. This schema plans text prompts only and must not execute audio generation.',
  shapeSummary: 'Title, overall audio style, target use, total duration, and ordered sections with prompt text plus duration, mood, energy, negative prompt, continuity, and transition metadata.',
  systemPrompt: 'You are the Local AI Hub Planner. Reason inside the provided planning schema, keep uncertainty explicit, do not invent source facts, and return JSON only. For audio prompt plans, produce ordered text prompts only; do not claim to generate audio or chain AudioCraft continuation.',
  responseShapeExample: AUDIO_PROMPT_PLAN_RESPONSE_SHAPE_EXAMPLE,
  sourceRequirements: Object.freeze({
    requireTextContext: true,
  }),
});

function normalizeTargetUse(value) {
  const normalized = normalizeString(value).toLowerCase();
  return TARGET_USE_OPTIONS.has(normalized) ? normalized : 'other';
}

function normalizeEnergy(value) {
  const normalized = normalizeString(value).toLowerCase();
  return ENERGY_OPTIONS.has(normalized) ? normalized : 'medium';
}

function normalizeDurationSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.round(numeric * 10) / 10;
}

function normalizeAudioSection(value, index) {
  const input = isRecord(value) ? value : {};
  const sectionIndex = Math.max(1, Math.floor(Number(input.index || index + 1) || index + 1));
  const name = normalizeTextBlock(input.name || input.sectionName || 'Section ' + String(sectionIndex));
  return {
    index: sectionIndex,
    name,
    purpose: normalizeTextBlock(input.purpose || input.intent),
    durationSeconds: normalizeDurationSeconds(input.durationSeconds || input.duration || input.seconds),
    prompt: normalizeTextBlock(input.prompt || input.audioPrompt || input.text),
    negativePrompt: normalizeTextBlock(input.negativePrompt || input.negative),
    mood: normalizeTextBlock(input.mood),
    energy: normalizeEnergy(input.energy),
    continuityNotes: normalizeTextBlock(input.continuityNotes || input.continuity),
    transitionNotes: normalizeTextBlock(input.transitionNotes || input.transition),
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

  const sections = (Array.isArray(value.sections) ? value.sections : [])
    .map((section, index) => normalizeAudioSection(section, index));
  const durationTotal = sections.reduce((total, section) => total + (Number(section.durationSeconds || 0) || 0), 0);
  const normalized = {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    schemaFamilyId: AUDIO_PROMPT_SCHEMA_FAMILY_ID,
    schemaId: AUDIO_PROMPT_PLAN_SCHEMA_ID,
    kind: AUDIO_PROMPT_PLAN_KIND,
    title: normalizeString(value.title, 'Audio prompt plan'),
    overallStyle: normalizeTextBlock(value.overallStyle || value.style || value.styleSummary),
    targetUse: normalizeTargetUse(value.targetUse || value.useCase),
    estimatedTotalDurationSeconds: normalizeDurationSeconds(value.estimatedTotalDurationSeconds || value.totalDurationSeconds) || normalizeDurationSeconds(durationTotal),
    sections,
    globalNegativePrompt: normalizeTextBlock(value.globalNegativePrompt || value.negativePrompt),
    notes: normalizeTextBlock(value.notes),
  };

  const errors = [];
  if (value.kind && normalizeString(value.kind) !== AUDIO_PROMPT_PLAN_KIND) {
    errors.push('Audio prompt plan kind must be audioPromptPlan.');
  }
  if (!normalized.title) {
    errors.push('Audio prompt plan must include a title.');
  }
  if (!normalized.overallStyle) {
    errors.push('Audio prompt plan must include an overall style.');
  }
  if (!normalized.sections.length) {
    errors.push('Audio prompt plan must include at least one section.');
  }
  normalized.sections.forEach((section, index) => {
    const label = 'Section ' + String(index + 1);
    if (!section.name) {
      errors.push(label + ' must include a name.');
    }
    if (!section.purpose) {
      errors.push(label + ' must include a purpose.');
    }
    if (!section.durationSeconds) {
      errors.push(label + ' must include a positive durationSeconds value.');
    }
    if (!section.prompt) {
      errors.push(label + ' must include a usable audio prompt.');
    }
    if (!ENERGY_OPTIONS.has(section.energy)) {
      errors.push(label + ' energy must be low, medium, or high.');
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
    throw new Error(validation.errors[0] || 'Local AI Hub could not build a preview from this audio prompt plan yet.');
  }

  const plan = validation.value;
  const sections = plan.sections.map((section, index) => ({
    continuityNotes: section.continuityNotes,
    durationSeconds: section.durationSeconds,
    energy: section.energy,
    index: section.index || index + 1,
    mood: section.mood,
    name: section.name,
    negativePrompt: section.negativePrompt,
    order: index + 1,
    promptPreview: section.prompt,
    purpose: section.purpose,
    summary: trimPreviewText([section.name, section.purpose, section.prompt].filter(Boolean).join(' | '), 360),
    transitionNotes: section.transitionNotes,
  }));

  return {
    estimatedTotalDurationSeconds: plan.estimatedTotalDurationSeconds,
    globalNegativePrompt: plan.globalNegativePrompt,
    limitationNote: normalizeTextBlock(options.limitationNote || 'This preview is a planning artifact. It creates ordered audio prompt text only; audio generation remains downstream.'),
    notes: plan.notes,
    overallStyle: plan.overallStyle,
    planTitle: normalizeString(plan.title, AUDIO_PROMPT_PLAN_SCHEMA.label),
    previewMode: 'audioPromptSections.v1',
    reviewVersion: PLANNING_REVIEW_VERSION,
    schemaFamilyId: AUDIO_PROMPT_SCHEMA_FAMILY_ID,
    schemaId: AUDIO_PROMPT_PLAN_SCHEMA_ID,
    schemaLabel: AUDIO_PROMPT_PLAN_SCHEMA.label,
    sectionCount: sections.length,
    sections,
    sourcePlanSummary: trimPreviewText([plan.overallStyle, sections[0]?.summary].filter(Boolean).join(' | '), 240),
    targetUse: plan.targetUse,
  };
}

function createReviewFinding(severity, category, title, detail, options = {}) {
  return {
    approximate: options.approximate === true,
    category: normalizeString(category, 'review'),
    detail: normalizeTextBlock(detail),
    heuristic: normalizeString(options.heuristic, 'schema-validation'),
    sectionIndex: Number.isInteger(options.sectionIndex) ? options.sectionIndex : null,
    sectionName: normalizeTextBlock(options.sectionName),
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
      findings.push(createReviewFinding('error', 'schema-validation', 'Plan does not match the audio prompt planning schema', error));
    });
  }

  if (plan) {
    plan.sections.forEach((section, index) => {
      const label = section.name || 'Section ' + String(index + 1);
      const promptWordCount = normalizeStringList(String(section.prompt || '').split(/\s+/)).length;
      if (promptWordCount < 6) {
        findings.push(createReviewFinding(
          'warn',
          'prompt-specificity',
          label + ' prompt may be too short',
          'This section prompt is quite brief, so it may need more concrete instruments, texture, mood, or motion before downstream audio generation.',
          { approximate: true, heuristic: 'prompt-word-count', sectionIndex: index + 1, sectionName: label },
        ));
      }
      if (section.durationSeconds > 180) {
        findings.push(createReviewFinding(
          'info',
          'duration-check',
          label + ' is a long section',
          'This section duration is long for a single generated clip. Consider splitting it downstream if the selected audio backend works better with shorter clips.',
          { approximate: true, heuristic: 'duration-threshold', sectionIndex: index + 1, sectionName: label },
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
    estimatedTotalDurationSeconds: Number(plan?.estimatedTotalDurationSeconds || 0) || 0,
    findings,
    heuristicsUsed: ['Planning schema validation', 'Prompt length check', 'Long section duration check'],
    limitationNote: 'This review checks the audio prompt plan shape and a few simple prompt-readiness signals. It does not run audio generation.',
    planTitle: normalizeString(plan?.title || planValue?.title, AUDIO_PROMPT_PLAN_SCHEMA.label),
    reviewVersion: PLANNING_REVIEW_VERSION,
    schemaFamilyId: AUDIO_PROMPT_SCHEMA_FAMILY_ID,
    schemaId: AUDIO_PROMPT_PLAN_SCHEMA_ID,
    schemaLabel: AUDIO_PROMPT_PLAN_SCHEMA.label,
    sectionCount: Number(plan?.sections?.length || 0) || 0,
    structuralValidation: {
      errors: validation.ok ? [] : [...validation.errors],
      ok: validation.ok,
      summary: validation.ok
        ? 'The plan matches the current audio prompt planning schema shape.'
        : 'The plan does not match the current audio prompt planning schema shape yet.',
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

function buildAudioPromptMetadata(section, index, plan, options = {}) {
  const sourcePlan = options.sourcePlan || null;
  return {
    audioPromptPlan: {
      globalNegativePrompt: plan.globalNegativePrompt,
      lineage: {
        planKind: AUDIO_PROMPT_PLAN_KIND,
        planSchemaId: AUDIO_PROMPT_PLAN_SCHEMA_ID,
        planTitle: plan.title,
        sourceIdea: extractSourceIdea(sourcePlan),
        sourcePlanId: normalizeString(sourcePlan?.id || sourcePlan?.artifactId),
      },
      negativePrompt: section.negativePrompt,
      section: {
        continuityNotes: section.continuityNotes,
        durationSeconds: section.durationSeconds,
        energy: section.energy,
        index: section.index || index + 1,
        mood: section.mood,
        name: section.name,
        purpose: section.purpose,
        transitionNotes: section.transitionNotes,
      },
      targetUse: plan.targetUse,
    },
  };
}

function buildTextCollectionItems(planValue, options = {}) {
  const validation = validatePlan(planValue);
  if (!validation.ok) {
    throw new Error(validation.errors[0] || 'This plan does not match the audio prompt planning schema.');
  }

  const plan = validation.value;
  return plan.sections.map((section, index) => ({
    displayName: section.name || 'Audio section ' + String(index + 1),
    itemId: 'audio-section-' + String(index + 1).padStart(3, '0'),
    metadata: buildAudioPromptMetadata(section, index, plan, options),
    text: section.prompt,
  }));
}

const AUDIO_PROMPT_PLAN_ADAPTER = Object.freeze({
  definition: AUDIO_PROMPT_PLAN_SCHEMA,
  responseJsonSchema: AUDIO_PROMPT_PLAN_RESPONSE_JSON_SCHEMA,
  buildPreviewDocument,
  buildReviewDocument,
  buildTextCollectionItems,
  validatePlan,
});

module.exports = {
  AUDIO_PROMPT_PLAN_ADAPTER,
  AUDIO_PROMPT_PLAN_KIND,
  AUDIO_PROMPT_PLAN_SCHEMA_ID,
  AUDIO_PROMPT_SCHEMA_FAMILY_ID,
};

module.exports.default = module.exports;
