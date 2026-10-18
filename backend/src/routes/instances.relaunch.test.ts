import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A box launch that failed is retried under the same name. The failed box is
 * retired by that launch, so retries do not leave a trail of failed boxes.
 */

type Box = { id: string; userId: string; name: string; kind: string; status: string; terminatedAt?: Date };

const state = { boxes: [] as Box[], revoked: [] as string[], projectsOn: {} as Record<string, number> };

const prisma = {
  instance: {
    findFirst: vi.fn(async (args: { where: { userId: string; name: string } }) =>
      state.boxes.find(b => b.userId === args.where.userId && b.name === args.where.name && b.status !== 'terminated') ?? null),
    findUnique: vi.fn(async (args: { where: { id: string } }) => state.boxes.find(b => b.id === args.where.id) ?? null),
    updateMany: vi.fn(async (args: { where: { id: string; status: string }; data: Partial<Box> }) => {
      const box = state.boxes.find(b => b.id === args.where.id && b.status === args.where.status);
      if (!box) return { count: 0 };
      Object.assign(box, args.data);
      return { count: 1 };
    }),
    count: vi.fn(async () => 0),
  },
  project: {
    count: vi.fn(async (args: { where: { instanceId: string } }) => state.projectsOn[args.where.instanceId] ?? 0),
  },
  agentToken: {
    updateMany: vi.fn(async (args: { where: { instanceId: string } }) => {
      state.revoked.push(args.where.instanceId);
      return { count: 1 };
    }),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
    instance: {
      create: vi.fn(async (args: { data: Omit<Box, 'id'> }) => {
        const box = { id: `box${state.boxes.length + 1}`, ...args.data };
        state.boxes.push(box);
        return box;
      }),
    },
    agentToken: { create: vi.fn(async () => ({})) },
  })),
};

const provisionBox = vi.fn(async () => {});
const terminateBox = vi.fn(async () => true);

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/boxProvisioner', () => ({ provisionBox, terminateBox, isBoxProvisioningConfigured: () => true }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('../services/boxImage', () => ({
  boxImageSelectionFor: vi.fn(async () => ({ kind: 'published' })),
  isPublished: () => true,
  PUBLISHED_IMAGE: { kind: 'published' },
}));
vi.mock('../services/warmPool', () => ({ currentPoolSpecHash: vi.fn(), reconcileWarmPool: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({ sendToInstanceAgent: vi.fn(), connectedInstanceIds: vi.fn(() => []) }));
vi.mock('../services/warmPoolClaim', () => ({
  claimWarmBox: vi.fn(), isNameConflict: () => false, prismaClaimEffects: {}, WARM_POOL_ENABLED_FLAG: 'warm-pool-enabled',
}));
vi.mock('../services/boxCreationGate', () => ({
  readBoxCreationFacts: vi.fn(async () => ({})),
  boxCreationRefusal: vi.fn(() => null),
}));

const { createBox } = await import('./instances');

const user = { id: 'u1', unixUsername: 'alice', googleEmail: 'alice@example.com', displayName: 'Alice' } as unknown as Express.User;

beforeEach(() => {
  state.boxes = [];
  state.revoked = [];
  state.projectsOn = {};
  vi.clearAllMocks();
});

describe('createBox under the name of an existing box', () => {
  it('retires a failed box of that name and launches its replacement', async () => {
    state.boxes.push({ id: 'old', userId: 'u1', name: 'dev11', kind: 'ec2', status: 'failed' });

    const result = await createBox(user, { name: 'dev11', kind: 'ec2' });

    expect(result.status).toBe(201);
    expect(state.boxes.find(b => b.id === 'old')?.status).toBe('terminated');
    expect(state.revoked).toEqual(['old']);
    expect(terminateBox).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }));
    expect(state.boxes.filter(b => b.status !== 'terminated').map(b => b.name)).toEqual(['dev11']);
    expect(provisionBox).toHaveBeenCalledOnce();
  });

  it('leaves a failed box a project waits on to that project\'s Retry', async () => {
    state.boxes.push({ id: 'old', userId: 'u1', name: 'dev11', kind: 'ec2', status: 'failed' });
    state.projectsOn.old = 1;

    const result = await createBox(user, { name: 'dev11', kind: 'ec2' });

    expect(result.status).toBe(409);
    expect(state.boxes.find(b => b.id === 'old')?.status).toBe('failed');
    expect(provisionBox).not.toHaveBeenCalled();
  });

  it('still refuses a name a live box holds', async () => {
    state.boxes.push({ id: 'live', userId: 'u1', name: 'dev11', kind: 'ec2', status: 'ready' });

    const result = await createBox(user, { name: 'dev11', kind: 'ec2' });

    expect(result).toEqual({ status: 409, body: { error: 'A box named "dev11" already exists' } });
    expect(state.boxes.find(b => b.id === 'live')?.status).toBe('ready');
    expect(terminateBox).not.toHaveBeenCalled();
  });
});
