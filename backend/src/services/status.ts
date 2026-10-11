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
import {
  AUTO_IDLE_MS, HYDRATE_MAX_AGE_MS, hydrateStatus, instanceKeyOf, persistRetryDelayMs, rowIsNewer, shouldPersist, toRow,
  type HydratedStatus,
} from './statusPersistence';


// In-memory status map. Keyed by statusKey(instanceId, session) — the tmux
// name is not unique across boxes. Written through to session_statuses
// (statusPersistence.ts) and re-read by hydrateStatuses() at startup.
const statusMap: StatusMap = new Map();

// Auto-revert "working" → "idle" after AUTO_IDLE_MS (safety net if Stop hook doesn't fire)
const autoIdleTimers = new Map<string, NodeJS.Timeout>();

// Pending "PR opened" milestones expire on their own (MILESTONE_TTL_MS) so a
// prompt nobody acted on never lingers.
const milestoneTimers = new Map<string, NodeJS.Timeout>();

type AgentStatusMeta = Omit<Partial<AgentStatus>, 'status' | 'updatedAt'>;

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

function startWorkingTimer(sessionName: string, instanceId: string | null, source?: string): void {
  const key = statusKey(instanceId, sessionName);
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

function stopWorkingTimer(sessionName: string, instanceId: string | null, endedAt: number = Date.now()): void {
  const key = statusKey(instanceId, sessionName);
  const session = workingSessions.get(key);
  if (!session) return;
  workingSessions.delete(key);

  const durationMs = endedAt - session.startedAt;
  if (durationMs < 1000) return; // ignore sub-second blips

  // The day the span ended, not now: a span banked late (hydration after a
  // restart past midnight) belongs to the day the timer would have fired.
  const date = todayStr(new Date(endedAt));
  const identity = workTimeIdentity(session.username, session.project, session.provider, date, session.instanceId);
  prisma.workTimeEntry.upsert({
    where: { username_project_provider_date_instanceId: identity },
    update: {
      totalMs: { increment: durationMs },
      sessions: { increment: 1 },
    },
    create: {
      ...identity,
      totalMs: durationMs,
      sessions: 1,
    },
  }).catch(err => {
    console.error('[WORKTIME] Failed to persist:', (err as Error).message);
  });
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
  const timer = setTimeout(() => {
    autoIdleTimers.delete(key);
    const current = statusMap.get(key);
    if (current?.status === 'working') {
      const idled: AgentStatus = {
        status: 'idle',
        updatedAt: new Date(),
        instanceId,
        message: 'Auto-idled after inactivity',
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
      };
      statusMap.set(key, idled);
      stopWorkingTimer(sessionName, instanceId);
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
  statusMap.set(key, h.status);
  lastWrittenAt.set(key, now);
  const parsed = parseSessionName(h.session, h.instanceId);
  if (parsed && (h.span || h.bank)) {
    const span = h.span ?? h.bank!;
    workingSessions.set(key, {
      startedAt: span.startedAt, provider: span.provider,
      project: parsed.project, username: parsed.username, instanceId: h.instanceId,
    });
    if (h.bank) stopWorkingTimer(h.session, h.instanceId, h.bank.endedAt);
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

// ── Public status API ──────────────────────────────────────────

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

  const entry: AgentStatus = {
    status,
    updatedAt: new Date(),
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
    // Preserve rateLimited unless explicitly provided (null clears it). A
    // process that is gone cannot be throttled, so not_running always drops
    // it: otherwise a provider error followed by an agent restart left the
    // badge up until the *same* process saw a success, which never comes.
    rateLimited: status === 'not_running' ? null
      : meta.rateLimited !== undefined ? meta.rateLimited : previous?.rateLimited,
  };
  statusMap.set(key, entry);

  // Working-time tracking: start/stop timers on transitions
  if (status === 'working' && previous?.status !== 'working') {
    startWorkingTimer(sessionName, resolvedInstanceId, meta.source);
  } else if (status !== 'working' && previous?.status === 'working') {
    stopWorkingTimer(sessionName, resolvedInstanceId);
  }

  persistIfChanged(sessionName, resolvedInstanceId, previous, entry);

  // Set auto-idle only when working
  if (status === 'working') {
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
  if (s.status === 'idle' && age < STALE_MS) return '🔴';

  // Stale or unknown — fall back to process check
  const running = await isAgentRunning(sessionName);
  if (running) return '🔘';
  const exists = s.status !== 'not_running';
  return exists ? '🔴' : '💤';
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
  deleteStatus(fromSession, instanceId);
  if (!prev || prev.status === 'not_running') return false;
  const { status, updatedAt: _u, instanceId: _i, ...meta } = prev;
  setStatus(toSession, status, meta, undefined, instanceId);
  if (prev.milestone && !isMilestoneExpired(prev.milestone, Date.now())) {
    armMilestoneTimer(toSession, instanceId, MILESTONE_TTL_MS - (Date.now() - prev.milestone.at.getTime()));
  }
  return true;
}

export function deleteStatus(sessionName: string, instanceId: string | null = null): void {
  const key = statusKey(instanceId, sessionName);
  stopWorkingTimer(sessionName, instanceId);
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

export function notifyStatusChange(sessionName: string, instanceId: string | null = null): void {
  onStatusChange?.(sessionName, instanceId);
}
