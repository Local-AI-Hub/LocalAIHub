const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const PIPELINE_EXECUTION_SERVICE_PATH = path.join(__dirname, '..', 'electron', 'services', 'pipelineExecutionService.js');
const PROVIDER_SERVICE_PATH = path.join(__dirname, '..', 'electron', 'services', 'providerService.js');

function buildSyntheticNarration(wordTarget) {
  const words = [
    'Local', 'AI', 'Hub', 'plans', 'a', 'longer', 'slideshow', 'with', 'clear', 'timing',
    'metadata', 'for', 'ordinary', 'Windows', 'hardware', 'and', 'keeps', 'each', 'visual', 'grounded',
  ];
  const output = [];
  while (output.length < wordTarget) {
    output.push(words[output.length % words.length]);
  }
  return output.join(' ');
}

function buildTranscriptSegments(segmentCount, durationSeconds) {
  const segmentDuration = durationSeconds / segmentCount;
  return Array.from({ length: segmentCount }, (_entry, index) => {
    const start = Number((segmentDuration * index).toFixed(3));
    const end = index === segmentCount - 1
      ? durationSeconds
      : Number((segmentDuration * (index + 1)).toFixed(3));
    return {
      id: 'seg-' + String(index + 1),
      start,
      end,
      text: 'Narration segment ' + String(index + 1) + ' describes a concrete visual beat for Local AI Hub.',
    };
  });
}

function buildTopicTranscriptPacket() {
  const topics = [
    { id: 'forest', start: 0, end: 10, text: 'The path enters a dark forest with wet branches closing overhead.' },
    { id: 'witch', start: 10, end: 20, text: 'A witch laughs from a crooked porch as candle smoke curls upward.' },
    { id: 'pumpkin', start: 20, end: 30, text: 'A jack-o-lantern glows orange beside the gate while the narrator pauses.' },
    { id: 'cat', start: 30, end: 40, text: 'A black cat crosses the moonlit path and vanishes into the grass.' },
  ];
  const packet = buildPlanningPacketDocument({
    desiredOutputNotes: 'Return at least one clean imagePrompt per timed narration beat. Use fallback 10 seconds per image.',
    goal: 'Create a timing-aligned Halloween slideshow scene plan.',
    schemaId: 'longformMedia.scenePlan.v1',
  }, [{
    displayName: 'Timed Halloween transcript',
    kind: 'text',
    text: topics.map((topic) => topic.text).join(' '),
    transcription: {
      durationSeconds: 40,
      segments: topics,
    },
  }]);
  const validation = validatePlanningPacketShape(packet);
  assert.strictEqual(validation.ok, true, validation.errors[0] || 'Expected topic transcript packet to validate.');
  return validation.value;
}

const {
  buildDeterministicPlanFromPacket,
  buildPlannerPrompt,
  buildPlanTextCollectionItems,
  buildPlanningPacketDocument,
  buildPlanningSchemaStructuredOutputRequest,
  getPlanningSchemaDefinition,
  validatePlanAgainstSchema,
  validatePlanningPacketShape,
} = require('../electron/shared/planningSchema.cjs');

function getMessageText(messages = []) {
  return messages.map((message) => String(message?.content || '')).join('\n');
}

function loadPlannerExecutionInternals() {
  const source = fs.readFileSync(PIPELINE_EXECUTION_SERVICE_PATH, 'utf8')
    + '\nmodule.exports.__longformPlannerTest = { executeChunkedLongformPlanner, resolveLongformPlannerBudgetProfile, estimatePlannerChunkRequestBudget, shouldUseChunkedLongformPlanner, classifyPlannerFailure, getPlannerRateLimitWaitMs };';
  const testModule = new Module(PIPELINE_EXECUTION_SERVICE_PATH + '.longform-test', module);
  testModule.filename = PIPELINE_EXECUTION_SERVICE_PATH;
  testModule.paths = Module._nodeModulePaths(path.dirname(PIPELINE_EXECUTION_SERVICE_PATH));
  testModule._compile(source, PIPELINE_EXECUTION_SERVICE_PATH);
  return testModule.exports.__longformPlannerTest;
}

function buildChunkModelReply(sceneCount, durationSeconds, promptPrefix) {
  const count = Math.max(1, Number(sceneCount || 1) || 1);
  const duration = Math.max(1, Number(durationSeconds || 60) || 60);
  const sceneDuration = duration / count;
  const scenes = Array.from({ length: count }, (_entry, index) => {
    const start = Number((sceneDuration * index).toFixed(3));
    const end = index === count - 1 ? duration : Number((sceneDuration * (index + 1)).toFixed(3));
    return {
      sceneId: 'scene-' + String(index + 1),
      sourceSpanLabel: 'Mock chunk beat ' + String(index + 1),
      meaningIntent: 'Represent the mocked chunk beat clearly.',
      viewerTakeaway: 'The viewer follows the mocked chunk beat.',
      sceneConcept: promptPrefix + ' concept ' + String(index + 1),
      treatmentApproach: 'Use a clear grounded slideshow still.',
      narrationDraft: '',
      narrationExcerpt: promptPrefix + ' narration excerpt ' + String(index + 1),
      sourceTranscriptSegmentIds: ['seg-' + String(index + 1)],
      startSeconds: start,
      endSeconds: end,
      durationSeconds: Number((end - start).toFixed(3)),
      imagePrompt: promptPrefix + ' clean image prompt ' + String(index + 1),
      visualPromptDraft: promptPrefix + ' clean image prompt ' + String(index + 1),
      riskNotes: [],
    };
  });
  return JSON.stringify({
    title: 'Mock chunk plan',
    timing: {
      timingMode: 'transcriptSegments',
      totalDurationSeconds: duration,
      fallbackSecondsPerImage: 8,
      minimumImageCount: count,
      source: 'Mock chunk transcript',
      coverageNotes: 'Mock scenes cover this chunk.',
    },
    overview: {
      meaningIntent: 'Mock chunk planning.',
      viewerTakeaway: 'The viewer follows the chunk.',
      narrativeArc: 'Chunk-local narration order.',
      toneStrategy: 'Grounded test visuals.',
      continuityNotes: ['Keep continuity with previous chunk.'],
      riskNotes: [],
    },
    scenes,
    openQuestions: [],
  });
}

function buildTranscriptPacket(segmentCount, durationSeconds, options = {}) {
  const packet = buildPlanningPacketDocument({
    desiredOutputNotes: 'Return scenes with startSeconds, endSeconds, durationSeconds, narrationExcerpt, sourceTranscriptSegmentIds, and visualPromptDraft. Use fallback ' + String(options.fallbackSecondsPerImage || 8) + ' seconds per image if timing must be inferred.',
    goal: 'Create a timing-aware longform slideshow scene plan from the voiceover transcript.',
    schemaId: 'longformMedia.scenePlan.v1',
    stylePolicyText: 'Keep visuals grounded and easy to inspect.',
  }, [{
    displayName: 'Synthetic transcript',
    kind: 'text',
    text: buildSyntheticNarration(Math.max(120, segmentCount * 16)),
    transcription: {
      durationSeconds,
      segments: buildTranscriptSegments(segmentCount, durationSeconds),
    },
  }]);
  const validation = validatePlanningPacketShape(packet);
  assert.strictEqual(validation.ok, true, validation.errors[0] || 'Expected transcript packet to validate.');
  return validation.value;
}

function buildDenseTranscriptPacket(segmentCount, durationSeconds, options = {}) {
  const segmentDuration = durationSeconds / segmentCount;
  const wordsPerSegment = Math.max(8, Number(options.wordsPerSegment || 36) || 36);
  const segments = Array.from({ length: segmentCount }, (_entry, index) => {
    const start = Number((segmentDuration * index).toFixed(3));
    const end = index === segmentCount - 1
      ? durationSeconds
      : Number((segmentDuration * (index + 1)).toFixed(3));
    return {
      id: 'dense-seg-' + String(index + 1),
      start,
      end,
      text: 'Narration segment ' + String(index + 1) + ' explains ' + buildSyntheticNarration(wordsPerSegment) + '.',
    };
  });
  const packet = buildPlanningPacketDocument({
    desiredOutputNotes: 'Return scenes with startSeconds, endSeconds, durationSeconds, narrationExcerpt, sourceTranscriptSegmentIds, and clean imagePrompt. Use fallback ' + String(options.fallbackSecondsPerImage || 8) + ' seconds per image.',
    goal: 'Create a timing-aware longform slideshow scene plan from a dense voiceover transcript.',
    schemaId: 'longformMedia.scenePlan.v1',
    stylePolicyText: 'Keep visuals grounded and easy to inspect.',
  }, [{
    displayName: 'Dense synthetic transcript',
    kind: 'text',
    text: segments.map((segment) => segment.text).join(' '),
    transcription: {
      durationSeconds,
      segments,
    },
  }]);
  const validation = validatePlanningPacketShape(packet);
  assert.strictEqual(validation.ok, true, validation.errors[0] || 'Expected dense transcript packet to validate.');
  return validation.value;
}

function buildMockPromptMessages(promptPacket, guidance = '') {
  const plannerPrompt = buildPlannerPrompt('longformMedia.scenePlan.v1', promptPacket, {
    compact: true,
    guidance,
  });
  const messages = [
    { role: 'system', content: plannerPrompt.systemPrompt },
    { role: 'user', content: plannerPrompt.userPrompt },
  ];
  return {
    messages,
    promptStats: {
      ...plannerPrompt.promptStats,
      requestCharacters: getMessageText(messages).length,
    },
  };
}

function getChunkDurationFromMessageText(messageText) {
  const match = String(messageText || '').match(/\\?"chunkDurationSeconds\\?":\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 60;
}

function getChunkMinimumFromMessageText(messageText) {
  const match = String(messageText || '').match(/chunkMinimumImageCount=(\d+)/);
  return match ? Number(match[1]) : 1;
}
function verifyPromptCompaction() {
  const packet = buildTranscriptPacket(180, 300);
  const compactPrompt = buildPlannerPrompt('longformMedia.scenePlan.v1', packet, { compact: true });
  const fullPrompt = buildPlannerPrompt('longformMedia.scenePlan.v1', packet, { compact: false });
  assert(compactPrompt.userPrompt.length < fullPrompt.userPrompt.length, 'Expected compact planner prompt to be smaller than the full prompt.');
  assert(compactPrompt.userPrompt.length < 24000, 'Expected compact longform planner prompt to stay bounded.');
  assert(/plannerCompaction/.test(compactPrompt.userPrompt), 'Expected compact prompt to disclose transcript segment grouping.');
  assert(/fallback seconds per image|fallback 8 seconds per image/i.test(compactPrompt.userPrompt), 'Expected prompt to preserve fallback seconds per image guidance.');
  assert(/minimumImageCount/i.test(compactPrompt.userPrompt), 'Expected longform planner prompt to include computed minimumImageCount guidance.');
  assert(/at least minimumImageCount scenes/i.test(compactPrompt.userPrompt), 'Expected longform planner prompt to make minimum scene count a hard requirement.');
}

function verifyDeterministicTimedFallback() {
  const packet = buildTranscriptPacket(60, 120, { fallbackSecondsPerImage: 8 });
  const fallbackPlan = buildDeterministicPlanFromPacket('longformMedia.scenePlan.v1', packet, {
    reason: 'Verification forced invalid planner JSON.',
  });
  const validation = validatePlanAgainstSchema('longformMedia.scenePlan.v1', fallbackPlan);
  assert.strictEqual(validation.ok, true, validation.errors[0] || 'Expected fallback plan to validate.');
  const plan = validation.value;
  const expectedMinimumImageCount = Math.ceil(120 / 8);
  assert.strictEqual(plan.timing.minimumImageCount, expectedMinimumImageCount, 'Expected fallback timing metadata to record ceil(duration / fallback seconds per image).');
  assert(plan.scenes.length >= expectedMinimumImageCount, 'Expected 2 minute narration to meet the deterministic minimum image count.');
  assert(plan.scenes.length <= 20, 'Expected 2 minute narration scene count to stay bounded.');
  assertSceneTimelineCovers(plan, 120);
  assert(plan.scenes.some((scene) => scene.sourceTranscriptSegmentIds.length > 1), 'Expected fallback scenes to carry transcript segment ids.');

  const collectionItems = buildPlanTextCollectionItems(plan);
  assert.strictEqual(collectionItems.length, plan.scenes.length, 'Expected one collection item per fallback scene.');
  assert.strictEqual(collectionItems[0].metadata.timingMode, 'dynamicFromPlanTiming', 'Expected Plan Scenes metadata to preserve dynamic timing mode.');
  assert(collectionItems[0].metadata.narrationExcerpt, 'Expected collection metadata to preserve narration excerpts.');
  assert.strictEqual(collectionItems[0].text, collectionItems[0].metadata.imagePrompt, 'Expected text collection items to expose only the clean image prompt.');
  assert(!/Meaning\s*\/\s*intent|Viewer takeaway|Narration excerpt|Source transcript segments/i.test(collectionItems[0].text), 'Expected image prompt text to exclude scene-plan metadata labels.');
}

function assertSceneTimelineCovers(plan, expectedDurationSeconds) {
  assert(Array.isArray(plan.scenes) && plan.scenes.length, 'Expected plan to contain scenes.');
  assert.strictEqual(plan.scenes[0].startSeconds, 0, 'Expected repaired scene timeline to start at zero.');
  const lastScene = plan.scenes[plan.scenes.length - 1];
  assert.strictEqual(lastScene.endSeconds, expectedDurationSeconds, 'Expected repaired scene timeline to cover the full narration duration.');
  plan.scenes.forEach((scene, index) => {
    assert(Number(scene.durationSeconds) > 0, 'Expected repaired scene durations to remain positive.');
    assert(scene.narrationExcerpt, 'Expected repaired scene to preserve a narration excerpt.');
    assert(Array.isArray(scene.sourceTranscriptSegmentIds) && scene.sourceTranscriptSegmentIds.length, 'Expected repaired scene to preserve transcript segment ids.');
    if (index > 0) {
      const previous = plan.scenes[index - 1];
      assert(Number(scene.startSeconds) >= Number(previous.startSeconds), 'Expected repaired scene starts to stay ordered.');
      assert(Number(scene.startSeconds) <= Number(previous.endSeconds) + 0.001, 'Expected repaired scene timeline not to introduce gaps.');
    }
  });
}

function verifyMinimumImageCountRepair() {
  const tooSmallPlan = {
    schemaId: 'longformMedia.scenePlan.v1',
    title: 'Too-small model plan',
    timing: {
      fallbackSecondsPerImage: 8,
      timingMode: 'transcriptSegments',
      totalDurationSeconds: 110,
    },
    overview: {
      meaningIntent: 'Verify deterministic repair of model plans with too few scenes.',
      narrativeArc: 'Start, middle, and final beat.',
      toneStrategy: 'Clear and grounded.',
      viewerTakeaway: 'The repaired plan should cover the narration without dropping timing metadata.',
    },
    scenes: [
      {
        meaningIntent: 'Open the topic.',
        narrationExcerpt: 'Opening narration excerpt.',
        sceneConcept: 'A grounded opening visual.',
        treatmentApproach: 'Use a clear documentary-style still.',
        sourceTranscriptSegmentIds: ['seg-1', 'seg-2'],
        startSeconds: 0,
        endSeconds: 55,
        durationSeconds: 55,
        viewerTakeaway: 'The viewer understands the setup.',
        visualPromptDraft: 'Opening visual prompt.',
      },
      {
        meaningIntent: 'Resolve the topic.',
        narrationExcerpt: 'Closing narration excerpt.',
        sceneConcept: 'A grounded closing visual.',
        treatmentApproach: 'Use a clear documentary-style still.',
        sourceTranscriptSegmentIds: ['seg-3', 'seg-4'],
        startSeconds: 55,
        endSeconds: 110,
        durationSeconds: 55,
        viewerTakeaway: 'The viewer understands the close.',
        visualPromptDraft: 'Closing visual prompt.',
      },
    ],
  };
  const validation = validatePlanAgainstSchema('longformMedia.scenePlan.v1', tooSmallPlan);
  assert.strictEqual(validation.ok, true, validation.errors[0] || 'Expected too-small model plan to validate after repair.');
  const repairedPlan = validation.value;
  const expectedMinimum = Math.ceil(110 / 8);
  assert.strictEqual(repairedPlan.timing.minimumImageCount, expectedMinimum, 'Expected repaired model plan to record ceil(duration / fallback seconds per image).');
  assert.strictEqual(repairedPlan.scenes.length, expectedMinimum, 'Expected too-small model plan to repair up to the minimum image count.');
  assert(/minimum image count/.test(repairedPlan.timing.coverageNotes || ''), 'Expected repaired model plan to explain the minimum-count repair.');
  assertSceneTimelineCovers(repairedPlan, 110);
}

function verifyCleanPromptSeparationAndSemanticRepair() {
  const packet = buildTopicTranscriptPacket();
  const tooShortRichPlan = {
    schemaId: 'longformMedia.scenePlan.v1',
    title: 'Too-short rich scene plan',
    timing: {
      fallbackSecondsPerImage: 10,
      timingMode: 'transcriptSegments',
      totalDurationSeconds: 40,
    },
    overview: {
      meaningIntent: 'Keep Halloween beats aligned to narration timing.',
      narrativeArc: 'Forest, witch, jack-o-lantern, cat.',
      toneStrategy: 'Clear spooky slideshow imagery.',
      viewerTakeaway: 'Each narrated topic should appear when discussed.',
    },
    scenes: [
      {
        meaningIntent: 'Set up the path and witch.',
        narrationExcerpt: 'The path enters a dark forest. A witch laughs.',
        sceneConcept: 'A broad Halloween opening scene.',
        treatmentApproach: 'Readable spooky composition.',
        sourceTranscriptSegmentIds: ['forest', 'witch'],
        startSeconds: 0,
        endSeconds: 20,
        durationSeconds: 20,
        viewerTakeaway: 'The story enters a haunted place.',
        visualPromptDraft: 'Dark forest and witch porch, spooky practical lighting.',
        riskNotes: ['Opening combines two timed topics.'],
      },
      {
        meaningIntent: 'Resolve with pumpkin and cat.',
        narrationExcerpt: 'A jack-o-lantern glows. A black cat crosses the path.',
        sceneConcept: 'A broad Halloween closing scene.',
        treatmentApproach: 'Readable spooky composition.',
        sourceTranscriptSegmentIds: ['pumpkin', 'cat'],
        startSeconds: 20,
        endSeconds: 40,
        durationSeconds: 20,
        viewerTakeaway: 'The story closes with iconic Halloween beats.',
        visualPromptDraft: 'Jack-o-lantern and black cat, moonlit path.',
        riskNotes: ['Closing combines two timed topics.'],
      },
    ],
  };

  const validation = validatePlanAgainstSchema('longformMedia.scenePlan.v1', tooShortRichPlan, { sourcePacket: packet });
  assert.strictEqual(validation.ok, true, validation.errors[0] || 'Expected too-short rich plan to validate after semantic repair.');
  const repairedPlan = validation.value;
  assert.strictEqual(repairedPlan.timing.minimumImageCount, 4, 'Expected computed minimum image count to be recorded.');
  assert.strictEqual(repairedPlan.scenes.length, 4, 'Expected model plan with too few scenes to repair upward.');
  assertSceneTimelineCovers(repairedPlan, 40);
  assert.deepStrictEqual(repairedPlan.scenes.map((scene) => scene.sourceTranscriptSegmentIds[0]), ['forest', 'witch', 'pumpkin', 'cat'], 'Expected repair to preserve transcript segment ids in source order.');
  assert(/dark forest/i.test(repairedPlan.scenes[0].narrationExcerpt), 'Expected first repaired scene to use the dark forest transcript excerpt.');
  assert(/witch laughs/i.test(repairedPlan.scenes[1].narrationExcerpt), 'Expected second repaired scene to use the witch transcript excerpt.');
  assert(/jack-o-lantern/i.test(repairedPlan.scenes[2].narrationExcerpt), 'Expected jack-o-lantern narration to remain in its timed scene.');
  assert(/black cat/i.test(repairedPlan.scenes[3].imagePrompt), 'Expected repaired imagePrompt to reflect the black cat timed narration.');

  const collectionItems = buildPlanTextCollectionItems(repairedPlan, { sourcePacket: packet });
  assert.strictEqual(collectionItems[2].text, collectionItems[2].metadata.imagePrompt, 'Expected collection text to be clean imagePrompt only.');
  assert(/jack-o-lantern/i.test(collectionItems[2].text), 'Expected jack-o-lantern prompt to align with the jack-o-lantern segment.');
  assert(!/meaning|viewer takeaway|narrative|risk notes|source transcript/i.test(collectionItems[2].text), 'Expected prompt text not to serialize scene metadata.');
  assert(/Resolve with pumpkin and cat/.test(collectionItems[2].metadata.meaningIntent), 'Expected metadata to preserve meaning/intent fields.');
}

function verifyProviderStructuredOutputPaths() {
  const providerSource = fs.readFileSync(PROVIDER_SERVICE_PATH, 'utf8');
  assert(/provider\.id === 'groq'[\s\S]*type:\s*'json_object'/.test(providerSource), 'Expected Groq planner requests to ask for JSON mode on the OpenAI-compatible chat path.');
  const responseFormat = buildPlanningSchemaStructuredOutputRequest('longformMedia.scenePlan.v1');
  assert.strictEqual(responseFormat.type, 'json_schema', 'Expected longform planning schemas to expose structured JSON schema requests.');
  assert(responseFormat.schema.properties.scenes.items.properties.startSeconds, 'Expected longform schema to include scene timing fields.');
  assert(responseFormat.schema.properties.timing.properties.minimumImageCount, 'Expected longform schema to expose minimum image count metadata.');
}

function verifyExecutionFallbackAndRepairSource() {
  const executionSource = fs.readFileSync(PIPELINE_EXECUTION_SERVICE_PATH, 'utf8');
  assert(/estimatePlannerMaxOutputTokens/.test(executionSource), 'Expected planner execution to estimate output budget for longform plans.');
  assert(/buildDeterministicPlanFromPacket/.test(executionSource), 'Expected planner execution to use deterministic fallback when model JSON is unusable.');
  assert(/parsePlannerReplyDetailed[\s\S]*catch[\s\S]*buildDeterministicPlanFromPacket/.test(executionSource), 'Expected invalid planner JSON to fall back through deterministic longform planning.');
}

function verifyChunkedPlannerSource() {
  const executionSource = fs.readFileSync(PIPELINE_EXECUTION_SERVICE_PATH, 'utf8');
  assert(/LONGFORM_CHUNKED_PLANNER_THRESHOLD_SECONDS\s*=\s*60/.test(executionSource), 'Expected longform chunking threshold to be 60 seconds.');
  assert(/LONGFORM_CHUNK_TARGET_DURATION_SECONDS\s*=\s*60/.test(executionSource), 'Expected target chunk duration to be 60 seconds.');
  assert(/LONGFORM_CHUNK_MAX_DURATION_SECONDS\s*=\s*90/.test(executionSource), 'Expected max chunk duration to be 90 seconds.');
  assert(/LONGFORM_CHUNK_CONTEXT_OVERLAP_SECONDS\s*=\s*5/.test(executionSource), 'Expected chunk context overlap to be 5 seconds.');
  assert(/shouldUseChunkedLongformPlanner/.test(executionSource), 'Expected Planner node to choose chunked mode for longform transcript packets.');
  assert(/plannerMode:\s*'singleShot'/.test(executionSource), 'Expected diagnostics to record single-shot planner mode.');
  assert(/plannerMode:\s*'chunked'/.test(executionSource), 'Expected diagnostics to record chunked planner mode.');
  assert(/executeChunkedLongformPlanner/.test(executionSource), 'Expected dedicated chunked longform planner execution.');
  assert(/buildLongformGlobalSummary/.test(executionSource), 'Expected chunked planning to build a compact global summary.');
  assert(/Compact global summary \/ visual continuity packet/.test(executionSource), 'Expected global summary packet to be included with each chunk.');
  assert(/Do not duplicate overlap\/context segments as output scenes/.test(executionSource), 'Expected chunk prompt to prevent duplicated overlap scenes.');
  assert(/Return at least chunkMinimumImageCount scenes/.test(executionSource), 'Expected each chunk prompt to carry a hard chunk minimum image count.');
  assert(/Local AI Hub will offset them back to the full narration timeline/.test(executionSource), 'Expected chunk plans to use relative timing that is offset during merge.');
  assert(/reconcileMergedLongformScenes/.test(executionSource), 'Expected deterministic merge and timeline reconciliation.');
  assert(/validatePlanAgainstSchema\(schemaId, mergedPlan, \{ sourcePacket: packet \}\)/.test(executionSource), 'Expected merged chunk plans to be schema-validated with the original packet.');
  assert(/buildDeterministicPlanFromPacket\(schemaId, chunkPacket/.test(executionSource), 'Expected deterministic fallback to apply only to failed chunks.');
  assert(/chunkFailures/.test(executionSource), 'Expected planner metadata to record chunk failures.');
  assert(/jsonRepairAttempted/.test(executionSource), 'Expected planner metadata to record JSON repair attempts.');
  assert(/retryAttempted/.test(executionSource), 'Expected planner metadata to record retry attempts.');
  assert(/deterministicFallbackUsed/.test(executionSource), 'Expected planner metadata to record deterministic fallback usage.');
  assert(/chunksPlanned/.test(executionSource), 'Expected planner metadata to record planned chunk count.');
  assert(/adaptiveChunkingEnabled/.test(executionSource), 'Expected planner metadata to record adaptive chunking enablement.');
  assert(/plannerBudgetProfile/.test(executionSource), 'Expected planner metadata to record the provider\/model budget profile.');
  assert(/chosenChunkDurationsSeconds/.test(executionSource), 'Expected planner metadata to record chosen chunk durations.');
  assert(/chunksSplitDueToBudget/.test(executionSource), 'Expected planner metadata to record budget-driven splits.');
  assert(/chunksSplitAfterRequestTooLarge/.test(executionSource), 'Expected planner metadata to record request-too-large splits.');
  assert(/rollingContextCharacters/.test(executionSource), 'Expected planner metadata to record rolling context size.');
  assert(/instructionSchemaCharacters/.test(executionSource), 'Expected planner metadata to record instruction and schema size.');
  assert(/actualProviderErrorCategory/.test(executionSource), 'Expected planner metadata to record provider error categories.');
  assert(/contextProfileId/.test(executionSource), 'Expected planner metadata to record context compaction profile.');
  assert(/request-too-large/.test(executionSource), 'Expected planner diagnostics to distinguish oversized requests.');
  assert(/provider-overload/.test(executionSource), 'Expected planner diagnostics to distinguish provider overload or high demand.');
  assert(/rate-limit/.test(executionSource), 'Expected planner diagnostics to distinguish rate limits.');
  assert(/quota/.test(executionSource), 'Expected planner diagnostics to distinguish quota limits.');
  assert(/output-token-limit/.test(executionSource), 'Expected planner diagnostics to distinguish output token limits.');
  assert(/missing-image-prompt/.test(executionSource), 'Expected planner diagnostics to distinguish missing image prompts.');
  assert(/missing-timing-fields/.test(executionSource), 'Expected planner diagnostics to distinguish missing timing fields.');
  assert(/provider-schema-unsupported/.test(executionSource), 'Expected planner diagnostics to distinguish unsupported JSON/schema modes.');
}

function verifyLongDurationFallbackScaling() {
  const fiveMinutePacket = buildTranscriptPacket(150, 300, { fallbackSecondsPerImage: 8 });
  const fiveMinutePlan = buildDeterministicPlanFromPacket('longformMedia.scenePlan.v1', fiveMinutePacket, {
    reason: 'Verification fallback for five minute transcript.',
  });
  assert.strictEqual(fiveMinutePlan.timing.minimumImageCount, Math.ceil(300 / 8), 'Expected five minute fallback to record the global minimum image count.');
  assert(fiveMinutePlan.scenes.length >= Math.ceil(300 / 8), 'Expected five minute fallback to meet minimum image count.');
  assertSceneTimelineCovers(fiveMinutePlan, 300);

  const thirtyMinutePacket = buildTranscriptPacket(900, 1800, { fallbackSecondsPerImage: 8 });
  const thirtyMinutePlan = buildDeterministicPlanFromPacket('longformMedia.scenePlan.v1', thirtyMinutePacket, {
    reason: 'Verification fallback for thirty minute transcript.',
  });
  assert.strictEqual(thirtyMinutePlan.timing.minimumImageCount, Math.ceil(1800 / 8), 'Expected thirty minute fallback to record the global minimum image count.');
  assert(thirtyMinutePlan.scenes.length >= Math.ceil(1800 / 8), 'Expected thirty minute fallback to meet minimum image count.');
  assertSceneTimelineCovers(thirtyMinutePlan, 1800);
}

async function verifyChunkedPlannerWithMockedProvider() {
  const { executeChunkedLongformPlanner } = loadPlannerExecutionInternals();
  assert.strictEqual(typeof executeChunkedLongformPlanner, 'function', 'Expected test harness to load the chunked planner executor.');
  const packet = buildTranscriptPacket(24, 120, { fallbackSecondsPerImage: 8 });
  const schema = getPlanningSchemaDefinition('longformMedia.scenePlan.v1');
  const providerCalls = [];
  const buildPromptMessages = (promptPacket, guidance = '') => {
    const plannerPrompt = buildPlannerPrompt('longformMedia.scenePlan.v1', promptPacket, {
      compact: true,
      guidance,
    });
    const messages = [
      { role: 'system', content: plannerPrompt.systemPrompt },
      { role: 'user', content: plannerPrompt.userPrompt },
    ];
    return {
      messages,
      promptStats: {
        ...plannerPrompt.promptStats,
        requestCharacters: getMessageText(messages).length,
      },
    };
  };
  const sendPlannerRequest = async (messages, retry = false) => {
    const messageText = getMessageText(messages);
    providerCalls.push({ messageText, retry });
    assert(/Compact global summary \/ visual continuity packet/.test(messageText), 'Expected every chunk provider call to include the compact global summary.');
    assert(!/Narration segment 24 describes/.test(messageText), 'Expected chunk provider calls not to repeat the full transcript.');
    assert(/chunkMinimumImageCount=8/.test(messageText), 'Expected each 60 second chunk to receive its minimum image count.');
    if (/"chunkIndex":2/.test(messageText)) {
      return 'not valid json';
    }
    return buildChunkModelReply(8, 60, 'first chunk model');
  };

  const result = await executeChunkedLongformPlanner({
    buildPromptMessages,
    fallbackSecondsPerImage: 8,
    model: 'mock-longform-planner',
    node: { id: 'planner-node', label: 'Mock chunked planner' },
    packet,
    plannerGuidance: 'Mocked provider chunk planning test.',
    providerId: 'mock',
    providerLabel: 'Mock Provider',
    reportProgress: () => {},
    schema,
    schemaId: 'longformMedia.scenePlan.v1',
    sendPlannerRequest,

  });

  assert(providerCalls.length >= 3, 'Expected first chunk plus failed second chunk retry calls.');
  assert.strictEqual(result.diagnostics.plannerMode, 'chunked', 'Expected mocked longform execution to use chunked mode.');
  assert.strictEqual(result.diagnostics.chunksPlanned, 2, 'Expected 2 minute transcript to plan in two chunks.');
  assert.strictEqual(result.diagnostics.chunkFailures.length, 1, 'Expected only the failed chunk to fall back.');
  assert.strictEqual(result.diagnostics.deterministicFallbackUsed, true, 'Expected deterministic fallback to be recorded for the failed chunk.');
  assert.strictEqual(result.diagnostics.retryAttempted, true, 'Expected failed chunk to retry once before fallback.');
  assert(result.normalizedPlan.scenes.length >= Math.ceil(120 / 8), 'Expected merged chunk plan to meet the global minimum image count.');
  assertSceneTimelineCovers(result.normalizedPlan, 120);
  assert(result.normalizedPlan.scenes.some((scene) => /first chunk model/i.test(scene.imagePrompt)), 'Expected successful chunk model scenes to remain in the merged plan.');
  assert(result.normalizedPlan.scenes.some((scene) => /Narration segment 13/i.test(scene.imagePrompt)), 'Expected failed second chunk fallback to derive prompts from its own transcript range.');
}

async function runAdaptivePlannerMock(options = {}) {
  const { executeChunkedLongformPlanner } = loadPlannerExecutionInternals();
  const packet = options.packet || buildTranscriptPacket(24, 120, { fallbackSecondsPerImage: 8 });
  const schema = getPlanningSchemaDefinition('longformMedia.scenePlan.v1');
  const providerCalls = [];
  const sendPlannerRequest = options.sendPlannerRequest || (async (messages, retry = false) => {
    const messageText = getMessageText(messages);
    providerCalls.push({ messageText, retry });
    const duration = getChunkDurationFromMessageText(messageText);
    const minimum = getChunkMinimumFromMessageText(messageText);
    return buildChunkModelReply(minimum, duration, options.promptPrefix || 'adaptive chunk model');
  });
  const result = await executeChunkedLongformPlanner({
    buildPromptMessages: buildMockPromptMessages,
    fallbackSecondsPerImage: 8,
    model: options.model || 'mock-longform-planner',
    node: { id: 'planner-node', label: 'Mock adaptive planner' },
    packet,
    plannerGuidance: 'Mocked adaptive provider chunk planning test.',
    providerId: options.providerId || 'mock',
    providerLabel: options.providerLabel || 'Mock Provider',
    providerMetadata: options.providerMetadata || null,
    reportProgress: () => {},
    enablePlannerRateLimitBackoff: Boolean(options.enablePlannerRateLimitBackoff),
    rateLimitBackoffMsOverride: Number(options.rateLimitBackoffMsOverride || 0) || 0,
    rateLimitBackoffMaxRetries: Number(options.rateLimitBackoffMaxRetries || 0) || undefined,
    schema,
    schemaId: 'longformMedia.scenePlan.v1',
    sendPlannerRequest,

  });
  return { providerCalls, result };
}

async function verifyAdaptiveChunkSizingBudgets() {
  const packet = buildDenseTranscriptPacket(48, 120, { fallbackSecondsPerImage: 8, wordsPerSegment: 26 });
  const gemini = await runAdaptivePlannerMock({
    packet,
    providerId: 'google',
    providerLabel: 'Google',
    model: 'models/gemini-2.5-flash',
    promptPrefix: 'gemini adaptive model',
  });
  assert.strictEqual(gemini.result.diagnostics.plannerBudgetProfile.profileId, 'gemini-2.5-flash-large', 'Expected Gemini Flash to use the larger planner budget profile.');
  assert.strictEqual(gemini.result.diagnostics.selectedTargetDurationSeconds, 60, 'Expected Gemini-like planner to keep normal 60 second chunks.');
  assert(gemini.result.diagnostics.chosenChunkDurationsSeconds.every((duration) => duration <= 60), 'Expected Gemini chunk durations to stay at or below the normal target.');

  const groq = await runAdaptivePlannerMock({
    packet,
    providerId: 'groq',
    providerLabel: 'Groq',
    model: 'openai/gpt-oss-120b',
    promptPrefix: 'groq adaptive model',
  });
  assert.strictEqual(groq.result.diagnostics.plannerBudgetProfile.profileId, 'groq-gpt-oss-120b-constrained', 'Expected Groq GPT-OSS-120B to use the constrained budget profile.');
  assert(groq.result.diagnostics.selectedTargetDurationSeconds < 60, 'Expected constrained Groq-like planner to choose smaller chunks for the same transcript.');
  assert(groq.result.diagnostics.chunksPlanned > gemini.result.diagnostics.chunksPlanned, 'Expected Groq-like chunking to produce more chunks than Gemini for the same transcript.');
  assert(groq.result.diagnostics.chunkDiagnostics.every((entry) => entry.estimatedTotalTokens <= entry.plannerBudgetTokens), 'Expected estimated Groq chunk requests to stay under the modeled budget.');
  assert(groq.result.diagnostics.chunksSplitDueToBudget > 0, 'Expected metadata to record budget-driven chunk splitting.');
  assert(Array.isArray(groq.result.diagnostics.adaptiveChunkingAttempts) && groq.result.diagnostics.adaptiveChunkingAttempts.length > 1, 'Expected metadata to record adaptive chunking attempts.');
}

async function verifyRollingContextBoundedAcrossLaterChunks() {
  const packet = buildDenseTranscriptPacket(48, 120, { fallbackSecondsPerImage: 8, wordsPerSegment: 26 });
  const { result } = await runAdaptivePlannerMock({
    packet,
    providerId: 'groq',
    providerLabel: 'Groq',
    model: 'openai/gpt-oss-120b',
    promptPrefix: 'bounded rolling context model',
  });
  const laterChunks = result.diagnostics.chunkDiagnostics.slice(1);
  assert(laterChunks.length > 1, 'Expected multiple later chunks for bounded context verification.');
  assert(laterChunks.every((entry) => entry.previousPromptCharacters <= 3 * 160), 'Expected later chunks to keep only the bounded last three image prompts.');
  assert(laterChunks.every((entry) => entry.previousChunkSummaryCharacters <= 320), 'Expected previous chunk summaries to stay compact.');
  assert(laterChunks.every((entry) => entry.estimatedTotalTokens <= entry.plannerBudgetTokens), 'Expected later chunks with rolling context to remain under budget.');
  assert(laterChunks.some((entry) => entry.rollingContextCharacters > 0), 'Expected later chunk estimates to include rolling context.');
}

function verifyChunkBudgetArithmeticIncludesContextAndOutput() {
  const {
    estimatePlannerChunkRequestBudget,
    resolveLongformPlannerBudgetProfile,
  } = loadPlannerExecutionInternals();
  const profile = resolveLongformPlannerBudgetProfile('unknown-provider', 'unknown-model');
  assert.strictEqual(profile.profileId, 'default-conservative', 'Expected unknown providers to use conservative defaults.');
  const estimate = estimatePlannerChunkRequestBudget({ promptStats: { requestCharacters: 4000 } }, 3, profile, {
    globalSummaryCharacters: 400,
    instructionSchemaCharacters: 1200,
    rollingContextCharacters: 600,
    transcriptCharacters: 1800,
  });
  assert.strictEqual(estimate.estimatedInputTokens, 1000, 'Expected input token estimate to use characters / 4.');
  assert.strictEqual(estimate.estimatedTotalTokens, estimate.estimatedInputTokens + estimate.estimatedOutputTokens + estimate.safetyMarginTokens, 'Expected total estimate to include input, output, and safety margin.');
  assert.strictEqual(estimate.rollingContextTokens, 150, 'Expected rolling context token estimate to be recorded.');
  assert.strictEqual(estimate.transcriptTokens, 450, 'Expected transcript token estimate to be recorded.');
}

async function verifyLaterChunksSimilarSizeStayUnderBudget() {
  const packet = buildDenseTranscriptPacket(60, 120, { fallbackSecondsPerImage: 8, wordsPerSegment: 22 });
  const { result } = await runAdaptivePlannerMock({
    packet,
    providerId: 'groq',
    providerLabel: 'Groq',
    model: 'openai/gpt-oss-120b',
    promptPrefix: 'later chunk budget model',
  });
  const diagnostics = result.diagnostics.chunkDiagnostics;
  assert(diagnostics.length >= 4, 'Expected constrained planner to use several chunks.');
  assert(diagnostics.every((entry) => entry.estimatedTotalTokens <= entry.plannerBudgetTokens), 'Expected every similar-sized chunk to remain under budget.');
  assert.strictEqual(result.diagnostics.chunkFailures.length, 0, 'Expected similar later chunks to avoid fallback when provider replies are valid.');
}
async function verifyRateLimitBackoffRetrySucceeds() {
  const packet = buildTranscriptPacket(24, 120, { fallbackSecondsPerImage: 8 });
  let calls = 0;
  const sendPlannerRequest = async (messages) => {
    calls += 1;
    const messageText = getMessageText(messages);
    const duration = getChunkDurationFromMessageText(messageText);
    if (calls === 2) {
      const error = new Error('Rate limit reached for model openai/gpt-oss-120b in organization test on tokens per minute (TPM): Limit 8000, Used 7400, Requested 900. Please try again in 1.2s.');
      error.providerStatus = 429;
      throw error;
    }
    return buildChunkModelReply(getChunkMinimumFromMessageText(messageText), duration, 'rate limit retry model');
  };
  const { result } = await runAdaptivePlannerMock({
    packet,
    providerId: 'groq',
    providerLabel: 'Groq',
    model: 'openai/gpt-oss-120b',
    sendPlannerRequest,
    enablePlannerRateLimitBackoff: true,
    rateLimitBackoffMsOverride: 1,
    rateLimitBackoffMaxRetries: 1,
  });
  assert.strictEqual(result.diagnostics.deterministicFallbackUsed, false, 'Expected rate-limit retry to avoid fallback when retry succeeds.');
  assert(result.diagnostics.totalRateLimitWaitMs >= 1, 'Expected rate-limit wait metadata to be recorded.');
  assert(result.diagnostics.rateLimitWaits.length >= 1, 'Expected per-wait rate-limit diagnostics.');
  assert(result.diagnostics.chunkDiagnostics.some((entry) => entry.rateLimitWaitMs >= 1), 'Expected chunk diagnostics to record rate-limit wait time.');
}

function verifyRetryAfterParsingAndTpmClassification() {
  const { classifyPlannerFailure, getPlannerRateLimitWaitMs } = loadPlannerExecutionInternals();
  const retryAfterError = new Error('Provider returned 429.');
  retryAfterError.providerStatus = 429;
  retryAfterError.providerRetryAfter = '2';
  assert.strictEqual(getPlannerRateLimitWaitMs(retryAfterError), 2000, 'Expected Retry-After seconds to be respected.');
  const cumulative = classifyPlannerFailure(new Error('TPM Limit 8000, Used 7400, Requested 900. Please try again in 1.2s.'));
  assert.strictEqual(cumulative.failureReason, 'rate-limit', 'Expected cumulative TPM window exhaustion to classify as rate-limit.');
  const singleRequest = classifyPlannerFailure(new Error('TPM Limit 8000, Requested 9224.'));
  assert.strictEqual(singleRequest.failureReason, 'request-too-large', 'Expected one request above TPM budget to classify as request-too-large.');
}

async function verifyBareContextOmitsPriorPromptsWhenOverBudget() {
  const packet = buildDenseTranscriptPacket(32, 120, { fallbackSecondsPerImage: 8, wordsPerSegment: 18 });
  const providerCalls = [];
  const sendPlannerRequest = async (messages) => {
    const messageText = getMessageText(messages);
    providerCalls.push(messageText);
    const duration = getChunkDurationFromMessageText(messageText);
    return buildChunkModelReply(getChunkMinimumFromMessageText(messageText), duration, 'bare context model');
  };
  await runAdaptivePlannerMock({
    packet,
    providerId: 'mock-tight',
    providerLabel: 'Mock Tight Provider',
    model: 'mock-tight-model',
    providerMetadata: {
      plannerBudgetProfile: {
        maxTotalTokens: 2500,
        safetyMarginTokens: 500,
      },
    },
    sendPlannerRequest,
  });
  const bareCalls = providerCalls.filter((messageText) => /contextProfileId\\?":\\?"bare|contextProfileId.{0,20}bare/.test(messageText));
  assert(bareCalls.length > 0, 'Expected tight budget to use bare context profile.');
  assert(bareCalls.every((messageText) => !/Prior clean image prompt|recentImagePrompts\\?":\[\s*"/.test(messageText)), 'Expected bare context to omit prior image prompts.');
}
async function verifyRequestTooLargeSplitRetrySucceeds() {
  const packet = buildTranscriptPacket(24, 120, { fallbackSecondsPerImage: 8 });
  const providerCalls = [];
  let oversizedThrown = false;
  const sendPlannerRequest = async (messages, retry = false) => {
    const messageText = getMessageText(messages);
    providerCalls.push({ messageText, retry });
    const duration = getChunkDurationFromMessageText(messageText);
    if (!oversizedThrown && duration >= 60) {
      oversizedThrown = true;
      throw new Error('Request too large. TPM Limit 8000, Requested 9224.');
    }
    return buildChunkModelReply(getChunkMinimumFromMessageText(messageText), duration, 'request split success');
  };
  const { result } = await runAdaptivePlannerMock({
    packet,
    providerId: 'google',
    providerLabel: 'Google',
    model: 'models/gemini-2.5-flash',
    sendPlannerRequest,

  });
  assert.strictEqual(result.diagnostics.chunksSplitAfterRequestTooLarge, 1, 'Expected request-too-large provider error to split a chunk once.');
  assert.strictEqual(result.diagnostics.deterministicFallbackUsed, false, 'Expected successful subchunk retry to avoid deterministic fallback.');
  assert.strictEqual(result.diagnostics.chunkFailures.length, 0, 'Expected no chunk fallback when split retry succeeds.');
  assert(providerCalls.length > 2, 'Expected provider calls to include the original oversized chunk and smaller retried chunks.');
  assert(providerCalls.slice(1).some((call) => getChunkDurationFromMessageText(call.messageText) < 60), 'Expected request-too-large retry to reduce transcript chunk duration.');
  assert(providerCalls.slice(1).some((call) => /contextProfileId\\?":\\?"minimal|contextProfileId.{0,20}minimal/.test(call.messageText)), 'Expected request-too-large retry to simplify rolling context.');
}

async function verifyRequestTooLargeSplitRetryFallbackIsLocal() {
  const packet = buildTranscriptPacket(24, 120, { fallbackSecondsPerImage: 8 });
  let oversizedThrown = false;
  let repeatedOversizedThrown = false;
  const sendPlannerRequest = async (messages) => {
    const messageText = getMessageText(messages);
    const duration = getChunkDurationFromMessageText(messageText);
    if (!oversizedThrown && duration >= 60) {
      oversizedThrown = true;
      throw new Error('Request too large. TPM Limit 8000, Requested 9224.');
    }
    if (!repeatedOversizedThrown && oversizedThrown && duration < 60) {
      repeatedOversizedThrown = true;
      throw new Error('Request too large even after split.');
    }
    return buildChunkModelReply(getChunkMinimumFromMessageText(messageText), duration, 'request split partial success');
  };
  const { result } = await runAdaptivePlannerMock({
    packet,
    providerId: 'google',
    providerLabel: 'Google',
    model: 'models/gemini-2.5-flash',
    sendPlannerRequest,

  });
  assert.strictEqual(result.diagnostics.chunksSplitAfterRequestTooLarge, 1, 'Expected provider request-too-large split metadata to be recorded.');
  assert.strictEqual(result.diagnostics.chunkFailures.length, 1, 'Expected only the repeatedly oversized subchunk to fall back.');
  assert.strictEqual(result.diagnostics.deterministicFallbackUsed, true, 'Expected deterministic fallback to be recorded for the failed subchunk.');
  assert(/too large even after/i.test(result.diagnostics.chunkFailures[0].failureReason), 'Expected fallback reason to explain request-too-large after splitting.');
  assert(result.normalizedPlan.scenes.some((scene) => /request split partial success/i.test(scene.imagePrompt)), 'Expected successful sibling subchunks to keep model-planned scenes.');
  assert(result.normalizedPlan.scenes.some((scene) => /Narration segment 1/i.test(scene.imagePrompt)), 'Expected failed subchunk fallback to stay local to its transcript range.');
}

function verifyShortTranscriptBudgetDecision() {
  const {
    estimatePlannerChunkRequestBudget,
    resolveLongformPlannerBudgetProfile,
    shouldUseChunkedLongformPlanner,
  } = loadPlannerExecutionInternals();
  const packet = buildTranscriptPacket(6, 30, { fallbackSecondsPerImage: 8 });
  const request = buildMockPromptMessages(packet, 'Short transcript planner test.');
  const normalProfile = resolveLongformPlannerBudgetProfile('google', 'models/gemini-2.5-flash');
  const normalBudget = estimatePlannerChunkRequestBudget(request, Math.ceil(30 / 8), normalProfile);
  assert.strictEqual(shouldUseChunkedLongformPlanner('longformMedia.scenePlan.v1', packet, { requestBudget: normalBudget }), false, 'Expected 30 second transcript to stay single-shot under normal budget.');

  const tinyBudget = {
    ...normalProfile,
    maxTotalTokens: Math.max(1, normalBudget.estimatedTotalTokens - 1),
    profileId: 'test-tiny-budget',
  };
  const constrainedBudget = estimatePlannerChunkRequestBudget(request, Math.ceil(30 / 8), tinyBudget);
  assert.strictEqual(shouldUseChunkedLongformPlanner('longformMedia.scenePlan.v1', packet, { requestBudget: constrainedBudget }), true, 'Expected 30 second transcript to chunk when the modeled budget requires it.');
}
async function main() {
  const packet = buildPlanningPacketDocument({
    goal: 'Verify longform planner reliability.',
    schemaId: 'longformMedia.scenePlan.v1',
  }, [{
    kind: 'text',
    text: buildSyntheticNarration(180),
  }]);
  assert.strictEqual(validatePlanningPacketShape(packet).ok, true, 'Expected basic longform packet to validate.');
  verifyPromptCompaction();
  verifyDeterministicTimedFallback();
  verifyMinimumImageCountRepair();
  verifyCleanPromptSeparationAndSemanticRepair();
  verifyLongDurationFallbackScaling();
  verifyProviderStructuredOutputPaths();
  verifyExecutionFallbackAndRepairSource();
  verifyChunkedPlannerSource();
  await verifyChunkedPlannerWithMockedProvider();
  await verifyAdaptiveChunkSizingBudgets();
  await verifyRollingContextBoundedAcrossLaterChunks();
  verifyChunkBudgetArithmeticIncludesContextAndOutput();
  await verifyLaterChunksSimilarSizeStayUnderBudget();
  await verifyRateLimitBackoffRetrySucceeds();
  verifyRetryAfterParsingAndTpmClassification();
  await verifyBareContextOmitsPriorPromptsWhenOverBudget();
  await verifyRequestTooLargeSplitRetrySucceeds();
  await verifyRequestTooLargeSplitRetryFallbackIsLocal();
  verifyShortTranscriptBudgetDecision();
  console.log('Verified longform planner adaptive chunk sizing, compact global summary, diagnostics, deterministic fallback, request-too-large splitting, minimum image repair, timing metadata, and provider JSON-mode safeguards.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
