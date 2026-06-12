const path = require('path');

const { isPathInside } = require('./pathSafetyService');

const SAFE_OWNER_ID = /^[a-z0-9_-]{1,120}$/i;
const SAFE_EXTENSIONS = new Set(['mkv', 'wav', 'webm']);

function normalizeOwnerId(value, label) {
  const normalized = String(value || '').trim();
  if (!SAFE_OWNER_ID.test(normalized)) {
    throw new Error(`Local AI Hub could not identify the pipeline ${label} for this recording.`);
  }
  return normalized;
}

async function assertNoLinks(fsApi, rootPath, candidatePath) {
  if (!isPathInside(rootPath, candidatePath)) {
    throw new Error('Local AI Hub refused to use a pipeline recording path outside the current run.');
  }

  const relative = path.relative(rootPath, candidatePath);
  let currentPath = path.resolve(rootPath);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    if (!(await fsApi.pathExists(currentPath))) {
      continue;
    }
    const stat = await fsApi.lstat(currentPath);
    if (stat.isSymbolicLink()) {
      throw new Error('Local AI Hub refused to use a pipeline recording path that contains a link or reparse point.');
    }
  }
}

async function resolvePipelineRecordingPaths(options = {}) {
  const context = options.context?.recordingContext;
  if (context?.type !== 'pipelineRun') {
    return null;
  }

  const extension = String(options.extension || '').trim().toLowerCase().replace(/^\./, '');
  if (!SAFE_EXTENSIONS.has(extension)) {
    throw new Error('Local AI Hub refused an unsupported pipeline recording format.');
  }

  const runId = normalizeOwnerId(context.runId, 'run');
  const nodeId = normalizeOwnerId(context.nodeId, 'node');
  const id = normalizeOwnerId(options.id, 'recording');
  const appPaths = options.getAppPaths();
  const runtimesRoot = path.resolve(String(appPaths?.runtimesRoot || '').trim());
  const runRoot = path.join(runtimesRoot, 'pipeline-runs', runId);
  const artifactsRoot = path.join(runRoot, 'artifacts');
  const directoryPath = path.join(artifactsRoot, 'record-input', nodeId);
  const outputPath = path.join(directoryPath, `${id}.${extension}`);
  const sidecarPath = path.join(directoryPath, `${id}.recording.json`);

  if (
    !isPathInside(runtimesRoot, runRoot)
    || !isPathInside(runRoot, artifactsRoot)
    || !isPathInside(artifactsRoot, outputPath)
    || !isPathInside(artifactsRoot, sidecarPath)
  ) {
    throw new Error('Local AI Hub refused to create a recording outside the current pipeline run.');
  }
  if (!(await options.fs.pathExists(artifactsRoot))) {
    throw new Error('The current pipeline run artifact folder is no longer available.');
  }

  await assertNoLinks(options.fs, runtimesRoot, artifactsRoot);
  await options.fs.ensureDir(directoryPath);
  await assertNoLinks(options.fs, artifactsRoot, directoryPath);

  return {
    artifactsRoot,
    directoryPath,
    nodeId,
    outputPath,
    outputRelativePath: path.relative(artifactsRoot, outputPath).replace(/\\/g, '/'),
    runId,
    runRoot,
    sidecarPath,
  };
}

function buildPipelineRecordingMetadata(storage, outputArtifactType) {
  if (!storage) {
    return {};
  }
  return {
    artifactRole: 'intermediate',
    nodeId: storage.nodeId,
    outputArtifactType,
    recordingContext: 'pipelineRun',
    runId: storage.runId,
  };
}

module.exports = {
  buildPipelineRecordingMetadata,
  resolvePipelineRecordingPaths,
  _test: {
    SAFE_EXTENSIONS,
    SAFE_OWNER_ID,
  },
};
