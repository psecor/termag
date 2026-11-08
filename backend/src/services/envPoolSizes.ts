/**
 * Which shared environments have a pool, and how deep.
 *
 * `environment-pool-enabled` (boolean, fallback off) is the kill switch for
 * preparing and claiming. `environment-pool-sizes` (JSON) says how many
 * `env-stopped` boxes each environment keeps, by name:
 * {"termag": 3, "webapp": 2}. An environment it doesn't list has no pool.
 * Both are read for the pool's fixed context, like every pool flag, so every
 * replica agrees.
 *
 * The total is clamped to ENV_POOL_TOTAL_CEILING in name order (the excess
 * comes off the names that sort last), with a warning, because each count is
 * EC2 instances and their volumes.
 */
import { POOL_FLAG_CONTEXT } from './poolLdContext';
import { boolVariationForContext, jsonVariationForContext } from './featureFlags';
import { ENVIRONMENT_NAME_RE } from './environments';

export const ENV_POOL_ENABLED_FLAG = 'environment-pool-enabled';
export const ENV_POOL_SIZES_FLAG = 'environment-pool-sizes';

/** The hard limit on every environment pool together, whatever the flag says. */
export const ENV_POOL_TOTAL_CEILING = 20;

export interface EnvPoolTarget {
  /** The environment's name, as the flag and `--environment` say it. */
  name: string;
  target: number;
}

let warnedRaw: string | null = null;

function warnOnce(raw: unknown, message: string): void {
  const key = JSON.stringify(raw) ?? String(raw);
  if (key === warnedRaw) return;
  warnedRaw = key;
  console.warn(`[ENV-POOL] ${ENV_POOL_SIZES_FLAG} served ${key}: ${message}`);
}

/**
 * A served value as targets, clamped. Unset, or not an object, is no pool at
 * all. A key that isn't an environment name, or a count that isn't a whole
 * number of 0 or more, is left out with a warning; the rest still count.
 */
export function parseEnvPoolSizes(raw: unknown): EnvPoolTarget[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnOnce(raw, 'not an object of environment names; no environment has a pool');
    return [];
  }
  const bad: string[] = [];
  const targets: EnvPoolTarget[] = [];
  for (const [name, n] of Object.entries(raw as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ENVIRONMENT_NAME_RE.test(name) || typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      bad.push(name);
      continue;
    }
    targets.push({ name, target: n });
  }
  if (bad.length) warnOnce(raw, `left out ${bad.join(', ')}: an environment name with a whole number of 0 or more`);
  let left = ENV_POOL_TOTAL_CEILING;
  let clamped = false;
  const out = targets.map(t => {
    const target = Math.min(t.target, left);
    if (target < t.target) clamped = true;
    left -= target;
    return { name: t.name, target };
  });
  if (clamped) warnOnce(raw, `clamped to ${out.map(t => `${t.name}=${t.target}`).join(' ')} (at most ${ENV_POOL_TOTAL_CEILING} in all, in name order)`);
  return out;
}

/** Whether environment pools are on: preparing, and claiming from them. */
export async function envPoolEnabled(): Promise<boolean> {
  return boolVariationForContext(ENV_POOL_ENABLED_FLAG, POOL_FLAG_CONTEXT, false);
}

/** Every environment's pool target, [] when pools are off. */
export async function envPoolTargets(): Promise<EnvPoolTarget[]> {
  if (!(await envPoolEnabled())) return [];
  return parseEnvPoolSizes(await jsonVariationForContext(ENV_POOL_SIZES_FLAG, POOL_FLAG_CONTEXT, null));
}

/** How many boxes the named environment's pool keeps; 0 when it has none or pools are off. */
export async function envPoolTargetFor(name: string): Promise<number> {
  return (await envPoolTargets()).find(t => t.name === name)?.target ?? 0;
}
