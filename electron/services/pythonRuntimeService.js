const path = require('path');
const fs = require('fs-extra');
const { open } = require('node:fs/promises');

const { version: APP_VERSION } = require('../../package.json');

const { getAppPaths } = require('./configService');
const { inspectPythonExecutable, resolvePythonCommand, runCommand } = require('./commandService');
const { isCompatibleRuntime, requirementToLabel } = require('./pythonRequirementService');

// Keep this catalog on python.org releases that still ship standalone Windows installers.
const PYTHON_RUNTIME_CATALOG = [
  {
    version: [3, 10, 11],
    versionString: '3.10.11',
    installerFileName: 'python-3.10.11-amd64.exe',
    installerUrl: 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe',
  },
  {
    version: [3, 11, 9],
    versionString: '3.11.9',
    installerFileName: 'python-3.11.9-amd64.exe',
    installerUrl: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe',
  },
  {
    version: [3, 12, 10],
    versionString: '3.12.10',
    installerFileName: 'python-3.12.10-amd64.exe',
    installerUrl: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe',
  },
];

const DOWNLOAD_TIMEOUT_MS = 30000;
const MIN_INSTALLER_BYTES = 2 * 1024 * 1024;
const RUNTIME_VERIFY_TIMEOUT_MS = 180000;
const RUNTIME_VERIFY_POLL_MS = 3000;
const MANAGED_RUNTIME_SEARCH_DEPTH = 4;
const POST_INSTALL_STABILIZATION_MS = 1500;

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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function selectManagedRuntime(requirement) {
  const compatible = PYTHON_RUNTIME_CATALOG.filter((runtime) => isCompatibleRuntime(runtime, requirement));
  if (compatible.length === 0) {
    throw new Error(
      `Local AI Hub could not find a managed Python runtime with a Windows installer that matches ${requirementToLabel(requirement)}.`,
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
        'User-Agent': `LocalAIHub/${APP_VERSION}`,
      },
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Local AI Hub could not reach python.org to download the required runtime.');
    }

    await logger.warn('Python runtime download connection failed before the installer started downloading.', {
      url,
      error,
    });
    throw new Error('Local AI Hub could not connect to python.org to download the required runtime.');
  } finally {
    clearTimeout(timer);
  }
}

function buildDownloadFailureMessage(runtime, response) {
  const status = Number(response?.status || 0);

  if (status === 404 || status === 410) {
    return `Local AI Hub could not find the Windows installer for Python ${runtime.versionString} on python.org.`;
  }

  if (status === 403) {
    return `Local AI Hub could not download Python ${runtime.versionString} because python.org refused the request.`;
  }

  if (status >= 500) {
    return `Local AI Hub could not download Python ${runtime.versionString} because python.org is unavailable right now.`;
  }

  return `Local AI Hub could not download Python ${runtime.versionString} from python.org.`;
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
  if (!response.ok) {
    await logger.warn('python.org did not return a downloadable Python installer.', {
      runtimeVersion: runtime.versionString,
      installerUrl: runtime.installerUrl,
      status: response.status,
      statusText: response.statusText,
    });
    throw new Error(buildDownloadFailureMessage(runtime, response));
  }

  if (!response.body) {
    await logger.warn('python.org responded to the Python installer request without a response body.', {
      runtimeVersion: runtime.versionString,
      installerUrl: runtime.installerUrl,
      status: response.status,
      statusText: response.statusText,
    });
    throw new Error(`Local AI Hub reached python.org for Python ${runtime.versionString}, but the installer file did not start downloading.`);
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

  if (downloaded < MIN_INSTALLER_BYTES) {
    await logger.warn('Downloaded Python installer was too small to be usable.', {
      runtimeVersion: runtime.versionString,
      installerPath,
      totalBytes: downloaded,
      minimumBytes: MIN_INSTALLER_BYTES,
    });
    await fs.remove(installerPath).catch(() => null);
    throw new Error(`Local AI Hub downloaded Python ${runtime.versionString}, but the installer file was incomplete.`);
  }

  await logger.info('Python runtime download completed.', {
    runtimeVersion: runtime.versionString,
    installerPath,
    totalBytes: downloaded,
  });
}

function buildMinorCompatibleRequirement(runtime) {
  const major = runtime.version?.[0] || 3;
  const minor = runtime.version?.[1] || 0;
  return {
    kind: 'specifier',
    specifier: `>=${major}.${minor},<${major}.${minor + 1}`,
  };
}

function versionsShareMajorMinor(left = [], right = []) {
  return Number(left[0]) === Number(right[0]) && Number(left[1]) === Number(right[1]);
}

function buildRuntimeMajorMinorTag(runtime) {
  const major = Number(runtime?.version?.[0] || 3);
  const minor = Number(runtime?.version?.[1] || 0);
  return `${major}${minor}`;
}

function uniqueResolvedPaths(values = []) {
  const seen = new Set();
  const results = [];

  for (const value of values) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      continue;
    }

    const resolvedValue = path.resolve(normalizedValue);
    const normalizedKey = resolvedValue.toLowerCase();
    if (seen.has(normalizedKey)) {
      continue;
    }

    seen.add(normalizedKey);
    results.push(resolvedValue);
  }

  return results;
}

function getManagedRuntimeCandidateRoots(installDir, runtime) {
  const parentDir = path.dirname(installDir);
  const versionTag = runtime?.versionString || '';
  const majorMinorTag = buildRuntimeMajorMinorTag(runtime);
  const dottedMajorMinor = runtime?.version?.length >= 2 ? `${runtime.version[0]}.${runtime.version[1]}` : '';
  const compactVersionTag = versionTag.replace(/[^0-9]/g, '');

  return uniqueResolvedPaths([
    installDir,
    path.join(installDir, 'python'),
    path.join(installDir, 'Python'),
    path.join(installDir, `Python${majorMinorTag}`),
    path.join(installDir, `python${majorMinorTag}`),
    path.join(parentDir, versionTag),
    path.join(parentDir, compactVersionTag),
    path.join(parentDir, `Python${majorMinorTag}`),
    path.join(parentDir, `python${majorMinorTag}`),
    dottedMajorMinor ? path.join(parentDir, `Python ${dottedMajorMinor}`) : null,
    versionTag ? path.join(parentDir, `Python-${versionTag}`) : null,
    versionTag ? path.join(parentDir, `python-${versionTag}`) : null,
  ]);
}

async function collectManagedPythonCandidates(installDir, runtime) {
  const seen = new Set();
  const results = [];
  const candidateRoots = getManagedRuntimeCandidateRoots(installDir, runtime);

  const addCandidate = async (candidatePath) => {
    if (!candidatePath) {
      return;
    }

    const normalizedKey = path.resolve(candidatePath).toLowerCase();
    if (seen.has(normalizedKey)) {
      return;
    }

    seen.add(normalizedKey);
    try {
      const stats = await fs.stat(candidatePath);
      if (stats.isFile() && path.basename(candidatePath).toLowerCase() === 'python.exe') {
        results.push(candidatePath);
      }
    } catch {
      return;
    }
  };

  const walk = async (directory, depthRemaining) => {
    if (depthRemaining < 0 || !(await fs.pathExists(directory))) {
      return;
    }

    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'python.exe') {
        await addCandidate(entryPath);
        continue;
      }

      if (entry.isDirectory()) {
        await walk(entryPath, depthRemaining - 1);
      }
    }
  };

  for (const root of candidateRoots) {
    await addCandidate(path.join(root, 'python.exe'));
    await addCandidate(path.join(root, 'Scripts', 'python.exe'));
    await walk(root, MANAGED_RUNTIME_SEARCH_DEPTH);
  }

  return {
    candidateRoots,
    candidates: results,
  };
}

async function verifyManagedRuntime(runtime, installDir, logger, options = {}) {
  const { candidates, candidateRoots } = await collectManagedPythonCandidates(installDir, runtime);
  if (candidates.length === 0) {
    if (options.logMissing !== false) {
      await logger.info('Managed Python runtime was not found yet.', {
        installDir,
        candidateRoots,
        expectedVersion: runtime.versionString,
      });
    }
    return null;
  }

  const exactRequirement = {
    kind: 'specifier',
    specifier: `==${runtime.versionString}`,
  };
  const minorRequirement = buildMinorCompatibleRequirement(runtime);

  for (const pythonPath of candidates) {
    try {
      const metadata = await inspectPythonExecutable(pythonPath);
      const detected = {
        installDir,
        pythonPath,
        version: metadata.version,
        versionString: metadata.versionString,
      };

      const exactMatch = isCompatibleRuntime(detected, exactRequirement);
      const minorMatch = isCompatibleRuntime(detected, minorRequirement) || versionsShareMajorMinor(metadata.version, runtime.version);
      if (!exactMatch && !minorMatch) {
        await logger.warn('Managed Python candidate version did not match the selected runtime.', {
          expectedVersion: runtime.versionString,
          detectedVersion: metadata.versionString,
          pythonPath,
        });
        continue;
      }

      if (!exactMatch) {
        await logger.warn('Managed Python runtime matched the requested major/minor version but not the exact patch. Accepting it as compatible.', {
          expectedVersion: runtime.versionString,
          detectedVersion: metadata.versionString,
          pythonPath,
        });
      }

      await logger.info('Managed Python runtime is ready.', {
        version: metadata.versionString,
        pythonPath,
      });
      return {
        ...runtime,
        source: 'managed',
        installDir,
        pythonPath,
        version: metadata.version,
        versionString: metadata.versionString,
      };
    } catch (error) {
      await logger.warn('Managed Python runtime inspection failed for a candidate executable.', {
        installDir,
        pythonPath,
        error,
      });
    }
  }

  return null;
}

async function waitForManagedRuntime(runtime, installDir, logger) {
  const deadline = Date.now() + RUNTIME_VERIFY_TIMEOUT_MS;
  let attempt = 0;

  while (Date.now() < deadline) {
    const verified = await verifyManagedRuntime(runtime, installDir, logger, {
      logMissing: attempt === 0 || Date.now() + RUNTIME_VERIFY_POLL_MS >= deadline,
    });
    if (verified) {
      return verified;
    }

    if (attempt === 0) {
      await logger.info('Waiting for the managed Python installer to finish writing files.', {
        installDir,
        timeoutMs: RUNTIME_VERIFY_TIMEOUT_MS,
      });
    }

    attempt += 1;
    await sleep(RUNTIME_VERIFY_POLL_MS);
  }

  return null;
}

async function resolveCompatibleSystemPython(requirement, logger) {
  try {
    const systemPython = await resolvePythonCommand();
    if (!isCompatibleRuntime(systemPython, requirement)) {
      await logger.warn('A system Python installation is present, but it does not satisfy this tool\'s version requirement.', {
        executable: systemPython.executable || null,
        requirement: requirementToLabel(requirement),
        version: systemPython.versionString,
      });
      return null;
    }

    await logger.warn('Managed Python verification failed. Falling back to a compatible system Python already installed on this PC.', {
      executable: systemPython.executable || null,
      version: systemPython.versionString,
    });

    return {
      ...systemPython,
      source: 'system',
      installDir: null,
      pythonPath: systemPython.executable || null,
    };
  } catch (error) {
    await logger.warn('No compatible system Python fallback was available.', {
      error,
      requirement: requirementToLabel(requirement),
    });
    return null;
  }
}

async function installManagedRuntime(runtime, installDir, installerPath, logger, onProgress, toolId, toolName) {
  await advance(logger, onProgress, {
    toolId,
    percent: 61,
    stage: 'runtime',
    message: `Installing Python ${runtime.versionString} into Local AI Hub.`,
  }, {
    installDir,
    installerPath,
  });

  await fs.ensureDir(path.dirname(installDir));
  await fs.remove(installDir).catch(() => null);
  await fs.ensureDir(installDir);

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
    errorMessage: 'Local AI Hub could not install the required Python runtime.',
  });

  await logger.info('The managed Python installer process exited. Starting runtime verification.', {
    installDir,
    installerPath,
    targetVersion: runtime.versionString,
  });

  await sleep(POST_INSTALL_STABILIZATION_MS);

  const verified = await waitForManagedRuntime(runtime, installDir, logger);
  if (!verified) {
    throw new Error('Local AI Hub installed Python, but the managed runtime did not appear in time for verification.');
  }

  await logger.info('Managed Python runtime installation completed.', {
    runtimeVersion: verified.versionString,
    installDir,
    pythonPath: verified.pythonPath,
  });

  await advance(logger, onProgress, {
    toolId,
    percent: 64,
    stage: 'runtime',
    message: `Python ${verified.versionString} is ready for ${toolName}.`,
  });

  return verified;
}

async function ensureManagedPythonRuntime(requirement, options) {
  const runtime = selectManagedRuntime(requirement);
  const { downloadsRoot, runtimesRoot } = getAppPaths();
  const installDir = path.join(runtimesRoot, 'python', runtime.versionString);
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
      message: `Using Local AI Hub-managed Python ${existing.versionString}.`,
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

  let installError = null;
  try {
    return await installManagedRuntime(runtime, installDir, installerPath, options.logger, options.onProgress, options.toolId, options.toolName);
  } catch (error) {
    installError = error;
    await options.logger.warn('Managed Python runtime installation did not verify cleanly.', {
      error,
      installerPath,
      installDir,
      runtimeVersion: runtime.versionString,
    });
  }

  const systemFallback = await resolveCompatibleSystemPython(requirement, options.logger);
  if (systemFallback) {
    await advance(options.logger, options.onProgress, {
      toolId: options.toolId,
      percent: 64,
      stage: 'runtime',
      message: `Using Python ${systemFallback.versionString} already installed on this PC.`,
    }, {
      executable: systemFallback.executable || systemFallback.pythonPath || null,
      source: 'system-python-fallback',
    });
    return systemFallback;
  }

  throw installError;
}

module.exports = {
  PYTHON_RUNTIME_CATALOG,
  ensureManagedPythonRuntime,
  selectManagedRuntime,
};

