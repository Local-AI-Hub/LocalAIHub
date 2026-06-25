const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  HYPERFRAMES_AUTHORING_CONTRACT,
  HYPERFRAMES_AUTHORING_RUNTIME_LABEL,
  HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH,
  HYPERFRAMES_EXTERNAL_AI_PROMPT,
  createHyperFramesProject,
  ensureHyperFramesProjectAuthoringRuntime,
  getHyperFramesAuthoringRuntimeSourcePath,
  getHyperFramesAuthoringScaffold,
  getHyperFramesProjectHealth,
  getHyperFramesProjectsRoot,
  prepareHyperFramesProjectForPipeline,
  saveHyperFramesProjectTextFile,
} = require('../electron/services/hyperFramesProjectService');
const { probeRenderedMp4, renderHyperFramesComposition } = require('../electron/services/hyperFramesRenderService');
const {
  buildHyperFramesRuntimePaths,
  detectExternalNodeAndNpm,
  getManagedHyperFramesExecutionRuntime,
} = require('../electron/services/hyperFramesService');
const { resolveManagedFfmpegPaths } = require('../electron/services/managedFfmpegService');
const { runStudioProjectPreflight } = require('../electron/services/hyperFramesStudioService');

const SMOKE_ROOT = 'D:\\LocalAIHub-HyperFrames-Authoring-Kit-Smoke';
const DEFAULT_INSTALL_ROOT = 'D:\\LocalAIHub';
const RENDER_CONFIG = Object.freeze({ fps: 30, quality: 'draft', workers: 1, browserGpu: false, format: 'mp4' });

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

async function cleanupSmokeRoot() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.remove(SMOKE_ROOT);
      return;
    } catch (error) {
      if (attempt === 4) {
        console.warn(`verify-hyperframes-authoring-kit cleanup skipped: ${error.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
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

function assertAuthoringContract(scaffold) {
  assert.strictEqual(HYPERFRAMES_AUTHORING_CONTRACT.targetVersion, '0.6.112', 'authoring contract pins HyperFrames 0.6.112');
  assert.strictEqual(HYPERFRAMES_AUTHORING_CONTRACT.localRuntimePath, HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH, 'contract names the managed local runtime path');
  assert.strictEqual(HYPERFRAMES_AUTHORING_RUNTIME_LABEL, 'Local AI Hub GSAP-compatible runtime', 'runtime label is explicit and not full-GSAP branded');
  assert(HYPERFRAMES_AUTHORING_CONTRACT.timelineRegistry.includes('window.__timelines["custom-scene"] = tl'), 'contract requires literal timeline registry keys');
  assert(HYPERFRAMES_AUTHORING_CONTRACT.gsapStrategy.includes('Remote GSAP/CDN URLs are blocked'), 'contract documents local GSAP strategy');
  assert(HYPERFRAMES_AUTHORING_CONTRACT.localOnly.includes('Remote http, https, data URLs'), 'contract documents the local-only policy');
  assert(HYPERFRAMES_EXTERNAL_AI_PROMPT.includes('Target HyperFrames version is 0.6.112.'), 'prompt pins HyperFrames version');
  assert(HYPERFRAMES_EXTERNAL_AI_PROMPT.includes('Return exactly three file contents: index.html, styles.css, script.js'), 'prompt asks for the narrow three-file workflow');
  assert(HYPERFRAMES_EXTERNAL_AI_PROMPT.includes(HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH), 'prompt names the local runtime asset');
  assert(HYPERFRAMES_EXTERNAL_AI_PROMPT.includes('no http://') && HYPERFRAMES_EXTERNAL_AI_PROMPT.includes('no https://') && HYPERFRAMES_EXTERNAL_AI_PROMPT.includes('no data:'), 'prompt forbids remote/data references');
  assert(HYPERFRAMES_EXTERNAL_AI_PROMPT.includes('Troubleshooting:'), 'prompt includes lint-oriented troubleshooting guidance');
  assert.deepStrictEqual(scaffold.files.map((file) => file.relativePath), ['index.html', 'styles.css', 'script.js'], 'scaffold exports exactly three editable files');
  const byPath = Object.fromEntries(scaffold.files.map((file) => [file.relativePath, String(file.content || '')]));
  const combined = Object.values(byPath).join('\n');
  assert(!/https?:\/\//i.test(combined), 'scaffold files contain no http/https references');
  assert(!/\bdata:/i.test(combined), 'scaffold files contain no data URLs');
  assert(byPath['index.html'].includes(`./${HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH}`), 'scaffold index loads local runtime');
  assert(byPath['index.html'].indexOf(`./${HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH}`) < byPath['index.html'].indexOf('./script.js'), 'scaffold loads runtime before script.js');
  assert(/data-composition-id="custom-scene"/.test(byPath['index.html']), 'scaffold root has matching composition id');
  assert(/data-width="1280"/.test(byPath['index.html']) && /data-height="720"/.test(byPath['index.html']), 'scaffold root declares dimensions');
  assert(/class="clip composition"/.test(byPath['index.html']), 'scaffold includes a clip element for Studio/editability');
  assert(/window\.__timelines\s*=\s*window\.__timelines\s*\|\|\s*\{\}/.test(byPath['script.js']), 'scaffold initializes window.__timelines');
  assert(byPath['script.js'].includes('gsap.timeline({ paused: true })'), 'scaffold uses local GSAP-style runtime');
  assert(byPath['script.js'].includes('window.__timelines["custom-scene"] = tl'), 'scaffold uses literal matching timeline registration');
  assert(!/window\.__timelines\[[^"']/.test(byPath['script.js']), 'scaffold avoids variable-key registration');
  assert(!/(^|[;{\\s])transform\\s*:/im.test(byPath['styles.css']), 'scaffold CSS avoids transform conflicts with GSAP x/y/scale');
  return byPath;
}

async function saveFixture(projectId, fixture, options) {
  for (const [relativePath, content] of Object.entries(fixture)) {
    await saveHyperFramesProjectTextFile(projectId, relativePath, content, options);
  }
}

async function main() {
  const scaffold = getHyperFramesAuthoringScaffold();
  const fixture = assertAuthoringContract(scaffold);
  assert(await fs.pathExists(getHyperFramesAuthoringRuntimeSourcePath()), 'authoring kit runtime source exists');
  const runtimeSource = await fs.readFile(getHyperFramesAuthoringRuntimeSourcePath(), 'utf8');
  assert(runtimeSource.includes('root.gsap') && runtimeSource.includes('root.GreenSock') && runtimeSource.includes('root._gsScope'), 'runtime exposes GSAP lint/runtime markers');
  assert(!/https?:\/\//i.test(runtimeSource) && !/\bdata:/i.test(runtimeSource), 'runtime source is local/offline');

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
    const created = await createHyperFramesProject({ templateId: 'blank', displayName: 'Authoring Kit Verified' }, options);
    const projectsRoot = getHyperFramesProjectsRoot(options);
    const projectDir = path.join(projectsRoot, created.project.projectId);
    const runtimeResult = await ensureHyperFramesProjectAuthoringRuntime(created.project.projectId, options);
    assert.strictEqual(runtimeResult.asset.relativePath, HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH, 'ensure runtime returns the managed runtime relative path');
    assert(await fs.pathExists(path.join(projectDir, HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH)), 'project contains the managed local runtime asset');
    await saveFixture(created.project.projectId, fixture, options);

    await assertRejects(
      () => saveHyperFramesProjectTextFile(created.project.projectId, 'styles.css', 'body{background:url(data:image/png;base64,abc)}', options),
      /local project assets|data/i,
      'authoring kit data URL save',
    );

    const health = await getHyperFramesProjectHealth(created.project.projectId, options);
    assert.strictEqual(health.runnable, true, 'verified scaffold project passes Local AI Hub health');
    const prepared = await prepareHyperFramesProjectForPipeline(created.project.projectId, options);
    const runtimeContext = await getManagedHyperFramesExecutionRuntime({}, getRuntimeOptions());
    const render = await renderHyperFramesComposition({ artifact: prepared.artifact, sourceNode: { type: 'hyperframesProjectInput' } }, {
      config: RENDER_CONFIG,
      displayName: 'HyperFrames authoring kit verifier',
      runDirectories,
      runtimeContext,
      timeoutMs: 15 * 60 * 1000,
    });
    const probe = await probeRenderedMp4(render.outputPath, runtimeContext);
    assert(probe.width === 1280 && probe.height === 720 && probe.durationSeconds > 0, 'authoring scaffold renders at declared dimensions');
    const ffmpeg = resolveManagedFfmpegPaths();
    const samples = [0.3, Math.min(2, probe.durationSeconds / 2), Math.max(0.5, probe.durationSeconds - 0.45)];
    const frames = samples.map((time) => sampleFrame(ffmpeg.ffmpegPath, render.outputPath, time, probe.width, probe.height));
    const differences = [meanDiff(frames[0], frames[1]), meanDiff(frames[1], frames[2]), meanDiff(frames[0], frames[2])];
    assert(differences[0] >= 1 && differences[1] >= 1 && Math.max(...differences) >= 2, `authoring scaffold must visibly change over time: ${JSON.stringify(differences)}`);

    const studioPaths = buildHyperFramesRuntimePaths(getRuntimeOptions());
    const studioRuntime = await detectExternalNodeAndNpm();
    const studioPreflight = await runStudioProjectPreflight(studioPaths, studioRuntime, projectDir, projectDir);
    assert(Number(studioPreflight.lintSummary.code || 0) === 0, 'verified scaffold passes restricted Studio lint preflight');

    const invalidFixtures = [
      {
        label: 'missing root composition attributes',
        files: { ...fixture, 'index.html': '<!doctype html><html><body><p>No composition root</p><script src="./script.js"></script></body></html>' },
        pattern: /composition|data-composition-id|root|lint/i,
      },
      {
        label: 'missing timeline registry',
        files: { ...fixture, 'script.js': '(function () { var tl = gsap.timeline({ paused: true }); tl.to({}, { duration: 4 }, 0); })();' },
        pattern: /window\.__timelines|timeline|registry|lint/i,
      },
      {
        label: 'mismatched timeline id',
        files: { ...fixture, 'script.js': fixture['script.js'].replace('window.__timelines["custom-scene"] = tl', 'window.__timelines["wrong-scene"] = tl') },
        pattern: /custom-scene|wrong-scene|timeline|mismatch|lint/i,
      },
      {
        label: 'missing local runtime script tag',
        files: { ...fixture, 'index.html': fixture['index.html'].replace(/\n  <script src="\.\/assets\/vendor\/localaihub-gsap-runtime\.js"><\/script>/, '') },
        pattern: /GSAP|missing_gsap_script|runtime|lint/i,
      },
    ];

    for (const invalid of invalidFixtures) {
      const bad = await createHyperFramesProject({ templateId: 'blank', displayName: `Invalid ${invalid.label}` }, options);
      const badDir = path.join(projectsRoot, bad.project.projectId);
      await saveFixture(bad.project.projectId, invalid.files, options);
      await assertRejects(
        () => runStudioProjectPreflight(studioPaths, studioRuntime, badDir, badDir),
        invalid.pattern,
        invalid.label,
      );
    }

    success = true;
    console.log(JSON.stringify({
      message: 'verify-hyperframes-authoring-kit: ok',
      output: { bytes: (await fs.stat(render.outputPath)).size, ...probe },
      sampledTimestamps: samples,
      meanAbsolutePixelDifferences: differences,
      studioLintCode: studioPreflight.lintSummary.code,
      runtimeAsset: HYPERFRAMES_AUTHORING_RUNTIME_RELATIVE_PATH,
    }, null, 2));
  } finally {
    if (success) await cleanupSmokeRoot();
  }
}

main().catch(async (error) => {
  await cleanupSmokeRoot().catch(() => null);
  console.error(error);
  process.exit(1);
});
