const crypto = require('crypto');
const net = require('net');
const fs = require('fs/promises');
const path = require('path');
const MAX_BYTES = 2 * 1024 * 1024;

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function createBridge({ dispatch, descriptorPath, sanitizeError = () => 'The agent request could not be completed.' }) {
  let server = null;
  let token = '';
  const sockets = new Set();
  async function stop() {
    const current = server;
    server = null;
    token = '';
    for (const socket of sockets) socket.destroy();
    if (current) await new Promise(resolve => current.close(resolve));
    await fs.rm(descriptorPath, { force: true });
  }
  async function start() {
    if (server) return;
    const secret = crypto.randomBytes(32).toString('hex');
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\localaihub-${crypto.randomUUID()}`
      : path.join(path.dirname(descriptorPath), `agent-${process.pid}.sock`);
    const candidate = net.createServer(socket => {
      if (sockets.size >= 16) { socket.destroy(); return; }
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.setTimeout(30000, () => socket.destroy());
      let input = '';
      let received = false;
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        if (received) return;
        input += chunk;
        if (Buffer.byteLength(input) > MAX_BYTES) { socket.destroy(); return; }
        if (!input.includes('\n')) return;
        received = true;
        (async () => {
          let request;
          try { request = JSON.parse(input.slice(0, input.indexOf('\n'))); }
          catch { throw fault('INVALID_REQUEST', 'Send a valid JSON request.'); }
          const supplied = Buffer.from(String(request?.token || ''));
          const expected = Buffer.from(secret);
          if (!token || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
            throw fault('UNAUTHORIZED', 'Agent access is disabled or the connection credentials are outdated.');
          }
          const data = await dispatch(request.method, request.params || {});
          const result = JSON.stringify({ ok: true, data });
          if (Buffer.byteLength(result) > MAX_BYTES) throw fault('RESULT_TOO_LARGE', 'Request a smaller result or a specific item.');
          socket.end(result + '\n');
        })().catch(error => socket.end(JSON.stringify({ ok: false, error: {
          code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'OPERATION_FAILED',
          message: sanitizeError(error),
        } }) + '\n'));
      });
    });
    try {
      await new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen(endpoint, resolve); });
      candidate.on('error', () => {});
      token = secret;
      await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
      await fs.writeFile(descriptorPath, JSON.stringify({ version: 1, endpoint, token: secret }), { mode: 0o600 });
      server = candidate;
    } catch (error) { token = ''; candidate.close(); throw error; }
  }
  return { start, stop, isRunning: () => Boolean(server) };
}
module.exports = { createBridge, fault, MAX_BYTES };
