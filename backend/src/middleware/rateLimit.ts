/**
 * Small in-memory token bucket, keyed per caller. Enough for the admin
 * surface (one process, a handful of admins); not a general-purpose limiter.
 */
import type { Request, Response, NextFunction } from 'express';

export interface Bucket { tokens: number; updatedAt: number }

export function takeToken(buckets: Map<string, Bucket>, key: string, capacity: number, refillPerSec: number, now: number): boolean {
  const b = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.updatedAt) / 1000) * refillPerSec);
  b.updatedAt = now;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

export function rateLimit(opts: { capacity: number; perMinute: number; keyOf?: (req: Request) => string }) {
  const buckets = new Map<string, Bucket>();
  const keyOf = opts.keyOf ?? ((req: Request) => req.adminTokenId ?? req.user?.id ?? req.ip ?? 'anon');
  // Drop idle buckets now and then so the map can't grow without bound.
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, b] of buckets) if (b.updatedAt < cutoff) buckets.delete(k);
  }, 5 * 60_000).unref();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (takeToken(buckets, keyOf(req), opts.capacity, opts.perMinute / 60, Date.now())) { next(); return; }
    res.setHeader('Retry-After', '5');
    res.status(429).json({ error: 'Rate limited' });
  };
}
