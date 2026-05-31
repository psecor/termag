import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { isAgentConnected, sendToAgent } from '../services/agentRegistry';
import { getPollerUsage } from '../services/tmuxPoller';
import { serverSideUsageProviderIds } from '../providers/registry';

const prisma = new PrismaClient();

// Cache usage data per user for 5 minutes
const cache = new Map<string, { data: any; fetchedAt: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export function usageRouter(): Router {
  const router = Router();

  const getUsage: RequestHandler = async (req, res) => {
    const userId = req.user!.id;
    const pollerProviders = serverSideUsageProviderIds();

    // Check cache — but bust if server-side-estimate data is now available but wasn't cached
    const cached = cache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      const hasPollerData = pollerProviders.some(
        pid => cached.data?.providers?.[pid] && Object.keys(cached.data.providers[pid]).length > 0
      );
      if (hasPollerData) {
        res.json(cached.data);
        return;
      }
      // Check if poller data is now available
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const freshPoller = user ? getPollerUsage(user.unixUsername) : {};
      if (Object.keys(freshPoller).length === 0) {
        res.json(cached.data);
        return;
      }
      // Poller data became available — bust cache and re-fetch
    }

    if (!isAgentConnected(userId)) {
      res.status(503).json({ error: 'Agent not connected' });
      return;
    }

    try {
      const result = await sendToAgent(userId, 'usage-scan', {}) as any;

      // Merge server-side usage data (tracked via tmux pane polling)
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user) {
        const pollerData = getPollerUsage(user.unixUsername);
        if (Object.keys(pollerData).length > 0) {
          if (!result.providers) result.providers = {};
          // Poller data is keyed by date; group it under each applicable provider
          // Currently all poller providers share the same accumulator,
          // so assign to the first server-side-estimate provider (cursor)
          for (const pid of pollerProviders) {
            result.providers[pid] = pollerData;
          }
          // Merge into combined days
          for (const [date, d] of Object.entries(pollerData) as [string, any][]) {
            if (!result.days[date]) {
              result.days[date] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 };
            }
            result.days[date].input += d.input;
            result.days[date].output += d.output;
            result.days[date].cacheRead += d.cacheRead;
            result.days[date].cacheCreate += d.cacheCreate;
            result.days[date].calls += d.calls;
          }
        }
      }

      cache.set(userId, { data: result, fetchedAt: Date.now() });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Failed to scan usage' });
    }
  };

  router.get('/', requireAuth, getUsage);

  return router;
}
