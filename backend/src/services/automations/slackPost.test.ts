import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { postMessageWithin } from './slackPost';

/** A local stand-in for the Web API: each request is handed to `answer`; `closed` counts requests whose connection ended. */
function slackStub(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen = { requests: 0, closed: 0 };
  const server = http.createServer((req, res) => {
    seen.requests++;
    req.socket.on('close', () => { seen.closed++; });
    answer(req, res);
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => void }>(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`, seen, close: () => { server.closeAllConnections(); server.close(); } });
  }));
}

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

const channel = () => 'C1';
const args = { text: 'hi' };

describe('postMessageWithin', () => {
  it('posts once and says so', async () => {
    const s = await slackStub((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    stop = s.close;
    expect(await postMessageWithin(2000, { token: 'xoxb-test', slackApiUrl: s.url }, channel, args)).toEqual({ ok: true });
    expect(s.seen.requests).toBe(1);
  });

  it('ends the request itself at the deadline, even one Slack trickles an answer to, and says it is unknown', async () => {
    const s = await slackStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const drip = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(drip));
    });
    stop = s.close;
    const started = Date.now();
    const r = await postMessageWithin(400, { token: 'xoxb-test', slackApiUrl: s.url }, channel, args);
    expect(r).toMatchObject({ ok: false, deadline: true, maybePosted: true });
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(s.seen.closed).toBe(1); // The connection is gone, not left running.
    expect(s.seen.requests).toBe(1);
  });

  it("tries once: a Slack error, a 5xx and a rate limit are not retried by the client", async () => {
    let status = 200;
    const s = await slackStub((_req, res) => {
      if (status === 429) { res.writeHead(429, { 'retry-after': '1' }); res.end(); return; }
      if (status === 500) { res.writeHead(500); res.end(); return; }
      res.setHeader('content-type', 'application/json'); res.end('{"ok":false,"error":"not_in_channel"}');
    });
    stop = s.close;
    expect(await postMessageWithin(2000, { token: 'xoxb-test', slackApiUrl: s.url }, channel, args)).toMatchObject({ ok: false, deadline: false, code: 'not_in_channel' });
    status = 500;
    expect(await postMessageWithin(2000, { token: 'xoxb-test', slackApiUrl: s.url }, channel, args)).toMatchObject({ ok: false, deadline: false });
    status = 429;
    expect(await postMessageWithin(2000, { token: 'xoxb-test', slackApiUrl: s.url }, channel, args)).toMatchObject({ ok: false, deadline: false });
    expect(s.seen.requests).toBe(3);
  });

  it("bounds the DM's lookup on the same client: stopped there, nothing was posted, and its request ends too", async () => {
    const s = await slackStub(() => {}); // users.lookupByEmail never answers
    stop = s.close;
    const r = await postMessageWithin(300, { token: 'xoxb-test', slackApiUrl: s.url }, async c => (await c.users.lookupByEmail({ email: 'me@example.com' })).user?.id ?? null, args);
    expect(r).toMatchObject({ ok: false, deadline: true, maybePosted: false });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(s.seen).toEqual({ requests: 1, closed: 1 });
  });

  it('says when there is nowhere to post, and posts nothing', async () => {
    const s = await slackStub((_req, res) => { res.end('{"ok":true}'); });
    stop = s.close;
    expect(await postMessageWithin(2000, { token: 'xoxb-test', slackApiUrl: s.url }, () => null, args)).toEqual({ ok: false, noChannel: true });
    expect(s.seen.requests).toBe(0);
  });

  it('goes through the gate it is given', async () => {
    const s = await slackStub((_req, res) => { res.end('{"ok":true}'); });
    stop = s.close;
    const r = await postMessageWithin(2000, { token: 'xoxb-test', slackApiUrl: s.url, gate: c => { (c as unknown as { makeRequest: () => never }).makeRequest = () => { throw new Error('slack-interactions-enabled is off'); }; return c; } }, channel, args);
    expect(r).toMatchObject({ ok: false, deadline: false, error: 'slack-interactions-enabled is off' });
    expect(s.seen.requests).toBe(0);
  });

  it("a gate still waiting on the bot's workspace at the deadline posted nothing, so it may be retried, and sends nothing later", async () => {
    const s = await slackStub((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    stop = s.close;
    let release!: () => void;
    const workspace = new Promise<void>(resolve => { release = resolve; });
    // The real gate's shape: wrap makeRequest, wait on the (slow) workspace lookup, then call through.
    const gate = (c: unknown) => {
      const w = c as { makeRequest: (url: string, ...rest: unknown[]) => Promise<unknown> };
      const inner = w.makeRequest.bind(c);
      w.makeRequest = async (url: string, ...rest: unknown[]) => { await workspace; return inner(url, ...rest); };
      return c as never;
    };
    const r = await postMessageWithin(200, { token: 'xoxb-test', slackApiUrl: s.url, gate }, channel, args);
    expect(r).toMatchObject({ ok: false, deadline: true, maybePosted: false });
    release();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(s.seen.requests).toBe(0);
  });
});
