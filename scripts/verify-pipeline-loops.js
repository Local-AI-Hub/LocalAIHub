const assert = require('assert');
const path = require('path');
const Module = require('module');

function flattenMockProviderText(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => flattenMockProviderText(entry)).filter(Boolean).join(' ');
  }

  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text;
    }

    if (typeof value.content === 'string' || Array.isArray(value.content)) {
      return flattenMockProviderText(value.content);
    }

    if (typeof value.input_text === 'string') {
      return value.input_text;
    }

    return '';
  }

  return typeof value === 'string' ? value : '';
}

function buildMockProviderReply(payload = {}) {
  const extractedText = flattenMockProviderText(payload.messages || []).trim();
  return 'Mock provider saw: ' + (extractedText || 'empty request');
}

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'home') {
            return process.env.USERPROFILE || process.cwd();
          }

          if (name === 'appData') {
            return process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming');
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

  if (normalizedParent.endsWith('/electron/services/pipelineExecutionService.js')) {
    if (request === './providerRegistry') {
      return {
        initializeProviderRegistry: async () => {},
      };
    }

    if (request === './providerService') {
      return {
        chatWithProvider: async (_providerId, payload = {}) => ({
          message: {
            content: buildMockProviderReply(payload),
          },
        }),
        listProviderConnections: async () => ([{
          id: 'openai',
          isConnected: true,
          name: 'Mock OpenAI',
        }]),
        runProviderOperation: async (_providerId, payload = {}) => ({
          message: {
            content: buildMockProviderReply(payload),
          },
        }),
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
  PIPELINE_RETRY_LOOP_MAX_ATTEMPTS,
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

async function waitFor(description, predicate, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }

    await wait(100);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

function buildValidationRetryPipeline(overrides = {}) {
  const textInput = createNode('textInput', {
    id: 'text-input',
    label: 'Prompt input',
    config: {
      text: 'Retry this validation once, then let it pass.',
    },
  });
  const validation = createNode('validation', {
    id: 'validation-node',
    label: 'Review text',
    config: {
      mode: 'user',
    },
  });
  const retryLoop = createNode('retryLoop', {
    id: 'retry-loop',
    label: 'Retry review',
    config: {
      maxAttempts: 3,
      retryTargetNodeId: validation.id,
    },
  });
  const output = createNode('textOutput', {
    id: 'text-output',
    label: 'Final text',
    config: {
      title: 'Loop result',
    },
  });

  return createEmptyPipeline({
    id: 'verify-pipeline-loops',
    name: 'Verify Pipeline Loops',
    nodes: [textInput, validation, retryLoop, output],
    edges: [
      createEdge(textInput.id, 'text', validation.id, 'input'),
      createEdge(validation.id, 'pass', retryLoop.id, 'complete'),
      createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      createEdge(retryLoop.id, 'result', output.id, 'text'),
      ...(Array.isArray(overrides.extraEdges) ? overrides.extraEdges : []),
    ],
    ...overrides,
  });
}

function buildBranchMergeLoopEntryPipeline() {
  const textInput = createNode('textInput', {
    id: 'merge-input',
    label: 'Merge input',
    config: {
      text: 'Reuse this text through the loop entry merge.',
    },
  });
  const branchMerge = createNode('branchMerge', {
    id: 'merge-entry',
    label: 'Loop entry merge',
  });
  const validation = createNode('validation', {
    id: 'merge-validation',
    label: 'Review merged text',
    config: {
      mode: 'user',
    },
  });
  const retryLoop = createNode('retryLoop', {
    id: 'merge-loop',
    label: 'Retry merge path',
    config: {
      maxAttempts: 3,
      retryTargetNodeId: branchMerge.id,
    },
  });
  const output = createNode('textOutput', {
    id: 'merge-output',
    label: 'Merged output',
    config: {
      title: 'Merged loop result',
    },
  });

  return createEmptyPipeline({
    id: 'verify-branch-merge-loop-entry',
    name: 'Verify Branch Merge Loop Entry',
    nodes: [textInput, branchMerge, validation, retryLoop, output],
    edges: [
      createEdge(textInput.id, 'text', branchMerge.id, 'branch'),
      createEdge(branchMerge.id, 'result', validation.id, 'input'),
      createEdge(validation.id, 'pass', retryLoop.id, 'complete'),
      createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      createEdge(retryLoop.id, 'result', output.id, 'text'),
    ],
  });
}

function buildNestedRetryPipeline() {
  const textInput = createNode('textInput', {
    id: 'nested-input',
    label: 'Nested input',
    config: {
      text: 'Drive nested retry loops through the same bounded execution model.',
    },
  });
  const innerValidation = createNode('validation', {
    id: 'nested-inner-validation',
    label: 'Inner review',
    config: {
      mode: 'user',
    },
  });
  const innerLoop = createNode('retryLoop', {
    id: 'nested-inner-loop',
    label: 'Inner retry',
    config: {
      maxAttempts: 3,
      retryTargetNodeId: innerValidation.id,
    },
  });
  const outerValidation = createNode('validation', {
    id: 'nested-outer-validation',
    label: 'Outer review',
    config: {
      mode: 'user',
    },
  });
  const outerLoop = createNode('retryLoop', {
    id: 'nested-outer-loop',
    label: 'Outer retry',
    config: {
      maxAttempts: 3,
      retryTargetNodeId: innerValidation.id,
    },
  });
  const output = createNode('textOutput', {
    id: 'nested-output',
    label: 'Nested result',
    config: {
      title: 'Nested loop result',
    },
  });

  return createEmptyPipeline({
    id: 'verify-nested-retry-loops',
    name: 'Verify Nested Retry Loops',
    nodes: [textInput, innerValidation, innerLoop, outerValidation, outerLoop, output],
    edges: [
      createEdge(textInput.id, 'text', innerValidation.id, 'input'),
      createEdge(innerValidation.id, 'pass', innerLoop.id, 'complete'),
      createEdge(innerValidation.id, 'fail', innerLoop.id, 'retry'),
      createEdge(innerLoop.id, 'result', outerValidation.id, 'input'),
      createEdge(outerValidation.id, 'pass', outerLoop.id, 'complete'),
      createEdge(outerValidation.id, 'fail', outerLoop.id, 'retry'),
      createEdge(outerLoop.id, 'result', output.id, 'text'),
    ],
  });
}

function buildOverlappingRetryPipeline() {
  const textInput = createNode('textInput', {
    id: 'overlap-input',
    label: 'Overlap input',
    config: {
      text: 'Drive overlapping retry spans without breaking deterministic execution.',
    },
  });
  const mergeEntry = createNode('branchMerge', {
    id: 'overlap-merge',
    label: 'Overlap merge',
  });
  const secondValidation = createNode('validation', {
    id: 'overlap-validation-b',
    label: 'Stage B review',
    config: {
      mode: 'user',
    },
  });
  const firstLoop = createNode('retryLoop', {
    id: 'overlap-loop-a',
    label: 'Retry merged stage',
    config: {
      maxAttempts: 3,
      retryTargetNodeId: mergeEntry.id,
    },
  });
  const thirdValidation = createNode('validation', {
    id: 'overlap-validation-c',
    label: 'Stage C review',
    config: {
      mode: 'user',
    },
  });
  const secondLoop = createNode('retryLoop', {
    id: 'overlap-loop-b',
    label: 'Retry stage B+C',
    config: {
      maxAttempts: 3,
      retryTargetNodeId: secondValidation.id,
    },
  });
  const output = createNode('textOutput', {
    id: 'overlap-output',
    label: 'Overlap result',
    config: {
      title: 'Overlapping loop result',
    },
  });

  return createEmptyPipeline({
    id: 'verify-overlapping-retry-loops',
    name: 'Verify Overlapping Retry Loops',
    nodes: [textInput, mergeEntry, secondValidation, firstLoop, thirdValidation, secondLoop, output],
    edges: [
      createEdge(textInput.id, 'text', mergeEntry.id, 'branch'),
      createEdge(mergeEntry.id, 'result', secondValidation.id, 'input'),
      createEdge(secondValidation.id, 'pass', firstLoop.id, 'complete'),
      createEdge(secondValidation.id, 'fail', firstLoop.id, 'retry'),
      createEdge(firstLoop.id, 'result', thirdValidation.id, 'input'),
      createEdge(thirdValidation.id, 'pass', secondLoop.id, 'complete'),
      createEdge(thirdValidation.id, 'fail', secondLoop.id, 'retry'),
      createEdge(secondLoop.id, 'result', output.id, 'text'),
    ],
  });
}

function buildGenericRetryReentryPipeline() {
  const textInput = createNode('textInput', {
    id: 'generic-input',
    label: 'Generic input',
    config: {
      text: 'Seed prompt',
    },
  });
  const llmStep = createNode('llmPrompt', {
    id: 'generic-llm',
    label: 'Rewrite draft',
    config: {
      executionMode: 'cloud',
      model: 'gpt-4o-mini',
      providerId: 'openai',
    },
  });
  const validation = createNode('validation', {
    id: 'generic-validation',
    label: 'Review rewrite',
    config: {
      mode: 'user',
    },
  });
  const retryLoop = createNode('retryLoop', {
    id: 'generic-loop',
    label: 'Retry rewrite',
    config: {
      maxAttempts: 4,
      retryTargetNodeId: llmStep.id,
    },
  });
  const output = createNode('textOutput', {
    id: 'generic-output',
    label: 'Generic output',
    config: {
      title: 'Generic retry result',
    },
  });

  return createEmptyPipeline({
    id: 'verify-generic-retry-reentry',
    name: 'Verify Generic Retry Re-entry',
    nodes: [textInput, llmStep, validation, retryLoop, output],
    edges: [
      createEdge(textInput.id, 'text', llmStep.id, 'prompt'),
      createEdge(llmStep.id, 'text', validation.id, 'input'),
      createEdge(validation.id, 'pass', retryLoop.id, 'complete'),
      createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      createEdge(retryLoop.id, 'result', output.id, 'text'),
    ],
  });
}

function buildRepeatedArtifactTerminationPipeline() {
  const textInput = createNode('textInput', {
    id: 'repeat-input',
    label: 'Repeat input',
    config: {
      text: 'Keep retrying this same text until the repeat rule stops the loop.',
    },
  });
  const validation = createNode('validation', {
    id: 'repeat-validation',
    label: 'Repeat review',
    config: {
      mode: 'user',
    },
  });
  const retryLoop = createNode('retryLoop', {
    id: 'repeat-loop',
    label: 'Repeat stop loop',
    config: {
      maxAttempts: 5,
      retryTargetNodeId: validation.id,
      retryTerminationAction: 'complete',
      stopWhenRetryArtifactRepeats: true,
    },
  });
  const output = createNode('textOutput', {
    id: 'repeat-output',
    label: 'Repeat output',
    config: {
      title: 'Repeated artifact result',
    },
  });

  return createEmptyPipeline({
    id: 'verify-repeated-artifact-termination',
    name: 'Verify Repeated Artifact Termination',
    nodes: [textInput, validation, retryLoop, output],
    edges: [
      createEdge(textInput.id, 'text', validation.id, 'input'),
      createEdge(validation.id, 'pass', retryLoop.id, 'complete'),
      createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      createEdge(retryLoop.id, 'result', output.id, 'text'),
    ],
  });
}

function buildLoopLeakPipeline() {
  const pipeline = buildValidationRetryPipeline();
  const extraOutput = createNode('textOutput', {
    id: 'leak-output',
    label: 'Leaked output',
    config: {
      title: 'Leaked branch',
    },
  });

  return createEmptyPipeline({
    ...pipeline,
    nodes: [...pipeline.nodes, extraOutput],
    edges: [...pipeline.edges, createEdge('validation-node', 'pass', extraOutput.id, 'text')],
  });
}

function buildRawCyclePipeline() {
  const textInput = createNode('textInput', {
    id: 'cycle-input',
    label: 'Cycle input',
    config: {
      text: 'This should never run as a raw cycle.',
    },
  });
  const branchMerge = createNode('branchMerge', {
    id: 'cycle-merge',
    label: 'Cycle merge',
  });
  const validation = createNode('validation', {
    id: 'cycle-validation',
    label: 'Cycle validation',
    config: {
      mode: 'user',
    },
  });
  const output = createNode('textOutput', {
    id: 'cycle-output',
    label: 'Cycle output',
    config: {
      title: 'Cycle output',
    },
  });

  return createEmptyPipeline({
    id: 'raw-cycle-pipeline',
    name: 'Raw Cycle Pipeline',
    nodes: [textInput, branchMerge, validation, output],
    edges: [
      createEdge(textInput.id, 'text', branchMerge.id, 'branch'),
      createEdge(branchMerge.id, 'result', validation.id, 'input'),
      createEdge(branchMerge.id, 'result', output.id, 'text'),
      createEdge(validation.id, 'pass', branchMerge.id, 'branch'),
      createEdge(validation.id, 'fail', branchMerge.id, 'branch'),
    ],
  });
}

async function cleanupActiveRun() {
  const activeRun = getActiveRunSnapshot();
  if (activeRun?.status === 'running' || activeRun?.status === 'paused') {
    try {
      cancelPipelineRun(activeRun.runId);
    } catch {
      return;
    }

    await waitFor('the active pipeline run to stop', () => {
      const nextRun = getActiveRunSnapshot();
      return nextRun && nextRun.runId === activeRun.runId && ['cancelled', 'failed', 'completed'].includes(nextRun.status) ? nextRun : null;
    }, 15000).catch(() => null);
  }
}

async function verifyRuntimeRetryLoop() {
  const pipeline = buildValidationRetryPipeline();
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected the retry loop smoke pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id.');

  const firstPause = await waitFor('the first validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.requestId ? run : null;
  });
  assert.strictEqual(firstPause.pendingValidation.iteration, 1, 'Expected the first validation pause to be attempt 1.');

  resumePipelineValidation(firstPause.runId, {
    comment: 'Trigger the retry path once.',
    decision: 'fail',
    nodeId: firstPause.pendingValidation.nodeId,
    requestId: firstPause.pendingValidation.requestId,
    runId: firstPause.runId,
  });

  const secondPause = await waitFor('the second validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.iteration === 2 ? run : null;
  });
  assert.strictEqual(secondPause.loopStates?.['retry-loop']?.attempt, 2, 'Expected the retry loop state to advance to attempt 2.');

  resumePipelineValidation(secondPause.runId, {
    comment: 'Allow the loop to exit.',
    decision: 'pass',
    nodeId: secondPause.pendingValidation.nodeId,
    requestId: secondPause.pendingValidation.requestId,
    runId: secondPause.runId,
  });

  const completedRun = await waitFor('the retry loop smoke run to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  assert.strictEqual(completedRun.loopStates?.['retry-loop']?.attempt, 2, 'Expected the loop to finish on attempt 2.');
  assert.strictEqual(completedRun.loopStates?.['retry-loop']?.status, 'completed', 'Expected the loop state to finish as completed.');
  assert.strictEqual(completedRun.nodeStates?.['validation-node']?.runCount, 2, 'Expected the validation node to run twice.');
  assert.strictEqual(completedRun.nodeStates?.['retry-loop']?.runCount, 2, 'Expected the retry loop node to evaluate twice.');
  assert.strictEqual(completedRun.nodeStates?.['text-output']?.status, 'completed', 'Expected the output node to complete after the loop exits.');
}

function resumePausedValidation(run, decision, comment) {
  resumePipelineValidation(run.runId, {
    comment,
    decision,
    nodeId: run.pendingValidation.nodeId,
    requestId: run.pendingValidation.requestId,
    runId: run.runId,
  });
}

async function verifyGenericRetryReentry() {
  const pipeline = buildGenericRetryReentryPipeline();
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [{
      id: 'openai',
      isConnected: true,
      name: 'Mock OpenAI',
    }],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected generic retry re-entry to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the generic retry re-entry pipeline.');

  const firstPause = await waitFor('the first generic retry validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'generic-validation' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  assert.strictEqual(firstPause.pendingValidation?.artifact?.text, 'Mock provider saw: Seed prompt', 'Expected the first generic retry pass to use the connected prompt input.');
  resumePausedValidation(firstPause, 'fail', 'Feed the generated text back into the retry target.');

  const secondPause = await waitFor('the second generic retry validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'generic-validation' && run?.pendingValidation?.iteration === 2 ? run : null;
  });
  assert.strictEqual(secondPause.pendingValidation?.artifact?.text, 'Mock provider saw: Mock provider saw: Seed prompt', 'Expected the second generic retry pass to consume the loop-carried artifact through the retry target input port.');
  assert.strictEqual(secondPause.nodeStates?.['generic-llm']?.runCount, 2, 'Expected the generic retry target step to rerun on the second attempt.');
  resumePausedValidation(secondPause, 'pass', 'Let the generic retry loop exit cleanly.');

  const completedRun = await waitFor('the generic retry re-entry run to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  assert.strictEqual(completedRun.nodeStates?.['generic-llm']?.runCount, 2, 'Expected the generic retry target step to keep both executions in its run count.');
  assert.strictEqual(completedRun.nodeStates?.['generic-output']?.status, 'completed', 'Expected the generic retry output to complete.');
}

async function verifyRepeatedArtifactTerminationRule() {
  const pipeline = buildRepeatedArtifactTerminationPipeline();
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected repeated-artifact termination to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the repeated-artifact termination pipeline.');

  const firstPause = await waitFor('the first repeated-artifact validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'repeat-validation' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  resumePausedValidation(firstPause, 'fail', 'Retry once with the same artifact.');

  const secondPause = await waitFor('the second repeated-artifact validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'repeat-validation' && run?.pendingValidation?.iteration === 2 ? run : null;
  });
  resumePausedValidation(secondPause, 'fail', 'Trigger the repeated-artifact stop rule.');

  const completedRun = await waitFor('the repeated-artifact termination run to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  assert.strictEqual(completedRun.loopStates?.['repeat-loop']?.attempt, 2, 'Expected the repeated-artifact loop to stop on attempt 2.');
  assert.strictEqual(completedRun.loopStates?.['repeat-loop']?.status, 'completed', 'Expected the repeated-artifact loop to complete by keeping the latest retry artifact.');
  assert.strictEqual(completedRun.nodeStates?.['repeat-loop']?.selectedBranch, 'retry-terminated', 'Expected the repeated-artifact loop node to report retry termination as its selected branch.');
  assert.strictEqual(completedRun.nodeStates?.['repeat-validation']?.runCount, 2, 'Expected the validation step to run twice before the repeated-artifact stop rule completed the loop.');
  assert(Array.isArray(completedRun.loopStates?.['repeat-loop']?.history) && completedRun.loopStates['repeat-loop'].history.some((entry) => String(entry?.message || '').includes('same artifact twice in a row')), 'Expected loop history to record the repeated-artifact termination reason.');
  assert.strictEqual(completedRun.nodeStates?.['repeat-output']?.status, 'completed', 'Expected the repeated-artifact output to complete.');
}

async function verifyNestedRetryLoops() {
  const pipeline = buildNestedRetryPipeline();
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected nested retry loops to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the nested retry loop pipeline.');

  const firstInnerPause = await waitFor('the first nested inner validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'nested-inner-validation' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  assert.strictEqual(firstInnerPause.pendingValidation.activeLoops?.length, 2, 'Expected the inner validation to see both retry loops on the first attempt.');
  resumePausedValidation(firstInnerPause, 'pass', 'Let the inner loop exit on the first outer attempt.');

  const firstOuterPause = await waitFor('the first nested outer validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'nested-outer-validation' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  resumePausedValidation(firstOuterPause, 'fail', 'Restart the outer loop once.');

  const secondOuterFirstInnerPause = await waitFor('the nested inner validation on outer attempt 2', () => {
    const run = getActiveRunSnapshot();
    if (run?.status !== 'paused' || run?.pendingValidation?.nodeId !== 'nested-inner-validation') {
      return null;
    }

    const activeLoops = run.pendingValidation.activeLoops || [];
    return activeLoops.length === 2 && activeLoops[0]?.iteration === 2 && activeLoops[1]?.iteration === 1 ? run : null;
  });
  assert(String(secondOuterFirstInnerPause.pendingValidation.loopPathLabel || '').includes('Outer retry attempt 2 of 3'), 'Expected the nested loop path to report the outer retry on attempt 2.');
  assert(String(secondOuterFirstInnerPause.pendingValidation.loopPathLabel || '').includes('Inner retry attempt 1 of 3'), 'Expected the nested loop path to reset the inner retry to attempt 1.');
  resumePausedValidation(secondOuterFirstInnerPause, 'fail', 'Trigger one inner retry inside the second outer attempt.');

  const secondOuterSecondInnerPause = await waitFor('the nested inner validation on inner attempt 2', () => {
    const run = getActiveRunSnapshot();
    if (run?.status !== 'paused' || run?.pendingValidation?.nodeId !== 'nested-inner-validation') {
      return null;
    }

    const activeLoops = run.pendingValidation.activeLoops || [];
    return activeLoops.length === 2 && activeLoops[0]?.iteration === 2 && activeLoops[1]?.iteration === 2 ? run : null;
  });
  assert.strictEqual(secondOuterSecondInnerPause.loopStates?.['nested-inner-loop']?.attempt, 2, 'Expected the inner retry loop to advance independently inside the outer retry.');
  resumePausedValidation(secondOuterSecondInnerPause, 'pass', 'Let the inner loop exit on attempt 2.');

  const secondOuterPause = await waitFor('the nested outer validation on attempt 2', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'nested-outer-validation' && run?.pendingValidation?.iteration === 2 ? run : null;
  });
  resumePausedValidation(secondOuterPause, 'pass', 'Let the outer loop exit on attempt 2.');

  const completedRun = await waitFor('the nested retry loop run to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  assert.strictEqual(completedRun.loopStates?.['nested-outer-loop']?.attempt, 2, 'Expected the outer retry loop to finish on attempt 2.');
  assert.strictEqual(completedRun.loopStates?.['nested-inner-loop']?.attempt, 2, 'Expected the inner retry loop to finish on attempt 2 inside the second outer pass.');
  assert.strictEqual(completedRun.nodeStates?.['nested-inner-validation']?.runCount, 3, 'Expected the inner validation to run across both outer attempts and one inner retry.');
  assert.strictEqual(completedRun.nodeStates?.['nested-outer-validation']?.runCount, 2, 'Expected the outer validation to run once per outer attempt.');
  assert(Array.isArray(completedRun.nodeStates?.['nested-inner-validation']?.history) && completedRun.nodeStates['nested-inner-validation'].history.length >= 2, 'Expected nested inner validation history to retain earlier attempts.');
}

async function verifyOverlappingRetryLoops() {
  const pipeline = buildOverlappingRetryPipeline();
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected overlapping retry loops to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the overlapping retry loop pipeline.');

  const secondStagePause = await waitFor('the first overlapping Stage B validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'overlap-validation-b' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  assert.strictEqual(secondStagePause.nodeStates?.['overlap-merge']?.selectedBranch, 'connected-branch', 'Expected the overlap merge to forward its connected branch on the first pass.');
  assert.strictEqual(secondStagePause.pendingValidation.activeLoops?.length, 2, 'Expected Stage B to sit inside both overlapping retry spans.');
  resumePausedValidation(secondStagePause, 'pass', 'Let the earlier loop complete on its first attempt.');

  const thirdStagePause = await waitFor('the first overlapping Stage C validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'overlap-validation-c' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  resumePausedValidation(thirdStagePause, 'fail', 'Retry from the overlapping later span once.');

  const secondStageRetryPause = await waitFor('the overlapping Stage B validation on loop attempt 2', () => {
    const run = getActiveRunSnapshot();
    if (run?.status !== 'paused' || run?.pendingValidation?.nodeId !== 'overlap-validation-b') {
      return null;
    }

    const activeLoops = run.pendingValidation.activeLoops || [];
    return activeLoops.length === 2 && activeLoops[0]?.iteration === 1 && activeLoops[1]?.iteration === 2 ? run : null;
  });
  assert(String(secondStageRetryPause.pendingValidation.loopPathLabel || '').includes('Retry merged stage attempt 1 of 3'), 'Expected the earlier overlapping loop to stay on attempt 1.');
  assert(String(secondStageRetryPause.pendingValidation.loopPathLabel || '').includes('Retry stage B+C attempt 2 of 3'), 'Expected the later overlapping loop to advance to attempt 2.');
  resumePausedValidation(secondStageRetryPause, 'pass', 'Let the shared middle span complete on the second overlapping attempt.');

  const thirdStageRetryPause = await waitFor('the overlapping Stage C validation on attempt 2', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'overlap-validation-c' && run?.pendingValidation?.iteration === 2 ? run : null;
  });
  resumePausedValidation(thirdStageRetryPause, 'pass', 'Exit the overlapping retry loop cleanly.');

  const completedRun = await waitFor('the overlapping retry loop run to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  assert.strictEqual(completedRun.nodeStates?.['overlap-merge']?.runCount, 1, 'Expected the merge entry to stay outside the later overlapping retry rerun.');
  assert.strictEqual(completedRun.nodeStates?.['overlap-validation-b']?.runCount, 2, 'Expected Stage B to rerun when the later overlapping loop retried.');
  assert.strictEqual(completedRun.nodeStates?.['overlap-loop-a']?.runCount, 2, 'Expected the shared earlier retry loop node to rerun inside the overlapping span.');
  assert.strictEqual(completedRun.nodeStates?.['overlap-validation-c']?.runCount, 2, 'Expected Stage C to run once per later loop attempt.');
  assert.strictEqual(completedRun.loopStates?.['overlap-loop-b']?.attempt, 2, 'Expected the later overlapping loop to finish on attempt 2.');
}

async function verifyBranchMergeLoopEntry() {
  const pipeline = buildBranchMergeLoopEntryPipeline();
  const analysis = analyzePipeline(pipeline, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected the branch merge retry-entry pipeline to be executable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected a pipeline run id for the branch merge loop-entry pipeline.');

  const firstPause = await waitFor('the first branch-merge validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'merge-validation' && run?.pendingValidation?.iteration === 1 ? run : null;
  });
  assert.strictEqual(firstPause.nodeStates?.['merge-entry']?.selectedBranch, 'connected-branch', 'Expected the loop entry merge to forward its connected branch on attempt 1.');

  resumePipelineValidation(firstPause.runId, {
    comment: 'Send the merged artifact back through the loop entry once.',
    decision: 'fail',
    nodeId: firstPause.pendingValidation.nodeId,
    requestId: firstPause.pendingValidation.requestId,
    runId: firstPause.runId,
  });

  const secondPause = await waitFor('the second branch-merge validation pause', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'paused' && run?.pendingValidation?.nodeId === 'merge-validation' && run?.pendingValidation?.iteration === 2 ? run : null;
  });

  assert.strictEqual(secondPause.nodeStates?.['merge-entry']?.runCount, 2, 'Expected the loop entry merge to rerun on attempt 2.');
  assert.strictEqual(secondPause.nodeStates?.['merge-entry']?.selectedBranch, 'loop-retry', 'Expected the loop entry merge to switch to the loop-carried retry artifact on attempt 2.');
  assert(Array.isArray(secondPause.loopStates?.['merge-loop']?.history) && secondPause.loopStates['merge-loop'].history.length >= 1, 'Expected loop history to capture the retry event.');
  assert.strictEqual(secondPause.loopStates?.['merge-loop']?.carriedArtifact?.text, 'Reuse this text through the loop entry merge.', 'Expected the retry artifact to be carried into the loop entry merge.');

  resumePipelineValidation(secondPause.runId, {
    comment: 'Let the branch-merge retry entry exit cleanly.',
    decision: 'pass',
    nodeId: secondPause.pendingValidation.nodeId,
    requestId: secondPause.pendingValidation.requestId,
    runId: secondPause.runId,
  });

  const completedRun = await waitFor('the branch-merge retry entry run to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  assert.strictEqual(completedRun.loopStates?.['merge-loop']?.status, 'completed', 'Expected the branch-merge retry entry loop to complete.');
  assert.strictEqual(completedRun.nodeStates?.['merge-entry']?.runCount, 2, 'Expected the loop entry merge to keep both attempts in its run count.');
  assert(Array.isArray(completedRun.nodeStates?.['merge-entry']?.history) && completedRun.nodeStates['merge-entry'].history.length === 1, 'Expected the loop entry merge to retain its previous attempt history.');
}

async function main() {
  await cleanupActiveRun();

  const cappedLoop = buildValidationRetryPipeline({
    nodes: buildValidationRetryPipeline().nodes.map((node) => (
      node.id === 'retry-loop'
        ? {
            ...node,
            config: {
              ...node.config,
              maxAttempts: PIPELINE_RETRY_LOOP_MAX_ATTEMPTS + 1,
            },
          }
        : node
    )),
  });
  const cappedAnalysis = analyzePipeline(cappedLoop, {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(cappedAnalysis.executable, false, 'Expected an over-limit retry loop to be blocked.');
  assert(cappedAnalysis.issues.some((issue) => String(issue.message || '').includes(String(PIPELINE_RETRY_LOOP_MAX_ATTEMPTS))), 'Expected the attempt cap error to mention the safety limit.');

  const leakAnalysis = analyzePipeline(buildLoopLeakPipeline(), {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(leakAnalysis.executable, false, 'Expected a leaking retry loop span to be blocked.');
  assert(leakAnalysis.issues.some((issue) => String(issue.message || '').toLowerCase().includes('retry span') || String(issue.message || '').toLowerCase().includes('loop result')), 'Expected a leaking retry loop span to report a loop boundary error.');

  const rawCycleAnalysis = analyzePipeline(buildRawCyclePipeline(), {
    hardware: null,
    providers: [],
    toolCatalog: [],
    tools: [],
  });
  assert.strictEqual(rawCycleAnalysis.executable, false, 'Expected raw graph cycles to stay blocked.');
  assert(rawCycleAnalysis.issues.some((issue) => String(issue.message || '').toLowerCase().includes('cycle')), 'Expected raw cycle analysis to mention the cycle rejection.');

  await verifyRuntimeRetryLoop();
  await verifyGenericRetryReentry();
  await verifyRepeatedArtifactTerminationRule();
  await verifyNestedRetryLoops();
  await verifyOverlappingRetryLoops();
  await verifyBranchMergeLoopEntry();
  console.log('Pipeline retry loop verification passed.');
}

main().catch(async (error) => {
  await cleanupActiveRun();
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
