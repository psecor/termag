import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { shouldReloadForStaleChunk } from './utils/staleChunk';
import './App.css';

// A lazy route's chunk failed to load: the orchestrator rolled to a new build
// while this page was open and the old chunk names are gone (utils/staleChunk.ts).
// Reload once to pick up the new page; otherwise let the error reach the
// boundary, which explains and offers Reload.
window.addEventListener('vite:preloadError', (e) => {
  if (shouldReloadForStaleChunk(window.sessionStorage, Date.now())) {
    e.preventDefault();
    window.location.reload();
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename="/termag">
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
