const STABLE_DIFFUSION_CHECKPOINT_EXTENSIONS = new Set(['.safetensors', '.ckpt']);
const RVC_VOICE_MODEL_EXTENSIONS = new Set(['.pth', '.pt']);

function normalizeAssetToken(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/]+/g, '/')
    .toLowerCase();
}

function stripWebUiHashSuffix(value) {
  return String(value || '').trim().replace(/\s+\[[0-9a-f]{6,}\]$/i, '').trim();
}

function basenameToken(value) {
  const normalized = String(value || '').trim().replace(/[\\/]+/g, '/');
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function extnameToken(value) {
  const baseName = basenameToken(value);
  const index = baseName.lastIndexOf('.');
  return index > 0 ? baseName.slice(index).toLowerCase() : '';
}

function stemToken(value) {
  const baseName = basenameToken(value);
  return baseName ? baseName.slice(0, baseName.length - extnameToken(baseName).length) : '';
}

function addCandidate(candidates, value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return;
  }

  const values = [rawValue, stripWebUiHashSuffix(rawValue), basenameToken(rawValue), basenameToken(stripWebUiHashSuffix(rawValue)), stemToken(rawValue)];
  for (const entry of values) {
    const normalized = normalizeAssetToken(entry);
    if (normalized) {
      candidates.add(normalized);
    }
  }
}

function getStableDiffusionCheckpointCandidates(entry = {}) {
  const candidates = new Set();
  [
    entry.id,
    entry.value,
    entry.canonicalValue,
    entry.label,
    entry.displayLabel,
    entry.title,
    entry.model_name,
    entry.name,
    entry.fileName,
    entry.filename,
    entry.basename,
    entry.relativePath,
    entry.path,
    entry.hash,
    entry.sha256,
    entry.downloadIdentity,
    entry.sourceArtifactPath,
  ].forEach((value) => addCandidate(candidates, value));
  if (Array.isArray(entry.aliases)) {
    entry.aliases.forEach((value) => addCandidate(candidates, value));
  }
  return [...candidates];
}

function getStableDiffusionCheckpointSelectionCandidates(selectedValue = '') {
  if (selectedValue && typeof selectedValue === 'object') {
    return getStableDiffusionCheckpointCandidates(selectedValue);
  }

  const candidates = new Set();
  addCandidate(candidates, selectedValue);
  return [...candidates];
}

function findStableDiffusionCheckpointMatch(models = [], selectedValue = '') {
  const requestedCandidates = getStableDiffusionCheckpointSelectionCandidates(selectedValue);
  if (!requestedCandidates.length) {
    return null;
  }

  return (Array.isArray(models) ? models : []).find((entry) => {
    const entryCandidates = getStableDiffusionCheckpointCandidates(entry);
    return requestedCandidates.some((candidate) => entryCandidates.includes(candidate));
  }) || null;
}

function isLikelySupportOnlyStableDiffusionModel(entry) {
  const haystack = [entry?.title, entry?.model_name, entry?.filename, entry?.name, entry?.fileName, entry?.relativePath, entry?.path]
    .map((value) => String(value || '').toLowerCase())
    .join('\n');
  return Boolean(haystack) && /(^|[\\/\s_-])safety[_ -]?checker([\\/\s_.-]|$)/i.test(haystack);
}

function isStableDiffusionCheckpointFileName(value) {
  return STABLE_DIFFUSION_CHECKPOINT_EXTENSIONS.has(extnameToken(value));
}

function normalizeStableDiffusionCheckpointEntry(entry = {}, tool = null, options = {}) {
  const filename = String(entry.filename || entry.path || '').trim();
  const fileName = String(entry.fileName || basenameToken(filename) || basenameToken(entry.title) || basenameToken(entry.model_name) || '').trim();
  const title = String(entry.title || '').trim();
  const modelName = String(entry.model_name || '').trim();
  const name = String(entry.name || modelName || stemToken(fileName) || stripWebUiHashSuffix(title) || fileName || '').trim();
  const id = String(entry.id || title || modelName || fileName || name || '').trim();
  const canonicalValue = String(entry.canonicalValue || entry.value || title || modelName || fileName || basenameToken(filename) || name || id || '').trim();
  const displayLabel = String(entry.displayLabel || entry.label || title || modelName || name || fileName || canonicalValue || id || '').trim();
  const backendVisible = options.backendVisible !== undefined ? Boolean(options.backendVisible) : Boolean(entry.backendVisible);
  const normalized = {
    ...entry,
    backendFields: {
      basename: fileName,
      filename,
      hash: String(entry.hash || '').trim(),
      model_name: modelName,
      sha256: String(entry.sha256 || '').trim(),
      title,
    },
    backendVisible,
    basename: fileName,
    canonicalValue,
    displayLabel,
    fileName,
    filename,
    id: canonicalValue || id,
    label: displayLabel,
    model_name: modelName,
    modelType: entry.modelType || 'checkpoint',
    name,
    path: String(entry.path || (filename && /[\\/]/.test(filename) ? filename : '') || '').trim(),
    relativePath: String(entry.relativePath || fileName || '').trim(),
    source: entry.source || (backendVisible ? 'backend' : 'local'),
    title,
    toolId: entry.toolId || tool?.id || '',
    value: canonicalValue || id,
  };
  normalized.aliases = getStableDiffusionCheckpointCandidates(normalized);
  return normalized;
}

function getStableDiffusionCheckpointModels(models = [], options = {}) {
  return (Array.isArray(models) ? models : [])
    .filter((entry) => {
      const modelType = String(entry?.modelType || '').trim().toLowerCase();
      const fileName = entry?.fileName || entry?.filename || entry?.title || entry?.name || '';
      const looksLikeCheckpoint = modelType === 'checkpoint' || modelType === 'inpainting' || isStableDiffusionCheckpointFileName(fileName);
      if (!looksLikeCheckpoint || isLikelySupportOnlyStableDiffusionModel(entry)) {
        return false;
      }
      if (options.requireBackendVisible && entry?.backendVisible === false) {
        return false;
      }
      return true;
    });
}

function getCanonicalStableDiffusionCheckpointName(entry = {}) {
  return String(entry.canonicalValue || entry.value || entry.title || entry.model_name || entry.fileName || basenameToken(entry.filename) || entry.name || '').trim();
}

function buildStableDiffusionCheckpointOption(entry = {}, toolId = '') {
  const normalized = normalizeStableDiffusionCheckpointEntry(entry, toolId ? { id: toolId } : null, {
    backendVisible: entry.backendVisible !== false,
  });
  return {
    ...normalized,
    detail: [normalized.backendVisible === false ? 'Local file not visible to backend' : 'Backend checkpoint', normalized.modelType, normalized.relativePath || normalized.fileName]
      .filter(Boolean)
      .join(' | '),
    id: normalized.value || normalized.id,
    label: normalized.displayLabel || normalized.label || normalized.id,
    toolId: toolId || normalized.toolId || '',
  };
}

function getRvcVoiceModelCandidates(entry = {}) {
  const candidates = new Set();
  [entry.id, entry.name, entry.fileName, entry.relativePath, entry.path].forEach((value) => addCandidate(candidates, value));
  return [...candidates];
}

function findRvcVoiceModelMatch(models = [], selectedValue = '') {
  const requested = normalizeAssetToken(selectedValue);
  if (!requested) {
    return null;
  }

  return (Array.isArray(models) ? models : []).find((entry) => getRvcVoiceModelCandidates(entry).includes(requested)) || null;
}

function getRvcVoiceModels(models = []) {
  return (Array.isArray(models) ? models : []).filter((entry) => {
    const fileName = String(entry?.fileName || entry?.path || entry?.relativePath || '').trim();
    const modelType = String(entry?.modelType || '').trim().toLowerCase();
    return modelType === 'audio / speech' || RVC_VOICE_MODEL_EXTENSIONS.has(extnameToken(fileName));
  });
}

module.exports = {
  buildStableDiffusionCheckpointOption,
  findRvcVoiceModelMatch,
  findStableDiffusionCheckpointMatch,
  getCanonicalStableDiffusionCheckpointName,
  getRvcVoiceModels,
  getStableDiffusionCheckpointCandidates,
  getStableDiffusionCheckpointModels,
  getStableDiffusionCheckpointSelectionCandidates,
  isLikelySupportOnlyStableDiffusionModel,
  normalizeAssetToken,
  normalizeStableDiffusionCheckpointEntry,
};
