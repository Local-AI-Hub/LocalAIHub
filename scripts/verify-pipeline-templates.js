const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
  tools: ['ollama', 'forge', 'automatic1111', 'whisper', 'audiocraft-webui', 'chatterbox-tts', 'rvc', 'upscayl', 'facefusion', 'comfyui', 'wan21-webui'].map((id) => tool(id)),
};

assert(BUILT_IN_PIPELINE_TEMPLATES.length >= 10, 'Expected a useful starter template set.');
const ids = BUILT_IN_PIPELINE_TEMPLATES.map((template) => template.id);
assert.strictEqual(new Set(ids).size, ids.length, 'Template IDs must be unique.');
const removedTemplateIds = [
  'image-collection-upscale',
  'audio-idea-to-prompt-collection',
  'script-to-video-prompt-collection',
  'export-subtitles-from-video',
  'validated-prompt-collection-to-images',
];
for (const removedId of removedTemplateIds) {
  assert(!ids.includes(removedId), `${removedId} should no longer be listed as a built-in template.`);
  assert.strictEqual(instantiatePipelineTemplate(removedId, allReadyContext).ok, false, `${removedId} should no longer instantiate as a built-in template.`);
}
for (const retainedId of [
  'image-upscale',
  'audio-idea-to-generated-song',
  'video-idea-to-generated-video',
  'generate-subtitled-video-from-video',
  'prompt-collection-to-images',
]) {
  assert(ids.includes(retainedId), `${retainedId} should remain available.`);
}
const allowedCategories = ['Text', 'Image', 'Audio', 'Video'];
const categoryCounts = BUILT_IN_PIPELINE_TEMPLATES.reduce((counts, template) => {
  assert(allowedCategories.includes(template.category), `${template.id} must use one of the four output categories.`);
  counts.set(template.category, (counts.get(template.category) || 0) + 1);
  return counts;
}, new Map());
assert.deepStrictEqual([...categoryCounts.keys()].sort(), [...allowedCategories].sort(), 'Templates must use exactly Text, Image, Audio, and Video categories.');
for (const category of allowedCategories) assert(categoryCounts.get(category) > 0, `Template category ${category} should not be empty.`);

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


const continuationStep = instantiatePipelineTemplate('audiocraft-continuation', allReadyContext).pipeline.nodes.find((node) => node.type === 'llmPrompt');
assert.strictEqual(getModelStepOperationId(continuationStep), PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'AudioCraft continuation should use the current Model Step audio operation.');
assert.strictEqual(continuationStep.config.audioMode, 'continuation', 'AudioCraft continuation should use continuation mode.');
assert.strictEqual(continuationStep.config.appendSource, true, 'AudioCraft continuation should append the source by default.');

function nodeByType(pipeline, type, message) {
  const found = pipeline.nodes.find((entry) => entry.type === type) || null;
  assert(found, message || ('Expected node type ' + type + '.'));
  return found;
}
function hasEdge(pipeline, source, sourcePort, target, targetPort) {
  return pipeline.edges.some((edge) => edge.source?.nodeId === source.id && edge.source?.portId === sourcePort && edge.target?.nodeId === target.id && edge.target?.portId === targetPort);
}

const chatterboxTemplate = BUILT_IN_PIPELINE_TEMPLATES.find((template) => template.id === 'voice-cloning-with-chatterbox');
assert(chatterboxTemplate, 'Voice cloning with Chatterbox template should exist.');
assert.strictEqual(chatterboxTemplate.category, 'Audio', 'Chatterbox voice cloning template should be categorized as Audio.');
const chatterboxResult = instantiatePipelineTemplate(chatterboxTemplate.id, allReadyContext);
assert(chatterboxResult.ok, 'Chatterbox voice cloning template should instantiate.');
const chatterboxPipeline = chatterboxResult.pipeline;
const chatterboxText = chatterboxPipeline.nodes.find((node) => node.type === 'textInput' && /text to speak/i.test(node.label));
const chatterboxReference = chatterboxPipeline.nodes.find((node) => node.type === 'audioInput' && /reference voice/i.test(node.label));
const chatterboxStep = chatterboxPipeline.nodes.find((node) => node.type === 'llmPrompt' && node.config?.toolId === 'chatterbox-tts');
const chatterboxOutput = chatterboxPipeline.nodes.find((node) => node.type === 'audioOutput');
assert(chatterboxText, 'Chatterbox template should clearly label the text input.');
assert(chatterboxReference, 'Chatterbox template should clearly label the reference voice audio input.');
assert(chatterboxStep, 'Chatterbox template should use the existing Chatterbox Model Step contract.');
assert.strictEqual(chatterboxStep.config.executionMode, 'localTool', 'Chatterbox template should use local tool execution.');
assert.strictEqual(chatterboxStep.config.operationId, PIPELINE_OPERATION_IDS.AUDIO_GENERATE, 'Chatterbox template should use audio generation.');
assert.strictEqual(chatterboxStep.config.audioMode, 'referenceVoiceTts', 'Chatterbox template should use Reference Voice TTS mode.');
assert(chatterboxOutput, 'Chatterbox template should include Audio Output.');
assert(hasEdge(chatterboxPipeline, chatterboxText, 'text', chatterboxStep, 'prompt'), 'Text to speak should feed Chatterbox.');
assert(hasEdge(chatterboxPipeline, chatterboxReference, 'audio', chatterboxStep, 'referenceAudio'), 'Reference voice audio should feed Chatterbox Reference Audio.');
assert(hasEdge(chatterboxPipeline, chatterboxStep, 'audio', chatterboxOutput, 'audio'), 'Chatterbox should feed Audio Output.');
const noProviderChatterbox = getPipelineTemplateReadiness(chatterboxTemplate.id, { tools: [tool('chatterbox-tts')], providers: [] });
assert.notStrictEqual(noProviderChatterbox.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Chatterbox template should not require a cloud provider.');

const faceFusionTemplate = BUILT_IN_PIPELINE_TEMPLATES.find((template) => template.id === 'face-swap-with-facefusion');
assert(faceFusionTemplate, 'Face swap with FaceFusion template should exist.');
assert.strictEqual(faceFusionTemplate.category, 'Image', 'FaceFusion image-output template should be categorized as Image.');
const faceFusionResult = instantiatePipelineTemplate(faceFusionTemplate.id, allReadyContext);
assert(faceFusionResult.ok, 'FaceFusion face swap template should instantiate.');
const faceFusionPipeline = faceFusionResult.pipeline;
const sourceFace = faceFusionPipeline.nodes.find((node) => node.type === 'imageInput' && /source face/i.test(node.label));
const targetImage = faceFusionPipeline.nodes.find((node) => node.type === 'imageInput' && /target image/i.test(node.label));
const faceFusionStep = faceFusionPipeline.nodes.find((node) => node.type === 'llmPrompt' && node.config?.toolId === 'facefusion');
const faceFusionOutput = faceFusionPipeline.nodes.find((node) => node.type === 'imageOutput');
assert(sourceFace, 'FaceFusion template should clearly label the source face input.');
assert(targetImage, 'FaceFusion template should clearly label the target image input.');
assert(faceFusionStep, 'FaceFusion template should use the existing FaceFusion Model Step contract.');
assert.strictEqual(faceFusionStep.config.executionMode, 'localTool', 'FaceFusion template should use local tool execution.');
assert.strictEqual(faceFusionStep.config.operationId, PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, 'FaceFusion template should use image transform.');
assert.strictEqual(faceFusionStep.config.transformSubtype, 'face-swap', 'FaceFusion template should use the supported face-swap subtype.');
assert(faceFusionOutput, 'FaceFusion template should include Image Output.');
assert(hasEdge(faceFusionPipeline, targetImage, 'image', faceFusionStep, 'prompt'), 'Target image should feed the main FaceFusion input.');
assert(hasEdge(faceFusionPipeline, sourceFace, 'image', faceFusionStep, 'referenceImage'), 'Source face should feed FaceFusion Reference Image.');
assert(hasEdge(faceFusionPipeline, faceFusionStep, 'image', faceFusionOutput, 'image'), 'FaceFusion should feed Image Output.');


const subtitledVideoResult = instantiatePipelineTemplate('generate-subtitled-video-from-video', allReadyContext);
assert(subtitledVideoResult.ok, 'Generate subtitled video template should instantiate.');
const subtitledVideo = subtitledVideoResult.pipeline;
const subtitledVideoInput = nodeByType(subtitledVideo, 'videoInput', 'Subtitled video template should include Video Input.');
const subtitledExtractAudio = nodeByType(subtitledVideo, 'extractAudio', 'Subtitled video template should include Extract Audio.');
const subtitledWhisper = subtitledVideo.nodes.find((entry) => entry.type === 'llmPrompt' && getModelStepOperationId(entry) === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE);
assert(subtitledWhisper, 'Subtitled video template should include a Whisper Model Step.');
const subtitledBurn = nodeByType(subtitledVideo, 'burnSubtitles', 'Subtitled video template should include Burn Subtitles / Captions.');
const subtitledOutput = nodeByType(subtitledVideo, 'videoOutput', 'Subtitled video template should include Video Output.');
assert(hasEdge(subtitledVideo, subtitledVideoInput, 'video', subtitledExtractAudio, 'video'), 'Video Input should feed Extract Audio in subtitled video template.');
assert(hasEdge(subtitledVideo, subtitledExtractAudio, 'audio', subtitledWhisper, 'prompt'), 'Extract Audio should feed Whisper in subtitled video template.');
assert(hasEdge(subtitledVideo, subtitledVideoInput, 'video', subtitledBurn, 'video'), 'Original Video Input should feed Burn Subtitles video input.');
assert(hasEdge(subtitledVideo, subtitledWhisper, 'text', subtitledBurn, 'captions'), 'Whisper transcript should feed Burn Subtitles captions input.');
assert(hasEdge(subtitledVideo, subtitledBurn, 'video', subtitledOutput, 'video'), 'Burn Subtitles should feed Video Output.');
assert(['auto', 'transcriptSegments'].includes(subtitledBurn.config.captionMode), 'Subtitled video template should use transcript-aware burn timing.');
assert(/burns captions directly into the video/i.test(subtitledVideo.description), 'Subtitled video template notes should explain burned captions.');
assert(/Export Subtitles \/ Captions/i.test(subtitledVideo.description), 'Subtitled video template notes should point users to the reusable subtitle export node.');
assert(!subtitledVideo.nodes.some((entry) => entry.type === 'exportSubtitles'), 'Subtitled video template should not require Export Subtitles.');
const missingWhisperSubtitledVideo = getPipelineTemplateReadiness('generate-subtitled-video-from-video', { ...allReadyContext, tools: allReadyContext.tools.filter((entry) => entry.id !== 'whisper') });
assert.strictEqual(missingWhisperSubtitledVideo.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Subtitled video template should report missing Whisper.');
assert(missingWhisperSubtitledVideo.missingTools.some((entry) => /whisper/i.test(entry)), 'Subtitled video readiness should explain the missing Whisper requirement.');
const configurableSubtitledVideo = getPipelineTemplateReadiness('generate-subtitled-video-from-video', allReadyContext);
assert.strictEqual(configurableSubtitledVideo.status, TEMPLATE_STATUS.CONFIGURABLE, 'Subtitled video template should remain configurable for source video and Whisper settings.');



const generatedVideoResult = instantiatePipelineTemplate('video-idea-to-generated-video', allReadyContext);
assert(generatedVideoResult.ok, 'Video idea generated video template should instantiate.');
const generatedVideo = generatedVideoResult.pipeline;
const generatedVideoPacket = generatedVideo.nodes.find((node) => node.type === 'planningPacket');
const generatedVideoPlanner = generatedVideo.nodes.find((node) => node.type === 'planner');
const generatedVideoPlanBridge = generatedVideo.nodes.find((node) => node.type === 'planScenes');
const generatedVideoMap = generatedVideo.nodes.find((node) => node.type === 'collectionMap');
const generatedVideoStitch = generatedVideo.nodes.find((node) => node.type === 'videoStitch');
const generatedVideoOutput = generatedVideo.nodes.find((node) => node.type === 'videoOutput');
assert(generatedVideoPacket, 'Generated video template should include a Planning Packet.');
assert(generatedVideoPlanner, 'Generated video template should include a Planner.');
assert(generatedVideoPlanBridge, 'Generated video template should include the plan-to-text collection bridge.');
assert(generatedVideoMap, 'Generated video template should include collectionMap generation.');
assert(generatedVideoStitch, 'Generated video template should include Video Stitch.');
assert(generatedVideoOutput, 'Generated video template should include Video Output.');
assert.strictEqual(generatedVideoPacket.config.schemaId, 'videoPromptPlan.v1', 'Generated video planning packet should request videoPromptPlan.');
assert.strictEqual(generatedVideoPlanner.config.schemaId, 'videoPromptPlan.v1', 'Generated video planner should request videoPromptPlan.');
assert.strictEqual(getCollectionMapMapping(generatedVideoMap)?.id, 'textToVideo', 'Generated video template should map planned text prompts to video.');
assert.strictEqual(generatedVideoMap.config.executionMode, 'localTool', 'Generated video template should use local video generation by default.');
assert.strictEqual(generatedVideoMap.config.toolId, 'wan21-webui', 'Generated video template should target Wan2.1 WebUI.');
assert.strictEqual(generatedVideoMap.config.videoItemMode, 'independent', 'Generated video template should use independent clips by default.');
assert.strictEqual(generatedVideoMap.config.videoChainFirstItemBehavior, 'textToVideo', 'Generated video template should keep a clear first-item behavior.');
assert.strictEqual(generatedVideoMap.config.promptStyleId, '', 'Generated video template should leave Prompt Style unset.');
assert(generatedVideo.edges.some((edge) => edge.source.nodeId === generatedVideoMap.id && edge.target.nodeId === generatedVideoStitch.id), 'Generated video collection should feed Video Stitch.');
assert(generatedVideo.edges.some((edge) => edge.source.nodeId === generatedVideoStitch.id && edge.target.nodeId === generatedVideoOutput.id), 'Video Stitch should feed Video Output.');
const missingWanGeneratedVideo = getPipelineTemplateReadiness('video-idea-to-generated-video', {
  ...allReadyContext,
  tools: allReadyContext.tools.filter((entry) => entry.id !== 'wan21-webui'),
});
assert.strictEqual(missingWanGeneratedVideo.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Generated video template should require Wan for actual generation.');
assert(missingWanGeneratedVideo.missingTools.some((entry) => /Wan|wan/i.test(entry)), 'Generated video readiness should explain the missing Wan requirement.');
const missingWanModelsGeneratedVideo = getPipelineTemplateReadiness('video-idea-to-generated-video', {
  ...allReadyContext,
  tools: allReadyContext.tools.map((entry) => entry.id === 'wan21-webui' ? tool('wan21-webui', { downloadedModels: [] }) : entry),
});
assert(missingWanModelsGeneratedVideo.missingModels.some((entry) => /model folders/i.test(entry)), 'Generated video readiness should explain missing Wan model folders when the tool reports none.');
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
const voiceoverAudioInputs = voiceoverNodesByType.get('audioInput') || [];
assert.strictEqual(voiceoverAudioInputs.length, 2, 'Voiceover slideshow template should include voiceover and background music audio inputs.');
const voiceoverAudio = voiceoverAudioInputs.find((entry) => entry.label === 'Voiceover audio');
const voiceoverBackgroundMusic = voiceoverAudioInputs.find((entry) => entry.label === 'Background music');
assert(voiceoverAudio, 'Voiceover slideshow template should include the Voiceover audio input.');
assert(voiceoverBackgroundMusic, 'Voiceover slideshow template should include the Background music input.');
const voiceoverWhisper = voiceover.nodes.find((entry) => entry.type === 'llmPrompt' && getModelStepOperationId(entry) === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE);
assert(voiceoverWhisper, 'Voiceover slideshow template should transcribe with the current Whisper Model Step operation.');
const voiceoverPacket = firstVoiceoverNode('planningPacket');
const voiceoverPlanner = firstVoiceoverNode('planner');
const voiceoverScenes = firstVoiceoverNode('planScenes');
const voiceoverMap = firstVoiceoverNode('collectionMap');
const voiceoverComposition = firstVoiceoverNode('mediaComposition');
const voiceoverExport = firstVoiceoverNode('mediaExport');
const voiceoverValidation = firstVoiceoverNode('validation');
const voiceoverRetry = firstVoiceoverNode('retryLoop');
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
assert(hasVoiceoverEdge(voiceoverBackgroundMusic, 'audio', voiceoverComposition, 'backgroundMusic'), 'Background music audio should feed Media Composition background music.');
assert(hasVoiceoverEdge(voiceoverComposition, 'composition', voiceoverExport, 'composition'), 'Media composition should feed media export.');
assert(hasVoiceoverEdge(voiceoverExport, 'video', voiceoverValidation, 'input'), 'Media Export should feed Validation.');
assert(hasVoiceoverEdge(voiceoverValidation, 'pass', voiceoverRetry, 'complete'), 'Validation pass should feed Retry Loop complete.');
assert(hasVoiceoverEdge(voiceoverValidation, 'fail', voiceoverRetry, 'retry'), 'Validation fail should feed Retry Loop retry.');
assert(hasVoiceoverEdge(voiceoverRetry, 'result', voiceoverOutput, 'video'), 'Retry Loop should feed Video Output.');
assert.strictEqual(voiceoverRetry.config.retryTargetNodeId, voiceoverComposition.id, 'Voiceover slideshow retry should use the existing Media Composition retry pattern.');
assert.strictEqual(voiceoverComposition.config.imageTimingMode, 'dynamicFromImageMetadata', 'Voiceover slideshow should match narration/transcript timing by default.');
assert.strictEqual(voiceoverComposition.config.secondsPerItem, 4, 'Voiceover slideshow should retain fixed secondsPerItem as the fallback setting.');
assert(/timestamped segments/i.test(voiceoverWhisper.config.instruction), 'Whisper step should request timestamped segment preservation.');
assert(/imagePrompt/i.test(voiceoverPacket.config.desiredOutputNotes), 'Planning packet should request clean scene image prompts.');
assert(/startSeconds|durationSeconds|endSeconds/i.test(voiceoverPacket.config.desiredOutputNotes), 'Planning packet should request scene timing metadata.');

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
const panelSource = fs.readFileSync(path.resolve(__dirname, '../src/components/PipelineBuilderPanel.jsx'), 'utf8');
assert(panelSource.includes("const PIPELINE_TEMPLATE_CATEGORIES = Object.freeze(['Text', 'Image', 'Audio', 'Video']);"), 'Template UI should define exactly four output category headings.');
assert(panelSource.includes('const [templateSearch, setTemplateSearch] = useState'), 'Template UI should keep local search state.');
assert(panelSource.includes('templateCards.filter((template)'), 'Template search should filter the visible template cards.');
assert(panelSource.includes('.filter((group) => group.templates.length > 0)'), 'Template UI should hide category headings with no visible templates.');
assert(panelSource.includes('templateGroups.map((group)'), 'Template UI should render grouped template sections.');

console.log(`Verified ${BUILT_IN_PIPELINE_TEMPLATES.length} built-in pipeline templates.`);
