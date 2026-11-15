/**
 * Session pins: the sessions a person pinned in the
 * chat sidebar, kept on the server so Pinned is the same on every browser, the
 * phone and the desktop app. One `session_pins` row per (person, workstream).
 *
 * A pin names its session by `Workstream.id`: the id every client already
 * has for a sidebar row (`ChatSessionRow.workstreamId`, the desktop's
 * `GET /api/cli/v1/chats` rows included), and the one that survives a project
 * rename or a session rename, where `(projectId, workstream name)` does not.
 *
 * Deleting the workstream, its project or the person deletes the pin (the
 * foreign keys cascade). Archiving keeps it: the list leaves out a session
 * that is archived (its workstream or its project), so an archive's Undo or a
 * reopen brings it back pinned. The list also leaves out a session the person
 * can no longer see (a share revoked), and pinning one answers 404, as it
 * does a session the sidebar never lists (SIDEBAR_SESSION).
 */
import { prisma } from '../db';

export interface SessionPinView {
  workstreamId: string;
  /** The session's checkout (Project.id) and workstream name: the sidebar row's key, `${projectId}|${workstream}`, as of this read. */
  projectId: string;
  workstream: string;
  pinnedAt: string;
}

export type PinOutcome =
  | { ok: true; pin: SessionPinView; created: boolean }
  | { ok: false; status: 404 | 409; code: 'session_not_found' | 'session_archived'; error: string };

/** A cuid, or anything else id-shaped; refused before it reaches a query. */
const WORKSTREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isWorkstreamId(id: unknown): id is string {
  return typeof id === 'string' && WORKSTREAM_ID.test(id);
}

/** Projects the person can see: their own, or one shared with them (as the sidebar lists). */
const visibleProject = (userId: string) => ({ OR: [{ userId }, { shares: { some: { userId } } }] });

/**
 * Workstreams the chat sidebar lists (frontend chat/simpleChat.ts chatRows):
 * a normal project's, and an automation's runs, but not the automation's
 * `main`, where no agent runs. Never MetaTerm or a space orchestrator.
 */
export const SIDEBAR_SESSION = {
  OR: [{ project: { kind: 'normal' } }, { project: { kind: 'automation' }, name: { not: 'main' } }],
};

const PIN_SELECT = {
  createdAt: true,
  workstream: { select: { id: true, name: true, projectId: true } },
} as const;

function viewOf(row: { createdAt: Date; workstream: { id: string; name: string; projectId: string } }): SessionPinView {
  return { workstreamId: row.workstream.id, projectId: row.workstream.projectId, workstream: row.workstream.name, pinnedAt: row.createdAt.toISOString() };
}

/** The person's pins on live sidebar sessions they can see, oldest pin first. */
export async function listSessionPins(userId: string): Promise<SessionPinView[]> {
  const rows = await prisma.sessionPin.findMany({
    where: { userId, workstream: { AND: [{ archived: false, project: { archived: false, ...visibleProject(userId) } }, SIDEBAR_SESSION] } },
    orderBy: [{ createdAt: 'asc' }, { workstreamId: 'asc' }],
    select: PIN_SELECT,
  });
  return rows.map(viewOf);
}

const isPrismaCode = (err: unknown, code: string) => (err as { code?: unknown } | null)?.code === code;

/**
 * Pins a session the person can see in the sidebar. Pinning one already
 * pinned answers its pin with `created: false`. An archived session is refused
 * (409), since the list would not show it; one they can't see, that the
 * sidebar doesn't list, or that is gone, is 404.
 */
export async function pinSession(userId: string, workstreamId: string): Promise<PinOutcome> {
  const ws = await prisma.workstream.findFirst({
    where: { AND: [{ id: workstreamId, project: visibleProject(userId) }, SIDEBAR_SESSION] },
    select: { archived: true, project: { select: { archived: true } } },
  });
  if (!ws) return { ok: false, status: 404, code: 'session_not_found', error: 'No such session' };
  if (ws.archived || ws.project.archived) return { ok: false, status: 409, code: 'session_archived', error: 'Reopen the session to pin it' };
  let created: boolean;
  try {
    created = (await prisma.sessionPin.createMany({ data: [{ userId, workstreamId }], skipDuplicates: true })).count > 0;
  } catch (err) {
    // Deleted between the read and the insert: the foreign key refuses it.
    if (isPrismaCode(err, 'P2003')) return { ok: false, status: 404, code: 'session_not_found', error: 'No such session' };
    throw err;
  }
  const row = await prisma.sessionPin.findUnique({ where: { userId_workstreamId: { userId, workstreamId } }, select: PIN_SELECT });
  // Unpinned, or the session deleted, since the insert.
  if (!row) return { ok: false, status: 404, code: 'session_not_found', error: 'No such session' };
  return { ok: true, pin: viewOf(row), created };
}

/** Unpins it: whether a pin was removed. Unpinning one that isn't pinned (or doesn't exist) changes nothing. */
export async function unpinSession(userId: string, workstreamId: string): Promise<boolean> {
  return (await prisma.sessionPin.deleteMany({ where: { userId, workstreamId } })).count > 0;
}
