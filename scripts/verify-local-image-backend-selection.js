const assert = require('assert');

const {
  PIPELINE_OPERATION_IDS,
  analyzePipeline,
  buildContextMaps,
  createEdge,
  createEmptyPipeline,
  createNode,
  selectLocalImageBackend,
} = require('../electron/shared/pipelineSchema.cjs');

function tool(id, patch = {}) {
  return {
    id,
    name: id === 'forge' ? 'Stable Diffusion WebUI Forge' : id === 'automatic1111' ? 'Automatic1111' : 'Fooocus',
    appDir: 'C:/mock/' + id,
    installDir: 'C:/mock/' + id,
    launchProfile: { kind: 'folder', path: 'C:/mock/' + id },
    status: 'stopped',
    downloadedModels: [{ id: 'sd15.safetensors', name: 'SD 1.5', fileName: 'sd15.safetensors', modelType: 'checkpoint' }],
    pipelineCapabilities: id === 'automatic1111' || id === 'forge'
      ? { operations: { [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: { inputKinds: ['text'], outputKinds: ['image'] } } }
      : null,
    ...patch,
  };
}

function context(tools) {
  return buildContextMaps({
    tools,
    toolCatalog: tools,
  });
}

function main() {
  const healthyForge = tool('forge', { status: 'running' });
  const unhealthyA1111 = tool('automatic1111', { status: 'error', lastError: 'Automatic1111 crashed during startup.' });
  const autoSelection = selectLocalImageBackend(context([unhealthyA1111, healthyForge]), { config: {} });
  assert.strictEqual(autoSelection.toolId, 'forge', 'Auto should prefer healthy Forge over unhealthy Automatic1111.');

  const explicitA1111 = selectLocalImageBackend(context([unhealthyA1111, healthyForge]), { config: { toolId: 'automatic1111' } });
  assert.strictEqual(explicitA1111.toolId, 'automatic1111', 'Explicit Automatic1111 selection should be preserved.');
  assert.strictEqual(explicitA1111.usable, false, 'Explicit unhealthy Automatic1111 should report not usable instead of silently switching.');

  const explicitForge = selectLocalImageBackend(context([unhealthyA1111, healthyForge]), { config: { toolId: 'forge' } });
  assert.strictEqual(explicitForge.toolId, 'forge', 'Explicit Forge selection should be preserved.');
  assert.strictEqual(explicitForge.usable, true, 'Explicit healthy Forge should be usable.');

  const noModelForge = tool('forge', { downloadedModels: [] });
  const noUsable = selectLocalImageBackend(context([noModelForge]), { config: {} });
  assert.strictEqual(noUsable.usable, false, 'A backend with a known empty checkpoint list should not be marked usable.');
  assert(/checkpoint/i.test(noUsable.message), 'No-usable message should explain the checkpoint gap.');

  const forgeWithBackendTitle = tool('forge', {
    status: 'running',
    downloadedModels: [{
      title: 'v1-5-pruned-emaonly.safetensors [6ce0161689]',
      model_name: 'v1-5-pruned-emaonly',
      filename: 'D:/LocalAIHub/tools/forge/app/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors',
      modelType: 'checkpoint',
    }],
  });
  const filenameOverride = selectLocalImageBackend(context([forgeWithBackendTitle]), { config: { model: 'v1-5-pruned-emaonly.safetensors', toolId: 'forge' } });
  assert.strictEqual(filenameOverride.usable, true, 'Filename override should match a backend title/model_name/filename entry.');
  const webUiTitleOverride = selectLocalImageBackend(context([forgeWithBackendTitle]), { config: { model: 'v1-5-pruned-emaonly.safetensors [6ce0161689]', toolId: 'forge' } });
  assert.strictEqual(webUiTitleOverride.usable, true, 'WebUI title override with hash should match the same backend checkpoint identity.');

  const collectionMapOverride = selectLocalImageBackend(context([forgeWithBackendTitle]), { type: 'collectionMap', config: { executionMode: 'localTool', model: 'v1-5-pruned-emaonly.safetensors [6ce0161689]', toolId: 'forge' } });
  assert.strictEqual(collectionMapOverride.usable, true, 'collectionMap local image generation should use the same checkpoint identity path as Model Step.');

  const staleCacheSelection = selectLocalImageBackend(context([tool('forge', { status: 'running', downloadedModels: [{ fileName: 'other.safetensors', modelType: 'checkpoint' }] })]), { config: { model: 'selected-from-live-refresh.safetensors', toolId: 'forge' } });
  assert.strictEqual(staleCacheSelection.usable, true, 'A selected live checkpoint should not be blocked by stale local downloaded-model cache before runtime validates /sdapi/v1/sd-models.');
  assert(/live WebUI model list/i.test(staleCacheSelection.message), 'Stale cache message should explain that runtime will verify the live WebUI model list.');

  const fooocusSelection = selectLocalImageBackend(context([tool('fooocus')]), { config: { toolId: 'fooocus' } });
  assert.strictEqual(fooocusSelection.usable, false, 'Fooocus should not be exposed as pipeline-runnable without an adapter.');
  assert(/launchable from Library/i.test(fooocusSelection.message), 'Fooocus message should be honest about Library-only support.');

  const text = createNode('textInput', { id: 'prompt', config: { text: 'a quiet cabin' } });
  const image = createNode('llmPrompt', { id: 'image', config: { executionMode: 'localTool', operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE, toolId: '', model: '' } });
  const output = createNode('imageOutput', { id: 'output' });
  const pipeline = createEmptyPipeline({
    nodes: [text, image, output],
    edges: [createEdge(text.id, 'text', image.id, 'prompt'), createEdge(image.id, 'image', output.id, 'image')],
  });
  const analysis = analyzePipeline(pipeline, context([healthyForge, unhealthyA1111]));
  assert.strictEqual(analysis.executable, true, 'Blank checkpoint should be allowed when a usable backend can verify its live model list at runtime.');
  assert(/Forge/i.test(analysis.nodeSummaries[image.id].readiness.message), 'Image node readiness should name the selected healthy backend.');

  console.log('Local image backend selection verification passed.');
}

main();
