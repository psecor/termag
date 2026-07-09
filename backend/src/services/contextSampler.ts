/**
 * Context Sampler — persists a project/workstream's Claude context-window
 * occupancy (the badge gauge) into per-minute buckets in context_samples, for
 * the "context usage over time" reporting.
 *
 * Mirrors warpSampler, with one deviation: warp gets a fresh sample every 5s,
 * but contextTokens is a slowly-changing GAUGE that the agent only POSTs on
 * change (plus a null when it expires). So we carry the last value forward:
 * a sweep writes a bucket for each live key every minute using either the
 * samples seen that minute or the carried last value. A null report (context
 * expired — idle/cleared) EVICTS the key so the series shows a gap rather than
 * a frozen flat line, and a STALE backstop evicts keys that stop reporting
 * without a null (e.g. an agent that died).
 *
 * The bucket transitions are pure functions (reduceRecord/reduceSweep/summarize)
 * so they can be unit-tested without a database; the exported record/sweep
 * wrappers apply their decisions and do the prisma writes.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SWEEP_INTERVAL_MS = 20_000;      // roll/flush completed minutes this often
const STALE_AFTER_MS = 12 * 60 * 1000; // backstop evict if no report in 12 min

export interface Bucket {
  projectId: string;
  workstream: string;
  bucketStart: number; // epoch ms, truncated to minute
  samples: number[];
  lastValue: number;   // carried-forward gauge value
  lastSampleAt: number;
}

const buckets = new Map<string, Bucket>();
let sweepTimer: NodeJS.Timeout | null = null;

export function truncateToMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

function keyFor(projectId: string, workstream: string): string {
  return `${projectId} ${workstream}`;
}

/** Pure: summarize a minute's samples into the persisted row shape. */
export function summarize(samples: number[]): { meanTokens: number; maxTokens: number; sampleCount: number } {
  const sum = samples.reduce((a, v) => a + v, 0);
  return {
    meanTokens: Math.round(sum / samples.length),
    maxTokens: Math.max(...samples),
    sampleCount: samples.length,
  };
}

/**
 * Pure: decide the effect of a reading on a key's bucket.
 * - `flush`: a completed bucket to persist (minute rolled, or being evicted).
 * - `next`: the new bucket state; when absent the key should be evicted.
 */
export function reduceRecord(
  existing: Bucket | undefined,
  projectId: string,
  workstream: string,
  tokens: number | null,
  now: number,
): { flush?: Bucket; next?: Bucket } {
  if (tokens === null || !Number.isFinite(tokens)) {
    return existing ? { flush: existing } : {}; // expired → flush what we have, then evict
  }
  const bucketStart = truncateToMinute(now);
  if (!existing) {
    return { next: { projectId, workstream, bucketStart, samples: [tokens], lastValue: tokens, lastSampleAt: now } };
  }
  if (existing.bucketStart !== bucketStart) {
    return {
      flush: existing,
      next: { projectId, workstream, bucketStart, samples: [tokens], lastValue: tokens, lastSampleAt: now },
    };
  }
  return { next: { ...existing, samples: [...existing.samples, tokens], lastValue: tokens, lastSampleAt: now } };
}

/**
 * Pure: decide a bucket's fate on a sweep tick.
 * - stale (no report in `staleAfterMs`) → flush + evict (no `next`).
 * - minute rolled → flush the completed bucket + carry `lastValue` forward.
 * - otherwise unchanged.
 */
export function reduceSweep(
  bucket: Bucket,
  now: number,
  staleAfterMs: number,
): { flush?: Bucket; next?: Bucket } {
  if (now - bucket.lastSampleAt >= staleAfterMs) {
    return { flush: bucket };
  }
  const curMinute = truncateToMinute(now);
  if (bucket.bucketStart < curMinute) {
    return { flush: bucket, next: { ...bucket, bucketStart: curMinute, samples: [bucket.lastValue] } };
  }
  return { next: bucket };
}

async function flushBucket(b: Bucket): Promise<void> {
  if (b.samples.length === 0) return;
  const { meanTokens, maxTokens, sampleCount } = summarize(b.samples);
  const bucket = new Date(b.bucketStart);
  try {
    await prisma.contextSample.upsert({
      where: {
        projectId_workstream_bucket: { projectId: b.projectId, workstream: b.workstream, bucket },
      },
      update: { meanTokens, maxTokens, sampleCount },
      create: { projectId: b.projectId, workstream: b.workstream, bucket, meanTokens, maxTokens, sampleCount },
    });
  } catch (err) {
    console.error('[CONTEXT-SAMPLER] Failed to persist:', (err as Error).message);
  }
}

/**
 * Record a context-token reading. Called from the status route when the agent
 * POSTs a `contextTokens` metadata update. `tokens === null` means the context
 * expired (idle/cleared) → stop sampling this key so the series gaps.
 */
export function recordContextSample(
  projectId: string,
  workstream: string,
  tokens: number | null,
  ts?: number,
): void {
  const key = keyFor(projectId, workstream);
  const { flush, next } = reduceRecord(buckets.get(key), projectId, workstream, tokens, ts ?? Date.now());
  if (flush) flushBucket(flush).catch(() => {});
  if (next) buckets.set(key, next);
  else buckets.delete(key);
}

function sweep(): void {
  const now = Date.now();
  for (const [key, b] of buckets) {
    const { flush, next } = reduceSweep(b, now, STALE_AFTER_MS);
    if (flush) flushBucket(flush).catch(() => {});
    if (next) buckets.set(key, next);
    else buckets.delete(key);
  }
}

export function startContextSampler(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
}

export async function stopContextSampler(): Promise<void> {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  const pending: Promise<void>[] = [];
  for (const b of buckets.values()) pending.push(flushBucket(b));
  buckets.clear();
  await Promise.allSettled(pending);
}
