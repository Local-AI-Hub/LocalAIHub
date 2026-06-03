const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-capability-uninstall');
process.env.APPDATA = path.join(TEST_STORAGE_ROOT, 'Roaming');
process.env.LOCALAPPDATA = path.join(TEST_STORAGE_ROOT, 'Local');

const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          if (name === 'appData') return process.env.APPDATA;
          if (name === 'home') return TEST_STORAGE_ROOT;
          if (name === 'exe') return process.execPath;
          if (name === 'temp') return path.join(TEST_STORAGE_ROOT, 'Temp');
          return TEST_STORAGE_ROOT;
        },
        getVersion() {
          return '0.40.0-test';
        },
        isPackaged: false,
      },
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');
}

function modeIds(toolState) {
  return (toolState.launchModes || []).map((mode) => mode.id).sort();
}

function buildDualState(toolId, manifest, desktopExecutableName) {
  const webuiRoot = path.join(TEST_STORAGE_ROOT, 'tools', toolId);
  const desktopRoot = path.join(TEST_STORAGE_ROOT, 'official', `${manifest.name} Desktop`);
  const desktopExe = path.join(desktopRoot, desktopExecutableName);

  touch(path.join(webuiRoot, 'app', toolId === 'invokeai' ? 'invokeai.yaml' : 'main.py'));
  touch(path.join(webuiRoot, '.venv', 'Scripts', 'python.exe'));
  if (toolId === 'invokeai') {
    touch(path.join(webuiRoot, '.venv', 'Scripts', 'invokeai-web.exe'));
  }
  touch(desktopExe);

  return {
    id: toolId,
    name: manifest.name,
    source: 'managed',
    managedByLocalAIHub: true,
    installDir: webuiRoot,
    appDir: path.join(webuiRoot, 'app'),
    venvDir: path.join(webuiRoot, '.venv'),
    desktopCompanion: {
      installed: true,
      source: 'official-installer',
      installDir: desktopRoot,
      appDir: desktopRoot,
      detectedPath: desktopExe,
      displayPath: desktopExe,
      executablePath: desktopExe,
      installedByLocalAIHub: true,
    },
    installedCapabilities: {
      webui: true,
      desktop: true,
    },
    status: 'stopped',
  };
}

async function main() {
  fs.rmSync(TEST_STORAGE_ROOT, { force: true, recursive: true });

  const { getToolManifest, initializeToolRegistry } = require('../electron/services/toolRegistry');
  const { _test } = require('../electron/services/installerService');

  await initializeToolRegistry();

  const cases = [
    ['comfyui', 'ComfyUI.exe'],
    ['invokeai', 'Invoke Community Edition.exe'],
  ];

  for (const [toolId, desktopExecutableName] of cases) {
    const manifest = getToolManifest(toolId);
    assert(manifest?.companionDesktop, `${toolId} should have a desktop companion manifest.`);

    const dualState = buildDualState(toolId, manifest, desktopExecutableName);
    assert.strictEqual(_test.capabilitiesShareInstallPath(dualState), false, `${toolId} separate WebUI/Desktop roots should not trip the overlap guard.`);

    const companionOnly = _test.buildCompanionOnlyPreservedState(dualState, manifest);
    assert(companionOnly, `${toolId} WebUI uninstall should be able to preserve a companion-only state.`);
    assert.deepStrictEqual(companionOnly.installedCapabilities, { webui: false, desktop: true }, `${toolId} companion-only state should mark only Desktop installed.`);
    assert.deepStrictEqual(modeIds(companionOnly), ['desktop'], `${toolId} companion-only state should expose only Desktop launch mode.`);
    assert.strictEqual(companionOnly.installDir, dualState.desktopCompanion.installDir, `${toolId} companion-only state should point at the official Desktop folder.`);

    const webuiOnly = _test.buildWebuiOnlyPreservedState(dualState, manifest);
    assert.strictEqual(webuiOnly.installedCapabilities.webui, true, `${toolId} WebUI state should preserve WebUI capability.`);
    assert.strictEqual(webuiOnly.installedCapabilities.desktop, false, `${toolId} WebUI state should clear Desktop capability.`);
    assert.deepStrictEqual(modeIds(webuiOnly), ['webui'], `${toolId} WebUI-only state should expose only WebUI launch mode.`);
    assert.strictEqual(webuiOnly.installDir, dualState.installDir, `${toolId} WebUI-only state should keep the managed WebUI folder.`);

    const companionUninstallState = _test.buildDesktopCompanionUninstallState(dualState, manifest);
    assert.strictEqual(companionUninstallState.installDir, dualState.desktopCompanion.installDir, `${toolId} desktop uninstall state should target the official Desktop folder.`);
    assert.notStrictEqual(companionUninstallState.installDir, dualState.installDir, `${toolId} desktop uninstall state must not target the managed WebUI folder.`);
    assert.strictEqual(companionUninstallState.detectedPath, dualState.desktopCompanion.detectedPath, `${toolId} desktop uninstall state should use the detected companion executable as evidence.`);

    const sharedRoot = path.join(TEST_STORAGE_ROOT, 'shared', toolId);
    const sharedState = {
      ...dualState,
      installDir: sharedRoot,
      appDir: path.join(sharedRoot, 'app'),
      desktopCompanion: {
        ...dualState.desktopCompanion,
        installDir: sharedRoot,
        appDir: sharedRoot,
        detectedPath: path.join(sharedRoot, desktopExecutableName),
        executablePath: path.join(sharedRoot, desktopExecutableName),
      },
    };
    assert.strictEqual(_test.capabilitiesShareInstallPath(sharedState), true, `${toolId} shared WebUI/Desktop folder should trip the safety guard.`);
  }

  const installerSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'services', 'installerService.js'), 'utf8');
  assert(installerSource.includes('resolveToolUninstallContext(companionUninstallState, companionManifest'), 'Desktop capability uninstall should resolve official uninstall metadata against the companion state and manifest.');
  assert(installerSource.includes('runWindowsUninstaller(workingUninstallEntry, logger, companionManifest.name)'), 'Desktop capability uninstall should use the existing official Windows uninstaller runner.');
  assert(installerSource.includes('The WebUI folder was left untouched'), 'Unsafe Desktop uninstall fallbacks should clearly say the WebUI was preserved.');
  assert(installerSource.includes('Open Windows Apps & Features'), 'Unsafe Desktop uninstall cases should give the user a Windows Apps path forward.');
  assert(installerSource.includes('Local AI Hub only accepts WebUI or Desktop App as uninstall choices'), 'Capability uninstall should reject arbitrary renderer capability values.');
  assert(!installerSource.includes('Capability-specific desktop uninstall is not automated in this build'), 'Old paused Desktop uninstall message should be removed.');

  const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'App.jsx'), 'utf8');
  assert(appSource.includes('allInstallCapabilitiesInstalled'), 'Store visibility should remain based on all capability install state.');
  assert(appSource.includes('uninstallTool({ toolId: tool.id, capability: capabilityId })'), 'Renderer uninstall requests should pass capability ids only.');

  console.log('Capability-specific uninstall verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});