/**
 * The browser session cookie.
 *
 * In production it is `__Host-termag.sid`: Secure, `Path=/`, no `Domain`. The
 * browser only accepts a `__Host-` cookie set that way by this host itself,
 * so no other `example.com` host can toss one at termag, the way a sibling
 * could set `termag.sid` for `.example.com` on `Path=/termag/api` and have it
 * sent ahead of the real one (session fixation in `google` and `oidc` mode).
 * Every cookie termag sets has the prefix; sessionCookie.test.ts fails on one
 * that doesn't.
 *
 * `Path=/` means the browser also sends it to the hosted apps on this host
 * (docs/hosted-apps.md); nginx drops it from their requests
 * (`$termag_upstream_cookie`, deploy/nginx/termag-gateway.conf).
 *
 * Off production (`npm run dev`, the e2e stack, stage) termag is plain http,
 * where a `__Host-` cookie can't exist: it must be Secure, express-session
 * won't send a Secure cookie on a request that isn't https, and browsers and
 * curl won't keep one from http. There it stays `termag.sid` on `/termag`,
 * not Secure, as before.
 *
 * The rename signed everyone out once. The old cookie is not accepted, since
 * accepting it is what a tossed one would ride; clearLegacySessionCookie
 * expires it when a browser still sends it.
 */
import type { RequestHandler } from 'express';
import type { SessionOptions } from 'express-session';

export const SESSION_COOKIE = '__Host-termag.sid';
/** The name before the prefix, and still the name off production. */
export const LEGACY_SESSION_COOKIE = 'termag.sid';
export const LEGACY_SESSION_COOKIE_PATH = '/termag';

const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** The cookie half of the session middleware's options. */
export function sessionCookieOptions(production: boolean): Required<Pick<SessionOptions, 'name' | 'cookie'>> {
  const shared = { httpOnly: true, sameSite: 'lax' as const, maxAge: MAX_AGE_MS };
  return production
    ? { name: SESSION_COOKIE, cookie: { ...shared, path: '/', secure: true } }
    : { name: LEGACY_SESSION_COOKIE, cookie: { ...shared, path: LEGACY_SESSION_COOKIE_PATH, secure: false } };
}

const LEGACY_IN_HEADER = /(?:^|;\s*)termag\.sid=/;

/**
 * Production only: expire a `termag.sid` the browser still sends, so it
 * stops riding along for the rest of its 90 days. Appends a Set-Cookie line,
 * as express-session does, so the session's own cookie still goes out.
 */
export const clearLegacySessionCookie: RequestHandler = (req, res, next) => {
  if (LEGACY_IN_HEADER.test(req.headers.cookie ?? '')) {
    res.clearCookie(LEGACY_SESSION_COOKIE, { path: LEGACY_SESSION_COOKIE_PATH, httpOnly: true, secure: true, sameSite: 'lax' });
  }
  next();
};
