const path = require('path');

const { normalizeDirectoryPath } = require('./configService');
const { findManagedToolsRootForPath } = require('./pathSafetyService');

const INSTALL_LIFECYCLE = {
  MANAGED: 'managed',
  OFFICIAL_INSTALLER: 'official-installer',
  EXTERNAL: 'external',
};

const INSTALL_DESTINATION_CONTROL = {
  MANAGED_ROOT: 'managed-root',
  INSTALLER_ROOT: 'installer-root',
  GUIDED: 'guided',
};

const TOOL_LIFECYCLE_CLASS = {
  MANAGED: 'managed-install',
  OFFICIAL_MANAGED: 'official-managed-install',
  DETECTED_OFFICIAL: 'detected-official-install',
  DETECTED_EXTERNAL: 'detected-external-install',
};

function normalizeOptionalPath(value) {
  const text = String(value || '').trim();
  return text ? normalizeDirectoryPath(text) : null;
}

function usesInstallerExecutable(manifest) {
  return String(manifest?.installInstructions?.kind || 'zip') === 'installer-exe';
}

function installerArgsAcceptInstallPath(manifest) {
  return (manifest?.installInstructions?.installerArgs || []).some((entry) => /\{(?:appDir|installDir)\}/.test(String(entry || '')));
}

function getManifestLifecycle(manifest) {
  return usesInstallerExecutable(manifest) ? INSTALL_LIFECYCLE.OFFICIAL_INSTALLER : INSTALL_LIFECYCLE.MANAGED;
}

function getManifestDestinationControl(manifest) {
  if (!usesInstallerExecutable(manifest)) {
    return INSTALL_DESTINATION_CONTROL.MANAGED_ROOT;
  }

  if (manifest?.installInstructions?.managedInstallSupported === false) {
    return INSTALL_DESTINATION_CONTROL.GUIDED;
  }

  return installerArgsAcceptInstallPath(manifest)
    ? INSTALL_DESTINATION_CONTROL.INSTALLER_ROOT
    : INSTALL_DESTINATION_CONTROL.GUIDED;
}

function getManifestInstallContract(manifest) {
  const lifecycleMode = getManifestLifecycle(manifest);
  const destinationControl = getManifestDestinationControl(manifest);
  const supportsSilentDestination = destinationControl !== INSTALL_DESTINATION_CONTROL.GUIDED;

  let locationSummary = 'Local AI Hub installs this tool directly inside its managed tools folder under your selected install root.';
  if (destinationControl === INSTALL_DESTINATION_CONTROL.INSTALLER_ROOT) {
    locationSummary = 'Local AI Hub hands your chosen tool folder to the official installer when that installer accepts a destination argument.';
  } else if (destinationControl === INSTALL_DESTINATION_CONTROL.GUIDED) {
    locationSummary = 'Local AI Hub can download and open the official installer, but the vendor installer decides or confirms the final destination.';
  }

  return {
    destinationControl,
    lifecycleMode,
    locationSummary,
    supportsRequestedInstallRoot: destinationControl !== INSTALL_DESTINATION_CONTROL.GUIDED,
    supportsSilentDestination,
  };
}

function deriveInstallRootFromState(toolState) {
  const candidatePath = normalizeOptionalPath(toolState?.installDir || toolState?.appDir || '');
  if (!candidatePath) {
    return null;
  }

  const toolsRoot = findManagedToolsRootForPath(candidatePath);
  return toolsRoot ? path.dirname(toolsRoot) : null;
}

function isToolInManagedLocation(toolState, manifest) {
  if (usesInstallerExecutable(manifest)) {
    return false;
  }

  const installRoot = deriveInstallRootFromState(toolState);
  const candidatePath = normalizeOptionalPath(
    toolState?.installDir || toolState?.appDir || toolState?.detectedPath || toolState?.displayPath || '',
  );

  return Boolean(installRoot && candidatePath);
}

function inferLifecycleMode(toolState, manifest) {
  if (toolState?.source === 'managed' && usesInstallerExecutable(manifest)) {
    return INSTALL_LIFECYCLE.OFFICIAL_INSTALLER;
  }

  if (
    toolState?.source === 'managed' ||
    toolState?.managedByLocalAIHub ||
    (!usesInstallerExecutable(manifest) && toolState?.installedByLocalAIHub === true) ||
    isToolInManagedLocation(toolState, manifest)
  ) {
    return INSTALL_LIFECYCLE.MANAGED;
  }

  const normalizedValue = String(toolState?.lifecycleMode || '').trim().toLowerCase();
  if (Object.values(INSTALL_LIFECYCLE).includes(normalizedValue)) {
    return normalizedValue;
  }

  if (usesInstallerExecutable(manifest)) {
    return INSTALL_LIFECYCLE.OFFICIAL_INSTALLER;
  }

  return INSTALL_LIFECYCLE.EXTERNAL;
}
function inferInstalledByLocalAIHub(toolState, manifest) {
  if (typeof toolState?.installedByLocalAIHub === 'boolean') {
    return toolState.installedByLocalAIHub;
  }

  if (toolState?.source === 'managed' || toolState?.managedByLocalAIHub) {
    return true;
  }

  if (!usesInstallerExecutable(manifest)) {
    return false;
  }

  const hasOwnedInstallerCache = Boolean(String(toolState?.downloadCachePath || '').trim());
  const hasRequestedInstallRoot = Boolean(normalizeOptionalPath(toolState?.requestedInstallRoot || toolState?.installRoot || ''));
  return hasOwnedInstallerCache && hasRequestedInstallRoot;
}

function getToolLifecycleClass(toolState, manifest, options = {}) {
  const lifecycleMode = options.lifecycleMode || inferLifecycleMode(toolState, manifest);
  const installedByLocalAIHub =
    typeof options.installedByLocalAIHub === 'boolean'
      ? options.installedByLocalAIHub
      : inferInstalledByLocalAIHub(toolState, manifest);

  if (lifecycleMode === INSTALL_LIFECYCLE.MANAGED) {
    return TOOL_LIFECYCLE_CLASS.MANAGED;
  }

  if (lifecycleMode === INSTALL_LIFECYCLE.OFFICIAL_INSTALLER && installedByLocalAIHub) {
    return TOOL_LIFECYCLE_CLASS.OFFICIAL_MANAGED;
  }

  if (lifecycleMode === INSTALL_LIFECYCLE.OFFICIAL_INSTALLER) {
    return TOOL_LIFECYCLE_CLASS.DETECTED_OFFICIAL;
  }

  return TOOL_LIFECYCLE_CLASS.DETECTED_EXTERNAL;
}

function getToolActionSemantics(toolState, manifest, options = {}) {
  const lifecycleMode = options.lifecycleMode || inferLifecycleMode(toolState, manifest);
  const installedByLocalAIHub =
    typeof options.installedByLocalAIHub === 'boolean'
      ? options.installedByLocalAIHub
      : inferInstalledByLocalAIHub(toolState, manifest);
  const lifecycleClass =
    options.lifecycleClass ||
    getToolLifecycleClass(toolState, manifest, {
      installedByLocalAIHub,
      lifecycleMode,
    });
  const installKind = usesInstallerExecutable(manifest) ? 'official-install' : 'install';
  const uninstallKind = lifecycleMode === INSTALL_LIFECYCLE.MANAGED
    ? 'uninstall'
    : lifecycleMode === INSTALL_LIFECYCLE.OFFICIAL_INSTALLER && installedByLocalAIHub
      ? 'official-uninstall'
      : 'remove-from-library';
  const repairKind = lifecycleMode === INSTALL_LIFECYCLE.MANAGED
    ? 'repair-managed'
    : usesInstallerExecutable(manifest)
      ? 'repair-official'
      : 'repair-unavailable';

  return {
    installKind,
    installLabel: installKind === 'official-install' ? 'Install Desktop App' : 'Install',
    installedByLocalAIHub,
    lifecycleClass,
    ownsInstallFiles: uninstallKind !== 'remove-from-library',
    repairAvailable: repairKind !== 'repair-unavailable',
    repairKind,
    repairLabel: repairKind === 'repair-unavailable' ? null : 'Repair',
    uninstallKind,
    uninstallLabel:
      uninstallKind === 'uninstall'
        ? 'Uninstall'
        : uninstallKind === 'official-uninstall'
          ? 'Official Uninstall'
          : 'Remove from Library',
    usesOfficialInstaller: usesInstallerExecutable(manifest),
    usesOfficialUninstaller: uninstallKind === 'official-uninstall',
  };
}

function normalizeToolLifecycle(toolState, manifest) {
  const lifecycleMode = inferLifecycleMode(toolState, manifest);
  const installedByLocalAIHub = inferInstalledByLocalAIHub(toolState, manifest);
  const lifecycleClass = getToolLifecycleClass(toolState, manifest, {
    installedByLocalAIHub,
    lifecycleMode,
  });
  const installRoot = normalizeOptionalPath(toolState?.installRoot) || deriveInstallRootFromState(toolState);
  const requestedInstallRoot =
    normalizeOptionalPath(toolState?.requestedInstallRoot) ||
    installRoot ||
    null;
  const actionSemantics = getToolActionSemantics(toolState, manifest, {
    installedByLocalAIHub,
    lifecycleClass,
    lifecycleMode,
  });

  return {
    ...toolState,
    actionSemantics,
    installRoot,
    installedByLocalAIHub,
    lifecycleClass,
    lifecycleMode,
    managedByLocalAIHub: lifecycleMode === INSTALL_LIFECYCLE.MANAGED,
    requestedInstallRoot,
  };
}

function isDirectManagedTool(toolState, manifest) {
  return inferLifecycleMode(toolState, manifest) === INSTALL_LIFECYCLE.MANAGED;
}

function isOfficialInstallerTool(toolState, manifest) {
  return inferLifecycleMode(toolState, manifest) === INSTALL_LIFECYCLE.OFFICIAL_INSTALLER;
}

function allowsLocalSnapshots(toolState, manifest) {
  return isDirectManagedTool(toolState, manifest);
}

module.exports = {
  INSTALL_DESTINATION_CONTROL,
  INSTALL_LIFECYCLE,
  TOOL_LIFECYCLE_CLASS,
  allowsLocalSnapshots,
  deriveInstallRootFromState,
  getManifestDestinationControl,
  getManifestInstallContract,
  getManifestLifecycle,
  getToolActionSemantics,
  getToolLifecycleClass,
  inferInstalledByLocalAIHub,
  inferLifecycleMode,
  installerArgsAcceptInstallPath,
  isDirectManagedTool,
  isOfficialInstallerTool,
  normalizeToolLifecycle,
  usesInstallerExecutable,
};


