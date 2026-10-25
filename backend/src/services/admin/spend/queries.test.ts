import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_POOLS, DEFAULT_PRICES } from './config';
import type { Pool } from './model';
// A sample of the pools an admin would set up, for these tests only; the
// figures are made up.
const EPD = 'Engineering';
const SAMPLE_POOLS: Array<Omit<Pool, 'id'>> = [
  { name: 'Cursor', kind: 'contract', providers: ['cursor'], annualUsd: 120_000, boxes: null, boxCostUsd: null, usersPerBox: null,
    share: 'proportional', shareValue: null, populationLabel: EPD, populationSize: 120, allocation: 'even', startDate: null, endDate: null,
    note: 'Sample contract.', sort: 10 },
  { name: 'Devin', kind: 'contract', providers: ['devin'], annualUsd: 30_000, boxes: null, boxCostUsd: null, usersPerBox: null,
    share: 'proportional', shareValue: null, populationLabel: EPD, populationSize: 120, allocation: 'even', startDate: null, endDate: null,
    note: 'Sample contract.', sort: 20 },
  { name: 'Inference box', kind: 'infra', providers: ['pi'], annualUsd: null, boxes: 1, boxCostUsd: 50_000, usersPerBox: 30,
    share: 'full', shareValue: null, populationLabel: null, populationSize: null, allocation: 'by-tokens', startDate: null, endDate: null,
    note: 'One inference box shared by every model on it.', sort: 30 },
];

// Seeding and saving the spend model against in-memory
// tables behind a minimal prisma.

type Settings = { id: string; seeded: boolean; loadedCostUsd: number; orgHeadcount: number; modelMix: unknown; updatedAt: Date };
type PoolRow = Record<string, unknown> & { id: string };
let settings: Settings | null = null;
let prices: Array<Record<string, unknown>> = [];
let pools: PoolRow[] = [];
let nextId = 0;
let raceOnUpsert = false;

const blankSettings = (): Settings => ({ id: 'settings', seeded: false, loadedCostUsd: 500000, orgHeadcount: 626, modelMix: {}, updatedAt: new Date(0) });
const p2002 = () => Object.assign(new Error('unique'), { code: 'P2002' });
const prismaMock = {
  spendSettings: {
    upsert: vi.fn(async () => {
      if (raceOnUpsert) { raceOnUpsert = false; settings ??= blankSettings(); throw p2002(); }
      settings ??= blankSettings(); return settings;
    }),
    findUniqueOrThrow: vi.fn(async () => { if (!settings) throw new Error('missing'); return settings; }),
    updateMany: vi.fn(async ({ where, data }: { where: { seeded?: boolean }; data: Partial<Settings> }) => {
      if (!settings || (where.seeded !== undefined && settings.seeded !== where.seeded)) return { count: 0 };
      Object.assign(settings, data); return { count: 1 };
    }),
    update: vi.fn(async ({ data }: { data: Partial<Settings> }) => Object.assign(settings!, data)),
  },
  modelPrice: {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => { prices.push(...data); return { count: data.length }; }),
    deleteMany: vi.fn(async () => { const count = prices.length; prices = []; return { count }; }),
    findMany: vi.fn(async () => [...prices]),
  },
  spendPool: {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => { for (const d of data) pools.push({ ...d, id: `pool${++nextId}` }); return { count: data.length }; }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const r = { ...data, id: `pool${++nextId}` }; pools.push(r); return r; }),
    deleteMany: vi.fn(async ({ where }: { where: { id: { notIn: string[] } } }) => { pools = pools.filter(p => where.id.notIn.includes(p.id)); return { count: 0 }; }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => pools.find(p => p.id === where.id) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(pools.find(p => p.id === where.id)!, data)),
    findMany: vi.fn(async () => [...pools].sort((a, b) => (a.sort as number) - (b.sort as number))),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
};
vi.mock('../../../db', () => ({ prisma: prismaMock }));

const { getSpendConfig, saveSpendConfig } = await import('./queries');

beforeEach(() => {
  settings = null; prices = []; pools = []; nextId = 0; raceOnUpsert = false;
  vi.clearAllMocks();
});

describe('ensureSeeded (via getSpendConfig)', () => {
  it('seeds the defaults once', async () => {
    const first = await getSpendConfig();
    expect(first.prices).toHaveLength(DEFAULT_PRICES.length);
    expect(first.pools.map(p => p.name)).toEqual(DEFAULT_POOLS.map(p => p.name));
    expect(first.config.modelMix).toEqual(DEFAULT_CONFIG.modelMix);
    await getSpendConfig();
    expect(prismaMock.spendPool.createMany).toHaveBeenCalledTimes(1);
    expect(pools).toHaveLength(DEFAULT_POOLS.length);
  });
  it('re-reads the row when a concurrent first read won the insert', async () => {
    raceOnUpsert = true;
    const r = await getSpendConfig();
    expect(r.pools).toHaveLength(DEFAULT_POOLS.length);
    expect(prismaMock.spendSettings.findUniqueOrThrow).toHaveBeenCalled();
  });
  it('does not re-seed once an admin has emptied the pools', async () => {
    await getSpendConfig();
    await saveSpendConfig({ config: DEFAULT_CONFIG, prices: [], pools: [] });
    const r = await getSpendConfig();
    expect(r.pools).toEqual([]);
    expect(r.prices).toEqual([]);
  });
});

describe('saveSpendConfig', () => {
  it('replaces prices, keeps the ids of pools it carries, and drops the rest', async () => {
    await getSpendConfig();
    const seeded = await saveSpendConfig({ config: DEFAULT_CONFIG, prices: DEFAULT_PRICES, pools: SAMPLE_POOLS });
    const [cursor, , infra] = seeded.pools;
    const saved = await saveSpendConfig({
      config: { ...DEFAULT_CONFIG, loadedCostUsd: 400000 },
      prices: [DEFAULT_PRICES[0]],
      pools: [{ ...cursor, annualUsd: 450000 }, { ...infra }, { ...SAMPLE_POOLS[1], name: 'Devin (new)' }],
    });
    expect(saved.config.loadedCostUsd).toBe(400000);
    expect(saved.prices).toHaveLength(1);
    const byName = Object.fromEntries(saved.pools.map(p => [p.name, p]));
    expect(byName.Cursor).toMatchObject({ id: cursor.id, annualUsd: 450000 });
    expect(byName['Inference box'].id).toBe(infra.id);
    expect(byName['Devin (new)'].id).not.toBe(seeded.pools[1].id);
    expect(byName.Devin).toBeUndefined();
  });
  it('creates a pool whose id no longer exists instead of failing', async () => {
    await getSpendConfig();
    const saved = await saveSpendConfig({ config: DEFAULT_CONFIG, prices: [], pools: [{ ...SAMPLE_POOLS[0], id: 'gone' }] });
    expect(saved.pools).toHaveLength(1);
    expect(saved.pools[0].id).not.toBe('gone');
  });
});
