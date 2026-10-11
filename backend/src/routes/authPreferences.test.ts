import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { authRouter } from './auth';
import { prisma } from '../db';
import { DEFAULT_THEME } from '../theme/schema';

vi.mock('../db', () => ({ prisma: { user: { upsert: vi.fn(), update: vi.fn() } } }));

interface RouteLayer { route?: { path: string; stack: { handle: RequestHandler }[] } }

function handler(router: Router, path: string): RequestHandler {
  const layer = (router.stack as RouteLayer[]).find(l => l.route?.path === path);
  if (!layer?.route) throw new Error(`no route ${path}`);
  return layer.route.stack[0].handle;
}

const storedUser = {
  id: 'u1', googleId: 'g1', googleEmail: 'e2e@termag.local', unixUsername: 'e2e', displayName: 'E2E',
  defaultAgentProvider: 'codex', claudeGatewayEnabled: true, dotfilesRepoUrl: null,
  slackUserId: null, discordUserId: null, createdAt: new Date(0), theme: {},
};

// `user: null` means no session (a default parameter would swallow an explicit undefined).
function call(h: RequestHandler, body: unknown, user: Express.User | null = { ...storedUser }) {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  res.status.mockReturnValue(res);
  const req = { body, user: user ?? undefined } as unknown as Request;
  return Promise.resolve(h(req, res, () => {})).then(() => ({ req, res }));
}

describe('PUT /auth/me/preferences', () => {
  let put: RequestHandler;
  let me: RequestHandler;

  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'local');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BIND_HOST', '127.0.0.1');
    const router = authRouter();
    put = handler(router, '/me/preferences');
    me = handler(router, '/me');
    vi.mocked(prisma.user.update).mockReset();
    vi.mocked(prisma.user.update).mockImplementation(async ({ data }) => ({ ...storedUser, ...(data as object) }) as never);
  });

  it('serves the normalized theme from /me, so a fresh {} row reads as the default', async () => {
    const { res } = await call(me, undefined);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ email: 'e2e@termag.local', theme: DEFAULT_THEME }));
  });

  it('stores a valid theme, mirrors it onto the session user and returns the full user', async () => {
    const theme = { version: 1, background: { mode: 'solid', color: '#0B1A2E' }, sidebarActivity: true };
    const { req, res } = await call(put, { theme });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { theme: { version: 1, background: { mode: 'solid', color: '#0b1a2e' }, sidebarActivity: true } },
    });
    expect(req.user?.theme).toEqual({ version: 1, background: { mode: 'solid', color: '#0b1a2e' }, sidebarActivity: true });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      defaultAgentProvider: 'codex',
      theme: { version: 1, background: { mode: 'solid', color: '#0b1a2e' }, sidebarActivity: true },
    }));
  });

  it('still accepts the provider on its own, leaving the theme untouched', async () => {
    const { res } = await call(put, { defaultAgentProvider: 'claude' });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { defaultAgentProvider: 'claude' } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ defaultAgentProvider: 'claude', theme: DEFAULT_THEME }));
  });

  it('rejects a bad theme with the validator message and writes nothing', async () => {
    const { res } = await call(put, { theme: { version: 1, background: { mode: 'solid', color: 'red' } } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(/background\.color/) });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider even when the theme is fine', async () => {
    const { res } = await call(put, { defaultAgentProvider: 'hal9000', theme: DEFAULT_THEME });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(/defaultAgentProvider/) });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const { res } = await call(put, {});
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('requires a signed-in user', async () => {
    const { res } = await call(put, { theme: DEFAULT_THEME }, null);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
