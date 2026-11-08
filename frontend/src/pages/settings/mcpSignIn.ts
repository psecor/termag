// Where the browser goes for an OAuth connector's sign-in.
// A sign-in that ends on termag's callback takes the
// Settings tab there and back, as always. A sign-in whose redirect is the
// localhost callback (a server on the user's mcp-oauth-loopback-servers list)
// opens in a new tab instead, so Settings stays open with its paste box. The
// orchestrator chooses the redirect, so the authorize URL's redirect_uri is
// what decides.

// The backend's LOOPBACK_REDIRECT_URI (services/mcpOAuthLoopback.ts).
export const LOOPBACK_REDIRECT_URI = 'http://localhost:53682/callback';

export function isLoopbackSignIn(authorizeUrl: string): boolean {
  try {
    return new URL(authorizeUrl).searchParams.get('redirect_uri') === LOOPBACK_REDIRECT_URI;
  } catch {
    return false;
  }
}

// The two parts of `window` a sign-in uses.
interface SignInWindow {
  open(url: string, target: string): { opener: unknown } | null;
  location: { assign(url: string): void };
}

/**
 * Sends the browser to `authorizeUrl`: the Settings tab itself for a normal
 * sign-in ('navigated'), a new tab for a localhost one ('opened'), or nothing
 * when the browser blocks that tab ('blocked'), for the caller to offer a
 * plain link. The tab is opened without the `noopener` feature, because with
 * it window.open answers null whether or not the tab opened; its opener is
 * cleared at once instead, so the tab can't reach this page, as with noopener.
 */
export function openSignIn(authorizeUrl: string, win: SignInWindow = window): 'navigated' | 'opened' | 'blocked' {
  if (!isLoopbackSignIn(authorizeUrl)) {
    win.location.assign(authorizeUrl);
    return 'navigated';
  }
  const tab = win.open(authorizeUrl, '_blank');
  if (!tab) return 'blocked';
  tab.opener = null;
  return 'opened';
}

/** A connector's localhost sign-in, open in another tab (or blocked from opening). */
export interface PendingSignIn {
  connectorId: string;
  authorizeUrl: string;
  // The browser refused the new tab: the box offers a plain link to it instead.
  blocked: boolean;
}

// The backend's OAUTH_STATE_TTL_MS (services/mcpConnectorStore.ts): a sign-in's
// state is good for this long, so its paste box is worth keeping as long.
export const PENDING_SIGN_IN_TTL_MS = 10 * 60_000;
const PENDING_KEY = 'termag.mcp.pendingSignIn';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const session = (): Store | null => { try { return window.sessionStorage; } catch { return null; } };

/**
 * Keeps the localhost sign-in in this tab's sessionStorage, so a reload of
 * Settings still shows its paste box (a linked server's box shows only while
 * one is pending). It holds the authorize URL, whose state and PKCE challenge
 * are useless without the person's termag sign-in.
 */
export function savePendingSignIn(p: PendingSignIn, store: Store | null = session(), now = Date.now()): void {
  try { store?.setItem(PENDING_KEY, JSON.stringify({ ...p, at: now })); } catch { /* storage full or off */ }
}

/** The sign-in savePendingSignIn kept, while its state is still good, else null. */
export function loadPendingSignIn(store: Store | null = session(), now = Date.now()): PendingSignIn | null {
  try {
    const v = JSON.parse(store?.getItem(PENDING_KEY) ?? 'null') as Partial<PendingSignIn & { at: number }> | null;
    if (!v || typeof v.connectorId !== 'string' || typeof v.authorizeUrl !== 'string' || typeof v.at !== 'number') return null;
    if (now - v.at > PENDING_SIGN_IN_TTL_MS || now < v.at) { store?.removeItem(PENDING_KEY); return null; }
    return { connectorId: v.connectorId, authorizeUrl: v.authorizeUrl, blocked: v.blocked === true };
  } catch {
    return null;
  }
}

export function clearPendingSignIn(store: Store | null = session()): void {
  try { store?.removeItem(PENDING_KEY); } catch { /* storage off */ }
}
