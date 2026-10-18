import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { boxUpdatePolicyRouter } from './boxUpdatePolicy';
import { boolVariation } from '../services/featureFlags';
import { BOX_AUTO_UPDATE_FLAG } from '../services/boxUpdatePolicy';
import { prisma } from '../db';

let agentInstanceId: string | null = 'box-a';
const ada = { id: 'u1', unixUsername: 'ada', googleEmail: 'ada@example.test', displayName: 'Ada', defaultAgentProvider: 'claude' };
const box = { id: 'box-a', name: 'ada-box', kind: 'ec2', user: { unixUsername: 'ada' } };
vi.mock('../db', () => ({ prisma: { instance: { findUnique: vi.fn(async () => ({ id: 'box-a', name: 'ada-box', kind: 'ec2', user: { unixUsername: 'ada' } })), update: vi.fn(async () => ({})) } } }));
vi.mock('../middleware/auth', () => ({
  requireAuthOrAgentToken: vi.fn((req: Request, _res: Response, next: NextFunction) => {
    req.user = ada as never;
    req.agentInstanceId = agentInstanceId;
    next();
  }),
}));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));

interface RouteLayer { route?: { path: string; stack: { handle: RequestHandler }[] } }

/** Runs GET /policy and resolves with the response once the handler has answered. */
async function get() {
  const layer = (boxUpdatePolicyRouter().stack as RouteLayer[]).find(l => l.route?.path === '/policy')!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: { body: unknown }, body: unknown) { this.body = body; answered(); return this; }),
  });
  const req = { headers: {} } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res;
}

describe('GET /api/box-update/policy', () => {
  beforeEach(() => {
    agentInstanceId = 'box-a';
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.clearAllMocks());

  it('refuses a caller without an instance-bound agent token', async () => {
    agentInstanceId = null;
    const res = await get();
    expect(res.statusCode).toBe(403);
    expect(boolVariation).not.toHaveBeenCalled();
  });

  it('says no while the flag is off for the owner', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: false, reason: 'flag-off' });
    expect(boolVariation).toHaveBeenCalledWith(BOX_AUTO_UPDATE_FLAG, ada, false, box);
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0]))).toEqual([
      "[BOX-UPDATE] policy for ada's box box-a: off (flag-off)",
    ]);
  });

  it('says yes once the flag is on for the owner', async () => {
    vi.mocked(boolVariation).mockResolvedValueOnce(true);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true });
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0]))).toEqual([
      "[BOX-UPDATE] policy for ada's box box-a: enabled",
    ]);
  });

  it('falls back to off when the flag is not set', async () => {
    // boolVariation's fallback argument is what an unconfigured SDK returns.
    const res = await get();
    expect(vi.mocked(boolVariation).mock.calls[0][2]).toBe(false);
    expect(res.body).toEqual({ enabled: false, reason: 'flag-off' });
  });
});

describe('POST /api/box-update/report', () => {
  async function post(body: unknown) {
    const layer = (boxUpdatePolicyRouter().stack as RouteLayer[]).find(l => l.route?.path === '/report')!;
    let answered!: () => void;
    const done = new Promise<void>(r => { answered = r; });
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      body: undefined as unknown,
      status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
      json: vi.fn(function (this: { body: unknown }, b: unknown) { this.body = b; answered(); return this; }),
      end: vi.fn(function (this: unknown) { answered(); return this; }),
    });
    const req = { headers: {}, body } as unknown as Request;
    for (const { handle } of layer.route!.stack) {
      let advanced = false;
      await handle(req, res as unknown as Response, () => { advanced = true; });
      if (!advanced) break;
    }
    await done;
    return res;
  }
  const report = { event: 'box-update', outcome: 'deferred', pull: 'pulled:2', reconcile: 'clean', deps: 'unchanged', agent: 'deferred:runner', from: 'a'.repeat(40), to: 'b'.repeat(40) };

  beforeEach(() => { agentInstanceId = 'box-a'; vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes the report on the box row and logs one line with the outcome, the range and the steps', async () => {
    const res = await post(report);
    expect(res.statusCode).toBe(204);
    expect(prisma.instance.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'box-a' }, data: expect.objectContaining({ lastUpdateOutcome: 'deferred', lastUpdateCommit: 'b'.repeat(40) }) }));
    const line = vi.mocked(console.log).mock.calls.map(c => String(c[0])).find(l => l.includes('reports deferred'));
    expect(line).toContain('ada-box (ada) reports deferred: aaaaaaaaaaaa..bbbbbbbbbbbb pull=pulled:2 reconcile=clean deps=unchanged agent=deferred:runner');
  });
  it('refuses a browser session, a malformed body and an unknown box', async () => {
    expect((await post({ ...report, outcome: 'fine' })).statusCode).toBe(400);
    agentInstanceId = null;
    expect((await post(report)).statusCode).toBe(403);
    agentInstanceId = 'box-a';
    vi.mocked(prisma.instance.findUnique).mockResolvedValueOnce(null as never);
    expect((await post(report)).statusCode).toBe(404);
  });
});
