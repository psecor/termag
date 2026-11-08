import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { authRouter } from './auth';
import { prisma } from '../db';
import { DEFAULT_THEME } from '../theme/schema';
import { forgetUserTimeZones } from '../services/userTimeZone';

vi.mock('../db', () => ({ prisma: { user: { upsert: vi.fn(), update: vi.fn() } } }));
const ld = vi.hoisted(() => ({ on: false }));
vi.mock('../services/featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/featureFlags')>()),
  boolVariation: vi.fn(async (key: string) => key === 'onboarding-refresh-enabled' && ld.on),
}));

interface RouteLayer { route?: { path: string; stack: { handle: RequestHandler }[] } }

function handler(router: Router, path: string): RequestHandler {
  const layer = (router.stack as RouteLayer[]).find(l => l.route?.path === path);
  if (!layer?.route) throw new Error(`no route ${path}`);
  return layer.route.stack[0].handle;
}

const storedUser = {
  id: 'u1', googleId: 'g1', googleEmail: 'e2e@termag.local', unixUsername: 'e2e', displayName: 'E2E',
  defaultAgentProvider: 'codex', claudeGatewayEnabled: true, dotfilesRepoUrl: null,
  slackUserId: null, discordUserId: null, createdAt: new Date(0), theme: {}, pushMutesChat: false, uiMode: null as string | null,
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
    ld.on = false;
    vi.mocked(prisma.user.update).mockReset();
    vi.mocked(prisma.user.update).mockImplementation(async ({ data }) => ({ ...storedUser, ...(data as object) }) as never);
  });

  it('leaves where termag opens out of /me, and refuses to store it, with onboarding-refresh-enabled off', async () => {
    const { res } = await call(me, undefined, { ...storedUser, uiMode: 'full' } as never);
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('uiMode');
    const put1 = await call(put, { uiMode: 'simple' });
    expect(put1.res.status).toHaveBeenCalledWith(403);
    expect(put1.res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ui_mode_disabled' }));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('keeps where termag opens on the user with the flag on', async () => {
    ld.on = true;
    const before = await call(me, undefined);
    expect(before.res.json).toHaveBeenCalledWith(expect.objectContaining({ uiMode: null }));
    const { req, res } = await call(put, { uiMode: 'full' });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { uiMode: 'full' } });
    expect(req.user?.uiMode).toBe('full');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ uiMode: 'full' }));
    const after = await call(me, undefined, req.user!);
    expect(after.res.json).toHaveBeenCalledWith(expect.objectContaining({ uiMode: 'full' }));
  });

  it("keeps the zone the browser sends at sign-in (GET /me?tz=) as User.timeZone, and ignores one that is not a zone", async () => {
    forgetUserTimeZones();
    const res = { status: vi.fn(), json: vi.fn() } as unknown as Response & { status: ReturnType<typeof vi.fn> };
    res.status.mockReturnValue(res);
    await me({ user: { ...storedUser, timeZone: null }, query: { tz: 'Europe/Berlin' } } as unknown as Request, res, () => {});
    await vi.waitFor(() => expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { timeZone: 'Europe/Berlin' } }));
    vi.mocked(prisma.user.update).mockClear();
    await me({ user: { ...storedUser, id: 'u2', timeZone: null }, query: { tz: 'Mars/Olympus' } } as unknown as Request, res, () => {});
    await new Promise(r => setTimeout(r, 10));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('takes only simple, full or null for it', async () => {
    ld.on = true;
    const { res } = await call(put, { uiMode: 'lab' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
    await call(put, { uiMode: null });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { uiMode: null } });
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
      data: { theme: { version: 1, background: { mode: 'solid', color: '#0b1a2e' }, sidebarActivity: true, sidebarMetaTerm: false, sidebarShowStopped: false, sidebarAskChats: false, sidebarHideAskBoxes: false } },
    });
    expect(req.user?.theme).toEqual({ version: 1, background: { mode: 'solid', color: '#0b1a2e' }, sidebarActivity: true, sidebarMetaTerm: false, sidebarShowStopped: false, sidebarAskChats: false, sidebarHideAskBoxes: false });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      defaultAgentProvider: 'codex',
      theme: { version: 1, background: { mode: 'solid', color: '#0b1a2e' }, sidebarActivity: true, sidebarMetaTerm: false, sidebarShowStopped: false, sidebarAskChats: false, sidebarHideAskBoxes: false },
    }));
  });

  it('stores the Projects list\'s Show stopped choice, and /me serves it back', async () => {
    const theme = { ...DEFAULT_THEME, sidebarShowStopped: true };
    const { req } = await call(put, { theme });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { theme } });
    expect(req.user?.theme).toEqual(theme);
    const { res } = await call(me, undefined, req.user!);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ theme }));
  });

  it('stores Appearance\'s Hide ask boxes choice, and /me serves it back', async () => {
    const theme = { ...DEFAULT_THEME, sidebarHideAskBoxes: true };
    const { req } = await call(put, { theme });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { theme } });
    expect(req.user?.theme).toEqual(theme);
    const { res } = await call(me, undefined, req.user!);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ theme }));
  });

  it('stores Appearance\'s terminal font, and an explicit maple switches back, stored as absent', async () => {
    const theme = { ...DEFAULT_THEME, terminalFont: 'jetbrains' };
    const { req } = await call(put, { theme });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { theme } });
    const { res } = await call(me, undefined, req.user!);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ theme }));
    const { req: back } = await call(put, { theme: { ...DEFAULT_THEME, terminalFont: 'maple' } }, req.user!);
    expect(prisma.user.update).toHaveBeenLastCalledWith({ where: { id: 'u1' }, data: { theme: DEFAULT_THEME } });
    expect(back.user?.theme).toEqual(DEFAULT_THEME);
  });

  it('keeps a stored light palette when a stale tab saves a theme without palette', async () => {
    const lightUser = { ...storedUser, theme: { version: 1, background: { mode: 'hyperspace' }, palette: 'light', sidebarActivity: true, sidebarMetaTerm: false } };
    const stale = { version: 1, background: { mode: 'solid', color: '#000000' } };
    const { res } = await call(put, { theme: stale }, lightUser as unknown as Express.User);
    const expected = { version: 1, background: { mode: 'solid', color: '#000000' }, palette: 'light', sidebarActivity: true, sidebarMetaTerm: false, sidebarShowStopped: false, sidebarAskChats: false, sidebarHideAskBoxes: false };
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { theme: expected } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ theme: expected }));
  });

  it('switches a light user back to dark on an explicit palette: dark, storing dark as absent', async () => {
    const lightUser = { ...storedUser, theme: { version: 1, background: { mode: 'hyperspace' }, palette: 'light' } };
    const { res } = await call(put, { theme: { ...DEFAULT_THEME, palette: 'dark' } }, lightUser as unknown as Express.User);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { theme: DEFAULT_THEME } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ theme: DEFAULT_THEME }));
  });

  it('serves a stored light palette from /me', async () => {
    const lightUser = { ...storedUser, theme: { version: 1, background: { mode: 'hyperspace' }, palette: 'light' } };
    const { res } = await call(me, undefined, lightUser as unknown as Express.User);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ theme: { ...DEFAULT_THEME, palette: 'light' } }));
  });

  it('still rejects an unknown theme key or a bad palette after the merge', async () => {
    const { res } = await call(put, { theme: { ...DEFAULT_THEME, fonts: 'serif' } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(/unknown keys: fonts/) });
    const { res: res2 } = await call(put, { theme: { ...DEFAULT_THEME, palette: 'system' } });
    expect(res2.status).toHaveBeenCalledWith(400);
    expect(res2.json).toHaveBeenCalledWith({ error: expect.stringMatching(/palette/) });
    expect(prisma.user.update).not.toHaveBeenCalled();
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

  it('serves pushMutesChat from /me and reads a row without it as false', async () => {
    const { res } = await call(me, undefined);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ pushMutesChat: false }));
    const { pushMutesChat: _drop, ...legacy } = storedUser;
    const { res: res2 } = await call(me, undefined, legacy as unknown as Express.User);
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ pushMutesChat: false }));
  });

  it('stores pushMutesChat, mirrors it onto the session user and returns it', async () => {
    const { req, res } = await call(put, { pushMutesChat: true });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { pushMutesChat: true } });
    expect(req.user?.pushMutesChat).toBe(true);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ pushMutesChat: true }));
  });

  it('rejects a non-boolean pushMutesChat and writes nothing', async () => {
    const { res } = await call(put, { pushMutesChat: 'yes' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(/pushMutesChat/) });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('serves boxIdleNotify from /me, reading a row without it as on, and stores a choice', async () => {
    const { res } = await call(me, undefined);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ boxIdleNotify: true }));
    const { req, res: res2 } = await call(put, { boxIdleNotify: false });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { boxIdleNotify: false } });
    expect(req.user?.boxIdleNotify).toBe(false);
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ boxIdleNotify: false }));
  });

  it('rejects a non-boolean boxIdleNotify and writes nothing', async () => {
    const { res } = await call(put, { boxIdleNotify: 'off' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(/boxIdleNotify/) });
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
