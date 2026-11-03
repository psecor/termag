/**
 * The commit this bundle was built from (vite.config.ts `define`), and the
 * beacon that tells the backend which build each user runs.
 */
import type { AxiosInstance } from 'axios';

declare const __TERMAG_SHA__: string | undefined;

export const BUILD_SHA: string = typeof __TERMAG_SHA__ === 'string' && __TERMAG_SHA__ ? __TERMAG_SHA__ : 'unknown';

export type ClientSurface = 'web' | 'mobile';

/** `mobile` on the phone client (/termag/m and paths under /termag/m/ only), else `web`. */
export function clientSurface(pathname: string): ClientSurface {
  return pathname === '/termag/m' || pathname.startsWith('/termag/m/') ? 'mobile' : 'web';
}

/** `web/<sha>`, or `mobile/<sha>` on the phone client. */
export function clientHeader(pathname: string, sha: string = BUILD_SHA): string {
  return `${clientSurface(pathname)}/${sha}`;
}

/**
 * Sends X-Termag-Client on every request of an axios instance. The backend
 * reads it for the Software tab's client versions and for the `surface` on the
 * flag context of flags read while serving the request
 * (backend services/requestSurface.ts).
 */
export function sendClientHeader(instance: AxiosInstance): void {
  instance.interceptors.request.use(config => {
    config.headers.set('X-Termag-Client', clientHeader(globalThis.location?.pathname ?? ''));
    return config;
  });
}

const BEACON_MS = 3600_000;

export function startClientBeacon(): void {
  const send = () => {
    // redirect: 'manual', as the status probe does: an edge sign-in 302 must
    // not be followed into the identity provider from a background request.
    void fetch('/termag/api/client/hello', {
      method: 'POST', credentials: 'include', redirect: 'manual',
      headers: { 'X-Termag-Client': clientHeader(window.location.pathname) },
    }).catch(() => { /* signed out or offline: nothing to record */ });
  };
  window.setTimeout(send, 5_000);
  window.setInterval(send, BEACON_MS);
}
