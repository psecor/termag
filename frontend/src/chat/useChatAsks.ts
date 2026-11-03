// The asks a chat sent, as the orchestrator says they stand (GET …/chat/asks),
// read again every few seconds while any
// of them, or a call in the chat that sent or waits for one, is still going.
import { useEffect, useMemo, useRef, useState } from 'react';
import { chatApi } from '../services/api';
import { askCallsOf, askThreadIds, askViews, callThreads, type AskCall, type AskView, type ChatAskThread } from './asks';
import type { ChatItem } from './sdkChat';
import type { AsksUi } from '../pages/chat/Asks';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** How often the asks are read while one is going. */
export const ASK_POLL_MS = 5000;
/** How many reads a thread the chat named may stay missing before polling stops waiting for it (a minute). */
export const ASK_MISSING_POLLS = 12;

const ACTIVE = new Set(['submitted', 'working']);
const going = (t: ChatAskThread) => t.messages.some(m => ACTIVE.has(m.status));
const NONE: ReadonlyMap<string, ChatAskThread> = new Map();

/**
 * The threads by id, empty until the first read (and while `enabled` is
 * off). `ids` are the threads the chat's calls named, `calls` how many ask
 * calls the chat has (a follow-up on a thread already named is a new call
 * with no new id, and is read again for), and `callsRunning` says a call that
 * sends or waits for an ask is still going.
 */
export function useChatAsks(projectId: string, workstream: string, ids: readonly string[], calls: number, callsRunning: boolean, enabled: boolean): ReadonlyMap<string, ChatAskThread> {
  const [threads, setThreads] = useState<ReadonlyMap<string, ChatAskThread>>(NONE);
  const last = useRef('');
  const key = `${ids.join(',')}|${calls}`;
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    const read = () => {
      let again = callsRunning;
      chatApi.asks(projectId, workstream, ids)
        .then(r => {
          if (!alive) return;
          const got = new Map(r.threads.map(t => [t.id, t]));
          // Only a change redraws the chat.
          const json = JSON.stringify(r.threads);
          if (json !== last.current) { last.current = json; setThreads(got); }
          const missing = ids.some(id => !got.has(id));
          misses = missing ? misses + 1 : 0;
          again = again || r.threads.some(going) || (missing && misses < ASK_MISSING_POLLS);
        })
        .catch(() => { again = again || misses < ASK_MISSING_POLLS; misses += 1; })
        .finally(() => { if (alive && again) timer = setTimeout(read, ASK_POLL_MS); });
    };
    read();
    return () => { alive = false; clearTimeout(timer); };
    // ids is read through key.
  }, [enabled, projectId, workstream, key, callsRunning]);
  return enabled ? threads : NONE;
}

/** The tool items by id that are ask calls. */
function askTools(items: readonly ChatItem[], calls: ReadonlyMap<string, AskCall>): Map<string, ToolItem> {
  const out = new Map<string, ToolItem>();
  for (const it of items) if (it.kind === 'tool' && calls.has(it.id)) out.set(it.id, it);
  return out;
}

const EMPTY_CALLS: ReadonlyMap<string, AskCall> = new Map();

/**
 * What the chat's ask rows read (pages/chat/Asks.tsx AsksContext): its
 * `termag ask` calls, the threads they are about and how each stands. Null
 * while `on` is off or the chat has no ask calls. `owner`: asks are
 * owner-only, so a sharee's view reads none.
 */
export function useAsksUi({ on, owner, projectId, workstream, items, open, shownThread }: {
  on: boolean; owner: boolean; projectId: string; workstream: string; items: readonly ChatItem[];
  open: (view: AskView) => void; shownThread: string | null;
}): AsksUi | null {
  const calls = useMemo(() => (on && owner ? askCallsOf(items) : EMPTY_CALLS), [on, owner, items]);
  const tools = useMemo(() => askTools(items, calls), [items, calls]);
  const ids = useMemo(() => askThreadIds(calls.values()), [calls]);
  const callsRunning = [...tools.values()].some(t => !t.done || t.background === 'running');
  const threads = useChatAsks(projectId, workstream, ids, calls.size, callsRunning, calls.size > 0);
  const byCall = useMemo(() => callThreads(calls, tools, threads), [calls, tools, threads]);
  const views = useMemo(() => askViews(calls, byCall, tools, threads), [calls, byCall, tools, threads]);
  return useMemo(() => (calls.size > 0 ? { calls, byCall, views, open, shownThread } : null), [calls, byCall, views, open, shownThread]);
}
