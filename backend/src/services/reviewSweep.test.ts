import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { getStatus, setStatus } from './status';
import {
  adoptHostPanels, clearReviewRecord, getReviewRecord, identityOf, markReviewSeen, registerReviewRecord, touchRecordWithProbe,
  resetReviewSweepForTests, reviewForSharedViewer, reviewMetaOf, runReviewSweepTick,
} from './reviewSweep';
import { probeReviewPane } from './review';
import { connectedProjectHosts } from './agentRegistry';

vi.mock('../db', () => ({
  prisma: {
    project: { findMany: vi.fn() },
    sessionStatus: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    workTimeEntry: { upsert: vi.fn() },
  },
}));
vi.mock('./agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  connectedProjectHosts: vi.fn(),
  sendForProject: vi.fn(),
  isAgentConnected: vi.fn(() => true),
  isInstanceAgentConnected: vi.fn(() => true),
}));
vi.mock('./tmux', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAgentRunning: vi.fn(),
}));

const HOST = { userId: 'u1', instanceId: 'box1' };
const IDENTITY = identityOf({
  host: HOST,
  projectId: 'p1',
  projectName: 'widget',
  ownerUsername: 'alice',
  workstream: 'main',
});

type Probe = Awaited<ReturnType<typeof probeReviewPane>>;

/** A minimal fake sendForProject: answers the RPCs probeReviewPane and discovery ask. */
function fakeSend(pane: { sessions?: string[]; cmd?: string | null; text?: string; option?: unknown } = {}) {
  const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const send = vi.fn(async (_host: unknown, type: string, payload: Record<string, unknown> = {}) => {
    calls.push({ type, payload });
    switch (type) {
      case 'tmux-list':
        return { sessions: pane.sessions ?? [] };
      case 'tmux-has-session':
        return { exists: pane.sessions?.includes(String(payload.sessionName)) === true };
      case 'tmux-foreground-cmd':
        return pane.cmd === undefined ? null : { cmd: pane.cmd ?? null };
      case 'tmux-capture':
        return { content: pane.text ?? '' };
      case 'tmux-get-user-option':
        return { value: pane.option ?? null };
      case 'tmux-set-user-option':
        return { ok: true };
      default:
        return {};
    }
  });
  return { send, calls };
}

function probe(over: Partial<Probe> = {}): Probe {
  return {
    exists: true, state: 'reviewing', pr: null, url: null, recovered: null, unrecoverable: false,
    ...over,
  };
}

beforeEach(() => {
  resetReviewSweepForTests();
  vi.mocked(prisma.project.findMany).mockResolvedValue([]);
  vi.mocked(connectedProjectHosts).mockReturnValue([] as never);
});

describe('touchRecordWithProbe (the sweep\'s state machine)', () => {
  it('a pane with no recoverable PR files nothing', () => {
    touchRecordWithProbe(null, probe({ unrecoverable: true }), IDENTITY);
    expect(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)).toBeNull();
  });

  it('registration publishes reviewing on the agent session and survives status flips', async () => {
    const rec = registerReviewRecord(IDENTITY, { pr: 205, url: 'https://github.com/o/r/pull/205' }, { now: 1_000 });
    expect(rec.state).toBe('reviewing');
    const st = getStatus('alice-widget-agent', HOST.instanceId);
    expect(st.review?.state).toBe('reviewing');
    expect(st.review?.pr).toBe(205);
    expect(st.review?.url).toBe('https://github.com/o/r/pull/205');

    // A hook-driven flip of the underlying status must not drop the review
    // (same rule the milestone has); the sweep is its only writer.
    setStatus('alice-widget-agent', 'working', undefined, undefined, HOST.instanceId);
    expect(getStatus('alice-widget-agent', HOST.instanceId).review?.state).toBe('reviewing');
  });

  it('moves through the states and stamps doneAt on entering done', () => {
    const rec = registerReviewRecord(IDENTITY, { pr: 9, url: null }, { now: 1_000 });
    touchRecordWithProbe(rec, probe({ state: 'waiting' }), IDENTITY, 5_000);
    let meta = reviewMetaOf(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)!);
    expect(meta.state).toBe('waiting');
    expect(meta.doneAt).toBeNull();

    touchRecordWithProbe(rec, probe({ state: 'done' }), IDENTITY, 60_000);
    meta = reviewMetaOf(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)!);
    expect(meta.state).toBe('done');
    expect(meta.doneAt?.getTime()).toBe(60_000);
    expect(meta.at.getTime()).toBe(60_000);
    expect(getStatus('alice-widget-agent', HOST.instanceId).review?.state).toBe('done');
  });

  it('re-entering the same state writes nothing (at stays at the last transition)', () => {
    const rec = registerReviewRecord(IDENTITY, { pr: 9, url: null }, { now: 1_000 });
    touchRecordWithProbe(rec, probe({ state: 'reviewing' }), IDENTITY, 20_000);
    expect(reviewMetaOf(rec).at.getTime()).toBe(1_000);
  });

  it('a foreground-cmd hiccup (state null) keeps the last state', () => {
    const rec = registerReviewRecord(IDENTITY, { pr: 9, url: null }, { now: 1_000 });
    touchRecordWithProbe(rec, probe({ state: 'waiting' }), IDENTITY, 5_000);
    touchRecordWithProbe(rec, probe({ state: null }), IDENTITY, 8_000);
    expect(reviewMetaOf(rec).state).toBe('waiting');
    expect(reviewMetaOf(rec).at.getTime()).toBe(5_000);
  });

  it('recovers a record from the probe (option value) when none existed', () => {
    touchRecordWithProbe(null, probe({
      recovered: { pr: 205, url: 'https://github.com/o/r/pull/205' },
      state: 'done',
    }), IDENTITY, 5_000);
    const rec = getReviewRecord(HOST.instanceId, IDENTITY.reviewSession);
    expect(rec?.pr).toBe(205);
    expect(rec?.startedAt).toBeNull(); // recovered, not launched by this process
    expect(rec?.state).toBe('done');
    expect(rec?.doneAt?.getTime()).toBe(5_000);
    expect(getStatus('alice-widget-agent', HOST.instanceId).review?.state).toBe('done');
  });

  it('a record cleared while its probe was in flight does not resurrect the ring (the mid-probe race)', () => {
    registerReviewRecord(IDENTITY, { pr: 9, url: null }, { now: 1_000 });
    clearReviewRecord(IDENTITY); // DELETE /review landed while the probe awaited
    // The route/sweep re-read the record after the probe: null → nothing republished.
    touchRecordWithProbe(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession), probe({ exists: true, state: 'done' }), IDENTITY, 30_000);
    expect(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)).toBeNull();
    expect(getStatus('alice-widget-agent', HOST.instanceId).review ?? null).toBeNull();
  });

  it('a just-launched pane whose bare prompt would read done stays reviewing; waiting is trusted early', () => {
    const rec = registerReviewRecord(IDENTITY, { pr: 9, url: null }, { now: 10_000 });
    touchRecordWithProbe(rec, probe({ state: 'done' }), IDENTITY, 10_000);
    expect(reviewMetaOf(rec).state).toBe('reviewing');
    touchRecordWithProbe(rec, probe({ state: 'waiting' }), IDENTITY, 11_000);
    expect(reviewMetaOf(rec).state).toBe('waiting');
    // After the settle window has passed, done is real.
    touchRecordWithProbe(rec, probe({ state: 'done' }), IDENTITY, 23_000);
    expect(reviewMetaOf(rec).state).toBe('done');
  });

  it('a missing pane clears the record and the field on the agent session', () => {
    registerReviewRecord(IDENTITY, { pr: 9, url: null }, { now: 1_000 });
    touchRecordWithProbe(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession), probe({ exists: false }), IDENTITY, 2_000);
    expect(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)).toBeNull();
    expect(getStatus('alice-widget-agent', HOST.instanceId).review ?? null).toBeNull();
  });
});

describe('seen', () => {
  it('stamps seenAt, pushes the field, and a later done rings again (new doneAt newer than seenAt)', () => {
    const rec = registerReviewRecord(IDENTITY, { pr: 9, url: null }, { now: 1_000 });
    touchRecordWithProbe(rec, probe({ state: 'done' }), IDENTITY, 5_000);
    expect(markReviewSeen(HOST.instanceId, IDENTITY.reviewSession, 6_000)).toBe(true);
    let meta = reviewMetaOf(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)!);
    expect(meta.seenAt?.getTime()).toBe(6_000);
    // The push happened despite the unchanged state (force): browsers read
    // the status channel, not the record map.
    expect(getStatus('alice-widget-agent', HOST.instanceId).review?.seenAt != null).toBe(true);

    touchRecordWithProbe(rec, probe({ state: 'reviewing' }), IDENTITY, 10_000);
    touchRecordWithProbe(rec, probe({ state: 'done' }), IDENTITY, 20_000);
    meta = reviewMetaOf(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)!);
    expect(meta.doneAt?.getTime()).toBe(20_000);
    expect(meta.seenAt?.getTime()).toBe(6_000);
  });

  it('never stamps earlier than the done it answers', () => {
    const rec = registerReviewRecord(IDENTITY, { pr: 9, url: null }, { now: 0 });
    // Past the settle window, so done is real and stamped.
    touchRecordWithProbe(rec, probe({ state: 'done' }), IDENTITY, 20_000);
    markReviewSeen(HOST.instanceId, IDENTITY.reviewSession, 2_000);
    expect(reviewMetaOf(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)!).seenAt?.getTime()).toBe(20_000);
  });

  it('answers false with no record (nothing to mark)', () => {
    expect(markReviewSeen(HOST.instanceId, IDENTITY.reviewSession)).toBe(false);
  });
});

describe('reviewForSharedViewer', () => {
  it('strips only the url', () => {
    const m = { state: 'done' as const, pr: 5, url: 'https://github.com/o/r/pull/5', at: new Date(0), doneAt: new Date(0), seenAt: null };
    expect(reviewForSharedViewer(m)).toEqual({ ...m, url: null });
    expect(reviewForSharedViewer(null)).toBeNull();
  });
});

describe('discovery', () => {
  const CAND = { host: HOST, projectId: 'p1', projectName: 'widget', ownerUsername: 'alice', workstreams: ['main'] };
  const GROUP = { host: HOST, projects: [{ projectId: 'p1', projectName: 'widget', ownerUsername: 'alice', workstreams: ['main'] }] };
  const PRAGMA = [{
    id: 'p1', name: 'widget', userId: 'u1', instanceId: 'box1',
    user: { unixUsername: 'alice' }, workstreams: [{ name: 'main' }],
  }];

  it('adopts a live -review session from tmux-list, PR from the option, and publishes', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue(PRAGMA as never);
    const { send, calls } = fakeSend({
      sessions: ['alice-widget-agent', 'alice-widget-ctrl', 'alice-widget-review'],
      cmd: 'devin',
      text: '✻ Thinking · 12s (esc twice to interrupt)',
      option: '205 https://github.com/o/r/pull/205',
    });
    const r = await adoptHostPanels(send, GROUP, 1_000);
    expect(r).toEqual({ ok: true, adopted: 1 });
    const rec = getReviewRecord(HOST.instanceId, IDENTITY.reviewSession);
    expect(rec?.pr).toBe(205);
    expect(rec?.startedAt).toBeNull();
    expect(rec?.state).toBe('reviewing');
    expect(getStatus('alice-widget-agent', HOST.instanceId).review?.state).toBe('reviewing');
    // One tmux-list for the whole host, and recovery took the option path, not
    // the once-only deep capture.
    expect(calls.filter(c => c.type === 'tmux-list')).toHaveLength(1);
    expect(calls.filter(c => c.type === 'tmux-capture' && c.payload.lines === 1000)).toHaveLength(0);
  });

  it('one tmux-list serves every project on the host (no sibling skipped)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      PRAGMA[0],
      { id: 'p2', name: 'other', userId: 'u1', instanceId: 'box1', user: { unixUsername: 'alice' }, workstreams: [{ name: 'main' }] },
    ] as never);
    const { send, calls } = fakeSend({
      sessions: ['alice-widget-review', 'alice-other-review'],
      cmd: 'devin',
      text: '⠀⠴ Thinking · 4s (esc twice to interrupt)',
      option: '3 https://github.com/o/r/pull/3',
    });
    const r = await adoptHostPanels(send, {
      host: HOST,
      projects: [
        { projectId: 'p1', projectName: 'widget', ownerUsername: 'alice', workstreams: ['main'] },
        { projectId: 'p2', projectName: 'other', ownerUsername: 'alice', workstreams: ['main'] },
      ],
    }, 1_000);
    expect(r).toEqual({ ok: true, adopted: 2 });
    expect(getReviewRecord(HOST.instanceId, 'alice-widget-review')?.pr).toBe(3);
    expect(getReviewRecord(HOST.instanceId, 'alice-other-review')?.pr).toBe(3);
    expect(calls.filter(c => c.type === 'tmux-list')).toHaveLength(1); // the bugbot regression: no per-project listing
  });

  it('a failed tmux-list reports not-ok, adopts nothing, and leaves the host unseen', async () => {
    const send = vi.fn(async () => { throw new Error('timed out'); });
    const r = await adoptHostPanels(send as never, GROUP, 1_000);
    expect(r).toEqual({ ok: false, adopted: 0 });
    expect(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)).toBeNull();
  });

  it('a live pane with no recoverable PR is adopted once and not re-probed on the next pass', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue(PRAGMA as never);
    const { send, calls } = fakeSend({
      sessions: ['alice-widget-review'],
      cmd: 'devin',
      text: '❭ Guide Devin while it works',
      option: null,
    });
    await adoptHostPanels(send, GROUP, 1_000);
    expect(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)).toBeNull();
    expect(calls.filter(c => c.type === 'tmux-capture' && c.payload.lines === 1000).length).toBeGreaterThan(0);
    calls.length = 0;
    await adoptHostPanels(send, GROUP, 2_000);
    expect(calls.filter(c => c.type === 'tmux-capture' && c.payload.lines === 1000)).toHaveLength(0);
  });

  it('a rediscovered already-done review publishes done exactly once — no reviewing flash first', async () => {
    const { send, calls } = fakeSend({
      sessions: ['alice-widget-review'],
      cmd: 'devin',
      // The verdict is on screen and the input box is empty: the pane is done.
      text: ' Verdict: approve with nits.\n❭ ',
      option: '205 https://github.com/o/r/pull/205',
    });
    await adoptHostPanels(send, GROUP, 1_000);
    const rec = getReviewRecord(HOST.instanceId, IDENTITY.reviewSession);
    expect(rec?.state).toBe('done');
    // The agent session's status was written once, with the final state.
    expect(getStatus('alice-widget-agent', HOST.instanceId).review?.state).toBe('done');
    expect(getStatus('alice-widget-agent', HOST.instanceId).review?.doneAt != null).toBe(true);
    expect(calls.filter(c => c.type === 'tmux-has-session')).toHaveLength(1);
  });

  it('a full tick clears records whose pane is gone and answers nothing for record-less discovery', async () => {
    registerReviewRecord(IDENTITY, { pr: 9, url: null }, { now: 1_000 });
    vi.mocked(prisma.project.findMany).mockResolvedValue(PRAGMA as never);
    vi.mocked(connectedProjectHosts).mockReturnValue([HOST] as never);
    const { send } = fakeSend({ sessions: [] }); // the pane died: no session in tmux at all
    await runReviewSweepTick(send, 5_000);
    expect(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)).toBeNull();
    expect(getStatus('alice-widget-agent', HOST.instanceId).review ?? null).toBeNull();
  });

  it('a quiet tick (all hosts seen, no full pass) does not query the project table', async () => {
    vi.mocked(prisma.project.findMany).mockClear();
    vi.mocked(connectedProjectHosts).mockReturnValue([HOST] as never);
    // Prime seenHosts: tick one (full pass=false but a new host) adopts.
    vi.mocked(prisma.project.findMany).mockResolvedValue(PRAGMA as never);
    const { send } = fakeSend({ sessions: [] });
    await runReviewSweepTick(send, 1_000);
    expect(prisma.project.findMany).toHaveBeenCalledTimes(1);
    await runReviewSweepTick(send, 6_000); // nothing new, not a full pass
    expect(prisma.project.findMany).toHaveBeenCalledTimes(1); // no second query
  });
});

describe('clearReviewRecord (stop-route path)', () => {
  it('removes the record and nulls the field', () => {
    registerReviewRecord(IDENTITY, { pr: 9, url: null }, { now: 1_000 });
    clearReviewRecord(IDENTITY);
    expect(getReviewRecord(HOST.instanceId, IDENTITY.reviewSession)).toBeNull();
    expect(getStatus('alice-widget-agent', HOST.instanceId).review ?? null).toBeNull();
  });
});

describe('probeReviewPane (the classifier the route and sweep share)', () => {
  it('classifies the pane; the record it was given stands for pr/url', async () => {
    const { send } = fakeSend({
      sessions: ['alice-widget-review'],
      cmd: 'devin',
      text: '⠀⠴ Thinking · 39s (esc twice to interrupt)\n❭ Guide Devin while it works',
    });
    const p = await probeReviewPane(send, HOST, IDENTITY.reviewSession, { pr: 7, url: null });
    expect(p).toMatchObject({ exists: true, state: 'reviewing', pr: 7, url: null, recovered: null, unrecoverable: false });
  });

  it('a definitive exists:false is nothing at all', async () => {
    const { send } = fakeSend({ sessions: [] });
    const p = await probeReviewPane(send, HOST, IDENTITY.reviewSession, null);
    expect(p.exists).toBe(false);
    expect(p.state).toBeNull();
  });

  it('marks a pane unrecoverable after one deep capture with no echo', async () => {
    const { send, calls } = fakeSend({
      sessions: ['alice-widget-review'],
      cmd: 'devin',
      text: '❭ Guide Devin while it works\nsome verdict text',
    });
    const first = await probeReviewPane(send, HOST, IDENTITY.reviewSession, null);
    expect(first.recovered).toBeNull();
    expect(first.unrecoverable).toBe(true);
    expect(calls.filter(c => c.type === 'tmux-capture' && c.payload.lines === 1000)).toHaveLength(1);
  });
});
