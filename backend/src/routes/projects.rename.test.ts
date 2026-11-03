import { beforeEach, describe, expect, it, vi } from 'vitest';

const project = {
  id: 'p1', name: 'old', kind: 'standard', instanceId: 'i1', userId: 'u1',
  instance: { hostHome: '/home/alice', status: 'ready' },
  workflows: [{ type: 'agent', provider: 'codex', workstream: { name: 'main' } }],
};
const prisma = {
  project: {
    findFirst: vi.fn(),
    findUnique: vi.fn(async () => ({ ...project, name: 'new' })),
    update: vi.fn(async () => ({})),
  },
};
const sendForProject = vi.fn();
let capabilities: string[] = [];
const ensureAgentSessionsAndLaunch = vi.fn(async () => {});

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn(), requireAuthOrAgentToken: vi.fn() }));
vi.mock('../slack/channels', () => ({ createProjectChannel: vi.fn() }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn() }));
const STOPPED_AT = new Date('2026-10-13T05:00:00Z');
const setStatus = vi.fn();
const moveStatus = vi.fn(() => true);
const live = new Map<string, unknown>();
vi.mock('../services/status', () => ({
  setStatus, moveStatus, notifyStatusChange: vi.fn(), getAllStatuses: () => live,
}));
vi.mock('../services/agentRegistry', () => ({
  isAgentConnected: vi.fn(() => true),
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject,
  sendToAgent: vi.fn(),
  projectAgentCapabilities: () => capabilities,
}));
vi.mock('../services/agentRuntime', () => ({
  ensureAgentSessionsAndLaunch,
  resolveAgentProvider: (p: string) => p,
  stopAgentSessions: vi.fn(),
}));

const { renameOwnedProject } = await import('./projects');
const { setWorkspaceChangeCallback } = await import('../services/workspaceEvents');
const user = { id: 'u1', unixUsername: 'alice', defaultAgentProvider: 'claude' } as unknown as Express.User;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.project.findFirst.mockImplementation(async (args: { where: { name?: string } }) => (args.where.name ? null : project));
});

describe('renameOwnedProject on a box with a Codex agent', () => {
  it('brings the stopped Codex bridge back under the old name when the box refuses the rename', async () => {
    sendForProject.mockImplementation(async (_host: unknown, command: string) => {
      if (command === 'project-rename') throw new Error('Unknown command: project-rename');
      return {};
    });
    const result = await renameOwnedProject(user, 'p1', 'new');
    expect(result).toMatchObject({ status: 409, body: { code: 'agent_outdated' } });
    expect(sendForProject).toHaveBeenCalledWith(expect.anything(), 'codex-session-stop', { sessionName: 'alice-old-agent' });
    expect(ensureAgentSessionsAndLaunch).toHaveBeenCalledWith(expect.objectContaining({ projectName: 'old', provider: 'codex' }));
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('restarts it under the new name after a rename', async () => {
    sendForProject.mockResolvedValue({});
    const result = await renameOwnedProject(user, 'p1', 'new');
    expect(result.status).toBe(200);
    expect(ensureAgentSessionsAndLaunch).toHaveBeenCalledTimes(1);
    expect(ensureAgentSessionsAndLaunch).toHaveBeenCalledWith(expect.objectContaining({ projectName: 'new', provider: 'codex' }));
  });

  it('moves a live session with its status and meta, as a workstream rename does', async () => {
    sendForProject.mockResolvedValue({});
    await renameOwnedProject(user, 'p1', 'new');
    expect(moveStatus).toHaveBeenCalledWith('alice-old-agent', 'alice-new-agent', 'i1');
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('seeds idle when nothing live moved, keeping an exited agent\'s stop time', async () => {
    sendForProject.mockResolvedValue({});
    moveStatus.mockReturnValueOnce(false);
    live.set('i1|alice-old-agent', { status: 'not_running', updatedAt: new Date(), stoppedAt: STOPPED_AT });
    await renameOwnedProject(user, 'p1', 'new');
    expect(setStatus).toHaveBeenCalledWith('alice-new-agent', 'idle', { instanceId: 'i1', stoppedAt: STOPPED_AT });
    live.clear();
  });
});

describe('renameOwnedProject on a multi-repo project', () => {
  const workspace = {
    ...project,
    layout: 'workspace',
    repos: [
      { name: 'shop-web', url: 'https://github.com/o/shop-web', position: 0, setupStatus: 'ready' },
      { name: 'shop-api', url: 'https://github.com/o/shop-api', position: 1, setupStatus: 'ready' },
    ],
    workstreams: [{ name: 'main', branch: 'main' }, { name: 'fix', branch: 'e2e/fix' }],
  };
  const asWorkspace = (row: object) => prisma.project.findFirst.mockImplementation(
    async (args: { where: { name?: string } }) => (args.where.name ? null : row));

  it('refuses on a box whose agent cannot repair the worktrees, before touching anything', async () => {
    asWorkspace(workspace);
    capabilities = ['workspace-clone-v1'];
    const result = await renameOwnedProject(user, 'p1', 'new');
    expect(result).toMatchObject({ status: 409, body: { code: 'agent_outdated' } });
    expect(sendForProject).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('refuses while a repository is still cloning into the folder', async () => {
    asWorkspace({ ...workspace, repos: [workspace.repos[0], { ...workspace.repos[1], setupStatus: 'cloning' }] });
    capabilities = ['workspace-clone-v1', 'workspace-rename-v1'];
    const result = await renameOwnedProject(user, 'p1', 'new');
    expect(result).toMatchObject({ status: 409, body: { error: 'shop-api is still being cloned; rename once it is done' } });
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('has the box repair every repository and rewrite the guides under the new name', async () => {
    asWorkspace(workspace);
    capabilities = ['workspace-clone-v1', 'workspace-rename-v1'];
    sendForProject.mockResolvedValue({});
    const result = await renameOwnedProject(user, 'p1', 'new');
    expect(result.status).toBe(200);
    const call = sendForProject.mock.calls.find(c => c[1] === 'project-rename')!;
    const plan = call[2] as { fromDir: string; toDir: string; workspace: { repos: string[]; guides: Array<{ dir: string; content: string }> } };
    expect(plan.fromDir).toBe('/home/alice/termag/projects/old');
    expect(plan.toDir).toBe('/home/alice/termag/projects/new');
    expect(plan.workspace.repos).toEqual(['shop-web', 'shop-api']);
    expect(plan.workspace.guides.map(g => [g.dir, g.content.split('\n')[1]])).toEqual([
      ['/home/alice/termag/projects/new', '# new'],
      ['/home/alice/termag/projects/new/.worktrees/fix', '# new / fix'],
    ]);
    expect(call[3]).toBe(60_000);
    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { name: 'new' } });
  });

  it('keeps the old name when the box could not repair a worktree and put everything back', async () => {
    asWorkspace(workspace);
    capabilities = ['workspace-clone-v1', 'workspace-rename-v1'];
    sendForProject.mockImplementation(async (_host: unknown, command: string) => {
      if (command === 'project-rename') throw new Error('git worktree repair failed (shop-api: error: x); nothing was renamed');
      return {};
    });
    const result = await renameOwnedProject(user, 'p1', 'new');
    expect(result).toMatchObject({ status: 502, body: { error: expect.stringMatching(/nothing was renamed/) } });
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});

describe('renameOwnedProject and the owner\'s tabs', () => {
  it('tells the owner the project list changed after a rename, and not after a refusal', async () => {
    const changed = vi.fn();
    setWorkspaceChangeCallback(changed);
    try {
      sendForProject.mockImplementation(async (_host: unknown, command: string) => {
        if (command === 'project-rename') throw new Error('Unknown command: project-rename');
        return {};
      });
      expect((await renameOwnedProject(user, 'p1', 'new')).status).toBe(409);
      expect(changed).not.toHaveBeenCalled();
      sendForProject.mockReset();
      sendForProject.mockResolvedValue({});
      expect((await renameOwnedProject(user, 'p1', 'new')).status).toBe(200);
      expect(changed.mock.calls).toEqual([['u1', 'projects']]);
    } finally {
      setWorkspaceChangeCallback(null);
    }
  });
});
