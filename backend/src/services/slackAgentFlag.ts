/**
 * Whether a Slack user's messages take the agent-session path (slack/agentTurn.ts):
 * the boolean flag `slack-agent-enabled`, off by default and
 * whenever flags are. The Slack app must also be declared an agent
 * (slack/agentSession.ts isAgentApp); with either off, DMs and @mentions answer
 * as before. Evaluated for the termag user the Slack user maps to by email.
 */
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';

export const SLACK_AGENT_FLAG = 'slack-agent-enabled';

export async function slackAgentEnabled(user: FlagUser | null): Promise<boolean> {
  return user ? boolVariation(SLACK_AGENT_FLAG, user, false) : false;
}
