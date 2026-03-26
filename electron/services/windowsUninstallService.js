const path = require('path');
const fs = require('fs-extra');

const { runCommand } = require('./commandService');
const { humanizeError, normalizeDirectoryPath } = require('./configService');
const { tokenizeCommand } = require('./toolRegistry');

const WINDOWS_UNINSTALL_CACHE_TTL_MS = 15000;
const WINDOWS_UNINSTALL_ROOTS = [
  'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

let cachedEntries = {
  entries: [],
  timestamp: 0,
};

function getEnvValueInsensitive(name) {
  const key = Object.keys(process.env).find((entry) => entry.toLowerCase() === String(name || '').toLowerCase());
  return key ? process.env[key] : null;
}

function expandWindowsEnvironmentVariables(value) {
  return String(value || '').replace(/%([^%]+)%/g, (_match, name) => getEnvValueInsensitive(name) || `%${name}%`);
}

function normalizeOptionalPath(value) {
  const text = String(value || '').trim().replace(/^"|"$/g, '');
  return text ? normalizeDirectoryPath(expandWindowsEnvironmentVariables(text)) : null;
}

function normalizePathKey(value) {
  const normalizedPath = normalizeOptionalPath(value);
  return normalizedPath ? normalizedPath.toLowerCase() : '';
}

function isPathInside(parentPath, candidatePath) {
  const normalizedParent = normalizeOptionalPath(parentPath);
  const normalizedCandidate = normalizeOptionalPath(candidatePath);
  if (!normalizedParent || !normalizedCandidate) {
    return false;
  }

  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

function uniquePaths(paths = []) {
  const seen = new Set();
  const results = [];

  for (const entry of paths || []) {
    const normalizedPath = normalizeOptionalPath(entry);
    const key = normalizePathKey(normalizedPath);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(normalizedPath);
  }

  return results;
}

function normalizeDisplayIcon(value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  const candidate = text.split(',')[0].trim().replace(/^"|"$/g, '');
  return normalizeOptionalPath(candidate) || null;
}

function extractCommandPath(commandLine) {
  const tokens = tokenizeCommand(commandLine || '');
  if (!tokens.length) {
    return null;
  }

  const candidate = expandWindowsEnvironmentVariables(String(tokens[0] || '').trim().replace(/^"|"$/g, ''));
  if (!candidate || /^[a-z]+:$/i.test(candidate)) {
    return null;
  }

  if (/^[A-Za-z]:\\/.test(candidate) || candidate.startsWith('\\\\')) {
    return candidate;
  }

  if (/^[^\\/:]+\.exe$/i.test(candidate)) {
    return null;
  }

  return /\.exe$/i.test(candidate) ? candidate : null;
}

function normalizeEntry(rawEntry = {}) {
  const quietUninstallString = String(rawEntry.quietUninstallString || '').trim();
  const uninstallString = String(rawEntry.uninstallString || '').trim();

  return {
    displayIcon: normalizeDisplayIcon(rawEntry.displayIcon),
    displayName: String(rawEntry.displayName || '').trim(),
    installLocation: normalizeOptionalPath(rawEntry.installLocation),
    keyPath: String(rawEntry.keyPath || '').trim(),
    publisher: String(rawEntry.publisher || '').trim(),
    quietUninstallString,
    uninstallExecutable: extractCommandPath(quietUninstallString) || extractCommandPath(uninstallString),
    uninstallString,
  };
}

async function listWindowsUninstallEntries(options = {}) {
  if (!options.refresh && cachedEntries.entries.length && Date.now() - cachedEntries.timestamp < WINDOWS_UNINSTALL_CACHE_TTL_MS) {
    return cachedEntries.entries;
  }

  const escapedRoots = WINDOWS_UNINSTALL_ROOTS.map(escapePowerShellString).join(', ');
  const script = [
    `$roots = @(${escapedRoots})`,
    '$entries = New-Object System.Collections.Generic.List[object]',
    'foreach ($root in $roots) {',
    '  if (-not (Test-Path $root)) { continue }',
    '  Get-ChildItem -Path $root -ErrorAction SilentlyContinue | ForEach-Object {',
    '    try {',
    '      $props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop',
    '      $entries.Add([PSCustomObject]@{',
    '        displayIcon = [string]$props.DisplayIcon',
    '        displayName = [string]$props.DisplayName',
    '        installLocation = [string]$props.InstallLocation',
    '        keyPath = [string]$_.Name',
    '        publisher = [string]$props.Publisher',
    '        quietUninstallString = [string]$props.QuietUninstallString',
    '        uninstallString = [string]$props.UninstallString',
    '      }) | Out-Null',
    '    } catch { }',
    '  }',
    '}',
    '$entries | ConvertTo-Json -Compress',
  ].join('\n');

  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', script], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    cachedEntries = {
      entries: [],
      timestamp: Date.now(),
    };
    return [];
  }

  let parsed = [];
  try {
    const payload = String(result.stdout || '').trim();
    if (!payload) {
      parsed = [];
    } else {
      const decoded = JSON.parse(payload);
      parsed = Array.isArray(decoded) ? decoded : decoded ? [decoded] : [];
    }
  } catch {
    parsed = [];
  }

  cachedEntries = {
    entries: parsed
      .map(normalizeEntry)
      .filter((entry) => entry.displayName || entry.uninstallString || entry.quietUninstallString || entry.keyPath),
    timestamp: Date.now(),
  };
  return cachedEntries.entries;
}

function collectEntryPaths(entry) {
  return uniquePaths([
    entry.installLocation,
    entry.displayIcon,
    entry.displayIcon ? path.dirname(entry.displayIcon) : null,
    entry.uninstallExecutable,
    entry.uninstallExecutable ? path.dirname(entry.uninstallExecutable) : null,
  ]);
}

async function getEntryHealth(entry) {
  const directPaths = uniquePaths([
    entry.installLocation,
    entry.displayIcon,
    entry.uninstallExecutable,
  ]);
  const directoryPaths = uniquePaths([
    entry.displayIcon ? path.dirname(entry.displayIcon) : null,
    entry.uninstallExecutable ? path.dirname(entry.uninstallExecutable) : null,
  ]);
  const paths = uniquePaths([...directPaths, ...directoryPaths]);
  const existingFiles = [];
  for (const targetPath of directPaths) {
    if (await fs.pathExists(targetPath)) {
      existingFiles.push(targetPath);
    }
  }

  const existingDirectories = [];
  for (const targetPath of directoryPaths) {
    if (await fs.pathExists(targetPath)) {
      existingDirectories.push(targetPath);
    }
  }

  const existingPaths = [];
  for (const targetPath of [...existingFiles, ...existingDirectories]) {
    const normalizedPath = normalizeOptionalPath(targetPath);
    if (!normalizedPath) {
      continue;
    }

    const key = normalizePathKey(normalizedPath);
    if (existingPaths.some((existingPath) => normalizePathKey(existingPath) === key)) {
      continue;
    }

    existingPaths.push(normalizedPath);
  }

  const hasUninstallCommand = Boolean(String(entry?.quietUninstallString || entry?.uninstallString || '').trim());
  const uninstallExecutableMissing =
    Boolean(entry?.uninstallExecutable) &&
    !existingFiles.some((existingPath) => normalizePathKey(existingPath) === normalizePathKey(entry.uninstallExecutable));
  const usable = hasUninstallCommand && !uninstallExecutableMissing;
  const hasInstallEvidence = existingFiles.length > 0 || existingDirectories.length > 0;
  const stale = (!hasInstallEvidence && !usable) || (paths.length === 0 && !hasUninstallCommand);

  return {
    broken: hasInstallEvidence && !usable,
    existingDirectories,
    existingFiles,
    existingPaths,
    hasInstallEvidence,
    hasUninstallCommand,
    missingPaths: paths.filter((targetPath) => !existingPaths.some((existingPath) => normalizePathKey(existingPath) === normalizePathKey(targetPath))),
    paths,
    stale,
    staleReason: paths.length === 0 && !hasUninstallCommand ? 'metadata-only' : stale ? 'missing-paths' : null,
    uninstallExecutableMissing,
    usable,
  };
}

function normalizeNameToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildNameTokenSet(values = []) {
  return new Set(values.map((entry) => normalizeNameToken(entry)).filter(Boolean));
}

function collectManifestNameTokens(manifest) {
  return buildNameTokenSet([
    manifest?.id,
    manifest?.name,
    ...(manifest?.discovery?.folderNames || []),
    ...(manifest?.installInstructions?.externalExecutableCandidates || []).map((entry) => path.basename(String(entry || ''), path.extname(String(entry || '')))),
    ...(manifest?.installInstructions?.externalBatchCandidates || []).map((entry) => path.basename(String(entry || ''), path.extname(String(entry || '')))),
  ]);
}

function collectStoredSignals(toolState) {
  return {
    commandFragments: [toolState?.windowsUninstallCommand, toolState?.windowsUninstallQuietCommand]
      .map((entry) => String(entry || '').trim().toLowerCase())
      .filter(Boolean),
    keyPaths: new Set([String(toolState?.windowsUninstallKeyPath || '').trim().toLowerCase()].filter(Boolean)),
    keyTokens: buildNameTokenSet([path.basename(String(toolState?.windowsUninstallKeyPath || ''))]),
    nameTokens: buildNameTokenSet([toolState?.windowsUninstallDisplayName]),
    pathCandidates: uniquePaths([
      toolState?.installDir,
      toolState?.appDir,
      toolState?.displayPath,
      toolState?.detectedPath,
      toolState?.executablePath,
      toolState?.externalInstallDir,
      toolState?.externalInstallDisplayPath,
      toolState?.externalDetectedPath,
      toolState?.windowsInstallLocation,
    ]),
  };
}

function commandMatchesStored(commandLine, storedCommandFragments = []) {
  const normalizedCommand = String(commandLine || '').trim().toLowerCase();
  if (!normalizedCommand) {
    return false;
  }

  return storedCommandFragments.some((entry) => entry === normalizedCommand || entry.includes(normalizedCommand) || normalizedCommand.includes(entry));
}

function entryMatchesToken(entryToken, candidateToken) {
  if (!entryToken || !candidateToken) {
    return false;
  }

  if (entryToken === candidateToken || (candidateToken.length >= 4 && entryToken.includes(candidateToken))) {
    return true;
  }

  if (candidateToken.length >= 3 && entryToken.startsWith(candidateToken)) {
    return /^\d/.test(entryToken.slice(candidateToken.length));
  }

  return false;
}

function scoreEntryForTool(entry, manifest, toolState) {
  const entryNameToken = normalizeNameToken(entry.displayName);
  const entryKeyToken = normalizeNameToken(path.basename(entry.keyPath || ''));
  const manifestTokens = collectManifestNameTokens(manifest);
  const storedSignals = collectStoredSignals(toolState);
  const entryPaths = collectEntryPaths(entry);
  const executableNames = new Set(
    (manifest?.installInstructions?.externalExecutableCandidates || [])
      .map((candidate) => path.basename(String(candidate || '')).toLowerCase())
      .filter(Boolean),
  );

  let score = 0;

  if (storedSignals.keyPaths.has(String(entry.keyPath || '').trim().toLowerCase())) {
    score += 20;
  }

  if (storedSignals.nameTokens.has(entryNameToken)) {
    score += 8;
  }

  if (storedSignals.keyTokens.has(entryKeyToken)) {
    score += 6;
  }

  if (commandMatchesStored(entry.uninstallString, storedSignals.commandFragments) || commandMatchesStored(entry.quietUninstallString, storedSignals.commandFragments)) {
    score += 8;
  }

  if (entry.displayIcon && executableNames.has(path.basename(entry.displayIcon).toLowerCase())) {
    score += 2;
  }

  for (const token of manifestTokens) {
    if (entryMatchesToken(entryNameToken, token)) {
      score += entryNameToken === token ? 4 : 3;
      break;
    }
  }

  for (const token of manifestTokens) {
    if (entryMatchesToken(entryKeyToken, token)) {
      score += entryKeyToken === token ? 4 : 3;
      break;
    }
  }

  for (const toolPath of storedSignals.pathCandidates) {
    for (const entryPath of entryPaths) {
      if (isPathInside(toolPath, entryPath) || isPathInside(entryPath, toolPath)) {
        score += 10;
      }
    }

    const normalizedToolPath = String(toolPath || '').toLowerCase();
    if (normalizedToolPath && entry.uninstallString && entry.uninstallString.toLowerCase().includes(normalizedToolPath)) {
      score += 4;
    }

    if (normalizedToolPath && entry.quietUninstallString && entry.quietUninstallString.toLowerCase().includes(normalizedToolPath)) {
      score += 4;
    }
  }

  return score;
}

async function resolveToolUninstallContext(toolState, manifest, options = {}) {
  const entries = await listWindowsUninstallEntries({ refresh: Boolean(options.refresh) });
  const storedSignals = collectStoredSignals(toolState);
  const candidateMap = new Map();

  for (const entry of entries) {
    const score = scoreEntryForTool(entry, manifest, toolState);
    const entryPaths = collectEntryPaths(entry);
    const touchesTrackedPath = storedSignals.pathCandidates.some((toolPath) =>
      entryPaths.some((entryPath) => isPathInside(toolPath, entryPath) || isPathInside(entryPath, toolPath)),
    );
    if (score <= 0 && !touchesTrackedPath) {
      continue;
    }

    const key = String(entry.keyPath || '').trim().toLowerCase();
    if (!key) {
      continue;
    }

    const normalizedScore = score > 0 ? score : 1;
    const existingCandidate = candidateMap.get(key);
    if (!existingCandidate || normalizedScore > existingCandidate.score) {
      candidateMap.set(key, {
        entry,
        score: normalizedScore,
      });
    }
  }

  const scoredEntries = [...candidateMap.values()].sort((left, right) => right.score - left.score);

  const brokenEntries = [];
  const scoredEntriesWithHealth = [];
  const staleEntries = [];

  for (const candidate of scoredEntries) {
    const health = await getEntryHealth(candidate.entry);
    const enrichedCandidate = {
      ...candidate,
      health,
    };
    scoredEntriesWithHealth.push(enrichedCandidate);
    if (health.stale) {
      staleEntries.push({
        entry: candidate.entry,
        health,
      });
      continue;
    }

    if (!health.usable) {
      brokenEntries.push({
        entry: candidate.entry,
        health,
      });
    }
  }

  const match = scoredEntriesWithHealth.find((candidate) => candidate.health.usable && !candidate.health.stale) || null;

  return {
    brokenEntries,
    entry: match?.entry || null,
    health: match?.health || null,
    staleEntries,
  };
}

function enrichToolWithWindowsUninstall(toolState, context) {
  const entry = context?.entry || null;
  const brokenEntries = context?.brokenEntries || [];
  const staleEntries = context?.staleEntries || [];
  const windowsUninstallPathState = entry
    ? staleEntries.length > 0
      ? 'present-with-stale'
      : 'present'
    : staleEntries.length > 0 || brokenEntries.length > 0
      ? 'stale'
      : 'missing';

  return {
    ...toolState,
    windowsInstallLocation: entry?.installLocation || null,
    windowsUninstallBrokenCount: brokenEntries.length,
    windowsUninstallDetected: Boolean(entry),
    windowsUninstallDisplayName: entry?.displayName || null,
    windowsUninstallKeyPath: entry?.keyPath || null,
    windowsUninstallPathState,
    windowsUninstallQuietCommand: entry?.quietUninstallString || null,
    windowsUninstallCommand: entry?.uninstallString || null,
    windowsUninstallStaleCount: staleEntries.length,
  };
}

function buildKnownToolTokenSet(options = {}) {
  const tokens = new Set();

  for (const manifest of options.manifests || []) {
    for (const token of collectManifestNameTokens(manifest)) {
      tokens.add(token);
    }
  }

  for (const tool of Object.values(options.trackedTools || {})) {
    for (const token of buildNameTokenSet([
      tool?.id,
      tool?.name,
      tool?.windowsUninstallDisplayName,
    ])) {
      tokens.add(token);
    }
  }

  return tokens;
}

function entryMatchesKnownToolToken(entry, knownTokens) {
  if (!knownTokens?.size) {
    return false;
  }

  const entryTokens = [
    normalizeNameToken(entry?.displayName),
    normalizeNameToken(path.basename(entry?.keyPath || '')),
  ].filter(Boolean);

  return entryTokens.some((entryToken) => {
    if (knownTokens.has(entryToken)) {
      return true;
    }

    for (const token of knownTokens) {
      if (entryMatchesToken(entryToken, token)) {
        return true;
      }
    }

    return false;
  });
}

async function collectStaleWindowsUninstallEntries(allowedRoots = [], options = {}) {
  const entries = await listWindowsUninstallEntries();
  const results = [];
  const knownTokens = buildKnownToolTokenSet(options);

  for (const entry of entries) {
    const health = await getEntryHealth(entry);
    if (!health.stale) {
      continue;
    }

    const touchesAllowedRoot = health.paths.some((candidatePath) =>
      allowedRoots.some((rootPath) => isPathInside(rootPath, candidatePath) || isPathInside(candidatePath, rootPath)),
    );
    if (!touchesAllowedRoot && !(health.paths.length === 0 && entryMatchesKnownToolToken(entry, knownTokens))) {
      continue;
    }

    results.push({
      displayName: entry.displayName || 'Windows uninstall entry',
      health,
      keyPath: entry.keyPath,
    });
  }

  return results;
}

async function removeWindowsUninstallEntry(entryOrKeyPath) {
  const keyPath = typeof entryOrKeyPath === 'string' ? entryOrKeyPath : entryOrKeyPath?.keyPath;
  if (!String(keyPath || '').trim()) {
    return;
  }

  await runCommand('reg.exe', ['delete', String(keyPath), '/f'], {
    errorMessage: 'Local AI Hub could not remove the broken Windows uninstall entry.',
  });
  cachedEntries = {
    entries: [],
    timestamp: 0,
  };
}

function buildPreferredUninstallCommand(entry) {
  const quietCommand = String(entry?.quietUninstallString || '').trim();
  if (quietCommand) {
    return quietCommand;
  }

  const uninstallCommand = String(entry?.uninstallString || '').trim();
  if (!uninstallCommand) {
    return '';
  }

  if (/msiexec(\.exe)?/i.test(uninstallCommand)) {
    let normalized = uninstallCommand.replace(/\/(?:I|i)(?=\s*\{)/, '/X');
    if (!/\/(?:q|quiet|passive)\b/i.test(normalized)) {
      normalized = `${normalized} /qn /norestart`;
    }
    return normalized;
  }

  return uninstallCommand;
}

function buildWindowsCommandInvocation(commandLine) {
  const expandedCommandLine = expandWindowsEnvironmentVariables(commandLine).trim();
  if (!expandedCommandLine) {
    return null;
  }

  const tokens = tokenizeCommand(expandedCommandLine);
  if (!tokens.length) {
    return null;
  }

  const command = String(tokens[0] || '').trim().replace(/^['"]|['"]$/g, '');
  const args = tokens.slice(1).map((entry) => String(entry || ''));
  if (!command) {
    return null;
  }

  if (/\.ps1$/i.test(command)) {
    return {
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
      command: 'powershell.exe',
    };
  }

  if (/\.(?:cmd|bat)$/i.test(command)) {
    return {
      args: ['/d', '/s', '/c', command, ...args],
      command: 'cmd.exe',
    };
  }

  return {
    args,
    command,
  };
}

async function runWindowsUninstaller(entry, logger, toolName = 'This tool') {
  const commandLine = buildPreferredUninstallCommand(entry);
  if (!commandLine) {
    throw new Error(`${toolName} did not expose a Windows uninstall command.`);
  }

  const invocation = buildWindowsCommandInvocation(commandLine);
  await logger?.info?.('Running the Windows uninstaller for a tool.', {
    keyPath: entry?.keyPath || null,
    toolName,
    command: invocation?.command || 'cmd.exe',
  });

  const result = invocation
    ? await runCommand(invocation.command, invocation.args, {
        allowFailure: true,
      })
    : await runCommand('cmd.exe', ['/d', '/s', '/c', expandWindowsEnvironmentVariables(commandLine)], {
        allowFailure: true,
      });
  cachedEntries = {
    entries: [],
    timestamp: 0,
  };

  if (result.code !== 0) {
    const readableMessage = humanizeError(result.stderr || result.stdout || '', `${toolName} did not finish uninstalling.`);
    throw new Error(readableMessage);
  }

  return result;
}

function escapePowerShellString(value) {
  return `'${String(value || '').replace(/'/g, `''`)}'`;
}

function getWindowsShortcutRoots() {
  return uniquePaths([
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : null,
    process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
    process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
  ]);
}

async function listWindowsShortcutDetails() {
  const roots = getWindowsShortcutRoots();
  if (!roots.length) {
    return [];
  }

  const escapedRoots = roots.map(escapePowerShellString).join(', ');
  const script = [
    `$roots = @(${escapedRoots})`,
    '$shell = New-Object -ComObject WScript.Shell',
    '$shortcuts = foreach ($root in $roots) {',
    '  if (-not (Test-Path $root)) { continue }',
    '  Get-ChildItem -Path $root -Filter *.lnk -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {',
    '    try {',
    '      $shortcut = $shell.CreateShortcut($_.FullName)',
    '      $iconValue = ""',
    "      if ($shortcut.IconLocation) { $iconValue = ($shortcut.IconLocation -split ',')[0] }",
    '      [PSCustomObject]@{',
    '        shortcutPath = $_.FullName',
    '        targetPath = [string]$shortcut.TargetPath',
    '        workingDirectory = [string]$shortcut.WorkingDirectory',
    '        iconPath = [string]$iconValue',
    '      }',
    '    } catch { }',
    '  }',
    '}',
    '$shortcuts | ConvertTo-Json -Compress',
  ].join('\n');

  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', script], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return [];
  }

  try {
    const payload = String(result.stdout || '').trim();
    if (!payload) {
      return [];
    }

    const decoded = JSON.parse(payload);
    const shortcuts = Array.isArray(decoded) ? decoded : decoded ? [decoded] : [];
    const seen = new Set();
    return shortcuts.filter((entry) => {
      const key = normalizePathKey(entry?.shortcutPath || '');
      if (!key || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  } catch {
    return [];
  }
}

async function collectStaleToolWindowsShortcuts(allowedRoots = [], options = {}) {
  const shortcuts = await listWindowsShortcutDetails();
  const knownTokens = buildKnownToolTokenSet(options);
  const results = [];

  for (const shortcut of shortcuts) {
    const shortcutPath = normalizeOptionalPath(shortcut?.shortcutPath);
    if (!shortcutPath) {
      continue;
    }

    const targetPath = normalizeOptionalPath(shortcut?.targetPath);
    const workingDirectory = normalizeOptionalPath(shortcut?.workingDirectory);
    const iconPath = normalizeOptionalPath(shortcut?.iconPath);
    const candidatePaths = uniquePaths([targetPath, workingDirectory, iconPath]);
    const touchesAllowedRoot = candidatePaths.some((candidatePath) =>
      allowedRoots.some((rootPath) => isPathInside(rootPath, candidatePath) || isPathInside(candidatePath, rootPath)),
    );
    const nameMatchesKnownTool = entryMatchesKnownToolToken(
      {
        displayName: path.basename(shortcutPath, path.extname(shortcutPath || '')),
        keyPath: shortcutPath,
      },
      knownTokens,
    );

    if (!touchesAllowedRoot && !nameMatchesKnownTool) {
      continue;
    }

    const targetExists = targetPath ? await fs.pathExists(targetPath) : false;
    if (targetExists) {
      continue;
    }

    const workingExists = workingDirectory ? await fs.pathExists(workingDirectory) : false;
    const iconExists = iconPath ? await fs.pathExists(iconPath) : false;
    if (!touchesAllowedRoot && (workingExists || iconExists)) {
      continue;
    }

    results.push({
      displayName: path.basename(shortcutPath, path.extname(shortcutPath || '')) || 'Windows shortcut',
      iconPath,
      shortcutPath,
      targetPath,
      workingDirectory,
    });
  }

  return results;
}

async function listToolWindowsShortcutPaths(toolState) {
  const installPaths = uniquePaths([
    toolState?.installDir,
    toolState?.appDir,
    toolState?.displayPath,
    toolState?.detectedPath,
    toolState?.windowsInstallLocation,
  ]);
  if (!installPaths.length) {
    return [];
  }

  const roots = uniquePaths([
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : null,
    process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
    process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
  ]);
  if (!roots.length) {
    return [];
  }

  const escapedRoots = roots.map(escapePowerShellString).join(', ');
  const escapedInstallPaths = installPaths.map(escapePowerShellString).join(', ');
  const script = [
    `$roots = @(${escapedRoots})`,
    `$installRoots = @(${escapedInstallPaths})`,
    'function Normalize-LocalAiHubPath([string]$value) {',
    '  if ([string]::IsNullOrWhiteSpace($value)) { return "" }',
    "  $trimmed = $value.Trim().Trim('\"')",
    '  try { return [System.IO.Path]::GetFullPath($trimmed).TrimEnd([System.IO.Path]::DirectorySeparatorChar) } catch { return $trimmed.TrimEnd([System.IO.Path]::DirectorySeparatorChar) }',
    '}',
    'function Is-Inside([string]$parent, [string]$candidate) {',
    '  if ([string]::IsNullOrWhiteSpace($parent) -or [string]::IsNullOrWhiteSpace($candidate)) { return $false }',
    '  $normalizedParent = Normalize-LocalAiHubPath $parent',
    '  $normalizedCandidate = Normalize-LocalAiHubPath $candidate',
    '  if ([string]::IsNullOrWhiteSpace($normalizedParent) -or [string]::IsNullOrWhiteSpace($normalizedCandidate)) { return $false }',
    '  return $normalizedCandidate.Equals($normalizedParent, [System.StringComparison]::OrdinalIgnoreCase) -or $normalizedCandidate.StartsWith($normalizedParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)',
    '}',
    '$shell = New-Object -ComObject WScript.Shell',
    '$matches = foreach ($root in $roots) {',
    '  if (-not (Test-Path $root)) { continue }',
    '  Get-ChildItem -Path $root -Filter *.lnk -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {',
    '    try {',
    '      $shortcut = $shell.CreateShortcut($_.FullName)',
    '      $iconValue = ""',
    "      if ($shortcut.IconLocation) { $iconValue = ($shortcut.IconLocation -split ',')[0] }",
    '      $candidates = @($shortcut.TargetPath, $shortcut.WorkingDirectory, $iconValue)',
    '      $matched = $false',
    '      foreach ($installRoot in $installRoots) {',
    '        foreach ($candidate in $candidates) {',
    '          if (Is-Inside $installRoot $candidate -or Is-Inside $candidate $installRoot) {',
    '            $matched = $true',
    '            break',
    '          }',
    '        }',
    '        if ($matched) { break }',
    '      }',
    '      if ($matched) { $_.FullName }',
    '    } catch { }',
    '  }',
    '}',
    '$matches | Sort-Object -Unique | ConvertTo-Json -Compress',
  ].join('\n');

  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', script], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return [];
  }

  try {
    const payload = String(result.stdout || '').trim();
    if (!payload) {
      return [];
    }

    const decoded = JSON.parse(payload);
    return uniquePaths(Array.isArray(decoded) ? decoded : decoded ? [decoded] : []);
  } catch {
    return [];
  }
}

async function removeToolWindowsShortcuts(toolState, logger) {
  const shortcutPaths = await listToolWindowsShortcutPaths(toolState);
  const removedPaths = [];

  for (const shortcutPath of shortcutPaths) {
    if (!(await fs.pathExists(shortcutPath))) {
      continue;
    }

    try {
      await fs.remove(shortcutPath);
      removedPaths.push(shortcutPath);
      await logger?.info?.('Removed a leftover Windows shortcut for a tool.', {
        path: shortcutPath,
        toolId: toolState?.id || null,
      });
    } catch (error) {
      await logger?.warn?.('Local AI Hub could not remove a leftover Windows shortcut.', {
        error,
        path: shortcutPath,
        toolId: toolState?.id || null,
      });
    }
  }

  return {
    removedCount: removedPaths.length,
    removedPaths,
  };
}

module.exports = {
  collectEntryPaths,
  collectStaleToolWindowsShortcuts,
  collectStaleWindowsUninstallEntries,
  enrichToolWithWindowsUninstall,
  getWindowsShortcutRoots,
  listWindowsUninstallEntries,
  removeToolWindowsShortcuts,
  removeWindowsUninstallEntry,
  resolveToolUninstallContext,
  runWindowsUninstaller,
};
