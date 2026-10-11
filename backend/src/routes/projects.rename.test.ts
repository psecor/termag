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
const ensureAgentSessionsAndLaunch = vi.fn(async () => {});

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn(), requireAuthOrAgentToken: vi.fn() }));
vi.mock('../slack/channels', () => ({ createProjectChannel: vi.fn() }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn() }));
vi.mock('../services/status', () => ({ deleteStatus: vi.fn(), setStatus: vi.fn(), notifyStatusChange: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({
  isAgentConnected: vi.fn(() => true),
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject,
  sendToAgent: vi.fn(),
}));
vi.mock('../services/agentRuntime', () => ({
  ensureAgentSessionsAndLaunch,
  resolveAgentProvider: (p: string) => p,
  stopAgentSessions: vi.fn(),
}));

const { renameOwnedProject } = await import('./projects');
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
});
