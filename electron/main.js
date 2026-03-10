const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  Tray,
  nativeImage,
  shell,
} = require('electron');

const {
  ensureStorage,
  getAppPaths,
  humanizeError,
  markFirstLaunchComplete,
  readConfig,
  saveHardwareDetection,
  upsertTool,
} = require('./services/configService');
const {
  browseRemoteModels,
  countDownloadedModels,
  deleteModel,
  downloadModel,
  getModelDownloadPreflight,
  listDownloadedModels,
  readModelSettings,
  saveModelManagerSettings,
  supportsModelManager,
} = require('./services/modelService');
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
const { listOllamaModels, chatWithOllama } = require('./services/ollamaService');
const {
  disposeAllRuntimes,
  getRuntimeOutputSnapshot,
  isToolActive,
  launchToolFromUserAction,
  resolveToolStatus,
  sendInputToTool,
  setRuntimeEventSink,
  stopTool,
} = require('./services/processService');
const { listSnapshots, restoreSnapshot, saveSnapshot } = require('./services/snapshotService');
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
  testProviderConnection,
} = require('./services/providerService');
const { getStatisticsSnapshot, recordToolLaunch, recordVramSample } = require('./services/statisticsService');
const { getToolUpdateSnapshot, refreshInstalledToolUpdates } = require('./services/toolUpdateService');
const { transcribeWithWhisper } = require('./services/whisperService');
const { configureAutoUpdates, restartToInstallUpdate } = require('./services/updateService');
const { disposeBackgroundTasks } = require('./services/backgroundTaskService');

const APP_USER_MODEL_ID = 'com.localaihub.desktop';
const TOOL_HEALTH_CHECK_INTERVAL_MS = 5000;
const TOOL_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let mainWindow = null;
let tray = null;
let isQuitting = false;
let backgroundHealthInterval = null;
let toolUpdateInterval = null;
let healthCheckBusy = false;
let toolUpdateCheckPromise = null;
let lastWindowActivity = { focused: true, visible: true };
let fatalAppErrorHandled = false;

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

function writeDiagnosticLog(label, error, context = {}) {
  const diagnosticPath = getDiagnosticLogPath();
  const payload = {
    appVersion: app.getVersion(),
    context,
    isPackaged: app.isPackaged,
    message: error?.message || String(error),
    stack: error?.stack || null,
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

function sendUpdateReadyNotification() {
  mainWindow?.webContents.send('app:update-ready', {
    message: 'An update is ready. Restart Local AI Hub to install.',
  });
  notify('Local AI Hub update ready', 'An update is ready. Restart Local AI Hub to install.').catch(() => null);
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
  await launchToolFromUserAction(tool, options);
  await recordToolLaunch(tool).catch(() => null);
  const nextState = await buildAppState();
  const nextTool = toolLookup(tool.id, nextState.tools);
  openInternalToolInterface(nextTool);
  return {
    nextState,
    nextTool,
  };
}

async function buildMergedToolStateList(options = {}) {
  const config = options.config || (await readConfig());
  return Promise.all(
    Object.values(config.tools || {})
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (tool) => {
        const manifest = getToolManifest(tool.id) || {};
        const mergedTool = {
          ...manifest,
          ...tool,
        };

        return {
          ...mergedTool,
          status: options.resolveStatuses ? await resolveToolStatus(mergedTool) : mergedTool.status || 'stopped',
          snapshots: options.includeSnapshots && mergedTool.source === 'managed' ? await listSnapshots(mergedTool.id) : [],
          updateSupported:
            mergedTool.source === 'managed' ||
            manifest.installInstructions?.kind === 'installer-exe' ||
            manifest.installInstructions?.kind === 'single-file' ||
            manifest.installInstructions?.runtime === 'binary',
        };
      }),
  );
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
    hardware,
    logsPath: paths.logsRoot,
    managedDataPath: paths.managedRoot,
    manifests,
    manifestStatus: getManifestStatus(),
    providerManifestStatus: getProviderManifestStatus(),
    providers: await listProviderConnections(),
    resources: await getLiveResourceUsage(paths.managedRoot),
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

async function updateTrayMenu() {
  if (!tray) {
    return;
  }

  await initializeToolRegistry();
  const tools = await buildMergedToolStateList({
    includeSnapshots: false,
    resolveStatuses: false,
  });
  const toolItems =
    tools.length > 0
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

  const menu = Menu.buildFromTemplate([
    { label: 'Open Local AI Hub', click: showWindow },
    { type: 'separator' },
    ...toolItems,
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Local AI Hub');
  tray.setContextMenu(menu);
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

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
    broadcastWindowActivity(true);
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
    broadcastWindowActivity(true);
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

    for (const storedTool of Object.values(config.tools || {})) {
      if (storedTool.status !== 'running') {
        continue;
      }

      const mergedTool = {
        ...(getToolManifest(storedTool.id) || {}),
        ...storedTool,
      };
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

async function withPlainEnglishErrors(handler, fallbackMessage) {
  try {
    const data = await handler();
    await updateHealthMonitor().catch(() => null);
    await updateTrayMenu();
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      message: humanizeError(error, fallbackMessage),
    };
  }
}

function registerIpcHandlers() {
  ipcMain.handle('app:bootstrap', () =>
    withPlainEnglishErrors(() => buildAppState({ forceDiscovery: true, refreshManifest: true }), 'Local AI Hub could not load the app state.'),
  );

  ipcMain.handle('app:refresh', () =>
    withPlainEnglishErrors(buildAppState, 'Local AI Hub could not refresh the dashboard.'),
  );

  ipcMain.handle('app:get-live-resources', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const { managedRoot } = getAppPaths();
      return getLiveResourceUsage(managedRoot, {
        includeDisk: Boolean(payload?.includeDisk),
      });
    }, 'Local AI Hub could not refresh live system usage right now.'),
  );

  ipcMain.handle('app:get-window-activity', () =>
    withPlainEnglishErrors(async () => getWindowActivityPayload(), 'Local AI Hub could not read the current window activity.'),
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

  ipcMain.handle('app:restart-to-update', () =>
    withPlainEnglishErrors(async () => {
      const restarting = restartToInstallUpdate();
      if (!restarting) {
        throw new Error('Local AI Hub does not have a downloaded update ready yet.');
      }

      return {
        message: 'Local AI Hub is restarting to install the update.',
      };
    }, 'Local AI Hub could not restart to install the update.'),
  );

  ipcMain.handle('tools:install', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const toolId = typeof payload === 'string' ? payload : payload?.toolId;
      const tool = await installTool(toolId, {
        lowDiskConfirmed: Boolean(payload?.lowDiskConfirmed),
        onProgress: (progressPayload) => sendInstallProgress(progressPayload),
      });
      invalidateDiscoveryCache();
      return {
        message:
          tool.installActionMessage ||
          (tool.reusedExistingInstall ? `${tool.name} is already ready to use.` : `${tool.name} was installed successfully.`),
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not install that tool.'),
  );

  ipcMain.handle('tools:get-install-preflight', (_event, toolId) =>
    withPlainEnglishErrors(async () => getToolInstallPreflight(toolId), 'Local AI Hub could not check disk space for that install.'),
  );

  ipcMain.handle('tools:launch', (_event, payload) =>
    withPlainEnglishErrors(async () => {
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

      const launchOptions = {};
      if (tool.id === 'aider') {
        const projectDir = String(payload?.projectDir || tool.lastProjectDir || '').trim();
        if (!projectDir) {
          throw new Error('Choose a project folder for Aider before launching it.');
        }

        launchOptions.launchProfileOverride = {
          workingDir: projectDir,
          allowExternalWorkingDir: true,
        };
        await upsertTool({
          id: tool.id,
          lastProjectDir: projectDir,
        });
      }
      const { nextState, nextTool } = await launchToolFromExplicitUserAction(tool, {
        ...launchOptions,
        launchContext: 'ipc-launch',
      });

      let message = `${nextTool.name} is starting.`;
      if (String(nextTool.interfaceMode || '').startsWith('embedded-')) {
        if (nextTool.interfaceMode === 'embedded-whisper') {
          message = `${nextTool.name} is ready. Local AI Hub opened its transcription view.`;
        } else if (nextTool.interfaceMode === 'embedded-chat') {
          message = `${nextTool.name} is starting. Local AI Hub opened its chat view.`;
        } else if (nextTool.interfaceMode === 'embedded-terminal') {
          message = `${nextTool.name} is ready. Local AI Hub opened its built-in console.`;
        }
      }

      return {
        message,
        state: nextState,
      };
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
      if (tool.status === 'running') {
        await stopTool(tool);
      }

      const updatedTool = await updateToolInstallation(tool, {
        onProgress: (progressPayload) => sendUpdateProgress(progressPayload),
      });
      invalidateDiscoveryCache();
      return {
        message: updatedTool.lastUpdateMessage || `Local AI Hub updated ${tool.name}.`,
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not update that tool.'),
  );

  ipcMain.handle('tools:repair', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const toolId = typeof payload === 'string' ? payload : payload?.toolId;
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      const repairedTool = await repairToolInstallation(tool, {
        onProgress: (progressPayload) => sendInstallProgress(progressPayload),
        removeOrphanedToolFolders: Boolean(payload?.removeOrphanedToolFolders),
      });
      invalidateDiscoveryCache();
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

  ipcMain.handle('tools:uninstall', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      if (tool.source === 'managed' && tool.status === 'running') {
        await stopTool(tool);
      }
      const removedTool = await uninstallTool(tool);
      invalidateDiscoveryCache();
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
      return {
        message: `Large Local AI Hub files will now use ${normalizedTargetPath}.`,
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not save the new storage folder.'),
  );

  ipcMain.handle('settings:dismiss-legacy-migration', (_event, sourceRoot) =>
    withPlainEnglishErrors(async () => {
      await dismissManagedDataMigration(sourceRoot);
      return {
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not update the migration reminder.'),
  );

  ipcMain.handle('settings:get-cleanup-preview', () =>
    withPlainEnglishErrors(() => inspectCleanupTargets(), 'Local AI Hub could not scan the approved cleanup folders right now.'),
  );

  ipcMain.handle('settings:run-cleanup', () =>
    withPlainEnglishErrors(async () => {
      const cleanupSummary = await runCleanup();
      return {
        cleanupSummary,
        message: 'Cleanup finished.',
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not remove those leftover files.'),
  );

  ipcMain.handle('settings:get-statistics', () =>
    withPlainEnglishErrors(async () => {
      const tools = await buildMergedToolStateList({
        includeSnapshots: false,
        resolveStatuses: false,
      });
      const runningTools = tools.filter((tool) => tool.status === 'running');
      if (runningTools.length > 0) {
        await recordVramSample(runningTools).catch(() => null);
      }
      return getStatisticsSnapshot(tools);
    }, 'Local AI Hub could not load the statistics screen right now.'),
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

  ipcMain.handle('models:browse', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      return browseRemoteModels(tool, payload);
    }, 'Local AI Hub could not load remote models right now.'),
  );

  ipcMain.handle('models:list-local', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      return listDownloadedModels(tool);
    }, 'Local AI Hub could not load the downloaded models for that tool.'),
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
      return {
        message: result.message,
        localModels: await listDownloadedModels(tool),
      };
    }, 'Local AI Hub could not download that model.'),
  );

  ipcMain.handle('models:delete', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      const result = await deleteModel(tool, payload);
      return {
        message: result.message,
        localModels: await listDownloadedModels(tool),
      };
    }, 'Local AI Hub could not delete that model.'),
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

  ipcMain.handle('whisper:transcribe', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup('whisper', state.tools);
      return transcribeWithWhisper(tool, payload);
    }, 'Local AI Hub could not transcribe that audio file.'),
  );

  ipcMain.handle('ollama:list-models', () =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup('ollama', state.tools);
      return listOllamaModels(tool);
    }, 'Local AI Hub could not load your local Ollama models.'),
  );

  ipcMain.handle('ollama:chat', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup('ollama', state.tools);
      return chatWithOllama(tool, payload);
    }, 'Local AI Hub could not send that message to Ollama.'),
  );

  ipcMain.handle('snapshots:list', (_event, toolId) =>
    withPlainEnglishErrors(async () => listSnapshots(toolId), 'Local AI Hub could not load snapshots.'),
  );

  ipcMain.handle('snapshots:save', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      if (tool.source !== 'managed') {
        throw new Error('Local AI Hub snapshots are only available for tools it manages itself.');
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
      if (tool.source !== 'managed') {
        throw new Error('Local AI Hub can only restore snapshots for tools it installed itself.');
      }
      await restoreSnapshot(tool, payload.snapshotFileName);
      return {
        message: `${tool.name} was restored from ${payload.snapshotFileName}.`,
        state: await buildAppState(),
      };
    }, 'Local AI Hub could not restore that snapshot.'),
  );
}

async function startApplication() {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  createWindow();
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
  tray = new Tray(createTrayIcon());
  tray.on('click', showWindow);
  registerIpcHandlers();
  configureAutoUpdates({ onUpdateReady: sendUpdateReadyNotification });
  await initializeToolRegistry({ refreshRemote: true });
  await initializeProviderRegistry();
  const initialState = await buildAppState({ forceDiscovery: true });
  await updateTrayMenu();
  await runSilentToolUpdateCheck(initialState.tools).catch(() => null);
  await updateHealthMonitor({ hasRunningTools: initialState.tools.some((tool) => tool.status === 'running') });
  toolUpdateInterval = setInterval(() => {
    buildMergedToolStateList({ includeSnapshots: false, resolveStatuses: false })
      .then((tools) => runSilentToolUpdateCheck(tools))
      .catch(() => null);
  }, TOOL_UPDATE_CHECK_INTERVAL_MS);
  broadcastWindowActivity(true);
}

process.on('uncaughtException', (error) => {
  reportFatalAppError(error, {
    phase: 'uncaughtException',
  });
});

process.on('unhandledRejection', (reason) => {
  reportFatalAppError(toError(reason), {
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

app.on('before-quit', async () => {
  isQuitting = true;
  if (backgroundHealthInterval) {
    clearInterval(backgroundHealthInterval);
    backgroundHealthInterval = null;
  }
  if (toolUpdateInterval) {
    clearInterval(toolUpdateInterval);
    toolUpdateInterval = null;
  }
  await disposeAllRuntimes();
  await disposeBackgroundTasks();
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


