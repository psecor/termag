import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { recordWarpSample } from '../services/warpSampler';
import { requireAuth } from '../middleware/auth';

const prisma = new PrismaClient();

export function warpRouter(): Router {
  const router = Router();

  const sample: RequestHandler = (req, res) => {
    const { value, ts } = req.body as { value?: number; ts?: number };
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      res.status(400).json({ error: 'value must be a finite number' });
      return;
    }
    // Sanity guard — warp values normally stay under ~10. 50 is a generous ceiling.
    if (value < 0 || value > 50) {
      res.status(400).json({ error: 'value out of range [0, 50]' });
      return;
    }
    if (ts !== undefined && (typeof ts !== 'number' || !Number.isFinite(ts))) {
      res.status(400).json({ error: 'ts must be a finite number' });
      return;
    }
    recordWarpSample(req.user!.id, value, ts);
    res.json({ ok: true });
  };

  const series: RequestHandler = async (req, res) => {
    const userId = req.user!.id;
    const rawDays = parseInt((req.query.days as string) ?? '30', 10);
    const days = Math.max(1, Math.min(365, isNaN(rawDays) ? 30 : rawDays));

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const todayStartUtc = new Date();
    todayStartUtc.setUTCHours(0, 0, 0, 0);

    // Per-day aggregates over the minute-bucket rows in warp_samples.
    // activeMinutes = count of minute buckets where meanWarp >= the 1.0
    // working threshold (matches sampler's ACTIVE_THRESHOLD).
    const dayRows = await prisma.$queryRaw<Array<{
      day: Date;
      mean_warp: number | null;
      p95: number | null;
      max_warp: number | null;
      active_minutes: number;
    }>>`
      SELECT date_trunc('day', bucket AT TIME ZONE 'UTC')::date AS day,
             AVG("meanWarp")::float AS mean_warp,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY "maxWarp")::float AS p95,
             MAX("maxWarp")::float AS max_warp,
             COUNT(*) FILTER (WHERE "meanWarp" >= 1.0)::int AS active_minutes
      FROM warp_samples
      WHERE "userId" = ${userId} AND bucket >= ${since}
      GROUP BY day
      ORDER BY day
    `;

    // Per-hour for today (UTC)
    const hourRows = await prisma.$queryRaw<Array<{
      hour: number;
      mean_warp: number | null;
      max_warp: number | null;
      active_minutes: number;
    }>>`
      SELECT EXTRACT(HOUR FROM bucket AT TIME ZONE 'UTC')::int AS hour,
             AVG("meanWarp")::float AS mean_warp,
             MAX("maxWarp")::float AS max_warp,
             COUNT(*) FILTER (WHERE "meanWarp" >= 1.0)::int AS active_minutes
      FROM warp_samples
      WHERE "userId" = ${userId} AND bucket >= ${todayStartUtc}
      GROUP BY hour
      ORDER BY hour
    `;

    const dayMap = new Map(dayRows.map(r => {
      const d = new Date(r.day);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      return [key, r];
    }));

    const dayArray: Array<{
      date: string;
      meanWarp: number;
      p95: number;
      maxWarp: number;
      activeMinutes: number;
    }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const row = dayMap.get(key);
      dayArray.push({
        date: key,
        meanWarp: row?.mean_warp != null ? Number(row.mean_warp) : 0,
        p95: row?.p95 != null ? Number(row.p95) : 0,
        maxWarp: row?.max_warp != null ? Number(row.max_warp) : 0,
        activeMinutes: row ? Number(row.active_minutes) : 0,
      });
    }

    const hoursToday: Array<{
      hour: number;
      meanWarp: number;
      maxWarp: number;
      activeMinutes: number;
    }> = new Array(24).fill(null).map((_, h) => ({
      hour: h, meanWarp: 0, maxWarp: 0, activeMinutes: 0,
    }));
    for (const r of hourRows) {
      if (r.hour >= 0 && r.hour < 24) {
        hoursToday[r.hour] = {
          hour: r.hour,
          meanWarp: r.mean_warp != null ? Number(r.mean_warp) : 0,
          maxWarp: r.max_warp != null ? Number(r.max_warp) : 0,
          activeMinutes: Number(r.active_minutes),
        };
      }
    }

    res.json({ days: dayArray, hoursToday });
  };

  router.post('/sample', requireAuth, sample);
  router.get('/series', requireAuth, series);

  return router;
}
