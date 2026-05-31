const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-asset-library-manager');
process.env.APPDATA = TEST_STORAGE_ROOT;
process.env.LOCALAPPDATA = TEST_STORAGE_ROOT;
const originalLoad = Module._load;

Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'home' || name === 'appData' || name === 'userData') {
            return TEST_STORAGE_ROOT;
          }
          if (name === 'exe') {
            return process.execPath;
          }
          return TEST_STORAGE_ROOT;
        },
        isPackaged: false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { ensureStorage, getAppPaths } = require('../electron/services/configService');
const {
  LIBRARY_TYPES,
  PREVIEW_URL_SCHEME,
  createAssetLibrary,
  deleteAssetLibrary,
  getAssetLibraryItemPreview,
  importAssetLibraryItems,
  listAssetLibraries,
  normalizeHexColor,
  removeAssetLibraryItem,
  renameAssetLibrary,
  resolveAssetLibraryFontForUse,
  resolveAssetLibraryItemFile,
  resolveAssetLibraryPreviewFile,
  resolveAssetLibraryPreviewRequest,
  resolveColorPaletteItemForUse,
  updateColorPaletteItem,
  validateImportExtension,
} = require('../electron/services/assetLibraryService');

function createWaveBuffer(durationSeconds = 1, sampleRate = 8000) {
  const channelCount = 1;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const frameCount = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = frameCount * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function assertRejectsPlainly(fn, pattern, label) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      throw new Error(label + ' should have failed.');
    })
    .catch((error) => {
      assert(pattern.test(error.message), label + ' failed with the wrong message: ' + error.message);
    });
}

async function verifyLibraryLifecycle() {
  for (const type of ['soundEffects', 'fonts', 'colorPalettes']) {
    const created = await createAssetLibrary(type, 'Shared Assets');
    assert(created.library.id, 'Expected created ' + type + ' library to have an id.');
    assert.strictEqual(created.library.name, 'Shared Assets');
    const duplicate = await createAssetLibrary(type, 'Shared Assets');
    assert.strictEqual(duplicate.library.name, 'Shared Assets (2)', 'Expected duplicate ' + type + ' names to be made safe.');
    const listed = await listAssetLibraries(type);
    assert(listed.some((library) => library.id === created.library.id), 'Expected list to include created ' + type + ' library.');
    const renamed = await renameAssetLibrary(type, created.library.id, 'Renamed Assets');
    assert.strictEqual(renamed.library.name, 'Renamed Assets');
    await deleteAssetLibrary(type, duplicate.library.id);
    const afterDelete = await listAssetLibraries(type);
    assert(!afterDelete.some((library) => library.id === duplicate.library.id), 'Expected deleted ' + type + ' library to disappear.');
  }
}

async function verifyImportsAndColors() {
  const fixturesRoot = path.join(TEST_STORAGE_ROOT, 'fixtures');
  fs.mkdirSync(fixturesRoot, { recursive: true });
  const wavePath = path.join(fixturesRoot, 'click.wav');
  const mp3Path = path.join(fixturesRoot, 'click.mp3');
  const textPath = path.join(fixturesRoot, 'notes.txt');
  const fontPath = path.join(fixturesRoot, 'Inter.otf');
  fs.writeFileSync(wavePath, createWaveBuffer(1.25));
  fs.writeFileSync(mp3Path, Buffer.from('not a real mp3 but extension-validated'));
  fs.writeFileSync(textPath, 'nope');
  fs.writeFileSync(fontPath, Buffer.from('font fixture'));

  assert.strictEqual(validateImportExtension('soundEffects', wavePath), '.wav');
  assert.strictEqual(validateImportExtension('soundEffects', mp3Path), '.mp3');
  assert.throws(() => validateImportExtension('soundEffects', textPath), /only import/i);
  assert.strictEqual(validateImportExtension('fonts', fontPath), '.otf');
  assert.throws(() => validateImportExtension('fonts', wavePath), /only import/i);

  const sounds = await createAssetLibrary('soundEffects', 'Impacts');
  const soundImport = await importAssetLibraryItems('soundEffects', sounds.library.id, [wavePath]);
  assert.strictEqual(soundImport.library.items.length, 1, 'Expected one imported sound.');
  assert.strictEqual(soundImport.library.items[0].extension, '.wav');
  assert.strictEqual(soundImport.library.items[0].sampleRate, 8000);
  assert(soundImport.library.items[0].durationSeconds > 1, 'Expected WAV duration metadata when easy.');
  assert(soundImport.library.items[0].previewUrl.startsWith(PREVIEW_URL_SCHEME + '://asset-library/'), 'Expected sound items to expose a scoped preview URL.');
  assert(!soundImport.library.items[0].previewUrl.includes(TEST_STORAGE_ROOT), 'Expected sound preview URL not to expose a raw local path.');
  const soundPreview = await getAssetLibraryItemPreview('soundEffects', sounds.library.id, soundImport.library.items[0].id);
  assert.strictEqual(soundPreview.previewKind, 'audio');
  assert.strictEqual(soundPreview.mimeType, 'audio/wav');
  const resolvedSoundPreview = await resolveAssetLibraryPreviewRequest(soundPreview.previewUrl);
  assert(resolvedSoundPreview.filePath.startsWith(path.join(getAppPaths().librariesRoot, 'sound-effects')), 'Expected sound preview to resolve inside managed sound libraries.');
  assert.strictEqual(resolvedSoundPreview.item.id, soundImport.library.items[0].id);
  await assertRejectsPlainly(
    () => importAssetLibraryItems('soundEffects', sounds.library.id, [textPath]),
    /only import/i,
    'Unsupported sound import',
  );

  const fonts = await createAssetLibrary('fonts', 'Title Fonts');
  const fontImport = await importAssetLibraryItems('fonts', fonts.library.id, [fontPath]);
  assert.strictEqual(fontImport.library.items.length, 1, 'Expected one imported font.');
  assert.strictEqual(fontImport.library.items[0].extension, '.otf');
  assert(fontImport.library.items[0].previewUrl.startsWith(PREVIEW_URL_SCHEME + '://asset-library/'), 'Expected font items to expose a scoped preview URL.');
  assert(fontImport.library.items[0].fontPreviewFamily.startsWith('LocalAIHubAssetFont-'), 'Expected font items to expose a safe preview font family.');
  assert(!fontImport.library.items[0].previewUrl.includes(TEST_STORAGE_ROOT), 'Expected font preview URL not to expose a raw local path.');
  const fontPreview = await getAssetLibraryItemPreview('fonts', fonts.library.id, fontImport.library.items[0].id);
  assert.strictEqual(fontPreview.previewKind, 'font');
  assert.strictEqual(fontPreview.mimeType, 'font/otf');
  const resolvedFontPreview = await resolveAssetLibraryPreviewRequest(fontPreview.previewUrl);
  assert(resolvedFontPreview.filePath.startsWith(path.join(getAppPaths().librariesRoot, 'fonts')), 'Expected font preview to resolve inside managed font libraries.');
  const resolvedFontForUse = await resolveAssetLibraryFontForUse(fonts.library.id, fontImport.library.items[0].id);
  assert(resolvedFontForUse.filePath.startsWith(path.join(getAppPaths().librariesRoot, 'fonts')), 'Expected runtime font use to resolve inside managed font libraries.');
  assert.strictEqual(resolvedFontForUse.item.id, fontImport.library.items[0].id, 'Expected runtime font resolver to preserve item identity.');
  await assertRejectsPlainly(
    () => importAssetLibraryItems('fonts', fonts.library.id, [wavePath]),
    /only import/i,
    'Unsupported font import',
  );

  assert.strictEqual(normalizeHexColor('abc'), '#AABBCC');
  assert.strictEqual(normalizeHexColor('#22d3ee'), '#22D3EE');
  assert.throws(() => normalizeHexColor('not-a-color'), /valid hex color/i);

  const palette = await createAssetLibrary('colorPalettes', 'Brand');
  const colorOne = await updateColorPaletteItem(palette.library.id, { name: 'Accent', hex: '#22d3ee' });
  assert.strictEqual(colorOne.library.items[0].hex, '#22D3EE');
  const colorTwo = await updateColorPaletteItem(palette.library.id, { name: 'Accent', hex: '#abc' });
  assert(colorTwo.library.items.some((item) => item.name === 'Accent (2)'), 'Expected duplicate color names to be made safe.');
  const resolvedPaletteColor = await resolveColorPaletteItemForUse(palette.library.id, colorOne.library.items[0].id);
  assert.strictEqual(resolvedPaletteColor.item.hex, '#22D3EE', 'Expected runtime palette resolver to return normalized hex.');
  await assertRejectsPlainly(
    () => updateColorPaletteItem(palette.library.id, { name: 'Broken', hex: 'nope' }),
    /valid hex color/i,
    'Invalid palette color',
  );
}

async function verifyPathSafetyAndManifestRecovery() {
  const paths = getAppPaths();
  const outsideFile = path.join(paths.librariesRoot, 'outside-keep.txt');
  fs.writeFileSync(outsideFile, 'keep me');
  await assertRejectsPlainly(
    () => deleteAssetLibrary('soundEffects', '../outside-keep'),
    /invalid library identifier|outside/i,
    'Traversal library delete',
  );
  assert(fs.existsSync(outsideFile), 'Library delete traversal attempt should not remove outside files.');
  await assertRejectsPlainly(
    () => resolveAssetLibraryPreviewRequest(PREVIEW_URL_SCHEME + '://asset-library/soundEffects/../outside-keep/item'),
    /invalid library identifier|outside|preview URL/i,
    'Traversal preview request',
  );
  await assertRejectsPlainly(
    () => resolveAssetLibraryPreviewRequest('file:///C:/Windows/win.ini'),
    /unknown asset preview URL/i,
    'Raw file preview request',
  );

  const soundLibrary = await createAssetLibrary('soundEffects', 'Safety');
  const libraryDir = path.join(paths.librariesRoot, 'sound-effects', soundLibrary.library.id);
  const manifestPath = path.join(libraryDir, 'manifest.json');
  const manifest = readJson(manifestPath);
  manifest.items = [{ id: 'unsafe-item', displayName: 'Unsafe', managedFilename: '..\\..\\outside-keep.txt', managedPath: '..\\..\\outside-keep.txt', extension: '.wav' }];
  writeJson(manifestPath, manifest);
  await removeAssetLibraryItem('soundEffects', soundLibrary.library.id, 'unsafe-item');
  assert(fs.existsSync(outsideFile), 'Item removal traversal attempt should not remove outside files.');

  const fontLibrary = await createAssetLibrary('fonts', 'Runtime Safety');
  const fontLibraryDir = path.join(paths.librariesRoot, 'fonts', fontLibrary.library.id);
  const fontManifestPath = path.join(fontLibraryDir, 'manifest.json');
  const fontManifest = readJson(fontManifestPath);
  fontManifest.items = [{ id: 'unsafe-font', displayName: 'Unsafe Font', managedFilename: '..\\..\\outside-keep.ttf', managedPath: '..\\..\\outside-keep.ttf', extension: '.ttf', type: 'font' }];
  writeJson(fontManifestPath, fontManifest);
  await assertRejectsPlainly(
    () => resolveAssetLibraryFontForUse(fontLibrary.library.id, 'unsafe-font'),
    /outside the managed asset library folder|could not find/i,
    'Runtime font traversal resolve',
  );
  assert(fs.existsSync(outsideFile), 'Runtime font traversal attempt should not touch outside files.');

  const corruptDir = path.join(paths.librariesRoot, 'sound-effects', 'corrupt-manifest');
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'manifest.json'), '{ broken json', 'utf8');
  const missingDir = path.join(paths.librariesRoot, 'sound-effects', 'missing-manifest');
  fs.mkdirSync(missingDir, { recursive: true });
  const listed = await listAssetLibraries('soundEffects');
  assert.strictEqual(listed.find((library) => library.id === 'corrupt-manifest').manifestStatus, 'corrupt');
  assert.strictEqual(listed.find((library) => library.id === 'missing-manifest').manifestStatus, 'missing');
}

function verifySurfaceArea() {
  assert.deepStrictEqual(Object.keys(LIBRARY_TYPES).sort(), ['colorPalettes', 'fonts', 'soundEffects'].sort());
  const preloadSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'preload.js'), 'utf8');
  for (const methodName of [
    'listAssetLibraries',
    'createAssetLibrary',
    'renameAssetLibrary',
    'deleteAssetLibrary',
    'getAssetLibraryItemPreview',
    'importAssetLibraryItems',
    'removeAssetLibraryItem',
    'updateColorPaletteItem',
  ]) {
    assert(preloadSource.includes(methodName), 'Expected preload to expose ' + methodName + '.');
  }

  const uiSource = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'AssetLibraryManager.jsx'), 'utf8');
  for (const label of ['Sound Effects', 'Fonts', 'Color Palettes']) {
    assert(uiSource.includes(label), 'Expected UI tab for ' + label + '.');
  }
  assert(uiSource.includes('new Audio'), 'Expected Sound Effects preview to use a local audio element.');
  assert(uiSource.includes('stopSoundPreview'), 'Expected the UI to stop sound previews when needed.');
  assert(uiSource.includes('@font-face'), 'Expected Fonts preview to render imported fonts with scoped font faces.');
  assert(uiSource.includes('The quick brown fox jumps over 13 lazy dogs.'), 'Expected fixed font preview sample text.');
  assert(!/Transition Presets|Prompt Snippets|promptSnippets|transitionPresets/.test(uiSource), 'Expected no transition preset or prompt snippet library UI.');
  const serviceSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'services', 'assetLibraryService.js'), 'utf8');
  assert(!/transitionPresets|promptSnippets/.test(serviceSource), 'Expected no transition preset or prompt snippet library service type.');
}

async function main() {
  fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
  await ensureStorage();
  await verifyLibraryLifecycle();
  await verifyImportsAndColors();
  await verifyPathSafetyAndManifestRecovery();
  verifySurfaceArea();
  console.log('Asset Library Manager verification passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
