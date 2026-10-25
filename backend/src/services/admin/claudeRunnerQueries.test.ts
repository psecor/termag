import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../db';
import { getAllStatuses } from '../status';
import { statusKey } from '../statusKey';
import { adminCloudSessions, buildCloudReport, capacityFromBoxes, cloudSummary, describeOwnerBoxes, liveStatusFor, observabilityUrlFromEnv, orchestratorHealth, orchestratorHealthPort, percentiles, refusalCategory, resetOrchestratorHealthCache, type BoxCapacity, type ReportEventRow, type ReportRunRow } from './claudeRunnerQueries';
import { REFUSAL_TEXTS } from '../claudeRunnerSpawn';
import { parseRange, type Range } from './range';

vi.mock('../../db', () => ({ prisma: { claudeRunnerSession: { findMany: vi.fn() }, claudeSessionEvent: { findMany: vi.fn() } } }));
vi.mock('../agentRegistry', () => ({ isInstanceAgentConnected: vi.fn(() => false), sendToInstanceAgent: vi.fn(), instanceAgentTransport: vi.fn(() => null) }));
vi.mock('../claudeSessionEvents', () => ({ recordSessionEvent: vi.fn(async () => {}) }));
vi.mock('../status', () => ({ getAllStatuses: vi.fn(() => new Map()) }));

describe('orchestratorHealth', () => {
  beforeEach(() => resetOrchestratorHealthCache());

  it('reads the port from the environment and refuses nonsense', () => {
    expect(orchestratorHealthPort({ CLAUDE_RUNNER_ORCHESTRATOR_HEALTH_PORT: '18081' })).toBe(18081);
    expect(orchestratorHealthPort({})).toBeNull();
    expect(orchestratorHealthPort({ CLAUDE_RUNNER_ORCHESTRATOR_HEALTH_PORT: 'eighty' })).toBeNull();
    expect(orchestratorHealthPort({ CLAUDE_RUNNER_ORCHESTRATOR_HEALTH_PORT: '70000' })).toBeNull();
  });

  it('says plainly when no port is configured (a host without the orchestrator)', async () => {
    const h = await orchestratorHealth({ env: {} });
    expect(h).toMatchObject({ available: false, port: null, body: null, cached: false });
    expect(h.reason).toContain('CLAUDE_RUNNER_ORCHESTRATOR_HEALTH_PORT');
  });

  it('fetches the loopback body with a timeout, then serves it from a ten-second cache', async () => {
    const fetcher = vi.fn().mockResolvedValue({ connected: true, queue_counts: { pending: 1 } });
    const env = { CLAUDE_RUNNER_ORCHESTRATOR_HEALTH_PORT: '18081' };
    const a = await orchestratorHealth({ env, fetcher, now: 1_000_000 });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:18081/healthz', 2000);
    expect(a).toMatchObject({ available: true, port: 18081, body: { connected: true }, cached: false });
    const b = await orchestratorHealth({ env, fetcher, now: 1_005_000 });
    expect(b).toMatchObject({ available: true, cached: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await orchestratorHealth({ env, fetcher, now: 1_011_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('carries the Observability link from the environment, https only', async () => {
    expect(observabilityUrlFromEnv({ OBSERVABILITY_UI_URL: ' https://app.example.test/o11y ' })).toBe('https://app.example.test/o11y');
    expect(observabilityUrlFromEnv({ OBSERVABILITY_UI_URL: 'http://plain.example.test' })).toBeNull();
    expect(observabilityUrlFromEnv({})).toBeNull();
    const h = await orchestratorHealth({ env: { OBSERVABILITY_UI_URL: 'https://app.example.test/o11y' } });
    expect(h.observabilityUrl).toBe('https://app.example.test/o11y');
  });

  it('reports a unit that does not answer, and caches that too', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const h = await orchestratorHealth({ env: { CLAUDE_RUNNER_ORCHESTRATOR_HEALTH_PORT: '18081' }, fetcher, now: 5_000_000 });
    expect(h).toMatchObject({ available: false, port: 18081, body: null });
    expect(h.reason).toContain('ECONNREFUSED');
  });
});

describe('adminCloudSessions', () => {
  const t = (s: string) => new Date(s);
  const run = (over: Record<string, unknown> = {}) => ({
    orderId: 'ord.1', sessionId: 'cse_01A', instanceId: 'box-a', slot: 2, startedAt: t('2026-10-08T10:00:00Z'), endedAt: null,
    exitStatus: null, exitReason: null, clientPlatform: 'web_claude_ai', title: 'SECRET PROMPT',
    user: { unixUsername: 'ada' }, instance: { name: 'ada-box', hostUnixUser: 'ada', status: 'ready' }, ...over,
  });

  it('groups every owner\'s runs by box, queued and recent apart, with owners named and titles left out', async () => {
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([
      run(),
      run({ orderId: 'ord.2', sessionId: 'cse_01B', slot: 3, user: { unixUsername: 'bob' }, instanceId: 'box-b', instance: { name: 'bob-box', hostUnixUser: 'bob', status: 'ready' } }),
      run({ orderId: 'ord.3', sessionId: 'cse_01C', endedAt: t('2026-10-08T11:00:00Z'), exitStatus: 0, exitReason: 'completed' }),
    ] as never);
    vi.mocked(prisma.claudeSessionEvent.findMany).mockResolvedValue([
      { sessionId: 'cse_01A', orderId: 'ord.1', instanceId: 'box-a', kind: 'started', detail: 'web_claude_ai', at: t('2026-10-08T10:00:10Z'), user: { unixUsername: 'ada' } },
      { sessionId: 'cse_01Q', orderId: 'ord.q', instanceId: null, kind: 'queued', detail: 'no box', code: 'no-box', at: t('2026-10-08T12:00:00Z'), user: { unixUsername: 'cat' } },
    ] as never);
    const out = await adminCloudSessions(7, t('2026-10-08T12:30:00Z'));
    expect(out.boxes.map(b => [b.boxName, b.owner, b.sessions.map(s => [s.key, s.state])])).toEqual([
      ['ada-box', 'ada', [['cse_01A', 'running']]],
      ['bob-box', 'bob', [['cse_01B', 'starting']]],
    ]);
    expect(out.queued).toEqual([expect.objectContaining({ key: 'cse_01Q', owner: 'cat', queuedReason: 'no box', queuedCode: 'no-box' })]);
    expect(out.recent).toEqual([expect.objectContaining({ key: 'cse_01C', owner: 'ada', state: 'ended', exitReason: 'completed' })]);
    expect(out.counts).toEqual({ running: 1, starting: 1, queued: 1, ended: 1, lost: 0 });
    // Open runs' events are read whatever their age, so an old running session is not shown as starting.
    expect(prisma.claudeSessionEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ at: { gte: expect.any(Date) } }, { orderId: { in: ['ord.1', 'ord.2'] } }] },
    }));
    expect(out.queued[0].queuedSince).toBe('2026-10-08T12:00:00.000Z');
    expect(JSON.stringify(out)).not.toContain('SECRET PROMPT');
    expect(JSON.stringify(out)).not.toContain('"title"');
    // Not even fetched: the select names no title column.
    expect(vi.mocked(prisma.claudeRunnerSession.findMany).mock.calls[0][0]).toMatchObject({ select: expect.not.objectContaining({ title: true }) });
    // Each box group says whether its agent answered when the view was built.
    expect(out.boxes.map(b => b.connected)).toEqual([false, false]);
  });

  it('joins the live status under the runner tmux name for running sessions only', async () => {
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([
      run(),
      run({ orderId: 'ord.2', sessionId: 'cse_01B', slot: 3 }),
    ] as never);
    vi.mocked(prisma.claudeSessionEvent.findMany).mockResolvedValue([
      { sessionId: 'cse_01A', orderId: 'ord.1', instanceId: 'box-a', kind: 'started', detail: null, at: t('2026-10-08T10:00:10Z'), user: { unixUsername: 'ada' } },
    ] as never);
    const map = new Map();
    map.set(statusKey('box-a', 'ada-claude-runner-s2-ord_d1-r'), { status: 'waiting', updatedAt: t('2026-10-08T12:00:00Z'), waitingReason: 'approval', contextTokens: 120_000, rateLimited: null });
    map.set(statusKey('box-a', 'ada-claude-runner-s3-ord_d2-r'), { status: 'working', updatedAt: t('2026-10-08T12:00:00Z') });
    vi.mocked(getAllStatuses).mockReturnValue(map);
    const out = await adminCloudSessions(7, t('2026-10-08T12:30:00Z'));
    const byKey = Object.fromEntries(out.boxes[0].sessions.map(s => [s.key, s]));
    expect(byKey.cse_01A.live).toEqual({ status: 'waiting', waitingReason: 'approval', rateLimited: null, contextTokens: 120_000, updatedAt: '2026-10-08T12:00:00.000Z' });
    // Starting: the box has not spawned the child, so whatever is in the map is not this session's.
    expect(byKey.cse_01B.state).toBe('starting');
    expect(byKey.cse_01B.live).toBeNull();
  });
});

describe('liveStatusFor', () => {
  const run = { orderId: 'o', instanceId: 'box-a', boxName: 'b', slot: 2, sessionName: 'ada-claude-runner-s2-o-r', startedAt: 'x', endedAt: null, durationSec: null, exitStatus: null, exitReason: null, alive: true };
  it('is null without a run, for an ended run, for a run with no tmux name, and when nothing was posted', () => {
    const map = new Map([[statusKey('box-a', run.sessionName), { status: 'working' as const, updatedAt: new Date(0) }]]);
    expect(liveStatusFor({ state: 'queued', current: null }, map)).toBeNull();
    expect(liveStatusFor({ state: 'ended', current: { ...run, endedAt: 'y' } }, map)).toBeNull();
    expect(liveStatusFor({ state: 'running', current: { ...run, sessionName: null } }, map)).toBeNull();
    expect(liveStatusFor({ state: 'running', current: run }, new Map())).toBeNull();
    // The probe found the tmux session gone: the runner died and the lost sweep has not run yet.
    expect(liveStatusFor({ state: 'running', current: { ...run, alive: false } }, map)).toBeNull();
    expect(liveStatusFor({ state: 'running', current: { ...run, alive: null } }, map)?.status).toBe('working');
    // Starting: a map entry under that name is from an earlier launch, not this child.
    expect(liveStatusFor({ state: 'starting', current: run }, map)).toBeNull();
    expect(liveStatusFor({ state: 'running', current: run }, map)?.status).toBe('working');
  });
});

describe('cloudSummary', () => {
  const t = (s: string) => new Date(s);
  it('counts open runs per box and owner, running once started, and queued sessions with no open run', async () => {
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([
      { orderId: 'o1', sessionId: 'cse_A', instanceId: 'box-a', userId: 'u1', startedAt: t('2026-10-09T09:00:00Z') },
      { orderId: 'o2', sessionId: 'cse_B', instanceId: 'box-a', userId: 'u1', startedAt: t('2026-10-09T09:05:00Z') },
      { orderId: 'o3', sessionId: 'cse_C', instanceId: 'box-b', userId: 'u2', startedAt: t('2026-10-09T09:00:00Z') },
      // o4 was relaunched at 09:50: its `started` from the first launch (09:01) is not this launch's.
      { orderId: 'o4', sessionId: 'cse_D', instanceId: 'box-b', userId: 'u2', startedAt: t('2026-10-09T09:50:00Z') },
      // o5 lingers open while a re-offer of its session (another order) was refused after it started.
      { orderId: 'o5', sessionId: 'cse_R', instanceId: 'box-b', userId: 'u2', startedAt: t('2026-10-09T08:00:00Z') },
    ] as never);
    vi.mocked(prisma.claudeSessionEvent.findMany)
      .mockResolvedValueOnce([
        { orderId: 'o1', at: t('2026-10-09T09:00:10Z') }, { orderId: 'o3', at: t('2026-10-09T09:00:10Z') },
        { orderId: 'o4', at: t('2026-10-09T09:01:00Z') }, { orderId: 'o5', at: t('2026-10-09T08:00:10Z') },
      ] as never)
      .mockResolvedValueOnce([
        // cse_B is queued-then-placed: its open run wins, it is not queued.
        { sessionId: 'cse_B', orderId: 'o2', kind: 'queued', at: t('2026-10-09T09:00:00Z') },
        { sessionId: 'cse_B', orderId: 'o2', kind: 'placed', at: t('2026-10-09T09:05:00Z') },
        // cse_Q: refused twice, nothing open: queued.
        { sessionId: 'cse_Q', orderId: 'oq', kind: 'queued', at: t('2026-10-09T09:00:00Z') },
        { sessionId: 'cse_Q', orderId: 'oq2', kind: 'agent-failed', at: t('2026-10-09T09:10:00Z') },
        // cse_E: ended an hour ago, newest event is `ended`: not queued.
        { sessionId: 'cse_E', orderId: 'oe', kind: 'queued', at: t('2026-10-09T07:00:00Z') },
        { sessionId: 'cse_E', orderId: 'oe', kind: 'ended', at: t('2026-10-09T08:00:00Z') },
        // cse_R: a re-offer under a new order refused after the old run started: queued, as deriveState says.
        { sessionId: 'cse_R', orderId: 'o6', kind: 'queued', at: t('2026-10-09T09:30:00Z') },
      ] as never);
    const out = await cloudSummary(t('2026-10-09T10:00:00Z'));
    expect(out).toMatchObject({
      running: 3, starting: 2, queued: 2,
      byBox: { 'box-a': { running: 1, starting: 1 }, 'box-b': { running: 2, starting: 1 } },
      byUser: { u1: { running: 1, starting: 1 }, u2: { running: 2, starting: 1 } },
    });
    // The queued window is the last day (the second of this call's two event reads).
    const calls = vi.mocked(prisma.claudeSessionEvent.findMany).mock.calls;
    expect(calls[calls.length - 1][0]).toMatchObject({ where: { at: { gte: t('2026-10-08T10:00:00Z') } } });
  });
});

describe('capacity', () => {
  const b = (over: Partial<BoxCapacity>): BoxCapacity => ({
    instanceId: 'i1', boxName: 'b1', userId: 'u1', owner: 'alice', status: 'ready', connected: true, capable: true, eligible: true, slotsUsed: 0, slotsMax: 3, ...over,
  });
  it('describes an owner\'s boxes in one phrase, the way a queued row needs it', () => {
    expect(describeOwnerBoxes([])).toBe('no boxes');
    expect(describeOwnerBoxes([b({ slotsUsed: 3 }), b({ instanceId: 'i2', status: 'stopped', eligible: false })])).toBe('1 ready · full, 1 stopped');
    expect(describeOwnerBoxes([b({ connected: false, eligible: false })])).toBe('1 ready · agent offline');
    expect(describeOwnerBoxes([b({ capable: false, eligible: false })])).toBe('1 ready · agent too old');
    expect(describeOwnerBoxes([b({ slotsUsed: 1 }), b({ instanceId: 'i2', slotsUsed: 1 })])).toBe('2 ready · 2 free');
  });
  it('rolls slots up per owner and org-wide over eligible boxes only, and names who is at the cap', () => {
    const cap = capacityFromBoxes([
      b({ slotsUsed: 3 }),
      b({ instanceId: 'i2', status: 'stopped', eligible: false, slotsUsed: 0 }),
      b({ instanceId: 'i3', userId: 'u2', owner: 'bob', slotsUsed: 1 }),
      b({ instanceId: 'i4', userId: null, owner: null, eligible: false }), // warm pool
    ], 3, new Date('2026-10-09T10:00:00Z'));
    expect(cap.owners.u1).toMatchObject({ owner: 'alice', eligibleBoxes: 1, slotsUsed: 3, slotsFree: 0, atCap: true });
    expect(cap.owners.u2).toMatchObject({ eligibleBoxes: 1, slotsUsed: 1, slotsFree: 2, atCap: false });
    expect(cap.totals).toEqual({ eligibleBoxes: 2, slotsUsed: 4, slotsFree: 2 });
    expect(Object.keys(cap.owners)).toEqual(['u1', 'u2']);
  });
});

describe('refusalCategory', () => {
  it('maps the spawn route\'s texts, by kind for agent failures and by prefix for the one with counts', () => {
    expect(refusalCategory('queued', REFUSAL_TEXTS.github)).toBe('github');
    expect(refusalCategory('queued', REFUSAL_TEXTS.agentTooOld)).toBe('agent-too-old');
    expect(refusalCategory('queued', REFUSAL_TEXTS.noBox)).toBe('no-box');
    expect(refusalCategory('queued', REFUSAL_TEXTS.boxesFull(2, 3))).toBe('boxes-full');
    expect(refusalCategory('queued', REFUSAL_TEXTS.hookGaveUp)).toBe('hook-gave-up');
    expect(refusalCategory('agent-failed', 'the box agent refused the launch: timeout')).toBe('agent-failed');
    expect(refusalCategory('queued', 'something new')).toBe('other');
    expect(refusalCategory('queued', null)).toBe('other');
  });

  it('reads the code first when the event has one, and sorts the auto-box codes into pending and blocked', () => {
    expect(refusalCategory('queued', 'anything', 'github')).toBe('github');
    expect(refusalCategory('queued', 'the spawn hook stopped waiting; no box started for it', 'hook-gave-up')).toBe('hook-gave-up');
    for (const code of ['box-wait', 'box-starting', 'box-claimed', 'box-provisioning', 'box-on-its-way']) expect(refusalCategory('queued', 'x', code)).toBe('box-pending');
    for (const code of ['box-hold', 'box-start-failed', 'no-provisioning', 'box-creation-refused']) expect(refusalCategory('queued', 'x', code)).toBe('box-blocked');
    expect(refusalCategory('agent-failed', 'x', 'agent-launch-failed')).toBe('agent-failed');
    // An unknown code falls back to the text.
    expect(refusalCategory('queued', REFUSAL_TEXTS.noBox, 'from-the-future')).toBe('no-box');
  });
});

describe('percentiles', () => {
  it('is empty for no samples and picks the nearest-rank values otherwise', () => {
    expect(percentiles([])).toEqual({ p50: null, p95: null, samples: 0 });
    expect(percentiles([5])).toEqual({ p50: 5, p95: 5, samples: 1 });
    expect(percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ p50: 6, p95: 10, samples: 10 });
  });
});

describe('buildCloudReport', () => {
  const t = (s: string) => new Date(s);
  const range = parseRange({ from: '2026-10-01', to: '2026-10-07' }, t('2026-10-07T12:00:00Z')) as Range;
  const now = t('2026-10-07T12:00:00Z');
  const run = (over: Partial<ReportRunRow>): ReportRunRow => ({
    orderId: 'o1', sessionId: 'cse_A', userId: 'u1', owner: 'ada', instanceId: 'box-a', boxName: 'ada-box', clientPlatform: 'web_claude_ai',
    startedAt: t('2026-10-02T10:00:00Z'), endedAt: t('2026-10-02T11:00:00Z'), exitReason: 'completed', ...over,
  });
  const ev = (over: Partial<ReportEventRow>): ReportEventRow => ({
    sessionId: 'cse_A', orderId: 'o1', userId: 'u1', owner: 'ada', instanceId: 'box-a', kind: 'placed', detail: null, at: t('2026-10-02T10:00:00Z'), ...over,
  });
  const runs = [
    run({}),
    run({ orderId: 'o2', sessionId: 'cse_A', startedAt: t('2026-10-03T10:00:00Z'), endedAt: t('2026-10-03T10:30:00Z'), exitReason: 'interrupted', clientPlatform: 'ios' }),
    run({ orderId: 'o3', sessionId: 'cse_B', userId: 'u2', owner: 'bob', instanceId: 'box-b', boxName: 'bob-box', startedAt: t('2026-10-03T09:00:00Z'), endedAt: t('2026-10-03T09:10:00Z'), exitReason: 'lost' }),
    // Open since 11:00 today: counts an hour of slot time up to now.
    run({ orderId: 'o4', sessionId: 'cse_C', startedAt: t('2026-10-07T11:00:00Z'), endedAt: null, exitReason: null, clientPlatform: null }),
  ];
  const events = [
    // cse_A: refused twice, placed 7 minutes after the first refusal, started 40 s after placement.
    ev({ kind: 'queued', detail: REFUSAL_TEXTS.noBox, at: t('2026-10-02T09:53:00Z') }),
    ev({ kind: 'queued', detail: REFUSAL_TEXTS.boxesFull(1, 3), at: t('2026-10-02T09:57:00Z') }),
    ev({ kind: 'placed', at: t('2026-10-02T10:00:00Z') }),
    ev({ kind: 'started', at: t('2026-10-02T10:00:40Z') }),
    // o2: placed and started without a queue.
    ev({ orderId: 'o2', kind: 'placed', at: t('2026-10-03T10:00:00Z') }),
    ev({ orderId: 'o2', kind: 'started', at: t('2026-10-03T10:00:20Z') }),
    // bob: an agent failure, then nothing.
    ev({ sessionId: 'cse_B', orderId: 'o3', userId: 'u2', owner: 'bob', kind: 'agent-failed', detail: 'the box agent refused the launch: x', at: t('2026-10-03T08:00:00Z') }),
  ];
  const prior = [run({ orderId: 'p1', sessionId: 'cse_P', startedAt: t('2026-09-25T10:00:00Z'), endedAt: t('2026-09-25T12:00:00Z') })];

  it('totals sessions, runs, slot time, ends, refusals by category and the two latencies', () => {
    const r = buildCloudReport(runs, events, prior, range, 'day', now);
    expect(r.totals).toMatchObject({ sessions: 3, runs: 4, slotSeconds: 3600 + 1800 + 600 + 3600, lost: 1 });
    expect(r.totals.ends).toEqual({ completed: 1, interrupted: 1, lost: 1, open: 1 });
    expect(r.refusals).toEqual({ 'no-box': 1, 'boxes-full': 1, 'agent-failed': 1 });
    expect(r.totals.queueWait).toEqual({ p50: 420, p95: 420, samples: 1 });
    // Nearest rank over [20, 40]: the upper value for both, as provisioningStats computes its percentiles.
    expect(r.totals.spawn).toEqual({ p50: 40, p95: 40, samples: 2 });
    expect(r.prior).toEqual({ sessions: 1, runs: 1, slotSeconds: 7200, lost: 0 });
    expect(r.eventHorizonDays).toBe(30);
    // One row per day of the range, gaps included, in order.
    expect(r.rows.map(x => x.key)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    const day = Object.fromEntries(r.rows.map(x => [x.key, x]));
    expect(day['2026-10-02']).toMatchObject({ runs: 1, slotSeconds: 3600, refusals: { 'no-box': 1, 'boxes-full': 1 }, spawn: { samples: 1 } });
    expect(day['2026-10-03']).toMatchObject({ runs: 2, slotSeconds: 1800 + 600, refusals: { 'agent-failed': 1 } });
    expect(day['2026-10-05']).toMatchObject({ runs: 0, slotSeconds: 0, ends: {} });
    expect(day['2026-10-07']).toMatchObject({ runs: 1, slotSeconds: 3600, ends: { open: 1 } });
  });

  it('splits a run over the days it spans inside the range, and groups an end by where it fell', () => {
    // Started Oct 2 22:00, ended Oct 3 02:00: two hours on each day; the end is Oct 3's.
    const spanning = [run({ orderId: 's', sessionId: 'cse_S', startedAt: t('2026-10-02T22:00:00Z'), endedAt: t('2026-10-03T02:00:00Z'), exitReason: 'completed' })];
    const byDay = buildCloudReport(spanning, [], [], range, 'day', now);
    const day = Object.fromEntries(byDay.rows.map(x => [x.key, x]));
    expect(day['2026-10-02']).toMatchObject({ runs: 1, slotSeconds: 7200, ends: {} });
    expect(day['2026-10-03']).toMatchObject({ runs: 0, slotSeconds: 7200, ends: { completed: 1 } });
    // A run that started before the range opens no row outside it: its in-range hours land on the first day.
    const early = [run({ orderId: 'e', sessionId: 'cse_E', startedAt: t('2026-09-30T20:00:00Z'), endedAt: t('2026-10-01T06:00:00Z'), exitReason: 'completed' })];
    const earlyDay = buildCloudReport(early, [], [], range, 'day', now);
    expect(earlyDay.rows.map(x => x.key)[0]).toBe('2026-10-01');
    expect(earlyDay.rows[0]).toMatchObject({ runs: 0, slotSeconds: 6 * 3600, ends: { completed: 1 } });
    // Grouped by exit reason, a run that ends after the range is `open`, not its later outcome.
    const late = [run({ orderId: 'l', sessionId: 'cse_L', startedAt: t('2026-10-06T10:00:00Z'), endedAt: t('2026-10-08T10:00:00Z'), exitReason: 'completed' })];
    expect(buildCloudReport(late, [], [], range, 'exitReason', now).rows.map(x => [x.key, x.runs])).toEqual([['open', 1]]);
  });

  it('clips slot time to the range, counts starts and ends inside it only, and reads a queue streak that began before it', () => {
    // A seven-day range ending 2026-10-07; the run below started the day before it and is still open.
    const r = buildCloudReport([
      run({ orderId: 'early', sessionId: 'cse_E', startedAt: t('2026-09-30T20:00:00Z'), endedAt: null, exitReason: null }),
      // Started inside, ended after the range: not an end of this range, open at its close.
      run({ orderId: 'late-end', sessionId: 'cse_L', startedAt: t('2026-10-06T10:00:00Z'), endedAt: t('2026-10-08T10:00:00Z'), exitReason: 'completed' }),
      // Started before, lost inside: an end (and a loss) of this range, not a start.
      run({ orderId: 'lost-in', sessionId: 'cse_X', startedAt: t('2026-09-30T23:00:00Z'), endedAt: t('2026-10-01T00:30:00Z'), exitReason: 'lost' }),
    ], [
      // Refused at 23:50 the night before, placed at 00:05 inside the range: a 15-minute wait that crosses midnight.
      ev({ sessionId: 'cse_E', orderId: 'early', kind: 'queued', detail: REFUSAL_TEXTS.noBox, at: t('2026-09-30T23:50:00Z') }),
      ev({ sessionId: 'cse_E', orderId: 'early', kind: 'placed', at: t('2026-10-01T00:05:00Z') }),
      // A refusal before the range is not one of the range's refusals.
      ev({ sessionId: 'cse_Z', orderId: 'z', kind: 'queued', detail: REFUSAL_TEXTS.noBox, at: t('2026-09-30T12:00:00Z') }),
    ], [], range, 'day', now);
    // early: all of the range up to now (Oct 1 00:00 → Oct 7 12:00 = 6.5 days); late-end: Oct 6 10:00 → range end Oct 8 00:00 = 38 h; lost-in: 30 min.
    expect(r.totals.slotSeconds).toBe(6.5 * 86400 + 38 * 3600 + 1800);
    expect(r.totals.runs).toBe(1);
    expect(r.totals.sessions).toBe(1);
    expect(r.totals.ends).toEqual({ lost: 1, open: 1 });
    expect(r.totals.lost).toBe(1);
    expect(r.refusals).toEqual({});
    expect(r.totals.queueWait).toEqual({ p50: 900, p95: 900, samples: 1 });
  });

  it('judges the prior range by the same rules over its own window', () => {
    const r = buildCloudReport([], [], [
      // Started in the prior week, ran into this one: prior gets its slot time up to the boundary only.
      run({ orderId: 'p1', sessionId: 'cse_P', startedAt: t('2026-09-30T22:00:00Z'), endedAt: t('2026-10-01T02:00:00Z'), exitReason: 'completed' }),
      // Lost after the prior window: not a prior loss.
      run({ orderId: 'p2', sessionId: 'cse_Q', startedAt: t('2026-09-29T10:00:00Z'), endedAt: t('2026-10-02T10:00:00Z'), exitReason: 'lost' }),
    ], range, 'day', now);
    // p1: Sep 30 22:00 → the boundary at Oct 1 00:00 = 2 h; p2: Sep 29 10:00 → the boundary = 38 h.
    expect(r.prior).toEqual({ sessions: 2, runs: 2, slotSeconds: 2 * 3600 + 38 * 3600, lost: 0 });
  });

  it('groups by owner, box, platform and exit reason; refusals land on day and owner rows only', () => {
    const byOwner = buildCloudReport(runs, events, [], range, 'owner', now);
    expect(byOwner.rows.map(x => [x.label, x.runs, x.refusals])).toEqual([['ada', 3, { 'no-box': 1, 'boxes-full': 1 }], ['bob', 1, { 'agent-failed': 1 }]]);
    const byBox = buildCloudReport(runs, events, [], range, 'box', now);
    expect(byBox.rows.map(x => [x.label, x.runs])).toEqual([['ada-box', 3], ['bob-box', 1]]);
    expect(byBox.rows[0].refusals).toEqual({});
    expect(byBox.rows[0].spawn.samples).toBe(2);
    const byPlatform = buildCloudReport(runs, events, [], range, 'platform', now);
    expect(byPlatform.rows.map(x => x.key).sort()).toEqual(['ios', 'unknown', 'web_claude_ai']);
    const byEnd = buildCloudReport(runs, events, [], range, 'exitReason', now);
    expect(Object.fromEntries(byEnd.rows.map(x => [x.key, x.runs]))).toEqual({ completed: 1, interrupted: 1, lost: 1, open: 1 });
    // Nothing from the fixture carries a title or an email.
    expect(JSON.stringify(byOwner)).not.toContain('@');
  });
});
