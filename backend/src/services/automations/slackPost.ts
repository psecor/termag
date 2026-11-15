/**
 * One Slack post for an alert, stopped at its deadline
 * . The app's own WebClient can't be used
 * for it: it retries a failed call for about half an hour on its own, and a
 * race against a timer would only stop waiting, leaving the request running,
 * so a post that answered late and the outbox's retry would both arrive.
 * Here each post gets a client of its own with retries off, rate limits
 * rejected (a 429 posted nothing, so the outbox's backoff takes it) and an
 * agent of its own, destroyed at the deadline: that ends the request's
 * socket, whatever it is doing, and every call still running on that
 * client (the DM's user lookup too) ends with it. A post stopped that way
 * may still have posted (Slack had the body), so the caller treats it as
 * unknown, not as failed: it is not tried again. One stopped before the post
 * began (in the lookup) posted nothing and may be. The save-time channel
 * check (alertChannel.ts) reads through the same kind of client
 * (withBoundedSlack), so a Slack outage or rate limit can't hold a save.
 */
import http from 'node:http';
import https from 'node:https';
import { WebClient } from '@slack/web-api';
import { botWorkspaceLookup, gateSlackClient, type SlackWorkspaceLookup } from '../slackInteractionsFlag';

export type BoundedPost =
  | { ok: true }
  /** channelOf found nowhere to post. */
  | { ok: false; noChannel: true }
  /** Stopped at the deadline; `maybePosted` once the post itself had begun. */
  | { ok: false; deadline: true; maybePosted: boolean; error: string }
  | { ok: false; deadline: false; error: string; code: string | null };

/** The calls a post makes: chat.postMessage, and whatever channelOf reads (the DM's lookup). */
export type BoundedSlack = Pick<WebClient, 'chat' | 'users' | 'conversations'>;

export interface BoundedPostClient {
  token: string;
  /** The Web API base URL; only the e2e stub sets it (SLACK_API_URL). */
  slackApiUrl?: string;
  /** Applied to the fresh client before it is used (slackInteractionsFlag.ts gateSlackClient). */
  gate?: (client: WebClient) => WebClient;
}

let appWorkspace: { client: unknown; lookup: SlackWorkspaceLookup } | null = null;

/** The app's token and gate (slack-interactions-enabled, read for the bot's workspace), for a bounded client; null without a token. */
export function appBoundedClient(appClient: { token?: string }): BoundedPostClient | null {
  if (!appClient.token) return null;
  if (appWorkspace?.client !== appClient) appWorkspace = { client: appClient, lookup: botWorkspaceLookup(appClient) };
  const lookup = appWorkspace.lookup;
  return { token: appClient.token, slackApiUrl: process.env.SLACK_API_URL?.trim() || undefined, gate: c => gateSlackClient(c, lookup) };
}

/**
 * A fresh WebClient with retries off, a 429 rejected and an agent of its own.
 * `onRequest` sees each method as its request starts, under the gate; after
 * `end()` no request starts and the agent's sockets are destroyed.
 */
function openBounded(c: BoundedPostClient, onRequest?: (method: string) => void): { client: WebClient; end: () => void } {
  const slackApiUrl = c.slackApiUrl || 'https://slack.com/api/';
  const agent = slackApiUrl.startsWith('http:') ? new http.Agent({ keepAlive: false }) : new https.Agent({ keepAlive: false });
  let client = new WebClient(c.token, { slackApiUrl, agent, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
  let expired = false;
  // Under the gate, so only a request that passed it is seen: postMessageWithin marks the post
  // begun when its own request starts, not while the gate still waits on the bot's workspace
  // (its auth.test is on the app's client, which this agent can't stop). Past the deadline no
  // request starts at all, so a gate that answers late sends nothing behind the caller.
  const raw = client as unknown as { makeRequest: (url: string, ...rest: unknown[]) => Promise<unknown> };
  const send = raw.makeRequest.bind(client);
  raw.makeRequest = async (url: string, ...rest: unknown[]) => {
    if (expired) throw new Error('the Slack call ran past its deadline');
    onRequest?.(url.replace(/^\/+/, ''));
    return send(url, ...rest);
  };
  if (c.gate) client = c.gate(client);
  return { client, end: () => { expired = true; agent.destroy(); } };
}

/**
 * `work` on a bounded client, within `ms`: at the deadline its requests are
 * ended (the agent destroyed) and nothing more starts. Never throws.
 */
export async function withBoundedSlack<T>(ms: number, c: BoundedPostClient, work: (client: WebClient) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; deadline: boolean; error: string }> {
  const { client, end } = openBounded(c);
  const call = work(client);
  call.catch(() => {}); // Failed after the deadline (its socket destroyed): nobody is waiting.
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), ms); timer.unref?.(); });
  try {
    const won = await Promise.race([call.then(value => ({ value })), late]);
    if (won === 'late') return { ok: false, deadline: true, error: `Slack did not answer within ${Math.round(ms / 1000)} s` };
    return { ok: true, value: won.value };
  } catch (err) {
    return { ok: false, deadline: false, error: (err as { data?: { error?: string } }).data?.error ?? (err as Error).message };
  } finally {
    clearTimeout(timer);
    end();
  }
}

/**
 * Find the channel (`channelOf`, on the same bounded client) and post `message` there, all within `ms`.
 * Never throws; nothing it started is left running when it returns.
 */
export async function postMessageWithin(
  ms: number,
  c: BoundedPostClient,
  channelOf: (client: BoundedSlack) => Promise<string | null> | string | null,
  message: { text: string; unfurl_links?: boolean; unfurl_media?: boolean },
): Promise<BoundedPost> {
  let posting = false;
  const { client, end } = openBounded(c, method => { if (method === 'chat.postMessage') posting = true; });
  const call = (async () => {
    const channel = await channelOf(client);
    if (!channel) return 'no_channel' as const;
    await client.chat.postMessage({ channel, ...message });
    return 'ok' as const;
  })();
  call.catch(() => {}); // Failed after the deadline (its socket destroyed): nobody is waiting.
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), ms); timer.unref?.(); });
  try {
    const won = await Promise.race([call, late]);
    if (won === 'ok') return { ok: true };
    if (won === 'no_channel') return { ok: false, noChannel: true };
    return { ok: false, deadline: true, maybePosted: posting, error: `Slack did not answer within ${Math.round(ms / 1000)} s` };
  } catch (err) {
    const code = (err as { data?: { error?: string } }).data?.error ?? null;
    return { ok: false, deadline: false, error: code ?? (err as Error).message, code };
  } finally {
    clearTimeout(timer);
    end();
  }
}
