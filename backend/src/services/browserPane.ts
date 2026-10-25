/**
 * Browser pane: the pure parts of the backend's half.
 *
 * A viewer opens `WS /termag/ws/browser` naming a project and a URL; the
 * backend asks the project's box agent to run a headless Chromium and
 * screencast it, and relays frames one way and input the other. This module
 * holds the flag and capability names, the close codes the UI reads, and the
 * validation of what the browser sends, so routes/browserWs.ts stays a relay.
 */

export const BROWSER_PANE_FLAG = 'browser-pane-enabled';
/** What an agent that can run a pane says in its hello (agent/browser-pane.js). */
export const BROWSER_PANE_CAPABILITY = 'browser-pane-v1';
/**
 * Kept profiles: asked for per
 * attach while the flag is on for the project's owner and box, and the
 * viewer's "Reset browser" relayed, only to an agent that says it can.
 */
export const BROWSER_PANE_PROFILES_FLAG = 'browser-pane-persistent-profiles-enabled';
export const BROWSER_PANE_PROFILES_CAPABILITY = 'browser-pane-profiles-v1';
/** A box agent that can run a reviewer's guest pane (agent/browser-guest.js) and has the box's guest user. */
export const BROWSER_PANE_GUEST_CAPABILITY = 'browser-pane-guest-v1';

/** The flag is off for this viewer and box. */
export const BROWSER_PANE_DISABLED_CLOSE_CODE = 4403;
/** The box's agent predates the browser pane (or the box has no Chromium). */
export const BROWSER_PANE_UNSUPPORTED_CLOSE_CODE = 4501;
/**
 * The box's agent is not connected right now ("try again later"): the pane
 * redials, since the agent reconnects on its own within seconds and may still
 * hold the viewer's parked browser. The other refusals are 1008 and final.
 */
export const BROWSER_PANE_RETRY_CLOSE_CODE = 1013;

export const BROWSER_VIEWPORT = { minWidth: 320, maxWidth: 2560, minHeight: 240, maxHeight: 1600, defaultWidth: 1024, defaultHeight: 768 } as const;
const MAX_TEXT_CHARS = 4096;
const MAX_URL_CHARS = 2048;

export type BrowserMouseType = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
export type BrowserMouseButton = 'none' | 'left' | 'middle' | 'right';

export interface BrowserMouseEvent {
  kind: 'mouse';
  type: BrowserMouseType;
  x: number;
  y: number;
  button: BrowserMouseButton;
  buttons: number;
  clickCount: number;
  modifiers: number;
  deltaX?: number;
  deltaY?: number;
}

export interface BrowserKeyEvent {
  kind: 'key';
  type: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  text?: string;
  windowsVirtualKeyCode?: number;
  modifiers: number;
}

export interface BrowserTextEvent {
  kind: 'text';
  text: string;
}

export type BrowserInputEvent = BrowserMouseEvent | BrowserKeyEvent | BrowserTextEvent;

export type BrowserClientMessage =
  | { type: 'input'; event: BrowserInputEvent }
  | { type: 'navigate'; url: string }
  | { type: 'history'; action: 'back' | 'forward' | 'reload' }
  | { type: 'resize'; width: number; height: number }
  /** Which web apps listen on the box (the pane's URL bar prefill). Answered by the route, not relayed. */
  | { type: 'suggest' }
  /** "Reset browser": the agent forgets this pane's kept profile and closes it; the pane redials onto a fresh one. */
  | { type: 'reset-profile' }
  /** The viewer's answer to the page's dialog the agent showed them (`browser-dialog`). */
  | { type: 'dialog'; id: number; accept: boolean; text?: string };

/** A web app listening on the box, as the agent's scan reports it. */
export interface BrowserSuggestion {
  url: string;
  title: string;
  status?: number;
}

/** The agent's answer to `browser-suggest`, with every field checked. */
export function parseBrowserSuggestions(raw: unknown): BrowserSuggestion[] {
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  const out: BrowserSuggestion[] = [];
  for (const item of items.slice(0, 16)) {
    if (!isRecord(item) || typeof item.url !== 'string') continue;
    const url = normalizeBrowserUrl(item.url);
    if (!url || url === 'about:blank') continue;
    out.push({
      url,
      title: typeof item.title === 'string' ? item.title.slice(0, 80) : '',
      ...(typeof item.status === 'number' ? { status: item.status } : {}),
    });
  }
  return out;
}

export interface BrowserPaneRequest {
  projectId: string;
  workstream: string;
  url: string;
  width: number;
  height: number;
}

export function agentSupportsBrowserPane(capabilities: readonly string[]): boolean {
  return capabilities.includes(BROWSER_PANE_CAPABILITY);
}

export function agentSupportsKeptProfiles(capabilities: readonly string[]): boolean {
  return capabilities.includes(BROWSER_PANE_PROFILES_CAPABILITY);
}

export function agentSupportsGuests(capabilities: readonly string[]): boolean {
  return capabilities.includes(BROWSER_PANE_GUEST_CAPABILITY);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function clampViewport(width: unknown, height: unknown): { width: number; height: number } {
  return {
    width: clampInt(width, BROWSER_VIEWPORT.minWidth, BROWSER_VIEWPORT.maxWidth, BROWSER_VIEWPORT.defaultWidth),
    height: clampInt(height, BROWSER_VIEWPORT.minHeight, BROWSER_VIEWPORT.maxHeight, BROWSER_VIEWPORT.defaultHeight),
  };
}

/**
 * `about:blank`, or an http(s) URL (a bare host[:port]/path gets http://);
 * null for any other scheme. The agent applies the same rule before it
 * navigates, so this is the first of two gates, not the only one.
 */
// A scheme is a word followed by `://`, or by `:` and something other than a
// digit: `localhost:3000` is a host and port, `javascript:alert(1)` is not.
function hasScheme(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(s);
}

export function normalizeBrowserUrl(input: unknown): string | null {
  if (input === undefined || input === null) return 'about:blank';
  if (typeof input !== 'string' || input.length > MAX_URL_CHARS) return null;
  const s = input.trim();
  if (!s || s === 'about:blank') return 'about:blank';
  const withScheme = hasScheme(s) ? s : `http://${s}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/** The query of a pane socket: `?projectId=&workstream=&url=&width=&height=`. */
// A workstream names a directory on the box (the suggestion scan's hint):
// the same rule as routes/workstreams.ts, so nothing but a plain name gets there.
const WORKSTREAM_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function parseBrowserPaneQuery(params: URLSearchParams): BrowserPaneRequest | { error: string } {
  const projectId = params.get('projectId')?.trim() ?? '';
  if (!projectId) return { error: 'projectId param required' };
  const workstream = params.get('workstream')?.trim() || 'main';
  if (!WORKSTREAM_NAME.test(workstream)) return { error: 'workstream name invalid' };
  const url = normalizeBrowserUrl(params.get('url'));
  if (!url) return { error: 'url must be http or https' };
  const { width, height } = clampViewport(params.get('width'), params.get('height'));
  return { projectId, workstream, url, width, height };
}

const MOUSE_TYPES: ReadonlySet<string> = new Set(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']);
const MOUSE_BUTTONS: ReadonlySet<string> = new Set(['none', 'left', 'middle', 'right']);
const KEY_TYPES: ReadonlySet<string> = new Set(['keyDown', 'keyUp']);
const HISTORY_ACTIONS: ReadonlySet<string> = new Set(['back', 'forward', 'reload']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The viewer's input event, with every field checked and bounded, or null. */
export function parseBrowserInputEvent(raw: unknown): BrowserInputEvent | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'mouse') {
    if (typeof raw.type !== 'string' || !MOUSE_TYPES.has(raw.type)) return null;
    if (typeof raw.x !== 'number' || !Number.isFinite(raw.x) || typeof raw.y !== 'number' || !Number.isFinite(raw.y)) return null;
    const event: BrowserMouseEvent = {
      kind: 'mouse',
      type: raw.type as BrowserMouseType,
      x: Math.round(raw.x),
      y: Math.round(raw.y),
      button: typeof raw.button === 'string' && MOUSE_BUTTONS.has(raw.button) ? (raw.button as BrowserMouseButton) : 'none',
      buttons: clampInt(raw.buttons, 0, 31, 0),
      clickCount: clampInt(raw.clickCount, 0, 3, 0),
      modifiers: clampInt(raw.modifiers, 0, 15, 0),
    };
    if (event.type === 'mouseWheel') {
      event.deltaX = clampInt(raw.deltaX, -4000, 4000, 0);
      event.deltaY = clampInt(raw.deltaY, -4000, 4000, 0);
    }
    return event;
  }
  if (raw.kind === 'key') {
    if (typeof raw.type !== 'string' || !KEY_TYPES.has(raw.type)) return null;
    const key = typeof raw.key === 'string' ? raw.key.slice(0, 32) : '';
    const code = typeof raw.code === 'string' ? raw.code.slice(0, 32) : '';
    if (!key && !code) return null;
    const event: BrowserKeyEvent = { kind: 'key', type: raw.type as 'keyDown' | 'keyUp', key, code, modifiers: clampInt(raw.modifiers, 0, 15, 0) };
    if (typeof raw.text === 'string' && raw.text.length > 0 && raw.text.length <= 8) event.text = raw.text;
    if (typeof raw.windowsVirtualKeyCode === 'number' && Number.isInteger(raw.windowsVirtualKeyCode) && raw.windowsVirtualKeyCode > 0 && raw.windowsVirtualKeyCode < 256) {
      event.windowsVirtualKeyCode = raw.windowsVirtualKeyCode;
    }
    return event;
  }
  if (raw.kind === 'text') {
    if (typeof raw.text !== 'string' || !raw.text || raw.text.length > MAX_TEXT_CHARS) return null;
    return { kind: 'text', text: raw.text };
  }
  return null;
}

// The longest text a page's dialog (or the viewer's prompt answer) carries either way.
const MAX_DIALOG_TEXT = 2000;

/** One frame from the viewer's socket, or null when it is not one we relay. */
export function parseBrowserClientMessage(raw: string): BrowserClientMessage | null {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!isRecord(msg)) return null;
  switch (msg.type) {
    case 'input': {
      const event = parseBrowserInputEvent(msg.event);
      return event ? { type: 'input', event } : null;
    }
    case 'navigate': {
      const url = typeof msg.url === 'string' ? normalizeBrowserUrl(msg.url) : null;
      return url ? { type: 'navigate', url } : null;
    }
    case 'history':
      return typeof msg.action === 'string' && HISTORY_ACTIONS.has(msg.action)
        ? { type: 'history', action: msg.action as 'back' | 'forward' | 'reload' }
        : null;
    case 'resize': {
      if (typeof msg.width !== 'number' || typeof msg.height !== 'number') return null;
      return { type: 'resize', ...clampViewport(msg.width, msg.height) };
    }
    case 'suggest':
      return { type: 'suggest' };
    case 'reset-profile':
      return { type: 'reset-profile' };
    case 'dialog': {
      if (typeof msg.id !== 'number' || !Number.isInteger(msg.id) || msg.id < 1 || typeof msg.accept !== 'boolean') return null;
      const out: BrowserClientMessage = { type: 'dialog', id: msg.id, accept: msg.accept };
      if (typeof msg.text === 'string') out.text = msg.text.slice(0, MAX_DIALOG_TEXT);
      return out;
    }
    default:
      return null;
  }
}

/** The agent-socket message a viewer's stream frame becomes (the stream id is added by the registry); `suggest` is not one. */
export function toAgentBrowserMessage(msg: Exclude<BrowserClientMessage, { type: 'suggest' }>): Record<string, unknown> {
  switch (msg.type) {
    case 'input': return { type: 'browser-input', event: msg.event };
    case 'navigate': return { type: 'browser-navigate', url: msg.url };
    case 'history': return { type: 'browser-history', action: msg.action };
    case 'resize': return { type: 'browser-resize', width: msg.width, height: msg.height };
    case 'reset-profile': return { type: 'browser-profile-reset' };
    case 'dialog': return { type: 'browser-dialog-answer', id: msg.id, accept: msg.accept, ...(msg.text !== undefined ? { text: msg.text } : {}) };
    default: {
      const unreachable: never = msg;
      return unreachable;
    }
  }
}
