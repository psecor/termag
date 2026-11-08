import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { workstreamsRouter } from './workstreams';
import { prisma } from '../db';

// Archive in a space's Files (chat-nested-agents-enabled): the row's explorerArchivedAt, owner only, nothing else.
vi.mock('../db', () => ({
  prisma: {
    workstream: { findFirst: vi.fn(), update: vi.fn(async ({ data }: { data: { explorerArchivedAt: Date | null } }) => ({ id: 'ws1', ...data })) },
  },
}));
vi.mock('../middleware/auth', () => ({
  requireAuth: vi.fn((req: Request, _res: Response, next: NextFunction) => { req.user = { id: 'u1', unixUsername: 'ada' } as never; next(); }),
}));
vi.mock('../middleware/parkedBox', () => ({ refuseParkedBox: () => (_q: Request, _s: Response, next: NextFunction) => next() }));
vi.mock('../middleware/unreadySetup', () => ({ refuseUnreadySetup: () => (_q: Request, _s: Response, next: NextFunction) => next() }));
vi.mock('../services/agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), projectAgentCapabilities: vi.fn(() => []), sendForProject: vi.fn() }));

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }
const PATH = '/projects/:projectId/workstreams/:id/explorer-archive';

async function call(body: unknown) {
  const layer = (workstreamsRouter().stack as RouteLayer[]).find(l => l.route?.path === PATH && l.route.methods.post)!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined as unknown,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: { body: unknown }, b: unknown) { this.body = b; answered(); return this; }),
  });
  const req = { params: { projectId: 'p1', id: 'ws1' }, query: {}, headers: {}, body } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res as typeof res & { body: Record<string, unknown> };
}

const find = vi.mocked(prisma.workstream.findFirst);
const update = vi.mocked(prisma.workstream.update);

beforeEach(() => {
  vi.clearAllMocks();
  find.mockResolvedValue({ id: 'ws1', project: { userId: 'u1' } } as never);
});

describe('POST …/workstreams/:id/explorer-archive', () => {
  it('archives the owner\'s session from Files, and brings it back', async () => {
    const on = await call({ archived: true });
    expect(on.statusCode).toBe(200);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: 'ws1' } });
    expect((update.mock.calls[0][0] as { data: { explorerArchivedAt: unknown } }).data.explorerArchivedAt).toBeInstanceOf(Date);
    await call({ archived: false });
    expect((update.mock.calls[1][0] as { data: { explorerArchivedAt: unknown } }).data.explorerArchivedAt).toBeNull();
  });

  it('only looks at a live workstream of the project', async () => {
    await call({ archived: true });
    expect(find.mock.calls[0][0]).toMatchObject({ where: { id: 'ws1', projectId: 'p1', archived: false } });
  });

  it('is 404 for someone else\'s session, and touches nothing', async () => {
    find.mockResolvedValue({ id: 'ws1', project: { userId: 'u2' } } as never);
    const r = await call({ archived: true });
    expect(r.statusCode).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it('is 400 without a boolean', async () => {
    const r = await call({ archived: 'yes' });
    expect(r.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
