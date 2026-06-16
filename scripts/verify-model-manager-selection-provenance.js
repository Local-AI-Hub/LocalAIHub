const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const modelService = require('../electron/services/modelService');

const {
  buildExpectedDownloadIdentity,
  resolveModelDestination,
  writeModelMetadata,
} = modelService._test;

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function assertIncludes(source, needle, label) {
  assert(source.includes(needle), label || `Expected source to include ${needle}`);
}

function assertMatches(source, pattern, label) {
  assert(pattern.test(source), label || `Expected source to match ${pattern}`);
}

function verifyStaticUxCoverage() {
  const ui = read('src/components/ModelManager.jsx');
  const service = read('electron/services/modelService.js');
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');

  assertIncludes(ui, 'Source: {sourceLabel}', 'Model cards should show the provider/source label.');
  assertIncludes(ui, 'Version: {versionLabel}', 'Model cards should show a version label.');
  assertIncludes(ui, 'License: {licenseLabel}', 'Model cards should show the license/provenance label.');
  assertIncludes(ui, 'Model page', 'Model cards should offer a source model-page action.');
  assertIncludes(ui, 'Artifact file', 'Model cards should offer a selected artifact link when available.');
  assertIncludes(ui, 'selectedArtifactMap', 'Model Manager should track explicit artifact/version selections.');
  assertIncludes(ui, 'buildSelectedCatalogItem', 'Downloads should be derived from the selected artifact payload.');
  assertIncludes(ui, 'artifactChoices.length > 1', 'Multiple compatible artifacts should render as a picker.');
  assertIncludes(ui, 'onArtifactChange', 'Artifact picker changes should update selected download identity.');
  assertIncludes(ui, 'Destination conflict', 'Same-destination conflicts should have a dedicated UI panel.');
  assertIncludes(ui, 'Choose another artifact or version above', 'Conflict UI should direct users to resolve by changing selection.');
  assertIncludes(ui, 'Refresh inventory', 'Conflict UI should let users refresh local inventory.');
  assert(!ui.includes('Overwrite existing'), 'Conflict UI must not offer overwrite as an unsafe shortcut.');

  assertIncludes(main, "models:open-source-link", 'Main process should expose a source-link IPC.');
  assertMatches(main, /sanitizeModelSourceUrl\(payload\?\.url\)/, 'Main process should sanitize source links before shell.openExternal.');
  assertIncludes(preload, 'openModelSourceLink', 'Preload should expose the safe source-link action.');
  assertIncludes(service, 'function sanitizeModelSourceUrl', 'Model service should centralize source-link sanitization.');
  assertIncludes(service, 'buildHuggingFaceArtifactChoice', 'Hugging Face catalog results should carry artifact choices.');
  assertIncludes(service, 'buildCivitaiArtifactChoice', 'CivitAI catalog results should carry artifact choices.');
  assertIncludes(service, 'buildOllamaArtifactChoices', 'Ollama catalog results should carry tag/version choices.');
  assertIncludes(service, 'dedupeArtifactChoices([', 'Catalog result builders should dedupe artifact choices.');
}

function verifySafeSourceLinks() {
  const sanitize = modelService.sanitizeModelSourceUrl;
  assert.strictEqual(typeof sanitize, 'function', 'sanitizeModelSourceUrl should be exported for IPC and verification.');
  assert.strictEqual(sanitize('https://huggingface.co/user/model#readme'), 'https://huggingface.co/user/model', 'Trusted Hugging Face model pages should be allowed and stripped of hash fragments.');
  assert.strictEqual(sanitize('https://civitai.com/models/123?modelVersionId=456'), 'https://civitai.com/models/123?modelVersionId=456', 'Trusted CivitAI model pages should be allowed.');
  assert.strictEqual(sanitize('https://ollama.com/library/llama3'), 'https://ollama.com/library/llama3', 'Trusted Ollama library pages should be allowed.');
  assert.strictEqual(sanitize('javascript:alert(1)'), null, 'JavaScript URLs must be rejected.');
  assert.strictEqual(sanitize('file:///C:/Users/Dell/model.safetensors'), null, 'Local file URLs must be rejected.');
  assert.strictEqual(sanitize('http://huggingface.co/user/model'), null, 'Non-HTTPS provider links must be rejected.');
  assert.strictEqual(sanitize('https://evil.example/model'), null, 'Untrusted hosts must be rejected.');
}

function tempTool(root) {
  return {
    id: 'comfyui',
    name: 'ComfyUI',
    appDir: root,
    installDir: root,
    status: 'stopped',
    modelManager: {
      enabled: true,
      targetLayout: {
        basePath: 'app-dir',
        directories: {
          Checkpoint: 'models/checkpoints',
        },
      },
    },
  };
}

function remotePayload(id, repositoryId, artifactPath, fileName = 'model.safetensors') {
  return {
    id,
    catalogRepositoryId: repositoryId,
    downloadUrl: `https://huggingface.co/${repositoryId}/resolve/main/${artifactPath}`,
    fileName,
    installRelativePath: fileName,
    modelType: 'Checkpoint',
    name: repositoryId,
    sizeBytes: 4,
    source: 'huggingface',
    sourceArtifactPath: artifactPath,
  };
}

async function verifySelectionIdentityAndConflicts() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-selection-'));
  try {
    const tool = tempTool(root);
    const first = remotePayload('hf:first', 'publisher/first', 'fp16/model.safetensors');
    const second = remotePayload('hf:second', 'publisher/second', 'fp16/model.safetensors');
    const alternateArtifact = remotePayload('hf:first-alt', 'publisher/first', 'ema/model.safetensors');

    const firstDestination = resolveModelDestination(tool, first);
    const firstIdentity = buildExpectedDownloadIdentity(tool, first, firstDestination);
    const secondIdentity = buildExpectedDownloadIdentity(tool, second, resolveModelDestination(tool, second));
    const alternateIdentity = buildExpectedDownloadIdentity(tool, alternateArtifact, resolveModelDestination(tool, alternateArtifact));

    assert.notStrictEqual(firstIdentity, secondIdentity, 'Different repositories with the same filename need different source identities.');
    assert.notStrictEqual(firstIdentity, alternateIdentity, 'Different selected artifacts in one repository need different source identities.');

    await fs.outputFile(firstDestination.destinationPath, 'data');
    await writeModelMetadata(firstDestination.destinationPath, {
      downloadIdentity: firstIdentity,
      fileName: firstDestination.fileName,
      installRelativePath: firstDestination.installRelativePath,
      modelType: 'Checkpoint',
      source: 'huggingface',
      toolId: tool.id,
    });

    await assert.rejects(
      () => modelService.downloadModel(tool, second),
      /different model named model\.safetensors.*will not overwrite or relabel/i,
      'Same destination with a different source identity should produce the conflict message used by the UI.',
    );
  } finally {
    await fs.remove(root).catch(() => null);
  }
}

async function main() {
  verifyStaticUxCoverage();
  verifySafeSourceLinks();
  await verifySelectionIdentityAndConflicts();
  console.log('Model Manager selection and provenance verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


