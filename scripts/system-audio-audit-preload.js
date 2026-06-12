const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('systemAudioAudit', {
  report: (payload) => ipcRenderer.send('system-audio-audit:result', payload),
});
