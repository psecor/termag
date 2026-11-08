/**
 * Slack Channel Management
 *
 * Creates and manages Slack channels for termag projects and workstreams.
 *
 * Naming mirrors tmux session naming minus the role segment, so a channel name
 * is derivable from the same (user, project, workstream) tuple that names the
 * tmux pair:
 *   main workstream:  #proj-<user>-<project>
 *   other workstream: #proj-<user>-<project>-<workstream>
 *
 * The unix username is part of the name because project names are only unique
 * per user — two people can each own a `termag` project. Channels created
 * before the username prefix were `#proj-<project>`; routing still accepts
 * that legacy form (see matchChannelTarget), preferring the invoking user's
 * project when the name is ambiguous.
 */

import { getSlackApp } from './app';

const CHANNEL_PREFIX = 'proj-';
// Slack: lowercase letters, digits, hyphens, underscores; max 80 chars.
const SLACK_CHANNEL_MAX = 80;

function slug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, SLACK_CHANNEL_MAX);
}

/** Canonical channel name for a (user, project, workstream) tuple. */
export function channelNameFor(username: string, projectName: string, workstream: string = 'main'): string {
  return workstream === 'main'
    ? slug(`${CHANNEL_PREFIX}${username}-${projectName}`)
    : slug(`${CHANNEL_PREFIX}${username}-${projectName}-${workstream}`);
}

/** A workstream channel's name (`#proj-…`, canonical or legacy): never a space channel. */
export function isWorkstreamChannelName(name: string): boolean {
  return name.startsWith(CHANNEL_PREFIX);
}

/** Pre-username-prefix channel name (`#proj-<project>`). Read-side only. */
export function legacyChannelNameFor(projectName: string): string {
  return slug(`${CHANNEL_PREFIX}${projectName}`);
}

export interface ChannelProjectLike {
  id: string;
  name: string;
  userId: string;
  user: { unixUsername: string };
  workstreams: { name: string }[];
}

/**
 * Pure: map a Slack channel name to a (project, workstream). Never parses the
 * name — it rebuilds the canonical name for every candidate tuple and compares,
 * so dashes in usernames, project names and workstream names are all fine.
 *
 * Order: canonical `#proj-<user>-<project>[-<workstream>]` first, then the
 * legacy `#proj-<project>` form (main workstream). Within each form the
 * invoking user's projects win, since legacy names aren't globally unique.
 */
export function matchChannelTarget(
  channelName: string,
  projects: ChannelProjectLike[],
  preferUserId?: string,
): { projectId: string; workstream: string } | null {
  if (!channelName.startsWith(CHANNEL_PREFIX)) return null;
  const ordered = preferUserId
    ? [...projects.filter(p => p.userId === preferUserId), ...projects.filter(p => p.userId !== preferUserId)]
    : projects;

  for (const p of ordered) {
    const wsNames = p.workstreams.length ? p.workstreams.map(w => w.name) : ['main'];
    if (!wsNames.includes('main')) wsNames.unshift('main');
    for (const ws of wsNames) {
      if (channelName === channelNameFor(p.user.unixUsername, p.name, ws)) {
        return { projectId: p.id, workstream: ws };
      }
    }
  }
  for (const p of ordered) {
    if (channelName === legacyChannelNameFor(p.name)) {
      return { projectId: p.id, workstream: 'main' };
    }
  }
  return null;
}

export interface CreateChannelOpts {
  username: string;
  projectName: string;
  workstream?: string;
  creatorSlackUserId?: string;
}

/**
 * Create the Slack channel for a project workstream and return its ID.
 * If the channel already exists, joins it and returns its ID.
 * Returns null if Slack is not configured or the call fails.
 */
export async function createChannelFor(opts: CreateChannelOpts): Promise<string | null> {
  const slackApp = getSlackApp();
  if (!slackApp) return null;

  const workstream = opts.workstream ?? 'main';
  const channelName = channelNameFor(opts.username, opts.projectName, workstream);
  const topic = workstream === 'main'
    ? `termag project: ${opts.username}/${opts.projectName}`
    : `termag project: ${opts.username}/${opts.projectName} @ ${workstream}`;

  try {
    const result = await slackApp.client.conversations.create({
      name: channelName,
      is_private: false,
    });

    const channelId = result.channel?.id;
    if (!channelId) return null;

    await slackApp.client.conversations.setTopic({ channel: channelId, topic }).catch(() => {});

    // Invite the creator if we know their Slack user ID
    if (opts.creatorSlackUserId) {
      await slackApp.client.conversations.invite({
        channel: channelId,
        users: opts.creatorSlackUserId,
      }).catch(() => {}); // may already be a member
    }

    console.log(`[SLACK] Created channel #${channelName} (${channelId})`);
    return channelId;
  } catch (err: unknown) {
    const error = err as { data?: { error?: string } };

    // Channel already exists — find and join it
    if (error.data?.error === 'name_taken') {
      try {
        const list = await slackApp.client.conversations.list({
          types: 'public_channel',
          limit: 1000,
          exclude_archived: true,
        });
        const existing = list.channels?.find((c: any) => c.name === channelName);
        if (existing?.id) {
          await slackApp.client.conversations.join({ channel: existing.id }).catch(() => {});
          if (opts.creatorSlackUserId) {
            await slackApp.client.conversations.invite({
              channel: existing.id,
              users: opts.creatorSlackUserId,
            }).catch(() => {});
          }
          console.log(`[SLACK] Joined existing channel #${channelName} (${existing.id})`);
          return existing.id;
        }
      } catch (listErr) {
        console.error('[SLACK] Failed to find existing channel:', (listErr as Error).message);
      }
    }

    console.error('[SLACK] Channel creation failed:', (err as Error).message);
    return null;
  }
}

/**
 * Back-compat wrapper for project creation (main workstream).
 */
export async function createProjectChannel(
  username: string,
  projectName: string,
  creatorSlackUserId?: string,
): Promise<string | null> {
  return createChannelFor({ username, projectName, creatorSlackUserId });
}

/** Archive a channel (used when a workstream is deleted). Best effort. */
export async function archiveChannel(channelId: string): Promise<void> {
  const slackApp = getSlackApp();
  if (!slackApp) return;
  try {
    await slackApp.client.conversations.archive({ channel: channelId });
    console.log(`[SLACK] Archived channel ${channelId}`);
  } catch (err) {
    console.error('[SLACK] Channel archive failed:', (err as Error).message);
  }
}

// ── Space channels ("Create") ────────────
//
// createSpaceChannel is deliberately not createChannelFor: that one is built for
// workstream channels (a fixed #proj-… name, always public, joins whoever already
// owns a taken name, and loses every other error as null). Joining an existing
// channel here would link someone else's channel to the space, so a taken name is
// refused with a suggestion, and every failure says why.

/** The minimal WebClient surface the space-channel helpers use; tests pass a fake. */
export interface SpaceChannelClient {
  conversations: {
    create(args: { name: string; is_private: boolean }): Promise<{ channel?: { id?: string } }>;
    invite(args: { channel: string; users: string }): Promise<unknown>;
    archive(args: { channel: string }): Promise<unknown>;
    list(args: { types: string; limit: number; exclude_archived: boolean; cursor?: string }):
      Promise<{ channels?: Array<{ name?: string }>; response_metadata?: { next_cursor?: string } }>;
  };
}

export type SpaceChannelNameRule = 'empty' | 'too_long' | 'characters' | 'proj_prefix';

export type CreateSpaceChannelResult =
  | { ok: true; channelId: string; invited: string[]; failedInvites: Array<{ id: string; error: string }> }
  | { ok: false; code: 'name_invalid' | 'name_taken' | 'restricted_action' | 'slack_error'; rule?: SpaceChannelNameRule; suggestion?: string; error?: string };

export interface CreateSpaceChannelOpts {
  name: string;
  private: boolean;
  /** The space owner creating it: invited first, and required. */
  ownerSlackId: string;
  /** The space's mapped members, when the owner chose to invite them. */
  inviteSlackIds?: string[];
}

/** Members per conversations.invite call (Slack allows up to 1000; smaller batches fail less at once). */
export const SPACE_CHANNEL_INVITE_BATCH = 100;

const SPACE_CHANNEL_NAME = /^[a-z0-9_-]+$/;

/** Why a space channel name breaks the rules, or null when it is fine. Checked before Slack is called. */
export function spaceChannelNameProblem(name: string): SpaceChannelNameRule | null {
  if (!name) return 'empty';
  if (name.length > SLACK_CHANNEL_MAX) return 'too_long';
  if (!SPACE_CHANNEL_NAME.test(name)) return 'characters';
  if (name.startsWith(CHANNEL_PREFIX)) return 'proj_prefix';
  return null;
}

/** Text for a broken name rule, for the UI, the CLI and Slack replies. */
export function spaceChannelNameRuleText(rule: SpaceChannelNameRule): string {
  switch (rule) {
    case 'empty': return 'A channel needs a name.';
    case 'too_long': return `A channel name is at most ${SLACK_CHANNEL_MAX} characters.`;
    case 'characters': return 'A channel name uses only lowercase letters, digits, - and _.';
    case 'proj_prefix': return `Names starting with ${CHANNEL_PREFIX} belong to workstream channels; pick another.`;
  }
}

/** The default name for a space's new channel: `space-<spaceName>`. */
export function defaultSpaceChannelName(spaceName: string): string {
  return slug(`space-${spaceName}`);
}

function slackErrorOf(err: unknown): string {
  const e = err as { data?: { error?: string }; message?: string };
  return e?.data?.error || e?.message || 'unknown_error';
}

function withSuffix(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${base.slice(0, SLACK_CHANNEL_MAX - suffix.length)}${suffix}`;
}

/** `<name>-2`, then `-3`, …: the first not among the public channels Slack lists. */
async function suggestFreeName(client: SpaceChannelClient, name: string): Promise<string> {
  const taken = new Set<string>();
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await client.conversations.list({ types: 'public_channel', limit: 1000, exclude_archived: false, ...(cursor ? { cursor } : {}) });
      for (const c of res.channels ?? []) if (c.name) taken.add(c.name);
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch (err) {
    // The suggestion is a hint: a failed list still suggests -2.
    console.error('[SLACK] Listing channels for a name suggestion failed:', slackErrorOf(err));
  }
  for (let n = 2; n < 1000; n++) {
    const candidate = withSuffix(name, n);
    if (!taken.has(candidate)) return candidate;
  }
  return withSuffix(name, Date.now() % 100000);
}

/** Invites one batch; when the batch fails, each member alone, so one bad id doesn't hide the rest. */
async function inviteBatch(client: SpaceChannelClient, channel: string, ids: string[], invited: string[], failed: Array<{ id: string; error: string }>): Promise<void> {
  try {
    await client.conversations.invite({ channel, users: ids.join(',') });
    invited.push(...ids);
    return;
  } catch (err) {
    if (ids.length === 1) {
      const error = slackErrorOf(err);
      if (error === 'already_in_channel') invited.push(ids[0]);
      else failed.push({ id: ids[0], error });
      return;
    }
  }
  for (const id of ids) await inviteBatch(client, channel, [id], invited, failed);
}

/**
 * Create a Slack channel for a space (public by default, private on request),
 * invite its owner (required: a failed owner invite archives the new channel)
 * and then the chosen members in batches. Never joins an existing channel.
 */
export async function createSpaceChannel(
  opts: CreateSpaceChannelOpts,
  client: SpaceChannelClient | null = (getSlackApp()?.client as SpaceChannelClient | undefined) ?? null,
): Promise<CreateSpaceChannelResult> {
  const rule = spaceChannelNameProblem(opts.name);
  if (rule) return { ok: false, code: 'name_invalid', rule, error: spaceChannelNameRuleText(rule) };
  if (!client) return { ok: false, code: 'slack_error', error: 'slack_not_configured' };

  let channelId: string | undefined;
  try {
    const res = await client.conversations.create({ name: opts.name, is_private: opts.private });
    channelId = res.channel?.id;
  } catch (err) {
    const error = slackErrorOf(err);
    if (error === 'name_taken') return { ok: false, code: 'name_taken', suggestion: await suggestFreeName(client, opts.name) };
    if (error === 'restricted_action') return { ok: false, code: 'restricted_action', error };
    if (error.startsWith('invalid_name')) return { ok: false, code: 'name_invalid', error };
    console.error('[SLACK] Space channel creation failed:', error);
    return { ok: false, code: 'slack_error', error };
  }
  if (!channelId) return { ok: false, code: 'slack_error', error: 'no_channel_id' };

  // termag created it, so it is a member; the owner has to be one too.
  try {
    await client.conversations.invite({ channel: channelId, users: opts.ownerSlackId });
  } catch (err) {
    const error = slackErrorOf(err);
    if (error !== 'already_in_channel') {
      await client.conversations.archive({ channel: channelId }).catch(archiveErr => {
        console.error(`[SLACK] Archiving space channel ${channelId} after a failed owner invite failed:`, slackErrorOf(archiveErr));
      });
      return { ok: false, code: 'slack_error', error: `owner_invite_failed: ${error}` };
    }
  }

  const invited = [opts.ownerSlackId];
  const failedInvites: Array<{ id: string; error: string }> = [];
  const rest = [...new Set(opts.inviteSlackIds ?? [])].filter(id => id && id !== opts.ownerSlackId);
  for (let i = 0; i < rest.length; i += SPACE_CHANNEL_INVITE_BATCH) {
    await inviteBatch(client, channelId, rest.slice(i, i + SPACE_CHANNEL_INVITE_BATCH), invited, failedInvites);
  }
  console.log(`[SLACK] Created space channel #${opts.name} (${channelId}, ${opts.private ? 'private' : 'public'}), invited ${invited.length}, ${failedInvites.length} failed`);
  return { ok: true, channelId, invited, failedInvites };
}
