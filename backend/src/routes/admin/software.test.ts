import { describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

vi.mock('../../services/software/queries', () => ({ softwareMatrix: vi.fn(), softwareHost: vi.fn(), clientVersions: vi.fn() }));
vi.mock('../../services/software/collector', () => ({ refreshInventories: vi.fn() }));
vi.mock('../../services/toolUpdate/runs', () => ({
  updatePreview: vi.fn(async () => ({ status: 404, body: { code: 'claude_update_off' } })),
  requestHostUpdate: vi.fn(async () => ({ status: 202, body: { runId: 'r' } })),
  requestFleetUpdate: vi.fn(async () => ({ status: 202, body: { runs: [], skipped: [] } })),
  listUpdateRuns: vi.fn(async () => ({ status: 200, body: { runs: [] } })),
}));
const { softwareRouter } = await import('./software');
const { requestHostUpdate, requestFleetUpdate } = await import('../../services/toolUpdate/runs');
const { TOOL_REGISTRY } = await import('../../services/toolUpdate/components');

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { name: string; handle: Function }[] } }
const routes = (r: Router) => (r.stack as Layer[]).filter(l => l.route).map(l => ({
  key: `${Object.keys(l.route!.methods)[0].toUpperCase()} ${l.route!.path}`,
  names: l.route!.stack.map(s => s.name),
  last: l.route!.stack[l.route!.stack.length - 1].handle,
}));

async function call(key: string, req: Record<string, unknown>) {
  const route = routes(softwareRouter()).find(r => r.key === key)!;
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  await route.last({ params: {}, query: {}, body: {}, user: { id: 'admin1' }, ...req }, res, () => {});
  return res;
}

describe('the Claude Code update routes', () => {
  it('each take a signed-in admin session, never an admin token', () => {
    const update = routes(softwareRouter()).filter(r => /update/.test(r.key));
    expect(update.map(r => r.key).sort()).toEqual([
      'GET /software/hosts/:hostKey/update-preview', 'GET /software/updates', 'POST /software/hosts/:hostKey/update', 'POST /software/update',
    ]);
    for (const r of update) expect(r.names).toContain('requireAdminSession');
  });

  it('answer what the service says, its 404 code included', async () => {
    const res = await call('GET /software/hosts/:hostKey/update-preview', { params: { hostKey: 'box-a' } });
    expect([res.statusCode, res.body]).toEqual([404, { code: 'claude_update_off' }]);
  });

  it('check the body before asking anything', async () => {
    expect((await call('POST /software/hosts/:hostKey/update', { params: { hostKey: 'box-a' }, body: { component: 'claude', restart: 'now' } })).statusCode).toBe(400);
    const unknown = await call('POST /software/hosts/:hostKey/update', { params: { hostKey: 'box-a' }, body: { component: 'nope', restart: 'idle' } });
    expect([unknown.statusCode, unknown.body.code]).toEqual([400, 'unknown_component']);
    expect((await call('GET /software/updates', { query: { component: 'python' } })).body.code).toBe('unknown_component');
    expect((await call('POST /software/update', { body: { component: 'claude', scope: 'some', restart: 'idle' } })).statusCode).toBe(400);
    expect(requestHostUpdate).not.toHaveBeenCalled();
    expect(requestFleetUpdate).not.toHaveBeenCalled();
    expect((await call('POST /software/hosts/:hostKey/update', { params: { hostKey: 'box-a' }, body: { component: 'claude', restart: 'idle' } })).statusCode).toBe(202);
    expect(vi.mocked(requestHostUpdate).mock.calls[0].slice(0, 3)).toEqual([TOOL_REGISTRY.claude, 'box-a', 'idle']);
    expect((await call('POST /software/update', { body: { component: 'claude', scope: 'behind', restart: 'none' } })).body).toEqual({ runs: [], skipped: [] });
  });

  it('take component codex to Codex\'s descriptor on every route', async () => {
    const { updatePreview, listUpdateRuns } = await import('../../services/toolUpdate/runs');
    await call('GET /software/hosts/:hostKey/update-preview', { params: { hostKey: 'box-a' }, query: { component: 'codex' } });
    expect(vi.mocked(updatePreview).mock.lastCall?.slice(0, 2)).toEqual([TOOL_REGISTRY.codex, 'box-a']);
    await call('POST /software/hosts/:hostKey/update', { params: { hostKey: 'box-a' }, body: { component: 'codex', restart: 'force' } });
    expect(vi.mocked(requestHostUpdate).mock.lastCall?.slice(0, 3)).toEqual([TOOL_REGISTRY.codex, 'box-a', 'force']);
    await call('POST /software/update', { body: { component: 'codex', scope: 'below-floor', restart: 'idle' } });
    expect(vi.mocked(requestFleetUpdate).mock.lastCall?.slice(0, 3)).toEqual([TOOL_REGISTRY.codex, 'below-floor', 'idle']);
    await call('GET /software/updates', { query: { component: 'codex' } });
    expect(vi.mocked(listUpdateRuns).mock.lastCall?.[0]).toBe(TOOL_REGISTRY.codex);
  });
});
