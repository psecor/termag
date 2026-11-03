import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';

const rows = vi.hoisted(() => [] as Array<{ id: string; name: string; project: { name: string; userId: string; instanceId: string } }>);
vi.mock('../db', () => ({
  prisma: {
    workstream: {
      findFirst: async ({ where }: { where: { name: string; project: { name: string; userId: string; instanceId: string } } }) => {
        const row = rows.find(r => r.name === where.name
          && r.project.name === where.project.name && r.project.userId === where.project.userId && r.project.instanceId === where.project.instanceId);
        return row ? { id: row.id } : null;
      },
    },
  },
}));
// The chat's space as turnMemorySpace answers it: a name, null for none, undefined when it can't be read.
const spaces = vi.hoisted(() => new Map<string, string | null | undefined>());
vi.mock('../services/chatSpace', () => ({ turnMemorySpace: async (id: string) => spaces.get(id) }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { cliApiRouter } = await import('./cliApi');
const { prismaCliSessionSpace } = await import('./cliSessionSpace');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'd'.repeat(64);
const BOX = 'tmag_box';
const now = new Date('2026-10-31T00:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    if (hash !== sha256Hex(DEVICE)) return null;
    return {
      id: 's1', userId: 'alice', user: alice, deviceName: 'mbp', tokenPrefix: 'tmcli_ddd',
      createdAt: now, lastUsedAt: now, revokedAt: null,
    } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) {
    return raw === BOX ? { user: alice, instanceId: 'b1' } : null;
  },
  createSession: async () => { throw new Error('unused'); },
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), now: () => now, sessionSpace: prismaCliSessionSpace }));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: err.message }); });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  rows.length = 0;
  spaces.clear();
  rows.push(
    { id: 'w-main', name: 'main', project: { name: 'app', userId: 'alice', instanceId: 'b1' } },
    { id: 'w-fix', name: 'fix-login', project: { name: 'app', userId: 'alice', instanceId: 'b1' } },
    { id: 'w-other', name: 'main', project: { name: 'app', userId: 'alice', instanceId: 'b2' } },
  );
  spaces.set('w-main', 'team');
  spaces.set('w-fix', null);
  spaces.set('w-other', 'elsewhere');
});

const ask = (query: string, token: string | null = BOX) =>
  fetch(`${base}/api/cli/v1/session-space${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('GET /session-space', () => {
  it("answers a session's own space on this box: main's by default, a worktree's by name, null for No space", async () => {
    expect(await (await ask('?project=app')).json()).toEqual({ space: 'team' });
    expect(await (await ask('?project=app&workstream=fix-login')).json()).toEqual({ space: null });
  });

  it("is a box's own: a device sign-in is refused, and another box's project isn't found", async () => {
    expect((await ask('?project=app', DEVICE)).status).toBe(403);
    expect((await ask('?project=app', null)).status).toBe(401);
    rows.splice(0, 2);
    expect((await ask('?project=app')).status).toBe(404);
  });

  it('refuses a name termag would never make, and fails rather than answer an unreadable space', async () => {
    for (const query of ['', '?project=', '?project=a/b', '?project=app&workstream=..']) {
      expect((await ask(query)).status, query).toBe(400);
    }
    spaces.set('w-main', undefined);
    expect((await ask('?project=app')).status).toBe(500);
  });
});
