const path = require('path');
const fs = require('fs-extra');
const { open } = require('node:fs/promises');
const { app } = require('electron');
const extract = require('extract-zip');

const { version: APP_VERSION } = require('../../package.json');

const { getAppPaths, humanizeError, removeTool, setToolIgnored, upsertTool } = require('./configService');
const { verifyDownloadedFileIntegrity } = require('./downloadIntegrityService');
const { resolvePythonCommand, runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const { detectPythonRequirement, describePythonRequirement } = require('./pythonRequirementService');
const { ensureManagedPythonRuntime } = require('./pythonRuntimeService');
const { applyRepairCleanup, getDiskPreflight, inspectRepairCleanup } = require('./storageMaintenanceService');
const { syncDiscoveredTools } = require('./toolDiscoveryService');
const { buildManagedLaunchProfile, getToolManifest, initializeToolRegistry } = require('./toolRegistry');
const { assertPathInside, assertSecureRemoteUrl, findManagedToolsRootForPath, resolveManagedToolPaths } = require('./pathSafetyService');

const DOWNLOAD_TIMEOUT_MS = 30000;
const MIN_CACHE_BYTES = 1024;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[unitIndex]}`;
}

function pluralize(count, singular, plural = null) {
  return count === 1 ? singular : plural || `${singular}s`;
}

async function resolveRemoteDownloadSize(downloadUrl, logger) {
  const safeDownloadUrl = assertSecureRemoteUrl(downloadUrl, 'installer download URL');

  const readSizeFromResponse = (response) => {
    const contentLength = Number(response.headers.get('content-length')) || 0;
    if (contentLength > 0) {
      return contentLength;
    }

    const contentRange = String(response.headers.get('content-range') || '');
    const rangeMatch = contentRange.match(/\/(\d+)$/);
    if (rangeMatch?.[1]) {
      return Number(rangeMatch[1]) || 0;
    }

    return 0;
  };

  const requestSize = async (method, headers = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(safeDownloadUrl, {
        method,
        signal: controller.signal,
        headers: {
          'User-Agent': `LocalAIHub/${APP_VERSION}`,
          ...headers,
        },
      });

      return response.ok ? readSizeFromResponse(response) : 0;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const headSize = await requestSize('HEAD');
    if (headSize > 0) {
      return {
        requiredBytes: headSize,
        sizeKnown: true,
        source: 'head-request',
      };
    }
  } catch (error) {
    await logger.warn('Installer size preflight HEAD request failed.', {
      downloadUrl: safeDownloadUrl,
      error,
    });
  }

  try {
    const rangeSize = await requestSize('GET', {
      Range: 'bytes=0-0',
    });
    if (rangeSize > 0) {
      return {
        requiredBytes: rangeSize,
        sizeKnown: true,
        source: 'range-request',
      };
    }
  } catch (error) {
    await logger.warn('Installer size preflight range request failed.', {
      downloadUrl: safeDownloadUrl,
      error,
    });
  }

  return {
    requiredBytes: 0,
    sizeKnown: false,
    source: 'unknown',
  };
}
async function estimateToolInstallRequirement(manifest, archivePath, logger) {
  if (archivePath && (await fs.pathExists(archivePath))) {
    const stats = await fs.stat(archivePath).catch(() => null);
    if (stats?.size > MIN_CACHE_BYTES) {
      return {
        requiredBytes: stats.size,
        sizeKnown: true,
        source: 'cached-installer',
      };
    }
  }

  if (manifest.installInstructions.kind === 'pip-package') {
    return {
      requiredBytes: 0,
      sizeKnown: false,
      source: 'pip-package',
    };
  }

  return resolveRemoteDownloadSize(manifest.downloadUrl, logger);
}

function assertInstallPreflightApproved(preflight, confirmed) {
  if (!preflight) {
    return;
  }

  if (preflight.blocked) {
    throw new Error(
      `${preflight.toolName} needs ${formatBytes(preflight.requiredBytes)} but only ${formatBytes(preflight.availableBytes)} is free on ${preflight.mount}. Clear space and try again.`,
    );
  }

  if (preflight.requiresConfirmation && !confirmed) {
    const sizeMessage = preflight.sizeKnown
      ? `${preflight.toolName} needs about ${formatBytes(preflight.requiredBytes)} and Local AI Hub needs confirmation before continuing on ${preflight.mount}.`
      : `${preflight.toolName} may leave this drive very low on free space, and Local AI Hub needs confirmation before continuing on ${preflight.mount}.`;
    throw new Error(sizeMessage);
  }
}

function buildRepairCleanupNotes(cleanupSummary) {
  const notes = [];

  if (cleanupSummary.removedDuplicateFolders > 0) {
    notes.push(
      `removed ${cleanupSummary.removedDuplicateFolders} duplicate ${pluralize(cleanupSummary.removedDuplicateFolders, 'install folder')}`,
    );
  }

  if (cleanupSummary.removedTemporaryArtifacts > 0) {
    notes.push(
      `cleaned ${cleanupSummary.removedTemporaryArtifacts} leftover ${pluralize(cleanupSummary.removedTemporaryArtifacts, 'download or temp item')}`,
    );
  }

  if (cleanupSummary.removedOrphanedToolFolders > 0) {
    notes.push(
      `deleted ${cleanupSummary.removedOrphanedToolFolders} orphaned ${pluralize(cleanupSummary.removedOrphanedToolFolders, 'tool folder')}`,
    );
  }

  if (cleanupSummary.skippedOrphanedToolFolders > 0) {
    notes.push(
      `left ${cleanupSummary.skippedOrphanedToolFolders} orphaned ${pluralize(cleanupSummary.skippedOrphanedToolFolders, 'tool folder')} untouched`,
    );
  }

  if (cleanupSummary.recoveredBytes > 0) {
    notes.push(`recovered ${formatBytes(cleanupSummary.recoveredBytes)} of disk space`);
  }

  return notes;
}

function summarizeRepairPlan(cleanupPlan) {
  const duplicateRecoveryBytes = cleanupPlan.duplicateFolders.reduce(
    (total, entry) => total + Number(entry.sizeBytes || 0),
    0,
  );
  const orphanedRecoveryBytes = cleanupPlan.orphanedToolFolders.reduce(
    (total, entry) => total + Number(entry.sizeBytes || 0),
    0,
  );
  const temporaryRecoveryBytes = cleanupPlan.temporaryArtifacts.reduce(
    (total, entry) => total + Number(entry.sizeBytes || 0),
    0,
  );

  return {
    duplicateFolderCount: cleanupPlan.duplicateFolders.length,
    duplicateRecoveryBytes,
    orphanedToolFolderCount: cleanupPlan.orphanedToolFolders.length,
    orphanedRecoveryBytes,
    potentialRecoveryBytes: cleanupPlan.potentialRecoveryBytes,
    requiresOrphanConfirmation: cleanupPlan.requiresOrphanConfirmation,
    temporaryArtifactCount: cleanupPlan.temporaryArtifacts.length,
    temporaryRecoveryBytes,
  };
}

function buildRepairOutcomeMessage(toolName, notes = []) {
  if (!notes.length) {
    return `Local AI Hub repaired ${toolName}.`;
  }

  return `Local AI Hub repaired ${toolName}: ${notes.join(', ')}.`;
}

async function getToolInstallPreflight(toolId) {
  await initializeToolRegistry();
  const manifest = getToolManifest(toolId);
  if (!manifest) {
    throw new Error('Local AI Hub does not recognize that tool.');
  }

  const logger = createLogger('installer', {
    toolId,
    toolName: manifest.name,
    mode: 'preflight',
  });
  const { archivePath } = buildManagedPaths(manifest);
  const estimate = await estimateToolInstallRequirement(manifest, archivePath, logger);
  const managedDataPath = getAppPaths().managedRoot;
  const preflight = await getDiskPreflight(managedDataPath, estimate.requiredBytes);

  return {
    ...preflight,
    estimateSource: estimate.source,
    sizeKnown: estimate.sizeKnown,
    targetPath: managedDataPath,
    toolId,
    toolName: manifest.name,
  };
}

function getToolRuntime(manifest) {
  return manifest.installInstructions.runtime;
}
function isBareCommand(token) {
  return Boolean(token) && !path.isAbsolute(token) && !/[\\/]/.test(token);
}

const SAFE_PIP_PACKAGE_PATTERN = /^[A-Za-z0-9._+\-[\],=<>!~]+$/;

function assertSafePipInstallTarget(value) {
  const target = String(value || '').trim();
  if (!target || !SAFE_PIP_PACKAGE_PATTERN.test(target)) {
    throw new Error('Local AI Hub refused to install an unsafe Python package target.');
  }

  return target;
}

function ensureManagedToolStatePaths(toolState) {
  if (!toolState?.id) {
    throw new Error('Local AI Hub could not validate the managed tool path.');
  }

  const installRoot = toolState.installDir || toolState.appDir || '';
  const toolsRootOverride = installRoot ? findManagedToolsRootForPath(installRoot) : null;
  const managedRootOverride = toolsRootOverride ? path.dirname(toolsRootOverride) : null;
  const managedPaths = resolveManagedToolPaths(
    toolState.id,
    path.basename(toolState.venvDir || '.venv'),
    managedRootOverride ? { managedRoot: managedRootOverride } : {},
  );
  const allowedToolsRoot = toolsRootOverride || managedPaths.toolsRoot;
  const installDir = assertPathInside(
    allowedToolsRoot,
    toolState.installDir || managedPaths.installDir,
    'Local AI Hub refused to use a managed install outside its tools folder.',
  );
  const appDir = assertPathInside(
    installDir,
    toolState.appDir || managedPaths.appDir,
    'Local AI Hub refused to use a managed app folder outside the tool directory.',
  );
  const venvDir = toolState.venvDir
    ? assertPathInside(
        installDir,
        toolState.venvDir,
        'Local AI Hub refused to use a managed Python environment outside the tool directory.',
      )
    : null;

  return {
    ...toolState,
    installDir,
    appDir,
    venvDir,
  };
}

function buildManagedProcessEnv(toolState, extraEnv = {}, options = {}) {
  const safeToolState = ensureManagedToolStatePaths(toolState);
  const stateRoot = path.join(safeToolState.installDir, '.localaihub');
  const cacheDir = path.join(stateRoot, 'cache');
  const tempDir = path.join(stateRoot, 'tmp');
  const pycacheDir = path.join(stateRoot, 'pycache');

  return {
    ...process.env,
    ...extraEnv,
    LOCALAIHUB_TOOL_ID: safeToolState.id,
    LOCALAIHUB_TOOL_ROOT: safeToolState.installDir,
    PIP_CACHE_DIR: cacheDir,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONPYCACHEPREFIX: pycacheDir,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    XDG_CACHE_HOME: cacheDir,
    ...(options.requireVirtualEnv ? { PIP_REQUIRE_VIRTUALENV: '1' } : {}),
  };
}

async function verifyCachedDownload(manifest, archivePath, logger) {
  try {
    return await verifyDownloadedFileIntegrity(manifest.downloadUrl, archivePath, logger, `${manifest.name} installer`);
  } catch (error) {
    await fs.remove(archivePath).catch(() => null);
    throw error;
  }
}
function reportProgress(callback, payload) {
  if (typeof callback === 'function') {
    callback(payload);
  }
}

async function advanceStep(logger, callback, payload, context = {}) {
  await logger.info(payload.message, {
    stage: payload.stage,
    percent: payload.percent,
    ...context,
  });
  reportProgress(callback, payload);
}

async function fetchWithTimeout(url, logger) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    await logger.info('Opening installer download connection.', {
      url,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': `LocalAIHub/${APP_VERSION}`,
      },
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Local AI Hub could not reach the download server. Check your internet connection and try again.');
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function hasUsableArchiveCache(archivePath, logger) {
  if (!(await fs.pathExists(archivePath))) {
    return false;
  }

  const stats = await fs.stat(archivePath);
  if (stats.size < MIN_CACHE_BYTES) {
    await logger.warn('Discarding incomplete cached installer archive.', {
      archivePath,
      sizeBytes: stats.size,
    });
    await fs.remove(archivePath);
    return false;
  }

  await logger.info('Using cached installer archive.', {
    archivePath,
    sizeBytes: stats.size,
  });
  return true;
}

async function downloadFile(url, destination, onProgress, logger, toolId) {
  assertSecureRemoteUrl(url, 'installer download URL');

  await advanceStep(
    logger,
    onProgress,
    {
      toolId,
      percent: 10,
      stage: 'downloading',
      message: 'Connecting to the download source.',
    },
    { url },
  );

  const response = await fetchWithTimeout(url, logger);
  if (!response.ok || !response.body) {
    throw new Error('Local AI Hub could not download the installer package.');
  }

  await fs.ensureDir(path.dirname(destination));
  const fileHandle = await open(destination, 'w');
  const reader = response.body.getReader();
  const total = Number(response.headers.get('content-length')) || 0;
  let downloaded = 0;
  let nextLogThreshold = 25;
  let nextUnknownLogBytes = 10 * 1024 * 1024;

  await logger.info('Installer download started.', {
    destination,
    totalBytes: total || null,
  });

  try {
    await advanceStep(
      logger,
      onProgress,
      {
        toolId,
        percent: 18,
        stage: 'downloading',
        message:
          total > 0
            ? 'Downloading the installer package.'
            : 'Downloading the installer package. The source did not report a file size.',
      },
      { totalBytes: total || null },
    );

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      downloaded += chunk.length;
      await fileHandle.write(chunk, 0, chunk.length);

      if (total > 0) {
        const percent = Math.min(45, 18 + Math.round((downloaded / total) * 27));
        reportProgress(onProgress, {
          toolId,
          percent,
          stage: 'downloading',
          message: 'Downloading the installer package.',
        });

        const percentComplete = Math.round((downloaded / total) * 100);
        if (percentComplete >= nextLogThreshold) {
          await logger.info('Installer download progress.', {
            downloadedBytes: downloaded,
            totalBytes: total,
            progressPercent: percentComplete,
          });
          nextLogThreshold += 25;
        }
      } else if (downloaded >= nextUnknownLogBytes) {
        await logger.info('Installer download progress.', {
          downloadedBytes: downloaded,
          totalBytes: null,
        });
        nextUnknownLogBytes += 10 * 1024 * 1024;
      }
    }

    await logger.info('Installer download finished.', {
      downloadedBytes: downloaded,
      totalBytes: total || null,
      destination,
    });
  } catch (error) {
    await logger.error('Installer download failed.', {
      destination,
      error,
    });
    await fs.remove(destination).catch(() => null);
    throw error;
  } finally {
    await fileHandle.close().catch(() => null);
  }
}

async function extractArchive(archivePath, targetDirectory, logger) {
  const tempDirectory = `${targetDirectory}__extract`;
  await logger.info('Extracting installer archive.', {
    archivePath,
    targetDirectory,
  });

  await fs.remove(tempDirectory);
  await fs.ensureDir(tempDirectory);

  const extension = path.extname(archivePath).toLowerCase();
  if (extension === '.7z') {
    const sevenZipPath = app.isPackaged
      ? path.join(process.resourcesPath, 'bin', '7za.exe')
      : path.join(__dirname, '..', '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

    if (!(await fs.pathExists(sevenZipPath))) {
      throw new Error('Local AI Hub is missing its 7-Zip helper and could not unpack that installer package.');
    }

    await fs.emptyDir(tempDirectory);
    await runCommand(sevenZipPath, ['x', archivePath, '-y', `-o${tempDirectory}`], {
      cwd: path.dirname(archivePath),
      errorMessage: 'Local AI Hub could not unpack the 7-Zip installer package.',
    });
  } else {
    await extract(archivePath, { dir: tempDirectory });
  }

  const entries = await fs.readdir(tempDirectory);
  const firstEntryPath = entries.length === 1 ? path.join(tempDirectory, entries[0]) : null;
  const hasSingleRoot =
    firstEntryPath && (await fs.stat(firstEntryPath)).isDirectory() && entries.length === 1;

  await fs.remove(targetDirectory);

  if (hasSingleRoot) {
    await fs.move(firstEntryPath, targetDirectory, { overwrite: true });
    await fs.remove(tempDirectory);
    await logger.info('Installer archive extracted into a single root folder.', {
      targetDirectory,
    });
    return targetDirectory;
  }

  await fs.move(tempDirectory, targetDirectory, { overwrite: true });
  await logger.info('Installer archive extracted into the app directory.', {
    targetDirectory,
  });
  return targetDirectory;
}

async function extractArchiveWithRecovery(manifest, archivePath, targetDirectory, onProgress, logger, toolId) {
  try {
    await extractArchive(archivePath, targetDirectory, logger);
  } catch (error) {
    await logger.warn('Installer archive extraction failed. Clearing the cached archive and retrying once.', {
      archivePath,
      error,
    });
    await fs.remove(archivePath).catch(() => null);

    await downloadFile(manifest.downloadUrl, archivePath, onProgress, logger, toolId);
    await verifyCachedDownload(manifest, archivePath, logger);
    await advanceStep(logger, onProgress, {
      toolId,
      percent: 50,
      stage: 'extracting',
      message: 'Expanding the installer package.',
    });

    try {
      await extractArchive(archivePath, targetDirectory, logger);
    } catch (retryError) {
      await logger.error('Installer archive extraction failed after retry.', {
        archivePath,
        error: retryError,
      });
      throw new Error('Local AI Hub could not unpack the installer package. The cached download was replaced, so try Install again.');
    }
  }
}

async function installPythonDependencies(toolState, manifest, onProgress, logger, pythonRuntime) {
  toolState = ensureManagedToolStatePaths(toolState);
  const python = pythonRuntime || (await resolvePythonCommand());
  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');
  const stateRoot = path.join(toolState.installDir, '.localaihub');

  await Promise.all([
    fs.ensureDir(toolState.installDir),
    fs.ensureDir(toolState.appDir),
    fs.ensureDir(path.join(stateRoot, 'cache')),
    fs.ensureDir(path.join(stateRoot, 'tmp')),
    fs.ensureDir(path.join(stateRoot, 'pycache')),
  ]);

  await advanceStep(
    logger,
    onProgress,
    {
      toolId: toolState.id,
      percent: 66,
      stage: 'environment',
      message: 'Creating a dedicated Python environment.',
    },
    {
      launcher: python.pythonPath || python.executable || python.launcher,
      version: python.versionString,
    },
  );

  if (python.pythonPath) {
    await runCommand(python.pythonPath, ['-m', 'venv', toolState.venvDir], {
      cwd: toolState.appDir,
      env: buildManagedProcessEnv(toolState),
      errorMessage: 'Local AI Hub could not create the Python virtual environment.',
    });
  } else {
    await runCommand(python.launcher, [...python.launcherArgs, '-m', 'venv', toolState.venvDir], {
      cwd: toolState.appDir,
      env: buildManagedProcessEnv(toolState),
      errorMessage: 'Local AI Hub could not create the Python virtual environment.',
    });
  }

  await logger.info('Python virtual environment created.', {
    venvDir: toolState.venvDir,
  });

  await advanceStep(logger, onProgress, {
    toolId: toolState.id,
    percent: 72,
    stage: 'dependencies',
    message: 'Updating pip inside the virtual environment.',
  });

  await runCommand(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
    cwd: toolState.appDir,
    env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
    errorMessage: 'Local AI Hub could not update pip in the tool environment.',
  });

  await logger.info('pip was upgraded inside the tool environment.', {
    pythonPath,
  });

  const instructions = manifest.installInstructions.pipInstalls || [];
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    const baseProgress = 78 + Math.round((index / Math.max(1, instructions.length)) * 14);
    let args = ['-m', 'pip', 'install'];
    let installTarget = instruction.value;

    if (instruction.kind === 'requirements') {
      const requirementsPath = assertPathInside(
        toolState.appDir,
        path.join(toolState.appDir, instruction.value),
        'Local AI Hub refused to install dependencies from outside the tool folder.',
      );
      if (!(await fs.pathExists(requirementsPath))) {
        await logger.warn('Skipping missing requirements file.', {
          requirementsPath,
        });
        continue;
      }
      installTarget = requirementsPath;
      args = [...args, '-r', requirementsPath];
    } else if (instruction.kind === 'path') {
      installTarget = assertPathInside(
        toolState.appDir,
        path.resolve(toolState.appDir, instruction.value),
        'Local AI Hub refused to install a Python package path outside the tool folder.',
      );
      args = [...args, installTarget];
    } else {
      installTarget = assertSafePipInstallTarget(instruction.value);
      args = [...args, installTarget];
    }

    await advanceStep(
      logger,
      onProgress,
      {
        toolId: toolState.id,
        percent: baseProgress,
        stage: 'dependencies',
        message: `Installing ${manifest.name} dependencies.`,
      },
      {
        installTarget,
      },
    );

    await runCommand(pythonPath, args, {
      cwd: toolState.appDir,
      env: buildManagedProcessEnv(toolState, {}, { requireVirtualEnv: true }),
      errorMessage: `Local AI Hub could not install ${manifest.name} dependencies.`,
    });

    await logger.info('Dependency installation step finished.', {
      installTarget,
    });
  }
}

async function resolveManagedPythonRuntime(appDir, manifest, logger, onProgress, toolId) {
  if (getToolRuntime(manifest) !== 'python') {
    return null;
  }

  await advanceStep(logger, onProgress, {
    toolId,
    percent: 54,
    stage: 'runtime',
    message: 'Inspecting the downloaded tool for Python requirements.',
  });

  const requirement = await detectPythonRequirement(appDir, manifest, logger);
  await logger.info('Tool Python requirement resolved.', {
    requirement: describePythonRequirement(requirement),
  });

  const runtime = await ensureManagedPythonRuntime(requirement, {
    logger,
    onProgress,
    toolId,
    toolName: manifest.name,
  });

  return {
    requirement,
    runtime,
  };
}

async function toolIsAvailable(toolState) {
  if (!toolState) {
    return false;
  }

  if (toolState.launchProfile?.kind === 'binary' && toolState.launchProfile?.executable) {
    return fs.pathExists(toolState.launchProfile.executable);
  }

  if ((toolState.launchProfile?.kind === 'python-script' || toolState.launchProfile?.kind === 'python-module') && toolState.launchProfile?.pythonPath) {
    if (isBareCommand(toolState.launchProfile.pythonPath)) {
      return toolState.installDir ? fs.pathExists(toolState.installDir) : true;
    }

    return fs.pathExists(toolState.launchProfile.pythonPath);
  }

  if (toolState.launchProfile?.kind === 'batch' && toolState.launchProfile?.command) {
    return fs.pathExists(toolState.launchProfile.command);
  }

  return toolState.installDir ? fs.pathExists(toolState.installDir) : false;
}

function createManagedToolState(manifest, installDir, appDir, venvDir, archivePath, pythonResolution) {
  const runtime = pythonResolution?.runtime || null;
  const requirement = pythonResolution?.requirement || null;
  const managedRuntime = runtime?.source === 'managed' ? runtime : null;
  const toolState = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    category: manifest.category,
    type: getToolRuntime(manifest),
    source: 'managed',
    managedByLocalAIHub: true,
    installDir,
    appDir,
    venvDir: getToolRuntime(manifest) === 'python' ? venvDir : null,
    executablePath:
      getToolRuntime(manifest) === 'binary' ? path.join(appDir, path.basename(manifest.launchCommand.split(' ')[0])) : null,
    launchUrl: manifest.launchUrl,
    healthUrl: manifest.healthUrl,
    processNames: manifest.processNames,
    configTargets: manifest.installInstructions.configTargets,
    downloadCachePath: archivePath,
    installedAt: new Date().toISOString(),
    lastError: null,
    lastRepairMessage: null,
    status: 'stopped',
    launchSupported: true,
    displayPath: installDir,
    pythonRequirement: requirement,
    pythonBootstrapPath: runtime?.pythonPath || runtime?.executable || runtime?.launcher || null,
    pythonBootstrapSource: runtime?.source || null,
    pythonBootstrapVersion: runtime?.versionString || null,
    managedPythonVersion: managedRuntime?.versionString || null,
    managedPythonPath: managedRuntime?.pythonPath || null,
    managedPythonInstallDir: managedRuntime?.installDir || null,
  };

  toolState.launchProfile = buildManagedLaunchProfile(toolState, manifest);
  if (toolState.launchProfile?.kind === 'binary') {
    toolState.executablePath = toolState.launchProfile.executable;
  }
  return ensureManagedToolStatePaths(toolState);
}
function buildManagedPaths(manifest) {
  const { downloadsRoot } = getAppPaths();
  const managedPaths = resolveManagedToolPaths(
    manifest.id,
    manifest.installInstructions.venvFolder || '.venv',
  );
  const cacheFileName =
    manifest.installInstructions.downloadFileName ||
    manifest.installInstructions.archiveName ||
    deriveCacheFileName(manifest.downloadUrl, manifest.id);
  const archivePath = assertPathInside(
    downloadsRoot,
    path.join(downloadsRoot, manifest.id, cacheFileName),
    'Local AI Hub refused to use a download cache path outside the downloads folder.',
  );

  return {
    ...managedPaths,
    archivePath,
  };
}

function deriveCacheFileName(downloadUrl, toolId) {
  try {
    const parsed = new URL(downloadUrl);
    const baseName = path.basename(parsed.pathname) || `${toolId}.bin`;
    return baseName.includes('.') ? baseName : `${toolId}.bin`;
  } catch {
    return `${toolId}.bin`;
  }
}

function replaceInstallerTemplate(value, replacements) {
  return String(value || '').replace(/\{([^}]+)\}/g, (_match, key) => {
    const resolvedValue = replacements[key];
    return resolvedValue === undefined || resolvedValue === null ? '' : String(resolvedValue);
  });
}

function resolveInstallerArgs(manifest, installDir, appDir) {
  return (manifest.installInstructions.installerArgs || [])
    .map((value) =>
      replaceInstallerTemplate(value, {
        appDir,
        installDir,
      }),
    )
    .filter(Boolean);
}

async function ensureCachedDownload(manifest, archivePath, logger, onProgress, toolId) {
  assertSecureRemoteUrl(manifest.downloadUrl, `${manifest.name} download URL`);

  const hasCachedArchive = await hasUsableArchiveCache(archivePath, logger);
  if (hasCachedArchive) {
    await advanceStep(
      logger,
      onProgress,
      {
        toolId,
        percent: 45,
        stage: 'downloading',
        message: 'Using the cached installer package.',
      },
      {
        archivePath,
      },
    );

    try {
      await verifyCachedDownload(manifest, archivePath, logger);
      return;
    } catch (error) {
      await logger.warn('Cached installer verification failed. Downloading a fresh copy.', {
        archivePath,
        error,
      });
    }
  }

  await downloadFile(manifest.downloadUrl, archivePath, onProgress, logger, toolId);
  await verifyCachedDownload(manifest, archivePath, logger);
}

async function installSingleFileTool(manifest, options, logger) {
  const { appDir, archivePath, installDir, venvDir } = buildManagedPaths(manifest);
  const downloadFileName =
    manifest.installInstructions.downloadFileName ||
    path.basename(archivePath) ||
    `${manifest.id}.exe`;
  const destinationPath = assertPathInside(
    appDir,
    path.join(appDir, downloadFileName),
    'Local AI Hub refused to copy a launcher outside the managed app folder.',
  );

  await logger.info('Single-file install requested.', {
    archivePath,
    destinationPath,
    installDir,
  });

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 5,
    stage: 'preparing',
    message: `Preparing ${manifest.name}.`,
  });

  await fs.ensureDir(appDir);
  await ensureCachedDownload(manifest, archivePath, logger, options.onProgress, manifest.id);

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 68,
    stage: 'extracting',
    message: `Copying ${manifest.name} into Local AI Hub.`,
  });

  await fs.copy(archivePath, destinationPath, { overwrite: true });

  const toolState = createManagedToolState(manifest, installDir, appDir, venvDir, archivePath, null);
  await upsertTool(toolState);

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 100,
    stage: 'complete',
    message: `${manifest.name} is ready.`,
  });

  return ensureManagedToolStatePaths(toolState);
}

async function installExecutableInstallerTool(manifest, options, logger) {
  const { appDir, archivePath, installDir, venvDir } = buildManagedPaths(manifest);

  await logger.info('Installer executable requested.', {
    archivePath,
    installDir,
  });

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 5,
    stage: 'preparing',
    message: `Preparing ${manifest.name}.`,
  });

  await fs.ensureDir(installDir);
  await fs.ensureDir(appDir);
  await ensureCachedDownload(manifest, archivePath, logger, options.onProgress, manifest.id);

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 72,
    stage: 'installing',
    message: `Running the official ${manifest.name} installer.`,
  });

  await runCommand(archivePath, resolveInstallerArgs(manifest, installDir, appDir), {
    cwd: path.dirname(archivePath),
    errorMessage: `Local AI Hub could not run the ${manifest.name} installer.`,
  });

  let toolState = createManagedToolState(manifest, installDir, appDir, venvDir, archivePath, null);
  if (!(await toolIsAvailable(toolState))) {
    const discoveredTools = await syncDiscoveredTools({ force: true });
    const detectedTool = discoveredTools[manifest.id];
    if (await toolIsAvailable(detectedTool)) {
      toolState = {
        ...detectedTool,
        downloadCachePath: archivePath,
      };
    } else {
      throw new Error(`${manifest.name} finished installing, but Local AI Hub could not find its launcher files afterward.`);
    }
  }

  await upsertTool(toolState);

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 100,
    stage: 'complete',
    message: `${manifest.name} is ready.`,
  });

  return toolState.source === 'managed' ? ensureManagedToolStatePaths(toolState) : toolState;
}

async function installPipPackageTool(manifest, options, logger) {
  const { appDir, archivePath, installDir, venvDir } = buildManagedPaths(manifest);

  await logger.info('Pip package install requested.', {
    installDir,
    archivePath,
  });

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 5,
    stage: 'preparing',
    message: `Preparing ${manifest.name}.`,
  });

  await fs.ensureDir(installDir);
  await fs.ensureDir(appDir);

  const pythonResolution = await resolveManagedPythonRuntime(
    appDir,
    manifest,
    logger,
    options.onProgress,
    manifest.id,
  );

  const toolState = createManagedToolState(
    manifest,
    installDir,
    appDir,
    venvDir,
    archivePath,
    pythonResolution,
  );

  await installPythonDependencies(
    toolState,
    manifest,
    options.onProgress,
    logger,
    pythonResolution.runtime,
  );

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 98,
    stage: 'finalizing',
    message: `${manifest.name} is being registered in Local AI Hub.`,
  });

  await upsertTool(toolState);

  await advanceStep(logger, options.onProgress, {
    toolId: manifest.id,
    percent: 100,
    stage: 'complete',
    message: `${manifest.name} is ready.`,
  });

  return ensureManagedToolStatePaths(toolState);
}

async function installTool(toolId, options = {}) {
  await initializeToolRegistry();
  const manifest = getToolManifest(toolId);
  if (!manifest) {
    throw new Error('Local AI Hub does not recognize that tool.');
  }

  const logger = createLogger('installer', {
    toolId,
    toolName: manifest.name,
  });

  try {
    await setToolIgnored(toolId, false);
    const discoveredTools = await syncDiscoveredTools({ force: true });
    const existingTool = discoveredTools[toolId];
    if (await toolIsAvailable(existingTool)) {
      const existingPath = existingTool.displayPath || existingTool.installDir;
      const installActionMessage =
        existingTool.source === 'managed'
          ? `${manifest.name} is already installed inside Local AI Hub.`
          : existingPath
            ? `${manifest.name} is already on this PC. Local AI Hub will use the existing install at ${existingPath}.`
            : `${manifest.name} is already on this PC. Local AI Hub will use the existing install it detected.`;

      await logger.info('Install request reused an existing tool installation.', {
        existingPath,
        source: existingTool.source,
      });

      return {
        ...existingTool,
        installActionMessage,
        reusedExistingInstall: true,
      };
    }

    const installPreflight = await getToolInstallPreflight(toolId);
    assertInstallPreflightApproved(installPreflight, Boolean(options.lowDiskConfirmed));

    const { archivePath, installDir } = buildManagedPaths(manifest);

    await logger.info('Install requested.', {
      installDir,
      archivePath,
      logsPath: await logger.getFilePath(),
    });

    const installKind = manifest.installInstructions.kind || 'zip';
    if (installKind === 'single-file') {
      const toolState = await installSingleFileTool(manifest, options, logger);
      await logger.info('Single-file install completed successfully.');
      return ensureManagedToolStatePaths(toolState);
    }

    if (installKind === 'installer-exe') {
      const toolState = await installExecutableInstallerTool(manifest, options, logger);
      await logger.info('Installer-based install completed successfully.');
      return toolState.source === 'managed' ? ensureManagedToolStatePaths(toolState) : toolState;
    }

    if (installKind === 'pip-package') {
      const toolState = await installPipPackageTool(manifest, options, logger);
      await logger.info('Pip package install completed successfully.');
      return ensureManagedToolStatePaths(toolState);
    }

    const { appDir, venvDir } = buildManagedPaths(manifest);

    await advanceStep(logger, options.onProgress, {
      toolId,
      percent: 5,
      stage: 'preparing',
      message: `Preparing ${manifest.name}.`,
    });

    await fs.ensureDir(installDir);
    await ensureCachedDownload(manifest, archivePath, logger, options.onProgress, toolId);

    await advanceStep(logger, options.onProgress, {
      toolId,
      percent: 50,
      stage: 'extracting',
      message: 'Expanding the installer package.',
    });

    await extractArchiveWithRecovery(manifest, archivePath, appDir, options.onProgress, logger, toolId);

    const pythonResolution = await resolveManagedPythonRuntime(
      appDir,
      manifest,
      logger,
      options.onProgress,
      toolId,
    );

    const toolState = createManagedToolState(
      manifest,
      installDir,
      appDir,
      venvDir,
      archivePath,
      pythonResolution,
    );

    if (getToolRuntime(manifest) === 'python') {
      await installPythonDependencies(
        toolState,
        manifest,
        options.onProgress,
        logger,
        pythonResolution.runtime,
      );
    }

    await advanceStep(logger, options.onProgress, {
      toolId,
      percent: 98,
      stage: 'finalizing',
      message: `${manifest.name} is being registered in Local AI Hub.`,
    });

    await upsertTool(toolState);
    await logger.info('Tool registration completed.', {
      installDir,
      launchProfile: toolState.launchProfile,
    });

    await advanceStep(logger, options.onProgress, {
      toolId,
      percent: 100,
      stage: 'complete',
      message: `${manifest.name} is ready.`,
    });
    await logger.info('Install completed successfully.');

    return ensureManagedToolStatePaths(toolState);
  } catch (error) {
    await logger.error('Install failed.', {
      error,
      readableMessage: humanizeError(error, `Local AI Hub could not install ${manifest.name}.`),
    });
    throw error;
  }
}

async function removePythonCaches(directory) {
  if (!(await fs.pathExists(directory))) {
    return;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') {
          await fs.remove(entryPath);
          return;
        }
        await removePythonCaches(entryPath);
      }
    }),
  );
}

async function inspectToolRepair(toolState) {
  await initializeToolRegistry();
  const manifest = getToolManifest(toolState?.id);
  if (!manifest) {
    throw new Error('Local AI Hub could not find the tool definition for repair.');
  }

  const safeToolState = toolState?.source === 'managed' ? ensureManagedToolStatePaths(toolState) : toolState;
  const cleanupPlan = await inspectRepairCleanup(safeToolState, manifest);
  return {
    toolId: toolState.id,
    toolName: manifest.name,
    ...summarizeRepairPlan(cleanupPlan),
  };
}

async function repairToolInstallation(toolState, options = {}) {
  const manifest = getToolManifest(toolState.id);
  if (!manifest) {
    throw new Error('Local AI Hub could not find the tool definition for repair.');
  }

  const logger = createLogger('installer', {
    toolId: toolState.id,
    toolName: manifest.name,
    mode: 'repair',
  });

  try {
    const managedPaths = buildManagedPaths(manifest);
    const installKind = manifest.installInstructions.kind || 'zip';
    if (toolState.source === 'managed') {
      toolState = ensureManagedToolStatePaths(toolState);
    }

    await logger.info('Repair requested.', {
      installDir: toolState.installDir,
      archivePath: toolState.downloadCachePath || managedPaths.archivePath,
    });

    await advanceStep(logger, options.onProgress, {
      toolId: toolState.id,
      percent: 12,
      stage: 'cleanup',
      message: 'Checking for duplicate folders and failed downloads.',
    });

    const cleanupPlan = await inspectRepairCleanup(toolState, manifest);
    const cleanupSummary = await applyRepairCleanup(cleanupPlan, {
      logger,
      removeOrphanedToolFolders: Boolean(options.removeOrphanedToolFolders),
    });
    const repairNotes = buildRepairCleanupNotes(cleanupSummary);
    let runtimeChanged = false;

    if (toolState.source !== 'managed') {
      if (installKind !== 'installer-exe') {
        throw new Error('Local AI Hub can only repair external installs when the official installer can be rerun safely.');
      }

      const downloadCachePath = toolState.downloadCachePath || managedPaths.archivePath;
      await ensureCachedDownload(manifest, downloadCachePath, logger, options.onProgress, toolState.id);

      await logger.info('External installer repair requested.', {
        installDir: toolState.installDir,
        archivePath: downloadCachePath,
      });

      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 40,
        stage: 'repairing',
        message: `Running the ${manifest.name} installer again.`,
      });

      await runCommand(downloadCachePath, resolveInstallerArgs(manifest, toolState.installDir, toolState.appDir || toolState.installDir), {
        cwd: path.dirname(downloadCachePath),
        errorMessage: `Local AI Hub could not rerun the ${manifest.name} installer.`,
      });

      const discoveredTools = await syncDiscoveredTools({ force: true });
      const repairedExternalTool = discoveredTools[toolState.id];
      if (!(await toolIsAvailable(repairedExternalTool))) {
        throw new Error(`Local AI Hub reran the ${manifest.name} installer, but it still could not find the launcher afterward.`);
      }

      repairNotes.push('reran the official installer');
      const updatedExternalTool = {
        ...repairedExternalTool,
        downloadCachePath,
        lastError: null,
        lastRepairMessage: buildRepairOutcomeMessage(manifest.name, repairNotes),
        status: 'stopped',
      };
      await upsertTool(updatedExternalTool);

      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 100,
        stage: 'complete',
        message: updatedExternalTool.lastRepairMessage,
      });

      return updatedExternalTool;
    }

    toolState.downloadCachePath = managedPaths.archivePath;
    if (installKind !== 'pip-package') {
      await ensureCachedDownload(manifest, toolState.downloadCachePath, logger, options.onProgress, toolState.id);
    }

    if (installKind === 'single-file') {
      const destinationPath = assertPathInside(
        managedPaths.appDir,
        path.join(
          managedPaths.appDir,
          manifest.installInstructions.downloadFileName || path.basename(toolState.downloadCachePath),
        ),
        'Local AI Hub refused to restore a launcher outside the managed app folder.',
      );

      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 25,
        stage: 'repairing',
        message: 'Restoring the tool launcher from the cached installer.',
      });
      await fs.ensureDir(managedPaths.appDir);
      await fs.copy(toolState.downloadCachePath, destinationPath, { overwrite: true });
      repairNotes.push('restored the launcher file from the local cache');
    } else if (installKind === 'installer-exe') {
      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 25,
        stage: 'repairing',
        message: `Running the ${manifest.name} installer again.`,
      });
      await runCommand(toolState.downloadCachePath, resolveInstallerArgs(manifest, toolState.installDir, toolState.appDir), {
        cwd: path.dirname(toolState.downloadCachePath),
        errorMessage: `Local AI Hub could not rerun the ${manifest.name} installer.`,
      });
      repairNotes.push('reran the official installer from the local cache');
    } else if (installKind === 'zip') {
      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 25,
        stage: 'repairing',
        message: 'Restoring the tool files from the cached installer.',
      });
      await extractArchive(toolState.downloadCachePath, toolState.appDir, logger);
      repairNotes.push('restored the application files from the local cache');
    } else if (installKind === 'pip-package') {
      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 25,
        stage: 'repairing',
        message: 'Refreshing the tool package inside its Python environment.',
      });
      repairNotes.push('refreshed the installed Python package');
    }

    if (getToolRuntime(manifest) === 'python') {
      await removePythonCaches(toolState.appDir);
      await logger.info('Cleared Python cache folders during repair.');
      repairNotes.push('cleared cached Python bytecode');

      const pythonResolution = await resolveManagedPythonRuntime(
        toolState.appDir,
        manifest,
        logger,
        options.onProgress,
        toolState.id,
      );

      const previousRuntimeVersion = toolState.pythonBootstrapVersion || toolState.managedPythonVersion || null;
      const previousRuntimeSource = toolState.pythonBootstrapSource || (toolState.managedPythonVersion ? 'managed' : null);
      runtimeChanged =
        previousRuntimeVersion !== pythonResolution.runtime.versionString ||
        previousRuntimeSource !== pythonResolution.runtime.source;
      if (toolState.venvDir) {
        await fs.remove(toolState.venvDir).catch(() => null);
      }

      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 55,
        stage: 'repairing',
        message: 'Rebuilding the tool environment.',
      });

      const rebuiltState = createManagedToolState(
        manifest,
        toolState.installDir,
        toolState.appDir,
        toolState.venvDir,
        toolState.downloadCachePath,
        pythonResolution,
      );

      await installPythonDependencies(
        rebuiltState,
        manifest,
        options.onProgress,
        logger,
        pythonResolution.runtime,
      );

      Object.assign(toolState, rebuiltState);
      repairNotes.push(
        pythonResolution.runtime.source === 'system'
          ? `recreated the virtual environment with Python ${pythonResolution.runtime.versionString} already installed on this PC`
          : runtimeChanged
            ? `recreated the virtual environment with Python ${pythonResolution.runtime.versionString}`
            : 'recreated the virtual environment',
      );
    }

    const updatedState = {
      ...toolState,
      source: 'managed',
      managedByLocalAIHub: true,
      lastError: null,
      lastRepairMessage: buildRepairOutcomeMessage(manifest.name, repairNotes),
      status: 'stopped',
    };

    updatedState.launchProfile = buildManagedLaunchProfile(updatedState, manifest);
    await upsertTool(updatedState);

    await advanceStep(logger, options.onProgress, {
      toolId: toolState.id,
      percent: 100,
      stage: 'complete',
      message: updatedState.lastRepairMessage,
    });
    await logger.info('Repair completed successfully.', {
      runtimeChanged,
      cleanupSummary,
    });

    return updatedState;
  } catch (error) {
    await logger.error('Repair failed.', {
      error,
      readableMessage: humanizeError(error, `Local AI Hub could not repair ${manifest.name}.`),
    });
    throw error;
  }
}
async function uninstallTool(toolState) {
  await initializeToolRegistry();
  const manifest = getToolManifest(toolState?.id);
  if (!manifest) {
    throw new Error('Local AI Hub could not find the tool definition for uninstall.');
  }

  const logger = createLogger('installer', {
    toolId: toolState.id,
    toolName: manifest.name,
    mode: 'uninstall',
  });

  try {
    if (toolState.source === 'managed') {
      const safeToolState = ensureManagedToolStatePaths(toolState);
      await logger.info('Managed uninstall requested.', {
        installDir: safeToolState.installDir,
      });
      await fs.remove(safeToolState.installDir).catch(() => null);
      await removeTool(toolState.id);
      await setToolIgnored(toolState.id, false);
      return {
        ...toolState,
        status: 'stopped',
        lastError: null,
        uninstallMessage: `${manifest.name} was uninstalled and moved back to Store.`,
      };
    }

    await logger.info('External install was removed from Local AI Hub tracking only.', {
      installDir: toolState.installDir || null,
      displayPath: toolState.displayPath || null,
    });
    await removeTool(toolState.id);
    await setToolIgnored(toolState.id, true);
    return {
      ...toolState,
      status: 'stopped',
      lastError: null,
      uninstallMessage:
        `${manifest.name} was removed from Local AI Hub. Its files were not deleted because Local AI Hub did not install them.`,
    };
  } catch (error) {
    await logger.error('Uninstall failed.', {
      error,
      readableMessage: humanizeError(error, `Local AI Hub could not uninstall ${manifest.name}.`),
    });
    throw error;
  }
}

module.exports = {
  getToolInstallPreflight,
  inspectToolRepair,
  installTool,
  repairToolInstallation,
  uninstallTool,
};









