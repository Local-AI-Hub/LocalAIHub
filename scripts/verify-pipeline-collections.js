const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-pipeline-collections');
const providerCalls = [];

function flattenProviderText(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => flattenProviderText(entry)).filter(Boolean).join(' ');
  }

  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text;
    }

    if (typeof value.content === 'string' || Array.isArray(value.content)) {
      return flattenProviderText(value.content);
    }

    if (typeof value.input_text === 'string') {
      return value.input_text;
    }

    return '';
  }

  return typeof value === 'string' ? value : '';
}

function buildMockProviderResponse(payload = {}) {
  const messageText = flattenProviderText(payload.messages || []).trim();
  if (/Validation rules:/i.test(messageText)) {
    return JSON.stringify({
      decision: 'pass',
      reason: 'Mock provider approved the collection.',
      summary: 'Mock provider approved the collection.',
      confidence: 0.82,
      evidenceMode: /ordered collection/i.test(messageText) ? 'structured-collection' : 'text-only',
      criteriaResults: [
        {
          criterion: 'default',
          decision: 'pass',
          reason: 'Mock provider found the supplied evidence sufficient.',
        },
      ],
    });
  }

  return 'Mock rewritten collection item.';
}

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'home' || name === 'appData') {
            return TEST_STORAGE_ROOT;
          }

          if (name === 'exe') {
            return process.execPath;
          }

          return process.cwd();
        },
        isPackaged: false,
      },
      nativeImage: null,
    };
  }

  if (normalizedParent.endsWith('/electron/services/pipelineArtifactService.js') && request === './configService') {
    return {
      ensureStorage: async () => {
        fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
      },
      getAppPaths: () => ({
        runtimesRoot: TEST_STORAGE_ROOT,
      }),
    };
  }

  if (normalizedParent.endsWith('/electron/services/pipelineExecutionService.js')) {
    if (request === './providerRegistry') {
      return {
        initializeProviderRegistry: async () => {},
      };
    }

    if (request === './providerService') {
      return {
        chatWithProvider: async (_providerId, payload = {}) => {
          providerCalls.push({ payload, type: 'chat' });
          return { message: { content: buildMockProviderResponse(payload) } };
        },
        listProviderConnections: async () => ([{
          id: 'openai',
          isConnected: true,
          name: 'Mock OpenAI',
        }]),
        runProviderOperation: async (_providerId, payload = {}) => {
          providerCalls.push({ payload, type: 'operation' });
          return { message: { content: buildMockProviderResponse(payload) } };
        },
      };
    }

    if (request === './toolRegistry') {
      return {
        getToolCatalog: () => [],
        initializeToolRegistry: async () => {},
      };
    }

    if (request === './toolStateService') {
      return {
        buildMergedToolStateList: async () => [],
        getResolvedToolState: async () => null,
      };
    }
  }

  return originalLoad.call(this, request, parent, isMain);
};

const {
  analyzePipeline,
  createEdge,
  createEmptyPipeline,
  createNode,
} = require('../electron/shared/pipelineSchema.cjs');
const {
  cancelPipelineRun,
  getActiveRunSnapshot,
  resumePipelineValidation,
  runPipeline,
} = require('../electron/services/pipelineExecutionService');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }
    await wait(40);
  }

  throw new Error('Timed out while waiting for ' + label + '.');
}

async function cleanupActiveRun() {
  const activeRun = getActiveRunSnapshot();
  if (!activeRun || (activeRun.status !== 'running' && activeRun.status !== 'paused')) {
    return;
  }

  try {
    cancelPipelineRun(activeRun.runId);
  } catch {
    return;
  }

  await waitFor('the active pipeline run to stop', () => {
    const currentRun = getActiveRunSnapshot();
    return !currentRun || ['cancelled', 'completed', 'failed'].includes(currentRun.status) ? currentRun || true : null;
  });
}

function buildProviderContext() {
  return {
    hardware: null,
    providers: [{
      id: 'openai',
      isConnected: true,
      name: 'Mock OpenAI',
    }],
    toolCatalog: [],
    tools: [],
  };
}

function buildOrderedCollectionPipeline() {
  const intro = createNode('textInput', {
    id: 'collection-intro',
    label: 'Intro text',
    config: { text: 'Intro scene' },
  });
  const middle = createNode('textInput', {
    id: 'collection-middle',
    label: 'Middle text',
    config: { text: 'Middle scene' },
  });
  const ending = createNode('textInput', {
    id: 'collection-ending',
    label: 'Ending text',
    config: { text: 'Ending scene' },
  });
  const seedCollection = createNode('collectionBuilder', {
    id: 'seed-collection',
    label: 'Seed collection',
  });
  const finalCollection = createNode('collectionBuilder', {
    id: 'final-collection',
    label: 'Final collection',
    config: {
      insertionMode: 'append',
    },
  });
  const output = createNode('collectionOutput', {
    id: 'collection-output',
    label: 'Collection output',
    config: {
      title: 'Story scenes',
    },
  });

  return createEmptyPipeline({
    id: 'verify-ordered-collection-pipeline',
    name: 'Verify Ordered Collection Pipeline',
    nodes: [intro, middle, ending, seedCollection, finalCollection, output],
    edges: [
      createEdge(intro.id, 'text', seedCollection.id, 'items'),
      createEdge(middle.id, 'text', seedCollection.id, 'items'),
      createEdge(seedCollection.id, 'collection', finalCollection.id, 'existing'),
      createEdge(ending.id, 'text', finalCollection.id, 'items'),
      createEdge(finalCollection.id, 'collection', output.id, 'collection'),
    ],
  });
}

function buildBatchOrderedCollectionPipeline(insertionMode = 'append') {
  const first = createNode('textInput', {
    id: `batch-first-${insertionMode}`,
    label: '1',
    config: { text: '1' },
  });
  const second = createNode('textInput', {
    id: `batch-second-${insertionMode}`,
    label: '2',
    config: { text: '2' },
  });
  const third = createNode('textInput', {
    id: `batch-third-${insertionMode}`,
    label: '3',
    config: { text: '3' },
  });
  const seedCollection = createNode('collectionBuilder', {
    id: `batch-seed-${insertionMode}`,
    label: 'Seed batch collection',
  });
  const finalCollection = createNode('collectionBuilder', {
    id: `batch-final-${insertionMode}`,
    label: 'Final batch collection',
    config: {
      insertionMode,
    },
  });
  const output = createNode('collectionOutput', {
    id: `batch-output-${insertionMode}`,
    label: 'Batch collection output',
    config: {
      title: `Batch ordered scenes ${insertionMode}`,
    },
  });

  return createEmptyPipeline({
    id: `verify-batch-ordered-collection-pipeline-${insertionMode}`,
    name: `Verify Batch Ordered Collection Pipeline ${insertionMode}`,
    nodes: [first, second, third, seedCollection, finalCollection, output],
    edges: [
      createEdge(first.id, 'text', seedCollection.id, 'items'),
      createEdge(seedCollection.id, 'collection', finalCollection.id, 'existing'),
      createEdge(second.id, 'text', finalCollection.id, 'items'),
      createEdge(third.id, 'text', finalCollection.id, 'items'),
      createEdge(finalCollection.id, 'collection', output.id, 'collection'),
    ],
  });
}
function buildValidatedCollectionPipeline() {
  const first = createNode('textInput', {
    id: 'validated-first',
    label: 'First clip',
    config: { text: 'Shot one' },
  });
  const second = createNode('textInput', {
    id: 'validated-second',
    label: 'Second clip',
    config: { text: 'Shot two' },
  });
  const collectionBuilder = createNode('collectionBuilder', {
    id: 'validated-builder',
    label: 'Validated collection',
  });
  const validation = createNode('validation', {
    id: 'validate-collection',
    label: 'Review collection',
    config: { mode: 'user' },
  });
  const merge = createNode('branchMerge', {
    id: 'validated-merge',
    label: 'Validated merge',
  });
  const output = createNode('collectionOutput', {
    id: 'validated-output',
    label: 'Validated output',
    config: {
      title: 'Validated scenes',
    },
  });

  return createEmptyPipeline({
    id: 'verify-validated-collection-pipeline',
    name: 'Verify Validated Collection Pipeline',
    nodes: [first, second, collectionBuilder, validation, merge, output],
    edges: [
      createEdge(first.id, 'text', collectionBuilder.id, 'items'),
      createEdge(second.id, 'text', collectionBuilder.id, 'items'),
      createEdge(collectionBuilder.id, 'collection', validation.id, 'input'),
      createEdge(validation.id, 'pass', merge.id, 'branch'),
      createEdge(validation.id, 'fail', merge.id, 'branch'),
      createEdge(merge.id, 'result', output.id, 'collection'),
    ],
  });
}

function buildLlmValidatedCollectionPipeline() {
  const first = createNode('textInput', {
    id: 'llm-validated-first',
    label: 'First clip',
    config: { text: 'Shot one' },
  });
  const second = createNode('textInput', {
    id: 'llm-validated-second',
    label: 'Second clip',
    config: { text: 'Shot two' },
  });
  const collectionBuilder = createNode('collectionBuilder', {
    id: 'llm-validated-builder',
    label: 'Validated collection',
  });
  const validation = createNode('validation', {
    id: 'llm-validate-collection',
    label: 'Review collection with model',
    config: {
      llmExecutionMode: 'cloud',
      mode: 'llm',
      model: 'gpt-4o-mini',
      providerId: 'openai',
      ruleset: 'Pass the ordered collection when the items remain grounded, coherent, and in order.',
    },
  });
  const merge = createNode('branchMerge', {
    id: 'llm-validated-merge',
    label: 'Validated merge',
  });
  const output = createNode('collectionOutput', {
    id: 'llm-validated-output',
    label: 'Validated output',
    config: {
      title: 'LLM validated scenes',
    },
  });

  return createEmptyPipeline({
    id: 'verify-llm-validated-collection-pipeline',
    name: 'Verify LLM Validated Collection Pipeline',
    nodes: [first, second, collectionBuilder, validation, merge, output],
    edges: [
      createEdge(first.id, 'text', collectionBuilder.id, 'items'),
      createEdge(second.id, 'text', collectionBuilder.id, 'items'),
      createEdge(collectionBuilder.id, 'collection', validation.id, 'input'),
      createEdge(validation.id, 'pass', merge.id, 'branch'),
      createEdge(validation.id, 'fail', merge.id, 'branch'),
      createEdge(merge.id, 'result', output.id, 'collection'),
    ],
  });
}

function buildCollectionValidationRetryPipeline() {
  const first = createNode('textInput', {
    id: 'retry-collection-first',
    label: 'First clip',
    config: { text: 'Shot one' },
  });
  const second = createNode('textInput', {
    id: 'retry-collection-second',
    label: 'Second clip',
    config: { text: 'Shot two' },
  });
  const collectionBuilder = createNode('collectionBuilder', {
    id: 'retry-collection-builder',
    label: 'Validated collection',
  });
  const validation = createNode('validation', {
    id: 'retry-collection-validation',
    label: 'Retry collection review',
    config: { mode: 'user' },
  });
  const retryLoop = createNode('retryLoop', {
    id: 'retry-collection-loop',
    label: 'Retry collection loop',
    config: {
      maxAttempts: 3,
      retryTargetNodeId: validation.id,
    },
  });
  const output = createNode('collectionOutput', {
    id: 'retry-collection-output',
    label: 'Retried collection output',
    config: {
      title: 'Retried validated scenes',
    },
  });

  return createEmptyPipeline({
    id: 'verify-collection-validation-retry-pipeline',
    name: 'Verify Collection Validation Retry Pipeline',
    nodes: [first, second, collectionBuilder, validation, retryLoop, output],
    edges: [
      createEdge(first.id, 'text', collectionBuilder.id, 'items'),
      createEdge(second.id, 'text', collectionBuilder.id, 'items'),
      createEdge(collectionBuilder.id, 'collection', validation.id, 'input'),
      createEdge(validation.id, 'pass', retryLoop.id, 'complete'),
      createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      createEdge(retryLoop.id, 'result', output.id, 'collection'),
    ],
  });
}

function buildAccumulateUntilTargetPipeline() {
  const source = createNode('textInput', {
    id: 'accumulate-source',
    label: 'Candidate text',
    config: { text: 'Approved frame' },
  });
  const validation = createNode('validation', {
    id: 'accumulate-validation',
    label: 'Review candidate',
    config: { mode: 'user' },
  });
  const accumulator = createNode('collectionAccumulator', {
    id: 'accumulate-control',
    label: 'Accepted collection',
    config: {
      targetCount: 2,
    },
  });
  const retryLoop = createNode('retryLoop', {
    id: 'accumulate-loop',
    label: 'Keep collecting',
    config: {
      maxAttempts: 4,
      retryTargetNodeId: validation.id,
    },
  });
  const output = createNode('collectionOutput', {
    id: 'accumulate-output',
    label: 'Accumulated output',
    config: {
      title: 'Approved collection',
    },
  });

  return createEmptyPipeline({
    id: 'verify-accumulate-until-target',
    name: 'Verify Accumulate Until Target',
    nodes: [source, validation, accumulator, retryLoop, output],
    edges: [
      createEdge(source.id, 'text', validation.id, 'input'),
      createEdge(validation.id, 'pass', accumulator.id, 'item'),
      createEdge(accumulator.id, 'collection', retryLoop.id, 'complete'),
      createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      createEdge(retryLoop.id, 'result', output.id, 'collection'),
    ],
  });
}

function buildMultiSourceAccumulateUntilTargetPipeline(options = {}) {
  const targetCount = Math.max(1, Number(options.targetCount || 2) || 2);
  const firstSource = createNode('textInput', {
    id: 'multi-accumulate-source-a',
    label: 'Candidate A',
    config: { text: 'Accepted frame A' },
  });
  const secondSource = createNode('textInput', {
    id: 'multi-accumulate-source-b',
    label: 'Candidate B',
    config: { text: 'Accepted frame B' },
  });
  const firstValidation = createNode('validation', {
    id: 'multi-accumulate-validation-a',
    label: 'Review A',
    config: { mode: 'user' },
  });
  const secondValidation = createNode('validation', {
    id: 'multi-accumulate-validation-b',
    label: 'Review B',
    config: { mode: 'user' },
  });
  const accumulator = createNode('collectionAccumulator', {
    id: 'multi-accumulate-control',
    label: 'Shared accepted collection',
    config: {
      targetCount,
    },
  });
  const retryLoop = createNode('retryLoop', {
    id: 'multi-accumulate-loop',
    label: 'Keep shared collection going',
    config: {
      maxAttempts: 4,
      retryTargetNodeId: secondValidation.id,
    },
  });
  const retryBranch = createNode('branchMerge', {
    id: 'multi-accumulate-retry-merge',
    label: 'Shared retry branch',
  });
  const output = createNode('collectionOutput', {
    id: 'multi-accumulate-output',
    label: 'Shared accumulated output',
    config: {
      title: 'Shared approved collection',
    },
  });

  return createEmptyPipeline({
    id: 'verify-multi-source-accumulate-until-target-' + targetCount,
    name: 'Verify Multi Source Accumulate Until Target ' + targetCount,
    nodes: [firstSource, secondSource, firstValidation, secondValidation, accumulator, retryLoop, retryBranch, output],
    edges: [
      createEdge(firstSource.id, 'text', firstValidation.id, 'input'),
      createEdge(secondSource.id, 'text', secondValidation.id, 'input'),
      createEdge(firstValidation.id, 'pass', accumulator.id, 'item'),
      createEdge(secondValidation.id, 'pass', accumulator.id, 'item'),
      createEdge(firstValidation.id, 'fail', retryBranch.id, 'branch'),
      createEdge(secondValidation.id, 'fail', retryBranch.id, 'branch'),
      createEdge(retryBranch.id, 'result', retryLoop.id, 'retry'),
      createEdge(accumulator.id, 'collection', retryLoop.id, 'complete'),
      createEdge(retryLoop.id, 'result', output.id, 'collection'),
    ],
  });
}
async function verifyAppendAndPrependCollectionOutputOrder() {
  const scenarios = [
    {
      mode: 'append',
      expectedFiles: ['001-1.txt', '002-2.txt', '003-3.txt'],
      expectedTexts: ['1', '2', '3'],
    },
    {
      mode: 'prepend',
      expectedFiles: ['001-3.txt', '002-2.txt', '003-1.txt'],
      expectedTexts: ['3', '2', '1'],
    },
  ];

  for (const scenario of scenarios) {
    const pipeline = buildBatchOrderedCollectionPipeline(scenario.mode);
    const analysis = analyzePipeline(pipeline, {
      hardware: null,
      providers: [],
      toolCatalog: [],
      tools: [],
    });
    assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || `Expected the ${scenario.mode} batch collection pipeline to be executable.`);

    const initialRun = await runPipeline(pipeline);
    assert(initialRun?.runId, `Expected a pipeline run id for the ${scenario.mode} batch collection pipeline.`);

    const completedRun = await waitFor(`the ${scenario.mode} batch collection pipeline to complete`, () => {
      const run = getActiveRunSnapshot();
      return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
    });

    const result = completedRun.terminalResults?.[0] || null;
    assert(result, `Expected the ${scenario.mode} batch collection pipeline to produce a terminal result.`);
    assert.strictEqual(result.kind, 'collection', `Expected the ${scenario.mode} batch output to be a collection.`);
    assert.deepStrictEqual(
      (result.artifact?.items || []).map((entry) => entry?.artifact?.text),
      scenario.expectedTexts,
      `Expected the ${scenario.mode} batch output preview/result order to match the collection order.`,
    );
    assert.deepStrictEqual(
      (result.artifact?.items || []).map((entry) => path.basename(entry?.artifact?.filePath || '')),
      scenario.expectedFiles,
      `Expected the ${scenario.mode} batch output files to keep the explicit collection order.`,
    );

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.deepStrictEqual(
      (manifest.items || []).map((entry) => entry?.artifact?.text),
      scenario.expectedTexts,
      `Expected the ${scenario.mode} manifest to preserve collection order.`,
    );
    assert.deepStrictEqual(
      (manifest.items || []).map((entry) => path.basename(entry?.relativeArtifactPath || '')),
      scenario.expectedFiles,
      `Expected the ${scenario.mode} manifest paths to preserve collection order.`,
    );
  }
}
async function verifyOrderedCollectionOutput() {
  const pipeline = buildOrderedCollectionPipeline();
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected ordered collection pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the ordered collection pipeline.');

  const completedRun = await waitFor('the ordered collection pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  const result = completedRun.terminalResults?.[0] || null;
  assert(result, 'Expected the ordered collection pipeline to produce a terminal result.');
  assert.strictEqual(result.kind, 'collection', 'Expected the terminal result to be a collection.');
  assert.strictEqual(result.itemKind, 'text', 'Expected the collection to keep text typing.');
  assert.strictEqual(result.itemCount, 3, 'Expected three ordered text items in the collection.');
  assert.deepStrictEqual(
    (result.artifact?.items || []).map((entry) => entry?.artifact?.text),
    ['Intro scene', 'Middle scene', 'Ending scene'],
    'Expected the collection to preserve item order through chained collection builders.',
  );
  assert(result.destinationPath && fs.existsSync(result.destinationPath), 'Expected the collection output folder to exist.');
  assert(result.manifestPath && fs.existsSync(result.manifestPath), 'Expected the collection manifest to exist.');

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.strictEqual(manifest.itemKind, 'text', 'Expected the manifest to record the text item kind.');
  assert.strictEqual(manifest.itemCount, 3, 'Expected the manifest to record the full item count.');
  assert.deepStrictEqual(
    (manifest.items || []).map((entry) => entry?.artifact?.text),
    ['Intro scene', 'Middle scene', 'Ending scene'],
    'Expected the manifest to preserve the ordered text items.',
  );
}

async function verifyCollectionValidationPause() {
  const pipeline = buildValidatedCollectionPipeline();
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected validated collection pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the validated collection pipeline.');

  const pausedRun = await waitFor('the collection validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'validate-collection' ? run : null;
  });

  assert.strictEqual(pausedRun.pendingValidation?.artifact?.kind, 'collection', 'Expected the validation step to receive a collection value.');
  assert.strictEqual(pausedRun.pendingValidation?.artifact?.itemKind, 'text', 'Expected the validation step to receive a typed text collection.');
  assert.strictEqual(pausedRun.pendingValidation?.artifact?.itemCount, 2, 'Expected the validation collection to contain two items.');
  assert.strictEqual(pausedRun.pendingValidation?.reviewContext?.evidenceMode, 'whole-collection-review', 'Expected user collection validation to advertise whole-collection review.');
  assert.deepStrictEqual(
    (pausedRun.pendingValidation?.artifact?.items || []).map((entry) => entry?.artifact?.text),
    ['Shot one', 'Shot two'],
    'Expected the validation pause to preserve collection item order.',
  );

  resumePipelineValidation(pausedRun.runId, {
    comment: 'Collection looks correct.',
    decision: 'pass',
    nodeId: pausedRun.pendingValidation.nodeId,
    requestId: pausedRun.pendingValidation.requestId,
    runId: pausedRun.runId,
  });

  const completedRun = await waitFor('the validated collection pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  const result = completedRun.terminalResults?.[0] || null;
  assert(result, 'Expected the validated collection pipeline to produce a terminal result.');
  assert.strictEqual(result.kind, 'collection', 'Expected the validated output to stay a collection.');
  assert.strictEqual(result.itemCount, 2, 'Expected the validated output to keep both ordered items.');
}
async function verifyLlmCollectionValidation() {
  providerCalls.length = 0;
  const pipeline = buildLlmValidatedCollectionPipeline();
  const analysis = analyzePipeline(pipeline, buildProviderContext());
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected LLM validated collection pipeline to be executable.');
  assert.notStrictEqual(
    analysis.nodeSummaries?.['llm-validate-collection']?.readiness?.tone,
    'error',
    'Expected the LLM collection validator to accept the collection input.',
  );
  assert(/collection/i.test(String(analysis.nodeSummaries?.['llm-validate-collection']?.readiness?.message || '')), 'Expected the LLM collection validator readiness message to mention collection review.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the LLM validated collection pipeline.');

  const completedRun = await waitFor('the LLM validated collection pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  const validationState = completedRun.nodeStates?.['llm-validate-collection'] || null;
  assert.strictEqual(validationState?.selectedBranch, 'pass', 'Expected the mock provider to pass the collection.');
  assert.strictEqual(validationState?.validation?.evidenceMode, 'structured-collection', 'Expected LLM collection validation to record whole-collection evidence mode.');

  const validationCall = providerCalls.find((entry) => flattenProviderText(entry?.payload?.messages || []).includes('Collection scope:')) || null;
  assert(validationCall, 'Expected the mock provider to receive a collection validation request.');
  const validationPrompt = flattenProviderText(validationCall.payload.messages || []);
  assert(/Review the ordered collection as a whole/i.test(validationPrompt), 'Expected the collection validation prompt to describe whole-collection review.');
  assert(/Type:\s*ordered collection/i.test(validationPrompt), 'Expected the provider prompt to include the ordered collection evidence.');
}

async function verifyCollectionValidationRetryLoop() {
  const pipeline = buildCollectionValidationRetryPipeline();
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected collection validation retry pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the collection validation retry pipeline.');

  const firstPause = await waitFor('the first collection retry validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'retry-collection-validation' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  assert.strictEqual(firstPause.pendingValidation?.artifact?.kind, 'collection', 'Expected the retry validation step to receive a collection artifact.');
  resumePipelineValidation(firstPause.runId, {
    comment: 'Fail the first whole-collection review so the retry loop runs again.',
    decision: 'fail',
    nodeId: firstPause.pendingValidation.nodeId,
    requestId: firstPause.pendingValidation.requestId,
    runId: firstPause.runId,
  });

  const secondPause = await waitFor('the second collection retry validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'retry-collection-validation' && run?.pendingValidation?.iteration === 2 ? run : null;
  });
  assert.strictEqual(secondPause.loopStates?.['retry-collection-loop']?.attempt, 2, 'Expected the collection retry loop to advance to attempt 2 after a failed whole-collection review.');
  assert.strictEqual(secondPause.pendingValidation?.artifact?.kind, 'collection', 'Expected the retried validation step to keep receiving a collection artifact.');
  resumePipelineValidation(secondPause.runId, {
    comment: 'Pass the retried whole-collection review.',
    decision: 'pass',
    nodeId: secondPause.pendingValidation.nodeId,
    requestId: secondPause.pendingValidation.requestId,
    runId: secondPause.runId,
  });

  const completedRun = await waitFor('the collection validation retry pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  const result = completedRun.terminalResults?.[0] || null;
  assert(result, 'Expected the collection validation retry pipeline to produce a terminal result.');
  assert.strictEqual(result.kind, 'collection', 'Expected collection validation retry to preserve the collection output kind.');
  assert.strictEqual(result.itemCount, 2, 'Expected collection validation retry to preserve both collection items.');
}

async function verifyAccumulateUntilTargetLoop() {
  const pipeline = buildAccumulateUntilTargetPipeline();
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected accumulate-until-target pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the accumulate-until-target pipeline.');

  const firstPause = await waitFor('the first accumulate validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'accumulate-validation' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  resumePipelineValidation(firstPause.runId, {
    comment: 'Keep the first accepted item.',
    decision: 'pass',
    nodeId: firstPause.pendingValidation.nodeId,
    requestId: firstPause.pendingValidation.requestId,
    runId: firstPause.runId,
  });

  const secondPause = await waitFor('the second accumulate validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'accumulate-validation' && run?.pendingValidation?.iteration === 2 ? run : null;
  });
  assert.strictEqual(secondPause.collectionControlStates?.['accumulate-control']?.acceptedCount, 1, 'Expected one accepted item to stay preserved after the first pass.');
  assert.strictEqual(secondPause.collectionControlStates?.['accumulate-control']?.status, 'collecting', 'Expected the accumulation state to keep collecting after the first pass.');
  assert.strictEqual(secondPause.loopStates?.['accumulate-loop']?.attempt, 2, 'Expected the connected retry loop to advance after the accumulator requested another attempt.');
  resumePipelineValidation(secondPause.runId, {
    comment: 'Reject this candidate so it retries without adding to the collection.',
    decision: 'fail',
    nodeId: secondPause.pendingValidation.nodeId,
    requestId: secondPause.pendingValidation.requestId,
    runId: secondPause.runId,
  });

  const thirdPause = await waitFor('the third accumulate validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'accumulate-validation' && run?.pendingValidation?.iteration === 3 ? run : null;
  });
  assert.strictEqual(thirdPause.collectionControlStates?.['accumulate-control']?.acceptedCount, 1, 'Expected the failed attempt not to increase the accepted-item count.');
  assert.strictEqual(thirdPause.collectionControlStates?.['accumulate-control']?.status, 'collecting', 'Expected the accumulation state to remain in collecting mode after a failed validation.');
  assert.strictEqual(thirdPause.loopStates?.['accumulate-loop']?.attempt, 3, 'Expected the retry loop to advance again after the failed candidate retried.');
  resumePipelineValidation(thirdPause.runId, {
    comment: 'Accept the final candidate and emit the collection.',
    decision: 'pass',
    nodeId: thirdPause.pendingValidation.nodeId,
    requestId: thirdPause.pendingValidation.requestId,
    runId: thirdPause.runId,
  });

  const completedRun = await waitFor('the accumulate-until-target pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  assert.strictEqual(completedRun.collectionControlStates?.['accumulate-control']?.acceptedCount, 2, 'Expected the accumulation state to finish with two accepted items.');
  assert.strictEqual(completedRun.collectionControlStates?.['accumulate-control']?.status, 'emitted', 'Expected the accumulation state to report that it emitted the collection.');
  const result = completedRun.terminalResults?.[0] || null;
  assert(result, 'Expected the accumulate-until-target pipeline to produce a terminal result.');
  assert.strictEqual(result.kind, 'collection', 'Expected accumulate-until-target to emit a collection result.');
  assert.strictEqual(result.itemCount, 2, 'Expected the emitted collection to contain only the accepted items.');
  assert.strictEqual(result.artifact?.accumulation?.targetCount, 2, 'Expected the collection artifact to record the configured target count.');
  assert.strictEqual(result.artifact?.accumulation?.acceptedCount, 2, 'Expected the collection artifact to record the accepted-item count.');
  assert.strictEqual(result.artifact?.accumulation?.status, 'emitted', 'Expected the collection artifact to record that emission completed.');
  assert.deepStrictEqual(
    (result.artifact?.items || []).map((entry) => entry?.lineage?.sourcePortId),
    ['pass', 'pass'],
    'Expected the emitted collection to keep only pass-branch lineage for accepted items.',
  );

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.strictEqual(manifest.accumulation?.targetCount, 2, 'Expected the saved manifest to preserve the target count.');
  assert.strictEqual(manifest.accumulation?.acceptedCount, 2, 'Expected the saved manifest to preserve the accepted-item count.');
  assert.deepStrictEqual(
    (manifest.items || []).map((entry) => entry?.lineage?.sourcePortId),
    ['pass', 'pass'],
    'Expected the saved manifest to keep only accepted-item lineage.',
  );
}

async function verifyMultiSourceAccumulateUntilTargetLoop() {
  const pipeline = buildMultiSourceAccumulateUntilTargetPipeline({ targetCount: 2 });
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected multi-source accumulate-until-target pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the multi-source accumulate-until-target pipeline.');

  const firstPause = await waitFor('the first multi-source validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'multi-accumulate-validation-a' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  resumePipelineValidation(firstPause.runId, {
    comment: 'Accept branch A and keep it stored.',
    decision: 'pass',
    nodeId: firstPause.pendingValidation.nodeId,
    requestId: firstPause.pendingValidation.requestId,
    runId: firstPause.runId,
  });

  const secondPause = await waitFor('the second multi-source validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'multi-accumulate-validation-b' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  resumePipelineValidation(secondPause.runId, {
    comment: 'Fail branch B so the loop retries only that branch while branch A stays accepted.',
    decision: 'fail',
    nodeId: secondPause.pendingValidation.nodeId,
    requestId: secondPause.pendingValidation.requestId,
    runId: secondPause.runId,
  });

  const retryPause = await waitFor('the retried branch B validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'multi-accumulate-validation-b' && run?.pendingValidation?.iteration === 2 ? run : null;
  });
  assert.strictEqual(retryPause.collectionControlStates?.['multi-accumulate-control']?.acceptedCount, 1, 'Expected branch A to stay accumulated while branch B retries.');
  assert.strictEqual(retryPause.collectionControlStates?.['multi-accumulate-control']?.status, 'collecting', 'Expected the shared accumulator to remain in collecting mode while branch B retries.');
  assert.strictEqual(retryPause.loopStates?.['multi-accumulate-loop']?.attempt, 2, 'Expected the shared retry loop to advance to attempt 2.');
  resumePipelineValidation(retryPause.runId, {
    comment: 'Accept branch B on retry and finish the collection.',
    decision: 'pass',
    nodeId: retryPause.pendingValidation.nodeId,
    requestId: retryPause.pendingValidation.requestId,
    runId: retryPause.runId,
  });

  const completedRun = await waitFor('the multi-source accumulate-until-target pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  assert.strictEqual(completedRun.collectionControlStates?.['multi-accumulate-control']?.acceptedCount, 2, 'Expected the shared accumulation state to finish with two accepted items.');
  assert.strictEqual(completedRun.collectionControlStates?.['multi-accumulate-control']?.status, 'emitted', 'Expected the shared accumulation state to report that it emitted the collection.');
  const result = completedRun.terminalResults?.[0] || null;
  assert(result, 'Expected the multi-source accumulate-until-target pipeline to produce a terminal result.');
  assert.strictEqual(result.kind, 'collection', 'Expected multi-source accumulate-until-target to emit a collection result.');
  assert.strictEqual(result.itemCount, 2, 'Expected the emitted collection to contain both accepted items without duplicating branch A on retry.');
  assert.deepStrictEqual(
    (result.artifact?.items || []).map((entry) => entry?.lineage?.sourceNodeId),
    ['multi-accumulate-validation-a', 'multi-accumulate-validation-b'],
    'Expected the emitted collection to preserve source lineage for both accepted branches in order.',
  );

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.strictEqual(manifest.accumulation?.acceptedCount, 2, 'Expected the saved shared manifest to preserve the accepted-item count.');
  assert.deepStrictEqual(
    (manifest.items || []).map((entry) => entry?.lineage?.sourceNodeId),
    ['multi-accumulate-validation-a', 'multi-accumulate-validation-b'],
    'Expected the saved shared manifest to preserve lineage for both accepted branches in order.',
  );
}

async function verifyMultiSourceAccumulateCompletionWinsOverRetry() {
  const pipeline = buildMultiSourceAccumulateUntilTargetPipeline({ targetCount: 1 });
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected the completion-priority multi-source pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the completion-priority multi-source pipeline.');

  const firstPause = await waitFor('the completion-priority branch A validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'multi-accumulate-validation-a' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  resumePipelineValidation(firstPause.runId, {
    comment: 'Accept branch A so the target is already met.',
    decision: 'pass',
    nodeId: firstPause.pendingValidation.nodeId,
    requestId: firstPause.pendingValidation.requestId,
    runId: firstPause.runId,
  });

  const secondPause = await waitFor('the completion-priority branch B validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'multi-accumulate-validation-b' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  resumePipelineValidation(secondPause.runId, {
    comment: 'Fail branch B in the same cycle; completion should win over retry now that the target is met.',
    decision: 'fail',
    nodeId: secondPause.pendingValidation.nodeId,
    requestId: secondPause.pendingValidation.requestId,
    runId: secondPause.runId,
  });

  const completedRun = await waitFor('the completion-priority multi-source pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  const result = completedRun.terminalResults?.[0] || null;
  assert(result, 'Expected the completion-priority multi-source pipeline to produce a terminal result.');
  assert.strictEqual(result.kind, 'collection', 'Expected completion-priority multi-source accumulation to emit a collection result.');
  assert.strictEqual(result.itemCount, 1, 'Expected the emitted collection to keep the accepted branch only.');
  assert.deepStrictEqual(
    (result.artifact?.items || []).map((entry) => entry?.lineage?.sourceNodeId),
    ['multi-accumulate-validation-a'],
    'Expected the emitted collection to keep only the accepted branch lineage when completion beats retry.',
  );
}
async function main() {
  await cleanupActiveRun();
  await verifyAppendAndPrependCollectionOutputOrder();
  await cleanupActiveRun();
  await verifyOrderedCollectionOutput();
  await cleanupActiveRun();
  await verifyCollectionValidationPause();
  await cleanupActiveRun();
  await verifyLlmCollectionValidation();
  await cleanupActiveRun();
  await verifyCollectionValidationRetryLoop();
  await cleanupActiveRun();
  await verifyAccumulateUntilTargetLoop();
  await cleanupActiveRun();
  await verifyMultiSourceAccumulateUntilTargetLoop();
  await cleanupActiveRun();
  await verifyMultiSourceAccumulateCompletionWinsOverRetry();
  await cleanupActiveRun();
  console.log('Pipeline collection verification passed.');
}

main().catch(async (error) => {
  await cleanupActiveRun();
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});






