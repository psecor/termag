// The browser's usage events: which client and
// view a person is in, and which commands they run in the chat UI. Product
// events like the rest (observability.ts), so metadata only: a chat command is
// named only when it is on CHAT_COMMANDS, since a person's own skills and
// commands can be called anything.
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { currentUiMode } from './chat/uiMode';
import { isStandalone, MOBILE_MEDIA_QUERY, TOUCH_MEDIA_QUERY } from './mobile/redirect';
import { recordProductEvent, type ProductEventAttributes } from './observability';

/** Which part of termag a page is: the phone client, the simple UI, the full workspace, or another page. */
export type ClientView = 'mobile' | 'simple' | 'full' | 'other';

// Routes of their own beside /m, /chat and the workspace (App.tsx).
const OTHER_PAGES = ['/login', '/dashboard', '/preview', '/welcome', '/automations', '/spawns', '/admin'];

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** The view of a router-relative path. Pure. */
export function clientView(pathname: string): ClientView {
  if (under(pathname, '/m')) return 'mobile';
  if (under(pathname, '/chat')) return 'simple';
  return OTHER_PAGES.some(p => under(pathname, p)) ? 'other' : 'full';
}

export interface ClientEnv {
  pathname: string;
  standalone: boolean;
  phone: boolean;
  touch: boolean;
  /** Notification.permission, or `unsupported`. */
  notifications: string;
  uiMode: string;
  resumed: boolean;
}

/** client.opened's attributes. Pure. */
export function clientOpenedAttributes(env: ClientEnv): ProductEventAttributes {
  return {
    'termag.view': clientView(env.pathname),
    'termag.uiMode': env.uiMode,
    'termag.standalone': env.standalone,
    'termag.phone': env.phone,
    'termag.touch': env.touch,
    'termag.notifications': env.notifications,
    'termag.resumed': env.resumed,
  };
}

function currentClientEnv(pathname: string, resumed: boolean): ClientEnv {
  const matches = (q: string) => { try { return window.matchMedia?.(q).matches === true; } catch { return false; } };
  let notifications = 'unsupported';
  try { if (typeof Notification !== 'undefined') notifications = Notification.permission; } catch { /* unsupported */ }
  return {
    pathname,
    standalone: isStandalone(window),
    phone: matches(MOBILE_MEDIA_QUERY),
    touch: matches(TOUCH_MEDIA_QUERY),
    notifications,
    uiMode: currentUiMode(),
    resumed,
  };
}

// An installed app or a pinned tab can stay loaded for days, so a page that
// comes back into view after this long counts as opened again (`resumed`).
export const REOPEN_AFTER_MS = 4 * 60 * 60 * 1000;
let lastOpened: number | null = null;

/**
 * Whether to record client.opened now. Pure but for the clock it is given.
 * The page's first open comes only from the mount's timer (`resumed` false),
 * once its redirects are done; after it, only the page coming back into view
 * after REOPEN_AFTER_MS records again (`resumed` true). A visibility change
 * before the first, or a remount after it (moving between routes), never does.
 */
export function shouldRecordOpened(last: number | null, now: number, resumed: boolean): boolean {
  return resumed ? last !== null && now - last >= REOPEN_AFTER_MS : last === null;
}

/**
 * How long after mounting the first record waits: the start of a load
 * redirects (the bare URL to /chat or /m, the installed app's start), and the
 * view recorded must be the one shown, not the URL the page was opened at.
 */
export const OPENED_SETTLE_MS = 1500;

/**
 * Records client.opened once per page load, and again when the page comes
 * back into view after REOPEN_AFTER_MS, each time with the path shown then.
 * Rendered inside FeatureFlagsProvider, so the user is loaded before the
 * first record. A redirect into another route's provider
 * unmounts this one before its timer fires, and the next one records.
 */
export function RecordClientOpened(): null {
  const { pathname } = useLocation();
  const path = useRef(pathname);
  useEffect(() => { path.current = pathname; }, [pathname]);
  useEffect(() => {
    const record = (resumed: boolean) => {
      const now = Date.now();
      if (!shouldRecordOpened(lastOpened, now, resumed)) return;
      lastOpened = now;
      recordProductEvent('client.opened', clientOpenedAttributes(currentClientEnv(path.current, resumed)));
    };
    const timer = setTimeout(() => record(false), OPENED_SETTLE_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') record(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return null;
}

/** Test hook. */
export function resetUsageEventsForTests(): void {
  lastOpened = null;
}

// ── Chat commands ────────────────────────────────────────────────────────────

/**
 * Commands a chat command is named by: Claude Code's built-ins and the skills
 * termag puts on every box (deploy/claude-skills). Anything else is `custom`.
 */
export const CHAT_COMMANDS: ReadonlySet<string> = new Set([
  // Claude Code
  'add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'effort', 'export', 'fast',
  'help', 'hooks', 'ide', 'init', 'login', 'logout', 'loop', 'mcp', 'memory', 'model', 'output-style', 'permissions',
  'plugin', 'plugins', 'reload-plugins', 'resume', 'review', 'rewind', 'security-review', 'simplify', 'status', 'statusline',
  'terminal-setup', 'todos', 'upgrade', 'usage', 'vim', 'code-review',
  // termag's skills
  'agent-ask', 'agent-orchestrator', 'metaterm', 'termag-bug-report', 'termag-handoff', 'termag-overlap', 'termag-pr', 'termag-spaces',
]);

/** The command a message sent in the chat is, as chat.command names it, or null when it is no slash command. Pure. */
export function chatCommandName(text: string): string | null {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s|$)/.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  return CHAT_COMMANDS.has(name) ? name : 'custom';
}

/** Where it was typed: the SDK chat, the pane chat, the phone's agent pane, or New chat's first message. */
export type ChatKind = 'sdk' | 'pane' | 'mobile' | 'new';

/** Record a typed slash command, if `text` is one. Never throws. */
export function recordTypedChatCommand(text: string, chat: ChatKind): void {
  const command = chatCommandName(text);
  if (command) recordProductEvent('chat.command', { 'termag.command': command, 'termag.via': 'typed', 'termag.chat': chat });
}

/** Record the context popover's Clear, Compact or Resume. */
export function recordChatAction(action: 'clear' | 'compact' | 'resume'): void {
  recordProductEvent('chat.command', { 'termag.command': action, 'termag.via': 'button', 'termag.chat': 'sdk' });
}
