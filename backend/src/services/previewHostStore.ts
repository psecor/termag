/**
 * What the preview host and the landing page read and write:
 * a name's link with its
 * project, the viewer's standing, the one-time codes, and the sessions. Over
 * an interface, so services/previewHost.ts and routes/previewLanding.ts are
 * tested without a database (previewHostTestStore.ts); prismaPreviewHostStore
 * is the real one.
 */
import type { Instance, Prisma, User } from '@prisma/client';
import { prisma } from '../db';
import { audienceStandingOf, audienceViewerSeen, noteAudienceViewer, prismaAudienceOps } from './previewAudience';
import type { PreviewLinkRow } from './previewLinks';
import type { PreviewAudience, PreviewHostMode } from './previewLinkRules';

/** The link a name serves now (in whatever state), with what serving it needs. */
export interface HostLinkContext {
  link: PreviewLinkRow;
  project: {
    id: string;
    name: string;
    userId: string;
    instanceId: string | null;
    /** An archived project serves none of its links (served, below). */
    archived: boolean;
    owner: User;
    instance: Instance | null;
  };
  /** The link's workstream, `main` for the implicit one. */
  workstreamName: string;
}

export interface ViewerFacts {
  isCollaborator: boolean;
  hasGrant: boolean;
  removed: boolean;
}

export interface CodeRow {
  codeHash: string;
  linkId: string;
  userId: string;
  basis: string;
  tokenHash: string | null;
  sessionIdHash: string | null;
  next: string;
  expiresAt: Date;
}

export interface SessionRow {
  idHash: string;
  linkId: string;
  userId: string;
  basis: string;
  tokenHash: string | null;
  verifiedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface HostUser {
  id: string;
  googleEmail: string;
  displayName: string;
}

export interface PreviewHostStore {
  /** The link PreviewLinkName.linkId points at, in whatever state; null for no name or no link. */
  resolveName(name: string): Promise<HostLinkContext | null>;
  /** The viewer's standing on the link's audience now: collaborator, a live grantee, removed. */
  viewer(link: Pick<PreviewLinkRow, 'audienceId' | 'projectId'>, userId: string, now: Date): Promise<ViewerFacts>;
  user(userId: string): Promise<HostUser | null>;
  createCode(row: CodeRow): Promise<void>;
  /** Delete the code and hand it back, when it exists and hasn't expired: one statement, so it works once (SR10). */
  takeCode(codeHash: string, now: Date): Promise<CodeRow | null>;
  createSession(row: Omit<SessionRow, 'revokedAt' | 'createdAt'> & { createdAt?: Date }): Promise<void>;
  findSession(idHash: string): Promise<SessionRow | null>;
  /** Move a live session's verifiedAt on (a reverify's exchange). False when it is no longer live. */
  markVerified(idHash: string, at: Date): Promise<boolean>;
  revokeSession(idHash: string, at: Date): Promise<void>;
  /** Record an open (A3) on the link's audience: the viewer row made or its lastOpenedAt moved. `firstOpen` when it was made. */
  opened(audienceId: string, userId: string, at: Date): Promise<{ firstOpen: boolean }>;
  /** An event on the link's audience, delivered by this link; the actor is a user id. */
  addEvent(e: { link: Pick<PreviewLinkRow, 'id' | 'audienceId'>; kind: string; actorId: string | null; reason?: string | null; detail?: Record<string, unknown> | null }): Promise<void>;
}

/**
 * A name's link as the preview host and the landing page may serve it: one
 * whose project is archived reads as ended, whatever its audience says, so it
 * gets the same refusals and the same 404 as an ended link (A4). Archiving
 * ends the audiences (#1107's endPreviewAudiences); this fails closed when that
 * end failed, as the tech spec's "Data model" requires. Every path reads a
 * link through it: the session check, the redirect to the landing page, the
 * exchange, the landing page and its reverify.
 */
export function served(ctx: HostLinkContext | null): HostLinkContext | null {
  if (!ctx || !ctx.project.archived || ctx.link.endedAt !== null) return ctx;
  return { ...ctx, link: { ...ctx.link, endedAt: ctx.link.createdAt, endReason: 'project-archived' } };
}

// A link is read through its audience (services/previewAudience.ts): who it is
// for, its expiry and its end are the audience's; its name, port, host mode and
// token are its own. Flattened as previewLinks.ts's PreviewLinkRow.
/** The link's audience as previewLinkAccess's decide and basisHolds take it; the link itself is the delivery. */
export function accessAudienceOf(link: Pick<PreviewLinkRow, 'audience' | 'expiresAt' | 'endedAt'>): { kind: PreviewLinkRow['audience']; expiresAt: Date; endedAt: Date | null } {
  return { kind: link.audience, expiresAt: link.expiresAt, endedAt: link.endedAt };
}

const LINK_SELECT = {
  id: true, name: true, hostSuffix: true, audienceId: true, port: true, linkTokenHash: true, hostMode: true, requestId: true, createdAt: true,
  audience: {
    select: {
      ownerId: true, workstreamId: true, kind: true, expiresAt: true, endedAt: true, endReason: true,
      workstream: { select: { name: true } },
      project: { select: { id: true, name: true, userId: true, instanceId: true, archived: true, user: true, instance: true } },
    },
  },
} as const;

interface RawCode {
  codeHash: string; linkId: string; userId: string; basis: string; tokenHash: string | null; sessionIdHash: string | null; next: string; expiresAt: Date;
}

export const prismaPreviewHostStore: PreviewHostStore = {
  async resolveName(name) {
    // One read: the name, its link, the link's audience with its project (owner and box) and workstream.
    const row = await prisma.previewLinkName.findUnique({ where: { name }, select: { link: { select: LINK_SELECT } } });
    const l = row?.link;
    if (!l) return null;
    const { audience: a, ...own } = l;
    const { project, workstream } = a;
    const link: PreviewLinkRow = {
      ...own, projectId: project.id, workstreamId: a.workstreamId, ownerId: a.ownerId, audience: a.kind as PreviewAudience,
      expiresAt: a.expiresAt, endedAt: a.endedAt, endReason: a.endReason, hostMode: own.hostMode as PreviewHostMode,
    };
    return {
      link,
      project: { id: project.id, name: project.name, userId: project.userId, instanceId: project.instanceId, archived: project.archived, owner: project.user, instance: project.instance },
      workstreamName: workstream?.name ?? 'main',
    };
  },
  async viewer(link, userId, now) {
    const [share, standing] = await Promise.all([
      prisma.projectShare.findUnique({ where: { projectId_userId: { projectId: link.projectId, userId } }, select: { id: true } }),
      audienceStandingOf(link.audienceId, userId, now),
    ]);
    return { isCollaborator: !!share, ...standing };
  },
  user: (userId) => prisma.user.findUnique({ where: { id: userId }, select: { id: true, googleEmail: true, displayName: true } }),
  async createCode(row) {
    await prisma.previewLinkCode.create({ data: row });
  },
  async takeCode(codeHash, now) {
    const rows = await prisma.$queryRaw<RawCode[]>`
      DELETE FROM "preview_link_codes" WHERE "codeHash" = ${codeHash} AND "expiresAt" > ${now}
      RETURNING "codeHash", "linkId", "userId", "basis", "tokenHash", "sessionIdHash", "next", "expiresAt"`;
    return rows[0] ?? null;
  },
  async createSession(row) {
    await prisma.previewLinkSession.create({ data: row });
  },
  findSession: (idHash) => prisma.previewLinkSession.findUnique({ where: { idHash } }),
  async markVerified(idHash, at) {
    const n = await prisma.previewLinkSession.updateMany({ where: { idHash, revokedAt: null, expiresAt: { gt: at } }, data: { verifiedAt: at } });
    return n.count === 1;
  },
  async revokeSession(idHash, at) {
    await prisma.previewLinkSession.updateMany({ where: { idHash, revokedAt: null }, data: { revokedAt: at } });
  },
  async opened(audienceId, userId, at) {
    const seen = await audienceViewerSeen(audienceId, userId);
    await noteAudienceViewer(audienceId, userId, at);
    return { firstOpen: !seen };
  },
  async addEvent({ link, kind, actorId, reason, detail }) {
    await prismaAudienceOps(prisma).addEvent({ audienceId: link.audienceId, kind, actorId, reason: reason ?? null, delivery: { kind: 'link', id: link.id }, detail: detail ?? null });
  },
};
