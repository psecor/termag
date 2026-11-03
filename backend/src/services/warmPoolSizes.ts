/**
 * How many warm boxes the pool holds of each size.
 *
 * A claim only takes a box of the size it would have launched (boxSize.ts),
 * so a pool of one size serves only the people whose size it is. With sizes
 * on for the pool (box-default-size serving a size for POOL_FLAG_CONTEXT), the
 * JSON flag `box-warm-pool-sizes` says how many of each size to keep, e.g.
 * {"small":4,"medium":2,"large":2}. Read for the pool's fixed context, like
 * every pool flag, so every replica agrees.
 *
 * When the flag serves an object, its counts are the pool: the total is their
 * sum, and `box-warm-pool-size` is not read. A size the object leaves out
 * takes its count from DEFAULT_WARM_POOL_SIZES. The only limit is the total:
 * the sum is clamped to WARM_POOL_TOTAL_CEILING, filled smallest size first
 * so the excess comes off the largest, with a warning, because these launch
 * EC2 instances. No size has a limit of its own. All zeros drains the pool.
 *
 * When the flag serves nothing (null: unset, or the flag source can't answer)
 * or a malformed value (not an object, or a count that is not a whole number
 * of 0 or more), the pool is the single-size pool it was before per-size
 * counts: `box-warm-pool-size` boxes of the pool's box-default-size, or of the
 * configured BOX_INSTANCE_TYPE with sizes off. `box-warm-pool-size` applies
 * only to that single-size pool. A malformed value is logged once per value.
 */
import { POOL_FLAG_CONTEXT } from './boxHibernationFlag';
import { BOX_SIZES, poolDefaultSize, type BoxSize } from './boxSize';
import { jsonVariationForContext } from './featureFlags';
import { recordProductEvent } from './productEvents';
import { warmPoolTargetSize, type WarmPoolSizeEnv } from './warmPoolSize';

export const WARM_POOL_SIZES_FLAG = 'box-warm-pool-sizes';

/** The count of a size a served object leaves out. */
export const DEFAULT_WARM_POOL_SIZES: Readonly<Record<BoxSize, number>> = { small: 4, medium: 2, large: 2 };

/** The hard limit on the whole pool a served object can ask for, whatever it says. */
export const WARM_POOL_TOTAL_CEILING = 20;

/** One size's share of the pool; size null is BOX_INSTANCE_TYPE, the pool with sizes off. */
export interface PoolTarget {
  size: BoxSize | null;
  target: number;
}

/** The last value warned about, so a bad flag is one line, not one per tick. */
let warnedRaw: string | null = null;

function warnOnce(raw: unknown, message: string): void {
  const key = JSON.stringify(raw) ?? String(raw);
  if (key === warnedRaw) return;
  warnedRaw = key;
  console.warn(`[POOL] ${WARM_POOL_SIZES_FLAG} served ${key}: ${message}`);
}

/**
 * A served value as a count per size, or null when it is unset or malformed
 * (the single-size pool). A size left out takes its default; an unknown key
 * is ignored with a warning. The counts are not clamped here.
 */
export function parseWarmPoolSizes(raw: unknown): Record<BoxSize, number> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnOnce(raw, `not an object of sizes; holding the single-size pool of box-warm-pool-size`);
    return null;
  }
  const served = raw as Record<string, unknown>;
  const counts = { ...DEFAULT_WARM_POOL_SIZES };
  const bad: string[] = [];
  for (const size of BOX_SIZES) {
    if (!(size in served)) continue;
    const n = served[size];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) counts[size] = n;
    else bad.push(size);
  }
  if (bad.length) {
    warnOnce(raw, `${bad.join(', ')} not a whole number of 0 or more; holding the single-size pool of box-warm-pool-size`);
    return null;
  }
  const unknown = Object.keys(served).filter(k => !(BOX_SIZES as readonly string[]).includes(k));
  if (unknown.length) warnOnce(raw, `ignoring ${unknown.join(', ')}, not one of ${BOX_SIZES.join(', ')}`);
  return counts;
}

/**
 * The counts as targets, their sum clamped to WARM_POOL_TOTAL_CEILING, filled
 * smallest size first (15/15/15 is 15/5/0). Pure; `clamped` says whether
 * anything was cut, for the caller's warning.
 */
export function ceilPoolTargets(counts: Readonly<Record<BoxSize, number>>): { targets: PoolTarget[]; clamped: boolean } {
  let left = WARM_POOL_TOTAL_CEILING;
  let clamped = false;
  const targets = BOX_SIZES.map(size => {
    const target = Math.min(counts[size], left);
    if (target < counts[size]) clamped = true;
    left -= target;
    return { size, target };
  });
  return { targets, clamped };
}

/**
 * What the pool should hold now: one entry per size when box-warm-pool-sizes
 * serves an object (some may be 0), or the single-size pool's one entry.
 */
export async function warmPoolTargets(env: WarmPoolSizeEnv = process.env): Promise<PoolTarget[]> {
  const poolSize = await poolDefaultSize();
  const raw = poolSize === null ? null : await jsonVariationForContext(WARM_POOL_SIZES_FLAG, POOL_FLAG_CONTEXT, null);
  const counts = parseWarmPoolSizes(raw);
  if (!counts) return [{ size: poolSize, target: await warmPoolTargetSize(env) }];
  const { targets, clamped } = ceilPoolTargets(counts);
  if (clamped) {
    warnOnce(raw, `clamped to ${targets.map(t => `${t.size}=${t.target}`).join(' ')} (at most ${WARM_POOL_TOTAL_CEILING} in all, smallest first)`);
  }
  return targets;
}

/** How many warm boxes of `size` the pool holds; 0 means a claim of that size goes cold. */
export async function warmPoolTargetFor(size: BoxSize | null, env: WarmPoolSizeEnv = process.env): Promise<number> {
  return (await warmPoolTargets(env)).find(t => t.size === size)?.target ?? 0;
}

/** Why a claim found no warm box: the pool holds none of the size, none of it was warm, or every one tried failed. */
export type PoolMissReason = 'size-not-pooled' | 'disk-not-pooled' | 'no-warm-box' | 'every-candidate-failed';

/**
 * One claim of `size` against the pool, hit or miss, for tuning the counts:
 * a `[POOL] claim hit|miss` line and a `box.pool.claim` product event, both
 * by size. Recorded only for a claimer the pool could serve but for its size
 * or its supply (in warm-pool-enabled, the published image, the pool's
 * hibernation value), so a miss is a box the counts could have warmed.
 */
export function recordPoolClaim(claim: {
  user: { id: string; unixUsername: string };
  size: BoxSize | null;
  via: 'add-box' | 'claude-runner';
  box?: string;
} & ({ outcome: 'hit' } | { outcome: 'miss'; reason: PoolMissReason })): void {
  const reason = claim.outcome === 'miss' ? claim.reason : null;
  const size = claim.size ?? 'configured';
  console.log(`[POOL] claim ${claim.outcome} size=${size} via=${claim.via} user=${claim.user.unixUsername}${reason ? ` reason=${reason}` : ''}`);
  recordProductEvent('box.pool.claim', { user: claim.user.id, box: claim.box ?? null }, {
    size, outcome: claim.outcome, reason, via: claim.via,
  });
}
