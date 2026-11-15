import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({ current: null as null | { client: { token: string } } }));
vi.mock('../../slack/app', () => ({ getSlackApp: () => app.current }));
vi.mock('../../db', () => ({ prisma: { user: { update: vi.fn(async () => ({})) } } }));
// The interaction gate is its own module's business (slackInteractionsFlag.test.ts); here every call passes it.
vi.mock('../slackInteractionsFlag', () => ({ botWorkspaceLookup: () => async () => null, gateSlackClient: (c: unknown) => c }));

import { checkAlertChannel, type AlertChannelClient } from './alertChannel';

const owner = { id: 'u1', slackUserId: 'U-owner', googleEmail: 'owner@example.com' };

/** A Slack fake: channels by id with their members (paged two at a time), the bot's own id, users by email. */
function slack(channels: Record<string, string[]>, opts: { bot?: string | null; authFails?: boolean; lookupFails?: string; emails?: Record<string, string> } = {}): AlertChannelClient {
  return {
    auth: { test: async () => { if (opts.authFails) throw new Error('An API error occurred: ratelimited'); return { user_id: opts.bot === null ? undefined : opts.bot ?? 'U-bot' }; } },
    conversations: {
      members: async ({ channel, cursor }) => {
        const all = channels[channel];
        if (!all) throw Object.assign(new Error('An API error occurred: channel_not_found'), { data: { error: 'channel_not_found' } });
        const from = cursor ? Number(cursor) : 0;
        const next = from + 2 < all.length ? String(from + 2) : '';
        return { members: all.slice(from, from + 2), response_metadata: { next_cursor: next } };
      },
    },
    users: {
      lookupByEmail: async ({ email }) => {
        if (opts.lookupFails) throw Object.assign(new Error(`An API error occurred: ${opts.lookupFails}`), { data: { error: opts.lookupFails } });
        return { user: { id: opts.emails?.[email] } };
      },
    },
  };
}

describe('checkAlertChannel', () => {
  it('takes a channel the owner and the bot are both in, across pages of members', async () => {
    expect(await checkAlertChannel(owner, 'C1', slack({ C1: ['U-a', 'U-b', 'U-bot', 'U-c', 'U-owner'] }))).toEqual({ ok: true });
  });

  it('refuses a channel the owner is not in', async () => {
    expect(await checkAlertChannel(owner, 'C1', slack({ C1: ['U-bot', 'U-someone'] }))).toMatchObject({ ok: false, code: 'alert_channel_not_member' });
  });

  it('refuses a channel the bot is not in, or one that does not exist', async () => {
    expect(await checkAlertChannel(owner, 'C1', slack({ C1: ['U-owner'] }))).toMatchObject({ ok: false, code: 'alert_channel_bot_absent' });
    expect(await checkAlertChannel(owner, 'C9', slack({}))).toMatchObject({ ok: false, code: 'alert_channel_bot_absent' });
  });

  it('finds the owner by email as DMs do, and refuses when it cannot', async () => {
    const byEmail = { id: 'u1', slackUserId: null, googleEmail: 'owner@example.com' };
    expect(await checkAlertChannel(byEmail, 'C1', slack({ C1: ['U-bot', 'U-found'] }, { emails: { 'owner@example.com': 'U-found' } }))).toEqual({ ok: true });
    expect(await checkAlertChannel(byEmail, 'C1', slack({ C1: ['U-bot'] }))).toMatchObject({ ok: false, code: 'alert_channel_owner_unknown' });
  });

  it("a lookup that fails for a moment is unchecked (try again), not \"can't find your Slack user\"", async () => {
    const byEmail = { id: 'u1', slackUserId: null, googleEmail: 'owner@example.com' };
    for (const code of ['ratelimited', 'internal_error', 'fatal_error']) {
      expect(await checkAlertChannel(byEmail, 'C1', slack({ C1: ['U-bot', 'U-owner'] }, { lookupFails: code })), code).toMatchObject({ ok: false, code: 'alert_channel_unchecked' });
    }
    expect(await checkAlertChannel(byEmail, 'C1', slack({ C1: ['U-bot'] }, { lookupFails: 'users_not_found' }))).toMatchObject({ ok: false, code: 'alert_channel_owner_unknown' });
    expect(await checkAlertChannel({ ...byEmail, googleEmail: '' }, 'C1', slack({ C1: ['U-bot'] }, { lookupFails: 'invalid_email' }))).toMatchObject({ ok: false, code: 'alert_channel_owner_unknown' });
  });

  it('fails closed when Slack will not say who the bot is', async () => {
    expect(await checkAlertChannel(owner, 'C1', slack({ C1: ['U-owner'] }, { authFails: true }))).toMatchObject({ ok: false, code: 'alert_channel_unchecked' });
    expect(await checkAlertChannel(owner, 'C1', slack({ C1: ['U-owner', 'U-bot'] }, { bot: null }))).toMatchObject({ ok: false, code: 'alert_channel_unchecked' });
  });

  it('refuses with no Slack app', async () => {
    expect(await checkAlertChannel(owner, 'C1', null)).toMatchObject({ ok: false, code: 'alert_slack_off' });
  });
});

describe('checkAlertChannel on the app\'s Slack', () => {
  /** A local stand-in for the Web API; `answer` takes the method and the response. */
  async function slackStub(answer: (method: string, res: http.ServerResponse) => void) {
    const seen: string[] = [];
    const server = http.createServer((req, res) => { const m = (req.url ?? '').replace(/^\/api\//, ''); seen.push(m); answer(m, res); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.SLACK_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
    app.current = { client: { token: 'xoxb-test' } };
    stop = () => { server.closeAllConnections(); server.close(); };
    return seen;
  }
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; app.current = null; delete process.env.SLACK_API_URL; });
  const json = (res: http.ServerResponse, body: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };

  it('checks through a bounded client', async () => {
    await slackStub((m, res) => json(res, m === 'auth.test' ? { ok: true, user_id: 'U-bot' } : { ok: true, members: ['U-bot', 'U-owner'], response_metadata: { next_cursor: '' } }));
    expect(await checkAlertChannel(owner, 'C1')).toEqual({ ok: true });
  });

  it('a rate limit is answered at once as unchecked: no retry, no wait on Retry-After', async () => {
    const seen = await slackStub((_m, res) => { res.writeHead(429, { 'retry-after': '30' }); res.end(); });
    const started = Date.now();
    expect(await checkAlertChannel({ ...owner, slackUserId: null }, 'C1')).toMatchObject({ ok: false, code: 'alert_channel_unchecked' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(seen).toEqual(['users.lookupByEmail']);
  });

  it('a Slack that never answers is unchecked at the deadline, and its request is ended', async () => {
    let closed = 0;
    await slackStub((_m, res) => { res.on('close', () => { closed++; }); });
    const started = Date.now();
    const r = await checkAlertChannel(owner, 'C1', undefined, 300);
    expect(r).toMatchObject({ ok: false, code: 'alert_channel_unchecked', error: expect.stringContaining("didn't answer") });
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(closed).toBe(1);
  });
});
