// What the file view's strip shows (pages/chat/FileChat.tsx), as one pure
// function of a session's messages: the ones sent from this file view, the
// pre-ready queue with its state and error, and the session's chat (the
// running turn and the latest reply). The component only renders the result.
//
// The rules, once:
// 1. The strip follows the newest message sent from here. Nothing sent: hidden.
// 2. A failure shows only while its message is that newest one. A later
//    message takes the strip; the failed one stays where it is (in the
//    pre-ready queue, which the conversation shows with its own Retry).
// 3. Dismiss hides the strip until something newer happens: a new message is
//    sent, or the dismissed message fails (that is news the person needs).
//    Its later progress (working, the reply, the turn's end) stays hidden.
//    Dismiss never brings an older message back: the newest stays the one
//    the strip follows, hidden.
// 4. Retry applies only to the newest message, only when it failed in the
//    pre-ready queue, and re-sends that queue entry, once: the strip says
//    queued again at once, so there is nothing to press twice. A direct send
//    that fails while its composer is on screen is not a strip failure: the
//    composer puts the text back in the box and says why under it, and the
//    strip shows what it did before. One that fails after the person picked
//    another target (its composer is gone) is: the strip of its session says
//    "not sent: …, back in the box", without Retry, and its text waits for
//    that session's box (`restore`), which takes it as soon as it is on
//    screen. The file view says so above whichever composer is shown.
// 5. The pre-ready queue holds one message per chat: a second message sent
//    before Claude is ready is appended to the waiting one and goes with it
//    (chat/useQueuedMessage.ts). The strip counts them while they wait, and
//    follows them as the one message they become once sent.
// Each session has its own model; switching the target back shows its strip
// as it was (FileChat keeps them for the page's life).
import { useSyncExternalStore } from 'react';
import { fileChatReply, type FileChatPhase } from './fileChat';
import type { ChatState } from './sdkChat';

export interface StripMessage {
  id: number;
  /** As sent: the typed text with the "(viewing …)" line. For queue entries, each entry's own text until the queue sends them as one. */
  text: string;
  via: 'direct' | 'queue';
  state: 'sending' | 'sent' | 'queued' | 'failed';
  error?: string;
  /** Which bubble with its text it is in the chat (1 = the first in view); 0 = not known, the last one with its text. */
  occurrence: number;
  /** A direct send that failed after its composer went: its text was put back in its box, not into a composer on screen. */
  away?: { images: number; seen?: boolean };
}

export interface StripModel {
  messages: StripMessage[];
  nextId: number;
  /** The queue's text while it holds something, and how many bubbles carried it once the history was in (it can only send after that). */
  queueText: string | null;
  queueBaseline: { text: string; count: number } | null;
  /** The newest message when Dismiss was pressed, and whether it had failed then. */
  dismissed: { id: number; failed: boolean } | null;
  /**
   * Typed texts of sends that failed away from their composer, in the order
   * sent, for the session's box to take back (then `restored`). The only copy:
   * a composer that is gone leaves the shared draft alone (useSdkChat keepsFailed).
   */
  restore: string[];
}

export const EMPTY_STRIP: StripModel = { messages: [], nextId: 1, queueText: null, queueBaseline: null, dismissed: null, restore: [] };

export type StripEvent =
  /** A direct send started; `occurrence` counted before it went. */
  | { type: 'sending'; text: string; occurrence: number }
  /** The direct send in flight was taken by the box. */
  | { type: 'sent' }
  /**
   * The direct send in flight failed. With `away` its composer was gone (the
   * person picked another target): it is a failure of this session, and its
   * typed text waits for this session's box.
   */
  | { type: 'unsent'; away?: { error: string; typed: string; images: number } }
  /** This session's box took the waiting text back. */
  | { type: 'restored' }
  /** Its composer has shown the failure that happened away from it (or the person closed the note about it). */
  | { type: 'seen' }
  /** A message went into the pre-ready queue. */
  | { type: 'queued'; text: string }
  /**
   * What the pre-ready queue holds now (useQueuedMessage): its text, its error,
   * and how many bubbles in the chat carry that text, once the history is in
   * (null before).
   */
  | { type: 'queue'; text: string | null; error: string | null; count: number | null }
  /** Retry on the strip's failure. */
  | { type: 'retry' }
  | { type: 'dismiss' };

const pendingQueue = (m: StripMessage) => m.via === 'queue' && (m.state === 'queued' || m.state === 'failed');

export function reduceStrip(model: StripModel, ev: StripEvent): StripModel {
  switch (ev.type) {
    case 'sending':
      return { ...model, nextId: model.nextId + 1, messages: [...model.messages, { id: model.nextId, text: ev.text, via: 'direct', state: 'sending', occurrence: ev.occurrence }] };
    case 'sent': {
      const i = model.messages.map(m => m.via === 'direct' && m.state === 'sending').lastIndexOf(true);
      if (i < 0) return model;
      const messages = model.messages.slice();
      messages[i] = { ...messages[i], state: 'sent' };
      return { ...model, messages };
    }
    case 'unsent': {
      const i = model.messages.map(m => m.via === 'direct' && m.state === 'sending').lastIndexOf(true);
      if (i < 0) return model;
      if (!ev.away) return { ...model, messages: model.messages.filter((_, j) => j !== i) };
      const messages = model.messages.slice();
      messages[i] = { ...messages[i], state: 'failed', error: ev.away.error, away: { images: ev.away.images } };
      const restore = ev.away.typed ? [...model.restore, ev.away.typed] : model.restore;
      return { ...model, messages, restore };
    }
    case 'restored':
      return model.restore.length ? { ...model, restore: [] } : model;
    case 'seen': {
      if (!model.messages.some(m => m.away && !m.away.seen)) return model;
      return { ...model, messages: model.messages.map(m => (m.away && !m.away.seen ? { ...m, away: { ...m.away, seen: true } } : m)) };
    }
    case 'queued':
      return { ...model, nextId: model.nextId + 1, messages: [...model.messages, { id: model.nextId, text: ev.text, via: 'queue', state: 'queued', occurrence: 0 }] };
    case 'queue': {
      if (ev.text != null) {
        const baseline = ev.count != null && model.queueBaseline?.text !== ev.text ? { text: ev.text, count: ev.count } : model.queueBaseline;
        const state: StripMessage['state'] = ev.error ? 'failed' : 'queued';
        const messages = model.messages.map(m => (pendingQueue(m) ? { ...m, state, error: ev.error ?? undefined } : m));
        return { ...model, messages, queueText: ev.text, queueBaseline: baseline };
      }
      // Empty: what waited went, as one message with the queue's text, under the newest entry's id.
      const pending = model.messages.filter(pendingQueue);
      if (!pending.length) return { ...model, queueText: null, queueBaseline: null };
      const text = model.queueText ?? pending[pending.length - 1].text;
      const occurrence = model.queueBaseline?.text === text ? model.queueBaseline.count + 1 : 0;
      const last = pending[pending.length - 1];
      const merged: StripMessage = { id: last.id, text, via: 'queue', state: 'sent', occurrence };
      const messages = model.messages.filter(m => !pendingQueue(m) || m.id === last.id).map(m => (m.id === last.id ? merged : m));
      return { ...model, messages, queueText: null, queueBaseline: null };
    }
    case 'retry': {
      const newest = model.messages[model.messages.length - 1];
      if (!newest || newest.via !== 'queue' || newest.state !== 'failed') return model;
      return { ...model, messages: model.messages.map(m => (pendingQueue(m) ? { ...m, state: 'queued', error: undefined } : m)) };
    }
    case 'dismiss': {
      const newest = model.messages[model.messages.length - 1];
      return newest ? { ...model, dismissed: { id: newest.id, failed: newest.state === 'failed' } } : model;
    }
  }
}

export type StripState =
  | { kind: 'hidden' }
  /** Waiting: in this browser's pre-ready queue (`browser`), or taken by the box behind the running turn (`box`). */
  | { kind: 'queued'; where: 'browser' | 'box'; count: number }
  | { kind: 'sending' }
  | { kind: 'working'; text: string | null }
  | { kind: 'done'; outcome: 'done' | 'stopped' | 'failed'; text: string | null }
  /** The newest message did not go: its error, how many messages it holds, and whether Retry applies. */
  | { kind: 'failed'; messageId: number; error: string; count: number; retry: boolean; away?: { images: number } };

/** The bubble a sent message is: its counted occurrence, or the last one with its text when that is not known. */
function replyOf(chat: ChatState, m: StripMessage): { phase: FileChatPhase; text: string | null } {
  if (m.occurrence > 0) return fileChatReply(chat, { message: m.text, occurrence: m.occurrence });
  const count = chat.items.filter(it => it.kind === 'user' && it.text.trim() === m.text.trim()).length;
  return count ? fileChatReply(chat, { message: m.text, occurrence: count }) : { phase: 'queued', text: null };
}

export function stripState(model: StripModel, chat: ChatState): StripState {
  const msgs = model.messages;
  const newest = msgs[msgs.length - 1];
  if (!newest) return { kind: 'hidden' };
  const d = model.dismissed;
  if (d && d.id === newest.id && !(newest.state === 'failed' && !d.failed)) return { kind: 'hidden' };
  switch (newest.state) {
    case 'sending':
      return { kind: 'sending' };
    case 'queued':
      return { kind: 'queued', where: 'browser', count: msgs.filter(m => pendingQueue(m)).length };
    case 'failed':
      return newest.away
        ? { kind: 'failed', messageId: newest.id, error: newest.error ?? 'not sent', count: 1, retry: false, away: newest.away }
        : { kind: 'failed', messageId: newest.id, error: newest.error ?? 'not sent', count: msgs.filter(m => pendingQueue(m)).length, retry: newest.via === 'queue' };
    case 'sent': {
      const r = replyOf(chat, newest);
      if (r.phase === 'queued') {
        // How many of the newest sent messages the box holds behind the turn.
        let count = 0;
        for (let i = msgs.length - 1; i >= 0 && msgs[i].state === 'sent' && replyOf(chat, msgs[i]).phase === 'queued'; i--) count++;
        return { kind: 'queued', where: 'box', count };
      }
      if (r.phase === 'working') return { kind: 'working', text: r.text };
      return { kind: 'done', outcome: r.phase === 'stopped' ? 'stopped' : r.phase === 'failed' ? 'failed' : 'done', text: r.text };
    }
  }
}

/** The strip's status words after the session's name. `live`: a message sent now goes into the running turn. */
export function stripStatusText(s: StripState, live: boolean): string {
  const many = (n: number) => (n > 1 ? `${n} messages · ` : '');
  switch (s.kind) {
    case 'hidden': return '';
    case 'sending': return 'Sending…';
    case 'queued': return s.where === 'browser' ? `${many(s.count)}sent as soon as Claude is ready`
      : live ? `${many(s.count)}Sent · it reads this at its next step` : `${many(s.count)}Queued · sent after the current turn`;
    case 'working': return 'Working…';
    case 'done': return s.outcome === 'stopped' ? 'Stopped' : s.outcome === 'failed' ? 'Failed' : 'Done';
    case 'failed': return s.away
      ? `not sent: ${s.error} · back in the box${s.away.images ? `; attach the ${s.away.images === 1 ? 'image' : `${s.away.images} images`} again` : ''}`
      : `${many(s.count)}not sent: ${s.error}`;
  }
}

/** A reply's first line, as plain text: what the one status line quotes. */
export function replyFirstLine(text: string | null): string | null {
  if (!text) return null;
  const line = text.split('\n').map(l => l.replace(/^[#>*\-\s`|]+/, '').replace(/[*_`]/g, '').trim()).find(Boolean);
  return line ?? null;
}

/**
 * The one line above the file view's composer (pages/chat/FileChat.tsx),
 * which never grows: everything the file view says above the box, in one
 * fixed-height row, with the reply itself left to the conversation (Open).
 * `status` is the session's own status line ("Done · your turn", "Setting
 * up · …"), shown when nothing was sent from here (or it was dismissed);
 * `unsent` is how many messages Stop took back; `away` the other sessions in
 * the space whose send failed after the person picked this one.
 */
export interface FileLine {
  /** The whole line, for its tooltip and tests: `name` + `status`. */
  text: string;
  /** The agent's name, drawn first and cut first (about 16 characters, the full name in a tooltip). */
  name: string;
  /** What follows the name (" · working…", " replied: <first line>"): kept in view before the name. */
  status: string;
  tone: 'idle' | 'working' | 'error';
  spinner: boolean;
  retry: boolean;
  /** × applies: there is a strip state to dismiss (the session's own status has none). */
  dismiss: boolean;
  unsent: number;
  away: { key: string; name: string; error: string } | null;
  /** More sessions beyond `away` with a failure. */
  awayMore: number;
}

export function fileLine(strip: StripState, ctx: {
  name: string; status: { tone: string; text: string }; running: boolean; live: boolean; unsent: number;
  away: ReadonlyArray<{ key: string; name: string; error: string }>;
}): FileLine {
  const base = { unsent: ctx.unsent, away: ctx.away[0] ?? null, awayMore: Math.max(0, ctx.away.length - 1) };
  const at = (text: string) => ` · ${text}`;
  const named = (l: Omit<FileLine, 'name' | 'text'>): FileLine => ({ ...l, name: ctx.name, text: `${ctx.name}${l.status}` });
  switch (strip.kind) {
    case 'hidden': {
      const tone = ctx.status.tone === 'error' ? 'error' : ctx.status.tone === 'idle' ? 'idle' : 'working';
      return named({ ...base, status: at(ctx.status.text), tone, spinner: ctx.running && ctx.status.tone === 'working', retry: false, dismiss: false });
    }
    case 'sending': return named({ ...base, status: at('sending…'), tone: 'working', spinner: true, retry: false, dismiss: true });
    case 'queued': return named({ ...base, status: at(stripStatusText(strip, ctx.live)), tone: 'working', spinner: false, retry: false, dismiss: true });
    case 'working': return named({ ...base, status: at('working…'), tone: 'working', spinner: true, retry: false, dismiss: true });
    case 'done': {
      const first = replyFirstLine(strip.text);
      const status = strip.outcome === 'stopped' ? at('stopped')
        : strip.outcome === 'failed' ? at(first ? `failed: ${first}` : 'failed')
        : first ? ` replied: ${first}` : at('done');
      return named({ ...base, status, tone: strip.outcome === 'failed' ? 'error' : 'idle', spinner: false, retry: false, dismiss: true });
    }
    case 'failed': return named({ ...base, status: at(stripStatusText(strip, ctx.live)), tone: 'error', spinner: false, retry: strip.retry, dismiss: true });
  }
}

// Each session's strip model, for the page's life, so switching the target back
// (or a send finishing after it switched) lands in the right session's strip.
const strips = new Map<string, StripModel>();
const stripListeners = new Set<() => void>();

export function dispatchStrip(key: string, ev: StripEvent): void {
  const prev = strips.get(key) ?? EMPTY_STRIP;
  const next = reduceStrip(prev, ev);
  if (next === prev) return;
  strips.set(key, next);
  stripsVersion++;
  for (const l of stripListeners) l();
}

export function useStripModel(key: string): StripModel {
  return useSyncExternalStore(
    l => { stripListeners.add(l); return () => { stripListeners.delete(l); }; },
    () => strips.get(key) ?? EMPTY_STRIP,
    () => EMPTY_STRIP,
  );
}

/** A session's strip model now, outside React (the file view's note about other targets). */
export function stripModelOf(key: string): StripModel { return strips.get(key) ?? EMPTY_STRIP; }

let stripsVersion = 0;
/** Re-renders on any session's strip change; read the models with stripModelOf. */
export function useStripsVersion(): number {
  return useSyncExternalStore(
    l => { stripListeners.add(l); return () => { stripListeners.delete(l); }; },
    () => stripsVersion,
    () => 0,
  );
}

/**
 * The failure of a send that went wrong after its composer was gone, still
 * unseen there: what the file view says above whichever composer is shown.
 */
export function awayFailure(model: StripModel): { error: string } | null {
  const newest = model.messages[model.messages.length - 1];
  return newest?.state === 'failed' && newest.away && !newest.away.seen ? { error: newest.error ?? 'not sent' } : null;
}

/** For tests: forget every session's strip. */
export function resetStripsForTests(): void { strips.clear(); }
