const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

// Read-only acceptance against the running Hub. An alternate packaged adapter can be passed as argv[2].
async function main() {
  const adapter = process.argv[2] || path.resolve(__dirname, '../electron/agent/server.cjs');
  const child = spawn(process.execPath, [adapter], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  async function request(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
    const { value, done } = await lines.next();
    assert(!done, 'The MCP adapter closed before replying.');
    const reply = JSON.parse(value);
    assert.equal(reply.id, id);
    assert(!reply.error, JSON.stringify(reply.error));
    return reply.result;
  }
  async function call(name, args) {
    const result = await request('tools/call', { name, arguments: args });
    assert(!result.isError, result.content[0].text);
    return result.structuredContent.result;
  }
  const search = async (toolId, source, query) => (await call('hub_model_search', { toolId, source, query })).items;
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'model-manager-acceptance', version: '1' } });
    const repo = 'reddrumm/RVCModels';
    const file = 'DestinyGhostDinkle_e595_s24990_RVC.zip';
    for (const query of [repo, repo + ' ' + file, 'Dinklage']) {
      const items = await search('rvc', 'huggingface', query);
      const card = items.find(item => item.repository === repo);
      const choice = card?.choices.find(entry => entry.label === file && !entry.disabled);
      assert(choice, 'Expected ' + file + ' for ' + query);
      if (query === 'Dinklage') {
        const result = await call('hub_model_preflight', { selectionId: card.selectionId, choiceIndex: choice.choiceIndex });
        assert(result.requiredBytes > choice.sizeBytes, 'RVC preflight must reserve extraction space.');
      }
    }
    console.log('Repository, file, README keyword, and RVC preflight passed.');
    const encoder = 'models/image_encoder/model.safetensors';
    const cards = await search('forge', 'huggingface', 'h94/IP-Adapter ' + encoder);
    for (const card of cards) {
      assert(!card.choices.some(choice => choice.label === encoder && !choice.disabled));
      assert(card.blockingReason || card.fileName !== encoder);
    }
    const mistyped = await search('ollama', 'ollama', 'qwen2.5:0.5bb');
    assert.equal(mistyped.length, 0);
    const [variant] = await search('ollama', 'ollama', 'qwen2.5:72b');
    assert.equal(variant?.sizeBytes, 47000000000, 'Expected the catalog variant advertised as 47 GB.');
    const [family] = await search('ollama', 'ollama', 'https://ollama.com/library/qwen2.5/tags');
    const choice = family?.choices.find(entry => entry.version === variant.name);
    assert(choice, 'Expected the 72b variant in the family.');
    assert.deepEqual(choice.hardwareFit, variant.hardwareFit);
    const selected = await call('hub_model_preflight', { selectionId: family.selectionId, choiceIndex: choice.choiceIndex });
    const direct = await call('hub_model_preflight', { selectionId: variant.selectionId });
    assert.equal(selected.requiredBytes, direct.requiredBytes);
    assert(direct.requiredBytes > 0 && (direct.sizeKnown || /estimate/i.test(direct.spaceNote)));
    console.log('Encoder exclusion, absent tag, decimal size, family rating and preflight passed.');
  } finally { child.stdin.end(); child.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
