/**
 * safeOAuthHttp's total deadline (review on #1572): the socket's
 * `timeout` is an idle timeout, so a receiver that trickles a byte every
 * few hundred milliseconds never trips it. `deadlineMs` bounds the whole
 * exchange. Served as plain http on loopback (the request function is
 * swapped), with the host on the test allow-list, as the e2e stack does.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { safeOAuthHttp, type RequestFn } from './mcpOAuthHttp';

let server: http.Server | null = null;
afterEach(() => new Promise<void>(resolve => { if (!server) return resolve(); server.closeAllConnections?.(); server.close(() => resolve()); server = null; }));

/** A receiver that answers 200 and then sends one byte every `everyMs`, for ever. */
async function trickler(everyMs: number): Promise<number> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const t = setInterval(() => res.write('.'), everyMs);
    res.on('close', () => clearInterval(t));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return (server!.address() as AddressInfo).port;
}

// https.request's job, done over plain http: the URL stays https:// so checkOAuthUrl still applies.
const overHttp: RequestFn = (u, options, callback) => http.request({
  host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: options.method, headers: options.headers, timeout: options.timeout,
}, callback);

describe('safeOAuthHttp deadlineMs', () => {
  it('gives up on a receiver that trickles bytes, though no single gap trips the idle timeout', async () => {
    const port = await trickler(50);
    const post = safeOAuthHttp(new Set([`127.0.0.1:${port}`]), overHttp);
    const started = Date.now();
    await expect(post(`https://127.0.0.1:${port}/hook`, { method: 'POST', body: '{}', deadlineMs: 400 })).rejects.toThrow(/did not finish within/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('leaves a quick answer alone', async () => {
    server = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const post = safeOAuthHttp(new Set([`127.0.0.1:${port}`]), overHttp);
    await expect(post(`https://127.0.0.1:${port}/hook`, { method: 'POST', body: '{}', deadlineMs: 2000 })).resolves.toMatchObject({ status: 204 });
  });
});
