const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const {
  BUILT_IN_TEMPLATES,
  PROJECT_ENTRY_FILE,
  PROJECT_MANIFEST_FILE,
  PROJECT_SCHEMA_VERSION,
  buildHyperFramesProjectPipelineDraft,
  createHyperFramesProject,
  deleteHyperFramesProject,
  duplicateHyperFramesProject,
  getHyperFramesProjectsRoot,
  getTemplateResourcesRoot,
  inspectHyperFramesProject,
  listHyperFramesProjectTemplates,
  listHyperFramesProjects,
  openHyperFramesProjectFolder,
  prepareHyperFramesProjectForPipeline,
  renameHyperFramesProject,
  validateTemplate,
} = require('../electron/services/hyperFramesProjectService');
const { assertTrustedCompositionArtifact } = require('../electron/services/hyperFramesRenderService');

async function main() {
  const managedRoot = path.join(__dirname, '..', 'temp', 'verify-hyperframes-projects-managed-root');
  await fs.remove(managedRoot);
  const options = { managedRoot };
  const projectsRoot = getHyperFramesProjectsRoot(options);

  assert.strictEqual(projectsRoot, path.join(managedRoot, 'projects', 'hyperframes'), 'projects live under managed projects root');
  assert(!projectsRoot.includes(path.join('tools', 'hyperframes')), 'projects are not stored under the HyperFrames runtime tool folder');

  const templateList = await listHyperFramesProjectTemplates();
  assert.strictEqual(templateList.templates.length, 3, 'three starter templates are exposed');
  assert.deepStrictEqual(templateList.templates.map((template) => template.id), BUILT_IN_TEMPLATES.map((template) => template.id), 'template ids match service constants');

  const templateRoot = getTemplateResourcesRoot();
  for (const template of templateList.templates) {
    const templateDir = path.join(templateRoot, template.id);
    assert(await fs.pathExists(path.join(templateDir, PROJECT_ENTRY_FILE)), `${template.id} has exact index.html`);
    assert(await fs.pathExists(path.join(templateDir, 'styles.css')), `${template.id} has local CSS`);
    assert(await fs.pathExists(path.join(templateDir, 'script.js')), `${template.id} has local JS`);
    assert(await fs.pathExists(path.join(templateDir, 'README.md')), `${template.id} has README`);
    assert(await fs.pathExists(path.join(templateDir, 'assets')), `${template.id} has assets directory`);
    await validateTemplate(template.id);
    const texts = ['index.html', 'styles.css', 'script.js'].map((fileName) => fs.readFileSync(path.join(templateDir, fileName), 'utf8')).join('\n');
    assert(!/https?:\/\//i.test(texts), `${template.id} has no remote references`);
    assert(!/\bdata:/i.test(texts), `${template.id} has no data URLs`);
    assert(!/node_modules|<script[^>]+src=["'](?!\.\/)/i.test(texts), `${template.id} does not depend on external packages`);
  }

  const created = await createHyperFramesProject({ templateId: 'animated-title-card', displayName: 'Smoke Title' }, options);
  assert(created.project.projectId && created.project.projectId !== created.project.displayName, 'project id is stable and separate from display name');
  assert.strictEqual(created.project.health.runnable, true, 'created project is runnable');
  assert.strictEqual(created.project.localAssetsOnly, true, 'created project is local-only');

  const projectDir = path.join(projectsRoot, created.project.projectId);
  const manifest = await fs.readJson(path.join(projectDir, PROJECT_MANIFEST_FILE));
  assert.strictEqual(manifest.schemaVersion, PROJECT_SCHEMA_VERSION, 'manifest schema is versioned');
  assert.strictEqual(manifest.projectId, created.project.projectId, 'manifest project id matches folder');
  assert.strictEqual(manifest.entryFile, PROJECT_ENTRY_FILE, 'manifest entry is exact index.html');
  assert.strictEqual(manifest.localAssetsOnly, true, 'manifest declares local assets only');
  assert.strictEqual(manifest.appCreated, true, 'manifest has app-created marker');
  assert(!Object.prototype.hasOwnProperty.call(manifest, 'filePath'), 'manifest does not store raw paths');
  assert(!Object.prototype.hasOwnProperty.call(manifest, 'command'), 'manifest does not store commands');

  const prepared = await prepareHyperFramesProjectForPipeline(created.project.projectId, options);
  assert.strictEqual(prepared.artifact.kind, 'file', 'project input emits a file artifact');
  assert.strictEqual(path.basename(prepared.artifact.filePath), PROJECT_ENTRY_FILE, 'project input emits index.html');
  assert.strictEqual(prepared.artifact.hyperFramesProject.projectId, created.project.projectId, 'artifact keeps project provenance');
  const trusted = assertTrustedCompositionArtifact({ artifact: prepared.artifact, sourceNode: { type: 'hyperframesProjectInput' } }, { allowDirectLocalIndexHtmlArtifact: false });
  assert.strictEqual(trusted.filePath, prepared.artifact.filePath, 'render trust gate accepts managed project input artifact');

  const renamed = await renameHyperFramesProject(created.project.projectId, 'Renamed Title', options);
  assert.strictEqual(renamed.project.projectId, created.project.projectId, 'rename preserves project id');
  assert.strictEqual(renamed.project.displayName, 'Renamed Title', 'rename updates display name');

  const duplicated = await duplicateHyperFramesProject(created.project.projectId, 'Renamed Title Copy', options);
  assert.notStrictEqual(duplicated.project.projectId, created.project.projectId, 'duplicate creates a new id');
  assert.strictEqual(duplicated.project.health.runnable, true, 'duplicate is runnable');
  assert(await fs.pathExists(path.join(projectsRoot, duplicated.project.projectId, PROJECT_ENTRY_FILE)), 'duplicate has independent copied files');

  let openedPath = '';
  const opened = await openHyperFramesProjectFolder(created.project.projectId, async (targetPath) => {
    openedPath = targetPath;
    return '';
  }, options);
  assert.strictEqual(opened.projectId, created.project.projectId, 'open-folder resolves by project id');
  assert.strictEqual(openedPath, projectDir, 'open-folder uses the managed project path');

  const draft = await buildHyperFramesProjectPipelineDraft(created.project.projectId, options);
  assert.strictEqual(draft.pipeline.nodes.map((node) => node.type).join('>'), 'hyperframesProjectInput>hyperframesRender>videoOutput', 'draft has project input, render, and output nodes');
  assert.strictEqual(draft.pipeline.edges.length, 2, 'draft connects the three nodes');
  assert.strictEqual(draft.pipeline.nodes[0].config.projectId, created.project.projectId, 'draft stores project id, not a path');

  const list = await listHyperFramesProjects(options);
  assert(list.projects.some((project) => project.projectId === created.project.projectId), 'created project appears in list');
  assert(list.projects.every((project) => !project.projectPath && !project.filePath), 'list does not expose raw filesystem paths');

  const remote = await createHyperFramesProject({ templateId: 'lower-third-caption', displayName: 'Remote Fixture' }, options);
  await fs.appendFile(path.join(projectsRoot, remote.project.projectId, 'script.js'), '\nconst bad = "https://example.invalid/asset.png";\n', 'utf8');
  const remoteInspection = await inspectHyperFramesProject(remote.project.projectId, options);
  assert.strictEqual(remoteInspection.health.runnable, false, 'remote reference fixture is not runnable');
  assert.strictEqual(remoteInspection.health.status, 'remote-references', 'remote reference fixture is rejected as remote');

  const malformedDir = path.join(projectsRoot, 'malformed-project');
  await fs.ensureDir(malformedDir);
  await fs.writeFile(path.join(malformedDir, PROJECT_MANIFEST_FILE), '{not-json', 'utf8');
  const malformed = await inspectHyperFramesProject('malformed-project', options);
  assert.strictEqual(malformed.health.runnable, false, 'malformed project is inspectable but not runnable');
  assert.strictEqual(malformed.health.status, 'malformed-manifest', 'malformed manifest health is explicit');

  const deleted = await deleteHyperFramesProject(duplicated.project.projectId, options);
  assert.strictEqual(deleted.deletedProjectId, duplicated.project.projectId, 'delete reports project id');
  assert(!(await fs.pathExists(path.join(projectsRoot, duplicated.project.projectId))), 'delete removes only selected project root');
  assert(await fs.pathExists(path.join(projectsRoot, created.project.projectId)), 'delete leaves sibling project intact');

  await fs.remove(managedRoot);
  console.log('verify-hyperframes-projects: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
