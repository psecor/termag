/**
 * Admin views of Claude Code cloud sessions: the orchestrator's own health, read from its loopback
 * `/healthz` on this host, and the org-wide picture of runs and queued
 * sessions. No titles here: the title is the owner's first prompt, and the
 * admin surface shows aggregates and metadata only.
 */
import { prisma } from '../../db';
import { instanceAgentTransport, isInstanceAgentConnected } from '../agentRegistry';
import { MAX_RUNNERS_PER_BOX, REFUSAL_TEXTS, RUNNER_AGENT_CAPABILITY, runnerBoxes } from '../claudeRunnerSpawn';
import type { Range } from './range';
import { getAllStatuses } from '../status';
import { statusKey } from '../statusKey';
import { buildSessions, isStartedFor, liveRuns, RUN_LOST_REASON, usageSelect, type CloudSessionView, type EventInput, type RunInput } from '../claudeSessions';

export interface OrchestratorHealth {
  /** False when no health port is configured (a host without the orchestrator) or the port does not answer. */
  available: boolean;
  reason?: string;
  port: number | null;
  /** The body as the orchestrator serves it: `connected`, `queue_counts`, `last_poll_at`, ... */
  body: Record<string, unknown> | null;
  fetchedAt: string;
  /** True when this answer came from the short cache rather than a fresh fetch. */
  cached: boolean;
  /**
   * Where the history lives: the observability view the orchestrator's journal
   * shipper feeds, from OBSERVABILITY_UI_URL in the backend environment.
   * Null when unset; the UI then shows no link rather than a guessed one.
   */
  observabilityUrl: string | null;
}

/** The orchestrator unit's `--health-port`, written to the backend .env by cloud-init on a host that runs it. */
export function orchestratorHealthPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.CLAUDE_RUNNER_ORCHESTRATOR_HEALTH_PORT?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** The Observability UI link the admin page shows beside the health; https only, never guessed. */
export function observabilityUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.OBSERVABILITY_UI_URL?.trim();
  return raw && /^https:\/\/[^\s]+$/.test(raw) ? raw : null;
}

const HEALTH_TIMEOUT_MS = 2000;
const HEALTH_CACHE_MS = 10_000;
let healthCache: { at: number; value: OrchestratorHealth } | null = null;

export type HealthFetcher = (url: string, timeoutMs: number) => Promise<Record<string, unknown>>;

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const body = await res.json() as Record<string, unknown>;
    return body;
  } finally {
    clearTimeout(t);
  }
}

/**
 * The orchestrator's `/healthz`, fetched with a two-second timeout and cached
 * ten seconds (the admin page polls; the unit need not answer every viewer).
 * The endpoint always answers 200 while the process is alive, so what matters
 * is the body: `connected` says whether the last poll of Anthropic succeeded,
 * `queue_counts` how many spawn requests sit in each state.
 */
export async function orchestratorHealth(opts: { env?: NodeJS.ProcessEnv; fetcher?: HealthFetcher; now?: number } = {}): Promise<OrchestratorHealth> {
  const now = opts.now ?? Date.now();
  const port = orchestratorHealthPort(opts.env);
  const observabilityUrl = observabilityUrlFromEnv(opts.env);
  if (!port) {
    return { available: false, reason: 'no orchestrator health port configured on this host (CLAUDE_RUNNER_ORCHESTRATOR_HEALTH_PORT)', port: null, body: null, fetchedAt: new Date(now).toISOString(), cached: false, observabilityUrl };
  }
  if (healthCache && now - healthCache.at < HEALTH_CACHE_MS) return { ...healthCache.value, cached: true };
  const fetcher = opts.fetcher ?? fetchJson;
  let value: OrchestratorHealth;
  try {
    const body = await fetcher(`http://127.0.0.1:${port}/healthz`, HEALTH_TIMEOUT_MS);
    value = { available: true, port, body, fetchedAt: new Date(now).toISOString(), cached: false, observabilityUrl };
  } catch (err) {
    value = { available: false, reason: `the orchestrator did not answer on 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`, port, body: null, fetchedAt: new Date(now).toISOString(), cached: false, observabilityUrl };
  }
  healthCache = { at: now, value };
  return value;
}

/** Tests only. */
export function resetOrchestratorHealthCache(): void { healthCache = null; }

/**
 * What the status map knows about a running session right now, under the
 * runner's tmux name: the same entry the project-pane tables show. Null for
 * a session with no open run, or one nothing has posted for yet.
 */
export interface CloudLiveStatus {
  status: 'working' | 'waiting' | 'idle' | 'not_running';
  waitingReason: string | null;
  rateLimited: string | null;
  contextTokens: number | null;
  /** The last status write, a lower bound for "waiting since". */
  updatedAt: string;
}

/** A session as the admin sees it: the owner's view minus the title, plus the owner and the live status. */
export type AdminCloudSession = Omit<CloudSessionView, 'title'> & { owner: string; live: CloudLiveStatus | null };

export interface AdminCloudSessions {
  /** Days of history read. */
  days: number;
  /** Runs live or starting now, grouped by box; `connected` is the box agent's state when the view was built. */
  boxes: Array<{ instanceId: string; boxName: string; owner: string; connected: boolean; sessions: AdminCloudSession[] }>;
  /** Sessions the orchestrator could not place, with the reason. */
  queued: AdminCloudSession[];
  /** Ended and lost sessions in the window, newest first, capped. */
  recent: AdminCloudSession[];
  counts: { running: number; starting: number; queued: number; ended: number; lost: number };
  generatedAt: string;
}

const RECENT_CAP = 50;

const runSelect = {
  orderId: true, sessionId: true, instanceId: true, userId: true, slot: true, startedAt: true, endedAt: true,
  // No `title`: the admin surface never reads an owner's first prompt, so it is not fetched.
  exitStatus: true, exitReason: true, clientPlatform: true, sessionSeq: true, ...usageSelect,
  user: { select: { unixUsername: true } },
  instance: { select: { name: true, hostUnixUser: true, status: true } },
} as const;

/**
 * Every user's cloud sessions in the window, grouped like the owner's view
 * (services/claudeSessions.ts) but with the owner named and the title left
 * out. One tmux-list per box with open runs, as the owner's list does.
 */
export const RECENT_LIMIT_MAX = 500;

export async function adminCloudSessions(days = 7, now: Date = new Date(), recentLimit: number = RECENT_CAP): Promise<AdminCloudSessions> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.claudeRunnerSession.findMany({
    where: { OR: [{ endedAt: null }, { startedAt: { gte: since } }, { endedAt: { gte: since } }] },
    select: runSelect,
  });
  // The window's events plus every event of a run still open: an open run's
  // `started` decides running versus starting however long ago it happened.
  const openOrders = rows.filter(r => !r.endedAt).map(r => r.orderId);
  const events = await prisma.claudeSessionEvent.findMany({
    where: { OR: [{ at: { gte: since } }, ...(openOrders.length ? [{ orderId: { in: openOrders } }] : [])] },
    select: { sessionId: true, orderId: true, instanceId: true, kind: true, detail: true, code: true, at: true, user: { select: { unixUsername: true } } },
  });
  const ownerByKey = new Map<string, string>();
  const runs: RunInput[] = rows.map(r => {
    const key = r.sessionId ?? `order:${r.orderId}`;
    ownerByKey.set(key, r.user.unixUsername);
    return {
      orderId: r.orderId, sessionId: r.sessionId, instanceId: r.instanceId, boxName: r.instance.name, hostUnixUser: r.instance.hostUnixUser,
      slot: r.slot, startedAt: r.startedAt, endedAt: r.endedAt, exitStatus: r.exitStatus, exitReason: r.exitReason,
      clientPlatform: r.clientPlatform, title: null, sessionSeq: r.sessionSeq, usage: r, checkoutBytes: r.checkoutBytes, kept: r.kept,
    };
  });
  const eventInputs: EventInput[] = events.map(e => {
    if (!ownerByKey.has(e.sessionId)) ownerByKey.set(e.sessionId, e.user.unixUsername);
    return { sessionId: e.sessionId, orderId: e.orderId, instanceId: e.instanceId, kind: e.kind, detail: e.detail, code: e.code, at: e.at };
  });
  const alive = await liveRuns(runs);
  const views = buildSessions(runs, eventInputs, alive);
  // The raw map, not getStatus(): that helper fabricates a fresh `not_running`
  // for unknown names, which would date every never-seen session to now.
  const statuses = getAllStatuses();
  const sessions: AdminCloudSession[] = views.map(v => {
    // The view type carries a title slot; it is null here (never fetched) and left out of the answer.
    const { title: _title, ...rest } = v;
    void _title;
    return { ...rest, owner: ownerByKey.get(v.key) ?? '?', live: liveStatusFor(v, statuses) };
  });

  const byBox = new Map<string, AdminCloudSessions['boxes'][number]>();
  const queued: AdminCloudSession[] = [];
  const recent: AdminCloudSession[] = [];
  const counts = { running: 0, starting: 0, queued: 0, ended: 0, lost: 0 };
  for (const s of sessions) {
    counts[s.state]++;
    if (s.state === 'queued') { queued.push(s); continue; }
    if (s.state === 'ended' || s.state === 'lost') { recent.push(s); continue; }
    const run = s.current!;
    let box = byBox.get(run.instanceId);
    if (!box) { box = { instanceId: run.instanceId, boxName: run.boxName, owner: s.owner, connected: isInstanceAgentConnected(run.instanceId), sessions: [] }; byBox.set(run.instanceId, box); }
    box.sessions.push(s);
  }
  for (const b of byBox.values()) b.sessions.sort((a, c) => a.current!.slot - c.current!.slot);
  return {
    days,
    boxes: [...byBox.values()].sort((a, b) => a.boxName.localeCompare(b.boxName)),
    queued,
    recent: recent.slice(0, Math.min(Math.max(1, recentLimit), RECENT_LIMIT_MAX)),
    counts,
    generatedAt: now.toISOString(),
  };
}

/**
 * The status-map entry behind a session's current run: only for a `running`
 * session (the box posted `started`, so the child exists and its hooks are
 * the writer) with a tmux name (a box whose unix user is unknown has none).
 * A `starting` session's entry, if any, is a stale one from an earlier
 * launch under the same name. Never the entry's `message`: it can carry a
 * notification's text, and the admin surface shows metadata only.
 */
export function liveStatusFor(v: Pick<CloudSessionView, 'state' | 'current'>, statuses: ReadonlyMap<string, { status: CloudLiveStatus['status']; updatedAt: Date; waitingReason?: string | null; rateLimited?: string | null; contextTokens?: number | null }>): CloudLiveStatus | null {
  const run = v.current;
  if (!run || run.endedAt || !run.sessionName || v.state !== 'running') return null;
  // The probe found no tmux session: the runner is gone and the lost sweep
  // has not caught up. Its last entry would be a phantom wait.
  if (run.alive === false) return null;
  const raw = statuses.get(statusKey(run.instanceId, run.sessionName));
  if (!raw) return null;
  return {
    status: raw.status, waitingReason: raw.waitingReason ?? null, rateLimited: raw.rateLimited ?? null,
    contextTokens: raw.contextTokens ?? null, updatedAt: raw.updatedAt.toISOString(),
  };
}

export interface CloudCounts { running: number; starting: number }

/**
 * The cheap org-wide picture, for the Overview KPI, the Fleet and Users
 * tables and the signals: open runs per box and per owner, split into
 * running (the box posted `started`) and starting, and how many sessions are
 * queued (newest event in the last day is a refusal and no run is open).
 * Reads Postgres only: no `tmux-list`, so it can ride on every poll.
 */
export interface CloudSummary {
  running: number;
  starting: number;
  queued: number;
  byBox: Record<string, CloudCounts>;
  byUser: Record<string, CloudCounts>;
  generatedAt: string;
}

const QUEUED_WINDOW_MS = 24 * 60 * 60 * 1000;
const REFUSALS = new Set(['queued', 'agent-failed']);

export async function cloudSummary(now: Date = new Date()): Promise<CloudSummary> {
  const open = await prisma.claudeRunnerSession.findMany({
    where: { endedAt: null },
    select: { orderId: true, sessionId: true, instanceId: true, userId: true, startedAt: true },
  });
  const openOrders = open.map(r => r.orderId);
  const [started, recent] = await Promise.all([
    openOrders.length
      ? prisma.claudeSessionEvent.findMany({ where: { orderId: { in: openOrders }, kind: 'started' }, select: { orderId: true, at: true } })
      : Promise.resolve([] as Array<{ orderId: string; at: Date }>),
    prisma.claudeSessionEvent.findMany({
      where: { at: { gte: new Date(now.getTime() - QUEUED_WINDOW_MS) } },
      select: { sessionId: true, orderId: true, kind: true, at: true },
    }),
  ]);
  // A `started` counts for the launch it belongs to: a relaunched order's row
  // is reopened with a new startedAt, and its earlier launch's event is not
  // proof that the new child spawned (services/claudeSessions.ts, isStartedFor).
  const byOrder = new Map(open.map(r => [r.orderId, r]));
  const startedOrders = new Set(started.filter(e => { const r = byOrder.get(e.orderId); return r && isStartedFor({ kind: 'started', orderId: e.orderId, at: e.at }, r); }).map(e => e.orderId));
  const bump = (m: Record<string, CloudCounts>, key: string, running: boolean) => {
    const c = m[key] ?? (m[key] = { running: 0, starting: 0 });
    if (running) c.running++; else c.starting++;
  };
  const byBox: Record<string, CloudCounts> = {};
  const byUser: Record<string, CloudCounts> = {};
  let running = 0, starting = 0;
  for (const r of open) {
    const isRunning = startedOrders.has(r.orderId);
    if (isRunning) running++; else starting++;
    bump(byBox, r.instanceId, isRunning);
    bump(byUser, r.userId, isRunning);
  }
  // The newest open run per session, for the same rule deriveState applies:
  // a refusal newer than the latest run and for another order is a re-offer
  // that failed while the old run lingers, and that session is queued.
  const openBySession = new Map<string, { orderId: string; startedAt: Date }>();
  for (const r of open) {
    if (!r.sessionId) continue;
    const cur = openBySession.get(r.sessionId);
    if (!cur || r.startedAt > cur.startedAt) openBySession.set(r.sessionId, { orderId: r.orderId, startedAt: r.startedAt });
  }
  const newest = new Map<string, { kind: string; orderId: string; at: Date }>();
  for (const e of recent) {
    const cur = newest.get(e.sessionId);
    if (!cur || e.at.getTime() > cur.at.getTime()) newest.set(e.sessionId, { kind: e.kind, orderId: e.orderId, at: e.at });
  }
  let queued = 0;
  for (const [sessionId, e] of newest) {
    if (!REFUSALS.has(e.kind)) continue;
    const run = openBySession.get(sessionId);
    if (!run || (e.orderId !== run.orderId && e.at.getTime() > run.startedAt.getTime())) queued++;
  }
  return { running, starting, queued, byBox, byUser, generatedAt: now.toISOString() };
}

// ── Capacity ─────────────────

/** One box as the spawn route would judge it, with the slots its open runs hold. */
export interface BoxCapacity {
  instanceId: string;
  boxName: string;
  userId: string | null;
  owner: string | null;
  status: string;
  connected: boolean;
  /** The agent announced it can run a runner (RUNNER_AGENT_CAPABILITY). */
  capable: boolean;
  /** The spawn route's rule: ec2, ready, connected, capable, home and unix user known. */
  eligible: boolean;
  /** Open runs on the box (Postgres; the lost sweep closes a vanished run within ten minutes). */
  slotsUsed: number;
  slotsMax: number;
  /** Host pressure from the agent (S5); null until an agent that samples has connected. */
  host: HostPressure | null;
}

export interface HostPressure { diskUsedPct: number | null; memUsedPct: number | null; load1: number | null; keptCheckouts: number | null; sampledAt: string }

export function hostPressureOf(r: { diskUsedPct: number | null; memUsedPct: number | null; load1: number | null; keptCheckouts: number | null; hostSampledAt: Date | null }): HostPressure | null {
  if (!r.hostSampledAt) return null;
  return { diskUsedPct: r.diskUsedPct, memUsedPct: r.memUsedPct, load1: r.load1, keptCheckouts: r.keptCheckouts, sampledAt: r.hostSampledAt.toISOString() };
}

export interface OwnerCapacity { owner: string; eligibleBoxes: number; slotsUsed: number; slotsFree: number; /** Every eligible box full, and there is at least one. */ atCap: boolean; boxes: string }

export interface Capacity {
  max: number;
  boxes: BoxCapacity[];
  owners: Record<string, OwnerCapacity>;
  totals: { eligibleBoxes: number; slotsUsed: number; slotsFree: number };
  generatedAt: string;
}

/**
 * "1 ready · full, 1 stopped, 1 ready · agent offline": an owner's boxes in
 * one phrase, for a queued row and the cloud_queued signal, so the admin can
 * tell "nudge them to start a box" from "raise the cap".
 */
export function describeOwnerBoxes(boxes: readonly BoxCapacity[]): string {
  if (boxes.length === 0) return 'no boxes';
  const phrase = (b: BoxCapacity): string => {
    if (b.status !== 'ready') return b.status;
    if (!b.connected) return 'ready · agent offline';
    if (!b.capable) return 'ready · agent too old';
    if (!b.eligible) return 'ready · not eligible';
    return b.slotsUsed >= b.slotsMax ? 'ready · full' : `ready · ${b.slotsMax - b.slotsUsed} free`;
  };
  const counts = new Map<string, number>();
  for (const b of boxes) { const k = phrase(b); counts.set(k, (counts.get(k) ?? 0) + 1); }
  return [...counts].map(([k, n]) => `${n} ${k}`).join(', ');
}

/** The pure half of capacity(): the owner rollups and totals over judged boxes. */
export function capacityFromBoxes(boxes: BoxCapacity[], max: number, now: Date): Capacity {
  const owners: Record<string, OwnerCapacity> = {};
  const byOwner = new Map<string, BoxCapacity[]>();
  for (const b of boxes) if (b.userId) { const l = byOwner.get(b.userId) ?? []; l.push(b); byOwner.set(b.userId, l); }
  for (const [userId, list] of byOwner) {
    const eligible = list.filter(b => b.eligible);
    const slotsUsed = eligible.reduce((n, b) => n + Math.min(b.slotsUsed, b.slotsMax), 0);
    const slotsFree = eligible.reduce((n, b) => n + Math.max(0, b.slotsMax - b.slotsUsed), 0);
    owners[userId] = { owner: list[0].owner ?? '?', eligibleBoxes: eligible.length, slotsUsed, slotsFree, atCap: eligible.length > 0 && slotsFree === 0, boxes: describeOwnerBoxes(list) };
  }
  const eligible = boxes.filter(b => b.eligible);
  return {
    max, boxes, owners,
    totals: {
      eligibleBoxes: eligible.length,
      slotsUsed: eligible.reduce((n, b) => n + Math.min(b.slotsUsed, b.slotsMax), 0),
      slotsFree: eligible.reduce((n, b) => n + Math.max(0, b.slotsMax - b.slotsUsed), 0),
    },
    generatedAt: now.toISOString(),
  };
}

/**
 * Slots used and free per box and per owner against MAX_RUNNERS_PER_BOX, with
 * every non-terminated box judged by the spawn route's eligibility rule.
 * Postgres and the agent registry only: no box RPC.
 */
export async function capacity(now: Date = new Date()): Promise<Capacity> {
  const [rows, summary] = await Promise.all([
    prisma.instance.findMany({
      where: { status: { not: 'terminated' } },
      select: { id: true, name: true, kind: true, status: true, hostHome: true, hostUnixUser: true, lastConnectedAt: true, userId: true, user: { select: { unixUsername: true } },
        diskUsedPct: true, memUsedPct: true, load1: true, keptCheckouts: true, hostSampledAt: true },
    }),
    cloudSummary(now),
  ]);
  const judged = rows.map(r => ({
    ...r,
    connected: isInstanceAgentConnected(r.id),
    capable: instanceAgentTransport(r.id)?.capabilities.includes(RUNNER_AGENT_CAPABILITY) ?? false,
  }));
  const eligibleIds = new Set(runnerBoxes(judged).map(b => b.id));
  const boxes: BoxCapacity[] = judged.map(r => {
    const open = summary.byBox[r.id] ?? { running: 0, starting: 0 };
    return {
      instanceId: r.id, boxName: r.name, userId: r.userId, owner: r.user?.unixUsername ?? null, status: r.status,
      connected: r.connected, capable: r.capable, eligible: eligibleIds.has(r.id),
      slotsUsed: open.running + open.starting, slotsMax: MAX_RUNNERS_PER_BOX,
      host: hostPressureOf(r),
    };
  });
  return capacityFromBoxes(boxes, MAX_RUNNERS_PER_BOX, now);
}

// ── Signal input ──────────────────

/** A session as the signals judge it: state, timing and the live entry; no title, no email, no box RPC. */
export interface CloudSignalSession {
  key: string;
  sessionId: string | null;
  userId: string;
  owner: string;
  state: CloudSessionView['state'];
  instanceId: string | null;
  boxName: string | null;
  slot: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  exitReason: string | null;
  /** The box posted `started` for the current run. */
  started: boolean;
  queuedSince: Date | null;
  queuedReason: string | null;
  live: { status: CloudLiveStatus['status']; waitingReason: string | null; contextTokens: number | null; rateLimited: string | null; updatedAt: Date } | null;
  /** Every run of the session the lost sweep closed, not only the current one: a resume under a new order must not hide an earlier loss. */
  lostRuns: Array<{ instanceId: string; boxName: string; endedAt: Date }>;
  /** Every run of the session in the window with whether its launch posted `started`, for the stale-box rule, and whether its checkout was kept. */
  runs: Array<{ orderId: string; instanceId: string; boxName: string; startedAt: Date; endedAt: Date | null; started: boolean; kept: boolean }>;
}

export interface CloudSignalInput {
  /** Every session with a run or an event in the window, or an open run. */
  sessions: CloudSignalSession[];
  /** The newest run start or end per box, for box_idle. */
  lastCloudRunAt: Record<string, Date>;
  capacity: Capacity;
  /** How far back runs and events were read. */
  windowDays: number;
}

export const SIGNAL_WINDOW_DAYS = 7;

/**
 * What the cloud signals need, from Postgres and the status map only: the
 * sessions of the last seven days built the way the admin tab builds them
 * but without the tmux probe (liveness is null), plus the capacity view.
 * Signals run on every Overview poll, so nothing here asks a box anything.
 */
export async function cloudSignalInput(now: Date = new Date()): Promise<CloudSignalInput> {
  const since = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [rows, cap] = await Promise.all([
    prisma.claudeRunnerSession.findMany({
      where: { OR: [{ endedAt: null }, { startedAt: { gte: since } }, { endedAt: { gte: since } }] },
      select: runSelect,
    }),
    capacity(now),
  ]);
  // Every fetched run's events, whatever their age: a run that started before
  // the window and ended inside it posted its `started` before the window too,
  // and must not read as a box that never reports starts.
  const orders = rows.map(r => r.orderId);
  const events = await prisma.claudeSessionEvent.findMany({
    where: { OR: [{ at: { gte: since } }, ...(orders.length ? [{ orderId: { in: orders } }] : [])] },
    select: { sessionId: true, orderId: true, instanceId: true, kind: true, detail: true, code: true, at: true, userId: true, user: { select: { unixUsername: true } } },
  });
  const ownerByKey = new Map<string, { userId: string; owner: string }>();
  const lastCloudRunAt: Record<string, Date> = {};
  const runs: RunInput[] = rows.map(r => {
    ownerByKey.set(r.sessionId ?? `order:${r.orderId}`, { userId: r.userId, owner: r.user.unixUsername });
    const newest = r.endedAt && r.endedAt > r.startedAt ? r.endedAt : r.startedAt;
    if (!lastCloudRunAt[r.instanceId] || newest > lastCloudRunAt[r.instanceId]) lastCloudRunAt[r.instanceId] = newest;
    return {
      orderId: r.orderId, sessionId: r.sessionId, instanceId: r.instanceId, boxName: r.instance.name, hostUnixUser: r.instance.hostUnixUser,
      slot: r.slot, startedAt: r.startedAt, endedAt: r.endedAt, exitStatus: r.exitStatus, exitReason: r.exitReason,
      clientPlatform: r.clientPlatform, title: null, sessionSeq: r.sessionSeq, usage: r, checkoutBytes: r.checkoutBytes, kept: r.kept,
    };
  });
  const eventInputs: EventInput[] = events.map(e => {
    if (!ownerByKey.has(e.sessionId)) ownerByKey.set(e.sessionId, { userId: e.userId, owner: e.user.unixUsername });
    return { sessionId: e.sessionId, orderId: e.orderId, instanceId: e.instanceId, kind: e.kind, detail: e.detail, code: e.code, at: e.at };
  });
  const statuses = getAllStatuses();
  const views = buildSessions(runs, eventInputs, new Map());
  const sessions: CloudSignalSession[] = views.map(v => {
    const who = ownerByKey.get(v.key) ?? { userId: '', owner: '?' };
    const live = liveStatusFor(v, statuses);
    // The current launch's `started`, not an earlier launch of the same order (isStartedFor).
    const startedFor = (r: { orderId: string; startedAt: Date }) => eventInputs.some(e => isStartedFor(e, r));
    const cur = v.current ? { orderId: v.current.orderId, startedAt: new Date(v.current.startedAt) } : null;
    const started = cur ? startedFor(cur) : false;
    const lostRuns = v.runs.filter(r => r.exitReason === RUN_LOST_REASON && r.endedAt).map(r => ({ instanceId: r.instanceId, boxName: r.boxName, endedAt: new Date(r.endedAt!) }));
    const runsOut = v.runs.map(r => { const startedAt = new Date(r.startedAt); return { orderId: r.orderId, instanceId: r.instanceId, boxName: r.boxName, startedAt, endedAt: r.endedAt ? new Date(r.endedAt) : null, started: startedFor({ orderId: r.orderId, startedAt }), kept: r.kept === true }; });
    return {
      key: v.key, sessionId: v.sessionId, userId: who.userId, owner: who.owner, state: v.state,
      instanceId: v.current?.instanceId ?? null, boxName: v.current?.boxName ?? null, slot: v.current?.slot ?? null,
      startedAt: v.current ? new Date(v.current.startedAt) : null, endedAt: v.current?.endedAt ? new Date(v.current.endedAt) : null,
      exitReason: v.current?.exitReason ?? null,
      started,
      queuedSince: v.queuedSince ? new Date(v.queuedSince) : null, queuedReason: v.queuedReason,
      live: live ? { status: live.status, waitingReason: live.waitingReason, contextTokens: live.contextTokens, rateLimited: live.rateLimited, updatedAt: new Date(live.updatedAt) } : null,
      lostRuns, runs: runsOut,
    };
  });
  return { sessions, lastCloudRunAt, capacity: cap, windowDays: SIGNAL_WINDOW_DAYS };
}

/** The reason a run row ends with when the lost sweep closed it (re-exported for the signals' tests). */
export const LOST_REASON = RUN_LOST_REASON;

// ── History ──────

export const REFUSAL_CATEGORIES = ['github', 'agent-too-old', 'no-box', 'boxes-full', 'hook-gave-up', 'box-pending', 'box-blocked', 'agent-failed', 'other'] as const;
export type RefusalCategory = typeof REFUSAL_CATEGORIES[number];

/** The auto-box codes (REFUSAL_CODES): a box on its way, or one that cannot be got. */
const CODE_CATEGORY: Record<string, RefusalCategory> = {
  github: 'github', 'agent-too-old': 'agent-too-old', 'no-box': 'no-box', 'boxes-full': 'boxes-full', 'hook-gave-up': 'hook-gave-up',
  'box-wait': 'box-pending', 'box-starting': 'box-pending', 'box-claimed': 'box-pending', 'box-provisioning': 'box-pending', 'box-on-its-way': 'box-pending',
  'box-hold': 'box-blocked', 'box-start-failed': 'box-blocked', 'no-provisioning': 'box-blocked', 'box-creation-refused': 'box-blocked',
  'agent-list-failed': 'agent-failed', 'agent-launch-failed': 'agent-failed',
};

/**
 * A refusal's category: from the event's `code` when it has one
 * (REFUSAL_CODES), else from its kind and the text the spawn route wrote
 * (REFUSAL_TEXTS): `agent-failed` by kind whatever its free text, the
 * `queued` texts by equality, boxes-full by prefix (it carries counts). The
 * text path stays for rows from before the column.
 */
export function refusalCategory(kind: string, detail: string | null, code: string | null = null): RefusalCategory {
  if (code && CODE_CATEGORY[code]) return CODE_CATEGORY[code];
  if (kind === 'agent-failed') return 'agent-failed';
  const d = detail ?? '';
  if (d === REFUSAL_TEXTS.github) return 'github';
  if (d === REFUSAL_TEXTS.agentTooOld) return 'agent-too-old';
  if (d === REFUSAL_TEXTS.noBox) return 'no-box';
  if (d.startsWith(REFUSAL_TEXTS.boxesFullPrefix)) return 'boxes-full';
  if (d === REFUSAL_TEXTS.hookGaveUp) return 'hook-gave-up';
  return 'other';
}

export const REPORT_GROUPS = ['day', 'owner', 'box', 'platform', 'exitReason'] as const;
export type ReportGroup = typeof REPORT_GROUPS[number];

export function parseReportGroup(raw: unknown): ReportGroup {
  return typeof raw === 'string' && (REPORT_GROUPS as readonly string[]).includes(raw) ? raw as ReportGroup : 'day';
}

export interface Percentiles { p50: number | null; p95: number | null; samples: number }

export interface CloudReportRow {
  key: string;
  label: string;
  /** Distinct sessions with a run started in the range. */
  sessions: number;
  runs: number;
  /** Seconds the runs held a slot inside the range (an open run counts up to now). */
  slotSeconds: number;
  /** Ends in the range by exit reason; `open` for runs still open. */
  ends: Record<string, number>;
  lost: number;
  /** Refusals in the range by category; filled for the day and owner groupings only (a refusal has no run). */
  refusals: Record<string, number>;
  /** Seconds from the start of a refusal streak to the placement that ended it. */
  queueWait: Percentiles;
  /** Seconds from `placed` to the box's `started`. */
  spawn: Percentiles;
  /** Tokens the runs that started in the range have posted about themselves (S4); 0 before a box posts usage. */
  tokens: number;
}

export interface CloudReport {
  range: { since: string; until: string; days: number };
  groupBy: ReportGroup;
  rows: CloudReportRow[];
  totals: Omit<CloudReportRow, 'key' | 'label'>;
  prior: { sessions: number; runs: number; slotSeconds: number; lost: number };
  /** Refusals in the range by category, whatever the grouping. */
  refusals: Record<string, number>;
  /** Events live this long; the refusal and latency series cover at most this many days. */
  eventHorizonDays: number;
  generatedAt: string;
}

export const EVENT_HORIZON_DAYS = 30;
const REFUSAL_KINDS = new Set(['queued', 'agent-failed']);

export function percentiles(xs: number[]): Percentiles {
  if (xs.length === 0) return { p50: null, p95: null, samples: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p50: at(0.5), p95: at(0.95), samples: s.length };
}

/** The pure half of cloudReport(): grouping and aggregation over the rows the query fetched. */
export interface ReportRunRow { orderId: string; sessionId: string | null; userId: string; owner: string; instanceId: string; boxName: string; clientPlatform: string | null; startedAt: Date; endedAt: Date | null; exitReason: string | null; /** The run's posted token total, 0 until it posts (S4). */ tokens: number }
export interface ReportEventRow { sessionId: string; orderId: string; userId: string; owner: string; instanceId: string | null; kind: string; detail: string | null; code?: string | null; at: Date }

/**
 * How far before a range the event log is read, so a queue streak that began
 * before the range and was placed inside it still yields a wait sample. The
 * orchestrator re-offers every few minutes, so a streak is continuous and a
 * day covers any wait the signals would not have screamed about long before.
 */
export const EVENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Seconds of [startedAt, endedAt or now) that fall inside [since, until). */
export function slotSecondsWithin(r: Pick<ReportRunRow, 'startedAt' | 'endedAt'>, sinceMs: number, untilMs: number, nowMs: number): number {
  const from = Math.max(r.startedAt.getTime(), sinceMs);
  const to = Math.min(r.endedAt?.getTime() ?? nowMs, untilMs);
  return Math.max(0, Math.round((to - from) / 1000));
}

/**
 * The pure half of cloudReport(). `runs` are every run that overlaps the
 * range (started before its end, not ended before its start); a run counts
 * as a session or run of the range when it STARTED inside it, holds slot time
 * for the part of its life inside it, and counts as an end when it ENDED
 * inside it, so a past range never reads a later outcome and today's slot
 * hours include yesterday's run that is still going. `events` may begin
 * EVENT_LOOKBACK_MS before the range; refusals are counted inside it only.
 */
export function buildCloudReport(runs: ReportRunRow[], events: ReportEventRow[], priorRuns: ReportRunRow[], range: Range, groupBy: ReportGroup, now: Date): CloudReport {
  const since = range.sinceTs.getTime();
  const until = range.untilTs.getTime();
  const nowMs = Math.min(now.getTime(), until);
  const inRange = (d: Date | null | undefined, from: number, to: number) => !!d && d.getTime() >= from && d.getTime() < to;
  // A run's group is where its in-range part belongs: for `exitReason` that is
  // the end inside the range, else `open` (a past range never reads a later
  // outcome); for `day` the run is split over the range's days below, so this
  // returns the start day only as a fallback for the latency samples.
  const groupOfRun = (r: ReportRunRow): [string, string] => {
    switch (groupBy) {
      case 'day': { const k = r.startedAt.toISOString().slice(0, 10); return [k, k]; }
      case 'owner': return [r.userId, r.owner];
      case 'box': return [r.instanceId, r.boxName];
      case 'platform': return [r.clientPlatform ?? 'unknown', r.clientPlatform ?? 'unknown'];
      case 'exitReason': { const k = inRange(r.endedAt, since, until) ? (r.exitReason ?? 'exit') : 'open'; return [k, k]; }
    }
  };
  const groupOfEvent = (e: ReportEventRow): [string, string] | null => {
    switch (groupBy) {
      case 'day': { const k = e.at.toISOString().slice(0, 10); return [k, k]; }
      case 'owner': return [e.userId, e.owner];
      default: return null;
    }
  };
  type Acc = { key: string; label: string; sessions: Set<string>; runs: number; slotSeconds: number; ends: Record<string, number>; lost: number; refusals: Record<string, number>; queueWait: number[]; spawn: number[]; tokens: number };
  const groups = new Map<string, Acc>();
  const acc = (key: string, label: string): Acc => {
    let g = groups.get(key);
    if (!g) { g = { key, label, sessions: new Set(), runs: 0, slotSeconds: 0, ends: {}, lost: 0, refusals: {}, queueWait: [], spawn: [], tokens: 0 }; groups.set(key, g); }
    return g;
  };
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const total: Acc = { key: '', label: '', sessions: new Set(), runs: 0, slotSeconds: 0, ends: {}, lost: 0, refusals: {}, queueWait: [], spawn: [], tokens: 0 };

  // A run's contribution to one window [from, to): slot time inside it, a
  // start if it started inside, an end if it ended inside, `open` on its
  // start day when it was not over by the range's end.
  const addRun = (a: Acc, r: ReportRunRow, from: number, to: number, endedInRange: boolean) => {
    a.slotSeconds += slotSecondsWithin(r, from, to, nowMs);
    if (inRange(r.startedAt, from, to)) {
      a.sessions.add(r.sessionId ?? `order:${r.orderId}`); a.runs++; a.tokens += r.tokens;
      if (!endedInRange) bump(a.ends, 'open');
    }
    if (inRange(r.endedAt, from, to)) {
      bump(a.ends, r.exitReason ?? 'exit');
      if (r.exitReason === RUN_LOST_REASON) a.lost++;
    }
  };
  // Day rows exist for every day of the range, so the chart has no gaps and a
  // run that started before the range never opens a row outside it.
  const days = groupBy === 'day' ? range.keys.map(k => { const start = Date.parse(`${k}T00:00:00Z`); return { k, start, end: start + 86_400_000 }; }) : [];
  for (const d of days) acc(d.k, d.k);

  const runByOrder = new Map(runs.map(r => [r.orderId, r]));
  for (const r of runs) {
    const endedHere = inRange(r.endedAt, since, until);
    addRun(total, r, since, until, endedHere);
    if (groupBy === 'day') {
      for (const d of days) addRun(acc(d.k, d.k), r, d.start, d.end, endedHere);
    } else {
      const [key, label] = groupOfRun(r);
      addRun(acc(key, label), r, since, until, endedHere);
    }
  }

  // Latencies from the event log. Spawn: placed → the current launch's started, per order.
  // Queue wait: the start of the unbroken refusal streak before a placed, per session.
  const bySession = new Map<string, ReportEventRow[]>();
  for (const e of events) { const l = bySession.get(e.sessionId) ?? []; l.push(e); bySession.set(e.sessionId, l); }
  const refusals: Record<string, number> = {};
  for (const e of events) {
    if (!REFUSAL_KINDS.has(e.kind) || !inRange(e.at, since, until)) continue;
    const cat = refusalCategory(e.kind, e.detail, e.code ?? null);
    bump(refusals, cat); bump(total.refusals, cat);
    const g = groupOfEvent(e);
    if (g) bump(acc(g[0], g[1]).refusals, cat);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      // A placement inside the range; the streak before it may reach into the lookback.
      if (e.kind !== 'placed' || !inRange(e.at, since, until)) continue;
      // By the placement's own day or owner where the grouping has one; else by the run's group.
      const run = runByOrder.get(e.orderId);
      const ge = groupOfEvent(e);
      const g = ge ? acc(...ge) : run ? acc(...groupOfRun(run)) : null;
      // Walk back over the refusals right before this placement.
      let j = i - 1;
      while (j >= 0 && REFUSAL_KINDS.has(list[j].kind)) j--;
      if (j < i - 1) {
        const wait = (e.at.getTime() - list[j + 1].at.getTime()) / 1000;
        total.queueWait.push(wait); g?.queueWait.push(wait);
      }
      const started = list.slice(i + 1).find(x => x.kind === 'started' && x.orderId === e.orderId);
      if (started) {
        const lat = (started.at.getTime() - e.at.getTime()) / 1000;
        total.spawn.push(lat); g?.spawn.push(lat);
      }
    }
  }

  const finish = (a: Acc): Omit<CloudReportRow, 'key' | 'label'> => ({
    sessions: a.sessions.size, runs: a.runs, slotSeconds: a.slotSeconds, ends: a.ends, lost: a.lost, refusals: a.refusals,
    queueWait: percentiles(a.queueWait), spawn: percentiles(a.spawn), tokens: a.tokens,
  });
  const rows = [...groups.values()].map(a => ({ key: a.key, label: a.label, ...finish(a) }));
  rows.sort((x, y) => groupBy === 'day' ? x.key.localeCompare(y.key) : (y.runs - x.runs) || x.label.localeCompare(y.label));
  // The prior range, judged by the same rules over its own window.
  const priorSince = since - range.days * 24 * 60 * 60 * 1000;
  const priorStarted = priorRuns.filter(r => inRange(r.startedAt, priorSince, since));
  return {
    range: { since: range.sinceKey, until: range.untilKey, days: range.days },
    groupBy, rows, totals: finish(total),
    prior: {
      sessions: new Set(priorStarted.map(r => r.sessionId ?? `order:${r.orderId}`)).size, runs: priorStarted.length,
      slotSeconds: priorRuns.reduce((n, r) => n + slotSecondsWithin(r, priorSince, since, nowMs), 0),
      lost: priorRuns.filter(r => r.exitReason === RUN_LOST_REASON && inRange(r.endedAt, priorSince, since)).length,
    },
    refusals, eventHorizonDays: EVENT_HORIZON_DAYS, generatedAt: now.toISOString(),
  };
}

const reportRunSelect = {
  orderId: true, sessionId: true, userId: true, instanceId: true, clientPlatform: true, startedAt: true, endedAt: true, exitReason: true,
  inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreateTokens: true,
  user: { select: { unixUsername: true } }, instance: { select: { name: true } },
} as const;

/**
 * Runs overlapping the range and events from a day before it (see
 * buildCloudReport), grouped one way; the prior range's runs for deltas. No
 * box RPC, no titles.
 */
export async function cloudReport(range: Range, groupBy: ReportGroup, now: Date = new Date()): Promise<CloudReport> {
  const priorSince = new Date(range.sinceTs.getTime() - range.days * 24 * 60 * 60 * 1000);
  const overlapping = (from: Date, to: Date) => ({ startedAt: { lt: to }, OR: [{ endedAt: null }, { endedAt: { gte: from } }] });
  const [runRows, priorRows, eventRows] = await Promise.all([
    prisma.claudeRunnerSession.findMany({ where: overlapping(range.sinceTs, range.untilTs), select: reportRunSelect }),
    prisma.claudeRunnerSession.findMany({ where: overlapping(priorSince, range.sinceTs), select: reportRunSelect }),
    prisma.claudeSessionEvent.findMany({
      where: { at: { gte: new Date(range.sinceTs.getTime() - EVENT_LOOKBACK_MS), lt: range.untilTs } },
      select: { sessionId: true, orderId: true, userId: true, instanceId: true, kind: true, detail: true, code: true, at: true, user: { select: { unixUsername: true } } },
    }),
  ]);
  const toRun = (r: typeof runRows[number]): ReportRunRow => ({
    orderId: r.orderId, sessionId: r.sessionId, userId: r.userId, owner: r.user.unixUsername, instanceId: r.instanceId, boxName: r.instance.name,
    clientPlatform: r.clientPlatform, startedAt: r.startedAt, endedAt: r.endedAt, exitReason: r.exitReason,
    tokens: Number((r.inputTokens ?? 0n) + (r.outputTokens ?? 0n) + (r.cacheReadTokens ?? 0n) + (r.cacheCreateTokens ?? 0n)),
  });
  const events: ReportEventRow[] = eventRows.map(e => ({ sessionId: e.sessionId, orderId: e.orderId, userId: e.userId, owner: e.user.unixUsername, instanceId: e.instanceId, kind: e.kind, detail: e.detail, code: e.code, at: e.at }));
  return buildCloudReport(runRows.map(toRun), events, priorRows.map(toRun), range, groupBy, now);
}

export interface PipelineBox {
  instanceId: string;
  boxName: string;
  owner: string | null;
  connected: boolean;
  agentCommit: string | null;
  runs: number;
  /** Runs whose current launch posted `started`. */
  withStarted: number;
  /** Runs the box reported an end for (not the lost sweep). */
  withEnded: number;
  withPlatform: number;
  /** Runs with a title: a count, never the text. */
  withTitle: number;
  lost: number;
  /** Runs still open. */
  open: number;
}

export interface PipelineHealth { days: number; boxes: PipelineBox[]; generatedAt: string }

/**
 * Per box, over the event horizon: how many runs each box-side signal
 * reached the backend for. A box whose runs never post `started` or `title`
 * runs a wrapper or hooks from before them; one whose runs end as `lost`
 * never posts `ended`. Joined with the agent commit Fleet already shows.
 */
export async function pipelineHealth(now: Date = new Date()): Promise<PipelineHealth> {
  const since = new Date(now.getTime() - EVENT_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const [rows, titled, startedEvents] = await Promise.all([
    prisma.claudeRunnerSession.findMany({
      where: { startedAt: { gte: since } },
      select: { orderId: true, instanceId: true, startedAt: true, endedAt: true, exitReason: true, clientPlatform: true, instance: { select: { name: true, user: { select: { unixUsername: true } } } } },
    }),
    // The title is counted, never read.
    prisma.claudeRunnerSession.groupBy({ by: ['instanceId'], where: { startedAt: { gte: since }, title: { not: null } }, _count: true }),
    prisma.claudeSessionEvent.findMany({ where: { at: { gte: since }, kind: 'started' }, select: { orderId: true, at: true } }),
  ]);
  const titledByBox = new Map(titled.map(t => [t.instanceId, t._count]));
  const startedByOrder = new Map<string, Date[]>();
  for (const e of startedEvents) { const l = startedByOrder.get(e.orderId) ?? []; l.push(e.at); startedByOrder.set(e.orderId, l); }
  const byBox = new Map<string, PipelineBox>();
  for (const r of rows) {
    let b = byBox.get(r.instanceId);
    if (!b) {
      b = { instanceId: r.instanceId, boxName: r.instance.name, owner: r.instance.user?.unixUsername ?? null, connected: isInstanceAgentConnected(r.instanceId),
        agentCommit: instanceAgentTransport(r.instanceId)?.agentCommit ?? null, runs: 0, withStarted: 0, withEnded: 0, withPlatform: 0, withTitle: titledByBox.get(r.instanceId) ?? 0, lost: 0, open: 0 };
      byBox.set(r.instanceId, b);
    }
    b.runs++;
    if ((startedByOrder.get(r.orderId) ?? []).some(at => isStartedFor({ kind: 'started', orderId: r.orderId, at }, r))) b.withStarted++;
    if (r.endedAt && r.exitReason !== RUN_LOST_REASON) b.withEnded++;
    if (r.clientPlatform) b.withPlatform++;
    if (r.exitReason === RUN_LOST_REASON) b.lost++;
    if (!r.endedAt) b.open++;
  }
  return { days: EVENT_HORIZON_DAYS, boxes: [...byBox.values()].sort((a, b) => b.runs - a.runs || a.boxName.localeCompare(b.boxName)), generatedAt: now.toISOString() };
}
