const assert = require('assert');

const {
  buildPipelineWizardContext,
  buildPipelineWizardDraft,
  buildPipelineWizardStructuredOutputRequest,
  parsePipelineWizardPlan,
} = require('../electron/shared/pipelineWizard.cjs');
const {
  annotateRecoveredDraftResult,
  buildWizardFailureSummary,
  runPipelineWizardLifecycle,
} = require('../electron/shared/pipelineWizardLifecycle.cjs');
const { buildGoogleGenerationConfig } = require('../electron/services/providerService.js');

const hardware = {
  compatibilityMessage: 'This GPU is supported in Low VRAM mode.',
  gpuModel: 'NVIDIA GTX 1060',
  systemRamMb: 16384,
  vramMb: 6144,
};

const providers = [
  { id: 'google', isConnected: true, lastTestSucceeded: true, name: 'Google Gemini' },
  { id: 'openai', isConnected: true, lastTestSucceeded: true, name: 'OpenAI' },
];

const tools = [
  { id: 'automatic1111', installDir: 'C:/mock/automatic1111', name: 'Automatic1111', status: 'stopped', compatibility: { minimumRamMb: 1, minimumVramMb: 1 } },
  { id: 'whisper', installDir: 'C:/mock/whisper', name: 'Whisper', status: 'stopped' },
  { id: 'ollama', installDir: 'C:/mock/ollama', name: 'Ollama', status: 'running' },
];

const context = buildPipelineWizardContext({ hardware, manifests: tools, providers, tools });

function nodeTypes(result) {
  return (result?.draftResult?.pipeline?.nodes || result?.pipeline?.nodes || []).map((node) => node.type);
}

async function runLifecycle(intent, overrides = {}) {
  return runPipelineWizardLifecycle({
    context,
    intent,
    wizardTarget: { mode: 'cloud', providerId: 'google', model: 'gemini-2.5-flash' },
    targetLabel: 'Google Gemini / gemini-2.5-flash',
    timeoutMs: 20,
    timeoutMessage: 'The wizard model did not return a draft within the allowed time.',
    getReplyText: (result) => String(result?.data?.text || result?.data?.message?.content || ''),
    parsePlan: parsePipelineWizardPlan,
    buildDraft: buildPipelineWizardDraft,
    ...overrides,
  });
}

function testGeminiStructuredOutputRequestShape() {
  const responseFormat = buildPipelineWizardStructuredOutputRequest();
  const config = buildGoogleGenerationConfig(
    { id: 'google', configuration: { maxOutputTokens: 1024 } },
    { maxOutputTokens: 4096, responseFormat },
  );
  assert.strictEqual(config.responseMimeType, 'application/json', 'Gemini wizard calls should request JSON output.');
  assert.strictEqual(config.maxOutputTokens, 4096, 'Wizard calls should be able to request a larger structured output budget.');
  assert(config.responseJsonSchema?.properties?.intentIr, 'Gemini wizard calls should include the Intent IR JSON schema.');
  assert.strictEqual(config.responseJsonSchema.properties.intentIr.properties.stages.items.properties.kind.enum.includes('generate_image'), true, 'Intent IR schema should constrain stage kinds.');
}

async function testValidStructuredLongformIntentIrCompilesDirectly() {
  const intent = 'transcribe an audio input (voiceover), then plan a longform video using that transcribed text, then generate text prompts based on the planning, then validate and retry each one, then once they have all passed use them to generate a collection of images, then use media composition to turn the initial voiceover audio and the generated images into a video, and output that video.';
  const structuredPlan = {
    title: 'Voiceover storyboard video draft',
    summary: 'Transcribe voiceover, plan scenes, validate prompts, map prompts to images, compose with audio, and export video.',
    recipeId: 'audio-transcribe',
    gaps: ['Prompt collection validation before mapping is modeled as a whole-collection review; per-item validation and retry belong on downstream Map Collection item-generation steps.'],
    userRefinementNotes: ['Review model and media export settings before running.'],
    intentIr: {
      sources: [{ name: 'sourceAudio', modality: 'audio', role: 'Source audio' }],
      artifacts: [
        { name: 'transcript', kind: 'text', role: 'Voiceover transcript' },
        { name: 'scenePlan', kind: 'plan', role: 'Longform scene plan' },
        { name: 'scenePrompts', kind: 'collection:text', role: 'Scene prompt collection' },
        { name: 'approvedScenePrompts', kind: 'collection:text', role: 'Approved prompt collection' },
        { name: 'generatedImages', kind: 'collection:image', role: 'Generated image collection' },
        { name: 'mediaComposition', kind: 'composition', role: 'Voiceover and image sequence' },
        { name: 'exportedVideo', kind: 'video', role: 'Final video' },
      ],
      stages: [
        { id: 'transcribeVoiceover', kind: 'transcribe_audio', inputs: ['sourceAudio'], outputs: ['transcript'], purpose: 'Transcribe the connected voiceover audio.' },
        { id: 'planVideo', kind: 'plan', inputs: ['transcript'], outputs: ['scenePlan'], purpose: 'Create a longform scene plan from the transcript.' },
        { id: 'derivePrompts', kind: 'plan_scenes', inputs: ['scenePlan'], outputs: ['scenePrompts'], purpose: 'Derive ordered scene prompts from the plan.' },
        { id: 'validatePrompts', kind: 'validate', inputs: ['scenePrompts'], outputs: ['reviewedScenePrompts'], validationMode: 'llm', purpose: 'Validate the prompt collection as a whole.' },
        { id: 'retryPrompts', kind: 'retry', inputs: ['reviewedScenePrompts'], outputs: ['approvedScenePrompts'], retryTarget: 'derivePrompts', maxAttempts: 3, purpose: 'Retry prompt derivation if collection validation fails.' },
        { id: 'generateImages', kind: 'generate_image', inputs: ['approvedScenePrompts'], outputs: ['generatedImages'], purpose: 'Generate one image per approved prompt.' },
        { id: 'composeVideo', kind: 'compose_media', inputs: ['generatedImages'], outputs: ['mediaComposition'], purpose: 'Compose generated images with the original voiceover audio.' },
        { id: 'exportVideo', kind: 'export', inputs: ['mediaComposition'], outputs: ['exportedVideo'], purpose: 'Export the media composition as video.' },
      ],
      outputs: [{ artifact: 'exportedVideo', kind: 'video', title: 'Final video' }],
      assumptions: [],
      gaps: ['Prompt collection validation before mapping is modeled as a whole-collection review; per-item validation and retry belong on downstream Map Collection item-generation steps.'],
    },
  };
  const result = await runLifecycle(intent, {
    requestModelDraft: () => Promise.resolve({ ok: true, data: { text: JSON.stringify(structuredPlan) } }),
  });
  assert.strictEqual(result.ok, true, 'Valid structured longform IR should compile directly.');
  assert.strictEqual(result.diagnosticCategory, '', 'Valid structured IR should not be classified as malformed recovery.');
  const types = nodeTypes(result);
  for (const expectedType of ['audioInput', 'llmPrompt', 'planner', 'planScenes', 'validation', 'retryLoop', 'collectionMap', 'mediaComposition', 'mediaExport', 'videoOutput']) {
    assert(types.includes(expectedType), 'Expected structured longform draft to include ' + expectedType + '.');
  }
}

async function testMisleadingCollectionMapAssumptionIsFiltered() {
  const intent = 'plan scenes then validate prompts and retry them before generating an image per scene';
  const modelOutput = {
    title: 'Misleading assumption draft',
    summary: 'Plan, validate, retry, and map prompts to images.',
    gaps: [],
    userRefinementNotes: [],
    intentIr: {
      sources: [{ name: 'brief', modality: 'text', role: 'Source brief' }],
      artifacts: [
        { name: 'scenePlan', kind: 'plan', role: 'Scene plan' },
        { name: 'scenePrompts', kind: 'collection:text', role: 'Scene prompts' },
        { name: 'generatedImages', kind: 'collection:image', role: 'Generated images' },
      ],
      stages: [
        { id: 'plan', kind: 'plan', inputs: ['brief'], outputs: ['scenePlan'], purpose: 'Plan scenes.' },
        { id: 'prompts', kind: 'plan_scenes', inputs: ['scenePlan'], outputs: ['scenePrompts'], purpose: 'Derive prompts.' },
        { id: 'images', kind: 'generate_image', inputs: ['scenePrompts'], outputs: ['generatedImages'], purpose: 'Generate images.' },
      ],
      outputs: [{ artifact: 'generatedImages', kind: 'collection:image', title: 'Generated images' }],
      assumptions: ['The build_collection stage will be compiled into a collectionMap node with an internal workflow that includes llmPrompt, validation, and retryLoop for each individual prompt.'],
      gaps: [],
    },
  };
  const result = await runLifecycle(intent, {
    requestModelDraft: () => Promise.resolve({ ok: true, data: { text: JSON.stringify(modelOutput) } }),
  });
  const allUserText = [result.draftResult.summary.message, ...(result.draftResult.summary.gaps || [])].join(' ');
  assert(!/internal workflow that includes llmPrompt, validation, and retryLoop/i.test(allUserText), 'Misleading per-item collectionMap assumption should be filtered.');
  assert(!/does not yet retry individual prompt items|per-item collectionMap retries/i.test(allUserText), 'Per-item collectionMap validation should no longer be described as unsupported.');
}

async function testProviderTimeoutResolvesWithRecoveredDraft() {
  const startedAt = Date.now();
  const result = await runLifecycle('make a simple text to image pipeline', {
    requestModelDraft: () => new Promise(() => {}),
  });
  assert(Date.now() - startedAt < 2000, 'Timeout simulation should resolve instead of staying pending.');
  assert.strictEqual(result.ok, true, 'Timeout should recover with a bounded draft when deterministic repair can ground it.');
  assert.strictEqual(result.diagnosticCategory, 'provider-timeout');
  assert(result.draftResult.summary.gaps.some((gap) => /did not return a draft|allowed time|split the workflow/i.test(gap)), 'Expected timeout guidance in recovered summary.');
  assert(nodeTypes(result).includes('imageOutput'), 'Recovered text-to-image timeout draft should still be grounded.');
}

async function testMalformedJsonResolvesWithRecoveredDraft() {
  const result = await runLifecycle('turn a collection of text prompts into a collection of images', {
    requestModelDraft: () => Promise.resolve({ ok: true, data: { text: 'this is not wizard json' } }),
  });
  assert.strictEqual(result.ok, true, 'Malformed model output should resolve through deterministic repair.');
  assert.strictEqual(result.diagnosticCategory, 'malformed-model-output');
  assert(nodeTypes(result).includes('collectionMap'), 'Malformed collection request should recover to collectionMap.');
  assert(result.draftResult.summary.gaps.some((gap) => /not valid wizard JSON|malformed output/i.test(gap)), 'Expected malformed-output diagnostic gap.');
}

async function testCompilerExceptionResolvesWithErrorSummary() {
  const result = await runLifecycle('make a simple text to image pipeline', {
    requestModelDraft: () => Promise.resolve({ ok: true, data: { text: '{"recipeId":"text-to-image"}' } }),
    buildDraft: () => {
      throw new Error('Simulated compiler failure');
    },
  });
  assert.strictEqual(result.ok, false, 'Compiler exception should resolve to an error summary when recovery also fails.');
  assert.strictEqual(result.summary.diagnosticCategory, 'compiler-grounding-error');
  assert(/compiler|ground|Simulated compiler failure/i.test(result.summary.message + ' ' + result.summary.gaps.join(' ')), 'Expected compiler diagnostic text.');
}

async function testProviderApiErrorResolvesWithErrorSummary() {
  const result = await runLifecycle('make a simple text to image pipeline', {
    requestModelDraft: () => Promise.resolve({ ok: false, message: 'Provider returned 429. Try again later.' }),
  });
  assert.strictEqual(result.ok, false, 'Provider API error should not stay pending.');
  assert.strictEqual(result.summary.diagnosticCategory, 'provider-error');
  assert(/429|try again/i.test(result.summary.message), 'Expected provider error message to reach the user summary.');
}

async function testLongformMediaTimeoutRecoversToGroundedDraft() {
  const intent = 'transcribe an audio input (voiceover), then plan a longform video using that transcribed text, then generate text prompts based on the planning, then validate and retry each one, then once they have all passed use them to generate a collection of images, then use media composition to turn the initial voiceover audio and the generated images into a video, and output that video.';
  const result = await runLifecycle(intent, {
    requestModelDraft: () => new Promise(() => {}),
  });
  assert.strictEqual(result.ok, true, 'Longform timeout should recover to a bounded draft when deterministic repair can ground it.');
  const types = nodeTypes(result);
  for (const expectedType of ['audioInput', 'llmPrompt', 'planningPacket', 'planner', 'planScenes', 'validation', 'retryLoop', 'collectionMap', 'mediaComposition', 'mediaExport', 'videoOutput']) {
    assert(types.includes(expectedType), 'Expected recovered longform draft to include ' + expectedType + '.');
  }
  const audioToComposition = result.draftResult.pipeline.edges.some((edge) => edge.source.portId === 'audio' && edge.target.portId === 'audio');
  assert(audioToComposition, 'Expected initial voiceover audio to be wired into Media Composition.');
}

function testFailureSummaryCategories() {
  const summary = buildWizardFailureSummary({ category: 'provider-timeout', message: 'Timed out.', targetLabel: 'Google Gemini / gemini-2.5-flash' });
  assert.strictEqual(summary.diagnosticCategory, 'provider-timeout');
  assert(summary.targetLabel.includes('Google Gemini'), 'Failure summary should preserve readable target labels.');
}

function assertWizardTextPreservesLowercaseS(label, text) {
  const normalized = String(text || '');
  for (const term of ['requested', 'nodes', 'was', 'scenes', 'assumptions', 'status', 'success']) {
    assert(
      new RegExp('\\b' + term + '\\b', 'i').test(normalized),
      label + ' should preserve "' + term + '" in: ' + normalized,
    );
  }
  assert(!/\breque ted\b|\bwa not\b|\bnode including\b/i.test(normalized), label + ' should not strip lowercase s characters: ' + normalized);
}

function testWizardLifecycleMessageTextPreservesLowercaseS() {
  const failureSummary = buildWizardFailureSummary({
    category: 'provider-error',
    message: 'The requested workflow status was success for scenes, assumptions, and nodes.',
  });
  assertWizardTextPreservesLowercaseS('Failure summary message', failureSummary.message);

  const recovered = annotateRecoveredDraftResult({
    summary: {
      resultState: 'repaired',
      message: 'Local AI Hub repaired and compiled the requested workflow into an editable grounded graph: 8 nodes including scenes, assumptions, status, and success.',
      gaps: [],
      manualRefinementNotes: [],
    },
  }, {
    category: 'malformed-model-output',
    message: 'The wizard model returned output that was not valid wizard JSON.',
  });
  const recoveredText = [recovered.summary.message, ...(recovered.summary.gaps || []), ...(recovered.summary.manualRefinementNotes || [])].join(' ');
  assertWizardTextPreservesLowercaseS('Recovered summary text', recoveredText);
  assert(/was not valid wizard JSON/i.test(recoveredText), 'Malformed-output diagnostic should preserve "was".');
}

async function main() {
  testGeminiStructuredOutputRequestShape();
  await testValidStructuredLongformIntentIrCompilesDirectly();
  await testMisleadingCollectionMapAssumptionIsFiltered();
  await testProviderTimeoutResolvesWithRecoveredDraft();
  await testMalformedJsonResolvesWithRecoveredDraft();
  await testCompilerExceptionResolvesWithErrorSummary();
  await testProviderApiErrorResolvesWithErrorSummary();
  await testLongformMediaTimeoutRecoversToGroundedDraft();
  testFailureSummaryCategories();
  testWizardLifecycleMessageTextPreservesLowercaseS();
  console.log('Pipeline wizard lifecycle verifier passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
