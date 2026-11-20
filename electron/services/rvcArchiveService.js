const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const yauzl = require('yauzl');
const { isRvcTrainingWeight } = require('./modelDownloadPlanService');

async function selectVoiceEntries(zip, signal, requireVoiceEvidence, nested) {
  const weights = [];
  const indices = [];
  const archives = [];
  await new Promise((resolve, reject) => {
    zip.once('error', reject);
    zip.once('end', resolve);
    zip.on('entry', entry => {
      if (signal?.aborted) return reject(signal.reason || new Error('Download cancelled.'));
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if ((!mode || mode === 0o100000) && !entry.fileName.startsWith('__MACOSX/') && !path.basename(entry.fileName).startsWith('._')) {
        if (/\.pth?$/i.test(entry.fileName) && !isRvcTrainingWeight(entry.fileName)) weights.push(entry);
        if (/\.index$/i.test(entry.fileName)) indices.push(entry);
        if (/\.zip$/i.test(entry.fileName)) archives.push(entry);
      }
      zip.readEntry();
    });
    zip.readEntry();
  });
  if (!weights.length && archives.length === 1 && !nested) {
    const inner = archives[0];
    if (inner.uncompressedSize > 8 * 1024 ** 3) throw new Error('The inner voice ZIP exceeds the 8 GB extraction limit.');
    return { inner, bytes: inner.uncompressedSize };
  }
  if (!weights.length && archives.length) throw new Error('Choose a single voice ZIP. This archive contains multiple bundles or additional nesting.');
  if (weights.length !== 1) throw new Error(weights.length
    ? 'This ZIP contains multiple voice weights. Choose a single-voice ZIP or an individual weight.'
    : 'This ZIP contains no exported .pth or .pt voice weight.');
  if (requireVoiceEvidence && !indices.length && !/rvc/i.test(weights[0].fileName)) {
    throw new Error('This untagged ZIP has no retrieval index or RVC-labeled weight to identify it as a voice model.');
  }
  const selected = [weights[0], ...(indices.length === 1 ? indices : [])];
  const bytes = selected.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (!Number.isSafeInteger(bytes) || bytes > 8 * 1024 ** 3) throw new Error('This voice bundle exceeds the 8 GB extraction limit.');
  return { selected, bytes, ambiguousIndex: indices.length > 1 };
}
const MAX_DIRECTORY_BYTES = 256 * 1024;

async function inspectVoiceZip(url, size, requireVoiceEvidence) {
  if (!url || !Number.isSafeInteger(size) || size < 22) return null;
  const start = Math.max(0, size - MAX_DIRECTORY_BYTES);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  let zip;
  try {
    const response = await fetch(url, { signal: controller.signal, headers: {
      Range: 'bytes=' + start + '-' + (size - 1), 'Accept-Encoding': 'identity',
    } });
    if (response.status !== 206 || response.headers.get('content-range') !== 'bytes ' + start + '-' + (size - 1) + '/' + size) return null;
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    for await (const chunk of response.body) {
      if (offset + chunk.length > buffer.length) return null;
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== buffer.length) return null;
    const reader = new yauzl.RandomAccessReader();
    reader.read = (target, dest, length, position, done) => {
      if (position < start || position + length > size) return setImmediate(done, new Error('Directory outside ZIP tail.'));
      buffer.copy(target, dest, position - start, position - start + length);
      setImmediate(done, null, length);
    };
    zip = await promisify(yauzl.fromRandomAccessReader)(reader, size, { lazyEntries: true, autoClose: false, strictFileNames: true });
    const { bytes, inner } = await selectVoiceEntries(zip, controller.signal, requireVoiceEvidence, false);
    return { bytes, nested: Boolean(inner) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    zip?.close();
  }
}

async function extractRvcVoice(zipPath, stageRoot, signal, checkSpace, requireVoiceEvidence, nested = false) {
  const zip = await promisify(yauzl.open)(zipPath, { lazyEntries: true, autoClose: false, strictFileNames: true });
  try {
    const { selected, inner, bytes, ambiguousIndex } = await selectVoiceEntries(zip, signal, requireVoiceEvidence, nested);
    if (inner) {
      await checkSpace(inner.uncompressedSize);
      const innerPath = path.join(stageRoot, 'nested.zip');
      const stream = await promisify(zip.openReadStream.bind(zip))(inner);
      await pipeline(stream, fs.createWriteStream(innerPath, { flags: 'wx' }), { signal });
      return await extractRvcVoice(innerPath, stageRoot, signal, checkSpace, requireVoiceEvidence, true);
    }
    await checkSpace(bytes);
    for (const [i, entry] of selected.entries()) {
      const stream = await promisify(zip.openReadStream.bind(zip))(entry);
      await pipeline(stream, fs.createWriteStream(path.join(stageRoot, i ? 'index' : 'weight'), { flags: 'wx' }), { signal });
    }
    return { hasIndex: selected.length === 2, ambiguousIndex };
  } finally {
    zip.close();
  }
}
module.exports = { extractRvcVoice, inspectVoiceZip };
