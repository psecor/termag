import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

let agentInstanceId: string | null = 'box-a';
const ada = { id: 'u1', unixUsername: 'ada' };
vi.mock('../middleware/auth', () => ({
  requireAuthOrAgentToken: vi.fn((req: Request, _res: Response, next: NextFunction) => {
    req.user = ada as never;
    req.agentInstanceId = agentInstanceId;
    next();
  }),
}));
vi.mock('../services/toolUpdate/runs', () => ({
  boxPolicy: vi.fn(async () => ({ status: 200, start: false, expire: false, body: { floor: '2.1.308', target: 'latest', restart: 'none', drainSec: 600, run: null } })),
  recordToolUpdateReport: vi.fn(async () => ({ status: 204, runId: 'r1', box: { id: 'box-a', name: 'ada-box', user: ada } })),
  afterReport: vi.fn(async () => {}),
}));
const { LOG_DETAIL_MAX, logDetail, toolUpdateRouter } = await import('./toolUpdate');
const { afterReport, boxPolicy, recordToolUpdateReport } = await import('../services/toolUpdate/runs');
const { TOOL_REGISTRY } = await import('../services/toolUpdate/components');

interface RouteLayer { route?: { path: string; stack: { handle: RequestHandler }[] } }
async function run(path: string, req: Record<string, unknown>) {
  const layer = (toolUpdateRouter().stack as RouteLayer[]).find(l => l.route?.path === path)!;
  const res: any = { statusCode: 200, body: undefined, ended: false,
    status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; }, end() { this.ended = true; return this; } };
  const r = { headers: {}, query: {}, body: undefined, ...req } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(r, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

describe('/api/tool-update', () => {
  beforeEach(() => { agentInstanceId = 'box-a'; vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.clearAllMocks());

  it('takes only an instance-bound agent token', async () => {
    agentInstanceId = null;
    expect((await run('/policy', { query: { component: 'claude' } })).statusCode).toBe(403);
    expect((await run('/report', { body: { component: 'claude', trigger: 'boot', outcome: 'current' } })).statusCode).toBe(403);
    expect(boxPolicy).not.toHaveBeenCalled();
  });

  it('answers the policy for the box and the run asked', async () => {
    const res = await run('/policy', { query: { component: 'claude', run: 'ckz9v1q2w0000abcd1234efgh' } });
    expect(res.body).toEqual({ floor: '2.1.308', target: 'latest', restart: 'none', drainSec: 600, run: null });
    expect(vi.mocked(boxPolicy).mock.calls[0]).toEqual([TOOL_REGISTRY.claude, 'box-a', ada, 'ckz9v1q2w0000abcd1234efgh', expect.any(Number), false]);
  });

  it('passes atStart=1, Docker\'s boot fetch, with no run id', async () => {
    await run('/policy', { query: { component: 'docker', atStart: '1' } });
    expect(vi.mocked(boxPolicy).mock.calls[0]).toEqual([TOOL_REGISTRY.docker, 'box-a', ada, null, expect.any(Number), true]);
  });

  it('answers Codex\'s policy with Codex\'s descriptor, and takes its report', async () => {
    await run('/policy', { query: { component: 'codex', run: 'ckz9v1q2w0000abcd1234efgh' } });
    expect(vi.mocked(boxPolicy).mock.calls[0]).toEqual([TOOL_REGISTRY.codex, 'box-a', ada, 'ckz9v1q2w0000abcd1234efgh', expect.any(Number), false]);
    const id = '01a18c85-d963-7800-93d4-991c84da09d5';
    const res = await run('/report', { body: {
      component: 'codex', trigger: 'manual', run: 'ckz9v1q2w0000abcd1234efgh', outcome: 'updated', fromVersion: '0.163.0', toVersion: '0.166.0',
      panes: [{ session: 'ada-web-agent', role: 'agent', sessionId: id, hadConversation: true }],
    } });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(recordToolUpdateReport).mock.calls[0][1]).toMatchObject({ component: 'codex', fromVersion: '0.163.0', toVersion: '0.166.0' });
    expect(vi.mocked(afterReport).mock.calls[0][1].panes).toEqual([{ session: 'ada-web-agent', role: 'agent', sessionId: id, hadConversation: true }]);
  });

  it('passes no_such_run on', async () => {
    vi.mocked(boxPolicy).mockResolvedValueOnce({ status: 404, body: { code: 'no_such_run' } });
    const res = await run('/policy', { query: { component: 'claude', run: 'x' } });
    expect([res.statusCode, res.body]).toEqual([404, { code: 'no_such_run' }]);
  });

  it('records a report, answers 204, then refreshes and relaunches', async () => {
    const res = await run('/report', { body: { component: 'claude', trigger: 'boot', outcome: 'updated', panes: [{ session: 'ada-web-agent', role: 'agent', hadConversation: false }] } });
    expect([res.statusCode, res.ended]).toEqual([204, true]);
    expect(vi.mocked(recordToolUpdateReport).mock.calls[0][0]).toBe('box-a');
    expect(vi.mocked(afterReport).mock.calls[0][1].panes).toEqual([{ session: 'ada-web-agent', role: 'agent', sessionId: null, hadConversation: false }]);
  });

  it('puts a failed or partial run\'s detail in its log line, on one line and capped', async () => {
    const detail = 'policy=ok restart=none drain=0s target=latest->- python3=/home/ada/.pyenv/versions/3.13/bin/python3 version=3.13.15->3.13.15 floor=3.13.18 state=below-floor python=3.13->FAILED:pyenv-global-not-a-version verify=-';
    const log = vi.mocked(console.log);
    await run('/report', { body: { component: 'python', trigger: 'floor', run: 'ckz9v1q2w0000abcd1234efgh', outcome: 'failed', fromVersion: '3.13.15', toVersion: '3.13.15', detail } });
    expect(log.mock.calls.at(-1)?.[0]).toBe(`[TOOL-UPDATE] ada-box (ada) reports python floor run r1: failed 3.13.15 -> 3.13.15, 0 agent pane(s) to relaunch; detail: ${detail}`);
    // A box's newlines and control characters cannot start a line of their own.
    await run('/report', { body: { component: 'python', trigger: 'floor', run: 'ckz9v1q2w0000abcd1234efgh', outcome: 'partial', detail: 'uv=FAILED\n[TOOL-UPDATE] forged\r\u001b[31m\u2028x\t y' } });
    const line = String(log.mock.calls.at(-1)?.[0]);
    expect(line).toMatch(/: partial, 0 agent pane\(s\) to relaunch; detail: uv=FAILED \[TOOL-UPDATE\] forged \[31m x y$/);
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    // Updated and current runs say nothing more.
    await run('/report', { body: { component: 'python', trigger: 'floor', run: 'ckz9v1q2w0000abcd1234efgh', outcome: 'updated', fromVersion: '3.13.16', toVersion: '3.13.18', detail } });
    expect(log.mock.calls.at(-1)?.[0]).toBe('[TOOL-UPDATE] ada-box (ada) reports python floor run r1: updated 3.13.16 -> 3.13.18, 0 agent pane(s) to relaunch');
    await run('/report', { body: { component: 'python', trigger: 'floor', run: 'ckz9v1q2w0000abcd1234efgh', outcome: 'failed' } });
    expect(log.mock.calls.at(-1)?.[0]).toBe('[TOOL-UPDATE] ada-box (ada) reports python floor run r1: failed, 0 agent pane(s) to relaunch');
  });

  it('logDetail keeps one line of a few hundred characters', () => {
    expect(logDetail(null)).toBe('');
    expect(logDetail('  a\n\n b  ')).toBe('a b');
    const long = logDetail('x'.repeat(5000));
    expect(long.length).toBe(LOG_DETAIL_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('answers a repeated report 204 and does nothing after it', async () => {
    vi.mocked(recordToolUpdateReport).mockResolvedValueOnce({ status: 204, runId: 'r1', box: { id: 'box-a', name: 'ada-box', user: ada } as never, repeat: true });
    const res = await run('/report', { body: { component: 'claude', trigger: 'manual', run: 'ckz9v1q2w0000abcd1234efgh', outcome: 'updated' } });
    expect([res.statusCode, res.ended]).toEqual([204, true]);
    expect(afterReport).not.toHaveBeenCalled();
  });

  it('refuses a malformed report before writing', async () => {
    const res = await run('/report', { body: { component: 'claude', trigger: 'manual', outcome: 'updated' } });
    expect([res.statusCode, res.body]).toEqual([400, { error: 'a manual report names its run' }]);
    expect(recordToolUpdateReport).not.toHaveBeenCalled();
  });

  it('answers unknown_component for a tool the registry does not list, or none', async () => {
    for (const query of [{}, { component: 'nope' }]) {
      const res = await run('/policy', { query });
      expect([res.statusCode, res.body.code]).toEqual([400, 'unknown_component']);
    }
    const res = await run('/report', { body: { component: 'rust', trigger: 'boot', outcome: 'updated' } });
    expect([res.statusCode, res.body.code]).toEqual([400, 'unknown_component']);
    expect(boxPolicy).not.toHaveBeenCalled();
    expect(recordToolUpdateReport).not.toHaveBeenCalled();
  });
});
