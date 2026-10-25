/**
 * Preview shares: an owner shares one workstream's
 * browser pane with a named termag user, who gets a sandboxed browser of
 * their own on the owner's box and nothing else of the project.
 *
 *   POST   /api/projects/:id/preview-shares            owner: share with { email, workstream, recipe?, ttlHours? }
 *   GET    /api/projects/:id/preview-shares            owner: the project's shares, live viewers, blocked origins
 *   PATCH  /api/projects/:id/preview-shares/:shareId   owner: { ttlHours } from now
 *   DELETE /api/projects/:id/preview-shares/:shareId   owner: revoke (scoped by both ids)
 *   GET    /api/preview-shares                         grantee: shared with me, live ones
 *   GET    /api/preview-shares/:shareId                grantee: one share and its state; anyone else 404
 *   POST   /api/preview-shares/:shareId/ask-wake       grantee: ask the owner (Slack) to wake their box
 *
 *   Phase 2, PR link shares (services/previewShareLinks.ts):
 *   POST   /api/projects/:id/preview-shares/link       owner: { workstream, repo, number[, recipe] }, checked on GitHub;
 *                                                      the link, and the PR comment that carries it
 *   DELETE /api/projects/:id/preview-shares/:shareId/viewers/:userId   owner: revoke one viewer of a link share
 *   POST   /api/preview-shares/:shareId/wake           viewer of a link share: wake the box the idle sweep
 *                                                      hibernated, within the owner's budget (4b)
 *   GET    /api/projects/:id/preview-share-settings    owner: the project's preview settings (4c)
 *   PUT    /api/projects/:id/preview-share-settings    owner: { prLinksEnabled, pathFilter, reviewerAccountHint, recipe }
 *
 *   And, with no route: a PR a session reports opening (`pr_created`,
 *   services/workstreamPrs.ts onPrCreated) is shared when its project says
 *   so (installAutoPreviewShares, from index.ts).
 *
 *   GET    /termag/p/:key[?at=<path>]                  the share link (previewLinkRouter); a link share's key is
 *                                                      its token, whose first open makes the viewer's row: sign in, then
 *                                                      the guest page, or the owner's own pane
 *                                                      (`?project=&ws=&browser=open&browserShare=&browserAt=`, which the
 *                                                      workspace reads to open its browser dock there)
 *
 * All behind the browser session (requireAuth): an agent token can't create,
 * list or revoke a share. Every refusal a non-grantee can see is the same
 * 404, so a share id reveals nothing. The browser socket's guest path is in
 * routes/browserWs.ts.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Instance, User } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { rateLimit } from '../middleware/rateLimit';
import { prisma } from '../db';
import { boolVariation, buildFlagContext, numberVariationForContext } from '../services/featureFlags';
import { findUserByEmail } from '../services/userByEmail';
import { repoKey } from '../services/projectTemplates';
import { GithubApiError } from '../services/githubCredential';
import { parsePrRef, PrInputError } from '../services/prReview';
import { getSlackApp } from '../slack/app';
import { slackIdFor } from '../services/briefing/slack';
import { instanceStatus } from '../services/boxPower';
import { onPrCreated, type PrCreatedEvent } from '../services/workstreamPrs';
import {
  activeLinkKeyOf, autoShareDecision, checkLinkSharePr, GUEST_REFUSAL_MESSAGES, parseAccountHint, parsePathFilter, isLinkToken, isShareId, LINK_SHARE_DAYS, linkTokenFor, linkTokenHash, localRedirectPath,
  parseRecipe, resolveGuestAccess, reviewerSignInHint, safeAtPath, shareLiveness, ttlHours,
} from '../services/previewShareRules';
import {
  closeGuestSockets, extendGuestProfiles, forgetGuestProfiles, previewShareEnded, prismaPreviewShareStore, prUrl, reconnectGuestSockets, teardownShare,
  type PreviewShareStore, type ShareRow,
} from '../services/previewShares';
import { announceLinkShare, defaultWakeDeps, ownerGithub, wakeable, wakeShareBox, type ShareGithubFor, type WakeDeps } from '../services/previewShareLinks';
import { RouteResult, sendResult } from './routeResult';

export const PREVIEW_SHARE_FLAG = 'browser-pane-preview-share-enabled';
export const PREVIEW_SHARE_TTL_FLAG = 'browser-pane-preview-share-ttl-hours';
export const PR_LINK_SHARES_FLAG = 'browser-pane-pr-link-shares-enabled';
export const GUEST_WAKE_FLAG = 'browser-pane-guest-wake-enabled';
const WORKSTREAM_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const ASK_WAKE_EVERY_MS = 10 * 60 * 1000;

export interface OwnedProject {
  id: string;
  name: string;
  userId: string;
  archived: boolean;
  instanceId: string | null;
  instance: Instance | null;
  /** The repository the project was made from (set by the server), or null. */
  repoUrl?: string | null;
}

export interface PreviewShareRouteDeps {
  store: PreviewShareStore;
  /** The project, only when `userId` owns it. */
  findOwnedProject(userId: string, projectId: string): Promise<OwnedProject | null>;
  /** A workstream the project has (not archived): its row id, or null for an implicit main. Undefined when it has no such workstream. */
  findWorkstream(projectId: string, name: string): Promise<{ id: string | null } | undefined>;
  findUserByEmail(email: string): Promise<User | null>;
  findUser(id: string): Promise<User | null>;
  /** Whether userId has a full ProjectShare on the project (the link sends them to their own pane). */
  isCollaborator(projectId: string, userId: string): Promise<boolean>;
  sharingOn(owner: User, box: Instance | null): Promise<boolean>;
  ttlDefault(owner: User, box: Instance | null): Promise<number>;
  boxStatus(instanceId: string | null): Promise<string | null>;
  /** Slack the owner that a reviewer asks them to wake the box; whether it went. */
  notifyWake(owner: User, viewer: User, share: { projectName: string; workstream: string }): Promise<boolean>;
  now(): number;
  // ── Phase 2: link shares ──
  prLinksOn(owner: User, box: Instance | null): Promise<boolean>;
  /** A workstream's row id and branch (set by the server when it was made), as findWorkstream finds it. */
  findBranch(projectId: string, name: string): Promise<{ id: string | null; branch: string | null } | undefined>;
  githubFor: ShareGithubFor;
  /** The site's own address, base path included (FRONTEND_URL + BASE_PATH): a link share's link is absolute, for its comment. */
  siteBase(): string;
  /** The server's secret a link share's token is made with (SESSION_SECRET). */
  linkSecret(): string;
  /** Seam 4's deps: waking a link share's box (4b). */
  wake: WakeDeps;
}

export const defaultPreviewShareRouteDeps: PreviewShareRouteDeps = {
  store: prismaPreviewShareStore,
  findOwnedProject: async (userId, projectId) => {
    const p = await prisma.project.findFirst({ where: { id: projectId, userId }, include: { instance: true } });
    return p ? { id: p.id, name: p.name, userId: p.userId, archived: p.archived, instanceId: p.instanceId, instance: p.instance, repoUrl: p.repoUrl } : null;
  },
  findWorkstream: async (projectId, name) => {
    const row = await prisma.workstream.findUnique({ where: { projectId_name: { projectId, name } }, select: { id: true, archived: true } });
    // Main is the project's own checkout, row or not; an archived row is gone.
    if (!row) return name === 'main' ? { id: null } : undefined;
    return row.archived ? undefined : { id: row.id };
  },
  findUserByEmail,
  findUser: (id) => prisma.user.findUnique({ where: { id } }),
  isCollaborator: async (projectId, userId) => !!(await prisma.projectShare.findUnique({ where: { projectId_userId: { projectId, userId } } })),
  sharingOn: (owner, box) => boolVariation(PREVIEW_SHARE_FLAG, owner, false, box),
  ttlDefault: (owner, box) => numberVariationForContext(PREVIEW_SHARE_TTL_FLAG, buildFlagContext(owner, box), 24),
  boxStatus: instanceStatus,
  notifyWake: async (owner, viewer, share) => {
    const client = getSlackApp()?.client;
    if (!client) return false;
    const channel = await slackIdFor(client, owner);
    if (!channel) return false;
    await client.chat.postMessage({
      channel,
      text: `${viewer.displayName} would like to review your preview of ${share.projectName} (${share.workstream}), but your box is asleep. Start it from termag's Boxes list and they can go ahead.`,
    });
    return true;
  },
  now: () => Date.now(),
  prLinksOn: (owner, box) => boolVariation(PR_LINK_SHARES_FLAG, owner, false, box),
  findBranch: async (projectId, name) => {
    const row = await prisma.workstream.findUnique({ where: { projectId_name: { projectId, name } }, select: { id: true, archived: true, branch: true } });
    if (!row) return name === 'main' ? { id: null, branch: null } : undefined;
    return row.archived ? undefined : { id: row.id, branch: row.branch };
  },
  githubFor: ownerGithub,
  siteBase: () => `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}${process.env.BASE_PATH ?? ''}`,
  linkSecret: () => process.env.SESSION_SECRET ?? 'dev-secret',
  wake: { ...defaultWakeDeps, wakeOn: (owner, box) => boolVariation(GUEST_WAKE_FLAG, owner, false, box) },
};

/** A link share's link: its token, never its id, opens it (and makes the opener's viewer row). */
export function linkSharePath(secret: string, shareId: string): string {
  return `/p/${linkTokenFor(secret, shareId)}`;
}

/** A share as its grantee sees it. */
function granteeView(share: ShareRow, ctx: { ownerName: string; projectName: string; workstream: string | null }, state: { ok: boolean; reason?: string; endedReason?: string | null }) {
  return {
    id: share.id,
    owner: { name: ctx.ownerName },
    project: { name: ctx.projectName },
    workstream: ctx.workstream ?? 'main',
    expiresAt: share.expiresAt.toISOString(),
    pr: share.prRepo && share.prNumber ? { repo: share.prRepo, number: share.prNumber, url: prUrl(share.prRepo, share.prNumber), headOid: share.prHeadOid } : null,
    state: state.ok ? 'active' : state.reason,
    ...(state.ok ? {} : { message: GUEST_REFUSAL_MESSAGES[state.reason as keyof typeof GUEST_REFUSAL_MESSAGES] ?? GUEST_REFUSAL_MESSAGES['not-shared'] }),
  };
}

const NOT_SHARED: RouteResult = { status: 404, body: { error: GUEST_REFUSAL_MESSAGES['not-shared'], code: 'not-shared' } };

export async function createShareFor(deps: PreviewShareRouteDeps, user: Express.User, projectId: string, body: any): Promise<RouteResult> {
  const project = await deps.findOwnedProject(user.id, projectId);
  if (!project || project.archived) return { status: 404, body: { error: 'Project not found' } };
  const owner = await deps.findUser(user.id);
  if (!owner) return { status: 404, body: { error: 'Project not found' } };
  if (!(await deps.sharingOn(owner, project.instance))) {
    return { status: 403, body: { error: 'Preview sharing is off for this box.', code: 'preview-share-disabled' } };
  }
  const workstream = typeof body?.workstream === 'string' && body.workstream ? body.workstream : 'main';
  if (!WORKSTREAM_NAME.test(workstream)) return { status: 400, body: { error: 'workstream is not a workstream name' } };
  const ws = await deps.findWorkstream(project.id, workstream);
  if (!ws) return { status: 404, body: { error: 'Workstream not found' } };
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) return { status: 400, body: { error: 'email is required' } };
  const grantee = await deps.findUserByEmail(email);
  if (!grantee) return { status: 404, body: { error: 'No termag user has that email. They need to sign in to termag once first.', code: 'no-such-user' } };
  if (grantee.id === owner.id) return { status: 400, body: { error: 'That is you: your own browser pane already shows this.' } };
  const recipe = parseRecipe(body?.recipe);
  if ('error' in recipe) return { status: 400, body: { error: recipe.error } };
  const hours = ttlHours(body?.ttlHours, await deps.ttlDefault(owner, project.instance));
  const expiresAt = new Date(deps.now() + hours * 3600 * 1000);
  // Shared with them already: that share is renewed, same link, rather than a
  // second one listed beside it. The recipe is the one asked for now; the
  // end moves later, never sooner. (An implicit main's share may still carry
  // no workstream row, so main matches either.)
  const existing = await deps.store.liveFor({
    projectId: project.id, granteeId: grantee.id, now: new Date(deps.now()),
    workstreamIds: workstream === 'main' && ws.id ? [ws.id, null] : [ws.id],
  });
  if (existing) {
    const was = existing.expiresAt.getTime();
    const recipeChanged = JSON.stringify(existing.originRecipe) !== JSON.stringify(recipe.recipe);
    const later = was > expiresAt.getTime() ? new Date(was) : expiresAt;
    const renewed = await deps.store.renew(project.id, existing.id, { recipe: recipe.recipe, expiresAt: later, actorId: owner.id });
    if (renewed) {
      if (later.getTime() !== was) {
        await extendGuestProfiles(renewed, { userId: project.userId, instanceId: project.instanceId }, await deps.store.viewerIds(renewed)).catch(() => {});
      }
      // A reviewer looking now still has the old recipe's origins: their pane
      // redials and attaches with the new one. (Sockets on another process
      // see the change at their next re-check.)
      if (recipeChanged) reconnectGuestSockets(renewed.id);
      console.log(`[PREVIEW-SHARE] ${owner.id} renewed ${renewed.id} for ${grantee.id} (${project.id}/${workstream})`);
      return { status: 200, body: { id: renewed.id, expiresAt: renewed.expiresAt.toISOString(), link: `/p/${renewed.id}`, ttlHours: hours, renewed: true } };
    }
  }
  const share = await deps.store.create({
    projectId: project.id, workstreamId: ws.id, ownerId: owner.id, granteeId: grantee.id, recipe: recipe.recipe, expiresAt,
  });
  await deps.store.recordEvent(share.id, 'created', { actorId: owner.id, detail: { grantee: grantee.id, ttlHours: hours } });
  console.log(`[PREVIEW-SHARE] ${owner.id} shared ${project.id}/${workstream} with ${grantee.id} for ${hours} h (${share.id})`);
  return { status: 201, body: { id: share.id, expiresAt: share.expiresAt.toISOString(), link: `/p/${share.id}`, ttlHours: hours } };
}

export async function revokeShareFor(deps: PreviewShareRouteDeps, user: Express.User, projectId: string, shareId: string): Promise<RouteResult> {
  if (!isShareId(shareId)) return { status: 404, body: { error: 'Share not found' } };
  const project = await deps.findOwnedProject(user.id, projectId);
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  const revoked = await deps.store.revoke(project.id, shareId, user.id);
  if (!revoked) return { status: 404, body: { error: 'Share not found' } };
  await teardownShare(deps.store, revoked, { userId: project.userId, instanceId: project.instanceId }, GUEST_REFUSAL_MESSAGES.revoked);
  // Not awaited: the hooks may call GitHub (the comment), and log their own failures.
  void previewShareEnded(revoked, 'revoked');
  console.log(`[PREVIEW-SHARE] ${user.id} revoked ${shareId}`);
  return { status: 200, body: { ok: true } };
}

export async function extendShareFor(deps: PreviewShareRouteDeps, user: Express.User, projectId: string, shareId: string, body: any): Promise<RouteResult> {
  if (!isShareId(shareId)) return { status: 404, body: { error: 'Share not found' } };
  const project = await deps.findOwnedProject(user.id, projectId);
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  const owner = await deps.findUser(user.id);
  if (!owner) return { status: 404, body: { error: 'Project not found' } };
  const hours = ttlHours(body?.ttlHours, await deps.ttlDefault(owner, project.instance));
  const expiresAt = new Date(deps.now() + hours * 3600 * 1000);
  // An extend never ends a share sooner: a lifetime shorter than what is
  // left is refused, not applied.
  const current = await deps.store.guestContext(shareId);
  if (current && current.share.projectId === project.id && current.share.audience === 'link') {
    return { status: 409, body: { error: 'A PR preview lasts until its pull request merges or closes.', code: 'link-share' } };
  }
  if (current && current.share.projectId === project.id && expiresAt.getTime() <= current.share.expiresAt.getTime()) {
    return { status: 409, body: { error: `It already lasts longer than ${hours} hours from now.`, code: 'would-shorten' } };
  }
  const extended = await deps.store.extend(project.id, shareId, expiresAt, user.id);
  if (!extended) return { status: 404, body: { error: 'Share not found' } };
  await extendGuestProfiles(extended, { userId: project.userId, instanceId: project.instanceId }, await deps.store.viewerIds(extended)).catch(() => {});
  return { status: 200, body: { id: extended.id, expiresAt: extended.expiresAt.toISOString() } };
}

/**
 * One share as the person it is for sees it; 404 to anyone else. Its owner
 * sees it as its grantee would ("Preview as guest").
 */
export async function shareForGrantee(deps: PreviewShareRouteDeps, user: Express.User, shareId: string): Promise<RouteResult> {
  if (!isShareId(shareId)) return NOT_SHARED;
  const ctx = await deps.store.guestContext(shareId, user.id);
  if (!ctx) return NOT_SHARED;
  // Its owner sees it as its reviewer would ("Preview as guest"), whatever
  // its audience; anyone else only as its grantee.
  const facts = { share: ctx.share, workstream: ctx.workstream, projectArchived: ctx.project.archived, now: deps.now() };
  const access = ctx.share.ownerId === user.id ? shareLiveness(facts) : resolveGuestAccess({ ...facts, viewerId: user.id, viewerRow: ctx.viewerRow });
  if (!access.ok && !access.toGrantee) return NOT_SHARED;
  const view = granteeView(ctx.share, { ownerName: ctx.owner.displayName, projectName: ctx.project.name, workstream: ctx.workstream?.name ?? null },
    access.ok ? { ok: true } : { ok: false, reason: access.reason, endedReason: access.endedReason });
  return {
    status: 200,
    body: {
      ...view,
      boxStatus: access.ok ? await deps.boxStatus(ctx.project.instanceId) : null,
      // The share's own owner looking (Preview as guest): their page offers no
      // "ask the owner to wake it", since the box is theirs to start.
      asOwner: ctx.share.ownerId === user.id,
      signInHint: access.ok ? reviewerSignInHint(ctx.share.originRecipe, ctx.accountHint) : null,
      // A reviewer may wake this box (4b): the page offers it instead of asking the owner. The budget is checked on the wake itself.
      canWake: access.ok && ctx.share.ownerId !== user.id && wakeable(ctx) && await deps.wake.wakeOn(ctx.owner, ctx.project.instance).catch(() => false),
    },
  };
}

/**
 * A link share's viewer wakes its box: a POST from the guest page, never a side effect of the socket. Only a
 * box the idle sweep hibernated, as its owner would start it, within the
 * owner's budget; the owner is told on Slack.
 */
export async function wakeFor(deps: PreviewShareRouteDeps, user: Express.User, shareId: string): Promise<RouteResult> {
  if (!isShareId(shareId)) return NOT_SHARED;
  const ctx = await deps.store.guestContext(shareId, user.id);
  if (!ctx) return NOT_SHARED;
  if (ctx.share.ownerId === user.id) return { status: 409, body: { error: 'This is your own box: start it from the Boxes list.', code: 'own-box' } };
  const access = resolveGuestAccess({ share: ctx.share, viewerId: user.id, viewerRow: ctx.viewerRow, workstream: ctx.workstream, projectArchived: ctx.project.archived, now: deps.now() });
  if (!access.ok) return access.toGrantee ? { status: 409, body: { error: GUEST_REFUSAL_MESSAGES[access.reason], code: access.reason } } : NOT_SHARED;
  const viewer = await deps.findUser(user.id);
  if (!viewer) return NOT_SHARED;
  const woke = await wakeShareBox(deps.wake, ctx, viewer);
  if (woke.ok) return { status: 202, body: { ok: true, status: woke.status } };
  if (woke.reason === 'too-soon' || woke.reason === 'daily') {
    return { status: 429, body: { error: woke.message, code: woke.reason, ...('retryAt' in woke && woke.retryAt ? { retryAt: new Date(woke.retryAt).toISOString() } : {}) } };
  }
  return { status: woke.reason === 'failed' ? 502 : 409, body: { error: woke.message, code: woke.reason } };
}

const lastWakeAsk = new Map<string, number>();

export async function askWakeFor(deps: PreviewShareRouteDeps, user: Express.User, shareId: string): Promise<RouteResult> {
  if (!isShareId(shareId)) return NOT_SHARED;
  const ctx = await deps.store.guestContext(shareId, user.id);
  if (!ctx) return NOT_SHARED;
  // Its owner previewing it as a guest has nobody to ask: the box is theirs.
  if (ctx.share.ownerId === user.id) return { status: 409, body: { error: 'This is your own box: start it from the Boxes list.', code: 'own-box' } };
  const access = resolveGuestAccess({ share: ctx.share, viewerId: user.id, viewerRow: ctx.viewerRow, workstream: ctx.workstream, projectArchived: ctx.project.archived, now: deps.now() });
  if (!access.ok) return access.toGrantee ? { status: 409, body: { error: GUEST_REFUSAL_MESSAGES[access.reason], code: access.reason } } : NOT_SHARED;
  const key = `${shareId}:${user.id}`;
  const last = lastWakeAsk.get(key) ?? 0;
  if (deps.now() - last < ASK_WAKE_EVERY_MS) return { status: 429, body: { error: 'The owner was asked a few minutes ago.', code: 'asked-recently' } };
  const viewer = await deps.findUser(user.id);
  if (!viewer) return NOT_SHARED;
  lastWakeAsk.set(key, deps.now());
  const sent = await deps.notifyWake(ctx.owner, viewer, { projectName: ctx.project.name, workstream: ctx.workstream?.name ?? 'main' }).catch(() => false);
  await deps.store.recordEvent(shareId, 'asked-wake', { actorId: user.id, detail: { sent } });
  return { status: 200, body: { ok: true, sent } };
}

/**
 * A PR's link share: the
 * owner asks for one from the PR overlay. The PR is read on GitHub with their
 * own token and must be theirs, open, not a draft, in this project's
 * private or internal repository, on this workstream's branch. The
 * workstream's live link share for the same PR is returned as it is; one for
 * another PR ends (superseded). A new one is announced on the PR by a
 * comment that carries its link.
 */
export async function createLinkShareFor(deps: PreviewShareRouteDeps, user: Express.User, projectId: string, body: any, opts: { auto?: boolean } = {}): Promise<RouteResult> {
  const project = await deps.findOwnedProject(user.id, projectId);
  if (!project || project.archived) return { status: 404, body: { error: 'Project not found' } };
  const owner = await deps.findUser(user.id);
  if (!owner) return { status: 404, body: { error: 'Project not found' } };
  if (!(await deps.sharingOn(owner, project.instance)) || !(await deps.prLinksOn(owner, project.instance))) {
    return { status: 403, body: { error: 'PR previews are off for this box.', code: 'pr-links-disabled' } };
  }
  const workstream = typeof body?.workstream === 'string' && body.workstream ? body.workstream : 'main';
  if (!WORKSTREAM_NAME.test(workstream)) return { status: 400, body: { error: 'workstream is not a workstream name' } };
  const ws = await deps.findBranch(project.id, workstream);
  if (!ws) return { status: 404, body: { error: 'Workstream not found' } };
  const [prOwner, prName] = typeof body?.repo === 'string' ? body.repo.split('/') : [];
  let ref;
  try { ref = parsePrRef(prOwner, prName, typeof body?.number === 'number' ? String(body.number) : body?.number); } catch (err) {
    if (err instanceof PrInputError) return { status: 400, body: { error: err.message } };
    throw err;
  }
  const settings = await deps.store.settings(project.id);
  // An automatic share (4c) only where the project asked for them; the owner's click needs no opt-in.
  if (opts.auto && !settings.prLinksEnabled) return { status: 200, body: { skipped: 'off' } };
  const recipeInput = parseRecipe(body?.recipe ?? settings.recipe ?? undefined);
  if ('error' in recipeInput) return { status: 400, body: { error: recipeInput.error } };
  let github;
  try { github = await deps.githubFor(owner.id); } catch (err) {
    console.warn(`[PREVIEW-SHARE] ${owner.id}: GitHub credential could not be read: ${(err as Error).message}`);
    return { status: 503, body: { error: 'Could not read your stored GitHub token right now. Try again in a moment.', code: 'credential-unavailable' } };
  }
  if (!github) return { status: 409, body: { error: 'Connect GitHub in Settings first: termag checks the pull request with your token.', code: 'github-not-connected' } };
  let facts;
  try { facts = await github.readPr(ref); } catch (err) {
    const status = err instanceof GithubApiError ? err.status : 0;
    if (status === 401) return { status: 502, body: { error: 'GitHub rejected your stored token. Reconnect GitHub in Settings.', code: 'github-reconnect' } };
    if (status === 404) return { status: 404, body: { error: "GitHub has no such pull request, or your token can't see it.", code: 'no-such-pr' } };
    console.warn(`[PREVIEW-SHARE] ${owner.id}: reading ${ref.owner}/${ref.name}#${ref.number} failed: ${(err as Error).message}`);
    return { status: 502, body: { error: 'Could not read the pull request from GitHub. Try again in a moment.', code: 'github-failed' } };
  }
  const verdict = checkLinkSharePr(facts, { repo: project.repoUrl ? repoKey(project.repoUrl) : null, branch: ws.branch });
  if (!verdict.ok) return { status: 409, body: { error: verdict.message, code: verdict.reason } };
  if (opts.auto) {
    // Noise control: the `no-preview` label, and the project's path filter.
    let scope;
    try { scope = await github.readScope(ref); } catch (err) {
      console.warn(`[PREVIEW-SHARE] ${owner.id}: reading ${ref.owner}/${ref.name}#${ref.number}'s labels and files failed: ${(err as Error).message}`);
      return { status: 502, body: { error: 'Could not read the pull request from GitHub.', code: 'github-failed' } };
    }
    const decision = autoShareDecision({ enabled: settings.prLinksEnabled, filter: settings.pathFilter, ...scope });
    if (!decision.share) return { status: 200, body: { skipped: decision.why } };
  }

  const now = new Date(deps.now());
  const prRepo = facts.repo;
  const opened = await deps.store.openLinkShare({
    projectId: project.id, workstreamId: ws.id, ownerId: owner.id, recipe: recipeInput.recipe,
    expiresAt: new Date(now.getTime() + LINK_SHARE_DAYS * 24 * 3600 * 1000),
    prRepo, prNumber: ref.number, prHeadOid: facts.headOid, linkKey: activeLinkKeyOf(project.id, ws.id), now,
    hashFor: (shareId) => linkTokenHash(linkTokenFor(deps.linkSecret(), shareId)),
  });
  const host = { userId: project.userId, instanceId: project.instanceId };
  if (opened.ended) {
    await teardownShare(deps.store, opened.ended, host, GUEST_REFUSAL_MESSAGES.ended);
    void previewShareEnded(opened.ended, opened.ended.endedReason ?? 'superseded', { supersededBy: ref.number });
  }
  const share = opened.share;
  const path = linkSharePath(deps.linkSecret(), share.id);
  const link = `${deps.siteBase()}${path}`;
  const comment = await announceLinkShare(deps.store, github, share, {
    link, signInHint: reviewerSignInHint(share.originRecipe, settings.accountHint), ownerName: owner.displayName,
  });
  if (!opened.existing) console.log(`[PREVIEW-SHARE] ${owner.id} shared ${prRepo}#${ref.number} (${project.id}/${workstream}) by link (${share.id})`);
  return {
    status: opened.existing ? 200 : 201,
    body: {
      id: share.id, link, linkPath: path, expiresAt: share.expiresAt.toISOString(), existing: opened.existing,
      pr: { repo: prRepo, number: ref.number, url: prUrl(prRepo, ref.number) },
      comment,
    },
  };
}

/** A project's preview settings, as its owner sees and edits them (4c). */
export async function settingsFor(deps: PreviewShareRouteDeps, user: Express.User, projectId: string): Promise<RouteResult> {
  const project = await deps.findOwnedProject(user.id, projectId);
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  return { status: 200, body: settingsView(await deps.store.settings(project.id)) };
}

export async function saveSettingsFor(deps: PreviewShareRouteDeps, user: Express.User, projectId: string, body: any): Promise<RouteResult> {
  const project = await deps.findOwnedProject(user.id, projectId);
  if (!project || project.archived) return { status: 404, body: { error: 'Project not found' } };
  const owner = await deps.findUser(user.id);
  if (!owner) return { status: 404, body: { error: 'Project not found' } };
  if (!(await deps.sharingOn(owner, project.instance)) || !(await deps.prLinksOn(owner, project.instance))) {
    return { status: 403, body: { error: 'PR previews are off for this box.', code: 'pr-links-disabled' } };
  }
  const current = await deps.store.settings(project.id);
  const enabled = body?.prLinksEnabled === undefined ? current.prLinksEnabled : body.prLinksEnabled;
  if (typeof enabled !== 'boolean') return { status: 400, body: { error: 'prLinksEnabled must be true or false' } };
  const filter = body?.pathFilter === undefined ? { filter: current.pathFilter } : parsePathFilter(body.pathFilter);
  if ('error' in filter) return { status: 400, body: { error: filter.error } };
  const hint = body?.reviewerAccountHint === undefined ? { hint: current.accountHint } : parseAccountHint(body.reviewerAccountHint);
  if ('error' in hint) return { status: 400, body: { error: hint.error } };
  let recipe = current.recipe;
  if (body?.recipe !== undefined) {
    if (body.recipe === null) recipe = null;
    else {
      const parsed = parseRecipe(body.recipe);
      if ('error' in parsed) return { status: 400, body: { error: parsed.error } };
      recipe = parsed.recipe;
    }
  }
  const saved = await deps.store.saveSettings(project.id, { prLinksEnabled: enabled, pathFilter: filter.filter, accountHint: hint.hint, recipe });
  console.log(`[PREVIEW-SHARE] ${owner.id} set ${project.id}'s preview settings: automatic ${saved.prLinksEnabled ? 'on' : 'off'}, ${saved.pathFilter.length} path prefix(es)`);
  return { status: 200, body: settingsView(saved) };
}

function settingsView(s: { prLinksEnabled: boolean; pathFilter: string[]; accountHint: string | null; recipe: unknown }) {
  return { prLinksEnabled: s.prLinksEnabled, pathFilter: s.pathFilter, reviewerAccountHint: s.accountHint, recipe: s.recipe };
}

/**
 * Share each PR a session reports opening (`pr_created`), when its project
 * says so (4c). The milestone is a
 * hint, never proof: the same checks run as for the owner's own click, as
 * the owner, on GitHub, and then the label and the path filter. Installed
 * once per process (index.ts); a refusal is logged, never shown.
 */
export function installAutoPreviewShares(deps: PreviewShareRouteDeps = defaultPreviewShareRouteDeps): () => void {
  return onPrCreated((ev: PrCreatedEvent) => {
    const at = `${ev.pr.repo}#${ev.pr.number}`;
    createLinkShareFor(deps, { id: ev.userId } as Express.User, ev.projectId, { workstream: ev.workstream, repo: ev.pr.repo, number: ev.pr.number }, { auto: true })
      .then(r => {
        const body = r.body as { skipped?: string; code?: string; id?: string };
        if (r.status === 201) console.log(`[PREVIEW-SHARE] ${ev.userId}'s ${at} shared automatically (${body.id})`);
        else if (body?.skipped && body.skipped !== 'off') console.log(`[PREVIEW-SHARE] ${ev.userId}'s ${at} not shared automatically: ${body.skipped}`);
        else if (r.status >= 400) console.log(`[PREVIEW-SHARE] ${ev.userId}'s ${at} not shared automatically: ${body?.code ?? r.status}`);
      })
      .catch(err => console.warn(`[PREVIEW-SHARE] automatic share of ${at} failed: ${(err as Error).message}`));
  });
}

/** Revoke one viewer of a link share: their socket closes and their browser profile goes; the share stays. */
export async function revokeViewerFor(deps: PreviewShareRouteDeps, user: Express.User, projectId: string, shareId: string, viewerId: string): Promise<RouteResult> {
  if (!isShareId(shareId) || typeof viewerId !== 'string' || !/^[a-z0-9]{10,64}$/.test(viewerId)) return { status: 404, body: { error: 'Viewer not found' } };
  const project = await deps.findOwnedProject(user.id, projectId);
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  if (!(await deps.store.revokeViewer(project.id, shareId, viewerId, user.id))) return { status: 404, body: { error: 'Viewer not found' } };
  closeGuestSockets(shareId, GUEST_REFUSAL_MESSAGES['viewer-revoked'], viewerId);
  const ctx = await deps.store.guestContext(shareId);
  if (ctx) await forgetGuestProfiles(ctx.share, { userId: project.userId, instanceId: project.instanceId }, [viewerId]).catch(() => {});
  console.log(`[PREVIEW-SHARE] ${user.id} revoked viewer ${viewerId} of ${shareId}`);
  return { status: 200, body: { ok: true } };
}

export function previewSharesRouter(deps: PreviewShareRouteDeps = defaultPreviewShareRouteDeps): Router {
  const router = Router();
  const handle = (fn: (req: Request) => Promise<RouteResult>): RequestHandler => asyncHandler(async (req: Request, res: Response) => { sendResult(res, await fn(req)); });
  // Per user, on these routes only: this router is mounted at /api, so a
  // router-wide use() would throttle every API call that passes through it.
  const limit = rateLimit({ capacity: 30, perMinute: 60 });

  router.post('/projects/:id/preview-shares', requireAuth, limit, handle(req => createShareFor(deps, req.user!, req.params.id, req.body)));
  router.post('/projects/:id/preview-shares/link', requireAuth, limit, handle(req => createLinkShareFor(deps, req.user!, req.params.id, req.body)));
  router.get('/projects/:id/preview-shares', requireAuth, limit, handle(async req => {
    const project = await deps.findOwnedProject(req.user!.id, req.params.id);
    if (!project) return { status: 404, body: { error: 'Project not found' } };
    const shares = await deps.store.listForProject(project.id);
    // A link share's link is its token; only its owner is shown it again.
    return { status: 200, body: { shares: shares.map(v => (v.audience === 'link' ? { ...v, linkPath: linkSharePath(deps.linkSecret(), v.id) } : v)) } };
  }));
  router.get('/projects/:id/preview-share-settings', requireAuth, limit, handle(req => settingsFor(deps, req.user!, req.params.id)));
  router.put('/projects/:id/preview-share-settings', requireAuth, limit, handle(req => saveSettingsFor(deps, req.user!, req.params.id, req.body)));
  router.delete('/projects/:id/preview-shares/:shareId/viewers/:userId', requireAuth, limit, handle(req => revokeViewerFor(deps, req.user!, req.params.id, req.params.shareId, req.params.userId)));
  router.patch('/projects/:id/preview-shares/:shareId', requireAuth, limit, handle(req => extendShareFor(deps, req.user!, req.params.id, req.params.shareId, req.body)));
  router.delete('/projects/:id/preview-shares/:shareId', requireAuth, limit, handle(req => revokeShareFor(deps, req.user!, req.params.id, req.params.shareId)));
  router.get('/preview-shares', requireAuth, limit, handle(async req => ({ status: 200, body: { shares: await deps.store.sharedWith(req.user!.id) } })));
  router.get('/preview-shares/:shareId', requireAuth, limit, handle(req => shareForGrantee(deps, req.user!, req.params.shareId)));
  router.post('/preview-shares/:shareId/ask-wake', requireAuth, limit, handle(req => askWakeFor(deps, req.user!, req.params.shareId)));
  router.post('/preview-shares/:shareId/wake', requireAuth, limit, handle(req => wakeFor(deps, req.user!, req.params.shareId)));
  return router;
}

export interface PreviewLinkDeps {
  store: Pick<PreviewShareStore, 'guestContext' | 'linkShareId' | 'addViewer'>;
  isCollaborator: PreviewShareRouteDeps['isCollaborator'];
  userId(req: Request): string | null;
  /** Remembers req.originalUrl and answers where to sign in; unset in okta mode, where the ALB signs people in first. */
  signIn?: (req: Request) => Promise<string | null>;
}

/**
 * The share link, `/termag/p/<key>[?at=<path>]`, mounted by index.ts behind
 * the cookie stack, ahead of the SPA. Someone signed out signs in and comes
 * back (auth/postLoginReturn.ts). Signed in, the owner or a full collaborator
 * goes to their own workspace pane at that page, and anyone else to the guest
 * page, `/termag/preview/<key>`, which asks `GET /api/preview-shares/:id` what
 * they may see (the same 404 for anyone the share isn't for).
 */
export function previewLinkRouter(basePath: string, deps: PreviewLinkDeps): Router {
  const router = Router();
  // Mounted at /p alone: per signed-in user, else per address.
  router.use(rateLimit({ capacity: 30, perMinute: 60, keyOf: req => deps.userId(req) ?? req.ip ?? 'anon' }));
  router.get('/:key', asyncHandler(async (req: Request, res: Response) => {
    const key = req.params.key;
    const notShared = () => { res.status(404).type('text/plain').send(GUEST_REFUSAL_MESSAGES['not-shared']); };
    if (!isShareId(key)) { notShared(); return; }
    // Only ever a path on this site: the targets below are built from the
    // base path, encoded ids and a checked key, and checked again here.
    const go = (target: string | null) => {
      const to = localRedirectPath(basePath, target);
      if (to) res.redirect(302, to); else notShared();
    };
    const userId = deps.userId(req);
    if (!userId) {
      const to = deps.signIn ? await deps.signIn(req) : null;
      if (to) { go(to); return; }
      res.status(401).type('text/plain').send('Sign in to termag to open this preview.');
      return;
    }
    const at = safeAtPath(req.query.at);
    const atQuery = at ? `?at=${encodeURIComponent(at)}` : '';
    // A link share's key is its token (phase 2): only the token finds it,
    // and opening it is what lets this viewer in. Its id alone never does.
    const byToken = isLinkToken(key);
    const shareId = byToken ? await deps.store.linkShareId(linkTokenHash(key)) : key;
    if (!shareId) { notShared(); return; }
    const ctx = await deps.store.guestContext(shareId);
    if (ctx && (ctx.project.userId === userId || await deps.isCollaborator(ctx.project.id, userId))) {
      // Their own pane is the right tool, and it keeps their own signed-in profile.
      const ws = ctx.workstream?.name ?? 'main';
      // The share rides along: their pane opens its app, not whatever app the dock showed last.
      const browser = `&browserShare=${encodeURIComponent(shareId)}${at ? `&browserAt=${encodeURIComponent(at)}` : ''}`;
      go(`${basePath}/?project=${encodeURIComponent(ctx.project.id)}&ws=${encodeURIComponent(ws)}&browser=open${browser}`);
      return;
    }
    if (byToken && ctx) await deps.store.addViewer(shareId, userId);
    go(`${basePath}/preview/${shareId}${atQuery}`);
  }));
  return router;
}
