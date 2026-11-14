const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { fault } = require('../agent/bridge.cjs');
const SAFE_FORMATS = 'png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,gif,mov,matroska,webm,avi,wav,mp3,flac,ogg,aac';
const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.mp4', '.mov', '.mkv', '.webm', '.avi', '.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac']);
async function resolveOutputFile(output, runsRoot) {
  if (!output || output.isDirectory) throw fault('INVALID_OUTPUT', 'Choose a saved file output.');
  const root = await fs.realpath(runsRoot);
  const target = await fs.realpath(output.outputPath);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fault('OUTPUT_OUTSIDE_STORAGE', 'This output resolves outside managed pipeline storage.');
  if (!(await fs.stat(target)).isFile()) throw fault('INVALID_OUTPUT', 'Choose a saved file output.');
  return target;
}
function runBounded(executable, args, maxBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0, chunks = [], finished = false;
    const finish = (error, data) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
    const timer = setTimeout(() => { child.kill(); finish(fault('MEDIA_TIMEOUT', 'Media inspection took too long. Try a smaller file or an earlier frame.')); }, 20000);
    child.on('error', () => finish(fault('MEDIA_RUNTIME_UNAVAILABLE', 'The bundled media inspection runtime could not start.')));
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { child.kill(); finish(fault('PREVIEW_TOO_LARGE', 'The media inspection result exceeds the preview limit.')); return; }
      chunks.push(chunk);
    });
    child.on('close', code => finish(code === 0 ? null : fault('MEDIA_INSPECTION_FAILED', 'The saved media could not be decoded at the requested position.'), Buffer.concat(chunks)));
  });
}
function createMediaInspector({ runsRoot, ffmpegPath, ffprobePath }) {
  let busy = false;
  return async (output, options = {}) => {
    if (busy) throw fault('MEDIA_BUSY', 'Another media inspection is running. Try again after it finishes.');
    busy = true;
    try {
      const target = await resolveOutputFile(output, runsRoot());
      const extension = path.extname(target).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(extension)) throw fault('UNSUPPORTED_MEDIA', 'Choose a saved image, audio or video file.');
      // Force the single-image demuxer for JPEGs: some valid files auto-detect as image2.
      // Avoid enabling image2 sequence/pattern access just to inspect one saved file.
      const inputFormat = ['.jpg', '.jpeg'].includes(extension) ? ['-f', 'jpeg_pipe'] : [];
      const probe = JSON.parse((await runBounded(ffprobePath(), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', SAFE_FORMATS, '-show_entries', 'format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,sample_rate,channels,duration', '-of', 'json', ...inputFormat, target], 65536)).toString('utf8'));
      const result = { outputId: output.id, kind: output.kind, format: probe.format || {}, streams: probe.streams || [] };
      if (!options.preview) return result;
      if (!result.streams.some(s => s.codec_type === 'video')) throw fault('NO_VISUAL_STREAM', 'This audio output has no image to preview. Request metadata without preview instead.');
      const imageFile = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'].includes(extension);
      const time = options.timeSeconds || 0;
      if (imageFile && time !== 0) throw fault('INVALID_FRAME_TIME', 'Image previews use timeSeconds=0.');
      if (!imageFile && Number(probe.format?.duration) > 0 && time >= Number(probe.format.duration)) throw fault('INVALID_FRAME_TIME', 'Choose a frame time before the end of the video.');
      const jpeg = await runBounded(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', SAFE_FORMATS, ...(!imageFile ? ['-ss', String(time)] : []), ...inputFormat, '-i', target, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease:force_divisible_by=2', '-threads', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'], 700000);
      if (!jpeg.length) throw fault('EMPTY_PREVIEW', 'No frame was available at that position.');
      return { ...result, timeSeconds: time, preview: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } };
    } finally { busy = false; }
  };
}
module.exports = { createMediaInspector, resolveOutputFile };
