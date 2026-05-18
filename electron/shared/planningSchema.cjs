const {
  cloneValue,
  isRecord,
  normalizeString,
  normalizeStringList,
  normalizeTextBlock,
  trimPreviewText,
} = require('./planningSchemas/planningSchemaUtils.cjs');
const {
  LONGFORM_MEDIA_SCHEMA_FAMILY_ID,
  LONGFORM_SCENE_PLAN_ADAPTER,
  LONGFORM_SCENE_PLAN_SCHEMA_ID,
} = require('./planningSchemas/longformScenePlan.cjs');
const {
  AUDIO_PROMPT_PLAN_ADAPTER,
  AUDIO_PROMPT_PLAN_SCHEMA_ID,
  AUDIO_PROMPT_SCHEMA_FAMILY_ID,
} = require('./planningSchemas/audioPromptPlan.cjs');

const PLANNING_SCHEMA_VERSION = 1;
const PLANNING_REVIEW_VERSION = 1;
const DEFAULT_PLANNING_SCHEMA_ID = LONGFORM_SCENE_PLAN_SCHEMA_ID;

const PLANNING_SCHEMA_FAMILY_IDS = Object.freeze({
  AUDIO_PROMPT: AUDIO_PROMPT_SCHEMA_FAMILY_ID,
  LONGFORM_MEDIA: LONGFORM_MEDIA_SCHEMA_FAMILY_ID,
});

const PLANNING_SCHEMA_ADAPTERS = Object.freeze({
  [LONGFORM_SCENE_PLAN_SCHEMA_ID]: LONGFORM_SCENE_PLAN_ADAPTER,
  [AUDIO_PROMPT_PLAN_SCHEMA_ID]: AUDIO_PROMPT_PLAN_ADAPTER,
});

function getPlanningSchemaAdapter(schemaId, options = {}) {
  const normalizedId = normalizeString(schemaId, DEFAULT_PLANNING_SCHEMA_ID);
  const adapter = PLANNING_SCHEMA_ADAPTERS[normalizedId] || null;
  if (adapter) {
    return adapter;
  }

  return options.allowDefault === false ? null : PLANNING_SCHEMA_ADAPTERS[DEFAULT_PLANNING_SCHEMA_ID];
}

function getPlanningSchemaDefinition(schemaId) {
  const adapter = getPlanningSchemaAdapter(schemaId);
  return cloneValue(adapter?.definition || PLANNING_SCHEMA_ADAPTERS[DEFAULT_PLANNING_SCHEMA_ID].definition);
}

function getPlanningSchemaResponseJsonSchema(schemaId) {
  const adapter = getPlanningSchemaAdapter(schemaId, { allowDefault: false });
  if (!adapter?.responseJsonSchema) {
    return null;
  }
  return cloneValue(adapter.responseJsonSchema);
}

function buildPlanningSchemaStructuredOutputRequest(schemaId) {
  const adapter = getPlanningSchemaAdapter(schemaId, { allowDefault: false });
  const responseJsonSchema = adapter?.responseJsonSchema ? cloneValue(adapter.responseJsonSchema) : null;
  if (!responseJsonSchema) {
    return null;
  }

  const schemaDefinition = adapter.definition || {};
  const schemaName = ('local_ai_hub_' + normalizeString(schemaDefinition.id || schemaId, 'planning_schema'))
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 80) || 'local_ai_hub_planning_schema';
  return {
    type: 'json_schema',
    name: schemaName,
    schema: responseJsonSchema,
  };
}

function getPlanningSchemaOptions() {
  return Object.values(PLANNING_SCHEMA_ADAPTERS).map((adapter) => {
    const schema = adapter.definition || {};
    return {
      familyId: schema.familyId,
      familyLabel: schema.familyLabel,
      id: schema.id,
      label: schema.label,
      maturity: schema.maturity,
      promptSummary: schema.promptSummary,
      shapeSummary: schema.shapeSummary,
    };
  });
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

function summarizeTranscriptionSource(artifact) {
  const transcription = artifact?.transcription && typeof artifact.transcription === 'object'
    ? artifact.transcription
    : null;
  if (!transcription) {
    return null;
  }

  const segments = (Array.isArray(transcription.segments) ? transcription.segments : [])
    .map((segment, index) => ({
      end: Number.isFinite(Number(segment?.end)) ? Math.round(Number(segment.end) * 100) / 100 : null,
      index,
      start: Number.isFinite(Number(segment?.start)) ? Math.round(Number(segment.start) * 100) / 100 : null,
      text: normalizeTextBlock(segment?.text),
    }))
    .filter((segment) => segment.text)
    .slice(0, 200);

  return {
    durationSeconds: Number.isFinite(Number(transcription.durationSeconds)) ? Math.round(Number(transcription.durationSeconds) * 100) / 100 : null,
    language: normalizeString(transcription.language),
    model: normalizeString(transcription.model),
    segmentCount: Number(transcription.segmentCount || segments.length) || segments.length,
    segments,
  };
}

function summarizeSourceArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return null;
  }

  const summary = {
    displayName: normalizeString(artifact.displayName || artifact.fileName || artifact.kind, 'Artifact'),
    fileName: normalizeString(artifact.fileName),
    filePath: normalizeString(artifact.filePath),
    kind: normalizeString(artifact.kind),
    summary: normalizeString(artifact.summary || artifact.previewText || artifact.text),
    textExcerpt: trimPreviewText(artifact.textExcerpt || artifact.text || artifact.previewText || '', 1200),
  };
  const transcription = summarizeTranscriptionSource(artifact);
  if (transcription) {
    summary.transcription = transcription;
  }
  return summary;
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

  const requestedSchemaId = normalizeString(value.schemaId || value?.desiredOutput?.schemaId, DEFAULT_PLANNING_SCHEMA_ID);
  const adapter = getPlanningSchemaAdapter(requestedSchemaId, { allowDefault: false });
  const schema = cloneValue(adapter?.definition || PLANNING_SCHEMA_ADAPTERS[DEFAULT_PLANNING_SCHEMA_ID].definition);
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
  if (!adapter) {
    errors.push('Local AI Hub does not recognize that planning schema yet.');
  }
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

function validatePlanAgainstSchema(schemaId, value) {
  const adapter = getPlanningSchemaAdapter(schemaId || value?.schemaId || DEFAULT_PLANNING_SCHEMA_ID, { allowDefault: false });
  if (!adapter?.validatePlan) {
    return {
      ok: false,
      errors: ['Local AI Hub does not recognize that planning schema yet.'],
      value: null,
    };
  }

  return adapter.validatePlan(value, {
    schemaVersion: PLANNING_SCHEMA_VERSION,
  });
}

function buildPlanPreviewDocument(planValue, options = {}) {
  const adapter = getPlanningSchemaAdapter(planValue?.schemaId || options.schemaId || DEFAULT_PLANNING_SCHEMA_ID, { allowDefault: false });
  if (!adapter?.buildPreviewDocument) {
    throw new Error('Local AI Hub does not have a preview adapter for that planning schema yet.');
  }

  return adapter.buildPreviewDocument(planValue, options);
}

function buildPlanReviewDocument(planValue, options = {}) {
  const adapter = getPlanningSchemaAdapter(planValue?.schemaId || options.schemaId || DEFAULT_PLANNING_SCHEMA_ID, { allowDefault: false });
  if (!adapter?.buildReviewDocument) {
    throw new Error('Local AI Hub does not have a review adapter for that planning schema yet.');
  }

  return adapter.buildReviewDocument(planValue, options);
}

function buildPlanTextCollectionItems(planValue, options = {}) {
  const adapter = getPlanningSchemaAdapter(planValue?.schemaId || options.schemaId || DEFAULT_PLANNING_SCHEMA_ID, { allowDefault: false });
  if (!adapter?.buildTextCollectionItems) {
    throw new Error('This planning schema does not currently expose a text-collection bridge.');
  }

  return adapter.buildTextCollectionItems(planValue, options);
}

function buildPlannerPrompt(schemaId, packet, options = {}) {
  const adapter = getPlanningSchemaAdapter(schemaId, { allowDefault: false });
  if (!adapter?.definition) {
    throw new Error('Local AI Hub does not recognize that planning schema yet.');
  }

  const schema = cloneValue(adapter.definition);
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

const buildPlanAuditDocument = buildPlanReviewDocument;

module.exports = {
  AUDIO_PROMPT_PLAN_SCHEMA_ID,
  DEFAULT_PLANNING_SCHEMA_ID,
  PLANNING_REVIEW_VERSION,
  PLANNING_SCHEMA_FAMILY_IDS,
  PLANNING_SCHEMA_VERSION,
  buildPlanAuditDocument,
  buildPlanPreviewDocument,
  buildPlanReviewDocument,
  buildPlanTextCollectionItems,
  buildPlanningPacketDocument,
  buildPlanningSchemaStructuredOutputRequest,
  buildPlannerPrompt,
  cloneValue,
  getPlanningSchemaAdapter,
  getPlanningSchemaDefinition,
  getPlanningSchemaOptions,
  getPlanningSchemaResponseJsonSchema,
  summarizeHardware,
  summarizeSourceArtifact,
  trimPreviewText,
  validatePlanAgainstSchema,
  validatePlanningPacketShape,
};

module.exports.default = module.exports;
