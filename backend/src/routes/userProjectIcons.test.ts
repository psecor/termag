// Project icons' routes: 404 user_projects_disabled with the flag
// off and nothing read or written; on, the picker's view, and a choice checked before it's stored. No
// route serves an image: each is inline in the view that names it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

vi.mock('../middleware/auth', () => {
  const auth = (req: { headers: Record<string, string>; user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.headers['x-test-user']) { res.status(401).json({ error: 'Unauthorized' }); return; }
    req.user = { id: req.headers['x-test-user'], unixUsername: 'pat' };
    next();
  };
  return { requireAuth: auth, requireAuthOrAgentToken: auth };
});
const flag = vi.hoisted(() => ({ on: true }));
vi.mock('../services/userProjects', () => ({ userProjectsEnabled: vi.fn(async () => flag.on) }));
const push = vi.hoisted(() => ({ notifyWorkspaceChange: vi.fn() }));
vi.mock('../services/workspaceEvents', () => push);
const store = vi.hoisted(() => ({
  saveUpload: vi.fn(async (): Promise<{ ok: true; id: string; mimeType: string } | { ok: false; error: string }> => ({ ok: true, id: 'up1', mimeType: 'image/png' })),
  projectIconsFor: vi.fn(async (_u: string, id: string) => (id === 'p1' ? { choice: 'auto', imageId: null, upload: null, repos: [] } : null)),
  setProjectIcon: vi.fn(async () => ({ status: 200, body: { ok: true } })),
  projectRepoKeys: vi.fn(async (_u: string, id: string) => (id === 'p1' ? ['e2e-org/sample'] : null)),
  repoIcons: vi.fn(async (_u: string, repos: Array<{ repoKey: string; iconId: string | null }>) =>
    repos.map(r => ({ repoKey: r.repoKey, detectedId: r.iconId, checkedAt: null, candidates: [] }))),
  storedRepoIcons: vi.fn(async () => new Map([['e2e-org/other', 'stored-fav']])),
  PROJECT_NOT_FOUND: { error: 'No such project', code: 'user_project_not_found' },
}));
vi.mock('../services/projectIconStore', () => store);
const refresh = vi.hoisted(() => ({
  refreshForPicker: vi.fn(async () => undefined),
  lastBestIcon: vi.fn((_u: string, repoKey: string) => (repoKey === 'e2e-org/sample' ? 'fav' : undefined)),
}));
vi.mock('../services/projectIconRefresh', () => refresh);

const { mountProjectIconRoutes } = await import('./userProjectIcons');

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountProjectIconRoutes(router);
  app.use('/api/user-projects', router);
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/user-projects`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => { vi.clearAllMocks(); flag.on = true; });

const call = (path: string, init: RequestInit & { user?: string | null } = {}) => {
  const { user = 'u1', ...rest } = init;
  return fetch(`${base}${path}`, { ...rest, headers: { ...(rest.headers as Record<string, string>), ...(user ? { 'x-test-user': user } : {}) } });
};

describe('POST /icons', () => {
  it('stores an image sent as a raster type', async () => {
    const res = await call('/icons', { method: 'POST', body: Buffer.from([0x89, 0x50]), headers: { 'content-type': 'image/png' } });
    expect([res.status, await res.json()]).toEqual([201, { id: 'up1', mimeType: 'image/png' }]);
    expect(store.saveUpload).toHaveBeenCalledWith('u1', Buffer.from([0x89, 0x50]));
  });

  it("refuses SVG, ICO and anything that isn't an image type (another site's form can't send one), before storing", async () => {
    for (const type of ['image/svg+xml', 'image/x-icon', 'text/plain', 'application/x-www-form-urlencoded', 'application/json']) {
      const res = await call('/icons', { method: 'POST', body: type === 'application/json' ? '{}' : '<svg/>', headers: { 'content-type': type } });
      expect(res.status).toBe(415);
    }
    expect(store.saveUpload).not.toHaveBeenCalled();
  });

  it('says why the store refused one', async () => {
    store.saveUpload.mockResolvedValueOnce({ ok: false, error: 'Upload a PNG, JPEG, GIF or WebP image' });
    const res = await call('/icons', { method: 'POST', body: Buffer.from('<svg/>'), headers: { 'content-type': 'image/png' } });
    expect([res.status, await res.json()]).toEqual([400, { error: 'Upload a PNG, JPEG, GIF or WebP image', code: 'project_icon_invalid' }]);
  });
});

describe('GET /:id/icons and PUT /:id/icon', () => {
  it("looks for the project's repositories' icons first, then answers the picker's view; 404 for a project that isn't the caller's", async () => {
    expect((await call('/p1/icons')).status).toBe(200);
    expect(refresh.refreshForPicker).toHaveBeenCalledWith('u1', ['e2e-org/sample']);
    expect((await call('/nope/icons')).status).toBe(404);
    expect(refresh.refreshForPicker).toHaveBeenCalledTimes(1);
  });

  it('stores a choice and tells the other tabs, after checking it', async () => {
    const put = (body: unknown) => call('/p1/icon', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect((await put({ choice: 'image', iconId: 'i1' })).status).toBe(200);
    expect(store.setProjectIcon).toHaveBeenCalledWith('u1', 'p1', { ok: true, iconChoice: 'image', iconId: 'i1' });
    expect(push.notifyWorkspaceChange).toHaveBeenCalledWith('u1', 'projects');
    expect((await put({ choice: 'favicon' })).status).toBe(400);
    expect(store.setProjectIcon).toHaveBeenCalledTimes(1);
  });
});

describe('GET /icon-candidates', () => {
  it("looks for the repositories' icons, then answers each one's candidates with the best found, else the one its projects show", async () => {
    const res = await call('/icon-candidates?repos=E2E-org/Sample,e2e-org/other,e2e-org/none');
    expect(res.status).toBe(200);
    expect(refresh.refreshForPicker).toHaveBeenCalledWith('u1', ['e2e-org/sample', 'e2e-org/other', 'e2e-org/none']);
    expect((await res.json()).repos.map((r: { repoKey: string; detectedId: string | null }) => [r.repoKey, r.detectedId]))
      .toEqual([['e2e-org/sample', 'fav'], ['e2e-org/other', 'stored-fav'], ['e2e-org/none', null]]);
  });

  it('refuses anything but 1 to 8 owner/name, before looking', async () => {
    for (const q of ['', '?repos=', '?repos=../x', '?repos=a/b/c', `?repos=${Array.from({ length: 9 }, (_, i) => `o/r${i}`).join(',')}`]) {
      expect((await call(`/icon-candidates${q}`)).status).toBe(400);
    }
    expect(refresh.refreshForPicker).not.toHaveBeenCalled();
  });
});

describe('with user-projects-enabled off', () => {
  it('answers 404 user_projects_disabled everywhere, reading and writing nothing', async () => {
    flag.on = false;
    for (const res of [
      await call('/p1/icons'),
      await call('/icons', { method: 'POST', body: Buffer.from([1]), headers: { 'content-type': 'image/png' } }),
      // Over the body limit too: the flag answers before the body is read.
      await call('/icons', { method: 'POST', body: Buffer.alloc(300 * 1024), headers: { 'content-type': 'image/png' } }),
      await call('/icon-candidates?repos=e2e-org/sample'),
      await call('/p1/icon', { method: 'PUT', body: '{"choice":"auto"}', headers: { 'content-type': 'application/json' } }),
    ]) {
      expect([res.status, (await res.json()).code]).toEqual([404, 'user_projects_disabled']);
    }
    for (const fn of [store.saveUpload, store.projectIconsFor, store.setProjectIcon, refresh.refreshForPicker]) expect(fn).not.toHaveBeenCalled();
  });
});
