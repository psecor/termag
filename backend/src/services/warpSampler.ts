/**
 * Warp Sampler — buffers per-user "speed" / hyperspace samples from the
 * frontend and rolls them into per-minute buckets in warp_samples.
 *
 * The frontend posts the synthesized targetWarp value every 5s. We hold
 * each user's current minute in memory, append samples as they arrive,
 * and flush to the database when the minute rolls over (or on shutdown,
 * or when a user has gone quiet for a while).
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CHECK_INTERVAL_MS = 30_000;     // sweep for stale buckets every 30s
const STALE_AFTER_MS = 2 * 60 * 1000; // flush a bucket if no sample in 2 min
const SAMPLE_INTERVAL_MS = 5_000;     // expected frontend cadence
const ACTIVE_THRESHOLD = 1.0;         // matches "working" floor in utils/warp.ts

interface UserBucket {
  bucketStart: number;     // epoch ms, truncated to minute
  samples: number[];
  activeSamples: number;   // count of samples >= ACTIVE_THRESHOLD
  lastSampleAt: number;    // epoch ms
}

const userBuckets = new Map<string, UserBucket>();
let checkTimer: NodeJS.Timeout | null = null;

function truncateToMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

async function flushBucket(userId: string, bucket: UserBucket): Promise<void> {
  if (bucket.samples.length === 0) return;
  const sum = bucket.samples.reduce((a, b) => a + b, 0);
  const meanWarp = sum / bucket.samples.length;
  const maxWarp = Math.max(...bucket.samples);
  const p95Warp = p95(bucket.samples);
  const activeMs = Math.min(60_000, bucket.activeSamples * SAMPLE_INTERVAL_MS);

  try {
    await prisma.warpSample.upsert({
      where: {
        userId_bucket: { userId, bucket: new Date(bucket.bucketStart) },
      },
      update: {
        meanWarp,
        maxWarp,
        p95Warp,
        sampleCount: bucket.samples.length,
        activeMs,
      },
      create: {
        userId,
        bucket: new Date(bucket.bucketStart),
        meanWarp,
        maxWarp,
        p95Warp,
        sampleCount: bucket.samples.length,
        activeMs,
      },
    });
  } catch (err) {
    console.error('[WARP-SAMPLER] Failed to persist:', (err as Error).message);
  }
}

/** Called from POST /api/warp/sample */
export function recordWarpSample(userId: string, value: number, ts?: number): void {
  const now = ts ?? Date.now();
  const bucketStart = truncateToMinute(now);
  const existing = userBuckets.get(userId);

  if (existing && existing.bucketStart !== bucketStart) {
    // Bucket rolled — flush old, start new (don't await, fire-and-forget)
    flushBucket(userId, existing).catch(() => {});
    userBuckets.set(userId, {
      bucketStart,
      samples: [value],
      activeSamples: value >= ACTIVE_THRESHOLD ? 1 : 0,
      lastSampleAt: now,
    });
    return;
  }

  if (!existing) {
    userBuckets.set(userId, {
      bucketStart,
      samples: [value],
      activeSamples: value >= ACTIVE_THRESHOLD ? 1 : 0,
      lastSampleAt: now,
    });
    return;
  }

  existing.samples.push(value);
  if (value >= ACTIVE_THRESHOLD) existing.activeSamples++;
  existing.lastSampleAt = now;
}

function sweepStale(): void {
  const now = Date.now();
  for (const [userId, bucket] of userBuckets) {
    if (now - bucket.lastSampleAt >= STALE_AFTER_MS) {
      flushBucket(userId, bucket).catch(() => {});
      userBuckets.delete(userId);
    }
  }
}

export function startWarpSampler(): void {
  if (checkTimer) return;
  checkTimer = setInterval(sweepStale, CHECK_INTERVAL_MS);
}

export async function stopWarpSampler(): Promise<void> {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  const pending: Promise<void>[] = [];
  for (const [userId, bucket] of userBuckets) {
    pending.push(flushBucket(userId, bucket));
  }
  userBuckets.clear();
  await Promise.allSettled(pending);
}
