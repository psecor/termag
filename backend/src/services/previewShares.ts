/**
 * Preview shares: the database half and the live
 * guest sockets. routes/previewShares.ts and the browser socket's guest path
 * (routes/browserWs.ts) are its only callers: nothing else in the backend
 * reads a PreviewShare, which services/previewShareIsolation.test.ts holds to.
 */
import { Prisma, type Instance, type User } from '@prisma/client';
import { prisma } from '../db';
import { GUEST_REFUSAL_MESSAGES, guestPaneKey, wakeBudget, type GuestShare, type OriginRecipe } from './previewShareRules';
import { projectAgentCapabilities, sendForProject, type ProjectHost } from './agentRegistry';
import { BROWSER_PANE_PROFILES_CAPABILITY } from './browserPane';
import { projectDirUnder, resolveProjectRoot } from './projectPaths';

export interface ShareRow extends GuestShare {
  projectId: string;
  workstreamId: string | null;
  ownerId: string;
  originRecipe: OriginRecipe;
  lastOpenedAt: Date | null;
  createdAt: Date;
  /** A link share's PR (phase 2), `owner/name` and number; null on a per-person share. */
  prRepo: string | null;
  prNumber: number | null;
  prCommentId: string | null;
  prHeadOid: string | null;
}

/** Everything the guest path needs about a share, in one read. */
export interface GuestShareContext {
  share: ShareRow;
  project: {
    id: string; name: string; userId: string; archived: boolean; instanceId: string | null; setupStatus: string;
    ownerUnixUsername: string; instance: Instance | null;
  };
  owner: User;
  /** The workstream as it is now (its current name), or null when it is gone or archived. */
  workstream: { name: string; archived: boolean } | null;
  /** The project's reviewer sign-in hint (PreviewShareSettings), if it set one. */
  accountHint?: string | null;
  /**
   * A link share's row for the viewer it was read for (guestContext's
   * viewerId): what resolveGuestAccess admits them by. Null when they have
   * none (they never opened its link), undefined when not asked.
   */
  viewerRow?: { revokedAt: Date | null } | null;
}

/** Who looked at a link share: its owner sees each, and can revoke one. */
export interface ShareViewerView {
  userId: string;
  name: string;
  email: string;
  firstOpenedAt: string;
  lastOpenedAt: string;
  revokedAt: string | null;
}

export interface ShareView {
  id: string;
  /** user: one named grantee; link: anyone signed in who opens its link (phase 2). */
  audience: 'user' | 'link';
  workstream: string;
  grantee: { id: string; email: string; name: string } | null;
  recipe: OriginRecipe;
  expiresAt: string;
  revokedAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
  lastOpenedAt: string | null;
  createdAt: string;
  liveViewers: number;
  /** Loopback origins a guest's browser was refused lately: what the owner may want to add. */
  blockedOrigins: string[];
  /** A link share's PR. */
  pr: { repo: string; number: number; url: string; headOid: string | null } | null;
  /** A link share's viewers, most recent first. */
  viewers: ShareViewerView[];
}

export interface SharedWithMeView {
  id: string;
  owner: { name: string };
  project: { name: string };
  workstream: string;
  expiresAt: string;
  /** A link share the viewer opened: its PR. */
  pr?: { repo: string; number: number } | null;
}

/** A live link share and what the sweep needs to check its PR (services/previewShareLinks.ts). */
export interface LiveLinkShare {
  share: ShareRow;
  owner: { id: string; displayName: string; slackUserId: string | null; googleEmail: string };
  host: ProjectHost;
}

const shareSelect = {
  id: true, projectId: true, workstreamId: true, ownerId: true, audience: true, granteeId: true, originRecipe: true,
  expiresAt: true, revokedAt: true, endedAt: true, endedReason: true, lastOpenedAt: true, createdAt: true,
  prRepo: true, prNumber: true, prCommentId: true, prHeadOid: true,
} satisfies Prisma.PreviewShareSelect;

export const prUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

/** A project's preview settings. */
export interface PreviewSettings {
  recipe: OriginRecipe | null;
  accountHint: string | null;
  /** Share the PRs its owner opens automatically (4c). */
  prLinksEnabled: boolean;
  pathFilter: string[];
}

/** liveLinkShares reads this many at a time. */
const LIVE_LINK_PAGE = 500;

type SelectedShare = Prisma.PreviewShareGetPayload<{ select: typeof shareSelect }>;

function toRow(s: SelectedShare): ShareRow {
  return { ...s, originRecipe: s.originRecipe as unknown as OriginRecipe };
}

/**
 * The share's workstream as it is now. A share on a project's main may have
 * no row id: main is the project's own checkout, there whether or not it has
 * a row (a project can have feature workstreams and no `main` row). Once a
 * `main` row exists the share is bound to it, and from then on follows it.
 */
async function currentWorkstream(share: ShareRow): Promise<{ name: string; archived: boolean } | null> {
  if (share.workstreamId) {
    const row = await prisma.workstream.findUnique({ where: { id: share.workstreamId }, select: { name: true, archived: true } });
    return row ?? null;
  }
  const main = await prisma.workstream.findUnique({ where: { projectId_name: { projectId: share.projectId, name: 'main' } }, select: { id: true, name: true, archived: true } });
  if (!main) return { name: 'main', archived: false };
  await prisma.previewShare.update({ where: { id: share.id }, data: { workstreamId: main.id } }).catch(() => {});
  return { name: main.name, archived: main.archived };
}

export interface PreviewShareStore {
  /** The share, its project and owner; with `viewerId`, a link share's row for that viewer too. */
  guestContext(shareId: string, viewerId?: string): Promise<GuestShareContext | null>;
  create(input: { projectId: string; workstreamId: string | null; ownerId: string; granteeId: string; recipe: OriginRecipe; expiresAt: Date }): Promise<ShareRow>;
  /** The live per-person share of this workstream for this grantee, if any (a share again renews it). */
  liveFor(input: { projectId: string; workstreamIds: (string | null)[]; granteeId: string; now: Date }): Promise<ShareRow | null>;
  /** A live share given a new recipe and expiry, its id (and link) kept; null when it isn't live. */
  renew(projectId: string, shareId: string, input: { recipe: OriginRecipe; expiresAt: Date; actorId: string }): Promise<ShareRow | null>;
  listForProject(projectId: string): Promise<ShareView[]>;
  sharedWith(userId: string): Promise<SharedWithMeView[]>;
  /** Revoke one share, scoped by both ids; the revoked row, or null when there was nothing live to revoke. */
  revoke(projectId: string, shareId: string, actorId: string): Promise<ShareRow | null>;
  extend(projectId: string, shareId: string, expiresAt: Date, actorId: string): Promise<ShareRow | null>;
  /** End every live share matching (a workstream removed, a project archived); the ended rows. */
  endWhere(where: { workstreamId?: string; projectId?: string }, reason: string): Promise<ShareRow[]>;
  recordEvent(shareId: string, kind: string, opts?: { actorId?: string | null; reason?: string | null; detail?: Prisma.InputJsonValue }): Promise<void>;
  noteOpened(shareId: string, viewerId: string): Promise<void>;
  /**
   * The viewers whose guest profiles a share's end must forget and an extend
   * must keep: its grantee, anyone who opened it, and its owner, whose
   * "Preview as guest" (`as=guest`) has a guest profile of its own.
   */
  viewerIds(share: ShareRow): Promise<string[]>;

  // ── Phase 2: link shares ──
  /** The link share whose token hashes to `tokenHash`, by id; null for none. */
  linkShareId(tokenHash: string): Promise<string | null>;
  /**
   * Give a workstream its link share for a PR, in one transaction: a live
   * one for the same PR is returned as it is (a second click, a repeated
   * milestone); one for another PR, or past its expiry, is ended first
   * (`superseded`, `expired`) and returned as `ended`. The new share's token
   * hash is `hashFor(id)`, set once its id exists.
   */
  openLinkShare(input: {
    projectId: string; workstreamId: string | null; ownerId: string; recipe: OriginRecipe; expiresAt: Date;
    prRepo: string; prNumber: number; prHeadOid: string; linkKey: string; hashFor: (shareId: string) => string; now: Date;
  }): Promise<{ share: ShareRow; existing: boolean; ended: ShareRow | null }>;
  /** Someone opened a link share's link: their viewer row (made once; a revoked one stays revoked). */
  addViewer(shareId: string, userId: string): Promise<{ revokedAt: Date | null }>;
  /** Revoke one viewer of a link share, scoped by project; whether there was one to revoke. */
  revokeViewer(projectId: string, shareId: string, userId: string, actorId: string): Promise<boolean>;
  setComment(shareId: string, commentId: string | null): Promise<void>;
  /**
   * Take the right to post a link share's comment, once per share across
   * orchestrators: `prCommentId` goes from empty (or a claim older than
   * `staleMs`, a poster that died) to `pending:<now>`. False when another
   * poster holds it, or the comment is there.
   */
  claimComment(shareId: string, now: number, staleMs: number): Promise<boolean>;
  /** The claim's outcome: the comment's id, or empty again (the post failed). Only while this claim holds. */
  settleComment(shareId: string, claimedAt: number, commentId: string | null): Promise<void>;
  /** The share as it is now, for a poster to see whether it ended while the comment was posted. */
  shareRow(shareId: string): Promise<ShareRow | null>;
  /** The PR number a superseded link share moved to, from its `ended` event; null when it wasn't superseded. */
  supersededBy(shareId: string): Promise<number | null>;
  setPrHead(shareId: string, headOid: string): Promise<void>;
  /** End one live share (the sweep: merged, closed, expired, token-invalid); the ended row, or null when it already had ended. */
  endOne(shareId: string, reason: string): Promise<ShareRow | null>;
  liveLinkShares(): Promise<LiveLinkShare[]>;
  /**
   * Take one of the owner's wakes for this share, atomically: under a lock
   * per owner, their wakes in the last 24 hours (the `woke` events of all
   * their shares) are checked against the budget, and the new one recorded.
   * `wakeId` lets a start that fails give it back.
   */
  claimWake(input: { ownerId: string; shareId: string; viewerId: string; now: number }): Promise<{ ok: true; wakeId: string } | { ok: false; reason: 'too-soon' | 'daily'; retryAt: number }>;
  refundWake(wakeId: string): Promise<void>;
  /** A project's preview settings (PreviewShareSettings): its default recipe and reviewer sign-in hint, and its automatic shares (4c). */
  settings(projectId: string): Promise<PreviewSettings>;
  saveSettings(projectId: string, settings: PreviewSettings): Promise<PreviewSettings>;
}

export const prismaPreviewShareStore: PreviewShareStore = {
  async guestContext(shareId, viewerId) {
    const s = await prisma.previewShare.findUnique({
      where: { id: shareId },
      select: {
        ...shareSelect,
        project: { select: { id: true, name: true, userId: true, archived: true, instanceId: true, setupStatus: true, user: true, instance: true, previewShareSettings: { select: { reviewerAccountHint: true } } } },
      },
    });
    if (!s) return null;
    const { project, ...rest } = s;
    const share = toRow(rest);
    let viewerRow: GuestShareContext['viewerRow'];
    if (viewerId !== undefined && share.audience === 'link') {
      viewerRow = await prisma.previewShareViewer.findUnique({ where: { shareId_userId: { shareId, userId: viewerId } }, select: { revokedAt: true } });
    }
    return {
      share,
      project: {
        id: project.id, name: project.name, userId: project.userId, archived: project.archived, instanceId: project.instanceId,
        setupStatus: project.setupStatus, ownerUnixUsername: project.user.unixUsername, instance: project.instance,
      },
      owner: project.user,
      workstream: await currentWorkstream(share),
      accountHint: project.previewShareSettings?.reviewerAccountHint ?? null,
      ...(viewerRow !== undefined ? { viewerRow } : {}),
    };
  },

  async create({ projectId, workstreamId, ownerId, granteeId, recipe, expiresAt }) {
    const s = await prisma.previewShare.create({
      data: { projectId, workstreamId, ownerId, granteeId, audience: 'user', originRecipe: recipe as unknown as Prisma.InputJsonValue, expiresAt },
      select: shareSelect,
    });
    return toRow(s);
  },

  async liveFor({ projectId, workstreamIds, granteeId, now }) {
    const s = await prisma.previewShare.findFirst({
      where: {
        projectId, granteeId, audience: 'user', revokedAt: null, endedAt: null, expiresAt: { gt: now },
        OR: workstreamIds.map(workstreamId => ({ workstreamId })),
      },
      orderBy: { createdAt: 'desc' },
      select: shareSelect,
    });
    return s ? toRow(s) : null;
  },

  async renew(projectId, shareId, { recipe, expiresAt, actorId }) {
    const n = await prisma.previewShare.updateMany({
      where: { id: shareId, projectId, revokedAt: null, endedAt: null },
      data: { expiresAt, originRecipe: recipe as unknown as Prisma.InputJsonValue },
    });
    if (n.count === 0) return null;
    await this.recordEvent(shareId, 'renewed', { actorId, detail: { expiresAt: expiresAt.toISOString() } });
    const s = await prisma.previewShare.findUnique({ where: { id: shareId }, select: shareSelect });
    return s ? toRow(s) : null;
  },

  async listForProject(projectId) {
    const rows = await prisma.previewShare.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        ...shareSelect,
        grantee: { select: { id: true, googleEmail: true, displayName: true } },
        workstream: { select: { name: true } },
        events: { where: { kind: 'blocked-origin' }, orderBy: { at: 'desc' }, take: 20, select: { detail: true } },
        viewers: { orderBy: { lastOpenedAt: 'desc' }, take: 50, select: { userId: true, firstOpenedAt: true, lastOpenedAt: true, revokedAt: true, user: { select: { googleEmail: true, displayName: true } } } },
      },
    });
    return rows.map(r => ({
      id: r.id,
      audience: r.audience === 'link' ? 'link' as const : 'user' as const,
      workstream: r.workstream?.name ?? 'main',
      grantee: r.grantee ? { id: r.grantee.id, email: r.grantee.googleEmail, name: r.grantee.displayName } : null,
      recipe: r.originRecipe as unknown as OriginRecipe,
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: r.revokedAt?.toISOString() ?? null,
      endedAt: r.endedAt?.toISOString() ?? null,
      endedReason: r.endedReason,
      lastOpenedAt: r.lastOpenedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      liveViewers: liveGuestCount(r.id),
      blockedOrigins: [...new Set(r.events.map(e => (e.detail as { origin?: unknown } | null)?.origin).filter((o): o is string => typeof o === 'string'))].slice(0, 8),
      pr: r.prRepo && r.prNumber ? { repo: r.prRepo, number: r.prNumber, url: prUrl(r.prRepo, r.prNumber), headOid: r.prHeadOid } : null,
      viewers: r.viewers.map(v => ({
        userId: v.userId, name: v.user.displayName, email: v.user.googleEmail,
        firstOpenedAt: v.firstOpenedAt.toISOString(), lastOpenedAt: v.lastOpenedAt.toISOString(), revokedAt: v.revokedAt?.toISOString() ?? null,
      })),
    }));
  },

  async sharedWith(userId) {
    const rows = await prisma.previewShare.findMany({
      where: {
        revokedAt: null, endedAt: null, expiresAt: { gt: new Date() }, project: { archived: false },
        // Shared with them by name, or a PR's link they opened (and still may).
        OR: [{ granteeId: userId, audience: 'user' }, { audience: 'link', viewers: { some: { userId, revokedAt: null } } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, expiresAt: true, prRepo: true, prNumber: true,
        owner: { select: { displayName: true } },
        project: { select: { name: true } },
        workstream: { select: { name: true } },
      },
    });
    return rows.map(r => ({
      id: r.id, owner: { name: r.owner.displayName }, project: { name: r.project.name }, workstream: r.workstream?.name ?? 'main', expiresAt: r.expiresAt.toISOString(),
      pr: r.prRepo && r.prNumber ? { repo: r.prRepo, number: r.prNumber } : null,
    }));
  },

  async revoke(projectId, shareId, actorId) {
    const now = new Date();
    const n = await prisma.previewShare.updateMany({
      where: { id: shareId, projectId, revokedAt: null, endedAt: null },
      data: { revokedAt: now, endedAt: now, endedReason: 'revoked', activeLinkKey: null },
    });
    if (n.count === 0) return null;
    await this.recordEvent(shareId, 'revoked', { actorId });
    const s = await prisma.previewShare.findUnique({ where: { id: shareId }, select: shareSelect });
    return s ? toRow(s) : null;
  },

  async extend(projectId, shareId, expiresAt, actorId) {
    const n = await prisma.previewShare.updateMany({
      where: { id: shareId, projectId, revokedAt: null, endedAt: null },
      data: { expiresAt },
    });
    if (n.count === 0) return null;
    await this.recordEvent(shareId, 'extended', { actorId, detail: { expiresAt: expiresAt.toISOString() } });
    const s = await prisma.previewShare.findUnique({ where: { id: shareId }, select: shareSelect });
    return s ? toRow(s) : null;
  },

  async endWhere(where, reason) {
    const live = await prisma.previewShare.findMany({ where: { ...where, revokedAt: null, endedAt: null }, select: shareSelect });
    if (live.length === 0) return [];
    const now = new Date();
    await prisma.previewShare.updateMany({
      where: { id: { in: live.map(s => s.id) }, endedAt: null },
      data: { endedAt: now, endedReason: reason, activeLinkKey: null },
    });
    for (const s of live) await this.recordEvent(s.id, 'ended', { reason });
    // Read after the write, so the end hooks see a comment id stored meanwhile (announceLinkShare).
    const ended = await prisma.previewShare.findMany({ where: { id: { in: live.map(s => s.id) }, endedReason: reason }, select: shareSelect });
    return ended.map(toRow);
  },

  async recordEvent(shareId, kind, opts = {}) {
    await prisma.previewShareEvent.create({
      data: { shareId, kind, actorId: opts.actorId ?? null, reason: opts.reason ?? null, ...(opts.detail !== undefined ? { detail: opts.detail } : {}) },
    }).catch(err => console.warn(`[PREVIEW-SHARE] ${shareId}: event ${kind} not recorded: ${(err as Error).message}`));
  },

  async noteOpened(shareId, viewerId) {
    const now = new Date();
    await prisma.previewShare.update({ where: { id: shareId }, data: { lastOpenedAt: now } }).catch(() => {});
    // A link share's viewer: their own last look, for the owner's list.
    await prisma.previewShareViewer.updateMany({ where: { shareId, userId: viewerId }, data: { lastOpenedAt: now } }).catch(() => {});
    await this.recordEvent(shareId, 'opened', { actorId: viewerId });
  },

  async viewerIds(share) {
    const rows = await prisma.previewShareViewer.findMany({ where: { shareId: share.id }, select: { userId: true } });
    return [...new Set([...(share.granteeId ? [share.granteeId] : []), ...rows.map(r => r.userId), share.ownerId])];
  },

  async linkShareId(tokenHash) {
    const s = await prisma.previewShare.findUnique({ where: { linkTokenHash: tokenHash }, select: { id: true, audience: true } });
    return s && s.audience === 'link' ? s.id : null;
  },

  async openLinkShare(input) {
    const attempt = () => prisma.$transaction(async (tx) => {
      const active = await tx.previewShare.findUnique({ where: { activeLinkKey: input.linkKey }, select: shareSelect });
      let ended: ShareRow | null = null;
      if (active) {
        const live = !active.revokedAt && !active.endedAt && active.expiresAt.getTime() > input.now.getTime();
        if (live && active.prRepo?.toLowerCase() === input.prRepo.toLowerCase() && active.prNumber === input.prNumber) {
          return { share: toRow(active), existing: true, ended: null };
        }
        const reason = live ? 'superseded' : 'expired';
        // The row as the end leaves it, so the end hooks see a comment id stored meanwhile.
        const after = await tx.previewShare.update({
          where: { id: active.id },
          data: { activeLinkKey: null, ...(active.endedAt ? {} : { endedAt: input.now, endedReason: reason }) },
          select: shareSelect,
        });
        await tx.previewShareEvent.create({ data: { shareId: active.id, kind: 'ended', reason, detail: { by: `${input.prRepo}#${input.prNumber}` } } });
        ended = toRow(after);
      }
      const made = await tx.previewShare.create({
        data: {
          projectId: input.projectId, workstreamId: input.workstreamId, ownerId: input.ownerId, audience: 'link',
          originRecipe: input.recipe as unknown as Prisma.InputJsonValue, expiresAt: input.expiresAt,
          prRepo: input.prRepo, prNumber: input.prNumber, prHeadOid: input.prHeadOid, activeLinkKey: input.linkKey,
        },
        select: { id: true },
      });
      const share = await tx.previewShare.update({ where: { id: made.id }, data: { linkTokenHash: input.hashFor(made.id) }, select: shareSelect });
      await tx.previewShareEvent.create({ data: { shareId: share.id, kind: 'created', actorId: input.ownerId, detail: { pr: `${input.prRepo}#${input.prNumber}` } } });
      return { share: toRow(share), existing: false, ended };
    });
    try {
      return await attempt();
    } catch (err) {
      // Two at once for the same workstream (a double click, the milestone
      // beside the button): the unique key lets one in; the other reads it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return attempt();
      throw err;
    }
  },

  async addViewer(shareId, userId) {
    const row = await prisma.previewShareViewer.upsert({
      where: { shareId_userId: { shareId, userId } },
      create: { shareId, userId },
      update: { lastOpenedAt: new Date() },
      select: { revokedAt: true },
    });
    return row;
  },

  async revokeViewer(projectId, shareId, userId, actorId) {
    const n = await prisma.previewShareViewer.updateMany({
      where: { shareId, userId, revokedAt: null, share: { projectId, audience: 'link' } },
      data: { revokedAt: new Date() },
    });
    if (n.count === 0) return false;
    await this.recordEvent(shareId, 'viewer-revoked', { actorId, detail: { viewer: userId } });
    return true;
  },

  async setComment(shareId, commentId) {
    await prisma.previewShare.update({ where: { id: shareId }, data: { prCommentId: commentId } });
  },

  async claimComment(shareId, now, staleMs) {
    const row = await prisma.previewShare.findUnique({ where: { id: shareId }, select: { prCommentId: true } });
    if (!row) return false;
    const held = row.prCommentId;
    if (held !== null) {
      const at = held.startsWith('pending:') ? Number(held.slice('pending:'.length)) : NaN;
      if (!Number.isFinite(at) || now - at < staleMs) return false;
    }
    const n = await prisma.previewShare.updateMany({ where: { id: shareId, prCommentId: held }, data: { prCommentId: `pending:${now}` } });
    return n.count === 1;
  },

  async settleComment(shareId, claimedAt, commentId) {
    await prisma.previewShare.updateMany({ where: { id: shareId, prCommentId: `pending:${claimedAt}` }, data: { prCommentId: commentId } });
  },

  async supersededBy(shareId) {
    const ev = await prisma.previewShareEvent.findFirst({ where: { shareId, kind: 'ended', reason: 'superseded' }, orderBy: { at: 'desc' }, select: { detail: true } });
    const by = (ev?.detail as { by?: unknown } | null)?.by;
    const n = typeof by === 'string' ? Number(by.split('#').pop()) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  },

  async shareRow(shareId) {
    const s = await prisma.previewShare.findUnique({ where: { id: shareId }, select: shareSelect });
    return s ? toRow(s) : null;
  },

  async setPrHead(shareId, headOid) {
    await prisma.previewShare.update({ where: { id: shareId }, data: { prHeadOid: headOid } });
  },

  async endOne(shareId, reason) {
    const now = new Date();
    const n = await prisma.previewShare.updateMany({
      where: { id: shareId, endedAt: null },
      data: { endedAt: now, endedReason: reason, activeLinkKey: null },
    });
    if (n.count === 0) return null;
    await this.recordEvent(shareId, 'ended', { reason });
    const s = await prisma.previewShare.findUnique({ where: { id: shareId }, select: shareSelect });
    return s ? toRow(s) : null;
  },

  async liveLinkShares() {
    // Every live one, a page at a time: the sweep checks them all each pass, newest included.
    const out: LiveLinkShare[] = [];
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.previewShare.findMany({
        where: { audience: 'link', endedAt: null, revokedAt: null },
        orderBy: { id: 'asc' },
        take: LIVE_LINK_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { ...shareSelect, owner: { select: { id: true, displayName: true, slackUserId: true, googleEmail: true } }, project: { select: { userId: true, instanceId: true } } },
      });
      for (const { owner, project, ...rest } of rows) out.push({ share: toRow(rest), owner, host: { userId: project.userId, instanceId: project.instanceId } });
      if (rows.length < LIVE_LINK_PAGE) return out;
      cursor = rows[rows.length - 1].id;
    }
  },

  async claimWake({ ownerId, shareId, viewerId, now }) {
    return prisma.$transaction(async (tx) => {
      // Two reviewers at once can't both take the last wake.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`preview-wake:${ownerId}`}))`;
      const recent = await tx.previewShareEvent.findMany({
        where: { kind: 'woke', at: { gt: new Date(now - 24 * 3600 * 1000) }, share: { ownerId } },
        select: { at: true },
      });
      const budget = wakeBudget(recent.map(e => e.at), now);
      if (!budget.ok) return budget;
      const ev = await tx.previewShareEvent.create({ data: { shareId, kind: 'woke', actorId: viewerId, at: new Date(now) }, select: { id: true } });
      return { ok: true as const, wakeId: ev.id };
    });
  },

  async refundWake(wakeId) {
    await prisma.previewShareEvent.delete({ where: { id: wakeId } }).catch(() => {});
  },

  async settings(projectId) {
    const row = await prisma.previewShareSettings.findUnique({ where: { projectId }, select: { originRecipe: true, reviewerAccountHint: true, prLinksEnabled: true, pathFilter: true } });
    return {
      recipe: (row?.originRecipe as unknown as OriginRecipe | null) ?? null, accountHint: row?.reviewerAccountHint ?? null,
      prLinksEnabled: row?.prLinksEnabled ?? false, pathFilter: row?.pathFilter ?? [],
    };
  },

  async saveSettings(projectId, settings) {
    const data = {
      originRecipe: settings.recipe === null ? Prisma.JsonNull : settings.recipe as unknown as Prisma.InputJsonValue,
      reviewerAccountHint: settings.accountHint, prLinksEnabled: settings.prLinksEnabled, pathFilter: settings.pathFilter,
    };
    await prisma.previewShareSettings.upsert({ where: { projectId }, create: { projectId, ...data }, update: data });
    return this.settings(projectId);
  },
};

// ── Live guest sockets ──────────────────────────────────────────────────────

/** A live guest socket: closed when its share is revoked or ends, on this process. */
export interface GuestSocketHandle {
  /** Whose socket it is: revoking one viewer of a link share closes only theirs. */
  viewerId?: string;
  close(message: string): void;
  /** The share changed under it (a renew with another recipe): the pane redials and gets the share as it is now. */
  reconnect(): void;
}

const liveGuests = new Map<string, Set<GuestSocketHandle>>();

/** Register a guest socket under its share; returns the unregister. */
export function registerGuestSocket(shareId: string, handle: GuestSocketHandle): () => void {
  let set = liveGuests.get(shareId);
  if (!set) { set = new Set(); liveGuests.set(shareId, set); }
  set.add(handle);
  return () => {
    const s = liveGuests.get(shareId);
    if (!s) return;
    s.delete(handle);
    if (s.size === 0) liveGuests.delete(shareId);
  };
}

/**
 * Close a share's live guest sockets on this process. A socket on another
 * orchestrator (a deploy's overlap) closes at its next grant re-check, within
 * GUEST_RECHECK_MS (routes/browserWs.ts).
 */
export function closeGuestSockets(shareId: string, message: string, viewerId?: string): number {
  const set = liveGuests.get(shareId);
  if (!set) return 0;
  const handles = [...set].filter(h => viewerId === undefined || h.viewerId === viewerId);
  for (const h of handles) { try { h.close(message); } catch { /* already gone */ } }
  return handles.length;
}

/** Have a share's live guest sockets, on this process, redial: they attach again with the share as it is now. */
export function reconnectGuestSockets(shareId: string): number {
  const set = liveGuests.get(shareId);
  if (!set) return 0;
  const handles = [...set];
  for (const h of handles) { try { h.reconnect(); } catch { /* already gone */ } }
  return handles.length;
}

export function liveGuestCount(shareId: string): number {
  return liveGuests.get(shareId)?.size ?? 0;
}

/** Tests only. */
export function resetLiveGuests(): void {
  liveGuests.clear();
}

/**
 * Tell the owner's box to forget a share's guest profiles (agent
 * browser-profile-forget): each viewer's kept profile and its browser go.
 * Best effort: a box that is off or offline catches up in its profile sweep,
 * once the share's indexed expiry passes.
 */
export async function forgetGuestProfiles(share: ShareRow, host: ProjectHost, viewerIds: string[]): Promise<void> {
  if (!projectAgentCapabilities(host).includes(BROWSER_PANE_PROFILES_CAPABILITY)) return;
  for (const viewerId of viewerIds) {
    await sendForProject(host, 'browser-profile-forget', { profileKey: guestPaneKey(share.id, viewerId) }, 15000)
      .catch(err => console.warn(`[PREVIEW-SHARE] ${share.id}: could not forget ${viewerId}'s guest profile: ${(err as Error).message}`));
  }
}

// ── Seams ───────────────

/** Where a share's guest browser runs: the box, the checkout, the recipe the agent resolves there. */
export interface ShareTarget {
  host: ProjectHost;
  /** The workstream's current name. */
  workstream: string;
  /** Its checkout on the box: the agent's ownership check runs against it. */
  cwd: string;
  recipe: OriginRecipe;
}

/**
 * Seam 1: what a share points at. Every guest path asks this, never the
 * share's project or workstream fields. Today a share is the owner's own
 * workstream on their own box; a preview fleet would answer here too.
 * Null when its workstream is gone.
 */
export function shareTarget(ctx: GuestShareContext): ShareTarget | null {
  if (!ctx.workstream || ctx.workstream.archived) return null;
  const { project } = ctx;
  return {
    host: { userId: project.userId, instanceId: project.instanceId },
    workstream: ctx.workstream.name,
    cwd: projectDirUnder(resolveProjectRoot({ ownerUnixUser: project.ownerUnixUsername, hostHome: project.instance?.hostHome }), project.name, ctx.workstream.name),
    recipe: ctx.share.originRecipe,
  };
}

/** `supersededBy`: the PR number a workstream's link share moved to. */
export interface ShareEndDetail { supersededBy?: number }
type EndedListener = (share: ShareRow, reason: string, detail: ShareEndDetail) => Promise<void> | void;
const endedListeners = new Set<EndedListener>();

/**
 * Seam 5: what else happens when a share ends, whatever ended it (a revoke,
 * the sweep, a workstream removed, a project archived). A link share's PR
 * comment is edited here (services/previewShareLinks.ts); a fleet would
 * tear down the PR's stack.
 */
export function onPreviewShareEnded(listener: EndedListener): () => void {
  endedListeners.add(listener);
  return () => { endedListeners.delete(listener); };
}

/** Run the end hooks for a share that has just ended; each is best effort. */
export async function previewShareEnded(share: ShareRow, reason: string, detail: ShareEndDetail = {}): Promise<void> {
  for (const listener of [...endedListeners]) {
    try { await listener(share, reason, detail); } catch (err) {
      console.warn(`[PREVIEW-SHARE] ${share.id}: an end hook failed: ${(err as Error).message}`);
    }
  }
}

/**
 * End every live preview share of a workstream that is being removed, or of a
 * project being archived: recorded, their guest sockets closed, their guests'
 * profiles forgotten. A removed workstream's share rows then go with it
 * (cascade), which is why this runs first.
 */
export async function endPreviewShares(
  where: { workstreamId?: string; projectId?: string },
  reason: 'workstream-removed' | 'project-archived',
  host: ProjectHost,
  store: PreviewShareStore = prismaPreviewShareStore,
): Promise<number> {
  const ended = await store.endWhere(where, reason);
  const message = reason === 'workstream-removed' ? GUEST_REFUSAL_MESSAGES['workstream-gone'] : GUEST_REFUSAL_MESSAGES['project-archived'];
  for (const share of ended) {
    await teardownShare(store, share, host, message);
    // Not awaited: a hook may call GitHub, and a removal or an archive is not held up by it.
    void previewShareEnded(share, reason);
  }
  if (ended.length) console.log(`[PREVIEW-SHARE] ended ${ended.length} share(s): ${reason}`);
  return ended.length;
}

/**
 * Tell the owner's box a share's new expiry (an extend), so the agent's sweep
 * keeps its guests' kept profiles until then (agent browser-profile-expiry).
 * Best effort: the next attach carries the expiry anyway.
 */
export async function extendGuestProfiles(share: ShareRow, host: ProjectHost, viewerIds: string[]): Promise<void> {
  if (!projectAgentCapabilities(host).includes(BROWSER_PANE_PROFILES_CAPABILITY)) return;
  for (const viewerId of viewerIds) {
    await sendForProject(host, 'browser-profile-expiry', { profileKey: guestPaneKey(share.id, viewerId), expiresAt: share.expiresAt.toISOString() }, 15000)
      .catch(() => {});
  }
}

/**
 * End a share everywhere it is live: close its sockets here, and have the box
 * forget its guests' profiles. Used for a revoke and for every other end.
 */
export async function teardownShare(store: PreviewShareStore, share: ShareRow, host: ProjectHost | null, message: string): Promise<void> {
  closeGuestSockets(share.id, message);
  if (host) await forgetGuestProfiles(share, host, await store.viewerIds(share)).catch(() => {});
}
