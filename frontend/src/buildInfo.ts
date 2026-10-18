/**
 * The commit this bundle was built from (vite.config.ts `define`), and the
 * beacon that tells the backend which build each user runs.
 */
declare const __TERMAG_SHA__: string | undefined;

export const BUILD_SHA: string = typeof __TERMAG_SHA__ === 'string' && __TERMAG_SHA__ ? __TERMAG_SHA__ : 'unknown';

/** `web/<sha>`, or `mobile/<sha>` on the phone client: /termag/m and paths under /termag/m/ only. */
export function clientHeader(pathname: string, sha: string = BUILD_SHA): string {
  const mobile = pathname === '/termag/m' || pathname.startsWith('/termag/m/');
  return `${mobile ? 'mobile' : 'web'}/${sha}`;
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
