import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliUser } from '../services/cliStore';

const instances = new Map<string, { id: string; name: string; kind: string; userId: string }>();
const projects = new Map<string, { instanceId: string | null; userId: string; boxStatus?: string }>();
vi.mock('../db', () => ({
  prisma: {
    user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, googleEmail: `${where.id}@x`, displayName: where.id, unixUsername: where.id, defaultAgentProvider: 'claude' }) },
    instance: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
        const row = instances.get(where.id);
        return row && row.userId === where.userId ? { id: row.id, name: row.name, kind: row.kind } : null;
      },
    },
    project: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
        const row = projects.get(where.id);
        return row && row.userId === where.userId
          ? { instanceId: row.instanceId, instance: row.boxStatus ? { status: row.boxStatus } : null }
          : null;
      },
    },
    workstream: { findFirst: async () => ({ id: 'ws1' }) },
  },
}));
const flag = vi.hoisted(() => ({ on: false, asked: [] as string[] }));
vi.mock('../services/desktopAppFlag', () => ({
  T3_CAPABILITY: 't3-v1',
  desktopAppEnabled: async (_user: unknown, box: { id: string }) => { flag.asked.push(box.id); return flag.on; },
}));
const calls = vi.hoisted(() => [] as string[]);
vi.mock('./instances', () => ({
  createBox: vi.fn(), renameOwnedBox: vi.fn(), setOwnedBoxLifecycle: vi.fn(), terminateOwnedBox: vi.fn(),
  powerOwnedBox: async (_user: unknown, _boxId: string, action: string) => { calls.push(`power:${action}`); return { status: 202, body: {} }; },
}));
const createProjectFor = vi.hoisted(() => vi.fn(async () => ({ status: 400, body: { error: 'stop here' } })));
vi.mock('./projects', () => ({
  archiveOwnedProject: vi.fn(), createProjectFor, renameOwnedProject: vi.fn(),
  retryCloneFor: async () => { calls.push('retryClone'); return { status: 202, body: {} }; },
}));
const workstreamInputs = vi.hoisted(() => [] as unknown[]);
vi.mock('./workstreams', () => ({
  createWorkstreamFor: async (_user: unknown, _projectId: string, input: unknown) => { calls.push('createWorkstream'); workstreamInputs.push(input); return { status: 201, body: {} }; },
  removeWorkstreamFor: async () => { calls.push('removeWorkstream'); return { status: 200, body: {} }; },
}));
vi.mock('../services/cliWorkstreams', () => ({
  createCliWorkstream: async (_req: unknown, deps: { create: (input: unknown) => Promise<unknown> }) => { await deps.create({}); return { status: 201, body: {} }; },
}));
vi.mock('../services/cliStorePrisma', () => ({ prismaCliStore: { listBoxes: async () => [], listProjects: async () => [] } }));
vi.mock('../services/agentRegistry', () => ({ instanceAgentTransport: () => null, sendToInstanceAgent: async () => null }));
vi.mock('../services/boxProvisioner', () => ({ isBoxProvisioningConfigured: () => true }));
vi.mock('../services/agentMessages', () => ({ pickTarget: vi.fn() }));
vi.mock('../services/prBranches', () => ({ repoFromOrigin: vi.fn() }));
// A space alice belongs to resolves to its id; any other name, to nothing (services/chatSpace.ts).
vi.mock('../services/chatSpace', () => ({
  resolveChatSpaceChoice: async (name: string | null) => (name === null ? { spaceId: null } : name === 'team' ? { spaceId: 'sp-team' } : null),
}));
const applyAskBoxPolicy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/boxLifecycle', () => ({ applyAskBoxPolicy }));

const { prismaCliLifecycle } = await import('./cliLifecyclePrisma');

const alice: CliUser = { id: 'alice', googleEmail: 'alice@x', unixUsername: 'alice', displayName: 'alice' };

beforeEach(() => {
  flag.on = false;
  flag.asked = [];
  calls.length = 0;
  workstreamInputs.length = 0;
  createProjectFor.mockClear();
  instances.clear();
  projects.clear();
  instances.set('b1', { id: 'b1', name: 'dev', kind: 'ec2', userId: 'alice' });
  projects.set('p1', { instanceId: 'b1', userId: 'alice' });
  projects.set('local', { instanceId: null, userId: 'alice' });
});

describe('the desktop-only CLI routes (workstreams, hibernate), behind desktop-app-enabled', () => {
  it('answer 404 not_found while the flag is off, and do nothing', async () => {
    const results = await Promise.all([
      prismaCliLifecycle.createWorkstream(alice, 'p1', { name: 'feat' }),
      prismaCliLifecycle.removeWorkstream(alice, 'p1', 'feat', { force: false, keepBranch: true }),
      prismaCliLifecycle.powerBox(alice, 'b1', 'hibernate'),
    ]);
    for (const r of results) expect(r).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(calls).toEqual([]);
    expect(flag.asked).toEqual(['b1', 'b1', 'b1']);
  });

  it('leave clone retry ungated: `termag ask --new-box` retries a project whose box failed to launch (Bugbot, #883)', async () => {
    expect((await prismaCliLifecycle.retryClone(alice, 'p1')).status).toBe(202);
    expect(calls).toEqual(['retryClone']);
    expect(flag.asked).toEqual([]);
  });

  it('go through once the flag is on for the box', async () => {
    flag.on = true;
    expect((await prismaCliLifecycle.powerBox(alice, 'b1', 'hibernate')).status).toBe(202);
    await prismaCliLifecycle.removeWorkstream(alice, 'p1', 'feat', { force: false, keepBranch: true });
    expect(calls).toEqual(['power:hibernate', 'removeWorkstream']);
  });

  it('refuse a project with no box, and a box that is not the caller\'s', async () => {
    flag.on = true;
    expect(await prismaCliLifecycle.retryClone(alice, 'local')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    flag.on = false;
    expect(await prismaCliLifecycle.retryClone(alice, 'local')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    flag.on = true;
    const bob: CliUser = { ...alice, id: 'bob' };
    expect(await prismaCliLifecycle.retryClone(bob, 'p1')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(await prismaCliLifecycle.powerBox(bob, 'b1', 'hibernate')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(calls).toEqual([]);
  });

  it('refuse a parked box with 409, as the cookie routes do, before touching the worktree', async () => {
    flag.on = true;
    for (const boxStatus of ['stopped', 'hibernating']) {
      projects.set('p1', { instanceId: 'b1', userId: 'alice', boxStatus });
      expect(await prismaCliLifecycle.removeWorkstream(alice, 'p1', 'feat', { force: false, keepBranch: true }))
        .toMatchObject({ status: 409, body: { code: 'box_not_ready' } });
      expect(await prismaCliLifecycle.retryClone(alice, 'p1')).toMatchObject({ status: 409, body: { code: 'box_not_ready' } });
    }
    expect(calls).toEqual([]);
  });

  it('never ask the flag for start and stop', async () => {
    await prismaCliLifecycle.powerBox(alice, 'b1', 'start');
    await prismaCliLifecycle.powerBox(alice, 'b1', 'stop');
    expect(calls).toEqual(['power:start', 'power:stop']);
    expect(flag.asked).toEqual([]);
  });
});

describe('box create for an ask', () => {
  it('hands createdFor to createBox, so the box gets the ask default size (small)', async () => {
    const { createBox } = await import('./instances');
    vi.mocked(createBox).mockResolvedValue({ status: 409, body: { error: 'taken' } });
    await prismaCliLifecycle.createBox(alice, { name: 'ask1' }, null, 'ask');
    await prismaCliLifecycle.createBox(alice, { name: 'dev2', size: 'large' }, null, null);
    expect(vi.mocked(createBox).mock.calls.map(c => [c[1], c[2]])).toEqual([
      [{ name: 'ask1', kind: 'ec2', size: undefined, repo: undefined }, { parentInstanceId: null, createdFor: 'ask' }],
      [{ name: 'dev2', kind: 'ec2', size: 'large', repo: undefined }, { parentInstanceId: null, createdFor: null }],
    ]);
  });

  it('applies the ask-box policy to a box it made for an ask, and passes the size warnings on', async () => {
    const { createBox } = await import('./instances');
    applyAskBoxPolicy.mockClear();
    vi.mocked(createBox).mockResolvedValue({ status: 201, body: { instance: { id: 'b9' }, claimed: false, warnings: ['acme/app\'s .termag/environment.json: "resources" is "xl", …'] } });
    expect(await prismaCliLifecycle.createBox(alice, { name: 'ask9', repoUrl: 'https://github.com/acme/app' }, null, 'ask'))
      .toEqual({ status: 201, body: { box: null, claimed: false, warnings: ['acme/app\'s .termag/environment.json: "resources" is "xl", …'] } });
    expect(applyAskBoxPolicy).toHaveBeenCalledWith('b9');
    vi.mocked(createBox).mockResolvedValue({ status: 201, body: { instance: { id: 'b10' }, claimed: true } });
    expect(await prismaCliLifecycle.createBox(alice, { name: 'dev10' }, null, null)).toEqual({ status: 201, body: { box: null, claimed: true } });
    expect(applyAskBoxPolicy).toHaveBeenCalledTimes(1);
  });

  it('applies nothing when the create fails', async () => {
    const { createBox } = await import('./instances');
    applyAskBoxPolicy.mockClear();
    vi.mocked(createBox).mockResolvedValue({ status: 409, body: { error: 'taken' } });
    await prismaCliLifecycle.createBox(alice, { name: 'ask1' }, null, 'ask');
    expect(applyAskBoxPolicy).not.toHaveBeenCalled();
  });
});

describe('project create from several repositories', () => {
  it('makes a multi-repo project of them, in order, and answers its checkouts', async () => {
    const { createProjectFor } = await import('./projects');
    vi.mocked(createProjectFor).mockResolvedValue({
      status: 201,
      body: { id: 'p-mr', repos: [{ name: 'web', url: 'https://github.com/acme/web', position: 0 }, { name: 'api', url: 'https://github.com/acme/api', position: 1 }] },
    });
    const got = await prismaCliLifecycle.createProject(alice, { boxId: 'b1', name: 'shop', agent: 'claude', repoUrls: ['https://github.com/acme/web', 'https://github.com/acme/api'] });
    expect(vi.mocked(createProjectFor).mock.calls.at(-1)?.[1]).toMatchObject({ repos: [{ url: 'https://github.com/acme/web' }, { url: 'https://github.com/acme/api' }] });
    expect(vi.mocked(createProjectFor).mock.calls.at(-1)?.[1]).not.toHaveProperty('repoUrl');
    expect(got).toMatchObject({ status: 201, body: { repos: [{ name: 'web', url: 'https://github.com/acme/web' }, { name: 'api', url: 'https://github.com/acme/api' }] } });
  });
});

describe('New session\'s space on a create (services/chatSpace.ts)', () => {
  it('fixes a workstream\'s space by name, No space for null, and leaves one alice can\'t use to the box', async () => {
    flag.on = true;
    await prismaCliLifecycle.createWorkstream(alice, 'p1', { name: 'a', chatSpace: 'team' });
    await prismaCliLifecycle.createWorkstream(alice, 'p1', { name: 'b', chatSpace: null });
    await prismaCliLifecycle.createWorkstream(alice, 'p1', { name: 'c', chatSpace: 'not-hers' });
    await prismaCliLifecycle.createWorkstream(alice, 'p1', { name: 'd' });
    expect(workstreamInputs).toEqual([
      { chatSpace: { spaceId: 'sp-team' } },
      { chatSpace: { spaceId: null } },
      {},
      {},
    ]);
  });

  it('hands a project\'s space to the web form\'s create, and nothing when none is named', async () => {
    await prismaCliLifecycle.createProject(alice, { boxId: 'b1', name: 'fix', agent: 'claude-chat', chatSpace: 'team' });
    await prismaCliLifecycle.createProject(alice, { boxId: 'b1', name: 'fix', agent: 'claude-chat', chatSpace: null });
    await prismaCliLifecycle.createProject(alice, { boxId: 'b1', name: 'fix', agent: 'claude-chat' });
    const spaces = createProjectFor.mock.calls.map(call => (call as unknown as [unknown, { chatSpace?: unknown }])[1]);
    expect(spaces.map(input => ('chatSpace' in input ? input.chatSpace : 'absent'))).toEqual(['team', null, 'absent']);
  });
});
