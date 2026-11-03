// Which UI this browser was last in: the simple UI at /chat or the full
// workspace. Showing /chat records simple; showing the workspace records
// full. A page load at the bare workspace URL (`/termag/`) with simple
// recorded opens /chat instead, so coming back to termag lands where the
// user left it. Only that first load is redirected: a link or the back
// button to `/` inside the app, and any deep link (`/?project=…`), open the
// workspace, except a share link its owner opened, which opens in the simple
// UI's side panel (simpleUiShareHandoff).

import { recordProductEvent } from '../observability';

export const UI_MODE_KEY = 'termag-ui-mode';

export type UiMode = 'simple' | 'full';

type ReadStorage = Pick<Storage, 'getItem'> | null | undefined;
type WriteStorage = Pick<Storage, 'setItem'> | null | undefined;

export function readUiMode(storage: ReadStorage): UiMode {
  try { return storage?.getItem(UI_MODE_KEY) === 'simple' ? 'simple' : 'full'; } catch { return 'full'; }
}

export function writeUiMode(storage: WriteStorage, mode: UiMode): void {
  try { storage?.setItem(UI_MODE_KEY, mode); } catch { /* private mode */ }
}

function local(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

export function currentUiMode(): UiMode { return readUiMode(local()); }

/** What this browser has recorded, or null when it has recorded nothing yet. */
function storedUiMode(): UiMode | null {
  try {
    const v = local()?.getItem(UI_MODE_KEY);
    return v === 'simple' || v === 'full' ? v : null;
  } catch { return null; }
}
// Told each time a visit records where it is, so the choice can be kept on
// the user as well (contexts/AuthContext.tsx).
const recorded = new Set<(mode: UiMode) => void>();
export function onUiModeRecorded(listener: (mode: UiMode) => void): () => void {
  recorded.add(listener);
  return () => { recorded.delete(listener); };
}

export function recordUiMode(mode: UiMode): void {
  const before = storedUiMode();
  writeUiMode(local(), mode);
  // A move between the simple UI and the workspace. Not a browser's
  // first visit, which has nothing to move from (first run has welcome.mode.chosen), nor adoptUiMode.
  if (before && before !== mode) recordProductEvent('ui.mode.switched', { 'termag.from': before, 'termag.to': mode });
  recorded.forEach(listener => listener(mode));
}

/** The user's kept choice, applied to this browser before any route reads it; not reported back. */
export function adoptUiMode(mode: UiMode): void { writeUiMode(local(), mode); }

/** The router path (BrowserRouter's basename is /termag) plus query of a page URL. */
export function routerEntry(loc: { pathname: string; search: string }): string {
  const path = loc.pathname.replace(/^\/termag(?=\/|$)/, '') || '/';
  return `${path}${loc.search === '?' ? '' : loc.search}`;
}

// Where this page was loaded, until the workspace has been shown once.
let entry: string | null = typeof window !== 'undefined' ? routerEntry(window.location) : null;

export function pageEntry(): string | null { return entry; }
/** The workspace has been shown: later visits to `/` in this page are in-app navigation. */
export function leavePageEntry(): void { entry = null; }

export const INITIAL_LOCATION_KEY = 'default';

/**
 * React Router keys the location a page was loaded at `default`; every router
 * navigation, push or replace, gets a fresh key. Any other key means the page
 * has navigated, wherever that happened (the phone redirect runs before the
 * workspace mounts), so a later `/` is in-app navigation, back button included.
 */
export function notePageLocation(key: string): void {
  if (key !== INITIAL_LOCATION_KEY) leavePageEntry();
}

/** Whether the workspace at `here` (router path + query) opens the simple UI instead. */
export function shouldOpenSimpleUi(i: {
  flagOn: boolean; mode: UiMode; entry: string | null; here: string; locationKey: string;
}): boolean {
  if (!i.flagOn || i.mode !== 'simple') return false;
  if (i.locationKey !== INITIAL_LOCATION_KEY) return false;
  if (i.entry == null || i.here !== i.entry) return false;
  return i.here === '/';
}

/**
 * A share link its owner opened, in the simple UI when that is where this
 * browser was last. The backend sends them to the workspace's own pane
 * (`/?project=&ws=&browser=open&browserShare=&browserAt=`, routes/previewShares.ts);
 * this is the same in the chat, `/chat/p/<project>?ws=&browser=open&…`, whose
 * side panel then opens on Browser at the share (useBrowserShareHandoff).
 * Null for anything else, and without the side panel, which opens the workspace.
 */
export function simpleUiShareHandoff(i: { flagOn: boolean; sidePanelOn: boolean; mode: UiMode; search: string }): string | null {
  if (!i.flagOn || !i.sidePanelOn || i.mode !== 'simple') return null;
  const sp = new URLSearchParams(i.search);
  const project = sp.get('project');
  if (!project || sp.get('browser') !== 'open') return null;
  const q = new URLSearchParams({ ws: sp.get('ws') || 'main' });
  for (const key of ['browser', 'browserShare', 'browserAt']) {
    const value = sp.get(key);
    if (value != null) q.set(key, value);
  }
  return `/chat/p/${encodeURIComponent(project)}?${q}`;
}
