// Pure rules for the session_statuses write-through (services/status.ts):
// what a row holds, when a change is worth writing, and how rows turn back
// into live status after a restart. No Prisma here, so it is unit-tested
// without a database.

import type { AgentStatus, SessionMilestone } from '../types/index';
import { isMilestoneExpired, MILESTONE_KINDS, MILESTONE_TTL_MS } from './milestone';

/** Matches the SessionStatus Prisma model. */
export interface SessionStatusRow {
  instanceKey: string;
  session: string;
  status: string;
  updatedAt: Date;
  workingStartedAt: Date | null;
  provider: string | null;
  source: string | null;
  message: string | null;
  waitingReason: string | null;
  threadId: string | null;
  contextTokens: number | null;
  rateLimited: string | null;
  milestone: unknown;
}

/** An open "working" span: when it started and whose time it is. */
export interface OpenSpan {
  startedAt: number;
  provider: string;
}

/** Same safety net as status.ts: working with no hook for this long is idle. */
export const AUTO_IDLE_MS = 5 * 60 * 1000;

/** Rows untouched for longer than this are not live status any more. */
export const HYDRATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A working session whose status doesn't change is rewritten at most this
 * often. Hooks repeat `working` on every tool call; writing each one would put
 * a row write behind every PreToolUse. Refreshing updatedAt on this cadence is
 * what lets hydration re-arm auto-idle within this much of the right time.
 */
export const WORKING_REFRESH_MS = 60 * 1000;

/** Backoff for retrying a failed write: 5 s, 10 s, 20 s, … capped at 5 min. */
export function persistRetryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 5 * 60 * 1000);
}

const STATUSES: readonly AgentStatus['status'][] = ['working', 'waiting', 'idle', 'not_running'];
const WAITING_REASONS: readonly NonNullable<AgentStatus['waitingReason']>[] = ['approval', 'user_input', 'unknown'];

export function instanceKeyOf(instanceId: string | null): string {
  return instanceId ?? '';
}

function milestoneJson(m: SessionMilestone | null | undefined): unknown {
  if (!m) return null;
  return { kind: m.kind, url: m.url, at: m.at.toISOString(), contextTokens: m.contextTokens };
}

export function toRow(
  instanceId: string | null,
  session: string,
  entry: AgentStatus,
  span: OpenSpan | undefined,
): SessionStatusRow {
  return {
    instanceKey: instanceKeyOf(instanceId),
    session,
    status: entry.status,
    updatedAt: entry.updatedAt,
    workingStartedAt: span ? new Date(span.startedAt) : null,
    provider: span?.provider ?? null,
    source: entry.source ?? null,
    message: entry.message ?? null,
    waitingReason: entry.waitingReason ?? null,
    threadId: entry.threadId ?? null,
    contextTokens: entry.contextTokens ?? null,
    rateLimited: entry.rateLimited ?? null,
    milestone: milestoneJson(entry.milestone),
  };
}

/**
 * Whether `next` should be written. The persisted fields that matter after a
 * restart are the status and its meta; `message`, activity scores and poller
 * meta change on nearly every post and are left to the live map.
 */
export function shouldPersist(
  prev: AgentStatus | undefined,
  next: AgentStatus,
  lastWrittenAt: number | undefined,
  now: number,
): boolean {
  if (!prev || lastWrittenAt === undefined) return true;
  if (prev.status !== next.status) return true;
  if ((prev.source ?? null) !== (next.source ?? null)) return true;
  if ((prev.waitingReason ?? null) !== (next.waitingReason ?? null)) return true;
  if ((prev.contextTokens ?? null) !== (next.contextTokens ?? null)) return true;
  if ((prev.rateLimited ?? null) !== (next.rateLimited ?? null)) return true;
  if (JSON.stringify(milestoneJson(prev.milestone)) !== JSON.stringify(milestoneJson(next.milestone))) return true;
  return next.status === 'working' && now - lastWrittenAt >= WORKING_REFRESH_MS;
}

function parseMilestone(raw: unknown): SessionMilestone | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { kind, url, at, contextTokens } = raw as Record<string, unknown>;
  if (typeof kind !== 'string' || !(MILESTONE_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof at !== 'string') return null;
  const atDate = new Date(at);
  if (Number.isNaN(atDate.getTime())) return null;
  return {
    kind: kind as SessionMilestone['kind'],
    url: typeof url === 'string' ? url : null,
    at: atDate,
    contextTokens: typeof contextTokens === 'number' ? contextTokens : null,
  };
}

export interface HydratedStatus {
  instanceId: string | null;
  session: string;
  status: AgentStatus;
  /**
   * When the row was written. `status.updatedAt` can be later: a working row
   * whose auto-idle deadline passed comes back idle as of that deadline.
   */
  rowUpdatedAt: Date;
  /** Open working span to resume; the next transition out of working banks it. */
  span?: OpenSpan;
  /** Re-arm the auto-idle timer to fire after this long. */
  autoIdleInMs?: number;
  /** Re-arm the milestone expiry timer to fire after this long. */
  milestoneExpiresInMs?: number;
  /** A span that ended while the backend was down (auto-idle passed): bank it now. */
  bank?: OpenSpan & { endedAt: number };
  /** The hydrated status differs from the row (auto-idled or milestone dropped): write it back. */
  rewrite: boolean;
}

/**
 * Turn persisted rows back into live status as of `now`. Rows older than
 * HYDRATE_MAX_AGE_MS or with an unknown status are skipped. A working session
 * whose auto-idle deadline passed during the downtime comes back idle as of
 * that deadline, with its span banked up to it — what the timer would have
 * done had the process been up. An expired milestone is dropped.
 */
export function hydrateStatus(rows: readonly SessionStatusRow[], now: number): HydratedStatus[] {
  const out: HydratedStatus[] = [];
  for (const row of rows) {
    const updatedAt = row.updatedAt.getTime();
    if (now - updatedAt > HYDRATE_MAX_AGE_MS) continue;
    if (!(STATUSES as readonly string[]).includes(row.status)) continue;

    let rewrite = false;
    let milestone = parseMilestone(row.milestone);
    if (row.milestone != null && !milestone) rewrite = true;
    let milestoneExpiresInMs: number | undefined;
    if (milestone) {
      if (isMilestoneExpired(milestone, now)) {
        milestone = null;
        rewrite = true;
      } else {
        milestoneExpiresInMs = MILESTONE_TTL_MS - (now - milestone.at.getTime());
      }
    }

    const instanceId = row.instanceKey === '' ? null : row.instanceKey;
    const waitingReason = (WAITING_REASONS as readonly string[]).includes(row.waitingReason ?? '')
      ? row.waitingReason as AgentStatus['waitingReason']
      : null;
    const status: AgentStatus = {
      status: row.status as AgentStatus['status'],
      updatedAt: row.updatedAt,
      instanceId,
      message: row.message ?? undefined,
      source: row.source ?? undefined,
      waitingReason,
      threadId: row.threadId ?? undefined,
      contextTokens: row.contextTokens ?? undefined,
      rateLimited: row.rateLimited,
      milestone,
    };

    const h: HydratedStatus = { instanceId, session: row.session, status, rowUpdatedAt: row.updatedAt, rewrite };
    if (status.status === 'working') {
      const span: OpenSpan = {
        startedAt: (row.workingStartedAt ?? row.updatedAt).getTime(),
        provider: row.provider ?? 'claude',
      };
      const deadline = updatedAt + AUTO_IDLE_MS;
      if (deadline > now) {
        h.span = span;
        h.autoIdleInMs = deadline - now;
      } else {
        h.status = {
          ...status,
          status: 'idle',
          updatedAt: new Date(deadline),
          message: 'Auto-idled after inactivity',
          waitingReason: null,
          activityScore: 0,
          activeTurn: false,
        };
        h.bank = { ...span, endedAt: deadline };
        h.rewrite = true;
      }
    }
    if (milestoneExpiresInMs !== undefined) h.milestoneExpiresInMs = milestoneExpiresInMs;
    out.push(h);
  }
  return out;
}

/**
 * Whether a row read back after a lease takeover should replace what this
 * process holds for the session. Strictly newer wins: an entry this process
 * wrote itself since (or the same state it hydrated at boot) stays. The
 * comparison is against the row's write time, not the auto-idle deadline a
 * stale working row is idled at, so a hook this process took after that
 * write is never replaced by the inferred idle.
 */
export function rowIsNewer(h: HydratedStatus, memory: AgentStatus | undefined): boolean {
  return !memory || memory.updatedAt.getTime() < h.rowUpdatedAt.getTime();
}
