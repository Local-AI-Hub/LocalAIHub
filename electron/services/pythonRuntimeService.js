const path = require('path');
const fs = require('fs-extra');
const { open } = require('node:fs/promises');

const { ensureStorage, getAppPaths } = require('./configService');
const { inspectPythonExecutable, runCommand } = require('./commandService');
const { isCompatibleRuntime, requirementToLabel } = require('./pythonRequirementService');

const PYTHON_RUNTIME_CATALOG = [
  {
    version: [3, 10, 19],
    versionString: '3.10.19',
    installerFileName: 'python-3.10.19-amd64.exe',
    installerUrl: 'https://www.python.org/ftp/python/3.10.19/python-3.10.19-amd64.exe',
  },
  {
    version: [3, 11, 14],
    versionString: '3.11.14',
    installerFileName: 'python-3.11.14-amd64.exe',
    installerUrl: 'https://www.python.org/ftp/python/3.11.14/python-3.11.14-amd64.exe',
  },
  {
    version: [3, 12, 12],
    versionString: '3.12.12',
    installerFileName: 'python-3.12.12-amd64.exe',
    installerUrl: 'https://www.python.org/ftp/python/3.12.12/python-3.12.12-amd64.exe',
  },
  {
    version: [3, 13, 12],
    versionString: '3.13.12',
    installerFileName: 'python-3.13.12-amd64.exe',
    installerUrl: 'https://www.python.org/ftp/python/3.13.12/python-3.13.12-amd64.exe',
  },
];

const DOWNLOAD_TIMEOUT_MS = 30000;
const MIN_INSTALLER_BYTES = 2 * 1024 * 1024;

function reportProgress(callback, payload) {
  if (typeof callback === 'function') {
    callback(payload);
  }
}

async function advance(logger, onProgress, payload, context = {}) {
  await logger.info(payload.message, {
    stage: payload.stage,
    percent: payload.percent,
    ...context,
  });
  reportProgress(onProgress, payload);
}

function selectManagedRuntime(requirement) {
  const compatible = PYTHON_RUNTIME_CATALOG.filter((runtime) => isCompatibleRuntime(runtime, requirement));
  if (compatible.length === 0) {
    throw new Error(
      `NestAI could not find a managed Python runtime that matches ${requirementToLabel(requirement)}.`,
    );
  }

  return compatible[compatible.length - 1];
}

async function fetchWithTimeout(url, logger) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    await logger.info('Connecting to the official Python download.', {
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
      throw new Error('NestAI could not reach python.org to download the required runtime.');
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function hasUsableInstaller(installerPath, logger) {
  if (!(await fs.pathExists(installerPath))) {
    return false;
  }

  const stats = await fs.stat(installerPath);
  if (stats.size < MIN_INSTALLER_BYTES) {
    await logger.warn('Discarding incomplete Python installer cache.', {
      installerPath,
      sizeBytes: stats.size,
    });
    await fs.remove(installerPath);
    return false;
  }

  await logger.info('Using cached Python installer.', {
    installerPath,
    sizeBytes: stats.size,
  });
  return true;
}

async function downloadPythonInstaller(runtime, installerPath, logger, onProgress, toolId, toolName) {
  await advance(logger, onProgress, {
    toolId,
    percent: 54,
    stage: 'runtime',
    message: `Downloading Python ${runtime.versionString} for ${toolName}.`,
  }, {
    installerUrl: runtime.installerUrl,
  });

  const response = await fetchWithTimeout(runtime.installerUrl, logger);
  if (!response.ok || !response.body) {
    throw new Error('NestAI could not download the required Python runtime from python.org.');
  }

  await fs.ensureDir(path.dirname(installerPath));
  const fileHandle = await open(installerPath, 'w');
  const reader = response.body.getReader();
  const total = Number(response.headers.get('content-length')) || 0;
  let downloaded = 0;
  let nextLogThreshold = 25;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      downloaded += chunk.length;
      await fileHandle.write(chunk, 0, chunk.length);

      if (total > 0) {
        const percent = Math.min(60, 54 + Math.round((downloaded / total) * 6));
        reportProgress(onProgress, {
          toolId,
          percent,
          stage: 'runtime',
          message: `Downloading Python ${runtime.versionString} for ${toolName}.`,
        });

        const percentComplete = Math.round((downloaded / total) * 100);
        if (percentComplete >= nextLogThreshold) {
          await logger.info('Python runtime download progress.', {
            runtimeVersion: runtime.versionString,
            downloadedBytes: downloaded,
            totalBytes: total,
            progressPercent: percentComplete,
          });
          nextLogThreshold += 25;
        }
      }
    }
  } catch (error) {
    await logger.error('Python runtime download failed.', {
      runtimeVersion: runtime.versionString,
      installerPath,
      error,
    });
    await fs.remove(installerPath).catch(() => null);
    throw error;
  } finally {
    await fileHandle.close().catch(() => null);
  }

  await logger.info('Python runtime download completed.', {
    runtimeVersion: runtime.versionString,
    installerPath,
    totalBytes: downloaded,
  });
}

async function verifyManagedRuntime(runtime, installDir, logger) {
  const pythonPath = path.join(installDir, 'python.exe');
  if (!(await fs.pathExists(pythonPath))) {
    return null;
  }

  try {
    const metadata = await inspectPythonExecutable(pythonPath);
    const detected = {
      installDir,
      pythonPath,
      version: metadata.version,
      versionString: metadata.versionString,
    };

    if (!isCompatibleRuntime(detected, { kind: 'specifier', specifier: `==${runtime.versionString}` })) {
      await logger.warn('Managed Python runtime exists but its version does not match the requested runtime.', {
        expectedVersion: runtime.versionString,
        detectedVersion: metadata.versionString,
        installDir,
      });
      return null;
    }

    await logger.info('Managed Python runtime is ready.', {
      version: metadata.versionString,
      pythonPath,
    });
    return {
      ...runtime,
      installDir,
      pythonPath,
    };
  } catch (error) {
    await logger.warn('Managed Python runtime inspection failed. NestAI will reinstall it.', {
      installDir,
      error,
    });
    return null;
  }
}

async function installManagedRuntime(runtime, installDir, installerPath, logger, onProgress, toolId, toolName) {
  await advance(logger, onProgress, {
    toolId,
    percent: 61,
    stage: 'runtime',
    message: `Installing Python ${runtime.versionString} into NestAI.`,
  }, {
    installDir,
    installerPath,
  });

  await fs.ensureDir(path.dirname(installDir));
  await fs.remove(installDir).catch(() => null);

  const args = [
    '/quiet',
    'InstallAllUsers=0',
    `TargetDir=${installDir}`,
    'AssociateFiles=0',
    'PrependPath=0',
    'AppendPath=0',
    'Shortcuts=0',
    'Include_launcher=0',
    'InstallLauncherAllUsers=0',
    'Include_test=0',
    'Include_pip=1',
    'SimpleInstall=1',
  ];

  await runCommand(installerPath, args, {
    errorMessage: 'NestAI could not install the required Python runtime.',
  });

  const verified = await verifyManagedRuntime(runtime, installDir, logger);
  if (!verified) {
    throw new Error('NestAI installed Python, but the managed runtime did not pass verification.');
  }

  await logger.info('Managed Python runtime installation completed.', {
    runtimeVersion: runtime.versionString,
    installDir,
  });

  await advance(logger, onProgress, {
    toolId,
    percent: 64,
    stage: 'runtime',
    message: `Python ${runtime.versionString} is ready for ${toolName}.`,
  });

  return verified;
}

async function ensureManagedPythonRuntime(requirement, options) {
  const runtime = selectManagedRuntime(requirement);
  const { downloadsRoot, root } = getAppPaths();
  const installDir = path.join(root, 'runtimes', 'python', runtime.versionString);
  const installerPath = path.join(downloadsRoot, 'python', runtime.installerFileName);

  await options.logger.info('Selected managed Python runtime.', {
    runtimeVersion: runtime.versionString,
    toolId: options.toolId,
  });

  const existing = await verifyManagedRuntime(runtime, installDir, options.logger);
  if (existing) {
    reportProgress(options.onProgress, {
      toolId: options.toolId,
      percent: 64,
      stage: 'runtime',
      message: `Using NestAI-managed Python ${runtime.versionString}.`,
    });
    return existing;
  }

  if (!(await hasUsableInstaller(installerPath, options.logger))) {
    await downloadPythonInstaller(runtime, installerPath, options.logger, options.onProgress, options.toolId, options.toolName);
  } else {
    await advance(options.logger, options.onProgress, {
      toolId: options.toolId,
      percent: 58,
      stage: 'runtime',
      message: `Using the cached Python ${runtime.versionString} installer.`,
    }, {
      installerPath,
    });
  }

  return installManagedRuntime(runtime, installDir, installerPath, options.logger, options.onProgress, options.toolId, options.toolName);
}

module.exports = {
  PYTHON_RUNTIME_CATALOG,
  ensureManagedPythonRuntime,
  selectManagedRuntime,
};
