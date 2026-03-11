const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('localAIHub', {
  bootstrap: () => invoke('app:bootstrap'),
  browseModels: (payload) => invoke('models:browse', payload),
  cancelPipelineRun: (runId) => invoke('pipelines:cancel-run', runId),
  chatWithOllama: (payload) => invoke('ollama:chat', payload),
  chatWithProvider: (payload) => invoke('providers:chat', payload),
  completeFirstLaunch: () => invoke('app:complete-first-launch'),
  deleteModel: (payload) => invoke('models:delete', payload),
  deletePipeline: (pipelineId) => invoke('pipelines:delete', pipelineId),
  disconnectProvider: (providerId) => invoke('providers:disconnect', providerId),
  dismissLegacyMigration: (sourceRoot) => invoke('settings:dismiss-legacy-migration', sourceRoot),
  downloadModel: (payload) => invoke('models:download', payload),
  getActivePipelineRun: () => invoke('pipelines:get-active-run'),
  getCleanupPreview: () => invoke('settings:get-cleanup-preview'),
  getLiveResources: (payload) => invoke('app:get-live-resources', payload),
  getModelDownloadPreflight: (payload) => invoke('models:get-download-preflight', payload),
  getModelSettings: () => invoke('models:get-settings'),
  getPipeline: (pipelineId) => invoke('pipelines:get', pipelineId),
  getRepairPreview: (toolId) => invoke('tools:get-repair-preview', toolId),
  getStatistics: () => invoke('settings:get-statistics'),
  getToolInstallPreflight: (toolId) => invoke('tools:get-install-preflight', toolId),
  getToolRuntimeOutput: (toolId) => invoke('tools:get-runtime-output', toolId),
  getWindowActivity: () => invoke('app:get-window-activity'),
  installTool: (payload) => invoke('tools:install', payload),
  launchTool: (payload) => invoke('tools:launch', payload),
  listLocalModels: (toolId) => invoke('models:list-local', { toolId }),
  listOllamaModels: () => invoke('ollama:list-models'),
  listPipelines: () => invoke('pipelines:list'),
  listProviderModels: (providerId) => invoke('providers:list-models', providerId),
  listProviders: () => invoke('providers:list'),
  listSnapshots: (toolId) => invoke('snapshots:list', toolId),
  openLogsFolder: () => invoke('app:open-logs-folder'),
  openPath: (payload) => invoke('app:open-path', payload),
  openToolFolder: (toolId) => invoke('tools:open-folder', toolId),
  pickAiderProjectFolder: () => invoke('aider:pick-project-folder'),
  pickPipelineFile: (payload) => invoke('pipelines:pick-file', payload),
  pickStorageFolder: () => invoke('settings:pick-storage-folder'),
  pickWhisperAudioFile: () => invoke('whisper:pick-audio-file'),
  refresh: () => invoke('app:refresh'),
  repairTool: (payload) => invoke('tools:repair', payload),
  restartToUpdate: () => invoke('app:restart-to-update'),
  restoreSnapshot: (payload) => invoke('snapshots:restore', payload),
  resumePipelineValidation: (payload) => invoke('pipelines:resume-validation', payload),
  runCleanup: () => invoke('settings:run-cleanup'),
  runPipeline: (payload) => invoke('pipelines:run', payload),
  saveCloseBehavior: (closeBehavior) => invoke('settings:save-close-behavior', closeBehavior),
  saveLiveResourcePolling: (enabled) => invoke('settings:save-live-resource-polling', enabled),
  saveModelSettings: (payload) => invoke('models:save-settings', payload),
  savePipeline: (payload) => invoke('pipelines:save', payload),
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
  onPipelineRunUpdate: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('pipelines:run-update', listener);
    return () => ipcRenderer.removeListener('pipelines:run-update', listener);
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
  onToolUpdateSummary: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:update-summary', listener);
    return () => ipcRenderer.removeListener('tools:update-summary', listener);
  },
  onUnexpectedStop: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('tools:unexpected-stop', listener);
    return () => ipcRenderer.removeListener('tools:unexpected-stop', listener);
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
  onAppStateUpdated: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:state-updated', listener);
    return () => ipcRenderer.removeListener('app:state-updated', listener);
  },
  onWindowActivity: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:window-activity', listener);
    return () => ipcRenderer.removeListener('app:window-activity', listener);
  },
});



