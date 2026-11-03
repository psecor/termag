import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Archiving a simple-UI chat parks its box (routes/chats.ts archiveChatFor):
 * a stop, even when the box can hibernate.
 */

const state = { otherProjects: 0 };

const box = { id: 'b1', userId: 'u1', name: 'olive', kind: 'ec2', status: 'ready', hibernationConfigured: true };
const chat = {
  id: 'p1', userId: 'u1', archived: false, instance: box, workstreams: [{ id: 'w1' }],
  workflows: [{ type: 'agent', provider: 'claude-chat', workstream: { id: 'w1', name: 'main' } }],
};

const prisma = {
  project: {
    findFirst: vi.fn(async () => ({ ...chat })),
    count: vi.fn(async () => state.otherProjects),
  },
};

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), sendForProject: vi.fn() }));
vi.mock('../services/agentRuntime', () => ({ ensureAgentSessionsAndLaunch: vi.fn() }));
vi.mock('../services/boxProvisioner', () => ({ isBoxProvisioningConfigured: () => true }));
vi.mock('../services/chatRevoke', () => ({ revokeChats: vi.fn(async () => null) }));
const powerOwnedBox = vi.fn(async (_user: unknown, _id: string, action: string) => ({
  status: 202, body: { ok: true, status: action === 'stop' ? 'stopping' : 'hibernating' },
}));
vi.mock('./instances', () => ({ powerOwnedBox, terminateOwnedBox: vi.fn() }));
vi.mock('./projects', () => ({ archiveOwnedProject: vi.fn(async () => ({ status: 200, body: {} })), ensureDataSessions: vi.fn() }));

const { archiveChatFor } = await import('./chats');

const user = { id: 'u1', unixUsername: 'alice' } as unknown as Express.User;

beforeEach(() => {
  state.otherProjects = 0;
  powerOwnedBox.mockClear();
});

describe('archiveChatFor', () => {
  it('stops a box that can hibernate', async () => {
    expect(await archiveChatFor(user, 'p1')).toEqual({ status: 200, body: { archived: true, box: { action: 'stop', status: 'stopping' } } });
    expect(powerOwnedBox).toHaveBeenCalledWith(user, 'b1', 'stop');
  });

  it("leaves the box alone when the desktop archives, whoever else uses it", async () => {
    expect(await archiveChatFor(user, 'p1', { powerBox: false })).toEqual({ status: 200, body: { archived: true, box: { action: null, reason: 'kept' } } });
    expect(powerOwnedBox).not.toHaveBeenCalled();
  });

  it('leaves a box other projects still use alone', async () => {
    state.otherProjects = 1;
    expect(await archiveChatFor(user, 'p1')).toEqual({
      status: 200, body: { archived: true, box: { action: null, reason: 'other projects still use this box' } },
    });
    expect(powerOwnedBox).not.toHaveBeenCalled();
  });
});
