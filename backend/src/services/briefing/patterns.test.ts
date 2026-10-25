import { describe, expect, it } from 'vitest';
import { BIG_CONTEXT_TOKENS, findPatterns, MAX_PATTERNS, type PatternInput } from './patterns';
import { buildCharts, dayKeysEnding } from './charts';
import { dismissedUntil, openKey, parseDismissInput, sessionDismissed, DismissInputError } from './dismissals';

const now = new Date('2026-10-17T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;

function input(over: Partial<PatternInput> = {}): PatternInput {
  return {
    now,
    contextPeaks: [],
    projectNames: new Map([['p1', 'termag'], ['p2', 'webapp']]),
    workstreams: [],
    prs: [],
    visits: [],
    live: [],
    ...over,
  };
}

describe('findPatterns', () => {
  it('finds nothing in a quiet fortnight', () => {
    expect(findPatterns(input())).toEqual([]);
  });

  it('names big contexts with stable ids, biggest first, and only for known projects', () => {
    const out = findPatterns(input({
      contextPeaks: [
        { projectId: 'p1', workstream: 'main', maxTokens: 387_564 },
        { projectId: 'p2', workstream: 'feat-x', maxTokens: 450_000 },
        { projectId: 'p1', workstream: 'small', maxTokens: BIG_CONTEXT_TOKENS - 1 },
        { projectId: 'gone', workstream: 'main', maxTokens: 900_000 },
      ],
    }));
    expect(out.map(p => p.id)).toEqual(['big-context:p2:feat-x', 'big-context:p1:main']);
    expect(out[1]).toMatchObject({ kind: 'big-context', projectId: 'p1', workstream: 'main' });
    expect(out[1].finding).toBe('termag peaked at 388k tokens of context in the last 14 days.');
  });

  it('puts agents left waiting first', () => {
    const out = findPatterns(input({
      contextPeaks: [{ projectId: 'p1', workstream: 'main', maxTokens: 500_000 }],
      live: [
        { projectId: 'p1', workstream: 'feat-y', connected: true, status: 'waiting', updatedAt: new Date(now.getTime() - 9 * H).toISOString() },
        { projectId: 'p2', workstream: 'main', connected: true, status: 'waiting', updatedAt: new Date(now.getTime() - 1 * H).toISOString() },
        { projectId: 'p2', workstream: 'old', connected: false, status: 'waiting', updatedAt: new Date(now.getTime() - 30 * H).toISOString() },
      ],
    }));
    expect(out[0]).toMatchObject({ id: 'waiting-long', projectId: 'p1', workstream: 'feat-y' });
    expect(out[0].finding).toMatch(/^1 agent has been waiting on you for over 8 hours: termag · feat-y\.$/);
  });

  it('reads PR lanes: undeployed merges, and branches without a PR from two up', () => {
    const out = findPatterns(input({
      prs: [
        { lane: 'merged_not_deployed', repo: 'o/termag', number: 400 },
        { lane: 'needs_pr', repo: 'o/termag', number: null, branch: 'feat-a' },
        { lane: 'needs_pr', repo: 'o/termag', number: null, branch: 'feat-b' },
        { lane: 'checks', repo: 'o/termag', number: 12 },
      ],
    }));
    expect(out.map(p => p.id)).toEqual(['undeployed-merges', 'branches-without-pr']);
    expect(out[0].finding).toBe('1 merged PR is not deployed yet: o/termag#400.');
    expect(out[1].finding).toBe('2 branches have pushed work and no PR: feat-a, feat-b.');
    expect(findPatterns(input({ prs: null }))).toEqual([]);
  });

  it('counts switches per active day', () => {
    const visits = [];
    for (const day of ['2026-10-15', '2026-10-16']) {
      for (let i = 0; i < 30; i++) visits.push({ projectId: i % 2 ? 'p1' : 'p2', previousProjectId: i % 2 ? 'p2' : 'p1', timestamp: new Date(`${day}T10:${String(i).padStart(2, '0')}:00Z`) });
    }
    const out = findPatterns(input({ visits }));
    expect(out.map(p => p.id)).toEqual(['many-switches']);
    expect(out[0].finding).toMatch(/about 30 times a day over 2 active days/);
    expect(findPatterns(input({ visits: visits.slice(0, 30) }))).toEqual([]);
  });

  it('lists stale workstreams from three up, never main', () => {
    const old = new Date(now.getTime() - 8 * D);
    const ws = ['a', 'b', 'main'].map(name => ({ projectId: 'p1', name, lastActiveAt: old }));
    expect(findPatterns(input({ workstreams: ws }))).toEqual([]);
    const out = findPatterns(input({ workstreams: [...ws, { projectId: 'p2', name: 'c', lastActiveAt: old }, { projectId: 'p2', name: 'fresh', lastActiveAt: now }] }));
    expect(out[0].finding).toBe('3 workstreams have not been touched in over a week and are not archived: termag · a, termag · b, webapp · c.');
  });

  it('caps the list', () => {
    const peaks = Array.from({ length: 12 }, (_, i) => ({ projectId: 'p1', workstream: `w${i}`, maxTokens: 400_000 + i }));
    expect(findPatterns(input({ contextPeaks: peaks })).length).toBeLessThanOrEqual(MAX_PATTERNS);
  });
});

describe('buildCharts', () => {
  it('lists the last seven days oldest first, splitting you from the agents', () => {
    const days = dayKeysEnding('2026-10-17');
    expect(days).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
    const c = buildCharts({
      days,
      worktime: [
        { date: '2026-10-17', provider: 'human', totalMs: 2 * H, projectId: 'p1' },
        { date: '2026-10-17', provider: 'claude', totalMs: 3 * H, projectId: 'p1' },
        { date: '2026-10-01', provider: 'claude', totalMs: 9 * H, projectId: 'p1' },
      ],
      tokensByDay: [{ date: '2026-10-16', tokens: 1000 }],
      windowWorktime: [
        { provider: 'human', totalMs: 1 * H, projectId: 'p2' },
        { provider: 'claude', totalMs: 3 * H, projectId: 'p1' },
        { provider: 'claude', totalMs: 5 * H, projectId: 'gone' },
        { provider: 'claude', totalMs: 5 * H, projectId: null },
      ],
      projectNames: new Map([['p1', 'termag'], ['p2', 'webapp']]),
    });
    expect(c.days).toHaveLength(7);
    expect(c.days[6]).toEqual({ day: '2026-10-17', humanMs: 2 * H, agentMs: 3 * H, tokens: 0 });
    expect(c.days[5].tokens).toBe(1000);
    expect(c.projects.map(p => p.name)).toEqual(['termag', 'webapp']);
  });
});

describe('dismissals', () => {
  it('keys items by session, or by PR when none', () => {
    expect(openKey('p1', null, null)).toBe('open:p1:main');
    expect(openKey('p1', 'feat', 'o/r#1')).toBe('open:p1:feat');
    expect(openKey(null, null, 'o/r#1')).toBe('open:pr:o/r#1');
    expect(openKey(null, null, null)).toBeNull();
  });

  it('parses only briefing keys and two actions', () => {
    expect(parseDismissInput({ key: 'pattern:big-context:p1:main', action: 'done' })).toEqual({ key: 'pattern:big-context:p1:main', action: 'done' });
    expect(parseDismissInput({ key: 'open:pr:o/r#1', action: 'defer' }).key).toBe('open:pr:o/r#1');
    expect(parseDismissInput({ key: 'pattern:big-context:p1:feat/x', action: 'done' }).key).toBe('pattern:big-context:p1:feat/x');
    expect(() => parseDismissInput({ key: 'o/r#1', action: 'done' })).toThrow(DismissInputError);
    expect(() => parseDismissInput({ key: 'pattern:x y', action: 'done' })).toThrow(DismissInputError);
    expect(() => parseDismissInput({ key: 'pattern:x', action: 'later' })).toThrow(DismissInputError);
  });

  it('defers a day, and a day more from a running deferral; done spans 14 or 7 days', () => {
    expect(dismissedUntil('pattern:x', 'defer', null, now).getTime()).toBe(now.getTime() + D);
    const running = { kind: 'defer', until: new Date(now.getTime() + 5 * H) };
    expect(dismissedUntil('pattern:x', 'defer', running, now).getTime()).toBe(now.getTime() + 5 * H + D);
    expect(dismissedUntil('pattern:x', 'done', running, now).getTime()).toBe(now.getTime() + 14 * D);
    expect(dismissedUntil('open:p1:main', 'done', null, now).getTime()).toBe(now.getTime() + 7 * D);
  });

  it('keeps a done session out until it does something new', () => {
    const done = { key: 'open:p1:main', kind: 'done' as const, until: new Date(now.getTime() + D).toISOString(), createdAt: '2026-10-17T10:00:00.000Z' };
    expect(sessionDismissed(done, '2026-10-17T09:00:00.000Z', now)).toBe(true);
    expect(sessionDismissed(done, null, now)).toBe(true);
    expect(sessionDismissed(done, '2026-10-17T11:00:00.000Z', now)).toBe(false);
    expect(sessionDismissed({ ...done, kind: 'defer' }, '2026-10-17T11:00:00.000Z', now)).toBe(true);
    expect(sessionDismissed({ ...done, until: '2026-10-17T11:00:00.000Z' }, null, now)).toBe(false);
    expect(sessionDismissed(undefined, null, now)).toBe(false);
  });
});
