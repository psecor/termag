import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '@prisma/client';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({ getInstanceAgent: vi.fn(), instanceAgentTransport: vi.fn(), connectedInstanceIds: vi.fn(() => []) }));
vi.mock('./envPool', () => ({ noteClaimInFlight: vi.fn(), stopBack: vi.fn() }));
vi.mock('./productEvents', () => ({ recordProductEvent: vi.fn() }));

const { claimEnvPoolBox, claimerCanRead } = await import('./envPoolClaim');
type Effects = import('./envPoolClaim').EnvClaimEffects;
type StartResult = import('./envPoolClaim').StartResult;

const owner = { id: 'u1', unixUsername: 'ada', displayName: 'Ada', googleEmail: 'z@example.com', dotfilesRepoUrl: null } as any;
const req = { owner, boxName: 'envbox', environmentId: 'env1', setupHash: 'h1', parentInstanceId: null };

function box(id: string, zone: string): Instance {
  return { id, availabilityZone: zone, subnetId: `subnet-${zone}`, status: 'env-stopped', userId: null } as unknown as Instance;
}

/** A pool of stopped boxes, and what EC2 does with each start. */
function harness(pool: Instance[], starts: Record<string, StartResult | 'throw'>, hello: Record<string, boolean> = {}) {
  const log: string[] = [];
  let clock = 0;
  const left = [...pool];
  const fx: Effects = {
    take: vi.fn(async (_r, refused: string[]) => {
      const i = left.findIndex(b => !refused.includes(b.availabilityZone!));
      if (i < 0) return null;
      const [b] = left.splice(i, 1);
      log.push(`take ${b.id}`);
      return b;
    }),
    hasStale: vi.fn(async () => false),
    start: vi.fn(async (b: Instance) => {
      clock += 1500;
      const r = starts[b.id] ?? { ok: true, fallbackType: null };
      if (r === 'throw') throw new Error('boom');
      log.push(`start ${b.id} ${r.ok ? 'ok' : r.capacity ? 'no-capacity' : 'failed'}`);
      return r;
    }),
    waitForHello: vi.fn(async (id: string) => { clock += 12_000; return hello[id] ?? true; }),
    putBack: vi.fn(async (b: Instance) => { log.push(`put back ${b.id}`); }),
    abandon: vi.fn(async (b: Instance, why: string) => { log.push(`abandon ${b.id}: ${why}`); }),
    connectedElsewhere: vi.fn(async () => false),
    stopBack: vi.fn(async (b: Instance, why: string) => { log.push(`stop back ${b.id}: ${why}`); }),
    handOver: vi.fn(async (b: Instance) => { log.push(`hand over ${b.id}`); return { ...b, userId: 'u1', status: 'ready' } as Instance; }),
    configureBox: vi.fn(async () => ({ reportsOnClaim: false })),
    abandonClaimed: vi.fn(async () => undefined),
    settleClaim: vi.fn(async () => undefined),
    welcomeOwner: vi.fn(async () => undefined),
    waitMs: 120_000,
    now: () => clock,
  };
  return { fx, log };
}

const noCapacity: StartResult = { ok: false, capacity: true, error: 'Insufficient capacity.' };

describe('claimEnvPoolBox', () => {
  it('starts the newest box, waits for its hello and hands it over', async () => {
    const { fx, log } = harness([box('b1', 'us-east-1a')], {});
    const out = await claimEnvPoolBox(req, fx);
    expect(out).toMatchObject({ claimed: true, fallback: null, startMs: 1500, helloMs: 12_000, tried: 1 });
    expect(log).toEqual(['take b1', 'start b1 ok', 'hand over b1']);
    expect(fx.settleClaim).toHaveBeenCalledWith('b1');
    expect(fx.welcomeOwner).toHaveBeenCalled();
  });

  it('says a hit took another type when startOnFallbackType retyped it', async () => {
    const { fx } = harness([box('b1', 'us-east-1a')], { b1: { ok: true, fallbackType: 'm7g.xlarge' } });
    expect(await claimEnvPoolBox(req, fx)).toMatchObject({ claimed: true, fallback: 'type' });
  });

  it('puts a box refused for capacity back, and takes one in another zone', async () => {
    const { fx, log } = harness([box('b1', 'us-east-1a'), box('b2', 'us-east-1a'), box('b3', 'us-east-1b')], { b1: noCapacity });
    const out = await claimEnvPoolBox(req, fx);
    expect(out).toMatchObject({ claimed: true, fallback: 'zone', tried: 2 });
    // b2 is in the refused zone, so it is never taken: b3 is.
    expect(log).toEqual(['take b1', 'start b1 no-capacity', 'put back b1', 'take b3', 'start b3 ok', 'hand over b3']);
    expect(fx.take).toHaveBeenLastCalledWith(req, ['us-east-1a']);
    expect(fx.abandon).not.toHaveBeenCalled();
  });

  it('misses with no-capacity when every zone with a box refuses', async () => {
    const { fx, log } = harness([box('b1', 'us-east-1a'), box('b2', 'us-east-1b')], { b1: noCapacity, b2: noCapacity });
    expect(await claimEnvPoolBox(req, fx)).toEqual({ claimed: false, reason: 'no-capacity', tried: 2 });
    expect(log.filter(l => l.startsWith('put back'))).toEqual(['put back b1', 'put back b2']);
  });

  it('abandons a box whose start failed otherwise, or whose hello never came, and moves on', async () => {
    const { fx, log } = harness(
      [box('b1', 'us-east-1a'), box('b2', 'us-east-1a'), box('b3', 'us-east-1a')],
      { b1: { ok: false, capacity: false, error: 'UnauthorizedOperation' }, b2: 'throw' },
    );
    const out = await claimEnvPoolBox(req, fx);
    expect(out).toMatchObject({ claimed: true, instance: { id: 'b3' }, tried: 3 });
    expect(log).toContain('abandon b1: start failed: UnauthorizedOperation');
    expect(log).toContain('abandon b2: start failed: boom');
  });

  it('abandons a box with no hello in time', async () => {
    const { fx, log } = harness([box('b1', 'us-east-1a')], {}, { b1: false });
    expect(await claimEnvPoolBox(req, fx)).toEqual({ claimed: false, reason: 'start-failed', tried: 1 });
    expect(log).toContain('abandon b1: no hello within 120s of its start');
  });

  it('stops back, not terminates, a box whose hello reached another orchestrator process (a rolling deploy)', async () => {
    const { fx, log } = harness([box('b1', 'a'), box('b2', 'a')], {}, { b1: false });
    (fx.connectedElsewhere as any).mockImplementation(async (id: string) => id === 'b1');
    expect(await claimEnvPoolBox(req, fx)).toMatchObject({ claimed: true, instance: { id: 'b2' } });
    expect(log).toContain('stop back b1: its hello reached another orchestrator process');
    expect(fx.abandon).not.toHaveBeenCalled();
  });

  it('stops a box back when its name is taken at the hand-over, and tries no other box with that name (Bugbot on #1453)', async () => {
    const { fx, log } = harness([box('b1', 'a'), box('b2', 'a')], {});
    (fx.handOver as any).mockResolvedValueOnce('name-taken');
    expect(await claimEnvPoolBox(req, fx)).toEqual({ claimed: false, reason: 'name-taken', tried: 1 });
    expect(log).toContain('stop back b1: the box name envbox is taken');
    expect(fx.abandon).not.toHaveBeenCalled();
    expect(fx.take).toHaveBeenCalledTimes(1);
  });

  it('misses with empty, or stale when only other setups are stopped', async () => {
    const { fx } = harness([], {});
    expect(await claimEnvPoolBox(req, fx)).toEqual({ claimed: false, reason: 'empty', tried: 0 });
    (fx.hasStale as any).mockResolvedValue(true);
    expect(await claimEnvPoolBox(req, fx)).toEqual({ claimed: false, reason: 'stale', tried: 0 });
  });

  it('gives up after MAX_CLAIM_CANDIDATES', async () => {
    const pool = ['a', 'b', 'c', 'd'].map(z => box(`b-${z}`, z));
    const { fx } = harness(pool, Object.fromEntries(pool.map(b => [b.id, noCapacity])));
    expect(await claimEnvPoolBox(req, fx)).toEqual({ claimed: false, reason: 'no-capacity', tried: 3 });
  });

  it('abandons the claimed box when box-claim fails, the warm way, and tries the next', async () => {
    const { fx } = harness([box('b1', 'a'), box('b2', 'a')], {});
    (fx.configureBox as any).mockRejectedValueOnce(new Error('rpc'));
    expect(await claimEnvPoolBox(req, fx)).toMatchObject({ claimed: true, instance: { id: 'b2' } });
    expect(fx.abandonClaimed).toHaveBeenCalledWith('b1', 'claim RPC failed');
  });
});

describe('claimerCanRead', () => {
  it('needs a credential that reads every repository', async () => {
    const canRead = vi.fn(async (_t: string, repo: string) => repo !== 'org/private');
    expect(await claimerCanRead('u1', ['org/a', 'org/b'], { token: async () => 't', canRead })).toBe(true);
    expect(await claimerCanRead('u1', ['org/a', 'org/private'], { token: async () => 't', canRead })).toBe(false);
    expect(await claimerCanRead('u1', ['org/a'], { token: async () => null, canRead })).toBe(false);
  });
});
