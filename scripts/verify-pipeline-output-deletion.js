const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const Module = require('module');

function loadModuleWithStubs(moduleRelativePath, stubs = {}) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    const normalizedParent = String(parent?.filename || '').replace(/\\/g, '/');
    for (const [suffix, stubMap] of Object.entries(stubs)) {
      if (normalizedParent.endsWith(suffix) && Object.prototype.hasOwnProperty.call(stubMap, request)) {
        return stubMap[request];
      }
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = path.resolve(__dirname, '..', moduleRelativePath);
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createConfigServiceStub(runtimesRoot) {
  return {
    ensureStorage: async () => {},
    getAppPaths: () => ({ runtimesRoot }),
  };
}

function createArtifactServiceStub() {
  const serializeArtifactForUi = (value) => (value ? JSON.parse(JSON.stringify(value)) : null);
  const createJsonArtifact = (kind) => (payload, options = {}) => ({
    kind,
    displayName: options.displayName || kind,
    fileName: options.displayName || `${kind}.json`,
    isFinalOutput: true,
    role: options.role || 'output',
  });

  return {
    buildFileArtifact: async (filePath, options = {}) => ({
      kind: options.kind || (path.extname(filePath).toLowerCase() === '.png' ? 'image' : 'file'),
      displayName: options.displayName || path.basename(filePath),
      fileName: path.basename(filePath),
      filePath,
      destinationPath: filePath,
      isFinalOutput: true,
      role: options.role || 'output',
      summary: path.basename(filePath),
    }),
    createAuditArtifact: createJsonArtifact('audit'),
    createPlanArtifact: createJsonArtifact('plan'),
    createPlanningPacketArtifact: createJsonArtifact('planning-packet'),
    createPreviewArtifact: createJsonArtifact('preview'),
    createTextArtifact: (text, options = {}) => ({
      kind: 'text',
      displayName: options.displayName || 'Text',
      isFinalOutput: true,
      role: options.role || 'output',
      text,
    }),
    serializeArtifactForUi,
    summarizeArtifact: (artifact) => String(artifact?.displayName || artifact?.fileName || artifact?.kind || '').trim(),
  };
}

async function writeFile(filePath, content = 'x') {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content);
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-output-delete-'));
  const runtimesRoot = path.join(tempRoot, 'runtimes');
  const runRoot = path.join(runtimesRoot, 'pipeline-runs', 'run-delete-test');
  const outputsRoot = path.join(runRoot, 'outputs');
  const artifactsRoot = path.join(runRoot, 'artifacts');
  await fs.ensureDir(outputsRoot);
  await fs.ensureDir(artifactsRoot);

  const service = loadModuleWithStubs('electron/services/pipelineOutputStoreService.js', {
    '/electron/services/pipelineOutputStoreService.js': {
      './configService': createConfigServiceStub(runtimesRoot),
      './pipelineArtifactService': createArtifactServiceStub(),
    },
  });

  const configService = loadModuleWithStubs('electron/services/configService.js', {
    '/electron/services/configService.js': {
      electron: {
        app: {
          getPath: (name) => name === 'appData' ? path.join(tempRoot, 'AppData', 'Roaming') : name === 'home' ? tempRoot : path.join(tempRoot, name),
          isPackaged: false,
        },
      },
    },
  });
  assert.strictEqual(configService.createDefaultConfig().moveDeletedPipelineOutputsToRecycleBin, true, 'Pipeline output trash setting should default on.');

  const primaryPath = path.join(outputsRoot, 'final-image.png');
  const sidecarPaths = [
    path.join(outputsRoot, 'final-image.image.json'),
    path.join(outputsRoot, 'final-image.image-analysis.json'),
    path.join(outputsRoot, 'final-image.subtitle.json'),
  ];
  await writeFile(primaryPath, 'png');
  for (const sidecarPath of sidecarPaths) {
    await writeFile(sidecarPath, '{}');
  }

  const deletionSet = await service._test.buildPipelineOutputDeletionSet(primaryPath, outputsRoot);
  assert(deletionSet.includes(primaryPath), 'Deletion set should include the primary output file.');
  for (const sidecarPath of sidecarPaths) {
    assert(deletionSet.includes(sidecarPath), `Deletion set should include ${path.basename(sidecarPath)}.`);
  }
  assert(service._test.isMetadataSidecar('final-image.image-analysis.json'), 'Image analysis sidecars should be recognized.');
  assert(service._test.isMetadataSidecar('final-image.subtitle.json'), 'Subtitle sidecars should be recognized.');

  const discovered = await service.listPipelineOutputs();
  assert(discovered.some((entry) => entry.outputPath === primaryPath), 'Output listing should include the primary file.');
  assert(!discovered.some((entry) => entry.outputPath.endsWith('.image-analysis.json')), 'Output listing should hide image-analysis sidecars.');
  assert(!discovered.some((entry) => entry.outputPath.endsWith('.subtitle.json')), 'Output listing should hide subtitle sidecars.');

  const trashedPaths = [];
  const trashResult = await service.deletePipelineOutput(primaryPath, {
    deleteMode: 'trash',
    trashItem: async (targetPath) => {
      trashedPaths.push(targetPath);
    },
  });
  assert.strictEqual(trashResult.deletionMode, 'trash', 'Trash delete should report trash mode.');
  assert.deepStrictEqual(new Set(trashedPaths), new Set(deletionSet), 'Trash mode should send the full deletion set to trashItem.');
  assert(await fs.pathExists(primaryPath), 'Trash verifier stub should not permanently delete the primary file.');

  const failedTrashPath = path.join(outputsRoot, 'trash-failure.png');
  await writeFile(failedTrashPath, 'png');
  let failedTrash = false;
  try {
    await service.deletePipelineOutput(failedTrashPath, {
      deleteMode: 'trash',
      trashItem: async () => {
        throw new Error('trash unavailable');
      },
    });
  } catch (error) {
    failedTrash = /Recycle Bin/.test(String(error?.message || error));
  }
  assert(failedTrash, 'Trash failure should surface a Recycle Bin error.');
  assert(await fs.pathExists(failedTrashPath), 'Trash failure must not silently fall back to permanent delete.');

  const permanentPath = path.join(outputsRoot, 'permanent.wav');
  const permanentSidecarPath = path.join(outputsRoot, 'permanent.audio.json');
  await writeFile(permanentPath, 'wav');
  await writeFile(permanentSidecarPath, '{}');
  const permanentResult = await service.deletePipelineOutput(permanentPath, { deleteMode: 'permanent' });
  assert.strictEqual(permanentResult.deletionMode, 'permanent', 'Permanent delete should report permanent mode.');
  assert(!(await fs.pathExists(permanentPath)), 'Permanent mode should delete the primary file.');
  assert(!(await fs.pathExists(permanentSidecarPath)), 'Permanent mode should delete adjacent sidecars.');

  const collectionPath = path.join(outputsRoot, 'scene-collection');
  await fs.ensureDir(path.join(collectionPath, 'items'));
  await fs.writeJson(path.join(collectionPath, 'manifest.json'), {
    kind: 'collection',
    isFinalOutput: true,
    role: 'output',
    itemKind: 'image',
    items: [],
  });
  const collectionSet = await service._test.buildPipelineOutputDeletionSet(collectionPath, outputsRoot);
  assert.deepStrictEqual(collectionSet, [collectionPath], 'Collection folders should be deleted as one output unit.');

  await assert.rejects(
    () => service.deletePipelineOutput(outputsRoot, { deleteMode: 'permanent' }),
    /whole outputs folder/,
    'The outputs folder itself must not be deletable.',
  );

  const outsidePath = path.join(tempRoot, 'outside.png');
  await writeFile(outsidePath, 'png');
  await assert.rejects(
    () => service.deletePipelineOutput(outsidePath, { deleteMode: 'permanent' }),
    /known pipeline output folders/,
    'Paths outside known pipeline output folders must be rejected.',
  );

  await fs.remove(tempRoot);
  console.log('Verified safer pipeline output deletion behavior.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
