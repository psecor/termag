import type { RequestHandler } from 'express';
import { prisma } from '../db';
import { powerStateError } from '../services/boxPowerPolicy';

/**
 * Answers 409 when the caller's project named by `req.params[param]` lives on
 * a box that is stopping, stopped or starting. Checked on the row rather than
 * on agent liveness: a stopping box's agent stays connected until EC2 powers
 * the instance off, and new sessions made in that window die with it.
 * Scoped to the caller's own projects because the routes it guards are
 * owner-only: anyone else's id falls through to the route's 404.
 */
export function refuseParkedBox(param: string): RequestHandler {
  return async function refuseParkedBox(req, res, next) {
    try {
      const project = await prisma.project.findFirst({
        where: { id: req.params[param], userId: req.user!.id },
        select: { instance: { select: { status: true } } },
      });
      const error = project?.instance ? powerStateError(project.instance.status) : null;
      if (error) { res.status(409).json({ error }); return; }
      next();
    } catch (err) {
      next(err);
    }
  };
}
