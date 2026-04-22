function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

function normalizeString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeTextBlock(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function trimPreviewText(value, limit = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > limit ? normalized.slice(0, Math.max(1, limit - 3)) + '...' : normalized;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => normalizeTextBlock(entry)).filter(Boolean))];
  }

  return [...new Set(
    String(value || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((entry) => entry.replace(/^[-*\d.)\s]+/, '').trim())
      .filter(Boolean),
  )];
}

module.exports = {
  cloneValue,
  isRecord,
  normalizeString,
  normalizeStringList,
  normalizeTextBlock,
  trimPreviewText,
};

module.exports.default = module.exports;
