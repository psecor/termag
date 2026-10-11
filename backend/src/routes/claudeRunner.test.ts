import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response } from 'express';
import { DRAINING_ERROR, OWNER_NOT_FOUND, claudeRunnerRouter } from './claudeRunner';
import { prisma } from '../db';
import { instanceAgentTransport, isInstanceAgentConnected, sendToInstanceAgent } from '../services/agentRegistry';
import { findUserByEmail } from '../services/userByEmail';
import { discardRunnerStart, recordRunnerStart } from '../services/claudeRunnerSessions';
import { recordSessionEvent } from '../services/claudeSessionEvents';

vi.mock('../db', () => ({ prisma: { instance: { findMany: vi.fn() } } }));
vi.mock('../services/userByEmail', () => ({ findUserByEmail: vi.fn() }));
vi.mock('../services/claudeRunnerSessions', () => ({ recordRunnerStart: vi.fn(async () => {}), discardRunnerStart: vi.fn(async () => {}) }));
vi.mock('../services/claudeSessionEvents', () => ({ recordSessionEvent: vi.fn(async () => {}) }));
const events = () => vi.mocked(recordSessionEvent).mock.calls.map(c => [c[0].kind, c[0].detail ?? null, c[0].instanceId ?? null]);
vi.mock('../services/agentRegistry', () => ({
  instanceAgentTransport: vi.fn(), isInstanceAgentConnected: vi.fn(), sendToInstanceAgent: vi.fn(),
}));
vi.mock('../services/credentialStore', () => ({ getCredentialStoreConfig: vi.fn(() => null), githubStoreDeps: vi.fn() }));
vi.mock('../services/githubBroker', () => ({ getGithubBrokerUrl: vi.fn(() => null) }));

const TOKEN = 'spawn-token';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmRlciJ9.c2lnbmF0dXJl'; // gitleaks:allow
const body = { orderId: 'ord.1', sessionId: 'sess-1', accountEmail: 'ada@example.com', workOrder: JWT };

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

/** Runs POST /spawn and resolves with the response once the handler has answered. */
async function spawn(opts: { token?: string; peer?: string; gone?: boolean; serving?: boolean } = {}) {
  const layer = (claudeRunnerRouter(TOKEN, () => opts.serving ?? true).stack as RouteLayer[]).find(l => l.route?.path === '/spawn')!;
  let answered!: () => void;
  const done = new Promise<void>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false,
    error: undefined as unknown,
    status: vi.fn().mockReturnThis(),
    json: vi.fn(function (this: { writableFinished: boolean }) { this.writableFinished = true; answered(); return this; }),
  });
  if (opts.gone) setImmediate(() => res.emit('close'));
  const req = {
    body, socket: { remoteAddress: opts.peer ?? '127.0.0.1' },
    headers: { authorization: `Bearer ${opts.token ?? TOKEN}` },
  } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    // asyncHandler hands a rejection to next(err) (apiErrorHandler's 500 in production).
    handle(req, res as unknown as Response, (err?: unknown) => { advanced = true; if (err !== undefined) { res.error = err; answered(); } });
    if (!advanced) break;
  }
  await done;
  return res;
}

const box = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, kind: 'ec2', status: 'ready', hostHome: '/home/ada', hostUnixUser: 'ada',
  lastConnectedAt: new Date('2026-10-06T10:00:00Z'), ...over,
});

/** Box agents: `sessions` per box id; every other RPC succeeds unless `fail` names it. */
function agents(sessions: Record<string, string[]>, fail: string[] = []) {
  vi.mocked(sendToInstanceAgent).mockImplementation(async (id: string, type: string) => {
    if (fail.includes(type)) throw new Error(`${type} failed`);
    if (type === 'tmux-list') return { sessions: sessions[id] ?? [] };
    if (type === 'tmux-create') return { ok: true, created: true };
    return { ok: true };
  });
}
const calls = (type: string) => vi.mocked(sendToInstanceAgent).mock.calls.filter(c => c[1] === type);
/** The one `[CLAUDE-RUNNER] order ...` line each spawn logs to the orchestrator journal. */
const outcomeLines = () => vi.mocked(console.log).mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[CLAUDE-RUNNER] order'));

describe('POST /internal/claude-runner/spawn', () => {
  beforeEach(() => {
    vi.mocked(findUserByEmail).mockResolvedValue({ id: 'u1', googleEmail: 'ada@example.com', unixUsername: 'ada' } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(prisma.instance.findMany).mockResolvedValue([box('box-a')] as never);
    vi.mocked(isInstanceAgentConnected).mockReturnValue(true);
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: ['credentials-v1', 'tmux-create-command-v1'], agentCommit: null });
    agents({});
  });
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

  it('refuses a wrong token and a non-loopback peer', async () => {
    expect((await spawn({ token: 'nope' })).status).toHaveBeenCalledWith(401);
    expect((await spawn({ peer: '10.0.4.9' })).status).toHaveBeenCalledWith(401);
    expect(sendToInstanceAgent).not.toHaveBeenCalled();
  });

  it('answers a retryable 503 at once while draining, before looking up the owner', async () => {
    const res = await spawn({ serving: false });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: DRAINING_ERROR });
    expect(findUserByEmail).not.toHaveBeenCalled();
    expect(sendToInstanceAgent).not.toHaveBeenCalled();
    expect(recordSessionEvent).not.toHaveBeenCalled();
  });

  it('answers 404 with a code the hook can tell from an unmounted route', async () => {
    vi.mocked(findUserByEmail).mockResolvedValue(null);
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: OWNER_NOT_FOUND }));
  });

  it('launches the runner as the session command, with the work order 0600', async () => {
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(calls('write-file')[0][2]).toEqual({ path: '/home/ada/.termag/claude-runner/ord.1.work-order', content: `${JWT}\n`, mode: 0o600 });
    expect(calls('tmux-create')[0][2]).toEqual({
      sessionName: 'ada-claude-runner-s2-ord_d1-r', cwd: '/home/ada/.termag/claude-runner', gitInit: false,
      command: ['/home/ada/.local/bin/termag-claude-runner', 'ord.1', '2'],
    });
    expect(calls('tmux-send-keys')).toEqual([]);
    expect(outcomeLines()).toEqual(['[CLAUDE-RUNNER] order ord.1 for ada started on box-a (box-a) as ada-claude-runner-s2-ord_d1-r (slot 2)']);
    expect(recordRunnerStart).toHaveBeenCalledWith({ orderId: 'ord.1', sessionId: 'sess-1', userId: 'u1', instanceId: 'box-a', slot: 2, startedAt: expect.any(Date) });
    expect(events()).toEqual([['placed', 'box-a slot 2', 'box-a']]);
    expect(vi.mocked(recordSessionEvent).mock.calls[0][0]).toMatchObject({ owner: { id: 'u1', unixUsername: 'ada' }, sessionId: 'sess-1', orderId: 'ord.1' });
    // Before the launch: a runner that exits at once reports within a second.
    const recordedAt = vi.mocked(recordRunnerStart).mock.invocationCallOrder[0];
    const launchedAt = vi.mocked(sendToInstanceAgent).mock.invocationCallOrder[vi.mocked(sendToInstanceAgent).mock.calls.findIndex(c => c[1] === 'tmux-create')];
    expect(recordedAt).toBeLessThan(launchedAt);
    expect(discardRunnerStart).not.toHaveBeenCalled();
  });

  it('still answers 202 when the session record cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(recordRunnerStart).mockRejectedValueOnce(new Error('db down'));
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(vi.mocked(console.error).mock.calls.map(c => String(c[0]))).toContain('[CLAUDE-RUNNER] order ord.1: recording the start failed:');
  });

  it('logs one outcome line per order naming the owner, refusals included, never the email', async () => {
    vi.mocked(prisma.instance.findMany).mockResolvedValue([] as never);
    await spawn();
    vi.mocked(prisma.instance.findMany).mockResolvedValue([box('box-a')] as never);
    agents({ 'box-a': ['ada-claude-runner-s2-x-r', 'ada-claude-runner-s3-y-r', 'ada-claude-runner-s4-z-r'] });
    await spawn();
    vi.mocked(findUserByEmail).mockResolvedValue(null);
    await spawn();
    expect(outcomeLines()).toEqual([
      '[CLAUDE-RUNNER] order ord.1 for ada: 503 no ready termag box with a connected agent for the session owner; start or add a box in termag',
      expect.stringMatching(/^\[CLAUDE-RUNNER\] order ord\.1 for ada: 503 every box of the session owner \(.+\) already runs 3 cloud sessions/),
      '[CLAUDE-RUNNER] order ord.1: 404 the session owner is not a termag user',
    ]);
    expect(outcomeLines().join('\n')).not.toContain('ada@example.com');
    // One queued event per refusal, with the reason the Activity tab shows; none for the unknown owner.
    expect(events()).toEqual([
      ['queued', 'no ready termag box with a connected agent for the session owner; start or add a box in termag', null],
      ['queued', expect.stringMatching(/^every box of the session owner/), null],
    ]);
  });

  it('logs the owner outcome line for a failure that answers 500', async () => {
    vi.mocked(prisma.instance.findMany).mockRejectedValue(new Error('db down'));
    const res = await spawn();
    expect(res.error).toEqual(new Error('db down'));
    expect(res.json).not.toHaveBeenCalled();
    expect(outcomeLines()).toEqual(['[CLAUDE-RUNNER] order ord.1 for ada: 500 db down']);
  });

  it('hands the runner the telemetry destination when the orchestrator ships telemetry', async () => {
    vi.stubEnv('OBSERVABILITY_PROJECT', 'termag-prod');
    vi.stubEnv('OBSERVABILITY_OTLP_ENDPOINT', 'https://otel.example.com');
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(calls('tmux-create')[0][2]).toEqual(expect.objectContaining({
      command: [
        '/home/ada/.local/bin/termag-claude-runner', 'ord.1', '2', '--otel-project', 'termag-prod', '--otel-endpoint', 'https://otel.example.com',
        // The owner's and the box's keys, so the session's telemetry joins to both.
        '--user-key', 'u1', '--box-key', 'box-a',
      ],
    }));
  });

  it('refuses a box whose agent cannot run a session command, without touching it', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: ['credentials-v1'], agentCommit: null });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('too old') });
    expect(sendToInstanceAgent).not.toHaveBeenCalled();
  });

  it('answers "already running" for an order whose session is live on another box', async () => {
    vi.mocked(prisma.instance.findMany).mockResolvedValue([
      box('box-a', { lastConnectedAt: new Date('2026-10-06T12:00:00Z') }), box('box-b'),
    ] as never);
    agents({ 'box-b': ['ada-claude-runner-s3-ord_d1-r'] });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'box-b', slot: 3, alreadyRunning: true }));
    expect(calls('write-file')).toEqual([]);
    expect(recordRunnerStart).not.toHaveBeenCalled();
    expect(events()).toEqual([['already-running', 'box-b slot 3', 'box-b']]);
  });

  it('places the session on another box when the favourite one is full', async () => {
    vi.mocked(prisma.instance.findMany).mockResolvedValue([
      box('box-a', { lastConnectedAt: new Date('2026-10-06T12:00:00Z') }), box('box-b'),
    ] as never);
    agents({ 'box-a': ['ada-claude-runner-s2-x-r', 'ada-claude-runner-s3-y-r', 'ada-claude-runner-s4-z-r'] });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(calls('tmux-create')[0][0]).toBe('box-b');
  });

  it('drops the session and empties the work order when the launch fails', async () => {
    agents({}, ['tmux-create']);
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(calls('tmux-kill')[0][2]).toEqual({ sessionName: 'ada-claude-runner-s2-ord_d1-r', exact: true });
    expect(calls('write-file').at(-1)![2]).toEqual({ path: '/home/ada/.termag/claude-runner/ord.1.work-order', content: '' });
    expect(discardRunnerStart).toHaveBeenCalledWith('ord.1');
    expect(events()).toEqual([['agent-failed', expect.stringContaining('refused the launch'), null]]);
  });

  it('retries instead of guessing when a box cannot list its sessions', async () => {
    agents({}, ['tmux-list']);
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(calls('write-file')).toEqual([]);
  });

  it('does not launch once the hook has stopped waiting', async () => {
    let releaseList!: () => void;
    vi.mocked(sendToInstanceAgent).mockImplementation(async (_id: string, type: string) => {
      if (type === 'tmux-list') { await new Promise<void>(r => { releaseList = r; }); return { sessions: [] }; }
      return { ok: true, created: true };
    });
    const pending = spawn({ gone: true });
    await vi.waitFor(() => expect(releaseList).toBeTypeOf('function'));
    await new Promise(r => setImmediate(r));
    releaseList();
    await pending;
    expect(calls('write-file')).toEqual([]);
    expect(calls('tmux-create')).toEqual([]);
  });
});
