const path = require('path');

const { runBackgroundTask } = require('./backgroundTaskService');

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

async function getNvidiaRuntimeDetails() {
  return runBackgroundTask('get-nvidia-runtime-details');
}

async function detectStorageSnapshot() {
  return runBackgroundTask('detect-storage-snapshot');
}

async function detectHardwareSnapshot() {
  return runBackgroundTask('detect-hardware-snapshot');
}

async function getDiskSnapshotForPath(targetPath) {
  const disks = await detectStorageSnapshot();
  return {
    disk: findDiskForPath(disks, targetPath),
    disks,
  };
}

async function getLiveResourceUsage(targetPath = null, options = {}) {
  return runBackgroundTask('get-live-resource-usage', {
    includeDisk: options.includeDisk !== false,
    targetPath,
  });
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
  normalizeMb,
};
