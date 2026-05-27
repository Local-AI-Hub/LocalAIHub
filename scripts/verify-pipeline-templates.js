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
  tools: ['ollama', 'forge', 'automatic1111', 'whisper', 'audiocraft-webui', 'upscayl', 'comfyui', 'wan21-webui'].map((id) => tool(id)),
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

function nodeByType(pipeline, type, message) {
  const found = pipeline.nodes.find((entry) => entry.type === type) || null;
  assert(found, message || ('Expected node type ' + type + '.'));
  return found;
}
function hasEdge(pipeline, source, sourcePort, target, targetPort) {
  return pipeline.edges.some((edge) => edge.source?.nodeId === source.id && edge.source?.portId === sourcePort && edge.target?.nodeId === target.id && edge.target?.portId === targetPort);
}

const exportSubsResult = instantiatePipelineTemplate('export-subtitles-from-video', allReadyContext);
assert(exportSubsResult.ok, 'Export subtitles from video template should instantiate.');
const exportSubs = exportSubsResult.pipeline;
const exportSubsVideo = nodeByType(exportSubs, 'videoInput', 'Export subtitles template should include Video Input.');
const exportSubsAudio = nodeByType(exportSubs, 'extractAudio', 'Export subtitles template should include Extract Audio.');
const exportSubsWhisper = exportSubs.nodes.find((entry) => entry.type === 'llmPrompt' && getModelStepOperationId(entry) === PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE);
assert(exportSubsWhisper, 'Export subtitles template should include a Whisper Model Step.');
const exportSubsNode = nodeByType(exportSubs, 'exportSubtitles', 'Export subtitles template should include Export Subtitles.');
const exportSubsOutput = nodeByType(exportSubs, 'fileOutput', 'Export subtitles template should include File Output.');
assert(hasEdge(exportSubs, exportSubsVideo, 'video', exportSubsAudio, 'video'), 'Video Input should feed Extract Audio.');
assert(hasEdge(exportSubs, exportSubsAudio, 'audio', exportSubsWhisper, 'prompt'), 'Extract Audio should feed Whisper.');
assert(hasEdge(exportSubs, exportSubsWhisper, 'text', exportSubsNode, 'captions'), 'Whisper transcript should feed Export Subtitles captions.');
assert(hasEdge(exportSubs, exportSubsNode, 'subtitles', exportSubsOutput, 'file'), 'Export Subtitles should feed File Output.');
assert.strictEqual(exportSubsNode.config.outputFormat, 'srt', 'Export subtitles template should default Export Subtitles to SRT.');
assert(['auto', 'transcriptSegments'].includes(exportSubsNode.config.captionMode), 'Export subtitles template should use transcript-aware subtitle timing.');
assert(/standalone subtitle file/i.test(exportSubs.description), 'Export subtitles template notes should explain standalone subtitle output.');
assert(/Whisper timestamped segments/i.test(exportSubs.description), 'Export subtitles template notes should explain Whisper timing.');
const missingWhisperExportSubs = getPipelineTemplateReadiness('export-subtitles-from-video', { ...allReadyContext, tools: allReadyContext.tools.filter((entry) => entry.id !== 'whisper') });
assert.strictEqual(missingWhisperExportSubs.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Export subtitles template should report missing Whisper.');
assert(missingWhisperExportSubs.missingTools.some((entry) => /whisper/i.test(entry)), 'Export subtitles readiness should explain the missing Whisper requirement.');
const configurableExportSubs = getPipelineTemplateReadiness('export-subtitles-from-video', allReadyContext);
assert.strictEqual(configurableExportSubs.status, TEMPLATE_STATUS.CONFIGURABLE, 'Export subtitles template should remain configurable for source video and Whisper settings.');

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
assert(/Export subtitles from video/i.test(subtitledVideo.description), 'Subtitled video template notes should point users to reusable subtitle export.');
assert(!subtitledVideo.nodes.some((entry) => entry.type === 'exportSubtitles'), 'Subtitled video template should not require Export Subtitles.');
const missingWhisperSubtitledVideo = getPipelineTemplateReadiness('generate-subtitled-video-from-video', { ...allReadyContext, tools: allReadyContext.tools.filter((entry) => entry.id !== 'whisper') });
assert.strictEqual(missingWhisperSubtitledVideo.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Subtitled video template should report missing Whisper.');
assert(missingWhisperSubtitledVideo.missingTools.some((entry) => /whisper/i.test(entry)), 'Subtitled video readiness should explain the missing Whisper requirement.');
const configurableSubtitledVideo = getPipelineTemplateReadiness('generate-subtitled-video-from-video', allReadyContext);
assert.strictEqual(configurableSubtitledVideo.status, TEMPLATE_STATUS.CONFIGURABLE, 'Subtitled video template should remain configurable for source video and Whisper settings.');

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

const videoPromptPlanResult = instantiatePipelineTemplate('script-to-video-prompt-collection', allReadyContext);
assert(videoPromptPlanResult.ok, 'Script to video prompt collection template should instantiate.');
const videoPromptPlanPipeline = videoPromptPlanResult.pipeline;
const videoPacket = videoPromptPlanPipeline.nodes.find((node) => node.type === 'planningPacket');
const videoPlanner = videoPromptPlanPipeline.nodes.find((node) => node.type === 'planner');
const videoPlanBridge = videoPromptPlanPipeline.nodes.find((node) => node.type === 'planScenes');
const videoCollectionOutput = videoPromptPlanPipeline.nodes.find((node) => node.type === 'collectionOutput');
assert(videoPacket, 'Video prompt planning template should include a Planning Packet.');
assert(videoPlanner, 'Video prompt planning template should include a Planner.');
assert(videoPlanBridge, 'Video prompt planning template should include the plan-to-text collection bridge.');
assert(videoCollectionOutput, 'Video prompt planning template should include a Collection Output.');
assert.strictEqual(videoPacket.config.schemaId, 'videoPromptPlan.v1', 'Video prompt planning packet should request videoPromptPlan.');
assert.strictEqual(videoPlanner.config.schemaId, 'videoPromptPlan.v1', 'Video planner should request videoPromptPlan.');
assert(/not required/i.test(videoPacket.config.readinessNotesText) && /Wan/i.test(videoPacket.config.readinessNotesText), 'Video prompt planning template should not require Wan.');
assert(/referenceMode/i.test(videoPacket.config.desiredOutputNotes) && /referenceFrameRole/i.test(videoPacket.config.desiredOutputNotes), 'Video prompt planning packet should request reference-frame metadata.');
assert(!videoPromptPlanPipeline.nodes.some((node) => node.type === 'collectionMap'), 'Video prompt planning template should not add collectionMap text-to-video.');
assert(!videoPromptPlanPipeline.nodes.some((node) => node.type === 'llmPrompt' && getModelStepOperationId(node) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE), 'Video prompt planning template should not execute video generation.');
assert(videoPromptPlanPipeline.edges.some((edge) => edge.source.nodeId === videoPlanner.id && edge.target.nodeId === videoPlanBridge.id), 'Video plan should feed the text collection bridge.');
const missingVideoToolVideoPlan = getPipelineTemplateReadiness('script-to-video-prompt-collection', {
  ...allReadyContext,
  tools: allReadyContext.tools.filter((entry) => !/wan|video/i.test(entry.id)),
});
assert.notStrictEqual(missingVideoToolVideoPlan.status, TEMPLATE_STATUS.MISSING_REQUIREMENTS, 'Video prompt planning should not require a video generation tool when a planning provider is available.');

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
assert.strictEqual(voiceoverComposition.config.imageTimingMode, 'dynamicFromImageMetadata', 'Voiceover slideshow should match narration/transcript timing by default.');
assert.strictEqual(voiceoverComposition.config.secondsPerItem, 4, 'Voiceover slideshow should retain fixed secondsPerItem as the fallback setting.');
assert(/timestamped segments/i.test(voiceoverWhisper.config.instruction), 'Whisper step should request timestamped segment preservation.');
assert(/visualPromptDraft/i.test(voiceoverPacket.config.desiredOutputNotes), 'Planning packet should request scene image prompt drafts.');
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
console.log(`Verified ${BUILT_IN_PIPELINE_TEMPLATES.length} built-in pipeline templates.`);
