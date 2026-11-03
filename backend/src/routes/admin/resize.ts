/**
 * Resize anyone's box from the Fleet tab (services/boxResize.ts). Mounted
 * inside adminRouter, so requireAdmin and the audit log already ran: the log's
 * row keeps the actor, the box, the size and the reason (summarizeArgs takes
 * the body's scalars). The resize itself is session only
 * (requireAdminSession), like growing a disk, and needs a reason, which the
 * box's owner sees beside the resize.
 */
import { Router } from 'express';
import { prisma } from '../../db';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { resizeInfo, startResize } from '../../services/boxResize';
import { resizeAccess } from '../../services/boxResizePolicy';

export function resizeRouter(): Router {
  const router = Router();

  router.get('/fleet/instances/:id/resize', asyncHandler(async (req, res) => {
    const box = await prisma.instance.findUnique({ where: { id: req.params.id } });
    if (!box) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(await resizeInfo(box));
  }));

  router.post('/fleet/instances/:id/resize', requireAdminSession, asyncHandler(async (req, res) => {
    const box = await prisma.instance.findUnique({ where: { id: req.params.id } });
    const { size, force, reason } = (req.body ?? {}) as { size?: unknown; force?: unknown; reason?: unknown };
    // Only admins get this far (requireAdmin); the check is the shared one, for the reason.
    const denied = resizeAccess(box, { id: req.user!.id, isAdmin: true }, 'admin', reason);
    if (denied) { res.status(denied.status).json({ error: denied.error, code: denied.code }); return; }
    const started = await startResize(box!, size, {
      userId: req.user!.id, role: box!.userId === req.user!.id ? 'owner' : 'admin', reason: String(reason), via: 'admin',
    }, { force: force === true });
    if (started.ok) res.status(202).json({ resize: started.resize });
    else res.status(started.status).json(started.body);
  }));

  return router;
}
