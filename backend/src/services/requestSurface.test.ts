import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { currentSurface, withSurface, surfaceMiddleware, slackSurfaceMiddleware } from './requestSurface';
import { buildFlagContext } from './featureFlags';

const user = { id: 'u1', googleEmail: 'a@example.com', displayName: 'A', unixUsername: 'a', defaultAgentProvider: 'claude' };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

describe('withSurface', () => {
  it('is unset outside, set inside, kept across awaits, and the inner one wins', async () => {
    expect(currentSurface()).toBeUndefined();
    await withSurface('cli', async () => {
      await tick();
      expect(currentSurface()).toBe('cli');
      withSurface('slack', () => expect(currentSurface()).toBe('slack'));
      expect(currentSurface()).toBe('cli');
    });
    expect(currentSurface()).toBeUndefined();
  });

  it('keeps concurrent work apart', async () => {
    const seen: string[] = [];
    await Promise.all([
      withSurface('web', async () => { await tick(); seen.push(`web:${currentSurface()}`); }),
      withSurface('slack', async () => { seen.push(`slack:${currentSurface()}`); await tick(); seen.push(`slack:${currentSurface()}`); }),
    ]);
    expect(seen.sort()).toEqual(['slack:slack', 'slack:slack', 'web:web']);
  });
});

describe('slackSurfaceMiddleware', () => {
  it('runs the Bolt listeners as slack', async () => {
    let seen: string | undefined;
    await slackSurfaceMiddleware({ next: async () => { await tick(); seen = currentSurface(); } });
    expect(seen).toBe('slack');
  });
});

describe('surfaceMiddleware', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())));

  // As index.ts mounts it: once, then a middleware that resumes the request in
  // another context (what the pg session store can do), then once more.
  async function start(): Promise<string> {
    const app = express();
    app.use('/api', surfaceMiddleware);
    app.use('/api', (_req, _res, next) => withSurface('slack', () => setImmediate(next)));
    app.use('/api', surfaceMiddleware);
    app.get('/api/ctx', async (_req, res) => {
      await tick();
      const ctx = buildFlagContext(user) as { surface?: string };
      res.json({ surface: currentSurface() ?? null, context: ctx.surface ?? null });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server!.once('listening', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/ctx`;
  }

  it('names the client the headers give, and puts it on the user context', async () => {
    const url = await start();
    const get = async (headers: Record<string, string>) => (await fetch(url, { headers })).json();
    expect(await get({ 'X-Termag-Client': 'web/0123456789ab' })).toEqual({ surface: 'web', context: 'web' });
    expect(await get({ 'X-Termag-Client': 'mobile/0123456789ab' })).toEqual({ surface: 'mobile', context: 'mobile' });
    expect(await get({ 'User-Agent': 'termag-cli/1.4.0' })).toEqual({ surface: 'cli', context: 'cli' });
    expect(await get({ 'User-Agent': 'termag-tui/1.4.0' })).toEqual({ surface: 'tui', context: 'tui' });
    expect(await get({ 'User-Agent': 'metaterm/0.9.1' })).toEqual({ surface: 'metaterm', context: 'metaterm' });
  });

  it('leaves an unrecognised client without a surface, not with one inherited from elsewhere', async () => {
    const url = await start();
    expect(await (await fetch(url, { headers: { 'User-Agent': 'curl/8.5.0' } })).json()).toEqual({ surface: null, context: null });
  });
});
