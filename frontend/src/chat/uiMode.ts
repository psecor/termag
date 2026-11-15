// Which UI this browser was last in: the simple UI at /chat or the full
// workspace. Showing /chat records simple; showing the workspace records
// full. Under chat-ui-nudge-enabled a visit records nothing and only a switch
// does (Lab's Open in termag, the chat's Open Lab, the Lab toast's Switch to
// chat, the end of setup), so a deep link into Lab doesn't change where
// termag opens. A page load at the bare workspace URL (`/termag/`) with simple
// recorded opens /chat instead, so coming back to termag lands where the
// user left it. Only that first load is redirected: a link or the back
// button to `/` inside the app, and any deep link (`/?project=…`), open the
// workspace, except a share link its owner opened, which opens in the simple
// UI's side panel (simpleUiShareHandoff), and, under chat-ui-nudge-enabled, a
// page loaded at a link to a project's session, which opens its chat
// (simpleUiDeepLink). The parameters an identity provider's app tile adds
// (Okta's `?iss=`, withoutLoginParams) don't make a landing a deep link.

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

/**
 * What an identity provider adds to the URL it opens termag at when a person
 * starts from its app tile (OpenID Connect's third-party-initiated login): the
 * Okta tile opens `/termag/?iss=https%3A%2F%2F<org>.okta.com`. The ALB has
 * signed the person in by the time the page loads, so termag never reads them,
 * and a landing that carries them is still the bare workspace URL.
 */
export const LOGIN_INITIATION_PARAMS = ['iss', 'login_hint', 'target_link_uri'] as const;

/** A query string without the login-initiation parameters; '' when nothing else is left. */
export function withoutLoginParams(search: string): string {
  if (!search || search === '?') return '';
  const sp = new URLSearchParams(search);
  if (!LOGIN_INITIATION_PARAMS.some(k => sp.has(k))) return search;
  for (const k of LOGIN_INITIATION_PARAMS) sp.delete(k);
  const rest = sp.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Takes the login-initiation parameters out of the address bar, before the
 * router reads it (main.tsx), so the workspace doesn't carry `?iss=` into every
 * URL it writes (`?iss=…&project=…`), where a reload or a bookmark would make
 * it a deep link. The history entry's state is kept, so the router still sees
 * the page's first location.
 */
export function dropLoginParamsFromAddressBar(win: Pick<Window, 'location' | 'history'>): void {
  try {
    const search = withoutLoginParams(win.location.search);
    if (search === win.location.search) return;
    win.history.replaceState(win.history.state, '', `${win.location.pathname}${search}${win.location.hash}`);
  } catch { /* a sandboxed frame or a test stub: the URL just keeps them */ }
}

/** The router path (BrowserRouter's basename is /termag) plus query of a page URL, login-initiation parameters left out. */
export function routerEntry(loc: { pathname: string; search: string }): string {
  const path = loc.pathname.replace(/^\/termag(?=\/|$)/, '') || '/';
  return `${path}${withoutLoginParams(loc.search)}`;
}

/** A router path plus query (`/?iss=…`), login-initiation parameters left out. */
function withoutLoginParamsIn(here: string): string {
  const q = here.indexOf('?');
  return q < 0 ? here : `${here.slice(0, q)}${withoutLoginParams(here.slice(q))}`;
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
  mode: UiMode; entry: string | null; here: string; locationKey: string;
}): boolean {
  if (i.mode !== 'simple') return false;
  if (i.locationKey !== INITIAL_LOCATION_KEY) return false;
  const here = withoutLoginParamsIn(i.here);
  if (i.entry == null || here !== i.entry) return false;
  return here === '/';
}

/**
 * A share link its owner opened, in the simple UI when that is where this
 * browser was last. The backend sends them to the workspace's own pane
 * (`/?project=&ws=&browser=open&browserShare=&browserAt=`, routes/previewShares.ts);
 * this is the same in the chat, `/chat/p/<project>?ws=&browser=open&…`, whose
 * side panel then opens on Browser at the share (useBrowserShareHandoff).
 * Null for anything else.
 */
export function simpleUiShareHandoff(i: { mode: UiMode; search: string }): string | null {
  if (i.mode !== 'simple') return null;
  const sp = new URLSearchParams(i.search);
  const project = sp.get('project');
  if (!project || sp.get('browser') !== 'open') return null;
  const q = new URLSearchParams({ ws: sp.get('ws') || 'main' });
  for (const key of ['browser', 'browserShare', 'browserAt', 'browserUrl']) {
    const value = sp.get(key);
    if (value != null) q.set(key, value);
  }
  return `/chat/p/${encodeURIComponent(project)}?${q}`;
}

/**
 * Marks a link that opens Lab on purpose: the chat's and the phone's Open in
 * Lab (fullUiHref). Its page load stays in Lab (simpleUiDeepLink), so opening
 * one in a new tab, or reloading Lab after it, doesn't send a chat person
 * back to the chat.
 */
export const LAB_PARAM = 'lab';

// The workspace parameters a project's chat stands in for: the project and its session.
const CHAT_EQUIVALENT_PARAMS: ReadonlySet<string> = new Set(['project', 'ws']);

/**
 * Under chat-ui-nudge-enabled, a Lab link to a project's session
 * (`/?project=<id>[&ws=<name>]`: Slack's and the automation reports' links,
 * briefing/slack.ts sessionLink) opened by someone whose kept choice is the
 * chat: the session it names, and its chat, `/chat/p/<id>[?ws=<name>]`
 * (chatHref), where SimpleUiReturnGate sends it, as simpleUiShareHandoff does
 * for a share link, once the project list shows that the session has a
 * conversation there (simpleChat.ts sessionHasChat). Only for the page's
 * first load, as shouldOpenSimpleUi, so in-app navigation to Lab stays there;
 * and only when every parameter has a chat equivalent. Null for anything else
 * (another Lab page, `branchOff`, a link marked LAB_PARAM), which opens Lab.
 */
export function simpleUiDeepLink(i: {
  mode: UiMode; entry: string | null; here: string; locationKey: string;
}): { projectId: string; workstream: string; href: string } | null {
  if (i.mode !== 'simple' || i.locationKey !== INITIAL_LOCATION_KEY) return null;
  const here = withoutLoginParamsIn(i.here);
  if (i.entry == null || here !== i.entry) return null;
  const q = here.indexOf('?');
  if (q < 0 || here.slice(0, q) !== '/') return null;
  const sp = new URLSearchParams(here.slice(q));
  if ([...sp.keys()].some(key => !CHAT_EQUIVALENT_PARAMS.has(key))) return null;
  const project = sp.get('project');
  if (!project) return null;
  const workstream = sp.get('ws') || 'main';
  const href = `/chat/p/${encodeURIComponent(project)}${workstream !== 'main' ? `?ws=${encodeURIComponent(workstream)}` : ''}`;
  return { projectId: project, workstream, href };
}
