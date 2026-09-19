import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { toWorktimeProjectRows } from '../services/worktimeProjects';


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

  // GET /api/worktime/projects?days=N — the same rows, but keeping the project
  // dimension (resolved to id + workstream) instead of grouping it away. Feeds
  // the dashboard's effort-by-project view. Dates are server-local like `/`.
  const getWorktimeByProject: RequestHandler = async (req, res) => {
    const daysBack = Math.min(365, Math.max(1, parseInt(req.query.days as string) || 30));
    const start = new Date();
    start.setDate(start.getDate() - daysBack);
    const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    try {
      const [entries, projects] = await Promise.all([
        prisma.workTimeEntry.findMany({
          where: { username: req.user!.unixUsername, date: { gte: startStr } },
          orderBy: { date: 'asc' },
        }),
        prisma.project.findMany({ where: { userId: req.user!.id }, select: { id: true, name: true } }),
      ]);
      res.json({ days: daysBack, rows: toWorktimeProjectRows(entries, projects) });
    } catch {
      res.status(500).json({ error: 'Failed to fetch per-project worktime data' });
    }
  };

  router.get('/projects', requireAuth, getWorktimeByProject);
  router.get('/', requireAuth, getWorktime);

  return router;
}
