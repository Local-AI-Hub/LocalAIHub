const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const service = require('../electron/services/hyperFramesRenderService');

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeTempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

(async () => {
  const root = makeTempRoot('localaihub-hyperframes-safety');
  try {
    const sourceRoot = path.join(root, 'source');
    const stagedRoot = path.join(root, 'staged');
    const indexPath = path.join(sourceRoot, 'index.html');
    writeFile(indexPath, '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Local</h1><script src="app.js"></script></body></html>');
    writeFile(path.join(sourceRoot, 'style.css'), 'body { font-family: Segoe UI, Arial, sans-serif; }');
    writeFile(path.join(sourceRoot, 'app.js'), 'window.__local = true;');
    writeFile(path.join(sourceRoot, '.cache', 'ignored.js'), 'https://ignored.example.invalid/cache.js');

    const beforeHash = hashFile(indexPath);
    const staged = await service.copyCompositionProjectSafely(sourceRoot, stagedRoot, { maxDepth: 8, maxFiles: 10, maxTotalBytes: 1024 * 1024 });
    assert.strictEqual(staged.fileCount, 3, 'Staging should copy only non-ignored regular files.');
    assert.strictEqual(staged.ignoredEntries.length, 1, 'Staging should ignore safe cache/temp entries.');
    assert(fs.existsSync(path.join(stagedRoot, 'index.html')), 'Staging must copy index.html.');
    assert(fs.existsSync(path.join(stagedRoot, 'style.css')), 'Staging must copy local CSS.');
    assert(!fs.existsSync(path.join(stagedRoot, '.cache', 'ignored.js')), 'Staging must skip ignored cache content.');
    assert.strictEqual(hashFile(indexPath), beforeHash, 'Staging must not modify source index.html.');

    const scan = await service.scanStagedCompositionForRemoteReferences(stagedRoot);
    assert.strictEqual(scan.localOnly, true, 'Local-only scan should pass for local assets.');
    assert(scan.scannedExtensions.includes('.html') && scan.scannedExtensions.includes('.css') && scan.scannedExtensions.includes('.js'), 'Scan should inspect HTML, CSS, and JS.');

    writeFile(path.join(stagedRoot, 'remote.js'), 'fetch("https://example.invalid/data.json")');
    await assert.rejects(
      () => service.scanStagedCompositionForRemoteReferences(stagedRoot),
      (error) => error.message === service.HYPERFRAMES_LOCAL_ASSETS_ERROR && error.code === 'HYPERFRAMES_REMOTE_REFERENCE',
      'Remote references must fail with the required local-assets message.',
    );
    fs.rmSync(path.join(stagedRoot, 'remote.js'), { force: true });
    writeFile(path.join(stagedRoot, 'data.js'), 'const img = "data:image/png;base64,AAAA";');
    await assert.rejects(
      () => service.scanStagedCompositionForRemoteReferences(stagedRoot),
      /local composition assets only/i,
      'Data URLs must fail local-only scanning.',
    );

    await assert.rejects(
      () => service.copyCompositionProjectSafely(sourceRoot, path.join(root, 'limited-files'), { maxDepth: 8, maxFiles: 1, maxTotalBytes: 1024 * 1024 }),
      /more files than the first-version staging limit/i,
      'File count limit must be enforced.',
    );
    await assert.rejects(
      () => service.copyCompositionProjectSafely(sourceRoot, path.join(root, 'limited-size'), { maxDepth: 8, maxFiles: 10, maxTotalBytes: 10 }),
      /larger than the first-version staging limit/i,
      'Total size limit must be enforced.',
    );
    writeFile(path.join(root, 'deep', 'a', 'b', 'c', 'index.html'), '<html></html>');
    await assert.rejects(
      () => service.copyCompositionProjectSafely(path.join(root, 'deep'), path.join(root, 'limited-depth'), { maxDepth: 1, maxFiles: 10, maxTotalBytes: 1024 * 1024 }),
      /deeper than the first-version staging limit/i,
      'Depth limit must be enforced.',
    );

    assert.deepStrictEqual(service.normalizeHyperFramesRenderSettings({ fps: 60, quality: 'high' }), {
      browserGpu: false,
      format: 'mp4',
      fps: 60,
      quality: 'high',
      workers: 1,
    }, 'Settings normalizer must keep fixed workers/GPU/format.');
    assert.throws(() => service.assertSupportedHyperFramesRenderSettings({ fps: 25, quality: 'draft' }), /24, 30, or 60 FPS/, 'Unsupported FPS must be rejected.');
    assert.throws(() => service.assertSupportedHyperFramesRenderSettings({ fps: 30, quality: 'cinema' }), /Draft, Standard, or High/, 'Unsupported quality must be rejected.');

    const trusted = service.assertTrustedCompositionArtifact({
      artifact: { kind: 'file', filePath: indexPath, fileUrl: `file://${indexPath}` },
      sourceNode: { type: 'fileInput' },
    }, { allowDirectLocalIndexHtmlArtifact: false, runDirectories: {} });
    assert.strictEqual(trusted.sourceFileName, 'index.html', 'Trusted artifact must identify index.html.');
    assert.throws(() => service.assertTrustedCompositionArtifact({ artifact: { kind: 'file', filePath: indexPath } }, { runDirectories: {} }), /user-selected File Input artifacts/, 'Untracked raw paths must be rejected.');
    assert.throws(() => service.assertTrustedCompositionArtifact({ artifact: { kind: 'file', filePath: path.join(sourceRoot, 'Index.html') }, sourceNode: { type: 'fileInput' } }, { runDirectories: {} }), /named exactly index.html/, 'Source filename must be exactly index.html.');
    assert.throws(() => service.assertTrustedCompositionArtifact({ artifact: { kind: 'file', filePath: indexPath, fileUrl: 'https://example.invalid/index.html' }, sourceNode: { type: 'fileInput' } }, { runDirectories: {} }), /only accepts local file artifacts/, 'Remote URLs must be rejected at intake.');

    const args = service.buildRenderArgs(stagedRoot, path.join(root, 'out.mp4'), { fps: 30, quality: 'draft' });
    assert.deepStrictEqual(args.slice(0, 2), ['render', '--composition'], 'Render args must start with render and explicit composition.');
    assert(args.includes('--output') && args.includes('--fps') && args.includes('--quality') && args.includes('--format'), 'Render args must include fixed explicit output/fps/quality/format entries.');
    assert(args.includes('--workers') && args.includes('1'), 'Render args must force one worker.');
    assert(args.includes('--no-browser-gpu'), 'Render args must disable browser GPU.');
    assert(!args.includes('--gpu') && !args.includes('--docker') && !args.includes('cloud') && !args.includes('preview'), 'Render args must not enable GPU encoding, Docker, cloud, or preview.');

    const sanitized = service.sanitizeCliText(`Error at ${indexPath}\nfetch https://example.invalid/token?secret=abc\napi_key=abc123`, { sourceRoot });
    assert(!sanitized.includes(indexPath), 'Sanitized CLI output must not include full source paths.');
    assert(!sanitized.includes('https://example.invalid'), 'Sanitized CLI output must not include remote URLs.');
    assert(!sanitized.includes('abc123'), 'Sanitized CLI output must redact credential-like values.');

    const metadata = service.buildHyperFramesRenderMetadata({
      settings: { fps: 30, quality: 'draft' },
      runtimeContext: {
        ffmpegReadiness: { ffmpegVersion: 'ffmpeg version test', ffprobeVersion: 'ffprobe version test' },
        runtime: { nodeVersion: 'v22.18.0' },
      },
      stagingSummary: staged,
      probeSummary: { width: 1920, height: 1080, fps: 30, durationSeconds: 3, sizeBytes: 12345 },
      outputSizeBytes: 12345,
      lintSummary: { code: 0, stdoutTail: '', stderrTail: '' },
      renderSummary: { code: 0, stdoutTail: '', stderrTail: '' },
    });
    assert.strictEqual(metadata.toolId, 'hyperframes', 'Metadata must include tool id.');
    assert.strictEqual(metadata.format, 'mp4', 'Metadata must record fixed MP4 format.');
    assert.strictEqual(metadata.localOnly, true, 'Metadata must record local-only preflight.');
    assert(!JSON.stringify(metadata).includes(sourceRoot), 'Metadata must not contain full source paths.');

    const renderSource = fs.readFileSync(path.join(repoRoot, 'electron/services/hyperFramesRenderService.js'), 'utf8');
    assert(renderSource.includes('fs.lstat'), 'Staging must inspect entries with lstat.');
    assert(renderSource.includes('isReparsePointStats'), 'Staging must reject symlink or junction traversal.');
    assert(renderSource.includes('fs.copyFile'), 'Staging must copy files explicitly instead of modifying the source.');
    assert(renderSource.includes('finally') && renderSource.includes('fs.remove(workRoot)'), 'Render service must clean operation staging on success, failure, timeout, or cancel.');
    assert(renderSource.includes('runHyperFramesCli') && !renderSource.includes('shell: true'), 'Render service must use managed CLI argument arrays, not shell interpolation.');

    console.log('HyperFrames composition safety verifier passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});