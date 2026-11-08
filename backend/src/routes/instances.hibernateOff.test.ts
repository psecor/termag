import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hibernate is off (Park by stopping): the manual
 * hibernate, from the UI, the CLI or the desktop app, answers 409 with a
 * code, and a hibernated box still resumes.
 */

const state = { box: null as Record<string, any> | null };

const prisma = {
  instance: {
    findUnique: vi.fn(async (args: { where: { id: string } }) => (state.box && state.box.id === args.where.id ? { ...state.box } : null)),
  },
};

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/boxProvisioner', () => ({
  provisionBox: vi.fn(), terminateBox: vi.fn(async () => true), isBoxProvisioningConfigured: () => true,
}));
const requestPower = vi.fn(async (_box: unknown, action: string) => (action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'hibernating'));
vi.mock('../services/boxPower', () => ({ requestPower, PowerRequestConflict: class extends Error {} }));
vi.mock('../services/boxLifecycle', () => ({ recentAutoTerminations: vi.fn(), setBoxLifecycle: vi.fn(), lifecycleViewFor: vi.fn() }));
vi.mock('../services/featureFlags', () => ({
  boolVariation: vi.fn(async (_key: string, _user: unknown, fallback: boolean) => fallback),
}));
vi.mock('../services/warmPool', () => ({ poolSpecHashOrNull: vi.fn(async () => null), reconcileWarmPool: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({
  isInstanceAgentConnected: vi.fn(() => true), sendToInstanceAgent: vi.fn(), connectedInstanceIds: vi.fn(() => []),
}));
vi.mock('../services/warmPoolClaim', () => ({
  claimWarmBox: vi.fn(), isNameConflict: () => false, prismaClaimEffects: {},
}));
vi.mock('../services/chatRevoke', () => ({ revokeChats: vi.fn(async () => null) }));
vi.mock('../services/workspaceEvents', () => ({ notifyOnSuccess: vi.fn((r: unknown) => r), notifyWorkspaceChange: vi.fn() }));
vi.mock('../services/productEvents', () => ({ recordProductEvent: vi.fn() }));

const { powerOwnedBox } = await import('./instances');

const user = { id: 'u1', unixUsername: 'alice' } as unknown as Express.User;

function seed(status: string) {
  state.box = {
    id: 'b1', userId: 'u1', name: 'olive', kind: 'ec2', status, ec2InstanceId: 'i-0abc',
    hibernationConfigured: true, autoTerminatedAt: null,
  };
}

beforeEach(() => {
  requestPower.mockClear();
});

describe('manual hibernate', () => {
  it('is refused with a code, and nothing is asked of EC2', async () => {
    seed('ready');
    expect(await powerOwnedBox(user, 'b1', 'hibernate')).toEqual({
      status: 409, body: { error: expect.stringMatching(/^Hibernate is turned off for this box/), code: 'hibernate_off' },
    });
    expect(requestPower).not.toHaveBeenCalled();
  });

  it('still lets a stop through, and a start resume a box already hibernated', async () => {
    seed('ready');
    expect((await powerOwnedBox(user, 'b1', 'stop')).status).toBe(202);
    seed('hibernated');
    expect(await powerOwnedBox(user, 'b1', 'start')).toEqual({ status: 202, body: { ok: true, status: 'starting' } });
  });
});
