const path = require('path');
const { app } = require('electron');
const config = require('./configService');
const { createBridge } = require('../agent/bridge.cjs');
const { createOperations } = require('../agent/operations.cjs');
let bridge;
let operations;
let transition = Promise.resolve();
let notifyModelChange;
function listModelTools() {
  return require('./toolStateService').buildMergedToolStateList({ resolveStatuses: true, includeSnapshots: false });
}
let mediaInspector;
let mediaDelivery;
function deliverMedia(output, args) {
  if (!mediaDelivery) mediaDelivery = require('./agentMediaDeliveryService').createMediaDelivery({ runsRoot: () => path.join(config.getAppPaths().runtimesRoot, 'pipeline-runs') });
  return mediaDelivery.deliver(output, args);
}
function inspectMedia(output, args) {
  if (!mediaInspector) {
    const { resolveFfmpegPath, resolveFfprobePath } = require('./mediaCompositionService');
    mediaInspector = require('./agentMediaService').createMediaInspector({ runsRoot: () => path.join(config.getAppPaths().runtimesRoot, 'pipeline-runs'), ffmpegPath: resolveFfmpegPath, ffprobePath: resolveFfprobePath });
  }
  return mediaInspector(output, args);
}
function getOperations() {
  if (!operations) operations = createOperations({
    version: app.getVersion(),
    humanizeError: config.humanizeError,
    modelManager: require('../agent/modelManager.cjs').createModelManager({
      models: require('./modelService'),
      listTools: listModelTools,
      hardware: async () => (await config.readConfig()).hardware || require('./hardwareService').detectHardwareSnapshot(),
      storage: () => require('./hardwareService').detectStorageSnapshot(),
      changed: (tool, reason) => notifyModelChange?.(tool, reason),
      withIdlePipeline: operation => require('./pipelineExecutionService').withIdlePipelineForToolAction(operation),
    }),
    inspectMedia,
    deliverMedia,
    toolCapabilities: id => require('../shared/pipelineCapabilities.cjs').getToolPipelineCapabilities(id),
    discover: section => require('./agentCapabilityService').discover(section),
    diagnostics: (tool, limit) => require('./agentCapabilityService').diagnostics(tool, limit),
    changeToolState: (tool, action) => require('./agentCapabilityService').changeToolState(tool, action),
    readConfig: config.readConfig,
    schema: require('../shared/pipelineSchema.cjs'),
    store: require('./pipelineStoreService'),
    execution: require('./pipelineExecutionService'),
    listTools: listModelTools,
    listModels: tool => require('./modelService').listDownloadedModels(tool),
    listOutputs: () => require('./pipelineOutputStoreService').listPipelineOutputs(),
    runsRoot: () => path.join(config.getAppPaths().runtimesRoot, 'pipeline-runs'),
  });
  return operations;
}
function getBridge() {
  if (!bridge) bridge = createBridge({
    descriptorPath: path.join(config.getAppPaths().configRoot, 'agent-connection.json'),
    sanitizeError: config.humanizeError,
    dispatch: async (method, params) => {
      if (!(await config.readConfig()).agentAccessEnabled) throw new Error('Agent access is disabled in Settings.');
      return getOperations().dispatch(method, params);
    },
  });
  return bridge;
}
function clientDirectory() { return app.isPackaged ? path.join(process.resourcesPath, 'agent') : path.join(__dirname, '..', 'agent'); }
async function getAgentAccess() {
  return { enabled: Boolean((await config.readConfig()).agentAccessEnabled), running: Boolean(bridge?.isRunning()),
    serverPath: path.join(clientDirectory(), 'server.cjs'), cliPath: path.join(clientDirectory(), 'cli.cjs'),
    extensionPath: app.isPackaged ? path.join(process.resourcesPath, 'LocalAIHub.mcpb') : path.join(__dirname, '..', '..', 'release', 'LocalAIHub.mcpb'),
    descriptorPath: path.join(config.getAppPaths().configRoot, 'agent-connection.json') };
}
function setAgentAccess(enabled) {
  if (typeof enabled !== 'boolean') return Promise.reject(new Error('Choose whether agent access is enabled.'));
  const task = transition.then(async () => {
    if (enabled) {
      await getBridge().start();
      try { await config.updateConfig(current => ({ ...current, agentAccessEnabled: true })); }
      catch (error) { await getBridge().stop(); throw error; }
    } else {
      await config.updateConfig(current => ({ ...current, agentAccessEnabled: false }));
      await getBridge().stop();
      if (mediaDelivery) await mediaDelivery.stop();
    }
    return getAgentAccess();
  });
  transition = task.catch(() => {});
  return task;
}
async function startAgentAccess(onModelChange) { notifyModelChange = onModelChange; return setAgentAccess(Boolean((await config.readConfig()).agentAccessEnabled)); }
async function stopAgentAccess() { await transition; if (bridge) await bridge.stop(); if (mediaDelivery) await mediaDelivery.stop(); }
function rememberAgentRun(run) { getOperations().remember(run); }
module.exports = { getAgentAccess, setAgentAccess, startAgentAccess, stopAgentAccess, rememberAgentRun };
