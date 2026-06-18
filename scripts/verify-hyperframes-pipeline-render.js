const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const schema = require('../electron/shared/pipelineSchema.cjs');
const capabilities = require('../electron/shared/pipelineCapabilities.cjs');

const {
  PIPELINE_NODE_TYPES,
  PIPELINE_OPERATION_IDS,
  analyzePipeline,
  createNode,
  getPipelineNodePorts,
} = schema;

function createEdge(sourceNodeId, sourcePortId, targetNodeId, targetPortId) {
  return {
    id: `${sourceNodeId}-${sourcePortId}-${targetNodeId}-${targetPortId}`,
    source: { nodeId: sourceNodeId, portId: sourcePortId },
    target: { nodeId: targetNodeId, portId: targetPortId },
  };
}

const nodeDefinition = PIPELINE_NODE_TYPES.hyperframesRender;
assert(nodeDefinition, 'HyperFrames Render node must be registered.');
assert.strictEqual(nodeDefinition.label, 'HyperFrames Render', 'Node label must be stable.');
assert.strictEqual(nodeDefinition.category, 'Deterministic Media Operations', 'Node must live with deterministic media operations.');
assert.deepStrictEqual(nodeDefinition.configDefaults, {
  fps: 30,
  quality: 'draft',
  workers: 1,
  browserGpu: false,
  format: 'mp4',
}, 'Node defaults must keep the first pass narrow.');

const inputPorts = getPipelineNodePorts(nodeDefinition, 'input');
const outputPorts = getPipelineNodePorts(nodeDefinition, 'output');
assert.deepStrictEqual(inputPorts.map((port) => [port.id, port.kind, port.required]), [['project', 'file', true]], 'Node input must be a typed file artifact.');
assert.deepStrictEqual(outputPorts.map((port) => [port.id, port.kind]), [['video', 'video']], 'Node output must be a single video artifact.');

assert.strictEqual(PIPELINE_OPERATION_IDS.HYPERFRAMES_RENDER, 'hyperframesRender', 'Operation id must be explicit.');
const strategy = capabilities.getToolPipelineStrategy('hyperframes');
assert(strategy, 'HyperFrames must now expose a local operation strategy.');
assert.strictEqual(strategy.id, capabilities.TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL, 'HyperFrames must be operation-driven, not graph-native or model-runtime.');
const operation = capabilities.getToolPipelineOperation('hyperframes', PIPELINE_OPERATION_IDS.HYPERFRAMES_RENDER);
assert(operation, 'HyperFrames render capability must be registered.');
assert.deepStrictEqual(operation.inputKinds, ['file'], 'Capability input must be file only.');
assert.deepStrictEqual(operation.outputKinds, ['video'], 'Capability output must be video only.');
assert.strictEqual(operation.localOnly, true, 'Capability must advertise local-only execution.');
assert.strictEqual(operation.requiresLocalIndexHtml, true, 'Capability must require local index.html intake.');
assert(capabilities.getOperationDrivenToolIdsForPipelineOperation(PIPELINE_OPERATION_IDS.HYPERFRAMES_RENDER).includes('hyperframes'), 'HyperFrames must be discoverable for its render operation.');

const readyHyperFramesTool = {
  id: 'hyperframes',
  name: 'HyperFrames',
  installedByLocalAIHub: true,
  status: 'stopped',
  hyperframes: {
    browserReady: true,
    doctorReady: true,
    ffmpegReady: true,
    setupSummary: 'HyperFrames 0.6.112, Node ready, Chrome Headless Shell ready, FFmpeg/FFprobe ready.',
  },
  pipelineCapabilities: capabilities.getToolPipelineCapabilities('hyperframes'),
};
const fileInput = createNode('fileInput', { id: 'input-index', config: { filePath: 'D:\\Composition\\index.html' } });
const renderNode = createNode('hyperframesRender', { id: 'render-index' });
const outputNode = createNode('videoOutput', { id: 'video-out' });
const pipeline = {
  nodes: [fileInput, renderNode, outputNode],
  edges: [
    createEdge(fileInput.id, 'file', renderNode.id, 'project'),
    createEdge(renderNode.id, 'video', outputNode.id, 'video'),
  ],
};
const analysis = analyzePipeline(pipeline, { tools: [readyHyperFramesTool], toolCatalog: [readyHyperFramesTool] });
assert.strictEqual(analysis.nodeSummaries[renderNode.id].readiness.tone, 'info', 'Ready HyperFrames node should analyze as ready.');
assert(/HyperFrames is ready/.test(analysis.nodeSummaries[renderNode.id].readiness.message), 'Readiness should mention HyperFrames readiness.');
assert.strictEqual(analysis.nodeSummaries[renderNode.id].capabilitySummary.operationId, 'hyperframesRender', 'Capability summary should use the render operation.');
assert.strictEqual(analysis.nodeSummaries[renderNode.id].capabilitySummary.targetId, 'hyperframes', 'Capability summary should target HyperFrames.');

const missingInputAnalysis = analyzePipeline({ nodes: [renderNode, outputNode], edges: [createEdge(renderNode.id, 'video', outputNode.id, 'video')] }, { tools: [readyHyperFramesTool], toolCatalog: [readyHyperFramesTool] });
assert(missingInputAnalysis.issues.some((issue) => /File Input.*index\.html/i.test(issue.message)), 'Analyzer must require a connected index.html File Input.');
const invalidConfigNode = createNode('hyperframesRender', { id: 'bad-render', config: { fps: 25, quality: 'draft' } });
const invalidAnalysis = analyzePipeline({ nodes: [fileInput, invalidConfigNode, outputNode], edges: [createEdge(fileInput.id, 'file', invalidConfigNode.id, 'project'), createEdge(invalidConfigNode.id, 'video', outputNode.id, 'video')] }, { tools: [readyHyperFramesTool], toolCatalog: [readyHyperFramesTool] });
assert(invalidAnalysis.issues.some((issue) => /24, 30, or 60 FPS/.test(issue.message)), 'Analyzer must reject unsupported FPS values.');
const missingToolAnalysis = analyzePipeline(pipeline, { tools: [], toolCatalog: [] });
assert(missingToolAnalysis.issues.some((issue) => /Install or repair HyperFrames/.test(issue.message)), 'Analyzer must require the managed HyperFrames runtime.');

const uiSource = fs.readFileSync(path.join(repoRoot, 'src/components/PipelineBuilderPanel.jsx'), 'utf8');
assert(uiSource.includes("selectedNode.type === 'hyperframesRender'"), 'Inspector must expose HyperFrames Render controls.');
assert(uiSource.includes('HyperFrames renders HTML/CSS/JavaScript in Chromium. Render only compositions you trust.'), 'Inspector must include the trusted-composition warning.');
assert(uiSource.includes('24 FPS') && uiSource.includes('30 FPS') && uiSource.includes('60 FPS'), 'Inspector must expose only the allowed FPS choices.');
assert(uiSource.includes('Draft') && uiSource.includes('Standard') && uiSource.includes('High'), 'Inspector must expose the allowed quality choices.');
assert(uiSource.includes('value="MP4"') && uiSource.includes('value="1"') && uiSource.includes('value="Disabled"'), 'Inspector must show fixed MP4/workers/browser-GPU settings.');
assert(!/hyperframes.*output.*path/i.test(uiSource), 'Inspector must not expose an arbitrary HyperFrames output path.');
assert(!/hyperframes.*args/i.test(uiSource), 'Inspector must not expose arbitrary HyperFrames CLI args.');

const executionSource = fs.readFileSync(path.join(repoRoot, 'electron/services/pipelineExecutionService.js'), 'utf8');
assert(executionSource.includes("require('./hyperFramesRenderService')"), 'Pipeline executor must use the HyperFrames render service.');
assert(executionSource.includes("node.type === 'hyperframesRender'"), 'Pipeline executor must route HyperFrames Render nodes.');
assert(executionSource.includes('activeRunAbortController?.signal'), 'Pipeline executor must pass the existing cancellation signal.');
assert(executionSource.includes('return true;') && executionSource.includes("node.type === 'hyperframesRender'"), 'HyperFrames Render must be treated as a heavy local step.');

const renderServiceSource = fs.readFileSync(path.join(repoRoot, 'electron/services/hyperFramesRenderService.js'), 'utf8');
assert(renderServiceSource.includes("['lint', '--json', stagedRoot]"), 'Render service must lint before render.');
assert(renderServiceSource.includes("'--no-browser-gpu'") && renderServiceSource.includes("'--workers'") && renderServiceSource.includes('HYPERFRAMES_RENDER_WORKERS'), 'Render service must force workers=1 and disable browser GPU.');
assert(renderServiceSource.includes("'--format'") && renderServiceSource.includes('HYPERFRAMES_RENDER_FORMAT'), 'Render service must force MP4 format.');
assert(!renderServiceSource.includes('cloud ') && !renderServiceSource.includes('preview '), 'Render service must not route cloud or studio commands.');

console.log('HyperFrames pipeline render verifier passed.');