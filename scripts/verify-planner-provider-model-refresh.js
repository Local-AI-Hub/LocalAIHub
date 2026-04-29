const assert = require('assert');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-planner-provider-model-refresh');

const providers = {
  google: {
    id: 'google',
    name: 'Google (Gemini)',
    apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
    authType: 'x-goog-api-key',
    modelsEndpoint: '/models',
    configuration: {
      protocol: 'google-gemini',
      preferredModelPrefixes: ['models/gemini-2.5-flash', 'models/gemini-2.5-pro', 'models/gemini-2.0-flash'],
      blockedModelPatterns: ['embedding', 'imagen', 'veo', 'aqa', 'tts'],
      maxOutputTokens: 1024,
    },
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    apiEndpoint: 'https://api.groq.com/openai/v1',
    authType: 'bearer',
    modelsEndpoint: '/models',
    configuration: {
      protocol: 'openai-compatible',
      preferredModelPrefixes: ['openai/gpt-oss', 'llama-3.3', 'llama-3.1'],
      blockedModelPatterns: ['whisper', 'tts', 'playai', 'vision-preview'],
      maxOutputTokens: 1024,
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'home' || name === 'appData') return TEST_STORAGE_ROOT;
          if (name === 'exe') return process.execPath;
          return process.cwd();
        },
        isPackaged: false,
      },
    };
  }

  if (normalizedParent.endsWith('/electron/services/providerService.js')) {
    if (request === './configService') {
      return {
        ensureStorage: async () => { const fs = require('fs'); fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true }); return { root: TEST_STORAGE_ROOT }; },
        humanizeError: (error, fallback) => (error?.message ? fallback + ' ' + error.message : fallback),
      };
    }
    if (request === './credentialService') {
      return {
        maskSecret: () => '***',
        resolveProviderCredential: async () => ({ apiKey: 'test-key', credentialSource: 'saved' }),
        setProviderSecret: async () => {},
      };
    }
    if (request === './logService') {
      return { createLogger: () => ({ warn: async () => {}, info: async () => {} }) };
    }
    if (request === './providerRegistry') {
      return {
        getProviderCatalog: () => Object.values(providers),
        getProviderManifest: (providerId) => providers[providerId] || null,
        initializeProviderRegistry: async () => {},
        resolveProviderUrl: (provider, endpoint) => provider.apiEndpoint + endpoint,
      };
    }
    if (request === './redactionService') {
      return { redactSensitiveText: (value) => String(value || '').replace(/test-key/g, '[redacted]') };
    }
  }

  return originalLoad.call(this, request, parent, isMain);
};

global.fetch = async (url) => {
  const target = String(url || '');
  if (target.includes('generativelanguage.googleapis.com')) {
    return {
      ok: true,
      text: async () => JSON.stringify({
        models: [
          { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash Preview TTS', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/imagen-4.0-generate-preview', displayName: 'Imagen 4', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    };
  }

  if (target.includes('api.groq.com')) {
    return {
      ok: true,
      text: async () => JSON.stringify({
        data: [
          { id: 'playai-tts', owned_by: 'groq' },
          { id: 'whisper-large-v3', owned_by: 'groq' },
          { id: 'llama-3.1-8b-instant', owned_by: 'groq' },
          { id: 'llama-3.3-70b-versatile', owned_by: 'groq' },
        ],
      }),
    };
  }

  throw new Error('Unexpected fetch URL: ' + target);
};

const { PIPELINE_OPERATION_IDS } = require('../electron/shared/pipelineCapabilities.cjs');
const { listProviderModels } = require('../electron/services/providerService');

async function main() {
  const plannerGoogleModels = await listProviderModels({ providerId: 'google', operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT });
  const googleIds = plannerGoogleModels.models.map((model) => model.id);
  assert.strictEqual(googleIds[0], 'models/gemini-2.5-flash', 'Planner text model refresh should surface preferred Gemini 2.5 Flash first.');
  assert(googleIds.includes('models/gemini-2.0-flash'), 'Planner text model refresh should include other Gemini text models.');
  assert(!googleIds.some((id) => /embedding|imagen|tts/i.test(id)), 'Planner text model refresh should filter Google non-text models.');
  assert.strictEqual(plannerGoogleModels.selectedModel, 'models/gemini-2.5-flash', 'Planner refresh should store the canonical Gemini model id as the selected model.');

  const modelStepGoogleModels = await listProviderModels({ providerId: 'google', operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT });
  assert.deepStrictEqual(modelStepGoogleModels.models.map((model) => model.id), googleIds, 'Model Step text refresh should use the same Google model discovery path.');

  const groqModels = await listProviderModels({ providerId: 'groq', operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT });
  const groqIds = groqModels.models.map((model) => model.id);
  assert(groqIds.includes('llama-3.3-70b-versatile'), 'Planner text model refresh should keep existing Groq text models.');
  assert(!groqIds.some((id) => /whisper|tts|playai/i.test(id)), 'Planner text model refresh should filter Groq non-text/audio models.');

  console.log('Planner provider model refresh verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});