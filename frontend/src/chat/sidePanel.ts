// The simple UI's side panel (behind simple-ui-side-panel-enabled): a
// collapsible column on the right of a conversation, like Cursor's agent
// side panel, holding the session's ctrl terminal and, where the browser pane
// is on, its browser. On desktop it docks beside the chat at a width the user
// drags; on a phone it is an overlay over the chat. What is remembered (open
// or not, which tab, the width) is one record in localStorage, shared by
// every conversation in this browser. The phone overlay always starts shut.
// Where the user has spaces it also has Files, the space's explorer of agents
// and files, and then it shows beside a space file and on a new tab too,
// where Files is its only tab.

export const SIDE_PANEL_KEY = 'termag-chat-side-panel';

export type SidePanelTab = 'files' | 'terminal' | 'browser';

export interface SidePanelState {
  open: boolean;
  tab: SidePanelTab;
  /** The docked panel's width in CSS pixels. */
  width: number;
}

export const SIDE_PANEL_DEFAULT_WIDTH = 480;
export const SIDE_PANEL_MIN_WIDTH = 320;
/** The chat keeps at least this much of the main column beside the panel. */
export const SIDE_PANEL_CHAT_MIN_WIDTH = 360;

export const DEFAULT_SIDE_PANEL: SidePanelState = { open: false, tab: 'terminal', width: SIDE_PANEL_DEFAULT_WIDTH };

type ReadStorage = Pick<Storage, 'getItem'> | null | undefined;
type WriteStorage = Pick<Storage, 'setItem'> | null | undefined;

export function readSidePanel(storage: ReadStorage): SidePanelState {
  let raw: unknown;
  try { raw = JSON.parse(storage?.getItem(SIDE_PANEL_KEY) ?? 'null'); } catch { return DEFAULT_SIDE_PANEL; }
  if (!raw || typeof raw !== 'object') return DEFAULT_SIDE_PANEL;
  const r = raw as Record<string, unknown>;
  return {
    open: r.open === true,
    tab: r.tab === 'browser' || r.tab === 'files' ? r.tab : 'terminal',
    width: typeof r.width === 'number' && Number.isFinite(r.width) ? Math.round(r.width) : SIDE_PANEL_DEFAULT_WIDTH,
  };
}

export function writeSidePanel(storage: WriteStorage, state: SidePanelState): void {
  try { storage?.setItem(SIDE_PANEL_KEY, JSON.stringify(state)); } catch { /* private mode: not remembered */ }
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
 * need (absent beside a file or on a new tab).
 */
export interface SidePanelOffer { files: boolean; session: boolean }

const SESSION_ONLY: SidePanelOffer = { files: false, session: true };

/** The tabs the panel offers: Files where there is a space, Terminal and Browser beside a session, Browser only where the browser pane is on. */
export function sidePanelTabs(browserOn: boolean, offer: SidePanelOffer = SESSION_ONLY): SidePanelTab[] {
  const tabs: SidePanelTab[] = [];
  if (offer.files) tabs.push('files');
  if (offer.session) tabs.push(...(browserOn ? ['terminal', 'browser'] as const : ['terminal'] as const));
  return tabs;
}

/**
 * The tab shown: the remembered one if it is offered, else Terminal, else
 * Files. The remembered tab isn't changed, so the next chat shows it again.
 */
export function shownSidePanelTab(tab: SidePanelTab, browserOn: boolean, offer: SidePanelOffer = SESSION_ONLY): SidePanelTab {
  const tabs = sidePanelTabs(browserOn, offer);
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
 * Whether either tab may attach, as the workspace decides for its ctrl
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
