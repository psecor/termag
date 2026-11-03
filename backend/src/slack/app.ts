/**
 * Slack Bolt App Setup
 *
 * Creates and starts the Slack app with Socket Mode.
 * Runs in the same process as the Express server.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { App } = require('@slack/bolt');

import { registerEventHandlers } from './events';
import { describeSlackGate } from './access';
import { loadActiveTargetsOrRetry } from './activeTargets';
import { loadAgentThreadsOrRetry } from './agentStore';
import { acceptAgentRuns, stopAgentRunsForRestart } from './agentSession';
import { slackSurfaceMiddleware } from '../services/requestSurface';
import { slackTraceMiddleware } from '../services/tracing/botSpans';

let slackApp: any = null;

export function createSlackApp(): any {
  // Only the e2e stack's Slack stub (scripts/e2e/fakes/slack-stub.mjs) sets it.
  const slackApiUrl = process.env.SLACK_API_URL?.trim();
  const clientOptions = slackApiUrl ? { slackApiUrl } : undefined;
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    processBeforeResponse: false,
    ...(clientOptions && { clientOptions, installerOptions: { clientOptions } }),
  });

  // Each Slack request a trace of its own, ids only (services/tracing/botSpans.ts);
  // first, so the span covers the surface middleware and the listeners.
  app.use(slackTraceMiddleware);
  // Flags read while handling a Slack event carry `surface: slack`.
  app.use(slackSurfaceMiddleware);
  registerEventHandlers(app);
  slackApp = app;
  return app;
}

/** Opens the Socket Mode connection; false when Slack is disabled or the start failed. */
export async function startSlackApp(app: any): Promise<boolean> {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
    console.log('[SLACK] Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN — Slack bot disabled');
    return false;
  }

  // Before connecting, so the first /t already sees everyone's saved target,
  // and a reply in an agent thread its saved session and owner.
  await loadActiveTargetsOrRetry('SLACK');
  await loadAgentThreadsOrRetry();
  acceptAgentRuns();
  try {
    await app.start();
    console.log('[SLACK] Bot running in Socket Mode');
    console.log(`[SLACK] Who may use the bot: ${describeSlackGate()}`);
    return true;
  } catch (error) {
    console.error('[SLACK] Failed to start:', (error as Error).message);
    return false;
  }
}

/**
 * Closes the Socket Mode connection only. The app's Web API client keeps
 * working, so a draining process still posts the notifications its own
 * status writes trigger.
 */
export async function stopSlackApp(app: any): Promise<void> {
  // Runs are stopped at once (and no new one starts), the connection closes
  // whether or not that throws, and then the stop waits for their notes, which
  // go out through the Web API client. A next holder that reaches one of these
  // threads first finds its run claim held (agentStore.ts) and asks the person
  // to try again, rather than resuming the same session alongside.
  const stopping = stopAgentRunsForRestart();
  try {
    await app.stop();
  } finally {
    await stopping;
  }
}

export function getSlackApp() {
  return slackApp;
}
