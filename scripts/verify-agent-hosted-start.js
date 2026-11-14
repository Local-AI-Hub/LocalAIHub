const assert = require('assert/strict');
const { spawn } = require('child_process');
const path = require('path');
async function check(hosted) {
  const server = path.resolve(__dirname, '../electron/agent/server.cjs');
  const args = hosted ? ['-e', 'require(process.argv[1]);', server] : [server];
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  try {
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Handshake timeout (hosted=${hosted}): ${stderr}`)), 3000);
      let buffer = '';
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', () => { clearTimeout(timer); reject(new Error(`Exited before handshake: ${stderr}`)); });
      child.stdout.on('data', b => {
        buffer += b;
        if (!buffer.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))); } catch (error) { reject(error); }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'hosted-start-verifier', version: '1' } } }) + '\n');
    });
    assert.equal(response.id, 0);
    assert.equal(response.result.serverInfo.name, 'local-ai-hub');
    assert.deepEqual(response.result.capabilities.tools, {});
    assert.equal(stderr, '');
  } finally { child.kill(); }
}
(async () => { await check(false); await check(true); console.log('MCP initialization passed for direct execution and hosted require, without a Hub connection.'); })().catch(error => { console.error(error); process.exitCode = 1; });
