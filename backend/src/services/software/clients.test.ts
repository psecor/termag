import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';

const upsert = vi.fn(async () => ({}));
vi.mock('../../db', () => ({ prisma: { clientVersion: { upsert: (...a: unknown[]) => upsert(...(a as [])) } } }));

import express from 'express';
import { clientVersionMiddleware } from './clients';

/** An app shaped like index.ts: the middleware, then a bearer-only router that finishes CLI requests. */
function app() {
  const a = express();
  a.use('/termag/api', clientVersionMiddleware);
  a.use('/termag/api/cli/v1', (req, res) => {
    res.locals.cliAuth = { user: { id: 'u-cli' } };
    res.json({ ok: true });
  });
  return a;
}

let server: ReturnType<ReturnType<typeof express>['listen']>;
let base = '';
beforeEach(async () => {
  upsert.mockClear();
  server = app().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>(r => server.close(() => r())));

const settle = () => new Promise(r => setTimeout(r, 20));

describe('clientVersionMiddleware', () => {
  it('records the CLI and TUI from their bearer-only routes (res.locals.cliAuth)', async () => {
    await fetch(`${base}/termag/api/cli/v1/whoami`, { headers: { 'User-Agent': 'termag-cli/0.1.0' } });
    await fetch(`${base}/termag/api/cli/v1/projects`, { headers: { 'User-Agent': 'termag-tui/0.1.0' } });
    await settle();
    const kinds = upsert.mock.calls.map(c => (c as unknown as [{ create: { kind: string; userId: string; version: string } }])[0].create);
    expect(kinds).toEqual([
      expect.objectContaining({ userId: 'u-cli', kind: 'cli', version: '0.1.0' }),
      expect.objectContaining({ userId: 'u-cli', kind: 'tui', version: '0.1.0' }),
    ]);
  });

  it('ignores requests from other clients', async () => {
    await fetch(`${base}/termag/api/cli/v1/whoami`, { headers: { 'User-Agent': 'curl/8' } });
    await settle();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('index.ts mount order', () => {
  it('mounts the middleware before the /api/cli/v1 routers, which finish every CLI request', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8');
    const mw = src.indexOf('app.use(`${BASE_PATH}/api`, clientVersionMiddleware)');
    const cli = src.indexOf('app.use(`${BASE_PATH}/api/cli/v1`');
    expect(mw).toBeGreaterThan(0);
    expect(cli).toBeGreaterThan(0);
    expect(mw).toBeLessThan(cli);
  });
});
