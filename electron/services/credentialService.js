const keytar = require('keytar');

const { createLogger } = require('./logService');
const { sanitizeManifestId } = require('./pathSafetyService');

const SERVICE_NAME = 'Local AI Hub';
const SECRET_ACCOUNTS = {
  civitaiApiKey: 'model-manager:civitai-api-key',
};

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

async function hasProviderSecret(providerId) {
  const secret = await getProviderSecret(providerId).catch(() => '');
  return Boolean(String(secret || '').trim());
}

async function readModelManagerSecrets() {
  const civitaiApiKey = await getSecret('civitaiApiKey').catch(() => '');
  return {
    civitaiApiKey,
    hasCivitaiApiKey: Boolean(civitaiApiKey),
  };
}

async function writeModelManagerSecrets(patch = {}) {
  const result = await readModelManagerSecrets();

  if (Object.prototype.hasOwnProperty.call(patch, 'civitaiApiKey')) {
    const civitaiApiKey = await setSecret('civitaiApiKey', patch.civitaiApiKey);
    result.civitaiApiKey = civitaiApiKey;
    result.hasCivitaiApiKey = Boolean(civitaiApiKey);
  }

  return result;
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
  getProviderSecret,
  getSecret,
  hasProviderSecret,
  maskSecret,
  migrateLegacyModelManagerSecrets,
  readModelManagerSecrets,
  setProviderSecret,
  setSecret,
  stripModelManagerSecrets,
  writeModelManagerSecrets,
};
