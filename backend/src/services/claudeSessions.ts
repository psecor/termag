/**
 * Claude Code cloud sessions as the owner sees them
 *: the runs (ClaudeRunnerSession,
 * one per order) and the events (ClaudeSessionEvent) of one owner, grouped by
 * Anthropic session id into a view with a state, plus the two sweeps that
 * keep the records honest: `lost` for a run whose runner is gone without an
 * end report, and retention (events 30 days, runs 90 days).
 *
 * The pure half (buildSessions, deriveState, sessionUrl) is unit tested over
 * event sequences; the composition reads Prisma, the agent registry (one
 * `tmux-list` per box among the open runs, as the session inventory does) and
 * the in-memory status map is left to the route and the frontend, which key it
 * by (instanceId, runner tmux session name).
 */
import { prisma } from '../db';
import { nextSessionSeq } from './claudeRunnerSessions';
import { LAUNCH_SKEW_MS } from './launchSkew';
import { ownerPlacementKey, serializeByKey } from './claudeRunnerSpawn';
import { isInstanceAgentConnected, sendToInstanceAgent } from './agentRegistry';
import { parseRunnerSessions, runnerSessionName, tmuxSafe } from './claudeRunnerSpawn';
import { recordSessionEvent, type SessionEventKind } from './claudeSessionEvents';

export type CloudSessionState = 'queued' | 'starting' | 'running' | 'ended' | 'lost';

/** The run row with what the view needs from its box. */
export interface RunInput {
  orderId: string;
  sessionId: string | null;
  instanceId: string;
  boxName: string;
  hostUnixUser: string | null;
  slot: number;
  startedAt: Date;
  endedAt: Date | null;
  exitStatus: number | null;
  exitReason: string | null;
  clientPlatform: string | null;
  title: string | null;
  sessionSeq: number | null;
  /** The run's cumulative token usage, when the session has posted one (S4); absent on callers that do not select it. */
  usage?: RunUsageInput | null;
  /** From the ended report (S5); absent on callers that do not select them. */
  checkoutBytes?: bigint | null;
  kept?: boolean | null;
}

export interface RunUsageInput {
  inputTokens: bigint | null; outputTokens: bigint | null; cacheReadTokens: bigint | null; cacheCreateTokens: bigint | null;
  usageCalls: number | null; model: string | null; usageAt: Date | null;
}

/** A run's token usage as the UI reads it: plain numbers, summed total, the model and when it was summed. */
export interface RunUsage {
  input: number; output: number; cacheRead: number; cacheCreate: number; total: number;
  calls: number | null; model: string | null; at: string;
}

export function toRunUsage(u: RunUsageInput | null | undefined): RunUsage | null {
  if (!u || !u.usageAt) return null;
  const n = (b: bigint | null) => Number(b ?? 0n);
  const input = n(u.inputTokens), output = n(u.outputTokens), cacheRead = n(u.cacheReadTokens), cacheCreate = n(u.cacheCreateTokens);
  return { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate, calls: u.usageCalls, model: u.model, at: u.usageAt.toISOString() };
}

export interface EventInput {
  sessionId: string;
  orderId: string;
  instanceId: string | null;
  kind: string;
  detail: string | null;
  at: Date;
}

export interface CloudSessionRun {
  orderId: string;
  instanceId: string;
  boxName: string;
  slot: number;
  /** The runner's tmux session on the box: the status map key with instanceId. */
  sessionName: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  exitStatus: number | null;
  exitReason: string | null;
  /** true: the runner's tmux session is live; false: gone; null: the box did not answer. */
  alive: boolean | null;
  /** Token usage the session posted about itself; null until the first post. */
  usage: RunUsage | null;
  /** The session directory's size when it ended, from the box; null before the end or from an older wrapper. */
  checkoutBytes: number | null;
  /** The checkout was kept on the box because GitHub did not have all of its work. */
  kept: boolean | null;
}

export interface CloudSessionView {
  /** The Anthropic session id, or `order:<id>` for a run recorded before session ids were kept. */
  key: string;
  sessionId: string | null;
  url: string | null;
  /** The session's ordinal among the owner's sessions; null for a run from before numbering. */
  seq: number | null;
  /** "Claude Cloud 3", or "Claude Cloud" when the run has no number. The prompt title is separate. */
  name: string;
  title: string | null;
  clientPlatform: string | null;
  state: CloudSessionState;
  /** For `ended` and `lost`: the latest run's reason. */
  exitReason: string | null;
  /** For `queued`: why the spawn was refused, as the Activity tab shows it. */
  queuedReason: string | null;
  /**
   * For `queued`: when the current uninterrupted run of refusals began, so the
   * UI measures time queued, not time since the latest re-offer (the
   * orchestrator retries every few minutes and each retry writes an event).
   */
  queuedSince: string | null;
  /** The latest run, when there is one. */
  current: CloudSessionRun | null;
  runs: CloudSessionRun[];
  /** The first run's start, else the first event. */
  firstSeenAt: string;
  /** The newest signal of any kind. */
  lastSeenAt: string;
  eventCount: number;
}

/** The session's page on claude.ai: the `cse_` id with its prefix swapped (verified 2026-10-08). */
export function sessionUrl(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const m = /^(?:cse|session)_([A-Za-z0-9]+)$/.exec(sessionId);
  return m ? `https://claude.ai/code/session_${m[1]}` : null;
}

export const RUN_LOST_REASON = 'lost';
export const CLOUD_SESSION_NAME_PREFIX = 'Claude Cloud';

/** The display name every cloud session carries: the prefix and the owner's ordinal. */
export function cloudSessionName(seq: number | null): string {
  return seq == null ? CLOUD_SESSION_NAME_PREFIX : `${CLOUD_SESSION_NAME_PREFIX} ${seq}`;
}
const QUEUED_KINDS = new Set<string>(['queued', 'agent-failed']);

/** The grouping key: the session id, else the order id (rows from older versions). */
export function sessionKey(x: { sessionId: string | null; orderId: string }): string {
  return x.sessionId ?? `order:${x.orderId}`;
}

const iso = (d: Date) => d.toISOString();
const seconds = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));

function toRun(r: RunInput, alive: boolean | null): CloudSessionRun {
  return {
    orderId: r.orderId, instanceId: r.instanceId, boxName: r.boxName, slot: r.slot,
    sessionName: r.hostUnixUser ? runnerSessionName(r.hostUnixUser, r.slot, r.orderId) : null,
    startedAt: iso(r.startedAt), endedAt: r.endedAt ? iso(r.endedAt) : null,
    durationSec: r.endedAt ? seconds(r.startedAt, r.endedAt) : null,
    exitStatus: r.exitStatus, exitReason: r.exitReason, alive,
    usage: toRunUsage(r.usage),
    checkoutBytes: r.checkoutBytes != null ? Number(r.checkoutBytes) : null, kept: r.kept ?? null,
  };
}

/**
 * The state of one session from its newest run and its events, newest first.
 *
 * | state      | rule |
 * | queued     | no run, and the newest event is a refusal; or a refusal newer than the latest run (a re-offer while the old run lingers) |
 * | starting   | the latest run is open and the box has not posted `started` for it |
 * | running    | the latest run is open and `started` arrived |
 * | lost       | the latest run ended with reason `lost` |
 * | ended      | the latest run ended any other way; or no run and the newest event is not a refusal |
 */
export interface DerivedState { state: CloudSessionState; exitReason: string | null; queuedReason: string | null; queuedSince: Date | null }

/** The start of the newest unbroken run of refusals (events newest first), bounded below by `after`. */
function queuedStreakStart(events: EventInput[], after: Date | null): Date | null {
  let since: Date | null = null;
  for (const e of events) {
    if (after && e.at.getTime() <= after.getTime()) break;
    if (!QUEUED_KINDS.has(e.kind)) break;
    since = e.at;
  }
  return since;
}

/**
 * A box clock is trusted ten minutes either way by the event route, so a
 * `started` stamped a little before the row's launch time is still this
 * launch's; one from well before it belongs to an earlier launch of the
 * same order (recordRunnerStart reopens the row with a new startedAt).
 */
export const STARTED_SKEW_MS = LAUNCH_SKEW_MS;

/** Is this `started` event the current launch's, not an earlier launch of the same order? */
export function isStartedFor(e: Pick<EventInput, 'kind' | 'orderId' | 'at'>, run: Pick<RunInput, 'orderId' | 'startedAt'>): boolean {
  return e.kind === 'started' && e.orderId === run.orderId && e.at.getTime() >= run.startedAt.getTime() - STARTED_SKEW_MS;
}

export function deriveState(latest: RunInput | null, events: EventInput[]): DerivedState {
  const none = { exitReason: null, queuedReason: null, queuedSince: null };
  const newest = events[0] ?? null;
  const refusal = newest && QUEUED_KINDS.has(newest.kind) ? newest : null;
  if (!latest) {
    return refusal
      ? { state: 'queued', exitReason: null, queuedReason: refusal.detail, queuedSince: queuedStreakStart(events, null) }
      : { state: 'ended', ...none };
  }
  if (refusal && refusal.orderId !== latest.orderId && refusal.at.getTime() > latest.startedAt.getTime()) {
    return { state: 'queued', exitReason: null, queuedReason: refusal.detail, queuedSince: queuedStreakStart(events, latest.startedAt) };
  }
  if (latest.endedAt) {
    return { state: latest.exitReason === RUN_LOST_REASON ? 'lost' : 'ended', exitReason: latest.exitReason, queuedReason: null, queuedSince: null };
  }
  const started = events.some(e => isStartedFor(e, latest));
  return { state: started ? 'running' : 'starting', ...none };
}

/** Group runs and events into sessions, newest activity first. */
export function buildSessions(runs: RunInput[], events: EventInput[], alive: Map<string, boolean | null>): CloudSessionView[] {
  const byKey = new Map<string, { runs: RunInput[]; events: EventInput[] }>();
  const bucket = (key: string) => {
    let b = byKey.get(key);
    if (!b) { b = { runs: [], events: [] }; byKey.set(key, b); }
    return b;
  };
  for (const r of runs) bucket(sessionKey(r)).runs.push(r);
  for (const e of events) bucket(e.sessionId).events.push(e);

  const out: CloudSessionView[] = [];
  for (const [key, b] of byKey) {
    b.runs.sort((x, y) => y.startedAt.getTime() - x.startedAt.getTime());
    b.events.sort((x, y) => y.at.getTime() - x.at.getTime());
    const latest = b.runs[0] ?? null;
    const titled = b.runs.find(r => r.title) ?? null;
    const numbered = b.runs.find(r => r.sessionSeq != null) ?? null;
    const platform = b.runs.find(r => r.clientPlatform) ?? null;
    const { state, exitReason, queuedReason, queuedSince } = deriveState(latest, b.events);
    const sessionId = latest?.sessionId ?? (key.startsWith('order:') ? null : key);
    const times = [...b.runs.map(r => r.startedAt), ...b.events.map(e => e.at)].map(d => d.getTime());
    const ends = b.runs.map(r => r.endedAt?.getTime() ?? 0);
    const first = new Date(Math.min(...times));
    const last = new Date(Math.max(...times, ...ends));
    out.push({
      key, sessionId, url: sessionUrl(sessionId),
      seq: numbered?.sessionSeq ?? null, name: cloudSessionName(numbered?.sessionSeq ?? null),
      title: titled?.title ?? null, clientPlatform: platform?.clientPlatform ?? null,
      state, exitReason, queuedReason, queuedSince: queuedSince ? iso(queuedSince) : null,
      current: latest ? toRun(latest, alive.get(latest.orderId) ?? null) : null,
      runs: b.runs.map(r => toRun(r, alive.get(r.orderId) ?? null)),
      firstSeenAt: iso(first), lastSeenAt: iso(last), eventCount: b.events.length,
    });
  }
  out.sort((x, y) => y.lastSeenAt.localeCompare(x.lastSeenAt));
  return out;
}

export const ACTIVE_STATES: ReadonlySet<CloudSessionState> = new Set(['queued', 'starting', 'running']);

// ── Composition ─────────────────────────────────────────────────────────────

/** The usage columns every run select carries (S4). */
export const usageSelect = {
  inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreateTokens: true, usageCalls: true, model: true, usageAt: true,
  checkoutBytes: true, kept: true,
} as const;

const runSelect = {
  orderId: true, sessionId: true, instanceId: true, slot: true, startedAt: true, endedAt: true,
  exitStatus: true, exitReason: true, clientPlatform: true, title: true, sessionSeq: true, ...usageSelect,
  instance: { select: { name: true, hostUnixUser: true, status: true } },
} as const;

type RunRow = RunUsageInput & { checkoutBytes: bigint | null; kept: boolean | null } & {
  orderId: string; sessionId: string | null; instanceId: string; slot: number; startedAt: Date; endedAt: Date | null;
  exitStatus: number | null; exitReason: string | null; clientPlatform: string | null; title: string | null; sessionSeq: number | null;
  instance: { name: string; hostUnixUser: string | null; status: string };
};

const toInput = (r: RunRow): RunInput => ({
  orderId: r.orderId, sessionId: r.sessionId, instanceId: r.instanceId, boxName: r.instance.name, hostUnixUser: r.instance.hostUnixUser,
  slot: r.slot, startedAt: r.startedAt, endedAt: r.endedAt, exitStatus: r.exitStatus, exitReason: r.exitReason,
  clientPlatform: r.clientPlatform, title: r.title, sessionSeq: r.sessionSeq, usage: r, checkoutBytes: r.checkoutBytes, kept: r.kept,
});

/**
 * The owner renames a session: the title on every run of it; null clears it.
 * Under the owner's placement lock, so a relaunch of the session cannot read
 * the old title before this write and then insert its run carrying it.
 * Returns the runs touched.
 */
export async function renameCloudSession(userId: string, key: string, title: string | null): Promise<number> {
  const where = key.startsWith('order:') ? { userId, orderId: key.slice('order:'.length) } : { userId, sessionId: key };
  return serializeByKey(ownerPlacementKey(userId), async () => {
    const r = await prisma.claudeRunnerSession.updateMany({ where, data: { title } });
    return r.count;
  });
}

/**
 * Number the sessions recorded before `sessionSeq` existed, once, at startup:
 * per owner, by the session's first start, each number drawn from the
 * owner's counter under the same per-owner lock the spawn route places
 * under, so a placement during the backfill can neither share a number nor
 * slip between two of the backfill's. Runs without a session id stay
 * unnumbered.
 */
export async function backfillSessionSeq(): Promise<number> {
  const rows = await prisma.claudeRunnerSession.findMany({
    where: { sessionSeq: null, sessionId: { not: null } },
    select: { userId: true, sessionId: true, startedAt: true },
    orderBy: { startedAt: 'asc' },
  });
  if (rows.length === 0) return 0;
  const byUser = new Map<string, string[]>();
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    if (!list.includes(r.sessionId!)) list.push(r.sessionId!);
    byUser.set(r.userId, list);
  }
  let numbered = 0;
  for (const [userId, sessions] of byUser) {
    await serializeByKey(ownerPlacementKey(userId), async () => {
      for (const sessionId of sessions) {
        // Re-checked under the lock: a placement of this session may have numbered it meanwhile.
        const already = await prisma.claudeRunnerSession.findFirst({ where: { userId, sessionId, sessionSeq: { not: null } }, select: { sessionSeq: true } });
        const seq = already?.sessionSeq ?? await nextSessionSeq(userId);
        await prisma.claudeRunnerSession.updateMany({ where: { userId, sessionId, sessionSeq: null }, data: { sessionSeq: seq } });
        numbered++;
      }
    });
  }
  console.log(`[CLAUDE-RUNNER] numbered ${numbered} cloud session(s) from before sessionSeq`);
  return numbered;
}

/**
 * Which of these runs' runner tmux sessions are live: one `tmux-list` per
 * box whose agent is connected (5 s), null for every run on a box that did
 * not answer or is disconnected.
 */
export async function liveRuns(runs: RunInput[]): Promise<Map<string, boolean | null>> {
  const alive = new Map<string, boolean | null>();
  const byBox = new Map<string, RunInput[]>();
  for (const r of runs) {
    if (r.endedAt) continue;
    alive.set(r.orderId, null);
    const list = byBox.get(r.instanceId) ?? [];
    list.push(r);
    byBox.set(r.instanceId, list);
  }
  await Promise.all([...byBox.entries()].map(async ([instanceId, boxRuns]) => {
    let names: Set<string> | null = null;
    const user = boxRuns[0].hostUnixUser;
    if (user && isInstanceAgentConnected(instanceId)) {
      try {
        const reply = await sendToInstanceAgent(instanceId, 'tmux-list', {}, 5000);
        const sessions: string[] = Array.isArray(reply?.sessions) ? reply.sessions : [];
        names = new Set(parseRunnerSessions(sessions, user).map(s => s.orderId));
      } catch { names = null; }
    }
    for (const r of boxRuns) alive.set(r.orderId, names ? names.has(tmuxSafe(r.orderId)) : null);
  }));
  return alive;
}

export interface ListOptions {
  /** How far back runs and events are read; open runs are read whatever their age. */
  days: number;
}

/** Every session of one owner within the window, newest first, with liveness probed. */
export async function listCloudSessions(userId: string, opts: ListOptions): Promise<CloudSessionView[]> {
  const since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);
  const rows = await prisma.claudeRunnerSession.findMany({
    // Open runs whatever their age; closed ones that started or ended in the window.
    where: { userId, OR: [{ endedAt: null }, { startedAt: { gte: since } }, { endedAt: { gte: since } }] },
    select: runSelect,
  }) as RunRow[];
  // The events in the window, plus every event of a run that is still open:
  // an open run's `started` decides running versus starting however long
  // ago it happened, and a session can outlive any window.
  const openOrders = rows.filter(r => !r.endedAt).map(r => r.orderId);
  const eventRows = await prisma.claudeSessionEvent.findMany({
    where: { userId, OR: [{ at: { gte: since } }, ...(openOrders.length ? [{ orderId: { in: openOrders } }] : [])] },
    select: { sessionId: true, orderId: true, instanceId: true, kind: true, detail: true, at: true },
  });
  const runs = rows.map(toInput);
  const alive = await liveRuns(runs);
  return buildSessions(runs, eventRows, alive);
}

/** The events of one session, newest first, for the owner. */
export async function listSessionEvents(userId: string, key: string): Promise<EventInput[]> {
  const where = key.startsWith('order:') ? { userId, orderId: key.slice('order:'.length) } : { userId, sessionId: key };
  return prisma.claudeSessionEvent.findMany({
    where, orderBy: { at: 'desc' }, take: 200,
    select: { sessionId: true, orderId: true, instanceId: true, kind: true, detail: true, at: true },
  });
}

// ── Sweeps ──────────────────────────────────────────────────────────────────

/** An open run this old with no runner session is lost; younger, it may still be starting. */
export const LOST_GRACE_MS = 10 * 60 * 1000;
/**
 * A box in one of these states runs nothing: an open run there is lost at
 * once. Not `stopping` or `hibernating` (the runner may still be winding down
 * and reporting), and not `hibernated` (RAM is saved; the runner resumes with
 * the box and reports its own end). Those wait for the agent to come back or
 * for the tmux check once it has.
 */
export const BOX_OFF_STATES: ReadonlySet<string> = new Set(['stopped', 'terminated', 'failed']);
export const EVENT_RETENTION_DAYS = 30;
export const RUN_RETENTION_DAYS = 90;

type OpenRow = RunRow & { id: string; userId: string; user: { unixUsername: string } };

/**
 * Stamp `lost` on open runs whose runner is gone without an end report: the
 * box is off, or the box's agent answers and the runner's tmux session is not
 * there, both only once the run (and its newest event) is older than the
 * grace. A box whose agent is disconnected is not judged.
 */
export async function sweepLostRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - LOST_GRACE_MS);
  const open = await prisma.claudeRunnerSession.findMany({
    where: { endedAt: null, startedAt: { lt: cutoff } },
    select: { ...runSelect, id: true, userId: true, user: { select: { unixUsername: true } } },
  }) as OpenRow[];
  if (open.length === 0) return 0;

  const orderIds = open.map(r => r.orderId);
  const recent = await prisma.claudeSessionEvent.findMany({
    where: { orderId: { in: orderIds }, at: { gte: cutoff } },
    select: { orderId: true },
  });
  const recentlySignalled = new Set(recent.map(e => e.orderId));

  // A box that is off is not asked: nothing runs there.
  const alive = await liveRuns(open.filter(r => !BOX_OFF_STATES.has(r.instance.status)).map(toInput));
  let lost = 0;
  for (const row of open) {
    let why: string | null = null;
    if (BOX_OFF_STATES.has(row.instance.status)) why = `box ${row.instance.status}`;
    else if (alive.get(row.orderId) === false && !recentlySignalled.has(row.orderId)) why = 'runner session gone without an end report';
    if (!why) continue;
    // Guarded on the start this sweep observed: placement may relaunch the
    // order (recordRunnerStart reopens the row with a new startedAt) while
    // the box call above is in flight, and that new run is not lost.
    const stamped = await prisma.claudeRunnerSession.updateMany({
      where: { id: row.id, endedAt: null, startedAt: row.startedAt },
      data: { endedAt: now, exitReason: RUN_LOST_REASON },
    });
    if (stamped.count === 0) continue;
    lost++;
    console.log(`[CLAUDE-RUNNER] order ${row.orderId} for ${row.user.unixUsername} lost on ${row.instance.name} slot ${row.slot} after ${seconds(row.startedAt, now)}s (${why})`);
    if (row.sessionId) {
      await recordSessionEvent({
        owner: { id: row.userId, unixUsername: row.user.unixUsername },
        sessionId: row.sessionId, orderId: row.orderId, instanceId: row.instanceId,
        kind: 'lost' satisfies SessionEventKind, detail: why, at: now,
      });
    }
  }
  return lost;
}

/**
 * Events older than 30 days and ended runs older than 90 days go; open runs
 * wait for the lost sweep, and so do their events: an open run's `started`
 * decides running versus starting however old it is.
 */
export async function sweepRetention(now: Date = new Date()): Promise<{ events: number; runs: number }> {
  const day = 24 * 60 * 60 * 1000;
  const open = await prisma.claudeRunnerSession.findMany({ where: { endedAt: null }, select: { orderId: true } });
  const openOrders = open.map(r => r.orderId);
  const events = await prisma.claudeSessionEvent.deleteMany({
    where: { at: { lt: new Date(now.getTime() - EVENT_RETENTION_DAYS * day) }, ...(openOrders.length ? { orderId: { notIn: openOrders } } : {}) },
  });
  const runs = await prisma.claudeRunnerSession.deleteMany({ where: { endedAt: { not: null, lt: new Date(now.getTime() - RUN_RETENTION_DAYS * day) } } });
  if (events.count || runs.count) console.log(`[CLAUDE-RUNNER] retention: removed ${events.count} event(s), ${runs.count} run(s)`);
  return { events: events.count, runs: runs.count };
}

let lostTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function startCloudSessionSweeps(lostEveryMs = 5 * 60 * 1000, retentionEveryMs = 60 * 60 * 1000): void {
  if (lostTimer) return;
  backfillSessionSeq().catch(e => console.error('[CLAUDE-RUNNER] sessionSeq backfill failed:', errMsg(e)));
  lostTimer = setInterval(() => sweepLostRuns().catch(e => console.error('[CLAUDE-RUNNER] lost sweep failed:', errMsg(e))), lostEveryMs);
  lostTimer.unref?.();
  retentionTimer = setInterval(() => sweepRetention().catch(e => console.error('[CLAUDE-RUNNER] retention sweep failed:', errMsg(e))), retentionEveryMs);
  retentionTimer.unref?.();
}

export function stopCloudSessionSweeps(): void {
  if (lostTimer) { clearInterval(lostTimer); lostTimer = null; }
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
}
