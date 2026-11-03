/**
 * Grow a box's root volume from the Fleet tab (services/boxDisk.ts). Mounted
 * inside adminRouter, so requireAdmin and the audit log already ran. The grow
 * is session only (requireAdminSession).
 */
import { Router } from 'express';
import { prisma } from '../../db';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { instanceAgentTransport } from '../../services/agentRegistry';
import {
  describeRootVolume, growRefusal, lastGrow, MAX_VOLUME_GB, parseGrowBody, startGrow,
} from '../../services/boxDisk';

export function diskRouter(): Router {
  const router = Router();

  router.get('/fleet/instances/:id/disk', asyncHandler(async (req, res) => {
    const box = await prisma.instance.findUnique({ where: { id: req.params.id } });
    if (!box) { res.status(404).json({ error: 'Not found' }); return; }
    const refusal = growRefusal(box, instanceAgentTransport(box.id)?.capabilities ?? null);
    const volume = box.kind === 'ec2' && box.ec2InstanceId
      ? await describeRootVolume(box).catch((err: Error) => ({ error: err.message }))
      : null;
    res.json({ refusal, maxGb: MAX_VOLUME_GB, volume, grow: lastGrow(box.id) });
  }));

  router.post('/fleet/instances/:id/disk', requireAdminSession, asyncHandler(async (req, res) => {
    const box = await prisma.instance.findUnique({ where: { id: req.params.id } });
    if (!box) { res.status(404).json({ error: 'Not found' }); return; }
    const refusal = growRefusal(box, instanceAgentTransport(box.id)?.capabilities ?? null);
    if (refusal) { res.status(409).json({ error: refusal }); return; }
    const volume = await describeRootVolume(box);
    const parsed = parseGrowBody(req.body, volume);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    try {
      res.status(202).json(await startGrow(box, volume, parsed.sizeGb, req.user!.unixUsername, undefined, req.user!.id));
    } catch (err) {
      // EC2's own refusals (one modification per volume per six hours, a modification still running) are the admin's to read.
      res.status(409).json({ error: (err as Error).message });
    }
  }));

  return router;
}
