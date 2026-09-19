import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { getConnectedAgents } from '../services/agentRegistry';
import {
  buildUsageResponse, hostStatuses, pollerEstimates, runUserScan, lastSuccessfulRun,
  RESCAN_THROTTLE_MS, UsageRowAgg,
} from '../services/tokenUsageSampler';

// GET /api/usage — token usage from token_usage_days (written by the sampler),
// plus live poller estimates. Never 503s once rows exist: an offline agent
// yields the last-known data with `staleSince` set. Schema-1 (old) agents show
// up as unattributed rows and `hosts[].schema === 1`.
// POST /api/usage/rescan — run the sampler for this user now (joins an in-flight
// run; throttled), then return the fresh payload.

const HISTORY_DAYS = 400;

async function payloadFor(userId: string, unixUsername: string) {
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const raw = await prisma.$queryRaw<Array<{
    projectId: string | null; workstream: string | null; provider: string; date: string; estimated: boolean;
    input: number; output: number; cacheRead: number; cacheCreate: number; calls: number;
  }>>`
    SELECT "projectId", "workstream", "provider", "date", "estimated",
           SUM("input")::float8 AS "input", SUM("output")::float8 AS "output",
           SUM("cacheRead")::float8 AS "cacheRead", SUM("cacheCreate")::float8 AS "cacheCreate",
           SUM("calls")::int AS "calls"
    FROM token_usage_days
    WHERE "userId" = ${userId} AND "date" >= ${since}
    GROUP BY "projectId", "workstream", "provider", "date", "estimated"
  `;
  const rows: UsageRowAgg[] = raw.map(r => ({
    projectId: r.projectId, workstream: r.workstream, provider: r.provider, date: r.date, estimated: r.estimated,
    day: { input: Number(r.input), output: Number(r.output), cacheRead: Number(r.cacheRead), cacheCreate: Number(r.cacheCreate), calls: Number(r.calls) },
  }));
  const [projects, instances, newest] = await Promise.all([
    prisma.project.findMany({ where: { userId }, select: { id: true, name: true, color: true, kind: true } }),
    prisma.instance.findMany({ where: { userId }, select: { id: true, name: true } }),
    prisma.tokenUsageDay.aggregate({ where: { userId, estimated: false }, _max: { scannedAt: true } }),
  ]);
  return buildUsageResponse(
    rows,
    projects.map(p => ({ id: p.id, name: p.name, color: p.color ?? null, kind: p.kind })),
    pollerEstimates(unixUsername),
    hostStatuses(userId, new Map(instances.map(i => [i.id, i.name]))),
    newest._max.scannedAt ?? null,
    Date.now(),
  );
}

export function usageRouter(): Router {
  const router = Router();

  const getUsage: RequestHandler = async (req, res) => {
    try {
      res.json(await payloadFor(req.user!.id, req.user!.unixUsername));
    } catch (err) {
      console.error('[USAGE] failed:', (err as Error).message);
      res.status(500).json({ error: 'Failed to load usage' });
    }
  };

  const rescan: RequestHandler = async (req, res) => {
    const userId = req.user!.id;
    const connected = getConnectedAgents().some(a => a.userId === userId);
    try {
      const last = lastSuccessfulRun(userId);
      const throttled = last !== null && Date.now() - last < RESCAN_THROTTLE_MS;
      if (connected && !throttled) await runUserScan(userId);
      const payload = await payloadFor(userId, req.user!.unixUsername);
      if (!connected && Object.keys(payload.days).length === 0) {
        res.status(503).json({ error: 'No agent connected and no usage recorded yet' });
        return;
      }
      res.json({ ...payload, throttled: throttled || undefined, agentConnected: connected });
    } catch (err) {
      console.error('[USAGE] rescan failed:', (err as Error).message);
      res.status(500).json({ error: 'Failed to rescan usage' });
    }
  };

  router.get('/', requireAuth, getUsage);
  router.post('/rescan', requireAuth, rescan);
  return router;
}
