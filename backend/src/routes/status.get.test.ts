import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { statusRouter } from './status';
import { validateAgentToken } from './agentTokens';
import { getStatus } from '../services/status';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentTokens', () => ({ validateAgentToken: vi.fn() }));
vi.mock('../services/status', () => ({
  setStatus: vi.fn(), getStatus: vi.fn(() => ({
    status: 'waiting',
    milestone: { kind: 'pr-opened', url: 'https://github.com/o/r/pull/9' },
    review: { state: 'done', pr: 9, url: 'https://github.com/o/r/pull/9', at: '2026-10-09T00:00:00Z', doneAt: '2026-10-09T00:01:00Z', seenAt: null },
  })),
  getAllStatuses: vi.fn(() => new Map()), updateStatusMeta: vi.fn(), notifyStatusChange: vi.fn(),
  armMilestoneTimer: vi.fn(), clearMilestoneTimer: vi.fn(),
}));

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

async function getSession(req: { socket: { remoteAddress: string }; headers: Record<string, string> }) {
  const layer = (statusRouter().stack as RouteLayer[]).find(l => l.route?.path === '/:session' && l.route.methods.get)!;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const full = { ...req, params: { session: 'alice-proj-agent' } } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(full, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

describe('GET /api/status/:session', () => {
  afterEach(() => vi.clearAllMocks());

  it('refuses a remote caller with no token', async () => {
    const res = await getSession({ socket: { remoteAddress: '10.0.4.9' }, headers: {} });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('refuses a remote caller whose token does not validate', async () => {
    vi.mocked(validateAgentToken).mockResolvedValue(null);
    const res = await getSession({ socket: { remoteAddress: '10.0.4.9' }, headers: { authorization: 'Bearer tmag_bad' } });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('refuses a remote caller behind the gateway', async () => {
    const res = await getSession({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-termag-peer-addr': '10.0.4.9' } });
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("serves a box token its own box's status, without the milestone or the review", async () => {
    vi.mocked(validateAgentToken).mockResolvedValue({
      user: null, instance: { id: 'box-1' }, token: { id: 't1', scope: 'agent', name: 'pool' },
    } as never);
    const res = await getSession({ socket: { remoteAddress: '10.0.4.9' }, headers: { authorization: 'Bearer tmag_ok' } });
    expect(getStatus).toHaveBeenCalledWith('alice-proj-agent', 'box-1');
    expect(res.json).toHaveBeenCalledWith({ status: 'waiting' });
  });

  it.each(['admin', 'client'])('refuses a %s-scoped token, even from this host', async (scope) => {
    vi.mocked(validateAgentToken).mockResolvedValue({
      user: { id: 'u1' }, instance: { id: 'box-1' }, token: { id: 't2', scope, name: scope },
    } as never);
    for (const remoteAddress of ['10.0.4.9', '127.0.0.1']) {
      const res = await getSession({ socket: { remoteAddress }, headers: { authorization: 'Bearer tmag_scoped' } });
      expect(res.status).toHaveBeenCalledWith(401);
    }
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('refuses a same-host caller whose token does not validate rather than serving the orchestrator key', async () => {
    vi.mocked(validateAgentToken).mockResolvedValue(null);
    const res = await getSession({ socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: 'Bearer tmag_expired' } });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('serves a same-host caller the orchestrator key without a token', async () => {
    const res = await getSession({ socket: { remoteAddress: '127.0.0.1' }, headers: {} });
    expect(getStatus).toHaveBeenCalledWith('alice-proj-agent', null);
    expect(res.json).toHaveBeenCalledWith({ status: 'waiting' });
  });});
