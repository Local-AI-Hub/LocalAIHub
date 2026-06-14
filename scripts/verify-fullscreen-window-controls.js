const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function readSource(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');
}

const appSource = readSource('src', 'App.jsx');
const configSource = readSource('electron', 'services', 'configService.js');
const mainSource = readSource('electron', 'main.js');
const preloadSource = readSource('electron', 'preload.js');
const settingsSource = readSource('src', 'components', 'SettingsPanel.jsx');
const sidebarSource = readSource('src', 'components', 'Sidebar.jsx');
const configService = require(path.join(repoRoot, 'electron', 'services', 'configService.js'));
const windowModeService = require(path.join(repoRoot, 'electron', 'services', 'windowModeService.js'));

function verifyWindowModeService() {
  let fullscreen = false;
  const setFullScreenCalls = [];
  const targetWindow = {
    isDestroyed: () => false,
    isFullScreen: () => fullscreen,
    setFullScreen: (enabled) => {
      setFullScreenCalls.push(enabled);
      fullscreen = enabled;
    },
  };

  assert.strictEqual(windowModeService.normalizeScreenMode('windowed'), 'windowed', 'Windowed should remain a valid saved mode.');
  assert.strictEqual(windowModeService.normalizeScreenMode('fullscreen'), 'fullscreen', 'Fullscreen should remain a valid saved mode.');
  assert.strictEqual(windowModeService.normalizeScreenMode('maximize'), 'windowed', 'Invalid saved modes should fall back to windowed.');
  assert.strictEqual(windowModeService.normalizeScreenMode(undefined), 'windowed', 'Missing saved modes should fall back to windowed.');
  assert.strictEqual(windowModeService.getScreenMode(targetWindow), 'windowed', 'Mock window should begin windowed.');
  assert.strictEqual(windowModeService.setScreenMode(targetWindow, 'fullscreen'), 'fullscreen', 'Fullscreen selection should be returned.');
  assert.deepStrictEqual(setFullScreenCalls, [true], 'Fullscreen selection should call BrowserWindow.setFullScreen(true).');
  assert.strictEqual(windowModeService.getScreenMode(targetWindow), 'fullscreen', 'Fullscreen state should be queryable.');
  assert.strictEqual(windowModeService.toggleFullscreen(targetWindow), 'windowed', 'Toggle should return to windowed mode.');
  assert.deepStrictEqual(setFullScreenCalls, [true, false], 'Windowed selection should call BrowserWindow.setFullScreen(false).');
  assert.throws(
    () => windowModeService.setScreenMode(targetWindow, 'maximize'),
    /Windowed mode or Fullscreen mode/,
    'Arbitrary renderer commands must not be accepted as runtime screen modes.',
  );
}

async function verifyConfigPersistence() {
  assert.strictEqual(configService.createDefaultConfig().screenMode, 'windowed', 'New installs should default to windowed mode.');
  assert(configSource.includes("screenMode: 'windowed'"), 'Config should persist a default screen mode.');
  assert(configSource.includes('screenMode: normalizeScreenMode(config?.screenMode)'), 'Stored screen modes should be normalized defensively.');
  assert(configSource.includes('const CONFIG_VERSION = 7;'), 'Config schema should advance for persisted screen mode.');

  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-window-settings-'));
  const previousAppData = process.env.APPDATA;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.APPDATA = path.join(tempRoot, 'roaming');
  process.env.LOCALAPPDATA = path.join(tempRoot, 'local');
  try {
    const savedFullscreen = await configService.writeConfig({
      ...configService.createDefaultConfig(),
      screenMode: 'fullscreen',
    });
    assert.strictEqual(savedFullscreen.screenMode, 'fullscreen', 'Fullscreen mode should persist to the normalized config.');
    assert.strictEqual((await configService.readConfig()).screenMode, 'fullscreen', 'Fullscreen mode should survive a config reread.');

    const savedInvalid = await configService.writeConfig({
      ...savedFullscreen,
      screenMode: 'maximize',
    });
    assert.strictEqual(savedInvalid.screenMode, 'windowed', 'Invalid stored modes should be rewritten as windowed.');
    assert.strictEqual((await configService.readConfig()).screenMode, 'windowed', 'Windowed fallback should survive a config reread.');
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    await fs.promises.rm(tempRoot, { force: true, recursive: true });
  }
}

function verifyMainProcessContract() {
  for (const channel of [
    'window:get-screen-mode',
    'window:set-screen-mode',
    'window:toggle-fullscreen',
    'settings:save-window-settings',
  ]) {
    assert(mainSource.includes(`ipcMain.handle('${channel}'`), `Main process should own ${channel}.`);
  }

  const saveStart = mainSource.indexOf("ipcMain.handle('settings:save-window-settings'");
  const saveEnd = mainSource.indexOf("ipcMain.handle('settings:save-close-behavior'", saveStart);
  const saveBlock = mainSource.slice(saveStart, saveEnd);
  for (const field of [
    'screenMode',
    'closeBehavior',
    'liveResourcePolling',
    'moveDeletedPipelineOutputsToRecycleBin',
  ]) {
    assert(saveBlock.includes(field), `Unified window save should persist ${field}.`);
  }
  assert(saveBlock.includes('await updateConfig((config) => ({'), 'Window settings should be persisted in one config update.');
  assert(saveBlock.includes('setScreenModePreference(screenMode)'), 'Saving should update the in-memory launch preference.');
  assert(saveBlock.includes('setCloseBehaviorPreference(closeBehavior)'), 'Saving should preserve the existing close preference behavior.');

  assert(mainSource.includes('setScreenModePreference(initialConfig.screenMode);'), 'Startup should load the saved screen mode.');
  assert(mainSource.includes("if (screenModePreference !== 'fullscreen')"), 'Saved windowed mode should remain windowed on launch.');
  assert(mainSource.includes('setImmediate(() => {'), 'Saved fullscreen should be applied without blocking startup.');
  assert(mainSource.includes('broadcastScreenMode(setScreenMode(mainWindow, screenModePreference))'), 'Saved fullscreen should be applied after the window is ready.');
  assert(mainSource.includes("mainWindow.once('ready-to-show'"), 'Saved mode should wait until the BrowserWindow is ready.');

  const shortcutStart = mainSource.indexOf("mainWindow.webContents.on('before-input-event'");
  const shortcutEnd = mainSource.indexOf("mainWindow.on('enter-full-screen'", shortcutStart);
  const shortcutBlock = mainSource.slice(shortcutStart, shortcutEnd);
  assert(shortcutBlock.includes("input.key === 'F11'"), 'F11 should remain handled by the primary BrowserWindow.');
  assert(shortcutBlock.includes('toggleFullscreen(mainWindow)'), 'F11 should toggle runtime fullscreen.');
  assert(!shortcutBlock.includes('updateConfig'), 'F11 should not persist until Save window settings is clicked.');
  assert(shortcutBlock.includes('!input.isAutoRepeat'), 'F11 auto-repeat should not rapidly toggle modes.');
  assert(!mainSource.includes("input.key === 'Escape'"), 'Esc should remain unclaimed to avoid modal and editor conflicts.');

  assert(mainSource.includes("ipcMain.on('window:request-close'"), 'Main process should own the no-payload close request.');
  assert(mainSource.includes('mainWindow.close();'), 'In-app close should route through BrowserWindow.close().');
  assert(mainSource.includes("mainWindow.on('close', (event) =>"), 'The existing safe close handler should remain active.');
  assert(mainSource.includes('shouldMinimizeToTrayOnClose()'), 'Close-to-tray behavior should remain in the shared close handler.');
  assert(mainSource.includes("reportShutdownError(error, { phase: 'window-close' })"), 'Exit cleanup errors should remain on the shared close path.');
  assert(mainSource.includes("mainWindow?.webContents.send('window:screen-mode-changed'"), 'Screen-mode changes should be emitted to the renderer.');
}

function verifyPreloadContract() {
  const expected = [
    "getScreenMode: () => invoke('window:get-screen-mode')",
    "setScreenMode: (screenMode) => invoke('window:set-screen-mode', screenMode)",
    "toggleFullscreen: () => invoke('window:toggle-fullscreen')",
    "saveWindowSettings: (payload) => invoke('settings:save-window-settings', payload)",
    "requestClose: () => ipcRenderer.send('window:request-close')",
    "ipcRenderer.on('window:screen-mode-changed', listener)",
  ];
  for (const entry of expected) {
    assert(preloadSource.includes(entry), `Preload should expose the bounded window API: ${entry}`);
  }
  assert(!preloadSource.includes('executeWindowCommand'), 'Preload must not expose arbitrary window commands.');
  assert(!preloadSource.includes('window:open-url') && !preloadSource.includes('window:open-path'), 'Window controls must not expose arbitrary URLs or file paths.');
}

function verifyRendererUx() {
  assert(settingsSource.includes('Windowed mode'), 'Settings should expose Windowed mode.');
  assert(settingsSource.includes('Fullscreen mode'), 'Settings should expose Fullscreen mode.');
  assert(settingsSource.includes('role="radiogroup"'), 'Settings screen modes should use a clear radio group.');
  assert(settingsSource.includes('Press F11 anywhere in Local AI Hub to toggle.'), 'Settings should explain the F11 shortcut.');
  assert(settingsSource.includes('Save window settings'), 'Window behavior should use the unified save label.');
  assert(!settingsSource.includes('Save close behavior'), 'The old close-only save label should be removed.');
  assert(!settingsSource.includes('Save live polling'), 'Live polling should use the unified save action.');
  assert(!settingsSource.includes('Save output deletion'), 'Pipeline deletion should use the unified save action.');
  assert(settingsSource.includes('F11 changes the current session until you save.'), 'Settings should explain that F11 is runtime-only until saved.');
  assert(!/Enter fullscreen|Exit fullscreen/i.test(settingsSource), 'Settings must not use action-style fullscreen labels.');

  assert(appSource.includes("const [activeTab, setActiveTab] = useState('home');"), 'The app should still launch to Home regardless of screen mode.');
  assert(appSource.includes("const SIDEBAR_COLLAPSED_STORAGE_KEY = 'local-ai-hub.sidebar-collapsed.v1';"), 'Sidebar collapse persistence should remain independent.');
  assert(appSource.includes('window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed))'), 'Sidebar collapse state should still persist locally.');
  assert(appSource.includes("runAction('settings:save-window-settings'"), 'Renderer should use the unified save action.');
  for (const field of [
    'screenMode,',
    'closeBehavior: closeBehaviorDraft',
    'liveResourcePolling: liveResourcePollingDraft',
    'moveDeletedPipelineOutputsToRecycleBin: pipelineOutputTrashDraft',
  ]) {
    assert(appSource.includes(field), `Renderer save payload should include ${field}.`);
  }
  assert(appSource.includes('onScreenModeChanged'), 'Renderer should follow main-process fullscreen state changes.');
  assert(appSource.includes('onChangeScreenMode={changeScreenMode}'), 'Settings should control the current main-process screen mode.');
  assert(!sidebarSource.toLowerCase().includes('fullscreen'), 'The sidebar must not contain a floating or persistent fullscreen control.');
  assert(!appSource.includes('data-floating-fullscreen'), 'No floating fullscreen overlay should be rendered.');
}

function verifyCloseButton() {
  assert(sidebarSource.includes('data-sidebar-expanded="true"'), 'Expanded sidebar hook should remain available.');
  assert(sidebarSource.includes('data-close-local-ai-hub="true"'), 'Expanded sidebar should render a focused close-button hook.');
  assert(sidebarSource.includes('Close Local AI Hub'), 'Expanded sidebar should render the separate close button.');
  assert(sidebarSource.includes('onClick={onRequestClose}'), 'Sidebar close button should use the scoped close callback.');
  assert(appSource.includes('onRequestClose={() => window.localAIHub.requestClose()}'), 'App should route sidebar close through preload.');
  const collapsedBlock = sidebarSource.slice(
    sidebarSource.indexOf('if (collapsed)'),
    sidebarSource.indexOf('\n\n  return (', sidebarSource.indexOf('if (collapsed)')),
  );
  assert(!collapsedBlock.includes('Close Local AI Hub'), 'Collapsed sidebar may require expansion before showing Close Local AI Hub.');
}

async function main() {
  verifyWindowModeService();
  await verifyConfigPersistence();
  verifyMainProcessContract();
  verifyPreloadContract();
  verifyRendererUx();
  verifyCloseButton();

  console.log('Persistent window settings, fullscreen launch, F11 runtime mode, and safe close verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});