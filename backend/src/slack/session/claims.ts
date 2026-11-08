/**
 * Who a Slack agent thread belongs to and what it resumes, and the runs in
 * flight (moved from agentSession.ts, M2): thread owners, Claude sessions and
 * a DM's carry-over, thread bindings, the store they are saved through, the
 * cross-process run claim, the caps, and the restart stop.
 */

import { randomUUID } from 'crypto';
import { isPersonalBinding, parseThreadScope, PERSONAL_BINDING, type ThreadBinding, type ThreadScope } from './scope';

const MAX_THREADS = 500;

export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** How long an agent turn may run; the Stop button ends one sooner. */
export const AGENT_TIMEOUT_MS = Math.max(1, parseInt(process.env.SLACK_AGENT_TIMEOUT_MINUTES ?? '', 10) || 30) * 60 * 1000;
/**
 * How often a running turn re-sends `processing`: a stream that times out moves
 * the session to `active`, and "Working…" should come back while Claude still works.
 */
export const STATUS_KEEPALIVE_MS = 3 * 60 * 1000;

const CARRY_OVER_MS = 30 * 60 * 1000;

/**
 * Where thread sessions and owners are saved, so a restart or a lease handover
 * keeps them (agentStore.ts, Postgres). Reads stay on the maps below; every
 * write goes through to the store. Null in tests and with Slack off.
 */
export interface AgentThreadStore {
  saveThread(channelId: string, threadTs: string, fields: {
    ownerSlackId?: string; claudeSessionId?: string | null; workingDir?: string | null; resetAt?: Date | null;
    scope?: ThreadScope; spaceId?: string | null; routeSeq?: number; frozenAt?: Date | null;
  }): void;
  saveDmLast(channelId: string, last: { claudeSessionId: string; workingDir: string; at: Date; spaceId?: string | null }): void;
  deleteDmLast(channelId: string): void;
  /** Settles once this thread's (and the DM's) queued writes have landed. */
  flush(channelId: string, threadTs: string, dmChannel?: string): Promise<void>;
  /** Settles once every queued write has landed. */
  flushAll(): Promise<void>;
  /** Whether `holder` may run a turn in the thread now (no other live holder). */
  claimRun(channelId: string, threadTs: string, holder: string): Promise<boolean>;
  renewRun(channelId: string, threadTs: string, holder: string): void;
  releaseRun(channelId: string, threadTs: string, holder: string): Promise<void>;
}

/** This process, as a run claim's holder. */
export const RUN_HOLDER = randomUUID();
/** How often a running turn renews its claim, and when a claim nobody renews lapses. */
export const RUN_BEAT_MS = 60 * 1000;
export const RUN_STALE_MS = 3 * 60 * 1000;

/**
 * Claims the thread for a turn across processes: during a lease handover the
 * old holder may still be running claude in it, and two runs must not resume
 * one session. True without a store, and when the store cannot answer (logged):
 * the claim guards the handover, and the bot should not go dark over it.
 */
export async function claimThreadRun(key: string): Promise<boolean> {
  if (!store) return true;
  const [channelId, threadTs] = splitKey(key);
  try {
    return await store.claimRun(channelId, threadTs, RUN_HOLDER);
  } catch (err) {
    console.error('[AGENT] could not claim the thread for a run:', (err as Error).message);
    return true;
  }
}

export function renewThreadRun(key: string): void {
  const [channelId, threadTs] = splitKey(key);
  store?.renewRun(channelId, threadTs, RUN_HOLDER);
}

/**
 * Awaited by the turn before it counts as finished, so a shutdown's wait covers
 * the write. The thread's own queued writes land first: once the claim is
 * free another process may save a newer session, which they must not overwrite.
 */
export async function releaseThreadRun(key: string, dmChannel?: string): Promise<void> {
  if (!store) return;
  const [channelId, threadTs] = splitKey(key);
  await store.flush(channelId, threadTs, dmChannel).catch(() => {});
  try {
    await store.releaseRun(channelId, threadTs, RUN_HOLDER);
  } catch (err) {
    console.error('[AGENT] Failed to release a run claim:', (err as Error).message);
  }
}

let store: AgentThreadStore | null = null;

export function setAgentThreadStore(next: AgentThreadStore | null): void {
  store = next;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

/** Drops the oldest entries (insertion order) past the cap. */
function trim<K>(m: Map<K, unknown> | Set<K>, onDrop?: (key: K) => void): void {
  while (m.size > MAX_THREADS) {
    const oldest = m.keys().next().value as K;
    m.delete(oldest);
    onDrop?.(oldest);
  }
}

/** One Claude session per thread, kept while the thread's working directory holds. */
const claudeSessions = new Map<string, { sessionId: string; workingDir: string }>();
/** The last session in each DM, which a new thread soon after picks up (only under the same space binding). */
const lastInChannel = new Map<string, { sessionId: string; workingDir: string; at: number; spaceId: string | null }>();
/** Threads bound to something other than a personal conversation (session/scope.ts); absent means personal. */
const threadBindings = new Map<string, ThreadBinding>();
/** Threads whose conversation was reset on purpose: starting fresh there needs no explaining. */
const resetThreads = new Set<string>();

export function rememberClaudeSession(
  key: string, sessionId: string, workingDir: string, channel?: string, now: number = Date.now(),
): void {
  claudeSessions.delete(key);
  claudeSessions.set(key, { sessionId, workingDir });
  trim(claudeSessions);
  resetThreads.delete(key);
  const [channelId, threadTs] = splitKey(key);
  store?.saveThread(channelId, threadTs, { claudeSessionId: sessionId, workingDir, resetAt: null });
  if (channel) {
    const spaceId = threadBindingOf(key).spaceId;
    lastInChannel.set(channel, { sessionId, workingDir, at: now, spaceId });
    // Absent means personal; the store writes null for it, so it clears an earlier space.
    store?.saveDmLast(channel, { claudeSessionId: sessionId, workingDir, at: new Date(now), ...(spaceId && { spaceId }) });
  }
}

/** What the thread is bound to: its scope, space, route seq and freeze. Personal unless set. */
export function threadBindingOf(key: string): ThreadBinding {
  return threadBindings.get(key) ?? PERSONAL_BINDING;
}

/** Binds the thread (saved through the store); a personal binding just clears it. */
export function setThreadBinding(key: string, binding: ThreadBinding): void {
  threadBindings.delete(key);
  if (!isPersonalBinding(binding)) {
    threadBindings.set(key, { ...binding });
    trim(threadBindings);
  }
  const [channelId, threadTs] = splitKey(key);
  store?.saveThread(channelId, threadTs, {
    scope: binding.scope, spaceId: binding.spaceId, routeSeq: binding.routeSeq, frozenAt: binding.frozenAt,
  });
}

/**
 * The thread's session, else (with `channel`) the DM's last one if it is under
 * half an hour old: a new message soon after is the same conversation, though
 * Slack opens a new thread for it. Pass `channel` only for a new DM thread.
 */
export function claudeSessionFor(
  key: string, workingDir: string, channel?: string, now: number = Date.now(),
): { sessionId: string; carried: boolean } | undefined {
  const s = claudeSessions.get(key);
  if (s) return s.workingDir === workingDir ? { sessionId: s.sessionId, carried: false } : undefined;
  const last = channel ? lastInChannel.get(channel) : undefined;
  // Carry-over stays within one binding: a space's conversation never carries into a personal thread, or back.
  return last && last.workingDir === workingDir && now - last.at < CARRY_OVER_MS && last.spaceId === threadBindingOf(key).spaceId
    ? { sessionId: last.sessionId, carried: true }
    : undefined;
}

/**
 * What is known of a thread's conversation, for a reply in it: `resumable`, or
 * `moved` (it ran in another working directory, the active project has changed
 * since), `reset` (on purpose), or `none` (never seen, or long forgotten).
 */
export function threadHistory(key: string, workingDir: string): 'resumable' | 'moved' | 'reset' | 'none' {
  const s = claudeSessions.get(key);
  if (s) return s.workingDir === workingDir ? 'resumable' : 'moved';
  return resetThreads.has(key) ? 'reset' : 'none';
}

/** Who started each channel thread's session: the only one it answers. */
const threadOwners = new Map<string, string>();

export function threadOwnerOf(key: string): string | undefined {
  return threadOwners.get(key);
}

/**
 * The thread's owner, making `userId` the owner when it has none yet. A thread
 * that loses its owner to the cap loses its Claude session with it, so whoever
 * claims it next starts fresh instead of resuming someone else's conversation.
 */
export function claimThread(key: string, userId: string): string {
  const known = threadOwners.get(key);
  const owner = known ?? userId;
  // Most recently used last, so the cap evicts idle threads first.
  threadOwners.delete(key);
  threadOwners.set(key, owner);
  trim(threadOwners, evicted => claudeSessions.delete(evicted));
  if (!known) {
    // A claim never inherits a conversation: if a saved one exists that memory
    // does not know of yet (its load failed or has not landed), it is cleared,
    // never handed to whoever spoke first.
    claudeSessions.delete(key);
    const [channelId, threadTs] = splitKey(key);
    store?.saveThread(channelId, threadTs, { ownerSlackId: owner, claudeSessionId: null, workingDir: null });
  }
  return owner;
}

/**
 * "new session" / "reset" / "clear": the thread's Claude session is forgotten,
 * and in a DM so is the conversation a new thread would carry over. In a channel
 * thread only its owner may do that; returns the owner who may otherwise.
 */
export function resetAgentConversation(args: {
  channel: string; threadTs: string; userId: string; inDM: boolean;
}): { reset: true } | { reset: false; owner: string } {
  const key = threadKey(args.channel, args.threadTs);
  if (!args.inDM) {
    const owner = threadOwners.get(key);
    if (owner && owner !== args.userId) return { reset: false, owner };
  }
  claudeSessions.delete(key);
  resetThreads.add(key);
  trim(resetThreads);
  store?.saveThread(args.channel, args.threadTs, { claudeSessionId: null, workingDir: null, resetAt: new Date() });
  if (args.inDM) {
    lastInChannel.delete(args.channel);
    store?.deleteDmLast(args.channel);
  }
  return { reset: true };
}

export type StoredAgentThread = {
  channelId: string; threadTs: string; ownerSlackId: string | null; claudeSessionId: string | null;
  workingDir: string | null; resetAt: Date | null; updatedAt: Date;
  /** Absent in rows read before the binding columns existed: personal. */
  scope?: string | null; spaceId?: string | null; routeSeq?: number | null; frozenAt?: Date | null;
};
export type StoredDmLast = { channelId: string; claudeSessionId: string; workingDir: string; at: Date; spaceId?: string | null };

/**
 * Fills the maps from saved rows (agentStore.ts loadAgentThreads), oldest first so
 * the newest are the last evicted. What this process has set since stays: a
 * row never replaces a live entry.
 */
export function hydrateAgentThreads(threads: StoredAgentThread[], dms: StoredDmLast[], now: number = Date.now()): void {
  for (const t of [...threads].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())) {
    const key = threadKey(t.channelId, t.threadTs);
    const liveOwner = threadOwners.get(key);
    // Someone else owns the thread here now: its saved conversation is not theirs.
    if (liveOwner && t.ownerSlackId && liveOwner !== t.ownerSlackId) continue;
    if (t.ownerSlackId && !liveOwner) threadOwners.set(key, t.ownerSlackId);
    const binding: ThreadBinding = {
      scope: parseThreadScope(t.scope), spaceId: t.spaceId ?? null, routeSeq: t.routeSeq ?? 0, frozenAt: t.frozenAt ?? null,
    };
    if (!threadBindings.has(key) && !isPersonalBinding(binding)) threadBindings.set(key, binding);
    if (claudeSessions.has(key) || resetThreads.has(key)) continue;
    if (t.claudeSessionId && t.workingDir) claudeSessions.set(key, { sessionId: t.claudeSessionId, workingDir: t.workingDir });
    else if (t.resetAt) resetThreads.add(key);
  }
  trim(threadOwners, evicted => claudeSessions.delete(evicted));
  trim(claudeSessions);
  trim(resetThreads);
  trim(threadBindings);
  for (const d of dms) {
    const at = d.at.getTime();
    if (now - at < CARRY_OVER_MS && !lastInChannel.has(d.channelId)) {
      lastInChannel.set(d.channelId, { sessionId: d.claudeSessionId, workingDir: d.workingDir, at, spaceId: d.spaceId ?? null });
    }
  }
}

export function resetAgentThreadsForTests(): void {
  claudeSessions.clear();
  lastInChannel.clear();
  resetThreads.clear();
  threadOwners.clear();
  threadBindings.clear();
}

/**
 * Runs in flight, by thread, and whose each is, so agent_session_stopped can end
 * them and a person's runs can be counted.
 *
 * This, like thread owners and Claude sessions, is process-local. That holds
 * while one process holds the Slack connection (with ORCHESTRATOR_LEASE only
 * the lease holder connects); a second live Socket Mode connection could get a
 * Stop or a button click for a run the other process is doing.
 */
export type AgentRunEntry = {
  controller: AbortController;
  userId: string;
  /** Puts the thread back on "Working…", unless the turn is already finishing. */
  keepAlive: () => void;
  /** Set before an abort that is not the user's Stop, so the turn can say why. */
  stopReason?: 'restart';
  /** Settles once the turn has said its last word. */
  finished: Promise<void>;
  /** The space a space thread's run is for, counted against its per-space cap (session/caps.ts). */
  spaceId?: string;
};

export const agentRuns = new Map<string, AgentRunEntry>();

/**
 * False from the moment this process starts letting go of the Slack connection
 * (stopAgentRunsForRestart) until it holds it again (acceptAgentRuns): an event
 * already on its way in must not start a turn the stop never sees.
 */
let acceptingRuns = true;

export function agentRunsAccepted(): boolean {
  return acceptingRuns;
}

/** Called when this process (again) holds the Slack connection. */
export function acceptAgentRuns(): void {
  acceptingRuns = true;
}

/**
 * For a shutdown, and whenever this process lets go of the Slack connection (a
 * lease handover, services/leaderOnly.ts): stops every run with a "termag is
 * restarting" note instead of leaving its thread on a half reply (or "Working…"
 * for an hour), and waits up to `waitMs` for those notes to go out. Otherwise
 * the next holder, which loads the same saved sessions, could start a second
 * `claude` on a session this one is still running. Returns how many it stopped.
 */
export function stopAgentRunsForRestart(waitMs: number = 4000): Promise<number> {
  // Synchronously, before the caller does anything else: a turn that starts
  // after the snapshot below would never be stopped.
  acceptingRuns = false;
  const runs = [...agentRuns.values()];
  for (const run of runs) {
    run.stopReason = 'restart';
    run.controller.abort();
  }
  return waitFor(runs, waitMs);
}

async function waitFor(runs: AgentRunEntry[], waitMs: number): Promise<number> {
  // The runs, then any write still queued outside one (a reset, an owner), so
  // none lands after the next process has saved over it.
  await Promise.race([
    Promise.allSettled(runs.map(r => r.finished)).then(() => store?.flushAll()),
    new Promise(resolve => setTimeout(resolve, waitMs).unref?.()),
  ]);
  return runs.length;
}

/** How many agent runs one person may have going at once (30-minute, bypassPermissions runs). */
export const MAX_AGENT_RUNS_PER_USER = 3;

/**
 * How many agent runs may go at once for everyone together. Every operator's
 * turn is a `claude` on the orchestrator host, billed to its one Claude login,
 * so the per-person cap alone still allows a run per allowed user times three.
 * SLACK_AGENT_MAX_RUNS overrides it.
 */
export const MAX_AGENT_RUNS_TOTAL = Math.max(1, parseInt(process.env.SLACK_AGENT_MAX_RUNS ?? '', 10) || 6);

/** Whether another run may start now under the global cap (agentRuns holds this process's runs). */
export function globalRunCapReached(max: number = MAX_AGENT_RUNS_TOTAL): boolean {
  return agentRuns.size >= max;
}

export function runsFor(userId: string): number {
  let n = 0;
  for (const run of agentRuns.values()) if (run.userId === userId) n++;
  return n;
}

/**
 * Whether `userId` may stop the run in this thread: the person it is running
 * for. Nobody else in a shared channel may end someone's run.
 */
export function mayStopRun(key: string, userId: string): boolean {
  return agentRuns.get(key)?.userId === userId;
}
