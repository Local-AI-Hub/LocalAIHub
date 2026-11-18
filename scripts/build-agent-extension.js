const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { TOOLS } = require('../electron/agent/contracts.cjs');
async function main() {
  const root = path.resolve(__dirname, '..');
  const version = require('../electron/agent/extension-version.json').version;
  const manifest = {
    manifest_version: '0.3', name: 'local-ai-hub', display_name: 'Local AI Hub', version,
    description: 'Search, install and remove models, discover local AI tools, create pipelines, run workflows, and retrieve results through Local AI Hub.',
    author: { name: 'Local AI Hub' },
    server: { type: 'node', entry_point: 'server.cjs', mcp_config: { command: 'node', args: ['${__dirname}/server.cjs'] } },
    tools: TOOLS.map(({ name, description }) => ({ name, description })),
    compatibility: { platforms: ['win32'], runtimes: { node: '>=18' } },
  };
  fs.mkdirSync(path.join(root, 'release'), { recursive: true });
  const target = path.join(root, 'release', 'LocalAIHub.mcpb');
  const archive = archiver('zip', { zlib: { level: 9 } });
  const output = fs.createWriteStream(target);
  const completion = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); });
  archive.pipe(output);
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  for (const file of ['server.cjs', 'client.cjs', 'contracts.cjs', 'bridge.cjs']) archive.file(path.join(root, 'electron', 'agent', file), { name: file });
  await archive.finalize(); await completion;
  console.log(`Built ${target}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

