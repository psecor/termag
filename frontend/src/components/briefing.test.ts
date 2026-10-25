import { describe, expect, it } from 'vitest';
import type { BriefingLatest, BriefingView } from '../services/api';
import {
  activeMarks, cardState, groupWorkedOn, markLabel, openCount, overlayMarks, pendingProblem, pollInterval, POLL_IDLE_MS, POLL_RUNNING_MS,
  prHref, prLabel, sessionHref, sessionLabel, splitMarked, statTiles, windowHeading, windowLabel, finishedLabel,
} from './briefing';

function view(over: Partial<BriefingView> = {}): BriefingView {
  return {
    id: 'b1', trigger: 'manual', status: 'done', error: null,
    window: { since: '2026-10-09T16:05:00Z', until: '2026-10-12T07:00:00Z', tz: 'UTC', label: 'Fri 9 Oct 16:05 to Mon 12 Oct 07:00 (2 days 14 hours)' },
    boxName: 'box-1', content: { version: 2, headline: 's', workedOn: [], leftOpen: [], workBetter: [] }, stats: null, charts: null,
    projects: { p1: { name: 'termag', archived: false } },
    createdAt: '2026-10-12T07:00:00Z', finishedAt: '2026-10-12T07:01:00Z',
    ...over,
  };
}

describe('cardState', () => {
  it('is loading before the first answer', () => expect(cardState(null)).toBe('loading'));
  it('is never with nothing at all', () => expect(cardState({ latest: null, pending: null })).toBe('never'));
  it('is running while the pending row runs, even with a latest', () => {
    expect(cardState({ latest: view(), pending: view({ id: 'b2', status: 'running' }) })).toBe('running');
    expect(cardState({ latest: null, pending: view({ status: 'running' }) })).toBe('running');
  });
  it('is ready with a latest, or with only a failed pending', () => {
    expect(cardState({ latest: view(), pending: null })).toBe('ready');
    expect(cardState({ latest: null, pending: view({ status: 'skipped', error: 'no box' }) })).toBe('ready');
  });
});

describe('pollInterval', () => {
  it('polls fast only while running', () => {
    expect(pollInterval('running')).toBe(POLL_RUNNING_MS);
    expect(pollInterval('ready')).toBe(POLL_IDLE_MS);
    expect(pollInterval('never')).toBe(POLL_IDLE_MS);
  });
});

describe('pendingProblem', () => {
  const base: BriefingLatest = { latest: view(), pending: null };
  it('is null without a problem', () => {
    expect(pendingProblem(null)).toBeNull();
    expect(pendingProblem(base)).toBeNull();
    expect(pendingProblem({ ...base, pending: view({ status: 'running' }) })).toBeNull();
  });
  it('names a skip and a failure with their reason', () => {
    expect(pendingProblem({ ...base, pending: view({ status: 'skipped', error: 'no box is ready' }) }))
      .toBe('The last briefing was skipped: no box is ready');
    expect(pendingProblem({ ...base, pending: view({ status: 'failed', error: null }) })).toBe('The last briefing failed.');
  });
});

describe('window label', () => {
  it('uses the server label', () => {
    expect(windowHeading(view())).toBe('Since your last briefing · Fri 9 Oct 16:05 to Mon 12 Oct 07:00 (2 days 14 hours)');
    expect(windowHeading({ ...view(), window: { ...view().window, basis: 'first' } })).toMatch(/^Since the start of yesterday · /);
    expect(windowHeading({ ...view(), window: { ...view().window, basis: 'stale' } })).toMatch(/^Since the start of yesterday · /);
    expect(windowHeading({ ...view(), window: { ...view().window, basis: 'capped' } })).toMatch(/^The last 7 days · /);
  });
  it('falls back to since → until', () => {
    const l = windowLabel({ since: '2026-10-09T16:05:00Z', until: '2026-10-12T07:00:00Z', tz: 'UTC', label: '' }, 'en-GB');
    expect(l).toContain(' to ');
    expect(l).toContain('16:05');
    expect(l).toContain('07:00');
  });
  it('survives a bad timezone', () => {
    expect(windowLabel({ since: '2026-10-09T16:05:00Z', until: '2026-10-12T07:00:00Z', tz: 'Not/AZone', label: '' })).toContain(' to ');
  });
});

describe('sessionHref / sessionLabel', () => {
  const projects = { p1: { name: 'termag', archived: false } };
  it('links known projects, main without a ws param', () => {
    expect(sessionHref('p1', 'main', projects)).toBe('/?project=p1');
    expect(sessionHref('p1', 'feat/x', projects)).toBe('/?project=p1&ws=feat%2Fx');
    expect(sessionHref('p1', null, projects, 'mobile')).toBe('/m/p/p1');
    expect(sessionHref('p1', 'feat/x', projects, 'mobile')).toBe('/m/p/p1?ws=feat%2Fx');
  });
  it('does not link unknown or missing projects', () => {
    expect(sessionHref(null, 'main', projects)).toBeNull();
    expect(sessionHref('gone', 'main', projects)).toBeNull();
  });
  it('labels with the workstream unless main', () => {
    expect(sessionLabel('p1', 'main', projects)).toBe('termag');
    expect(sessionLabel('p1', 'ws', projects)).toBe('termag · ws');
    expect(sessionLabel('x', 'ws', projects)).toBeNull();
  });
});

describe('statTiles / openCount', () => {
  it('is empty without stats', () => expect(statTiles(null)).toEqual([]));
  it('formats the six tiles', () => {
    const t = statTiles({ agentMs: 3_900_000, humanMs: 600_000, tokens: 1, sessionsTouched: 4, switches: 2, waitingNow: 1, prsNeedingAttention: 3, keptCheckouts: 0, offlineBoxes: 0 });
    expect(t.map(x => x.id)).toEqual(['agent', 'human', 'sessions', 'waiting', 'prs', 'kept']);
    expect(t[0].value).toBe('1h5');
    expect(t[1].value).toBe('10m');
  });
  it('counts what the latest left open, less what was marked', () => {
    expect(openCount(null)).toBe(0);
    const item = (key: string | null) => ({ key, projectId: null, workstream: null, kind: 'action' as const, title: 't', detail: 'd', evidence: 'git' as const, pr: null });
    const c = { version: 2 as const, headline: '', workedOn: [], workBetter: [], leftOpen: [item('open:p1:main'), item('open:p1:feat'), item(null)] };
    expect(openCount({ latest: view({ content: c }), pending: null })).toBe(3);
    const marks = [{ key: 'open:p1:main', kind: 'defer' as const, until: '2026-10-18T00:00:00Z', createdAt: '' }, { key: 'open:p1:feat', kind: 'done' as const, until: '2026-10-01T00:00:00Z', createdAt: '' }];
    expect(openCount({ latest: view({ content: c }), pending: null, dismissals: marks }, Date.parse('2026-10-17T00:00:00Z'))).toBe(2);
  });
});

describe('finishedLabel', () => {
  it('writes the finish time in the briefing zone', () => {
    const w = { since: '', until: '', tz: 'America/New_York', label: '' };
    expect(finishedLabel({ finishedAt: '2026-10-12T14:05:00Z', window: w }, 'en-GB')).toMatch(/10:05/);
    expect(finishedLabel({ finishedAt: null, window: w })).toBeNull();
  });
});

describe('items and marks', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const marks = activeMarks([
    { key: 'pattern:a', kind: 'defer', until: '2026-10-18T12:00:00Z', createdAt: '' },
    { key: 'pattern:b', kind: 'done', until: '2026-10-31T12:00:00Z', createdAt: '' },
    { key: 'pattern:old', kind: 'defer', until: '2026-10-16T12:00:00Z', createdAt: '' },
  ], now);

  it('keeps only running marks, and splits items by them in order', () => {
    expect([...marks.keys()]).toEqual(['pattern:a', 'pattern:b']);
    const s = splitMarked([{ key: 'pattern:old' }, { key: 'pattern:a' }, { key: null }, { key: 'pattern:b' }], marks);
    expect(s.shown.map(x => x.key)).toEqual(['pattern:old', null]);
    expect(s.hidden.map(x => [x.key, x.mark.kind])).toEqual([['pattern:a', 'defer'], ['pattern:b', 'done']]);
  });

  it('lets a Done item back in a briefing written after the click', () => {
    const done = activeMarks([{ key: 'open:p1:main', kind: 'done', until: '2026-10-20T00:00:00Z', createdAt: '2026-10-17T09:00:00Z' }], now);
    const items = [{ key: 'open:p1:main' }];
    expect(splitMarked(items, done, '2026-10-17T08:00:00Z').hidden).toHaveLength(1);
    expect(splitMarked(items, done, '2026-10-18T08:00:00Z').shown).toHaveLength(1);
    const deferred = activeMarks([{ key: 'open:p1:main', kind: 'defer', until: '2026-10-18T12:00:00Z', createdAt: '2026-10-17T09:00:00Z' }], now);
    expect(splitMarked(items, deferred, '2026-10-18T08:00:00Z').hidden).toHaveLength(1);
  });

  it('keeps a Done PR-only item or pattern hidden in later briefings', () => {
    const marks2 = activeMarks([
      { key: 'open:pr:o/r#2', kind: 'done', until: '2026-10-24T00:00:00Z', createdAt: '2026-10-17T09:00:00Z' },
      { key: 'pattern:many-switches', kind: 'done', until: '2026-10-31T00:00:00Z', createdAt: '2026-10-17T09:00:00Z' },
    ], now);
    const s = splitMarked([{ key: 'open:pr:o/r#2' }, { key: 'pattern:many-switches' }], marks2, '2026-10-18T08:00:00Z');
    expect(s.shown).toEqual([]);
    expect(s.hidden).toHaveLength(2);
  });

  it('keeps a click over a poll that left before it was saved', () => {
    const server = [{ key: 'pattern:a', kind: 'defer' as const, until: '2026-10-18T12:00:00Z', createdAt: '' }];
    const done = { key: 'pattern:b', kind: 'done' as const, until: '2026-10-31T12:00:00Z', createdAt: '' };
    const overrides = [{ key: 'pattern:b', mark: done, settledAt: 2000 }, { key: 'pattern:a', mark: null, settledAt: null }];
    // Poll left at 1000, before the save at 2000: both clicks still show.
    expect(overlayMarks(server, overrides, 1000).map(m => m.key)).toEqual(['pattern:b']);
    // A poll that left after the save is the truth for that key; the unsaved Bring back still applies.
    expect(overlayMarks(server, overrides, 3000).map(m => m.key)).toEqual([]);
    expect(overlayMarks([...server, done], overrides, 3000).map(m => m.key)).toEqual(['pattern:b']);
  });

  it('says when a mark lets its item back', () => {
    expect(markLabel(marks.get('pattern:a')!, now)).toBe('back in 24h');
    expect(markLabel(marks.get('pattern:b')!, now)).toBe('done');
  });

  it('links PR refs', () => {
    expect(prHref('o/termag#12')).toBe('https://github.com/o/termag/pull/12');
    expect(prHref('#12')).toBeNull();
    expect(prLabel('o/termag#12')).toBe('#12');
  });

  it('groups Worked on by session, in order', () => {
    const projects = { p1: { name: 'termag', archived: false } };
    const g = groupWorkedOn([
      { projectId: 'p1', workstream: 'main', text: 'a', prs: [] },
      { projectId: null, workstream: null, text: 'b', prs: [] },
      { projectId: 'p1', workstream: 'main', text: 'c', prs: [] },
      { projectId: 'p1', workstream: 'feat', text: 'd', prs: [] },
    ], projects);
    expect(g.map(x => [x.label, x.items.map(i => i.text).join('')])).toEqual([['termag', 'ac'], [null, 'b'], ['termag · feat', 'd']]);
  });

  it('keeps two projects with the same name apart', () => {
    const projects = { p1: { name: 'termag', archived: false }, p2: { name: 'termag', archived: false } };
    const g = groupWorkedOn([
      { projectId: 'p1', workstream: 'main', text: 'a', prs: [] },
      { projectId: 'p2', workstream: 'main', text: 'b', prs: [] },
      { projectId: 'p1', workstream: null, text: 'c', prs: [] },
    ], projects);
    expect(g.map(x => [x.projectId, x.items.map(i => i.text).join('')])).toEqual([['p1', 'ac'], ['p2', 'b']]);
  });
});
