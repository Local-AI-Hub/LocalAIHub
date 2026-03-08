import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

window.__NESTAI_RENDERER_READY = true;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
