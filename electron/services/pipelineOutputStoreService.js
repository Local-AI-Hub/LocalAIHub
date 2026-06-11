const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');

const { ensureStorage, getAppPaths } = require('./configService');
const {
  buildFileArtifact,
  createAuditArtifact,
  createPlanArtifact,
  createPlanningPacketArtifact,
  createPreviewArtifact,
  createTextArtifact,
  serializeArtifactForUi,
  summarizeArtifact,
} = require('./pipelineArtifactService');

const TEXT_FILE_EXTENSIONS = new Set(['.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.log', '.html', '.xml', '.ini', '.rtf']);
const METADATA_SUFFIXES = ['.audio.json', '.image.json', '.transcription.json', '.composition-export.json', '.video.json', '.image-analysis.json', '.subtitle.json'];
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

function isDiscoverableFinalOutputArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return false;
  }

  const artifactRole = String(artifact.artifactRole || '').trim().toLowerCase();
  if (['debug', 'intermediate', 'internal'].includes(artifactRole)) {
    return false;
  }

  if (artifact.isFinalOutput === false) {
    return false;
  }

  const role = String(artifact.role || '').trim().toLowerCase();
  if (role && role !== 'output' && artifactRole !== 'final' && artifact.isFinalOutput !== true) {
    return false;
  }

  return true;
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
    isFinalOutput: artifact?.isFinalOutput !== false,
    itemKind: String(artifact?.itemKind || '').trim(),
    outputKind: String(artifact?.outputKind || artifact?.kind || '').trim(),
    outputLabel: String(artifact?.outputLabel || artifact?.displayName || artifact?.fileName || path.basename(outputPath)).trim() || path.basename(outputPath),
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

function attachJsonArtifactDetails(artifact, filePath, stat) {
  artifact.destinationPath = filePath;
  artifact.extension = '.json';
  artifact.fileName = path.basename(filePath);
  artifact.filePath = filePath;
  artifact.fileUrl = pathToFileURL(filePath).toString();
  artifact.formatLabel = artifact.formatLabel || 'JSON document';
  artifact.mimeType = 'application/json';
  artifact.sizeBytes = Number(stat?.size || 0) || 0;
  artifact.summary = summarizeArtifact(artifact);
  return artifact;
}

async function buildDiscoveredTypedJsonArtifact(filePath, stat) {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedLowerPath = normalizedFilePath.toLowerCase();
  const payload = await readJsonIfExists(normalizedFilePath);
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (normalizedLowerPath.endsWith('.packet.json')) {
    return attachJsonArtifactDetails(createPlanningPacketArtifact(payload, {
      displayName: path.basename(normalizedFilePath),
      role: 'output',
    }), normalizedFilePath, stat);
  }

  if (normalizedLowerPath.endsWith('.plan.json')) {
    return attachJsonArtifactDetails(createPlanArtifact(payload, {
      displayName: path.basename(normalizedFilePath),
      role: 'output',
    }), normalizedFilePath, stat);
  }

  if (normalizedLowerPath.endsWith('.preview.json')) {
    return attachJsonArtifactDetails(createPreviewArtifact(payload, {
      displayName: path.basename(normalizedFilePath),
      role: 'output',
    }), normalizedFilePath, stat);
  }

  if (normalizedLowerPath.endsWith('.audit.json')) {
    return attachJsonArtifactDetails(createAuditArtifact(payload, {
      displayName: path.basename(normalizedFilePath),
      role: 'output',
    }), normalizedFilePath, stat);
  }

  return null;
}


async function buildDiscoveredFileArtifact(filePath) {
  const normalizedFilePath = normalizePath(filePath);
  const stat = await fs.stat(normalizedFilePath);
  const extension = path.extname(normalizedFilePath).toLowerCase();
  const basePath = path.join(path.dirname(normalizedFilePath), path.basename(normalizedFilePath, extension));
  const metadataPaths = [];
  const typedJsonArtifact = await buildDiscoveredTypedJsonArtifact(normalizedFilePath, stat);
  if (typedJsonArtifact) {
    return typedJsonArtifact;
  }

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
  const videoMetadataPath = `${basePath}.video.json`;

  const audioMetadata = await readJsonIfExists(audioMetadataPath);
  const imageMetadata = await readJsonIfExists(imageMetadataPath);
  const compositionExportMetadata = await readJsonIfExists(compositionExportMetadataPath);
  const videoMetadata = await readJsonIfExists(videoMetadataPath);

  if (audioMetadata) {
    metadataPaths.push(audioMetadataPath);
  }
  if (imageMetadata) {
    metadataPaths.push(imageMetadataPath);
  }
  if (compositionExportMetadata) {
    metadataPaths.push(compositionExportMetadataPath);
  }
  if (videoMetadata) {
    metadataPaths.push(videoMetadataPath);
  }

  const artifact = await buildFileArtifact(normalizedFilePath, {
    audio: audioMetadata?.audio,
    audioGeneration: audioMetadata?.audioGeneration,
    audioTransformation: audioMetadata?.audioTransformation,
    compositionExport: compositionExportMetadata?.compositionExport,
    displayName: path.basename(normalizedFilePath),
    imageTransformation: imageMetadata?.imageTransformation,
    videoGeneration: videoMetadata?.videoGeneration,
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
    artifactRole: String(manifest?.artifactRole || '').trim(),
    destinationPath: directoryPath,
    directoryPath,
    displayName: String(manifest?.displayName || path.basename(directoryPath)).trim() || path.basename(directoryPath),
    fileName: path.basename(manifestPath),
    filePath: manifestPath,
    fileUrl: pathToFileURL(manifestPath).toString(),
    isFinalOutput: manifest?.isFinalOutput === true || String(manifest?.artifactRole || '').trim() === 'final' || String(manifest?.role || 'output').trim() === 'output',
    itemCount: Number(manifest?.itemCount || items.length) || items.length,
    itemKind: String(manifest?.itemKind || '').trim(),
    items,
    kind: 'collection',
    manifestPath,
    metadataPaths: [manifestPath],
    order: String(manifest?.order || 'explicit').trim() || 'explicit',
    outputKind: String(manifest?.outputKind || '').trim(),
    outputLabel: String(manifest?.outputLabel || '').trim(),
    outputNodeId: String(manifest?.outputNodeId || '').trim(),
    outputPortId: String(manifest?.outputPortId || '').trim(),
    previewKind: 'collection',
    role: String(manifest?.role || 'output').trim() || 'output',
    runId: String(manifest?.runId || '').trim(),
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
    artifactRole: String(manifest?.artifactRole || '').trim(),
    composition,
    destinationPath: directoryPath,
    directoryPath,
    displayName: String(manifest?.displayName || path.basename(directoryPath)).trim() || path.basename(directoryPath),
    fileName: path.basename(manifestPath),
    filePath: manifestPath,
    fileUrl: pathToFileURL(manifestPath).toString(),
    isFinalOutput: manifest?.isFinalOutput === true || String(manifest?.artifactRole || '').trim() === 'final' || String(manifest?.role || 'output').trim() === 'output',
    kind: 'composition',
    manifestPath,
    metadataPaths: [manifestPath],
    outputKind: String(manifest?.outputKind || '').trim(),
    outputLabel: String(manifest?.outputLabel || '').trim(),
    outputNodeId: String(manifest?.outputNodeId || '').trim(),
    outputPortId: String(manifest?.outputPortId || '').trim(),
    previewKind: 'composition',
    role: String(manifest?.role || 'output').trim() || 'output',
    runId: String(manifest?.runId || '').trim(),
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

      if (!artifact || !isDiscoverableFinalOutputArtifact(artifact)) {
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

function resolvePipelineOutputContext(targetPath, pipelineRunsRoot) {
  let currentPath = normalizePath(targetPath);
  const normalizedRunsRoot = normalizePath(pipelineRunsRoot);

  while (isPathInside(normalizedRunsRoot, currentPath)) {
    if (path.basename(currentPath).toLowerCase() === 'outputs') {
      const runDirectory = path.dirname(currentPath);
      if (path.dirname(runDirectory).toLowerCase() !== normalizedRunsRoot.toLowerCase()) {
        return null;
      }

      return {
        artifactsRoot: path.join(runDirectory, 'artifacts'),
        outputsRoot: currentPath,
        runDirectory,
        runId: path.basename(runDirectory),
      };
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return null;
}

function resolvePipelineOutputRoot(targetPath, pipelineRunsRoot) {
  return resolvePipelineOutputContext(targetPath, pipelineRunsRoot)?.outputsRoot || '';
}

function getAdjacentMetadataSidecarPaths(filePath) {
  const basePath = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)));
  return METADATA_SUFFIXES.map((suffix) => `${basePath}${suffix}`);
}

async function assertPathHasNoLinks(rootPath, candidatePath) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedCandidate = normalizePath(candidatePath);
  if (!isPathInside(normalizedRoot, normalizedCandidate)) {
    throw new Error('Local AI Hub refused to inspect a pipeline cleanup path outside its owning run folder.');
  }

  const relativePath = path.relative(normalizedRoot, normalizedCandidate);
  const segments = relativePath ? relativePath.split(path.sep).filter(Boolean) : [];
  let currentPath = normalizedRoot;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    if (!(await fs.pathExists(currentPath))) {
      continue;
    }
    const stat = await fs.lstat(currentPath);
    if (stat.isSymbolicLink()) {
      throw new Error('Local AI Hub refused to delete a pipeline path that uses a link or reparse point.');
    }
  }
}

async function inspectDeletionPath(targetPath, owningRoot) {
  const normalizedTarget = normalizePath(targetPath);
  await assertPathHasNoLinks(owningRoot, normalizedTarget);
  const stat = await fs.lstat(normalizedTarget);
  if (stat.isSymbolicLink()) {
    throw new Error('Local AI Hub refused to delete a pipeline path that uses a link or reparse point.');
  }

  if (stat.isFile()) {
    return { bytes: Number(stat.size || 0) || 0, directories: 0, files: 1 };
  }
  if (!stat.isDirectory()) {
    throw new Error('Local AI Hub can only delete regular pipeline output files or folders.');
  }

  const summary = { bytes: 0, directories: 1, files: 0 };
  const entries = await fs.readdir(normalizedTarget);
  for (const entry of entries) {
    const childSummary = await inspectDeletionPath(path.join(normalizedTarget, entry), owningRoot);
    summary.bytes += childSummary.bytes;
    summary.directories += childSummary.directories;
    summary.files += childSummary.files;
  }
  return summary;
}

function combinePathSummaries(summaries) {
  return summaries.reduce((total, summary) => ({
    bytes: total.bytes + Number(summary?.bytes || 0),
    directories: total.directories + Number(summary?.directories || 0),
    files: total.files + Number(summary?.files || 0),
  }), { bytes: 0, directories: 0, files: 0 });
}

function assertDeletablePipelineOutputPath(candidatePath, outputsRoot) {
  const normalizedCandidate = normalizePath(candidatePath);
  if (!isPathInside(outputsRoot, normalizedCandidate)) {
    throw new Error('Local AI Hub refused to delete a pipeline output companion outside the known output folder.');
  }

  if (normalizedCandidate.toLowerCase() === normalizePath(outputsRoot).toLowerCase()) {
    throw new Error('Choose a saved pipeline output instead of the whole outputs folder.');
  }

  return normalizedCandidate;
}

async function buildPipelineOutputDeletionSet(targetPath, outputsRoot, runDirectory = path.dirname(outputsRoot)) {
  const normalizedTargetPath = assertDeletablePipelineOutputPath(targetPath, outputsRoot);
  await assertPathHasNoLinks(runDirectory, normalizedTargetPath);
  let stat = null;
  try {
    stat = await fs.lstat(normalizedTargetPath);
  } catch {
    throw new Error('Local AI Hub could not find that pipeline output anymore.');
  }

  if (stat.isSymbolicLink()) {
    throw new Error('Local AI Hub refused to delete a pipeline output that uses a link or reparse point.');
  }
  if (stat.isDirectory()) {
    return [normalizedTargetPath];
  }
  if (!stat.isFile()) {
    throw new Error('Choose a saved pipeline output file or folder to delete.');
  }

  const deletionSet = [];
  for (const sidecarPath of getAdjacentMetadataSidecarPaths(normalizedTargetPath)) {
    const normalizedSidecarPath = assertDeletablePipelineOutputPath(sidecarPath, outputsRoot);
    if (normalizedSidecarPath.toLowerCase() === normalizedTargetPath.toLowerCase()) {
      continue;
    }

    if (await fs.pathExists(normalizedSidecarPath)) {
      await assertPathHasNoLinks(runDirectory, normalizedSidecarPath);
      deletionSet.push(normalizedSidecarPath);
    }
  }
  deletionSet.push(normalizedTargetPath);

  return [...new Map(deletionSet.map((entry) => [entry.toLowerCase(), entry])).values()];
}

function normalizeDeletionMode(options = {}) {
  return options.deleteMode === 'permanent' || options.useTrash === false ? 'permanent' : 'trash';
}

async function listRemainingOutputEntries(outputsRoot, deletionSet) {
  if (!(await fs.pathExists(outputsRoot))) {
    return [];
  }
  const deletedKeys = new Set(deletionSet.map((entry) => normalizePath(entry).toLowerCase()));
  const entries = await fs.readdir(outputsRoot);
  return entries
    .map((entry) => path.join(outputsRoot, entry))
    .filter((entryPath) => !deletedKeys.has(normalizePath(entryPath).toLowerCase()));
}

async function canDeleteWholeRun(context, deletionSet) {
  const remainingOutputEntries = await listRemainingOutputEntries(context.outputsRoot, deletionSet);
  if (remainingOutputEntries.length > 0) {
    return false;
  }

  await assertPathHasNoLinks(path.dirname(context.runDirectory), context.runDirectory);
  const runEntries = await fs.readdir(context.runDirectory);
  const allowedNames = new Set(['artifacts', 'outputs']);
  return runEntries.every((entry) => allowedNames.has(String(entry || '').toLowerCase()));
}

async function buildPipelineOutputDeletionPreview(outputPath, options = {}) {
  const targetPath = normalizePath(outputPath);
  if (!String(outputPath || '').trim()) {
    throw new Error('Choose a pipeline output to delete first.');
  }

  await ensureStorage();
  const pipelineRunsRoot = path.join(getAppPaths().runtimesRoot, 'pipeline-runs');
  const context = resolvePipelineOutputContext(targetPath, pipelineRunsRoot);
  if (!context) {
    throw new Error('Local AI Hub can only delete files from known pipeline output folders.');
  }

  const selectedPaths = await buildPipelineOutputDeletionSet(targetPath, context.outputsRoot, context.runDirectory);
  const selectedSummary = combinePathSummaries(await Promise.all(selectedPaths.map((entry) => inspectDeletionPath(entry, context.runDirectory))));
  const artifactsExist = await fs.pathExists(context.artifactsRoot);
  let artifactSummary = { bytes: 0, directories: 0, files: 0 };
  let artifactInspectionError = '';
  if (artifactsExist) {
    try {
      artifactSummary = await inspectDeletionPath(context.artifactsRoot, context.runDirectory);
    } catch (error) {
      artifactInspectionError = String(error?.message || error).trim();
    }
  }
  const activeRunId = String(options.activeRunId || '').trim();
  const activeRunBlocked = Boolean(activeRunId && activeRunId === context.runId);
  const intermediateCleanupBlocked = activeRunBlocked || Boolean(artifactInspectionError);
  const intermediateCleanupBlockedReason = activeRunBlocked
    ? 'Local AI Hub will not delete intermediate files from the pipeline run that is currently active.'
    : artifactInspectionError;
  const wholeRunSafe = !intermediateCleanupBlocked && await canDeleteWholeRun(context, selectedPaths);

  return {
    artifactSummary,
    artifactsExist,
    canDeleteWholeRun: wholeRunSafe,
    deletionMode: normalizeDeletionMode(options),
    intermediateCleanupBlocked,
    intermediateCleanupBlockedReason,
    outputPath: targetPath,
    outputsRoot: context.outputsRoot,
    runDirectory: context.runDirectory,
    runId: context.runId,
    selectedPaths,
    selectedSummary,
  };
}

async function buildPipelineOutputDeletionPlan(outputPath, options = {}) {
  const preview = await buildPipelineOutputDeletionPreview(outputPath, options);
  const includeIntermediates = options.includeIntermediates === true;
  if (includeIntermediates && preview.intermediateCleanupBlocked) {
    throw new Error(preview.intermediateCleanupBlockedReason || 'Local AI Hub could not safely delete intermediate files from this run.');
  }

  let deletionPaths = [...preview.selectedPaths];
  let deletesWholeRun = false;
  if (includeIntermediates && preview.artifactsExist) {
    if (preview.canDeleteWholeRun) {
      deletionPaths = [preview.runDirectory];
      deletesWholeRun = true;
    } else {
      deletionPaths.push(path.join(preview.runDirectory, 'artifacts'));
    }
  }

  for (const candidatePath of deletionPaths) {
    if (!isPathInside(preview.runDirectory, candidatePath)) {
      throw new Error('Local AI Hub refused to delete a pipeline cleanup path outside its owning run folder.');
    }
    await assertPathHasNoLinks(preview.runDirectory, candidatePath);
  }

  return {
    ...preview,
    deletionPaths: [...new Map(deletionPaths.map((entry) => [normalizePath(entry).toLowerCase(), normalizePath(entry)])).values()],
    deletesWholeRun,
    includeIntermediates,
  };
}

async function removePipelineOutputPath(targetPath, options = {}) {
  if (normalizeDeletionMode(options) === 'permanent') {
    await fs.remove(targetPath);
    return;
  }

  if (typeof options.trashItem !== 'function') {
    throw new Error('The Recycle Bin is not available from this Local AI Hub window. Disable "Move deleted pipeline outputs to Recycle Bin" in Settings if you want to permanently delete this output instead.');
  }

  try {
    await options.trashItem(targetPath);
  } catch {
    throw new Error('Local AI Hub could not move that output or its generated run files to the Recycle Bin. Disable "Move deleted pipeline outputs to Recycle Bin" in Settings if you want to permanently delete them instead.');
  }
}

async function deletePipelineOutput(outputPath, options = {}) {
  const plan = await buildPipelineOutputDeletionPlan(outputPath, options);
  const completedPaths = [];
  for (const deletionPath of plan.deletionPaths) {
    try {
      await removePipelineOutputPath(deletionPath, { ...options, deleteMode: plan.deletionMode });
      completedPaths.push(deletionPath);
    } catch (error) {
      const remainingCount = plan.deletionPaths.length - completedPaths.length;
      const partialMessage = completedPaths.length
        ? `Local AI Hub deleted ${completedPaths.length} cleanup item${completedPaths.length === 1 ? '' : 's'}, but could not finish the remaining ${remainingCount}. ${error.message}`
        : error.message;
      const partialError = new Error(partialMessage);
      partialError.completedPaths = completedPaths;
      partialError.failedPath = deletionPath;
      throw partialError;
    }
  }

  const label = path.basename(plan.outputPath);
  const cleanupLabel = plan.includeIntermediates && plan.artifactsExist
    ? plan.deletesWholeRun
      ? ' The now-empty pipeline run and its generated intermediate files were removed too.'
      : ' Generated intermediate files from the same run were removed too.'
    : '';
  return {
    deletedPath: plan.outputPath,
    deletedPaths: completedPaths,
    deletionMode: plan.deletionMode,
    deletedIntermediates: plan.includeIntermediates && plan.artifactsExist,
    deletedWholeRun: plan.deletesWholeRun,
    message: plan.deletionMode === 'permanent'
      ? `${label} was permanently deleted from Local AI Hub's pipeline outputs.${cleanupLabel}`
      : `${label} was moved to the Recycle Bin from Local AI Hub's pipeline outputs.${cleanupLabel}`,
    runId: plan.runId,
  };
}

module.exports = {
  buildPipelineOutputDeletionPreview,
  deletePipelineOutput,
  listPipelineOutputs,
  _test: {
    assertPathHasNoLinks,
    buildPipelineOutputDeletionPlan,
    buildPipelineOutputDeletionSet,
    canDeleteWholeRun,
    getAdjacentMetadataSidecarPaths,
    inspectDeletionPath,
    isMetadataSidecar,
    normalizeDeletionMode,
    resolvePipelineOutputContext,
    resolvePipelineOutputRoot,
  },
};