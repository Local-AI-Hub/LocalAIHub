const assert = require('assert');
const http = require('http');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-forge-pipeline-readiness');
const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'home' || name === 'appData') return TEST_STORAGE_ROOT;
          if (name === 'exe') return process.execPath;
          return process.cwd();
        },
        getVersion() {
          return '0.21.0-test';
        },
        isPackaged: false,
      },
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const { buildExternalLaunchProfile, buildManagedLaunchProfile, getToolManifest, initializeToolRegistry } = require('../electron/services/toolRegistry');
const { isToolActive, isToolReady } = require('../electron/services/processService');
const { generateImageWithWorkflowTool } = require('../electron/services/workflowToolService');
const {
  buildStableDiffusionCheckpointOption,
  findStableDiffusionCheckpointMatch,
  getStableDiffusionCheckpointModels,
  normalizeStableDiffusionCheckpointEntry,
} = require('../electron/shared/toolAssetSelection.cjs');

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  const port = await listen(server);
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  await initializeToolRegistry();
  const forge = getToolManifest('forge');
  const automatic1111 = getToolManifest('automatic1111');

  assert(forge, 'Forge should be present in the tool registry.');
  assert.strictEqual(
    forge.healthUrl,
    'http://127.0.0.1:7860/sdapi/v1/sd-models',
    'Forge pipeline readiness should use a Stable Diffusion WebUI API endpoint that avoids the cmd-flags response schema.',
  );
  assert.strictEqual(
    automatic1111.healthUrl,
    'http://127.0.0.1:7860/sdapi/v1/sd-models',
    'Automatic1111 should use the same Stable Diffusion WebUI model-list readiness endpoint.',
  );
  const liveCheckpointEntry = normalizeStableDiffusionCheckpointEntry({
    title: 'v1-5-pruned-emaonly.safetensors [6ce0161689]',
    model_name: 'v1-5-pruned-emaonly',
    filename: 'D:/LocalAIHub/tools/forge/app/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors',
    hash: '6ce0161689',
    sha256: '0123456789abcdef',
  }, forge, { backendVisible: true });
  const liveCheckpointOption = buildStableDiffusionCheckpointOption(liveCheckpointEntry, 'forge');
  assert.strictEqual(liveCheckpointOption.id, 'v1-5-pruned-emaonly.safetensors [6ce0161689]', 'UI checkpoint option id should use the shared canonical WebUI title value.');
  assert.strictEqual(liveCheckpointOption.backendVisible, true, 'Live checkpoint options should be marked backend-visible.');
  assert(liveCheckpointOption.aliases.includes('v1-5-pruned-emaonly.safetensors'), 'Live checkpoint aliases should include the hashless basename.');
  const localOnlyOption = buildStableDiffusionCheckpointOption({ fileName: 'disk-only.safetensors', modelType: 'checkpoint', backendVisible: false }, 'forge');
  assert.strictEqual(localOnlyOption.backendVisible, false, 'Disk fallback checkpoint options should remain visually distinguishable from live backend options.');
  assert.strictEqual(getStableDiffusionCheckpointModels([localOnlyOption], { requireBackendVisible: true }).length, 0, 'Disk fallback checkpoint options should not be treated as verified live backend models.');
  const localFileEntry = { fileName: 'v1-5-pruned-emaonly.safetensors', modelType: 'checkpoint', path: 'D:/LocalAIHub/tools/forge/app/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors' };
  assert(findStableDiffusionCheckpointMatch([localFileEntry], liveCheckpointOption.id), 'A UI-selected WebUI title with hash should match the same local file basename.');
  for (const alias of [liveCheckpointEntry.title, liveCheckpointEntry.model_name, 'v1-5-pruned-emaonly.safetensors', liveCheckpointEntry.filename, liveCheckpointEntry.hash, liveCheckpointEntry.sha256]) {
    assert(findStableDiffusionCheckpointMatch([liveCheckpointEntry], alias), 'Runtime checkpoint matching should accept alias: ' + alias);
  }

  const managedForgeProfile = buildManagedLaunchProfile({
    appDir: path.join(TEST_STORAGE_ROOT, 'tools', 'forge', 'app'),
    installDir: path.join(TEST_STORAGE_ROOT, 'tools', 'forge'),
    venvDir: path.join(TEST_STORAGE_ROOT, 'tools', 'forge', '.venv'),
  }, forge);
  const externalForgeProfile = buildExternalLaunchProfile(
    forge,
    path.join(TEST_STORAGE_ROOT, 'external-forge'),
    path.join(TEST_STORAGE_ROOT, 'external-forge', 'webui-user.bat'),
  );
  assert(
    Array.isArray(managedForgeProfile?.args) && managedForgeProfile.args.includes('--api'),
    'Managed Forge launch profile should include --api.',
  );
  assert(
    Array.isArray(externalForgeProfile?.args) && externalForgeProfile.args.includes('--api'),
    'External Forge launch profile should include --api.',
  );

  await withServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html>Forge UI</html>');
      return;
    }

    if (request.url === '/sdapi/v1/cmd-flags') {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{"detail":[{"loc":["response","port"],"msg":"Input should be a valid string","input":7860}]}');
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"detail":"not found"}');
  }, async (port) => {
    const tool = {
      id: 'forge',
      name: 'Stable Diffusion WebUI Forge',
      launchUrl: `http://127.0.0.1:${port}`,
      healthUrl: `http://127.0.0.1:${port}/sdapi/v1/sd-models`,
      processNames: [],
      status: 'running',
    };

    assert.strictEqual(await isToolActive(tool), true, 'Forge root page should count as active so Local AI Hub does not start a second copy on the same port.');
    assert.strictEqual(await isToolReady(tool), false, 'Forge should not count as pipeline-ready until the selected API health endpoint answers.');
  });

  await withServer((request, response) => {
    if (request.url === '/sdapi/v1/sd-models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[]');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html>Forge UI</html>');
  }, async (port) => {
    const tool = {
      id: 'forge',
      name: 'Stable Diffusion WebUI Forge',
      launchUrl: `http://127.0.0.1:${port}`,
      healthUrl: `http://127.0.0.1:${port}/sdapi/v1/sd-models`,
      processNames: [],
      status: 'running',
    };

    assert.strictEqual(await isToolActive(tool), true, 'Forge should be active when its API endpoint answers.');
    assert.strictEqual(await isToolReady(tool), true, 'Forge should be pipeline-ready when the Stable Diffusion WebUI model-list API answers.');
  });

  await withServer((request, response) => {
    if (request.url === '/sdapi/v1/sd-models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[{"title":"realisticVision.safetensors","model_name":"realisticVision","filename":"D:/models/realisticVision.safetensors"}]');
      return;
    }

    if (request.url === '/sdapi/v1/txt2img') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ images: [ONE_PIXEL_PNG], info: '{}' }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"detail":"not found"}');
  }, async (port) => {
    const generated = await generateImageWithWorkflowTool({
      id: 'forge',
      name: 'Stable Diffusion WebUI Forge',
      launchUrl: `http://127.0.0.1:${port}`,
      status: 'running',
    }, { prompt: 'test prompt' });
    assert.strictEqual(generated.base64Image, ONE_PIXEL_PNG, 'API-ready Forge should complete the shared image generation request path.');
  });

  await withServer((request, response) => {
    if (request.url === '/sdapi/v1/sd-models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[{"title":"safety_checker\\\\model.fp16.safetensors","model_name":"safety_checker_model.fp16","filename":"D:/LocalAIHub/tools/forge/app/models/Stable-diffusion/safety_checker/model.fp16.safetensors"}]');
      return;
    }

    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end('{"detail":"txt2img should not be reached"}');
  }, async (port) => {
    await assert.rejects(
      () => generateImageWithWorkflowTool({
        id: 'forge',
        name: 'Stable Diffusion WebUI Forge',
        launchUrl: `http://127.0.0.1:${port}`,
        status: 'running',
      }, { prompt: 'test prompt' }),
      /API is reachable, but its model list only shows non-generation support files.*safety_checker/i,
      'Safety-checker-only model lists should be reported as a checkpoint problem, not connectivity.',
    );
  });

  await withServer((request, response) => {
    if (request.url === '/sdapi/v1/sd-models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[{"title":"realisticVision.safetensors","model_name":"realisticVision","filename":"D:/models/realisticVision.safetensors"}]');
      return;
    }

    if (request.url === '/sdapi/v1/txt2img') {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{"detail":[{"loc":["body","prompt"],"msg":"Generation failed after API readiness"}]}');
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"detail":"not found"}');
  }, async (port) => {
    await assert.rejects(
      () => generateImageWithWorkflowTool({
        id: 'forge',
        name: 'Stable Diffusion WebUI Forge',
        launchUrl: `http://127.0.0.1:${port}`,
        status: 'running',
      }, { prompt: 'test prompt' }),
      /API request to \/sdapi\/v1\/txt2img returned 500.*body\.prompt: Generation failed after API readiness/i,
      'txt2img HTTP failures should not be rewritten as not answering.',
    );
  });

  await withServer((request, response) => {
    if (request.url === '/sdapi/v1/sd-models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[{"title":"v1-5-pruned-emaonly.safetensors [6ce0161689]","model_name":"v1-5-pruned-emaonly","filename":"D:/LocalAIHub/tools/forge/app/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors","hash":"6ce0161689"}]');
      return;
    }

    if (request.url === '/sdapi/v1/txt2img') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const payload = JSON.parse(body || '{}');
        assert.strictEqual(payload.override_settings.sd_model_checkpoint, 'v1-5-pruned-emaonly.safetensors [6ce0161689]', 'A filename checkpoint override should match the live WebUI title and send the backend canonical title.');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ images: [ONE_PIXEL_PNG], info: '{}' }));
      });
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"detail":"not found"}');
  }, async (port) => {
    const generated = await generateImageWithWorkflowTool({
      id: 'forge',
      name: 'Stable Diffusion WebUI Forge',
      launchUrl: 'http://127.0.0.1:' + port,
      status: 'running',
    }, { model: 'v1-5-pruned-emaonly.safetensors', prompt: 'test prompt' });
    assert.strictEqual(generated.base64Image, ONE_PIXEL_PNG, 'Filename checkpoint overrides should complete when the backend lists that model.');
  });

  const runtimeAliases = [
    'v1-5-pruned-emaonly.safetensors [6ce0161689]',
    'v1-5-pruned-emaonly',
    'v1-5-pruned-emaonly.safetensors',
    'D:/LocalAIHub/tools/forge/app/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors',
    '6ce0161689',
    '0123456789abcdef',
  ];
  for (const alias of runtimeAliases) {
    await withServer((request, response) => {
      if (request.url === '/sdapi/v1/sd-models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('[{"title":"v1-5-pruned-emaonly.safetensors [6ce0161689]","model_name":"v1-5-pruned-emaonly","filename":"D:/LocalAIHub/tools/forge/app/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors","hash":"6ce0161689","sha256":"0123456789abcdef"}]');
        return;
      }

      if (request.url === '/sdapi/v1/txt2img') {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          const payload = JSON.parse(body || '{}');
          assert.strictEqual(payload.override_settings.sd_model_checkpoint, 'v1-5-pruned-emaonly.safetensors [6ce0161689]', 'Alias ' + alias + ' should resolve to the backend canonical title.');
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ images: [ONE_PIXEL_PNG], info: '{}' }));
        });
        return;
      }

      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end('{"detail":"not found"}');
    }, async (port) => {
      const generated = await generateImageWithWorkflowTool({
        id: 'forge',
        name: 'Stable Diffusion WebUI Forge',
        launchUrl: 'http://127.0.0.1:' + port,
        status: 'running',
      }, { model: alias, prompt: 'test prompt' });
      assert.strictEqual(generated.base64Image, ONE_PIXEL_PNG, 'Checkpoint alias should complete when the backend lists that model: ' + alias);
    });
  }

  await withServer((request, response) => {
    if (request.url === '/sdapi/v1/sd-models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[{"title":"availableModel.safetensors","model_name":"availableModel","filename":"D:/models/availableModel.safetensors"}]');
      return;
    }

    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end('{"detail":"txt2img should not be reached"}');
  }, async (port) => {
    await assert.rejects(
      () => generateImageWithWorkflowTool({
        id: 'forge',
        name: 'Stable Diffusion WebUI Forge',
        launchUrl: 'http://127.0.0.1:' + port,
        status: 'running',
      }, { model: 'missingModel.safetensors', prompt: 'test prompt' }),
      /Selected checkpoint is not available in the live Stable Diffusion WebUI Forge model list.*Selected value: "missingModel\.safetensors".*Runtime source: live \/sdapi\/v1\/sd-models.*Available checkpoints: availableModel\.safetensors/i,
      'Missing selected checkpoints should include selected value, live source, and available backend labels.',
    );
  });

  await withServer((request, response) => {
    if (request.url === '/sdapi/v1/sd-models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[]');
      return;
    }

    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end('{"detail":"txt2img should not be reached"}');
  }, async (port) => {
    await assert.rejects(
      () => generateImageWithWorkflowTool({
        id: 'forge',
        name: 'Stable Diffusion WebUI Forge',
        launchUrl: 'http://127.0.0.1:' + port,
        status: 'running',
        downloadedModels: [{ fileName: 'v1-5-pruned-emaonly.safetensors', modelType: 'checkpoint', path: 'D:/LocalAIHub/tools/forge/app/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors' }],
      }, { prompt: 'test prompt' }),
      /can see downloaded checkpoint files locally.*live WebUI API is not listing them/i,
      'Downloaded local checkpoints that are absent from the live backend list should be diagnosed as a path or refresh mismatch.',
    );
  });

  await assert.rejects(
    () => generateImageWithWorkflowTool({
      id: 'forge',
      name: 'Stable Diffusion WebUI Forge',
      launchUrl: 'http://127.0.0.1:9',
      status: 'running',
    }, { prompt: 'test prompt' }),
    /not answering on http:\/\/127\.0\.0\.1:9.*\/sdapi\/v1\/sd-models/i,
    'Connection failures should keep the not-answering diagnostic and include the exact URL.',
  );
  console.log('Forge pipeline readiness verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

