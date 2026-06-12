const path = require('path');
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');

const partition = `local-ai-hub-system-audio-audit-${Date.now()}`;
let auditWindow = null;
let completed = false;

function finish(payload, exitCode = 0) {
  if (completed) return;
  completed = true;
  console.log(JSON.stringify({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    platform: process.platform,
    ...payload,
  }));
  auditWindow?.destroy();
  app.exit(exitCode);
}

app.whenReady().then(async () => {
  const auditSession = session.fromPartition(partition, { cache: false });
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  if (!sources.length) {
    finish({ ok: false, message: 'Electron did not enumerate a screen source.' }, 1);
    return;
  }

  auditWindow = new BrowserWindow({
    width: 460,
    height: 220,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'system-audio-audit-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  auditWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  auditWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  auditSession.setPermissionCheckHandler((webContents, permission) => webContents === auditWindow.webContents && ['media', 'display-capture'].includes(permission));
  auditSession.setPermissionRequestHandler((webContents, permission, callback) => callback(webContents === auditWindow.webContents && ['media', 'display-capture'].includes(permission)));
  auditSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({ video: sources[0], audio: 'loopback' });
  });

  ipcMain.once('system-audio-audit:result', (_event, payload) => finish({ sourceCount: sources.length, ...payload }, payload?.ok ? 0 : 1));
  await auditWindow.loadFile(path.join(__dirname, 'system-audio-audit.html'));
  auditWindow.show();
  auditWindow.focus();
  auditWindow.webContents.focus();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const rect = await auditWindow.webContents.executeJavaScript("document.getElementById('start-audit').getBoundingClientRect().toJSON()", true);
  const x = Math.round(rect.x + rect.width / 2);
  const y = Math.round(rect.y + rect.height / 2);
  auditWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  auditWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  auditWindow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });

  setTimeout(() => finish({ ok: false, sourceCount: sources.length, message: 'The bounded loopback audit timed out.' }, 1), 10000);
}).catch((error) => finish({ ok: false, message: error?.message || String(error) }, 1));
