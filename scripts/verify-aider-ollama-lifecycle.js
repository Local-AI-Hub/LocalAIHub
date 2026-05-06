const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const {
  __testing,
  finishOllamaSession,
  getOllamaLifecycleTimeouts,
} = require('../electron/services/ollamaService');
const { __testing: processTesting } = require('../electron/services/processService');

const tool = {
  defaultPort: 11434,
  id: 'ollama',
  launchUrl: 'http://127.0.0.1:11434',
  name: 'Ollama',
};

class FakeChild extends EventEmitter {
  constructor({ pid = 0, closeOnKill = true } = {}) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.killCalls = 0;
    this.pid = pid;
    this.closeOnKill = closeOnKill;
  }

  kill() {
    this.killCalls += 1;
    this.killed = true;
    if (this.closeOnKill) {
      setImmediate(() => {
        this.exitCode = 0;
        this.emit('close', 0, null);
      });
    }
    return true;
  }
}

async function testExternalSessionIsNotKilled() {
  const child = new FakeChild();
  const result = await finishOllamaSession({
    serveProcess: child,
    startedByLocalAIHub: false,
    tool,
  });

  assert.strictEqual(child.killCalls, 0, 'External Ollama processes must not be killed.');
  assert.strictEqual(result.reason, 'external-or-unowned');
}

async function testOwnedSessionStopsGracefully() {
  __testing.resetOwnedOllamaSessions();
  const child = new FakeChild({ closeOnKill: true });
  const session = __testing.registerOwnedOllamaServeProcess(tool, child, {
    autoStarted: true,
    launchAttempted: true,
  });

  const result = await finishOllamaSession(session);
  assert.strictEqual(child.killCalls, 1, 'Owned Ollama should receive a stop request.');
  assert.strictEqual(result.stopped, true);
  assert.strictEqual(result.forced, false);
  assert.strictEqual(__testing.getOwnedOllamaSessionCount(), 0);
}

async function testSharedOwnedSessionWaitsForLastOwner() {
  __testing.resetOwnedOllamaSessions();
  const child = new FakeChild({ closeOnKill: true });
  const ownerA = __testing.registerOwnedOllamaServeProcess(tool, child, {
    autoStarted: true,
    launchAttempted: true,
  });
  const ownerB = __testing.acquireExistingOwnedOllamaSession(tool, {
    alreadyActive: true,
  });

  const firstRelease = await finishOllamaSession(ownerA);
  assert.strictEqual(firstRelease.reason, 'still-in-use');
  assert.strictEqual(firstRelease.remainingOwners, 1);
  assert.strictEqual(child.killCalls, 0, 'Shared owned Ollama should keep running until the last owner releases it.');

  const secondRelease = await finishOllamaSession(ownerB);
  assert.strictEqual(secondRelease.stopped, true);
  assert.strictEqual(child.killCalls, 1, 'Last owner should stop the owned Ollama process.');
  assert.strictEqual(__testing.getOwnedOllamaSessionCount(), 0);
}

function testOwnedOllamaPidIdentificationPreservesExternal() {
  const processes = [
    {
      commandLine: 'C:\\Program Files\\Ollama\\ollama.exe serve',
      executablePath: 'C:\\Program Files\\Ollama\\ollama.exe',
      parentPid: 1,
      pid: 100,
    },
    {
      commandLine: 'C:\\Program Files\\Ollama\\ollama.exe serve',
      executablePath: 'C:\\Program Files\\Ollama\\ollama.exe',
      parentPid: 20,
      pid: 200,
    },
    {
      commandLine: 'C:\\Program Files\\Ollama\\ollama.exe runner',
      executablePath: 'C:\\Program Files\\Ollama\\ollama.exe',
      parentPid: 200,
      pid: 201,
    },
  ];

  const ownedPids = __testing.identifyOwnedOllamaProcesses(processes, {
    childPid: 200,
    executablePath: 'C:\\Program Files\\Ollama\\ollama.exe',
    preStartPids: [100],
  });

  assert.deepStrictEqual(ownedPids.sort((a, b) => a - b), [200, 201], 'Pre-existing external Ollama PIDs must be excluded from owned cleanup.');
}

async function testOwnedCleanupVerifiesConcretePidSet() {
  const child = new FakeChild({ closeOnKill: true, pid: 0 });
  const result = await __testing.stopOwnedOllamaServeProcess({
    ownedPids: [999999],
    serveProcess: child,
    startedByLocalAIHub: true,
    tool,
  }, { timeoutMs: 1, forceVerifyMs: 1 });

  assert.strictEqual(child.killCalls, 1);
  assert.strictEqual(result.stopped, true);
  assert.deepStrictEqual(result.ownedPids, [999999], 'Cleanup should operate on recorded concrete Ollama PIDs, not just the child wrapper.');
}

function testTimeoutsAreDocumented() {
  const timeouts = getOllamaLifecycleTimeouts();
  assert.strictEqual(timeouts.readinessMs, 90000);
  assert.strictEqual(timeouts.readinessProbeMs, 3000);
  assert.strictEqual(timeouts.cleanupGracefulStopMs, 15000);
  assert.strictEqual(timeouts.cleanupForceVerifyMs, 5000);
  assert.strictEqual(timeouts.chatRequestMs, 10 * 60 * 1000);
}

function testAiderOllamaTimeoutRetryClassifier() {
  const runtimeState = {
    toolId: 'aider',
    launchProfile: {
      args: ['--model', 'ollama_chat/qwen2.5-coder:7b'],
    },
    stdoutBuffer: '',
    stderrBuffer: 'litellm.APIConnectionError: Ollama_chatException - litellm.Timeout: Connection timed out after 600.0 seconds.\nRetrying in 0.2 seconds...',
  };
  const classification = processTesting.getAiderOllamaTimeoutRetryClassification(runtimeState);
  assert(classification, 'Expected LiteLLM/Ollama timeout plus retry output to be classified.');
  assert.strictEqual(classification.kind, 'aider-ollama-timeout-retry');
  assert.strictEqual(classification.timeoutSeconds, 600);
  assert(classification.message.includes('stopped this Aider session'), 'Expected a plain-English terminal-state message.');

  const slowButStillWorking = {
    ...runtimeState,
    stderrBuffer: 'litellm.Timeout: Connection timed out after 600.0 seconds.',
  };
  assert.strictEqual(processTesting.getAiderOllamaTimeoutRetryClassification(slowButStillWorking), null, 'A timeout without an Aider retry marker should not be classified as terminal.');
}

function testProcessServiceShutdownRunsCleanup() {
  const processServicePath = path.resolve(__dirname, '..', 'electron', 'services', 'processService.js');
  const source = fs.readFileSync(processServicePath, 'utf8');
  assert(source.includes("logRuntimeStopCleanupFailure(runtime, 'app-shutdown'"), 'App shutdown should run runtime support cleanup.');
  assert(source.includes('if (!shouldTrackAiderSession(toolState))'), 'Aider exit must not be reclassified as a still-running launcher.');
  assert(source.includes("'startup-failure-before-confirmed'"), 'Startup failure should run support cleanup.');
  assert(source.includes('const PROCESS_GRACEFUL_STOP_MS = 5000'), 'Stop should have a bounded graceful phase before force kill.');
  assert(source.includes("cleanupContext: 'aider-terminal-output'"), 'Aider terminal timeout finalization should run support cleanup.');
  assert(source.includes("finalStatus: sessionOnlyFailure ? 'stopped' : 'error'"), 'Aider model timeout/retry should stop the session without persisting a tool-level error.');
  assert(source.includes("runtimeState.aiderFailureScope !== 'session'"), 'Session-scoped Aider model errors must not become Library repair errors on process exit.');
}

(async () => {
  await testExternalSessionIsNotKilled();
  await testOwnedSessionStopsGracefully();
  await testSharedOwnedSessionWaitsForLastOwner();
  testOwnedOllamaPidIdentificationPreservesExternal();
  await testOwnedCleanupVerifiesConcretePidSet();
  testTimeoutsAreDocumented();
  testAiderOllamaTimeoutRetryClassifier();
  testProcessServiceShutdownRunsCleanup();
  console.log('Aider/Ollama lifecycle verifier passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
