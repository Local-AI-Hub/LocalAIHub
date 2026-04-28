const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { shell, app } = require('electron');
const { PythonShell } = require('python-shell');

const { getAppPaths, humanizeError, upsertTool } = require('./configService');
const { killProcessTree, runCommand } = require('./commandService');
const { createLogger } = require('./logService');
const { buildOllamaAllocationFailureMessage, isOllamaAllocationFailureMessage } = require('./ollamaFailureService');
const { attemptAutomaticLaunchRecovery, diagnoseLaunchFailure, selectPyTorchRepairCandidates } = require('./runtimeRecoveryService');
const { getNvidiaRuntimeDetails, detectHardwareSnapshot } = require('./hardwareService');
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
const MANAGED_STABLE_DIFFUSION_TOOL_IDS = new Set(['automatic1111', 'forge']);
const MANAGED_STABLE_DIFFUSION_CLIP_PACKAGE = '--no-build-isolation git+https://github.com/openai/CLIP.git@d50d76daa670286dd6cacf3bcd80b5e4823fc8e1#egg=clip';
const MANAGED_STABLE_DIFFUSION_REPO_URL = 'https://github.com/w-e-w/stablediffusion.git';
const MANAGED_STABLE_DIFFUSION_NUMPY_PIN = 'numpy==1.26.2';
const MANAGED_STABLE_DIFFUSION_SKIMAGE_PIN = 'scikit-image==0.21.0';
const MANAGED_STABLE_DIFFUSION_SETUPTOOLS_PIN = 'setuptools==69.5.1';
const MANAGED_FORGE_PYDANTIC_PIN = 'pydantic==2.8.2';
const AIDER_WAITING_FOR_INPUT_MS = 2500;
const AIDER_AUTO_SETTLE_MIN_TURN_MS = 12000;
const AIDER_AUTO_SETTLE_MIN_IDLE_AFTER_FILE_CHANGE_MS = 4000;
const AIDER_AUTO_SETTLE_REPEAT_THRESHOLD = 2;
const AIDER_OUTPUT_AFTER_CHANGE_THRESHOLD = 2400;
const AIDER_REPEAT_SIGNATURE_MIN_LENGTH = 120;
const AIDER_MAX_CHANGED_FILES = 12;
const AIDER_STARTUP_SETTLE_MS = 1500;
const AIDER_STARTUP_RECOVERY_WAIT_MS = 10 * 60 * 1000;
let runtimeEventSink = null;
const pendingStartupMonitors = new Map();
const runtimeExitSettlingToolIds = new Set();

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
function attachRuntimeLifecycle(runtimeState, runtimeOptions = {}) {
  if (!runtimeState) {
    return runtimeState;
  }
  runtimeState.onStopCleanup = typeof runtimeOptions.onStopCleanup === 'function'
    ? runtimeOptions.onStopCleanup
    : null;
  runtimeState.onStopCleanupPromise = null;
  return runtimeState;
}
async function runRuntimeStopCleanup(runtimeState) {
  if (!runtimeState?.onStopCleanup) {
    return;
  }
  if (!runtimeState.onStopCleanupPromise) {
    runtimeState.onStopCleanupPromise = Promise.resolve()
      .then(() => runtimeState.onStopCleanup())
      .finally(() => {
        runtimeState.onStopCleanup = null;
      });
  }
  return runtimeState.onStopCleanupPromise;
}
async function logRuntimeStopCleanupFailure(runtimeState, context, error) {
  if (!runtimeState?.logger || !error) {
    return;
  }
  await runtimeState.logger.warn('Local AI Hub could not clean up a supporting runtime after the main tool stopped.', {
    context,
    error,
  });
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

function snapshotRuntimeSessionState(sessionState) {
  if (!sessionState) {
    return null;
  }

  return {
    ...sessionState,
    changedFiles: [...(sessionState.changedFiles || [])],
  };
}

function emitRuntimeSessionState(runtimeState) {
  const sessionState = snapshotRuntimeSessionState(runtimeState?.sessionState);
  if (!sessionState) {
    return;
  }

  const signature = JSON.stringify(sessionState);
  if (runtimeState.lastSessionStateSignature === signature) {
    return;
  }

  runtimeState.lastSessionStateSignature = signature;
  emitRuntimeEvent({
    type: 'session-state',
    toolId: runtimeState.toolId,
    sessionState,
  });
}

function getRuntimeOutputSnapshot(toolId) {
  const runtime = runtimes.get(toolId);
  return {
    toolId,
    stdout: runtime?.stdoutBuffer || '',
    stderr: runtime?.stderrBuffer || '',
    sessionState: snapshotRuntimeSessionState(runtime?.sessionState),
  };
}

function isToolRuntimeSettling(toolId) {
  return runtimeExitSettlingToolIds.has(toolId);
}

function writeRuntimeInput(runtime, input, options = {}) {
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
  return text;
}

function sendInputToTool(toolId, input, options = {}) {
  const runtime = runtimes.get(toolId);
  const text = writeRuntimeInput(runtime, input, options);
  noteRuntimeInput(runtime, text, options);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function stripAnsiText(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function buildAiderStartingMessage(projectDir) {
  return `Aider is starting in ${projectDir || 'the selected project folder'}.`;
}

function buildAiderRespondingMessage(sessionState) {
  const changedFileCount = Number(sessionState?.changedFileCount || 0);
  if (changedFileCount > 0) {
    return `Aider is still responding after changing ${changedFileCount} file${changedFileCount === 1 ? '' : 's'}. Local AI Hub will move it back to waiting when this turn settles.`;
  }

  return 'Aider is working on your last instruction.';
}

function buildAiderWaitingMessage(sessionState) {
  const changedFileCount = Number(sessionState?.changedFileCount || 0);
  if (changedFileCount > 0) {
    return `Aider is waiting for your next instruction. It changed ${changedFileCount} file${changedFileCount === 1 ? '' : 's'} in this turn.`;
  }

  return 'Aider is waiting for your next instruction.';
}

function shouldTrackAiderSession(toolState) {
  return toolState?.id === 'aider';
}

function isAiderOllamaSession(runtimeState) {
  if (runtimeState?.toolId !== 'aider') {
    return false;
  }

  const args = Array.isArray(runtimeState?.launchProfile?.args) ? runtimeState.launchProfile.args : [];
  const modelFlagIndex = args.findIndex((entry) => entry === '--model');
  if (modelFlagIndex >= 0) {
    return String(args[modelFlagIndex + 1] || '').startsWith('ollama_chat/');
  }

  return Boolean(runtimeState?.launchProfile?.env?.OLLAMA_API_BASE);
}

function detectAiderHardFailureMessage(runtimeState) {
  if (!isAiderOllamaSession(runtimeState)) {
    return '';
  }

  const combinedOutput = stripAnsiText(`${runtimeState?.stdoutBuffer || ''}\n${runtimeState?.stderrBuffer || ''}`);
  if (!combinedOutput.trim()) {
    return '';
  }

  if (isOllamaAllocationFailureMessage(combinedOutput)) {
    return buildOllamaAllocationFailureMessage({
      context: 'aider-turn',
      runtimePolicy: runtimeState?.launchProfile?.localAIHubAiderRuntimePolicy || null,
    });
  }

  const normalizedOutput = combinedOutput.toLowerCase();
  const looksLikeHardOllama500 = (normalizedOutput.includes('ollama_chatexception') || normalizedOutput.includes('ollamaexception'))
    && (normalizedOutput.includes('returned 500') || normalizedOutput.includes('internalservererror'))
    && /(memory|allocate|allocation|out of memory)/i.test(combinedOutput);
  if (looksLikeHardOllama500) {
    return buildOllamaAllocationFailureMessage({
      context: 'aider-turn',
      runtimePolicy: runtimeState?.launchProfile?.localAIHubAiderRuntimePolicy || null,
    });
  }

  return '';
}

async function maybeStopAiderForHardFailure(toolState, runtimeState) {
  if (!shouldTrackAiderSession(toolState) || runtimeState?.hardFailureMessage || runtimeState?.stopping || runtimeState?.exitHandled) {
    return;
  }

  const message = detectAiderHardFailureMessage(runtimeState);
  if (!message) {
    return;
  }

  runtimeState.hardFailureMessage = message;
  clearAiderWaitingTimer(runtimeState);
  if (runtimeState.sessionState) {
    runtimeState.sessionState.phase = 'error';
    runtimeState.sessionState.waitingForUser = false;
    runtimeState.sessionState.activeTurn = false;
    runtimeState.sessionState.message = message;
    emitRuntimeSessionState(runtimeState);
  }

  await stopRuntimeProcess(toolState.id, runtimeState, {
    sessionMessage: message,
  });
}

function clearAiderWaitingTimer(runtimeState) {
  if (runtimeState?.aiderWaitingTimer) {
    clearTimeout(runtimeState.aiderWaitingTimer);
    runtimeState.aiderWaitingTimer = null;
  }
}

function normalizeRelativeRuntimePath(rootPath, candidatePath) {
  const normalizedRoot = String(rootPath || '').trim();
  const normalizedCandidate = String(candidatePath || '').trim();
  if (!normalizedRoot || !normalizedCandidate) {
    return '';
  }

  const relativePath = path.relative(normalizedRoot, normalizedCandidate);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return '';
  }

  return relativePath;
}

function shouldIgnoreAiderChangedPath(relativePath) {
  const segments = String(relativePath || '')
    .split(/[\\/]+/)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);

  return segments.some((segment) => [
    '.git',
    '.localaihub',
    '.venv',
    '__pycache__',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'venv',
  ].includes(segment));
}

function createAiderSessionState(toolState, launchProfile) {
  const projectDir = launchProfile?.workingDir || toolState?.lastProjectDir || '';
  return {
    kind: 'aider',
    phase: 'starting',
    message: buildAiderStartingMessage(projectDir),
    waitingForUser: false,
    activeTurn: false,
    projectDir,
    changedFiles: [],
    changedFileCount: 0,
    autoSettleAttempted: false,
    autoSettleTriggered: false,
  };
}

function recordAiderChangedFile(runtimeState, candidatePath) {
  if (!runtimeState?.sessionState?.activeTurn) {
    return;
  }

  const projectDir = runtimeState.sessionState.projectDir;
  const relativePath = normalizeRelativeRuntimePath(projectDir, candidatePath);
  if (!relativePath || shouldIgnoreAiderChangedPath(relativePath)) {
    return;
  }

  const normalizedPath = relativePath.split(path.sep).join('/');
  const existingFiles = new Set(runtimeState.sessionState.changedFiles || []);
  if (!existingFiles.has(normalizedPath)) {
    runtimeState.sessionState.changedFiles = [normalizedPath, ...(runtimeState.sessionState.changedFiles || [])]
      .slice(0, AIDER_MAX_CHANGED_FILES);
  }

  runtimeState.sessionState.changedFileCount = Math.max(
    Number(runtimeState.sessionState.changedFileCount || 0),
    runtimeState.sessionState.changedFiles.length,
  );
  runtimeState.aiderLastFileChangeAt = Date.now();
  runtimeState.aiderOutputSinceLastFileChange = 0;

  if (runtimeState.sessionState.phase === 'responding') {
    const changedFileCount = Number(runtimeState.sessionState.changedFileCount || 0);
    runtimeState.sessionState.message = changedFileCount === 1
      ? `Aider changed ${normalizedPath}. Local AI Hub is waiting for the turn to settle.`
      : `Aider has changed ${changedFileCount} files in this turn. Local AI Hub is waiting for the turn to settle.`;
  }

  emitRuntimeSessionState(runtimeState);
}

function startAiderProjectWatcher(runtimeState) {
  const projectDir = runtimeState?.sessionState?.projectDir;
  if (!projectDir || runtimeState?.aiderProjectWatcher) {
    return;
  }

  try {
    const watcher = fs.watch(projectDir, { recursive: true }, (_eventType, fileName) => {
      if (!fileName) {
        return;
      }

      const nextPath = path.resolve(projectDir, String(fileName));
      recordAiderChangedFile(runtimeState, nextPath);
    });

    if (typeof watcher?.on === 'function') {
      watcher.on('error', () => null);
    }

    runtimeState.aiderProjectWatcher = watcher;
  } catch {
    runtimeState.aiderProjectWatcher = null;
  }
}

function buildAiderOutputSignature(runtimeState) {
  const combinedOutput = stripAnsiText(`${runtimeState?.stdoutBuffer || ''}\n${runtimeState?.stderrBuffer || ''}`);
  const lines = combinedOutput
    .split(/\r?\n/)
    .map((line) => line.toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#').trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('> '));

  return lines.slice(-8).join('\n').slice(-1200);
}

function updateAiderRepeatHeuristic(runtimeState) {
  const nextSignature = buildAiderOutputSignature(runtimeState);
  if (nextSignature.length < AIDER_REPEAT_SIGNATURE_MIN_LENGTH) {
    return;
  }

  if (nextSignature === runtimeState.aiderRepeatSignature) {
    runtimeState.aiderRepeatCount += 1;
    return;
  }

  runtimeState.aiderRepeatSignature = nextSignature;
  runtimeState.aiderRepeatCount = 0;
}

function scheduleAiderWaitingState(runtimeState) {
  if (!runtimeState?.sessionState?.activeTurn) {
    return;
  }

  clearAiderWaitingTimer(runtimeState);
  runtimeState.aiderWaitingTimer = setTimeout(() => {
    if (!runtimeState?.sessionState?.activeTurn || runtimeState?.stopping || runtimeState?.exitHandled) {
      return;
    }

    runtimeState.sessionState.phase = 'waiting';
    runtimeState.sessionState.waitingForUser = true;
    runtimeState.sessionState.activeTurn = false;
    runtimeState.sessionState.message = buildAiderWaitingMessage(runtimeState.sessionState);
    emitRuntimeSessionState(runtimeState);
  }, AIDER_WAITING_FOR_INPUT_MS);
}

function maybeAutoSettleAiderSession(runtimeState) {
  const sessionState = runtimeState?.sessionState;
  if (!sessionState?.activeTurn || sessionState.waitingForUser || sessionState.autoSettleAttempted) {
    return;
  }

  if (Number(sessionState.changedFileCount || 0) === 0) {
    return;
  }

  if (!Number(runtimeState.aiderLastUserInputAt) || !Number(runtimeState.aiderLastFileChangeAt)) {
    return;
  }

  const now = Date.now();
  if (now - runtimeState.aiderLastUserInputAt < AIDER_AUTO_SETTLE_MIN_TURN_MS) {
    return;
  }

  if (now - runtimeState.aiderLastFileChangeAt < AIDER_AUTO_SETTLE_MIN_IDLE_AFTER_FILE_CHANGE_MS) {
    return;
  }

  const looksRepetitive = runtimeState.aiderRepeatCount >= AIDER_AUTO_SETTLE_REPEAT_THRESHOLD
    && runtimeState.aiderOutputSinceLastFileChange >= AIDER_OUTPUT_AFTER_CHANGE_THRESHOLD;
  if (!looksRepetitive) {
    return;
  }

  sendInputToTool(runtimeState.toolId, '/ask', {
    autoGenerated: true,
    source: 'localaihub-aider-auto-settle',
  });
}

function trackAiderRuntimeOutput(runtimeState, content) {
  if (!runtimeState?.sessionState || !shouldTrackAiderSession({ id: runtimeState.toolId })) {
    return;
  }

  if (!stripAnsiText(content).replace(/\s+/g, '')) {
    return;
  }

  if (runtimeState.sessionState.activeTurn && runtimeState.sessionState.phase !== 'settling') {
    runtimeState.sessionState.phase = 'responding';
    runtimeState.sessionState.waitingForUser = false;
    runtimeState.sessionState.message = buildAiderRespondingMessage(runtimeState.sessionState);
  }

  runtimeState.aiderLastOutputAt = Date.now();
  if (Number(runtimeState.aiderLastFileChangeAt) > 0) {
    runtimeState.aiderOutputSinceLastFileChange += String(content || '').length;
  }

  updateAiderRepeatHeuristic(runtimeState);
  scheduleAiderWaitingState(runtimeState);
  maybeAutoSettleAiderSession(runtimeState);
  emitRuntimeSessionState(runtimeState);
}

function noteRuntimeInput(runtimeState, _text, options = {}) {
  if (!runtimeState?.sessionState || !shouldTrackAiderSession({ id: runtimeState.toolId })) {
    return;
  }

  clearAiderWaitingTimer(runtimeState);

  if (options.autoGenerated) {
    runtimeState.sessionState.phase = 'settling';
    runtimeState.sessionState.waitingForUser = false;
    runtimeState.sessionState.activeTurn = true;
    runtimeState.sessionState.autoSettleAttempted = true;
    runtimeState.sessionState.autoSettleTriggered = true;
    runtimeState.sessionState.message = 'Aider already changed files and kept repeating itself, so Local AI Hub asked it to settle and wait for you. Review the console to confirm the result.';
    emitRuntimeSessionState(runtimeState);
    return;
  }

  runtimeState.aiderLastUserInputAt = Date.now();
  runtimeState.aiderLastOutputAt = 0;
  runtimeState.aiderLastFileChangeAt = 0;
  runtimeState.aiderRepeatSignature = '';
  runtimeState.aiderRepeatCount = 0;
  runtimeState.aiderOutputSinceLastFileChange = 0;
  runtimeState.sessionState.phase = 'responding';
  runtimeState.sessionState.waitingForUser = false;
  runtimeState.sessionState.activeTurn = true;
  runtimeState.sessionState.changedFiles = [];
  runtimeState.sessionState.changedFileCount = 0;
  runtimeState.sessionState.autoSettleAttempted = false;
  runtimeState.sessionState.autoSettleTriggered = false;
  runtimeState.sessionState.message = buildAiderRespondingMessage(runtimeState.sessionState);
  emitRuntimeSessionState(runtimeState);
}

function initializeRuntimeSessionTracking(toolState, runtimeState) {
  if (!runtimeState || !shouldTrackAiderSession(toolState)) {
    return;
  }

  runtimeState.sessionState = createAiderSessionState(toolState, runtimeState.launchProfile || toolState.launchProfile);
  runtimeState.lastSessionStateSignature = '';
  runtimeState.aiderWaitingTimer = null;
  runtimeState.aiderProjectWatcher = null;
  runtimeState.aiderLastUserInputAt = 0;
  runtimeState.aiderLastOutputAt = 0;
  runtimeState.aiderLastFileChangeAt = 0;
  runtimeState.aiderRepeatSignature = '';
  runtimeState.aiderRepeatCount = 0;
  runtimeState.aiderOutputSinceLastFileChange = 0;
  startAiderProjectWatcher(runtimeState);
  emitRuntimeSessionState(runtimeState);
}

function markRuntimeSessionReady(runtimeState) {
  if (!runtimeState?.sessionState) {
    return;
  }

  clearAiderWaitingTimer(runtimeState);
  runtimeState.sessionState.phase = 'waiting';
  runtimeState.sessionState.waitingForUser = true;
  runtimeState.sessionState.activeTurn = false;
  runtimeState.sessionState.message = buildAiderWaitingMessage(runtimeState.sessionState);
  emitRuntimeSessionState(runtimeState);
}

function markRuntimeSessionStopped(runtimeState, message = 'Aider stopped. Launch it again to continue coding.') {
  if (!runtimeState?.sessionState) {
    return;
  }

  clearAiderWaitingTimer(runtimeState);
  runtimeState.sessionState.phase = 'stopped';
  runtimeState.sessionState.waitingForUser = false;
  runtimeState.sessionState.activeTurn = false;
  runtimeState.sessionState.message = message;
  emitRuntimeSessionState(runtimeState);
}

function disposeRuntimeSessionTracking(runtimeState) {
  clearAiderWaitingTimer(runtimeState);

  if (runtimeState?.aiderProjectWatcher) {
    runtimeState.aiderProjectWatcher.close();
    runtimeState.aiderProjectWatcher = null;
  }
}

function buildStartupDownloadMessage(runtimeState) {
  const toolName = runtimeState?.startupDownload?.toolName || 'This tool';
  if (runtimeState?.launchConfirmed && !toolUsesLocalUrl(runtimeState)) {
    return `${toolName} is finishing its own first-run setup in its own window. Local AI Hub already launched the app.`;
  }

  return `${toolName} is downloading required files on first launch. This may take several minutes.`;
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

function getManagedToolStateRoot(toolState) {
  const managedRoot = getManagedToolRoot(toolState);
  return managedRoot ? path.join(managedRoot, '.localaihub') : null;
}

async function ensureManagedStableDiffusionConstraintFile(toolState) {
  if (!MANAGED_STABLE_DIFFUSION_TOOL_IDS.has(toolState?.id)) {
    return null;
  }

  const stateRoot = getManagedToolStateRoot(toolState);
  if (!stateRoot) {
    return null;
  }

  const constraintLines = ['numpy<2'];
  if (toolState.id === 'forge') {
    constraintLines.push(MANAGED_FORGE_PYDANTIC_PIN);
  }

  const constraintsDir = path.join(stateRoot, 'pip');
  const constraintPath = path.join(constraintsDir, 'stable-diffusion-constraints.txt');
  await fs.ensureDir(constraintsDir);
  await fs.writeFile(constraintPath, `${constraintLines.join('\n')}\n`, 'utf8');
  return constraintPath;
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

  const stateRoot = getManagedToolStateRoot(toolState);
  const cacheDir = path.join(stateRoot, 'cache');
  const tempDir = path.join(stateRoot, 'tmp');
  const pycacheDir = path.join(stateRoot, 'pycache');
  const hfCacheDir = path.join(cacheDir, 'huggingface');
  const transformersCacheDir = path.join(cacheDir, 'transformers');
  const ollamaModelsDir = toolState.id === 'ollama' ? path.join(getAppPaths().modelsRoot, 'ollama') : null;
  const openWebUiDataDir = toolState.id === 'openwebui' ? path.join(toolState.appDir || managedRoot, 'data') : null;
  const openWebUiFrontendDirCandidate = toolState.id === 'openwebui'
    ? path.join(managedRoot, '.venv', 'Lib', 'site-packages', 'open_webui', 'frontend')
    : null;
  const openWebUiFrontendDir = openWebUiFrontendDirCandidate && await fs.pathExists(openWebUiFrontendDirCandidate)
    ? openWebUiFrontendDirCandidate
    : null;
  const openWebUiPythonEnv = toolState.id === 'openwebui'
    ? {
        PYTHONIOENCODING: 'utf-8',
        PYTHONLEGACYWINDOWSSTDIO: '1',
        PYTHONUTF8: '1',
        ...(openWebUiFrontendDir ? { FRONTEND_BUILD_DIR: openWebUiFrontendDir } : {}),
      }
    : {};

  await Promise.all([
    fs.ensureDir(cacheDir),
    fs.ensureDir(tempDir),
    fs.ensureDir(pycacheDir),
    fs.ensureDir(hfCacheDir),
    fs.ensureDir(transformersCacheDir),
    ollamaModelsDir ? fs.ensureDir(ollamaModelsDir) : Promise.resolve(),
    openWebUiDataDir ? fs.ensureDir(openWebUiDataDir) : Promise.resolve(),
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
    ...(openWebUiDataDir ? { DATA_DIR: openWebUiDataDir } : {}),
    ...openWebUiPythonEnv,
  };
}

function isStableDiffusionApiTool(toolState) {
  return Boolean(toolState?.id && MANAGED_STABLE_DIFFUSION_TOOL_IDS.has(toolState.id));
}

function launchProfileHasArg(launchProfile, argName) {
  return (Array.isArray(launchProfile?.args) ? launchProfile.args : [])
    .some((entry) => String(entry || '').trim().toLowerCase() === argName);
}

function ensureStableDiffusionApiLaunchProfile(toolState, launchProfile) {
  if (
    !isStableDiffusionApiTool(toolState)
    || !launchProfile
    || !['python-script', 'python-module', 'batch'].includes(launchProfile.kind)
    || launchProfileHasArg(launchProfile, '--api')
  ) {
    return launchProfile;
  }

  return {
    ...launchProfile,
    args: ['--api', ...(launchProfile.args || [])],
  };
}
function isManagedStableDiffusionLaunch(toolState, launchProfile) {
  return Boolean(
    toolState
    && MANAGED_STABLE_DIFFUSION_TOOL_IDS.has(toolState.id)
    && (toolState.managedByLocalAIHub || toolState.source === 'managed')
    && (launchProfile?.kind === 'python-script' || launchProfile?.kind === 'python-module')
  );
}

async function inspectManagedTorchRuntime(launchProfile) {
  if (!launchProfile?.pythonPath) {
    return null;
  }

  const inspectionSnippet = [
    'import importlib.util',
    'import json',
    "info = {'installed': False, 'version': None, 'cudaAvailable': False, 'cudaVersion': None, 'importError': None}",
    "spec = importlib.util.find_spec('torch')",
    "info['installed'] = bool(spec)",
    'if spec is not None:',
    '    try:',
    '        import torch',
    "        info['version'] = getattr(torch, '__version__', None)",
    "        info['cudaAvailable'] = bool(torch.cuda.is_available())",
    "        info['cudaVersion'] = getattr(torch.version, 'cuda', None)",
    '    except Exception as exc:',
    "        info['importError'] = str(exc)",
    'print(json.dumps(info))',
  ].join('\n');

  const result = await runCommand(launchProfile.pythonPath, ['-c', inspectionSnippet], {
    allowFailure: true,
    cwd: launchProfile.workingDir,
    env: {
      ...process.env,
      PYTHONNOUSERSITE: '1',
    },
  });

  if (result.code !== 0) {
    return null;
  }

  const payload = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{'));

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function inspectManagedStableDiffusionPythonEnvironment(launchProfile) {
  if (!launchProfile?.pythonPath) {
    return null;
  }

  const inspectionSnippet = [
    'import importlib.util',
    'import json',
    "info = {'pkgResourcesInstalled': False, 'xformersInstalled': False, 'numpyVersion': None, 'numpyImportError': None, 'skimageInstalled': False, 'skimageVersion': None, 'skimageImportError': None, 'pydanticVersion': None, 'pydanticImportError': None}",
    "info['pkgResourcesInstalled'] = bool(importlib.util.find_spec('pkg_resources'))",
    "info['xformersInstalled'] = bool(importlib.util.find_spec('xformers'))",
    "skimage_spec = importlib.util.find_spec('skimage')",
    "info['skimageInstalled'] = bool(skimage_spec)",
    'try:',
    '    import numpy',
    "    info['numpyVersion'] = getattr(numpy, '__version__', None)",
    'except Exception as exc:',
    "    info['numpyImportError'] = str(exc)",
    'if skimage_spec is not None:',
    '    try:',
    '        import skimage',
    "        info['skimageVersion'] = getattr(skimage, '__version__', None)",
    '    except Exception as exc:',
    "        info['skimageImportError'] = str(exc)",
    'try:',
    '    import pydantic',
    "    info['pydanticVersion'] = getattr(pydantic, '__version__', None)",
    'except Exception as exc:',
    "    info['pydanticImportError'] = str(exc)",
    'print(json.dumps(info))',
  ].join('\n');

  const result = await runCommand(launchProfile.pythonPath, ['-c', inspectionSnippet], {
    allowFailure: true,
    cwd: launchProfile.workingDir,
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PYTHONNOUSERSITE: '1',
    },
  });

  if (result.code !== 0) {
    return null;
  }

  const payload = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{') && line.endsWith('}'));

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function needsManagedStableDiffusionDependencyRepair(toolState, pythonEnvironment) {
  if (!pythonEnvironment) {
    return false;
  }

  const numpyMajor = Number.parseInt(String(pythonEnvironment.numpyVersion || '').split('.')[0], 10);
  const forgeNeedsPydanticRepair = toolState?.id === 'forge'
    && (
      Boolean(pythonEnvironment.pydanticImportError)
      || String(pythonEnvironment.pydanticVersion || '').trim() !== '2.8.2'
    );
  return (
    !pythonEnvironment.pkgResourcesInstalled
    || (Number.isFinite(numpyMajor) && numpyMajor >= 2)
    || !pythonEnvironment.skimageInstalled
    || Boolean(pythonEnvironment.skimageImportError)
    || forgeNeedsPydanticRepair
  );
}

async function repairManagedStableDiffusionPythonEnvironment(toolState, launchProfile, logger, constraintPath, pythonEnvironment) {
  const packages = [
    MANAGED_STABLE_DIFFUSION_SETUPTOOLS_PIN,
    MANAGED_STABLE_DIFFUSION_NUMPY_PIN,
    MANAGED_STABLE_DIFFUSION_SKIMAGE_PIN,
    ...(toolState?.id === 'forge' ? [MANAGED_FORGE_PYDANTIC_PIN] : []),
  ];

  await logger.info('Repairing managed Stable Diffusion Python packages before launch.', {
    packages,
    pythonEnvironment,
  });

  await runCommand(
    launchProfile.pythonPath,
    [
      '-m',
      'pip',
      'install',
      '--upgrade',
      '--force-reinstall',
      '--no-cache-dir',
      '--prefer-binary',
      ...packages,
    ],
    {
      cwd: launchProfile.workingDir,
      env: {
        ...process.env,
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PYTHONNOUSERSITE: '1',
        ...(constraintPath ? { PIP_CONSTRAINT: constraintPath } : {}),
      },
      errorMessage: `Local AI Hub could not repair ${toolState.name}'s managed Python packages before launch.`,
    },
  );

  const repairedEnvironment = await inspectManagedStableDiffusionPythonEnvironment(launchProfile);
  if (needsManagedStableDiffusionDependencyRepair(toolState, repairedEnvironment)) {
    throw new Error(`${toolState.name} still has missing or incompatible Python packages after Local AI Hub repaired its managed runtime.`);
  }
}

async function prepareManagedStableDiffusionLaunchProfile(toolState, launchProfile) {
  if (!isManagedStableDiffusionLaunch(toolState, launchProfile)) {
    return launchProfile;
  }

  const constraintPath = await ensureManagedStableDiffusionConstraintFile(toolState);
  const logger = createRuntimeLogger(toolState, launchProfile, {
    launchContext: 'prelaunch-runtime-check',
  });
  const pythonEnvironment = await inspectManagedStableDiffusionPythonEnvironment(launchProfile);
  if (needsManagedStableDiffusionDependencyRepair(toolState, pythonEnvironment)) {
    await repairManagedStableDiffusionPythonEnvironment(toolState, launchProfile, logger, constraintPath, pythonEnvironment);
  }

  const managedStableDiffusionEnv = {
    ...(launchProfile.env || {}),
    CLIP_PACKAGE: MANAGED_STABLE_DIFFUSION_CLIP_PACKAGE,
    ...(constraintPath ? { PIP_CONSTRAINT: constraintPath } : {}),
    ...(toolState.id === 'automatic1111' ? { STABLE_DIFFUSION_REPO: MANAGED_STABLE_DIFFUSION_REPO_URL } : {}),
  };

  const [hardwareSnapshot, nvidia] = await Promise.all([
    detectHardwareSnapshot().catch(() => null),
    getNvidiaRuntimeDetails().catch(() => null),
  ]);
  const hardware = {
    ...hardwareSnapshot,
    ...(nvidia || {}),
    nvidiaSmiAvailable: Boolean(nvidia?.nvidiaSmiAvailable || hardwareSnapshot?.nvidiaSmiAvailable),
  };
  const args = [...(launchProfile.args || [])];
  const automatic1111NeedsMedvram =
    toolState.id === 'automatic1111'
    && !args.includes('--medvram')
    && !args.includes('--lowvram')
    && (
      (Number(hardware?.vramMb || 0) > 0 && Number(hardware.vramMb) <= Math.max(6144, Number(toolState?.compatibility?.minimumVramMb || 0)))
      || (
        Number(hardware?.systemRamMb || 0) > 0
        && Number(toolState?.compatibility?.minimumRamMb || 0) > 0
        && Number(hardware.systemRamMb) <= Number(toolState.compatibility.minimumRamMb)
      )
    );

  if (automatic1111NeedsMedvram) {
    args.unshift('--medvram');
    await logger.info('Applying Automatic1111 low-VRAM launch mode.', {
      gpuModel: hardware?.gpuModel || null,
      systemRamMb: hardware?.systemRamMb || null,
      vramMb: hardware?.vramMb || null,
    });
  }

  const preferredBuild = selectPyTorchRepairCandidates(hardware)[0];
  if (!preferredBuild) {
    return {
      ...launchProfile,
      args,
      env: managedStableDiffusionEnv,
    };
  }

  const torchRuntime = await inspectManagedTorchRuntime(launchProfile);
  const needsCudaBootstrap =
    !torchRuntime
    || !torchRuntime.installed
    || Boolean(torchRuntime.importError)
    || !torchRuntime.cudaAvailable
    || !torchRuntime.cudaVersion;

  if (!needsCudaBootstrap) {
    return {
      ...launchProfile,
      args,
      env: managedStableDiffusionEnv,
    };
  }

  if (!args.includes('--reinstall-torch')) {
    args.unshift('--reinstall-torch');
  }

  return {
    ...launchProfile,
    args,
    env: {
      ...managedStableDiffusionEnv,
      TORCH_INDEX_URL: preferredBuild.indexUrl,
    },
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

function getCombinedRuntimeOutput(runtimeState) {
  return `${runtimeState?.stdoutLogBuffer || runtimeState?.stdoutBuffer || ''}\n${runtimeState?.stderrLogBuffer || runtimeState?.stderrBuffer || ''}`.trim();
}

function outputMentionsExpectedUrl(toolState, output) {
  const normalizedOutput = String(output || '').toLowerCase();
  return getExpectedLocalMarkers(toolState).some((marker) => normalizedOutput.includes(marker));
}

function getWindowsExitDescription(code) {
  switch (code >>> 0) {
    case 3221225477:
      return 'a native access violation';
    default:
      return '';
  }
}

function shouldPreferExitCodeContext(message, failureText) {
  const normalized = `${message || ''}\n${failureText || ''}`.toLowerCase();
  return (
    (normalized.includes('warnings.warn(') || normalized.includes('futurewarning:'))
    && !/(traceback|error:|exception|assertionerror|modulenotfounderror|filenotfounderror|runtimeerror|valueerror|permissionerror)/.test(normalized)
  );
}

function hasStructuredPythonFailure(output) {
  return /(traceback|error:|exception|assertionerror|modulenotfounderror|filenotfounderror|runtimeerror|valueerror|permissionerror)/i.test(String(output || ''));
}

function buildAutomatic1111NativeCrashMessage(toolState, runtimeState, exitContext) {
  if (toolState?.id !== 'automatic1111' || exitContext.unsignedExitCode !== 3221225477) {
    return '';
  }

  const combinedOutput = getCombinedRuntimeOutput(runtimeState);
  if (hasStructuredPythonFailure(combinedOutput)) {
    return '';
  }

  const loadedWeights = /Loading weights \[/i.test(combinedOutput);
  const creatingModelFromConfig = /Creating model from config:/i.test(combinedOutput);
  const lowVramProfileActive = /Launching Web UI with arguments:.*--(?:med|low)vram\b/i.test(combinedOutput);
  const xformersUnavailable = /No module 'xformers'\. Proceeding without it\./i.test(combinedOutput) || /no module 'xformers'\. Processing without/i.test(combinedOutput);
  const stageMessage = exitContext.reachedLocalUrl
    ? `${toolState.name} finished its bootstrap work, answered its local API, and then a native Windows component crashed while the runtime was bringing up the web UI and first model load.`
    : creatingModelFromConfig
      ? `${toolState.name} loaded its checkpoint and began constructing its Stable Diffusion model, then a native Windows component crashed before the local API became available.`
      : loadedWeights
        ? `${toolState.name} loaded its checkpoint and then a native Windows component crashed before it could finish constructing the Stable Diffusion model and local API.`
        : `${toolState.name} hit a native Windows crash during Automatic1111 startup before its local API became available.`;
  const lowVramMessage = lowVramProfileActive
    ? 'Local AI Hub had already applied its general Automatic1111 low-VRAM launch mode for this run, so the remaining failure is beyond the broad launch-profile adjustment Local AI Hub can safely make. '
    : '';
  const xformersMessage = xformersUnavailable
    ? 'The captured output already shows that Automatic1111 had fallen back away from xformers, so this is not an xformers-enabled launch path. '
    : '';

  return `${stageMessage} ${lowVramMessage}${xformersMessage}Local AI Hub did not capture a Python traceback, so this points to Automatic1111's native CUDA or PyTorch runtime stack on this machine rather than its install or first-run download state. Windows reported exit code ${exitContext.unsignedExitCode} (${exitContext.hexExitCode}), which usually means ${exitContext.exitDescription}. Open the logs folder for the full launch details.`;
}

function buildFooocusNativeCrashMessage(toolState, runtimeState, exitContext) {
  if (toolState?.id !== 'fooocus' || exitContext.unsignedExitCode !== 3221225477) {
    return '';
  }

  const combinedOutput = getCombinedRuntimeOutput(runtimeState);
  if (hasStructuredPythonFailure(combinedOutput)) {
    return '';
  }

  const reachedCudaStartup = /device:\s*cuda:/i.test(combinedOutput) || /vae dtype:/i.test(combinedOutput);
  const stageMessage = exitContext.reachedLocalUrl
    ? `${toolState.name} reached its local URL and then a native Windows component inside Fooocus crashed.`
    : reachedCudaStartup
      ? `${toolState.name} finished its initial CUDA startup steps and then a native Windows component inside Fooocus crashed before the web UI became available.`
      : `${toolState.name} hit a native Windows crash before its web UI became available.`;

  return `${stageMessage} Local AI Hub did not receive a Python traceback, so this points to Fooocus's embedded runtime rather than its install or library state. Windows reported exit code ${exitContext.unsignedExitCode} (${exitContext.hexExitCode}), which usually means ${exitContext.exitDescription}. Open the logs folder for the full launch details.`;
}
function buildExitCodeContextMessage(toolState, runtimeState) {
  const exitCode = Number(runtimeState?.process?.exitCode);
  if (!Number.isFinite(exitCode) || exitCode === 0) {
    return '';
  }

  const unsignedExitCode = exitCode >>> 0;
  const hexExitCode = `0x${unsignedExitCode.toString(16).toUpperCase().padStart(8, '0')}`;
  const combinedOutput = getCombinedRuntimeOutput(runtimeState);
  const reachedLocalUrl = outputMentionsExpectedUrl(toolState, combinedOutput);
  const exitDescription = getWindowsExitDescription(unsignedExitCode);
  const automatic1111NativeCrashMessage = buildAutomatic1111NativeCrashMessage(toolState, runtimeState, {
    unsignedExitCode,
    hexExitCode,
    reachedLocalUrl,
    exitDescription,
  });
  if (automatic1111NativeCrashMessage) {
    return automatic1111NativeCrashMessage;
  }

  const fooocusNativeCrashMessage = buildFooocusNativeCrashMessage(toolState, runtimeState, {
    unsignedExitCode,
    hexExitCode,
    reachedLocalUrl,
    exitDescription,
  });
  if (fooocusNativeCrashMessage) {
    return fooocusNativeCrashMessage;
  }
  const stageVerb = exitDescription ? 'crashed' : 'stopped';
  const stageMessage = reachedLocalUrl
    ? `${toolState.name} reached its local URL and then ${stageVerb}`
    : `${toolState.name} ${stageVerb} before it finished starting`;
  const reasonMessage = exitDescription
    ? `Windows reported exit code ${unsignedExitCode} (${hexExitCode}), which usually means ${exitDescription}.`
    : `Windows reported exit code ${unsignedExitCode} (${hexExitCode}).`;
  return `${stageMessage}. ${reasonMessage} Open the logs folder for the full launch details.`;
}

function buildConcreteLaunchFailureMessage(toolState, runtimeState, fallbackMessage) {
  const combinedOutput = getCombinedRuntimeOutput(runtimeState);
  const failureText = collectMeaningfulFailureText(toolState, combinedOutput);
  if (!failureText) {
    return buildExitCodeContextMessage(toolState, runtimeState) || fallbackMessage;
  }

  const diagnosis = diagnoseLaunchFailure(toolState, failureText);
  if (diagnosis?.recognized && diagnosis.summary) {
    return diagnosis.summary;
  }

  if (shouldPreferExitCodeContext(diagnosis?.summary || '', failureText)) {
    const exitCodeMessage = buildExitCodeContextMessage(toolState, runtimeState);
    if (exitCodeMessage) {
      return exitCodeMessage;
    }
  }

  return diagnosis?.summary || humanizeError(failureText, fallbackMessage);
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
    return response.ok;
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

async function waitForNamedProcesses(processNames = [], timeoutMs = SUCCESS_CONFIRM_TIMEOUT_MS) {
  const normalizedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Number(timeoutMs) : SUCCESS_CONFIRM_TIMEOUT_MS;
  const deadline = Date.now() + normalizedTimeoutMs;

  while (Date.now() <= deadline) {
    const runningProcessNames = await getRunningProcessNames(processNames);
    if (runningProcessNames.length > 0) {
      return runningProcessNames;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(500, remainingMs));
  }

  return [];
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

  if (toolUsesLocalUrl(toolState)) {
    if (await probeUrl(toolState.healthUrl)) {
      return true;
    }

    if (toolState.launchUrl && String(toolState.launchUrl).trim() !== String(toolState.healthUrl || '').trim() && await probeUrl(toolState.launchUrl)) {
      return true;
    }
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
  const shouldBypassInterfaceProbe = isStableDiffusionApiTool(toolState)
    && Boolean(toolState.healthUrl)
    && String(toolState.healthUrl).trim() !== String(toolState.launchUrl).trim();

  if (shouldBypassInterfaceProbe) {
    // Stable Diffusion WebUI tools can answer the API before the heavier Gradio root page is safe to probe.
    await sleep(1500);
    await shell.openExternal(launchUrl).catch(() => null);
    return;
  }

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
    message: buildStartupDownloadMessage(runtimeState),
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
  if (!state || runtimeState?.launchConfirmed) {
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

function appendRuntimeOutput(toolState, runtimeState, key, chunk) {
  const content = typeof chunk === 'string' ? chunk : chunk?.toString?.() || '';
  runtimeState[key] = trimBufferedOutput(`${runtimeState[key] || ''}${content}`, OUTPUT_BUFFER_LIMIT);

  const logKey = key === 'stderrBuffer' ? 'stderrLogBuffer' : 'stdoutLogBuffer';
  runtimeState[logKey] = trimBufferedOutput(`${runtimeState[logKey] || ''}${content}`, OUTPUT_LOG_LIMIT);

  analyzeStartupDownloadOutput(runtimeState, key === 'stderrBuffer' ? 'stderr' : 'stdout', content);
  trackAiderRuntimeOutput(runtimeState, content);
  maybeStopAiderForHardFailure(toolState, runtimeState).catch(() => null);
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

function initializeRuntimeStartupOutcome(runtimeState) {
  if (!runtimeState || runtimeState.startupOutcomePromise) {
    return;
  }

  runtimeState.startupOutcome = null;
  runtimeState.startupOutcomeSettled = false;
  runtimeState.startupOutcomePromise = new Promise((resolve) => {
    runtimeState.resolveStartupOutcome = resolve;
  });
}

function settleRuntimeStartupOutcome(runtimeState, outcome = {}) {
  if (!runtimeState || runtimeState.startupOutcomeSettled) {
    return;
  }

  runtimeState.startupOutcomeSettled = true;
  runtimeState.startupOutcome = outcome;
  if (typeof runtimeState.resolveStartupOutcome === 'function') {
    runtimeState.resolveStartupOutcome(outcome);
    runtimeState.resolveStartupOutcome = null;
  }
}

async function waitForRuntimeStartupOutcome(runtimeState, timeoutMs = AIDER_STARTUP_RECOVERY_WAIT_MS) {
  if (!runtimeState?.startupOutcomePromise) {
    return null;
  }

  if (runtimeState.startupOutcomeSettled) {
    return runtimeState.startupOutcome;
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(runtimeState.startupOutcome || null), timeoutMs);
    runtimeState.startupOutcomePromise
      .then((outcome) => {
        clearTimeout(timer);
        resolve(outcome || null);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(runtimeState.startupOutcome || null);
      });
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

async function stopRuntimeProcess(toolId, runtimeState, options = {}) {
  pendingStartupMonitors.delete(toolId);
  const sessionMessage = options.sessionMessage || runtimeState?.hardFailureMessage || 'Aider stopped. Launch it again to continue coding.';

  if (!runtimeState?.process?.pid) {
    markRuntimeSessionStopped(runtimeState, sessionMessage);
    disposeRuntimeSessionTracking(runtimeState);
    clearLaunchProgress(runtimeState);
    clearRuntime(toolId, runtimeState);
    return;
  }

  runtimeState.stopping = true;
  markRuntimeSessionStopped(runtimeState, sessionMessage);
  disposeRuntimeSessionTracking(runtimeState);
  clearLaunchProgress(runtimeState);
  await killProcessTree(runtimeState.process.pid).catch(() => null);
  await waitForRuntimeExit(runtimeState).catch(() => false);
  clearRuntime(toolId, runtimeState);
  await runRuntimeStopCleanup(runtimeState).catch((error) => logRuntimeStopCleanupFailure(runtimeState, 'internal-stop', error));
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

        const message = runtimeState?.process?.exitCode === null
          ? buildPendingStartupFailureMessage(toolState, target)
          : buildConcreteLaunchFailureMessage(toolState, runtimeState, buildPendingStartupFailureMessage(toolState, target));
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

      const timeoutMessage = `${toolState.name} did not answer on ${target} before Local AI Hub's startup check finished. Open the logs folder for the full launch details.`;
      const launchFailureMessage = !processStillRunning && runningProcessNames.length === 0
        ? buildConcreteLaunchFailureMessage(toolState, runtimeState, timeoutMessage)
        : timeoutMessage;

      await stopRuntimeProcess(toolState.id, runtimeState);
      throw new Error(launchFailureMessage);
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

  if (toolState?.id === 'aider' && runtimeState.process?.exitCode === null && !runtimeState.stopping) {
    await waitForRuntimeExit(runtimeState, AIDER_STARTUP_SETTLE_MS);
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

  const runningProcessNames = runtimeState.launchedViaShell
    ? await waitForNamedProcesses(toolState.processNames)
    : await getRunningProcessNames(toolState.processNames);
  if (runningProcessNames.length > 0) {
    await logger.info(runtimeState.launchedViaShell
      ? 'Tool launch was confirmed by an active process after Windows opened the app.'
      : 'Tool launch was confirmed by an active process after the launcher exited.', {
      runningProcessNames,
    });
    runtimeState.launchConfirmed = true;
    clearLaunchProgress(runtimeState);
    return {
      status: 'running',
    };
  }

  throw new Error(runtimeState.launchedViaShell
    ? `${toolState.name} did not leave a running app process after Windows tried to open it.`
    : `${toolState.name} stopped before Local AI Hub could confirm that it launched.`);
}
async function confirmLaunchAfterExit(toolState, runtimeState = null) {
  if (toolUsesLocalUrl(toolState)) {
    const confirmationTimeoutMs = runtimeState?.launchConfirmed
      ? SUCCESS_CONFIRM_TIMEOUT_MS
      : Math.min(
          Math.max(SUCCESS_CONFIRM_TIMEOUT_MS, getStartupTimeoutMs(toolState, SUCCESS_CONFIRM_TIMEOUT_MS)),
          60000,
        );

    return {
      running: await waitForToolReady(
        toolState,
        confirmationTimeoutMs,
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
  markRuntimeSessionStopped(
    runtimeState,
    runtimeState.hardFailureMessage
      ? runtimeState.hardFailureMessage
      : runtimeState.stopping
        ? 'Aider stopped. Launch it again to continue coding.'
        : 'Aider stopped. Review the console and launch it again when you want to continue.',
  );
  disposeRuntimeSessionTracking(runtimeState);
  runtimeExitSettlingToolIds.add(toolState.id);

  try {
    clearRuntime(toolState.id, runtimeState);

    const logger = runtimeState.logger || createRuntimeLogger(toolState, runtimeState.launchProfile || toolState.launchProfile, runtimeOptions);
    const combinedOutput = `${runtimeState.stdoutLogBuffer || runtimeState.stdoutBuffer || ''}
${runtimeState.stderrLogBuffer || runtimeState.stderrBuffer || ''}`.trim();

    if (runtimeState.stopping) {
      if (runtimeState.hardFailureMessage) {
        await logger.warn('Tool runtime was stopped by Local AI Hub after a hard runtime failure.', {
          exitCode: code,
          signal,
          hardFailureMessage: runtimeState.hardFailureMessage,
        });
        await upsertTool({
          id: toolState.id,
          status: 'error',
          lastError: runtimeState.hardFailureMessage,
          lastRepairMessage: null,
        });
        emitToolState(toolState.id, {
          status: 'error',
          lastError: runtimeState.hardFailureMessage,
          lastRepairMessage: null,
        });
        settleRuntimeStartupOutcome(runtimeState, {
          status: 'error',
          recovered: false,
          message: runtimeState.hardFailureMessage,
        });
        emitUnexpectedStop(toolState, runtimeState.hardFailureMessage);
        return;
      }

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
      await runRuntimeStopCleanup(runtimeState).catch((error) => logRuntimeStopCleanupFailure(runtimeState, 'clean-exit-before-ready', error));
      settleRuntimeStartupOutcome(runtimeState, {
        status: 'stopped',
      });
      return;
    }

    const launchState = await confirmLaunchAfterExit(toolState, runtimeState);
    if (launchState.running) {
      await logger.info(runtimeState.launchConfirmed
        ? 'Launcher process exited, but the tool is still available.'
        : 'Launch process exited after the tool became available.', {
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
      settleRuntimeStartupOutcome(runtimeState, {
        status: 'running',
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
      await runRuntimeStopCleanup(runtimeState).catch((error) => logRuntimeStopCleanupFailure(runtimeState, 'clean-exit-before-ready', error));
      settleRuntimeStartupOutcome(runtimeState, {
        status: 'stopped',
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
            return launchToolInternal(nextToolState, {
              autoRecoveryAttempted: true,
              launchContext: 'automatic-recovery',
            });
          },
        });

    if (recoveryResult?.recovered) {
      settleRuntimeStartupOutcome(runtimeState, {
        status: 'running',
        recovered: true,
        message: recoveryResult.userMessage || null,
      });
      return;
    }

    let message = recoveryResult?.userMessage;
    if (message && shouldPreferExitCodeContext(message, failureText)) {
      message = buildExitCodeContextMessage(toolState, runtimeState) || message;
    }

    if (!message) {
      message = buildExitCodeContextMessage(toolState, runtimeState);
    }

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

    if (!wasRunning && runtimeState.startupCheckPending) {
      runtimeState.startupFailureMessage = message;
      settleRuntimeStartupOutcome(runtimeState, {
        status: 'error',
        recovered: false,
        message,
      });
      return;
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
    await runRuntimeStopCleanup(runtimeState).catch((error) => logRuntimeStopCleanupFailure(runtimeState, 'unexpected-exit', error));
    settleRuntimeStartupOutcome(runtimeState, {
      status: 'error',
      recovered: false,
      message,
    });
    emitUnexpectedStop(toolState, message);
  } finally {
    runtimeExitSettlingToolIds.delete(toolState.id);
  }
}

function attachRuntimeHandlers(toolState, runtimeState, runtimeOptions = {}) {
  const child = runtimeState.process;

  child.stdout?.on('data', (chunk) => {
    appendRuntimeOutput(toolState, runtimeState, 'stdoutBuffer', chunk);
  });

  child.stderr?.on('data', (chunk) => {
    appendRuntimeOutput(toolState, runtimeState, 'stderrBuffer', chunk);
  });

  child.on('close', (code, signal) => {
    handleRuntimeExit(toolState, runtimeState, code, signal, runtimeOptions).catch(() => null);
  });

  child.on('error', (error) => {
    appendRuntimeOutput(toolState, runtimeState, 'stderrBuffer', error?.message || String(error));
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
    launchUrl: toolState.launchUrl || null,
    healthUrl: toolState.healthUrl || null,
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

  attachRuntimeLifecycle(runtimeState, runtimeOptions);
  initializeRuntimeStartupOutcome(runtimeState);
  initializeRuntimeSessionTracking(toolState, runtimeState);
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

  if (getToolInterfaceMode(toolState) === 'desktop-app') {
    const launchError = await shell.openPath(safeLaunchProfile.executable);
    if (launchError) {
      throw new Error(launchError);
    }

    return {
      kind: 'binary-shell',
      toolId: toolState.id,
      toolName: toolState.name,
      launchUrl: toolState.launchUrl || null,
      healthUrl: toolState.healthUrl || null,
      process: null,
      logger,
      launchProfile: safeLaunchProfile,
      startupDownload: createStartupDownloadState(toolState),
      stdoutBuffer: '',
      stderrBuffer: '',
      stdoutLogBuffer: '',
      stderrLogBuffer: '',
      stopping: false,
      exitHandled: false,
      launchedViaShell: true,
    };
  }

  const child = spawn(safeLaunchProfile.executable, safeLaunchProfile.args || [], {
    cwd: safeLaunchProfile.workingDir || path.dirname(safeLaunchProfile.executable),
    windowsHide: true,
    env: await buildLaunchRuntimeEnv(toolState, safeLaunchProfile.env || {}),
  });

  const runtimeState = rememberRuntime(toolState.id, {
    kind: 'binary',
    toolId: toolState.id,
    toolName: toolState.name,
    launchUrl: toolState.launchUrl || null,
    healthUrl: toolState.healthUrl || null,
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

  attachRuntimeLifecycle(runtimeState, runtimeOptions);
  initializeRuntimeStartupOutcome(runtimeState);
  initializeRuntimeSessionTracking(toolState, runtimeState);
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
    launchUrl: toolState.launchUrl || null,
    healthUrl: toolState.healthUrl || null,
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

  attachRuntimeLifecycle(runtimeState, runtimeOptions);
  initializeRuntimeStartupOutcome(runtimeState);
  initializeRuntimeSessionTracking(toolState, runtimeState);
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
    markRuntimeSessionReady(runtime);
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

  let launchProfile = resolveLaunchProfile(toolState, mergeLaunchProfiles(toolState.launchProfile, options.launchProfileOverride));
  if (!launchProfile) {
    throw new Error(`${toolState.name} does not have a launch profile yet.`);
  }

  launchProfile = await prepareManagedStableDiffusionLaunchProfile(toolState, launchProfile);
  launchProfile = ensureStableDiffusionApiLaunchProfile(toolState, launchProfile);

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

  let runtimeState = null;

  try {
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

    runtimeState.startupCheckPending = true;
    let launchResult = null;
    try {
      launchResult = await waitForLaunchConfirmation(toolState, runtimeState, runtimeState.logger, options);
    } finally {
      if (runtimeState) {
        runtimeState.startupCheckPending = false;
      }
    }
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
    markRuntimeSessionReady(runtimeState);

    if (!options.skipOpenInterface) {
      openToolInterface(toolState).catch(() => null);
    }

    return {
      ...toolState,
      status: 'running',
      lastError: null,
    };
  } catch (error) {
    let startupOutcome = null;
    if (toolState.id === 'aider' && runtimeState) {
      startupOutcome = await waitForRuntimeStartupOutcome(runtimeState);
      if (startupOutcome?.recovered && startupOutcome.status === 'running') {
        return {
          ...toolState,
          status: 'running',
          lastError: null,
        };
      }
    }

    const message = startupOutcome?.message
      || runtimeState?.startupFailureMessage
      || humanizeError(error, `${toolState.name} could not start.`);
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
    try {
      await runRuntimeStopCleanup(runtime);
    } catch (error) {
      throw new Error(humanizeError(error, toolState.name + ' stopped, but Local AI Hub could not shut down the supporting runtime it started for this session.'));
    }
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
  isToolRuntimeSettling,
  isToolReady,
  launchToolFromUserAction,
  prepareToolForMaintenance,
  resolveToolStatus,
  sendInputToTool,
  setRuntimeEventSink,
  stopTool,
};
