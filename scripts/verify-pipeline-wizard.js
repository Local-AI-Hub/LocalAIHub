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
  buildPipelineWizardStructuredOutputRequest,
  getPipelineWizardRequestProfile,
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
  {
    id: 'google',
    isConnected: true,
    lastTestSucceeded: true,
    lastTestedAt: new Date().toISOString(),
    name: 'Google Gemini',
  },
  {
    id: 'xai',
    isConnected: true,
    lastTestSucceeded: true,
    lastTestedAt: new Date().toISOString(),
    name: 'xAI',
  },
];

const assetLibraries = {
  soundEffects: [
    {
      id: 'sfx-halloween',
      name: 'Halloween Sounds',
      items: [{ id: 'door-creak', name: 'Door creak' }, { id: 'wind-gust', name: 'Wind gust' }],
    },
    {
      id: 'sfx-ambience',
      name: 'Ambience Beds',
      items: [{ id: 'night-ambience', name: 'Night ambience' }],
    },
  ],
  fonts: [
    {
      id: 'font-horror',
      name: 'Horror Fonts',
      items: [{ id: 'nosifer-regular', name: 'Nosifer Regular' }],
    },
  ],
  colorPalettes: [
    {
      id: 'palette-horror',
      name: 'Horror Palette',
      items: [
        { id: 'blood-red', name: 'Blood red', hex: '#c1121f' },
        { id: 'bone-white', name: 'Bone white', hex: '#f8f0dd' },
        { id: 'grave-black', name: 'Grave black', hex: '#050505' },
      ],
    },
  ],
};

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

function buildMediaCapabilityContext(overrides = {}) {
  const mediaTools = [
    ...tools,
    {
      compatibility: { minimumRamMb: 8192, minimumVramMb: 4096, recommendedRamMb: 16384, recommendedVramMb: 8192 },
      id: 'audiocraft-webui',
      installDir: 'C:/mock/audiocraft',
      launchProfile: { kind: 'python-script', pythonPath: 'C:/mock/python.exe' },
      name: 'AudioCraft WebUI',
      status: 'stopped',
    },
    {
      id: 'rvc',
      installDir: 'C:/mock/rvc',
      launchProfile: { kind: 'python-script', pythonPath: 'C:/mock/python.exe' },
      name: 'RVC',
      status: 'stopped',
    },
    {
      compatibility: { minimumRamMb: 8192, minimumVramMb: 4096, recommendedRamMb: 16384, recommendedVramMb: 8192 },
      id: 'chatterbox-tts',
      installDir: 'C:/mock/chatterbox',
      launchProfile: { kind: 'python-script', pythonPath: 'C:/mock/python.exe' },
      name: 'Chatterbox-Turbo TTS',
      status: 'stopped',
    },
    {
      compatibility: { minimumRamMb: 16384, minimumVramMb: 8192, recommendedRamMb: 32768, recommendedVramMb: 12288 },
      id: 'wan21-webui',
      installDir: 'C:/mock/wan21',
      launchProfile: { kind: 'python-script', pythonPath: 'C:/mock/python.exe' },
      name: 'Wan2.1 WebUI',
      status: 'stopped',
    },
    {
      id: 'upscayl',
      installDir: 'C:/mock/upscayl',
      launchProfile: { kind: 'binary', executable: 'C:/mock/upscayl.exe' },
      name: 'Upscayl',
      status: 'stopped',
    },
    {
      id: 'facefusion',
      installDir: 'C:/mock/facefusion',
      launchProfile: { kind: 'python-script', pythonPath: 'C:/mock/python.exe' },
      name: 'FaceFusion',
      status: 'stopped',
    },
  ];
  const selectedTools = overrides.tools || mediaTools;
  return buildPipelineWizardContext({
    hardware: overrides.hardware || hardware,
    manifests: overrides.manifests || selectedTools,
    providers: overrides.providers || providers,
    tools: selectedTools,
  });
}

function getModelStepByOperation(pipeline, operationId) {
  return pipeline.nodes.find((node) => node.type === 'llmPrompt' && node.config?.operationId === operationId) || null;
}

function assertNoInventedRuntimeFileOrModelPaths(pipeline) {
  for (const node of pipeline.nodes) {
    if (['imageInput', 'audioInput', 'videoInput', 'fileInput'].includes(node.type)) {
      assert.strictEqual(node.config.filePath, '', node.label + ' should remain an empty runtime placeholder.');
    }
    if (node.type === 'llmPrompt' && node.config?.operationId === 'audioTransform') {
      assert.strictEqual(node.config.model, '', 'RVC voice model selection should remain a visible manual configuration requirement.');
    }
  }
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
  assert(localPrompt.includes('llmPrompt|'), 'Local prompt should include the unified Model Step node signature.');
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
  assert(result.pipeline.nodes.some((node) => node.type === 'llmPrompt' && node.config.operationId === 'imageGenerate' && node.config.toolId === 'automatic1111'), 'Expected Local AI Hub to infer grounded local image generation through Model Step.');
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
  assert(result.pipeline.nodes.some((node) => node.type === 'llmPrompt' && node.config.operationId === 'imageGenerate' && node.config.toolId === 'automatic1111'), 'Expected grounded Automatic1111 image generation through Model Step.');
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
  assert(result.pipeline.nodes.some((node) => node.type === 'collectionMap'), 'Expected repaired storyboard draft to map scene prompts through collection image generation.');
  assert(result.pipeline.nodes.some((node) => node.type === 'mediaExport'), 'Expected supported image collection to video export to compile now that collectionMap exists.');
  assert(result.pipeline.nodes.length > 10, 'Expected the repaired draft to avoid collapsing to a shallow three-node graph.');
  assert.strictEqual(result.summary.gaps.some((gap) => /does not yet map each collection item through image generation automatically/i.test(gap)), false, 'Collection-to-image should no longer be reported as an unsupported bridge.');
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
function testCollectionTextPromptsToImagesDraft(context) {
  const intent = 'turn a collection of text prompts into a collection of images';
  const fallbackPlan = parsePipelineWizardPlan('', { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: fallbackPlan,
    wizardTarget: { mode: 'cloud', providerId: 'google', model: 'gemini-2.5-flash' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  for (const expectedType of ['collectionInput', 'collectionMap', 'collectionOutput']) {
    assert(result.pipeline.nodes.some((node) => node.type === expectedType), 'Expected collection-aware prompt-to-image graph to include ' + expectedType + '.');
  }
  assert.strictEqual(result.pipeline.nodes.some((node) => node.type === 'collectionBuilder'), false, 'Explicit prompt collections should not require a synthetic Collection Builder.');
  assert.strictEqual(result.pipeline.nodes.some((node) => node.type === 'imageOutput'), false, 'Collection request should not collapse to a single image output.');
  assert.strictEqual(result.pipeline.nodes.some((node) => node.type === 'imageGenerate'), false, 'Collection request should use collectionMap rather than a single imageGenerate node.');
  assert(/Collection Input -> Map Collection -> Collection Output/i.test(result.summary.message), 'Summary should describe collection-aware lowering.');
}

function testPlanScenesCanMapToImages(context) {
  const intent = 'plan scenes, then generate one image per scene';
  const fallbackPlan = parsePipelineWizardPlan('', { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: fallbackPlan,
    wizardTarget: { mode: 'cloud', providerId: 'google', model: 'gemini-2.5-flash' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  for (const expectedType of ['planningPacket', 'planner', 'planScenes', 'collectionMap', 'collectionOutput']) {
    assert(result.pipeline.nodes.some((node) => node.type === expectedType), 'Expected scene-to-image draft to include ' + expectedType + '.');
  }
  assert.strictEqual(result.summary.gaps.some((gap) => /collection item through image generation automatically/i.test(gap)), false, 'Scene image mapping should not be reported as unsupported.');
}

function testUnsupportedCollectionMappingStaysHonest(context) {
  const intent = 'collection mapping verification';
  const plan = parsePipelineWizardPlan(JSON.stringify({
    title: 'Cloud image collection mapping',
    intentIr: {
      sources: [{ name: 'sourceImage', modality: 'image', role: 'Source image' }],
      artifacts: [
        { name: 'imageCollection', kind: 'collection:image' },
        { name: 'generatedImages', kind: 'collection:image' },
      ],
      stages: [
        { id: 'collectImages', kind: 'build_collection', input: 'sourceImage', output: 'imageCollection' },
        { id: 'mapImages', kind: 'generate_image', input: 'imageCollection', output: 'generatedImages', mappingMode: 'cloudImageToImage' },
      ],
      outputs: [{ artifact: 'generatedImages', kind: 'collection:image', title: 'Generated images' }],
    },
  }), { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: plan,
    wizardTarget: { mode: 'cloud', providerId: 'google', model: 'gemini-2.5-flash' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.pipeline.nodes.some((node) => node.type === 'collectionBuilder'), 'Expected source collection to be preserved.');
  const mapNode = result.pipeline.nodes.find((node) => node.type === 'collectionMap');
  assert(mapNode, 'Expected image collection mapping to lower to collectionMap.');
  assert.strictEqual(mapNode.config.mappingId, 'cloudImageToImage', 'Expected image collection mapping to use cloud image-to-image.');
  assert.strictEqual(mapNode.config.executionMode, 'cloud', 'Expected image collection mapping to use a cloud provider.');
  assert.strictEqual(mapNode.config.providerId, 'google', 'Expected image collection mapping to keep the Google provider target.');
}

function testGeminiVideoInputTextGeneration(context) {
  const intent = 'summarize a video file';
  const fallbackPlan = parsePipelineWizardPlan('', { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: fallbackPlan,
    wizardTarget: { mode: 'cloud', providerId: 'google', model: 'gemini-2.5-flash' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.pipeline.nodes.some((node) => node.type === 'videoInput'), 'Expected requested video source to be preserved.');
  assert(result.pipeline.nodes.some((node) => node.type === 'llmPrompt'), 'Expected video to feed a text-generation model step.');
  assert(result.pipeline.nodes.some((node) => node.type === 'textOutput'), 'Expected text output for video summary.');
  assert.strictEqual(result.summary.gaps.some((gap) => /does not accept video/i.test(gap)), false, 'Gemini video input should be treated as supported by capability declarations.');
}

function testUnsupportedVideoInputProviderIsSurfaced(context) {
  const intent = 'summarize a video file';
  const fallbackPlan = parsePipelineWizardPlan('', { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: fallbackPlan,
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.pipeline.nodes.some((node) => node.type === 'videoInput'), 'Expected unsupported provider case to preserve requested video source.');
  assert(result.pipeline.nodes.some((node) => node.type === 'llmPrompt'), 'Expected editable model step to remain visible for provider correction.');
  assert(result.summary.gaps.some((gap) => /does not accept video inputs/i.test(gap)), 'Expected honest unsupported provider/model gap.');
}

function testFileInputTextGenerationForSupportedProvider(context) {
  const intent = 'review a document file and summarize it';
  const fallbackPlan = parsePipelineWizardPlan('', { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: fallbackPlan,
    wizardTarget: { mode: 'cloud', providerId: 'google', model: 'gemini-2.5-flash' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.pipeline.nodes.some((node) => node.type === 'fileInput'), 'Expected requested file source to be preserved.');
  assert(result.pipeline.nodes.some((node) => node.type === 'llmPrompt'), 'Expected file to feed a text-generation model step.');
  assert(result.pipeline.nodes.some((node) => node.type === 'textOutput'), 'Expected text output for file review.');
}


function testAudioGenerationIntentIrDraft() {
  const context = buildMediaCapabilityContext();
  const intent = 'generate background music from a text prompt';
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.pipeline.nodes.some((node) => node.type === 'textInput'), 'Expected text prompt placeholder for audio generation.');
  const step = getModelStepByOperation(result.pipeline, 'audioGenerate');
  assert(step, 'Expected audio generation to compile through a Model Step operation.');
  assert.strictEqual(step.config.executionMode, 'localTool', 'Expected installed AudioCraft to be preferred for local audio generation.');
  assert.strictEqual(step.config.toolId, 'audiocraft-webui', 'Expected AudioCraft for generated music/audio.');
  assert(result.pipeline.nodes.some((node) => node.type === 'audioOutput'), 'Expected audio output node.');
  assertNoInventedRuntimeFileOrModelPaths(result.pipeline);
  assertRuntimeConfigsDoNotContainIntent(result.pipeline, intent);
}

function testAudioTransformRvcIntentIrDraft() {
  const context = buildMediaCapabilityContext();
  const intent = 'convert a voiceover using RVC';
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.pipeline.nodes.some((node) => node.type === 'audioInput'), 'Expected audio file placeholder for RVC conversion.');
  const step = getModelStepByOperation(result.pipeline, 'audioTransform');
  assert(step, 'Expected RVC voice conversion to compile through audioTransform.');
  assert.strictEqual(step.config.toolId, 'rvc', 'Expected installed RVC to be selected.');
  assert(result.pipeline.nodes.some((node) => node.type === 'audioOutput'), 'Expected transformed audio output.');
  assert(result.summary.gaps.some((gap) => /voice model/i.test(gap)), 'Expected visible voice-model configuration requirement.');
  assertNoInventedRuntimeFileOrModelPaths(result.pipeline);
  assertRuntimeConfigsDoNotContainIntent(result.pipeline, intent);
}

function testVideoGenerationFromTextIntentIrDraft() {
  const context = buildMediaCapabilityContext();
  const intent = 'generate a video from a text prompt';
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.pipeline.nodes.some((node) => node.type === 'textInput'), 'Expected text prompt placeholder for text-to-video.');
  assert(getModelStepByOperation(result.pipeline, 'videoGenerate'), 'Expected videoGenerate model step.');
  assert(result.pipeline.nodes.some((node) => node.type === 'videoOutput'), 'Expected video output node.');
  assert(result.summary.gaps.some((gap) => /Wan2.1|hardware|reduced settings|practical fit/i.test(gap)), 'Expected honest Wan hardware/readiness warning on GTX 1060-class hardware.');
  assertNoInventedRuntimeFileOrModelPaths(result.pipeline);
}

function testVideoGenerationFromImageIntentIrDraft() {
  const context = buildMediaCapabilityContext();
  const intent = 'turn an image input into a video';
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.pipeline.nodes.some((node) => node.type === 'imageInput'), 'Expected image file placeholder for image-to-video.');
  assert(getModelStepByOperation(result.pipeline, 'videoGenerate'), 'Expected image-to-video to compile through videoGenerate.');
  assert(result.pipeline.nodes.some((node) => node.type === 'videoOutput'), 'Expected video output node.');
  assert.strictEqual(result.summary.gaps.some((gap) => /only generate images from text/i.test(gap)), false, 'Image-to-video should not fall into image-generation gaps.');
  assertNoInventedRuntimeFileOrModelPaths(result.pipeline);
}

function testImageUpscaleIntentIrDraft() {
  const context = buildMediaCapabilityContext();
  const intent = 'upscale an image';
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.pipeline.nodes.some((node) => node.type === 'imageInput'), 'Expected image placeholder for upscaling.');
  const step = getModelStepByOperation(result.pipeline, 'imageTransform');
  assert(step, 'Expected imageTransform model step for upscaling.');
  assert.strictEqual(step.config.toolId, 'upscayl', 'Expected Upscayl to be preferred for generic upscale/enhance requests.');
  assert(result.pipeline.nodes.some((node) => node.type === 'imageOutput'), 'Expected image output node.');
  assertNoInventedRuntimeFileOrModelPaths(result.pipeline);
}

function testFaceFusionIntentIrDraft() {
  const context = buildMediaCapabilityContext();
  const intent = 'swap a face using a reference image';
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert.strictEqual(result.pipeline.nodes.filter((node) => node.type === 'imageInput').length, 2, 'Expected target and reference image placeholders.');
  const step = getModelStepByOperation(result.pipeline, 'imageTransform');
  assert(step, 'Expected FaceFusion to compile through imageTransform.');
  assert.strictEqual(step.config.toolId, 'facefusion', 'Expected FaceFusion for face-swap requests.');
  assert(result.pipeline.edges.some((edge) => edge.target?.nodeId === step.id && edge.target?.portId === 'referenceImage'), 'Expected reference image to connect to the Model Step reference input.');
  assertNoInventedRuntimeFileOrModelPaths(result.pipeline);
}

function testUnavailableLocalTransformStaysHonest() {
  const context = buildMediaCapabilityContext({ tools, manifests: tools, providers: [] });
  const intent = 'convert a voiceover using RVC';
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud' },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  const step = getModelStepByOperation(result.pipeline, 'audioTransform');
  assert(step, 'Expected unsupported RVC request to remain an editable audioTransform graph.');
  assert.strictEqual(step.config.executionMode, 'localTool', 'Unavailable RVC should stay on the local operation path instead of pretending cloud support.');
  assert.strictEqual(step.config.toolId, '', 'Unavailable RVC should not invent a selected tool installation.');
  assert(result.summary.gaps.some((gap) => /Install RVC/i.test(gap)), 'Expected honest missing-RVC readiness gap.');
  assertNoInventedRuntimeFileOrModelPaths(result.pipeline);
}

function buildDirectIrDraft({ context, intent, intentIr, wizardTarget }) {
  const plan = parsePipelineWizardPlan(JSON.stringify({ title: 'Pass 1 direct IR fixture', intentIr }), { intent });
  return buildPipelineWizardDraft({ context, intent, modelPlan: plan, wizardTarget });
}

function getFirstCollectionMap(pipeline) {
  return pipeline.nodes.find((node) => node.type === 'collectionMap') || null;
}

function testCloudImageGenerationPassOneDrafts(context) {
  const textImage = buildDirectIrDraft({
    context,
    intent: 'Generate a cloud image with OpenAI.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-image-1' },
    intentIr: {
      sources: [{ name: 'prompt', modality: 'text', role: 'Prompt' }],
      stages: [{ id: 'image', kind: 'generate_image', input: 'prompt', output: 'generatedImage', operationSubtype: 'textToImage', providerPreference: 'openai' }],
      outputs: [{ artifact: 'generatedImage', kind: 'image', title: 'Generated image' }],
    },
  });
  assertNoStructuralErrors(textImage.pipeline);
  const imageStep = getModelStepByOperation(textImage.pipeline, 'imageGenerate');
  assert(imageStep, 'Expected cloud text-to-image to lower through Model Step imageGenerate.');
  assert.strictEqual(imageStep.config.executionMode, 'cloud');
  assert.strictEqual(imageStep.config.providerId, 'openai');

  const imageEdit = buildDirectIrDraft({
    context,
    intent: 'Edit this source image with OpenAI.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-image-1' },
    intentIr: {
      sources: [{ name: 'sourceImage', modality: 'image', role: 'Source image' }],
      stages: [{ id: 'edit', kind: 'generate_image', input: 'sourceImage', output: 'editedImage', operationSubtype: 'imageToImage', providerPreference: 'openai' }],
      outputs: [{ artifact: 'editedImage', kind: 'image', title: 'Edited image' }],
    },
  });
  assertNoStructuralErrors(imageEdit.pipeline);
  assert(imageEdit.pipeline.nodes.some((node) => node.type === 'imageInput'), 'Expected image-to-image to preserve image input.');
  const editStep = getModelStepByOperation(imageEdit.pipeline, 'imageGenerate');
  assert(editStep, 'Expected cloud image-to-image to lower through Model Step imageGenerate.');
  assert.strictEqual(editStep.config.executionMode, 'cloud');
  assert.strictEqual(editStep.config.providerId, 'openai');
}

function testCloudImageCollectionMapPassOneDrafts(context) {
  const textMap = buildDirectIrDraft({
    context,
    intent: 'Generate one cloud image per prompt.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-image-1' },
    intentIr: {
      sources: [{ name: 'prompts', modality: 'collection:text', role: 'Prompts' }],
      stages: [{ id: 'mapImages', kind: 'generate_image', input: 'prompts', output: 'images', mappingMode: 'textToImage', providerPreference: 'openai' }],
      outputs: [{ artifact: 'images', kind: 'collection:image', title: 'Images' }],
    },
  });
  assertNoStructuralErrors(textMap.pipeline);
  const textMapNode = getFirstCollectionMap(textMap.pipeline);
  assert(textMapNode, 'Expected collection text-to-image to lower to collectionMap.');
  assert.strictEqual(textMapNode.config.mappingId, 'textToImage');
  assert.strictEqual(textMapNode.config.providerId, 'openai');

}
function testCloudVideoGenerationPassOneDrafts(context) {
  const textVideo = buildDirectIrDraft({
    context,
    intent: 'Generate a Google cloud video from text.',
    wizardTarget: { mode: 'cloud', providerId: 'google', model: 'models/veo-3.1-generate-preview' },
    intentIr: {
      sources: [{ name: 'prompt', modality: 'text', role: 'Prompt' }],
      stages: [{ id: 'video', kind: 'generate_video', input: 'prompt', output: 'video', operationSubtype: 'textToVideo', providerPreference: 'google' }],
      outputs: [{ artifact: 'video', kind: 'video', title: 'Video' }],
    },
  });
  assertNoStructuralErrors(textVideo.pipeline);
  const textVideoStep = getModelStepByOperation(textVideo.pipeline, 'videoGenerate');
  assert(textVideoStep, 'Expected cloud text-to-video to lower through Model Step videoGenerate.');
  assert.strictEqual(textVideoStep.config.executionMode, 'cloud');
  assert.strictEqual(textVideoStep.config.providerId, 'google');

  const imageVideo = buildDirectIrDraft({
    context,
    intent: 'Generate an xAI video from this image.',
    wizardTarget: { mode: 'cloud', providerId: 'xai', model: 'grok-imagine-video' },
    intentIr: {
      sources: [{ name: 'sourceImage', modality: 'image', role: 'Source image' }],
      stages: [{ id: 'video', kind: 'generate_video', input: 'sourceImage', output: 'video', operationSubtype: 'imageToVideo', providerPreference: 'xai' }],
      outputs: [{ artifact: 'video', kind: 'video', title: 'Video' }],
    },
  });
  assertNoStructuralErrors(imageVideo.pipeline);
  assert(imageVideo.pipeline.nodes.some((node) => node.type === 'imageInput'), 'Expected image-to-video to preserve image input.');
  const imageVideoStep = getModelStepByOperation(imageVideo.pipeline, 'videoGenerate');
  assert(imageVideoStep, 'Expected cloud image-to-video to lower through Model Step videoGenerate.');
  assert.strictEqual(imageVideoStep.config.executionMode, 'cloud');
  assert.strictEqual(imageVideoStep.config.providerId, 'xai');
}

function testCloudVideoCollectionMapPassOneDrafts(context) {
  const textMap = buildDirectIrDraft({
    context,
    intent: 'Generate one Google video per prompt and chain previous last frames.',
    wizardTarget: { mode: 'cloud', providerId: 'google', model: 'models/veo-3.1-generate-preview' },
    intentIr: {
      sources: [{ name: 'prompts', modality: 'collection:text', role: 'Prompts' }],
      stages: [{ id: 'mapVideos', kind: 'generate_video', input: 'prompts', output: 'videos', mappingMode: 'textToVideo', providerPreference: 'google', previousLastFrameChaining: true }],
      outputs: [{ artifact: 'videos', kind: 'collection:video', title: 'Videos' }],
    },
  });
  assertNoStructuralErrors(textMap.pipeline);
  const textMapNode = getFirstCollectionMap(textMap.pipeline);
  assert(textMapNode, 'Expected collection text-to-video to lower to collectionMap.');
  assert.strictEqual(textMapNode.config.mappingId, 'textToVideo');
  assert.strictEqual(textMapNode.config.providerId, 'google');
  assert.strictEqual(textMapNode.config.videoItemMode, 'sequentialLastFrame');

  const imageMap = buildDirectIrDraft({
    context,
    intent: 'Generate one xAI video per source image.',
    wizardTarget: { mode: 'cloud', providerId: 'xai', model: 'grok-imagine-video' },
    intentIr: {
      sources: [{ name: 'images', modality: 'collection:image', role: 'Images' }],
      stages: [{ id: 'mapVideos', kind: 'generate_video', input: 'images', output: 'videos', mappingMode: 'cloudImageToVideo', providerPreference: 'xai' }],
      outputs: [{ artifact: 'videos', kind: 'collection:video', title: 'Videos' }],
    },
  });
  assertNoStructuralErrors(imageMap.pipeline);
  const imageMapNode = getFirstCollectionMap(imageMap.pipeline);
  assert(imageMapNode, 'Expected collection image-to-video to lower to collectionMap.');
  assert.strictEqual(imageMapNode.config.mappingId, 'cloudImageToVideo');
  assert.strictEqual(imageMapNode.config.providerId, 'xai');
}

function testCloudVideoProviderFilteringPassOne() {
  const context = buildMediaCapabilityContext({
    providers: providers.filter((provider) => provider.id === 'openai'),
    tools: tools,
  });
  const result = buildDirectIrDraft({
    context,
    intent: 'Generate an OpenAI Sora video from this prompt.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'sora-2' },
    intentIr: {
      sources: [{ name: 'prompt', modality: 'text', role: 'Prompt' }],
      stages: [{ id: 'video', kind: 'generate_video', input: 'prompt', output: 'video', operationSubtype: 'textToVideo', providerPreference: 'openai' }],
      outputs: [{ artifact: 'video', kind: 'video', title: 'Video' }],
    },
  });
  assertNoStructuralErrors(result.pipeline);
  const videoStep = getModelStepByOperation(result.pipeline, 'videoGenerate');
  assert(videoStep, 'Expected unsupported OpenAI video request to remain editable.');
  assert.notStrictEqual(videoStep.config.providerId, 'openai', 'OpenAI must not be selected for wizard cloud video generation.');
  assert(result.summary.gaps.some((gap) => /OpenAI\/Sora video is not available|Google or xAI/i.test(gap)), 'Expected OpenAI video provider filtering gap.');
}

function testChatterboxReferenceVoicePassOneDrafts() {
  const context = buildMediaCapabilityContext();
  const single = buildDirectIrDraft({
    context,
    intent: 'Use this reference voice audio to say the text.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
    intentIr: {
      sources: [
        { name: 'speechText', modality: 'text', role: 'Speech text' },
        { name: 'referenceVoiceAudio', modality: 'audio', role: 'Reference voice audio' },
      ],
      stages: [{ id: 'voice', kind: 'generate_audio', input: 'speechText', inputs: ['speechText', 'referenceVoiceAudio'], output: 'voiceAudio', operationSubtype: 'referenceVoiceTts', referenceAudio: 'referenceVoiceAudio' }],
      outputs: [{ artifact: 'voiceAudio', kind: 'audio', title: 'Voice audio' }],
    },
  });
  assertNoStructuralErrors(single.pipeline);
  const voiceStep = getModelStepByOperation(single.pipeline, 'audioGenerate');
  assert(voiceStep, 'Expected Reference Voice TTS to lower through Model Step audioGenerate.');
  assert.strictEqual(voiceStep.config.executionMode, 'localTool');
  assert.strictEqual(voiceStep.config.toolId, 'chatterbox-tts');
  assert.strictEqual(voiceStep.config.audioMode, 'referenceVoiceTts');
  assert(single.pipeline.edges.some((edge) => edge.target.nodeId === voiceStep.id && edge.target.portId === 'referenceAudio'), 'Expected Reference Voice TTS Model Step to receive referenceAudio.');

  const collection = buildDirectIrDraft({
    context,
    intent: 'Use one shared reference voice audio for each line in this collection.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
    intentIr: {
      sources: [
        { name: 'voiceLines', modality: 'collection:text', role: 'Voice lines' },
        { name: 'referenceVoiceAudio', modality: 'audio', role: 'Reference voice audio' },
      ],
      stages: [{ id: 'voiceLines', kind: 'generate_audio', input: 'voiceLines', inputs: ['voiceLines', 'referenceVoiceAudio'], output: 'generatedVoiceLines', operationSubtype: 'referenceVoiceTts', mappingMode: 'textToAudio', referenceAudio: 'referenceVoiceAudio' }],
      outputs: [{ artifact: 'generatedVoiceLines', kind: 'collection:audio', title: 'Generated voice lines' }],
    },
  });
  assertNoStructuralErrors(collection.pipeline);
  const mapNode = getFirstCollectionMap(collection.pipeline);
  assert(mapNode, 'Expected Reference Voice TTS collection to lower to collectionMap.');
  assert.strictEqual(mapNode.config.mappingId, 'textToAudio');
  assert.strictEqual(mapNode.config.toolId, 'chatterbox-tts');
  assert.strictEqual(mapNode.config.audioMode, 'referenceVoiceTts');
  assert(collection.pipeline.edges.some((edge) => edge.target.nodeId === mapNode.id && edge.target.portId === 'referenceAudio'), 'Expected Reference Voice TTS collectionMap to receive shared referenceAudio.');
}
function testMediaCompositionPassTwoDrafts(context) {
  const result = buildDirectIrDraft({
    context,
    intent: 'Compose an image collection into a narration-synced slideshow with transitions, background music, and Halloween sound effects.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
    intentIr: {
      sources: [
        { name: 'images', modality: 'collection:image', role: 'Ordered image collection' },
        { name: 'narrationAudio', modality: 'audio', role: 'Narration audio' },
        { name: 'backgroundMusic', modality: 'audio', role: 'Background music' },
      ],
      stages: [
        {
          id: 'compose',
          kind: 'compose_media',
          input: 'images',
          inputs: ['images', 'narrationAudio', 'backgroundMusic'],
          output: 'composition',
          mediaComposition: {
            timingMode: 'dynamicFromImageMetadata',
            fallbackSecondsPerImage: 5,
            transitionsEnabled: true,
            transitionMode: 'randomCategory',
            transitionCategory: 'wipes',
            narrationVolume: 0.82,
            backgroundMusicVolume: 0.2,
            soundEffectsEnabled: true,
            soundEffectsVolume: 0.31,
            soundEffectLibraryRefs: ['Halloween Sounds', 'sfx-ambience'],
          },
        },
        { id: 'export', kind: 'export', input: 'composition', output: 'video' },
      ],
      outputs: [{ artifact: 'video', kind: 'video', title: 'Slideshow video' }],
    },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  const compositionNode = result.pipeline.nodes.find((node) => node.type === 'mediaComposition');
  assert(compositionNode, 'Expected Media Composition node from compose_media IR.');
  assert.strictEqual(compositionNode.config.imageTimingMode, 'dynamicFromImageMetadata');
  assert.strictEqual(compositionNode.config.secondsPerItem, 5);
  assert.strictEqual(compositionNode.config.sceneTransitionMode, 'randomCategory');
  assert.strictEqual(compositionNode.config.sceneTransitionCategory, 'wipes');
  assert.strictEqual(compositionNode.config.narrationVolume, 0.82);
  assert.strictEqual(compositionNode.config.backgroundMusicVolume, 0.2);
  assert.strictEqual(compositionNode.config.soundEffectsEnabled, true);
  assert.strictEqual(compositionNode.config.soundEffectsVolume, 0.31);
  assert.strictEqual(compositionNode.config.soundEffectsLibraryId, 'sfx-halloween');
  assert.deepStrictEqual(compositionNode.config.soundEffectsLayers.map((layer) => layer.libraryId), ['sfx-halloween', 'sfx-ambience']);
  assert(result.pipeline.edges.some((edge) => edge.target.nodeId === compositionNode.id && edge.target.portId === 'audio'), 'Expected narration audio to connect to Media Composition primary audio.');
  assert(result.pipeline.edges.some((edge) => edge.target.nodeId === compositionNode.id && edge.target.portId === 'backgroundMusic'), 'Expected background music to connect to Media Composition backgroundMusic.');
}

function testBurnSubtitlesPassTwoDrafts(context) {
  const result = buildDirectIrDraft({
    context,
    intent: 'Burn large bold horror captions into a video using the Horror Fonts library and Horror Palette, validate it, and retry on failure.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
    intentIr: {
      sources: [
        { name: 'sourceVideo', modality: 'video', role: 'Source video' },
        { name: 'captionText', modality: 'text', role: 'Caption text' },
      ],
      stages: [
        {
          id: 'burnCaptions',
          kind: 'burn_subtitles',
          input: 'sourceVideo',
          inputs: ['sourceVideo', 'captionText'],
          output: 'captionedVideo',
          burnSubtitles: {
            fontLibraryRef: 'Horror Fonts',
            colorPaletteRef: 'Horror Palette',
            position: 'bottomCenter',
            styleIntent: 'large bold horror',
          },
        },
        { id: 'validateCaptions', kind: 'validate', input: 'captionedVideo', output: 'reviewedCaptionedVideo' },
        { id: 'retryCaptions', kind: 'retry', input: 'reviewedCaptionedVideo', output: 'approvedCaptionedVideo', retryTarget: 'burnCaptions', maxAttempts: 4 },
      ],
      outputs: [{ artifact: 'approvedCaptionedVideo', kind: 'video', title: 'Captioned video' }],
    },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  const burnNode = result.pipeline.nodes.find((node) => node.type === 'burnSubtitles');
  assert(burnNode, 'Expected Burn Subtitles node from burn_subtitles IR.');
  assert.strictEqual(burnNode.config.fontSource, 'assetLibrary');
  assert.strictEqual(burnNode.config.fontLibraryId, 'font-horror');
  assert.strictEqual(burnNode.config.fontItemId, 'nosifer-regular');
  assert.strictEqual(burnNode.config.colorSource, 'palette');
  assert.strictEqual(burnNode.config.colorPaletteLibraryId, 'palette-horror');
  assert.strictEqual(burnNode.config.textColorPaletteItemId, 'blood-red');
  assert.strictEqual(burnNode.config.outlineColorPaletteItemId, 'bone-white');
  assert.strictEqual(burnNode.config.backgroundColorPaletteItemId, 'grave-black');
  assert.strictEqual(burnNode.config.position, 'bottomCenter');
  assert.strictEqual(burnNode.config.fontSize, 36);
  assert.strictEqual(burnNode.config.bold, true);
  const retryNode = result.pipeline.nodes.find((node) => node.type === 'retryLoop');
  assert(retryNode, 'Expected retry loop after caption validation.');
  assert.strictEqual(retryNode.config.retryTargetNodeId, burnNode.id, 'Expected caption retry to target Burn Subtitles.');
}
function assertNormalizeDraft({ context, sourceKind, outputKind, nodeType, outputFormat, expectedFormat }) {
  const result = buildDirectIrDraft({
    context,
    intent: 'Normalize or convert media format.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
    intentIr: {
      sources: [{ name: 'sourceMedia', modality: sourceKind, role: 'Source media' }],
      stages: [{ id: 'normalize', kind: 'normalize_media', input: 'sourceMedia', output: 'normalizedMedia', normalizeMedia: { mediaKind: outputKind.replace('collection:', ''), outputFormat } }],
      outputs: [{ artifact: 'normalizedMedia', kind: outputKind, title: 'Normalized media' }],
    },
  });
  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  const normalizeNode = result.pipeline.nodes.find((node) => node.type === nodeType);
  assert(normalizeNode, 'Expected ' + nodeType + ' for ' + sourceKind + ' conversion.');
  assert.strictEqual(normalizeNode.config.outputFormat, expectedFormat);
  assert(!result.pipeline.nodes.some((node) => node.type === 'llmPrompt'), 'Normalize/convert requests should not route through Model Step.');
  assert(result.pipeline.nodes.some((node) => node.type === (String(outputKind).startsWith('collection:') ? 'collectionOutput' : outputKind + 'Output')), 'Expected matching output node for ' + outputKind + '.');
  return result;
}

function testNormalizeMediaPassThreeDrafts(context) {
  assertNormalizeDraft({ context, sourceKind: 'audio', outputKind: 'audio', nodeType: 'normalizeAudioCollection', outputFormat: 'wav', expectedFormat: 'wav' });
  assertNormalizeDraft({ context, sourceKind: 'collection:audio', outputKind: 'collection:audio', nodeType: 'normalizeAudioCollection', outputFormat: 'mp3', expectedFormat: 'mp3' });
  assertNormalizeDraft({ context, sourceKind: 'video', outputKind: 'video', nodeType: 'normalizeVideoCollection', outputFormat: 'mp4', expectedFormat: 'mp4' });
  assertNormalizeDraft({ context, sourceKind: 'collection:video', outputKind: 'collection:video', nodeType: 'normalizeVideoCollection', outputFormat: 'webm', expectedFormat: 'webm' });
  assertNormalizeDraft({ context, sourceKind: 'image', outputKind: 'image', nodeType: 'normalizeImage', outputFormat: 'jpg', expectedFormat: 'jpg' });
  assertNormalizeDraft({ context, sourceKind: 'collection:image', outputKind: 'collection:image', nodeType: 'normalizeImage', outputFormat: 'webp', expectedFormat: 'webp' });

  const unsupported = assertNormalizeDraft({ context, sourceKind: 'audio', outputKind: 'audio', nodeType: 'normalizeAudioCollection', outputFormat: 'aac', expectedFormat: 'auto' });
  assert(unsupported.summary.gaps.some((gap) => /aac|not supported|normalized-format/i.test(gap)), 'Unsupported normalize format should be surfaced as a repairable warning.');
}

function testNormalizeIntentRepairPassThree(context) {
  const audio = buildPipelineWizardDraft({
    context,
    intent: 'convert this mp3 to wav',
    modelPlan: parsePipelineWizardPlan('', { intent: 'convert this mp3 to wav' }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });
  assertNoStructuralErrors(audio.pipeline);
  assert(audio.pipeline.nodes.some((node) => node.type === 'normalizeAudioCollection' && node.config.outputFormat === 'wav'), 'MP3 to WAV should compile to Normalize Audio.');
  assert(!audio.pipeline.nodes.some((node) => node.type === 'llmPrompt'), 'MP3 to WAV should not compile to audio generation or Model Step.');

  const images = buildPipelineWizardDraft({
    context,
    intent: 'convert these images to webp',
    modelPlan: parsePipelineWizardPlan('', { intent: 'convert these images to webp' }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });
  assertNoStructuralErrors(images.pipeline);
  assert(images.pipeline.nodes.some((node) => node.type === 'collectionInput'), 'Collection image conversion should use a collection source.');
  assert(images.pipeline.nodes.some((node) => node.type === 'normalizeImage' && node.config.outputFormat === 'webp'), 'Image collection conversion should compile to Normalize Image.');
}

function testHeavyCooldownPassThreeRunSettings(context) {
  const intent = 'Generate one image per prompt and wait 45 seconds between heavy local generations.';
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-image-1' },
  });
  assertNoStructuralErrors(result.pipeline);
  assert.strictEqual(result.pipeline.runSettings.enableHeavyStepCooldown, true, 'Wizard should enable heavy step cooldown only when requested.');
  assert.strictEqual(result.pipeline.runSettings.heavyStepCooldownSeconds, 45, 'Wizard should parse requested cooldown seconds.');
  assert(!result.pipeline.nodes.some((node) => JSON.stringify(node.config || {}).includes('heavyStepCooldown')), 'Cooldown should stay in pipeline runSettings, not node config.');
}

function testCollectionMapPerItemValidationPassThree(context) {
  const intent = 'Turn a collection of prompts into images, review each generated image, and retry failed items.';
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-image-1' },
  });
  assertNoStructuralErrors(result.pipeline);
  const mapNode = getFirstCollectionMap(result.pipeline);
  assert(mapNode, 'Expected prompt collection image generation to lower to collectionMap.');
  assert.strictEqual(mapNode.config.perItemValidation?.enabled, true, 'Per-item validation should be enabled for each generated item review.');
  assert.strictEqual(mapNode.config.perItemValidation?.mode, 'user');
  assert.strictEqual(mapNode.config.perItemValidation?.maxAttempts, 3, 'Retry failed items should raise per-item attempts.');
  assert.strictEqual(mapNode.config.failureMode, 'fail-fast');
}

function testWholeCollectionValidationStillSupportedPassThree(context) {
  const result = buildDirectIrDraft({
    context,
    intent: 'Generate images for a prompt collection, then validate the final collection as a whole and retry the map if it fails.',
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-image-1' },
    intentIr: {
      sources: [{ name: 'prompts', modality: 'collection:text', role: 'Prompt collection' }],
      stages: [
        { id: 'mapImages', kind: 'generate_image', input: 'prompts', output: 'images', mappingMode: 'textToImage', providerPreference: 'openai' },
        { id: 'validateCollection', kind: 'validate', input: 'images', output: 'reviewedImages', validationMode: 'llm', purpose: 'Validate the generated image collection as a whole.' },
        { id: 'retryCollection', kind: 'retry', input: 'reviewedImages', output: 'approvedImages', retryTarget: 'mapImages', maxAttempts: 3 },
      ],
      outputs: [{ artifact: 'approvedImages', kind: 'collection:image', title: 'Approved image collection' }],
    },
  });
  assertNoStructuralErrors(result.pipeline);
  const mapNode = getFirstCollectionMap(result.pipeline);
  assert(mapNode, 'Expected whole-collection validation draft to still include collectionMap.');
  assert.notStrictEqual(mapNode.config.perItemValidation?.enabled, true, 'Whole-collection validation should not force per-item collectionMap validation.');
  assert(result.pipeline.nodes.some((node) => node.type === 'validation'), 'Whole-collection validation should still compile to Validation node.');
  assert(result.pipeline.nodes.some((node) => node.type === 'retryLoop'), 'Whole-collection retry should still compile to Retry Loop.');
}
function testDeterministicMediaUtilitiesFinalPass(context) {
  const buildPromptDraft = (intent) => buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });
  const nodeTypes = (result) => result.pipeline.nodes.map((node) => node.type);
  const operationIds = (result) => result.pipeline.nodes.map((node) => node.config?.operationId).filter(Boolean);
  const assertSubsequence = (actual, expected, message) => {
    let cursor = -1;
    for (const item of expected) {
      const nextIndex = actual.findIndex((candidate, index) => index > cursor && candidate === item);
      assert(nextIndex >= 0, message + ' Missing ordered node ' + item + ' in ' + actual.join(' -> '));
      cursor = nextIndex;
    }
  };


  const trimVideo = buildPromptDraft('trim this video to the first 10 seconds');
  assertNoStructuralErrors(trimVideo.pipeline);
  const trimVideoNode = trimVideo.pipeline.nodes.find((node) => node.type === 'trimMedia');
  assert(trimVideoNode, 'Trim video prompt should lower to Trim Media.');
  assert.strictEqual(trimVideoNode.config.startSeconds, 0);
  assert.strictEqual(trimVideoNode.config.endSeconds, 10);
  assert(trimVideo.pipeline.nodes.some((node) => node.type === 'videoOutput'), 'Trim video should keep video output.');
  assert(!trimVideo.pipeline.nodes.some((node) => node.type === 'llmPrompt'), 'Trim video should not use Model Step.');

  const trimAudio = buildPromptDraft('cut this audio from 5 seconds to 20 seconds');
  assertNoStructuralErrors(trimAudio.pipeline);
  const trimAudioNode = trimAudio.pipeline.nodes.find((node) => node.type === 'trimMedia');
  assert(trimAudioNode, 'Trim audio prompt should lower to Trim Media.');
  assert.strictEqual(trimAudioNode.config.startSeconds, 5);
  assert.strictEqual(trimAudioNode.config.endSeconds, 20);
  assert(trimAudio.pipeline.nodes.some((node) => node.type === 'audioOutput'), 'Trim audio should keep audio output.');

  const extractedAudio = buildPromptDraft('extract audio from this video');
  assertNoStructuralErrors(extractedAudio.pipeline);
  assert(extractedAudio.pipeline.nodes.some((node) => node.type === 'extractAudio'), 'Extract audio prompt should lower to Extract Audio.');
  assert(extractedAudio.pipeline.nodes.some((node) => node.type === 'audioOutput'), 'Extract audio should output audio.');
  assert(!extractedAudio.pipeline.nodes.some((node) => node.type === 'llmPrompt'), 'Extract audio should not use Model Step.');

  const lastFrame = buildPromptDraft('grab the last frame from this video');
  assertNoStructuralErrors(lastFrame.pipeline);
  const lastFrameNode = lastFrame.pipeline.nodes.find((node) => node.type === 'extractVideoFrame');
  assert(lastFrameNode, 'Last-frame prompt should lower to Extract Video Frame.');
  assert.strictEqual(lastFrameNode.config.framePosition, 'last');
  assert(lastFrame.pipeline.nodes.some((node) => node.type === 'imageOutput'), 'Extract frame should output image.');

  const defaultFrame = buildPromptDraft('make a thumbnail from this video');
  assertNoStructuralErrors(defaultFrame.pipeline);
  const defaultFrameNode = defaultFrame.pipeline.nodes.find((node) => node.type === 'extractVideoFrame');
  assert(defaultFrameNode, 'Thumbnail prompt should lower to Extract Video Frame.');
  assert.strictEqual(defaultFrameNode.config.framePosition, 'first');
  assert(defaultFrame.summary.gaps.some((gap) => /defaults to the first frame/i.test(gap)), 'Unspecified thumbnail frame should include a first-frame assumption.');

  const exportedSubtitles = buildPromptDraft('export subtitles as srt from this transcript');
  assertNoStructuralErrors(exportedSubtitles.pipeline);
  const exportNode = exportedSubtitles.pipeline.nodes.find((node) => node.type === 'exportSubtitles');
  assert(exportNode, 'Export subtitles prompt should lower to Export Subtitles.');
  assert.strictEqual(exportNode.config.outputFormat, 'srt');
  assert(exportedSubtitles.pipeline.nodes.some((node) => node.type === 'fileOutput'), 'Export subtitles should output a file.');
  assert(!exportedSubtitles.pipeline.nodes.some((node) => node.type === 'burnSubtitles'), 'Export subtitles should not burn captions into video.');

  const burnedSubtitles = buildPromptDraft('burn subtitles into this video');
  assertNoStructuralErrors(burnedSubtitles.pipeline);
  assert(burnedSubtitles.pipeline.nodes.some((node) => node.type === 'burnSubtitles'), 'Burn subtitles prompt should still lower to Burn Subtitles.');
  assert(!burnedSubtitles.pipeline.nodes.some((node) => node.type === 'exportSubtitles'), 'Burn subtitles should not lower to Export Subtitles.');

  const stitchedAudio = buildPromptDraft('stitch these audio clips together');
  assertNoStructuralErrors(stitchedAudio.pipeline);
  assert(stitchedAudio.pipeline.nodes.some((node) => node.type === 'audioStitch'), 'Audio stitch prompt should lower to Audio Stitch.');
  assert(stitchedAudio.pipeline.nodes.some((node) => node.type === 'audioOutput'), 'Audio stitch should output audio.');
  assert(!stitchedAudio.pipeline.nodes.some((node) => node.type === 'videoStitch'), 'Audio stitch should not also lower to Video Stitch.');

  const stitchedVideo = buildPromptDraft('stitch these videos together');
  assertNoStructuralErrors(stitchedVideo.pipeline);
  assert(stitchedVideo.pipeline.nodes.some((node) => node.type === 'videoStitch'), 'Video stitch prompt should lower to Video Stitch.');
  assert(stitchedVideo.pipeline.nodes.some((node) => node.type === 'videoOutput'), 'Video stitch should output video.');

  const slideshow = buildPromptDraft('turn these images into a slideshow video');
  assertNoStructuralErrors(slideshow.pipeline);
  assert(slideshow.pipeline.nodes.some((node) => node.type === 'mediaComposition'), 'Slideshow prompts should still lower to Media Composition.');
  assert(!slideshow.pipeline.nodes.some((node) => node.type === 'videoStitch'), 'Slideshow prompts should not lower to Video Stitch.');

  const audioUtilityToText = buildPromptDraft('start with an audio input, trim that audio to ten seconds, transcribe it, then output the transcript as text');
  assertNoStructuralErrors(audioUtilityToText.pipeline);
  assertSubsequence(nodeTypes(audioUtilityToText), ['audioInput', 'trimMedia', 'llmPrompt', 'textOutput'], 'Audio utility plus transcription chain should preserve ordered stages.');
  assert(operationIds(audioUtilityToText).includes('whisperTranscribe'), 'Audio utility plus transcription should lower transcription through Whisper.');
  const audioUtilityTrim = audioUtilityToText.pipeline.nodes.find((node) => node.type === 'trimMedia');
  assert.strictEqual(audioUtilityTrim.config.endSeconds, 10, 'Trim-to-duration wording should parse number-word seconds.');
  assert(!audioUtilityToText.pipeline.nodes.some((node) => node.type === 'audioOutput'), 'Intermediate trimmed audio should not become the final output when transcript text is requested.');

  const videoUtilityToText = buildPromptDraft('start with a video input, trim the clip to the first ten seconds, extract the audio, transcribe it, then send the transcript to a text output');
  assertNoStructuralErrors(videoUtilityToText.pipeline);
  assertSubsequence(nodeTypes(videoUtilityToText), ['videoInput', 'trimMedia', 'extractAudio', 'llmPrompt', 'textOutput'], 'Video utility plus transcription chain should preserve ordered stages.');
  assert(operationIds(videoUtilityToText).includes('whisperTranscribe'), 'Extracted audio should feed Whisper transcription.');
  assert(!videoUtilityToText.pipeline.nodes.some((node) => node.type === 'videoOutput' || node.type === 'audioOutput'), 'Intermediate video/audio utility artifacts should not become final outputs when transcript text is requested.');

  const audioTrimNormalize = buildPromptDraft('take an audio input, trim it to the first ten seconds, normalize the audio to wav, then output the audio');
  assertNoStructuralErrors(audioTrimNormalize.pipeline);
  assertSubsequence(nodeTypes(audioTrimNormalize), ['audioInput', 'trimMedia', 'normalizeAudioCollection', 'audioOutput'], 'Trim and normalize should compose in user order before audio output.');

  const frameToImage = buildPromptDraft('start with a video input, grab a frame at five seconds, use Google cloud image generation to make a polished variation, then output the image');
  assertNoStructuralErrors(frameToImage.pipeline);
  assertSubsequence(nodeTypes(frameToImage), ['videoInput', 'extractVideoFrame', 'llmPrompt', 'imageOutput'], 'Extracted video frame should feed cloud image generation and finish as an image.');
  assert(operationIds(frameToImage).includes('imageGenerate'), 'Frame-to-image workflow should use image generation, not generic text generation.');
  const timestampFrame = frameToImage.pipeline.nodes.find((node) => node.type === 'extractVideoFrame');
  assert.strictEqual(timestampFrame.config.framePosition, 'timestamp');
  assert.strictEqual(timestampFrame.config.timestampSeconds, 5, 'Frame timestamp should parse number-word seconds.');
  assert(!frameToImage.pipeline.nodes.some((node) => node.type === 'mediaComposition' || node.type === 'textOutput'), 'Image-output workflows should not be routed into composition or text output just because the source is video.');

  const captionBurn = buildPromptDraft('start with a video input and a caption text input, burn subtitles into the video using bold bottom captions, then output the captioned video');
  assertNoStructuralErrors(captionBurn.pipeline);
  assertSubsequence(nodeTypes(captionBurn), ['videoInput', 'textInput', 'burnSubtitles', 'videoOutput'], 'Caption burn should preserve video plus caption inputs and finish as video.');
  assert(!captionBurn.pipeline.nodes.some((node) => node.type === 'llmPrompt' || node.type === 'textOutput'), 'Caption burn should not invent generic text generation or text output.');
}
function testWizardProviderModelLabelAvoidsObjectString(context) {
  const intent = 'Summarize a plain text input.';
  const fallbackPlan = parsePipelineWizardPlan('', { intent });
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: fallbackPlan,
    wizardTarget: { mode: 'cloud', providerId: 'google', model: { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' } },
  });

  assertNoStructuralErrors(result.pipeline);
  assertKnownNodeTypes(result.pipeline);
  assert(result.summary.targetLabel.includes('Google Gemini'), 'Expected provider name in target label.');
  assert(result.summary.targetLabel.includes('gemini-2.5-flash'), 'Expected normalized model id in target label.');
  assert(!result.summary.targetLabel.includes('[object Object]'), 'Provider/model label should not expose object stringification.');
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
  assert(result.pipeline.nodes.some((node) => node.type === 'llmPrompt' && node.config?.operationId === 'whisperTranscribe'), 'Expected hallucinated plan to instantiate bounded Whisper transcription through Model Step.');
}

function testConstrainedWizardPromptIsCompactAndBudgeted(context) {
  const intent = 'Compose an image collection into a narration-synced slideshow with fallback 8 seconds per image, random wipes, narration at 100%, quiet background music, and Halloween sound effects.';
  const target = { mode: 'cloud', providerId: 'groq', model: 'openai/gpt-oss-120b' };
  const profile = getPipelineWizardRequestProfile({ context, intent, wizardTarget: target });
  const messages = buildPipelineWizardMessages({ context, intent, wizardTarget: { ...target, requestProfile: profile } });
  const promptText = JSON.stringify(messages);
  const userPayload = JSON.parse(messages[1].content);
  assert.strictEqual(profile.compactMode, true, 'Groq GPT-OSS wizard requests should use compact mode.');
  assert.strictEqual(profile.maxOutputTokens, 1024, 'Groq GPT-OSS wizard responses should stay within the constrained response budget.');
  assert(promptText.includes('Using compact wizard mode for this model.'), 'Compact mode prompt should include the plain-English compact note.');
  assert(promptText.length < 14000, 'Compact constrained-model prompt should stay small enough to avoid the observed Groq TPM failure.');
  assert(userPayload.allowedNodeTypes.length < context.nodeTypes.length, 'Compact mode should filter node type context to the relevant surface.');
  assert(userPayload.allowedNodeTypes.includes('mediaComposition'), 'Compact media prompts should still include Media Composition.');
  assert(userPayload.allowedNodeTypes.includes('mediaExport'), 'Compact media prompts should still include Media Export.');
  assert(!userPayload.allowedNodeTypes.includes('burnSubtitles'), 'Compact media prompts should omit unrelated node families.');

  const fullSchemaText = JSON.stringify(buildPipelineWizardStructuredOutputRequest());
  const compactSchemaText = JSON.stringify(buildPipelineWizardStructuredOutputRequest({ compactMode: true }));
  assert(compactSchemaText.length < fullSchemaText.length, 'Compact structured output schema should reduce Gemini schema-mode prompt weight.');
}

function testMediaCompositionMalformedRepairReliability(context) {
  const intent = 'Compose an image collection into a narration-synced slideshow with fallback 8 seconds per image, random wipes, narration at 100%, quiet background music, and Halloween sound effects.';
  const result = buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('not valid json', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'google', model: 'gemini-2.5-flash' },
  });
  const nodeTypes = result.pipeline.nodes.map((node) => node.type);
  for (const expectedType of ['collectionInput', 'audioInput', 'mediaComposition', 'mediaExport', 'videoOutput']) {
    assert(nodeTypes.includes(expectedType), 'Malformed media composition repair should include ' + expectedType + '.');
  }
  assert.strictEqual(nodeTypes.filter((type) => type === 'audioInput').length, 2, 'Media composition repair should include narration and background music audio inputs.');
  assert(!nodeTypes.includes('audioOutput'), 'Media composition repair should not recover into an audio output pipeline.');
  const mediaNode = result.pipeline.nodes.find((node) => node.type === 'mediaComposition');
  assert(mediaNode, 'Expected Media Composition node.');
  assert.strictEqual(mediaNode.config.imageTimingMode, 'dynamicFromImageMetadata', 'Narration-synced slideshows should use dynamic image timing.');
  assert.strictEqual(mediaNode.config.secondsPerItem, 8, 'Fallback seconds per image should be preserved from malformed-output repair.');
  assert.strictEqual(mediaNode.config.sceneTransitionMode, 'randomCategory', 'Random wipes should use random transition category mode.');
  assert.strictEqual(mediaNode.config.sceneTransitionCategory, 'wipes', 'Random wipes should preserve the wipes category.');
  assert.strictEqual(mediaNode.config.narrationVolume, 1, 'Narration at 100% should preserve full narration volume.');
  assert.strictEqual(mediaNode.config.backgroundMusicVolume, 0.18, 'Quiet background music should lower only the music mix level.');
  assert.strictEqual(mediaNode.config.soundEffectsEnabled, true, 'Halloween sound effects should enable SFX layers.');
  assert.strictEqual(mediaNode.config.soundEffectsLibraryId, 'sfx-halloween', 'Halloween SFX should resolve the matching asset library when available.');
  assert.strictEqual(mediaNode.config.soundEffectsLayers.length, 1, 'Resolved SFX library should become a SFX layer.');
  assert(!result.summary.gaps.some((gap) => /generatedAudio|audio output/i.test(gap)), 'Media repair should not leave an audio-output gap.');

  const noLibraryContext = buildPipelineWizardContext({ hardware, manifests: tools, providers, tools, assetLibraries: { soundEffects: [], fonts: [], colorPalettes: [] } });
  const missingLibraryResult = buildPipelineWizardDraft({
    context: noLibraryContext,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'google', model: 'gemini-2.5-flash' },
  });
  const missingMediaNode = missingLibraryResult.pipeline.nodes.find((node) => node.type === 'mediaComposition');
  assert(missingMediaNode?.config.soundEffectsEnabled, 'Missing SFX libraries should not disable requested sound effects.');
  assert(missingLibraryResult.summary.gaps.some((gap) => /Sound Effects|asset library/i.test(gap)), 'Missing SFX library should be surfaced as an explicit assumption/gap.');
}
function testRecordInputWizardDrafts(context) {
  const buildPromptDraft = (intent) => buildPipelineWizardDraft({
    context,
    intent,
    modelPlan: parsePipelineWizardPlan('', { intent }),
    wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' },
  });
  const getRecordNode = (result) => result.pipeline.nodes.find((node) => node.type === 'recordInput') || null;
  const hasEdge = (result, sourceNode, sourcePortId, targetNode, targetPortId) => result.pipeline.edges.some((edge) => (
    edge.source.nodeId === sourceNode.id
    && edge.source.portId === sourcePortId
    && edge.target.nodeId === targetNode.id
    && edge.target.portId === targetPortId
  ));
  const assertRecordDraft = (intent, expectedMode, expectedKind) => {
    const result = buildPromptDraft(intent);
    assertNoStructuralErrors(result.pipeline);
    const recordNode = getRecordNode(result);
    assert(recordNode, 'Expected Record Input for: ' + intent);
    assert.strictEqual(recordNode.config.mode, expectedMode, 'Unexpected Record Input mode for: ' + intent);
    assert.strictEqual(recordNode.config.outputKind, expectedKind, 'Unexpected Record Input output kind for: ' + intent);
    assert.strictEqual(recordNode.config.microphoneId, '', 'Wizard must not invent a microphone id.');
    assert.strictEqual(recordNode.config.webcamId, '', 'Wizard must not invent a webcam id.');
    assert.strictEqual(recordNode.config.displayId, '', 'Wizard must not invent a display id.');
    return { result, recordNode };
  };

  assert(context.recordInputCapability?.modes?.some((mode) => mode.id === 'microphone' && mode.outputKind === 'audio'), 'Wizard context should expose microphone Record Input capability.');
  assert(context.recordInputCapability?.modes?.some((mode) => mode.id === 'screenSystemAudio' && mode.outputKind === 'video'), 'Wizard context should expose screen plus system-audio Record Input capability.');
  const promptMessages = buildPipelineWizardMessages({ context, intent: 'record my microphone and transcribe it', wizardTarget: { mode: 'cloud', providerId: 'openai', model: 'gpt-4o-mini' } });
  assert(JSON.stringify(promptMessages).includes('recordInput'), 'Wizard prompt vocabulary should teach the planner about recorded sources.');

  const microphoneAudio = assertRecordDraft('record my microphone and save the audio', 'microphone', 'audio');
  const microphoneAudioOutput = microphoneAudio.result.pipeline.nodes.find((node) => node.type === 'audioOutput');
  assert(microphoneAudioOutput && hasEdge(microphoneAudio.result, microphoneAudio.recordNode, 'audio', microphoneAudioOutput, 'audio'), 'Microphone Record Input should wire its audio port to Audio Output.');
  assert(!microphoneAudio.result.pipeline.nodes.some((node) => node.type === 'videoOutput'), 'Audio-mode Record Input must not wire to Video Output.');

  const microphoneTranscript = assertRecordDraft('record my microphone and transcribe it', 'microphone', 'audio');
  const microphoneWhisper = microphoneTranscript.result.pipeline.nodes.find((node) => node.type === 'llmPrompt' && node.config?.operationId === 'whisperTranscribe');
  assert(microphoneWhisper && hasEdge(microphoneTranscript.result, microphoneTranscript.recordNode, 'audio', microphoneWhisper, 'prompt'), 'Microphone Record Input should feed Whisper transcription.');
  assert(microphoneTranscript.result.pipeline.nodes.some((node) => node.type === 'textOutput'), 'Microphone transcription should end in Text Output.');

  const voiceoverSlideshow = assertRecordDraft('record a voiceover and make a slideshow video', 'microphone', 'audio');
  const slideshowComposition = voiceoverSlideshow.result.pipeline.nodes.find((node) => node.type === 'mediaComposition');
  assert(slideshowComposition, 'Recorded voiceover slideshow should include Media Composition.');
  assert(voiceoverSlideshow.result.pipeline.nodes.some((node) => node.type === 'collectionInput'), 'Recorded voiceover slideshow should leave an image collection placeholder.');
  assert(hasEdge(voiceoverSlideshow.result, voiceoverSlideshow.recordNode, 'audio', slideshowComposition, 'audio'), 'Recorded voiceover should wire to Media Composition narration audio.');
  assert(voiceoverSlideshow.result.pipeline.nodes.some((node) => node.type === 'videoOutput'), 'Recorded voiceover slideshow should produce video output.');

  const systemAudio = assertRecordDraft('record system audio and transcribe it', 'systemAudio', 'audio');
  assert(systemAudio.result.pipeline.nodes.some((node) => node.type === 'llmPrompt' && node.config?.operationId === 'whisperTranscribe'), 'System audio recording should support transcription.');

  const screen = assertRecordDraft('record my screen and save it as a video', 'screen', 'video');
  assert(screen.result.pipeline.nodes.some((node) => node.type === 'videoOutput'), 'Screen recording should produce Video Output.');
  assert(!screen.result.pipeline.nodes.some((node) => node.type === 'audioOutput'), 'Video-mode Record Input must not wire directly to Audio Output.');

  assertRecordDraft('record screen with microphone and save as video', 'screenMic', 'video');
  assertRecordDraft('record webcam with voice and save as video', 'webcamMic', 'video');
  assertRecordDraft('record my screen with system audio and save as video', 'screenSystemAudio', 'video');

  const region = assertRecordDraft('record a screen region and save it as a video', 'screen', 'video');
  assert.deepStrictEqual(region.recordNode.config.captureTarget, { type: 'desktop' }, 'Unspecified region bounds should not become an invalid hardcoded region config.');
  assert(region.result.summary.gaps.some((gap) => /region needs a display and bounds|choose the region/i.test(gap)), 'Region draft should explain the runtime region-selection assumption.');

  const webcam = assertRecordDraft('record webcam video and burn subtitles', 'webcam', 'video');
  const burnNode = webcam.result.pipeline.nodes.find((node) => node.type === 'burnSubtitles');
  assert(burnNode && hasEdge(webcam.result, webcam.recordNode, 'video', burnNode, 'video'), 'Webcam Record Input should feed Burn Subtitles through its video port.');

  const videoTranscript = assertRecordDraft('record my screen, transcribe it, and output the transcript as text', 'screen', 'video');
  const extractNode = videoTranscript.result.pipeline.nodes.find((node) => node.type === 'extractAudio');
  const videoWhisper = videoTranscript.result.pipeline.nodes.find((node) => node.type === 'llmPrompt' && node.config?.operationId === 'whisperTranscribe');
  assert(extractNode && videoWhisper, 'Video recording transcription should insert Extract Audio before Whisper.');
  assert(hasEdge(videoTranscript.result, videoTranscript.recordNode, 'video', extractNode, 'video'), 'Video Record Input should feed Extract Audio through the video port.');
  assert(hasEdge(videoTranscript.result, extractNode, 'audio', videoWhisper, 'prompt'), 'Extracted audio should feed Whisper.');
  assert(!videoTranscript.result.pipeline.nodes.some((node) => node.type === 'audioOutput'), 'Video transcription should not create a direct Audio Output.');

  const unsupported = assertRecordDraft('record screen with microphone and system audio', 'screenMic', 'video');
  assert(unsupported.result.summary.gaps.some((gap) => /not supported.*without system audio/i.test(gap)), 'Unsupported screen plus microphone plus system audio should produce a clear assumption.');

  const reviewed = assertRecordDraft('record a voiceover, let me review it, then transcribe it', 'microphone', 'audio');
  const validationNode = reviewed.result.pipeline.nodes.find((node) => node.type === 'validation');
  const retryNode = reviewed.result.pipeline.nodes.find((node) => node.type === 'retryLoop');
  const reviewedWhisper = reviewed.result.pipeline.nodes.find((node) => node.type === 'llmPrompt' && node.config?.operationId === 'whisperTranscribe');
  assert(validationNode && retryNode && reviewedWhisper, 'Review request should place Validation and Retry before transcription.');
  assert(hasEdge(reviewed.result, reviewed.recordNode, 'audio', validationNode, 'input'), 'Record Input should feed Validation first.');
  assert(hasEdge(reviewed.result, retryNode, 'result', reviewedWhisper, 'prompt'), 'Approved/retried recording should feed transcription.');
  assert.strictEqual(retryNode.config.retryTargetNodeId, reviewed.recordNode.id, 'Validation retry should target Record Input for a fresh recording.');
}
const context = buildPipelineWizardContext({ hardware, manifests: tools, providers, tools, assetLibraries });
testWizardPromptBoundary(context);
testLocalWizardPromptIsCompactAndGrounded(context);
testConstrainedWizardPromptIsCompactAndBudgeted(context);
testMediaCompositionMalformedRepairReliability(context);
testRecordInputWizardDrafts(context);
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
testCollectionTextPromptsToImagesDraft(context);
testPlanScenesCanMapToImages(context);
testAudioGenerationIntentIrDraft();
testAudioTransformRvcIntentIrDraft();
testVideoGenerationFromTextIntentIrDraft();
testVideoGenerationFromImageIntentIrDraft();
testImageUpscaleIntentIrDraft();
testFaceFusionIntentIrDraft();
testUnavailableLocalTransformStaysHonest();
testUnsupportedCollectionMappingStaysHonest(context);
testGeminiVideoInputTextGeneration(context);
testUnsupportedVideoInputProviderIsSurfaced(context);
testFileInputTextGenerationForSupportedProvider(context);
testWizardProviderModelLabelAvoidsObjectString(context);
testHallucinatedPlanFallsBack(context);
testCloudImageGenerationPassOneDrafts(context);
testCloudImageCollectionMapPassOneDrafts(context);
testCloudVideoGenerationPassOneDrafts(context);
testCloudVideoCollectionMapPassOneDrafts(context);
testCloudVideoProviderFilteringPassOne();
testChatterboxReferenceVoicePassOneDrafts();

console.log('Pipeline wizard verifier passed.');
