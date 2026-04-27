import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';

const prisma = new PrismaClient();

export function worktimeRouter(): Router {
  const router = Router();

  const getWorktime: RequestHandler = async (req, res) => {
    const username = req.user!.unixUsername;
    const daysBack = parseInt(req.query.days as string) || 30;

    // Calculate start date
    const start = new Date();
    start.setDate(start.getDate() - daysBack);
    const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;

    try {
      const entries = await prisma.workTimeEntry.findMany({
        where: {
          username,
          date: { gte: startStr },
        },
        orderBy: { date: 'asc' },
      });

      // Group by date, then by provider
      const days: Record<string, Record<string, { totalMs: number; sessions: number }>> = {};
      for (const e of entries) {
        if (!days[e.date]) days[e.date] = {};
        if (!days[e.date][e.provider]) {
          days[e.date][e.provider] = { totalMs: 0, sessions: 0 };
        }
        days[e.date][e.provider].totalMs += e.totalMs;
        days[e.date][e.provider].sessions += e.sessions;
      }

      res.json({ days });
    } catch {
      res.status(500).json({ error: 'Failed to fetch worktime data' });
    }
  };

  router.get('/', requireAuth, getWorktime);

  return router;
}
