/**
 * Whether a box's disk is growing (services/boxDisk.ts), for the two things
 * that must not stop a box under a grow: a resize, which waits for it
 * (boxResize.ts), and the idle sweep, which holds the box while it runs
 * (the `disk-grow` busy check, boxLifecycle.busyBoxes).
 *
 * A grow counts as running from either side:
 *   - this process holds it (boxDisk.growRunning: a grow, or a request's
 *     reservation from its first checks until the grow is registered);
 *   - its `disk-grow` row in box_events is open and fresh
 *     (boxEvents.openEventWhere), which covers a grow another orchestrator
 *     process runs, the file system retry included. A grow ends within that
 *     hour (boxDisk.maxGrowMs). The row of a grow this process has already
 *     finished doesn't count: its record says how it ended, and the row is
 *     closed after that, without waiting (boxDisk.finish).
 *
 * index.ts registers the busy check at startup (registerDiskGrowBusyCheck).
 */
import { prisma } from '../db';
import { growRunning, lastGrow } from './boxDisk';
import { openEventWhere } from './boxEvents';
import { registerBoxBusyCheck } from './boxLifecycle';

/** Of `ids`, the boxes whose disk is growing now, in this process or another. */
export async function diskGrowBusyIds(ids: string[], nowMs = Date.now()): Promise<Set<string>> {
  const busy = new Set(ids.filter(id => growRunning(id)));
  const rest = ids.filter(id => !busy.has(id));
  if (rest.length === 0) return busy;
  const open = await prisma.boxEvent.findMany({
    where: { ...openEventWhere('disk-grow', nowMs), boxId: { in: rest } },
    select: { id: true, boxId: true },
  });
  // This process's grows are read again after the query: one reserved or started during it holds the box too.
  for (const id of rest) if (growRunning(id)) busy.add(id);
  for (const r of open) {
    if (!r.boxId || busy.has(r.boxId)) continue;
    // This process's own finished grow, whose row is still being closed: not running.
    if (lastGrow(r.boxId)?.eventId === r.id) continue;
    busy.add(r.boxId);
  }
  return busy;
}

/** Whether one box's disk is growing now. */
export async function diskGrowBusy(id: string): Promise<boolean> {
  return (await diskGrowBusyIds([id])).has(id);
}

/** The idle sweep holds a box while its disk grows, so an idle stop never cuts off the agent's file system step. */
export function registerDiskGrowBusyCheck(): void {
  registerBoxBusyCheck('disk-grow', ids => diskGrowBusyIds(ids));
}
