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
vi.mock('../services/sessionAccess', () => {
  class SessionAccessError extends Error { constructor(public status: number, message: string) { super(message); } }
  return {
    SessionAccessError,
    assertSessionAccess: async (_u: string, projectId: string, role: string, workstream: string) => ({
      host: { instanceId: 'i-1', userId: 'u1' }, session: `u-sample-${role}`, role, workstream, isOwner: true,
      project: { id: projectId, name: 'sample', userId: 'u1', instanceId: 'i-1', ownerUsername: 'u' },
    }),
  };
});
vi.mock('../services/reviewSweep', () => ({
  clearReviewRecord: vi.fn(), getReviewRecord: () => null, identityOf: (x: unknown) => x, markReviewSeen: () => false,
  registerReviewRecord: () => ({ startedAt: new Date('2026-10-15T00:00:00Z') }), touchRecordWithProbe: vi.fn(),
}));
vi.mock('../services/status', () => ({ getAllStatuses: () => new Map() }));
vi.mock('../services/boxActivity', () => ({ noteBoxActivity: vi.fn() }));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'u1' }; next(); },
}));

import { decodePrOption, encodePrOption } from '../services/review';
const { reviewRouter } = await import('./review');
const { setPaneLaunchSettleForTests } = await import('../services/agentRuntime');
// Launches here follow one another into the same pane; the post-launch settle would only add waits.
setPaneLaunchSettleForTests(0);

describe('review PR option codec', () => {
  it('round-trips a PR with and without its url and reviewer', () => {
    expect(decodePrOption(encodePrOption(205, 'https://github.com/example-org/termag/pull/205')))
      .toEqual({ pr: 205, url: 'https://github.com/example-org/termag/pull/205', reviewer: null });
    expect(decodePrOption(encodePrOption(7, null))).toEqual({ pr: 7, url: null, reviewer: null });
    expect(decodePrOption(encodePrOption(7, null, 'claude'))).toEqual({ pr: 7, url: null, reviewer: 'claude' });
    expect(encodePrOption(7, null, 'claude')).toBe('7 - claude');
    expect(decodePrOption(encodePrOption(8, 'https://github.com/o/r/pull/8', 'cursor')))
      .toEqual({ pr: 8, url: 'https://github.com/o/r/pull/8', reviewer: 'cursor' });
  });
  it('re-validates what comes back from tmux', () => {
    expect(decodePrOption('205 https://github.com/o/r/pull/9')).toEqual({ pr: 205, url: null, reviewer: null });
    expect(decodePrOption('205 - codex')).toEqual({ pr: 205, url: null, reviewer: null });
    expect(decodePrOption('abc')).toBeNull();
    expect(decodePrOption('')).toBeNull();
    expect(decodePrOption(null)).toBeNull();
  });
});

describe('review routes: which repository', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', reviewRouter());
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/p1/review`;
  });
  afterAll(() => { server.close(); });

  /** A checkout whose origin is `origin` (null: `git init`, no remote); the pane mentions "PR #342". */
  function box(origin: string | null) {
    agent.calls = [];
    agent.answers = {
      'git-branch-state': () => ({ branch: 'main', origin }),
      'git-pr-info': () => ({ branch: 'main', pr: null, error: null }),
      'tmux-capture': () => ({ content: 'opened PR #342 for this' }),
      'read-file': () => ({ ok: true, content: null }),
      'write-file': () => ({ ok: true }),
      'tmux-has-session': () => ({ exists: false }),
      'tmux-create': () => ({ ok: true }),
      'tmux-set-user-option': () => ({ ok: true }),
      'tmux-send-keys': () => ({ ok: true }),
    };
  }
  beforeEach(() => box(null));

  const post = (body: unknown) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('guess names the workstream repository and gives a URL-less pane guess its URL', async () => {
    box('https://github.com/example-org/termag.git');
    const r = await (await fetch(`${base}/guess?workstream=main`)).json();
    expect(r).toMatchObject({ repo: 'example-org/termag', repoKnown: true });
    expect(r.guess).toMatchObject({ number: 342, source: 'pane', url: 'https://github.com/example-org/termag/pull/342' });
  });
  it('guess says when the directory has no GitHub remote', async () => {
    const r = await (await fetch(`${base}/guess?workstream=main`)).json();
    expect(r).toMatchObject({ repo: null, repoKnown: true, guess: { number: 342, url: null } });
  });
  it('refuses a bare number with no GitHub remote, before touching tmux', async () => {
    const r = await post({ workstream: 'main', pr: 342 });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/no GitHub remote/);
    expect(agent.calls).not.toContain('tmux-create');
  });
  it('starts a URL review in that repository, and a bare number in the workstream\'s', async () => {
    let r = await post({ workstream: 'main', pr: 342, url: 'https://github.com/example-org/termag/pull/342' });
    expect(r.status).toBe(201);
    box('git@github.com:example-org/termag.git');
    const written: string[] = [];
    agent.answers['write-file'] = p => { written.push(p.content as string); return { ok: true }; };
    r = await post({ workstream: 'main', pr: 342 });
    expect(r.status).toBe(201);
    expect((await r.json()).url).toBe('https://github.com/example-org/termag/pull/342');
    expect(written[0]).toContain('Pass --repo example-org/termag to every gh command');
  });
});
