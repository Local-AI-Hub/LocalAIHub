const MODALITY_TEXT = 'text';
const MODALITY_IMAGE = 'image';
const MODALITY_AUDIO = 'audio';
const MODALITY_VIDEO = 'video';
const MODALITY_FILE = 'file';

const PIPELINE_OPERATION_IDS = Object.freeze({
  GRAPH_WORKFLOW: 'graphWorkflow',
  IMAGE_ANALYZE: 'imageAnalyze',
  IMAGE_GENERATE: 'imageGenerate',
  VIDEO_GENERATE: 'videoGenerate',
  LLM_PROMPT: 'llmPrompt',
  VALIDATION_LLM: 'validationLlm',
  WHISPER_TRANSCRIBE: 'whisperTranscribe',
});

const TOOL_PIPELINE_STRATEGY_IDS = Object.freeze({
  GRAPH_NATIVE_DEFERRED: 'graph-native-deferred',
  GRAPH_NATIVE_WORKFLOW: 'graph-native-workflow',
  LOCAL_MODEL_RUNTIME: 'local-model-runtime',
  LOCAL_OPERATION_TOOL: 'local-operation-tool',
});

const TOOL_PIPELINE_STRATEGIES = Object.freeze({
  ollama: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_MODEL_RUNTIME,
    label: 'Local model runtime',
    notes: 'Ollama fits the model-step architecture for text generation and multimodal text output, but it is not used for local media generation in this pass.',
  }),
  automatic1111: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'Automatic1111 exposes a simple WebUI API that fits the current sequential model-step pipeline for text-to-image generation.',
  }),
  forge: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'Forge exposes a simple WebUI API that fits the current sequential model-step pipeline for text-to-image generation.',
  }),
  comfyui: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_WORKFLOW,
    label: 'Graph-native workflow tool',
    notes: 'ComfyUI uses the dedicated graph workflow step with explicit typed boundary mappings instead of the model-step abstraction.',
  }),
  invokeai: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_DEFERRED,
    label: 'Graph-native workflow tool',
    notes: 'InvokeAI remains deferred until Local AI Hub adds a dedicated graph-workflow adapter for it.',
  }),
});

const TOOL_PIPELINE_CAPABILITIES = Object.freeze({
  ollama: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        notes: 'Image input requires a vision-capable Ollama model.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        notes: 'Image validation requires a vision-capable Ollama model.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'tool',
  }),
  whisper: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_AUDIO]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'tool',
  }),
  automatic1111: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.IMAGE_ANALYZE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        notes: 'Runs a single text-to-image request through the Stable Diffusion WebUI API.',
        outputKinds: Object.freeze([MODALITY_IMAGE]),
      }),
    }),
    targetType: 'tool',
  }),
  forge: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.IMAGE_ANALYZE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        notes: 'Runs a single text-to-image request through the Stable Diffusion WebUI API.',
        outputKinds: Object.freeze([MODALITY_IMAGE]),
      }),
    }),
    targetType: 'tool',
  }),
});

const PROVIDER_PIPELINE_CAPABILITIES = Object.freeze({
  openai: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        notes: 'Image generation uses a dedicated OpenAI image model such as gpt-image-1.',
        outputKinds: Object.freeze([MODALITY_IMAGE]),
      }),
      [PIPELINE_OPERATION_IDS.VIDEO_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        notes: 'Video generation uses a Sora video model such as sora-2 or sora-2-pro. Image input also needs motion guidance in the step instruction box.',
        outputKinds: Object.freeze([MODALITY_VIDEO]),
      }),
    }),
    targetType: 'provider',
  }),
  anthropic: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'provider',
  }),
  google: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'provider',
  }),
  mistral: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'provider',
  }),
  groq: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'provider',
  }),
  deepseek: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'provider',
  }),
  xai: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'provider',
  }),
});

const PROVIDER_MODEL_CAPABILITY_RULES = Object.freeze({
  openai: Object.freeze([
    Object.freeze({
      capabilityLabels: Object.freeze(['Image generation']),
      capabilitySource: 'explicit',
      exclusive: true,
      operations: Object.freeze({
        [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
          inputKinds: Object.freeze([MODALITY_TEXT]),
          notes: 'Creates an image from a text prompt.',
          outputKinds: Object.freeze([MODALITY_IMAGE]),
        }),
      }),
      pattern: /^(gpt-image-1(?:.5|-mini)?)$/i,
    }),
    Object.freeze({
      capabilityLabels: Object.freeze(['Video generation', 'Image reference']),
      capabilitySource: 'explicit',
      exclusive: true,
      operations: Object.freeze({
        [PIPELINE_OPERATION_IDS.VIDEO_GENERATE]: Object.freeze({
          inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
          notes: 'Creates a video from text or from an image plus motion guidance.',
          outputKinds: Object.freeze([MODALITY_VIDEO]),
        }),
      }),
      pattern: /^sora-2(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/i,
    }),
  ]),
});

const PROVIDER_MODEL_FALLBACK_OPERATION_IDS = Object.freeze({
  openai: Object.freeze([PIPELINE_OPERATION_IDS.LLM_PROMPT, PIPELINE_OPERATION_IDS.VALIDATION_LLM]),
});

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function cloneKinds(kinds = []) {
  return [...new Set((kinds || []).map((kind) => String(kind || '').trim().toLowerCase()).filter(Boolean))];
}

function cloneOperation(operation) {
  if (!operation) {
    return null;
  }

  return {
    ...operation,
    inputKinds: cloneKinds(operation.inputKinds),
    outputKinds: cloneKinds(operation.outputKinds),
  };
}

function cloneOperationMap(operations = {}) {
  return Object.fromEntries(Object.entries(operations || {}).map(([operationId, operation]) => [operationId, cloneOperation(operation)]));
}

function cloneCapabilityRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    capabilityLabels: Array.isArray(record.capabilityLabels)
      ? [...new Set(record.capabilityLabels.map((entry) => String(entry || '').trim()).filter(Boolean))]
      : [],
    capabilitySource: String(record.capabilitySource || '').trim() || '',
    operations: cloneOperationMap(record.operations || {}),
  };
}

function cloneToolPipelineStrategy(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    label: String(record.label || '').trim() || '',
    notes: String(record.notes || '').trim() || '',
  };
}

function getToolPipelineCapabilities(toolId) {
  return cloneCapabilityRecord(TOOL_PIPELINE_CAPABILITIES[normalizeId(toolId)] || null);
}

function getProviderPipelineCapabilities(providerId) {
  return cloneCapabilityRecord(PROVIDER_PIPELINE_CAPABILITIES[normalizeId(providerId)] || null);
}

function getToolPipelineStrategy(toolId) {
  return cloneToolPipelineStrategy(TOOL_PIPELINE_STRATEGIES[normalizeId(toolId)] || null);
}

function getMatchingProviderModelRule(providerId, modelId) {
  const normalizedModelId = String(modelId || '').trim();
  if (!normalizedModelId) {
    return null;
  }

  return (PROVIDER_MODEL_CAPABILITY_RULES[normalizeId(providerId)] || []).find((rule) => rule.pattern?.test(normalizedModelId)) || null;
}

function getProviderModelFallbackOperations(providerId) {
  const providerRecord = PROVIDER_PIPELINE_CAPABILITIES[providerId] || null;
  const fallbackOperationIds = PROVIDER_MODEL_FALLBACK_OPERATION_IDS[providerId] || null;
  if (!providerRecord) {
    return {};
  }

  if (!fallbackOperationIds) {
    return providerRecord.operations || {};
  }

  return Object.fromEntries(
    fallbackOperationIds
      .map((operationId) => [operationId, providerRecord.operations?.[operationId] || null])
      .filter(([, operation]) => Boolean(operation)),
  );
}

function getProviderModelCapabilities(providerId, modelId) {
  const normalizedProviderId = normalizeId(providerId);
  const providerRecord = PROVIDER_PIPELINE_CAPABILITIES[normalizedProviderId] || null;
  const rule = getMatchingProviderModelRule(providerId, modelId);
  const fallbackOperations = getProviderModelFallbackOperations(normalizedProviderId);
  if (!rule) {
    return cloneCapabilityRecord(
      providerRecord
        ? {
            ...providerRecord,
            operations: fallbackOperations,
          }
        : null,
    );
  }

  const baseOperations = rule.exclusive ? {} : fallbackOperations;
  return cloneCapabilityRecord({
    capabilityLabels: rule.capabilityLabels || [],
    capabilitySource: rule.capabilitySource || 'explicit',
    operations: {
      ...baseOperations,
      ...(rule.operations || {}),
    },
    targetType: 'provider',
  });
}

function getToolPipelineOperation(toolId, operationId) {
  return cloneOperation(TOOL_PIPELINE_CAPABILITIES[normalizeId(toolId)]?.operations?.[operationId] || null);
}

function getProviderPipelineOperation(providerId, operationId) {
  return cloneOperation(PROVIDER_PIPELINE_CAPABILITIES[normalizeId(providerId)]?.operations?.[operationId] || null);
}

function getProviderModelOperation(providerId, modelId, operationId) {
  return cloneOperation(getProviderModelCapabilities(providerId, modelId)?.operations?.[operationId] || null);
}

function doesProviderModelSupportOperation(providerId, modelId, operationId) {
  return Boolean(getProviderModelCapabilities(providerId, modelId)?.operations?.[operationId]);
}

function getToolIdsForPipelineOperation(operationId) {
  return Object.entries(TOOL_PIPELINE_CAPABILITIES)
    .filter(([, record]) => Boolean(record?.operations?.[operationId]))
    .map(([toolId]) => toolId);
}

function getProviderIdsForPipelineOperation(operationId) {
  return Object.entries(PROVIDER_PIPELINE_CAPABILITIES)
    .filter(([, record]) => Boolean(record?.operations?.[operationId]))
    .map(([providerId]) => providerId);
}

function getToolIdsForPipelineStrategy(strategyIds) {
  const normalizedStrategyIds = (Array.isArray(strategyIds) ? strategyIds : [strategyIds])
    .map((strategyId) => String(strategyId || '').trim())
    .filter(Boolean);

  if (!normalizedStrategyIds.length) {
    return [];
  }

  return Object.entries(TOOL_PIPELINE_STRATEGIES)
    .filter(([, record]) => normalizedStrategyIds.includes(record?.id))
    .map(([toolId]) => toolId);
}

function getGraphWorkflowToolIds(options = {}) {
  const strategyIds = [TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_WORKFLOW];
  if (options.includeDeferred !== false) {
    strategyIds.push(TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_DEFERRED);
  }

  return getToolIdsForPipelineStrategy(strategyIds);
}

function getRunnableGraphWorkflowToolIds() {
  return getToolIdsForPipelineStrategy(TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_WORKFLOW);
}
function getOperationDrivenToolIdsForPipelineOperation(operationId) {
  return Object.entries(TOOL_PIPELINE_CAPABILITIES)
    .filter(([toolId, record]) => {
      if (!record?.operations?.[operationId]) {
        return false;
      }

      return TOOL_PIPELINE_STRATEGIES[toolId]?.id === TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL;
    })
    .map(([toolId]) => toolId);
}

module.exports = {
  MODALITY_AUDIO,
  MODALITY_FILE,
  MODALITY_IMAGE,
  MODALITY_TEXT,
  MODALITY_VIDEO,
  PIPELINE_OPERATION_IDS,
  TOOL_PIPELINE_STRATEGY_IDS,
  doesProviderModelSupportOperation,
  getGraphWorkflowToolIds,
  getOperationDrivenToolIdsForPipelineOperation,
  getProviderIdsForPipelineOperation,
  getProviderModelCapabilities,
  getProviderModelOperation,
  getProviderPipelineCapabilities,
  getProviderPipelineOperation,
  getRunnableGraphWorkflowToolIds,
  getToolIdsForPipelineOperation,
  getToolIdsForPipelineStrategy,
  getToolPipelineCapabilities,
  getToolPipelineOperation,
  getToolPipelineStrategy,
};

module.exports.default = module.exports;




