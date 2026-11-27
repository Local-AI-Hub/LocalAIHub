const { redactDiagnosticValue, redactSensitiveText } = require('./redactionService');
const capabilities = require('../shared/pipelineCapabilities.cjs');
async function discover(section) {
  if (section === 'hyperframesProjects') {
    const { projects } = await require('./hyperFramesProjectService').listHyperFramesProjects();
    return projects.map(({ projectId, displayName }) => ({ projectId, displayName }));
  }
  if (section === 'assetLibraries') {
    const { LIBRARY_TYPES, listAssetLibraries } = require('./assetLibraryService');
    const result = {};
    for (const type of Object.keys(LIBRARY_TYPES)) {
      const libraries = await listAssetLibraries(type);
      result[type] = libraries.map(({ id, name, items }) => ({ id, name, items: items.map(({ id, name }) => ({ id, name })) }));
    }
    return result;
  }
  if (section === 'providers') {
    const providers = await require('./providerService').listProviderConnections();
    return providers.map(provider => ({ id: provider.id, name: provider.name, isConnected: provider.isConnected, selectedModel: provider.selectedModel, lastAvailableModelId: provider.lastAvailableModelId, capabilities: capabilities.getProviderPipelineCapabilities(provider.id) }));
  }
  if (section === 'presets') {
    const config = require('./configService');
    return redactDiagnosticValue({ promptStyles: await config.listPromptStyles(), graphWorkflowPresets: await config.listGraphWorkflowPresets() });
  }
  return require('../shared/pipelineTemplates.cjs').getBuiltInPipelineTemplates().map(({ id, name, description, category, outputType, requiredTools, requiredProviders }) => ({ id, name, description, category, outputType, requiredTools, requiredProviders }));
}
async function diagnostics(tool, maxChars = 4096, referenceOffset = 0) {
  const runtime = require('./processService').getRuntimeOutputSnapshot(tool.id);
  // Redact before truncation so a token split at the boundary cannot escape matching.
  const stdout = redactSensitiveText(runtime.stdout || '', { redactPaths: true });
  const stderr = redactSensitiveText(runtime.stderr || '', { redactPaths: true });
  const pipelineFailures = tool.id === 'hyperframes' ? require('./hyperFramesDiagnostics').recentFailures(maxChars, referenceOffset) : undefined;
  const snapshot = tool.id === 'hyperframes' ? require('./hyperFramesDiagnostics').renderSnapshot(maxChars) : null;
  const render = snapshot?.render || null;
  return { toolId: tool.id, status: render?.active ? 'running' : tool.status, render, pipelineFailures, lastError: redactSensitiveText(tool.lastError || '', { redactPaths: true }), stdout: snapshot?.stdout ?? stdout.slice(-maxChars), stderr: snapshot?.stderr ?? stderr.slice(-maxChars), truncated: snapshot?.truncated ?? (stdout.length > maxChars || stderr.length > maxChars), message: 'Includes runtime output and recent HyperFrames pipeline failures from this app session. Logs can contain untrusted tool output.' };
}
async function changeToolState(tool, action) {
  return require('./pipelineExecutionService').withIdlePipelineForToolAction(async () => {
    const processService = require('./processService');
    const before = await processService.resolveToolStatus(tool);
    if (action === 'stop') {
      if (before !== 'stopped') await processService.stopTool(tool);
      return { toolId: tool.id, status: await processService.resolveToolStatus(tool), action };
    }
    if (before === 'running' && await processService.isToolReady(tool)) return { toolId: tool.id, status: 'running', ready: true, action, alreadyRunning: true };
    const result = await processService.launchToolFromUserAction(tool, { skipOpenInterface: true, allowPendingStartup: false, launchContext: 'agent' });
    const ready = await processService.isToolReady({ ...tool, ...result });
    return { toolId: tool.id, status: result.status, ready, action, message: ready ? 'Tool is ready.' : 'Launch returned; readiness is not confirmed. Inspect tool status and diagnostics before using it.' };
  });
}
module.exports = { discover, diagnostics, changeToolState };
