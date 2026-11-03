/**
 * Admin box actions: quarantine a box, and terminate a quarantined
 * one. Mounted inside adminRouter, so requireAdmin and the audit row already
 * apply. Both are session-only (requireAdminSession): an admin bearer token
 * is a read credential a model or script holds, and these act on someone
 * else's machine.
 */
import { Router } from 'express';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { parseQuarantineBody } from '../../services/boxQuarantinePolicy';
import { quarantineBoxAnswer, terminateQuarantinedBox } from '../../services/boxQuarantine';
import { sendResult } from '../routeResult';

export function quarantineRouter(): Router {
  const router = Router();

  router.post('/fleet/instances/:id/quarantine', requireAdminSession, asyncHandler(async (req, res) => {
    const parsed = parseQuarantineBody(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    sendResult(res, await quarantineBoxAnswer(req.params.id, req.user!, parsed.reason));
  }));

  router.post('/fleet/instances/:id/terminate', requireAdminSession, asyncHandler(async (req, res) => {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
      res.status(400).json({ error: 'confirm: true is required' });
      return;
    }
    sendResult(res, await terminateQuarantinedBox(req.params.id, req.user!));
  }));

  return router;
}
