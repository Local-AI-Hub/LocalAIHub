const si = require('systeminformation');

const { runCommand } = require('./commandService');

function normalizeMb(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  if (value > 1024 * 1024) {
    return Math.round(value / 1024 / 1024);
  }

  return Math.round(value);
}

function pickPrimaryGpu(controllers) {
  if (!Array.isArray(controllers) || controllers.length === 0) {
    return {};
  }

  return [...controllers].sort((left, right) => {
    const leftDedicated = /nvidia|amd|radeon|geforce|rtx|gtx/i.test(
      `${left.vendor || ''} ${left.model || ''}`,
    );
    const rightDedicated = /nvidia|amd|radeon|geforce|rtx|gtx/i.test(
      `${right.vendor || ''} ${right.model || ''}`,
    );
    const leftScore = (leftDedicated ? 100000 : 0) + normalizeMb(left.vram || left.memoryTotal);
    const rightScore = (rightDedicated ? 100000 : 0) + normalizeMb(right.vram || right.memoryTotal);
    return rightScore - leftScore;
  })[0];
}

function buildCompatibilityMessage(gpuModel, vramMb, systemRamMb) {
  const vramGb = Math.max(1, Math.round((vramMb / 1024) * 10) / 10);
  const ramGb = Math.round(systemRamMb / 1024);

  if (vramMb >= 12 * 1024 && systemRamMb >= 32 * 1024) {
    return `Your ${gpuModel} is ready for full local image workflows with room for larger models.`;
  }

  if (vramMb >= 8 * 1024) {
    return `Your ${gpuModel} is supported for most tools with balanced settings.`;
  }

  if (vramMb >= 6 * 1024) {
    return `Your ${gpuModel} ${vramGb}GB is supported in Low VRAM mode.`;
  }

  if (vramMb >= 4 * 1024) {
    return `Your ${gpuModel} can run lighter workflows, but keep expectations to smaller models and reduced image sizes.`;
  }

  if (ramGb < 16) {
    return 'Your system is below the recommended GPU and RAM range. Local AI Hub can still help, but expect CPU-only fallbacks and slower setup steps.';
  }

  return `Your ${gpuModel} is below the recommended GPU range. Local AI Hub can still manage the tools, but most workloads will need conservative settings.`;
}

function parseNvidiaQueryLine(line) {
  const parts = String(line || '').split(',').map((part) => part.trim());
  if (parts.length < 4) {
    return null;
  }

  const vramMb = Number.parseInt(parts[2], 10);
  const vramUsedMb = Number.parseInt(parts[3], 10);

  return {
    gpuVendor: 'NVIDIA',
    gpuModel: parts[0],
    nvidiaDriverVersion: parts[1],
    vramMb: Number.isFinite(vramMb) ? vramMb : 0,
    vramUsedMb: Number.isFinite(vramUsedMb) ? vramUsedMb : null,
  };
}

function parseCudaVersionFromSmi(output) {
  const match = String(output || '').match(/CUDA Version:\s*([0-9.]+)/i);
  return match ? match[1] : null;
}

async function getNvidiaRuntimeDetails() {
  const summary = await runCommand('nvidia-smi', [], {
    allowFailure: true,
  });
  if (summary.code !== 0) {
    return null;
  }

  const query = await runCommand(
    'nvidia-smi',
    ['--query-gpu=name,driver_version,memory.total,memory.used', '--format=csv,noheader,nounits'],
    { allowFailure: true },
  );

  const firstLine = String(query.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const parsed = parseNvidiaQueryLine(firstLine);
  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    nvidiaCudaVersion: parseCudaVersionFromSmi(summary.stdout || summary.stderr || ''),
    nvidiaSmiAvailable: true,
  };
}

function buildHardwareSnapshot(gpu, memory, nvidia) {
  const fallbackGpuModel = nvidia?.gpuModel || 'Unknown GPU';
  const fallbackVendor = nvidia?.gpuVendor || 'Unknown vendor';
  const vramMb = nvidia?.vramMb || normalizeMb(gpu?.vram || gpu?.memoryTotal);
  const systemRamMb = Math.round((memory.total || 0) / 1024 / 1024);
  const gpuModel = gpu?.model || fallbackGpuModel;
  const gpuVendor = gpu?.vendor || fallbackVendor;

  return {
    gpuModel,
    gpuVendor,
    vramMb,
    systemRamMb,
    compatibilityMessage: buildCompatibilityMessage(gpuModel, vramMb, systemRamMb),
    detectedAt: new Date().toISOString(),
    nvidiaDriverVersion: nvidia?.nvidiaDriverVersion || null,
    nvidiaCudaVersion: nvidia?.nvidiaCudaVersion || null,
    nvidiaSmiAvailable: Boolean(nvidia?.nvidiaSmiAvailable),
  };
}

function resolveControllerVramTotal(gpu, nvidia) {
  return nvidia?.vramMb || normalizeMb(gpu?.vram || gpu?.memoryTotal);
}

function resolveControllerVramUsed(gpu, vramTotalMb) {
  const memoryUsed = Number(gpu?.memoryUsed);
  if (Number.isFinite(memoryUsed) && memoryUsed >= 0) {
    return normalizeMb(memoryUsed);
  }

  const utilizationMemory = Number(gpu?.utilizationMemory);
  if (Number.isFinite(utilizationMemory) && utilizationMemory >= 0) {
    if (utilizationMemory <= 100 && vramTotalMb > 0) {
      return Math.min(vramTotalMb, Math.round((utilizationMemory / 100) * vramTotalMb));
    }

    return normalizeMb(utilizationMemory);
  }

  return null;
}

async function detectHardwareSnapshot() {
  const [graphics, memory, nvidia] = await Promise.all([si.graphics(), si.mem(), getNvidiaRuntimeDetails()]);
  const gpu = pickPrimaryGpu(graphics.controllers);
  return buildHardwareSnapshot(gpu, memory, nvidia);
}

async function getLiveResourceUsage() {
  const [graphics, memory, nvidia] = await Promise.all([si.graphics(), si.mem(), getNvidiaRuntimeDetails()]);
  const gpu = pickPrimaryGpu(graphics.controllers);
  const vramTotalMb = resolveControllerVramTotal(gpu, nvidia);
  const controllerVramUsedMb = resolveControllerVramUsed(gpu, vramTotalMb);
  const vramUsedMb = Number.isFinite(nvidia?.vramUsedMb)
    ? nvidia.vramUsedMb
    : controllerVramUsedMb;

  return {
    gpuName: gpu.model || nvidia?.gpuModel || 'Unknown GPU',
    ramUsedMb: Math.round((memory.active || memory.used || 0) / 1024 / 1024),
    ramTotalMb: Math.round((memory.total || 0) / 1024 / 1024),
    vramUsedMb: Number.isFinite(vramUsedMb) ? vramUsedMb : null,
    vramTotalMb,
    vramSource: Number.isFinite(nvidia?.vramUsedMb) ? 'nvidia-smi' : controllerVramUsedMb !== null ? 'systeminformation' : 'unknown',
    nvidiaDriverVersion: nvidia?.nvidiaDriverVersion || null,
    nvidiaCudaVersion: nvidia?.nvidiaCudaVersion || null,
  };
}

module.exports = {
  detectHardwareSnapshot,
  getLiveResourceUsage,
  getNvidiaRuntimeDetails,
};
