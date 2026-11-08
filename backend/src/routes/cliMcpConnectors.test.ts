/**
 * GET /api/cli/v1/mcp-connectors (routes/cliMcpConnectors.ts) through the real
 * cliApiRouter and its bearer check, and how a connector's row reads as one
 * status word.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
vi.mock('../db', () => ({ prisma: {} }));
const { cliApiRouter } = await import('./cliApi');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');
const { connectorStatus } = await import('./cliMcpConnectors');

const cliUser = (id: string): CliUser => ({ id, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id });
const DEVICE = 'tmcli_' + 'a'.repeat(64);
const now = new Date('2026-10-30T04:00:00Z');
const store = {
  async findSessionByHash(hash: string) {
    if (sha256Hex(DEVICE) !== hash) return null;
    return { id: 's-alice', userId: 'alice', user: cliUser('alice'), deviceName: 'mbp', tokenPrefix: 'tmcli_xxx', createdAt: now, lastUsedAt: now, revokedAt: null } satisfies CliSessionRecord;
  },
  validateAgentToken: async () => null,
  touchSession: async () => {},
} as unknown as CliStore;

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use('/api/cli/v1', cliApiRouter({
    store, codes: new AuthCodeStore(), jwt: new Promise(() => {}), now: () => now,
    mcpConnectors: {
      list: async (user) => ({ available: true, connectors: [{ id: 'c1', name: 'linear', upstream: `https://mcp.linear.app/sse?u=${user.id}`, authType: 'oauth', status: 'ready' }] }),
    },
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const get = (token: string | null) => fetch(`${base}/api/cli/v1/mcp-connectors`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

describe('GET /api/cli/v1/mcp-connectors', () => {
  it("lists the signed-in user's connectors, and needs a sign-in", async () => {
    const res = await get(DEVICE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true, available: true,
      connectors: [{ id: 'c1', name: 'linear', upstream: 'https://mcp.linear.app/sse?u=alice', authType: 'oauth', status: 'ready' }],
    });
    expect((await get(null)).status).toBe(401);
  });
});

describe('connectorStatus', () => {
  const base = { id: 'c', name: 'n', upstream: 'https://x', brokerUrl: null, updatedAt: now, headers: {}, secretNames: [] };
  it('reads OAuth by its link and static headers by their secrets', () => {
    expect(connectorStatus({ ...base, authType: 'oauth', missingSecrets: [], linkStatus: 'linked', linkError: null, oauth: null })).toBe('ready');
    expect(connectorStatus({ ...base, authType: 'oauth', missingSecrets: [], linkStatus: 'needs_link', linkError: null, oauth: null })).toBe('needs_link');
    expect(connectorStatus({ ...base, authType: 'oauth', missingSecrets: [], linkStatus: 'needs_link', linkError: 'invalid_grant', oauth: null })).toBe('link_failed');
    expect(connectorStatus({ ...base, authType: 'static', missingSecrets: ['TOKEN'] } as never)).toBe('needs_secrets');
    expect(connectorStatus({ ...base, authType: 'static', missingSecrets: [] } as never)).toBe('ready');
    expect(connectorStatus({ ...base, authType: 'static', secretNames: null, missingSecrets: [] } as never)).toBe('secrets_unreadable');
  });
});
