/**
 * The Slack workspace a pre-registered Slack client's sign-in is pinned to.
 * The client is the termag
 * Slack app, which stays undistributed, and Slack refuses to authorize an
 * undistributed app on any workspace but its own
 * (`invalid_team_for_non_distributed_app`). Without `team` on the authorize
 * URL, Slack picks the workspace from whatever Slack session the browser has,
 * so the pin is what sends the user to the app's workspace.
 *
 * The workspace is the entry's `team` in MCP_OAUTH_CLIENTS when it names one,
 * else the bot's own (auth.test with the bot token, once per process): the
 * bot and the MCP client are the same app, so they share a workspace.
 */

import type { DiscoveredOAuth, OAuthClient, PreregisteredClient } from './mcpOAuth';
import { SLACK_TEAM } from './mcpOAuth';

type AuthTest = { auth: { test: () => Promise<{ team_id?: string }> } };

let botTeam: string | null = null;

/** Slack's authorize endpoint: slack.com itself, where team pinning means something. */
function isSlack(d: DiscoveredOAuth): boolean {
  try {
    return new URL(d.authorizationEndpoint).hostname === 'slack.com';
  } catch {
    return false;
  }
}

/**
 * The `team` for this sign-in's authorize URL, or undefined for none: only a
 * pre-registered client at Slack is pinned. A failed auth.test pins nothing
 * (the sign-in goes ahead as before) and is tried again on the next sign-in.
 */
export async function authorizeTeam(
  d: DiscoveredOAuth,
  client: OAuthClient,
  pre: PreregisteredClient | null,
  slack: () => AuthTest | null | undefined,
): Promise<string | undefined> {
  if (client.via !== 'preregistered' || !isSlack(d)) return undefined;
  if (pre?.team) return pre.team;
  if (botTeam) return botTeam;
  const bot = slack();
  if (!bot) return undefined;
  try {
    const id = (await bot.auth.test()).team_id;
    if (typeof id === 'string' && SLACK_TEAM.test(id)) botTeam = id;
  } catch (err) {
    console.warn('[MCP] Slack auth.test failed, so this sign-in is not pinned to a workspace:', (err as Error).message);
  }
  return botTeam ?? undefined;
}

export function resetSlackTeamForTests(): void {
  botTeam = null;
}
