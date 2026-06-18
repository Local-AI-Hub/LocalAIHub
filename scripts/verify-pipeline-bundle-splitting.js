const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const readSource = (...segments) => fs.readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');
const pathExists = (...segments) => fs.existsSync(path.join(repoRoot, ...segments));

const appSource = readSource('src', 'App.jsx');
const pipelineSource = readSource('src', 'components', 'PipelineBuilderPanel.jsx');
const viteSource = readSource('vite.config.mjs');

function verifyRootPipelineBoundary() {
  assert(
    appSource.includes("const PipelineBuilderPanel = lazy(() => import('./components/PipelineBuilderPanel'));"),
    'App should lazy-load the Pipelines tab panel.',
  );
  assert(
    !/^import\s+PipelineBuilderPanel\s+from\s+['"]\.\/components\/PipelineBuilderPanel['"];?/m.test(appSource),
    'App should not eagerly import PipelineBuilderPanel.',
  );
  assert(
    appSource.includes('Loading Pipelines...') && appSource.includes('<Suspense fallback='),
    'Pipelines should retain a Suspense fallback around the lazy tab panel.',
  );
}

function verifyPipelineOnlyDynamicImports() {
  assert(
    !pipelineSource.includes("import pipelineWizardShared from '../../electron/shared/pipelineWizard.cjs';"),
    'Pipeline wizard compiler helpers should not be statically imported by PipelineBuilderPanel.',
  );
  assert(
    !pipelineSource.includes("import pipelineWizardLifecycleShared from '../../electron/shared/pipelineWizardLifecycle.cjs';"),
    'Pipeline wizard lifecycle helpers should not be statically imported by PipelineBuilderPanel.',
  );
  assert(
    pipelineSource.includes("import('../../electron/shared/pipelineWizard.cjs')"),
    'Pipeline wizard compiler helpers should be loaded through a dynamic import boundary.',
  );
  assert(
    pipelineSource.includes("import('../../electron/shared/pipelineWizardLifecycle.cjs')"),
    'Pipeline wizard lifecycle helpers should be loaded through a dynamic import boundary.',
  );
  assert(
    pipelineSource.includes("const AssetLibraryManager = React.lazy(() => import('./AssetLibraryManager'));"),
    'Pipeline Resources should lazy-load AssetLibraryManager.',
  );
  assert(
    pipelineSource.includes("const PromptStylePresetManager = React.lazy(() => import('./PromptStylePresetManager'));"),
    'Pipeline Resources should lazy-load PromptStylePresetManager.',
  );
  assert(
    pipelineSource.includes('loadPipelineWizardModules') && pipelineSource.includes('await loadPipelineWizardModules()'),
    'Wizard generation should load wizard modules on demand.',
  );
}

function verifyWarningWasNotHidden() {
  assert(
    /chunkSizeWarningLimit:\s*550\b/.test(viteSource),
    'Vite chunk warning limit should remain at the existing 550 kB threshold.',
  );
  assert(
    !/chunkSizeWarningLimit:\s*(?:[6-9]\d\d|[1-9]\d{3,})\b/.test(viteSource),
    'The large chunk warning should not be hidden by raising the threshold.',
  );
  assert(
    viteSource.includes("return 'pipeline-templates';"),
    'The existing pipeline templates chunk boundary should remain explicit.',
  );
}

function verifyBuiltChunks() {
  assert(pathExists('dist', 'index.html'), 'Run npm run build:ui before this verifier so dist/index.html exists.');
  const assetsDir = path.join(repoRoot, 'dist', 'assets');
  assert(fs.existsSync(assetsDir), 'Run npm run build:ui before this verifier so dist/assets exists.');

  const jsAssets = fs.readdirSync(assetsDir)
    .filter((fileName) => fileName.endsWith('.js'))
    .map((fileName) => ({
      fileName,
      sizeBytes: fs.statSync(path.join(assetsDir, fileName)).size,
    }));

  const pipelineChunks = jsAssets.filter((asset) => asset.fileName.startsWith('PipelineBuilderPanel-'));
  assert(pipelineChunks.length > 0, 'Build output should include a PipelineBuilderPanel chunk.');
  for (const chunk of pipelineChunks) {
    assert(
      chunk.sizeBytes <= 550 * 1024,
      `PipelineBuilderPanel chunk should stay below the 550 kB warning limit; ${chunk.fileName} is ${chunk.sizeBytes} bytes.`,
    );
  }

  assert(
    jsAssets.some((asset) => asset.fileName.startsWith('pipelineWizard-')),
    'Build output should include a separate pipelineWizard dynamic chunk.',
  );
  assert(
    jsAssets.some((asset) => asset.fileName.startsWith('pipelineWizardLifecycle-')),
    'Build output should include a separate pipelineWizardLifecycle dynamic chunk.',
  );
  assert(
    jsAssets.some((asset) => asset.fileName.startsWith('AssetLibraryManager-')),
    'Build output should include a separate AssetLibraryManager dynamic chunk.',
  );
  assert(
    jsAssets.some((asset) => asset.fileName.startsWith('PromptStylePresetManager-')),
    'Build output should include a separate PromptStylePresetManager dynamic chunk.',
  );
  assert(
    jsAssets.some((asset) => asset.fileName.startsWith('pipeline-templates-')),
    'Build output should retain the existing pipeline templates chunk.',
  );
}

verifyRootPipelineBoundary();
verifyPipelineOnlyDynamicImports();
verifyWarningWasNotHidden();
verifyBuiltChunks();

console.log('Pipeline bundle splitting verification passed.');
