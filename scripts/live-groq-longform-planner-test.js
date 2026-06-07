const fs = require('fs');
const Module = require('module');
const path = require('path');

const PIPELINE_EXECUTION_SERVICE_PATH = path.join(__dirname, '..', 'electron', 'services', 'pipelineExecutionService.js');
const { chatWithProvider, listProviderConnections } = require('../electron/services/providerService');
const {
  buildPlannerPrompt,
  buildPlanningPacketDocument,
  getPlanningSchemaDefinition,
  validatePlanningPacketShape,
} = require('../electron/shared/planningSchema.cjs');

function loadPlannerExecutionInternals() {
  const source = fs.readFileSync(PIPELINE_EXECUTION_SERVICE_PATH, 'utf8')
    + '\nmodule.exports.__liveLongformPlanner = { executeChunkedLongformPlanner };';
  const testModule = new Module(PIPELINE_EXECUTION_SERVICE_PATH + '.live-groq-test', module);
  testModule.filename = PIPELINE_EXECUTION_SERVICE_PATH;
  testModule.paths = Module._nodeModulePaths(path.dirname(PIPELINE_EXECUTION_SERVICE_PATH));
  testModule._compile(source, PIPELINE_EXECUTION_SERVICE_PATH);
  return testModule.exports.__liveLongformPlanner;
}

function getMessageText(messages = []) {
  return messages.map((message) => String(message?.content || '')).join('\n');
}

function buildTranscriptSegments() {
  const beats = [
    'A quiet Windows desktop wakes before sunrise, with a small local AI control panel opening over a cluttered creative workspace.',
    'The narrator explains that many people want powerful AI tools without sending every idea to a cloud service.',
    'A modest graphics card appears beside gauges for VRAM and system memory, showing careful resource budgeting.',
    'ComfyUI, Ollama, and image tools appear as separate workstations inside one organized hub.',
    'The app checks hardware, chooses low VRAM settings, and avoids overwhelming the machine.',
    'A user saves an environment snapshot before experimenting with a new model and dependency set.',
    'The snapshot becomes a labeled archive on the local drive, ready to restore if an update breaks things.',
    'An installer card downloads a tool into an isolated folder while a progress bar advances step by step.',
    'The dashboard shows running and stopped tools, plus live memory use at the top of the window.',
    'A failed launch changes the status to error, and the repair action checks dependencies in plain English.',
    'The repair flow reinstalls missing packages, fixes common CUDA mismatches, and reports what changed.',
    'The app minimizes to the Windows tray, where quick launch options keep the full interface out of the way.',
    'The narrator emphasizes local-first privacy, with network access used only when the user installs a tool.',
    'A low-end laptop runs a smaller model smoothly because the planner chose realistic settings.',
    'A creator returns to the dashboard, starts a local chat model, and keeps generating ideas offline.',
    'The closing beat shows Local AI Hub as a calm control room for practical local AI work.'
  ];
  const durationSeconds = 120;
  const segmentDuration = durationSeconds / beats.length;
  return beats.map((text, index) => ({
    id: 'live-seg-' + String(index + 1),
    start: Number((index * segmentDuration).toFixed(3)),
    end: index === beats.length - 1 ? durationSeconds : Number(((index + 1) * segmentDuration).toFixed(3)),
    text,
  }));
}

function buildLivePacket() {
  const segments = buildTranscriptSegments();
  const packet = buildPlanningPacketDocument({
    desiredOutputNotes: 'Return clean imagePrompt text for each timed visual beat. Use fallback 8 seconds per image.',
    goal: 'Create a timing-aware longform slideshow scene plan from this two minute narration.',
    schemaId: 'longformMedia.scenePlan.v1',
    stylePolicyText: 'Use grounded Windows desktop visuals, practical UI details, and clear readable compositions.',
  }, [{
    displayName: 'Groq live two minute planning transcript',
    kind: 'text',
    text: segments.map((segment) => segment.text).join(' '),
    transcription: {
      durationSeconds: 120,
      segments,
    },
  }]);
  const validation = validatePlanningPacketShape(packet);
  if (!validation.ok) {
    throw new Error(validation.errors[0] || 'Live planning packet did not validate.');
  }
  return validation.value;
}

function buildPromptMessages(promptPacket, guidance = '') {
  const plannerPrompt = buildPlannerPrompt('longformMedia.scenePlan.v1', promptPacket, {
    compact: true,
    guidance,
  });
  const messages = [];
  if (plannerPrompt.systemPrompt) {
    messages.push({ role: 'system', content: plannerPrompt.systemPrompt });
  }
  messages.push({ role: 'user', content: plannerPrompt.userPrompt });
  return {
    messages,
    promptStats: {
      ...plannerPrompt.promptStats,
      requestCharacters: getMessageText(messages).length,
    },
  };
}

function summarizeResult(result, providerCalls) {
  const diagnostics = result.diagnostics || {};
  const chunkDiagnostics = diagnostics.chunkDiagnostics || [];
  const chunkFailures = diagnostics.chunkFailures || [];
  const modelAuthored = chunkDiagnostics.filter((entry) => !entry.deterministicFallbackUsed).length;
  const fallback = chunkDiagnostics.filter((entry) => entry.deterministicFallbackUsed).length;
  const imagePromptsClean = (result.normalizedPlan?.scenes || []).every((scene) => {
    const text = String(scene?.imagePrompt || '');
    return text && !/Meaning\s*\/\s*intent|Viewer takeaway|Narration excerpt|Source transcript/i.test(text);
  });
  return {
    chunks: diagnostics.chunksPlanned || chunkDiagnostics.length,
    modelAuthored,
    fallback,
    failuresByReason: chunkFailures.reduce((acc, entry) => {
      const reason = String(entry.failureReason || 'unknown');
      acc[reason] = (acc[reason] || 0) + 1;
      return acc;
    }, {}),
    providerCalls: providerCalls.length,
    rateLimitWaits: diagnostics.rateLimitWaits || [],
    totalRateLimitWaitMs: diagnostics.totalRateLimitWaitMs || 0,
    chunkSizes: chunkDiagnostics.map((entry) => entry.chunkDurationSeconds),
    contextProfiles: chunkDiagnostics.map((entry) => entry.contextProfileId),
    errorCategories: chunkDiagnostics.map((entry) => entry.actualProviderErrorCategory || ''),
    requestCharacters: chunkDiagnostics.map((entry) => entry.requestCharacters),
    estimatedTotalTokens: chunkDiagnostics.map((entry) => entry.estimatedTotalTokens),
    requestedOutputTokens: chunkDiagnostics.map((entry) => entry.requestedOutputTokens),
    cleanImagePrompts: imagePromptsClean,
  };
}

async function main() {
  const providerId = 'groq';
  const model = 'openai/gpt-oss-120b';
  const providers = await listProviderConnections();
  const provider = providers.find((entry) => entry.id === providerId) || { id: providerId, name: 'Groq' };
  const { executeChunkedLongformPlanner } = loadPlannerExecutionInternals();
  const packet = buildLivePacket();
  const schema = getPlanningSchemaDefinition('longformMedia.scenePlan.v1');
  const providerCalls = [];
  const sendPlannerRequest = async (messages, retry = false, requestOptions = {}) => {
    providerCalls.push({
      retry,
      requestCharacters: getMessageText(messages).length,
      maxOutputTokens: requestOptions.maxOutputTokens || 0,
    });
    const result = await chatWithProvider(providerId, {
      messages,
      model,
      timeoutMs: 60000,
      timeoutMessage: 'Groq took too long to answer this live planning request.',
      maxOutputTokens: requestOptions.maxOutputTokens,
      responseFormat: require('../electron/shared/planningSchema.cjs').buildPlanningSchemaStructuredOutputRequest('longformMedia.scenePlan.v1'),
    });
    return String(result?.message?.content || '').trim();
  };

  const result = await executeChunkedLongformPlanner({
    buildPromptMessages,
    enablePlannerRateLimitBackoff: true,
    fallbackSecondsPerImage: 8,
    model,
    node: { id: 'live-groq-planner', label: 'Live Groq planner test' },
    packet,
    plannerGuidance: 'Live planning-only reliability test. Return JSON only.',
    providerId,
    providerLabel: provider.name || 'Groq',
    providerMetadata: provider,
    rateLimitBackoffMaxRetries: 2,
    reportProgress: (message) => console.error('[progress]', message),
    schema,
    schemaId: 'longformMedia.scenePlan.v1',
    sendPlannerRequest,
  });

  console.log(JSON.stringify(summarizeResult(result, providerCalls), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: String(error?.message || error || 'Live Groq planner test failed.'),
  }, null, 2));
  process.exit(1);
});