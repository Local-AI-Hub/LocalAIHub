const assert = require('assert');

const {
  buildContextMaps,
  buildPipelineGraph,
  analyzePipeline,
} = require('../electron/shared/pipelineSchema.cjs');
const {
  WIZARD_RECIPE_IDS,
  buildPipelineWizardContext,
  buildPipelineWizardDraft,
  buildPipelineWizardMessages,
  inferRecipeIdFromIntent,
  parsePipelineWizardPlan,
} = require('../electron/shared/pipelineWizard.cjs');

const hardware = {
  compatibilityMessage: 'This GPU is supported in Low VRAM mode.',
  gpuModel: 'NVIDIA GTX 1060',
  systemRamMb: 16384,
  vramMb: 6144,
};

const providers = [
  {
    id: 'openai',
    isConnected: true,
    lastTestSucceeded: true,
    lastTestedAt: new Date().toISOString(),
    name: 'OpenAI',
  },
];

const tools = [
  {
    compatibility: {
      minimumRamMb: 8192,
      minimumVramMb: 4096,
      recommendedRamMb: 16384,
      recommendedVramMb: 8192,
    },
    id: 'automatic1111',
    installDir: 'C:/mock/automatic1111',
    launchProfile: { kind: 'folder', path: 'C:/mock/automatic1111' },
    name: 'Automatic1111',
    status: 'stopped',
  },
  {
    id: 'whisper',
    installDir: 'C:/mock/whisper',
    launchProfile: { kind: 'python-module', pythonPath: 'C:/mock/python.exe' },
    name: 'Whisper',
    status: 'stopped',
  },
  {
    id: 'ollama',
    installDir: 'C:/mock/ollama',
    launchProfile: { kind: 'binary', executable: 'C:/mock/ollama.exe' },
    modelCapabilitiesByName: {
      'llama3.1:8b': {
        capabilityLabels: ['completion'],
        capabilitySource: 'test',
        name: 'llama3.1:8b',
        supportsImageInput: false,
      },
    },
    name: 'Ollama',
    status: 'running',
  },
];

function assertNoStructuralErrors(pipeline) {
  const graph = buildPipelineGraph(pipeline);
  assert.deepStrictEqual(graph.errors, [], 'Expected no graph errors, got: ' + graph.errors.join(' | '));
}

function assertKnownNodeTypes(pipeline) {
  for (const node of pipeline.nodes) {
    assert(node.type && node.type !== 'unknown', 'Wizard created an unknown node type.');
  }
}

function assertRuntimeConfigsDoNotContainIntent(pipeline, intent) {
  const normalizedIntent = String(intent || '').trim();
  const authoringPattern = /\b(build|create|make|draft|generate|design|compose|construct|set up|wire)\b.{0,80}\b(pipeline|workflow|graph|builder|wizard)\b/i;
  for (const node of pipeline.nodes) {
    const serializedConfig = JSON.stringify(node.config || {});
    assert(!serializedConfig.includes(normalizedIntent), 'Runtime config copied the wizard request into node ' + node.label + '.');
    assert(!authoringPattern.test(serializedConfig), 'Runtime config leaked authoring language into node ' + node.label + ': ' + serializedConfig);
  }
}

function analyzeWithRealContext(pipeline) {
  return analyzePipeline(pipeline, buildContextMaps({
    hardware,
    providers,
    toolCatalog: tools,
    tools,
  }));
}

function testWizardPromptBoundary(context) {
  const messages = buildPipelineWizardMessages({
    context,
    intent: 'Create a text to image pipeline for product thumbnails.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });
  const prompt = JSON.stringify(messages);
  assert(prompt.includes('Do not invent node types'), 'Wizard prompt should forbid invented graph structures.');
  assert(prompt.includes('Keep authoring-time requests separate'), 'Wizard prompt should protect runtime content from request leakage.');
  assert(prompt.includes('patternHintIds'), 'Wizard prompt should expose recipes as pattern hints.');
  assert(prompt.includes('intentIr'), 'Wizard prompt should prefer the generic intent IR boundary.');
  assert(prompt.includes('supportedIntentStageKinds'), 'Wizard prompt should expose supported abstract stage kinds.');
  assert(prompt.includes('allowedNodeTypes'), 'Wizard prompt should expose allowed node types for flexible composition.');
  assert(prompt.includes('automatic1111'), 'Wizard prompt should expose real available tools.');
}

function testLocalWizardPromptIsCompactAndGrounded(context) {
  const localMessages = buildPipelineWizardMessages({
    context,
    intent: 'Create a text to image pipeline for product thumbnails.',
    wizardTarget: { mode: 'ollama', model: 'qwen2.5:0.5b' },
  });
  const localPrompt = JSON.stringify(localMessages);
  assert(localPrompt.length < 9000, 'Local wizard prompt should stay compact enough for modest Ollama models.');
  assert(localPrompt.includes('textInput|'), 'Local prompt should still include grounded node signatures.');
  assert(localPrompt.includes('imageGenerate|'), 'Local prompt should still include image generation node signatures.');
  assert(localPrompt.includes('automatic1111'), 'Local prompt should still include real available tools.');
  assert(localPrompt.includes('intentIr'), 'Local prompt should ask weaker models for abstract intent instead of exact wiring.');
  assert(localPrompt.includes('supportedIntentStageKinds'), 'Local prompt should constrain local models to supported abstract stage kinds.');
  assert(localPrompt.includes('Recipe ids are hints'), 'Local prompt should keep recipes as hints rather than templates.');
}


function testIntentIrTextToImageDraft(context) {
  const intent = 'Create a product thumbnail image pipeline from a plain English product description.';
  const plan = parsePipelineWizardPlan(JSON.stringify({
    title: 'Product thumbnail intent draft',
    summary: 'Use abstract intent and let Local AI Hub choose nodes.',
    intentIr: {
      sources: [{ name: 'productBrief', modality: 'text', role: 'Product brief' }],
      artifacts: [{ name: 'thumbnail', kind: 'image' }],
      stages: [{ id: 'makeThumbnail', kind: 'generate_image', input: 'productBrief', output: 'thumbnail', purpose: 'Generate a product thumbnail from the connected brief.' }],
      outputs: [{ artifact: 'thumbnail', kind: 'image', title: 'Generated thumbnail' }],
      gaps: [],
    },
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: plan,
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.summary.recipeLabel, 'Intent IR graph', 'Expected the generic intent IR compiler to own this draft.');
  assert(result.pipeline.nodes.some((node) => node.type === 'textInput'), 'Expected text source node from IR source.');
  assert(result.pipeline.nodes.some((node) => node.type === 'imageGenerate' && node.config.toolId === 'automatic1111'), 'Expected Local AI Hub to infer grounded local image generation.');
  assert(result.pipeline.nodes.some((node) => node.type === 'imageOutput'), 'Expected image output node from IR output.');
  assertRuntimeConfigsDoNotContainIntent(result.pipeline, intent);
}

function testIntentIrPlanningValidationRetryDraft(context) {
  const intent = 'Turn this episode outline into a longform scene plan, validate it, retry on failure, then expose approved scene prompts as an ordered collection.';
  const plan = parsePipelineWizardPlan(JSON.stringify({
    title: 'Approved scene planning intent draft',
    summary: 'Use intent IR for planning, validation, retry, and scene prompt collection.',
    intentIr: {
      sources: [{ name: 'episodeOutline', modality: 'text', role: 'Episode outline' }],
      artifacts: [
        { name: 'scenePlan', kind: 'plan' },
        { name: 'approvedPlan', kind: 'plan' },
        { name: 'scenePrompts', kind: 'collection:text' },
      ],
      stages: [
        { id: 'makePlan', kind: 'plan', input: 'episodeOutline', output: 'scenePlan', purpose: 'Create a structured longform scene plan.' },
        { id: 'checkPlan', kind: 'validate', input: 'scenePlan', output: 'reviewedPlan', validationMode: 'llm', purpose: 'Pass only if the plan has ordered scenes and specific visual prompt material.' },
        { id: 'retryPlan', kind: 'retry', input: 'reviewedPlan', output: 'approvedPlan', retryTarget: 'makePlan', maxAttempts: 3 },
        { id: 'extractPrompts', kind: 'plan_scenes', input: 'approvedPlan', output: 'scenePrompts' },
      ],
      outputs: [
        { artifact: 'approvedPlan', kind: 'plan', title: 'Approved scene plan' },
        { artifact: 'scenePrompts', kind: 'collection:text', title: 'Approved scene prompts' },
      ],
    },
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: plan,
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.summary.recipeLabel, 'Intent IR graph', 'Expected planning request to compile through generic IR.');
  for (const expectedType of ['planningPacket', 'planner', 'validation', 'retryLoop', 'planScenes', 'planOutput', 'collectionOutput']) {
    assert(result.pipeline.nodes.some((node) => node.type === expectedType), 'Expected IR planning graph to include ' + expectedType + '.');
  }
  assert(result.pipeline.nodes.some((node) => node.type === 'retryLoop' && node.config.retryTargetNodeId), 'Expected retry loop to target the planned stage.');
  assertRuntimeConfigsDoNotContainIntent(result.pipeline, intent);
}

function testIntentIrLocalImageDescriptionValidationDraft(context) {
  const intent = 'Build a pipeline with image input, model generates description, validate description, retry the model on fail, and output approved text.';
  const plan = parsePipelineWizardPlan(JSON.stringify({
    title: 'Local image description intent draft',
    summary: 'Use intent IR so a local model only names stages.',
    intentIr: {
      sources: [{ name: 'sourceImage', modality: 'image', role: 'Source image' }],
      artifacts: [{ name: 'description', kind: 'text' }, { name: 'approvedDescription', kind: 'text' }],
      stages: [
        { id: 'describeImage', kind: 'llm_generate_text', input: 'sourceImage', output: 'description', purpose: 'Describe the connected runtime image.' },
        { id: 'checkDescription', kind: 'validate', input: 'description', output: 'reviewedDescription', validationMode: 'llm', purpose: 'Pass only if the description is specific and useful.' },
        { id: 'retryDescription', kind: 'retry', input: 'reviewedDescription', output: 'approvedDescription', retryTarget: 'describeImage', maxAttempts: 3 },
      ],
      outputs: [{ artifact: 'approvedDescription', kind: 'text', title: 'Approved description' }],
    },
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: plan,
    wizardTarget: { mode: 'ollama', model: 'llama3.1:8b' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.summary.recipeLabel, 'Intent IR graph', 'Expected local-oriented request to stay on the generic IR path.');
  for (const expectedType of ['imageInput', 'llmPrompt', 'validation', 'retryLoop', 'textOutput']) {
    assert(result.pipeline.nodes.some((node) => node.type === expectedType), 'Expected local IR graph to include ' + expectedType + '.');
  }
  assert(result.pipeline.nodes.some((node) => node.type === 'llmPrompt' && node.config.executionMode === 'ollama'), 'Expected Local AI Hub to infer Ollama model execution.');
  assert(result.pipeline.nodes.some((node) => node.type === 'validation' && node.config.llmExecutionMode === 'ollama'), 'Expected validation to reuse the local wizard target when requested.');
  assertRuntimeConfigsDoNotContainIntent(result.pipeline, intent);
}

function testTextToImageDraft(context) {
  const intent = 'Create a product thumbnail image pipeline from a plain English product description.';
  const plan = parsePipelineWizardPlan(JSON.stringify({
    recipeId: WIZARD_RECIPE_IDS.TEXT_TO_IMAGE,
    title: 'Product thumbnail draft',
    summary: 'Use the installed local image generator and keep settings editable.',
    steps: [{ operationId: 'imageGenerate', targetKind: 'tool', targetId: 'automatic1111', purpose: 'Generate the thumbnail image.' }],
    gaps: [],
    userRefinementNotes: ['Tune size and prompt details after the draft is created.'],
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: plan,
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  const inputNode = result.pipeline.nodes.find((node) => node.type === 'textInput');
  assert(inputNode, 'Expected a text input node.');
  assert.strictEqual(inputNode.config.text, '', 'Text input should not copy the authoring request as runtime content.');
  assert(result.pipeline.nodes.some((node) => node.type === 'imageGenerate' && node.config.toolId === 'automatic1111'), 'Expected grounded Automatic1111 image generation.');
  assert(result.pipeline.nodes.some((node) => node.type === 'imageOutput'), 'Expected an image output node.');
  assert(result.summary.manualRefinementNotes.some((note) => /settings/i.test(note)), 'Expected honest manual refinement note.');
  assertRuntimeConfigsDoNotContainIntent(result.pipeline, intent);
}

function testFlexibleGraphDraft(context) {
  const intent = 'Summarize a product brief, then rewrite the summary as a punchy store listing.';
  const plan = parsePipelineWizardPlan(JSON.stringify({
    title: 'Two-step copy draft',
    summary: 'Compose two model steps instead of using a canned whole-pipeline recipe.',
    draftGraph: {
      nodes: [
        { id: 'brief', type: 'textInput', label: 'Product brief', config: { text: intent } },
        { id: 'summary', type: 'llmPrompt', label: 'Summarize brief', config: { operationId: 'llmPrompt', instruction: 'Summarize the connected product brief.' } },
        { id: 'listing', type: 'llmPrompt', label: 'Write listing', config: { operationId: 'llmPrompt', instruction: 'Rewrite the summary as a concise store listing.' } },
        { id: 'out', type: 'textOutput', label: 'Listing output', config: { title: 'Store listing' } },
      ],
      edges: [
        { sourceNodeId: 'brief', sourcePortId: 'text', targetNodeId: 'summary', targetPortId: 'prompt' },
        { sourceNodeId: 'summary', sourcePortId: 'text', targetNodeId: 'listing', targetPortId: 'prompt' },
        { sourceNodeId: 'listing', sourcePortId: 'text', targetNodeId: 'out', targetPortId: 'text' },
      ],
    },
    gaps: [],
    userRefinementNotes: ['Tune both model instructions before running.'],
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: plan,
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.pipeline.nodes.filter((node) => node.type === 'llmPrompt').length, 2, 'Expected a flexible two-model-step graph.');
  assert.strictEqual(result.pipeline.nodes.find((node) => node.id === 'brief').config.text, '', 'Flexible text inputs should not keep copied wizard intent.');
  assert(result.summary.recipeLabel === 'Flexible grounded graph', 'Expected flexible graph summary instead of a canned recipe label.');
}

function testScenePlanDraft(context) {
  const intent = 'Turn this episode outline into a grounded longform scene plan and scene prompt collection.';
  const plan = parsePipelineWizardPlan(JSON.stringify({
    recipeId: WIZARD_RECIPE_IDS.SCENE_PLAN,
    title: 'Episode scene planning draft',
    summary: 'Use the current mature scene-planning substrate.',
    steps: [{ operationId: 'llmPrompt', targetKind: 'provider', targetId: 'openai', purpose: 'Build the structured plan.' }],
    gaps: ['Downstream image or video generation is not auto-configured in this first pass.'],
    userRefinementNotes: [],
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: plan,
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  for (const expectedType of ['planningPacket', 'planner', 'planScenes', 'planOutput', 'collectionOutput']) {
    assert(result.pipeline.nodes.some((node) => node.type === expectedType), 'Expected scene plan draft to include ' + expectedType + '.');
  }
  const sourceNode = result.pipeline.nodes.find((node) => node.type === 'textInput');
  const packetNode = result.pipeline.nodes.find((node) => node.type === 'planningPacket');
  assert.strictEqual(sourceNode.config.text, '', 'Scene plan source text should be runtime input, not wizard intent.');
  assert(!packetNode.config.goal.includes(intent), 'Planning goal should be distilled instead of copied.');
  assert(!packetNode.config.sourceSummary.includes(intent), 'Planning source summary should describe runtime source, not authoring request.');
  assert(result.summary.gaps.some((gap) => /longform scene-planning/i.test(gap) || /Downstream image/i.test(gap)), 'Expected explicit planning/deferred-generation gap.');
}

function testComplexStoryboardVideoScaffold(context) {
  const intent = 'Build a pipeline where a user enters a voiceover script, generates a plan, validates the plan and retries on fail, creates per-scene prompts, validates prompts and retries, generates images from approved prompts, validates images and regenerates failures, then sequences approved images into a video.';
  const shallowPlan = parsePipelineWizardPlan(JSON.stringify({
    recipeId: WIZARD_RECIPE_IDS.SCENE_PLAN,
    title: 'Build the requested pipeline',
    summary: 'Make a pipeline for the user request.',
    steps: [{ operationId: 'llmPrompt', purpose: 'Plan scenes.' }],
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: shallowPlan,
    wizardTarget: { mode: 'ollama', model: 'llama3.1:8b' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.pipeline.name, 'Validated storyboard video draft', 'Expected sanitized short pipeline title.');
  assert.strictEqual(result.summary.recipeLabel, 'Intent IR graph', 'Expected weak local storyboard output to repair through generic intent IR.');
  assert.strictEqual(result.plan.intentIrRepair.applied, true, 'Expected obligation repair to rebuild the weak local request.');
  for (const expectedType of ['planningPacket', 'planner', 'validation', 'retryLoop', 'planScenes', 'planOutput', 'collectionOutput']) {
    assert(result.pipeline.nodes.some((node) => node.type === expectedType), 'Expected repaired storyboard draft to include ' + expectedType + '.');
  }
  assert(result.pipeline.nodes.filter((node) => node.type === 'validation').length >= 2, 'Expected the repaired draft to preserve plan and prompt validation stages.');
  assert(result.pipeline.nodes.filter((node) => node.type === 'retryLoop').length >= 2, 'Expected the repaired draft to preserve retry stages.');
  assert.strictEqual(result.pipeline.nodes.some((node) => node.type === 'mediaExport'), false, 'Unsupported downstream export should stay an explicit gap instead of a fake compiled graph.');
  assert(result.pipeline.nodes.length > 6, 'Expected the repaired draft to avoid collapsing to a shallow three-node graph.');
  assert(result.summary.gaps.some((gap) => /does not yet map each collection item through image generation automatically/i.test(gap)), 'Expected explicit unsupported collection-to-image bridge gap.');
  assert(!/Make a pipeline for the user request/.test(result.summary.message), 'Summary should describe the graph Local AI Hub actually created.');
  assert.strictEqual(result.summary.resultState, 'repaired', 'Expected repaired storyboard draft to be classified as repaired, not placeholder.');
  assert(/repaired and compiled the requested workflow/i.test(result.summary.message), 'Expected graph-grounded repaired intent summary after repair.');
  assertRuntimeConfigsDoNotContainIntent(result.pipeline, intent);
}

function testPartialStoryboardDraftStaysFlexible(context) {
  const intent = 'Build a pipeline where a user enters a voiceover script, generates a plan, validates prompts, generates images, validates images, and sequences approved images into a video.';
  const plan = parsePipelineWizardPlan(JSON.stringify({
    title: 'Prompt validation draft',
    summary: 'A partial but valid graph composed from real node types.',
    draftGraph: {
      nodes: [
        { id: 'script', type: 'textInput', label: 'Build the requested pipeline', config: { text: intent } },
        { id: 'prompt', type: 'llmPrompt', label: 'Create scene prompt', purpose: 'Create an image prompt from the connected runtime script.', config: { operationId: 'llmPrompt', notes: intent } },
        { id: 'check', type: 'validation', label: 'Validate prompt', config: { mode: 'llm', ruleset: intent, systemPrompt: 'Build a pipeline that validates generated prompts.' } },
        { id: 'passOut', type: 'textOutput', label: 'Build the pipeline output', config: { title: 'Build pipeline output' } },
        { id: 'failOut', type: 'textOutput', label: 'Rejected prompt', config: { title: 'Rejected prompt' } },
      ],
      edges: [
        { sourceNodeId: 'script', sourcePortId: 'text', targetNodeId: 'prompt', targetPortId: 'prompt' },
        { sourceNodeId: 'prompt', sourcePortId: 'text', targetNodeId: 'check', targetPortId: 'input' },
        { sourceNodeId: 'check', sourcePortId: 'pass', targetNodeId: 'passOut', targetPortId: 'text' },
        { sourceNodeId: 'check', sourcePortId: 'fail', targetNodeId: 'failOut', targetPortId: 'text' },
      ],
    },
    gaps: ['Image generation and video export are still to be added.'],
    userRefinementNotes: [],
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: plan,
    wizardTarget: { mode: 'ollama', model: 'llama3.1:8b' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.summary.recipeLabel, 'Flexible grounded graph', 'Expected partial valid composition to remain flexible instead of being replaced by a full scaffold.');
  assert.strictEqual(result.pipeline.nodes.filter((node) => node.type === 'mediaExport').length, 0, 'Fallback scaffold should not inject video export into a partial flexible graph.');
  assert.strictEqual(result.pipeline.nodes.find((node) => node.id === 'script').label, 'Text Input', 'Runtime-facing labels should not keep authoring instructions.');
  assert.strictEqual(result.pipeline.nodes.find((node) => node.id === 'script').config.text, '', 'Runtime input should stay empty.');
  assert.strictEqual(result.pipeline.nodes.find((node) => node.id === 'prompt').config.notes, '', 'Generic runtime config fields should not keep copied wizard intent.');
  const validationNode = result.pipeline.nodes.find((node) => node.id === 'check');
  assert.notStrictEqual(validationNode.config.ruleset, intent, 'Validation rules should not copy the wizard request.');
  assert(!/Build a pipeline/i.test(validationNode.config.systemPrompt), 'Validation system prompt should not keep authoring instructions.');
  assert.strictEqual(result.pipeline.nodes.find((node) => node.id === 'passOut').config.title, 'Text Output', 'Output title should fall back to schema label when authoring language is proposed.');
  assertRuntimeConfigsDoNotContainIntent(result.pipeline, intent);
}

function testGenericLocalTextResponseExpandsForComplexStoryboard(context) {
  const intent = 'Build a pipeline where a user enters a voiceover script, generates a plan, validates the plan and retries on fail, creates per-scene prompts, validates prompts and retries, generates images from approved prompts, validates images and regenerates failures, then sequences approved images into a video.';
  const weakLocalPlan = parsePipelineWizardPlan(JSON.stringify({
    recipeId: WIZARD_RECIPE_IDS.TEXT_RESPONSE,
    title: 'Text response draft',
    summary: 'This draft creates the requested planning, validation, image generation, and video workflow.',
    steps: [{ operationId: 'llmPrompt', purpose: 'Answer the user.' }],
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: weakLocalPlan,
    wizardTarget: { mode: 'ollama', model: 'phi4-mini:3.8b' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.summary.recipeLabel, 'Validated storyboard/video scaffold', 'Expected generic local text response to be expanded when it under-covers the complex request.');
  assert(result.pipeline.nodes.filter((node) => node.type === 'validation').length >= 3, 'Expected validation stages instead of a shallow text response.');
  assert(result.pipeline.nodes.filter((node) => node.type === 'retryLoop').length >= 3, 'Expected retry stages instead of a shallow text response.');
  assert(result.pipeline.nodes.some((node) => node.type === 'mediaExport'), 'Expected video export in the expanded draft.');
  assert(!/This draft creates the requested planning/.test(result.summary.message), 'Summary should describe the graph Local AI Hub actually created, not the weak model summary.');
  assert(/multi-stage storyboard\/video scaffold/i.test(result.summary.message), 'Expected graph-grounded storyboard summary.');
}

function testImageDescriptionValidationHarness(context) {
  const intent = 'Build a pipeline with image input, model generates description, validate description, retry model step on fail, text output on pass.';
  const weakLocalPlan = parsePipelineWizardPlan(JSON.stringify({
    recipeId: WIZARD_RECIPE_IDS.TEXT_RESPONSE,
    title: 'Text response draft',
    summary: 'This draft validates an image description and retries on failure.',
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: weakLocalPlan,
    wizardTarget: { mode: 'ollama', model: 'phi4-mini:3.8b' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.summary.recipeLabel, 'Intent IR graph', 'Expected image-description recovery to use the generic IR path.');
  assert.strictEqual(result.plan.intentIrRepair.applied, true, 'Expected obligation repair to rebuild the weak local image-description request.');
  for (const expectedType of ['imageInput', 'llmPrompt', 'validation', 'retryLoop', 'textOutput']) {
    assert(result.pipeline.nodes.some((node) => node.type === expectedType), 'Expected image description draft to include ' + expectedType + '.');
  }
  assert.strictEqual(result.pipeline.nodes[0].type, 'imageInput', 'Expected the requested image input modality to be preserved.');
  assert.strictEqual(result.summary.resultState, 'repaired', 'Expected repaired image-description draft to be classified as repaired.');
  assert(/repaired and compiled the requested workflow/i.test(result.summary.message), 'Summary should describe the repaired IR graph.');
  assert(!/This draft validates an image description/.test(result.summary.message), 'Summary should not reuse the weak model summary after repair.');
  assert(result.summary.gaps.some((gap) => /vision-capable provider\/model|read image inputs/i.test(gap)), 'Expected honest vision-capability note.');
}
function testExplicitTextOutputStaysText(context) {
  const intent = 'Build a pipeline that starts with an image input, uses a model to generate a text description of the image, validates that description, retries or regenerates the description if validation fails, and sends the approved description to a text output.';
  const weakLocalPlan = parsePipelineWizardPlan(JSON.stringify({
    recipeId: WIZARD_RECIPE_IDS.TEXT_RESPONSE,
    title: 'Text response draft',
    summary: 'This draft creates an image description workflow.',
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: weakLocalPlan,
    wizardTarget: { mode: 'ollama', model: 'phi4-mini:3.8b' },
  });
  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.summary.resultState, 'repaired', 'Expected the explicit text-output request to be repaired into a useful graph.');
  for (const expectedType of ['imageInput', 'llmPrompt', 'validation', 'retryLoop', 'textOutput']) {
    assert(result.pipeline.nodes.some((node) => node.type === expectedType), 'Expected repaired text-output graph to include ' + expectedType + '.');
  }
  assert.strictEqual(result.pipeline.nodes.some((node) => node.type === 'imageGenerate'), false, 'Explicit text-output request should not drift into image generation.');
  assert.strictEqual(result.pipeline.nodes.some((node) => node.type === 'imageOutput'), false, 'Explicit text-output request should not end in image output.');
  assert(/repaired and compiled the requested workflow/i.test(result.summary.message), 'Expected repaired messaging for the explicit text-output request.');
}
function testFallbackPlanningRecoveryIsNotPlaceholder(context) {
  const intent = 'Turn this episode outline into a longform scene plan, validate it, retry on failure, then expose approved scene prompts as an ordered collection.';
  const fallbackPlan = parsePipelineWizardPlan('', { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: fallbackPlan,
    wizardTarget: { mode: 'ollama', model: 'phi4-mini:3.8b' },
  });
  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.summary.resultState, 'repaired', 'Expected empty-plan recovery to be classified as repaired, not placeholder.');
  assert.strictEqual(result.summary.recipeLabel, 'Intent IR graph', 'Expected empty-plan recovery to still surface the useful intent graph label.');
  assert(!/placeholder/i.test(result.summary.message), 'Useful recovered planning graph should not be described as a placeholder.');
  assert(/repaired and compiled the requested workflow/i.test(result.summary.message), 'Expected empty-plan recovery summary to describe repaired compilation.');
  for (const expectedType of ['planningPacket', 'planner', 'validation', 'retryLoop', 'planScenes', 'collectionOutput']) {
    assert(result.pipeline.nodes.some((node) => node.type === expectedType), 'Expected recovered planning graph to include ' + expectedType + '.');
  }
}
function testHallucinatedPlanFallsBack(context) {
  const intent = 'Transcribe an interview audio file into text.';
  const plan = parsePipelineWizardPlan('{"recipeId":"invented-graph","steps":[{"operationId":"magic","targetKind":"dragon"}]}', { intent });
  assert.strictEqual(plan.recipeId, WIZARD_RECIPE_IDS.AUDIO_TRANSCRIBE, 'Expected heuristic fallback to transcription recipe.');
  assert.strictEqual(inferRecipeIdFromIntent(intent), WIZARD_RECIPE_IDS.AUDIO_TRANSCRIBE);

  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: plan,
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });
  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.pipeline.nodes.some((node) => node.type === 'whisperTranscribe'), 'Expected hallucinated plan to instantiate only the bounded Whisper transcription recipe.');
}

const context = buildPipelineWizardContext({ hardware, manifests: tools, providers, tools });
testWizardPromptBoundary(context);
testLocalWizardPromptIsCompactAndGrounded(context);
testTextToImageDraft(context);
testIntentIrTextToImageDraft(context);
testIntentIrPlanningValidationRetryDraft(context);
testIntentIrLocalImageDescriptionValidationDraft(context);
testFlexibleGraphDraft(context);
testScenePlanDraft(context);
testComplexStoryboardVideoScaffold(context);
testImageDescriptionValidationHarness(context);
testExplicitTextOutputStaysText(context);
testFallbackPlanningRecoveryIsNotPlaceholder(context);
testPartialStoryboardDraftStaysFlexible(context);
testHallucinatedPlanFallsBack(context);

console.log('Pipeline wizard verifier passed.');

