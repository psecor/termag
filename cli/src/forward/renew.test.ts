import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RENEW_EVERY_MS, RENEW_VALID_FOR_MS, signInOf, tokenFrame, tokenRenewer } from './renew.js';

/** Just what the renewer touches of a WebSocket. */
class FakeWs extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000); }
}
const asWs = (f: FakeWs) => f as unknown as WebSocket;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('tokenRenewer', () => {
  it('leaves 10 min of every token: an ask each 5 min for one valid 15 min', () => {
    expect(RENEW_EVERY_MS).toBe(5 * 60_000);
    expect(RENEW_VALID_FOR_MS - RENEW_EVERY_MS).toBe(10 * 60_000);
    expect(tokenFrame('eyJx.y.z')).toBe('{"t":"token","token":"eyJx.y.z"}');
  });

  it('asks once per interval for all its connections, and sends a new token to each that lacks it', async () => {
    const asks: Array<{ validForMs?: number } | undefined> = [];
    let n = 0;
    const r = tokenRenewer(async (o) => { asks.push(o); return `t${++n}`; }, { everyMs: 20 });
    const [a, b, c] = [new FakeWs(), new FakeWs(), new FakeWs()];
    r.add(asWs(a), 't0');
    r.add(asWs(b), 't0');
    // Opened later, with the token of the first renewal already.
    await wait(30);
    r.add(asWs(c), 't1');
    await wait(15);
    r.stop();
    expect(asks.length).toBeGreaterThanOrEqual(1);
    expect(asks.every(o => o?.validForMs === RENEW_VALID_FOR_MS)).toBe(true);
    const want = Array.from({ length: n }, (_, i) => tokenFrame(`t${i + 1}`));
    expect(a.sent).toEqual(want);
    expect(b.sent).toEqual(want);
    expect(c.sent).toEqual(want.slice(1));
  });

  it('sends nothing when the source hands back the token a connection holds', async () => {
    let asks = 0;
    const r = tokenRenewer(async () => { asks++; return 'same'; }, { everyMs: 10 });
    const a = new FakeWs();
    r.add(asWs(a), 'same');
    await wait(60);
    r.stop();
    expect(asks).toBeGreaterThan(1);
    expect(a.sent).toEqual([]);
  });

  it('asks nothing while no connection is open, and stops asking once the last one closes', async () => {
    let asks = 0;
    const r = tokenRenewer(async () => `t${++asks}`, { everyMs: 10 });
    await wait(40);
    expect(asks).toBe(0);
    const a = new FakeWs();
    r.add(asWs(a), 't0');
    await wait(25);
    a.close();
    const after = asks;
    expect(after).toBeGreaterThan(0);
    await wait(40);
    expect(asks).toBe(after);
    // A closed connection is never added.
    r.add(asWs(a), 'tx');
    await wait(30);
    expect(asks).toBe(after);
    r.stop();
  });

  it('reports a failed ask and tries again after retryMs', async () => {
    const errors: string[] = [];
    let asks = 0;
    const r = tokenRenewer(async () => { if (++asks === 1) throw new Error('offline'); return 'fresh'; }, {
      everyMs: 10, retryMs: 10, onError: e => errors.push(e.message),
    });
    const a = new FakeWs();
    r.add(asWs(a), 'old');
    await wait(60);
    r.stop();
    expect(errors).toEqual(['offline']);
    expect(a.sent[0]).toBe(tokenFrame('fresh'));
  });

  it('renews a connection only with its own sign-in\'s tokens: after a second login the old ones run on unrenewed', async () => {
    const jwt = (jti: string, n: number) => `eyJh.${Buffer.from(JSON.stringify({ jti, n })).toString('base64url')}.sig`;
    expect(signInOf(jwt('s1', 1))).toBe('s1');
    expect(signInOf('tmcli_x')).toBeNull();
    let next = jwt('s1', 2);
    const r = tokenRenewer(async () => next, { everyMs: 10 });
    const old = new FakeWs();
    r.add(asWs(old), jwt('s1', 1));
    await wait(25);
    expect(old.sent).toEqual([tokenFrame(jwt('s1', 2))]);
    // `termag login` again: the source now mints for s2 alone.
    next = jwt('s2', 1);
    await wait(25);
    expect(old.sent).toEqual([tokenFrame(jwt('s1', 2))]);
    expect(r.outlived(asWs(old))).toBe(true);
    const fresh = new FakeWs();
    r.add(asWs(fresh), jwt('s2', 1));
    next = jwt('s2', 2);
    await wait(25);
    r.stop();
    expect(fresh.sent).toEqual([tokenFrame(jwt('s2', 2))]);
    expect(r.outlived(asWs(fresh))).toBe(false);
    expect(old.sent).toHaveLength(1);
  });

  it('sends nothing to a connection that is ending, and asks nothing while every one is', async () => {
    let asks = 0;
    const r = tokenRenewer(async () => `t${++asks}`, { everyMs: 10 });
    let ending = false;
    const a = new FakeWs();
    const b = new FakeWs();
    r.add(asWs(a), 't0', () => ending);
    r.add(asWs(b), 't0');
    await wait(15);
    ending = true;
    const sentA = a.sent.length;
    await wait(30);
    expect(a.sent).toHaveLength(sentA);
    expect(b.sent.length).toBeGreaterThan(sentA);
    b.close();
    const after = asks;
    await wait(40);
    r.stop();
    expect(asks).toBe(after);
  });

  it('asks nothing more once stopped', async () => {
    let asks = 0;
    const r = tokenRenewer(async () => `t${++asks}`, { everyMs: 10 });
    const a = new FakeWs();
    r.add(asWs(a), 't0');
    await wait(25);
    r.stop();
    const after = asks;
    await wait(40);
    expect(asks).toBe(after);
    r.add(asWs(new FakeWs()), 't0');
    await wait(30);
    expect(asks).toBe(after);
  });
});
