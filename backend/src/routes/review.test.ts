import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// The route's wiring: the agent, the database and the access check are fakes,
// so nothing here reaches a box. The agent fake answers per RPC type.
const agent = vi.hoisted(() => ({ answers: {} as Record<string, (p: Record<string, unknown>) => unknown>, calls: [] as string[], log: [] as Array<{ type: string; payload: Record<string, unknown> }> }));
// The sweep's records by review session, and what the start route filed (slot by slot).
const sweep = vi.hoisted(() => ({ records: new Map<string, { pr: number; url: string | null }>(), registered: [] as Array<{ slot: number; reviewSession: string }>, cleared: [] as string[] }));
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
    agent.log.push({ type, payload });
    const a = agent.answers[type];
    if (!a) throw new Error(`Unknown command: ${type}`);
    return a(payload);
  },
}));
vi.mock('../services/sessionAccess', async (importOriginal) => {
  class SessionAccessError extends Error { constructor(public status: number, message: string) { super(message); } }
  return {
    parseReviewSlot: (await importOriginal<typeof import('../services/sessionAccess')>()).parseReviewSlot,
    SessionAccessError,
    assertSessionAccess: async (_u: string, projectId: string, role: string, workstream: string) => ({
      host: { instanceId: 'i-1', userId: 'u1' }, session: `u-sample-${role}`, role, workstream, isOwner: true, slot: role === 'review' ? 1 : null,
      project: { id: projectId, name: 'sample', userId: 'u1', instanceId: 'i-1', ownerUsername: 'u' },
    }),
  };
});
vi.mock('../services/reviewSweep', () => ({
  clearReviewRecord: (identity: { slot: number }) => { sweep.cleared.push(`slot ${identity.slot}`); },
  getReviewRecord: (_i: unknown, session: string) => sweep.records.get(session) ?? null,
  identityOf: (x: unknown) => x, markReviewSeen: () => false,
  registerReviewRecord: (identity: { slot: number; reviewSession?: string }) => {
    sweep.registered.push({ slot: identity.slot, reviewSession: identity.reviewSession ?? '' });
    return { startedAt: new Date('2026-10-15T00:00:00Z') };
  },
  reviewMetaOf: (x: unknown) => x, reviewRecordsOf: () => [], touchRecordWithProbe: vi.fn(),
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

  // Review all with Devin: one session, one prompt over the members.
  const GROUP = {
    name: 'Desktop bridge',
    members: [
      { repo: 'example-org/termag', number: 646, note: 'the contract' },
      { repo: 'example-org/terraform', number: 28576, note: 'merge after 646 is deployed' },
      { repo: 'example-org/termag', number: 647 },
    ],
  };
  it('starts one review of a group: the prompt lists every member, in order, with its repository', async () => {
    box('https://github.com/example-org/termag.git');
    const written: string[] = [];
    agent.answers['write-file'] = p => { written.push(p.content as string); return { ok: true }; };
    const r = await post({ workstream: 'main', pr: 646, url: 'https://github.com/example-org/termag/pull/646', group: GROUP });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ pr: 646, url: 'https://github.com/example-org/termag/pull/646' });
    const prompt = written[0];
    expect(prompt.startsWith('Review GitHub pull request #646 (https://github.com/example-org/termag/pull/646) first, then the rest of the review group "Desktop bridge"')).toBe(true);
    expect(prompt).toContain('1. example-org/termag#646 (https://github.com/example-org/termag/pull/646) (note: the contract)');
    expect(prompt).toContain('2. example-org/terraform#28576 (https://github.com/example-org/terraform/pull/28576) (note: merge after 646 is deployed)');
    expect(prompt).toContain('3. example-org/termag#647 (https://github.com/example-org/termag/pull/647)\n');
    expect(prompt).toContain('one short verdict per pull request');
    expect(prompt).toContain('Do not modify files, commit, push or post anything to GitHub.');
    expect(prompt).toContain('Reviewed by Devin');
    // The repo template is not read: the group's instructions replace it.
    expect(agent.calls).not.toContain('read-file');
  });
  it('names the first member\'s PR, whatever url says, even in a checkout with no remote (Devin)', async () => {
    box(null);
    const r = await post({ workstream: 'main', pr: 646, url: 'https://github.com/someone/else/pull/646', group: GROUP });
    expect(r.status).toBe(201);
    expect((await r.json()).url).toBe('https://github.com/example-org/termag/pull/646');
    const opt = agent.calls.indexOf('tmux-set-user-option');
    expect(opt).toBeGreaterThan(-1);
  });
  it('refuses a group listing a PR twice (Devin)', async () => {
    box('https://github.com/example-org/termag.git');
    const twice = { name: 'G', members: [{ repo: 'example-org/termag', number: 646 }, { repo: 'Example-Org/Termag', number: 646 }] };
    const r = await post({ workstream: 'main', pr: 646, group: twice });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('example-org/termag#646 is in the group twice');
  });
  it('refuses a group that does not start on pr, comes with an edited prompt, or is malformed', async () => {
    box('https://github.com/example-org/termag.git');
    expect((await post({ workstream: 'main', pr: 647, group: GROUP })).status).toBe(400);
    expect((await post({ workstream: 'main', pr: 646, group: GROUP, prompt: 'x' })).status).toBe(400);
    const bad = await post({ workstream: 'main', pr: 1, group: { name: 'G', members: [{ repo: 'nope', number: 1 }] } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Each pull request needs repo (owner/name) and number');
    expect((await post({ workstream: 'main', pr: 1, group: { name: 'G', members: [] } })).status).toBe(400);
    expect(agent.calls).not.toContain('tmux-create');
  });
});

describe('review routes: several panes (docs/parallel-reviews.md)', () => {
  let server: Server;
  let base: string;
  let parallel = true;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', reviewRouter({ parallelOn: async () => parallel }));
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/p1/review`;
  });
  afterAll(() => { server.close(); });

  const T = 'https://github.com/example-org/termag/pull/';
  /** Live review panes, by session, each with the PR its record names. */
  function panes(live: Record<string, number>) {
    parallel = true;
    agent.calls = [];
    agent.log = [];
    sweep.records = new Map(Object.entries(live).map(([name, pr]) => [name, { pr, url: `${T}${pr}` }]));
    sweep.registered = [];
    sweep.cleared = [];
    agent.answers = {
      'git-branch-state': () => ({ branch: 'main', origin: 'https://github.com/example-org/termag.git' }),
      'read-file': () => ({ ok: true, content: null }),
      'write-file': () => ({ ok: true }),
      'tmux-list': () => ({ sessions: Object.keys(live) }),
      // tmux's lookup: `=<name>:` is that pane only, a bare name also the first one it prefixes.
      'tmux-has-session': p => {
        const t = String(p.sessionName);
        const exact = /^=(.+):$/.exec(t);
        const names = Object.keys(live);
        return { exists: exact ? names.includes(exact[1]) : names.some(n => n.startsWith(t)) };
      },
      'tmux-kill': () => ({ ok: true }),
      'tmux-create': () => ({ ok: true }),
      'tmux-set-user-option': () => ({ ok: true }),
      'tmux-send-keys': () => ({ ok: true }),
    };
  }
  const post = (body: unknown) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const sent = (type: string) => agent.log.filter(c => c.type === type).map(c => c.payload);

  it('adds a pane for another PR, beside the running one', async () => {
    panes({ 'u-sample-review': 646 });
    const r = await post({ workstream: 'main', pr: 647, url: `${T}647` });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ session: 'u-sample-review-2', slot: 2, replaced: false });
    expect(sent('tmux-kill')).toEqual([]);
    expect(sent('tmux-create')[0]).toMatchObject({ sessionName: 'u-sample-review-2' });
    // Every RPC but create names the pane exactly; the prompt file is the plain session's.
    expect(sent('tmux-send-keys')[0]).toMatchObject({ sessionName: '=u-sample-review-2:' });
    expect(String(sent('tmux-send-keys')[0].keys)).toContain('review-prompts/u-sample-review-2.md');
    expect(sent('write-file')[0].path).toBe('/home/u/.termag/review-prompts/u-sample-review-2.md');
    expect(sweep.registered.map(r => r.slot)).toEqual([2]);
  });
  it('restarts only the pane already on that PR', async () => {
    panes({ 'u-sample-review': 646, 'u-sample-review-2': 647 });
    const r = await post({ workstream: 'main', pr: 647, url: `${T}647` });
    expect(await r.json()).toMatchObject({ session: 'u-sample-review-2', slot: 2, replaced: true });
    expect(sent('tmux-kill')).toEqual([{ sessionName: '=u-sample-review-2:' }]);
  });
  it('takes slot 1 when it is free, though slot 2 shares its prefix', async () => {
    panes({ 'u-sample-review-2': 647 });
    const r = await post({ workstream: 'main', pr: 700, url: `${T}700` });
    expect(await r.json()).toMatchObject({ session: 'u-sample-review', slot: 1, replaced: false });
    // A bare `u-sample-review` would have prefix-matched slot 2 and killed it.
    expect(sent('tmux-kill')).toEqual([]);
  });
  it('refuses a ninth pane, touching nothing', async () => {
    panes(Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map(n => [n === 1 ? 'u-sample-review' : `u-sample-review-${n}`, 100 + n])));
    const r = await post({ workstream: 'main', pr: 999, url: `${T}999` });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'reviews_full', error: expect.stringMatching(/All 8 review panes/) });
    expect(agent.calls).not.toContain('tmux-create');
  });
  it('with the flag off replaces slot 1 whatever runs, and never lists tmux', async () => {
    panes({ 'u-sample-review': 646, 'u-sample-review-2': 647 });
    parallel = false;
    const r = await post({ workstream: 'main', pr: 700, url: `${T}700` });
    expect(await r.json()).toMatchObject({ session: 'u-sample-review', slot: 1, replaced: true });
    expect(sent('tmux-kill')).toEqual([{ sessionName: '=u-sample-review:' }]);
    expect(agent.calls).not.toContain('tmux-list');
  });
  it('starts one at a time per workstream, so two at once take two panes', async () => {
    const live: Record<string, number> = {};
    panes(live);
    // The second start lists tmux only after the first created its pane.
    agent.answers['tmux-create'] = p => { live[String(p.sessionName)] = 0; return { ok: true }; };
    // A slow list, so both starts would read it before either creates a pane without the lock.
    agent.answers['tmux-list'] = () => {
      const sessions = Object.keys(live); // what tmux lists when asked, answered a little later
      return new Promise(res => setTimeout(() => res({ sessions }), 30));
    };
    const [a, b] = await Promise.all([post({ workstream: 'main', pr: 1, url: `${T}1` }), post({ workstream: 'main', pr: 2, url: `${T}2` })]);
    expect([(await a.json()).slot, (await b.json()).slot].sort()).toEqual([1, 2]);
  });
  it('takes the slot a start names, replacing what runs there, and refuses one past the last', async () => {
    panes({ 'u-sample-review': 646, 'u-sample-review-2': 647 });
    const r = await post({ workstream: 'main', pr: 700, url: `${T}700`, slot: 1 });
    expect(await r.json()).toMatchObject({ session: 'u-sample-review', slot: 1, replaced: true });
    expect(sent('tmux-kill')).toEqual([{ sessionName: '=u-sample-review:' }]);
    expect(agent.calls).not.toContain('tmux-list');
    expect((await post({ workstream: 'main', pr: 700, url: `${T}700`, slot: 9 })).status).toBe(400);
  });
  it('stops the pane a session names, exactly, and 404s a name that is no slot', async () => {
    panes({ 'u-sample-review': 646, 'u-sample-review-3': 648 });
    let r = await fetch(`${base}?workstream=main&session=u-sample-review-3`, { method: 'DELETE' });
    expect(await r.json()).toMatchObject({ ok: true, session: 'u-sample-review-3' });
    expect(sent('tmux-kill')).toEqual([{ sessionName: '=u-sample-review-3:' }]);
    expect(sweep.cleared).toEqual(['slot 3']);
    r = await fetch(`${base}?workstream=main&session=u-sample-agent`, { method: 'DELETE' });
    expect(r.status).toBe(404);
    r = await fetch(`${base}?workstream=main&session=${encodeURIComponent('u-sample-review*')}`, { method: 'DELETE' });
    expect(r.status).toBe(404);
    // No session: slot 1, as an older client means.
    r = await fetch(`${base}?workstream=main`, { method: 'DELETE' });
    expect(await r.json()).toMatchObject({ session: 'u-sample-review' });
  });
});
