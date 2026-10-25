import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { statusRouter } from './status';
import { prisma } from '../db';
import { setStatus } from '../services/status';

// Status writes from a box (an instance-bound agent token): the caller's own
// project panes, and the box's own runner sessions, whose names start with the
// box's unix user rather than the owner's termag username.
vi.mock('../db', () => ({ prisma: { instance: { findUnique: vi.fn() }, project: { updateMany: vi.fn(() => ({ catch: () => {} })) } } }));
vi.mock('../middleware/auth', () => ({
  requireAuth: vi.fn(),
  requireAuthOrAgentToken: vi.fn(async (req: Request, _res: Response, next: () => void) => {
    req.user = { id: 'u1', unixUsername: 'carol' } as never;
    req.agentInstanceId = 'box-a';
    next();
  }),
}));
vi.mock('../services/status', () => ({
  setStatus: vi.fn(() => ({ status: 'working', updatedAt: new Date() })), getStatus: vi.fn(), getAllStatuses: vi.fn(() => new Map()),
  updateStatusMeta: vi.fn(), notifyStatusChange: vi.fn(), armMilestoneTimer: vi.fn(), clearMilestoneTimer: vi.fn(),
}));
vi.mock('../slack/lts', () => ({ getAllNotificationTargets: vi.fn(async () => []) }));
vi.mock('../slack/app', () => ({ getSlackApp: vi.fn(() => null) }));
vi.mock('../discord/app', () => ({ getDiscordClient: vi.fn(() => null) }));
vi.mock('../slack/tmuxAgent', () => ({ capturePaneForSlack: vi.fn() }));
vi.mock('../services/humanActivity', () => ({ recordHeartbeat: vi.fn() }));
vi.mock('../services/sessionResolver', () => ({ resolveSessionProject: vi.fn(async () => null) }));
vi.mock('../services/contextSampler', () => ({ recordContextSample: vi.fn() }));
vi.mock('./agentTokens', () => ({ validateAgentToken: vi.fn() }));

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

async function post(session: string) {
  const layer = ((statusRouter() as Router).stack as RouteLayer[]).find(l => l.route?.path === '/' && l.route.methods.post)!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: unknown) { answered(); return this; }),
  });
  // A remote peer (a box over the VPC), so authStatusWrite goes through the token path.
  const req = { body: { session, status: 'working' }, headers: {}, socket: { remoteAddress: '10.0.4.9' }, ip: '10.0.4.9' } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res;
}

describe('status writes from a box', () => {
  beforeEach(() => {
    vi.mocked(prisma.instance.findUnique).mockResolvedValue({ hostUnixUser: 'termag' } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.clearAllMocks());

  it("accepts the owner's own project pane without asking about the box", async () => {
    const res = await post('carol-webapp-agent');
    expect(res.statusCode).toBe(200);
    expect(prisma.instance.findUnique).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith('carol-webapp-agent', 'working', expect.anything(), undefined, 'box-a');
  });

  it("accepts the box's own runner session, named after the box's unix user", async () => {
    const res = await post('termag-claude-runner-s3-ord_d1-r');
    expect(res.statusCode).toBe(200);
    expect(prisma.instance.findUnique).toHaveBeenCalledWith({ where: { id: 'box-a' }, select: { hostUnixUser: true } });
    expect(setStatus).toHaveBeenCalledWith('termag-claude-runner-s3-ord_d1-r', 'working', expect.anything(), undefined, 'box-a');
  });

  it("accepts the box's own t3 server session, a desktop thread outside every project", async () => {
    const res = await post('termag-t3');
    expect(res.statusCode).toBe(200);
    expect(prisma.instance.findUnique).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith('termag-t3', 'working', expect.anything(), undefined, 'box-a');
  });

  it('refuses the t3 server session to a caller with no box (a browser session)', async () => {
    const { requireAuthOrAgentToken } = await import('../middleware/auth');
    vi.mocked(requireAuthOrAgentToken).mockImplementationOnce(async (req: Request, _res: Response, next: () => void) => {
      req.user = { id: 'u1', unixUsername: 'ffeldberg' } as never;
      next();
    });
    expect((await post('termag-t3')).statusCode).toBe(403);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("refuses a project pane under the box user's prefix, another user's runner session, and fails closed on a lookup error", async () => {
    expect((await post('termag-webapp-agent')).statusCode).toBe(403);
    expect((await post('ada-claude-runner-s2-x-r')).statusCode).toBe(403);
    vi.mocked(prisma.instance.findUnique).mockRejectedValueOnce(new Error('db down'));
    expect((await post('termag-claude-runner-s3-ord_d1-r')).statusCode).toBe(403);
    expect(setStatus).not.toHaveBeenCalled();
  });
});
