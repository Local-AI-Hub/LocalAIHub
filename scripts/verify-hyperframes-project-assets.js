const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const managedRoot = path.join(repoRoot, 'temp', 'verify-hyperframes-project-assets-root');
const fixtureRoot = path.join(repoRoot, 'temp', 'verify-hyperframes-project-assets-fixtures');

const service = require('../electron/services/hyperFramesProjectService');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

async function assertRejects(fn, pattern, label) {
  let rejected = false;
  try {
    await fn();
  } catch (error) {
    rejected = true;
    assert(pattern.test(String(error && error.message || error)), `${label} rejected with unexpected message: ${error && error.message}`);
  }
  assert(rejected, `${label} should reject.`);
}

async function main() {
  await fs.remove(managedRoot);
  await fs.remove(fixtureRoot);
  await fs.ensureDir(fixtureRoot);
  const options = { managedRoot };
  const created = await service.createHyperFramesProject({ templateId: 'lower-third-caption', displayName: 'Asset Verify' }, options);
  const projectId = created.project.projectId;
  const projectDir = path.join(service.getHyperFramesProjectsRoot(options), projectId);
  const assetsDir = path.join(projectDir, 'assets');

  const pngPath = path.join(fixtureRoot, 'sample.png');
  const jpgPath = path.join(fixtureRoot, 'photo.jpg');
  const wavPath = path.join(fixtureRoot, 'tone.wav');
  const fontPath = path.join(fixtureRoot, 'font.woff2');
  const exePath = path.join(fixtureRoot, 'tool.exe');
  await fs.writeFile(pngPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await fs.writeFile(jpgPath, Buffer.from([255, 216, 255, 217]));
  await fs.writeFile(wavPath, Buffer.from('RIFFfakeWAVE'));
  await fs.writeFile(fontPath, Buffer.from('font'));
  await fs.writeFile(exePath, Buffer.from('MZ'));

  const firstImport = await service.importHyperFramesProjectAssets(projectId, { sourceFiles: [pngPath, jpgPath, wavPath, fontPath] }, options);
  assert.strictEqual(firstImport.assets.length, 4, 'supported local assets import');
  assert(firstImport.assets.every((asset) => asset.reference.startsWith('assets/')), 'asset references are project-relative assets paths');
  assert(firstImport.assets.every((asset) => !path.isAbsolute(asset.reference)), 'asset references never expose absolute source paths');
  assert(await fs.pathExists(path.join(assetsDir, 'sample.png')), 'asset copy lands inside project assets folder');

  const duplicateImport = await service.importHyperFramesProjectAssets(projectId, { sourceFiles: [pngPath] }, options);
  assert.strictEqual(duplicateImport.assets[0].reference, 'assets/sample (2).png', 'duplicate asset filename gets deterministic safe suffix');
  assert(await fs.pathExists(path.join(assetsDir, 'sample (2).png')), 'duplicate asset copy is not an overwrite');

  await assertRejects(() => service.importHyperFramesProjectAssets(projectId, { sourceFiles: [exePath] }, options), /asset types|copy only/i, 'unsupported executable asset');
  await assertRejects(() => service.importHyperFramesProjectAssets(projectId, { sourceFiles: [pngPath], targetSubfolder: '..' }, options), /traversal|assets folder|outside|dot or space/i, 'asset target traversal');
  await assertRejects(() => service.importHyperFramesProjectAssets(projectId, { sourceFiles: [path.join(fixtureRoot, 'missing.png')] }, options), /find/i, 'missing source asset');

  const assetList = await service.listHyperFramesProjectAssets(projectId, options);
  const fileAssets = assetList.assets.filter((asset) => asset.kind === 'file');
  assert(fileAssets.length >= 5, 'asset browser lists copied files');
  assert(fileAssets.every((asset) => asset.relativePath.startsWith('assets/')), 'asset browser is scoped to assets folder');
  assert(fileAssets.every((asset) => !asset.relativePath.includes('..')), 'asset browser exposes safe relative paths only');

  const reference = service.getHyperFramesProjectAssetReference('assets/sample.png');
  assert.strictEqual(reference.reference, 'assets/sample.png', 'asset reference generation is stable and local-relative');
  await assertRejects(() => service.getHyperFramesProjectAssetReference('../sample.png'), /traversal|assets folder|outside|dot or space/i, 'asset reference traversal');

  await service.renameHyperFramesProjectAsset(projectId, 'assets/photo.jpg', 'renamed-photo.jpg', options);
  assert(await fs.pathExists(path.join(assetsDir, 'renamed-photo.jpg')), 'asset rename stays inside assets folder');
  await service.duplicateHyperFramesProjectAsset(projectId, 'assets/renamed-photo.jpg', '', options);
  assert(await fs.pathExists(path.join(assetsDir, 'renamed-photo copy.jpg')), 'asset duplicate stays inside assets folder');
  await service.deleteHyperFramesProjectAsset(projectId, 'assets/renamed-photo copy.jpg', options);
  assert(!(await fs.pathExists(path.join(assetsDir, 'renamed-photo copy.jpg'))), 'asset delete removes scoped asset file');
  await assertRejects(() => service.deleteHyperFramesProjectAsset(projectId, '../outside.png', options), /traversal|assets folder|outside|dot or space/i, 'asset delete escape');
  await assertRejects(() => service.renameHyperFramesProjectAsset(projectId, 'assets/sample.png', 'CON.png', options), /reserved/i, 'asset reserved filename');

  const health = await service.getHyperFramesProjectHealth(projectId, options);
  assert.strictEqual(health.runnable, true, 'supported local assets keep project healthy');
  await fs.writeFile(path.join(assetsDir, 'unsupported.bat'), 'echo bad', 'utf8');
  const unhealthy = await service.getHyperFramesProjectHealth(projectId, options);
  assert.strictEqual(unhealthy.runnable, false, 'unsupported asset extensions show in health');
  assert(unhealthy.unsupportedAssets.includes('assets/unsupported.bat'), 'health reports unsupported asset by relative path only');

  const mainSource = read('electron/main.js');
  const preloadSource = read('electron/preload.js');
  const uiSource = read('src/components/HyperFramesProjectEditor.jsx');
  assert(mainSource.includes("hyperframes-projects:pick-assets") && mainSource.includes('dialog.showOpenDialog') && mainSource.includes('importHyperFramesProjectAssets(projectId'), 'asset import uses main-process picker and immediate managed copy');
  assert(preloadSource.includes('pickHyperFramesProjectAssets') && !preloadSource.includes('importHyperFramesProjectAssets'), 'preload exposes picker/copy, not arbitrary source import');
  assert(uiSource.includes('pickHyperFramesProjectAssets') && !uiSource.includes('showOpenDialog'), 'renderer routes asset import through main-process picker');
  assert(!uiSource.includes('<iframe') && !uiSource.includes('<webview') && !uiSource.includes('HyperFrames Studio'), 'asset browser adds no preview iframe/webview or embedded Studio UI');

  await fs.remove(managedRoot);
  await fs.remove(fixtureRoot);
  console.log('verify-hyperframes-project-assets: ok');
}

main().catch(async (error) => {
  await fs.remove(managedRoot).catch(() => null);
  await fs.remove(fixtureRoot).catch(() => null);
  console.error(error);
  process.exit(1);
});
