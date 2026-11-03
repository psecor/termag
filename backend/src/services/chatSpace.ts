/**
 * A chat belongs to exactly one space, fixed when it starts (the person's
 * decision on plan-outbox #38). It is
 * kept on the chat's workstream (Workstream.spaceId, spaceFixedAt):
 *
 * - New session records the space it was started in, or "No space"
 *   (routes/projects.ts createProjectFor, `chatSpace`);
 * - an automation's run records the automation's space (automations/runner.ts);
 *   both are written in the insert of the chat's workstream (fixedOnCreate), so
 *   a listing during the rest of the create can't fix it to the box's first
 *   grant first;
 * - any other chat gets its box's first granted space the first time the
 *   server lists it or sends it a message, or "No space" when the box has
 *   none then.
 *
 * Once fixed it never moves: a later grant, a tab opened from another space,
 * or Clear (a new session on the same workstream) keeps it. Its sidebar
 * group, header chip and memory all read it. A space deleted since leaves the
 * chat with none (the row's foreign key is set null at the purge; until then
 * a deleted space counts as none).
 */
import { prisma } from '../db';

export interface ChatSpace { id: string; name: string }

/** What fixing reads and writes; Prisma's client in production, a fake in tests. */
export interface ChatSpaceDb {
  workstream: {
    findUnique(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  space: { findFirst(args: unknown): Promise<unknown> };
  spaceBox: { findFirst(args: unknown): Promise<unknown>; findMany(args: unknown): Promise<unknown> };
}

type WsRow = {
  spaceFixedAt: Date | null;
  space: { id: string; name: string; deletedAt: Date | null } | null;
  project: { instanceId: string | null };
};

const WS_SELECT = {
  spaceFixedAt: true,
  space: { select: { id: true, name: true, deletedAt: true } },
  project: { select: { instanceId: true } },
};

/** A New session's or an automation's space: by name, live, and one `userId` is a member of. */
async function requestedSpace(db: ChatSpaceDb, name: string, userId: string): Promise<ChatSpace | null> {
  return await db.space.findFirst({
    where: { name, deletedAt: null, members: { some: { userId } } },
    select: { id: true, name: true },
  }) as ChatSpace | null;
}

/** The box's first explicitly granted space (the one its CLI loads by default), or null. */
async function firstGranted(db: ChatSpaceDb, instanceId: string | null): Promise<ChatSpace | null> {
  if (!instanceId) return null;
  const grant = await db.spaceBox.findFirst({
    where: { instanceId, space: { deletedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: { space: { select: { id: true, name: true } } },
  }) as { space: ChatSpace } | null;
  return grant?.space ?? null;
}

/**
 * A New session's or an automation's choice, resolved before its workstream
 * is made: `{ spaceId }` for a live space `userId` is a member of, `{ spaceId:
 * null }` for "No space" (`name` null), null for no choice or an unknown name
 * (the chat then gets its box's first grant at first use, as any other).
 */
export async function resolveChatSpaceChoice(
  name: string | null | undefined, userId: string, db: ChatSpaceDb = prisma as unknown as ChatSpaceDb,
): Promise<{ spaceId: string | null } | null> {
  if (name === null) return { spaceId: null };
  if (typeof name !== 'string' || !name) return null;
  const space = await requestedSpace(db, name, userId);
  return space ? { spaceId: space.id } : null;
}

/** The workstream create data for a resolved choice: fixed from its first row on. Nothing for none. */
export function fixedOnCreate(choice: { spaceId: string | null } | null | undefined): { spaceId?: string | null; spaceFixedAt?: Date } {
  return choice ? { spaceId: choice.spaceId, spaceFixedAt: new Date() } : {};
}

export interface ChatPlace {
  /** The chat's space, or null for "No space" (or a space deleted since). */
  space: ChatSpace | null;
  /** Whether the chat's box is granted that space, so its CLI can load the memory. */
  reachable: boolean;
}

/**
 * Workstream `workstreamId`'s space, fixing it now if it has none yet:
 * `requested` (a name, or null for No space) when given and valid, else the
 * box's first granted space. Two first uses at once fix it once: the write
 * only lands while the row is still unfixed, and the loser reads the winner's.
 */
export async function chatSpaceFor(
  workstreamId: string,
  opts: { requested?: { name: string | null; userId: string } } = {},
  db: ChatSpaceDb = prisma as unknown as ChatSpaceDb,
): Promise<ChatPlace> {
  let ws = await db.workstream.findUnique({ where: { id: workstreamId }, select: WS_SELECT }) as WsRow | null;
  if (!ws) return { space: null, reachable: false };
  if (!ws.spaceFixedAt) {
    const req = opts.requested;
    let chosen: ChatSpace | null = null;
    // New session's "No space" is a choice; a name that isn't a live space of the user's falls back like no name.
    if (!req || req.name !== null) {
      chosen = (req?.name ? await requestedSpace(db, req.name, req.userId) : null) ?? await firstGranted(db, ws.project.instanceId);
    }
    const { count } = await db.workstream.updateMany({
      where: { id: workstreamId, spaceFixedAt: null },
      data: { spaceId: chosen?.id ?? null, spaceFixedAt: new Date() },
    });
    if (count === 0) ws = await db.workstream.findUnique({ where: { id: workstreamId }, select: WS_SELECT }) as WsRow | null;
    else ws = { ...ws, spaceFixedAt: new Date(), space: chosen ? { ...chosen, deletedAt: null } : null };
    if (!ws) return { space: null, reachable: false };
  }
  const space = ws.space && !ws.space.deletedAt ? { id: ws.space.id, name: ws.space.name } : null;
  if (!space || !ws.project.instanceId) return { space, reachable: false };
  const grant = await db.spaceBox.findFirst({ where: { spaceId: space.id, instanceId: ws.project.instanceId }, select: { id: true } });
  return { space, reachable: grant != null };
}

/**
 * The space a turn of workstream `workstreamId`'s chat loads (chat-send and
 * ask-run's `spaceMemory`): the chat's own while its box is granted it, null
 * for none (no space, or the grant gone), undefined when it can't be read,
 * which leaves the box to pick as for an older backend. Every turn of a chat
 * goes through this, a person's or an ask's, so they all load the same.
 */
export async function turnMemorySpace(workstreamId: string, db: ChatSpaceDb = prisma as unknown as ChatSpaceDb): Promise<string | null | undefined> {
  try {
    const place = await chatSpaceFor(workstreamId, {}, db);
    return place.space && place.reachable ? place.space.name : null;
  } catch (err) {
    console.warn(`[CHAT] ${workstreamId}: chat space: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * The project list's unfixed chats fixed in place (routes/projects.ts
 * listProjectsFor): each gets its box's first granted space, or none, and
 * `spaceId` / `spaceFixedAt` on the rows it is given say so. One grant read
 * for all the boxes; a row fixed meanwhile by another request keeps its own.
 */
export async function fixListedChatSpaces<R extends { id: string; spaceId?: string | null; spaceFixedAt?: Date | null }>(
  rows: R[],
  boxOf: (row: R) => string | null,
  db: ChatSpaceDb = prisma as unknown as ChatSpaceDb,
): Promise<void> {
  const unfixed = rows.filter(r => !r.spaceFixedAt);
  if (!unfixed.length) return;
  const boxes = [...new Set(unfixed.map(boxOf).filter((b): b is string => !!b))];
  const grants = boxes.length ? await db.spaceBox.findMany({
    where: { instanceId: { in: boxes }, space: { deletedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: { instanceId: true, spaceId: true },
  }) as Array<{ instanceId: string; spaceId: string }> : [];
  const first = new Map<string, string>();
  for (const g of grants) if (!first.has(g.instanceId)) first.set(g.instanceId, g.spaceId);
  const now = new Date();
  const bySpace = new Map<string | null, string[]>();
  const spaceOf = (r: R) => { const box = boxOf(r); return (box && first.get(box)) || null; };
  for (const r of unfixed) bySpace.set(spaceOf(r), [...(bySpace.get(spaceOf(r)) ?? []), r.id]);
  for (const [spaceId, ids] of bySpace) {
    await db.workstream.updateMany({ where: { id: { in: ids }, spaceFixedAt: null }, data: { spaceId, spaceFixedAt: now } });
  }
  // What the list answers: the fix just made (a row a concurrent request fixed first shows that on the next list).
  for (const r of unfixed) {
    r.spaceId = spaceOf(r);
    r.spaceFixedAt = now;
  }
}
