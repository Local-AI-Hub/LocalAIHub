const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('localAIHub', {
  bootstrap: () => invoke('app:bootstrap'),
  browseModels: (payload) => invoke('models:browse', payload),
  chatWithOllama: (payload) => invoke('ollama:chat', payload),
  chatWithProvider: (payload) => invoke('providers:chat', payload),
  completeFirstLaunch: () => invoke('app:complete-first-launch'),
  deleteModel: (payload) => invoke('models:delete', payload),
  disconnectProvider: (providerId) => invoke('providers:disconnect', providerId),
  dismissLegacyMigration: (sourceRoot) => invoke('settings:dismiss-legacy-migration', sourceRoot),
  downloadModel: (payload) => invoke('models:download', payload),
  getCleanupPreview: () => invoke('settings:get-cleanup-preview'),
  getLiveResources: (payload) => invoke('app:get-live-resources', payload),
  getModelDownloadPreflight: (payload) => invoke('models:get-download-preflight', payload),
  getModelSettings: () => invoke('models:get-settings'),
  getRepairPreview: (toolId) => invoke('tools:get-repair-preview', toolId),
  getStatistics: () => invoke('settings:get-statistics'),
  getToolInstallPreflight: (toolId) => invoke('tools:get-install-preflight', toolId),
  getWindowActivity: () => invoke('app:get-window-activity'),
  getToolRuntimeOutput: (toolId) => invoke('tools:get-runtime-output', toolId),
  installTool: (payload) => invoke('tools:install', payload),
  launchTool: (payload) => invoke('tools:launch', payload),
  listLocalModels: (toolId) => invoke('models:list-local', { toolId }),
  listOllamaModels: () => invoke('ollama:list-models'),
  listProviderModels: (providerId) => invoke('providers:list-models', providerId),
  listProviders: () => invoke('providers:list'),
  listSnapshots: (toolId) => invoke('snapshots:list', toolId),
  openLogsFolder: () => invoke('app:open-logs-folder'),
  openToolFolder: (toolId) => invoke('tools:open-folder', toolId),
  pickAiderProjectFolder: () => invoke('aider:pick-project-folder'),
  pickStorageFolder: () => invoke('settings:pick-storage-folder'),
  pickWhisperAudioFile: () => invoke('whisper:pick-audio-file'),
  refresh: () => invoke('app:refresh'),
  repairTool: (payload) => invoke('tools:repair', payload),
  restartToUpdate: () => invoke('app:restart-to-update'),
  restoreSnapshot: (payload) => invoke('snapshots:restore', payload),
  runCleanup: () => invoke('settings:run-cleanup'),
  saveModelSettings: (payload) => invoke('models:save-settings', payload),
  saveProviderKey: (payload) => invoke('providers:save-key', payload),
  saveSnapshot: (toolId) => invoke('snapshots:save', toolId),
  sendToolInput: (payload) => invoke('tools:send-input', payload),
  setStorageLocation: (payload) => invoke('settings:set-storage-location', payload),
  stopTool: (toolId) => invoke('tools:stop', toolId),
  testProviderConnection: (providerId) => invoke('providers:test', providerId),
  transcribeWithWhisper: (payload) => invoke('whisper:transcribe', payload),
  uninstallTool: (toolId) => invoke('tools:uninstall', toolId),
  updateTool: (payload) => invoke('tools:update', payload),
  onInstallProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:install-progress', listener);
    return () => ipcRenderer.removeListener('tools:install-progress', listener);
  },
  onLaunchProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:launch-progress', listener);
    return () => ipcRenderer.removeListener('tools:launch-progress', listener);
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
  onWindowActivity: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:window-activity', listener);
    return () => ipcRenderer.removeListener('app:window-activity', listener);
  },
  onRuntimeOutput: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:runtime-output', listener);
    return () => ipcRenderer.removeListener('tools:runtime-output', listener);
  },
  onToolState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:tool-state', listener);
    return () => ipcRenderer.removeListener('tools:tool-state', listener);
  },
  onUnexpectedStop: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:unexpected-stop', listener);
    return () => ipcRenderer.removeListener('tools:unexpected-stop', listener);
  },
  onToolUpdateSummary: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:update-summary', listener);
    return () => ipcRenderer.removeListener('tools:update-summary', listener);
  },
  onUpdateProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:update-progress', listener);
    return () => ipcRenderer.removeListener('tools:update-progress', listener);
  },
  onUpdateReady: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:update-ready', listener);
    return () => ipcRenderer.removeListener('app:update-ready', listener);
  },
});
