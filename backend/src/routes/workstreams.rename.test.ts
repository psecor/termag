import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { workstreamsRouter } from './workstreams';
import { prisma } from '../db';
import { projectAgentCapabilities, sendForProject } from '../services/agentRegistry';
import { moveStatus } from '../services/status';

// A multi-repo project's workstream rename: the
// box moves the workstream root and repairs each repository's worktree in it
// (workspace-move), or the row goes back.
vi.mock('../db', () => ({
  prisma: {
    workstream: { findFirst: vi.fn(), findUnique: vi.fn(async () => ({ id: 'ws1', name: 'feature' })), update: vi.fn(async () => ({})) },
    projectRepo: { findMany: vi.fn() },
    agentMessage: { findMany: vi.fn(async () => [{ id: 'm1' }]), updateMany: vi.fn(async () => ({ count: 1 })) },
  },
}));
vi.mock('../middleware/auth', () => ({
  requireAuth: vi.fn((req: Request, _res: Response, next: NextFunction) => { req.user = { id: 'u1', unixUsername: 'ada' } as never; next(); }),
}));
vi.mock('../middleware/parkedBox', () => ({ refuseParkedBox: () => (_q: Request, _s: Response, next: NextFunction) => next() }));
vi.mock('../middleware/unreadySetup', () => ({ refuseUnreadySetup: () => (_q: Request, _s: Response, next: NextFunction) => next() }));
vi.mock('../services/agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  projectAgentCapabilities: vi.fn(() => []),
  sendForProject: vi.fn(),
}));
vi.mock('../services/spawnRenames', () => ({ renameSpawnWorkstream: vi.fn(async () => {}) }));
vi.mock('../services/status', () => ({
  setStatus: vi.fn(), notifyStatusChange: vi.fn(), moveStatus: vi.fn(), clearMilestoneTimer: vi.fn(), updateStatusMeta: vi.fn(),
}));
vi.mock('../slack/channels', () => ({ createChannelFor: vi.fn(), archiveChannel: vi.fn() }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn(), renameNotificationTargets: vi.fn() }));

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

const PATH = '/projects/:projectId/workstreams/:id/rename';

async function rename(name: string) {
  const layer = (workstreamsRouter().stack as RouteLayer[]).find(l => l.route?.path === PATH && l.route.methods.post)!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined as unknown,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: { body: unknown }, body: unknown) { this.body = body; answered(); return this; }),
  });
  const req = { params: { projectId: 'p1', id: 'ws1' }, query: {}, headers: {}, body: { name } } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res as typeof res & { body: Record<string, unknown> };
}

const REPOS = [
  { name: 'shop-web', url: 'https://github.com/o/shop-web', position: 0, setupStatus: 'ready' },
  { name: 'shop-api', url: 'https://github.com/o/shop-api', position: 1, setupStatus: 'ready' },
];

function workstreamRow(layout = 'workspace') {
  return {
    id: 'ws1', projectId: 'p1', name: 'fix', branch: 'e2e/fix', askThread: null,
    project: {
      id: 'p1', name: 'shop', kind: 'regular', layout, userId: 'u1', instanceId: 'box1',
      user: { unixUsername: 'ada' }, instance: { hostHome: '/home/ada' },
    },
    workflows: [{ type: 'agent', provider: 'claude' }],
  };
}

const send = vi.mocked(sendForProject);
const rowUpdate = vi.mocked(prisma.workstream.update);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.workstream.findFirst).mockResolvedValue(workstreamRow() as never);
  vi.mocked(prisma.projectRepo.findMany).mockResolvedValue(REPOS as never);
  vi.mocked(projectAgentCapabilities).mockReturnValue(['workspace-clone-v1', 'workspace-rename-v1']);
  send.mockImplementation(async (_h, command) => (command === 'tmux-rename-session' ? { ok: true, renamed: true } : { ok: true }));
});

describe('POST /api/projects/:projectId/workstreams/:id/rename on a multi-repo project', () => {
  it('has the box move the workstream root and repair every repository, then renames the sessions', async () => {
    const res = await rename('feature');
    expect(res.statusCode).toBe(200);
    const move = send.mock.calls.find(c => c[1] === 'workspace-move')!;
    expect(move[2]).toEqual({
      root: '/home/ada/termag/projects/shop',
      fromDir: '/home/ada/termag/projects/shop/.worktrees/fix',
      toDir: '/home/ada/termag/projects/shop/.worktrees/feature',
      repos: ['shop-web', 'shop-api'],
      guides: [{ dir: '/home/ada/termag/projects/shop/.worktrees/feature', content: expect.stringContaining('# shop / feature\n') }],
    });
    expect((move[2] as { guides: Array<{ content: string }> }).guides[0].content).toContain('a worktree on branch `e2e/fix`');
    expect(send.mock.calls.some(c => c[1] === 'git-worktree-move')).toBe(false);
    expect(send).toHaveBeenCalledWith(expect.anything(), 'tmux-rename-session', { from: 'ada-shop-fix-agent', to: 'ada-shop-feature-agent' });
    expect(moveStatus).toHaveBeenCalledWith('ada-shop-fix-agent', 'ada-shop-feature-agent', 'box1');
    expect(rowUpdate).toHaveBeenCalledTimes(1);
    // Its asks' finish notices follow it to the new name.
    expect(prisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: { senderUserId: 'u1', notifyProjectId: 'p1', notifyWorkstream: 'fix' }, select: { id: true },
    });
    expect(prisma.agentMessage.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['m1'] } }, data: { notifyWorkstream: 'feature' } });
    // Before the folder moves, so the notice sweep never sees them under a name no row has.
    expect(vi.mocked(prisma.agentMessage.updateMany).mock.invocationCallOrder[0])
      .toBeLessThan(send.mock.invocationCallOrder[send.mock.calls.findIndex(c => c[1] === 'workspace-move')]);
  });

  it('refuses on a box whose agent cannot repair the worktrees, before the row or the folder moves', async () => {
    vi.mocked(projectAgentCapabilities).mockReturnValue(['workspace-clone-v1']);
    const res = await rename('feature');
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('agent_outdated');
    expect(rowUpdate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('puts the row back when the box could not move it, and renames no session', async () => {
    send.mockImplementation(async (_h, command) => {
      if (command === 'workspace-move') throw new Error('git worktree repair failed (shop-api: error: x); nothing was moved');
      return { ok: true };
    });
    const res = await rename('feature');
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('The workstream folder could not be moved: git worktree repair failed (shop-api: error: x); nothing was moved');
    expect(rowUpdate.mock.calls.map(c => (c[0] as { data: { name: string } }).data.name)).toEqual(['feature', 'fix']);
    expect(vi.mocked(prisma.agentMessage.updateMany).mock.calls.map(c => (c[0] as { data: { notifyWorkstream: string } }).data.notifyWorkstream))
      .toEqual(['feature', 'fix']);
    expect(send.mock.calls.some(c => c[1] === 'tmux-rename-session')).toBe(false);
  });

  it('leaves a single-repository workstream on git-worktree-move', async () => {
    vi.mocked(prisma.workstream.findFirst).mockResolvedValue(workstreamRow('repo') as never);
    const res = await rename('feature');
    expect(res.statusCode).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.anything(), 'git-worktree-move', { projectDir: '/home/ada/termag/projects/shop', from: 'fix', to: 'feature' });
    expect(prisma.projectRepo.findMany).not.toHaveBeenCalled();
  });
});
