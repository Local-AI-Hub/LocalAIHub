const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { shell, app } = require('electron');
const { PythonShell } = require('python-shell');

const { getAppPaths, humanizeError, upsertTool } = require('./configService');
const { killProcessTree, runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const { attemptAutomaticLaunchRecovery } = require('./runtimeRecoveryService');
const { assertLoopbackUrl, assertPathInside } = require('./pathSafetyService');

const runtimes = new Map();
const OPEN_TIMEOUT_MS = 30000;
const SUCCESS_CONFIRM_TIMEOUT_MS = 15000;
const OUTPUT_BUFFER_LIMIT = 64000;
const OUTPUT_LOG_LIMIT = 1024 * 1024;
const PROCESS_SHUTDOWN_WAIT_MS = 15000;
const PROCESS_RELEASE_SETTLE_MS = 1500;
const STARTUP_PENDING_GRACE_MS = 5 * 60 * 1000;
const STARTUP_DOWNLOAD_ACTIVITY_GRACE_MS = 15 * 60 * 1000;
const STARTUP_DOWNLOAD_CARRY_LIMIT = 256;
const DOWNLOAD_KEYWORD_PATTERN = /\b(download(?:ing|ed)?|fetch(?:ing|ed)?|retriev(?:e|ing|ed)?|pull(?:ing|ed)?|sync(?:ing|ed)?|cache(?:ing|d)?|checkpoint|weights?)\b/i;
const DOWNLOAD_SOURCE_PATTERN = /(https?:\/\/|huggingface|civitai|modelscope|\.safetensors\b|\.ckpt\b|\.pth\b|\.bin\b|\.onnx\b|\.gguf\b|\.pt\b)/i;
const DOWNLOAD_PROGRESS_PATTERN = /(?:^|[\s|])(\d{1,3})%(?=\s|\||$)/g;
let runtimeEventSink = null;
const pendingStartupMonitors = new Map();

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

function emitRuntimeEvent(payload) {
  if (typeof runtimeEventSink !== 'function') {
    return;
  }

  try {
    runtimeEventSink(payload);
  } catch {
    return;
  }
}

function emitToolState(toolId, patch = {}) {
  if (!toolId) {
    return;
  }

  emitRuntimeEvent({
    type: 'tool-state',
    toolId,
    status: patch.status || 'stopped',
    lastError: Object.prototype.hasOwnProperty.call(patch, 'lastError') ? patch.lastError : null,
    ...(Object.prototype.hasOwnProperty.call(patch, 'lastRepairMessage') ? { lastRepairMessage: patch.lastRepairMessage } : {}),
  });
}

function emitUnexpectedStop(toolState, message) {
  emitRuntimeEvent({
    type: 'unexpected-stop',
    toolId: toolState?.id || '',
    toolName: toolState?.name || 'This tool',
    message,
    canRelaunch: toolState?.launchSupported !== false,
  });
}

function setRuntimeEventSink(listener) {
  runtimeEventSink = typeof listener === 'function' ? listener : null;
}

function getRuntimeOutputSnapshot(toolId) {
  const runtime = runtimes.get(toolId);
  return {
    toolId,
    stdout: runtime?.stdoutBuffer || '',
    stderr: runtime?.stderrBuffer || '',
  };
}

function sendInputToTool(toolId, input, options = {}) {
  const runtime = runtimes.get(toolId);
  if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopping) {
    throw new Error('Local AI Hub could not send input because that tool is not running right now.');
  }

  if (!runtime.process.stdin || runtime.process.stdin.destroyed || !runtime.process.stdin.writable) {
    throw new Error('Local AI Hub could not send input to that tool because it does not accept console input.');
  }

  const text = String(input || '');
  if (!text.trim()) {
    throw new Error('Local AI Hub needs some text to send to that tool.');
  }

  runtime.process.stdin.write(options.appendNewline === false ? text : `${text}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildStartupDownloadMessage(toolName) {
  return `${toolName || 'This tool'} is downloading required files on first launch. This may take several minutes.`;
}

function createStartupDownloadState(toolState) {
  return {
    active: false,
    detectedAt: 0,
    detail: '',
    lastActivityAt: 0,
    lastSignature: '',
    percent: null,
    stderrCarry: '',
    stdoutCarry: '',
    toolName: toolState?.name || 'This tool',
  };
}

function normalizeProcessNames(processNames = []) {
  return [...new Set((processNames || []).map((name) => path.basename(String(name || '')).trim()).filter(Boolean))];
}

function isBareCommand(command) {
  return Boolean(command) && !path.isAbsolute(command) && !/[\\/]/.test(command);
}

function toolUsesLocalUrl(toolState) {
  return Boolean(toolState?.launchUrl || toolState?.healthUrl);
}

function getManagedToolRoot(toolState) {
  if (!toolState || !(toolState.managedByLocalAIHub || toolState.source === 'managed')) {
    return null;
  }

  const basePath = String(toolState.installDir || toolState.appDir || '').trim();
  return basePath ? path.resolve(basePath) : null;
}

function ensureManagedRuntimePath(toolState, candidatePath, label) {
  if (!candidatePath) {
    return candidatePath;
  }

  const managedRoot = getManagedToolRoot(toolState);
  if (!managedRoot) {
    return candidatePath;
  }

  return assertPathInside(
    managedRoot,
    candidatePath,
    `Local AI Hub refused to use a ${label} outside the managed tool folder.`,
  );
}

async function buildLaunchRuntimeEnv(toolState, extraEnv = {}) {
  const managedRoot = getManagedToolRoot(toolState);
  if (!managedRoot) {
    return {
      ...process.env,
      ...extraEnv,
    };
  }

  const stateRoot = path.join(managedRoot, '.localaihub');
  const cacheDir = path.join(stateRoot, 'cache');
  const tempDir = path.join(stateRoot, 'tmp');
  const pycacheDir = path.join(stateRoot, 'pycache');
  const hfCacheDir = path.join(cacheDir, 'huggingface');
  const transformersCacheDir = path.join(cacheDir, 'transformers');
  const ollamaModelsDir = toolState.id === 'ollama' ? path.join(getAppPaths().modelsRoot, 'ollama') : null;

  await Promise.all([
    fs.ensureDir(cacheDir),
    fs.ensureDir(tempDir),
    fs.ensureDir(pycacheDir),
    fs.ensureDir(hfCacheDir),
    fs.ensureDir(transformersCacheDir),
    ollamaModelsDir ? fs.ensureDir(ollamaModelsDir) : Promise.resolve(),
  ]);

  return {
    ...process.env,
    ...extraEnv,
    LOCALAIHUB_TOOL_ID: toolState.id,
    LOCALAIHUB_TOOL_ROOT: managedRoot,
    NESTAI_TOOL_ID: toolState.id,
    PIP_CACHE_DIR: cacheDir,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONPYCACHEPREFIX: pycacheDir,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    XDG_CACHE_HOME: cacheDir,
    HF_HOME: hfCacheDir,
    TRANSFORMERS_CACHE: transformersCacheDir,
    ...(ollamaModelsDir ? { OLLAMA_MODELS: ollamaModelsDir } : {}),
  };
}

function resolveLaunchProfile(toolState, launchProfile) {
  if (!launchProfile) {
    return null;
  }

  const workingDir = launchProfile.workingDir
    ? launchProfile.allowExternalWorkingDir
      ? path.resolve(launchProfile.workingDir)
      : ensureManagedRuntimePath(toolState, launchProfile.workingDir, 'working folder')
    : toolState.appDir || toolState.installDir || process.cwd();

  if (launchProfile.kind === 'python-script' || launchProfile.kind === 'python-module') {
    const pythonPath = isBareCommand(launchProfile.pythonPath)
      ? launchProfile.pythonPath
      : ensureManagedRuntimePath(toolState, launchProfile.pythonPath, 'Python launcher');
    const resolvedTarget =
      launchProfile.kind === 'python-script'
        ? ensureManagedRuntimePath(
            toolState,
            path.isAbsolute(launchProfile.target)
              ? launchProfile.target
              : path.resolve(toolState.appDir || workingDir, launchProfile.target),
            'Python script',
          )
        : launchProfile.target;

    return {
      ...launchProfile,
      pythonArgs: launchProfile.pythonArgs || [],
      pythonPath,
      target: resolvedTarget,
      workingDir,
    };
  }

  if (launchProfile.kind === 'binary') {
    const executable = ensureManagedRuntimePath(toolState, launchProfile.executable, 'launcher executable');
    return {
      ...launchProfile,
      executable,
      workingDir: workingDir || path.dirname(executable),
    };
  }

  if (launchProfile.kind === 'batch') {
    const command = ensureManagedRuntimePath(toolState, launchProfile.command, 'launcher script');
    return {
      ...launchProfile,
      command,
      workingDir: workingDir || path.dirname(command),
    };
  }

  if (launchProfile.kind === 'folder') {
    return {
      ...launchProfile,
      path: ensureManagedRuntimePath(toolState, launchProfile.path || toolState.installDir, 'tool folder'),
    };
  }

  if (launchProfile.kind === 'embedded') {
    return {
      ...launchProfile,
      workingDir,
    };
  }

  return {
    ...launchProfile,
    workingDir,
  };
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
      return;
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
    const safeUrl = assertLoopbackUrl(url, 'tool URL');
    const response = await fetch(safeUrl, {
      method: 'GET',
    });
    return Boolean(response);
  } catch {
    return false;
  }
}

async function waitForToolReady(toolState, timeoutMs = OPEN_TIMEOUT_MS, runtimeState = null) {
  if (!toolState?.launchUrl && !toolState?.healthUrl) {
    return false;
  }

  const baseDeadline = Date.now() + timeoutMs;
  while (true) {
    if (runtimeState?.stopping || runtimeState?.exitHandled) {
      return false;
    }

    if (await probeUrl(toolState.healthUrl || toolState.launchUrl)) {
      return true;
    }

    const downloadDeadline =
      runtimeState?.startupDownload?.active && Number(runtimeState.startupDownload.lastActivityAt) > 0
        ? runtimeState.startupDownload.lastActivityAt + STARTUP_DOWNLOAD_ACTIVITY_GRACE_MS
        : 0;
    const effectiveDeadline = Math.max(baseDeadline, downloadDeadline);
    if (Date.now() >= effectiveDeadline) {
      return false;
    }

    await sleep(1000);
  }
}

function getStartupTimeoutMs(toolState, fallbackMs = OPEN_TIMEOUT_MS) {
  const timeoutMs = Number(toolState?.startupTimeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }

  return fallbackMs;
}

function getPendingStartupTimeoutMs(toolState) {
  return Math.max(getStartupTimeoutMs(toolState, OPEN_TIMEOUT_MS), STARTUP_PENDING_GRACE_MS);
}

async function persistToolRuntimeState(toolState, status, extra = {}) {
  await upsertTool({
    id: toolState.id,
    status,
    lastError: Object.prototype.hasOwnProperty.call(extra, 'lastError') ? extra.lastError : null,
    lastRepairMessage: Object.prototype.hasOwnProperty.call(extra, 'lastRepairMessage') ? extra.lastRepairMessage : null,
  });

  emitToolState(toolState.id, {
    status,
    lastError: Object.prototype.hasOwnProperty.call(extra, 'lastError') ? extra.lastError : null,
    lastRepairMessage: Object.prototype.hasOwnProperty.call(extra, 'lastRepairMessage') ? extra.lastRepairMessage : null,
  });
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

  if (toolState.launchProfile?.kind === 'embedded') {
    return toolState.status === 'running';
  }

  if (await probeUrl(toolState.healthUrl || toolState.launchUrl)) {
    return true;
  }

  const runningProcessNames = await getRunningProcessNames(toolState.processNames);
  return runningProcessNames.length > 0;
}

async function isToolReady(toolState) {
  if (!toolState) {
    return false;
  }

  const runtime = runtimes.get(toolState.id);
  if (runtime?.process && runtime.process.exitCode === null && !runtime.stopping) {
    if (!toolUsesLocalUrl(toolState)) {
      return true;
    }

    return probeUrl(toolState.healthUrl || toolState.launchUrl);
  }

  if (toolState.launchProfile?.kind === 'embedded') {
    return toolState.status === 'running';
  }

  if (toolUsesLocalUrl(toolState)) {
    return probeUrl(toolState.healthUrl || toolState.launchUrl);
  }

  const runningProcessNames = await getRunningProcessNames(toolState.processNames);
  return runningProcessNames.length > 0;
}

async function openToolInterface(toolState) {
  if (!toolState?.launchUrl || getToolInterfaceMode(toolState) !== 'external-browser') {
    return;
  }

  const launchUrl = assertLoopbackUrl(toolState.launchUrl, 'tool URL');
  const ready = await waitForToolReady(
    {
      ...toolState,
      launchUrl,
    },
    getStartupTimeoutMs(toolState, OPEN_TIMEOUT_MS),
  );

  if (!ready) {
    return;
  }

  await shell.openExternal(launchUrl).catch(() => null);
}

function mergeLaunchProfiles(baseProfile, overrideProfile = {}) {
  if (!baseProfile) {
    return overrideProfile || null;
  }

  return {
    ...baseProfile,
    ...(overrideProfile || {}),
    env: {
      ...(baseProfile.env || {}),
      ...(overrideProfile?.env || {}),
    },
  };
}

function trimBufferedOutput(value, limit) {
  const text = String(value || '');
  return text.length > limit ? text.slice(-limit) : text;
}

function extractDownloadPercent(text) {
  let match = null;
  let latestPercent = null;

  while ((match = DOWNLOAD_PROGRESS_PATTERN.exec(String(text || ''))) !== null) {
    const percent = Number(match[1]);
    if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      latestPercent = percent;
    }
  }

  DOWNLOAD_PROGRESS_PATTERN.lastIndex = 0;
  return latestPercent;
}

function extractDownloadItemLabel(text) {
  const urlMatch = String(text || '').match(/https?:\/\/[^\s'"]+/i);
  if (urlMatch?.[0]) {
    try {
      const parsed = new URL(urlMatch[0].replace(/[)\]}>,.;]+$/, ''));
      const fileName = path.basename(parsed.pathname || '');
      if (fileName) {
        return fileName;
      }
    } catch {
      return null;
    }
  }

  const fileMatch = String(text || '').match(/[A-Za-z0-9._-]+\.(?:safetensors|ckpt|pth|bin|onnx|gguf|pt)\b/i);
  return fileMatch?.[0] || null;
}

function compactOutputText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function emitLaunchProgress(runtimeState) {
  const state = runtimeState?.startupDownload;
  if (!state) {
    return;
  }

  const payload = {
    type: 'launch-progress',
    toolId: runtimeState.toolId,
    active: Boolean(state.active),
    detail: state.active ? state.detail || null : null,
    message: buildStartupDownloadMessage(state.toolName),
    percent: Number.isFinite(state.percent) ? state.percent : null,
  };
  const signature = JSON.stringify(payload);
  if (state.lastSignature === signature) {
    return;
  }

  state.lastSignature = signature;
  emitRuntimeEvent(payload);
}

function clearLaunchProgress(runtimeState) {
  if (!runtimeState?.startupDownload) {
    return;
  }

  const state = runtimeState.startupDownload;
  if (!state.active && !state.lastSignature) {
    return;
  }

  state.active = false;
  state.detail = '';
  state.lastActivityAt = 0;
  state.percent = null;
  emitLaunchProgress(runtimeState);
}

function analyzeStartupDownloadOutput(runtimeState, stream, content) {
  const state = runtimeState?.startupDownload;
  if (!state) {
    return;
  }

  const carryKey = stream === 'stderr' ? 'stderrCarry' : 'stdoutCarry';
  const combined = `${state[carryKey] || ''}${String(content || '')}`;
  state[carryKey] = combined.slice(-STARTUP_DOWNLOAD_CARRY_LIMIT);

  const segments = combined
    .split(/[\r\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(-12);

  let detectedActivity = false;
  let latestDetail = state.detail;
  let latestPercent = Number.isFinite(state.percent) ? state.percent : null;

  for (const segment of segments) {
    const percent = extractDownloadPercent(segment);
    const looksLikeDownload =
      /downloading:/i.test(segment) ||
      (DOWNLOAD_KEYWORD_PATTERN.test(segment) && (DOWNLOAD_SOURCE_PATTERN.test(segment) || /\bdownload/i.test(segment))) ||
      (state.active && Number.isFinite(percent));

    if (!looksLikeDownload) {
      continue;
    }

    detectedActivity = true;
    if (Number.isFinite(percent)) {
      latestPercent = latestPercent === null ? percent : Math.max(latestPercent, percent);
    }

    const itemLabel = extractDownloadItemLabel(segment);
    if (itemLabel) {
      latestDetail = `Current file: ${itemLabel}`;
    } else if (Number.isFinite(percent)) {
      latestDetail = `Download progress: ${percent}%`;
    } else {
      const compact = compactOutputText(segment);
      if (compact) {
        latestDetail = compact;
      }
    }
  }

  if (!detectedActivity) {
    return;
  }

  state.active = true;
  state.detectedAt = state.detectedAt || Date.now();
  state.detail = latestDetail || state.detail || '';
  state.lastActivityAt = Date.now();
  state.percent = Number.isFinite(latestPercent) ? Math.min(100, latestPercent) : null;
  emitLaunchProgress(runtimeState);
}

function appendRuntimeOutput(runtimeState, key, chunk) {
  const content = typeof chunk === 'string' ? chunk : chunk?.toString?.() || '';
  runtimeState[key] = trimBufferedOutput(`${runtimeState[key] || ''}${content}`, OUTPUT_BUFFER_LIMIT);

  const logKey = key === 'stderrBuffer' ? 'stderrLogBuffer' : 'stdoutLogBuffer';
  runtimeState[logKey] = trimBufferedOutput(`${runtimeState[logKey] || ''}${content}`, OUTPUT_LOG_LIMIT);

  analyzeStartupDownloadOutput(runtimeState, key === 'stderrBuffer' ? 'stderr' : 'stdout', content);
  emitRuntimeEvent({
    type: 'output',
    toolId: runtimeState.toolId,
    stream: key === 'stderrBuffer' ? 'stderr' : 'stdout',
    chunk: content,
  });
}

function buildLaunchCommandSummary(launchProfile, extra = {}) {
  if (!launchProfile) {
    return extra;
  }

  if (launchProfile.kind === 'python-script' || launchProfile.kind === 'python-module') {
    return {
      command: launchProfile.pythonPath,
      pythonArgs: launchProfile.pythonArgs || [],
      target: launchProfile.target,
      targetKind: launchProfile.kind,
      targetArgs: launchProfile.args || [],
      workingDir: launchProfile.workingDir,
      ...extra,
    };
  }

  if (launchProfile.kind === 'binary') {
    return {
      command: launchProfile.executable,
      args: launchProfile.args || [],
      workingDir: launchProfile.workingDir,
      ...extra,
    };
  }

  if (launchProfile.kind === 'batch') {
    return {
      command: launchProfile.command,
      args: launchProfile.args || [],
      workingDir: launchProfile.workingDir,
      ...extra,
    };
  }

  return {
    ...launchProfile,
    ...extra,
  };
}

function createRuntimeLogger(toolState, launchProfile, runtimeOptions = {}) {
  return createLogger('launch', {
    toolId: toolState.id,
    toolName: toolState.name,
    launchContext: runtimeOptions.launchContext || 'internal',
    launchKind: launchProfile?.kind || 'unknown',
  });
}

async function waitForRuntimeExit(runtimeState, timeoutMs = PROCESS_SHUTDOWN_WAIT_MS) {
  if (!runtimeState?.process || runtimeState.process.exitCode !== null) {
    return true;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      runtimeState.process.removeListener('close', handleClose);
      resolve(value);
    };

    const handleClose = () => finish(true);
    const timer = setTimeout(() => finish(runtimeState.process.exitCode !== null), timeoutMs);

    runtimeState.process.once('close', handleClose);
  });
}

async function waitForNamedProcessesToStop(processNames = [], timeoutMs = PROCESS_SHUTDOWN_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runningProcessNames = await getRunningProcessNames(processNames);
    if (runningProcessNames.length === 0) {
      return true;
    }

    await sleep(500);
  }

  return (await getRunningProcessNames(processNames)).length === 0;
}

function buildPendingStartupMessage(toolState, target) {
  return `${toolState.name} is still starting and has not answered on ${target} yet. Local AI Hub will keep waiting in the background.`;
}

function buildPendingStartupFailureMessage(toolState, target) {
  return `${toolState.name} is still not answering on ${target}. Local AI Hub stopped waiting in the background. Open the logs folder for the full launch details.`;
}

async function stopRuntimeProcess(toolId, runtimeState) {
  pendingStartupMonitors.delete(toolId);

  if (!runtimeState?.process?.pid) {
    clearLaunchProgress(runtimeState);
    clearRuntime(toolId, runtimeState);
    return;
  }

  runtimeState.stopping = true;
  clearLaunchProgress(runtimeState);
  await killProcessTree(runtimeState.process.pid).catch(() => null);
  await waitForRuntimeExit(runtimeState).catch(() => false);
  clearRuntime(toolId, runtimeState);
}

async function monitorPendingLaunch(toolState, runtimeState = null, options = {}) {
  if (!toolState?.id) {
    return null;
  }

  const existingMonitor = pendingStartupMonitors.get(toolState.id);
  if (existingMonitor) {
    return existingMonitor;
  }

  const monitorPromise = (async () => {
    const logger = runtimeState?.logger || createRuntimeLogger(toolState, runtimeState?.launchProfile || toolState.launchProfile, {
      launchContext: options.launchContext || 'pending-startup',
    });
    const target = toolState.healthUrl || toolState.launchUrl || `http://127.0.0.1:${toolState.defaultPort}`;

    try {
      const ready = await waitForToolReady(toolState, getPendingStartupTimeoutMs(toolState), runtimeState);
      if (runtimeState?.stopping || runtimeState?.exitHandled) {
        return;
      }

      if (!ready) {
        await logger.warn('Tool never became ready after Local AI Hub kept waiting in the background.', {
          target,
          stdout: runtimeState?.stdoutLogBuffer || runtimeState?.stdoutBuffer || '',
          stderr: runtimeState?.stderrLogBuffer || runtimeState?.stderrBuffer || '',
        });

        if (runtimeState?.process?.pid && runtimeState.process.exitCode === null) {
          await stopRuntimeProcess(toolState.id, runtimeState);
        }

        const message = buildPendingStartupFailureMessage(toolState, target);
        await persistToolRuntimeState(toolState, 'error', {
          lastError: message,
          lastRepairMessage: null,
        });
        emitUnexpectedStop(toolState, message);
        return;
      }

      if (runtimeState) {
        runtimeState.launchConfirmed = true;
        clearLaunchProgress(runtimeState);
      }

      await logger.info('Tool answered on its expected local URL after Local AI Hub kept waiting in the background.', {
        target,
      });
      await persistToolRuntimeState(toolState, 'running', {
        lastError: null,
        lastRepairMessage: null,
      });

      if (options.openInterfaceWhenReady) {
        openToolInterface(toolState).catch(() => null);
      }
    } catch (error) {
      if (runtimeState?.stopping || runtimeState?.exitHandled) {
        return;
      }

      const message = humanizeError(error, buildPendingStartupFailureMessage(toolState, target));
      await logger.error('Background startup wait failed.', {
        error,
        target,
      });
      await persistToolRuntimeState(toolState, 'error', {
        lastError: message,
        lastRepairMessage: null,
      });
      emitUnexpectedStop(toolState, message);
    } finally {
      pendingStartupMonitors.delete(toolState.id);
    }
  })();

  pendingStartupMonitors.set(toolState.id, monitorPromise);
  return monitorPromise;
}

async function waitForLaunchConfirmation(toolState, runtimeState, logger, options = {}) {
  if (!runtimeState) {
    return {
      status: 'stopped',
    };
  }

  if (toolUsesLocalUrl(toolState)) {
    const target = toolState.healthUrl || toolState.launchUrl || `http://127.0.0.1:${toolState.defaultPort}`;
    const confirmationTimeoutMs = options.allowPendingStartup
      ? Math.min(getStartupTimeoutMs(toolState, OPEN_TIMEOUT_MS), OPEN_TIMEOUT_MS)
      : getStartupTimeoutMs(toolState, OPEN_TIMEOUT_MS);
    const ready = await waitForToolReady(toolState, confirmationTimeoutMs, runtimeState);
    if (!ready) {
      const processStillRunning = runtimeState.process?.exitCode === null && !runtimeState.stopping;
      const runningProcessNames = processStillRunning ? [] : await getRunningProcessNames(toolState.processNames);
      await logger.warn('Tool did not answer on its expected local URL before the startup timeout.', {
        target,
        processStillRunning,
        runningProcessNames,
        startupDownload: runtimeState.startupDownload?.active
          ? {
              detectedAt: runtimeState.startupDownload.detectedAt || null,
              detail: runtimeState.startupDownload.detail || null,
              lastActivityAt: runtimeState.startupDownload.lastActivityAt || null,
              percent: runtimeState.startupDownload.percent,
            }
          : null,
        stdout: runtimeState.stdoutLogBuffer || runtimeState.stdoutBuffer || '',
        stderr: runtimeState.stderrLogBuffer || runtimeState.stderrBuffer || '',
      });

      if (options.allowPendingStartup && (processStillRunning || runningProcessNames.length > 0)) {
        return {
          status: 'starting',
          target,
        };
      }

      await stopRuntimeProcess(toolState.id, runtimeState);
      throw new Error(`${toolState.name} did not answer on ${target} before Local AI Hub's startup check finished. Open the logs folder for the full launch details.`);
    }

    await logger.info('Tool answered on its expected local URL.', {
      target,
    });
    runtimeState.launchConfirmed = true;
    clearLaunchProgress(runtimeState);
    return {
      status: 'running',
    };
  }

  if (runtimeState.process?.exitCode === null && !runtimeState.stopping) {
    await logger.info('Tool process started without a local URL health check.', {
      pid: runtimeState.process?.pid || null,
    });
    runtimeState.launchConfirmed = true;
    clearLaunchProgress(runtimeState);
    return {
      status: 'running',
    };
  }

  const runningProcessNames = await getRunningProcessNames(toolState.processNames);
  if (runningProcessNames.length > 0) {
    await logger.info('Tool launch was confirmed by an active process after the launcher exited.', {
      runningProcessNames,
    });
    runtimeState.launchConfirmed = true;
    clearLaunchProgress(runtimeState);
    return {
      status: 'running',
    };
  }

  throw new Error(`${toolState.name} stopped before Local AI Hub could confirm that it launched.`);
}
async function confirmLaunchAfterExit(toolState, runtimeState = null) {
  if (toolUsesLocalUrl(toolState)) {
    return {
      running: await waitForToolReady(
        toolState,
        Math.max(SUCCESS_CONFIRM_TIMEOUT_MS, getStartupTimeoutMs(toolState, SUCCESS_CONFIRM_TIMEOUT_MS)),
        runtimeState,
      ),
      runningProcessNames: [],
    };
  }

  const runningProcessNames = await getRunningProcessNames(toolState.processNames);
  return {
    running: runningProcessNames.length > 0,
    runningProcessNames,
  };
}

async function handleRuntimeExit(toolState, runtimeState, code, signal, runtimeOptions = {}) {
  if (!runtimeState || runtimeState.exitHandled) {
    return;
  }

  runtimeState.exitHandled = true;
  pendingStartupMonitors.delete(toolState.id);
  clearLaunchProgress(runtimeState);
  clearRuntime(toolState.id, runtimeState);

  const logger = runtimeState.logger || createRuntimeLogger(toolState, runtimeState.launchProfile || toolState.launchProfile, runtimeOptions);
  const combinedOutput = `${runtimeState.stdoutLogBuffer || runtimeState.stdoutBuffer || ''}\n${runtimeState.stderrLogBuffer || runtimeState.stderrBuffer || ''}`.trim();

  if (runtimeState.stopping) {
    await logger.info('Tool runtime stopped by Local AI Hub.', {
      exitCode: code,
      signal,
    });
    await upsertTool({
      id: toolState.id,
      status: 'stopped',
      lastError: null,
      lastRepairMessage: null,
    });
    emitToolState(toolState.id, {
      status: 'stopped',
      lastError: null,
      lastRepairMessage: null,
    });
    return;
  }

  const launchState = runtimeState.launchConfirmed ? { running: false, runningProcessNames: [] } : await confirmLaunchAfterExit(toolState, runtimeState);
  if (!runtimeState.launchConfirmed && launchState.running) {
    await logger.info('Launch process exited after the tool became available.', {
      exitCode: code,
      signal,
      runningProcessNames: launchState.runningProcessNames || [],
    });
    await upsertTool({
      id: toolState.id,
      status: 'running',
      lastError: null,
      lastRepairMessage: null,
    });
    emitToolState(toolState.id, {
      status: 'running',
      lastError: null,
      lastRepairMessage: null,
    });
    return;
  }

  const wasRunning = Boolean(runtimeState.launchConfirmed);
  const isClean = code === 0 || signal === 'SIGTERM';
  if (!wasRunning && isClean) {
    await logger.info('Tool process exited cleanly.', {
      exitCode: code,
      signal,
      stdout: runtimeState.stdoutLogBuffer || runtimeState.stdoutBuffer || '',
      stderr: runtimeState.stderrLogBuffer || runtimeState.stderrBuffer || '',
    });
    await upsertTool({
      id: toolState.id,
      status: 'stopped',
      lastError: null,
      lastRepairMessage: null,
    });
    emitToolState(toolState.id, {
      status: 'stopped',
      lastError: null,
      lastRepairMessage: null,
    });
    return;
  }

  const failureText = collectMeaningfulFailureText(toolState, combinedOutput);
  if (isClean && wasRunning) {
    await logger.warn('Tool exited after it had already been confirmed running.', {
      exitCode: code,
      signal,
      stdout: runtimeState.stdoutLogBuffer || runtimeState.stdoutBuffer || '',
      stderr: runtimeState.stderrLogBuffer || runtimeState.stderrBuffer || '',
    });
  } else {
    await logger.error('Tool process exited unexpectedly.', {
      exitCode: code,
      signal,
      launchProfile: buildLaunchCommandSummary(runtimeState.launchProfile || toolState.launchProfile || null),
      stdout: runtimeState.stdoutLogBuffer || runtimeState.stdoutBuffer || '',
      stderr: runtimeState.stderrLogBuffer || runtimeState.stderrBuffer || '',
    });
  }

  const recoveryResult = runtimeOptions.autoRecoveryAttempted
    ? { handled: false, recovered: false, userMessage: null }
    : await attemptAutomaticLaunchRecovery(toolState, failureText || runtimeState.stderrLogBuffer || '', {
        logger,
        retryLaunch: async (nextToolState) => {
          await launchToolInternal(nextToolState, {
            autoRecoveryAttempted: true,
            launchContext: 'automatic-recovery',
          });
        },
      });

  if (recoveryResult?.recovered) {
    return;
  }

  let message = recoveryResult?.userMessage;
  if (!message && toolUsesLocalUrl(toolState) && !wasRunning) {
    const target = toolState.healthUrl || toolState.launchUrl || `http://127.0.0.1:${toolState.defaultPort}`;
    message = `${toolState.name} stopped before it became available on ${target}. Open the logs folder for the full launch details.`;
  }

  if (!message) {
    const fallbackMessage = wasRunning
      ? `${toolState.name} stopped unexpectedly while it was running.`
      : `${toolState.name} stopped unexpectedly.`;
    message = humanizeError(failureText || fallbackMessage, fallbackMessage);
  }

  await upsertTool({
    id: toolState.id,
    status: 'error',
    lastError: message,
    lastRepairMessage: null,
  });
  emitToolState(toolState.id, {
    status: 'error',
    lastError: message,
    lastRepairMessage: null,
  });
  emitUnexpectedStop(toolState, message);
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
  const safeLaunchProfile = resolveLaunchProfile(toolState, launchProfile);
  if (!isBareCommand(safeLaunchProfile.pythonPath) && !(await fs.pathExists(safeLaunchProfile.pythonPath))) {
    throw new Error(`${toolState.name} is missing its Python launcher. Run Repair or reinstall it.`);
  }

  const helperScript = getHelperScriptPath();
  if (!(await fs.pathExists(helperScript))) {
    throw new Error('Local AI Hub is missing its Python launcher helper. Reinstall the app to restore it.');
  }

  const runtimeEnv = await buildLaunchRuntimeEnv(toolState, safeLaunchProfile.env || {});
  const logger = createRuntimeLogger(toolState, safeLaunchProfile, runtimeOptions);
  await logger.info('Starting tool runtime.', {
    launch: buildLaunchCommandSummary(safeLaunchProfile, {
      helperScript,
      helperMode: safeLaunchProfile.kind === 'python-module' ? 'module' : 'script',
    }),
  });

  const shellInstance = new PythonShell(path.basename(helperScript), {
    pythonPath: safeLaunchProfile.pythonPath,
    scriptPath: path.dirname(helperScript),
    pythonOptions: ['-u', ...(safeLaunchProfile.pythonArgs || [])],
    args: [
      safeLaunchProfile.workingDir,
      safeLaunchProfile.kind === 'python-module' ? 'module' : 'script',
      safeLaunchProfile.target,
      ...(safeLaunchProfile.args || []),
    ],
    env: runtimeEnv,
  });

  if (!shellInstance.childProcess) {
    throw new Error(`${toolState.name} did not return a Python process handle.`);
  }

  const runtimeState = rememberRuntime(toolState.id, {
    kind: 'python',
    toolId: toolState.id,
    toolName: toolState.name,
    process: shellInstance.childProcess,
    shell: shellInstance,
    logger,
    launchProfile: safeLaunchProfile,
    startupDownload: createStartupDownloadState(toolState),
    stdoutBuffer: '',
    stderrBuffer: '',
    stdoutLogBuffer: '',
    stderrLogBuffer: '',
    stopping: false,
    exitHandled: false,
  });

  return attachRuntimeHandlers(toolState, runtimeState, runtimeOptions);
}

async function launchBinaryProfile(toolState, launchProfile, runtimeOptions = {}) {
  const safeLaunchProfile = resolveLaunchProfile(toolState, launchProfile);
  if (!(await fs.pathExists(safeLaunchProfile.executable))) {
    throw new Error(`${toolState.name} is missing its launcher executable. Run Repair or reinstall it.`);
  }

  const logger = createRuntimeLogger(toolState, safeLaunchProfile, runtimeOptions);
  await logger.info('Starting tool runtime.', {
    launch: buildLaunchCommandSummary(safeLaunchProfile),
  });

  const child = spawn(safeLaunchProfile.executable, safeLaunchProfile.args || [], {
    cwd: safeLaunchProfile.workingDir || path.dirname(safeLaunchProfile.executable),
    windowsHide: true,
    env: await buildLaunchRuntimeEnv(toolState, safeLaunchProfile.env || {}),
  });

  const runtimeState = rememberRuntime(toolState.id, {
    kind: 'binary',
    toolId: toolState.id,
    toolName: toolState.name,
    process: child,
    logger,
    launchProfile: safeLaunchProfile,
    startupDownload: createStartupDownloadState(toolState),
    stdoutBuffer: '',
    stderrBuffer: '',
    stdoutLogBuffer: '',
    stderrLogBuffer: '',
    stopping: false,
    exitHandled: false,
  });

  return attachRuntimeHandlers(toolState, runtimeState, runtimeOptions);
}

async function launchBatchProfile(toolState, launchProfile, runtimeOptions = {}) {
  const safeLaunchProfile = resolveLaunchProfile(toolState, launchProfile);
  if (!(await fs.pathExists(safeLaunchProfile.command))) {
    throw new Error(`${toolState.name} is missing its launcher script. Open the tool folder to inspect it.`);
  }

  const logger = createRuntimeLogger(toolState, safeLaunchProfile, runtimeOptions);
  await logger.info('Starting tool runtime.', {
    launch: buildLaunchCommandSummary(safeLaunchProfile, {
      commandShell: 'cmd.exe',
    }),
  });

  const child = spawn('cmd.exe', ['/c', safeLaunchProfile.command, ...(safeLaunchProfile.args || [])], {
    cwd: safeLaunchProfile.workingDir || path.dirname(safeLaunchProfile.command),
    windowsHide: true,
    env: await buildLaunchRuntimeEnv(toolState, safeLaunchProfile.env || {}),
  });

  const runtimeState = rememberRuntime(toolState.id, {
    kind: 'batch',
    toolId: toolState.id,
    toolName: toolState.name,
    process: child,
    logger,
    launchProfile: safeLaunchProfile,
    startupDownload: createStartupDownloadState(toolState),
    stdoutBuffer: '',
    stderrBuffer: '',
    stdoutLogBuffer: '',
    stderrLogBuffer: '',
    stopping: false,
    exitHandled: false,
  });

  return attachRuntimeHandlers(toolState, runtimeState, runtimeOptions);
}

async function resolveToolStatus(toolState) {
  if (await isToolReady(toolState)) {
    return 'running';
  }

  if (toolState?.status === 'starting') {
    return (await isToolActive(toolState)) ? 'starting' : 'stopped';
  }

  if (toolState?.status === 'running') {
    return 'stopped';
  }

  return toolState?.status || 'stopped';
}

async function launchToolInternal(toolState, options = {}) {
  if (!toolState) {
    throw new Error('Local AI Hub could not find that tool in its installed list.');
  }

  const markStarting = async () => {
    await persistToolRuntimeState(toolState, 'starting', {
      lastError: null,
      lastRepairMessage: null,
    });
    return {
      ...toolState,
      status: 'starting',
      lastError: null,
      lastRepairMessage: null,
    };
  };

  const runtime = runtimes.get(toolState.id);
  if (runtime?.process && runtime.process.exitCode === null && !runtime.stopping) {
    const launchResult = await waitForLaunchConfirmation(
      toolState,
      runtime,
      runtime.logger || createRuntimeLogger(toolState, runtime.launchProfile || toolState.launchProfile, options),
      options,
    );
    if (launchResult.status === 'starting') {
      const pendingTool = await markStarting();
      monitorPendingLaunch(toolState, runtime, {
        launchContext: options.launchContext,
        openInterfaceWhenReady: !options.skipOpenInterface,
      }).catch(() => null);
      return pendingTool;
    }

    await persistToolRuntimeState(toolState, 'running', {
      lastError: null,
      lastRepairMessage: null,
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

  if (await isToolActive(toolState)) {
    if (toolUsesLocalUrl(toolState)) {
      const confirmationTimeoutMs = options.allowPendingStartup
        ? Math.min(getStartupTimeoutMs(toolState, OPEN_TIMEOUT_MS), OPEN_TIMEOUT_MS)
        : getStartupTimeoutMs(toolState, OPEN_TIMEOUT_MS);
      const ready = await waitForToolReady(toolState, confirmationTimeoutMs);
      if (!ready) {
        if (!options.allowPendingStartup) {
          throw new Error(`${toolState.name} is running, but it is not answering on its local URL yet.`);
        }

        const pendingTool = await markStarting();
        monitorPendingLaunch(toolState, null, {
          launchContext: options.launchContext,
          openInterfaceWhenReady: !options.skipOpenInterface,
        }).catch(() => null);
        return pendingTool;
      }
    }

    await persistToolRuntimeState(toolState, 'running', {
      lastError: null,
      lastRepairMessage: null,
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

  const launchProfile = resolveLaunchProfile(toolState, mergeLaunchProfiles(toolState.launchProfile, options.launchProfileOverride));
  if (!launchProfile) {
    throw new Error(`${toolState.name} does not have a launch profile yet.`);
  }

  if (launchProfile.kind === 'embedded') {
    await persistToolRuntimeState(toolState, 'running', {
      lastError: null,
      lastRepairMessage: null,
    });

    return {
      ...toolState,
      status: 'running',
      lastError: null,
    };
  }

  if (launchProfile.kind === 'folder') {
    await shell.openPath(launchProfile.path || toolState.installDir);
    return toolState;
  }

  try {
    let runtimeState = null;

    if (launchProfile.kind === 'python-script' || launchProfile.kind === 'python-module') {
      runtimeState = await launchPythonProfile(toolState, launchProfile, options);
    } else if (launchProfile.kind === 'binary') {
      runtimeState = await launchBinaryProfile(toolState, launchProfile, options);
    } else if (launchProfile.kind === 'batch') {
      runtimeState = await launchBatchProfile(toolState, launchProfile, options);
    } else {
      throw new Error(`Local AI Hub does not know how to launch ${toolState.name}.`);
    }

    await persistToolRuntimeState(toolState, 'starting', {
      lastError: null,
      lastRepairMessage: null,
    });

    const launchResult = await waitForLaunchConfirmation(toolState, runtimeState, runtimeState.logger, options);
    if (launchResult.status === 'starting') {
      monitorPendingLaunch(toolState, runtimeState, {
        launchContext: options.launchContext,
        openInterfaceWhenReady: !options.skipOpenInterface,
      }).catch(() => null);
      return {
        ...toolState,
        status: 'starting',
        lastError: null,
      };
    }

    await persistToolRuntimeState(toolState, 'running', {
      lastError: null,
      lastRepairMessage: null,
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
    await persistToolRuntimeState(toolState, 'error', {
      lastError: message,
      lastRepairMessage: null,
    });
    throw new Error(message);
  }
}

async function launchToolFromUserAction(toolState, options = {}) {
  return launchToolInternal(toolState, {
    ...options,
    allowPendingStartup: options.allowPendingStartup === undefined ? true : Boolean(options.allowPendingStartup),
    launchContext: options.launchContext || 'user-action',
  });
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
  pendingStartupMonitors.delete(toolState.id);

  const runtime = runtimes.get(toolState.id);
  if (runtime?.process?.pid) {
    runtime.stopping = true;
    clearLaunchProgress(runtime);
    await killProcessTree(runtime.process.pid);
    await waitForRuntimeExit(runtime).catch(() => false);
    clearRuntime(toolState.id, runtime);
    await persistToolRuntimeState(toolState, 'stopped', {
      lastError: null,
      lastRepairMessage: null,
    });
    return;
  }

  const stoppedProcessNames = await stopNamedProcesses(toolState.processNames);
  if (stoppedProcessNames.length > 0) {
    await waitForNamedProcessesToStop(stoppedProcessNames).catch(() => false);
    await persistToolRuntimeState(toolState, 'stopped', {
      lastError: null,
      lastRepairMessage: null,
    });
    return;
  }

  if (await probeUrl(toolState.healthUrl || toolState.launchUrl)) {
    throw new Error(
      `Local AI Hub cannot safely stop ${toolState.name} because it did not start this process itself. Close it from its own window or service manager.`,
    );
  }

  await persistToolRuntimeState(toolState, 'stopped', {
    lastError: null,
    lastRepairMessage: null,
  });
}

async function prepareToolForMaintenance(toolState) {
  const wasActive = await isToolActive(toolState).catch(() => false);
  if (wasActive) {
    await stopTool(toolState);
  }

  await sleep(PROCESS_RELEASE_SETTLE_MS);

  const stillActive = await isToolActive(toolState).catch(() => false);
  if (stillActive) {
    throw new Error(`${toolState.name} is still using files on this PC. Let it finish closing, then try again.`);
  }

  return {
    wasActive,
  };
}
async function disposeAllRuntimes() {
  await Promise.all(
    [...runtimes.values()].map(async (runtime) => {
      runtime.stopping = true;
      clearLaunchProgress(runtime);
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
  getRuntimeOutputSnapshot,
  isToolActive,
  isToolReady,
  launchToolFromUserAction,
  prepareToolForMaintenance,
  resolveToolStatus,
  sendInputToTool,
  setRuntimeEventSink,
  stopTool,
};

