const assert = require('assert');
const path = require('path');
const Module = require('module');

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
        chatWithProvider: async () => {
          throw new Error('Cloud provider calls are not part of the pipeline loop smoke test.');
        },
        listProviderConnections: async () => [],
        runProviderOperation: async () => {
          throw new Error('Cloud provider operations are not part of the pipeline loop smoke test.');
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
  console.log('Pipeline retry loop verification passed.');
}

main().catch(async (error) => {
  await cleanupActiveRun();
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
