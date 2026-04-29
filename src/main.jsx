import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

function formatRendererError(error) {
  if (!error) {
    return null;
  }

  return {
    message: String(error.message || error),
    name: String(error.name || 'Error'),
    stack: String(error.stack || ''),
  };
}

function logRendererEvent(message, context = {}, level = 'error') {
  try {
    const logger = window?.localAIHub?.logRendererEvent;
    if (typeof logger === 'function') {
      Promise.resolve(logger({ context, level, message, source: 'renderer-main' })).catch(() => {});
    }
  } catch {
    // Keep renderer diagnostics best-effort only.
  }
}

function showRendererFallback(message) {
  if (typeof window === 'undefined') {
    return;
  }

  const fallbackMessage =
    message ||
    'Close the app and reopen it. If this keeps happening, reinstall Local AI Hub with the latest installer.';

  if (typeof window.__LOCAL_AI_HUB_SHOW_FALLBACK === 'function') {
    window.__LOCAL_AI_HUB_SHOW_FALLBACK('Local AI Hub could not load its interface.', fallbackMessage);
    return;
  }

  const fallback = document.getElementById('local-ai-hub-fallback');
  if (fallback) {
    fallback.style.display = 'flex';
  }
}

class RendererErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    logRendererEvent('Renderer root render failed.', {
      componentStack: String(info?.componentStack || ''),
      error: formatRendererError(error),
      phase: 'root-boundary',
    });
    showRendererFallback();
  }

  render() {
    if (this.state.hasError) {
      return null;
    }

    return this.props.children;
  }
}

window.addEventListener('error', (event) => {
  logRendererEvent('Renderer window error.', {
    colno: Number(event?.colno || 0),
    error: formatRendererError(event?.error),
    filename: String(event?.filename || ''),
    lineno: Number(event?.lineno || 0),
    message: String(event?.message || ''),
    phase: 'window-error',
  });

  const root = document.getElementById('root');
  if (!window.__LOCAL_AI_HUB_RENDERER_READY || !root?.childElementCount) {
    showRendererFallback();
  }
});

window.addEventListener('unhandledrejection', (event) => {
  logRendererEvent('Renderer promise rejection.', {
    phase: 'unhandledrejection',
    reason: formatRendererError(event?.reason) || String(event?.reason || ''),
  });
  showRendererFallback();
});

try {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Local AI Hub could not find its root container.');
  }

  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <RendererErrorBoundary>
        <App />
      </RendererErrorBoundary>
    </React.StrictMode>,
  );

  window.requestAnimationFrame(() => {
    window.__LOCAL_AI_HUB_RENDERER_READY = true;
  });
} catch (error) {
  logRendererEvent('Renderer bootstrap failed.', {
    error: formatRendererError(error),
    phase: 'bootstrap-catch',
  });
  showRendererFallback();
}
