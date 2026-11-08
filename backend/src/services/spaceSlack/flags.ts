/**
 * The gates of spaces in Slack, each read
 * for one person:
 *
 * - `space-channels-enabled` covers linking from every entry point (Slack, the
 *   API and the CLI), the orchestrator, and space files from Slack; read for
 *   the space's runner and for the person acting.
 * - `slack-router-enabled`: DMs and @mentions outside space channels go
 *   through the router; read for the person writing.
 * - `slack-router-overview-enabled` needs `slack-router-enabled` as well.
 *
 * `slack-agent-enabled` and ALLOWED_SLACK_USERS keep gating only the personal
 * (operator) scope; they are not read here.
 */
import { boolVariation } from '../featureFlags';
import type { FlagUser } from '../featureFlags';

export async function spaceChannelsEnabled(user: FlagUser): Promise<boolean> {
  return boolVariation('space-channels-enabled', user, false);
}

export async function slackRouterEnabled(user: FlagUser): Promise<boolean> {
  return boolVariation('slack-router-enabled', user, false);
}

/** The router's own cross-space overview: only where the router is on too. */
export async function slackRouterOverviewEnabled(user: FlagUser): Promise<boolean> {
  return await slackRouterEnabled(user) && boolVariation('slack-router-overview-enabled', user, false);
}
