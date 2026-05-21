const { spawn } = require('child_process');

const PYTHON_METADATA_SNIPPET =
  'import json, platform, sys; print(json.dumps({"executable": sys.executable, "version": list(sys.version_info[:3]), "versionString": platform.python_version()}))';

function firstNonEmptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function compareVersions(left = [], right = []) {
  for (let index = 0; index < Math.max(left.length, right.length, 3); index += 1) {
    const leftPart = left[index] || 0;
    const rightPart = right[index] || 0;

    if (leftPart > rightPart) {
      return 1;
    }

    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

function formatVersion(version) {
  if (Array.isArray(version)) {
    return version.join('.');
  }

  return String(version || 'unknown');
}

function terminateChildProcess(child) {
  if (!child?.pid) {
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // The process may already be gone.
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
      });
      killer.on('error', () => {});
    } catch {
      // Best effort cleanup only.
    }
  }
}

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutTimer = null;
    let abortHandler = null;
    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (abortHandler && options.signal?.removeEventListener) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      abortHandler = null;
    };
    const finalizeResolve = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(value);
    };
    const finalizeReject = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    let stdout = '';
    let stderr = '';
    let child;

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.replaceEnv ? (options.env || {}) : {
          ...process.env,
          ...(options.env || {}),
        },
        windowsHide: true,
        shell: Boolean(options.shell),
      });
    } catch (error) {
      if (options.allowFailure) {
        finalizeResolve({
          code: 1,
          stdout,
          stderr: stderr || error?.message || String(error),
        });
        return;
      }

      finalizeReject(error);
      return;
    }

    const finishInterrupted = (message, codeValue) => {
      terminateChildProcess(child);
      if (options.allowFailure) {
        finalizeResolve({
          code: codeValue,
          stdout,
          stderr: stderr || message,
        });
        return;
      }

      const failure = new Error(message);
      failure.code = codeValue;
      failure.stdout = stdout;
      failure.stderr = stderr || message;
      finalizeReject(failure);
    };

    const timeoutMs = Number(options.timeoutMs || 0);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        finishInterrupted(options.timeoutMessage || `${command} took too long and was stopped.`, 'ETIMEDOUT');
      }, timeoutMs);
    }

    if (options.signal?.aborted) {
      finishInterrupted(options.abortMessage || `${command} was cancelled.`, 'ABORT_ERR');
      return;
    }

    if (options.signal?.addEventListener) {
      abortHandler = () => {
        finishInterrupted(options.abortMessage || `${command} was cancelled.`, 'ABORT_ERR');
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (options.allowFailure) {
        finalizeResolve({
          code: 1,
          stdout,
          stderr: stderr || error?.message || String(error),
        });
        return;
      }

      finalizeReject(error);
    });

    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) {
        finalizeResolve({ code, stdout, stderr });
        return;
      }

      const failure = new Error(options.errorMessage || firstNonEmptyLine(stderr) || `${command} failed.`);
      failure.code = code;
      failure.stdout = stdout;
      failure.stderr = stderr;
      finalizeReject(failure);
    });
  });
}

function parsePythonMetadata(stdout) {
  const lastLine = String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find(Boolean);

  if (!lastLine) {
    throw new Error('Local AI Hub could not read the Python version.');
  }

  const metadata = JSON.parse(lastLine);
  return {
    executable: metadata.executable,
    version: metadata.version,
    versionString: metadata.versionString || formatVersion(metadata.version),
  };
}

async function probePython(launcher, launcherArgs = []) {
  const result = await runCommand(launcher, [...launcherArgs, '-c', PYTHON_METADATA_SNIPPET]);
  const metadata = parsePythonMetadata(result.stdout);
  return {
    launcher,
    launcherArgs,
    executable: metadata.executable,
    version: metadata.version,
    versionString: metadata.versionString,
  };
}

async function inspectPythonCommand() {
  try {
    return await probePython('py', ['-3']);
  } catch {
    try {
      return await probePython('python', []);
    } catch {
      throw new Error('Python 3 was not found. Install a compatible Python version, then try again.');
    }
  }
}

async function inspectPythonExecutable(executablePath) {
  const result = await runCommand(executablePath, ['-c', PYTHON_METADATA_SNIPPET], {
    errorMessage: 'Local AI Hub could not inspect the managed Python runtime.',
  });
  return parsePythonMetadata(result.stdout);
}

async function resolvePythonCommand() {
  return inspectPythonCommand();
}

async function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  await runCommand('taskkill', ['/pid', String(pid), '/t', '/f'], {
    allowFailure: true,
  });
}

module.exports = {
  compareVersions,
  formatVersion,
  inspectPythonCommand,
  inspectPythonExecutable,
  killProcessTree,
  resolvePythonCommand,
  runCommand,
};
