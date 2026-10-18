import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { workstreamsRouter } from './workstreams';
import { prisma } from '../db';
import { isProjectAgentConnected } from '../services/agentRegistry';
import { ensureAgentSessionsAndLaunch, stopAgentPane } from '../services/agentRuntime';
import { clearMilestoneTimer, notifyStatusChange, setStatus, updateStatusMeta } from '../services/status';

vi.mock('../db', () => ({
  prisma: { workstream: { findFirst: vi.fn() }, workflow: { update: vi.fn(async () => ({})) } },
}));
vi.mock('../middleware/auth', () => ({
  requireAuth: vi.fn((req: Request, _res: Response, next: NextFunction) => { req.user = { id: 'u1', unixUsername: 'ada' } as never; next(); }),
}));
vi.mock('../middleware/parkedBox', () => ({ refuseParkedBox: () => (_q: Request, _s: Response, next: NextFunction) => next() }));
vi.mock('../middleware/unreadySetup', () => ({ refuseUnreadySetup: () => (_q: Request, _s: Response, next: NextFunction) => next() }));
vi.mock('../services/agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), sendForProject: vi.fn() }));
vi.mock('../services/agentRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/agentRuntime')>()),
  stopAgentPane: vi.fn(async () => {}),
  ensureAgentSessionsAndLaunch: vi.fn(async () => 'launched'),
  stopAgentSessions: vi.fn(async () => {}),
}));
vi.mock('../services/status', () => ({
  setStatus: vi.fn(), notifyStatusChange: vi.fn(), moveStatus: vi.fn(), clearMilestoneTimer: vi.fn(), updateStatusMeta: vi.fn(),
}));
vi.mock('../slack/channels', () => ({ createChannelFor: vi.fn(), archiveChannel: vi.fn() }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn(), renameNotificationTargets: vi.fn() }));

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

const PATH = '/projects/:projectId/workstreams/:id/agent';

async function switchTo(provider: unknown, params = { projectId: 'p1', id: 'ws1' }) {
  const layer = (workstreamsRouter().stack as RouteLayer[]).find(l => l.route?.path === PATH && l.route.methods.post)!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined as unknown,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: { body: unknown }, body: unknown) { this.body = body; answered(); return this; }),
  });
  const req = { params, query: {}, headers: {}, body: { provider } } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res as typeof res & { body: Record<string, unknown> };
}

function workstreamRow(over: { provider?: string | null; kind?: string; owner?: string; instanceId?: string | null; workflows?: unknown[] } = {}) {
  return {
    id: 'ws1', projectId: 'p1', name: 'feature-x', branch: 'feature-x',
    project: {
      id: 'p1', name: 'termag', kind: over.kind ?? 'regular', userId: over.owner ?? 'u1',
      instanceId: over.instanceId === undefined ? 'box1' : over.instanceId,
      user: { unixUsername: 'ada', defaultAgentProvider: 'claude' },
      instance: { hostHome: '/home/ada' },
    },
    workflows: over.workflows ?? [{ id: 'wf1', type: 'agent', provider: over.provider === undefined ? 'claude' : over.provider }],
  };
}

const findFirst = vi.mocked(prisma.workstream.findFirst);
const update = vi.mocked(prisma.workflow.update);

describe('POST /api/projects/:projectId/workstreams/:id/agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectAgentConnected).mockReturnValue(true);
    findFirst.mockResolvedValue(workstreamRow() as never);
  });

  it('rewrites the row, stops only the old agent, clears its status, then launches the new one', async () => {
    const order: string[] = [];
    update.mockImplementation((async (a: { data: { provider: string } }) => { order.push(`row:${a.data.provider}`); return {}; }) as never);
    vi.mocked(stopAgentPane).mockImplementation(async (c) => { order.push(`stop:${c.provider}`); });
    vi.mocked(setStatus).mockImplementation(((s: string, st: string) => { order.push(`status:${s}:${st}`); }) as never);
    vi.mocked(ensureAgentSessionsAndLaunch).mockImplementation(async (c) => { order.push(`launch:${c.provider}`); return 'launched'; });

    const res = await switchTo('pi');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, provider: 'pi', changed: true, launch: 'launched', warning: null });
    expect(order).toEqual([
      'row:pi',
      'stop:claude',
      'status:ada-termag-feature-x-agent:not_running',
      'launch:pi',
    ]);
    expect(update).toHaveBeenCalledWith({ where: { id: 'wf1' }, data: { provider: 'pi' } });
    expect(vi.mocked(stopAgentPane).mock.calls[0][0]).toMatchObject({ unixUsername: 'ada', projectName: 'termag', workstream: 'feature-x', instanceId: 'box1' });
    expect(notifyStatusChange).toHaveBeenCalledWith('ada-termag-feature-x-agent', 'box1');
  });

  it("drops what the old agent left on the session: PR prompt, its timer, and its context reading", async () => {
    await switchTo('pi');
    expect(setStatus).toHaveBeenCalledWith('ada-termag-feature-x-agent', 'not_running', { milestone: null }, undefined, 'box1');
    expect(clearMilestoneTimer).toHaveBeenCalledWith('ada-termag-feature-x-agent', 'box1');
    expect(updateStatusMeta).toHaveBeenCalledWith('ada-termag-feature-x-agent', { contextTokens: undefined }, 'box1');
  });

  it('a launch that typed nothing into the pane is a success with a warning, not a silent one', async () => {
    vi.mocked(ensureAgentSessionsAndLaunch).mockResolvedValueOnce('unknown');
    let res = await switchTo('pi');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ changed: true, launch: 'unknown' });
    expect(String(res.body.warning)).toMatch(/could not be checked, so pi was not started/);

    vi.mocked(ensureAgentSessionsAndLaunch).mockResolvedValueOnce('busy');
    res = await switchTo('pi');
    expect(String(res.body.warning)).toMatch(/git was running/);
  });

  it('a workflow with no stored provider counts as the user default', async () => {
    findFirst.mockResolvedValue(workstreamRow({ provider: null }) as never);
    const res = await switchTo('claude');
    expect(res.body).toEqual({ ok: true, provider: 'claude', changed: false });
    expect(update).not.toHaveBeenCalled();
    expect(stopAgentPane).not.toHaveBeenCalled();
  });

  it('switching to the agent already running is a no-op', async () => {
    findFirst.mockResolvedValue(workstreamRow({ provider: 'pi' }) as never);
    const res = await switchTo('pi');
    expect(res.statusCode).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(ensureAgentSessionsAndLaunch).not.toHaveBeenCalled();
  });

  it('refuses agents the picker does not offer, without touching anything', async () => {
    for (const bad of ['codex', 'human', 'nope', '', 42, undefined]) {
      const res = await switchTo(bad);
      expect(res.statusCode).toBe(400);
    }
    expect(findFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("404s on someone else's workstream", async () => {
    findFirst.mockResolvedValue(workstreamRow({ owner: 'u2' }) as never);
    const res = await switchTo('pi');
    expect(res.statusCode).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses MetaTerm and a workstream without an agent', async () => {
    findFirst.mockResolvedValue(workstreamRow({ kind: 'metaterm' }) as never);
    expect((await switchTo('pi')).statusCode).toBe(400);
    findFirst.mockResolvedValue(workstreamRow({ workflows: [{ id: 'wf2', type: 'data', provider: null }] }) as never);
    expect((await switchTo('pi')).statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('503s when the box agent is offline, before writing the row', async () => {
    vi.mocked(isProjectAgentConnected).mockReturnValue(false);
    const res = await switchTo('pi');
    expect(res.statusCode).toBe(503);
    expect(update).not.toHaveBeenCalled();
  });

  it('puts the row back when the box refuses to stop the old agent', async () => {
    vi.mocked(stopAgentPane).mockRejectedValueOnce(new Error('rpc timeout'));
    const res = await switchTo('pi');
    expect(res.statusCode).toBe(502);
    expect(update.mock.calls.map(c => (c[0] as { data: { provider: string } }).data.provider)).toEqual(['pi', 'claude']);
    expect(setStatus).not.toHaveBeenCalled();
    expect(ensureAgentSessionsAndLaunch).not.toHaveBeenCalled();
  });

  it('a failed launch keeps the new agent recorded and says so', async () => {
    vi.mocked(ensureAgentSessionsAndLaunch).mockRejectedValueOnce(new Error('tmux-create failed'));
    const res = await switchTo('pi');
    expect(res.statusCode).toBe(502);
    expect(res.body.provider).toBe('pi');
    expect(String(res.body.error)).toMatch(/Switched to pi, but it did not start/);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
