// GET /api/user-projects and /:id, and
// POST /api/user-projects: 404
// user_projects_disabled with the flag off and nothing read or written; on, the
// backfill first, then only the caller's own projects.
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
const up = vi.hoisted(() => ({
  userProjectsEnabled: vi.fn(async () => true),
  ensureUserProjects: vi.fn(async () => ({ attached: 0, created: 0 })),
  createPersonUserProject: vi.fn(async (): Promise<{ ok: true; id: string } | { ok: false; taken: { id: string; name: string; archived: boolean } }> => ({ ok: true, id: 'u1-p' })),
  addUserProjectRepo: vi.fn(async (): Promise<{ ok: true } | { ok: false; status: 400 | 404 | 409; code: string; error: string }> => ({ ok: true })),
}));
vi.mock('../services/userProjects', async () => {
  const actual = await vi.importActual<typeof import('../services/userProjects')>('../services/userProjects');
  return { ...up, planNewUserProject: actual.planNewUserProject };
});
const multi = vi.hoisted(() => ({ on: true }));
vi.mock('../services/multiRepoFlag', () => ({ multiRepoEnabled: vi.fn(async () => multi.on) }));
const views = vi.hoisted(() => ({
  listUserProjectViews: vi.fn(async (userId: string) => [{ id: `${userId}-p`, name: 'termag' }]),
  userProjectViewFor: vi.fn(async (userId: string, id: string) => (id === `${userId}-p` ? { id, name: 'termag' } : null)),
}));
vi.mock('../services/userProjectViews', () => views);
const writes = vi.hoisted(() => ({
  patchUserProjectFor: vi.fn(async (_u: unknown, id: string, body: unknown) => ({ status: 200, body: { id, body } })),
  archivePlanFor: vi.fn(async (_u: unknown, id: string) => ({ status: 200, body: { id, boxes: [] } })),
}));
vi.mock('./userProjectWrites', () => writes);
const icons = vi.hoisted(() => ({ refreshDueIconsInBackground: vi.fn(async () => undefined), refreshForPicker: vi.fn(), lastBestIcon: vi.fn() }));
vi.mock('../services/projectIconRefresh', () => icons);

const { userProjectsRouter } = await import('./userProjects');

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/user-projects', userProjectsRouter());
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/user-projects`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => { vi.clearAllMocks(); multi.on = true; });

const get = async (path: string, user: string | null = 'u1') => {
  const res = await fetch(`${base}${path}`, { headers: user ? { 'x-test-user': user } : {} });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const post = async (body: unknown, user: string | null = 'u1') => {
  const res = await fetch(base, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('GET /api/user-projects', () => {
  it("answers the caller's projects, after the backfill", async () => {
    expect(await get('')).toEqual({ status: 200, body: { projects: [{ id: 'u1-p', name: 'termag' }] } });
    expect(up.ensureUserProjects).toHaveBeenCalledWith('u1');
    expect(views.listUserProjectViews).toHaveBeenCalledWith('u1');
    // Then, not awaited, a look for their repositories' icons that are due.
    expect(icons.refreshDueIconsInBackground).toHaveBeenCalledWith('u1');
  });

  it("answers one of the caller's, and 404 for anyone else's", async () => {
    expect(await get('/u1-p')).toEqual({ status: 200, body: { id: 'u1-p', name: 'termag' } });
    expect(await get('/u1-p', 'u2')).toEqual({ status: 404, body: { error: 'No such project', code: 'user_project_not_found' } });
    expect(views.userProjectViewFor).toHaveBeenLastCalledWith('u2', 'u1-p');
  });

  it('answers 404 user_projects_disabled with the flag off, reading and writing nothing', async () => {
    up.userProjectsEnabled.mockResolvedValue(false);
    for (const path of ['', '/u1-p']) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('user_projects_disabled');
    }
    expect(up.ensureUserProjects).not.toHaveBeenCalled();
    expect(views.listUserProjectViews).not.toHaveBeenCalled();
    expect(views.userProjectViewFor).not.toHaveBeenCalled();
    up.userProjectsEnabled.mockResolvedValue(true);
  });

  it("tells the person's other tabs when the backfill attached a checkout (its raw SQL pushes nothing)", async () => {
    const { setWorkspaceChangeCallback } = await import('../services/workspaceEvents');
    const pushed = vi.fn();
    setWorkspaceChangeCallback(pushed);
    await get('');
    expect(pushed).not.toHaveBeenCalled();
    up.ensureUserProjects.mockResolvedValueOnce({ attached: 1, created: 0 });
    await get('');
    expect(pushed).toHaveBeenCalledWith('u1', 'projects');
    setWorkspaceChangeCallback(null);
  });

  it('still answers when the backfill fails', async () => {
    up.ensureUserProjects.mockRejectedValueOnce(new Error('db down'));
    expect((await get('')).status).toBe(200);
  });

  it('needs a sign-in', async () => {
    expect((await get('', null)).status).toBe(401);
  });
});

describe('POST /api/user-projects', () => {
  const TERMAG = 'https://github.com/example-org/termag.git';

  it("makes the caller's project after the backfill, and answers its view", async () => {
    expect(await post({ name: ' termag ', repos: [{ url: TERMAG }] })).toEqual({ status: 201, body: { id: 'u1-p', name: 'termag' } });
    expect(up.ensureUserProjects).toHaveBeenCalledWith('u1');
    expect(up.createPersonUserProject).toHaveBeenCalledWith('u1', {
      name: 'termag', repoSetKey: 'example-org/termag',
      repos: [{ repoKey: 'example-org/termag', name: 'termag', url: TERMAG, defaultBranch: null }],
    });
    expect(views.userProjectViewFor).toHaveBeenCalledWith('u1', 'u1-p');
    // Its repositories' icons at once, past the list's throttle.
    expect(icons.refreshDueIconsInBackground).toHaveBeenCalledWith('u1', {}, { force: true });
  });

  it("tells the person's other tabs about a project made, so the sidebar lists it with no session yet", async () => {
    const { setWorkspaceChangeCallback } = await import('../services/workspaceEvents');
    const pushed = vi.fn();
    setWorkspaceChangeCallback(pushed);
    await post({ name: 'scratch', repos: [] });
    expect(pushed).toHaveBeenCalledWith('u1', 'projects');
    setWorkspaceChangeCallback(null);
  });

  it('makes one with no repository', async () => {
    expect((await post({ name: 'scratch', repos: [] })).status).toBe(201);
    expect(up.createPersonUserProject).toHaveBeenCalledWith('u1', { name: 'scratch', repoSetKey: '', repos: [] });
  });

  it('answers 409 user_project_name_taken with the project it clashes with, and whether it is archived', async () => {
    up.createPersonUserProject.mockResolvedValueOnce({ ok: false, taken: { id: 'u1-old', name: 'Termag', archived: true } });
    expect(await post({ name: 'termag', repos: [] })).toEqual({
      status: 409,
      body: { error: 'You already have a project called Termag', code: 'user_project_name_taken', field: 'name', projectId: 'u1-old', archived: true },
    });
  });

  it('answers 400 for a bad name or repository, naming the field and the repository, and writes nothing', async () => {
    expect(await post({ name: '', repos: [] })).toMatchObject({ status: 400, body: { code: 'user_project_invalid', field: 'name' } });
    expect(await post({ name: 'p', repos: [{ url: 'https://gitlab.com/a/b' }] }))
      .toMatchObject({ status: 400, body: { code: 'user_project_invalid', field: 'repos', repo: 'https://gitlab.com/a/b' } });
    expect(up.createPersonUserProject).not.toHaveBeenCalled();
  });

  it('answers 404 user_projects_disabled with the flag off, reading and writing nothing', async () => {
    up.userProjectsEnabled.mockResolvedValueOnce(false);
    expect(await post({ name: 'termag', repos: [] })).toMatchObject({ status: 404, body: { code: 'user_projects_disabled' } });
    expect(up.ensureUserProjects).not.toHaveBeenCalled();
    expect(up.createPersonUserProject).not.toHaveBeenCalled();
  });

  it('takes one repository at most while multi-repo projects are off for the caller', async () => {
    multi.on = false;
    const two = [{ url: TERMAG }, { url: 'https://github.com/example-org/termag-desktop' }];
    expect(await post({ name: 'both', repos: two })).toMatchObject({ status: 400, body: { field: 'repos', error: 'Projects with more than one repository are not on for you' } });
    expect((await post({ name: 'one', repos: [{ url: TERMAG }] })).status).toBe(201);
  });

  it('answers 503 and makes nothing when the backfill fails, so it never takes a name a checkout would get', async () => {
    up.ensureUserProjects.mockRejectedValueOnce(new Error('db down'));
    expect(await post({ name: 'termag', repos: [] })).toEqual({ status: 503, body: { error: 'Could not read your projects; try again', code: 'user_projects_unavailable' } });
    expect(up.createPersonUserProject).not.toHaveBeenCalled();
  });

  it('answers 500 when the write fails', async () => {
    up.createPersonUserProject.mockRejectedValueOnce(new Error('db down'));
    expect(await post({ name: 'termag', repos: [] })).toEqual({ status: 500, body: { error: 'Failed to make the project' } });
  });

  it('needs a sign-in', async () => {
    expect((await post({ name: 'termag' }, null)).status).toBe(401);
  });
});

describe('PATCH /api/user-projects/:id and GET /:id/archive-plan', () => {
  const patch = async (path: string, body: unknown, user: string | null = 'u1') => {
    const res = await fetch(`${base}${path}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  it("hands the body to the project's writes, after the backfill", async () => {
    expect(await patch('/up1', { name: 'Termag web' })).toEqual({ status: 200, body: { id: 'up1', body: { name: 'Termag web' } } });
    expect(writes.patchUserProjectFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'up1', { name: 'Termag web' });
    expect(up.ensureUserProjects).toHaveBeenCalledWith('u1');
    expect(await get('/up1/archive-plan')).toEqual({ status: 200, body: { id: 'up1', boxes: [] } });
  });

  it('answers 404 user_projects_disabled with the flag off, changing nothing', async () => {
    up.userProjectsEnabled.mockResolvedValue(false);
    expect((await patch('/up1', { archived: true })).body.code).toBe('user_projects_disabled');
    expect((await get('/up1/archive-plan')).body.code).toBe('user_projects_disabled');
    expect(writes.patchUserProjectFor).not.toHaveBeenCalled();
    expect(writes.archivePlanFor).not.toHaveBeenCalled();
    up.userProjectsEnabled.mockResolvedValue(true);
  });

  it('needs a sign-in', async () => {
    expect((await patch('/up1', { archived: true }, null)).status).toBe(401);
    expect((await get('/up1/archive-plan', null)).status).toBe(401);
  });
});

describe('POST /api/user-projects/:id/repos', () => {
  const addRepo = async (id: string, body: unknown, user: string | null = 'u1') => {
    const res = await fetch(`${base}/${id}/repos`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  it("adds the repository to the caller's project and answers its view", async () => {
    expect(await addRepo('u1-p', { url: 'https://github.com/o/r' })).toEqual({ status: 200, body: { id: 'u1-p', name: 'termag' } });
    expect(up.addUserProjectRepo).toHaveBeenCalledWith('u1', 'u1-p', { url: 'https://github.com/o/r' }, 8);
  });

  it("tells the person's other tabs, so the sidebar shows the project's repositories", async () => {
    const { setWorkspaceChangeCallback } = await import('../services/workspaceEvents');
    const pushed = vi.fn();
    setWorkspaceChangeCallback(pushed);
    await addRepo('u1-p', { url: 'https://github.com/o/r' });
    expect(pushed).toHaveBeenCalledWith('u1', 'projects');
    pushed.mockClear();
    up.addUserProjectRepo.mockResolvedValueOnce({ ok: false, status: 409, code: 'user_project_repo_exists', error: 'no' });
    await addRepo('u1-p', { url: 'https://github.com/o/r' });
    expect(pushed).not.toHaveBeenCalled();
    setWorkspaceChangeCallback(null);
  });

  it('takes one repository at most while multi-repo projects are off', async () => {
    multi.on = false;
    await addRepo('u1-p', { url: 'https://github.com/o/r' });
    expect(up.addUserProjectRepo).toHaveBeenCalledWith('u1', 'u1-p', { url: 'https://github.com/o/r' }, 1);
  });

  it('answers the refusal as it is', async () => {
    up.addUserProjectRepo.mockResolvedValueOnce({ ok: false, status: 409, code: 'user_project_repo_limit', error: 'A project holds at most 8 repositories' });
    expect(await addRepo('u1-p', { url: 'https://github.com/o/r' }))
      .toEqual({ status: 409, body: { error: 'A project holds at most 8 repositories', code: 'user_project_repo_limit' } });
  });

  it('answers 404 user_projects_disabled with the flag off, writing nothing', async () => {
    up.userProjectsEnabled.mockResolvedValueOnce(false);
    expect(await addRepo('u1-p', { url: 'https://github.com/o/r' })).toMatchObject({ status: 404, body: { code: 'user_projects_disabled' } });
    expect(up.addUserProjectRepo).not.toHaveBeenCalled();
  });

  it('needs a sign-in', async () => {
    expect((await addRepo('u1-p', {}, null)).status).toBe(401);
  });
});
