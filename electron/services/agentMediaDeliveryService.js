const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { resolveOutputFile } = require('./agentMediaService');
const { fault } = require('../agent/bridge.cjs');
const TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };
const AUDIO_LIMIT = 700000;
function createMediaDelivery({ runsRoot, now = Date.now, lifetimeMs = 30 * 60 * 1000 }) {
  let server, starting;
  let generation = 0;
  const grants = new Map();
  const expire = () => { for (const [key, value] of grants) if (value.expires <= now()) grants.delete(key); };
  async function handle(req, res) {
    let file;
    try {
      const host = '127.0.0.1:' + server.address().port;
      // No CORS access, arbitrary Host headers, or cross-origin scripted requests.
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== 'http://' + host)) { res.writeHead(403).end(); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
      expire();
      const match = /^\/media\/([a-f0-9]{64})\/(view|file|download)$/.exec(req.url);
      const grant = match && grants.get(match[1]);
      if (!grant) { res.writeHead(404).end('This media link is unavailable or expired.'); return; }
      const common = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" };
      if (match[2] === 'view') {
        const tag = grant.mimeType.startsWith('audio/') ? 'audio' : 'video';
        const body = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Local AI Hub media</title></head><body style="font:18px system-ui;max-width:1000px;margin:40px auto;padding:20px"><h1>Local AI Hub media</h1><' + tag + ' controls preload="metadata" style="max-width:100%" src="file"></' + tag + '><p><a href="download">Download original file</a></p><p>This temporary link works on this PC while the Hub and agent access remain enabled. If your browser cannot play this format, download it to open with your media player.</p></body></html>');
        res.writeHead(200, { ...common, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body); return;
      }
      const target = await resolveOutputFile(grant.output, runsRoot());
      file = await fs.promises.open(target, 'r');
      const stat = await file.stat();
      if (!stat.isFile()) throw Error('Not a file');
      let start = 0, end = stat.size - 1, status = 200;
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!range || (!range[1] && !range[2])) { res.writeHead(416, { ...common, 'Content-Range': 'bytes */' + stat.size }).end(); return; }
        if (!range[1]) start = Math.max(0, stat.size - Number(range[2]));
        else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { res.writeHead(416, { ...common, 'Content-Range': 'bytes */' + stat.size }).end(); return; }
        status = 206;
      }
      const name = path.basename(target).replace(/[\r\n"\\\x00-\x1f\x7f-\uffff]/g, '_');
      res.writeHead(status, { ...common, 'Content-Type': grant.mimeType, 'Accept-Ranges': 'bytes', 'Content-Length': Math.max(0, end - start + 1), 'Content-Disposition': (match[2] === 'download' ? 'attachment' : 'inline') + '; filename="' + name + '"', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}) });
      if (req.method === 'HEAD' || !stat.size) { res.end(); return; }
      await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
    } catch {
      if (!res.headersSent) res.writeHead(404).end('The saved media is no longer available.');
      else res.destroy();
    } finally { if (file) await file.close().catch(() => {}); }
  }
  async function ensureServer() {
    if (starting) return starting;
    if (server) return;
    starting = new Promise((resolve, reject) => {
      const candidate = http.createServer((req, res) => { handle(req, res); });
      candidate.maxConnections = 16;
      candidate.requestTimeout = 30000;
      candidate.headersTimeout = 10000;
      candidate.setTimeout(30000, socket => socket.destroy());
      candidate.once('error', reject);
      candidate.listen(0, '127.0.0.1', () => { server = candidate; resolve(); });
    });
    try { await starting; } finally { starting = null; }
  }
  async function deliver(output, options = {}) {
    const epoch = generation;
    const target = await resolveOutputFile(output, runsRoot());
    const mimeType = TYPES[path.extname(target).toLowerCase()];
    if (!mimeType) throw fault('UNSUPPORTED_MEDIA', 'Choose a saved audio or video output.');
    const stat = await fs.promises.stat(target);
    const metadata = { outputId: output.id, name: path.basename(target), mimeType, sizeBytes: stat.size };
    if (options.mode === 'audio') {
      if (!mimeType.startsWith('audio/')) throw fault('NOT_AUDIO', 'Use link mode for video delivery.');
      const file = await fs.promises.open(target, 'r');
      try {
        const buffer = Buffer.alloc(AUDIO_LIMIT + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const part = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (!part.bytesRead) break;
          bytesRead += part.bytesRead;
        }
        if (bytesRead > AUDIO_LIMIT || (await file.stat()).size > AUDIO_LIMIT) throw fault('MEDIA_TOO_LARGE', 'This audio is too large for inline MCP delivery. Use link mode to deliver the full original file.');
        return { ...metadata, audio: { mimeType, data: buffer.subarray(0, bytesRead).toString('base64') }, message: 'Audio bytes delivered; playback depends on the chat client.' };
      } finally { await file.close(); }
    }
    expire();
    if (grants.size >= 100) throw fault('MEDIA_LINK_LIMIT', 'Too many active media links. Wait for links to expire or disable and re-enable agent access.');
    if (epoch !== generation) throw fault('MEDIA_ACCESS_STOPPED', 'Agent access was stopped during delivery.');
    await ensureServer();
    if (epoch !== generation) throw fault('MEDIA_ACCESS_STOPPED', 'Agent access was stopped during delivery.');
    if (grants.size >= 100) throw fault('MEDIA_LINK_LIMIT', 'Too many active media links.');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = now() + lifetimeMs;
    grants.set(token, { output: { ...output }, mimeType, expires });
    const base = 'http://127.0.0.1:' + server.address().port + '/media/' + token;
    return { ...metadata, playbackUrl: base + '/view', downloadUrl: base + '/download', streamUrl: base + '/file', expiresAt: new Date(expires).toISOString(), message: 'Temporary local links: open on the PC running Local AI Hub. Keep the Hub and agent access enabled. These are not uploaded chat attachments; chat-client link handling and browser codec support vary. Anyone on this PC with the link can access this output until expiry.' };
  }
  async function stop() {
    generation++;
    if (starting) await starting.catch(() => {});
    grants.clear();
    const current = server;
    if (current) {
      const closed = new Promise(resolve => current.close(resolve));
      current.closeAllConnections();
      await closed;
      server = null;
    }
  }
  return { deliver, stop };
}
module.exports = { createMediaDelivery };
