import { Router, RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { isAgentConnected, sendToAgent } from '../services/agentRegistry';

// Cache usage data per user for 5 minutes
const cache = new Map<string, { data: any; fetchedAt: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export function usageRouter(): Router {
  const router = Router();

  const getUsage: RequestHandler = async (req, res) => {
    const userId = req.user!.id;

    // Check cache
    const cached = cache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      res.json(cached.data);
      return;
    }

    if (!isAgentConnected(userId)) {
      res.status(503).json({ error: 'Agent not connected' });
      return;
    }

    try {
      const result = await sendToAgent(userId, 'usage-scan', {});
      cache.set(userId, { data: result, fetchedAt: Date.now() });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Failed to scan usage' });
    }
  };

  router.get('/', requireAuth, getUsage);

  return router;
}
