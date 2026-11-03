// The file view's agent composer: who a message
// typed under a space file goes to, what it says, and what to show of the
// answer. The target is one of the space's agent sessions, from the sidebar's
// tabs (chat/openItems.ts groupOpenItems), that runs in the chat runner (a
// pane chat has no send route). By default it is the conversation this
// browser tab showed last, when that one is in the file's space, else the
// space's session with the latest activity. Picking another in the composer
// makes it the remembered one, so the next file in the space goes there too.
// Kept in sessionStorage: each browser tab has its own "where I came from".
import { useSyncExternalStore } from 'react';
import { isStopNote, type ChatItem, type ChatState } from './sdkChat';

export interface FileChatTarget {
  projectId: string;
  workstream: string;
  /** What the composer calls it: Claude's title, else the project (and workstream). */
  name: string;
  /** The tab order in the space, for the picker. */
  order: number;
  /** Last status write (ms), the "most recently active" clock; null when unknown. */
  activeAt: number | null;
}

export const LAST_CHAT_KEY = 'termag.chat.fileChatTarget.v1';

export function fileChatTargetKey(t: { projectId: string; workstream: string }): string {
  return `${t.projectId}|${t.workstream}`;
}

function session(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

/** The conversation this browser tab showed (or was told to talk to) last, or null. */
export function readLastChat(store: Storage | null = session()): { projectId: string; workstream: string } | null {
  try {
    const raw = store?.getItem(LAST_CHAT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { projectId?: unknown; workstream?: unknown };
    return typeof v.projectId === 'string' && v.projectId && typeof v.workstream === 'string' && v.workstream
      ? { projectId: v.projectId, workstream: v.workstream } : null;
  } catch { return null; }
}

/** A conversation was shown, or picked as the file composer's target. */
export function noteLastChat(ref: { projectId: string; workstream: string }, store: Storage | null = session()): void {
  try { store?.setItem(LAST_CHAT_KEY, JSON.stringify({ projectId: ref.projectId, workstream: ref.workstream })); } catch { /* blocked: the default falls back to activity */ }
}

/**
 * Where a message goes unless the person picks another: the remembered
 * conversation when it is one of `targets`, else the one with the latest
 * activity (the first in tab order on a tie, or when none has a clock).
 */
export function defaultFileChatTarget(targets: readonly FileChatTarget[], last: { projectId: string; workstream: string } | null): FileChatTarget | null {
  if (!targets.length) return null;
  if (last) {
    const key = fileChatTargetKey(last);
    const hit = targets.find(t => fileChatTargetKey(t) === key);
    if (hit) return hit;
  }
  return [...targets].sort((a, b) => (b.activeAt ?? -Infinity) - (a.activeAt ?? -Infinity) || a.order - b.order)[0];
}

/** The message as sent: what was typed, then a line saying which file the person is looking at. */
export function fileChatMessage(text: string, space: string, path: string): string {
  const typed = text.trim();
  // Once only: a "Not sent" message sent again already carries it.
  if (splitViewingLine(typed).viewing) return typed;
  const line = `(viewing ${space}:${path})`;
  return typed ? `${typed}\n\n${line}` : line;
}

const VIEWING_LINE = /(?:^|\n\n)(\(viewing [^\s:()]+:[^\n]+\))$/;

/**
 * A message's text and the "(viewing space:path)" line the file view adds
 * after it, which the conversation draws quieter (chat/UserMessageText.tsx);
 * `viewing` is null for any other message.
 */
export function splitViewingLine(text: string): { body: string; viewing: string | null } {
  const m = VIEWING_LINE.exec(text);
  return m ? { body: text.slice(0, m.index), viewing: m[1] } : { body: text, viewing: null };
}


export type FileChatPhase = 'queued' | 'working' | 'done' | 'failed' | 'stopped';

export interface FileChatReply {
  phase: FileChatPhase;
  /** The latest text the agent wrote after the message, or null before it has written any. */
  text: string | null;
}

/** A message sent from the file view: its text, and which bubble with that text it is (1 = the first in view; 0 = sent before the history answered, so it is the next one after what the history holds). */
export interface FileChatSent { message: string; occurrence: number }

/** How many bubbles in `state` carry `message`'s text. */
export function countSent(state: ChatState, message: string): number {
  return state.items.filter(it => it.kind === 'user' && it.text.trim() === message.trim()).length;
}

/**
 * What became of `sent` in the target's chat: still waiting behind a turn
 * (its bubble is pending, or not in view yet), being answered, or answered,
 * with the newest text after it. Its bubble is the `occurrence`th with its
 * text, counted when it was sent, so the same words sent again follow the
 * new bubble, not the old one's answer.
 */
export function fileChatReply(state: ChatState, sent: FileChatSent): FileChatReply {
  let at = -1;
  let seen = 0;
  for (let i = 0; i < state.items.length; i++) {
    const it = state.items[i];
    if (it.kind === 'user' && it.text.trim() === sent.message.trim() && ++seen === sent.occurrence) { at = i; break; }
  }
  const mine = at >= 0 ? state.items[at] as Extract<ChatItem, { kind: 'user' }> : null;
  if (!mine || mine.pending) return { phase: 'queued', text: null };
  // The answer runs up to the next message; one after ours means ours was answered before it.
  const rest = state.items.slice(at + 1);
  const next = rest.findIndex(it => it.kind === 'user');
  const after = next >= 0 ? rest.slice(0, next) : rest;
  const textItem = [...after].reverse().find(it => it.kind === 'text' && it.text.trim());
  const text = textItem?.kind === 'text' ? textItem.text : null;
  if (state.running && next < 0) return { phase: 'working', text };
  const last = after[after.length - 1];
  if (last?.kind === 'error') return { phase: 'failed', text: text ?? last.text };
  if (isStopNote(last)) return { phase: 'stopped', text };
  return { phase: 'done', text };
}

export function fileChatPhaseText(phase: FileChatPhase, live: boolean): string {
  switch (phase) {
    case 'queued': return live ? 'Sent · it reads this at its next step' : 'Queued · sent after the current turn';
    case 'working': return 'Working…';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    case 'stopped': return 'Stopped';
  }
}

// A `termag-compose:` link clicked in a space's file (chat/markdownParse.ts
// composeLinkText) puts its text in that space's composer under it. A click
// never sends, and a link reaches only the composer of the file's own space.
type ComposeFill = (text: string) => void;
const composeFills = new Map<string, Set<ComposeFill>>();

const listening = new Set<() => void>();
function changed(): void { for (const l of listening) l(); }

/** The composer under a file of `space` listens for link fills while it is mounted. */
export function onComposeFill(space: string, fn: ComposeFill): () => void {
  const fills = composeFills.get(space) ?? new Set<ComposeFill>();
  fills.add(fn);
  composeFills.set(space, fills);
  changed();
  return () => {
    fills.delete(fn);
    if (!fills.size) composeFills.delete(space);
    changed();
  };
}

/** Whether a composer for `space` is there to take a link's text: until one is, compose links stay plain text. */
export function useComposeListening(space: string): boolean {
  return useSyncExternalStore(
    l => { listening.add(l); return () => { listening.delete(l); }; },
    () => (composeFills.get(space)?.size ?? 0) > 0,
    () => false,
  );
}

/** A compose link in a file of `space` was clicked. */
export function requestComposeFill(space: string, text: string): void {
  for (const fn of composeFills.get(space) ?? []) fn(text);
}

/**
 * Whether the person may message agents from a file of `space`: an owner or
 * editor of it, as the spaces list says (their effective role: a read-only
 * space caps everyone at viewer). A viewer reads the space and nothing more,
 * and someone who isn't a member (a file shared with all of termag, #718)
 * has no role in it at all, so neither gets the composer or live Do it links.
 */
export function canComposeIn(spaces: ReadonlyArray<{ name: string; role?: string }>, space: string): boolean {
  const role = spaces.find(s => s.name === space)?.role;
  return role === 'owner' || role === 'editor';
}

/**
 * What the message box holds after a link puts `text` in. An empty box, or
 * one still holding exactly what the last link put there, takes the new
 * text instead (one click per action, so "merge #748" after "mark #761
 * ready" switches the action). Anything the person typed is kept, and the
 * text goes on a new line after it. `replaced` says which happened.
 */
export function filledDraft(current: string, lastFill: string | null, text: string): { draft: string; replaced: boolean } {
  if (!current.trim() || current === lastFill) return { draft: text, replaced: true };
  return { draft: `${current.trimEnd()}\n${text}`, replaced: false };
}
