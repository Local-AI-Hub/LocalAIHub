const path = require('path');
const fs = require('fs-extra');

const { getAppPaths, upsertTool } = require('./configService');

const GGUF_FILE_PATTERN = /\.gguf$/i;
const MULTIPART_GGUF_PATTERN = /^(.*?)-(\d{5})-of-(\d{5})(\.gguf)$/i;
const MAX_DISCOVERED_MODELS = 200;

function getLmStudioModelsRoot() {
  return path.join(process.env.USERPROFILE || '', '.lmstudio', 'models');
}

function normalizeSelection(selection) {
  if (!selection || typeof selection !== 'object') {
    return null;
  }

  const kind = String(selection.kind || '').trim().toLowerCase();
  const fileType = String(selection.fileType || '').trim().toLowerCase();
  const filePath = String(selection.filePath || '').trim();
  if (kind !== 'model-file' || fileType !== 'gguf' || !filePath) {
    return null;
  }

  const resolvedPath = path.resolve(filePath);
  return {
    kind: 'model-file',
    fileName: String(selection.fileName || path.basename(resolvedPath)).trim() || path.basename(resolvedPath),
    filePath: resolvedPath,
    fileType: 'gguf',
    updatedAt: selection.updatedAt || null,
  };
}

function normalizePathKey(targetPath) {
  return path.resolve(String(targetPath || '')).replace(/[\\/]+/g, '/').toLowerCase();
}

function isInsidePath(parentPath, candidatePath) {
  const normalizedParent = String(parentPath || '').trim();
  const normalizedCandidate = String(candidatePath || '').trim();
  if (!normalizedParent || !normalizedCandidate) {
    return false;
  }

  const parentKey = normalizePathKey(normalizedParent);
  const candidateKey = normalizePathKey(normalizedCandidate);
  return candidateKey === parentKey || candidateKey.startsWith(`${parentKey}/`);
}

function compareCandidateEntries(left, right) {
  if (Boolean(left.selected) !== Boolean(right.selected)) {
    return left.selected ? -1 : 1;
  }

  if (Boolean(left.exists) !== Boolean(right.exists)) {
    return left.exists ? -1 : 1;
  }

  if (Boolean(left.launchReady) !== Boolean(right.launchReady)) {
    return left.launchReady ? -1 : 1;
  }

  if (Boolean(left.inManagedModels) !== Boolean(right.inManagedModels)) {
    return left.inManagedModels ? -1 : 1;
  }

  if (Boolean(left.inLmStudioModels) !== Boolean(right.inLmStudioModels)) {
    return left.inLmStudioModels ? -1 : 1;
  }

  const leftTime = Date.parse(left.modifiedAt || '') || 0;
  const rightTime = Date.parse(right.modifiedAt || '') || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  return String(left.fileName || '').localeCompare(String(right.fileName || ''));
}

function buildLocationLabel(filePath, roots) {
  if (isInsidePath(roots.managedModelsRoot, filePath)) {
    const relativePath = path.relative(roots.managedModelsRoot, filePath);
    return relativePath && relativePath !== path.basename(filePath)
      ? `Local AI Hub managed models\\${relativePath}`
      : 'Local AI Hub managed models';
  }

  if (isInsidePath(roots.lmStudioModelsRoot, filePath)) {
    const relativePath = path.relative(roots.lmStudioModelsRoot, filePath);
    return relativePath && relativePath !== path.basename(filePath)
      ? `LM Studio models\\${relativePath}`
      : 'LM Studio models';
  }

  return path.dirname(filePath);
}

function parseMultipartGgufFileName(fileName) {
  const match = String(fileName || '').match(MULTIPART_GGUF_PATTERN);
  if (!match) {
    return null;
  }

  const partIndex = Number.parseInt(match[2], 10);
  const partCount = Number.parseInt(match[3], 10);
  if (!Number.isFinite(partIndex) || !Number.isFinite(partCount) || partIndex < 1 || partCount < 2 || partIndex > partCount) {
    return null;
  }

  return {
    baseName: match[1],
    extension: match[4],
    partCount,
    partIndex,
    width: match[2].length,
  };
}

function buildMultipartGgufFileName(parsed, partIndex) {
  return `${parsed.baseName}-${String(partIndex).padStart(parsed.width, '0')}-of-${String(parsed.partCount).padStart(parsed.width, '0')}${parsed.extension}`;
}

async function inspectMultipartModel(filePath) {
  const resolvedPath = path.resolve(filePath);
  const fileName = path.basename(resolvedPath);
  const parsed = parseMultipartGgufFileName(fileName);
  if (!parsed) {
    return {
      isMultipart: false,
      missingParts: [],
      partCount: 1,
      partIndex: 1,
      ready: true,
    };
  }

  const directoryPath = path.dirname(resolvedPath);
  const missingParts = [];
  for (let currentPart = 1; currentPart <= parsed.partCount; currentPart += 1) {
    const siblingPath = path.join(directoryPath, buildMultipartGgufFileName(parsed, currentPart));
    if (!(await fs.pathExists(siblingPath))) {
      missingParts.push({
        fileName: path.basename(siblingPath),
        filePath: siblingPath,
        partIndex: currentPart,
      });
    }
  }

  return {
    isMultipart: true,
    missingParts,
    partCount: parsed.partCount,
    partIndex: parsed.partIndex,
    ready: missingParts.length === 0,
  };
}

function formatMissingMultipartList(missingParts = [], maxItems = 2) {
  const normalizedParts = Array.isArray(missingParts) ? missingParts.filter(Boolean) : [];
  if (normalizedParts.length === 0) {
    return '';
  }

  const listedNames = normalizedParts.slice(0, maxItems).map((part) => part.fileName).filter(Boolean);
  if (listedNames.length === 0) {
    return '';
  }

  if (normalizedParts.length <= maxItems) {
    return listedNames.join(', ');
  }

  return `${listedNames.join(', ')}, and ${normalizedParts.length - maxItems} more`;
}

function buildIncompleteSplitCopy(fileName, inspection, options = {}) {
  const missingLabel = formatMissingMultipartList(inspection?.missingParts || []);
  const missingCount = Number(inspection?.missingParts?.length || 0);
  const partDescription = inspection?.isMultipart
    ? `part ${inspection.partIndex} of ${inspection.partCount}`
    : 'part of a split model';
  const detail = missingLabel
    ? `${fileName} is ${partDescription} of a split GGUF, but Local AI Hub could not find ${missingLabel} in the same folder.`
    : `${fileName} is ${partDescription} of a split GGUF, but one or more sibling files are missing from the same folder.`;

  if (options.forSave) {
    return `That GGUF file is incomplete. ${detail} Choose a complete GGUF or re-download the full split model before saving KoboldCpp setup.`;
  }

  return {
    detail: `${detail} Choose a complete GGUF or re-download the full split model before launching KoboldCpp.`,
    statusDetail: missingCount > 0
      ? `Missing ${missingCount} split GGUF file${missingCount === 1 ? '' : 's'}: ${missingLabel}.`
      : 'One or more split GGUF files are missing.',
    summary: `Saved model incomplete: ${fileName}. Missing ${missingCount} split GGUF file${missingCount === 1 ? '' : 's'}.`,
  };
}

async function createCandidateEntry(filePath, roots, selectedPath) {
  const resolvedPath = path.resolve(filePath);
  const fileName = path.basename(resolvedPath);
  const exists = await fs.pathExists(resolvedPath);
  let sizeBytes = 0;
  let modifiedAt = null;

  if (exists) {
    const stats = await fs.stat(resolvedPath);
    if (stats.isFile()) {
      sizeBytes = Number(stats.size || 0);
      modifiedAt = stats.mtime instanceof Date ? stats.mtime.toISOString() : null;
    }
  }

  const multipartInspection = exists
    ? await inspectMultipartModel(resolvedPath)
    : {
        isMultipart: false,
        missingParts: [],
        partCount: 1,
        partIndex: 1,
        ready: false,
      };
  const incompleteCopy = exists && !multipartInspection.ready
    ? buildIncompleteSplitCopy(fileName, multipartInspection)
    : null;

  return {
    id: normalizePathKey(resolvedPath),
    exists,
    fileName,
    filePath: resolvedPath,
    inLmStudioModels: isInsidePath(roots.lmStudioModelsRoot, resolvedPath),
    inManagedModels: isInsidePath(roots.managedModelsRoot, resolvedPath),
    incompleteSplit: Boolean(exists && !multipartInspection.ready),
    launchReady: Boolean(exists && multipartInspection.ready),
    locationLabel: buildLocationLabel(resolvedPath, roots),
    missingPartCount: multipartInspection.missingParts.length,
    missingPartPaths: multipartInspection.missingParts.map((part) => part.filePath),
    modifiedAt,
    multipart: Boolean(multipartInspection.isMultipart),
    multipartPartCount: multipartInspection.partCount,
    multipartPartIndex: multipartInspection.partIndex,
    selected: Boolean(selectedPath) && normalizePathKey(selectedPath) === normalizePathKey(resolvedPath),
    sizeBytes,
    statusDetail: incompleteCopy?.statusDetail || '',
  };
}

async function walkForGgufFiles(rootPath, entries, seenKeys, roots, selectedPath) {
  const pending = [rootPath];

  while (pending.length && entries.length < MAX_DISCOVERED_MODELS) {
    const currentPath = pending.shift();
    let directoryEntries = [];

    try {
      directoryEntries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directoryEntries) {
      if (entries.length >= MAX_DISCOVERED_MODELS) {
        break;
      }

      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      if (!entry.isFile() || !GGUF_FILE_PATTERN.test(entry.name)) {
        continue;
      }

      const entryKey = normalizePathKey(entryPath);
      if (seenKeys.has(entryKey)) {
        continue;
      }

      seenKeys.add(entryKey);
      entries.push(await createCandidateEntry(entryPath, roots, selectedPath));
    }
  }
}

function getDiscoveryRoots(selection = null) {
  const managedModelsRoot = getAppPaths().modelsRoot;
  const lmStudioModelsRoot = getLmStudioModelsRoot();
  const selectionPath = selection?.filePath ? path.resolve(selection.filePath) : '';
  const selectionDirectory = selectionPath ? path.dirname(selectionPath) : '';

  return {
    managedModelsRoot,
    lmStudioModelsRoot,
    scanRoots: [...new Set([managedModelsRoot, lmStudioModelsRoot, selectionDirectory].filter(Boolean))],
  };
}

async function listKoboldCppModelCandidates(tool) {
  const selection = normalizeSelection(tool?.launchSelection);
  const roots = getDiscoveryRoots(selection);
  const entries = [];
  const seenKeys = new Set();

  if (selection?.filePath && await fs.pathExists(selection.filePath)) {
    const selectionKey = normalizePathKey(selection.filePath);
    seenKeys.add(selectionKey);
    entries.push(await createCandidateEntry(selection.filePath, roots, selection.filePath));
  }

  for (const scanRoot of roots.scanRoots) {
    if (entries.length >= MAX_DISCOVERED_MODELS) {
      break;
    }

    if (!(await fs.pathExists(scanRoot))) {
      continue;
    }

    let stats = null;
    try {
      stats = await fs.stat(scanRoot);
    } catch {
      stats = null;
    }

    if (!stats) {
      continue;
    }

    if (stats.isDirectory()) {
      await walkForGgufFiles(scanRoot, entries, seenKeys, roots, selection?.filePath || '');
      continue;
    }

    if (stats.isFile() && GGUF_FILE_PATTERN.test(path.basename(scanRoot))) {
      const entryKey = normalizePathKey(scanRoot);
      if (!seenKeys.has(entryKey)) {
        seenKeys.add(entryKey);
        entries.push(await createCandidateEntry(scanRoot, roots, selection?.filePath || ''));
      }
    }
  }

  return entries.sort(compareCandidateEntries);
}

async function buildKoboldCppLaunchSelectionStatus(tool) {
  const selection = normalizeSelection(tool?.launchSelection);
  const selectionExists = selection?.filePath ? await fs.pathExists(selection.filePath) : false;

  if (!selection) {
    return {
      actionLabel: 'Choose model',
      configured: false,
      detail: 'Choose one GGUF file in Local AI Hub, then launches will go straight into KoboldCpp.',
      fileName: '',
      filePath: '',
      incomplete: false,
      kind: 'model-file',
      missing: false,
      ready: false,
      required: true,
      summary: 'No GGUF model selected yet. Launch will open Local AI Hub setup first.',
      tone: 'neutral',
      type: 'koboldcpp-model',
    };
  }

  if (!selectionExists) {
    return {
      actionLabel: 'Change model',
      configured: true,
      detail: 'The saved GGUF file is no longer available at the stored path. Pick another model before launching KoboldCpp.',
      fileName: selection.fileName,
      filePath: selection.filePath,
      incomplete: false,
      kind: selection.kind,
      missing: true,
      ready: false,
      required: true,
      summary: `Saved model missing: ${selection.fileName}. Choose a new GGUF file before launch.`,
      tone: 'warn',
      type: 'koboldcpp-model',
    };
  }

  const multipartInspection = await inspectMultipartModel(selection.filePath);
  if (!multipartInspection.ready) {
    const incompleteCopy = buildIncompleteSplitCopy(selection.fileName, multipartInspection);
    return {
      actionLabel: 'Change model',
      configured: true,
      detail: incompleteCopy.detail,
      fileName: selection.fileName,
      filePath: selection.filePath,
      incomplete: true,
      kind: selection.kind,
      missing: false,
      missingPartCount: multipartInspection.missingParts.length,
      missingPartPaths: multipartInspection.missingParts.map((part) => part.filePath),
      ready: false,
      required: true,
      summary: incompleteCopy.summary,
      tone: 'warn',
      type: 'koboldcpp-model',
    };
  }

  return {
    actionLabel: 'Change model',
    configured: true,
    detail: 'Local AI Hub will launch KoboldCpp with this GGUF file, then hand off to KoboldCpp\'s own UI.',
    fileName: selection.fileName,
    filePath: selection.filePath,
    incomplete: false,
    kind: selection.kind,
    missing: false,
    ready: true,
    required: true,
    summary: `Launch will use ${selection.fileName}.`,
    tone: 'good',
    type: 'koboldcpp-model',
  };
}

async function hydrateKoboldCppToolState(tool) {
  if (tool?.id !== 'koboldcpp') {
    return tool;
  }

  const launchSelection = normalizeSelection(tool.launchSelection);
  return {
    ...tool,
    launchSelection,
    launchSelectionStatus: await buildKoboldCppLaunchSelectionStatus({
      ...tool,
      launchSelection,
    }),
  };
}

function replaceArgumentValue(args = [], flag, value) {
  const nextArgs = [];

  for (let index = 0; index < (args || []).length; index += 1) {
    const currentValue = args[index];
    if (currentValue === flag) {
      index += 1;
      continue;
    }

    if (String(currentValue || '').startsWith(`${flag}=`)) {
      continue;
    }

    nextArgs.push(currentValue);
  }

  nextArgs.push(flag, value);
  return nextArgs;
}

async function buildKoboldCppLaunchConfiguration(tool) {
  const hydratedTool = await hydrateKoboldCppToolState(tool);
  const status = hydratedTool.launchSelectionStatus;
  if (!status?.configured) {
    throw new Error('Choose a GGUF model in Local AI Hub before launching KoboldCpp.');
  }

  if (!status.ready) {
    if (status.incomplete) {
      throw new Error(status.detail || 'The saved KoboldCpp model is incomplete. Choose a complete GGUF before launching again.');
    }

    throw new Error('The saved KoboldCpp model could not be found. Change the GGUF model in Local AI Hub before launching again.');
  }

  const baseProfile = hydratedTool.launchProfile;
  if (!baseProfile) {
    throw new Error('KoboldCpp does not have a launch profile yet. Reinstall or repair it, then try again.');
  }

  return {
    launchMessage: `KoboldCpp is starting with ${status.fileName}.`,
    launchProfileOverride: {
      ...baseProfile,
      args: replaceArgumentValue(baseProfile.args || [], '--model', status.filePath),
    },
  };
}

async function getKoboldCppSetup(tool) {
  const hydratedTool = await hydrateKoboldCppToolState(tool);
  return {
    candidates: await listKoboldCppModelCandidates(hydratedTool),
    launchSelection: hydratedTool.launchSelection,
    launchSelectionStatus: hydratedTool.launchSelectionStatus,
  };
}

async function saveKoboldCppLaunchSelection(tool, payload = {}) {
  const requestedModelPath = String(payload.modelPath || '').trim();
  if (!requestedModelPath) {
    throw new Error('Choose a GGUF model file before saving KoboldCpp setup.');
  }

  if (!GGUF_FILE_PATTERN.test(requestedModelPath)) {
    throw new Error('Choose a GGUF model file for KoboldCpp.');
  }

  const resolvedModelPath = path.resolve(requestedModelPath);
  const exists = await fs.pathExists(resolvedModelPath);
  if (!exists) {
    throw new Error('That GGUF file could not be found on this PC. Choose another model file and try again.');
  }

  const stats = await fs.stat(resolvedModelPath);
  if (!stats.isFile()) {
    throw new Error('Choose a GGUF model file, not a folder.');
  }

  const multipartInspection = await inspectMultipartModel(resolvedModelPath);
  if (!multipartInspection.ready) {
    throw new Error(buildIncompleteSplitCopy(path.basename(resolvedModelPath), multipartInspection, { forSave: true }));
  }

  const launchSelection = {
    kind: 'model-file',
    fileName: path.basename(resolvedModelPath),
    filePath: resolvedModelPath,
    fileType: 'gguf',
    updatedAt: new Date().toISOString(),
  };

  await upsertTool({
    id: tool.id,
    launchSelection,
  });

  const nextTool = {
    ...tool,
    launchSelection,
  };

  return {
    launchSelection,
    message: `KoboldCpp will launch with ${launchSelection.fileName}.`,
    setup: await getKoboldCppSetup(nextTool),
  };
}

module.exports = {
  buildKoboldCppLaunchConfiguration,
  getKoboldCppSetup,
  hydrateKoboldCppToolState,
  listKoboldCppModelCandidates,
  saveKoboldCppLaunchSelection,
};

