import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { shouldReloadForStaleChunk } from './utils/staleChunk';
import { startClientBeacon } from './buildInfo';
// Starts listening for beforeinstallprompt before the lazy /m chunk loads (mobile/install.ts).
import './mobile/install';
import { NAVIGATE_EVENT } from './mobile/push';
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

// Tell the backend which build this browser runs.
startClientBeacon();
// A notification click (public/sw.js) asks the open window to show a page.
// The phone client routes it in place (MobileApp listens for the event and
// cancels it); any other page, which has no such listener, just loads the URL.
navigator.serviceWorker?.addEventListener('message', (e) => {
  const data = e.data as { type?: string; url?: string } | null;
  if (data?.type !== 'termag:navigate' || typeof data.url !== 'string') return;
  let target: URL;
  try { target = new URL(data.url, window.location.origin); } catch { return; }
  if (target.origin !== window.location.origin || !target.pathname.startsWith('/termag/')) return;
  const routed = !window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: target, cancelable: true }));
  if (!routed) window.location.assign(target.href);
});
// addEventListener alone leaves the client message queue closed in WebKit
// (only onmessage or startMessages() opens it), so messages never arrive.
navigator.serviceWorker?.startMessages();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename="/termag">
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
