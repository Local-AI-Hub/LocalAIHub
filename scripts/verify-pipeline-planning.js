const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-pipeline-planning');

function buildMockPlanReply() {
  return JSON.stringify({
    title: 'Episode 1 scene plan',
    overview: {
      meaningIntent: 'Frame the episode as a grounded setup that earns curiosity and emotional investment.',
      viewerTakeaway: 'The viewer should understand the stakes, the central tension, and why the protagonist keeps going.',
      narrativeArc: 'Open with context, escalate into a choice, and end with a forward-driving unresolved question.',
      toneStrategy: 'Keep the treatment cinematic, intimate, and practical for later media generation.',
      continuityNotes: ['Carry the same protagonist styling across every scene.', 'Keep location transitions explicit and chronological.'],
      riskNotes: ['The source leaves some visual specifics open, so the prompts should stay flexible rather than over-claiming detail.'],
    },
    scenes: [
      {
        sceneId: 'scene-1',
        sourceSpanLabel: 'Opening setup',
        meaningIntent: 'Introduce the protagonist and establish the core setting.',
        viewerTakeaway: 'This world feels constrained, lived-in, and ready to change.',
        sceneConcept: 'A grounded opening image that places the protagonist in a modest but visually rich environment.',
        treatmentApproach: 'Use restrained camera language, readable geography, and practical detail over spectacle.',
        narrationDraft: 'Open by naming the setting and the protagonist\'s present limitation in plain language.',
        visualPromptDraft: 'Cinematic interior, grounded lived-in details, protagonist at the center, soft morning light, practical realism, high continuity.',
        riskNotes: ['Avoid inventing props or wardrobe details not supported by the source.'],
      },
      {
        sceneId: 'scene-2',
        sourceSpanLabel: 'Decision beat',
        meaningIntent: 'Translate the script\'s turning point into a visual decision scene.',
        viewerTakeaway: 'The protagonist is choosing movement despite uncertainty.',
        sceneConcept: 'A moment of hesitation followed by a concrete decision that changes the episode direction.',
        treatmentApproach: 'Make the emotional beat clear first, then attach a strong visual action that can drive later shot work.',
        narrationDraft: 'Explain the cost of staying still and the reason the protagonist decides to act now.',
        visualPromptDraft: 'Character-driven turning point, visible hesitation, then decisive action, grounded cinematic realism, continuity with prior scene.',
        riskNotes: ['Leave room for later generation passes to refine exact blocking.'],
      },
    ],
    openQuestions: ['Should the later media pass emphasize realism or slight stylization for the final reveal?'],
  }, null, 2);
}

function getMessageText(messages = []) {
  return messages.map((message) => {
    const content = message?.content;
    if (Array.isArray(content)) {
      return content.map((part) => part?.text || '').join('\n');
    }

    return String(content || '');
  }).join('\n');
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

  if (
    (normalizedParent.endsWith('/electron/services/pipelineArtifactService.js') || normalizedParent.endsWith('/electron/services/pipelineOutputStoreService.js'))
    && request === './configService'
  ) {
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
          assert(Array.isArray(payload.messages) && payload.messages.length > 0, 'Expected the pipeline to send at least one message to the provider.');
          const messageText = getMessageText(payload.messages);
          if (/Validation rules:/i.test(messageText)) {
            assert(/Local AI Hub plan-review evidence:/i.test(messageText), 'Expected plan validation to include local plan-review evidence.');
            return {
              message: {
                content: JSON.stringify({
                  decision: 'pass',
                  reason: 'The plan is structurally usable and matches the scene-planning rubric.',
                  summary: 'Plan validation passed.',
                  confidence: 0.91,
                  evidenceMode: 'structured-plan',
                  evidenceLimitations: 'Local plan-review evidence is bounded and heuristic, so the validator treats it as supporting evidence.',
                  criteriaResults: [
                    { criterion: 'Plan structure', decision: 'pass', reason: 'The plan contains overview, scenes, prompts, and risk notes.' },
                  ],
                }),
              },
            };
          }

          assert.strictEqual(payload.timeoutMs, 60000, 'Expected planner to use the extended provider timeout for structured planning.');
          assert.strictEqual(payload.maxOutputTokens, 4096, 'Expected planner to request enough output budget for structured JSON.');
          assert(/planner request/i.test(String(payload.timeoutMessage || '')), 'Expected planner to pass a planner-specific timeout message.');
          assert.strictEqual(payload.responseFormat?.type, 'json_schema', 'Expected planner to request provider structured JSON when the planning schema defines it.');
          assert(payload.responseFormat?.schema?.properties?.scenes, 'Expected planner structured output request to include the longform scene JSON schema.');
          return {
            message: {
              content: buildMockPlanReply(),
            },
          };
        },
        listProviderConnections: async () => ([{
          id: 'openai',
          isConnected: true,
          name: 'Mock OpenAI',
        }]),
        runProviderOperation: async () => ({ message: { content: '' } }),
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
  buildContextMaps,
  createEdge,
  createEmptyPipeline,
  createNode,
} = require('../electron/shared/pipelineSchema.cjs');
const {
  cancelPipelineRun,
  getActiveRunSnapshot,
  runPipeline,
} = require('../electron/services/pipelineExecutionService');
const { listPipelineOutputs } = require('../electron/services/pipelineOutputStoreService');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(description, predicate, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }
    await wait(80);
  }

  throw new Error('Timed out while waiting for ' + description + '.');
}

async function cleanupActiveRun() {
  const activeRun = getActiveRunSnapshot();
  if (!activeRun || !['running', 'paused'].includes(activeRun.status)) {
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

function createPlanningCoreNodes() {
  const scriptInput = createNode('textInput', {
    id: 'planning-script-input',
    label: 'Script input',
    config: {
      text: 'A determined protagonist wakes before sunrise, realizes time is running out, and chooses to leave home to confront a problem they have been avoiding.',
    },
  });
  const planningPacket = createNode('planningPacket', {
    id: 'planning-packet-node',
    label: 'Scene planning packet',
    config: {
      goal: 'Break this script into a usable longform-media scene plan that preserves meaning, viewer takeaway, treatment, risks, and prompt drafts.',
      constraintsText: 'Keep scenes grounded and visually coherent.\nDo not invent unsupported facts.',
      desiredOutputNotes: 'Return a scene plan that is practical for later longform media generation.',
      riskNotesText: 'Flag any source ambiguity instead of pretending certainty.',
      schemaId: 'longformMedia.scenePlan.v1',
      stylePolicyText: 'Use plain-English scene reasoning.\nKeep continuity visible across scenes.',
    },
  });
  const planner = createNode('planner', {
    id: 'planner-node',
    label: 'Structured planner',
    config: {
      executionMode: 'cloud',
      instruction: 'Stay concise but preserve staged reasoning and practical visual prompts.',
      model: 'mock-scene-planner',
      providerId: 'openai',
      schemaId: 'longformMedia.scenePlan.v1',
    },
  });

  return { planner, planningPacket, scriptInput };
}

function buildPlanningPipeline() {
  const { planner, planningPacket, scriptInput } = createPlanningCoreNodes();
  const validation = createNode('validation', {
    id: 'plan-validation-node',
    label: 'Plan validation',
    config: {
      llmExecutionMode: 'cloud',
      mode: 'llm',
      model: 'mock-validator',
      providerId: 'openai',
      ruleset: 'Pass only if the structured plan is grounded, scene-complete, and practical for later media generation.',
    },
  });
  const retryLoop = createNode('retryLoop', {
    id: 'plan-retry-loop-node',
    label: 'Plan review loop',
    config: {
      maxAttempts: 2,
      retryTargetNodeId: planner.id,
      retryTerminationAction: 'fail',
      stopWhenRetryArtifactRepeats: true,
    },
  });
  const planScenes = createNode('planScenes', {
    id: 'plan-scenes-node',
    label: 'Plan scene text',
  });
  const planOutput = createNode('planOutput', {
    id: 'plan-output-node',
    label: 'Plan output',
    config: {
      title: 'Episode scene plan',
    },
  });
  const collectionOutput = createNode('collectionOutput', {
    id: 'scene-collection-output-node',
    label: 'Scene text output',
    config: {
      title: 'Scene prompt drafts',
    },
  });

  return createEmptyPipeline({
    id: 'verify-pipeline-planning',
    name: 'Verify Planning Pipeline',
    nodes: [scriptInput, planningPacket, planner, validation, retryLoop, planScenes, planOutput, collectionOutput],
    edges: [
      createEdge(scriptInput.id, 'text', planningPacket.id, 'source'),
      createEdge(planningPacket.id, 'packet', planner.id, 'packet'),
      createEdge(planner.id, 'plan', validation.id, 'input'),
      createEdge(validation.id, 'pass', retryLoop.id, 'complete'),
      createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      createEdge(retryLoop.id, 'result', planOutput.id, 'plan'),
      createEdge(retryLoop.id, 'result', planScenes.id, 'plan'),
      createEdge(planScenes.id, 'collection', collectionOutput.id, 'collection'),
    ],
  });
}

function buildPlanRetryPipeline() {
  const { planner, planningPacket, scriptInput } = createPlanningCoreNodes();
  const validation = createNode('validation', {
    id: 'plan-validation-node',
    label: 'Plan validation',
    config: {
      llmExecutionMode: 'cloud',
      mode: 'llm',
      model: 'mock-validator',
      providerId: 'openai',
      ruleset: 'Fail plans that need revision so Retry Loop can rerun the planner.',
    },
  });
  const retryLoop = createNode('retryLoop', {
    id: 'plan-retry-loop-node',
    label: 'Revise plan loop',
    config: {
      maxAttempts: 2,
      retryTargetNodeId: planner.id,
      retryTerminationAction: 'fail',
      stopWhenRetryArtifactRepeats: true,
    },
  });
  const planOutput = createNode('planOutput', {
    id: 'retry-plan-output-node',
    label: 'Retry result output',
    config: {
      title: 'Validated scene plan',
    },
  });

  return createEmptyPipeline({
    id: 'verify-pipeline-planning-retry',
    name: 'Verify Planning Retry Pipeline',
    nodes: [scriptInput, planningPacket, planner, validation, retryLoop, planOutput],
    edges: [
      createEdge(scriptInput.id, 'text', planningPacket.id, 'source'),
      createEdge(planningPacket.id, 'packet', planner.id, 'packet'),
      createEdge(planner.id, 'plan', validation.id, 'input'),
      createEdge(validation.id, 'pass', retryLoop.id, 'complete'),
      createEdge(validation.id, 'fail', retryLoop.id, 'retry'),
      createEdge(retryLoop.id, 'result', planOutput.id, 'plan'),
    ],
  });
}

function getNodeOutputArtifact(run, nodeId, portId) {
  return run?.nodeStates?.[nodeId]?.outputs?.[portId] || null;
}

async function main() {
  await cleanupActiveRun();
  fs.rmSync(TEST_STORAGE_ROOT, { force: true, recursive: true });
  fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });

  const pipeline = buildPlanningPipeline();
  const retryPipeline = buildPlanRetryPipeline();
  const context = buildContextMaps({
    hardware: null,
    providers: [{
      id: 'openai',
      isConnected: true,
      name: 'Mock OpenAI',
    }],
    toolCatalog: [],
    tools: [],
  });

  const analysis = analyzePipeline(pipeline, context);
  assert.strictEqual(analysis.executable, true, analysis.primaryIssue?.message || 'Expected planning pipeline to be executable.');
  assert(analysis.reachableNodeIds.includes('plan-validation-node'), 'Expected plan validation to be reachable.');
  assert(analysis.reachableNodeIds.includes('plan-scenes-node'), 'Expected Plan Scenes to be reachable.');
  assert(analysis.reachableNodeIds.includes('plan-retry-loop-node'), 'Expected Retry Loop to be reachable in the executable planning flow.');

  const retryAnalysis = analyzePipeline(retryPipeline, context);
  assert.strictEqual(retryAnalysis.executable, true, retryAnalysis.primaryIssue?.message || 'Expected plan retry pipeline to be executable.');
  assert(retryAnalysis.reachableNodeIds.includes('plan-retry-loop-node'), 'Expected Retry Loop to be reachable for failed plan review.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected runPipeline to return a run id.');

  const completedRun = await waitFor('the planning pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  const validationState = completedRun.nodeStates?.['plan-validation-node'];
  assert.strictEqual(validationState?.selectedBranch, 'pass', 'Expected plan validation to route to pass.');
  assert.strictEqual(validationState?.validation?.evidenceMode, 'structured-plan', 'Expected validation to treat Plan as structured plan evidence.');
  assert(validationState.validation.planReview?.structuralValidation?.ok, 'Expected validation state to include plan review evidence.');

  const validatedPlan = getNodeOutputArtifact(completedRun, 'plan-validation-node', 'pass');
  assert.strictEqual(validatedPlan?.kind, 'plan', 'Expected validation pass output to stay a Plan artifact.');
  assert.strictEqual(validatedPlan.lastValidation?.decision, 'pass', 'Expected validation to attach review results to the routed Plan artifact.');
  assert(validatedPlan.lastValidation?.planReview?.structuralValidation?.ok, 'Expected routed Plan to carry plan review evidence for retry/correction flow.');

  const planResult = completedRun.terminalResults?.find((entry) => entry.kind === 'plan') || null;
  assert(planResult, 'Expected a terminal Plan result from the planning pipeline.');
  assert(planResult.destinationPath && fs.existsSync(planResult.destinationPath), 'Expected the saved .plan.json output to exist.');
  assert(planResult.destinationPath.endsWith('.plan.json'), 'Expected the saved plan output to use the .plan.json extension.');
  assert.strictEqual(planResult.artifact?.kind, 'plan', 'Expected the saved artifact kind to stay plan.');
  assert.strictEqual(planResult.artifact?.isFinalOutput, true, 'Expected explicit Plan Output artifacts to be marked as final outputs.');
  assert.strictEqual(planResult.artifact?.schemaId, 'longformMedia.scenePlan.v1', 'Expected the saved plan artifact to preserve the planning schema id.');
  assert.strictEqual(Array.isArray(planResult.artifact?.plan?.scenes), true, 'Expected the saved plan artifact to include scenes.');
  assert.strictEqual(planResult.artifact.plan.scenes.length, 2, 'Expected the saved plan artifact to include two scenes.');

  const sceneCollection = getNodeOutputArtifact(completedRun, 'plan-scenes-node', 'collection');
  assert(sceneCollection, 'Expected Plan Scenes to produce an ordered text collection.');
  assert.strictEqual(sceneCollection.kind, 'collection', 'Expected Plan Scenes output to stay a collection artifact.');
  assert.strictEqual(sceneCollection.itemKind, 'text', 'Expected Plan Scenes to produce a text collection.');
  assert.strictEqual(sceneCollection.items.length, 2, 'Expected Plan Scenes to produce one text item per scene.');
  assert(/Visual prompt draft:/i.test(sceneCollection.items[0].artifact.text), 'Expected scene text items to carry prompt draft content.');

  const collectionResult = completedRun.terminalResults?.find((entry) => entry.kind === 'collection') || null;
  assert(collectionResult, 'Expected a terminal collection result from Plan Scenes.');
  assert(collectionResult.directoryPath && fs.existsSync(collectionResult.directoryPath), 'Expected the saved collection output directory to exist.');
  assert.strictEqual(collectionResult.artifact?.isFinalOutput, true, 'Expected explicit Collection Output artifacts to be marked as final outputs.');

  const outputsDirectory = path.dirname(planResult.destinationPath);
  const savedOutputFiles = fs.readdirSync(outputsDirectory);
  assert(savedOutputFiles.some((entry) => entry.endsWith('.plan.json')), 'Expected a saved .plan.json file in the run outputs.');
  assert(!savedOutputFiles.some((entry) => entry.endsWith('.preview.json')), 'Expected the corrected flow not to save Preview node artifacts.');
  assert(!savedOutputFiles.some((entry) => entry.endsWith('.audit.json')), 'Expected the corrected flow not to save Audit node artifacts.');

  const discoveredOutputs = await listPipelineOutputs();
  const runOutputs = discoveredOutputs.filter((entry) => entry.runId === initialRun.runId);
  assert(runOutputs.some((entry) => entry.kind === 'plan' && entry.outputPath.endsWith('.plan.json')), 'Expected listPipelineOutputs to rediscover the typed plan JSON output.');
  assert(runOutputs.some((entry) => entry.kind === 'collection'), 'Expected listPipelineOutputs to rediscover the scene text collection output.');
  assert(!runOutputs.some((entry) => entry.kind === 'preview'), 'Expected rediscovery not to find new Preview outputs from this flow.');
  assert(!runOutputs.some((entry) => entry.kind === 'audit'), 'Expected rediscovery not to find new Audit outputs from this flow.');

  console.log('Verified planning pipeline packet->planner->validation->plan/scene-collection flow at:', outputsDirectory);
}

main().catch(async (error) => {
  console.error(error);
  await cleanupActiveRun();
  process.exitCode = 1;
});
