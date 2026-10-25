/**
 * Spend model defaults (seeded once) and validation of the admin's edits.
 * Pure.
 */
import { POOL_ALLOCATIONS, POOL_KINDS, POOL_SHARES, type Pool, type Price, type SpendConfig } from './model';

/** Anthropic list prices per million tokens; cache write is the 5-minute rate (1.25 × input). Bedrock can differ: admins correct the table. */
export const DEFAULT_PRICES: Price[] = [
  { provider: 'claude', model: 'claude-opus-5-5', effectiveFrom: '2026-01-01', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { provider: 'claude', model: 'claude-fable-5-1', effectiveFrom: '2026-01-01', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { provider: 'claude', model: 'claude-sonnet-5-5', effectiveFrom: '2026-01-01', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { provider: 'claude', model: 'claude-haiku-5-5', effectiveFrom: '2026-01-01', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { provider: 'claude', model: 'claude-opus-4-8', effectiveFrom: '2026-01-01', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
];

export const DEFAULT_CONFIG: SpendConfig = {
  loadedCostUsd: 150_000,
  orgHeadcount: 100,
  modelMix: { claude: { 'claude-opus-5-5': 0.8, 'claude-fable-5-1': 0.2 } },
};

// No pools are seeded: an admin adds each contract or infrastructure cost
// (its yearly price, the population it covers, how it is shared) on the Spend
// tab. The headcount and loaded cost above are placeholders to edit there too.
export const DEFAULT_POOLS: Array<Omit<Pool, 'id'>> = [];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
type Err = { error: string };

const num = (v: unknown, name: string, { min = 0, int = false, nullable = false } = {}): number | null | Err => {
  if (v === null || v === undefined || v === '') return nullable ? null : { error: `${name} is required` };
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) return { error: `${name} must be ${int ? 'an integer' : 'a number'} ≥ ${min}` };
  return n;
};
const isErr = (v: unknown): v is Err => typeof v === 'object' && v !== null && 'error' in v;
const day = (v: unknown, name: string): string | null | Err => {
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'string' && DAY.test(v) ? v : { error: `${name} must be YYYY-MM-DD` };
};
const text = (v: unknown, max = 200): string | null => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

export function parseConfig(raw: unknown): SpendConfig | Err {
  const b = (raw ?? {}) as Record<string, unknown>;
  const loaded = num(b.loadedCostUsd, 'loadedCostUsd', { min: 1 }); if (isErr(loaded)) return loaded;
  const head = num(b.orgHeadcount, 'orgHeadcount', { min: 1, int: true }); if (isErr(head)) return head;
  const mixRaw = b.modelMix ?? {};
  if (typeof mixRaw !== 'object' || Array.isArray(mixRaw)) return { error: 'modelMix must be { provider: { model: weight } }' };
  const modelMix: SpendConfig['modelMix'] = {};
  for (const [prov, models] of Object.entries(mixRaw as Record<string, unknown>)) {
    if (!SLUG.test(prov) || typeof models !== 'object' || models === null || Array.isArray(models)) return { error: `modelMix.${prov} must be { model: weight }` };
    const out: Record<string, number> = {};
    for (const [model, w] of Object.entries(models as Record<string, unknown>)) {
      const n = num(w, `modelMix.${prov}.${model}`); if (isErr(n)) return n;
      if (!SLUG.test(model)) return { error: `bad model id ${model}` };
      if (n! > 0) out[model] = n!;
    }
    if (Object.keys(out).length) modelMix[prov] = out;
  }
  return { loadedCostUsd: loaded!, orgHeadcount: head!, modelMix };
}

export function parsePrices(raw: unknown): Price[] | Err {
  if (!Array.isArray(raw)) return { error: 'prices must be a list' };
  const out: Price[] = [];
  const seen = new Set<string>();
  for (const [i, r] of raw.entries()) {
    const b = (r ?? {}) as Record<string, unknown>;
    const provider = typeof b.provider === 'string' ? b.provider.trim() : '';
    const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : '*';
    if (!SLUG.test(provider)) return { error: `prices[${i}].provider is required (lowercase id)` };
    if (model !== '*' && !SLUG.test(model)) return { error: `prices[${i}].model must be a model id or *` };
    const eff = day(b.effectiveFrom, `prices[${i}].effectiveFrom`); if (isErr(eff)) return eff;
    if (!eff) return { error: `prices[${i}].effectiveFrom is required` };
    const f: Record<string, number> = {};
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const n = num(b[k], `prices[${i}].${k}`); if (isErr(n)) return n; f[k] = n!;
    }
    const key = `${provider}/${model}/${eff}`;
    if (seen.has(key)) return { error: `duplicate price ${key}` };
    seen.add(key);
    out.push({ provider, model, effectiveFrom: eff, input: f.input, output: f.output, cacheRead: f.cacheRead, cacheWrite: f.cacheWrite });
  }
  return out;
}

export function parsePools(raw: unknown): Array<Omit<Pool, 'id'> & { id?: string }> | Err {
  if (!Array.isArray(raw)) return { error: 'pools must be a list' };
  const out: Array<Omit<Pool, 'id'> & { id?: string }> = [];
  const providers = new Set<string>();
  const names = new Set<string>(); const ids = new Set<string>();
  for (const [i, r] of raw.entries()) {
    const b = (r ?? {}) as Record<string, unknown>;
    const at = `pools[${i}]`;
    const name = text(b.name, 80); if (!name) return { error: `${at}.name is required` };
    // Names key the weekly trend's series; ids are what a save updates in place.
    if (names.has(name.toLowerCase())) return { error: `two pools are named ${name}` };
    names.add(name.toLowerCase());
    if (typeof b.id === 'string' && b.id) { if (ids.has(b.id)) return { error: `${at}: pool id ${b.id} appears twice` }; ids.add(b.id); }
    const kind = b.kind as Pool['kind'];
    if (!POOL_KINDS.includes(kind)) return { error: `${at}.kind must be ${POOL_KINDS.join(' or ')}` };
    const share = (b.share ?? 'proportional') as Pool['share'];
    if (!POOL_SHARES.includes(share)) return { error: `${at}.share must be one of ${POOL_SHARES.join(', ')}` };
    const allocation = (b.allocation ?? 'even') as Pool['allocation'];
    if (!POOL_ALLOCATIONS.includes(allocation)) return { error: `${at}.allocation must be one of ${POOL_ALLOCATIONS.join(', ')}` };
    const provs = Array.isArray(b.providers) ? b.providers : typeof b.providers === 'string' ? b.providers.split(',') : [];
    const list = [...new Set(provs.map(p => String(p).trim()).filter(Boolean))];
    if (!list.length || !list.every(p => SLUG.test(p))) return { error: `${at}.providers must list provider ids` };
    for (const p of list) { if (providers.has(p)) return { error: `provider ${p} is in two pools` }; providers.add(p); }
    const annualUsd = num(b.annualUsd, `${at}.annualUsd`, { nullable: true }); if (isErr(annualUsd)) return annualUsd;
    const boxes = num(b.boxes, `${at}.boxes`, { int: true, min: 1, nullable: true }); if (isErr(boxes)) return boxes;
    const boxCostUsd = num(b.boxCostUsd, `${at}.boxCostUsd`, { nullable: true }); if (isErr(boxCostUsd)) return boxCostUsd;
    const usersPerBox = num(b.usersPerBox, `${at}.usersPerBox`, { int: true, min: 1, nullable: true }); if (isErr(usersPerBox)) return usersPerBox;
    if (kind === 'contract' && annualUsd == null) return { error: `${at}: a contract needs annualUsd` };
    if (kind === 'infra' && (boxCostUsd == null || usersPerBox == null)) return { error: `${at}: an infra pool needs boxCostUsd and usersPerBox` };
    const shareValue = num(b.shareValue, `${at}.shareValue`, { nullable: true }); if (isErr(shareValue)) return shareValue;
    if (shareValue != null && shareValue > 1) return { error: `${at}.shareValue is a fraction, 0 to 1` };
    const populationSize = num(b.populationSize, `${at}.populationSize`, { int: true, min: 1, nullable: true }); if (isErr(populationSize)) return populationSize;
    const startDate = day(b.startDate, `${at}.startDate`); if (isErr(startDate)) return startDate;
    const endDate = day(b.endDate, `${at}.endDate`); if (isErr(endDate)) return endDate;
    if (startDate && endDate && endDate < startDate) return { error: `${at}: endDate precedes startDate` };
    const sort = num(b.sort ?? (i + 1) * 10, `${at}.sort`, { int: true }); if (isErr(sort)) return sort;
    out.push({
      ...(typeof b.id === 'string' && b.id ? { id: b.id } : {}),
      name, kind, providers: list,
      annualUsd: kind === 'contract' ? annualUsd : null,
      boxes: kind === 'infra' ? boxes : null, boxCostUsd: kind === 'infra' ? boxCostUsd : null, usersPerBox: kind === 'infra' ? usersPerBox : null,
      share, shareValue: share === 'usage' ? shareValue : null,
      populationLabel: share === 'proportional' ? text(b.populationLabel, 80) : null,
      populationSize: share === 'proportional' ? populationSize : null,
      allocation, startDate, endDate, note: text(b.note, 500), sort: sort!,
    });
  }
  return out;
}
