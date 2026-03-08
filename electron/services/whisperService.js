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

async function resolveWhisperPython(tool) {
  const candidates = [
    tool?.launchProfile?.pythonPath,
    tool?.externalPythonPath,
    tool?.managedPythonPath,
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

  await logger.info('Whisper transcription finished.', {
    audioPath,
    detectedLanguage: transcription.language || null,
  });

  return {
    audioPath,
    language: transcription.language || 'unknown',
    model: modelName,
    segments: transcription.segments || [],
    text: transcription.text,
  };
}

module.exports = {
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODEL_OPTIONS,
  transcribeWithWhisper,
};
