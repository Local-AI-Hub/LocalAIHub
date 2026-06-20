const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const esbuild = require('esbuild');
const React = require('react');
const ReactDOMServer = require('react-dom/server');

const repoRoot = path.resolve(__dirname, '..');
const tempRoot = path.join(repoRoot, 'temp', 'verify-hyperframes-projects-ui');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

async function bundleManager() {
  await fs.remove(tempRoot);
  await fs.ensureDir(tempRoot);
  const outfile = path.join(tempRoot, 'HyperFramesProjectManager.cjs');
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src', 'components', 'HyperFramesProjectManager.jsx')],
    bundle: true,
    external: ['react'],
    format: 'cjs',
    outfile,
    platform: 'node',
    sourcemap: false,
  });
  return require(outfile);
}

async function main() {
  const pipelineSource = read('src/components/PipelineBuilderPanel.jsx');
  const managerSource = read('src/components/HyperFramesProjectManager.jsx');
  const mainSource = read('electron/main.js');
  const preloadSource = read('electron/preload.js');
  const serviceSource = read('electron/services/hyperFramesProjectService.js');
  const editorSource = read('src/components/HyperFramesProjectEditor.jsx');
  const assetLibrarySource = read('src/components/AssetLibraryManager.jsx');
  const promptStylesSource = read('src/components/PromptStylePresetManager.jsx');

  assert(pipelineSource.includes("const HyperFramesProjectManager = React.lazy(() => import('./HyperFramesProjectManager'));"), 'PipelineBuilderPanel must define the lazy HyperFramesProjectManager import.');
  assert(pipelineSource.includes('class HyperFramesProjectsErrorBoundary'), 'HyperFrames Projects must have a local render boundary.');
  assert(pipelineSource.includes('HyperFramesProjectsErrorBoundary') && pipelineSource.includes('onRetry={() => setHyperFramesProjectsPanelRetryKey'), 'Local boundary must expose retry.');
  assert(pipelineSource.includes('data-pipeline-resource-section="hyperframes-projects"'), 'Resources subview must contain HyperFrames Projects.');
  assert(pipelineSource.includes("toggleSection('hyperFramesProjects')"), 'HyperFrames Projects section must be expandable.');
  assert(pipelineSource.includes('key={hyperFramesProjectsPanelRetryKey}'), 'Retry must remount the project manager.');
  assert(pipelineSource.includes('const [hyperFramesProjects, setHyperFramesProjects] = useState([]);'), 'PipelineBuilderPanel must define HyperFrames Projects state before wiring onProjectsChanged.');
  assert(pipelineSource.includes('normalizeHyperFramesProjectsForPipelineSelector'), 'PipelineBuilderPanel must normalize project rows used by the pipeline selector.');
  assert(pipelineSource.includes('setHyperFramesProjects(normalizeHyperFramesProjectsForPipelineSelector(result.data?.projects));'), 'PipelineBuilderPanel must not store raw project-list rows for rendering.');
  assert(!pipelineSource.includes('<HyperFramesProjectManager') || pipelineSource.includes('const HyperFramesProjectManager'), 'The project manager JSX must not reference an undefined identifier.');
  assert(!pipelineSource.includes('onProjectsChanged={setHyperFramesProjects}') || pipelineSource.includes('const [hyperFramesProjects, setHyperFramesProjects] = useState([]);'), 'The onProjectsChanged callback must not reference an undefined setter.');

  assert(managerSource.includes('normalizeHyperFramesProjectsForUi'), 'Project responses must be normalized before render.');
  assert(managerSource.includes('normalizeHyperFramesTemplatesForUi'), 'Template responses must be normalized before render.');
  assert(managerSource.includes('normalizeHyperFramesBlankProjectForUi'), 'Blank Project metadata must be normalized separately from starter templates.');
  assert(managerSource.includes('<optgroup label="Starter templates">') && managerSource.includes('{blankProject ? <option'), 'Blank Project must be first-class without appearing inside the starter template group.');
  assert(managerSource.includes('Open in HyperFrames Studio (Experimental)'), 'Restricted Studio prototype must remain clearly experimental.');
  assert(!managerSource.includes('<iframe') && !managerSource.includes('<webview'), 'Project manager must not embed HyperFrames Studio.');
  assert(managerSource.includes('HyperFrames projects could not load.'), 'Project-list failures must render an inline error state.');
  assert(managerSource.includes('Retry'), 'Inline project errors must include retry.');
  assert(managerSource.includes('No HyperFrames projects yet.'), 'Empty project list must render the intended empty state.');
  assert(managerSource.includes('Open Editor'), 'Project manager exposes the safe editor action.');
  assert(managerSource.includes('This editor works only inside Local AI Hub-managed HyperFrames projects.'), 'Project manager includes editor scope note.');
  assert(editorSource.includes('<textarea'), 'Project editor uses a simple textarea editor.');
  assert(managerSource.includes("getApiMethod('listHyperFramesProjects'"), 'Missing preload list method must be handled explicitly.');
  assert(!managerSource.includes('filePath:') && !managerSource.includes('folderPath:'), 'Renderer project actions must not submit arbitrary paths.');
  assert(!editorSource.includes('filePath:') && !editorSource.includes('folderPath:'), 'Editor renderer actions must not submit arbitrary paths.');
  for (const actionName of ['renameHyperFramesProject', 'duplicateHyperFramesProject', 'deleteHyperFramesProject', 'openHyperFramesProjectFolder', 'prepareHyperFramesProjectPipeline']) {
    assert(managerSource.includes(`getApiMethod('${actionName}')({ projectId: id`), `${actionName} must be called with projectId.`);
  }

  const bundle = await bundleManager();
  const Manager = bundle.default || bundle;
  assert.strictEqual(typeof Manager, 'function', 'HyperFramesProjectManager module must import successfully.');
  const rendered = ReactDOMServer.renderToString(React.createElement(Manager, { onProjectsChanged: () => {}, onToast: () => {}, onUseProjectInPipeline: () => {} }));
  assert(rendered.includes('Projects are stored under Local AI Hub managed storage'), 'Initial render should include project guidance text.');
  assert(rendered.includes('Loading HyperFrames projects'), 'Initial render should show the loading state before IPC resolves.');

  const normalizedEmpty = bundle.normalizeHyperFramesProjectsForUi(null);
  assert.deepStrictEqual(normalizedEmpty, [], 'Empty or malformed project-list payload normalizes to an empty array.');
  const damaged = bundle.normalizeHyperFramesProjectsForUi([{ projectId: 'bad-one', health: { status: { unexpected: true }, message: null, runnable: false }, createdAt: 'not-a-date' }]);
  assert.strictEqual(damaged.length, 1, 'Damaged project entry remains inspectable.');
  assert.strictEqual(typeof damaged[0].health.status, 'string', 'Damaged project health status is safe text.');
  assert.strictEqual(damaged[0].createdAt, null, 'Invalid timestamps are guarded.');
  const normal = bundle.normalizeHyperFramesProjectsForUi([{ projectId: 'ok-project', displayName: 'OK Project', templateLabel: 'Animated', health: { status: 'healthy', message: 'Ready', runnable: true }, localAssetsOnly: true }]);
  assert.strictEqual(normal[0].displayName, 'OK Project', 'Normal project list result renders safely.');
  assert.strictEqual(normal[0].health.runnable, true, 'Runnable health survives normalization.');
  const templates = bundle.normalizeHyperFramesTemplatesForUi([{ id: 'animated-title-card', label: 'Animated title card' }]);
  assert.strictEqual(templates[0].id, 'animated-title-card', 'Template metadata normalizes safely.');
  const blankProject = bundle.normalizeHyperFramesBlankProjectForUi({ id: 'blank', label: 'Blank Project', sourceType: 'blank-scaffold' });
  assert.strictEqual(blankProject.id, 'blank', 'Blank Project metadata normalizes independently.');
  assert.strictEqual(blankProject.sourceType, 'blank-scaffold', 'Blank Project provenance survives normalization.');

  for (const [method, channel] of [
    ['listHyperFramesProjects', 'hyperframes-projects:list'],
    ['listHyperFramesProjectTemplates', 'hyperframes-projects:templates'],
    ['createHyperFramesProject', 'hyperframes-projects:create'],
    ['renameHyperFramesProject', 'hyperframes-projects:rename'],
    ['duplicateHyperFramesProject', 'hyperframes-projects:duplicate'],
    ['deleteHyperFramesProject', 'hyperframes-projects:delete'],
    ['openHyperFramesProjectFolder', 'hyperframes-projects:open-folder'],
    ['prepareHyperFramesProjectPipeline', 'hyperframes-projects:prepare-pipeline'],
    ['getHyperFramesProjectEditorState', 'hyperframes-projects:editor-state'],
    ['readHyperFramesProjectFile', 'hyperframes-projects:read-file'],
    ['saveHyperFramesProjectFile', 'hyperframes-projects:save-file'],
    ['createHyperFramesProjectFile', 'hyperframes-projects:create-file'],
    ['renameHyperFramesProjectFile', 'hyperframes-projects:rename-file'],
    ['duplicateHyperFramesProjectFile', 'hyperframes-projects:duplicate-file'],
    ['deleteHyperFramesProjectFile', 'hyperframes-projects:delete-file'],
    ['pickHyperFramesProjectAssets', 'hyperframes-projects:pick-assets'],
  ]) {
    assert(preloadSource.includes(`${method}:`) && preloadSource.includes(`invoke('${channel}'`), `${method} preload bridge must invoke ${channel}.`);
    assert(mainSource.includes(`ipcMain.handle('${channel}'`), `${channel} must have a main-process handler.`);
  }

  for (const serviceName of ['listHyperFramesProjects', 'listHyperFramesProjectTemplates', 'createHyperFramesProject', 'renameHyperFramesProject', 'duplicateHyperFramesProject', 'deleteHyperFramesProject', 'openHyperFramesProjectFolder', 'buildHyperFramesProjectPipelineDraft']) {
    assert(serviceSource.includes(serviceName), `${serviceName} service method must exist.`);
  }
  assert(mainSource.includes('openHyperFramesProjectFolder') && mainSource.includes('shell.openPath(targetPath)'), 'Open-folder IPC must resolve project id before shell.openPath.');

  assert(assetLibrarySource.includes('export default function AssetLibraryManager'), 'AssetLibraryManager should still mount as its lazy module default export.');
  assert(promptStylesSource.includes('export default function PromptStylePresetManager'), 'PromptStylePresetManager should still mount as its lazy module default export.');
  assert(pipelineSource.includes("const AssetLibraryManager = React.lazy(() => import('./AssetLibraryManager'));"), 'AssetLibraryManager lazy loading remains intact.');
  assert(pipelineSource.includes("const PromptStylePresetManager = React.lazy(() => import('./PromptStylePresetManager'));"), 'PromptStylePresetManager lazy loading remains intact.');
  assert(!managerSource.includes('Local AI Hub could not load its interface.'), 'HyperFrames Projects path must not invoke the global interface fallback.');
  assert(!editorSource.includes('<iframe') && !editorSource.includes('<webview') && !editorSource.includes('Monaco'), 'Safe editor does not add iframe, webview, or Monaco.');

  await fs.remove(tempRoot);
  console.log('HyperFrames Projects UI verifier passed.');
}

main().catch(async (error) => {
  await fs.remove(tempRoot).catch(() => null);
  console.error(error);
  process.exit(1);
});
