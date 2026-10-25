/**
 * Preview link shares: a
 * PR's "Preview this PR" link, its comment on GitHub, and the leader sweep
 * that ends it with the PR. The database half stays in previewShares.ts; this
 * is GitHub's half.
 *
 *   - ShareGithub (seam 2): reading a PR, posting and editing its comment.
 *     Today with the share owner's stored token (ownerGithub).
 *   - announceLinkShare: the comment that carries a new share's link.
 *   - the end hook (seam 5): a link share's comment loses its link when the
 *     share ends, whatever ended it.
 *   - runLinkShareSweep: every live link share's PR, read every 5 minutes:
 *     merged, closed, past its 14 days, or no longer readable ends it.
 *   - wakeShareBox (seam 4, PR 4b): a reviewer wakes the box an idle sweep
 *     hibernated, within the owner's budget.
 */
import type { Instance, User } from '@prisma/client';
import { prisma } from '../db';
import { readGithubAccess } from './credentialStore';
import { GithubApiError } from './githubCredential';
import { editComment, fetchPrFacts, fetchPrScope, parsePrRef, postComment, type PrFacts, type PrRef, type PrScope } from './prReview';
import { endedCommentBody, GUEST_REFUSAL_MESSAGES, guestWakeRefusal, previewCommentBody, WAKE_MESSAGES, type WakeRefusal } from './previewShareRules';
import { PowerRequestConflict, requestPower } from './boxPower';
import { powerRequestError } from './boxPowerPolicy';
import { isAutoHibernateNote } from './boxLifecyclePolicy';
import { isBoxProvisioningConfigured } from './boxProvisioner';
import { notifyWorkspaceChange } from './workspaceEvents';
import {
  onPreviewShareEnded, previewShareEnded, prismaPreviewShareStore, teardownShare, type GuestShareContext, type PreviewShareStore, type ShareEndDetail, type ShareRow,
} from './previewShares';
import { getSlackApp } from '../slack/app';
import { slackIdFor } from './briefing/slack';

export const LINK_SHARE_SWEEP_MS = 5 * 60 * 1000;
const GITHUB_TIMEOUT_MS = 20_000;

/** Seam 2: what a link share asks of GitHub. */
export interface ShareGithub {
  readPr(ref: PrRef): Promise<PrFacts>;
  /** Labels and changed paths: what an automatic share decides by (4c). */
  readScope(ref: PrRef): Promise<PrScope>;
  postComment(ref: PrRef, body: string): Promise<{ id: string | null; url: string | null }>;
  editComment(ref: PrRef, commentId: string, body: string): Promise<void>;
}

/** GitHub as a share's owner reaches it; null when they have no token stored. */
export type ShareGithubFor = (ownerId: string) => Promise<ShareGithub | null>;

const timedFetch: typeof fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });

/**
 * The owner's stored `gh` token (services/credentialStore.ts). Null only
 * when there is none; a credential store that can't be read (KMS, the
 * database) throws, so the sweep tries again rather than ending previews.
 */
export const ownerGithub: ShareGithubFor = async (ownerId) => {
  const access = await readGithubAccess(ownerId);
  if (!access) return null;
  return {
    readPr: (ref) => fetchPrFacts(access.token, ref, timedFetch),
    readScope: (ref) => fetchPrScope(access.token, ref, timedFetch),
    postComment: (ref, body) => postComment(access.token, ref, body, timedFetch),
    editComment: (ref, commentId, body) => editComment(access.token, ref, commentId, body, timedFetch),
  };
};

/** A stored `owner/name` and number as a PrRef; null when they no longer parse (another org). */
export function sharePrRef(share: Pick<ShareRow, 'prRepo' | 'prNumber'>): PrRef | null {
  if (!share.prRepo || !share.prNumber) return null;
  const [owner, name] = share.prRepo.split('/');
  try { return parsePrRef(owner, name, String(share.prNumber)); } catch { return null; }
}

export type CommentOutcome =
  | { state: 'posted'; url: string | null }
  | { state: 'kept' }
  /** Another request holds the claim and is posting it now. */
  | { state: 'posting' }
  | { state: 'failed'; error: string };

/** A poster's claim older than this is a poster that died: another may take it over. */
export const COMMENT_CLAIM_STALE_MS = 2 * 60 * 1000;

/** `prCommentId` while a poster holds the claim (claimComment): no comment to edit yet. */
export function isPendingComment(id: string | null): boolean {
  return typeof id === 'string' && id.startsWith('pending:');
}

/**
 * Post the comment that carries a link share's link, once per share: the
 * poster first claims it (claimComment), so two creates at once, on any
 * orchestrator, post one comment. A share that has one keeps it. The share
 * may end while GitHub takes the post (the end hook found no comment id to
 * edit then), so once the id is stored the share is read again, and an ended
 * one's comment is edited here. A token that may not comment (a fine-grained
 * one without Pull requests write) leaves the share working, without a
 * comment; the owner is told and can copy the link.
 */
export async function announceLinkShare(
  store: PreviewShareStore, github: ShareGithub, share: ShareRow,
  input: { link: string; signInHint: string | null; ownerName: string; now?: number },
): Promise<CommentOutcome> {
  if (share.prCommentId && !isPendingComment(share.prCommentId)) return { state: 'kept' };
  const ref = sharePrRef(share);
  if (!ref) return { state: 'failed', error: 'Not a pull request termag can comment on.' };
  const claimedAt = input.now ?? Date.now();
  if (!(await store.claimComment(share.id, claimedAt, COMMENT_CLAIM_STALE_MS))) {
    const now = await store.shareRow(share.id).catch(() => null);
    return now?.prCommentId && !isPendingComment(now.prCommentId) ? { state: 'kept' } : { state: 'posting' };
  }
  let made: { id: string | null; url: string | null };
  try {
    made = await github.postComment(ref, previewCommentBody({ link: input.link, shareId: share.id, signInHint: input.signInHint, ownerName: input.ownerName }));
  } catch (err) {
    await store.settleComment(share.id, claimedAt, null).catch(() => {});
    const status = err instanceof GithubApiError ? err.status : 0;
    const error = status === 403 || status === 404
      ? "Your GitHub token can't comment on this pull request (a fine-grained token needs Pull requests: write). Copy the link instead."
      : status === 401 ? 'GitHub rejected your stored token. Reconnect GitHub in Settings.' : 'GitHub did not take the comment. Copy the link instead.';
    await store.recordEvent(share.id, 'comment-failed', { reason: String(status || 'error') });
    console.warn(`[PREVIEW-SHARE] ${share.id}: comment on ${share.prRepo}#${share.prNumber} failed: ${(err as Error).message}`);
    return { state: 'failed', error };
  }
  // The comment is on the PR now: from here on a failure must not lose its id, or no end could
  // ever take the link off it. Storing it is tried twice; if that still fails, the id is logged.
  let stored = false;
  for (let attempt = 0; attempt < 2 && !stored; attempt++) {
    try { await store.settleComment(share.id, claimedAt, made.id); stored = true; } catch (err) {
      if (attempt === 1) console.error(`[PREVIEW-SHARE] ${share.id}: comment ${made.id} (${made.url}) is on ${share.prRepo}#${share.prNumber} but its id could not be stored: ${(err as Error).message}`);
    }
  }
  await store.recordEvent(share.id, 'commented', { detail: { url: made.url, id: made.id, stored } });
  const now = made.id ? await store.shareRow(share.id).catch(() => null) : null;
  if (now?.endedAt && made.id) {
    const by = now.endedReason === 'superseded' ? await store.supersededBy(share.id).catch(() => null) : null;
    await github.editComment(ref, made.id, endedCommentBody(now.endedReason ?? 'ended', share.id, by))
      .catch(err => console.warn(`[PREVIEW-SHARE] ${share.id}: ended while commenting, and the edit failed: ${(err as Error).message}`));
  }
  return { state: 'posted', url: made.url };
}

/** Seam 5, a link share's half: its comment says it ended, and no longer carries the link. */
export function linkShareEndHook(githubFor: ShareGithubFor) {
  return async (share: ShareRow, reason: string, detail: ShareEndDetail): Promise<void> => {
    // A claim still posting: its poster sees the end and edits the comment itself (announceLinkShare).
    if (share.audience !== 'link' || !share.prCommentId || isPendingComment(share.prCommentId)) return;
    const ref = sharePrRef(share);
    if (!ref) return;
    const github = await githubFor(share.ownerId);
    if (!github) return;
    await github.editComment(ref, share.prCommentId, endedCommentBody(reason, share.id, detail.supersededBy ?? null));
  };
}

let hooksInstalled: (() => void) | null = null;

/** Installed once per process (index.ts): every end of a link share edits its comment, on any orchestrator. */
export function installPreviewShareLinkHooks(githubFor: ShareGithubFor = ownerGithub): () => void {
  hooksInstalled?.();
  const off = onPreviewShareEnded(linkShareEndHook(githubFor));
  hooksInstalled = () => { off(); hooksInstalled = null; };
  return hooksInstalled;
}

/** End a link share now: recorded, its guests closed, its hooks run. Null when it had ended already. */
export async function endLinkShare(store: PreviewShareStore, share: ShareRow, host: { userId: string; instanceId: string | null } | null, reason: string, detail: ShareEndDetail = {}): Promise<ShareRow | null> {
  const ended = await store.endOne(share.id, reason);
  if (!ended) return null;
  await teardownShare(store, ended, host, GUEST_REFUSAL_MESSAGES.ended);
  await previewShareEnded(ended, reason, detail);
  return ended;
}

// ── The sweep (leader only) ──────────────────────────────────────────────────

export interface LinkShareSweepDeps {
  store: PreviewShareStore;
  githubFor: ShareGithubFor;
  /** Tell an owner their link share ended because termag can no longer read its PR. */
  notifyOwner(owner: { id: string; displayName: string; slackUserId: string | null; googleEmail: string }, text: string): Promise<void>;
}

const notifyOwnerBySlack: LinkShareSweepDeps['notifyOwner'] = async (owner, text) => {
  const client = getSlackApp()?.client;
  if (!client) return;
  const channel = await slackIdFor(client, owner);
  if (channel) await client.chat.postMessage({ channel, text });
};

export const defaultLinkShareSweepDeps: LinkShareSweepDeps = { store: prismaPreviewShareStore, githubFor: ownerGithub, notifyOwner: notifyOwnerBySlack };

export interface SweepResult { checked: number; ended: Record<string, number>; skipped: number }

let sweeping = false;

/**
 * One pass over every live link share. prPipeline only reads GitHub when
 * someone opens it, and never sees a PR closed without merging, so the sweep
 * reads each PR itself. A merge or a close ends the share (a reopened PR does
 * not bring it back), as does its expiry. A PR the owner's token can no
 * longer read (no token, a 401, a 404) ends it too, and the owner is told; a
 * GitHub that fails otherwise is tried again next pass. An open PR's head
 * commit is kept for the guest header.
 */
export async function runLinkShareSweep(now: number, deps: LinkShareSweepDeps = defaultLinkShareSweepDeps): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, ended: {}, skipped: 0 };
  if (sweeping) return result;
  sweeping = true;
  try {
    const live = await deps.store.liveLinkShares();
    const githubByOwner = new Map<string, Promise<ShareGithub | null>>();
    const end = async (entry: (typeof live)[number], reason: string) => {
      const ended = await endLinkShare(deps.store, entry.share, entry.host, reason);
      if (ended) result.ended[reason] = (result.ended[reason] ?? 0) + 1;
      return ended;
    };
    for (const entry of live) {
      const { share, owner } = entry;
      result.checked++;
      if (share.expiresAt.getTime() <= now) { await end(entry, 'expired'); continue; }
      const ref = sharePrRef(share);
      let unreadable = false;
      let github: ShareGithub | null = null;
      // A stored PR that no longer parses (its org since dropped from ORGS) can't be checked: like an
      // unreadable one, it ends, and the owner is told.
      if (!ref) unreadable = true;
      if (ref) {
        if (!githubByOwner.has(owner.id)) githubByOwner.set(owner.id, deps.githubFor(owner.id));
        try { github = await githubByOwner.get(owner.id)!; } catch (err) {
          // The credential store couldn't be read (KMS, the database): not a missing token, so nothing ends.
          console.warn(`[PREVIEW-SHARE] sweep: ${owner.id}'s GitHub credential could not be read: ${(err as Error).message}`);
          result.skipped++;
          continue;
        }
        if (!github) unreadable = true;
      }
      let facts: PrFacts | null = null;
      if (github && ref) {
        try { facts = await github.readPr(ref); } catch (err) {
          const status = err instanceof GithubApiError ? err.status : 0;
          if (status === 401 || status === 404) unreadable = true;
          else { result.skipped++; continue; }
        }
      }
      if (unreadable) {
        const ended = await end(entry, 'token-invalid');
        if (ended) {
          const why = !ref
            ? 'termag no longer checks pull requests in that repository'
            : `termag can no longer read that pull request with your GitHub token${github ? '' : ' (none is stored)'}`;
          const next = !ref ? '' : ' Reconnect GitHub in Settings, then share it again from the PR overlay.';
          await deps.notifyOwner(owner, `Your preview of ${share.prRepo}#${share.prNumber} ended: ${why}, so it couldn't tell when the PR merged or closed. Its comment on the PR still shows the link, but the link no longer opens.${next}`)
            .catch(err => console.warn(`[PREVIEW-SHARE] ${share.id}: owner notice failed: ${(err as Error).message}`));
        }
        continue;
      }
      if (facts!.state === 'MERGED') { await end(entry, 'merged'); continue; }
      if (facts!.state === 'CLOSED') { await end(entry, 'closed'); continue; }
      if (facts!.headOid !== share.prHeadOid) await deps.store.setPrHead(share.id, facts!.headOid).catch(() => {});
    }
    const endedCount = Object.values(result.ended).reduce((a, b) => a + b, 0);
    if (endedCount) console.log(`[PREVIEW-SHARE] sweep: ${result.checked} link share(s) checked, ended ${JSON.stringify(result.ended)}`);
    return result;
  } finally {
    sweeping = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startPreviewShareSweep(intervalMs = LINK_SHARE_SWEEP_MS): void {
  if (timer) return;
  const tick = () => { runLinkShareSweep(Date.now()).catch(err => console.error('[PREVIEW-SHARE] sweep failed:', err)); };
  timer = setInterval(tick, intervalMs);
  timer.unref();
}

export function stopPreviewShareSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── Seam 4: making a share's box reachable (PR 4b) ───────────────────────────

export interface WakeDeps {
  /** `recordEvent`: a start that failed leaves a `wake-failed` event, since its `woke` is given back. */
  store: Pick<PreviewShareStore, 'claimWake' | 'refundWake' | 'recordEvent'>;
  /** `browser-pane-guest-wake-enabled`, for the owner and box. */
  wakeOn(owner: User, box: Instance | null): Promise<boolean>;
  start(box: Instance): Promise<void>;
  provisioningConfigured(): boolean;
  notifyOwner(owner: { id: string; displayName: string; slackUserId: string | null; googleEmail: string }, text: string): Promise<void>;
  /** The owner's box list changed (their open UI refreshes). */
  boxesChanged(ownerId: string): void;
  /** The box as it is now: after a start that lost a race, whether it is coming up after all. */
  boxNow(boxId: string): Promise<{ status: string; autoTerminatedAt: Date | null } | null>;
  now(): number;
}

export const defaultWakeDeps: Omit<WakeDeps, 'wakeOn'> = {
  store: prismaPreviewShareStore,
  // Not an owner's start: the idle clock restarts, the terminate clock stays (boxPower `guestWake`).
  start: async (box) => { await requestPower(box, 'start', { guestWake: true }); },
  provisioningConfigured: isBoxProvisioningConfigured,
  notifyOwner: notifyOwnerBySlack,
  boxesChanged: (ownerId) => notifyWorkspaceChange(ownerId, 'boxes'),
  boxNow: (boxId) => prisma.instance.findUnique({ where: { id: boxId }, select: { status: true, autoTerminatedAt: true } }),
  now: () => Date.now(),
};

export type WakeResult =
  | { ok: true; status: 'starting' }
  | { ok: false; reason: WakeRefusal; message: string; retryAt?: number }
  | { ok: false; reason: 'failed'; message: string };

/**
 * Whether a share's box could be woken by its viewer now, flag and budget
 * aside (the guest page's offer). Any link share may; a per-person share
 * never does. (`PreviewShare.wakeAllowed`, from the phase 1 schema, is not
 * read: link shares made before 4b would have it off.)
 */
export function wakeable(ctx: GuestShareContext): boolean {
  return ctx.share.audience === 'link' && guestWakeRefusal(ctx.project.instance, isAutoHibernateNote) === null;
}

/**
 * Seam 4: make a share's box reachable for `viewer`, who may already open
 * it (the caller checked). Today: wake the owner's box when the idle sweep
 * hibernated it, as an owner's start would (powerRequestError, for the
 * owner), within the owner's budget across all their shares, and tell them.
 * A fleet would pick or start a box with a free slot here instead.
 */
export async function wakeShareBox(deps: WakeDeps, ctx: GuestShareContext, viewer: User): Promise<WakeResult> {
  const no = (reason: WakeRefusal, retryAt?: number): WakeResult => ({ ok: false, reason, message: WAKE_MESSAGES[reason], ...(retryAt ? { retryAt } : {}) });
  const { share, owner } = ctx;
  const box = ctx.project.instance;
  if (share.audience !== 'link') return no('not-wakeable');
  if (box?.status === 'starting') return { ok: true, status: 'starting' };
  const refusal = guestWakeRefusal(box, isAutoHibernateNote);
  if (refusal) return no(refusal);
  if (!(await deps.wakeOn(owner, box))) return no('wake-off');
  // The owner's own checks, as the owner: a box on EC2, provisioning on, a
  // start the box's state allows, not one the sweep claimed for terminate.
  const policy = powerRequestError(box, owner.id, 'start', deps.provisioningConfigured());
  if (policy) return { ok: false, reason: 'failed', message: "The owner's box can't be started from here right now. Ask its owner to start it." };
  const claim = await deps.store.claimWake({ ownerId: owner.id, shareId: share.id, viewerId: viewer.id, now: deps.now() });
  if (!claim.ok) return no(claim.reason, claim.retryAt);
  try {
    await deps.start(box!);
  } catch (err) {
    await deps.store.refundWake(claim.wakeId);
    if (err instanceof PowerRequestConflict) {
      // The box changed between the read and the write: someone else started it (it is coming up
      // anyway), or the lifecycle sweep claimed it for terminate (it stays down).
      let now: Awaited<ReturnType<WakeDeps['boxNow']>> | undefined;
      try { now = await deps.boxNow(box!.id); } catch { now = undefined; }
      if (now && !now.autoTerminatedAt && (now.status === 'starting' || now.status === 'ready')) return { ok: true, status: 'starting' };
      // Gone or claimed for terminate is final; a read that failed, or any other change, is worth another try.
      if (now === null || now?.autoTerminatedAt) return no('no-box');
      return { ok: false, reason: 'failed', message: "The owner's box changed state just now. Try again in a moment." };
    }
    await deps.store.recordEvent(share.id, 'wake-failed', { actorId: viewer.id, reason: (err as Error).message.slice(0, 200) }).catch(() => {});
    console.warn(`[PREVIEW-SHARE] ${share.id}: waking ${box!.id} failed: ${(err as Error).message}`);
    return { ok: false, reason: 'failed', message: "Could not start the owner's box. Try again in a moment, or ask its owner." };
  }
  console.log(`[PREVIEW-SHARE] ${viewer.id} woke ${owner.id}'s box ${box!.id} for ${share.id}`);
  deps.boxesChanged(owner.id);
  const what = share.prRepo && share.prNumber ? `${share.prRepo}#${share.prNumber}` : 'a preview';
  await deps.notifyOwner(owner, `${viewer.displayName} woke your box ${box!.name} to review ${what}. It goes back to sleep on its own once nobody is using it.`)
    .catch(err => console.warn(`[PREVIEW-SHARE] ${share.id}: wake notice failed: ${(err as Error).message}`));
  return { ok: true, status: 'starting' };
}
