/**
 * The preview audience core:
 * who may see a preview of a workstream, whatever delivers it. It owns four
 * tables, `PreviewAudience`, `PreviewAudienceGrantee`, `PreviewAudienceViewer`
 * and `PreviewAudienceEvent`, and nothing else reads or writes them through
 * Prisma (previewAudienceIsolation.test.ts).
 *
 * A delivery is how an audience gets to see the workstream: a preview link
 * (services/previewLinks.ts, a port at <name>.<preview domain>) today.
 * Preview shares (a guest browser pane) and webapp-attach's AttachGrant are
 * meant to become deliveries on the same core later, on their owners'
 * schedule: one audience, several deliveries, each with its own token (SR11),
 * so one revoke and one viewer removal cover all of them (SR18).
 *
 * What the core decides:
 * - who is in the audience: its `kind` (owner, people, link), its grantees,
 *   and the viewers removed from it (a viewer's `revokedAt`, the name preview
 *   shares use). The access rule itself is previewLinkAccess.ts's `decide`,
 *   over an audience and a delivery;
 * - when it lives: one audience-level expiry, plus an optional per-grantee
 *   `expiresAt` (shares will need per-person expiry; links leave it null);
 * - who may manage it: ManagePolicy, a value each delivery passes;
 * - how it ends: endPreviewAudience runs every registered delivery's end
 *   hook, so ending an audience ends each delivery on it with the
 *   delivery's own work (a link holds its name, revokes its sessions, drops
 *   its codes), and stamps the audience once. Archiving a project or removing
 *   a workstream calls endPreviewAudiences (routes/projects.ts,
 *   routes/workstreams.ts).
 *
 * Event actors are user ids (`actorId`), as preview shares' are.
 *
 * Provisional until preview shares' owner confirms them (open questions on
 * #1107): the expiry model, the manage policy and per-delivery tokens. Each
 * is one place here.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';

export const AUDIENCE_KINDS = ['owner', 'people', 'link'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

/** Why an audience ended. A delivery's own reasons (a share's merged PR, say) join the list when it moves onto the core. */
export type AudienceEndReason = 'expired' | 'revoked' | 'box-gone' | 'project-gone' | 'workstream-gone' | 'kill-switch' | 'admin';

export interface AudienceRow {
  id: string;
  projectId: string;
  workstreamId: string | null;
  ownerId: string;
  kind: AudienceKind;
  expiresAt: Date;
  revokedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  createdAt: Date;
}

export function audienceLive(a: Pick<AudienceRow, 'expiresAt' | 'endedAt'>, now: Date): boolean {
  return a.endedAt === null && a.expiresAt.getTime() > now.getTime();
}

/** A grantee row counts while its own expiry, if it has one, hasn't passed. */
export function granteeLive(g: { expiresAt: Date | null }, now: Date): boolean {
  return g.expiresAt === null || g.expiresAt.getTime() > now.getTime();
}

// ── Who may manage an audience ────────────────────────────────────────────

/**
 * Who may create an audience, and who may change one (extend, revoke, remove
 * a viewer). Each delivery passes its own: links let collaborators publish,
 * and the owner or the creator change it; preview shares, owner-only today,
 * would pass OWNER_ONLY.
 */
export interface ManagePolicy {
  create: 'owner' | 'owner-or-collaborator';
  change: 'owner' | 'owner-or-creator';
}

export const LINK_MANAGE_POLICY: ManagePolicy = { create: 'owner-or-collaborator', change: 'owner-or-creator' };
export const OWNER_ONLY_POLICY: ManagePolicy = { create: 'owner', change: 'owner' };

export interface ManagerStanding {
  isProjectOwner: boolean;
  isCollaborator: boolean;
}

export function mayCreateAudience(policy: ManagePolicy, s: ManagerStanding): boolean {
  return s.isProjectOwner || (policy.create === 'owner-or-collaborator' && s.isCollaborator);
}

export function mayChangeAudience(policy: ManagePolicy, s: ManagerStanding, audience: Pick<AudienceRow, 'ownerId'>, actorId: string): boolean {
  return s.isProjectOwner || (policy.change === 'owner-or-creator' && audience.ownerId === actorId);
}

// ── The writes, inside a delivery's transaction ───────────────────────────

export interface AudienceEventInput {
  audienceId: string;
  kind: string;
  actorId: string | null;
  reason?: string | null;
  /** The delivery it happened on (`link` and its id); unset for the audience itself. */
  delivery?: { kind: string; id: string } | null;
  detail?: Record<string, unknown> | null;
}

export type AudienceWrite = Pick<AudienceRow, 'projectId' | 'workstreamId' | 'ownerId' | 'kind' | 'expiresAt'>;
export type AudienceUpdate = Partial<Pick<AudienceRow, 'kind' | 'expiresAt' | 'revokedAt' | 'endedAt' | 'endReason'>>;

/**
 * What a delivery's transaction may do to the core tables. The prisma one is
 * prismaAudienceOps(tx), so a delivery's own writes and the audience's commit
 * together; tests use an in-memory one (previewLinksTestStore.ts).
 */
export interface AudienceOps {
  create(data: AudienceWrite): Promise<AudienceRow>;
  read(id: string): Promise<AudienceRow | null>;
  update(id: string, data: AudienceUpdate): Promise<AudienceRow>;
  /** Every grantee's user id, live or not. */
  granteeIds(audienceId: string): Promise<string[]>;
  /** Whether userId is a live grantee. */
  hasLiveGrant(audienceId: string, userId: string, now: Date): Promise<boolean>;
  /** Make the grantees exactly these users (their own expiry left null). */
  setGrantees(audienceId: string, userIds: string[]): Promise<void>;
  /** Drop one grantee (a viewer the owner removed). */
  removeGrantee(audienceId: string, userId: string): Promise<void>;
  /** Clear revokedAt for these viewers: naming someone again lets them back in. */
  unrevokeViewers(audienceId: string, userIds: string[]): Promise<void>;
  /** Mark a viewer removed, making their row if they never opened it. */
  revokeViewer(audienceId: string, userId: string, at: Date): Promise<void>;
  addEvent(e: AudienceEventInput): Promise<void>;
}

/**
 * Stamp an audience ended for `reason`, once: a second end, or one of an
 * audience already ended, changes nothing and answers null. A revoke also
 * sets revokedAt. The caller ends its delivery in the same transaction.
 */
export async function endAudienceInTx(ops: AudienceOps, audienceId: string, reason: AudienceEndReason, actorId: string | null, now: Date): Promise<AudienceRow | null> {
  const a = await ops.read(audienceId);
  if (!a || a.endedAt !== null) return null;
  const ended = await ops.update(a.id, { endedAt: now, endReason: reason, ...(reason === 'revoked' ? { revokedAt: now } : {}) });
  await ops.addEvent({ audienceId: a.id, kind: reason === 'revoked' ? 'revoked' : 'ended', actorId, reason });
  return ended;
}

// ── The end hook ──────────────────────────────────────────────────────────

/**
 * A delivery's end: end everything it has on the audience (each under its
 * own locks, stamping the audience with endAudienceInTx in the same
 * transaction). Answers whether it had anything there.
 */
export interface PreviewDelivery {
  kind: string;
  end(audienceId: string, reason: AudienceEndReason, actorId: string | null, now: Date): Promise<boolean>;
}

const deliveries = new Map<string, PreviewDelivery>();

/** Register a delivery's end hook (services/previewLinks.ts installPreviewLinkDelivery, from index.ts). */
export function registerPreviewDelivery(d: PreviewDelivery): void {
  deliveries.set(d.kind, d);
}

/** For tests: forget every registered delivery. */
export function resetPreviewDeliveries(): void {
  deliveries.clear();
}

export interface AudienceEndDeps {
  /** The live audiences of a project or a workstream. */
  liveAudienceIds(where: { projectId?: string; workstreamId?: string }): Promise<string[]>;
  /** End an audience with no delivery on it: its own transaction. */
  endBare(audienceId: string, reason: AudienceEndReason, actorId: string | null, now: Date): Promise<void>;
  deliveries(): PreviewDelivery[];
}

/**
 * End one audience and so every delivery on it: each registered delivery's
 * end hook, then, if none had anything there, the audience on its own.
 */
export async function endPreviewAudience(
  audienceId: string, reason: AudienceEndReason, actorId: string | null = null, now: Date = new Date(), deps: AudienceEndDeps = prismaAudienceEndDeps,
): Promise<void> {
  let delivered = false;
  for (const d of deps.deliveries()) {
    if (await d.end(audienceId, reason, actorId, now)) delivered = true;
  }
  if (!delivered) await deps.endBare(audienceId, reason, actorId, now);
}

/**
 * End every live audience of a project (archived: `project-gone`) or a
 * workstream (removed: `workstream-gone`), as preview shares end theirs. Call
 * it before the rows go, so live sessions close and names are held 30 days
 * from now; a cascade alone would drop the sessions but not tell the relay.
 * Answers how many ended; throws one error naming any that didn't (each cause in `errors`),
 * after trying every one. Name reservations survive either way (SR19).
 */
export async function endPreviewAudiences(
  where: { projectId: string } | { workstreamId: string },
  reason: 'project-gone' | 'workstream-gone',
  actorId: string | null = null,
  now: Date = new Date(),
  deps: AudienceEndDeps = prismaAudienceEndDeps,
): Promise<number> {
  const ids = await deps.liveAudienceIds(where);
  // One audience failing to end never leaves the rest live: each is tried
  // (twice), and the failures are thrown together once all have been, so the
  // caller's log names them. An archived project's rows don't cascade.
  const failed: Array<{ id: string; error: unknown }> = [];
  for (const id of ids) {
    try {
      await endPreviewAudience(id, reason, actorId, now, deps);
    } catch {
      try { await endPreviewAudience(id, reason, actorId, now, deps); } catch (error) { failed.push({ id, error }); }
    }
  }
  const ended = ids.length - failed.length;
  if (ended) console.log(`[PREVIEW-AUDIENCE] ended ${ended} audience(s): ${reason}`);
  if (failed.length) {
    const err = new Error(`${failed.length} of ${ids.length} preview audience(s) did not end (${reason}): ${failed.map(f => f.id).join(', ')}`
      + ` (${failed.map(f => (f.error instanceof Error ? f.error.message : String(f.error))).join('; ')})`);
    throw Object.assign(err, { errors: failed.map(f => f.error) });
  }
  return ended;
}

// ── Prisma ────────────────────────────────────────────────────────────────

const AUDIENCE_SELECT = {
  id: true, projectId: true, workstreamId: true, ownerId: true, kind: true, expiresAt: true, revokedAt: true, endedAt: true, endReason: true, createdAt: true,
} as const;

function asAudience(a: Prisma.PreviewAudienceGetPayload<{ select: typeof AUDIENCE_SELECT }>): AudienceRow {
  return { ...a, kind: a.kind as AudienceKind };
}

export function prismaAudienceOps(tx: Prisma.TransactionClient): AudienceOps {
  return {
    async create(data) { return asAudience(await tx.previewAudience.create({ data, select: AUDIENCE_SELECT })); },
    async read(id) {
      const a = await tx.previewAudience.findUnique({ where: { id }, select: AUDIENCE_SELECT });
      return a ? asAudience(a) : null;
    },
    async update(id, data) { return asAudience(await tx.previewAudience.update({ where: { id }, data, select: AUDIENCE_SELECT })); },
    async granteeIds(audienceId) {
      return (await tx.previewAudienceGrantee.findMany({ where: { audienceId }, select: { userId: true } })).map(g => g.userId);
    },
    async hasLiveGrant(audienceId, userId, now) {
      const g = await tx.previewAudienceGrantee.findUnique({ where: { audienceId_userId: { audienceId, userId } }, select: { expiresAt: true } });
      return !!g && granteeLive(g, now);
    },
    async setGrantees(audienceId, userIds) {
      await tx.previewAudienceGrantee.deleteMany({ where: { audienceId, userId: { notIn: userIds } } });
      if (userIds.length) await tx.previewAudienceGrantee.createMany({ data: userIds.map(userId => ({ audienceId, userId })), skipDuplicates: true });
    },
    async removeGrantee(audienceId, userId) {
      await tx.previewAudienceGrantee.deleteMany({ where: { audienceId, userId } });
    },
    async unrevokeViewers(audienceId, userIds) {
      if (userIds.length) await tx.previewAudienceViewer.updateMany({ where: { audienceId, userId: { in: userIds }, revokedAt: { not: null } }, data: { revokedAt: null } });
    },
    async revokeViewer(audienceId, userId, at) {
      // A user id that names nobody makes no row (the relation would refuse it).
      if (!(await tx.user.findUnique({ where: { id: userId }, select: { id: true } }))) return;
      await tx.previewAudienceViewer.upsert({
        where: { audienceId_userId: { audienceId, userId } },
        create: { audienceId, userId, firstOpenedAt: at, lastOpenedAt: at, revokedAt: at },
        update: { revokedAt: at },
      });
    },
    async addEvent({ audienceId, kind, actorId, reason, delivery, detail }) {
      await tx.previewAudienceEvent.create({
        data: {
          audienceId, kind, actorId, reason: reason ?? null, deliveryKind: delivery?.kind ?? null, deliveryId: delivery?.id ?? null,
          detail: (detail ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    },
  };
}

/** What a delivery's list shows of its audience: the relation to include, and its view. */
export const AUDIENCE_LIST_INCLUDE = {
  workstream: { select: { name: true } },
  owner: { select: { id: true, googleEmail: true, displayName: true } },
  grantees: { include: { user: { select: { id: true, googleEmail: true, displayName: true } } } },
  viewers: { include: { user: { select: { id: true, googleEmail: true, displayName: true } } }, orderBy: { lastOpenedAt: 'desc' } },
} as const satisfies Prisma.PreviewAudienceInclude;

export type ListedAudience = Prisma.PreviewAudienceGetPayload<{ include: typeof AUDIENCE_LIST_INCLUDE }>;

export interface PersonView { id: string; email: string; displayName: string }

export interface AudienceListView extends AudienceRow {
  workstreamName: string | null;
  owner: PersonView;
  grantees: Array<PersonView & { expiresAt: Date | null }>;
  viewers: Array<PersonView & { firstOpenedAt: Date; lastOpenedAt: Date; revokedAt: Date | null }>;
}

function person(u: { id: string; googleEmail: string; displayName: string }): PersonView {
  return { id: u.id, email: u.googleEmail, displayName: u.displayName };
}

export function audienceListView(a: ListedAudience): AudienceListView {
  return {
    id: a.id, projectId: a.projectId, workstreamId: a.workstreamId, ownerId: a.ownerId, kind: a.kind as AudienceKind, expiresAt: a.expiresAt,
    revokedAt: a.revokedAt, endedAt: a.endedAt, endReason: a.endReason, createdAt: a.createdAt,
    workstreamName: a.workstream?.name ?? null,
    owner: person(a.owner),
    grantees: a.grantees.map(g => ({ ...person(g.user), expiresAt: g.expiresAt })),
    viewers: a.viewers.map(v => ({ ...person(v.user), firstOpenedAt: v.firstOpenedAt, lastOpenedAt: v.lastOpenedAt, revokedAt: v.revokedAt })),
  };
}

/** The where for a delivery's list: audiences of a project live or ended since `since`, or someone's live ones. */
export function audienceListWhere(q: { projectId: string; since: Date } | { ownerId: string; now: Date }): Prisma.PreviewAudienceWhereInput {
  if ('projectId' in q) return { projectId: q.projectId, OR: [{ endedAt: null, expiresAt: { gt: q.since } }, { endedAt: { gt: q.since } }] };
  return { OR: [{ ownerId: q.ownerId }, { project: { userId: q.ownerId } }], endedAt: null, expiresAt: { gt: q.now } };
}

/** Viewer facts the access rule needs, for one user (previewLinkAccess.ts AccessViewer's audience half). */
export async function audienceStandingOf(audienceId: string, userId: string, now: Date, client: Prisma.TransactionClient = prisma): Promise<{ hasGrant: boolean; removed: boolean }> {
  const [g, v] = await Promise.all([
    client.previewAudienceGrantee.findUnique({ where: { audienceId_userId: { audienceId, userId } }, select: { expiresAt: true } }),
    client.previewAudienceViewer.findUnique({ where: { audienceId_userId: { audienceId, userId } }, select: { revokedAt: true } }),
  ]);
  return { hasGrant: !!g && granteeLive(g, now), removed: !!v?.revokedAt };
}

/** Whether this viewer has opened the preview before (a viewer row, removed or not): the landing page's first-open hand-off. */
export async function audienceViewerSeen(audienceId: string, userId: string, client: Prisma.TransactionClient = prisma): Promise<boolean> {
  return !!(await client.previewAudienceViewer.findUnique({ where: { audienceId_userId: { audienceId, userId } }, select: { id: true } }));
}

/** Record that a viewer opened the preview (A3): their row made or its lastOpenedAt moved; a removed viewer's stays removed. */
export async function noteAudienceViewer(audienceId: string, userId: string, now: Date, client: Prisma.TransactionClient = prisma): Promise<void> {
  await client.previewAudienceViewer.upsert({
    where: { audienceId_userId: { audienceId, userId } },
    create: { audienceId, userId, firstOpenedAt: now, lastOpenedAt: now },
    update: { lastOpenedAt: now },
  });
}

export const prismaAudienceEndDeps: AudienceEndDeps = {
  async liveAudienceIds(where) {
    const rows = await prisma.previewAudience.findMany({ where: { ...where, endedAt: null }, select: { id: true } });
    return rows.map(r => r.id);
  },
  async endBare(audienceId, reason, actorId, now) {
    await prisma.$transaction(tx => endAudienceInTx(prismaAudienceOps(tx), audienceId, reason, actorId, now));
  },
  deliveries: () => [...deliveries.values()],
};
