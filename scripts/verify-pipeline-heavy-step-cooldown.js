const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const schema = require(path.join(root, 'electron', 'shared', 'pipelineSchema.cjs'));
const executionSource = fs.readFileSync(path.join(root, 'electron', 'services', 'pipelineExecutionService.js'), 'utf8');
const builderSource = fs.readFileSync(path.join(root, 'src', 'components', 'PipelineBuilderPanel.jsx'), 'utf8');
const localAudioSource = fs.readFileSync(path.join(root, 'electron', 'services', 'localAudioService.js'), 'utf8');
const audiocraftHelperSource = fs.readFileSync(path.join(root, 'electron', 'helpers', 'run_audiocraft_pipeline_task.py'), 'utf8');

const empty = schema.createEmptyPipeline();
assert.deepStrictEqual(empty.runSettings, {
  enableHeavyStepCooldown: false,
  heavyStepCooldownSeconds: 0,
}, 'new pipelines should default heavy-step cooldown off with 0 seconds.');

const normalized = schema.normalizePipelineDefinition({
  runSettings: {
    enableHeavyStepCooldown: true,
    heavyStepCooldownSeconds: 999,
  },
});
assert.strictEqual(normalized.runSettings.enableHeavyStepCooldown, true, 'cooldown enabled flag should persist.');
assert.strictEqual(normalized.runSettings.heavyStepCooldownSeconds, 300, 'cooldown seconds should clamp to the 0-300 second range.');

const negative = schema.normalizePipelineDefinition({
  runSettings: {
    enableHeavyStepCooldown: true,
    heavyStepCooldownSeconds: -10,
  },
});
assert.strictEqual(negative.runSettings.heavyStepCooldownSeconds, 0, 'negative cooldown seconds should clamp to 0.');

assert(builderSource.includes('Cooldown between heavy local steps'), 'Pipeline Builder should expose the cooldown checkbox.');
assert(builderSource.includes('Cooldown seconds'), 'Pipeline Builder should expose the cooldown seconds field.');
assert(builderSource.includes('HEAVY_STEP_COOLDOWN_MAX_SECONDS'), 'Pipeline Builder should use the shared cooldown range.');
assert(builderSource.includes('normalizePipelineRunSettings'), 'Pipeline Builder should persist bounded run settings.');

assert(executionSource.includes('HEAVY_LOCAL_PIPELINE_OPERATION_IDS'), 'execution should centralize first-pass heavy local operation classification.');
for (const operationId of ['IMAGE_GENERATE', 'IMAGE_TRANSFORM', 'AUDIO_GENERATE', 'AUDIO_TRANSFORM', 'VIDEO_GENERATE']) {
  assert(executionSource.includes('PIPELINE_OPERATION_IDS.' + operationId), operationId + ' should be classified for heavy local cooldown.');
}
const heavyOperationSet = executionSource.match(/const HEAVY_LOCAL_PIPELINE_OPERATION_IDS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
assert(!heavyOperationSet.includes('WHISPER_TRANSCRIBE'), 'Whisper transcription should not be classified as heavy by default.');
assert(executionSource.includes("node.type === 'graphWorkflow'"), 'graph workflow nodes should be considered for local heavy cooldown.');
assert(executionSource.includes("toolId === 'comfyui' || toolId === 'invokeai'"), 'ComfyUI/InvokeAI graph workflows should be treated as heavy local steps.');

assert(executionSource.includes('if (nodeIsHeavyLocal && completedHeavyLocalStep)'), 'top-level execution should not cool down before the first heavy local step.');
assert(executionSource.includes('completedHeavyLocalStep = true'), 'top-level execution should remember completed heavy local steps.');
assert(executionSource.includes('if (useItemCooldown && index > 0)'), 'collectionMap should cool down between heavy local items, not before item 1.');
assert(executionSource.includes('PipelineCancelledError') && executionSource.includes('signal?.aborted'), 'cooldown waits should be interruptible by cancellation.');
assert(executionSource.includes('cooldownWaitCount'), 'run metadata should count inserted cooldown waits.');

for (const deterministicNode of ['audioStitch', 'videoStitch', 'normalizeAudioCollection', 'normalizeVideoCollection', 'extractVideoFrame', 'extractAudio', 'trimMedia', 'burnSubtitles', 'exportSubtitles']) {
  const deterministicPattern = "node.type === '" + deterministicNode + "'";
  assert(!executionSource.includes(deterministicPattern + ' &&'), deterministicNode + ' should not be directly classified as heavy local cooldown work.');
}

assert(localAudioSource.includes('heavyStepCooldownSeconds'), 'AudioCraft local audio requests should carry repeat cooldown seconds.');
assert(localAudioSource.includes('signal: options.cancelSignal || null'), 'AudioCraft helper process should receive the cancellation signal.');
assert(audiocraftHelperSource.includes('heavy_step_cooldown_seconds'), 'AudioCraft helper should parse repeat cooldown seconds.');
assert(audiocraftHelperSource.includes('repeat_index > 1') && audiocraftHelperSource.includes('time.sleep(heavy_step_cooldown_seconds)'), 'AudioCraft helper should wait between continuation repeats only.');

console.log('Heavy local pipeline cooldown verifier passed.');
