import { Router, RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { ensureMetaTerm, MetaTermUnavailableError } from '../services/metaterm';

// POST /api/metaterm — the UI entry point. Idempotent: creates the caller's
// pinned MetaTerm singleton on first use, otherwise just ensures it's up and
// returns it. 201 on create, 200 after.
export function metatermRouter(): Router {
  const router = Router();

  const open: RequestHandler = async (req, res) => {
    try {
      const { project, created } = await ensureMetaTerm(req.user!);
      res.status(created ? 201 : 200).json({ project, created });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[METATERM] open failed:', msg);
      const status = err instanceof MetaTermUnavailableError ? err.status : 500;
      res.status(status).json({ error: `Failed to open MetaTerm: ${msg}` });
    }
  };

  router.post('/metaterm', requireAuth, open);
  return router;
}
