export function formatMemory(mb) {
  if (!Number.isFinite(mb) || mb <= 0) {
    return 'Not available';
  }

  const gb = mb / 1024;
  const digits = gb >= 10 ? 0 : 1;
  return `${gb.toFixed(digits).replace(/\.0$/, '')} GB`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'Size unavailable';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[unitIndex]}`;
}

export function formatUsage(usedMb, totalMb) {
  if (!Number.isFinite(totalMb) || totalMb <= 0) {
    return 'Not available';
  }

  if (!Number.isFinite(usedMb) || usedMb < 0) {
    return `Total ${formatMemory(totalMb)}`;
  }

  return `${formatMemory(usedMb)} / ${formatMemory(totalMb)}`;
}

export function formatDiskAvailability(freeBytes, totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return 'Not available';
  }

  const freeLabel = Number.isFinite(freeBytes) && freeBytes >= 0 ? (freeBytes === 0 ? '0 B' : formatBytes(freeBytes)) : 'Unknown';
  return `${freeLabel} free of ${formatBytes(totalBytes)}`;
}

export function formatTimestamp(value) {
  if (!value) {
    return 'Unknown time';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function statusClass(status) {
  if (status === 'running') {
    return 'border-signal/40 bg-signal/10 text-signal';
  }

  if (status === 'starting') {
    return 'border-amber-300/40 bg-amber-300/10 text-amber-100';
  }

  if (status === 'error') {
    return 'border-danger/40 bg-danger/10 text-danger';
  }

  return 'border-white/10 bg-white/5 text-slate-300';
}

export function progressWidth(progress) {
  return `${Math.max(0, Math.min(100, progress || 0))}%`;
}

