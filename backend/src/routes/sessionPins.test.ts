import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Session pins: the routes, with the database, the flag and the push stubbed.
const db = vi.hoisted(() => ({
  workstream: { findFirst: vi.fn() },
  sessionPin: { findMany: vi.fn(), createMany: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
}));
const flag = vi.hoisted(() => ({ on: true }));
vi.mock('../db', () => ({ prisma: db }));
vi.mock('../services/userProjects', () => ({ userProjectsEnabled: vi.fn(async () => flag.on) }));
vi.mock('../services/workspaceEvents', () => ({ notifyWorkspaceChange: vi.fn() }));
vi.mock('../middleware/auth', () => ({
  requireAuth: vi.fn((req: Request, _res: Response, next: NextFunction) => { req.user = { id: 'u1', unixUsername: 'ada' } as never; next(); }),
}));

import { sessionPinsRouter } from './sessionPins';
import { notifyWorkspaceChange } from '../services/workspaceEvents';
import { userProjectsEnabled } from '../services/userProjects';
import { SIDEBAR_SESSION } from '../services/sessionPins';

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

/** Runs the route's handlers in order, as Express would, until one answers. */
async function call(method: 'get' | 'put' | 'delete', path: string, params: Record<string, string> = {}) {
  const layer = (sessionPinsRouter().stack as RouteLayer[]).find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined as unknown,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: { body: unknown }, b: unknown) { this.body = b; answered(); return this; }),
  });
  const req = { params, query: {}, headers: {}, body: {} } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    let failed: unknown;
    await handle(req, res as unknown as Response, (err?: unknown) => { advanced = err === undefined; failed = err; });
    // asyncHandler forwards on a microtask.
    await new Promise(r => setImmediate(r));
    if (failed !== undefined) throw failed;
    if (!advanced) break;
  }
  await done;
  return res as typeof res & { body: Record<string, unknown> };
}

const notify = vi.mocked(notifyWorkspaceChange);
const at = new Date('2026-11-13T12:00:00Z');
const row = (id: string, name = 'main', projectId = 'p1') => ({ createdAt: at, workstream: { id, name, projectId } });

beforeEach(() => {
  vi.clearAllMocks();
  flag.on = true;
  db.workstream.findFirst.mockResolvedValue({ archived: false, project: { archived: false } });
  db.sessionPin.createMany.mockResolvedValue({ count: 1 });
  db.sessionPin.findUnique.mockResolvedValue(row('ws1'));
  db.sessionPin.deleteMany.mockResolvedValue({ count: 1 });
  db.sessionPin.findMany.mockResolvedValue([row('ws1'), row('ws2', 'side')]);
});

describe('GET /api/session-pins', () => {
  it("lists the caller's pins on live sessions they can see, oldest first", async () => {
    const r = await call('get', '/');
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ pins: [
      { workstreamId: 'ws1', projectId: 'p1', workstream: 'main', pinnedAt: at.toISOString() },
      { workstreamId: 'ws2', projectId: 'p1', workstream: 'side', pinnedAt: at.toISOString() },
    ] });
    const q = db.sessionPin.findMany.mock.calls[0][0];
    expect(q.where).toEqual({
      userId: 'u1',
      workstream: { AND: [
        { archived: false, project: { archived: false, OR: [{ userId: 'u1' }, { shares: { some: { userId: 'u1' } } }] } },
        SIDEBAR_SESSION,
      ] },
    });
    expect(q.orderBy).toEqual([{ createdAt: 'asc' }, { workstreamId: 'asc' }]);
  });

  it('is 404 session_pins_disabled with user-projects-enabled off, and reads nothing', async () => {
    flag.on = false;
    const r = await call('get', '/');
    expect(r.statusCode).toBe(404);
    expect(r.body.code).toBe('session_pins_disabled');
    expect(db.sessionPin.findMany).not.toHaveBeenCalled();
    expect(vi.mocked(userProjectsEnabled).mock.calls[0][0]).toMatchObject({ id: 'u1' });
  });
});

describe('PUT /api/session-pins/:workstreamId', () => {
  it('pins a session the caller can see and tells their other tabs', async () => {
    const r = await call('put', '/:workstreamId', { workstreamId: 'ws1' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ pin: { workstreamId: 'ws1', projectId: 'p1', workstream: 'main', pinnedAt: at.toISOString() } });
    expect(db.workstream.findFirst.mock.calls[0][0].where).toEqual({ AND: [
      { id: 'ws1', project: { OR: [{ userId: 'u1' }, { shares: { some: { userId: 'u1' } } }] } },
      SIDEBAR_SESSION,
    ] });
    expect(db.sessionPin.createMany).toHaveBeenCalledWith({ data: [{ userId: 'u1', workstreamId: 'ws1' }], skipDuplicates: true });
    expect(notify).toHaveBeenCalledWith('u1', 'pins');
  });

  it('answers an existing pin again without a push', async () => {
    db.sessionPin.createMany.mockResolvedValue({ count: 0 });
    const r = await call('put', '/:workstreamId', { workstreamId: 'ws1' });
    expect(r.statusCode).toBe(200);
    expect((r.body.pin as { workstreamId: string }).workstreamId).toBe('ws1');
    expect(notify).not.toHaveBeenCalled();
  });

  it("is 404 for a session the caller can't see, or that is gone, and writes nothing", async () => {
    db.workstream.findFirst.mockResolvedValue(null);
    const r = await call('put', '/:workstreamId', { workstreamId: 'theirs' });
    expect(r.statusCode).toBe(404);
    expect(r.body.code).toBe('session_not_found');
    expect(db.sessionPin.createMany).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('is 404 when the session is deleted between the read and the insert', async () => {
    db.sessionPin.createMany.mockRejectedValue(Object.assign(new Error('fk'), { code: 'P2003' }));
    const r = await call('put', '/:workstreamId', { workstreamId: 'ws1' });
    expect(r.statusCode).toBe(404);
    expect(r.body.code).toBe('session_not_found');
    expect(notify).not.toHaveBeenCalled();
  });

  it('is 409 session_archived for an archived session or one in an archived project', async () => {
    db.workstream.findFirst.mockResolvedValue({ archived: true, project: { archived: false } });
    expect((await call('put', '/:workstreamId', { workstreamId: 'ws1' })).body.code).toBe('session_archived');
    db.workstream.findFirst.mockResolvedValue({ archived: false, project: { archived: true } });
    const r = await call('put', '/:workstreamId', { workstreamId: 'ws1' });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('session_archived');
    expect(db.sessionPin.createMany).not.toHaveBeenCalled();
  });

  it('is 400 for something that is not an id, before any read', async () => {
    for (const id of ['', 'a b', 'x'.repeat(65), '../p1', 'ws1;drop']) {
      const r = await call('put', '/:workstreamId', { workstreamId: id });
      expect(r.statusCode).toBe(400);
      expect(r.body.code).toBe('session_pin_invalid');
    }
    expect(db.workstream.findFirst).not.toHaveBeenCalled();
  });

  it('is 404 session_pins_disabled with the flag off, and writes nothing', async () => {
    flag.on = false;
    const r = await call('put', '/:workstreamId', { workstreamId: 'ws1' });
    expect(r.statusCode).toBe(404);
    expect(r.body.code).toBe('session_pins_disabled');
    expect(db.workstream.findFirst).not.toHaveBeenCalled();
    expect(db.sessionPin.createMany).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/session-pins/:workstreamId', () => {
  it("removes the caller's own pin only, and tells their other tabs", async () => {
    const r = await call('delete', '/:workstreamId', { workstreamId: 'ws1' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ pinned: false });
    expect(db.sessionPin.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', workstreamId: 'ws1' } });
    expect(notify).toHaveBeenCalledWith('u1', 'pins');
  });

  it('is a quiet 200 when it was not pinned', async () => {
    db.sessionPin.deleteMany.mockResolvedValue({ count: 0 });
    const r = await call('delete', '/:workstreamId', { workstreamId: 'ws9' });
    expect(r.statusCode).toBe(200);
    expect(notify).not.toHaveBeenCalled();
  });

  it('is 404 session_pins_disabled with the flag off, and deletes nothing', async () => {
    flag.on = false;
    const r = await call('delete', '/:workstreamId', { workstreamId: 'ws1' });
    expect(r.statusCode).toBe(404);
    expect(db.sessionPin.deleteMany).not.toHaveBeenCalled();
  });

  it('is 400 for something that is not an id', async () => {
    const r = await call('delete', '/:workstreamId', { workstreamId: 'a/b' });
    expect(r.statusCode).toBe(400);
    expect(db.sessionPin.deleteMany).not.toHaveBeenCalled();
  });
});
