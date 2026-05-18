const assert = require('assert');

const {
  BUILT_IN_PIPELINE_TEMPLATES,
  TEMPLATE_STATUS,
  getPipelineTemplateReadiness,
  instantiatePipelineTemplate,
} = require('../electron/shared/pipelineTemplates.cjs');
const {
  PIPELINE_OPERATION_IDS,
  buildPipelineGraph,
  getCollectionMapMapping,
  getModelStepOperationId,
  getNodeTypeDefinition,
} = require('../electron/shared/pipelineSchema.cjs');
const {
  buildPlanningPacketDocument,
} = require('../electron/shared/planningSchema.cjs');
function tool(id, extra = {}) {
  return { id, name: id, status: 'stopped', launchSupported: true, ...extra };
}

const allReadyContext = {
  providers: [{ id: 'openai', name: 'OpenAI', isConnected: true }],
  promptStyles: [{ id: 'cinematic', name: 'Cinematic' }],
  graphWorkflowPresets: [{
    id: 'graph-text-image',
    name: 'Text to image preset',
    declaredContract: { inputKinds: ['text'], outputKinds: ['image'], operationFamily: 'textToImage' },
    inputBindings: {},
    outputBindings: {},
    toolId: 'comfyui',
    validation: { ok: true },
    workflowFormat: 'comfyui-api',
    workflowText: '{}',
  }],
  tools: ['ollama', 'forge', 'automatic1111', 'whisper', 'audiocraft-webui', 'upscayl', 'comfyui'].map((id) => tool(id)),
};

assert(BUILT_IN_PIPELINE_TEMPLATES.length >= 10, 'Expected a useful starter template set.');
const ids = BUILT_IN_PIPELINE_TEMPLATES.map((template) => template.id);
assert.strictEqual(new Set(ids).size, ids.length, 'Template IDs must be unique.');

for (const template of BUILT_IN_PIPELINE_TEMPLATES) {
  assert(template.id && template.name && template.category && template.outputType, `Template ${template.id || '<missing>'} must include user-facing metadata.`);
  const result = instantiatePipelineTemplate(template.id, allReadyContext);
  assert(result.ok, `${template.id} should instantiate.`);
  assert.notStrictEqual(result.pipeline, template.pipeline, `${template.id} must create a fresh pipeline, not expose template storage.`);
  assert(result.pipeline.nodes.length >= 2, `${template.id} should create nodes.`);
  for (const node of result.pipeline.nodes) {
    assert(getNodeTypeDefinition(node.type), `${template.id} uses unsupported node type ${node.type}.`);
  }
  const graph = buildPipelineGraph(result.pipeline);
  assert.strictEqual(graph.errors.filter((message) => /unsupported node type|invalid connection|cycle/i.test(message)).length, 0, `${template.id} has structural graph errors: ${graph.errors.join('; ')}`);
}

const emptyTextToImage = getPipelineTemplateReadiness('simple-text-to-image', { tools: [], providers: [] });
assert.strictEqual(emptyTextToImage.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Text-to-image should not be ready with no image runtime.');
assert(emptyTextToImage.missingTools.length || emptyTextToImage.missingProviders.length, 'Missing image runtime should be explained.');

const readyTextToImage = getPipelineTemplateReadiness('simple-text-to-image', allReadyContext);
assert([TEMPLATE_STATUS.READY, TEMPLATE_STATUS.CONFIGURABLE].includes(readyTextToImage.status), 'Text-to-image should become ready/configurable when dependencies exist.');

const collectionTemplate = instantiatePipelineTemplate('prompt-collection-to-images', allReadyContext).pipeline;
assert(collectionTemplate.nodes.some((node) => node.type === 'collectionInput' && node.config.itemType === 'text'), 'Prompt collection template must use Collection Input text items.');
const collectionMap = collectionTemplate.nodes.find((node) => node.type === 'collectionMap');
assert(collectionMap, 'Prompt collection template must use collectionMap.');
assert.strictEqual(getCollectionMapMapping(collectionMap)?.id, 'textToImage', 'Prompt collection map should be textToImage.');

const validatedMap = instantiatePipelineTemplate('validated-prompt-collection-to-images', allReadyContext).pipeline.nodes.find((node) => node.type === 'collectionMap');
assert.strictEqual(validatedMap.config.perItemValidation.enabled, true, 'Validated prompt collection template should enable per-item validation.');
assert.strictEqual(validatedMap.config.perItemValidation.mode, 'user', 'Validated prompt collection template should use user validation.');
assert.strictEqual(validatedMap.config.failureMode, 'partial', 'Validated prompt collection template should keep partial successes.');

const continuationStep = instantiatePipelineTemplate('audiocraft-continuation', allReadyContext).pipeline.nodes.find((node) => node.type === 'llmPrompt');
assert.strictEqual(getModelStepOperationId(continuationStep), PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'AudioCraft continuation should use the current Model Step audio operation.');
assert.strictEqual(continuationStep.config.audioMode, 'continuation', 'AudioCraft continuation should use continuation mode.');
assert.strictEqual(continuationStep.config.appendSource, true, 'AudioCraft continuation should append the source by default.');

const audioPlanResult = instantiatePipelineTemplate('audio-idea-to-prompt-collection', allReadyContext);
assert(audioPlanResult.ok, 'Audio idea planning template should instantiate.');
const audioPlanPipeline = audioPlanResult.pipeline;
const audioPacket = audioPlanPipeline.nodes.find((node) => node.type === 'planningPacket');
const audioPlanner = audioPlanPipeline.nodes.find((node) => node.type === 'planner');
const audioPlanBridge = audioPlanPipeline.nodes.find((node) => node.type === 'planScenes');
const audioCollectionOutput = audioPlanPipeline.nodes.find((node) => node.type === 'collectionOutput');
assert(audioPacket, 'Audio planning template should include a Planning Packet.');
assert(audioPlanner, 'Audio planning template should include a Planner.');
assert(audioPlanBridge, 'Audio planning template should include the plan-to-text collection bridge.');
assert(audioCollectionOutput, 'Audio planning template should include a Collection Output.');
assert.strictEqual(audioPacket.config.schemaId, 'audioPromptPlan.v1', 'Audio planning packet should request audioPromptPlan.');
assert.strictEqual(audioPlanner.config.schemaId, 'audioPromptPlan.v1', 'Audio planner should request audioPromptPlan.');
assert(/AudioCraft is not required/i.test(audioPacket.config.readinessNotesText), 'Audio planning template should not require AudioCraft.');
assert(!audioPlanPipeline.nodes.some((node) => node.type === 'llmPrompt' && getModelStepOperationId(node) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE), 'Audio planning template should not execute audio generation.');
assert(audioPlanPipeline.edges.some((edge) => edge.source.nodeId === audioPlanner.id && edge.target.nodeId === audioPlanBridge.id), 'Audio plan should feed the text collection bridge.');
const missingAudioCraftAudioPlan = getPipelineTemplateReadiness('audio-idea-to-prompt-collection', {
  ...allReadyContext,
  tools: allReadyContext.tools.filter((entry) => entry.id !== 'audiocraft-webui'),
});
assert.notStrictEqual(missingAudioCraftAudioPlan.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Audio prompt planning should not require AudioCraft when a planning provider is available.');

const generatedSongResult = instantiatePipelineTemplate('audio-idea-to-generated-song', allReadyContext);
assert(generatedSongResult.ok, 'Audio idea generated song template should instantiate.');
const generatedSong = generatedSongResult.pipeline;
const generatedSongMap = generatedSong.nodes.find((node) => node.type === 'collectionMap');
const generatedSongStitch = generatedSong.nodes.find((node) => node.type === 'audioStitch');
const generatedSongOutput = generatedSong.nodes.find((node) => node.type === 'audioOutput');
assert(generatedSong.nodes.some((node) => node.type === 'planningPacket' && node.config.schemaId === 'audioPromptPlan.v1'), 'Generated song template should include an audio prompt planning packet.');
assert(generatedSongMap, 'Generated song template should include collectionMap generation.');
assert.strictEqual(getCollectionMapMapping(generatedSongMap)?.id, 'textToAudio', 'Generated song template should map planned text prompts to audio.');
assert.strictEqual(generatedSongMap.config.executionMode, 'localTool', 'Generated song template should prefer local AudioCraft.');
assert.strictEqual(generatedSongMap.config.toolId, 'audiocraft-webui', 'Generated song template should target AudioCraft WebUI.');
assert.strictEqual(generatedSongMap.config.audiocraftItemMode, 'sequentialContinuation', 'Generated song template should enable AudioCraft sequential continuation.');
assert.strictEqual(generatedSongMap.config.promptStyleId, '', 'Generated song template should leave Prompt Style unset.');
assert(generatedSongStitch, 'Generated song template should include Audio Stitch.');
assert(generatedSongOutput, 'Generated song template should include Audio Output.');
assert(generatedSong.edges.some((edge) => edge.source.nodeId === generatedSongMap.id && edge.target.nodeId === generatedSongStitch.id), 'Generated song collection should feed Audio Stitch.');
assert(generatedSong.edges.some((edge) => edge.source.nodeId === generatedSongStitch.id && edge.target.nodeId === generatedSongOutput.id), 'Audio Stitch should feed Audio Output.');
const missingAudioCraftGeneratedSong = getPipelineTemplateReadiness('audio-idea-to-generated-song', {
  ...allReadyContext,
  tools: allReadyContext.tools.filter((entry) => entry.id !== 'audiocraft-webui'),
});
assert.strictEqual(missingAudioCraftGeneratedSong.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Generated song template should require AudioCraft.');
assert(missingAudioCraftGeneratedSong.missingTools.some((entry) => /AudioCraft|audiocraft/i.test(entry)), 'Generated song readiness should explain the missing AudioCraft requirement.');

const noPresetGraph = getPipelineTemplateReadiness('graph-workflow-from-preset', { tools: [tool('comfyui')], graphWorkflowPresets: [] });
assert.strictEqual(noPresetGraph.status, TEMPLATE_STATUS.UNAVAILABLE, 'Graph preset template should be unavailable without a compatible preset.');
assert(noPresetGraph.missingPresets.length, 'Graph preset template should explain the missing preset.');

const noStyleTemplate = getPipelineTemplateReadiness('styled-prompt-collection-to-images', { ...allReadyContext, promptStyles: [] });
assert.notStrictEqual(noStyleTemplate.status, TEMPLATE_STATUS.UNAVAILABLE, 'Prompt Style demo should still be creatable without saved styles.');
assert(noStyleTemplate.notes.some((note) => /Prompt Style/i.test(note)), 'Prompt Style demo should explain the optional missing style.');

const voiceoverResult = instantiatePipelineTemplate('voiceover-to-slideshow-video', allReadyContext);
assert(voiceoverResult.ok, 'Voiceover slideshow template should instantiate.');
const voiceover = voiceoverResult.pipeline;
const voiceoverNodesByType = new Map();
for (const entry of voiceover.nodes) {
  if (!voiceoverNodesByType.has(entry.type)) voiceoverNodesByType.set(entry.type, []);
  voiceoverNodesByType.get(entry.type).push(entry);
}
function firstVoiceoverNode(type) {
  const found = voiceoverNodesByType.get(type)?.[0] || null;
  assert(found, `Voiceover slideshow template should include ${type}.`);
  return found;
}
function hasVoiceoverEdge(source, sourcePort, target, targetPort) {
  return voiceover.edges.some((edge) => edge.source?.nodeId === source.id && edge.source?.portId === sourcePort && edge.target?.nodeId === target.id && edge.target?.portId === targetPort);
}
const voiceoverAudio = firstVoiceoverNode('audioInput');
const voiceoverWhisper = voiceover.nodes.find((entry) => entry.type === 'llmPrompt' && getModelStepOperationId(entry) === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE);
assert(voiceoverWhisper, 'Voiceover slideshow template should transcribe with the current Whisper Model Step operation.');
const voiceoverPacket = firstVoiceoverNode('planningPacket');
const voiceoverPlanner = firstVoiceoverNode('planner');
const voiceoverScenes = firstVoiceoverNode('planScenes');
const voiceoverMap = firstVoiceoverNode('collectionMap');
const voiceoverComposition = firstVoiceoverNode('mediaComposition');
const voiceoverExport = firstVoiceoverNode('mediaExport');
const voiceoverOutput = firstVoiceoverNode('videoOutput');
assert(hasVoiceoverEdge(voiceoverAudio, 'audio', voiceoverWhisper, 'prompt'), 'Voiceover audio should feed Whisper.');
assert(hasVoiceoverEdge(voiceoverWhisper, 'text', voiceoverPacket, 'source'), 'Whisper transcript should feed the planning packet.');
assert(hasVoiceoverEdge(voiceoverPacket, 'packet', voiceoverPlanner, 'packet'), 'Planning packet should feed planner.');
assert(hasVoiceoverEdge(voiceoverPlanner, 'plan', voiceoverScenes, 'plan'), 'Planner output should feed Plan Scenes.');
assert(hasVoiceoverEdge(voiceoverScenes, 'collection', voiceoverMap, 'collection'), 'Scene prompt collection should feed collectionMap.');
assert.strictEqual(getCollectionMapMapping(voiceoverMap)?.id, 'textToImage', 'Voiceover slideshow should map text prompts to images.');
assert.strictEqual(voiceoverMap.config.perItemValidation.enabled, true, 'Voiceover slideshow should include per-item user image validation.');
assert.strictEqual(voiceoverMap.config.failureMode, 'partial', 'Voiceover slideshow should keep partial image successes.');
assert(hasVoiceoverEdge(voiceoverMap, 'collection', voiceoverComposition, 'visuals'), 'Generated image collection should feed media composition visuals.');
assert(hasVoiceoverEdge(voiceoverAudio, 'audio', voiceoverComposition, 'audio'), 'Original voiceover audio should feed media composition primary audio.');
assert(hasVoiceoverEdge(voiceoverComposition, 'composition', voiceoverExport, 'composition'), 'Media composition should feed media export.');
assert(hasVoiceoverEdge(voiceoverExport, 'video', voiceoverOutput, 'video'), 'Media export should feed Video Output.');
assert.strictEqual(voiceoverComposition.config.secondsPerItem, 4, 'Voiceover slideshow timing should remain configurable through secondsPerItem.');
assert(/timestamped segments/i.test(voiceoverWhisper.config.instruction), 'Whisper step should request timestamped segment preservation.');
assert(/visualPromptDraft/i.test(voiceoverPacket.config.desiredOutputNotes), 'Planning packet should request scene image prompt drafts.');

const timestampPacket = buildPlanningPacketDocument(voiceoverPacket.config, [{
  kind: 'text',
  text: 'Opening line. Second beat.',
  transcription: {
    durationSeconds: 8.5,
    language: 'en',
    model: 'base',
    segmentCount: 2,
    segments: [
      { start: 0, end: 3.25, text: 'Opening line.' },
      { start: 3.25, end: 8.5, text: 'Second beat.' },
    ],
  },
}]);
assert.strictEqual(timestampPacket.sourceArtifacts[0].transcription.segments.length, 2, 'Planning packet should preserve Whisper timestamped segments when present.');
assert.strictEqual(timestampPacket.sourceArtifacts[0].transcription.segments[1].start, 3.25, 'Planning packet should preserve segment start times.');
const missingWhisperVoiceover = getPipelineTemplateReadiness('voiceover-to-slideshow-video', {
  ...allReadyContext,
  tools: allReadyContext.tools.filter((entry) => entry.id !== 'whisper'),
});
assert.strictEqual(missingWhisperVoiceover.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Voiceover slideshow should report missing requirements without Whisper.');
assert(missingWhisperVoiceover.missingTools.some((entry) => /whisper/i.test(entry)), 'Voiceover slideshow should explain the missing Whisper requirement.');

const missingImageRuntimeVoiceover = getPipelineTemplateReadiness('voiceover-to-slideshow-video', {
  ...allReadyContext,
  providers: [],
  tools: allReadyContext.tools.filter((entry) => !['forge', 'automatic1111'].includes(entry.id)),
});
assert.strictEqual(missingImageRuntimeVoiceover.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Voiceover slideshow should report missing requirements without an image runtime/provider.');
assert(missingImageRuntimeVoiceover.missingTools.length || missingImageRuntimeVoiceover.missingProviders.length, 'Voiceover slideshow should explain the missing image generation requirement.');

const configurableVoiceover = getPipelineTemplateReadiness('voiceover-to-slideshow-video', allReadyContext);
assert.strictEqual(configurableVoiceover.status, TEMPLATE_STATUS.CONFIGURABLE, 'Voiceover slideshow should be configurable even when dependencies exist because model/input selections are still required.');
assert(configurableVoiceover.missingModels.length, 'Voiceover slideshow should remind the user to choose a planner/image model before running.');
console.log(`Verified ${BUILT_IN_PIPELINE_TEMPLATES.length} built-in pipeline templates.`);
