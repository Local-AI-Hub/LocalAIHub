const fs = require('fs');
const Module = require('module');
const path = require('path');

const fakeSecrets = new Map();
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'keytar') {
    return {
      async deletePassword(service, account) {
        fakeSecrets.delete(`${service}:${account}`);
        return true;
      },
      async getPassword(service, account) {
        return fakeSecrets.get(`${service}:${account}`) || null;
      },
      async setPassword(service, account, value) {
        fakeSecrets.set(`${service}:${account}`, String(value || ''));
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertSecretAbsent(value, secrets, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    assert(!text.includes(secret), `${label} exposed a secret value.`);
  }
}

(async () => {
  const savedSecret = 'lah_saved_secret_value_for_verifier_0000000000';
  const envSecret = 'lah_env_secret_value_for_verifier_1111111111111';
  const otherEnvSecret = 'lah_other_env_secret_for_verifier_2222222222';
  const secrets = [savedSecret, envSecret, otherEnvSecret];

  const credentialService = require('../electron/services/credentialService');
  const redactionService = require('../electron/services/redactionService');

  delete process.env.OPENAI_API_KEY;
  await credentialService.setProviderSecret('openai', savedSecret);
  let credential = await credentialService.resolveProviderCredential('openai');
  assert(credential.credentialSource === 'saved', 'Saved provider credential was not selected when no env var was present.');
  assert(credential.apiKey === savedSecret, 'Saved provider credential did not resolve through the shared resolver.');

  process.env.OPENAI_API_KEY = envSecret;
  credential = await credentialService.resolveProviderCredential('openai');
  assert(credential.credentialSource === 'environment', 'Environment provider credential did not take precedence.');
  assert(credential.envVarName === 'OPENAI_API_KEY', 'Environment provider credential did not report its variable name.');
  assert(credential.apiKey === envSecret, 'Environment provider credential did not resolve through the shared resolver.');

  const providerService = require('../electron/services/providerService');
  const providers = await providerService.listProviderConnections();
  const openai = providers.find((provider) => provider.id === 'openai');
  assert(openai, 'OpenAI provider summary was not returned.');
  assert(openai.credentialSource === 'environment', 'Provider summary did not show environment credential source.');
  assert(openai.credentialStatusLabel === 'Using environment variable: OPENAI_API_KEY', 'Provider summary did not show the safe env-var label.');
  assertSecretAbsent(openai, secrets, 'Provider summary');

  delete process.env.OPENAI_API_KEY;
  await credentialService.setProviderSecret('openai', '');
  credential = await credentialService.resolveProviderCredential('openai');
  assert(credential.credentialSource === 'missing', 'Missing provider credential did not report missing source.');
  assert(!credential.apiKey, 'Missing provider credential returned a value.');

  process.env.CIVITAI_API_KEY = otherEnvSecret;
  const modelSecrets = await credentialService.readModelManagerSecrets();
  assert(modelSecrets.civitaiCredentialSource === 'environment', 'CivitAI env credential source was not detected.');
  assert(modelSecrets.civitaiApiKey === otherEnvSecret, 'CivitAI env credential did not resolve.');

  const redacted = redactionService.redactSensitiveText(
    `Authorization: Bearer ${envSecret} x-api-key=${savedSecret} https://example.test?api_key=${otherEnvSecret}`,
    { additionalSecrets: [savedSecret] },
  );
  assertSecretAbsent(redacted, secrets, 'Redacted text');
  assert(redacted.includes('[redacted]'), 'Representative secrets were not redacted.');

  const aiderSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'aiderService.js'), 'utf8');
  assert(aiderSource.includes('resolveProviderCredential'), 'Aider is not using the shared credential resolver.');
  assert(!aiderSource.includes('getProviderSecret(provider.id)'), 'Aider still reads provider secrets directly.');

  const pipelineSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'pipelineExecutionService.js'), 'utf8');
  assert(pipelineSource.includes('chatWithProvider') && pipelineSource.includes('runProviderOperation'), 'Pipeline provider paths do not use providerService.');

  console.log('Provider credential security verifier passed. No verifier secret values were printed.');
})().catch((error) => {
  console.error(error.message || 'Provider credential security verifier failed.');
  process.exitCode = 1;
});
