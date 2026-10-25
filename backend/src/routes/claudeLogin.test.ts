import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const gate = vi.hoisted(() => ({
  userId: 'u1',
  owner: true,
  missing: false,
  calls: [] as { type: string; timeout?: number; payload?: Record<string, unknown> }[],
}));

const URL = 'https://claude.com/cai/oauth/authorize?code=true&code_challenge=abc&login_method=sso&state=xyz';
const CODE = 'good-code#good-state';

vi.mock('../db', () => ({
  prisma: {
    project: {
      findFirst: async ({ where }: { where: { userId?: string } }) => (
        where.userId === 'u1' ? { instance: { status: 'ready' } } : null
      ),
      findUnique: async () => null,
    },
  },
}));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: gate.userId, googleEmail: 'person@example.invalid' };
    next();
  },
}));
vi.mock('../services/agentRegistry', () => ({
  isProjectAgentConnected: () => true,
  projectAgentCapabilities: () => ['claude-login-v1'],
  sendForProject: async (_host: unknown, type: string, payload: Record<string, unknown>, timeout?: number) => {
    gate.calls.push({ type, timeout, payload });
    if (type === 'claude-login-start' || type === 'claude-login-status') {
      return { phase: 'needs-code', loggedIn: false, authMethod: 'none', url: URL };
    }
    return { phase: 'ready', loggedIn: true, authMethod: 'claude.ai' };
  },
}));
vi.mock('../services/sessionAccess', () => {
  class SessionAccessError extends Error {
    constructor(public status: number, message: string) { super(message); }
  }
  return {
    SessionAccessError,
    projectSessionAccess: async (_userId: string, projectId: string) => {
      if (projectId === 'missing' || gate.missing) throw new SessionAccessError(404, 'Project not found');
      return () => ({
        host: { userId: 'box-user', instanceId: 'i-1' },
        isOwner: gate.owner,
      });
    },
  };
});

const { claudeLoginRouter } = await import('./claudeLogin');

describe('claude login routes', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/projects', claudeLoginRouter());
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
  });
  afterAll(() => { server.close(); });
  beforeEach(() => {
    gate.userId = 'u1';
    gate.owner = true;
    gate.missing = false;
    gate.calls = [];
  });

  const send = (project: string, method: string, path: string, body?: unknown) => fetch(`${base}/${project}/claude-login${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('lets the owner start and paste, and gives the agent the long window', async () => {
    const started = await send('box-a', 'POST', '');
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ phase: 'needs-code', url: URL });
    expect(gate.calls[0]).toMatchObject({ type: 'claude-login-start', timeout: 45_000 });

    const pasted = await send('box-a', 'POST', '/code', { code: CODE });
    expect(pasted.status).toBe(200);
    expect(await pasted.json()).toMatchObject({ phase: 'ready', loggedIn: true });
    expect(gate.calls[1]).toMatchObject({ type: 'claude-login-submit', timeout: 45_000, payload: { code: CODE } });
  });

  it('refuses a collaborator on every write and hides the link on a read', async () => {
    gate.userId = 'u2';
    gate.owner = false;
    for (const req of [
      send('p1', 'POST', ''),
      send('p1', 'POST', '/code', { code: CODE }),
      send('p1', 'POST', '/code', { code: 'not-a-code' }),
      send('p1', 'DELETE', ''),
    ]) {
      const res = await req;
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('owner');
    }
    expect(gate.calls).toEqual([]);

    const read = await send('p1', 'GET', '');
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.phase).toBe('owner');
    expect(body.url).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('oauth/authorize');
    expect(gate.calls.map(c => c.type)).toEqual(['claude-login-status']);
  });

  it('checks access before it judges the paste', async () => {
    gate.missing = true;
    const missing = await send('missing', 'POST', '/code', { code: 'not-a-code' });
    expect(missing.status).toBe(404);
    expect(gate.calls).toEqual([]);

    gate.missing = false;
    const bad = await send('p1', 'POST', '/code', { code: 'not-a-code' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('bad-code');
    expect(gate.calls).toEqual([]);
  });

  it('limits each project on its own', async () => {
    for (let i = 0; i < 5; i += 1) expect((await send('p1', 'POST', '')).status).toBe(200);
    const blocked = await send('p1', 'POST', '');
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).code).toBe('rate-limited');
    expect((await send('p2', 'POST', '')).status).toBe(200);

    for (let i = 0; i < 8; i += 1) expect((await send('p1', 'POST', '/code', { code: CODE })).status).toBe(200);
    expect((await send('p1', 'POST', '/code', { code: CODE })).status).toBe(429);
    expect((await send('p2', 'POST', '/code', { code: CODE })).status).toBe(200);
  });
});
