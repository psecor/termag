/**
 * My files in /auth/me and its preferences:
 * behind project-files-enabled, /me carries `myFilesSpace` and `myFilesOnBoxes`;
 * the preferences write takes "Put My files on my boxes" (off removes the grants,
 * on grants it to every capable box) and "Use an existing space as My files…";
 * POST /auth/me/my-files makes it as the Files tab opens.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { authRouter } from './auth';
import { prisma } from '../db';
import * as pf from '../services/projectFiles';

vi.mock('../db', () => ({ prisma: { user: { upsert: vi.fn(), update: vi.fn() } } }));
vi.mock('../services/featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/featureFlags')>()),
  boolVariation: vi.fn(async () => false),
}));
const on = vi.hoisted(() => ({ value: false }));
vi.mock('../services/projectFiles', () => ({
  projectFilesEnabled: vi.fn(async () => on.value),
  myFilesSpaceName: vi.fn(async () => 'ana-my-files'),
  useExistingSpace: vi.fn(),
  removeMyFilesGrants: vi.fn(async () => 2),
  grantMyFilesEverywhere: vi.fn(async () => 2),
  ensureMyFiles: vi.fn(),
}));

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

function handler(router: Router, path: string, method: string): RequestHandler {
  const layer = (router.stack as RouteLayer[]).find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`no route ${method} ${path}`);
  return layer.route.stack[0].handle;
}

const storedUser = {
  id: 'u1', googleId: 'g1', googleEmail: 'ana@termag.local', unixUsername: 'ana', displayName: 'Ana',
  defaultAgentProvider: 'claude', claudeGatewayEnabled: true, dotfilesRepoUrl: null,
  slackUserId: null, discordUserId: null, createdAt: new Date(0), theme: {}, pushMutesChat: false, uiMode: null,
  chatNudgeDismissedAt: null, boxPlacement: null, myFilesSpaceId: 's-mine', myFilesOnBoxes: true, onboardedAt: new Date(0),
};

function call(h: RequestHandler, body: unknown, user: Record<string, unknown> = { ...storedUser }) {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  res.status.mockReturnValue(res);
  const req = { body, user, query: {} } as unknown as Request;
  return Promise.resolve(h(req, res, () => {})).then(() => ({ req, res }));
}

describe('My files in /auth/me', () => {
  let put: RequestHandler;
  let me: RequestHandler;
  let ensure: RequestHandler;

  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'local');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BIND_HOST', '127.0.0.1');
    const router = authRouter();
    put = handler(router, '/me/preferences', 'put');
    me = handler(router, '/me', 'get');
    ensure = handler(router, '/me/my-files', 'post');
    on.value = false;
    vi.clearAllMocks();
    vi.mocked(prisma.user.update).mockImplementation(async ({ data }) => ({ ...storedUser, ...(data as object) }) as never);
  });

  it('is left out, and refused, with project-files-enabled off', async () => {
    const { res } = await call(me, undefined);
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('myFilesSpace');
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('myFilesOnBoxes');
    for (const body of [{ myFilesOnBoxes: false }, { myFilesSpace: 'ana-notes' }]) {
      const r = await call(put, body);
      expect(r.res.status).toHaveBeenCalledWith(403);
      expect(r.res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'project_files_disabled' }));
    }
    const made = await call(ensure, undefined);
    expect(made.res.status).toHaveBeenCalledWith(404);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(pf.removeMyFilesGrants).not.toHaveBeenCalled();
  });

  it('carries the space and the switch with the flag on', async () => {
    on.value = true;
    const { res } = await call(me, undefined);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ myFilesSpace: 'ana-my-files', myFilesOnBoxes: true }));
  });

  it('off removes My files from the boxes; on puts it on every capable one; anything else is refused', async () => {
    on.value = true;
    const off = await call(put, { myFilesOnBoxes: false });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { myFilesOnBoxes: false } });
    expect(pf.removeMyFilesGrants).toHaveBeenCalledWith('u1');
    expect(pf.grantMyFilesEverywhere).not.toHaveBeenCalled();
    expect(off.req.user).toMatchObject({ myFilesOnBoxes: false });
    expect(off.res.json).toHaveBeenCalledWith(expect.objectContaining({ myFilesOnBoxes: false }));
    await call(put, { myFilesOnBoxes: true });
    expect(pf.grantMyFilesEverywhere).toHaveBeenCalledTimes(1);
    const bad = await call(put, { myFilesOnBoxes: 'yes' });
    expect(bad.res.status).toHaveBeenCalledWith(400);
  });

  it('uses an existing space as My files, passing a refusal through and changing nothing', async () => {
    on.value = true;
    vi.mocked(pf.useExistingSpace).mockResolvedValueOnce({ ok: false, status: 409, code: 'space_in_use', error: 'That space is already a project\'s files' });
    const refused = await call(put, { myFilesSpace: 'ana-termag' });
    expect(pf.useExistingSpace).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), { kind: 'mine' }, 'ana-termag');
    expect(refused.res.status).toHaveBeenCalledWith(409);
    expect(refused.res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'space_in_use' }));
    expect(prisma.user.update).not.toHaveBeenCalled();
    vi.mocked(pf.useExistingSpace).mockResolvedValueOnce({ ok: true, space: { id: 's2', name: 'ana-notes' }, previous: 's-mine' });
    vi.mocked(pf.myFilesSpaceName).mockResolvedValueOnce('ana-notes');
    const used = await call(put, { myFilesSpace: ' ana-notes ' });
    expect(pf.useExistingSpace).toHaveBeenLastCalledWith(expect.anything(), { kind: 'mine' }, 'ana-notes');
    expect(used.res.status).not.toHaveBeenCalled();
    expect(used.res.json).toHaveBeenCalledWith(expect.objectContaining({ myFilesSpace: 'ana-notes' }));
    const empty = await call(put, { myFilesSpace: '' });
    expect(empty.res.status).toHaveBeenCalledWith(400);
  });

  it('makes My files as the Files tab opens, and grants it to every capable box on each call while it is on', async () => {
    on.value = true;
    vi.mocked(pf.ensureMyFiles).mockResolvedValueOnce({ space: { id: 's-mine', name: 'ana-my-files' }, made: true });
    const first = await call(ensure, undefined);
    expect(first.res.json).toHaveBeenCalledWith({ myFilesSpace: 'ana-my-files', myFilesOnBoxes: true });
    expect(pf.grantMyFilesEverywhere).toHaveBeenCalledTimes(1);
    // A retry after a grant pass that failed: the space exists now, and the boxes still get it (Bugbot, #1829).
    vi.mocked(pf.ensureMyFiles).mockResolvedValueOnce({ space: { id: 's-mine', name: 'ana-my-files' }, made: false });
    await call(ensure, undefined);
    expect(pf.grantMyFilesEverywhere).toHaveBeenCalledTimes(2);
    // Kept off the boxes: made, but not granted.
    vi.mocked(pf.ensureMyFiles).mockResolvedValueOnce({ space: { id: 's-mine', name: 'ana-my-files' }, made: true });
    await call(ensure, undefined, { ...storedUser, myFilesOnBoxes: false });
    expect(pf.grantMyFilesEverywhere).toHaveBeenCalledTimes(2);
  });
});
