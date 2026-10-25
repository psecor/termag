import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { sharingRouter } from './sharing';
import { boolVariation } from '../services/featureFlags';
import { BOX_SHARING_FLAG } from '../services/boxSharingFlag';
import { prisma } from '../db';
import { notifyShareChange } from '../services/statusAudience';

const ada = { id: 'u-ada', unixUsername: 'ada', googleEmail: 'ada@example.test', displayName: 'Ada', defaultAgentProvider: 'claude' };
const bob = { id: 'u-bob', unixUsername: 'bob', googleEmail: 'bob@example.test', displayName: 'Bob', defaultAgentProvider: 'claude' };
let caller: typeof ada = ada;

vi.mock('../db', () => ({
  prisma: {
    project: { findFirst: vi.fn(async () => ({ id: 'p1', userId: 'u-ada', kind: 'standard' })) },
    user: { findUnique: vi.fn(async () => ({ id: 'u-bob' })) },
    projectShare: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    projectInvite: {
      upsert: vi.fn(async () => ({ id: 'inv1', status: 'pending' })),
      findFirst: vi.fn(async () => ({ id: 'inv1', projectId: 'p1', inviteeId: 'u-bob', status: 'pending' })),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async () => []),
  },
}));
vi.mock('../middleware/auth', () => ({
  requireAuth: vi.fn((req: Request, _res: Response, next: NextFunction) => { req.user = caller as never; next(); }),
}));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('../services/statusAudience', () => ({ notifyShareChange: vi.fn() }));

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

/** Runs one route of the sharing router and resolves with the response once it has answered. */
async function call(method: string, path: string, params: Record<string, string> = {}, body: unknown = {}) {
  const layer = (sharingRouter().stack as RouteLayer[]).find(l => l.route?.path === path && l.route.methods[method])!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: { body: unknown }, b: unknown) { this.body = b; answered(); return this; }),
  });
  const req = { headers: {}, params, body } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res;
}

const refused = { error: expect.stringContaining('turned off'), code: 'sharing_disabled' };

describe('sharing routes behind box-sharing-enabled', () => {
  afterEach(() => { vi.clearAllMocks(); caller = ada; });

  it('refuses a new invite while the flag is off for the inviter, before touching the database', async () => {
    const res = await call('post', '/projects/:id/invite', { id: 'p1' }, { inviteeEmail: 'bob@example.test' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(refused);
    expect(boolVariation).toHaveBeenCalledWith(BOX_SHARING_FLAG, ada, false);
    expect(prisma.projectInvite.upsert).not.toHaveBeenCalled();
  });

  it('sends the invite once the flag is on for the inviter', async () => {
    vi.mocked(boolVariation).mockResolvedValueOnce(true);
    const res = await call('post', '/projects/:id/invite', { id: 'p1' }, { inviteeEmail: 'bob@example.test' });
    expect(res.statusCode).toBe(201);
    expect(prisma.projectInvite.upsert).toHaveBeenCalled();
  });

  it('refuses to accept a pending invite while the flag is off for the invitee', async () => {
    caller = bob;
    const res = await call('post', '/invites/:id/accept', { id: 'inv1' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(refused);
    expect(boolVariation).toHaveBeenCalledWith(BOX_SHARING_FLAG, bob, false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts the invite once the flag is on for the invitee', async () => {
    caller = bob;
    vi.mocked(boolVariation).mockResolvedValueOnce(true);
    const res = await call('post', '/invites/:id/accept', { id: 'inv1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(prisma.$transaction).toHaveBeenCalled();
    // Bob's open status sockets re-read his scope at once.
    expect(notifyShareChange).toHaveBeenCalledWith({ userId: 'u-bob' });
  });

  it('keeps listing, declining, revoking and leaving open with the flag off', async () => {
    expect((await call('get', '/invites')).statusCode).toBe(200);
    expect((await call('get', '/projects/:id/shares', { id: 'p1' })).statusCode).toBe(200);
    expect((await call('delete', '/projects/:id/shares/:shareId', { id: 'p1', shareId: 's1' })).body).toEqual({ ok: true });
    caller = bob;
    expect((await call('post', '/invites/:id/decline', { id: 'inv1' })).body).toEqual({ ok: true });
    expect((await call('delete', '/projects/:id/leave', { id: 'p1' })).body).toEqual({ ok: true });
    expect(boolVariation).not.toHaveBeenCalled();
    expect(prisma.projectShare.deleteMany).toHaveBeenCalledWith({ where: { id: 's1', projectId: 'p1' } });
    expect(prisma.projectShare.deleteMany).toHaveBeenCalledWith({ where: { projectId: 'p1', userId: 'u-bob' } });
    expect(notifyShareChange).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(notifyShareChange).toHaveBeenCalledWith({ userId: 'u-bob' });
  });
});

describe('revoking a share', () => {
  // Ada owns p1, Bob owns p2; s-ada is Bob's share on p1, s-bob Ada's on p2.
  const projects = [{ id: 'p1', userId: 'u-ada', kind: 'standard' }, { id: 'p2', userId: 'u-bob', kind: 'standard' }];
  let shares: { id: string; projectId: string; userId: string }[] = [];

  beforeEach(() => {
    shares = [{ id: 's-ada', projectId: 'p1', userId: 'u-bob' }, { id: 's-bob', projectId: 'p2', userId: 'u-ada' }];
    vi.mocked(prisma.project.findFirst).mockImplementation((async ({ where }: { where: { id: string; userId: string } }) =>
      projects.find(p => p.id === where.id && p.userId === where.userId) ?? null) as never);
    vi.mocked(prisma.projectShare.deleteMany).mockImplementation((async ({ where }: { where: Partial<{ id: string; projectId: string; userId: string }> }) => {
      const hit = (s: typeof shares[number]) => Object.entries(where).every(([k, v]) => s[k as keyof typeof s] === v);
      const count = shares.filter(hit).length;
      shares = shares.filter(s => !hit(s));
      return { count };
    }) as never);
  });
  afterEach(() => { vi.mocked(prisma.project.findFirst).mockReset(); vi.mocked(prisma.projectShare.deleteMany).mockReset(); vi.mocked(notifyShareChange).mockClear(); caller = ada; });

  it("removes a share on the caller's own project", async () => {
    const res = await call('delete', '/projects/:id/shares/:shareId', { id: 'p1', shareId: 's-ada' });
    expect(res.body).toEqual({ ok: true });
    expect(shares.map(s => s.id)).toEqual(['s-bob']);
    expect(notifyShareChange).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it("leaves a share on another owner's project alone, naming it through the caller's own project", async () => {
    const res = await call('delete', '/projects/:id/shares/:shareId', { id: 'p1', shareId: 's-bob' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Share not found' });
    expect(shares.map(s => s.id)).toEqual(['s-ada', 's-bob']);
    expect(notifyShareChange).not.toHaveBeenCalled();
  });

  it("refuses a caller who does not own the project, before touching any share", async () => {
    caller = bob;
    const res = await call('delete', '/projects/:id/shares/:shareId', { id: 'p1', shareId: 's-ada' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Project not found' });
    expect(prisma.projectShare.deleteMany).not.toHaveBeenCalled();
    expect(shares).toHaveLength(2);
  });

  it('answers 404 for a share that is already gone', async () => {
    expect((await call('delete', '/projects/:id/shares/:shareId', { id: 'p1', shareId: 's-ada' })).body).toEqual({ ok: true });
    expect((await call('delete', '/projects/:id/shares/:shareId', { id: 'p1', shareId: 's-ada' })).statusCode).toBe(404);
  });

  it('announces a leave only when there was a share to leave', async () => {
    caller = bob;
    expect((await call('delete', '/projects/:id/leave', { id: 'p1' })).body).toEqual({ ok: true });
    expect(notifyShareChange).toHaveBeenCalledWith({ userId: 'u-bob' });
    vi.mocked(notifyShareChange).mockClear();
    expect((await call('delete', '/projects/:id/leave', { id: 'p1' })).body).toEqual({ ok: true });
    expect(notifyShareChange).not.toHaveBeenCalled();
  });
});
