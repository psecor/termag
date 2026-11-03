import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Keep running: the owner says they are using a
 * box, so its idle clock restarts and its standing warning goes stale.
 */

const state = { box: null as Record<string, any> | null, writes: [] as Array<{ where: any; data: any }> };

const prisma = {
  instance: {
    findFirst: vi.fn(async (args: { where: { id: string; userId: string } }) =>
      state.box && state.box.id === args.where.id && state.box.userId === args.where.userId ? { ...state.box } : null),
    updateMany: vi.fn(async (args: { where: any; data: any }) => {
      state.writes.push(args);
      if (!state.box || state.box.status !== args.where.status) return { count: 0 };
      Object.assign(state.box, args.data);
      return { count: 1 };
    }),
    findUniqueOrThrow: vi.fn(async () => ({ ...state.box })),
  },
};

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/boxProvisioner', () => ({
  provisionBox: vi.fn(), terminateBox: vi.fn(async () => true), isBoxProvisioningConfigured: () => true,
}));
vi.mock('../services/boxPower', () => ({ requestPower: vi.fn(), PowerRequestConflict: class extends Error {} }));
vi.mock('../services/boxLifecycle', () => ({
  recentAutoTerminations: vi.fn(), setBoxLifecycle: vi.fn(),
  // box-idle-stop-enabled on, with its 2 h window.
  lifecycleViewFor: vi.fn(async (_user: unknown, row: any) =>
    (await import('../services/boxLifecyclePolicy')).lifecycleView(row, 90, { idleStopOn: true, idleStopHours: 2, warnMinutes: 120 })),
}));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('../services/warmPool', () => ({ poolSpecHashOrNull: vi.fn(async () => null), reconcileWarmPool: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({
  isInstanceAgentConnected: vi.fn(() => true), sendToInstanceAgent: vi.fn(), connectedInstanceIds: vi.fn(() => []),
}));
vi.mock('../services/warmPoolClaim', () => ({
  claimWarmBox: vi.fn(), isNameConflict: () => false, prismaClaimEffects: {}, WARM_POOL_ENABLED_FLAG: 'warm-pool-enabled',
}));
vi.mock('../services/chatRevoke', () => ({ revokeChats: vi.fn(async () => null) }));
const changes: string[] = [];
vi.mock('../services/workspaceEvents', () => ({
  notifyOnSuccess: vi.fn(), notifyWorkspaceChange: vi.fn((owner: string, what: string) => { changes.push(`${owner}:${what}`); }),
}));
const events: Array<{ name: string; detail: unknown }> = [];
vi.mock('../services/productEvents', () => ({ recordProductEvent: (name: string, _ctx: unknown, detail: unknown) => { events.push({ name, detail }); } }));

const { keepOwnedBoxRunning } = await import('./instances');

const user = { id: 'u1', unixUsername: 'alice' } as unknown as Express.User;
const HOUR = 60 * 60 * 1000;

function seed(over: Record<string, any> = {}) {
  state.box = {
    id: 'b1', userId: 'u1', name: 'olive', kind: 'ec2', status: 'ready', ec2InstanceId: 'i-0abc',
    hibernationConfigured: false, rehibernatePending: false, idleHibernateHours: null,
    lastActivityAt: new Date(Date.now() - 70 * HOUR), readyAt: null, createdAt: new Date(Date.now() - 100 * HOUR),
    idleWarnedAt: new Date(Date.now() - HOUR), idleParkAt: new Date(Date.now() + HOUR), autoParkedAt: null,
    parkedAt: null, lifecycleNote: null, hibernatedTerminateDays: null, unsavedWork: null, unsavedWorkCheckedAt: null,
    ...over,
  };
}

beforeEach(() => {
  state.writes = [];
  events.length = 0;
  changes.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('keepOwnedBoxRunning', () => {
  it("restarts the owner's box's idle clock, so its warning goes stale and it waits a full limit", async () => {
    seed();
    const before = Date.now();
    const result = await keepOwnedBoxRunning(user, 'b1', 'cli');
    expect(result.status).toBe(200);
    expect(state.writes[0].where).toEqual({ id: 'b1', status: 'ready' });
    expect(state.box!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before);
    const lifecycle = (result.body as { lifecycle: { warnedAt: string | null; parkAt: string; idleLimitHours: number } }).lifecycle;
    expect(lifecycle.warnedAt).toBeNull();
    expect(lifecycle.idleLimitHours).toBe(2);
    expect(new Date(lifecycle.parkAt).getTime()).toBeGreaterThanOrEqual(before + 2 * HOUR);
    expect(events).toEqual([{ name: 'box.kept_running', detail: { via: 'cli' } }]);
    // The owner's open tabs reload the box list, so the countdown goes.
    expect(changes).toEqual(['u1:boxes']);
  });

  it("answers 404 for another user's box and 409 for a box that isn't running", async () => {
    seed({ userId: 'u2' });
    expect((await keepOwnedBoxRunning(user, 'b1', 'ui')).status).toBe(404);
    seed({ status: 'stopped' });
    const stopped = await keepOwnedBoxRunning(user, 'b1', 'ui');
    expect(stopped).toMatchObject({ status: 409, body: { error: expect.stringMatching(/olive is stopped/) } });
    expect(state.writes).toEqual([]);
  });
});
