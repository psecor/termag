import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliUser } from '../services/cliStore';

const mainModel = vi.hoisted(() => ({ value: null as string | null }));
const askModelOn = vi.hoisted(() => ({ value: true }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async (key: string) => key === 'ask-model-choice-enabled' && askModelOn.value) }));
const instances = new Map<string, { id: string; name: string; kind: string; userId: string }>();
const projects = new Map<string, { instanceId: string | null; userId: string; boxStatus?: string }>();
vi.mock('../db', () => ({
  prisma: {
    user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, googleEmail: `${where.id}@x`, displayName: where.id, unixUsername: where.id, defaultAgentProvider: 'claude' }) },
    instance: {
      findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, name: where.id, kind: 'ec2' }),
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
    // The main workstream's agent row, as the create left it (an un-archive keeps the old one).
    workflow: { findFirst: async () => ({ model: mainModel.value }) },
  },
}));
vi.mock('../services/desktopAppFlag', () => ({ T3_CAPABILITY: 't3-v1' }));
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
  calls.length = 0;
  workstreamInputs.length = 0;
  createProjectFor.mockClear();
  instances.clear();
  projects.clear();
  instances.set('b1', { id: 'b1', name: 'dev', kind: 'ec2', userId: 'alice' });
  projects.set('p1', { instanceId: 'b1', userId: 'alice' });
  projects.set('local', { instanceId: null, userId: 'alice' });
});

describe('the desktop-only CLI routes (workstreams, hibernate)', () => {
  it('leave clone retry ungated: `termag ask --new-box` retries a project whose box failed to launch (Bugbot, #883)', async () => {
    expect((await prismaCliLifecycle.retryClone(alice, 'p1')).status).toBe(202);
    expect(calls).toEqual(['retryClone']);
  });

  it('go through for the caller\'s box', async () => {
    expect((await prismaCliLifecycle.powerBox(alice, 'b1', 'hibernate')).status).toBe(202);
    await prismaCliLifecycle.removeWorkstream(alice, 'p1', 'feat', { force: false, keepBranch: true });
    expect(calls).toEqual(['power:hibernate', 'removeWorkstream']);
  });

  it('refuse a project with no box, and a box that is not the caller\'s', async () => {
    expect(await prismaCliLifecycle.retryClone(alice, 'local')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    const bob: CliUser = { ...alice, id: 'bob' };
    expect(await prismaCliLifecycle.retryClone(bob, 'p1')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(await prismaCliLifecycle.powerBox(bob, 'b1', 'hibernate')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(calls).toEqual([]);
  });

  it('refuse a parked box with 409, as the cookie routes do, before touching the worktree', async () => {
    for (const boxStatus of ['stopped', 'hibernating']) {
      projects.set('p1', { instanceId: 'b1', userId: 'alice', boxStatus });
      expect(await prismaCliLifecycle.removeWorkstream(alice, 'p1', 'feat', { force: false, keepBranch: true }))
        .toMatchObject({ status: 409, body: { code: 'box_not_ready' } });
      expect(await prismaCliLifecycle.retryClone(alice, 'p1')).toMatchObject({ status: 409, body: { code: 'box_not_ready' } });
    }
    expect(calls).toEqual([]);
  });

  it('let start and stop through', async () => {
    await prismaCliLifecycle.powerBox(alice, 'b1', 'start');
    await prismaCliLifecycle.powerBox(alice, 'b1', 'stop');
    expect(calls).toEqual(['power:start', 'power:stop']);
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

describe('project create --model', () => {
  it('answers the model the main workstream really has: the one asked for, or an un-archived project\'s own', async () => {
    vi.mocked(createProjectFor).mockResolvedValue({ status: 201, body: { id: 'p-new' } } as never);
    mainModel.value = 'opus';
    const made = await prismaCliLifecycle.createProject(alice, { boxId: 'b1', name: 'fix', agent: 'claude', model: 'opus' });
    expect(vi.mocked(createProjectFor).mock.calls.at(-1)?.[1]).toMatchObject({ initialAgent: { provider: 'claude', model: 'opus' } });
    expect(made).toMatchObject({ status: 201, body: { model: 'opus', restored: false } });
    // Un-archived: it keeps its agent row (haiku), as it keeps its directory against `from`.
    vi.mocked(createProjectFor).mockResolvedValue({ status: 200, body: { id: 'p-old', restored: true } } as never);
    mainModel.value = 'haiku';
    const restored = await prismaCliLifecycle.createProject(alice, { boxId: 'b1', name: 'old', agent: 'claude', model: 'opus' });
    expect(restored).toMatchObject({ body: { model: 'haiku', restored: true } });
    mainModel.value = null;
    expect(await prismaCliLifecycle.createProject(alice, { boxId: 'b1', name: 'old', agent: 'claude', model: 'opus' })).toMatchObject({ body: { model: null } });
    // Off for the creator and box: not applied, and the answer says why.
    askModelOn.value = false;
    vi.mocked(createProjectFor).mockResolvedValue({ status: 201, body: { id: 'p-new' } } as never);
    mainModel.value = null;
    const off = await prismaCliLifecycle.createProject(alice, { boxId: 'b1', name: 'off', agent: 'claude', model: 'opus' });
    expect((vi.mocked(createProjectFor).mock.calls.at(-1)?.[1] as { initialAgent: object }).initialAgent).not.toHaveProperty('model');
    expect(off).toMatchObject({ body: { model: null, modelIgnored: expect.stringContaining('ask-model-choice-enabled') } });
    // Off and restored: it keeps its own model (haiku), and the answer says that, not "the default".
    vi.mocked(createProjectFor).mockResolvedValue({ status: 200, body: { id: 'p-old', restored: true } } as never);
    mainModel.value = 'haiku';
    const offRestored = await prismaCliLifecycle.createProject(alice, { boxId: 'b1', name: 'old', agent: 'claude', model: 'opus' });
    expect(offRestored).toMatchObject({ body: { model: 'haiku', restored: true } });
    expect(offRestored.body).not.toHaveProperty('modelIgnored');
    askModelOn.value = true;
    // Without --model the answer names none, as before.
    expect((await prismaCliLifecycle.createProject(alice, { boxId: 'b1', name: 'old', agent: 'claude' })).body).not.toHaveProperty('model');
  });
});
