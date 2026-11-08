import { beforeEach, describe, expect, it, vi } from 'vitest';

// createWorkstreamFor's pull-request path (`pr`): the worktree comes from the
// agent's git-worktree-add-pr, which may adopt an agent-made worktree.
vi.mock('../db', () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    projectRepo: { findMany: vi.fn(async () => []) },
    workstream: { findUnique: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn(), update: vi.fn(async () => ({})) },
    workflow: { findMany: vi.fn(async () => []), create: vi.fn() },
  },
}));
vi.mock('../services/agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  projectAgentCapabilities: vi.fn(() => ['worktree-pr-v1']),
  sendForProject: vi.fn(),
}));
vi.mock('../slack/channels', () => ({ createChannelFor: vi.fn(async () => null), archiveChannel: vi.fn() }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn(), renameNotificationTargets: vi.fn() }));

const { prisma } = await import('../db');
const registry = await import('../services/agentRegistry');
const { createWorkstreamFor, isPrBranchName } = await import('./workstreams');

const USER = { id: 'u1', unixUsername: 'psecor' } as Express.User;
const PROJECT = {
  id: 'p1', userId: 'u1', name: 'termag', kind: 'normal', instanceId: 'box1', setupStatus: 'none',
  user: { unixUsername: 'psecor' }, instance: { hostHome: '/home/psecor', status: 'ready' },
};
const send = vi.mocked(registry.sendForProject);
const findUnique = vi.mocked(prisma.workstream.findUnique);
const create = vi.mocked(prisma.workstream.create);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.project.findFirst).mockResolvedValue(PROJECT as never);
  findUnique.mockResolvedValue(null);
  create.mockImplementation((async ({ data }: { data: { name: string; branch: string } }) => ({ id: 'w1', ...data })) as never);
  vi.mocked(registry.projectAgentCapabilities).mockReturnValue(['worktree-pr-v1']);
});

const input = { name: 'termag-pr-defer', branch: 'feat/pr-defer', pr: { repo: 'example-org/termag', number: 359, sameRepo: true, headOid: 'b'.repeat(40) } };

describe('createWorkstreamFor with a pull request', () => {
  it('checks the PR\'s branch out through git-worktree-add-pr', async () => {
    send.mockResolvedValue({ ok: true, path: '/x' });
    const got = await createWorkstreamFor(USER, 'p1', input);
    expect(got.status).toBe(201);
    expect(send).toHaveBeenCalledWith({ userId: 'u1', instanceId: 'box1' }, 'git-worktree-add-pr',
      expect.objectContaining({ worktreeName: 'termag-pr-defer', branch: 'feat/pr-defer', number: 359, sameRepo: true, headOid: 'b'.repeat(40) }), 600_000);
    expect(send.mock.calls.some(c => c[1] === 'git-worktree-add')).toBe(false);
    expect(create).toHaveBeenCalledWith({ data: { projectId: 'p1', name: 'termag-pr-defer', branch: 'feat/pr-defer' } });
  });
  it('takes an adopted worktree\'s name', async () => {
    send.mockResolvedValue({ ok: true, path: '/x', adopted: 'termag-worktree-pr-pills' });
    const got = await createWorkstreamFor(USER, 'p1', input);
    expect(got.status).toBe(201);
    expect((got.body as { name: string }).name).toBe('termag-worktree-pr-pills');
  });
  it('refuses when the adopted worktree is already a workstream', async () => {
    send.mockResolvedValue({ ok: true, path: '/x', adopted: 'taken' });
    findUnique.mockImplementation((async ({ where }: { where: { projectId_name: { name: string } } }) => (where.projectId_name.name === 'taken' ? { id: 'w0' } : null)) as never);
    const got = await createWorkstreamFor(USER, 'p1', input);
    expect(got.status).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });
  it('refuses an adopted name reserved for ask threads', async () => {
    send.mockResolvedValue({ ok: true, path: '/x', adopted: 'ask-cmvpvr0by19t1ex4aevd9iv3e' });
    const got = await createWorkstreamFor(USER, 'p1', input);
    expect(got.status).toBe(409);
    expect((got.body as { error: string }).error).toMatch(/ask threads/);
    expect(create).not.toHaveBeenCalled();
  });
  it('asks for an agent update instead of calling an agent that lacks the RPC', async () => {
    vi.mocked(registry.projectAgentCapabilities).mockReturnValue([]);
    const got = await createWorkstreamFor(USER, 'p1', input);
    expect(got.status).toBe(409);
    expect((got.body as { error: string }).error).toMatch(/update termag on the box/);
    expect(send).not.toHaveBeenCalled();
  });
  it('never removes an adopted worktree, or the PR\'s branch, when the row cannot be written', async () => {
    send.mockResolvedValue({ ok: true, path: '/x', adopted: 'agent-made' });
    create.mockRejectedValueOnce(new Error('race'));
    await expect(createWorkstreamFor(USER, 'p1', input)).rejects.toThrow('race');
    expect(send.mock.calls.some(c => c[1] === 'git-worktree-remove')).toBe(false);

    send.mockReset();
    send.mockResolvedValue({ ok: true, path: '/x' });
    create.mockRejectedValueOnce(new Error('race'));
    await expect(createWorkstreamFor(USER, 'p1', input)).rejects.toThrow('race');
    const remove = send.mock.calls.find(c => c[1] === 'git-worktree-remove');
    expect(remove?.[2]).toMatchObject({ worktreeName: 'termag-pr-defer', branch: undefined });
  });
  it('reports a failed checkout', async () => {
    send.mockRejectedValue(new Error('feat/pr-defer is already checked out at /home/psecor/termag/projects/termag'));
    const got = await createWorkstreamFor(USER, 'p1', input);
    expect(got).toMatchObject({ status: 500, body: { error: expect.stringContaining('already checked out') } });
  });
});

describe('the project\'s repository', () => {
  const origin = (url: string | null) => send.mockImplementation((async (_h: unknown, type: string) => (
    type === 'git-branch-state' ? { origin: url } : { ok: true, path: '/x' })) as never);

  it('refuses a project whose origin is another repository, before any fetch', async () => {
    origin('https://github.com/example-org/termag.git');
    const got = await createWorkstreamFor(USER, 'p1', { ...input, pr: { ...input.pr, repo: 'example-org/terraform', number: 28576 } });
    expect(got.status).toBe(409);
    expect((got.body as { error: string }).error).toBe(
      'termag is a checkout of example-org/termag, not example-org/terraform. Make a project for example-org/terraform (or un-archive one), then try again.');
    expect(send.mock.calls.some(c => c[1] === 'git-worktree-add-pr')).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
  it('checks out when the origin is the PR\'s repository, whatever its case or form', async () => {
    origin('git@github.com:Example-Org/Termag.git');
    const got = await createWorkstreamFor(USER, 'p1', input);
    expect(got.status).toBe(201);
    expect(send).toHaveBeenCalledWith(expect.anything(), 'git-branch-state', { cwd: '/home/psecor/termag/projects/termag' }, 10_000);
  });
  it('leaves it to the fetch when the box cannot say', async () => {
    origin(null);
    expect((await createWorkstreamFor(USER, 'p1', input)).status).toBe(201);
    send.mockImplementation((async (_h: unknown, type: string) => {
      if (type === 'git-branch-state') throw new Error('Unknown command');
      return { ok: true, path: '/x' };
    }) as never);
    expect((await createWorkstreamFor(USER, 'p1', input)).status).toBe(201);
  });
});

describe('a multi-repo project (docs/multi-repo-projects.md)', () => {
  const SHOP = { ...PROJECT, name: 'shop', layout: 'workspace', setupStatus: 'ready' };
  const REPOS = [
    { name: 'shop-web', url: 'https://github.com/acme/shop-web.git', position: 0, setupStatus: 'ready' },
    { name: 'shop-api', url: 'https://github.com/acme/shop-api.git', position: 1, setupStatus: 'ready' },
  ];
  const ROOT = '/home/psecor/termag/projects/shop';
  const apiPr = { ...input, name: 'shop-api-pr7', branch: 'feat/x', pr: { repo: 'acme/shop-api', number: 7, sameRepo: true, headOid: 'c'.repeat(40) } };
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(SHOP as never);
    vi.mocked(prisma.projectRepo.findMany).mockResolvedValue(REPOS as never);
    vi.mocked(registry.projectAgentCapabilities).mockReturnValue(['worktree-pr-v1', 'worktree-pr-path-v1', 'workspace-clone-v1']);
    send.mockResolvedValue({ ok: true });
  });

  it('checks the PR out in its repository\'s worktree, the others on its branch', async () => {
    const got = await createWorkstreamFor(USER, 'p1', apiPr);
    expect(got.status).toBe(201);
    const adds = send.mock.calls.filter(c => c[1] === 'git-worktree-add-pr' || c[1] === 'git-worktree-add').map(c => [c[1], (c[2] as { projectDir: string }).projectDir, (c[2] as { worktreePath: string }).worktreePath, (c[2] as { branch: string }).branch]);
    expect(adds).toEqual([
      ['git-worktree-add-pr', `${ROOT}/shop-api`, `${ROOT}/.worktrees/shop-api-pr7/shop-api`, 'feat/x'],
      ['git-worktree-add', `${ROOT}/shop-web`, `${ROOT}/.worktrees/shop-api-pr7/shop-web`, 'feat/x'],
    ]);
    expect(send.mock.calls.some(c => c[1] === 'git-branch-state')).toBe(false);
    expect(create).toHaveBeenCalledWith({ data: { projectId: 'p1', name: 'shop-api-pr7', branch: 'feat/x' } });
  });
  it('refuses a PR of a repository the project does not hold, before the box is asked anything', async () => {
    const got = await createWorkstreamFor(USER, 'p1', { ...apiPr, pr: { ...apiPr.pr, repo: 'acme/docs' } });
    expect(got).toEqual({ status: 409, body: { error: 'shop holds acme/shop-web, acme/shop-api, not acme/docs. Make a project for acme/docs (or un-archive one), then try again.' } });
    expect(send).not.toHaveBeenCalled();
  });
  it('asks for an agent update when the box cannot put a PR worktree at a path', async () => {
    vi.mocked(registry.projectAgentCapabilities).mockReturnValue(['worktree-pr-v1', 'workspace-clone-v1']);
    const got = await createWorkstreamFor(USER, 'p1', apiPr);
    expect(got.status).toBe(409);
    expect((got.body as { error: string }).error).toMatch(/update termag on the box/);
    expect(send).not.toHaveBeenCalled();
  });
  it('reports a failed checkout as the PR\'s, naming the repository', async () => {
    send.mockImplementation((async (_h: unknown, type: string) => {
      if (type === 'git-worktree-add-pr') throw new Error("origin's pull/7 is 00000000, not the PR's head cccccccc");
      return { ok: true };
    }) as never);
    const got = await createWorkstreamFor(USER, 'p1', apiPr);
    expect(got).toEqual({ status: 500, body: { error: "Could not check out the pull request: shop-api: origin's pull/7 is 00000000, not the PR's head cccccccc" } });
    expect(create).not.toHaveBeenCalled();
  });
  it('keeps the PR\'s branch when the row cannot be written, and drops the branches it made', async () => {
    create.mockRejectedValueOnce(new Error('race'));
    await expect(createWorkstreamFor(USER, 'p1', apiPr)).rejects.toThrow('race');
    const removes = send.mock.calls.filter(c => c[1] === 'git-worktree-remove').map(c => [(c[2] as { projectDir: string }).projectDir, (c[2] as { branch?: string }).branch]);
    expect(removes).toEqual([[`${ROOT}/shop-api`, undefined], [`${ROOT}/shop-web`, 'feat/x']]);
  });
});

describe('a PR branch name', () => {
  it('is left to the box\'s git check-ref-format, past the backend\'s narrow allowlist (Bugbot)', async () => {
    send.mockResolvedValue({ ok: true, path: '/x' });
    const got = await createWorkstreamFor(USER, 'p1', { ...input, branch: 'psecor/fix@home+ñ' });
    expect(got.status).toBe(201);
    expect(send).toHaveBeenCalledWith(expect.anything(), 'git-worktree-add-pr', expect.objectContaining({ branch: 'psecor/fix@home+ñ' }), 600_000);
  });
  it('still refuses an option, control characters or nothing', () => {
    expect(isPrBranchName('-x')).toBe(false);
    expect(isPrBranchName('a\nb')).toBe(false);
    expect(isPrBranchName('')).toBe(false);
    expect(isPrBranchName('feat/x')).toBe(true);
  });
});
