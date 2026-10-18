import { describe, expect, it, vi } from 'vitest';
import { buildLedger, cleanDigest, needsAttention, MAX_DIGESTS, type LedgerDeps, type LiveRow, type OwnedProject } from './ledger';
import type { BriefingWindow } from './types';

const window: BriefingWindow = {
  since: '2026-10-09T16:00:00.000Z',
  until: '2026-10-12T07:00:00.000Z',
  tz: 'UTC',
  label: 'Fri 9 Oct 16:00 to Mon 12 Oct 07:00 (2 days 15 hours)',
  basis: 'since_last',
  previousBriefingAt: '2026-10-09T16:01:00.000Z',
};
const user = { id: 'u1', unixUsername: 'pat' };

function row(over: Partial<LiveRow>): LiveRow {
  return {
    projectId: 'p1', projectName: 'termag', access: 'owner', workstream: 'main', role: 'agent', instanceId: 'box1',
    connected: true, status: 'idle', updatedAt: null, waitingReason: null, rateLimited: null, milestone: null, provider: 'claude',
    ...over,
  };
}

function project(over: Partial<OwnedProject>): OwnedProject {
  return {
    id: 'p1', name: 'termag', instanceId: 'box1', user: { unixUsername: 'pat' },
    instance: { hostHome: '/home/pat', name: 'devbox' },
    workstreams: [{ name: 'main', lastActiveAt: new Date('2026-10-01T00:00:00Z') }],
    ...over,
  };
}

function deps(over: Partial<LedgerDeps> = {}): LedgerDeps {
  return {
    liveRows: async () => [],
    ownedProjects: async () => [],
    boxNames: async ids => new Map(ids.map(id => [id, `name-${id}`])),
    worktime: async () => [],
    tokens: async () => [],
    visits: async () => [],
    contextPeaks: async () => [],
    cloud: async () => [],
    prs: async () => [],
    connected: () => true,
    digest: async () => ({ transcript: null, commits: [], branch: 'main' }),
    paneTail: async () => null,
    serverTz: () => 'UTC',
    now: () => new Date('2026-10-12T07:00:05Z'),
    ...over,
  };
}

describe('buildLedger', () => {
  it('lists touched sessions with activity, busiest first, and totals', async () => {
    const d = deps({
      liveRows: async () => [
        row({}),
        row({ projectId: 'p2', projectName: 'dotfiles' }),
        row({ projectId: 'p3', projectName: 'quiet' }),
      ],
      ownedProjects: async () => [project({}), project({ id: 'p2', name: 'dotfiles' }), project({ id: 'p3', name: 'quiet' })],
      worktime: async () => [
        { project: 'termag', provider: 'claude', date: '2026-10-10', totalMs: 3_600_000, sessions: 2, instanceId: 'box1' },
        { project: 'termag', provider: 'human', date: '2026-10-10', totalMs: 600_000, sessions: 1, instanceId: 'box1' },
        { project: 'dotfiles', provider: 'claude', date: '2026-10-11', totalMs: 7_200_000, sessions: 1, instanceId: 'box1' },
      ],
      tokens: async () => [{ projectId: 'p1', workstream: 'main', tokens: 1000 }, { projectId: null, workstream: null, tokens: 5 }],
      visits: async () => [
        { projectId: 'p1', workstream: 'main', previousProjectId: 'p2', timestamp: new Date('2026-10-10T10:00:00Z') },
        { projectId: 'p1', workstream: 'main', previousProjectId: 'p1', timestamp: new Date('2026-10-10T11:00:00Z') },
      ],
      contextPeaks: async () => [{ projectId: 'p1', workstream: 'main', maxTokens: 150_000 }],
    });
    const l = await buildLedger(user, window, d);
    expect(l.sessions.map(s => s.projectName)).toEqual(['dotfiles', 'termag']);
    const t = l.sessions[1];
    expect(t.activity).toMatchObject({ agentMs: 3_600_000, humanMs: 600_000, tokens: 1000, visits: 2, peakContextTokens: 150_000 });
    expect(t.boxName).toBe('name-box1');
    expect(l.totals).toMatchObject({ agentMs: 10_800_000, humanMs: 600_000, tokens: 1005, sessionsTouched: 2, switches: 1 });
    expect(l.window).toBe(window);
    expect(l.trust).toMatch(/UNTRUSTED/);
  });

  it('keeps a waiting session and captures its pane, but not a shared project', async () => {
    const paneTail = vi.fn(async () => 'Do you want to proceed? 1. Yes');
    const digest = vi.fn(async () => ({ transcript: null, commits: [], branch: 'main' }));
    const l = await buildLedger(user, window, deps({
      liveRows: async () => [
        row({ status: 'waiting', waitingReason: 'approval' }),
        row({ projectId: 's1', projectName: 'shared', access: 'collaborator', status: 'waiting' }),
      ],
      ownedProjects: async () => [project({})],
      paneTail,
      digest,
    }));
    expect(l.sessions).toHaveLength(2);
    expect(l.totals.waitingNow).toBe(2);
    expect(paneTail).toHaveBeenCalledTimes(1);
    expect(paneTail).toHaveBeenCalledWith('u1', 'p1', 'main');
    expect(digest).toHaveBeenCalledTimes(1);
    expect(l.sessions.find(s => s.projectId === 's1')!.digest).toBeNull();
    expect(l.sessions.find(s => s.projectId === 'p1')!.paneTail).toContain('proceed');
  });

  it('asks the box for a digest with the workstream checkout and the window', async () => {
    const digest = vi.fn(async () => ({
      branch: 'feat/x',
      commits: [{ sha: 'abc1234', at: '2026-10-10T12:00:00Z', subject: 'wip' }],
      transcript: { userTurns: 3, firstAt: null, lastAt: null, lastUserPrompts: ['hi'], lastAssistantText: 'Keep it?', endsWithQuestion: true, todos: [{ content: 'tests', status: 'pending' }] },
    }));
    const l = await buildLedger(user, window, deps({
      liveRows: async () => [row({ workstream: 'feat' })],
      ownedProjects: async () => [project({ workstreams: [{ name: 'feat', lastActiveAt: new Date('2026-10-11T00:00:00Z') }] })],
      digest: digest as unknown as LedgerDeps['digest'],
    }));
    expect(digest).toHaveBeenCalledWith({ userId: 'u1', instanceId: 'box1' }, '/home/pat/termag/projects/termag/.worktrees/feat', window.since, window.until);
    expect(l.sessions[0].digest?.transcript?.endsWithQuestion).toBe(true);
  });

  it('notes offline boxes and old agents instead of failing', async () => {
    let calls = 0;
    const l = await buildLedger(user, window, deps({
      liveRows: async () => [
        row({ status: 'waiting' }),
        row({ projectId: 'p2', projectName: 'b', status: 'waiting' }),
        row({ projectId: 'p3', projectName: 'c', instanceId: 'box2', connected: false }),
      ],
      ownedProjects: async () => [
        project({ workstreams: [{ name: 'main', lastActiveAt: new Date('2026-10-10T00:00:00Z') }] }),
        project({ id: 'p2', name: 'b', workstreams: [{ name: 'main', lastActiveAt: new Date('2026-10-10T00:00:00Z') }] }),
        project({ id: 'p3', name: 'c', instanceId: 'box2', workstreams: [{ name: 'main', lastActiveAt: new Date('2026-10-10T00:00:00Z') }] }),
      ],
      connected: h => h.instanceId !== 'box2',
      digest: async () => { calls++; throw new Error('Unknown command: briefing-digest'); },
    }));
    // The second session on the same old agent is not asked again.
    expect(calls).toBe(1);
    expect(l.notes.join(' ')).toMatch(/too old/);
    expect(l.notes.join(' ')).toMatch(/offline/);
    expect(l.sessions.find(s => s.projectId === 'p3')).toMatchObject({ hostOffline: true, status: { now: 'unknown' } });
    expect(l.totals.offlineBoxes).toBe(1);
  });

  it('links PRs to sessions and keeps unlinked ones that need attention', async () => {
    const pr = (over: Record<string, unknown>) => ({
      kind: 'pr', lane: 'checks', repo: 'o/r', number: 1, title: 't', url: 'u', author: 'me', headRefName: 'h', baseRefName: 'main',
      at: null, badges: [], failingChecks: ['ci'], pendingChecks: [], waitingOn: [], blockedBy: null, mergedAt: null,
      mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null, ...over,
    });
    const l = await buildLedger(user, window, deps({
      liveRows: async () => [row({})],
      ownedProjects: async () => [project({})],
      prs: async () => [
        pr({ workstream: { projectId: 'p1', projectName: 'termag', workstream: 'main' } }),
        pr({ number: 2, lane: 'needs_my_review', failingChecks: [] }),
        pr({ number: 3, lane: 'deployed', failingChecks: [] }),
      ] as never,
    }));
    // The session had no other activity: an attention PR alone makes it touched.
    expect(l.sessions).toHaveLength(1);
    expect(l.sessions[0].prs.map(p => p.number)).toEqual([1]);
    expect(l.otherPrs.map(p => p.number)).toEqual([2]);
    expect(l.totals.prsNeedingAttention).toBe(2);
  });

  it('light mode reads no boxes and no GitHub', async () => {
    const digest = vi.fn(); const paneTail = vi.fn(); const prs = vi.fn(async () => []);
    await buildLedger(user, window, deps({
      liveRows: async () => [row({ status: 'waiting' })],
      ownedProjects: async () => [project({})],
      digest: digest as never, paneTail: paneTail as never, prs,
    }), { light: true });
    expect(digest).not.toHaveBeenCalled();
    expect(paneTail).not.toHaveBeenCalled();
    expect(prs).not.toHaveBeenCalled();
  });

  it('caps the digests it asks for', async () => {
    const n = MAX_DIGESTS + 3;
    const digest = vi.fn(async () => ({ transcript: null, commits: [], branch: null }));
    const l = await buildLedger(user, window, deps({
      liveRows: async () => Array.from({ length: n }, (_, i) => row({ projectId: `p${i}`, projectName: `n${i}`, status: 'waiting' })),
      ownedProjects: async () => Array.from({ length: n }, (_, i) => project({ id: `p${i}`, name: `n${i}` })),
      digest,
    }));
    expect(digest).toHaveBeenCalledTimes(MAX_DIGESTS);
    expect(l.notes.join(' ')).toMatch(/without a digest/);
  });
});

describe('cleanDigest', () => {
  it('truncates and drops malformed parts', () => {
    const d = cleanDigest({
      branch: 'x'.repeat(500),
      commits: [{ sha: 'a', subject: 's'.repeat(500) }, { nope: true }],
      transcript: { userTurns: 'many', lastUserPrompts: Array(9).fill('p'), lastAssistantText: 'z'.repeat(5000), endsWithQuestion: 'yes', todos: [{ content: 'c', status: 'weird' }] },
    });
    expect(d!.branch!.length).toBe(200);
    expect(d!.commits).toHaveLength(1);
    expect(d!.commits[0].subject.length).toBe(200);
    expect(d!.transcript).toMatchObject({ userTurns: 0, endsWithQuestion: false });
    expect(d!.transcript!.lastUserPrompts).toHaveLength(5);
    expect(d!.transcript!.lastAssistantText!.length).toBe(1200);
    expect(d!.transcript!.todos[0].status).toBe('pending');
    expect(cleanDigest(null)).toBeNull();
  });
});

describe('needsAttention', () => {
  it('counts red checks but not pending ones', () => {
    expect(needsAttention({ lane: 'checks', failingChecks: ['x'] })).toBe(true);
    expect(needsAttention({ lane: 'checks', failingChecks: [] })).toBe(false);
    expect(needsAttention({ lane: 'ready_to_merge', failingChecks: [] })).toBe(true);
    expect(needsAttention({ lane: 'needs_approval', failingChecks: [] })).toBe(false);
  });
});
