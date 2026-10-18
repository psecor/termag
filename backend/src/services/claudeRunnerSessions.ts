/**
 * Session records for Claude Code cloud sessions on boxes: one row per order
 * the spawn route started (schema.prisma, ClaudeRunnerSession).
 *
 * The spawn route writes the row before the runner is launched
 * (recordRunnerStart), so the box's report cannot arrive first, and removes it
 * again when the launch fails (discardRunnerStart). The box reports through
 * POST /termag/api/claude-runner/event (routes/claudeRunnerEvents.ts):
 * `started` when the runner's command hook spawns Claude Code (the session id
 * and the client platform), `title` once with the first prompt's first line,
 * and `ended` from the runner script's exit trap, which completes the row
 * (recordRunnerEnd) and logs the owner's `ended` line. A one-shot runner exits
 * when its session ends, so endedAt - startedAt is the slot's occupancy (idle
 * time up to the runner's release included), not the owner's typing time.
 *
 * A row is one run. The Anthropic session (`sessionId`) outlives it: a
 * re-offer after a refusal or a resume after the idle release is a new order
 * and a new row of the same session, and the title travels with the session
 * (recordRunnerStart copies it from the latest titled run).
 */
import { prisma } from '../db';
import { LAUNCH_SKEW_MS } from './launchSkew';
import { isOrderId } from './claudeRunnerSpawn';

export interface RunnerStart {
  orderId: string;
  /** The Anthropic session this order serves, from the spawn body; null from an older caller. */
  sessionId: string | null;
  userId: string;
  instanceId: string;
  slot: number;
  /** The launch time, taken by the caller as it launches; not the insert's. */
  startedAt: Date;
}

// The Anthropic session id as the spawn hook and the runner hand it over
// (`cse_...`, or `session_...` in the lifecycle hooks). Checked for shape only.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/;
export const isSessionId = (s: string): boolean => SESSION_ID.test(s);

/**
 * One row per order, describing its latest launch. A retry of an order whose
 * session is live never gets here (the spawn route answers "already running"
 * without a launch). A relaunch of an order whose runner vanished (placement
 * found no live tmux session for it) moves the row to the new box and slot
 * and reopens it, so the new runner's end report is taken. A report from the
 * earlier launch that is still in flight then carries an endedAt from before
 * this startedAt, which recordRunnerEnd ignores as stale.
 *
 * The title belongs to the session, not the run: a new run of a session that
 * already has a titled run starts with that title.
 */
export async function recordRunnerStart(start: RunnerStart): Promise<void> {
  const { orderId, sessionId, ...launch } = start;
  let title: string | null = null;
  let sessionSeq: number | null = null;
  if (sessionId) {
    // An earlier run of the same session carries the title and the number.
    const titled = await prisma.claudeRunnerSession.findFirst({
      where: { sessionId, title: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { title: true },
    });
    title = titled?.title ?? null;
    const numbered = await prisma.claudeRunnerSession.findFirst({
      where: { sessionId, sessionSeq: { not: null } },
      select: { sessionSeq: true },
    });
    sessionSeq = numbered?.sessionSeq ?? await nextSessionSeq(launch.userId);
  }
  const carried = { ...(title ? { title } : {}), ...(sessionSeq != null ? { sessionSeq } : {}) };
  await prisma.claudeRunnerSession.upsert({
    where: { orderId },
    create: { orderId, sessionId, ...launch, ...carried },
    // A relaunch is a new run: the earlier launch's token totals go with its end.
    update: { ...launch, sessionId, endedAt: null, exitStatus: null, exitReason: null, ...USAGE_RESET, ...carried },
  });
}

/**
 * The next "Claude Cloud N" for an owner: an atomic increment of the counter
 * on their user row. The counter outlives the run rows, so a number is never
 * handed out twice, not after the 90-day retention sweep and not when a
 * placement and the startup backfill interleave.
 */
export async function nextSessionSeq(userId: string): Promise<number> {
  const u = await prisma.user.update({ where: { id: userId }, data: { claudeSessionSeq: { increment: 1 } }, select: { claudeSessionSeq: true } });
  return u.claudeSessionSeq;
}

/** The launch failed after the row was written: no runner ran, so the row goes. */
export async function discardRunnerStart(orderId: string): Promise<void> {
  await prisma.claudeRunnerSession.deleteMany({ where: { orderId } });
}

export interface RunnerEnd {
  orderId: string;
  exitStatus: number;
  exitReason: string | null;
  endedAt: Date;
  /** The session directory's size as the post-session hook measured it (S5); null from an older wrapper. */
  checkoutBytes: bigint | null;
  /** The checkout was kept under ~/ccr/kept: GitHub did not have all of its work. Null from an older wrapper. */
  kept: boolean | null;
}

export interface RunnerStarted {
  orderId: string;
  sessionId: string;
  clientPlatform: string | null;
  /** When the hook ran, by the box's clock (trusted ten minutes either way); null from an older hook. */
  at: Date | null;
}

export interface RunnerTitle {
  orderId: string;
  title: string;
}

/**
 * Cumulative token usage of a run, summed from the session's own transcript
 *: posted by `termag-status stop` on
 * every turn and by the post-session hook once more. `at` is the box's clock
 * when it summed, trusted ten minutes either way; the newest post wins.
 */
export interface RunnerUsage {
  orderId: string;
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheCreate: bigint;
  /** API responses counted after dedupe; null from a poster that did not count. */
  calls: number | null;
  /** The model most of the responses came from; a short token, or null. */
  model: string | null;
  at: Date;
}

/** What a box may post to the event route; `event` picks the shape. */
export type RunnerEvent =
  | ({ event: 'ended' } & RunnerEnd)
  | ({ event: 'started' } & RunnerStarted)
  | ({ event: 'title' } & RunnerTitle)
  | ({ event: 'usage' } & RunnerUsage);

// A short lowercase token, such as the runner's post-session reason
// (completed, failed, interrupted) or the script's own (signal, timeout).
const EXIT_REASON = /^[a-z][a-z0-9-]{0,63}$/;
// The client surface Anthropic records at session creation (web_claude_ai,
// desktop_app, ios, android, claude_code_cli, scheduled_trigger, ...).
const CLIENT_PLATFORM = /^[a-z][a-z0-9_-]{0,39}$/;
// The box's clock is trusted this far either way; past it, now is used, so a
// duration can neither go negative nor balloon on a wrong clock.
const CLOCK_TRUST_MS = 10 * 60 * 1000;
/** The columns a relaunch clears: the earlier launch's token totals, checkout size and kept flag are not this run's. */
export const USAGE_RESET = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreateTokens: null, usageCalls: null, model: null, usageAt: null, checkoutBytes: null, kept: null } as const;
// A model id as Claude Code writes it (claude-opus-5-5, us.anthropic.claude-...).
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
// Token counts are whole and non-negative; a transcript summed by jq is a JSON number.
function tokenCount(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,18}$/.test(v)) return BigInt(v);
  return null;
}
/** The title is the first prompt's first line, this long at most. */
export const TITLE_MAX = 120;

/**
 * The first line of a prompt, as a title: control characters and runs of
 * whitespace collapsed, trimmed, cut to TITLE_MAX. Null when nothing is left.
 */
export function titleFromPrompt(text: string): string | null {
  const line = text.split(/\r?\n/).map(l => l.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).find(l => l.length > 0);
  if (!line) return null;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

export function parseRunnerEvent(body: unknown, now: Date = new Date()): RunnerEvent | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const orderId = typeof b.orderId === 'string' ? b.orderId : '';
  if (!isOrderId(orderId)) return { error: 'orderId missing or not a safe identifier' };
  switch (b.event) {
    case 'ended': {
      const exitStatus = b.exitStatus;
      if (typeof exitStatus !== 'number' || !Number.isInteger(exitStatus) || exitStatus < 0 || exitStatus > 255) {
        return { error: 'exitStatus must be an integer from 0 to 255' };
      }
      let exitReason: string | null = null;
      if (b.exitReason !== undefined && b.exitReason !== null) {
        if (typeof b.exitReason !== 'string' || !EXIT_REASON.test(b.exitReason)) return { error: 'exitReason must be a short lowercase token' };
        exitReason = b.exitReason;
      }
      let endedAt = now;
      if (b.endedAt !== undefined) {
        const t = typeof b.endedAt === 'string' ? Date.parse(b.endedAt) : NaN;
        if (Number.isNaN(t)) return { error: 'endedAt must be an ISO-8601 timestamp' };
        if (Math.abs(t - now.getTime()) <= CLOCK_TRUST_MS) endedAt = new Date(t);
      }
      let checkoutBytes: bigint | null = null;
      if (b.checkoutBytes !== undefined && b.checkoutBytes !== null) {
        checkoutBytes = tokenCount(b.checkoutBytes);
        if (checkoutBytes === null) return { error: 'checkoutBytes must be a non-negative integer' };
      }
      let kept: boolean | null = null;
      if (b.kept !== undefined && b.kept !== null) {
        if (typeof b.kept !== 'boolean') return { error: 'kept must be a boolean' };
        kept = b.kept;
      }
      return { event: 'ended', orderId, exitStatus, exitReason, endedAt, checkoutBytes, kept };
    }
    case 'started': {
      const sessionId = typeof b.sessionId === 'string' ? b.sessionId.trim() : '';
      if (!isSessionId(sessionId)) return { error: 'sessionId missing or not a session id' };
      let clientPlatform: string | null = null;
      if (b.clientPlatform !== undefined && b.clientPlatform !== null && b.clientPlatform !== '') {
        if (typeof b.clientPlatform !== 'string' || !CLIENT_PLATFORM.test(b.clientPlatform)) return { error: 'clientPlatform must be a short lowercase token' };
        clientPlatform = b.clientPlatform;
      }
      let at: Date | null = null;
      if (b.at !== undefined && b.at !== null) {
        const t = typeof b.at === 'string' ? Date.parse(b.at) : NaN;
        if (Number.isNaN(t)) return { error: 'at must be an ISO-8601 timestamp' };
        at = Math.abs(t - now.getTime()) <= CLOCK_TRUST_MS ? new Date(t) : now;
      }
      return { event: 'started', orderId, sessionId, clientPlatform, at };
    }
    case 'title': {
      const title = typeof b.title === 'string' ? titleFromPrompt(b.title) : null;
      if (!title) return { error: 'title missing or empty' };
      return { event: 'title', orderId, title };
    }
    case 'usage': {
      const input = tokenCount(b.input), output = tokenCount(b.output), cacheRead = tokenCount(b.cacheRead), cacheCreate = tokenCount(b.cacheCreate);
      if (input === null || output === null || cacheRead === null || cacheCreate === null) return { error: 'input, output, cacheRead and cacheCreate must be non-negative integers' };
      let calls: number | null = null;
      if (b.calls !== undefined && b.calls !== null) {
        if (typeof b.calls !== 'number' || !Number.isInteger(b.calls) || b.calls < 0) return { error: 'calls must be a non-negative integer' };
        calls = b.calls;
      }
      let model: string | null = null;
      if (b.model !== undefined && b.model !== null && b.model !== '') {
        if (typeof b.model !== 'string' || !MODEL.test(b.model)) return { error: 'model must be a short model id' };
        model = b.model;
      }
      let at = now;
      if (b.at !== undefined && b.at !== null) {
        const t = typeof b.at === 'string' ? Date.parse(b.at) : NaN;
        if (Number.isNaN(t)) return { error: 'at must be an ISO-8601 timestamp' };
        if (Math.abs(t - now.getTime()) <= CLOCK_TRUST_MS) at = new Date(t);
      }
      return { event: 'usage', orderId, input, output, cacheRead, cacheCreate, calls, model, at };
    }
    default:
      return { error: "event must be 'ended', 'started', 'title' or 'usage'" };
  }
}

/** The row and what the log lines and the event log need from it. */
interface RowContext {
  id: string;
  userId: string;
  sessionId: string | null;
  instanceId: string;
  slot: number;
  startedAt: Date;
  endedAt: Date | null;
  title: string | null;
  user: { unixUsername: string };
  instance: { name: string };
}

async function rowForOrder(orderId: string): Promise<RowContext | null> {
  return prisma.claudeRunnerSession.findUnique({
    where: { orderId },
    select: {
      id: true, userId: true, sessionId: true, instanceId: true, slot: true, startedAt: true, endedAt: true, title: true,
      user: { select: { unixUsername: true } }, instance: { select: { name: true } },
    },
  });
}

export interface RunIdentity {
  userId: string;
  who: string;
  sessionId: string | null;
  instanceId: string;
  boxName: string;
  slot: number;
}

const identity = (row: RowContext): RunIdentity => ({
  userId: row.userId, who: row.user.unixUsername, sessionId: row.sessionId, instanceId: row.instanceId, boxName: row.instance.name, slot: row.slot,
});

export type RunnerEndOutcome =
  | ({ kind: 'ended'; durationSec: number; exitStatus: number; exitReason: string | null } & RunIdentity)
  /** The same end reported again: nothing to do, nothing to log. */
  | { kind: 'repeat' }
  /** No row: this backend never recorded the start. */
  | { kind: 'unknown' }
  /** The reporting box did not run this order. */
  | { kind: 'other-box' }
  /** The report is from an earlier launch of the order: it ended before the current launch started. */
  | { kind: 'stale'; startedAt: Date };

/**
 * Completes the order's row for the box whose agent token made the report.
 * The end is stamped with a guarded update, so two reports of one end (a
 * retry racing the first) log one line.
 */
export async function recordRunnerEnd(instanceId: string, end: RunnerEnd): Promise<RunnerEndOutcome> {
  const row = await rowForOrder(end.orderId);
  if (!row) return { kind: 'unknown' };
  if (row.instanceId !== instanceId) return { kind: 'other-box' };
  // A relaunch reopened the row (recordRunnerStart); the earlier launch's own
  // report, delayed in flight, must not close the new one. Its endedAt is the
  // box's clock when it exited, which was before placement found the session
  // gone and the relaunch set startedAt. (A box clock more than ten minutes
  // off was replaced by the server's now in parseRunnerEvent, and such a report
  // is not told apart; EC2 clocks are NTP-synced.)
  if (end.endedAt.getTime() < row.startedAt.getTime()) return { kind: 'stale', startedAt: row.startedAt };
  const stamped = await prisma.claudeRunnerSession.updateMany({
    where: { id: row.id, endedAt: null },
    data: {
      endedAt: end.endedAt, exitStatus: end.exitStatus, exitReason: end.exitReason,
      ...(end.checkoutBytes !== null ? { checkoutBytes: end.checkoutBytes } : {}),
      ...(end.kept !== null ? { kept: end.kept } : {}),
    },
  });
  if (stamped.count === 0) return { kind: 'repeat' };
  const durationSec = Math.max(0, Math.round((end.endedAt.getTime() - row.startedAt.getTime()) / 1000));
  return { kind: 'ended', ...identity(row), durationSec, exitStatus: end.exitStatus, exitReason: end.exitReason };
}

export type RunnerStartedOutcome =
  | ({ kind: 'started'; clientPlatform: string | null } & RunIdentity)
  | { kind: 'unknown' }
  | { kind: 'other-box' }
  /** The report is from an earlier launch of a relaunched order: its hook ran before the current launch started. */
  | { kind: 'stale'; startedAt: Date };

/**
 * The runner's command hook spawned Claude Code for this order: the row learns
 * the session id (which the spawn body already set, normally) and the client
 * platform. A `started` for a row that already ended is still recorded on the
 * row, so the platform is known, but the row is not reopened. A report that
 * says when its hook ran is ignored when that was before the row's current
 * launch (a relaunched order; the earlier launch's hook reporting late), as
 * recordRunnerEnd ignores a stale end.
 */
export async function recordRunnerStarted(instanceId: string, started: RunnerStarted): Promise<RunnerStartedOutcome> {
  const row = await rowForOrder(started.orderId);
  if (!row) return { kind: 'unknown' };
  if (row.instanceId !== instanceId) return { kind: 'other-box' };
  if (started.at && started.at.getTime() < row.startedAt.getTime()) return { kind: 'stale', startedAt: row.startedAt };
  if (row.sessionId && row.sessionId !== started.sessionId) {
    console.warn(`[CLAUDE-RUNNER] order ${started.orderId}: the box reports session ${started.sessionId}, the spawn recorded ${row.sessionId}; keeping the spawn's`);
  }
  const sessionId = row.sessionId ?? started.sessionId;
  await prisma.claudeRunnerSession.update({
    where: { id: row.id },
    data: { sessionId, ...(started.clientPlatform ? { clientPlatform: started.clientPlatform } : {}) },
  });
  return { kind: 'started', ...identity(row), sessionId, clientPlatform: started.clientPlatform };
}

export type RunnerTitleOutcome =
  | ({ kind: 'set' } & RunIdentity)
  /** The row already has a title: the first prompt wins. */
  | ({ kind: 'kept' } & RunIdentity)
  | { kind: 'unknown' }
  | { kind: 'other-box' };

export type RunnerUsageOutcome =
  | ({ kind: 'set' } & RunIdentity)
  /** The row already holds a newer summary (a slow post landing after a fresher one). */
  | ({ kind: 'stale' } & RunIdentity)
  | { kind: 'unknown' }
  | { kind: 'other-box' };

/** The run's cumulative usage: the newest summary wins, by the box's `at`. */
export async function recordRunnerUsage(instanceId: string, usage: RunnerUsage): Promise<RunnerUsageOutcome> {
  const row = await rowForOrder(usage.orderId);
  if (!row) return { kind: 'unknown' };
  if (row.instanceId !== instanceId) return { kind: 'other-box' };
  // A summary from an earlier launch of a relaunched order, landing late: not this run's tokens.
  if (usage.at.getTime() < row.startedAt.getTime() - LAUNCH_SKEW_MS) return { kind: 'stale', ...identity(row) };
  const set = await prisma.claudeRunnerSession.updateMany({
    where: { id: row.id, OR: [{ usageAt: null }, { usageAt: { lt: usage.at } }] },
    data: {
      inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheCreateTokens: usage.cacheCreate,
      usageCalls: usage.calls, model: usage.model, usageAt: usage.at,
    },
  });
  return { kind: set.count > 0 ? 'set' : 'stale', ...identity(row) };
}

/** The first prompt's first line, once per run; a title carried from an earlier run of the session stays. */
export async function recordRunnerTitle(instanceId: string, title: RunnerTitle): Promise<RunnerTitleOutcome> {
  const row = await rowForOrder(title.orderId);
  if (!row) return { kind: 'unknown' };
  if (row.instanceId !== instanceId) return { kind: 'other-box' };
  const set = await prisma.claudeRunnerSession.updateMany({ where: { id: row.id, title: null }, data: { title: title.title } });
  return { kind: set.count > 0 ? 'set' : 'kept', ...identity(row) };
}
