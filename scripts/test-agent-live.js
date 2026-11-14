// Opt-in live test. Uses the CLI against the running Hub; never part of automated unit checks.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const cli = path.resolve(__dirname, '../electron/agent/cli.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let temp;
let activeRunId;
async function call(name, args = {}) {
  const argumentFile = path.join(temp, crypto.randomUUID() + '.json');
  await fs.writeFile(argumentFile, JSON.stringify(args));
  try {
    const { stdout } = await exec(process.execPath, [cli, name, argumentFile], { windowsHide: true, timeout: 35000, maxBuffer: 3 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    let failure;
    try { failure = JSON.parse(error.stderr); } catch { failure = { error: error.message }; }
    throw Object.assign(new Error(failure.error), { code: failure.code });
  } finally { await fs.rm(argumentFile, { force: true }); }
}
async function runTest(types, text, model) {
  const { pipeline } = await call('hub_create_draft', { name: model ? 'Agent live local model verification' : 'Agent live text verification', types });
  pipeline.nodes[0].config.text = text;
  const last = pipeline.nodes[pipeline.nodes.length - 1];
  const edge = (source, sourcePort, target, targetPort) => ({ id: 'edge-' + crypto.randomUUID(), source: { nodeId: source.id, portId: sourcePort }, target: { nodeId: target.id, portId: targetPort } });
  if (model) {
    const node = pipeline.nodes[1];
    Object.assign(node.config, { executionMode: 'ollama', toolId: 'ollama', model, systemPrompt: 'Reply in one short sentence. Do not include explanations or reasoning.', instruction: 'Answer the input in at most ten words.' });
    pipeline.edges = [edge(pipeline.nodes[0], 'text', node, 'prompt'), edge(node, 'text', last, 'text')];
  } else pipeline.edges = [edge(pipeline.nodes[0], 'text', last, 'text')];
  const analysis = await call('hub_validate_pipeline', { definition: pipeline });
  if (!analysis.executable) throw new Error('Pipeline is not executable: ' + (analysis.primaryIssue?.message || JSON.stringify(analysis.issues)));
  await call('hub_save_pipeline', { definition: pipeline, overwrite: false });
  const initial = await call('hub_run_pipeline', { pipelineId: pipeline.id, requestId: crypto.randomUUID() });
  activeRunId = initial.runId;
  let run = initial;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (['running', 'paused'].includes(run.status)) {
    if (Date.now() > deadline) throw new Error('The live test exceeded five minutes.');
    await delay(5000);
    run = await call('hub_run_status', { runId: activeRunId });
  }
  if (run.status !== 'completed') throw new Error(run.message || 'Pipeline did not complete.');
  activeRunId = null;
  const outputs = await call('hub_outputs', { runId: run.runId });
  const output = outputs.find(o => o.kind === 'text');
  if (!output) throw new Error('No saved text output was returned.');
  const result = await call('hub_read_output', { outputId: output.id });
  if (!result.text?.trim() || (!model && result.text.trim() !== text)) throw new Error('The saved output failed read-back verification.');
  return { pipelineId: pipeline.id, runId: run.runId, status: run.status, model: model || null, text: result.text.trim(), outputPath: output.outputPath };
}
async function main() {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-live-agent-'));
  try {
    const status = await call('hub_status');
    if (['running', 'paused'].includes(status.run?.status)) throw new Error('A pipeline is already active. The live test will not interrupt it.');
    console.log(JSON.stringify({ connected: true, version: status.version }));
    console.log(JSON.stringify(await runTest(['textInput', 'textOutput'], 'Hello from the Local AI Hub CLI live test.')));
    const before = await call('hub_tools');
    const ollama = before.find(t => t.id === 'ollama');
    if (!ollama) throw new Error('No installed Ollama tool was discovered; local-model test cannot run.');
    const models = await call('hub_models', { toolId: 'ollama' });
    const local = models.filter(m => !/cloud/i.test(m.name || '') && Number(m.sizeBytes) > 0 && Number(m.sizeBytes) <= 3 * 1024 ** 3);
    local.sort((a,b) => (a.name === 'qwen2.5:0.5b' ? -1 : b.name === 'qwen2.5:0.5b' ? 1 : a.sizeBytes - b.sizeBytes));
    if (!local.length) throw new Error('No small downloaded local model was found. Nothing will be downloaded.');
    console.log(JSON.stringify(await runTest(['textInput', 'llmPrompt', 'textOutput'], 'What is two plus two?', local[0].name)));
    const after = await call('hub_tools');
    console.log(JSON.stringify({ ollamaBefore: ollama.status, ollamaAfter: after.find(t=>t.id==='ollama')?.status, completed: true }));
  } finally {
    if (activeRunId) await call('hub_cancel_run', { runId: activeRunId }).catch(error => console.error('Could not cancel this test run: ' + error.message));
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(JSON.stringify({ completed: false, code: error.code || 'LIVE_TEST_FAILED', message: error.message })); process.exitCode = 1; });
