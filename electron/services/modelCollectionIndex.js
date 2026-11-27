const fs = require('node:fs/promises');
const path = require('node:path');

const LABEL_FORMAT = 6;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REPOSITORIES = 512;
const MAX_REPO_BYTES = 256 * 1024;

// One JSON line per repository allows replacements and eviction to be budgeted
// exactly, without reserializing the entire catalog on each inspection.
function createCollectionIndex(getFile, normalize, budget = MAX_BYTES) {
  const entries = new Map();
  let bytes = 0;
  let loading;
  let write;
  let timer;
  let dirty = false;

  function replace(record) {
    const key = record.id.toLowerCase();
    const line = JSON.stringify(record) + '\n';
    const previous = entries.get(key);
    if (previous?.line === line) return false;
    const size = Buffer.byteLength(line);
    if (size > budget) return false;
    if (previous) {
      bytes -= previous.size;
      entries.delete(key);
    }
    entries.set(key, { record, line, size, terms: [...record.names, ...record.labels.map(row => row.label)].map(normalize) });
    bytes += size;
    while (bytes > budget || entries.size > MAX_REPOSITORIES) {
      const oldest = entries.keys().next().value;
      bytes -= entries.get(oldest).size;
      entries.delete(oldest);
    }
    return true;
  }

  async function load() {
    try {
      const file = getFile();
      if ((await fs.stat(file)).size > budget) return;
      const lines = (await fs.readFile(file, 'utf8')).split('\n');
      let count = 0;
      for (const line of lines) {
        if (++count % 16 === 0) await new Promise(resolve => setImmediate(resolve));
        if (!line) continue;
        const r = JSON.parse(line);
        if (validId(r.id) && Array.isArray(r.names) && Array.isArray(r.labels) &&
            r.names.every(value => typeof value === 'string') && r.labels.every(row => typeof row?.label === 'string' && typeof row.path === 'string')) {
          const labels = listedFileLabels(r.names, r.labels);
          if (labels.length !== r.labels.length) schedule();
          replace({ ...r, labels });
        }
      }
    } catch { /* A missing or damaged cache can be rebuilt by browsing. */ }
  }

  function validId(id) {
    return typeof id === 'string' && /^[\w.-]+\/[\w.-]+$/.test(id) && !id.split('/').some(part => part === '.' || part === '..');
  }

  async function flush() {
    await (loading ||= load());
    if (write) await write;
    if (!dirty) return;
    dirty = false;
    const file = getFile();
    const snapshot = Array.from(entries.values(), entry => entry.line).join('');
    write = (async () => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file + '.tmp', snapshot);
        await fs.rename(file + '.tmp', file);
      } catch { dirty = true; }
    })();
    await write;
  }

  function schedule() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; void flush(); }, 250);
    timer.unref();
  }

  function boundedStrings(values, limit) {
    const result = new Set();
    let size = 0;
    for (const value of values) {
      if (!value || typeof value !== 'string' || value.length > 2048 || result.has(value)) continue;
      const next = Buffer.byteLength(JSON.stringify(value)) + 1;
      if (size + next > limit) break;
      size += next;
      result.add(value);
    }
    return [...result];
  }

  function listedFileLabels(names, rows) {
    if (!rows.length) return rows;
    const files = new Set(names);
    return rows.filter(row => files.has(row.path));
  }

  function boundedLabels(rows) {
    const labels = [];
    let bytes = 0;
    for (const row of rows) {
      if (!row.label || row.label.length > 2048 || !row.path || row.path.length > 2048) continue;
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > MAX_REPO_BYTES * 0.24) break;
      labels.push(row);
    }
    return labels;
  }

  function* filenames(siblings) {
    for (const file of siblings) yield file?.rfilename;
  }

  async function remember(detail, labels) {
    if (!validId(detail?.id) || detail.private || detail.gated || !detail.siblings?.length) return;
    await (loading ||= load());
    const old = entries.get(detail.id.toLowerCase())?.record;
    const rev = detail.sha || '';
    const names = labels !== undefined && old?.rev === rev ? old.names :
      boundedStrings(filenames(detail.siblings), MAX_REPO_BYTES * 0.75);
    const previousLabels = old?.rev === rev ? old.labels : [];
    // Old rows still locate candidate repositories, but only freshly parsed
    // links may select files without rechecking the README.
    const labelFormat = labels === undefined ? (old?.labelFormat || 0) : LABEL_FORMAT;
    const record = { id: detail.id, downloads: detail.downloads || 0, likes: detail.likes || 0, createdAt: detail.createdAt || detail.created_at || detail.lastModified || detail.last_modified, rev, names, labelFormat, labels: listedFileLabels(names, labels === undefined ? previousLabels : boundedLabels(labels)) };
    if (replace(record)) schedule();
  }

  async function matchingIds(query, exactFilename = false, sort) {
    await (loading ||= load());
    const tokens = normalize(query).split(' ').filter(Boolean);
    if (!tokens.length) return [];
    const result = [];
    for (const { record, terms } of entries.values()) {
      const matched = exactFilename
        ? record.names.some(name => path.posix.basename(name).toLowerCase() === query.toLowerCase())
        : terms.some(term => tokens.every(token => term.includes(token)));
      if (matched) result.push(record);
    }
    if (sort) {
      const value = row => sort === 'newest' ? (Date.parse(row.createdAt) || 0) : Number(row[sort === 'highest-rated' ? 'likes' : 'downloads']) || 0;
      result.sort((a, b) => value(b) - value(a) || a.id.localeCompare(b.id));
    } else result.reverse();
    return result.map(row => row.id);
  }

  function aliasPaths(detail, query, matches) {
    const record = entries.get(detail.id.toLowerCase())?.record;
    if (!detail.sha || record?.rev !== detail.sha || record.labelFormat !== LABEL_FORMAT) return [];
    return record.labels.filter(row => matches(query, [row.label])).map(row => row.path);
  }

  return { remember, matchingIds, aliasPaths, flush };
}

module.exports = { createCollectionIndex };
