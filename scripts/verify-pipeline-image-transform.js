const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const commandService = require('../electron/services/commandService');

const PNG_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

commandService.runCommand = async (command, args = []) => {
  const commandText = String(command || '').toLowerCase();
  const normalizedArgs = Array.isArray(args) ? args.map((entry) => String(entry || '')) : [];
  if (commandText.endsWith('upscayl-bin.exe') || commandText.endsWith('realesrgan-ncnn-vulkan.exe')) {
    const outputIndex = normalizedArgs.indexOf('-o');
    const inputIndex = normalizedArgs.indexOf('-i');
    const outputTarget = outputIndex >= 0 ? normalizedArgs[outputIndex + 1] : '';
    const inputPath = inputIndex >= 0 ? normalizedArgs[inputIndex + 1] : '';
    if (!outputTarget) {
      return { code: 1, stderr: 'Upscayl did not receive an output path.', stdout: '' };
    }

    const outputPath = path.extname(outputTarget)
      ? outputTarget
      : path.join(outputTarget, path.basename(inputPath || 'upscayl-output.png'));
    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, PNG_FIXTURE);
    return { code: 0, stderr: '', stdout: 'Upscayl mock complete.' };
  }

  const requestPath = normalizedArgs[1] || normalizedArgs[0] || '';
  const request = requestPath ? await fs.readJson(requestPath) : null;
  if (!request?.outputPath) {
    return { code: 1, stderr: 'FaceFusion did not receive an output path.', stdout: '' };
  }

  await fs.ensureDir(path.dirname(request.outputPath));
  await fs.writeFile(request.outputPath, PNG_FIXTURE);
  return {
    code: 0,
    stderr: '',
    stdout: JSON.stringify({
      message: 'FaceFusion mock transformed the connected target image.',
      outputPath: request.outputPath,
      transformationType: 'face-swap',
    }),
  };
};

const {
  PIPELINE_OPERATION_IDS,
  analyzePipeline,
  buildContextMaps,
  createEdge,
  createEmptyPipeline,
  createNode,
  getModelStepOperationId,
  normalizeImageTransformSubtype,
} = require('../electron/shared/pipelineSchema.cjs');
const { buildFileArtifact } = require('../electron/services/pipelineArtifactService');
const { generateImageWithLocalImageTool } = require('../electron/services/localImageService');

function makeTool(id, root, patch = {}) {
  const isFaceFusion = id === 'facefusion';
  return {
    id,
    name: isFaceFusion ? 'FaceFusion' : 'Upscayl',
    appDir: root,
    installDir: root,
    launchProfile: isFaceFusion
      ? { kind: 'python-script', pythonPath: 'python' }
      : { kind: 'binary', executable: path.join(root, 'upscayl-bin.exe') },
    managedPythonPath: 'python',
    pipelineCapabilities: {
      operations: {
        [PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM]: {
          inputKinds: ['image'],
          outputKinds: ['image'],
        },
      },
    },
    status: 'stopped',
    ...patch,
  };
}

function context(tools) {
  return buildContextMaps({
    tools,
    toolCatalog: tools,
  });
}

function buildTransformPipeline({ sourcePath, referencePath = '', toolId, transformSubtype = '' }) {
  const target = createNode('imageInput', { id: 'target', config: { filePath: sourcePath } });
  const nodes = [target];
  const edges = [];
  const step = createNode('llmPrompt', {
    id: 'transform',
    config: {
      executionMode: 'localTool',
      operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM,
      toolId,
      transformSubtype,
    },
  });
  const output = createNode('imageOutput', { id: 'output' });
  nodes.push(step, output);
  edges.push(createEdge(target.id, 'image', step.id, 'prompt'));
  if (referencePath) {
    const reference = createNode('imageInput', { id: 'reference', config: { filePath: referencePath } });
    nodes.splice(1, 0, reference);
    edges.push(createEdge(reference.id, 'image', step.id, 'referenceImage'));
  }
  edges.push(createEdge(step.id, 'image', output.id, 'image'));
  return createEmptyPipeline({ nodes, edges });
}

function assertIssue(analysis, pattern, message) {
  assert(
    analysis.issues.some((issue) => pattern.test(String(issue.message || ''))),
    message + '\nIssues: ' + analysis.issues.map((issue) => issue.message).join(' | '),
  );
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-image-transform-'));
  try {
    const sourcePath = path.join(tempRoot, 'target.png');
    const referencePath = path.join(tempRoot, 'reference.png');
    await fs.writeFile(sourcePath, PNG_FIXTURE);
    await fs.writeFile(referencePath, PNG_FIXTURE);

    const upscaylRoot = path.join(tempRoot, 'upscayl');
    const facefusionRoot = path.join(tempRoot, 'facefusion');
    await fs.ensureDir(path.join(upscaylRoot, 'resources', 'models'));
    await fs.writeFile(path.join(upscaylRoot, 'upscayl-bin.exe'), 'mock');
    await fs.writeFile(path.join(upscaylRoot, 'resources', 'models', 'realesrgan-x4plus.param'), 'mock');
    await fs.ensureDir(facefusionRoot);
    await fs.writeFile(path.join(facefusionRoot, 'facefusion.py'), 'mock');

    const upscayl = makeTool('upscayl', upscaylRoot);
    const facefusion = makeTool('facefusion', facefusionRoot);
    const maps = context([upscayl, facefusion]);

    assert.strictEqual(normalizeImageTransformSubtype('upscayl', ''), 'upscale', 'Upscayl should default to upscale.');
    assert.strictEqual(normalizeImageTransformSubtype('upscayl', 'enhance'), 'enhance', 'Upscayl should accept enhance metadata.');
    assert.strictEqual(normalizeImageTransformSubtype('facefusion', ''), 'face-swap', 'FaceFusion should default to face-swap.');
    assert.strictEqual(normalizeImageTransformSubtype('facefusion', 'enhance'), '', 'FaceFusion should not claim generic enhancement.');

    const upscaylPipeline = buildTransformPipeline({ sourcePath, toolId: 'upscayl', transformSubtype: 'enhance' });
    const upscaylStep = upscaylPipeline.nodes.find((node) => node.id === 'transform');
    assert.strictEqual(getModelStepOperationId(upscaylStep), PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, 'Upscayl should use the shared imageTransform operation.');
    const upscaylAnalysis = analyzePipeline(upscaylPipeline, maps);
    assert.strictEqual(upscaylAnalysis.executable, true, 'Upscayl transform pipeline should be executable.');
    assert(/enhance/i.test(upscaylAnalysis.nodeSummaries.transform.readiness.message), 'Upscayl readiness should name the requested subtype.');

    const facefusionPipeline = buildTransformPipeline({ sourcePath, referencePath, toolId: 'facefusion' });
    const facefusionAnalysis = analyzePipeline(facefusionPipeline, maps);
    assert.strictEqual(facefusionAnalysis.executable, true, 'FaceFusion target plus reference pipeline should be executable.');
    assert(/Reference Image/i.test(facefusionAnalysis.nodeSummaries.transform.readiness.message), 'FaceFusion readiness should explain the reference image input.');

    const missingReference = analyzePipeline(buildTransformPipeline({ sourcePath, toolId: 'facefusion' }), maps);
    assert.strictEqual(missingReference.executable, false, 'FaceFusion without a reference image should be blocked.');
    assertIssue(missingReference, /source face image|Reference Image/i, 'Missing FaceFusion reference should fail honestly.');

    const missingInput = createEmptyPipeline({
      nodes: [
        createNode('llmPrompt', { id: 'transform', config: { executionMode: 'localTool', operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM, toolId: 'upscayl' } }),
        createNode('imageOutput', { id: 'output' }),
      ],
      edges: [createEdge('transform', 'image', 'output', 'image')],
    });
    const missingInputAnalysis = analyzePipeline(missingInput, maps);
    assert.strictEqual(missingInputAnalysis.executable, false, 'Image transform without a source image should be blocked.');

    const unsupportedSubtype = analyzePipeline(buildTransformPipeline({ sourcePath, toolId: 'upscayl', transformSubtype: 'face-swap' }), maps);
    assert.strictEqual(unsupportedSubtype.executable, false, 'Unsupported tool/subtype combinations should be blocked.');
    assertIssue(unsupportedSubtype, /does not support the selected image transform subtype/i, 'Unsupported subtype should explain the tool mismatch.');

    const unsupportedTool = analyzePipeline(buildTransformPipeline({ sourcePath, toolId: 'automatic1111' }), maps);
    assert.strictEqual(unsupportedTool.executable, false, 'Unsupported image-transform tools should be rejected.');
    assertIssue(unsupportedTool, /Upscayl or FaceFusion.*image transform|Choose Upscayl or FaceFusion/i, 'Unsupported tool should explain the valid transform tools.');

    const sourceArtifact = await buildFileArtifact(sourcePath, { displayName: 'Target image', kind: 'image' });
    const referenceArtifact = await buildFileArtifact(referencePath, { displayName: 'Reference face', kind: 'image' });
    const runDirectories = { artifactsDir: path.join(tempRoot, 'artifacts') };
    await fs.ensureDir(runDirectories.artifactsDir);

    const upscaylResult = await generateImageWithLocalImageTool(upscayl, {
      displayName: 'Enhance target',
      nodeLabel: 'Enhance target',
      operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM,
      runDirectories,
      sourceImageArtifact: sourceArtifact,
      sourceImagePath: sourcePath,
      transformSubtype: 'enhance',
    });
    assert.strictEqual(upscaylResult.outputs.image.kind, 'image', 'Upscayl should emit an image artifact.');
    assert.strictEqual(upscaylResult.outputs.image.imageTransformation.transformSubtype, 'enhance', 'Upscayl should preserve transform subtype metadata.');
    assert.strictEqual(upscaylResult.outputs.image.imageTransformation.sourceImage.fileName, 'target.png', 'Upscayl should preserve source-image lineage.');

    const facefusionResult = await generateImageWithLocalImageTool(facefusion, {
      displayName: 'Face swap target',
      nodeLabel: 'Face swap target',
      operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM,
      referenceImageArtifact: referenceArtifact,
      referenceImagePath: referencePath,
      runDirectories,
      sourceImageArtifact: sourceArtifact,
      sourceImagePath: sourcePath,
      transformSubtype: 'face-swap',
    });
    assert.strictEqual(facefusionResult.outputs.image.kind, 'image', 'FaceFusion should emit an image artifact.');
    assert.strictEqual(facefusionResult.outputs.image.imageTransformation.transformSubtype, 'face-swap', 'FaceFusion should preserve face-swap subtype metadata.');
    assert.strictEqual(facefusionResult.outputs.image.imageTransformation.sourceImage.fileName, 'target.png', 'FaceFusion should preserve target-image lineage.');
    assert.strictEqual(facefusionResult.outputs.image.imageTransformation.referenceImage.fileName, 'reference.png', 'FaceFusion should preserve reference-image lineage.');

    await assert.rejects(
      () => generateImageWithLocalImageTool(facefusion, {
        displayName: 'Missing face reference',
        nodeLabel: 'Missing face reference',
        operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM,
        runDirectories,
        sourceImageArtifact: sourceArtifact,
        sourceImagePath: sourcePath,
      }),
      /source face image on the Reference Image input/i,
      'FaceFusion execution should fail honestly without a reference image.',
    );

    await assert.rejects(
      () => generateImageWithLocalImageTool({ id: 'automatic1111', name: 'Automatic1111', appDir: tempRoot }, {
        runDirectories,
        sourceImageArtifact: sourceArtifact,
        sourceImagePath: sourcePath,
      }),
      /does not have a runnable local image transformation adapter/i,
      'Unsupported image transform adapters should fail honestly.',
    );

    const text = createNode('textInput', { id: 'prompt', config: { text: 'a small cabin' } });
    const imageStep = createNode('llmPrompt', { id: 'image', config: { executionMode: 'localTool', operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE, toolId: '' } });
    assert.strictEqual(getModelStepOperationId(imageStep), PIPELINE_OPERATION_IDS.IMAGE_GENERATE, 'Ordinary local image generation should stay on imageGenerate.');
    const imageOutput = createNode('imageOutput', { id: 'imageOut' });
    const generationPipeline = createEmptyPipeline({
      nodes: [text, imageStep, imageOutput],
      edges: [createEdge(text.id, 'text', imageStep.id, 'prompt'), createEdge(imageStep.id, 'image', imageOutput.id, 'image')],
    });
    const generationAnalysis = analyzePipeline(generationPipeline, context([makeTool('upscayl', upscaylRoot), { ...makeTool('automatic1111', tempRoot), id: 'automatic1111', name: 'Automatic1111', downloadedModels: [{ id: 'sd15.safetensors', modelType: 'checkpoint' }], pipelineCapabilities: { operations: { [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: { inputKinds: ['text'], outputKinds: ['image'] } } } }]));
    assert.strictEqual(generationAnalysis.executable, true, 'Ordinary image generation analysis should not be affected by imageTransform subtype metadata.');

    const collectionMap = createNode('collectionMap', { id: 'map', config: { operationId: PIPELINE_OPERATION_IDS.IMAGE_GENERATE } });
    assert.strictEqual(collectionMap.config.operationId, PIPELINE_OPERATION_IDS.IMAGE_GENERATE, 'Collection Map should remain scoped to image generation.');

    console.log('Pipeline image transform verification passed.');
  } finally {
    await fs.remove(tempRoot).catch(() => null);
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
