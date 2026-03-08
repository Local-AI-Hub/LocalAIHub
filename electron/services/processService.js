const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { shell, app } = require('electron');
const { PythonShell } = require('python-shell');

const { humanizeError, upsertTool } = require('./configService');
const { killProcessTree, runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const { attemptAutomaticLaunchRecovery } = require('./runtimeRecoveryService');

const runtimes = new Map();
const OPEN_TIMEOUT_MS = 30000;
const SUCCESS_CONFIRM_TIMEOUT_MS = 15000;
const OUTPUT_BUFFER_LIMIT = 64000;

function getHelperScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'helpers', 'launch_python_target.py')
    : path.join(__dirname, '..', 'helpers', 'launch_python_target.py');
}

function rememberRuntime(toolId, runtime) {
  runtimes.set(toolId, runtime);
  return runtime;
}

function clearRuntime(toolId, runtime = null) {
  if (!runtime || runtimes.get(toolId) === runtime) {
    runtimes.delete(toolId);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeProcessNames(processNames = []) {
  return [...new Set((processNames || []).map((name) => path.basename(String(name || '')).trim()).filter(Boolean))];
}

function getToolInterfaceMode(toolState) {
  return toolState?.interfaceMode || 'external-browser';
}

function getExpectedLocalMarkers(toolState) {
  const markers = new Set();

  const addUrlMarkers = (value) => {
    const text = String(value || '').trim();
    if (!text) {
      return;
    }

    markers.add(text.toLowerCase());

    try {
      const parsed = new URL(text);
      if (parsed.host) {
        markers.add(parsed.host.toLowerCase());
      }
      if (parsed.port) {
        markers.add(`127.0.0.1:${parsed.port}`.toLowerCase());
        markers.add(`localhost:${parsed.port}`.toLowerCase());
        markers.add(`0.0.0.0:${parsed.port}`.toLowerCase());
      }
    } catch {
      // Ignore malformed URLs and keep the raw text marker.
    }
  };

  addUrlMarkers(toolState?.launchUrl);
  addUrlMarkers(toolState?.healthUrl);

  if (toolState?.defaultPort) {
    const port = String(toolState.defaultPort).trim();
    markers.add(`127.0.0.1:${port}`.toLowerCase());
    markers.add(`localhost:${port}`.toLowerCase());
    markers.add(`0.0.0.0:${port}`.toLowerCase());
    markers.add(`:${port}`.toLowerCase());
  }

  return [...markers];
}

function lineContainsExpectedUrl(toolState, line) {
  const normalizedLine = String(line || '').toLowerCase();
  return getExpectedLocalMarkers(toolState).some((marker) => normalizedLine.includes(marker));
}

function outputContainsExpectedUrl(toolState, output) {
  return String(output || '')
    .split(/\r?\n/)
    .some((line) => lineContainsExpectedUrl(toolState, line));
}

function isInformationalLogLine(line) {
  const normalizedLine = String(line || '').trim();
  return (
    /^\[?info\]?[:\s]/i.test(normalizedLine) ||
    /^notice[:\s]/i.test(normalizedLine) ||
    /\blevel=info\b/i.test(normalizedLine) ||
    /^time=.*\blevel=info\b/i.test(normalizedLine)
  );
}

function collectMeaningfulFailureText(toolState, output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !lineContainsExpectedUrl(toolState, line))
    .filter((line) => !isInformationalLogLine(line));

  if (!lines.length) {
    return '';
  }

  return lines.slice(-30).join('\n');
}

async function probeUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
    });
    return Boolean(response);
  } catch {
    return false;
  }
}

async function waitForToolReady(toolState, timeoutMs = OPEN_TIMEOUT_MS) {
  if (!toolState?.launchUrl && !toolState?.healthUrl) {
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeUrl(toolState.healthUrl || toolState.launchUrl)) {
      return true;
    }
    await sleep(1000);
  }

  return false;
}

async function getRunningProcessNames(processNames = []) {
  const matches = [];

  for (const processName of normalizeProcessNames(processNames)) {
    const result = await runCommand('tasklist', ['/FI', `IMAGENAME eq ${processName}`, '/FO', 'CSV', '/NH'], {
      allowFailure: true,
    });
    const output = String(result.stdout || '').trim();

    if (!output || /^INFO:/i.test(output) || /^"INFO:/i.test(output)) {
      continue;
    }

    matches.push(processName);
  }

  return matches;
}

async function isToolActive(toolState) {
  if (!toolState) {
    return false;
  }

  const runtime = runtimes.get(toolState.id);
  if (runtime?.process && runtime.process.exitCode === null && !runtime.stopping) {
    return true;
  }

  if (await probeUrl(toolState.healthUrl || toolState.launchUrl)) {
    return true;
  }

  const runningProcessNames = await getRunningProcessNames(toolState.processNames);
  return runningProcessNames.length > 0;
}

async function openToolInterface(toolState) {
  if (!toolState?.launchUrl || getToolInterfaceMode(toolState) !== 'external-browser') {
    return;
  }

  await waitForToolReady(toolState, OPEN_TIMEOUT_MS);
  await shell.openExternal(toolState.launchUrl).catch(() => null);
}

function appendRuntimeOutput(runtimeState, key, chunk) {
  const content = typeof chunk === 'string' ? chunk : chunk?.toString?.() || '';
  const nextValue = `${runtimeState[key] || ''}${content}`;
  runtimeState[key] = nextValue.length > OUTPUT_BUFFER_LIMIT ? nextValue.slice(-OUTPUT_BUFFER_LIMIT) : nextValue;
}

async function confirmLaunchAfterExit(toolState, combinedOutput) {
  const successMarkerSeen = outputContainsExpectedUrl(toolState, combinedOutput);
  const ready = await waitForToolReady(toolState, successMarkerSeen ? SUCCESS_CONFIRM_TIMEOUT_MS : 2000);

  if (ready) {
    return {
      running: true,
      successMarkerSeen,
    };
  }

  if (successMarkerSeen) {
    const runningProcessNames = await getRunningProcessNames(toolState.processNames);
    return {
      running: runningProcessNames.length > 0,
      successMarkerSeen,
    };
  }

  return {
    running: false,
    successMarkerSeen,
  };
}

async function handleRuntimeExit(toolState, runtimeState, code, signal, runtimeOptions = {}) {
  if (!runtimeState || runtimeState.exitHandled) {
    return;
  }

  runtimeState.exitHandled = true;
  clearRuntime(toolState.id, runtimeState);

  if (runtimeState.stopping) {
    await upsertTool({
      id: toolState.id,
      status: 'stopped',
      lastError: null,
    });
    return;
  }

  const combinedOutput = `${runtimeState.stdoutBuffer || ''}\n${runtimeState.stderrBuffer || ''}`.trim();
  const launchState = await confirmLaunchAfterExit(toolState, combinedOutput);
  if (launchState.running) {
    await upsertTool({
      id: toolState.id,
      status: 'running',
      lastError: null,
    });
    return;
  }

  const isClean = code === 0 || signal === 'SIGTERM';
  if (isClean) {
    await upsertTool({
      id: toolState.id,
      status: 'stopped',
      lastError: null,
    });
    return;
  }

  const logger = createLogger('launch', {
    toolId: toolState.id,
    toolName: toolState.name,
    exitCode: code,
    signal,
  });

  const failureText = collectMeaningfulFailureText(toolState, combinedOutput);
  const recoveryResult = runtimeOptions.autoRecoveryAttempted
    ? { handled: false, recovered: false, userMessage: null }
    : await attemptAutomaticLaunchRecovery(toolState, failureText || '', {
        logger,
        retryLaunch: async (nextToolState) => {
          await launchTool(nextToolState, {
            autoRecoveryAttempted: true,
          });
        },
      });

  if (recoveryResult?.recovered) {
    return;
  }

  let message = recoveryResult?.userMessage;
  if (!message && launchState.successMarkerSeen) {
    const target = toolState.launchUrl || `http://127.0.0.1:${toolState.defaultPort}`;
    message = `${toolState.name} reported ${target}, but Local AI Hub could not keep it reachable after the launch process exited. Open the logs folder for the full launch output.`;
  }

  if (!message) {
    message = humanizeError(
      failureText || `${toolState.name} stopped unexpectedly.`,
      `${toolState.name} stopped unexpectedly.`,
    );
  }

  await upsertTool({
    id: toolState.id,
    status: 'error',
    lastError: message,
  });
}

function attachRuntimeHandlers(toolState, runtimeState, runtimeOptions = {}) {
  const child = runtimeState.process;

  child.stdout?.on('data', (chunk) => {
    appendRuntimeOutput(runtimeState, 'stdoutBuffer', chunk);
  });

  child.stderr?.on('data', (chunk) => {
    appendRuntimeOutput(runtimeState, 'stderrBuffer', chunk);
  });

  child.on('close', (code, signal) => {
    handleRuntimeExit(toolState, runtimeState, code, signal, runtimeOptions).catch(() => null);
  });

  child.on('error', (error) => {
    appendRuntimeOutput(runtimeState, 'stderrBuffer', error?.message || String(error));
    handleRuntimeExit(toolState, runtimeState, 1, null, runtimeOptions).catch(() => null);
  });

  return runtimeState;
}

async function launchPythonProfile(toolState, launchProfile, runtimeOptions = {}) {
  if (!(await fs.pathExists(launchProfile.pythonPath))) {
    throw new Error(`${toolState.name} is missing its Python launcher. Run Repair or reinstall it.`);
  }

  const helperScript = getHelperScriptPath();
  if (!(await fs.pathExists(helperScript))) {
    throw new Error('Local AI Hub is missing its Python launcher helper. Reinstall the app to restore it.');
  }

  const shellInstance = new PythonShell(path.basename(helperScript), {
    pythonPath: launchProfile.pythonPath,
    scriptPath: path.dirname(helperScript),
    pythonOptions: ['-u'],
    args: [
      launchProfile.workingDir,
      launchProfile.kind === 'python-module' ? 'module' : 'script',
      launchProfile.target,
      ...(launchProfile.args || []),
    ],
    env: {
      ...process.env,
      NESTAI_TOOL_ID: toolState.id,
    },
  });

  if (!shellInstance.childProcess) {
    throw new Error(`${toolState.name} did not return a Python process handle.`);
  }

  const runtimeState = rememberRuntime(toolState.id, {
    kind: 'python',
    process: shellInstance.childProcess,
    shell: shellInstance,
    stdoutBuffer: '',
    stderrBuffer: '',
    stopping: false,
    exitHandled: false,
  });

  attachRuntimeHandlers(toolState, runtimeState, runtimeOptions);
}

async function launchBinaryProfile(toolState, launchProfile, runtimeOptions = {}) {
  if (!(await fs.pathExists(launchProfile.executable))) {
    throw new Error(`${toolState.name} is missing its launcher executable. Run Repair or reinstall it.`);
  }

  const child = spawn(launchProfile.executable, launchProfile.args || [], {
    cwd: launchProfile.workingDir || path.dirname(launchProfile.executable),
    windowsHide: true,
    env: process.env,
  });

  const runtimeState = rememberRuntime(toolState.id, {
    kind: 'binary',
    process: child,
    stdoutBuffer: '',
    stderrBuffer: '',
    stopping: false,
    exitHandled: false,
  });

  attachRuntimeHandlers(toolState, runtimeState, runtimeOptions);
}

async function launchBatchProfile(toolState, launchProfile, runtimeOptions = {}) {
  if (!(await fs.pathExists(launchProfile.command))) {
    throw new Error(`${toolState.name} is missing its launcher script. Open the tool folder to inspect it.`);
  }

  const child = spawn('cmd.exe', ['/c', launchProfile.command, ...(launchProfile.args || [])], {
    cwd: launchProfile.workingDir || path.dirname(launchProfile.command),
    windowsHide: true,
    env: process.env,
  });

  const runtimeState = rememberRuntime(toolState.id, {
    kind: 'batch',
    process: child,
    stdoutBuffer: '',
    stderrBuffer: '',
    stopping: false,
    exitHandled: false,
  });

  attachRuntimeHandlers(toolState, runtimeState, runtimeOptions);
}

async function resolveToolStatus(toolState) {
  if (await isToolActive(toolState)) {
    return 'running';
  }

  if (toolState?.status === 'running') {
    return 'stopped';
  }

  return toolState?.status || 'stopped';
}

async function launchTool(toolState, options = {}) {
  if (!toolState) {
    throw new Error('Local AI Hub could not find that tool in its installed list.');
  }

  const runtime = runtimes.get(toolState.id);
  if (runtime?.process && runtime.process.exitCode === null && !runtime.stopping) {
    if (!options.skipOpenInterface) {
      openToolInterface(toolState).catch(() => null);
    }
    return {
      ...toolState,
      status: 'running',
      lastError: null,
    };
  }

  if (await isToolActive(toolState)) {
    await upsertTool({
      id: toolState.id,
      status: 'running',
      lastError: null,
    });
    if (!options.skipOpenInterface) {
      openToolInterface(toolState).catch(() => null);
    }
    return {
      ...toolState,
      status: 'running',
      lastError: null,
    };
  }

  const launchProfile = toolState.launchProfile;
  if (!launchProfile) {
    throw new Error(`${toolState.name} does not have a launch profile yet.`);
  }

  if (launchProfile.kind === 'folder') {
    await shell.openPath(launchProfile.path || toolState.installDir);
    return toolState;
  }

  try {
    if (launchProfile.kind === 'python-script' || launchProfile.kind === 'python-module') {
      await launchPythonProfile(toolState, launchProfile, options);
    } else if (launchProfile.kind === 'binary') {
      await launchBinaryProfile(toolState, launchProfile, options);
    } else if (launchProfile.kind === 'batch') {
      await launchBatchProfile(toolState, launchProfile, options);
    } else {
      throw new Error(`Local AI Hub does not know how to launch ${toolState.name}.`);
    }

    await upsertTool({
      id: toolState.id,
      status: 'running',
      lastError: null,
    });

    if (!options.skipOpenInterface) {
      openToolInterface(toolState).catch(() => null);
    }

    return {
      ...toolState,
      status: 'running',
      lastError: null,
    };
  } catch (error) {
    const message = humanizeError(error, `${toolState.name} could not start.`);
    await upsertTool({
      id: toolState.id,
      status: 'error',
      lastError: message,
    });
    throw new Error(message);
  }
}

async function stopNamedProcesses(processNames = []) {
  const runningProcessNames = await getRunningProcessNames(processNames);

  await Promise.all(
    runningProcessNames.map((processName) =>
      runCommand('taskkill', ['/IM', processName, '/T', '/F'], {
        allowFailure: true,
      }),
    ),
  );

  return runningProcessNames;
}

async function stopTool(toolState) {
  const runtime = runtimes.get(toolState.id);
  if (runtime?.process?.pid) {
    runtime.stopping = true;
    await killProcessTree(runtime.process.pid);
    clearRuntime(toolState.id, runtime);
    await upsertTool({
      id: toolState.id,
      status: 'stopped',
      lastError: null,
    });
    return;
  }

  const stoppedProcessNames = await stopNamedProcesses(toolState.processNames);
  if (stoppedProcessNames.length > 0) {
    await upsertTool({
      id: toolState.id,
      status: 'stopped',
      lastError: null,
    });
    return;
  }

  if (await probeUrl(toolState.healthUrl || toolState.launchUrl)) {
    throw new Error(
      `Local AI Hub cannot safely stop ${toolState.name} because it did not start this process itself. Close it from its own window or service manager.`,
    );
  }

  await upsertTool({
    id: toolState.id,
    status: 'stopped',
    lastError: null,
  });
}

async function disposeAllRuntimes() {
  await Promise.all(
    [...runtimes.values()].map(async (runtime) => {
      runtime.stopping = true;
      await killProcessTree(runtime.process?.pid).catch(() => null);
    }),
  );
  runtimes.clear();
}

function getRunningToolIds() {
  return new Set(runtimes.keys());
}

module.exports = {
  disposeAllRuntimes,
  getRunningToolIds,
  isToolActive,
  launchTool,
  resolveToolStatus,
  stopTool,
};


