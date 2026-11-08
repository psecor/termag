/**
 * When the session's user last signed in to termag, as opposed to when the
 * session was last used: express-session's cookie rolls on every request, so
 * a session can outlive its sign-in by 90 days. Stamped on every sign-in
 * (routes/auth.ts). Preview links require a sign-in from the last 12 hours in
 * `google` and `oidc` mode (SR18),
 * where the landing page's check otherwise never goes back to the identity
 * provider; `okta` mode goes back through the ALB's Okta action anyway.
 */
import type { Session, SessionData } from 'express-session';

declare module 'express-session' {
  interface SessionData {
    /** ms since the epoch of this session's last sign-in. Missing on sessions from before it was kept. */
    authenticatedAt?: number;
  }
}

/** The sign-in a preview session may stand on, in google and oidc mode. */
export const PREVIEW_SIGN_IN_MAX_MS = 12 * 3600_000;

type MaybeSession = (Session & Partial<SessionData>) | undefined;

/** Record a sign-in on the (regenerated) session. */
export function markSignedIn(session: MaybeSession, now: number = Date.now()): void {
  if (session) session.authenticatedAt = now;
}

/** Whether the session's sign-in is at most `maxMs` old. A session with no record of one is not. */
export function signedInWithin(session: MaybeSession, maxMs: number, now: number = Date.now()): boolean {
  const at = session?.authenticatedAt;
  return typeof at === 'number' && Number.isFinite(at) && at <= now && now - at <= maxMs;
}
