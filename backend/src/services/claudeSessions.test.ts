import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { isInstanceAgentConnected, sendToInstanceAgent } from './agentRegistry';
import { recordSessionEvent } from './claudeSessionEvents';
import {
  backfillSessionSeq, buildSessions, cloudSessionName, deriveState, listCloudSessions, liveRuns, renameCloudSession, sessionKey, sessionUrl, sweepLostRuns, sweepRetention,
  type EventInput, type RunInput,
} from './claudeSessions';

vi.mock('../db', () => ({ prisma: {
  claudeRunnerSession: { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn() },
  claudeSessionEvent: { findMany: vi.fn(), deleteMany: vi.fn() },
} }));
vi.mock('./agentRegistry', () => ({ isInstanceAgentConnected: vi.fn(), sendToInstanceAgent: vi.fn() }));
vi.mock('./claudeSessionEvents', () => ({ recordSessionEvent: vi.fn(async () => {}) }));
vi.mock('./claudeRunnerSessions', () => ({ nextSessionSeq: vi.fn() }));
import { nextSessionSeq } from './claudeRunnerSessions';

const t = (s: string) => new Date(s);
const run = (over: Partial<RunInput> = {}): RunInput => ({
  orderId: 'ord.1', sessionId: 'cse_01A', instanceId: 'box-a', boxName: 'ada-box', hostUnixUser: 'ada', slot: 2,
  startedAt: t('2026-10-08T10:00:00Z'), endedAt: null, exitStatus: null, exitReason: null, clientPlatform: null, title: null, sessionSeq: null, ...over,
});
const ev = (kind: string, over: Partial<EventInput> = {}): EventInput => ({
  sessionId: 'cse_01A', orderId: 'ord.1', instanceId: 'box-a', kind, detail: null, at: t('2026-10-08T10:00:00Z'), ...over,
});

describe('sessionUrl and sessionKey', () => {
  it('swaps the cse_ prefix for session_ on claude.ai, and takes session_ ids as they are', () => {
    expect(sessionUrl('cse_018WY1ng4FeqiiV49u8ZrHmT')).toBe('https://claude.ai/code/session_018WY1ng4FeqiiV49u8ZrHmT');
    expect(sessionUrl('session_01A')).toBe('https://claude.ai/code/session_01A');
    expect(sessionUrl('sess-1')).toBeNull();
    expect(sessionUrl(null)).toBeNull();
  });

  it('groups by session id, else by order id for rows from before session ids were kept', () => {
    expect(sessionKey({ sessionId: 'cse_01A', orderId: 'ord.1' })).toBe('cse_01A');
    expect(sessionKey({ sessionId: null, orderId: 'ord.1' })).toBe('order:ord.1');
  });
});

describe('cloudSessionName', () => {
  it('prefixes every session with Claude Cloud and the owner ordinal, the prefix alone before numbering', () => {
    expect(cloudSessionName(3)).toBe('Claude Cloud 3');
    expect(cloudSessionName(null)).toBe('Claude Cloud');
  });
});

describe('renameCloudSession', () => {
  beforeEach(() => vi.clearAllMocks());
  it("sets the title on every run of the owner's session, by session id or order key, and clears with null", async () => {
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValue({ count: 2 } as never);
    expect(await renameCloudSession('u1', 'cse_01A', 'Auth fix')).toBe(2);
    expect(prisma.claudeRunnerSession.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1', sessionId: 'cse_01A' }, data: { title: 'Auth fix' } });
    await renameCloudSession('u1', 'order:ord.1', null);
    expect(prisma.claudeRunnerSession.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1', orderId: 'ord.1' }, data: { title: null } });
  });
});

describe('backfillSessionSeq', () => {
  beforeEach(() => vi.clearAllMocks());
  it('numbers unnumbered sessions per owner by first start, each from the owner counter, skipping one a placement numbered meanwhile', async () => {
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([
      { userId: 'u1', sessionId: 'cse_01B', startedAt: t('2026-10-01T00:00:00Z') },
      { userId: 'u2', sessionId: 'cse_02A', startedAt: t('2026-10-02T00:00:00Z') },
      { userId: 'u1', sessionId: 'cse_01A', startedAt: t('2026-10-03T00:00:00Z') },
      { userId: 'u1', sessionId: 'cse_01B', startedAt: t('2026-10-04T00:00:00Z') },
    ] as never);
    // cse_01A was placed, and numbered 3, between the scan and its turn under the lock.
    vi.mocked(prisma.claudeRunnerSession.findFirst).mockImplementation((async (q: { where: { sessionId: string } }) => q.where.sessionId === 'cse_01A' ? { sessionSeq: 3 } : null) as never);
    let n = 0;
    vi.mocked(nextSessionSeq).mockImplementation(async () => ++n);
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValue({ count: 1 } as never);
    expect(await backfillSessionSeq()).toBe(3);
    expect(prisma.claudeRunnerSession.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionSeq: null, sessionId: { not: null } } }));
    expect(vi.mocked(nextSessionSeq).mock.calls.map(c => c[0])).toEqual(['u1', 'u2']);
    const calls = vi.mocked(prisma.claudeRunnerSession.updateMany).mock.calls.map(c => c[0]);
    expect(calls).toEqual([
      { where: { userId: 'u1', sessionId: 'cse_01B', sessionSeq: null }, data: { sessionSeq: 1 } },
      { where: { userId: 'u1', sessionId: 'cse_01A', sessionSeq: null }, data: { sessionSeq: 3 } },
      { where: { userId: 'u2', sessionId: 'cse_02A', sessionSeq: null }, data: { sessionSeq: 2 } },
    ]);
  });
  it('does nothing when every session is numbered', async () => {
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([] as never);
    expect(await backfillSessionSeq()).toBe(0);
    expect(prisma.claudeRunnerSession.updateMany).not.toHaveBeenCalled();
  });
});

describe('deriveState', () => {
  it('is queued while only refusals exist, with the newest reason and the start of the streak', () => {
    expect(deriveState(null, [ev('queued', { detail: 'slots full', at: t('2026-10-08T10:01:00Z') }), ev('queued', { detail: 'no box' })]))
      .toEqual({ state: 'queued', exitReason: null, queuedReason: 'slots full', queuedSince: t('2026-10-08T10:00:00Z') });
    expect(deriveState(null, [ev('agent-failed', { detail: 'refused the launch' })])).toMatchObject({ state: 'queued', queuedReason: 'refused the launch', queuedSince: t('2026-10-08T10:00:00Z') });
  });

  it('is starting until the box posts started for the run, then running', () => {
    expect(deriveState(run(), [ev('placed')])).toMatchObject({ state: 'starting' });
    expect(deriveState(run(), [ev('started', { at: t('2026-10-08T10:00:30Z') }), ev('placed')])).toMatchObject({ state: 'running' });
    // A started for an earlier run of the session does not count for this one.
    expect(deriveState(run({ orderId: 'ord.2' }), [ev('started', { orderId: 'ord.1' })])).toMatchObject({ state: 'starting' });
    // A relaunch reopens the row with a new startedAt; the earlier launch's `started` is not this child's.
    expect(deriveState(run({ startedAt: t('2026-10-08T10:50:00Z') }), [ev('started', { at: t('2026-10-08T10:00:30Z') })])).toMatchObject({ state: 'starting' });
    // Within the clock-skew allowance it still counts.
    expect(deriveState(run({ startedAt: t('2026-10-08T10:00:45Z') }), [ev('started', { at: t('2026-10-08T10:00:30Z') })])).toMatchObject({ state: 'running' });
  });

  it('is queued again when a refusal is newer than the latest run (a re-offer while the old run lingers)', () => {
    const latest = run({ startedAt: t('2026-10-08T10:00:00Z') });
    expect(deriveState(latest, [ev('queued', { orderId: 'ord.2', detail: 'slots full', at: t('2026-10-08T12:00:00Z') }), ev('started')]))
      .toMatchObject({ state: 'queued', queuedReason: 'slots full', queuedSince: t('2026-10-08T12:00:00Z') });
    // The streak starts after the run, not at a refusal from before it.
    expect(deriveState(latest, [
      ev('queued', { orderId: 'ord.2', at: t('2026-10-08T12:08:00Z') }), ev('queued', { orderId: 'ord.2', at: t('2026-10-08T12:04:00Z') }),
      ev('started', { at: t('2026-10-08T10:00:30Z') }), ev('queued', { at: t('2026-10-08T09:59:00Z') }),
    ])).toMatchObject({ state: 'queued', queuedSince: t('2026-10-08T12:04:00Z') });
    // A refusal of the same order before its own launch is history, not a queue.
    expect(deriveState(latest, [ev('queued', { at: t('2026-10-08T09:59:00Z') })])).toMatchObject({ state: 'starting' });
  });

  it('is ended or lost from the latest run', () => {
    expect(deriveState(run({ endedAt: t('2026-10-08T11:00:00Z'), exitStatus: 0, exitReason: 'completed' }), [])).toEqual({ state: 'ended', exitReason: 'completed', queuedReason: null, queuedSince: null });
    expect(deriveState(run({ endedAt: t('2026-10-08T11:00:00Z'), exitReason: 'lost' }), [])).toMatchObject({ state: 'lost', exitReason: 'lost' });
  });
});

describe('buildSessions', () => {
  it('groups several runs of one session, newest activity first, with the title and platform from any run', () => {
    const runs = [
      run({ orderId: 'ord.1', startedAt: t('2026-10-08T10:00:00Z'), endedAt: t('2026-10-08T11:00:00Z'), exitStatus: 0, exitReason: 'completed', title: 'Fix the auth bug', sessionSeq: 3 }),
      run({ orderId: 'ord.2', startedAt: t('2026-10-08T12:00:00Z'), clientPlatform: 'ios' }),
      run({ orderId: 'ord.9', sessionId: 'cse_01B', startedAt: t('2026-10-08T09:00:00Z'), endedAt: t('2026-10-08T09:30:00Z'), exitStatus: 0 }),
    ];
    const events = [ev('started', { orderId: 'ord.2', at: t('2026-10-08T12:00:10Z') }), ev('placed', { orderId: 'ord.2', at: t('2026-10-08T12:00:00Z') }), ev('placed')];
    const alive = new Map<string, boolean | null>([['ord.2', true]]);
    const out = buildSessions(runs, events, alive);
    expect(out.map(s => s.key)).toEqual(['cse_01A', 'cse_01B']);
    const a = out[0];
    expect(a).toMatchObject({
      sessionId: 'cse_01A', url: 'https://claude.ai/code/session_01A', seq: 3, name: 'Claude Cloud 3', title: 'Fix the auth bug', clientPlatform: 'ios', state: 'running', eventCount: 3,
      firstSeenAt: '2026-10-08T10:00:00.000Z', lastSeenAt: '2026-10-08T12:00:10.000Z',
    });
    expect(a.current).toMatchObject({ orderId: 'ord.2', sessionName: 'ada-claude-runner-s2-ord_d2-r', alive: true, durationSec: null });
    expect(a.runs.map(r => r.orderId)).toEqual(['ord.2', 'ord.1']);
    expect(a.runs[1]).toMatchObject({ durationSec: 3600, exitReason: 'completed', alive: null });
    expect(out[1]).toMatchObject({ state: 'ended', eventCount: 0, current: expect.objectContaining({ orderId: 'ord.9' }) });
  });

  it('keeps a session that only has events, and a older run without a session id', () => {
    const out = buildSessions([run({ orderId: 'old.1', sessionId: null })], [ev('queued', { sessionId: 'cse_01Q', orderId: 'ord.q', detail: 'no box' })], new Map());
    expect(out.find(s => s.key === 'cse_01Q')).toMatchObject({ state: 'queued', queuedReason: 'no box', queuedSince: '2026-10-08T10:00:00.000Z', current: null, sessionId: 'cse_01Q' });
    expect(out.find(s => s.key === 'order:old.1')).toMatchObject({ sessionId: null, url: null, state: 'starting' });
  });
});

describe('liveRuns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks each connected box once and reads the runner sessions out of its tmux list', async () => {
    vi.mocked(isInstanceAgentConnected).mockImplementation(id => id === 'box-a');
    vi.mocked(sendToInstanceAgent).mockResolvedValue({ sessions: ['ada-termag-agent', 'ada-claude-runner-s2-ord_d1-r'] });
    const alive = await liveRuns([
      run({ orderId: 'ord.1' }), run({ orderId: 'ord.2', slot: 3 }),
      run({ orderId: 'ord.3', instanceId: 'box-b' }),
      run({ orderId: 'ord.4', endedAt: t('2026-10-08T11:00:00Z') }),
    ]);
    expect(sendToInstanceAgent).toHaveBeenCalledTimes(1);
    expect(sendToInstanceAgent).toHaveBeenCalledWith('box-a', 'tmux-list', {}, 5000);
    expect([...alive.entries()]).toEqual([['ord.1', true], ['ord.2', false], ['ord.3', null]]);
  });

  it('answers null for a box that does not answer', async () => {
    vi.mocked(isInstanceAgentConnected).mockReturnValue(true);
    vi.mocked(sendToInstanceAgent).mockRejectedValue(new Error('timeout'));
    expect([...(await liveRuns([run()])).entries()]).toEqual([['ord.1', null]]);
  });
});

describe('sweepLostRuns', () => {
  const now = t('2026-10-08T12:00:00Z');
  const openRow = (over: Record<string, unknown> = {}) => ({
    id: 'r1', orderId: 'ord.1', sessionId: 'cse_01A', userId: 'u1', instanceId: 'box-a', slot: 2, startedAt: t('2026-10-08T10:00:00Z'),
    endedAt: null, exitStatus: null, exitReason: null, clientPlatform: null, title: null,
    instance: { name: 'ada-box', hostUnixUser: 'ada', status: 'ready' }, user: { unixUsername: 'ada' }, ...over,
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(prisma.claudeSessionEvent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(isInstanceAgentConnected).mockReturnValue(true);
    vi.mocked(sendToInstanceAgent).mockResolvedValue({ sessions: [] });
  });

  it('stamps lost on an old open run whose runner session is gone, and logs the event', async () => {
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([openRow()] as never);
    expect(await sweepLostRuns(now)).toBe(1);
    expect(prisma.claudeRunnerSession.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { endedAt: null, startedAt: { lt: t('2026-10-08T11:50:00Z') } } }));
    // Guarded on the observed start, so a relaunch during the box call is not stamped.
    expect(prisma.claudeRunnerSession.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', endedAt: null, startedAt: t('2026-10-08T10:00:00Z') }, data: { endedAt: now, exitReason: 'lost' } });
    expect(recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'lost', sessionId: 'cse_01A', detail: 'runner session gone without an end report', at: now }));
    expect(vi.mocked(console.log).mock.calls[0][0]).toBe('[CLAUDE-RUNNER] order ord.1 for ada lost on ada-box slot 2 after 7200s (runner session gone without an end report)');
  });

  it('leaves a run alone while its runner session is live, its box is unreachable, or it signalled recently', async () => {
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([openRow()] as never);
    vi.mocked(sendToInstanceAgent).mockResolvedValueOnce({ sessions: ['ada-claude-runner-s2-ord_d1-r'] });
    expect(await sweepLostRuns(now)).toBe(0);
    vi.mocked(isInstanceAgentConnected).mockReturnValueOnce(false);
    expect(await sweepLostRuns(now)).toBe(0);
    vi.mocked(prisma.claudeSessionEvent.findMany).mockResolvedValueOnce([{ orderId: 'ord.1' }] as never);
    expect(await sweepLostRuns(now)).toBe(0);
    expect(prisma.claudeRunnerSession.updateMany).not.toHaveBeenCalled();
  });

  it('stamps lost at once on a box that is off, without asking it', async () => {
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([openRow({ instance: { name: 'ada-box', hostUnixUser: 'ada', status: 'stopped' } })] as never);
    expect(await sweepLostRuns(now)).toBe(1);
    expect(sendToInstanceAgent).not.toHaveBeenCalled();
    expect(recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'lost', detail: 'box stopped' }));
  });

  it('waits on a box that is stopping or hibernated: the runner may still report, or resume', async () => {
    vi.mocked(isInstanceAgentConnected).mockReturnValue(false);
    for (const status of ['stopping', 'hibernating', 'hibernated']) {
      vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([openRow({ instance: { name: 'ada-box', hostUnixUser: 'ada', status } })] as never);
      expect(await sweepLostRuns(now)).toBe(0);
    }
    expect(prisma.claudeRunnerSession.updateMany).not.toHaveBeenCalled();
  });

  it('writes no event for a older run without a session id, and none when another writer stamped first', async () => {
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([openRow({ sessionId: null })] as never);
    expect(await sweepLostRuns(now)).toBe(1);
    expect(recordSessionEvent).not.toHaveBeenCalled();
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([openRow()] as never);
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValueOnce({ count: 0 });
    expect(await sweepLostRuns(now)).toBe(0);
  });
});

describe('sweepRetention', () => {
  it('removes events after 30 days and ended runs after 90, never open runs or their events', async () => {
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([{ orderId: 'ord.open' }] as never);
    vi.mocked(prisma.claudeSessionEvent.deleteMany).mockResolvedValue({ count: 3 });
    vi.mocked(prisma.claudeRunnerSession.deleteMany).mockResolvedValue({ count: 1 });
    const now = t('2026-10-08T12:00:00Z');
    expect(await sweepRetention(now)).toEqual({ events: 3, runs: 1 });
    expect(prisma.claudeSessionEvent.deleteMany).toHaveBeenCalledWith({ where: { at: { lt: t('2026-09-08T12:00:00Z') }, orderId: { notIn: ['ord.open'] } } });
    expect(prisma.claudeRunnerSession.deleteMany).toHaveBeenCalledWith({ where: { endedAt: { not: null, lt: t('2026-07-10T12:00:00Z') } } });
  });
});

describe('listCloudSessions', () => {
  it("reads the window's events plus every event of a run still open, so an old running session is not shown as starting", async () => {
    vi.clearAllMocks();
    vi.mocked(isInstanceAgentConnected).mockReturnValue(false);
    const oldStart = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    vi.mocked(prisma.claudeRunnerSession.findMany).mockResolvedValue([{
      orderId: 'ord.old', sessionId: 'cse_OLD', instanceId: 'box-a', slot: 2, startedAt: oldStart, endedAt: null, exitStatus: null, exitReason: null,
      clientPlatform: null, title: null, instance: { name: 'ada-box', hostUnixUser: 'ada', status: 'ready' },
    }] as never);
    vi.mocked(prisma.claudeSessionEvent.findMany).mockResolvedValue([
      { sessionId: 'cse_OLD', orderId: 'ord.old', instanceId: 'box-a', kind: 'started', detail: null, at: new Date(oldStart.getTime() + 10_000) },
    ] as never);
    const out = await listCloudSessions('u1', { days: 30 });
    expect(prisma.claudeSessionEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1', OR: [{ at: { gte: expect.any(Date) } }, { orderId: { in: ['ord.old'] } }] },
    }));
    expect(out[0]).toMatchObject({ key: 'cse_OLD', state: 'running' });
  });
});
