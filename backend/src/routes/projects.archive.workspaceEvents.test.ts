import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceChangeCallback } from '../services/workspaceEvents';

/**
 * Archiving a project tells the owner's tabs (services/workspaceEvents.ts),
 * whichever caller asked: the cookie route, the CLI, the simple UI or a spawn.
 */

const project = {
  id: 'p1', name: 'askproj', kind: 'standard', instanceId: 'i1', userId: 'u1',
  workflows: [{ type: 'agent', provider: 'claude', workstream: { name: 'main' } }],
  workstreams: [{ id: 'w1' }],
};
const prisma = {
  project: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
  workflow: { deleteMany: vi.fn(async () => ({ count: 1 })) },
};
const revokeChats = vi.fn(async (): Promise<string | null> => null);

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn(), requireAuthOrAgentToken: vi.fn() }));
vi.mock('../slack/channels', () => ({ createProjectChannel: vi.fn() }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn() }));
vi.mock('../services/status', () => ({
  setStatus: vi.fn(), moveStatus: vi.fn(), notifyStatusChange: vi.fn(), getAllStatuses: () => new Map(),
}));
vi.mock('../services/agentRegistry', () => ({
  isAgentConnected: vi.fn(() => true),
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject: vi.fn(async () => ({})),
  sendToAgent: vi.fn(),
}));
vi.mock('../services/agentRuntime', () => ({
  ensureAgentSessionsAndLaunch: vi.fn(),
  resolveAgentProvider: (p: string) => p,
  stopAgentSessions: vi.fn(async () => {}),
}));
vi.mock('../services/chatRevoke', () => ({ revokeChats }));

const { archiveOwnedProject } = await import('./projects');
const user = { id: 'u1', unixUsername: 'alice', defaultAgentProvider: 'claude' } as unknown as Express.User;
const changed = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  prisma.project.findFirst.mockResolvedValue(project);
  setWorkspaceChangeCallback(changed);
});
afterEach(() => setWorkspaceChangeCallback(null));

describe('archiveOwnedProject', () => {
  it('tells the owner the project list changed', async () => {
    expect((await archiveOwnedProject(user, 'p1')).status).toBe(200);
    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { archived: true } });
    expect(changed.mock.calls).toEqual([['u1', 'projects']]);
  });

  it('says nothing when the project is missing or a chat turn blocks the archive', async () => {
    prisma.project.findFirst.mockResolvedValueOnce(null);
    expect((await archiveOwnedProject(user, 'p1')).status).toBe(404);
    revokeChats.mockResolvedValueOnce('A chat turn is still running');
    expect((await archiveOwnedProject(user, 'p1')).status).toBe(409);
    expect(changed).not.toHaveBeenCalled();
  });
});
