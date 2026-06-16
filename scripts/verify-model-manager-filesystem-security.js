const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const modelService = require('../electron/services/modelService');
const pathSafety = require('../electron/services/pathSafetyService');

const {
  assertSafeModelOperationPath,
  sanitizeModelPreviewUrl,
  streamDownloadToFile,
  walkDirectoryFiles,
} = modelService._test;

function responseFromBytes(bytes, headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(bytes));
      controller.close();
    },
  }), { status: 200, headers });
}

async function expectRejectsWith(promise, pattern, label) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert(error, `${label} should reject.`);
  assert.match(String(error.message || error), pattern, label);
}

async function createDirectoryLink(target, link) {
  await fs.remove(link).catch(() => null);
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    console.warn('Symlink/junction fixture could not be created on this machine; reparse-specific assertions were skipped:', error.message);
    return false;
  }
}

function modelTool(root) {
  return {
    id: 'security-fixture',
    name: 'Security Fixture',
    appDir: root,
    installDir: root,
    modelManager: {
      enabled: true,
      targetLayout: {
        basePath: 'app-dir',
        directories: {
          Checkpoint: '.',
        },
      },
    },
  };
}

async function verifyRealpathContainment() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-realpath-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-outside-'));
  const originalFetch = global.fetch;
  try {
    const inside = path.join(root, 'model.safetensors');
    await fs.outputFile(inside, 'model');
    assert.strictEqual(await assertSafeModelOperationPath(root, inside), path.resolve(inside), 'Normal inside-root path should pass realpath containment.');

    if (process.platform === 'win32') {
      assert(pathSafety.isPathInside(root.toUpperCase(), inside.toLowerCase()), 'Windows containment should be case-insensitive.');
    }

    await expectRejectsWith(
      assertSafeModelOperationPath(root, path.join(root, '..', 'escape.safetensors')),
      /outside|refused/i,
      'Lexical traversal outside the root',
    );

    const outsideModel = path.join(outside, 'escaped.safetensors');
    await fs.outputFile(outsideModel, 'outside');
    const linkPath = path.join(root, 'linked-outside');
    const linkCreated = await createDirectoryLink(outside, linkPath);
    if (linkCreated) {
      const linkedModel = path.join(linkPath, 'escaped.safetensors');
      await expectRejectsWith(
        assertSafeModelOperationPath(root, linkedModel),
        /symlink|junction|outside|refused/i,
        'Reparse path pointing outside root',
      );

      await expectRejectsWith(
        modelService.deleteModel(modelTool(root), { modelType: 'Checkpoint', path: linkedModel, fileName: 'escaped.safetensors' }),
        /symlink|junction|outside|refused/i,
        'Destructive model deletion through a reparse path',
      );
      assert.strictEqual(await fs.readFile(outsideModel, 'utf8'), 'outside', 'Delete rejection must not touch the outside target.');

      global.fetch = async () => responseFromBytes('data', { 'content-length': '4' });
      await expectRejectsWith(
        streamDownloadToFile('https://example.test/model.safetensors', path.join(linkPath, 'downloaded.safetensors'), { safeRoot: root, expectedBytes: 4, displayName: 'downloaded.safetensors' }),
        /symlink|junction|outside|refused/i,
        'Download finalization through a reparse path',
      );
      assert.strictEqual(await fs.pathExists(path.join(outside, 'downloaded.safetensors')), false, 'Rejected finalization must not write outside the model root.');
    }
  } finally {
    global.fetch = originalFetch;
    await fs.remove(root).catch(() => null);
    await fs.remove(outside).catch(() => null);
  }
}

async function verifyBoundedScans() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-mm-scan-'));
  try {
    await fs.outputFile(path.join(root, 'valid.safetensors'), 'ok');
    await fs.outputFile(path.join(root, 'partial.safetensors.download'), 'partial');
    await fs.outputFile(path.join(root, 'cache.tmp'), 'temp');
    let files = await walkDirectoryFiles(root);
    assert(files.some((file) => path.basename(file) === 'valid.safetensors'), 'Ordinary model files should still be found.');
    assert(!files.some((file) => /\.download$|\.tmp$/i.test(path.basename(file))), 'Temp and partial artifacts should be ignored.');

    const deepDir = path.join(root, 'a', 'b', 'c');
    await fs.outputFile(path.join(deepDir, 'deep.safetensors'), 'deep');
    files = await walkDirectoryFiles(root, { maxDepth: 1 });
    assert(!files.some((file) => path.basename(file) === 'deep.safetensors'), 'Scan should stop at the configured max depth.');
    assert((files.scanWarnings || []).some((warning) => /depth 1/i.test(warning)), 'Max-depth scan should report a plain warning.');

    for (let index = 0; index < 8; index += 1) {
      await fs.outputFile(path.join(root, `many-${index}.safetensors`), 'x');
    }
    files = await walkDirectoryFiles(root, { maxEntries: 3 });
    assert((files.scanWarnings || []).some((warning) => /3 files and folders/i.test(warning)), 'Max-entry scan should report a plain warning.');

    const loopLink = path.join(root, 'loop');
    const linkCreated = await createDirectoryLink(root, loopLink);
    if (linkCreated) {
      files = await walkDirectoryFiles(root, { maxDepth: 4, maxEntries: 100 });
      assert((files.scanWarnings || []).some((warning) => /symlink|junction|loop/i.test(warning)), 'Scan should skip symlink or junction loops with a warning.');
      assert(files.length < 20, 'Scan should not recurse through a loop.');
    }

    const originalReaddir = fs.readdir;
    fs.readdir = async function patchedReaddir(targetPath, options) {
      if (String(targetPath).endsWith('unreadable-fixture')) {
        const error = new Error('access denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalReaddir.call(this, targetPath, options);
    };
    try {
      await fs.ensureDir(path.join(root, 'unreadable-fixture'));
      files = await walkDirectoryFiles(root);
      assert((files.scanWarnings || []).some((warning) => /could not read/i.test(warning)), 'Unreadable folders should not crash scans and should warn.');
    } finally {
      fs.readdir = originalReaddir;
    }
  } finally {
    await fs.remove(root).catch(() => null);
  }
}

function verifyPreviewSanitizer() {
  assert.strictEqual(sanitizeModelPreviewUrl('https://image.civitai.com/x/y.jpeg'), 'https://image.civitai.com/x/y.jpeg', 'CivitAI CDN preview should be accepted.');
  assert.strictEqual(sanitizeModelPreviewUrl('https://huggingface.co/user/repo/resolve/main/preview.png'), 'https://huggingface.co/user/repo/resolve/main/preview.png', 'Hugging Face preview should be accepted.');
  assert.strictEqual(sanitizeModelPreviewUrl('file:///C:/Users/Dell/secret.png'), null, 'file previews must be rejected.');
  assert.strictEqual(sanitizeModelPreviewUrl('javascript:alert(1)'), null, 'javascript previews must be rejected.');
  assert.strictEqual(sanitizeModelPreviewUrl('data:image/png;base64,AAAA'), null, 'data previews must be rejected.');
  assert.strictEqual(sanitizeModelPreviewUrl('blob:https://huggingface.co/id'), null, 'blob previews must be rejected.');
  assert.strictEqual(sanitizeModelPreviewUrl('https://unknown.example/preview.png'), null, 'Unknown preview hosts should be rejected.');
  assert.strictEqual(sanitizeModelPreviewUrl('not a url'), null, 'Invalid preview URLs should safely fall back.');

  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelManager.jsx'), 'utf8');
  assert(rendererSource.includes('isSafeModelPreviewUrl'), 'Model Manager renderer should include a preview URL safety check.');
  assert(rendererSource.includes('src={safePreviewUrl}'), 'Model Manager should render only the sanitized preview URL.');
  assert(!rendererSource.includes('src={item.previewUrl}'), 'Model Manager should not render raw provider preview URLs.');
}

async function main() {
  await verifyRealpathContainment();
  await verifyBoundedScans();
  verifyPreviewSanitizer();
  console.log('Model Manager filesystem security verifier passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

