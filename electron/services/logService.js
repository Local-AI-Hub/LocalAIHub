const path = require('path');
const fs = require('fs-extra');

const { ensureStorage, getAppPaths } = require('./configService');

function currentDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeContextValue(value) {
  if (value instanceof Error) {
    return {
      message: value.message,
      stack: value.stack,
      code: value.code,
      stdout: value.stdout,
      stderr: value.stderr,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeContextValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeContextValue(entry)]),
    );
  }

  return value;
}

function serializeContext(context) {
  if (!context || Object.keys(context).length === 0) {
    return '';
  }

  try {
    return ` ${JSON.stringify(normalizeContextValue(context))}`;
  } catch {
    return ` ${String(context)}`;
  }
}

async function getLogFilePath(scope = 'installer') {
  const { logsRoot } = await ensureStorage();
  return path.join(logsRoot, `${scope}-${currentDateStamp()}.log`);
}

async function appendLog(scope, level, message, context = {}) {
  const filePath = await getLogFilePath(scope);
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${serializeContext(context)}\n`;

  try {
    await fs.appendFile(filePath, line, 'utf8');
  } catch (error) {
    console.error('Local AI Hub could not write a log line.', error);
  }

  return filePath;
}

function createLogger(scope, baseContext = {}) {
  const write = (level, message, context = {}) =>
    appendLog(scope, level, message, {
      ...baseContext,
      ...context,
    });

  return {
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    getFilePath: () => getLogFilePath(scope),
  };
}

module.exports = {
  appendLog,
  createLogger,
  getLogFilePath,
};
