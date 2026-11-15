// The sampler's load on the database: at most MAX_CONCURRENT_PERSISTS host
// scans write at once, however many hosts and users are due together.
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ active: 0, peak: 0, writes: 0 }));
vi.mock('./agentRegistry', () => ({
  getConnectedAgents: () => Array.from({ length: 4 }, (_, u) => Array.from({ length: 3 }, (_, b) => ({ userId: `u${u}`, unixUsername: `u${u}`, instanceId: `i-${u}-${b}` }))).flat(),
  sendForProject: async () => {
    const days = { '2026-11-13': { input: 1, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, calls: 1 } };
    return { schema: 2, sources: { claude: { buckets: [{ dir: 'd', days, models: [{ model: 'opus', backend: '', days }] }] } } };
  },
}));
vi.mock('./tmuxPoller', () => ({ getPollerUsage: () => ({}) }));
vi.mock('../db', () => {
  // A host's writes run from its first deleteMany to its last $executeRaw (the model rows').
  const slow = () => new Promise(r => setTimeout(r, 5));
  return {
    prisma: {
      project: { findMany: async () => [] },
      tokenUsageDay: {
        deleteMany: async () => { h.active++; h.peak = Math.max(h.peak, h.active); await slow(); return { count: 0 }; },
        findMany: async () => [],
      },
      tokenUsageModelDay: { deleteMany: async () => ({ count: 0 }), findMany: async () => [] },
      $executeRaw: async (q: { sql: string }) => {
        await slow();
        h.writes++;
        if (q.sql.includes('token_usage_model_days')) h.active--;
        return 1;
      },
    },
  };
});

import { MAX_CONCURRENT_PERSISTS, runUserScan } from './tokenUsageSampler';

describe('token-usage sampler scheduling', () => {
  it('12 hosts of 4 users scanned at once write at most MAX_CONCURRENT_PERSISTS at a time, and all of them write', async () => {
    await Promise.all(['u0', 'u1', 'u2', 'u3'].map(u => runUserScan(u)));
    expect(MAX_CONCURRENT_PERSISTS).toBe(3);
    expect(h.peak).toBe(3);
    expect(h.active).toBe(0);
    expect(h.writes).toBe(24); // one day statement and one model statement per host
  });
});
