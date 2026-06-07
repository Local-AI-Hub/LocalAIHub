// Manual live/provider-backed verifier only.
// Uses saved live provider credentials and may consume provider quota or hit rate limits.
// Run manually only when explicitly validating Pipeline Wizard provider behavior.
const LIVE_VALIDATION_FLAG = '--live-provider-validation';

function printUsage() {
  console.log([
    'Pipeline Wizard live provider validation is an opt-in manual verifier.',
    '',
    'This script uses saved live provider credentials and may consume provider quota or hit rate limits.',
    'It is not part of normal release, push, npm verify, or CI-style validation.',
    '',
    'Manual usage:',
    '  npm run verify:wizard-live',
    '  node scripts/verify-pipeline-wizard-live-validation.js --live-provider-validation',
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

const assert = require('assert');

const {
  buildPipelineWizardContext,
  buildPipelineWizardDraft,
  buildPipelineWizardMessages,
  buildPipelineWizardStructuredOutputRequest,
  getPipelineWizardRequestProfile,
  parsePipelineWizardPlan,
} = require('../electron/shared/pipelineWizard.cjs');
const { resolveProviderCredential } = require('../electron/services/credentialService.js');
const { chatWithProvider } = require('../electron/services/providerService.js');

const hardware = {
  compatibilityMessage: 'This GPU is supported in Low VRAM mode.',
  gpuModel: 'NVIDIA GTX 1060',
  systemRamMb: 16384,
  vramMb: 6144,
};
const providers = [
  { id: 'groq', isConnected: true, lastTestSucceeded: true, name: 'Groq' },
  { id: 'google', isConnected: true, lastTestSucceeded: true, name: 'Google Gemini' },
  { id: 'openai', isConnected: true, lastTestSucceeded: true, name: 'OpenAI' },
  { id: 'xai', isConnected: true, lastTestSucceeded: true, name: 'xAI' },
];
const tools = [
  { id: 'automatic1111', name: 'Automatic1111', status: 'running' },
  { id: 'whisper', name: 'Whisper', status: 'running' },
  { id: 'chatterbox-tts', name: 'Chatterbox-Turbo TTS', status: 'stopped' },
  { id: 'wan21-webui', name: 'Wan2.1 WebUI', status: 'stopped' },
];
const assetLibraries = {
  soundEffects: [{ id: 'sfx-halloween', name: 'Halloween Sounds', items: [{ id: 'door-creak', name: 'Door creak' }] }],
  fonts: [{ id: 'font-bold-captions', name: 'Bold Caption Fonts', items: [{ id: 'inter-bold', name: 'Inter Bold' }] }],
  colorPalettes: [{ id: 'palette-high-contrast', name: 'High Contrast Captions', items: [{ id: 'white', hex: '#ffffff' }, { id: 'black', hex: '#000000' }] }],
};
const context = buildPipelineWizardContext({ hardware, providers, tools, assetLibraries });

const promptCases = [
  {
    id: 'audio-trim-transcribe',
    category: 'audio utility plus transcription',
    prompt: 'Start with an audio input, trim it to the first ten seconds, transcribe the trimmed audio, and send the transcript to a text output.',
    expected: ['audioInput', 'trimMedia', 'llmPrompt', 'textOutput'],
    ordered: ['audioInput', 'trimMedia', 'llmPrompt', 'textOutput'],
    forbidden: ['audioOutput'],
    operations: ['whisperTranscribe'],
  },
  {
    id: 'video-trim-extract-transcribe',
    category: 'video utility chain plus transcription',
    prompt: 'Start with a video input, trim it from 5 seconds to 20 seconds, extract the audio from that trimmed clip, transcribe it, and output the transcript text.',
    expected: ['videoInput', 'trimMedia', 'extractAudio', 'llmPrompt', 'textOutput'],
    ordered: ['videoInput', 'trimMedia', 'extractAudio', 'llmPrompt', 'textOutput'],
    forbidden: ['videoOutput', 'audioOutput'],
    operations: ['whisperTranscribe'],
  },
  {
    id: 'audio-trim-normalize',
    category: 'audio utility chain',
    prompt: 'Start with an audio input, trim it to 12 seconds, normalize and convert the trimmed audio to mp3, and output the audio.',
    expected: ['audioInput', 'trimMedia', 'normalizeAudioCollection', 'audioOutput'],
    ordered: ['audioInput', 'trimMedia', 'normalizeAudioCollection', 'audioOutput'],
    forbidden: ['textOutput'],
  },
  {
    id: 'video-frame-cloud-image',
    category: 'video frame utility plus cloud image generation',
    prompt: 'Start with a video input, grab the last frame, use Google cloud image generation to create a stylized poster from that frame, and output the image.',
    expected: ['videoInput', 'extractVideoFrame', 'llmPrompt', 'imageOutput'],
    ordered: ['videoInput', 'extractVideoFrame', 'llmPrompt', 'imageOutput'],
    forbidden: ['videoOutput'],
    operations: ['imageGenerate'],
  },
  {
    id: 'burn-captions',
    category: 'caption burn with secondary text source',
    prompt: 'Start with a video input and a caption text input, burn subtitles into the video using bold bottom captions, then output the captioned video.',
    expected: ['videoInput', 'textInput', 'burnSubtitles', 'videoOutput'],
    ordered: ['videoInput', 'burnSubtitles', 'videoOutput'],
    forbidden: ['fileOutput', 'textOutput'],
  },
  {
    id: 'collection-map-images-review',
    category: 'collection map with per-item review',
    prompt: 'Start with a collection of text prompts, generate one Google cloud image for each prompt, require per-item approval and retry for failed items, and output the image collection.',
    expected: ['collectionInput', 'collectionMap', 'collectionOutput'],
    ordered: ['collectionInput', 'collectionMap', 'collectionOutput'],
    forbidden: ['imageOutput'],
  },
  {
    id: 'image-slideshow-export',
    category: 'media composition with export',
    prompt: 'Compose an image collection into a narration-synced slideshow with fallback 8 seconds per image, random wipes, narration at 100%, quiet background music, and Halloween sound effects.',
    expected: ['collectionInput', 'audioInput', 'mediaComposition', 'mediaExport', 'videoOutput'],
    ordered: ['collectionInput', 'mediaComposition', 'mediaExport', 'videoOutput'],
    forbidden: ['audioOutput'],
  },
];

function getReplyText(result) {
  return String(result?.message?.content || result?.data?.content || result?.data?.text || result?.content || '').trim();
}

function isSubsequence(list, ordered) {
  let cursor = -1;
  for (const item of ordered) {
    const next = list.findIndex((entry, index) => index > cursor && entry === item);
    if (next < 0) return false;
    cursor = next;
  }
  return true;
}

function isProviderLimitError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /rate limit|quota|too many requests|tpm|tokens per minute|resource_exhausted|429/.test(message);
}

function sanitizeProviderError(error) {
  return String(error?.message || error || '')
    .replace(/org_[a-z0-9_\-]+/gi, '[redacted-org]')
    .replace(/sk-[a-z0-9_\-]+/gi, '[redacted-key]')
    .replace(/key[=:]\s*[^\s,;]+/gi, 'key=[redacted]');
}

function evaluateDraft(testCase, parsedPlan, draft) {
  const nodes = draft.pipeline.nodes || [];
  const nodeTypes = nodes.map((node) => node.type);
  const operationIds = nodes.map((node) => node.config?.operationId).filter(Boolean);
  const missing = testCase.expected.filter((type) => !nodeTypes.includes(type));
  const forbiddenPresent = (testCase.forbidden || []).filter((type) => nodeTypes.includes(type));
  const missingOperations = (testCase.operations || []).filter((operationId) => !operationIds.includes(operationId));
  const orderOk = isSubsequence(nodeTypes, testCase.ordered || testCase.expected);
  const correct = !missing.length && !forbiddenPresent.length && !missingOperations.length && orderOk;
  let failureType = '';
  if (!correct) {
    if (!parsedPlan?.intentIr || !(parsedPlan.intentIr.stages || []).length) {
      failureType = 'model output';
    } else if (draft.plan?.intentIrRepair?.applied && (draft.plan?.intentIrRepair?.reasons || []).length) {
      failureType = 'repair';
    } else if (draft.summary?.gaps?.some((gap) => /Skipped|needs|could not|not support/i.test(gap))) {
      failureType = 'lowering';
    } else {
      failureType = 'schema/capability mismatch';
    }
  }
  return {
    parsedIrSuccess: Boolean(parsedPlan?.intentIr && ((parsedPlan.intentIr.sources || []).length || (parsedPlan.intentIr.stages || []).length || (parsedPlan.intentIr.outputs || []).length)),
    repairNeeded: Boolean(draft.plan?.intentIrRepair?.applied),
    fallbackUsed: Boolean(parsedPlan?.usedFallback),
    nodeTypes,
    operationIds,
    expectedNodeTypes: testCase.expected,
    correct,
    failureType,
    missing,
    forbiddenPresent,
    missingOperations,
    orderOk,
    repairReasons: draft.plan?.intentIrRepair?.reasons || [],
    gaps: draft.summary?.gaps || [],
  };
}

async function runTargetCase(target, testCase) {
  const wizardTarget = { mode: 'cloud', providerId: target.providerId, model: target.model };
  const profile = getPipelineWizardRequestProfile({ context, intent: testCase.prompt, wizardTarget });
  const messages = buildPipelineWizardMessages({ context, intent: testCase.prompt, wizardTarget: { ...wizardTarget, requestProfile: profile } });
  const response = await chatWithProvider(target.providerId, {
    messages,
    model: target.model,
    maxOutputTokens: profile.maxOutputTokens,
    responseFormat: buildPipelineWizardStructuredOutputRequest({ compactMode: profile.compactMode }),
    timeoutMs: 45000,
    timeoutMessage: 'The live wizard validation model did not return a planning draft in time.',
  });
  const replyText = getReplyText(response);
  assert(replyText, target.providerId + ' returned an empty planning reply for ' + testCase.id + '.');
  const parsedPlan = parsePipelineWizardPlan(replyText, { intent: testCase.prompt });
  const draft = buildPipelineWizardDraft({ context, intent: testCase.prompt, modelPlan: parsedPlan, wizardTarget });
  return {
    providerId: target.providerId,
    model: target.model,
    caseId: testCase.id,
    category: testCase.category,
    prompt: testCase.prompt,
    compactMode: profile.compactMode,
    maxOutputTokens: profile.maxOutputTokens,
    promptChars: JSON.stringify(messages).length,
    ...evaluateDraft(testCase, parsedPlan, draft),
  };
}

async function runTarget(target) {
  const credential = await resolveProviderCredential(target.providerId).catch(() => null);
  if (!String(credential?.apiKey || '').trim()) {
    return promptCases.map((testCase) => ({
      providerId: target.providerId,
      model: target.model,
      caseId: testCase.id,
      category: testCase.category,
      prompt: testCase.prompt,
      correct: false,
      skipped: true,
      reason: 'No configured provider credential was available.',
    }));
  }

  const results = [];
  for (const testCase of promptCases) {
    try {
      results.push(await runTargetCase(target, testCase));
    } catch (error) {
      if (isProviderLimitError(error)) {
        results.push({
          providerId: target.providerId,
          model: target.model,
          caseId: testCase.id,
          category: testCase.category,
          prompt: testCase.prompt,
          correct: false,
          skipped: true,
          reason: 'Provider rate/quota limit reached; stopped remaining live planning cases for this provider.',
          error: sanitizeProviderError(error),
        });
        const completed = new Set(results.map((entry) => entry.caseId));
        for (const remaining of promptCases) {
          if (!completed.has(remaining.id)) {
            results.push({
              providerId: target.providerId,
              model: target.model,
              caseId: remaining.id,
              category: remaining.category,
              prompt: remaining.prompt,
              correct: false,
              skipped: true,
              reason: 'Skipped after provider rate/quota limit was reached.',
            });
          }
        }
        break;
      }
      results.push({
        providerId: target.providerId,
        model: target.model,
        caseId: testCase.id,
        category: testCase.category,
        prompt: testCase.prompt,
        correct: false,
        failureType: 'provider/model output',
        error: sanitizeProviderError(error),
      });
    }
  }
  return results;
}

(async () => {
  const targets = [
    { providerId: 'groq', model: 'openai/gpt-oss-120b' },
    { providerId: 'google', model: 'models/gemini-2.5-flash' },
  ];
  const results = [];
  for (const target of targets) {
    results.push(...await runTarget(target));
  }
  const failures = results.filter((entry) => !entry.skipped && !entry.correct);
  const skipped = results.filter((entry) => entry.skipped);
  console.log(JSON.stringify({
    summary: {
      total: results.length,
      passed: results.filter((entry) => entry.correct).length,
      failed: failures.length,
      skipped: skipped.length,
      categories: [...new Set(promptCases.map((entry) => entry.category))],
    },
    results,
  }, null, 2));
  if (failures.length) {
    process.exitCode = 1;
  }
})();
