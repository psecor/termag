/**
 * Deployed software under /api/admin/software.
 * Mounted inside adminRouter (requireAdmin and the rate limit already ran).
 */
import { Router } from 'express';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { softwareMatrix, softwareHost, clientVersions } from '../../services/software/queries';
import { refreshInventories } from '../../services/software/collector';

export function softwareRouter(): Router {
  const router = Router();
  router.get('/software', asyncHandler(async (_req, res) => { res.json(await softwareMatrix()); }));
  router.get('/software/clients', asyncHandler(async (_req, res) => { res.json(await clientVersions()); }));
  router.get('/software/hosts/:hostKey', asyncHandler(async (req, res) => {
    const out = await softwareHost(req.params.hostKey);
    if (!out) { res.status(404).json({ error: 'No such host' }); return; }
    res.json(out);
  }));
  // Ask every agent (and the orchestrator) for a fresh inventory now.
  router.post('/software/refresh', requireAdminSession, asyncHandler(async (_req, res) => {
    refreshInventories();
    res.json({ started: true });
  }));
  return router;
}
