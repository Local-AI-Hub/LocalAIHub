const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('localAIHub', {
  bootstrap: () => invoke('app:bootstrap'),
  browseModels: (payload) => invoke('models:browse', payload),
  cancelModelBrowse: (requestId) => invoke('models:cancel-browse', { requestId }),
  cancelUpdateCheck: () => invoke('updates:cancel-check'),
  checkForUpdates: () => invoke('updates:check'),
  copySystemInfo: () => invoke('diagnostics:copy-system-info'),
  createDiagnosticsBundle: () => invoke('diagnostics:create-bundle'),
  createAssetLibrary: (payload) => invoke('asset-libraries:create', payload),
  deleteAssetLibrary: (payload) => invoke('asset-libraries:delete', payload),
  getAssetLibraryItemPreview: (payload) => invoke('asset-libraries:get-preview', payload),
  importAssetLibraryItems: (payload) => invoke('asset-libraries:import-items', payload),
  listAssetLibraries: (type) => invoke('asset-libraries:list', { type }),
  pickAssetLibraryFiles: (payload) => invoke('asset-libraries:pick-files', payload),
  removeAssetLibraryItem: (payload) => invoke('asset-libraries:remove-item', payload),
  renameAssetLibrary: (payload) => invoke('asset-libraries:rename', payload),
  updateColorPaletteItem: (payload) => invoke('asset-libraries:update-color', payload),
  cancelPipelineRun: (runId) => invoke('pipelines:cancel-run', runId),
  cancelPipelineRecordInput: (payload) => invoke('pipelines:cancel-record-input', payload),
  cancelRecording: () => invoke('recordings:cancel'),
  chatWithOllama: (payload) => invoke('ollama:chat', payload),
  chatWithProvider: (payload) => invoke('providers:chat', payload),
  completeFirstLaunch: () => invoke('app:complete-first-launch'),
  deleteModel: (payload) => invoke('models:delete', payload),
  deletePipeline: (pipelineId) => invoke('pipelines:delete', pipelineId),
  deletePipelineOutput: (payload) => invoke('pipelines:delete-output', payload),
  deletePromptStyle: (promptStyleId) => invoke('prompt-styles:delete', promptStyleId),
  deleteGraphWorkflowPreset: (presetId) => invoke('graph-workflow-presets:delete', presetId),
  disconnectProvider: (providerId) => invoke('providers:disconnect', providerId),
  dismissLegacyMigration: (sourceRoot) => invoke('settings:dismiss-legacy-migration', sourceRoot),
  downloadModel: (payload) => invoke('models:download', payload),
  getActivePipelineRun: () => invoke('pipelines:get-active-run'),
  getActiveRecording: () => invoke('recordings:get-active'),
  getCleanupPreview: () => invoke('settings:get-cleanup-preview'),
  getLiveResources: (payload) => invoke('app:get-live-resources', payload),
  getModelDownloadPreflight: (payload) => invoke('models:get-download-preflight', payload),
  getModelSettings: () => invoke('models:get-settings'),
  getKoboldCppSetup: (payload) => invoke('koboldcpp:get-setup', payload),
  getPipeline: (pipelineId) => invoke('pipelines:get', pipelineId),
  getPipelineOutputDeletionPreview: (payload) => invoke('pipelines:get-output-deletion-preview', payload),
  getRepairPreview: (toolId) => invoke('tools:get-repair-preview', toolId),
  cancelStatisticsRequest: (requestId) => invoke('settings:cancel-statistics-request', { requestId }),
  getStatistics: (payload) => invoke('settings:get-statistics', payload),
  getStatisticsCore: (payload) => invoke('settings:get-statistics-core', payload),
  getStatisticsStorage: (payload) => invoke('settings:get-statistics-storage', payload),
  getToolInstallPreflight: (payload) => invoke('tools:get-install-preflight', payload),
  getToolRuntimeOutput: (toolId) => invoke('tools:get-runtime-output', toolId),
  getWindowActivity: () => invoke('app:get-window-activity'),
  getScreenMode: () => invoke('window:get-screen-mode'),
  focusWindow: (payload) => invoke('app:focus-window', payload),
  showConfirmDialog: (payload) => ipcRenderer.sendSync('app:confirm-sync', payload),
  installTool: (payload) => invoke('tools:install', payload),
  launchTool: (payload) => invoke('tools:launch', payload),
  listLocalModels: (payload) => invoke('models:list-local', payload),
  listToolAssets: (payload) => invoke('models:list-tool-assets', payload),
  listOllamaModels: (options) => invoke('ollama:list-models', options),
  listPipelines: () => invoke('pipelines:list'),
  listPromptStyles: () => invoke('prompt-styles:list'),
  listPipelineOutputs: () => invoke('pipelines:list-outputs'),
  listProviderModels: (providerId) => invoke('providers:list-models', providerId),
  listGraphWorkflowPresets: () => invoke('graph-workflow-presets:list'),
  listProviders: () => invoke('providers:list'),
  listSnapshots: (toolId) => invoke('snapshots:list', toolId),
  listRecordingDevices: (forceRefresh = false) => invoke('recordings:list-devices', { forceRefresh }),
  listRecordingDisplays: () => invoke('recordings:list-displays'),
  selectRecordingRegion: (displayId) => invoke('recordings:select-region', { displayId }),
  listRecordings: () => invoke('recordings:list'),
  logRendererEvent: (payload) => invoke('app:log-renderer-event', payload),
  openDiagnosticsFolder: () => invoke('diagnostics:open-folder'),
  openAppUpdateTarget: (target) => invoke('updates:open-target', target),
  openLogsFolder: () => invoke('app:open-logs-folder'),
  openRecording: (id) => invoke('recordings:open', { id }),
  openRecordingsFolder: () => invoke('recordings:open-folder'),
  openPath: (payload) => invoke('app:open-path', payload),
  openToolFolder: (toolId) => invoke('tools:open-folder', toolId),
  inspectAiderProject: (projectDir) => invoke('aider:inspect-project', projectDir),
  listAiderModels: (payload) => invoke('aider:list-models', payload),
  pickAiderProjectFolder: () => invoke('aider:pick-project-folder'),
  pickPipelineFile: (payload) => invoke('pipelines:pick-file', payload),
  pickStorageFolder: () => invoke('settings:pick-storage-folder'),
  pickKoboldCppModel: (payload) => invoke('koboldcpp:pick-model', payload),
  pickWhisperAudioFile: () => invoke('whisper:pick-audio-file'),
  refresh: () => invoke('app:refresh'),
  repairTool: (payload) => invoke('tools:repair', payload),
  requestClose: () => ipcRenderer.send('window:request-close'),
  revealRecording: (id) => invoke('recordings:reveal', { id }),
  deleteRecording: (id) => invoke('recordings:delete', { id }),
  restoreSnapshot: (payload) => invoke('snapshots:restore', payload),
  resumePipelineValidation: (payload) => invoke('pipelines:resume-validation', payload),
  runCleanup: () => invoke('settings:run-cleanup'),
  runPipeline: (payload) => invoke('pipelines:run', payload),
  saveWindowSettings: (payload) => invoke('settings:save-window-settings', payload),
  saveHomeChecklistDismissed: (dismissed) => invoke('settings:save-home-checklist-dismissed', dismissed),
  saveCheckForUpdatesOnLaunch: (enabled) => invoke('updates:save-check-on-launch', enabled),
  savePreferredInstallRoot: (targetPath) => invoke('settings:save-preferred-install-root', targetPath),
  saveModelSettings: (payload) => invoke('models:save-settings', payload),
  saveKoboldCppSetup: (payload) => invoke('koboldcpp:save-setup', payload),
  savePromptStyle: (payload) => invoke('prompt-styles:save', payload),
  saveGraphWorkflowPreset: (payload) => invoke('graph-workflow-presets:save', payload),
  savePipeline: (payload) => invoke('pipelines:save', payload),
  saveProviderKey: (payload) => invoke('providers:save-key', payload),
  saveSnapshot: (toolId) => invoke('snapshots:save', toolId),
  sendToolInput: (payload) => invoke('tools:send-input', payload),
  setStorageLocation: (payload) => invoke('settings:set-storage-location', payload),
  setScreenMode: (screenMode) => invoke('window:set-screen-mode', screenMode),
  startRecording: (payload) => invoke('recordings:start', payload),
  startPipelineRecordInput: (payload) => invoke('pipelines:start-record-input', payload),
  stopRecording: () => invoke('recordings:stop'),
  stopPipelineRecordInput: (payload) => invoke('pipelines:stop-record-input', payload),
  stopTool: (toolId) => invoke('tools:stop', toolId),
  testProviderConnection: (providerId) => invoke('providers:test', providerId),
  toggleFullscreen: () => invoke('window:toggle-fullscreen'),
  transcribeWithWhisper: (payload) => invoke('whisper:transcribe', payload),
  uninstallTool: (payload) => invoke('tools:uninstall', payload),
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
  onRecordingStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('recordings:status-update', listener);
    return () => ipcRenderer.removeListener('recordings:status-update', listener);
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
  onScreenModeChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('window:screen-mode-changed', listener);
    return () => ipcRenderer.removeListener('window:screen-mode-changed', listener);
  },
});
