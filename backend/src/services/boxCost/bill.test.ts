import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultByTime } from '@aws-sdk/client-cost-explorer';

// The pull's tables, in memory.
const db = {
  rates: [] as Array<{ day: string; key: string; estimated: boolean }>,
  billed: [] as Array<{ day: string }>,
  state: null as { id: string; tickAt: Date } | null,
};
vi.mock('../../db', () => {
  const inDays = (where: any) => (r: { day: string }) => !where.day.in.includes(r.day);
  const tx = {
    boxBilledDay: {
      deleteMany: async ({ where }: any) => { db.billed = db.billed.filter(inDays(where)); },
      createMany: async ({ data }: any) => { db.billed.push(...data); },
    },
    boxRate: {
      deleteMany: async ({ where }: any) => {
        db.rates = where.OR
          ? db.rates.filter(r => !where.OR.some((k: any) => k.day === r.day && k.key === r.key))
          : db.rates.filter(inDays(where));
      },
      createMany: async ({ data }: any) => { db.rates.push(...data); },
    },
    boxMeterState: { upsert: async ({ create }: any) => { db.state = { ...create }; } },
  };
  return {
    prisma: {
      boxRate: { findMany: async ({ where }: any) => db.rates.filter(r => r.day >= where.day.gte).map(r => ({ day: r.day, estimated: r.estimated })) },
      boxMeterState: { findUnique: async () => db.state },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
let configured = true;
vi.mock('../boxProvisioner', () => ({ getBoxConfig: () => (configured ? { region: 'us-east-2' } : null) }));

const { billTick, daysToPull, instanceTypeOf, learnRates, parseResourceResults, parseUsageTypeResults, pullBill, resetBillFailureForTests, GP3_KEY } = await import('./bill');

const NOW = new Date('2026-10-26T03:00:00Z');
const day = (start: string, groups: Array<[string[], number, number]>, estimated = false): ResultByTime => ({
  TimePeriod: { Start: start, End: start },
  Estimated: estimated,
  Groups: groups.map(([Keys, usd, qty]) => ({ Keys, Metrics: { NetAmortizedCost: { Amount: String(usd) }, UsageQuantity: { Amount: String(qty) } } })),
});

describe('instanceTypeOf', () => {
  it('reads compute usage types, with or without a region prefix', () => {
    expect(instanceTypeOf('USE2-BoxUsage:m9g.2xlarge')).toBe('m9g.2xlarge');
    expect(instanceTypeOf('BoxUsage:t3.large')).toBe('t3.large');
  });
  it('ignores everything else', () => {
    expect(instanceTypeOf('USE2-DataTransfer-Out-Bytes')).toBeNull();
    expect(instanceTypeOf('USE2-EBS:VolumeUsage.gp3')).toBeNull();
  });
});

describe('daysToPull', () => {
  const window = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19',
    '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];

  it('fetches the whole window, never today, the first time', () => {
    expect(daysToPull(NOW, [])).toEqual(window);
  });

  it('refreshes only the last three days once the rest are final', () => {
    expect(daysToPull(NOW, window.map(d => ({ day: d, estimated: false })))).toEqual(['2026-10-23', '2026-10-24', '2026-10-25']);
  });

  it('reaches back to the oldest day still estimated or missing', () => {
    const stored = window.filter(d => d !== '2026-10-18').map(d => ({ day: d, estimated: d === '2026-10-20' }));
    expect(daysToPull(NOW, stored)[0]).toBe('2026-10-18');
  });
});

describe('parsing and rates', () => {
  const compute = [
    day('2026-10-24', [
      [['i-a', 'USE2-BoxUsage:m9g.2xlarge'], 3.81, 24],
      [['i-b', 'USE2-BoxUsage:m9g.2xlarge'], 1.905, 12],
      [['i-a', 'USE2-DataTransfer-Out-Bytes'], 0.02, 1],
      [['NoResourceId', 'USE2-BoxUsage:m9g.2xlarge'], 0, 0],
    ]),
  ];

  it('keeps one compute row per instance and day, and drops transfer and empty rows', () => {
    expect(parseResourceResults(compute)).toEqual([
      { day: '2026-10-24', ec2InstanceId: 'i-a', instanceType: 'm9g.2xlarge', hours: 24, usd: 3.81, estimated: false },
      { day: '2026-10-24', ec2InstanceId: 'i-b', instanceType: 'm9g.2xlarge', hours: 12, usd: 1.905, estimated: false },
    ]);
  });

  it('divides cost by usage per type, and gp3 by GB-months', () => {
    const usage = parseUsageTypeResults([day('2026-10-24', [[['USE2-EBS:VolumeUsage.gp3'], 49.47, 754.1], [['USE2-NatGateway-Bytes'], 3, 80]], true)]);
    const rates = learnRates(parseResourceResults(compute), usage);
    expect(rates.find(r => r.key === 'm9g.2xlarge')).toMatchObject({ day: '2026-10-24', usage: 36, estimated: false });
    expect(rates.find(r => r.key === 'm9g.2xlarge')!.usd).toBeCloseTo(0.15875);
    expect(rates.find(r => r.key === GP3_KEY)).toMatchObject({ usage: 754.1, estimated: true });
    expect(rates.find(r => r.key === GP3_KEY)!.usd).toBeCloseTo(0.0656, 4);
    expect(rates).toHaveLength(2);
  });
});

describe('pullBill', () => {
  const deps = {
    fetchCompute: vi.fn(async (start: string) => [day(start, [[['i-a', 'USE2-BoxUsage:m8g.2xlarge'], 3.5, 24]])]),
    fetchUsageTypes: vi.fn(async (start: string) => [day(start, [[['USE2-EBS:VolumeUsage.gp3'], 50, 750]])]),
  };
  beforeEach(() => {
    db.rates = []; db.billed = []; db.state = null; configured = true;
    deps.fetchCompute.mockClear(); deps.fetchUsageTypes.mockClear();
    resetBillFailureForTests();
  });

  it('asks for the days due as one range, end exclusive, and replaces what came back', async () => {
    db.rates = ['2026-10-13', '2026-10-14'].map(d => ({ day: d, key: 'm8g.2xlarge', estimated: true }));
    // The fake answers for the range's first day only.
    const days = await pullBill(NOW, deps);
    expect(deps.fetchCompute).toHaveBeenCalledWith('2026-10-13', '2026-10-26');
    expect(days).toEqual(['2026-10-13']);
    expect(db.rates.filter(r => r.key === 'm8g.2xlarge').map(r => [r.day, r.estimated])).toEqual([['2026-10-14', true], ['2026-10-13', false]]);
    expect(db.state?.tickAt).toEqual(NOW);
  });

  it('keeps a day\'s compute when only gp3 came back for it', async () => {
    db.rates = [{ day: '2026-10-13', key: 'm8g.2xlarge', estimated: true }];
    db.billed = [{ day: '2026-10-13' }];
    const gp3Only = { fetchCompute: vi.fn(async () => []), fetchUsageTypes: deps.fetchUsageTypes };
    expect(await pullBill(NOW, gp3Only)).toEqual(['2026-10-13']);
    expect(db.billed).toHaveLength(1);
    expect(db.rates.map(r => r.key).sort()).toEqual([GP3_KEY, 'm8g.2xlarge']);
  });

  it('keeps what it had when Cost Explorer returns nothing', async () => {
    db.rates = [{ day: '2026-10-24', key: 'm8g.2xlarge', estimated: true }];
    db.billed = [{ day: '2026-10-24' }];
    const empty = { fetchCompute: vi.fn(async () => []), fetchUsageTypes: vi.fn(async () => []) };
    expect(await pullBill(NOW, empty)).toEqual([]);
    expect(db.rates).toHaveLength(1);
    expect(db.billed).toHaveLength(1);
  });

  it('counts a day estimated when any of its rates is', async () => {
    const window = Array.from({ length: 13 }, (_, i) => `2026-10-${String(13 + i).padStart(2, '0')}`);
    db.rates = window.flatMap(d => [{ day: d, key: 'a', estimated: false }, { day: d, key: 'b', estimated: d === '2026-10-15' }]);
    await pullBill(NOW, deps);
    expect(deps.fetchCompute).toHaveBeenCalledWith('2026-10-15', '2026-10-26');
  });

  it('waits after a success, backs off after a failure, and does nothing unconfigured', async () => {
    expect(await billTick(NOW.getTime(), deps)).not.toBeNull();
    expect(await billTick(NOW.getTime() + 60_000, deps)).toBeNull();

    db.state = null;
    const failing = { ...deps, fetchCompute: vi.fn(async () => { throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); }) };
    expect(await billTick(NOW.getTime(), failing)).toBeNull();
    expect(await billTick(NOW.getTime() + 60 * 60_000, deps)).toBeNull(); // inside the 6 h back-off
    expect(await billTick(NOW.getTime() + 7 * 60 * 60_000, deps)).not.toBeNull();

    configured = false; db.state = null; resetBillFailureForTests();
    expect(await billTick(NOW.getTime(), deps)).toBeNull();
  });
});
