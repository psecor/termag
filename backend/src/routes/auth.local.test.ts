import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { authRouter } from './auth';
import { prisma } from '../db';

vi.mock('../db', () => ({ prisma: { user: { upsert: vi.fn() } } }));

interface RouteLayer { route?: { path: string; stack: { name: string; handle: RequestHandler }[] } }

function loginHandlers(router: Router): { path: string; handler: string }[] {
  return (router.stack as RouteLayer[])
    .filter(l => l.route && (l.route.path === '/login' || l.route.path === '/dev-login'))
    .map(l => ({ path: l.route!.path, handler: l.route!.stack[0].name }));
}

describe('authRouter local sign-in', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('registers localLogin on /login when AUTH_MODE=local and the server is loopback-only', () => {
    vi.stubEnv('AUTH_MODE', 'local');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BIND_HOST', '127.0.0.1');
    expect(loginHandlers(authRouter())).toEqual([{ path: '/login', handler: 'localLogin' }]);
  });

  it('refuses to build the router for AUTH_MODE=local in production', () => {
    vi.stubEnv('AUTH_MODE', 'local');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BIND_HOST', '127.0.0.1');
    expect(() => authRouter()).toThrow(/"production"/);
  });

  it('refuses to build the router for AUTH_MODE=local on all interfaces', () => {
    vi.stubEnv('AUTH_MODE', 'local');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BIND_HOST', '');
    expect(() => authRouter()).toThrow(/BIND_HOST/);
  });

  it('has no sign-in bypass in google mode outside production', () => {
    vi.stubEnv('AUTH_MODE', 'google');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BIND_HOST', '127.0.0.1');
    const handlers = loginHandlers(authRouter());
    expect(handlers.map(h => h.path)).toEqual(['/login']);
    expect(handlers[0].handler).not.toBe('localLogin');
  });

  it('refuses a sign-in that a same-host proxy forwarded from off-host, before touching the database', async () => {
    vi.stubEnv('AUTH_MODE', 'local');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BIND_HOST', '127.0.0.1');
    vi.stubEnv('ALLOWED_USERS', 'e2e@termag.local:e2e');
    const layer = (authRouter().stack as RouteLayer[]).find(l => l.route?.path === '/login')!;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), redirect: vi.fn() };
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-termag-peer-addr': '10.0.4.45' } };
    await layer.route!.stack[0].handle(req as unknown as Request, res as unknown as Response, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });
});
