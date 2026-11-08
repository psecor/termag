// The asks a chat sent, as the orchestrator says they stand (GET …/chat/asks),
// read again every few seconds while any
// of them, or a call in the chat that sent or waits for one, is still going,
// and while a finished one's finish notice is due (asks.ts askNoticePollMs).
// A pane chat has no calls to read, so it reads them by parent alone (usePaneAsks).
import { useEffect, useMemo, useRef, useState } from 'react';
import { chatApi } from '../services/api';
import { MAX_ASK_THREAD_IDS, NOTICE_POLL_SLOW_MS, askCallsOf, askNoticePollMs, askThreadIds, askViews, callThreads, paneAskViews, paneKeptAsks, type AskCall, type AskView, type ChatAskThread } from './asks';
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
 * GET …/chat/asks naming every one of `ids`, MAX_ASK_THREAD_IDS a read (the
 * most it takes), the reads at once: each answers its ids, the chat's newest
 * threads and every one still going (routes/chatAsks.ts askThreadsOf), so a
 * chat that named more than one read takes still reads each. The threads of
 * all the answers, oldest first; one failed read fails it.
 */
export async function readChatAsks(projectId: string, workstream: string, ids: readonly string[]): Promise<{ threads: ChatAskThread[] }> {
  const pages: (readonly string[])[] = [];
  for (let i = 0; i < ids.length; i += MAX_ASK_THREAD_IDS) pages.push(ids.slice(i, i + MAX_ASK_THREAD_IDS));
  if (pages.length <= 1) return chatApi.asks(projectId, workstream, ids);
  const answers = await Promise.all(pages.map(page => chatApi.asks(projectId, workstream, page)));
  const byId = new Map<string, ChatAskThread>();
  for (const a of answers) for (const t of a.threads) byId.set(t.id, t);
  return { threads: [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1)) };
}

/**
 * The threads by id, empty until the first read (and while `enabled` is
 * off). `ids` are the threads the chat's calls named (read in pages,
 * readChatAsks), `calls` how many ask
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
      let wait = ASK_POLL_MS;
      readChatAsks(projectId, workstream, ids)
        .then(r => {
          if (!alive) return;
          const got = new Map(r.threads.map(t => [t.id, t]));
          // Only a change redraws the chat.
          const json = JSON.stringify(r.threads);
          if (json !== last.current) { last.current = json; setThreads(got); }
          const missing = ids.some(id => !got.has(id));
          misses = missing ? misses + 1 : 0;
          again = again || r.threads.some(going) || (missing && misses < ASK_MISSING_POLLS);
          const notice = again ? null : askNoticePollMs(r.threads, Date.now(), ASK_POLL_MS);
          if (notice != null) { again = true; wait = notice; }
        })
        .catch(() => { again = again || misses < ASK_MISSING_POLLS; misses += 1; })
        .finally(() => { if (alive && again) timer = setTimeout(read, wait); });
    };
    read();
    return () => { alive = false; clearTimeout(timer); };
    // ids is read through key.
  }, [enabled, projectId, workstream, key, callsRunning]);
  return enabled ? threads : NONE;
}

/** What a pane chat knows of its asks: `off` (not read for it), `loading` (no answer yet), or the threads. */
export type PaneAsks = { state: 'off' | 'loading'; threads: ReadonlyMap<string, ChatAskThread> } | { state: 'ready'; threads: ReadonlyMap<string, ChatAskThread> };

/**
 * A pane chat's threads by id (ChatView.tsx): every ask the orchestrator
 * recorded the pane as sending, read by parent alone, since a pane has no
 * Bash calls to name them. Read when the chat opens and whenever `working`
 * changes, then every ASK_POLL_MS while the pane's agent works (it may send
 * one at any moment) or any ask is going, and for a finished one's due
 * notice. A failed read is tried again for up to a minute while nothing
 * else keeps it reading, and once a minute after that until the chat has
 * had its first answer; a 404 is an answer (none) and stops it. Each answer is the chat's it was read for
 * (`projectId|workstream`): another chat's is never shown, and until the
 * first answer for this one the state is `loading`.
 */
export function usePaneAsks(projectId: string, workstream: string, working: boolean, enabled: boolean): PaneAsks {
  const key = `${projectId}|${workstream}`;
  const [got, setGot] = useState<{ key: string; threads: ReadonlyMap<string, ChatAskThread> } | null>(null);
  const last = useRef('');
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    const read = () => {
      let again = working;
      let wait = ASK_POLL_MS;
      chatApi.asks(projectId, workstream, [])
        .then(r => {
          if (!alive) return;
          misses = 0;
          // Only a change redraws the chat; the chat's key is part of it, so a switch always does.
          const sig = `${key}\n${JSON.stringify(r.threads)}`;
          if (sig !== last.current) { last.current = sig; setGot({ key, threads: new Map(r.threads.map(t => [t.id, t])) }); }
          again = again || r.threads.some(going);
          const notice = again ? null : askNoticePollMs(r.threads, Date.now(), ASK_POLL_MS);
          if (notice != null) { again = true; wait = notice; }
        })
        .catch((err: { response?: { status?: number } }) => {
          // A 404 (asks off for the caller, or the project gone) is an answer, even after others: none, and nothing to read again.
          if (err?.response?.status === 404) {
            if (alive && last.current !== `${key}\n[]`) { last.current = `${key}\n[]`; setGot({ key, threads: NONE }); }
            again = false;
            return;
          }
          // A failed read: again while the agent works, else for up to a minute, and then, until this
          // chat has had an answer (a restored ask tab waits on it), once a minute.
          misses += 1;
          if (again || misses < ASK_MISSING_POLLS) { again = true; return; }
          if (!last.current.startsWith(`${key}\n`)) { again = true; wait = NOTICE_POLL_SLOW_MS; }
        })
        .finally(() => { if (alive && again) timer = setTimeout(read, wait); });
    };
    read();
    return () => { alive = false; clearTimeout(timer); };
  }, [enabled, key, projectId, workstream, working]);
  if (!enabled) return { state: 'off', threads: NONE };
  return got && got.key === key ? { state: 'ready', threads: got.threads } : { state: 'loading', threads: NONE };
}

const NO_CALLS: ReadonlyMap<string, AskCall> = new Map();
const NO_BY_CALL: ReadonlyMap<string, string[]> = new Map();
const NO_VIEWS: ReadonlyMap<string, AskView> = new Map();

/**
 * What a pane chat's asks read (ChatView.tsx): the ask rows' AsksUi, with no
 * calls (a pane has none to read; null while it has sent none), the asks
 * kept in view in the drawer on its composer (chat/asks.ts paneKeptAsks), and
 * the views for the ask tab (chat/askStore.ts): null until the first answer,
 * so a tab says it is loading rather than that its ask is gone, and none at
 * all while asks are off for this chat (`on` off, or a sharee: asks are
 * owner-only).
 */
export function usePaneAsksUi({ on, owner, projectId, workstream, working, open, shownThread, agent }: {
  on: boolean; owner: boolean; projectId: string; workstream: string; working: boolean;
  open: (view: AskView) => void; shownThread: string | null; agent: string;
}): { ui: AsksUi | null; kept: AskView[]; published: ReadonlyMap<string, AskView> | null } {
  const asks = usePaneAsks(projectId, workstream, working, on && owner && Boolean(projectId));
  const views = useMemo(() => paneAskViews(asks.threads), [asks.threads]);
  // Re-read the clock with the threads, and while any is kept, each minute, so a finished one leaves in time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!views.size) return undefined;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [views]);
  const kept = useMemo(() => paneKeptAsks(views, now), [views, now]);
  const ui = useMemo(() => (views.size > 0 ? { calls: NO_CALLS, byCall: NO_BY_CALL, views, open, shownThread, agent } : null),
    [views, open, shownThread, agent]);
  const published = asks.state === 'off' ? NO_VIEWS : asks.state === 'loading' ? null : views;
  return { ui, kept, published };
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
 * owner-only, so a sharee's view reads none. `agent`: what the words call
 * the chat's agent (chat/asks.ts askAgentName).
 */
export function useAsksUi({ on, owner, projectId, workstream, items, open, shownThread, agent }: {
  on: boolean; owner: boolean; projectId: string; workstream: string; items: readonly ChatItem[];
  open: (view: AskView) => void; shownThread: string | null; agent: string;
}): AsksUi | null {
  const calls = useMemo(() => (on && owner ? askCallsOf(items) : EMPTY_CALLS), [on, owner, items]);
  const tools = useMemo(() => askTools(items, calls), [items, calls]);
  const ids = useMemo(() => askThreadIds(calls.values()), [calls]);
  const callsRunning = [...tools.values()].some(t => !t.done || t.background === 'running');
  const threads = useChatAsks(projectId, workstream, ids, calls.size, callsRunning, calls.size > 0);
  const byCall = useMemo(() => callThreads(calls, tools, threads), [calls, tools, threads]);
  const views = useMemo(() => askViews(calls, byCall, tools, threads), [calls, byCall, tools, threads]);
  return useMemo(() => (calls.size > 0 ? { calls, byCall, views, open, shownThread, agent } : null), [calls, byCall, views, open, shownThread, agent]);
}
