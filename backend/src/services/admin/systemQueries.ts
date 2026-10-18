/**
 * Orchestrator process and database health for the admin System page.
 */
import { prisma } from '../../db';
import { termagVersion } from '../termagVersion';
import { getConnectedAgents } from '../agentRegistry';
import { boxUpdateStatus } from '../boxUpdate';
import { getAllStatuses } from '../status';
import { allHostStatuses } from '../tokenUsageSampler';
import { agentTokenForms } from '../../auth/agentWsToken';
import { readFileSync } from 'fs';
import { join } from 'path';

let version: string | null = null;
function appVersion(): string {
  if (version) return version;
  try { version = String(JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')).version); }
  catch { version = 'unknown'; }
  return version;
}

export async function systemHealth() {
  const [tables, dbSize, sessionsRows] = await Promise.all([
    prisma.$queryRaw<Array<{ table: string; rows: number; bytes: number }>>`
      SELECT relname::text AS "table", n_live_tup::int AS rows, pg_total_relation_size(relid)::float8 AS bytes
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC`,
    prisma.$queryRaw<Array<{ bytes: number }>>`SELECT pg_database_size(current_database())::float8 AS bytes`,
    prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM session WHERE expire > now()`.catch(() => [{ n: -1 }]),
  ]);
  const mem = process.memoryUsage();
  const agents = getConnectedAgents();
  const statuses = getAllStatuses();
  const byStatus: Record<string, number> = {};
  for (const s of statuses.values()) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  const scans = allHostStatuses();
  const boxUpdates = await boxUpdateStatus();
  return {
    process: {
      version: appVersion(), node: process.version, pid: process.pid,
      uptimeS: Math.round(process.uptime()), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576),
      // The running commit as GET /api/version resolves it (env, git, or the baked sha); TERMAG_COMMIT / GIT_SHA were never set.
      commit: (await termagVersion()).sha,
      authMode: process.env.AUTH_MODE ?? 'google',
      localSessions: (process.env.LOCAL_SESSIONS_ENABLED ?? 'true') !== 'false',
    },
    agents: {
      connected: agents.length, boxes: agents.filter(a => a.instanceId).length, legacy: agents.filter(a => !a.instanceId).length,
      tokenForms: agentTokenForms.snapshot(),
    },
    statusMap: { sessions: statuses.size, byStatus, note: 'in-memory; reset on restart' },
    boxUpdates,
    usageScans: {
      hosts: scans.length, failing: scans.filter(s => s.error).length,
      lastScanAt: scans.reduce<string | null>((m, s) => (s.lastScanAt && (!m || s.lastScanAt > m) ? s.lastScanAt : m), null),
      schema1Hosts: scans.filter(s => s.schema === 1).length,
    },
    db: { bytes: Number(dbSize[0]?.bytes ?? 0), activeHttpSessions: Number(sessionsRows[0]?.n ?? -1), tables: tables.map(t => ({ table: t.table, rows: Number(t.rows), bytes: Number(t.bytes) })) },
    generatedAt: new Date().toISOString(),
  };
}
