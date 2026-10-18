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
