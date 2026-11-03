import type { spawn, SpawnOptions } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { postInBackground, SENDER, type BackgroundRequest } from './backgroundPost.js';

const request: BackgroundRequest = {
  url: 'http://127.0.0.1:9/termag/api/cli/v1/usage',
  method: 'POST',
  headers: { Authorization: 'Bearer tmag_secret', 'Content-Type': 'application/json' },
  body: '{"command":"space memory","phase":"finished"}',
  timeoutMs: 1500,
};

let server: Server | null = null;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = null;
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/termag/api/cli/v1/usage`;
}

describe('postInBackground', () => {
  it('runs the fixed sender in a detached child, with the request only on its stdin', () => {
    const calls: Array<{ cmd: string; args: readonly string[]; opts: SpawnOptions }> = [];
    const stdin: string[] = [];
    let unrefs = 0;
    const fake = ((cmd: string, args: readonly string[], opts: SpawnOptions) => {
      calls.push({ cmd, args, opts });
      return { on: () => {}, unref: () => { unrefs++; }, stdin: { on: () => {}, end: (data: string) => { stdin.push(data); } } };
    }) as unknown as typeof spawn;
    postInBackground(request, fake);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(process.execPath);
    expect(calls[0].args).toEqual(['-e', SENDER]);
    expect(calls[0].opts).toEqual({ detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    // Not in the argv (`ps`), not in an environment of its own (/proc/<pid>/environ, its children).
    expect(JSON.stringify([calls[0].args, calls[0].opts])).not.toContain('tmag_secret');
    expect(stdin.map(s => JSON.parse(s))).toEqual([request]);
    expect(unrefs).toBe(1);
  });

  it('ignores a spawn that throws', () => {
    expect(postInBackground(request, (() => { throw new Error('EAGAIN'); }) as unknown as typeof spawn)).toBeNull();
  });

  it('sends the request from a real child after the caller has moved on', async () => {
    let seen!: (r: Record<string, string | undefined>) => void;
    const got = new Promise<Record<string, string | undefined>>(resolve => { seen = resolve; });
    const url = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.statusCode = 204;
        res.end();
        seen({ method: req.method, path: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
      });
    });
    expect(postInBackground({ ...request, url })).not.toBeNull();
    expect(await got).toEqual({
      method: 'POST', path: '/termag/api/cli/v1/usage', auth: 'Bearer tmag_secret', type: 'application/json', body: request.body,
    });
  }, 15_000);

  it('gives up at its timeout when nothing answers', async () => {
    const url = await listen(() => { /* never answers */ });
    const child = postInBackground({ ...request, url, timeoutMs: 300 });
    expect(child).not.toBeNull();
    const started = Date.now();
    const code = await new Promise<number | null>(resolve => child!.on('exit', resolve));
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});
