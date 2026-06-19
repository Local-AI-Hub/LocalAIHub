const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const readSource = (...segments) => fs.readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');

const appSource = readSource('src', 'App.jsx');
const homeSource = readSource('src', 'components', 'HomePanel.jsx');
const pipelineSource = readSource('src', 'components', 'PipelineBuilderPanel.jsx');
const promptStyleSource = readSource('src', 'components', 'PromptStylePresetManager.jsx');
const settingsSource = readSource('src', 'components', 'SettingsPanel.jsx');
const sidebarSource = readSource('src', 'components', 'Sidebar.jsx');

function verifySubviewNavigation() {
  assert(pipelineSource.includes('data-pipeline-workspace-navigation="true"'), 'Pipelines should render internal workspace navigation.');
  for (const [id, label] of [['get-started', 'Get Started'], ['build', 'Build'], ['resources', 'Resources'], ['outputs', 'Outputs']]) {
    assert(pipelineSource.includes(`{ id: '${id}', label: '${label}' }`), `Pipelines should expose the ${label} subview.`);
  }
  assert(pipelineSource.includes("return 'get-started';"), 'Unspecified Pipeline entry targets should default to Get Started.');
  assert(appSource.includes("if (tab === 'pipelines')") && appSource.includes('setPipelineEntryRevision((current) => current + 1)'), 'Each sidebar Pipeline click should issue a fresh subview request.');
  assert(appSource.includes("const [activeTab, setActiveTab] = useState('home');"), 'The app should still launch to Home.');
}

function verifyGetStarted() {
  assert(pipelineSource.includes("activeSubview === 'get-started'"), 'Get Started should have its own workspace body.');
  for (const label of ['Pipeline wizard', 'Starter templates', 'Saved pipelines']) {
    assert(pipelineSource.includes(label), `Get Started should retain ${label}.`);
  }
  for (const key of ['pipelineWizard', 'starterTemplates', 'savedPipelines']) {
    assert(pipelineSource.includes(`toggleSection('${key}')`), `${key} should remain collapsible and expandable.`);
  }
  assert(pipelineSource.includes('order-1 xl:col-span-2') && pipelineSource.includes('order-2') && pipelineSource.includes('order-3'), 'The wizard should lead the Get Started layout, with templates and saved pipelines below it.');
}

function verifyBuild() {
  assert(pipelineSource.includes("activeSubview === 'build'"), 'Build should have its own workspace body.');
  for (const label of ['Pipeline setup', 'Node palette', 'Canvas', 'Runtime status']) {
    assert(pipelineSource.includes(label), `Build should retain ${label}.`);
  }
  for (const key of ['pipelineInfo', 'nodePalette', 'canvas', 'runStatus']) {
    assert(pipelineSource.includes(`toggleSection('${key}')`), `${key} should remain collapsible and expandable.`);
  }
  for (const action of ['New pipeline', 'Copy pipeline', 'Delete', 'Run pipeline']) {
    assert(pipelineSource.includes(action), `Pipeline Setup should retain the ${action} action.`);
  }
  assert(pipelineSource.includes('data-node-inspector-overlay="true"'), 'Node Inspector should be a contextual overlay.');
  assert(pipelineSource.includes('onContextMenu={(event) =>') && pipelineSource.includes('onDoubleClick={(event) =>'), 'Right-click and double-click should open Node Inspector.');
  assert(pipelineSource.includes("event.key === 'Escape'") && pipelineSource.includes('event.target === event.currentTarget'), 'Escape and outside click should close Node Inspector.');
  assert(pipelineSource.includes('event.button !== 0'), 'Right-click should not start node dragging.');
  assert(pipelineSource.includes("setActiveSubview('build')"), 'Template, wizard, and saved-pipeline authoring actions should enter Build.');
}

function verifyResources() {
  assert(pipelineSource.includes("activeSubview === 'resources'"), 'Resources should have its own workspace body.');
  assert(pipelineSource.includes('<AssetLibraryManager onToast={onToast} />'), 'Resources should render the existing Asset Library Manager.');
  assert(pipelineSource.includes('<PromptStylePresetManager'), 'Resources should render the prompt style preset manager.');
  assert(pipelineSource.includes('<HyperFramesProjectManager'), 'Resources should render the HyperFrames Projects manager.');
  assert(pipelineSource.includes('data-pipeline-resource-section="hyperframes-projects"'), 'Resources should expose a HyperFrames Projects section marker.');
  assert(pipelineSource.includes('HyperFramesProjectsErrorBoundary'), 'HyperFrames Projects should be isolated by a local render boundary.');
  assert(pipelineSource.includes('hyperFramesProjects: false'), 'HyperFrames Projects should have an explicit default Resources expansion state.');
  assert(pipelineSource.includes('const [hyperFramesProjects, setHyperFramesProjects] = useState([]);'), 'HyperFrames Projects should define parent state used by project input selectors.');
  assert(pipelineSource.includes("toggleSection('assetLibraries')") && pipelineSource.includes("toggleSection('promptStyles')") && pipelineSource.includes("toggleSection('hyperFramesProjects')"), 'All Resources sections should remain collapsible and expandable.');
  assert(!settingsSource.includes('Asset Libraries'), 'Asset Libraries should no longer appear in Settings.');
  assert(!settingsSource.includes('Prompt Style Presets'), 'Prompt Style Presets should no longer appear in Settings.');
  assert(promptStyleSource.includes('onSavePromptStyle?.(buildPromptStylePayload(promptStyleDraft))'), 'Prompt style saving should preserve the existing callback and payload path.');
  assert(promptStyleSource.includes('onDeletePromptStyle?.(id)'), 'Prompt style deletion should preserve the existing callback path.');
}

function verifyOutputsAndRouting() {
  assert(pipelineSource.includes("activeSubview === 'outputs'"), 'Outputs should have its own workspace body.');
  assert(pipelineSource.includes('data-pipeline-outputs-full-width="true"'), 'Pipeline Outputs should occupy the full subview width.');
  assert(pipelineSource.includes("toggleSection('pipelineOutputs')"), 'Pipeline Outputs should remain collapsible and expandable.');
  assert(!pipelineSource.includes('pipelineOutputsExpanded'), 'The old mixed-grid Outputs expansion state should be removed.');
  assert(homeSource.includes("label: 'Build a pipeline', tab: 'pipelines', target: 'build'"), 'Home Build pipeline should route to Build.');
  assert(homeSource.includes("label: 'Open starter templates', tab: 'pipelines', target: 'templates'"), 'Home starter templates should route to Get Started templates.');
  assert(homeSource.includes("label: 'View outputs', tab: 'pipelines', target: 'outputs'"), 'Home View outputs should route to Outputs.');
  assert(pipelineSource.includes('<PipelineOutputDeletionDialog') && pipelineSource.includes('onDelete={handleDeleteOutput}'), 'Existing output deletion UI should remain wired.');
}

function verifyUnaffectedSurfaces() {
  assert(sidebarSource.includes("label=\"Pipelines\" onClick={() => onChangeTab('pipelines')}"), 'Sidebar Pipelines navigation should remain intact.');
  assert(appSource.includes("const SIDEBAR_COLLAPSED_STORAGE_KEY = 'local-ai-hub.sidebar-collapsed.v1';"), 'Sidebar collapse persistence should remain independent.');
  assert(settingsSource.includes('App updates'), 'Settings Updates should still render.');
  assert(settingsSource.includes('Support and Diagnostics'), 'Settings Diagnostics should still render.');
  assert(settingsSource.includes('Windowed mode') && settingsSource.includes('Fullscreen mode'), 'Fullscreen and windowed Settings controls should remain intact.');
  assert(pipelineSource.includes('window.localAIHub.runPipeline(draft)'), 'Pipeline execution should continue through the existing runtime call.');
}

verifySubviewNavigation();
verifyGetStarted();
verifyBuild();
verifyResources();
verifyOutputsAndRouting();
verifyUnaffectedSurfaces();
console.log('Pipeline workspace subviews verification passed.');
