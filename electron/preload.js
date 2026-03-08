const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('localAIHub', {
  bootstrap: () => invoke('app:bootstrap'),
  chatWithOllama: (payload) => invoke('ollama:chat', payload),
  completeFirstLaunch: () => invoke('app:complete-first-launch'),
  deleteModel: (payload) => invoke('models:delete', payload),
  downloadModel: (payload) => invoke('models:download', payload),
  getModelSettings: () => invoke('models:get-settings'),
  installTool: (toolId) => invoke('tools:install', toolId),
  launchTool: (toolId) => invoke('tools:launch', toolId),
  listLocalModels: (toolId) => invoke('models:list-local', { toolId }),
  listOllamaModels: () => invoke('ollama:list-models'),
  listSnapshots: (toolId) => invoke('snapshots:list', toolId),
  browseModels: (payload) => invoke('models:browse', payload),
  openLogsFolder: () => invoke('app:open-logs-folder'),
  openToolFolder: (toolId) => invoke('tools:open-folder', toolId),
  refresh: () => invoke('app:refresh'),
  repairTool: (toolId) => invoke('tools:repair', toolId),
  restartToUpdate: () => invoke('app:restart-to-update'),
  restoreSnapshot: (payload) => invoke('snapshots:restore', payload),
  saveModelSettings: (payload) => invoke('models:save-settings', payload),
  saveSnapshot: (toolId) => invoke('snapshots:save', toolId),
  stopTool: (toolId) => invoke('tools:stop', toolId),
  pickWhisperAudioFile: () => invoke('whisper:pick-audio-file'),
  transcribeWithWhisper: (payload) => invoke('whisper:transcribe', payload),
  onInstallProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:install-progress', listener);
    return () => ipcRenderer.removeListener('tools:install-progress', listener);
  },
  onModelDownloadProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('models:download-progress', listener);
    return () => ipcRenderer.removeListener('models:download-progress', listener);
  },
  onOpenToolUi: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:open-tool-ui', listener);
    return () => ipcRenderer.removeListener('app:open-tool-ui', listener);
  },
  onUpdateReady: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:update-ready', listener);
    return () => ipcRenderer.removeListener('app:update-ready', listener);
  },
});

