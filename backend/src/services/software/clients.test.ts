import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';

const upsert = vi.fn(async () => ({}));
vi.mock('../../db', () => ({ prisma: { clientVersion: { upsert: (...a: unknown[]) => upsert(...(a as [])) } } }));
const events: Array<{ name: string; ctx: unknown; detail: unknown }> = [];
vi.mock('../productEvents', () => ({
  recordProductEvent: (name: string, ctx: unknown, detail: unknown) => { events.push({ name, ctx, detail }); },
}));

import express from 'express';
import { clientVersionMiddleware, recordDesktopOpen, resetClientThrottlesForTests } from './clients';

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) termagBeta/0.1.252 Chrome/152.0.0.0 Electron/44.0.0 Safari/537.36';

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
  events.length = 0;
  resetClientThrottlesForTests();
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
    expect(events).toEqual([]);
  });

  it('records the desktop app, and counts it opened once for a run of its requests', async () => {
    for (let i = 0; i < 3; i++) await fetch(`${base}/termag/api/cli/v1/boxes`, { headers: { 'User-Agent': DESKTOP_UA } });
    await settle();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0] as unknown as [{ create: unknown }])[0].create).toEqual(expect.objectContaining({ userId: 'u-cli', kind: 'desktop', version: '0.1.252' }));
    expect(events).toEqual([{
      name: 'client.opened',
      ctx: { user: 'u-cli' },
      detail: { view: 'desktop', version: '0.1.252', channel: 'beta', platform: 'darwin' },
    }]);
  });

  it('sends no client.opened for the CLI or TUI, whose commands are cli.command', async () => {
    await fetch(`${base}/termag/api/cli/v1/whoami`, { headers: { 'User-Agent': 'termag-cli/0.1.0' } });
    await fetch(`${base}/termag/api/cli/v1/projects`, { headers: { 'User-Agent': 'termag-tui/0.1.0' } });
    await settle();
    expect(events).toEqual([]);
  });
});

describe('recordDesktopOpen', () => {
  const desktop = { version: '0.1.252', channel: 'beta', platform: 'darwin' as const };
  const H = 3600_000;

  it('sends at most once every four hours per user, whatever the version', () => {
    expect(recordDesktopOpen('u1', desktop, 0)).toBe(true);
    expect(recordDesktopOpen('u1', desktop, 1 * H)).toBe(false);
    expect(recordDesktopOpen('u1', { ...desktop, version: '0.1.253' }, 2 * H)).toBe(false);
    expect(recordDesktopOpen('u2', desktop, 2 * H)).toBe(true);
    expect(recordDesktopOpen('u1', desktop, 4 * H - 1)).toBe(false);
    expect(recordDesktopOpen('u1', desktop, 4 * H)).toBe(true);
    expect(events.map(e => (e.ctx as { user: string }).user)).toEqual(['u1', 'u2', 'u1']);
  });

  it('passes what the User-Agent did not say as null, which the record leaves out', () => {
    recordDesktopOpen('u1', { version: '0.1.252', channel: null, platform: null }, 0);
    expect(events[0].detail).toEqual({ view: 'desktop', version: '0.1.252', channel: null, platform: null });
  });
});

describe('index.ts mount order', () => {
  it('mounts the middleware before every /api/cli/v1 router, which finish their requests', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8');
    const mw = src.indexOf('app.use(`${BASE_PATH}/api`, clientVersionMiddleware)');
    expect(mw).toBeGreaterThan(0);
    // The plain mount, and the desktop's box relay and forward probe, which come first.
    for (const prefix of ['app.use(`${BASE_PATH}/api/cli/v1`', 'app.use(`${BASE_PATH}/api/cli/v1/boxes/:id/t3/relay`', 'app.use(`${BASE_PATH}/api/cli/v1/boxes/:id/forward`']) {
      const at = src.indexOf(prefix);
      expect(at, prefix).toBeGreaterThan(0);
      expect(mw, prefix).toBeLessThan(at);
    }
  });
});
