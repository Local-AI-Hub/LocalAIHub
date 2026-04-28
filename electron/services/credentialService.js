const keytar = require('keytar');

const { createLogger } = require('./logService');
const { sanitizeManifestId } = require('./pathSafetyService');

const SERVICE_NAME = 'Local AI Hub';
const SECRET_ACCOUNTS = {
  civitaiApiKey: 'model-manager:civitai-api-key',
};

const DEFAULT_PROVIDER_ENV_VARS = {
  anthropic: ['ANTHROPIC_API_KEY'],
  civitai: ['CIVITAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
};

function getProviderEnvVarNames(providerId) {
  const normalizedProviderId = sanitizeManifestId(providerId);
  return [...(DEFAULT_PROVIDER_ENV_VARS[normalizedProviderId] || [])];
}

function readEnvironmentSecret(envVarName) {
  const normalizedName = String(envVarName || '').trim();
  if (!normalizedName) {
    return '';
  }

  const matchedName = Object.keys(process.env).find((key) => key.toLowerCase() === normalizedName.toLowerCase());
  return matchedName ? String(process.env[matchedName] || '').trim() : '';
}

function getAccountName(secretKey) {
  if (SECRET_ACCOUNTS[secretKey]) {
    return SECRET_ACCOUNTS[secretKey];
  }

  if (String(secretKey || '').startsWith('provider:')) {
    const providerId = sanitizeManifestId(String(secretKey).slice('provider:'.length));
    return `provider:${providerId}:api-key`;
  }

  return '';
}

function maskSecret(secretValue) {
  const value = String(secretValue || '').trim();
  if (!value) {
    return '';
  }

  if (value.length <= 8) {
    return `${'*'.repeat(Math.max(0, value.length - 2))}${value.slice(-2)}`;
  }

  return `${value.slice(0, 3)}${'*'.repeat(Math.max(4, value.length - 7))}${value.slice(-4)}`;
}

async function getSecret(secretKey) {
  const logger = createLogger('credentials', {
    secretKey,
  });
  const account = getAccountName(secretKey);
  if (!account) {
    throw new Error('Local AI Hub could not find that secure setting.');
  }

  try {
    return (await keytar.getPassword(SERVICE_NAME, account)) || '';
  } catch (error) {
    await logger.error('Reading a secret from Windows Credential Manager failed.', {
      error,
    });
    throw new Error('Local AI Hub could not read a saved credential from Windows Credential Manager.');
  }
}

async function setSecret(secretKey, secretValue) {
  const logger = createLogger('credentials', {
    secretKey,
  });
  const account = getAccountName(secretKey);
  if (!account) {
    throw new Error('Local AI Hub could not find that secure setting.');
  }

  try {
    const nextValue = String(secretValue || '').trim();
    if (!nextValue) {
      await keytar.deletePassword(SERVICE_NAME, account);
      return '';
    }

    await keytar.setPassword(SERVICE_NAME, account, nextValue);
    return nextValue;
  } catch (error) {
    await logger.error('Writing a secret to Windows Credential Manager failed.', {
      error,
    });
    throw new Error('Local AI Hub could not save that credential into Windows Credential Manager.');
  }
}

async function getProviderSecret(providerId) {
  return getSecret(`provider:${sanitizeManifestId(providerId)}`);
}

async function setProviderSecret(providerId, secretValue) {
  return setSecret(`provider:${sanitizeManifestId(providerId)}`, secretValue);
}

async function resolveProviderCredential(providerId) {
  const normalizedProviderId = sanitizeManifestId(providerId);
  const envVarNames = getProviderEnvVarNames(normalizedProviderId);
  const savedSecret = await getProviderSecret(normalizedProviderId).catch(() => '');
  const hasSavedCredential = Boolean(String(savedSecret || '').trim());

  for (const envVarName of envVarNames) {
    const envValue = readEnvironmentSecret(envVarName);
    if (envValue) {
      return {
        apiKey: envValue,
        credentialSource: 'environment',
        envVarName,
        envVarNames,
        hasEnvCredential: true,
        hasSavedCredential,
      };
    }
  }

  if (hasSavedCredential) {
    return {
      apiKey: String(savedSecret || '').trim(),
      credentialSource: 'saved',
      envVarName: envVarNames[0] || '',
      envVarNames,
      hasEnvCredential: false,
      hasSavedCredential: true,
    };
  }

  return {
    apiKey: '',
    credentialSource: 'missing',
    envVarName: envVarNames[0] || '',
    envVarNames,
    hasEnvCredential: false,
    hasSavedCredential: false,
  };
}

async function hasProviderSecret(providerId) {
  const credential = await resolveProviderCredential(providerId).catch(() => null);
  return Boolean(String(credential?.apiKey || '').trim());
}

async function readModelManagerSecrets() {
  const savedCivitaiApiKey = await getSecret('civitaiApiKey').catch(() => '');
  const envCivitaiApiKey = readEnvironmentSecret('CIVITAI_API_KEY');
  const civitaiApiKey = envCivitaiApiKey || savedCivitaiApiKey;
  return {
    civitaiApiKey,
    civitaiCredentialSource: envCivitaiApiKey ? 'environment' : savedCivitaiApiKey ? 'saved' : 'missing',
    civitaiEnvVarName: 'CIVITAI_API_KEY',
    hasCivitaiApiKey: Boolean(civitaiApiKey),
    hasSavedCivitaiApiKey: Boolean(savedCivitaiApiKey),
  };
}

async function writeModelManagerSecrets(patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, 'civitaiApiKey')) {
    await setSecret('civitaiApiKey', patch.civitaiApiKey);
  }

  return readModelManagerSecrets();
}

async function migrateLegacyModelManagerSecrets(legacySettings = {}) {
  const legacyApiKey = String(legacySettings.civitaiApiKey || '').trim();
  if (!legacyApiKey) {
    return false;
  }

  await writeModelManagerSecrets({
    civitaiApiKey: legacyApiKey,
  });
  return true;
}

function stripModelManagerSecrets(settings = {}) {
  const { civitaiApiKey, ...rest } = settings || {};
  return rest;
}

module.exports = {
  getProviderEnvVarNames,
  getProviderSecret,
  getSecret,
  hasProviderSecret,
  maskSecret,
  migrateLegacyModelManagerSecrets,
  readModelManagerSecrets,
  resolveProviderCredential,
  setProviderSecret,
  setSecret,
  stripModelManagerSecrets,
  writeModelManagerSecrets,
};
