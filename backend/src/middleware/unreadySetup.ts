import type { RequestHandler } from 'express';
import { prisma } from '../db';
import { refuseUnreadySessions } from '../services/sessionGate';

/**
 * Answers 409 when the caller's project named by `req.params[param]` is still
 * being set up from its repository (services/sessionGate.ts). Scoped to the
 * caller's own projects because the routes it guards are owner-only: anyone
 * else's id falls through to the route's 404.
 */
export function refuseUnreadySetup(param: string): RequestHandler {
  return async function refuseUnreadySetup(req, res, next) {
    try {
      const project = await prisma.project.findFirst({
        where: { id: req.params[param], userId: req.user!.id },
        select: { id: true, setupStatus: true },
      });
      const refusal = project && refuseUnreadySessions(project);
      if (refusal) { res.status(409).json({ error: refusal.message }); return; }
      next();
    } catch (err) {
      next(err);
    }
  };
}
