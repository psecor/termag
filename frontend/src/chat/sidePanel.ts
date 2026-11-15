// The simple UI's side panel: a
// collapsible column on the right of a conversation, like Cursor's agent
// side panel, holding the session's ctrl terminal and, where the browser pane
// is on, its browser. On desktop it docks beside the chat at a width the user
// drags; on a phone it is an overlay over the chat. Open or not, and which
// tab, are each place's own (a session, a space's files, an automation's
// page: sidePanelPlace): it starts shut, on Terminal, and the places it was
// left open in and the tab each last showed are remembered in localStorage,
// the last SIDE_PANEL_OPEN_MAX and SIDE_PANEL_TABS_MAX of them. The width is
// one record, shared by every place in this browser. The phone overlay always
// starts shut.
// Where the user has spaces it also has Files, the space's explorer of agents
// and files, and then it shows beside a space file and on a new tab too,
// where Files is its only tab. Beside a session its owner may share, it also
// has Share: the full UI's "Share…" on the browser dock.
// Under project-files-enabled a file picked in Files (or a file link in a reply) opens in the panel, as a file tab
// of its own (chat/openItems.ts openInPanel); each place remembers the file tab it showed, if one, beside its tool.

/** The width, shared by every place. The `open` and `tab` of a record from before each place had its own are no longer read. */
export const SIDE_PANEL_KEY = 'termag-chat-side-panel';
/** The places the docked panel was left open in, the most recent first. */
export const SIDE_PANEL_OPEN_KEY = 'termag-chat-side-panel-open';
/** How many places the panel's open state is remembered for; past it the oldest starts shut again. */
export const SIDE_PANEL_OPEN_MAX = 50;
/** The tab each place last showed, the most recent first. */
export const SIDE_PANEL_TABS_KEY = 'termag-chat-side-panel-tabs';
/** How many places the panel's tab is remembered for; past it the oldest opens on DEFAULT_SIDE_PANEL_TAB again. */
export const SIDE_PANEL_TABS_MAX = 50;

export type SidePanelTab = 'files' | 'terminal' | 'browser' | 'share' | 'pr' | 'review';

/** What every place shares. */
export interface SidePanelPrefs {
  /** The docked panel's width in CSS pixels. */
  width: number;
}

/** The panel as one place shows it: the shared width, and its tab and whether it is open there. */
export interface SidePanelState extends SidePanelPrefs {
  tab: SidePanelTab;
  open: boolean;
  /** The file tab shown over `tab` (an OpenItem's id), if one is; null shows the tool. */
  file?: string | null;
}

/** A place's remembered tab (SIDE_PANEL_TABS_KEY), and the file tab it showed over it, if any. */
export interface SidePanelPlaceTab {
  place: string;
  tab: SidePanelTab;
  file?: string;
}

export const SIDE_PANEL_DEFAULT_WIDTH = 480;
export const SIDE_PANEL_MIN_WIDTH = 320;
/** The chat keeps at least this much of the main column beside the panel. */
export const SIDE_PANEL_CHAT_MIN_WIDTH = 360;

/** The tab a place with none remembered opens on (shownSidePanelTab shows Files where Terminal isn't offered). */
export const DEFAULT_SIDE_PANEL_TAB: SidePanelTab = 'terminal';
export const DEFAULT_SIDE_PANEL_PREFS: SidePanelPrefs = { width: SIDE_PANEL_DEFAULT_WIDTH };
export const DEFAULT_SIDE_PANEL: SidePanelState = { open: false, tab: DEFAULT_SIDE_PANEL_TAB, ...DEFAULT_SIDE_PANEL_PREFS };

const TABS: readonly SidePanelTab[] = ['files', 'terminal', 'browser', 'share', 'pr', 'review'];
const isSidePanelTab = (v: unknown): v is SidePanelTab => TABS.includes(v as SidePanelTab);

type ReadStorage = Pick<Storage, 'getItem'> | null | undefined;
type WriteStorage = Pick<Storage, 'setItem'> | null | undefined;

export function readSidePanel(storage: ReadStorage): SidePanelPrefs {
  let raw: unknown;
  try { raw = JSON.parse(storage?.getItem(SIDE_PANEL_KEY) ?? 'null'); } catch { return DEFAULT_SIDE_PANEL_PREFS; }
  if (!raw || typeof raw !== 'object') return DEFAULT_SIDE_PANEL_PREFS;
  const r = raw as Record<string, unknown>;
  return { width: typeof r.width === 'number' && Number.isFinite(r.width) ? Math.round(r.width) : SIDE_PANEL_DEFAULT_WIDTH };
}

/** Writes the width only: open or not, and the tab, are each place's (writeOpenSidePanels, writeSidePanelTabs). */
export function writeSidePanel(storage: WriteStorage, prefs: SidePanelPrefs): void {
  try { storage?.setItem(SIDE_PANEL_KEY, JSON.stringify({ width: prefs.width })); } catch { /* private mode: not remembered */ }
}

/**
 * The place the panel is beside, for its open state: a session
 * (`session:<projectId>|<workstream>`), the agents in no space, an
 * automation's page, or a space, whose file views and new tab are one place
 * so going from file to file keeps the panel as it was. Null for a page with
 * no panel. The first that applies, in the order ChatApp picks what Files explores.
 */
export function sidePanelPlace(at: {
  session?: { projectId: string; workstream: string } | null;
  agents?: boolean;
  automation?: string | null;
  space?: string | null;
}): string | null {
  if (at.session) return `session:${at.session.projectId}|${at.session.workstream}`;
  if (at.agents) return 'agents';
  if (at.automation) return `automation:${at.automation}`;
  if (at.space) return `space:${at.space}`;
  return null;
}

const PLACE_MAX_LENGTH = 400;

/** The places the panel was left open in, most recent first: strings only, each once, at most SIDE_PANEL_OPEN_MAX. */
export function readOpenSidePanels(storage: ReadStorage): string[] {
  let raw: unknown;
  try { raw = JSON.parse(storage?.getItem(SIDE_PANEL_OPEN_KEY) ?? 'null'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const places = raw.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= PLACE_MAX_LENGTH);
  return [...new Set(places)].slice(0, SIDE_PANEL_OPEN_MAX);
}

export function writeOpenSidePanels(storage: WriteStorage, places: readonly string[]): void {
  try { storage?.setItem(SIDE_PANEL_OPEN_KEY, JSON.stringify(places)); } catch { /* private mode: not remembered */ }
}

/**
 * `places` with `place` open, first as the most recent (also how a visit to
 * a place it is open in keeps it from aging out), or shut, gone. Only the
 * newest SIDE_PANEL_OPEN_MAX are kept; one that falls off starts shut again.
 */
export function withSidePanelOpen(places: readonly string[], place: string, open: boolean): string[] {
  const rest = places.filter(p => p !== place);
  return (open ? [place, ...rest] : rest).slice(0, SIDE_PANEL_OPEN_MAX);
}

/** The tab each place last showed, most recent first: known tabs only, each place once (its first), at most SIDE_PANEL_TABS_MAX. */
export function readSidePanelTabs(storage: ReadStorage): SidePanelPlaceTab[] {
  let raw: unknown;
  try { raw = JSON.parse(storage?.getItem(SIDE_PANEL_TABS_KEY) ?? 'null'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tabs: SidePanelPlaceTab[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { place, tab, file } = e as Record<string, unknown>;
    if (typeof place !== 'string' || !place || place.length > PLACE_MAX_LENGTH || seen.has(place) || !isSidePanelTab(tab)) continue;
    seen.add(place);
    tabs.push(typeof file === 'string' && FILE_TAB_ID.test(file) ? { place, tab, file } : { place, tab });
  }
  return tabs.slice(0, SIDE_PANEL_TABS_MAX);
}

export function writeSidePanelTabs(storage: WriteStorage, tabs: readonly SidePanelPlaceTab[]): void {
  try { storage?.setItem(SIDE_PANEL_TABS_KEY, JSON.stringify(tabs)); } catch { /* private mode: not remembered */ }
}

/** A file tab's id, as chat/openItems.ts makes them. */
const FILE_TAB_ID = /^[a-z0-9]{1,16}$/;

/** The file tab `place` last showed over its tool, if one. */
export function sidePanelFileAt(tabs: readonly SidePanelPlaceTab[], place: string | null): string | null {
  return (place != null ? tabs.find(t => t.place === place)?.file : undefined) ?? null;
}

/** The tab `place` opens on: the one it last showed, else DEFAULT_SIDE_PANEL_TAB. */
export function sidePanelTabAt(tabs: readonly SidePanelPlaceTab[], place: string | null): SidePanelTab {
  return (place != null ? tabs.find(t => t.place === place)?.tab : undefined) ?? DEFAULT_SIDE_PANEL_TAB;
}

/**
 * `tabs` with `place` on `tab`, first as the most recent (also how a visit
 * keeps a place from aging out). Only the newest SIDE_PANEL_TABS_MAX are
 * kept; one that falls off opens on DEFAULT_SIDE_PANEL_TAB again.
 */
export function withSidePanelTab(tabs: readonly SidePanelPlaceTab[], place: string, tab: SidePanelTab, file: string | null = null): SidePanelPlaceTab[] {
  return [file ? { place, tab, file } : { place, tab }, ...tabs.filter(t => t.place !== place)].slice(0, SIDE_PANEL_TABS_MAX);
}

/**
 * The docked width to lay out: the stored one, kept between the minimum and
 * what leaves the chat its own minimum in a main column `mainWidth` wide.
 * A window too narrow for both gives the panel its minimum.
 */
export function clampSidePanelWidth(width: number, mainWidth: number): number {
  const max = Math.max(SIDE_PANEL_MIN_WIDTH, mainWidth - SIDE_PANEL_CHAT_MIN_WIDTH);
  return Math.min(max, Math.max(SIDE_PANEL_MIN_WIDTH, Math.round(width)));
}

/**
 * What the panel is beside: `files`, a space to explore (absent for an agent
 * with no space); `session`, an agent's session, which Terminal and Browser
 * need (absent beside a file or on a new tab); `share`, a session whose
 * preview this user may share (its owner, not a
 * collaborator); `pr`, a session's Pull request tab (the chrome
 * refresh's, PrTab.tsx); `review`, its review panes.
 */
export interface SidePanelOffer { files: boolean; session: boolean; share?: boolean; pr?: boolean; review?: boolean }

const SESSION_ONLY: SidePanelOffer = { files: false, session: true };

/**
 * The tabs the panel offers: Files where there is a space, Terminal and
 * Browser beside a session, and Share beside a session that may be shared, since a share is a browser too.
 */
export function sidePanelTabs(offer: SidePanelOffer = SESSION_ONLY): SidePanelTab[] {
  const tabs: SidePanelTab[] = [];
  if (offer.files) tabs.push('files');
  if (offer.session) tabs.push('terminal', 'browser');
  if (offer.session && offer.share) tabs.push('share');
  if (offer.session && offer.pr) tabs.push('pr');
  if (offer.session && offer.review) tabs.push('review');
  return tabs;
}

/**
 * The tab shown: the place's remembered one if it is offered, else Terminal,
 * else Files. The remembered tab isn't changed, so it shows again once offered.
 */
export function shownSidePanelTab(tab: SidePanelTab, offer: SidePanelOffer = SESSION_ONLY): SidePanelTab {
  const tabs = sidePanelTabs(offer);
  if (tabs.includes(tab)) return tab;
  return tabs.includes('terminal') ? 'terminal' : 'files';
}

/**
 * The panel's shortcut: Ctrl+Alt+B (⌘⌥B on a Mac), VS Code's and Cursor's
 * "toggle secondary side bar". Matched on `code`, since Option turns the
 * Mac's `key` into `∫`. Ctrl+B alone is tmux's prefix in the terminal.
 */
export function isSidePanelShortcut(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  return e.code === 'KeyB' && e.altKey && !e.shiftKey && (e.ctrlKey || e.metaKey);
}

export type SidePanelBody = 'ready' | 'setup' | 'no-shell';

/**
 * Whether a session tab may attach (Share too: what it shares is the browser's), as the workspace decides for its ctrl
 * column (the ctrl terminal and the browser dock live in the same
 * `hasAgent && !cloneHeld` branch of App.tsx). The terminal is the
 * workstream's ctrl shell, never the agent pane (the chat reads that pane,
 * or the chat runner owns the agent). Nothing attaches, terminal or
 * browser, until the project is set up (cloneTile's holdTerminal); a
 * project with no agent workflow has no ctrl session to attach to.
 */
export function sidePanelBody(i: { hasAgent: boolean; held: boolean }): SidePanelBody {
  if (!i.hasAgent) return 'no-shell';
  if (i.held) return 'setup';
  return 'ready';
}

/**
 * The docked width to paint: the remembered one, clamped to the main column
 * as it is now. Unmeasured (first paint), the remembered width. The clamp is
 * not written back, so the panel returns to its width when the window grows.
 */
export function dockedSidePanelWidth(stored: number, mainWidth: number | null): number {
  return mainWidth == null ? stored : clampSidePanelWidth(stored, mainWidth);
}
