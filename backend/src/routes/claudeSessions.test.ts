import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { claudeSessionsRouter, parseSessionKey, redactLog, tailLines } from './claudeSessions';
import { prisma } from '../db';
import { isInstanceAgentConnected, sendToInstanceAgent } from '../services/agentRegistry';
import { listCloudSessions, listSessionEvents, renameCloudSession, type CloudSessionView } from '../services/claudeSessions';
import { recordSessionEvent } from '../services/claudeSessionEvents';

vi.mock('../db', () => ({ prisma: { instance: { findFirst: vi.fn() } } }));
vi.mock('../middleware/auth', () => ({
  requireAuth: vi.fn((req: Request, _res: Response, next: NextFunction) => { req.user = { id: 'u1', unixUsername: 'ada' } as never; next(); }),
}));
vi.mock('../services/agentRegistry', () => ({ isInstanceAgentConnected: vi.fn(), sendToInstanceAgent: vi.fn() }));
vi.mock('../services/claudeSessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/claudeSessions')>()),
  listCloudSessions: vi.fn(), listSessionEvents: vi.fn(), renameCloudSession: vi.fn(),
}));
vi.mock('../services/claudeSessionEvents', () => ({ recordSessionEvent: vi.fn(async () => {}) }));

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

async function call(method: 'get' | 'post' | 'patch', path: string, params: Record<string, string> = {}, query: Record<string, string> = {}, body: unknown = {}) {
  const layer = (claudeSessionsRouter().stack as RouteLayer[]).find(l => l.route?.path === path && l.route.methods[method])!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined as unknown,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: { body: unknown }, body: unknown) { this.body = body; answered(); return this; }),
    end: vi.fn(function (this: unknown) { answered(); return this; }),
  });
  const req = { params, query, headers: {}, body } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res;
}

const view = (over: Partial<CloudSessionView> = {}): CloudSessionView => ({
  key: 'cse_01A', sessionId: 'cse_01A', url: 'https://claude.ai/code/session_01A', seq: 3, name: 'Claude Cloud 3', title: 'Fix the auth bug', clientPlatform: 'web_claude_ai',
  state: 'running', exitReason: null, queuedReason: null, queuedSince: null,
  current: { orderId: 'ord.1', instanceId: 'box-a', boxName: 'ada-box', slot: 2, sessionName: 'ada-claude-runner-s2-ord_d1-r', startedAt: '2026-10-08T10:00:00.000Z', endedAt: null, durationSec: null, exitStatus: null, exitReason: null, alive: true },
  runs: [], firstSeenAt: '2026-10-08T10:00:00.000Z', lastSeenAt: '2026-10-08T10:00:00.000Z', eventCount: 1, ...over,
});

describe('helpers', () => {
  it('accepts a session id or an order: key, nothing else', () => {
    expect(parseSessionKey('cse_018WY1ng4FeqiiV49u8ZrHmT')).toBe('cse_018WY1ng4FeqiiV49u8ZrHmT');
    expect(parseSessionKey('order:ord.1')).toBe('order:ord.1');
    expect(parseSessionKey('order:../x')).toBeNull();
    expect(parseSessionKey('a b')).toBeNull();
  });

  it('redacts tokens a runner log could carry and tails lines', () => {
    const log = 'Bearer abcdefghijkl\nsk-ant-cc-eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.sig\nurl?token=tmag_abc&x=1\nghp_abcdefghijklmnopqrstuvwxyz0123\nplain line';
    const out = redactLog(log);
    expect(out).not.toMatch(/abcdefghijkl|eyJ|tmag_abc|ghp_/);
    expect(out).toContain('plain line');
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc');
    expect(tailLines('a', 5)).toBe('a');
  });
});

describe('/api/claude-sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(listCloudSessions).mockResolvedValue([view(), view({ key: 'cse_01B', sessionId: 'cse_01B', state: 'ended', exitReason: 'completed', current: { ...view().current!, endedAt: '2026-10-08T11:00:00.000Z', durationSec: 3600, exitStatus: 0, exitReason: 'completed', alive: false } }), view({ key: 'cse_01Q', sessionId: 'cse_01Q', state: 'queued', current: null })]);
    vi.mocked(isInstanceAgentConnected).mockReturnValue(true);
  });
  afterEach(() => vi.clearAllMocks());

  it('lists active sessions by default and recent ones on request, within a capped window', async () => {
    const active = await call('get', '/');
    expect(listCloudSessions).toHaveBeenCalledWith('u1', { days: 30 });
    expect((active.body as { sessions: CloudSessionView[] }).sessions.map(s => s.key)).toEqual(['cse_01A', 'cse_01Q']);
    const recent = await call('get', '/', {}, { state: 'recent', days: '400' });
    expect(listCloudSessions).toHaveBeenLastCalledWith('u1', { days: 90 });
    expect((recent.body as { sessions: CloudSessionView[] }).sessions.map(s => s.key)).toEqual(['cse_01B']);
  });

  it('answers the events of an owned session and 404 for a bad or foreign key', async () => {
    vi.mocked(listSessionEvents).mockResolvedValue([{ sessionId: 'cse_01A', orderId: 'ord.1', instanceId: 'box-a', kind: 'placed', detail: null, at: new Date('2026-10-08T10:00:00Z') }]);
    const res = await call('get', '/:key/events', { key: 'cse_01A' });
    expect(listSessionEvents).toHaveBeenCalledWith('u1', 'cse_01A');
    expect(res.body).toEqual({ key: 'cse_01A', events: [expect.objectContaining({ kind: 'placed', at: '2026-10-08T10:00:00.000Z' })] });
    expect((await call('get', '/:key/events', { key: 'nope nope' })).statusCode).toBe(404);
    vi.mocked(listSessionEvents).mockResolvedValue([]);
    expect((await call('get', '/:key/events', { key: 'cse_01Z' })).statusCode).toBe(404);
  });

  it('tails and redacts the runner log through the box agent', async () => {
    vi.mocked(prisma.instance.findFirst).mockResolvedValue({ hostHome: '/home/ada/' } as never);
    vi.mocked(sendToInstanceAgent).mockResolvedValue({ ok: true, content: 'one\ntwo Bearer secrettoken12\nthree\n' });
    const res = await call('get', '/:key/runner-log', { key: 'cse_01A' }, { lines: '2' });
    expect(sendToInstanceAgent).toHaveBeenCalledWith('box-a', 'read-file', { path: '/home/ada/.termag/claude-runner/ord.1.log' }, 10000);
    expect(res.body).toEqual({ key: 'cse_01A', orderId: 'ord.1', lines: 2, log: 'two Bearer REDACTED\nthree' });
    vi.mocked(sendToInstanceAgent).mockResolvedValue({ ok: true, content: null });
    expect((await call('get', '/:key/runner-log', { key: 'cse_01A' })).statusCode).toBe(404);
    vi.mocked(isInstanceAgentConnected).mockReturnValue(false);
    expect((await call('get', '/:key/runner-log', { key: 'cse_01A' })).statusCode).toBe(503);
    expect((await call('get', '/:key/runner-log', { key: 'cse_01Q' })).statusCode).toBe(404);
  });

  it('renames: the title after the fixed name on every run, trimmed to a first line, with a renamed event; null clears', async () => {
    vi.mocked(renameCloudSession).mockResolvedValue(2);
    vi.mocked(listCloudSessions).mockResolvedValue([view({ title: 'Auth fix' })]);
    const res = await call('patch', '/:key/title', { key: 'cse_01A' }, {}, { title: '  Auth fix\nsecond line ignored ' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, key: 'cse_01A', title: 'Auth fix', name: 'Claude Cloud 3' });
    expect(renameCloudSession).toHaveBeenCalledWith('u1', 'cse_01A', 'Auth fix');
    expect(recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'cse_01A', orderId: 'ord.1', kind: 'renamed' }));

    await call('patch', '/:key/title', { key: 'cse_01A' }, {}, { title: null });
    expect(renameCloudSession).toHaveBeenCalledWith('u1', 'cse_01A', null);
  });

  it('refuses a rename that is not a string, or that is blank, and 404s a foreign key', async () => {
    expect((await call('patch', '/:key/title', { key: 'cse_01A' }, {}, { title: 7 })).statusCode).toBe(400);
    expect((await call('patch', '/:key/title', { key: 'cse_01A' }, {}, { title: '   ' })).statusCode).toBe(200); // blank clears
    expect(renameCloudSession).toHaveBeenLastCalledWith('u1', 'cse_01A', null);
    vi.mocked(renameCloudSession).mockResolvedValue(0);
    expect((await call('patch', '/:key/title', { key: 'cse_01Z' }, {}, { title: 'x' })).statusCode).toBe(404);
    expect((await call('patch', '/:key/title', { key: 'a b' }, {}, { title: 'x' })).statusCode).toBe(404);
  });

  it('ends a live run by killing its tmux session by exact name, and records the request', async () => {
    vi.mocked(sendToInstanceAgent).mockResolvedValue({ ok: true });
    const res = await call('post', '/:key/end', { key: 'cse_01A' });
    expect(res.statusCode).toBe(202);
    expect(sendToInstanceAgent).toHaveBeenCalledWith('box-a', 'tmux-kill', { sessionName: 'ada-claude-runner-s2-ord_d1-r', exact: true }, 10000);
    expect(recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'end-requested', sessionId: 'cse_01A', orderId: 'ord.1', owner: { id: 'u1', unixUsername: 'ada' } }));
  });

  it('answers 409 when no run is live, and 502 when the box does not answer', async () => {
    expect((await call('post', '/:key/end', { key: 'cse_01B' })).statusCode).toBe(409);
    expect((await call('post', '/:key/end', { key: 'cse_01Q' })).statusCode).toBe(409);
    vi.mocked(sendToInstanceAgent).mockRejectedValue(new Error('timeout'));
    expect((await call('post', '/:key/end', { key: 'cse_01A' })).statusCode).toBe(502);
    expect(recordSessionEvent).not.toHaveBeenCalled();
  });
});
