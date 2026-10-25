import { beforeEach, describe, expect, it, vi } from 'vitest';

// The desktop's workstreams (POST/DELETE /api/cli/v1/projects/:id/workstreams):
// made with agent claude-chat whatever main runs,
// so the workstream has its tmux pair in the worktree (where a desktop
// thread's status is filed) and nothing interactive in its pane; removed the
// way t3 removes a worktree, keeping the branch.
vi.mock('../db', () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    workstream: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) },
    workflow: { findMany: vi.fn(), create: vi.fn(async () => ({})) },
    automationRun: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock('../services/agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  projectAgentCapabilities: vi.fn(() => []),
  sendForProject: vi.fn(async () => ({})),
}));
vi.mock('../services/agentRuntime', () => ({
  ensureAgentSessionsAndLaunch: vi.fn(async () => 'launched'),
  stopAgentSessions: vi.fn(async () => {}),
  stopAgentPane: vi.fn(async () => {}),
  resolveAgentProvider: (provider: string | null) => provider ?? 'claude',
}));
vi.mock('../services/chatRevoke', () => ({ revokeChats: vi.fn(async () => null) }));
vi.mock('../services/productEvents', () => ({ recordProductEvent: vi.fn() }));
vi.mock('../slack/channels', () => ({ createChannelFor: vi.fn(async () => null), archiveChannel: vi.fn(async () => {}) }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn(), renameNotificationTargets: vi.fn() }));

const { prisma } = await import('../db');
const registry = await import('../services/agentRegistry');
const runtime = await import('../services/agentRuntime');
const { createWorkstreamFor, removeWorkstreamFor } = await import('./workstreams');

const USER = { id: 'u1', unixUsername: 'alice' } as Express.User;
const PROJECT = {
  id: 'p1', userId: 'u1', name: 'sample', kind: 'normal', instanceId: 'box1', setupStatus: 'none', repoUrl: null,
  user: { unixUsername: 'alice' }, instance: { hostHome: '/home/alice', status: 'ready' },
};
const send = vi.mocked(registry.sendForProject);
const launch = vi.mocked(runtime.ensureAgentSessionsAndLaunch);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.project.findFirst).mockResolvedValue(PROJECT as never);
  vi.mocked(prisma.workstream.findUnique).mockImplementation((async ({ where }: { where: { projectId_name: { name: string } } }) =>
    where.projectId_name.name === 'main' ? { id: 'w-main', name: 'main' } : null) as never);
  vi.mocked(prisma.workstream.create).mockImplementation((async ({ data }: { data: { name: string; branch: string } }) => ({ id: 'w1', ...data })) as never);
  // main runs an interactive Claude in its pane and has a data pair.
  vi.mocked(prisma.workflow.findMany).mockResolvedValue([
    { type: 'agent', provider: 'claude' }, { type: 'data', provider: null },
  ] as never);
});

describe('a workstream the desktop makes', () => {
  it('runs claude-chat in its agent workflow, whatever main runs, and keeps main\'s other workflows', async () => {
    const got = await createWorkstreamFor(USER, 'p1', { name: 't3-0a1b2c3d', baseRef: 'main', provider: 'claude-chat' });
    expect(got.status).toBe(201);
    expect(send).toHaveBeenCalledWith({ userId: 'u1', instanceId: 'box1' }, 'git-worktree-add',
      expect.objectContaining({ worktreeName: 't3-0a1b2c3d', branch: 't3-0a1b2c3d', baseRef: 'main' }), 10_000);
    expect(vi.mocked(prisma.workflow.create).mock.calls.map(([arg]) => arg.data)).toEqual([
      { projectId: 'p1', workstreamId: 'w1', type: 'agent', provider: 'claude-chat', backend: null, model: null },
      { projectId: 'p1', workstreamId: 'w1', type: 'data', provider: null, backend: null, model: null },
    ]);
    // The pair is started in the worktree: claude-chat creates the sessions and types nothing.
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0]).toMatchObject({ provider: 'claude-chat', workstream: 't3-0a1b2c3d', projectName: 'sample' });
  });

  it('gets an agent workflow even when main has none', async () => {
    vi.mocked(prisma.workflow.findMany).mockResolvedValue([] as never);
    await createWorkstreamFor(USER, 'p1', { name: 'fix', provider: 'claude-chat' });
    expect(vi.mocked(prisma.workflow.create).mock.calls.map(([arg]) => arg.data)).toEqual([
      { projectId: 'p1', workstreamId: 'w1', type: 'agent', provider: 'claude-chat', backend: null, model: null },
    ]);
    expect(launch.mock.calls[0][0]).toMatchObject({ provider: 'claude-chat', workstream: 'fix' });
  });

  it('is removed keeping its branch when asked, as t3 removes a worktree', async () => {
    vi.mocked(prisma.workstream.findFirst).mockResolvedValue({
      id: 'w1', name: 't3-0a1b2c3d', branch: 't3-0a1b2c3d', slackChannelId: null,
      project: PROJECT, workflows: [{ type: 'agent', provider: 'claude-chat' }],
    } as never);
    expect((await removeWorkstreamFor(USER, 'p1', 'w1', { force: true, keepBranch: true })).status).toBe(200);
    expect(send).toHaveBeenCalledWith({ userId: 'u1', instanceId: 'box1' }, 'git-worktree-remove',
      { projectDir: '/home/alice/termag/projects/sample', worktreeName: 't3-0a1b2c3d', branch: undefined, force: true });
    expect(prisma.workstream.delete).toHaveBeenCalledWith({ where: { id: 'w1' } });

    send.mockClear();
    await removeWorkstreamFor(USER, 'p1', 'w1', { force: true });
    expect(send).toHaveBeenCalledWith(expect.anything(), 'git-worktree-remove', expect.objectContaining({ branch: 't3-0a1b2c3d' }));
  });
});
