const path = require('path');
const fs = require('fs-extra');

const { runCommand } = require('./commandService');
const { getProviderSecret } = require('./credentialService');
const { listDownloadedModels } = require('./modelService');
const { listOllamaModels } = require('./ollamaService');

const SUPPORTED_PROVIDER_PROTOCOLS = new Set(['openai-compatible', 'anthropic', 'google-gemini']);
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

function normalizeProviderId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeModelId(value) {
  return String(value || '').trim();
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeGeminiModelId(value) {
  return normalizeModelId(value).replace(/^models\//i, '');
}

function getProviderProtocol(provider) {
  return String(provider?.configuration?.protocol || '').trim().toLowerCase();
}

function getOllamaBaseUrl(tool) {
  return trimTrailingSlash(tool?.launchUrl || DEFAULT_OLLAMA_BASE_URL) || DEFAULT_OLLAMA_BASE_URL;
}

function getSupportedAiderProviders({ ollamaTool, providers = [] }) {
  const options = [];

  if (ollamaTool) {
    options.push({
      id: 'ollama',
      source: 'local',
      label: ollamaTool.name || 'Ollama',
      detail: 'Use a locally installed Ollama model with Aider.',
      supported: true,
      launchSupport: 'ollama-chat',
    });
  }

  for (const provider of providers) {
    if (!provider?.isConnected) {
      continue;
    }

    const protocol = getProviderProtocol(provider);
    const supported = SUPPORTED_PROVIDER_PROTOCOLS.has(protocol);
    const detail =
      protocol === 'openai-compatible'
        ? 'Uses this provider through Aider\'s OpenAI-compatible adapter.'
        : protocol === 'anthropic'
          ? 'Uses Aider\'s Anthropic adapter.'
          : protocol === 'google-gemini'
            ? 'Uses Aider\'s Gemini adapter.'
            : 'Local AI Hub cannot map this provider into Aider yet.';

    options.push({
      id: provider.id,
      source: 'cloud',
      label: provider.name,
      detail,
      protocol,
      supported,
      launchSupport: supported ? protocol : 'unsupported',
    });
  }

  return options;
}

function buildOllamaAiderModelEntry(model, ollamaTool, options = {}) {
  const modelName = normalizeModelId(model?.name || model?.id || '');
  if (!modelName) {
    return null;
  }

  const capabilityLabels = Array.isArray(model?.capabilityLabels)
    ? model.capabilityLabels.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const appearsEmbeddingOnly = capabilityLabels.includes('embedding') && !capabilityLabels.includes('vision');
  const compatibilityState = appearsEmbeddingOnly ? 'caution' : 'supported';
  const compatibilityNote = appearsEmbeddingOnly
    ? 'Aider uses Ollama\'s chat adapter. This model looks like an embedding-focused model, so coding chat may not work.'
    : options.fromLibraryState
      ? 'Local AI Hub is showing installed Ollama models from disk and will start Ollama when you launch Aider.'
      : 'Uses Ollama\'s local chat API through Aider\'s ollama_chat adapter.';

  return {
    id: modelName,
    label: modelName,
    detail: model?.detail || null,
    aiderModel: `ollama_chat/${modelName}`,
    compatibilityState,
    compatibilityNote,
    env: {
      OLLAMA_API_BASE: getOllamaBaseUrl(ollamaTool),
    },
  };
}

function buildProviderAiderModelEntry(provider, model) {
  const modelId = normalizeModelId(model?.id || model?.name || '');
  if (!modelId) {
    return null;
  }

  const protocol = getProviderProtocol(provider);
  let aiderModel = '';
  let env = {};
  let compatibilityNote = '';

  if (protocol === 'openai-compatible') {
    aiderModel = `openai/${modelId}`;
    env = {
      OPENAI_API_BASE: trimTrailingSlash(provider.apiEndpoint),
    };
    compatibilityNote = 'Uses this provider through Aider\'s OpenAI-compatible adapter. Model-specific tuning may fall back to generic defaults.';
  } else if (protocol === 'anthropic') {
    aiderModel = `anthropic/${modelId}`;
    compatibilityNote = 'Uses Aider\'s Anthropic adapter.';
  } else if (protocol === 'google-gemini') {
    const normalizedGeminiModel = normalizeGeminiModelId(modelId);
    aiderModel = `gemini/${normalizedGeminiModel}`;
    compatibilityNote = 'Uses Aider\'s Gemini adapter.';
  } else {
    return null;
  }

  return {
    id: modelId,
    label: model?.label || modelId,
    detail: model?.detail || null,
    aiderModel,
    compatibilityState: 'supported',
    compatibilityNote,
    env,
  };
}

function selectMatchingModelId(models = [], preferredModelId = '') {
  const normalizedPreferredModelId = normalizeModelId(preferredModelId);
  if (normalizedPreferredModelId && models.some((entry) => entry.id === normalizedPreferredModelId)) {
    return normalizedPreferredModelId;
  }

  return models[0]?.id || '';
}

async function listAiderLaunchModels({ providerId, ollamaTool, providers = [], preferredModelId = '' }) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    throw new Error('Choose a provider before Local AI Hub loads Aider models.');
  }

  if (normalizedProviderId === 'ollama') {
    if (!ollamaTool) {
      throw new Error('Install or detect Ollama before using it with Aider.');
    }

    let models = [];
    let fromLibraryState = false;
    if (String(ollamaTool.status || '').trim().toLowerCase() === 'running') {
      try {
        const response = await listOllamaModels(ollamaTool, { includeCapabilities: true });
        models = (response.models || []).map((entry) => buildOllamaAiderModelEntry(entry, ollamaTool)).filter(Boolean);
      } catch {
        fromLibraryState = true;
      }
    }

    if (!models.length) {
      fromLibraryState = true;
      const localModels = await listDownloadedModels(ollamaTool);
      models = localModels
        .map((entry) => buildOllamaAiderModelEntry({ ...entry, name: entry.name }, ollamaTool, { fromLibraryState: true }))
        .filter(Boolean);
    }

    return {
      providerId: normalizedProviderId,
      providerLabel: ollamaTool.name || 'Ollama',
      models,
      selectedModelId: selectMatchingModelId(models, preferredModelId),
      sourceState: fromLibraryState ? 'library' : 'runtime',
      message: models.length
        ? fromLibraryState
          ? 'Local AI Hub is showing installed Ollama models from disk. It will start Ollama when you launch Aider.'
          : `Connected to ${getOllamaBaseUrl(ollamaTool)}.`
        : 'No Ollama models were found yet. Pull a model in Ollama before starting Aider.',
    };
  }

  const provider = (providers || []).find((entry) => normalizeProviderId(entry.id) === normalizedProviderId);
  if (!provider?.isConnected) {
    throw new Error('Connect that provider before using it with Aider.');
  }

  const protocol = getProviderProtocol(provider);
  if (!SUPPORTED_PROVIDER_PROTOCOLS.has(protocol)) {
    throw new Error(`${provider.name} is connected in Local AI Hub, but its API protocol is not mapped into Aider yet.`);
  }

  const response = await require('./providerService').listProviderModels(provider.id);
  const models = (response.models || [])
    .map((entry) => buildProviderAiderModelEntry(provider, entry))
    .filter(Boolean);

  return {
    providerId: normalizedProviderId,
    providerLabel: provider.name,
    models,
    selectedModelId: selectMatchingModelId(models, preferredModelId || response.selectedModel || ''),
    sourceState: 'provider',
    message: models.length
      ? `Local AI Hub loaded ${models.length} Aider-ready model${models.length === 1 ? '' : 's'} from ${provider.name}.`
      : `${provider.name} is connected, but it did not return any models Local AI Hub can use with Aider.`,
  };
}

async function inspectAiderProject(projectDir) {
  const normalizedProjectDir = path.resolve(String(projectDir || '').trim());
  if (!String(projectDir || '').trim()) {
    throw new Error('Choose a project folder before starting Aider.');
  }

  if (!(await fs.pathExists(normalizedProjectDir))) {
    throw new Error('That project folder does not exist on this PC anymore. Choose it again before launching Aider.');
  }

  const stats = await fs.stat(normalizedProjectDir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error('Choose a project folder, not a file, before starting Aider.');
  }

  const gitVersion = await runCommand('git', ['--version'], {
    cwd: normalizedProjectDir,
    allowFailure: true,
  });
  const gitAvailable = gitVersion.code === 0;

  let hasGitRepo = false;
  let gitRoot = '';
  if (gitAvailable) {
    const gitRootResult = await runCommand('git', ['rev-parse', '--show-toplevel'], {
      cwd: normalizedProjectDir,
      allowFailure: true,
    });
    if (gitRootResult.code === 0) {
      gitRoot = String(gitRootResult.stdout || '').trim();
      hasGitRepo = Boolean(gitRoot);
    }
  }

  if (!hasGitRepo && (await fs.pathExists(path.join(normalizedProjectDir, '.git')))) {
    hasGitRepo = true;
    gitRoot = normalizedProjectDir;
  }

  let message = '';
  if (hasGitRepo) {
    message = `Git repository detected at ${gitRoot}.`;
  } else if (gitAvailable) {
    message = 'No git repository was found in this folder yet. Local AI Hub can initialize one before Aider starts.';
  } else {
    message = 'Git is not available on this PC, so Local AI Hub cannot initialize a repository automatically.';
  }

  return {
    projectDir: normalizedProjectDir,
    gitAvailable,
    hasGitRepo,
    gitRoot,
    canInitializeGit: gitAvailable && !hasGitRepo,
    message,
  };
}

async function ensureAiderGitRepository(projectInfo, options = {}) {
  if (projectInfo.hasGitRepo || !options.initializeGit) {
    return projectInfo;
  }

  if (!projectInfo.gitAvailable) {
    throw new Error('Git is not available on this PC, so Local AI Hub cannot initialize a repository for Aider.');
  }

  await runCommand('git', ['init'], {
    cwd: projectInfo.projectDir,
    errorMessage: 'Local AI Hub could not initialize a git repository for that project folder.',
  });

  return inspectAiderProject(projectInfo.projectDir);
}

async function resolveAiderLaunchSelection({ providerId, modelId, ollamaTool, providers = [] }) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const normalizedModelId = normalizeModelId(modelId);
  if (!normalizedProviderId) {
    throw new Error('Choose a provider before launching Aider.');
  }
  if (!normalizedModelId) {
    throw new Error('Choose a model before launching Aider.');
  }

  if (normalizedProviderId === 'ollama') {
    if (!ollamaTool) {
      throw new Error('Install or detect Ollama before using it with Aider.');
    }

    const modelEntry = buildOllamaAiderModelEntry({ name: normalizedModelId }, ollamaTool, {
      fromLibraryState: String(ollamaTool.status || '').trim().toLowerCase() !== 'running',
    });
    return {
      providerLabel: ollamaTool.name || 'Ollama',
      modelEntry,
      requiresOllamaStart: String(ollamaTool.status || '').trim().toLowerCase() !== 'running',
    };
  }

  const provider = (providers || []).find((entry) => normalizeProviderId(entry.id) === normalizedProviderId);
  if (!provider?.isConnected) {
    throw new Error('Connect that provider before launching Aider.');
  }

  const protocol = getProviderProtocol(provider);
  if (!SUPPORTED_PROVIDER_PROTOCOLS.has(protocol)) {
    throw new Error(`${provider.name} is connected in Local AI Hub, but it cannot be launched through Aider yet.`);
  }

  const modelEntry = buildProviderAiderModelEntry(provider, {
    id: normalizedModelId,
    label: normalizedModelId,
  });
  if (!modelEntry) {
    throw new Error(`Local AI Hub could not map ${provider.name}'s selected model into an Aider launch profile.`);
  }

  const providerSecret = await getProviderSecret(provider.id).catch(() => '');
  if (!String(providerSecret || '').trim()) {
    throw new Error(`Reconnect ${provider.name} before launching Aider. Local AI Hub could not read its saved API key.`);
  }

  if (protocol === 'openai-compatible') {
    modelEntry.env.OPENAI_API_KEY = providerSecret;
  } else if (protocol === 'anthropic') {
    modelEntry.env.ANTHROPIC_API_KEY = providerSecret;
  } else if (protocol === 'google-gemini') {
    modelEntry.env.GEMINI_API_KEY = providerSecret;
  }

  return {
    providerLabel: provider.name,
    modelEntry,
    requiresOllamaStart: false,
  };
}

async function buildAiderLaunchConfiguration({ tool, ollamaTool, providers = [], projectDir, providerId, modelId, initializeGit }) {
  const projectInfo = await inspectAiderProject(projectDir);
  const resolvedProjectInfo = await ensureAiderGitRepository(projectInfo, {
    initializeGit: Boolean(initializeGit),
  });
  const selection = await resolveAiderLaunchSelection({
    providerId,
    modelId,
    ollamaTool,
    providers,
  });

  const args = [
    '--model',
    selection.modelEntry.aiderModel,
    '--no-fancy-input',
    '--no-pretty',
    '--no-analytics',
    '--no-check-update',
    '--no-show-release-notes',
    '--no-show-model-warnings',
    '--encoding',
    'utf-8',
  ];

  if (resolvedProjectInfo.hasGitRepo) {
    args.push('--git', '--no-gitignore');
  } else {
    args.push('--no-git', '--no-gitignore', '--no-auto-commits', '--no-dirty-commits', '--skip-sanity-check-repo');
  }

  return {
    projectInfo: resolvedProjectInfo,
    selection,
    persistedFields: {
      aiderInitializeGit: Boolean(initializeGit),
      aiderModelId: normalizeModelId(modelId),
      aiderProviderId: normalizeProviderId(providerId),
      lastProjectDir: resolvedProjectInfo.projectDir,
    },
    launchProfileOverride: {
      ...tool.launchProfile,
      args,
      env: {
        ...(selection.modelEntry.env || {}),
        NO_COLOR: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      workingDir: resolvedProjectInfo.projectDir,
      allowExternalWorkingDir: true,
    },
    launchMessage: resolvedProjectInfo.hasGitRepo
      ? `Aider is running in ${resolvedProjectInfo.projectDir} with ${selection.modelEntry.label} from ${selection.providerLabel}.`
      : `Aider is running in ${resolvedProjectInfo.projectDir} without git, using ${selection.modelEntry.label} from ${selection.providerLabel}.`,
  };
}

module.exports = {
  buildAiderLaunchConfiguration,
  getSupportedAiderProviders,
  inspectAiderProject,
  listAiderLaunchModels,
};
