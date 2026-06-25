const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH,
  createHyperFramesProject,
  ensureHyperFramesProjectAuthoringRuntime,
  getHyperFramesAuthoringScaffold,
  getHyperFramesProjectsRoot,
  prepareHyperFramesProjectForPipeline,
  saveHyperFramesProjectTextFile,
} = require('../electron/services/hyperFramesProjectService');
const {
  buildHyperFramesLintFailureMessage,
  probeRenderedMp4,
  renderHyperFramesComposition,
} = require('../electron/services/hyperFramesRenderService');
const { getManagedHyperFramesExecutionRuntime } = require('../electron/services/hyperFramesService');
const { resolveManagedFfmpegPaths } = require('../electron/services/managedFfmpegService');

const SMOKE_ROOT = 'D:\\LocalAIHub-HyperFrames-External-Code-Workflow-Smoke';
const DEFAULT_INSTALL_ROOT = 'D:\\LocalAIHub';
const RENDER_CONFIG = Object.freeze({ fps: 30, quality: 'draft', workers: 1, browserGpu: false, format: 'mp4' });

function assertLocalGeneratedFixture(scaffold) {
  assert(scaffold.externalAiPrompt.includes('Target HyperFrames version is 0.6.112.'), 'external-AI prompt names the pinned HyperFrames version');
  assert(scaffold.externalAiPrompt.includes(HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH), 'external-AI prompt names the local runtime path');
  assert(scaffold.externalAiPrompt.includes('Return exactly three file contents: index.html, styles.css, script.js'), 'external-AI prompt requests the three-file workflow');
  assert.deepStrictEqual(scaffold.files.map((file) => file.relativePath), ['index.html', 'styles.css', 'script.js'], 'verified scaffold exposes exactly the three editable files');
  const byPath = Object.fromEntries(scaffold.files.map((file) => [file.relativePath, String(file.content || '')]));
  const combined = Object.values(byPath).join('\n');
  assert(!/https?:\/\//i.test(combined), 'verified scaffold has no http/https references');
  assert(!/\bdata:/i.test(combined), 'verified scaffold has no data URL references');
  assert(!byPath['index.html'].includes('window.__timelines'), 'verified index.html keeps timeline registration in linked script.js');
  assert(byPath['index.html'].indexOf(`./${HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH}`) > -1, 'verified index.html loads the local runtime');
  assert(byPath['index.html'].indexOf(`./${HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH}`) < byPath['index.html'].indexOf('./script.js'), 'verified index.html loads runtime before script.js');
  assert(/data-composition-id="custom-scene"/.test(byPath['index.html']), 'verified index.html uses custom-scene root id');
  assert(/window\.__timelines\s*=\s*window\.__timelines\s*\|\|\s*\{\}/.test(byPath['script.js']), 'verified script initializes timeline registry');
  assert(byPath['script.js'].includes('gsap.timeline({ paused: true })'), 'verified script uses GSAP-style local runtime contract');
  assert(byPath['script.js'].includes('window.__timelines["custom-scene"] = tl'), 'verified script uses a literal matching registry key');
  assert(!/window\.__timelines\[[^"']/.test(byPath['script.js']), 'verified script avoids variable-key registration');
  return byPath;
}

function hashProjectFiles(projectDir) {
  const records = [];
  function visit(currentPath) {
    const stats = fs.lstatSync(currentPath);
    if (stats.isDirectory()) {
      for (const child of fs.readdirSync(currentPath).sort()) visit(path.join(currentPath, child));
      return;
    }
    if (!stats.isFile()) return;
    const buffer = fs.readFileSync(currentPath);
    records.push(path.relative(projectDir, currentPath).replace(/\\/g, '/') + '|' + buffer.length + '|' + crypto.createHash('sha256').update(buffer).digest('hex'));
  }
  visit(projectDir);
  return crypto.createHash('sha256').update(records.sort().join('\n')).digest('hex');
}

function sampleFrame(ffmpegPath, videoPath, timestamp, width, height) {
  const result = spawnSync(ffmpegPath, ['-v', 'error', '-ss', timestamp.toFixed(3), '-i', videoPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
    encoding: 'buffer',
    maxBuffer: width * height * 3 + 1024 * 1024,
  });
  assert.strictEqual(result.status, 0, `FFmpeg frame sampling failed: ${String(result.stderr || '').trim()}`);
  return result.stdout.subarray(0, width * height * 3);
}

function meanDiff(first, second) {
  let total = 0;
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index += 1) total += Math.abs(first[index] - second[index]);
  return total / Math.max(1, length);
}

async function assertRejects(fn, pattern, label) {
  let rejected = false;
  try {
    await fn();
  } catch (error) {
    rejected = true;
    assert(pattern.test(String(error?.message || error)), `${label} rejected with unexpected message: ${error?.message || error}`);
  }
  assert(rejected, `${label} should reject`);
}

function getRuntimeOptions() {
  return fs.existsSync(path.join(DEFAULT_INSTALL_ROOT, 'tools', 'hyperframes', 'runtime'))
    ? { installRoot: DEFAULT_INSTALL_ROOT }
    : {};
}

async function main() {
  const scaffold = getHyperFramesAuthoringScaffold();
  const fixture = assertLocalGeneratedFixture(scaffold);
  await fs.remove(SMOKE_ROOT);
  const options = { managedRoot: SMOKE_ROOT };
  const runDirectories = {
    root: SMOKE_ROOT,
    artifactsDir: path.join(SMOKE_ROOT, 'artifacts'),
    outputsDir: path.join(SMOKE_ROOT, 'outputs'),
  };
  await fs.ensureDir(runDirectories.artifactsDir);
  let success = false;
  try {
    const created = await createHyperFramesProject({ templateId: 'blank', displayName: 'Verified External AI Code' }, options);
    const projectsRoot = getHyperFramesProjectsRoot(options);
    const projectDir = path.join(projectsRoot, created.project.projectId);
    const runtimeCopy = await ensureHyperFramesProjectAuthoringRuntime(created.project.projectId, options);
    assert.strictEqual(runtimeCopy.asset.relativePath, HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH, 'runtime helper copies the managed runtime asset');
    for (const [relativePath, content] of Object.entries(fixture)) {
      const saved = await saveHyperFramesProjectTextFile(created.project.projectId, relativePath, content, options);
      assert.strictEqual(saved.file.relativePath, relativePath, `${relativePath} saved through editor service path`);
    }

    await assertRejects(
      () => saveHyperFramesProjectTextFile(created.project.projectId, 'styles.css', 'body { background: url(https://example.invalid/remote.png); }', options),
      /local project assets|remote http/i,
      'remote generated composition save',
    );

    const prepared = await prepareHyperFramesProjectForPipeline(created.project.projectId, options);
    const projectHashBefore = hashProjectFiles(projectDir);
    const runtimeContext = await getManagedHyperFramesExecutionRuntime({}, getRuntimeOptions());
    const render = await renderHyperFramesComposition({ artifact: prepared.artifact, sourceNode: { type: 'hyperframesProjectInput' } }, {
      config: RENDER_CONFIG,
      displayName: 'Verified external-AI workflow verifier',
      runDirectories,
      runtimeContext,
      timeoutMs: 15 * 60 * 1000,
    });
    assert.strictEqual(hashProjectFiles(projectDir), projectHashBefore, 'render does not modify editor-owned generated source project');
    const probe = await probeRenderedMp4(render.outputPath, runtimeContext);
    assert(probe.width > 0 && probe.height > 0 && probe.durationSeconds > 0 && probe.fps > 0, 'verified external-AI code renders a valid MP4');
    const ffmpeg = resolveManagedFfmpegPaths();
    const samples = [0.25, Math.max(0.75, probe.durationSeconds / 2), Math.max(0.5, probe.durationSeconds - 0.35)].map((time) => Math.min(time, Math.max(0.05, probe.durationSeconds - 0.05)));
    const frames = samples.map((time) => sampleFrame(ffmpeg.ffmpegPath, render.outputPath, time, probe.width, probe.height));
    const differences = [meanDiff(frames[0], frames[1]), meanDiff(frames[1], frames[2]), meanDiff(frames[0], frames[2])];
    assert(differences[0] >= 1 && differences[1] >= 1 && Math.max(...differences) >= 2, `verified external-AI composition should visibly change over time: ${JSON.stringify(differences)}`);

    const bad = await createHyperFramesProject({ templateId: 'blank', displayName: 'Invalid External AI Code' }, options);
    const missingRuntimeIndex = fixture['index.html'].replace(/\n  <script src="\.\/assets\/vendor\/localaihub-gsap-runtime\.js"><\/script>/, '');
    await saveHyperFramesProjectTextFile(bad.project.projectId, 'index.html', missingRuntimeIndex, options);
    await saveHyperFramesProjectTextFile(bad.project.projectId, 'styles.css', fixture['styles.css'], options);
    await saveHyperFramesProjectTextFile(bad.project.projectId, 'script.js', fixture['script.js'], options);
    const badPrepared = await prepareHyperFramesProjectForPipeline(bad.project.projectId, options);
    await assertRejects(
      () => renderHyperFramesComposition({ artifact: badPrepared.artifact, sourceNode: { type: 'hyperframesProjectInput' } }, {
        config: RENDER_CONFIG,
        displayName: 'Invalid external-AI workflow verifier',
        runDirectories,
        runtimeContext,
        timeoutMs: 2 * 60 * 1000,
      }),
      /GSAP|missing_gsap_script|HyperFrames lint found a problem|Lint phase|lint/i,
      'invalid generated composition missing local runtime',
    );
    const syntheticLintMessage = buildHyperFramesLintFailureMessage({ code: 1, stderrTail: 'index.html:12:4 SyntaxError: Unexpected token', stdoutTail: '' });
    assert(/Lint phase: hyperframes lint --json/.test(syntheticLintMessage), 'lint message includes phase');
    assert(/index\.html:12:4|SyntaxError/.test(syntheticLintMessage), 'lint message includes file/line/error detail when available');
    assert(syntheticLintMessage.length < 3500, 'lint detail is bounded');

    success = true;
    console.log(JSON.stringify({
      message: 'verify-hyperframes-external-code-workflow: ok',
      output: { bytes: (await fs.stat(render.outputPath)).size, ...probe },
      sampledTimestamps: samples,
      meanAbsolutePixelDifferences: differences,
    }, null, 2));
  } finally {
    if (success) await fs.remove(SMOKE_ROOT);
  }
}

main().catch(async (error) => {
  await fs.remove(SMOKE_ROOT).catch(() => null);
  console.error(error);
  process.exit(1);
});
