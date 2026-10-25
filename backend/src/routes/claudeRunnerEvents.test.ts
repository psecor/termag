import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logs } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { claudeRunnerEventsRouter } from './claudeRunnerEvents';
import { recordRunnerEnd, recordRunnerStarted, recordRunnerTitle, recordRunnerUsage } from '../services/claudeRunnerSessions';
import { notifyCloudSessionChange, recordSessionEvent } from '../services/claudeSessionEvents';

let agentInstanceId: string | null = 'box-a';
vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({
  requireAuthOrAgentToken: vi.fn((req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: 'u1' } as never;
    req.agentInstanceId = agentInstanceId;
    next();
  }),
}));
vi.mock('../services/claudeRunnerSessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/claudeRunnerSessions')>()),
  recordRunnerEnd: vi.fn(), recordRunnerStarted: vi.fn(), recordRunnerTitle: vi.fn(), recordRunnerUsage: vi.fn(),
}));
vi.mock('../services/claudeSessionEvents', () => ({ recordSessionEvent: vi.fn(async () => {}), notifyCloudSessionChange: vi.fn() }));
const who = { userId: 'u1', who: 'ada', sessionId: 'cse_01A', instanceId: 'box-a', boxName: 'ada-box', slot: 2 };

// The product events the route records (services/productEvents.ts), read off
// a log exporter as the backend sends them.
const logExporter = new InMemoryLogRecordExporter();
logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logExporter })] }));
const productEvents = () => logExporter.getFinishedLogRecords().map(r => r.attributes);

interface RouteLayer { route?: { path: string; stack: { handle: RequestHandler }[] } }
const body = { event: 'ended', orderId: 'ord.1', exitStatus: 0, exitReason: 'completed' };

/** Runs POST /event and resolves with the response once the handler has answered. */
async function post(reqBody: unknown = body) {
  const layer = (claudeRunnerEventsRouter().stack as RouteLayer[]).find(l => l.route?.path === '/event')!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: unknown) { answered(); return this; }),
    end: vi.fn(function (this: unknown) { answered(); return this; }),
  });
  const req = { body: reqBody, headers: {} } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res;
}
const lines = (fn: 'log' | 'warn') => vi.mocked(console[fn]).mock.calls.map(c => String(c[0]));

describe('POST /api/claude-runner/event', () => {
  beforeEach(() => {
    agentInstanceId = 'box-a';
    logExporter.reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.clearAllMocks());

  it('refuses a caller without an instance-bound agent token', async () => {
    agentInstanceId = null;
    const res = await post();
    expect(res.statusCode).toBe(403);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('box agents only') });
    expect(recordRunnerEnd).not.toHaveBeenCalled();
  });

  it('refuses a malformed body', async () => {
    const res = await post({ event: 'ended', orderId: 'ord.1' });
    expect(res.statusCode).toBe(400);
    expect(recordRunnerEnd).not.toHaveBeenCalled();
  });

  it("records the end for the token's box and logs the owner's ended line", async () => {
    vi.mocked(recordRunnerEnd).mockResolvedValue({ kind: 'ended', ...who, durationSec: 5000, exitStatus: 0, exitReason: 'completed' });
    const res = await post();
    expect(recordRunnerEnd).toHaveBeenCalledWith('box-a', expect.objectContaining({ orderId: 'ord.1', exitStatus: 0, exitReason: 'completed' }));
    expect(res.statusCode).toBe(204);
    expect(res.end).toHaveBeenCalled();
    expect(lines('log')).toEqual(['[CLAUDE-RUNNER] order ord.1 for ada ended on ada-box slot 2 after 5000s, exit 0 (completed)']);
    expect(recordSessionEvent).toHaveBeenCalledWith({
      owner: { id: 'u1', unixUsername: 'ada' }, sessionId: 'cse_01A', orderId: 'ord.1', instanceId: 'box-a', kind: 'ended', detail: 'completed',
    });
    expect(productEvents()).toEqual([{
      'event.name': 'cloud.session.ended', 'termag.user.id': 'u1', 'termag.box.id': 'box-a',
      'termag.provider': 'claude', 'termag.kind': 'cloud', 'termag.durationSec': 5000, 'termag.exitStatus': 0, 'termag.exitReason': 'completed', 'termag.slot': 2,
    }]);
  });

  it('records a started report, logs the serving line and appends the event', async () => {
    vi.mocked(recordRunnerStarted).mockResolvedValue({ kind: 'started', ...who, clientPlatform: 'web_claude_ai' });
    const res = await post({ event: 'started', orderId: 'ord.1', sessionId: 'cse_01A', clientPlatform: 'web_claude_ai' });
    expect(recordRunnerStarted).toHaveBeenCalledWith('box-a', { event: 'started', orderId: 'ord.1', sessionId: 'cse_01A', clientPlatform: 'web_claude_ai', at: null });
    expect(res.statusCode).toBe(204);
    expect(lines('log')).toEqual(['[CLAUDE-RUNNER] order ord.1 for ada serving session cse_01A from web_claude_ai on ada-box slot 2']);
    expect(recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'started', detail: 'web_claude_ai', sessionId: 'cse_01A' }));
    expect(productEvents()).toEqual([{
      'event.name': 'cloud.session.started', 'termag.user.id': 'u1', 'termag.box.id': 'box-a',
      'termag.provider': 'claude', 'termag.kind': 'cloud', 'termag.clientPlatform': 'web_claude_ai', 'termag.slot': 2,
    }]);
  });

  it('sets a title without logging or storing the text, and pushes the change', async () => {
    vi.mocked(recordRunnerTitle).mockResolvedValueOnce({ kind: 'set', ...who });
    const res = await post({ event: 'title', orderId: 'ord.1', title: 'Fix the auth bug' });
    expect(res.statusCode).toBe(204);
    expect(lines('log')).toEqual(['[CLAUDE-RUNNER] order ord.1 for ada: title set']);
    expect(recordSessionEvent).not.toHaveBeenCalled();
    expect(notifyCloudSessionChange).toHaveBeenCalledWith({ id: 'u1', unixUsername: 'ada' }, 'cse_01A');
    vi.mocked(recordRunnerTitle).mockResolvedValueOnce({ kind: 'kept', ...who });
    expect((await post({ event: 'title', orderId: 'ord.1', title: 'Second prompt' })).statusCode).toBe(204);
    expect(notifyCloudSessionChange).toHaveBeenCalledTimes(1);
  });

  it('answers 204 and a warn line for a started report from before the current launch', async () => {
    const startedAt = new Date();
    vi.mocked(recordRunnerStarted).mockResolvedValueOnce({ kind: 'stale', startedAt });
    const res = await post({ event: 'started', orderId: 'ord.1', sessionId: 'cse_01A', at: new Date(startedAt.getTime() - 60_000).toISOString() });
    expect(res.statusCode).toBe(204);
    expect(lines('warn')[0]).toContain('is from before the current launch');
    expect(recordSessionEvent).not.toHaveBeenCalled();
  });

  it("answers 404 and 403 for a started report on an order it never started or another box's", async () => {
    vi.mocked(recordRunnerStarted).mockResolvedValueOnce({ kind: 'unknown' });
    expect((await post({ event: 'started', orderId: 'ord.1', sessionId: 'cse_01A' })).statusCode).toBe(404);
    vi.mocked(recordRunnerStarted).mockResolvedValueOnce({ kind: 'other-box' });
    expect((await post({ event: 'started', orderId: 'ord.1', sessionId: 'cse_01A' })).statusCode).toBe(403);
    expect(recordSessionEvent).not.toHaveBeenCalled();
  });

  it('answers 204 and a warn line for a report from before the current launch', async () => {
    // Inside parseRunnerEvent's clock-trust window, so the box's endedAt is kept.
    const endedAt = new Date(Date.now() - 60_000);
    const startedAt = new Date(endedAt.getTime() + 30_000);
    vi.mocked(recordRunnerEnd).mockResolvedValue({ kind: 'stale', startedAt });
    const res = await post({ ...body, endedAt: endedAt.toISOString() });
    expect(res.statusCode).toBe(204);
    expect(lines('log')).toEqual([]);
    expect(lines('warn')).toEqual([`[CLAUDE-RUNNER] order ord.1: end at ${endedAt.toISOString()} is from before the current launch at ${startedAt.toISOString()}; ignored`]);
  });

  it('answers 204 without a line, and no product event, for a repeated report', async () => {
    vi.mocked(recordRunnerEnd).mockResolvedValue({ kind: 'repeat' });
    const res = await post();
    expect(res.statusCode).toBe(204);
    expect(lines('log')).toEqual([]);
    expect(productEvents()).toEqual([]);
  });

  it('answers 404 for an order it never started, and 403 for another box\'s', async () => {
    vi.mocked(recordRunnerEnd).mockResolvedValueOnce({ kind: 'unknown' });
    expect((await post()).statusCode).toBe(404);
    vi.mocked(recordRunnerEnd).mockResolvedValueOnce({ kind: 'other-box' });
    expect((await post()).statusCode).toBe(403);
    expect(lines('warn')).toEqual([
      '[CLAUDE-RUNNER] order ord.1: report from box box-a, but no start was recorded for it',
      '[CLAUDE-RUNNER] order ord.1: report from box box-a, which did not run it',
    ]);
  });

  it('records a usage summary with no event and no number in the journal, and pushes to the owner when it is the newest', async () => {
    const usage = { event: 'usage', orderId: 'ord.1', input: 10, output: 5, cacheRead: 0, cacheCreate: 0, calls: 1, model: 'claude-opus-5-5' };
    vi.mocked(recordRunnerUsage).mockResolvedValue({ kind: 'set', ...who });
    let res = await post(usage);
    expect(res.statusCode).toBe(204);
    expect(recordRunnerUsage).toHaveBeenCalledWith('box-a', expect.objectContaining({ event: 'usage', input: 10n }));
    expect(recordSessionEvent).not.toHaveBeenCalled();
    expect(notifyCloudSessionChange).toHaveBeenCalledWith({ id: 'u1', unixUsername: 'ada' }, 'cse_01A');
    expect(lines('log').join('\n')).not.toMatch(/\b10\b/);
    vi.mocked(notifyCloudSessionChange).mockClear();
    vi.mocked(recordRunnerUsage).mockResolvedValue({ kind: 'stale', ...who });
    res = await post(usage);
    expect(res.statusCode).toBe(204);
    expect(notifyCloudSessionChange).not.toHaveBeenCalled();
    vi.mocked(recordRunnerUsage).mockResolvedValue({ kind: 'other-box' });
    res = await post(usage);
    expect(res.statusCode).toBe(403);
    expect((await post({ ...usage, input: -4 })).statusCode).toBe(400);
  });
});
