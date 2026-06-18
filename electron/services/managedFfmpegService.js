const path = require('path');
const fs = require('fs-extra');
const { execFile } = require('child_process');
const { promisify } = require('util');

let app = null;
try {
  ({ app } = require('electron'));
} catch {
  app = null;
}

let staticPair = null;
try {
  staticPair = require('ffmpeg-ffprobe-static') || null;
} catch {
  staticPair = null;
}

const execFileAsync = promisify(execFile);
const FFMPEG_BINARY_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const FFPROBE_BINARY_NAME = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';

function buildManagedFfmpegPathsFromBinDir(binDir, source = 'managed-bin') {
  const resolvedBinDir = path.resolve(String(binDir || '').trim());
  return {
    binDir: resolvedBinDir,
    ffmpegPath: path.join(resolvedBinDir, FFMPEG_BINARY_NAME),
    ffprobePath: path.join(resolvedBinDir, FFPROBE_BINARY_NAME),
    source,
  };
}

function getPackagedManagedFfmpegPaths() {
  if (!app?.isPackaged || !process.resourcesPath) {
    return null;
  }
  return buildManagedFfmpegPathsFromBinDir(path.join(process.resourcesPath, 'bin'), 'packaged-resources');
}

function getStaticManagedFfmpegPaths() {
  const ffmpegPath = String(staticPair?.ffmpegPath || '').trim();
  const ffprobePath = String(staticPair?.ffprobePath || '').trim();
  if (!ffmpegPath && !ffprobePath) {
    return null;
  }
  const binDir = path.dirname(ffmpegPath || ffprobePath);
  return {
    binDir,
    ffmpegPath,
    ffprobePath,
    source: 'ffmpeg-ffprobe-static',
  };
}

function getManagedFfmpegPathCandidates() {
  const candidates = [getPackagedManagedFfmpegPaths(), getStaticManagedFfmpegPaths()].filter(Boolean);
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const key = path.resolve(candidate.binDir || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

function getMissingManagedFfmpegBinaries(paths) {
  const missing = [];
  if (!paths?.ffmpegPath || !fs.existsSync(paths.ffmpegPath)) missing.push(FFMPEG_BINARY_NAME);
  if (!paths?.ffprobePath || !fs.existsSync(paths.ffprobePath)) missing.push(FFPROBE_BINARY_NAME);
  return missing;
}

function buildManagedFfmpegMissingMessage(paths) {
  const missing = getMissingManagedFfmpegBinaries(paths);
  if (!missing.length) {
    return '';
  }
  const location = paths?.binDir ? ` in ${paths.binDir}` : '';
  return `Local AI Hub's managed FFmpeg runtime is incomplete${location}. Missing: ${missing.join(', ')}.`;
}

function resolveManagedFfmpegPaths() {
  const candidates = getManagedFfmpegPathCandidates();
  const incomplete = [];
  for (const candidate of candidates) {
    const missing = getMissingManagedFfmpegBinaries(candidate);
    if (!missing.length) {
      return {
        binDir: path.resolve(candidate.binDir),
        ffmpegPath: path.resolve(candidate.ffmpegPath),
        ffprobePath: path.resolve(candidate.ffprobePath),
        source: candidate.source,
      };
    }
    incomplete.push(buildManagedFfmpegMissingMessage(candidate));
  }

  const detail = incomplete.filter(Boolean).join(' ');
  throw new Error(detail || 'Local AI Hub could not find its managed FFmpeg and FFprobe runtime. Rebuild or reinstall the app, then try again.');
}

function prependManagedFfmpegBinToPath(env = {}, managedPaths = resolveManagedFfmpegPaths()) {
  const nextEnv = { ...env };
  const pathKey = Object.keys(nextEnv).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const existingPath = String(nextEnv[pathKey] || process.env[pathKey] || '');
  const existingEntries = existingPath.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  const normalizedBinDir = path.resolve(managedPaths.binDir).toLowerCase();
  const withoutManaged = existingEntries.filter((entry) => path.resolve(entry).toLowerCase() !== normalizedBinDir);
  nextEnv[pathKey] = [managedPaths.binDir, ...withoutManaged].join(path.delimiter);
  nextEnv.LOCALAIHUB_FFMPEG_DIR = managedPaths.binDir;
  nextEnv.FFMPEG_BINARY = managedPaths.ffmpegPath;
  nextEnv.IMAGEIO_FFMPEG_EXE = managedPaths.ffmpegPath;
  nextEnv.FFPROBE_BINARY = managedPaths.ffprobePath;
  nextEnv.LOCALAIHUB_FFPROBE_BINARY = managedPaths.ffprobePath;
  return nextEnv;
}

function firstVersionLine(output) {
  return String(output || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

async function verifyManagedFfmpegBinary(binaryPath, args = ['-version']) {
  const result = await execFileAsync(binaryPath, args, { windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024 });
  return firstVersionLine(result.stdout || result.stderr || '');
}

async function getManagedFfmpegReadiness(paths = resolveManagedFfmpegPaths()) {
  const missing = getMissingManagedFfmpegBinaries(paths);
  if (missing.length) {
    return {
      ok: false,
      paths,
      error: buildManagedFfmpegMissingMessage(paths),
      missing,
    };
  }

  try {
    const ffmpegVersion = await verifyManagedFfmpegBinary(paths.ffmpegPath);
    const ffprobeVersion = await verifyManagedFfmpegBinary(paths.ffprobePath);
    return {
      ok: true,
      paths,
      ffmpegVersion,
      ffprobeVersion,
      versions: { ffmpeg: ffmpegVersion, ffprobe: ffprobeVersion },
    };
  } catch (error) {
    return {
      ok: false,
      paths,
      error: error?.message || 'Local AI Hub could not execute its managed FFmpeg runtime.',
      missing: [],
    };
  }
}

module.exports = {
  FFMPEG_BINARY_NAME,
  FFPROBE_BINARY_NAME,
  buildManagedFfmpegMissingMessage,
  buildManagedFfmpegPathsFromBinDir,
  getManagedFfmpegReadiness,
  getMissingManagedFfmpegBinaries,
  getStaticManagedFfmpegPaths,
  prependManagedFfmpegBinToPath,
  resolveManagedFfmpegPaths,
  verifyManagedFfmpegBinary,
};
