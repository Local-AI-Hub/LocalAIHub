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
  getLongformMinimumImageCount,
} = require('./planningSchemas/longformScenePlan.cjs');
const {
  AUDIO_PROMPT_PLAN_ADAPTER,
  AUDIO_PROMPT_PLAN_SCHEMA_ID,
  AUDIO_PROMPT_SCHEMA_FAMILY_ID,
} = require('./planningSchemas/audioPromptPlan.cjs');
const {
  VIDEO_PROMPT_PLAN_ADAPTER,
  VIDEO_PROMPT_PLAN_SCHEMA_ID,
  VIDEO_PROMPT_SCHEMA_FAMILY_ID,
} = require('./planningSchemas/videoPromptPlan.cjs');

const PLANNING_SCHEMA_VERSION = 1;
const PLANNING_REVIEW_VERSION = 1;
const DEFAULT_PLANNING_SCHEMA_ID = LONGFORM_SCENE_PLAN_SCHEMA_ID;
const LONGFORM_PLANNER_DIRECT_SEGMENT_LIMIT = 80;
const LONGFORM_PLANNER_COMPACT_SEGMENT_LIMIT = 48;
const LONGFORM_PLANNER_SEGMENT_TEXT_LIMIT = 140;
const LONGFORM_PLANNER_GROUP_TEXT_LIMIT = 220;

const PLANNING_SCHEMA_FAMILY_IDS = Object.freeze({
  AUDIO_PROMPT: AUDIO_PROMPT_SCHEMA_FAMILY_ID,
  LONGFORM_MEDIA: LONGFORM_MEDIA_SCHEMA_FAMILY_ID,
  VIDEO_PROMPT: VIDEO_PROMPT_SCHEMA_FAMILY_ID,
});

const PLANNING_SCHEMA_ADAPTERS = Object.freeze({
  [LONGFORM_SCENE_PLAN_SCHEMA_ID]: LONGFORM_SCENE_PLAN_ADAPTER,
  [AUDIO_PROMPT_PLAN_SCHEMA_ID]: AUDIO_PROMPT_PLAN_ADAPTER,
  [VIDEO_PROMPT_PLAN_SCHEMA_ID]: VIDEO_PROMPT_PLAN_ADAPTER,
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
      id: normalizeString(segment?.id || segment?.segmentId || segment?.index, String(index)),
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

function roundPlannerSeconds(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 100) / 100 : null;
}

function trimPlannerText(value, limit) {
  return trimPreviewText(normalizeTextBlock(value), Math.max(20, Number(limit || 0) || 180));
}

function normalizePlannerTimingSeconds(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric * 100) / 100 : null;
}

function getPacketFallbackSecondsPerImage(packet = {}) {
  const notes = [
    packet?.desiredOutput?.notes,
    packet?.workingNotes,
    packet?.goal,
  ].map((entry) => String(entry || '')).join(' ');
  const match = notes.match(/fallback\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)?\s*(?:per|\/)?\s*(?:image|item|scene)/i);
  return normalizePlannerTimingSeconds(packet?.desiredOutput?.fallbackSecondsPerImage || packet?.fallbackSecondsPerImage || match?.[1]) || 8;
}

function getPacketTranscriptDurationSeconds(packet = {}) {
  const durations = [];
  const sourceArtifacts = Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts : [];
  sourceArtifacts.forEach((artifact) => {
    const transcription = artifact?.transcription && typeof artifact.transcription === 'object' ? artifact.transcription : null;
    const duration = normalizePlannerTimingSeconds(transcription?.durationSeconds);
    if (duration) {
      durations.push(duration);
    }
    const segmentEnd = Math.max(0, ...(Array.isArray(transcription?.segments) ? transcription.segments : []).map((segment) => Number(segment?.end ?? segment?.endSeconds ?? 0) || 0));
    const normalizedSegmentEnd = normalizePlannerTimingSeconds(segmentEnd);
    if (normalizedSegmentEnd) {
      durations.push(normalizedSegmentEnd);
    }
  });
  return durations.length ? Math.max(...durations) : null;
}

function buildLongformMinimumCountGuidance(schemaId, packet = {}) {
  if (String(schemaId || '').trim() !== LONGFORM_SCENE_PLAN_SCHEMA_ID) {
    return '';
  }

  const totalDurationSeconds = getPacketTranscriptDurationSeconds(packet);
  const fallbackSecondsPerImage = getPacketFallbackSecondsPerImage(packet);
  const minimumImageCount = getLongformMinimumImageCount(totalDurationSeconds, fallbackSecondsPerImage);
  if (!totalDurationSeconds || !minimumImageCount) {
    return '';
  }

  return [
    'Longform timing requirements:',
    'totalNarrationDurationSeconds: ' + totalDurationSeconds,
    'fallbackSecondsPerImage: ' + fallbackSecondsPerImage,
    'minimumImageCount: ' + minimumImageCount,
    'You must return at least minimumImageCount scenes. If the transcript is too coarse, split transcript segments by their timed content so every scene keeps startSeconds, endSeconds, durationSeconds, narrationExcerpt, sourceTranscriptSegmentIds, and a clean imagePrompt aligned to that time range.',
    'Only imagePrompt is sent to image generation; keep meaningIntent, viewerTakeaway, timing, transcript ids, and risk notes out of imagePrompt.',
  ].join('\n');
}

function normalizePlannerSegment(segment, index, textLimit = LONGFORM_PLANNER_SEGMENT_TEXT_LIMIT) {
  const text = trimPlannerText(segment?.text, textLimit);
  if (!text) {
    return null;
  }

  const id = normalizeString(segment?.id || segment?.segmentId || segment?.index, String(index));
  return {
    id,
    end: roundPlannerSeconds(segment?.end),
    index,
    start: roundPlannerSeconds(segment?.start),
    text,
  };
}

function compactPlannerSegmentGroup(segments, groupIndex) {
  const normalizedSegments = segments
    .map((segment, index) => normalizePlannerSegment(segment, index, LONGFORM_PLANNER_SEGMENT_TEXT_LIMIT))
    .filter(Boolean);
  if (!normalizedSegments.length) {
    return null;
  }

  const first = normalizedSegments[0];
  const last = normalizedSegments[normalizedSegments.length - 1];
  return {
    id: first.id === last.id ? first.id : first.id + '-' + last.id,
    end: last.end,
    index: groupIndex,
    sourceTranscriptSegmentIds: normalizedSegments.map((segment) => segment.id),
    start: first.start,
    text: trimPlannerText(normalizedSegments.map((segment) => segment.text).join(' '), LONGFORM_PLANNER_GROUP_TEXT_LIMIT),
  };
}

function compactPlannerTranscript(transcription = {}) {
  const sourceSegments = Array.isArray(transcription?.segments) ? transcription.segments : [];
  const normalizedDirectSegments = sourceSegments
    .map((segment, index) => normalizePlannerSegment(segment, index))
    .filter(Boolean);
  let compactedSegments = normalizedDirectSegments;
  let compacted = false;

  if (normalizedDirectSegments.length > LONGFORM_PLANNER_DIRECT_SEGMENT_LIMIT) {
    compacted = true;
    const groupSize = Math.max(2, Math.ceil(normalizedDirectSegments.length / LONGFORM_PLANNER_COMPACT_SEGMENT_LIMIT));
    compactedSegments = [];
    for (let index = 0; index < sourceSegments.length; index += groupSize) {
      const group = compactPlannerSegmentGroup(sourceSegments.slice(index, index + groupSize), compactedSegments.length);
      if (group) {
        compactedSegments.push(group);
      }
    }
  }

  return {
    durationSeconds: roundPlannerSeconds(transcription?.durationSeconds),
    language: normalizeString(transcription?.language),
    model: normalizeString(transcription?.model),
    segmentCount: Number(transcription?.segmentCount || sourceSegments.length) || sourceSegments.length,
    segments: compactedSegments,
    ...(compacted ? {
      plannerCompaction: {
        originalSegmentCount: normalizedDirectSegments.length,
        strategy: 'grouped-adjacent-transcript-segments',
      },
    } : {}),
  };
}

function compactPlannerSourceArtifact(artifact = {}, schemaId = DEFAULT_PLANNING_SCHEMA_ID) {
  const compacted = {
    displayName: normalizeString(artifact.displayName || artifact.fileName || artifact.kind, 'Artifact'),
    kind: normalizeString(artifact.kind),
    summary: trimPlannerText(artifact.summary, 600),
    textExcerpt: trimPlannerText(artifact.textExcerpt || artifact.text || artifact.previewText || '', schemaId === LONGFORM_SCENE_PLAN_SCHEMA_ID ? 900 : 1200),
  };

  if (schemaId === LONGFORM_SCENE_PLAN_SCHEMA_ID && artifact?.transcription && typeof artifact.transcription === 'object') {
    compacted.transcription = compactPlannerTranscript(artifact.transcription);
  }

  return Object.fromEntries(Object.entries(compacted).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
  }));
}

function compactPlanningPacketForPlanner(packet, schemaId = DEFAULT_PLANNING_SCHEMA_ID) {
  const normalizedSchemaId = normalizeString(schemaId || packet?.schemaId || packet?.desiredOutput?.schemaId, DEFAULT_PLANNING_SCHEMA_ID);
  const compacted = {
    schemaVersion: packet.schemaVersion,
    title: normalizeString(packet.title),
    schemaFamilyId: normalizeString(packet.schemaFamilyId),
    schemaId: normalizeString(packet.schemaId),
    schemaLabel: normalizeString(packet.schemaLabel),
    goal: trimPlannerText(packet.goal, 700),
    sourceSummary: trimPlannerText(packet.sourceSummary, 900),
    sourceArtifacts: (Array.isArray(packet.sourceArtifacts) ? packet.sourceArtifacts : [])
      .map((artifact) => compactPlannerSourceArtifact(artifact, normalizedSchemaId))
      .filter(Boolean),
    constraints: normalizeStringList(packet.constraints).map((entry) => trimPlannerText(entry, 320)).slice(0, 16),
    stylePolicy: normalizeStringList(packet.stylePolicy).map((entry) => trimPlannerText(entry, 320)).slice(0, 12),
    availableTools: normalizeStringList(packet.availableTools).map((entry) => trimPlannerText(entry, 260)).slice(0, 12),
    readiness: {
      hardwareSummary: trimPlannerText(packet?.readiness?.hardwareSummary, 320),
      notes: normalizeStringList(packet?.readiness?.notes).map((entry) => trimPlannerText(entry, 260)).slice(0, 8),
    },
    desiredOutput: {
      notes: trimPlannerText(packet?.desiredOutput?.notes, 900),
      schemaFamilyId: normalizeString(packet?.desiredOutput?.schemaFamilyId),
      schemaId: normalizeString(packet?.desiredOutput?.schemaId),
      schemaLabel: normalizeString(packet?.desiredOutput?.schemaLabel),
      shapeSummary: trimPlannerText(packet?.desiredOutput?.shapeSummary, 700),
    },
    riskNotes: normalizeStringList(packet.riskNotes).map((entry) => trimPlannerText(entry, 260)).slice(0, 10),
    uncertaintyFlags: normalizeStringList(packet.uncertaintyFlags).map((entry) => trimPlannerText(entry, 220)).slice(0, 10),
    workingNotes: trimPlannerText(packet.workingNotes, 700),
  };

  return compacted;
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

function validatePlanAgainstSchema(schemaId, value, options = {}) {
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
    ...options,
  });
}

function buildDeterministicPlanFromPacket(schemaId, packet, options = {}) {
  const adapter = getPlanningSchemaAdapter(schemaId || packet?.schemaId || DEFAULT_PLANNING_SCHEMA_ID, { allowDefault: false });
  if (!adapter?.buildDeterministicPlan) {
    return null;
  }

  return adapter.buildDeterministicPlan(packet, options);
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
  const promptPacket = options.compact === false
    ? packetValidation.value
    : compactPlanningPacketForPlanner(packetValidation.value, schema.id);
  const jsonIndent = options.compact === false ? 2 : 0;
  const sections = [
    'Planning schema:',
    schema.promptSummary,
    '',
    buildLongformMinimumCountGuidance(schema.id, packetValidation.value),
    '',
    'Required JSON shape example:',
    JSON.stringify(schema.responseShapeExample, null, jsonIndent),
    '',
    'Planning packet:',
    JSON.stringify(promptPacket, null, jsonIndent),
    guidance ? '\nPlanner guidance:\n' + guidance : '',
    '',
    'Return JSON only. Keep uncertainty visible in riskNotes or openQuestions instead of pretending missing source detail is certain.',
  ].filter(Boolean);

  const userPrompt = sections.join('\n');
  const systemPrompt = [normalizeTextBlock(options.systemPrompt), schema.systemPrompt].filter(Boolean).join('\n\n').trim();
  return {
    packet: packetValidation.value,
    promptPacket,
    promptStats: {
      compacted: options.compact !== false,
      systemPromptCharacters: systemPrompt.length,
      userPromptCharacters: userPrompt.length,
    },
    schema,
    systemPrompt,
    userPrompt,
  };
}

const buildPlanAuditDocument = buildPlanReviewDocument;

module.exports = {
  AUDIO_PROMPT_PLAN_SCHEMA_ID,
  DEFAULT_PLANNING_SCHEMA_ID,
  LONGFORM_SCENE_PLAN_SCHEMA_ID,
  VIDEO_PROMPT_PLAN_SCHEMA_ID,
  PLANNING_REVIEW_VERSION,
  PLANNING_SCHEMA_FAMILY_IDS,
  PLANNING_SCHEMA_VERSION,
  buildPlanAuditDocument,
  buildPlanPreviewDocument,
  buildPlanReviewDocument,
  buildPlanTextCollectionItems,
  buildDeterministicPlanFromPacket,
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
