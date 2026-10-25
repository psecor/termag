import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response } from 'express';
vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../services/admin/adminAccess', () => ({ touchLastSeen: vi.fn() }));
import { usersRouter } from './users';

interface RouteLayer { route?: { path: string; stack: { handle: RequestHandler }[] } }

/** Runs GET /search through the router's real middleware and resolves once it has answered. */
async function search(router: ReturnType<typeof usersRouter>, req: Partial<Request>) {
  const layer = (router.stack as RouteLayer[]).find(l => l.route?.path === '/search')!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    body: undefined as unknown,
    setHeader: vi.fn(),
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: { body: unknown }, body: unknown) { this.body = body; answered(); return this; }),
  });
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle({ headers: {}, query: {}, ip: '10.0.0.1', ...req } as Request, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res;
}

const ada = { id: 'u1', googleEmail: 'ada@x.test' } as Express.User;

describe('GET /api/users/search', () => {
  it('answers the signed-in caller, passing their id so they are left out', async () => {
    const found = [{ email: 'gus@x.test', displayName: 'Gus' }];
    const search_ = vi.fn(async () => found);
    const res = await search(usersRouter({ search: search_ }), { user: ada, query: { q: 'gu' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ people: found });
    expect(search_).toHaveBeenCalledWith('gu', 'u1');
  });

  it('refuses anyone without a session; an agent token is not one', async () => {
    const search_ = vi.fn(async () => []);
    const res = await search(usersRouter({ search: search_ }), { query: { q: 'gu' }, headers: { authorization: 'Bearer agent-token' } });
    expect(res.statusCode).toBe(401);
    expect(search_).not.toHaveBeenCalled();
  });

  it('refuses a query over 100 characters, and treats a missing or repeated q as empty', async () => {
    const search_ = vi.fn(async () => []);
    const router = usersRouter({ search: search_ });
    expect((await search(router, { user: ada, query: { q: 'a'.repeat(101) } })).statusCode).toBe(400);
    await search(router, { user: ada, query: {} });
    await search(router, { user: ada, query: { q: ['a', 'b'] } as never });
    expect(search_.mock.calls).toEqual([['', 'u1'], ['', 'u1']]);
  });

  it('rate-limits each caller: 30 at once, then 429', async () => {
    const router = usersRouter({ search: vi.fn(async () => []) });
    for (let i = 0; i < 30; i++) expect((await search(router, { user: ada, query: { q: 'gu' } })).statusCode).toBe(200);
    expect((await search(router, { user: ada, query: { q: 'gu' } })).statusCode).toBe(429);
    expect((await search(router, { user: { ...ada, id: 'u2' }, query: { q: 'gu' } })).statusCode).toBe(200);
  });
});
