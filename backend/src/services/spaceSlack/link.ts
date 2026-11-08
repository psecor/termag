/**
 * The link service (§4.6): the one place a
 * Slack channel is linked to a space or unlinked from it. Every entry point
 * (`/t link`, the shortcut, App Home, the web dialog, the CLI) calls `link()`
 * twice, once to preview and once to commit, and every refusal has a code.
 *
 * Checks, in the order they run:
 *   1. space-channels-enabled for the actor          space_channels_off
 *   2. the actor owns the space                       space_not_found, not_owner
 *   4. not a DM, a #proj-… channel, Slack Connect
 *      or archived                                   channel_dm, channel_workstream, channel_ext_shared, channel_archived
 *   3. the actor is in the channel (from Slack, and
 *      for a private channel from anywhere)           not_in_channel, actor_not_in_slack
 *   5. not linked to another space                    channel_linked (the same space: a no-op)
 *   6. under channelsPerSpace, private allowed        too_many_channels, private_not_allowed
 *   7. termag is in the channel or can join           needs_invite
 *
 * 4, 5 and 6 run before 3 (the spec lists 3 first) so termag never joins a
 * channel it would refuse anyway (3's S2 fallback joins; below). Only 3's own
 * answer can still come after such a join: under the fallback, membership
 * can't be read without it.
 *
 * Pending the M0 spike, two places use the tech spec's fallback:
 *   - [S2] When the bot can't read the members of a public channel it hasn't
 *     joined, it joins first, then reads them (`readMembers`).
 *   - [S4] Unlinks for termag's removal come from channel events and the
 *     reconcile (M5d); `unlink` takes `reason: 'removed'` and posts nothing.
 *
 * Freezing threads (§4.6) goes through the `ThreadFreezer` port: production's
 * is threadFreezer.ts (`slack_agent_threads.frozenAt`), wired in runtime.ts.
 */
import { canManage, resolveSpaceAccess } from '../spaces/spaceAccess';
import type { SpaceRecord, SpaceStore } from '../spaces/spaceStore';
import {
  createSpaceChannel, isWorkstreamChannelName, spaceChannelNameProblem, spaceChannelNameRuleText,
  type SpaceChannelClient,
} from '../../slack/channels';
import {
  activateSpaceSlack, completeEnable, DEFAULT_RUNNER_BOX, GONE_BOX_STATUSES,
  type EnableDeps, type EnableInput, type RunnerBoxChoice,
} from './enable';
import type { SpaceSlackLimits } from './limits';
import type { SpaceChannelRow, SpaceSlackRow, SpaceSlackStore } from './linkStore';

export type LinkVia = 'slack_command' | 'slack_shortcut' | 'app_home' | 'web' | 'cli';
export type UnlinkReason = 'owner' | 'archived' | 'removed' | 'ext_shared' | 'disabled' | 'space_deleted' | 'relinked';
export type LinkRefusal =
  | 'space_channels_off' | 'space_not_found' | 'not_owner' | 'not_in_channel' | 'actor_not_in_slack'
  | 'channel_dm' | 'channel_workstream' | 'channel_ext_shared' | 'channel_archived' | 'channel_linked'
  | 'too_many_channels' | 'private_not_allowed' | 'needs_invite' | 'runner_no_box' | 'not_linked'
  | 'name_invalid' | 'name_taken' | 'restricted_action' | 'slack_error';

const SLACK_ENTRY_POINTS: ReadonlySet<LinkVia> = new Set(['slack_command', 'slack_shortcut', 'app_home']);

export interface LinkActor { userId: string; slackId?: string }

export interface LinkInput {
  spaceName: string;
  /** An existing channel; or `create` for a new one. */
  channelId?: string;
  create?: { name: string; private: boolean; inviteMembers: boolean };
  actor: LinkActor;
  via: LinkVia;
  /** Preview first (every entry point), then commit. */
  mode: 'preview' | 'commit';
  /** The first link's runner box; a new small box by default. */
  runner?: { box: RunnerBoxChoice };
  teamId?: string;
}

export type LinkRefused = { kind: 'refused'; code: LinkRefusal; message: string; suggestion?: string; error?: string };

export type LinkResult =
  | { kind: 'preview'; bystanders: number | null; needsInvite: boolean; firstLink: boolean; channelName: string | null; isPrivate: boolean }
  | { kind: 'linked'; channel: SpaceChannelRow; already: boolean; failedInvites?: Array<{ id: string; error: string }> }
  | LinkRefused;

export interface UnlinkInput {
  channelId: string;
  /** null: termag itself (an event or the reconcile). */
  actor: LinkActor | null;
  via: LinkVia | 'slack_event' | 'reconcile';
  reason: UnlinkReason;
  /** Honoured only for channels termag created. */
  archive?: boolean;
  mode: 'preview' | 'commit';
}

export type UnlinkResult =
  | { kind: 'preview'; spaceName: string; channelName: string; threads: number | null; canArchive: boolean }
  | { kind: 'unlinked'; channel: SpaceChannelRow; spaceName: string; archived: boolean }
  | LinkRefused;

/** What a channel is, from conversations.info. */
export interface SlackChannelInfo {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_ext_shared?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  context_team_id?: string;
}

export interface LinkSlackClient extends SpaceChannelClient {
  conversations: SpaceChannelClient['conversations'] & {
    info(args: { channel: string }): Promise<{ channel?: SlackChannelInfo }>;
    members(args: { channel: string; limit: number; cursor?: string }): Promise<{ members?: string[]; response_metadata?: { next_cursor?: string } }>;
    join(args: { channel: string }): Promise<unknown>;
  };
  chat: { postMessage(args: { channel: string; text: string; blocks?: unknown[] }): Promise<{ ts?: string }> };
  /** Who the bot token is, when the entry point didn't say (`deps.botUserId`). */
  auth?: { test(): Promise<{ user_id?: string }> };
}

/** Freezes termag's threads in a channel (§4.6). */
export interface ThreadFreezer {
  /**
   * At link: every existing termag thread in the channel, operator `personal`
   * threads included, and any an earlier link left unfrozen. `repeat` (the
   * same-space no-op retrying a failed freeze) leaves `space` threads alone:
   * those are the live link's own.
   */
  freezeAtLink(channelId: string, spaceName: string, at: Date, opts?: { repeat?: boolean }): Promise<number>;
  /** At unlink: the channel's `space` threads. */
  freezeAtUnlink(channelId: string, spaceName: string, at: Date): Promise<number>;
  /** The channel's `space` threads, for the unlink preview; null when unknown. */
  spaceThreadCount(channelId: string): Promise<number | null>;
}

/** Freezes nothing: for tests and scripts without the database. Production uses threadFreezer.ts. */
export const noThreadFreezer: ThreadFreezer = {
  async freezeAtLink() { return 0; },
  async freezeAtUnlink() { return 0; },
  async spaceThreadCount() { return null; },
};

export interface LinkDeps {
  spaces: Pick<SpaceStore, 'findSpace' | 'memberRoles' | 'box' | 'recordEvent'>;
  store: SpaceSlackStore;
  /** null when Slack isn't configured. */
  slack: LinkSlackClient | null;
  /** space-channels-enabled, read for this person. */
  channelsEnabled(userId: string): Promise<boolean>;
  /** The caps, read for the runner, with the space's own overrides. */
  limitsFor(runnerUserId: string, overrides: unknown): Promise<SpaceSlackLimits>;
  freezer?: ThreadFreezer;
  /** termag's own bot user, left out of the bystander count; looked up with auth.test when absent. */
  botUserId?: string;
  ensureOrchestratorProject?: EnableDeps['ensureOrchestratorProject'];
  now?: () => Date;
}

/** What each refusal says, for Slack replies, the API and the CLI. */
export function refusalText(code: LinkRefusal, ctx: { spaceName?: string; limit?: number; suggestion?: string; error?: string } = {}): string {
  const space = ctx.spaceName ? `*${ctx.spaceName}*` : 'the space';
  switch (code) {
    case 'space_channels_off': return 'Linking Slack channels to spaces is not available yet.';
    case 'space_not_found': return `There is no space named ${ctx.spaceName ?? 'that'} that you are a member of.`;
    case 'not_owner': return `Only an owner of ${space} can link or unlink its channels.`;
    case 'not_in_channel': return 'You need to be a member of this channel to link it.';
    case 'actor_not_in_slack': return 'termag can\'t find your Slack account: sign in to termag with the email you use in Slack.';
    case 'channel_dm': return 'A direct message or group DM can\'t be linked to a space.';
    case 'channel_workstream': return 'A #proj-… channel belongs to a workstream and can\'t be linked to a space.';
    case 'channel_ext_shared': return 'A channel shared with another organisation (Slack Connect) can\'t be linked to a space.';
    case 'channel_archived': return 'That channel is archived; unarchive it in Slack first.';
    case 'channel_linked': return 'This channel is already linked to another space; unlink it there first.';
    case 'too_many_channels': return `${space} already has ${ctx.limit ?? 'the most'} linked channels; unlink one first.`;
    case 'private_not_allowed': return 'Private channels can\'t be linked to spaces here.';
    case 'needs_invite': return `Invite me with \`/invite @termag\`, then run \`/t link ${ctx.spaceName ?? '<space>'}\` again.`;
    case 'runner_no_box': return 'That box isn\'t one of your live boxes; pick another or a new one.';
    case 'not_linked': return 'This channel isn\'t linked to a space.';
    case 'name_invalid': return ctx.error ?? 'That channel name isn\'t allowed.';
    case 'name_taken': return `That name is taken${ctx.suggestion ? `; try ${ctx.suggestion}` : ''}. To use the existing channel, link it instead.`;
    case 'restricted_action': return 'This workspace doesn\'t let apps create channels: create it in Slack, then link it.';
    case 'slack_error': return `Slack refused${ctx.error ? ` (${ctx.error})` : ''}; try again.`;
  }
}

const refuse = (code: LinkRefusal, ctx: Parameters<typeof refusalText>[1] = {}): LinkRefused => ({
  kind: 'refused', code, message: refusalText(code, ctx),
  ...(ctx.suggestion ? { suggestion: ctx.suggestion } : {}), ...(ctx.error ? { error: ctx.error } : {}),
});

function slackErrorOf(err: unknown): string {
  const e = err as { data?: { error?: string }; message?: string };
  return e?.data?.error || e?.message || 'unknown_error';
}

/** Every member of the channel, or null when the bot can't read them. */
async function readMembersOnce(slack: LinkSlackClient, channel: string): Promise<string[] | null> {
  const out: string[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 50; page++) {
      const res = await slack.conversations.members({ channel, limit: 1000, ...(cursor ? { cursor } : {}) });
      out.push(...(res.members ?? []));
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) return out;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * [S2 fallback] For a public channel termag hasn't joined, joins first when
 * the members can't be read otherwise. Returns null when they still can't.
 */
async function readMembers(slack: LinkSlackClient, info: SlackChannelInfo, channel: string, allowJoin = true): Promise<{ members: string[] | null; joined: boolean }> {
  const members = await readMembersOnce(slack, channel);
  if (members || !allowJoin || info.is_private || info.is_member) return { members, joined: false };
  try {
    await slack.conversations.join({ channel });
  } catch {
    return { members: null, joined: false };
  }
  return { members: await readMembersOnce(slack, channel), joined: true };
}

interface OwnerCheck { space: SpaceRecord; spaceSlack: SpaceSlackRow | null; firstLink: boolean; limits: SpaceSlackLimits }

async function checkOwner(deps: LinkDeps, spaceName: string, actor: LinkActor): Promise<OwnerCheck | LinkRefused> {
  if (!await deps.channelsEnabled(actor.userId)) return refuse('space_channels_off');
  const space = await deps.spaces.findSpace(spaceName);
  const members = space ? await deps.spaces.memberRoles(space.id) : new Map();
  const access = space ? resolveSpaceAccess({ kind: 'user', userId: actor.userId }, { space, members, grantedBoxIds: new Set() }) : null;
  // A non-member gets the space's own not-found, so names don't leak.
  if (!space || !access) return refuse('space_not_found', { spaceName });
  if (!canManage(access)) return refuse('not_owner', { spaceName: space.name });
  const spaceSlack = await deps.store.spaceSlack(space.id);
  const firstLink = !spaceSlack || !!spaceSlack.disabledAt;
  const runner = firstLink ? actor.userId : spaceSlack!.runnerUserId;
  const limits = await deps.limitsFor(runner, spaceSlack?.limits ?? null);
  return { space, spaceSlack, firstLink, limits };
}

async function checkCap(deps: LinkDeps, o: OwnerCheck, isPrivate: boolean): Promise<LinkRefused | null> {
  if (isPrivate && !o.limits.allowPrivate) return refuse('private_not_allowed');
  const count = o.spaceSlack && !o.firstLink ? await deps.store.activeChannelCount(o.spaceSlack.id) : 0;
  if (count >= o.limits.channelsPerSpace) return refuse('too_many_channels', { spaceName: o.space.name, limit: o.limits.channelsPerSpace });
  return null;
}

async function actorSlackId(deps: LinkDeps, actor: LinkActor): Promise<string | null> {
  return actor.slackId ?? (await deps.store.slackIdsOf([actor.userId])).get(actor.userId) ?? null;
}

const botIds = new WeakMap<object, Promise<string | null>>();

/**
 * termag's own Slack user: the entry point's (`deps.botUserId`, from Bolt's
 * context), else the bot token's `auth.test`, asked once per client, so the
 * web and CLI entry points don't count termag as a bystander.
 */
async function botUserIdOf(deps: LinkDeps): Promise<string | null> {
  if (deps.botUserId) return deps.botUserId;
  const slack = deps.slack;
  if (!slack?.auth) return null;
  let id = botIds.get(slack);
  if (!id) {
    id = slack.auth.test().then(r => r.user_id ?? null, () => null);
    botIds.set(slack, id);
  }
  return id;
}

/** Channel members who aren't the space's mapped members, termag, or the actor (whose id may not be mapped yet). */
async function bystanderCount(deps: LinkDeps, spaceId: string, members: string[], actorSlackId: string | null): Promise<number> {
  const roles = await deps.spaces.memberRoles(spaceId);
  const mapped = new Set((await deps.store.slackIdsOf([...roles.keys()])).values());
  const bot = await botUserIdOf(deps);
  return members.filter(id => id !== bot && id !== actorSlackId && !mapped.has(id)).length;
}

/** What a commit enabled, so it can complete the enable after the claim, or undo it. */
interface Activation { spaceSlack: SpaceSlackRow; created: boolean; input: EnableInput; enableDeps: EnableDeps }

/**
 * The first link turns Slack on for the space (enable.ts), the actor as
 * runner: only the row here. The `slack.enable` event and the project wait
 * for a successful channel claim (finishLink), and an activation whose claim
 * fails is released, so a refused link never leaves Slack on with no channel.
 * A later link passes the existing row, so its project step can resume.
 */
async function activate(deps: LinkDeps, o: OwnerCheck, input: LinkInput): Promise<Activation | LinkRefused> {
  const enableDeps: EnableDeps = { spaces: deps.spaces, slack: deps.store, ensureOrchestratorProject: deps.ensureOrchestratorProject };
  const enableInput: EnableInput = { spaceId: o.space.id, actorUserId: input.actor.userId, box: input.runner?.box ?? DEFAULT_RUNNER_BOX, via: input.via };
  if (!o.firstLink) return { spaceSlack: o.spaceSlack!, created: false, input: enableInput, enableDeps };
  const res = await activateSpaceSlack(enableDeps, enableInput);
  if (res.kind === 'refused') return refuse(res.code);
  return { spaceSlack: res.spaceSlack, created: res.created, input: enableInput, enableDeps };
}

/** The first link's runner box, checked before anything is created in Slack. */
async function runnerBoxProblem(deps: LinkDeps, o: OwnerCheck, input: LinkInput): Promise<LinkRefused | null> {
  const box = input.runner?.box;
  if (!o.firstLink || !box || !('existing' in box)) return null;
  const found = await deps.spaces.box(box.existing);
  return !found || found.userId !== input.actor.userId || GONE_BOX_STATUSES.has(found.status) ? refuse('runner_no_box') : null;
}

function confirmationBlocks(spaceName: string, linkedBySlackId: string | null) {
  const by = linkedBySlackId ? ` by <@${linkedBySlackId}>` : '';
  const text = `This channel is now linked to the termag space *${spaceName}*${by}.`;
  const button = (label: string, actionId: string) => ({ type: 'button', text: { type: 'plain_text', text: label }, action_id: actionId, value: spaceName });
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      // Handled by later milestones (M5c's App Home flows, M8, M9); until then a click does nothing.
      { type: 'actions', elements: [button('Files', 'space_channel_files'), button('Status', 'space_channel_status'), button('New request', 'space_channel_new_request')] },
    ],
  };
}

async function finishLink(deps: LinkDeps, args: {
  space: SpaceRecord; activation: Activation; channelId: string; teamId: string; name: string; isPrivate: boolean;
  createdByTermag: boolean; actor: LinkActor; slackId: string | null; via: LinkVia; freeze: boolean;
}): Promise<LinkResult> {
  const linkedVia = args.createdByTermag ? 'create' : args.via;
  const { activation } = args;
  const row = await deps.store.claimChannel({
    channelId: args.channelId, teamId: args.teamId, spaceSlackId: activation.spaceSlack.id, name: args.name,
    isPrivate: args.isPrivate, createdByTermag: args.createdByTermag, linkedById: args.actor.userId, linkedVia,
  });
  if (!row) {
    // Another link won the race: the same space is a no-op, anything else is refused.
    // An activation this link made, and that never got a channel, is undone.
    const released = activation.created ? await deps.store.releaseSpaceSlack(activation.spaceSlack.id) : false;
    const existing = await deps.store.channel(args.channelId);
    const owner = existing && !existing.unlinkedAt ? await deps.store.spaceSlackById(existing.spaceSlackId) : null;
    if (existing && owner?.spaceId === args.space.id) {
      // A double submit: the winner reused the row this link created (so it
      // couldn't be released), and only the creator completes the enable.
      if (activation.created && !released) await completeEnable(activation.enableDeps, activation.input, activation);
      if (args.freeze) await (deps.freezer ?? noThreadFreezer).freezeAtLink(args.channelId, args.space.name, (deps.now ?? (() => new Date()))(), { repeat: true });
      return { kind: 'linked', channel: existing, already: true };
    }
    return refuse('channel_linked');
  }
  // The channel is claimed: now the enable's audit event and project (or the project's retry).
  await completeEnable(activation.enableDeps, activation.input, activation);
  await deps.spaces.recordEvent({
    spaceId: args.space.id, actorUserId: args.actor.userId, action: 'slack.channel_link', surface: 'slack',
    note: `linkedVia=${linkedVia}${args.createdByTermag ? `; from=${args.via}` : ''}; channel=${args.channelId}; name=#${args.name}`,
  });
  if (deps.slack) {
    try {
      const posted = await deps.slack.chat.postMessage({ channel: args.channelId, ...confirmationBlocks(args.space.name, args.slackId) });
      if (posted.ts) await deps.store.setConfirmTs(args.channelId, posted.ts);
    } catch (err) {
      // The link stands; only the message is missing.
      console.error(`[SPACE-SLACK] Posting the link confirmation in ${args.channelId} failed:`, slackErrorOf(err));
    }
  }
  if (args.freeze) await (deps.freezer ?? noThreadFreezer).freezeAtLink(args.channelId, args.space.name, (deps.now ?? (() => new Date()))());
  return { kind: 'linked', channel: row, already: false };
}

async function linkCreate(deps: LinkDeps, input: LinkInput, o: OwnerCheck): Promise<LinkResult> {
  const create = input.create!;
  const capped = await checkCap(deps, o, create.private);
  if (capped) return capped;
  const rule = spaceChannelNameProblem(create.name);
  if (rule) return refuse('name_invalid', { error: spaceChannelNameRuleText(rule) });
  const ownerSlackId = await actorSlackId(deps, input.actor);
  if (!ownerSlackId) return refuse('actor_not_in_slack');
  if (input.mode === 'preview') {
    return { kind: 'preview', bystanders: 0, needsInvite: false, firstLink: o.firstLink, channelName: create.name, isPrivate: create.private };
  }
  if (!deps.slack) return refuse('slack_error', { error: 'slack_not_configured' });
  const badBox = await runnerBoxProblem(deps, o, input);
  if (badBox) return badBox;

  let inviteSlackIds: string[] = [];
  if (create.inviteMembers) {
    const roles = await deps.spaces.memberRoles(o.space.id);
    inviteSlackIds = [...(await deps.store.slackIdsOf([...roles.keys()])).values()];
  }
  const made = await createSpaceChannel({ name: create.name, private: create.private, ownerSlackId, inviteSlackIds }, deps.slack);
  // Slack refused (name_taken, restricted_action, …): nothing was enabled.
  if (!made.ok) return refuse(made.code, { suggestion: made.suggestion, error: made.error });
  const archiveMade = () => deps.slack!.conversations.archive({ channel: made.channelId })
    .catch(err => console.error(`[SPACE-SLACK] Archiving unlinked new channel ${made.channelId} failed:`, slackErrorOf(err)));
  const activation = await activate(deps, o, input);
  if ('kind' in activation) { await archiveMade(); return activation; }

  await deps.spaces.recordEvent({
    spaceId: o.space.id, actorUserId: input.actor.userId, action: 'slack.channel_create', surface: 'slack',
    note: `linkedVia=create; from=${input.via}; channel=${made.channelId}; name=#${create.name}; private=${create.private}; invited=${made.invited.length}; failedInvites=${made.failedInvites.length}`,
  });
  const res = await finishLink(deps, {
    space: o.space, activation, channelId: made.channelId, teamId: input.teamId ?? '', name: create.name, isPrivate: create.private,
    createdByTermag: true, actor: input.actor, slackId: ownerSlackId, via: input.via, freeze: false,
  });
  if (res.kind === 'refused') { await archiveMade(); return res; }
  return res.kind === 'linked' ? { ...res, failedInvites: made.failedInvites } : res;
}

async function linkExisting(deps: LinkDeps, input: LinkInput, o: OwnerCheck): Promise<LinkResult> {
  const channelId = input.channelId!;
  if (/^D/.test(channelId)) return refuse('channel_dm');
  if (!deps.slack) return refuse('slack_error', { error: 'slack_not_configured' });

  // A private channel termag isn't in is invisible to the bot (channel_not_found).
  let info: SlackChannelInfo | null = null;
  try {
    info = (await deps.slack.conversations.info({ channel: channelId })).channel ?? null;
  } catch (err) {
    const error = slackErrorOf(err);
    if (error !== 'channel_not_found' && error !== 'not_in_channel') return refuse('slack_error', { error });
  }

  if (info) {
    if (info.is_im || info.is_mpim) return refuse('channel_dm');
    if (info.name && isWorkstreamChannelName(info.name)) return refuse('channel_workstream');
    if (info.is_ext_shared) return refuse('channel_ext_shared');
    // Slack refuses posts in an archived channel, so it could never answer there.
    if (info.is_archived) return refuse('channel_archived');
  }

  const isPrivate = info ? !!info.is_private : true;

  // What check 5 will answer, read now so that nothing before it can join a
  // channel that is already linked (the S2 fallback); the answer itself waits
  // for the membership check, so a non-member learns nothing about the link.
  const existing = await deps.store.channel(channelId);
  const linkOwner = existing && !existing.unlinkedAt ? await deps.store.spaceSlackById(existing.spaceSlackId) : null;
  // By space, not by o.spaceSlack: a concurrent first link may have created it since.
  const linkedHere = !!existing && !existing.unlinkedAt && linkOwner?.spaceId === o.space.id;
  const linkedElsewhere = !!existing && !existing.unlinkedAt && !linkedHere;

  // 6 (and the commit's runner box) need only the database, so they too run
  // before 3 can join: a refused link never adds termag to a channel. Not for
  // the same-space no-op, which a full space must still answer.
  if (!linkedHere && !linkedElsewhere) {
    const capped = await checkCap(deps, o, isPrivate);
    if (capped) return capped;
    if (input.mode === 'commit') {
      const badBox = await runnerBoxProblem(deps, o, input);
      if (badBox) return badBox;
    }
  }

  // 3: the actor is in the channel (and the members, for the bystanders).
  const visible = !!info && (!isPrivate || !!info.is_member);
  let members: string[] | null = null;
  let joined = false;
  if (visible) {
    ({ members, joined } = await readMembers(deps.slack, info!, channelId, !linkedHere && !linkedElsewhere));
    if (SLACK_ENTRY_POINTS.has(input.via) || isPrivate) {
      const slackId = await actorSlackId(deps, input.actor);
      if (!slackId) return refuse('actor_not_in_slack');
      if (!members) return refuse('slack_error', { error: 'members_unreadable' });
      if (!members.includes(slackId)) return refuse('not_in_channel');
    }
  }

  // 5: one space per channel; the same space again is a no-op, whose commit
  // repeats the freeze in case the first link's failed after the claim.
  if (linkedHere) {
    if (input.mode === 'commit') await (deps.freezer ?? noThreadFreezer).freezeAtLink(channelId, o.space.name, (deps.now ?? (() => new Date()))(), { repeat: true });
    return { kind: 'linked', channel: existing!, already: true };
  }
  if (linkedElsewhere) return refuse('channel_linked');

  // 7: termag in the channel, or able to join.
  const needsInvite = !visible;
  if (input.mode === 'preview') {
    return {
      kind: 'preview', needsInvite, firstLink: o.firstLink, channelName: info?.name ?? null, isPrivate,
      bystanders: members ? await bystanderCount(deps, o.space.id, members, await actorSlackId(deps, input.actor)) : null,
    };
  }
  if (needsInvite) return refuse('needs_invite', { spaceName: o.space.name });
  if (!info!.is_member && !joined) {
    try {
      await deps.slack.conversations.join({ channel: channelId });
    } catch (err) {
      return refuse('slack_error', { error: slackErrorOf(err) });
    }
  }

  const activation = await activate(deps, o, input);
  if ('kind' in activation) return activation;
  return finishLink(deps, {
    space: o.space, activation, channelId, teamId: input.teamId ?? info!.context_team_id ?? '', name: info!.name ?? channelId,
    isPrivate, createdByTermag: false, actor: input.actor, slackId: await actorSlackId(deps, input.actor), via: input.via, freeze: true,
  });
}

/** Preview, then commit, a link of an existing channel (or a new one, `create`) to a space. */
export async function link(deps: LinkDeps, input: LinkInput): Promise<LinkResult> {
  const o = await checkOwner(deps, input.spaceName, input.actor);
  if ('kind' in o) return o;
  if (input.create) return linkCreate(deps, input, o);
  if (!input.channelId) return refuse('not_linked');
  return linkExisting(deps, input, o);
}

/** Preview, then commit, unlinking a channel; `actor: null` is termag itself (archived, removed, …). */
export async function unlink(deps: LinkDeps, input: UnlinkInput): Promise<UnlinkResult> {
  const row = await deps.store.channel(input.channelId);
  if (row?.unlinkedAt && input.mode === 'commit') {
    // A retry after an unlink whose freeze failed: an unlinked channel's space
    // threads must all be frozen, so freezing them again is always right.
    await (deps.freezer ?? noThreadFreezer).freezeAtUnlink(input.channelId, row.name, (deps.now ?? (() => new Date()))());
  }
  const spaceSlack = row && !row.unlinkedAt ? await deps.store.spaceSlackById(row.spaceSlackId) : null;
  const space = spaceSlack ? await deps.spaces.findSpace(spaceSlack.spaceId) : null;
  if (!row || row.unlinkedAt || !spaceSlack) return refuse('not_linked');
  const spaceName = space?.name ?? spaceSlack.spaceId;

  if (input.actor) {
    if (!space) return refuse('not_linked');
    const o = await checkOwner(deps, space.name, input.actor);
    if ('kind' in o) return o;
    if (SLACK_ENTRY_POINTS.has(input.via as LinkVia) && deps.slack) {
      const slackId = await actorSlackId(deps, input.actor);
      const members = await readMembersOnce(deps.slack, input.channelId);
      if (!slackId) return refuse('actor_not_in_slack');
      // Unreadable members (a rate limit, termag not in it) is Slack's failure, not the owner's absence, as in link().
      if (!members) return refuse('slack_error', { error: 'members_unreadable' });
      if (!members.includes(slackId)) return refuse('not_in_channel');
    }
  }

  const freezer = deps.freezer ?? noThreadFreezer;
  if (input.mode === 'preview') {
    return { kind: 'preview', spaceName, channelName: row.name, threads: await freezer.spaceThreadCount(input.channelId), canArchive: row.createdByTermag };
  }

  const now = (deps.now ?? (() => new Date()))();
  const done = await deps.store.markUnlinked(input.channelId, input.reason, now);
  if (!done) return refuse('not_linked');
  await deps.spaces.recordEvent({
    spaceId: spaceSlack.spaceId, actorUserId: input.actor?.userId ?? 'system', action: 'slack.channel_unlink', surface: 'slack',
    note: `linkedVia=${input.via}; reason=${input.reason}; channel=${input.channelId}; name=#${row.name}`,
  });
  // termag can't post where it was removed, nor in an archived channel.
  if (deps.slack && input.reason !== 'removed' && input.reason !== 'archived') {
    await deps.slack.chat.postMessage({ channel: input.channelId, text: `This channel is no longer linked to the termag space *${spaceName}*.` })
      .catch(err => console.error(`[SPACE-SLACK] Posting the unlink notice in ${input.channelId} failed:`, slackErrorOf(err)));
  }
  await freezer.freezeAtUnlink(input.channelId, spaceName, now);

  let archived = false;
  if (input.archive && row.createdByTermag && deps.slack && input.reason !== 'archived' && input.reason !== 'removed') {
    try {
      await deps.slack.conversations.archive({ channel: input.channelId });
      archived = true;
    } catch (err) {
      console.error(`[SPACE-SLACK] Archiving ${input.channelId} after unlink failed:`, slackErrorOf(err));
    }
  }
  return { kind: 'unlinked', channel: done, spaceName, archived };
}
