const path = require('path');
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
} = require('./services/configService');
const {
  browseRemoteModels,
  countDownloadedModels,
  deleteModel,
  downloadModel,
  listDownloadedModels,
  readModelSettings,
  saveModelManagerSettings,
  supportsModelManager,
} = require('./services/modelService');
const { invalidateDiscoveryCache, syncDiscoveredTools } = require('./services/toolDiscoveryService');
const { detectHardwareSnapshot, getLiveResourceUsage } = require('./services/hardwareService');
const { installTool, repairToolInstallation } = require('./services/installerService');
const { listOllamaModels, chatWithOllama } = require('./services/ollamaService');
const {
  disposeAllRuntimes,
  isToolActive,
  launchTool,
  stopTool,
  resolveToolStatus,
} = require('./services/processService');
const { listSnapshots, restoreSnapshot, saveSnapshot } = require('./services/snapshotService');
const { getToolCatalog, getToolManifest, initializeToolRegistry } = require('./services/toolRegistry');
const { getManifestStatus } = require('./services/manifestService');
const { transcribeWithWhisper } = require('./services/whisperService');
const { configureAutoUpdates, restartToInstallUpdate } = require('./services/updateService');

let mainWindow = null;
let tray = null;
let isQuitting = false;

function getRendererUrl() {
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }

  return `file://${path.join(__dirname, '..', 'dist', 'index.html')}`;
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
      <rect width="32" height="32" rx="8" fill="#0c1523" />
      <path d="M8 24V8h4l8 10V8h4v16h-4l-8-10v10z" fill="#5dd7ff" />
    </svg>
  `;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function getStopMessage(tool) {
  if (tool?.interfaceMode === 'external-browser' && tool?.launchUrl) {
    return `${tool.name} stopped. You can close the browser tab.`;
  }

  return `${tool?.name || 'The tool'} was stopped.`;
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

async function buildAppState(options = {}) {
  await initializeToolRegistry({ refreshRemote: Boolean(options.refreshManifest) });
  await syncDiscoveredTools({ force: Boolean(options.forceDiscovery) });

  const config = await readConfig();
  let hardware = config.hardware;

  if (!hardware || !Array.isArray(hardware.disks) || hardware.disks.length === 0) {
    hardware = await detectHardwareSnapshot();
    await saveHardwareDetection(hardware);
  }

  const latestConfig = await readConfig();
  const paths = getAppPaths();
  const tools = await Promise.all(
    Object.values(latestConfig.tools)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (tool) => {
        const manifest = getToolManifest(tool.id) || {};
        const mergedTool = {
          ...manifest,
          ...tool,
        };

        return {
          ...mergedTool,
          status: await resolveToolStatus(mergedTool),
          snapshots: mergedTool.source === 'managed' ? await listSnapshots(mergedTool.id) : [],
        };
      }),
  );
  const downloadedModelCount = (
    await Promise.all(
      tools
        .filter((tool) => supportsModelManager(tool))
        .map((tool) => countDownloadedModels(tool).catch(() => 0)),
    )
  ).reduce((total, count) => total + count, 0);

  return {
    appDataPath: paths.root,
    downloadedModelCount,
    firstLaunch: !latestConfig.firstLaunchCompleted,
    hardware,
    logsPath: paths.logsRoot,
    manifests: getToolCatalog(),
    manifestStatus: getManifestStatus(),
    resources: await getLiveResourceUsage(),
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

  const state = await buildAppState();
  const toolItems =
    state.tools.length > 0
      ? state.tools.map((tool) => ({
          label: tool.status === 'running' ? `Stop ${tool.name}` : `Launch ${tool.name}`,
          click: async () => {
            try {
              if (tool.status === 'running') {
                await stopTool(tool);
                await maybeNotifyStoppedTool(tool);
              } else if (tool.launchSupported === false) {
                await shell.openPath(tool.installDir);
              } else {
                await launchTool(tool);
                openInternalToolInterface(tool);
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
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
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
  });

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });
}

async function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function sendInstallProgress(payload) {
  mainWindow?.webContents.send('tools:install-progress', payload);
}

function sendModelProgress(payload) {
  mainWindow?.webContents.send('models:download-progress', payload);
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

async function withPlainEnglishErrors(handler, fallbackMessage) {
  try {
    const data = await handler();
    await updateTrayMenu();
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      message: humanizeError(error, fallbackMessage),
    };
  }
}

async function ensureOllamaReadyForModels(tool) {
  if (tool?.id !== 'ollama') {
    return tool;
  }

  if (!(await isToolActive(tool))) {
    await launchTool(tool, {
      skipOpenInterface: true,
    });
  }

  const state = await buildAppState();
  return modelToolLookup('ollama', state.tools);
}

function registerIpcHandlers() {
  ipcMain.handle('app:bootstrap', () =>
    withPlainEnglishErrors(() => buildAppState({ forceDiscovery: true, refreshManifest: true }), 'Local AI Hub could not load the app state.'),
  );

  ipcMain.handle('app:refresh', () =>
    withPlainEnglishErrors(buildAppState, 'Local AI Hub could not refresh the dashboard.'),
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

  ipcMain.handle('tools:install', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const tool = await installTool(toolId, {
        onProgress: (payload) => sendInstallProgress(payload),
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

  ipcMain.handle('tools:launch', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      if (tool.launchSupported === false) {
        await shell.openPath(tool.installDir);
        return {
          message: `${tool.name}'s folder is open.`,
          state,
        };
      }
      await launchTool(tool);
      const nextState = await buildAppState();
      const nextTool = toolLookup(toolId, nextState.tools);
      openInternalToolInterface(nextTool);
      return {
        message:
          String(nextTool.interfaceMode || '').startsWith('embedded-')
            ? nextTool.interfaceMode === 'embedded-whisper'
              ? `${nextTool.name} is ready. Local AI Hub opened its transcription view.`
              : `${nextTool.name} is starting. Local AI Hub opened its chat view.`
            : `${nextTool.name} is starting.`,
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

  ipcMain.handle('tools:repair', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      const repairedTool = await repairToolInstallation(tool, {
        onProgress: (payload) => sendInstallProgress(payload),
      });
      invalidateDiscoveryCache();
      return {
        message: repairedTool.lastRepairMessage,
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'Local AI Hub could not repair that tool.'),
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
      const activeTool = tool.id === 'ollama' ? await ensureOllamaReadyForModels(tool) : tool;
      return browseRemoteModels(activeTool, payload);
    }, 'Local AI Hub could not load remote models right now.'),
  );

  ipcMain.handle('models:list-local', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      const activeTool = tool.id === 'ollama' ? await ensureOllamaReadyForModels(tool) : tool;
      return listDownloadedModels(activeTool);
    }, 'Local AI Hub could not load the downloaded models for that tool.'),
  );

  ipcMain.handle('models:download', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      const activeTool = tool.id === 'ollama' ? await ensureOllamaReadyForModels(tool) : tool;
      const result = await downloadModel(activeTool, payload, {
        onProgress: (progress) => sendModelProgress({
          toolId: payload.toolId,
          ...progress,
        }),
      });
      return {
        message: result.message,
        localModels: await listDownloadedModels(activeTool),
      };
    }, 'Local AI Hub could not download that model.'),
  );

  ipcMain.handle('models:delete', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = modelToolLookup(payload.toolId, state.tools);
      const activeTool = tool.id === 'ollama' ? await ensureOllamaReadyForModels(tool) : tool;
      const result = await deleteModel(activeTool, payload);
      return {
        message: result.message,
        localModels: await listDownloadedModels(activeTool),
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
      const activeTool = await ensureOllamaReadyForModels(tool);
      return listOllamaModels(activeTool);
    }, 'Local AI Hub could not load your local Ollama models.'),
  );

  ipcMain.handle('ollama:chat', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup('ollama', state.tools);
      const activeTool = await ensureOllamaReadyForModels(tool);
      return chatWithOllama(activeTool, payload);
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

app.whenReady().then(async () => {
  createWindow();
  tray = new Tray(createTrayIcon());
  tray.on('click', showWindow);
  registerIpcHandlers();
  configureAutoUpdates({ onUpdateReady: sendUpdateReadyNotification });
  await initializeToolRegistry({ refreshRemote: true });
  await updateTrayMenu();
});

app.on('before-quit', async () => {
  isQuitting = true;
  await disposeAllRuntimes();
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






