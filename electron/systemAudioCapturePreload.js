const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('systemAudioCapture', {
  ready: () => ipcRenderer.invoke('system-audio-capture:ready'),
  configured: () => ipcRenderer.invoke('system-audio-capture:configured'),
  onConfigure(handler) {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.once('system-audio-capture:configure', listener);
  },
  onStop(handler) {
    const listener = () => handler();
    ipcRenderer.on('system-audio-capture:stop', listener);
    return () => ipcRenderer.removeListener('system-audio-capture:stop', listener);
  },
  prepared: () => ipcRenderer.invoke('system-audio-capture:prepared'),
  started: (payload) => ipcRenderer.invoke('system-audio-capture:started', payload),
  writeChunk: (bytes) => ipcRenderer.invoke('system-audio-capture:chunk', bytes),
  complete: (payload) => ipcRenderer.invoke('system-audio-capture:complete', payload),
  fail: (payload) => ipcRenderer.invoke('system-audio-capture:error', payload),
});
