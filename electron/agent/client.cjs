const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const net = require('net');
const { MAX_BYTES } = require('./bridge.cjs');
function defaultDescriptorPath() {
  return process.env.LOCALAIHUB_AGENT_CONNECTION || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'LocalAIHub', 'agent-connection.json');
}
async function callBridge(method, params = {}, descriptorPath = defaultDescriptorPath()) {
  let connection;
  try { connection = JSON.parse(await fs.readFile(descriptorPath, 'utf8')); }
  catch { throw new Error('Open Local AI Hub and enable Agent access in Settings first.'); }
  if (process.platform === 'win32' && !String(connection.endpoint).startsWith('\\\\.\\pipe\\localaihub-')) throw new Error('Invalid Local AI Hub connection.');
  const request = JSON.stringify({ token: connection.token, method, params }) + '\n';
  if (Buffer.byteLength(request) > MAX_BYTES) throw new Error('This agent request is too large.');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.endpoint);
    let input = '';
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(result); };
    socket.setEncoding('utf8');
    socket.setTimeout(method === 'hub_model_search' ? 120000 : 30000, () => finish(new Error('Local AI Hub took too long to respond. Check its status before retrying a mutation.')));
    socket.on('connect', () => socket.write(request));
    socket.on('error', error => finish(Object.assign(new Error(['EACCES', 'EPERM'].includes(error.code) ? 'This client is not permitted to connect to Local AI Hub. Its sandbox or Windows permissions blocked the local connection.' : 'Local AI Hub is unavailable. Open the app and check Agent access in Settings.'), { code: error.code })));
    socket.on('close', () => finish(new Error('Local AI Hub closed the connection.')));
    socket.on('data', chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_BYTES) return finish(new Error('Local AI Hub returned too much data.'));
      if (!input.includes('\n')) return;
      try {
        const result = JSON.parse(input.slice(0, input.indexOf('\n')));
        finish(result.ok ? null : Object.assign(new Error(result.error.message), { code: result.error.code }), result.data);
      } catch (error) { finish(error); }
    });
  });
}
module.exports = { callBridge, defaultDescriptorPath };
