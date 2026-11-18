const path = require('path');
const { createHash, randomUUID } = require('crypto');
const fs = require('fs-extra');

const { ensureStorage, getAppPaths } = require('./configService');
const { normalizePipelineDefinition } = require('../shared/pipelineSchema.cjs');

const PIPELINES_DIRECTORY_NAME = 'pipelines';
let pendingMutation = Promise.resolve();

function queueMutation(operation) {
  const result = pendingMutation.then(operation);
  pendingMutation = result.catch(() => {});
  return result;
}

function sanitizePipelineId(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return normalized || 'pipeline';
}

async function getPipelinesDirectory() {
  await ensureStorage();
  return path.join(getAppPaths().configRoot, PIPELINES_DIRECTORY_NAME);
}

async function ensurePipelineStorage() {
  const directoryPath = await getPipelinesDirectory();
  await fs.ensureDir(directoryPath);
  return directoryPath;
}

// Older releases sometimes used the display name as the filename. The ID inside
// the file is authoritative, including for IDs that share a Windows filename.
async function locatePipeline(directory, id) {
  if (!id) throw new Error('Choose a saved pipeline first.');
  const digest = createHash('sha256').update(id).digest('hex');
  const filePath = path.join(directory, `id.${digest}.json`);
  if (await fs.pathExists(filePath)) {
    return { filePath, existing: await fs.readJson(filePath) };
  }

  const expected = `${sanitizePipelineId(id)}.json`;
  async function matchLegacyFile(entry) {
    const legacyPath = path.join(directory, entry);
    try {
      const definition = await fs.readJson(legacyPath);
      if (String(definition?.id || '').trim() === id) {
        return { filePath: legacyPath, existing: definition };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !['ENOENT', 'EISDIR'].includes(error.code)) throw error;
    }
    return null;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  const legacyFiles = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('id.') && entry.name.toLowerCase().endsWith('.json'));
  const expectedFile = legacyFiles.find((entry) => entry.name === expected);
  if (expectedFile) {
    const match = await matchLegacyFile(expected);
    if (match) return match;
  }
  for (const entry of legacyFiles) {
    if (entry === expectedFile) continue;
    const match = await matchLegacyFile(entry.name);
    if (match) return match;
  }
  return { filePath, existing: null };
}

function buildPipelineSummary(pipeline) {
  return {
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    createdAt: pipeline.createdAt,
    updatedAt: pipeline.updatedAt,
    nodeCount: Array.isArray(pipeline.nodes) ? pipeline.nodes.length : 0,
    edgeCount: Array.isArray(pipeline.edges) ? pipeline.edges.length : 0,
  };
}

async function listPipelines() {
  const directoryPath = await ensurePipelineStorage();
  const entries = await fs.readdir(directoryPath);
  const pipelines = [];

  for (const entry of entries) {
    if (!String(entry || '').toLowerCase().endsWith('.json')) {
      continue;
    }

    const filePath = path.join(directoryPath, entry);
    try {
      const definition = await fs.readJson(filePath);
      if (!definition?.id) continue;
      const metadata = normalizePipelineDefinition({ ...definition, nodes: [], edges: [] }, {
        keepCreatedAt: true,
        keepUpdatedAt: true,
      });
      pipelines.push(buildPipelineSummary({ ...metadata, nodes: definition.nodes, edges: definition.edges }));
    } catch {
      continue;
    }
  }

  return pipelines.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

async function getPipeline(pipelineId) {
  const { existing } = await locatePipeline(await ensurePipelineStorage(), String(pipelineId || '').trim());
  if (!existing) throw new Error('Local AI Hub could not find that saved pipeline.');
  return normalizePipelineDefinition(existing, { keepCreatedAt: true, keepUpdatedAt: true });
}

function savePipeline(definition) {
  return queueMutation(() => writePipeline(definition));
}

async function writePipeline(definition) {
  const pipeline = normalizePipelineDefinition(definition || {}, { keepCreatedAt: true });
  const { filePath, existing } = await locatePipeline(await ensurePipelineStorage(), pipeline.id);
  if (existing?.createdAt) pipeline.createdAt = existing.createdAt;

  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.remove(tempPath);
  }
  return pipeline;
}

function deletePipeline(pipelineId) {
  return queueMutation(() => removePipeline(pipelineId));
}

async function removePipeline(pipelineId) {
  const { filePath, existing: pipeline } = await locatePipeline(await ensurePipelineStorage(), String(pipelineId || '').trim());
  if (!pipeline) throw new Error('Local AI Hub could not find that saved pipeline.');
  await fs.remove(filePath);
  return {
    id: pipeline.id,
    name: pipeline.name,
  };
}

module.exports = {
  buildPipelineSummary,
  deletePipeline,
  ensurePipelineStorage,
  getPipeline,
  listPipelines,
  savePipeline,
};

