const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  MAX_LOG_FILE_BYTES,
  MAX_LOG_TOTAL_BYTES,
  buildSystemInfoText,
  collectSupportData,
  copySanitizedLogs,
  createDiagnosticsBundle,
} = require('../electron/services/diagnosticsService');
const { redactSensitiveText } = require('../electron/services/redactionService');

const SECRETS = [
  'sk-testdiagnosticsecret1234567890',
  'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II',
  'gsk_diagnosticSecret123456789012345',
  'xai-diagnosticSecret123456789012345',
];
const USER_PATH = 'C:\\Users\\Matthew\\Private Project\\source-video.mp4';

function fakeDependencies(paths) {
  return {
    ensureStorage: async () => paths,
    readConfig: async () => ({
      closeBehavior: 'tray',
      screenMode: 'fullscreen',
      firstLaunchCompleted: true,
      liveResourcePolling: false,
      managedDataRoot: paths.managedRoot,
      moveDeletedPipelineOutputsToRecycleBin: true,
      preferredInstallRoot: null,
      providerKey: SECRETS[0],
    }),
    osInfo: async () => ({ platform: 'Windows', distro: 'Microsoft Windows 11 Pro', release: '11', build: '26100', arch: 'x64' }),
    cpu: async () => ({ manufacturer: 'Test', brand: 'CPU', cores: 8 }),
    mem: async () => ({ total: 16 * 1024 * 1024 * 1024 }),
    detectHardwareSnapshot: async () => ({ gpuModel: 'Test GPU', gpuVendor: 'Test Vendor', systemRamMb: 16384, vramMb: 6144 }),
    getLiveResourceUsage: async () => ({ gpuName: 'Test GPU', ramTotalMb: 16384, vramTotalMb: 6144, vramUsedMb: 1024, diskFreeBytes: 90 * 1024 * 1024 * 1024, diskMount: 'D:\\' }),
    detectStorageSnapshot: async () => [
      { mount: 'C:\\', freeBytes: 50 * 1024 * 1024 * 1024, sizeBytes: 200 * 1024 * 1024 * 1024 },
      { mount: 'D:\\', freeBytes: 90 * 1024 * 1024 * 1024, sizeBytes: 500 * 1024 * 1024 * 1024 },
    ],
    listTools: async () => [
      { id: 'comfyui', name: 'ComfyUI', installDir: path.join(paths.toolsRoot, 'comfyui'), status: 'stopped', modelManager: { enabled: true } },
      { id: 'broken', name: 'Broken Tool', installDir: path.join(paths.toolsRoot, 'broken'), status: 'error', lastError: `Authorization: Bearer ${SECRETS[0]} at ${USER_PATH}`, actionSemantics: { repairAvailable: true } },
    ],
    listProviders: async () => [
      { id: 'openai', name: 'OpenAI', isConnected: true, libraryStatus: 'connected', apiKey: SECRETS[0], maskedKey: SECRETS[0] },
      { id: 'google', name: 'Google', isConnected: false, libraryStatus: 'disconnected' },
    ],
    listRecordings: async () => [{
      id: 'recording-20260613120000-abcd1234', backend: 'ffmpeg', mode: 'screen', status: 'failed', durationSeconds: 2,
      container: 'mkv', outputPath: USER_PATH, fileName: 'private-client-demo.mkv', errorSummary: `Failed near ${USER_PATH}`,
    }],
    listPipelineOutputs: async () => [{
      runId: 'run-safe-1', kind: 'video', outputKind: 'video', savedAt: '2026-06-13T12:00:00.000Z',
      outputPath: path.join(paths.runtimesRoot, 'pipeline-runs', 'run-safe-1', 'outputs', 'private-output.mp4'),
      outputLabel: 'private-output.mp4',
    }],
    readModelSettings: async () => ({ hasCivitaiApiKey: true, civitaiApiKey: SECRETS[2] }),
    listDownloadedModels: async () => [
      { toolId: 'comfyui', modelType: 'Checkpoint', fileName: 'private-model.safetensors', path: path.join(paths.modelsRoot, 'private-model.safetensors'), scanWarnings: ['Model scan skipped a symlink or junction inside the model folder.'] },
    ],
    getModelManagerCacheSummary: () => ({
      inventoryCache: { enabled: true, ttlMs: 15000, maxEntries: 128, entryCount: 1 },
      providerCatalogCache: { enabled: true, ttlMs: 600000, maxEntries: 200, detailMaxEntries: 400, entryCounts: {} },
    }),
    getRecentSupportEvents: () => [],
    getFfmpegSummary: async () => ({ available: true, version: 'ffmpeg version 7.1-test' }),
  };
}

async function listFiles(root) {
  const results = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else results.push(target);
    }
  }
  await walk(root);
  return results;
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-hub-diagnostics-'));
  const paths = {
    configRoot: path.join(tempRoot, 'config'),
    localRoot: path.join(tempRoot, 'local'),
    managedRoot: path.join(tempRoot, 'managed'),
    logsRoot: path.join(tempRoot, 'managed', 'logs'),
    toolsRoot: path.join(tempRoot, 'managed', 'tools'),
    modelsRoot: path.join(tempRoot, 'managed', 'models'),
    recordingsRoot: path.join(tempRoot, 'managed', 'recordings'),
    runtimesRoot: path.join(tempRoot, 'managed', 'runtimes'),
    appInstallDir: path.join(tempRoot, 'app'),
  };
  await Promise.all(Object.values(paths).map((target) => fs.ensureDir(target)));
  const hugeLog = [
    `Authorization: Bearer ${SECRETS[0]}`,
    `token=${SECRETS[1]}`,
    `api_key=${SECRETS[2]}`,
    `prompt: private client prompt body`,
    `sourcePath=${USER_PATH}`,
    'fileName=private-client-demo.mkv',
    'x'.repeat(MAX_LOG_FILE_BYTES * 2),
  ].join('\n');
  await fs.writeFile(path.join(paths.logsRoot, 'renderer-2026-06-13.log'), hugeLog, 'utf8');
  await fs.writeFile(path.join(paths.logsRoot, 'do-not-copy.mp4'), 'source media', 'utf8');
  await fs.writeFile(path.join(paths.modelsRoot, 'private-model.safetensors'), 'model', 'utf8');
  await fs.writeFile(path.join(paths.recordingsRoot, 'private-recording.mkv'), 'media', 'utf8');
  await fs.ensureDir(path.join(paths.runtimesRoot, 'pipeline-runs', 'run-safe-1', 'outputs'));
  await fs.writeFile(path.join(paths.runtimesRoot, 'pipeline-runs', 'run-safe-1', 'outputs', 'private-output.mp4'), 'generated', 'utf8');

  const deps = fakeDependencies(paths);
  const data = await collectSupportData({
    activePipelineRun: {
      runId: 'run-active', status: 'failed', startedAt: '2026-06-13T11:00:00.000Z', finishedAt: '2026-06-13T11:01:00.000Z',
      message: `Pipeline failed with ${SECRETS[0]} while reading ${USER_PATH}`,
      nodeStates: { one: { type: 'image-generate', status: 'failed', message: 'private prompt body' } },
    },
    appVersion: '0.49.0',
    versions: { electron: '30.5.1', node: '20.19.0', chrome: '124.0.0.0' },
  }, deps);
  const systemInfo = buildSystemInfoText(data);
  assert.strictEqual(data.configSummary.screenMode, 'fullscreen', 'Diagnostics should include the saved screen mode.');
  assert(systemInfo.includes('App version: 0.49.0'), 'System info should include the app version.');
  assert(systemInfo.includes('OS: Microsoft Windows 11 Pro'), 'System info should include the OS summary.');
  assert(systemInfo.includes('CPU: Test CPU'), 'System info should include the CPU summary.');
  assert(systemInfo.includes('RAM total:'), 'System info should include RAM.');
  assert(systemInfo.includes('GPU: Test GPU'), 'System info should include GPU.');
  assert(systemInfo.includes('Managed root: <managed-root>'), 'System info should use a redacted managed-root placeholder.');
  for (const secret of SECRETS) assert(!systemInfo.includes(secret), 'System info must not include provider keys or tokens.');
  assert(!systemInfo.includes('C:\\Users\\Matthew'), 'System info must redact user-home paths.');

  const diagnosticsRoot = path.join(tempRoot, 'diagnostics-output');
  const result = await createDiagnosticsBundle({
    activePipelineRun: {
      runId: 'run-active', status: 'failed', message: `Authorization: Bearer ${SECRETS[0]} at ${USER_PATH}`,
      nodeStates: { one: { type: 'video-output', status: 'failed', prompt: 'private prompt body' } },
    },
    appVersion: '0.49.0',
    versions: { electron: '30.5.1', node: '20.19.0', chrome: '124.0.0.0' },
  }, { ...deps, diagnosticsRoot });
  assert(result.bundlePath.startsWith(diagnosticsRoot + path.sep), 'Bundle must be created under the diagnostics root.');
  const expected = [
    'README.txt', 'system-info.txt', 'app-summary.json', 'tools-summary.json', 'providers-summary.json',
    'model-manager-health.json', 'recorder-summary.json', 'pipeline-runs-summary.json', 'config-summary.json', 'logs',
  ];
  for (const entry of expected) assert(await fs.pathExists(path.join(result.bundlePath, entry)), `Bundle should include ${entry}.`);

  const files = await listFiles(result.bundlePath);
  const relativeFiles = files.map((file) => path.relative(result.bundlePath, file).replace(/\\/g, '/'));
  assert(!relativeFiles.some((file) => /\.(?:png|jpe?g|gif|webp|mp4|mkv|wav|safetensors|ckpt|pt|pth|gguf)$/i.test(file)), 'Bundle must not include media or model files.');
  assert(!relativeFiles.some((file) => file.includes('outputs/')), 'Bundle must not copy generated pipeline outputs.');

  const textFiles = files.filter((file) => !file.toLowerCase().endsWith('.zip'));
  const combined = (await Promise.all(textFiles.map((file) => fs.readFile(file, 'utf8')))).join('\n');
  for (const secret of SECRETS) assert(!combined.includes(secret), 'Bundle must redact API keys, PATs, and provider tokens.');
  assert(!/Authorization:\s*Bearer\s+[A-Za-z0-9]/i.test(combined), 'Bundle must redact Authorization headers.');
  assert(!combined.includes('C:\\Users\\Matthew'), 'Bundle must redact absolute user paths.');
  assert(!combined.includes('private client prompt body'), 'Bundle logs must omit prompt contents.');
  assert(!combined.includes('private-output.mp4'), 'Bundle must omit generated output file names.');
  assert(!combined.includes('private-client-demo.mkv'), 'Bundle must omit recorder media file names.');
  assert(!combined.includes('private-model.safetensors'), 'Bundle must omit model file names from Model Manager health.');

  const logFiles = files.filter((file) => path.dirname(file).endsWith(`${path.sep}logs`) && file.toLowerCase().endsWith('.log'));
  const includedLogBytes = (await Promise.all(logFiles.map((file) => fs.stat(file)))).reduce((total, stat) => total + stat.size, 0);
  assert(includedLogBytes <= MAX_LOG_TOTAL_BYTES + 4096, 'Included logs must stay under the total cap.');
  assert(logFiles.every((file) => fs.statSync(file).size <= MAX_LOG_FILE_BYTES + 4096), 'Each included log must stay near the per-file cap.');

  const missingLogReport = await copySanitizedLogs(path.join(tempRoot, 'missing-logs'), path.join(tempRoot, 'missing-log-output'), paths);
  assert.deepStrictEqual(missingLogReport.included, [], 'Missing logs should not fail diagnostics creation.');

  const directRedaction = redactSensitiveText(`Authorization: Bearer ${SECRETS[0]} ${SECRETS[1]} ${USER_PATH}`, {
    homePath: 'C:\\Users\\Matthew',
    redactPaths: true,
  });
  for (const secret of SECRETS.slice(0, 2)) assert(!directRedaction.includes(secret), 'Central redactor should remove representative secrets.');
  assert(directRedaction.includes('%USERPROFILE%'), 'Central redactor should use the user-home placeholder when it knows the home path.');

  const preload = await fs.readFile(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  assert(preload.includes("copySystemInfo: () => invoke('diagnostics:copy-system-info')"), 'Preload should expose scoped copy-system-info IPC.');
  assert(preload.includes("createDiagnosticsBundle: () => invoke('diagnostics:create-bundle')"), 'Preload should expose bundle creation without renderer paths.');
  assert(preload.includes("openDiagnosticsFolder: () => invoke('diagnostics:open-folder')"), 'Preload should expose bounded diagnostics-folder opening.');
  assert(!/createDiagnosticsBundle:\s*\([^)]*payload/i.test(preload), 'Renderer must not request arbitrary files for diagnostics inclusion.');

  const mainSource = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert(mainSource.includes("ipcMain.handle('diagnostics:open-folder', () =>"), 'Open-folder IPC should accept no renderer path.');
  assert(mainSource.includes('getDiagnosticsRoot(await ensureStorage())'), 'Open-folder IPC should resolve the bounded diagnostics root in main.');

  const settingsSource = await fs.readFile(path.join(__dirname, '..', 'src', 'components', 'SettingsPanel.jsx'), 'utf8');
  assert(settingsSource.includes('Support and Diagnostics'), 'Settings should include the Support and Diagnostics section.');
  assert(settingsSource.includes('Review it before sharing.'), 'Settings should include the privacy review note.');

  await fs.remove(tempRoot);
  console.log('Diagnostics support verifier passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
