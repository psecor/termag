import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceChangeCallback } from '../services/workspaceEvents';

/**
 * Terminating or powering a box tells the owner's tabs (services/workspaceEvents.ts),
 * whichever caller asked: the cookie route, the CLI, the simple UI or a sweep.
 */

type Box = {
  id: string; userId: string; name: string; kind: string; status: string;
  ec2InstanceId: string | null; autoTerminatedAt: Date | null; hibernationConfigured: boolean;
  projects: { id: string; name: string; workstreams: { id: string }[] }[];
};

const state = { box: null as Box | null };

const prisma = {
  instance: {
    findFirst: vi.fn(async (args: { where: { id: string; userId: string } }) =>
      state.box && state.box.id === args.where.id && state.box.userId === args.where.userId ? state.box : null),
    findUnique: vi.fn(async (args: { where: { id: string } }) => (state.box?.id === args.where.id ? state.box : null)),
    update: vi.fn(async () => ({})),
  },
  project: { updateMany: vi.fn(async () => ({ count: 0 })) },
  agentToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  $transaction: vi.fn(async () => []),
};

const requestPower = vi.fn(async (_box: unknown, action: string) => (action === 'start' ? 'starting' : 'stopping'));
class PowerRequestConflict extends Error {}

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/boxProvisioner', () => ({
  provisionBox: vi.fn(), terminateBox: vi.fn(async () => true), isBoxProvisioningConfigured: () => true,
}));
vi.mock('../services/boxPower', () => ({ requestPower, PowerRequestConflict }));
vi.mock('../services/boxLifecycle', () => ({ recentAutoTerminations: vi.fn(), setBoxLifecycle: vi.fn() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('../services/warmPool', () => ({ poolSpecHashOrNull: vi.fn(async () => null), reconcileWarmPool: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({
  isInstanceAgentConnected: vi.fn(() => true), sendToInstanceAgent: vi.fn(), connectedInstanceIds: vi.fn(() => []),
}));
vi.mock('../services/warmPoolClaim', () => ({
  claimWarmBox: vi.fn(), isNameConflict: () => false, prismaClaimEffects: {}, WARM_POOL_ENABLED_FLAG: 'warm-pool-enabled',
}));
vi.mock('../services/chatRevoke', () => ({ revokeChats: vi.fn(async () => null) }));

const { powerOwnedBox, terminateOwnedBox } = await import('./instances');

const user = { id: 'u1', unixUsername: 'alice' } as unknown as Express.User;
const changed = vi.fn();

function box(over: Partial<Box> = {}): Box {
  return {
    id: 'b1', userId: 'u1', name: 'askbox', kind: 'ec2', status: 'ready', ec2InstanceId: 'i-0abc',
    autoTerminatedAt: null, hibernationConfigured: false, projects: [], ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.box = box();
  setWorkspaceChangeCallback(changed);
});
afterEach(() => setWorkspaceChangeCallback(null));

describe('terminateOwnedBox', () => {
  it('tells the owner both lists changed, since its projects are archived with it', async () => {
    state.box = box({ projects: [{ id: 'p1', name: 'sample', workstreams: [{ id: 'w1' }] }] });
    const result = await terminateOwnedBox(user, 'b1', true);
    expect(result.status).toBe(200);
    expect(changed.mock.calls).toEqual([['u1', 'boxes'], ['u1', 'projects']]);
  });

  it('says nothing when it asks for confirmation or the box is not the caller\'s', async () => {
    state.box = box({ projects: [{ id: 'p1', name: 'sample', workstreams: [] }] });
    expect((await terminateOwnedBox(user, 'b1', false)).status).toBe(409);
    expect((await terminateOwnedBox({ id: 'u2' } as Express.User, 'b1', true)).status).toBe(404);
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('powerOwnedBox', () => {
  it('tells the owner the box list changed on an accepted stop or start (202)', async () => {
    expect((await powerOwnedBox(user, 'b1', 'stop')).status).toBe(202);
    state.box = box({ status: 'stopped' });
    expect((await powerOwnedBox(user, 'b1', 'start')).status).toBe(202);
    expect(changed.mock.calls).toEqual([['u1', 'boxes'], ['u1', 'boxes']]);
  });

  it('marks every power change as the owner\'s own: a stop or hibernate drops the idle note a reviewer could wake by', async () => {
    requestPower.mockClear();
    expect((await powerOwnedBox(user, 'b1', 'stop')).status).toBe(202);
    expect(requestPower).toHaveBeenLastCalledWith(expect.anything(), 'stop', { markInUse: false, byOwner: true });
    state.box = box({ status: 'stopped' });
    expect((await powerOwnedBox(user, 'b1', 'start')).status).toBe(202);
    expect(requestPower).toHaveBeenLastCalledWith(expect.anything(), 'start', { markInUse: true, byOwner: true });
  });

  it('says nothing when the request is refused or EC2 refuses it', async () => {
    state.box = box({ status: 'stopped' });
    expect((await powerOwnedBox(user, 'b1', 'stop')).status).toBe(409);
    state.box = box();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    requestPower.mockRejectedValueOnce(new Error('throttled'));
    expect((await powerOwnedBox(user, 'b1', 'stop')).status).toBe(502);
    expect(changed).not.toHaveBeenCalled();
  });
});
