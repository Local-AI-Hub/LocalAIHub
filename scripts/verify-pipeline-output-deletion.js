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
  return filePath;
}

async function createRun(runtimesRoot, runId) {
  const root = path.join(runtimesRoot, 'pipeline-runs', runId);
  const outputs = path.join(root, 'outputs');
  const artifacts = path.join(root, 'artifacts');
  await fs.ensureDir(outputs);
  await fs.ensureDir(artifacts);
  return { artifacts, outputs, root, runId };
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-output-delete-'));
  const runtimesRoot = path.join(tempRoot, 'runtimes');
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

  const defaultRun = await createRun(runtimesRoot, 'run-default-delete');
  const defaultOutput = await writeFile(path.join(defaultRun.outputs, 'final-image.png'), 'png');
  const defaultSidecars = [
    await writeFile(path.join(defaultRun.outputs, 'final-image.image.json'), '{}'),
    await writeFile(path.join(defaultRun.outputs, 'final-image.image-analysis.json'), '{}'),
    await writeFile(path.join(defaultRun.outputs, 'final-image.subtitle.json'), '{}'),
  ];
  const retainedArtifact = await writeFile(path.join(defaultRun.artifacts, 'generated-image.png'), 'artifact');
  const outsideInput = await writeFile(path.join(tempRoot, 'user-input.png'), 'user');
  const assetLibraryItem = await writeFile(path.join(tempRoot, 'asset-library', 'music.wav'), 'asset');
  await fs.writeJson(path.join(defaultRun.artifacts, 'references.json'), {
    assetLibraryItem,
    outsideInput,
  });

  const defaultSet = await service._test.buildPipelineOutputDeletionSet(defaultOutput, defaultRun.outputs);
  assert(defaultSet.includes(defaultOutput), 'Default deletion set should include the selected output.');
  defaultSidecars.forEach((sidecarPath) => assert(defaultSet.includes(sidecarPath), 'Default deletion set should include adjacent sidecars.'));
  assert(!defaultSet.includes(retainedArtifact), 'Default deletion set must not include intermediate artifacts.');
  const defaultResult = await service.deletePipelineOutput(defaultOutput, { deleteMode: 'permanent' });
  assert.strictEqual(defaultResult.deletedIntermediates, false, 'Default delete should not report intermediate cleanup.');
  assert(!(await fs.pathExists(defaultOutput)), 'Default delete should remove the selected output.');
  for (const sidecarPath of defaultSidecars) assert(!(await fs.pathExists(sidecarPath)), 'Default delete should remove adjacent sidecars.');
  assert(await fs.pathExists(retainedArtifact), 'Default delete should preserve same-run intermediate artifacts.');
  assert(await fs.pathExists(outsideInput), 'User-provided input references outside the run must be preserved.');
  assert(await fs.pathExists(assetLibraryItem), 'Asset library references outside the run must be preserved.');

  const siblingRun = await createRun(runtimesRoot, 'run-sibling-output');
  const selectedSiblingOutput = await writeFile(path.join(siblingRun.outputs, 'selected.mp4'), 'selected');
  const retainedSiblingOutput = await writeFile(path.join(siblingRun.outputs, 'keep.mp4'), 'keep');
  const siblingArtifact = await writeFile(path.join(siblingRun.artifacts, 'generated.wav'), 'generated');
  const otherRun = await createRun(runtimesRoot, 'run-other');
  const otherArtifact = await writeFile(path.join(otherRun.artifacts, 'other-generated.png'), 'other');
  await writeFile(path.join(otherRun.outputs, 'other-output.png'), 'other-output');

  const siblingPreview = await service.buildPipelineOutputDeletionPreview(selectedSiblingOutput, { deleteMode: 'permanent' });
  assert.strictEqual(siblingPreview.artifactSummary.files, 1, 'Preview should count same-run artifact files.');
  assert.strictEqual(siblingPreview.canDeleteWholeRun, false, 'Preview should not offer whole-run deletion while sibling outputs remain.');
  const siblingResult = await service.deletePipelineOutput(selectedSiblingOutput, { deleteMode: 'permanent', includeIntermediates: true });
  assert.strictEqual(siblingResult.deletedIntermediates, true, 'Optional cleanup should report intermediate deletion.');
  assert(!(await fs.pathExists(selectedSiblingOutput)), 'Optional cleanup should delete the selected output.');
  assert(!(await fs.pathExists(siblingArtifact)), 'Optional cleanup should delete same-run artifacts.');
  assert(await fs.pathExists(retainedSiblingOutput), 'Optional cleanup must preserve sibling outputs.');
  assert(await fs.pathExists(otherArtifact), 'Optional cleanup must preserve artifacts from other runs.');
  assert(await fs.pathExists(siblingRun.root), 'Run folder must remain while sibling outputs exist.');
  const outputsAfterSiblingCleanup = await service.listPipelineOutputs();
  assert(outputsAfterSiblingCleanup.some((entry) => entry.outputPath === retainedSiblingOutput), 'Output listing should retain sibling outputs after cleanup.');
  assert(!outputsAfterSiblingCleanup.some((entry) => entry.outputPath === selectedSiblingOutput), 'Output listing should remove the deleted output.');

  const wholeRun = await createRun(runtimesRoot, 'run-whole-cleanup');
  const wholeOutput = await writeFile(path.join(wholeRun.outputs, 'final.mp4'), 'video');
  await writeFile(path.join(wholeRun.artifacts, 'composition', 'manifest.json'), '{}');
  await writeFile(path.join(wholeRun.artifacts, 'composition', 'frame.png'), 'frame');
  const wholePlan = await service._test.buildPipelineOutputDeletionPlan(wholeOutput, { deleteMode: 'permanent', includeIntermediates: true });
  assert.strictEqual(wholePlan.deletesWholeRun, true, 'Safe final-output cleanup should plan whole-run deletion.');
  assert.deepStrictEqual(wholePlan.deletionPaths, [wholeRun.root], 'Whole-run cleanup should stay bounded to the owning run folder.');
  await service.deletePipelineOutput(wholeOutput, { deleteMode: 'permanent', includeIntermediates: true });
  assert(!(await fs.pathExists(wholeRun.root)), 'Safe run folder should be deleted when no outputs remain.');

  const activeRun = await createRun(runtimesRoot, 'run-active');
  const activeOutput = await writeFile(path.join(activeRun.outputs, 'active.png'), 'active');
  const activeArtifact = await writeFile(path.join(activeRun.artifacts, 'active-artifact.png'), 'active-artifact');
  await assert.rejects(
    () => service.deletePipelineOutput(activeOutput, { activeRunId: activeRun.runId, deleteMode: 'permanent', includeIntermediates: true }),
    /currently active/,
    'Intermediate cleanup must reject the active run.',
  );
  assert(await fs.pathExists(activeOutput), 'Active-run rejection should preserve the selected output.');
  assert(await fs.pathExists(activeArtifact), 'Active-run rejection should preserve artifacts.');

  const outsidePath = await writeFile(path.join(tempRoot, 'outside.png'), 'outside');
  await assert.rejects(
    () => service.deletePipelineOutput(outsidePath, { deleteMode: 'permanent', includeIntermediates: true }),
    /known pipeline output folders/,
    'Paths outside known pipeline output folders must be rejected.',
  );

  const traversalRun = await createRun(runtimesRoot, 'run-traversal');
  const traversalOutput = await writeFile(path.join(traversalRun.outputs, 'safe.png'), 'safe');
  await assert.rejects(
    () => service._test.buildPipelineOutputDeletionPlan(path.join(traversalRun.outputs, '..', '..', '..', 'outside.png'), { deleteMode: 'permanent', includeIntermediates: true }),
    /known pipeline output folders/,
    'Traversal outside the owning run must be rejected.',
  );
  assert(await fs.pathExists(traversalOutput), 'Traversal rejection must preserve the legitimate output.');

  const linkRun = await createRun(runtimesRoot, 'run-link');
  const linkOutput = await writeFile(path.join(linkRun.outputs, 'link-test.png'), 'link-output');
  const linkTarget = path.join(tempRoot, 'link-target');
  await fs.ensureDir(linkTarget);
  await writeFile(path.join(linkTarget, 'keep.txt'), 'keep');
  let linkCreated = false;
  try {
    await fs.symlink(linkTarget, path.join(linkRun.artifacts, 'external-link'), 'junction');
    linkCreated = true;
  } catch {
    linkCreated = false;
  }
  if (linkCreated) {
    const linkPreview = await service.buildPipelineOutputDeletionPreview(linkOutput, { deleteMode: 'permanent' });
    assert.strictEqual(linkPreview.intermediateCleanupBlocked, true, 'Link/reparse artifacts should block intermediate cleanup.');
    await assert.rejects(
      () => service.deletePipelineOutput(linkOutput, { deleteMode: 'permanent', includeIntermediates: true }),
      /link or reparse point/,
      'Intermediate cleanup should reject link/reparse paths.',
    );
    await service.deletePipelineOutput(linkOutput, { deleteMode: 'permanent' });
    assert(await fs.pathExists(path.join(linkTarget, 'keep.txt')), 'Default output deletion must not follow artifact links.');
  }

  const trashRun = await createRun(runtimesRoot, 'run-trash');
  const trashOutput = await writeFile(path.join(trashRun.outputs, 'trash.mp4'), 'trash');
  await writeFile(path.join(trashRun.artifacts, 'trash-artifact.wav'), 'trash-artifact');
  const trashedPaths = [];
  const trashResult = await service.deletePipelineOutput(trashOutput, {
    deleteMode: 'trash',
    includeIntermediates: true,
    trashItem: async (targetPath) => {
      trashedPaths.push(targetPath);
      await fs.remove(targetPath);
    },
  });
  assert.strictEqual(trashResult.deletionMode, 'trash', 'Recycle Bin mode should be honored for intermediate cleanup.');
  assert.deepStrictEqual(trashedPaths, [trashRun.root], 'Safe final-output cleanup should send the whole bounded run folder to trash.');
  assert(!(await fs.pathExists(trashRun.root)), 'Trash callback should receive and remove the planned run folder.');

  const failedTrashRun = await createRun(runtimesRoot, 'run-trash-failure');
  const failedTrashOutput = await writeFile(path.join(failedTrashRun.outputs, 'failure.png'), 'failure');
  await assert.rejects(
    () => service.deletePipelineOutput(failedTrashOutput, {
      deleteMode: 'trash',
      trashItem: async () => { throw new Error('trash unavailable'); },
    }),
    /Recycle Bin/,
    'Recycle Bin failure should surface a clear error.',
  );
  assert(await fs.pathExists(failedTrashOutput), 'Recycle Bin failure must not fall back to permanent delete.');

  const partialRun = await createRun(runtimesRoot, 'run-partial');
  const partialOutput = await writeFile(path.join(partialRun.outputs, 'partial.png'), 'partial');
  const partialSibling = await writeFile(path.join(partialRun.outputs, 'keep.png'), 'keep');
  const partialArtifact = await writeFile(path.join(partialRun.artifacts, 'generated.png'), 'generated');
  let partialError = null;
  let partialCalls = 0;
  try {
    await service.deletePipelineOutput(partialOutput, {
      deleteMode: 'trash',
      includeIntermediates: true,
      trashItem: async (targetPath) => {
        partialCalls += 1;
        if (partialCalls === 1) {
          await fs.remove(targetPath);
          return;
        }
        throw new Error('second item failed');
      },
    });
  } catch (error) {
    partialError = error;
  }
  assert(partialError && /deleted 1 cleanup item/.test(partialError.message), 'Partial failure should clearly report completed cleanup items.');
  assert(!(await fs.pathExists(partialOutput)), 'Partial failure should reflect the selected output already removed.');
  assert(await fs.pathExists(partialArtifact), 'Partial failure should preserve the artifact path that failed to delete.');
  assert(await fs.pathExists(partialSibling), 'Partial failure must preserve sibling outputs.');

  const collectionRun = await createRun(runtimesRoot, 'run-directory-output');
  const collectionPath = path.join(collectionRun.outputs, 'scene-collection');
  await fs.ensureDir(path.join(collectionPath, 'items'));
  await fs.writeJson(path.join(collectionPath, 'manifest.json'), { kind: 'collection', isFinalOutput: true, role: 'output', itemKind: 'image', items: [] });
  const collectionSet = await service._test.buildPipelineOutputDeletionSet(collectionPath, collectionRun.outputs);
  assert.deepStrictEqual(collectionSet, [collectionPath], 'Directory outputs should be deleted as one output unit.');
  await service.deletePipelineOutput(collectionPath, { deleteMode: 'permanent' });
  assert(!(await fs.pathExists(collectionPath)), 'Directory output deletion should remove the selected output folder.');

  await assert.rejects(
    () => service.deletePipelineOutput(collectionRun.outputs, { deleteMode: 'permanent' }),
    /whole outputs folder/,
    'The outputs folder itself must not be deletable.',
  );

  assert(service._test.isMetadataSidecar('final-image.image-analysis.json'), 'Image analysis sidecars should be recognized.');
  assert(service._test.isMetadataSidecar('final-image.subtitle.json'), 'Subtitle sidecars should be recognized.');

  await fs.remove(tempRoot);
  console.log('Verified safer pipeline output deletion and optional same-run cleanup behavior.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});