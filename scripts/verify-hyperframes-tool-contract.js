const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  getToolPipelineCapabilities,
  getToolPipelineStrategy,
} = require('../electron/shared/pipelineCapabilities.cjs');

const repoRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'electron/config/tools-manifest.json'), 'utf8'));
const hyperframes = manifest.find((tool) => tool.id === 'hyperframes');
assert(hyperframes, 'HyperFrames must be present in the manifest.');

assert.strictEqual(hyperframes.name, 'HyperFrames', 'HyperFrames display name should be stable.');
assert.strictEqual(hyperframes.category, 'Video tools', 'HyperFrames should be categorized as a local video/media tool.');
assert.strictEqual(hyperframes.interfaceMode, 'pipeline-only', 'HyperFrames must not expose a launch/render surface in pass 1.');
assert.strictEqual(hyperframes.installInstructions.kind, 'npm-package', 'HyperFrames should use the managed npm-package lifecycle.');
assert.strictEqual(hyperframes.installInstructions.runtime, 'node', 'HyperFrames should declare its external Node runtime dependency.');
assert.strictEqual(hyperframes.installInstructions.npmPackage, 'hyperframes', 'HyperFrames package name should be explicit.');
assert.strictEqual(hyperframes.installInstructions.npmVersion, '0.6.112', 'HyperFrames package version should be exact.');
assert.strictEqual(hyperframes.installInstructions.pinnedPackage, 'hyperframes@0.6.112', 'HyperFrames package spec must be pinned exactly.');
assert(/Renders local HTML video compositions to MP4/.test(hyperframes.description), 'HyperFrames description should be factual and not describe AI generation.');
assert(!/AI model|model runtime|generation backend/i.test(hyperframes.description), 'HyperFrames should not be described as an AI backend.');
assert(hyperframes.setupNotes.some((note) => /Node\.js 22 or newer and npm/i.test(note)), 'Store setup notes must mention Node.js 22+ and npm.');
assert(hyperframes.setupNotes.some((note) => /FFmpeg, FFprobe, npm cache, temporary workspace, and Chrome Headless Shell/i.test(note)), 'Store setup notes must mention managed FFmpeg/FFprobe/npm/temp/browser.');
assert(hyperframes.setupNotes.some((note) => /significant disk space/i.test(note)), 'Store setup notes must mention disk usage.');
assert(hyperframes.setupNotes.some((note) => /HTML\/CSS\/JavaScript/i.test(note) && /trust/i.test(note)), 'Store setup notes must include the trusted composition warning.');

const registrySource = fs.readFileSync(path.join(repoRoot, 'electron/services/toolRegistry.js'), 'utf8');
assert(registrySource.includes('npmPackage: installInstructions.npmPackage'), 'Tool registry should preserve npm package metadata.');
assert(registrySource.includes('setupNotes'), 'Tool catalog should expose setup notes to Store.');

const storeCardSource = fs.readFileSync(path.join(repoRoot, 'src/components/StoreCard.jsx'), 'utf8');
assert(storeCardSource.includes('manifest.setupNotes'), 'Store card should render focused setup notes.');
const libraryCardSource = fs.readFileSync(path.join(repoRoot, 'src/components/LibraryCard.jsx'), 'utf8');
assert(libraryCardSource.includes('hyperFramesStatusItems'), 'Library card should render HyperFrames runtime readiness chips.');
assert(libraryCardSource.includes('Rendering UI and pipeline nodes are not enabled in this pass'), 'Library card should avoid implying render support.');

assert.strictEqual(getToolPipelineStrategy('hyperframes'), null, 'HyperFrames must not gain a pipeline strategy in pass 1.');
assert.deepStrictEqual(Object.keys(getToolPipelineCapabilities('hyperframes')?.operations || {}), [], 'HyperFrames must not gain render/pipeline operations in pass 1.');

const sourceCorpus = [
  fs.readFileSync(path.join(repoRoot, 'electron/services/hyperFramesService.js'), 'utf8'),
  fs.readFileSync(path.join(repoRoot, 'electron/services/installerService.js'), 'utf8'),
  storeCardSource,
  libraryCardSource,
].join('\n');
assert(!/HyperFrames Render button|Render button|composition chooser|Studio embedding|Preview button/i.test(sourceCorpus), 'Pass 1 must not add HyperFrames render/editor/preview UI.');
assert(!/HYPERFRAMES_BROWSER_PATH\s*=\s*['"]C:/i.test(sourceCorpus), 'HyperFrames browser override must not hard-code the user C: cache.');

console.log('HyperFrames tool contract verifier passed.');