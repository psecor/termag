import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// A box's own agent token (`tmag_…`, scope `agent`) is not an admin
// credential anywhere under /api/admin, its owner an admin or not: the bug
// routes included, minting admin tokens and granting admin too. An admin's box
// reads and triages bug reports on /api/cli/v1 only (routes/cliBugReports.ts).
vi.mock('../../db', () => ({ prisma: { user: { update: async () => ({}) }, adminAuditLog: { create: async () => ({}) } } }));
vi.mock('../agentTokens', () => ({ validateAgentToken: vi.fn() }));
const { validateAgentToken } = await import('../agentTokens');
const { adminRouter } = await import('./index');

const BOX = 'tmag_box_of_an_admin';
const ADMIN_TOKEN = 'tmag_admin_scoped';
const root = { id: 'root', googleEmail: 'root@example.com', role: 'admin', adminSource: 'grant' };
vi.mocked(validateAgentToken).mockImplementation(async raw => {
  if (raw === BOX) return { user: root, instance: { id: 'i-root' }, token: { id: 'tok-box', scope: 'agent', name: 'root-box' } } as never;
  if (raw === ADMIN_TOKEN) return { user: root, instance: null, token: { id: 'tok-admin', scope: 'admin', name: 'mcp' } } as never;
  return null;
});

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter());
  server = await new Promise<Server>(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe('a box token under /api/admin', () => {
  it.each([
    ['GET', '/fleet/instances'],
    ['GET', '/users'],
    ['GET', '/audit'],
    ['POST', '/tokens'],
    ['PUT', '/admins/someone'],
    ['GET', '/bug-reports'],
    ['GET', '/bug-reports/counts'],
    ['GET', '/bug-reports/bug1'],
    ['PATCH', '/bug-reports/bug1'],
  ])('refuses %s %s with 404, as for any non-admin', async (method, path) => {
    const r = await fetch(`${base}/api/admin${path}`, {
      method, headers: { authorization: `Bearer ${BOX}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ name: 'x', role: 'admin', status: 'fixed' }),
    });
    expect(r.status).toBe(404);
  });

  it('is told apart from the admin token of the same admin, which gets past requireAdmin', async () => {
    // requireAdminSession's 403, not requireAdmin's 404: the route was reached.
    const r = await fetch(`${base}/api/admin/tokens`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: '{}',
    });
    expect(r.status).toBe(403);
  });
});
