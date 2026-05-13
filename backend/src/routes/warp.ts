import { Router, RequestHandler } from 'express';
import { recordWarpSample } from '../services/warpSampler';
import { requireAuth } from '../middleware/auth';

export function warpRouter(): Router {
  const router = Router();

  const sample: RequestHandler = (req, res) => {
    const { value, ts } = req.body as { value?: number; ts?: number };
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      res.status(400).json({ error: 'value must be a finite number' });
      return;
    }
    // Sanity guard — warp values normally stay under ~10. 50 is a generous ceiling.
    if (value < 0 || value > 50) {
      res.status(400).json({ error: 'value out of range [0, 50]' });
      return;
    }
    if (ts !== undefined && (typeof ts !== 'number' || !Number.isFinite(ts))) {
      res.status(400).json({ error: 'ts must be a finite number' });
      return;
    }
    recordWarpSample(req.user!.id, value, ts);
    res.json({ ok: true });
  };

  router.post('/sample', requireAuth, sample);

  return router;
}
