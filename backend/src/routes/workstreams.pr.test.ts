import { beforeEach, describe, expect, it, vi } from 'vitest';

// createWorkstreamFor's pull-request path (`pr`): the worktree comes from the
// agent's git-worktree-add-pr, which may adopt an agent-made worktree.
vi.mock('../db', () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    workstream: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(async () => ({})) },
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

const input = { name: 'termag-pr-defer', branch: 'feat/pr-defer', pr: { number: 359, sameRepo: true, headOid: 'b'.repeat(40) } };

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
