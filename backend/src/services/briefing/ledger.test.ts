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
    tokensByDay: async () => [],
    dismissals: async () => [],
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
        pr({ number: 4, lane: 'team_review', failingChecks: [] }),
      ] as never,
    }));
    // The session had no other activity: an attention PR alone makes it touched.
    expect(l.sessions).toHaveLength(1);
    expect(l.sessions[0].prs.map(p => p.number)).toEqual([1]);
    // A team review is listed, not counted as attention.
    expect(l.otherPrs.map(p => p.number)).toEqual([2, 4]);
    expect(l.totals.prsNeedingAttention).toBe(2);
  });

  it('leaves out a PR-only item marked Done or deferred, for the whole mark, but still counts it', async () => {
    const pr = (n: number) => ({
      kind: 'pr', lane: 'needs_my_review', repo: 'o/r', number: n, title: 't', url: 'u', author: 'me', headRefName: 'h', baseRefName: 'main',
      at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [], blockedBy: null, mergedAt: null,
      mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null,
    });
    const l = await buildLedger(user, window, deps({
      prs: async () => [pr(2), pr(3), pr(4)] as never,
      // Done long before this run: a PR has no activity rule, so it stays out.
      dismissals: async () => [
        { key: 'open:pr:o/r#2', kind: 'done', until: '2026-10-18T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z' },
        { key: 'open:pr:o/r#3', kind: 'defer', until: '2026-10-13T00:00:00.000Z', createdAt: '2026-10-12T00:00:00.000Z' },
      ],
    }));
    expect(l.otherPrs.map(p => p.number)).toEqual([4]);
    expect(l.totals.prsNeedingAttention).toBe(3);
    expect(l.notes.join(' ')).toMatch(/2 PR\(s\) you marked Done or deferred are left out/);
  });

  it('carries orphaned spawns, and a note instead of failing when they cannot be read', async () => {
    const orphan = { spawnId: 's1', projectId: 'p1', workstream: 'leaf', title: 'Add tests', state: 'done', orphanedAt: '2026-10-19T10:00:00.000Z', unreadReport: true };
    expect((await buildLedger(user, window, deps({ spawnOrphans: async () => [orphan] }))).spawnOrphans).toEqual([orphan]);
    const l = await buildLedger(user, window, deps({ spawnOrphans: async () => { throw new Error('db'); } }));
    expect(l.spawnOrphans).toEqual([]);
    expect(l.notes).toContain('Orphaned spawned agents could not be read.');
    expect((await buildLedger(user, window, deps())).spawnOrphans).toBeUndefined();
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

describe('buildLedger: patterns, charts and Done/Defer', () => {
  const doneAt = '2026-10-11T00:00:00.000Z';
  const mark = (key: string, kind: 'done' | 'defer') => ({ key, kind, until: '2026-10-20T00:00:00.000Z', createdAt: doneAt });

  it('flags dismissed sessions until they do something new, and drops dismissed patterns', async () => {
    const d = deps({
      liveRows: async () => [row({}), row({ workstream: 'feat' }), row({ workstream: 'later' })],
      ownedProjects: async () => [project({ workstreams: ['main', 'feat', 'later'].map(name => ({ name, lastActiveAt: new Date('2026-10-10T00:00:00Z') })) })],
      digest: async (_h, cwd) => ({
        branch: 'main', commits: [],
        // main went quiet before the click; feat did something after it.
        transcript: { userTurns: 1, firstAt: null, lastAt: cwd.endsWith('feat') ? '2026-10-11T05:00:00.000Z' : '2026-10-10T05:00:00.000Z', lastUserPrompts: [], lastAssistantText: null, endsWithQuestion: true, todos: [] },
      }),
      contextPeaks: async () => [{ projectId: 'p1', workstream: 'main', maxTokens: 400_000 }, { projectId: 'p1', workstream: 'feat', maxTokens: 500_000 }],
      dismissals: async () => [mark('open:p1:main', 'done'), mark('open:p1:feat', 'done'), mark('open:p1:later', 'defer'), mark('pattern:big-context:p1:feat', 'defer')],
    });
    const l = await buildLedger(user, window, d);
    const by = new Map(l.sessions.map(s => [s.workstream, s.dismissed]));
    expect(Object.fromEntries(by)).toEqual({ main: true, feat: false, later: true });
    expect(l.patterns.map(p => p.id)).toEqual(['big-context:p1:main']);
  });

  it('compares activity as instants, not text: a later commit with an offset counts', async () => {
    const d = deps({
      liveRows: async () => [row({ status: 'waiting' })],
      ownedProjects: async () => [project({})],
      // 03:30-07:00 is 10:30Z, after both the click (10:00Z) and the transcript (09:00Z),
      // though "2026-10-11T03:30" sorts before "2026-10-11T09:00" as text.
      digest: async () => ({
        branch: 'main', commits: [{ sha: 'a', at: '2026-10-11T03:30:00-07:00', subject: 's' }],
        transcript: { userTurns: 1, firstAt: null, lastAt: '2026-10-11T09:00:00.000Z', lastUserPrompts: [], lastAssistantText: null, endsWithQuestion: false, todos: [] },
      }),
      dismissals: async () => [{ key: 'open:p1:main', kind: 'done', until: '2026-10-20T00:00:00.000Z', createdAt: '2026-10-11T10:00:00.000Z' }],
    });
    const l = await buildLedger(user, window, d);
    expect(l.sessions[0].dismissed).toBe(false);
  });

  it('shows everything when the marks cannot be read', async () => {
    const d = deps({
      liveRows: async () => [row({ status: 'waiting' })],
      ownedProjects: async () => [project({})],
      dismissals: async () => { throw new Error('db down'); },
    });
    const l = await buildLedger(user, window, d);
    expect(l.sessions[0].dismissed).toBe(false);
  });

  it('charts the seven days ending with the window, and the window per project', async () => {
    const d = deps({
      ownedProjects: async () => [project({})],
      worktime: async (_u, days) => days.includes('2026-10-06')
        ? [{ project: 'termag', provider: 'human', date: '2026-10-12', totalMs: 60_000, sessions: 1, instanceId: 'box1' }]
        : [{ project: 'termag', provider: 'claude', date: '2026-10-10', totalMs: 120_000, sessions: 1, instanceId: 'box1' }],
      tokensByDay: async () => [{ date: '2026-10-12', tokens: 9 }],
    });
    const l = await buildLedger(user, window, d);
    expect(l.charts.days.map(x => x.day)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
    expect(l.charts.days[6]).toMatchObject({ humanMs: 60_000, tokens: 9 });
    expect(l.charts.projects).toEqual([{ projectId: 'p1', name: 'termag', humanMs: 0, agentMs: 120_000 }]);
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
