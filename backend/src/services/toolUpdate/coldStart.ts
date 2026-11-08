/**
 * The cold-start marker: the
 * sweep's resume path for a box that was stopped and started again, which is
 * how most boxes come back in the morning since the idle stop (a real EC2
 * stop, box-idle-stop-enabled) replaced hibernation.
 *
 * Nothing new is stored: the marker is read from what the connect already
 * writes. `Instance.lastReadyAt` is stamped only by the agent's connect that
 * makes the box ready (a start, a resume, a first boot; instanceLifecycle.ts
 * connectUpdate), never by a reconnect of a box that already was, so an agent
 * restart or a dropped socket on a running box is not a start. Of those:
 *
 *   - a resume from hibernation is the other marker's, resumedFromHibernationAt
 *     (boxPower.ts): its `hibernatedAt` is kept through the start, while every
 *     stop clears it, so a box with hibernatedAt set did not boot;
 *   - the 60-day refresh's resume (rehibernatePending) is no start either;
 *   - a box's first boot (lastReadyAt equal to the write-once readyAt) has the
 *     image's tools and its own setup to run: the nightly run covers it.
 *
 * The marker is when the box went down before this start, as near as the row
 * says it: the agent's disconnect (`agentDisconnectedAt`, stamped by the
 * socket's close and never by a connect) when it comes before that connect.
 * A run that reached the box before the stop is then not taken for this
 * start's (Devin on #1304); a run during the boot itself, after it (Claude
 * Code's boot unit reports before the agent connects), already ran for this
 * start and spends it, as a run after a hibernation resume spends that marker
 * (resumePending). When a later disconnect has overwritten it, the connect
 * less COLD_START_BOOT_MS stands in: the start at the latest.
 */
import type { Instance } from '@prisma/client';

/** How long before the connect that made the box ready its start may have been: the box start timeout's default (BOX_START_TIMEOUT_SECONDS). */
export const COLD_START_BOOT_MS = 15 * 60_000;

export type ResumeKind = 'hibernation' | 'cold-start';

export type MarkerBox = Pick<Instance, 'resumedFromHibernationAt' | 'lastReadyAt' | 'readyAt' | 'hibernatedAt' | 'rehibernatePending'> & Partial<Pick<Instance, 'agentDisconnectedAt'>>;

/** When this box's last cold start was, as a resume marker, or null when its last coming up was not one. */
export function coldStartMarker(box: Omit<MarkerBox, 'resumedFromHibernationAt'>): Date | null {
  const up = box.lastReadyAt;
  if (!up || box.hibernatedAt || box.rehibernatePending) return null;
  if (box.readyAt && box.readyAt.getTime() === up.getTime()) return null;
  const latest = up.getTime() - COLD_START_BOOT_MS;
  const down = box.agentDisconnectedAt?.getTime();
  return new Date(down !== undefined && down < up.getTime() ? Math.max(down, latest) : latest);
}

/**
 * The box's resume marker for the sweep: a resume from hibernation (the
 * stored marker, which the sweep clears once spent), else a cold start (read
 * from the row, spent per tool by a run after it), else none.
 */
export function resumeMarker(box: MarkerBox): { at: Date; kind: ResumeKind } | null {
  if (box.resumedFromHibernationAt) return { at: box.resumedFromHibernationAt, kind: 'hibernation' };
  const at = coldStartMarker(box);
  return at ? { at, kind: 'cold-start' } : null;
}
