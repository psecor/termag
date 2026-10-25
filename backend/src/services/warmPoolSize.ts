/**
 * How many claimable warm boxes the pool holds: the number flag
 * `box-warm-pool-size`, read for the pool's fixed context (POOL_FLAG_CONTEXT), so
 * the flag's one value is the size and no user target
 * can move it. Every replica evaluates the same context and so agrees on the
 * target, which the serializable insert in warmPool.ts re-checks anyway.
 *
 * The value is clamped to 0..WARM_POOL_SIZE_MAX, because it launches EC2
 * instances and a typo in a dashboard should not launch a hundred. 0 drains
 * the pool. Lowering it retires surplus pool boxes on the next tick
 * (warmPoolPlanner), and only ever ownerless `warming`/`warm` rows: a claimed
 * box has an owner and `ready` from the claim's own statement.
 *
 * `WARM_POOL_TARGET_SIZE` survives only as the e2e stack's override, honored
 * under AUTH_MODE=local like the e2e stack's other overrides,
 * so a deployment cannot hold the pool size away from the flag through its
 * environment.
 */
import { numberVariationForContext } from './featureFlags';
import { POOL_FLAG_CONTEXT } from './boxHibernationFlag';

export const WARM_POOL_SIZE_FLAG = 'box-warm-pool-size';
export const WARM_POOL_SIZE_FALLBACK = 5;
export const WARM_POOL_SIZE_MAX = 20;

/** A served value as a pool size: whole, 0..WARM_POOL_SIZE_MAX, the fallback when it is not a number at all. */
export function clampWarmPoolSize(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return WARM_POOL_SIZE_FALLBACK;
  return Math.min(WARM_POOL_SIZE_MAX, Math.max(0, Math.floor(raw)));
}

export interface WarmPoolSizeEnv {
  WARM_POOL_TARGET_SIZE?: string;
  AUTH_MODE?: string;
}

export interface WarmPoolSizeOverride {
  size: number | null;
  /** Why a set variable was ignored, for the startup log. */
  ignored?: string;
}

export function warmPoolSizeOverride(env: WarmPoolSizeEnv): WarmPoolSizeOverride {
  const raw = env.WARM_POOL_TARGET_SIZE?.trim();
  if (!raw) return { size: null };
  if (env.AUTH_MODE !== 'local') {
    return { size: null, ignored: `WARM_POOL_TARGET_SIZE is only honored with AUTH_MODE=local; the pool size is the ${WARM_POOL_SIZE_FLAG} flag` };
  }
  // Not parseInt: "2 boxes" or "2.9" is a typo, not a size.
  if (!/^\d+$/.test(raw)) return { size: null, ignored: `WARM_POOL_TARGET_SIZE is not a whole number: ${JSON.stringify(raw)}` };
  return { size: clampWarmPoolSize(parseInt(raw, 10)) };
}

/** The last out-of-range value logged, so a misconfigured flag is one line, not one per tick. */
let warnedRaw: number | null = null;

export async function warmPoolTargetSize(env: WarmPoolSizeEnv = process.env): Promise<number> {
  const override = warmPoolSizeOverride(env);
  if (override.size !== null) return override.size;

  const raw = await numberVariationForContext(WARM_POOL_SIZE_FLAG, POOL_FLAG_CONTEXT, WARM_POOL_SIZE_FALLBACK);
  const size = clampWarmPoolSize(raw);
  if (size !== raw && !Object.is(warnedRaw, raw)) {
    warnedRaw = raw;
    console.warn(`[POOL] ${WARM_POOL_SIZE_FLAG} served ${raw}; using ${size} (range 0..${WARM_POOL_SIZE_MAX})`);
  }
  return size;
}
