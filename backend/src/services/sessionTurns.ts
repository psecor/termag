/**
 * Several Claude turns behind one status key. The desktop app's threads run Claude Code on
 * a box through the box's t3 server, in a project's checkout, and their hooks
 * post to that project's agent session (deploy/termag-status maps the hook's
 * checkout to the session), beside whatever the agent pane itself runs. Two
 * threads in one checkout, or a thread and the pane, then share one status
 * key, and the first to stop must not show the project idle while the other
 * still works.
 *
 * So a post reports one contributor's own turn, and the key's status is the
 * busiest of them: working while any contributor works, else waiting while any
 * waits, else what was posted. Contributors, per key:
 *
 *   t3:<threadId>  a desktop thread: source `t3:*`, threadId its Claude
 *                  session id (from the hook's stdin)
 *   pane           everything else posted for the key: the pane's own hooks,
 *                  bridge or chat runner (one agent, one contributor)
 *
 * A desktop post without a threadId (the PreToolUse hook reads no stdin) can't
 * be told apart: a working one passes as it is, any other ends every desktop
 * turn of the key, which is what the post meant before this module.
 *
 * A key no desktop turn has posted to is untouched: the post is the status, as
 * it always was. A working turn goes stale after AUTO_IDLE_MS (the auto-idle
 * safety net's window, so a turn whose Stop never came stops counting when the
 * session would have idled anyway), a waiting one after HYDRATE_MAX_AGE_MS.
 * Kept in memory only: after a restart the next post is taken as it comes.
 *
 * Notifications are not decided here: the route sends Slack, Discord and web
 * pushes for the post itself, so a thread that needs input while another works
 * still says so, and is shown waiting once nothing works.
 */
import type { AgentStatus } from '../types/index';
import { AUTO_IDLE_MS, HYDRATE_MAX_AGE_MS } from './statusPersistence';

/**
 * The box's t3 server's own tmux session (agent/t3-bridge.js SESSION_NAME).
 * A desktop thread in a directory that is no termag project's checkout posts
 * under it: box activity that no project owns, so it keeps the box awake and
 * books no working time.
 */
export const T3_SERVER_SESSION = 'termag-t3';

const PANE = 'pane';
const MAX_THREAD_ID = 200;

export interface TurnPost {
  status: AgentStatus['status'];
  source?: string;
  threadId?: string;
  message?: string;
  waitingReason?: AgentStatus['waitingReason'];
}

interface Turn extends TurnPost { at: number }

export type TurnTable = Map<string, Turn>;

/** A status from the desktop app's threads (the t3 server's Claude hooks). */
export function isDesktopSource(source: unknown): boolean {
  return typeof source === 'string' && source.startsWith('t3:');
}

function atRest(status: AgentStatus['status']): boolean {
  return status === 'idle' || status === 'not_running';
}

function stale(turn: Turn, now: number): boolean {
  const ttl = turn.status === 'working' ? AUTO_IDLE_MS : HYDRATE_MAX_AGE_MS;
  return now - turn.at > ttl;
}

function newest(turns: Turn[], status: AgentStatus['status']): Turn | undefined {
  let best: Turn | undefined;
  for (const t of turns) if (t.status === status && (!best || t.at > best.at)) best = t;
  return best;
}

/**
 * Pure: the table after `post`, and the status to write for the key. The
 * effective post is `post` itself (the same object) whenever it stands.
 */
export function settle(table: TurnTable | undefined, post: TurnPost, now: number): { table: TurnTable; effective: TurnPost } {
  const turns: TurnTable = new Map();
  for (const [id, t] of table ?? []) if (!stale(t, now)) turns.set(id, t);

  const desktop = isDesktopSource(post.source);
  const thread = typeof post.threadId === 'string' && post.threadId.length > 0 && post.threadId.length <= MAX_THREAD_ID
    ? post.threadId : null;
  const own = desktop ? (thread ? `t3:${thread}` : null) : PANE;
  if (own) {
    if (atRest(post.status)) turns.delete(own);
    else turns.set(own, { status: post.status, source: post.source, message: post.message, waitingReason: post.waitingReason, at: now });
  } else if (post.status !== 'working') {
    for (const id of [...turns.keys()]) if (id !== PANE) turns.delete(id);
  } else {
    // One of this key's working desktop turns is still at it (a PreToolUse,
    // which reads no stdin): keep them all from going stale, as the post
    // keeps the session's own auto-idle from firing.
    for (const [id, t] of turns) if (id !== PANE && t.status === 'working') turns.set(id, { ...t, at: now });
  }

  const anyDesktop = [...turns.keys()].some(id => id !== PANE);
  if ((!desktop && !anyDesktop) || post.status === 'working') return { table: turns, effective: post };

  const others = [...turns].filter(([id]) => id !== own).map(([, t]) => t);
  const working = newest(others, 'working');
  if (working) return { table: turns, effective: { status: 'working', source: working.source } };
  if (post.status === 'waiting') return { table: turns, effective: post };
  const waiting = newest(others, 'waiting');
  if (waiting) {
    return { table: turns, effective: { status: 'waiting', source: waiting.source, message: waiting.message, waitingReason: waiting.waitingReason } };
  }
  return { table: turns, effective: post };
}

const tables = new Map<string, TurnTable>();

/** Record `post` for status key `key`; returns what the key's status should be. */
export function settleTurnPost(key: string, post: TurnPost, now: number = Date.now()): TurnPost {
  const { table, effective } = settle(tables.get(key), post, now);
  if (table.size > 0) tables.set(key, table);
  else tables.delete(key);
  return effective;
}

/** The session is gone (deleteStatus): its turns go with it. */
export function forgetTurns(key: string): void {
  tables.delete(key);
}

/** The session was renamed (moveStatus): its turns go on under the new key. */
export function moveTurns(fromKey: string, toKey: string): void {
  const table = tables.get(fromKey);
  tables.delete(fromKey);
  if (table) tables.set(toKey, table);
  else tables.delete(toKey);
}

export function resetTurnsForTests(): void {
  tables.clear();
}
