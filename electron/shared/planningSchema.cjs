const PLANNING_SCHEMA_VERSION = 1;
const PLANNING_REVIEW_VERSION = 1;
const DEFAULT_PLANNING_SCHEMA_ID = 'longformMedia.scenePlan.v1';

const PLANNING_SCHEMA_FAMILY_IDS = Object.freeze({
  LONGFORM_MEDIA: 'longformMedia',
});

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

function normalizeString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeTextBlock(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function trimPreviewText(value, limit = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > limit ? normalized.slice(0, Math.max(1, limit - 3)) + '...' : normalized;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => normalizeTextBlock(entry)).filter(Boolean))];
  }

  return [...new Set(
    String(value || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((entry) => entry.replace(/^[-*\d.)\s]+/, '').trim())
      .filter(Boolean),
  )];
}

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

function createAuditFinding(severity, category, title, detail, options = {}) {
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

function buildPlanPreviewDocument(planValue, options = {}) {
  const schemaId = normalizeString(planValue?.schemaId, DEFAULT_PLANNING_SCHEMA_ID);
  const validation = validatePlanAgainstSchema(schemaId, planValue);
  if (!validation.ok) {
    throw new Error(validation.errors[0] || 'Local AI Hub could not build a preview from this plan yet.');
  }

  const plan = validation.value;
  const schema = getPlanningSchemaDefinition(plan.schemaId || schemaId);
  const scenes = plan.scenes.map((scene, index) => ({
    meaningIntent: scene.meaningIntent,
    narrationDraft: scene.narrationDraft,
    order: index + 1,
    promptPreview: scene.visualPromptDraft,
    promptReadiness: !scene.visualPromptDraft
      ? 'missing-prompt'
      : countPromptSpecificityTerms(scene.visualPromptDraft) >= 8
        ? 'usable-draft'
        : 'needs-more-specificity',
    promptWordCount: countPromptSpecificityTerms(scene.visualPromptDraft),
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
    planTitle: normalizeString(plan.title, schema?.label || 'Plan'),
    previewMode: 'scenePromptCards.v1',
    reviewVersion: PLANNING_REVIEW_VERSION,
    sceneCount: scenes.length,
    scenes,
    schemaFamilyId: normalizeString(schema?.familyId, PLANNING_SCHEMA_FAMILY_IDS.LONGFORM_MEDIA),
    schemaId: normalizeString(plan.schemaId, schema?.id || DEFAULT_PLANNING_SCHEMA_ID),
    schemaLabel: normalizeString(schema?.label, 'Preview'),
    sourcePlanSummary: trimPreviewText([plan.overview?.viewerTakeaway, plan.scenes?.[0]?.sceneConcept].filter(Boolean).join(' | '), 240),
  };
}

function buildPlanAuditDocument(planValue, options = {}) {
  const schemaId = normalizeString(planValue?.schemaId, DEFAULT_PLANNING_SCHEMA_ID);
  const validation = validatePlanAgainstSchema(schemaId, planValue);
  const schema = getPlanningSchemaDefinition(schemaId);
  const plan = validation.ok ? validation.value : null;
  const previewDocument = isRecord(options.preview) ? options.preview : null;
  const packetValidation = isRecord(options.sourcePacket) ? validatePlanningPacketShape(options.sourcePacket) : { ok: false, value: null };
  const constraints = packetValidation.ok ? normalizeStringList(packetValidation.value?.constraints) : [];
  const findings = [];

  if (!validation.ok) {
    validation.errors.forEach((error) => {
      findings.push(createAuditFinding(
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
    scenes.forEach((scene, index) => {
      const sceneLabel = scene.sourceSpanLabel || scene.sceneId || 'Scene ' + String(index + 1);
      const promptSpecificityCount = countPromptSpecificityTerms(scene.visualPromptDraft);
      if (promptSpecificityCount < 7) {
        findings.push(createAuditFinding(
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
        findings.push(createAuditFinding(
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
      extractConstraintSignals(constraints).forEach((signal) => {
        if (signal.type === 'negative') {
          const exactPhrase = signal.phrase ? sceneReviewText.includes(signal.phrase.toLowerCase()) : false;
          const keywordHits = (signal.keywords || []).filter((keyword) => sceneReviewText.includes(keyword));
          if (exactPhrase || keywordHits.length >= Math.min(2, Math.max(1, signal.keywords.length))) {
            findings.push(createAuditFinding(
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
            findings.push(createAuditFinding(
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
        findings.push(createAuditFinding(
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
    limitationNote: 'This audit combines plan-shape validation with a small set of bounded heuristics. It is useful for review, but it is not exhaustive or a semantic guarantee.',
    planTitle: normalizeString(plan?.title || planValue?.title, schema?.label || 'Plan'),
    previewCoverage: {
      connected: Boolean(previewDocument),
      matchesPlan: !previewDocument || !findings.some((entry) => entry.category === 'preview-coverage'),
      sceneCount: Number(previewDocument?.sceneCount || previewDocument?.scenes?.length || 0) || 0,
    },
    reviewVersion: PLANNING_REVIEW_VERSION,
    sceneCount: Number(plan?.scenes?.length || 0) || 0,
    schemaFamilyId: normalizeString(schema?.familyId, PLANNING_SCHEMA_FAMILY_IDS.LONGFORM_MEDIA),
    schemaId: normalizeString(schema?.id, DEFAULT_PLANNING_SCHEMA_ID),
    schemaLabel: normalizeString(schema?.label, 'Audit'),
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

function summarizeHardware(hardware = {}) {
  const gpuModel = normalizeString(hardware?.gpuModel, 'Unknown GPU');
  const vramMb = Number(hardware?.vramMb || 0) || 0;
  const systemRamMb = Number(hardware?.systemRamMb || 0) || 0;
  const memoryParts = [];
  if (vramMb > 0) {
    memoryParts.push(Math.round(vramMb / 1024) + ' GB VRAM');
  }
  if (systemRamMb > 0) {
    memoryParts.push(Math.round(systemRamMb / 1024) + ' GB RAM');
  }

  const compatibilityMessage = normalizeString(hardware?.compatibilityMessage);
  const summary = [gpuModel, memoryParts.join(' | '), compatibilityMessage].filter(Boolean).join(' | ');
  return summary || 'Hardware profile unavailable';
}

function summarizeSourceArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return null;
  }

  return {
    displayName: normalizeString(artifact.displayName || artifact.fileName || artifact.kind, 'Artifact'),
    fileName: normalizeString(artifact.fileName),
    filePath: normalizeString(artifact.filePath),
    kind: normalizeString(artifact.kind),
    summary: normalizeString(artifact.summary || artifact.previewText || artifact.text),
    textExcerpt: trimPreviewText(artifact.textExcerpt || artifact.text || artifact.previewText || '', 1200),
  };
}

const SCENE_PLAN_RESPONSE_SHAPE_EXAMPLE = Object.freeze({
  title: 'Episode scene plan',
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
      visualPromptDraft: 'A practical prompt draft for later image or video work.',
      riskNotes: ['Ambiguities or continuity risks for this scene.'],
    },
  ],
  openQuestions: ['Any missing detail the source still leaves unclear.'],
});

const PLANNING_SCHEMAS = Object.freeze({
  [DEFAULT_PLANNING_SCHEMA_ID]: Object.freeze({
    familyId: PLANNING_SCHEMA_FAMILY_IDS.LONGFORM_MEDIA,
    familyLabel: 'Longform media',
    id: DEFAULT_PLANNING_SCHEMA_ID,
    label: 'Scene plan',
    maturity: 'usable',
    promptSummary: 'Create a staged longform-media scene plan that makes narrative intent, viewer takeaway, scene concept, treatment, risk notes, and prompt drafts explicit for each scene.',
    shapeSummary: 'Overview plus ordered scenes with intent, takeaway, concept, treatment, risk notes, and prompt drafts.',
    systemPrompt: 'You are the Local AI Hub Planner. Reason inside the provided planning schema, keep uncertainty explicit, do not invent source facts, and return JSON only.',
    responseShapeExample: SCENE_PLAN_RESPONSE_SHAPE_EXAMPLE,
    sourceRequirements: Object.freeze({
      requireTextContext: true,
    }),
  }),
});

function getPlanningSchemaDefinition(schemaId) {
  const normalizedId = normalizeString(schemaId, DEFAULT_PLANNING_SCHEMA_ID);
  return cloneValue(PLANNING_SCHEMAS[normalizedId] || PLANNING_SCHEMAS[DEFAULT_PLANNING_SCHEMA_ID]);
}

function getPlanningSchemaOptions() {
  return Object.values(PLANNING_SCHEMAS).map((schema) => ({
    familyId: schema.familyId,
    familyLabel: schema.familyLabel,
    id: schema.id,
    label: schema.label,
    maturity: schema.maturity,
    promptSummary: schema.promptSummary,
    shapeSummary: schema.shapeSummary,
  }));
}

function normalizeDesiredOutput(schema, config = {}) {
  return {
    notes: normalizeTextBlock(config.desiredOutputNotes),
    schemaFamilyId: normalizeString(schema?.familyId, PLANNING_SCHEMA_FAMILY_IDS.LONGFORM_MEDIA),
    schemaId: normalizeString(schema?.id, DEFAULT_PLANNING_SCHEMA_ID),
    schemaLabel: normalizeString(schema?.label, 'Plan'),
    shapeSummary: normalizeString(schema?.shapeSummary),
  };
}

function buildPlanningPacketDocument(config = {}, sourceArtifacts = [], options = {}) {
  const schema = getPlanningSchemaDefinition(config.schemaId || options.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
  const normalizedSources = (Array.isArray(sourceArtifacts) ? sourceArtifacts : [])
    .map((artifact) => summarizeSourceArtifact(artifact))
    .filter(Boolean);

  return {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    title: normalizeString(config.title, schema.label + ' Packet'),
    schemaFamilyId: schema.familyId,
    schemaId: schema.id,
    schemaLabel: schema.label,
    goal: normalizeTextBlock(config.goal),
    sourceSummary: normalizeTextBlock(config.sourceSummary),
    sourceArtifacts: normalizedSources,
    constraints: normalizeStringList(config.constraintsText || config.constraints),
    stylePolicy: normalizeStringList(config.stylePolicyText || config.stylePolicy),
    availableTools: normalizeStringList(config.availableToolsText || config.availableTools),
    readiness: {
      hardwareSummary: summarizeHardware(options.hardware || {}),
      notes: normalizeStringList(config.readinessNotesText || config.readinessNotes),
    },
    desiredOutput: normalizeDesiredOutput(schema, config),
    riskNotes: normalizeStringList(config.riskNotesText || config.riskNotes),
    uncertaintyFlags: normalizeStringList(config.uncertaintyFlagsText || config.uncertaintyFlags),
    workingNotes: normalizeTextBlock(config.additionalContext || config.workingNotes),
  };
}

function validatePlanningPacketShape(value) {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: ['Planning packet data must be an object.'],
      value: null,
    };
  }

  const schema = getPlanningSchemaDefinition(value.schemaId || value?.desiredOutput?.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
  const normalized = {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    title: normalizeString(value.title, schema.label + ' Packet'),
    schemaFamilyId: normalizeString(value.schemaFamilyId, schema.familyId),
    schemaId: normalizeString(value.schemaId, schema.id),
    schemaLabel: normalizeString(value.schemaLabel, schema.label),
    goal: normalizeTextBlock(value.goal),
    sourceSummary: normalizeTextBlock(value.sourceSummary),
    sourceArtifacts: (Array.isArray(value.sourceArtifacts) ? value.sourceArtifacts : []).map((artifact) => summarizeSourceArtifact(artifact)).filter(Boolean),
    constraints: normalizeStringList(value.constraints),
    stylePolicy: normalizeStringList(value.stylePolicy),
    availableTools: normalizeStringList(value.availableTools),
    readiness: {
      hardwareSummary: normalizeString(value?.readiness?.hardwareSummary),
      notes: normalizeStringList(value?.readiness?.notes),
    },
    desiredOutput: {
      notes: normalizeTextBlock(value?.desiredOutput?.notes),
      schemaFamilyId: normalizeString(value?.desiredOutput?.schemaFamilyId, schema.familyId),
      schemaId: normalizeString(value?.desiredOutput?.schemaId, schema.id),
      schemaLabel: normalizeString(value?.desiredOutput?.schemaLabel, schema.label),
      shapeSummary: normalizeString(value?.desiredOutput?.shapeSummary, schema.shapeSummary),
    },
    riskNotes: normalizeStringList(value.riskNotes),
    uncertaintyFlags: normalizeStringList(value.uncertaintyFlags),
    workingNotes: normalizeTextBlock(value.workingNotes),
  };

  const errors = [];
  if (!normalized.goal) {
    errors.push('Enter a task goal before Local AI Hub builds this planning packet.');
  }

  if (!normalized.desiredOutput.schemaId) {
    errors.push('Choose the desired planning schema before Local AI Hub builds this planning packet.');
  }

  if (!normalized.sourceArtifacts.length && !normalized.sourceSummary) {
    errors.push('Connect at least one source artifact or add a source summary for this planning packet.');
  }

  if (schema.sourceRequirements?.requireTextContext) {
    const hasTextSource = normalized.sourceArtifacts.some((artifact) => artifact.textExcerpt);
    if (!hasTextSource && !normalized.sourceSummary) {
      errors.push('This planning schema needs source text. Connect a script or transcript, or add a manual source summary.');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    value: normalized,
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

function normalizeScenePlanScene(value, index) {
  const input = isRecord(value) ? value : {};
  return {
    sceneId: normalizeString(input.sceneId, 'scene-' + String(index + 1)),
    sourceSpanLabel: normalizeTextBlock(input.sourceSpanLabel || input.sourceSpan || input.beat || 'Scene ' + String(index + 1)),
    meaningIntent: normalizeTextBlock(input.meaningIntent || input.intent),
    viewerTakeaway: normalizeTextBlock(input.viewerTakeaway || input.takeaway),
    sceneConcept: normalizeTextBlock(input.sceneConcept || input.concept),
    treatmentApproach: normalizeTextBlock(input.treatmentApproach || input.treatment),
    narrationDraft: normalizeTextBlock(input.narrationDraft || input.narration),
    visualPromptDraft: normalizeTextBlock(input.visualPromptDraft || input.promptDraft || input.prompt),
    riskNotes: normalizeStringList(input.riskNotes),
  };
}

function validateScenePlanValue(value) {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: ['Planner output must be a JSON object.'],
      value: null,
    };
  }

  const normalized = {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    schemaFamilyId: PLANNING_SCHEMA_FAMILY_IDS.LONGFORM_MEDIA,
    schemaId: DEFAULT_PLANNING_SCHEMA_ID,
    title: normalizeString(value.title, 'Scene plan'),
    overview: normalizeScenePlanOverview(value.overview),
    scenes: (Array.isArray(value.scenes) ? value.scenes : []).map((scene, index) => normalizeScenePlanScene(scene, index)).filter(Boolean),
    openQuestions: normalizeStringList(value.openQuestions),
  };

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
    if (!scene.visualPromptDraft) {
      errors.push(label + ' must include a prompt draft.');
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    value: normalized,
  };
}

function validatePlanAgainstSchema(schemaId, value) {
  const schema = getPlanningSchemaDefinition(schemaId);
  if (schema.id === DEFAULT_PLANNING_SCHEMA_ID) {
    return validateScenePlanValue(value);
  }

  return {
    ok: false,
    errors: ['Local AI Hub does not recognize that planning schema yet.'],
    value: null,
  };
}

function buildPlannerPrompt(schemaId, packet, options = {}) {
  const schema = getPlanningSchemaDefinition(schemaId);
  const packetValidation = validatePlanningPacketShape(packet);
  if (!packetValidation.ok) {
    throw new Error(packetValidation.errors[0] || 'Planning packet is not ready yet.');
  }

  const guidance = normalizeTextBlock(options.guidance);
  const sections = [
    'Planning schema:',
    schema.promptSummary,
    '',
    'Required JSON shape example:',
    JSON.stringify(schema.responseShapeExample, null, 2),
    '',
    'Planning packet:',
    JSON.stringify(packetValidation.value, null, 2),
    guidance ? '\nPlanner guidance:\n' + guidance : '',
    '',
    'Return JSON only. Keep uncertainty visible in riskNotes or openQuestions instead of pretending missing source detail is certain.',
  ].filter(Boolean);

  return {
    packet: packetValidation.value,
    schema,
    systemPrompt: [normalizeTextBlock(options.systemPrompt), schema.systemPrompt].filter(Boolean).join('\n\n').trim(),
    userPrompt: sections.join('\n'),
  };
}

module.exports = {
  DEFAULT_PLANNING_SCHEMA_ID,
  PLANNING_REVIEW_VERSION,
  PLANNING_SCHEMA_FAMILY_IDS,
  PLANNING_SCHEMA_VERSION,
  buildPlanAuditDocument,
  buildPlanPreviewDocument,
  buildPlanningPacketDocument,
  buildPlannerPrompt,
  cloneValue,
  getPlanningSchemaDefinition,
  getPlanningSchemaOptions,
  summarizeHardware,
  summarizeSourceArtifact,
  trimPreviewText,
  validatePlanAgainstSchema,
  validatePlanningPacketShape,
};

module.exports.default = module.exports;
