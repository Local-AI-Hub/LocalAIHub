function normalizeOllamaErrorText(value) {
  return String(value || '').trim().toLowerCase();
}

function isOllamaAllocationFailureMessage(value) {
  const normalized = normalizeOllamaErrorText(value);
  if (!normalized) {
    return false;
  }

  return normalized.includes('memory layout cannot be allocated')
    || normalized.includes('cuda out of memory')
    || normalized.includes('cuda_malloc failed: out of memory')
    || normalized.includes('failed to allocate')
    || (normalized.includes('out of memory') && normalized.includes('ollama'));
}

function buildOllamaAllocationFailureMessage(options = {}) {
  const modelName = String(options.modelName || '').trim();
  const contextLabel = String(options.context || '').trim().toLowerCase();
  const policy = options.runtimePolicy || null;
  const prefix = contextLabel === 'aider-turn'
    ? 'Ollama hard-failed this Aider turn'
    : modelName
      ? `Ollama hard-failed while running ${modelName}`
      : 'Ollama hard-failed';
  const policyMessage = policy && Number.isFinite(policy.maxContextTokens) && Number.isFinite(policy.mapTokens)
    ? ` Local AI Hub had already capped Aider's Ollama context to ${policy.maxContextTokens} tokens and repo map to ${policy.mapTokens} tokens on this PC, so the remaining failure means this model or turn still does not fit cleanly.`
    : '';

  return `${prefix} because it could not allocate the requested memory layout on this PC.${policyMessage} This is a real Ollama memory limit, not a retryable Local AI Hub error. Try a smaller model, a smaller context, or free GPU memory before trying again.`;
}

module.exports = {
  buildOllamaAllocationFailureMessage,
  isOllamaAllocationFailureMessage,
};
