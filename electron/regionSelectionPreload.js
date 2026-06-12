const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('regionSelection', {
  cancel: () => ipcRenderer.invoke('recordings:region-selection-cancel'),
  submit: (selection) => ipcRenderer.invoke('recordings:region-selection-submit', selection),
});
