// Manual live/provider-backed verifier only.
// Performs Pipeline Wizard drafting calls; it never executes generated pipelines or media operations.
const LIVE_VALIDATION_FLAG = '--live-provider-validation';

function printUsage() {
  console.log([
    'Pipeline Wizard live provider validation is opt-in and may consume provider quota.',
    '',
    'It only requests compact Wizard Intent IR and compiles drafts locally.',
    'It does not save pipelines, record media, install tools, or run generated media workflows.',
    '',
    'Usage:',
    '  npm run verify:wizard-live',
    '  node scripts/verify-pipeline-wizard-live-validation.js --live-provider-validation',
    '  node scripts/verify-pipeline-wizard-live-validation.js --live-provider-validation --provider=google',
    '  node scripts/verify-pipeline-wizard-live-validation.js --live-provider-validation --provider=groq',
  ].join('\n'));
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printUsage();
  process.exit(0);
}

if (!process.argv.includes(LIVE_VALIDATION_FLAG)) {
  printUsage();
  console.error('\nRefusing to run live provider validation without ' + LIVE_VALIDATION_FLAG + '.');
  process.exit(1);
}

const {
  buildPipelineWizardContext,
  buildPipelineWizardDraft,
  buildPipelineWizardMessages,
  buildPipelineWizardStructuredOutputRequest,
  getPipelineWizardRequestProfile,
  parsePipelineWizardPlan,
} = require('../electron/shared/pipelineWizard.cjs');
const {
  WIZARD_DIAGNOSTIC_CATEGORIES,
  runPipelineWizardLifecycle,
} = require('../electron/shared/pipelineWizardLifecycle.cjs');
const { resolveProviderCredential } = require('../electron/services/credentialService.js');
const { chatWithProvider } = require('../electron/services/providerService.js');

const hardware = {
  compatibilityMessage: 'This GPU is supported in Low VRAM mode.',
  gpuModel: 'NVIDIA GTX 1060',
  systemRamMb: 16384,
  vramMb: 6144,
};
const providers = [
  { id: 'google', isConnected: true, lastTestSucceeded: true, name: 'Google Gemini' },
  { id: 'groq', isConnected: true, lastTestSucceeded: true, name: 'Groq' },
];
const tools = [
  { id: 'automatic1111', name: 'Automatic1111', status: 'running' },
  { id: 'whisper', name: 'Whisper', status: 'running' },
];
const context = buildPipelineWizardContext({ hardware, providers, tools });

const promptCases = [
  { id: 'video-collection-music', prompt: 'add music to a collection of videos', expected: ['collectionInput', 'mediaComposition', 'mediaExport', 'videoOutput'], mode: 'videoSequence' },
  { id: 'combine-video-clips', prompt: 'combine several video clips', expected: ['collectionInput', 'mediaComposition', 'mediaExport', 'videoOutput'], mode: 'videoSequence' },
  { id: 'record-mic-transcribe', prompt: 'record my microphone, transcribe that audio, then output the transcribed text', expected: ['recordInput', 'llmPrompt', 'textOutput'], recordMode: 'microphone' },
  { id: 'existing-video-music', prompt: 'add background music to this video', expected: ['videoInput', 'mediaComposition', 'mediaExport', 'videoOutput'], mode: 'singleVideoMix' },
  { id: 'screen-recording-track', prompt: 'put a background track under my screen recording', expected: ['videoInput', 'mediaComposition', 'mediaExport', 'videoOutput'], mode: 'singleVideoMix' },
  { id: 'demo-sections-music', prompt: 'stitch my demo sections together and add music', expected: ['collectionInput', 'mediaComposition', 'mediaExport', 'videoOutput'], mode: 'videoSequence' },
  { id: 'system-audio-transcribe', prompt: 'record system audio and transcribe it', expected: ['recordInput', 'llmPrompt', 'textOutput'], recordMode: 'systemAudio' },
  { id: 'generated-image-slideshow', prompt: 'make a narrated slideshow from generated images', expected: ['textInput', 'llmPrompt', 'mediaComposition', 'mediaExport', 'videoOutput'], mode: 'imageSlideshow' },
  { id: 'screen-mic-video', prompt: 'record my screen with microphone and save it as a video', expected: ['recordInput', 'videoOutput'], recordMode: 'screenMic' },
  { id: 'short-clips-export', prompt: 'take several short clips, merge them, and export one video', expected: ['collectionInput', 'mediaComposition', 'mediaExport', 'videoOutput'], mode: 'videoSequence' },
  { id: 'mp4-music-layer', prompt: 'layer music under an existing MP4', expected: ['videoInput', 'mediaComposition', 'mediaExport', 'videoOutput'], mode: 'singleVideoMix' },
  { id: 'final-demo-video', prompt: 'turn my clips into one final demo video', expected: ['collectionInput', 'mediaComposition', 'mediaExport', 'videoOutput'], mode: 'videoSequence' },
  { id: 'voice-transcript', prompt: 'capture my voice and make a transcript', expected: ['recordInput', 'llmPrompt', 'textOutput'], recordMode: 'microphone' },
  { id: 'broll-music-bed', prompt: 'combine B-roll clips with a music bed', expected: ['collectionInput', 'mediaComposition', 'mediaExport', 'videoOutput'], mode: 'videoSequence' },
  { id: 'screen-capture-export', prompt: 'use my screen capture as the source and export a finished video', expected: ['videoInput', 'videoOutput'] },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getReplyText(result) {
  return String(result?.data?.message?.content || result?.data?.content || result?.data?.text || '').trim();
}

function isRateLimitError(error) {
  return /rate limit|quota|too many requests|tpm|tokens per minute|resource_exhausted|429/i.test(String(error?.message || error || ''));
}

function sanitizeProviderError(error) {
  return String(error?.message || error || '')
    .replace(/org_[a-z0-9_-]+/gi, '[redacted-org]')
    .replace(/sk-[a-z0-9_-]+/gi, '[redacted-key]')
    .replace(/key[=:]\s*[^\s,;]+/gi, 'key=[redacted]');
}

function getSelectedIntent(plan, draft) {
  const stages = plan?.intentIr?.stages || [];
  const compositionStage = stages.find((stage) => stage.kind === 'compose_media');
  const recordSource = (plan?.intentIr?.sources || []).find((source) => source.recordInput);
  return {
    compositionMode: compositionStage?.mediaComposition?.compositionMode || '',
    outputKinds: (plan?.intentIr?.outputs || []).map((output) => output.kind).filter(Boolean),
    recordMode: recordSource?.recordInput?.mode || '',
    stageKinds: stages.map((stage) => stage.kind),
    repairedStageKinds: draft?.plan?.intentIr?.stages?.map((stage) => stage.kind) || [],
  };
}

function evaluateTopology(testCase, draft) {
  const nodes = draft?.pipeline?.nodes || [];
  const nodeTypes = nodes.map((node) => node.type);
  const missing = testCase.expected.filter((type) => !nodeTypes.includes(type));
  const compositionNode = nodes.find((node) => node.type === 'mediaComposition');
  const recordNode = nodes.find((node) => node.type === 'recordInput');
  const modeMatches = !testCase.mode || compositionNode?.config?.compositionMode === testCase.mode;
  const recordModeMatches = !testCase.recordMode || recordNode?.config?.mode === testCase.recordMode;
  return {
    correct: missing.length === 0 && modeMatches && recordModeMatches,
    missing,
    modeMatches,
    nodeTypes,
    recordModeMatches,
  };
}

async function runTargetCase(target, testCase) {
  const wizardTarget = { mode: 'cloud', providerId: target.providerId, model: target.model };
  const profile = getPipelineWizardRequestProfile({ context, intent: testCase.prompt, wizardTarget });
  const messages = buildPipelineWizardMessages({
    context,
    intent: testCase.prompt,
    wizardTarget: { ...wizardTarget, requestProfile: profile },
  });
  let providerResponse = null;
  try {
    providerResponse = await chatWithProvider(target.providerId, {
      messages,
      model: target.model,
      maxOutputTokens: profile.maxOutputTokens,
      responseFormat: buildPipelineWizardStructuredOutputRequest({ compactMode: profile.compactMode }),
      timeoutMs: 60000,
      timeoutMessage: 'The live wizard validation model did not return a planning draft in time.',
    });
  } catch (error) {
    return {
      provider: target.providerId,
      model: target.model,
      prompt: testCase.prompt,
      primaryJsonIrValid: false,
      compiledWithoutFallback: false,
      recoveredFallbackUsed: false,
      graphValid: false,
      selectedIntent: {},
      failureClassification: WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED,
      failureDetail: isRateLimitError(error) ? 'rate_limited' : 'provider_error',
      error: sanitizeProviderError(error),
      topologyCorrect: false,
    };
  }

  const replyText = String(providerResponse?.message?.content || '').trim();
  const parsedPlan = parsePipelineWizardPlan(replyText, { intent: testCase.prompt });
  const lifecycleResult = await runPipelineWizardLifecycle({
    context,
    intent: testCase.prompt,
    wizardTarget,
    targetLabel: target.providerId + ' / ' + target.model,
    requestModelDraft: () => Promise.resolve({ ok: true, data: providerResponse }),
    getReplyText,
    parsePlan: parsePipelineWizardPlan,
    buildDraft: buildPipelineWizardDraft,
  });
  const draft = lifecycleResult?.draftResult || null;
  const topology = evaluateTopology(testCase, draft);
  return {
    provider: target.providerId,
    model: target.model,
    prompt: testCase.prompt,
    primaryJsonIrValid: Boolean(parsedPlan?.parseDiagnostics?.jsonParsed && parsedPlan?.parseDiagnostics?.schemaValid && !parsedPlan?.parseDiagnostics?.extracted),
    compiledWithoutFallback: Boolean(lifecycleResult?.ok && !lifecycleResult?.recovered && lifecycleResult?.diagnosticCategory === WIZARD_DIAGNOSTIC_CATEGORIES.PRIMARY_COMPILED),
    recoveredFallbackUsed: Boolean(lifecycleResult?.recovered),
    graphValid: Boolean(draft?.pipeline && !(draft?.graphErrors || []).length),
    selectedIntent: getSelectedIntent(parsedPlan, draft),
    failureClassification: lifecycleResult?.diagnosticCategory || '',
    failureDetail: '',
    finishReason: providerResponse?.providerDiagnostics?.finishReason || '',
    outputTruncated: Boolean(providerResponse?.providerDiagnostics?.outputTruncated),
    topologyCorrect: topology.correct,
    topology,
    parseIssues: parsedPlan?.parseDiagnostics?.issues || [],
    repairReasons: draft?.plan?.intentIrRepair?.reasons || [],
  };
}

async function runTarget(target) {
  const credential = await resolveProviderCredential(target.providerId).catch(() => null);
  if (!String(credential?.apiKey || '').trim()) {
    return promptCases.map((testCase) => ({
      provider: target.providerId,
      model: target.model,
      prompt: testCase.prompt,
      skipped: true,
      reason: 'No configured provider credential was available.',
    }));
  }

  const results = [];
  const targetCases = promptCases.slice(0, target.maxCases || promptCases.length);
  for (let index = 0; index < targetCases.length; index += 1) {
    if (index > 0) {
      await delay(target.pauseMs);
    }
    const result = await runTargetCase(target, targetCases[index]);
    results.push(result);
    console.log(JSON.stringify(result));
    if (result.failureDetail === 'rate_limited') {
      for (const remaining of targetCases.slice(index + 1)) {
        results.push({
          provider: target.providerId,
          model: target.model,
          prompt: remaining.prompt,
          skipped: true,
          reason: 'Skipped after the provider rate limit was reached.',
        });
      }
      break;
    }
  }
  for (const remaining of promptCases.slice(targetCases.length)) {
    results.push({
      provider: target.providerId,
      model: target.model,
      prompt: remaining.prompt,
      skipped: true,
      reason: 'Skipped to keep optional secondary-provider validation modest.',
    });
  }
  return results;
}

(async () => {
  const providerArg = process.argv.find((arg) => arg.startsWith('--provider='));
  const selectedProvider = providerArg ? providerArg.split('=')[1] : '';
  const targets = [
    { providerId: 'google', model: 'models/gemini-2.5-flash', pauseMs: 1000 },
    { providerId: 'groq', model: 'openai/gpt-oss-120b', pauseMs: 45000, maxCases: 5 },
  ].filter((target) => !selectedProvider || target.providerId === selectedProvider);
  const results = [];
  for (const target of targets) {
    results.push(...await runTarget(target));
  }

  const attempted = results.filter((entry) => !entry.skipped);
  const summary = {
    total: results.length,
    attempted: attempted.length,
    skipped: results.filter((entry) => entry.skipped).length,
    primarySuccess: attempted.filter((entry) => entry.compiledWithoutFallback && entry.graphValid).length,
    fallbackSuccess: attempted.filter((entry) => entry.recoveredFallbackUsed && entry.graphValid).length,
    invalidGraph: attempted.filter((entry) => !entry.graphValid).length,
    topologyCorrect: attempted.filter((entry) => entry.topologyCorrect).length,
  };
  console.log(JSON.stringify({ summary, results }, null, 2));

  const hardFailures = attempted.filter((entry) => !entry.graphValid || !entry.topologyCorrect);
  if (hardFailures.length) {
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(sanitizeProviderError(error));
  process.exit(1);
});
