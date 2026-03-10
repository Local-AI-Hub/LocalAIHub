const path = require('path');
const fs = require('fs-extra');

const { ensureStorage, getAppPaths } = require('./configService');
const { normalizePipelineDefinition } = require('../shared/pipelineSchema.cjs');

const PIPELINES_DIRECTORY_NAME = 'pipelines';

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

async function getPipelineFilePath(pipelineId) {
  const directoryPath = await ensurePipelineStorage();
  return path.join(directoryPath, `${sanitizePipelineId(pipelineId)}.json`);
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

async function readPipelineFile(filePath) {
  const definition = await fs.readJson(filePath);
  return normalizePipelineDefinition(definition, {
    keepCreatedAt: true,
    keepUpdatedAt: true,
  });
}

async function listPipelines() {
  const directoryPath = await ensurePipelineStorage();
  const entries = await fs.readdir(directoryPath).catch(() => []);
  const pipelines = [];

  for (const entry of entries) {
    if (!String(entry || '').toLowerCase().endsWith('.json')) {
      continue;
    }

    const filePath = path.join(directoryPath, entry);
    try {
      const pipeline = await readPipelineFile(filePath);
      pipelines.push(buildPipelineSummary(pipeline));
    } catch {
      continue;
    }
  }

  return pipelines.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

async function getPipeline(pipelineId) {
  const filePath = await getPipelineFilePath(pipelineId);
  if (!(await fs.pathExists(filePath))) {
    throw new Error('Local AI Hub could not find that saved pipeline.');
  }

  return readPipelineFile(filePath);
}

async function savePipeline(definition) {
  const requestedId = definition?.id || null;
  const filePath = await getPipelineFilePath(requestedId || definition?.name || 'pipeline');
  let existing = null;

  if (await fs.pathExists(filePath)) {
    existing = await readPipelineFile(filePath).catch(() => null);
  }

  const pipeline = normalizePipelineDefinition(
    {
      ...(definition || {}),
      id: existing?.id || definition?.id,
      createdAt: definition?.createdAt || existing?.createdAt,
    },
    {
      keepCreatedAt: true,
      keepUpdatedAt: false,
    },
  );
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf8');
  await fs.move(tempPath, filePath, { overwrite: true });
  return pipeline;
}

async function deletePipeline(pipelineId) {
  const filePath = await getPipelineFilePath(pipelineId);
  if (!(await fs.pathExists(filePath))) {
    throw new Error('Local AI Hub could not find that saved pipeline.');
  }

  const pipeline = await readPipelineFile(filePath).catch(() => ({
    id: pipelineId,
    name: 'This pipeline',
  }));
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

