import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response } from 'express';
import { DRAINING_ERROR, OWNER_NOT_FOUND, claudeRunnerRouter } from './claudeRunner';
import { prisma } from '../db';
import { instanceAgentTransport, isInstanceAgentConnected, sendToInstanceAgent } from '../services/agentRegistry';
import { findUserByEmail } from '../services/userByEmail';
import { discardRunnerStart, recordRunnerStart } from '../services/claudeRunnerSessions';
import { recordSessionEvent } from '../services/claudeSessionEvents';
import { boolVariation } from '../services/featureFlags';
import { isBoxProvisioningConfigured, provisionNewBox } from '../services/boxProvisioner';
import { requestPower } from '../services/boxPower';
import { claimWarmBox } from '../services/warmPoolClaim';
import { poolSpecHashOrNull } from '../services/warmPool';
import { boxCreationRefusal, readBoxCreationFacts } from '../services/boxCreationGate';
import { boxImageSelectionFor } from '../services/boxImage';
import { ownerHibernationEnabled } from '../services/boxHibernationFlag';
import { deliveryInFlight } from '../services/credentialDelivery';
import { createOwnerFromAllowlist, slackRealName } from '../services/claudeRunnerOwner';
import { notifyGithubAbsent, notifyRefusal } from '../services/claudeRunnerNotices';
import { getCredentialStoreConfig, githubStoreDeps } from '../services/credentialStore';
import { getGithubBrokerUrl } from '../services/githubBroker';

vi.mock('../db', () => ({ prisma: { instance: { findMany: vi.fn(), findUnique: vi.fn() } } }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('../services/boxProvisioner', () => ({
  isBoxProvisioningConfigured: vi.fn(() => true),
  provisionNewBox: vi.fn(async (_user: unknown, base: string) => base),
  pickFreeBoxName: (taken: Set<string>, base: string) => (taken.has(base) ? `${base}-2` : base),
  isConcurrentCreate: (err: { code?: string } | null) => err?.code === 'P2034',
}));
vi.mock('../services/boxPower', () => ({ requestPower: vi.fn(async () => 'i-1'), PowerRequestConflict: class extends Error {} }));
vi.mock('../services/warmPoolClaim', () => ({
  claimWarmBox: vi.fn(), prismaClaimEffects: {}, WARM_POOL_ENABLED_FLAG: 'warm-pool-enabled',
  isNameConflict: (err: { code?: string } | null) => err?.code === 'P2002',
}));
vi.mock('../services/warmPool', () => ({ poolSpecHashOrNull: vi.fn(async () => null), reconcileWarmPool: vi.fn(async () => {}) }));
vi.mock('../services/boxImage', () => ({
  boxImageSelectionFor: vi.fn(async () => ({ kind: 'published' })),
  isPublished: (selection: { kind: string }) => selection.kind === 'published',
}));
vi.mock('../services/boxHibernationFlag', () => ({ ownerHibernationEnabled: vi.fn(async () => false), poolHibernationEnabled: vi.fn(async () => false) }));
vi.mock('../services/boxCreationGate', () => ({
  readBoxCreationFacts: vi.fn(async () => ({ required: false, flagOn: false, hasGithubCredential: false })),
  boxCreationRefusal: vi.fn(() => null),
}));
vi.mock('../services/userByEmail', () => ({ findUserByEmail: vi.fn() }));
vi.mock('../services/claudeRunnerSessions', () => ({ recordRunnerStart: vi.fn(async () => {}), discardRunnerStart: vi.fn(async () => {}) }));
vi.mock('../services/claudeSessionEvents', () => ({ recordSessionEvent: vi.fn(async () => {}) }));
const events = () => vi.mocked(recordSessionEvent).mock.calls.map(c => [c[0].kind, c[0].detail ?? null, c[0].instanceId ?? null]);
/** The refusal codes the events carried, in order (null for a placement). */
const codes = () => vi.mocked(recordSessionEvent).mock.calls.map(c => c[0].code ?? null);
vi.mock('../services/agentRegistry', () => ({
  instanceAgentTransport: vi.fn(), isInstanceAgentConnected: vi.fn(), sendToInstanceAgent: vi.fn(),
}));
vi.mock('../services/credentialStore', () => ({ getCredentialStoreConfig: vi.fn(() => null), githubStoreDeps: vi.fn() }));
vi.mock('../services/credentialDelivery', () => ({ deliveryInFlight: vi.fn(() => null) }));
vi.mock('../services/claudeRunnerNotices', () => ({ notifyRefusal: vi.fn(async () => false), notifyGithubAbsent: vi.fn(async () => false) }));
vi.mock('../services/claudeRunnerOwner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/claudeRunnerOwner')>()),
  createOwnerFromAllowlist: vi.fn(), slackRealName: vi.fn(async () => null),
}));
vi.mock('../services/githubBroker', () => ({ getGithubBrokerUrl: vi.fn(() => null) }));

const TOKEN = 'spawn-token';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmRlciJ9.c2lnbmF0dXJl'; // gitleaks:allow
const body = { orderId: 'ord.1', sessionId: 'sess-1', accountEmail: 'ada@example.com', workOrder: JWT };

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

/** Runs POST /spawn and resolves with the response once the handler has answered. */
async function spawn(opts: { token?: string; peer?: string; gone?: boolean; serving?: boolean; budgetMs?: number; body?: typeof body } = {}) {
  const layer = (claudeRunnerRouter(TOKEN, () => opts.serving ?? true, { placementBudgetMs: opts.budgetMs }).stack as RouteLayer[]).find(l => l.route?.path === '/spawn')!;
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
    body: opts.body ?? body, socket: { remoteAddress: opts.peer ?? '127.0.0.1' },
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
    // ... and its stable code, which the body carries too (the hook ignores it).
    expect(codes()).toEqual(['no-box', 'boxes-full']);
  });

  it('answers every refusal with its code beside the text', async () => {
    vi.mocked(prisma.instance.findMany).mockResolvedValue([] as never);
    expect((await spawn()).json).toHaveBeenCalledWith({ error: expect.stringContaining('start or add a box'), code: 'no-box' });
    vi.mocked(prisma.instance.findMany).mockResolvedValue([box('box-a')] as never);
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: ['credentials-v1'], agentCommit: null });
    expect((await spawn()).json).toHaveBeenCalledWith({ error: expect.stringContaining('too old'), code: 'agent-too-old' });
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: ['tmux-create-command-v1'], agentCommit: null });
    agents({}, ['tmux-list']);
    const listFailed = await spawn();
    expect(listFailed.status).toHaveBeenCalledWith(502);
    expect(listFailed.json).toHaveBeenCalledWith({ error: expect.stringContaining('did not list'), code: 'agent-list-failed' });
    agents({}, ['tmux-create']);
    expect((await spawn()).json).toHaveBeenCalledWith({ error: expect.stringContaining('refused the launch'), code: 'agent-launch-failed' });
    expect(codes()).toEqual(['no-box', 'agent-too-old', 'agent-list-failed', 'agent-launch-failed']);
    expect(events().map(e => e[0])).toEqual(['queued', 'queued', 'agent-failed', 'agent-failed']);
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

  it('waits for a delivery still running to the chosen box before launching, and answers box-wait past the budget (Devin on #286)', async () => {
    vi.mocked(deliveryInFlight).mockReturnValue(new Promise<void>(() => {}));
    const late = await spawn({ budgetMs: 20 });
    expect(late.status).toHaveBeenCalledWith(503);
    expect(late.json).toHaveBeenCalledWith({ error: expect.stringContaining('still receiving its credentials'), code: 'box-wait' });
    expect(calls('tmux-create')).toEqual([]);
    expect(recordRunnerStart).not.toHaveBeenCalled();
    let landed!: () => void;
    vi.mocked(deliveryInFlight).mockReturnValue(new Promise<void>(r => { landed = r; }));
    const pending = spawn();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(calls('tmux-create')).toEqual([]);
    landed();
    expect((await pending).status).toHaveBeenCalledWith(202);
    expect(calls('tmux-create')[0][0]).toBe('box-a');
    vi.mocked(deliveryInFlight).mockReturnValue(null);
  });

  it('refuses a box whose agent cannot run a session command, without touching it', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: ['credentials-v1'], agentCommit: null });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('too old'), code: 'agent-too-old' });
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

describe('POST /internal/claude-runner/spawn, owner with no box', () => {
  const today = `claude-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const user = { id: 'u1', googleEmail: 'ada@example.com', unixUsername: 'ada', displayName: 'Ada' };
  // Every non-terminated EC2 box of the owner, as the auto-box path reads them.
  let owned: Record<string, unknown>[];
  let names: string[];
  const flags = (on: Record<string, boolean>) =>
    vi.mocked(boolVariation).mockImplementation(async (key: string) => on[key] ?? false);

  beforeEach(() => {
    owned = [];
    names = [];
    vi.mocked(findUserByEmail).mockResolvedValue(user as never);
    vi.mocked(prisma.instance.findMany).mockImplementation((async (args: { where: { status?: unknown }; select?: { name?: boolean; createdAt?: boolean } }) => {
      if (args.where.status === 'ready') return [];
      if (args.select?.createdAt) return owned;
      return names.map(name => ({ name }));
    }) as never);
    vi.mocked(isInstanceAgentConnected).mockReturnValue(true);
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: ['tmux-create-command-v1'] });
    vi.mocked(provisionNewBox).mockImplementation(async (_u, base) => {
      owned.push({ id: 'new', name: base, kind: 'ec2', status: 'provisioning', ec2InstanceId: null, lastConnectedAt: null, createdAt: new Date() });
      return base;
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('only queues while the flag is off', async () => {
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('start or add a box'), code: 'no-box' });
    expect(provisionNewBox).not.toHaveBeenCalled();
  });

  it('cold-provisions one box named for the day, and a burst of sessions waits on it', async () => {
    flags({ 'claude-runner-auto-box-enabled': true });
    const [a, b] = await Promise.all([spawn(), spawn()]);
    expect(provisionNewBox).toHaveBeenCalledTimes(1);
    expect(provisionNewBox).toHaveBeenCalledWith(user, today, expect.any(Function), { image: { kind: 'published' }, hibernation: false });
    for (const res of [a, b]) expect(res.status).toHaveBeenCalledWith(503);
    expect(a.json).toHaveBeenCalledWith({ error: expect.stringContaining(`provisioning termag box "${today}"`), code: 'box-provisioning' });
    expect(b.json).toHaveBeenCalledWith({ error: expect.stringContaining('provisioning; retried'), code: 'box-wait' });
    // Each wait is a `queued` event with what was done and its code.
    expect(events().map(e => e[0])).toEqual(['queued', 'queued']);
    expect(codes()).toEqual(['box-provisioning', 'box-wait']);
  });

  it('provisions even when the owner only has failed, external-only or id-less boxes (Bugbot on #191)', async () => {
    flags({ 'claude-runner-auto-box-enabled': true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    owned = [
      { id: 'f', name: 'default', kind: 'ec2', status: 'failed', ec2InstanceId: null, lastConnectedAt: null, createdAt: old },
      { id: 's', name: 'noid', kind: 'ec2', status: 'stopped', ec2InstanceId: null, lastConnectedAt: null, createdAt: old },
    ];
    await spawn();
    expect(provisionNewBox).toHaveBeenCalledTimes(1);
  });

  it('holds off after a box failed within the hour', async () => {
    flags({ 'claude-runner-auto-box-enabled': true });
    owned = [{ id: 'f', name: today, kind: 'ec2', status: 'failed', ec2InstanceId: null, lastConnectedAt: null, createdAt: new Date() }];
    const res = await spawn();
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('failed to provision less than an hour ago'), code: 'box-hold' });
    expect(provisionNewBox).not.toHaveBeenCalled();
  });

  it('starts a stopped box instead of making one', async () => {
    flags({ 'claude-runner-auto-box-enabled': true });
    const stopped = { id: 'old', name: 'old', kind: 'ec2', status: 'stopped', ec2InstanceId: 'i-1', lastConnectedAt: null, createdAt: new Date(0), userId: 'u1' };
    owned = [stopped];
    vi.mocked(prisma.instance.findUnique).mockResolvedValue(stopped as never);
    const res = await spawn();
    expect(requestPower).toHaveBeenCalledWith(stopped, 'start', { markInUse: true });
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('starting box "old"'), code: 'box-starting' });
    expect(provisionNewBox).not.toHaveBeenCalled();
  });

  it('resumes a hibernated box instead of making one', async () => {
    flags({ 'claude-runner-auto-box-enabled': true });
    const napping = { id: 'nap', name: 'nap', kind: 'ec2', status: 'hibernated', ec2InstanceId: 'i-2', lastConnectedAt: null, createdAt: new Date(0), userId: 'u1' };
    owned = [napping];
    vi.mocked(prisma.instance.findUnique).mockResolvedValue(napping as never);
    const res = await spawn();
    expect(requestPower).toHaveBeenCalledWith(napping, 'start', { markInUse: true });
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('resuming box "nap"'), code: 'box-starting' });
    expect(provisionNewBox).not.toHaveBeenCalled();
  });

  it('claims a warm box under a free name, and treats a name clash as a box on its way (Bugbot on #191)', async () => {
    // The claimed row carries no host home yet (an agent that never said hello
    // with one), so the runner cannot be placed in this request: 503, and the
    // box is theirs for the re-offer.
    flags({ 'claude-runner-auto-box-enabled': true, 'warm-pool-enabled': true });
    vi.mocked(poolSpecHashOrNull).mockResolvedValue('hash');
    names = [today];
    vi.mocked(claimWarmBox).mockResolvedValue({ claimed: true, instance: { id: 'w1', name: `${today}-2` }, candidatesTried: 1 } as never);
    const claimed = await spawn();
    expect(vi.mocked(claimWarmBox).mock.calls[0][0]).toMatchObject({ boxName: `${today}-2`, currentHash: 'hash' });
    // The claim asks again, inside its transaction, whether a box is still needed.
    expect(vi.mocked(claimWarmBox).mock.calls[0][0].stillNeeded?.([])).toBe(true);
    expect(claimed.json).toHaveBeenCalledWith({ error: expect.stringContaining(`claimed termag box "${today}-2"`), code: 'box-claimed' });

    vi.mocked(claimWarmBox).mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const clash = await spawn();
    expect(clash.status).toHaveBeenCalledWith(503);
    expect(clash.json).toHaveBeenCalledWith({ error: expect.stringContaining('being set up'), code: 'box-on-its-way' });
    expect(provisionNewBox).not.toHaveBeenCalled();
  });

  it('skips the pool for an owner whose box-image or box-hibernation-enabled flag differs from the pool, and launches with their values', async () => {
    flags({ 'claude-runner-auto-box-enabled': true, 'warm-pool-enabled': true });
    vi.mocked(poolSpecHashOrNull).mockResolvedValue('hash');
    vi.mocked(boxImageSelectionFor).mockResolvedValueOnce({ kind: 'ami', amiId: 'ami-123' } as never);
    await spawn();
    expect(claimWarmBox).not.toHaveBeenCalled();
    expect(provisionNewBox).toHaveBeenLastCalledWith(user, today, expect.any(Function), { image: { kind: 'ami', amiId: 'ami-123' }, hibernation: false });

    owned = [];
    vi.mocked(ownerHibernationEnabled).mockResolvedValueOnce(true);
    await spawn();
    expect(claimWarmBox).not.toHaveBeenCalled();
    expect(provisionNewBox).toHaveBeenLastCalledWith(user, today, expect.any(Function), { image: { kind: 'published' }, hibernation: true });
  });

  it('hands the create a re-check for inside its transaction, and stands down when it says a box is already on its way (Bugbot on #191)', async () => {
    flags({ 'claude-runner-auto-box-enabled': true });
    vi.mocked(provisionNewBox).mockResolvedValue(null);
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('being set up'), code: 'box-on-its-way' });
    const stillNeeded = vi.mocked(provisionNewBox).mock.calls[0][2];
    expect(stillNeeded([])).toBe(true);
    const onItsWay = { id: 'p', name: today, kind: 'ec2', status: 'provisioning', ec2InstanceId: null, lastConnectedAt: null, createdAt: new Date() };
    expect(stillNeeded([onItsWay])).toBe(false);
  });

  it('starts, claims or buys nothing once the hook has stopped waiting', async () => {
    flags({ 'claude-runner-auto-box-enabled': true });
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    vi.mocked(prisma.instance.findMany).mockImplementation((async (args: { where: { status?: unknown }; select?: { createdAt?: boolean } }) => {
      if (args.where.status === 'ready') return [];
      if (args.select?.createdAt) { await held; return owned; }
      return names.map(name => ({ name }));
    }) as never);
    const pending = spawn({ gone: true });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    release();
    const res = await pending;
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('stopped waiting'), code: 'hook-gave-up' });
    expect(provisionNewBox).not.toHaveBeenCalled();
    expect(requestPower).not.toHaveBeenCalled();
    expect(claimWarmBox).not.toHaveBeenCalled();
  });

  it('applies the Add box gate: no box for an owner it refuses, retried instead (#226)', async () => {
    flags({ 'claude-runner-auto-box-enabled': true });
    vi.mocked(boxCreationRefusal).mockReturnValueOnce({ status: 409, body: { error: 'Connect GitHub in Settings before adding a box', code: 'github-required' } } as never);
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('Connect GitHub'), code: 'box-creation-refused' });
    expect(provisionNewBox).not.toHaveBeenCalled();
    expect(claimWarmBox).not.toHaveBeenCalled();
  });

  it('does not buy a box for an owner whose connected box only needs a newer agent', async () => {
    flags({ 'claude-runner-auto-box-enabled': true });
    vi.mocked(prisma.instance.findMany).mockImplementation((async () => [box('box-a')]) as never);
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: [] });
    const res = await spawn();
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('too old'), code: 'agent-too-old' });
    expect(provisionNewBox).not.toHaveBeenCalled();
  });
  describe('a warm box claimed in this request', () => {
    const claimed = {
      id: 'w1', name: today, kind: 'ec2', status: 'ready', hostHome: '/home/termag', hostUnixUser: 'termag',
      lastConnectedAt: new Date('2026-10-09T10:00:00Z'), userId: 'u1',
    };
    beforeEach(() => {
      flags({ 'claude-runner-auto-box-enabled': true, 'warm-pool-enabled': true });
      vi.mocked(poolSpecHashOrNull).mockResolvedValue('hash');
      vi.mocked(claimWarmBox).mockResolvedValue({ claimed: true, instance: claimed, candidatesTried: 1 } as never);
      agents({});
    });

    it('places the runner on it in the same request once its credentials have landed', async () => {
      let landed!: () => void;
      const delivery = new Promise<void>(r => { landed = r; });
      vi.mocked(deliveryInFlight).mockReturnValue(delivery);
      const pending = spawn();
      // Nothing is sent to the box while the delivery runs.
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      expect(calls('tmux-create')).toEqual([]);
      landed();
      const res = await pending;
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'w1', boxName: today, slot: 2 }));
      expect(calls('tmux-list')[0][0]).toBe('w1');
      expect(calls('tmux-create')[0][0]).toBe('w1');
      expect(calls('tmux-create')[0][2]).toEqual(expect.objectContaining({ sessionName: 'termag-claude-runner-s2-ord_d1-r' }));
      expect(recordRunnerStart).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ord.1', instanceId: 'w1', slot: 2 }));
      expect(events()).toEqual([['placed', `${today} slot 2`, 'w1']]);
      expect(provisionNewBox).not.toHaveBeenCalled();
    });

    it('places at once when no delivery is running, and a failed delivery does not hold it back', async () => {
      vi.mocked(deliveryInFlight).mockReturnValue(Promise.reject(new Error('KMS down')));
      const res = await spawn();
      expect(res.status).toHaveBeenCalledWith(202);
      expect(calls('tmux-create')[0][0]).toBe('w1');
    });

    it('answers box-wait when the delivery outlasts the budget, and the next spawn places', async () => {
      vi.mocked(deliveryInFlight).mockReturnValue(new Promise<void>(() => {}));
      const res = await spawn({ budgetMs: 20 });
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining(`box "${today}" is still receiving its credentials`), code: 'box-wait' });
      expect(calls('tmux-create')).toEqual([]);
      // The box is theirs now: the re-offer finds it ready and connected.
      vi.mocked(deliveryInFlight).mockReturnValue(null);
      vi.mocked(prisma.instance.findMany).mockImplementation((async (args: { where: { status?: unknown } }) => (args.where.status === 'ready' ? [claimed] : [])) as never);
      const next = await spawn();
      expect(next.status).toHaveBeenCalledWith(202);
      expect(calls('tmux-create')[0][0]).toBe('w1');
      expect(claimWarmBox).toHaveBeenCalledTimes(1);
    });

    it("places a burst's second session on the box the first one claimed, instead of waiting on it (Devin on #286)", async () => {
      // No ready box until the claim commits; then the claimed box is ready and
      // its live sessions are whatever this test created on it.
      let ready: Record<string, unknown>[] = [];
      const live: string[] = [];
      vi.mocked(prisma.instance.findMany).mockImplementation((async (args: { where: { status?: unknown }; select?: { createdAt?: boolean } }) => {
        if (args.where.status === 'ready') return ready;
        if (args.select?.createdAt) return [];
        return [];
      }) as never);
      vi.mocked(claimWarmBox).mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 5));
        ready = [claimed];
        return { claimed: true, instance: claimed, candidatesTried: 1 } as never;
      });
      vi.mocked(sendToInstanceAgent).mockImplementation(async (_id: string, type: string, payload: unknown) => {
        if (type === 'tmux-list') return { sessions: [...live] };
        if (type === 'tmux-create') { live.push((payload as { sessionName: string }).sessionName); return { ok: true, created: true }; }
        return { ok: true };
      });
      const bodyB = { ...body, orderId: 'ord.2', sessionId: 'sess-2' };
      const [a, b] = await Promise.all([spawn(), spawn({ body: bodyB })]);
      expect(a.status).toHaveBeenCalledWith(202);
      expect(b.status).toHaveBeenCalledWith(202);
      expect(claimWarmBox).toHaveBeenCalledTimes(1);
      expect(calls('tmux-create').map(c => (c[2] as { sessionName: string }).sessionName).sort()).toEqual([
        'termag-claude-runner-s2-ord_d1-r', 'termag-claude-runner-s3-ord_d2-r',
      ]);
      expect(events().map(e => e[0]).sort()).toEqual(['placed', 'placed']);
    });

    it('answers box-claimed when the claimed box cannot run a runner yet', async () => {
      vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: ['credentials-v1'] });
      const res = await spawn();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('claimed termag box'), code: 'box-claimed' });
      expect(calls('tmux-create')).toEqual([]);
      expect(events().map(e => e[0])).toEqual(['queued']);
    });

    it('answers the launch failure itself when the placement on the claimed box fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      agents({}, ['tmux-create']);
      const res = await spawn();
      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('refused the launch'), code: 'agent-launch-failed' });
      expect(events().map(e => e[0])).toEqual(['agent-failed']);
    });
  });
});

describe('POST /internal/claude-runner/spawn, Anthropic-managed git', () => {
  const CAPABLE = ['credentials-v1', 'tmux-create-command-v1', 'claude-runner-wrapper-v2'];
  const OLD_WRAPPER = ['credentials-v1', 'tmux-create-command-v1'];
  const flags = (on: Record<string, boolean>) =>
    vi.mocked(boolVariation).mockImplementation(async (key: string) => on[key] ?? false);
  /** A broker host where the owner's stored GitHub credential is `present` or `absent`. */
  const broker = (credential: 'present' | 'absent') => {
    vi.mocked(getCredentialStoreConfig).mockReturnValue({ kmsKeyArn: 'arn:aws:kms:us-east-2:123456789012:key/k' } as never);
    vi.mocked(getGithubBrokerUrl).mockReturnValue('https://github-broker.example.test');
    vi.mocked(githubStoreDeps).mockReturnValue({ read: async () => (credential === 'present' ? { token: 'gho_x' } : null) } as never);
  };
  const launchArgv = () => (calls('tmux-create')[0][2] as { command: string[] }).command.slice(3);

  beforeEach(() => {
    vi.mocked(findUserByEmail).mockResolvedValue({ id: 'u1', googleEmail: 'ada@example.com', unixUsername: 'ada' } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(prisma.instance.findMany).mockResolvedValue([box('box-a')] as never);
    vi.mocked(isInstanceAgentConnected).mockReturnValue(true);
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: CAPABLE, agentCommit: null });
    agents({});
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCredentialStoreConfig).mockReturnValue(null);
    vi.mocked(getGithubBrokerUrl).mockReturnValue(null);
  });

  it('refuses an owner without GitHub as today while the flag is off', async () => {
    broker('absent');
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('has not connected GitHub'), code: 'github' });
    expect(sendToInstanceAgent).not.toHaveBeenCalled();
  });

  it('with the flag off, a capable box and a connected owner get the launch they got before: no git flags, the gate as it was', async () => {
    broker('present');
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(launchArgv()).toEqual([]);
    expect(vi.mocked(boolVariation).mock.calls.map(c => c[0])).toContain('claude-runner-anthropic-git-enabled');
  });

  it('places the session with Anthropic-managed git on a capable box, telling the wrapper the credential is absent', async () => {
    broker('absent');
    flags({ 'claude-runner-anthropic-git-enabled': true });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(launchArgv()).toEqual(['--anthropic-git', '--github', 'absent']);
    expect(events()).toEqual([['placed', 'box-a slot 2', 'box-a']]);
  });

  it('tells the wrapper the credential is connected, and still uses Anthropic-managed git', async () => {
    broker('present');
    flags({ 'claude-runner-anthropic-git-enabled': true });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(launchArgv()).toEqual(['--anthropic-git', '--github', 'connected']);
  });

  it('sends no --github on a host without the broker, where nothing is checked', async () => {
    flags({ 'claude-runner-anthropic-git-enabled': true });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(launchArgv()).toEqual(['--anthropic-git']);
  });

  it('sends no git flags to a box whose wrapper predates them, and refuses an owner without GitHub there as if the flag were off', async () => {
    flags({ 'claude-runner-anthropic-git-enabled': true });
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: OLD_WRAPPER, agentCommit: null });
    const connected = await spawn();
    expect(connected.status).toHaveBeenCalledWith(202);
    expect(launchArgv()).toEqual([]);
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    agents({});
    broker('absent');
    const absent = await spawn();
    expect(absent.status).toHaveBeenCalledWith(503);
    expect(absent.json).toHaveBeenCalledWith({ error: expect.stringContaining('has not connected GitHub'), code: 'github' });
    expect(calls('tmux-create')).toEqual([]);
  });

  it('answers already-running for an order live on an old-wrapper box, rather than starting a second runner on a capable one (Devin on #287)', async () => {
    broker('absent');
    flags({ 'claude-runner-anthropic-git-enabled': true });
    vi.mocked(prisma.instance.findMany).mockResolvedValue([
      box('box-old', { lastConnectedAt: new Date('2026-10-09T12:00:00Z') }), box('box-new'),
    ] as never);
    vi.mocked(instanceAgentTransport).mockImplementation(((id: string) => ({ conn: {} as never, capabilities: id === 'box-new' ? CAPABLE : OLD_WRAPPER, agentCommit: null })) as never);
    agents({ 'box-old': ['ada-claude-runner-s2-ord_d1-r'] });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'box-old', alreadyRunning: true }));
    expect(calls('tmux-create')).toEqual([]);
  });

  it('answers already-running for an order live on an old-wrapper box when every ready box is one, rather than the GitHub refusal (Bugbot on #287)', async () => {
    broker('absent');
    flags({ 'claude-runner-anthropic-git-enabled': true });
    vi.mocked(prisma.instance.findMany).mockResolvedValue([box('box-old'), box('box-older')] as never);
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: OLD_WRAPPER, agentCommit: null });
    agents({ 'box-older': ['ada-claude-runner-s1-ord_d1-r'] });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'box-older', alreadyRunning: true }));
    expect(calls('tmux-create')).toEqual([]);
  });

  it("answers the GitHub refusal, not boxes-full, when a burst's second session finds only old-wrapper boxes ready (Bugbot on #287)", async () => {
    broker('absent');
    flags({ 'claude-runner-anthropic-git-enabled': true, 'claude-runner-auto-box-enabled': true });
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: OLD_WRAPPER, agentCommit: null });
    // The first read sees no ready box (the burst's first session is mid-claim); the re-read under the lock sees an old-wrapper one.
    vi.mocked(prisma.instance.findMany)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValue([box('box-old')] as never);
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('has not connected GitHub'), code: 'github' });
    expect(calls('tmux-create')).toEqual([]);
  });

  it('picks a capable box over an old one for an owner without GitHub', async () => {
    broker('absent');
    flags({ 'claude-runner-anthropic-git-enabled': true });
    vi.mocked(prisma.instance.findMany).mockResolvedValue([
      box('box-old', { lastConnectedAt: new Date('2026-10-09T12:00:00Z') }), box('box-new'),
    ] as never);
    vi.mocked(instanceAgentTransport).mockImplementation(((id: string) => ({ conn: {} as never, capabilities: id === 'box-new' ? CAPABLE : OLD_WRAPPER, agentCommit: null })) as never);
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(calls('tmux-create')[0][0]).toBe('box-new');
  });

  describe('with no box', () => {
    const today = `claude-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    /** What the Add box gate knows on a broker host: a credential is required; the owner has a stored row or not. */
    const stored = (hasGithubCredential: boolean, flagOn = false) =>
      vi.mocked(readBoxCreationFacts).mockResolvedValue({ required: true, flagOn, hasGithubCredential });
    beforeEach(() => {
      vi.mocked(prisma.instance.findMany).mockImplementation((async (args: { where: { status?: unknown }; select?: { name?: boolean; createdAt?: boolean } }) => {
        if (args.where.status === 'ready') return [];
        if (args.select?.createdAt) return [];
        return [];
      }) as never);
      vi.mocked(poolSpecHashOrNull).mockResolvedValue('hash');
      vi.mocked(claimWarmBox).mockResolvedValue({ claimed: false, reason: 'no-warm-box', candidatesTried: 0 } as never);
    });
    afterEach(() => {
      vi.mocked(readBoxCreationFacts).mockResolvedValue({ required: false, flagOn: false, hasGithubCredential: false });
    });

    it('claims a warm box for an owner the Add box gate refuses, but never a cold one (B3)', async () => {
      broker('absent'); stored(false, true);
      flags({ 'claude-runner-anthropic-git-enabled': true, 'claude-runner-auto-box-enabled': true, 'warm-pool-enabled': true });
      vi.mocked(boxCreationRefusal).mockReturnValue({ status: 409, body: { error: 'Connect GitHub in Settings before adding a box', code: 'github-required' } } as never);
      const res = await spawn();
      expect(claimWarmBox).toHaveBeenCalledTimes(1);
      expect(vi.mocked(claimWarmBox).mock.calls[0][0]).toMatchObject({ boxName: today });
      expect(provisionNewBox).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('Connect GitHub'), code: 'box-creation-refused' });
      vi.mocked(boxCreationRefusal).mockReturnValue(null as never);
    });

    it('claims only a pool box whose agent announces claude-runner-wrapper-v2 for an owner the gate refuses, and the gate\'s refusal when the pool has none (B3; Bugbot on #285)', async () => {
      broker('absent'); stored(false, true);
      flags({ 'claude-runner-anthropic-git-enabled': true, 'claude-runner-auto-box-enabled': true, 'warm-pool-enabled': true });
      vi.mocked(boxCreationRefusal).mockReturnValue({ status: 409, body: { error: 'Connect GitHub in Settings before adding a box', code: 'github-required' } } as never);
      vi.mocked(instanceAgentTransport).mockImplementation(((id: string) =>
        ({ conn: {} as never, capabilities: id === 'pool-new' ? CAPABLE : OLD_WRAPPER, agentCommit: null })) as never);
      const res = await spawn();
      expect(claimWarmBox).toHaveBeenCalledTimes(1);
      const { eligible } = vi.mocked(claimWarmBox).mock.calls[0][0];
      expect(eligible?.('pool-new')).toBe(true);
      expect(eligible?.('pool-old')).toBe(false);
      vi.mocked(instanceAgentTransport).mockReturnValue(undefined as never);
      expect(eligible?.('pool-gone')).toBe(false);
      // The claim found nothing it may take: the gate's refusal, not a cold box.
      expect(provisionNewBox).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('Connect GitHub'), code: 'box-creation-refused' });
      expect(outcomeLines().some(l => l.includes('claude-runner-wrapper-v2 boxes only'))).toBe(true);
      vi.mocked(boxCreationRefusal).mockReturnValue(null as never);
    });

    it('claims any pool box for an owner with a stored GitHub credential', async () => {
      broker('present'); stored(true);
      flags({ 'claude-runner-anthropic-git-enabled': true, 'claude-runner-auto-box-enabled': true, 'warm-pool-enabled': true });
      await spawn();
      expect(claimWarmBox).toHaveBeenCalledTimes(1);
      expect(vi.mocked(claimWarmBox).mock.calls[0][0].eligible).toBeUndefined();
    });

    it('never cold-provisions for an owner without a stored credential even when the Add box gate is not enforcing', async () => {
      broker('absent'); stored(false);
      flags({ 'claude-runner-anthropic-git-enabled': true, 'claude-runner-auto-box-enabled': true, 'warm-pool-enabled': true });
      const res = await spawn();
      expect(claimWarmBox).toHaveBeenCalledTimes(1);
      expect(provisionNewBox).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('Connect GitHub'), code: 'box-creation-refused' });
    });

    it('decides the cold box by the stored row, not the spawn\'s credential read: a failed read with a row stored still provisions, none stored never does (Devin on #287)', async () => {
      // The read failed (unknown): the gate lets the session through, and the
      // stored row says the owner has GitHub.
      vi.mocked(getCredentialStoreConfig).mockReturnValue({ kmsKeyArn: 'arn:aws:kms:us-east-2:123456789012:key/k' } as never);
      vi.mocked(getGithubBrokerUrl).mockReturnValue('https://github-broker.example.test');
      vi.mocked(githubStoreDeps).mockReturnValue({ read: async () => { throw new Error('KMS down'); } } as never);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      stored(true);
      flags({ 'claude-runner-auto-box-enabled': true });
      const withRow = await spawn();
      expect(provisionNewBox).toHaveBeenCalledTimes(1);
      expect(withRow.json).toHaveBeenCalledWith({ error: expect.stringContaining('provisioning termag box'), code: 'box-provisioning' });
      vi.clearAllMocks();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      stored(false);
      flags({ 'claude-runner-auto-box-enabled': true });
      const noRow = await spawn();
      expect(provisionNewBox).not.toHaveBeenCalled();
      expect(noRow.json).toHaveBeenCalledWith({ error: expect.stringContaining('Connect GitHub'), code: 'box-creation-refused' });
    });

    it('still cold-provisions for an owner with GitHub connected, flag on', async () => {
      broker('present'); stored(true);
      flags({ 'claude-runner-anthropic-git-enabled': true, 'claude-runner-auto-box-enabled': true });
      const res = await spawn();
      expect(provisionNewBox).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('provisioning termag box'), code: 'box-provisioning' });
    });

    it('still applies the Add box gate to the warm claim while the flag is off', async () => {
      broker('present'); stored(true, true);
      flags({ 'claude-runner-auto-box-enabled': true, 'warm-pool-enabled': true });
      vi.mocked(boxCreationRefusal).mockReturnValueOnce({ status: 409, body: { error: 'Connect GitHub in Settings before adding a box', code: 'github-required' } } as never);
      const res = await spawn();
      expect(claimWarmBox).not.toHaveBeenCalled();
      expect(provisionNewBox).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('Connect GitHub'), code: 'box-creation-refused' });
    });
  });
});

describe('POST /internal/claude-runner/spawn, owner unknown to termag', () => {
  const ada = { id: 'u-new', googleEmail: 'ada@example.com', unixUsername: 'ada', displayName: 'Ada' };
  const withId = { ...body, accountId: 'user_01HXYZ' };
  const flags = (on: Record<string, boolean>) =>
    vi.mocked(boolVariation).mockImplementation(async (key: string) => on[key] ?? false);
  /** Which flag contexts the flags were read on, by flag. */
  const contexts = () => vi.mocked(boolVariation).mock.calls.map(c => [c[0], (c[1] as { id: string; googleEmail: string }).id]);

  beforeEach(() => {
    vi.stubEnv('ALLOWED_USERS', '@example.com');
    vi.mocked(findUserByEmail).mockResolvedValue(null);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(prisma.instance.findMany).mockResolvedValue([box('box-a')] as never);
    vi.mocked(isInstanceAgentConnected).mockReturnValue(true);
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: ['credentials-v1', 'tmux-create-command-v1'], agentCommit: null });
    agents({});
    vi.mocked(createOwnerFromAllowlist).mockResolvedValue({ kind: 'created', user: ada } as never);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('is the 404 it always was while the flags are off, and nothing is created', async () => {
    const res = await spawn({ body: withId });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(createOwnerFromAllowlist).not.toHaveBeenCalled();
    expect(outcomeLines()).toEqual(['[CLAUDE-RUNNER] order ord.1: 404 the session owner is not a termag user']);
  });

  it('creates the user, logs it, records it, and places the session (U1, U5)', async () => {
    flags({ 'claude-runner-auto-box-enabled': true, 'claude-runner-auto-user-enabled': true });
    vi.mocked(slackRealName).mockResolvedValue('Ada Lovelace');
    const res = await spawn({ body: withId });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(createOwnerFromAllowlist).toHaveBeenCalledWith({ email: 'ada@example.com', accountId: 'user_01HXYZ', realName: 'Ada Lovelace' }, expect.anything());
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0]))).toContain('[CLAUDE-RUNNER] order ord.1: created termag user ada for the session owner');
    expect(events().map(e => e[0])).toEqual(['user-created', 'placed']);
    expect(vi.mocked(recordSessionEvent).mock.calls[0][0]).toMatchObject({ owner: { id: 'u-new', unixUsername: 'ada' } });
    expect(outcomeLines().join('\n')).not.toContain('ada@example.com');
  });

  it('reads both flags on a context keyed by the account id, never the email (U7, U8), and needs auto-box on', async () => {
    flags({ 'claude-runner-auto-box-enabled': true, 'claude-runner-auto-user-enabled': true });
    await spawn({ body: withId });
    expect(contexts()).toEqual(expect.arrayContaining([['claude-runner-auto-box-enabled', 'claude:user_01HXYZ'], ['claude-runner-auto-user-enabled', 'claude:user_01HXYZ']]));
    // The context carries the unix username the allowlist derives, as the row will (Bugbot on #288).
    expect(vi.mocked(boolVariation).mock.calls[0][1]).toMatchObject({ unixUsername: 'ada' });
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    flags({ 'claude-runner-auto-user-enabled': true });
    const res = await spawn({ body: withId });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(createOwnerFromAllowlist).not.toHaveBeenCalled();
    expect(contexts().map(c => c[0])).not.toContain('claude-runner-auto-user-enabled');
  });

  it('keeps reading the flags on the placeholder key once the row exists, so a rule targeting it decides the box too (Devin on #288)', async () => {
    flags({ 'claude-runner-auto-box-enabled': true, 'claude-runner-auto-user-enabled': true });
    const placeholder = { ...ada, googleId: 'claude:user_01HXYZ' };
    vi.mocked(createOwnerFromAllowlist).mockResolvedValue({ kind: 'created', user: placeholder } as never);
    vi.mocked(prisma.instance.findMany).mockImplementation((async (args: { where: { status?: unknown } }) => (args.where.status === 'ready' ? [] : [])) as never);
    await spawn({ body: withId });
    // The auto-box read after creation is on the same key as before it.
    const autoBoxKeys = contexts().filter(c => c[0] === 'claude-runner-auto-box-enabled').map(c => c[1]);
    expect(autoBoxKeys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(autoBoxKeys)).toEqual(new Set(['claude:user_01HXYZ']));
    expect(provisionNewBox).toHaveBeenCalledTimes(1);
  });

  it('creates nobody for a body without the account id (an older hook), and is the 404 as today', async () => {
    flags({ 'claude-runner-auto-box-enabled': true, 'claude-runner-auto-user-enabled': true });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(createOwnerFromAllowlist).not.toHaveBeenCalled();
    expect(boolVariation).not.toHaveBeenCalled();
  });

  it('answers 404 and names the derived username, never the email, on a collision (U4)', async () => {
    flags({ 'claude-runner-auto-box-enabled': true, 'claude-runner-auto-user-enabled': true });
    vi.mocked(createOwnerFromAllowlist).mockResolvedValue({ kind: 'collision', unixUsername: 'ada' } as never);
    const res = await spawn({ body: withId });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: OWNER_NOT_FOUND }));
    const lines = vi.mocked(console.log).mock.calls.map(c => String(c[0]));
    expect(lines).toContain('[CLAUDE-RUNNER] order ord.1: 404 the session owner is not a termag user and could not be created: unix username ada belongs to another user');
    expect(lines.join('\n')).not.toContain('ada@example.com');
  });

  it('answers 404 and places nothing when the account id is bound to another email (Security Agent on #288)', async () => {
    flags({ 'claude-runner-auto-box-enabled': true, 'claude-runner-auto-user-enabled': true });
    vi.mocked(createOwnerFromAllowlist).mockResolvedValue({ kind: 'account-bound', unixUsername: 'ada.old' } as never);
    const res = await spawn({ body: withId });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(calls('tmux-create')).toEqual([]);
    const lines = vi.mocked(console.log).mock.calls.map(c => String(c[0]));
    expect(lines.join('\n')).toContain('already belongs to termag user ada.old under another email');
    expect(lines.join('\n')).not.toContain('ada@example.com');
  });

  it('answers 404 for an email the allowlist does not admit, flags on (U2)', async () => {
    flags({ 'claude-runner-auto-box-enabled': true, 'claude-runner-auto-user-enabled': true });
    vi.mocked(createOwnerFromAllowlist).mockResolvedValue({ kind: 'not-allowed' } as never);
    const res = await spawn({ body: withId });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(events()).toEqual([]);
  });

  it('creates one row for a burst of two sessions and places both (U4)', async () => {
    flags({ 'claude-runner-auto-box-enabled': true, 'claude-runner-auto-user-enabled': true });
    // The second spawn, serialized behind the first, finds the row by email.
    vi.mocked(createOwnerFromAllowlist).mockImplementation(async () => {
      vi.mocked(findUserByEmail).mockResolvedValue(ada as never);
      return { kind: 'created', user: ada } as never;
    });
    const live: string[] = [];
    vi.mocked(sendToInstanceAgent).mockImplementation(async (_id: string, type: string, payload: unknown) => {
      if (type === 'tmux-list') return { sessions: [...live] };
      if (type === 'tmux-create') { live.push((payload as { sessionName: string }).sessionName); return { ok: true, created: true }; }
      return { ok: true };
    });
    const [a, b] = await Promise.all([spawn({ body: withId }), spawn({ body: { ...withId, orderId: 'ord.2', sessionId: 'sess-2' } })]);
    expect(a.status).toHaveBeenCalledWith(202);
    expect(b.status).toHaveBeenCalledWith(202);
    expect(createOwnerFromAllowlist).toHaveBeenCalledTimes(1);
    expect(events().filter(e => e[0] === 'user-created')).toHaveLength(1);
    expect(events().filter(e => e[0] === 'placed')).toHaveLength(2);
  });
});

describe('POST /internal/claude-runner/spawn, owner notices', () => {
  const CAPABLE = ['credentials-v1', 'tmux-create-command-v1', 'claude-runner-wrapper-v2'];
  const flags = (on: Record<string, boolean>) =>
    vi.mocked(boolVariation).mockImplementation(async (key: string) => on[key] ?? false);
  const broker = (credential: 'present' | 'absent') => {
    vi.mocked(getCredentialStoreConfig).mockReturnValue({ kmsKeyArn: 'arn:aws:kms:us-east-2:123456789012:key/k' } as never);
    vi.mocked(getGithubBrokerUrl).mockReturnValue('https://github-broker.example.test');
    vi.mocked(githubStoreDeps).mockReturnValue({ read: async () => (credential === 'present' ? { token: 'gho_x' } : null) } as never);
  };
  beforeEach(() => {
    flags({});
    vi.mocked(findUserByEmail).mockResolvedValue({ id: 'u1', googleEmail: 'ada@example.com', unixUsername: 'ada' } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(prisma.instance.findMany).mockResolvedValue([box('box-a')] as never);
    vi.mocked(isInstanceAgentConnected).mockReturnValue(true);
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: CAPABLE, agentCommit: null });
    agents({});
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCredentialStoreConfig).mockReturnValue(null);
    vi.mocked(getGithubBrokerUrl).mockReturnValue(null);
  });

  it('offers a notice for every refusal, with its code and the box the text names, after the answer', async () => {
    vi.mocked(prisma.instance.findMany).mockResolvedValue([] as never);
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(503);
    // The persisted user (the notice's foreign key), never the flag identity.
    expect(notifyRefusal).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1', googleEmail: 'ada@example.com' }), 'sess-1', 'no-box', expect.stringContaining('start or add a box'), null);
    expect(vi.mocked(notifyRefusal).mock.invocationCallOrder[0]).toBeGreaterThan(res.json.mock.invocationCallOrder[0]);
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    agents({ 'box-a': ['ada-claude-runner-s2-x-r', 'ada-claude-runner-s3-y-r', 'ada-claude-runner-s4-z-r'] });
    vi.mocked(prisma.instance.findMany).mockResolvedValue([box('box-a')] as never);
    await spawn();
    expect(notifyRefusal).toHaveBeenCalledWith(expect.anything(), 'sess-1', 'boxes-full', expect.any(String), null);
  });

  it('names the box a refusal is about', async () => {
    flags({ 'claude-runner-auto-box-enabled': true });
    const stopped = { id: 'old', name: 'old-box', kind: 'ec2', status: 'stopped', ec2InstanceId: 'i-1', lastConnectedAt: null, createdAt: new Date(0), userId: 'u1' };
    vi.mocked(prisma.instance.findMany).mockImplementation((async (args: { where: { status?: unknown }; select?: { createdAt?: boolean } }) => {
      if (args.where.status === 'ready') return [];
      if (args.select?.createdAt) return [stopped];
      return [];
    }) as never);
    vi.mocked(prisma.instance.findUnique).mockResolvedValue(stopped as never);
    await spawn();
    expect(notifyRefusal).toHaveBeenCalledWith(expect.anything(), 'sess-1', 'box-starting', expect.stringContaining('old-box'), 'old-box');
  });

  it('offers the GitHub reminder only for a session placed with Anthropic-managed git and no termag credential', async () => {
    broker('absent');
    flags({ 'claude-runner-anthropic-git-enabled': true });
    const res = await spawn();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(notifyGithubAbsent).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'sess-1', 'box-a');
    expect(vi.mocked(notifyGithubAbsent).mock.invocationCallOrder[0]).toBeGreaterThan(res.json.mock.invocationCallOrder[0]);
    expect(notifyRefusal).not.toHaveBeenCalled();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    agents({});
    broker('present');
    await spawn();
    expect(notifyGithubAbsent).not.toHaveBeenCalled();
  });
});
