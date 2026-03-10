const path = require('path');
const fs = require('fs-extra');

const { ensureStorage, getAppPaths, readConfig } = require('./configService');
const { detectStorageSnapshot, findDiskForPath, getLiveResourceUsage } = require('./hardwareService');
const { listDownloadedModels, supportsModelManager } = require('./modelService');
const { calculatePathSize } = require('./storageLocationService');

const STATISTICS_FILE = 'statistics.json';
const STATISTICS_VERSION = 1;
const MAX_VRAM_HISTORY_SAMPLES = 360;

let statisticsQueue = Promise.resolve();

function createDefaultStatistics() {
  return {
    version: STATISTICS_VERSION,
    toolLaunchCounts: {},
    vramHistory: [],
  };
}

async function getStatisticsFilePath() {
  const { root } = await ensureStorage();
  return path.join(root, STATISTICS_FILE);
}

function normalizeStatisticsPayload(payload) {
  return {
    ...createDefaultStatistics(),
    ...(payload || {}),
    toolLaunchCounts: payload?.toolLaunchCounts && typeof payload.toolLaunchCounts === 'object' ? payload.toolLaunchCounts : {},
    vramHistory: Array.isArray(payload?.vramHistory) ? payload.vramHistory.slice(-MAX_VRAM_HISTORY_SAMPLES) : [],
  };
}

async function readStatistics() {
  const filePath = await getStatisticsFilePath();
  if (!(await fs.pathExists(filePath))) {
    return createDefaultStatistics();
  }

  try {
    const payload = await fs.readJson(filePath);
    return normalizeStatisticsPayload(payload);
  } catch {
    return createDefaultStatistics();
  }
}

async function writeStatistics(payload) {
  const filePath = await getStatisticsFilePath();
  const nextPayload = normalizeStatisticsPayload(payload);
  await fs.writeJson(filePath, nextPayload, { spaces: 2 });
  return nextPayload;
}

function queueStatisticsOperation(operation) {
  const nextOperation = statisticsQueue.then(operation, operation);
  statisticsQueue = nextOperation.catch(() => null);
  return nextOperation;
}

async function updateStatistics(mutator) {
  return queueStatisticsOperation(async () => {
    const current = await readStatistics();
    const next = (await mutator(current)) || current;
    return writeStatistics(next);
  });
}

async function recordToolLaunch(tool) {
  if (!tool?.id) {
    return readStatistics();
  }

  return updateStatistics((statistics) => ({
    ...statistics,
    toolLaunchCounts: {
      ...statistics.toolLaunchCounts,
      [tool.id]: {
        count: Number(statistics.toolLaunchCounts?.[tool.id]?.count || 0) + 1,
        name: tool.name,
        lastLaunchedAt: new Date().toISOString(),
      },
    },
  }));
}

async function recordVramSample(runningTools = []) {
  const activeTools = Array.isArray(runningTools) ? runningTools.filter((tool) => tool?.id) : [];
  if (!activeTools.length) {
    return readStatistics();
  }

  const resources = await getLiveResourceUsage(getAppPaths().managedRoot).catch(() => null);
  if (!resources) {
    return readStatistics();
  }

  const sample = {
    timestamp: new Date().toISOString(),
    toolIds: activeTools.map((tool) => tool.id),
    vramTotalMb: Number(resources.vramTotalMb || 0),
    vramUsedMb: Number(resources.vramUsedMb || 0),
  };

  return updateStatistics((statistics) => ({
    ...statistics,
    vramHistory: [...(statistics.vramHistory || []), sample].slice(-MAX_VRAM_HISTORY_SAMPLES),
  }));
}

function toRootKey(targetPath) {
  return path.resolve(String(targetPath || '')).toLowerCase();
}

function isNestedPath(parentPath, candidatePath) {
  const normalizedParent = path.resolve(String(parentPath || ''));
  const normalizedCandidate = path.resolve(String(candidatePath || ''));
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

function getUniqueTrackedRoots(rootCandidates = []) {
  const uniqueRoots = [];
  for (const candidate of rootCandidates.filter(Boolean).map((entry) => path.resolve(String(entry)))) {
    if (uniqueRoots.some((existing) => toRootKey(existing) === toRootKey(candidate))) {
      continue;
    }

    if (uniqueRoots.some((existing) => isNestedPath(existing, candidate))) {
      continue;
    }

    const filteredRoots = uniqueRoots.filter((existing) => !isNestedPath(candidate, existing));
    filteredRoots.push(candidate);
    uniqueRoots.splice(0, uniqueRoots.length, ...filteredRoots);
  }

  return uniqueRoots;
}

async function getToolInstallSize(tool) {
  if (!tool?.installDir) {
    return 0;
  }

  return calculatePathSize(tool.installDir).catch(() => 0);
}

async function getToolModelSize(tool) {
  if (!supportsModelManager(tool)) {
    return 0;
  }

  const models = await listDownloadedModels(tool).catch(() => []);
  return models.reduce((total, model) => total + Number(model.sizeBytes || 0), 0);
}

async function getTrackedTools(tools = null) {
  if (Array.isArray(tools)) {
    return tools;
  }

  const config = await readConfig();
  return Object.values(config.tools || {});
}

async function getStatisticsSnapshot(tools = null) {
  const [statistics, trackedTools] = await Promise.all([readStatistics(), getTrackedTools(tools)]);
  const paths = getAppPaths();
  const disks = await detectStorageSnapshot().catch(() => []);
  const storageDrive = findDiskForPath(disks, paths.managedRoot) || findDiskForPath(disks, paths.appInstallDir);
  const trackedRoots = getUniqueTrackedRoots([paths.configRoot, paths.localRoot, paths.managedRoot, paths.appInstallDir]);

  const [toolBreakdown, storageRoots] = await Promise.all([
    Promise.all(
      trackedTools.map(async (tool) => {
        const [installBytes, modelBytes] = await Promise.all([getToolInstallSize(tool), getToolModelSize(tool)]);
        return {
          toolId: tool.id,
          toolName: tool.name,
          installBytes,
          modelBytes,
          totalBytes: installBytes + modelBytes,
          status: tool.status || 'stopped',
        };
      }),
    ),
    Promise.all(
      trackedRoots.map(async (rootPath) => ({
        path: rootPath,
        sizeBytes: await calculatePathSize(rootPath).catch(() => 0),
      })),
    ),
  ]);

  const launchRanking = Object.entries(statistics.toolLaunchCounts || {})
    .map(([toolId, entry]) => ({
      toolId,
      toolName: entry?.name || trackedTools.find((tool) => tool.id === toolId)?.name || toolId,
      count: Number(entry?.count || 0),
      lastLaunchedAt: entry?.lastLaunchedAt || null,
    }))
    .sort((left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName));

  const totalLocalAIHubBytes = storageRoots.reduce((total, entry) => total + Number(entry.sizeBytes || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    launchRanking,
    storageRoots,
    toolBreakdown: toolBreakdown.sort((left, right) => right.totalBytes - left.totalBytes || left.toolName.localeCompare(right.toolName)),
    totalDiskUsage: {
      freeBytes: storageDrive?.freeBytes || 0,
      installDrive: storageDrive?.mount || '',
      localAIHubBytes: totalLocalAIHubBytes,
      totalBytes: storageDrive?.sizeBytes || 0,
    },
    vramHistory: (statistics.vramHistory || []).slice(-MAX_VRAM_HISTORY_SAMPLES),
  };
}

module.exports = {
  getStatisticsSnapshot,
  readStatistics,
  recordToolLaunch,
  recordVramSample,
};
