const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  BLANK_PROJECT,
  BUILT_IN_TEMPLATES,
  createHyperFramesProject,
  getBlankProjectResourcesDir,
  getHyperFramesProjectEditorState,
  getHyperFramesProjectHealth,
  getHyperFramesProjectsRoot,
  listHyperFramesProjectTemplates,
  prepareHyperFramesProjectForPipeline,
  readHyperFramesProjectTextFile,
  saveHyperFramesProjectTextFile,
} = require('../electron/services/hyperFramesProjectService');
const { probeRenderedMp4, renderHyperFramesComposition } = require('../electron/services/hyperFramesRenderService');
const { getManagedHyperFramesExecutionRuntime } = require('../electron/services/hyperFramesService');
const { resolveManagedFfmpegPaths } = require('../electron/services/managedFfmpegService');

const SMOKE_ROOT = 'D:\\LocalAIHub-HyperFrames-Blank-Project-Smoke';
const INSTALL_ROOT = 'D:\\LocalAIHub';
const CACHE_PATHS = [
  'C:\\Users\\Dell.cache\\hyperframes\\chrome',
  'C:\\Users\\Dell\\.cache\\hyperframes\\chrome',
];
const REQUIRED_FILES = ['project.json', 'index.html', 'styles.css', 'script.js', 'README.md'];
const AUTHORING_RUNTIME = 'assets/vendor/localaihub-gsap-runtime.js';
const SCANNED_LOCAL_ONLY_FILES = ['index.html', 'styles.css', 'script.js', AUTHORING_RUNTIME];

async function snapshot(root) {
  if (!(await fs.pathExists(root))) return { exists: false, files: 0, bytes: 0, digest: '' };
  const rows = [];
  async function visit(current) {
    const stats = await fs.lstat(current);
    const relative = path.relative(root, current).replace(/\\/g, '/');
    rows.push(`${relative}|${stats.isDirectory() ? 'd' : 'f'}|${stats.size}|${Math.round(stats.mtimeMs)}`);
    if (stats.isDirectory()) for (const name of (await fs.readdir(current)).sort()) await visit(path.join(current, name));
  }
  await visit(root);
  return {
    exists: true,
    files: rows.filter((row) => row.includes('|f|')).length,
    bytes: rows.filter((row) => row.includes('|f|')).reduce((sum, row) => sum + Number(row.split('|')[2]), 0),
    digest: crypto.createHash('sha256').update(rows.join('\n')).digest('hex'),
  };
}

function sampleFrame(ffmpegPath, videoPath, timestamp, width, height) {
  const result = spawnSync(ffmpegPath, ['-v', 'error', '-ss', String(timestamp), '-i', videoPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
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

async function main() {
  await fs.remove(SMOKE_ROOT);
  const options = { managedRoot: SMOKE_ROOT };
  const cacheBefore = {};
  for (const cachePath of CACHE_PATHS) cacheBefore[cachePath] = await snapshot(cachePath);
  let success = false;
  try {
    const listed = await listHyperFramesProjectTemplates();
    assert.strictEqual(listed.templates.length, 3, 'the starter template list remains exactly three');
    assert.deepStrictEqual(listed.templates.map((entry) => entry.id), BUILT_IN_TEMPLATES.map((entry) => entry.id), 'starter template identities remain unchanged');
    assert(!listed.templates.some((entry) => entry.id === BLANK_PROJECT.id), 'Blank Project is not presented as a starter template');
    assert.strictEqual(listed.blankProject.id, 'blank', 'Blank Project is a separate first-class creation source');
    assert.strictEqual(listed.blankProject.sourceType, 'blank-scaffold', 'Blank Project reports scaffold provenance');

    const scaffoldRoot = getBlankProjectResourcesDir();
    for (const fileName of REQUIRED_FILES.filter((name) => name !== 'project.json')) {
      assert(await fs.pathExists(path.join(scaffoldRoot, fileName)), `blank scaffold includes ${fileName}`);
    }
    assert(await fs.pathExists(path.join(scaffoldRoot, 'assets')), 'blank scaffold includes assets directory');
    assert(await fs.pathExists(path.join(scaffoldRoot, AUTHORING_RUNTIME)), 'blank scaffold includes the managed local authoring runtime');
    const scaffoldText = (await Promise.all(SCANNED_LOCAL_ONLY_FILES.map((name) => fs.readFile(path.join(scaffoldRoot, name), 'utf8')))).join('\n');
    assert(!/https?:\/\//i.test(scaffoldText), 'blank scaffold contains no remote URL references');
    assert(!/\bdata:/i.test(scaffoldText), 'blank scaffold contains no data URL references');
    const blankIndexSource = await fs.readFile(path.join(scaffoldRoot, 'index.html'), 'utf8');
    const blankScriptSource = await fs.readFile(path.join(scaffoldRoot, 'script.js'), 'utf8');
    assert(!blankIndexSource.includes('window.__timelines'), 'blank scaffold registers timelines from linked script.js only');
    assert(blankIndexSource.indexOf('./assets/vendor/localaihub-gsap-runtime.js') > -1, 'blank index loads the local authoring runtime');
    assert(blankIndexSource.indexOf('./assets/vendor/localaihub-gsap-runtime.js') < blankIndexSource.indexOf('./script.js'), 'blank index loads the local runtime before script.js');
    assert(/data-composition-id="custom-scene"/.test(blankIndexSource), 'blank root uses the verified composition id');
    assert(/window\.__timelines\s*=\s*window\.__timelines\s*\|\|\s*\{\}/.test(blankScriptSource), 'blank linked script initializes the HyperFrames timeline registry');
    assert(blankScriptSource.includes('gsap.timeline({ paused: true })'), 'blank linked script uses the local GSAP-compatible runtime');
    assert(blankScriptSource.includes('window.__timelines["custom-scene"] = tl'), 'blank linked script registers the literal matching timeline id');
    assert(!/window\.__timelines\[[^"']/.test(blankScriptSource), 'blank linked script avoids variable-key timeline registration');
    assert(!/@keyframes|animation\s*:/i.test(scaffoldText), 'blank scaffold does not rely on ordinary CSS animation');

    const first = await createHyperFramesProject({ templateId: 'blank', displayName: 'Blank Verify' }, options);
    const projectsRoot = getHyperFramesProjectsRoot(options);
    const firstDir = path.join(projectsRoot, first.project.projectId);
    await fs.writeFile(path.join(firstDir, 'owner-marker.txt'), 'first project', 'utf8');
    const second = await createHyperFramesProject({ templateId: 'blank', displayName: 'Blank Verify' }, options);
    assert.notStrictEqual(first.project.projectId, second.project.projectId, 'same-name blank creation receives a unique project ID');
    assert.strictEqual(await fs.readFile(path.join(firstDir, 'owner-marker.txt'), 'utf8'), 'first project', 'creating another blank project does not overwrite an existing project');

    const project = second.project;
    const projectDir = path.join(projectsRoot, project.projectId);
    const manifest = await fs.readJson(path.join(projectDir, 'project.json'));
    assert.strictEqual(manifest.templateId, 'blank', 'blank manifest uses canonical templateId');
    assert.strictEqual(manifest.templateVersion, 1, 'blank manifest has a scaffold version');
    assert.strictEqual(manifest.sourceType, 'blank-scaffold', 'blank manifest identifies scaffold origin');
    assert.strictEqual(manifest.localAssetsOnly, true, 'blank manifest is local-assets-only');
    for (const fileName of REQUIRED_FILES) assert(await fs.pathExists(path.join(projectDir, fileName)), `created blank project includes ${fileName}`);
    assert(await fs.pathExists(path.join(projectDir, 'assets')), 'created blank project includes assets directory');
    assert(await fs.pathExists(path.join(projectDir, AUTHORING_RUNTIME)), 'created blank project includes the local authoring runtime');

    const editor = await getHyperFramesProjectEditorState(project.projectId, options);
    for (const editable of ['index.html', 'styles.css', 'script.js']) {
      assert(editor.files.some((entry) => entry.relativePath === editable && entry.editable), `${editable} is editable`);
      const opened = await readHyperFramesProjectTextFile(project.projectId, editable, options);
      assert(opened.content.length > 0, `${editable} opens with scaffold content`);
    }
    const index = await readHyperFramesProjectTextFile(project.projectId, 'index.html', options);
    await saveHyperFramesProjectTextFile(project.projectId, 'index.html', index.content.replace('Your composition', 'Blank project verified'), options);
    const health = await getHyperFramesProjectHealth(project.projectId, options);
    assert.strictEqual(health.runnable, true, 'edited blank project health passes');

    const prepared = await prepareHyperFramesProjectForPipeline(project.projectId, options);
    assert.strictEqual(prepared.artifact.hyperFramesProject.templateId, 'blank', 'Project Input preserves blank provenance');
    assert.strictEqual(prepared.artifact.hyperFramesProject.sourceType, 'blank-scaffold', 'Project Input preserves scaffold source type');

    const runtimeContext = await getManagedHyperFramesExecutionRuntime({}, { installRoot: INSTALL_ROOT });
    const ffmpeg = resolveManagedFfmpegPaths();
    const runDirectories = {
      root: SMOKE_ROOT,
      artifactsDir: path.join(SMOKE_ROOT, 'artifacts'),
      outputsDir: path.join(SMOKE_ROOT, 'outputs'),
    };
    await fs.ensureDir(runDirectories.artifactsDir);
    const render = await renderHyperFramesComposition({ artifact: prepared.artifact, sourceNode: { type: 'hyperframesProjectInput' } }, {
      config: { fps: 30, quality: 'draft', workers: 1, browserGpu: false, format: 'mp4' },
      displayName: 'Blank Project temporal verifier',
      runDirectories,
      runtimeContext,
      timeoutMs: 15 * 60 * 1000,
    });
    const probe = await probeRenderedMp4(render.outputPath, runtimeContext);
    assert(probe.width > 0 && probe.height > 0 && probe.fps > 0 && probe.durationSeconds > 0, 'blank project renders a valid MP4');
    const samples = [0.35, Math.min(2.5, probe.durationSeconds / 2), Math.max(0.5, probe.durationSeconds - 0.5)];
    const frames = samples.map((time) => sampleFrame(ffmpeg.ffmpegPath, render.outputPath, time, probe.width, probe.height));
    const differences = [meanDiff(frames[0], frames[1]), meanDiff(frames[1], frames[2]), meanDiff(frames[0], frames[2])];
    assert(differences[0] >= 1 && differences[1] >= 1 && Math.max(...differences) >= 2, `blank composition must show material deterministic motion: ${JSON.stringify(differences)}`);

    const cacheAfter = {};
    for (const cachePath of CACHE_PATHS) cacheAfter[cachePath] = await snapshot(cachePath);
    assert.deepStrictEqual(cacheAfter, cacheBefore, 'blank render does not change guarded C: HyperFrames caches');
    success = true;
    console.log(JSON.stringify({
      message: 'HyperFrames Blank Project verification passed.',
      project: { templateId: project.templateId, sourceType: project.sourceType, health: health.status },
      output: { bytes: (await fs.stat(render.outputPath)).size, ...probe },
      sampledTimestamps: samples,
      meanAbsolutePixelDifferences: differences,
      guardedCaches: cacheAfter,
    }, null, 2));
  } finally {
    if (success) {
      const resolved = path.resolve(SMOKE_ROOT);
      assert.strictEqual(path.basename(resolved), 'LocalAIHub-HyperFrames-Blank-Project-Smoke', 'cleanup root must be the named smoke directory');
      await fs.remove(resolved);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
