const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { validateArguments, TOOLS } = require('./contracts.cjs');
const { fault } = require('./bridge.cjs');

function createOperations(deps) {
  const runs = new Map();
  const requests = new Map();
  const jobs = new Map();
  const jobRequests = new Map();
  let mutation = Promise.resolve();
  function remember(run) {
    if (!run?.runId) return;
    runs.set(run.runId, JSON.parse(JSON.stringify(run)));
    while (runs.size > 100) runs.delete(runs.keys().next().value);
  }
  function assertDefinition(value) {
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 100 || value.edges.length > 500) throw fault('INVALID_PIPELINE', 'Supply nodes and edges arrays with at most 100 nodes and 500 edges.');
    const ids = new Set();
    for (const node of value.nodes) {
      if (!node || !deps.schema.getNodeTypeDefinition(node.type) || typeof node.id !== 'string' || !node.id || ids.has(node.id)) throw fault('INVALID_PIPELINE', 'Each node needs a unique ID and a supported type.');
      ids.add(node.id);
    }
    const edgeIds = new Set();
    for (const edge of value.edges) {
      if (!edge || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id) || !ids.has(edge.source?.nodeId) || !ids.has(edge.target?.nodeId) || typeof edge.source?.portId !== 'string' || typeof edge.target?.portId !== 'string') throw fault('INVALID_PIPELINE', 'Each edge needs a unique ID and source/target objects with existing nodeId and portId values.');
      edgeIds.add(edge.id);
    }
  }
  async function execute(name, args) {
    switch (name) {
      case 'hub_discovery': return deps.discover(args.section);
      case 'hub_deliver_media': {
        const output = (await deps.listOutputs()).find(o => o.id === args.outputId);
        if (!output) throw fault('OUTPUT_NOT_FOUND', 'That saved output could not be found.');
        return deps.deliverMedia(output, args);
      }
      case 'hub_inspect_media': {
        const output = (await deps.listOutputs()).find(o => o.id === args.outputId);
        if (!output) throw fault('OUTPUT_NOT_FOUND', 'That saved output could not be found.');
        return deps.inspectMedia(output, args);
      }
      case 'hub_diagnostics': {
        const tool = (await deps.listTools()).find(t => t.id === args.toolId);
        if (!tool) throw fault('TOOL_NOT_FOUND', 'That tool is not installed.');
        return deps.diagnostics(tool, args.maxChars);
      }
      case 'hub_job_status': {
        const job = jobs.get(args.jobId);
        if (!job) throw fault('JOB_NOT_FOUND', 'That job is not available in this app session.');
        return { ...job };
      }
      case 'hub_tool_action': {
        const key = args.toolId + ':' + args.action;
        const previous = jobRequests.get(args.requestId);
        if (previous) {
          if (previous.key !== key) throw fault('REQUEST_CONFLICT', 'That request ID was used for another tool action.');
          return { ...jobs.get(previous.jobId) };
        }
        if (jobs.size >= 1000) throw fault('SESSION_LIMIT', 'Restart the Hub before starting more tool actions.');
        const tool = (await deps.listTools()).find(t => t.id === args.toolId);
        if (!tool) throw fault('TOOL_NOT_FOUND', 'That tool is not installed.');
        const job = { jobId: 'job-' + crypto.randomUUID(), toolId: tool.id, action: args.action, status: 'running', startedAt: new Date().toISOString() };
        jobs.set(job.jobId, job);
        jobRequests.set(args.requestId, { key, jobId: job.jobId });
        Promise.resolve().then(() => deps.changeToolState(tool, args.action)).then(result => {
          job.status = 'completed'; job.result = result;
        }, error => {
          job.status = 'failed'; job.error = { code: error.code || 'TOOL_ACTION_FAILED', message: deps.humanizeError(error) };
        }).finally(() => { job.finishedAt = new Date().toISOString(); });
        return { ...job };
      }
      case 'hub_status': return { version: deps.version, hardware: (await deps.readConfig()).hardware, run: deps.execution.getActiveRunSnapshot(), operations: TOOLS.map(t => t.name) };
      case 'hub_tools': return (await deps.listTools()).map(t => ({ id: t.id, name: t.name, status: t.status, installed: true, availableModels: t.availableModels, capabilities: deps.toolCapabilities?.(t.id) }));
      case 'hub_models': {
        const tool = (await deps.listTools()).find(t => t.id === args.toolId);
        if (!tool) throw fault('TOOL_NOT_FOUND', 'That tool is not installed.');
        return deps.listModels(tool);
      }
      case 'hub_node_types': {
        if (!args.type) return Object.values(deps.schema.PIPELINE_NODE_TYPES).map(({ type, label, description }) => ({ type, label, description }));
        const entry = deps.schema.getNodeTypeDefinition(args.type);
        if (!entry) throw fault('UNKNOWN_NODE', 'That pipeline node type is not supported.');
        return { ...entry, sampleNode: deps.schema.createNode(args.type) };
      }
      case 'hub_create_draft': {
        for (const type of args.types) if (!deps.schema.getNodeTypeDefinition(type)) throw fault('UNKNOWN_NODE', `Unsupported pipeline node type: ${type}.`);
        const pipeline = deps.schema.createEmptyPipeline();
        pipeline.id = `agent-${crypto.randomUUID()}`;
        pipeline.name = args.name;
        pipeline.nodes = args.types.map((type, index) => deps.schema.createNode(type, { position: { x: 100 + index * 260, y: 100 } }));
        return { pipeline, edgeExample: deps.schema.createEdge(pipeline.nodes[0].id, 'text', pipeline.nodes[1]?.id || 'target-node-id', 'text'), message: 'Fill node configurations and connect ports before validating and saving.' };
      }
      case 'hub_pipelines': return deps.store.listPipelines();
      case 'hub_get_pipeline': return deps.store.getPipeline(args.pipelineId);
      case 'hub_validate_pipeline': assertDefinition(args.definition); return (await deps.execution.analyzeWithCurrentContext(args.definition)).analysis;
      case 'hub_save_pipeline': {
        assertDefinition(args.definition);
        const id = args.definition.id;
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(id)) throw fault('INVALID_PIPELINE', 'Use a lowercase pipeline ID with letters, digits, underscores or hyphens (up to 100 characters).');
        if (!args.overwrite && (await deps.store.listPipelines()).some(p => p.id === id)) throw fault('ALREADY_EXISTS', 'This pipeline already exists. Set overwrite=true only if you intend to replace it.');
        return deps.store.savePipeline(args.definition);
      }
      case 'hub_run_pipeline': {
        const prior = requests.get(args.requestId);
        if (prior) {
          if (prior.pipelineId !== args.pipelineId) throw fault('REQUEST_CONFLICT', 'That request ID was used for another pipeline.');
          return runs.get(prior.runId) || { runId: prior.runId, message: 'Run history expired. Inspect saved outputs; this request will not start another run.' };
        }
        if (requests.size >= 1000) throw fault('SESSION_LIMIT', 'The agent request history is full. Restart Local AI Hub before starting more agent runs.');
        const run = await deps.execution.runPipeline(await deps.store.getPipeline(args.pipelineId));
        remember(run);
        requests.set(args.requestId, { pipelineId: args.pipelineId, runId: run.runId });
        return run;
      }
      case 'hub_run_status': {
        const active = deps.execution.getActiveRunSnapshot(); remember(active);
        if (!args.runId) return active;
        const run = runs.get(args.runId);
        if (!run) throw fault('RUN_NOT_FOUND', 'That run is not available in this app session. Check saved outputs for older runs.');
        return run;
      }
      case 'hub_cancel_run': return deps.execution.cancelPipelineRun(args.runId);
      case 'hub_outputs': return (await deps.listOutputs()).filter(o => !args.runId || o.runId === args.runId);
      case 'hub_read_output': {
        const output = (await deps.listOutputs()).find(o => o.id === args.outputId);
        if (!output) throw fault('OUTPUT_NOT_FOUND', 'That saved output could not be found.');
        const extension = path.extname(output.outputPath).toLowerCase();
        if (output.isDirectory || !['.txt', '.md', '.json', '.srt', '.vtt', '.csv'].includes(extension)) return { output, message: 'This output is available at its local path.' };
        const root = await fs.realpath(deps.runsRoot());
        const target = await fs.realpath(output.outputPath);
        const relative = path.relative(root, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw fault('OUTPUT_OUTSIDE_STORAGE', 'This output resolves outside managed pipeline storage.');
        const handle = await fs.open(target, 'r');
        try {
          const buffer = Buffer.alloc(65536);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return { output, text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: (await handle.stat()).size > bytesRead };
        } finally { await handle.close(); }
      }
      default: throw fault('UNKNOWN_OPERATION', 'That agent operation is not supported.');
    }
  }
  async function dispatch(name, args) {
    validateArguments(name, args);
    if (TOOLS.find(t => t.name === name).annotations.readOnlyHint) return execute(name, args);
    const task = mutation.then(() => execute(name, args));
    mutation = task.catch(() => {});
    return task;
  }
  return { dispatch, remember };
}
module.exports = { createOperations };
