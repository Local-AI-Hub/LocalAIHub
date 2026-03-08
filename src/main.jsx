import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

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

window.addEventListener('error', () => {
  const root = document.getElementById('root');
  if (!window.__LOCAL_AI_HUB_RENDERER_READY || !root?.childElementCount) {
    showRendererFallback();
  }
});

window.addEventListener('unhandledrejection', () => {
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
      <App />
    </React.StrictMode>,
  );

  window.requestAnimationFrame(() => {
    window.__LOCAL_AI_HUB_RENDERER_READY = true;
  });
} catch {
  showRendererFallback();
}
