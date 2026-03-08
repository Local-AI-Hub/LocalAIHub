const keytar = require('keytar');

const { createLogger } = require('./logService');

const SERVICE_NAME = 'Local AI Hub';
const SECRET_ACCOUNTS = {
  civitaiApiKey: 'model-manager:civitai-api-key',
};

async function getSecret(secretKey) {
  const logger = createLogger('credentials', {
    secretKey,
  });
  const account = SECRET_ACCOUNTS[secretKey];
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
  const account = SECRET_ACCOUNTS[secretKey];
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
  migrateLegacyModelManagerSecrets,
  readModelManagerSecrets,
  setSecret,
  stripModelManagerSecrets,
  writeModelManagerSecrets,
};
