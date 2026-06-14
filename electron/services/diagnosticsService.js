const path = require('path');
const fs = require('fs-extra');
const si = require('systeminformation');
const archiver = require('archiver');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { ensureStorage, getAppPaths, readConfig } = require('./configService');
const { detectHardwareSnapshot, detectStorageSnapshot, findDiskForPath, getLiveResourceUsage } = require('./hardwareService');
const { resolveFfmpegPath } = require('./mediaCompositionService');
const { readModelSettings, supportsModelManager } = require('./modelService');
const { listPipelineOutputs } = require('./pipelineOutputStoreService');
const { listProviderConnections } = require('./providerService');
const { listRecentRecordings } = require('./recordingService');
const { redactDiagnosticValue, redactSensitiveText } = require('./redactionService');
const { buildMergedToolStateList } = require('./toolStateService');

const execFileAsync = promisify(execFile);
const DIAGNOSTICS_SCHEMA_VERSION = 1;
const MAX_LOG_FILES = 6;
const MAX_LOG_FILE_BYTES = 256 * 1024;
const MAX_LOG_TOTAL_BYTES = 1024 * 1024;
const PRIVATE_CONTENT_KEY_PATTERN = /^(?:prompt|negativePrompt|positivePrompt|messages|content|text|sourcePath|inputPath|outputPath|fileName|destinationPath|artifactPath)$/i;
const MEDIA_OR_MODEL_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|mp[34]|mkv|mov|avi|webm|wav|mp3|flac|ogg|safetensors|ckpt|pt|pth|gguf|onnx|bin)$/i;
const MEDIA_OR_MODEL_FILENAME_PATTERN = /\b[^\s\\/:*?"<>|]{1,120}\.(?:png|jpe?g|gif|webp|bmp|tiff?|mp[34]|mkv|mov|avi|webm|wav|mp3|flac|ogg|safetensors|ckpt|pt|pth|gguf|onnx|bin)\b/gi;

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : Math.round(size * 10) / 10} ${units[index]}`;
}

function formatMb(value) {
  const mb = Number(value || 0);
  return mb > 0 ? `${Math.round(mb).toLocaleString('en-US')} MB` : 'Unavailable';
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function buildRedactionOptions(paths = {}) {
  return {
    homePath: process.env.USERPROFILE || process.env.HOME || '',
    managedRoot: paths.managedRoot || '',
    additionalPaths: [
      { path: paths.configRoot, placeholder: '<app-data>' },
      { path: paths.localRoot, placeholder: '<local-app-data>' },
      { path: paths.appInstallDir, placeholder: '<app-install>' },
      { path: paths.logsRoot, placeholder: '<logs>' },
      { path: paths.runtimesRoot, placeholder: '<runtimes>' },
      { path: paths.recordingsRoot, placeholder: '<recordings>' },
      { path: paths.modelsRoot, placeholder: '<models>' },
      { path: paths.toolsRoot, placeholder: '<tools>' },
    ],
  };
}

function sanitizeText(value, paths, maxLength = 1200) {
  const redacted = String(redactSensitiveText(String(value || ''), {
    ...buildRedactionOptions(paths),
    redactPaths: true,
  }) || '');
  return redacted.replace(MEDIA_OR_MODEL_FILENAME_PATTERN, '<private-file>').slice(0, maxLength);
}

function sanitizeWorkflowValue(value, paths, seen = new WeakSet()) {
  if (typeof value === 'string') return sanitizeText(value, paths, 2000);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeWorkflowValue(entry, paths, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = PRIVATE_CONTENT_KEY_PATTERN.test(key)
      ? '[omitted from diagnostics]'
      : sanitizeWorkflowValue(entry, paths, seen);
  }
  return redactDiagnosticValue(output, buildRedactionOptions(paths));
}

async function inspectDirectory(targetPath) {
  const exists = await fs.pathExists(targetPath).catch(() => false);
  let readable = false;
  let writable = false;
  if (exists) {
    readable = await fs.access(targetPath, fs.constants.R_OK).then(() => true).catch(() => false);
    writable = await fs.access(targetPath, fs.constants.W_OK).then(() => true).catch(() => false);
  }
  return { exists, readable, writable };
}

function summarizeTool(tool, paths) {
  const hasInstall = Boolean(tool?.installDir || tool?.appDir || tool?.detectedPath || tool?.executablePath);
  const status = String(tool?.status || 'stopped').trim().toLowerCase() || 'stopped';
  const needsAttention = !hasInstall || status === 'error' || Boolean(tool?.lastError);
  return {
    id: String(tool?.id || '').trim(),
    name: String(tool?.name || tool?.id || 'Unknown tool').trim(),
    installed: hasInstall,
    launchMode: String(tool?.selectedLaunchMode || tool?.launchMode || tool?.interfaceMode || '').trim() || 'default',
    lifecycleMode: String(tool?.lifecycleMode || '').trim() || 'unknown',
    status,
    ready: hasInstall && !needsAttention,
    needsSetupOrRepair: needsAttention,
    repairAvailable: Boolean(tool?.actionSemantics?.repairAvailable),
    installPath: hasInstall ? sanitizeText(tool.installDir || tool.appDir || tool.detectedPath || tool.executablePath, paths, 300) : '',
    lastError: sanitizeText(tool?.lastError || '', paths, 500),
  };
}

function summarizeProvider(provider, paths) {
  return {
    id: String(provider?.id || '').trim(),
    name: String(provider?.name || provider?.id || 'Unknown provider').trim(),
    configured: Boolean(provider?.isConnected),
    readinessStatus: String(provider?.libraryStatus || (provider?.isConnected ? 'connected' : 'disconnected')).trim(),
    statusMessage: sanitizeText(provider?.statusMessage || provider?.credentialStatusMessage || '', paths, 500),
  };
}

function summarizeRecorderEntry(recording, paths) {
  return {
    id: String(recording?.id || '').trim(),
    backend: String(recording?.backend || 'ffmpeg').trim(),
    mode: String(recording?.mode || '').trim(),
    status: String(recording?.status || '').trim(),
    startedAt: recording?.startedAt || null,
    stoppedAt: recording?.stoppedAt || null,
    durationSeconds: Number(recording?.durationSeconds || 0) || 0,
    container: String(recording?.container || recording?.format || '').trim(),
    sizeBytes: Number(recording?.sizeBytes || 0) || 0,
    errorSummary: sanitizeText(recording?.errorSummary || '', paths, 500),
  };
}

function summarizeActiveRun(run, paths) {
  if (!run?.runId) return null;
  const nodeStates = Object.values(run.nodeStates || {});
  return {
    runId: String(run.runId),
    pipelineId: String(run.pipelineId || ''),
    status: String(run.status || ''),
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    nodeTypes: [...new Set(nodeStates.map((node) => String(node?.type || '').trim()).filter(Boolean))],
    nodeStatuses: nodeStates.reduce((counts, node) => {
      const status = String(node?.status || 'unknown').trim() || 'unknown';
      counts[status] = Number(counts[status] || 0) + 1;
      return counts;
    }, {}),
    errorSummary: ['failed', 'cancelled'].includes(String(run.status || '').toLowerCase())
      ? sanitizeText(run.message || '', paths, 800)
      : '',
  };
}

function summarizeOutputRuns(outputs = []) {
  const byRun = new Map();
  for (const output of outputs.slice(0, 100)) {
    const runId = String(output?.runId || '').trim();
    if (!runId) continue;
    const current = byRun.get(runId) || { runId, status: 'completed', artifactTypes: [], savedAt: null, outputCount: 0 };
    const kind = String(output?.outputKind || output?.kind || '').trim();
    if (kind && !current.artifactTypes.includes(kind)) current.artifactTypes.push(kind);
    current.outputCount += 1;
    if (!current.savedAt || String(output?.savedAt || '') > current.savedAt) current.savedAt = output?.savedAt || null;
    byRun.set(runId, current);
  }
  return [...byRun.values()].sort((left, right) => String(right.savedAt || '').localeCompare(String(left.savedAt || ''))).slice(0, 20);
}

async function getFfmpegSummary(paths) {
  try {
    const executable = resolveFfmpegPath();
    const result = await execFileAsync(executable, ['-version'], { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024 });
    const version = String(result.stdout || result.stderr || '').split(/\r?\n/)[0].trim().slice(0, 240);
    return { available: true, version: sanitizeText(version, paths, 240) };
  } catch (error) {
    return { available: false, version: '', error: sanitizeText(error?.message || 'FFmpeg was not found.', paths, 300) };
  }
}

function withCollectionTimeout(operation, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

async function collectSupportData(context = {}, dependencies = {}) {
  const deps = {
    ensureStorage: dependencies.ensureStorage || ensureStorage,
    readConfig: dependencies.readConfig || readConfig,
    detectHardwareSnapshot: dependencies.detectHardwareSnapshot || detectHardwareSnapshot,
    detectStorageSnapshot: dependencies.detectStorageSnapshot || detectStorageSnapshot,
    getLiveResourceUsage: dependencies.getLiveResourceUsage || getLiveResourceUsage,
    osInfo: dependencies.osInfo || (() => si.osInfo()),
    cpu: dependencies.cpu || (() => si.cpu()),
    mem: dependencies.mem || (() => si.mem()),
    listTools: dependencies.listTools || (() => buildMergedToolStateList({ includeSnapshots: false, resolveStatuses: false })),
    listProviders: dependencies.listProviders || listProviderConnections,
    listRecordings: dependencies.listRecordings || (() => listRecentRecordings({ limit: 20 })),
    listPipelineOutputs: dependencies.listPipelineOutputs || listPipelineOutputs,
    readModelSettings: dependencies.readModelSettings || readModelSettings,
    getFfmpegSummary: dependencies.getFfmpegSummary || getFfmpegSummary,
  };

  const paths = await deps.ensureStorage();
  const settled = await Promise.allSettled([
    withCollectionTimeout(() => deps.readConfig(), 'App configuration'),
    withCollectionTimeout(() => deps.osInfo(), 'OS information'),
    withCollectionTimeout(() => deps.cpu(), 'CPU information'),
    withCollectionTimeout(() => deps.mem(), 'Memory information'),
    withCollectionTimeout(() => deps.detectHardwareSnapshot(), 'Hardware information'),
    withCollectionTimeout(() => deps.getLiveResourceUsage(paths.managedRoot, { includeDisk: true }), 'Live hardware usage'),
    withCollectionTimeout(() => deps.detectStorageSnapshot(), 'Storage information'),
    withCollectionTimeout(() => deps.listTools(), 'Tool summary'),
    withCollectionTimeout(() => deps.listProviders(), 'Provider summary'),
    withCollectionTimeout(() => deps.listRecordings(), 'Recorder summary'),
    withCollectionTimeout(() => deps.listPipelineOutputs(), 'Pipeline summary'),
    withCollectionTimeout(() => deps.readModelSettings(), 'Model settings'),
    withCollectionTimeout(() => deps.getFfmpegSummary(paths), 'FFmpeg information'),
    withCollectionTimeout(() => inspectDirectory(paths.managedRoot), 'Managed root status'),
  ]);
  const value = (index, fallback) => settled[index]?.status === 'fulfilled' ? settled[index].value : fallback;
  const config = value(0, {});
  const osInfo = value(1, {});
  const cpu = value(2, {});
  const memory = value(3, {});
  const hardware = value(4, config.hardware || {});
  const resources = value(5, {});
  const disks = value(6, hardware.disks || []);
  const tools = value(7, []).map((tool) => summarizeTool(tool, paths));
  const providers = value(8, []).map((provider) => summarizeProvider(provider, paths));
  const recordings = value(9, []).map((recording) => summarizeRecorderEntry(recording, paths));
  const outputs = value(10, []);
  const modelSettings = value(11, {});
  const ffmpeg = value(12, { available: false, version: '' });
  const managedRootStatus = value(13, { exists: false, readable: false, writable: false });
  const cDrive = disks.find((disk) => String(disk?.mount || '').toLowerCase().startsWith('c:')) || null;
  const managedDrive = findDiskForPath(disks, paths.managedRoot) || null;
  const activeRun = summarizeActiveRun(context.activePipelineRun, paths);
  const modelTools = tools.filter((tool) => {
    const original = value(7, []).find((entry) => entry.id === tool.id);
    return original && supportsModelManager(original);
  });
  const warnings = settled
    .map((entry, index) => entry.status === 'rejected' ? `Support data source ${index + 1} was unavailable: ${sanitizeText(entry.reason?.message || entry.reason, paths, 300)}` : '')
    .filter(Boolean);

  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    app: {
      version: String(context.appVersion || 'unknown'),
      updateChannel: String(context.updateChannel || (String(context.appVersion || '').includes('-') ? 'development' : 'stable')),
      electron: String(context.versions?.electron || process.versions.electron || 'unknown'),
      node: String(context.versions?.node || process.versions.node || 'unknown'),
      chrome: String(context.versions?.chrome || process.versions.chrome || 'unknown'),
    },
    os: {
      platform: String(osInfo.platform || process.platform),
      distro: String(osInfo.distro || osInfo.codename || 'Windows'),
      release: String(osInfo.release || ''),
      build: String(osInfo.build || ''),
      arch: String(osInfo.arch || process.arch),
    },
    hardware: {
      cpu: [cpu.manufacturer, cpu.brand].filter(Boolean).join(' ').trim() || 'Unknown CPU',
      cpuCores: Number(cpu.cores || cpu.physicalCores || 0) || null,
      ramTotalBytes: Number(memory.total || 0) || Number(hardware.systemRamMb || 0) * 1024 * 1024,
      gpu: String(hardware.gpuModel || resources.gpuName || 'Unknown GPU'),
      gpuVendor: String(hardware.gpuVendor || ''),
      vramTotalMb: Number(resources.vramTotalMb || hardware.vramMb || 0) || null,
      vramUsedMb: resources.vramUsedMb !== null && resources.vramUsedMb !== undefined && Number.isFinite(Number(resources.vramUsedMb)) ? Number(resources.vramUsedMb) : null,
      vramAvailableMb: Number(resources.vramTotalMb || hardware.vramMb || 0) > 0 && resources.vramUsedMb !== null && resources.vramUsedMb !== undefined && Number.isFinite(Number(resources.vramUsedMb))
        ? Math.max(0, Number(resources.vramTotalMb || hardware.vramMb) - Number(resources.vramUsedMb))
        : null,
    },
    storage: {
      cDriveFreeBytes: Number(cDrive?.freeBytes || 0) || null,
      managedDrive: String(managedDrive?.mount || resources.diskMount || ''),
      managedDriveFreeBytes: Number(managedDrive?.freeBytes || resources.diskFreeBytes || 0) || null,
      managedRoot: '<managed-root>',
      managedRootStatus,
    },
    ffmpeg,
    recorder: {
      available: Boolean(ffmpeg.available),
      backends: ffmpeg.available ? ['FFmpeg', ...(process.platform === 'win32' ? ['Electron system audio'] : [])] : [],
      recentCount: recordings.length,
    },
    tools: {
      installedCount: tools.filter((tool) => tool.installed).length,
      readyCount: tools.filter((tool) => tool.ready).length,
      needsSetupOrRepairCount: tools.filter((tool) => tool.needsSetupOrRepair).length,
      items: tools,
    },
    providers: {
      configuredCount: providers.filter((provider) => provider.configured).length,
      totalCount: providers.length,
      items: providers,
    },
    models: {
      managerToolCount: modelTools.length,
      availableToolFolders: modelTools.filter((tool) => tool.installed).length,
      civitaiConfigured: Boolean(modelSettings.hasCivitaiApiKey),
    },
    recordings,
    pipelineRuns: {
      active: activeRun,
      recent: summarizeOutputRuns(outputs),
      lastErrorSummary: activeRun?.errorSummary || '',
    },
    configSummary: {
      closeBehavior: String(config.closeBehavior || 'exit'),
      firstLaunchCompleted: Boolean(config.firstLaunchCompleted),
      liveResourcePolling: Boolean(config.liveResourcePolling),
      moveDeletedPipelineOutputsToRecycleBin: config.moveDeletedPipelineOutputsToRecycleBin !== false,
      customManagedRoot: Boolean(config.managedDataRoot),
      customPreferredInstallRoot: Boolean(config.preferredInstallRoot),
    },
    warnings,
    paths,
  };
}

function buildSystemInfoText(data) {
  const lines = [
    'Local AI Hub support summary',
    `Created: ${data.createdAt}`,
    '',
    `App version: ${data.app.version}`,
    `Update channel: ${data.app.updateChannel}`,
    `OS: ${[data.os.distro, data.os.release, data.os.build ? `build ${data.os.build}` : '', data.os.arch].filter(Boolean).join(' ')}`,
    `Electron / Node / Chrome: ${data.app.electron} / ${data.app.node} / ${data.app.chrome}`,
    `CPU: ${data.hardware.cpu}${data.hardware.cpuCores ? ` (${data.hardware.cpuCores} cores)` : ''}`,
    `RAM total: ${formatBytes(data.hardware.ramTotalBytes)}`,
    `GPU: ${data.hardware.gpu}${data.hardware.gpuVendor ? ` (${data.hardware.gpuVendor})` : ''}`,
    `VRAM total / available: ${formatMb(data.hardware.vramTotalMb)} / ${formatMb(data.hardware.vramAvailableMb)}`,
    `C: free space: ${formatBytes(data.storage.cDriveFreeBytes)}`,
    `Managed root drive free space: ${formatBytes(data.storage.managedDriveFreeBytes)}${data.storage.managedDrive ? ` on ${data.storage.managedDrive}` : ''}`,
    `Managed root: ${data.storage.managedRoot}`,
    `Managed root status: exists=${data.storage.managedRootStatus.exists ? 'yes' : 'no'}, readable=${data.storage.managedRootStatus.readable ? 'yes' : 'no'}, writable=${data.storage.managedRootStatus.writable ? 'yes' : 'no'}`,
    `FFmpeg: ${data.ffmpeg.available ? data.ffmpeg.version || 'available' : 'not available'}`,
    `Recorder: ${data.recorder.available ? `available (${data.recorder.backends.join(', ')})` : 'not available'}`,
    `Tools: ${data.tools.installedCount} installed, ${data.tools.readyCount} ready, ${data.tools.needsSetupOrRepairCount} need setup or repair`,
    `Providers: ${data.providers.configuredCount} configured, ${data.providers.totalCount - data.providers.configuredCount} not configured`,
    `Model folders: ${data.models.availableToolFolders} available for ${data.models.managerToolCount} model-managed tools`,
    `Last pipeline error: ${data.pipelineRuns.lastErrorSummary || 'None available'}`,
  ];
  if (data.warnings.length) lines.push('', `Collection notes: ${data.warnings.length} optional data source(s) were unavailable.`);
  return `${lines.join('\n')}\n`;
}

function getDiagnosticsRoot(paths = getAppPaths()) {
  return path.join(paths.configRoot, 'diagnostics');
}

async function writeJson(filePath, payload, paths) {
  await fs.writeJson(filePath, sanitizeWorkflowValue(payload, paths), { spaces: 2 });
}

function sanitizeLogLine(line, paths) {
  const text = String(line || '');
  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      return `${sanitizeText(text.slice(0, jsonStart), paths, 2000)}${JSON.stringify(sanitizeWorkflowValue(parsed, paths))}`;
    } catch {
      // Fall through to conservative text redaction.
    }
  }
  return sanitizeText(text
    .replace(/(["']?(?:prompt|negativePrompt|positivePrompt|messages|content|text)["']?\s*[:=]\s*)[^,}\r\n]+/gi, '$1[omitted from diagnostics]'), paths, 4000);
}

async function copySanitizedLogs(logsRoot, targetRoot, paths) {
  const report = { included: [], skipped: [], totalBytes: 0, capBytes: MAX_LOG_TOTAL_BYTES };
  await fs.ensureDir(targetRoot);
  if (!(await fs.pathExists(logsRoot))) {
    await fs.writeFile(path.join(targetRoot, 'README.txt'), 'No Local AI Hub logs folder was available. Bundle creation continued.\n', 'utf8');
    return report;
  }

  const entries = await fs.readdir(logsRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.log') || MEDIA_OR_MODEL_EXTENSION_PATTERN.test(entry.name)) continue;
    const sourcePath = path.join(logsRoot, entry.name);
    const stat = await fs.stat(sourcePath).catch(() => null);
    if (stat?.isFile()) candidates.push({ name: entry.name, sourcePath, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of candidates.slice(0, MAX_LOG_FILES)) {
    if (report.totalBytes >= MAX_LOG_TOTAL_BYTES) {
      report.skipped.push({ file: candidate.name, reason: 'total size cap reached' });
      continue;
    }
    try {
      const remaining = MAX_LOG_TOTAL_BYTES - report.totalBytes;
      const readBytes = Math.min(candidate.size, MAX_LOG_FILE_BYTES, remaining);
      const handle = await fs.open(candidate.sourcePath, 'r');
      const buffer = Buffer.alloc(readBytes);
      await fs.read(handle, buffer, 0, readBytes, Math.max(0, candidate.size - readBytes));
      await fs.close(handle);
      const sanitized = buffer.toString('utf8').split(/\r?\n/).map((line) => sanitizeLogLine(line, paths)).join('\n');
      const safeName = candidate.name.replace(/[^a-z0-9._-]/gi, '_');
      await fs.writeFile(path.join(targetRoot, safeName), `${candidate.size > readBytes ? '[Earlier log content omitted by size cap.]\n' : ''}${sanitized}`, 'utf8');
      report.totalBytes += Buffer.byteLength(sanitized, 'utf8');
      report.included.push({ file: safeName, sourceBytes: candidate.size, includedBytes: readBytes, truncated: candidate.size > readBytes });
    } catch (error) {
      report.skipped.push({ file: candidate.name, reason: sanitizeText(error?.message || 'could not read log', paths, 200) });
    }
  }

  await fs.writeJson(path.join(targetRoot, 'log-inclusion-report.json'), report, { spaces: 2 });
  return report;
}

async function createZip(folderPath, zipPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (error) => error.code === 'ENOENT' ? null : reject(error));
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(folderPath, path.basename(folderPath));
    archive.finalize();
  });
  return zipPath;
}

async function createDiagnosticsBundle(context = {}, dependencies = {}) {
  const data = await collectSupportData(context, dependencies);
  const paths = data.paths;
  const diagnosticsRoot = dependencies.diagnosticsRoot || getDiagnosticsRoot(paths);
  await fs.ensureDir(diagnosticsRoot);
  const bundleName = `LocalAIHub-Diagnostics-${timestampForFile()}`;
  const bundlePath = path.join(diagnosticsRoot, bundleName);
  const zipPath = `${bundlePath}.zip`;
  await fs.ensureDir(bundlePath);

  const readme = [
    'Local AI Hub diagnostics bundle',
    '',
    'Review every file in this folder before sharing it.',
    'This bundle contains app/version details, hardware and storage summaries, tool/provider readiness, recent recorder and pipeline metadata, and capped sanitized app logs.',
    'Local AI Hub does not intentionally include API keys, tokens, model files, source media, generated outputs, recorder media, pipeline artifact media, prompt bodies, browser data, or environment-variable dumps.',
    'Nothing was uploaded or sent automatically.',
    '',
    `Created: ${data.createdAt}`,
  ].join('\n');
  await fs.writeFile(path.join(bundlePath, 'README.txt'), `${readme}\n`, 'utf8');
  await fs.writeFile(path.join(bundlePath, 'system-info.txt'), buildSystemInfoText(data), 'utf8');
  await writeJson(path.join(bundlePath, 'app-summary.json'), {
    diagnosticsSchemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    createdAt: data.createdAt,
    app: data.app,
    os: data.os,
    hardware: data.hardware,
    storage: data.storage,
    ffmpeg: data.ffmpeg,
    recorder: data.recorder,
    warnings: data.warnings,
  }, paths);
  await writeJson(path.join(bundlePath, 'tools-summary.json'), data.tools, paths);
  await writeJson(path.join(bundlePath, 'providers-summary.json'), data.providers, paths);
  await writeJson(path.join(bundlePath, 'recorder-summary.json'), { recordings: data.recordings }, paths);
  await writeJson(path.join(bundlePath, 'pipeline-runs-summary.json'), data.pipelineRuns, paths);
  await writeJson(path.join(bundlePath, 'config-summary.json'), data.configSummary, paths);
  const logReport = await copySanitizedLogs(paths.logsRoot, path.join(bundlePath, 'logs'), paths);

  let createdZipPath = '';
  let zipWarning = '';
  try {
    createdZipPath = await createZip(bundlePath, zipPath);
  } catch (error) {
    zipWarning = sanitizeText(error?.message || 'The ZIP file could not be created.', paths, 300);
  }

  return {
    bundlePath,
    diagnosticsRoot,
    logReport,
    message: createdZipPath
      ? 'Diagnostics bundle created. Review it before sharing.'
      : 'Diagnostics folder created. Review it before sharing. The optional ZIP file could not be created.',
    zipPath: createdZipPath,
    zipWarning,
  };
}

module.exports = {
  DIAGNOSTICS_SCHEMA_VERSION,
  MAX_LOG_FILE_BYTES,
  MAX_LOG_FILES,
  MAX_LOG_TOTAL_BYTES,
  buildSystemInfoText,
  collectSupportData,
  copySanitizedLogs,
  createDiagnosticsBundle,
  getDiagnosticsRoot,
  sanitizeLogLine,
  sanitizeWorkflowValue,
};
