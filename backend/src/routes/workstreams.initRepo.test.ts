import { beforeEach, describe, expect, it, vi } from 'vitest';

// createWorkstreamFor's plain branch-off: whether the agent may give the
// project its first commit before `worktree add` (agent/git-repo.js) follows
// repoUrl, since a pane checkout runs with setupStatus already none.
vi.mock('../db', () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    workstream: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(async () => ({})) },
    workflow: { findMany: vi.fn(async () => []), create: vi.fn() },
  },
}));
vi.mock('../services/agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  projectAgentCapabilities: vi.fn(() => []),
  sendForProject: vi.fn(),
}));
vi.mock('../slack/channels', () => ({ createChannelFor: vi.fn(async () => null), archiveChannel: vi.fn() }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn(), renameNotificationTargets: vi.fn() }));

const { prisma } = await import('../db');
const registry = await import('../services/agentRegistry');
const { createWorkstreamFor, CHECKOUT_NOT_LANDED } = await import('./workstreams');

const USER = { id: 'u1', unixUsername: 'psecor' } as Express.User;
const PROJECT = {
  id: 'p1', userId: 'u1', name: 'termag', kind: 'normal', instanceId: 'box1', setupStatus: 'none', repoUrl: null,
  user: { unixUsername: 'psecor' }, instance: { hostHome: '/home/psecor', status: 'ready' },
};
const send = vi.mocked(registry.sendForProject);
const create = vi.mocked(prisma.workstream.create);

function withProject(over: Record<string, unknown>) {
  vi.mocked(prisma.project.findFirst).mockResolvedValue({ ...PROJECT, ...over } as never);
}

function worktreeAddPayload() {
  return send.mock.calls.find(c => c[1] === 'git-worktree-add')?.[2] as { initRepo?: boolean } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  withProject({});
  vi.mocked(prisma.workstream.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.workstream.findMany).mockResolvedValue([]);
  create.mockImplementation((async ({ data }: { data: { name: string; branch: string } }) => ({ id: 'w1', ...data })) as never);
  send.mockResolvedValue({ ok: true, path: '/x' });
});

describe('createWorkstreamFor ask-thread names', () => {
  it('refuses the ask-<thread id> shape for a person, before touching prisma', async () => {
    const got = await createWorkstreamFor(USER, 'p1', { name: 'ask-cmvpvr0by19t1ex4aevd9iv3e' });
    expect(got.status).toBe(400);
    expect((got.body as { error: string }).error).toMatch(/ask threads/);
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });

  it('still lets a human take a name that is not quite the shape', async () => {
    const got = await createWorkstreamFor(USER, 'p1', { name: 'ask-Fix' });
    expect(got.status).toBe(201);
  });
});

describe('createWorkstreamFor first-commit backstop', () => {
  it('asks for it on a project with no repository to check out', async () => {
    const got = await createWorkstreamFor(USER, 'p1', { name: 'ws1' });
    expect(got.status).toBe(201);
    expect(worktreeAddPayload()?.initRepo).toBe(true);
  });

  it('never asks for it while a repository is still to be checked out', async () => {
    withProject({ repoUrl: 'https://github.com/example-org/termag.git' });
    const got = await createWorkstreamFor(USER, 'p1', { name: 'ws1' });
    expect(got.status).toBe(201);
    expect(worktreeAddPayload()?.initRepo).toBe(false);
  });

  it('says the checkout has not landed instead of passing on git\'s unborn-HEAD error', async () => {
    withProject({ repoUrl: 'https://github.com/example-org/termag.git' });
    send.mockRejectedValue(new Error('Command failed: git worktree add\nfatal: invalid reference: HEAD'));
    const got = await createWorkstreamFor(USER, 'p1', { name: 'ws1' });
    expect(got.status).toBe(409);
    expect((got.body as { error: string }).error).toBe(CHECKOUT_NOT_LANDED);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('createWorkstreamFor branch', () => {
  it('refuses a new branch git would not create, before anything is recorded', async () => {
    for (const branch of ['team/', 'a//b', 'a/.b']) {
      const got = await createWorkstreamFor(USER, 'p1', { name: 'ws1', branch });
      expect(got.status, branch).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('adds the worktree under its name on a branch that holds slashes', async () => {
    const got = await createWorkstreamFor(USER, 'p1', { name: 'ws1', branch: 'me/ABC-1/x' });
    expect(got.status).toBe(201);
    expect(send.mock.calls.find(c => c[1] === 'git-worktree-add')?.[2]).toMatchObject({ worktreeName: 'ws1', branch: 'me/ABC-1/x' });
  });

  it('refuses a name another workstream holds, before the box is asked', async () => {
    vi.mocked(prisma.workstream.findMany).mockResolvedValue([{ name: 'ws1' }] as never);
    const got = await createWorkstreamFor(USER, 'p1', { name: 'ws1', branch: 'me/ABC-1/x' });
    expect(got.status).toBe(409);
    expect((got.body as { error: string }).error).toBe('A workstream with that name already exists');
    expect(send).not.toHaveBeenCalled();
  });

  it('says the name is taken when one workstream has the name and another the branch', async () => {
    vi.mocked(prisma.workstream.findMany).mockResolvedValue([{ name: 'beta' }, { name: 'alpha' }] as never);
    const got = await createWorkstreamFor(USER, 'p1', { name: 'alpha', branch: 'me/beta' });
    expect(got.status).toBe(409);
    expect((got.body as { error: string }).error).toBe('A workstream with that name already exists');
  });

  it('refuses a branch another workstream holds, before the box is asked', async () => {
    vi.mocked(prisma.workstream.findMany).mockResolvedValue([{ name: 'main' }] as never);
    const got = await createWorkstreamFor(USER, 'p1', { name: 'ws1', branch: 'master' });
    expect(got.status).toBe(409);
    expect(vi.mocked(prisma.workstream.findMany).mock.calls[0]?.[0]).toMatchObject({ where: { projectId: 'p1', OR: [{ name: 'ws1' }, { branch: 'master' }] } });
    expect((got.body as { error: string }).error).toMatch(/branch master/);
    expect(send).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
