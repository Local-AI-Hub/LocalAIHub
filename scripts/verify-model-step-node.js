const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { pathToFileURL } = require('url');
const esbuild = require('esbuild');

const pipelineSchema = require('../electron/shared/pipelineSchema.cjs');

async function loadPipelineUiBundle() {
  const outfile = path.join(os.tmpdir(), 'local-ai-hub-pipeline-ui.verify.cjs');
  esbuild.buildSync({
    bundle: true,
    entryPoints: [path.resolve(__dirname, '../src/lib/pipeline-ui.js')],
    format: 'cjs',
    outfile,
    platform: 'node',
    target: ['node18'],
  });
  return require(outfile);
}

function verifyPipelineBuilderSourceGuards() {
  const panelPath = path.resolve(__dirname, '../src/components/PipelineBuilderPanel.jsx');
  const source = fs.readFileSync(panelPath, 'utf8');
  assert(/const\s+transcriptionTools\s*=\s*useMemo\(/.test(source), 'Expected PipelineBuilderPanel to declare transcriptionTools before using it in the Model Step inspector.');
  assert(/const\s+isLocalImageAnalysisMode\s*=/.test(source), 'Expected PipelineBuilderPanel to declare isLocalImageAnalysisMode.');
  assert(/const\s+isLocalTranscriptionMode\s*=/.test(source), 'Expected PipelineBuilderPanel to declare isLocalTranscriptionMode.');
  assert(!/\bhandleRefreshModels\(selectedNode\)/.test(source), 'Expected Model Step refresh actions to use the live refreshNodeModels path.');
  assert(!/selectedNode\.type === 'imageGenerate'/.test(source), 'Expected removed standalone image generation inspector branches to stay gone.');
  assert(!/selectedNode\.type === 'imageAnalyze'/.test(source), 'Expected removed standalone image analysis inspector branches to stay gone.');
  assert(!/selectedNode\.type === 'whisperTranscribe'/.test(source), 'Expected removed standalone transcription inspector branches to stay gone.');
  assert(source.includes('<option value="continuation">Continuation</option>'), 'Expected Model Step AudioCraft mode picker to expose continuation mode.');
  assert(source.includes('llm-local-audio-seed'), 'Expected Model Step AudioCraft continuation UI to expose seed seconds.');
  assert(source.includes('llm-local-audio-repeat'), 'Expected Model Step AudioCraft continuation UI to expose repeat count.');
  assert(source.includes('Each repeat uses the end of the current audio as the next seed'), 'Expected Model Step AudioCraft continuation UI to explain repeat continuation semantics.');
  assert(source.includes('llm-local-audio-append'), 'Expected Model Step AudioCraft continuation UI to expose append-source output mode.');
  assert(source.includes('Advanced AudioCraft settings'), 'Expected Model Step AudioCraft UI to keep advanced generation settings available but collapsed.');
  assert(source.includes('llm-prompt-style'), 'Expected Model Step inspector to expose the Prompt Style selector.');
  assert(source.includes('collection-map-prompt-style'), 'Expected collectionMap inspector to expose the Prompt Style selector for text mappings.');
  const checkpointOptionHelperUses = source.match(/buildStableDiffusionCheckpointOption/g) || [];
  assert(checkpointOptionHelperUses.length >= 3, 'Expected Model Step and collectionMap checkpoint refresh options to use the shared checkpoint identity helper.');
}

async function main() {
  const defaultConfig = pipelineSchema.getDefaultNodeConfig('llmPrompt');
  assert(defaultConfig && typeof defaultConfig === 'object', 'Expected a default config object for Model Step.');
  assert.strictEqual(defaultConfig.operationId, pipelineSchema.PIPELINE_OPERATION_IDS.LLM_PROMPT, 'Expected Model Step to default to the general llmPrompt operation.');
  assert.strictEqual(defaultConfig.executionMode, 'cloud', 'Expected Model Step to default to cloud execution mode.');
  assert.strictEqual(defaultConfig.promptStyleId, '', 'Expected Model Step prompt style to default to none.');
  assert.strictEqual(pipelineSchema.getDefaultNodeConfig('collectionMap').promptStyleId, '', 'Expected collectionMap prompt style to default to none.');

  const pipelineUi = await loadPipelineUiBundle();
  const paletteGroups = pipelineUi.getNodePaletteGroups();
  const aiStepsGroup = paletteGroups.find((group) => group.label === 'AI Steps');
  assert(aiStepsGroup, 'Expected an AI Steps palette group.');
  assert(aiStepsGroup.entries.some((entry) => entry.type === 'llmPrompt'), 'Expected Model Step in the AI Steps palette.');
  assert(aiStepsGroup.entries.some((entry) => entry.type === 'graphWorkflow'), 'Expected Graph Workflow in the AI Steps palette.');
  assert(aiStepsGroup.entries.some((entry) => entry.type === 'collectionMap'), 'Expected Map Collection in the AI Steps palette.');
  assert(aiStepsGroup.entries.some((entry) => entry.type === 'validation'), 'Expected Validation in the AI Steps palette.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('validation').type, 'validation', 'Validation node type id should remain stable.');
  assert.strictEqual(pipelineSchema.getNodeTypeDefinition('validation').category, 'AI Steps', 'Validation should live under AI Steps.');
  assert(!paletteGroups.some((group) => group.label === 'Validation'), 'Expected no standalone Validation palette group after moving Validation into AI Steps.');
  assert(!paletteGroups.some((group) => group.entries.some((entry) => ['imageGenerate', 'imageAnalyze', 'whisperTranscribe'].includes(entry.type))), 'Expected removed standalone AI nodes to stay out of the palette.');

  const node = pipelineUi.createPositionedNode('llmPrompt', []);
  assert(node && node.type === 'llmPrompt', 'Expected createPositionedNode to build a Model Step node from the palette shape.');
  assert.strictEqual(node.label, 'Model Step', 'Expected fresh Model Step nodes to use the Model Step label.');
  assert.deepStrictEqual(node.position, { x: 120, y: 120 }, 'Expected the palette-created first Model Step node to use the default positioned layout.');

  const inputPorts = pipelineSchema.getPipelineNodePorts(node, 'input');
  const outputPorts = pipelineSchema.getPipelineNodePorts(node, 'output');
  assert(Array.isArray(inputPorts) && inputPorts.length >= 1, 'Expected Model Step input ports to resolve without throwing.');
  assert(Array.isArray(outputPorts) && outputPorts.length >= 1, 'Expected Model Step output ports to resolve without throwing.');
  assert(inputPorts.some((port) => port.id === 'prompt'), 'Expected Model Step to expose a prompt input port.');
  assert(outputPorts.some((port) => port.id === 'text'), 'Expected Model Step to expose a text output port.');

  const height = pipelineUi.getNodeCardHeight(node);
  assert(Number.isFinite(height) && height >= pipelineUi.PIPELINE_NODE_MIN_HEIGHT, 'Expected Model Step card height to compute without throwing.');
  const promptPortCenter = pipelineUi.getNodePortCenter(node, 'input', 0);
  assert(Number.isFinite(promptPortCenter.x) && Number.isFinite(promptPortCenter.y), 'Expected Model Step port geometry to compute without throwing.');

  const analysis = pipelineUi.analyzePipelineDraft({ nodes: [node], edges: [] }, pipelineUi.buildPipelineDisplayContext({
    hardware: null,
    manifests: [],
    providers: [],
    tools: [],
  }));
  assert(analysis && typeof analysis === 'object', 'Expected pipeline analysis to return a result for a fresh Model Step.');
  assert(Array.isArray(analysis.issues), 'Expected pipeline analysis to produce an issues array.');
  assert(analysis.nodeSummaries && analysis.nodeSummaries[node.id], 'Expected pipeline analysis to produce a node summary for the fresh Model Step.');
  assert(analysis.nodeSummaries[node.id].readiness && typeof analysis.nodeSummaries[node.id].readiness.message === 'string', 'Expected fresh Model Step readiness details to be computed without throwing.');

  verifyPipelineBuilderSourceGuards();

  console.log('Model Step node verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
