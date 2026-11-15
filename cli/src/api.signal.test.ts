import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api, REQUEST_CANCELLED } from './api.js';
import { CliError } from './errors.js';

/**
 * Api.request's caller signal and its timeout, held to the whole response: a server that sends
 * its headers and then stalls in the body, or a bearer refresh that never answers, is cut there.
 */
let server: Server;
let host: string;
let held: ServerResponse[];

beforeEach(async () => {
  held = [];
  server = createServer((req, res) => {
    // Headers and the start of a JSON body, then nothing more.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"ok":');
    held.push(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const r of held) r.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

const failure = async (p: Promise<unknown>): Promise<CliError> => {
  try { await p; } catch (err) { return err as CliError; }
  throw new Error('expected a failure');
};

describe('Api.request with a signal', () => {
  it('a body that stalls after the headers ends on the caller\'s signal, as REQUEST_CANCELLED', async () => {
    const ctl = new AbortController();
    const api = new Api({ host, token: 'eyJ.x.y', fetch: globalThis.fetch, timeoutMs: 60_000 });
    const pending = failure(api.request('GET', '/x', undefined, { signal: ctl.signal }));
    while (held.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
    // Long enough for fetch to have the headers and be reading the body.
    await new Promise(resolve => setTimeout(resolve, 300));
    const at = Date.now();
    ctl.abort();
    const err = await pending;
    expect(Date.now() - at).toBeLessThan(2000);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toBe(REQUEST_CANCELLED);
  });

  it('a body that stalls after the headers ends on the client\'s timeout, as its usual timeout', async () => {
    const api = new Api({ host, token: 'eyJ.x.y', fetch: globalThis.fetch, timeoutMs: 300 });
    const err = await failure(api.request('GET', '/x'));
    expect(err.code).toBe('timeout');
    expect(err.message).toBe(`Timed out waiting for the orchestrator at ${host}`);
  });

  it('a bearer refresh that never answers ends on the signal, because the source gets it', async () => {
    const ctl = new AbortController();
    let seen: AbortSignal | undefined;
    const token = (opts?: { signal?: AbortSignal }) => {
      seen = opts?.signal;
      return new Promise<string>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new CliError('failed', REQUEST_CANCELLED)), { once: true });
      });
    };
    const api = new Api({ host, token, fetch: globalThis.fetch });
    const pending = failure(api.request('GET', '/x', undefined, { signal: ctl.signal }));
    ctl.abort();
    expect((await pending).message).toBe(REQUEST_CANCELLED);
    expect(seen).toBe(ctl.signal);
    expect(held).toEqual([]);
  });

  it('a whole body still reads as before', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'); });
    const api = new Api({ host, token: 'eyJ.x.y', fetch: globalThis.fetch });
    expect(await api.request('GET', '/x', undefined, { signal: new AbortController().signal })).toEqual({ ok: true });
  });
});
