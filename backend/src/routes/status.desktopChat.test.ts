import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { statusRouter } from './status';
import { setStatus } from '../services/status';
import { resetTurnsForTests } from '../services/sessionTurns';

// POST /api/status from a desktop thread whose checkout has no pane session
// (services/desktopThreadStatus.ts): its post as the t3 server is the chat's,
// when a chat on the posting box holds the thread's Claude session.
vi.mock('../db', () => ({ prisma: { instance: { findUnique: vi.fn() }, project: { updateMany: vi.fn(() => ({ catch: () => {} })) } } }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn(), requireAuthOrAgentToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()) }));
vi.mock('../auth/peerAddress', () => ({ isLocalPeer: () => false }));
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

const desktop = vi.hoisted(() => ({ chat: null as string | null, asked: [] as string[][] }));
vi.mock('../services/desktopThreadStatus', () => ({ chatStatusSessionFor: vi.fn(async (box: string, sid: string) => { desktop.asked.push([box, sid]); return desktop.chat; }) }));

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
  // The box's own agent token: its user and its box.
  const req = { body, headers: {}, socket: { remoteAddress: '10.0.0.5' }, ip: '10.0.0.5', user: { id: 'u1', unixUsername: 'jsmith' }, agentInstanceId: 'box-1' } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res;
}

const SID = '0334b447-41c0-4f95-ba90-d74fcfdaa69d';
const written = () => vi.mocked(setStatus).mock.calls.map(c => [c[0], c[1]]);

describe('POST /api/status from a desktop thread with no pane session', () => {
  beforeEach(() => { resetTurnsForTests(); desktop.chat = null; desktop.asked = []; vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.clearAllMocks());

  it('is the chat that holds its Claude session, on this box, and still box activity on the t3 server', async () => {
    desktop.chat = 'jsmith-parity-test-chat2-agent';
    await post({ session: 'termag-t3', status: 'working', source: 't3:claude', threadId: SID });
    expect(desktop.asked).toEqual([['box-1', SID]]);
    expect(written()).toEqual([['termag-t3', 'working'], ['jsmith-parity-test-chat2-agent', 'working']]);
    // The Stop settles both, so a PreToolUse post with no thread can't leave the t3 server working.
    vi.mocked(setStatus).mockClear();
    await post({ session: 'termag-t3', status: 'idle', source: 't3:claude', threadId: SID });
    expect(written()).toEqual([['termag-t3', 'idle'], ['jsmith-parity-test-chat2-agent', 'idle']]);
  });

  it("is never a chat the caller doesn't own, whatever the lookup says", async () => {
    desktop.chat = 'bob-shared-agent';
    await post({ session: 'termag-t3', status: 'working', source: 't3:claude', threadId: SID });
    expect(written()).toEqual([['termag-t3', 'working']]);
  });

  it("stays the t3 server's when no chat holds the session, the post names none, or it isn't a desktop thread's", async () => {
    await post({ session: 'termag-t3', status: 'working', source: 't3:claude', threadId: SID });
    desktop.chat = 'jsmith-parity-test-chat2-agent';
    await post({ session: 'termag-t3', status: 'working', source: 't3:claude' });
    await post({ session: 'termag-t3', status: 'working', source: 'claude', threadId: SID });
    expect(written()).toEqual([['termag-t3', 'working'], ['termag-t3', 'working'], ['termag-t3', 'working']]);
    expect(desktop.asked).toEqual([['box-1', SID]]);
  });

  it("leaves a project's own session alone", async () => {
    desktop.chat = 'jsmith-parity-test-chat2-agent';
    await post({ session: 'jsmith-web-agent', status: 'working', source: 't3:claude', threadId: SID });
    expect(written()).toEqual([['jsmith-web-agent', 'working']]);
    expect(desktop.asked).toEqual([]);
  });
});
