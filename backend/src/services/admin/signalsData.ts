/**
 * Loads the inputs buildSignals() needs. The only impure half of the signals
 * feature; everything after this is the pure module.
 */
import { prisma } from '../../db';
import { listInstances } from './fleetQueries';
import { liveSessions } from './inventoryQueries';
import { userTokenDays } from './usageQueries';
import { buildSignals, THRESHOLDS, type Signal, type SignalOrchestrator } from './signals';
import { cloudSignalInput, orchestratorHealth, type OrchestratorHealth } from './claudeRunnerQueries';
import { dayKey } from './range';
import type { SessionRow } from '../sessionInventory';

/** The health body as the signals read it (the body's shape is the orchestrator's own). */
export function orchestratorForSignals(h: OrchestratorHealth): SignalOrchestrator {
  const b = h.body ?? {};
  const lastPoll = typeof b.last_poll_at === 'string' ? Date.parse(b.last_poll_at) : NaN;
  return {
    configured: h.port != null,
    available: h.available,
    connected: b.connected === true,
    lastPollAt: Number.isFinite(lastPoll) ? new Date(lastPoll) : null,
    reason: h.reason ?? null,
  };
}

const BASELINE_DAYS = 14;

export async function computeSignals(now = Date.now(), reuse: { sessions?: SessionRow[] } = {}): Promise<{ signals: Signal[]; thresholds: typeof THRESHOLDS; generatedAt: string }> {
  const keys: string[] = [];
  for (let i = BASELINE_DAYS; i >= 0; i--) keys.push(dayKey(new Date(now - i * 86_400_000)));
  const todayKey = keys[keys.length - 1];
  const [instances, projects, sessions, userTokens, unknown, cloud, health] = await Promise.all([
    listInstances(),
    prisma.project.findMany({ select: { id: true, name: true, userId: true, archived: true, lastActiveAt: true, kind: true, user: { select: { unixUsername: true } } } }),
    reuse.sessions ?? liveSessions(),
    userTokenDays(keys),
    prisma.$queryRaw<Array<{ username: string }>>`
      SELECT DISTINCT w."username" FROM work_time_entries w LEFT JOIN users u ON u."unixUsername" = w."username"
      WHERE u.id IS NULL AND w."date" >= ${keys[0]}`,
    cloudSignalInput(new Date(now)),
    orchestratorHealth({ now }),
  ]);
  const signals = buildSignals({
    instances: instances.map(i => ({
      id: i.id, name: i.name, status: i.status, kind: i.kind, createdAt: new Date(i.createdAt), connected: i.connected,
      userId: i.owner?.id ?? '', unixUsername: i.owner?.unixUsername ?? 'pool', projectCount: i.projects.active,
      lastProjectActiveAt: i.lastProjectActiveAt ? new Date(i.lastProjectActiveAt) : null, provisioningError: i.provisioningError,
      lastCloudRunAt: cloud.lastCloudRunAt[i.id] ?? null,
      host: i.host ? { ...i.host, sampledAt: new Date(i.host.sampledAt) } : null,
      update: i.update ? { at: new Date(i.update.at), outcome: i.update.outcome, detail: i.update.detail, commit: i.update.commit } : null,
      agentCommit: i.agentCommit,
    })),
    cloud: { sessions: cloud.sessions, capacity: cloud.capacity },
    orchestrator: orchestratorForSignals(health),
    projects: projects.map(p => ({ id: p.id, name: p.name, userId: p.userId, unixUsername: p.user.unixUsername, archived: p.archived, lastActiveAt: p.lastActiveAt, kind: p.kind })),
    sessions,
    userTokens,
    todayKey,
    baselineKeys: keys.slice(0, -1),
    unknownWorktimeUsernames: unknown.map(u => u.username),
  }, now);
  return { signals, thresholds: THRESHOLDS, generatedAt: new Date(now).toISOString() };
}
