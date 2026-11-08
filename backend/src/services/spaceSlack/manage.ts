/**
 * Managing a space's Slack from termag:
 * the status view, pause and resume, handing the runner to another owner, and
 * disabling Slack for the space. Linking and unlinking stay in link.ts; this
 * file reads and writes only what those don't.
 *
 * The runner handover is two steps, the runner's offer and the offered
 * owner's acceptance, with no table of its own: the offer is a SpaceEvent
 * (`slack.runner_offer`), and the latest of the runner events says whether one
 * is pending. An owner may take over without an offer when the runner is no
 * longer an owner of the space (they left, or were made an editor).
 *
 * Until M7 there is no orchestrator project to stop or archive: disable
 * unlinks every channel and marks the row disabled; M7 adds stopping the runs
 * and archiving the project.
 */
import { prisma } from '../../db';
import { canManage, resolveSpaceAccess } from '../spaces/spaceAccess';
import type { SpaceRecord, SpaceStore } from '../spaces/spaceStore';
import { boxChoiceNote, GONE_BOX_STATUSES, type RunnerBoxChoice } from './enable';
import { unlink, type LinkActor, type LinkDeps, type LinkVia } from './link';
import type { SpaceChannelRow, SpaceSlackRow } from './linkStore';

/** What this file needs beyond SpaceSlackStore. */
export interface SpaceSlackAdminStore {
  /** The linked (not unlinked) channels of a SpaceSlack, oldest link first. */
  linkedChannels(spaceSlackId: string): Promise<SpaceChannelRow[]>;
  /** These channels' rows, linked or not, for the picker. */
  channelsByIds(channelIds: string[]): Promise<SpaceChannelRow[]>;
  /** Moves status from one of `from` to `to`; null when it wasn't in `from` (or is disabled). */
  setStatus(spaceSlackId: string, from: string[], to: string): Promise<SpaceSlackRow | null>;
  /** Sets the runner, only while it is still `expectRunner`; null otherwise. */
  setRunner(spaceSlackId: string, expectRunner: string, runnerUserId: string, instanceId: string | null): Promise<SpaceSlackRow | null>;
  /** Sets disabledAt on a live row; null when it was already disabled. */
  markDisabled(spaceSlackId: string, at: Date): Promise<SpaceSlackRow | null>;
  /** Channels of a SpaceSlack unlinked for this reason (a disable's, to freeze their threads again). */
  unlinkedChannels(spaceSlackId: string, reason: string): Promise<SpaceChannelRow[]>;
  /** The space's newest event with one of these actions, however many other events came after it. */
  latestEvent(spaceId: string, actions: readonly string[]): Promise<{ action: string; note?: string | null } | null>;
}

const SELECT = {
  id: true, spaceId: true, enabledById: true, runnerUserId: true, projectId: true, instanceId: true,
  status: true, limits: true, disabledAt: true,
} as const;

async function updatedOrNull(count: number, id: string): Promise<SpaceSlackRow | null> {
  return count === 1 ? prisma.spaceSlack.findUnique({ where: { id }, select: SELECT }) : null;
}

export const prismaSpaceSlackAdminStore: SpaceSlackAdminStore = {
  async linkedChannels(spaceSlackId) {
    return prisma.spaceChannel.findMany({ where: { spaceSlackId, unlinkedAt: null }, orderBy: { linkedAt: 'asc' } });
  },
  async channelsByIds(channelIds) {
    if (!channelIds.length) return [];
    return prisma.spaceChannel.findMany({ where: { channelId: { in: channelIds } } });
  },
  async setStatus(id, from, to) {
    const done = await prisma.spaceSlack.updateMany({ where: { id, status: { in: from }, disabledAt: null }, data: { status: to } });
    return updatedOrNull(done.count, id);
  },
  async setRunner(id, expectRunner, runnerUserId, instanceId) {
    const done = await prisma.spaceSlack.updateMany({
      where: { id, runnerUserId: expectRunner, disabledAt: null }, data: { runnerUserId, instanceId },
    });
    return updatedOrNull(done.count, id);
  },
  async markDisabled(id, at) {
    const done = await prisma.spaceSlack.updateMany({ where: { id, disabledAt: null }, data: { disabledAt: at } });
    return updatedOrNull(done.count, id);
  },
  async unlinkedChannels(spaceSlackId, reason) {
    return prisma.spaceChannel.findMany({ where: { spaceSlackId, unlinkedAt: { not: null }, unlinkReason: reason } });
  },
  async latestEvent(spaceId, actions) {
    return prisma.spaceEvent.findFirst({ where: { spaceId, action: { in: [...actions] } }, orderBy: { at: 'desc' }, select: { action: true, note: true } });
  },
};

export type ManageRefusal = 'space_channels_off' | 'not_owner' | 'not_enabled' | 'not_runner' | 'no_offer'
  | 'not_an_owner' | 'suspended' | 'runner_no_box' | 'already';

export type ManageRefused = { kind: 'refused'; code: ManageRefusal; message: string };

export function manageRefusalText(code: ManageRefusal, spaceName = 'the space'): string {
  switch (code) {
    case 'space_channels_off': return 'Linking Slack channels to spaces is not available yet.';
    case 'not_owner': return `Only an owner of ${spaceName} can change its Slack settings.`;
    case 'not_enabled': return `Slack isn't on for ${spaceName}: link a channel first.`;
    case 'not_runner': return `Only ${spaceName}'s runner can hand it over.`;
    case 'no_offer': return 'Nobody offered you the runner; ask the current runner to hand it over.';
    case 'not_an_owner': return `The new runner must be an owner of ${spaceName}.`;
    case 'suspended': return `${spaceName}'s Slack is suspended by termag; it can't be resumed from here.`;
    case 'runner_no_box': return 'That box isn\'t one of your live boxes; pick another or a new one.';
    case 'already': return 'Nothing to change.';
  }
}

const refuse = (code: ManageRefusal, spaceName?: string): ManageRefused => ({ kind: 'refused', code, message: manageRefusalText(code, spaceName) });

export interface ManageDeps extends LinkDeps {
  spaces: LinkDeps['spaces'] & Pick<SpaceStore, 'events' | 'members' | 'boxesOwnedBy' | 'spacesOfUser' | 'grantedBoxIds'>;
  admin: SpaceSlackAdminStore;
}

export interface ManageCtx {
  space: SpaceRecord;
  actor: LinkActor;
  via: LinkVia;
}

export const RUNNER_ACTIONS = ['slack.runner_offer', 'slack.runner_offer_cancel', 'slack.runner_change', 'slack.enable', 'slack.disable'] as const;

/**
 * The owner the runner offered the role to, if the offer still stands: the
 * newest runner event, looked up by action, so file and memory events after
 * the offer never push it out of view.
 */
export async function pendingRunnerOf(deps: Pick<ManageDeps, 'admin'>, spaceId: string): Promise<string | null> {
  const last = await deps.admin.latestEvent(spaceId, RUNNER_ACTIONS);
  if (last?.action !== 'slack.runner_offer') return null;
  return /(?:^|; )to=([^;]+)/.exec(last.note ?? '')?.[1] ?? null;
}

async function isOwner(deps: Pick<ManageDeps, 'spaces'>, space: SpaceRecord, userId: string): Promise<boolean> {
  const members = await deps.spaces.memberRoles(space.id);
  const access = resolveSpaceAccess({ kind: 'user', userId }, { space, members, grantedBoxIds: new Set() });
  return !!access && canManage(access);
}

/** The caller is an owner, the flag is on, and Slack is on for the space. */
async function ownerAndEnabled(deps: ManageDeps, ctx: ManageCtx): Promise<SpaceSlackRow | ManageRefused> {
  if (!await deps.channelsEnabled(ctx.actor.userId)) return refuse('space_channels_off');
  if (!await isOwner(deps, ctx.space, ctx.actor.userId)) return refuse('not_owner', ctx.space.name);
  const row = await deps.store.spaceSlack(ctx.space.id);
  if (!row || row.disabledAt) return refuse('not_enabled', ctx.space.name);
  return row;
}

async function audit(deps: ManageDeps, ctx: ManageCtx, action: string, note: string) {
  await deps.spaces.recordEvent({ spaceId: ctx.space.id, actorUserId: ctx.actor.userId, action, surface: 'slack', note: `linkedVia=${ctx.via}; ${note}` });
}

/** Pause (answers stop in every linked channel) or resume. A suspended space stays suspended. */
export async function setPaused(deps: ManageDeps, ctx: ManageCtx, paused: boolean): Promise<{ kind: 'ok'; spaceSlack: SpaceSlackRow } | ManageRefused> {
  const row = await ownerAndEnabled(deps, ctx);
  if ('kind' in row) return row;
  if (row.status === 'suspended') return refuse('suspended', ctx.space.name);
  const done = paused
    ? await deps.admin.setStatus(row.id, ['active'], 'paused')
    : await deps.admin.setStatus(row.id, ['paused'], 'active');
  if (!done) return { kind: 'ok', spaceSlack: row };
  await audit(deps, ctx, paused ? 'slack.pause' : 'slack.resume', `status=${done.status}`);
  return { kind: 'ok', spaceSlack: done };
}

export type RunnerRequest =
  | { offer: string }
  | { cancel: true }
  | { accept: true; box?: RunnerBoxChoice };

/**
 * The runner offers the role to another owner (`offer`: their user id) or
 * withdraws the offer; the offered owner accepts with their own box. An owner
 * may also accept when the runner is no longer an owner.
 */
export async function handOverRunner(deps: ManageDeps, ctx: ManageCtx, req: RunnerRequest):
  Promise<{ kind: 'offered'; to: string } | { kind: 'cancelled' } | { kind: 'runner'; spaceSlack: SpaceSlackRow } | ManageRefused> {
  const row = await ownerAndEnabled(deps, ctx);
  if ('kind' in row) return row;
  const me = ctx.actor.userId;

  if ('offer' in req) {
    if (row.runnerUserId !== me) return refuse('not_runner', ctx.space.name);
    if (req.offer === me) return refuse('already');
    if (!await isOwner(deps, ctx.space, req.offer) || !await deps.channelsEnabled(req.offer)) return refuse('not_an_owner', ctx.space.name);
    await audit(deps, ctx, 'slack.runner_offer', `from=${me}; to=${req.offer}`);
    return { kind: 'offered', to: req.offer };
  }
  if ('cancel' in req) {
    if (row.runnerUserId !== me) return refuse('not_runner', ctx.space.name);
    if (!await pendingRunnerOf(deps, ctx.space.id)) return refuse('no_offer');
    await audit(deps, ctx, 'slack.runner_offer_cancel', `from=${me}`);
    return { kind: 'cancelled' };
  }

  if (row.runnerUserId === me) return refuse('already');
  const offered = (await pendingRunnerOf(deps, ctx.space.id)) === me;
  const orphaned = !await isOwner(deps, ctx.space, row.runnerUserId);
  if (!offered && !orphaned) return refuse('no_offer');
  let instanceId: string | null = null;
  const box = req.box ?? { new: { size: 'small' } };
  if ('existing' in box) {
    const found = await deps.spaces.box(box.existing);
    // The same rule as a first link's box (enable.ts): failed and quarantined boxes can't run it either.
    if (!found || found.userId !== me || GONE_BOX_STATUSES.has(found.status)) return refuse('runner_no_box');
    instanceId = found.id;
  }
  const done = await deps.admin.setRunner(row.id, row.runnerUserId, me, instanceId);
  if (!done) return refuse('no_offer');
  await audit(deps, ctx, 'slack.runner_change', `from=${row.runnerUserId}; to=${me}; ${offered ? 'offered' : 'runner_not_owner'}; ${boxChoiceNote(box)}`);
  return { kind: 'runner', spaceSlack: done };
}

/**
 * Disable Slack for the space: the row disabled first, then every channel
 * unlinked (reason `disabled`). Disabling first makes a link that starts now a
 * first link again (it re-enables the space, as a new link should); a link
 * already past its checks may still claim its channel while this runs, so the
 * channels are read again after each pass until none is left.
 *
 * The sweep is fenced to this disable: before each channel it checks the row
 * is still disabled, and stops if someone re-enabled the space meanwhile (their
 * new channel is theirs). One channel's failure doesn't stop the others: when
 * an unlink throws after the channel was marked unlinked (its thread freeze
 * failed), the freeze is tried again (unlink() refreezes an unlinked channel).
 * Disabling an already-disabled space finishes what an earlier disable left:
 * the channels still linked, and the freezes of the ones it unlinked.
 */
export async function disable(deps: ManageDeps, ctx: ManageCtx):
  Promise<{ kind: 'disabled'; unlinked: number; remaining: number; unfrozen: number; reenabled: boolean } | ManageRefused> {
  if (!await deps.channelsEnabled(ctx.actor.userId)) return refuse('space_channels_off');
  if (!await isOwner(deps, ctx.space, ctx.actor.userId)) return refuse('not_owner', ctx.space.name);
  const row = await deps.store.spaceSlack(ctx.space.id);
  if (!row) return refuse('not_enabled', ctx.space.name);
  const retry = !!row.disabledAt;
  // A concurrent disable may get there first (null): this one still sweeps.
  if (!retry) await deps.admin.markDisabled(row.id, (deps.now ?? (() => new Date()))());
  const stillDisabled = async () => !!(await deps.store.spaceSlackById(row.id))?.disabledAt;
  const unlinkOne = (channelId: string) => unlink(deps, { channelId, actor: ctx.actor, via: ctx.via, reason: 'disabled', mode: 'commit' });

  let unlinked = 0;
  let unfrozen = 0;
  let reenabled = false;
  sweep: for (let pass = 0; pass < DISABLE_SWEEPS; pass++) {
    const left = await deps.admin.linkedChannels(row.id);
    if (!left.length) break;
    let progress = false;
    for (const ch of left) {
      if (!await stillDisabled()) { reenabled = true; break sweep; }
      try {
        if ((await unlinkOne(ch.channelId)).kind === 'unlinked') { unlinked++; progress = true; }
      } catch (err) {
        console.error(`[SPACE-SLACK] Unlinking ${ch.channelId} while disabling ${ctx.space.name} failed:`, (err as Error).message);
        // Marked unlinked before it threw: the freeze failed. Count it, and freeze again.
        if ((await deps.store.channel(ch.channelId))?.unlinkedAt) {
          unlinked++;
          progress = true;
          if (!await refreeze(deps, ch.channelId, unlinkOne)) unfrozen++;
        }
      }
    }
    if (!progress) break;
  }
  // An earlier disable's unlinks whose freeze may have failed: freezing again is always right.
  if (retry && !reenabled) {
    for (const ch of await deps.admin.unlinkedChannels(row.id, 'disabled')) {
      if (!await refreeze(deps, ch.channelId, unlinkOne)) unfrozen++;
    }
  }
  const remaining = reenabled ? 0 : (await deps.admin.linkedChannels(row.id)).length;
  // M7: stop the orchestrator's runs and archive its project here.
  await audit(deps, ctx, 'slack.disable',
    `unlinked=${unlinked}; remaining=${remaining}${unfrozen ? `; unfrozen=${unfrozen}` : ''}${retry ? '; retry' : ''}${reenabled ? '; reenabled' : ''}`);
  return { kind: 'disabled', unlinked, remaining, unfrozen, reenabled };
}

/** For a channel that is unlinked now, its space threads frozen again (unlink() does it); false when that fails too. */
async function refreeze(deps: ManageDeps, channelId: string, unlinkOne: (id: string) => Promise<unknown>): Promise<boolean> {
  if (!(await deps.store.channel(channelId))?.unlinkedAt) return false;
  try {
    await unlinkOne(channelId);
    return true;
  } catch (err) {
    console.error(`[SPACE-SLACK] Freezing ${channelId}'s threads again failed:`, (err as Error).message);
    return false;
  }
}

/** Passes over the linked channels a disable makes, for links that land while it runs. */
const DISABLE_SWEEPS = 5;
