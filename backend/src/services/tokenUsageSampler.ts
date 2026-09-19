/**
 * Token-usage sampler — persists per-project daily token totals.
 *
 * Every 5 minutes per user (staggered), asks EVERY connected agent of that user
 * (the legacy per-user agent and each box agent) for `usage-scan`, normalises
 * the response (schema 1 = user-wide per provider, schema 2 = per-directory
 * buckets with path hints), resolves buckets to (project, workstream) with
 * tokenUsageResolve, and upserts ABSOLUTE day totals into token_usage_days.
 * A rescan is authoritative for the days it reports, so the upsert is
 * idempotent; days no longer reported (pruned logs) keep their last row.
 *
 * Why server-side: the old GET /api/usage did the RPC inline against the
 * legacy agent only (boxes were invisible) and 503'd whenever that agent was
 * offline. Reading from the table instead serves last-known data with a
 * staleness marker and covers every host.
 *
 * normalizeScanResponse / resolveRows / buildUsageResponse are pure and
 * unit-tested; the scheduler and prisma writes wrap them.
 */
import { prisma } from '../db';
import { getConnectedAgents, sendForProject } from './agentRegistry';
import { getPollerUsage } from './tmuxPoller';
import { serverSideUsageProviderIds } from '../providers/registry';
import { resolveUsageSource, ProjectCandidate } from './tokenUsageResolve';

export const LEGACY_HOST = 'legacy';
const TICK_MS = 30_000;
const PER_USER_INTERVAL_MS = 5 * 60_000;
const STAGGER_WINDOW_MS = PER_USER_INTERVAL_MS;
const RPC_TIMEOUT_MS = 60_000;      // a cold parse of a big ~/.claude can exceed the 10 s default
const HISTORY_DAYS = 400;
const STALE_AFTER_MS = 15 * 60_000;
export const RESCAN_THROTTLE_MS = 30_000;

export interface UsageDay { input: number; output: number; cacheRead: number; cacheCreate: number; calls: number }
export const emptyDay = (): UsageDay => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 });
export function addDay(t: UsageDay, d: UsageDay): void {
  t.input += d.input; t.output += d.output; t.cacheRead += d.cacheRead; t.cacheCreate += d.cacheCreate; t.calls += d.calls;
}

export interface RowInput {
  provider: string;
  date: string;
  sourceKey: string;
  cwdHint: string | null;
  dir: string | null;
  agentSchema: 1 | 2;
  day: UsageDay;
}

export interface NormalizedScan {
  schema: 1 | 2;
  scannedAt: string | null;
  rows: RowInput[];
  /** Claude dirs the agent reported read errors for — leave their existing rows alone. */
  skippedDirs: Set<string>;
}

function toDay(v: unknown): UsageDay {
  const d = (v && typeof v === 'object' ? v : {}) as Partial<UsageDay>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return { input: n(d.input), output: n(d.output), cacheRead: n(d.cacheRead), cacheCreate: n(d.cacheCreate), calls: n(d.calls) };
}
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Pure: agent response (either schema) → row inputs. */
export function normalizeScanResponse(raw: unknown): NormalizedScan {
  const r = (raw ?? {}) as Record<string, any>;
  const skippedDirs = new Set<string>();
  const rows: RowInput[] = [];
  const v2 = r.schema === 2 && r.sources && typeof r.sources === 'object';
  if (v2) {
    for (const [provider, src] of Object.entries(r.sources as Record<string, any>)) {
      if (!src || !Array.isArray(src.buckets)) continue;
      for (const e of Array.isArray(src.errors) ? src.errors : []) if (e && typeof e.dir === 'string') skippedDirs.add(e.dir);
      for (const b of src.buckets) {
        if (!b || typeof b.days !== 'object') continue;
        const dir = typeof b.dir === 'string' ? b.dir : null;
        if (dir && skippedDirs.has(dir)) continue;
        const cwdHint = typeof b.cwdHint === 'string' && b.cwdHint ? b.cwdHint : null;
        const sourceKey = dir ?? cwdHint ?? '';
        for (const [date, d] of Object.entries(b.days)) {
          if (!isDate(date)) continue;
          rows.push({ provider, date, sourceKey, cwdHint, dir, agentSchema: 2, day: toDay(d) });
        }
      }
    }
    return { schema: 2, scannedAt: typeof r.scannedAt === 'string' ? r.scannedAt : null, rows, skippedDirs };
  }
  // Schema 1: per provider per day, no attribution possible.
  const providers: Record<string, any> = r.providers && typeof r.providers === 'object'
    ? r.providers : (r.days ? { unknown: r.days } : {});
  for (const [provider, days] of Object.entries(providers)) {
    if (!days || typeof days !== 'object') continue;
    for (const [date, d] of Object.entries(days as Record<string, unknown>)) {
      if (!isDate(date)) continue;
      rows.push({ provider, date, sourceKey: '', cwdHint: null, dir: null, agentSchema: 1, day: toDay(d) });
    }
  }
  return { schema: 1, scannedAt: null, rows, skippedDirs };
}

export interface ResolvedRow extends RowInput { projectId: string | null; workstream: string | null }

/** Pure: attach (projectId, workstream) to each row. */
export function resolveRows(rows: RowInput[], username: string, projects: ProjectCandidate[]): ResolvedRow[] {
  return rows.map(row => {
    const r = row.agentSchema === 2 ? resolveUsageSource({ cwdHint: row.cwdHint, dir: row.dir }, username, projects) : null;
    return { ...row, projectId: r?.projectId ?? null, workstream: r?.workstream ?? null };
  });
}

// ── Response building (shared by the route and tests) ─────────────────────

export interface UsageRowAgg {
  projectId: string | null;
  workstream: string | null;
  provider: string;
  date: string;
  estimated: boolean;
  day: UsageDay;
}
export interface ProjectMeta { id: string; name: string; color: string | null; kind: string }
export interface HostStatus {
  hostKey: string;
  instanceId: string | null;
  name: string;
  connected: boolean;
  lastScanAt: string | null;
  schema: 1 | 2 | null;
  error?: string;
}
export interface UsageResponseV2 {
  days: Record<string, UsageDay>;
  providers: Record<string, Record<string, UsageDay>>;
  projects: Array<{ projectId: string; name: string; color: string | null; kind: string; workstream: string; days: Record<string, UsageDay> }>;
  unattributed: Record<string, UsageDay>;
  hosts: HostStatus[];
  staleSince: string | null;
  generatedAt: string;
}

/**
 * Pure: aggregated rows + live poller estimates → the API payload.
 * Invariant: sum(projects) + unattributed == days − (estimated provider rows).
 */
export function buildUsageResponse(
  rows: UsageRowAgg[],
  projects: ProjectMeta[],
  poller: { providerIds: string[]; days: Record<string, UsageDay> },
  hosts: HostStatus[],
  newestScanAt: Date | null,
  now: number,
): UsageResponseV2 {
  const meta = new Map(projects.map(p => [p.id, p]));
  const days: Record<string, UsageDay> = {};
  const providers: Record<string, Record<string, UsageDay>> = {};
  const unattributed: Record<string, UsageDay> = {};
  const perProject = new Map<string, UsageResponseV2['projects'][number]>();
  const bump = (m: Record<string, UsageDay>, date: string, d: UsageDay) => { if (!m[date]) m[date] = emptyDay(); addDay(m[date], d); };

  for (const r of rows) {
    bump(days, r.date, r.day);
    if (!providers[r.provider]) providers[r.provider] = {};
    bump(providers[r.provider], r.date, r.day);
    if (r.estimated) continue; // estimates are provider-level only
    const pm = r.projectId ? meta.get(r.projectId) : undefined;
    if (!pm) { bump(unattributed, r.date, r.day); continue; }
    const ws = r.workstream ?? 'main';
    const key = `${pm.id} ${ws}`;
    let entry = perProject.get(key);
    if (!entry) { entry = { projectId: pm.id, name: pm.name, color: pm.color, kind: pm.kind, workstream: ws, days: {} }; perProject.set(key, entry); }
    bump(entry.days, r.date, r.day);
  }
  // Live poller estimates (not persisted): provider-level only, like before.
  if (Object.keys(poller.days).length) {
    for (const pid of poller.providerIds) {
      if (!providers[pid]) providers[pid] = {};
      for (const [date, d] of Object.entries(poller.days)) { bump(providers[pid], date, d); bump(days, date, d); }
    }
  }
  const stale = newestScanAt && now - newestScanAt.getTime() > STALE_AFTER_MS ? newestScanAt.toISOString() : null;
  return {
    days, providers,
    projects: [...perProject.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workstream.localeCompare(b.workstream)),
    unattributed, hosts, staleSince: stale, generatedAt: new Date(now).toISOString(),
  };
}

// ── Scheduler + persistence ────────────────────────────────────────────────

interface HostRun { userId: string; instanceId: string | null; lastAttemptAt: number; lastScanAt: number | null; lastError: string | null; schema: 1 | 2 | null; durationMs: number; rows: number }
const hostRuns = new Map<string, HostRun>();          // hostKey → status (in-memory; cleared on restart)
const due = new Map<string, number>();                 // userId → next run epoch
const inFlight = new Map<string, Promise<void>>();     // userId → running scan
const lastSuccess = new Map<string, number>();         // userId → epoch of last run with ≥1 host ok
let tickTimer: NodeJS.Timeout | null = null;

const hostKeyOf = (instanceId: string | null) => instanceId ?? LEGACY_HOST;
function hashStagger(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return h % STAGGER_WINDOW_MS;
}
function sinceDate(): string {
  return new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
}

async function loadProjects(userId: string): Promise<ProjectCandidate[]> {
  const ps = await prisma.project.findMany({ where: { userId }, select: { id: true, name: true, workstreams: { select: { name: true } } } });
  return ps.map(p => ({ id: p.id, name: p.name, workstreams: p.workstreams.map(w => w.name) }));
}

async function persistHost(userId: string, hostKey: string, norm: NormalizedScan, resolved: ResolvedRow[], scannedAt: Date): Promise<void> {
  const dates = [...new Set(resolved.map(r => r.date))];
  if (dates.length === 0) return;
  // Schema-flip guard: a host that changed shape would otherwise double count
  // (schema-1 rows have sourceKey '', schema-2 rows never do).
  const flipped = await prisma.tokenUsageDay.deleteMany({
    where: { userId, hostKey, date: { in: dates }, estimated: false, sourceKey: norm.schema === 2 ? '' : { not: '' } },
  });
  if (flipped.count) console.warn(`[TOKEN-USAGE] ${hostKey}: removed ${flipped.count} rows of the other schema for ${dates.length} dates`);

  const ops = resolved.map(r => prisma.tokenUsageDay.upsert({
    where: { userId_hostKey_provider_date_sourceKey: { userId, hostKey, provider: r.provider, date: r.date, sourceKey: r.sourceKey } },
    update: {
      cwdHint: r.cwdHint, projectId: r.projectId, workstream: r.workstream,
      input: BigInt(r.day.input), output: BigInt(r.day.output), cacheRead: BigInt(r.day.cacheRead), cacheCreate: BigInt(r.day.cacheCreate),
      calls: r.day.calls, agentSchema: r.agentSchema, scannedAt,
    },
    create: {
      userId, hostKey, provider: r.provider, date: r.date, sourceKey: r.sourceKey,
      cwdHint: r.cwdHint, projectId: r.projectId, workstream: r.workstream,
      input: BigInt(r.day.input), output: BigInt(r.day.output), cacheRead: BigInt(r.day.cacheRead), cacheCreate: BigInt(r.day.cacheCreate),
      calls: r.day.calls, agentSchema: r.agentSchema, scannedAt,
    },
  }));
  for (let i = 0; i < ops.length; i += 200) await prisma.$transaction(ops.slice(i, i + 200));
}

/** Rows that couldn't be attributed when written may resolve now (project created later). */
async function reResolveUnattributed(userId: string, username: string, projects: ProjectCandidate[]): Promise<void> {
  const rows = await prisma.tokenUsageDay.findMany({
    where: { userId, projectId: null, agentSchema: 2, OR: [{ cwdHint: { not: null } }, { sourceKey: { not: '' } }] },
    select: { id: true, cwdHint: true, sourceKey: true, provider: true },
    take: 500,
  });
  for (const r of rows) {
    const hit = resolveUsageSource({ cwdHint: r.cwdHint, dir: r.provider === 'claude' ? r.sourceKey : null }, username, projects);
    if (hit) await prisma.tokenUsageDay.update({ where: { id: r.id }, data: { projectId: hit.projectId, workstream: hit.workstream } });
  }
}

async function scanHost(userId: string, username: string, instanceId: string | null, projects: ProjectCandidate[]): Promise<void> {
  const hostKey = hostKeyOf(instanceId);
  const started = Date.now();
  const run: HostRun = hostRuns.get(hostKey) ?? { userId, instanceId, lastAttemptAt: 0, lastScanAt: null, lastError: null, schema: null, durationMs: 0, rows: 0 };
  run.lastAttemptAt = started;
  hostRuns.set(hostKey, run);
  try {
    const raw = await sendForProject({ userId, instanceId }, 'usage-scan', { schema: 2, since: sinceDate() }, RPC_TIMEOUT_MS);
    const norm = normalizeScanResponse(raw);
    const resolved = resolveRows(norm.rows, username, projects);
    const parsed = norm.scannedAt ? new Date(norm.scannedAt) : new Date();
    const scannedAt = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    await persistHost(userId, hostKey, norm, resolved, scannedAt);
    run.lastScanAt = Date.now(); run.lastError = null; run.schema = norm.schema; run.rows = resolved.length;
    lastSuccess.set(userId, Date.now());
  } catch (err) {
    run.lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[TOKEN-USAGE] ${username}/${hostKey}: ${run.lastError}`);
  } finally {
    run.durationMs = Date.now() - started;
  }
}

/** Scan every connected host of one user. Joins an in-flight run if there is one. */
export function runUserScan(userId: string): Promise<void> {
  const existing = inFlight.get(userId);
  if (existing) return existing;
  const p = (async () => {
    const hosts = getConnectedAgents().filter(a => a.userId === userId);
    if (hosts.length === 0) return;
    const username = hosts[0].unixUsername;
    const projects = await loadProjects(userId);
    await Promise.allSettled(hosts.map(h => scanHost(userId, username, h.instanceId, projects)));
    await reResolveUnattributed(userId, username, projects).catch(() => {});
  })().finally(() => { inFlight.delete(userId); due.set(userId, Date.now() + PER_USER_INTERVAL_MS); });
  inFlight.set(userId, p);
  return p;
}

export function lastSuccessfulRun(userId: string): number | null { return lastSuccess.get(userId) ?? null; }

/** Host statuses for the route: every connected agent + every host we've heard from. */
export function hostStatuses(userId: string, instanceNames: Map<string, string>): HostStatus[] {
  const connected = new Set(getConnectedAgents().filter(a => a.userId === userId).map(a => hostKeyOf(a.instanceId)));
  const keys = new Set<string>([...connected, ...[...hostRuns.entries()].filter(([, r]) => r.userId === userId).map(([k]) => k)]);
  return [...keys].sort().map(hostKey => {
    const r = hostRuns.get(hostKey);
    const instanceId = hostKey === LEGACY_HOST ? null : hostKey;
    return {
      hostKey, instanceId,
      name: instanceId ? instanceNames.get(instanceId) ?? instanceId : 'orchestrator',
      connected: connected.has(hostKey),
      lastScanAt: r?.lastScanAt ? new Date(r.lastScanAt).toISOString() : null,
      schema: r?.schema ?? null,
      ...(r?.lastError ? { error: r.lastError } : {}),
    };
  });
}

/** Live (un-persisted) poller estimates for the response. */
export function pollerEstimates(unixUsername: string): { providerIds: string[]; days: Record<string, UsageDay> } {
  return { providerIds: serverSideUsageProviderIds(), days: getPollerUsage(unixUsername) };
}

function tick(): void {
  const now = Date.now();
  const users = new Set(getConnectedAgents().map(a => a.userId));
  for (const userId of users) {
    if (inFlight.has(userId)) continue;
    const next = due.get(userId) ?? (now + hashStagger(userId));
    if (!due.has(userId)) due.set(userId, next);
    if (now >= next) void runUserScan(userId);
  }
}

export function startTokenUsageSampler(): void {
  if (tickTimer) return;
  tickTimer = setInterval(tick, TICK_MS);
  tick();
  console.log('[TOKEN-USAGE] Sampler started');
}

export async function stopTokenUsageSampler(): Promise<void> {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  await Promise.allSettled([...inFlight.values()]);
}
