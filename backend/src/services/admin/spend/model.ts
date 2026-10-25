/**
 * The spend model. Pure: the queries load token days,
 * prices, pools and settings, this turns them into cost. Every number is an
 * estimate for relative comparison, not accounting.
 *
 * - Metered providers (Claude) cost tokens × a dated price. token_usage_days
 *   has no model column yet (phase 2), so a provider's rows are priced at the
 *   blend `modelMix` names, or at its `*` price row.
 * - Flat-priced spend is a cost pool: a vendor contract (annualUsd) or an
 *   internal inference box fleet (boxes × boxCostUsd). termag carries a share
 *   of it (proportional to its users over the pool's population, a measured
 *   usage share, or all of it) and splits that over people. Providers a pool
 *   covers are never also metered.
 * - Poller-estimated token rows are counted and priced on the side, never in
 *   the totals.
 */

export const POOL_KINDS = ['contract', 'infra'] as const;
export const POOL_SHARES = ['proportional', 'usage', 'full'] as const;
export const POOL_ALLOCATIONS = ['even', 'by-tokens', 'by-usage'] as const;
export type PoolKind = typeof POOL_KINDS[number];
export type PoolShare = typeof POOL_SHARES[number];
export type PoolAllocation = typeof POOL_ALLOCATIONS[number];

/** Providers priced as another: a cloud session is Claude Code on the same models. */
export const PRICE_ALIAS: Record<string, string> = { 'claude-cloud': 'claude' };
/** The model a price row applies to when the token row names none. */
export const ANY_MODEL = '*';

export interface Price {
  provider: string;
  model: string;
  /** YYYY-MM-DD: applies to token days on or after it, until a later row for the same provider and model. */
  effectiveFrom: string;
  /** USD per million tokens. */
  input: number; output: number; cacheRead: number; cacheWrite: number;
}

export interface Pool {
  id: string;
  name: string;
  kind: PoolKind;
  providers: string[];
  /** contract: the yearly cost. */
  annualUsd: number | null;
  /** infra: boxes running (null = size from peak concurrency), each costing boxCostUsd a year and serving usersPerBox at once. */
  boxes: number | null;
  boxCostUsd: number | null;
  usersPerBox: number | null;
  share: PoolShare;
  /** share = usage: termag's measured fraction, 0 to 1. */
  shareValue: number | null;
  /** share = proportional: the people the pool is for (null = settings.orgHeadcount). */
  populationLabel: string | null;
  populationSize: number | null;
  allocation: PoolAllocation;
  /** Inclusive YYYY-MM-DD bounds; null = open. */
  startDate: string | null;
  endDate: string | null;
  note: string | null;
  sort: number;
}

export interface SpendConfig {
  loadedCostUsd: number;
  orgHeadcount: number;
  /** provider → model → weight, the assumed blend until rows carry a model. */
  modelMix: Record<string, Record<string, number>>;
}

export interface TokenDay {
  userId: string; provider: string; date: string; estimated: boolean;
  input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number;
}

export interface SpendUser { id: string; name: string }

export interface SpendInputs {
  /** Inclusive UTC day keys of the window. */
  days: string[];
  tokens: TokenDay[];
  prices: Price[];
  pools: Pool[];
  config: SpendConfig;
  /** Every termag user who existed by the window's end. */
  users: SpendUser[];
  /** Count only users active in the window (tokens or agent time). */
  activeOnly: boolean;
  /** userId → provider → agent milliseconds in the window (work_time_entries). */
  agentMs: Map<string, Map<string, number>>;
  /** pool id → peak concurrent users measured in the window, when known. */
  peakConcurrent: Map<string, number>;
}

const M = 1e6;
const tokensOf = (t: Pick<TokenDay, 'input' | 'output' | 'cacheRead' | 'cacheCreate' | 'reasoning'>) => t.input + t.output + t.cacheRead + t.cacheCreate + t.reasoning;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The row for (provider, model) in force on `date`, or null. */
export function priceOn(prices: Price[], provider: string, model: string, date: string): Price | null {
  let best: Price | null = null;
  for (const p of prices) {
    if (p.provider !== provider || p.model !== model || p.effectiveFrom > date) continue;
    if (!best || p.effectiveFrom > best.effectiveFrom) best = p;
  }
  return best;
}

/**
 * The price for a provider's model-less rows on `date`: the `modelMix` blend
 * when every model in it has a price, else the provider's `*` row, else null
 * (unpriced). Weights are normalised, so 4:1 and 0.8:0.2 are the same blend.
 */
export function blendedPrice(prices: Price[], mix: Record<string, number> | undefined, provider: string, date: string): Price | null {
  const weights = Object.entries(mix ?? {}).filter(([, w]) => w > 0);
  const sum = weights.reduce((s, [, w]) => s + w, 0);
  if (weights.length && sum > 0) {
    const rows = weights.map(([model, w]) => ({ p: priceOn(prices, provider, model, date), w: w / sum }));
    if (rows.every(r => r.p)) {
      const f = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => rows.reduce((s, r) => s + r.p![k] * r.w, 0);
      return { provider, model: ANY_MODEL, effectiveFrom: date, input: f('input'), output: f('output'), cacheRead: f('cacheRead'), cacheWrite: f('cacheWrite') };
    }
  }
  return priceOn(prices, provider, ANY_MODEL, date);
}

/** USD for one token row at a price. Reasoning tokens are billed as output. */
export function costOf(t: Pick<TokenDay, 'input' | 'output' | 'cacheRead' | 'cacheCreate' | 'reasoning'>, p: Price): number {
  return (t.input * p.input + (t.output + t.reasoning) * p.output + t.cacheRead * p.cacheRead + t.cacheCreate * p.cacheWrite) / M;
}

/** Nearest-rank percentile of an ascending list. */
function pct(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export interface PoolCost {
  id: string; name: string; kind: PoolKind; providers: string[];
  share: PoolShare; allocation: PoolAllocation;
  /** The pool's cost a year, before termag's share. */
  annualUsd: number;
  /** Days of the window the pool ran (its start and end dates). */
  daysInWindow: number;
  /** termag's fraction, 0 to 1. */
  shareFraction: number;
  populationLabel: string | null;
  population: number | null;
  /** termag's part of the pool's cost in the window. */
  costUsd: number;
  tokens: number;
  usdPerMTokens: number | null;
  /** People with tokens or agent time on the pool's providers in the window. */
  activeUsers: number;
  usdPerActiveUser: number | null;
  /** infra only. */
  infra: null | {
    boxes: number; fixedBoxes: boolean; boxCostUsd: number; usersPerBox: number;
    peakConcurrent: number | null; boxesNeeded: number | null; utilization: number | null;
    /** A seat at full load: boxCostUsd / 12 / usersPerBox. */
    seatUsdPerMonth: number;
  };
  warnings: string[];
}

export interface ProviderCost {
  provider: string;
  pricing: 'metered' | 'pool' | 'unpriced';
  pool: string | null;
  users: number;
  input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number; tokens: number;
  costUsd: number;
  usdPerMTokens: number | null;
  /** Cost over tokens without cache reads, which dominate the count. */
  usdPerMExcludingCacheReads: number | null;
  /** What the cache reads would have cost at the input price, minus what they cost. Metered only. */
  cacheSavingsUsd: number | null;
  /** Poller-estimated tokens and their cost at the same price, outside the totals. */
  estimatedTokens: number;
  estimatedCostUsd: number;
  /** The blend or row the window's last day was priced at. */
  priceUsed: Omit<Price, 'provider' | 'effectiveFrom'> | null;
}

export interface PersonCost {
  userId: string; name: string; active: boolean;
  tokens: number;
  meteredUsd: number;
  /** pool id → USD. */
  pools: Record<string, number>;
  poolUsd: number;
  totalUsd: number;
  annualizedUsd: number;
  /** annualizedUsd / loadedCostUsd. */
  shareOfLoaded: number;
  topProvider: string | null;
}

export interface SpendReport {
  window: { since: string; until: string; days: number };
  denominator: { mode: 'all' | 'active'; users: number; allUsers: number; activeUsers: number };
  config: SpendConfig;
  totals: {
    meteredUsd: number; poolUsd: number; totalUsd: number;
    perHeadUsd: number | null; perHeadMonthlyUsd: number | null;
    annualizedUsd: number; shareOfLoaded: number | null;
    tokens: number; usdPerMTokens: number | null;
    estimatedTokens: number; estimatedCostUsd: number;
  };
  distribution: { p50: number | null; p90: number | null; mean: number | null; max: number | null };
  providers: ProviderCost[];
  pools: PoolCost[];
  people: PersonCost[];
  /** Providers with real tokens and neither a price nor a pool. */
  unpriced: string[];
}

function daysWithin(days: string[], start: string | null, end: string | null): number {
  return days.filter(d => (!start || d >= start) && (!end || d <= end)).length;
}

/** Split `total` over `ids` by `weight`; evenly when every weight is zero. */
function allocate(total: number, ids: string[], weight: (id: string) => number): Map<string, number> {
  const out = new Map<string, number>();
  if (!ids.length || total === 0) { for (const id of ids) out.set(id, 0); return out; }
  const w = ids.map(weight);
  const sum = w.reduce((s, x) => s + x, 0);
  ids.forEach((id, i) => out.set(id, sum > 0 ? total * w[i] / sum : total / ids.length));
  return out;
}

export function computeSpend(inp: SpendInputs): SpendReport {
  const { days, config } = inp;
  const since = days[0]; const until = days[days.length - 1];
  const poolOf = new Map<string, Pool>();
  for (const p of inp.pools) for (const prov of p.providers) if (!poolOf.has(prov)) poolOf.set(prov, p);

  // Tokens per (user, provider), real and estimated; metered cost day by day (prices are dated).
  type Acc = { input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number; tokens: number; cost: number; cacheReadCost: number; savings: number; estTokens: number; estCost: number; users: Set<string> };
  const blank = (): Acc => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, tokens: 0, cost: 0, cacheReadCost: 0, savings: 0, estTokens: 0, estCost: 0, users: new Set() });
  const byProvider = new Map<string, Acc>();
  const userProv = new Map<string, Map<string, { tokens: number; cost: number }>>();
  const priceCache = new Map<string, Price | null>();
  const priceFor = (provider: string, date: string) => {
    const key = `${provider}\u0000${date}`;
    if (!priceCache.has(key)) {
      const base = PRICE_ALIAS[provider] ?? provider;
      priceCache.set(key, blendedPrice(inp.prices, config.modelMix[base], base, date));
    }
    return priceCache.get(key)!;
  };
  const unpriced = new Set<string>();

  for (const t of inp.tokens) {
    const n = tokensOf(t);
    if (n <= 0) continue;
    const a = byProvider.get(t.provider) ?? blank(); byProvider.set(t.provider, a);
    const metered = !poolOf.has(t.provider);
    const price = metered ? priceFor(t.provider, t.date) : null;
    if (t.estimated) {
      a.estTokens += n;
      if (price) a.estCost += costOf(t, price);
      continue;
    }
    a.input += t.input; a.output += t.output; a.cacheRead += t.cacheRead; a.cacheCreate += t.cacheCreate; a.reasoning += t.reasoning; a.tokens += n;
    a.users.add(t.userId);
    let cost = 0;
    if (price) {
      cost = costOf(t, price);
      a.cacheReadCost += t.cacheRead * price.cacheRead / M;
      a.savings += t.cacheRead * (price.input - price.cacheRead) / M;
    } else if (metered) unpriced.add(t.provider);
    a.cost += cost;
    const up = userProv.get(t.userId) ?? new Map(); userProv.set(t.userId, up);
    const cell = up.get(t.provider) ?? { tokens: 0, cost: 0 }; up.set(t.provider, cell);
    cell.tokens += n; cell.cost += cost;
  }

  const msOn = (userId: string, providers: string[]) => providers.reduce((s, p) => s + (inp.agentMs.get(userId)?.get(p) ?? 0), 0);
  const tokensOn = (userId: string, providers: string[]) => providers.reduce((s, p) => s + (userProv.get(userId)?.get(p)?.tokens ?? 0), 0);
  const allProviders = (userId: string) => [...(userProv.get(userId)?.keys() ?? []), ...(inp.agentMs.get(userId)?.keys() ?? [])];
  const isActive = (userId: string) => (userProv.get(userId)?.size ?? 0) > 0 || [...(inp.agentMs.get(userId)?.values() ?? [])].some(ms => ms > 0);

  const allUsers = inp.users.length;
  const activeIds = inp.users.filter(u => isActive(u.id)).map(u => u.id);
  const denomIds = inp.activeOnly ? activeIds : inp.users.map(u => u.id);

  // Pools: termag's part of each, then split over the denominator.
  const poolAlloc = new Map<string, Map<string, number>>();
  const pools: PoolCost[] = [...inp.pools].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)).map(p => {
    const warnings: string[] = [];
    let infra: PoolCost['infra'] = null;
    let annualUsd = 0;
    if (p.kind === 'infra') {
      const boxCost = p.boxCostUsd ?? 0;
      const perBox = p.usersPerBox && p.usersPerBox > 0 ? p.usersPerBox : 1;
      const peak = inp.peakConcurrent.get(p.id) ?? null;
      const needed = peak == null ? null : Math.max(1, Math.ceil(peak / perBox));
      const boxes = p.boxes ?? needed ?? 1;
      annualUsd = boxes * boxCost;
      if (needed != null && p.boxes != null && needed > p.boxes) warnings.push(`peak concurrency needs ${needed} boxes; ${p.boxes} configured`);
      infra = {
        boxes, fixedBoxes: p.boxes != null, boxCostUsd: boxCost, usersPerBox: perBox,
        peakConcurrent: peak, boxesNeeded: needed, utilization: peak == null ? null : peak / (boxes * perBox),
        seatUsdPerMonth: round2(boxCost / 12 / perBox),
      };
    } else {
      annualUsd = p.annualUsd ?? 0;
    }
    const daysIn = daysWithin(days, p.startDate, p.endDate);
    let shareFraction = 1;
    let population: number | null = null;
    if (p.share === 'proportional') {
      population = p.populationSize ?? config.orgHeadcount;
      shareFraction = population > 0 ? Math.min(1, allUsers / population) : 1;
      if (population > 0 && allUsers > population) warnings.push(`more termag users (${allUsers}) than the pool's population (${population}); share capped at 100%`);
    } else if (p.share === 'usage') {
      shareFraction = Math.min(1, Math.max(0, p.shareValue ?? 0));
      if (p.shareValue == null) warnings.push('usage share not set; counted as 0');
    }
    const costUsd = annualUsd * daysIn / 365 * shareFraction;
    const tokens = p.providers.reduce((s, prov) => s + (byProvider.get(prov)?.tokens ?? 0), 0);
    const poolActive = inp.users.filter(u => tokensOn(u.id, p.providers) > 0 || msOn(u.id, p.providers) > 0).length;
    const weight = p.allocation === 'by-tokens' ? (id: string) => tokensOn(id, p.providers)
      : p.allocation === 'by-usage' ? (id: string) => msOn(id, p.providers)
      : () => 1;
    poolAlloc.set(p.id, allocate(costUsd, denomIds, weight));
    return {
      id: p.id, name: p.name, kind: p.kind, providers: p.providers, share: p.share, allocation: p.allocation,
      annualUsd, daysInWindow: daysIn, shareFraction, populationLabel: p.populationLabel, population,
      costUsd: round2(costUsd), tokens, usdPerMTokens: tokens > 0 ? costUsd / (tokens / M) : null,
      activeUsers: poolActive, usdPerActiveUser: poolActive > 0 ? round2(costUsd / poolActive) : null,
      infra, warnings,
    };
  });

  const loaded = config.loadedCostUsd;
  const annualize = (usd: number) => usd * 365 / days.length;
  const nameOf = new Map(inp.users.map(u => [u.id, u.name]));
  const people: PersonCost[] = denomIds.map(id => {
    const up = userProv.get(id);
    const meteredUsd = [...(up?.values() ?? [])].reduce((s, c) => s + c.cost, 0);
    const poolsOut: Record<string, number> = {};
    let poolUsd = 0;
    for (const p of pools) { const v = poolAlloc.get(p.id)?.get(id) ?? 0; poolsOut[p.id] = round2(v); poolUsd += v; }
    const totalUsd = meteredUsd + poolUsd;
    const top = [...(up?.entries() ?? [])].sort((a, b) => b[1].tokens - a[1].tokens)[0]?.[0]
      ?? allProviders(id).sort((a, b) => msOn(id, [b]) - msOn(id, [a]))[0] ?? null;
    return {
      userId: id, name: nameOf.get(id) ?? id, active: isActive(id),
      tokens: [...(up?.values() ?? [])].reduce((s, c) => s + c.tokens, 0),
      meteredUsd: round2(meteredUsd), pools: poolsOut, poolUsd: round2(poolUsd), totalUsd: round2(totalUsd),
      annualizedUsd: round2(annualize(totalUsd)), shareOfLoaded: loaded > 0 ? annualize(totalUsd) / loaded : 0,
      topProvider: top,
    };
  }).sort((a, b) => b.totalUsd - a.totalUsd || a.name.localeCompare(b.name));

  // Providers: metered at their price; pool-covered at the pool's cost split by tokens.
  const providers: ProviderCost[] = [...byProvider.entries()].map(([provider, a]) => {
    const pool = poolOf.get(provider) ?? null;
    let costUsd = a.cost;
    let pricing: ProviderCost['pricing'] = 'metered';
    // Unpriced only when nothing was priced: a provider whose price row starts mid-window stays metered
    // for the days it covers (and is still listed in `unpriced`), so the totals match the people table.
    if (pool) {
      pricing = 'pool';
      const pc = pools.find(x => x.id === pool.id)!;
      costUsd = pc.tokens > 0 ? pc.costUsd * a.tokens / pc.tokens : 0;
    } else if (a.cost === 0 && (unpriced.has(provider) || (a.tokens === 0 && !priceFor(provider, until)))) pricing = 'unpriced';
    const last = pricing === 'metered' ? priceFor(provider, until) : null;
    const noCache = a.tokens - a.cacheRead;
    return {
      provider, pricing, pool: pool?.name ?? null, users: a.users.size,
      input: a.input, output: a.output, cacheRead: a.cacheRead, cacheCreate: a.cacheCreate, reasoning: a.reasoning, tokens: a.tokens,
      costUsd: round2(costUsd),
      usdPerMTokens: a.tokens > 0 && pricing !== 'unpriced' ? costUsd / (a.tokens / M) : null,
      usdPerMExcludingCacheReads: noCache > 0 && pricing !== 'unpriced' ? (pricing === 'metered' ? costUsd - a.cacheReadCost : costUsd) / (noCache / M) : null,
      cacheSavingsUsd: pricing === 'metered' ? round2(a.savings) : null,
      estimatedTokens: a.estTokens, estimatedCostUsd: round2(a.estCost),
      priceUsed: last ? { model: last.model, input: last.input, output: last.output, cacheRead: last.cacheRead, cacheWrite: last.cacheWrite } : null,
    };
  }).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);

  const meteredUsd = providers.filter(p => p.pricing === 'metered').reduce((s, p) => s + p.costUsd, 0);
  const poolUsd = pools.reduce((s, p) => s + p.costUsd, 0);
  const totalUsd = meteredUsd + poolUsd;
  const tokens = providers.reduce((s, p) => s + p.tokens, 0);
  const n = denomIds.length;
  const costs = people.map(p => p.totalUsd).sort((a, b) => a - b);
  return {
    window: { since, until, days: days.length },
    denominator: { mode: inp.activeOnly ? 'active' : 'all', users: n, allUsers, activeUsers: activeIds.length },
    config,
    totals: {
      meteredUsd: round2(meteredUsd), poolUsd: round2(poolUsd), totalUsd: round2(totalUsd),
      perHeadUsd: n ? round2(totalUsd / n) : null,
      perHeadMonthlyUsd: n ? round2(totalUsd / n * 365 / 12 / days.length) : null,
      annualizedUsd: round2(annualize(totalUsd)),
      shareOfLoaded: n && loaded > 0 ? annualize(totalUsd) / (n * loaded) : null,
      tokens, usdPerMTokens: tokens > 0 ? totalUsd / (tokens / M) : null,
      estimatedTokens: providers.reduce((s, p) => s + p.estimatedTokens, 0),
      estimatedCostUsd: round2(providers.reduce((s, p) => s + p.estimatedCostUsd, 0)),
    },
    distribution: {
      p50: pct(costs, 0.5), p90: pct(costs, 0.9),
      mean: costs.length ? round2(costs.reduce((s, x) => s + x, 0) / costs.length) : null,
      max: costs.length ? costs[costs.length - 1] : null,
    },
    providers, pools, people,
    unpriced: [...unpriced].sort(),
  };
}

export interface SpendWeek { week: string; days: number; metered: Record<string, number>; pools: Record<string, number>; totalUsd: number }

/**
 * Weekly cost (Monday UTC weeks) over `days`: metered by provider and each
 * pool's termag share. Box counts are the configured ones (or 1): peak
 * concurrency is a per-window measurement.
 */
export function spendTrend(inp: Omit<SpendInputs, 'activeOnly' | 'agentMs' | 'peakConcurrent'>): SpendWeek[] {
  const weekOf = (d: string) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    const dow = (new Date(t).getUTCDay() + 6) % 7;
    return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
  };
  const weeks = new Map<string, string[]>();
  for (const d of inp.days) { const w = weekOf(d); weeks.set(w, [...(weeks.get(w) ?? []), d]); }
  const byDay = new Map<string, TokenDay[]>();
  for (const t of inp.tokens) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  return [...weeks.entries()].map(([week, wdays]) => {
    const r = computeSpend({
      ...inp, days: wdays, tokens: wdays.flatMap(d => byDay.get(d) ?? []),
      activeOnly: false, agentMs: new Map(), peakConcurrent: new Map(),
    });
    const metered: Record<string, number> = {};
    for (const p of r.providers) if (p.pricing === 'metered' && p.costUsd > 0) metered[p.provider] = p.costUsd;
    const pools: Record<string, number> = {};
    for (const p of r.pools) pools[p.name] = p.costUsd;
    return { week, days: wdays.length, metered, pools, totalUsd: r.totals.totalUsd };
  });
}
