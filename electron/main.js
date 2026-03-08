const path = require('path');
const {
  app,
  BrowserWindow,
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
const { invalidateDiscoveryCache, syncDiscoveredTools } = require('./services/toolDiscoveryService');
const { detectHardwareSnapshot, getLiveResourceUsage } = require('./services/hardwareService');
const { installTool, repairToolInstallation } = require('./services/installerService');
const { listOllamaModels, chatWithOllama } = require('./services/ollamaService');
const { launchTool, stopTool, disposeAllRuntimes, resolveToolStatus } = require('./services/processService');
const { listSnapshots, restoreSnapshot, saveSnapshot } = require('./services/snapshotService');
const { getToolCatalog, getToolManifest, initializeToolRegistry } = require('./services/toolRegistry');
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
    return `${tool.name} stopped — you can close the browser tab.`;
  }

  return `${tool?.name || 'The tool'} was stopped.`;
}

function sendUpdateReadyNotification() {
  mainWindow?.webContents.send('app:update-ready', {
    message: 'An update is ready. Restart NestAI to install.',
  });
  notify('NestAI update ready', 'An update is ready. Restart NestAI to install.').catch(() => null);
}

function openInternalToolInterface(tool) {
  if (!tool || tool.interfaceMode !== 'embedded-chat' || !mainWindow || mainWindow.isDestroyed()) {
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
    await notify('NestAI', getStopMessage(tool));
  }
}

async function buildAppState(options = {}) {
  await syncDiscoveredTools({ force: Boolean(options.forceDiscovery) });

  const config = await readConfig();
  let hardware = config.hardware;

  if (!hardware) {
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

  return {
    appDataPath: paths.root,
    firstLaunch: !latestConfig.firstLaunchCompleted,
    hardware,
    logsPath: paths.logsRoot,
    manifests: getToolCatalog(),
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
    { label: 'Open NestAI', click: showWindow },
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

  tray.setToolTip('NestAI');
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

function toolLookup(toolId, tools) {
  const tool = tools.find((item) => item.id === toolId);
  if (!tool) {
    throw new Error('NestAI could not find that installed tool.');
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

function registerIpcHandlers() {
  ipcMain.handle('app:bootstrap', () =>
    withPlainEnglishErrors(() => buildAppState({ forceDiscovery: true }), 'NestAI could not load the app state.'),
  );

  ipcMain.handle('app:refresh', () =>
    withPlainEnglishErrors(buildAppState, 'NestAI could not refresh the dashboard.'),
  );

  ipcMain.handle('app:complete-first-launch', () =>
    withPlainEnglishErrors(async () => {
      await markFirstLaunchComplete();
      return buildAppState();
    }, 'NestAI could not save the first-launch state.'),
  );

  ipcMain.handle('app:open-logs-folder', () =>
    withPlainEnglishErrors(async () => {
      const { logsRoot } = await ensureStorage();
      await shell.openPath(logsRoot);
      return {
        message: 'NestAI logs folder is open.',
      };
    }, 'NestAI could not open the logs folder.'),
  );

  ipcMain.handle('tools:install', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const tool = await installTool(toolId, {
        onProgress: (payload) => sendInstallProgress(payload),
      });
      invalidateDiscoveryCache();
      return {
        message: `${tool.name} was installed successfully.`,
        state: await buildAppState({ forceDiscovery: true }),
      };
    }, 'NestAI could not install that tool.'),
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
          nextTool.interfaceMode === 'embedded-chat'
            ? `${nextTool.name} is starting. NestAI opened its chat view.`
            : `${nextTool.name} is starting.`,
        state: nextState,
      };
    }, 'NestAI could not start that tool.'),
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
    }, 'NestAI could not stop that tool.'),
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
    }, 'NestAI could not repair that tool.'),
  );

  ipcMain.handle('tools:open-folder', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      await shell.openPath(tool.installDir);
      return {
        message: `${tool.name}'s folder is open.`,
      };
    }, 'NestAI could not open that folder.'),
  );

  ipcMain.handle('ollama:list-models', () =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup('ollama', state.tools);
      return listOllamaModels(tool);
    }, 'NestAI could not load your local Ollama models.'),
  );

  ipcMain.handle('ollama:chat', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup('ollama', state.tools);
      return chatWithOllama(tool, payload);
    }, 'NestAI could not send that message to Ollama.'),
  );

  ipcMain.handle('snapshots:list', (_event, toolId) =>
    withPlainEnglishErrors(async () => listSnapshots(toolId), 'NestAI could not load snapshots.'),
  );

  ipcMain.handle('snapshots:save', (_event, toolId) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(toolId, state.tools);
      if (tool.source !== 'managed') {
        throw new Error('NestAI snapshots are only available for tools it manages itself.');
      }
      const snapshot = await saveSnapshot(tool);
      await notify('NestAI snapshot saved', `${tool.name} snapshot ${snapshot.fileName} is ready.`);
      return {
        message: `${tool.name} snapshot saved to ${snapshot.fileName}.`,
        state: await buildAppState(),
      };
    }, 'NestAI could not save that snapshot.'),
  );

  ipcMain.handle('snapshots:restore', (_event, payload) =>
    withPlainEnglishErrors(async () => {
      const state = await buildAppState();
      const tool = toolLookup(payload.toolId, state.tools);
      if (tool.source !== 'managed') {
        throw new Error('NestAI can only restore snapshots for tools it installed itself.');
      }
      await restoreSnapshot(tool, payload.snapshotFileName);
      return {
        message: `${tool.name} was restored from ${payload.snapshotFileName}.`,
        state: await buildAppState(),
      };
    }, 'NestAI could not restore that snapshot.'),
  );
}

app.whenReady().then(async () => {
  createWindow();
  tray = new Tray(createTrayIcon());
  tray.on('click', showWindow);
  registerIpcHandlers();
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



