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
    return `${toolState.name} stopped before it finished starting. NestAI could not match the error automatically. Open the logs folder for the full details.`;
  }

  return `${toolState.name} stopped before it finished starting. NestAI could not match the error automatically. The tool reported: ${lastLine}. Open the logs folder for the full details.`;
}

function diagnoseLaunchFailure(toolState, stderrText, hardware) {
  const stderr = String(stderrText || '');
  const normalized = stderr.toLowerCase();
  const gpuModel = hardware?.gpuModel || 'your GPU';

  if (/torch not compiled with cuda enabled/i.test(stderr)) {
    return {
      recognized: true,
      id: 'torch-cpu-build',
      action: 'repair-pytorch-cuda',
      summary: `${toolState.name} is using a CPU-only PyTorch build instead of an NVIDIA CUDA build.`,
      repairingMessage: `NestAI found a CPU-only PyTorch build and is reinstalling the NVIDIA build for ${gpuModel}.`,
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
      repairingMessage: `NestAI is reinstalling PyTorch for the NVIDIA driver it detected on this machine.`,
    };
  }

  if (/moduleNotFoundError:\s+No module named ['"]torch['"]/i.test(stderr)) {
    return {
      recognized: true,
      id: 'missing-torch',
      action: 'repair-pytorch-cuda',
      summary: `${toolState.name} is missing PyTorch in its Python environment.`,
      repairingMessage: `NestAI is reinstalling PyTorch with the correct CUDA build for ${gpuModel}.`,
    };
  }

  if (/dll load failed while importing (torch|torch_cpu|torch_cuda|c10_cuda|fbgemm)/i.test(stderr) || (/winerror 126/i.test(normalized) && /torch/i.test(normalized))) {
    return {
      recognized: true,
      id: 'torch-dll-mismatch',
      action: 'repair-pytorch-cuda',
      summary: `${toolState.name} has a broken PyTorch CUDA runtime in its Python environment.`,
      repairingMessage: `NestAI is reinstalling PyTorch and CUDA support for ${gpuModel}.`,
    };
  }

  const missingModule = stderr.match(/ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/i);
  if (missingModule && missingModule[1] && missingModule[1].toLowerCase() !== 'torch') {
    return {
      recognized: true,
      id: 'missing-python-module',
      action: 'repair-python-environment',
      summary: `${toolState.name} is missing the Python package "${missingModule[1]}".`,
      repairingMessage: `NestAI is rebuilding ${toolState.name}'s Python environment automatically.`,
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
      errorMessage: `NestAI could not reinstall PyTorch with ${build.label}.`,
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
    errorMessage: 'NestAI could not verify the PyTorch runtime after reinstalling it.',
  });

  const payload = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{'));

  if (!payload) {
    throw new Error('NestAI could not read the PyTorch verification result.');
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
    throw new Error('NestAI could not match this PC to a supported NVIDIA PyTorch CUDA build from pytorch.org.');
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
        repairMessage: `NestAI reinstalled PyTorch with ${build.label} for ${hardware.gpuModel}.`,
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

  throw lastError || new Error('NestAI could not repair the PyTorch CUDA runtime.');
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
        userMessage: `${toolState.name} failed to start, but NestAI only applies automatic Python and CUDA repairs to tools it installed itself. Open the logs folder for the full error.`,
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
      lastRepairMessage: `${repairMessage} NestAI is retrying the launch now.`,
      lastError: null,
      status: 'stopped',
    });

    if (typeof options.retryLaunch === 'function') {
      await options.retryLaunch({
        ...refreshedTool,
        lastRepairMessage: repairMessage,
      });
    }

    const ready = await waitForToolReady({
      ...refreshedTool,
      launchUrl: refreshedTool.launchUrl || toolState.launchUrl,
      healthUrl: refreshedTool.healthUrl || toolState.healthUrl,
    });

    if (!ready) {
      return {
        handled: true,
        recovered: false,
        userMessage: `${toolState.name} was repaired and retried, but it still did not answer on its local port. Open the logs folder for the full launch output.`,
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
    const message = humanizeError(error, `${toolState.name} still could not start after NestAI tried to repair it.`);
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
};

