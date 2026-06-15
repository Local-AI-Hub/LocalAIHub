const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  PIPELINE_OPERATION_IDS,
  TOOL_PIPELINE_STRATEGY_IDS,
  getToolPipelineCapabilities,
  getToolPipelineStrategy,
} = require('../electron/shared/pipelineCapabilities.cjs');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'electron', 'config', 'tools-manifest.json');
const contractPath = path.join(repoRoot, 'docs', 'internal-tool-integration-contract.md');
const graphContractsPath = path.join(repoRoot, 'electron', 'shared', 'graphWorkflowContracts.cjs');
const diagnosticsPath = path.join(repoRoot, 'electron', 'services', 'diagnosticsService.js');
const verifyScriptsRoot = path.join(repoRoot, 'scripts');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const contractText = fs.readFileSync(contractPath, 'utf8');
const graphContractsText = fs.readFileSync(graphContractsPath, 'utf8');
const diagnosticsText = fs.readFileSync(diagnosticsPath, 'utf8');
const warnings = [];

const readinessExceptions = new Map([
  ['lmstudio', 'Desktop app readiness uses process/vendor-app confirmation.'],
  ['gpt4all', 'Desktop app readiness uses process/vendor-app confirmation.'],
  ['jan', 'Desktop app readiness uses process/vendor-app confirmation.'],
  ['opencode', 'Desktop app readiness uses process/vendor-app confirmation.'],
  ['upscayl', 'Desktop app readiness uses process/vendor-app confirmation.'],
  ['whisper', 'Embedded transcription readiness uses task/import checks.'],
  ['aider', 'Embedded terminal readiness uses interactive session checks.'],
]);

function warn(message) {
  warnings.push(message);
}

function hasText(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

assert(Array.isArray(manifest) && manifest.length > 0, 'The bundled tool manifest must contain tools.');
assert(fs.existsSync(contractPath), 'The internal tool integration contract document must exist.');

for (const heading of [
  '## Purpose',
  '## Required Integration Fields And Concepts',
  '## Current Architecture Map',
  '## Integration Checklist',
  '## Known Gaps And Follow-Up Recommendations',
  '## What This Is Not',
]) {
  assert(contractText.includes(heading), `The internal contract must include ${heading}.`);
}

assert(contractText.includes('Not a public plugin SDK.'), 'The contract must state that it is not a public plugin SDK.');
assert(contractText.includes('not imply it') || contractText.includes('does not imply it'), 'The contract must explain that Store presence does not imply pipeline support.');

const seenIds = new Set();
const verificationCorpus = fs.readdirSync(verifyScriptsRoot)
  .filter((name) => /^verify-.*\.js$/i.test(name))
  .map((name) => fs.readFileSync(path.join(verifyScriptsRoot, name), 'utf8'))
  .join('\n');

for (const tool of manifest) {
  assert(tool && typeof tool === 'object', 'Every manifest entry must be an object.');
  assert(hasText(tool.id) && /^[a-z0-9][a-z0-9-]*$/.test(tool.id), 'Every manifest tool must have a stable lowercase ID.');
  assert(!seenIds.has(tool.id), `Tool ID ${tool.id} must be unique.`);
  seenIds.add(tool.id);

  assert(hasText(tool.name), `${tool.id} must have a display name.`);
  assert(hasText(tool.category), `${tool.id} must have a category.`);
  assert(hasText(tool.description), `${tool.id} must have help/description text.`);
  assert(hasText(tool.downloadUrl), `${tool.id} must have an install source.`);
  assert(hasText(tool.installInstructions?.kind), `${tool.id} must declare an install plan kind.`);
  assert(hasText(tool.installInstructions?.runtime), `${tool.id} must declare an install runtime.`);
  assert(hasText(tool.installInstructions?.installSummary), `${tool.id} must have plain-English install text.`);
  assert(hasText(tool.launchCommand) || (tool.launchModes || []).some((mode) => hasText(mode?.launchCommand)), `${tool.id} must have launch metadata.`);
  assert(Array.isArray(tool.detectionPaths), `${tool.id} detection paths must be an array.`);

  const hasHttpReadiness = Boolean(tool.healthUrl || tool.healthCheckPath || tool.defaultPort);
  if (!hasHttpReadiness && !readinessExceptions.has(tool.id)) {
    warn(`${tool.id}: no HTTP readiness metadata or documented verifier exception.`);
  }

  if (tool.modelManager?.enabled) {
    assert(Array.isArray(tool.modelManager.sources) && tool.modelManager.sources.length > 0, `${tool.id} Model Manager support must declare sources.`);
    assert(tool.modelManager.defaults && typeof tool.modelManager.defaults === 'object', `${tool.id} Model Manager support must declare defaults.`);
    assert(hasText(tool.modelManager.targetLayout?.basePath), `${tool.id} Model Manager support must declare a base path convention.`);
    assert(tool.modelManager.targetLayout?.directories && Object.keys(tool.modelManager.targetLayout.directories).length > 0, `${tool.id} Model Manager support must declare model directories.`);
  }

  const strategy = getToolPipelineStrategy(tool.id);
  const operations = Object.keys(getToolPipelineCapabilities(tool.id)?.operations || {});
  if (strategy?.id === 'graph-native-workflow') {
    assert(graphContractsText.includes(`${tool.id}: Object.freeze({`), `${tool.id} must have an explicit graph workflow contract.`);
  }
  if (strategy?.id === 'local-operation-tool' || strategy?.id === 'local-model-runtime') {
    assert(operations.length > 0, `${tool.id} pipeline strategy must have typed operation capabilities.`);
  }
  if (!strategy && operations.length > 0) {
    warn(`${tool.id}: has pipeline operations but no explicit pipeline strategy.`);
  }
  if ((strategy || operations.length > 0) && !verificationCorpus.includes(tool.id)) {
    warn(`${tool.id}: pipeline registration has no discoverable focused verifier reference.`);
  }
}

const whisperStrategy = getToolPipelineStrategy('whisper');
const whisperCapabilities = getToolPipelineCapabilities('whisper');
const whisperTranscription = whisperCapabilities?.operations?.[PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE] || null;
assert.strictEqual(whisperStrategy?.id, TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL, 'Whisper must explicitly use the operation-driven local tool pipeline strategy.');
assert.deepStrictEqual(whisperTranscription?.inputKinds, ['audio'], 'Whisper transcription must explicitly accept audio input.');
assert.deepStrictEqual(whisperTranscription?.outputKinds, ['text'], 'Whisper transcription must explicitly produce text output.');
assert(!warnings.some((warning) => warning.startsWith('whisper: has pipeline operations but no explicit pipeline strategy.')), 'The Whisper pipeline strategy audit warning must remain resolved.');
assert.strictEqual(getToolPipelineStrategy('aider'), null, 'Aider must remain outside the pipeline strategy registry.');
assert.deepStrictEqual(Object.keys(getToolPipelineCapabilities('aider')?.operations || {}), [], 'Aider must not gain pipeline operations accidentally.');

assert(diagnosticsText.includes('function summarizeTool(tool, paths)'), 'Diagnostics must retain generic tool integration summaries.');
assert(diagnosticsText.includes('repairAvailable') && diagnosticsText.includes('lifecycleMode'), 'Diagnostics tool summaries must include lifecycle and repair visibility.');

console.log(`Tool integration contract audit passed for ${manifest.length} manifest tools.`);
if (warnings.length) {
  console.log(`Audit warnings (${warnings.length}):`);
  for (const warning of warnings) console.log(`- ${warning}`);
} else {
  console.log('Audit warnings: none.');
}