/**
 * Waking a parked box from a preview link's landing page
 * (step 3; PRD U4;
 * security review SR20), as a link share's wake does (previewShareLinks.ts,
 * wakeShareBox), behind `preview-links-wake-enabled`.
 *
 * Only a viewer the link already admits gets here (the landing's decide runs
 * first; anyone else gets the same 404 and never a wake). Then:
 * - not the box's owner: their own box is theirs to start, as they would;
 * - only a box the idle sweep stopped (or hibernated) and nobody has touched
 *   since; a box its owner stopped by hand is never started by a viewer;
 * - the owner's own start rules (powerRequestError), as the owner;
 * - within the owner's guest wake budget, one for their preview shares and
 *   links (previewShares.ts, claimGuestWake): 30 minutes apart, six a day;
 * - a start as a guest's: the idle clock restarts, the terminate clock stays,
 *   so the woken box goes back down through the default idle window;
 * - the owner is told on Slack who woke it, and for which link.
 * A start that fails gives the wake back.
 */
import type { Instance, User } from '@prisma/client';
import { prisma } from '../db';
import { isAutoHibernateNote, isSweepStopped } from './boxLifecyclePolicy';
import { PowerRequestConflict, requestPower } from './boxPower';
import { powerRequestError } from './boxPowerPolicy';
import { isBoxProvisioningConfigured } from './boxProvisioner';
import { dropLinkWake, recordLinkWake } from './previewAudience';
import { previewLinkWakeEnabled } from './previewLinkFlags';
import { guestWakeRefusal, WAKE_MESSAGES, type WakeRefusal } from './previewShareRules';
import { claimGuestWake } from './previewShares';
import { notifyWorkspaceChange } from './workspaceEvents';

export type LinkWakeRefusal = WakeRefusal | 'owner' | 'off';

export type LinkWakeResult =
  | { ok: true; status: 'starting' }
  | { ok: false; reason: LinkWakeRefusal; message: string; retryAt?: number }
  | { ok: false; reason: 'failed'; message: string };

export const LINK_WAKE_MESSAGES: Record<LinkWakeRefusal, string> = {
  ...WAKE_MESSAGES,
  'not-wakeable': "This preview can't wake its box. Ask its owner to start it.",
  'too-soon': 'This box was woken for a viewer a few minutes ago. Try again later, or ask its owner.',
  daily: "This owner's box has been woken for viewers as often as it may be today. Ask its owner to start it.",
  owner: 'This is your box: start it from termag, then open the link again.',
  off: 'This preview is asleep. Ask its owner to start the box.',
};

export interface LinkWakeContext {
  link: { id: string; name: string; audienceId: string };
  project: { userId: string; instanceId: string | null; owner: User };
}

export interface LinkWakeDeps {
  /** preview-links-wake-enabled for the owner and box. */
  enabled(owner: User, box: Instance | null): Promise<boolean>;
  /** The box as it is now (not a cached context's). */
  box(boxId: string): Promise<Instance | null>;
  /** claimGuestWake, recording the link's wake. */
  claim(input: { ownerId: string; audienceId: string; linkId: string; viewerId: string; now: number }): Promise<{ ok: true; wakeId: string } | { ok: false; reason: 'too-soon' | 'daily'; retryAt: number }>;
  refund(wakeId: string): Promise<void>;
  start(box: Instance): Promise<void>;
  provisioningConfigured(): boolean;
  notifyOwner(owner: User, text: string): Promise<void>;
  boxesChanged(ownerId: string): void;
  now(): number;
}

/**
 * Statuses where a Wake it post goes back to the landing rather than waking: coming up or up (another viewer's wake,
 * or its owner's start), or still going down, where the landing looks again until the wake can be offered (Bugbot, #1570).
 */
const BACK_TO_LANDING = new Set(['starting', 'ready', 'stopping', 'hibernating']);

const no = (reason: LinkWakeRefusal, retryAt?: number): LinkWakeResult => ({ ok: false, reason, message: LINK_WAKE_MESSAGES[reason], ...(retryAt ? { retryAt } : {}) });

/**
 * Whether the landing offers "Wake it" to this viewer, the budget aside (it's
 * checked on the wake itself): null when it would, else why not.
 */
export async function linkWakeRefusal(deps: Pick<LinkWakeDeps, 'enabled' | 'box'>, ctx: LinkWakeContext, viewerId: string): Promise<LinkWakeRefusal | null> {
  if (ctx.project.userId === viewerId) return 'owner';
  const box = ctx.project.instanceId ? await deps.box(ctx.project.instanceId) : null;
  if (!(await deps.enabled(ctx.project.owner, box))) return 'off';
  // Coming up, up already, or still going down: nothing to refuse; the landing shows which (Bugbot, #1570).
  if (box && BACK_TO_LANDING.has(box.status)) return null;
  return guestWakeRefusal(box, isAutoHibernateNote, isSweepStopped);
}

/** Wake the link's box for `viewer`, whom the link admits (the caller decided it). */
export async function wakeLinkBox(deps: LinkWakeDeps, ctx: LinkWakeContext, viewer: { id: string; googleEmail: string }): Promise<LinkWakeResult> {
  // Up, coming up or going down: back to the landing, which hands off, shows the wait, or looks again; a wake that
  // would be refused (the owner, the flag off) has nothing to do there either, so it doesn't refuse (Bugbot, #1570).
  const first = ctx.project.instanceId ? await deps.box(ctx.project.instanceId) : null;
  if (first && BACK_TO_LANDING.has(first.status)) return { ok: true, status: 'starting' };
  const refusal = await linkWakeRefusal(deps, ctx, viewer.id);
  if (refusal) return no(refusal);
  const box = await deps.box(ctx.project.instanceId!);
  if (box && BACK_TO_LANDING.has(box.status)) return { ok: true, status: 'starting' };
  // Decided on the box this start reads, not the look before: a stop that settled in between may be its owner's,
  // which no viewer may undo (Bugbot, #1570).
  const settled = guestWakeRefusal(box, isAutoHibernateNote, isSweepStopped);
  if (settled) return no(settled);
  const owner = ctx.project.owner;
  if (powerRequestError(box, owner.id, 'start', deps.provisioningConfigured())) {
    return { ok: false, reason: 'failed', message: "The owner's box can't be started from here right now. Ask its owner to start it." };
  }
  const claim = await deps.claim({ ownerId: owner.id, audienceId: ctx.link.audienceId, linkId: ctx.link.id, viewerId: viewer.id, now: deps.now() });
  if (!claim.ok) {
    // Another viewer's wake took the budget a moment ago: join it rather than stop at a refusal (Bugbot, #1570).
    const now = await deps.box(box!.id).catch(() => null);
    if (now && !now.autoTerminatedAt && (now.status === 'starting' || now.status === 'ready')) return { ok: true, status: 'starting' };
    return no(claim.reason, claim.retryAt);
  }
  try {
    await deps.start(box!);
  } catch (err) {
    await deps.refund(claim.wakeId);
    if (err instanceof PowerRequestConflict) {
      const now = await deps.box(box!.id).catch(() => undefined);
      if (now && !now.autoTerminatedAt && (now.status === 'starting' || now.status === 'ready')) return { ok: true, status: 'starting' };
      if (now === null || now?.autoTerminatedAt) return no('no-box');
      return { ok: false, reason: 'failed', message: "The owner's box changed state just now. Try again in a moment." };
    }
    return { ok: false, reason: 'failed', message: "The owner's box didn't start. Ask its owner to start it." };
  }
  deps.boxesChanged(owner.id);
  await deps.notifyOwner(owner, `${viewer.googleEmail} woke your box ${box!.name} to open your preview link ${ctx.link.name}. It goes back to sleep when it's idle, as usual.`).catch(() => {});
  return { ok: true, status: 'starting' };
}

export const defaultLinkWakeDeps: LinkWakeDeps = {
  enabled: (owner, box) => previewLinkWakeEnabled(owner, box),
  box: (boxId) => prisma.instance.findUnique({ where: { id: boxId } }),
  claim: ({ ownerId, audienceId, linkId, viewerId, now }) => claimGuestWake(ownerId, now, tx => recordLinkWake(tx, { audienceId, linkId, viewerId, at: new Date(now) })),
  refund: dropLinkWake,
  // Not an owner's start: the idle clock restarts, the terminate clock stays (boxPower `guestWake`).
  start: async (box) => { await requestPower(box, 'start', { guestWake: true }); },
  provisioningConfigured: isBoxProvisioningConfigured,
  async notifyOwner(owner, text) {
    const { getSlackApp } = await import('../slack/app');
    const { slackIdFor } = await import('./briefing/slack');
    const client = getSlackApp()?.client;
    if (!client) return;
    const channel = await slackIdFor(client, owner);
    if (channel) await client.chat.postMessage({ channel, text });
  },
  boxesChanged: (ownerId) => notifyWorkspaceChange(ownerId, 'boxes'),
  now: () => Date.now(),
};
