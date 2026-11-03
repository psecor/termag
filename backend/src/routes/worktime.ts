import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { toWorktimeProjectRows, worktimeUsernames } from '../services/worktimeProjects';
import { noteUserTimeZone } from '../services/userTimeZone';
import { shiftDay, workTimeDay } from '../services/worktimeDays';
import type { RouteResult } from './routeResult';

/** Who reads working time: the zone they report is recorded for banking (services/userTimeZone.ts). */
type Reader = { readonly id: string; readonly unixUsername: string; readonly timeZone?: string | null };

/**
 * This person's today, and the day `daysBack` days before it, in the zone the
 * reader sends as `tz` (else the one on record, else the orchestrator's):
 * working time is banked by their days (services/worktimeDays.ts).
 */
function readerDays(user: Reader, tzRaw: unknown, daysBack: number): { today: string; since: string } {
  const today = workTimeDay(Date.now(), noteUserTimeZone(user, tzRaw));
  return { today, since: shiftDay(today, -daysBack) };
}

/**
 * GET /api/worktime?days=N&tz=Zone: banked time per day and provider (`human`
 * is the user's own), and which day is their `today`. Shared with GET
 * /api/cli/v1/worktime (routes/cliWorktime.ts).
 */
export async function worktimeFor(user: Reader, daysRaw: unknown, tzRaw?: unknown): Promise<RouteResult> {
  const daysBack = parseInt(daysRaw as string) || 30;
  const { today, since } = readerDays(user, tzRaw, daysBack);
  try {
    const entries = await prisma.workTimeEntry.findMany({
      where: {
        username: { in: worktimeUsernames(user.unixUsername) },
        date: { gte: since },
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

    return { status: 200, body: { days, today } };
  } catch {
    return { status: 500, body: { error: 'Failed to fetch worktime data' } };
  }
}

// GET /api/worktime/projects?days=N&tz=Zone — the same rows, but keeping the
// project dimension (resolved to id + workstream) instead of grouping it away.
// Feeds the dashboard's effort-by-project view. Days are the person's, like `/`.
// Shared with GET /api/cli/v1/worktime/projects.
export async function worktimeByProjectFor(user: Reader, daysRaw: unknown, tzRaw?: unknown): Promise<RouteResult> {
  const daysBack = Math.min(365, Math.max(1, parseInt(daysRaw as string) || 30));
  const { today, since } = readerDays(user, tzRaw, daysBack);
  try {
    const [entries, projects] = await Promise.all([
      prisma.workTimeEntry.findMany({
        where: { username: { in: worktimeUsernames(user.unixUsername) }, date: { gte: since } },
        orderBy: { date: 'asc' },
      }),
      prisma.project.findMany({ where: { userId: user.id }, select: { id: true, name: true, instanceId: true } }),
    ]);
    return { status: 200, body: { days: daysBack, today, rows: toWorktimeProjectRows(entries, projects) } };
  } catch {
    return { status: 500, body: { error: 'Failed to fetch per-project worktime data' } };
  }
}

export function worktimeRouter(): Router {
  const router = Router();

  const getWorktime: RequestHandler = async (req, res) => {
    const out = await worktimeFor(req.user!, req.query.days, req.query.tz);
    res.status(out.status).json(out.body);
  };

  const getWorktimeByProject: RequestHandler = async (req, res) => {
    const out = await worktimeByProjectFor(req.user!, req.query.days, req.query.tz);
    res.status(out.status).json(out.body);
  };

  router.get('/projects', requireAuth, getWorktimeByProject);
  router.get('/', requireAuth, getWorktime);

  return router;
}
