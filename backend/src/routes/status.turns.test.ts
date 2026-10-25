import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { statusRouter } from './status';
import { setStatus } from '../services/status';
import { pushOnWaitingTransition } from '../services/pushWaiting';
import { resetTurnsForTests } from '../services/sessionTurns';
import { prisma } from '../db';

// POST /api/status with desktop threads in a project's checkout
// (services/sessionTurns.ts): the session's status
// is the busiest turn's, while pushes follow the post itself.
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

const S = 'alice-web-agent';
const lastWrite = () => vi.mocked(setStatus).mock.calls.at(-1)!;

describe('POST /api/status with desktop threads', () => {
  beforeEach(() => { resetTurnsForTests(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.clearAllMocks());

  it("one thread's Stop is written as working while another thread works; the last Stop idles the session", async () => {
    await post({ session: S, status: 'working', source: 't3:claude', threadId: 'A' });
    await post({ session: S, status: 'working', source: 't3:claude', threadId: 'B' });
    await post({ session: S, status: 'idle', source: 't3:claude', threadId: 'A' });
    expect(lastWrite()[1]).toBe('working');
    expect(lastWrite()[2]).toMatchObject({ source: 't3:claude' });
    await post({ session: S, status: 'idle', source: 't3:claude', threadId: 'B' });
    expect(lastWrite()[1]).toBe('idle');
    expect(lastWrite()[2]).toMatchObject({ source: 't3:claude', threadId: 'B' });
  });

  it('a thread that needs input while another works pushes for the post, and the session stays working', async () => {
    await post({ session: S, status: 'working', source: 't3:claude', threadId: 'A' });
    await post({ session: S, status: 'waiting', source: 't3:claude', threadId: 'B', message: 'Allow?', notify: true });
    expect(lastWrite()[1]).toBe('working');
    expect(vi.mocked(pushOnWaitingTransition).mock.calls.at(-1)![0]).toMatchObject({ next: 'waiting', message: 'Allow?' });
    // Working: the project's lastActiveAt moves, as for any working write.
    expect(prisma.project.updateMany).toHaveBeenCalled();
  });

  it("the pane's own posts are written as they come when no desktop thread posted", async () => {
    await post({ session: S, status: 'working' });
    await post({ session: S, status: 'idle' });
    expect(vi.mocked(setStatus).mock.calls.map(c => c[1])).toEqual(['working', 'idle']);
    expect(lastWrite()[2]).toMatchObject({ source: undefined, threadId: undefined });
  });
});
