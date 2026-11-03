import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// POST /api/admin/prs/teams/import (Sync): an admin uploads the org-tree export.
const sync = vi.hoisted(() => ({ calls: [] as unknown[], fail: null as string | null }));
vi.mock('../../db', () => ({ prisma: {} }));
vi.mock('../../middleware/admin', () => ({
  requireAdminSession: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/prAnalytics/teamSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/prAnalytics/teamSync')>()),
  syncTeams: async (deps: { exportData?: unknown }) => {
    sync.calls.push(deps.exportData);
    if (sync.fail) throw new Error(sync.fail);
    return { teams: 75, members: 300, skipped: 4, source: 'upload' };
  },
}));

const { prsRouter } = await import('./prs');
const { TEAMS_EXPORT_BODY_LIMIT } = await import('../../services/prAnalytics/teamSync');

let server: Server;
let url: string;
beforeAll(async () => {
  const app = express();
  // As index.ts mounts it: the export's own limit ahead of the global 100 KB parser.
  app.use('/api/admin/prs/teams/import', express.json({ limit: TEAMS_EXPORT_BODY_LIMIT }));
  app.use(express.json());
  app.use('/api/admin', prsRouter());
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/prs/teams/import`;
});
afterAll(() => { server.close(); });
beforeEach(() => { sync.calls = []; sync.fail = null; });

const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /prs/teams/import', () => {
  it('syncs from an export bigger than the global body limit, as the real one is', async () => {
    const teams = Array.from({ length: 75 }, (_, i) => ({ tag: `team${i}`, label: `Team ${i}`, parent: null }));
    const members = Object.fromEntries(teams.map(t => [t.tag, { current: Array.from({ length: 10 }, (_, j) => ({ email: `p${j}@example.com`, name: 'x'.repeat(200), start: '2026-09-17' })), former: [] }]));
    const body = { teams, members };
    expect(JSON.stringify(body).length).toBeGreaterThan(100 * 1024);
    const r = await post(body);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ teams: 75, members: 300, skipped: 4, source: 'upload' });
    expect(sync.calls).toHaveLength(1);
  });
  it('refuses something that is not an export, without syncing', async () => {
    const r = await post({ hello: 'world' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('The export has no teams');
    expect(sync.calls).toHaveLength(0);
  });
});

describe('POST /prs/teams/import, failing past the checks', () => {
  it('says why, not a bare 500 (Devin, #1094)', async () => {
    sync.fail = 'the database went away';
    const r = await post({ teams: [{ tag: 'a' }], members: { a: { current: [] } } });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'team import failed: the database went away' });
  });
  it('refuses a bad roster entry with a 400 naming it, before any sync', async () => {
    const r = await post({ teams: [{ tag: 'a' }], members: { a: { current: [null] } } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('A member of a is not an object');
    expect(sync.calls).toHaveLength(0);
  });
});
