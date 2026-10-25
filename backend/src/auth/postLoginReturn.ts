/**
 * Where a browser goes after signing in, when the sign-in interrupted
 * `termag login`, a space file link or a preview share link:
 * /auth/cli/authorize, /files/<space>/<path> (routes/spaceFiles.ts) and
 * /p/<key> (routes/previewShares.ts) stash their own URL in the session and
 * send the browser to /auth/login; every sign-in success handler then
 * returns there instead of the app root.
 *
 * Only those three kinds of URL under this BASE_PATH are ever stashed or
 * followed, so the stash can't be turned into an open redirect. It is read
 * before req.login, because passport regenerates the session on login.
 */
import type { Session, SessionData } from 'express-session';

declare module 'express-session' {
  interface SessionData {
    /** A pending /auth/cli/authorize, /files/ or /p/ URL (path + query), see auth/postLoginReturn.ts. */
    postLoginReturnTo?: string;
  }
}

const AUTHORIZE_PATH = '/auth/cli/authorize';
const FILE_LINK_PATH = '/files/';
const PREVIEW_LINK_PATH = '/p/';

/** The URL parsed against a placeholder origin, or null if it is not a plain same-origin path. */
function parsePath(url: unknown): URL | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  if (/[\\\s]/.test(url)) return null;
  let parsed: URL;
  try { parsed = new URL(url, 'http://termag.invalid'); } catch { return null; }
  return parsed.origin === 'http://termag.invalid' ? parsed : null;
}

/** The path + query to return to, or null unless it is this server's CLI approval page. */
export function cliReturnPath(basePath: string, url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(`${basePath}${AUTHORIZE_PATH}?`)) return null;
  const parsed = parsePath(url);
  if (!parsed || parsed.pathname !== `${basePath}${AUTHORIZE_PATH}`) return null;
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * The path + query to return to, or null unless it is a space file link on
 * this server, exactly as sent: a URL the parser would rewrite (dot segments)
 * is refused rather than followed somewhere else.
 */
export function fileLinkReturnPath(basePath: string, url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(`${basePath}${FILE_LINK_PATH}`)) return null;
  const parsed = parsePath(url);
  if (!parsed || !parsed.pathname.startsWith(`${basePath}${FILE_LINK_PATH}`)) return null;
  const path = `${parsed.pathname}${parsed.search}`;
  return path === url ? path : null;
}

/**
 * The path + query to return to, or null unless it is a preview share link on
 * this server, `/p/<key>` with nothing after the key but a query, exactly as
 * sent.
 */
export function previewLinkReturnPath(basePath: string, url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(`${basePath}${PREVIEW_LINK_PATH}`)) return null;
  const parsed = parsePath(url);
  if (!parsed || !/^\/p\/[a-z0-9]{1,64}$/.test(parsed.pathname.slice(basePath.length))) return null;
  const path = `${parsed.pathname}${parsed.search}`;
  return path === url ? path : null;
}

function returnPath(basePath: string, url: unknown): string | null {
  return cliReturnPath(basePath, url) ?? fileLinkReturnPath(basePath, url) ?? previewLinkReturnPath(basePath, url);
}

type MaybeSession = (Session & Partial<SessionData>) | undefined;

export function stashPostLoginReturn(session: MaybeSession, basePath: string, url: string): boolean {
  const path = returnPath(basePath, url);
  if (!session || !path) return false;
  session.postLoginReturnTo = path;
  return true;
}

/** Pops the stash: the absolute URL to redirect to after sign-in. */
export function takePostLoginRedirect(session: MaybeSession, basePath: string, frontendUrl: string): string {
  const pending = session?.postLoginReturnTo;
  if (session) delete session.postLoginReturnTo;
  const path = returnPath(basePath, pending);
  return path ? `${frontendUrl}${path}` : `${frontendUrl}${basePath}/`;
}
