const path = require('path');
const fs = require('fs-extra');

const { compareVersions, runCommand } = require('./commandService');
const { humanizeError, readConfig, upsertTool } = require('./configService');
const { getNvidiaRuntimeDetails, detectHardwareSnapshot } = require('./hardwareService');
const { repairToolInstallation } = require('./installerService');

const PYTORCH_REPAIR_BUILDS = [
  {
    channel: 'cu126',
    label: 'CUDA 12.6',
    minCudaVersion: [12, 6],
    torch: '2.6.0',
    torchvision: '0.21.0',
    torchaudio: '2.6.0',
    indexUrl: 'https://download.pytorch.org/whl/cu126',
  },
  {
    channel: 'cu124',
    label: 'CUDA 12.4',
    minCudaVersion: [12, 4],
    torch: '2.6.0',
    torchvision: '0.21.0',
    torchaudio: '2.6.0',
    indexUrl: 'https://download.pytorch.org/whl/cu124',
  },
  {
    channel: 'cu121',
    label: 'CUDA 12.1',
    minCudaVersion: [12, 1],
    torch: '2.5.1',
    torchvision: '0.20.1',
    torchaudio: '2.5.1',
    indexUrl: 'https://download.pytorch.org/whl/cu121',
  },
  {
    channel: 'cu118',
    label: 'CUDA 11.8',
    minCudaVersion: [11, 8],
    torch: '2.6.0',
    torchvision: '0.21.0',
    torchaudio: '2.6.0',
    indexUrl: 'https://download.pytorch.org/whl/cu118',
  },
];

const RESTART_WAIT_MS = 30000;
const recoveryLocks = new Set();

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseVersionParts(value) {
  return String(value || '')
    .split('.')
    .map((part) => Number.parseInt(part.replace(/[^0-9].*$/, ''), 10))
    .filter((part) => Number.isFinite(part));
}

function isLegacyNvidiaModel(model) {
  return /\b(gtx|tesla p|quadro p)\b/i.test(String(model || '')) && !/\brtx\b/i.test(String(model || ''));
}

function probeUrl(url) {
  if (!url) {
    return Promise.resolve(false);
  }


  return fetch(url, { method: 'GET' })
    .then((response) => Boolean(response))
    .catch(() => false);
}

function findLastMeaningfulLine(stderrText) {
  const lines = String(stderrText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    [...lines].reverse().find((line) => !/^Traceback/i.test(line) && !/^File "/i.test(line)) ||
    lines[lines.length - 1] ||
    ''
  );
}

function summarizeUnknownFailure(toolState, stderrText) {
  const lastLine = findLastMeaningfulLine(stderrText);
  if (!lastLine) {
    return `${toolState.name} stopped before it finished starting. Local AI Hub could not match the error automatically. Open the logs folder for the full details.`;
  }

  return `${toolState.name} stopped before it finished starting. Local AI Hub could not match the error automatically. The tool reported: ${lastLine}. Open the logs folder for the full details.`;
}

function formatMemoryGb(megabytes) {
  const value = Number(megabytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }

  return `${Math.round((value / 1024) * 10) / 10} GB`;
}
function diagnoseLaunchFailure(toolState, stderrText, hardware) {
  const stderr = String(stderrText || '');
  const normalized = stderr.toLowerCase();
  const gpuModel = hardware?.gpuModel || 'your GPU';

  if (/No module named open_webui\.__main__/i.test(stderr)) {
    return {
      recognized: true,
      id: 'openwebui-main-entrypoint',
      action: 'none',
      summary: `${toolState.name} is being launched with the wrong Python entrypoint. Local AI Hub needs to start open_webui.main or the open-webui console script instead of python -m open_webui.`,
      repairingMessage: null,
    };
  }

  const unsupportedLaunchArgs = stderr.match(/(?:^|\n)[^\n]*error:\s*unrecognized arguments?:\s*([^\r\n]+)/i);
  if (unsupportedLaunchArgs?.[1]) {
    const args = unsupportedLaunchArgs[1].trim();
    return {
      recognized: true,
      id: 'unsupported-launch-arguments',
      action: 'none',
      summary: `${toolState.name} was launched with unsupported command-line argument${args.split(/\s+/).length === 1 ? '' : 's'}: ${args}. Local AI Hub needs updated launch settings for this tool before it can start cleanly.`,
      repairingMessage: null,
    };
  }
  if (toolState?.id === 'invokeai' && /No UI found at .*invokeai[\\/]frontend[\\/]web[\\/]dist, skipping UI mount/i.test(stderr)) {
    return {
      recognized: true,
      id: 'invokeai-missing-web-ui-assets',
      action: 'repair-python-environment',
      summary: `${toolState.name} started its API, but the packaged InvokeAI web UI assets are missing from its Python environment. Run Repair to rebuild InvokeAI, then launch it again.`,
      repairingMessage: `Local AI Hub is rebuilding ${toolState.name}'s Python environment so InvokeAI's web UI assets are installed correctly.`,
    };
  }
  if (toolState?.id === 'rvc' && /ImportError:\s*cannot import name ['"]media_data['"] from ['"]gradio_client['"]/i.test(stderr)) {
    return {
      recognized: true,
      id: 'rvc-gradio-client-media-data',
      action: 'repair-python-environment',
      summary: `${toolState.name} has an incompatible Gradio client package in its Python environment. RVC's bundled Gradio 3.34 expects gradio_client.media_data, but the installed gradio_client package does not provide it. Run Repair to rebuild RVC with the pinned compatible dependency set.`,
      repairingMessage: `Local AI Hub is rebuilding ${toolState.name}'s Python environment with the RVC-compatible Gradio client dependency.`,
    };
  }
  if (toolState?.id === 'openwebui' && /UnicodeEncodeError:/i.test(stderr) && /charmap codec can't encode/i.test(stderr) && /open_webui\\main\.py/i.test(stderr)) {
    return {
      recognized: true,
      id: 'openwebui-console-encoding',
      action: 'none',
      summary: `${toolState.name} hit a Windows console encoding error while printing its startup banner. Local AI Hub needs to run Open WebUI with UTF-8 Python stdio on this PC.`,
      repairingMessage: null,
    };
  }

  if (toolState?.id === 'openwebui' && /Frontend build directory not found at/i.test(stderr)) {
    return {
      recognized: true,
      id: 'openwebui-frontend-build-dir',
      action: 'none',
      summary: `${toolState.name} started its Python server, but it is still pointing at the wrong frontend asset folder. Local AI Hub needs to launch the packaged install with Open WebUI's installed frontend directory, not the default venv build path.`,
      repairingMessage: null,
    };
  }

  if (toolState?.id === 'openwebui' && /BertModel LOAD REPORT/i.test(stderr) && /can be ignored when loading from different task\/architecture/i.test(stderr)) {
    return {
      recognized: true,
      id: 'openwebui-wrong-serve-entrypoint',
      action: 'none',
      summary: `${toolState.name} initialized part of its embedding stack and then exited before starting its local web server. Local AI Hub needs to launch the open-webui serve entrypoint instead of importing open_webui.main directly.`,
      repairingMessage: null,
    };
  }

  if (toolState?.id === 'koboldcpp') {
    const missingSplitMatch = stderr.match(/gguf_init_from_file: failed to open GGUF file '([^']+\.gguf)' \(No such file or directory\)/i);
    if (missingSplitMatch && /failed to load GGUF split/i.test(stderr)) {
      const missingSplitPath = missingSplitMatch[1];
      const missingSplitFile = path.basename(missingSplitPath);
      return {
        recognized: true,
        id: 'koboldcpp-missing-gguf-split',
        action: 'none',
        summary: `${toolState.name} received the selected GGUF file, but the model is incomplete on disk. KoboldCpp also needs ${missingSplitFile} in the same folder, and that split file is missing. Choose a complete GGUF or re-download the full split model before launching again.`,
        repairingMessage: null,
      };
    }

    const modelLoadFailureMatch = stderr.match(/gpttype_load_model:\s*error:\s*failed to load model '([^']+)'/i);
    if (modelLoadFailureMatch) {
      const reportedModelValue = String(modelLoadFailureMatch[1] || '').trim();
      const looksLikeFilesystemPath = /^[a-z]:\\/i.test(reportedModelValue) || /[\\/]/.test(reportedModelValue);
      const placeholderValue = /^(a local path|local path|path to (?:a )?local model|path to (?:a )?gguf)$/i.test(reportedModelValue);
      const memoryLoadFailure = /cudaMalloc failed: out of memory/i.test(stderr)
        || /failed to allocate compute (?:pp )?buffers/i.test(stderr)
        || /failed to initialize the context: failed to allocate/i.test(stderr)
        || /failed to allocate CUDA0 buffer/i.test(stderr);

      if (memoryLoadFailure && looksLikeFilesystemPath) {
        return {
          recognized: true,
          id: 'koboldcpp-model-load-oom',
          action: 'none',
          summary: `${toolState.name} received the selected GGUF file at ${reportedModelValue}, but the model ran out of available GPU memory while KoboldCpp was creating its compute buffers. Choose a smaller GGUF, reduce KoboldCpp's memory use, or switch to a lighter runtime mode before launching again.`,
          repairingMessage: null,
        };
      }

      if (reportedModelValue && (!looksLikeFilesystemPath || placeholderValue)) {
        return {
          recognized: true,
          id: 'koboldcpp-invalid-model-value',
          action: 'none',
          summary: `${toolState.name} was asked to load "${reportedModelValue}", but that is not a usable filesystem path to a GGUF on this PC. Local AI Hub passed an invalid model value to KoboldCpp instead of the saved file path. Re-save the model selection and try again.`,
          repairingMessage: null,
        };
      }
    }
  }
  if (toolState?.id === 'automatic1111' && /Stable diffusion model failed to load/i.test(stderr) && (/OutOfMemoryError/i.test(stderr) || /DefaultCPUAllocator: not enough memory/i.test(stderr))) {
    return {
      recognized: true,
      id: 'automatic1111-model-load-oom',
      action: 'none',
      summary: `${toolState.name} brought up its web UI, but the first Stable Diffusion model load ran out of GPU or system memory on this machine.`,
      repairingMessage: null,
    };
  }

  if (toolState?.id === 'automatic1111' && /MemoryError/i.test(stderr) && /(window\.gradio_config|gradio\\templates\\frontend\\index\.html|gradio\\routes\.py|toorjson)/i.test(stderr)) {
    return {
      recognized: true,
      id: 'automatic1111-gradio-memoryerror',
      action: 'none',
      summary: `${toolState.name} started its Python web server, but Gradio ran out of memory while rendering the first page. This is a real runtime memory failure on this machine, not an install or CUDA bootstrap error.`,
      repairingMessage: null,
    };
  }

  if (toolState?.id === 'automatic1111'
    && /Loading weights \[/i.test(stderr)
    && /Running on local URL:/i.test(stderr)
    && !/(Traceback|MemoryError|Exception|AssertionError|RuntimeError|ValueError|OutOfMemoryError|Stable diffusion model failed to load)/i.test(stderr)) {
    const lowVramProfileActive = /Launching Web UI with arguments:.*--(?:med|low)vram\b/i.test(stderr);
    const lowVramMessage = lowVramProfileActive
      ? ' Local AI Hub had already applied its general Automatic1111 low-VRAM launch mode for this run, so the remaining failure is beyond the broad launch-profile adjustment Local AI Hub can safely make.'
      : '';

    return {
      recognized: true,
      id: 'automatic1111-native-post-bind-crash',
      action: 'none',
      summary: `${toolState.name} finished its bootstrap work, answered its local API, and then the Windows process died without a Python traceback.${lowVramMessage} The captured output already shows xformers was unavailable, so this points to Automatic1111's remaining native CUDA or PyTorch runtime stack on this machine rather than its install or first-run download state.`,
      repairingMessage: null,
    };
  }

  if (toolState?.id === 'automatic1111'
    && /Loading weights \[/i.test(stderr)
    && !/Running on local URL:/i.test(stderr)
    && !/(Traceback|MemoryError|Exception|AssertionError|RuntimeError|ValueError|OutOfMemoryError|Stable diffusion model failed to load)/i.test(stderr)) {
    const lowVramProfileActive = /Launching Web UI with arguments:.*--(?:med|low)vram\b/i.test(stderr);
    const lowVramMessage = lowVramProfileActive
      ? ' Local AI Hub had already applied its general Automatic1111 low-VRAM launch mode for this run, so the remaining failure is beyond the broad launch-profile adjustment Local AI Hub can safely make.'
      : '';

    return {
      recognized: true,
      id: 'automatic1111-native-pre-bind-crash',
      action: 'none',
      summary: `${toolState.name} loaded its Stable Diffusion checkpoint and then the Windows process died before its local API came up.${lowVramMessage} The captured output already shows xformers was unavailable, so this points to Automatic1111's remaining native CUDA or PyTorch runtime stack on this machine rather than its install or first-run download state.`,
      repairingMessage: null,
    };
  }

  if (/torch not compiled with cuda enabled/i.test(stderr)) {
    return {
      recognized: true,
      id: 'torch-cpu-build',
      action: 'repair-pytorch-cuda',
      summary: `${toolState.name} is using a CPU-only PyTorch build instead of an NVIDIA CUDA build.`,
      repairingMessage: `Local AI Hub found a CPU-only PyTorch build and is reinstalling the NVIDIA build for ${gpuModel}.`,
    };
  }

  if (/found no nvidia driver on your system/i.test(stderr)) {
    return {
      recognized: true,
      id: 'nvidia-driver-hidden',
      action: hardware?.nvidiaSmiAvailable ? 'repair-pytorch-cuda' : 'none',
      summary: hardware?.nvidiaSmiAvailable
        ? `${toolState.name} could not use the NVIDIA driver from inside its Python environment.`
        : `${toolState.name} could not find an NVIDIA driver on this PC.`,
      repairingMessage: `Local AI Hub is reinstalling PyTorch for the NVIDIA driver it detected on this machine.`,
    };
  }

  if (/moduleNotFoundError:\s+No module named ['"]torch['"]/i.test(stderr)) {
    return {
      recognized: true,
      id: 'missing-torch',
      action: 'repair-pytorch-cuda',
      summary: `${toolState.name} is missing PyTorch in its Python environment.`,
      repairingMessage: `Local AI Hub is reinstalling PyTorch with the correct CUDA build for ${gpuModel}.`,
    };
  }

  if (/dll load failed while importing (torch|torch_cpu|torch_cuda|c10_cuda|fbgemm)/i.test(stderr) || (/winerror 126/i.test(normalized) && /torch/i.test(normalized))) {
    return {
      recognized: true,
      id: 'torch-dll-mismatch',
      action: 'repair-pytorch-cuda',
      summary: `${toolState.name} has a broken PyTorch CUDA runtime in its Python environment.`,
      repairingMessage: `Local AI Hub is reinstalling PyTorch and CUDA support for ${gpuModel}.`,
    };
  }

  if (/torch is not able to use gpu; add --skip-torch-cuda-test/i.test(stderr)) {
    return {
      recognized: true,
      id: 'torch-cuda-check-failed',
      action: hardware?.nvidiaSmiAvailable ? 'repair-pytorch-cuda' : 'none',
      summary: hardware?.nvidiaSmiAvailable
        ? `${toolState.name} has a PyTorch build that still cannot reach ${gpuModel}.`
        : `${toolState.name} requires NVIDIA CUDA support, but this PC does not currently expose a working NVIDIA CUDA runtime.`,
      repairingMessage: hardware?.nvidiaSmiAvailable
        ? `Local AI Hub is reinstalling a CUDA-enabled PyTorch build for ${gpuModel}.`
        : null,
    };
  }

  if (/your device does not support the current version of torch\/cuda/i.test(stderr)) {
    return {
      recognized: true,
      id: 'torch-cuda-build-mismatch',
      action: hardware?.nvidiaSmiAvailable ? 'repair-pytorch-cuda' : 'none',
      summary: hardware?.nvidiaSmiAvailable
        ? `${toolState.name} is using a Torch/CUDA build that does not match ${gpuModel}.`
        : `${toolState.name} requires an NVIDIA CUDA build that this PC does not currently provide.`,
      repairingMessage: hardware?.nvidiaSmiAvailable
        ? `Local AI Hub is reinstalling a compatible CUDA-enabled PyTorch build for ${gpuModel}.`
        : null,
    };
  }

  if (toolState?.id === 'automatic1111' && /Couldn't clone Stable Diffusion/i.test(stderr) && /repository not found/i.test(stderr) && /Stability-AI\/stablediffusion\.git/i.test(stderr)) {
    return {
      recognized: true,
      id: 'automatic1111-stable-diffusion-repo-missing',
      action: 'none',
      summary: `${toolState.name} is still trying to clone the retired Stability-AI/stablediffusion.git bootstrap repository. Local AI Hub needs to launch it with the maintained replacement Stable Diffusion repo URL instead.`,
      repairingMessage: null,
    };
  }

  if ((toolState?.id === 'automatic1111' || toolState?.id === 'forge') && /couldn't install clip/i.test(stderr) && /pkg_resources/i.test(stderr)) {
    return {
      recognized: true,
      id: 'clip-bootstrap-build-failure',
      action: 'repair-python-environment',
      summary: `${toolState.name} could not bootstrap its CLIP dependency. The upstream launch step fell back to building CLIP, and that build failed before pkg_resources was available.`,
      repairingMessage: `Local AI Hub is rebuilding ${toolState.name}'s Python environment with the trusted CLIP bootstrap path.`,
    };
  }

  if (toolState?.id === 'facefusion' && /(?:\[FACEFUSION\.CORE\]\s*)?ffmpeg is not installed/i.test(stderr)) {
    return {
      recognized: true,
      id: 'facefusion-missing-ffmpeg-runtime',
      action: 'none',
      summary: `${toolState.name} could not find FFmpeg in its launch environment. Local AI Hub should expose its bundled FFmpeg runtime to FaceFusion; reinstall Local AI Hub if this message appears after updating, then launch FaceFusion again.`,
      repairingMessage: null,
    };
  }
  if (toolState?.id === 'facefusion' && /ModuleNotFoundError:\s+No module named ['"]cv2['"]/i.test(stderr)) {
    return {
      recognized: true,
      id: 'facefusion-missing-opencv',
      action: 'repair-python-environment',
      summary: `${toolState.name} is missing OpenCV (cv2), which this FaceFusion version declares as opencv-python in requirements.txt. Run Repair to rebuild FaceFusion with the required OpenCV package.`,
      repairingMessage: `Local AI Hub is rebuilding ${toolState.name}'s Python environment with FaceFusion's OpenCV dependency.`,
    };
  }

  if (toolState?.id === 'facefusion' && /ModuleNotFoundError:\s+No module named ['"]onnxruntime['"]/i.test(stderr)) {
    return {
      recognized: true,
      id: 'facefusion-missing-onnxruntime',
      action: 'repair-python-environment',
      summary: `${toolState.name} is missing ONNX Runtime (onnxruntime), which this FaceFusion version declares in requirements.txt. Run Repair to rebuild FaceFusion with the required ONNX Runtime package.`,
      repairingMessage: `Local AI Hub is rebuilding ${toolState.name}'s Python environment with FaceFusion's ONNX Runtime dependency.`,
    };
  }

  const missingModule = stderr.match(/ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/i);
  if (missingModule && missingModule[1] && missingModule[1].toLowerCase() !== 'torch') {
    return {
      recognized: true,
      id: 'missing-python-module',
      action: 'repair-python-environment',
      summary: `${toolState.name} is missing the Python package "${missingModule[1]}".`,
      repairingMessage: `Local AI Hub is rebuilding ${toolState.name}'s Python environment automatically.`,
    };
  }

  if (/numpy\.dtype size changed/i.test(stderr) || /skimage\._shared\.geometry/i.test(stderr) || /A module that was compiled using NumPy 1\.x cannot be run in\s*NumPy 2/i.test(stderr) || /_ARRAY_API not found/i.test(stderr)) {
    return {
      recognized: true,
      id: 'python-binary-mismatch',
      action: 'repair-python-environment',
      summary: `${toolState.name} has compiled Python packages that no longer match the NumPy 1.x runtime it needs.`,
      repairingMessage: `Local AI Hub is rebuilding ${toolState.name}'s Python environment automatically.`,
    };
  }

  if (toolState?.id === 'forge' && /FieldInfo' object has no attribute 'in_'/i.test(stderr) && /fastapi\\dependencies\\utils\.py/i.test(stderr)) {
    return {
      recognized: true,
      id: 'forge-pydantic-fastapi-mismatch',
      action: 'repair-python-environment',
      summary: `${toolState.name} has a FastAPI or Gradio dependency stack that drifted away from Forge's pinned Pydantic build.`,
      repairingMessage: `Local AI Hub is rebuilding ${toolState.name}'s pinned web UI dependencies automatically.`,
    };
  }

  const missingManagedPython = stderr.match(/No Python at ['"]*([^'"\r\n]+python\.exe)['"]*/i);
  if (missingManagedPython?.[1] && toolState?.source === 'managed') {
    return {
      recognized: true,
      id: 'managed-python-bootstrap-missing',
      action: 'repair-python-environment',
      summary: `${toolState.name}'s managed Python environment still points at ${missingManagedPython[1]}, but that Python install is no longer present on this PC. Local AI Hub needs to rebuild the environment with one of its managed Python runtimes.`,
      repairingMessage: `Local AI Hub is rebuilding ${toolState.name}'s Python environment because its previous base Python install is missing.`,
    };
  }

  const missingPath = stderr.match(/FileNotFoundError:\s+\[Errno 2\]\s+No such file or directory:\s+['"]([^'"]+)['"]/i);
  if (missingPath && missingPath[1]) {
    return {
      recognized: true,
      id: 'missing-launch-path',
      action: 'none',
      summary: `${toolState.name} is pointing at a file that is missing on this PC: ${missingPath[1]}. Run Repair or reinstall it.`,
      repairingMessage: null,
    };
  }

  if (/Couldn't find Stable Diffusion in any of:/i.test(stderr)) {
    return {
      recognized: true,
      id: 'missing-stable-diffusion-layout',
      action: 'none',
      summary: `${toolState.name} is missing the Stable Diffusion source folders that its upstream launcher expects. Local AI Hub should launch this tool through its bootstrap step or rebuild its install.`,
      repairingMessage: null,
    };
  }

  return {
    recognized: false,
    id: 'unrecognized',
    action: 'none',
    summary: summarizeUnknownFailure(toolState, stderrText),
    repairingMessage: null,
  };
}

function selectPyTorchRepairCandidates(hardware) {
  if (!hardware?.nvidiaSmiAvailable || !/nvidia/i.test(`${hardware.gpuVendor || ''} ${hardware.gpuModel || ''}`)) {
    return [];
  }

  const cudaVersion = parseVersionParts(hardware.nvidiaCudaVersion);
  if (cudaVersion.length === 0) {
    return [];
  }

  const candidates = PYTORCH_REPAIR_BUILDS.filter((build) => compareVersions(cudaVersion, build.minCudaVersion) >= 0);
  if (candidates.length === 0) {
    return [];
  }

  const sorted = [...candidates].sort((left, right) => {
    const comparison = compareVersions(left.minCudaVersion, right.minCudaVersion);
    return isLegacyNvidiaModel(hardware.gpuModel) ? comparison : comparison * -1;
  });

  return sorted;
}

function getManagedPythonPath(toolState) {
  return toolState.launchProfile?.pythonPath || path.join(toolState.venvDir || '', 'Scripts', 'python.exe');
}

async function removeStaleTorchArtifacts(toolState, logger) {
  const sitePackagesDir = path.join(toolState.venvDir || '', 'Lib', 'site-packages');
  if (!(await fs.pathExists(sitePackagesDir))) {
    return;
  }

  const entries = await fs.readdir(sitePackagesDir, { withFileTypes: true });
  const staleEntries = entries
    .filter((entry) => entry.name.startsWith('~') && /orch/i.test(entry.name))
    .map((entry) => path.join(sitePackagesDir, entry.name));

  for (const targetPath of staleEntries) {
    await fs.remove(targetPath).catch(() => null);
    await logger.info('Removed a stale PyTorch package artifact before reinstalling CUDA wheels.', {
      targetPath,
    });
  }
}

async function reinstallPyTorchBuild(toolState, build, logger) {
  const pythonPath = getManagedPythonPath(toolState);
  await removeStaleTorchArtifacts(toolState, logger);
  await runCommand(
    pythonPath,
    [
      '-m',
      'pip',
      'install',
      '--upgrade',
      '--force-reinstall',
      '--no-cache-dir',
      `torch==${build.torch}`,
      `torchvision==${build.torchvision}`,
      `torchaudio==${build.torchaudio}`,
      '--index-url',
      build.indexUrl,
    ],
    {
      cwd: toolState.appDir,
      errorMessage: `Local AI Hub could not reinstall PyTorch with ${build.label}.`,
    },
  );

  await logger.info('PyTorch reinstall command completed.', {
    build: build.channel,
    indexUrl: build.indexUrl,
  });
}

async function verifyPyTorchBuild(toolState, build, logger) {
  const pythonPath = getManagedPythonPath(toolState);
  await removeStaleTorchArtifacts(toolState, logger);
  const verificationSnippet = [
    'import json',
    'info = {}',
    'import torch',
    "info['torchVersion'] = getattr(torch, '__version__', 'unknown')",
    "info['cudaAvailable'] = bool(torch.cuda.is_available())",
    "info['cudaVersion'] = getattr(torch.version, 'cuda', None)",
    "info['deviceName'] = torch.cuda.get_device_name(0) if info['cudaAvailable'] else None",
    'print(json.dumps(info))',
  ].join('; ');

  const result = await runCommand(pythonPath, ['-c', verificationSnippet], {
    cwd: toolState.appDir,
    errorMessage: 'Local AI Hub could not verify the PyTorch runtime after reinstalling it.',
  });

  const payload = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{'));

  if (!payload) {
    throw new Error('Local AI Hub could not read the PyTorch verification result.');
  }

  const verification = JSON.parse(payload);
  if (!verification.cudaAvailable) {
    throw new Error(`PyTorch still cannot see CUDA after reinstalling the ${build.label} build.`);
  }

  await logger.info('PyTorch verification succeeded.', verification);
  return verification;
}

async function repairPyTorchCuda(toolState, logger, hardware) {
  const candidates = selectPyTorchRepairCandidates(hardware);
  if (candidates.length === 0) {
    throw new Error('Local AI Hub could not match this PC to a supported NVIDIA PyTorch CUDA build from pytorch.org.');
  }

  let lastError = null;
  for (const build of candidates) {
    try {
      await logger.info('Trying a PyTorch CUDA repair candidate.', {
        build: build.channel,
        label: build.label,
      });
      await reinstallPyTorchBuild(toolState, build, logger);
      const verification = await verifyPyTorchBuild(toolState, build, logger);
      return {
        repairMessage: `Local AI Hub reinstalled PyTorch with ${build.label} for ${hardware.gpuModel}.`,
        verification,
      };
    } catch (error) {
      lastError = error;
      await logger.warn('PyTorch CUDA repair candidate failed.', {
        build: build.channel,
        error,
      });
    }
  }

  throw lastError || new Error('Local AI Hub could not repair the PyTorch CUDA runtime.');
}

async function waitForToolReady(toolState) {
  if (!toolState.launchUrl && !toolState.healthUrl) {
    return true;
  }

  const deadline = Date.now() + RESTART_WAIT_MS;
  while (Date.now() < deadline) {
    if (await probeUrl(toolState.healthUrl || toolState.launchUrl)) {
      return true;
    }
    await sleep(1000);
  }

  return false;
}

async function attemptAutomaticLaunchRecovery(toolState, stderrText, options = {}) {
  if (!toolState?.id || recoveryLocks.has(toolState.id)) {
    return {
      handled: false,
      recovered: false,
      userMessage: null,
    };
  }

  recoveryLocks.add(toolState.id);
  const logger = options.logger;

  try {
    const [hardwareSnapshot, nvidia] = await Promise.all([detectHardwareSnapshot(), getNvidiaRuntimeDetails()]);
    const hardware = {
      ...hardwareSnapshot,
      ...(nvidia || {}),
      nvidiaSmiAvailable: Boolean(nvidia?.nvidiaSmiAvailable || hardwareSnapshot?.nvidiaSmiAvailable),
    };
    const diagnosis = diagnoseLaunchFailure(toolState, stderrText, hardware);

    await logger.error('Captured launch failure stderr.', {
      diagnosisId: diagnosis.id,
      summary: diagnosis.summary,
      stderr: stderrText,
    });

    if (!diagnosis.recognized) {
      return {
        handled: true,
        recovered: false,
        userMessage: diagnosis.summary,
      };
    }

    if (toolState.source !== 'managed') {
      return {
        handled: true,
        recovered: false,
        userMessage: `${toolState.name} failed to start, but Local AI Hub only applies automatic Python and CUDA repairs to tools it installed itself. Open the logs folder for the full error.`,
      };
    }

    if (diagnosis.action === 'none') {
      return {
        handled: true,
        recovered: false,
        userMessage: diagnosis.summary,
      };
    }

    await upsertTool({
      id: toolState.id,
      status: 'stopped',
      lastError: null,
      lastRepairMessage: diagnosis.repairingMessage,
    });

    let repairMessage = diagnosis.repairingMessage;
    if (diagnosis.action === 'repair-pytorch-cuda') {
      const repairResult = await repairPyTorchCuda(toolState, logger, hardware);
      repairMessage = repairResult.repairMessage;
    } else if (diagnosis.action === 'repair-python-environment') {
      const repairedTool = await repairToolInstallation(toolState, {});
      repairMessage = repairedTool.lastRepairMessage;
    }

    const config = await readConfig();
    const refreshedTool = config.tools[toolState.id] || toolState;
    await upsertTool({
      id: toolState.id,
      lastRepairMessage: `${repairMessage} Local AI Hub is retrying the launch now.`,
      lastError: null,
      status: 'stopped',
    });

    let retryLaunchResult = null;
    if (typeof options.retryLaunch === 'function') {
      retryLaunchResult = await options.retryLaunch({
        ...refreshedTool,
        lastRepairMessage: repairMessage,
      });
    }

    const readyTarget = {
      ...refreshedTool,
      launchUrl: refreshedTool.launchUrl || toolState.launchUrl,
      healthUrl: refreshedTool.healthUrl || toolState.healthUrl,
    };
    const usesLocalUrl = Boolean(readyTarget.launchUrl || readyTarget.healthUrl);
    const ready = usesLocalUrl
      ? await waitForToolReady(readyTarget)
      : retryLaunchResult?.status === 'running';

    if (!ready) {
      return {
        handled: true,
        recovered: false,
        userMessage: usesLocalUrl
          ? `${toolState.name} was repaired and retried, but it still did not answer on its local port. Open the logs folder for the full launch output.`
          : `${toolState.name} was repaired and retried, but it still did not stay running. Open the logs folder for the full launch output.`,
      };
    }

    const successMessage = `${repairMessage} ${toolState.name} restarted successfully.`;
    await upsertTool({
      id: toolState.id,
      status: 'running',
      lastError: null,
      lastRepairMessage: successMessage,
    });

    await logger.info('Automatic launch recovery succeeded.', {
      message: successMessage,
    });

    return {
      handled: true,
      recovered: true,
      userMessage: successMessage,
    };
  } catch (error) {
    const message = humanizeError(error, `${toolState.name} still could not start after Local AI Hub tried to repair it.`);
    await logger.error('Automatic launch recovery failed.', {
      error,
      stderr: stderrText,
    });
    return {
      handled: true,
      recovered: false,
      userMessage: message,
    };
  } finally {
    recoveryLocks.delete(toolState.id);
  }
}

module.exports = {
  attemptAutomaticLaunchRecovery,
  diagnoseLaunchFailure,
  selectPyTorchRepairCandidates,
};


