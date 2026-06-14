const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
function readSource(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');
}

const appSource = readSource('src', 'App.jsx');
const homeSource = readSource('src', 'components', 'HomePanel.jsx');
const sidebarSource = readSource('src', 'components', 'Sidebar.jsx');
const pipelineSource = readSource('src', 'components', 'PipelineBuilderPanel.jsx');
const settingsSource = readSource('src', 'components', 'SettingsPanel.jsx');
const preloadSource = readSource('electron', 'preload.js');
const mainSource = readSource('electron', 'main.js');
const configSource = readSource('electron', 'services', 'configService.js');

function verifyNavigation() {
  assert(appSource.includes("const [activeTab, setActiveTab] = useState('home');"), 'Fresh launches should default to Home.');
  assert(!/localStorage[^\n]*(?:activeTab|active-tab|lastTab|last-tab)/i.test(appSource), 'App launch should not restore a previously active tab.');
  assert(sidebarSource.includes("label=\"Home\" onClick={() => onChangeTab('home')}"), 'Sidebar should include Home navigation.');
  const homeIndex = sidebarSource.indexOf('label="Home"');
  const libraryIndex = sidebarSource.indexOf('label="Library"');
  assert(homeIndex >= 0 && libraryIndex > homeIndex, 'Home should be the first main navigation item.');
  for (const label of ['Library', 'Store', 'Model Manager', 'Recorder', 'Pipelines', 'Statistics', 'Settings']) {
    assert(sidebarSource.includes(`label="${label}"`), `${label} should remain accessible while the sidebar is expanded.`);
  }
}

function verifyChecklistPersistence() {
  assert(homeSource.includes('data-home-checklist="true"'), 'Home should render the Getting Started checklist.');
  assert(homeSource.includes('Dismiss checklist'), 'Checklist should be dismissible.');
  assert(homeSource.includes('optional: true'), 'Checklist should distinguish optional steps.');
  assert(homeSource.includes('Optional steps never block dismissal.'), 'Optional steps should not block dismissal.');
  assert(configSource.includes('homeChecklistDismissed: false'), 'Config should default the checklist to visible.');
  assert(configSource.includes('homeChecklistDismissed: Boolean(config?.homeChecklistDismissed)'), 'Config normalization should preserve dismissal.');
  assert(preloadSource.includes("saveHomeChecklistDismissed: (dismissed) => invoke('settings:save-home-checklist-dismissed', dismissed)"), 'Preload should expose bounded checklist persistence.');
  assert(mainSource.includes("ipcMain.handle('settings:save-home-checklist-dismissed'"), 'Main should persist checklist dismissal.');
  assert(appSource.includes('checklistDismissed={Boolean(appState.settings?.homeChecklistDismissed)}'), 'Home should consume persisted dismissal state.');
}

function verifyQuickActionsAndOutputsLayout() {
  const expected = [
    ["label: 'Record something'", "tab: 'recorder'"],
    ["label: 'Build a pipeline'", "tab: 'pipelines'"],
    ["label: 'Open starter templates'", "target: 'templates'"],
    ["label: 'View outputs'", "target: 'outputs'"],
    ["label: 'Install tools'", "tab: 'store'"],
    ["label: 'Manage models'", "tab: 'models'"],
    ["label: 'Configure providers'", "tab: 'settings'"],
    ["label: 'Create diagnostics bundle'", "target: 'diagnostics'"],
  ];
  for (const [label, target] of expected) {
    assert(homeSource.includes(label) && homeSource.includes(target), `Quick action ${label} should target the existing area.`);
  }
  assert(appSource.includes('initialFocus={pipelineEntryTarget}'), 'Home Pipeline actions should pass their target to the existing Pipeline Builder.');
  assert(pipelineSource.includes("initialFocus === 'outputs'"), 'The Home Outputs action should expand the existing Outputs section.');
  assert(pipelineSource.includes('data-pipeline-home-target="templates"'), 'Template quick action should reveal the starter templates section.');
  assert(
    pipelineSource.includes("<div className={pipelineOutputsExpanded ? 'xl:col-span-2 2xl:col-span-3' : ''} data-pipeline-home-target=\"outputs\">"),
    'The Outputs grid wrapper should span every Pipeline column when expanded.',
  );
  assert(
    !pipelineSource.includes("className={pipelineOutputsExpanded ? 'xl:col-span-2 2xl:col-span-3' : ''}\n              busyPath={outputsBusyPath}"),
    'The full-width class must not sit on the nested Outputs panel instead of the grid item.',
  );
  assert(settingsSource.includes("initialSection = ''") && settingsSource.includes('setOpenSection(initialSection)'), 'Diagnostics quick action should open the existing Settings section.');
  assert(settingsSource.includes('cleanupPreview && !initialSection'), 'Cleanup preview should not steal focus from an explicit Home Settings target.');
}

function verifyHomePolish() {
  assert(!homeSource.includes('data-home-hardware'), 'Home should not render a duplicate hardware card.');
  assert(!homeSource.includes('Hardware expectations'), 'Home should not repeat hardware expectations from the sidebar.');
  assert(!homeSource.includes('buildHardwareExpectation'), 'Home should not keep unused hardware expectation logic.');
  assert(!homeSource.includes('formatMemory') && !homeSource.includes('formatDiskAvailability'), 'Home should not import hardware formatting helpers.');
  assert(homeSource.includes('Welcome home') && homeSource.includes('Getting Started') && homeSource.includes('Quick actions'), 'Home should retain its hero, checklist, and quick actions.');
}

function verifySidebarCollapse() {
  assert(sidebarSource.includes('if (collapsed)'), 'Sidebar should have a dedicated collapsed rendering state.');
  assert(sidebarSource.includes('data-sidebar-collapsed="true"'), 'Collapsed sidebar should expose a focused verifier hook.');
  assert(sidebarSource.includes('aria-label="Expand sidebar"'), 'Collapsed restore control should have an accessible label.');
  assert(sidebarSource.includes('Expand sidebar'), 'Collapsed sidebar should show a clear restore label.');
  assert(sidebarSource.includes('Collapse sidebar'), 'Expanded sidebar should expose a collapse control.');
  const collapsedBlock = sidebarSource.slice(sidebarSource.indexOf('if (collapsed)'), sidebarSource.indexOf('\n\n  return (', sidebarSource.indexOf('if (collapsed)')));
  assert(!collapsedBlock.includes('<NavButton') && !collapsedBlock.includes('Main navigation'), 'Collapsed state should not render a tab icon rail or normal navigation.');
  assert(appSource.includes("const SIDEBAR_COLLAPSED_STORAGE_KEY = 'local-ai-hub.sidebar-collapsed.v1';"), 'Sidebar collapse should use a local, lightweight persistence key.');
  assert(appSource.includes('useState(getInitialSidebarCollapsed)'), 'Sidebar should restore its persisted collapsed state.');
  assert(appSource.includes('window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed))'), 'Sidebar collapse changes should persist locally.');
  assert(appSource.includes('grid-cols-1 grid-rows-[auto,minmax(0,1fr)]'), 'Collapsed layout should give main content the full available width below the small bubble.');
  assert(appSource.includes('onCollapse={() => setSidebarCollapsed(true)}') && appSource.includes('onExpand={() => setSidebarCollapsed(false)}'), 'App should connect both sidebar toggle directions.');
  assert(appSource.includes("const [activeTab, setActiveTab] = useState('home');"), 'Persisted sidebar state must not alter the Home launch default.');
}

function verifyPassiveHome() {
  const forbiddenCalls = [
    'getStatistics',
    'getStatisticsCore',
    'getStatisticsStorage',
    'browseModels',
    'listProviderModels',
    'testProviderConnection',
    'chatWithProvider',
    'fetch(',
  ];
  for (const call of forbiddenCalls) {
    assert(!homeSource.includes(call), `Home must not trigger heavy or remote call: ${call}`);
  }
  assert(appSource.includes("if (activeTab !== 'statistics')"), 'Statistics loading should remain gated to its own tab.');
  assert(appSource.includes("activeTab === 'models' ? (\n            <ModelManager isActive={activeTab === 'models'}"), 'Model Manager should mount only on its own tab.');
}

function verifyExistingSupportUi() {
  assert(settingsSource.includes('Support and Diagnostics'), 'Diagnostics UI should remain available.');
  assert(settingsSource.includes('App updates'), 'Updates UI should remain available.');
  assert(appSource.includes('<RecorderPanel'), 'Recorder should remain available.');
  assert(appSource.includes('<PipelineBuilderPanel'), 'Pipelines should remain available.');
}

verifyNavigation();
verifyChecklistPersistence();
verifyQuickActionsAndOutputsLayout();
verifyHomePolish();
verifySidebarCollapse();
verifyPassiveHome();
verifyExistingSupportUi();
console.log('Home page and layout polish verification passed.');