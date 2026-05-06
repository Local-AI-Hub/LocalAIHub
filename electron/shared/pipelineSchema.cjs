const {
  PIPELINE_OPERATION_IDS,
  TOOL_PIPELINE_STRATEGY_IDS,
  getGraphWorkflowToolIds,
  getOperationDrivenToolIdsForPipelineOperation,
  getProviderIdsForPipelineOperation,
  getProviderModelCapabilities,
  getProviderPipelineOperation,
  doesProviderOperationRequireExplicitModel,
  getRunnableGraphWorkflowToolIds,
  getToolPipelineOperation,
  getToolPipelineStrategy,
} = require('./pipelineCapabilities.cjs');
const {
  GRAPH_WORKFLOW_BINDING_MODE_IDS,
  GRAPH_WORKFLOW_OPERATION_BACKEND_IDS,
  getDefaultGraphWorkflowBindings,
  getGraphWorkflowContract,
  getGraphWorkflowOperationBackendSupport,
  getGraphWorkflowFieldOptions,
  getGraphWorkflowInputBinding,
  getGraphWorkflowNodeEntry,
  getGraphWorkflowOutputBinding,
  getGraphWorkflowOutputNodeOptions,
  parseGraphWorkflowDefinitionText,
} = require('./graphWorkflowContracts.cjs');
const {
  DEFAULT_PLANNING_SCHEMA_ID,
  getPlanningSchemaDefinition,
  getPlanningSchemaOptions,
} = require('./planningSchema.cjs');
const {
  findRvcVoiceModelMatch,
  findStableDiffusionCheckpointMatch,
  getRvcVoiceModels,
  getStableDiffusionCheckpointModels,
  isLikelySupportOnlyStableDiffusionModel,
} = require('./toolAssetSelection.cjs');

const PIPELINE_SCHEMA_VERSION = 8;
const PIPELINE_RETRY_LOOP_MAX_ATTEMPTS = 8;
const DEFAULT_POSITION_X = 120;
const DEFAULT_POSITION_Y = 120;
const PORT_KIND_TEXT = 'text';
const PORT_KIND_IMAGE = 'image';
const PORT_KIND_AUDIO = 'audio';
const PORT_KIND_VIDEO = 'video';
const PORT_KIND_FILE = 'file';
const PORT_KIND_PLANNING_PACKET = 'planningPacket';
const PORT_KIND_PLAN = 'plan';
const PORT_KIND_PREVIEW = 'preview';
const PORT_KIND_AUDIT = 'audit';
const PORT_KIND_COMPOSITION = 'composition';
const PORT_KIND_COLLECTION = 'collection';
const PORT_COLLECTION_KIND_PREFIX = PORT_KIND_COLLECTION + ':';
const PORT_KIND_ANY = 'any';
const PORT_KIND_PASSTHROUGH = 'passthrough';
const PORT_KIND_AUDIO_FILE = PORT_KIND_AUDIO;
const COLLECTION_ITEM_PORT_KINDS = Object.freeze([
  PORT_KIND_TEXT,
  PORT_KIND_IMAGE,
  PORT_KIND_AUDIO,
  PORT_KIND_VIDEO,
  PORT_KIND_FILE,
]);
const VALIDATION_INPUT_PORT_KINDS = Object.freeze([
  ...COLLECTION_ITEM_PORT_KINDS,
  PORT_KIND_PLAN,
]);
const SUPPORTED_PORT_KINDS = Object.freeze([
  ...COLLECTION_ITEM_PORT_KINDS,
  PORT_KIND_PLANNING_PACKET,
  PORT_KIND_PLAN,
  PORT_KIND_COMPOSITION,
]);
const PIPELINE_PORT_KIND_LABELS = Object.freeze({
  [PORT_KIND_TEXT]: 'Text',
  [PORT_KIND_IMAGE]: 'Image',
  [PORT_KIND_AUDIO]: 'Audio',
  [PORT_KIND_VIDEO]: 'Video',
  [PORT_KIND_FILE]: 'File',
  [PORT_KIND_PLANNING_PACKET]: 'Planning Packet',
  [PORT_KIND_PLAN]: 'Plan',
  [PORT_KIND_PREVIEW]: 'Preview',
  [PORT_KIND_AUDIT]: 'Audit',
  [PORT_KIND_COMPOSITION]: 'Composition',
  [PORT_KIND_COLLECTION]: 'Collection',
});
const PIPELINE_OPERATION_LABELS = Object.freeze({
  [PIPELINE_OPERATION_IDS.GRAPH_WORKFLOW]: 'Graph workflow',
  [PIPELINE_OPERATION_IDS.IMAGE_ANALYZE]: 'Image analysis',
  [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: 'Image generation',
  [PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM]: 'Image transform',
  [PIPELINE_OPERATION_IDS.VIDEO_GENERATE]: 'Video generation',
  [PIPELINE_OPERATION_IDS.AUDIO_GENERATE]: 'Audio generation',
  [PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM]: 'Audio transform',
  [PIPELINE_OPERATION_IDS.LLM_PROMPT]: 'Text response',
  [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: 'LLM validation',
  [PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE]: 'Transcription',
});
const MODEL_STEP_CLOUD_OPERATION_OPTIONS = Object.freeze([
  {
    id: PIPELINE_OPERATION_IDS.LLM_PROMPT,
    label: 'Text response',
  },
  {
    id: PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
    label: 'Image generation',
  },
  {
    id: PIPELINE_OPERATION_IDS.AUDIO_GENERATE,
    label: 'Audio generation',
  },
  {
    id: PIPELINE_OPERATION_IDS.VIDEO_GENERATE,
    label: 'Video generation',
  },
]);
const IMAGE_WORKFLOW_TOOL_IDS = Object.freeze(getOperationDrivenToolIdsForPipelineOperation(PIPELINE_OPERATION_IDS.IMAGE_GENERATE));
const IMAGE_TRANSFORM_TOOL_IDS = Object.freeze(getOperationDrivenToolIdsForPipelineOperation(PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM));
const IMAGE_TRANSFORM_SUBTYPE_OPTIONS = Object.freeze({
  upscayl: Object.freeze([
    Object.freeze({ id: 'upscale', label: 'Upscale' }),
    Object.freeze({ id: 'enhance', label: 'Enhance' }),
  ]),
  facefusion: Object.freeze([
    Object.freeze({ id: 'face-swap', label: 'Face swap' }),
  ]),
});
const VIDEO_WORKFLOW_TOOL_IDS = Object.freeze(getOperationDrivenToolIdsForPipelineOperation(PIPELINE_OPERATION_IDS.VIDEO_GENERATE));
const AUDIO_WORKFLOW_TOOL_IDS = Object.freeze(getOperationDrivenToolIdsForPipelineOperation(PIPELINE_OPERATION_IDS.AUDIO_GENERATE));
const AUDIO_TRANSFORM_TOOL_IDS = Object.freeze(getOperationDrivenToolIdsForPipelineOperation(PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM));
const GRAPH_WORKFLOW_TOOL_IDS = Object.freeze(getGraphWorkflowToolIds());
const RUNNABLE_GRAPH_WORKFLOW_TOOL_IDS = Object.freeze(getRunnableGraphWorkflowToolIds());
const DEFAULT_GRAPH_WORKFLOW_TOOL_ID = RUNNABLE_GRAPH_WORKFLOW_TOOL_IDS[0] || GRAPH_WORKFLOW_TOOL_IDS[0] || 'comfyui';
const DEFAULT_GRAPH_WORKFLOW_BINDINGS = Object.freeze(getDefaultGraphWorkflowBindings(DEFAULT_GRAPH_WORKFLOW_TOOL_ID));

const WHISPER_MODELS = [
  { id: 'tiny', label: 'Tiny' },
  { id: 'base', label: 'Base' },
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large-v3', label: 'Large v3' },
];

const PIPELINE_NODE_TYPES = Object.freeze({
  textInput: Object.freeze({
    type: 'textInput',
    label: 'Text Input',
    category: 'Inputs',
    description: 'Adds plain text to a workflow run.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'text',
        kind: PORT_KIND_TEXT,
        label: 'Text',
      },
    ],
    configDefaults: {
      text: '',
    },
  }),
  imageInput: Object.freeze({
    type: 'imageInput',
    label: 'Image File',
    category: 'Inputs',
    description: 'Supplies an image file to later nodes.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'image',
        kind: PORT_KIND_IMAGE,
        label: 'Image',
      },
    ],
    configDefaults: {
      filePath: '',
    },
  }),
  audioInput: Object.freeze({
    type: 'audioInput',
    label: 'Audio File',
    category: 'Inputs',
    description: 'Supplies an audio file path to later nodes.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'audio',
        kind: PORT_KIND_AUDIO,
        label: 'Audio',
      },
    ],
    configDefaults: {
      filePath: '',
    },
  }),
  videoInput: Object.freeze({
    type: 'videoInput',
    label: 'Video File',
    category: 'Inputs',
    description: 'Supplies a video file to later nodes.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'audio',
        kind: PORT_KIND_AUDIO,
        label: 'Audio',
      },
      {
        id: 'video',
        kind: PORT_KIND_VIDEO,
        label: 'Video',
      },
    ],
    configDefaults: {
      filePath: '',
    },
  }),
  fileInput: Object.freeze({
    type: 'fileInput',
    label: 'File Input',
    category: 'Inputs',
    description: 'Passes a general file or artifact reference into the workflow.',
    inputPorts: [],
    outputPorts: [
      {
        id: 'file',
        kind: PORT_KIND_FILE,
        label: 'File',
      },
    ],
    configDefaults: {
      filePath: '',
    },
  }),
  planningPacket: Object.freeze({
    type: 'planningPacket',
    label: 'Planning Packet',
    category: 'Planning',
    description: 'Builds an editable planning packet from upstream source artifacts plus structured planning context.',
    inputPorts: [
      {
        id: 'source',
        kind: PORT_KIND_ANY,
        allowedKinds: COLLECTION_ITEM_PORT_KINDS,
        label: 'Source',
        allowMultipleConnections: true,
        minimumConnections: 1,
      },
    ],
    outputPorts: [
      {
        id: 'packet',
        kind: PORT_KIND_PLANNING_PACKET,
        label: 'Packet',
      },
    ],
    configDefaults: {
      schemaId: DEFAULT_PLANNING_SCHEMA_ID,
      title: '',
      goal: '',
      sourceSummary: '',
      constraintsText: '',
      stylePolicyText: '',
      availableToolsText: '',
      readinessNotesText: '',
      desiredOutputNotes: '',
      riskNotesText: '',
      uncertaintyFlagsText: '',
      additionalContext: '',
    },
  }),
  llmPrompt: Object.freeze({
    type: 'llmPrompt',
    label: 'Model Step',
    category: 'AI Steps',
    description: 'Sends compatible text or media to a model and returns the selected typed output. Local image transformation can also use an optional Reference Image input for source-image lineage.',
    inputPorts: [
      {
        id: 'prompt',
        kind: PORT_KIND_ANY,
        allowedKinds: [PORT_KIND_TEXT, PORT_KIND_IMAGE, PORT_KIND_VIDEO, PORT_KIND_FILE],
        label: 'Input',
        required: true,
      },
      {
        id: 'referenceImage',
        kind: PORT_KIND_ANY,
        dynamicOnly: true,
        label: 'Reference Image',
      },
    ],
    outputPorts: [
      {
        id: 'text',
        kind: PORT_KIND_TEXT,
        label: 'Text',
      },
      {
        id: 'image',
        kind: PORT_KIND_IMAGE,
        label: 'Image',
      },
      {
        id: 'audio',
        kind: PORT_KIND_AUDIO,
        label: 'Audio',
      },
      {
        id: 'video',
        kind: PORT_KIND_VIDEO,
        label: 'Video',
      },
    ],
    configDefaults: {
      executionMode: 'cloud',
      operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT,
      providerId: '',
      toolId: '',
      model: '',
      instruction: '',
      systemPrompt: '',
      imageSize: '1024x1024',
      imageQuality: 'auto',
      imageBackground: 'auto',
      videoSize: '1280x720',
      audioVoice: '',
      audioMode: 'music',
      durationSeconds: 8,
      negativePrompt: '',
      width: 832,
      height: 832,
      steps: 24,
      cfgScale: 7,
      seed: -1,
      transformSubtype: '',
      analysisMode: 'clip',
    },
    cloudOperationOptions: MODEL_STEP_CLOUD_OPERATION_OPTIONS,
    supportedExecutionModes: [
      {
        id: 'cloud',
        label: 'Cloud provider',
      },
      {
        id: 'ollama',
        label: 'Ollama (local)',
        requiredToolId: 'ollama',
      },
      {
        id: 'localTool',
        label: 'Local media tool',
      },
    ],
  }),
  planner: Object.freeze({
    type: 'planner',
    label: 'Planner',
    category: 'Planning',
    description: 'Consumes a Planning Packet, reasons inside the selected planning schema, and returns a typed Plan artifact.',
    inputPorts: [
      {
        id: 'packet',
        kind: PORT_KIND_PLANNING_PACKET,
        label: 'Planning Packet',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'plan',
        kind: PORT_KIND_PLAN,
        label: 'Plan',
      },
    ],
    configDefaults: {
      executionMode: 'cloud',
      providerId: '',
      model: '',
      schemaId: '',
      instruction: '',
      systemPrompt: '',
    },
    supportedExecutionModes: [
      {
        id: 'cloud',
        label: 'Cloud provider',
      },
      {
        id: 'ollama',
        label: 'Ollama (local)',
        requiredToolId: 'ollama',
      },
    ],
    schemaOptions: getPlanningSchemaOptions(),
  }),
  planScenes: Object.freeze({
    type: 'planScenes',
    label: 'Plan Scenes',
    category: 'Planning',
    description: 'Turns a structured Plan into an ordered text collection of scene prompt drafts for downstream output or later generation work.',
    inputPorts: [
      {
        id: 'plan',
        kind: PORT_KIND_PLAN,
        label: 'Plan',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'collection',
        kind: PORT_KIND_TEXT,
        collectionBehavior: 'only',
        label: 'Scene Text Collection',
      },
    ],
    configDefaults: {},
  }),
  graphWorkflow: Object.freeze({
    type: 'graphWorkflow',
    label: 'Graph Workflow',
    category: 'AI Steps',
    description: 'Runs a graph-native local workflow with explicit typed boundaries. Use this for ComfyUI, InvokeAI, and other graph-style tools instead of the model-step abstraction.',
    inputPorts: [
      {
        id: 'text',
        kind: PORT_KIND_TEXT,
        label: 'Text',
      },
      {
        id: 'image',
        kind: PORT_KIND_IMAGE,
        label: 'Image',
      },
    ],
    outputPorts: [
      {
        id: 'image',
        kind: PORT_KIND_IMAGE,
        label: 'Image',
      },
      {
        id: 'video',
        kind: PORT_KIND_VIDEO,
        label: 'Video',
      },
    ],
    configDefaults: {
      graphContractVersion: 1,
      toolId: DEFAULT_GRAPH_WORKFLOW_TOOL_ID,
      workflowFormat: DEFAULT_GRAPH_WORKFLOW_BINDINGS.workflowFormat,
      workflowText: '',
      inputBindings: DEFAULT_GRAPH_WORKFLOW_BINDINGS.inputBindings,
      outputBindings: DEFAULT_GRAPH_WORKFLOW_BINDINGS.outputBindings,
    },
    supportedToolIds: GRAPH_WORKFLOW_TOOL_IDS,
  }),
  validation: Object.freeze({
    type: 'validation',
    label: 'Validation',
    category: 'Validation',
    description: 'Evaluates incoming content and routes it to pass or fail.',
    inputPorts: [
      {
        id: 'input',
        kind: PORT_KIND_ANY,
        allowedKinds: VALIDATION_INPUT_PORT_KINDS,
        collectionBehavior: 'allow',
        label: 'Input',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'pass',
        kind: PORT_KIND_PASSTHROUGH,
        label: 'Pass',
        passthroughFrom: 'input',
      },
      {
        id: 'fail',
        kind: PORT_KIND_PASSTHROUGH,
        label: 'Fail',
        passthroughFrom: 'input',
      },
    ],
    configDefaults: {
      mode: 'user',
      llmExecutionMode: 'cloud',
      providerId: '',
      model: '',
      ruleset: '',
      systemPrompt: '',
    },
    supportedExecutionModes: [
      {
        id: 'user',
        label: 'User approval',
      },
      {
        id: 'llm',
        label: 'LLM validator',
      },
    ],
    supportedLlmExecutionModes: [
      {
        id: 'cloud',
        label: 'Cloud provider',
      },
      {
        id: 'ollama',
        label: 'Ollama (local)',
        requiredToolId: 'ollama',
      },
    ],
  }),
  branchMerge: Object.freeze({
    type: 'branchMerge',
    label: 'Branch Merge',
    category: 'Flow',
    description: 'Recombines routed branches and forwards the single branch that stayed active.',
    inputPorts: [
      {
        id: 'branch',
        kind: PORT_KIND_ANY,
        allowedKinds: SUPPORTED_PORT_KINDS,
        collectionBehavior: 'allow',
        label: 'Branches',
        required: true,
        allowMultipleConnections: true,
        minimumConnections: 2,
      },
    ],
    outputPorts: [
      {
        id: 'result',
        kind: PORT_KIND_PASSTHROUGH,
        label: 'Result',
        passthroughFrom: 'branch',
      },
    ],
    configDefaults: {},
  }),
  retryLoop: Object.freeze({
    type: 'retryLoop',
    label: 'Retry Loop',
    category: 'Flow',
    description: 'Retries an earlier step or subflow when the retry branch stays active, then exits through the complete branch.',
    inputPorts: [
      {
        id: 'complete',
        kind: PORT_KIND_ANY,
        allowedKinds: SUPPORTED_PORT_KINDS,
        collectionBehavior: 'allow',
        label: 'Complete',
      },
      {
        id: 'retry',
        kind: PORT_KIND_ANY,
        allowedKinds: SUPPORTED_PORT_KINDS,
        collectionBehavior: 'allow',
        label: 'Retry',
      },
    ],
    outputPorts: [
      {
        id: 'result',
        kind: PORT_KIND_PASSTHROUGH,
        label: 'Result',
        passthroughFrom: 'complete',
      },
    ],
    configDefaults: {
      retryTargetNodeId: '',
      maxAttempts: 3,
      retryTerminationAction: 'fail',
      stopWhenRetryArtifactRepeats: false,
    },
  }),
  collectionBuilder: Object.freeze({
    type: 'collectionBuilder',
    label: 'Collection Builder',
    category: 'Flow',
    description: 'Builds an ordered collection from compatible single artifacts and can extend an existing collection.',
    inputPorts: [
      {
        id: 'items',
        kind: PORT_KIND_ANY,
        allowedKinds: COLLECTION_ITEM_PORT_KINDS,
        label: 'Items',
        required: true,
        allowMultipleConnections: true,
        minimumConnections: 1,
      },
      {
        id: 'existing',
        kind: PORT_KIND_ANY,
        allowedKinds: COLLECTION_ITEM_PORT_KINDS,
        collectionBehavior: 'only',
        label: 'Existing Collection',
      },
    ],
    outputPorts: [
      {
        id: 'collection',
        kind: PORT_KIND_ANY,
        allowedKinds: COLLECTION_ITEM_PORT_KINDS,
        collectionBehavior: 'only',
        label: 'Collection',
      },
    ],
    configDefaults: {
      insertionMode: 'append',
    },
  }),
  collectionMap: Object.freeze({
    type: 'collectionMap',
    label: 'Map Collection',
    category: 'Flow',
    description: 'Applies one supported operation to every item in an ordered collection and emits a same-order collection with item lineage preserved. This first slice supports text prompts to generated images.',
    inputPorts: [
      {
        id: 'collection',
        kind: PORT_KIND_TEXT,
        collectionBehavior: 'only',
        label: 'Text Collection',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'collection',
        kind: PORT_KIND_IMAGE,
        collectionBehavior: 'only',
        label: 'Image Collection',
      },
    ],
    configDefaults: {
      operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE,
      executionMode: 'cloud',
      providerId: '',
      toolId: '',
      graphWorkflowToolId: DEFAULT_GRAPH_WORKFLOW_TOOL_ID,
      workflowText: '',
      inputBindings: DEFAULT_GRAPH_WORKFLOW_BINDINGS.inputBindings,
      outputBindings: DEFAULT_GRAPH_WORKFLOW_BINDINGS.outputBindings,
      workflowFormat: DEFAULT_GRAPH_WORKFLOW_BINDINGS.workflowFormat,
      model: '',
      instruction: 'Generate one image for each text item while preserving the source order.',
      imageSize: '1024x1024',
      imageQuality: 'auto',
      imageBackground: 'auto',
      negativePrompt: '',
      width: 832,
      height: 832,
      steps: 24,
      cfgScale: 7,
      seed: -1,
    },
  }),
  collectionAccumulator: Object.freeze({
    type: 'collectionAccumulator',
    label: 'Accumulate Until Target',
    category: 'Flow',
    description: 'Keeps accepted same-type items from one or more validated branches across loop attempts until the target count is reached, then emits one ordered collection.',
    inputPorts: [
      {
        id: 'item',
        kind: PORT_KIND_ANY,
        allowedKinds: COLLECTION_ITEM_PORT_KINDS,
        label: 'Accepted Items',
        required: true,
        allowMultipleConnections: true,
        minimumConnections: 1,
      },
    ],
    outputPorts: [
      {
        id: 'collection',
        kind: PORT_KIND_ANY,
        allowedKinds: COLLECTION_ITEM_PORT_KINDS,
        collectionBehavior: 'only',
        label: 'Collection',
      },
    ],
    configDefaults: {
      targetCount: 3,
    },
  }),
  collectionOutput: Object.freeze({
    type: 'collectionOutput',
    label: 'Collection Output',
    category: 'Outputs',
    description: 'Shows the final ordered collection and saves a manifest plus its ordered items to the run folder.',
    inputPorts: [
      {
        id: 'collection',
        kind: PORT_KIND_ANY,
        allowedKinds: COLLECTION_ITEM_PORT_KINDS,
        collectionBehavior: 'only',
        label: 'Collection',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'Collection result',
    },
  }),
  mediaComposition: Object.freeze({
    type: 'mediaComposition',
    label: 'Media Composition',
    category: 'Flow',
    description: 'Builds a reusable media composition from an ordered image collection with optional narration and optional background music.',
    inputPorts: [
      {
        id: 'visuals',
        kind: PORT_KIND_IMAGE,
        collectionBehavior: 'only',
        label: 'Visual Collection',
        required: true,
      },
      {
        id: 'audio',
        kind: PORT_KIND_AUDIO,
        label: 'Primary Audio',
      },
      {
        id: 'backgroundMusic',
        kind: PORT_KIND_AUDIO,
        label: 'Background Music',
      },
    ],
    outputPorts: [
      {
        id: 'composition',
        kind: PORT_KIND_COMPOSITION,
        label: 'Composition',
      },
    ],
    configDefaults: {
      secondsPerItem: 4,
    },
  }),
  mediaExport: Object.freeze({
    type: 'mediaExport',
    label: 'Media Export',
    category: 'Flow',
    description: 'Renders a saved media composition into a video artifact through the shared export path.',
    inputPorts: [
      {
        id: 'composition',
        kind: PORT_KIND_COMPOSITION,
        label: 'Composition',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'video',
        kind: PORT_KIND_VIDEO,
        label: 'Video',
      },
    ],
    configDefaults: {
      title: 'Composed video',
      width: 1280,
      height: 720,
      fps: 30,
      fitMode: 'contain',
      stopMode: 'shortest',
    },
  }),
  planOutput: Object.freeze({
    type: 'planOutput',
    label: 'Plan Output',
    category: 'Outputs',
    description: 'Shows the final structured plan and saves its JSON output to the run folder.',
    inputPorts: [
      {
        id: 'plan',
        kind: PORT_KIND_PLAN,
        label: 'Plan',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'Plan result',
    },
  }),
  textOutput: Object.freeze({
    type: 'textOutput',
    label: 'Text Output',
    category: 'Outputs',
    description: 'Shows the final text result inline and saves a copy to the run folder.',
    inputPorts: [
      {
        id: 'text',
        kind: PORT_KIND_TEXT,
        label: 'Text',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'Text result',
    },
  }),
  imageOutput: Object.freeze({
    type: 'imageOutput',
    label: 'Image Output',
    category: 'Outputs',
    description: 'Shows the final image and saves a copy to the run folder.',
    inputPorts: [
      {
        id: 'image',
        kind: PORT_KIND_IMAGE,
        label: 'Image',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'Image result',
    },
  }),
  audioOutput: Object.freeze({
    type: 'audioOutput',
    label: 'Audio Output',
    category: 'Outputs',
    description: 'Keeps the final audio artifact and shows where it was saved.',
    inputPorts: [
      {
        id: 'audio',
        kind: PORT_KIND_AUDIO,
        label: 'Audio',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'Audio result',
    },
  }),
  videoOutput: Object.freeze({
    type: 'videoOutput',
    label: 'Video Output',
    category: 'Outputs',
    description: 'Keeps the final video artifact and shows where it was saved.',
    inputPorts: [
      {
        id: 'video',
        kind: PORT_KIND_VIDEO,
        label: 'Video',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'Video result',
    },
  }),
  fileOutput: Object.freeze({
    type: 'fileOutput',
    label: 'File Output',
    category: 'Outputs',
    description: 'Keeps the final file reference and shows where it was saved.',
    inputPorts: [
      {
        id: 'file',
        kind: PORT_KIND_FILE,
        label: 'File',
        required: true,
      },
    ],
    outputPorts: [],
    terminal: true,
    configDefaults: {
      title: 'File result',
    },
  }),
});

const NODE_TYPE_LIST = Object.freeze(Object.values(PIPELINE_NODE_TYPES));

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createUniqueId(prefix = 'item') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toNonEmptyString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeTimestamp(value) {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function normalizeNumber(value, fallback) {
  const nextValue = Number(value);
  return Number.isFinite(nextValue) ? nextValue : fallback;
}

function normalizePortKind(kind) {
  const normalized = String(kind || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  if (normalized === 'audio-file') {
    return PORT_KIND_AUDIO;
  }

  return normalized;
}

function getSupportedPortKinds() {
  return [...SUPPORTED_PORT_KINDS];
}

function getPortCollectionBehavior(port) {
  const behavior = String(port?.collectionBehavior || '').trim().toLowerCase();
  return behavior === 'allow' || behavior === 'only' ? behavior : 'single';
}

function createCollectionPortKind(kind) {
  const normalized = normalizePortKind(kind);
  if (!normalized) {
    return '';
  }

  if (normalized.startsWith(PORT_COLLECTION_KIND_PREFIX)) {
    return normalized;
  }

  if (normalized === PORT_KIND_ANY || normalized === PORT_KIND_PASSTHROUGH || normalized === PORT_KIND_COLLECTION || normalized === PORT_KIND_COMPOSITION) {
    return '';
  }

  return PORT_COLLECTION_KIND_PREFIX + normalized;
}

function getCollectionItemKind(kind) {
  const normalized = normalizePortKind(kind);
  if (!normalized.startsWith(PORT_COLLECTION_KIND_PREFIX)) {
    return '';
  }

  return normalizePortKind(normalized.slice(PORT_COLLECTION_KIND_PREFIX.length));
}

function isCollectionPortKind(kind) {
  return Boolean(getCollectionItemKind(kind));
}

function formatPortKindLabel(kind) {
  const normalized = normalizePortKind(kind);
  if (isCollectionPortKind(normalized)) {
    const itemKind = getCollectionItemKind(normalized);
    return (PIPELINE_PORT_KIND_LABELS[itemKind] || itemKind || PIPELINE_PORT_KIND_LABELS[PORT_KIND_COLLECTION]) + ' Collection';
  }

  return PIPELINE_PORT_KIND_LABELS[normalized] || normalized;
}

function applyCollectionBehaviorToKinds(kinds = [], port) {
  const normalizedKinds = [...new Set((kinds || []).map((entry) => normalizePortKind(entry)).filter(Boolean))]
    .filter((kind) => !isCollectionPortKind(kind));
  const behavior = getPortCollectionBehavior(port);
  if (behavior === 'only') {
    return normalizedKinds.map((kind) => createCollectionPortKind(kind)).filter(Boolean);
  }

  if (behavior === 'allow') {
    return [
      ...normalizedKinds,
      ...normalizedKinds.map((kind) => createCollectionPortKind(kind)).filter(Boolean),
    ];
  }

  return normalizedKinds;
}

function resolveDynamicInputKinds(node, port) {
  if (!node || !port) {
    return [];
  }

  if (node.type === 'llmPrompt' && port.id === 'prompt') {
    const executionMode = getModelStepExecutionMode(node);
    const operationId = getModelStepOperationId(node);

    if (executionMode === 'ollama') {
      return uniqueKindList(getToolPipelineOperation('ollama', PIPELINE_OPERATION_IDS.LLM_PROMPT)?.inputKinds || []);
    }

    if (executionMode === 'localTool') {
      const toolId = getModelStepLocalToolId(node, {});
      const toolIds = toolId ? [toolId] : getOperationDrivenToolIdsForModelStepOperation(operationId);
      return uniqueKindList(toolIds.flatMap((entry) => getToolPipelineOperation(entry, operationId)?.inputKinds || []));
    }

    const providerId = String(node?.config?.providerId || '').trim().toLowerCase();
    const modelId = String(node?.config?.model || '').trim();
    if (providerId) {
      const providerOperation = modelId
        ? getProviderModelCapabilities(providerId, modelId)?.operations?.[operationId] || getProviderPipelineOperation(providerId, operationId)
        : getProviderPipelineOperation(providerId, operationId);
      return uniqueKindList(providerOperation?.inputKinds || []);
    }

    return uniqueKindList(
      getProviderIdsForPipelineOperation(operationId).flatMap((entry) => getProviderPipelineOperation(entry, operationId)?.inputKinds || []),
    );
  }

  if (node.type === 'llmPrompt' && port.id === 'referenceImage') {
    const executionMode = getModelStepExecutionMode(node);
    const operationId = getModelStepOperationId(node);
    if (executionMode === 'localTool' && operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
      return [PORT_KIND_IMAGE];
    }

    return [];
  }

  if (node.type === 'collectionMap' && port.id === 'collection') {
    return isSupportedCollectionMapOperation(node) ? [PORT_KIND_TEXT] : [];
  }
  if (node.type === 'validation' && port.id === 'input' && node.config?.mode === 'llm') {
    const executionMode = node?.config?.llmExecutionMode === 'ollama' ? 'ollama' : 'cloud';
    if (executionMode === 'ollama') {
      return uniqueKindList(getToolPipelineOperation('ollama', PIPELINE_OPERATION_IDS.VALIDATION_LLM)?.inputKinds || []);
    }

    const providerId = String(node?.config?.providerId || '').trim().toLowerCase();
    if (providerId) {
      return uniqueKindList(getProviderPipelineOperation(providerId, PIPELINE_OPERATION_IDS.VALIDATION_LLM)?.inputKinds || []);
    }

    return uniqueKindList(
      getProviderIdsForPipelineOperation(PIPELINE_OPERATION_IDS.VALIDATION_LLM)
        .flatMap((entry) => getProviderPipelineOperation(entry, PIPELINE_OPERATION_IDS.VALIDATION_LLM)?.inputKinds || []),
    );
  }

  return [];
}

function getPortAllowedKinds(port, options = {}) {
  if (!port || typeof port !== 'object') {
    return [];
  }

  const dynamicKinds = options?.direction === 'input'
    ? resolveDynamicInputKinds(options?.node || null, port)
    : [];
  const staticKinds = Array.isArray(port.allowedKinds) && port.allowedKinds.length
    ? [...new Set(port.allowedKinds.map((entry) => normalizePortKind(entry)).filter(Boolean))]
    : [];
  const baseKinds = port.dynamicOnly
    ? dynamicKinds
    : dynamicKinds.length
      ? uniqueKindList([...dynamicKinds, ...staticKinds])
      : staticKinds.length
        ? staticKinds
        : (() => {
            const kind = normalizePortKind(port.kind);
            if (kind === PORT_KIND_ANY) {
              return getSupportedPortKinds();
            }

            if (kind === PORT_KIND_PASSTHROUGH) {
              return [];
            }

            return kind ? [kind] : [];
          })();
  return applyCollectionBehaviorToKinds(baseKinds, port);
}

function doesPortAllowMultipleConnections(port) {
  return Boolean(port?.allowMultipleConnections);
}

function getIncomingEdgesForPortKey(graph, portKey) {
  if (!graph || !portKey) {
    return [];
  }

  const incomingEdges = graph.incomingEdgesByPortKey?.get?.(portKey);
  if (Array.isArray(incomingEdges)) {
    return incomingEdges.filter(Boolean);
  }

  const incomingEdge = graph.incomingEdgeByPortKey?.get?.(portKey);
  return incomingEdge ? [incomingEdge] : [];
}

function intersectKindLists(kindLists = []) {
  if (!kindLists.length) {
    return [];
  }

  let intersection = uniqueKindList(kindLists[0]);
  for (const kindList of kindLists.slice(1)) {
    const normalizedKinds = uniqueKindList(kindList);
    intersection = intersection.filter((kind) => normalizedKinds.includes(kind));
    if (!intersection.length) {
      break;
    }
  }

  return intersection;
}

function getIncomingKindsForPort(node, port, graph, visited = new Set()) {
  if (!node || !port || !graph) {
    return [];
  }

  const incomingEdges = getIncomingEdgesForPortKey(graph, `${node.id}:${port.id}`);
  if (!incomingEdges.length) {
    return [];
  }

  const incomingKindLists = incomingEdges
    .map((edge) => {
      const sourceNode = graph.nodeMap.get(edge.source.nodeId);
      const sourcePort = getPortDefinition(sourceNode, 'output', edge.source.portId);
      return resolveOutputKinds(sourceNode, sourcePort, graph, new Set(visited));
    })
    .filter((kindList) => kindList.length);

  if (!incomingKindLists.length) {
    return [];
  }

  const mergedKinds = doesPortAllowMultipleConnections(port)
    ? intersectKindLists(incomingKindLists)
    : uniqueKindList(incomingKindLists.flat());
  const allowedKinds = getPortAllowedKinds(port, { direction: 'input', node });
  return allowedKinds.length ? mergedKinds.filter((kind) => allowedKinds.includes(kind)) : mergedKinds;
}

function getPipelineOperationLabel(operationId) {
  return PIPELINE_OPERATION_LABELS[operationId] || 'Model output';
}

function getModelStepExecutionMode(node) {
  return node?.config?.executionMode === 'ollama'
    ? 'ollama'
    : node?.config?.executionMode === 'localTool'
      ? 'localTool'
      : 'cloud';
}

function getModelStepOperationId(node) {
  if (node?.type !== 'llmPrompt') {
    return PIPELINE_OPERATION_IDS.LLM_PROMPT;
  }

  const executionMode = getModelStepExecutionMode(node);
  if (executionMode === 'ollama') {
    return PIPELINE_OPERATION_IDS.LLM_PROMPT;
  }

  if (executionMode === 'localTool') {
    const requestedOperationId = String(node?.config?.operationId || '').trim();
    if (requestedOperationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) {
      return PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE;
    }

    if (requestedOperationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
      return PIPELINE_OPERATION_IDS.IMAGE_ANALYZE;
    }

    if (requestedOperationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
      return PIPELINE_OPERATION_IDS.VIDEO_GENERATE;
    }

    if (requestedOperationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
      return PIPELINE_OPERATION_IDS.AUDIO_GENERATE;
    }

    if (requestedOperationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
      return PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM;
    }

    if (requestedOperationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
      return PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM;
    }

    return PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
  }

  const requestedOperationId = String(node?.config?.operationId || '').trim();
  return MODEL_STEP_CLOUD_OPERATION_OPTIONS.some((entry) => entry.id === requestedOperationId)
    ? requestedOperationId
    : PIPELINE_OPERATION_IDS.LLM_PROMPT;
}

function getCollectionMapExecutionMode(node) {
  if (node?.config?.executionMode === 'localTool') {
    return 'localTool';
  }

  if (node?.config?.executionMode === 'graphWorkflow') {
    return 'graphWorkflow';
  }

  return 'cloud';
}

function getCollectionMapOperationId(node) {
  const requestedOperationId = String(node?.config?.operationId || '').trim();
  return requestedOperationId || PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
}

function isSupportedCollectionMapOperation(node) {
  return getCollectionMapOperationId(node) === PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
}
function getImageTransformSubtypeOptions(toolId = '') {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  const options = IMAGE_TRANSFORM_SUBTYPE_OPTIONS[normalizedToolId] || Object.values(IMAGE_TRANSFORM_SUBTYPE_OPTIONS).flat();
  const seen = new Set();
  return options
    .map((entry) => ({
      id: String(entry?.id || '').trim(),
      label: String(entry?.label || entry?.id || '').trim(),
    }))
    .filter((entry) => {
      if (!entry.id || seen.has(entry.id)) {
        return false;
      }

      seen.add(entry.id);
      return true;
    });
}

function getDefaultImageTransformSubtype(toolId = '') {
  return getImageTransformSubtypeOptions(toolId)[0]?.id || '';
}

function getImageTransformSubtypeLabel(subtype = '') {
  const normalizedSubtype = String(subtype || '').trim().toLowerCase();
  return getImageTransformSubtypeOptions()
    .find((entry) => entry.id === normalizedSubtype)?.label || normalizedSubtype.replace(/-/g, ' ');
}

function normalizeImageTransformSubtype(toolId = '', subtype = '') {
  const normalizedSubtype = String(subtype || '').trim().toLowerCase();
  const options = getImageTransformSubtypeOptions(toolId);
  if (normalizedSubtype && options.some((entry) => entry.id === normalizedSubtype)) {
    return normalizedSubtype;
  }

  return normalizedSubtype ? '' : getDefaultImageTransformSubtype(toolId);
}
function getOperationDrivenToolIdsForModelStepOperation(operationId) {
  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
    return VIDEO_WORKFLOW_TOOL_IDS;
  }

  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
    return AUDIO_WORKFLOW_TOOL_IDS;
  }

  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
    return AUDIO_TRANSFORM_TOOL_IDS;
  }

  if (operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE) {
    return ['whisper'];
  }

  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
    return IMAGE_TRANSFORM_TOOL_IDS;
  }

  return IMAGE_WORKFLOW_TOOL_IDS;
}

function getModelStepLocalToolId(node, contextMaps = {}) {
  const selectedToolId = String(node?.config?.toolId || '').trim();
  if (selectedToolId) {
    return selectedToolId;
  }

  const operationId = getModelStepOperationId(node);
  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE || operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE) {
    return selectLocalImageBackend(contextMaps, node, { operationId }).toolId || '';
  }

  return pickAvailableToolId(getOperationDrivenToolIdsForModelStepOperation(operationId), contextMaps);
}

function getGraphWorkflowToolId(node) {
  const selectedToolId = String(node?.config?.toolId || '').trim().toLowerCase();
  return selectedToolId || DEFAULT_GRAPH_WORKFLOW_TOOL_ID;
}


function doesToolExposeDownloadedModel(tool, model) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel) {
    return false;
  }

  if (tool?.id === 'automatic1111' || tool?.id === 'forge') {
    return Boolean(findStableDiffusionCheckpointMatch(getStableDiffusionCheckpointModels(tool?.downloadedModels || []), model));
  }

  if (tool?.id === 'rvc') {
    return Boolean(findRvcVoiceModelMatch(getRvcVoiceModels(tool?.downloadedModels || []), model));
  }

  return (Array.isArray(tool?.downloadedModels) ? tool.downloadedModels : []).some((entry) => {
    const candidates = [entry?.id, entry?.name, entry?.fileName, entry?.relativePath, entry?.path]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    return candidates.includes(normalizedModel);
  });
}

function getNodeTypeDefinition(type) {
  return PIPELINE_NODE_TYPES[type] || null;
}

function getDefaultNodeConfig(type) {
  const definition = getNodeTypeDefinition(type);
  return cloneValue(definition?.configDefaults || {});
}

function normalizeNodeConfig(type, config) {
  return {
    ...getDefaultNodeConfig(type),
    ...(config && typeof config === 'object' ? cloneValue(config) : {}),
  };
}

function createNode(type, overrides = {}) {
  const definition = getNodeTypeDefinition(type);
  if (!definition) {
    throw new Error('Local AI Hub could not create that pipeline node type.');
  }

  return {
    id: toNonEmptyString(overrides.id, createUniqueId(type)),
    type,
    label: toNonEmptyString(overrides.label, definition.label),
    position: {
      x: normalizeNumber(overrides.position?.x, DEFAULT_POSITION_X),
      y: normalizeNumber(overrides.position?.y, DEFAULT_POSITION_Y),
    },
    config: normalizeNodeConfig(type, overrides.config),
  };
}

function normalizeNode(node, index = 0) {
  const definition = getNodeTypeDefinition(node?.type);
  if (!definition) {
    return {
      id: toNonEmptyString(node?.id, createUniqueId('node')),
      type: toNonEmptyString(node?.type, 'unknown'),
      label: toNonEmptyString(node?.label, 'Unknown node'),
      position: {
        x: normalizeNumber(node?.position?.x, DEFAULT_POSITION_X + (index % 3) * 280),
        y: normalizeNumber(node?.position?.y, DEFAULT_POSITION_Y + Math.floor(index / 3) * 220),
      },
      config: cloneValue(node?.config && typeof node.config === 'object' ? node.config : {}),
    };
  }

  return createNode(node.type, {
    id: node?.id,
    label: node?.label,
    position: node?.position,
    config: node?.config,
  });
}

function createEdge(sourceNodeId, sourcePortId, targetNodeId, targetPortId, overrides = {}) {
  return {
    id: toNonEmptyString(overrides.id, createUniqueId('edge')),
    source: {
      nodeId: toNonEmptyString(sourceNodeId),
      portId: toNonEmptyString(sourcePortId),
    },
    target: {
      nodeId: toNonEmptyString(targetNodeId),
      portId: toNonEmptyString(targetPortId),
    },
  };
}

function normalizeEdge(edge) {
  return createEdge(edge?.source?.nodeId, edge?.source?.portId, edge?.target?.nodeId, edge?.target?.portId, {
    id: edge?.id,
  });
}

function createEmptyPipeline(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    id: toNonEmptyString(overrides.id, createUniqueId('pipeline')),
    name: toNonEmptyString(overrides.name, 'Untitled pipeline'),
    description: String(overrides.description || '').trim(),
    createdAt: normalizeTimestamp(overrides.createdAt || now),
    updatedAt: normalizeTimestamp(overrides.updatedAt || now),
    nodes: Array.isArray(overrides.nodes) ? overrides.nodes.map((node, index) => normalizeNode(node, index)) : [],
    edges: Array.isArray(overrides.edges) ? overrides.edges.map((edge) => normalizeEdge(edge)) : [],
  };
}

function normalizePipelineDefinition(definition = {}, options = {}) {
  const now = new Date().toISOString();
  const createdAt = options.keepCreatedAt && definition?.createdAt ? normalizeTimestamp(definition.createdAt) : normalizeTimestamp(definition?.createdAt || now);
  const updatedAt = options.keepUpdatedAt && definition?.updatedAt ? normalizeTimestamp(definition.updatedAt) : normalizeTimestamp(now);

  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    id: toNonEmptyString(definition?.id, createUniqueId('pipeline')),
    name: toNonEmptyString(definition?.name, 'Untitled pipeline'),
    description: String(definition?.description || '').trim(),
    createdAt,
    updatedAt,
    nodes: Array.isArray(definition?.nodes) ? definition.nodes.map((node, index) => normalizeNode(node, index)) : [],
    edges: Array.isArray(definition?.edges) ? definition.edges.map((edge) => normalizeEdge(edge)) : [],
  };
}

function isPipelineNodeLike(value) {
  return Boolean(value && typeof value === 'object' && typeof value.type === 'string');
}

function buildGraphWorkflowPortDefinition(spec) {
  const id = String(spec?.portId || '').trim();
  if (!id) {
    return null;
  }

  return {
    id,
    kind: spec.kind,
    label: spec.label || PIPELINE_PORT_KIND_LABELS[normalizePortKind(spec.kind)] || id,
  };
}

function getPipelineNodePorts(nodeOrType, direction) {
  const node = isPipelineNodeLike(nodeOrType) ? nodeOrType : null;
  const nodeType = node ? node.type : nodeOrType;
  const definition = getNodeTypeDefinition(nodeType);
  if (node?.type === 'graphWorkflow') {
    const contract = getGraphWorkflowContract(getGraphWorkflowToolId(node));
    const specs = direction === 'input' ? contract.inputPorts : contract.outputPorts;
    return (specs || []).map(buildGraphWorkflowPortDefinition).filter(Boolean);
  }

  const portList = direction === 'input' ? definition?.inputPorts : definition?.outputPorts;
  return portList || [];
}

function getPortDefinition(nodeOrType, direction, portId) {
  return getPipelineNodePorts(nodeOrType, direction).find((port) => port.id === portId) || null;
}
function resolveOutputKinds(sourceNode, sourcePort, graph, visited = new Set()) {
  if (!sourcePort) {
    return [];
  }

  const normalizedKind = normalizePortKind(sourcePort.kind);
  const explicitKinds = getPortAllowedKinds(sourcePort, { direction: 'output', node: sourceNode || null });
  if (normalizedKind && normalizedKind !== PORT_KIND_PASSTHROUGH && normalizedKind !== PORT_KIND_ANY) {
    return explicitKinds.length ? explicitKinds : [normalizedKind];
  }

  if (normalizedKind === PORT_KIND_ANY) {
    return explicitKinds.length ? explicitKinds : getSupportedPortKinds();
  }

  if (!sourceNode || !graph) {
    return [];
  }

  const visitKey = `${sourceNode.id}:${sourcePort.id}`;
  if (visited.has(visitKey)) {
    return [];
  }

  visited.add(visitKey);
  const passthroughPortId = sourcePort.passthroughFrom || 'input';
  const passthroughInputPort = getPortDefinition(sourceNode, 'input', passthroughPortId) || {
    id: passthroughPortId,
    kind: PORT_KIND_ANY,
  };
  return getIncomingKindsForPort(sourceNode, passthroughInputPort, graph, visited);
}

function doesKindIntersect(leftKinds = [], rightKinds = []) {
  return leftKinds.some((kind) => rightKinds.includes(kind));
}

function arePortsCompatible(source, target, options = {}) {
  const targetKinds = typeof target === 'string' ? getPortAllowedKinds({ kind: target }) : getPortAllowedKinds(target, { direction: 'input', node: options.targetNode || null });
  const sourceKinds =
    typeof source === 'string'
      ? getPortAllowedKinds({ kind: source })
      : resolveOutputKinds(options.sourceNode || null, source, options.graph);

  if (!targetKinds.length) {
    return false;
  }

  if (!sourceKinds.length) {
    if (normalizePortKind(source?.kind) !== PORT_KIND_PASSTHROUGH) {
      return false;
    }

    if (!options.sourceNode || !options.graph) {
      return true;
    }

    const passthroughPortId = source?.passthroughFrom || 'input';
    return getIncomingEdgesForPortKey(options.graph, `${options.sourceNode.id}:${passthroughPortId}`).length === 0;
  }

  return doesKindIntersect(sourceKinds, targetKinds);
}

function collectConnectedNodeIds(startNodeId, edgeMap, direction = 'target', allowedNodeIds = null) {
  const visited = new Set();
  const queue = [startNodeId];

  while (queue.length > 0) {
    const currentNodeId = queue.shift();
    if (!currentNodeId || visited.has(currentNodeId)) {
      continue;
    }

    if (allowedNodeIds instanceof Set && !allowedNodeIds.has(currentNodeId)) {
      continue;
    }

    visited.add(currentNodeId);
    for (const edge of edgeMap.get(currentNodeId) || []) {
      const nextNodeId = direction === 'source' ? edge.source.nodeId : edge.target.nodeId;
      if (!visited.has(nextNodeId)) {
        queue.push(nextNodeId);
      }
    }
  }

  return visited;
}

function getRetryLoopAttemptLimit(node) {
  return Number(node?.config?.maxAttempts || 0);
}

function getRetryLoopTerminationAction(node) {
  return String(node?.config?.retryTerminationAction || '').trim() === 'complete' ? 'complete' : 'fail';
}

function doesRetryLoopStopOnRepeatedArtifact(node) {
  return Boolean(node?.config?.stopWhenRetryArtifactRepeats);
}

function getRetryLoopReentryDescriptor(graph, retryTargetNode, retryKinds = []) {
  if (!graph || !retryTargetNode) {
    return {
      limitation: '',
      mode: 'none',
      portId: '',
      portLabel: '',
    };
  }

  if (retryTargetNode.type === 'branchMerge') {
    return {
      limitation: '',
      mode: 'branchMerge',
      portId: 'branch',
      portLabel: 'Branches',
    };
  }

  const definition = getNodeTypeDefinition(retryTargetNode.type);
  const inputPorts = Array.isArray(definition?.inputPorts) ? definition.inputPorts : [];
  const eligiblePorts = inputPorts.filter((port) => {
    if (!port || doesPortAllowMultipleConnections(port)) {
      return false;
    }

    const allowedKinds = getPortAllowedKinds(port, { direction: 'input', node: retryTargetNode });
    if (!allowedKinds.length || !doesKindIntersect(allowedKinds, retryKinds)) {
      return false;
    }

    return Boolean(port.required) || getIncomingEdgesForPortKey(graph, retryTargetNode.id + ':' + port.id).length > 0;
  });

  if (eligiblePorts.length === 1) {
    const selectedPort = eligiblePorts[0];
    return {
      limitation: '',
      mode: 'inputPort',
      portId: selectedPort.id,
      portLabel: selectedPort.label || selectedPort.id,
    };
  }

  if (eligiblePorts.length > 1) {
    return {
      limitation: 'Later attempts rerun from ' + retryTargetNode.label + ' using its connected inputs because the retry artifact matches more than one input on that step. Add a Branch Merge or target a step with one clear compatible input if you want automatic re-entry.',
      mode: 'none',
      portId: '',
      portLabel: '',
    };
  }

  return {
    limitation: 'Later attempts rerun from ' + retryTargetNode.label + ' using its connected inputs because this step does not have one clear compatible input for the retry artifact.',
    mode: 'none',
    portId: '',
    portLabel: '',
  };
}

function getRetryLoopAccumulatorCompleteSource(graph, loopNode) {
  if (!graph || !loopNode?.id) {
    return null;
  }

  const completeEdges = getIncomingEdgesForPortKey(graph, loopNode.id + ':complete');
  if (completeEdges.length !== 1) {
    return null;
  }

  const completeEdge = completeEdges[0];
  const sourceNode = graph.nodeMap.get(completeEdge.source.nodeId) || null;
  if (!sourceNode || sourceNode.type !== 'collectionAccumulator' || completeEdge.source.portId !== 'collection') {
    return null;
  }

  return {
    edge: completeEdge,
    sourceNode,
  };
}

function isRetryLoopAccumulatorCompleteCompatible(graph, loopNode, completeKinds = [], retryKinds = []) {
  const accumulatorSource = getRetryLoopAccumulatorCompleteSource(graph, loopNode);
  if (!accumulatorSource) {
    return false;
  }

  const accumulatorItemKinds = getIncomingKindsForNodePort(accumulatorSource.sourceNode, 'item', graph)
    .filter((kind) => !isCollectionPortKind(kind));
  if (!accumulatorItemKinds.length || !retryKinds.length || !doesKindIntersect(accumulatorItemKinds, retryKinds)) {
    return false;
  }

  return completeKinds.length > 0 && completeKinds.every((kind) => {
    if (!isCollectionPortKind(kind)) {
      return false;
    }

    return accumulatorItemKinds.includes(getCollectionItemKind(kind));
  });
}

function addRetryLoopIssue(graph, nodeId, message) {
  if (!graph?.retryLoopIssuesByNodeId?.has(nodeId)) {
    graph.retryLoopIssuesByNodeId.set(nodeId, []);
  }

  graph.retryLoopIssuesByNodeId.get(nodeId).push(message);
}

function appendRetryLoopNodeId(map, nodeId, loopNodeId) {
  if (!map || !nodeId || !loopNodeId) {
    return;
  }

  const existingLoopNodeIds = Array.isArray(map.get(nodeId)) ? map.get(nodeId) : [];
  if (!existingLoopNodeIds.includes(loopNodeId)) {
    map.set(nodeId, [...existingLoopNodeIds, loopNodeId]);
  }
}

function sortRetryLoopNodeIds(graph, loopNodeIds = []) {
  return [...new Set(Array.isArray(loopNodeIds) ? loopNodeIds.filter(Boolean) : [])].sort((leftLoopNodeId, rightLoopNodeId) => {
    const leftLoopMeta = graph?.retryLoopsByNodeId?.get(leftLoopNodeId) || null;
    const rightLoopMeta = graph?.retryLoopsByNodeId?.get(rightLoopNodeId) || null;
    const leftTargetIndex = Number(leftLoopMeta?.retryTargetIndex);
    const rightTargetIndex = Number(rightLoopMeta?.retryTargetIndex);
    if (leftTargetIndex !== rightTargetIndex) {
      return leftTargetIndex - rightTargetIndex;
    }

    const leftLoopIndex = Number(leftLoopMeta?.loopIndex);
    const rightLoopIndex = Number(rightLoopMeta?.loopIndex);
    if (leftLoopIndex !== rightLoopIndex) {
      return rightLoopIndex - leftLoopIndex;
    }

    return String(leftLoopNodeId).localeCompare(String(rightLoopNodeId));
  });
}

function populateRetryLoopMetadata(graph) {
  if (!graph) {
    return;
  }

  const retryLoopNodes = graph.executionOrder
    .map((nodeId) => graph.nodeMap.get(nodeId))
    .filter((node) => node?.type === 'retryLoop');

  for (const node of retryLoopNodes) {
    const completeEdges = graph.incomingEdgesByPortKey.get(node.id + ':complete') || [];
    const retryEdges = graph.incomingEdgesByPortKey.get(node.id + ':retry') || [];
    if (!completeEdges.length || !retryEdges.length) {
      addRetryLoopIssue(graph, node.id, 'Connect both the Complete and Retry inputs before running this loop.');
    }

    const maxAttempts = getRetryLoopAttemptLimit(node);
    if (!Number.isInteger(maxAttempts)) {
      addRetryLoopIssue(graph, node.id, 'Enter a whole number for the loop attempt limit.');
    } else if (maxAttempts < 2) {
      addRetryLoopIssue(graph, node.id, 'Set this loop to at least 2 attempts so it can actually retry.');
    } else if (maxAttempts > PIPELINE_RETRY_LOOP_MAX_ATTEMPTS) {
      addRetryLoopIssue(graph, node.id, 'This control-flow model allows up to ' + PIPELINE_RETRY_LOOP_MAX_ATTEMPTS + ' attempts so runs stay bounded and understandable.');
    }

    const retryTargetNodeId = String(node.config?.retryTargetNodeId || '').trim();
    if (!retryTargetNodeId) {
      addRetryLoopIssue(graph, node.id, 'Choose which earlier step should rerun when this loop takes the Retry branch.');
    }

    const retryTargetNode = retryTargetNodeId ? graph.nodeMap.get(retryTargetNodeId) || null : null;
    if (retryTargetNodeId && !retryTargetNode) {
      addRetryLoopIssue(graph, node.id, 'The selected retry target no longer exists in this pipeline.');
    }

    const loopIndex = Number(graph.executionIndexByNodeId.get(node.id));
    const targetIndex = retryTargetNode ? Number(graph.executionIndexByNodeId.get(retryTargetNode.id)) : -1;
    if (retryTargetNode) {
      if (!graph.reachableNodeIds.has(retryTargetNode.id)) {
        addRetryLoopIssue(graph, node.id, 'Choose a retry target that still leads to an output in this pipeline.');
      } else if (!Number.isFinite(targetIndex) || !Number.isFinite(loopIndex) || targetIndex >= loopIndex) {
        addRetryLoopIssue(graph, node.id, 'Choose an earlier step for this retry loop. The retry target must stay upstream of the Retry Loop node.');
      }
    }

    if ((graph.retryLoopIssuesByNodeId.get(node.id) || []).length) {
      continue;
    }

    const nodesReachableFromTarget = collectConnectedNodeIds(retryTargetNode.id, graph.outgoingEdgesByNode, 'target', graph.reachableNodeIds);
    const nodesThatReachLoop = collectConnectedNodeIds(node.id, graph.incomingEdgesByNode, 'source', graph.reachableNodeIds);
    const segmentNodeIds = new Set([...nodesReachableFromTarget].filter((nodeId) => nodesThatReachLoop.has(nodeId)));
    segmentNodeIds.add(node.id);

    if (!segmentNodeIds.has(retryTargetNode.id)) {
      addRetryLoopIssue(graph, node.id, 'Connect the selected retry target forward into this Retry Loop node before running it.');
      continue;
    }

    if ([...completeEdges, ...retryEdges].some((edge) => !segmentNodeIds.has(edge.source.nodeId))) {
      addRetryLoopIssue(graph, node.id, 'Feed both loop branches from the steps between the retry target and this Retry Loop node.');
    }

    const completePort = getPortDefinition(node.type, 'input', 'complete');
    const retryPort = getPortDefinition(node.type, 'input', 'retry');
    const completeKinds = getIncomingKindsForPort(node, completePort, graph);
    const retryKinds = getIncomingKindsForPort(node, retryPort, graph);
    const retryEntry = getRetryLoopReentryDescriptor(graph, retryTargetNode, retryKinds);
    const accumulatorCompleteCompatible = Boolean(getRetryLoopAccumulatorCompleteSource(graph, node));
    if (completeKinds.length && retryKinds.length && !doesKindIntersect(completeKinds, retryKinds) && !accumulatorCompleteCompatible) {
      addRetryLoopIssue(graph, node.id, 'The Complete and Retry branches must stay on the same artifact type so retries remain deterministic.');
    }

    let loopLeakDetected = false;
    for (const segmentNodeId of segmentNodeIds) {
      if (segmentNodeId === node.id) {
        continue;
      }

      for (const edge of graph.outgoingEdgesByNode.get(segmentNodeId) || []) {
        if (!graph.reachableNodeIds.has(edge.target.nodeId)) {
          continue;
        }

        if (edge.target.nodeId === node.id) {
          continue;
        }

        if (!segmentNodeIds.has(edge.target.nodeId)) {
          loopLeakDetected = true;
          break;
        }
      }

      if (loopLeakDetected) {
        break;
      }
    }

    if (loopLeakDetected) {
      addRetryLoopIssue(graph, node.id, 'Keep every step in this retry span inside the loop until it reaches the Retry Loop node. Move outside outputs and side branches after the loop result.');
    }

    if (retryTargetNode.type === 'branchMerge') {
      const branchPort = getPortDefinition(retryTargetNode.type, 'input', 'branch');
      const branchEdges = graph.incomingEdgesByPortKey.get(retryTargetNode.id + ':branch') || [];
      const explicitBranchKinds = branchPort ? getIncomingKindsForPort(retryTargetNode, branchPort, graph) : [];
      if (!branchEdges.length) {
        addRetryLoopIssue(graph, node.id, 'Connect at least one upstream branch into the retry target merge so the first attempt has content to run.');
      } else if (explicitBranchKinds.length && retryKinds.length && !doesKindIntersect(explicitBranchKinds, retryKinds)) {
        addRetryLoopIssue(graph, node.id, 'The retry target merge must accept the same artifact type that the Retry branch carries back into the loop.');
      }
    }

    if ((graph.retryLoopIssuesByNodeId.get(node.id) || []).length) {
      continue;
    }

    const segmentExecutionOrder = graph.executionOrder.filter((nodeId) => segmentNodeIds.has(nodeId));
    const loopMetadata = {
      completeKinds,
      loopIndex,
      loopLabel: node.label,
      loopNodeId: node.id,
      maxAttempts,
      retryEntryLimitation: retryEntry.limitation,
      retryEntryMode: retryEntry.mode,
      retryEntryPortId: retryEntry.portId,
      retryEntryPortLabel: retryEntry.portLabel,
      retryKinds,
      retryTargetIndex: targetIndex,
      retryTargetLabel: retryTargetNode.label,
      retryTargetNodeId: retryTargetNode.id,
      segmentExecutionOrder,
      segmentNodeIds: [...segmentNodeIds],
      stopWhenRetryArtifactRepeats: doesRetryLoopStopOnRepeatedArtifact(node),
      terminationAction: getRetryLoopTerminationAction(node),
    };

    graph.retryLoopsByNodeId.set(node.id, loopMetadata);
    appendRetryLoopNodeId(graph.retryLoopNodeIdsByTargetNodeId, retryTargetNode.id, node.id);
    for (const segmentNodeId of segmentExecutionOrder) {
      appendRetryLoopNodeId(graph.retryLoopNodeIdsBySegmentNodeId, segmentNodeId, node.id);
    }
  }

  for (const [segmentNodeId, loopNodeIds] of graph.retryLoopNodeIdsBySegmentNodeId.entries()) {
    graph.retryLoopNodeIdsBySegmentNodeId.set(segmentNodeId, sortRetryLoopNodeIds(graph, loopNodeIds));
  }

  for (const [targetNodeId, loopNodeIds] of graph.retryLoopNodeIdsByTargetNodeId.entries()) {
    graph.retryLoopNodeIdsByTargetNodeId.set(targetNodeId, sortRetryLoopNodeIds(graph, loopNodeIds));
  }
}

function getRetryLoopEntryMetadataList(graph, nodeId) {
  if (!graph?.retryLoopsByNodeId || !nodeId) {
    return [];
  }

  const loopNodeIds = Array.isArray(graph.retryLoopNodeIdsByTargetNodeId?.get(nodeId))
    ? graph.retryLoopNodeIdsByTargetNodeId.get(nodeId)
    : [];
  return loopNodeIds
    .map((loopNodeId) => graph.retryLoopsByNodeId.get(loopNodeId) || null)
    .filter(Boolean);
}

function getRetryLoopEntryMetadata(graph, nodeId) {
  return getRetryLoopEntryMetadataList(graph, nodeId)[0] || null;
}

function buildRetryLoopReadinessMessage(node, loopMeta) {
  const targetLabel = loopMeta?.retryTargetLabel || 'the selected retry target';
  const baseMessage = 'This loop reruns from ' + targetLabel + ' until the Complete branch truly wins or attempt ' + loopMeta.maxAttempts + ' is reached.';
  const reentryMessage = loopMeta?.retryEntryMode === 'branchMerge'
    ? ' Later attempts feed the retry artifact back through ' + targetLabel + '.'
    : loopMeta?.retryEntryMode === 'inputPort'
      ? ' Later attempts feed the retry artifact back into ' + targetLabel + ' through ' + (loopMeta.retryEntryPortLabel || loopMeta.retryEntryPortId || 'its selected input') + '.'
      : loopMeta?.retryEntryLimitation
        ? ' ' + loopMeta.retryEntryLimitation
        : '';
  const terminationMessage = getRetryLoopTerminationAction(node) === 'complete'
    ? ' If the Retry branch is still active when a stop rule triggers, Local AI Hub exits the loop and keeps the latest retry artifact.'
    : ' If the Retry branch is still active when a stop rule triggers, Local AI Hub stops the run with a plain-English error.';
  const repeatedArtifactMessage = doesRetryLoopStopOnRepeatedArtifact(node)
    ? ' It also stops early if the Retry branch produces the same artifact on consecutive attempts.'
    : '';
  return baseMessage + reentryMessage + terminationMessage + repeatedArtifactMessage;
}

function getCollectionAccumulatorTargetCount(node) {
  return Number(node?.config?.targetCount || 0);
}

function addCollectionAccumulatorIssue(graph, nodeId, message) {
  if (!graph?.collectionAccumulatorIssuesByNodeId?.has(nodeId)) {
    graph.collectionAccumulatorIssuesByNodeId.set(nodeId, []);
  }

  graph.collectionAccumulatorIssuesByNodeId.get(nodeId).push(message);
}

function populateCollectionAccumulatorMetadata(graph) {
  if (!graph) {
    return;
  }

  const accumulatorNodes = graph.executionOrder
    .map((nodeId) => graph.nodeMap.get(nodeId))
    .filter((node) => node?.type === 'collectionAccumulator');

  for (const node of accumulatorNodes) {
    const itemEdges = getIncomingEdgesForPortKey(graph, node.id + ':item') || [];
    if (!itemEdges.length) {
      addCollectionAccumulatorIssue(graph, node.id, 'Connect one or more accepted items into this step before running it.');
    }

    const targetCount = getCollectionAccumulatorTargetCount(node);
    if (!Number.isInteger(targetCount) || targetCount < 1) {
      addCollectionAccumulatorIssue(graph, node.id, 'Enter a whole target count of at least 1 for this accumulation step.');
    }

    const itemKinds = getIncomingKindsForNodePort(node, 'item', graph)
      .filter((kind) => !isCollectionPortKind(kind));
    if (!itemKinds.length) {
      addCollectionAccumulatorIssue(graph, node.id, 'Connect one or more same-type single artifacts into this accumulation step.');
    }

    const collectionEdges = (graph.outgoingEdgesByNode.get(node.id) || [])
      .filter((edge) => edge.source.portId === 'collection');
    const completeLoopEdges = collectionEdges.filter((edge) => {
      const targetNode = graph.nodeMap.get(edge.target.nodeId) || null;
      return targetNode?.type === 'retryLoop' && edge.target.portId === 'complete';
    });
    if (collectionEdges.length !== 1 || completeLoopEdges.length !== 1) {
      addCollectionAccumulatorIssue(graph, node.id, 'Connect the Collection output directly to one Retry Loop Complete input so this step can keep collecting until the target is reached.');
      continue;
    }

    const loopNode = graph.nodeMap.get(completeLoopEdges[0].target.nodeId) || null;
    const loopMeta = loopNode ? graph.retryLoopsByNodeId.get(loopNode.id) || null : null;
    if (!loopNode || !loopMeta) {
      addCollectionAccumulatorIssue(graph, node.id, 'Fix the connected Retry Loop before running this accumulation step.');
      continue;
    }

    if (itemKinds.length && loopMeta.retryKinds?.length && !doesKindIntersect(itemKinds, loopMeta.retryKinds)) {
      addCollectionAccumulatorIssue(graph, node.id, 'This accumulation step must collect the same item type that the connected Retry Loop keeps retrying.');
    }

    if ((graph.collectionAccumulatorIssuesByNodeId.get(node.id) || []).length) {
      continue;
    }

    graph.collectionAccumulatorsByNodeId.set(node.id, {
      itemKinds,
      loopLabel: loopNode.label,
      loopNodeId: loopNode.id,
      retryTargetLabel: loopMeta.retryTargetLabel,
      retryTargetNodeId: loopMeta.retryTargetNodeId,
      targetCount,
    });
  }
}

function buildCollectionAccumulatorReadinessMessage(node, meta) {
  const targetCount = Number(meta?.targetCount || getCollectionAccumulatorTargetCount(node) || 1) || 1;
  const itemLabel = formatPortKindList(meta?.itemKinds || []);
  const loopLabel = meta?.loopLabel || 'the connected Retry Loop';
  return 'This step keeps accepted ' + itemLabel + ' items from one or more upstream branches in order until it reaches ' + targetCount + ', then emits one ordered collection into ' + loopLabel + '. While it is still collecting, the connected loop keeps retrying without treating the stored collection state as a finished loop exit.';
}

function compareIssueSeverity(leftTone = 'neutral', rightTone = 'neutral') {
  const priority = {
    neutral: 0,
    good: 0,
    info: 1,
    warn: 2,
    danger: 3,
    error: 4,
  };

  return (priority[leftTone] || 0) - (priority[rightTone] || 0);
}

function evaluateCompatibilityProfile(profile, hardware) {
  if (!profile || !hardware) {
    return {
      label: 'Hardware unknown',
      tone: 'neutral',
      message: 'Local AI Hub has not finished reading this machine yet.',
    };
  }

  const vramMb = Number(hardware.vramMb || 0);
  const ramMb = Number(hardware.systemRamMb || 0);
  const minimumVramMb = Number(profile.minimumVramMb || 0);
  const recommendedVramMb = Number(profile.recommendedVramMb || minimumVramMb);
  const minimumRamMb = Number(profile.minimumRamMb || 0);
  const recommendedRamMb = Number(profile.recommendedRamMb || minimumRamMb);

  if (vramMb >= recommendedVramMb && ramMb >= recommendedRamMb) {
    return {
      label: 'Recommended',
      tone: 'good',
      message: 'This machine has enough GPU and RAM headroom for normal use.',
    };
  }

  if (vramMb >= minimumVramMb && ramMb >= minimumRamMb) {
    return {
      label: minimumVramMb >= 6144 ? 'Low VRAM mode' : 'Supported',
      tone: 'info',
      message:
        recommendedVramMb >= 16384
          ? 'This workload can run here, but it is aimed at higher-VRAM GPUs and will need conservative settings.'
          : 'This workload should run, but expect smaller batches or lighter models.',
    };
  }

  if (vramMb >= minimumVramMb || ramMb >= minimumRamMb) {
    return {
      label: 'Limited',
      tone: 'warn',
      message:
        recommendedVramMb >= 16384
          ? 'This workload is best on a higher-VRAM GPU and may be heavily constrained on this machine.'
          : 'This workload may still run, but it will need conservative settings.',
    };
  }

  return {
    label: 'Below spec',
    tone: 'danger',
    message: 'This machine is below the normal target range for that local workload.',
  };
}

function buildContextMaps(context = {}) {
  const tools = Array.isArray(context.tools)
    ? context.tools
    : context.toolsById && typeof context.toolsById === 'object'
      ? Object.values(context.toolsById)
      : [];
  const providers = Array.isArray(context.providers)
    ? context.providers
    : context.providersById && typeof context.providersById === 'object'
      ? Object.values(context.providersById)
      : [];
  const toolCatalog = Array.isArray(context.toolCatalog)
    ? context.toolCatalog
    : context.toolCatalogById && typeof context.toolCatalogById === 'object'
      ? Object.values(context.toolCatalogById)
      : [];

  return {
    hardware: context.hardware || null,
    toolsById: Object.fromEntries(tools.map((tool) => [tool.id, tool])),
    providersById: Object.fromEntries(providers.map((provider) => [provider.id, provider])),
    toolCatalogById: Object.fromEntries(toolCatalog.map((tool) => [tool.id, tool])),
  };
}

function uniqueKindList(values = []) {
  return [...new Set((values || []).map((entry) => normalizePortKind(entry)).filter(Boolean))];
}

function formatPortKindList(kinds = []) {
  const labels = uniqueKindList(kinds).map((kind) => formatPortKindLabel(kind));
  if (!labels.length) {
    return 'nothing yet';
  }

  if (labels.length === 1) {
    return labels[0];
  }

  if (labels.length === 2) {
    return labels[0] + ' or ' + labels[1];
  }

  return labels.slice(0, -1).join(', ') + ', or ' + labels[labels.length - 1];
}

function formatValidationReviewKinds(directKinds = [], derivedKinds = []) {
  const direct = uniqueKindList(directKinds);
  const derived = uniqueKindList(derivedKinds).filter((kind) => !direct.includes(kind));
  const segments = [];

  if (direct.length) {
    segments.push(formatPortKindList(direct) + ' directly');
  }

  if (derived.length) {
    segments.push(formatPortKindList(derived) + ' through extracted evidence');
  }

  if (!segments.length) {
    return 'nothing yet';
  }

  return segments.length === 2 ? segments[0] + ' and ' + segments[1] : segments[0];
}

function getValidationConnectedKinds(connectedKinds = []) {
  const normalizedKinds = uniqueKindList(connectedKinds);
  const collectionKinds = normalizedKinds.filter((kind) => isCollectionPortKind(kind));
  const itemKinds = uniqueKindList(collectionKinds.map((kind) => getCollectionItemKind(kind)).filter(Boolean));
  return {
    collectionKinds,
    itemKinds,
    normalizedKinds,
    resolvedKinds: uniqueKindList([...normalizedKinds, ...itemKinds]),
  };
}

function doesValidationCapabilityAcceptKind(capabilitySummary, kind) {
  const normalizedKind = normalizePortKind(kind);
  if (!normalizedKind || !capabilitySummary) {
    return false;
  }

  const supportedKinds = uniqueKindList(capabilitySummary.inputKinds || []);
  if (supportedKinds.includes(normalizedKind)) {
    return true;
  }

  const itemKind = getCollectionItemKind(normalizedKind);
  return Boolean(itemKind) && supportedKinds.includes(itemKind);
}

function getValidationKindMode(capabilitySummary, kind) {
  const normalizedKind = normalizePortKind(kind);
  if (!normalizedKind || !capabilitySummary) {
    return '';
  }

  const directKinds = uniqueKindList(
    capabilitySummary.directInputKinds && capabilitySummary.directInputKinds.length
      ? capabilitySummary.directInputKinds
      : capabilitySummary.inputKinds,
  );
  if (directKinds.includes(normalizedKind)) {
    return 'direct';
  }

  const derivedKinds = uniqueKindList(capabilitySummary.derivedInputKinds || []);
  return derivedKinds.includes(normalizedKind) ? 'derived' : '';
}

function getValidationReadyMessage(targetLabel, capabilitySummary, connectedKinds = []) {
  const { collectionKinds, resolvedKinds } = getValidationConnectedKinds(connectedKinds);
  if (collectionKinds.length) {
    const collectionLabel = collectionKinds.length === 1
      ? formatPortKindLabel(collectionKinds[0]).toLowerCase()
      : 'collection input';
    return targetLabel + ' will review the connected ' + collectionLabel + ' as a whole and return a pass or fail decision.';
  }

  if (resolvedKinds.includes(PORT_KIND_VIDEO)) {
    return targetLabel + ' will review the connected video and return a pass or fail decision.';
  }

  if (resolvedKinds.includes(PORT_KIND_PLAN)) {
    return targetLabel + ' will review the structured plan and return a pass or fail decision.';
  }

  if (resolvedKinds.includes(PORT_KIND_FILE)) {
    const mode = getValidationKindMode(capabilitySummary, PORT_KIND_FILE);
    if (mode === 'direct') {
      return targetLabel + ' will review the connected file and return a pass or fail decision.';
    }

    if (mode === 'derived') {
      return targetLabel + ' will review extracted document text and metadata from the connected file and return a pass or fail decision.';
    }
  }

  if (resolvedKinds.includes(PORT_KIND_IMAGE)) {
    return targetLabel + ' can review the connected image and return a pass or fail decision.';
  }

  return targetLabel + ' will review this validation input and return a pass or fail decision.';
}

function getContextToolEntry(toolId, contextMaps = {}) {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  if (!normalizedToolId) {
    return null;
  }

  return contextMaps.toolsById?.[normalizedToolId] || contextMaps.toolCatalogById?.[normalizedToolId] || null;
}

function getContextProviderEntry(providerId, contextMaps = {}) {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  if (!normalizedProviderId) {
    return null;
  }

  return contextMaps.providersById?.[normalizedProviderId] || null;
}

function getContextToolOperation(toolId, operationId, contextMaps = {}) {
  return getContextToolEntry(toolId, contextMaps)?.pipelineCapabilities?.operations?.[operationId] || getToolPipelineOperation(toolId, operationId);
}

function getContextProviderOperation(providerId, operationId, contextMaps = {}) {
  return getContextProviderEntry(providerId, contextMaps)?.pipelineCapabilities?.operations?.[operationId] || getProviderPipelineOperation(providerId, operationId);
}

function mergeCapabilityOperations(operations = []) {
  const usableOperations = (operations || []).filter(Boolean);
  if (!usableOperations.length) {
    return null;
  }

  return {
    inputKinds: uniqueKindList(usableOperations.flatMap((operation) => operation.inputKinds || [])),
    notes: usableOperations.map((operation) => String(operation.notes || '').trim()).find(Boolean) || '',
    operationSubtypes: uniqueKindList(usableOperations.flatMap((operation) => operation.operationSubtypes || [])),
    outputKinds: uniqueKindList(usableOperations.flatMap((operation) => operation.outputKinds || [])),
    transformSubtypes: uniqueKindList(usableOperations.flatMap((operation) => operation.transformSubtypes || [])),
  };
}

function getIncomingKindsForNodePort(node, portId, graph) {
  if (!node || !graph) {
    return [];
  }

  const port = getPortDefinition(node, 'input', portId);
  return getIncomingKindsForPort(node, port, graph);
}

function doesModelLikelySupportImages(targetKind, targetId, model) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel) {
    return false;
  }

  if (targetKind === 'tool' && targetId === 'ollama') {
    return /(vision|llava|bakllava|moondream|qwen2(\.5)?-?vl|minicpm-v|llama[- ]?3\.2[- ]?vision|internvl)/i.test(normalizedModel);
  }

  if (targetKind !== 'provider') {
    return false;
  }

  if (targetId === 'openai') {
    return /(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|\bo1\b|\bo3\b)/i.test(normalizedModel);
  }

  if (targetId === 'anthropic') {
    return /claude-(3|4)/i.test(normalizedModel);
  }

  if (targetId === 'google') {
    return /gemini/i.test(normalizedModel);
  }

  return false;
}

function resolveToolBackedNodeCapability(node, contextMaps = {}) {
  if (!node) {
    return null;
  }

  if (node.type === 'collectionMap') {
    const operationId = getCollectionMapOperationId(node);
    if (!isSupportedCollectionMapOperation(node)) {
      return {
        capability: null,
        operationId,
        targetId: '',
        targetKind: 'collection-map',
        targetLabel: 'Map Collection',
      };
    }

    if (getCollectionMapExecutionMode(node) === 'graphWorkflow') {
      const support = getGraphWorkflowOperationBackendSupport(node, GRAPH_WORKFLOW_OPERATION_BACKEND_IDS.TEXT_TO_IMAGE);
      const tool = support.toolId ? getContextToolEntry(support.toolId, contextMaps) : null;
      return {
        capability: support.usable
          ? {
              inputKinds: [PORT_KIND_TEXT],
              notes: support.message,
              outputKinds: [PORT_KIND_IMAGE],
            }
          : null,
        operationId,
        targetId: support.toolId || '',
        targetKind: 'tool',
        targetLabel: tool?.name || support.contract?.toolId || 'Graph workflow',
      };
    }

    if (getCollectionMapExecutionMode(node) === 'localTool') {
      const effectiveToolId = getImageToolIdForNode(node, contextMaps);
      const toolIds = effectiveToolId ? [effectiveToolId] : IMAGE_WORKFLOW_TOOL_IDS;
      const tool = effectiveToolId ? getContextToolEntry(effectiveToolId, contextMaps) : null;
      return {
        capability: mergeCapabilityOperations(toolIds.map((toolId) => getContextToolOperation(toolId, operationId, contextMaps))),
        operationId,
        targetId: effectiveToolId || '',
        targetKind: 'tool',
        targetLabel: tool?.name || 'Automatic1111 or Forge',
      };
    }

    const providerId = String(node?.config?.providerId || '').trim().toLowerCase();
    if (providerId) {
      const provider = getContextProviderEntry(providerId, contextMaps);
      return {
        capability: getContextProviderOperation(providerId, operationId, contextMaps),
        operationId,
        targetId: providerId,
        targetKind: 'provider',
        targetLabel: provider?.name || 'Cloud provider',
      };
    }

    return {
      capability: mergeCapabilityOperations(
        getProviderIdsForPipelineOperation(operationId).map((entry) => getContextProviderOperation(entry, operationId, contextMaps)),
      ),
      operationId,
      targetId: '',
      targetKind: 'provider',
      targetLabel: 'Cloud provider',
    };
  }
  if (node.type === 'graphWorkflow') {
    const toolId = getGraphWorkflowToolId(node);
    const tool = getContextToolEntry(toolId, contextMaps);
    const contract = getGraphWorkflowContract(toolId);
    return {
      capability: contract.supportsExecution
        ? {
            inputKinds: (contract.inputPorts || []).map((entry) => entry.kind),
            notes: contract.notes,
            outputKinds: (contract.outputPorts || []).map((entry) => entry.kind),
          }
        : null,
      operationId: PIPELINE_OPERATION_IDS.GRAPH_WORKFLOW,
      targetId: toolId,
      targetKind: 'tool',
      targetLabel: tool?.name || (toolId ? toolId : 'Graph workflow tool'),
    };
  }

  return null;
}

function resolveLlmNodeCapability(node, contextMaps = {}) {
  const executionMode = getModelStepExecutionMode(node);
  const operationId = getModelStepOperationId(node);
  if (executionMode === 'ollama') {
    const tool = getContextToolEntry('ollama', contextMaps);
    return {
      capability: getContextToolOperation('ollama', PIPELINE_OPERATION_IDS.LLM_PROMPT, contextMaps),
      operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT,
      targetId: 'ollama',
      targetKind: 'tool',
      targetLabel: tool?.name || 'Ollama',
    };
  }

  if (executionMode === 'localTool') {
    const selectedToolId = String(node?.config?.toolId || '').trim();
    const supportedToolIds = getOperationDrivenToolIdsForModelStepOperation(operationId);
    const effectiveToolId = selectedToolId && supportedToolIds.includes(selectedToolId)
      ? selectedToolId
      : getModelStepLocalToolId(node, contextMaps);
    const toolIds = effectiveToolId ? [effectiveToolId] : supportedToolIds;
    const tool = effectiveToolId ? getContextToolEntry(effectiveToolId, contextMaps) : null;
    const fallbackLabel = operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
      ? 'Wan2.1 WebUI'
      : operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
        ? 'AudioCraft WebUI'
        : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
          ? 'RVC'
          : operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
            ? 'Upscayl or FaceFusion'
            : 'Automatic1111 or Forge';
    return {
      capability: mergeCapabilityOperations(toolIds.map((toolId) => getContextToolOperation(toolId, operationId, contextMaps))),
      operationId,
      targetId: effectiveToolId || '',
      targetKind: 'tool',
      targetLabel: tool?.name || fallbackLabel,
    };
  }
const providerId = String(node?.config?.providerId || '').trim().toLowerCase();
  if (providerId) {
    const provider = getContextProviderEntry(providerId, contextMaps);
    return {
      capability: getContextProviderOperation(providerId, operationId, contextMaps),
      operationId,
      targetId: providerId,
      targetKind: 'provider',
      targetLabel: provider?.name || 'Cloud provider',
    };
  }

  return {
    capability: mergeCapabilityOperations(
      getProviderIdsForPipelineOperation(operationId).map((entry) => getContextProviderOperation(entry, operationId, contextMaps)),
    ),
    operationId,
    targetId: '',
    targetKind: 'provider',
    targetLabel: 'Cloud provider',
  };
}

function resolveValidationNodeCapability(node, contextMaps = {}) {
  if (node?.config?.mode !== 'llm') {
    return null;
  }

  const executionMode = node?.config?.llmExecutionMode === 'ollama' ? 'ollama' : 'cloud';
  if (executionMode === 'ollama') {
    const tool = getContextToolEntry('ollama', contextMaps);
    return {
      capability: getContextToolOperation('ollama', PIPELINE_OPERATION_IDS.VALIDATION_LLM, contextMaps),
      operationId: PIPELINE_OPERATION_IDS.VALIDATION_LLM,
      targetId: 'ollama',
      targetKind: 'tool',
      targetLabel: tool?.name || 'Ollama',
    };
  }

  const providerId = String(node?.config?.providerId || '').trim().toLowerCase();
  if (providerId) {
    const provider = getContextProviderEntry(providerId, contextMaps);
    return {
      capability: getContextProviderOperation(providerId, PIPELINE_OPERATION_IDS.VALIDATION_LLM, contextMaps),
      operationId: PIPELINE_OPERATION_IDS.VALIDATION_LLM,
      targetId: providerId,
      targetKind: 'provider',
      targetLabel: provider?.name || 'Cloud provider',
    };
  }

  return {
    capability: mergeCapabilityOperations(
      getProviderIdsForPipelineOperation(PIPELINE_OPERATION_IDS.VALIDATION_LLM).map((entry) => getContextProviderOperation(entry, PIPELINE_OPERATION_IDS.VALIDATION_LLM, contextMaps)),
    ),
    operationId: PIPELINE_OPERATION_IDS.VALIDATION_LLM,
    targetId: '',
    targetKind: 'provider',
    targetLabel: 'Cloud provider',
  };
}

function resolveNodeCapability(node, contextMaps = {}) {
  if (!node) {
    return null;
  }

  if (node.type === 'llmPrompt') {
    return resolveLlmNodeCapability(node, contextMaps);
  }

  if (node.type === 'validation') {
    return resolveValidationNodeCapability(node, contextMaps);
  }

  return resolveToolBackedNodeCapability(node, contextMaps);
}

function buildNodeCapabilitySummary(node, contextMaps = {}) {
  const resolved = resolveNodeCapability(node, contextMaps);
  if (!resolved) {
    return null;
  }

  const capability = resolved.capability || null;
  if (!capability) {
    return {
      derivedInputKinds: [],
      directInputKinds: [],
      inputKinds: [],
      message: resolved.targetLabel + ' does not support ' + getPipelineOperationLabel(resolved.operationId).toLowerCase() + ' for this step yet.',
      notes: '',
      operationId: resolved.operationId,
      operationLabel: getPipelineOperationLabel(resolved.operationId),
      outputKinds: [],
      supported: false,
      targetId: resolved.targetId,
      targetKind: resolved.targetKind,
      targetLabel: resolved.targetLabel,
    };
  }

  const inputKinds = uniqueKindList(capability.inputKinds);
  const directInputKinds = uniqueKindList(capability.directInputKinds && capability.directInputKinds.length ? capability.directInputKinds : inputKinds);
  const derivedInputKinds = uniqueKindList(capability.derivedInputKinds || []);
  const outputKinds = uniqueKindList(capability.outputKinds);
  const operationSubtypes = uniqueKindList(capability.operationSubtypes || []);
  const transformSubtypes = uniqueKindList(capability.transformSubtypes || []);
  const notes = String(capability.notes || '').trim();
  const collectionSupportNote = resolved.operationId === PIPELINE_OPERATION_IDS.VALIDATION_LLM
    && inputKinds.some((kind) => COLLECTION_ITEM_PORT_KINDS.includes(kind))
      ? ' Same-type collections are also reviewed as whole collections in this step.'
      : '';
  const message = resolved.operationId === PIPELINE_OPERATION_IDS.VALIDATION_LLM
    ? resolved.targetLabel + ' can review ' + formatValidationReviewKinds(directInputKinds, derivedInputKinds) + ' in this validation step.' + collectionSupportNote + (notes ? ' ' + notes : '')
    : resolved.targetLabel + ' supports ' + formatPortKindList(inputKinds) + ' to ' + formatPortKindList(outputKinds) + ' for this step.' + (notes ? ' ' + notes : '');
  return {
    derivedInputKinds,
    directInputKinds,
    inputKinds,
    message,
    notes,
    operationId: resolved.operationId,
    operationLabel: getPipelineOperationLabel(resolved.operationId),
    operationSubtypes,
    outputKinds,
    transformSubtypes,
    supported: true,
    targetId: resolved.targetId,
    targetKind: resolved.targetKind,
    targetLabel: resolved.targetLabel,
  };
}

function getOllamaModelCapabilityEntry(model, contextMaps = {}) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel) {
    return null;
  }

  const lookup = getContextToolEntry('ollama', contextMaps)?.modelCapabilitiesByName;
  if (!lookup || typeof lookup !== 'object') {
    return null;
  }

  return lookup[normalizedModel] || null;
}

function getImageModelSupportState(node, capabilitySummary, contextMaps = {}) {
  if (!capabilitySummary?.inputKinds?.includes(PORT_KIND_IMAGE)) {
    return {
      status: 'not-applicable',
      message: '',
    };
  }

  const model = String(node?.config?.model || '').trim();
  if (!model) {
    return {
      status: 'unknown',
      message: '',
    };
  }

  if (capabilitySummary.targetKind === 'tool' && capabilitySummary.targetId === 'ollama') {
    const capability = getOllamaModelCapabilityEntry(model, contextMaps);
    if (capability?.supportsImageInput === false) {
      return {
        status: 'unsupported',
        message: 'Selected model does not support image input. Choose a vision-capable Ollama model before running this step.',
      };
    }

    if (capability?.supportsImageInput === true) {
      return {
        status: 'supported',
        message: '',
      };
    }
  }

  if (doesModelLikelySupportImages(capabilitySummary.targetKind, capabilitySummary.targetId, model)) {
    return {
      status: 'supported',
      message: '',
    };
  }

  if (capabilitySummary.targetKind === 'tool') {
    return {
      status: 'unknown',
      message: 'This step is wired for image input, but Local AI Hub cannot confirm that the selected Ollama model supports images yet. If it refuses the image, switch to a vision-capable Ollama model like Llava or Qwen VL.',
    };
  }

  return {
    status: 'unknown',
    message: 'This step is wired for image input, but the selected model name does not clearly look image-capable. If the provider rejects the image, choose one of its vision-capable chat models.',
  };
}

function getValidationModalitySupportState(node, capabilitySummary, contextMaps = {}, connectedKinds = []) {
  if (!capabilitySummary || capabilitySummary.operationId !== PIPELINE_OPERATION_IDS.VALIDATION_LLM) {
    return {
      status: 'supported',
      message: '',
    };
  }

  const { collectionKinds, itemKinds, resolvedKinds } = getValidationConnectedKinds(connectedKinds);
  if (!resolvedKinds.length) {
    return {
      status: 'supported',
      message: '',
    };
  }

  const targetLabel = capabilitySummary.targetLabel || 'This validator';
  const directKinds = uniqueKindList(
    capabilitySummary.directInputKinds && capabilitySummary.directInputKinds.length
      ? capabilitySummary.directInputKinds
      : capabilitySummary.inputKinds,
  );
  const derivedKinds = uniqueKindList(capabilitySummary.derivedInputKinds || []);

  if (collectionKinds.length) {
    const collectionLabel = collectionKinds.length === 1
      ? formatPortKindLabel(collectionKinds[0]).toLowerCase()
      : 'ordered collection';
    if (itemKinds.some((kind) => kind === PORT_KIND_IMAGE || kind === PORT_KIND_VIDEO || kind === PORT_KIND_AUDIO)) {
      return {
        status: 'limited',
        message: targetLabel + ' will review the connected ' + collectionLabel + ' as a whole through collection metadata and per-item summaries. It will not inspect every media item as a separate attachment in this step.',
      };
    }

    if (itemKinds.includes(PORT_KIND_FILE)) {
      return {
        status: 'limited',
        message: targetLabel + ' will review the connected ' + collectionLabel + ' as a whole through collection metadata and extracted per-file evidence when available. It will not open every file as a separate attachment in this step.',
      };
    }
  }

  if (resolvedKinds.includes(PORT_KIND_IMAGE) && directKinds.includes(PORT_KIND_IMAGE)) {
    const imageSupport = getImageModelSupportState(node, capabilitySummary, contextMaps);
    if (imageSupport.status !== 'not-applicable') {
      return imageSupport;
    }
  }

  if (resolvedKinds.includes(PORT_KIND_VIDEO)) {
    if (directKinds.includes(PORT_KIND_VIDEO)) {
      return capabilitySummary.targetKind === 'provider' && capabilitySummary.targetId === 'google'
        ? {
            status: 'supported',
            message: '',
          }
        : {
            status: 'unknown',
            message: targetLabel + ' can accept a video attachment here, but Local AI Hub cannot confirm per-model video review support from the current catalog yet. If it refuses the video, switch to a Gemini multimodal model or use user approval.',
          };
    }

    return {
      status: 'unsupported',
      message: targetLabel + ' cannot review video input in this validation step yet. Choose a Gemini validator or use user approval for this artifact.',
    };
  }

  if (resolvedKinds.includes(PORT_KIND_FILE)) {
    if (directKinds.includes(PORT_KIND_FILE)) {
      if (capabilitySummary.targetKind === 'provider' && capabilitySummary.targetId === 'anthropic') {
        return {
          status: 'unknown',
          message: 'Claude can review PDF documents directly here. Other file types may fall back to extracted text depending on the file.',
        };
      }

      return {
        status: 'supported',
        message: '',
      };
    }

    if (derivedKinds.includes(PORT_KIND_FILE)) {
      return {
        status: 'limited',
        message: targetLabel + ' will review extracted text and metadata from the connected file. It will not inspect the raw file directly in this step.',
      };
    }
  }

  return {
    status: 'supported',
    message: '',
  };
}

function getConnectedOutputPortEntries(node, graph) {
  if (!node || !graph) {
    return [];
  }

  return (graph.outgoingEdgesByNode.get(node.id) || [])
    .map((edge) => ({
      edge,
      port: getPortDefinition(node, 'output', edge.source.portId),
    }))
    .filter((entry) => entry.port);
}

function getUnexpectedOutputConnectionMessage(node, supportedOutputKinds = [], graph) {
  const normalizedOutputKinds = uniqueKindList(supportedOutputKinds);
  const unsupportedEntry = getConnectedOutputPortEntries(node, graph).find((entry) => {
    const portKind = normalizePortKind(entry.port?.kind);
    return portKind && !normalizedOutputKinds.includes(portKind);
  });

  if (!unsupportedEntry) {
    return '';
  }

  const portKind = normalizePortKind(unsupportedEntry.port?.kind);
  const targetNode = graph.nodeMap.get(unsupportedEntry.edge.target.nodeId);
  return 'This step is set to return ' + formatPortKindList(normalizedOutputKinds) + ', but it is currently wired through the ' + (PIPELINE_PORT_KIND_LABELS[portKind] || unsupportedEntry.port?.label || 'selected') + ' output to ' + (targetNode?.label || 'another node') + '. Use the matching output port for this operation.';
}

function getModelStepSupportState(node, capabilitySummary, contextMaps = {}, connectedKinds = []) {
  const model = String(node?.config?.model || '').trim();
  if (!capabilitySummary) {
    return {
      status: 'unknown',
      message: '',
    };
  }

  if (!model) {
    if (
      node?.config?.executionMode === 'localTool'
      && (
        capabilitySummary.operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
        || capabilitySummary.operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
        || capabilitySummary.operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
        || capabilitySummary.operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
        || capabilitySummary.operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
      )
    ) {
      return {
        status: 'supported',
        message: '',
      };
    }

    if (
      capabilitySummary.targetKind === 'provider'
      && capabilitySummary.targetId
      && !doesProviderOperationRequireExplicitModel(capabilitySummary.targetId, capabilitySummary.operationId)
    ) {
      return {
        status: 'supported',
        message: '',
      };
    }

    return {
      status: 'unknown',
      message: '',
    };
  }

  if (capabilitySummary.targetKind === 'tool' && capabilitySummary.targetId && capabilitySummary.targetId !== 'ollama') {
    if (node?.config?.executionMode === 'localTool' && capabilitySummary.operationId !== PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
      return {
        status: 'supported',
        message: '',
      };
    }

    const tool = getContextToolEntry(capabilitySummary.targetId, contextMaps);
    const downloadedModels = Array.isArray(tool?.downloadedModels) ? tool.downloadedModels : [];
    if (!downloadedModels.length) {
      return {
        status: 'unknown',
        message: capabilitySummary.targetLabel + ' has not shared its local checkpoint list yet. Refresh the local model list or make sure the tool is installed on this PC before running this step.',
      };
    }

    if (!doesToolExposeDownloadedModel(tool, model)) {
      return {
        status: 'unsupported',
        message: 'Selected checkpoint is not available in ' + capabilitySummary.targetLabel + '. Refresh the local model list or download that checkpoint before running this step.',
      };
    }
  }

  if (capabilitySummary.targetKind === 'provider' && capabilitySummary.targetId) {
    const modelCapabilities = getProviderModelCapabilities(capabilitySummary.targetId, model);
    if (!modelCapabilities?.operations?.[capabilitySummary.operationId]) {
      return {
        status: 'unsupported',
        message:
          capabilitySummary.operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
            ? 'Selected model does not support image generation on ' + capabilitySummary.targetLabel + '. Choose a dedicated image model such as gpt-image-1 before running this step.'
            : capabilitySummary.operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
              ? 'Selected model does not support video generation on ' + capabilitySummary.targetLabel + '. Choose a Sora video model such as sora-2 before running this step.'
              : capabilitySummary.operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                ? capabilitySummary.targetId === 'google'
                  ? 'Selected model does not support speech generation on ' + capabilitySummary.targetLabel + '. Choose a Gemini TTS model such as gemini-2.5-flash-preview-tts before running this step.'
                  : capabilitySummary.targetId === 'openai'
                    ? 'Selected model does not support speech generation on ' + capabilitySummary.targetLabel + '. Choose an OpenAI TTS model such as gpt-4o-mini-tts, tts-1, or tts-1-hd before running this step.'
                    : 'Selected model does not support speech generation on ' + capabilitySummary.targetLabel + '. Choose a compatible text-to-speech model before running this step.'
                : 'Selected model does not support ' + getPipelineOperationLabel(capabilitySummary.operationId).toLowerCase() + ' on ' + capabilitySummary.targetLabel + '. Choose a compatible chat model before running this step.',
      };
    }
  }

  if (
    (capabilitySummary.operationId === PIPELINE_OPERATION_IDS.LLM_PROMPT || capabilitySummary.operationId === PIPELINE_OPERATION_IDS.VALIDATION_LLM)
    && connectedKinds.includes(PORT_KIND_IMAGE)
  ) {
    return getImageModelSupportState(node, capabilitySummary, contextMaps);
  }

  return {
    status: 'supported',
    message: '',
  };
}

function buildPipelineGraph(definition = {}) {
  const pipeline = normalizePipelineDefinition(definition, {
    keepCreatedAt: true,
    keepUpdatedAt: true,
  });
  const errors = [];
  const warnings = [];
  const nodeMap = new Map();
  const nodeOrder = pipeline.nodes.map((node) => node.id);

  if (!pipeline.nodes.length) {
    errors.push('Add at least one node before running this pipeline.');
  }

  for (const node of pipeline.nodes) {
    if (nodeMap.has(node.id)) {
      errors.push(`The pipeline contains two nodes with the ID "${node.id}".`);
      continue;
    }

    if (!getNodeTypeDefinition(node.type)) {
      errors.push(`"${node.label}" uses an unsupported node type.`);
    }

    nodeMap.set(node.id, node);
  }

  const structuralEdges = [];
  const edgeKeys = new Set();
  const targetPortKeys = new Map();
  for (const edge of pipeline.edges) {
    const sourceNode = nodeMap.get(edge.source.nodeId);
    const targetNode = nodeMap.get(edge.target.nodeId);
    if (!sourceNode || !targetNode) {
      errors.push('One of the connections points at a node that no longer exists.');
      continue;
    }

    if (sourceNode.id === targetNode.id) {
      errors.push(`"${sourceNode.label}" cannot connect to itself.`);
      continue;
    }

    const sourcePort = getPortDefinition(sourceNode, 'output', edge.source.portId);
    const targetPort = getPortDefinition(targetNode, 'input', edge.target.portId);
    if (!sourcePort || !targetPort) {
      errors.push(`Local AI Hub found an invalid connection between "${sourceNode.label}" and "${targetNode.label}".`);
      continue;
    }

    const edgeKey = `${sourceNode.id}:${sourcePort.id}->${targetNode.id}:${targetPort.id}`;
    if (edgeKeys.has(edgeKey)) {
      errors.push(`"${sourceNode.label}" is already connected to "${targetNode.label}" through ${targetPort.label}.`);
      continue;
    }

    edgeKeys.add(edgeKey);
    const targetKey = `${targetNode.id}:${targetPort.id}`;
    const existingTargetEdges = targetPortKeys.get(targetKey) || [];
    if (existingTargetEdges.length && !doesPortAllowMultipleConnections(targetPort)) {
      errors.push(`"${targetNode.label}" already has a connection for ${targetPort.label}.`);
      continue;
    }

    existingTargetEdges.push(edge);
    targetPortKeys.set(targetKey, existingTargetEdges);
    structuralEdges.push({
      edge,
      sourceNode,
      sourcePort,
      targetNode,
      targetPort,
    });
  }

  const outgoingEdgesByNode = new Map([...nodeMap.keys()].map((nodeId) => [nodeId, []]));
  const incomingEdgesByNode = new Map([...nodeMap.keys()].map((nodeId) => [nodeId, []]));
  const incomingEdgesByPortKey = new Map();
  const compatibilityIncomingEdgesByPortKey = new Map();
  for (const entry of structuralEdges) {
    const targetKey = `${entry.targetNode.id}:${entry.targetPort.id}`;
    if (!compatibilityIncomingEdgesByPortKey.has(targetKey)) {
      compatibilityIncomingEdgesByPortKey.set(targetKey, []);
    }

    compatibilityIncomingEdgesByPortKey.get(targetKey).push(entry.edge);
  }

  const compatibilityIncomingEdgeByPortKey = new Map(
    [...compatibilityIncomingEdgesByPortKey.entries()].map(([portKey, edges]) => [portKey, edges[0]]),
  );
  const validEdges = [];
  const graphForCompatibility = {
    pipeline,
    nodeMap,
    incomingEdgesByPortKey: compatibilityIncomingEdgesByPortKey,
    incomingEdgeByPortKey: compatibilityIncomingEdgeByPortKey,
  };
  const invalidMultiInputPortKeys = new Set();

  for (const entry of structuralEdges) {
    const targetKey = `${entry.targetNode.id}:${entry.targetPort.id}`;
    if (
      doesPortAllowMultipleConnections(entry.targetPort)
      && !invalidMultiInputPortKeys.has(targetKey)
      && (compatibilityIncomingEdgesByPortKey.get(targetKey) || []).length > 1
      && !getIncomingKindsForPort(entry.targetNode, entry.targetPort, graphForCompatibility).length
    ) {
      errors.push(`"${entry.targetNode.label}" can only merge branches that stay on the same artifact type. Connect branches that all carry text, image, audio, video, or file output.`);
      invalidMultiInputPortKeys.add(targetKey);
    }
  }

  for (const entry of structuralEdges) {
    if (!arePortsCompatible(entry.sourcePort, entry.targetPort, {
      sourceNode: entry.sourceNode,
      targetNode: entry.targetNode,
      graph: graphForCompatibility,
    })) {
      errors.push(`"${entry.sourceNode.label}" cannot connect ${entry.sourcePort.label} to ${entry.targetNode.label}'s ${entry.targetPort.label} input.`);
      continue;
    }

    validEdges.push(entry.edge);
    const targetKey = `${entry.targetNode.id}:${entry.targetPort.id}`;
    if (!incomingEdgesByPortKey.has(targetKey)) {
      incomingEdgesByPortKey.set(targetKey, []);
    }

    incomingEdgesByPortKey.get(targetKey).push(entry.edge);
    outgoingEdgesByNode.get(entry.sourceNode.id).push(entry.edge);
    incomingEdgesByNode.get(entry.targetNode.id).push(entry.edge);
  }

  const incomingEdgeByPortKey = new Map(
    [...incomingEdgesByPortKey.entries()].map(([portKey, edges]) => [portKey, edges[0]]),
  );

  const terminalNodeIds = pipeline.nodes.filter((node) => getNodeTypeDefinition(node.type)?.terminal).map((node) => node.id);
  const retainedResultNodeIds = pipeline.nodes
    .filter((node) => {
      const definition = getNodeTypeDefinition(node.type);
      return Boolean(definition?.terminal || definition?.persistsOutput);
    })
    .map((node) => node.id);
  if (!retainedResultNodeIds.length) {
    errors.push('Add at least one output or review node so Local AI Hub knows which result to keep.');
  }

  const reachableNodeIds = new Set();
  const reverseQueue = [...retainedResultNodeIds];
  while (reverseQueue.length > 0) {
    const nodeId = reverseQueue.shift();
    if (reachableNodeIds.has(nodeId)) {
      continue;
    }

    reachableNodeIds.add(nodeId);
    const incomingEdges = incomingEdgesByNode.get(nodeId) || [];
    for (const edge of incomingEdges) {
      reverseQueue.push(edge.source.nodeId);
    }
  }

  for (const node of pipeline.nodes) {
    if (!reachableNodeIds.has(node.id) && retainedResultNodeIds.length > 0) {
      warnings.push(`"${node.label}" does not lead to a kept result and will be skipped.`);
    }
  }

  const indegree = new Map();
  const executionOrder = [];
  const queuedNodeIds = [];
  for (const nodeId of nodeOrder) {
    if (!reachableNodeIds.has(nodeId)) {
      continue;
    }

    const incomingCount = (incomingEdgesByNode.get(nodeId) || []).filter((edge) => reachableNodeIds.has(edge.source.nodeId)).length;
    indegree.set(nodeId, incomingCount);
    if (incomingCount === 0) {
      queuedNodeIds.push(nodeId);
    }
  }

  while (queuedNodeIds.length > 0) {
    const currentNodeId = queuedNodeIds.shift();
    executionOrder.push(currentNodeId);

    for (const edge of outgoingEdgesByNode.get(currentNodeId) || []) {
      if (!reachableNodeIds.has(edge.target.nodeId)) {
        continue;
      }

      const nextDegree = Number(indegree.get(edge.target.nodeId) || 0) - 1;
      indegree.set(edge.target.nodeId, nextDegree);
      if (nextDegree === 0) {
        queuedNodeIds.push(edge.target.nodeId);
      }
    }
  }

  const reachableCount = [...reachableNodeIds].length;
  if (reachableCount > 0 && executionOrder.length !== reachableCount) {
    errors.push('Local AI Hub found a cycle in the connected part of this pipeline. Remove the loop before running it.');
  }

  const graph = {
    pipeline,
    errors,
    warnings,
    nodeMap,
    outgoingEdgesByNode,
    incomingEdgesByNode,
    incomingEdgesByPortKey,
    incomingEdgeByPortKey,
    reachableNodeIds,
    terminalNodeIds,
    retainedResultNodeIds,
    executionOrder,
    executionIndexByNodeId: new Map(executionOrder.map((nodeId, index) => [nodeId, index])),
    retryLoopIssuesByNodeId: new Map(),
    retryLoopNodeIdsBySegmentNodeId: new Map(),
    retryLoopNodeIdsByTargetNodeId: new Map(),
    retryLoopsByNodeId: new Map(),
    collectionAccumulatorIssuesByNodeId: new Map(),
    collectionAccumulatorsByNodeId: new Map(),
    edges: validEdges,
  };

  for (const nodeId of executionOrder) {
    const node = nodeMap.get(nodeId);
    const definitionEntry = getNodeTypeDefinition(node?.type);
    if (!node || !definitionEntry) {
      continue;
    }

    for (const port of definitionEntry.inputPorts || []) {
      const targetKey = `${node.id}:${port.id}`;
      const incomingEdges = incomingEdgesByPortKey.get(targetKey) || [];
      if (port.required && !incomingEdges.length) {
        errors.push(`"${node.label}" is missing a connection for ${port.label}.`);
        continue;
      }

      if (
        doesPortAllowMultipleConnections(port)
        && incomingEdges.length > 1
        && !invalidMultiInputPortKeys.has(targetKey)
        && !getIncomingKindsForPort(node, port, graph).length
      ) {
        errors.push(`"${node.label}" can only merge branches that stay on the same artifact type. Connect branches that all carry text, image, audio, video, or file output.`);
      }
    }
  }

  populateRetryLoopMetadata(graph);
  populateCollectionAccumulatorMetadata(graph);
  return graph;
}

function pickAvailableToolId(candidateToolIds = [], contextMaps = {}) {
  for (const toolId of candidateToolIds) {
    if (contextMaps.toolsById?.[toolId] || contextMaps.toolCatalogById?.[toolId]) {
      return toolId;
    }
  }

  return candidateToolIds[0] || null;
}

function isLikelySupportOnlyImageModel(entry) {
  return isLikelySupportOnlyStableDiffusionModel(entry);
}

function getLocalImageCheckpointModels(tool) {
  return getStableDiffusionCheckpointModels(Array.isArray(tool?.downloadedModels) ? tool.downloadedModels : []);
}

function toolHasDownloadedModelInfo(tool) {
  return Array.isArray(tool?.downloadedModels);
}

function doesLocalImageToolExposeModel(tool, model) {
  return Boolean(findStableDiffusionCheckpointMatch(getLocalImageCheckpointModels(tool), model));
}

function getLocalImageBackendOperationId(node, fallback = PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
  if (node?.type === 'imageAnalyze') {
    return PIPELINE_OPERATION_IDS.IMAGE_ANALYZE;
  }

  if (node?.type === 'collectionMap') {
    return getCollectionMapOperationId(node);
  }

  if (node?.type === 'llmPrompt') {
    return getModelStepOperationId(node);
  }

  return fallback;
}

function getLocalImageBackendModelState(tool, model) {
  const requestedModel = String(model || '').trim();
  const hasModelInfo = toolHasDownloadedModelInfo(tool);
  const checkpoints = getLocalImageCheckpointModels(tool);

  if (requestedModel) {
    if (!hasModelInfo) {
      return {
        status: 'unknown',
        message: (tool?.name || 'This image backend') + ' has not shared its local checkpoint list yet. Refresh checkpoints before relying on this override, or leave it blank to use the backend current checkpoint.',
      };
    }

    if (!doesLocalImageToolExposeModel(tool, requestedModel)) {
      return {
        status: 'unknown',
        message: 'Selected checkpoint is not in the last cached checkpoint list for ' + (tool?.name || 'this image backend') + '. Local AI Hub will verify the live WebUI model list before sending the request.',
      };
    }

    return { status: 'ready', message: '' };
  }

  if (!hasModelInfo) {
    return {
      status: 'unknown',
      message: (tool?.name || 'This image backend') + ' will use its currently loaded checkpoint. Local AI Hub will verify the live WebUI model list before sending the request.',
    };
  }

  if (!checkpoints.length) {
    const status = String(tool?.status || '').trim().toLowerCase();
    if (status === 'running' || status === 'starting') {
      return {
        status: 'unknown',
        message: (tool?.name || 'This image backend') + ' will use its currently loaded checkpoint if the live WebUI API reports a usable generation checkpoint. Refresh checkpoints to see the backend list before running.',
      };
    }

    return {
      status: 'missing',
      message: (tool?.name || 'This image backend') + ' does not have a usable Stable Diffusion checkpoint in its local model list. Download or add a real checkpoint before running this step.',
    };
  }

  return { status: 'ready', message: '' };
}

function getLocalImageBackendCandidateState(toolId, contextMaps = {}, options = {}) {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  const operationId = options.operationId || PIPELINE_OPERATION_IDS.IMAGE_GENERATE;
  const installedTool = contextMaps.toolsById?.[normalizedToolId] || null;
  const catalogTool = contextMaps.toolCatalogById?.[normalizedToolId] || null;
  const tool = installedTool || catalogTool || null;
  const label = tool?.name || normalizedToolId || 'This backend';
  const capability = getContextToolOperation(normalizedToolId, operationId, contextMaps);
  const model = String(options.model || '').trim();
  const messages = [];
  let score = 0;
  let usable = true;

  if (!normalizedToolId || !capability) {
    return { toolId: normalizedToolId, tool, installedTool, usable: false, score: -1000, message: label + ' is not a Local AI Hub pipeline image-generation backend.' };
  }

  if (!installedTool) {
    return { toolId: normalizedToolId, tool, installedTool, usable: false, score: -900, message: 'Install ' + label + ' before using it for local image generation.' };
  }

  score += 100;
  if (!canToolLikelyLaunch(installedTool)) {
    usable = false;
    score -= 300;
    messages.push(label + ' is installed, but Local AI Hub cannot find a launchable local runtime. Run Repair or reinstall it before using this image backend.');
  }

  const status = String(installedTool.status || '').trim().toLowerCase();
  const lastError = String(installedTool.lastError || '').trim();
  if (status === 'running') {
    score += 80;
  } else if (status === 'starting') {
    score += 45;
  } else if (status === 'error') {
    usable = false;
    score -= 250;
    messages.push(lastError || (label + ' is currently marked unhealthy. Open Library or run Repair before using it for image generation.'));
  } else {
    score += 30;
    if (lastError) {
      score -= 60;
      messages.push(label + ' has a recent launch issue: ' + lastError);
    }
  }

  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
    const modelState = getLocalImageBackendModelState(installedTool, model);
    if (modelState.status === 'ready') {
      score += 35;
    } else if (modelState.status === 'missing') {
      usable = false;
      score -= 220;
      messages.push(modelState.message);
    } else if (modelState.status === 'unknown') {
      score -= 5;
      messages.push(modelState.message);
    }
  }

  const compatibilityProfile = installedTool.compatibility || catalogTool?.compatibility || catalogTool?.installInstructions?.compatibility || null;
  const compatibility = evaluateCompatibilityProfile(compatibilityProfile, contextMaps.hardware);
  if (compatibility?.tone === 'good') {
    score += 12;
  } else if (compatibility?.tone === 'warn') {
    score -= 8;
  } else if (compatibility?.tone === 'danger' || compatibility?.tone === 'error') {
    score -= 35;
    messages.push(compatibility.message);
  }

  return {
    compatibility,
    installedTool,
    message: messages.find(Boolean) || '',
    score,
    status,
    tool: installedTool,
    toolId: normalizedToolId,
    usable,
  };
}

function getUnsupportedLocalImageBackendMessage(toolId, contextMaps = {}) {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  const label = getContextToolEntry(normalizedToolId, contextMaps)?.name || normalizedToolId || 'This tool';
  if (normalizedToolId === 'comfyui' || normalizedToolId === 'invokeai') {
    return label + ' stays graph-native in Local AI Hub. Use a Graph Workflow node with an imported workflow instead of the sequential Image Generation backend selector.';
  }
  return 'Choose Auto, Forge, or Automatic1111 for this local image generation step.';
}

function selectLocalImageBackend(contextMaps = {}, node = {}, options = {}) {
  const operationId = options.operationId || getLocalImageBackendOperationId(node);
  const candidateToolIds = (Array.isArray(options.candidateToolIds) && options.candidateToolIds.length ? options.candidateToolIds : IMAGE_WORKFLOW_TOOL_IDS)
    .map((toolId) => String(toolId || '').trim().toLowerCase())
    .filter(Boolean);
  const selectedToolId = String(options.toolId || node?.config?.toolId || '').trim().toLowerCase();
  const model = String(options.model !== undefined ? options.model : node?.config?.model || '').trim();

  if (selectedToolId) {
    if (!candidateToolIds.includes(selectedToolId)) {
      return {
        explicit: true,
        message: getUnsupportedLocalImageBackendMessage(selectedToolId, contextMaps),
        score: -1000,
        tool: getContextToolEntry(selectedToolId, contextMaps),
        toolId: selectedToolId,
        usable: false,
      };
    }

    return {
      explicit: true,
      ...getLocalImageBackendCandidateState(selectedToolId, contextMaps, { model, operationId }),
    };
  }

  const candidates = candidateToolIds.map((toolId) => getLocalImageBackendCandidateState(toolId, contextMaps, { model, operationId }));
  const usableCandidates = candidates
    .filter((entry) => entry.usable)
    .sort((left, right) => right.score - left.score);
  const selected = usableCandidates[0] || null;
  if (selected) {
    return {
      auto: true,
      candidates,
      ...selected,
    };
  }

  const bestBlocked = candidates.sort((left, right) => right.score - left.score)[0] || null;
  return {
    auto: true,
    candidates,
    message: bestBlocked?.message || 'No usable local image generation backend is ready. Install or repair Forge or Automatic1111, then make sure a real Stable Diffusion checkpoint is available.',
    score: bestBlocked?.score || -1000,
    tool: bestBlocked?.tool || null,
    toolId: bestBlocked?.toolId || '',
    usable: false,
  };
}

function getImageToolIdForNode(node, contextMaps = {}) {
  const selectedToolId = String(node?.config?.toolId || '').trim();
  if (selectedToolId) {
    return selectedToolId;
  }

  return selectLocalImageBackend(contextMaps, node).toolId || '';
}

function getLocalToolRequirement(node, contextMaps = {}) {
  if (node.type === 'llmPrompt' && getModelStepExecutionMode(node) === 'ollama') {
    return 'ollama';
  }

  if (node.type === 'planner' && node.config?.executionMode === 'ollama') {
    return 'ollama';
  }

  if (node.type === 'llmPrompt' && getModelStepExecutionMode(node) === 'localTool') {
    return getModelStepLocalToolId(node, contextMaps);
  }

  if (node.type === 'validation' && node.config?.mode === 'llm' && node.config?.llmExecutionMode === 'ollama') {
    return 'ollama';
  }

  if (node.type === 'collectionMap' && getCollectionMapExecutionMode(node) === 'localTool') {
    return getImageToolIdForNode(node, contextMaps);
  }

  if (node.type === 'collectionMap' && getCollectionMapExecutionMode(node) === 'graphWorkflow') {
    const support = getGraphWorkflowOperationBackendSupport(node, GRAPH_WORKFLOW_OPERATION_BACKEND_IDS.TEXT_TO_IMAGE);
    return support.toolId || String(node.config?.graphWorkflowToolId || '').trim().toLowerCase() || null;
  }
  if (node.type === 'graphWorkflow') {
    return getGraphWorkflowToolId(node);
  }

  return null;
}

function getCompatibilityEntry(node, contextMaps) {
  const requiredToolId = getLocalToolRequirement(node, contextMaps);
  if (!requiredToolId) {
    return null;
  }

  const installedTool = contextMaps.toolsById[requiredToolId] || null;
  const catalogTool = contextMaps.toolCatalogById[requiredToolId] || installedTool || null;
  return {
    requiredToolId,
    installedTool,
    catalogTool,
    profile: catalogTool?.compatibility || catalogTool?.installInstructions?.compatibility || installedTool?.compatibility || null,
  };
}

function trimPreviewText(value, limit = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}

function buildNodeIssue(node, tone, message, options = {}) {
  return {
    nodeId: node.id,
    nodeLabel: node.label,
    tone,
    message,
    kind: options.kind || 'readiness',
  };
}
function parseProviderStatusTimestamp(value) {
  const timestamp = Date.parse(String(value || '').trim());
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSelectedProviderStatus(providerId, contextMaps) {
  const provider = contextMaps.providersById[String(providerId || '').trim()] || null;
  if (!provider) {
    return {
      provider: null,
      tone: 'error',
      message: 'Choose a connected cloud provider for this step.',
    };
  }

  if (!provider.isConnected) {
    return {
      provider,
      tone: 'error',
      message: 'That cloud provider is not connected on this PC yet. Save its API key first.',
    };
  }

  const lastSuccessfulUseTimestamp = parseProviderStatusTimestamp(provider.lastSuccessfulUseAt);
  const lastTestedTimestamp = parseProviderStatusTimestamp(provider.lastTestedAt);
  const liveSuccessOutranksFailedTest = provider.lastTestSucceeded === false
    && lastSuccessfulUseTimestamp
    && (!lastTestedTimestamp || lastSuccessfulUseTimestamp >= lastTestedTimestamp);

  if (liveSuccessOutranksFailedTest) {
    return {
      provider,
      tone: 'info',
      message: provider.name + ' completed a real provider request on this PC more recently than its last failed connection check. Local AI Hub will rely on that newer success for this step.',
    };
  }

  if (provider.lastTestSucceeded === false) {
    return {
      provider,
      tone: 'warn',
      message: provider.name + ' has a saved API key, but the last connection check failed on this PC. Re-test the provider before relying on this step.',
    };
  }

  if (!provider.lastTestedAt || provider.lastTestSucceeded !== true) {
    if (lastSuccessfulUseTimestamp) {
      return {
        provider,
        tone: 'info',
        message: provider.name + ' completed a real provider request on this PC, even though it has not passed a saved connection check here yet.',
      };
    }

    return {
      provider,
      tone: 'warn',
      message: provider.name + ' has a saved API key, but it has not been validated on this PC yet.',
    };
  }

  return {
    provider,
    tone: 'info',
    message: provider.name + ' will process this step outside your machine.',
  };
}

function analyzeInputFileNode(node, summary) {
  if (!String(node.config?.filePath || '').trim()) {
    summary.readiness = {
      tone: 'error',
      message: `Choose a file for ${node.label} before running this pipeline.`,
    };
    return false;
  }

  return true;
}

function canToolLikelyLaunch(tool) {
  if (!tool || tool.launchSupported === false) {
    return false;
  }

  if (tool.launchProfile?.kind === 'embedded') {
    return Boolean(tool.launchProfile?.pythonPath || tool.externalPythonPath || tool.managedPythonPath || tool.pythonBootstrapPath || tool.installDir || tool.displayPath);
  }

  if (tool.launchProfile?.kind === 'python-script' || tool.launchProfile?.kind === 'python-module') {
    return Boolean(tool.launchProfile?.pythonPath || tool.externalPythonPath || tool.managedPythonPath || tool.pythonBootstrapPath);
  }

  if (tool.launchProfile?.kind === 'binary') {
    return Boolean(tool.launchProfile?.executable || tool.executablePath);
  }

  if (tool.launchProfile?.kind === 'batch') {
    return Boolean(tool.launchProfile?.command);
  }

  if (tool.launchProfile?.kind === 'folder') {
    return Boolean(tool.launchProfile?.path || tool.installDir || tool.displayPath);
  }

  return Boolean(tool.installDir || tool.displayPath || tool.appDir);
}

function analyzeWhisperNode(summary, contextMaps) {
  const tool = contextMaps.toolsById.whisper || null;
  if (!tool) {
    summary.readiness = {
      tone: 'error',
      message: 'Install Whisper before using this transcription step in a pipeline.',
    };
    return false;
  }

  if (String(tool.status || '').toLowerCase() === 'error' && String(tool.lastError || '').trim()) {
    summary.readiness = {
      tone: 'error',
      message: tool.lastError,
    };
    return false;
  }

  if (!canToolLikelyLaunch(tool)) {
    summary.readiness = {
      tone: 'error',
      message: 'Whisper is installed, but Local AI Hub cannot find its Python environment yet. Run Repair or reinstall Whisper before using this transcription step.',
    };
    return false;
  }

  if (String(tool.status || '').toLowerCase() === 'running') {
    summary.readiness = {
      tone: 'info',
      message: 'Whisper is ready for local transcription on this PC.',
    };
    return true;
  }

  if (String(tool.status || '').toLowerCase() === 'starting') {
    summary.readiness = {
      tone: 'warn',
      message: 'Whisper is still starting. Local AI Hub will wait for it before this transcription step runs.',
    };
    return true;
  }

  summary.readiness = {
    tone: 'warn',
    message: 'Whisper is installed and Local AI Hub can start it automatically when this transcription step begins.',
  };
  return true;
}

function analyzeImageToolNode(node, summary, contextMaps) {
  const selection = selectLocalImageBackend(contextMaps, node);
  if (!selection.usable) {
    summary.readiness = {
      tone: 'error',
      message: selection.message || 'No usable local image generation backend is ready. Install or repair Forge or Automatic1111, then refresh checkpoints.',
    };
    return false;
  }

  const tool = selection.tool || null;
  if (String(tool.status || '').toLowerCase() !== 'running') {
    summary.readiness = {
      tone: 'warn',
      message: tool.name + ' is not running yet. Local AI Hub can start it automatically when this image step begins. ' + (selection.message || 'Leave Checkpoint blank to use the backend current checkpoint.'),
    };
    return true;
  }

  summary.readiness = {
    tone: 'info',
    message: tool.name + ' will handle this image step locally. ' + (selection.message || 'Leave Checkpoint blank to use the backend current checkpoint.'),
  };
  return true;
}

function analyzeModelStepLocalToolNode(node, summary, contextMaps, connectedKinds = [], referenceKinds = []) {
  const operationId = getModelStepOperationId(node);
  const selectedToolId = String(node.config?.toolId || '').trim();
  const supportedToolIds = getOperationDrivenToolIdsForModelStepOperation(operationId);
  const effectiveToolId = getModelStepLocalToolId(node, contextMaps);
  const installMessage = operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
    ? 'Install Whisper before using local audio transcription in a model step.'
    : operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
      ? 'Install Wan2.1 WebUI before using local video generation in a model step.'
      : operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
        ? 'Install AudioCraft WebUI before using local audio generation in a model step.'
        : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
          ? 'Install RVC before using local audio transformation in a model step.'
          : operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
            ? 'Install Upscayl or FaceFusion before using local image transformation in a model step.'
            : operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE
              ? 'Install Automatic1111 or Forge before using local image analysis in a model step.'
              : 'Install Automatic1111 or Forge before using the local image tool mode in a model step.';
  const selectionMessage = operationId === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE
    ? 'Choose Whisper for this local audio transcription model step.'
    : operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
      ? 'Choose Wan2.1 WebUI for this local video model step. ComfyUI video workflows use the dedicated Graph Workflow step instead of this model-step mode.'
      : operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
        ? 'Choose AudioCraft WebUI for this local audio generation step. Use Audio transform when you want RVC voice conversion, so this operation stays focused on generated-audio output.'
        : operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM
          ? 'Choose RVC for this local audio transformation step. Generated-audio tools stay on the dedicated audio-generation path.'
          : operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
            ? 'Choose Upscayl or FaceFusion for this local image transformation step. Automatic1111, Forge, and graph-native tools stay on the generation or Graph Workflow paths.'
            : operationId === PIPELINE_OPERATION_IDS.IMAGE_ANALYZE
              ? 'Choose Automatic1111 or Forge for this local image analysis model step.'
              : 'Choose Automatic1111 or Forge for this local image model step. ComfyUI and other graph-native local tools use the dedicated Graph Workflow step instead of this model-step mode.';

  if (selectedToolId && !supportedToolIds.includes(selectedToolId)) {
    summary.readiness = {
      tone: 'error',
      message: selectionMessage,
    };
    return false;
  }

  if (!effectiveToolId) {
    summary.readiness = {
      tone: 'error',
      message: installMessage,
    };
    return false;
  }

  const tool = contextMaps.toolsById[effectiveToolId] || null;
  if (!tool) {
    summary.readiness = {
      tone: 'error',
      message: installMessage,
    };
    return false;
  }

  const toolStatus = String(tool.status || '').trim().toLowerCase();
  const toolLastError = String(tool.lastError || '').trim();
  if (toolStatus === 'error') {
    summary.readiness = {
      tone: 'error',
      message: toolLastError || (tool.name + ' is currently marked unhealthy. Run Repair or reinstall the tool before using this model step.'),
    };
    return false;
  }

  if (!canToolLikelyLaunch(tool)) {
    summary.readiness = {
      tone: 'error',
      message: tool.name + ' is installed, but Local AI Hub cannot find its local runtime yet. Run Repair or reinstall the tool before using this model step.',
    };
    return false;
  }



  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE) {
    const selection = selectLocalImageBackend(contextMaps, node, { operationId });
    if (!selection.usable) {
      summary.readiness = {
        tone: 'error',
        message: selection.message || 'No usable local image generation backend is ready. Install or repair Forge or Automatic1111, then refresh checkpoints.',
      };
      return false;
    }

    const imageTool = selection.tool || tool;
    if (String(imageTool.status || '').toLowerCase() !== 'running') {
      summary.readiness = {
        tone: 'warn',
        message: imageTool.name + ' is not running yet. Local AI Hub can start it automatically when this model step begins. ' + (selection.message || 'Leave Checkpoint blank to use the backend current checkpoint.'),
      };
      return true;
    }

    summary.readiness = {
      tone: 'info',
      message: imageTool.name + ' will turn the connected text prompt into an image locally. ' + (selection.message || 'Leave Checkpoint blank to use the backend current checkpoint.'),
    };
    return true;
  }

  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE) {
    const audioMode = String(node.config?.audioMode || 'music').trim().toLowerCase();
    if (connectedKinds.includes(PORT_KIND_AUDIO) && audioMode === 'sound') {
      summary.readiness = {
        tone: 'error',
        message: 'Sound mode currently accepts text prompts only in this first audio-output slice. Switch the step to Music mode if you want to guide generation with connected audio.',
      };
      return false;
    }

    summary.readiness = {
      tone: 'info',
      message: tool.name + ' will run this audio generation step through its dedicated local backend adapter. Music mode accepts text prompts and optional audio guidance, while Sound mode stays text-only in this pass.',
    };
    return true;
  }

  if (operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM) {
    const selectedModel = String(node.config?.model || '').trim();
    if (!selectedModel) {
      summary.readiness = {
        tone: 'error',
        message: 'Choose an RVC voice model before running this audio transformation step.',
      };
      return false;
    }

    const downloadedModels = getRvcVoiceModels(Array.isArray(tool.downloadedModels) ? tool.downloadedModels : []);
    const matchedModel = findRvcVoiceModelMatch(downloadedModels, selectedModel);
    if (Array.isArray(tool.downloadedModels) && !downloadedModels.length) {
      summary.readiness = {
        tone: 'error',
        message: 'No RVC voice models were found in the local weights folder. Add a .pth voice model under the RVC weights folder, then refresh voice models.',
      };
      return false;
    }
    if (downloadedModels.length && !matchedModel) {
      summary.readiness = {
        tone: 'error',
        message: 'The selected RVC voice model is not available locally. Refresh voice models or pick a .pth file from the RVC weights folder.',
      };
      return false;
    }

    summary.readiness = {
      tone: 'info',
      message: tool.name + ' will transform the connected source audio through its dedicated local backend adapter. Choose a voice model from the RVC weights folder, and expect the cleanest results with a dry single-speaker voice clip. The index file stays optional in this first pass.',
    };
    return true;
  }

  if (operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM) {
    const transformSubtype = normalizeImageTransformSubtype(tool.id, node.config?.transformSubtype);
    if (!transformSubtype) {
      const subtypeOptions = getImageTransformSubtypeOptions(tool.id).map((entry) => entry.label).join(' or ');
      summary.readiness = {
        tone: 'error',
        message: tool.name + ' does not support the selected image transform subtype. Choose ' + subtypeOptions + ' for this tool.',
      };
      return false;
    }

    const referenceImageConnected = referenceKinds.includes(PORT_KIND_IMAGE);
    if (tool.id === 'facefusion' && !referenceImageConnected) {
      summary.readiness = {
        tone: 'error',
        message: 'FaceFusion image mode needs a source face image on the Reference Image input in addition to the connected target image.',
      };
      return false;
    }

    const subtypeLabel = getImageTransformSubtypeLabel(transformSubtype);
    summary.readiness = {
      tone: 'info',
      message: tool.id === 'facefusion'
        ? tool.name + ' will run a ' + subtypeLabel + ' transform on the connected target image using the Reference Image input as the source face. This first pass stays image-only and keeps both source images attached to the saved result lineage.'
        : tool.name + ' will run a ' + subtypeLabel + ' transform through its dedicated local backend adapter. This first pass keeps the main source image attached to the transformed result lineage and leaves advanced Upscayl tuning on the full tool surface.',
    };
    return true;
  }

  if (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE) {
    const videoSize = String(node.config?.videoSize || '').trim();
    if (tool.id === 'wan21-webui' && videoSize && !['832x480', '1280x720'].includes(videoSize)) {
      summary.readiness = {
        tone: 'error',
        message: 'Wan2.1 currently supports 832x480 or 1280x720 in this first local-video pipeline slice. Choose one of those video sizes or use ComfyUI graph workflows for other layouts.',
      };
      return false;
    }

    const hasTextInput = connectedKinds.includes(PORT_KIND_TEXT);
    const hasImageInput = connectedKinds.includes(PORT_KIND_IMAGE);
    if (hasImageInput && !String(node.config?.instruction || '').trim()) {
      summary.readiness = {
        tone: 'error',
        message: 'Wan image-to-video needs motion guidance in the Instruction box before this step can run.',
      };
      return false;
    }

    if (Array.isArray(tool.downloadedModels) && !tool.downloadedModels.length) {
      summary.readiness = {
        tone: 'error',
        message: 'Wan2.1 is installed, but Local AI Hub did not find Wan model assets under models\\Wan-AI. Download the matching text-to-video or image-to-video model folders before running this step.',
      };
      return false;
    }

    const modeLabel = hasImageInput ? 'image-to-video' : hasTextInput ? 'text-to-video' : 'local video generation';
    const compatibilityProfile = tool.compatibility || null;
    const compatibility = evaluateCompatibilityProfile(compatibilityProfile, contextMaps.hardware);
    if (compatibilityProfile && (compatibility?.tone === 'danger' || compatibility?.tone === 'warn')) {
      summary.readiness = {
        tone: 'warn',
        message: tool.name + ' is configured for ' + modeLabel + ', but this machine is below or near the low end of Wan2.1 hardware targets. ' + compatibility.message + ' Wan generation also needs a CUDA-enabled PyTorch runtime and local model folders; the CUDA Toolkit/nvcc is only relevant to optional acceleration packages such as flash_attn.',
      };
      return true;
    }

    summary.readiness = {
      tone: 'info',
      message: tool.name + ' will run this ' + modeLabel + ' step through its dedicated local backend adapter. Local AI Hub keeps the pipeline sequential, requires a CUDA-enabled PyTorch runtime and Wan model folders, and saves the rendered video back into the run folder.',
    };
    return true;
  }

  if (String(tool.status || '').toLowerCase() !== 'running') {
    summary.readiness = {
      tone: 'warn',
      message: tool.name + ' is not running yet. Local AI Hub can start it automatically when this model step begins.',
    };
    return true;
  }

  summary.readiness = {
    tone: 'info',
    message: tool.name + ' will turn the connected text prompt into an image locally.',
  };
  return true;
}

function analyzeCollectionMapGraphWorkflowNode(node, summary, contextMaps) {
  const support = getGraphWorkflowOperationBackendSupport(node, GRAPH_WORKFLOW_OPERATION_BACKEND_IDS.TEXT_TO_IMAGE);
  if (!support.usable) {
    summary.readiness = {
      tone: 'error',
      message: support.message || 'Configure a compatible text-to-image graph workflow before using it for Map Collection.',
    };
    return false;
  }

  const toolLabel = getContextToolEntry(support.toolId, contextMaps)?.name || support.contract?.toolId || 'This graph workflow tool';
  const installedTool = contextMaps.toolsById[support.toolId] || null;
  if (!installedTool) {
    summary.readiness = {
      tone: 'error',
      message: 'Install ' + toolLabel + ' before using this graph workflow for Map Collection.',
    };
    return false;
  }

  if (!canToolLikelyLaunch(installedTool)) {
    summary.readiness = {
      tone: 'error',
      message: toolLabel + ' is installed, but Local AI Hub cannot find its local runtime yet. Run Repair or reinstall the tool before using this graph workflow backend.',
    };
    return false;
  }

  const status = String(installedTool.status || '').trim().toLowerCase();
  if (status === 'error') {
    summary.readiness = {
      tone: 'error',
      message: String(installedTool.lastError || '').trim() || (toolLabel + ' is currently marked unhealthy. Open Library or run Repair before using this graph workflow backend.'),
    };
    return false;
  }

  if (status !== 'running') {
    summary.readiness = {
      tone: 'warn',
      message: toolLabel + ' is not running yet. Local AI Hub can start it automatically, then run the configured graph workflow once for each text item and keep the original order.',
    };
    return true;
  }

  summary.readiness = {
    tone: 'info',
    message: toolLabel + ' will run the configured text-to-image graph workflow once for each text item and keep the original order.',
  };
  return true;
}

function analyzeGraphWorkflowNode(node, graph, summary, contextMaps) {
  const toolId = getGraphWorkflowToolId(node);
  const toolLabel = getContextToolEntry(toolId, contextMaps)?.name || 'This graph workflow tool';
  const strategy = getToolPipelineStrategy(toolId);
  const contract = getGraphWorkflowContract(toolId);

  if (!toolId || !GRAPH_WORKFLOW_TOOL_IDS.includes(toolId) || !strategy || !contract) {
    summary.readiness = {
      tone: 'error',
      message: 'Choose a graph-native workflow tool for this step.',
    };
    return false;
  }

  if (!contract.supportsExecution || !RUNNABLE_GRAPH_WORKFLOW_TOOL_IDS.includes(toolId) || strategy.id !== TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_WORKFLOW) {
    summary.readiness = {
      tone: 'error',
      message: toolLabel + ' is modeled as a graph-native workflow tool, but ' + contract.executionBlockedMessage,
    };
    return false;
  }

  const parsedWorkflow = parseGraphWorkflowDefinitionText(toolId, node.config?.workflowText);
  if (!parsedWorkflow.ok) {
    summary.readiness = {
      tone: 'error',
      message: parsedWorkflow.message,
    };
    return false;
  }

  const inputBoundaryMessages = {
    image: {
      field: 'The mapped image boundary field could not be found in the imported workflow definition.',
      missing: 'Map the Image input boundary to a workflow node and field before running this graph workflow step.',
      node: 'The mapped image boundary node could not be found in the imported workflow definition.',
    },
    text: {
      field: 'The mapped text boundary field could not be found in the imported workflow definition.',
      missing: 'Map the Text input boundary to a workflow node and field before running this graph workflow step.',
      node: 'The mapped text boundary node could not be found in the imported workflow definition.',
    },
  };

  for (const inputSpec of contract.inputPorts || []) {
    const portId = String(inputSpec.portId || '').trim();
    const binding = getGraphWorkflowInputBinding(node, portId);
    const nodeId = String(binding.nodeId || '').trim();
    const field = String(binding.field || '').trim();
    const connected = getIncomingKindsForNodePort(node, portId, graph).length > 0;
    const messages = inputBoundaryMessages[portId] || inputBoundaryMessages.text;
    if (connected && (!nodeId || !field || binding.mode !== GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_FIELD)) {
      summary.readiness = {
        tone: 'error',
        message: messages.missing,
      };
      return false;
    }

    if (!nodeId) {
      continue;
    }

    const workflowNode = getGraphWorkflowNodeEntry(parsedWorkflow.workflow, nodeId);
    if (!workflowNode) {
      summary.readiness = {
        tone: 'error',
        message: messages.node,
      };
      return false;
    }

    if (!field || !workflowNode.inputs || typeof workflowNode.inputs !== 'object' || !Object.prototype.hasOwnProperty.call(workflowNode.inputs, field)) {
      summary.readiness = {
        tone: 'error',
        message: messages.field,
      };
      return false;
    }
  }

  const supportedOutputKinds = (contract.outputPorts || []).map((entry) => entry.kind);
  const unexpectedOutputMessage = getUnexpectedOutputConnectionMessage(node, supportedOutputKinds, graph);
  if (unexpectedOutputMessage) {
    summary.readiness = {
      tone: 'error',
      message: unexpectedOutputMessage,
    };
    return false;
  }

  const outgoingEdges = graph.outgoingEdgesByNode.get(node.id) || [];
  const connectedOutputPortIds = [...new Set(outgoingEdges.map((edge) => String(edge?.source?.portId || '').trim()).filter(Boolean))];
  const requiredOutputSpecs = connectedOutputPortIds.length
    ? (contract.outputPorts || []).filter((entry) => connectedOutputPortIds.includes(String(entry.portId || '').trim()))
    : contract.outputPorts || [];

  if (!requiredOutputSpecs.length) {
    summary.readiness = {
      tone: 'error',
      message: 'Choose at least one output boundary for this graph workflow step before running it.',
    };
    return false;
  }

  for (const outputSpec of requiredOutputSpecs) {
    const portId = String(outputSpec.portId || '').trim();
    const outputBinding = getGraphWorkflowOutputBinding(node, portId);
    const outputNodeId = String(outputBinding.nodeId || '').trim();
    const outputLabel = outputSpec.label || (PIPELINE_PORT_KIND_LABELS[normalizePortKind(outputSpec.kind)] || 'workflow output');
    const lowerLabel = String(outputLabel).toLowerCase();
    if (!outputNodeId || outputBinding.mode !== GRAPH_WORKFLOW_BINDING_MODE_IDS.NODE_OUTPUT) {
      summary.readiness = {
        tone: 'error',
        message: 'Choose the workflow node that should feed the ' + outputLabel + ' boundary before running this graph workflow step.',
      };
      return false;
    }

    if (!getGraphWorkflowNodeEntry(parsedWorkflow.workflow, outputNodeId)) {
      summary.readiness = {
        tone: 'error',
        message: 'The selected ' + lowerLabel + ' boundary node could not be found in the imported workflow definition.',
      };
      return false;
    }
  }

  const installedTool = contextMaps.toolsById[toolId] || null;
  if (!installedTool) {
    summary.readiness = {
      tone: 'error',
      message: 'Install ' + toolLabel + ' before using this graph workflow step.',
    };
    return false;
  }

  if (String(installedTool.status || '').toLowerCase() !== 'running') {
    summary.readiness = {
      tone: 'warn',
      message: installedTool.name + ' is not running yet. Local AI Hub can start it automatically when this graph workflow begins.',
    };
    return true;
  }

  summary.readiness = {
    tone: 'info',
    message: installedTool.name + ' will run the imported ' + (contract.workflowFormat?.label || 'graph workflow definition') + ' and return the selected typed output back into the main pipeline.',
  };
  return true;
}

function analyzePipeline(definition = {}, context = {}) {
  const graph = buildPipelineGraph(definition);
  const contextMaps = buildContextMaps(context);
  const issues = [];
  const nodeSummaries = {};
  const compatibilityEntries = [];
  const localHeavyNodeIds = [];

  for (const message of graph.errors) {
    issues.push({ tone: 'error', message });
  }

  for (const message of graph.warnings) {
    issues.push({ tone: 'warn', message });
  }

  for (const node of graph.pipeline.nodes) {
    const summary = {
      nodeId: node.id,
      nodeLabel: node.label,
      type: node.type,
      readiness: {
        tone: 'good',
        message: 'This node is ready.',
      },
      capabilitySummary: buildNodeCapabilitySummary(node, contextMaps),
      compatibility: null,
    };
    const definitionEntry = getNodeTypeDefinition(node.type);

    if (!definitionEntry) {
      summary.readiness = {
        tone: 'error',
        message: 'This node type is not supported in the current app build.',
      };
      issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
      nodeSummaries[node.id] = summary;
      continue;
    }

    if (graph.reachableNodeIds.has(node.id)) {
      if (node.type === 'textInput' && !String(node.config?.text || '').trim()) {
        summary.readiness = {
          tone: 'error',
          message: 'Enter some text before running this pipeline.',
        };
        issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
      }

      if (node.type === 'imageInput' || node.type === 'audioInput' || node.type === 'videoInput' || node.type === 'fileInput') {
        if (!analyzeInputFileNode(node, summary)) {
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        }
      }

      if (node.type === 'llmPrompt') {
        const executionMode = getModelStepExecutionMode(node);
        const operationId = getModelStepOperationId(node);
        const connectedKinds = getIncomingKindsForNodePort(node, 'prompt', graph);
        const referenceKinds = getIncomingKindsForNodePort(node, 'referenceImage', graph);
        if (summary.capabilitySummary?.supported === false) {
          summary.readiness = {
            tone: 'error',
            message: summary.capabilitySummary.message,
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          const unsupportedKinds = connectedKinds.filter((kind) => !(summary.capabilitySummary?.inputKinds || []).includes(kind));
          const outputConnectionMessage = getUnexpectedOutputConnectionMessage(node, summary.capabilitySummary?.outputKinds || [], graph);
          const providerRequiresExplicitModel = executionMode === 'cloud'
            ? doesProviderOperationRequireExplicitModel(String(node.config?.providerId || '').trim(), operationId)
            : true;
          const requiresExplicitModel = !(executionMode === 'localTool' && (operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE || operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE || operationId === PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM || operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM || operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE))
            && (executionMode !== 'cloud' || providerRequiresExplicitModel);
          if (unsupportedKinds.length) {
            summary.readiness = {
              tone: 'error',
              message: (summary.capabilitySummary?.targetLabel || 'This target') + ' does not accept ' + formatPortKindList(unsupportedKinds) + ' here. This step currently supports ' + formatPortKindList(summary.capabilitySummary?.inputKinds || [PORT_KIND_TEXT]) + '.',
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (requiresExplicitModel && !String(node.config?.model || '').trim()) {
            summary.readiness = {
              tone: 'error',
              message: 'Choose or enter a model for this model step.',
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (outputConnectionMessage) {
            summary.readiness = {
              tone: 'error',
              message: outputConnectionMessage,
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (
            operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
            && connectedKinds.includes(PORT_KIND_IMAGE)
            && !String(node.config?.instruction || '').trim()
          ) {
            summary.readiness = {
              tone: 'error',
              message: 'This video step is using an image input. Add motion guidance in the instruction box before running it.',
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (executionMode === 'cloud') {
            const providerStatus = getSelectedProviderStatus(node.config?.providerId, contextMaps);
            summary.readiness = {
              tone: providerStatus.tone,
              message: providerStatus.message,
            };
            if (providerStatus.tone === 'error') {
              issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
            } else {
              const modelSupport = getModelStepSupportState(node, summary.capabilitySummary, contextMaps, connectedKinds);
              summary.readiness = modelSupport.status === 'unsupported'
                ? {
                    tone: 'error',
                    message: modelSupport.message,
                  }
                : modelSupport.status === 'unknown'
                  ? {
                      tone: 'warn',
                      message: modelSupport.message || providerStatus.message,
                    }
                  : providerStatus.tone === 'warn'
                    ? {
                        tone: 'warn',
                        message: providerStatus.message,
                      }
                    : providerStatus.provider?.lastSuccessfulUseAt && (providerStatus.provider?.lastTestSucceeded === false || !providerStatus.provider?.lastTestedAt)
                      ? {
                          tone: 'info',
                          message: providerStatus.message,
                        }
                    : operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE
                      ? {
                          tone: 'info',
                          message: (providerStatus.provider?.name || 'That provider') + ' will turn the connected text prompt into an image.',
                        }
                      : operationId === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
                        ? connectedKinds.includes(PORT_KIND_IMAGE)
                          ? {
                              tone: 'info',
                              message: (providerStatus.provider?.name || 'That provider') + ' will use the connected image and your motion guidance to render a video.',
                            }
                          : {
                              tone: 'info',
                              message: (providerStatus.provider?.name || 'That provider') + ' will turn the connected prompt into a video artifact.',
                            }
                        : operationId === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
                          ? {
                              tone: 'info',
                              message: (providerStatus.provider?.name || 'That provider') + ' will turn the connected text into a saved audio artifact for the Audio output port.',
                            }
                          : connectedKinds.includes(PORT_KIND_IMAGE)
                            ? {
                                tone: 'info',
                                message: (providerStatus.provider?.name || 'That provider') + ' can read the connected image and return text.',
                              }
                            : {
                                tone: 'info',
                                message: (providerStatus.provider?.name || 'That provider') + ' will return text for this step.',
                              };
              issues.push(buildNodeIssue(node, summary.readiness.tone, summary.readiness.message));
            }
          } else if (executionMode === 'localTool') {
            if (operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE && (Number(node.config?.width || 0) < 256 || Number(node.config?.height || 0) < 256)) {
              summary.readiness = {
                tone: 'error',
                message: 'Use at least 256 by 256 for local image generation in a model step.',
              };
              issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
            } else {
              const ready = analyzeModelStepLocalToolNode(node, summary, contextMaps, connectedKinds, referenceKinds);
              if (!ready || summary.readiness.tone === 'error') {
                issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
              } else {
                const modelSupport = getModelStepSupportState(node, summary.capabilitySummary, contextMaps, connectedKinds);
                if (modelSupport.status === 'unsupported') {
                  summary.readiness = {
                    tone: 'error',
                    message: modelSupport.message,
                  };
                  issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
                } else if (modelSupport.status === 'unknown') {
                  summary.readiness = {
                    tone: 'warn',
                    message: modelSupport.message,
                  };
                  issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
                } else if (summary.readiness.tone === 'warn') {
                  issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
                } else {
                  issues.push(buildNodeIssue(node, 'info', summary.readiness.message));
                }
              }
            }
          } else {
            const ollamaTool = contextMaps.toolsById.ollama || null;
            if (!ollamaTool) {
              summary.readiness = {
                tone: 'error',
                message: 'Install Ollama before using the local model mode in a pipeline.',
              };
              issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
            } else if (String(ollamaTool.status || '').toLowerCase() !== 'running') {
              summary.readiness = {
                tone: 'warn',
                message: 'Ollama is not running yet. Local AI Hub can start it automatically when this pipeline begins.',
              };
              issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
            } else {
              const modelSupport = getModelStepSupportState(node, summary.capabilitySummary, contextMaps, connectedKinds);
              summary.readiness = modelSupport.status === 'unsupported'
                ? {
                    tone: 'error',
                    message: modelSupport.message,
                  }
                : modelSupport.status === 'unknown'
                  ? {
                      tone: 'warn',
                      message: modelSupport.message,
                    }
                  : connectedKinds.includes(PORT_KIND_IMAGE)
                    ? {
                        tone: 'info',
                        message: 'Ollama will read the connected image and return text.',
                      }
                    : {
                        tone: 'info',
                        message: 'Ollama will process this text step locally.',
                      };
              if (summary.readiness.tone === 'error') {
                issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
              } else if (summary.readiness.tone === 'warn') {
                issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
              }
            }
          }
        }
      }

      if (node.type === 'graphWorkflow') {
        const ready = analyzeGraphWorkflowNode(node, graph, summary, contextMaps);
        if (!ready || summary.readiness.tone === 'error') {
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (summary.readiness.tone === 'warn') {
          issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
        } else {
          issues.push(buildNodeIssue(node, 'info', summary.readiness.message));
        }
      }

      if (node.type === 'planningPacket') {
        const sourceKinds = getIncomingKindsForNodePort(node, 'source', graph);
        const goal = String(node.config?.goal || '').trim();
        const sourceSummary = String(node.config?.sourceSummary || '').trim();
        if (!goal) {
          summary.readiness = {
            tone: 'error',
            message: 'Describe the task goal before building this planning packet.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (!sourceKinds.length && !sourceSummary) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect source content or add a manual source summary before building this planning packet.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          const schema = getPlanningSchemaDefinition(node.config?.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
          summary.readiness = {
            tone: 'info',
            message: 'This packet will carry structured planning context for the ' + (schema?.label || 'selected planning schema').toLowerCase() + '.',
          };
          issues.push(buildNodeIssue(node, 'info', summary.readiness.message));
        }
      }

      if (node.type === 'planner') {
        const packetKinds = getIncomingKindsForNodePort(node, 'packet', graph);
        const executionMode = node.config?.executionMode === 'ollama' ? 'ollama' : 'cloud';
        const schema = getPlanningSchemaDefinition(node.config?.schemaId || DEFAULT_PLANNING_SCHEMA_ID);
        const model = String(node.config?.model || '').trim();
        if (!packetKinds.includes(normalizePortKind(PORT_KIND_PLANNING_PACKET))) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect a Planning Packet before running this planner.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (!model) {
          summary.readiness = {
            tone: 'error',
            message: 'Choose or enter a model for this planner.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (executionMode === 'ollama') {
          const ollamaTool = contextMaps.toolsById.ollama || null;
          if (!ollamaTool) {
            summary.readiness = {
              tone: 'error',
              message: 'Install Ollama before using a local planner.',
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (String(ollamaTool.status || '').toLowerCase() !== 'running') {
            summary.readiness = {
              tone: 'warn',
              message: 'Ollama is not running yet. Local AI Hub can start it automatically when this planner runs.',
            };
            issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
          } else {
            summary.readiness = {
              tone: 'info',
              message: 'Ollama will build a structured ' + (schema?.label || 'plan').toLowerCase() + ' inside the selected planning schema contract.',
            };
            issues.push(buildNodeIssue(node, 'info', summary.readiness.message));
          }
        } else {
          const providerStatus = getSelectedProviderStatus(node.config?.providerId, contextMaps);
          if (providerStatus.tone === 'error') {
            summary.readiness = {
              tone: 'error',
              message: providerStatus.message,
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else {
            summary.readiness = {
              tone: providerStatus.tone === 'warn' ? 'warn' : 'info',
              message: providerStatus.tone === 'warn'
                ? providerStatus.message
                : (providerStatus.provider?.name || 'That provider') + ' will build a structured ' + (schema?.label || 'plan').toLowerCase() + ' inside the selected planning schema contract.',
            };
            issues.push(buildNodeIssue(node, summary.readiness.tone, summary.readiness.message));
          }
        }
      }

      if (node.type === 'planScenes') {
        const planKinds = getIncomingKindsForNodePort(node, 'plan', graph);
        if (!planKinds.includes(normalizePortKind(PORT_KIND_PLAN))) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect a structured Plan before building scene text.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          summary.readiness = {
            tone: 'info',
            message: 'This step will turn the connected Plan into an ordered text collection of scene prompt drafts.',
          };
        }
      }

      if (node.type === 'validation') {
        const outgoingEdges = graph.outgoingEdgesByNode.get(node.id) || [];
        const passCount = outgoingEdges.filter((edge) => edge.source.portId === 'pass').length;
        const failCount = outgoingEdges.filter((edge) => edge.source.portId === 'fail').length;
        const connectedKinds = getIncomingKindsForNodePort(node, 'input', graph);
        const validationRequiresExplicitModel = node.config?.llmExecutionMode === 'cloud'
          ? doesProviderOperationRequireExplicitModel(String(node.config?.providerId || '').trim(), PIPELINE_OPERATION_IDS.VALIDATION_LLM)
          : true;
        if (passCount === 0 || failCount === 0) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect both the pass and fail outputs before running this validation step.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (node.config?.mode === 'llm') {
          if (summary.capabilitySummary?.supported === false) {
            summary.readiness = {
              tone: 'error',
              message: summary.capabilitySummary.message,
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else {
            const unsupportedKinds = connectedKinds.filter((kind) => !doesValidationCapabilityAcceptKind(summary.capabilitySummary, kind));
            if (unsupportedKinds.length) {
              summary.readiness = {
                tone: 'error',
                message: (summary.capabilitySummary?.targetLabel || 'This validator') + ' does not accept ' + formatPortKindList(unsupportedKinds) + ' here. This validation step currently supports ' + formatPortKindList(summary.capabilitySummary?.inputKinds || [PORT_KIND_TEXT]) + '.',
              };
              issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
            } else if (!String(node.config?.ruleset || '').trim()) {
              summary.readiness = {
                tone: 'error',
                message: 'Describe the pass and fail rules for this validation step.',
              };
              issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
            } else if (validationRequiresExplicitModel && !String(node.config?.model || '').trim()) {
              summary.readiness = {
                tone: 'error',
                message: 'Choose or enter a model for this validator.',
              };
              issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
            } else if (node.config?.llmExecutionMode === 'ollama') {
              const ollamaTool = contextMaps.toolsById.ollama || null;
              if (!ollamaTool) {
                summary.readiness = {
                  tone: 'error',
                  message: 'Install Ollama before using a local validator.',
                };
                issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
              } else if (String(ollamaTool.status || '').toLowerCase() !== 'running') {
                summary.readiness = {
                  tone: 'warn',
                  message: 'Ollama is not running yet. Local AI Hub can start it automatically when this validator runs.',
                };
                issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
              } else {
                const modelSupport = getValidationModalitySupportState(node, summary.capabilitySummary, contextMaps, connectedKinds);
                summary.readiness = modelSupport.status === 'unsupported'
                  ? {
                      tone: 'error',
                      message: modelSupport.message,
                    }
                  : modelSupport.status === 'unknown' || modelSupport.status === 'limited'
                    ? {
                        tone: 'warn',
                        message: modelSupport.message,
                      }
                    : {
                        tone: 'info',
                        message: getValidationReadyMessage('Ollama', summary.capabilitySummary, connectedKinds),
                      };
                if (summary.readiness.tone === 'error') {
                  issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
                } else if (summary.readiness.tone === 'warn') {
                  issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
                }
              }
            } else {
              const providerStatus = getSelectedProviderStatus(node.config?.providerId, contextMaps);
              summary.readiness = {
                tone: providerStatus.tone,
                message: providerStatus.message,
              };
              if (providerStatus.tone === 'error') {
                issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
              } else {
                const modelSupport = getValidationModalitySupportState(node, summary.capabilitySummary, contextMaps, connectedKinds);
                summary.readiness = modelSupport.status === 'unsupported'
                  ? {
                      tone: 'error',
                      message: modelSupport.message,
                    }
                  : modelSupport.status === 'unknown' || modelSupport.status === 'limited'
                    ? {
                        tone: 'warn',
                        message: modelSupport.message,
                      }
                    : {
                        tone: 'info',
                        message: getValidationReadyMessage(providerStatus.provider?.name || 'That provider', summary.capabilitySummary, connectedKinds),
                      };
                if (summary.readiness.tone === 'error') {
                  issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
                } else if (summary.readiness.tone === 'warn') {
                  issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
                }
              }
            }
          }
        } else {
          summary.readiness = {
            tone: 'info',
            message: 'This run will pause here, show the connected artifact preview when possible, and wait for your pass or fail decision.',
          };
        }
      }

      if (node.type === 'retryLoop') {
        const loopIssues = graph.retryLoopIssuesByNodeId.get(node.id) || [];
        const loopMeta = graph.retryLoopsByNodeId.get(node.id) || null;
        if (loopIssues.length) {
          summary.readiness = {
            tone: 'error',
            message: loopIssues[0],
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (loopMeta) {
          summary.readiness = {
            tone: 'info',
            message: buildRetryLoopReadinessMessage(node, loopMeta),
          };
        }
      }

      if (node.type === 'branchMerge') {
        const branchPort = getPortDefinition(node.type, 'input', 'branch');
        const branchEdges = graph.incomingEdgesByPortKey.get(node.id + ':branch') || [];
        const retryEntryMeta = getRetryLoopEntryMetadata(graph, node.id);
        const minimumConnections = retryEntryMeta ? 1 : Math.max(2, Number(branchPort?.minimumConnections || 0) || 0);
        const connectedKinds = getIncomingKindsForNodePort(node, 'branch', graph);
        if (branchEdges.length < minimumConnections) {
          summary.readiness = {
            tone: 'error',
            message: retryEntryMeta
              ? 'Connect at least one upstream branch before running this merge. Later retry attempts will feed the loop artifact back in automatically.'
              : 'Connect both sides of the branch before running this merge step.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (!connectedKinds.length) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect branches that all carry the same artifact type before running this merge step.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          summary.readiness = {
            tone: 'info',
            message: retryEntryMeta
              ? 'This merge forwards its connected branch on the first attempt, then switches to the loop retry artifact on later attempts.'
              : 'This merge waits for earlier branches to finish or skip, then forwards the single branch that stayed active.',
          };
        }
      }

      if (node.type === 'collectionMap') {
        const connectedKinds = getIncomingKindsForNodePort(node, 'collection', graph);
        const executionMode = getCollectionMapExecutionMode(node);
        const operationId = getCollectionMapOperationId(node);
        if (!isSupportedCollectionMapOperation(node)) {
          summary.readiness = {
            tone: 'error',
            message: 'Map Collection currently supports text collection to image collection only. Choose Image generation or use another explicit pipeline step.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (!connectedKinds.includes(createCollectionPortKind(PORT_KIND_TEXT))) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect an ordered text collection before mapping it through image generation.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (executionMode === 'graphWorkflow') {
          const ready = analyzeCollectionMapGraphWorkflowNode(node, summary, contextMaps);
          if (!ready || summary.readiness.tone === 'error') {
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else if (summary.readiness.tone === 'warn') {
            issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
          } else {
            issues.push(buildNodeIssue(node, 'info', summary.readiness.message));
          }
        } else if (executionMode === 'localTool') {
          if (Number(node.config?.width || 0) < 256 || Number(node.config?.height || 0) < 256) {
            summary.readiness = {
              tone: 'error',
              message: 'Use at least 256 by 256 for mapped local image generation.',
            };
            issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
          } else {
            const ready = analyzeImageToolNode(node, summary, contextMaps);
            if (!ready || summary.readiness.tone === 'error') {
              issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
            } else if (summary.readiness.tone === 'warn') {
              issues.push(buildNodeIssue(node, 'warn', summary.readiness.message));
            } else {
              summary.readiness = {
                tone: 'info',
                message: summary.readiness.message + ' Map Collection will generate one image for each text item and keep the original order.',
              };
              issues.push(buildNodeIssue(node, 'info', summary.readiness.message));
            }
          }
        } else if (summary.capabilitySummary?.supported === false) {
          summary.readiness = {
            tone: 'error',
            message: summary.capabilitySummary.message,
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (doesProviderOperationRequireExplicitModel(String(node.config?.providerId || '').trim(), operationId) && !String(node.config?.model || '').trim()) {
          summary.readiness = {
            tone: 'error',
            message: 'Choose or enter an image model before mapping this text collection.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          const providerStatus = getSelectedProviderStatus(node.config?.providerId, contextMaps);
          summary.readiness = providerStatus.tone === 'good'
            ? {
                tone: 'info',
                message: (providerStatus.provider?.name || 'That provider') + ' will generate one image for each text item and keep the original collection order.',
              }
            : {
                tone: providerStatus.tone,
                message: providerStatus.message,
              };
          issues.push(buildNodeIssue(node, summary.readiness.tone, summary.readiness.message));
        }
      }
      if (node.type === 'collectionBuilder') {
        const itemEdges = graph.incomingEdgesByPortKey.get(node.id + ':items') || [];
        const itemKinds = getIncomingKindsForNodePort(node, 'items', graph).filter((kind) => !isCollectionPortKind(kind));
        const existingKinds = getIncomingKindsForNodePort(node, 'existing', graph);
        const existingItemKinds = uniqueKindList(existingKinds.map((kind) => getCollectionItemKind(kind)).filter(Boolean));
        if (!itemEdges.length) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect at least one upstream item before running this collection builder.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (!itemKinds.length) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect single artifacts that all share the same type before building a collection.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (existingItemKinds.length && !existingItemKinds.includes(itemKinds[0])) {
          summary.readiness = {
            tone: 'error',
            message: 'The Existing Collection input must use the same item type as the connected Items input.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          const orderLabel = String(node.config?.insertionMode || '').trim() === 'prepend' ? 'before' : 'after';
          summary.readiness = {
            tone: 'info',
            message: 'This builder keeps the Items connections in order and places them ' + orderLabel + ' the existing collection when one is connected.',
          };
        }
      }

      if (node.type === 'collectionAccumulator') {
        const accumulatorIssues = graph.collectionAccumulatorIssuesByNodeId.get(node.id) || [];
        const accumulatorMeta = graph.collectionAccumulatorsByNodeId.get(node.id) || null;
        if (accumulatorIssues.length) {
          summary.readiness = {
            tone: 'error',
            message: accumulatorIssues[0],
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else if (accumulatorMeta) {
          summary.readiness = {
            tone: 'info',
            message: buildCollectionAccumulatorReadinessMessage(node, accumulatorMeta),
          };
        }
      }

      if (node.type === 'collectionOutput') {
        const collectionKinds = getIncomingKindsForNodePort(node, 'collection', graph);
        if (!collectionKinds.length) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect a typed collection before running this output step.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          summary.readiness = {
            tone: 'info',
            message: 'This output saves an ordered collection manifest and keeps the item order explicit in the run folder.',
          };
        }
      }

      if (node.type === 'planOutput') {
        const planKinds = getIncomingKindsForNodePort(node, 'plan', graph);
        if (!planKinds.includes(PORT_KIND_PLAN)) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect a structured Plan before running this output step.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          summary.readiness = {
            tone: 'info',
            message: 'This output saves the structured plan JSON and keeps it inspectable in the run folder.',
          };
        }
      }

      if (node.type === 'mediaComposition') {
        const visualKinds = getIncomingKindsForNodePort(node, 'visuals', graph);
        if (!visualKinds.length) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect an ordered image collection before building this media composition.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          summary.readiness = {
            tone: 'info',
            message: 'This step keeps the visual collection order explicit and can attach one primary audio track plus one optional background music track before export.',
          };
        }
      }

      if (node.type === 'mediaExport') {
        const compositionKinds = getIncomingKindsForNodePort(node, 'composition', graph);
        if (!compositionKinds.length) {
          summary.readiness = {
            tone: 'error',
            message: 'Connect a media composition before running this export step.',
          };
          issues.push(buildNodeIssue(node, 'error', summary.readiness.message));
        } else {
          summary.readiness = {
            tone: 'info',
            message: 'This export renders the connected composition to a video artifact through the shared ffmpeg-backed export path.',
          };
        }
      }
    }

    const compatibilityEntry = getCompatibilityEntry(node, contextMaps);
    if (compatibilityEntry?.profile) {
      const compatibility = evaluateCompatibilityProfile(compatibilityEntry.profile, contextMaps.hardware);
      summary.compatibility = {
        ...compatibility,
        source: compatibilityEntry.catalogTool?.name || compatibilityEntry.requiredToolId,
      };
      compatibilityEntries.push({
        ...summary.compatibility,
        nodeId: node.id,
        nodeLabel: node.label,
      });
      localHeavyNodeIds.push(node.id);
    }

    nodeSummaries[node.id] = summary;
  }

  if (localHeavyNodeIds.length > 1) {
    issues.push({
      tone: compatibilityEntries.some((entry) => entry.tone === 'warn' || entry.tone === 'danger') ? 'warn' : 'info',
      message: `This workflow includes ${localHeavyNodeIds.length} local tool steps. Local AI Hub will still run them one at a time.`,
    });
  }

  const highestCompatibility = compatibilityEntries.reduce((current, entry) => {
    if (!current || compareIssueSeverity(entry.tone, current.tone) > 0) {
      return entry;
    }

    return current;
  }, null);

  let compatibilitySummary = null;
  if (!compatibilityEntries.length) {
    compatibilitySummary = {
      tone: 'good',
      label: 'Flexible typed flow',
      message: 'This workflow currently depends on text, file, or cloud steps more than a heavy local GPU run.',
    };
  } else if (highestCompatibility) {
    compatibilitySummary = {
      tone: highestCompatibility.tone,
      label: highestCompatibility.label,
      message: `${highestCompatibility.nodeLabel}: ${highestCompatibility.message}`,
    };
  }

  const highestIssue = issues.reduce((current, issue) => {
    if (!current || compareIssueSeverity(issue.tone, current.tone) > 0) {
      return issue;
    }

    return current;
  }, null);

  return {
    pipeline: graph.pipeline,
    executable: !issues.some((issue) => issue.tone === 'error') && graph.executionOrder.length > 0,
    issues,
    nodeSummaries,
    compatibilitySummary,
    executionOrder: graph.executionOrder,
    reachableNodeIds: [...graph.reachableNodeIds],
    terminalNodeIds: graph.terminalNodeIds,
    retainedResultNodeIds: [...graph.retainedResultNodeIds],
    primaryIssue: highestIssue,
  };
}

module.exports = {
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_NODE_TYPES,
  NODE_TYPE_LIST,
  GRAPH_WORKFLOW_TOOL_IDS,
  GRAPH_WORKFLOW_OPERATION_BACKEND_IDS,
  IMAGE_WORKFLOW_TOOL_IDS,
  PIPELINE_OPERATION_IDS,
  PIPELINE_PORT_KIND_LABELS,
  PIPELINE_RETRY_LOOP_MAX_ATTEMPTS,
  AUDIO_WORKFLOW_TOOL_IDS,
  AUDIO_TRANSFORM_TOOL_IDS,
  IMAGE_TRANSFORM_TOOL_IDS,
  PORT_KIND_ANY,
  PORT_KIND_AUDIO,
  PORT_KIND_AUDIO_FILE,
  PORT_KIND_COLLECTION,
  PORT_KIND_COMPOSITION,
  PORT_KIND_FILE,
  PORT_KIND_IMAGE,
  PORT_KIND_PLANNING_PACKET,
  PORT_KIND_PLAN,
  PORT_KIND_PREVIEW,
  PORT_KIND_AUDIT,
  PORT_KIND_PASSTHROUGH,
  PORT_KIND_TEXT,
  PORT_KIND_VIDEO,
  SUPPORTED_PORT_KINDS,
  createCollectionPortKind,
  formatPortKindLabel,
  DEFAULT_PLANNING_SCHEMA_ID,
  getCollectionItemKind,
  isCollectionPortKind,
  VIDEO_WORKFLOW_TOOL_IDS,
  WHISPER_MODELS,
  analyzePipeline,
  arePortsCompatible,
  buildContextMaps,
  buildPipelineGraph,
  cloneValue,
  compareIssueSeverity,
  createEdge,
  createEmptyPipeline,
  createNode,
  createUniqueId,
  evaluateCompatibilityProfile,
  getDefaultGraphWorkflowBindings,
  getDefaultNodeConfig,
  getGraphWorkflowContract,
  getGraphWorkflowFieldOptions,
  getGraphWorkflowInputBinding,
  getGraphWorkflowNodeEntry,
  getGraphWorkflowOutputBinding,
  getGraphWorkflowOutputNodeOptions,
  getGraphWorkflowOperationBackendSupport,
  getGraphWorkflowToolId,
  getImageToolIdForNode,
  getDefaultImageTransformSubtype,
  getImageTransformSubtypeLabel,
  getImageTransformSubtypeOptions,
  selectLocalImageBackend,
  getLocalImageCheckpointModels,
  getLocalImageBackendOperationId,
  getLocalToolRequirement,
  getModelStepExecutionMode,
  getPipelineNodePorts,
  getModelStepLocalToolId,
  getModelStepOperationId,
  getNodeTypeDefinition,
  getPlanningSchemaDefinition,
  getPlanningSchemaOptions,
  getPortAllowedKinds,
  getPortDefinition,
  getSupportedPortKinds,
  normalizeImageTransformSubtype,
  normalizePipelineDefinition,
  normalizePortKind,
  parseGraphWorkflowDefinitionText,
  resolveOutputKinds,
  trimPreviewText,
};

module.exports.default = module.exports;
