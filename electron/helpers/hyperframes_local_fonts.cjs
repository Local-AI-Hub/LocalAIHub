// The managed compiler uses global fetch for optional Google Fonts lookups.
const originalFetch = globalThis.fetch;
globalThis.fetch = function fetchWithLocalFonts(input, ...options) {
  const value = typeof input === 'string' || input instanceof URL ? input : input?.url;
  const url = URL.canParse(value) ? new URL(value) : null;
  if (url && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
    return Promise.resolve(new Response(null, { status: 404, statusText: 'Local fonts only' }));
  }
  return originalFetch.call(this, input, ...options);
};
