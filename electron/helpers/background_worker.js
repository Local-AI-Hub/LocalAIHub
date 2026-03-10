const path = require('path');
const fs = require('fs-extra');
const si = require('systeminformation');
const { spawn } = require('child_process');
const { parentPort } = require('worker_threads');

const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const COMMON_LIBRARY_ROOTS = [
  '',
  'Apps',
  'Applications',
  'Programs',
  'Tools',
  'AI',
  'AI Tools',
  'Portable',
  'LocalAI',
  path.join('SteamLibrary', 'steamapps', 'common'),
  path.join('Steam', 'steamapps', 'common'),
  'Games',
  path.join('Games', 'SteamLibrary', 'steamapps', 'common'),
];

function postMessage(payload) {
  if (parentPort) {
    parentPort.postMessage(payload);
    return;
  }

  process.send?.(payload);
}

function sendResult(requestId, result) {
  postMessage({
    ok: true,
    requestId,
    result,
  });
}

function sendError(requestId, error) {
  postMessage({
    error: error?.message || String(error) || 'A Local AI Hub background task failed.',
    ok: false,
    requestId,
  });
}

function getEnvValueInsensitive(name) {
  const key = Object.keys(process.env).find((entry) => entry.toLowerCase() === String(name || '').toLowerCase());
  return key ? process.env[key] : '';
}

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
      freeBytes,
      mount,
      sizeBytes,
      usePercent: sizeBytes > 0 ? Math.round((usedBytes / sizeBytes) * 1000) / 10 : null,
      usedBytes,
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

function pickPrimaryGpu(controllers) {
  if (!Array.isArray(controllers) || controllers.length === 0) {
    return {};
  }

  return [...controllers].sort((left, right) => {
    const leftDedicated = /nvidia|amd|radeon|geforce|rtx|gtx/i.test(`${left.vendor || ''} ${left.model || ''}`);
    const rightDedicated = /nvidia|amd|radeon|geforce|rtx|gtx/i.test(`${right.vendor || ''} ${right.model || ''}`);
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
    gpuModel: parts[0],
    gpuVendor: 'NVIDIA',
    nvidiaDriverVersion: parts[1],
    vramMb: Number.isFinite(vramMb) ? vramMb : 0,
    vramUsedMb: Number.isFinite(vramUsedMb) ? vramUsedMb : null,
  };
}

function parseCudaVersionFromSmi(output) {
  const match = String(output || '').match(/CUDA Version:\s*([0-9.]+)/i);
  return match ? match[1] : null;
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

function buildHardwareSnapshot(gpu, memory, nvidia, disks) {
  const fallbackGpuModel = nvidia?.gpuModel || 'Unknown GPU';
  const fallbackVendor = nvidia?.gpuVendor || 'Unknown vendor';
  const vramMb = nvidia?.vramMb || normalizeMb(gpu?.vram || gpu?.memoryTotal);
  const systemRamMb = Math.round((memory.total || 0) / 1024 / 1024);
  const gpuModel = gpu?.model || fallbackGpuModel;
  const gpuVendor = gpu?.vendor || fallbackVendor;

  return {
    compatibilityMessage: buildCompatibilityMessage(gpuModel, vramMb, systemRamMb),
    detectedAt: new Date().toISOString(),
    disks,
    gpuModel,
    gpuVendor,
    nvidiaCudaVersion: nvidia?.nvidiaCudaVersion || null,
    nvidiaDriverVersion: nvidia?.nvidiaDriverVersion || null,
    nvidiaSmiAvailable: Boolean(nvidia?.nvidiaSmiAvailable),
    systemRamMb,
    vramMb,
  };
}

function normalizePathKey(targetPath) {
  try {
    return path.resolve(String(targetPath || '')).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return String(targetPath || '').trim().toLowerCase();
  }
}

function normalizeInstallDirCandidate(candidatePath) {
  if (!candidatePath) {
    return null;
  }

  return path.basename(candidatePath) === 'app' ? path.dirname(candidatePath) : candidatePath;
}

function uniquePaths(paths = []) {
  const seen = new Set();
  const results = [];

  for (const entry of paths || []) {
    const normalized = normalizePathKey(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(entry);
  }

  return results;
}

async function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finalizeResolve = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };
    const finalizeReject = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    let stdout = '';
    let stderr = '';
    let child;

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...(options.env || {}),
        },
        shell: Boolean(options.shell),
        windowsHide: true,
      });
    } catch (error) {
      if (options.allowFailure) {
        finalizeResolve({
          code: 1,
          stderr: stderr || error?.message || String(error),
          stdout,
        });
        return;
      }

      finalizeReject(error);
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (options.allowFailure) {
        finalizeResolve({
          code: 1,
          stderr: stderr || error?.message || String(error),
          stdout,
        });
        return;
      }

      finalizeReject(error);
    });
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) {
        finalizeResolve({
          code,
          stderr,
          stdout,
        });
        return;
      }

      finalizeReject(new Error(String(stderr || stdout || `${command} failed.`).trim()));
    });
  });
}

async function getNvidiaRuntimeDetailsLocal() {
  const summary = await runCommand('nvidia-smi', [], {
    allowFailure: true,
  });
  if (summary.code !== 0) {
    return null;
  }

  const query = await runCommand(
    'nvidia-smi',
    ['--query-gpu=name,driver_version,memory.total,memory.used', '--format=csv,noheader,nounits'],
    {
      allowFailure: true,
    },
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

async function detectStorageSnapshotLocal() {
  const entries = await si.fsSize().catch(() => []);
  return buildDiskSnapshot(entries);
}

async function detectHardwareSnapshotLocal() {
  const [graphics, memory, nvidia, disks] = await Promise.all([
    si.graphics(),
    si.mem(),
    getNvidiaRuntimeDetailsLocal(),
    detectStorageSnapshotLocal(),
  ]);
  const gpu = pickPrimaryGpu(graphics.controllers);
  return buildHardwareSnapshot(gpu, memory, nvidia, disks);
}

async function getLiveResourceUsageLocal(payload = {}) {
  const targetPath = payload?.targetPath || null;
  const includeDisk = Boolean(targetPath) && payload?.includeDisk !== false;

  const [graphics, memory, nvidia, disks] = await Promise.all([
    si.graphics(),
    si.mem(),
    getNvidiaRuntimeDetailsLocal(),
    includeDisk ? detectStorageSnapshotLocal().catch(() => []) : Promise.resolve([]),
  ]);
  const gpu = pickPrimaryGpu(graphics.controllers);
  const vramTotalMb = resolveControllerVramTotal(gpu, nvidia);
  const controllerVramUsedMb = resolveControllerVramUsed(gpu, vramTotalMb);
  const vramUsedMb = Number.isFinite(nvidia?.vramUsedMb) ? nvidia.vramUsedMb : controllerVramUsedMb;
  const targetDisk = includeDisk ? findDiskForPath(disks, targetPath) : null;

  return {
    diskFreeBytes: targetDisk?.freeBytes ?? null,
    diskMount: targetDisk?.mount || null,
    diskTotalBytes: targetDisk?.sizeBytes ?? null,
    diskUsePercent: targetDisk?.usePercent ?? null,
    diskUsedBytes: targetDisk?.usedBytes ?? null,
    gpuName: gpu.model || nvidia?.gpuModel || 'Unknown GPU',
    nvidiaCudaVersion: nvidia?.nvidiaCudaVersion || null,
    nvidiaDriverVersion: nvidia?.nvidiaDriverVersion || null,
    ramTotalMb: Math.round((memory.total || 0) / 1024 / 1024),
    ramUsedMb: Math.round((memory.active || memory.used || 0) / 1024 / 1024),
    vramSource: Number.isFinite(nvidia?.vramUsedMb) ? 'nvidia-smi' : controllerVramUsedMb !== null ? 'systeminformation' : 'unknown',
    vramTotalMb,
    vramUsedMb: Number.isFinite(vramUsedMb) ? vramUsedMb : null,
  };
}

async function calculatePathSizeLocal(targetPath) {
  if (!(await fs.pathExists(targetPath))) {
    return 0;
  }

  const stats = await fs.stat(targetPath).catch(() => null);
  if (!stats) {
    return 0;
  }

  if (stats.isFile()) {
    return stats.size;
  }

  if (!stats.isDirectory()) {
    return 0;
  }

  const entries = await fs.readdir(targetPath, {
    withFileTypes: true,
  }).catch(() => []);
  const sizes = await Promise.all(
    entries.map((entry) => calculatePathSizeLocal(path.join(targetPath, entry.name))),
  );

  return sizes.reduce((total, value) => total + value, 0);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function expandDetectionPath(template) {
  return String(template || '').replace(/%([^%]+)%/g, (_match, name) => getEnvValueInsensitive(name) || '');
}

function getAllowedManagedInstallDirs(manifest, appPaths) {
  return uniquePaths([
    path.join(appPaths.toolsRoot, manifest.id),
    ...(appPaths.legacyRoots || []).map((legacyRoot) => path.join(legacyRoot, 'tools', manifest.id)),
  ]);
}

function getAllowedManagedLocationKeys(manifest, appPaths) {
  const locations = getAllowedManagedInstallDirs(manifest, appPaths);
  return new Set(
    uniquePaths([
      ...locations,
      ...locations.map((installDir) => path.join(installDir, 'app')),
    ]).map((entry) => normalizePathKey(entry)),
  );
}

function toolUsesManagedInstallLocation(manifest, tool, appPaths) {
  if (!tool) {
    return false;
  }

  if (tool.source === 'managed' || tool.managedByLocalAIHub) {
    return true;
  }

  const allowedLocations = getAllowedManagedLocationKeys(manifest, appPaths);
  const candidates = uniquePaths([
    normalizeInstallDirCandidate(tool.installDir),
    tool.installDir,
    tool.appDir,
    normalizeInstallDirCandidate(tool.detectedPath),
    normalizeInstallDirCandidate(tool.displayPath),
  ].filter(Boolean));

  return candidates.some((candidate) => allowedLocations.has(normalizePathKey(candidate)));
}

async function managedInstallDirectoryExists(manifest, installDir, appPaths) {
  const baseDir = normalizeInstallDirCandidate(installDir) || getAllowedManagedInstallDirs(manifest, appPaths)[0];
  const candidateDirs = uniquePaths([
    baseDir,
    path.join(baseDir || '', 'app'),
  ].filter(Boolean));

  for (const candidateDir of candidateDirs) {
    if (await directoryExists(candidateDir)) {
      return normalizeInstallDirCandidate(candidateDir);
    }
  }

  return null;
}

async function findExecutableOnPath(executableName) {
  const result = await runCommand('where', [executableName], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return null;
  }

  const candidate = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return candidate && (await fileExists(candidate)) ? candidate : null;
}

function parsePythonProbeResult(stdout) {
  const payload = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{'));

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function probePythonModule(moduleName, launcher, launcherArgs = []) {
  const probeSnippet = [
    'import importlib.util, json, sys',
    `module_name = ${JSON.stringify(moduleName)}`,
    'spec = importlib.util.find_spec(module_name)',
    'print(json.dumps({"found": bool(spec), "python": sys.executable}))',
  ].join('; ');

  const result = await runCommand(launcher, [...launcherArgs, '-c', probeSnippet], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return null;
  }

  const payload = parsePythonProbeResult(result.stdout);
  if (!payload?.found || !payload.python) {
    return null;
  }

  return {
    detectedPath: payload.python,
    displayPath: `${payload.python} (${moduleName})`,
    fromPath: true,
    installDir: path.dirname(path.dirname(payload.python)),
    pythonPath: payload.python,
    reason: 'python-module',
  };
}

async function discoverFromPythonModules(manifest) {
  const pythonModules = manifest.discovery?.pythonModules || [];
  if (!pythonModules.length) {
    return null;
  }

  const launchers = [
    { args: ['-3'], command: 'py' },
    { args: [], command: 'python' },
  ];

  for (const moduleName of pythonModules) {
    for (const launcher of launchers) {
      const resolved = await probePythonModule(moduleName, launcher.command, launcher.args);
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

async function resolveFilesystemCandidate(candidatePath, metadata = {}) {
  const expandedPath = expandDetectionPath(candidatePath);
  if (!expandedPath || !(await pathExists(expandedPath))) {
    return null;
  }

  const stats = await fs.stat(expandedPath);
  return {
    detectedPath: expandedPath,
    displayPath: expandedPath,
    fromPath: false,
    installDir: stats.isDirectory() ? expandedPath : path.dirname(expandedPath),
    reason: metadata.reason || 'filesystem',
  };
}

async function resolveDetectionPath(detectionPath) {
  if (String(detectionPath || '').startsWith('PATH:')) {
    const executable = detectionPath.slice(5).trim();
    const resolved = await findExecutableOnPath(executable);
    if (!resolved) {
      return null;
    }

    return {
      detectedPath: resolved,
      displayPath: resolved,
      fromPath: true,
      installDir: path.dirname(resolved),
      reason: 'manifest-path',
    };
  }

  return resolveFilesystemCandidate(detectionPath, {
    reason: 'manifest-path',
  });
}

function getTrackedPathCandidates(existingTool, manifest, appPaths) {
  return uniquePaths([
    existingTool?.detectedPath,
    existingTool?.displayPath,
    existingTool?.installDir,
    existingTool?.appDir,
    existingTool?.launchProfile?.executable,
    existingTool?.launchProfile?.command,
    existingTool?.launchProfile?.pythonPath,
    existingTool?.externalPythonPath,
    path.join(appPaths.toolsRoot, manifest.id),
    path.join(appPaths.toolsRoot, manifest.id, 'app'),
    ...(appPaths.legacyRoots || []).flatMap((legacyRoot) => [
      path.join(legacyRoot, 'tools', manifest.id),
      path.join(legacyRoot, 'tools', manifest.id, 'app'),
    ]),
  ].filter(Boolean));
}

async function getDriveRoots() {
  const discovered = [];

  for (const letter of DRIVE_LETTERS) {
    const driveRoot = `${letter}:\\`;
    if (await directoryExists(driveRoot)) {
      discovered.push(driveRoot);
    }
  }

  const systemDrive = getEnvValueInsensitive('SystemDrive');
  if (systemDrive) {
    discovered.push(systemDrive.endsWith('\\') ? systemDrive : `${systemDrive}\\`);
  }

  return uniquePaths(discovered);
}

async function buildCommonSearchRoots(appPaths) {
  const userProfile = getEnvValueInsensitive('USERPROFILE');
  const oneDrive = getEnvValueInsensitive('OneDrive');
  const envRoots = [
    getEnvValueInsensitive('LOCALAPPDATA'),
    path.join(getEnvValueInsensitive('LOCALAPPDATA') || '', 'Programs'),
    getEnvValueInsensitive('APPDATA'),
    getEnvValueInsensitive('PROGRAMFILES'),
    getEnvValueInsensitive('ProgramFiles(x86)'),
    getEnvValueInsensitive('PROGRAMDATA'),
    userProfile,
    path.join(userProfile || '', 'Documents'),
    path.join(userProfile || '', 'Downloads'),
    path.join(userProfile || '', 'Desktop'),
    oneDrive,
    path.join(oneDrive || '', 'Documents'),
    path.join(oneDrive || '', 'Desktop'),
    getEnvValueInsensitive('PUBLIC'),
    path.join(getEnvValueInsensitive('PUBLIC') || '', 'Documents'),
    appPaths.toolsRoot,
    ...(appPaths.legacyRoots || []).map((legacyRoot) => path.join(legacyRoot, 'tools')),
  ].filter(Boolean);

  const driveRoots = await getDriveRoots();
  const driveLibraries = driveRoots.flatMap((driveRoot) =>
    COMMON_LIBRARY_ROOTS.map((relativeRoot) => path.join(driveRoot, relativeRoot)),
  );

  return uniquePaths([...envRoots, ...driveLibraries]);
}

async function discoverFromManifestPaths(manifest) {
  for (const detectionPath of manifest.detectionPaths || []) {
    const resolved = await resolveDetectionPath(detectionPath);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function discoverFromTrackedPaths(manifest, existingTool, appPaths) {
  for (const candidatePath of getTrackedPathCandidates(existingTool, manifest, appPaths)) {
    const resolved = await resolveFilesystemCandidate(candidatePath, {
      reason: 'tracked-path',
    });

    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function discoverFromPathExecutables(manifest) {
  const executables = uniquePaths([
    ...(manifest.discovery?.pathExecutables || []),
    ...(manifest.installInstructions?.externalExecutableCandidates || [])
      .map((entry) => path.basename(entry))
      .filter((entry) => entry && entry !== '.'),
  ]);

  for (const executable of executables) {
    if (!executable || /[\\/]/.test(executable)) {
      continue;
    }

    const resolved = await findExecutableOnPath(executable);
    if (resolved) {
      return {
        detectedPath: resolved,
        displayPath: resolved,
        fromPath: true,
        installDir: path.dirname(resolved),
        reason: 'path-executable',
      };
    }
  }

  return null;
}

async function discoverFromCommonRoots(manifest, appPaths) {
  const folderNames = uniquePaths(manifest.discovery?.folderNames || []);
  const markerPaths = uniquePaths(manifest.discovery?.markerPaths || []);
  const searchRoots = await buildCommonSearchRoots(appPaths);

  for (const root of searchRoots) {
    for (const folderName of folderNames) {
      for (const markerPath of markerPaths) {
        const candidate = path.join(root, folderName, markerPath);
        const resolved = await resolveFilesystemCandidate(candidate, {
          reason: 'common-root-scan',
        });
        if (resolved) {
          return resolved;
        }
      }
    }
  }

  return null;
}

async function discoverInstallLocation(manifest, existingTool, appPaths) {
  const discoverySteps = [
    () => discoverFromTrackedPaths(manifest, existingTool, appPaths),
    () => discoverFromManifestPaths(manifest),
    () => discoverFromPathExecutables(manifest),
    () => discoverFromPythonModules(manifest),
    () => discoverFromCommonRoots(manifest, appPaths),
  ];

  for (const discoverStep of discoverySteps) {
    const resolved = await discoverStep();
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function findManagedInstallCandidate(manifest, candidatePaths, appPaths) {
  for (const candidate of uniquePaths(candidatePaths.filter(Boolean))) {
    const resolved = await managedInstallDirectoryExists(manifest, candidate, appPaths);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function discoverTools(payload = {}) {
  const manifests = Array.isArray(payload?.manifests) ? payload.manifests : [];
  const tools = payload?.tools && typeof payload.tools === 'object' ? payload.tools : {};
  const ignoredToolIds = new Set(Array.isArray(payload?.ignoredToolIds) ? payload.ignoredToolIds : []);
  const appPaths = payload?.appPaths || {};
  const results = {};

  for (const manifest of manifests) {
    const existingTool = tools[manifest.id] || null;
    const shouldTreatAsManaged = toolUsesManagedInstallLocation(manifest, existingTool, appPaths);
    const managedCandidates = shouldTreatAsManaged
      ? [
          normalizeInstallDirCandidate(existingTool?.installDir),
          normalizeInstallDirCandidate(existingTool?.appDir),
          ...getAllowedManagedInstallDirs(manifest, appPaths),
        ]
      : getAllowedManagedInstallDirs(manifest, appPaths);

    const managedInstallDir = await findManagedInstallCandidate(manifest, managedCandidates, appPaths);
    const externalDetected =
      ignoredToolIds.has(manifest.id) || managedInstallDir
        ? null
        : await discoverInstallLocation(manifest, existingTool, appPaths);

    results[manifest.id] = {
      externalDetected,
      managedInstallDir,
      shouldTreatAsManaged,
    };
  }

  return results;
}

async function handleTask(task, payload) {
  if (task === 'calculate-path-size') {
    return calculatePathSizeLocal(payload?.targetPath);
  }

  if (task === 'detect-hardware-snapshot') {
    return detectHardwareSnapshotLocal();
  }

  if (task === 'detect-storage-snapshot') {
    return detectStorageSnapshotLocal();
  }

  if (task === 'discover-tools') {
    return discoverTools(payload);
  }

  if (task === 'get-live-resource-usage') {
    return getLiveResourceUsageLocal(payload);
  }

  if (task === 'get-nvidia-runtime-details') {
    return getNvidiaRuntimeDetailsLocal();
  }

  throw new Error(`Unknown background task: ${task}`);
}

async function handleMessage(message) {
  const requestId = Number(message?.requestId);

  try {
    const result = await handleTask(message?.task, message?.payload || {});
    sendResult(requestId, result);
  } catch (error) {
    sendError(requestId, error);
  }
}

if (parentPort) {
  parentPort.on('message', handleMessage);
} else {
  process.on('message', handleMessage);
}

process.on('disconnect', () => {
  process.exit(0);
});
