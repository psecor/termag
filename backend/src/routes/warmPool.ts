/**
 * The warm pool's live view, for the "2 warm, 0 warming" line under Boxes.
 *
 * Every number comes from Postgres or from the reconciler's last tick, never
 * from AWS. The Boxes section polls this while it is open, and recomputing the
 * pool spec hash per request would put a DescribeImages call behind each poll.
 */

import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { warmPoolTargetSize } from '../services/warmPoolSize';
import { lastWarmPoolTick } from '../services/warmPool';

const HOUR_MS = 60 * 60 * 1000;

export function warmPoolRouter(): Router {
  const router = Router();

  const summary: RequestHandler = async (_req, res) => {
    const tick = lastWarmPoolTick();
    // Having no owner is what makes a row the pool's. A cold box has an owner
    // from creation and a claimed box has had one since its claim committed.
    const ownerless = { userId: null } as const;

    const [warm, warming, staleWarm, failedLastHour] = await Promise.all([
      prisma.instance.count({ where: { ...ownerless, status: 'warm' } }),
      prisma.instance.count({ where: { ...ownerless, status: 'warming' } }),
      tick === null ? 0 : prisma.instance.count({
        where: {
          ...ownerless,
          status: 'warm',
          // A bare `not` misses a null column, measured against Postgres, and
          // a row with no hash at all launched before the pool tracked one,
          // which is exactly what stale means.
          OR: [{ poolSpecHash: null }, { poolSpecHash: { not: tick.specHash } }],
        },
      }),
      prisma.instance.count({
        where: { ...ownerless, status: 'failed', createdAt: { gte: new Date(Date.now() - HOUR_MS) } },
      }),
    ]);

    res.json({
      target: await warmPoolTargetSize(),
      warm,
      warming,
      staleWarm,
      failedLastHour,
      breakerOpen: tick?.breakerOpen ?? false,
      specHash: tick?.specHash ?? null,
    });
  };

  router.get('/', requireAuth, asyncHandler(summary));

  return router;
}
