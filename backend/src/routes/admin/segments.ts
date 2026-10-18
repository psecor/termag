/**
 * Segments under /api/admin/segments. Mounted inside
 * adminRouter (requireAdmin + rate limit already ran). Reads are admin-token
 * friendly; the manual rebuild (like every admin write) needs a signed-in
 * session, same as the other /api/admin POSTs.
 */
import { Router } from 'express';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { segmentHistory, segmentTransitions, segmentUsers, segmentSpan, trackerStatus, segmentTrackerTick } from '../../services/segments/queries';

export function segmentsRouter(): Router {
  const router = Router();

  // Everything the tab needs in one call: 30 days of daily buckets, the 7-day
  // flow table, the tracked span, and the tracker's own health.
  router.get('/segments', asyncHandler(async (_req, res) => {
    const [history, transitions, span, status] = await Promise.all([
      segmentHistory(30), segmentTransitions(), segmentSpan(), trackerStatus(),
    ]);
    res.json({ ...history, ...span, transitions, tracker: status });
  }));

  // Per-user rows (with usernames) for a day; defaults to the newest day.
  router.get('/segments/users', asyncHandler(async (req, res) => {
    const day = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : (await segmentSpan()).to;
    res.json({ date: day, users: await segmentUsers(day) });
  }));

  // Ops: force a rebuild now (the tracker normally ticks every 10 min and
  // writes only when today's rows are missing). One upsert per user per day.
  router.post('/segments/rebuild', requireAdminSession, asyncHandler(async (_req, res) => {
    res.json(await segmentTrackerTick());
  }));

  return router;
}
