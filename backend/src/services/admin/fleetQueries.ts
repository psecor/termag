/**
 * Fleet (boxes) queries for the admin surface. Each export answers one
 * question and is shared by the REST route and the MCP tool of the same name.
 */
import { prisma } from '../../db';
import { getConnectedAgents, instanceAgentTransport, isInstanceAgentConnected } from '../agentRegistry';
import { allHostStatuses } from '../tokenUsageSampler';
import { cloudSummary, hostPressureOf, type CloudCounts, type HostPressure } from './claudeRunnerQueries';
import { lastBoxUpdateOf, type LastBoxUpdate } from '../boxUpdateReport';
import { boxUpdateTarget, type BoxUpdateTarget } from '../boxUpdate';
import type { Range } from './range';

export interface AdminInstance {
  id: string; name: string; kind: string; status: string; region: string | null;
  ec2InstanceId: string | null; hostname: string | null;
  /** The AMI the box launched from and how it was chosen (boxImage.boxImageSource); null before they were recorded. */
  imageId: string | null; imageSource: string | null;
  createdAt: string; readyAt: string | null; lastConnectedAt: string | null; terminatedAt: string | null;
  provisioningError: string | null;
  provisioningMs: number | null;
  /** Null for an unclaimed warm-pool box (status warming/warm). */
  owner: { id: string; email: string; unixUsername: string } | null;
  connected: boolean;
  /** The termag commit the connected agent runs (from its hello); null when offline or from an older agent. */
  agentCommit: string | null;
  /** When that commit was made; null when offline or from an agent too old to say. Sorts the table by agent age. */
  agentCommitAt: string | null;
  /** The last termag-box-update run the box reported; null before any. */
  update: LastBoxUpdate | null;
  projects: { active: number; archived: number };
  lastProjectActiveAt: string | null;
  /** Claude Code cloud sessions open on the box right now. */
  cloud: CloudCounts;
  /** Disk, memory, load and kept runner checkouts from the agent (G10); null until an agent that samples has connected. */
  host: HostPressure | null;
  scan: { lastScanAt: string | null; error: string | null; schema: number | null } | null;
}

export async function listInstances(opts: { includeTerminated?: boolean } = {}): Promise<AdminInstance[]> {
  const [rows, cloud] = await Promise.all([
    prisma.instance.findMany({
      where: opts.includeTerminated ? {} : { status: { not: 'terminated' } },
      include: {
        user: { select: { id: true, googleEmail: true, unixUsername: true } },
        projects: { select: { archived: true, lastActiveAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    cloudSummary(),
  ]);
  // Per-instance registry lookup, not getConnectedAgents(): that list only
  // carries owned boxes, so an unclaimed warm-pool agent would read as offline.
  const scans = new Map(allHostStatuses().filter(h => h.instanceId).map(h => [h.instanceId!, h]));
  return rows.map(r => {
    const scan = scans.get(r.id);
    const active = r.projects.filter(p => !p.archived);
    const lastActive = active.reduce<Date | null>((m, p) => (!m || p.lastActiveAt > m ? p.lastActiveAt : m), null);
    return {
      id: r.id, name: r.name, kind: r.kind, status: r.status, region: r.region,
      ec2InstanceId: r.ec2InstanceId, hostname: r.hostname,
      imageId: r.imageId, imageSource: r.imageSource,
      createdAt: r.createdAt.toISOString(), readyAt: r.readyAt?.toISOString() ?? null,
      lastConnectedAt: r.lastConnectedAt?.toISOString() ?? null, terminatedAt: r.terminatedAt?.toISOString() ?? null,
      provisioningError: r.provisioningError,
      provisioningMs: r.readyAt ? r.readyAt.getTime() - r.createdAt.getTime() : null,
      owner: r.user ? { id: r.user.id, email: r.user.googleEmail, unixUsername: r.user.unixUsername } : null,
      connected: isInstanceAgentConnected(r.id),
      agentCommit: instanceAgentTransport(r.id)?.agentCommit ?? null,
      agentCommitAt: instanceAgentTransport(r.id)?.agentCommitAt?.toISOString() ?? null,
      update: lastBoxUpdateOf(r),
      projects: { active: active.length, archived: r.projects.length - active.length },
      lastProjectActiveAt: lastActive?.toISOString() ?? null,
      cloud: cloud.byBox[r.id] ?? { running: 0, starting: 0 },
      host: hostPressureOf(r),
      scan: scan ? { lastScanAt: scan.lastScanAt, error: scan.error ?? null, schema: scan.schema } : null,
    };
  });
}

export interface FleetOverview {
  total: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  byRegion: Record<string, number>;
  connected: number;
  readyDisconnected: number;
  /** Unclaimed pool boxes (status warming/warm) whose agent is connected. */
  poolAgentsConnected: number;
  legacyAgentsConnected: number;
  /** Claude Code cloud sessions open right now, and how many boxes carry one. */
  cloud: CloudCounts & { boxes: number };
  /** What a current box runs (the newest box AMI's commit and date), for the "behind" marker. */
  target: BoxUpdateTarget;
  /** Connected owned boxes whose agent runs another commit than the target. */
  behind: number;
  generatedAt: string;
}

export async function fleetOverview(): Promise<FleetOverview> {
  const [instances, target] = await Promise.all([listInstances(), boxUpdateTarget()]);
  const count = (key: (i: AdminInstance) => string | null) => {
    const out: Record<string, number> = {};
    for (const i of instances) { const k = key(i) ?? 'unknown'; out[k] = (out[k] ?? 0) + 1; }
    return out;
  };
  return {
    total: instances.length,
    byStatus: count(i => i.status), byKind: count(i => i.kind), byRegion: count(i => i.region),
    connected: instances.filter(i => i.connected).length,
    readyDisconnected: instances.filter(i => i.status === 'ready' && !i.connected).length,
    poolAgentsConnected: instances.filter(i => !i.owner && i.connected).length,
    legacyAgentsConnected: getConnectedAgents().filter(a => !a.instanceId).length,
    cloud: {
      running: instances.reduce((n, i) => n + i.cloud.running, 0),
      starting: instances.reduce((n, i) => n + i.cloud.starting, 0),
      boxes: instances.filter(i => i.cloud.running + i.cloud.starting > 0).length,
    },
    target,
    behind: target.commit ? instances.filter(i => i.connected && i.owner && i.agentCommit !== target.commit).length : 0,
    generatedAt: new Date().toISOString(),
  };
}

export interface ProvisioningStats {
  range: { since: string; until: string };
  launched: number; ready: number; failed: number; pending: number;
  /** Cold-provisioning seconds for boxes that reached ready in the range. */
  durationS: { p50: number | null; p95: number | null; max: number | null; samples: number };
  failures: Array<{ error: string; count: number }>;
  byWeek: Array<{ week: string; launched: number; failed: number; p50S: number | null }>;
}

export async function provisioningStats(range: Range): Promise<ProvisioningStats> {
  const rows = await prisma.instance.findMany({
    where: { kind: 'ec2', createdAt: { gte: range.sinceTs, lt: range.untilTs } },
    select: { createdAt: true, readyAt: true, status: true, provisioningError: true },
  });
  const durations = rows.filter(r => r.readyAt).map(r => (r.readyAt!.getTime() - r.createdAt.getTime()) / 1000).sort((a, b) => a - b);
  const pct = (p: number) => durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] : null;
  const failures = new Map<string, number>();
  for (const r of rows) if (r.status === 'failed') failures.set(r.provisioningError ?? 'unknown', (failures.get(r.provisioningError ?? 'unknown') ?? 0) + 1);
  const weeks = new Map<string, { launched: number; failed: number; d: number[] }>();
  for (const r of rows) {
    const d = new Date(r.createdAt); d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    const week = d.toISOString().slice(0, 10);
    const w = weeks.get(week) ?? { launched: 0, failed: 0, d: [] };
    w.launched++; if (r.status === 'failed') w.failed++;
    if (r.readyAt) w.d.push((r.readyAt.getTime() - r.createdAt.getTime()) / 1000);
    weeks.set(week, w);
  }
  return {
    range: { since: range.sinceKey, until: range.untilKey },
    launched: rows.length,
    ready: rows.filter(r => r.readyAt).length,
    failed: rows.filter(r => r.status === 'failed').length,
    pending: rows.filter(r => r.status === 'provisioning').length,
    durationS: { p50: pct(0.5), p95: pct(0.95), max: durations.length ? durations[durations.length - 1] : null, samples: durations.length },
    failures: [...failures].map(([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count),
    byWeek: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, w]) => {
      const s = w.d.sort((a, b) => a - b);
      return { week, launched: w.launched, failed: w.failed, p50S: s.length ? s[Math.floor(s.length / 2)] : null };
    }),
  };
}

export async function getInstance(id: string) {
  const [all, row] = await Promise.all([
    listInstances({ includeTerminated: true }),
    prisma.instance.findUnique({
      where: { id },
      include: {
        projects: { select: { id: true, name: true, archived: true, lastActiveAt: true }, orderBy: { lastActiveAt: 'desc' } },
        agentTokens: { select: { id: true, name: true, tokenPrefix: true, createdAt: true, lastUsedAt: true, revokedAt: true } },
      },
    }),
  ]);
  const summary = all.find(i => i.id === id);
  if (!summary || !row) return null;
  return {
    ...summary,
    projectList: row.projects.map(p => ({ id: p.id, name: p.name, archived: p.archived, lastActiveAt: p.lastActiveAt.toISOString() })),
    tokens: row.agentTokens.map(t => ({ ...t, createdAt: t.createdAt.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() ?? null, revokedAt: t.revokedAt?.toISOString() ?? null })),
    securityGroupId: row.securityGroupId, iamRoleName: row.iamRoleName,
  };
}
