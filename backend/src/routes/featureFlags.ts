import { Router, RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { flagsForBrowser } from '../services/featureFlags';

// GET /api/flags: the flag values configured by TERMAG_FLAGS, for the
// frontend's useFlag (flags.ts). An empty object means every flag uses its
// fallback.
export function featureFlagsRouter(): Router {
  const router = Router();
  const get: RequestHandler = (_req, res) => {
    res.json({ flags: flagsForBrowser() });
  };
  router.get('/', requireAuth, get);
  return router;
}
