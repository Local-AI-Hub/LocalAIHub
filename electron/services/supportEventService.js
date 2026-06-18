const { redactSensitiveText, sanitizeUserMessage } = require('./redactionService');

const MAX_SUPPORT_EVENTS = 50;
const SUPPORT_GUIDANCE_TEXT = 'Create a diagnostics bundle from Settings -> Support and Diagnostics, review it, then attach it to a GitHub issue if you want help troubleshooting. Use Copy system info too, and do not share secrets, provider keys, PATs, model files, or private media.';
const MEDIA_OR_MODEL_FILENAME_PATTERN = /\b[^\s\\/:*?"<>|]{1,120}\.(?:png|jpe?g|gif|webp|bmp|tiff?|mp[34]|mkv|mov|avi|webm|wav|mp3|flac|ogg|safetensors|ckpt|pt|pth|gguf|onnx|bin)\b/gi;
const recentSupportEvents = [];

function normalizeEventText(value, fallback = 'The operation failed.') {
  const message = sanitizeUserMessage(
    redactSensitiveText(String(value || ''), { redactPaths: true }),
    fallback,
  );
  return message.replace(MEDIA_OR_MODEL_FILENAME_PATTERN, '<private-file>').slice(0, 500);
}

function categorizeSupportError(error, operation = '') {
  const code = String(error?.code || error?.name || '').trim().toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  const combined = `${code} ${operation} ${message}`;

  if (/cancel/.test(combined)) return 'cancelled';
  if (/integrity|checksum|sha-?256|expected .*received|partial file/.test(combined)) return 'integrity';
  if (/preflight|free space|disk|drive|storage/.test(combined)) return 'preflight';
  if (/cuda|pytorch|torch|nvidia|gpu|vram/.test(combined)) return 'runtime-gpu';
  if (/python|pip|venv|module|dependency|package/.test(combined)) return 'runtime-dependency';
  if (/download|pull|network|timeout|connection|http|server/.test(combined)) return 'download';
  if (/readiness|ready|answer|local port|health/.test(combined)) return 'readiness';
  if (/install|installer|repair/.test(combined)) return 'install-repair';
  return 'unknown';
}

function normalizeSupportEvent(event = {}) {
  const operation = String(event.operation || event.operationCategory || '').trim().toLowerCase() || 'unknown';
  return {
    timestamp: event.timestamp || new Date().toISOString(),
    area: String(event.area || 'app').trim().toLowerCase(),
    toolId: String(event.toolId || '').trim().toLowerCase(),
    operation,
    category: String(event.category || categorizeSupportError(event.error, operation)).trim().toLowerCase(),
    message: normalizeEventText(event.message || event.error?.message || event.error, 'The operation failed.'),
  };
}

function recordSupportEvent(event = {}) {
  const normalized = normalizeSupportEvent(event);
  recentSupportEvents.unshift(normalized);
  if (recentSupportEvents.length > MAX_SUPPORT_EVENTS) {
    recentSupportEvents.length = MAX_SUPPORT_EVENTS;
  }
  return normalized;
}

function getRecentSupportEvents(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 20) || 20, MAX_SUPPORT_EVENTS));
  return recentSupportEvents.slice(0, limit).map((event) => ({ ...event }));
}

function appendSupportGuidance(message) {
  const base = normalizeEventText(message, 'The operation failed.');
  if (/Support and Diagnostics/i.test(base)) {
    return base;
  }
  return `${base} ${SUPPORT_GUIDANCE_TEXT}`;
}

module.exports = {
  MAX_SUPPORT_EVENTS,
  SUPPORT_GUIDANCE_TEXT,
  appendSupportGuidance,
  categorizeSupportError,
  getRecentSupportEvents,
  recordSupportEvent,
};
