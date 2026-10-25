import { describe, it, expect } from 'vitest';
import { blendedPrice, computeSpend, costOf, priceOn, spendTrend, type Pool, type SpendInputs, type TokenDay } from './model';
import { DEFAULT_CONFIG, DEFAULT_PRICES, parseConfig, parsePools, parsePrices } from './config';
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


const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const tok = (userId: string, provider: string, date: string, t: Partial<TokenDay> = {}): TokenDay =>
  ({ userId, provider, date, estimated: false, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, ...t });
const pools = (): Pool[] => SAMPLE_POOLS.map((p, i) => ({ ...p, id: `pool${i}` }));
const users = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, name: `user${i}` }));

function inputs(over: Partial<SpendInputs> = {}): SpendInputs {
  return {
    days: days('2026-10-01', 30), tokens: [], prices: DEFAULT_PRICES, pools: pools(), config: DEFAULT_CONFIG,
    users: users(60), activeOnly: false, agentMs: new Map(), peakConcurrent: new Map(), ...over,
  };
}

describe('prices', () => {
  it('picks the latest row in force on the day', () => {
    const prices = [
      { provider: 'claude', model: 'm', effectiveFrom: '2026-01-01', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      { provider: 'claude', model: 'm', effectiveFrom: '2026-10-10', input: 2, output: 2, cacheRead: 2, cacheWrite: 2 },
    ];
    expect(priceOn(prices, 'claude', 'm', '2026-10-09')?.input).toBe(1);
    expect(priceOn(prices, 'claude', 'm', '2026-10-10')?.input).toBe(2);
    expect(priceOn(prices, 'claude', 'm', '2025-12-31')).toBeNull();
  });

  it('blends the seeded 80/20 Opus 5.5 / Fable 5.1 mix', () => {
    const p = blendedPrice(DEFAULT_PRICES, DEFAULT_CONFIG.modelMix.claude, 'claude', '2026-10-21')!;
    expect(p.input).toBeCloseTo(5.2);
    expect(p.output).toBeCloseTo(26);
    expect(p.cacheRead).toBeCloseTo(0.21);
    expect(p.cacheWrite).toBeCloseTo(6.5);
  });

  it('normalises weights and falls back to the * row when a mixed model has no price', () => {
    const a = blendedPrice(DEFAULT_PRICES, { 'claude-opus-5-5': 4, 'claude-fable-5-1': 1 }, 'claude', '2026-10-21')!;
    expect(a.output).toBeCloseTo(26);
    const star = [{ provider: 'claude', model: '*', effectiveFrom: '2026-01-01', input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }];
    expect(blendedPrice(star, { 'no-such-model': 1 }, 'claude', '2026-10-21')?.input).toBe(9);
    expect(blendedPrice([], undefined, 'claude', '2026-10-21')).toBeNull();
  });

  it('bills reasoning as output', () => {
    const p = { provider: 'x', model: '*', effectiveFrom: '2026-01-01', input: 1, output: 10, cacheRead: 0.1, cacheWrite: 2 };
    expect(costOf({ input: 1e6, output: 1e6, reasoning: 1e6, cacheRead: 1e6, cacheCreate: 1e6 }, p)).toBeCloseTo(1 + 20 + 0.1 + 2);
  });
});

describe('computeSpend', () => {
  it('works the example through: Claude 30 days, 60 users, contracts at 60/120, one inference box', () => {
    // The staging snapshot's 30-day Claude totals, on one user.
    const tokens = [tok('u0', 'claude', '2026-10-15', { input: 0.3e6, output: 33.6e6, cacheRead: 9089.2e6, cacheCreate: 376.7e6 })];
    const r = computeSpend(inputs({ tokens }));
    const claude = r.providers.find(p => p.provider === 'claude')!;
    expect(claude.pricing).toBe('metered');
    // The doc's $5,238 is from the exact rows; these totals are rounded to 0.1 M.
    expect(Math.abs(claude.costUsd - 5238)).toBeLessThan(10);
    const cursor = r.pools.find(p => p.name === 'Cursor')!;
    expect(cursor.shareFraction).toBeCloseTo(60 / 120);
    expect(cursor.costUsd).toBeCloseTo(120_000 * 30 / 365 * 60 / 120, 0);
    const box = r.pools.find(p => p.name === 'Inference box')!;
    expect(box.costUsd).toBeCloseTo(50_000 * 30 / 365, 0);
    expect(box.infra).toMatchObject({ boxes: 1, fixedBoxes: true, seatUsdPerMonth: 138.89 });
    expect(r.denominator).toEqual({ mode: 'all', users: 60, allUsers: 60, activeUsers: 1 });
    expect(r.totals.totalUsd).toBeCloseTo(claude.costUsd + cursor.costUsd + r.pools[1].costUsd + box.costUsd, 1);
    // The year's spend over 60 people at the loaded cost.
    expect(r.totals.shareOfLoaded!).toBeCloseTo(r.totals.annualizedUsd / (60 * DEFAULT_CONFIG.loadedCostUsd), 6);
  });

  it('never meters a provider a pool covers, and splits the pool by tokens', () => {
    const tokens = [
      tok('u0', 'pi', '2026-10-02', { input: 300e6 }),
      tok('u1', 'pi', '2026-10-02', { input: 100e6 }),
    ];
    const prices = [...DEFAULT_PRICES, { provider: 'pi', model: '*', effectiveFrom: '2026-01-01', input: 100, output: 100, cacheRead: 100, cacheWrite: 100 }];
    const r = computeSpend(inputs({ tokens, prices }));
    const dark = r.providers.find(p => p.provider === 'pi')!;
    expect(dark.pricing).toBe('pool');
    expect(dark.pool).toBe('Inference box');
    const box = r.pools.find(p => p.name === 'Inference box')!;
    expect(dark.costUsd).toBeCloseTo(box.costUsd, 1);
    expect(box.usdPerMTokens).toBeCloseTo(box.costUsd / 400, 3);
    const u0 = r.people.find(p => p.userId === 'u0')!; const u1 = r.people.find(p => p.userId === 'u1')!;
    expect(u0.pools[box.id] / u1.pools[box.id]).toBeCloseTo(3, 1);
    expect(r.people.find(p => p.userId === 'u5')!.pools[box.id]).toBe(0);
  });

  it('spreads contracts evenly over the denominator, all users or only active ones', () => {
    const tokens = [tok('u0', 'claude', '2026-10-02', { output: 1e6 }), tok('u1', 'claude', '2026-10-02', { output: 1e6 })];
    const all = computeSpend(inputs({ tokens }));
    const active = computeSpend(inputs({ tokens, activeOnly: true }));
    const cursorAll = all.pools.find(p => p.name === 'Cursor')!;
    expect(all.people).toHaveLength(60);
    expect(all.people.find(p => p.userId === 'u9')!.pools[cursorAll.id]).toBeCloseTo(cursorAll.costUsd / 60, 1);
    expect(active.people.map(p => p.userId).sort()).toEqual(['u0', 'u1']);
    // The share stays termag users over population: the toggle changes who carries it, not how much.
    expect(active.pools.find(p => p.name === 'Cursor')!.costUsd).toBe(cursorAll.costUsd);
    expect(active.people[0].pools[cursorAll.id]).toBeCloseTo(cursorAll.costUsd / 2, 1);
    expect(active.totals.perHeadUsd).toBeCloseTo(active.totals.totalUsd / 2, 1);
  });

  it('counts agent time as activity and allocates by-usage pools by it', () => {
    const p: Pool[] = [{ ...pools()[0], allocation: 'by-usage' }];
    const agentMs = new Map([['u0', new Map([['cursor', 3_000]])], ['u1', new Map([['cursor', 1_000]])]]);
    const r = computeSpend(inputs({ pools: p, agentMs, activeOnly: true }));
    expect(r.denominator.activeUsers).toBe(2);
    expect(r.pools[0].activeUsers).toBe(2);
    expect(r.people.find(x => x.userId === 'u0')!.pools[p[0].id] / r.people.find(x => x.userId === 'u1')!.pools[p[0].id]).toBeCloseTo(3, 1);
    expect(r.people[0].topProvider).toBe('cursor');
  });

  it('applies share rules, caps proportional at 100% and prorates pool dates', () => {
    const base = pools()[0];
    const usage = computeSpend(inputs({ pools: [{ ...base, share: 'usage', shareValue: 0.25 }] }));
    expect(usage.pools[0].costUsd).toBeCloseTo(120_000 * 30 / 365 * 0.25, 0);
    const capped = computeSpend(inputs({ pools: [{ ...base, populationSize: 10 }] }));
    expect(capped.pools[0].shareFraction).toBe(1);
    expect(capped.pools[0].warnings[0]).toMatch(/capped/);
    const late = computeSpend(inputs({ pools: [{ ...base, share: 'full', startDate: '2026-10-21' }] }));
    expect(late.pools[0].daysInWindow).toBe(10);
    expect(late.pools[0].costUsd).toBeCloseTo(120_000 * 10 / 365, 0);
  });

  it('sizes an infra pool from peak concurrency when boxes is unset, and warns when the fixed count is short', () => {
    const infra = pools()[2];
    const sized = computeSpend(inputs({ pools: [{ ...infra, boxes: null }], peakConcurrent: new Map([[infra.id, 45]]) }));
    expect(sized.pools[0].infra).toMatchObject({ boxes: 2, fixedBoxes: false, boxesNeeded: 2, utilization: 0.75 });
    const short = computeSpend(inputs({ pools: [infra], peakConcurrent: new Map([[infra.id, 45]]) }));
    expect(short.pools[0].infra!.boxes).toBe(1);
    expect(short.pools[0].warnings[0]).toMatch(/needs 2 boxes/);
  });

  it('keeps poller estimates and unpriced providers out of the totals', () => {
    const tokens = [
      tok('u0', 'claude', '2026-10-02', { output: 1e6, estimated: true }),
      tok('u0', 'codex', '2026-10-02', { output: 1e6 }),
    ];
    const r = computeSpend(inputs({ tokens, pools: [] }));
    expect(r.totals.meteredUsd).toBe(0);
    expect(r.totals.estimatedCostUsd).toBeCloseTo(26, 1);
    expect(r.unpriced).toEqual(['codex']);
    expect(r.providers.find(p => p.provider === 'codex')!.pricing).toBe('unpriced');
    // Codex tokens still make the user active.
    expect(r.denominator.activeUsers).toBe(1);
  });

  it('keeps a provider whose price starts mid-window metered, and its totals match the people', () => {
    const prices = [{ provider: 'codex', model: '*', effectiveFrom: '2026-10-15', input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 }];
    const tokens = [
      tok('u0', 'codex', '2026-10-02', { output: 1e6 }),
      tok('u0', 'codex', '2026-10-20', { output: 1e6 }),
    ];
    const r = computeSpend(inputs({ tokens, prices, pools: [] }));
    const codex = r.providers.find(p => p.provider === 'codex')!;
    expect(codex.pricing).toBe('metered');
    expect(codex.costUsd).toBeCloseTo(10, 2);
    expect(r.totals.meteredUsd).toBeCloseTo(10, 2);
    expect(r.people.reduce((s, p) => s + p.meteredUsd, 0)).toBeCloseTo(r.totals.meteredUsd, 2);
    // The uncovered day is still flagged.
    expect(r.unpriced).toEqual(['codex']);
  });

  it('prices claude-cloud rows as claude', () => {
    const r = computeSpend(inputs({ tokens: [tok('u0', 'claude-cloud', '2026-10-02', { output: 1e6 })], pools: [] }));
    expect(r.providers[0]).toMatchObject({ provider: 'claude-cloud', pricing: 'metered' });
    expect(r.providers[0].costUsd).toBeCloseTo(26, 1);
  });

  it('reports cache savings and $/M without cache reads', () => {
    const r = computeSpend(inputs({ tokens: [tok('u0', 'claude', '2026-10-02', { cacheRead: 10e6, output: 1e6 })], pools: [] }));
    const c = r.providers[0];
    expect(c.cacheSavingsUsd).toBeCloseTo(10 * (5.2 - 0.21), 1);
    expect(c.usdPerMExcludingCacheReads).toBeCloseTo(26, 1);
    expect(c.usdPerMTokens).toBeCloseTo((26 + 2.1) / 11, 2);
  });

  it('gives a distribution over the denominator', () => {
    const tokens = [1, 2, 3, 4].map(i => tok(`u${i}`, 'claude', '2026-10-02', { output: i * 1e6 }));
    const r = computeSpend(inputs({ tokens, pools: [], users: users(5) }));
    expect(r.distribution.max).toBeCloseTo(104, 0);
    expect(r.distribution.p50).toBeCloseTo(52, 0);
    expect(r.distribution.mean).toBeCloseTo(52, 0);
  });
});

describe('spendTrend', () => {
  it('buckets Monday weeks with partial edges', () => {
    const w = spendTrend({ days: days('2026-10-01', 14), tokens: [tok('u0', 'claude', '2026-10-06', { output: 1e6 })], prices: DEFAULT_PRICES, pools: pools(), config: DEFAULT_CONFIG, users: users(60) });
    expect(w.map(x => [x.week, x.days])).toEqual([['2026-09-28', 4], ['2026-10-05', 7], ['2026-10-12', 3]]);
    expect(w[1].metered.claude).toBeCloseTo(26, 1);
    expect(w[1].pools['Inference box']).toBeCloseTo(50_000 * 7 / 365, 0);
  });
});

describe('config validation', () => {
  it('accepts the defaults round-trip', () => {
    expect(parseConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    expect(parsePrices(DEFAULT_PRICES)).toEqual(DEFAULT_PRICES);
    expect(parsePools(SAMPLE_POOLS)).toEqual(SAMPLE_POOLS);
  });
  it('rejects bad input', () => {
    expect(parseConfig({ loadedCostUsd: 0, orgHeadcount: 10 })).toHaveProperty('error');
    expect(parsePrices([{ provider: 'claude', effectiveFrom: 'soon', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }])).toHaveProperty('error');
    expect(parsePrices([DEFAULT_PRICES[0], DEFAULT_PRICES[0]])).toEqual({ error: expect.stringMatching(/duplicate/) });
    expect(parsePools([{ ...SAMPLE_POOLS[0], annualUsd: null }])).toEqual({ error: expect.stringMatching(/annualUsd/) });
    expect(parsePools([SAMPLE_POOLS[0], { ...SAMPLE_POOLS[1], providers: ['cursor'] }])).toEqual({ error: expect.stringMatching(/two pools/) });
    expect(parsePools([{ ...SAMPLE_POOLS[0], share: 'usage', shareValue: 2 }])).toHaveProperty('error');
    expect(parsePools([SAMPLE_POOLS[0], { ...SAMPLE_POOLS[1], name: 'cursor' }])).toEqual({ error: expect.stringMatching(/two pools are named/) });
    expect(parsePools([{ ...SAMPLE_POOLS[0], id: 'p1' }, { ...SAMPLE_POOLS[1], id: 'p1' }])).toEqual({ error: expect.stringMatching(/appears twice/) });
  });
  it('drops fields that do not apply to the kind or share', () => {
    const [p] = parsePools([{ ...SAMPLE_POOLS[0], boxes: 3, shareValue: 0.5 }]) as Exclude<ReturnType<typeof parsePools>, { error: string }>;
    expect(p.boxes).toBeNull();
    expect(p.shareValue).toBeNull();
  });
});
