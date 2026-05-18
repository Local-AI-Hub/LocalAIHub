const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
  if (normalizedParent.endsWith('/electron/services/pipelineArtifactService.js') && request === './configService') {
    return {
      ensureStorage: async () => {},
      getAppPaths: () => ({ runtimesRoot: process.cwd() }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  AUDIO_PROMPT_PLAN_SCHEMA_ID,
  buildPlanReviewDocument,
  buildPlanTextCollectionItems,
  buildPlannerPrompt,
  buildPlanningPacketDocument,
  buildPlanningSchemaStructuredOutputRequest,
  getPlanningSchemaOptions,
  validatePlanAgainstSchema,
  validatePlanningPacketShape,
} = require('../electron/shared/planningSchema.cjs');
const {
  createArtifactCollection,
  createTextArtifact,
} = require('../electron/services/pipelineArtifactService');
const {
  buildGoogleGenerationConfig,
  buildOpenAiResponseFormat,
} = require('../electron/services/providerService');

const goodAudioPlan = {
  schemaVersion: 1,
  kind: 'audioPromptPlan',
  title: 'Dark fantasy battle theme',
  overallStyle: 'Dark orchestral fantasy, low strings, distant choir, heavy percussion, cinematic tension.',
  targetUse: 'music',
  estimatedTotalDurationSeconds: 90,
  sections: [
    {
      index: 1,
      name: 'intro',
      purpose: 'establish an ominous battlefield atmosphere',
      durationSeconds: 20,
      prompt: 'dark ambient pads, low bowed strings, distant choir, slow ominous rise, sparse war drums',
      negativePrompt: 'upbeat pop drums, vocals, cheerful melody',
      mood: 'ominous',
      energy: 'low',
      continuityNotes: 'introduce the main descending motif quietly',
      transitionNotes: 'fade into a stronger pulse',
    },
    {
      index: 2,
      name: 'climax',
      purpose: 'deliver the main battle payoff',
      durationSeconds: 40,
      prompt: 'epic dark fantasy orchestra, pounding taiko-like percussion, brass swells, choir accents, urgent string ostinato',
      negativePrompt: 'modern EDM drop, comic tone',
      mood: 'heroic and dangerous',
      energy: 'high',
      continuityNotes: 'state the descending motif in brass',
      transitionNotes: 'end with a suspended final hit',
    },
  ],
  globalNegativePrompt: 'bright ukulele, cheerful pop vocals',
  notes: 'Planning-only prompt sections for downstream text-to-audio generation.',
};

const goodValidation = validatePlanAgainstSchema(AUDIO_PROMPT_PLAN_SCHEMA_ID, goodAudioPlan);
assert.strictEqual(goodValidation.ok, true, goodValidation.errors.join('; '));
assert.strictEqual(goodValidation.value.kind, 'audioPromptPlan');
assert.strictEqual(goodValidation.value.sections.length, 2);
assert.strictEqual(goodValidation.value.sections[1].energy, 'high');

const badValidation = validatePlanAgainstSchema(AUDIO_PROMPT_PLAN_SCHEMA_ID, {
  kind: 'audioPromptPlan',
  title: 'Broken audio plan',
  overallStyle: 'ambient',
  sections: [{ name: 'intro', purpose: 'start', durationSeconds: 0, prompt: '' }],
});
assert.strictEqual(badValidation.ok, false, 'Invalid audio prompt plans should fail validation.');
assert(badValidation.errors.some((entry) => /durationSeconds/i.test(entry)), 'Invalid duration should be reported clearly.');
assert(badValidation.errors.some((entry) => /prompt/i.test(entry)), 'Missing prompt should be reported clearly.');

const packet = buildPlanningPacketDocument({
  schemaId: AUDIO_PROMPT_PLAN_SCHEMA_ID,
  title: 'Audio idea planning packet',
  goal: 'Make a 90-second dark fantasy battle theme with an ominous intro, a rising middle section, and a climactic ending.',
  constraintsText: 'Plan text prompts only. Do not generate audio.',
  desiredOutputNotes: 'Return ordered audioPromptPlan sections with durations and negative prompts.',
}, [createTextArtifact('Make a 90-second dark fantasy battle theme with an ominous intro, a rising middle section, and a climactic ending.', { displayName: 'Audio idea' })]);
const packetValidation = validatePlanningPacketShape(packet);
assert.strictEqual(packetValidation.ok, true, packetValidation.errors.join('; '));
assert.strictEqual(packetValidation.value.schemaId, AUDIO_PROMPT_PLAN_SCHEMA_ID);
assert.strictEqual(packetValidation.value.desiredOutput.schemaId, AUDIO_PROMPT_PLAN_SCHEMA_ID);

const plannerPrompt = buildPlannerPrompt(AUDIO_PROMPT_PLAN_SCHEMA_ID, packetValidation.value, {
  guidance: 'Keep prompts concise but useful for text-to-audio generation.',
});
assert.strictEqual(plannerPrompt.schema.id, AUDIO_PROMPT_PLAN_SCHEMA_ID);
assert(plannerPrompt.userPrompt.includes('audioPromptPlan'), 'Planner prompt should request the audioPromptPlan shape.');
assert(/text prompts only/i.test(plannerPrompt.systemPrompt + plannerPrompt.userPrompt), 'Planner prompt should keep generation out of scope.');

const responseFormat = buildPlanningSchemaStructuredOutputRequest(AUDIO_PROMPT_PLAN_SCHEMA_ID);
assert.strictEqual(responseFormat.type, 'json_schema', 'Audio planner should expose a structured JSON schema request.');
assert.strictEqual(responseFormat.schema.properties.kind.enum[0], 'audioPromptPlan');
assert.strictEqual(responseFormat.schema.properties.sections.items.properties.energy.enum.includes('high'), true, 'Audio planner JSON schema should constrain section energy.');
assert(responseFormat.schema.properties.sections.items.properties.prompt, 'Audio planner JSON schema should include per-section prompt text.');

const geminiConfig = buildGoogleGenerationConfig(
  { id: 'google', configuration: { maxOutputTokens: 1024 } },
  { maxOutputTokens: 4096, responseFormat },
);
assert.strictEqual(geminiConfig.responseMimeType, 'application/json', 'Gemini planner calls should request JSON output.');
assert.strictEqual(geminiConfig.maxOutputTokens, 4096, 'Planner structured output should use the requested output budget.');
assert.strictEqual(geminiConfig.responseJsonSchema.properties.kind.enum[0], 'audioPromptPlan', 'Gemini planner calls should include the audioPromptPlan JSON schema.');

const openAiResponseFormat = buildOpenAiResponseFormat({ responseFormat });
assert.strictEqual(openAiResponseFormat.type, 'json_schema', 'OpenAI planner calls should use JSON schema response format when supported.');
assert.strictEqual(openAiResponseFormat.json_schema.strict, true, 'OpenAI planner JSON schema requests should stay strict.');
assert.strictEqual(openAiResponseFormat.json_schema.schema.properties.sections.items.properties.energy.enum.includes('medium'), true, 'OpenAI planner schema should preserve audio section constraints.');

const collectionItems = buildPlanTextCollectionItems(goodValidation.value, {
  sourcePlan: {
    sourcePacket: packetValidation.value,
  },
});
assert.deepStrictEqual(collectionItems.map((entry) => entry.text), goodAudioPlan.sections.map((entry) => entry.prompt));
assert.strictEqual(collectionItems[0].displayName, 'intro');
assert.strictEqual(collectionItems[0].metadata.audioPromptPlan.section.durationSeconds, 20);
assert.strictEqual(collectionItems[0].metadata.audioPromptPlan.negativePrompt, 'upbeat pop drums, vocals, cheerful melody');
assert.strictEqual(collectionItems[0].metadata.audioPromptPlan.lineage.planKind, 'audioPromptPlan');
assert(/90-second dark fantasy battle theme/i.test(collectionItems[0].metadata.audioPromptPlan.lineage.sourceIdea), 'Collection item metadata should preserve source idea lineage.');

const collection = createArtifactCollection(collectionItems.map((item) => ({
  artifact: createTextArtifact(item.text, { displayName: item.displayName }),
  itemId: item.itemId,
  metadata: item.metadata,
})), { itemKind: 'text', displayName: 'Audio prompt collection' });
assert.strictEqual(collection.itemKind, 'text');
assert.strictEqual(collection.items.length, 2);
assert.strictEqual(collection.items[1].metadata.audioPromptPlan.section.name, 'climax');
assert.strictEqual(collection.items[1].metadata.audioPromptPlan.section.durationSeconds, 40);

const review = buildPlanReviewDocument(goodValidation.value);
assert.strictEqual(review.structuralValidation.ok, true);
assert.strictEqual(review.sectionCount, 2);

const sceneValidation = validatePlanAgainstSchema('longformMedia.scenePlan.v1', {
  title: 'Scene plan still works',
  overview: {
    meaningIntent: 'Show the story setup.',
    viewerTakeaway: 'The stakes are clear.',
    narrativeArc: 'Open, build, resolve.',
    toneStrategy: 'Grounded and cinematic.',
  },
  scenes: [{
    sceneId: 'scene-1',
    sourceSpanLabel: 'Opening',
    meaningIntent: 'Introduce the setting.',
    viewerTakeaway: 'The world feels lived in.',
    sceneConcept: 'A protagonist enters a quiet room.',
    treatmentApproach: 'Keep the camera simple and grounded.',
    visualPromptDraft: 'Grounded cinematic room, practical light, clear protagonist silhouette, restrained detail.',
  }],
});
assert.strictEqual(sceneValidation.ok, true, sceneValidation.errors.join('; '));

const schemaOptions = getPlanningSchemaOptions();
assert(schemaOptions.some((schema) => schema.id === AUDIO_PROMPT_PLAN_SCHEMA_ID), 'Planning schema options should expose audioPromptPlan.');
assert(schemaOptions.some((schema) => schema.id === 'longformMedia.scenePlan.v1'), 'Planning schema options should keep longform scene planning.');

console.log('Verified audio prompt planning schema and text collection conversion.');
