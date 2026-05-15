const crypto = require('crypto');

const PROMPT_STYLE_SCHEMA_VERSION = 1;
const PROMPT_STYLE_TARGET_KINDS = Object.freeze(['any', 'image', 'audio', 'video', 'text']);
const PROMPT_STYLE_PLACEMENTS = Object.freeze(['prefix', 'suffix', 'both']);

function createPromptStyleId() {
  if (typeof crypto.randomUUID === 'function') {
    return 'prompt-style-' + crypto.randomUUID();
  }
  return 'prompt-style-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePromptTextForMatch(value) {
  return normalizeWhitespace(value).replace(/\s*,\s*/g, ',').toLowerCase();
}

function splitTerms(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitTerms(entry));
  }
  return String(value || '')
    .split(/[\n,]+/)
    .map((entry) => normalizeWhitespace(entry))
    .filter(Boolean);
}

function uniqueTerms(value) {
  const seen = new Set();
  const terms = [];
  for (const term of splitTerms(value)) {
    const key = normalizePromptTextForMatch(term);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function normalizeTargetKinds(style) {
  const rawKinds = Array.isArray(style?.targetKinds)
    ? style.targetKinds
    : String(style?.targetKind || style?.target || 'any').split(/[\n,]+/);
  const kinds = rawKinds
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => PROMPT_STYLE_TARGET_KINDS.includes(entry));
  return kinds.length ? [...new Set(kinds)] : ['any'];
}

function normalizePromptStylePreset(style = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const id = String(style.id || '').trim() || createPromptStyleId();
  const name = normalizeWhitespace(style.name) || 'Untitled prompt style';
  const placement = PROMPT_STYLE_PLACEMENTS.includes(String(style.placement || '').trim().toLowerCase())
    ? String(style.placement || '').trim().toLowerCase()
    : 'suffix';
  const createdAt = String(style.createdAt || '').trim() || now;
  const updatedAt = options.touch ? now : (String(style.updatedAt || '').trim() || now);

  return {
    id,
    name,
    description: normalizeWhitespace(style.description),
    targetKind: normalizeTargetKinds(style)[0] || 'any',
    targetKinds: normalizeTargetKinds(style),
    positivePrefix: normalizeWhitespace(style.positivePrefix),
    positiveSuffix: normalizeWhitespace(style.positiveSuffix),
    requiredTerms: uniqueTerms(style.requiredTerms),
    negativePrompt: uniqueTerms(style.negativePrompt).join(', '),
    placement,
    dedupe: style.dedupe !== false,
    lockRequiredTerms: style.lockRequiredTerms !== false,
    createdAt,
    updatedAt,
    schemaVersion: PROMPT_STYLE_SCHEMA_VERSION,
  };
}

function normalizePromptStylePresets(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  return value
    .map((entry) => {
      try {
        return normalizePromptStylePreset(entry);
      } catch {
        return null;
      }
    })
    .filter((entry) => {
      if (!entry?.id || seen.has(entry.id)) {
        return false;
      }
      seen.add(entry.id);
      return true;
    })
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' }));
}

function isPromptStyleCompatibleWithTarget(style, targetKind) {
  const target = String(targetKind || '').trim().toLowerCase();
  if (!target) {
    return false;
  }
  const kinds = normalizeTargetKinds(style);
  return kinds.includes('any') || kinds.includes(target);
}

function includesTerm(prompt, term) {
  const normalizedPrompt = normalizePromptTextForMatch(prompt);
  const normalizedTerm = normalizePromptTextForMatch(term);
  return Boolean(normalizedPrompt && normalizedTerm && normalizedPrompt.includes(normalizedTerm));
}

function appendPromptParts(parts) {
  return parts.map((entry) => String(entry || '').trim()).filter(Boolean).join('\n\n').trim();
}

function applyRequiredTerms(prompt, terms, placement) {
  const appliedTerms = [];
  const skippedDuplicateTerms = [];
  const basePrompt = String(prompt || '').trim();
  for (const term of terms) {
    if (includesTerm(basePrompt + '\n' + appliedTerms.join(', '), term)) {
      skippedDuplicateTerms.push(term);
    } else {
      appliedTerms.push(term);
    }
  }

  if (!appliedTerms.length) {
    return { finalPrompt: basePrompt, appliedTerms, skippedDuplicateTerms };
  }

  const requiredText = appliedTerms.join(', ');
  if (placement === 'prefix') {
    return { finalPrompt: appendPromptParts([requiredText, basePrompt]), appliedTerms, skippedDuplicateTerms };
  }
  return { finalPrompt: appendPromptParts([basePrompt, requiredText]), appliedTerms, skippedDuplicateTerms };
}

function mergeNegativePrompt(originalNegativePrompt, styleNegativePrompt) {
  const originalTerms = uniqueTerms(originalNegativePrompt);
  const originalKeys = new Set(originalTerms.map((term) => normalizePromptTextForMatch(term)));
  const appliedNegativeTerms = [];
  const skippedDuplicateNegativeTerms = [];
  for (const term of uniqueTerms(styleNegativePrompt)) {
    const key = normalizePromptTextForMatch(term);
    if (!key || originalKeys.has(key)) {
      skippedDuplicateNegativeTerms.push(term);
      continue;
    }
    originalKeys.add(key);
    appliedNegativeTerms.push(term);
  }
  return {
    finalNegativePrompt: [...originalTerms, ...appliedNegativeTerms].join(', '),
    appliedNegativeTerms,
    skippedDuplicateNegativeTerms,
  };
}

function summarizePromptStyle(style) {
  const normalized = normalizePromptStylePreset(style || {});
  return {
    id: normalized.id,
    name: normalized.name,
    targetKind: normalized.targetKind,
    targetKinds: normalized.targetKinds,
    placement: normalized.placement,
    schemaVersion: normalized.schemaVersion,
  };
}

function applyPromptStyleToPrompt(prompt, style, options = {}) {
  const normalizedStyle = normalizePromptStylePreset(style || {});
  const targetKind = String(options.targetKind || '').trim().toLowerCase();
  const originalPrompt = String(prompt || '').trim();
  const originalNegativePrompt = String(options.negativePrompt || '').trim();
  const supportNegativePrompt = Boolean(options.supportNegativePrompt);

  let finalPrompt = originalPrompt;
  let prefixApplied = '';
  let suffixApplied = '';
  const prefix = normalizedStyle.positivePrefix;
  const suffix = normalizedStyle.positiveSuffix;
  const placement = normalizedStyle.placement;

  if (prefix && !includesTerm(finalPrompt, prefix)) {
    finalPrompt = appendPromptParts([prefix, finalPrompt]);
    prefixApplied = prefix;
  }

  const requiredPlacement = placement === 'prefix' ? 'prefix' : 'suffix';
  const requiredResult = applyRequiredTerms(finalPrompt, normalizedStyle.requiredTerms, requiredPlacement);
  finalPrompt = requiredResult.finalPrompt;

  if (suffix && !includesTerm(finalPrompt, suffix)) {
    finalPrompt = appendPromptParts([finalPrompt, suffix]);
    suffixApplied = suffix;
  }

  const negativeResult = supportNegativePrompt
    ? mergeNegativePrompt(originalNegativePrompt, normalizedStyle.negativePrompt)
    : { finalNegativePrompt: originalNegativePrompt, appliedNegativeTerms: [], skippedDuplicateNegativeTerms: [] };

  return {
    originalPrompt,
    finalPrompt,
    originalNegativePrompt,
    finalNegativePrompt: negativeResult.finalNegativePrompt,
    appliedTerms: requiredResult.appliedTerms,
    skippedDuplicateTerms: requiredResult.skippedDuplicateTerms,
    appliedNegativeTerms: negativeResult.appliedNegativeTerms,
    skippedDuplicateNegativeTerms: negativeResult.skippedDuplicateNegativeTerms,
    positivePrefixApplied: prefixApplied,
    positiveSuffixApplied: suffixApplied,
    targetKind,
    promptStyle: summarizePromptStyle(normalizedStyle),
  };
}

function serializePromptStyleApplication(application = null) {
  if (!application || typeof application !== 'object') {
    return null;
  }
  const style = application.promptStyle || application || {};
  const normalized = {
    id: String(style.id || '').trim(),
    name: String(style.name || '').trim(),
    targetKind: String(style.targetKind || application.targetKind || '').trim(),
    targetKinds: Array.isArray(style.targetKinds) ? style.targetKinds.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    placement: String(style.placement || application.placement || '').trim(),
    originalPrompt: String(application.originalPrompt || '').trim(),
    finalPrompt: String(application.finalPrompt || '').trim(),
    originalNegativePrompt: String(application.originalNegativePrompt || '').trim(),
    finalNegativePrompt: String(application.finalNegativePrompt || '').trim(),
    appliedTerms: uniqueTerms(application.appliedTerms),
    skippedDuplicateTerms: uniqueTerms(application.skippedDuplicateTerms),
    appliedNegativeTerms: uniqueTerms(application.appliedNegativeTerms),
    skippedDuplicateNegativeTerms: uniqueTerms(application.skippedDuplicateNegativeTerms),
    positivePrefixApplied: String(application.positivePrefixApplied || '').trim(),
    positiveSuffixApplied: String(application.positiveSuffixApplied || '').trim(),
  };
  return normalized.id || normalized.name ? normalized : null;
}

module.exports = {
  PROMPT_STYLE_PLACEMENTS,
  PROMPT_STYLE_SCHEMA_VERSION,
  PROMPT_STYLE_TARGET_KINDS,
  applyPromptStyleToPrompt,
  isPromptStyleCompatibleWithTarget,
  normalizePromptStylePreset,
  normalizePromptStylePresets,
  serializePromptStyleApplication,
  splitTerms,
};

module.exports.default = module.exports;
