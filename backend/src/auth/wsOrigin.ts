// Cross-origin guard for the WebSocket upgrade handshake.
//
// The terminal (`/ws/terminal`) and status (`/ws/status`) sockets authenticate
// from the browser's ambient `termag.sid` session cookie. That cookie is
// `SameSite=Lax` and host-only, so a page on ANOTHER same-site origin (any
// `*.example.com` host — a Spinnaker deploy box, a hosted sub-app, anything)
// can open a WebSocket to the orchestrator and the browser will attach the
// cookie, handing that page a live terminal as the victim. CORS does not cover
// WebSockets and `handleUpgrade` did no origin check, so nothing stopped it.
//
// A browser ALWAYS sends an `Origin` header on a WebSocket handshake; the
// per-user agent (a Node `ws` client, authenticated by bearer token) sends
// none. So the rule is: reject an upgrade whose Origin is present but not
// allowlisted, and let an Origin-less upgrade through to its own auth. A
// non-browser client can't ride the victim's cookie anyway (it has no way to
// obtain it cross-site), so it needs no Origin check here.

/**
 * Origins allowed to open a browser WebSocket. The app is served same-origin as
 * its API, so a genuine handshake's Origin is the origin of `FRONTEND_URL`
 * (`https://app.termag.example.com` in production, the Vite dev server in
 * development). `ALLOWED_WS_ORIGINS` (comma-separated) adds any extra hosts the
 * UI is legitimately served from.
 */
export function allowedWsOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>();
  for (const raw of (env.ALLOWED_WS_ORIGINS ?? '').split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // Ignore a malformed entry rather than failing every upgrade.
    }
  }
  try {
    origins.add(new URL(env.FRONTEND_URL ?? 'http://localhost:5173').origin);
  } catch {
    // FRONTEND_URL unparseable: fall back to the dev default so local dev works.
    origins.add('http://localhost:5173');
  }
  return origins;
}

/**
 * Whether a WebSocket upgrade with this `Origin` header may proceed. `undefined`
 * (no header, i.e. a non-browser client such as the agent) passes; a present
 * Origin must be allowlisted. Comparison is against the normalized origin
 * (`scheme://host[:port]`), which is exactly the shape a browser sends.
 */
export function isAllowedUpgradeOrigin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (origin === undefined) return true;
  return allowedWsOrigins(env).has(origin);
}
