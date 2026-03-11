const MODALITY_TEXT = 'text';
const MODALITY_IMAGE = 'image';
const MODALITY_AUDIO = 'audio';
const MODALITY_VIDEO = 'video';
const MODALITY_FILE = 'file';

const PIPELINE_OPERATION_IDS = Object.freeze({
  IMAGE_ANALYZE: 'imageAnalyze',
  IMAGE_GENERATE: 'imageGenerate',
  LLM_PROMPT: 'llmPrompt',
  VALIDATION_LLM: 'validationLlm',
  WHISPER_TRANSCRIBE: 'whisperTranscribe',
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

function cloneCapabilityRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    operations: Object.fromEntries(
      Object.entries(record.operations || {}).map(([operationId, operation]) => [operationId, cloneOperation(operation)]),
    ),
  };
}

function getToolPipelineCapabilities(toolId) {
  return cloneCapabilityRecord(TOOL_PIPELINE_CAPABILITIES[String(toolId || '').trim().toLowerCase()] || null);
}

function getProviderPipelineCapabilities(providerId) {
  return cloneCapabilityRecord(PROVIDER_PIPELINE_CAPABILITIES[String(providerId || '').trim().toLowerCase()] || null);
}

function getToolPipelineOperation(toolId, operationId) {
  return cloneOperation(TOOL_PIPELINE_CAPABILITIES[String(toolId || '').trim().toLowerCase()]?.operations?.[operationId] || null);
}

function getProviderPipelineOperation(providerId, operationId) {
  return cloneOperation(PROVIDER_PIPELINE_CAPABILITIES[String(providerId || '').trim().toLowerCase()]?.operations?.[operationId] || null);
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

module.exports = {
  MODALITY_AUDIO,
  MODALITY_FILE,
  MODALITY_IMAGE,
  MODALITY_TEXT,
  MODALITY_VIDEO,
  PIPELINE_OPERATION_IDS,
  getProviderIdsForPipelineOperation,
  getProviderPipelineCapabilities,
  getProviderPipelineOperation,
  getToolIdsForPipelineOperation,
  getToolPipelineCapabilities,
  getToolPipelineOperation,
};

module.exports.default = module.exports;
