const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

const { createLogger } = require('./logService');

let configured = false;
let updateReady = false;

function configureAutoUpdates(options = {}) {
  if (configured || !app.isPackaged) {
    return;
  }

  configured = true;
  const logger = createLogger('updates');

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', async (info) => {
    await logger.info('A newer app release was found. Downloading it in the background.', {
      version: info?.version,
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    updateReady = true;
    await logger.info('An app update finished downloading.', {
      version: info?.version,
    });
    options.onUpdateReady?.(info);
  });

  autoUpdater.on('error', async (error) => {
    await logger.warn('Auto-update check failed silently.', {
      error,
    });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => null);
  }, 12000);
}

function isUpdateReady() {
  return Boolean(app.isPackaged && updateReady);
}

function restartToInstallUpdate() {
  if (!isUpdateReady()) {
    return false;
  }

  autoUpdater.quitAndInstall(false, true);
  return true;
}

module.exports = {
  configureAutoUpdates,
  isUpdateReady,
  restartToInstallUpdate,
};
