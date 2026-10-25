// Browser pane connection policy: when a dropped
// socket is retried, how long to wait, and when the pane should ask the box
// which apps are listening. Pure, so it is tested without a socket.
import { BROWSER_PANE_CLOSE } from './browserPaneInput';

/**
 * Close codes that end the pane: a retry would get the same answer. An agent
 * that is not connected is not among them (the backend closes 1013 for that):
 * it reconnects within seconds and may still hold the parked browser.
 */
const FINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  BROWSER_PANE_CLOSE.DISABLED,
  BROWSER_PANE_CLOSE.UNSUPPORTED,
  BROWSER_PANE_CLOSE.PARKED,
  // A guest's refusals the page shows; a busy box (GUEST_BUSY) redials instead.
  BROWSER_PANE_CLOSE.GUEST_REFUSED,
  BROWSER_PANE_CLOSE.GUEST_STACK,
  BROWSER_PANE_CLOSE.GUEST_UNSAFE,
  1008, // refused: login, project, share, setup, a bad request; a kept browser taken over by another tab
]);

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 15_000;

/**
 * Whether a close is worth redialing. A refusal is final; anything else (the
 * socket dropped, the browser exited, a proxy gave up) is retried, and the
 * agent keeps the browser parked for a minute so the retry lands on the same
 * page.
 */
export function isFinalClose(code: number): boolean {
  return FINAL_CLOSE_CODES.has(code);
}

/** 1s, 2s, 4s, 8s, then 15s between attempts. */
export function reconnectDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** n);
}

/** A pane with nothing to show yet asks the box what is listening. */
export function isBlankUrl(url: string | null | undefined): boolean {
  const s = (url ?? '').trim();
  return s === '' || s === 'about:blank';
}

export interface Suggestion { url: string; title: string; status?: number }

/** The suggestion to open on a blank pane: the agent ranks them, the first wins; none when the list is empty. */
export function suggestionToOpen(items: readonly Suggestion[]): Suggestion | null {
  return items.length > 0 ? items[0] : null;
}

/** What a chip shows: the title, with the host and port for context when there is one; else the URL without its scheme. */
export function suggestionLabel(item: Suggestion): string {
  const bare = item.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return item.title ? `${item.title} · ${bare}` : bare;
}

/** Who a pane is for: the project's owner or collaborator, or a reviewer on a preview share. */
export type BrowserPaneTarget =
  | { mode: 'owner'; projectId: string; workstream: string; openShare?: BrowserShareHandoff | null }
  | { mode: 'guest'; shareId: string; at?: string | null; asGuest?: boolean };

/** The browser socket's query for a pane: the project and workstream, or the share, plus the URL and size. */
export function browserSocketParams(target: BrowserPaneTarget, url: string, size: { width: number; height: number }): string {
  const p = new URLSearchParams();
  if (target.mode === 'owner') {
    p.set('projectId', target.projectId);
    p.set('workstream', target.workstream);
    if (target.openShare) {
      p.set('openShare', target.openShare.shareId);
      if (target.openShare.at) p.set('at', target.openShare.at);
    }
  } else {
    p.set('share', target.shareId);
    if (target.at) p.set('at', target.at);
    if (target.asGuest) p.set('as', 'guest');
  }
  p.set('url', url);
  // This pane shows a page's alert, confirm and prompt for the viewer to answer
  // (an older backend or agent answers them itself, as before).
  p.set('dialogs', '1');
  p.set('width', String(size.width));
  p.set('height', String(size.height));
  return p.toString();
}

/**
 * A share link's `at` (and the workspace's `browserAt`): a path only, one
 * leading `/`, never `//` or `/\`, no backslash or control character, decoded
 * or not. Null for anything else. The backend and the agent check it again.
 */
export function safeAtPath(at: string | null | undefined): string | null {
  if (typeof at !== 'string' || !at || at.length > 2048) return null;
  if (!/^\/(?![/\\])/.test(at)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(at)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(at); } catch { return null; }
  return /^\/[/\\]/.test(decoded) ? null : at;
}

/**
 * The share link's handoff to the owner's own pane (backend
 * routes/previewShares.ts): `?browser=open&browserShare=<id>[&browserAt=<path>]`
 * asks the workspace to open its browser dock on that share's app, at that
 * page. Null when the URL asks for nothing.
 */
export function browserHandoff(search: string): { open: true; share: BrowserShareHandoff | null } | null {
  const sp = new URLSearchParams(search);
  if (sp.get('browser') !== 'open') return null;
  const shareId = sp.get('browserShare');
  return { open: true, share: shareId && /^[a-z0-9]{10,64}$/.test(shareId) ? { shareId, at: safeAtPath(sp.get('browserAt')) } : null };
}

/**
 * A share link the owner opened, for their own pane's first dial: the box
 * opens the page on the share's app (the agent resolves its recipe), not on
 * whatever app the dock showed last.
 */
export interface BrowserShareHandoff { shareId: string; at: string | null }
