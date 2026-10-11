/**
 * Where a browser goes after signing in, when the sign-in interrupted
 * `termag login`: /auth/cli/authorize stashes its own URL in the session and
 * sends the browser to /auth/login; every sign-in success handler then
 * returns there instead of the app root.
 *
 * Only a /auth/cli/authorize URL under this BASE_PATH is ever stashed or
 * followed, so the stash can't be turned into an open redirect. It is read
 * before req.login, because passport regenerates the session on login.
 */
import type { Session, SessionData } from 'express-session';

declare module 'express-session' {
  interface SessionData {
    /** A pending /auth/cli/authorize URL (path + query), see auth/postLoginReturn.ts. */
    postLoginReturnTo?: string;
  }
}

const AUTHORIZE_PATH = '/auth/cli/authorize';

/** The path + query to return to, or null unless it is this server's CLI approval page. */
export function cliReturnPath(basePath: string, url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  if (!url.startsWith(`${basePath}${AUTHORIZE_PATH}?`)) return null;
  if (/[\\\s]/.test(url)) return null;
  let parsed: URL;
  try { parsed = new URL(url, 'http://termag.invalid'); } catch { return null; }
  if (parsed.origin !== 'http://termag.invalid' || parsed.pathname !== `${basePath}${AUTHORIZE_PATH}`) return null;
  return `${parsed.pathname}${parsed.search}`;
}

type MaybeSession = (Session & Partial<SessionData>) | undefined;

export function stashPostLoginReturn(session: MaybeSession, basePath: string, url: string): boolean {
  const path = cliReturnPath(basePath, url);
  if (!session || !path) return false;
  session.postLoginReturnTo = path;
  return true;
}

/** Pops the stash: the absolute URL to redirect to after sign-in. */
export function takePostLoginRedirect(session: MaybeSession, basePath: string, frontendUrl: string): string {
  const pending = session?.postLoginReturnTo;
  if (session) delete session.postLoginReturnTo;
  const path = cliReturnPath(basePath, pending);
  return path ? `${frontendUrl}${path}` : `${frontendUrl}${basePath}/`;
}
