const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  createHyperFramesProject,
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

const GENERATED_FIXTURE = Object.freeze({
  'index.html': `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Generated Local Composition</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="stage" data-composition-id="generatedLocal" data-start="0" data-width="1280" data-height="720" data-duration="3">
    <div class="orb" aria-hidden="true"></div>
    <h1>Local Motion</h1>
    <p>Rendered from editor-saved generated code.</p>
  </main>
  <script>window.__timelines = window.__timelines || {}; window.__timelines.generatedLocal = window.__timelines.generatedLocal || { seek: function (time) { return this; }, totalTime: function (time) { return 3; }, pause: function () { return this; } };</script>
  <script src="./script.js"></script>
</body>
</html>
`,
  'styles.css': `html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #101820; color: #f7fff7; font-family: Arial, sans-serif; }
.stage { position: relative; width: 100vw; height: 100vh; display: grid; place-items: center; text-align: center; }
.stage h1 { position: relative; z-index: 2; margin: 0; font-size: 86px; letter-spacing: 0; }
.stage p { position: absolute; z-index: 2; top: 58%; margin: 0; font-size: 28px; color: #c7f9cc; }
.orb { position: absolute; width: 260px; height: 260px; border-radius: 50%; background: #ff6b35; box-shadow: 0 0 0 28px #2ec4b6; transform: translate(-320px, -90px) scale(0.8); }
`,
  'script.js': `(function () {
  var duration = 3;
  function renderAt(time) {
    var t = Math.max(0, Math.min(duration, Number(time) || 0));
    var phase = t / duration;
    var orb = document.querySelector('.orb');
    var title = document.querySelector('h1');
    var x = -320 + phase * 640;
    var y = -90 + Math.sin(phase * Math.PI * 2) * 130;
    var scale = 0.8 + phase * 0.55;
    orb.style.transform = 'translate(' + x.toFixed(2) + 'px, ' + y.toFixed(2) + 'px) scale(' + scale.toFixed(3) + ')';
    orb.style.background = phase < 0.5 ? '#ff6b35' : '#ffd166';
    title.style.transform = 'translateY(' + Math.sin(phase * Math.PI * 2).toFixed(3) * 34 + 'px)';
    title.style.color = phase < 0.5 ? '#f7fff7' : '#b8f2e6';
  }
  window.__timelines = window.__timelines || {};
  window.__timelines.generatedLocal = {
    seek: function (time) { renderAt(time); return this; },
    totalTime: function (time) { renderAt(time || 0); return duration; },
    pause: function () { return this; }
  };
  renderAt(0);
})();
`,
});

function assertLocalGeneratedFixture() {
  const combined = Object.values(GENERATED_FIXTURE).join('\n');
  assert(!/https?:\/\//i.test(combined), 'fixture has no http/https references');
  assert(!/\bdata:/i.test(combined), 'fixture has no data URL references');
  assert(/totalTime:\s*function\s*\(time\)/.test(combined), 'fixture uses deterministic totalTime(time)');
  assert(/seek:\s*function\s*\(time\)/.test(combined), 'fixture uses seek(time)');
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
  assertLocalGeneratedFixture();
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
    const created = await createHyperFramesProject({ templateId: 'blank', displayName: 'External Generated Code' }, options);
    const projectsRoot = getHyperFramesProjectsRoot(options);
    const projectDir = path.join(projectsRoot, created.project.projectId);
    for (const [relativePath, content] of Object.entries(GENERATED_FIXTURE)) {
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
      displayName: 'External generated workflow verifier',
      runDirectories,
      runtimeContext,
      timeoutMs: 15 * 60 * 1000,
    });
    assert.strictEqual(hashProjectFiles(projectDir), projectHashBefore, 'render does not modify editor-owned generated source project');
    const probe = await probeRenderedMp4(render.outputPath, runtimeContext);
    assert(probe.width > 0 && probe.height > 0 && probe.durationSeconds > 0 && probe.fps > 0, 'external generated code renders a valid MP4');
    const ffmpeg = resolveManagedFfmpegPaths();
    const samples = [0.25, Math.max(0.75, probe.durationSeconds / 2), Math.max(0.5, probe.durationSeconds - 0.35)].map((time) => Math.min(time, Math.max(0.05, probe.durationSeconds - 0.05)));
    const frames = samples.map((time) => sampleFrame(ffmpeg.ffmpegPath, render.outputPath, time, probe.width, probe.height));
    const differences = [meanDiff(frames[0], frames[1]), meanDiff(frames[1], frames[2]), meanDiff(frames[0], frames[2])];
    assert(differences[0] >= 1 && differences[1] >= 1 && Math.max(...differences) >= 2, `external generated composition should visibly change over time: ${JSON.stringify(differences)}`);

    const bad = await createHyperFramesProject({ templateId: 'blank', displayName: 'Invalid Generated Code' }, options);
    await saveHyperFramesProjectTextFile(bad.project.projectId, 'index.html', '<!doctype html><html><body><main data-composition-id="broken" data-start="0" data-width="1280" data-height="720" data-duration="1">Missing timeline registration</main></body></html>', options);
    const badPrepared = await prepareHyperFramesProjectForPipeline(bad.project.projectId, options);
    await assertRejects(
      () => renderHyperFramesComposition({ artifact: badPrepared.artifact, sourceNode: { type: 'hyperframesProjectInput' } }, {
        config: RENDER_CONFIG,
        displayName: 'Invalid generated workflow verifier',
        runDirectories,
        runtimeContext,
        timeoutMs: 2 * 60 * 1000,
      }),
      /HyperFrames lint found a problem|Lint phase|lint/i,
      'invalid generated composition render',
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
