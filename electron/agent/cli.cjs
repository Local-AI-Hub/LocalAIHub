const fs = require('fs/promises');
const { TOOLS } = require('./contracts.cjs');
const { callBridge } = require('./client.cjs');
async function main() {
  const [method, input] = process.argv.slice(2);
  if (!method || method === '--help') { console.log('Usage: node cli.cjs <hub_operation> [arguments.json]\nUse --list to discover operations.'); return; }
  if (method === '--list') { console.log(JSON.stringify(TOOLS, null, 2)); return; }
  const args = input ? JSON.parse(await fs.readFile(input, 'utf8')) : {};
  console.log(JSON.stringify(await callBridge(method, args), null, 2));
}
main().catch(error => { console.error(JSON.stringify({ error: error.message, code: error.code || 'AGENT_ERROR' })); process.exitCode = 1; });
