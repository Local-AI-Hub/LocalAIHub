const assert = require('assert');

const {
  VIDEO_PROMPT_PLAN_SCHEMA_ID,
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

const goodVideoPlan = {
  schemaVersion: 1,
  kind: 'videoPromptPlan',
  title: 'Abandoned space station sequence',
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
    {
      index: 2,
      name: 'Docking approach',
      durationSeconds: 8,
      prompt: 'continue toward the damaged docking bay of the same abandoned space station, warning lights pulsing softly, camera gliding forward through drifting frost particles',
      negativePrompt: 'abrupt cut, mismatched station design, noisy flicker, text artifacts',
      cameraMotion: 'steady forward glide into the docking bay',
      subjectMotion: 'frost particles drift past camera and warning lights pulse',
      setting: 'same damaged docking ring and exterior hull',
      action: 'the docking doors loom closer as the camera enters shadow',
      referenceMode: 'previousClipLastFrame',
      referenceFrameRole: 'previousClipLastFrame',
      needsInitialReferenceImage: false,
      usesPreviousClipLastFrame: true,
      continuityNotes: 'continue from the previous clip last frame while preserving the same station silhouette, color palette, and orbital direction',
      transitionNotes: 'match cut from the docking ring crossing frame',
      sourceText: 'Create a 30-second moody sci-fi establishing sequence of an abandoned space station.',
    },
  ],
  notes: 'Planning-only prompt clips for downstream video generation.',
};

const goodValidation = validatePlanAgainstSchema(VIDEO_PROMPT_PLAN_SCHEMA_ID, goodVideoPlan);
assert.strictEqual(goodValidation.ok, true, goodValidation.errors.join('; '));
assert.strictEqual(goodValidation.value.kind, 'videoPromptPlan');
assert.strictEqual(goodValidation.value.clips.length, 2);
assert.strictEqual(goodValidation.value.clips[1].usesPreviousClipLastFrame, true);

const badValidation = validatePlanAgainstSchema(VIDEO_PROMPT_PLAN_SCHEMA_ID, {
  kind: 'videoPromptPlan',
  title: 'Broken video plan',
  overallStyle: 'cinematic',
  clips: [{ name: 'clip', durationSeconds: 0, prompt: '', cameraMotion: '', subjectMotion: '' }],
});
assert.strictEqual(badValidation.ok, false, 'Invalid video prompt plans should fail validation.');
assert(badValidation.errors.some((entry) => /prompt/i.test(entry)), 'Missing prompt should be reported clearly.');
assert(badValidation.errors.some((entry) => /durationSeconds/i.test(entry)), 'Invalid duration should be reported clearly.');

const sourceIdea = 'Create a 30-second moody sci-fi establishing sequence of an abandoned space station.';
const packet = buildPlanningPacketDocument({
  schemaId: VIDEO_PROMPT_PLAN_SCHEMA_ID,
  title: 'Video concept planning packet',
  goal: sourceIdea,
  constraintsText: 'Plan text prompts only. Do not generate video, run image-to-video, or extract last frames.',
  desiredOutputNotes: 'Return ordered videoPromptPlan clips with durations, motion, continuity, and reference-frame metadata.',
}, [createTextArtifact(sourceIdea, { displayName: 'Video concept' })]);
const packetValidation = validatePlanningPacketShape(packet);
assert.strictEqual(packetValidation.ok, true, packetValidation.errors.join('; '));
assert.strictEqual(packetValidation.value.schemaId, VIDEO_PROMPT_PLAN_SCHEMA_ID);
assert.strictEqual(packetValidation.value.desiredOutput.schemaId, VIDEO_PROMPT_PLAN_SCHEMA_ID);

const plannerPrompt = buildPlannerPrompt(VIDEO_PROMPT_PLAN_SCHEMA_ID, packetValidation.value, {
  guidance: 'Make clip prompts motion-first and keep reference-frame intent explicit.',
});
assert.strictEqual(plannerPrompt.schema.id, VIDEO_PROMPT_PLAN_SCHEMA_ID);
assert(plannerPrompt.userPrompt.includes('videoPromptPlan'), 'Planner prompt should request the videoPromptPlan shape.');
assert(/camera motion|subject motion|reference-frame/i.test(plannerPrompt.schema.promptSummary + plannerPrompt.userPrompt), 'Planner prompt should include video-specific motion/reference guidance.');
assert(/do not claim to generate video/i.test(plannerPrompt.systemPrompt), 'Planner system prompt should keep generation out of scope.');

const responseFormat = buildPlanningSchemaStructuredOutputRequest(VIDEO_PROMPT_PLAN_SCHEMA_ID);
assert.strictEqual(responseFormat.type, 'json_schema', 'Video planner should expose a structured JSON schema request.');
assert.strictEqual(responseFormat.schema.properties.kind.enum[0], 'videoPromptPlan');
assert.strictEqual(responseFormat.schema.properties.clips.items.properties.referenceMode.enum.includes('previousClipLastFrame'), true, 'Video planner JSON schema should constrain reference modes.');
assert(responseFormat.schema.properties.clips.items.properties.cameraMotion, 'Video planner JSON schema should include camera motion.');
assert(responseFormat.schema.properties.clips.items.properties.durationSeconds, 'Video planner JSON schema should include duration.');

const collectionItems = buildPlanTextCollectionItems(goodValidation.value, {
  sourcePlan: {
    id: 'plan-video-1',
    sourcePacket: packetValidation.value,
  },
});
assert.deepStrictEqual(collectionItems.map((entry) => entry.text), goodVideoPlan.clips.map((entry) => entry.prompt));
assert.strictEqual(collectionItems[0].displayName, 'Exterior drift');
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.clip.durationSeconds, 8);
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.clip.cameraMotion, 'steady forward glide into the docking bay');
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.clip.subjectMotion, 'frost particles drift past camera and warning lights pulse');
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.clip.action, 'the docking doors loom closer as the camera enters shadow');
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.negativePrompt, 'abrupt cut, mismatched station design, noisy flicker, text artifacts');
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.referenceMode, 'previousClipLastFrame');
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.referenceFrameRole, 'previousClipLastFrame');
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.usesPreviousClipLastFrame, true);
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.needsInitialReferenceImage, false);
assert(/abandoned space station/i.test(collectionItems[1].metadata.videoPromptPlan.lineage.sourceIdea), 'Collection item metadata should preserve source idea lineage.');
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.lineage.planKind, 'videoPromptPlan');
assert.strictEqual(collectionItems[1].metadata.videoPromptPlan.lineage.planSchemaId, VIDEO_PROMPT_PLAN_SCHEMA_ID);

const collection = createArtifactCollection(collectionItems.map((item) => ({
  artifact: createTextArtifact(item.text, { displayName: item.displayName }),
  itemId: item.itemId,
  metadata: item.metadata,
})), { itemKind: 'text', displayName: 'Video prompt collection' });
assert.strictEqual(collection.itemKind, 'text');
assert.strictEqual(collection.items.length, 2);
assert.strictEqual(collection.items[1].metadata.videoPromptPlan.clip.name, 'Docking approach');
assert.strictEqual(collection.items[1].metadata.videoPromptPlan.clip.continuityNotes.includes('previous clip last frame'), true);
assert.strictEqual(collection.items[1].metadata.videoPromptPlan.clip.transitionNotes, 'match cut from the docking ring crossing frame');
assert.strictEqual(collection.items[1].metadata.videoPromptPlan.sourceText, sourceIdea);

const review = buildPlanReviewDocument(goodValidation.value);
assert.strictEqual(review.structuralValidation.ok, true);
assert.strictEqual(review.clipCount, 2);
assert.strictEqual(review.schemaId, VIDEO_PROMPT_PLAN_SCHEMA_ID);

const schemaOptions = getPlanningSchemaOptions();
assert(schemaOptions.some((schema) => schema.id === VIDEO_PROMPT_PLAN_SCHEMA_ID), 'Planning schema options should expose videoPromptPlan.');
assert(schemaOptions.some((schema) => schema.id === 'audioPromptPlan.v1'), 'Planning schema options should keep audioPromptPlan.');
assert(schemaOptions.some((schema) => schema.id === 'longformMedia.scenePlan.v1'), 'Planning schema options should keep longform scene planning.');

console.log('Verified video prompt planning schema and text collection conversion.');
