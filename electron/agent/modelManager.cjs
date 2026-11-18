const crypto = require('crypto');
const { fault } = require('./bridge.cjs');
const { getArtifactChoices, buildSelectedCatalogItem } = require('../shared/modelArtifactSelection.cjs');

function removalId(tool, model) {
  return crypto.createHash('sha256').update(JSON.stringify([
    tool.id, model.id, model.path, model.invokeAiModelKey, model.packageManifestPath,
    model.downloadIdentity, model.name, model.sizeBytes, model.modifiedAt,
  ])).digest('hex');
}

function createModelManager({ models, listTools, hardware, storage, changed, withIdlePipeline }) {
  const selections = new Map();

  async function target(toolId) {
    const tool = (await listTools()).find(entry => entry.id === toolId);
    if (!tool || !models.supportsModelManager(tool)) throw fault('MODEL_TARGET_UNAVAILABLE', 'Choose an installed target from hub_model_manager.');
    return tool;
  }

  async function discover() {
    const [tools, specs, disks] = await Promise.all([listTools(), hardware(), storage()]);
    return { hardware: { ...specs, disks }, disks, targets: tools.filter(models.supportsModelManager).map(tool => {
      const { sources = [{ id: 'huggingface', label: 'Hugging Face' }], allowedModelTypes, allowedTaskTypes } = models.getModelManagerConfig(tool);
      const searchHint = tool.id === 'upscayl' ? 'Enter an exact Hugging Face repository ID (owner/repository) containing a matching .param and .bin pair.' : undefined;
      return { toolId: tool.id, name: tool.name, sources, allowedModelTypes, allowedTaskTypes, searchHint, defaults: models.getModelManagerDefaults(tool) };
    }) };
  }

  async function search(args) {
    const tool = await target(args.toolId);
    const config = models.getModelManagerConfig(tool);
    if (args.source && !(config.sources || [{ id: 'huggingface' }]).some(source => source.id === args.source)) {
      throw fault('INVALID_SOURCE', 'Choose a catalog source listed for this target.');
    }
    for (const [key, allowed] of [['modelType', config.allowedModelTypes], ['taskType', config.allowedTaskTypes]]) {
      if (args[key] && allowed?.length && !allowed.includes(args[key])) throw fault('INVALID_FILTER', 'Choose a supported ' + key + ' for this target.');
    }
    const { items, pagination } = await models.browseRemoteModels(tool, args);
    return { pagination, items: items.map(item => {
      const selectionId = crypto.randomUUID();
      selections.set(selectionId, { toolId: tool.id, installDir: tool.installDir, item });
      if (selections.size > 256) selections.delete(selections.keys().next().value);
      return { selectionId, name: item.name, source: item.source, modelType: item.modelType,
        repository: item.catalogRepositoryId, fileName: item.fileName, sizeBytes: item.sizeBytes,
        license: item.license, modelPageUrl: item.modelPageUrl, hardwareFit: item.hardwareFit, downloaded: item.downloaded, blockingReason: item.downloadPlan?.blockingReason,
        choices: getArtifactChoices(item).map((choice, index) => ({
          choiceIndex: index, label: choice.label, version: choice.versionLabel, sizeBytes: choice.sizeBytes,
          recommended: choice.recommended, disabled: choice.disabled,
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

  return { discover, search, resolveSelection, target, preflight, install, uninstall,
    cancel: job => models.cancelModelDownload({ id: job.toolId }, { downloadId: job.jobId }) };
}

module.exports = { createModelManager, removalId };
