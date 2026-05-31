/**
 * Slack Bolt App Setup
 *
 * Creates and starts the Slack app with Socket Mode.
 * Runs in the same process as the Express server.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { App } = require('@slack/bolt');

import { registerEventHandlers } from './events';

let slackApp: any = null;

export function createSlackApp(): any {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    processBeforeResponse: false,
  });

  registerEventHandlers(app);
  slackApp = app;
  return app;
}

export async function startSlackApp(app: any): Promise<void> {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
    console.log('[SLACK] Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN — Slack bot disabled');
    return;
  }

  try {
    await app.start();
    console.log('[SLACK] Bot running in Socket Mode');
  } catch (error) {
    console.error('[SLACK] Failed to start:', (error as Error).message);
  }
}

export function getSlackApp() {
  return slackApp;
}
