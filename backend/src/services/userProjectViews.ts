/**
 * What GET /api/user-projects and /:id answer
 * : a person's projects, each with its repositories and its
 * checkouts on their boxes, most recently active first. Owner only: the read
 * is by the caller's id, so a collaborator never sees another person's
 * project. The view is pure (`userProjectView`); the reads are below it.
 */
import { prisma } from '../db';
import { repoDisplayName } from './userProjects';
import { iconChoiceOf, iconSrc, type IconChoice } from './projectIcons';

export interface UserProjectView {
  id: string;
  name: string;
  /**
   * `iconId`: its detected icon, drawn when the project's icon is
   * automatic; `iconSrc` that icon as a data: URI, for the first two repositories (the ones the icon draws).
   */
  repos: Array<{ repoKey: string; name: string; url: string; defaultBranch: string | null; iconId: string | null; iconSrc: string | null }>;
  /** What its icon is: automatic, the letters, or `imageId`'s image, inline as `src` (a data: URI). */
  icon: { choice: IconChoice; imageId: string | null; src: string | null };
  archived: boolean;
  /** The newest `lastActiveAt` of its checkouts, else its `createdAt`; not stored. */
  lastActiveAt: string;
  /** Its Project files (milestone 8); null until then. */
  filesSpace: { name: string } | null;
  checkouts: Array<{
    projectId: string;
    instanceId: string | null;
    boxName: string | null;
    boxStatus: string | null;
    /** Live workstreams. */
    sessions: number;
    archived: boolean;
  }>;
}

/** What the view reads of a project row (the select below). */
export interface UserProjectRow {
  id: string;
  name: string;
  archivedAt: Date | null;
  createdAt: Date;
  repos: ReadonlyArray<{
    repoKey: string; url: string; defaultBranch: string | null; position: number;
    iconId?: string | null; icon?: { mimeType: string; data: Uint8Array } | null;
  }>;
  /** Its icon; absent reads as automatic. */
  iconChoice?: string | null;
  iconId?: string | null;
  icon?: { mimeType: string; data: Uint8Array } | null;
  /** Its Project files; one deleted since (until the sweep purges it and the key goes null) counts as none. */
  filesSpace: { name: string; deletedAt?: Date | null } | null;
  checkouts: ReadonlyArray<{
    id: string;
    instanceId: string | null;
    archived: boolean;
    lastActiveAt: Date;
    instance: { name: string; status: string } | null;
    _count: { workstreams: number };
  }>;
}

/** Its icon choice, with the chosen image inline (an image that's gone reads as automatic). */
function iconOf(row: UserProjectRow): UserProjectView['icon'] {
  const { choice, imageId } = iconChoiceOf({ iconChoice: row.iconChoice ?? null, iconId: row.iconId ?? null });
  return { choice, imageId, src: choice === 'image' && row.icon ? iconSrc(row.icon) : null };
}

/** One project's view: repositories in order, checkouts most recently active first. */
export function userProjectView(row: UserProjectRow): UserProjectView {
  const checkouts = [...row.checkouts].sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime() || (a.id < b.id ? -1 : 1));
  const lastActive = checkouts[0]?.lastActiveAt ?? row.createdAt;
  return {
    id: row.id,
    name: row.name,
    repos: [...row.repos].sort((a, b) => a.position - b.position)
      .map((r, i) => ({
        repoKey: r.repoKey, name: repoDisplayName(r.url), url: r.url, defaultBranch: r.defaultBranch, iconId: r.iconId ?? null,
        // Only the first two: the icon draws one, or two split on the diagonal, and every byte here is in the list.
        iconSrc: i < 2 && r.icon ? iconSrc(r.icon) : null,
      })),
    icon: iconOf(row),
    archived: row.archivedAt !== null,
    lastActiveAt: lastActive.toISOString(),
    filesSpace: row.filesSpace && !row.filesSpace.deletedAt ? { name: row.filesSpace.name } : null,
    checkouts: checkouts.map(c => ({
      projectId: c.id,
      instanceId: c.instanceId,
      boxName: c.instance?.name ?? null,
      boxStatus: c.instance?.status ?? null,
      sessions: c._count.workstreams,
      archived: c.archived,
    })),
  };
}

/** A person's projects, most recently active first (ties: newest made first). */
export function sortUserProjectViews(views: UserProjectView[]): UserProjectView[] {
  return views.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || (a.id < b.id ? 1 : -1));
}

const selectFor = (userId: string) => ({
  id: true, name: true, archivedAt: true, createdAt: true, iconChoice: true, iconId: true,
  icon: { select: { mimeType: true, data: true } },
  repos: { select: { repoKey: true, url: true, defaultBranch: true, position: true, iconId: true, icon: { select: { mimeType: true, data: true } } } },
  filesSpace: { select: { name: true, deletedAt: true } },
  // A checkout is only ever attached to its owner's project; the filter keeps it that way here too.
  checkouts: {
    where: { userId },
    select: {
      id: true, instanceId: true, archived: true, lastActiveAt: true,
      instance: { select: { name: true, status: true } },
      _count: { select: { workstreams: { where: { archived: false } } } },
    },
  },
}) as const;

/** GET /api/user-projects: every project of the caller's, archived ones included. */
export async function listUserProjectViews(userId: string): Promise<UserProjectView[]> {
  const rows = await prisma.userProject.findMany({ where: { userId }, select: selectFor(userId) });
  return sortUserProjectViews(rows.map(userProjectView));
}

/** GET /api/user-projects/:id: one of the caller's projects, or null when it isn't theirs. */
export async function userProjectViewFor(userId: string, id: string): Promise<UserProjectView | null> {
  const row = await prisma.userProject.findFirst({ where: { id, userId }, select: selectFor(userId) });
  return row ? userProjectView(row) : null;
}
