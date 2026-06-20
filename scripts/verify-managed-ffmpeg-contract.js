const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const {
  buildManagedFfmpegMissingMessage,
  buildManagedFfmpegPathsFromBinDir,
  getManagedFfmpegReadiness,
  getMissingManagedFfmpegBinaries,
  getStaticManagedFfmpegPaths,
  prependManagedFfmpegBinToPath,
  resolveManagedFfmpegPaths,
} = require('../electron/services/managedFfmpegService');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function pathEntries(env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  return String(env[pathKey] || '').split(path.delimiter).filter(Boolean);
}

async function verifyManagedPairReadiness() {
  const paths = resolveManagedFfmpegPaths();
  assert(/ffmpeg(?:\.exe)?$/i.test(paths.ffmpegPath), 'Managed FFmpeg resolver must return ffmpeg.exe.');
  assert(/ffprobe(?:\.exe)?$/i.test(paths.ffprobePath), 'Managed FFmpeg resolver must return ffprobe.exe.');
  assert.strictEqual(path.dirname(paths.ffmpegPath), path.dirname(paths.ffprobePath), 'Managed FFmpeg and FFprobe must live in the same bin directory.');

  const readiness = await getManagedFfmpegReadiness(paths);
  assert.strictEqual(readiness.ok, true, 'Valid managed FFmpeg and FFprobe pair should be ready.');
  assert(/ffmpeg version 6\.1\.1-essentials_build-www\.gyan\.dev/.test(readiness.ffmpegVersion), 'Managed ffmpeg.exe should report the expected gyan 6.1.1 distribution.');
  assert(/ffprobe version 6\.1\.1-essentials_build-www\.gyan\.dev/.test(readiness.ffprobeVersion), 'Managed ffprobe.exe should report the expected gyan 6.1.1 distribution.');
}

async function verifyLegacyFfmpegOnlyIsIncomplete() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'localaihub-ffmpeg-contract-'));
  try {
    const legacyBin = path.join(tempRoot, 'legacy-bin');
    const fakeSystemBin = path.join(tempRoot, 'system-bin');
    await fsp.mkdir(legacyBin, { recursive: true });
    await fsp.mkdir(fakeSystemBin, { recursive: true });
    await fsp.writeFile(path.join(legacyBin, 'ffmpeg.exe'), 'legacy ffmpeg placeholder');
    await fsp.writeFile(path.join(fakeSystemBin, 'ffprobe.exe'), 'system ffprobe placeholder');

    const legacyPaths = buildManagedFfmpegPathsFromBinDir(legacyBin, 'legacy-test');
    const missing = getMissingManagedFfmpegBinaries(legacyPaths);
    assert.deepStrictEqual(missing, ['ffprobe.exe'], 'A legacy ffmpeg-only managed runtime must report ffprobe.exe as missing.');
    assert(/ffprobe\.exe/.test(buildManagedFfmpegMissingMessage(legacyPaths)), 'Missing-binary message must identify ffprobe.exe plainly.');

    const originalPath = process.env.PATH;
    process.env.PATH = fakeSystemBin + path.delimiter + String(originalPath || '');
    try {
      const readiness = await getManagedFfmpegReadiness(legacyPaths);
      assert.strictEqual(readiness.ok, false, 'Readiness must not use PATH fallback to satisfy a missing managed ffprobe.exe.');
      assert(readiness.missing.includes('ffprobe.exe'), 'Readiness should keep reporting managed ffprobe.exe missing even when PATH has another ffprobe.exe.');
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

function verifyManagedMediaEnvironment() {
  const paths = getStaticManagedFfmpegPaths();
  assert(paths?.ffmpegPath && paths?.ffprobePath, 'Static development package must expose both ffmpegPath and ffprobePath.');
  const env = prependManagedFfmpegBinToPath({ PATH: ['C:\\Windows\\System32', paths.binDir].join(path.delimiter) }, paths);
  const entries = pathEntries(env);
  assert.strictEqual(path.resolve(entries[0]).toLowerCase(), path.resolve(paths.binDir).toLowerCase(), 'Managed FFmpeg bin directory must be first in process-scoped PATH.');
  assert.strictEqual(env.FFMPEG_BINARY, paths.ffmpegPath, 'Managed env should expose the explicit ffmpeg.exe path.');
  assert.strictEqual(env.IMAGEIO_FFMPEG_EXE, paths.ffmpegPath, 'Managed env should expose the common IMAGEIO_FFMPEG_EXE alias.');
  assert.strictEqual(env.FFPROBE_BINARY, paths.ffprobePath, 'Managed env should expose the explicit ffprobe.exe path.');
  assert.strictEqual(env.LOCALAIHUB_FFPROBE_BINARY, paths.ffprobePath, 'Managed env should expose the Local AI Hub ffprobe diagnostic alias.');
}

function verifyPackagingAndLifecycleSource() {
  const packageJson = JSON.parse(read('package.json'));
  assert.strictEqual(packageJson.version, '0.54.0', 'This pass must not bump the current development version.');
  assert.strictEqual(packageJson.dependencies['ffmpeg-ffprobe-static'], '6.1.1', 'The managed pair should use the exact paired ffmpeg-ffprobe-static package.');
  assert(packageJson.dependencies['ffmpeg-static'], 'Existing ffmpeg-static dependency should remain available for legacy verifier fixtures.');
  const resources = packageJson.build.extraResources || [];
  assert(resources.some((entry) => entry.from === 'node_modules/ffmpeg-ffprobe-static/ffmpeg.exe' && entry.to === 'bin/ffmpeg.exe'), 'Packaged resources must include managed ffmpeg.exe.');
  assert(resources.some((entry) => entry.from === 'node_modules/ffmpeg-ffprobe-static/ffprobe.exe' && entry.to === 'bin/ffprobe.exe'), 'Packaged resources must include managed ffprobe.exe.');
  assert((packageJson.build.files || []).includes('!node_modules/ffmpeg-ffprobe-static/**/*'), 'Packager should not also bundle the full ffmpeg-ffprobe-static package tree.');

  const processService = read('electron/services/processService.js');
  assert(processService.includes('resolveManagedFfmpegPaths'), 'Launch env should resolve the managed FFmpeg pair through the shared helper.');
  assert(processService.includes('managedPaths.ffprobePath'), 'Launch readiness must require managed ffprobe.exe before exposing FFmpeg to child processes.');
  assert(processService.includes('prependManagedFfmpegBinToPath'), 'Launch env should prepend the managed bin folder through the shared helper.');
  assert(processService.includes('FFPROBE_BINARY') && processService.includes('LOCALAIHUB_FFPROBE_BINARY'), 'Launch env diagnostics should whitelist FFprobe aliases.');

  const mediaComposition = read('electron/services/mediaCompositionService.js');
  assert(mediaComposition.includes('resolveManagedFfmpegPaths().ffmpegPath'), 'Media composition should use the explicit managed ffmpeg.exe path.');
  assert(mediaComposition.includes('resolveFfprobePath'), 'Media composition module should expose the managed ffprobe.exe path for future media validation.');

  const diagnostics = read('electron/services/diagnosticsService.js');
  assert(diagnostics.includes('getManagedFfmpegReadiness'), 'Diagnostics must use managed pair readiness.');
  assert(diagnostics.includes('ffprobeVersion'), 'Diagnostics should report the FFprobe version when the managed pair is ready.');

  const sourceBlob = [processService, mediaComposition, diagnostics, read('electron/services/managedFfmpegService.js')].join('\n');
  assert(!/setx\s/i.test(sourceBlob), 'Managed FFmpeg changes must not introduce global PATH mutation through setx.');
  assert(!/reg(?:\.exe)?\s+(?:add|delete)/i.test(sourceBlob), 'Managed FFmpeg changes must not introduce registry mutation.');
  assert(!/process\.env\.PATH\s*=/.test(sourceBlob), 'Managed FFmpeg launch handling must not permanently mutate process.env.PATH.');

  const installer = read('build/installer.nsh');
  assert(/customInstall/.test(installer) && /customUnInstall/.test(installer), 'Existing installer lifecycle hooks should remain present.');
}

async function main() {
  await verifyManagedPairReadiness();
  await verifyLegacyFfmpegOnlyIsIncomplete();
  verifyManagedMediaEnvironment();
  verifyPackagingAndLifecycleSource();
  console.log('Managed FFmpeg contract verifier passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
