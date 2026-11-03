/**
 * Fleet operations on a box, in the append-only `box_events` table: one row
 * per operation (a resize, a disk grow), created when it is asked for and
 * updated as it goes, never deleted (docs/agents/data-and-schema.md). The
 * admin audit log keeps the *request* to an admin route; this keeps the
 * *operation* and its outcome, whoever asked (owner, admin or the system).
 *
 * The open row of a kind is that operation in progress: started under
 * OPEN_EVENT_STALE_MS ago and not finished. A process that dies mid-way
 * leaves its row open; once stale it no longer counts as running, and the
 * views read it as cut off.
 */
import type { BoxEvent, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { RESIZE_STALE_MS } from './boxResizeLock';

export type BoxEventKind = 'resize' | 'disk-grow';
export type BoxEventActorRole = 'owner' | 'admin' | 'system';
export type { BoxEvent };

/** An open row older than this belongs to a process that died. */
export const OPEN_EVENT_STALE_MS = RESIZE_STALE_MS;

/** Whether the row is an operation still in progress (not finished, not stale). */
export function eventOpen(row: Pick<BoxEvent, 'startedAt' | 'finishedAt'>, nowMs = Date.now()): boolean {
  return !row.finishedAt && nowMs - row.startedAt.getTime() < OPEN_EVENT_STALE_MS;
}

/** The open rows of `kind`, as a Prisma filter (startedAt is never null, so this is NULL-safe). */
export function openEventWhere(kind: BoxEventKind, nowMs = Date.now()): Prisma.BoxEventWhereInput {
  return { kind, finishedAt: null, startedAt: { gte: new Date(nowMs - OPEN_EVENT_STALE_MS) } };
}

export interface NewBoxEvent {
  box: { id: string; name: string };
  kind: BoxEventKind;
  actorId: string | null;
  actorRole: BoxEventActorRole;
  reason?: string | null;
  from?: string | null;
  to?: string | null;
  phase?: string;
  detail?: Prisma.InputJsonValue;
  startedAt?: Date;
}

type Tx = Pick<typeof prisma, 'boxEvent'>;

export async function createBoxEvent(e: NewBoxEvent, tx: Tx = prisma): Promise<BoxEvent> {
  return tx.boxEvent.create({
    data: {
      boxId: e.box.id, boxName: e.box.name, kind: e.kind, actorId: e.actorId, actorRole: e.actorRole,
      reason: e.reason?.trim() || null, from: e.from ?? null, to: e.to ?? null, phase: e.phase ?? 'requested',
      detail: e.detail, ...(e.startedAt ? { startedAt: e.startedAt } : {}),
    },
  });
}

/** Move a row on: a new phase, and detail merged into what it had. */
export async function advanceBoxEvent(id: string, phase: string, detail?: Record<string, unknown>): Promise<BoxEvent> {
  if (!detail) return prisma.boxEvent.update({ where: { id }, data: { phase } });
  const row = await prisma.boxEvent.findUniqueOrThrow({ where: { id } });
  return prisma.boxEvent.update({ where: { id }, data: { phase, detail: { ...asObject(row.detail), ...detail } as Prisma.InputJsonValue } });
}

/** Close a row: done or failed, with the error (cut at 1000 characters) and the last detail. */
export async function finishBoxEvent(
  id: string, outcome: { phase: 'done' | 'failed'; error?: string | null; detail?: Record<string, unknown> },
): Promise<BoxEvent> {
  const row = await prisma.boxEvent.findUniqueOrThrow({ where: { id } });
  return prisma.boxEvent.update({
    where: { id },
    data: {
      phase: outcome.phase, finishedAt: new Date(), error: outcome.error?.slice(0, 1000) ?? null,
      detail: { ...asObject(row.detail), ...(outcome.detail ?? {}) } as Prisma.InputJsonValue,
    },
  });
}

/** The newest row of `kind` for each box: its current or last operation of that kind. */
export async function latestBoxEvents(boxIds: string[], kind: BoxEventKind): Promise<Map<string, BoxEvent>> {
  const out = new Map<string, BoxEvent>();
  if (boxIds.length === 0) return out;
  const rows = await prisma.boxEvent.findMany({
    where: { boxId: { in: boxIds }, kind },
    orderBy: { startedAt: 'desc' },
    distinct: ['boxId'],
  });
  for (const r of rows) if (r.boxId) out.set(r.boxId, r);
  return out;
}

export async function latestBoxEvent(boxId: string, kind: BoxEventKind): Promise<BoxEvent | null> {
  return (await latestBoxEvents([boxId], kind)).get(boxId) ?? null;
}

/** The box's open operation of `kind`, or null. */
export async function openBoxEvent(boxId: string, kind: BoxEventKind, nowMs = Date.now()): Promise<BoxEvent | null> {
  return prisma.boxEvent.findFirst({ where: { boxId, ...openEventWhere(kind, nowMs) }, orderBy: { startedAt: 'desc' } });
}

/** Which of these boxes have an open operation of this kind (the ask queue holds them). */
export async function boxesWithOpenEvent(boxIds: string[], kind: BoxEventKind, nowMs = Date.now()): Promise<Set<string>> {
  if (!boxIds.length) return new Set();
  const rows = await prisma.boxEvent.findMany({ where: { boxId: { in: boxIds }, ...openEventWhere(kind, nowMs) }, select: { boxId: true } });
  return new Set(rows.flatMap(r => (r.boxId ? [r.boxId] : [])));
}

/** The box's recent operations of every kind, newest first (the Fleet tab's list). */
export async function recentBoxEvents(boxId: string, limit = 10): Promise<BoxEvent[]> {
  return prisma.boxEvent.findMany({ where: { boxId }, orderBy: { startedAt: 'desc' }, take: limit });
}

/** One row as the Fleet tab lists it. */
export interface BoxEventView {
  id: string;
  kind: string;
  actorId: string | null;
  actorRole: string;
  reason: string | null;
  from: string | null;
  to: string | null;
  phase: string;
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export function boxEventView(r: BoxEvent, nowMs = Date.now()): BoxEventView {
  const running = eventOpen(r, nowMs);
  const cutOff = !running && !r.finishedAt;
  return {
    id: r.id, kind: r.kind, actorId: r.actorId, actorRole: r.actorRole, reason: r.reason, from: r.from, to: r.to,
    phase: cutOff ? 'failed' : r.phase, running, startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    error: cutOff ? 'Cut off (the orchestrator restarted mid-way)' : r.error,
  };
}

export function asObject(v: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
