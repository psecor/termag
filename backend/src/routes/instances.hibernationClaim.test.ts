import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagContext } from '../services/featureFlags';

/**
 * A user claims a warm box only when their box-hibernation-enabled value is
 * the pool's: EC2 fixes hibernation at launch, so a user targeted away from
 * the fallthrough gets a fresh box launched with their own value.
 */

// box-hibernation-enabled as a targeting flag source would serve it: individual user
// targets, else the fallthrough. warm-pool-enabled is on for everyone.
const flag = vi.hoisted(() => ({ fallthrough: false, userTargets: {} as Record<string, boolean> }));

vi.mock('../services/featureFlags', () => {
  const evaluate = (key: string, ctx: FlagContext, fallback: boolean) => {
    if (key === 'warm-pool-enabled') return true;
    if (key !== 'box-hibernation-enabled') return fallback;
    const userKey = ctx.kind === 'user' ? ctx.key : undefined;
    return userKey !== undefined && userKey in flag.userTargets ? flag.userTargets[userKey] : flag.fallthrough;
  };
  return {
    boolVariationForContext: vi.fn(async (key: string, ctx: FlagContext, fallback: boolean) => evaluate(key, ctx, fallback)),
    boolVariation: vi.fn(async (key: string, user: { id: string }, fallback: boolean) => evaluate(key, { kind: 'user', key: user.id }, fallback)),
    stringVariation: vi.fn(async (_key: string, _user: unknown, fallback: string) => fallback),
  };
});

const claimed = { id: 'pool1', userId: 'u1', name: 'dev1', kind: 'ec2', status: 'ready' };
const claimWarmBox = vi.hoisted(() => vi.fn());
const provisionBox = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../db', () => ({
  prisma: {
    instance: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 2) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      instance: { create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'cold1', ...args.data })) },
      agentToken: { create: vi.fn(async () => ({})) },
    })),
  },
}));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/boxProvisioner', () => ({ provisionBox, terminateBox: vi.fn(), isBoxProvisioningConfigured: () => true }));
vi.mock('../services/warmPool', () => ({ poolSpecHashOrNull: vi.fn(async () => 'spec1'), reconcileWarmPool: vi.fn(async () => {}) }));
vi.mock('../services/agentRegistry', () => ({ sendToInstanceAgent: vi.fn() }));
vi.mock('../services/warmPoolClaim', () => ({
  claimWarmBox, isNameConflict: () => false, prismaClaimEffects: {}, WARM_POOL_ENABLED_FLAG: 'warm-pool-enabled',
}));
vi.mock('../services/boxCreationGate', () => ({
  readBoxCreationFacts: vi.fn(async () => ({})),
  boxCreationRefusal: vi.fn(() => null),
}));

const { createBox } = await import('./instances');

const user = { id: 'u1', unixUsername: 'alice', googleEmail: 'alice@example.com', displayName: 'Alice' } as unknown as Express.User;

beforeEach(() => {
  flag.fallthrough = false;
  flag.userTargets = {};
  vi.clearAllMocks();
  claimWarmBox.mockResolvedValue({ claimed: true, instance: claimed });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('claiming a warm box under box-hibernation-enabled', () => {
  it.each([false, true])('claims normally for a user at the default value (fallthrough %s)', async (fallthrough) => {
    flag.fallthrough = fallthrough;

    const result = await createBox(user, { name: 'dev1', kind: 'ec2' });

    expect(result).toEqual({ status: 201, body: { instance: claimed, claimed: true } });
    expect(claimWarmBox).toHaveBeenCalledWith(expect.objectContaining({ currentHash: 'spec1', boxName: 'dev1' }), {});
    expect(provisionBox).not.toHaveBeenCalled();
  });

  it.each([
    { fallthrough: false, override: true },
    { fallthrough: true, override: false },
  ])('skips the claim for a user targeted to $override while the pool is $fallthrough, and launches with their value', async ({ fallthrough, override }) => {
    flag.fallthrough = fallthrough;
    flag.userTargets = { u1: override };

    const result = await createBox(user, { name: 'dev1', kind: 'ec2' });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ claimed: false, instance: { id: 'cold1', status: 'provisioning' } });
    expect(claimWarmBox).not.toHaveBeenCalled();
    expect(provisionBox).toHaveBeenCalledWith(expect.objectContaining({ hibernation: override, image: { kind: 'published' } }));
  });

  it('launches with the default value when a claim falls through', async () => {
    flag.fallthrough = true;
    claimWarmBox.mockResolvedValue({ claimed: false, reason: 'no-candidate', candidatesTried: 0 });

    await createBox(user, { name: 'dev1', kind: 'ec2' });

    expect(provisionBox).toHaveBeenCalledWith(expect.objectContaining({ hibernation: true }));
  });
});
