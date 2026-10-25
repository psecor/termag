/**
 * Who may drive termag from Slack: `/t`, DMs and @mentions (deploy/setup.md §7).
 *
 * Two sources, merged. The boolean flag `slack-bot-enabled`, read for the
 * termag user the Slack account maps to by email (userMapping.ts), and
 * `ALLOWED_SLACK_USERS`, a fixed list of Slack user ids that get in whatever
 * the flag says (the only source while TERMAG_FLAGS does not set the flag). Anyone
 * in neither is refused, including a Slack account with no termag user that is
 * not listed, and everyone not listed while the flag is unset: the DM
 * executor runs `claude` as the backend's own user, so the gate fails
 * closed.
 *
 * Getting in is not reaching everything. slackProjectAccess decides which
 * projects a `/t` may type into, and slackChatAllowed keeps DMs and @mentions
 * (the executor) to the list.
 */

import type { WebClient } from '@slack/web-api';
import { boolVariation } from '../services/featureFlags';
import { projectSessionAccess, SessionAccessError } from '../services/sessionAccess';
import { isKnownMiss, resolveTermagUser } from './userMapping';

export const SLACK_BOT_FLAG = 'slack-bot-enabled';

/**
 * The Slack user ids in ALLOWED_SLACK_USERS (empty when unset). Entries are
 * documented as `slackId:unixuser`; the unix half is informational and dropped.
 */
export function allowedSlackUsers(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map(entry => entry.split(':')[0].trim()).filter(Boolean));
}

export async function slackUserAllowed(
  slackUserId: string,
  client: WebClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return (await slackUserRefusal(slackUserId, client, env)) === null;
}

/**
 * Why slackUserAllowed says no, or null when it says yes. 'lookup-failed' is a
 * Slack account the mapping could not check (Slack's call failed), so nothing
 * is known about its termag account.
 */
export type SlackRefusal = 'no-termag-user' | 'lookup-failed' | 'flag-off';

export async function slackUserRefusal(
  slackUserId: string,
  client: WebClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SlackRefusal | null> {
  if (allowedSlackUsers(env.ALLOWED_SLACK_USERS).has(slackUserId)) return null;
  const user = await resolveTermagUser(slackUserId, client);
  if (!user) return isKnownMiss(slackUserId) ? 'no-termag-user' : 'lookup-failed';
  return (await boolVariation(SLACK_BOT_FLAG, user, false)) ? null : 'flag-off';
}

/** Where people ask for the flag. */
export const SLACK_ACCESS_CHANNEL = '#termag-help';

/**
 * The reply a refused `/t` gets, shown only to them. A Slack account that
 * maps to no termag user is told so, since the flag is read for that user;
 * one whose lookup failed is told to try again, not that it has no account.
 */
export function slackRefusalText(refusal: SlackRefusal): string {
  switch (refusal) {
    case 'no-termag-user':
      return `You don't have access to termag's \`/t\` yet, and termag has no account with your Slack email. Sign in to termag with that email, then ask for access in ${SLACK_ACCESS_CHANNEL}.`;
    case 'lookup-failed':
      return `termag couldn't check your access just now. Try again in a minute; if it keeps happening, ask in ${SLACK_ACCESS_CHANNEL}.`;
    case 'flag-off':
      return `You don't have access to termag's \`/t\` yet. Ask for access in ${SLACK_ACCESS_CHANNEL}.`;
  }
}

/** What a `/t` from one Slack account may reach (slackProjectAccess). */
export interface SlackProjectAccess {
  /** Listed in ALLOWED_SLACK_USERS: every project, and the local sessions. */
  unscoped: boolean;
  /** Whether a `/t` may drive this project. null is a session no project builds. */
  mayReach(projectId: string | null): Promise<boolean>;
}

/**
 * Which projects a `/t` from this Slack account may drive. An id in
 * ALLOWED_SLACK_USERS keeps the routing the bot always had: a channel, a
 * project name or a tmux session name picks any project, and `/t local`
 * reaches the Mac daemon's one shared queue (lts.ts). Everyone the flag lets
 * in reaches only projects their termag user owns or was shared
 * (projectSessionAccess, the web and terminal sockets' check), and no local
 * sessions: `/t` types into an agent or ctrl pane and presses Enter, which is
 * the owner's authority on the owner's box.
 */
export function slackProjectAccess(
  slackUserId: string,
  termagUserId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): SlackProjectAccess {
  if (allowedSlackUsers(env.ALLOWED_SLACK_USERS).has(slackUserId)) {
    return { unscoped: true, mayReach: async () => true };
  }
  return {
    unscoped: false,
    mayReach: async projectId => {
      if (!termagUserId || !projectId) return false;
      try {
        await projectSessionAccess(termagUserId, projectId);
        return true;
      } catch (err) {
        if (err instanceof SessionAccessError) return false;
        throw err;
      }
    },
  };
}

/**
 * Whether a DM or @mention may reach the executor (executor.ts), which runs
 * `claude --permission-mode bypassPermissions` as the backend's own user, with
 * its environment: only the ids in ALLOWED_SLACK_USERS. The flag's
 * people get `/t` into their own projects, not the orchestrator's identity.
 */
export function slackChatAllowed(slackUserId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return allowedSlackUsers(env.ALLOWED_SLACK_USERS).has(slackUserId);
}

/** One line for the startup log: where access comes from. */
export function describeSlackGate(env: NodeJS.ProcessEnv = process.env): string {
  const listed = allowedSlackUsers(env.ALLOWED_SLACK_USERS).size;
  const flag = `${SLACK_BOT_FLAG} per termag user (/t into their own projects)`;
  return listed > 0
    ? `${flag}, plus ${listed} id${listed === 1 ? '' : 's'} in ALLOWED_SLACK_USERS (any project, DMs and @mentions)`
    : `${flag}; DMs and @mentions answer nobody without ALLOWED_SLACK_USERS`;
}
