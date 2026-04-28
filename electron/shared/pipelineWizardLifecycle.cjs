const WIZARD_CLOUD_DRAFT_TIMEOUT_MS = 180000;
const WIZARD_LOCAL_DRAFT_TIMEOUT_MS = 300000;
const WIZARD_CLIENT_TIMEOUT_GRACE_MS = 15000;

function normalizeString(value, fallback = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}

function getErrorMessage(error, fallback = 'Local AI Hub could not finish the wizard request.') {
  if (typeof error === 'string') {
    return normalizeString(error, fallback);
  }
  return normalizeString(error?.message || error?.reason || error?.detail, fallback);
}

function classifyWizardFailure(message = '', fallback = 'provider-error') {
  const normalized = String(message || '').toLowerCase();
  if (/timeout|timed out|took too long|did not return|did not answer|aborted/.test(normalized)) {
    return 'provider-timeout';
  }
  if (/json|format|parse|malformed|invalid model output|empty reply|empty response/.test(normalized)) {
    return 'malformed-model-output';
  }
  if (/compile|compiler|ground|graph|node|port|connection|unsupported/i.test(message)) {
    return 'compiler-grounding-error';
  }
  if (/ipc|bridge|invoke|renderer|window.localaihub/i.test(message)) {
    return 'ui-ipc-failure';
  }
  return fallback;
}

function getWizardFailureTitle(category = '') {
  if (category === 'provider-timeout') return 'Wizard model timed out';
  if (category === 'provider-error') return 'Wizard model error';
  if (category === 'malformed-model-output') return 'Wizard output format issue';
  if (category === 'compiler-grounding-error') return 'Wizard compiler issue';
  if (category === 'ui-ipc-failure') return 'Wizard request error';
  return 'Wizard request error';
}

function getWizardFailureHeadline(category = '') {
  if (category === 'provider-timeout') return 'Wizard draft timed out';
  if (category === 'provider-error') return 'Wizard draft was not created';
  if (category === 'malformed-model-output') return 'Wizard model output was repaired or rejected';
  if (category === 'compiler-grounding-error') return 'Wizard draft could not be grounded';
  if (category === 'ui-ipc-failure') return 'Wizard request did not complete';
  return 'Wizard draft was not created';
}

function getWizardFailureGuidance(category = '') {
  if (category === 'provider-timeout') {
    return 'The wizard model did not return a draft within the allowed time. Try a simpler request, a stronger model, or split the workflow into stages.';
  }
  if (category === 'malformed-model-output') {
    return 'The wizard model returned output Local AI Hub could not use directly, so the compiler rebuilt from deterministic rules where possible.';
  }
  if (category === 'compiler-grounding-error') {
    return 'Local AI Hub hit an internal grounding problem while compiling the wizard draft. The request stayed bounded and the draft was not left pending.';
  }
  if (category === 'ui-ipc-failure') {
    return 'Local AI Hub could not complete the app request path for this wizard run. Try again after refreshing the app state.';
  }
  return 'The wizard model did not return a usable draft. Try again, choose a different model, or split the workflow into smaller stages.';
}

function buildWizardFailureSummary({ category = 'provider-error', message = '', targetLabel = '' } = {}) {
  const failureMessage = normalizeString(message, getWizardFailureGuidance(category));
  const guidance = getWizardFailureGuidance(category);
  return {
    recipeId: '',
    recipeLabel: getWizardFailureTitle(category),
    resultState: 'error',
    targetLabel,
    headline: getWizardFailureHeadline(category),
    message: failureMessage,
    gaps: [...new Set([guidance, failureMessage].filter(Boolean))],
    manualRefinementNotes: [],
    graphErrorCount: 1,
    graphWarningCount: 0,
    diagnosticCategory: category,
  };
}

function annotateRecoveredDraftResult(draftResult, { category = '', message = '' } = {}) {
  const summary = draftResult?.summary || {};
  const guidance = getWizardFailureGuidance(category);
  const failureMessage = normalizeString(message, guidance);
  const prefix = category === 'provider-timeout'
    ? 'The wizard model timed out, so Local AI Hub rebuilt a bounded draft from built-in rules. '
    : category === 'malformed-model-output'
      ? 'The wizard model returned malformed output, so Local AI Hub rebuilt a bounded draft from built-in rules. '
      : category === 'compiler-grounding-error'
        ? 'The wizard compiler hit an issue with the model draft, so Local AI Hub rebuilt a bounded draft from built-in rules. '
        : 'Local AI Hub rebuilt a bounded draft from built-in rules. ';
  return {
    ...draftResult,
    summary: {
      ...summary,
      headline: summary.resultState === 'placeholder'
        ? 'Recovered placeholder draft created'
        : 'Recovered draft created',
      message: prefix + normalizeString(summary.message, 'Review the recovered draft before running.'),
      gaps: [...new Set([...(summary.gaps || []), guidance, failureMessage].filter(Boolean))],
      manualRefinementNotes: [...new Set([...(summary.manualRefinementNotes || []), 'Review this recovered draft carefully before running. Local AI Hub rebuilt it after the wizard model path failed.'])],
      diagnosticCategory: category,
    },
  };
}

function shouldRecoverFromFailure(category = '') {
  return category === 'provider-timeout'
    || category === 'malformed-model-output'
    || category === 'compiler-grounding-error';
}

async function withWizardRequestTimeout(requestPromise, { timeoutMs = WIZARD_CLOUD_DRAFT_TIMEOUT_MS, timeoutMessage = '' } = {}) {
  const boundedTimeoutMs = Math.max(1000, Number(timeoutMs || 0) || WIZARD_CLOUD_DRAFT_TIMEOUT_MS);
  let timer = null;
  const timeoutResult = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        message: normalizeString(timeoutMessage, getWizardFailureGuidance('provider-timeout')),
        diagnosticCategory: 'provider-timeout',
      });
    }, boundedTimeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve(requestPromise).catch((error) => ({
        ok: false,
        message: getErrorMessage(error),
        diagnosticCategory: classifyWizardFailure(getErrorMessage(error), 'ui-ipc-failure'),
      })),
      timeoutResult,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function recoverWizardDraft({ intent, context, wizardTarget, parsePlan, buildDraft, category, message }) {
  const fallbackPlan = parsePlan('', { intent });
  const draftResult = buildDraft({
    context,
    intent,
    modelPlan: fallbackPlan,
    wizardTarget,
  });
  return annotateRecoveredDraftResult(draftResult, { category, message });
}

async function runPipelineWizardLifecycle({
  intent = '',
  context = {},
  wizardTarget = {},
  targetLabel = '',
  requestModelDraft,
  getReplyText,
  parsePlan,
  buildDraft,
  timeoutMs = WIZARD_CLOUD_DRAFT_TIMEOUT_MS,
  timeoutMessage = '',
} = {}) {
  if (typeof requestModelDraft !== 'function') {
    return {
      ok: false,
      summary: buildWizardFailureSummary({ category: 'ui-ipc-failure', message: 'Local AI Hub could not start the wizard model request.', targetLabel }),
    };
  }

  const providerResult = await withWizardRequestTimeout(requestModelDraft(), { timeoutMs, timeoutMessage });
  if (!providerResult?.ok) {
    const message = providerResult?.message || 'The wizard model did not return a usable draft.';
    const category = providerResult?.diagnosticCategory || classifyWizardFailure(message, 'provider-error');
    if (shouldRecoverFromFailure(category)) {
      try {
        return {
          ok: true,
          recovered: true,
          diagnosticCategory: category,
          draftResult: recoverWizardDraft({ intent, context, wizardTarget, parsePlan, buildDraft, category, message }),
        };
      } catch (error) {
        const recoveryMessage = getErrorMessage(error, 'Local AI Hub could not recover a grounded wizard draft after the model path failed.');
        return {
          ok: false,
          summary: buildWizardFailureSummary({ category: 'compiler-grounding-error', message: recoveryMessage, targetLabel }),
        };
      }
    }
    return {
      ok: false,
      diagnosticCategory: category,
      summary: buildWizardFailureSummary({ category, message, targetLabel }),
    };
  }

  let replyText = '';
  try {
    replyText = typeof getReplyText === 'function' ? getReplyText(providerResult) : '';
    const modelPlan = parsePlan(replyText, { intent });
    const draftResult = buildDraft({ context, intent, modelPlan, wizardTarget });
    const malformed = Boolean(replyText && modelPlan?.usedFallback);
    return {
      ok: true,
      diagnosticCategory: malformed ? 'malformed-model-output' : '',
      draftResult: malformed
        ? annotateRecoveredDraftResult(draftResult, {
            category: 'malformed-model-output',
            message: 'The wizard model returned output that was not valid wizard JSON.',
          })
        : draftResult,
    };
  } catch (error) {
    const message = getErrorMessage(error, 'Local AI Hub could not compile the wizard model draft into grounded pipeline nodes.');
    try {
      return {
        ok: true,
        recovered: true,
        diagnosticCategory: 'compiler-grounding-error',
        draftResult: recoverWizardDraft({ intent, context, wizardTarget, parsePlan, buildDraft, category: 'compiler-grounding-error', message }),
      };
    } catch (recoveryError) {
      return {
        ok: false,
        diagnosticCategory: 'compiler-grounding-error',
        summary: buildWizardFailureSummary({
          category: 'compiler-grounding-error',
          message: getErrorMessage(recoveryError, message),
          targetLabel,
        }),
      };
    }
  }
}

module.exports = {
  WIZARD_CLOUD_DRAFT_TIMEOUT_MS,
  WIZARD_LOCAL_DRAFT_TIMEOUT_MS,
  WIZARD_CLIENT_TIMEOUT_GRACE_MS,
  annotateRecoveredDraftResult,
  buildWizardFailureSummary,
  classifyWizardFailure,
  getErrorMessage,
  runPipelineWizardLifecycle,
  withWizardRequestTimeout,
};

module.exports.default = module.exports;
