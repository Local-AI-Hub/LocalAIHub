const path = require('path');
const fs = require('fs-extra');

const { ensureStorage, getAppPaths, readConfig } = require('./configService');
const { detectStorageSnapshot, findDiskForPath, getLiveResourceUsage } = require('./hardwareService');
const { listDownloadedModels, supportsModelManager } = require('./modelService');
const { calculatePathSize } = require('./storageLocationService');
const { createLogger } = require('./logService');

const STATISTICS_FILE = 'statistics.json';
const STATISTICS_INDEX_FILE = 'statistics-index.json';
const STATISTICS_VERSION = 1;
const STATISTICS_INDEX_SCHEMA_VERSION = 1;
const MAX_VRAM_HISTORY_SAMPLES = 360;
const STORAGE_INDEX_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const STORAGE_SECTION = 'storage';
const MAX_INVALIDATION_REASONS = 12;

const logger = createLogger('statistics');

function createStatisticsAbortError() {
  const error = new Error('Statistics loading was canceled.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfStatisticsCanceled(signal) {
  if (signal?.aborted) {
    throw createStatisticsAbortError();
  }
}

function recoverStatisticsScanError(error, fallbackValue) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    throw createStatisticsAbortError();
  }
  return fallbackValue;
}

let statisticsQueue = Promise.resolve();
let storageIndexRebuildPromise = null;

function createDefaultStatistics() {
  return {
    version: STATISTICS_VERSION,
    toolLaunchCounts: {},
    vramHistory: [],
  };
}

function createEmptyIndexSection() {
  return {
    data: null,
    diagnostics: {},
    indexedAt: null,
    invalidatedAt: null,
    invalidationReasons: [],
    signature: null,
  };
}

function createDefaultStatisticsIndex() {
  return {
    schemaVersion: STATISTICS_INDEX_SCHEMA_VERSION,
    indexedAt: null,
    sections: {
      [STORAGE_SECTION]: createEmptyIndexSection(),
    },
  };
}

async function getStatisticsFilePath() {
  const { root } = await ensureStorage();
  return path.join(root, STATISTICS_FILE);
}

async function getStatisticsIndexFilePath() {
  const { root } = await ensureStorage();
  return path.join(root, STATISTICS_INDEX_FILE);
}

function normalizeStatisticsPayload(payload) {
  return {
    ...createDefaultStatistics(),
    ...(payload || {}),
    toolLaunchCounts: payload?.toolLaunchCounts && typeof payload.toolLaunchCounts === 'object' ? payload.toolLaunchCounts : {},
    vramHistory: Array.isArray(payload?.vramHistory) ? payload.vramHistory.slice(-MAX_VRAM_HISTORY_SAMPLES) : [],
  };
}

function normalizeIndexSection(section) {
  if (!section || typeof section !== 'object') {
    return createEmptyIndexSection();
  }

  return {
    ...createEmptyIndexSection(),
    ...section,
    diagnostics: section.diagnostics && typeof section.diagnostics === 'object' ? section.diagnostics : {},
    invalidationReasons: Array.isArray(section.invalidationReasons) ? section.invalidationReasons.slice(-MAX_INVALIDATION_REASONS) : [],
  };
}

function normalizeStatisticsIndex(payload) {
  if (!payload || typeof payload !== 'object' || Number(payload.schemaVersion) !== STATISTICS_INDEX_SCHEMA_VERSION) {
    return createDefaultStatisticsIndex();
  }

  return {
    ...createDefaultStatisticsIndex(),
    ...payload,
    sections: {
      ...createDefaultStatisticsIndex().sections,
      ...(payload.sections || {}),
      [STORAGE_SECTION]: normalizeIndexSection(payload.sections?.[STORAGE_SECTION]),
    },
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

async function readStatisticsIndex(options = {}) {
  const startedAt = process.hrtime.bigint();
  const filePath = await getStatisticsIndexFilePath();
  if (!(await fs.pathExists(filePath))) {
    logger.info('Statistics index load missed because the file does not exist.', {
      filePath,
      totalMs: elapsedMs(startedAt),
    }).catch(() => null);
    return {
      filePath,
      index: createDefaultStatisticsIndex(),
      status: 'missing',
    };
  }

  try {
    const payload = await fs.readJson(filePath);
    const index = normalizeStatisticsIndex(payload);
    const status = Number(payload?.schemaVersion) === STATISTICS_INDEX_SCHEMA_VERSION ? 'loaded' : 'schema-mismatch';
    logger.info('Statistics index loaded.', {
      filePath,
      status,
      totalMs: elapsedMs(startedAt),
    }).catch(() => null);
    return {
      filePath,
      index,
      status,
    };
  } catch (error) {
    logger.warn('Statistics index is corrupt and will be ignored.', {
      error,
      filePath,
      totalMs: elapsedMs(startedAt),
    }).catch(() => null);
    if (options.recoverCorrupt !== false) {
      return {
        filePath,
        index: createDefaultStatisticsIndex(),
        status: 'corrupt',
      };
    }
    throw error;
  }
}

async function writeStatisticsIndex(index) {
  const startedAt = process.hrtime.bigint();
  const filePath = await getStatisticsIndexFilePath();
  const nextIndex = normalizeStatisticsIndex({
    ...index,
    indexedAt: new Date().toISOString(),
  });
  await fs.writeJson(filePath, nextIndex, { spaces: 2 });
  logger.info('Statistics index saved.', {
    filePath,
    totalMs: elapsedMs(startedAt),
  }).catch(() => null);
  return nextIndex;
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

async function updateStatisticsIndex(mutator) {
  return queueStatisticsOperation(async () => {
    const { index } = await readStatisticsIndex();
    const next = (await mutator(index)) || index;
    return writeStatisticsIndex(next);
  });
}

function normalizeSectionList(sections) {
  const sectionList = Array.isArray(sections) ? sections : [sections || STORAGE_SECTION];
  return [...new Set(sectionList.map((section) => String(section || '').trim()).filter(Boolean))];
}

function compactInvalidationDetails(details = {}) {
  const compacted = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (value === undefined || value === null || typeof value === 'object') {
      continue;
    }
    compacted[key] = String(value).slice(0, 180);
  }
  return compacted;
}

async function invalidateStatisticsIndexSections(sections = [STORAGE_SECTION], reason = 'local-change', details = {}) {
  const sectionList = normalizeSectionList(sections);
  if (!sectionList.length) {
    return readStatisticsIndex();
  }

  const invalidatedAt = new Date().toISOString();
  const reasonEntry = {
    at: invalidatedAt,
    reason: String(reason || 'local-change').slice(0, 120),
    details: compactInvalidationDetails(details),
  };

  const nextIndex = await updateStatisticsIndex((index) => {
    const nextSections = {
      ...(index.sections || {}),
    };

    for (const sectionName of sectionList) {
      const section = normalizeIndexSection(nextSections[sectionName]);
      nextSections[sectionName] = {
        ...section,
        invalidatedAt,
        invalidationReasons: [...(section.invalidationReasons || []), reasonEntry].slice(-MAX_INVALIDATION_REASONS),
      };
    }

    return {
      ...index,
      sections: nextSections,
    };
  });

  logger.info('Statistics index section invalidated.', {
    details: reasonEntry.details,
    reason: reasonEntry.reason,
    sections: sectionList,
  }).catch(() => null);

  return nextIndex;
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

function elapsedMs(startedAt) {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1000000);
}

async function measureStatisticsSection(timings, name, operation) {
  const startedAt = process.hrtime.bigint();
  try {
    return await operation();
  } finally {
    timings[name] = elapsedMs(startedAt);
  }
}

function buildLaunchRanking(statistics, trackedTools = []) {
  return Object.entries(statistics.toolLaunchCounts || {})
    .map(([toolId, entry]) => ({
      toolId,
      toolName: entry?.name || trackedTools.find((tool) => tool.id === toolId)?.name || toolId,
      count: Number(entry?.count || 0),
      lastLaunchedAt: entry?.lastLaunchedAt || null,
    }))
    .sort((left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName));
}

async function getToolInstallSize(tool, options = {}) {
  throwIfStatisticsCanceled(options.signal);
  if (!tool?.installDir) {
    return 0;
  }

  return calculatePathSize(tool.installDir, { signal: options.signal }).catch((error) => recoverStatisticsScanError(error, 0));
}

async function getToolModelSummary(tool, options = {}) {
  throwIfStatisticsCanceled(options.signal);
  if (!supportsModelManager(tool)) {
    return {
      modelBytes: 0,
      modelCount: 0,
    };
  }

  const models = await listDownloadedModels(tool, { signal: options.signal }).catch((error) => recoverStatisticsScanError(error, []));
  throwIfStatisticsCanceled(options.signal);
  return {
    modelBytes: models.reduce((total, model) => total + Number(model.sizeBytes || 0), 0),
    modelCount: models.length,
  };
}

async function getTrackedTools(tools = null) {
  if (Array.isArray(tools)) {
    return tools;
  }

  const config = await readConfig();
  return Object.values(config.tools || {});
}

function buildStorageSignature(trackedTools = [], trackedRoots = []) {
  return {
    roots: trackedRoots.map((rootPath) => path.resolve(String(rootPath || '')).toLowerCase()).sort(),
    tools: trackedTools
      .filter((tool) => tool?.id)
      .map((tool) => ({
        appDir: String(tool.appDir || '').trim().toLowerCase(),
        id: String(tool.id || '').trim(),
        installDir: String(tool.installDir || '').trim().toLowerCase(),
        managedByLocalAIHub: Boolean(tool.managedByLocalAIHub),
        modelManager: supportsModelManager(tool),
        source: String(tool.source || '').trim().toLowerCase(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function signaturesMatch(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function buildSectionFreshness(sectionName, section, source, extra = {}) {
  const updatedAt = section?.indexedAt || extra.updatedAt || null;
  const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : null;
  return {
    ageMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : null,
    invalidatedAt: section?.invalidatedAt || null,
    source,
    stale: Boolean(extra.stale),
    status: extra.status || source,
    updatedAt,
  };
}

function buildFreshnessPayload(entries = {}) {
  return {
    sectionFreshness: entries,
    statisticsIndex: entries,
  };
}

function getStorageIndexMissReason(section, signature, forceRefresh) {
  if (forceRefresh) {
    return 'force-refresh';
  }
  if (!section?.data || !section?.indexedAt) {
    return 'missing-section';
  }
  if (section.invalidatedAt) {
    return 'invalidated';
  }
  if (!signaturesMatch(section.signature, signature)) {
    return 'signature-changed';
  }
  const indexedTime = new Date(section.indexedAt).getTime();
  if (!Number.isFinite(indexedTime)) {
    return 'invalid-timestamp';
  }
  if (Date.now() - indexedTime > STORAGE_INDEX_MAX_AGE_MS) {
    return 'expired';
  }
  return '';
}

function mergeLiveToolStatus(toolBreakdown = [], trackedTools = []) {
  const toolStatusById = new Map(trackedTools.filter((tool) => tool?.id).map((tool) => [tool.id, tool.status || 'stopped']));
  return toolBreakdown.map((entry) => ({
    ...entry,
    status: toolStatusById.get(entry.toolId) || entry.status || 'stopped',
  }));
}

function buildStorageSnapshotFromData(sectionData, section, trackedTools, storageDrive, source, generatedAt = new Date().toISOString()) {
  const localAIHubBytes = Number(sectionData?.totalDiskUsage?.localAIHubBytes || 0);
  return {
    generatedAt,
    modelSummaries: Array.isArray(sectionData?.modelSummaries) ? sectionData.modelSummaries : [],
    storageRoots: Array.isArray(sectionData?.storageRoots) ? sectionData.storageRoots : [],
    toolBreakdown: mergeLiveToolStatus(Array.isArray(sectionData?.toolBreakdown) ? sectionData.toolBreakdown : [], trackedTools),
    totalDiskUsage: {
      freeBytes: storageDrive?.freeBytes || 0,
      installDrive: storageDrive?.mount || sectionData?.totalDiskUsage?.installDrive || '',
      localAIHubBytes,
      totalBytes: storageDrive?.sizeBytes || 0,
    },
    ...buildFreshnessPayload({
      [STORAGE_SECTION]: buildSectionFreshness(STORAGE_SECTION, section, source),
    }),
  };
}

async function scanStorageSectionData(trackedTools, trackedRoots, timings, options = {}) {
  throwIfStatisticsCanceled(options.signal);
  const [toolBreakdown, storageRoots] = await Promise.all([
    measureStatisticsSection(timings, 'toolBreakdownMs', () =>
      Promise.all(
        trackedTools.map(async (tool) => {
          throwIfStatisticsCanceled(options.signal);
          const [installBytes, modelSummary] = await Promise.all([getToolInstallSize(tool, options), getToolModelSummary(tool, options)]);
          throwIfStatisticsCanceled(options.signal);
          return {
            toolId: tool.id,
            toolName: tool.name,
            installBytes,
            modelBytes: modelSummary.modelBytes,
            modelCount: modelSummary.modelCount,
            totalBytes: installBytes + modelSummary.modelBytes,
            status: tool.status || 'stopped',
          };
        }),
      ),
    ),
    measureStatisticsSection(timings, 'storageRootsMs', () =>
      Promise.all(
        trackedRoots.map(async (rootPath) => {
          throwIfStatisticsCanceled(options.signal);
          return {
            path: rootPath,
            sizeBytes: await calculatePathSize(rootPath, { signal: options.signal }).catch((error) => recoverStatisticsScanError(error, 0)),
          };
        }),
      ),
    ),
  ]);

  throwIfStatisticsCanceled(options.signal);
  const sortedToolBreakdown = toolBreakdown.sort((left, right) => right.totalBytes - left.totalBytes || left.toolName.localeCompare(right.toolName));
  return {
    modelSummaries: sortedToolBreakdown.map((entry) => ({
      modelBytes: entry.modelBytes,
      modelCount: entry.modelCount,
      toolId: entry.toolId,
      toolName: entry.toolName,
    })),
    storageRoots,
    toolBreakdown: sortedToolBreakdown,
    totalDiskUsage: {
      localAIHubBytes: storageRoots.reduce((total, entry) => total + Number(entry.sizeBytes || 0), 0),
    },
  };
}

async function rebuildStorageIndexSection(trackedTools, trackedRoots, signature, options = {}) {
  const rebuild = async () => {
    throwIfStatisticsCanceled(options.signal);
    const startedAt = process.hrtime.bigint();
    const timings = {};
    const indexedAt = new Date().toISOString();
    const data = await scanStorageSectionData(trackedTools, trackedRoots, timings, options);
    throwIfStatisticsCanceled(options.signal);
    const section = {
      data,
      diagnostics: {
        rebuildReason: options.reason || 'miss',
        timings,
      },
      indexedAt,
      invalidatedAt: null,
      invalidationReasons: [],
      signature,
    };

    await updateStatisticsIndex((index) => ({
      ...index,
      sections: {
        ...(index.sections || {}),
        [STORAGE_SECTION]: section,
      },
    }));
    throwIfStatisticsCanceled(options.signal);

    logger.info('Statistics storage index rebuilt.', {
      reason: options.reason || 'miss',
      storageRootCount: data.storageRoots.length,
      timings,
      toolCount: trackedTools.length,
      totalMs: elapsedMs(startedAt),
    }).catch(() => null);

    return section;
  };

  if (options.signal) {
    return rebuild();
  }
  if (storageIndexRebuildPromise && !options.forceRefresh) {
    logger.info('Statistics storage index rebuild reused in-flight work.').catch(() => null);
    return storageIndexRebuildPromise;
  }

  storageIndexRebuildPromise = rebuild();
  try {
    return await storageIndexRebuildPromise;
  } finally {
    storageIndexRebuildPromise = null;
  }
}
async function getStatisticsCoreSnapshot(tools = null, options = {}) {
  throwIfStatisticsCanceled(options.signal);
  const totalStartedAt = process.hrtime.bigint();
  const timings = {};
  const [statistics, trackedTools] = await measureStatisticsSection(timings, 'readStatisticsAndToolsMs', () =>
    Promise.all([readStatistics(), getTrackedTools(tools)]),
  );
  const paths = getAppPaths();
  const disks = await measureStatisticsSection(timings, 'detectStorageMs', () => detectStorageSnapshot().catch(() => []));
  const storageDrive = findDiskForPath(disks, paths.managedRoot) || findDiskForPath(disks, paths.appInstallDir);
  throwIfStatisticsCanceled(options.signal);
  const generatedAt = new Date().toISOString();
  const snapshot = {
    generatedAt,
    launchRanking: buildLaunchRanking(statistics, trackedTools),
    totalDiskUsage: {
      freeBytes: storageDrive?.freeBytes || 0,
      installDrive: storageDrive?.mount || '',
      localAIHubBytes: null,
      totalBytes: storageDrive?.sizeBytes || 0,
    },
    vramHistory: (statistics.vramHistory || []).slice(-MAX_VRAM_HISTORY_SAMPLES),
    ...buildFreshnessPayload({
      core: {
        ageMs: 0,
        source: 'live',
        stale: false,
        status: 'live',
        updatedAt: generatedAt,
      },
    }),
  };

  logger.info('Statistics core snapshot loaded.', {
    totalMs: elapsedMs(totalStartedAt),
    timings,
    cacheMode: options.cacheMode || 'miss',
    toolCount: trackedTools.length,
    launchCountEntries: snapshot.launchRanking.length,
    vramHistorySamples: snapshot.vramHistory.length,
  }).catch(() => null);

  return snapshot;
}

async function getStatisticsStorageSnapshot(tools = null, options = {}) {
  throwIfStatisticsCanceled(options.signal);
  const totalStartedAt = process.hrtime.bigint();
  const timings = {};
  const trackedTools = await measureStatisticsSection(timings, 'readToolsMs', () => getTrackedTools(tools));
  const paths = getAppPaths();
  const trackedRoots = getUniqueTrackedRoots([paths.configRoot, paths.localRoot, paths.managedRoot, paths.appInstallDir]);
  const signature = buildStorageSignature(trackedTools, trackedRoots);
  const disks = await measureStatisticsSection(timings, 'detectStorageMs', () => detectStorageSnapshot().catch(() => []));
  const storageDrive = findDiskForPath(disks, paths.managedRoot) || findDiskForPath(disks, paths.appInstallDir);
  const forceRefresh = Boolean(options.forceRefresh || options.refresh || options.rebuildIndex);
  const indexResult = await measureStatisticsSection(timings, 'indexLoadMs', () => readStatisticsIndex());
  const section = normalizeIndexSection(indexResult.index.sections?.[STORAGE_SECTION]);
  const missReason = getStorageIndexMissReason(section, signature, forceRefresh);
  throwIfStatisticsCanceled(options.signal);

  if (!missReason) {
    const snapshot = buildStorageSnapshotFromData(section.data, section, trackedTools, storageDrive, 'index');
    logger.info('Statistics storage snapshot loaded from index.', {
      ageMs: snapshot.sectionFreshness.storage.ageMs,
      indexStatus: indexResult.status,
      timings,
      totalMs: elapsedMs(totalStartedAt),
      toolCount: trackedTools.length,
      storageRootCount: snapshot.storageRoots.length,
    }).catch(() => null);
    return snapshot;
  }

  logger.info('Statistics storage index miss; rebuilding section.', {
    forceRefresh,
    indexStatus: indexResult.status,
    reason: missReason,
    timings,
  }).catch(() => null);

  const rebuiltSection = await measureStatisticsSection(timings, 'indexRebuildMs', () =>
    rebuildStorageIndexSection(trackedTools, trackedRoots, signature, {
      forceRefresh,
      reason: missReason,
      signal: options.signal,
    }),
  );
  throwIfStatisticsCanceled(options.signal);
  const snapshot = buildStorageSnapshotFromData(rebuiltSection.data, rebuiltSection, trackedTools, storageDrive, 'scan');

  logger.info('Statistics storage snapshot loaded.', {
    cacheMode: 'miss',
    indexMissReason: missReason,
    storageRootCount: snapshot.storageRoots.length,
    timings,
    toolCount: trackedTools.length,
    totalMs: elapsedMs(totalStartedAt),
  }).catch(() => null);

  return snapshot;
}

async function getStatisticsSnapshot(tools = null, options = {}) {
  throwIfStatisticsCanceled(options.signal);
  const totalStartedAt = process.hrtime.bigint();
  const [core, storage] = await Promise.all([
    getStatisticsCoreSnapshot(tools, options),
    getStatisticsStorageSnapshot(tools, options),
  ]);
  throwIfStatisticsCanceled(options.signal);
  const snapshot = {
    ...core,
    modelSummaries: storage.modelSummaries,
    storageRoots: storage.storageRoots,
    toolBreakdown: storage.toolBreakdown,
    totalDiskUsage: storage.totalDiskUsage,
    generatedAt: new Date().toISOString(),
    sectionFreshness: {
      ...(core.sectionFreshness || {}),
      ...(storage.sectionFreshness || {}),
    },
    statisticsIndex: {
      ...(core.statisticsIndex || {}),
      ...(storage.statisticsIndex || {}),
    },
  };

  logger.info('Statistics full snapshot loaded.', {
    totalMs: elapsedMs(totalStartedAt),
    toolBreakdownCount: snapshot.toolBreakdown.length,
    storageRootCount: snapshot.storageRoots.length,
    launchCountEntries: snapshot.launchRanking.length,
    vramHistorySamples: snapshot.vramHistory.length,
  }).catch(() => null);

  return snapshot;
}

module.exports = {
  getStatisticsCoreSnapshot,
  getStatisticsSnapshot,
  getStatisticsStorageSnapshot,
  invalidateStatisticsIndexSections,
  readStatistics,
  recordToolLaunch,
  recordVramSample,
  _test: {
    buildStorageSignature,
    getStorageIndexMissReason,
    getStatisticsIndexFilePath,
    readStatisticsIndex,
    STORAGE_INDEX_MAX_AGE_MS,
  },
};
