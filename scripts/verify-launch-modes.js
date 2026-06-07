const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TEST_STORAGE_ROOT = path.join(process.cwd(), 'temp', 'verify-launch-modes');
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
          return '0.39.0-test';
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

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'electron', 'config', 'tools-manifest.json'), 'utf8'));
}

async function main() {
  fs.rmSync(TEST_STORAGE_ROOT, { force: true, recursive: true });

  const manifestTools = readManifest();
  const byId = (toolId) => manifestTools.find((tool) => tool.id === toolId);
  const { buildLaunchModeState, getToolCatalog, getToolManifest, initializeToolRegistry } = require('../electron/services/toolRegistry');
  const { _test: installerTesting } = require('../electron/services/installerService');
  const { __testing } = require('../electron/services/processService');

  await initializeToolRegistry();

  for (const toolId of ['opencode', 'ollama', 'comfyui', 'invokeai', 'koboldcpp', 'tabby']) {
    const rawTool = byId(toolId);
    assert(rawTool, `${toolId} should remain in the manifest.`);
    assert(Array.isArray(rawTool.launchModes), `${toolId} should declare launch modes explicitly.`);
    assert(rawTool.preferredLaunchMode, `${toolId} should declare a preferred launch mode.`);
  }

  for (const toolId of ['automatic1111', 'forge', 'openwebui', 'text-generation-webui', 'wan21-webui', 'audiocraft-webui', 'facefusion', 'triposr', 'rvc']) {
    const rawTool = byId(toolId);
    assert(rawTool, `${toolId} should remain in the manifest.`);
    assert(!(rawTool.launchModes || []).some((mode) => mode.interfaceMode === 'desktop-app'), `${toolId} should not expose a desktop launch mode.`);
  }

  const ollamaManifest = getToolManifest('ollama');
  const ollamaRoot = path.join(TEST_STORAGE_ROOT, 'official', 'Ollama');
  const ollamaState = {
    id: 'ollama',
    name: 'Ollama',
    source: 'external',
    installDir: ollamaRoot,
    appDir: ollamaRoot,
    detectedPath: path.join(ollamaRoot, 'ollama.exe'),
  };
  touch(path.join(ollamaRoot, 'ollama.exe'));
  touch(path.join(ollamaRoot, 'ollama app.exe'));
  const ollamaModes = buildLaunchModeState(ollamaState, ollamaManifest, {
    detectedPath: ollamaState.detectedPath,
    source: 'external',
  });
  assert.deepStrictEqual(modeIds(ollamaModes), ['desktop', 'service'], 'Ollama should expose service and desktop modes when the official app executable is available.');
  assert.strictEqual(ollamaModes.launchModeProfiles.service.executable, path.join(ollamaRoot, 'ollama.exe'), 'Ollama service mode should keep using ollama.exe.');
  assert.strictEqual(ollamaModes.launchModeProfiles.desktop.executable, path.join(ollamaRoot, 'ollama app.exe'), 'Ollama desktop mode should launch the official app executable, not the CLI/service binary.');

  for (const toolId of ['opencode', 'gpt4all', 'jan', 'upscayl', 'lmstudio', 'anythingllm']) {
    const manifest = getToolManifest(toolId);
    assert.strictEqual(manifest.interfaceMode, 'desktop-app', `${toolId} should preserve desktop-app behavior.`);
    assert.deepStrictEqual(manifest.launchModes.map((mode) => mode.id), ['desktop'], `${toolId} should normalize to one desktop launch mode.`);
  }

  const opencodeRaw = byId('opencode');
  assert(opencodeRaw, 'OpenCode should appear in the Store manifest.');
  assert.strictEqual(opencodeRaw.category, 'Coding tools', 'OpenCode should be categorized with coding agents.');
  assert(
    opencodeRaw.description.includes('Configure providers inside OpenCode'),
    'OpenCode Store copy should tell users provider configuration stays inside OpenCode.',
  );
  assert(
    opencodeRaw.description.includes('IDE extension integration is not managed'),
    'OpenCode Store copy should make IDE extension integration out of scope.',
  );
  assert.strictEqual(opencodeRaw.downloadUrl, 'https://github.com/anomalyco/opencode/releases/latest/download/opencode-desktop-win-x64.exe', 'OpenCode should use the official GitHub desktop release asset.');
  assert.strictEqual(opencodeRaw.installInstructions?.managedInstallSupported, false, 'OpenCode Desktop should use the guided official installer flow.');
  assert.deepStrictEqual((opencodeRaw.launchModes || []).map((mode) => mode.id), ['desktop'], 'OpenCode should expose only Desktop App in this pass.');
  assert(!(opencodeRaw.launchModes || []).some((mode) => mode.id === 'cli'), 'OpenCode CLI/TUI should not be shown until a bounded terminal launcher is implemented.');
  assert(
    opencodeRaw.detectionPaths?.includes('%LOCALAPPDATA%\\Programs\\@opencode-aidesktop\\OpenCode.exe'),
    'OpenCode should detect the actual official Windows installer folder used by the desktop app.',
  );
  assert(opencodeRaw.discovery?.folderNames?.includes('@opencode-aidesktop'), 'OpenCode common-root discovery should include the official scoped app folder.');
  assert.strictEqual(opencodeRaw.discovery?.pathExecutables?.length, 0, 'OpenCode should not use PATH or arbitrary executable scanning for Desktop detection.');

  const opencodeManifest = getToolManifest('opencode');
  assert.strictEqual(opencodeManifest.installContract.destinationControl, 'guided', 'OpenCode Desktop should let the official installer decide the final app location.');
  const opencodeRoot = path.join(TEST_STORAGE_ROOT, 'official', 'OpenCode');
  const opencodeState = {
    id: 'opencode',
    name: 'OpenCode',
    source: 'external',
    installDir: opencodeRoot,
    appDir: opencodeRoot,
    detectedPath: path.join(opencodeRoot, 'OpenCode.exe'),
  };
  touch(path.join(opencodeRoot, 'OpenCode.exe'));
  const opencodeModes = buildLaunchModeState(opencodeState, opencodeManifest, {
    detectedPath: opencodeState.detectedPath,
    source: 'external',
  });
  assert.deepStrictEqual(modeIds(opencodeModes), ['desktop'], 'OpenCode should expose Desktop App when OpenCode.exe is detected.');
  assert.strictEqual(opencodeModes.launchModeProfiles.desktop.executable, path.join(opencodeRoot, 'OpenCode.exe'), 'OpenCode Desktop launch should resolve from the detected official executable.');
  assert.strictEqual(opencodeModes.launchModeProfiles.desktop.allowExternalExecutable, true, 'OpenCode Desktop launch should allow only the manifest-approved detected external executable.');
  assert.throws(
    () => __testing.selectLaunchMode({ ...opencodeState, ...opencodeModes }, 'cli'),
    /does not expose that launch mode/,
    'OpenCode should reject CLI launch mode requests while CLI/TUI is future work.',
  );
  const officialOpenCodeRoot = path.join(process.env.LOCALAPPDATA, 'Programs', '@opencode-aidesktop');
  const officialOpenCodeExe = path.join(officialOpenCodeRoot, 'OpenCode.exe');
  touch(officialOpenCodeExe);
  const officialOpenCodeModes = buildLaunchModeState(
    {
      ...opencodeState,
      installDir: officialOpenCodeRoot,
      appDir: officialOpenCodeRoot,
      detectedPath: officialOpenCodeExe,
    },
    opencodeManifest,
    {
      detectedPath: officialOpenCodeExe,
      source: 'external',
    },
  );
  assert.strictEqual(officialOpenCodeModes.launchModeProfiles.desktop.executable, officialOpenCodeExe, 'OpenCode should approve the official scoped desktop app path outside Local AI Hub tools.');
  assert.strictEqual(installerTesting.isGuidedOfficialInstallerManifest(opencodeManifest), true, 'OpenCode updates should use guided official desktop installer rules.');
  assert.throws(
    () => installerTesting.ensureManagedToolStatePaths({
      id: 'opencode',
      source: 'managed',
      installDir: officialOpenCodeRoot,
      appDir: officialOpenCodeRoot,
    }),
    /outside its tools folder/,
    'Managed-folder validation should still reject arbitrary external OpenCode paths.',
  );
  assert(
    installerTesting.buildUnverifiedExternalUpdateMessage(opencodeManifest, '9.9.9').includes('detected the official app afterward'),
    'Guided official updater version gaps should be reported as a nonfatal detection warning.',
  );
  assert.strictEqual(
    installerTesting.officialDesktopUpdateStateIsApproved(opencodeManifest, {
      source: 'external',
      installDir: officialOpenCodeRoot,
      appDir: officialOpenCodeRoot,
      detectedPath: officialOpenCodeExe,
      launchProfile: { kind: 'binary', executable: officialOpenCodeExe },
    }),
    true,
    'OpenCode official update verification should approve the manifest-listed desktop executable outside Local AI Hub tools.',
  );
  const arbitraryOpenCodeRoot = path.join(TEST_STORAGE_ROOT, 'arbitrary', 'OpenCode');
  const arbitraryOpenCodeExe = path.join(arbitraryOpenCodeRoot, 'OpenCode.exe');
  touch(arbitraryOpenCodeExe);
  assert.strictEqual(
    installerTesting.officialDesktopUpdateStateIsApproved(opencodeManifest, {
      source: 'external',
      installDir: arbitraryOpenCodeRoot,
      appDir: arbitraryOpenCodeRoot,
      detectedPath: arbitraryOpenCodeExe,
      launchProfile: { kind: 'binary', executable: arbitraryOpenCodeExe },
    }),
    false,
    'OpenCode official update verification should reject arbitrary external executables.',
  );
  assert.strictEqual(
    installerTesting.officialDesktopUpdateStateIsApproved(opencodeManifest, {
      source: 'external',
      installDir: arbitraryOpenCodeRoot,
      appDir: arbitraryOpenCodeRoot,
      detectedPath: arbitraryOpenCodeExe,
      launchProfile: { kind: 'binary', executable: arbitraryOpenCodeExe },
      windowsUninstallDetected: true,
    }),
    true,
    'OpenCode official update verification should approve Windows uninstall metadata detections even when the app is outside tools.',
  );
  const fakeOfficialUpdateLogger = { info: async () => {}, warn: async () => {} };
  let delayedOfficialDetectionAttempts = 0;
  const delayedOfficialDetection = await installerTesting.detectOfficialDesktopUpdateToolState(
    opencodeManifest,
    path.join(TEST_STORAGE_ROOT, 'downloads', 'opencode-desktop-win-x64.exe'),
    fakeOfficialUpdateLogger,
    {
      timeoutMs: 100,
      pollMs: 1,
      sleep: async () => {},
      discoverTools: async () => {
        delayedOfficialDetectionAttempts += 1;
        if (delayedOfficialDetectionAttempts < 3) return {};
        return {
          opencode: {
            source: 'external',
            installDir: officialOpenCodeRoot,
            appDir: officialOpenCodeRoot,
            detectedPath: officialOpenCodeExe,
            displayPath: officialOpenCodeExe,
            launchProfile: { kind: 'binary', executable: officialOpenCodeExe },
            launchSupported: true,
          },
        };
      },
    },
  );
  assert(delayedOfficialDetection, 'Official desktop update detection should poll briefly for delayed post-update discovery.');
  assert.strictEqual(delayedOfficialDetection.detectedPath, officialOpenCodeExe, 'Delayed official detection should refresh stale pre-update state without an app relaunch.');
  assert(delayedOfficialDetectionAttempts >= 3, 'Official desktop update detection should retry before reporting failure.');
  const missingOfficialDetection = await installerTesting.detectOfficialDesktopUpdateToolState(
    opencodeManifest,
    path.join(TEST_STORAGE_ROOT, 'downloads', 'missing-opencode.exe'),
    fakeOfficialUpdateLogger,
    { timeoutMs: 0, pollMs: 0, sleep: async () => {}, discoverTools: async () => ({}) },
  );
  assert.strictEqual(missingOfficialDetection, null, 'Official desktop update detection should stop after bounded retries.');
  assert(
    installerTesting.buildOfficialDesktopUpdateVerificationLagMessage(opencodeManifest).includes('could not verify the updated desktop app yet'),
    'Official desktop update failures should use the verification-lag message, not the managed tools folder guard.',
  );
  const opencodeUpdateInstallerSource = fs.readFileSync(path.join(process.cwd(), 'electron/services/installerService.js'), 'utf8');
  assert(opencodeUpdateInstallerSource.includes('usesGuidedOfficialInstaller && !isManagedInstall'), 'OpenCode guided updates should bypass managed-install validation.');
  assert(opencodeUpdateInstallerSource.includes('useOfficialDesktopDetection'), 'Post-update guided official apps should use official desktop detection before managed install validation.');
  assert(opencodeUpdateInstallerSource.includes('buildOfficialDesktopUpdateVerificationLagMessage'), 'Post-update guided official detection lag should not surface managed-folder guard errors.');
  assert(opencodeUpdateInstallerSource.includes('const discoveredTools = await syncDiscoveredTools({ force: true });'), 'Guided official updates should refresh Library detection after installer completion.');
  assert(opencodeUpdateInstallerSource.includes('lastError: null'), 'Successful guided official updates should clear stale update errors.');
  const opencodeDiscoverySource = fs.readFileSync(path.join(process.cwd(), 'electron/services/toolDiscoveryService.js'), 'utf8');
  assert(opencodeDiscoverySource.includes("discoverOfficialInstallerFromWindowsUninstall(manifest, logger)"), 'OpenCode official desktop detection should consult verified Windows uninstall metadata.');
  assert(opencodeDiscoverySource.includes("!['manifest-path', 'windows-uninstall'].includes(detected.reason)"), 'Guided official desktop detection should reject arbitrary external executable locations.');

  const comfyRaw = byId('comfyui');
  const comfyRequirementsInstall = comfyRaw.installInstructions?.pipInstalls?.find((entry) => entry.kind === 'requirements' && entry.value === 'requirements.txt');
  assert(comfyRequirementsInstall?.excludePatterns?.includes('^torch\\b'), 'ComfyUI repair/install should not let upstream requirements pull a CPU-only torch wheel.');
  assert(comfyRequirementsInstall?.excludePatterns?.includes('^torchvision\\b'), 'ComfyUI repair/install should leave torchvision selection to the managed CUDA PyTorch step.');
  assert(comfyRequirementsInstall?.excludePatterns?.includes('^torchaudio\\b'), 'ComfyUI repair/install should leave torchaudio selection to the managed CUDA PyTorch step.');

  const tabbyRaw = byId('tabby');
  assert.deepStrictEqual((tabbyRaw.launchModes || []).map((mode) => mode.id), ['service'], 'Tabby should stay service/Web/API only until a desktop launcher is explicitly audited.');

  const comfyManifest = getToolManifest('comfyui');
  assert(comfyManifest.companionDesktop, 'ComfyUI should declare an official companion desktop installer.');
  assert.strictEqual(comfyManifest.companionDesktop.installContract.destinationControl, 'guided', 'ComfyUI Desktop should use the guided official installer flow.');
  const comfyRoot = path.join(TEST_STORAGE_ROOT, 'tools', 'comfyui');
  const comfyState = {
    id: 'comfyui',
    name: 'ComfyUI',
    source: 'managed',
    managedByLocalAIHub: true,
    installDir: comfyRoot,
    appDir: path.join(comfyRoot, 'app'),
    venvDir: path.join(comfyRoot, '.venv'),
  };
  touch(path.join(comfyState.appDir, 'main.py'));
  touch(path.join(comfyState.venvDir, 'Scripts', 'python.exe'));

  const comfyWebOnly = buildLaunchModeState(comfyState, comfyManifest, { source: 'managed' });
  assert.deepStrictEqual(modeIds(comfyWebOnly), ['webui'], 'ComfyUI should not expose Desktop App when ComfyUI.exe is missing.');
  assert.throws(
    () => __testing.selectLaunchMode({ ...comfyState, ...comfyWebOnly, launchModes: comfyWebOnly.launchModes }, 'desktop'),
    /Desktop app is not installed for this tool\. Use Web UI or install the Desktop App from Store\./,
    'Missing desktop modes should fail with the required plain-English message.',
  );

  const comfyDesktopRoot = path.join(TEST_STORAGE_ROOT, 'official', 'ComfyUI Desktop');
  touch(path.join(comfyDesktopRoot, 'ComfyUI.exe'));
  const comfyDual = buildLaunchModeState(
    {
      ...comfyState,
      desktopCompanion: {
        installed: true,
        installDir: comfyDesktopRoot,
        appDir: comfyDesktopRoot,
        detectedPath: path.join(comfyDesktopRoot, 'ComfyUI.exe'),
      },
      installedCapabilities: {
        webui: true,
        desktop: true,
      },
    },
    comfyManifest,
    { source: 'managed' },
  );
  assert.deepStrictEqual(modeIds(comfyDual), ['desktop', 'webui'], 'ComfyUI should expose Web UI and Desktop App when both launchers are present.');
  assert.strictEqual(comfyDual.preferredLaunchMode, 'webui', 'ComfyUI should prefer Web UI.');
  assert.strictEqual(comfyDual.launchModeProfiles.desktop.executable, path.join(comfyDesktopRoot, 'ComfyUI.exe'), 'ComfyUI Desktop mode should resolve through companion metadata.');
  assert.strictEqual(comfyDual.launchModeProfiles.desktop.allowExternalWorkingDir, true, 'ComfyUI Desktop companion launch should allow its official external app folder as the working directory.');
  assert.strictEqual(comfyDual.launchModeProfiles.desktop.allowExternalExecutable, true, 'ComfyUI Desktop companion launch should allow its manifest-approved external launcher executable.');

  const comfyDesktopOnly = buildLaunchModeState(
    {
      id: 'comfyui',
      name: 'ComfyUI',
      source: 'external',
      companionOnly: true,
      installDir: comfyDesktopRoot,
      appDir: comfyDesktopRoot,
      detectedPath: path.join(comfyDesktopRoot, 'ComfyUI.exe'),
      desktopCompanion: {
        installed: true,
        installDir: comfyDesktopRoot,
        appDir: comfyDesktopRoot,
        detectedPath: path.join(comfyDesktopRoot, 'ComfyUI.exe'),
      },
      installedCapabilities: {
        webui: false,
        desktop: true,
      },
    },
    comfyManifest,
    { source: 'external', detectedPath: path.join(comfyDesktopRoot, 'ComfyUI.exe') },
  );
  assert.deepStrictEqual(modeIds(comfyDesktopOnly), ['desktop'], 'ComfyUI companion-only installs should expose only Desktop App.');

  const invokeManifest = getToolManifest('invokeai');
  assert(invokeManifest.companionDesktop, 'InvokeAI should declare an official companion desktop installer.');
  assert.strictEqual(invokeManifest.companionDesktop.installContract.destinationControl, 'guided', 'InvokeAI Launcher should use the guided official installer flow.');
  const invokeRoot = path.join(TEST_STORAGE_ROOT, 'tools', 'invokeai');
  const invokeState = {
    id: 'invokeai',
    name: 'InvokeAI',
    source: 'managed',
    managedByLocalAIHub: true,
    installDir: invokeRoot,
    appDir: path.join(invokeRoot, 'app'),
    venvDir: path.join(invokeRoot, '.venv'),
  };
  touch(path.join(invokeState.venvDir, 'Scripts', 'python.exe'));
  touch(path.join(invokeState.venvDir, 'Scripts', 'invokeai-web.exe'));

  const invokeWebOnly = buildLaunchModeState(invokeState, invokeManifest, { source: 'managed' });
  assert.deepStrictEqual(modeIds(invokeWebOnly), ['webui'], 'InvokeAI should not expose Desktop App when the official desktop executable is missing.');
  assert.throws(
    () => __testing.selectLaunchMode({ ...invokeState, ...invokeWebOnly, launchModes: invokeWebOnly.launchModes }, 'desktop'),
    /Desktop app is not installed for this tool\. Use Web UI or install the Desktop App from Store\./,
    'Missing InvokeAI desktop mode should fail with the required plain-English message.',
  );

  const invokeDesktopRoot = path.join(TEST_STORAGE_ROOT, 'official', 'InvokeAI Launcher');
  touch(path.join(invokeDesktopRoot, 'Invoke Community Edition.exe'));
  const invokeDual = buildLaunchModeState(
    {
      ...invokeState,
      desktopCompanion: {
        installed: true,
        installDir: invokeDesktopRoot,
        appDir: invokeDesktopRoot,
        detectedPath: path.join(invokeDesktopRoot, 'Invoke Community Edition.exe'),
      },
      installedCapabilities: {
        webui: true,
        desktop: true,
      },
    },
    invokeManifest,
    { source: 'managed' },
  );
  assert.deepStrictEqual(modeIds(invokeDual), ['desktop', 'webui'], 'InvokeAI should expose Desktop App only when a manifest-backed desktop executable is present.');
  assert.strictEqual(invokeDual.preferredLaunchMode, 'webui', 'InvokeAI should keep Web UI as the preferred mode.');
  assert.strictEqual(invokeDual.launchModeProfiles.desktop.executable, path.join(invokeDesktopRoot, 'Invoke Community Edition.exe'), 'InvokeAI desktop mode should resolve through companion metadata.');
  assert.strictEqual(invokeDual.launchModeProfiles.desktop.allowExternalWorkingDir, true, 'InvokeAI Launcher companion launch should allow its official external app folder as the working directory.');
  assert.strictEqual(invokeDual.launchModeProfiles.desktop.allowExternalExecutable, true, 'InvokeAI Launcher companion launch should allow its manifest-approved external launcher executable.');
  assert.strictEqual(
    __testing.resolveLaunchProfile({ ...invokeState, ...invokeDual }, invokeDual.launchModeProfiles.desktop).executable,
    path.join(invokeDesktopRoot, 'Invoke Community Edition.exe'),
    'Approved InvokeAI companion launchers outside the managed WebUI folder should pass the launcher executable guard.',
  );
  assert.throws(
    () => __testing.resolveLaunchProfile(
      { ...invokeState, ...invokeDual },
      {
        kind: 'binary',
        executable: path.join(TEST_STORAGE_ROOT, 'arbitrary', 'Invoke Community Edition.exe'),
        workingDir: invokeDesktopRoot,
        allowExternalWorkingDir: true,
      },
    ),
    /refused to use a launcher executable outside the managed tool folder/,
    'Arbitrary external executables should still be rejected for managed tools.',
  );

  const catalog = getToolCatalog();
  for (const toolId of ['comfyui', 'invokeai']) {
    const catalogTool = catalog.find((tool) => tool.id === toolId);
    assert.deepStrictEqual((catalogTool.installCapabilities || []).map((capability) => capability.id), ['webui', 'desktop'], `${toolId} should expose WebUI and Desktop App Store install capabilities.`);
  }

  const koboldManifest = getToolManifest('koboldcpp');
  const koboldRoot = path.join(TEST_STORAGE_ROOT, 'tools', 'koboldcpp');
  const koboldState = {
    id: 'koboldcpp',
    name: 'KoboldCpp',
    source: 'managed',
    managedByLocalAIHub: true,
    installDir: koboldRoot,
    appDir: path.join(koboldRoot, 'app'),
  };
  touch(path.join(koboldState.appDir, 'koboldcpp.exe'));
  const koboldModes = buildLaunchModeState(koboldState, koboldManifest, { source: 'managed' });
  assert.deepStrictEqual(modeIds(koboldModes), ['desktop', 'webui'], 'KoboldCpp should expose server/WebUI and native executable modes.');
  assert.strictEqual(__testing.selectLaunchMode({ ...koboldState, ...koboldModes }, 'desktop').toolState.interfaceMode, 'desktop-app', 'KoboldCpp desktop mode should apply desktop interface behavior.');
  assert.throws(
    () => __testing.selectLaunchMode({ ...koboldState, ...koboldModes }, 'C:\\Windows\\notepad.exe'),
    /does not expose that launch mode/,
    'Renderer requests should be limited to manifest launch mode ids, not arbitrary commands or paths.',
  );

  const tabbyManifest = getToolManifest('tabby');
  const tabbyRoot = path.join(TEST_STORAGE_ROOT, 'tools', 'tabby');
  const tabbyState = {
    id: 'tabby',
    name: 'Tabby',
    source: 'managed',
    managedByLocalAIHub: true,
    installDir: tabbyRoot,
    appDir: path.join(tabbyRoot, 'app'),
  };
  touch(path.join(tabbyState.appDir, 'tabby.exe'));
  const tabbyModes = buildLaunchModeState(tabbyState, tabbyManifest, { source: 'managed' });
  assert.deepStrictEqual(modeIds(tabbyModes), ['service'], 'Tabby should expose only its declared service mode.');

  const libraryCardSource = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'LibraryCard.jsx'), 'utf8');
  assert(libraryCardSource.includes('availableLaunchModes'), 'Library cards should filter launch mode choices to available manifest-backed modes.');
  assert(libraryCardSource.includes('launchModeActionLabel'), 'Library cards should render clear launch mode labels.');
  assert(libraryCardSource.includes("return 'Launch WebUI';"), 'WebUI-only Library cards should label the single launch action as Launch WebUI.');
  assert(libraryCardSource.includes("return 'Launch Desktop App';"), 'Desktop-only Library cards should label the single launch action as Launch Desktop App.');
  assert(libraryCardSource.includes("return 'Launch Service';"), 'Service-only Library cards should label the single launch action as Launch Service.');
  assert(libraryCardSource.includes('singleLaunchActionLabel(tool, preferredMode)'), 'Single-mode Library cards should use specific launch labels instead of generic Launch.');
  assert(libraryCardSource.includes('Pipeline Builder'), 'Pipeline-only Library cards should keep their existing Pipeline Builder action.');
  assert(libraryCardSource.includes("onLaunch(tool.id, { launchMode: mode.id })"), 'Library mode actions should pass only the mode id.');

  const installerSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'services', 'installerService.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'App.jsx'), 'utf8');
  assert(appSource.includes('allInstallCapabilitiesInstalled'), 'Store visibility should account for partial WebUI/Desktop capability installs.');
  assert(appSource.includes("capability === 'default'"), 'Single-identity tools such as Ollama should count as installed when they already exist in Library.');
  assert(appSource.includes('capability: capabilityId'), 'Store install requests should pass only a capability id, not executable paths.');
  assert(!appSource.includes('Capability-specific uninstall is paused'), 'Dual-capability uninstall should no longer be paused in the renderer.');
  assert(installerSource.includes('uninstallDualWebuiCapability'), 'Dual-capability WebUI uninstall should use a guarded capability-specific service path.');
  assert(installerSource.includes('uninstallDualDesktopCapability'), 'Dual-capability Desktop App uninstall should use a guarded official-uninstaller service path.');
  assert(appSource.includes('repairLibraryTool(tool, capability'), 'Library repair actions should be capability-aware.');
  assert(appSource.includes('uninstallTool({ toolId: tool.id, capability: capabilityId })'), 'Library uninstall requests should pass capability ids instead of raw paths.');

  const storeCardSource = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'StoreCard.jsx'), 'utf8');
  assert(storeCardSource.includes('capabilityInstalled'), 'Store cards should render installed/available state per install capability.');
  assert(storeCardSource.includes("onInstall(manifest.id, capability.id)"), 'Store cards should request companion installs by capability id only.');
  assert(storeCardSource.includes('Install Desktop App'), 'Desktop official installer Store buttons should say Install Desktop App.');
  assert(!storeCardSource.includes('Official Install'), 'Store cards should not show the old Official Install button wording.');

  const libraryCardSourceAgain = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'LibraryCard.jsx'), 'utf8');
  assert(libraryCardSourceAgain.includes('Repair WebUI'), 'Dual-capability Library cards should label WebUI repair explicitly.');
  assert(libraryCardSourceAgain.includes('Repair Desktop App'), 'Dual-capability Library cards should label Desktop App repair explicitly.');
  assert(libraryCardSourceAgain.includes('Uninstall WebUI'), 'Dual-capability Library cards should label WebUI uninstall explicitly.');
  assert(libraryCardSourceAgain.includes('Uninstall Desktop App'), 'Dual-capability Library cards should label Desktop App uninstall explicitly.');

  assert(installerSource.includes('ensureManagedCudaPyTorch'), 'ComfyUI install/repair should install and verify a managed CUDA PyTorch build before pip check.');
  assert(installerSource.includes("MANAGED_CUDA_PYTORCH_INSTALL_TOOL_IDS = new Set(['comfyui'])"), 'Managed CUDA PyTorch install should stay scoped to ComfyUI in this pass.');
  assert(installerSource.includes('persistCompanionDesktopDetection'), 'Companion desktop installs should be marked installed only after a detection pass.');
  assert(installerSource.includes('was not detected. Use Install Desktop App'), 'Failed companion detection should clear guided installer progress instead of leaving 72% pending.');
  assert(installerSource.includes("capability === 'desktop' && manifest.companionDesktop"), 'Desktop companion repair should re-detect or rerun the official installer by capability.');

  const discoverySource = fs.readFileSync(path.join(process.cwd(), 'electron', 'services', 'toolDiscoveryService.js'), 'utf8');
  assert(discoverySource.includes('discoverFromManifestPaths(companion'), 'Companion desktop detection should start from explicit manifest known paths.');
  assert(discoverySource.includes('!previous?.installedByLocalAIHub'), 'Stale companion desktop paths should not be trusted unless Local AI Hub launched the official installer.');
  assert(discoverySource.includes('discoverCompanionFromWindowsUninstall'), 'Companion desktop detection should use verified Windows uninstall metadata when the installer chose an official app location.');

  console.log('Launch mode architecture verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
