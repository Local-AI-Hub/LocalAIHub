const path = require('path');
const fs = require('fs-extra');
const { open } = require('node:fs/promises');
const extract = require('extract-zip');

const { getAppPaths, humanizeError, upsertTool } = require('./configService');
const { resolvePythonCommand, runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const { detectPythonRequirement, describePythonRequirement } = require('./pythonRequirementService');
const { ensureManagedPythonRuntime } = require('./pythonRuntimeService');
const { buildManagedLaunchProfile, getToolManifest, initializeToolRegistry } = require('./toolRegistry');

const DOWNLOAD_TIMEOUT_MS = 30000;
const MIN_CACHE_BYTES = 1024;

function getToolRuntime(manifest) {
  return manifest.installInstructions.runtime;
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
        'User-Agent': 'NestAI/0.1.0',
      },
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('NestAI could not reach the download server. Check your internet connection and try again.');
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
    throw new Error('NestAI could not download the installer package.');
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
      throw new Error('NestAI could not unpack the installer package. The cached download was replaced, so try Install again.');
    }
  }
}

async function installPythonDependencies(toolState, manifest, onProgress, logger, pythonRuntime) {
  const python = pythonRuntime || (await resolvePythonCommand());
  const pythonPath = path.join(toolState.venvDir, 'Scripts', 'python.exe');

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
      errorMessage: 'NestAI could not create the Python virtual environment.',
    });
  } else {
    await runCommand(python.launcher, [...python.launcherArgs, '-m', 'venv', toolState.venvDir], {
      cwd: toolState.appDir,
      errorMessage: 'NestAI could not create the Python virtual environment.',
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
    errorMessage: 'NestAI could not update pip in the tool environment.',
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
      const requirementsPath = path.join(toolState.appDir, instruction.value);
      if (!(await fs.pathExists(requirementsPath))) {
        await logger.warn('Skipping missing requirements file.', {
          requirementsPath,
        });
        continue;
      }
      installTarget = requirementsPath;
      args = [...args, '-r', requirementsPath];
    } else {
      installTarget = path.resolve(toolState.appDir, instruction.value);
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
      errorMessage: `NestAI could not install ${manifest.name} dependencies.`,
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
    managedByNestAI: true,
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
  return toolState;
}

async function installTool(toolId, options = {}) {
  const manifest = getToolManifest(toolId);
  if (!manifest) {
    throw new Error('NestAI does not recognize that tool.');
  }

  const logger = createLogger('installer', {
    toolId,
    toolName: manifest.name,
  });

  try {
    const { downloadsRoot, toolsRoot } = getAppPaths();
    const installDir = path.join(toolsRoot, manifest.id);
    const appDir = path.join(installDir, 'app');
    const venvDir = path.join(installDir, manifest.installInstructions.venvFolder || '.venv');
    const archivePath = path.join(downloadsRoot, manifest.id, manifest.installInstructions.archiveName);

    await logger.info('Install requested.', {
      installDir,
      archivePath,
      logsPath: await logger.getFilePath(),
    });

    await advanceStep(logger, options.onProgress, {
      toolId,
      percent: 5,
      stage: 'preparing',
      message: `Preparing ${manifest.name}.`,
    });

    await fs.ensureDir(installDir);

    const hasCachedArchive = await hasUsableArchiveCache(archivePath, logger);
    if (!hasCachedArchive) {
      await downloadFile(manifest.downloadUrl, archivePath, options.onProgress, logger, toolId);
    } else {
      await advanceStep(
        logger,
        options.onProgress,
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
    }

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
      message: `${manifest.name} is being registered in NestAI.`,
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

    return toolState;
  } catch (error) {
    await logger.error('Install failed.', {
      error,
      readableMessage: humanizeError(error, `NestAI could not install ${manifest.name}.`),
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
    throw new Error('NestAI could not find the tool definition for repair.');
  }

  const logger = createLogger('installer', {
    toolId: toolState.id,
    toolName: manifest.name,
    mode: 'repair',
  });

  try {
    if (!toolState.downloadCachePath || !(await fs.pathExists(toolState.downloadCachePath))) {
      throw new Error('NestAI could not find the cached installer files. Reinstall the tool instead.');
    }

    await logger.info('Repair requested.', {
      installDir: toolState.installDir,
      archivePath: toolState.downloadCachePath,
    });

    await advanceStep(logger, options.onProgress, {
      toolId: toolState.id,
      percent: 25,
      stage: 'repairing',
      message: 'Restoring the tool files from the cached installer.',
    });
    await extractArchive(toolState.downloadCachePath, toolState.appDir, logger);

    const repairNotes = ['restored the application files from the local cache'];
    let runtimeChanged = false;

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
      if (runtimeChanged && toolState.venvDir) {
        await fs.remove(toolState.venvDir).catch(() => null);
        repairNotes.push(`switched the environment to Python ${pythonResolution.runtime.versionString}`);
      }

      if (runtimeChanged || !(await fs.pathExists(toolState.venvDir))) {
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
        repairNotes.push('recreated the virtual environment');
      }
    }

    const updatedState = {
      ...toolState,
      source: 'managed',
      managedByNestAI: true,
      lastError: null,
      lastRepairMessage: `NestAI repaired ${manifest.name}: ${repairNotes.join(', ')}.`,
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
      readableMessage: humanizeError(error, `NestAI could not repair ${manifest.name}.`),
    });
    throw error;
  }
}

module.exports = {
  installTool,
  repairToolInstallation,
};

