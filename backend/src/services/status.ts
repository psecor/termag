import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AgentStatus, StatusMap } from '../types/index';
import { isAgentRunning } from './tmux';
import { providerForSource } from '../providers/registry';
import { parseStatusKey, statusKey } from './statusKey';
import { CLOUD_WORKTIME_PROJECT, workTimeIdentity } from './worktimeProjects';
import { isRunnerSessionShaped } from './claudeRunnerSpawn';
import { boxOwnerUsername, primeBoxOwners } from './boxOwners';
import { isMilestoneExpired, MILESTONE_TTL_MS } from './milestone';
import { noteBoxActivity } from './boxActivity';
import { forgetTurns, moveTurns } from './sessionTurns';
import {
  AUTO_IDLE_MESSAGE, AUTO_IDLE_MS, AUTO_IDLE_TAIL_CREDIT_MS, HYDRATE_MAX_AGE_MS, hydrateStatus, instanceKeyOf, persistRetryDelayMs, rowIsNewer, shouldPersist, toRow,
  type HydratedStatus,
} from './statusPersistence';
import { recordProductEvent, type ProductEventDetail, type ProductEventName } from './productEvents';
import { userIdForUnixUsername } from './userKeys';

/**
 * A product event about a session this module knows only by name: the
 * username in the name (or the box's owner for a cloud runner) resolves to the
 * user id the event is keyed by (services/userKeys.ts). Fire-and-forget;
 * a name no user is behind records nothing.
 */
// Hooks-based providers (claude) send no source; poller/bridge providers do.
function providerForSourceOrNull(source: string | undefined): string | null {
  return source ? providerForSource(source) ?? null : null;
}

function recordSessionEvent(name: ProductEventName, sessionName: string, instanceId: string | null, detail: ProductEventDetail): void {
  const parsed = parseSessionName(sessionName, instanceId);
  if (!parsed) return;
  void userIdForUnixUsername(parsed.username).then(user => {
    if (user) recordProductEvent(name, { user, box: instanceId }, detail);
  });
}


// In-memory status map. Keyed by statusKey(instanceId, session) — the tmux
// name is not unique across boxes. Written through to session_statuses
// (statusPersistence.ts) and re-read by hydrateStatuses() at startup.
const statusMap: StatusMap = new Map();

// Auto-revert "working" → "idle" after AUTO_IDLE_MS (safety net if Stop hook doesn't fire)
const autoIdleTimers = new Map<string, NodeJS.Timeout>();

// Pending "PR opened" milestones expire on their own (MILESTONE_TTL_MS) so a
// prompt nobody acted on never lingers.
const milestoneTimers = new Map<string, NodeJS.Timeout>();

type AgentStatusMeta = Omit<Partial<AgentStatus>, 'status' | 'updatedAt' | 'statusSince'>;

// ── Working-time accumulator ───────────────────────────────────
// Tracks when sessions enter "working" and banks duration on transition out.

interface WorkingSession {
  startedAt: number;
  provider: string;
  project: string;
  username: string;
  instanceId: string | null;
}

const workingSessions = new Map<string, WorkingSession>();

// Pending "auto-idle cut" record: the deadline closed a span that may not have
// really ended. If working resumes within AUTO_IDLE_TAIL_CREDIT_MS, the gap is
// credited to the same row (without a bogus extra sessions count). Set only by
// deadline cuts (auto-idle timer and restart hydration); a real Stop → idle
// transition never leaves one.
interface AutoIdleTail {
  username: string;
  project: string;
  provider: string;
  instanceId: string | null;
  /** The ms the auto-idle deadline would have fired, i.e. where the span was cut. */
  cutAt: number;
}

const autoIdleTails = new Map<string, AutoIdleTail>();

/** Record a tail, dropping any past the credit window (a cut never resumed). */
function setAutoIdleTail(key: string, tail: AutoIdleTail): void {
  const now = Date.now();
  for (const [k, t] of autoIdleTails) {
    if (now - t.cutAt > AUTO_IDLE_TAIL_CREDIT_MS) autoIdleTails.delete(k);
  }
  autoIdleTails.set(key, tail);
}

function todayStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseSessionName(sessionName: string, instanceId: string | null = null): { username: string; project: string } | null {
  // Format: username-project-agent
  const m = sessionName.match(/^(.+?)-(.+)-agent$/);
  if (m) return { username: m[1], project: m[2] };
  // A Claude Code cloud session's runner (<boxUser>-claude-runner-s<slot>-<order>-r):
  // its time belongs to the box's owner,
  // whose username is not in the name (a provisioned box keeps the image's
  // unix user), under the reserved cloud project. Unknown owner: not banked.
  if (instanceId && isRunnerSessionShaped(sessionName)) {
    const owner = boxOwnerUsername(instanceId);
    return owner ? { username: owner, project: CLOUD_WORKTIME_PROJECT } : null;
  }
  return null;
}

function upsertWorkTime(
  identity: { username: string; project: string; provider: string; date: string; instanceId: string },
  durationMs: number,
  opts: { sessions: boolean },
): void {
  prisma.workTimeEntry.upsert({
    where: { username_project_provider_date_instanceId: identity },
    update: {
      totalMs: { increment: durationMs },
      ...(!opts.sessions ? {} : { sessions: { increment: 1 } as const }),
    },
    create: {
      ...identity,
      totalMs: durationMs,
      sessions: opts.sessions ? 1 : 0,
    },
  }).catch(err => {
    console.error('[WORKTIME] Failed to persist:', (err as Error).message);
  });
}

/**
 * Working resumed for a session whose span was deadline-cut by auto-idle.
 * Within the credit window the cut is reinterpreted as a silent stretch of the
 * same turn and the gap is banked as a tail; the new span still starts fresh
 * (attribution unchanged, since identity comes from the tail record anyway).
 * Beyond the window the cut was almost certainly a real pause — drop the tail.
 */
function creditAutoIdleTail(sessionName: string, instanceId: string | null): void {
  const key = statusKey(instanceId, sessionName);
  const tail = autoIdleTails.get(key);
  if (!tail) return;
  autoIdleTails.delete(key); // consumed either way: nothing re-arms after a resume
  const now = Date.now();
  const tailMs = now - tail.cutAt;
  if (tailMs > AUTO_IDLE_TAIL_CREDIT_MS || tailMs < 1000) return;
  // Banked under the day of the credit, like every other late bank — a tail
  // that crosses midnight lands in the day the resume happened.
  const identity = workTimeIdentity(tail.username, tail.project, tail.provider, todayStr(new Date(now)), tail.instanceId);
  upsertWorkTime(identity, tailMs, { sessions: false });
}

function startWorkingTimer(sessionName: string, instanceId: string | null, source?: string): void {
  const key = statusKey(instanceId, sessionName);
  creditAutoIdleTail(sessionName, instanceId);
  if (workingSessions.has(key)) return;
  const parsed = parseSessionName(sessionName, instanceId);
  if (!parsed) return;
  // Hooks-based providers (claude) don't send source; poller/bridge providers do.
  // Default to 'claude' when source is missing since that's the only hook-based provider.
  const provider = (source ? providerForSource(source) : null) ?? 'claude';
  workingSessions.set(key, {
    startedAt: Date.now(),
    provider,
    project: parsed.project,
    username: parsed.username,
    instanceId,
  });
}

/** Banks the open span; `ending` describes how the span came to an end. */
function stopWorkingTimer(
  sessionName: string,
  instanceId: string | null,
  endedAt: number = Date.now(),
  ending: 'transition' | 'auto-idle' = 'transition',
): void {
  const key = statusKey(instanceId, sessionName);
  const session = workingSessions.get(key);
  if (!session) return;
  workingSessions.delete(key);

  const durationMs = endedAt - session.startedAt;
  if (durationMs >= 1000) {
    // The day the span ended, not now: a span banked late (hydration after a
    // restart past midnight) belongs to the day the timer would have fired.
    const date = todayStr(new Date(endedAt));
    const identity = workTimeIdentity(session.username, session.project, session.provider, date, session.instanceId);
    upsertWorkTime(identity, durationMs, { sessions: true });
  }

  // Record deadline cuts so a prompt resume can credit the silent stretch.
  if (ending === 'auto-idle') {
    setAutoIdleTail(key, {
      username: session.username,
      project: session.project,
      provider: session.provider,
      instanceId,
      cutAt: endedAt,
    });
  } else {
    autoIdleTails.delete(key);
  }
}

// ── Write-through to session_statuses ──────────────────────────
// Writes for one key run in order (a fast working → waiting must not land as
// waiting → working) and never block the caller: the in-memory map stays
// authoritative for this process. A failed write is retried with backoff
// (persistRetryDelayMs) from whatever the map holds by then, because an
// unchanged waiting session may post nothing else for hours.

const persistChains = new Map<string, Promise<void>>();
const lastWrittenAt = new Map<string, number>();
const writeGeneration = new Map<string, number>();
const retryTimers = new Map<string, NodeJS.Timeout>();
const retryAttempts = new Map<string, number>();

function cancelPersistRetry(key: string): void {
  const t = retryTimers.get(key);
  if (t) { clearTimeout(t); retryTimers.delete(key); }
}

function schedulePersistRetry(key: string, sessionName: string, instanceId: string | null): void {
  const attempt = (retryAttempts.get(key) ?? 0) + 1;
  retryAttempts.set(key, attempt);
  cancelPersistRetry(key);
  const t = setTimeout(() => {
    retryTimers.delete(key);
    const current = statusMap.get(key);
    if (current) persistEntry(sessionName, instanceId, current);
    else unpersist(sessionName, instanceId);
  }, persistRetryDelayMs(attempt));
  t.unref?.();
  retryTimers.set(key, t);
}

function enqueuePersist(key: string, sessionName: string, instanceId: string | null, op: () => Promise<unknown>): void {
  const gen = (writeGeneration.get(key) ?? 0) + 1;
  writeGeneration.set(key, gen);
  // This write carries the latest state, so a pending retry of an older one is moot.
  cancelPersistRetry(key);
  const next = (persistChains.get(key) ?? Promise.resolve())
    .then(op)
    .then(
      () => { if (writeGeneration.get(key) === gen) retryAttempts.delete(key); },
      err => {
        console.error('[STATUS] persist failed, will retry:', (err as Error).message);
        if (writeGeneration.get(key) === gen) schedulePersistRetry(key, sessionName, instanceId);
      },
    );
  persistChains.set(key, next);
  void next.finally(() => { if (persistChains.get(key) === next) persistChains.delete(key); });
}

function persistEntry(sessionName: string, instanceId: string | null, entry: AgentStatus): void {
  const key = statusKey(instanceId, sessionName);
  const w = workingSessions.get(key);
  const row = toRow(instanceId, sessionName, entry, w && { startedAt: w.startedAt, provider: w.provider });
  const data = { ...row, milestone: row.milestone === null ? Prisma.DbNull : row.milestone as Prisma.InputJsonValue };
  lastWrittenAt.set(key, Date.now());
  enqueuePersist(key, sessionName, instanceId, () => prisma.sessionStatus.upsert({
    where: { instanceKey_session: { instanceKey: row.instanceKey, session: sessionName } },
    create: data,
    update: data,
  }));
}

function persistIfChanged(sessionName: string, instanceId: string | null, prev: AgentStatus | undefined, next: AgentStatus): void {
  const key = statusKey(instanceId, sessionName);
  const now = Date.now();
  // While a retry is pending it carries the latest state, so only a real
  // change writes ahead of it; the working refresh would undo the backoff.
  const writtenAt = retryTimers.has(key) ? now : lastWrittenAt.get(key);
  if (shouldPersist(prev, next, writtenAt, now)) persistEntry(sessionName, instanceId, next);
}

function unpersist(sessionName: string, instanceId: string | null): void {
  const key = statusKey(instanceId, sessionName);
  lastWrittenAt.delete(key);
  enqueuePersist(key, sessionName, instanceId, () => prisma.sessionStatus.deleteMany({
    where: { instanceKey: instanceKeyOf(instanceId), session: sessionName },
  }));
}

// A draining process runs no status
// timers: an auto-idle or milestone expiry it fired would write a row over
// the one the serving process wrote since. Hook writes it still takes are
// persisted, for the new holder's re-read. The new holder runs none either
// until that re-read is done (statusTakeover.ts), for the mirror reason.
let timersSuspended = false;

function armAutoIdle(sessionName: string, instanceId: string | null, delayMs: number): void {
  if (timersSuspended) return;
  const key = statusKey(instanceId, sessionName);
  const existing = autoIdleTimers.get(key);
  if (existing) clearTimeout(existing);
  const deadline = Date.now() + delayMs;
  const timer = setTimeout(() => {
    autoIdleTimers.delete(key);
    const current = statusMap.get(key);
    if (current?.status === 'working') {
      // The flush here is timer slack off `deadline`; banking uses the exact
      // deadline so the tail credit (if working resumes) starts where the cut
      // was meant to.
      const at = new Date();
      const idled: AgentStatus = {
        status: 'idle',
        updatedAt: at,
        statusSince: at,
        instanceId,
        message: AUTO_IDLE_MESSAGE,
        source: current.source,
        waitingReason: null,
        activityScore: 0,
        tokenBurst: current.tokenBurst,
        activeTurn: false,
        threadId: current.threadId,
        // Gauges and the pending PR prompt survive the auto-idle: this is a
        // safety-net flip of `status`, not new information about the session.
        pollerMeta: current.pollerMeta,
        contextTokens: current.contextTokens,
        rateLimited: current.rateLimited,
        milestone: current.milestone,
        review: current.review,
        handoff: current.handoff,
        stoppedAt: at,
      };
      statusMap.set(key, idled);
      onStatusTransition?.(sessionName, instanceId, current.status, 'idle');
      stopWorkingTimer(sessionName, instanceId, deadline, 'auto-idle');
      persistEntry(sessionName, instanceId, idled);
      onStatusChange?.(sessionName, instanceId);
    }
  }, delayMs);
  autoIdleTimers.set(key, timer);
}

export function clearMilestoneTimer(sessionName: string, instanceId: string | null): void {
  const key = statusKey(instanceId, sessionName);
  const t = milestoneTimers.get(key);
  if (t) { clearTimeout(t); milestoneTimers.delete(key); }
}

/** Drop the session's pending milestone once it has expired (after delayMs). */
export function armMilestoneTimer(sessionName: string, instanceId: string | null, delayMs: number = MILESTONE_TTL_MS): void {
  const key = statusKey(instanceId, sessionName);
  clearMilestoneTimer(sessionName, instanceId);
  if (timersSuspended) return;
  milestoneTimers.set(key, setTimeout(() => {
    milestoneTimers.delete(key);
    const cur = statusMap.get(key);
    if (cur?.milestone && isMilestoneExpired(cur.milestone, Date.now())) {
      updateStatusMeta(sessionName, { milestone: null }, instanceId);
      onStatusChange?.(sessionName, instanceId);
    }
  }, Math.max(0, delayMs)));
}

/**
 * Draining: stop every auto-idle and milestone timer and arm no new ones.
 * Serving again (failover): re-arm them from the entries in memory, as a boot
 * would from the rows.
 */
export function setStatusTimersSuspended(suspended: boolean, now: number = Date.now()): void {
  if (suspended === timersSuspended) return;
  timersSuspended = suspended;
  if (suspended) {
    for (const t of autoIdleTimers.values()) clearTimeout(t);
    autoIdleTimers.clear();
    for (const t of milestoneTimers.values()) clearTimeout(t);
    milestoneTimers.clear();
    return;
  }
  for (const [key, entry] of statusMap) {
    const { instanceId, session } = parseStatusKey(key);
    if (entry.status === 'working') {
      armAutoIdle(session, instanceId, Math.max(0, entry.updatedAt.getTime() + AUTO_IDLE_MS - now));
    }
    if (entry.milestone) {
      armMilestoneTimer(session, instanceId, MILESTONE_TTL_MS - (now - entry.milestone.at.getTime()));
    }
  }
}

function applyHydrated(h: HydratedStatus, now: number): void {
  const key = statusKey(h.instanceId, h.session);
  // The row is the truth now (a takeover replaces what this process held):
  // only a tail the row itself implies survives, re-seeded below.
  autoIdleTails.delete(key);
  statusMap.set(key, h.status);
  lastWrittenAt.set(key, now);
  const parsed = parseSessionName(h.session, h.instanceId);
  if (parsed && (h.span || h.bank)) {
    const span = h.span ?? h.bank!;
    workingSessions.set(key, {
      startedAt: span.startedAt, provider: span.provider,
      project: parsed.project, username: parsed.username, instanceId: h.instanceId,
    });
    if (h.bank) stopWorkingTimer(h.session, h.instanceId, h.bank.endedAt, 'auto-idle');
  }
  if (parsed && h.tail) {
    const provider = (h.tail.source ? providerForSource(h.tail.source) : null) ?? 'claude';
    setAutoIdleTail(key, {
      username: parsed.username, project: parsed.project, provider, instanceId: h.instanceId, cutAt: h.tail.cutAt,
    });
  }
  if (h.autoIdleInMs !== undefined) armAutoIdle(h.session, h.instanceId, h.autoIdleInMs);
  if (h.milestoneExpiresInMs !== undefined) armMilestoneTimer(h.session, h.instanceId, h.milestoneExpiresInMs);
  if (h.rewrite) persistEntry(h.session, h.instanceId, h.status);
}

async function readHydratable(now: number): Promise<HydratedStatus[]> {
  // Runner sessions bank under their box owner; the owners must be known
  // before a hydrated span is re-banked (boxOwners.ts).
  await primeBoxOwners().catch(err => console.error('[WORKTIME] box owners not primed:', (err as Error).message));
  const cutoff = new Date(now - HYDRATE_MAX_AGE_MS);
  await prisma.sessionStatus.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  const rows = await prisma.sessionStatus.findMany({ where: { updatedAt: { gte: cutoff } } });
  return hydrateStatus(rows, now);
}

/**
 * Load persisted status into the map (call once, before serving). Keys a
 * writer already set in this process win over the row. Working sessions get
 * their span and auto-idle timer back; pending milestones their expiry timer.
 * Rows older than HYDRATE_MAX_AGE_MS are deleted.
 */
export async function hydrateStatuses(now: number = Date.now()): Promise<number> {
  let loaded = 0;
  for (const h of await readHydratable(now)) {
    if (statusMap.has(statusKey(h.instanceId, h.session))) continue;
    applyHydrated(h, now);
    loaded++;
  }
  return loaded;
}

/**
 * Read session_statuses again after this process took the lease over
 *: until the load balancer moved, the
 * displaced process kept taking status writes, which landed in the table but
 * not in this map. A row strictly newer than the entry here replaces it. The
 * working span this process held for it is dropped unbanked, because the
 * process that wrote the row banked it on that transition. A session deleted
 * there in the meantime is not noticed; its next write or kill corrects it.
 */
export async function rehydrateStatuses(now: number = Date.now()): Promise<number> {
  let replaced = 0;
  for (const h of await readHydratable(now)) {
    const key = statusKey(h.instanceId, h.session);
    if (!rowIsNewer(h, statusMap.get(key))) continue;
    workingSessions.delete(key);
    const idle = autoIdleTimers.get(key);
    if (idle) { clearTimeout(idle); autoIdleTimers.delete(key); }
    clearMilestoneTimer(h.session, h.instanceId);
    applyHydrated(h, now);
    onStatusChange?.(h.session, h.instanceId);
    replaced++;
  }
  return replaced;
}

/**
 * A transition the sidebar's "stopped since you looked" marker counts: the
 * agent was busy (working, or asking) and is now at rest. Waiting itself is
 * not a stop; it has its own standing colour.
 */
export function comesToRest(from: AgentStatus['status'] | undefined, to: AgentStatus['status']): boolean {
  return (from === 'working' || from === 'waiting') && (to === 'idle' || to === 'not_running');
}

// ── Public status API ──────────────────────────────────────────

/** Whether the session has a live status entry (getStatus answers not_running for one that has none). */
export function hasStatus(sessionName: string, instanceId: string | null = null): boolean {
  return statusMap.has(statusKey(instanceId, sessionName));
}

export function getStatus(sessionName: string, instanceId: string | null = null): AgentStatus {
  return statusMap.get(statusKey(instanceId, sessionName))
    ?? { status: 'not_running', updatedAt: new Date(), instanceId };
}

export function getAllStatuses(): Map<string, AgentStatus> {
  return statusMap;
}

/** Update metadata fields without changing the status itself */
export function updateStatusMeta(
  sessionName: string,
  meta: Partial<AgentStatusMeta>,
  instanceId: string | null = null,
): void {
  const key = statusKey(instanceId, sessionName);
  const existing = statusMap.get(key);
  if (!existing) return; // no status to update — ignore
  const { instanceId: _drop, ...rest } = meta;
  const next: AgentStatus = { ...existing, ...rest, instanceId, updatedAt: new Date() };
  statusMap.set(key, next);
  persistIfChanged(sessionName, instanceId, existing, next);
}

export function setStatus(
  sessionName: string,
  status: AgentStatus['status'],
  messageOrMeta?: string | AgentStatusMeta,
  metaMaybe?: AgentStatusMeta,
  instanceId?: string | null,
): AgentStatus {
  const meta = typeof messageOrMeta === 'string'
    ? { ...(metaMaybe || {}), message: messageOrMeta }
    : (messageOrMeta || {});
  // Positional instanceId wins when the caller passed it (including null).
  // Otherwise a meta.instanceId from a caller that already has a meta bag applies.
  const resolvedInstanceId = instanceId !== undefined ? instanceId : (meta.instanceId ?? null);
  const key = statusKey(resolvedInstanceId, sessionName);

  const previous = statusMap.get(key);
  // A real non-working signal after an auto-idle cut (a late Stop, a prompt,
  // the agent exiting) says the turn did end: no tail credit on a resume. The
  // auto-idle write itself doesn't come through here.
  if (status !== 'working') autoIdleTails.delete(key);
  const now = new Date();
  // When the current status began: a repeat of the same status keeps it (a
  // hook POST during a working turn is not a new status), a change starts it.
  // An entry from before this field (hydrated, or older) counts from its
  // last write, the best that is known.
  const since = previous?.status === status ? previous.statusSince ?? previous.updatedAt : now;

  const entry: AgentStatus = {
    status,
    updatedAt: now,
    statusSince: since,
    instanceId: resolvedInstanceId,
    message: meta.message,
    source: meta.source,
    waitingReason: meta.waitingReason,
    activityScore: meta.activityScore,
    tokenBurst: meta.tokenBurst,
    activeTurn: meta.activeTurn,
    threadId: meta.threadId,
    pollerMeta: meta.pollerMeta,
    // Preserve contextTokens from previous state unless explicitly provided
    contextTokens: meta.contextTokens ?? previous?.contextTokens,
    // Same for the milestone: a status flip (working → idle) must not drop a
    // pending "PR opened" prompt. An explicit null clears it.
    milestone: meta.milestone !== undefined ? meta.milestone : previous?.milestone,
    // Same for the review ring's pane state: the sweep owns it, so a hook- or
    // poller-driven flip of `status` must not drop it. An explicit null clears
    // it (the sweep's pane-gone / stop paths).
    review: meta.review !== undefined ? meta.review : previous?.review,
    // And a handoff in flight: its route and sweep own it.
    handoff: meta.handoff !== undefined ? meta.handoff : previous?.handoff,
    // Preserve rateLimited unless explicitly provided (null clears it). A
    // process that is gone cannot be throttled, so not_running always drops
    // it: otherwise a provider error followed by an agent restart left the
    // badge up until the *same* process saw a success, which never comes.
    rateLimited: status === 'not_running' ? null
      : meta.rateLimited !== undefined ? meta.rateLimited : previous?.rateLimited,
    stoppedAt: meta.stoppedAt !== undefined ? meta.stoppedAt
      : comesToRest(previous?.status, status) ? now : previous?.stoppedAt,
  };
  statusMap.set(key, entry);
  if (previous?.status !== status) {
    onStatusTransition?.(sessionName, resolvedInstanceId, previous?.status, status);
    // The transition as a product event: the new status, why it waits, and
    // how long the previous status lasted (from when it began, not from the
    // last write: meta writes and repeated posts bump updatedAt). Not the message.
    const previousSince = previous ? previous.statusSince ?? previous.updatedAt : null;
    recordSessionEvent('agent.status.changed', sessionName, resolvedInstanceId, {
      status,
      previousStatus: previous?.status ?? null,
      waitingReason: status === 'waiting' ? meta.waitingReason ?? null : null,
      previousStatusSeconds: previousSince ? Math.max(0, Math.round((now.getTime() - previousSince.getTime()) / 1000)) : null,
      provider: providerForSourceOrNull(meta.source) ?? providerForSourceOrNull(previous?.source) ?? 'claude',
    });
  }

  // Working-time tracking: start/stop timers on transitions
  if (status === 'working' && previous?.status !== 'working') {
    startWorkingTimer(sessionName, resolvedInstanceId, meta.source);
  } else if (status !== 'working' && previous?.status === 'working') {
    stopWorkingTimer(sessionName, resolvedInstanceId);
  }

  persistIfChanged(sessionName, resolvedInstanceId, previous, entry);

  // Set auto-idle only when working
  if (status === 'working') {
    noteBoxActivity(resolvedInstanceId);
    armAutoIdle(sessionName, resolvedInstanceId, AUTO_IDLE_MS);
  } else {
    const existing = autoIdleTimers.get(key);
    if (existing) { clearTimeout(existing); autoIdleTimers.delete(key); }
  }

  return entry;
}

// Resolve stoplight emoji from status + process check
export async function resolveStoplight(sessionName: string, instanceId: string | null = null): Promise<string> {
  const s = getStatus(sessionName, instanceId);
  const age = Date.now() - s.updatedAt.getTime();
  const STALE_MS = 10 * 60 * 1000;

  if (s.status === 'working') return '🟢';
  if (s.status === 'waiting') return '🟡';
  // Ready (idle) is white, not red: red reads as a fault.
  if (s.status === 'idle' && age < STALE_MS) return '⚪';

  // Stale or unknown — fall back to process check
  const running = await isAgentRunning(sessionName);
  if (running) return '🔘';
  const exists = s.status !== 'not_running';
  return exists ? '⚪' : '💤';
}

/**
 * Carry a session's live status to a new session name (workstream rename).
 * The entry, its meta (contextTokens, milestone, rateLimited…) and the
 * pending milestone expiry move; the old key is dropped. Returns false when
 * there was nothing live to move. The working span is banked under the old
 * name and a new one starts under the new name — attribution is by project,
 * so nothing is lost.
 */
export function moveStatus(fromSession: string, toSession: string, instanceId: string | null = null): boolean {
  const prev = statusMap.get(statusKey(instanceId, fromSession));
  const tail = autoIdleTails.get(statusKey(instanceId, fromSession));
  // Before deleteStatus, which forgets the old key's turns: a desktop thread
  // still working must keep the renamed session working.
  moveTurns(statusKey(instanceId, fromSession), statusKey(instanceId, toSession));
  deleteStatus(fromSession, instanceId);
  if (!prev || prev.status === 'not_running') return false;
  const { status, updatedAt: _u, statusSince: _s, instanceId: _i, ...meta } = prev;
  setStatus(toSession, status, meta, undefined, instanceId);
  // After setStatus, which drops a tail on any non-working write. Attribution
  // is by project, so the tail's identity still holds under the new name.
  if (tail) autoIdleTails.set(statusKey(instanceId, toSession), tail);
  if (prev.milestone && !isMilestoneExpired(prev.milestone, Date.now())) {
    armMilestoneTimer(toSession, instanceId, MILESTONE_TTL_MS - (Date.now() - prev.milestone.at.getTime()));
  }
  return true;
}

export function deleteStatus(sessionName: string, instanceId: string | null = null): void {
  const key = statusKey(instanceId, sessionName);
  stopWorkingTimer(sessionName, instanceId);
  autoIdleTails.delete(key);
  forgetTurns(key);
  statusMap.delete(key);
  const timer = autoIdleTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    autoIdleTimers.delete(key);
  }
  clearMilestoneTimer(sessionName, instanceId);
  unpersist(sessionName, instanceId);
}

// Hook for pushing status changes to WebSocket clients.
let onStatusChange: ((sessionName: string, instanceId: string | null) => void) | null = null;

export function setStatusChangeCallback(fn: (sessionName: string, instanceId: string | null) => void): void {
  onStatusChange = fn;
}

// Hook for the spawn status history (services/spawnStatusLog.ts): every change of
// `status` itself, not of its metadata. Kept a callback so this module imports
// nothing of the spawn code.
let onStatusTransition: ((sessionName: string, instanceId: string | null, from: AgentStatus['status'] | undefined, to: AgentStatus['status']) => void) | null = null;

export function setStatusTransitionCallback(fn: typeof onStatusTransition): void {
  onStatusTransition = fn;
}

export function notifyStatusChange(sessionName: string, instanceId: string | null = null): void {
  onStatusChange?.(sessionName, instanceId);
}

/**
 * The status of an agent pane whose agent was just killed to start another
 * there: a handoff restart (services/agentHandoffSweep.ts). Switch agent
 * (routes/workstreams.ts) does the same steps inline. not_running ends its working-time
 * span (booked to the old provider) and drops its rate-limit badge, so the
 * row does not show a stale "working" until the new agent's first post. What
 * the old agent left that a merge would otherwise carry over goes too: a
 * pending "PR opened" prompt (explicit null) and its context reading (only
 * clearable as a metadata write — setStatus keeps it via `??`). The Review
 * pane's ring state stays: that pane is still running.
 */
export function markAgentPaneStopped(sessionName: string, instanceId: string | null, meta: AgentStatusMeta = {}): void {
  const before = statusMap.get(statusKey(instanceId, sessionName));
  // An agent that was running is over: one ended event per stop, none for a
  // repeat of not_running.
  if (before && before.status !== 'not_running') {
    recordSessionEvent('agent.session.ended', sessionName, instanceId, {
      kind: isRunnerSessionShaped(sessionName) ? 'cloud' : 'interactive',
      provider: providerForSourceOrNull(before.source) ?? 'claude',
      lastStatus: before.status,
    });
  }
  setStatus(sessionName, 'not_running', { milestone: null, ...meta }, undefined, instanceId);
  clearMilestoneTimer(sessionName, instanceId);
  updateStatusMeta(sessionName, { contextTokens: undefined }, instanceId);
  notifyStatusChange(sessionName, instanceId);
}
