const path = require('path');
const fs = require('fs-extra');
const { app } = require('electron');

const { runCommand } = require('./commandService');
const { createLogger } = require('./logService');

const DEFAULT_WHISPER_MODEL = 'base';
const WHISPER_MODEL_OPTIONS = ['tiny', 'base', 'small', 'medium', 'large-v3'];

function getWhisperHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'helpers', 'transcribe_whisper.py')
    : path.join(__dirname, '..', 'helpers', 'transcribe_whisper.py');
}

function parseJsonLine(stdout) {
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

function resolveWhisperModelName(value) {
  const modelName = String(value || DEFAULT_WHISPER_MODEL).trim().toLowerCase();
  return WHISPER_MODEL_OPTIONS.includes(modelName) ? modelName : DEFAULT_WHISPER_MODEL;
}

function normalizeWhisperError(error) {
  const message = String(error?.message || '').trim();
  const normalized = message.toLowerCase();

  if (normalized.includes("no module named 'av'") || /no module named ['\"]av['\"]/.test(normalized)) {
    return new Error('Whisper is missing its bundled audio decoder. Repair or reinstall Whisper and try again.');
  }

  if (normalized.includes("no module named 'faster_whisper'") || /no module named ['\"]faster_whisper['\"]/.test(normalized)) {
    return new Error('Whisper is missing the faster-whisper package. Repair or reinstall Whisper and try again.');
  }

  if (normalized.includes('cublas64_') || normalized.includes('cudnn')) {
    return new Error('Whisper could not use NVIDIA acceleration because Windows is missing the CUDA libraries it needs. Repair or reinstall Whisper and try again.');
  }

  return error instanceof Error ? error : new Error(message || 'Local AI Hub could not transcribe that audio file with Whisper.');
}

async function resolveWhisperPython(tool) {
  const candidates = [
    tool?.launchProfile?.pythonPath,
    tool?.externalPythonPath,
    tool?.managedPythonPath,
    tool?.pythonBootstrapPath,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (!path.isAbsolute(candidate)) {
      return candidate;
    }

    if (await fs.pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error('Local AI Hub could not find Whisper\'s Python environment. Reinstall or repair Whisper and try again.');
}

async function transcribeWithWhisper(tool, payload = {}) {
  if (!tool) {
    throw new Error('Install Whisper before starting local transcription.');
  }

  const logger = createLogger('whisper', {
    toolId: tool?.id || 'whisper',
    model: resolveWhisperModelName(payload.model),
  });
  const audioPath = path.resolve(String(payload.audioPath || '').trim());
  if (!audioPath || !(await fs.pathExists(audioPath))) {
    throw new Error('Choose an audio file before starting transcription.');
  }

  const helperPath = getWhisperHelperPath();
  if (!(await fs.pathExists(helperPath))) {
    throw new Error('Local AI Hub is missing its Whisper helper script. Reinstall the app to restore it.');
  }

  const pythonPath = await resolveWhisperPython(tool);
  const modelName = resolveWhisperModelName(payload.model);
  const cacheDir = path.join(tool?.installDir || path.dirname(audioPath), 'models');
  await fs.ensureDir(cacheDir);

  await logger.info('Starting Whisper transcription.', {
    audioPath,
    cacheDir,
    helperPath,
    pythonPath,
  });

  try {
    const result = await runCommand(
      pythonPath,
      [helperPath, audioPath, modelName, cacheDir],
      {
        cwd: tool?.appDir || tool?.installDir || path.dirname(audioPath),
        env: {
          HF_HOME: cacheDir,
          TRANSFORMERS_CACHE: cacheDir,
        },
        errorMessage: 'Local AI Hub could not transcribe that audio file with Whisper.',
      },
    );

    const transcription = parseJsonLine(result.stdout);
    if (!transcription?.text) {
      throw new Error('Whisper finished, but it did not return any transcript text.');
    }

    if (String(transcription.runtimeNote || '').trim()) {
      await logger.warn('Whisper transcription switched runtimes.', {
        audioPath,
        runtimeNote: transcription.runtimeNote,
      });
    }

    await logger.info('Whisper transcription finished.', {
      audioPath,
      computeType: transcription.computeType || null,
      detectedLanguage: transcription.language || null,
      device: transcription.device || null,
      durationSeconds: transcription.durationSeconds || null,
      runtimeNote: transcription.runtimeNote || null,
    });

    return {
      audioPath,
      computeType: String(transcription.computeType || '').trim(),
      device: String(transcription.device || '').trim(),
      durationSeconds: Number.isFinite(Number(transcription.durationSeconds)) && Number(transcription.durationSeconds) > 0
        ? Math.round(Number(transcription.durationSeconds) * 100) / 100
        : null,
      language: transcription.language || 'unknown',
      model: modelName,
      runtimeNote: String(transcription.runtimeNote || '').trim(),
      segments: transcription.segments || [],
      text: transcription.text,
    };
  } catch (error) {
    const normalizedError = normalizeWhisperError(error);
    await logger.error('Whisper transcription failed.', {
      audioPath,
      error,
      normalizedMessage: normalizedError.message,
    });
    throw normalizedError;
  }
}

module.exports = {
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODEL_OPTIONS,
  transcribeWithWhisper,
};
