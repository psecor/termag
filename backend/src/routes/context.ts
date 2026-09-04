import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';


function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function contextRouter(): Router {
  const router = Router();

  // Per-project context-window occupancy over time. The 30d view shows the
  // PEAK (max) context each UTC day per project (max across the project's
  // workstreams); `hoursToday` is the intra-day peak per hour. Mirrors
  // /api/warp/series. Scoped to the caller's own projects.
  const series: RequestHandler = async (req, res) => {
    const userId = req.user!.id;
    const rawDays = parseInt((req.query.days as string) ?? '30', 10);
    const days = Math.max(1, Math.min(365, isNaN(rawDays) ? 30 : rawDays));

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const todayStartUtc = new Date();
    todayStartUtc.setUTCHours(0, 0, 0, 0);

    const dayRows = await prisma.$queryRaw<Array<{
      project_id: string;
      name: string;
      color: string | null;
      day: Date;
      peak: number;
    }>>`
      SELECT cs."projectId" AS project_id, p.name AS name, p.color AS color,
             date_trunc('day', cs.bucket AT TIME ZONE 'UTC')::date AS day,
             MAX(cs."maxTokens")::int AS peak
      FROM context_samples cs
      JOIN projects p ON p.id = cs."projectId"
      WHERE p."userId" = ${userId} AND cs.bucket >= ${since}
      GROUP BY cs."projectId", p.name, p.color, day
      ORDER BY project_id, day
    `;

    const hourRows = await prisma.$queryRaw<Array<{
      project_id: string;
      hour: number;
      peak: number;
    }>>`
      SELECT cs."projectId" AS project_id,
             EXTRACT(HOUR FROM cs.bucket AT TIME ZONE 'UTC')::int AS hour,
             MAX(cs."maxTokens")::int AS peak
      FROM context_samples cs
      JOIN projects p ON p.id = cs."projectId"
      WHERE p."userId" = ${userId} AND cs.bucket >= ${todayStartUtc}
      GROUP BY cs."projectId", hour
      ORDER BY project_id, hour
    `;

    // The zero-filled date axis, oldest → newest.
    const dateAxis: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      dateAxis.push(dayKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
    }

    // Group rows per project.
    interface Proj {
      projectId: string;
      name: string;
      color: string | null;
      dayPeaks: Map<string, number>;
      hourPeaks: Map<number, number>;
    }
    const projs = new Map<string, Proj>();
    const ensure = (id: string, name = '', color: string | null = null): Proj => {
      let p = projs.get(id);
      if (!p) { p = { projectId: id, name, color, dayPeaks: new Map(), hourPeaks: new Map() }; projs.set(id, p); }
      if (name) p.name = name;
      if (color) p.color = color;
      return p;
    };

    for (const r of dayRows) {
      const p = ensure(r.project_id, r.name, r.color);
      p.dayPeaks.set(dayKey(new Date(r.day)), Number(r.peak));
    }
    for (const r of hourRows) {
      const p = ensure(r.project_id);
      if (r.hour >= 0 && r.hour < 24) p.hourPeaks.set(r.hour, Number(r.peak));
    }

    const projects = [...projs.values()].map(p => ({
      projectId: p.projectId,
      name: p.name,
      color: p.color,
      days: dateAxis.map(date => ({ date, peakTokens: p.dayPeaks.get(date) ?? 0 })),
      hoursToday: Array.from({ length: 24 }, (_, h) => ({ hour: h, peakTokens: p.hourPeaks.get(h) ?? 0 })),
    }));

    res.json({ dateAxis, projects });
  };

  router.get('/series', requireAuth, series);

  return router;
}
