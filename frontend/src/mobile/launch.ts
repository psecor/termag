// A home-screen shortcut or a share into the installed app while it is already
// open. The manifest's launch_handler (focus-existing)
// brings that window to the front on Chromium without navigating it; the URL
// arrives through window.launchQueue instead, and this routes it in place, so
// the open page keeps its state. Other browsers have no launchQueue.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

interface LaunchParams { targetURL?: string | null }
interface LaunchQueue { setConsumer(consumer: (params: LaunchParams) => void): void }

/**
 * The router path a launch asks for (BrowserRouter's basename is /termag), or
 * null to stay put: no URL, another origin, outside the app, or the page
 * already showing it (the first launch of a window names the page it loads).
 */
export function launchPath(
  targetURL: string | null | undefined,
  here: { origin: string; pathname: string; search: string },
): string | null {
  if (!targetURL) return null;
  let target: URL;
  try { target = new URL(targetURL); } catch { return null; }
  if (target.origin !== here.origin || !target.pathname.startsWith('/termag/')) return null;
  if (target.pathname === here.pathname && target.search === here.search) return null;
  return `${target.pathname.slice('/termag'.length)}${target.search}`;
}

// The URL this window loaded, before any in-app redirect (to /login, say).
const loadedUrl = typeof window === 'undefined' ? '' : window.location.href;

export function useLaunchQueue(): void {
  const navigate = useNavigate();
  const latest = useRef(navigate);
  latest.current = navigate;
  useEffect(() => {
    const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
    let first = true;
    queue?.setConsumer(params => {
      // A window's first launch names the page it loaded; the app has taken it from there.
      const loaded = first && params.targetURL === loadedUrl;
      first = false;
      const path = loaded ? null : launchPath(params.targetURL, window.location);
      if (path) latest.current(path);
    });
  }, []);
}
