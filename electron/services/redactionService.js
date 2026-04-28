const WINDOWS_PATH_PATTERN = /\b[a-zA-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g;
const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_*.-]{10,}\b/g,
  /\bAIza[0-9A-Za-z\-_*]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}\b/gi,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._\-+/=]{12,}\b/gi,
  /[?&](?:api[_-]?key|access[_-]?token|token|secret)=([^&#\s]+)/gi,
  /["']?(?:authorization|x-api-key|x-goog-api-key|api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?[^"',\s}]+["']?/gi,
  /\b[A-Za-z0-9_\-]{32,}\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/g,
];
const SENSITIVE_ENV_NAME_PATTERN = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)$/i;

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
}

function collectSensitiveEnvironmentValues() {
  return Object.entries(process.env || {})
    .filter(([key, value]) => SENSITIVE_ENV_NAME_PATTERN.test(key) && String(value || '').trim().length >= 8)
    .map(([, value]) => String(value || '').trim());
}

function redactExactSecretValues(text, values = []) {
  return values.reduce((current, secret) => {
    const normalizedSecret = String(secret || '').trim();
    if (normalizedSecret.length < 8) {
      return current;
    }

    return current.replace(new RegExp(escapeRegExp(normalizedSecret), 'g'), '[redacted]');
  }, text);
}

function redactSensitiveText(value, options = {}) {
  if (typeof value !== 'string') {
    return value;
  }

  let nextValue = redactExactSecretValues(value, [
    ...(Array.isArray(options.additionalSecrets) ? options.additionalSecrets : []),
    ...collectSensitiveEnvironmentValues(),
  ]);
  for (const pattern of TOKEN_PATTERNS) {
    nextValue = nextValue.replace(pattern, (match) => (match.startsWith('?') || match.startsWith('&') ? match[0] + '[redacted]' : '[redacted]'));
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
