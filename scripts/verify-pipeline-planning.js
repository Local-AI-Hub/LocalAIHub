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
        riskNotes: ['Leave room for later preview passes to refine exact blocking.'],
      },
    ],
    openQuestions: ['Should the later media pass emphasize realism or slight stylization for the final reveal?'],
  }, null, 2);
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
          assert(Array.isArray(payload.messages) && payload.messages.length > 0, 'Expected planner to send at least one message to the provider.');
          assert.strictEqual(payload.timeoutMs, 60000, 'Expected planner to use the extended provider timeout for structured planning.');
          assert(/planner request/i.test(String(payload.timeoutMessage || '')), 'Expected planner to pass a planner-specific timeout message.');
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

function buildPlanningPipeline(includePlanOutput = true) {
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
  const preview = createNode('preview', {
    id: 'preview-node',
    label: 'Plan preview',
  });
  const audit = createNode('audit', {
    id: 'audit-node',
    label: 'Plan audit',
  });
  const planOutput = createNode('planOutput', {
    id: 'plan-output-node',
    label: 'Plan output',
    config: {
      title: 'Episode scene plan',
    },
  });

  const nodes = [scriptInput, planningPacket, planner, preview, audit];
  const edges = [
    createEdge(scriptInput.id, 'text', planningPacket.id, 'source'),
    createEdge(planningPacket.id, 'packet', planner.id, 'packet'),
    createEdge(planner.id, 'plan', preview.id, 'plan'),
    createEdge(planner.id, 'plan', audit.id, 'plan'),
    createEdge(preview.id, 'preview', audit.id, 'preview'),
  ];

  if (includePlanOutput) {
    nodes.push(planOutput);
    edges.push(createEdge(planner.id, 'plan', planOutput.id, 'plan'));
  }

  return createEmptyPipeline({
    id: includePlanOutput ? 'verify-pipeline-planning' : 'verify-pipeline-planning-review-only',
    name: includePlanOutput ? 'Verify Planning Pipeline' : 'Verify Planning Review Pipeline',
    nodes,
    edges,
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
  const reviewOnlyPipeline = buildPlanningPipeline(false);
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
  const reviewOnlyAnalysis = analyzePipeline(reviewOnlyPipeline, context);
  assert.strictEqual(reviewOnlyAnalysis.executable, true, reviewOnlyAnalysis.primaryIssue?.message || 'Expected the review-only planning pipeline to be executable.');
  assert(reviewOnlyAnalysis.reachableNodeIds.includes('preview-node'), 'Expected the review-only pipeline to keep the Preview node reachable.');
  assert(reviewOnlyAnalysis.reachableNodeIds.includes('audit-node'), 'Expected the review-only pipeline to keep the Audit node reachable.');

  const initialRun = await runPipeline(pipeline);
  assert(initialRun?.runId, 'Expected runPipeline to return a run id.');

  const completedRun = await waitFor('the planning pipeline to complete', () => {
    const run = getActiveRunSnapshot();
    return run?.status === 'completed' && run?.runId === initialRun.runId ? run : null;
  });

  const result = completedRun.terminalResults?.[0] || null;
  assert(result, 'Expected one terminal result from the planning pipeline.');
  assert.strictEqual(result.kind, 'plan', 'Expected the terminal result to be a typed plan artifact.');
  assert(result.destinationPath && fs.existsSync(result.destinationPath), 'Expected the saved .plan.json output to exist.');
  assert.strictEqual(path.extname(result.destinationPath), '.json', 'Expected the saved plan output to be JSON.');
  assert(result.destinationPath.endsWith('.plan.json'), 'Expected the saved plan output to use the .plan.json extension.');
  assert.strictEqual(result.artifact?.kind, 'plan', 'Expected the saved artifact kind to stay plan.');
  assert.strictEqual(result.artifact?.schemaId, 'longformMedia.scenePlan.v1', 'Expected the saved plan artifact to preserve the planning schema id.');
  assert.strictEqual(Array.isArray(result.artifact?.plan?.scenes), true, 'Expected the saved plan artifact to include scenes.');
  assert.strictEqual(result.artifact.plan.scenes.length, 2, 'Expected the saved plan artifact to include two scenes.');
  assert(result.artifact.plan.overview?.meaningIntent, 'Expected the saved plan artifact to keep overview intent.');

  const previewArtifact = getNodeOutputArtifact(completedRun, 'preview-node', 'preview');
  assert(previewArtifact, 'Expected the Preview node to produce a typed preview artifact.');
  assert.strictEqual(previewArtifact.kind, 'preview', 'Expected the Preview node output kind to stay preview.');
  assert(previewArtifact.destinationPath && fs.existsSync(previewArtifact.destinationPath), 'Expected the saved .preview.json output to exist.');
  assert(previewArtifact.destinationPath.endsWith('.preview.json'), 'Expected the preview output to use the .preview.json extension.');
  assert.strictEqual(previewArtifact.preview?.sceneCount, 2, 'Expected the preview document to include two scenes.');
  assert.strictEqual(Array.isArray(previewArtifact.preview?.scenes), true, 'Expected the preview artifact to expose preview scenes.');
  assert.strictEqual(previewArtifact.preview.scenes.length, 2, 'Expected the preview artifact to expose two preview scenes.');
  assert(previewArtifact.preview.limitationNote, 'Expected the preview artifact to include a review boundary note.');

  const auditArtifact = getNodeOutputArtifact(completedRun, 'audit-node', 'audit');
  assert(auditArtifact, 'Expected the Audit node to produce a typed audit artifact.');
  assert.strictEqual(auditArtifact.kind, 'audit', 'Expected the Audit node output kind to stay audit.');
  assert(auditArtifact.destinationPath && fs.existsSync(auditArtifact.destinationPath), 'Expected the saved .audit.json output to exist.');
  assert(auditArtifact.destinationPath.endsWith('.audit.json'), 'Expected the audit output to use the .audit.json extension.');
  assert.strictEqual(auditArtifact.audit?.previewCoverage?.connected, true, 'Expected the audit to record connected preview coverage.');
  assert.strictEqual(auditArtifact.audit?.structuralValidation?.ok, true, 'Expected the audit to preserve schema validation success.');
  assert(Array.isArray(auditArtifact.audit?.heuristicsUsed), 'Expected the audit artifact to list the heuristics it used.');
  assert(auditArtifact.audit.heuristicsUsed.includes('Planning schema validation'), 'Expected the audit heuristics to mention schema validation.');
  assert(auditArtifact.audit.heuristicsUsed.includes('Preview coverage alignment'), 'Expected the audit heuristics to mention preview coverage alignment when a preview is connected.');

  const outputsDirectory = path.dirname(result.destinationPath);
  const savedOutputFiles = fs.readdirSync(outputsDirectory);
  assert(savedOutputFiles.some((entry) => entry.endsWith('.plan.json')), 'Expected a saved .plan.json file in the run outputs.');
  assert(savedOutputFiles.some((entry) => entry.endsWith('.preview.json')), 'Expected a saved .preview.json file in the run outputs.');
  assert(savedOutputFiles.some((entry) => entry.endsWith('.audit.json')), 'Expected a saved .audit.json file in the run outputs.');

  const savedPreview = JSON.parse(fs.readFileSync(previewArtifact.destinationPath, 'utf8'));
  assert.strictEqual(savedPreview.previewMode, 'scenePromptCards.v1', 'Expected the preview JSON to preserve its bounded review mode.');
  assert.strictEqual(savedPreview.sceneCount, 2, 'Expected the preview JSON to preserve the scene count.');
  assert(savedPreview.scenes.every((scene) => scene.promptPreview && scene.promptReadiness), 'Expected every preview scene to keep prompt preview fields.');

  const savedAudit = JSON.parse(fs.readFileSync(auditArtifact.destinationPath, 'utf8'));
  assert.strictEqual(savedAudit.previewCoverage?.connected, true, 'Expected the audit JSON to preserve preview coverage connection.');
  assert.strictEqual(savedAudit.structuralValidation?.ok, true, 'Expected the audit JSON to preserve structural validation success.');
  assert(Array.isArray(savedAudit.findings), 'Expected the audit JSON to include a findings array.');

  const discoveredOutputs = await listPipelineOutputs();
  const runOutputs = discoveredOutputs.filter((entry) => entry.runId === initialRun.runId);
  assert(runOutputs.some((entry) => entry.kind === 'plan' && entry.outputPath.endsWith('.plan.json')), 'Expected listPipelineOutputs to rediscover the typed plan JSON output.');
  assert(runOutputs.some((entry) => entry.kind === 'preview' && entry.outputPath.endsWith('.preview.json')), 'Expected listPipelineOutputs to rediscover the typed preview JSON output.');
  assert(runOutputs.some((entry) => entry.kind === 'audit' && entry.outputPath.endsWith('.audit.json')), 'Expected listPipelineOutputs to rediscover the typed audit JSON output.');

  const discoveredPreview = runOutputs.find((entry) => entry.kind === 'preview');
  assert.strictEqual(discoveredPreview?.artifact?.kind, 'preview', 'Expected rediscovered preview outputs to stay typed preview artifacts.');
  assert.strictEqual(discoveredPreview?.artifact?.preview?.sceneCount, 2, 'Expected rediscovered preview artifacts to keep scene counts.');

  const discoveredAudit = runOutputs.find((entry) => entry.kind === 'audit');
  assert.strictEqual(discoveredAudit?.artifact?.kind, 'audit', 'Expected rediscovered audit outputs to stay typed audit artifacts.');
  assert.strictEqual(discoveredAudit?.artifact?.audit?.previewCoverage?.connected, true, 'Expected rediscovered audit artifacts to keep preview coverage state.');

  console.log('Verified planning pipeline packet->planner->plan->preview/audit flow at:', outputsDirectory);
}

main().catch(async (error) => {
  console.error(error);
  await cleanupActiveRun();
  process.exitCode = 1;
});