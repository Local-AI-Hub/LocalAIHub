const WIZARD_CLOUD_DRAFT_TIMEOUT_MS = 180000;
const WIZARD_LOCAL_DRAFT_TIMEOUT_MS = 300000;
const WIZARD_CLIENT_TIMEOUT_GRACE_MS = 15000;
const WIZARD_DIAGNOSTIC_CATEGORIES = Object.freeze({
  PROVIDER_CALL_FAILED: 'provider_call_failed',
  PROVIDER_RETURNED_EMPTY: 'provider_returned_empty',
  JSON_PARSE_FAILED: 'json_parse_failed',
  JSON_WRAPPED_OR_EXTRACTED: 'json_wrapped_or_extracted',
  SCHEMA_VALIDATION_FAILED: 'schema_validation_failed',
  UNSUPPORTED_ENUM: 'unsupported_enum',
  MISSING_REQUIRED_FIELD: 'missing_required_field',
  LOWERING_FAILED: 'lowering_failed',
  GRAPH_VALIDATION_FAILED: 'graph_validation_failed',
  OUTPUT_TRUNCATED: 'output_truncated',
  FALLBACK_RECOVERED: 'fallback_recovered',
  PRIMARY_COMPILED: 'primary_compiled',
});

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

function classifyWizardFailure(message = '', fallback = WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED) {
  const normalized = String(message || '').toLowerCase();
  if (/max[_\s-]?tokens|finish reason.{0,20}(?:length|max)|truncat/.test(normalized)) {
    return WIZARD_DIAGNOSTIC_CATEGORIES.OUTPUT_TRUNCATED;
  }
  if (/empty reply|empty response|returned no (?:text|content)|no candidate content/.test(normalized)) {
    return WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_RETURNED_EMPTY;
  }
  if (/json/.test(normalized) && /parse|malformed|invalid|could not/.test(normalized)) {
    return WIZARD_DIAGNOSTIC_CATEGORIES.JSON_PARSE_FAILED;
  }
  if (/schema/.test(normalized)) {
    return WIZARD_DIAGNOSTIC_CATEGORIES.SCHEMA_VALIDATION_FAILED;
  }
  if (/graph|node|port|connection|cycle/i.test(message)) {
    return WIZARD_DIAGNOSTIC_CATEGORIES.GRAPH_VALIDATION_FAILED;
  }
  if (/compile|compiler|ground|lower|unsupported/i.test(message)) {
    return WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED;
  }
  return fallback;
}

function getWizardFailureTitle(category = '') {
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED) return 'Wizard model error';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_RETURNED_EMPTY) return 'Wizard model returned no draft';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.JSON_PARSE_FAILED) return 'Wizard JSON format issue';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.JSON_WRAPPED_OR_EXTRACTED) return 'Wizard JSON needed extraction';
  if ([WIZARD_DIAGNOSTIC_CATEGORIES.SCHEMA_VALIDATION_FAILED, WIZARD_DIAGNOSTIC_CATEGORIES.UNSUPPORTED_ENUM, WIZARD_DIAGNOSTIC_CATEGORIES.MISSING_REQUIRED_FIELD].includes(category)) return 'Wizard intent format issue';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED) return 'Wizard intent could not be compiled directly';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.GRAPH_VALIDATION_FAILED) return 'Wizard graph needed repair';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.OUTPUT_TRUNCATED) return 'Wizard response was cut short';
  return 'Wizard request error';
}

function getWizardFailureHeadline(category = '') {
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED) return 'Wizard draft was not created';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_RETURNED_EMPTY) return 'Wizard returned an empty draft';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.JSON_PARSE_FAILED) return 'Wizard JSON could not be parsed';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.JSON_WRAPPED_OR_EXTRACTED) return 'Wizard JSON was recovered from extra text';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.UNSUPPORTED_ENUM) return 'Wizard used an unsupported intent value';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.MISSING_REQUIRED_FIELD) return 'Wizard intent was missing required information';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.SCHEMA_VALIDATION_FAILED) return 'Wizard intent did not match the expected format';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED) return 'Wizard intent needed deterministic repair';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.GRAPH_VALIDATION_FAILED) return 'Wizard graph needed deterministic repair';
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.OUTPUT_TRUNCATED) return 'Wizard response was incomplete';
  return 'Wizard draft was not created';
}

function getWizardFailureGuidance(category = '') {
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED) {
    return 'The wizard provider call did not finish successfully. Try again, check the provider connection, or choose another wizard model.';
  }
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_RETURNED_EMPTY) {
    return 'The wizard provider returned no usable text. Local AI Hub rebuilt from deterministic rules where possible.';
  }
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.JSON_PARSE_FAILED) {
    return 'The wizard model returned text that was not valid JSON. Local AI Hub rebuilt from deterministic rules where possible.';
  }
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.JSON_WRAPPED_OR_EXTRACTED) {
    return 'The wizard model wrapped its JSON in extra text. Local AI Hub extracted it and rebuilt a bounded draft.';
  }
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.UNSUPPORTED_ENUM) {
    return 'The wizard model used an intent value Local AI Hub does not support. The compiler rebuilt from supported intent rules where possible.';
  }
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.MISSING_REQUIRED_FIELD) {
    return 'The wizard model omitted required intent information. The compiler rebuilt from deterministic rules where possible.';
  }
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.SCHEMA_VALIDATION_FAILED) {
    return 'The wizard model returned JSON that did not match the Wizard Intent IR schema. The compiler rebuilt from deterministic rules where possible.';
  }
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED) {
    return 'Local AI Hub could not compile the model intent directly, so it rebuilt a bounded draft from deterministic rules.';
  }
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.GRAPH_VALIDATION_FAILED) {
    return 'The model-authored intent produced an invalid graph, so Local AI Hub rebuilt a bounded valid draft.';
  }
  if (category === WIZARD_DIAGNOSTIC_CATEGORIES.OUTPUT_TRUNCATED) {
    return 'The provider stopped before the structured response was complete. Local AI Hub rebuilt from deterministic rules where possible.';
  }
  return 'The wizard model did not return a usable draft. Try again, choose a different model, or split the workflow into smaller stages.';
}

function buildWizardFailureSummary({ category = WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED, message = '', targetLabel = '' } = {}) {
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
  const prefixes = {
    [WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED]: 'The wizard provider call failed, so Local AI Hub rebuilt a bounded draft from built-in rules. ',
    [WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_RETURNED_EMPTY]: 'The wizard model returned an empty response, so Local AI Hub rebuilt a bounded draft from built-in rules. ',
    [WIZARD_DIAGNOSTIC_CATEGORIES.JSON_PARSE_FAILED]: 'The wizard model returned JSON that could not be parsed, so Local AI Hub rebuilt a bounded draft from built-in rules. ',
    [WIZARD_DIAGNOSTIC_CATEGORIES.JSON_WRAPPED_OR_EXTRACTED]: 'The wizard model wrapped its JSON in extra text, so Local AI Hub extracted it and rebuilt a bounded draft. ',
    [WIZARD_DIAGNOSTIC_CATEGORIES.SCHEMA_VALIDATION_FAILED]: 'The wizard model returned JSON that did not match the Wizard Intent IR schema, so Local AI Hub rebuilt a bounded draft from built-in rules. ',
    [WIZARD_DIAGNOSTIC_CATEGORIES.UNSUPPORTED_ENUM]: 'The wizard model used an unsupported intent value, so Local AI Hub rebuilt a bounded draft from supported rules. ',
    [WIZARD_DIAGNOSTIC_CATEGORIES.MISSING_REQUIRED_FIELD]: 'The wizard model omitted required intent information, so Local AI Hub rebuilt a bounded draft from built-in rules. ',
    [WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED]: 'The wizard intent could not be compiled directly, so Local AI Hub rebuilt a bounded draft from built-in rules. ',
    [WIZARD_DIAGNOSTIC_CATEGORIES.GRAPH_VALIDATION_FAILED]: 'The wizard intent produced an invalid graph, so Local AI Hub rebuilt a bounded draft from built-in rules. ',
    [WIZARD_DIAGNOSTIC_CATEGORIES.OUTPUT_TRUNCATED]: 'The wizard provider stopped before the structured response was complete, so Local AI Hub rebuilt a bounded draft from built-in rules. ',
  };
  const prefix = prefixes[category] || 'Local AI Hub rebuilt a bounded draft from built-in rules. ';
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
  return [
    WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_RETURNED_EMPTY,
    WIZARD_DIAGNOSTIC_CATEGORIES.JSON_PARSE_FAILED,
    WIZARD_DIAGNOSTIC_CATEGORIES.JSON_WRAPPED_OR_EXTRACTED,
    WIZARD_DIAGNOSTIC_CATEGORIES.SCHEMA_VALIDATION_FAILED,
    WIZARD_DIAGNOSTIC_CATEGORIES.UNSUPPORTED_ENUM,
    WIZARD_DIAGNOSTIC_CATEGORIES.MISSING_REQUIRED_FIELD,
    WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED,
    WIZARD_DIAGNOSTIC_CATEGORIES.GRAPH_VALIDATION_FAILED,
    WIZARD_DIAGNOSTIC_CATEGORIES.OUTPUT_TRUNCATED,
  ].includes(category);
}

async function withWizardRequestTimeout(requestPromise, { timeoutMs = WIZARD_CLOUD_DRAFT_TIMEOUT_MS, timeoutMessage = '' } = {}) {
  const boundedTimeoutMs = Math.max(1000, Number(timeoutMs || 0) || WIZARD_CLOUD_DRAFT_TIMEOUT_MS);
  let timer = null;
  const timeoutResult = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        message: normalizeString(timeoutMessage, getWizardFailureGuidance(WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED)),
        diagnosticCategory: WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED,
        diagnosticDetail: 'timeout',
      });
    }, boundedTimeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve(requestPromise).catch((error) => ({
        ok: false,
        message: getErrorMessage(error),
        diagnosticCategory: classifyWizardFailure(getErrorMessage(error)),
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
  onDiagnostic,
} = {}) {
  const diagnostics = [];
  const emitDiagnostic = (category, detail = {}) => {
    const entry = {
      category,
      at: new Date().toISOString(),
      ...detail,
    };
    diagnostics.push(entry);
    if (typeof onDiagnostic === 'function') {
      try {
        onDiagnostic(entry);
      } catch {
        // Diagnostics must never break wizard drafting.
      }
    }
    return entry;
  };
  if (typeof requestModelDraft !== 'function') {
    emitDiagnostic(WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED, { detail: 'request_not_started' });
    return {
      ok: false,
      diagnosticCategory: WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED,
      diagnostics,
      summary: buildWizardFailureSummary({ category: WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED, message: 'Local AI Hub could not start the wizard model request.', targetLabel }),
    };
  }

  const providerResult = await withWizardRequestTimeout(Promise.resolve().then(() => requestModelDraft()), { timeoutMs, timeoutMessage });
  if (!providerResult?.ok) {
    const message = providerResult?.message || 'The wizard model did not return a usable draft.';
    const category = providerResult?.diagnosticCategory || classifyWizardFailure(message);
    const timedOut = providerResult?.diagnosticDetail === 'timeout' || /timeout|timed out|took too long|did not return|did not answer|aborted/i.test(message);
    emitDiagnostic(category, {
      detail: providerResult?.diagnosticDetail || (timedOut ? 'timeout' : ''),
      message,
    });
    if (shouldRecoverFromFailure(category) || (category === WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_CALL_FAILED && timedOut)) {
      try {
        emitDiagnostic(WIZARD_DIAGNOSTIC_CATEGORIES.FALLBACK_RECOVERED, { rootCategory: category });
        return {
          ok: true,
          recovered: true,
          diagnosticCategory: category,
          diagnosticCategories: diagnostics.map((entry) => entry.category),
          diagnostics,
          draftResult: recoverWizardDraft({ intent, context, wizardTarget, parsePlan, buildDraft, category, message }),
        };
      } catch (error) {
        const recoveryMessage = getErrorMessage(error, 'Local AI Hub could not recover a grounded wizard draft after the model path failed.');
        emitDiagnostic(WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED, { message: recoveryMessage });
        return {
          ok: false,
          diagnosticCategory: WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED,
          diagnostics,
          summary: buildWizardFailureSummary({ category: WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED, message: recoveryMessage, targetLabel }),
        };
      }
    }
    return {
      ok: false,
      diagnosticCategory: category,
      diagnostics,
      summary: buildWizardFailureSummary({ category, message, targetLabel }),
    };
  }

  let replyText = '';
  try {
    const providerDiagnostics = providerResult?.data?.providerDiagnostics || providerResult?.providerDiagnostics || {};
    if (providerDiagnostics.outputTruncated) {
      const category = WIZARD_DIAGNOSTIC_CATEGORIES.OUTPUT_TRUNCATED;
      const message = 'The wizard provider stopped with finish reason ' + normalizeString(providerDiagnostics.finishReason, 'MAX_TOKENS') + ' before the structured response was complete.';
      emitDiagnostic(category, { providerDiagnostics });
      emitDiagnostic(WIZARD_DIAGNOSTIC_CATEGORIES.FALLBACK_RECOVERED, { rootCategory: category });
      return {
        ok: true,
        recovered: true,
        diagnosticCategory: category,
        diagnosticCategories: diagnostics.map((entry) => entry.category),
        diagnostics,
        draftResult: recoverWizardDraft({ intent, context, wizardTarget, parsePlan, buildDraft, category, message }),
      };
    }
    replyText = typeof getReplyText === 'function' ? getReplyText(providerResult) : '';
    if (!String(replyText || '').trim()) {
      const category = WIZARD_DIAGNOSTIC_CATEGORIES.PROVIDER_RETURNED_EMPTY;
      const message = 'The wizard provider returned no usable structured text.';
      emitDiagnostic(category, { providerDiagnostics });
      emitDiagnostic(WIZARD_DIAGNOSTIC_CATEGORIES.FALLBACK_RECOVERED, { rootCategory: category });
      return {
        ok: true,
        recovered: true,
        diagnosticCategory: category,
        diagnosticCategories: diagnostics.map((entry) => entry.category),
        diagnostics,
        draftResult: recoverWizardDraft({ intent, context, wizardTarget, parsePlan, buildDraft, category, message }),
      };
    }
    const modelPlan = parsePlan(replyText, { intent });
    const parseCategory = modelPlan?.parseDiagnostics?.category || '';
    if (parseCategory) {
      emitDiagnostic(parseCategory, {
        extracted: Boolean(modelPlan?.parseDiagnostics?.extracted),
        issues: modelPlan?.parseDiagnostics?.issues || [],
      });
    }
    const draftResult = buildDraft({ context, intent, modelPlan, wizardTarget });
    const graphErrors = draftResult?.graphErrors || [];
    const graphFallback = Boolean(!modelPlan?.usedFallback && draftResult?.plan?.usedFallback);
    const loweringRepair = Boolean(draftResult?.plan?.intentIrRepair?.applied);
    let recoveryCategory = modelPlan?.usedFallback ? (parseCategory || WIZARD_DIAGNOSTIC_CATEGORIES.SCHEMA_VALIDATION_FAILED) : '';
    if (!recoveryCategory && graphFallback) recoveryCategory = WIZARD_DIAGNOSTIC_CATEGORIES.GRAPH_VALIDATION_FAILED;
    if (!recoveryCategory && graphErrors.length) recoveryCategory = WIZARD_DIAGNOSTIC_CATEGORIES.GRAPH_VALIDATION_FAILED;
    if (!recoveryCategory && loweringRepair) recoveryCategory = WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED;
    if (recoveryCategory) {
      if (!diagnostics.some((entry) => entry.category === recoveryCategory)) {
        emitDiagnostic(recoveryCategory, {
          graphErrors,
          repairReasons: draftResult?.plan?.intentIrRepair?.reasons || [],
        });
      }
      emitDiagnostic(WIZARD_DIAGNOSTIC_CATEGORIES.FALLBACK_RECOVERED, { rootCategory: recoveryCategory });
    } else {
      emitDiagnostic(WIZARD_DIAGNOSTIC_CATEGORIES.PRIMARY_COMPILED, {
        providerDiagnostics,
        stageKinds: modelPlan?.intentIr?.stages?.map((stage) => stage.kind) || [],
      });
    }
    return {
      ok: true,
      recovered: Boolean(recoveryCategory),
      diagnosticCategory: recoveryCategory || WIZARD_DIAGNOSTIC_CATEGORIES.PRIMARY_COMPILED,
      diagnosticCategories: diagnostics.map((entry) => entry.category),
      diagnostics,
      draftResult: recoveryCategory
        ? annotateRecoveredDraftResult(draftResult, {
            category: recoveryCategory,
            message: getWizardFailureGuidance(recoveryCategory),
          })
        : draftResult,
    };
  } catch (error) {
    const message = getErrorMessage(error, 'Local AI Hub could not compile the wizard model draft into grounded pipeline nodes.');
    emitDiagnostic(WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED, { message });
    try {
      emitDiagnostic(WIZARD_DIAGNOSTIC_CATEGORIES.FALLBACK_RECOVERED, { rootCategory: WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED });
      return {
        ok: true,
        recovered: true,
        diagnosticCategory: WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED,
        diagnosticCategories: diagnostics.map((entry) => entry.category),
        diagnostics,
        draftResult: recoverWizardDraft({ intent, context, wizardTarget, parsePlan, buildDraft, category: WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED, message }),
      };
    } catch (recoveryError) {
      return {
        ok: false,
        diagnosticCategory: WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED,
        diagnostics,
        summary: buildWizardFailureSummary({
          category: WIZARD_DIAGNOSTIC_CATEGORIES.LOWERING_FAILED,
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
  WIZARD_DIAGNOSTIC_CATEGORIES,
  annotateRecoveredDraftResult,
  buildWizardFailureSummary,
  classifyWizardFailure,
  getErrorMessage,
  runPipelineWizardLifecycle,
  withWizardRequestTimeout,
};

module.exports.default = module.exports;
