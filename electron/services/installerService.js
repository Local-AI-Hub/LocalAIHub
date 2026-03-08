const path = require('path');
const fs = require('fs-extra');
const { open } = require('node:fs/promises');
const extract = require('extract-zip');

const { version: APP_VERSION } = require('../../package.json');

const { getAppPaths, humanizeError, upsertTool } = require('./configService');
const { verifyDownloadedFileIntegrity } = require('./downloadIntegrityService');
const { resolvePythonCommand, runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const { detectPythonRequirement, describePythonRequirement } = require('./pythonRequirementService');
const { ensureManagedPythonRuntime } = require('./pythonRuntimeService');
const { syncDiscoveredTools } = require('./toolDiscoveryService');
const { buildManagedLaunchProfile, getToolManifest, initializeToolRegistry } = require('./toolRegistry');
const { assertPathInside, assertSecureRemoteUrl, resolveManagedToolPaths } = require('./pathSafetyService');

const DOWNLOAD_TIMEOUT_MS = 30000;
const MIN_CACHE_BYTES = 1024;

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

  const managedPaths = resolveManagedToolPaths(toolState.id, path.basename(toolState.venvDir || '.venv'));
  const installDir = assertPathInside(
    managedPaths.toolsRoot,
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
  await extract(archivePath, { dir: tempDirectory });

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
    managedPythonVersion: runtime?.versionString || null,
    managedPythonPath: runtime?.pythonPath || null,
    managedPythonInstallDir: runtime?.installDir || null,
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

  const toolState = createManagedToolState(manifest, installDir, appDir, venvDir, archivePath, null);
  if (!(await toolIsAvailable(toolState))) {
    throw new Error(`${manifest.name} finished installing, but Local AI Hub could not find its launcher files afterward.`);
  }

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
    toolState = ensureManagedToolStatePaths(toolState);
    const managedPaths = buildManagedPaths(manifest);
    toolState.downloadCachePath = managedPaths.archivePath;
    await ensureCachedDownload(manifest, toolState.downloadCachePath, logger, options.onProgress, toolState.id);

    await logger.info('Repair requested.', {
      installDir: toolState.installDir,
      archivePath: toolState.downloadCachePath,
    });

    const installKind = manifest.installInstructions.kind || 'zip';
    const repairNotes = [];
    let runtimeChanged = false;

    if (installKind === 'single-file') {
      const managedPaths = buildManagedPaths(manifest);
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
    } else {
      await advanceStep(logger, options.onProgress, {
        toolId: toolState.id,
        percent: 25,
        stage: 'repairing',
        message: 'Restoring the tool files from the cached installer.',
      });
      await extractArchive(toolState.downloadCachePath, toolState.appDir, logger);
      repairNotes.push('restored the application files from the local cache');
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

      runtimeChanged = toolState.managedPythonVersion !== pythonResolution.runtime.versionString;
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
        runtimeChanged
          ? `recreated the virtual environment with Python ${pythonResolution.runtime.versionString}`
          : 'recreated the virtual environment',
      );
    }

    const updatedState = {
      ...toolState,
      source: 'managed',
      managedByLocalAIHub: true,
      lastError: null,
      lastRepairMessage: `Local AI Hub repaired ${manifest.name}: ${repairNotes.join(', ')}.`,
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

module.exports = {
  installTool,
  repairToolInstallation,
};






























