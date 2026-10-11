import { describe, expect, it } from 'vitest';
import { leaseConfigFromEnv, OrchestratorLease, type LeaseConfig, type LeaseStore } from './orchestratorLease';

/** The orchestrator_leases row, in memory, with the same rules as the Prisma store. */
class MemoryLease implements LeaseStore {
  row: { holderId: string; heartbeatAt: Date; claimedAt: Date } | null = null;
  down = false;
  async claim(holderId: string, _label: string, now: Date, startedAt: Date) {
    if (this.down) throw new Error('db down');
    this.row = { holderId, heartbeatAt: now, claimedAt: startedAt };
  }
  async claimIfOlder(holderId: string, label: string, now: Date, startedAt: Date) {
    if (this.down) throw new Error('db down');
    if (this.row && this.row.claimedAt >= startedAt) return this.row.holderId === holderId;
    await this.claim(holderId, label, now, startedAt);
    return true;
  }
  async heartbeat(holderId: string, now: Date) {
    if (this.down) throw new Error('db down');
    if (this.row?.holderId !== holderId) return false;
    this.row.heartbeatAt = now;
    return true;
  }
  async reclaimIfStale(holderId: string, label: string, now: Date, staleBefore: Date, startedAt: Date) {
    if (this.down) throw new Error('db down');
    if (this.row && this.row.heartbeatAt >= staleBefore) return false;
    await this.claim(holderId, label, now, startedAt);
    return true;
  }
}

const config: LeaseConfig = { heartbeatMs: 5_000, staleMs: 30_000, drainGraceMs: 45_000, drainBrowserDelayMs: 1_500 };

function orchestrator(store: MemoryLease, holderId: string, clock: { t: number }) {
  const events: string[] = [];
  const lease = new OrchestratorLease({
    store, holderId, label: holderId, config,
    now: () => new Date(clock.t),
    onServe: () => events.push('serve'),
    onDrain: () => events.push('drain'),
    log: () => {},
  });
  return { lease, events };
}

describe('OrchestratorLease', () => {
  it('serves after claiming, and keeps serving while it holds the lease', async () => {
    const store = new MemoryLease();
    const clock = { t: 0 };
    const blue = orchestrator(store, 'blue', clock);
    await blue.lease.start();
    blue.lease.stop();
    clock.t += 5_000;
    await blue.lease.tick();
    expect(blue.events).toEqual(['serve']);
    expect(blue.lease.currentRole).toBe('serving');
  });

  it('a newer process displaces the holder, which drains on its next heartbeat', async () => {
    const store = new MemoryLease();
    const clock = { t: 0 };
    const blue = orchestrator(store, 'blue', clock);
    const green = orchestrator(store, 'green', clock);
    await blue.lease.start(); blue.lease.stop();
    clock.t += 1_000;
    await green.lease.start(); green.lease.stop();
    clock.t += 4_000;
    await blue.lease.tick();
    await green.lease.tick();
    expect(blue.events).toEqual(['serve', 'drain']);
    expect(green.events).toEqual(['serve']);
  });

  it('a draining process serves again once the new holder has been silent for staleMs', async () => {
    const store = new MemoryLease();
    const clock = { t: 0 };
    const blue = orchestrator(store, 'blue', clock);
    const green = orchestrator(store, 'green', clock);
    await blue.lease.start(); blue.lease.stop();
    clock.t += 1_000;
    await green.lease.start(); green.lease.stop();
    await blue.lease.tick();
    clock.t += 29_000;
    await blue.lease.tick();
    expect(blue.lease.currentRole).toBe('draining');
    clock.t += 2_000;
    await blue.lease.tick();
    expect(blue.events).toEqual(['serve', 'drain', 'serve']);
    // And green, which went silent, finds it lost the lease when it comes back.
    await green.lease.tick();
    expect(green.events).toEqual(['serve', 'drain']);
  });

  it('a claim that failed on start is retried, and a recovered database does not make it drain', async () => {
    const store = new MemoryLease();
    store.row = { holderId: 'previous deploy', heartbeatAt: new Date(-60_000), claimedAt: new Date(-60_000) };
    store.down = true;
    const clock = { t: 0 };
    const blue = orchestrator(store, 'blue', clock);
    await blue.lease.start(); blue.lease.stop();
    store.down = false;
    clock.t += 5_000;
    await blue.lease.tick();
    clock.t += 5_000;
    await blue.lease.tick();
    expect(blue.events).toEqual(['serve']);
    expect(store.row?.holderId).toBe('blue');
  });

  it('a retried claim yields to a process that started later', async () => {
    const store = new MemoryLease();
    store.down = true;
    const clock = { t: 0 };
    const blue = orchestrator(store, 'blue', clock);
    await blue.lease.start(); blue.lease.stop();
    store.down = false;
    clock.t += 1_000;
    const green = orchestrator(store, 'green', clock);
    await green.lease.start(); green.lease.stop();
    clock.t += 4_000;
    await blue.lease.tick();
    expect(blue.events).toEqual(['serve', 'drain']);
    expect(store.row?.holderId).toBe('green');
  });

  it('two failed claims retried in the wrong order still leave the lease with the newer process', async () => {
    const store = new MemoryLease();
    store.down = true;
    const clock = { t: 0 };
    const blue = orchestrator(store, 'blue', clock);
    await blue.lease.start(); blue.lease.stop();
    clock.t += 1_000;
    const green = orchestrator(store, 'green', clock);
    await green.lease.start(); green.lease.stop();
    store.down = false;
    clock.t += 4_000;
    await blue.lease.tick();   // the older process happens to retry first
    await green.lease.tick();
    clock.t += 5_000;
    await blue.lease.tick();
    expect(store.row?.holderId).toBe('green');
    expect(green.events).toEqual(['serve']);
    expect(blue.events).toEqual(['serve', 'drain']);
  });

  it('a newer process that lost a create race to an older one takes the lease on its next tick', async () => {
    const store = new MemoryLease();
    const clock = { t: 1_000 };
    const green = orchestrator(store, 'green', clock);
    // The race: green's claim finds no row, and blue (started at 0) creates it
    // before green's write, so green's first claim reports the lease taken.
    const realClaim = store.claimIfOlder.bind(store);
    let raced = false;
    store.claimIfOlder = async (holderId, label, now, startedAt) => {
      if (!raced && holderId === 'green') {
        raced = true;
        await store.claim('blue', 'blue', new Date(0), new Date(0));
        return false;
      }
      return realClaim(holderId, label, now, startedAt);
    };
    await green.lease.start(); green.lease.stop();
    expect(green.events).toEqual([]);
    clock.t += 5_000;
    await green.lease.tick();
    expect(green.events).toEqual(['serve']);
    expect(store.row?.holderId).toBe('green');
  });

  it('a first claim that lands after a newer process wrote the lease does not take it', async () => {
    const store = new MemoryLease();
    const clock = { t: 0 };
    const blue = orchestrator(store, 'blue', clock);
    // Green started later but its claim landed first.
    await store.claim('green', 'green', new Date(1_000), new Date(1_000));
    await blue.lease.start(); blue.lease.stop();
    expect(store.row?.holderId).toBe('green');
    expect(blue.events).toEqual([]);
    expect(blue.lease.currentRole).toBe('draining');
    // And it takes the lease once green goes silent.
    clock.t += 32_000;
    await blue.lease.tick();
    expect(blue.events).toEqual(['serve']);
  });

  it('a database outage is not a lost lease, and does not stop the process serving', async () => {
    const store = new MemoryLease();
    store.down = true;
    const clock = { t: 0 };
    const blue = orchestrator(store, 'blue', clock);
    await blue.lease.start(); blue.lease.stop();
    clock.t += 5_000;
    await blue.lease.tick();
    expect(blue.events).toEqual(['serve']);
  });
});

describe('leaseConfigFromEnv', () => {
  it('is off unless ORCHESTRATOR_LEASE=true', () => {
    expect(leaseConfigFromEnv({})).toBeNull();
    expect(leaseConfigFromEnv({ ORCHESTRATOR_LEASE: '1' })).toBeNull();
  });

  it('defaults, and never lets the stale window drop under three heartbeats', () => {
    expect(leaseConfigFromEnv({ ORCHESTRATOR_LEASE: 'true' })).toEqual({ heartbeatMs: 5_000, staleMs: 30_000, drainGraceMs: 45_000, drainBrowserDelayMs: 1_500 });
    expect(leaseConfigFromEnv({ ORCHESTRATOR_LEASE: 'true', ORCHESTRATOR_LEASE_HEARTBEAT_MS: '20000', ORCHESTRATOR_LEASE_STALE_MS: '10000' }))
      .toMatchObject({ heartbeatMs: 20_000, staleMs: 60_000 });
  });
});
