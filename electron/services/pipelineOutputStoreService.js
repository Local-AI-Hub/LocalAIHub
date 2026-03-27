const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');

const { ensureStorage, getAppPaths } = require('./configService');
const {
  buildFileArtifact,
  createTextArtifact,
  serializeArtifactForUi,
  summarizeArtifact,
} = require('./pipelineArtifactService');

const TEXT_FILE_EXTENSIONS = new Set(['.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.log', '.html', '.xml', '.ini', '.rtf']);
const METADATA_SUFFIXES = ['.audio.json', '.image.json', '.transcription.json', '.composition-export.json'];
const TEXT_MIME_TYPES = {
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.ini': 'text/plain',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.rtf': 'application/rtf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

function normalizePath(value) {
  return path.resolve(String(value || '').trim());
}

function isPathInside(parentPath, candidatePath) {
  const normalizedParent = normalizePath(parentPath);
  const normalizedCandidate = normalizePath(candidatePath);
  const parentKey = normalizedParent.toLowerCase();
  const candidateKey = normalizedCandidate.toLowerCase();
  return candidateKey === parentKey || candidateKey.startsWith(parentKey + path.sep.toLowerCase());
}

function isMetadataSidecar(fileName) {
  const normalizedFileName = String(fileName || '').trim().toLowerCase();
  return METADATA_SUFFIXES.some((suffix) => normalizedFileName.endsWith(suffix));
}

async function readJsonIfExists(filePath) {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  try {
    return await fs.readJson(filePath);
  } catch {
    return null;
  }
}

function toIsoString(value) {
  if (!value) {
    return '';
  }

  try {
    return new Date(value).toISOString();
  } catch {
    return '';
  }
}

function buildOutputRecord(recordPath, artifact, stat, context = {}) {
  const outputPath = artifact?.destinationPath || artifact?.directoryPath || artifact?.filePath || recordPath;
  const savedAt = toIsoString(stat?.mtime || stat?.birthtime || Date.now());
  const relativePath = path.relative(context.outputsDirectory || path.dirname(outputPath), outputPath).replace(/\\/g, '/');
  return {
    artifact: serializeArtifactForUi(artifact),
    fileName: path.basename(outputPath),
    id: `${context.runId || 'run'}:${relativePath || path.basename(outputPath)}`,
    isDirectory: Boolean(stat?.isDirectory?.()),
    kind: String(artifact?.kind || '').trim(),
    itemKind: String(artifact?.itemKind || '').trim(),
    outputLabel: String(artifact?.displayName || artifact?.fileName || path.basename(outputPath)).trim() || path.basename(outputPath),
    outputPath,
    outputsDirectory: context.outputsDirectory || '',
    runDirectory: context.runDirectory || '',
    runId: context.runId || '',
    savedAt,
    savedTimestamp: Number(stat?.mtimeMs || stat?.birthtimeMs || 0) || 0,
    summary: String(artifact?.summary || '').trim(),
  };
}

function attachTextFileDetails(artifact, filePath, stat, extension, transcription, metadataPaths) {
  artifact.destinationPath = filePath;
  artifact.extension = extension;
  artifact.fileName = path.basename(filePath);
  artifact.filePath = filePath;
  artifact.fileUrl = pathToFileURL(filePath).toString();
  artifact.formatLabel = artifact.formatLabel || 'Text file';
  artifact.mimeType = TEXT_MIME_TYPES[extension] || 'text/plain';
  artifact.sizeBytes = Number(stat?.size || 0) || 0;
  if (transcription) {
    artifact.transcription = serializeArtifactForUi(transcription);
  }
  if (metadataPaths.length) {
    artifact.metadataPaths = metadataPaths;
  }
  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

async function buildDiscoveredFileArtifact(filePath) {
  const normalizedFilePath = normalizePath(filePath);
  const stat = await fs.stat(normalizedFilePath);
  const extension = path.extname(normalizedFilePath).toLowerCase();
  const basePath = path.join(path.dirname(normalizedFilePath), path.basename(normalizedFilePath, extension));
  const metadataPaths = [];

  if (TEXT_FILE_EXTENSIONS.has(extension)) {
    const text = await fs.readFile(normalizedFilePath, 'utf8').catch(() => '');
    const transcriptionPath = `${basePath}.transcription.json`;
    const transcription = await readJsonIfExists(transcriptionPath);
    if (transcription) {
      metadataPaths.push(transcriptionPath);
    }

    const artifact = createTextArtifact(text, {
      displayName: path.basename(normalizedFilePath),
      metadataPaths,
      role: 'output',
      transcription,
    });
    return attachTextFileDetails(artifact, normalizedFilePath, stat, extension, transcription, metadataPaths);
  }

  const audioMetadataPath = `${basePath}.audio.json`;
  const imageMetadataPath = `${basePath}.image.json`;
  const compositionExportMetadataPath = `${basePath}.composition-export.json`;

  const audioMetadata = await readJsonIfExists(audioMetadataPath);
  const imageMetadata = await readJsonIfExists(imageMetadataPath);
  const compositionExportMetadata = await readJsonIfExists(compositionExportMetadataPath);

  if (audioMetadata) {
    metadataPaths.push(audioMetadataPath);
  }
  if (imageMetadata) {
    metadataPaths.push(imageMetadataPath);
  }
  if (compositionExportMetadata) {
    metadataPaths.push(compositionExportMetadataPath);
  }

  const artifact = await buildFileArtifact(normalizedFilePath, {
    audio: audioMetadata?.audio,
    audioGeneration: audioMetadata?.audioGeneration,
    audioTransformation: audioMetadata?.audioTransformation,
    compositionExport: compositionExportMetadata?.compositionExport,
    displayName: path.basename(normalizedFilePath),
    imageTransformation: imageMetadata?.imageTransformation,
    role: 'output',
  });

  artifact.destinationPath = normalizedFilePath;
  if (metadataPaths.length) {
    artifact.metadataPaths = metadataPaths;
  }
  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

function buildCollectionArtifactFromManifest(directoryPath, manifestPath, manifest) {
  const items = (Array.isArray(manifest?.items) ? manifest.items : []).map((entry, index) => ({
    artifact: serializeArtifactForUi(entry?.artifact || null),
    index: Number(entry?.index || index) || index,
    itemId: String(entry?.itemId || '').trim(),
    lineage: serializeArtifactForUi(entry?.lineage || null),
    summary: String(entry?.summary || '').trim(),
  }));

  const artifact = {
    accumulation: serializeArtifactForUi(manifest?.accumulation || null),
    destinationPath: directoryPath,
    directoryPath,
    displayName: String(manifest?.displayName || path.basename(directoryPath)).trim() || path.basename(directoryPath),
    fileName: path.basename(manifestPath),
    filePath: manifestPath,
    fileUrl: pathToFileURL(manifestPath).toString(),
    itemCount: Number(manifest?.itemCount || items.length) || items.length,
    itemKind: String(manifest?.itemKind || '').trim(),
    items,
    kind: 'collection',
    manifestPath,
    metadataPaths: [manifestPath],
    order: String(manifest?.order || 'explicit').trim() || 'explicit',
    previewKind: 'collection',
    role: String(manifest?.role || 'output').trim() || 'output',
    summary: String(manifest?.summary || '').trim(),
  };
  artifact.summary = artifact.summary || summarizeArtifact(artifact);
  return artifact;
}

function buildCompositionArtifactFromManifest(directoryPath, manifestPath, manifest) {
  const composition = serializeArtifactForUi(manifest?.composition) || {
    exportKind: String(manifest?.exportKind || 'video').trim() || 'video',
    recipeId: String(manifest?.recipeId || '').trim(),
    recipeLabel: String(manifest?.recipeLabel || '').trim(),
    tracks: serializeArtifactForUi(manifest?.tracks || []),
  };

  const artifact = {
    composition,
    destinationPath: directoryPath,
    directoryPath,
    displayName: String(manifest?.displayName || path.basename(directoryPath)).trim() || path.basename(directoryPath),
    fileName: path.basename(manifestPath),
    filePath: manifestPath,
    fileUrl: pathToFileURL(manifestPath).toString(),
    kind: 'composition',
    manifestPath,
    metadataPaths: [manifestPath],
    previewKind: 'composition',
    role: String(manifest?.role || 'output').trim() || 'output',
    summary: String(manifest?.summary || '').trim(),
    trackCount: Number(manifest?.trackCount || composition?.tracks?.length || 0) || 0,
  };
  artifact.summary = artifact.summary || summarizeArtifact(artifact);
  return artifact;
}

async function buildDiscoveredDirectoryArtifact(directoryPath) {
  const manifestPath = path.join(directoryPath, 'manifest.json');
  const manifest = await readJsonIfExists(manifestPath);
  if (!manifest) {
    return null;
  }

  if (String(manifest.kind || '').trim() === 'collection') {
    return buildCollectionArtifactFromManifest(directoryPath, manifestPath, manifest);
  }

  if (String(manifest.kind || '').trim() === 'composition') {
    return buildCompositionArtifactFromManifest(directoryPath, manifestPath, manifest);
  }

  return null;
}

async function listPipelineOutputs() {
  await ensureStorage();
  const pipelineRunsRoot = path.join(getAppPaths().runtimesRoot, 'pipeline-runs');
  if (!(await fs.pathExists(pipelineRunsRoot))) {
    return [];
  }

  const runEntries = await fs.readdir(pipelineRunsRoot).catch(() => []);
  const records = [];

  for (const runEntry of runEntries) {
    const runDirectory = path.join(pipelineRunsRoot, runEntry);
    let runStat = null;
    try {
      runStat = await fs.stat(runDirectory);
    } catch {
      runStat = null;
    }

    if (!runStat?.isDirectory?.()) {
      continue;
    }

    const outputsDirectory = path.join(runDirectory, 'outputs');
    if (!(await fs.pathExists(outputsDirectory))) {
      continue;
    }

    const outputEntries = await fs.readdir(outputsDirectory).catch(() => []);
    for (const outputEntry of outputEntries) {
      if (isMetadataSidecar(outputEntry)) {
        continue;
      }

      const recordPath = path.join(outputsDirectory, outputEntry);
      let stat = null;
      try {
        stat = await fs.stat(recordPath);
      } catch {
        stat = null;
      }

      if (!stat) {
        continue;
      }

      let artifact = null;
      if (stat.isDirectory()) {
        artifact = await buildDiscoveredDirectoryArtifact(recordPath);
      } else if (stat.isFile()) {
        artifact = await buildDiscoveredFileArtifact(recordPath);
      }

      if (!artifact) {
        continue;
      }

      records.push(buildOutputRecord(recordPath, artifact, stat, {
        outputsDirectory,
        runDirectory,
        runId: path.basename(runDirectory),
      }));
    }
  }

  return records.sort((left, right) => {
    if ((right.savedTimestamp || 0) !== (left.savedTimestamp || 0)) {
      return (right.savedTimestamp || 0) - (left.savedTimestamp || 0);
    }

    return String(right.outputLabel || '').localeCompare(String(left.outputLabel || ''));
  });
}

function resolvePipelineOutputRoot(targetPath, pipelineRunsRoot) {
  let currentPath = normalizePath(targetPath);
  const normalizedRunsRoot = normalizePath(pipelineRunsRoot);

  while (isPathInside(normalizedRunsRoot, currentPath)) {
    if (path.basename(currentPath).toLowerCase() === 'outputs') {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return '';
}

async function deletePipelineOutput(outputPath) {
  const targetPath = normalizePath(outputPath);
  if (!String(outputPath || '').trim()) {
    throw new Error('Choose a pipeline output to delete first.');
  }

  await ensureStorage();
  const pipelineRunsRoot = path.join(getAppPaths().runtimesRoot, 'pipeline-runs');
  const outputsRoot = resolvePipelineOutputRoot(targetPath, pipelineRunsRoot);
  if (!outputsRoot) {
    throw new Error('Local AI Hub can only delete files from known pipeline output folders in this pass.');
  }

  if (targetPath.toLowerCase() === outputsRoot.toLowerCase()) {
    throw new Error('Choose a saved pipeline output instead of the whole outputs folder.');
  }

  if (!(await fs.pathExists(targetPath))) {
    throw new Error('Local AI Hub could not find that pipeline output anymore.');
  }

  const label = path.basename(targetPath);
  await fs.remove(targetPath);
  return {
    deletedPath: targetPath,
    message: `${label} was removed from Local AI Hub's pipeline outputs.`,
  };
}

module.exports = {
  deletePipelineOutput,
  listPipelineOutputs,
};
