const path = require('path');

const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|gif)$/i;
const AUDIO_PREVIEW_FILE_PATTERN = /\.(wav|mp3|flac|ogg|m4a|aac)$/i;
const ARCHIVE_FILE_PATTERN = /\.(zip|7z|rar|tar|tgz|tar\.gz)$/i;
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
const INVOKEAI_TOOL_IDS = new Set(['invokeai']);
const INVOKEAI_API_IMPORT_MODEL_TYPES = new Set(['Checkpoint', 'Inpainting', 'LoRA', 'ControlNet', 'VAE', 'Embedding']);
const INVOKEAI_API_IMPORT_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth']);
const GGUF_TOOL_IDS = new Set(['lmstudio', 'koboldcpp']);
const RVC_MODEL_FILE_PATTERN = /\.(?:pth|pt)$/i;
const RVC_INDEX_FILE_PATTERN = /\.index$/i;
const RVC_CONTEXT_PATTERN = /(?:^|[^a-z0-9])(?:rvc|retrieval[-_\s]*based[-_\s]*voice[-_\s]*conversion|retrieval[-_\s]*voice[-_\s]*conversion|voice[-_\s]*conversion|voice[-_\s]*model|voice[-_\s]*clone|speaker[-_\s]*model)(?:[^a-z0-9]|$)/i;
const PACKAGE_TOOL_IDS = new Set(['audiocraft-webui', 'wan21-webui', 'upscayl']);
const AUDIOCRAFT_CORE_REQUIRED_FILES = Object.freeze(['state_dict.bin', 'compression_state_dict.bin']);
const AUDIOCRAFT_MUSICGEN_OPTIONAL_FILES = Object.freeze(['config.json']);
const AUDIOCRAFT_AUDIOGEN_OPTIONAL_FILES = Object.freeze([]);
const AUDIOCRAFT_REPOSITORIES = new Map([
  ['facebook/audiogen-medium', { audioMode: 'sound', label: 'AudioCraft AudioGen snapshot', modelType: 'Audio / Speech', required: AUDIOCRAFT_CORE_REQUIRED_FILES, optional: AUDIOCRAFT_AUDIOGEN_OPTIONAL_FILES }],
  ['facebook/musicgen-small', { audioMode: 'music', label: 'AudioCraft MusicGen snapshot', modelType: 'Audio / Speech', required: AUDIOCRAFT_CORE_REQUIRED_FILES, optional: AUDIOCRAFT_MUSICGEN_OPTIONAL_FILES }],
  ['facebook/musicgen-medium', { audioMode: 'music', label: 'AudioCraft MusicGen snapshot', modelType: 'Audio / Speech', required: AUDIOCRAFT_CORE_REQUIRED_FILES, optional: AUDIOCRAFT_MUSICGEN_OPTIONAL_FILES }],
  ['facebook/musicgen-large', { audioMode: 'music', label: 'AudioCraft MusicGen large snapshot', modelType: 'Audio / Speech', required: AUDIOCRAFT_CORE_REQUIRED_FILES, optional: AUDIOCRAFT_MUSICGEN_OPTIONAL_FILES }],
  ['facebook/musicgen-melody', { audioMode: 'music', label: 'AudioCraft MusicGen melody snapshot', modelType: 'Audio / Speech', required: AUDIOCRAFT_CORE_REQUIRED_FILES, optional: AUDIOCRAFT_MUSICGEN_OPTIONAL_FILES }],
]);
const WAN_REPOSITORIES = new Map([
  ['wan-ai/wan2.1-t2v-1.3b', { generationMode: 'text-to-video', label: 'Wan2.1 text-to-video model folder', modelType: 'Video', requiredPatterns: [/^diffusion_pytorch_model(?:-[0-9]{5}-of-[0-9]{5})?\.safetensors$/i, /^models_t5_.*\.pth$/i, /^Wan2\.1_VAE\.pth$/i] }],
  ['wan-ai/wan2.1-t2v-14b', { generationMode: 'text-to-video', label: 'Wan2.1 text-to-video model folder', modelType: 'Video', requiredPatterns: [/^diffusion_pytorch_model(?:-[0-9]{5}-of-[0-9]{5})?\.safetensors$/i, /^models_t5_.*\.pth$/i, /^Wan2\.1_VAE\.pth$/i] }],
  ['wan-ai/wan2.1-i2v-14b-480p', { generationMode: 'image-to-video', label: 'Wan2.1 image-to-video model folder', modelType: 'Video', requiredPatterns: [/^diffusion_pytorch_model(?:-[0-9]{5}-of-[0-9]{5})?\.safetensors$/i, /^models_t5_.*\.pth$/i, /^Wan2\.1_VAE\.pth$/i, /^models_clip_.*\.pth$/i] }],
  ['wan-ai/wan2.1-i2v-14b-720p', { generationMode: 'image-to-video', label: 'Wan2.1 image-to-video model folder', modelType: 'Video', requiredPatterns: [/^diffusion_pytorch_model(?:-[0-9]{5}-of-[0-9]{5})?\.safetensors$/i, /^models_t5_.*\.pth$/i, /^Wan2\.1_VAE\.pth$/i, /^models_clip_.*\.pth$/i] }],
]);

function normalizeRepositoryId(value) {
  return String(value || '').trim().replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

function repositoryFolderName(repositoryId) {
  const parts = String(repositoryId || '').trim().replace(/\\+/g, '/').split('/').filter(Boolean);
  return parts.pop() || 'model-package';
}

function packageArtifactEntry(artifact, required = true, installRelativePath = null) {
  const sourcePath = artifactPath(artifact);
  const fileName = artifactName(artifact);
  return {
    fileName,
    installRelativePath: String(installRelativePath || sourcePath || fileName).replace(/\\+/g, '/'),
    path: sourcePath,
    required: Boolean(required),
    sizeBytes: Number((artifact && artifact.sizeBytes) || 0),
  };
}

function sumPackageSize(files = []) {
  return files.reduce((total, entry) => total + (Number(entry.sizeBytes || 0) || 0), 0);
}

function buildBlockedPackagePlan(tool, repositoryId, reason, rejectedArtifacts = []) {
  return {
    artifactLabel: 'Package',
    blockingReason: reason,
    compatibleArtifacts: [],
    modelType: tool && tool.id === 'wan21-webui' ? 'Video' : tool && tool.id === 'upscayl' ? 'Upscaler' : 'Audio / Speech',
    optionalArtifacts: [],
    packageIdentity: repositoryId ? 'hf:' + repositoryId : null,
    planType: 'package',
    recommendedArtifactPath: repositoryId || null,
    rejectedArtifacts: rejectedArtifacts.slice(0, 8).map((artifact) => ({ fileName: artifactName(artifact), modelType: artifact.modelType || 'Support file', path: artifactPath(artifact), reason: 'This file is not enough to install the required package layout.' })),
    requiredArtifacts: [],
    runnable: false,
    warning: null,
  };
}

function createAudioCraftPackagePlan(options, artifacts) {
  const rawRepositoryId = String(options && (options.catalogRepositoryId || options.repositoryId) || '').trim().replace(/\\+/g, '/');
  const repositoryId = normalizeRepositoryId(rawRepositoryId);
  const profile = AUDIOCRAFT_REPOSITORIES.get(repositoryId);
  if (!profile) {
    return buildBlockedPackagePlan(options.tool, repositoryId, 'AudioCraft Model Manager installs are limited to known MusicGen and AudioGen snapshots whose complete local layout Local AI Hub can verify. Use a supported facebook/musicgen-* or facebook/audiogen-* snapshot, or leave the pipeline model field blank to use AudioCraft upstream defaults.', artifacts);
  }
  const byPath = new Map((artifacts || []).map((artifact) => [artifactPath(artifact).toLowerCase(), artifact]));
  const requiredFiles = profile.required.map((filePath) => byPath.get(filePath.toLowerCase())).filter(Boolean).map((artifact) => packageArtifactEntry(artifact, true));
  const missing = profile.required.filter((filePath) => !byPath.has(filePath.toLowerCase()));
  if (missing.length) {
    return buildBlockedPackagePlan(options.tool, repositoryId, 'This AudioCraft snapshot is missing required files: ' + missing.join(', ') + '. Local AI Hub will not install a partial AudioCraft package.', artifacts);
  }
  const optionalFiles = profile.optional.map((filePath) => byPath.get(filePath.toLowerCase())).filter(Boolean).map((artifact) => packageArtifactEntry(artifact, false));
  const downloadFiles = [...requiredFiles, ...optionalFiles];
  const packageRoot = path.join('audiocraft', repositoryFolderName(rawRepositoryId || repositoryId)).replace(/\\+/g, '/');
  return {
    artifactLabel: profile.label,
    blockingReason: null,
    compatibleArtifacts: [{ artifactKind: 'audiocraft-snapshot', fileName: repositoryFolderName(rawRepositoryId || repositoryId), modelType: profile.modelType, path: packageRoot, requiredArtifacts: requiredFiles.map((entry) => entry.path) }],
    downloadFiles,
    modelType: profile.modelType,
    optionalArtifacts: optionalFiles,
    packageIdentity: 'hf:' + repositoryId + ':audiocraft-snapshot',
    packageName: repositoryFolderName(rawRepositoryId || repositoryId),
    packageRoot,
    packageTargetMode: 'folder',
    planType: 'package',
    recommendedArtifactPath: packageRoot,
    rejectedArtifacts: [],
    requiredArtifacts: requiredFiles.map((entry) => entry.path),
    requiredFiles,
    runnable: true,
    sizeBytes: sumPackageSize(downloadFiles),
    warning: 'This installs a complete local AudioCraft snapshot. Upstream model-name defaults still work when the pipeline model field is blank.',
  };
}

function parseWanDiffusionShardName(fileName) {
  const match = String(fileName || '').match(/^diffusion_pytorch_model-(\d{5})-of-(\d{5})\.safetensors$/i);
  if (!match) {
    return null;
  }
  return {
    index: Number.parseInt(match[1], 10),
    total: Number.parseInt(match[2], 10),
  };
}

function validateWanDiffusionShardMatches(matches = []) {
  const shardEntries = [];
  const unshardedEntries = [];

  for (const artifact of matches) {
    const name = artifactName(artifact);
    const shard = parseWanDiffusionShardName(name);
    if (shard) {
      shardEntries.push({ artifact, name, ...shard });
    } else if (/^diffusion_pytorch_model\.safetensors$/i.test(name)) {
      unshardedEntries.push(artifact);
    }
  }

  if (!shardEntries.length) {
    return null;
  }

  if (unshardedEntries.length) {
    return 'This Wan model snapshot mixes sharded and non-sharded diffusion weights. Choose a snapshot with either one complete diffusion_pytorch_model.safetensors file or one complete shard set.';
  }

  const totals = new Set(shardEntries.map((entry) => entry.total));
  if (totals.size !== 1) {
    return 'This Wan model snapshot mixes diffusion shard counts. Choose a snapshot where every diffusion shard uses the same -of-000NN total.';
  }

  const total = shardEntries[0].total;
  if (!Number.isInteger(total) || total < 1) {
    return 'This Wan model snapshot has an invalid diffusion shard count.';
  }

  const byIndex = new Map();
  for (const entry of shardEntries) {
    if (!Number.isInteger(entry.index) || entry.index < 1 || entry.index > total) {
      return `This Wan model snapshot has an invalid diffusion shard name: ${entry.name}.`;
    }
    const existing = byIndex.get(entry.index) || [];
    existing.push(entry);
    byIndex.set(entry.index, existing);
  }

  const duplicates = Array.from(byIndex.entries()).filter(([, entries]) => entries.length > 1);
  if (duplicates.length) {
    const index = String(duplicates[0][0]).padStart(5, '0');
    return `This Wan model snapshot has duplicate diffusion shard ${index}. Choose a snapshot with exactly one file for each shard.`;
  }

  const missing = [];
  for (let index = 1; index <= total; index += 1) {
    if (!byIndex.has(index)) {
      missing.push(String(index).padStart(5, '0'));
    }
  }

  if (missing.length) {
    return `This Wan model snapshot is missing diffusion shard ${missing[0]} of ${String(total).padStart(5, '0')}. Local AI Hub needs every diffusion_pytorch_model-00001-of-000NN through diffusion_pytorch_model-000NN-of-000NN file.`;
  }

  return null;
}
function createWanPackagePlan(options, artifacts) {
  const rawRepositoryId = String(options && (options.catalogRepositoryId || options.repositoryId) || '').trim().replace(/\\+/g, '/');
  const repositoryId = normalizeRepositoryId(rawRepositoryId);
  const profile = WAN_REPOSITORIES.get(repositoryId);
  if (!profile) {
    return buildBlockedPackagePlan(options.tool, repositoryId, 'Wan Model Manager installs are limited to known Wan-AI folders that match Local AI Hub\'s current Diffsynth runtime layout. Diffusers-only or component-only Wan repos are blocked for now.', artifacts);
  }
  const rootArtifacts = (artifacts || []).filter((artifact) => artifactPath(artifact) && !artifactPath(artifact).includes('/'));
  const requiredFiles = [];
  const missingPatterns = [];
  for (const pattern of profile.requiredPatterns) {
    const matches = rootArtifacts.filter((artifact) => pattern.test(artifactName(artifact))).sort((left, right) => artifactName(left).localeCompare(artifactName(right)));
    if (!matches.length) {
      missingPatterns.push(String(pattern));
      continue;
    }
    if (pattern.test('diffusion_pytorch_model.safetensors')) {
      const shardIssue = validateWanDiffusionShardMatches(matches);
      if (shardIssue) {
        return buildBlockedPackagePlan(options.tool, repositoryId, shardIssue, artifacts);
      }
    }
    requiredFiles.push(...matches.map((artifact) => packageArtifactEntry(artifact, true)));
  }
  if (missingPatterns.length) {
    return buildBlockedPackagePlan(options.tool, repositoryId, 'This Wan snapshot is missing required diffusion, text encoder, VAE, or image encoder files. Local AI Hub will not install a partial Wan model folder.', artifacts);
  }
  const seen = new Set();
  const dedupedRequired = requiredFiles.filter((entry) => {
    const key = entry.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const packageRoot = repositoryFolderName(rawRepositoryId || repositoryId);
  return {
    artifactLabel: profile.label,
    blockingReason: null,
    compatibleArtifacts: [{ artifactKind: 'wan-model-folder', fileName: packageRoot, modelType: profile.modelType, path: packageRoot, requiredArtifacts: dedupedRequired.map((entry) => entry.path) }],
    downloadFiles: dedupedRequired,
    modelType: profile.modelType,
    optionalArtifacts: [],
    packageIdentity: 'hf:' + repositoryId + ':wan-model-folder',
    packageName: packageRoot,
    packageRoot,
    packageTargetMode: 'folder',
    planType: 'package',
    recommendedArtifactPath: packageRoot,
    rejectedArtifacts: [],
    requiredArtifacts: dedupedRequired.map((entry) => entry.path),
    requiredFiles: dedupedRequired,
    runnable: true,
    sizeBytes: sumPackageSize(dedupedRequired),
    warning: 'This installs the Wan folder layout expected under models\\Wan-AI. Hardware and CUDA readiness warnings still apply.',
  };
}

function createUpscaylPackagePlan(options, artifacts) {
  const pairGroups = new Map();
  for (const artifact of artifacts || []) {
    const fileName = artifactName(artifact);
    const extension = path.extname(fileName).toLowerCase();
    if (!['.param', '.bin'].includes(extension) || artifactPath(artifact).includes('/')) {
      continue;
    }
    const stem = fileName.slice(0, -extension.length);
    const group = pairGroups.get(stem.toLowerCase()) || { stem, files: {} };
    group.files[extension] = artifact;
    pairGroups.set(stem.toLowerCase(), group);
  }
  const completePairs = [...pairGroups.values()].filter((group) => group.files['.param'] && group.files['.bin']);
  if (!completePairs.length) {
    return buildBlockedPackagePlan(options.tool, normalizeRepositoryId(options && (options.catalogRepositoryId || options.repositoryId)), 'Upscayl custom models need a matching .param and .bin pair with the same file name stem. Local AI Hub will not install a one-sided Upscayl asset.', artifacts);
  }
  completePairs.sort((left, right) => left.stem.localeCompare(right.stem));
  const selected = completePairs[0];
  const requiredFiles = [packageArtifactEntry(selected.files['.param'], true, artifactName(selected.files['.param'])), packageArtifactEntry(selected.files['.bin'], true, artifactName(selected.files['.bin']))];
  return {
    artifactLabel: 'Upscayl paired model set',
    blockingReason: null,
    compatibleArtifacts: completePairs.map((group) => ({ artifactKind: 'upscayl-model-set', fileName: group.stem, modelType: 'Upscaler', path: group.stem, requiredArtifacts: [artifactPath(group.files['.param']), artifactPath(group.files['.bin'])] })),
    downloadFiles: requiredFiles,
    modelType: 'Upscaler',
    optionalArtifacts: [],
    packageIdentity: 'hf:' + normalizeRepositoryId(options && (options.catalogRepositoryId || options.repositoryId)) + ':upscayl-model-set:' + selected.stem.toLowerCase(),
    packageName: selected.stem,
    packageRoot: selected.stem,
    packageTargetMode: 'flat',
    planType: 'package',
    recommendedArtifactPath: selected.stem,
    rejectedArtifacts: [],
    requiredArtifacts: requiredFiles.map((entry) => entry.path),
    requiredFiles,
    runnable: true,
    sizeBytes: sumPackageSize(requiredFiles),
    warning: 'This installs the matching .param and .bin files together so Upscayl can discover the custom model by name.',
  };
}

function createPackageDownloadPlan(options, artifacts) {
  const toolId = String(options && options.tool && options.tool.id || '').trim().toLowerCase();
  if (toolId === 'audiocraft-webui') return createAudioCraftPackagePlan(options, artifacts);
  if (toolId === 'wan21-webui') return createWanPackagePlan(options, artifacts);
  if (toolId === 'upscayl') return createUpscaylPackagePlan(options, artifacts);
  return null;
}

function normalizeModelType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'Checkpoint';
  if (normalized.includes('rvc') || normalized.includes('retrieval voice conversion') || normalized.includes('voice conversion') || normalized.includes('voice model')) return 'RVC Voice Model';
  if (normalized.includes('gguf') || /\.gguf$/i.test(normalized)) return 'GGUF';
  if (normalized.includes('upscaler') || normalized.includes('esrgan') || normalized.includes('realesrgan')) return 'Upscaler';
  if (normalized.includes('video') || normalized.includes('wan2.1') || normalized.includes('wan-ai')) return 'Video';
  if (normalized.includes('audio') || normalized.includes('speech') || normalized.includes('musicgen') || normalized.includes('audiogen') || normalized.includes('bark')) return 'Audio / Speech';
  if (normalized.includes('inpaint')) return 'Inpainting';
  if (normalized.includes('lora') || normalized.includes('locon')) return 'LoRA';
  if (normalized.includes('vae')) return 'VAE';
  if (normalized.includes('embedding') || normalized.includes('textual inversion') || normalized.includes('textualinversion')) return 'Embedding';
  if (normalized.includes('control')) return 'ControlNet';
  if (normalized.includes('hyper')) return 'Hypernetwork';
  return 'Checkpoint';
}

function normalizeModelTypeFilter(value) {
  return String(value || 'all').trim().toLowerCase() || 'all';
}

function targetFamily(tool) {
  if (tool && PACKAGE_TOOL_IDS.has(tool.id)) return 'package';
  if (tool && tool.id === 'ollama') return 'ollama';
  if (tool && GGUF_TOOL_IDS.has(tool.id)) return 'gguf';
  if (tool && WEBUI_TOOL_IDS.has(tool.id)) return 'sd-webui';
  if (tool && tool.id === 'comfyui') return 'comfyui';
  if (tool && INVOKEAI_TOOL_IDS.has(tool.id)) return 'invokeai';
  if (tool && tool.id === 'rvc') return 'rvc';
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

function hasLikelyRvcContext(artifact) {
  const combined = [artifactPath(artifact), artifactName(artifact), artifact && artifact.type, artifact && artifact.modelType]
    .filter(Boolean)
    .join(' ');
  return normalizeModelType(artifact && artifact.modelType) === 'RVC Voice Model' || RVC_CONTEXT_PATTERN.test(combined);
}

function normalizeRvcMatchToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function compactRvcMatchToken(value) {
  return normalizeRvcMatchToken(value).replace(/\s+/g, '');
}

function rvcStem(value) {
  const fileName = artifactName({ rfilename: value });
  const extension = path.extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

function rvcPathTokens(artifact) {
  const fullPath = artifactPath(artifact);
  const segments = fullPath.split('/').filter(Boolean);
  const fileName = artifactName(artifact);
  const withoutIndex = fileName.replace(/\.index$/i, '');
  return [...segments.slice(0, -1), withoutIndex]
    .map((entry) => ({ compact: compactRvcMatchToken(entry), normalized: normalizeRvcMatchToken(entry) }))
    .filter((entry) => entry.compact);
}

function rvcIndexMatchesPrimary(indexArtifact, primaryArtifact, compatibleCount, indexCount) {
  const primaryStem = rvcStem(artifactPath(primaryArtifact));
  const primaryCompact = compactRvcMatchToken(primaryStem);
  if (primaryCompact.length >= 3 && !['model', 'pytorchmodel', 'weight', 'weights'].includes(primaryCompact)) {
    if (rvcPathTokens(indexArtifact).some((token) => token.compact.includes(primaryCompact) || primaryCompact.includes(token.compact))) {
      return true;
    }
  }
  return compatibleCount === 1 && indexCount === 1;
}

function getRvcOptionalCompanions(rejected, recommended, compatible) {
  if (!recommended || recommended.artifactKind !== 'rvc-voice-model') {
    return { ambiguous: false, companions: [], indexCount: 0 };
  }
  const indexArtifacts = rejected.filter((artifact) => artifact.artifactKind === 'rvc-index');
  const matches = indexArtifacts.filter((artifact) => rvcIndexMatchesPrimary(artifact, recommended, compatible.length, indexArtifacts.length));
  if (matches.length !== 1) {
    return { ambiguous: indexArtifacts.length > 0, companions: [], indexCount: indexArtifacts.length };
  }
  return {
    ambiguous: false,
    companions: matches.map((artifact) => ({
      artifactKind: artifact.artifactKind,
      fileName: artifactName(artifact),
      modelType: artifact.modelType,
      path: artifactPath(artifact),
      sizeBytes: Number(artifact.sizeBytes || 0),
    })),
    indexCount: indexArtifacts.length,
  };
}

function inferRvcArtifact(artifact) {
  const relativePath = artifactPath(artifact);
  const fileName = artifactName(artifact);
  const extension = path.extname(fileName).toLowerCase();
  if (hasSupportPath(artifact) || DOCUMENTATION_FILE_PATTERN.test(relativePath) || CONFIG_ONLY_FILE_PATTERN.test(fileName) || IMAGE_FILE_PATTERN.test(fileName) || AUDIO_PREVIEW_FILE_PATTERN.test(fileName)) {
    return { rejected: true, artifactKind: 'support-file', artifactLabel: 'Support file', modelType: 'Support file', reason: 'Documentation, config, preview, and audio sample files are supporting files, not RVC voice model weights.' };
  }
  if (ARCHIVE_FILE_PATTERN.test(fileName)) {
    return { rejected: true, artifactKind: 'unsupported-archive', artifactLabel: 'Archive', modelType: 'Archive', reason: 'This catalog downloader only installs single RVC voice weight files today, not archive bundles.' };
  }
  if (RVC_INDEX_FILE_PATTERN.test(fileName)) {
    return { rejected: true, artifactKind: 'rvc-index', artifactLabel: 'RVC index', modelType: 'RVC index', reason: 'RVC index files are optional companions. Choose a .pth voice model weight as the primary download.' };
  }
  if (!RVC_MODEL_FILE_PATTERN.test(fileName)) {
    return { rejected: true, artifactKind: 'unsupported', artifactLabel: 'Unsupported', modelType: normalizeModelType(fileName), reason: (fileName || 'This file') + ' is not a recognized RVC voice model weight.' };
  }
  if (!hasLikelyRvcContext(artifact)) {
    return { rejected: true, artifactKind: 'generic-pytorch-weight', artifactLabel: 'Generic PyTorch weight', modelType: 'PyTorch weight', reason: 'This .pth/.pt file is not clearly labeled as an RVC voice model, so Local AI Hub will not install it into RVC automatically.' };
  }
  let score = 95;
  const normalizedPath = relativePath.toLowerCase();
  if (extension === '.pth') score += 10;
  if (pathSegments(artifact).includes('weights')) score += 8;
  if (normalizedPath.includes('rvc')) score += 6;
  if (artifact && artifact.primary) score += 10;
  return { artifactKind: 'rvc-voice-model', artifactLabel: 'RVC voice model', modelType: 'RVC Voice Model', score };
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
  if (family === 'rvc') {
    const inferred = inferRvcArtifact(artifact);
    if (inferred.rejected) return Object.assign({}, inferred, { runnable: false });
    if (!selectedTypeMatches(inferred.modelType, selectedType)) return Object.assign({}, inferred, { runnable: false, reason: inferred.modelType + ' artifacts do not match the selected ' + normalizeModelType(selectedType) + ' filter.' });
    return Object.assign({}, inferred, { runnable: true });
  }
  if (family === 'sd-webui' || family === 'comfyui' || family === 'invokeai') {
    if (extension === '.gguf' && (family === 'sd-webui' || family === 'invokeai')) {
      const targetLabel = family === 'invokeai' ? 'InvokeAI' : 'Forge and Automatic1111';
      return { artifactKind: 'target-mismatch', artifactLabel: 'GGUF LLM file', modelType: 'GGUF', runnable: false, reason: 'GGUF files are for LLM targets such as KoboldCpp or LM Studio. ' + targetLabel + ' need image checkpoint files such as .safetensors or .ckpt.' };
    }
    const inferred = inferImageArtifact(artifact);
    if (inferred.rejected) return Object.assign({}, inferred, { runnable: false });
    if (family === 'invokeai') {
      const normalizedPath = artifactPath(artifact).toLowerCase();
      const looksLikeDiffusersFolderMember = DIFFUSERS_GENERIC_COMPONENT_FILE_PATTERN.test(fileName) && /(?:^|\/)controlnet(?:\/|$)/i.test(normalizedPath);
      if (looksLikeDiffusersFolderMember) {
        return Object.assign({}, inferred, { runnable: false, reason: 'InvokeAI diffusers folder imports are not enabled in Local AI Hub yet. Choose a single-file ControlNet, LoRA, VAE, embedding, checkpoint, or inpainting artifact.' });
      }
      if (!INVOKEAI_API_IMPORT_MODEL_TYPES.has(inferred.modelType)) {
        return Object.assign({}, inferred, { runnable: false, reason: 'InvokeAI Model Manager support currently covers checkpoints, inpainting checkpoints, LoRAs, ControlNet files, VAEs, and textual inversion embeddings through InvokeAI\'s import API. This artifact type is not enabled for InvokeAI yet.' });
      }
      if (!INVOKEAI_API_IMPORT_EXTENSIONS.has(extension)) {
        return Object.assign({}, inferred, { runnable: false, reason: 'InvokeAI imports from Local AI Hub are limited to single model files ending in .safetensors, .ckpt, .pt, or .pth for now.' });
      }
    }
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
    if (family === 'invokeai') score += 20;
    if (normalizeModelTypeFilter(selectedType) !== 'all' && selectedTypeMatches(inferred.modelType, selectedType)) score += 35;
    if (artifact && artifact.primary) score += 20;
    return Object.assign({}, inferred, { installStrategy: family === 'invokeai' ? 'invokeai-api-import' : null, runnable: true, score });
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
  const family = targetFamily(tool);
  const compatible = annotated.filter((artifact) => artifact.runnable).sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || artifactPath(left).localeCompare(artifactPath(right)));
  const rejected = annotated.filter((artifact) => !artifact.runnable);
  const recommended = compatible[0] || null;
  const rvcCompanionPlan = getRvcOptionalCompanions(rejected, recommended, compatible);
  const optionalArtifacts = rvcCompanionPlan.companions;
  const blockingReason = recommended ? null : ((rejected.find((artifact) => artifact.blockingReason) || {}).blockingReason || 'Local AI Hub could not find a runnable artifact for ' + ((tool && tool.name) || 'this target') + '.');
  const baseWarning = optionalArtifacts.length
    ? 'A matching RVC index file will be downloaded as an optional companion for retrieval-index quality.'
    : rvcCompanionPlan.ambiguous
      ? 'RVC index files are present, but Local AI Hub could not match one confidently to the selected voice weight. Add the .index file manually if you need retrieval-index quality.'
      : recommended && recommended.modelType === 'Inpainting' && normalizeModelTypeFilter(selectedType) !== 'inpainting'
        ? 'This looks like an inpainting checkpoint. Base checkpoints are preferred unless you choose the Inpainting filter.'
        : null;
  const invokeAiImport = family === 'invokeai' && Boolean(recommended);
  const warning = invokeAiImport
    ? ['Local AI Hub will download this file to a temporary location, then ask InvokeAI to import and register it through InvokeAI\'s model API.', baseWarning].filter(Boolean).join(' ')
    : baseWarning;
  return {
    artifactLabel: recommended ? recommended.artifactLabel : null,
    compatibleArtifacts: compatible.map((artifact) => ({ artifactKind: artifact.artifactKind, fileName: artifactName(artifact), modelType: artifact.modelType, path: artifactPath(artifact), requiredArtifacts: artifact.requiredArtifacts || [] })),
    installStrategy: invokeAiImport ? 'invokeai-api-import' : null,
    modelType: recommended ? recommended.modelType : null,
    optionalArtifacts,
    planType: invokeAiImport ? 'api-import' : null,
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
  const packagePlan = createPackageDownloadPlan(options || {}, artifacts);
  if (packagePlan) return packagePlan;
  const selectedType = options && options.selectedType;
  const tool = options && options.tool;
  const groups = splitGroups(artifacts);
  const annotated = artifacts.map((artifact) => annotateArtifact(tool, artifact, selectedType, groups));
  return summarizePlan(tool, selectedType, annotated);
}

function annotateArtifactsForDownloadPlan(options) {
  const artifacts = ((options && options.artifacts) || []).filter(Boolean);
  const packagePlan = createPackageDownloadPlan(options || {}, artifacts);
  if (packagePlan) {
    return artifacts.map((artifact) => Object.assign({}, artifact, {
      artifactKind: packagePlan.runnable ? 'package-member' : 'package-blocked-member',
      artifactLabel: packagePlan.artifactLabel || 'Package',
      blockingReason: packagePlan.runnable ? null : packagePlan.blockingReason,
      downloadPlan: Object.assign({}, packagePlan),
      modelType: packagePlan.modelType || 'Package',
      requiredArtifacts: packagePlan.requiredArtifacts || [],
      runnable: Boolean(packagePlan.runnable),
      score: packagePlan.runnable ? 120 : 0,
    }));
  }
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
