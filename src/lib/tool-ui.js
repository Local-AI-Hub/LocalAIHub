import { formatMemory } from './formatters';

export function evaluateCompatibility(manifest, hardware) {
  const profile = manifest?.compatibility;
  if (!profile || !hardware) {
    return {
      label: 'Hardware unknown',
      tone: 'neutral',
      message: 'Local AI Hub has not finished reading this machine yet.',
    };
  }

  const vramMb = hardware.vramMb || 0;
  const ramMb = hardware.systemRamMb || 0;
  const minimumVramMb = profile.minimumVramMb || 0;
  const recommendedVramMb = profile.recommendedVramMb || minimumVramMb;
  const minimumRamMb = profile.minimumRamMb || 0;
  const recommendedRamMb = profile.recommendedRamMb || minimumRamMb;

  if (vramMb >= recommendedVramMb && ramMb >= recommendedRamMb) {
    return {
      label: 'Recommended',
      tone: 'good',
      message: 'This machine has enough GPU and RAM headroom for normal use.',
    };
  }

  if (vramMb >= minimumVramMb && ramMb >= minimumRamMb) {
    return {
      label: minimumVramMb >= 6144 && vramMb < recommendedVramMb ? 'Low VRAM mode' : 'Supported',
      tone: 'info',
      message:
        recommendedVramMb >= 16384
          ? 'This tool can run, but it is aimed at high-VRAM GPUs and will need conservative settings on this machine.'
          : 'This tool should run, but expect smaller batches or lighter models.',
    };
  }

  const shortfalls = [];
  if (vramMb < minimumVramMb) shortfalls.push(`${formatMemory(minimumVramMb)} VRAM`);
  if (ramMb < minimumRamMb) shortfalls.push(`${formatMemory(minimumRamMb)} system RAM`);
  return {
    label: 'Below spec',
    tone: 'warn',
    message: `This tool lists a minimum of ${shortfalls.join(' and ')}. This machine falls below that requirement.`,
  };
}

export function compatibilityClass(tone) {
  if (tone === 'good') {
    return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200';
  }

  if (tone === 'info') {
    return 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100';
  }

  if (tone === 'warn') {
    return 'border-amber-400/30 bg-amber-400/10 text-amber-100';
  }

  if (tone === 'danger') {
    return 'border-rose-400/30 bg-rose-400/10 text-rose-100';
  }

  return 'border-white/10 bg-white/5 text-slate-300';
}

export function toolSearchText(manifest) {
  return [manifest.id, manifest.name, manifest.description, manifest.category].filter(Boolean).join(' ').toLowerCase();
}

export function describeRequirements(manifest) {
  const profile = manifest?.compatibility;
  if (!profile) {
    return 'No hardware guidance available.';
  }

  const parts = [];
  if (profile.recommendedVramMb) {
    parts.push(`${formatMemory(profile.recommendedVramMb)} VRAM target`);
  }
  if (profile.recommendedRamMb) {
    parts.push(`${formatMemory(profile.recommendedRamMb)} system RAM target`);
  }

  return parts.join(' | ') || 'No hardware guidance available.';
}


export function getInstallCapabilities(manifest) {
  return Array.isArray(manifest?.installCapabilities) && manifest.installCapabilities.length
    ? manifest.installCapabilities
    : [
        {
          id: 'default',
          label: manifest?.installContract?.lifecycleMode === 'official-installer' ? 'Desktop App' : 'WebUI',
          installLabel: manifest?.installContract?.lifecycleMode === 'official-installer' ? 'Install Desktop App' : 'Install',
          installedLabel: 'Installed',
        },
      ];
}

export function capabilityIsInstalled(tool, capabilityId) {
  if (!tool) {
    return false;
  }

  const capability = String(capabilityId || 'webui').trim().toLowerCase();
  if (capability === 'default') {
    return Boolean(tool);
  }

  if (tool.installedCapabilities && Object.prototype.hasOwnProperty.call(tool.installedCapabilities, capability)) {
    return Boolean(tool.installedCapabilities[capability]);
  }

  if (capability === 'desktop') {
    return Boolean(tool.desktopCompanion?.installed || (tool.launchModes || []).some((mode) => mode.id === 'desktop'));
  }

  if (capability === 'webui') {
    return Boolean(tool.source === 'managed' || (tool.launchModes || []).some((mode) => mode.id === 'webui'));
  }

  return true;
}
