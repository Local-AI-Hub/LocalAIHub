const assert = require('assert');

const {
  buildOllamaUnavailableMessage,
  chatWithOllama,
  waitForOllamaReady,
} = require('../electron/services/ollamaService');

const tool = {
  defaultPort: 11434,
  id: 'ollama',
  name: 'Ollama',
};

async function testWaitsUntilTagsEndpointAnswers() {
  let attempts = 0;
  const result = await waitForOllamaReady(tool, {
    fetch: async (url) => {
      attempts += 1;
      assert(url.endsWith('/api/tags'), 'Expected readiness probe to use the Ollama tags endpoint.');
      if (attempts < 3) {
        throw new Error('not ready yet');
      }
      return { ok: true };
    },
    intervalMs: 1,
    probeTimeoutMs: 1,
    timeoutMs: 100,
  });

  assert.strictEqual(result.ready, true);
  assert.strictEqual(result.baseUrl, 'http://127.0.0.1:11434');
  assert.strictEqual(attempts, 3, 'Expected polling to retry until the API is ready.');
}

async function testReadinessFailureUsesBoundedWizardMessage() {
  let attempts = 0;
  await assert.rejects(
    () => waitForOllamaReady(tool, {
      actionLabel: 'run the wizard model',
      autoStartAttempted: true,
      fetch: async () => {
        attempts += 1;
        return { ok: false };
      },
      intervalMs: 1,
      probeTimeoutMs: 1,
      timeoutMs: 8,
    }),
    (error) => {
      assert(error.message.includes('cannot run the wizard model'), 'Expected action-specific wizard readiness message.');
      assert(error.message.includes('tried to start Ollama'), 'Expected auto-start context in readiness failure.');
      return true;
    },
  );
  assert(attempts >= 1, 'Expected at least one readiness probe before failing.');
}

function testUnavailableMessageWithoutAutoStartStillPointsToLibrary() {
  const message = buildOllamaUnavailableMessage(tool, {
    actionLabel: 'run the wizard model',
    autoStartAttempted: false,
  });
  assert(message.includes('Start Ollama from Library and try again.'));
}

function testUnavailableMessageForActiveButUnreadyOllama() {
  const message = buildOllamaUnavailableMessage(tool, {
    actionLabel: 'refresh local models',
    alreadyActive: true,
    autoStartAttempted: false,
  });
  assert(message.includes('appears to be running'), 'Expected active-but-unready context.');
  assert(message.includes('Restart Ollama from Library'), 'Expected restart guidance instead of plain start guidance.');
}

async function testChatTimeoutKeepsPayloadMessage() {
  await assert.rejects(
    () => chatWithOllama(tool, {
      fetch: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
      messages: [{ role: 'user', content: 'Draft a JSON plan.' }],
      model: 'llama3.1:8b',
      timeoutMessage: 'Wizard local draft timed out plainly.',
      timeoutMs: 25,
    }),
    (error) => {
      assert.strictEqual(error.message, 'Wizard local draft timed out plainly.');
      return true;
    },
  );
}

async function testChatNetworkFailureIsNotReadinessMessage() {
  await assert.rejects(
    () => chatWithOllama(tool, {
      fetch: async () => {
        throw new Error('read ECONNRESET');
      },
      messages: [{ role: 'user', content: 'Draft a JSON plan.' }],
      model: 'llama3.1:8b',
    }),
    (error) => {
      assert(error.message.includes('could not complete the chat request'), 'Expected a chat-specific failure message.');
      assert(!error.message.includes('not answering on'), 'Chat failure should not be mislabeled as a readiness failure.');
      return true;
    },
  );
}

async function testChatPayloadCanRequestJsonMode() {
  let requestBody = null;
  const result = await chatWithOllama(tool, {
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        text: async () => JSON.stringify({ message: { role: 'assistant', content: '{"ok":true}' }, model: 'llama3.1:8b' }),
      };
    },
    format: 'json',
    messages: [{ role: 'user', content: 'Draft a JSON plan.' }],
    model: 'llama3.1:8b',
    options: { temperature: 0.2 },
  });

  assert.strictEqual(requestBody.format, 'json');
  assert.strictEqual(requestBody.options.temperature, 0.2);
  assert.strictEqual(result.message.content, '{"ok":true}');
}

(async () => {
  await testWaitsUntilTagsEndpointAnswers();
  await testReadinessFailureUsesBoundedWizardMessage();
  testUnavailableMessageWithoutAutoStartStillPointsToLibrary();
  testUnavailableMessageForActiveButUnreadyOllama();
  await testChatTimeoutKeepsPayloadMessage();
  await testChatNetworkFailureIsNotReadinessMessage();
  await testChatPayloadCanRequestJsonMode();
  console.log('Ollama readiness verifier passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
