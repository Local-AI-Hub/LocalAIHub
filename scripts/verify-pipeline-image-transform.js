const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const commandService = require('../electron/services/commandService');

const PNG_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const upscaylCommandOptions = [];
const upscaylCommandPaths = [];
const facefusionCommandOptions = [];

commandService.runCommand = async (command, args = [], options = {}) => {
  const commandText = String(command || '').toLowerCase();
  const normalizedArgs = Array.isArray(args) ? args.map((entry) => String(entry || '')) : [];
  if (commandText.endsWith('upscayl-bin.exe') || commandText.endsWith('realesrgan-ncnn-vulkan.exe')) {
    upscaylCommandOptions.push(options || {});
    upscaylCommandPaths.push(command);
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

  facefusionCommandOptions.push(options || {});
  const requestPath = normalizedArgs[1] || normalizedArgs[0] || '';
  const request = requestPath ? await fs.readJson(requestPath) : null;
  if (!request?.outputPath) {
    return { code: 1, stderr: 'FaceFusion did not receive an output path.', stdout: '' };
  }

  if (request.nodeLabel === 'Traceback target') {
    return {
      code: 1,
      stderr: 'Traceback (most recent call last):\nModuleNotFoundError: No module named \'cv2\'\n',
      stdout: '{"message":"Traceback (most recent call last):"}',
    };
  }

  if (request.nodeLabel === 'Onnx target') {
    return {
      code: 1,
      stderr: 'Traceback (most recent call last):\nModuleNotFoundError: No module named \'onnxruntime\'\n',
      stdout: '{"message":"Traceback (most recent call last):"}',
    };
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
      : { kind: 'binary', executable: path.join(root, 'Upscayl.exe') },
    executablePath: isFaceFusion ? null : path.join(root, 'Upscayl.exe'),
    managedPythonPath: 'python',
    source: 'managed',
    managedByLocalAIHub: true,
    installInstructions: { runtime: isFaceFusion ? 'python' : 'binary' },
    launchEnvironment: isFaceFusion ? { includeBundledFfmpeg: true } : {},
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

function parseLastJsonLine(value) {
  const line = String(value || '')
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.trim().startsWith('{'));
  assert(line, 'Expected helper output to include a JSON line. Output: ' + value);
  return JSON.parse(line);
}

function runFaceFusionHelper(requestPath, options = {}) {
  const helperPath = path.join(process.cwd(), 'electron/helpers/run_facefusion_pipeline_task.py');
  const result = spawnSync('python', [helperPath, requestPath], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

async function writeFaceFusionHelperFixture(root, behavior) {
  await fs.ensureDir(root);
  const scriptPath = path.join(root, 'facefusion.py');
  const script = [
    'import os, sys',
    'args = sys.argv[1:]',
    'print("[FACEFUSION.CORE] processing step 1 of 1")',
    behavior === 'success'
      ? 'output_path = args[args.index("--output-path") + 1] if "--output-path" in args else args[args.index("-o") + 1]; os.makedirs(os.path.dirname(output_path), exist_ok=True); open(output_path, "wb").write(b"fake-image")'
      : behavior === 'diagnostic'
        ? 'print("[FACEFUSION.CORE] match the target and output extension!"); sys.exit(1)'
        : 'sys.exit(1)',
  ].join('\n');
  await fs.writeFile(scriptPath, script, 'utf8');
  return scriptPath;
}

async function verifyFaceFusionHelperContract(tempRoot) {
  const helperRoot = path.join(tempRoot, 'facefusion-helper-contract');
  const targetPath = path.join(helperRoot, 'target.jpg');
  const referencePath = path.join(helperRoot, 'reference.jpg');
  await fs.ensureDir(helperRoot);
  await fs.writeFile(targetPath, PNG_FIXTURE);
  await fs.writeFile(referencePath, PNG_FIXTURE);

  const successRoot = path.join(helperRoot, 'success-tool');
  await writeFaceFusionHelperFixture(successRoot, 'success');
  const successRequest = path.join(helperRoot, 'success-request.json');
  const requestedPngPath = path.join(helperRoot, 'artifact.png');
  await fs.writeJson(successRequest, {
    outputPath: requestedPngPath,
    referenceImagePath: referencePath,
    targetImagePath: targetPath,
    toolRoot: successRoot,
  });
  const successResult = runFaceFusionHelper(successRequest, { cwd: successRoot });
  assert.strictEqual(successResult.status, 0, 'FaceFusion helper should exit successfully when the backend writes the transformed image.');
  const successPayload = parseLastJsonLine(successResult.stdout);
  assert(/artifact\.jpg$/i.test(successPayload.outputPath), 'FaceFusion helper should align the backend output extension with the target image.');
  assert(await fs.pathExists(successPayload.outputPath), 'FaceFusion helper success payload should point at an existing output image.');

  const progressRoot = path.join(helperRoot, 'progress-tool');
  await writeFaceFusionHelperFixture(progressRoot, 'progress-only');
  const progressRequest = path.join(helperRoot, 'progress-request.json');
  const missingPath = path.join(helperRoot, 'missing.jpg');
  await fs.writeJson(progressRequest, {
    outputPath: missingPath,
    referenceImagePath: referencePath,
    targetImagePath: targetPath,
    toolRoot: progressRoot,
  });
  const progressResult = runFaceFusionHelper(progressRequest, { cwd: progressRoot });
  assert.notStrictEqual(progressResult.status, 0, 'FaceFusion helper should fail when the backend exits without an output image.');
  const progressPayload = parseLastJsonLine(progressResult.stdout);
  assert(!/^\[FACEFUSION\.CORE\] processing step/i.test(progressPayload.message), 'FaceFusion helper should not surface a progress-only line as the final error.');
  assert(progressPayload.message.includes(missingPath), 'Missing-output errors should include the expected output path.');

  const diagnosticRoot = path.join(helperRoot, 'diagnostic-tool');
  await writeFaceFusionHelperFixture(diagnosticRoot, 'diagnostic');
  const diagnosticRequest = path.join(helperRoot, 'diagnostic-request.json');
  await fs.writeJson(diagnosticRequest, {
    outputPath: path.join(helperRoot, 'diagnostic.jpg'),
    referenceImagePath: referencePath,
    targetImagePath: targetPath,
    toolRoot: diagnosticRoot,
  });
  const diagnosticResult = runFaceFusionHelper(diagnosticRequest, { cwd: diagnosticRoot });
  assert.notStrictEqual(diagnosticResult.status, 0, 'FaceFusion helper should fail when FaceFusion reports a backend diagnostic.');
  const diagnosticPayload = parseLastJsonLine(diagnosticResult.stdout);
  assert(/match the target and output extension/i.test(diagnosticPayload.message), 'FaceFusion helper should preserve useful backend diagnostics.');
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
    await fs.writeFile(path.join(upscaylRoot, 'Upscayl.exe'), 'desktop app mock');
    await fs.ensureDir(path.join(upscaylRoot, 'resources', 'bin'));
    await fs.writeFile(path.join(upscaylRoot, 'resources', 'bin', 'upscayl-bin.exe'), 'mock');
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

    const upscaylAbortController = new AbortController();
    const upscaylResult = await generateImageWithLocalImageTool(upscayl, {
      cancelSignal: upscaylAbortController.signal,
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
    assert(upscaylCommandPaths.some((entry) => /resources[\\/]bin[\\/]upscayl-bin\.exe$/i.test(String(entry || ''))), 'Upscayl pipeline transform should use the bundled CLI, not the desktop Upscayl.exe launch path.');
    assert(!upscaylCommandPaths.some((entry) => /Upscayl\.exe$/i.test(String(entry || ''))), 'Upscayl pipeline transform must not launch the desktop app executable.');
    assert(upscaylCommandOptions.some((entry) => Number(entry.timeoutMs || 0) > 0), 'Upscayl direct command should run with a timeout.');
    assert(upscaylCommandOptions.some((entry) => entry.signal === upscaylAbortController.signal), 'Upscayl direct command should receive the pipeline cancel signal.');
    assert(upscaylCommandOptions.some((entry) => /cancelled/i.test(String(entry.abortMessage || ''))), 'Upscayl direct command should have a plain-English abort message.');

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
    const facefusionEnv = facefusionCommandOptions.find((entry) => entry?.env)?.env || {};
    assert(facefusionEnv.FFMPEG_BINARY && /ffmpeg\.exe$/i.test(facefusionEnv.FFMPEG_BINARY), 'FaceFusion pipeline helper env should expose the bundled ffmpeg.exe path.');
    assert.strictEqual(facefusionEnv.IMAGEIO_FFMPEG_EXE, facefusionEnv.FFMPEG_BINARY, 'FaceFusion pipeline helper env should set common FFmpeg aliases consistently.');
    const facefusionPathKey = Object.keys(facefusionEnv).find((key) => key.toLowerCase() === 'path') || 'PATH';
    const facefusionPathEntries = String(facefusionEnv[facefusionPathKey] || '').split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
    assert(facefusionPathEntries.some((entry) => path.resolve(entry).toLowerCase() === path.resolve(path.dirname(facefusionEnv.FFMPEG_BINARY)).toLowerCase()), 'FaceFusion pipeline helper PATH should include the bundled FFmpeg directory.');

    await assert.rejects(
      () => generateImageWithLocalImageTool(facefusion, {
        displayName: 'Traceback target',
        nodeLabel: 'Traceback target',
        operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM,
        referenceImageArtifact: referenceArtifact,
        referenceImagePath: referencePath,
        runDirectories,
        sourceImageArtifact: sourceArtifact,
        sourceImagePath: sourcePath,
        transformSubtype: 'face-swap',
      }),
      /OpenCV \(cv2\)|opencv-python/i,
      'FaceFusion helper failures should preserve useful missing dependency diagnostics instead of Traceback-only JSON.',
    );

    await assert.rejects(
      () => generateImageWithLocalImageTool(facefusion, {
        displayName: 'Onnx target',
        nodeLabel: 'Onnx target',
        operationId: PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM,
        referenceImageArtifact: referenceArtifact,
        referenceImagePath: referencePath,
        runDirectories,
        sourceImageArtifact: sourceArtifact,
        sourceImagePath: sourcePath,
        transformSubtype: 'face-swap',
      }),
      /ONNX Runtime|onnxruntime/i,
      'FaceFusion helper failures should preserve useful missing ONNX Runtime diagnostics instead of Traceback-only JSON.',
    );

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

    await verifyFaceFusionHelperContract(tempRoot);

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
