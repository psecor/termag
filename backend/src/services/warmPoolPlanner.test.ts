import { describe, it, expect } from 'vitest';
import {
  type PlanInput,
  type PoolPlan,
  type PoolRowView,
  planWarmPool,
  stuckWarmingReason,
} from './warmPoolPlanner';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const HASH = 'sha-current';
const OLD_HASH = 'sha-previous';

/** A timestamp that many milliseconds before `NOW`. */
function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

const POLICY: Omit<PlanInput, 'rows'> = {
  lastWarmedAt: null,
  target: 2,
  maxInFlight: 2,
  currentHash: HASH,
  maxAgeMs: 24 * HOUR,
  agentLostAfterMs: 5 * MINUTE,
  breakerWindowMs: HOUR,
  breakerThreshold: 3,
  now: NOW,
};

function plan(rows: PoolRowView[], override: Partial<PlanInput> = {}): PoolPlan {
  return planWarmPool({ ...POLICY, rows, ...override });
}

function warming(id: string, override: Partial<PoolRowView> = {}): PoolRowView {
  return {
    id,
    status: 'warming',
    poolSpecHash: HASH,
    createdAt: ago(2 * MINUTE),
    warmedAt: null,
    lastConnectedAt: null,
    agentDisconnectedAt: null,
    provisioningError: null,
    ...override,
  };
}

function warm(id: string, override: Partial<PoolRowView> = {}): PoolRowView {
  return {
    id,
    status: 'warm',
    poolSpecHash: HASH,
    createdAt: ago(HOUR),
    warmedAt: ago(50 * MINUTE),
    lastConnectedAt: ago(55 * MINUTE),
    agentDisconnectedAt: null,
    provisioningError: null,
    ...override,
  };
}

function failed(id: string, override: Partial<PoolRowView> = {}): PoolRowView {
  return {
    id,
    status: 'failed',
    poolSpecHash: HASH,
    createdAt: ago(10 * MINUTE),
    warmedAt: null,
    lastConnectedAt: null,
    agentDisconnectedAt: null,
    provisioningError: 'RunInstances: InsufficientInstanceCapacity',
    ...override,
  };
}

const CLOSED = { open: false, failures: 0, lastError: null };

describe('deficit', () => {
  it('launches the whole target into an empty pool', () => {
    expect(plan([])).toEqual({
      launch: 2,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 0, inFlight: 0 },
    });
  });

  it('counts a warming row as supply, so a half-filled pool launches only the rest', () => {
    expect(plan([warm('a'), warming('b')])).toEqual({
      launch: 0,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 1, inFlight: 1 },
    });
  });

  it('does nothing at all once the pool is at target', () => {
    expect(plan([warm('a'), warm('b')])).toEqual({
      launch: 0,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 2, inFlight: 0 },
    });
  });
});

describe('in-flight cap', () => {
  it('launches no more than the cap leaves room for', () => {
    expect(plan([warming('a')], { target: 4 })).toEqual({
      launch: 1,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 0, inFlight: 1 },
    });
  });

  it('launches nothing while the cap is full, however big the deficit', () => {
    expect(plan([warming('a'), warming('b')], { target: 10 })).toEqual({
      launch: 0,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 0, inFlight: 2 },
    });
  });

  it('treats a zero cap as a kill switch that holds what is already warm', () => {
    expect(plan([warm('a')], { maxInFlight: 0 })).toEqual({
      launch: 0,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 1, inFlight: 0 },
    });
  });
});

describe('two pods filling one deficit', () => {
  // The planner's half of the guard. The reconciler's serializable transaction
  // re-counts before inserting, and this is why one committed insert is enough
  // to stop the other pod's next tick: a warming row is supply.
  it('launches nothing once another pod has inserted the rows the deficit needed', () => {
    expect(plan([warming('pod-a-1'), warming('pod-a-2')])).toEqual({
      launch: 0,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 0, inFlight: 2 },
    });
  });

  it('launches only the shortfall the other pod left', () => {
    expect(plan([warming('pod-a-1')], { target: 2, maxInFlight: 4 })).toEqual({
      launch: 1,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 0, inFlight: 1 },
    });
  });
});

describe('target 0', () => {
  it('drains the whole pool and launches nothing', () => {
    expect(plan([warm('w'), warming('g')], { target: 0 })).toEqual({
      launch: 0,
      fail: [],
      terminate: [
        { id: 'w', reason: 'drain' },
        { id: 'g', reason: 'drain' },
      ],
      breaker: CLOSED,
      supply: { claimable: 1, inFlight: 1 },
    });
  });

  it('is a no-op once the pool is gone', () => {
    expect(plan([], { target: 0 })).toEqual({
      launch: 0,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 0, inFlight: 0 },
    });
  });

  // A box whose agent is gone is the one a drain must not leave behind. Only a
  // retirement reaches terminateBox, so omitting it from this list leaves an
  // EC2 instance running and billing after the pool is supposed to be gone.
  it('drains a box whose agent is already lost', () => {
    const rows = [
      warm('lost', { lastConnectedAt: ago(HOUR), agentDisconnectedAt: ago(6 * MINUTE) }),
      warm('live'),
    ];
    expect(plan(rows, { target: 0 })).toEqual({
      launch: 0,
      fail: [],
      // Same createdAt, so the order is the id tie-break that keeps a plan
      // reproducible.
      terminate: [
        { id: 'live', reason: 'drain' },
        { id: 'lost', reason: 'drain' },
      ],
      breaker: CLOSED,
      supply: { claimable: 1, inFlight: 0 },
    });
  });

  it('drains a stale box as a drain rather than as staleness', () => {
    expect(plan([warm('s', { poolSpecHash: OLD_HASH })], { target: 0 }).terminate).toEqual([
      { id: 's', reason: 'drain' },
    ]);
  });
});

describe('surplus', () => {
  it('retires the excess oldest first', () => {
    const rows = [
      warm('newest', { createdAt: ago(HOUR) }),
      warm('oldest', { createdAt: ago(3 * HOUR) }),
      warm('middle', { createdAt: ago(2 * HOUR) }),
    ];
    expect(plan(rows, { target: 1 })).toEqual({
      launch: 0,
      fail: [],
      terminate: [
        { id: 'oldest', reason: 'surplus' },
        { id: 'middle', reason: 'surplus' },
      ],
      breaker: CLOSED,
      supply: { claimable: 3, inFlight: 0 },
    });
  });

  it('breaks a tie on createdAt by id, so the plan is reproducible', () => {
    const born = ago(HOUR);
    const rows = [warm('b', { createdAt: born }), warm('a', { createdAt: born })];
    expect(plan(rows, { target: 1 }).terminate).toEqual([{ id: 'a', reason: 'surplus' }]);
  });

  // box-warm-pool-size lowered from 5 to 2 mid-refill.
  it('retires the warming boxes a lowered target no longer has room for, newest first', () => {
    const rows = [
      warm('w'),
      warming('g-old', { createdAt: ago(9 * MINUTE) }),
      warming('g-mid', { createdAt: ago(6 * MINUTE) }),
      warming('g-new', { createdAt: ago(3 * MINUTE) }),
    ];
    expect(plan(rows, { target: 2, maxInFlight: 3 })).toEqual({
      launch: 0,
      fail: [],
      terminate: [
        { id: 'g-new', reason: 'surplus' },
        { id: 'g-mid', reason: 'surplus' },
      ],
      breaker: CLOSED,
      supply: { claimable: 1, inFlight: 3 },
    });
  });

  it('retires every warming box once the warm ones alone exceed the target', () => {
    const rows = [warm('w1', { createdAt: ago(2 * HOUR) }), warm('w2'), warm('w3'), warming('g')];
    expect(plan(rows, { target: 1 }).terminate).toEqual([
      { id: 'w1', reason: 'surplus' },
      { id: 'w2', reason: 'surplus' },
      { id: 'g', reason: 'surplus' },
    ]);
  });

  it('leaves a warming box alone while the pool is under target', () => {
    expect(plan([warm('w'), warming('g')], { target: 2 }).terminate).toEqual([]);
  });

  it('never counts a stale warming box against the room, which staleness already retires', () => {
    const rows = [warm('w'), warming('cur'), warming('old', { poolSpecHash: OLD_HASH })];
    expect(plan(rows, { target: 2, maxInFlight: 3 }).terminate).toEqual([{ id: 'old', reason: 'stale' }]);
  });
});

describe('staleness', () => {
  it('replaces a stale box before retiring it, so a rollover leaves no empty window', () => {
    const rows = [
      warm('old-1', { poolSpecHash: OLD_HASH }),
      warm('old-2', { poolSpecHash: OLD_HASH }),
    ];
    expect(plan(rows)).toEqual({
      launch: 2,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 0, inFlight: 0 },
    });
  });

  it('keeps the stale boxes while their replacements are still warming', () => {
    const rows = [
      warm('old-1', { poolSpecHash: OLD_HASH }),
      warm('old-2', { poolSpecHash: OLD_HASH }),
      warm('new-1'),
      warming('new-2'),
    ];
    expect(plan(rows)).toEqual({
      launch: 0,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 1, inFlight: 1 },
    });
  });

  it('retires the stale boxes the tick the replacements reach the target', () => {
    const rows = [
      warm('old-1', { poolSpecHash: OLD_HASH, createdAt: ago(4 * HOUR) }),
      warm('old-2', { poolSpecHash: OLD_HASH, createdAt: ago(3 * HOUR) }),
      warm('new-1'),
      warm('new-2'),
    ];
    expect(plan(rows)).toEqual({
      launch: 0,
      fail: [],
      terminate: [
        { id: 'old-1', reason: 'stale' },
        { id: 'old-2', reason: 'stale' },
      ],
      breaker: CLOSED,
      supply: { claimable: 2, inFlight: 0 },
    });
  });

  it('retires a stale warming box at once, because it was never claimable', () => {
    expect(plan([warming('rolled-over', { poolSpecHash: OLD_HASH })])).toEqual({
      // One, not two: the box being retired still holds a slot against the cap
      // until AWS actually kills it.
      launch: 1,
      fail: [],
      terminate: [{ id: 'rolled-over', reason: 'stale' }],
      breaker: CLOSED,
      // Zero, because supply reports the current spec only. The stale row does
      // still hold a slot against the in-flight cap, which is why one replaces
      // it rather than two.
      supply: { claimable: 0, inFlight: 0 },
    });
  });

  it('calls a box past its max age stale for that reason and not for its hash', () => {
    const rows = [warm('elderly', { createdAt: ago(25 * HOUR) }), warm('fresh')];
    expect(plan(rows, { target: 1 })).toEqual({
      launch: 0,
      fail: [],
      terminate: [{ id: 'elderly', reason: 'max-age' }],
      breaker: CLOSED,
      supply: { claimable: 1, inFlight: 0 },
    });
  });

  it('replaces an over-age box before retiring it too', () => {
    expect(plan([warm('elderly', { createdAt: ago(25 * HOUR) })], { target: 1 })).toEqual({
      launch: 1,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 0, inFlight: 0 },
    });
  });
});

describe('agent liveness', () => {
  it('fails a warm box whose agent has been gone too long and refills its slot the same tick', () => {
    const rows = [
      warm('lost', { lastConnectedAt: ago(HOUR), agentDisconnectedAt: ago(6 * MINUTE) }),
      warm('alive'),
    ];
    expect(plan(rows)).toEqual({
      launch: 1,
      fail: [{ id: 'lost', reason: 'agent lost' }],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 1, inFlight: 0 },
    });
  });

  it('reads a reconnected box as live from the two timestamps, not from the disconnect alone', () => {
    // A connect no longer clears agentDisconnectedAt, so this row has a
    // disconnect 10 minutes old and a connect 9 minutes old. A single-column
    // check would fail this box for having been gone past the 5 minute limit.
    const rows = [
      warm('reconnected', { agentDisconnectedAt: ago(10 * MINUTE), lastConnectedAt: ago(9 * MINUTE) }),
      warm('alive'),
    ];
    expect(plan(rows)).toEqual({
      launch: 0,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 2, inFlight: 0 },
    });
  });

  // A rolling deploy stamps a disconnect on every warm box at once, so a box
  // inside the grace window has to stay supply. Dropping it launches a
  // replacement per box on every release, each of which then retires as
  // surplus when the agents dial back in.
  it('keeps a briefly disconnected box as supply rather than replacing it', () => {
    const rows = [
      warm('blipped', { lastConnectedAt: ago(HOUR), agentDisconnectedAt: ago(3 * MINUTE) }),
      warm('steady'),
    ];
    expect(plan(rows)).toEqual({
      launch: 0,
      fail: [],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 2, inFlight: 0 },
    });
  });

  it('drops the box from supply and replaces it once the grace window passes', () => {
    const rows = [
      warm('gone', { lastConnectedAt: ago(HOUR), agentDisconnectedAt: ago(6 * MINUTE) }),
      warm('steady'),
    ];
    expect(plan(rows)).toEqual({
      launch: 1,
      fail: [{ id: 'gone', reason: 'agent lost' }],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 1, inFlight: 0 },
    });
  });

  it('treats a disconnect with no recorded connect as gone', () => {
    const rows = [warm('never', { lastConnectedAt: null, agentDisconnectedAt: ago(6 * MINUTE) })];
    expect(plan(rows).fail).toEqual([{ id: 'never', reason: 'agent lost' }]);
  });

  it('leaves a stale box with a lost agent to the fail path, not the retire path', () => {
    const rows = [
      warm('stale-and-lost', {
        poolSpecHash: OLD_HASH,
        lastConnectedAt: ago(HOUR),
        agentDisconnectedAt: ago(6 * MINUTE),
      }),
      warm('new-1'),
      warm('new-2'),
    ];
    expect(plan(rows)).toEqual({
      launch: 0,
      fail: [{ id: 'stale-and-lost', reason: 'agent lost' }],
      terminate: [],
      breaker: CLOSED,
      supply: { claimable: 2, inFlight: 0 },
    });
  });
});

describe('breaker', () => {
  const three = [
    failed('f1', { createdAt: ago(50 * MINUTE), provisioningError: 'first' }),
    failed('f2', { createdAt: ago(30 * MINUTE), provisioningError: 'second' }),
    failed('f3', { createdAt: ago(10 * MINUTE), provisioningError: 'third' }),
  ];

  it('opens on the third failure and stops launching, quoting the newest error', () => {
    expect(plan(three)).toEqual({
      launch: 0,
      fail: [],
      terminate: [],
      breaker: { open: true, failures: 3, lastError: 'third' },
      supply: { claimable: 0, inFlight: 0 },
    });
  });

  // WP-6 is about boxes that fail to become claimable. A box that warmed and
  // was later failed for losing its agent is evidence that it needs replacing,
  // not evidence that the next launch will fail, and one blip across the fleet
  // would otherwise stop the very refills it made necessary.
  it('ignores a failure that follows a successful warm', () => {
    const postWarm = three.map((row, i) => ({
      ...row,
      warmedAt: ago((60 - i * 10) * MINUTE),
      lastConnectedAt: ago((60 - i * 10) * MINUTE),
      agentDisconnectedAt: ago((15 - i) * MINUTE),
      provisioningError: 'agent lost',
    }));
    expect(plan(postWarm).breaker).toEqual(CLOSED);
  });

  it('stays closed on two failures', () => {
    expect(plan(three.slice(0, 2))).toEqual({
      launch: 2,
      fail: [],
      terminate: [],
      breaker: { open: false, failures: 2, lastError: 'second' },
      supply: { claimable: 0, inFlight: 0 },
    });
  });

  it('forgets a failure older than the window', () => {
    const stale = failed('f0', { createdAt: ago(70 * MINUTE), provisioningError: 'ancient' });
    expect(plan([stale, ...three.slice(0, 2)]).breaker).toEqual({
      open: false,
      failures: 2,
      lastError: 'second',
    });
  });

  it('dates a failure by the last event on the row, not by createdAt', () => {
    // This box was launched 70 minutes ago and lost its agent 10 minutes ago.
    // There is no failedAt column, so the disconnect is the only evidence of
    // when it failed, and dating it from createdAt would drop it.
    const late = failed('f0', {
      createdAt: ago(70 * MINUTE),
      lastConnectedAt: ago(65 * MINUTE),
      agentDisconnectedAt: ago(10 * MINUTE),
      provisioningError: 'agent lost',
    });
    expect(plan([late, ...three.slice(0, 2)]).breaker).toEqual({
      open: true,
      failures: 3,
      lastError: 'agent lost',
    });
  });

  it('closes on the next successful warm and resumes launching', () => {
    expect(plan(three, { lastWarmedAt: ago(5 * MINUTE) })).toEqual({
      launch: 2,
      fail: [],
      terminate: [],
      breaker: { open: false, failures: 0, lastError: null },
      supply: { claimable: 0, inFlight: 0 },
    });
  });

  it('stays closed after the box that closed it has been claimed and left the pool', () => {
    // lastWarmedAt is read across every box, not off `rows`, precisely so a
    // claim does not erase the evidence that the pool is working.
    expect(plan(three, { lastWarmedAt: ago(5 * MINUTE) }).breaker.open).toBe(false);
  });

  it('does not add up failures either side of a success', () => {
    expect(plan(three, { lastWarmedAt: ago(20 * MINUTE) }).breaker).toEqual({
      open: false,
      failures: 1,
      lastError: 'third',
    });
  });

  it('blocks launches without blocking retirement', () => {
    const rows = [...three, warm('a'), warm('b'), warm('surplus-oldest', { createdAt: ago(3 * HOUR) })];
    expect(plan(rows)).toEqual({
      launch: 0,
      fail: [],
      terminate: [{ id: 'surplus-oldest', reason: 'surplus' }],
      breaker: { open: true, failures: 3, lastError: 'third' },
      supply: { claimable: 3, inFlight: 0 },
    });
  });

  it('reports no error when nothing has failed', () => {
    expect(plan([warm('a'), warm('b')]).breaker).toEqual({ open: false, failures: 0, lastError: null });
  });
});

describe('stuckWarmingReason', () => {
  const windows = { noAgentAfterMs: 15 * MINUTE, incompleteAfterMs: 45 * MINUTE };

  it('gives a silent box the full fifteen minutes to dial in', () => {
    expect(stuckWarmingReason({ createdAt: ago(14 * MINUTE), lastConnectedAt: null, now: NOW, ...windows }))
      .toBe(null);
  });

  it('fails a box that never dialed in', () => {
    expect(stuckWarmingReason({ createdAt: ago(15 * MINUTE), lastConnectedAt: null, now: NOW, ...windows }))
      .toBe('no-agent');
  });

  it('gives a connected box the full forty-five minutes to finish its on-warm run', () => {
    expect(stuckWarmingReason({ createdAt: ago(44 * MINUTE), lastConnectedAt: ago(40 * MINUTE), now: NOW, ...windows }))
      .toBe(null);
  });

  it('fails a box still warming past the on-warm window', () => {
    expect(stuckWarmingReason({ createdAt: ago(45 * MINUTE), lastConnectedAt: ago(40 * MINUTE), now: NOW, ...windows }))
      .toBe('incomplete');
  });

  it('prefers the more specific verdict for a box that never dialed in at all', () => {
    expect(stuckWarmingReason({ createdAt: ago(50 * MINUTE), lastConnectedAt: null, now: NOW, ...windows }))
      .toBe('no-agent');
  });

  it('says nothing about a box launched a moment ago', () => {
    expect(stuckWarmingReason({ createdAt: NOW, lastConnectedAt: null, now: NOW, ...windows })).toBe(null);
  });
});
