import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/boxes/placement (routes/boxPlacement.ts): off answers 404; on, the
 * caller's own boxes with their checkouts and last use, read into the rule
 * (services/boxPlacement.ts), and nothing is woken, launched or claimed. With
 * a userProjectId (user-projects-enabled), a box has what the session needs
 * when it has a checkout of that project.
 */

const flags = vi.hoisted(() => ({ on: true, policy: 'reuse-first' as string, size: '', userProjects: true }));
vi.mock('../services/featureFlags', () => ({
  boolVariation: vi.fn(async (key: string, _u: unknown, fallback: boolean) => (
    key === 'box-placement-enabled' ? flags.on : key === 'user-projects-enabled' ? flags.userProjects : fallback)),
  stringVariation: vi.fn(async (key: string, _u: unknown, fallback: string) => (key === 'box-placement-policy' ? flags.policy : key === 'box-default-size' ? flags.size : fallback)),
  jsonVariation: vi.fn(async (_k: string, _u: unknown, fallback: unknown) => fallback),
}));

const NOW = Date.parse('2030-01-01T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000);
const db = vi.hoisted(() => ({
  boxes: [] as Array<Record<string, unknown>>,
  projects: [] as Array<Record<string, unknown>>,
  userProjects: [] as Array<{ id: string; userId: string; name: string; archivedAt?: Date | null; repos: Array<{ url: string }> }>,
  warm: 0,
  writes: 0,
  findMany: vi.fn(),
  count: vi.fn(),
}));
vi.mock('../db', () => ({
  prisma: {
    instance: {
      findMany: db.findMany.mockImplementation(async () => db.boxes),
      count: db.count.mockImplementation(async () => db.warm),
      update: vi.fn(async () => { db.writes++; }),
      updateMany: vi.fn(async () => { db.writes++; }),
    },
    project: { findMany: vi.fn(async () => db.projects) },
    userProject: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
        db.userProjects.find(p => p.id === where.id && p.userId === where.userId) ?? null),
    },
    hostSample: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
const provisioned = vi.hoisted(() => ({ configured: true }));
vi.mock('../services/boxProvisioner', () => ({ isBoxProvisioningConfigured: () => provisioned.configured }));
const offline = vi.hoisted(() => new Set<string>());
vi.mock('../services/agentRegistry', () => ({ isInstanceAgentConnected: (id: string) => !offline.has(id) }));

import { boxPlacementFor, isProjectCheckout, reposQuery } from './boxPlacement';

const user = { id: 'u1', unixUsername: 'pat', email: 'pat@example.com', boxPlacement: null } as unknown as Express.User;
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, kind: 'ec2', status: 'ready', ec2InstanceId: `i-${id}`,
  memUsedPct: 40, diskUsedPct: 30, load1: null, hostSampledAt: minsAgo(1), ...over,
});
const project = (id: string, instanceId: string, over: Record<string, unknown> = {}) => ({
  id, instanceId, repoUrl: 'https://github.com/example-org/termag', layout: 'repo', setupStatus: 'ready', lastActiveAt: minsAgo(30), repos: [], ...over,
});

beforeEach(() => {
  flags.on = true;
  flags.policy = 'reuse-first';
  flags.size = '';
  flags.userProjects = true;
  db.userProjects = [];
  offline.clear();
  provisioned.configured = true;
  db.boxes = [];
  db.projects = [];
  db.warm = 0;
  db.writes = 0;
  db.findMany.mockClear();
  db.count.mockClear();
});

describe('GET /api/boxes/placement', () => {
  it('answers 404 box_placement_disabled while the flag is off, and reads nothing', async () => {
    flags.on = false;
    const r = await boxPlacementFor(user, ['example-org/termag'], null, NOW);
    expect(r).toEqual({ status: 404, body: { error: 'Runs on: Auto is not on for you', code: 'box_placement_disabled' } });
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it('lists only the caller\'s own boxes that can take a session', async () => {
    await boxPlacementFor(user, [], null, NOW);
    const where = db.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.autoTerminatedAt).toBeNull();
    expect(where.status.in).toEqual(expect.arrayContaining(['ready', 'starting', 'stopped', 'hibernated', 'stopping', 'hibernating']));
    expect(where.status.in).not.toEqual(expect.arrayContaining(['failed']));
    expect(where.status.in).not.toContain('quarantined');
    expect(where.status.in).not.toContain('terminated');
  });

  it('prefers the box with a checkout of the repository over the last one used', async () => {
    db.boxes = [row('last'), row('repo')];
    db.projects = [
      project('p-last', 'last', { repoUrl: 'https://github.com/example-org/other', lastActiveAt: minsAgo(1) }),
      project('p-repo', 'repo'),
    ];
    const r = await boxPlacementFor(user, ['Example-Org/termag'], null, NOW);
    expect(r.status).toBe(200);
    const body = r.body as { recommended: unknown; boxes: Array<Record<string, unknown>> };
    expect(body.recommended).toEqual({ kind: 'box', instanceId: 'repo', reason: ['has termag', 'room to spare'] });
    expect(body.boxes.find(b => b.instanceId === 'repo')).toMatchObject({ hasRepos: true, checkoutProjectId: 'p-repo', sessions: 1 });
    expect(body.boxes.find(b => b.instanceId === 'last')).toMatchObject({ hasRepos: false, lastUsedAt: minsAgo(1).toISOString() });
    expect(db.writes).toBe(0);
  });

  it('matches a multi-repo checkout by its whole set, and never a clone still pending', async () => {
    db.boxes = [row('ws'), row('pending')];
    db.projects = [
      project('p-ws', 'ws', { layout: 'workspace', repoUrl: null, repos: [{ url: 'https://github.com/example-org/termag-desktop' }, { url: 'https://github.com/example-org/termag' }] }),
      project('p-pending', 'pending', { setupStatus: 'pending', lastActiveAt: minsAgo(1) }),
    ];
    const both = await boxPlacementFor(user, ['example-org/termag', 'example-org/termag-desktop'], null, NOW);
    expect((both.body as { recommended: unknown }).recommended).toMatchObject({ instanceId: 'ws', reason: ['has termag + termag-desktop', 'room to spare'] });
    const one = await boxPlacementFor(user, ['example-org/termag'], null, NOW);
    const boxes = (one.body as { boxes: Array<{ instanceId: string; hasRepos: boolean }> }).boxes;
    expect(boxes.every(b => !b.hasRepos)).toBe(true);
  });

  it('says New box from the pool when a warm box of the size is free', async () => {
    db.warm = 1;
    const r = await boxPlacementFor(user, [], 'large', NOW);
    expect(db.count.mock.calls[0][0]).toEqual({ where: { userId: null, status: 'warm', size: 'large' } });
    expect((r.body as { recommended: unknown }).recommended).toEqual({ kind: 'new', source: 'pool', reason: ['a ready box from the pool'] });
  });

  it('without a size, counts only warm boxes of the owner\'s default size, null while sizes are off', async () => {
    await boxPlacementFor(user, [], null, NOW);
    expect(db.count.mock.calls[0][0]).toEqual({ where: { userId: null, status: 'warm', size: null } });
    flags.size = 'medium';
    await boxPlacementFor(user, [], null, NOW);
    expect(db.count.mock.calls[1][0]).toEqual({ where: { userId: null, status: 'warm', size: 'medium' } });
  });

  it('never recommends a ready box whose agent dropped', async () => {
    db.boxes = [row('gone'), row('live')];
    db.projects = [project('p-gone', 'gone', { lastActiveAt: minsAgo(1) })];
    offline.add('gone');
    const r = await boxPlacementFor(user, ['example-org/termag'], null, NOW);
    const body = r.body as { recommended: unknown; boxes: Array<Record<string, unknown>> };
    expect(body.recommended).toMatchObject({ kind: 'box', instanceId: 'live' });
    expect(body.boxes.find(b => b.instanceId === 'gone')).toMatchObject({ connected: false, hasRepos: true });
  });

  it('never says the pool where no box is provisioned', async () => {
    provisioned.configured = false;
    db.warm = 3;
    const r = await boxPlacementFor(user, [], null, NOW);
    expect((r.body as { newBox: unknown }).newBox).toEqual({ source: 'cold' });
  });

  it('follows box-placement-policy, and reads anything else as reuse first', async () => {
    db.boxes = [row('a')];
    flags.policy = 'fresh-first';
    const fresh = await boxPlacementFor(user, [], null, NOW);
    expect(fresh.body).toMatchObject({ policy: 'fresh-first', policySource: 'org', recommended: { kind: 'new' } });
    flags.policy = 'newest';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = await boxPlacementFor(user, [], null, NOW);
    await boxPlacementFor(user, [], null, NOW);
    expect(other.body).toMatchObject({ policy: 'reuse-first', recommended: { kind: 'box', instanceId: 'a' } });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('the person\'s own default', () => {
  it('beats box-placement-policy', async () => {
    db.boxes = [row('a')];
    flags.policy = 'reuse-first';
    const fresh = await boxPlacementFor({ ...user, boxPlacement: 'fresh-first' } as Express.User, [], null, NOW);
    expect(fresh.body).toMatchObject({ policy: 'fresh-first', policySource: 'personal', recommended: { kind: 'new' } });
    flags.policy = 'fresh-first';
    const reuse = await boxPlacementFor({ ...user, boxPlacement: 'reuse-first' } as Express.User, [], null, NOW);
    expect(reuse.body).toMatchObject({ policy: 'reuse-first', policySource: 'personal', recommended: { kind: 'box', instanceId: 'a' } });
  });

  it('is the org default while unset, or set to something that is not a policy', async () => {
    db.boxes = [row('a')];
    flags.policy = 'fresh-first';
    const r = await boxPlacementFor({ ...user, boxPlacement: 'old' } as unknown as Express.User, [], null, NOW);
    expect(r.body).toMatchObject({ policy: 'fresh-first', policySource: 'org' });
  });
});

describe('GET /api/boxes/placement with a userProjectId', () => {
  const TERMAG = 'https://github.com/example-org/termag';
  const DESKTOP = 'https://github.com/example-org/termag-desktop';

  it("prefers a box with a checkout of the project, named after it, over one of another project on the same repository", async () => {
    db.userProjects = [{ id: 'up-exp', userId: 'u1', name: 'termag experiments', repos: [{ url: TERMAG }] }];
    db.boxes = [row('other'), row('mine')];
    db.projects = [
      project('p-other', 'other', { userProjectId: 'up-main', lastActiveAt: minsAgo(1) }),
      project('p-mine', 'mine', { userProjectId: 'up-exp' }),
    ];
    const r = await boxPlacementFor(user, ['example-org/other'], null, NOW, 'up-exp');
    const body = r.body as { recommended: unknown; boxes: Array<Record<string, unknown>> };
    expect(body.recommended).toEqual({ kind: 'box', instanceId: 'mine', reason: ['has termag experiments', 'room to spare'] });
    expect(body.boxes.find(b => b.instanceId === 'other')).toMatchObject({ hasRepos: false, checkoutProjectId: null });
  });

  it("never offers a checkout missing a repository the project has since gained; one with a repository more still counts", async () => {
    db.userProjects = [{ id: 'up', userId: 'u1', name: 'termag + termag-desktop', repos: [{ url: TERMAG }, { url: DESKTOP }] }];
    db.boxes = [row('old'), row('grown')];
    db.projects = [
      project('p-old', 'old', { userProjectId: 'up', lastActiveAt: minsAgo(1) }),
      project('p-grown', 'grown', {
        userProjectId: 'up', layout: 'workspace', repoUrl: null,
        repos: [{ url: `${DESKTOP}.git` }, { url: TERMAG }, { url: 'https://github.com/example-org/docs' }],
      }),
    ];
    const body = (await boxPlacementFor(user, [], null, NOW, 'up')).body as { boxes: Array<{ instanceId: string; checkoutProjectId: string | null }> };
    expect(body.boxes.find(b => b.instanceId === 'old')?.checkoutProjectId).toBeNull();
    expect(body.boxes.find(b => b.instanceId === 'grown')?.checkoutProjectId).toBe('p-grown');
  });

  it("finds a no-repo project's checkout", async () => {
    db.userProjects = [{ id: 'up', userId: 'u1', name: 'Scratch', repos: [] }];
    db.boxes = [row('a')];
    db.projects = [project('p', 'a', { userProjectId: 'up', repoUrl: null })];
    const r = await boxPlacementFor(user, [], null, NOW, 'up');
    expect((r.body as { recommended: unknown }).recommended).toEqual({ kind: 'box', instanceId: 'a', reason: ['Last used', 'has Scratch', 'room to spare'] });
  });

  it("answers 404 for a project that isn't the caller's", async () => {
    db.userProjects = [{ id: 'up', userId: 'u2', name: 'theirs', repos: [] }];
    expect(await boxPlacementFor(user, [], null, NOW, 'up')).toEqual({ status: 404, body: { error: 'No such project', code: 'user_project_not_found' } });
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it('answers 409 for an archived project, as its create would, and reads no box', async () => {
    db.userProjects = [{ id: 'up', userId: 'u1', name: 'gone', archivedAt: new Date(NOW), repos: [] }];
    expect(await boxPlacementFor(user, [], null, NOW, 'up')).toEqual({ status: 409, body: { error: 'That project is archived', code: 'user_project_archived' } });
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it('places by the repositories, as before, with the record off', async () => {
    flags.userProjects = false;
    db.boxes = [row('repo')];
    db.projects = [project('p-repo', 'repo', { userProjectId: null })];
    const r = await boxPlacementFor(user, ['example-org/termag'], null, NOW, 'up');
    expect((r.body as { recommended: unknown }).recommended).toEqual({ kind: 'box', instanceId: 'repo', reason: ['Last used', 'has termag', 'room to spare'] });
  });
});

describe('isProjectCheckout', () => {
  const p = { id: 'up', repoKeys: ['example-org/termag'] };
  it("is one of the project's checkouts holding each of its repositories, in any spelling", () => {
    expect(isProjectCheckout({ userProjectId: 'up', layout: 'repo', repoUrl: 'git@github.com:Example-Org/termag.git', repos: [] }, p)).toBe(true);
    expect(isProjectCheckout({ userProjectId: 'other', layout: 'repo', repoUrl: 'https://github.com/example-org/termag', repos: [] }, p)).toBe(false);
    expect(isProjectCheckout({ userProjectId: null, layout: 'repo', repoUrl: 'https://github.com/example-org/termag', repos: [] }, p)).toBe(false);
    expect(isProjectCheckout({ userProjectId: 'up', layout: 'repo', repoUrl: null, repos: [] }, p)).toBe(false);
    expect(isProjectCheckout({ userProjectId: 'up', layout: 'repo', repoUrl: null, repos: [] }, { id: 'up', repoKeys: [] })).toBe(true);
  });
});

describe('reposQuery', () => {
  it('takes a comma list, given once or more', () => {
    expect(reposQuery('a/b, c/d,')).toEqual(['a/b', 'c/d']);
    expect(reposQuery(['a/b', 'c/d'])).toEqual(['a/b', 'c/d']);
    expect(reposQuery(undefined)).toEqual([]);
  });
});
