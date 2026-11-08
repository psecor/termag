/**
 * How fast EBS initializes a new box's root volume from the image's snapshot:
 * the number flag `box-volume-initialization-rate`, in MiB/s, read for the
 * warm pool's fixed context (POOL_FLAG_CONTEXT) on every launch, pool or not.
 * 0, the fallback, is off: RunInstances gets no VolumeInitializationRate and
 * the volume loads each block from S3 on its first read, as before.
 *
 * Why: a volume restored from a snapshot without it reads cold blocks at
 * 2.5-76 ms each, and a cold webapp `make dev` was disk-bound for minutes.
 * Fast snapshot restore covers only the publish workflow's one zone
 * (BOX_FAST_SNAPSHOT_RESTORE_AZ), while launches rotate across every box
 * subnet, and each publish's new snapshot starts with an empty FSR credit
 * bucket just as the pool relaunches on it. A set rate makes EBS copy the
 * whole snapshot in the background at that rate, in any zone; with FSR also
 * on in the volume's zone, EBS uses the rate instead of FSR. Billed per GiB
 * of snapshot data per volume (docs/box-provisioning.md, "Root volume
 * initialization").
 *
 * EBS takes 100 to 300 MiB/s. A served value is clamped into that range, so
 * a typo neither fails every launch nor silently turns the rate off; a
 * non-number or anything at or below 0 is off.
 *
 * Not part of the pool spec hash: turning it on does not roll the pool. Warm
 * boxes launched before take effect from the next publish's relaunch.
 */
import { numberVariationForContext } from './featureFlags';
import { POOL_FLAG_CONTEXT } from './poolLdContext';

export const BOX_VOLUME_INIT_RATE_FLAG = 'box-volume-initialization-rate';
export const VOLUME_INIT_RATE_MIN = 100;
export const VOLUME_INIT_RATE_MAX = 300;

/** A served value as a rate in MiB/s, or undefined for off. */
export function volumeInitRateFrom(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(VOLUME_INIT_RATE_MAX, Math.max(VOLUME_INIT_RATE_MIN, Math.round(raw)));
}

/** The rate a launch starting now asks EBS for; undefined when the flag is off or no flag source is configured. */
export async function boxVolumeInitRate(): Promise<number | undefined> {
  return volumeInitRateFrom(await numberVariationForContext(BOX_VOLUME_INIT_RATE_FLAG, POOL_FLAG_CONTEXT, 0));
}

/**
 * RunInstances refusing the rate itself: EBS fails the request when it can't
 * initialize at the rate (capacity, or the regional 5,000 MiB/s quota across
 * concurrent initializations). The launch is retried once without it.
 */
export function isVolumeInitRateRefusal(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /initiali[sz]ation ?rate/i.test(text);
}
