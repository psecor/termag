/**
 * How much throughput and IOPS a new box's root gp3 volume gets above gp3's
 * free baseline (125 MiB/s, 3,000 IOPS): the JSON flag
 * `box-root-volume-performance`, `{ "throughput": <MiB/s>, "iops": <n> }`,
 * read for the warm pool's fixed context (POOL_FLAG_CONTEXT) on every launch,
 * pool or not, like box-volume-initialization-rate (boxVolumeInitRate.ts).
 * null, the fallback, is off: RunInstances sets neither, as before.
 *
 * Why: after a Go edit that shifts lines in a widely imported package,
 * webapp's Bazel build writes 3.55 GB of archives plus a second copy into
 * the disk cache, and the link then reads 6.6 GB. On a 125 MiB/s volume the
 * link took 30-211 s against 9-10 s warm (docs/box-provisioning.md, "Root
 * volume throughput and IOPS").
 *
 * One JSON flag rather than two numbers: the two values are one setting.
 * gp3 caps throughput at 0.25 MiB/s per provisioned IOPS, so the pair has to
 * change together, in one flag change, with one off variation.
 *
 * A served value is clamped to what gp3 accepts, so a typo neither fails
 * every launch nor silently turns it off: throughput 125..1000 MiB/s, IOPS
 * 3,000..16,000. (EBS now takes up to 2,000 MiB/s and 80,000 IOPS, but no box
 * type's EBS link goes past 1,250-1,500 MB/s, even bursting.) A field that is
 * missing, not a number, or at or below the baseline is left at the baseline;
 * a value that is not an object, or has neither field above the baseline, is
 * off. The ratios that depend on the volume (500 IOPS per GiB, 0.25 MiB/s
 * per IOPS) are applied per launch by volumePerformanceFor.
 *
 * Billed per volume-month while the volume exists, stopped boxes included.
 * Not part of the pool spec hash: turning it on does not roll the pool.
 */
import { jsonVariationForContext } from './featureFlags';
import { POOL_FLAG_CONTEXT } from './poolLdContext';

export const BOX_ROOT_VOLUME_PERFORMANCE_FLAG = 'box-root-volume-performance';

export const GP3_BASELINE_THROUGHPUT = 125;
export const GP3_BASELINE_IOPS = 3000;
export const GP3_MAX_THROUGHPUT = 1000;
export const GP3_MAX_IOPS = 16000;
/** gp3: at most 500 IOPS per GiB of volume. */
export const GP3_IOPS_PER_GIB = 500;
/** gp3: at most 0.25 MiB/s of throughput per provisioned IOPS. */
export const GP3_THROUGHPUT_PER_IOPS = 0.25;

/** What the flag asks for above the baseline; a field left out stays at the baseline. */
export interface VolumePerformance {
  throughput?: number;
  iops?: number;
}

function field(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const n = Math.round(raw);
  if (n <= min) return undefined;
  return Math.min(max, n);
}

/** A served value as the throughput and IOPS to ask for, or undefined for off. */
export function volumePerformanceFrom(raw: unknown): VolumePerformance | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const throughput = field(r.throughput, GP3_BASELINE_THROUGHPUT, GP3_MAX_THROUGHPUT);
  const iops = field(r.iops, GP3_BASELINE_IOPS, GP3_MAX_IOPS);
  if (throughput === undefined && iops === undefined) return undefined;
  return { ...(throughput !== undefined ? { throughput } : {}), ...(iops !== undefined ? { iops } : {}) };
}

/**
 * `perf` fitted to a volume of `sizeGb`: IOPS at most 500 per GiB, and
 * throughput at most 0.25 MiB/s per IOPS (the baseline 3,000 when none is
 * asked for, so up to 750 MiB/s). Throughput is lowered to fit rather than
 * IOPS raised, so the flag never buys more than it says. A field that drops
 * to the baseline is left out; undefined when nothing is left.
 */
export function volumePerformanceFor(perf: VolumePerformance | undefined, sizeGb: number): VolumePerformance | undefined {
  if (!perf) return undefined;
  const iopsCap = Number.isFinite(sizeGb) && sizeGb > 0 ? Math.floor(sizeGb * GP3_IOPS_PER_GIB) : GP3_BASELINE_IOPS;
  const iops = perf.iops !== undefined ? Math.min(perf.iops, iopsCap) : undefined;
  const effectiveIops = iops ?? GP3_BASELINE_IOPS;
  const throughput = perf.throughput !== undefined
    ? Math.min(perf.throughput, Math.floor(effectiveIops * GP3_THROUGHPUT_PER_IOPS))
    : undefined;
  return volumePerformanceFrom({ throughput, iops });
}

/** The throughput and IOPS a launch starting now asks for; undefined when the flag is off or no flag source is configured. */
export async function boxVolumePerformance(): Promise<VolumePerformance | undefined> {
  return volumePerformanceFrom(await jsonVariationForContext(BOX_ROOT_VOLUME_PERFORMANCE_FLAG, POOL_FLAG_CONTEXT, null));
}

/** What a volume with `perf` delivers: the asked-for values, else the baseline. For log lines and spans. */
export function effectiveVolumePerformance(perf: VolumePerformance | undefined): { throughput: number; iops: number } {
  return { throughput: perf?.throughput ?? GP3_BASELINE_THROUGHPUT, iops: perf?.iops ?? GP3_BASELINE_IOPS };
}

/**
 * RunInstances refusing the root volume's throughput or IOPS (a ratio EBS
 * counts differently, an account limit). The launch is retried once without
 * them: like the initialization rate, they are a speed-up, the box is not.
 */
export function isVolumePerformanceRefusal(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /\b(throughput|iops)\b/i.test(text);
}
