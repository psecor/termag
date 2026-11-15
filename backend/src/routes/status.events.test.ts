import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { statusRouter } from './status';
import { recordProductEvent } from '../services/productEvents';
import { resolveSessionProject } from '../services/sessionResolver';

// What leaves a box, as product events (docs/agents/observability.md): the
// edit route's agent.file.edited, the mcp route's agent.mcp.used and the
// milestone's pr.opened / pr.merged.
vi.mock('../db', () => ({ prisma: { instance: { findUnique: vi.fn() }, project: { updateMany: vi.fn(() => ({ catch: () => {} })) } } }));
vi.mock('../middleware/auth', () => ({
  requireAuth: vi.fn(),
  requireAuthOrAgentToken: vi.fn(async (req: Request, _res: Response, next: () => void) => {
    req.user = { id: 'u1', unixUsername: 'ffox' } as never;
    req.agentInstanceId = 'box-a';
    next();
  }),
}));
vi.mock('../services/status', () => ({
  setStatus: vi.fn(() => ({ status: 'working', updatedAt: new Date() })), getStatus: vi.fn(), getAllStatuses: vi.fn(() => new Map()),
  updateStatusMeta: vi.fn(), notifyStatusChange: vi.fn(), armMilestoneTimer: vi.fn(), clearMilestoneTimer: vi.fn(),
}));
vi.mock('../slack/lts', () => ({ getAllNotificationTargets: vi.fn(async () => []) }));
vi.mock('../slack/app', () => ({ getSlackApp: vi.fn(() => null) }));
vi.mock('../discord/app', () => ({ getDiscordClient: vi.fn(() => null) }));
vi.mock('../slack/tmuxAgent', () => ({ capturePaneForSlack: vi.fn() }));
vi.mock('../services/humanActivity', () => ({ recordHeartbeat: vi.fn() }));
vi.mock('../services/sessionResolver', () => ({
  resolveSessionProject: vi.fn(async () => null),
  isAmbiguousSession: (v: unknown) => !!v && typeof v === 'object' && (v as { ambiguous?: boolean }).ambiguous === true,
}));
vi.mock('../services/contextSampler', () => ({ recordContextSample: vi.fn() }));
vi.mock('./agentTokens', () => ({ validateAgentToken: vi.fn() }));
vi.mock('../services/workstreamPrs', () => ({ recordCreatedLink: vi.fn(async () => {}) }));
vi.mock('../services/productEvents', () => ({ recordProductEvent: vi.fn() }));
vi.mock('../services/mcpConnectorStore', () => ({
  ldUserForId: vi.fn(async (id?: string) => (id ? { id } : null)),
  catalogNamesForUser: vi.fn(async () => ['acme-docs']),
}));
const mcpEventsOn = { value: true };
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => mcpEventsOn.value) }));

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

async function post(path: string, body: Record<string, unknown>, peer = '10.0.4.9') {
  const layer = ((statusRouter() as Router).stack as RouteLayer[]).find(l => l.route?.path === path && l.route.methods.post)!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    json: vi.fn(function (this: unknown) { answered(); return this; }),
  });
  const req = { body, headers: {}, socket: { remoteAddress: peer }, ip: peer } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    await handle(req, res as unknown as Response, () => { advanced = true; });
    if (!advanced) break;
  }
  await done;
  return res;
}

describe('POST /api/status/edit', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.clearAllMocks());

  it('records the directory, tool and Claude session for the owner and the box', async () => {
    const res = await post('/edit', { session: 'ffox-webapp-agent', dir: 'verifiers/billing', tool: 'Edit', claudeSession: '818686a7-4ce0-440a-ae11-522472afeecd' });
    expect(res.statusCode).toBe(200);
    expect(recordProductEvent).toHaveBeenCalledWith('agent.file.edited', { user: 'u1', box: 'box-a' },
      { dir: 'verifiers/billing', tool: 'Edit', claudeSession: '818686a7-4ce0-440a-ae11-522472afeecd' });
  });

  it('refuses a deeper path and another user\'s session, and records nothing', async () => {
    expect((await post('/edit', { session: 'ffox-webapp-agent', dir: 'a/b/c', tool: 'Edit' })).statusCode).toBe(400);
    expect((await post('/edit', { session: 'someoneelse-webapp-agent', dir: 'src', tool: 'Write' })).statusCode).toBe(403);
    expect(recordProductEvent).not.toHaveBeenCalled();
  });
});

describe('POST /api/status/mcp', () => {
  beforeEach(() => { mcpEventsOn.value = true; vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.clearAllMocks());

  it('names a known server and its tool, and a catalog server', async () => {
    const res = await post('/mcp', { session: 'ffox-webapp-agent', server: 'acme-observability', tool: 'search-logs', outcome: 'ok', claudeSession: '818686a7-4ce0-440a-ae11-522472afeecd' });
    expect(res.statusCode).toBe(200);
    expect(recordProductEvent).toHaveBeenCalledWith('agent.mcp.used', { user: 'u1', box: 'box-a' },
      { server: 'acme-observability', tool: 'search-logs', outcome: 'ok', claudeSession: '818686a7-4ce0-440a-ae11-522472afeecd' });
    await post('/mcp', { session: 'ffox-webapp-agent', server: 'acme-docs', tool: 'lookup', outcome: 'error' });
    expect(recordProductEvent).toHaveBeenLastCalledWith('agent.mcp.used', { user: 'u1', box: 'box-a' },
      { server: 'acme-docs', tool: 'lookup', outcome: 'error', claudeSession: null });
  });

  it('records any other server as other, with no tool', async () => {
    await post('/mcp', { session: 'ffox-webapp-agent', server: 'my-private-thing', tool: 'read_secret_notes', outcome: 'ok' });
    expect(recordProductEvent).toHaveBeenCalledWith('agent.mcp.used', { user: 'u1', box: 'box-a' }, { server: 'other', outcome: 'ok', claudeSession: null });
  });

  it('answers 404 and records nothing while agent-mcp-events-enabled is off', async () => {
    mcpEventsOn.value = false;
    const res = await post('/mcp', { session: 'ffox-webapp-agent', server: 'metaterm', tool: 'list_sessions', outcome: 'ok' });
    expect(res.statusCode).toBe(404);
    expect(recordProductEvent).not.toHaveBeenCalled();
  });

  it('refuses a bad body and another user\'s session, and records nothing', async () => {
    expect((await post('/mcp', { session: 'ffox-webapp-agent', server: 'metaterm', tool: 'list_sessions', outcome: 'maybe' })).statusCode).toBe(400);
    expect((await post('/mcp', { session: 'ffox-webapp-agent', server: 'meta term', tool: 'x', outcome: 'ok' })).statusCode).toBe(400);
    expect((await post('/mcp', { session: 'someoneelse-webapp-agent', server: 'metaterm', tool: 'x', outcome: 'ok' })).statusCode).toBe(403);
    expect(recordProductEvent).not.toHaveBeenCalled();
  });
});

describe('POST /api/status/milestone: pr.opened and pr.merged', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.clearAllMocks());

  it('names the PR by repository and number', async () => {
    await post('/milestone', { session: 'ffox-webapp-agent', kind: 'pr_created', url: 'https://github.com/acme/widgets/pull/7' });
    expect(recordProductEvent).toHaveBeenCalledWith('pr.opened', { user: 'u1', box: 'box-a' }, { repo: 'acme/widgets', number: 7 });
    await post('/milestone', { session: 'ffox-webapp-agent', kind: 'pr_merged', url: null });
    expect(recordProductEvent).toHaveBeenCalledWith('pr.merged', { user: 'u1', box: 'box-a' }, { repo: undefined, number: undefined });
  });
});

describe('a same-host hook\'s events', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.clearAllMocks());

  it('name the owner of the orchestrator project the session builds', async () => {
    vi.mocked(resolveSessionProject).mockResolvedValueOnce({ userId: 'u7', instanceId: null, projectId: 'p1', workstream: 'main' });
    expect((await post('/edit', { session: 'ada-webapp-agent', dir: 'src', tool: 'Write' }, '127.0.0.1')).statusCode).toBe(200);
    expect(resolveSessionProject).toHaveBeenCalledWith('ada-webapp-agent', null);
    expect(recordProductEvent).toHaveBeenCalledWith('agent.file.edited', { user: 'u7', box: null }, expect.anything());
    vi.mocked(resolveSessionProject).mockResolvedValueOnce({ userId: 'u7', instanceId: null, projectId: 'p1', workstream: 'main' });
    await post('/milestone', { session: 'ada-webapp-agent', kind: 'pr_created', url: 'https://github.com/acme/widgets/pull/7' }, '127.0.0.1');
    expect(recordProductEvent).toHaveBeenCalledWith('pr.opened', { user: 'u7', box: null }, { repo: 'acme/widgets', number: 7 });
  });

  it('go out without a user when no one project matches', async () => {
    vi.mocked(resolveSessionProject).mockResolvedValueOnce({ ambiguous: true });
    await post('/edit', { session: 'ada-webapp-agent', dir: 'src', tool: 'Write' }, '127.0.0.1');
    vi.mocked(resolveSessionProject).mockResolvedValueOnce({ userId: 'u7', instanceId: null, projectId: null, workstream: null });
    await post('/edit', { session: 'ada-webapp-agent', dir: 'src', tool: 'Write' }, '127.0.0.1');
    vi.mocked(resolveSessionProject).mockRejectedValueOnce(new Error('db down'));
    await post('/edit', { session: 'ada-webapp-agent', dir: 'src', tool: 'Write' }, '127.0.0.1');
    expect(vi.mocked(recordProductEvent).mock.calls.map(c => c[1])).toEqual([
      { user: undefined, box: null }, { user: undefined, box: null }, { user: undefined, box: null },
    ]);
  });
});
