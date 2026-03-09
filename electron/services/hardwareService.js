const path = require('path');
const si = require('systeminformation');

const { runCommand } = require('./commandService');

const LOW_DISK_CONFIRMATION_RATIO = 0.1;

function normalizeMb(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  if (value > 1024 * 1024) {
    return Math.round(value / 1024 / 1024);
  }

  return Math.round(value);
}

function normalizeDriveRoot(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const driveMatch = raw.match(/^[A-Za-z]:/);
  if (driveMatch) {
    return `${driveMatch[0]}\\`;
  }

  return raw.replace(/[\\/]+$/, '');
}

function buildDiskSnapshot(entries = []) {
  const disks = [];
  const seen = new Set();

  for (const entry of entries || []) {
    const mount = normalizeDriveRoot(entry.mount || entry.fs || entry.drive || '');
    if (!mount) {
      continue;
    }

    const key = mount.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const sizeBytes = Number(entry.size || 0);
    const usedBytes = Number(entry.used || 0);
    const freeBytes = Math.max(0, sizeBytes - usedBytes);
    disks.push({
      mount,
      sizeBytes,
      usedBytes,
      freeBytes,
      usePercent: sizeBytes > 0 ? Math.round((usedBytes / sizeBytes) * 1000) / 10 : null,
    });
  }

  return disks.sort((left, right) => left.mount.localeCompare(right.mount));
}

function findDiskForPath(disks = [], targetPath) {
  const driveRoot = normalizeDriveRoot(path.parse(path.resolve(String(targetPath || ''))).root);
  if (!driveRoot) {
    return null;
  }

  return disks.find((disk) => normalizeDriveRoot(disk.mount).toLowerCase() === driveRoot.toLowerCase()) || null;
}

function assessDiskSpace(disk, requiredBytes, options = {}) {
  const minimumRemainingRatio =
    Number(options.minimumRemainingRatio) > 0 ? Number(options.minimumRemainingRatio) : LOW_DISK_CONFIRMATION_RATIO;
  const totalBytes = Number(disk?.sizeBytes || 0);
  const freeBytes = Number(disk?.freeBytes || 0);
  const hasKnownRequirement = Number.isFinite(requiredBytes) && requiredBytes > 0;
  const hasDiskInfo = totalBytes > 0 && freeBytes >= 0;
  const remainingBytes = hasKnownRequirement && hasDiskInfo ? freeBytes - requiredBytes : freeBytes;
  const remainingRatio = hasDiskInfo ? remainingBytes / totalBytes : null;
  const currentFreeRatio = hasDiskInfo ? freeBytes / totalBytes : null;
  const blocked = hasDiskInfo && hasKnownRequirement && remainingBytes < 0;
  const requiresConfirmation = blocked
    ? false
    : hasDiskInfo &&
      (hasKnownRequirement ? remainingRatio < minimumRemainingRatio : currentFreeRatio < minimumRemainingRatio);

  return {
    availableBytes: freeBytes,
    blocked,
    currentFreeRatio,
    mount: disk?.mount || '',
    remainingBytes: hasKnownRequirement && hasDiskInfo ? Math.max(0, remainingBytes) : freeBytes,
    remainingRatio,
    requiredBytes: hasKnownRequirement ? requiredBytes : 0,
    requiresConfirmation,
    sizeKnown: hasKnownRequirement,
    totalBytes,
  };
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

async function detectStorageSnapshot() {
  const entries = await si.fsSize().catch(() => []);
  return buildDiskSnapshot(entries);
}

function buildHardwareSnapshot(gpu, memory, nvidia, disks) {
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
    disks,
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
  const [graphics, memory, nvidia, disks] = await Promise.all([si.graphics(), si.mem(), getNvidiaRuntimeDetails(), detectStorageSnapshot()]);
  const gpu = pickPrimaryGpu(graphics.controllers);
  return buildHardwareSnapshot(gpu, memory, nvidia, disks);
}

async function getDiskSnapshotForPath(targetPath) {
  const disks = await detectStorageSnapshot();
  return {
    disks,
    disk: findDiskForPath(disks, targetPath),
  };
}

async function getLiveResourceUsage(targetPath = null) {
  const [graphics, memory, nvidia, disks] = await Promise.all([
    si.graphics(),
    si.mem(),
    getNvidiaRuntimeDetails(),
    targetPath ? detectStorageSnapshot().catch(() => []) : Promise.resolve([]),
  ]);
  const gpu = pickPrimaryGpu(graphics.controllers);
  const vramTotalMb = resolveControllerVramTotal(gpu, nvidia);
  const controllerVramUsedMb = resolveControllerVramUsed(gpu, vramTotalMb);
  const vramUsedMb = Number.isFinite(nvidia?.vramUsedMb)
    ? nvidia.vramUsedMb
    : controllerVramUsedMb;
  const targetDisk = targetPath ? findDiskForPath(disks, targetPath) : null;

  return {
    diskFreeBytes: targetDisk?.freeBytes || null,
    diskMount: targetDisk?.mount || null,
    diskTotalBytes: targetDisk?.sizeBytes || null,
    diskUsePercent: targetDisk?.usePercent ?? null,
    diskUsedBytes: targetDisk?.usedBytes || null,
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
  LOW_DISK_CONFIRMATION_RATIO,
  assessDiskSpace,
  buildDiskSnapshot,
  detectHardwareSnapshot,
  detectStorageSnapshot,
  findDiskForPath,
  getDiskSnapshotForPath,
  getLiveResourceUsage,
  getNvidiaRuntimeDetails,
  normalizeDriveRoot,
};

