import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagContext } from './featureFlags';

/**
 * The warm pool reads box-hibernation-enabled once per spec, for a fixed
 * context: the value goes into the spec hash, so flipping the fallthrough
 * rolls the pool, and into the pool's launches.
 */

// box-hibernation-enabled as a targeting flag source would serve it: individual user
// targets, else the fallthrough.
const flag = vi.hoisted(() => ({ fallthrough: false, userTargets: {} as Record<string, boolean>, contexts: [] as unknown[] }));

vi.mock('./featureFlags', () => {
  const evaluate = (key: string, ctx: FlagContext, fallback: boolean) => {
    if (key !== 'box-hibernation-enabled') return fallback;
    flag.contexts.push(ctx);
    const userKey = ctx.kind === 'user' ? ctx.key : ctx.kind === 'multi' ? (ctx as { user?: { key: string } }).user?.key : undefined;
    return userKey !== undefined && userKey in flag.userTargets ? flag.userTargets[userKey] : flag.fallthrough;
  };
  return {
    boolVariationForContext: vi.fn(async (key: string, ctx: FlagContext, fallback: boolean) => evaluate(key, ctx, fallback)),
    boolVariation: vi.fn(async (key: string, user: { id: string }, fallback: boolean) => evaluate(key, { kind: 'user', key: user.id }, fallback)),
  };
});

const ami = vi.hoisted(() => ({ imageId: 'ami-1', rootDeviceName: '/dev/sda1', rootVolumeGb: 120, hibernationSupported: true, termagSha: null, createdAt: null }));
const provisionPoolBox = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@aws-sdk/client-ec2', () => ({ EC2Client: class {} }));
vi.mock('./boxProvisioner', () => ({
  awsClientConfig: () => ({}),
  buildWarmCloudInit: () => '#!/bin/bash\n',
  discoverLatestAmi: vi.fn(async () => ami),
  getBoxConfig: () => ({ instanceType: 'm9g.2xlarge', agentWsUrl: 'wss://orchestrator/termag/ws/agent' }),
  provisionPoolBox,
  terminateBox: vi.fn(),
}));
vi.mock('./warmPoolClaim', () => ({ resendStalledClaims: vi.fn(async () => {}) }));

const tx = {
  instance: {
    count: vi.fn(async () => 0),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'pool1', ...args.data })),
  },
  agentToken: { create: vi.fn(async () => ({})) },
};
vi.mock('../db', () => ({
  prisma: {
    instance: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  },
}));

const { currentPoolSpec, reconcileWarmPool, resetPoolSpecCache } = await import('./warmPool');
const { POOL_FLAG_CONTEXT } = await import('./boxHibernationFlag');

beforeEach(() => {
  flag.fallthrough = false;
  flag.userTargets = {};
  flag.contexts = [];
  ami.hibernationSupported = true;
  provisionPoolBox.mockClear();
  resetPoolSpecCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.WARM_POOL_TARGET_SIZE = '1';
});

describe('the warm pool and box-hibernation-enabled', () => {
  it('reads the flag for the fixed pool context, never a user', async () => {
    await currentPoolSpec();
    expect(flag.contexts).toEqual([POOL_FLAG_CONTEXT]);
    expect(POOL_FLAG_CONTEXT).toMatchObject({ kind: 'box', key: 'termag-warm-pool' });
  });

  it('follows the fallthrough, so flipping it changes the spec hash and rolls the pool', async () => {
    const off = await currentPoolSpec();
    flag.fallthrough = true;
    const on = await currentPoolSpec();
    expect(off.hibernation).toBe(false);
    expect(on.hibernation).toBe(true);
    expect(on.hash).not.toBe(off.hash);
  });

  it('is not moved by a user target', async () => {
    const before = await currentPoolSpec();
    flag.userTargets = { u1: true };
    expect(await currentPoolSpec()).toEqual(before);
  });

  it('leaves the hash alone on an AMI that cannot hibernate', async () => {
    ami.hibernationSupported = false;
    const off = await currentPoolSpec();
    flag.fallthrough = true;
    const on = await currentPoolSpec();
    expect(on.hash).toBe(off.hash);
    expect(on.hibernation).toBe(true);
  });

  it('launches pool boxes with the value it hashed', async () => {
    flag.fallthrough = true;
    const spec = await currentPoolSpec();
    await reconcileWarmPool();
    expect(provisionPoolBox).toHaveBeenCalledOnce();
    expect(provisionPoolBox).toHaveBeenCalledWith(expect.objectContaining({ poolSpecHash: spec.hash, hibernation: true }));
  });
});
