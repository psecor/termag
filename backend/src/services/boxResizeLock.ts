/**
 * A box's resize lock (services/boxResize.ts): the box's open `resize` row in
 * box_events (services/boxEvents.ts). On its own, with no runtime imports, so
 * the power rules (boxPower.ts) can refuse a request while a resize holds the
 * box without loading the resize module.
 */

import type { Prisma } from '@prisma/client';

/**
 * A resize whose row is still open after this long belongs to a process
 * that died (a deploy, a crash): it no longer holds the box. The longest real
 * one is a hibernated box's resume, stop and start, each with its own
 * timeout (15, 12 and 15 minutes).
 */
export const RESIZE_STALE_MS = 60 * 60 * 1000;

/**
 * The boxes no resize holds, for a guarded write on `instances`: no open
 * `resize` row (not finished, started under RESIZE_STALE_MS ago). A NOT
 * EXISTS on box_events, whose startedAt is never NULL, so it is NULL-safe on a
 * box that was never resized (Bugbot on #877). requestPower uses it.
 */
export function resizeFreeWhere(nowMs = Date.now()): Prisma.InstanceWhereInput {
  return { boxEvents: { none: { kind: 'resize', finishedAt: null, startedAt: { gte: new Date(nowMs - RESIZE_STALE_MS) } } } };
}
