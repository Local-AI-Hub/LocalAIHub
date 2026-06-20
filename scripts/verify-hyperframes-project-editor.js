const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const managedRoot = path.join(repoRoot, 'temp', 'verify-hyperframes-project-editor-root');
const outsideRoot = path.join(repoRoot, 'temp', 'verify-hyperframes-project-editor-outside');

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
  await fs.remove(outsideRoot);
  await fs.ensureDir(outsideRoot);
  const options = { managedRoot };

  const created = await service.createHyperFramesProject({ templateId: 'animated-title-card', displayName: 'Editor Verify' }, options);
  const projectId = created.project.projectId;
  const projectsRoot = service.getHyperFramesProjectsRoot(options);
  const projectDir = path.join(projectsRoot, projectId);

  const editorState = await service.getHyperFramesProjectEditorState(projectId, options);
  assert(editorState.files.some((entry) => entry.relativePath === 'index.html'), 'file browser lists index.html');
  assert(editorState.files.some((entry) => entry.relativePath === 'styles.css'), 'file browser lists styles.css');
  assert(editorState.files.some((entry) => entry.relativePath === 'script.js'), 'file browser lists script.js');
  assert(editorState.files.some((entry) => entry.relativePath === 'README.md'), 'file browser lists README.md');
  assert(editorState.files.some((entry) => entry.relativePath === 'assets' && entry.kind === 'directory'), 'file browser lists assets folder');
  assert(editorState.files.every((entry) => !path.isAbsolute(entry.relativePath) && !/^[a-zA-Z]:/.test(entry.relativePath)), 'file browser exposes relative paths only');
  assert.strictEqual(editorState.health.runnable, true, 'fresh template passes editor health');

  await assertRejects(() => service.getHyperFramesProjectEditorState('missing-project', options), /no longer exists|invalid/i, 'missing project id');
  await assertRejects(() => service.readHyperFramesProjectTextFile(projectId, path.join(projectDir, 'index.html'), options), /relative paths only|invalid|outside/i, 'absolute path read');

  const index = await service.readHyperFramesProjectTextFile(projectId, 'index.html', options);
  assert(index.content.includes('<!doctype html>'), 'text file read returns bounded text content');
  assert(index.sizeBytes <= service.MAX_EDITABLE_TEXT_FILE_BYTES, 'read reports bounded size');

  await fs.writeFile(path.join(projectDir, 'binary.txt'), Buffer.from([0, 1, 2, 3, 0]));
  await assertRejects(() => service.readHyperFramesProjectTextFile(projectId, 'binary.txt', options), /binary/i, 'binary text read');
  await fs.writeFile(path.join(projectDir, 'oversized.txt'), Buffer.alloc(service.MAX_EDITABLE_TEXT_FILE_BYTES + 1, 65));
  await assertRejects(() => service.readHyperFramesProjectTextFile(projectId, 'oversized.txt', options), /larger/i, 'oversized text read');
  await fs.writeFile(path.join(projectDir, 'notes.exe'), 'nope', 'utf8');
  await assertRejects(() => service.readHyperFramesProjectTextFile(projectId, 'notes.exe', options), /can edit/i, 'unsupported text read');

  const saved = await service.saveHyperFramesProjectTextFile(projectId, 'index.html', index.content.replace('HyperFrames Project', 'Editor Verified Project'), options);
  assert(saved.file.content.includes('Editor Verified Project'), 'save updates allowed text file');
  await assertRejects(() => service.saveHyperFramesProjectTextFile(projectId, 'styles.css', 'body{background:url(https://example.com/a.png)}', options), /local project assets|Remote|http/i, 'https save');
  await assertRejects(() => service.saveHyperFramesProjectTextFile(projectId, 'styles.css', 'body{background:url(http://example.com/a.png)}', options), /local project assets|Remote|http/i, 'http save');
  await assertRejects(() => service.saveHyperFramesProjectTextFile(projectId, 'styles.css', 'body{background:url(data:image/png;base64,abc)}', options), /local project assets|data/i, 'data save');
  await assertRejects(() => service.saveHyperFramesProjectTextFile(projectId, 'styles.css', 'body{background:url(..\\..\\escape.png)}', options), /local project assets|escape/i, 'path escape save');
  await assertRejects(() => service.saveHyperFramesProjectTextFile(projectId, '../outside.css', 'body{}', options), /traversal|outside|relative|dot or space/i, 'outside save path');

  await service.createHyperFramesProjectTextFile(projectId, 'notes.txt', 'hello', options);
  assert(await fs.pathExists(path.join(projectDir, 'notes.txt')), 'create text file is project-scoped');
  await service.renameHyperFramesProjectFile(projectId, 'notes.txt', 'notes-renamed.txt', options);
  assert(await fs.pathExists(path.join(projectDir, 'notes-renamed.txt')), 'rename text file is project-scoped');
  await service.duplicateHyperFramesProjectFile(projectId, 'notes-renamed.txt', 'notes-copy.txt', options);
  assert(await fs.pathExists(path.join(projectDir, 'notes-copy.txt')), 'duplicate text file is project-scoped');
  await service.deleteHyperFramesProjectFile(projectId, 'notes-copy.txt', options);
  assert(!(await fs.pathExists(path.join(projectDir, 'notes-copy.txt'))), 'delete text file is project-scoped');
  await assertRejects(() => service.createHyperFramesProjectTextFile(projectId, 'CON.txt', '', options), /reserved/i, 'reserved filename create');
  await assertRejects(() => service.renameHyperFramesProjectFile(projectId, 'notes-renamed.txt', 'bad/name.txt', options), /file name only|separators/i, 'bad filename rename');
  await assertRejects(() => service.deleteHyperFramesProjectFile(projectId, 'index.html', options), /entrypoint|index\.html/i, 'index deletion');
  await assertRejects(() => service.saveHyperFramesProjectTextFile(projectId, 'project.json', '{}', options), /project\.json|can edit/i, 'project manifest edit');

  await fs.writeFile(path.join(projectDir, 'script.js'), 'const bad = "https://example.com/foo.png";\n', 'utf8');
  const unsafeHealth = await service.getHyperFramesProjectHealth(projectId, options);
  assert.strictEqual(unsafeHealth.runnable, false, 'health catches remote references without executing code');
  assert(unsafeHealth.damaged.includes('remote-or-data-reference'), 'health reports local-only failure without source contents');
  await assertRejects(() => service.prepareHyperFramesProjectForPipeline(projectId, options), /local composition assets|not ready|Remote/i, 'render preflight rejects unsafe project');

  const outsideFile = path.join(outsideRoot, 'outside.css');
  await fs.writeFile(outsideFile, 'outside', 'utf8');
  const linkPath = path.join(projectDir, 'linked-outside');
  let symlinkMade = false;
  try {
    await fs.symlink(outsideRoot, linkPath, 'junction');
    symlinkMade = true;
    await assertRejects(() => service.saveHyperFramesProjectTextFile(projectId, 'linked-outside/outside.css', 'body{}', options), /symlink|junction|outside/i, 'reparse traversal save');
    const linkedHealth = await service.getHyperFramesProjectHealth(projectId, options);
    assert.strictEqual(linkedHealth.runnable, false, 'health reports unsafe reparse traversal');
    assert(linkedHealth.unsafePaths.length > 0, 'health includes unsafe path diagnostics without source contents');
  } catch (error) {
    if (symlinkMade) throw error;
    const serviceSource = read('electron/services/hyperFramesProjectService.js');
    assert(serviceSource.includes('assertNoReparsePointTraversal') && serviceSource.includes('assertRealPathInside'), 'service contains reparse containment checks when OS blocks junction fixture');
  }

  const uiSource = read('src/components/HyperFramesProjectEditor.jsx');
  const managerSource = read('src/components/HyperFramesProjectManager.jsx');
  const mainSource = read('electron/main.js');
  const preloadSource = read('electron/preload.js');
  assert(managerSource.includes('This editor works only inside Local AI Hub-managed HyperFrames projects.'), 'UI includes managed-project editor note');
  assert(managerSource.includes('HyperFrames compositions execute HTML/CSS/JavaScript when rendered. Edit and render only projects you trust.'), 'UI includes trusted-code warning');
  assert(managerSource.includes('This version supports local project assets only. Remote http/https/data references are blocked.'), 'UI includes local-only policy note');
  assert(managerSource.includes('Open in HyperFrames Studio (Experimental)'), 'UI includes the experimental restricted Studio action');
  assert(uiSource.includes('<textarea'), 'editor uses a built-in textarea');
  assert(!uiSource.includes('<iframe') && !uiSource.includes('<webview') && !uiSource.includes('Monaco'), 'editor adds no iframe, webview, or Monaco');
  assert(!managerSource.includes('<iframe') && !managerSource.includes('<webview') && !managerSource.includes('Monaco'), 'manager adds no iframe, webview, or Monaco');
  assert(mainSource.includes("hyperframes-projects:editor-state") && preloadSource.includes('getHyperFramesProjectEditorState'), 'editor IPC is exposed through project-scoped bridge');
  assert(!preloadSource.includes('importHyperFramesProjectAssets'), 'renderer is not exposed a direct arbitrary-source asset import method');

  await fs.remove(managedRoot);
  await fs.remove(outsideRoot);
  console.log('verify-hyperframes-project-editor: ok');
}

main().catch(async (error) => {
  await fs.remove(managedRoot).catch(() => null);
  await fs.remove(outsideRoot).catch(() => null);
  console.error(error);
  process.exit(1);
});
