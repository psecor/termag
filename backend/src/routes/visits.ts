import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';

const prisma = new PrismaClient();

export function visitsRouter(): Router {
  const router = Router();

  const record: RequestHandler = async (req, res) => {
    const { projectId, previousProjectId, sessionTag } = req.body as {
      projectId?: string | null;
      previousProjectId?: string | null;
      sessionTag?: string;
    };

    // Both ids may be null (e.g. switching to "no project"), but if present
    // must be strings. Reject obvious garbage.
    if (projectId !== null && projectId !== undefined && typeof projectId !== 'string') {
      res.status(400).json({ error: 'projectId must be string or null' });
      return;
    }
    if (previousProjectId !== null && previousProjectId !== undefined && typeof previousProjectId !== 'string') {
      res.status(400).json({ error: 'previousProjectId must be string or null' });
      return;
    }
    if (sessionTag !== undefined && typeof sessionTag !== 'string') {
      res.status(400).json({ error: 'sessionTag must be string' });
      return;
    }

    // If projectId is set, confirm the viewer can see the project (owner or
    // collaborator). This stops a hostile client from logging visits to
    // arbitrary project ids it doesn't have access to.
    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      if (project.userId !== req.user!.id) {
        const share = await prisma.projectShare.findUnique({
          where: { projectId_userId: { projectId, userId: req.user!.id } },
        });
        if (!share) {
          res.status(403).json({ error: 'no access to project' });
          return;
        }
      }
    }

    await prisma.projectVisit.create({
      data: {
        userId: req.user!.id,
        projectId: projectId ?? null,
        previousProjectId: previousProjectId ?? null,
        sessionTag: sessionTag ?? null,
      },
    });

    res.json({ ok: true });
  };

  const stats: RequestHandler = async (req, res) => {
    const userId = req.user!.id;
    const rawDays = parseInt((req.query.days as string) ?? '30', 10);
    const days = Math.max(1, Math.min(365, isNaN(rawDays) ? 30 : rawDays));

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const todayStartUtc = new Date();
    todayStartUtc.setUTCHours(0, 0, 0, 0);

    // Per-day counts (UTC days) over the window
    const dailyRows = await prisma.$queryRaw<Array<{ day: Date; count: number }>>`
      SELECT date_trunc('day', timestamp AT TIME ZONE 'UTC')::date AS day,
             COUNT(*)::int AS count
      FROM project_visits
      WHERE "userId" = ${userId}
        AND timestamp >= ${since}
      GROUP BY day
      ORDER BY day
    `;

    // Dwell / inter-switch stats over the same window
    const statsRows = await prisma.$queryRaw<Array<{
      mean_dwell_seconds: number | null;
      stdev_seconds: number | null;
      interval_count: number;
    }>>`
      WITH t AS (
        SELECT timestamp,
               EXTRACT(EPOCH FROM (timestamp - LAG(timestamp) OVER (ORDER BY timestamp))) AS dwell_seconds
        FROM project_visits
        WHERE "userId" = ${userId} AND timestamp >= ${since}
      )
      SELECT
        AVG(dwell_seconds) AS mean_dwell_seconds,
        STDDEV_SAMP(dwell_seconds) AS stdev_seconds,
        COUNT(*) FILTER (WHERE dwell_seconds IS NOT NULL)::int AS interval_count
      FROM t
    `;

    // Per-hour counts for today (UTC)
    const hourRows = await prisma.$queryRaw<Array<{ hour: number; count: number }>>`
      SELECT EXTRACT(HOUR FROM timestamp AT TIME ZONE 'UTC')::int AS hour,
             COUNT(*)::int AS count
      FROM project_visits
      WHERE "userId" = ${userId}
        AND timestamp >= ${todayStartUtc}
      GROUP BY hour
      ORDER BY hour
    `;

    const dayMap = new Map(dailyRows.map(r => {
      const d = new Date(r.day);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      return [key, Number(r.count)];
    }));

    // Fill in zero days so the frontend gets a dense array
    const dayArray: Array<{ date: string; switches: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      dayArray.push({ date: key, switches: dayMap.get(key) ?? 0 });
    }

    const totalSwitches = dayArray.reduce((s, d) => s + d.switches, 0);
    const todayKey = dayArray[dayArray.length - 1]?.date ?? '';
    const todaySwitches = dayMap.get(todayKey) ?? 0;

    const perHourToday: number[] = new Array(24).fill(0);
    for (const r of hourRows) {
      if (r.hour >= 0 && r.hour < 24) perHourToday[r.hour] = Number(r.count);
    }

    const meanDwellMs = statsRows[0]?.mean_dwell_seconds != null
      ? Math.round(Number(statsRows[0].mean_dwell_seconds) * 1000)
      : 0;
    const stdevInterSwitchMs = statsRows[0]?.stdev_seconds != null
      ? Math.round(Number(statsRows[0].stdev_seconds) * 1000)
      : 0;

    res.json({
      days: dayArray,
      totalSwitches,
      todaySwitches,
      perHourToday,
      meanDwellMs,
      stdevInterSwitchMs,
    });
  };

  router.post('/', requireAuth, record);
  router.get('/stats', requireAuth, stats);

  return router;
}
