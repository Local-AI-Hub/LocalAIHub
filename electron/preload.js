const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('nestAI', {
  bootstrap: () => invoke('app:bootstrap'),
  chatWithOllama: (payload) => invoke('ollama:chat', payload),
  completeFirstLaunch: () => invoke('app:complete-first-launch'),
  installTool: (toolId) => invoke('tools:install', toolId),
  launchTool: (toolId) => invoke('tools:launch', toolId),
  listOllamaModels: () => invoke('ollama:list-models'),
  listSnapshots: (toolId) => invoke('snapshots:list', toolId),
  openLogsFolder: () => invoke('app:open-logs-folder'),
  restartToUpdate: () => invoke('app:restart-to-update'),
  openToolFolder: (toolId) => invoke('tools:open-folder', toolId),
  refresh: () => invoke('app:refresh'),
  repairTool: (toolId) => invoke('tools:repair', toolId),
  restoreSnapshot: (payload) => invoke('snapshots:restore', payload),
  saveSnapshot: (toolId) => invoke('snapshots:save', toolId),
  stopTool: (toolId) => invoke('tools:stop', toolId),
  onInstallProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:install-progress', listener);
    return () => ipcRenderer.removeListener('tools:install-progress', listener);
  },
  onOpenToolUi: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:open-tool-ui', listener);
    return () => ipcRenderer.removeListener('app:open-tool-ui', listener);
  },
});

