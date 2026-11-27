const crypto = require('crypto');
const { fault } = require('./bridge.cjs');
const { getArtifactChoices, buildSelectedCatalogItem } = require('../shared/modelArtifactSelection.cjs');

function searchFilters(tool, config) {
  return {
    allowedModelTypes: config.allowedModelTypes || (tool.id === 'ollama' ? ['all'] : ['all', 'checkpoint', 'lora', 'vae', 'embedding', 'controlnet', 'hypernetwork', 'upscaler', 'gguf', 'rvc-voice', 'audio-speech', 'video', 'inpainting']),
    allowedTaskTypes: config.allowedTaskTypes || (tool.id === 'ollama' ? ['all'] : ['all', 'image-generation', 'image-to-image', 'text-generation', 'video-generation', 'image-to-video', 'audio-speech', 'voice-conversion']),
  };
}

function removalId(tool, model) {
  return crypto.createHash('sha256').update(JSON.stringify([
    tool.id, model.id, model.path, model.invokeAiModelKey, model.packageManifestPath,
    model.downloadIdentity, model.name, model.sizeBytes, model.modifiedAt,
  ])).digest('hex');
}

function createModelManager({ models, listTools, hardware, storage, changed, withIdlePipeline }) {
  const selections = new Map();
  const pages = new Map();

  async function target(toolId) {
    const tool = (await listTools()).find(entry => entry.id === toolId);
    if (!tool || !models.supportsModelManager(tool)) throw fault('MODEL_TARGET_UNAVAILABLE', 'Choose an installed target from hub_model_manager.');
    return tool;
  }

  async function hardwareSnapshot() {
    const [specs, disks] = await Promise.all([hardware(), storage()]);
    return { ...specs, disks };
  }

  async function discover() {
    const [tools, specs] = await Promise.all([listTools(), hardwareSnapshot()]);
    return { hardware: specs, disks: specs.disks, targets: tools.filter(models.supportsModelManager).map(tool => {
      const config = models.getModelManagerConfig(tool);
      const { sources = [{ id: 'huggingface', label: 'Hugging Face' }] } = config;
      const { allowedModelTypes, allowedTaskTypes } = searchFilters(tool, config);
      const searchHint = tool.id === 'upscayl' ? 'Search by model name or Hugging Face repository ID. Each complete .param and .bin pair is a separate choice.' : sources.some(source => source.id === 'huggingface') ? 'Search by keyword, repository ID, or collection URL. Use owner/repo followed by a keyword to filter files inside a repository.' : undefined;
      return { toolId: tool.id, name: tool.name, sources, allowedModelTypes, allowedTaskTypes, searchHint, defaults: models.getModelManagerDefaults(tool) };
    }) };
  }

  async function search(args) {
    const tool = await target(args.toolId);
    const config = models.getModelManagerConfig(tool);
    if (args.source && !(config.sources || [{ id: 'huggingface' }]).some(source => source.id === args.source)) {
      throw fault('INVALID_SOURCE', 'Choose a catalog source listed for this target.');
    }
    const filters = searchFilters(tool, config);
    for (const [key, allowed] of [['modelType', filters.allowedModelTypes], ['taskType', filters.allowedTaskTypes]]) {
      if (args[key] && allowed?.length && !allowed.includes(args[key])) throw fault('INVALID_FILTER', 'Choose a supported ' + key + ' for this target.');
    }
    const signature = JSON.stringify(Object.fromEntries(Object.keys(args).filter(key => key !== 'cursor' && args[key] !== undefined).sort().map(key => [key, args[key]])));
    let result;
    if (args.cursor?.startsWith('agent-catalog:')) {
      const saved = pages.get(args.cursor);
      if (!saved || saved.signature !== signature) throw fault('SELECTION_EXPIRED', 'Repeat the same search to continue.');
      result = saved.result;
    } else result = await models.browseRemoteModels(tool, args);
    const expanded = result.items.flatMap(item => {
      const choices = getArtifactChoices(item);
      if (choices.length <= 64) return [item];
      const chunks = [];
      for (let i = 0; i < choices.length; i += 64) {
        const artifactChoices = choices.slice(i, i + 64);
        chunks.push(buildSelectedCatalogItem({ ...item, artifactChoices }));
      }
      return chunks;
    });
    const items = [];
    let size = 0;
    for (const item of expanded) {
      const count = Math.max(1, getArtifactChoices(item).length);
      if (items.length && size + count > 128) break;
      items.push(item); size += count;
    }
    let pagination = result.pagination;
    if (items.length < expanded.length) {
      const cursor = 'agent-catalog:' + crypto.randomUUID();
      pages.set(cursor, { signature, result: { items: expanded.slice(items.length), pagination } });
      if (pages.size > 128) pages.delete(pages.keys().next().value);
      pagination = { ...pagination, hasMore: true, nextCursor: cursor, nextPage: null };
    }
    return { pagination, items: items.map(item => {
      const selectionId = crypto.randomUUID();
      selections.set(selectionId, { toolId: tool.id, installDir: tool.installDir, item });
      if (selections.size > 256) selections.delete(selections.keys().next().value);
      return { selectionId, name: item.name, source: item.source, modelType: item.modelType,
        repository: item.catalogRepositoryId, fileName: item.fileName, sizeBytes: item.sizeBytes,
        license: item.license, modelPageUrl: item.modelPageUrl, hardwareFit: item.hardwareFit, downloaded: item.downloaded, blockingReason: item.downloadPlan?.blockingReason,
        choices: getArtifactChoices(item).map((choice, index) => ({
          choiceIndex: index, label: choice.label, version: choice.versionLabel, sizeBytes: choice.sizeBytes,
          hardwareFit: choice.payload?.hardwareFit, diskWarning: choice.payload?.diskWarning,
          recommended: choice.recommended, disabled: choice.disabled, reason: choice.reason || undefined,
        })) };
    }) };
  }

  async function resolveSelection({ selectionId, choiceIndex }) {
    const selection = selections.get(selectionId);
    if (!selection) throw fault('SELECTION_EXPIRED', 'Search the catalog again to select that model.');
    const tool = await target(selection.toolId);
    if (tool.installDir !== selection.installDir) throw fault('SELECTION_EXPIRED', 'The tool installation changed. Search again.');
    const choice = getArtifactChoices(selection.item)[choiceIndex];
    if (choiceIndex !== undefined && (!choice || choice.disabled)) throw fault('INVALID_CHOICE', 'Select an available artifact from the search result.');
    const payload = buildSelectedCatalogItem(selection.item, choice?.id);
    if (payload.selectedArtifactChoice?.disabled || payload.downloadPlan?.runnable === false) {
      throw fault('MODEL_INCOMPATIBLE', payload.downloadPlan?.blockingReason || 'This artifact cannot be installed for that target.');
    }
    return { tool, payload };
  }

  async function uninstall(tool, id) {
    return withIdlePipeline(async () => {
      const inventory = await models.listDownloadedModels(tool, { forceRefresh: true });
      const matches = inventory.filter(model => removalId(tool, model) === id);
      if (matches.length !== 1) throw fault('MODEL_NOT_FOUND', 'Refresh hub_models and select a current local model.');
      const result = await models.deleteModel(tool, matches[0]);
      await changed(tool, 'model-deleted');
      return { message: result.message };
    });
  }

  async function install({ tool, payload }, args, job) {
    const result = await models.downloadModel(tool, { ...payload, downloadId: job.jobId, lowDiskConfirmed: args.lowDiskConfirmed === true }, {
      onProgress: ({ percent, receivedBytes, totalBytes, message }) => {
        job.progress = { percent, receivedBytes, totalBytes, message };
      },
    });
    await changed(tool, 'model-downloaded');
    return { message: result.message };
  }

  async function preflight(args) {
    const { tool, payload } = await resolveSelection(args);
    return models.getModelDownloadPreflight(tool, payload);
  }

  return { hardwareSnapshot, discover, search, resolveSelection, target, preflight, install, uninstall,
    cancel: job => models.cancelModelDownload({ id: job.toolId }, { downloadId: job.jobId }) };
}

module.exports = { createModelManager, removalId };
