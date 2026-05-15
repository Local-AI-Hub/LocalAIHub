const {
  GRAPH_WORKFLOW_TOOL_IDS,
  DEFAULT_PLANNING_SCHEMA_ID,
  IMAGE_WORKFLOW_TOOL_IDS,
  PIPELINE_OPERATION_IDS,
  PORT_KIND_IMAGE,
  PORT_KIND_TEXT,
  analyzePipeline,
  buildContextMaps,
  buildGraphWorkflowConfigFromPreset,
  createEdge,
  createEmptyPipeline,
  createNode,
  evaluateCompatibilityProfile,
  isGraphWorkflowPresetCompatibleWithOperation,
  normalizePipelineDefinition,
} = require('./pipelineSchema.cjs');

const {
  getProviderIdsForPipelineOperation,
  getProviderPipelineOperation,
  getToolPipelineOperation,
} = require('./pipelineCapabilities.cjs');

const TEMPLATE_STATUS = Object.freeze({
  READY: 'ready',
  CONFIGURABLE: 'configurable',
  MISSING_REQUIREMENTS: 'missing-requirements',
  UNAVAILABLE: 'unavailable',
});

function cloneValue(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function normalizeId(value) { return String(value || '').trim().toLowerCase(); }
function unique(values = []) { return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]; }
function titleFromId(value) { return String(value || '').split(/[-_\s]+/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '); }
function getTool(contextMaps, toolId) { return contextMaps.toolsById?.[normalizeId(toolId)] || null; }
function getCatalogTool(contextMaps, toolId) { return contextMaps.toolCatalogById?.[normalizeId(toolId)] || getTool(contextMaps, toolId) || null; }
function toolLabel(contextMaps, toolId) { const tool = getTool(contextMaps, toolId) || getCatalogTool(contextMaps, toolId); return String(tool?.name || tool?.label || tool?.id || titleFromId(toolId) || 'Local tool').trim(); }
function providerLabel(contextMaps, providerId) { const provider = contextMaps.providersById?.[normalizeId(providerId)] || null; return String(provider?.name || provider?.label || provider?.id || titleFromId(providerId) || 'Cloud provider').trim(); }
function providerConnected(provider) { return Boolean(provider && provider.isConnected === true); }
function providerIdsForOperation(operationId, contextMaps, candidates = []) { return (candidates.length ? candidates : getProviderIdsForPipelineOperation(operationId)).map(normalizeId).filter((id) => providerConnected(contextMaps.providersById?.[id]) && getProviderPipelineOperation(id, operationId)); }
function toolUsable(tool) { const status = normalizeId(tool?.status); return Boolean(tool && status !== 'error' && tool.launchSupported !== false); }
function toolIdsForOperation(operationId, contextMaps, candidates = []) { return candidates.map(normalizeId).filter((id) => toolUsable(getTool(contextMaps, id)) && getToolPipelineOperation(id, operationId)); }
function chooseTarget(operationId, contextMaps, options = {}) {
  const localToolIds = Array.isArray(options.localToolIds) ? options.localToolIds : [];
  const providerIds = Array.isArray(options.providerIds) ? options.providerIds : [];
  const localToolId = localToolIds.length ? toolIdsForOperation(operationId, contextMaps, localToolIds)[0] || '' : '';
  const providerId = providerIdsForOperation(operationId, contextMaps, providerIds)[0] || '';
  if (options.preferLocal !== false && localToolId) return { executionMode: 'localTool', providerId: '', toolId: localToolId, model: '' };
  if (providerId) return { executionMode: 'cloud', providerId, toolId: '', model: '' };
  if (localToolId) return { executionMode: 'localTool', providerId: '', toolId: localToolId, model: '' };
  return { executionMode: options.fallbackExecutionMode || 'cloud', providerId: '', toolId: options.fallbackToolId || '', model: '' };
}
function pos(index, y = 0) { return { x: 96 + index * 300, y: 132 + y + (index % 2) * 42 }; }
function node(type, index, config = {}, label = '', y = 0) { return createNode(type, { ...(label ? { label } : {}), config, position: pos(index, y) }); }
function link(edges, source, sourcePort, target, targetPort) { edges.push(createEdge(source.id, sourcePort, target.id, targetPort)); }
function stepConfig(operationId, target, config = {}) { return { executionMode: target.executionMode || 'cloud', operationId, providerId: target.executionMode === 'cloud' ? target.providerId || '' : '', toolId: target.executionMode === 'localTool' ? target.toolId || '' : '', model: target.model || '', ...config }; }
function mapConfig(operationId, mappingId, target, config = {}) {
  return {
    mappingId,
    operationId,
    executionMode: target.executionMode || 'cloud',
    providerId: target.executionMode === 'cloud' ? target.providerId || '' : '',
    toolId: target.executionMode === 'localTool' ? target.toolId || '' : '',
    model: '',
    instruction: operationId === PIPELINE_OPERATION_IDS.IMAGE_GENERATE ? 'Generate one image for each text item while preserving the source order.' : 'Transform each image while preserving the source order.',
    failureMode: 'fail-fast',
    imageSize: '1024x1024',
    imageQuality: 'auto',
    imageBackground: 'auto',
    promptStyleId: '',
    width: 832,
    height: 832,
    steps: 24,
    cfgScale: 7,
    seed: -1,
    transformSubtype: operationId === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM ? 'upscale' : '',
    scale: 4,
    perItemValidation: { enabled: false, mode: 'llm', llmExecutionMode: 'cloud', providerId: '', model: '', ruleset: '', systemPrompt: '', maxAttempts: 2, retryInstruction: '', failMode: 'fail-fast' },
    ...config,
  };
}
function finalize(template, nodes, edges, extra = '') {
  return normalizePipelineDefinition(createEmptyPipeline({
    name: template.name,
    description: [template.description, extra, ...(template.nextSteps || []).map((step) => 'Next: ' + step), 'Created from the built-in Local AI Hub starter template. This is a normal editable pipeline after creation.'].filter(Boolean).join('\n\n'),
    nodes,
    edges,
  }));
}
function textResponse(template, contextMaps) {
  const target = chooseTarget(PIPELINE_OPERATION_IDS.LLM_PROMPT, contextMaps, { localToolIds: ['ollama'], preferLocal: false });
  if (!target.providerId && getTool(contextMaps, 'ollama')) target.executionMode = 'ollama';
  const edges = [];
  const a = node('textInput', 0, { text: '' }, 'Prompt');
  const b = node('llmPrompt', 1, stepConfig(PIPELINE_OPERATION_IDS.LLM_PROMPT, target, { instruction: 'Answer the connected prompt clearly and directly.' }), 'Model response');
  const c = node('textOutput', 2, { title: 'Text response' }, 'Text output');
  link(edges, a, 'text', b, 'prompt'); link(edges, b, 'text', c, 'text');
  return finalize(template, [a, b, c], edges);
}
function imageDescription(template, contextMaps) {
  const target = chooseTarget(PIPELINE_OPERATION_IDS.IMAGE_ANALYZE, contextMaps, { localToolIds: IMAGE_WORKFLOW_TOOL_IDS, preferLocal: false });
  const edges = [];
  const a = node('imageInput', 0, {}, 'Source image');
  const b = node('llmPrompt', 1, stepConfig(PIPELINE_OPERATION_IDS.IMAGE_ANALYZE, target, { analysisMode: 'clip', instruction: 'Describe the important visible details in the connected image.' }), 'Describe image');
  const c = node('textOutput', 2, { title: 'Image description' }, 'Text output');
  link(edges, a, 'image', b, 'prompt'); link(edges, b, 'text', c, 'text');
  return finalize(template, [a, b, c], edges);
}
function textToImage(template, contextMaps) {
  const target = chooseTarget(PIPELINE_OPERATION_IDS.IMAGE_GENERATE, contextMaps, { fallbackExecutionMode: 'localTool', fallbackToolId: IMAGE_WORKFLOW_TOOL_IDS[0] || 'forge', localToolIds: IMAGE_WORKFLOW_TOOL_IDS, preferLocal: true });
  const edges = [];
  const a = node('textInput', 0, { text: '' }, 'Image prompt');
  const b = node('llmPrompt', 1, stepConfig(PIPELINE_OPERATION_IDS.IMAGE_GENERATE, target, { instruction: 'Generate one image from the connected prompt. Leave checkpoint and detailed image settings editable.', imageSize: '1024x1024', imageQuality: 'auto', imageBackground: 'auto', width: 832, height: 832, steps: 24, cfgScale: 7, seed: -1, negativePrompt: '', promptStyleId: '' }), 'Generate image');
  const c = node('imageOutput', 2, { title: 'Generated image' }, 'Image output');
  link(edges, a, 'text', b, 'prompt'); link(edges, b, 'image', c, 'image');
  return finalize(template, [a, b, c], edges);
}
function promptCollectionImages(template, contextMaps, options = {}) {
  const target = chooseTarget(PIPELINE_OPERATION_IDS.IMAGE_GENERATE, contextMaps, { fallbackExecutionMode: 'localTool', fallbackToolId: IMAGE_WORKFLOW_TOOL_IDS[0] || 'forge', localToolIds: IMAGE_WORKFLOW_TOOL_IDS, preferLocal: true });
  const perItemValidation = options.userValidation ? { enabled: true, mode: 'user', llmExecutionMode: 'cloud', providerId: '', model: '', ruleset: 'Pass images that match the source prompt well enough to keep. Fail images with obvious artifacts, mismatched content, or unusable composition.', systemPrompt: '', maxAttempts: 2, retryInstruction: 'Revise the source prompt for this item and try again.', failMode: options.partialSuccess ? 'partial' : 'fail-fast' } : undefined;
  const edges = [];
  const a = node('collectionInput', 0, { itemType: PORT_KIND_TEXT, items: [] }, 'Prompt collection');
  const b = node('collectionMap', 1, mapConfig(PIPELINE_OPERATION_IDS.IMAGE_GENERATE, 'textToImage', target, { failureMode: options.partialSuccess ? 'partial' : 'fail-fast', perItemValidation }), options.userValidation ? 'Generate and review each image' : 'Generate image collection');
  const c = node('collectionOutput', 2, { title: 'Image collection' }, 'Collection output');
  link(edges, a, 'collection', b, 'collection'); link(edges, b, 'collection', c, 'collection');
  return finalize(template, [a, b, c], edges);
}
function audioTranscription(template) {
  const edges = [];
  const a = node('audioInput', 0, {}, 'Source audio');
  const b = node('llmPrompt', 1, stepConfig(PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE, { executionMode: 'localTool', toolId: 'whisper', model: 'base' }, { instruction: 'Transcribe the connected audio file into text.' }), 'Transcribe audio');
  const c = node('textOutput', 2, { title: 'Transcript' }, 'Transcript output');
  link(edges, a, 'audio', b, 'prompt'); link(edges, b, 'text', c, 'text');
  return finalize(template, [a, b, c], edges);
}
function textToAudio(template) {
  const edges = [];
  const a = node('textInput', 0, { text: '' }, 'Audio prompt');
  const b = node('llmPrompt', 1, stepConfig(PIPELINE_OPERATION_IDS.AUDIO_GENERATE, { executionMode: 'localTool', toolId: 'audiocraft-webui' }, { instruction: 'Generate a short music or sound bed from the connected prompt.', audioMode: 'music', durationSeconds: 8, audiocraftTemperature: 1, audiocraftTopK: 250, audiocraftTopP: 0, audiocraftCfgCoef: 3, audiocraftTwoStepCfg: false }), 'Generate audio');
  const c = node('audioOutput', 2, { title: 'Generated audio' }, 'Audio output');
  link(edges, a, 'text', b, 'prompt'); link(edges, b, 'audio', c, 'audio');
  return finalize(template, [a, b, c], edges);
}
function audioContinuation(template) {
  const edges = [];
  const a = node('audioInput', 0, {}, 'Source audio');
  const b = node('llmPrompt', 1, stepConfig(PIPELINE_OPERATION_IDS.AUDIO_GENERATE, { executionMode: 'localTool', toolId: 'audiocraft-webui' }, { instruction: 'Continue the connected audio from its ending while preserving the general style.', audioMode: 'continuation', continuationSeedSeconds: 12, appendSource: true, durationSeconds: 8, audiocraftTemperature: 1, audiocraftTopK: 250, audiocraftTopP: 0, audiocraftCfgCoef: 3, audiocraftTwoStepCfg: false }), 'Continue audio');
  const c = node('audioOutput', 2, { title: 'Continued audio' }, 'Audio output');
  link(edges, a, 'audio', b, 'prompt'); link(edges, b, 'audio', c, 'audio');
  return finalize(template, [a, b, c], edges);
}
function voiceoverSlideshowVideo(template, contextMaps) {
  const plannerTarget = chooseTarget(PIPELINE_OPERATION_IDS.LLM_PROMPT, contextMaps, { localToolIds: ['ollama'], preferLocal: false });
  if (!plannerTarget.providerId && getTool(contextMaps, 'ollama')) plannerTarget.executionMode = 'ollama';
  const imageTarget = chooseTarget(PIPELINE_OPERATION_IDS.IMAGE_GENERATE, contextMaps, { fallbackExecutionMode: 'localTool', fallbackToolId: IMAGE_WORKFLOW_TOOL_IDS[0] || 'forge', localToolIds: IMAGE_WORKFLOW_TOOL_IDS, preferLocal: true });
  const edges = [];
  const audio = node('audioInput', 0, {}, 'Voiceover audio');
  const transcript = node('llmPrompt', 1, stepConfig(PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE, { executionMode: 'localTool', toolId: 'whisper', model: 'base' }, { instruction: 'Transcribe the voiceover and preserve timestamped segments when Whisper returns them.' }), 'Timestamped transcription');
  const packet = node('planningPacket', 2, {
    schemaId: DEFAULT_PLANNING_SCHEMA_ID,
    title: 'Voiceover slideshow planning packet',
    goal: 'Convert the voiceover transcript and timestamped segments into an ordered slideshow scene plan for image generation and video composition.',
    sourceSummary: '',
    constraintsText: 'Preserve source order. Create one slide for each major beat. Keep every visual prompt concrete and image-generation ready. Include source transcript segment references or timing notes when the transcript provides them.',
    stylePolicyText: 'Keep visual continuity across the slideshow. A Prompt Style preset can be selected later on the image map for stronger consistency.',
    availableToolsText: 'Whisper transcription, a configurable image generation backend, ordered collection mapping, and slideshow media composition with the original voiceover audio.',
    readinessNotesText: 'Select the voiceover audio file, configure the planner provider/model, and configure the image backend/checkpoint before running. Slide timing uses the Media Composition seconds-per-item setting unless you adjust it manually.',
    desiredOutputNotes: 'Return ordered scenes/slides. Each scene should include visualPromptDraft, sourceSpanLabel, optional narration/caption context, and timing or segment notes when available.',
    riskNotesText: 'Do not invent visuals that contradict the transcript. Keep any unclear source moments visible as risk notes or open questions.',
  }, 'Build scene packet');
  const planner = node('planner', 3, {
    executionMode: plannerTarget.executionMode === 'ollama' ? 'ollama' : 'cloud',
    providerId: plannerTarget.executionMode === 'cloud' ? plannerTarget.providerId || '' : '',
    model: plannerTarget.model || '',
    schemaId: DEFAULT_PLANNING_SCHEMA_ID,
    instruction: 'Create a structured longform scene plan for a slideshow video. Preserve ordering from the transcript, write practical visualPromptDraft values for each slide, and carry timing or source-segment references when the transcript metadata makes them available.',
    systemPrompt: '',
  }, 'Plan slideshow scenes');
  const prompts = node('planScenes', 4, {}, 'Image prompt collection');
  const images = node('collectionMap', 5, mapConfig(PIPELINE_OPERATION_IDS.IMAGE_GENERATE, 'textToImage', imageTarget, {
    failureMode: 'partial',
    instruction: 'Generate one slideshow image for each planned visual prompt while preserving scene order and source lineage.',
    perItemValidation: {
      enabled: true,
      mode: 'user',
      llmExecutionMode: 'cloud',
      providerId: '',
      model: '',
      ruleset: 'Accept images that clearly match the planned scene prompt and keep a consistent slideshow style. Reject unusable images with obvious artifacts or mismatched content.',
      systemPrompt: '',
      maxAttempts: 2,
      retryInstruction: 'Revise this scene prompt for a cleaner slideshow image and try again.',
      failMode: 'partial',
    },
  }), 'Generate and review images');
  const composition = node('mediaComposition', 6, { secondsPerItem: 4 }, 'Compose slideshow');
  const exportNode = node('mediaExport', 7, { title: 'Voiceover slideshow video', width: 1280, height: 720, fps: 30, fitMode: 'contain', stopMode: 'shortest' }, 'Export slideshow video');
  const output = node('videoOutput', 8, { title: 'Voiceover slideshow video' }, 'Video output');
  link(edges, audio, 'audio', transcript, 'prompt');
  link(edges, transcript, 'text', packet, 'source');
  link(edges, packet, 'packet', planner, 'packet');
  link(edges, planner, 'plan', prompts, 'plan');
  link(edges, prompts, 'collection', images, 'collection');
  link(edges, images, 'collection', composition, 'visuals');
  link(edges, audio, 'audio', composition, 'audio');
  link(edges, composition, 'composition', exportNode, 'composition');
  link(edges, exportNode, 'video', output, 'video');
  return finalize(template, [audio, transcript, packet, planner, prompts, images, composition, exportNode, output], edges, 'Transcript segment metadata is preserved by Whisper when available. This template asks the planner to carry segment references, while the slideshow composer uses an editable seconds-per-item duration today.');
}
function imageUpscale(template) {
  const edges = [];
  const a = node('imageInput', 0, {}, 'Source image');
  const b = node('llmPrompt', 1, stepConfig(PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, { executionMode: 'localTool', toolId: 'upscayl' }, { instruction: 'Upscale the connected image and keep the transformed result as a pipeline artifact.', transformSubtype: 'upscale', scale: 4 }), 'Upscale image');
  const c = node('imageOutput', 2, { title: 'Upscaled image' }, 'Image output');
  link(edges, a, 'image', b, 'prompt'); link(edges, b, 'image', c, 'image');
  return finalize(template, [a, b, c], edges);
}
function imageCollectionUpscale(template) {
  const edges = [];
  const a = node('collectionInput', 0, { itemType: PORT_KIND_IMAGE, items: [] }, 'Image collection');
  const b = node('collectionMap', 1, mapConfig(PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, 'imageToImage', { executionMode: 'localTool', toolId: 'upscayl' }, { transformSubtype: 'upscale', scale: 4 }), 'Upscale image collection');
  const c = node('collectionOutput', 2, { title: 'Upscaled image collection' }, 'Collection output');
  link(edges, a, 'collection', b, 'collection'); link(edges, b, 'collection', c, 'collection');
  return finalize(template, [a, b, c], edges);
}
function graphPreset(template, contextMaps) {
  const preset = (contextMaps.graphWorkflowPresets || []).find((entry) => isGraphWorkflowPresetCompatibleWithOperation(entry)) || null;
  const config = preset ? buildGraphWorkflowConfigFromPreset(preset) : { graphWorkflowPresetId: '', toolId: GRAPH_WORKFLOW_TOOL_IDS[0] || 'comfyui', workflowSource: 'preset', workflowText: '' };
  const edges = [];
  const a = node('textInput', 0, { text: '' }, 'Workflow prompt');
  const b = node('graphWorkflow', 1, config, 'Run graph workflow');
  const c = node('imageOutput', 2, { title: 'Graph workflow image' }, 'Image output');
  link(edges, a, 'text', b, 'text'); link(edges, b, 'image', c, 'image');
  return finalize(template, [a, b, c], edges, preset ? 'This draft is attached to the saved graph workflow preset "' + preset.name + '".' : 'Choose or create a compatible graph workflow preset before running this pipeline.');
}

const localOrCloudImageRuntime = Object.freeze({ id: 'image-generation-runtime', label: 'Local or cloud image generation runtime', anyOf: Object.freeze([
  Object.freeze({ kind: 'toolOperation', operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE, toolIds: IMAGE_WORKFLOW_TOOL_IDS }),
  Object.freeze({ kind: 'providerOperation', operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE }),
]) });

const BUILT_IN_PIPELINE_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'text-response', name: 'Text response', description: 'Ask a local or cloud language model for a text answer and save the response.', category: 'Cloud/basic', tags: Object.freeze(['text', 'llm']), outputType: 'Text', complexity: 'easy', requirements: Object.freeze(['Connected text provider or Ollama', 'Model selected before running']), runtimeGroups: Object.freeze([Object.freeze({ id: 'text-runtime', label: 'Connected text provider or Ollama', anyOf: Object.freeze([Object.freeze({ kind: 'providerOperation', operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT }), Object.freeze({ kind: 'toolOperation', operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT, toolIds: Object.freeze(['ollama']) })]) })]), modelSelectionRequired: true, placeholdersRequired: true, nextSteps: Object.freeze(['Enter the real prompt.', 'Choose a provider or Ollama model before running.']), createPipeline: textResponse }),
  Object.freeze({ id: 'image-description', name: 'Image description', description: 'Send an image to a vision-capable model or image backend and save a text description.', category: 'Cloud/basic', tags: Object.freeze(['image', 'analysis']), outputType: 'Text', complexity: 'easy', requirements: Object.freeze(['Vision provider or local image analysis backend', 'Image file selected before running']), runtimeGroups: Object.freeze([Object.freeze({ id: 'image-analysis-runtime', label: 'Vision provider or local image backend', anyOf: Object.freeze([Object.freeze({ kind: 'providerOperation', operationId: PIPELINE_OPERATION_IDS.IMAGE_ANALYZE }), Object.freeze({ kind: 'toolOperation', operationId: PIPELINE_OPERATION_IDS.IMAGE_ANALYZE, toolIds: IMAGE_WORKFLOW_TOOL_IDS })]) })]), modelSelectionRequired: true, placeholdersRequired: true, nextSteps: Object.freeze(['Choose the source image.', 'Choose a vision model or local image analysis backend.']), createPipeline: imageDescription }),
  Object.freeze({ id: 'simple-text-to-image', name: 'Simple text to image', description: 'Turn one text prompt into one generated image using a local image backend or cloud image provider.', category: 'Local image', tags: Object.freeze(['image', 'generation']), outputType: 'Image', complexity: 'easy', requirements: Object.freeze(['Forge or Automatic1111, or a connected image provider', 'Prompt entered before running']), runtimeGroups: Object.freeze([localOrCloudImageRuntime]), placeholdersRequired: true, nextSteps: Object.freeze(['Enter the image prompt.', 'Choose a checkpoint or provider image model if needed.']), createPipeline: textToImage }),
  Object.freeze({ id: 'prompt-collection-to-images', name: 'Prompt collection to image collection', description: 'Map an ordered text prompt collection into an ordered image collection.', category: 'Local image', tags: Object.freeze(['collection', 'image', 'map']), outputType: 'Image collection', complexity: 'intermediate', requirements: Object.freeze(['Collection Input text items', 'Image generation runtime']), runtimeGroups: Object.freeze([localOrCloudImageRuntime]), placeholdersRequired: true, nextSteps: Object.freeze(['Add prompt items to Collection Input.', 'Review image settings before running the map.']), createPipeline: (template, contextMaps) => promptCollectionImages(template, contextMaps) }),
  Object.freeze({ id: 'validated-prompt-collection-to-images', name: 'Prompt collection to images with user validation', description: 'Map each prompt to an image, pause for per-item user review, and keep partial successes when an item cannot be accepted.', category: 'Local image', tags: Object.freeze(['collection', 'validation', 'retry']), outputType: 'Image collection', complexity: 'advanced', requirements: Object.freeze(['Collection Input text items', 'Image generation runtime', 'User review during run']), runtimeGroups: Object.freeze([localOrCloudImageRuntime]), placeholdersRequired: true, nextSteps: Object.freeze(['Add prompt items to Collection Input.', 'Run when you are ready to review each generated item.']), createPipeline: (template, contextMaps) => promptCollectionImages(template, contextMaps, { partialSuccess: true, userValidation: true }) }),
  Object.freeze({ id: 'audio-transcription', name: 'Audio transcription', description: 'Transcribe an audio file locally with Whisper and save the transcript.', category: 'Audio', tags: Object.freeze(['audio', 'whisper']), outputType: 'Text', complexity: 'easy', requirements: Object.freeze(['Whisper installed', 'Audio file selected before running']), runtimeGroups: Object.freeze([Object.freeze({ id: 'whisper-runtime', label: 'Whisper', anyOf: Object.freeze([Object.freeze({ kind: 'toolOperation', operationId: PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE, toolIds: Object.freeze(['whisper']) })]) })]), placeholdersRequired: true, nextSteps: Object.freeze(['Choose the source audio file.', 'Change the Whisper model size if needed.']), createPipeline: audioTranscription }),
  Object.freeze({ id: 'text-to-music-audio', name: 'Text to music or audio', description: 'Generate a short music or sound artifact from text using AudioCraft.', category: 'Audio', tags: Object.freeze(['audio', 'music']), outputType: 'Audio', complexity: 'intermediate', requirements: Object.freeze(['AudioCraft WebUI installed', 'Prompt entered before running']), runtimeGroups: Object.freeze([Object.freeze({ id: 'audiocraft-runtime', label: 'AudioCraft WebUI', anyOf: Object.freeze([Object.freeze({ kind: 'toolOperation', operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE, toolIds: Object.freeze(['audiocraft-webui']) })]) })]), placeholdersRequired: true, nextSteps: Object.freeze(['Enter the audio prompt.', 'Adjust duration and AudioCraft settings if needed.']), createPipeline: textToAudio }),
  Object.freeze({ id: 'audiocraft-continuation', name: 'AudioCraft continuation', description: 'Continue a source audio clip with AudioCraft while preserving its style.', category: 'Audio', tags: Object.freeze(['audio', 'continuation']), outputType: 'Audio', complexity: 'advanced', requirements: Object.freeze(['AudioCraft WebUI installed', 'Source audio selected before running']), runtimeGroups: Object.freeze([Object.freeze({ id: 'audiocraft-runtime', label: 'AudioCraft WebUI', anyOf: Object.freeze([Object.freeze({ kind: 'toolOperation', operationId: PIPELINE_OPERATION_IDS.AUDIO_GENERATE, toolIds: Object.freeze(['audiocraft-webui']) })]) })]), placeholdersRequired: true, nextSteps: Object.freeze(['Choose the source audio file.', 'Tune continuation seed seconds and duration.']), createPipeline: audioContinuation }),
  Object.freeze({ id: 'voiceover-to-slideshow-video', name: 'Voiceover to slideshow video', description: 'Turn a source voiceover into a timestamp-aware scene plan, generate ordered slideshow images, and export a video with the original audio.', category: 'Media/collection', tags: Object.freeze(['audio', 'whisper', 'planning', 'collection', 'image', 'video']), outputType: 'Video', complexity: 'advanced', requirements: Object.freeze(['Voiceover audio file selected before running', 'Whisper installed', 'Connected planning provider/model or Ollama', 'Local or cloud image generation runtime', 'Built-in media composition/export path']), runtimeGroups: Object.freeze([Object.freeze({ id: 'whisper-runtime', label: 'Whisper', anyOf: Object.freeze([Object.freeze({ kind: 'toolOperation', operationId: PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE, toolIds: Object.freeze(['whisper']) })]) }), Object.freeze({ id: 'planning-runtime', label: 'Connected planning provider or Ollama', anyOf: Object.freeze([Object.freeze({ kind: 'providerOperation', operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT }), Object.freeze({ kind: 'toolOperation', operationId: PIPELINE_OPERATION_IDS.LLM_PROMPT, toolIds: Object.freeze(['ollama']) })]) }), localOrCloudImageRuntime]), modelSelectionRequired: true, placeholdersRequired: true, optionalPresets: Object.freeze(['promptStyle']), nextSteps: Object.freeze(['Select the source voiceover audio file.', 'Configure Whisper if needed.', 'Choose a planner provider/model or Ollama model.', 'Choose the image backend, checkpoint, or cloud image model.', 'Optionally select a Prompt Style preset on the image map for visual consistency.', 'Adjust the Media Composition seconds-per-item setting if the default slide timing does not match the voiceover.']), createPipeline: voiceoverSlideshowVideo }),
  Object.freeze({ id: 'image-upscale', name: 'Image upscale', description: 'Upscale one image through Upscayl and save the transformed result.', category: 'Media/collection', tags: Object.freeze(['image', 'upscale']), outputType: 'Image', complexity: 'easy', requirements: Object.freeze(['Upscayl installed', 'Image file selected before running']), runtimeGroups: Object.freeze([Object.freeze({ id: 'upscayl-runtime', label: 'Upscayl', anyOf: Object.freeze([Object.freeze({ kind: 'toolOperation', operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, toolIds: Object.freeze(['upscayl']) })]) })]), placeholdersRequired: true, nextSteps: Object.freeze(['Choose the source image.', 'Adjust scale if needed.']), createPipeline: imageUpscale }),
  Object.freeze({ id: 'image-collection-upscale', name: 'Image collection upscale', description: 'Upscale every image in an ordered collection through Upscayl.', category: 'Media/collection', tags: Object.freeze(['collection', 'upscale']), outputType: 'Image collection', complexity: 'intermediate', requirements: Object.freeze(['Upscayl installed', 'Collection Input image items']), runtimeGroups: Object.freeze([Object.freeze({ id: 'upscayl-runtime', label: 'Upscayl', anyOf: Object.freeze([Object.freeze({ kind: 'toolOperation', operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, toolIds: Object.freeze(['upscayl']) })]) })]), placeholdersRequired: true, nextSteps: Object.freeze(['Add image items to Collection Input.', 'Review scale before running.']), createPipeline: imageCollectionUpscale }),
  Object.freeze({ id: 'graph-workflow-from-preset', name: 'Graph workflow from preset', description: 'Run a saved text-to-image graph workflow preset from a text prompt and save its image output.', category: 'Graph workflow', tags: Object.freeze(['graph', 'preset']), outputType: 'Image', complexity: 'advanced', requirements: Object.freeze(['Compatible saved Graph Workflow preset', 'Preset tool installed']), requiredPresets: Object.freeze(['graphWorkflow:text-to-image']), runtimeGroups: Object.freeze([Object.freeze({ id: 'graph-workflow-tool', label: 'ComfyUI or InvokeAI', anyOf: Object.freeze([Object.freeze({ kind: 'toolInstalled', toolIds: GRAPH_WORKFLOW_TOOL_IDS })]) })]), placeholdersRequired: true, nextSteps: Object.freeze(['Create or choose a compatible graph workflow preset.', 'Enter the workflow prompt before running.']), createPipeline: graphPreset }),
  Object.freeze({ id: 'styled-prompt-collection-to-images', name: 'Styled prompt collection to image collection', description: 'Map a prompt collection to images with an optional Prompt Style preset left unset for the user to choose.', category: 'Prompt styles', tags: Object.freeze(['collection', 'prompt-style']), outputType: 'Image collection', complexity: 'intermediate', requirements: Object.freeze(['Image generation runtime', 'Optional Prompt Style preset']), optionalPresets: Object.freeze(['promptStyle']), runtimeGroups: Object.freeze([localOrCloudImageRuntime]), placeholdersRequired: true, nextSteps: Object.freeze(['Add prompt items to Collection Input.', 'Optionally select a Prompt Style preset on the Map Collection node.']), createPipeline: (template, contextMaps) => promptCollectionImages(template, contextMaps) }),
]);

function templateToolIds(template) {
  const ids = [];
  for (const group of template.runtimeGroups || []) for (const option of group.anyOf || []) if (option.kind === 'toolOperation' || option.kind === 'toolInstalled') ids.push(...(option.toolIds || []));
  return unique(ids.map(normalizeId));
}
function getBuiltInPipelineTemplates() { return BUILT_IN_PIPELINE_TEMPLATES.map((template) => ({ ...template, tags: [...(template.tags || [])], requirements: [...(template.requirements || [])], nextSteps: [...(template.nextSteps || [])], requiredTools: templateToolIds(template) })); }
function evalOption(option, contextMaps) {
  if (option.kind === 'providerOperation') {
    const ids = (option.providerIds || getProviderIdsForPipelineOperation(option.operationId)).map(normalizeId).filter(Boolean);
    const readyIds = providerIdsForOperation(option.operationId, contextMaps, ids);
    return { kind: option.kind, ready: readyIds.length > 0, readyIds, missingProviders: readyIds.length ? [] : ids.map((id) => providerLabel(contextMaps, id)) };
  }
  if (option.kind === 'toolOperation') {
    const ids = (option.toolIds || []).map(normalizeId).filter(Boolean);
    const readyIds = toolIdsForOperation(option.operationId, contextMaps, ids);
    const blocked = ids.filter((id) => getTool(contextMaps, id) && !readyIds.includes(id));
    return { kind: option.kind, ready: readyIds.length > 0, readyIds, missingTools: readyIds.length ? [] : ids.map((id) => toolLabel(contextMaps, id)), warnings: blocked.map((id) => toolLabel(contextMaps, id) + ' is installed but is not launch-ready. Run Repair or reinstall it before using this template.') };
  }
  if (option.kind === 'toolInstalled') {
    const ids = (option.toolIds || []).map(normalizeId).filter(Boolean);
    const readyIds = ids.filter((id) => toolUsable(getTool(contextMaps, id)));
    const blocked = ids.filter((id) => getTool(contextMaps, id) && !readyIds.includes(id));
    return { kind: option.kind, ready: readyIds.length > 0, readyIds, missingTools: readyIds.length ? [] : ids.map((id) => toolLabel(contextMaps, id)), warnings: blocked.map((id) => toolLabel(contextMaps, id) + ' is installed but is not launch-ready. Run Repair or reinstall it before using this template.') };
  }
  return { kind: option.kind || 'unknown', ready: false, readyIds: [] };
}
function evalGroup(group, contextMaps) { const optionResults = (group.anyOf || []).map((option) => evalOption(option, contextMaps)); const selected = optionResults.find((entry) => entry.ready) || null; return { groupId: group.id, label: group.label, ready: Boolean(selected), selected, optionResults }; }
function hardwareWarnings(template, contextMaps) {
  const warnings = [];
  for (const id of templateToolIds(template)) {
    const tool = getTool(contextMaps, id) || getCatalogTool(contextMaps, id);
    const compatibility = evaluateCompatibilityProfile(tool?.compatibility || tool?.installInstructions?.compatibility || null, contextMaps.hardware || {});
    if (['warn', 'danger', 'error'].includes(compatibility?.tone)) warnings.push((tool?.name || toolLabel(contextMaps, id)) + ': ' + compatibility.message);
  }
  return unique(warnings);
}
function getPipelineTemplateReadiness(templateOrId, context = {}) {
  const template = typeof templateOrId === 'string' ? BUILT_IN_PIPELINE_TEMPLATES.find((entry) => entry.id === templateOrId) : templateOrId;
  if (!template) return { status: TEMPLATE_STATUS.UNAVAILABLE, missingTools: [], missingProviders: [], missingModels: [], missingPresets: [], notes: [], warnings: ['That starter template is not available in this build.'] };
  const contextMaps = buildContextMaps(context);
  const runtimeGroups = (template.runtimeGroups || []).map((group) => evalGroup(group, contextMaps));
  const missingTools = [];
  const missingProviders = [];
  const missingModels = [];
  const missingPresets = [];
  const notes = [];
  const warnings = [];
  for (const group of runtimeGroups) if (!group.ready) for (const result of group.optionResults || []) { missingTools.push(...(result.missingTools || [])); missingProviders.push(...(result.missingProviders || [])); warnings.push(...(result.warnings || [])); }
  if ((template.requiredPresets || []).includes('graphWorkflow:text-to-image') && !(contextMaps.graphWorkflowPresets || []).some((preset) => isGraphWorkflowPresetCompatibleWithOperation(preset))) missingPresets.push('Create/save a compatible text-to-image Graph Workflow preset first.');
  if ((template.optionalPresets || []).includes('promptStyle') && !(Array.isArray(context.promptStyles) && context.promptStyles.length)) notes.push('No Prompt Style presets are saved yet. You can still create this pipeline and choose a style later.');
  if (template.modelSelectionRequired) missingModels.push('Choose a model before running this pipeline.');
  warnings.push(...hardwareWarnings(template, contextMaps));
  const result = { missingTools: unique(missingTools), missingProviders: unique(missingProviders), missingModels: unique(missingModels), missingPresets: unique(missingPresets), notes: unique(notes), runtimeGroups, warnings: unique(warnings) };
  result.status = result.missingPresets.length ? TEMPLATE_STATUS.UNAVAILABLE : result.missingTools.length || result.missingProviders.length ? TEMPLATE_STATUS.MISSING_REQUIREMENTS : result.missingModels.length || template.placeholdersRequired || result.warnings.length || result.notes.length ? TEMPLATE_STATUS.CONFIGURABLE : TEMPLATE_STATUS.READY;
  return result;
}
function instantiatePipelineTemplate(templateOrId, context = {}) {
  const template = typeof templateOrId === 'string' ? BUILT_IN_PIPELINE_TEMPLATES.find((entry) => entry.id === templateOrId) : templateOrId;
  if (!template) return { ok: false, message: 'Local AI Hub could not find that starter template.' };
  const contextMaps = buildContextMaps(context);
  const readiness = getPipelineTemplateReadiness(template, context);
  const pipeline = template.createPipeline(template, contextMaps, { readiness });
  return { ok: true, analysis: analyzePipeline(pipeline, contextMaps), pipeline: normalizePipelineDefinition(cloneValue(pipeline)), readiness, template: { id: template.id, name: template.name, category: template.category, outputType: template.outputType } };
}

module.exports = { BUILT_IN_PIPELINE_TEMPLATES, TEMPLATE_STATUS, getBuiltInPipelineTemplates, getPipelineTemplateReadiness, instantiatePipelineTemplate };
module.exports.default = module.exports;
