const assert = require('assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const Module = require('module');
const { spawn } = require('child_process');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const extract = require('extract-zip');
const net = require('net');
const { createBridge } = require('../electron/agent/bridge.cjs');
const { callBridge } = require('../electron/agent/client.cjs');
const { createOperations } = require('../electron/agent/operations.cjs');
const { TOOLS } = require('../electron/agent/contracts.cjs');
const schema = require('../electron/shared/pipelineSchema.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localaihub-agent-test-'));
const runtimeRoot = path.join(root, 'runtimes');
let configState = { hardware: { vramMb: 6144, systemRamMb: 16312 }, agentAccessEnabled: false };
const config = { updateConfig: async updater => { configState = updater(configState); return configState; }, ensureStorage: async () => fs.ensureDir(runtimeRoot), getAppPaths: () => ({ configRoot: root, runtimesRoot: runtimeRoot }), listGraphWorkflowPresets: async () => [], listPromptStyles: async () => [], readConfig: async () => configState };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const owner = String(parent?.filename || '').replace(/\\/g, '/');
  if (request === 'electron') return { app: { getPath: () => root, getVersion: () => 'test', isPackaged: false }, nativeImage: null };
  if (request === './configService' && owner.includes('/electron/services/')) return config;
  if (owner.endsWith('/electron/services/pipelineExecutionService.js')) {
    if (request === './providerRegistry') return { initializeProviderRegistry: async () => {} };
    if (request === './providerService') return { listProviderConnections: async () => [] };
    if (request === './toolRegistry') return { getToolCatalog: () => [{ id: 'ollama', name: 'Ollama', compatibility: { minimumVramMb: 2048, recommendedVramMb: 4096, minimumRamMb: 4096, recommendedRamMb: 8192 } }] };
    if (request === './toolStateService') return { buildMergedToolStateList: async () => [], getResolvedToolState: async () => null };
    if (request === './modelService') return { listDownloadedModels: async () => [] };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const execution = require('../electron/services/pipelineExecutionService');
const store = require('../electron/services/pipelineStoreService');
const { listPipelineOutputs } = require('../electron/services/pipelineOutputStoreService');
const operations = createOperations({ version: 'test', schema, execution, store, readConfig: config.readConfig, listTools: async () => [{ id: 'test', name: 'Test', status: 'stopped' }], listModels: async () => [], listOutputs: listPipelineOutputs, runsRoot: () => path.join(runtimeRoot, 'pipeline-runs') });
execution.setPipelineEventSink(({ run }) => operations.remember(run));
const descriptorPath = path.join(root, 'agent-connection.json');
const bridge = createBridge({ dispatch: operations.dispatch, descriptorPath, sanitizeError: e => e.message });
const call = (method, params = {}) => callBridge(method, params, descriptorPath);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitRun(id) {
  for (let i = 0; i < 200; i++) { const run = await call('hub_run_status', { runId: id }); if (!['running', 'paused'].includes(run.status)) return run; await delay(20); }
  throw Error('Pipeline did not finish.');
}
function mcpClient(serverPath) {
  const child = spawn(process.execPath, [serverPath], { windowsHide: true, env: { ...process.env, LOCALAIHUB_AGENT_CONNECTION: descriptorPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', sequence = 0, stderr = '';
  const pending = new Map();
  child.stderr.on('data', b => { stderr += b; });
  child.stdout.on('data', b => {
    buffer += b;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const handler = pending.get(reply.id); if (handler) { pending.delete(reply.id); handler(reply); }
    }
  });
  return { child, stderr: () => stderr, request(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('MCP request timed out: '+method+' '+stderr)), 10000);
      pending.set(id, value => { clearTimeout(timer); resolve(value); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params })+'\n');
    });
  } };
}
async function main() {
  let client;
  try {
    await assert.rejects(() => call('hub_status'), /enable Agent access/);
    await bridge.start();
    assert.equal((await call('hub_tools'))[0].id, 'test');
    await assert.rejects(() => call('hub_status', { unwanted: true }), /Unknown argument/);
    await assert.rejects(() => call('eval', {}), /not supported/);
    const descriptor = await fs.readJson(descriptorPath);
    const unauthorized = await new Promise((resolve, reject) => {
      const socket = net.createConnection(descriptor.endpoint); let text='';
      socket.on('error',reject); socket.on('connect',()=>socket.write(JSON.stringify({token:'bad',method:'hub_status'})+'\n')); socket.on('data',b=>{text+=b}); socket.on('end',()=>resolve(JSON.parse(text)));
    });
    assert.equal(unauthorized.error.code, 'UNAUTHORIZED');
    for (const { type } of await call('hub_node_types')) {
      const info = await call('hub_node_types', { type });
      assert.deepEqual(Object.keys(info.configSchema.properties), Object.keys(schema.getDefaultNodeConfig(type)));
    }
    const rvcConfig = { executionMode: 'localTool', operationId: 'audioTransform', toolId: 'rvc', rvcInference: { pitchChange: -5, indexRate: 0 } };
    const preview = await call('hub_node_types', { type: 'llmPrompt', config: rvcConfig });
    assert.deepEqual(preview.configuredPorts.outputs.map(port => port.id), ['audio']);
    assert.equal(preview.sampleNode.config.rvcInference.indexRate, 0);
    assert.equal(preview.configSchema.properties.rvcInference.properties.pitchMethod.enum.includes('harvest'), true);
    for (const [types, expected] of [
      [['textInput', 'llmPrompt'], [0, 'text', 1, 'prompt']],
      [['imageInput', 'textInput', 'imageOutput'], [0, 'image', 2, 'image']],
      [['textInput'], null],
      [['llmPrompt', 'imageOutput'], null],
      [['textInput', 'imageOutput'], null],
    ]) {
      const { pipeline, edgeExample } = await call('hub_create_draft', { name: 'Draft connections', types });
      assert.deepEqual(pipeline.edges, []);
      if (expected) {
        const [from, output, to, input] = expected;
        assert.deepEqual(edgeExample.source, { nodeId: pipeline.nodes[from].id, portId: output });
        assert.deepEqual(edgeExample.target, { nodeId: pipeline.nodes[to].id, portId: input });
        assert.equal(schema.buildPipelineGraph({ ...pipeline, edges: [edgeExample] }).edges.length, 1);
      } else {
        assert.equal(edgeExample, null);
      }
    }
    const configured = (await call('hub_create_draft', { name: 'Configuration roundtrip', types: ['llmPrompt', 'collectionMap'] })).pipeline;
    configured.nodes[0].config = rvcConfig;
    configured.nodes[1].config.perItemValidation.ollamaOptions = { temperature: 0, seed: 7 };
    await call('hub_save_pipeline', { definition: configured });
    const saved = await call('hub_get_pipeline', { pipelineId: configured.id });
    assert.deepEqual(saved.nodes[0].config.rvcInference, rvcConfig.rvcInference);
    assert.deepEqual(saved.nodes[1].config.perItemValidation.ollamaOptions, { temperature: 0, seed: 7 });
    configured.nodes[0].config.rvcInference.indexRate = 2;
    await assert.rejects(call('hub_validate_pipeline', { definition: configured }), /indexRate/);
    const draft = (await call('hub_create_draft', { name: 'Agent verification', types: ['textInput', 'textOutput'] })).pipeline;
    draft.nodes[0].config.text = 'A real pipeline through the agent bridge.';
    draft.edges = [schema.createEdge(draft.nodes[0].id, 'text', draft.nodes[1].id, 'text')];
    const analysis = await call('hub_validate_pipeline', { definition: draft });
    assert.equal(analysis.executable, true, JSON.stringify(analysis.issues));
    assert.deepEqual((await execution.analyzeWithCurrentContext(draft)).context.hardware, configState.hardware);
    configState.hardware = null;
    assert.equal((await execution.analyzeWithCurrentContext(draft)).context.hardware, null);
    configState.hardware = { vramMb: 6144, systemRamMb: 16312 };
    const hardwareDraft = schema.createEmptyPipeline();
    const inputNode = schema.createNode('textInput');
    const modelNode = schema.createNode('llmPrompt');
    const outputNode = schema.createNode('textOutput');
    modelNode.config = { ...modelNode.config, executionMode: 'ollama', toolId: 'ollama', model: 'test' };
    hardwareDraft.nodes = [inputNode, modelNode, outputNode];
    hardwareDraft.edges = [schema.createEdge(inputNode.id, 'text', modelNode.id, 'text'), schema.createEdge(modelNode.id, 'text', outputNode.id, 'text')];
    assert.equal((await call('hub_validate_pipeline', { definition: hardwareDraft })).nodeSummaries[modelNode.id].compatibility.label, 'Recommended');
    configState.hardware = null;
    assert.equal((await call('hub_validate_pipeline', { definition: hardwareDraft })).nodeSummaries[modelNode.id].compatibility.label, 'Hardware unknown');
    configState.hardware = { vramMb: 6144, systemRamMb: 16312 };
    await call('hub_save_pipeline', { definition: draft });
    await assert.rejects(() => call('hub_save_pipeline', { definition: draft }), /already exists/);
    assert.equal((await call('hub_get_pipeline', { pipelineId: draft.id })).name, draft.name);
    const [a,b] = await Promise.all([call('hub_run_pipeline', { pipelineId:draft.id,requestId:'once' }),call('hub_run_pipeline', { pipelineId:draft.id,requestId:'once' })]);
    assert.equal(a.runId,b.runId);
    assert.equal((await waitRun(a.runId)).status, 'completed');
    await assert.rejects(()=>call('hub_run_pipeline',{pipelineId:'different',requestId:'once'}),/another pipeline/);
    const outputs = await call('hub_outputs', {runId:a.runId});
    assert(outputs.length>0);
    const content = await call('hub_read_output',{outputId:outputs[0].id});
    assert(content.text.includes('A real pipeline'));
    assert(!content.output.summary.startsWith('Transcript'), 'Plain text must not be labeled as a transcript.');
    const artifacts = require('../electron/services/pipelineArtifactService');
    assert(artifacts.summarizeArtifact(artifacts.createTextArtifact('spoken words', { transcription: { backend: 'whisper' } })).includes('Whisper transcript'));
    await assert.rejects(()=>call('hub_read_output',{outputId:'../private'}),/could not be found/);
    // Concurrent UI/service calls must be blocked before async preflight completes.
    const starts=await Promise.allSettled([execution.runPipeline(draft),execution.runPipeline(draft)]);
    assert.equal(starts.filter(r=>r.status==='fulfilled').length,1);
    assert.match(starts.find(r=>r.status==='rejected').reason.message,/already running/);
    await waitRun(starts.find(r=>r.status==='fulfilled').value.runId);
    const review = schema.createNode('validation', { config: { mode: 'user' } });
    const failedOutput = schema.createNode('textOutput');
    const paused = schema.createEmptyPipeline({ id: 'agent-review', name: 'Agent review', nodes: [draft.nodes[0], review, draft.nodes[1], failedOutput], edges: [schema.createEdge(draft.nodes[0].id, 'text', review.id, 'input'), schema.createEdge(review.id, 'pass', draft.nodes[1].id, 'text'), schema.createEdge(review.id, 'fail', failedOutput.id, 'text')] });
    await call('hub_save_pipeline', { definition: paused });
    const reviewRun = await call('hub_run_pipeline', { pipelineId: paused.id, requestId: 'review' });
    for (let i=0;i<100 && execution.getActiveRunSnapshot().status!=='paused';i++) await delay(20);
    assert.equal(execution.getActiveRunSnapshot().status,'paused');
    let lifecycleCalled = false;
    await assert.rejects(() => execution.withIdlePipelineForToolAction(async () => { lifecycleCalled = true; }), /active pipeline/);
    assert.equal(lifecycleCalled, false);
    await assert.rejects(()=>call('hub_cancel_run',{runId:'wrong-run'}),/could not find/);
    await call('hub_cancel_run',{runId:reviewRun.runId});
    assert.equal((await waitRun(reviewRun.runId)).status,'cancelled');
    let releaseLifecycle;
    const lifecycle = execution.withIdlePipelineForToolAction(() => new Promise(resolve => { releaseLifecycle = resolve; }));
    await assert.rejects(() => execution.runPipeline(draft), /already running/);
    await assert.rejects(() => execution.withIdlePipelineForToolAction(async () => {}), /tool action/);
    releaseLifecycle(); await lifecycle;
    await assert.rejects(() => execution.withIdlePipelineForToolAction(async () => { throw Error('simulated lifecycle failure'); }), /simulated/);
    const recovered = await execution.runPipeline(draft);
    assert.equal((await waitRun(recovered.runId)).status, 'completed');
    const cli = await execFile(process.execPath,[path.resolve(__dirname,'../electron/agent/cli.cjs'),'hub_status'],{env:{...process.env,LOCALAIHUB_AGENT_CONNECTION:descriptorPath},windowsHide:true});
    assert.equal(JSON.parse(cli.stdout).version,'test');
    // Exercise the actual child-process stdio transport, not an in-process mock.
    await execFile(process.execPath,[path.resolve(__dirname,'build-agent-extension.js')],{windowsHide:true});
    const extensionRoot=path.join(root,'extension');
    await extract(path.resolve(__dirname,'../release/LocalAIHub.mcpb'),{dir:extensionRoot});
    const manifest=await fs.readJson(path.join(extensionRoot,'manifest.json'));
    assert.equal(manifest.manifest_version,'0.3');
    assert.equal(manifest.tools.length,TOOLS.length);
    client=mcpClient(path.join(extensionRoot,manifest.server.entry_point));
    assert.equal((await client.request('tools/list',{})).error.code,-32000);
    const init=await client.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'verifier',version:'1'}});
    assert.equal(init.result.protocolVersion,'2025-11-25');
    client.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    assert.equal((await client.request('tools/list',{})).result.tools.length,TOOLS.length);
    assert.equal((await client.request('tools/call',{name:'hub_status',arguments:{}})).result.isError,false);
    assert.equal((await client.request('tools/call',{name:'hub_status',arguments:{extra:true}})).error.code,-32602);
    assert.equal((await client.request('made_up',{})).error.code,-32601);
    await bridge.stop();
    assert.equal(await fs.pathExists(descriptorPath),false);
    assert.equal((await client.request('tools/call',{name:'hub_status',arguments:{}})).result.isError,true);
    assert.equal(client.stderr(),'');
    await bridge.start();
    assert.notEqual((await fs.readJson(descriptorPath)).token,descriptor.token);
    assert.equal((await call('hub_status')).version,'test');
    await bridge.stop();
    const accessService = require('../electron/services/agentAccessService');
    assert.equal((await accessService.startAgentAccess()).running, false);
    assert.equal((await accessService.setAgentAccess(true)).running, true);
    assert.equal((await call('hub_status')).version, 'test');
    await accessService.stopAgentAccess();
    assert.equal((await accessService.startAgentAccess()).running, true, 'Enabled preference survives bridge restart.');
    assert.equal((await accessService.setAgentAccess(false)).enabled, false);
    await assert.rejects(() => call('hub_status'), /enable Agent access/);
    await accessService.stopAgentAccess();
    const React=require('react');
    const {renderToStaticMarkup}=require('react-dom/server');
    const source=await fs.readFile(path.resolve(__dirname,'../src/components/AgentAccessPanel.jsx'),'utf8');
    const compiled=require('esbuild').transformSync(source,{loader:'jsx',format:'cjs',jsx:'automatic'}).code;
    const renderedModule=new Module(path.resolve(__dirname,'../src/components/agent-render-test.cjs'),module);
    renderedModule.filename=path.resolve(__dirname,'../src/components/agent-render-test.cjs');
    renderedModule.paths=module.paths;
    renderedModule._compile(compiled,renderedModule.filename);
    const markup=renderToStaticMarkup(React.createElement(renderedModule.exports.default));
    assert(markup.includes('Enable agent access') && markup.includes('Show Claude Desktop extension') && markup.includes('Data returned to a cloud agent'));
    console.log('Agent access passed: real pipeline save/validate/run/output, deduplication, shared start lock, auth, revocation, restart, and MCP subprocess.');
  } finally {
    if(client) {client.child.kill(); await new Promise(resolve=>client.child.once('close',resolve));}
    await bridge.stop();
    Module._load=originalLoad;
    await fs.remove(root);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});


