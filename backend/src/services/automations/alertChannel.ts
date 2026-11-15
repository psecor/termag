/**
 * The save-time check of an alert's Slack channel
 * ("Alerts and the outbound webhook"; review on #1572): a channel id
 * is only a target when the owner is a member of the channel and the bot can
 * post there. Without it, one user could point their alerts, with a summary
 * they steer through the prompt, at someone else's channel the bot happens
 * to be in. The owner's Slack user is found as their DMs find it
 * (dmChannelOf: the linked id, else a lookup by email); the members are read
 * as spaces' Slack links read them (conversations.members). It all goes
 * through a bounded client (slackPost.ts withBoundedSlack: retries off, a 429
 * rejected, CHANNEL_CHECK_DEADLINE_MS in all), so a Slack outage or rate
 * limit makes a save answer "try again" at once instead of hanging on the
 * app client's retries.
 */
import { prisma } from '../../db';
import { getSlackApp } from '../../slack/app';
import { appBoundedClient, withBoundedSlack } from './slackPost';

export interface AlertChannelClient {
  auth: { test(): Promise<{ user_id?: string }> };
  conversations: { members(args: { channel: string; limit?: number; cursor?: string }): Promise<{ members?: string[]; response_metadata?: { next_cursor?: string } }> };
  users: { lookupByEmail(args: { email: string }): Promise<{ user?: { id?: string } }> };
}

export type AlertChannelRefusal = { ok: false; code: string; error: string };

const MAX_PAGES = 50;

/** The whole save-time check, every Slack call in it, stops here and is refused as unchecked. */
export const CHANNEL_CHECK_DEADLINE_MS = 5_000;

/**
 * The owner's Slack id: the linked one, else a lookup by email, linked for
 * next time. Unlike briefing/slack.ts slackIdFor, which reads every failure
 * as "no user", only no email or Slack's `users_not_found` is null; any other
 * failure (a 5xx, a rate limit, the network) throws, so a DM alert is retried
 * (notices.ts) and a save is told to try again.
 */
export async function dmChannelOf(client: Pick<AlertChannelClient, 'users'>, owner: { id: string; slackUserId: string | null; googleEmail: string }): Promise<string | null> {
  if (owner.slackUserId) return owner.slackUserId;
  if (!owner.googleEmail) return null;
  let id: string | undefined;
  try {
    id = (await client.users.lookupByEmail({ email: owner.googleEmail })).user?.id;
  } catch (err) {
    if ((err as { data?: { error?: string } }).data?.error === 'users_not_found') return null;
    throw err;
  }
  if (!id) return null;
  await prisma.user.update({ where: { id: owner.id }, data: { slackUserId: id } }).catch(() => {});
  return id;
}

/**
 * Whether `userId` is a member of `channel`, reading pages of members only
 * until it is found. Throws Slack's error when the members can't be read.
 * Delivery asks it before every post to a channel id (notices.ts), so an
 * owner who left the channel after saving it stops the alerts there.
 */
export async function isChannelMember(client: Pick<AlertChannelClient, 'conversations'>, channel: string, userId: string): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.conversations.members({ channel, limit: 1000, ...(cursor ? { cursor } : {}) });
    if ((res.members ?? []).includes(userId)) return true;
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) return false;
  }
  return false;
}

/** The channel's members, or the Slack error code that kept them from being read. */
async function membersOf(client: AlertChannelClient, channel: string): Promise<{ members: Set<string> } | { error: string }> {
  const members = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.conversations.members({ channel, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const m of res.members ?? []) members.add(m);
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return { members };
  } catch (err) {
    return { error: (err as { data?: { error?: string } }).data?.error ?? (err as Error).message };
  }
}

/**
 * Whether `owner` may send alerts to `channel`: Slack is set up, the owner
 * has a Slack user the bot can find, the bot is in the channel (so it can
 * post) and so is the owner. A refusal says which and what to do.
 */
export async function checkAlertChannel(
  owner: { id: string; slackUserId: string | null; googleEmail: string },
  channel: string,
  client?: AlertChannelClient | null,
  deadlineMs: number = CHANNEL_CHECK_DEADLINE_MS,
): Promise<{ ok: true } | AlertChannelRefusal> {
  const slackOff: AlertChannelRefusal = { ok: false, code: 'alert_slack_off', error: 'This termag has no Slack app, so alerts can\'t go to a Slack channel' };
  if (client === null) return slackOff;
  if (client) return checkWith(owner, channel, client);
  const appClient = getSlackApp()?.client;
  const bounded = appClient ? appBoundedClient(appClient) : null;
  if (!bounded) return slackOff;
  const r = await withBoundedSlack(deadlineMs, bounded, c => checkWith(owner, channel, c as unknown as AlertChannelClient));
  if (r.ok) return r.value;
  return { ok: false, code: 'alert_channel_unchecked', error: `Slack ${r.deadline ? `didn't answer within ${Math.round(deadlineMs / 1000)} s` : `failed (${r.error})`}, so channel ${channel} can't be checked; try again` };
}

async function checkWith(owner: { id: string; slackUserId: string | null; googleEmail: string }, channel: string, client: AlertChannelClient): Promise<{ ok: true } | AlertChannelRefusal> {
  let ownerSlackId: string | null;
  try {
    ownerSlackId = await dmChannelOf(client, owner);
  } catch (err) {
    // A rate limit, a 5xx, the network: not "no such user".
    const code = (err as { data?: { error?: string } }).data?.error ?? (err as Error).message;
    return { ok: false, code: 'alert_channel_unchecked', error: `Slack couldn't look up your Slack user (${code}), so channel ${channel} can't be checked; try again` };
  }
  if (!ownerSlackId) {
    return { ok: false, code: 'alert_channel_owner_unknown', error: 'termag can\'t find your Slack user (it looks you up by your email), so it can\'t check that you\'re in that channel' };
  }
  // Fail closed: without the bot's own id there is no telling whether it can post there.
  const botId = await client.auth.test().then(r => r.user_id ?? null, () => null);
  if (!botId) return { ok: false, code: 'alert_channel_unchecked', error: "Slack didn't say who termag's bot is (auth.test), so the channel can't be checked; try again" };
  const read = await membersOf(client, channel);
  if ('error' in read) {
    if (read.error === 'channel_not_found' || read.error === 'not_in_channel') {
      return { ok: false, code: 'alert_channel_bot_absent', error: `termag's Slack bot isn't in channel ${channel} (or it doesn't exist): invite the bot there first` };
    }
    return { ok: false, code: 'alert_channel_unchecked', error: `Slack couldn't list channel ${channel}'s members (${read.error}); try again` };
  }
  if (!read.members.has(botId)) {
    return { ok: false, code: 'alert_channel_bot_absent', error: `termag's Slack bot isn't in channel ${channel}: invite the bot there first` };
  }
  if (!read.members.has(ownerSlackId)) {
    return { ok: false, code: 'alert_channel_not_member', error: `You aren't a member of channel ${channel}; alerts go only to a channel you're in` };
  }
  return { ok: true };
}
