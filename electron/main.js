const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  desktopCapturer,
  ipcMain,
  Menu,
  Notification,
  protocol,
  screen,
  session,
  Tray,
  nativeImage,
  shell,
} = require('electron');

const {
  deleteGraphWorkflowPreset,
  deletePromptStyle,
  ensureStorage,
  getAppPaths,
  humanizeError,
  listGraphWorkflowPresets,
  markFirstLaunchComplete,
  readConfig,
  saveHardwareDetection,
  updateConfig,
  upsertGraphWorkflowPreset,
  upsertPromptStyle,
  upsertTool,
} = require('./services/configService');
const {
  browseRemoteModels,
  countDownloadedModels,
  deleteModel,
  downloadModel,
  getModelDownloadPreflight,
  listDownloadedModels,
  listToolAssets,
  readModelSettings,
  saveModelManagerSettings,
  supportsModelManager,
} = require('./services/modelService');
const {
  buildKoboldCppLaunchConfiguration,
  getKoboldCppSetup,
  saveKoboldCppLaunchSelection,
} = require('./services/koboldCppService');
const { invalidateDiscoveryCache, syncDiscoveredTools } = require('./services/toolDiscoveryService');
const { detectHardwareSnapshot, getLiveResourceUsage } = require('./services/hardwareService');
const {
  getToolInstallPreflight,
  inspectToolRepair,
  installTool,
  repairToolInstallation,
  uninstallTool,
  updateToolInstallation,
} = require('./services/installerService');
const { buildOllamaUnavailableMessage, listOllamaModels, chatWithOllama, finishOllamaSession, prepareOllamaSession, refreshOwnedOllamaSessionProcesses, waitForOllamaReady } = require('./services/ollamaService');
const { buildAiderLaunchConfiguration, inspectAiderProject, listAiderLaunchModels } = require('./services/aiderService');
const {
  disposeAllRuntimes,
  getRuntimeOutputSnapshot,
  isToolActive,
  isToolRuntimeSettling,
  launchToolFromUserAction,
  prepareToolForMaintenance,
  sendInputToTool,
  setRuntimeEventSink,
  stopTool,
} = require('./services/processService');
const { listSnapshots, restoreSnapshot, saveSnapshot } = require('./services/snapshotService');
const {
  LIBRARY_TYPES,
  PREVIEW_URL_SCHEME,
  createAssetLibrary,
  deleteAssetLibrary,
  getAssetLibraryItemPreview,
  importAssetLibraryItems,
  listAssetLibraries,
  removeAssetLibraryItem,
  renameAssetLibrary,
  resolveAssetLibraryPreviewRequest,
  updateColorPaletteItem,
} = require('./services/assetLibraryService');
const { inspectCleanupTargets, runCleanup } = require('./services/storageCleanupService');
const { dismissManagedDataMigration, getStorageOverview, setManagedDataRoot } = require('./services/storageLocationService');
const { getToolCatalog, getToolManifest, initializeToolRegistry } = require('./services/toolRegistry');
const { getManifestStatus } = require('./services/manifestService');
const { getProviderManifestStatus, initializeProviderRegistry } = require('./services/providerRegistry');
const {
  chatWithProvider,
  disconnectProvider,
  listProviderConnections,
  listProviderModels,
  saveProviderConnection,
  setProviderStateChangeSink,
  testProviderConnection,
} = require('./services/providerService');
const { getStatisticsCoreSnapshot, getStatisticsSnapshot, getStatisticsStorageSnapshot, invalidateStatisticsIndexSections, recordToolLaunch, recordVramSample } = require('./services/statisticsService');
const { getToolUpdateSnapshot, refreshInstalledToolUpdates } = require('./services/toolUpdateService');
const { transcribeWithWhisper } = require('./services/whisperService');
const { buildMergedToolStateList } = require('./services/toolStateService');
const { createUpdateService } = require('./services/updateService');
const { disposeBackgroundTasks } = require('./services/backgroundTaskService');
const {
  cancelPipelineRecordInput,
  cancelPipelineRun,
  getActiveRunSnapshot,
  handlePipelineRecordingStatus,
  resumePipelineValidation,
  runPipeline,
  setPipelineEventSink,
  setPipelineRecordingController,
  startPipelineRecordInput,
  stopPipelineRecordInput,
} = require('./services/pipelineExecutionService');
const { deletePipeline, getPipeline, listPipelines, savePipeline } = require('./services/pipelineStoreService');
const { buildPipelineOutputDeletionPreview, deletePipelineOutput, listPipelineOutputs } = require('./services/pipelineOutputStoreService');
const { redactSensitiveText } = require('./services/redactionService');
const { appendLog } = require('./services/logService');
const {
  buildSystemInfoText,
  collectSupportData,
  createDiagnosticsBundle,
  getDiagnosticsRoot,
} = require('./services/diagnosticsService');

const appUpdateService = createUpdateService({
  openExternalImpl: (url) => shell.openExternal(url),
});
const {
  cancelRecording: cancelFfmpegRecording,
  deleteRecording: deleteStoredRecording,
  disposeRecording: disposeFfmpegRecording,
  getActiveRecording: getActiveFfmpegRecording,
  listRecordingDevices,
  listRecentRecordings,
  openRecording,
  openRecordingsFolder,
  revealRecording,
  setRecordingEventSink: setFfmpegRecordingEventSink,
  startRecording: startFfmpegRecording,
  stopRecording: stopFfmpegRecording,
} = require('./services/recordingService');
const { createSystemAudioRecordingService } = require('./services/systemAudioRecordingService');
const { createSystemAudioCaptureAdapter } = require('./services/systemAudioCaptureAdapter');
const { normalizeOverlaySelection } = require('./services/regionSelectionService');
const { buildTrayMenuTemplate, getTrayTooltip } = require('./services/trayMenuService');

const systemAudioCaptureAdapter = createSystemAudioCaptureAdapter({
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
});
const systemAudioRecordingService = createSystemAudioRecordingService({ captureAdapter: systemAudioCaptureAdapter });
let recordingStartInProgress = false;

function isSystemAudioRecordingRequest(payload = {}) {
  return payload?.systemAudio === true || payload?.mode === 'systemAudio';
}

function getActiveRecording() {
  return systemAudioRecordingService.getActiveRecording() || getActiveFfmpegRecording();
}

function setRecordingEventSink(sink) {
  setFfmpegRecordingEventSink(sink);
  systemAudioRecordingService.setRecordingEventSink(sink);
}

async function startRecording(payload = {}, context = {}) {
  if (recordingStartInProgress || getActiveRecording()) {
    throw new Error('A recording is already active. Stop or cancel it before starting another one.');
  }
  recordingStartInProgress = true;
  try {
    if (isSystemAudioRecordingRequest(payload)) {
      return await systemAudioRecordingService.startRecording(payload, context);
    }
    return await startFfmpegRecording(payload, context);
  } finally {
    recordingStartInProgress = false;
  }
}

async function stopRecording() {
  if (systemAudioRecordingService.getActiveRecording()) return systemAudioRecordingService.stopRecording();
  return stopFfmpegRecording();
}

async function cancelRecording() {
  if (systemAudioRecordingService.getActiveRecording()) return systemAudioRecordingService.cancelRecording();
  return cancelFfmpegRecording();
}

async function disposeRecording() {
  if (systemAudioRecordingService.getActiveRecording()) return systemAudioRecordingService.disposeRecording();
  return disposeFfmpegRecording();
}

async function deleteRecording(id, options) {
  if (getActiveRecording()?.id === String(id || '').trim()) {
    throw new Error('Stop or cancel the active recording before deleting it.');
  }
  return deleteStoredRecording(id, options);
}

setPipelineRecordingController({
  async start({ config, nodeId, runId }) {
    return startRecording(config, {
      displays: listRecordingDisplays(),
      recordingContext: {
        nodeId,
        runId,
        type: 'pipelineRun',
      },
    });
  },
  cancel: () => cancelRecording(),
  stop: () => stopRecording(),
});

const APP_USER_MODEL_ID = 'com.localaihub.desktop';
const TOOL_HEALTH_CHECK_INTERVAL_MS = 5000;
const TOOL_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LIVE_RESOURCE_CACHE_TTL_MS = 5000;
try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_URL_SCHEME,
      privileges: {
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true,
      },
    },
  ]);
} catch {
  // Electron only allows scheme registration before app readiness; ignore duplicate registration in test-like reloads.
}

let mainWindow = null;
let tray = null;
let cachedTrayToolItems = [];
let trayToolRefreshPromise = null;
let trayRecordingStopPromise = null;
let regionSelectionWindow = null;
let regionSelectionDisplay = null;
let regionSelectionPromise = null;
let regionSelectionResolve = null;
let regionSelectionReject = null;
let isQuitting = false;
let closeBehaviorPreference = 'exit';
let shutdownComplete = false;
let shutdownPromise = null;
let backgroundHealthInterval = null;
let toolUpdateInterval = null;
let healthCheckBusy = false;
let toolUpdateCheckPromise = null;
let lastWindowActivity = { focused: true, visible: true };
let liveResourceCache = {
  key: '',
  timestamp: 0,
  value: null,
};
const tabOwnedRequestControllers = {
  modelCatalog: new Map(),
  statistics: new Map(),
};
let fatalAppErrorHandled = false;
let appStartupComplete = false;

function toError(value) {
  if (value instanceof Error) {
    return value;
  }

  return new Error(typeof value === 'string' ? value : 'Unknown startup error');
}

function getDiagnosticLogPath() {
  try {
    return path.join(app.getPath('temp'), 'LocalAIHub-startup.log');
  } catch {
    return path.join(process.cwd(), 'LocalAIHub-startup.log');
  }
}

function normalizeDiagnosticValue(value) {
  if (value instanceof Error) {
    return {
      message: redactSensitiveText(value.message || ''),
      stack: redactSensitiveText(value.stack || ''),
      code: value.code,
      stdout: redactSensitiveText(value.stdout || ''),
      stderr: redactSensitiveText(value.stderr || ''),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDiagnosticValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeDiagnosticValue(entry)]));
  }

  return typeof value === 'string' ? redactSensitiveText(value) : value;
}

function writeDiagnosticLog(label, error, context = {}) {
  const diagnosticPath = getDiagnosticLogPath();
  const payload = {
    appVersion: app.getVersion(),
    context: normalizeDiagnosticValue(context),
    isPackaged: app.isPackaged,
    message: redactSensitiveText(error?.message || String(error)),
    stack: redactSensitiveText(error?.stack || ''),
    timestamp: new Date().toISOString(),
  };

  try {
    fs.appendFileSync(diagnosticPath, `[${payload.timestamp}] [${label}] ${JSON.stringify(payload)}\n`, 'utf8');
    return diagnosticPath;
  } catch {
    return null;
  }
}

function reportFatalAppError(error, context = {}) {
  if (fatalAppErrorHandled) {
    return;
  }

  fatalAppErrorHandled = true;
  const normalizedError = toError(error);
  const diagnosticPath = writeDiagnosticLog('fatal-startup-error', normalizedError, context);
  const message = humanizeError(normalizedError, 'Local AI Hub could not start correctly on this PC.');

  dialog.showErrorBox(
    'Local AI Hub could not start',
    diagnosticPath
      ? `${message}\n\nA startup diagnostic log was saved to:\n${diagnosticPath}`
      : `${message}\n\nLocal AI Hub could not save a startup diagnostic log.`,
  );

  isQuitting = true;
  app.exit(1);
}

function reportPostStartupUnhandledRejection(reason, context = {}) {
  const normalizedError = toError(reason);
  const diagnosticPath = writeDiagnosticLog('main-process-unhandled-rejection', normalizedError, context);
  try {
    console.error('[Local AI Hub] Main-process promise rejection after startup:', normalizedError, diagnosticPath || '');
  } catch {
    return;
  }
}

function normalizeCloseBehavior(value) {
  return String(value || '').trim().toLowerCase() === 'tray' ? 'tray' : 'exit';
}

function setCloseBehaviorPreference(value) {
  closeBehaviorPreference = normalizeCloseBehavior(value);
}

function shouldMinimizeToTrayOnClose() {
  return closeBehaviorPreference !== 'exit';
}

async function shutdownOwnedResources() {
  if (backgroundHealthInterval) {
    clearInterval(backgroundHealthInterval);
    backgroundHealthInterval = null;
  }
  if (toolUpdateInterval) {
    clearInterval(toolUpdateInterval);
    toolUpdateInterval = null;
  }

  cancelRecordingRegionSelection();
  if (getActiveRecording()?.recordingContext === 'pipelineRun') {
    await cancelRecording().catch(() => null);
  } else {
    await disposeRecording().catch(() => null);
  }
  await disposeAllRuntimes().catch(() => null);
  await disposeBackgroundTasks().catch(() => null);
  appUpdateService.dispose();
}

async function requestAppQuit() {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      isQuitting = true;
      await shutdownOwnedResources();
      shutdownComplete = true;

      if (tray && !tray.isDestroyed()) {
        tray.destroy();
        tray = null;
      }

      app.quit();
      return true;
    })().catch((error) => {
      shutdownPromise = null;
      shutdownComplete = false;
      isQuitting = false;
      throw error;
    });
  }

  return shutdownPromise;
}

function reportShutdownError(error, context = {}) {
  const diagnosticPath = writeDiagnosticLog('shutdown-error', toError(error), context);
  dialog.showErrorBox(
    'Local AI Hub could not close cleanly',
    diagnosticPath
      ? `Local AI Hub hit a shutdown problem and saved a diagnostic log to:\n${diagnosticPath}`
      : humanizeError(error, 'Local AI Hub hit a shutdown problem while closing.'),
  );
}

function getRendererUrl() {
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }

  return `file://${path.join(__dirname, '..', 'dist', 'index.html')}`;
}

function getAppIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'icon.ico');
}

function createTrayIcon() {
  const trayImage = nativeImage.createFromPath(getAppIconPath());
  return trayImage.isEmpty() ? nativeImage.createEmpty() : trayImage.resize({ width: 16, height: 16 });
}

function getStopMessage(tool) {
  if (tool?.interfaceMode === 'external-browser' && tool?.launchUrl) {
    return `${tool.name} stopped. You can close the browser tab.`;
  }

  return `${tool?.name || 'The tool'} was stopped.`;
}

async function notify(title, body, options = {}) {
  if (!Notification.isSupported()) {
    return null;
  }

  const notification = new Notification({
    title,
    body,
    icon: getAppIconPath(),
    ...options,
  });
  notification.show();
  return notification;
}

function openInternalToolInterface(tool) {
  if (!tool || !String(tool.interfaceMode || '').startsWith('embedded-') || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  showWindow();
  mainWindow.webContents.send('app:open-tool-ui', {
    toolId: tool.id,
    interfaceMode: tool.interfaceMode,
  });
}

async function maybeNotifyStoppedTool(tool) {
  if (tool?.interfaceMode === 'external-browser' && tool?.launchUrl) {
    await notify('Local AI Hub', getStopMessage(tool));
  }
}

async function launchToolFromExplicitUserAction(tool, options = {}) {
  const launchedTool = await launchToolFromUserAction(tool, options);
  await recordToolLaunch(tool).catch(() => null);
  const nextState = await buildAppState();
  const nextTool = toolLookup(tool.id, nextState.tools);
  openInternalToolInterface({
    ...nextTool,
    interfaceMode: launchedTool?.interfaceMode || nextTool?.interfaceMode,
  });
  return {
    nextState,
    nextTool: {
      ...nextTool,
      interfaceMode: launchedTool?.interfaceMode || nextTool?.interfaceMode,
      lastLaunchWarning: launchedTool?.lastLaunchWarning || nextTool?.lastLaunchWarning,
    },
  };
}

async function hasConfiguredRunningTools() {
  const config = await readConfig();
  return Object.values(config.tools || {}).some((tool) => tool.status === 'running');
}

function getWindowActivityPayload() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return {
      focused: false,
      visible: false,
    };
  }

  return {
    focused: mainWindow.isFocused(),
    visible: mainWindow.isVisible() && !mainWindow.isMinimized(),
  };
}

function broadcastWindowActivity(force = false) {
  const nextActivity = getWindowActivityPayload();
  if (
    !force &&
    nextActivity.focused === lastWindowActivity.focused &&
    nextActivity.visible === lastWindowActivity.visible
  ) {
    return nextActivity;
  }

  lastWindowActivity = nextActivity;
  mainWindow?.webContents.send('app:window-activity', nextActivity);
  return nextActivity;
}

function focusMainWindowFromRenderer(reason = 'renderer-focus-request') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return getWindowActivityPayload();
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
  mainWindow.webContents.focus();
  const activity = broadcastWindowActivity(true);
  appendLog('renderer', 'info', 'Renderer requested app window focus.', {
    focused: activity.focused,
    reason: String(reason || 'renderer-focus-request').slice(0, 120),
    visible: activity.visible,
  }).catch(() => null);
  return activity;
}
function showConfirmDialogFromRenderer(payload = {}) {
  const message = String(payload?.message || '').trim() || 'Continue?';
  const result = dialog.showMessageBoxSync(mainWindow || undefined, {
    buttons: ['Cancel', 'OK'],
    cancelId: 0,
    defaultId: 1,
    message,
    noLink: true,
    title: 'Local AI Hub',
    type: 'question',
  });
  const confirmed = result === 1;
  focusMainWindowFromRenderer('main-process-confirm');
  appendLog('renderer', 'info', 'Main-process confirm closed.', {
    confirmed,
    messageLength: message.length,
  }).catch(() => null);
  return confirmed;
}
async function updateHealthMonitor(options = {}) {
  const hasRunningTools =
    typeof options.hasRunningTools === 'boolean' ? options.hasRunningTools : await hasConfiguredRunningTools();

  if (!hasRunningTools) {
    if (backgroundHealthInterval) {
      clearInterval(backgroundHealthInterval);
      backgroundHealthInterval = null;
    }
    return;
  }

  if (backgroundHealthInterval || isQuitting) {
    return;
  }

  backgroundHealthInterval = setInterval(() => {
    checkRunningToolsHealth().catch(() => null);
  }, TOOL_HEALTH_CHECK_INTERVAL_MS);
}

function buildLiveResourceCacheKey(targetPath, options = {}) {
  return JSON.stringify({
    includeDisk: options.includeDisk !== false,
    targetPath: String(targetPath || ''),
  });
}

async function getCachedLiveResources(targetPath, options = {}) {
  const cacheKey = buildLiveResourceCacheKey(targetPath, options);
  if (
    liveResourceCache.value &&
    liveResourceCache.key === cacheKey &&
    Date.now() - liveResourceCache.timestamp < LIVE_RESOURCE_CACHE_TTL_MS
  ) {
    return liveResourceCache.value;
  }

  const resources = await getLiveResourceUsage(targetPath, options);
  liveResourceCache = {
    key: cacheKey,
    timestamp: Date.now(),
    value: resources,
  };
  return resources;
}

async function getDownloadedModelCountSnapshot() {
  const config = await readConfig();
  const tools = Object.values(config.tools || {}).filter((tool) => supportsModelManager(tool));
  const counts = await Promise.all(tools.map((tool) => countDownloadedModels(tool).catch(() => 0)));
  return counts.reduce((total, count) => total + count, 0);
}

function sendAppStateUpdate(payload) {
  if (!payload) {
    return;
  }

  mainWindow?.webContents.send('app:state-updated', payload);
}

async function refreshOpenAppState(options = {}) {
  const state = await buildAppState(options);
  sendAppStateUpdate(state);
  await updateHealthMonitor({ hasRunningTools: state.tools.some((tool) => tool.status === 'running') }).catch(() => null);
  await updateTrayMenu().catch(() => null);
  return state;
}

async function buildAppState(options = {}) {
  await initializeToolRegistry({ refreshRemote: Boolean(options.refreshManifest) });
  await initializeProviderRegistry();
  await syncDiscoveredTools({ force: Boolean(options.forceDiscovery) });

  const config = await readConfig();
  let hardware = config.hardware;

  if (!hardware || !Array.isArray(hardware.disks) || hardware.disks.length === 0) {
    hardware = await detectHardwareSnapshot();
    await saveHardwareDetection(hardware);
  }

  const latestConfig = await readConfig();
  const paths = getAppPaths();
  const storage = await getStorageOverview();
  const manifests = getToolCatalog();
  const tools = await buildMergedToolStateList({
    config: latestConfig,
    includeSnapshots: true,
    resolveStatuses: true,
    syncDiscovered: false,
  });
  const downloadedModelCount = (
    await Promise.all(
      tools
        .filter((tool) => supportsModelManager(tool))
        .map((tool) => countDownloadedModels(tool).catch(() => 0)),
    )
  ).reduce((total, count) => total + count, 0);

  return {
    appDataPath: paths.configRoot,
    appInstallPath: paths.appInstallDir,
    downloadedModelCount,
    executablePath: paths.executablePath,
    firstLaunch: !latestConfig.firstLaunchCompleted,
    graphWorkflowPresets: latestConfig.graphWorkflowPresets || [],
    promptStyles: latestConfig.promptStyles || [],
    hardware,
    logsPath: paths.logsRoot,
    managedDataPath: paths.managedRoot,
    manifests,
    manifestStatus: getManifestStatus(),
    providerManifestStatus: getProviderManifestStatus(),
    providers: await listProviderConnections(),
    resources: await getCachedLiveResources(paths.managedRoot, { includeDisk: true }),
    settings: {
      checkForUpdatesOnLaunch: Boolean(latestConfig.checkForUpdatesOnLaunch),
      closeBehavior: normalizeCloseBehavior(latestConfig.closeBehavior),
      homeChecklistDismissed: Boolean(latestConfig.homeChecklistDismissed),
      liveResourcePolling: Boolean(latestConfig.liveResourcePolling),
      moveDeletedPipelineOutputsToRecycleBin: latestConfig.moveDeletedPipelineOutputsToRecycleBin !== false,
    },
    appUpdate: await appUpdateService.getSnapshot(),
    storage,
    toolUpdates: await getToolUpdateSnapshot(tools),
    tools,
  };
}

function showWindow() {
  if (!mainWindow) {
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

function serializeRecordingDisplay(display, index, primaryId) {
  const bounds = {
    x: Math.trunc(Number(display.bounds?.x) || 0),
    y: Math.trunc(Number(display.bounds?.y) || 0),
    width: Math.trunc(Number(display.bounds?.width) || 0),
    height: Math.trunc(Number(display.bounds?.height) || 0),
  };
  const captureRect = screen.dipToScreenRect(null, bounds);
  return {
    id: String(display.id),
    name: String(display.label || '').trim() || (String(display.id) === primaryId ? 'Primary display' : `Display ${index + 1}`),
    primary: String(display.id) === primaryId,
    bounds,
    captureBounds: {
      x: Math.trunc(Number(captureRect?.x) || 0),
      y: Math.trunc(Number(captureRect?.y) || 0),
      width: Math.trunc(Number(captureRect?.width) || 0),
      height: Math.trunc(Number(captureRect?.height) || 0),
    },
    scaleFactor: Number(display.scaleFactor) || 1,
  };
}

function listRecordingDisplays() {
  const primaryId = String(screen.getPrimaryDisplay()?.id ?? '');
  return screen.getAllDisplays().map((display, index) => serializeRecordingDisplay(display, index, primaryId));
}

function settleRecordingRegionSelection(result, error = null) {
  const selectionWindow = regionSelectionWindow;
  const resolve = regionSelectionResolve;
  const reject = regionSelectionReject;
  regionSelectionWindow = null;
  regionSelectionDisplay = null;
  regionSelectionPromise = null;
  regionSelectionResolve = null;
  regionSelectionReject = null;

  if (selectionWindow && !selectionWindow.isDestroyed()) {
    selectionWindow.destroy();
  }
  if (error) {
    reject?.(error);
  } else {
    resolve?.(result);
  }
  if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

function cancelRecordingRegionSelection() {
  if (!regionSelectionPromise) {
    return false;
  }
  settleRecordingRegionSelection({ canceled: true, region: null });
  return true;
}

async function selectRecordingRegion(displayId) {
  if (regionSelectionPromise) {
    regionSelectionWindow?.focus();
    throw new Error('A region selection is already open. Finish or cancel it first.');
  }

  const rawDisplays = screen.getAllDisplays();
  const rawDisplay = rawDisplays.find((display) => String(display.id) === String(displayId || ''));
  if (!rawDisplay) {
    throw new Error('Choose an available display before selecting a region.');
  }
  const primaryId = String(screen.getPrimaryDisplay()?.id ?? '');
  const displayIndex = rawDisplays.indexOf(rawDisplay);
  regionSelectionDisplay = serializeRecordingDisplay(rawDisplay, displayIndex, primaryId);
  regionSelectionWindow = new BrowserWindow({
    x: regionSelectionDisplay.bounds.x,
    y: regionSelectionDisplay.bounds.y,
    width: regionSelectionDisplay.bounds.width,
    height: regionSelectionDisplay.bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'regionSelectionPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  regionSelectionWindow.setAlwaysOnTop(true, 'screen-saver');
  try {
    regionSelectionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // The selector remains always-on-top when this workspace hint is unavailable.
  }
  regionSelectionWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  regionSelectionWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  regionSelectionWindow.once('closed', () => {
    if (regionSelectionPromise) {
      settleRecordingRegionSelection({ canceled: true, region: null });
    }
  });

  regionSelectionPromise = new Promise((resolve, reject) => {
    regionSelectionResolve = resolve;
    regionSelectionReject = reject;
  });
  const selectionPromise = regionSelectionPromise;
  try {
    await regionSelectionWindow.loadFile(path.join(__dirname, 'region-selection.html'));
    if (!regionSelectionWindow || regionSelectionWindow.isDestroyed()) {
      throw new Error('The region selector closed before it was ready.');
    }
    regionSelectionWindow.show();
    regionSelectionWindow.focus();
  } catch (error) {
    settleRecordingRegionSelection(null, error);
  }
  return selectionPromise;
}

function submitRecordingRegionSelection(event, selection) {
  if (!regionSelectionWindow || event.sender !== regionSelectionWindow.webContents || !regionSelectionDisplay) {
    throw new Error('Local AI Hub refused a region selection from an unexpected window.');
  }
  const region = normalizeOverlaySelection(
    selection,
    regionSelectionDisplay,
    (dipRect) => screen.dipToScreenRect(regionSelectionWindow, dipRect),
  );
  settleRecordingRegionSelection({ canceled: false, region });
  return { accepted: true };
}

function buildTrayToolItems(tools = []) {
  return tools.length > 0
    ? tools.map((tool) => ({
        label: tool.status === 'running' ? `Stop ${tool.name}` : `Launch ${tool.name}`,
        click: async () => {
          try {
            if (tool.status === 'running') {
              await stopTool(tool);
              await maybeNotifyStoppedTool(tool);
            } else if (tool.launchSupported === false) {
              await shell.openPath(tool.installDir);
            } else {
              await launchToolFromExplicitUserAction(tool, {
                launchContext: 'tray-menu',
              });
            }
            await updateTrayMenu();
          } catch {
            return null;
          }
        },
      }))
    : [{ label: 'No tools installed yet', enabled: false }];
}

async function refreshTrayToolItems() {
  if (!trayToolRefreshPromise) {
    trayToolRefreshPromise = (async () => {
      await initializeToolRegistry();
      const tools = await buildMergedToolStateList({
        includeSnapshots: false,
        resolveStatuses: false,
      });
      cachedTrayToolItems = buildTrayToolItems(tools);
    })().finally(() => {
      trayToolRefreshPromise = null;
    });
  }

  await trayToolRefreshPromise;
}

function stopActiveRecordingFromTray() {
  if (trayRecordingStopPromise || !getActiveRecording()) {
    return trayRecordingStopPromise;
  }

  trayRecordingStopPromise = stopRecording()
    .then(() => invalidateStatisticsIndexSections(['storage'], 'recording-stopped').catch(() => null))
    .catch(() => null)
    .finally(() => {
      trayRecordingStopPromise = null;
      updateTrayMenu({ refreshTools: false }).catch(() => null);
    });
  return trayRecordingStopPromise;
}

function applyTrayMenu() {
  if (!tray) {
    return;
  }

  const activeRecording = getActiveRecording();
  const template = buildTrayMenuTemplate({
    activeRecording,
    quit: () => {
      requestAppQuit().catch((error) => reportShutdownError(error, { phase: 'tray-quit' }));
    },
    showWindow,
    stopRecording: stopActiveRecordingFromTray,
    toolItems: cachedTrayToolItems,
  });
  tray.setToolTip(getTrayTooltip(activeRecording));
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

async function updateTrayMenu(options = {}) {
  applyTrayMenu();
  if (options.refreshTools === false) {
    return;
  }

  await refreshTrayToolItems();
  applyTrayMenu();
}

function handleTrayClick() {
  if (getActiveRecording()) {
    tray?.popUpContextMenu();
    return;
  }

  showWindow();
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1160,
    minHeight: 760,
    backgroundColor: '#0a111d',
    autoHideMenuBar: true,
    icon: getAppIconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const rendererUrl = getRendererUrl();
  if (rendererUrl.startsWith('file://')) {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    mainWindow.loadURL(rendererUrl);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    broadcastWindowActivity(true);
  });

  mainWindow.on('focus', () => {
    broadcastWindowActivity(true);
  });

  mainWindow.on('blur', () => {
    broadcastWindowActivity(true);
  });

  mainWindow.on('show', () => {
    broadcastWindowActivity(true);
  });

  mainWindow.on('hide', () => {
    broadcastWindowActivity(true);
  });

  mainWindow.on('restore', () => {
    broadcastWindowActivity(true);
  });

  mainWindow.on('minimize', () => {
    broadcastWindowActivity(true);
  });

  mainWindow.on('close', (event) => {
    if (shutdownComplete) {
      return;
    }

    if (shouldMinimizeToTrayOnClose()) {
      event.preventDefault();
      mainWindow.hide();
      broadcastWindowActivity(true);
      return;
    }

    event.preventDefault();
    requestAppQuit().catch((error) => reportShutdownError(error, { phase: 'window-close' }));
  });
}

function sendInstallProgress(payload) {
  mainWindow?.webContents.send('tools:install-progress', payload);
}

function sendUpdateProgress(payload) {
  mainWindow?.webContents.send('tools:update-progress', payload);
}

function sendModelProgress(payload) {
  mainWindow?.webContents.send('models:download-progress', payload);
}

function sendToolState(payload) {
  mainWindow?.webContents.send('tools:tool-state', payload);
}

function sendUnexpectedStop(payload) {
  mainWindow?.webContents.send('tools:unexpected-stop', payload);
}

function sendToolUpdateSummary(payload) {
  mainWindow?.webContents.send('tools:update-summary', payload);
}

function toolLookup(toolId, tools) {
  const tool = tools.find((item) => item.id === toolId);
  if (!tool) {
    throw new Error('Local AI Hub could not find that installed tool.');
  }
  return tool;
}

function modelToolLookup(toolId, tools) {
  const tool = toolLookup(toolId, tools);
  if (!supportsModelManager(tool)) {
    throw new Error(`${tool.name} does not support the Model Manager yet.`);
  }
  return tool;
}

async function relaunchToolInBackground(toolId) {
  const state = await buildAppState();
  const tool = toolLookup(toolId, state.tools);
  await launchToolFromExplicitUserAction(tool, {
    skipOpenInterface: true,
    launchContext: 'notification-relaunch',
  });
  await notify('Local AI Hub', `${tool.name} is relaunching in the background.`).catch(() => null);
}

async function showUnexpectedStopNotification(payload) {
  if (!Notification.isSupported() || !payload?.toolId) {
    return;
  }

  const notification = new Notification({
    title: `${payload.toolName || 'A tool'} stopped`,
    body: payload.canRelaunch ? `${payload.message} Click Relaunch to start it again.` : payload.message,
    icon: getAppIconPath(),
    actions: payload.canRelaunch ? [{ type: 'button', text: 'Relaunch' }] : [],
    closeButtonText: 'Dismiss',
  });

  if (payload.canRelaunch) {
    notification.on('action', (_event, index) => {
      if (index === 0) {
        relaunchToolInBackground(payload.toolId).catch(() => null);
      }
    });

    notification.on('click', () => {
      relaunchToolInBackground(payload.toolId).catch(() => null);
    });
  } else {
    notification.on('click', showWindow);
  }

  notification.show();
}

async function checkRunningToolsHealth() {
  if (healthCheckBusy || isQuitting) {
    return;
  }

  healthCheckBusy = true;
  try {
    await initializeToolRegistry();
    const config = await readConfig();
    const activeRunningTools = [];
    const mergedTools = await buildMergedToolStateList({
      config,
      includeSnapshots: false,
      resolveStatuses: false,
      skipRegistryInit: true,
      syncDiscovered: false,
    });

    for (const mergedTool of mergedTools) {
      if (mergedTool.status !== 'running') {
        continue;
      }

      if (isToolRuntimeSettling(mergedTool.id)) {
        continue;
      }

      const active = await isToolActive(mergedTool).catch(() => false);
      if (active) {
        activeRunningTools.push(mergedTool);
        continue;
      }

      const message = `${mergedTool.name} stopped unexpectedly while it was running.`;
      await upsertTool({
        id: mergedTool.id,
        status: 'error',
        lastError: message,
      });
      const eventPayload = {
        toolId: mergedTool.id,
        toolName: mergedTool.name,
        status: 'error',
        lastError: message,
        message,
        canRelaunch: mergedTool.launchSupported !== false,
      };
      sendToolState(eventPayload);
      sendUnexpectedStop(eventPayload);
      await showUnexpectedStopNotification(eventPayload).catch(() => null);
    }

    if (activeRunningTools.length > 0) {
      await recordVramSample(activeRunningTools).catch(() => null);
    }

    await updateHealthMonitor({ hasRunningTools: activeRunningTools.length > 0 }).catch(() => null);
    await updateTrayMenu().catch(() => null);
  } finally {
    healthCheckBusy = false;
  }
}

async function runSilentToolUpdateCheck(tools = null) {
  if (toolUpdateCheckPromise) {
    return toolUpdateCheckPromise;
  }

  toolUpdateCheckPromise = (async () => {
    const toolList = tools || (await buildMergedToolStateList({ includeSnapshots: false, resolveStatuses: false }));
    await refreshInstalledToolUpdates(toolList).catch(() => null);
    const summary = await getToolUpdateSnapshot(toolList);
    sendToolUpdateSummary(summary);
    return summary;
  })();

  try {
    return await toolUpdateCheckPromise;
  } finally {
    toolUpdateCheckPromise = null;
  }
}

async function registerAssetLibraryPreviewProtocol() {
  if (registerAssetLibraryPreviewProtocol.registered) {
    return;
  }

  protocol.handle(PREVIEW_URL_SCHEME, async (request) => {
    try {
      const preview = await resolveAssetLibraryPreviewRequest(request.url);
      const buffer = await fs.promises.readFile(preview.filePath);
      return new Response(buffer, {
        headers: {
          'cache-control': 'no-store',
          'content-type': preview.mimeType,
        },
      });
    } catch (error) {
      return new Response(humanizeError(error, 'Local AI Hub could not load that asset preview.'), {
        status: 404,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
      });
    }
  });

  registerAssetLibraryPreviewProtocol.registered = true;
}
registerAssetLibraryPreviewProtocol.registered = false;
function isCancellationError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function getTabOwnedRequestKey(event, requestId) {
  const normalizedRequestId = String(requestId || '').trim().slice(0, 180);
  if (!normalizedRequestId) {
    return '';
  }
  return `${event.sender.id}:${normalizedRequestId}`;
}

async function runTabOwnedRequest(event, payload, scope, handler) {
  const requestKey = getTabOwnedRequestKey(event, payload?.requestId);
  if (!requestKey) {
    return handler(null);
  }

  const controllers = tabOwnedRequestControllers[scope];
  const previousController = controllers.get(requestKey);
  previousController?.abort();
  const controller = new AbortController();
  controllers.set(requestKey, controller);
  const abortOnDestroyed = () => controller.abort();
  event.sender.once('destroyed', abortOnDestroyed);

  try {
    return await handler(controller.signal);
  } finally {
    event.sender.removeListener('destroyed', abortOnDestroyed);
    if (controllers.get(requestKey) === controller) {
      controllers.delete(requestKey);
    }
  }
}

function cancelTabOwnedRequest(event, payload, scope) {
  const requestKey = getTabOwnedRequestKey(event, payload?.requestId);
  const controllers = tabOwnedRequestControllers[scope];
  const controller = requestKey ? controllers.get(requestKey) : null;
  if (!controller) {
    return { canceled: false };
  }
  controller.abort();
  controllers.delete(requestKey);
  return { canceled: true };
}
async function withPlainEnglishErrors(handler, fallbackMessage, options = {}) {
  try {
    const data = await handler();
    if (options.refreshMode === 'deferred') {
      updateHealthMonitor().catch(() => null);
      updateTrayMenu({ refreshTools: false }).catch(() => null);
    } else if (options.refreshMode !== 'none') {
      await updateHealthMonitor().catch(() => null);
      await updateTrayMenu();
    }
    return { ok: true, data };
  } catch (error) {
    if (options.allowCancellation && isCancellationError(error)) {
      return {
        canceled: true,
        ok: false,
      };
    }
    return {
      ok: false,
      message: humanizeError(error, fallbackMessage),
      ...(error?.diagnosticCategory ? { diagnosticCategory: error.diagnosticCategory } : {}),
      ...(error?.providerDiagnostics ? { providerDiagnostics: error.providerDiagnostics } : {}),
    };
  }
}

function registerIpcHandlers() {
  ipcMain.handle('app:bootstrap', () =>
    withPlainEnglishErrors(() => buildAppState({ forceDiscovery: true }), 'Local AI Hub could not load the app state.'),
  );

  ipcMain.handle('app:refresh', () =>
    withPlainEnglishErrors(buildAppState, 'Local AI Hub could not refresh the dashboard.'),
  );


  ipcMain.on('app:confirm-sync', (event, payload) => {
    try {
      event.returnValue = { ok: true, data: showConfirmDialogFromRenderer(payload) };
    } catch (error) {
      event.returnValue = {
        ok: false,
        message: humanizeError(error, 'Local AI Hub could not show that confirmation dialog.'),
      };
    }
  });
  ipcMain.handle('app:log-renderer-event', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const level = String(payload?.level || 'error').trim().toLowerCase();
      const message = String(payload?.message || 'Renderer event').trim() || 'Renderer event';
      const normalizedLevel = ['info', 'warn', 'error'].includes(level) ? level : 'error';
      const logPath = await appendLog('renderer', normalizedLevel, message, {
        context: payload?.context || {},
        source: String(payload?.source || 'renderer').trim() || 'renderer',
      });
      return { ok: true, logPath };
    }, 'Local AI Hub could not record the renderer diagnostic.'),
  );

  ipcMain.handle('app:get-live-resources', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const { managedRoot } = getAppPaths();
      return getLiveResourceUsage(managedRoot, {
        includeDisk: Boolean(payload?.includeDisk),
      });
    }, 'Local AI Hub could not refresh live system usage right now.'),
  );

  ipcMain.handle('diagnostics:copy-system-info', () =>
    withPlainEnglishErrors(async () => {
      const data = await collectSupportData({
        activePipelineRun: getActiveRunSnapshot(),
        appVersion: app.getVersion(),
        versions: process.versions,
      });
      const text = buildSystemInfoText(data);
      clipboard.writeText(text);
      return {
        message: 'System information copied. Review it before sharing.',
      };
    }, 'Local AI Hub could not copy the system information.', { refreshMode: 'none' }),
  );

  ipcMain.handle('diagnostics:create-bundle', () =>
    withPlainEnglishErrors(() => createDiagnosticsBundle({
      activePipelineRun: getActiveRunSnapshot(),
      appVersion: app.getVersion(),
      versions: process.versions,
    }), 'Local AI Hub could not create the diagnostics bundle.', { refreshMode: 'none' }),
  );

  ipcMain.handle('diagnostics:open-folder', () =>
    withPlainEnglishErrors(async () => {
      const diagnosticsRoot = getDiagnosticsRoot(await ensureStorage());
      await fs.promises.mkdir(diagnosticsRoot, { recursive: true });
      const result = await shell.openPath(diagnosticsRoot);
      if (result) throw new Error(result);
      return {
        diagnosticsRoot,
        message: 'Diagnostics folder opened.',
      };
    }, 'Local AI Hub could not open the diagnostics folder.', { refreshMode: 'none' }),
  );

  ipcMain.handle('app:get-window-activity', () =>
    withPlainEnglishErrors(async () => getWindowActivityPayload(), 'Local AI Hub could not read the current window activity.'),
  );
  ipcMain.handle('app:focus-window', (_event, payload) =>
    withPlainEnglishErrors(async () => focusMainWindowFromRenderer(payload?.reason), 'Local AI Hub could not restore app focus.'),
  );

  ipcMain.handle('app:complete-first-launch', () =>
    withPlainEnglishErrors(async () => {
      await markFirstLaunchComplete();
      return buildAppState();
    }, 'Local AI Hub could not save the first-launch state.'),
  );

  ipcMain.handle('app:open-logs-folder', () =>
    withPlainEnglishErrors(async () => {
      const { logsRoot } = await ensureStorage();
      await shell.openPath(logsRoot);
      return {
        message: 'Local AI Hub logs folder is open.',
      };
    }, 'Local AI Hub could not open the logs folder.'),
  );

  ipcMain.handle('app:open-path', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const targetPath = path.resolve(String(payload?.path || '').trim());
      if (!String(payload?.path || '').trim()) {
        throw new Error('Choose a file or folder first.');
      }

      if (!fs.existsSync(targetPath)) {
        throw new Error('Local AI Hub could not find that file or folder anymore.');
      }

      if (payload?.reveal) {
        shell.showItemInFolder(targetPath);
        return {
          message: 'Local AI Hub opened that location in File Explorer.',
        };
      }

      const result = await shell.openPath(targetPath);
      if (result) {
        throw new Error(result);
      }

      return {
        message: 'Local AI Hub opened that file or folder.',
      };
    }, 'Local AI Hub could not open that file or folder.'),
  );

  ipcMain.handle('recordings:select-region', (_event, payload) =>
    withPlainEnglishErrors(() => selectRecordingRegion(payload?.displayId), 'Local AI Hub could not open the region selector.', { refreshMode: 'none' }),
  );
  ipcMain.handle('recordings:region-selection-submit', (event, payload) =>
    withPlainEnglishErrors(async () => submitRecordingRegionSelection(event, payload), 'Local AI Hub could not use that selected region.', { refreshMode: 'none' }),
  );
  ipcMain.handle('recordings:region-selection-cancel', (event) =>
    withPlainEnglishErrors(async () => {
      if (!regionSelectionWindow || event.sender !== regionSelectionWindow.webContents) {
        throw new Error('Local AI Hub refused a region cancellation from an unexpected window.');
      }
      cancelRecordingRegionSelection();
      return { canceled: true };
    }, 'Local AI Hub could not close the region selector.', { refreshMode: 'none' }),
  );
  ipcMain.handle('recordings:list-displays', () =>
    withPlainEnglishErrors(async () => ({ displays: listRecordingDisplays() }), 'Local AI Hub could not read the available displays.', { refreshMode: 'none' }),
  );
  ipcMain.handle('recordings:list-devices', (_event, payload) =>
    withPlainEnglishErrors(() => listRecordingDevices({ forceRefresh: Boolean(payload?.forceRefresh) }), 'Local AI Hub could not refresh recording devices.', { refreshMode: 'none' }),
  );
  ipcMain.handle('recordings:get-active', () =>
    withPlainEnglishErrors(async () => ({ recording: getActiveRecording() }), 'Local AI Hub could not read the active recording.', { refreshMode: 'none' }),
  );
  ipcMain.handle('recordings:list', () =>
    withPlainEnglishErrors(async () => ({ recordings: await listRecentRecordings() }), 'Local AI Hub could not load recent recordings.', { refreshMode: 'none' }),
  );
  ipcMain.handle('recordings:start', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const recording = await startRecording(payload || {}, { displays: listRecordingDisplays() });
      return { recording, message: 'Recording started.' };
    }, 'Local AI Hub could not start that recording.', { refreshMode: 'deferred' }),
  );
  ipcMain.handle('recordings:stop', () =>
    withPlainEnglishErrors(async () => {
      const recording = await stopRecording();
      invalidateStatisticsIndexSections(['storage'], 'recording-stopped').catch(() => null);
      return { recording, message: recording?.status === 'completed' ? 'Recording saved.' : 'Recording stopped before clean finalization.' };
    }, 'Local AI Hub could not stop that recording cleanly.', { refreshMode: 'deferred' }),
  );
  ipcMain.handle('recordings:cancel', () =>
    withPlainEnglishErrors(async () => {
      const recording = await cancelRecording();
      invalidateStatisticsIndexSections(['storage'], 'recording-canceled').catch(() => null);
      return { recording, message: recording?.status === 'canceled' ? 'Recording canceled.' : 'Recording was interrupted while canceling.' };
    }, 'Local AI Hub could not cancel that recording.', { refreshMode: 'deferred' }),
  );
  ipcMain.handle('recordings:open', (_event, payload) =>
    withPlainEnglishErrors(() => openRecording(payload?.id, (targetPath) => shell.openPath(targetPath)), 'Local AI Hub could not open that recording.'),
  );
  ipcMain.handle('recordings:reveal', (_event, payload) =>
    withPlainEnglishErrors(() => revealRecording(payload?.id, (targetPath) => shell.showItemInFolder(targetPath)), 'Local AI Hub could not reveal that recording.'),
  );
  ipcMain.handle('recordings:open-folder', () =>
    withPlainEnglishErrors(() => openRecordingsFolder((targetPath) => shell.openPath(targetPath)), 'Local AI Hub could not open the recordings folder.'),
  );
  ipcMain.handle('recordings:delete', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const config = await readConfig();
      const result = await deleteRecording(payload?.id, {
        deleteMode: config.moveDeletedPipelineOutputsToRecycleBin !== false ? 'trash' : 'permanent',
        trashItem: (targetPath) => shell.trashItem(targetPath),
      });
      await invalidateStatisticsIndexSections(['storage'], 'recording-deleted').catch(() => null);
      return result;
    }, 'Local AI Hub could not delete that recording.'),
  );

  ipcMain.handle('asset-libraries:list', (_event, payload) =>
    withPlainEnglishErrors(async () => ({
      libraries: await listAssetLibraries(typeof payload === 'string' ? payload : payload?.type),
    }), 'Local AI Hub could not load asset libraries.'),
  );

  ipcMain.handle('asset-libraries:create', (_event, payload) =>
    withPlainEnglishErrors(async () => createAssetLibrary(payload?.type, payload?.name), 'Local AI Hub could not create that asset library.'),
  );

  ipcMain.handle('asset-libraries:rename', (_event, payload) =>
    withPlainEnglishErrors(async () => renameAssetLibrary(payload?.type, payload?.libraryId, payload?.name), 'Local AI Hub could not rename that asset library.'),
  );

  ipcMain.handle('asset-libraries:delete', (_event, payload) =>
    withPlainEnglishErrors(async () => deleteAssetLibrary(payload?.type, payload?.libraryId), 'Local AI Hub could not delete that asset library.'),
  );

  ipcMain.handle('asset-libraries:pick-files', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const type = String(payload?.type || '').trim();
      const pickerConfig = {
        soundEffects: {
          title: 'Import sound effect files',
          filters: [
            { name: 'Audio files', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] },
            { name: 'All files', extensions: ['*'] },
          ],
        },
        fonts: {
          title: 'Import font files',
          filters: [
            { name: 'Font files', extensions: ['ttf', 'otf'] },
            { name: 'All files', extensions: ['*'] },
          ],
        },
      };
      if (!pickerConfig[type] || !LIBRARY_TYPES[type]) {
        throw new Error('Choose Sound Effects or Fonts before importing files.');
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: pickerConfig[type].title,
        properties: ['openFile', 'multiSelections'],
        filters: pickerConfig[type].filters,
      });
      return {
        canceled: Boolean(result.canceled),
        filePaths: result.filePaths || [],
      };
    }, 'Local AI Hub could not open the asset import picker.'),
  );

  ipcMain.handle('asset-libraries:get-preview', (_event, payload) =>
    withPlainEnglishErrors(async () => getAssetLibraryItemPreview(payload?.type, payload?.libraryId, payload?.itemId), 'Local AI Hub could not prepare that asset preview.'),
  );
  ipcMain.handle('asset-libraries:import-items', (_event, payload) =>
    withPlainEnglishErrors(async () => importAssetLibraryItems(payload?.type, payload?.libraryId, payload?.files), 'Local AI Hub could not import those asset files.'),
  );

  ipcMain.handle('asset-libraries:remove-item', (_event, payload) =>
    withPlainEnglishErrors(async () => removeAssetLibraryItem(payload?.type, payload?.libraryId, payload?.itemId), 'Local AI Hub could not remove that asset library item.'),
  );

  ipcMain.handle('asset-libraries:update-color', (_event, payload) =>
    withPlainEnglishErrors(async () => updateColorPaletteItem(payload?.libraryId, payload?.item), 'Local AI Hub could not save that color.'),
  );
  ipcMain.handle('tools:install', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const toolId = typeof payload === 'string' ? payload : payload?.toolId;
      const tool = await installTool(toolId, {
        capability: payload?.capability || payload?.installCapability || null,
        installRoot: payload?.installRoot || null,
        lowDiskConfirmed: Boolean(payload?.lowDiskConfirmed),
        onGuidedInstallerComplete: async () => {
          invalidateDiscoveryCache();
          await refreshOpenAppState({ forceDiscovery: true });
        },
        onProgress: (progressPayload) => sendInstallProgress(progressPayload),
      });
      invalidateDiscoveryCache();
      await invalidateStatisticsIndexSections(['storage'], 'tool-installed', { toolId }).catch(() => null);
      return {
        message:
          tool.installActionMessage ||
          (tool.reusedExistingInstall ? `${tool.name} is already ready to use.` : `${tool.name} was installed successfully.`),
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not install that tool.'),
  );

  ipcMain.handle('tools:get-install-preflight', (_event, payload) =>
    withPlainEnglishErrors(async () => getToolInstallPreflight(payload), 'Local AI Hub could not check disk space for that install.'),
  );

  ipcMain.handle('tools:launch', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      let releaseLaunchSupportRuntime = null;
      try {
        const toolId = typeof payload === 'string' ? payload : payload?.toolId;
        const state = await buildAppState();
        const tool = toolLookup(toolId, state.tools);
        if (tool.launchSupported === false) {
          await shell.openPath(tool.installDir);
          return {
            message: `${tool.name}'s folder is open.`,
            state,
          };
        }

        const requestedLaunchMode = typeof payload === 'object' && payload
          ? String(payload.launchMode || payload.launchModeId || '').trim().toLowerCase()
          : '';
        const launchOptions = requestedLaunchMode
          ? { launchMode: requestedLaunchMode }
          : {};
        if (tool.id === 'aider') {
          const projectDir = String(payload?.projectDir || tool.lastProjectDir || '').trim();
          const aiderSession = payload?.aiderSession || {};
          const aiderLaunch = await buildAiderLaunchConfiguration({
            tool,
            ollamaTool: toolLookup('ollama', state.tools),
            providers: state.providers || [],
            projectDir,
            providerId: aiderSession.providerId || tool.aiderProviderId || '',
            modelId: aiderSession.modelId || tool.aiderModelId || '',
            initializeGit: aiderSession.initializeGit !== undefined ? aiderSession.initializeGit : tool.aiderInitializeGit !== false,
          });
          if (aiderLaunch.selection.modelEntry.aiderModel.startsWith('ollama_chat/')) {
            const ollamaTool = toolLookup('ollama', state.tools);
            if (!ollamaTool) {
              throw new Error('Install or detect Ollama before launching an Ollama-backed Aider session.');
            }
            const ollamaSession = await prepareOllamaSession(ollamaTool, {
              autoStart: true,
              launchContext: 'aider-session',
            });
            let ollamaSessionReleased = false;
            releaseLaunchSupportRuntime = async () => {
              if (ollamaSessionReleased) {
                return;
              }
              ollamaSessionReleased = true;
              await finishOllamaSession(ollamaSession);
            };
            await waitForOllamaReady(ollamaSession.tool || ollamaTool, {
              actionLabel: 'start Aider with the selected Ollama model',
              alreadyActive: Boolean(ollamaSession.alreadyActive),
              autoStartAttempted: Boolean(ollamaSession.autoStarted || ollamaSession.launchAttempted),
            });
            if (ollamaSession.startedByLocalAIHub) {
              await refreshOwnedOllamaSessionProcesses(ollamaSession).catch(() => []);
              launchOptions.onStopCleanup = releaseLaunchSupportRuntime;
            } else {
              releaseLaunchSupportRuntime = null;
            }
          }
          launchOptions.launchProfileOverride = aiderLaunch.launchProfileOverride;
          launchOptions.successMessage = aiderLaunch.launchMessage;
          await upsertTool({
            id: tool.id,
            ...aiderLaunch.persistedFields,
          });
        }
        if (tool.id === 'koboldcpp' && requestedLaunchMode !== 'desktop') {
          const koboldLaunch = await buildKoboldCppLaunchConfiguration(tool);
          launchOptions.launchProfileOverride = koboldLaunch.launchProfileOverride;
          launchOptions.successMessage = koboldLaunch.launchMessage;
        }

        const { nextState, nextTool } = await launchToolFromExplicitUserAction(tool, {
          ...launchOptions,
          launchContext: 'ipc-launch',
        });
        releaseLaunchSupportRuntime = null;
        let message = launchOptions.successMessage || `${nextTool.name} is starting.`;
        if (!launchOptions.successMessage && String(nextTool.interfaceMode || '').startsWith('embedded-')) {
          if (nextTool.interfaceMode === 'embedded-whisper') {
            message = `${nextTool.name} is ready. Local AI Hub opened its transcription view.`;
          } else if (nextTool.interfaceMode === 'embedded-chat') {
            message = `${nextTool.name} is starting. Local AI Hub opened its chat view.`;
          } else if (nextTool.interfaceMode === 'embedded-terminal') {
            message = `${nextTool.name} is ready. Local AI Hub opened its built-in console.`;
          }
        }
        if (nextTool?.lastLaunchWarning && !message.includes(nextTool.lastLaunchWarning)) {
          message += '\n\n' + nextTool.lastLaunchWarning;
        }
        return {
          message,
          state: nextState,
        };
      } catch (error) {
        if (typeof releaseLaunchSupportRuntime === 'function') {
          await releaseLaunchSupportRuntime().catch(() => null);
        }
        invalidateDiscoveryCache();
        await refreshOpenAppState({ forceDiscovery: true }).catch(() => null);
        throw error;
      }
    }, 'Local AI Hub could not start that tool.'),
  );

  ipcMain.handle('tools:stop', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      await stopTool(tool);
      await maybeNotifyStoppedTool(tool);
      return {
        message: getStopMessage(tool),
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not stop that tool.'),
  );

  ipcMain.handle('tools:update', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const toolId = typeof payload === 'string' ? payload : payload?.toolId;
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      await prepareToolForMaintenance(tool);

      const updatedTool = await updateToolInstallation(tool, {
        onProgress: (progressPayload) => sendUpdateProgress(progressPayload),
      });
      invalidateDiscoveryCache();
      await invalidateStatisticsIndexSections(['storage'], 'tool-updated', { toolId }).catch(() => null);
      const nextState = await buildAppState({ forceDiscovery: true });
      await refreshInstalledToolUpdates(nextState.tools).catch(() => null);
      nextState.toolUpdates = await getToolUpdateSnapshot(nextState.tools);
      sendToolUpdateSummary(nextState.toolUpdates);
      return {
        message: updatedTool.lastUpdateMessage || 'Local AI Hub updated ' + tool.name + '.',
        state: nextState,
      };
    }, 'Local AI Hub could not update that tool.'),
  );

  ipcMain.handle('tools:repair', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const toolId = typeof payload === 'string' ? payload : payload?.toolId;
      const capability = typeof payload === 'string' ? null : payload?.capability || payload?.installCapability || null;
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      await prepareToolForMaintenance(tool);
      const repairedTool = await repairToolInstallation(tool, {
        capability,
        onProgress: (progressPayload) => sendInstallProgress(progressPayload),
        removeOrphanedToolFolders: Boolean(payload?.removeOrphanedToolFolders),
      });
      invalidateDiscoveryCache();
      await invalidateStatisticsIndexSections(['storage'], 'tool-repaired', { toolId }).catch(() => null);
      return {
        message: repairedTool.lastRepairMessage,
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not repair that tool.'),
  );

  ipcMain.handle('tools:get-repair-preview', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      return inspectToolRepair(tool);
    }, 'Local AI Hub could not inspect that repair right now.'),
  );

  ipcMain.handle('tools:uninstall', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const toolId = typeof payload === 'string' ? payload : payload?.toolId;
      const capability = typeof payload === 'string' ? null : payload?.capability || payload?.installCapability || null;
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      if (tool.source === 'managed') {
        await prepareToolForMaintenance(tool);
      }
      const removedTool = await uninstallTool(tool, { capability });
      invalidateDiscoveryCache();
      await invalidateStatisticsIndexSections(['storage'], 'tool-uninstalled', { toolId: tool.id }).catch(() => null);
      return {
        message: removedTool.uninstallMessage || `${tool.name} was removed from Local AI Hub.`,
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not uninstall that tool.'),
  );

  ipcMain.handle('settings:pick-storage-folder', () =>
    withPlainEnglishErrors(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a storage folder for Local AI Hub',
        properties: ['openDirectory', 'createDirectory'],
      });

      return {
        canceled: Boolean(result.canceled),
        folderPath: result.filePaths?.[0] || '',
      };
    }, 'Local AI Hub could not open the storage folder picker.'),
  );

  ipcMain.handle('settings:set-storage-location', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const requestedPath = String(payload?.targetPath || '').trim();
      if (!requestedPath) {
        throw new Error('Choose a storage folder before saving the new location.');
      }

      const parsedPath = path.parse(requestedPath);
      const normalizedTargetPath = requestedPath === parsedPath.root ? path.join(requestedPath, 'LocalAIHub') : requestedPath;
      await setManagedDataRoot(normalizedTargetPath, {
        migrateExistingData: Boolean(payload?.migrateExistingData),
        migrationSourceRoot: payload?.migrationSourceRoot || null,
      });
      invalidateDiscoveryCache();
      await invalidateStatisticsIndexSections(['storage'], 'storage-location-changed', { targetPath: normalizedTargetPath }).catch(() => null);
      return {
        message: `Large Local AI Hub data will now use ${normalizedTargetPath}. Direct Local AI Hub-managed tool folders can move there when you choose migration, but official-installer apps stay in their current Windows install location until you reinstall them.`,
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not save the new storage folder.'),
  );

  ipcMain.handle('settings:save-preferred-install-root', (_event, targetPath) =>
    withPlainEnglishErrors(async () => {
      const requestedPath = String(targetPath || '').trim();
      if (!requestedPath) {
        throw new Error('Choose a default install folder before saving it.');
      }

      const parsedPath = path.parse(requestedPath);
      const normalizedTargetPath = requestedPath === parsedPath.root ? path.join(requestedPath, 'LocalAIHub') : requestedPath;
      await updateConfig((config) => ({
        ...config,
        preferredInstallRoot: normalizedTargetPath,
      }));
      invalidateDiscoveryCache();
      await invalidateStatisticsIndexSections(['storage'], 'preferred-install-root-changed', { targetPath: normalizedTargetPath }).catch(() => null);
      return {
        message: `New store installs will default to ${normalizedTargetPath}. Tools that use an external official installer may still ask you to confirm or change the final destination.`,
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not save the default install folder.'),
  );
  ipcMain.handle('settings:dismiss-legacy-migration', (_event, sourceRoot) =>
    withPlainEnglishErrors(async () => {
      await dismissManagedDataMigration(sourceRoot);
      return {
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not update the migration reminder.'),
  );

  ipcMain.handle('settings:save-close-behavior', (_event, closeBehavior) =>
    withPlainEnglishErrors(async () => {
      const nextCloseBehavior = normalizeCloseBehavior(closeBehavior);
      await updateConfig((config) => ({
        ...config,
        closeBehavior: nextCloseBehavior,
      }));
      setCloseBehaviorPreference(nextCloseBehavior);
      return {
        message:
          nextCloseBehavior === 'exit'
            ? 'Local AI Hub will fully exit when you click the close button.'
            : 'Local AI Hub will hide to the tray when you click the close button.',
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not save that close-button setting.'),
  );

  ipcMain.handle('settings:save-home-checklist-dismissed', (_event, dismissed) =>
    withPlainEnglishErrors(async () => {
      const homeChecklistDismissed = Boolean(dismissed);
      await updateConfig((config) => ({
        ...config,
        homeChecklistDismissed,
      }));
      sendAppStateUpdate({ settings: { homeChecklistDismissed } });
      return { homeChecklistDismissed };
    }, 'Local AI Hub could not save that Home checklist preference.', { refreshMode: 'none' }),
  );

  ipcMain.handle('settings:save-live-resource-polling', (_event, enabled) =>
    withPlainEnglishErrors(async () => {
      const liveResourcePolling = Boolean(enabled);
      await updateConfig((config) => ({
        ...config,
        liveResourcePolling,
      }));
      return {
        message: liveResourcePolling
          ? 'Live RAM and VRAM polling is now on. Local AI Hub will refresh those readings more gently in the background.'
          : 'Live RAM and VRAM polling is now off. Local AI Hub will keep a quieter snapshot instead of refreshing continuously.',
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not save the live usage polling setting.'),
  );

  ipcMain.handle('updates:check', () =>
    withPlainEnglishErrors(async () => {
      const update = await appUpdateService.checkForUpdates();
      sendAppStateUpdate({ appUpdate: update });
      return update;
    }, 'Local AI Hub could not check for updates right now.', { refreshMode: 'none' }),
  );

  ipcMain.handle('updates:cancel-check', () =>
    withPlainEnglishErrors(async () => {
      appUpdateService.cancelUpdateCheck();
      return { message: 'Update check stopped.' };
    }, 'Local AI Hub could not stop that update check.', { refreshMode: 'none' }),
  );

  ipcMain.handle('updates:save-check-on-launch', (_event, enabled) =>
    withPlainEnglishErrors(async () => {
      const result = await appUpdateService.saveCheckOnLaunch(enabled);
      sendAppStateUpdate({
        appUpdate: result.update,
        settings: { checkForUpdatesOnLaunch: result.checkForUpdatesOnLaunch },
      });
      return result;
    }, 'Local AI Hub could not save that update-check setting.', { refreshMode: 'none' }),
  );

  ipcMain.handle('updates:open-target', (_event, target) =>
    withPlainEnglishErrors(
      () => appUpdateService.openUpdateTarget(target),
      'Local AI Hub could not open that trusted GitHub release link.',
      { refreshMode: 'none' },
    ),
  );

  ipcMain.handle('settings:save-pipeline-output-trash', (_event, enabled) =>
    withPlainEnglishErrors(async () => {
      const moveDeletedPipelineOutputsToRecycleBin = enabled !== false;
      await updateConfig((config) => ({
        ...config,
        moveDeletedPipelineOutputsToRecycleBin,
      }));
      return {
        message: moveDeletedPipelineOutputsToRecycleBin
          ? 'Deleted pipeline outputs will move to the Recycle Bin when Windows allows it.'
          : 'Deleted pipeline outputs will be permanently removed from disk. This cannot be easily undone.',
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not save the pipeline output deletion setting.'),
  );
  ipcMain.handle('settings:get-cleanup-preview', () =>
    withPlainEnglishErrors(() => inspectCleanupTargets(), 'Local AI Hub could not scan the approved cleanup folders right now.'),
  );

  ipcMain.handle('settings:run-cleanup', () =>
    withPlainEnglishErrors(async () => {
      const cleanupSummary = await runCleanup();
      await invalidateStatisticsIndexSections(['storage'], 'storage-cleanup').catch(() => null);
      const removedCount = cleanupSummary.removedEntries?.length || 0;
      const failedCount = cleanupSummary.failedEntries?.length || 0;
      const message = failedCount
        ? removedCount
          ? `Cleanup removed ${removedCount} leftover item${removedCount === 1 ? '' : 's'}, but ${failedCount} item${failedCount === 1 ? ' is' : 's are'} still being used by Windows. Close any app or File Explorer window using those folders, then run Cleanup again.`
          : cleanupSummary.failedEntries[0]?.message || 'Cleanup could not remove those leftover files because Windows is still using them.'
        : 'Cleanup finished.';
      return {
        cleanupSummary,
        message,
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not remove those leftover files.'),
  );

  ipcMain.handle('settings:get-statistics-core', (event, payload = {}) =>
    withPlainEnglishErrors(() => runTabOwnedRequest(event, payload, 'statistics', async (signal) => {
      const startedAt = Date.now();
      const configStartedAt = Date.now();
      const config = await readConfig();
      const tools = Object.values(config.tools || {});
      const configMs = Date.now() - configStartedAt;
      const runningTools = tools.filter((tool) => tool.status === 'running');
      const vramStartedAt = Date.now();
      if (runningTools.length > 0) {
        await recordVramSample(runningTools).catch(() => null);
      }
      const vramSampleMs = Date.now() - vramStartedAt;
      const snapshotStartedAt = Date.now();
      const snapshot = await getStatisticsCoreSnapshot(tools, { signal });
      appendLog('statistics', 'info', 'Statistics core IPC request completed.', {
        totalMs: Date.now() - startedAt,
        configMs,
        vramSampleMs,
        snapshotMs: Date.now() - snapshotStartedAt,
        toolCount: tools.length,
        runningToolCount: runningTools.length,
      }).catch(() => null);
      return snapshot;
    }), 'Local AI Hub could not load the main statistics right now.', { allowCancellation: true }),
  );

  ipcMain.handle('settings:get-statistics-storage', (event, payload = {}) =>
    withPlainEnglishErrors(() => runTabOwnedRequest(event, payload, 'statistics', async (signal) => {
      const startedAt = Date.now();
      const toolsStartedAt = Date.now();
      const tools = await buildMergedToolStateList({
        includeSnapshots: false,
        resolveStatuses: false,
      });
      const toolStateMs = Date.now() - toolsStartedAt;
      const snapshotStartedAt = Date.now();
      const snapshot = await getStatisticsStorageSnapshot(tools, {
        forceRefresh: Boolean(payload?.forceRefresh || payload?.refresh || payload?.rebuildIndex),
        signal,
      });
      appendLog('statistics', 'info', 'Statistics storage IPC request completed.', {
        totalMs: Date.now() - startedAt,
        toolStateMs,
        snapshotMs: Date.now() - snapshotStartedAt,
        toolCount: tools.length,
      }).catch(() => null);
      return snapshot;
    }), 'Local AI Hub could not load storage statistics right now.', { allowCancellation: true }),
  );

  ipcMain.handle('settings:get-statistics', (event, payload = {}) =>
    withPlainEnglishErrors(() => runTabOwnedRequest(event, payload, 'statistics', async (signal) => {
      const startedAt = Date.now();
      const toolsStartedAt = Date.now();
      const tools = await buildMergedToolStateList({
        includeSnapshots: false,
        resolveStatuses: false,
      });
      const toolStateMs = Date.now() - toolsStartedAt;
      const runningTools = tools.filter((tool) => tool.status === 'running');
      const vramStartedAt = Date.now();
      if (runningTools.length > 0) {
        await recordVramSample(runningTools).catch(() => null);
      }
      const vramSampleMs = Date.now() - vramStartedAt;
      const snapshotStartedAt = Date.now();
      const snapshot = await getStatisticsSnapshot(tools, {
        forceRefresh: Boolean(payload?.forceRefresh || payload?.refresh || payload?.rebuildIndex),
        signal,
      });
      appendLog('statistics', 'info', 'Statistics full IPC request completed.', {
        totalMs: Date.now() - startedAt,
        toolStateMs,
        vramSampleMs,
        snapshotMs: Date.now() - snapshotStartedAt,
        toolCount: tools.length,
        runningToolCount: runningTools.length,
      }).catch(() => null);
      return snapshot;
    }), 'Local AI Hub could not load the statistics screen right now.', { allowCancellation: true }),
  );

  ipcMain.handle('settings:cancel-statistics-request', (event, payload = {}) =>
    withPlainEnglishErrors(() => cancelTabOwnedRequest(event, payload, 'statistics'), 'Local AI Hub could not cancel that statistics request.', { refreshMode: 'none' }),
  );
  ipcMain.handle('providers:list', () =>
    withPlainEnglishErrors(async () => listProviderConnections(), 'Local AI Hub could not load the cloud provider list.'),
  );

  ipcMain.handle('providers:save-key', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const provider = await saveProviderConnection(payload?.providerId, payload?.apiKey);
      return {
        message: `${provider.name} credentials were saved in Windows Credential Manager.`,
        provider,
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not save that cloud provider key.'),
  );

  ipcMain.handle('providers:test', (_event, providerId) =>
    withPlainEnglishErrors(async () => {
      const result = await testProviderConnection(providerId);
      return {
        ...result,
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not test that cloud provider connection.'),
  );

  ipcMain.handle('providers:disconnect', (_event, providerId) =>
    withPlainEnglishErrors(async () => {
      const result = await disconnectProvider(providerId);
      return {
        message: `${result.providerName} was disconnected from this PC.`,
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not disconnect that cloud provider.'),
  );

  ipcMain.handle('providers:list-models', (_event, providerId) =>
    withPlainEnglishErrors(async () => listProviderModels(providerId), 'Local AI Hub could not load models for that cloud provider.'),
  );

  ipcMain.handle('providers:chat', (_event, payload) =>
    withPlainEnglishErrors(async () => chatWithProvider(payload?.providerId, payload), 'Local AI Hub could not send that cloud provider message.'),
  );

  ipcMain.handle('tools:open-folder', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      await shell.openPath(tool.installDir);
      return {
        message: `${tool.name}'s folder is open.`,
      };
    }, 'Local AI Hub could not open that folder.'),
  );

  ipcMain.handle('aider:pick-project-folder', () =>
    withPlainEnglishErrors(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a project folder for Aider',
        properties: ['openDirectory', 'createDirectory'],
      });

      return {
        canceled: Boolean(result.canceled),
        folderPath: result.filePaths?.[0] || '',
      };
    }, 'Local AI Hub could not open the project folder picker.'),
  );

  ipcMain.handle('aider:inspect-project', (_event, projectDir) =>
    withPlainEnglishErrors(async () => inspectAiderProject(projectDir), 'Local AI Hub could not inspect that Aider project folder.'),
  );

  ipcMain.handle('aider:list-models', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      return listAiderLaunchModels({
        providerId: payload?.providerId,
        preferredModelId: payload?.preferredModelId,
        ollamaTool: toolLookup('ollama', state.tools),
        providers: state.providers || [],
      });
    }, 'Local AI Hub could not load models for that Aider provider.'),
  );

  ipcMain.handle('tools:get-runtime-output', (_event, toolId) =>
    withPlainEnglishErrors(async () => getRuntimeOutputSnapshot(toolId), 'Local AI Hub could not load that tool console.'),
  );

  ipcMain.handle('tools:send-input', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(payload.toolId, state.tools);
      sendInputToTool(tool.id, payload.input, {
        appendNewline: payload.appendNewline !== false,
      });
      return {
        message: `${tool.name} received your command.`,
      };
    }, 'Local AI Hub could not send that input to the tool.'),
  );

  ipcMain.handle('models:get-settings', () =>
    withPlainEnglishErrors(() => readModelSettings(), 'Local AI Hub could not load the Model Manager settings.'),
  );

  ipcMain.handle('models:save-settings', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const settings = await saveModelManagerSettings(payload || {});
      return {
        message: 'Model Manager settings were saved on this PC. Sensitive keys are stored in Windows Credential Manager.',
        settings,
      };
    }, 'Local AI Hub could not save the Model Manager settings.'),
  );

  ipcMain.handle('models:browse', (event, payload = {}) =>
    withPlainEnglishErrors(() => runTabOwnedRequest(event, payload, 'modelCatalog', async (signal) => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      return browseRemoteModels(tool, payload, { signal });
    }), 'Local AI Hub could not load remote models right now.', { allowCancellation: true }),
  );

  ipcMain.handle('models:cancel-browse', (event, payload = {}) =>
    withPlainEnglishErrors(() => cancelTabOwnedRequest(event, payload, 'modelCatalog'), 'Local AI Hub could not cancel that catalog request.', { refreshMode: 'none' }),
  );

  ipcMain.handle('models:list-local', (event, payload = {}) =>
    withPlainEnglishErrors(() => runTabOwnedRequest(event, payload, 'modelCatalog', async (signal) => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      return listDownloadedModels(tool, { signal });
    }), 'Local AI Hub could not load the downloaded models for that tool.', { allowCancellation: true }),
  );

  ipcMain.handle('models:list-tool-assets', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      return listToolAssets(tool, payload || {});
    }, 'Local AI Hub could not refresh the local tool assets for that pipeline step.'),
  );

  ipcMain.handle('models:get-download-preflight', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      return getModelDownloadPreflight(tool, payload);
    }, 'Local AI Hub could not check disk space for that model download.'),
  );

  ipcMain.handle('models:download', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      const result = await downloadModel(tool, payload, {
        onProgress: (progress) => sendModelProgress({
          toolId: payload.toolId,
          ...progress,
        }),
      });
      const localModels = await listDownloadedModels(tool);
      await invalidateStatisticsIndexSections(['storage'], 'model-downloaded', { toolId: tool.id }).catch(() => null);
      sendAppStateUpdate({
        downloadedModelCount: await getDownloadedModelCountSnapshot(),
      });
      return {
        message: result.message,
        localModels,
      };
    }, 'Local AI Hub could not download that model.'),
  );

  ipcMain.handle('models:delete', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      const result = await deleteModel(tool, payload);
      const localModels = await listDownloadedModels(tool);
      await invalidateStatisticsIndexSections(['storage'], 'model-deleted', { toolId: tool.id }).catch(() => null);
      sendAppStateUpdate({
        downloadedModelCount: await getDownloadedModelCountSnapshot(),
      });
      return {
        message: result.message,
        localModels,
      };
    }, 'Local AI Hub could not delete that model.'),
  );

  ipcMain.handle('koboldcpp:get-setup', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const toolId = typeof payload === 'string' ? payload : payload?.toolId || 'koboldcpp';
      const tool = toolLookup(toolId, state.tools);
      if (tool.id !== 'koboldcpp') {
        throw new Error('Only KoboldCpp uses this Local AI Hub model setup flow.');
      }

      return getKoboldCppSetup(tool);
    }, 'Local AI Hub could not load KoboldCpp setup.'),
  );

  ipcMain.handle('koboldcpp:pick-model', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const toolId = typeof payload === 'string' ? payload : payload?.toolId || 'koboldcpp';
      const tool = toolLookup(toolId, state.tools);
      if (tool.id !== 'koboldcpp') {
        throw new Error('Only KoboldCpp uses this Local AI Hub model picker.');
      }

      const requestedPath = String(payload?.currentPath || tool.launchSelection?.filePath || '').trim();
      const defaultPath = requestedPath
        ? path.extname(requestedPath)
          ? path.dirname(requestedPath)
          : requestedPath
        : getAppPaths().modelsRoot;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a GGUF model for KoboldCpp',
        defaultPath,
        properties: ['openFile'],
        filters: [
          { name: 'GGUF models', extensions: ['gguf'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });

      return {
        canceled: Boolean(result.canceled),
        filePath: result.filePaths?.[0] || '',
      };
    }, 'Local AI Hub could not open the KoboldCpp model picker.'),
  );

  ipcMain.handle('koboldcpp:save-setup', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const toolId = typeof payload === 'string' ? payload : payload?.toolId || 'koboldcpp';
      const tool = toolLookup(toolId, state.tools);
      if (tool.id !== 'koboldcpp') {
        throw new Error('Only KoboldCpp uses this Local AI Hub model setup flow.');
      }

      const savedSetup = await saveKoboldCppLaunchSelection(tool, payload || {});
      const nextState = await buildAppState();
      const nextTool = toolLookup(tool.id, nextState.tools);
      return {
        message: savedSetup.message,
        setup: await getKoboldCppSetup(nextTool),
        state: nextState,
      };
    }, 'Local AI Hub could not save the KoboldCpp model selection.'),
  );

  ipcMain.handle('whisper:pick-audio-file', () =>
    withPlainEnglishErrors(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose an audio file',
        properties: ['openFile'],
        filters: [
          { name: 'Audio files', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'mp4', 'mkv', 'webm'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });

      return {
        canceled: Boolean(result.canceled),
        filePath: result.filePaths?.[0] || '',
      };
    }, 'Local AI Hub could not open the audio picker.'),
  );

  ipcMain.handle('pipelines:pick-file', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const kind = String(payload?.kind || 'file').trim().toLowerCase();
      const pickerMap = {
        audio: {
          title: 'Choose an audio file',
          filters: [
            { name: 'Audio files', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma'] },
            { name: 'All files', extensions: ['*'] },
          ],
        },
        file: {
          title: 'Choose a file',
          filters: [{ name: 'All files', extensions: ['*'] }],
        },
        image: {
          title: 'Choose an image file',
          filters: [
            { name: 'Image files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
            { name: 'All files', extensions: ['*'] },
          ],
        },
        video: {
          title: 'Choose a video file',
          filters: [
            { name: 'Video files', extensions: ['mp4', 'mkv', 'mov', 'webm'] },
            { name: 'All files', extensions: ['*'] },
          ],
        },
      };
      const picker = pickerMap[kind] || pickerMap.file;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: picker.title,
        properties: ['openFile'],
        filters: picker.filters,
      });

      return {
        canceled: Boolean(result.canceled),
        filePath: result.filePaths?.[0] || '',
      };
    }, 'Local AI Hub could not open that file picker.'),
  );

  ipcMain.handle('whisper:transcribe', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup('whisper', state.tools);
      return transcribeWithWhisper(tool, payload);
    }, 'Local AI Hub could not transcribe that audio file.'),
  );

  ipcMain.handle('ollama:list-models', (_event, options) =>
    withPlainEnglishErrors(async () => {
      const requestOptions = options || {};
      const state = await buildAppState();
      const tool = toolLookup('ollama', state.tools);
      if (requestOptions.preferLocalLibrary && !requestOptions.autoStart && String(tool?.status || '').trim().toLowerCase() !== 'running') {
        const localModels = await listDownloadedModels(tool);
        return {
          baseUrl: '',
          fromLibraryState: true,
          models: localModels.map((model) => ({
            modifiedAt: model.modifiedAt || null,
            name: model.name,
            size: Number(model.sizeBytes || 0),
          })),
        };
      }

      let session = null;
      try {
        if (requestOptions.autoStart) {
          session = await prepareOllamaSession(tool, {
            autoStart: true,
            launchContext: requestOptions.launchContext || 'model-list-refresh',
          });
        }
        const activeTool = session?.tool || tool;
        if (requestOptions.autoStart) {
          await waitForOllamaReady(activeTool, {
            actionLabel: 'refresh local models',
            alreadyActive: Boolean(session?.alreadyActive),
            autoStartAttempted: Boolean(session?.autoStarted || session?.launchAttempted),
            timeoutMs: requestOptions.readinessTimeoutMs,
          });
        }
        const result = await listOllamaModels(activeTool, requestOptions);
        return {
          ...result,
          autoStarted: Boolean(session?.autoStarted),
          stoppedAfterUse: Boolean(session?.startedByLocalAIHub),
        };
      } catch (error) {
        throw error;
      } finally {
        await finishOllamaSession(session);
      }
    }, 'Local AI Hub could not load your local Ollama models.'),
  );

  ipcMain.handle('ollama:chat', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup('ollama', state.tools);
      let session = null;
      try {
        if (payload?.autoStart) {
          session = await prepareOllamaSession(tool, {
            autoStart: true,
            launchContext: payload.launchContext || 'ollama-chat',
          });
        }
        const activeTool = session?.tool || tool;
        if (payload?.autoStart) {
          await waitForOllamaReady(activeTool, {
            actionLabel: 'run the wizard model',
            alreadyActive: Boolean(session?.alreadyActive),
            autoStartAttempted: Boolean(session?.autoStarted || session?.launchAttempted),
            timeoutMs: payload.readinessTimeoutMs,
          });
        }
        return await chatWithOllama(activeTool, payload);
      } catch (error) {
        if (payload?.autoStart && !session) {
          throw new Error(buildOllamaUnavailableMessage(tool, {
            actionLabel: 'run the wizard model',
            autoStartAttempted: true,
          }));
        }
        throw error;
      } finally {
        await finishOllamaSession(session);
      }
    }, 'Local AI Hub could not send that message to Ollama.'),
  );

  ipcMain.handle('snapshots:list', (_event, toolId) =>
    withPlainEnglishErrors(async () => listSnapshots(toolId), 'Local AI Hub could not load snapshots.'),
  );

  ipcMain.handle('snapshots:save', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      if (tool.lifecycleMode !== 'managed') {
        throw new Error('Local AI Hub snapshots are only available for tools it manages directly. Official-installer and detected installs can stay in Library, but Local AI Hub will not snapshot them.');
      }
      const snapshot = await saveSnapshot(tool);
      await notify('Local AI Hub snapshot saved', `${tool.name} snapshot ${snapshot.fileName} is ready.`);
      return {
        message: `${tool.name} snapshot saved to ${snapshot.fileName}.`,
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not save that snapshot.'),
  );

  ipcMain.handle('snapshots:restore', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(payload.toolId, state.tools);
      if (tool.lifecycleMode !== 'managed') {
        throw new Error('Local AI Hub can only restore snapshots for tools it manages directly.');
      }
      await restoreSnapshot(tool, payload.snapshotFileName);
      return {
        message: `${tool.name} was restored from ${payload.snapshotFileName}.`,
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not restore that snapshot.'),
  );
  ipcMain.handle('graph-workflow-presets:list', () =>
    withPlainEnglishErrors(async () => ({
      presets: await listGraphWorkflowPresets(),
    }), 'Local AI Hub could not load graph workflow presets.'),
  );

  ipcMain.handle('graph-workflow-presets:save', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const config = await upsertGraphWorkflowPreset(payload || {});
      return {
        message: 'Graph workflow preset saved.',
        presets: config.graphWorkflowPresets || [],
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not save that graph workflow preset.'),
  );

  ipcMain.handle('graph-workflow-presets:delete', (_event, presetId) =>
    withPlainEnglishErrors(async () => {
      const config = await deleteGraphWorkflowPreset(presetId);
      return {
        message: 'Graph workflow preset deleted.',
        presets: config.graphWorkflowPresets || [],
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not delete that graph workflow preset.'),
  );
  ipcMain.handle('prompt-styles:list', () =>
    withPlainEnglishErrors(async () => ({
      promptStyles: (await readConfig()).promptStyles || [],
    }), 'Local AI Hub could not load prompt styles.'),
  );

  ipcMain.handle('prompt-styles:save', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const config = await upsertPromptStyle(payload || {});
      return {
        message: 'Prompt style saved.',
        promptStyles: config.promptStyles || [],
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not save that prompt style.'),
  );

  ipcMain.handle('prompt-styles:delete', (_event, promptStyleId) =>
    withPlainEnglishErrors(async () => {
      const config = await deletePromptStyle(promptStyleId);
      return {
        message: 'Prompt style deleted.',
        promptStyles: config.promptStyles || [],
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not delete that prompt style.'),
  );

  ipcMain.handle('pipelines:list', () =>
    withPlainEnglishErrors(async () => ({
      pipelines: await listPipelines(),
    }), 'Local AI Hub could not load the saved pipelines.'),
  );

  ipcMain.handle('pipelines:get', (_event, pipelineId) =>
    withPlainEnglishErrors(async () => ({
      pipeline: await getPipeline(pipelineId),
    }), 'Local AI Hub could not load that pipeline.'),
  );

  ipcMain.handle('pipelines:save', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const pipeline = await savePipeline(payload || {});
      return {
        message: `${pipeline.name} was saved.`,
        pipeline,
        pipelines: await listPipelines(),
      };
    }, 'Local AI Hub could not save that pipeline.'),
  );

  ipcMain.handle('pipelines:delete', (_event, pipelineId) =>
    withPlainEnglishErrors(async () => {
      const removedPipeline = await deletePipeline(pipelineId);
      return {
        message: `${removedPipeline.name} was deleted.`,
        pipelines: await listPipelines(),
      };
    }, 'Local AI Hub could not delete that pipeline.'),
  );

  ipcMain.handle('pipelines:get-active-run', () =>
    withPlainEnglishErrors(async () => ({
      run: getActiveRunSnapshot(),
    }), 'Local AI Hub could not read the current pipeline run.'),
  );

  ipcMain.handle('pipelines:run', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const run = await runPipeline(payload || {});
      return {
        message: run?.message || 'Local AI Hub started the pipeline run.',
        run,
      };
    }, 'Local AI Hub could not run that pipeline.'),
  );

  ipcMain.handle('pipelines:cancel-run', (_event, runId) =>
    withPlainEnglishErrors(async () => ({
      message: 'Local AI Hub is stopping the active pipeline and will shut down any tool it started for the run.',
      run: cancelPipelineRun(runId),
    }), 'Local AI Hub could not cancel that pipeline run.'),
  );

  ipcMain.handle('pipelines:start-record-input', (_event, payload) =>
    withPlainEnglishErrors(async () => ({
      message: 'Record Input started.',
      run: await startPipelineRecordInput(payload?.runId, payload || {}),
    }), 'Local AI Hub could not start that Record Input recording.', { refreshMode: 'none' }),
  );

  ipcMain.handle('pipelines:stop-record-input', (_event, payload) =>
    withPlainEnglishErrors(async () => ({
      message: 'Record Input is finalizing.',
      run: await stopPipelineRecordInput(payload?.runId, payload || {}),
    }), 'Local AI Hub could not stop that Record Input recording cleanly.', { refreshMode: 'none' }),
  );

  ipcMain.handle('pipelines:cancel-record-input', (_event, payload) =>
    withPlainEnglishErrors(async () => ({
      message: 'Record Input was canceled and this pipeline step will fail.',
      run: await cancelPipelineRecordInput(payload?.runId, payload || {}),
    }), 'Local AI Hub could not cancel that Record Input recording.', { refreshMode: 'none' }),
  );

  ipcMain.handle('pipelines:resume-validation', (_event, payload) =>
    withPlainEnglishErrors(async () => ({
      message: 'Local AI Hub recorded your validation decision.',
      run: resumePipelineValidation(payload?.runId, payload || {}),
    }), 'Local AI Hub could not continue that validation step.'),
  );

  ipcMain.handle('pipelines:list-outputs', () =>
    withPlainEnglishErrors(async () => ({
      outputs: await listPipelineOutputs(),
    }), 'Local AI Hub could not load the saved pipeline outputs.'),
  );

  ipcMain.handle('pipelines:get-output-deletion-preview', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const config = await readConfig();
      const activeRun = getActiveRunSnapshot();
      const activeRunId = ['running', 'paused'].includes(activeRun?.status) ? activeRun.runId : '';
      return buildPipelineOutputDeletionPreview(payload?.path, {
        activeRunId,
        deleteMode: config.moveDeletedPipelineOutputsToRecycleBin !== false ? 'trash' : 'permanent',
      });
    }, 'Local AI Hub could not prepare that pipeline output cleanup preview.'),
  );

  ipcMain.handle('pipelines:delete-output', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const config = await readConfig();
      const useTrash = config.moveDeletedPipelineOutputsToRecycleBin !== false;
      const activeRun = getActiveRunSnapshot();
      const activeRunId = ['running', 'paused'].includes(activeRun?.status) ? activeRun.runId : '';
      const result = await deletePipelineOutput(payload?.path, {
        activeRunId,
        deleteMode: useTrash ? 'trash' : 'permanent',
        includeIntermediates: payload?.includeIntermediates === true,
        trashItem: (targetPath) => shell.trashItem(targetPath),
      });
      await invalidateStatisticsIndexSections(['storage'], 'pipeline-output-deleted').catch(() => null);
      return result;
    }, 'Local AI Hub could not delete that pipeline output.'),
  );
}

async function startApplication() {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  await ensureStorage();
  await registerAssetLibraryPreviewProtocol();
  const initialConfig = await readConfig();
  setCloseBehaviorPreference(initialConfig.closeBehavior);
  createWindow();
  setRecordingEventSink((payload) => {
    mainWindow?.webContents.send('recordings:status-update', payload);
    handlePipelineRecordingStatus(payload).catch(() => null);
    if (payload?.recording?.status && payload.recording.status !== 'recording') {
      invalidateStatisticsIndexSections(['storage'], `recording-${payload.recording.status}`).catch(() => null);
    }
    updateTrayMenu({ refreshTools: false }).catch(() => null);
  });
  setRuntimeEventSink((payload) => {
    if (payload?.type === 'launch-progress') {
      mainWindow?.webContents.send('tools:launch-progress', payload);
      return;
    }

    if (payload?.type === 'tool-state') {
      sendToolState(payload);
      updateHealthMonitor().catch(() => null);
      updateTrayMenu().catch(() => null);
      return;
    }

    if (payload?.type === 'unexpected-stop') {
      sendUnexpectedStop(payload);
      showUnexpectedStopNotification(payload).catch(() => null);
      updateHealthMonitor().catch(() => null);
      updateTrayMenu().catch(() => null);
      return;
    }

    mainWindow?.webContents.send('tools:runtime-output', payload);
  });
  const statisticsInvalidatedPipelineRuns = new Set();
  setPipelineEventSink((payload) => {
    mainWindow?.webContents.send('pipelines:run-update', payload);
    const run = payload?.run || {};
    if (run.runId && ['completed', 'failed', 'cancelled'].includes(String(run.status || '').toLowerCase()) && !statisticsInvalidatedPipelineRuns.has(run.runId)) {
      statisticsInvalidatedPipelineRuns.add(run.runId);
      invalidateStatisticsIndexSections(['storage'], 'pipeline-run-finished', { runId: run.runId, status: run.status }).catch(() => null);
    }
  });
  setProviderStateChangeSink((payload) => {
    if (!Array.isArray(payload?.providers)) {
      return;
    }

    sendAppStateUpdate({
      providers: payload.providers,
    });
  });
  tray = new Tray(createTrayIcon());
  tray.on('click', handleTrayClick);
  registerIpcHandlers();
  await initializeToolRegistry();
  await initializeProviderRegistry();
  const initialState = await buildAppState({ forceDiscovery: true });
  await updateTrayMenu();
  await runSilentToolUpdateCheck(initialState.tools).catch(() => null);
  await updateHealthMonitor({ hasRunningTools: initialState.tools.some((tool) => tool.status === 'running') });
  appUpdateService.scheduleLaunchUpdateCheck({
    enabled: Boolean(initialConfig.checkForUpdatesOnLaunch),
    onResult: (update) => sendAppStateUpdate({ appUpdate: update }),
  });
  toolUpdateInterval = setInterval(() => {
    buildMergedToolStateList({ includeSnapshots: false, resolveStatuses: false })
      .then((tools) => runSilentToolUpdateCheck(tools))
      .catch(() => null);
  }, TOOL_UPDATE_CHECK_INTERVAL_MS);
  broadcastWindowActivity(true);
  appStartupComplete = true;
}

process.on('uncaughtException', (error) => {
  reportFatalAppError(error, {
    phase: 'uncaughtException',
  });
});

process.on('unhandledRejection', (reason) => {
  if (!appStartupComplete) {
    reportFatalAppError(toError(reason), {
      phase: 'unhandledRejection',
    });
    return;
  }

  reportPostStartupUnhandledRejection(reason, {
    phase: 'unhandledRejection',
  });
});

app.whenReady()
  .then(() => startApplication())
  .catch((error) => {
    reportFatalAppError(error, {
      phase: 'whenReady',
    });
  });

app.on('before-quit', (event) => {
  if (shutdownComplete) {
    isQuitting = true;
    return;
  }

  event.preventDefault();
  requestAppQuit().catch((error) => {
    reportShutdownError(error, { phase: 'before-quit' });
    shutdownComplete = true;
    app.exit(1);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    return;
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    return;
  }

  showWindow();
});

app.on('browser-window-focus', () => {
  broadcastWindowActivity(true);
});

app.on('browser-window-blur', () => {
  broadcastWindowActivity(true);
});
