const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

function stub(name, overrides) {
  const id = require.resolve('../electron/services/' + name);
  require.cache[id] = { loaded: true, exports: { ...require(id), ...overrides } };
}

async function verifyStore(root) {
  const logger = { info: async () => {}, warn: async () => {}, error: async () => {} };
  stub('configService', {
    ensureStorage: async () => ({ root }),
    getAppPaths: () => ({ managedRoot: root }),
    setToolIgnored: async () => {},
  });
  stub('logService', { createLogger: () => logger });
  const registry = require('../electron/services/toolRegistry');
  await registry.initializeToolRegistry();
  const catalog = registry.getToolCatalog();
  assert.ok(catalog.length);
  const chatterbox = catalog.find(tool => tool.id === 'chatterbox-tts');
  assert.equal(chatterbox.compatibility.minimumVramMb, 6144);
  assert.equal(chatterbox.compatibility.minimumRamMb, 16384);
  assert.equal(registry.getToolManifest(chatterbox.id), registry.getToolManifest(chatterbox.id));

  const ui = buildSync({
    stdin: {
      contents: "export {default as StoreCard} from './src/components/StoreCard'; export * from './src/lib/tool-ui';",
      resolveDir: path.resolve(__dirname, '..'),
    },
    write: false, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/*'],
  });
  const renderExports = {};
  Function('require', 'module', ui.outputFiles[0].text)(require, renderExports);
  const { StoreCard, evaluateCompatibility, toolSearchText } = renderExports.exports;
  const hardware = { vramMb: 4096, systemRamMb: 16384 };
  assert.equal(evaluateCompatibility(chatterbox, hardware).label, 'Below spec');
  for (const manifest of catalog) {
    const props = { manifest, compatibility: evaluateCompatibility(manifest, hardware), onInstall: () => {} };
    const html = renderToStaticMarkup(React.createElement(StoreCard, props));
    assert.ok(html.includes('Install details') && html.includes('<button'));
    assert.ok(toolSearchText(manifest).includes(manifest.id));
    assert.equal(StoreCard.compare(props, { ...props, onInstall: () => {} }), false);
    if (manifest.installCapabilities?.length > 1) {
      const busy = renderToStaticMarkup(React.createElement(StoreCard, { ...props, busy: 'webui' }));
      assert.equal((busy.match(/<button[^>]*disabled/g) || []).length, manifest.installCapabilities.length);
      assert.equal((busy.match(/Installing\.\.\./g) || []).length, 1);
    }
  }

  const manifestServicePath = require.resolve('../electron/services/manifestService');
  delete require.cache[manifestServicePath];
  const manifestService = require(manifestServicePath);
  const pathExists = fs.pathExists;
  const bundle = path.resolve(__dirname, '../electron/config/tools-manifest.json');
  try {
    fs.pathExists = file => file === bundle ? Promise.resolve(false) : pathExists(file);
    assert.equal((await manifestService.loadToolManifest()).length, catalog.length);
    assert.equal(manifestService.getManifestStatus().source, 'cache');
    assert.equal(manifestService.getManifestStatus().verified, true);
  } finally {
    fs.pathExists = pathExists;
  }

  let blocked = false;
  stub('hyperFramesService', {
    getHyperFramesInstallPreflight: async () => ({ blocked, toolName: 'HyperFrames', mount: root }),
    installManagedHyperFrames: async () => { throw new Error('Simulated runtime failure'); },
  });
  stub('toolDiscoveryService', { syncDiscoveredTools: async () => { throw new Error('Simulated discovery failure'); } });
  stub('supportEventService', { recordSupportEvent: () => {} });
  stub('storageMaintenanceService', {
    getDiskPreflight: async (_target, requiredBytes) => ({ requiredBytes }),
  });
  const { installTool, getToolInstallPreflight } = require('../electron/services/installerService');
  const companion = catalog.find(tool => tool.companionDesktop);
  let total = '1200000000';
  let cancelled = 0;
  const originalFetch = global.fetch;
  global.fetch = async (_url, { method }) => {
    if (method === 'HEAD') return new Response(null, { status: 405 });
    return new Response(new ReadableStream({ cancel: () => { cancelled++; } }), {
      status: 206,
      headers: { 'content-length': '1', 'content-range': `bytes 0-0/${total}` },
    });
  };
  try {
    const request = { toolId: companion.id, capability: 'desktop', installRoot: root };
    const measured = await getToolInstallPreflight(request);
    assert.equal(measured.requiredBytes, Number(total));
    assert.equal(measured.sizeKnown, true);
    assert.equal(measured.capability, 'desktop');
    total = '*';
    assert.equal((await getToolInstallPreflight(request)).sizeKnown, false);
    assert.equal(cancelled, 2);
  } finally {
    global.fetch = originalFetch;
  }
  const install = toolId => installTool(toolId, { installRoot: root });
  await assert.rejects(getToolInstallPreflight({ toolId: 'hyperframes', installRoot: 'relative' }), /full install folder path/);
  const toolDir = id => path.join(root, 'tools', id);
  blocked = true;
  await assert.rejects(install('hyperframes'), /Clear space/);
  assert.equal(await fs.pathExists(toolDir('hyperframes')), false);
  blocked = false;
  await assert.rejects(install('hyperframes'), /Simulated runtime failure/);
  assert.equal(await fs.pathExists(toolDir('hyperframes')), false);
  for (const id of ['hyperframes', 'comfyui']) {
    const marker = path.join(toolDir(id), 'existing.txt');
    await fs.outputFile(marker, 'keep');
    await assert.rejects(install(id), /Simulated (runtime|discovery) failure/);
    assert.equal(await fs.readFile(marker, 'utf8'), 'keep');
  }
  console.log(`Store verification passed for ${catalog.length} catalog cards, signed-cache fallback, and install failure cleanup.`);
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-store-review-'));
  try {
    await verifyStore(root);
  } finally {
    await fs.remove(root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
