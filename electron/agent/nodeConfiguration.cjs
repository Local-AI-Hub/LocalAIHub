const { fault } = require('./bridge.cjs');
const { normalizeRvcInference, RVC_PARAMETERS, RVC_PITCH_METHODS } = require('../shared/rvcInference.cjs');
const { getOperationDrivenToolIdsForPipelineOperation, getProviderIdsForPipelineOperation, getToolPipelineOperation, getProviderPipelineOperation } = require('../shared/pipelineCapabilities.cjs');

const cloudInference = {
  temperature: { type: 'number', minimum: 0, description: 'Supported range depends on the provider and model.' },
  topP: { type: 'number', minimum: 0, maximum: 1 },
  maxOutputTokens: { type: 'integer', minimum: 128, maximum: 8192 },
};
const chatterboxOptions = {
  temperature: { type: 'number', minimum: 0 },
  top_k: { type: 'integer', minimum: 0 }, top_p: { type: 'number', minimum: 0, maximum: 1 },
  repetition_penalty: { type: 'number', minimum: 0 }, norm_loudness: { type: 'boolean' },
};
const rvcInference = { pitchMethod: { type: 'string', enum: RVC_PITCH_METHODS, default: 'rmvpe' } };
for (const [key, spec] of Object.entries(RVC_PARAMETERS)) {
  rvcInference[key] = { type: spec.step === 1 ? 'integer' : 'number', minimum: spec.min, maximum: spec.max, default: spec.defaultValue };
}

function fields(defaults) {
  const properties = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (key === 'rvcInference') properties[key] = { type: 'object', description: 'RVC audioTransform settings.', properties: rvcInference, additionalProperties: false };
    else if (key === 'cloudInference') properties[key] = { type: 'object', description: 'Cloud text generation or LLM review. Omit settings to use provider defaults. Model support varies.', properties: cloudInference, additionalProperties: false };
    else if (key === 'whisperOptions') properties[key] = { type: 'object', description: 'Native faster-whisper transcribe keyword options. VAD defaults to enabled. Omit language for automatic detection.', examples: [{ language: 'en', task: 'transcribe', temperature: 0, beam_size: 5, vad_filter: false, initial_prompt: 'Names and terminology' }] };
    else if (key === 'chatterboxOptions') properties[key] = { type: 'object', description: 'Chatterbox-Turbo reference voice generation.', properties: chatterboxOptions, additionalProperties: false };
    else if (key === 'ollamaOptions') properties[key] = { type: 'object', description: 'Native Ollama chat options, using backend names.', examples: [{ temperature: 0, top_k: 40, top_p: 0.9, seed: 42, num_predict: 256, repeat_penalty: 1.1 }] };
    else if (Array.isArray(value)) properties[key] = { type: 'array', default: value };
    else if (value && typeof value === 'object') properties[key] = { type: 'object', properties: fields(value) };
    else properties[key] = { type: typeof value, default: value };
  }
  return properties;
}

function checkSettings(config, location) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fault('INVALID_PIPELINE', location + ' must be an object.');
  for (const [key, specs] of Object.entries({ cloudInference, rvcInference, chatterboxOptions, whisperOptions: null, ollamaOptions: null })) {
    if (!Object.hasOwn(config, key)) continue;
    const settings = config[key];
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw fault('INVALID_PIPELINE', location + '.' + key + ' must be an object.');
    if (!specs) continue;
    for (const [name, value] of Object.entries(settings)) {
      const spec = Object.hasOwn(specs, name) && specs[name];
      const valid = spec && (spec.enum ? spec.enum.includes(value)
        : spec.type === 'boolean' ? typeof value === 'boolean'
        : Number.isFinite(value) && !(value < spec.minimum || value > spec.maximum) && (spec.type !== 'integer' || Number.isInteger(value)));
      if (!valid) {
        throw fault('INVALID_PIPELINE', 'Check ' + location + '.' + key + '.' + name + ' against hub_node_types.');
      }
    }
  }
}

function checkNodeConfig(type, config, location) {
  checkSettings(config, location);
  if (type === 'collectionMap' && Object.hasOwn(config, 'perItemValidation')) checkSettings(config.perItemValidation, location + '.perItemValidation');
}

function getConfiguredPorts(schema, sampleNode) {
  let outputKinds;
  if (sampleNode.type === 'llmPrompt') {
    const operation = schema.getModelStepOperationId(sampleNode);
    const mode = schema.getModelStepExecutionMode(sampleNode);
    const toolId = mode === 'ollama' ? 'ollama' : schema.getModelStepLocalToolId(sampleNode);
    const capability = mode === 'cloud'
      ? getProviderPipelineOperation(sampleNode.config.providerId || getProviderIdsForPipelineOperation(operation)[0], operation)
      : getToolPipelineOperation(toolId || getOperationDrivenToolIdsForPipelineOperation(operation)[0], operation);
    outputKinds = capability?.outputKinds;
  }
  const ports = direction => schema.getPipelineNodePorts(sampleNode, direction).filter(port =>
    (!port.dynamicOnly || schema.getPortAllowedKinds(port, { direction, node: sampleNode }).length)
    && (direction !== 'output' || !outputKinds || outputKinds.includes(port.kind))
  );
  return { inputs: ports('input'), outputs: ports('output') };
}

function describeNode(schema, entry, config) {
  checkNodeConfig(entry.type, config, 'config');
  const sampleNode = schema.createNode(entry.type, { config });
  const properties = fields(entry.configDefaults);
  const enums = {
    workflowSource: ['local', 'preset'], videoOperationMode: ['auto', 'textToVideo', 'imageToVideo'],
    retryTerminationAction: ['fail', 'complete'], insertionMode: ['append', 'prepend'],
    failureMode: ['fail-fast', 'partial'], channels: ['stereo', 'mono'], sizeMode: ['matchFirst', 'custom'],
    framePosition: ['first', 'last', 'timestamp'], fitMode: ['contain', 'cover'], stopMode: ['shortest', 'visuals'],
    compositionMode: Object.values(schema.MEDIA_COMPOSITION_MODES),
    sceneTransitionMode: Object.values(schema.MEDIA_COMPOSITION_TRANSITION_MODES),
    soundEffectsSchedulingMode: Object.values(schema.MEDIA_COMPOSITION_SOUND_EFFECTS_SCHEDULING_MODES),
    soundEffectsDensity: schema.MEDIA_COMPOSITION_SOUND_EFFECTS_DENSITIES,
    itemType: ['text', 'image', 'audio', 'video', 'file'],
  };
  for (const [key, values] of Object.entries(enums)) if (properties[key]) properties[key].enum = values;
  const choices = {};
  if (properties.rvcInference) {
    const operationIds = new Set(schema.COLLECTION_MAP_MAPPING_OPTIONS.map(mapping => mapping.operationId));
    if (entry.type === 'llmPrompt') operationIds.add(schema.PIPELINE_OPERATION_IDS.LLM_PROMPT);
    choices.operations = [...operationIds].map(operationId => ({
      operationId, toolIds: getOperationDrivenToolIdsForPipelineOperation(operationId), providerIds: getProviderIdsForPipelineOperation(operationId),
    })).filter(option => option.toolIds.length || option.providerIds.length);
    choices.audioModes = Object.fromEntries(schema.AUDIO_WORKFLOW_TOOL_IDS.map(id => [id, schema.getAudioModeOptionsForLocalTool(id)]));
    choices.imageTransforms = Object.fromEntries(schema.IMAGE_TRANSFORM_TOOL_IDS.map(id => [id, schema.getImageTransformSubtypeOptions(id)]));
    choices.whisperModels = schema.WHISPER_MODELS;
    if (sampleNode.config.toolId === 'rvc') sampleNode.config.rvcInference = normalizeRvcInference(sampleNode.config.rvcInference);
  }
  if (entry.type === 'collectionMap') choices.mappings = schema.COLLECTION_MAP_MAPPING_OPTIONS;
  if (entry.type === 'recordInput') choices.recordingModes = schema.RECORD_INPUT_MODE_OPTIONS;
  if (properties.schemaId) choices.planningSchemas = schema.getPlanningSchemaOptions().map(({ id, label }) => ({ id, label }));
  if (entry.type === 'mediaComposition') choices.transitions = schema.MEDIA_COMPOSITION_TRANSITION_CATEGORIES;
  if (entry.type === 'collectionInput') properties.items.description = 'Ordered objects. Set text for text items or filePath for media and files.';
  if (entry.type === 'recordInput') properties.captureTarget.examples = [{ type: 'desktop' }, { type: 'region', displayId: 'DISPLAY_ID', x: 0, y: 0, width: 640, height: 480 }];
  if (entry.type === 'graphWorkflow') choices.graphWorkflow = schema.getGraphWorkflowContract(schema.getGraphWorkflowToolId(sampleNode));
  if (properties.graphWorkflowPresetId) properties.graphWorkflowPresetId.description = 'Use hub_discovery presets to select a saved graph workflow.';
  const { inputs, outputs } = getConfiguredPorts(schema, sampleNode);
  const describePorts = (ports, direction) => ports.map(port => ({
    ...port, allowedKinds: schema.getPortAllowedKinds(port, { direction, node: sampleNode }),
  }));
  return { ...entry, sampleNode, configSchema: { type: 'object', properties }, choices, configuredPorts: { inputs: describePorts(inputs, 'input'), outputs: describePorts(outputs, 'output') } };
}

module.exports = { checkNodeConfig, describeNode, getConfiguredPorts };
