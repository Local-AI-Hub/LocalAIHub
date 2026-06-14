const WINDOWS_PATH_PATTERN = /\b[a-zA-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g;
const POSIX_USER_PATH_PATTERN = /\/(?:Users|home)\/[^/\s]+(?:\/[^\s"'<>|]*)?/g;
const REDACTION_PLACEHOLDER = '[redacted]';
const TOKEN_PATTERNS = [
  /\b(?:sk|gsk|xai)-[A-Za-z0-9_*.-]{10,}\b/g,
  /\bgsk_[A-Za-z0-9_*.-]{10,}\b/g,
  /\bAIza[0-9A-Za-z\-_*]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}\b/gi,
  /\bAuthorization\s*:\s*(?:Bearer\s+)?[A-Za-z0-9._\-+/=]{8,}/gi,
  /([?&](?:api[_-]?key|access[_-]?token|token|secret|key)=)([^&#\s]+)/gi,
  /(["']?(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|api[_-]?key|access[_-]?token|token|secret|password)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
  /\b[A-Za-z0-9_\-]{32,}\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/g,
  /\b(?=[A-Za-z0-9_./+=-]{40,}\b)(?=[A-Za-z0-9_./+=-]*[A-Za-z])(?=[A-Za-z0-9_./+=-]*\d)[A-Za-z0-9_./+=-]+\b/g,
];
const SENSITIVE_ENV_NAME_PATTERN = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)$/i;
const SENSITIVE_KEY_PATTERN = /(?:authorization|api[_-]?key|access[_-]?token|token|secret|password|pat)$/i;

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

    return current.replace(new RegExp(escapeRegExp(normalizedSecret), 'g'), REDACTION_PLACEHOLDER);
  }, text);
}

function normalizePathMappings(options = {}) {
  const mappings = [];
  const push = (targetPath, placeholder) => {
    const normalized = String(targetPath || '').trim().replace(/[\\/]+$/, '');
    if (normalized) mappings.push({ targetPath: normalized, placeholder });
  };

  push(options.homePath || process.env.USERPROFILE || process.env.HOME, '%USERPROFILE%');
  push(options.managedRoot, '<managed-root>');
  for (const entry of options.additionalPaths || []) {
    if (typeof entry === 'string') push(entry, '<local-path>');
    else push(entry?.path, entry?.placeholder || '<local-path>');
  }

  return mappings.sort((left, right) => right.targetPath.length - left.targetPath.length);
}

function redactLocalPaths(value, options = {}) {
  let text = String(value || '');
  for (const mapping of normalizePathMappings(options)) {
    text = text.replace(new RegExp(escapeRegExp(mapping.targetPath), 'gi'), mapping.placeholder);
  }

  if (options.redactPaths) {
    text = text.replace(WINDOWS_PATH_PATTERN, '<local-path>');
    text = text.replace(POSIX_USER_PATH_PATTERN, '%USERPROFILE%');
  }
  return text;
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
    nextValue = nextValue.replace(pattern, (...args) => {
      const match = args[0];
      const prefix = args[1];
      return typeof prefix === 'string' && match.startsWith(prefix)
        ? `${prefix}${REDACTION_PLACEHOLDER}`
        : REDACTION_PLACEHOLDER;
    });
  }

  return redactLocalPaths(nextValue, options);
}

function redactDiagnosticValue(value, options = {}, seen = new WeakSet()) {
  if (typeof value === 'string') return redactSensitiveText(value, { ...options, redactPaths: true });
  if (Array.isArray(value)) return value.map((entry) => redactDiagnosticValue(entry, options, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTION_PLACEHOLDER
      : redactDiagnosticValue(entry, options, seen);
  }
  return result;
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
  REDACTION_PLACEHOLDER,
  redactDiagnosticValue,
  redactLocalPaths,
  redactSensitiveText,
  sanitizeUserMessage,
};
