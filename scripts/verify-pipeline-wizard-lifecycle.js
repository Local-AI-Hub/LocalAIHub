const assert = require('assert');

const {
  buildPipelineWizardContext,
  buildPipelineWizardDraft,
  buildPipelineWizardStructuredOutputRequest,
  parsePipelineWizardPlan,
} = require('../electron/shared/pipelineWizard.cjs');
const {
  WIZARD_DIAGNOSTIC_CATEGORIES,
  annotateRecoveredDraftResult,
  buildWizardFailureSummary,
  runPipelineWizardLifecycle,
} = require('../electron/shared/pipelineWizardLifecycle.cjs');
const {
  buildGoogleGenerationConfig,
  buildOpenAiCompatibleResponseFormat,
} = require('../electron/services/providerService.js');

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
  const groqFormat = buildOpenAiCompatibleResponseFormat(
    { id: 'groq' },
    { model: 'openai/gpt-oss-120b', responseFormat },
  );
  assert.strictEqual(groqFormat.type, 'json_schema', 'Groq GPT-OSS wizard calls should use JSON Schema mode instead of generic JSON-object mode.');
  assert.strictEqual(groqFormat.json_schema.strict, false, 'Groq should use best-effort schema mode because the compact Wizard Intent IR intentionally has optional fields.');
}

async function testSchemaValidLongformIntentIrCanBeLoweringRepaired() {
  const intent = 'transcribe an audio input, plan scenes from the transcript, create a scene prompt collection, validate and retry that prompt collection, generate one image per approved prompt, compose the images with the original audio, and output a video.';
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
        { id: 'retryPrompts', kind: 'retry', inputs: ['reviewedScenePrompts'], outputs: ['approvedScenePrompts'], retryTarget: 'derivePrompts', purpose: 'Retry prompt derivation if collection validation fails.' },
        { id: 'generateImages', kind: 'generate_image', inputs: ['approvedScenePrompts'], outputs: ['generatedImages'], purpose: 'Generate one image per approved prompt.' },
        { id: 'composeVideo', kind: 'compose_media', inputs: ['generatedImages', 'sourceAudio'], outputs: ['mediaComposition'], purpose: 'Compose generated images with the original voiceover audio.', mediaComposition: { compositionMode: 'imageSlideshow' } },
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
  assert.strictEqual(result.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED, 'Schema-valid but semantically incomplete longform IR should be classified as lowering repair.');
  assert.strictEqual(result.recovered, true, 'Semantic obligation repair should be reported as recovered fallback.');
  const types = nodeTypes(result);
  for (const expectedType of ['audioInput', 'llmPrompt', 'planner', 'planScenes', 'validation', 'retryLoop', 'collectionMap', 'mediaComposition', 'mediaExport', 'videoOutput']) {
    assert(types.includes(expectedType), 'Expected structured longform draft to include ' + expectedType + '.');
  }
}

async function testValidCompactIntentWithoutRecipeIdCompilesDirectly() {
  const intent = 'add music to a collection of videos';
  const structuredPlan = {
    title: 'Video collection music mix',
    summary: 'Compose an ordered video collection with background music and export one video.',
    gaps: [],
    userRefinementNotes: [],
    intentIr: {
      sources: [
        { name: 'videos', modality: 'collection:video', role: 'Ordered source videos' },
        { name: 'music', modality: 'audio', role: 'Background music' },
      ],
      artifacts: [
        { name: 'composition', kind: 'composition', role: 'Video sequence composition' },
        { name: 'video', kind: 'video', role: 'Exported video' },
      ],
      stages: [
        { id: 'compose', kind: 'compose_media', inputs: ['videos', 'music'], outputs: ['composition'], purpose: 'Compose videos with background music.', mediaComposition: { compositionMode: 'videoSequence' } },
        { id: 'export', kind: 'export', inputs: ['composition'], outputs: ['video'], purpose: 'Export one video.' },
      ],
      outputs: [{ artifact: 'video', kind: 'video', title: 'Video' }],
      assumptions: [],
      gaps: [],
    },
  };
  const result = await runLifecycle(intent, {
    requestModelDraft: () => Promise.resolve({
      ok: true,
      data: {
        message: { content: JSON.stringify(structuredPlan) },
        providerDiagnostics: { finishReason: 'STOP', outputTruncated: false },
      },
    }),
  });
  assert.strictEqual(result.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.PRIMARY_COMPILED, 'Optional recipeId must not force fallback for valid Intent IR.');
  assert.strictEqual(result.recovered, false);
  assert(nodeTypes(result).includes('mediaComposition'));

  const nullRecipeResult = await runLifecycle(intent, {
    requestModelDraft: () => Promise.resolve({
      ok: true,
      data: { message: { content: JSON.stringify({ ...structuredPlan, recipeId: null }) } },
    }),
  });
  assert.strictEqual(nullRecipeResult.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.PRIMARY_COMPILED, 'A null optional recipe hint should be treated as omitted.');
}

async function testSchemaValidCompositionIntentGuidesAmbiguousWording() {
  const intent = 'stitch my demo sections together and add music';
  const structuredPlan = {
    title: 'Demo video sequence',
    summary: 'Compose demo video sections with a music bed and export one video.',
    gaps: [],
    userRefinementNotes: [],
    intentIr: {
      sources: [
        { name: 'sections', modality: 'collection:video', role: 'Demo video sections' },
        { name: 'music', modality: 'audio', role: 'Music bed' },
      ],
      artifacts: [
        { name: 'composition', kind: 'composition', role: 'Demo composition' },
        { name: 'video', kind: 'video', role: 'Final demo video' },
      ],
      stages: [
        { id: 'compose', kind: 'compose_media', inputs: ['sections', 'music'], outputs: ['composition'], purpose: 'Compose demo sections with music.', mediaComposition: { compositionMode: 'videoSequence' } },
        { id: 'export', kind: 'export', inputs: ['composition'], outputs: ['video'], purpose: 'Export one video.' },
      ],
      outputs: [{ artifact: 'video', kind: 'video', title: 'Demo video' }],
      assumptions: [],
      gaps: [],
    },
  };
  const result = await runLifecycle(intent, {
    requestModelDraft: () => Promise.resolve({ ok: true, data: { text: JSON.stringify(structuredPlan) } }),
  });
  assert.strictEqual(result.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.PRIMARY_COMPILED, 'A coherent model-authored composition IR should override an ambiguous audio-generation heuristic.');
  assert.strictEqual(result.recovered, false);
  assert(nodeTypes(result).includes('mediaComposition'));
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
  assert.strictEqual(result.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED);
  assert(result.diagnosticCategories.includes(WIZARD_DIAGNOSTIC_CATEGORIES.FALLBACK_RECOVERED));
  assert(result.draftResult.summary.gaps.some((gap) => /did not return a draft|allowed time|split the workflow/i.test(gap)), 'Expected timeout guidance in recovered summary.');
  assert(nodeTypes(result).includes('imageOutput'), 'Recovered text-to-image timeout draft should still be grounded.');
}

async function testMalformedJsonResolvesWithRecoveredDraft() {
  const result = await runLifecycle('turn a collection of text prompts into a collection of images', {
    requestModelDraft: () => Promise.resolve({ ok: true, data: { text: 'this is not wizard json' } }),
  });
  assert.strictEqual(result.ok, true, 'Malformed model output should resolve through deterministic repair.');
  assert.strictEqual(result.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.JSON_PARSE_FAILED);
  assert(nodeTypes(result).includes('collectionMap'), 'Malformed collection request should recover to collectionMap.');
  assert(result.draftResult.summary.gaps.some((gap) => /not valid JSON|could not be parsed/i.test(gap)), 'Expected JSON parse diagnostic gap.');
}

async function testMarkdownWrappedJsonIsClassifiedAsExtractedRecovery() {
  const intent = 'combine several video clips';
  const structuredPlan = {
    title: 'Combine video clips',
    summary: 'Compose video clips into one export.',
    gaps: [],
    userRefinementNotes: [],
    intentIr: {
      sources: [{ name: 'videos', modality: 'collection:video', role: 'Video clips' }],
      artifacts: [
        { name: 'composition', kind: 'composition', role: 'Video sequence' },
        { name: 'video', kind: 'video', role: 'Exported video' },
      ],
      stages: [
        { id: 'compose', kind: 'compose_media', inputs: ['videos'], outputs: ['composition'], purpose: 'Sequence the clips.', mediaComposition: { compositionMode: 'videoSequence' } },
        { id: 'export', kind: 'export', inputs: ['composition'], outputs: ['video'], purpose: 'Export one video.' },
      ],
      outputs: [{ artifact: 'video', kind: 'video', title: 'Video' }],
      assumptions: [],
      gaps: [],
    },
  };
  const result = await runLifecycle(intent, {
    requestModelDraft: () => Promise.resolve({ ok: true, data: { text: '```json\n' + JSON.stringify(structuredPlan) + '\n```' } }),
  });
  assert.strictEqual(result.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.JSON_WRAPPED_OR_EXTRACTED);
  assert.strictEqual(result.recovered, true);
  assert(/wrapped its JSON in extra text/i.test(result.draftResult.summary.message));
}

async function testSchemaFailuresAreClassifiedPrecisely() {
  const missingField = await runLifecycle('make a slideshow from images', {
    requestModelDraft: () => Promise.resolve({
      ok: true,
      data: {
        text: JSON.stringify({
          title: 'Slideshow',
          gaps: [],
          userRefinementNotes: [],
          intentIr: { sources: [], artifacts: [], stages: [], outputs: [], assumptions: [], gaps: [] },
        }),
      },
    }),
  });
  assert.strictEqual(missingField.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.MISSING_REQUIRED_FIELD);
  assert(!/malformed output/i.test(missingField.draftResult.summary.message), 'Missing fields should not be mislabeled as malformed JSON.');

  const unsupportedEnum = await runLifecycle('make a slideshow from images', {
    requestModelDraft: () => Promise.resolve({
      ok: true,
      data: {
        text: JSON.stringify({
          title: 'Slideshow',
          summary: 'Create a slideshow.',
          gaps: [],
          userRefinementNotes: [],
          intentIr: {
            sources: [{ name: 'images', modality: 'image-bucket', role: 'Images' }],
            artifacts: [],
            stages: [],
            outputs: [],
            assumptions: [],
            gaps: [],
          },
        }),
      },
    }),
  });
  assert.strictEqual(unsupportedEnum.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.UNSUPPORTED_ENUM);

  const extraProperty = await runLifecycle('make a slideshow from images', {
    requestModelDraft: () => Promise.resolve({
      ok: true,
      data: {
        text: JSON.stringify({
          title: 'Slideshow',
          summary: 'Create a slideshow.',
          gaps: [],
          userRefinementNotes: [],
          unexpectedGraphConfig: { fps: 60 },
          intentIr: { sources: [], artifacts: [], stages: [], outputs: [], assumptions: [], gaps: [] },
        }),
      },
    }),
  });
  assert.strictEqual(extraProperty.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.SCHEMA_VALIDATION_FAILED);
}

async function testEmptyProviderReplyIsClassifiedPrecisely() {
  const result = await runLifecycle('combine several video clips', {
    requestModelDraft: () => Promise.resolve({
      ok: true,
      data: {
        message: { content: '' },
        providerDiagnostics: { finishReason: 'STOP', outputTruncated: false },
      },
    }),
  });
  assert.strictEqual(result.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_RETURNED_EMPTY);
  assert.strictEqual(result.recovered, true);
  assert(/empty response/i.test(result.draftResult.summary.message));
}

async function testOutputTruncationIsClassifiedBeforeParsing() {
  const result = await runLifecycle('record system audio and transcribe it', {
    requestModelDraft: () => Promise.resolve({
      ok: true,
      data: {
        message: { content: '{"title":"cut off"' },
        providerDiagnostics: { finishReason: 'MAX_TOKENS', outputTruncated: true },
      },
    }),
  });
  assert.strictEqual(result.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.OUTPUT_TRUNCATED);
  assert.strictEqual(result.recovered, true);
}

async function testGraphValidationIsNotLabeledMalformedJson() {
  const intent = 'make a simple text to image pipeline';
  const structuredPlan = {
    title: 'Image draft',
    summary: 'Generate an image.',
    gaps: [],
    userRefinementNotes: [],
    intentIr: {
      sources: [{ name: 'prompt', modality: 'text', role: 'Prompt' }],
      artifacts: [{ name: 'image', kind: 'image', role: 'Image' }],
      stages: [{ id: 'generate', kind: 'generate_image', inputs: ['prompt'], outputs: ['image'], purpose: 'Generate an image.' }],
      outputs: [{ artifact: 'image', kind: 'image', title: 'Image' }],
      assumptions: [],
      gaps: [],
    },
  };
  const result = await runLifecycle(intent, {
    requestModelDraft: () => Promise.resolve({ ok: true, data: { text: JSON.stringify(structuredPlan) } }),
    buildDraft: (options) => {
      const draft = buildPipelineWizardDraft(options);
      return { ...draft, graphErrors: ['Simulated invalid connection'] };
    },
  });
  assert.strictEqual(result.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.GRAPH_VALIDATION_FAILED);
  assert(!/malformed output/i.test(result.draftResult.summary.message));
}

async function testCompilerExceptionResolvesWithErrorSummary() {
  const result = await runLifecycle('make a simple text to image pipeline', {
    requestModelDraft: () => Promise.resolve({ ok: true, data: { text: '{"recipeId":"text-to-image"}' } }),
    buildDraft: () => {
      throw new Error('Simulated compiler failure');
    },
  });
  assert.strictEqual(result.ok, false, 'Compiler exception should resolve to an error summary when recovery also fails.');
  assert.strictEqual(result.summary.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED);
  assert(/compiler|ground|Simulated compiler failure/i.test(result.summary.message + ' ' + result.summary.gaps.join(' ')), 'Expected compiler diagnostic text.');
}

async function testProviderApiErrorResolvesWithErrorSummary() {
  const result = await runLifecycle('make a simple text to image pipeline', {
    requestModelDraft: () => Promise.resolve({ ok: false, message: 'Provider returned 429. Try again later.' }),
  });
  assert.strictEqual(result.ok, false, 'Provider API error should not stay pending.');
  assert.strictEqual(result.summary.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED);
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
  const summary = buildWizardFailureSummary({ category: WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED, message: 'Timed out.', targetLabel: 'Google Gemini / gemini-2.5-flash' });
  assert.strictEqual(summary.diagnosticCategory, WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED);
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
    category: WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED,
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
    category: WIZARD_DIAGNOSTIC_CATEGORIES.JSON_PARSE_FAILED,
    message: 'The wizard model returned output that was not valid wizard JSON.',
  });
  const recoveredText = [recovered.summary.message, ...(recovered.summary.gaps || []), ...(recovered.summary.manualRefinementNotes || [])].join(' ');
  assertWizardTextPreservesLowercaseS('Recovered summary text', recoveredText);
  assert(/was not valid wizard JSON/i.test(recoveredText), 'Malformed-output diagnostic should preserve "was".');
}

async function main() {
  testGeminiStructuredOutputRequestShape();
  await testSchemaValidLongformIntentIrCanBeLoweringRepaired();
  await testValidCompactIntentWithoutRecipeIdCompilesDirectly();
  await testSchemaValidCompositionIntentGuidesAmbiguousWording();
  await testMisleadingCollectionMapAssumptionIsFiltered();
  await testProviderTimeoutResolvesWithRecoveredDraft();
  await testMalformedJsonResolvesWithRecoveredDraft();
  await testMarkdownWrappedJsonIsClassifiedAsExtractedRecovery();
  await testSchemaFailuresAreClassifiedPrecisely();
  await testEmptyProviderReplyIsClassifiedPrecisely();
  await testOutputTruncationIsClassifiedBeforeParsing();
  await testGraphValidationIsNotLabeledMalformedJson();
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
