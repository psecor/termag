// Every sign-in stamps the session's authenticatedAt (auth/signInAge.ts), which
// the preview links' landing page reads in google and oidc mode (SR18). The
// google callback's last step, after passport has regenerated the session.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { authRouter } from './auth';

vi.mock('../db', () => ({ prisma: { user: { upsert: vi.fn() } } }));

interface RouteLayer { route?: { path: string; stack: { handle: RequestHandler }[] } }

describe('sign-in time on the session', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('the google callback stamps authenticatedAt on the new session before it redirects', async () => {
    vi.stubEnv('AUTH_MODE', 'google');
    const layer = ((authRouter() as Router).stack as RouteLayer[]).find(l => l.route?.path === '/google/callback')!;
    const last = layer.route!.stack.at(-1)!.handle;
    const req = { session: {} as Record<string, unknown> };
    const res = { locals: { returnTo: '/termag/' }, redirect: vi.fn() };
    const before = Date.now();
    await last(req as unknown as Request, res as unknown as Response, vi.fn());
    expect(res.redirect).toHaveBeenCalledWith('/termag/');
    expect(req.session.authenticatedAt).toBeGreaterThanOrEqual(before);
  });
});
