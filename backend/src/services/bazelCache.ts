/**
 * The boxes' shared Bazel cache: boxes read an S3 bucket directly, through the VPC's gateway
 * endpoint, with no credential. This module is the pure half of its delivery:
 * the bucket origin from the environment, the generation's name, the
 * `box-bazel-cache-config` flag read over code defaults, and the payloads the
 * `bazel-cache` step carries. services/bazelCacheDelivery.ts sends them.
 *
 * The URL a box gets is `BAZEL_CACHE_URL` + `/g/` + a validated generation.
 * It never comes from a flag: the config reader ignores every key it doesn't
 * know, `url` and `bucket` included.
 */

/**
 * The agent capability for the `bazel-cache` step. Here, not in
 * bazelCacheDelivery.ts, because credentialDelivery.ts reads it while modules
 * load, and bazelCacheDelivery.ts sits in a cycle with it through
 * agentRegistry.ts.
 */
export const BAZEL_CACHE_CAPABILITY = 'bazel-cache-v2';

/** A generation: an ISO week with the ISO year, maybe a flush suffix (tech spec, "Generations"). */
export const GENERATION_PATTERN = /^[0-9]{4}w(0[1-9]|[1-4][0-9]|5[0-3])(-[1-9][0-9]?)?$/;

// The bucket's regional virtual-hosted origin. No dots in the name, so the
// certificate matches; the same pattern termag-credentials checks on the box.
const S3_HOST = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.s3\.[a-z0-9-]+\.amazonaws\.com$/;

/**
 * BAZEL_CACHE_URL as the bucket's origin, `https://<bucket>.s3.<region>.amazonaws.com`,
 * or null. Anything else (another host, a path, a port, credentials, a query,
 * plain http) is logged and treated as unset: the box writes the URL into
 * /etc/bazel.bazelrc.
 */
export function bazelCacheOriginFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.BAZEL_CACHE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error('[BAZEL-CACHE] BAZEL_CACHE_URL is not a URL; treating it as unset');
    return null;
  }
  if (url.protocol !== 'https:' || !S3_HOST.test(url.hostname) || url.port || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    console.error('[BAZEL-CACHE] BAZEL_CACHE_URL must be an https S3 bucket origin (https://<bucket>.s3.<region>.amazonaws.com); treating it as unset');
    return null;
  }
  return url.origin;
}

/** The URL a box reads: the origin and a generation already checked against GENERATION_PATTERN. */
export function bazelCacheUrl(origin: string, generation: string): string {
  if (!GENERATION_PATTERN.test(generation)) throw new Error(`not a generation: ${generation}`);
  return `${origin}/g/${generation}`;
}

/** What `box-bazel-cache-config` tunes; every field has a code default. */
export interface BazelCacheSettings {
  remoteTimeoutSeconds: number;
  remoteRetries: number;
  jobs: number;
  downloadOutputs: 'toplevel' | 'all';
  flushGeneration: number;
  goHostModcache: boolean;
}

export const DEFAULT_BAZEL_CACHE_SETTINGS: BazelCacheSettings = {
  remoteTimeoutSeconds: 5,
  remoteRetries: 1,
  jobs: 200,
  downloadOutputs: 'toplevel',
  flushGeneration: 0,
  goHostModcache: false,
};

function intIn(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/**
 * The flag's JSON over the defaults, field by field, as parseSpawnLimits reads
 * `agent-spawn-limits`: `{}` (variation 0), null or a non-object is every
 * default, and a key that is malformed or out of range falls back to its own
 * default alone, with a warning. Unknown keys, `url` and `bucket` among them,
 * are ignored.
 */
export function parseBazelCacheConfig(value: unknown): BazelCacheSettings {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const d = DEFAULT_BAZEL_CACHE_SETTINGS;
  const bad: string[] = [];
  const pick = <T>(key: keyof BazelCacheSettings, parsed: T | undefined, fallback: T): T => {
    if (key in v && parsed === undefined) bad.push(key);
    return parsed === undefined ? fallback : parsed;
  };
  const settings: BazelCacheSettings = {
    remoteTimeoutSeconds: pick('remoteTimeoutSeconds', intIn(v.remoteTimeoutSeconds, 1, 60), d.remoteTimeoutSeconds),
    remoteRetries: pick('remoteRetries', intIn(v.remoteRetries, 0, 5), d.remoteRetries),
    jobs: pick('jobs', intIn(v.jobs, 8, 400), d.jobs),
    downloadOutputs: pick('downloadOutputs', v.downloadOutputs === 'toplevel' || v.downloadOutputs === 'all' ? v.downloadOutputs : undefined, d.downloadOutputs),
    flushGeneration: pick('flushGeneration', intIn(v.flushGeneration, 0, 2 ** 31 - 1), d.flushGeneration),
    goHostModcache: pick('goHostModcache', typeof v.goHostModcache === 'boolean' ? v.goHostModcache : undefined, d.goHostModcache),
  };
  if (bad.length) console.warn(`[BAZEL-CACHE] box-bazel-cache-config: ${bad.join(', ')} out of range or malformed; using the default for each`);
  return settings;
}

/**
 * The `credentials-apply` payload, minus the `seq` added at send time. Values
 * only, never rc text: termag-credentials validates each field again and
 * renders the block itself.
 */
export interface BazelCacheApply {
  url: string;
  flushGeneration: number;
  remoteTimeoutSeconds: number;
  remoteRetries: number;
  jobs: number;
  downloadOutputs: 'toplevel' | 'all';
  goHostModcache: boolean;
}

export function bazelCacheApply(url: string, s: BazelCacheSettings): BazelCacheApply {
  return {
    url,
    flushGeneration: s.flushGeneration,
    remoteTimeoutSeconds: s.remoteTimeoutSeconds,
    remoteRetries: s.remoteRetries,
    jobs: s.jobs,
    downloadOutputs: s.downloadOutputs,
    goHostModcache: s.goHostModcache,
  };
}
