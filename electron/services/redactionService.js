const WINDOWS_PATH_PATTERN = /\b[a-zA-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g;
const TOKEN_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}\b/gi,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._\-+/=]{12,}\b/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"',\s]+["']?/gi,
];

function redactSensitiveText(value, options = {}) {
  if (typeof value !== 'string') {
    return value;
  }

  let nextValue = value;
  for (const pattern of TOKEN_PATTERNS) {
    nextValue = nextValue.replace(pattern, '[redacted]');
  }

  if (options.redactPaths) {
    nextValue = nextValue.replace(WINDOWS_PATH_PATTERN, 'a local path');
  }

  return nextValue;
}

function sanitizeUserMessage(rawMessage, fallback = 'Something went wrong. Please try again.') {
  const message = String(rawMessage || '').trim();
  if (!message) {
    return fallback;
  }

  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^at\s/i.test(line) && !/^traceback/i.test(line) && !/^file\s+"/i.test(line));

  if (!firstLine) {
    return fallback;
  }

  const cleaned = redactSensitiveText(firstLine.replace(/^Error:\s*/i, ''), {
    redactPaths: true,
  }).trim();

  return cleaned || fallback;
}

module.exports = {
  redactSensitiveText,
  sanitizeUserMessage,
};
