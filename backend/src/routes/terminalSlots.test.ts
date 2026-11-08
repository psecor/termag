import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// The route's wiring: the agent, the database and the access check are fakes,
// so nothing here reaches a box. The agent fake answers per RPC type.
const agent = vi.hoisted(() => ({ answers: {} as Record<string, (p: Record<string, unknown>) => unknown>, calls: [] as string[] }));
vi.mock('../db', () => ({
  prisma: {
    project: {
      findUnique: async () => ({
        id: 'p1', name: 'sample', setupStatus: 'ready',
        user: { unixUsername: 'u' }, instance: { hostHome: '/home/u', status: 'running' },
      }),
    },
  },
}));
vi.mock('../services/agentRegistry', () => ({
  isProjectAgentConnected: () => true,
  sendForProject: async (_h: unknown, type: string, payload: Record<string, unknown>) => {
    agent.calls.push(type);
    const a = agent.answers[type];
    if (!a) throw new Error(`Unknown command: ${type}`);
    return a(payload);
  },
}));
vi.mock('../services/sessionAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sessionAccess')>();
  class SessionAccessError extends Error { constructor(public status: number, message: string) { super(message); } }
  return {
    ...actual,
    SessionAccessError,
    assertSessionAccess: async (_u: string, projectId: string, role: string, workstream: string) => ({
      host: { instanceId: 'i-1', userId: 'u1' }, session: `u-sample-${role}`, role, workstream, isOwner: true, slot: 1,
      project: { id: projectId, name: 'sample', userId: 'u1', instanceId: 'i-1', ownerUsername: 'u', setupStatus: 'ready' },
    }),
  };
});
vi.mock('../services/boxActivity', () => ({ noteBoxActivity: vi.fn() }));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'u1' }; next(); },
}));

const { terminalSlotsRouter } = await import('./terminalSlots');

describe('terminal slot routes', () => {
  let server: Server;
  let base: string;
  let flagOn: boolean;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', terminalSlotsRouter({ flagOn: async () => flagOn }));
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/p1/terminals`;
  });
  afterAll(() => { server.close(); });

  beforeEach(() => {
    flagOn = true;
    agent.calls = [];
    agent.answers = {
      'tmux-list': () => ({ sessions: ['u-sample-agent', 'u-sample-ctrl'] }),
      'tmux-create': () => ({ ok: true }),
      'tmux-kill': () => ({ ok: true }),
    };
  });

  const post = (body: unknown) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('adds the lowest free slot, in the workstream directory, and never slot 1', async () => {
    const r = await post({ workstream: 'main' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, slot: 2, session: 'u-sample-ctrl-2', label: 'term 2' });
    expect(agent.calls).toContain('tmux-create');
  });

  it('skips live slots and is 409 when all are in use', async () => {
    agent.answers['tmux-list'] = () => ({ sessions: ['u-sample-agent', 'u-sample-ctrl', 'u-sample-ctrl-2'] });
    const r = await post({ workstream: 'main' });
    expect(await r.json()).toMatchObject({ slot: 3 });
    agent.answers['tmux-list'] = () => ({ sessions: Array.from({ length: 8 }, (_, i) => (i === 0 ? 'u-sample-agent' : `u-sample-ctrl-${i + 1}`)) });
    const full = await post({ workstream: 'main' });
    expect(full.status).toBe(409);
    expect((await full.json()).code).toBe('terminals_full');
  });

  it('refuses a tab while the flag is off', async () => {
    flagOn = false;
    const r = await post({ workstream: 'main' });
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('terminal_tabs_disabled');
  });

  it('lists only live slots with their labels', async () => {
    agent.answers['tmux-list'] = () => ({ sessions: ['u-sample-ctrl', 'u-sample-ctrl-3', 'u-sample-agent'] });
    const r = await fetch(`${base}?workstream=main`);
    expect(await r.json()).toMatchObject({
      max: 8,
      terminals: [
        { slot: 1, session: 'u-sample-ctrl', label: 'ctrl' },
        { slot: 3, session: 'u-sample-ctrl-3', label: 'term 3' },
      ],
    });
  });

  it('closes a slot by its exact target and refuses the ctrl pane and bad slots', async () => {
    const r = await fetch(`${base}?workstream=main&slot=2`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(agent.calls).toContain('tmux-kill');
    for (const slot of ['1', '0', '9', 'abc']) {
      const bad = await fetch(`${base}?workstream=main&slot=${slot}`, { method: 'DELETE' });
      expect(bad.status).toBe(400);
    }
  });
});
