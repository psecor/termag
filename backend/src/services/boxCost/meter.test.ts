import { beforeEach, describe, expect, it, vi } from 'vitest';

// The meter's tick state and the writes it would make, in memory.
const db = {
  instances: [] as Record<string, any>[],
  state: null as { id: string; tickAt: Date } | null,
  written: [] as unknown[],
  ticksWon: 0,
};
vi.mock('../../db', () => {
  const tx = {
    boxMeterState: {
      findUnique: async () => (db.state ? { ...db.state } : null),
      updateMany: async ({ where, data }: any) => {
        if (!db.state || db.state.tickAt.getTime() !== where.tickAt.getTime()) return { count: 0 };
        db.state.tickAt = data.tickAt;
        db.ticksWon++;
        return { count: 1 };
      },
      create: async ({ data }: any) => { db.state = { ...data }; db.ticksWon++; return data; },
    },
    $executeRaw: async (...args: unknown[]) => { db.written.push(args); return 1; },
  };
  return {
    prisma: {
      instance: {
        findMany: async ({ where, distinct }: any) => {
          if (distinct) return [];
          const ids: string[] = where.ec2InstanceId.in;
          return db.instances.filter(r => ids.includes(r.ec2InstanceId));
        },
      },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock('../boxProvisioner', () => ({
  getBoxConfig: () => ({ region: 'us-east-2', managedTag: 'termag' }),
  awsClientConfig: () => ({ region: 'us-east-2' }),
}));

const { classify, hourSlices, meterDeltas, meterIntervalMsFromEnv, meterSpan, sweepBoxMeter, ACTIVE_WINDOW_MS } = await import('./meter');
type Ec2Box = import('./meter').Ec2Box;
type MeterRow = import('./meter').MeterRow;

const T = Date.UTC(2026, 9, 26, 12, 0, 0);
const MIN = 60_000;
const box = (extra: Partial<Ec2Box> = {}): Ec2Box =>
  ({ ec2InstanceId: 'i-1', state: 'running', instanceType: 'm9g.2xlarge', region: 'us-east-2', volumeGb: 152, ...extra });
const row = (extra: Partial<MeterRow> = {}): MeterRow =>
  ({ id: 'inst_1', ec2InstanceId: 'i-1', userId: 'u1', status: 'ready', lastActivityAt: null, ...extra });

describe('classify', () => {
  it('bills compute only while EC2 says running', () => {
    for (const state of ['pending', 'stopping', 'stopped', 'shutting-down']) expect(classify(box({ state }), row(), T)).toBeNull();
  });

  it('bills the stopping of a hibernate, while RAM goes to disk, as boot', () => {
    expect(classify(box({ state: 'stopping' }), row({ status: 'hibernating' }), T)).toBe('boot');
    expect(classify(box({ state: 'stopping' }), row({ status: 'stopping' }), T)).toBeNull();
  });

  it('is active within the window and idle past it', () => {
    expect(classify(box(), row({ lastActivityAt: new Date(T - ACTIVE_WINDOW_MS) }), T)).toBe('active');
    expect(classify(box(), row({ lastActivityAt: new Date(T - ACTIVE_WINDOW_MS - 1) }), T)).toBe('idle');
    expect(classify(box(), row(), T)).toBe('idle');
  });

  it('puts ownerless boxes in the pool, transitions in boot', () => {
    expect(classify(box(), row({ userId: null, status: 'warm' }), T)).toBe('pool');
    for (const status of ['provisioning', 'starting', 'stopping', 'hibernating']) expect(classify(box(), row({ status }), T)).toBe('boot');
  });

  it('calls a box with no row, or a terminated one, an orphan', () => {
    expect(classify(box(), undefined, T)).toBe('orphan');
    expect(classify(box(), row({ status: 'terminated' }), T)).toBe('orphan');
  });
});

describe('hourSlices', () => {
  it('keeps a span inside one hour whole', () => {
    expect(hourSlices(T, T + 5 * MIN)).toEqual([{ hour: new Date(T), ms: 5 * MIN }]);
  });

  it('cuts a span at the hour', () => {
    expect(hourSlices(T - 2 * MIN, T + 3 * MIN)).toEqual([
      { hour: new Date(T - 60 * MIN), ms: 2 * MIN },
      { hour: new Date(T), ms: 3 * MIN },
    ]);
  });
});

describe('meterSpan', () => {
  it('runs from the last tick', () => {
    expect(meterSpan(T - 7 * MIN, T, 5 * MIN)).toEqual({ startMs: T - 7 * MIN, endMs: T });
  });

  it('meters one interval with no tick, or one too old to trust', () => {
    expect(meterSpan(null, T, 5 * MIN)).toEqual({ startMs: T - 5 * MIN, endMs: T });
    expect(meterSpan(T - 60 * MIN, T, 5 * MIN)).toEqual({ startMs: T - 5 * MIN, endMs: T });
  });
});

describe('meterIntervalMsFromEnv', () => {
  it('defaults to five minutes, turns off at 0 and ignores nonsense', () => {
    expect(meterIntervalMsFromEnv({})).toBe(300_000);
    expect(meterIntervalMsFromEnv({ BOX_METER_SECONDS: '60' })).toBe(60_000);
    expect(meterIntervalMsFromEnv({ BOX_METER_SECONDS: '0' })).toBe(0);
    expect(meterIntervalMsFromEnv({ BOX_METER_SECONDS: '5' })).toBe(300_000);
    expect(meterIntervalMsFromEnv({ BOX_METER_SECONDS: 'x' })).toBe(300_000);
  });
});

describe('meterDeltas', () => {
  it('charges a running box compute and storage', () => {
    const [d] = meterDeltas([box()], [row({ lastActivityAt: new Date(T) })], T, T + 5 * MIN);
    expect(d).toMatchObject({ instanceId: 'inst_1', userId: 'u1', activeSec: 300, idleSec: 0, storageGbSec: 152 * 300 });
  });

  it('charges a stopped box storage only', () => {
    const [d] = meterDeltas([box({ state: 'stopped' })], [row({ status: 'stopped' })], T, T + 5 * MIN);
    expect(d).toMatchObject({ activeSec: 0, idleSec: 0, poolSec: 0, bootSec: 0, orphanSec: 0, storageGbSec: 152 * 300 });
  });

  it('meters a box termag has no row for', () => {
    const [d] = meterDeltas([box({ ec2InstanceId: 'i-stray' })], [row()], T, T + 5 * MIN);
    expect(d).toMatchObject({ ec2InstanceId: 'i-stray', instanceId: null, userId: null, orphanSec: 300 });
  });

  it('charges nobody for a box termag terminated that EC2 still has', () => {
    const [running] = meterDeltas([box()], [row({ status: 'terminated' })], T, T + 5 * MIN);
    expect(running).toMatchObject({ instanceId: 'inst_1', userId: null, orphanSec: 300 });
    const [stopped] = meterDeltas([box({ state: 'stopped' })], [row({ status: 'terminated' })], T, T + 5 * MIN);
    expect(stopped).toMatchObject({ userId: null, storageGbSec: 152 * 300 });
  });

  it('writes one row per hour the span touches', () => {
    const deltas = meterDeltas([box()], [row()], T - MIN, T + 4 * MIN);
    expect(deltas.map(d => [d.hour.getTime(), d.idleSec])).toEqual([[T - 60 * MIN, 60], [T, 240]]);
  });
});

describe('sweepBoxMeter', () => {
  const deps = { describeBoxes: async () => [box()] };
  beforeEach(() => {
    db.instances = [row()];
    db.state = null;
    db.written = [];
    db.ticksWon = 0;
  });

  it('starts the clock and writes the first interval', async () => {
    expect(await sweepBoxMeter(T, deps, 5 * MIN)).toBe(1);
    expect(db.state?.tickAt.getTime()).toBe(T);
    expect(db.written).toHaveLength(1);
  });

  it('leaves a span another orchestrator just metered alone', async () => {
    db.state = { id: 'meter', tickAt: new Date(T - MIN) };
    expect(await sweepBoxMeter(T, deps, 5 * MIN)).toBeNull();
    expect(db.written).toHaveLength(0);
  });

  it('meters from the previous tick and moves it', async () => {
    db.state = { id: 'meter', tickAt: new Date(T - 5 * MIN) };
    expect(await sweepBoxMeter(T, deps, 5 * MIN)).toBe(1);
    expect(db.state.tickAt.getTime()).toBe(T);
    expect(db.ticksWon).toBe(1);
  });

  it('writes nothing when describing EC2 fails, so the next tick covers the span', async () => {
    db.state = { id: 'meter', tickAt: new Date(T - 5 * MIN) };
    await expect(sweepBoxMeter(T, { describeBoxes: async () => { throw new Error('throttled'); } }, 5 * MIN)).rejects.toThrow('throttled');
    expect(db.state.tickAt.getTime()).toBe(T - 5 * MIN);
  });
});
