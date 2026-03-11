const path = require('path');
const fs = require('fs-extra');

const { assertSecureRemoteUrl, sanitizeManifestId } = require('./pathSafetyService');
const { computeManifestDigest, getDefaultManifestSignaturePath, verifyManifestSignature } = require('./manifestSignatureService');
const { getProviderPipelineCapabilities } = require('../shared/pipelineCapabilities.cjs');

const ALLOWED_AUTH_TYPES = new Set(['bearer', 'x-api-key', 'x-goog-api-key']);
const ALLOWED_PROTOCOLS = new Set(['openai-compatible', 'anthropic', 'google-gemini']);

let loadedProviders = null;
let manifestStatus = {
  hash: null,
  verified: false,
  warning: null,
};

function getBundledProviderManifestPath() {
  return path.join(__dirname, '..', 'config', 'providers-manifest.json');
}

function normalizeEndpoint(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`Local AI Hub could not read the ${label}.`);
  }

  if (/^https:\/\//i.test(text)) {
    return assertSecureRemoteUrl(text, label);
  }

  return text.startsWith('/') ? text : `/${text}`;
}

function normalizeProviderConfiguration(providerId, configuration = {}) {
  const protocol = String(configuration.protocol || '').trim().toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    throw new Error(`Local AI Hub rejected ${providerId} because it uses an unsupported provider protocol.`);
  }

  return {
    protocol,
    chatEndpoint: configuration.chatEndpoint ? normalizeEndpoint(configuration.chatEndpoint, `${providerId} chat endpoint`) : null,
    headers: configuration.headers && typeof configuration.headers === 'object' ? configuration.headers : {},
    maxOutputTokens: Number(configuration.maxOutputTokens) > 0 ? Number(configuration.maxOutputTokens) : 512,
    preferredModelPrefixes: Array.isArray(configuration.preferredModelPrefixes)
      ? configuration.preferredModelPrefixes.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [],
    blockedModelPatterns: Array.isArray(configuration.blockedModelPatterns)
      ? configuration.blockedModelPatterns.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [],
    defaultModel: String(configuration.defaultModel || '').trim() || null,
    anthropicVersion: String(configuration.anthropicVersion || '2023-06-01').trim(),
  };
}

function validateProvider(rawProvider) {
  if (!rawProvider || typeof rawProvider !== 'object') {
    throw new Error('Local AI Hub received an invalid cloud provider manifest entry.');
  }

  const id = sanitizeManifestId(rawProvider.id);
  const name = String(rawProvider.name || '').trim();
  const authType = String(rawProvider.authType || '').trim().toLowerCase();
  if (!name) {
    throw new Error(`Local AI Hub rejected ${id} because it is missing a provider name.`);
  }

  if (!ALLOWED_AUTH_TYPES.has(authType)) {
    throw new Error(`Local AI Hub rejected ${id} because it uses an unsupported authentication type.`);
  }

  return {
    id,
    name,
    apiEndpoint: assertSecureRemoteUrl(rawProvider.apiEndpoint, `${id} API endpoint`),
    authType,
    modelsEndpoint: normalizeEndpoint(rawProvider.modelsEndpoint, `${id} models endpoint`),
    docsUrl: assertSecureRemoteUrl(rawProvider.docsUrl, `${id} docs URL`),
    configuration: normalizeProviderConfiguration(id, rawProvider.configuration || rawProvider.providerConfiguration || {}),
    pipelineCapabilities: getProviderPipelineCapabilities(id),
  };
}

function resolveProviderUrl(provider, endpoint) {
  const target = String(endpoint || '').trim();
  if (!target) {
    return provider.apiEndpoint;
  }

  if (/^https:\/\//i.test(target)) {
    return assertSecureRemoteUrl(target, `${provider.id} endpoint`);
  }

  const base = provider.apiEndpoint.endsWith('/') ? provider.apiEndpoint : `${provider.apiEndpoint}/`;
  return new URL(target.replace(/^\//, ''), base).toString();
}

async function readSignedProviderManifest() {
  const manifestPath = getBundledProviderManifestPath();
  const signaturePath = getDefaultManifestSignaturePath(manifestPath);
  const rawManifestText = await fs.readFile(manifestPath, 'utf8');
  const rawSignatureText = await fs.readFile(signaturePath, 'utf8');

  if (!verifyManifestSignature(rawManifestText, rawSignatureText)) {
    throw new Error('Local AI Hub rejected the cloud provider catalog because its digital signature could not be verified.');
  }

  const providers = JSON.parse(rawManifestText);
  if (!Array.isArray(providers)) {
    throw new Error('Local AI Hub received an invalid cloud provider manifest payload.');
  }

  return {
    hash: computeManifestDigest(rawManifestText),
    providers: providers.map((provider) => validateProvider(provider)),
  };
}

async function initializeProviderRegistry() {
  if (loadedProviders) {
    return loadedProviders;
  }

  const manifest = await readSignedProviderManifest();
  loadedProviders = manifest.providers;
  manifestStatus = {
    hash: manifest.hash,
    verified: true,
    warning: null,
  };
  return loadedProviders;
}

function getProviderManifest(providerId) {
  return (loadedProviders || []).find((provider) => provider.id === providerId) || null;
}

function getProviderCatalog() {
  return (loadedProviders || []).map((provider) => ({
    id: provider.id,
    name: provider.name,
    apiEndpoint: provider.apiEndpoint,
    authType: provider.authType,
    docsUrl: provider.docsUrl,
    modelsEndpoint: provider.modelsEndpoint,
    pipelineCapabilities: provider.pipelineCapabilities || null,
  }));
}

function getProviderManifestStatus() {
  return {
    ...manifestStatus,
  };
}

module.exports = {
  getBundledProviderManifestPath,
  getProviderCatalog,
  getProviderManifest,
  getProviderManifestStatus,
  initializeProviderRegistry,
  resolveProviderUrl,
};



