import { describe, expect, it, vi } from 'vitest';
import { searchFor } from './sessions';
import type { SearchDeps } from '../services/sessionSearch';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuthOrAgentToken: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({ sendForProject: vi.fn(), isProjectAgentConnected: vi.fn() }));

const deps = (): SearchDeps & { listRows: ReturnType<typeof vi.fn> } => ({
  listRows: vi.fn(async () => [{ projectId: 'p1', projectName: 't', owner: 'ada', access: 'owner', workstream: 'main', role: 'agent', session: 's', connected: true, alive: true, status: 'idle' }]),
  accessProject: async () => () => ({ host: { userId: 'u', instanceId: null }, session: 's' }),
  capture: async () => 'one HIT here',
});

describe('searchFor', () => {
  it('validates the query', async () => {
    expect((await searchFor('u-val', { q: ' a ' }, 'browser', deps())).status).toBe(400);
    expect((await searchFor('u-val', { q: 'x'.repeat(201) }, 'browser', deps())).status).toBe(400);
  });

  it('searches, caches a repeat, and rate-limits a different search from the same caller', async () => {
    const d = deps();
    const first = await searchFor('u-rl', { q: 'hit' }, 'browser', d, 1_000_000);
    expect(first.status).toBe(200);
    expect((first.body as { hits: unknown[] }).hits).toHaveLength(1);
    // Same search, case aside, inside the cache window: no new fan-out, not rate limited.
    const again = await searchFor('u-rl', { q: 'HIT' }, 'browser', d, 1_001_000);
    expect(again).toMatchObject({ status: 200, body: { cached: true } });
    expect(d.listRows).toHaveBeenCalledTimes(1);
    // A different search one second later is too soon for this caller…
    expect((await searchFor('u-rl', { q: 'other' }, 'browser', d, 1_001_000)).status).toBe(429);
    // …but another caller (MetaTerm's box token) has its own budget.
    expect((await searchFor('u-rl', { q: 'other' }, 'box-1', d, 1_001_000)).status).toBe(200);
    expect((await searchFor('u-rl', { q: 'third' }, 'browser', d, 1_004_000)).status).toBe(200);
  });

  it('hands the rate-limit budget back when the search itself fails', async () => {
    const d = deps();
    d.listRows.mockRejectedValueOnce(new Error('db down'));
    await expect(searchFor('u-refund', { q: 'hit' }, 'browser', d, 2_000_000)).rejects.toThrow('db down');
    expect((await searchFor('u-refund', { q: 'hit' }, 'browser', d, 2_000_500)).status).toBe(200);
  });

  it('clamps lines and passes roles through', async () => {
    const d = deps();
    const r = await searchFor('u-lines', { q: 'hit', lines: '5000', roles: 'ctrl' }, 'browser', d);
    expect(r.body).toMatchObject({ lines: 1000, roles: ['ctrl'], searched: 0, hits: [] });
  });
});
