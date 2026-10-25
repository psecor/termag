// "Your turn" notifications for simple-UI chats.
// The pure half: when a chat's events end a turn, what the notification says,
// and whether this tab should show it. Web push (backend
// services/chatTurnPush.ts, public/sw.js) covers a device subscribed to push;
// this tab covers a device that is not, while it is open.
import { chatHref } from './simpleChat';

/**
 * One chat's turn, followed through its events: `open` from the first sign of
 * work until Claude answers. `ready` says this event ended the turn for the
 * person: a `result` (each answer, also in a live turn that stays open on
 * background work), or a `turn-end` without one. A turn someone stopped (a
 * turn-end with a signal) is not ready: they know. Mirrors the backend's
 * isChatTurnEnd over the status it derives from the same events.
 */
export function stepTurn(open: boolean, event: unknown): { open: boolean; ready: boolean } {
  const ev = (event && typeof event === 'object' ? event : {}) as { type?: unknown; isReplay?: unknown; signal?: unknown; message?: { content?: unknown } };
  switch (ev.type) {
    case 'turn-start':
    case 'assistant':
      return { open: true, ready: false };
    case 'user':
      return ev.isReplay === true && typeof ev.message?.content === 'string' ? { open: true, ready: false } : { open, ready: false };
    case 'result':
      return { open: false, ready: open };
    case 'turn-end':
      return { open: false, ready: open && !ev.signal };
    default:
      return { open, ready: false };
  }
}

/**
 * A chat already working when the page loaded has sent no turn-start this
 * page saw: count it as in a turn, so its answer still notifies. Only keys the
 * follower has no state for, since it knows better once frames arrive.
 * Mutates `open`; `working` holds `${projectId}|${workstream}` keys.
 */
export function seedWorkingTurns(open: Map<string, boolean>, working: Iterable<string>): void {
  for (const key of working) if (!open.has(key)) open.set(key, true);
}

const MAX_BODY = 180;

/** The first non-empty line of a `result` event's text. */
export function turnPreview(event: unknown): string | null {
  const text = (event as { result?: unknown } | null)?.result;
  if (typeof text !== 'string') return null;
  const line = text.split('\n').find(l => l.trim() !== '')?.replace(/\s+/g, ' ').trim();
  return line || null;
}

/** A reply's line as a notification shows it: no markdown emphasis, code ticks or heading/list marker (backend webPush.ts). */
export function plainPreview(text: string): string {
  return text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim().replace(/^(#{1,6}|[-*+]|>)\s+/, '');
}

/** What the notification says; the same words as the push (backend buildChatTurnPayload). */
export function turnNotificationText(projectName: string, workstream: string, preview: string | null): { title: string; body: string } {
  const text = plainPreview(preview ?? '');
  return {
    title: workstream === 'main' ? projectName : `${projectName} · ${workstream}`,
    body: text ? `Your turn · ${text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text}` : 'Done · your turn',
  };
}

/** One notification per chat, shared with the push so either replaces the other. */
export function chatTurnTag(projectId: string, workstream: string): string {
  return `chat-turn:${projectId}:${workstream}`;
}

/** The chat's absolute path under the app, for the notification's click. */
export function chatTurnUrl(projectId: string, workstream: string): string {
  return `/termag${chatHref(projectId, workstream)}`;
}

export interface LocalNotifyInput {
  /** The person opted in and the flag is on. */
  enabled: boolean;
  permission: NotificationPermission | 'unsupported';
  /** This device is subscribed to push, which brings the notification itself. */
  pushCovers: boolean;
  /** The page is visible and focused. */
  looking: boolean;
  /** The chat this tab shows, if any. */
  shown: { projectId: string; workstream: string } | null;
  chat: { projectId: string; workstream: string };
}

/** Whether this tab shows the notification: never for the chat the person is looking at. */
export function shouldNotifyHere(i: LocalNotifyInput): boolean {
  if (!i.enabled || i.permission !== 'granted' || i.pushCovers) return false;
  const onIt = i.shown?.projectId === i.chat.projectId && i.shown.workstream === i.chat.workstream;
  return !(i.looking && onIt);
}

export type NotifyState =
  /** The flag is off for this person: no control. */
  | 'hidden'
  | 'unsupported'
  /** Blocked in the browser's site settings. */
  | 'blocked'
  | 'off'
  /** On, shown only while termag is open in a tab. */
  | 'on-tab'
  /** On, and this device gets a push when termag is closed too. */
  | 'on-push';

export function notifyState(i: { flag: boolean; optedIn: boolean; permission: NotificationPermission | 'unsupported'; pushCovers: boolean }): NotifyState {
  if (!i.flag) return 'hidden';
  if (i.permission === 'unsupported') return 'unsupported';
  if (i.permission === 'denied') return 'blocked';
  if (!i.optedIn || i.permission !== 'granted') return 'off';
  return i.pushCovers ? 'on-push' : 'on-tab';
}

/** localStorage key: the chat view's setup hint was dismissed or followed on this browser. */
export const SETUP_HINT_DISMISSED_KEY = 'termag.chat.notifyHintDismissed';

/**
 * The chat view's one-time pointer to Settings → Notifications: only while
 * notifications were never set up (not opted in, and this browser was never
 * asked) and the hint was not dismissed here. Otherwise the chat shows nothing.
 */
export function showSetupHint(i: { flag: boolean; optedIn: boolean; permission: NotificationPermission | 'unsupported'; dismissed: boolean }): boolean {
  return i.flag && !i.optedIn && i.permission === 'default' && !i.dismissed;
}
