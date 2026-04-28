const path = require('path');

const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|gif)$/i;
const DOCUMENTATION_FILE_PATTERN = /(?:^|[\\/])(?:README|LICENSE|NOTICE|CHANGELOG)(?:\.[a-z0-9]+)?$/i;
const CONFIG_ONLY_FILE_PATTERN = /\.(json|ya?ml|txt|md)$/i;
const DIFFUSERS_COMPONENT_SEGMENTS = new Set([
  'feature_extractor',
  'safety_checker',
  'scheduler',
  'text_encoder',
  'text_encoder_2',
  'tokenizer',
  'tokenizer_2',
  'unet',
]);
const DIFFUSERS_GENERIC_COMPONENT_FILE_PATTERN = /^(?:diffusion_pytorch_model|model|pytorch_model)(?:[._-][a-z0-9]+)*\.(?:safetensors|bin|pt|pth)$/i;
const SUPPORT_SEGMENTS = new Set(['assets', 'asset', 'examples', 'example', 'images', 'image', 'media', 'previews', 'preview', 'samples', 'sample']);
const WEBUI_TOOL_IDS = new Set(['automatic1111', 'forge']);
const GGUF_TOOL_IDS = new Set(['lmstudio', 'koboldcpp']);

function normalizeModelType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'Checkpoint';
  if (normalized.includes('gguf') || /\.gguf$/i.test(normalized)) return 'GGUF';
  if (normalized.includes('upscaler') || normalized.includes('esrgan') || normalized.includes('realesrgan')) return 'Upscaler';
  if (normalized.includes('audio') || normalized.includes('speech') || normalized.includes('musicgen') || normalized.includes('bark')) return 'Audio / Speech';
  if (normalized.includes('inpaint')) return 'Inpainting';
  if (normalized.includes('lora') || normalized.includes('locon')) return 'LoRA';
  if (normalized.includes('vae')) return 'VAE';
  if (normalized.includes('embedding') || normalized.includes('textual inversion')) return 'Embedding';
  if (normalized.includes('control')) return 'ControlNet';
  if (normalized.includes('hyper')) return 'Hypernetwork';
  return 'Checkpoint';
}

function normalizeModelTypeFilter(value) {
  return String(value || 'all').trim().toLowerCase() || 'all';
}

function targetFamily(tool) {
  if (tool && tool.id === 'ollama') return 'ollama';
  if (tool && GGUF_TOOL_IDS.has(tool.id)) return 'gguf';
  if (tool && WEBUI_TOOL_IDS.has(tool.id)) return 'sd-webui';
  if (tool && tool.id === 'comfyui') return 'comfyui';
  return 'generic-file';
}

function artifactPath(artifact) {
  return String((artifact && (artifact.rfilename || artifact.fileName || artifact.name || artifact.path)) || '').trim().replace(/\\+/g, '/');
}

function artifactName(artifact) {
  return path.basename(artifactPath(artifact) || String((artifact && (artifact.fileName || artifact.name)) || '').trim());
}

function pathSegments(artifact) {
  return artifactPath(artifact).split('/').map((segment) => segment.trim().toLowerCase()).filter(Boolean);
}

function hasDiffusersComponentPath(artifact) {
  const segments = pathSegments(artifact);
  if (segments.some((segment) => DIFFUSERS_COMPONENT_SEGMENTS.has(segment))) {
    return true;
  }
  return segments.includes('vae') && DIFFUSERS_GENERIC_COMPONENT_FILE_PATTERN.test(artifactName(artifact));
}

function hasSupportPath(artifact) {
  return pathSegments(artifact).some((segment) => SUPPORT_SEGMENTS.has(segment));
}

function selectedTypeMatches(modelType, selectedType) {
  const selected = normalizeModelTypeFilter(selectedType);
  if (!selected || selected === 'all') return true;
  return normalizeModelType(modelType).toLowerCase() === normalizeModelType(selected).toLowerCase();
}

function parseSplitGguf(artifact) {
  const fullPath = artifactPath(artifact);
  const fileName = artifactName(artifact);
  const match = fileName.match(/^(.+?)-(\d{5})-of-(\d{5})\.gguf$/i);
  if (!match) return null;
  return {
    groupKey: fullPath.slice(0, fullPath.length - fileName.length) + match[1] + '-split.gguf',
    index: Number.parseInt(match[2], 10),
    total: Number.parseInt(match[3], 10),
  };
}

function splitGroups(artifacts) {
  const groups = new Map();
  for (const artifact of artifacts || []) {
    const split = parseSplitGguf(artifact);
    if (!split) continue;
    const group = groups.get(split.groupKey) || { artifacts: [], indexes: new Set(), total: split.total };
    group.artifacts.push(artifact);
    group.indexes.add(split.index);
    group.total = Math.max(group.total, split.total);
    groups.set(split.groupKey, group);
  }
  return groups;
}

function splitGroupFor(artifact, groups) {
  const split = parseSplitGguf(artifact);
  return split ? groups.get(split.groupKey) || null : null;
}

function inferImageArtifact(artifact) {
  const relativePath = artifactPath(artifact);
  const fileName = artifactName(artifact);
  const combined = [relativePath, fileName, artifact && artifact.type, artifact && artifact.modelType].filter(Boolean).join(' ').toLowerCase();
  const extension = path.extname(fileName).toLowerCase();
  if (hasDiffusersComponentPath(artifact)) {
    return { rejected: true, artifactKind: 'support-file', artifactLabel: 'Support file', modelType: 'Support file', reason: 'Diffusers component/support files are not runnable generation checkpoints by themselves.' };
  }
  if (hasSupportPath(artifact) || DOCUMENTATION_FILE_PATTERN.test(relativePath) || CONFIG_ONLY_FILE_PATTERN.test(fileName) || IMAGE_FILE_PATTERN.test(fileName)) {
    return { rejected: true, artifactKind: 'support-file', artifactLabel: 'Support file', modelType: 'Support file', reason: 'Documentation, config, and preview files are supporting files, not runnable models.' };
  }
  if (combined.includes('controlnet') || /(?:^|[\\/])control[_-]?/.test(relativePath.toLowerCase())) return { artifactKind: 'controlnet', artifactLabel: 'ControlNet', modelType: 'ControlNet' };
  if (combined.includes('lora') || combined.includes('locon')) return { artifactKind: 'lora', artifactLabel: 'LoRA', modelType: 'LoRA' };
  if (combined.includes('embedding') || combined.includes('textual inversion')) return { artifactKind: 'embedding', artifactLabel: 'Embedding', modelType: 'Embedding' };
  if (combined.includes('hypernetwork')) return { artifactKind: 'hypernetwork', artifactLabel: 'Hypernetwork', modelType: 'Hypernetwork' };
  if (combined.includes('vae')) return { artifactKind: 'vae', artifactLabel: 'VAE', modelType: 'VAE' };
  if (combined.includes('upscaler') || combined.includes('realesrgan') || combined.includes('esrgan')) return { artifactKind: 'upscaler', artifactLabel: 'Upscaler', modelType: 'Upscaler' };
  if (combined.includes('inpaint')) return { artifactKind: 'inpainting', artifactLabel: 'Inpainting', modelType: 'Inpainting' };
  if (extension === '.safetensors' || extension === '.ckpt') return { artifactKind: 'checkpoint', artifactLabel: 'Checkpoint', modelType: 'Checkpoint' };
  if (extension === '.pt' || extension === '.pth') return { artifactKind: 'upscaler', artifactLabel: 'Upscaler', modelType: 'Upscaler' };
  return { rejected: true, artifactKind: 'unsupported', artifactLabel: 'Unsupported', modelType: normalizeModelType(fileName), reason: (fileName || 'This file') + ' is not a recognized runnable image-generation model artifact for this target.' };
}

function classifyArtifact(tool, artifact, selectedType) {
  const family = targetFamily(tool);
  const fileName = artifactName(artifact);
  const extension = path.extname(fileName).toLowerCase();
  const sizeBytes = Number((artifact && artifact.sizeBytes) || 0);
  if (family === 'ollama') return { artifactKind: 'ollama-tag', artifactLabel: 'Ollama tag', modelType: 'Model', runnable: true, score: 120 };
  if (family === 'gguf') {
    if (extension !== '.gguf') return { artifactKind: 'unsupported', artifactLabel: 'Not GGUF', modelType: normalizeModelType(fileName), runnable: false, reason: 'This target can only run GGUF model files.' };
    return { artifactKind: 'gguf', artifactLabel: 'GGUF', modelType: 'GGUF', runnable: true, score: 100 + Math.min(sizeBytes / (1024 * 1024 * 1024), 20) };
  }
  if (family === 'sd-webui' || family === 'comfyui') {
    if (extension === '.gguf' && family === 'sd-webui') {
      return { artifactKind: 'target-mismatch', artifactLabel: 'GGUF LLM file', modelType: 'GGUF', runnable: false, reason: 'GGUF files are for LLM targets such as KoboldCpp or LM Studio. Forge and Automatic1111 need image checkpoint files such as .safetensors or .ckpt.' };
    }
    const inferred = inferImageArtifact(artifact);
    if (inferred.rejected) return Object.assign({}, inferred, { runnable: false });
    if (!selectedTypeMatches(inferred.modelType, selectedType)) return Object.assign({}, inferred, { runnable: false, reason: inferred.modelType + ' artifacts do not match the selected ' + normalizeModelType(selectedType) + ' filter.' });
    let score = 40 + Math.min(sizeBytes / (1024 * 1024 * 1024), 20);
    if (inferred.modelType === 'Checkpoint') {
      score += 80;
      const normalizedPath = artifactPath(artifact).toLowerCase();
      if (extension === '.safetensors') score += 10;
      if (normalizedPath.includes('emaonly')) score += 15;
      if (normalizedPath.includes('pruned')) score += 8;
      if (normalizedPath.includes('non_ema') || normalizedPath.includes('non-ema')) score -= 20;
    }
    if (inferred.modelType === 'Inpainting') score += normalizeModelTypeFilter(selectedType) === 'inpainting' ? 75 : 25;
    if (normalizeModelTypeFilter(selectedType) !== 'all' && selectedTypeMatches(inferred.modelType, selectedType)) score += 35;
    if (artifact && artifact.primary) score += 20;
    return Object.assign({}, inferred, { runnable: true, score });
  }
  const modelType = normalizeModelType((artifact && (artifact.modelType || artifact.type)) || fileName);
  const runnable = selectedTypeMatches(modelType, selectedType);
  return { artifactKind: modelType.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'model', artifactLabel: modelType, modelType, runnable, score: 50, reason: runnable ? null : modelType + ' artifacts do not match the selected filter.' };
}

function annotateArtifact(tool, artifact, selectedType, groups) {
  const classification = classifyArtifact(tool, artifact, selectedType);
  const group = splitGroupFor(artifact, groups);
  let runnable = Boolean(classification.runnable);
  let blockingReason = classification.reason || null;
  let requiredArtifacts = [artifactPath(artifact)].filter(Boolean);
  if (group) {
    requiredArtifacts = group.artifacts.map(artifactPath).filter(Boolean).sort();
    runnable = false;
    blockingReason = group.indexes.size < group.total
      ? 'This split GGUF set is incomplete. Local AI Hub found ' + group.indexes.size + ' of ' + group.total + ' required parts.'
      : 'This is a split GGUF bundle. Local AI Hub can identify the complete set, but this catalog downloader only installs single-file artifacts today.';
  }
  return Object.assign({}, artifact, {
    artifactKind: classification.artifactKind,
    artifactLabel: classification.artifactLabel,
    blockingReason,
    modelType: classification.modelType,
    requiredArtifacts,
    runnable,
    score: Number(classification.score || 0),
  });
}

function summarizePlan(tool, selectedType, annotated) {
  const compatible = annotated.filter((artifact) => artifact.runnable).sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || artifactPath(left).localeCompare(artifactPath(right)));
  const rejected = annotated.filter((artifact) => !artifact.runnable);
  const recommended = compatible[0] || null;
  const blockingReason = recommended ? null : ((rejected.find((artifact) => artifact.blockingReason) || {}).blockingReason || 'Local AI Hub could not find a runnable artifact for ' + ((tool && tool.name) || 'this target') + '.');
  const warning = recommended && recommended.modelType === 'Inpainting' && normalizeModelTypeFilter(selectedType) !== 'inpainting'
    ? 'This looks like an inpainting checkpoint. Base checkpoints are preferred unless you choose the Inpainting filter.'
    : null;
  return {
    artifactLabel: recommended ? recommended.artifactLabel : null,
    compatibleArtifacts: compatible.map((artifact) => ({ artifactKind: artifact.artifactKind, fileName: artifactName(artifact), modelType: artifact.modelType, path: artifactPath(artifact), requiredArtifacts: artifact.requiredArtifacts || [] })),
    optionalArtifacts: [],
    recommendedArtifact: recommended,
    recommendedArtifactPath: recommended ? artifactPath(recommended) : null,
    rejectedArtifacts: rejected.slice(0, 8).map((artifact) => ({ fileName: artifactName(artifact), modelType: artifact.modelType, path: artifactPath(artifact), reason: artifact.blockingReason || 'This artifact is not compatible with the selected target.' })),
    requiredArtifacts: recommended ? recommended.requiredArtifacts || [] : [],
    runnable: Boolean(recommended),
    blockingReason,
    warning,
  };
}

function createModelDownloadPlan(options) {
  const artifacts = ((options && options.artifacts) || []).filter(Boolean);
  const selectedType = options && options.selectedType;
  const tool = options && options.tool;
  const groups = splitGroups(artifacts);
  const annotated = artifacts.map((artifact) => annotateArtifact(tool, artifact, selectedType, groups));
  return summarizePlan(tool, selectedType, annotated);
}

function annotateArtifactsForDownloadPlan(options) {
  const artifacts = ((options && options.artifacts) || []).filter(Boolean);
  const selectedType = options && options.selectedType;
  const tool = options && options.tool;
  const groups = splitGroups(artifacts);
  const annotated = artifacts.map((artifact) => annotateArtifact(tool, artifact, selectedType, groups));
  const plan = summarizePlan(tool, selectedType, annotated);
  return annotated.map((artifact) => Object.assign({}, artifact, {
    downloadPlan: Object.assign({}, plan, { recommendedArtifact: undefined }),
  }));
}

function ollamaTagPlan(name) {
  return {
    artifactLabel: 'Ollama tag',
    blockingReason: null,
    compatibleArtifacts: [{ artifactKind: 'ollama-tag', fileName: name, modelType: 'Model', path: name, requiredArtifacts: [name].filter(Boolean) }],
    optionalArtifacts: [],
    recommendedArtifactPath: name,
    rejectedArtifacts: [],
    requiredArtifacts: [name].filter(Boolean),
    runnable: true,
    warning: null,
  };
}

module.exports = {
  annotateArtifactsForDownloadPlan,
  artifactPath,
  classifyArtifact,
  createModelDownloadPlan,
  ollamaTagPlan,
};
