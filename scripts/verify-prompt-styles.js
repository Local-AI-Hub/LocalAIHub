const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const promptStyles = require('../electron/shared/promptStyles.cjs');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-prompt-styles');

function loadConfigServiceWithTempRoot() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath(name) {
            if (name === 'home' || name === 'appData') return TEST_STORAGE_ROOT;
            if (name === 'exe') return process.execPath;
            return TEST_STORAGE_ROOT;
          },
          isPackaged: false,
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = path.resolve(__dirname, '../electron/services/configService.js');
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

async function verifyPromptStyleHelper() {
  const animeStyle = promptStyles.normalizePromptStylePreset({
    id: 'style-anime',
    name: 'Anime Test',
    targetKind: 'image',
    requiredTerms: ['anime film still', 'hand-painted background', 'soft sunlight'],
    negativePrompt: 'photorealistic, 3d render',
    placement: 'suffix',
  });

  const applied = promptStyles.applyPromptStyleToPrompt('A cat beside a window', animeStyle, {
    negativePrompt: 'low quality, 3D   render',
    supportNegativePrompt: true,
    targetKind: 'image',
  });
  assert(applied.finalPrompt.includes('anime film still'), 'Expected helper to append missing required term.');
  assert(applied.finalPrompt.includes('hand-painted background'), 'Expected helper to append every missing required term.');
  assert.strictEqual(applied.finalNegativePrompt, 'low quality, 3D render, photorealistic', 'Expected helper to dedupe negative terms case-insensitively and with normalized spaces.');

  const duplicate = promptStyles.applyPromptStyleToPrompt('anime film still, a cat', animeStyle, { targetKind: 'image' });
  assert.strictEqual((duplicate.finalPrompt.match(/anime film still/g) || []).length, 1, 'Expected helper not to duplicate existing required terms.');
  assert(duplicate.skippedDuplicateTerms.includes('anime film still'), 'Expected duplicate required terms to be reported.');

  const prefixStyle = promptStyles.normalizePromptStylePreset({ name: 'Prefix', targetKind: 'audio', requiredTerms: 'cinematic orchestral', placement: 'prefix' });
  const prefixApplied = promptStyles.applyPromptStyleToPrompt('dark ambient cue', prefixStyle, { targetKind: 'audio' });
  assert(prefixApplied.finalPrompt.startsWith('cinematic orchestral'), 'Expected prefix placement to put required terms before the prompt.');

  assert(promptStyles.isPromptStyleCompatibleWithTarget(animeStyle, 'image'), 'Expected image style to be compatible with image.');
  assert(!promptStyles.isPromptStyleCompatibleWithTarget(animeStyle, 'audio'), 'Expected image style to be incompatible with audio.');
  assert(promptStyles.isPromptStyleCompatibleWithTarget({ targetKind: 'any' }, 'video'), 'Expected any style to be compatible with video.');
}

async function verifyConfigPersistence() {
  fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
  const configService = loadConfigServiceWithTempRoot();
  await configService.ensureStorage();

  let styles = await configService.listPromptStyles();
  assert.deepStrictEqual(styles, [], 'Expected prompt styles to default to an empty list.');

  let config = await configService.upsertPromptStyle({
    id: 'style-music',
    name: 'Cinematic Music',
    targetKind: 'audio',
    requiredTerms: ['cinematic orchestral', 'dark ambient'],
  });
  assert.strictEqual(config.promptStyles.length, 1, 'Expected config to persist one prompt style.');
  assert.strictEqual(config.promptStyles[0].targetKind, 'audio', 'Expected target kind to persist.');

  config = await configService.upsertPromptStyle({
    ...config.promptStyles[0],
    requiredTerms: ['cinematic orchestral', 'dark ambient', 'no vocals'],
  });
  assert.strictEqual(config.promptStyles[0].requiredTerms.length, 3, 'Expected update to replace the saved prompt style.');

  await configService.deletePromptStyle('style-music');
  styles = await configService.listPromptStyles();
  assert.deepStrictEqual(styles, [], 'Expected prompt style deletion to persist.');
}

async function main() {
  await verifyPromptStyleHelper();
  await verifyConfigPersistence();
  console.log('Prompt style verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
