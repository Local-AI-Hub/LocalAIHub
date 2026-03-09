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
  getModelDownloadPreflight: (payload) => invoke('models:get-download-preflight', payload),
  getModelSettings: () => invoke('models:get-settings'),
  getRepairPreview: (toolId) => invoke('tools:get-repair-preview', toolId),
  getToolInstallPreflight: (toolId) => invoke('tools:get-install-preflight', toolId),
  getToolRuntimeOutput: (toolId) => invoke('tools:get-runtime-output', toolId),
  installTool: (payload) => invoke('tools:install', payload),
  launchTool: (payload) => invoke('tools:launch', payload),
  listLocalModels: (toolId) => invoke('models:list-local', { toolId }),
  listOllamaModels: () => invoke('ollama:list-models'),
  listSnapshots: (toolId) => invoke('snapshots:list', toolId),
  browseModels: (payload) => invoke('models:browse', payload),
  openLogsFolder: () => invoke('app:open-logs-folder'),
  openToolFolder: (toolId) => invoke('tools:open-folder', toolId),
  pickStorageFolder: () => invoke('settings:pick-storage-folder'),
  setStorageLocation: (payload) => invoke('settings:set-storage-location', payload),
  dismissLegacyMigration: (sourceRoot) => invoke('settings:dismiss-legacy-migration', sourceRoot),
  getCleanupPreview: () => invoke('settings:get-cleanup-preview'),
  runCleanup: () => invoke('settings:run-cleanup'),
  pickAiderProjectFolder: () => invoke('aider:pick-project-folder'),
  pickWhisperAudioFile: () => invoke('whisper:pick-audio-file'),
  refresh: () => invoke('app:refresh'),
  repairTool: (payload) => invoke('tools:repair', payload),
  restartToUpdate: () => invoke('app:restart-to-update'),
  restoreSnapshot: (payload) => invoke('snapshots:restore', payload),
  saveModelSettings: (payload) => invoke('models:save-settings', payload),
  saveSnapshot: (toolId) => invoke('snapshots:save', toolId),
  sendToolInput: (payload) => invoke('tools:send-input', payload),
  stopTool: (toolId) => invoke('tools:stop', toolId),
  transcribeWithWhisper: (payload) => invoke('whisper:transcribe', payload),
  uninstallTool: (toolId) => invoke('tools:uninstall', toolId),
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
  onRuntimeOutput: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:runtime-output', listener);
    return () => ipcRenderer.removeListener('tools:runtime-output', listener);
  },
  onUpdateReady: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:update-ready', listener);
    return () => ipcRenderer.removeListener('app:update-ready', listener);
  },
});


