import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { statusRouter } from './status';
import { getAllStatuses } from '../services/status';
import { getAllNotificationTargets } from '../slack/lts';
import { getSlackApp } from '../slack/app';
import { pushOnWaitingTransition, waitingChatMuted } from '../services/pushWaiting';
import type { AgentStatus } from '../types/index';

// The `web` target in POST /api/status: the push decision
// sees the status from BEFORE the write, runs whether or not the hook asked
// for `notify`, and pushMutesChat drops the Slack "needs input" post only.
vi.mock('../db', () => ({ prisma: { instance: { findUnique: vi.fn() }, project: { updateMany: vi.fn(() => ({ catch: () => {} })) } } }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn(), requireAuthOrAgentToken: vi.fn() }));
vi.mock('../auth/peerAddress', () => ({ isLocalPeer: () => true }));
vi.mock('../services/status', () => ({
  setStatus: vi.fn((_s: string, status: string) => ({ status, updatedAt: new Date() })), getStatus: vi.fn(), getAllStatuses: vi.fn(() => new Map()),
  updateStatusMeta: vi.fn(), notifyStatusChange: vi.fn(), armMilestoneTimer: vi.fn(), clearMilestoneTimer: vi.fn(),
}));
vi.mock('../services/pushWaiting', () => ({ pushOnWaitingTransition: vi.fn(() => true), waitingChatMuted: vi.fn(async () => false) }));
vi.mock('../slack/lts', () => ({ getAllNotificationTargets: vi.fn(async () => []) }));
vi.mock('../slack/app', () => ({ getSlackApp: vi.fn(() => null) }));
vi.mock('../slack/events', () => ({ trackPaneMessage: vi.fn(), addReactionHints: vi.fn() }));
vi.mock('../discord/app', () => ({ getDiscordClient: vi.fn(() => null) }));
vi.mock('../slack/tmuxAgent', () => ({ capturePaneForSlack: vi.fn(async () => 'pane') }));
vi.mock('../services/humanActivity', () => ({ recordHeartbeat: vi.fn() }));
vi.mock('../services/sessionResolver', () => ({ resolveSessionProject: vi.fn(async () => null) }));
vi.mock('../services/contextSampler', () => ({ recordContextSample: vi.fn() }));
vi.mock('./agentTokens', () => ({ validateAgentToken: vi.fn() }));

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

async function post(body: Record<string, unknown>) {
  const layer = ((statusRouter() as Router).stack as RouteLayer[]).find(l => l.route?.path === '/' && l.route.methods.post)!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: unknown) { answered(); return this; }),
  });
  const req = { body, headers: {}, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res;
}

describe('POST /api/status → web push', () => {
  const slackPost = vi.fn(async () => ({ ts: '1.2' }));
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(getAllStatuses).mockReturnValue(new Map<string, AgentStatus>([['|alice-cx-agent', { status: 'working', updatedAt: new Date() }]]));
    vi.mocked(getSlackApp).mockReturnValue({ client: { chat: { postMessage: slackPost } } } as never);
    vi.mocked(getAllNotificationTargets).mockResolvedValue([{ platform: 'slack', channel: 'C1', userId: 'U1' }]);
  });
  afterEach(() => vi.clearAllMocks());

  it('hands the push the previous status, without notify and without chat targets', async () => {
    vi.mocked(getAllNotificationTargets).mockResolvedValue([]);
    const res = await post({ session: 'alice-cx-agent', status: 'waiting', message: 'Needs approval', waitingReason: 'approval' });
    expect(res.statusCode).toBe(200);
    expect(pushOnWaitingTransition).toHaveBeenCalledWith({
      session: 'alice-cx-agent', instanceId: null, prev: 'working', next: 'waiting', message: 'Needs approval', waitingReason: 'approval',
    });
    expect(getAllNotificationTargets).not.toHaveBeenCalled();
  });

  it('posts "needs input" to Slack as before when chat is not muted', async () => {
    await post({ session: 'alice-cx-agent', status: 'waiting', notify: true });
    expect(waitingChatMuted).toHaveBeenCalledWith('alice-cx-agent', null);
    expect(slackPost).toHaveBeenCalledTimes(1);
  });

  it('skips the Slack "needs input" post when the owner muted chat for push', async () => {
    vi.mocked(waitingChatMuted).mockResolvedValueOnce(true);
    const res = await post({ session: 'alice-cx-agent', status: 'waiting', notify: true });
    expect(res.statusCode).toBe(200);
    expect(slackPost).not.toHaveBeenCalled();
    expect(pushOnWaitingTransition).toHaveBeenCalled();
  });

  it('never asks about muting for a non-waiting post', async () => {
    await post({ session: 'alice-cx-agent', status: 'idle', notify: true });
    expect(waitingChatMuted).not.toHaveBeenCalled();
    expect(pushOnWaitingTransition).toHaveBeenCalledWith(expect.objectContaining({ prev: 'working', next: 'idle' }));
  });
});
