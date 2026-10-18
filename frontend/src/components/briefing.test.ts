import { describe, expect, it } from 'vitest';
import type { BriefingLatest, BriefingView } from '../services/api';
import {
  cardState, openCount, pendingProblem, pollInterval, POLL_IDLE_MS, POLL_RUNNING_MS,
  sessionHref, sessionLabel, statTiles, windowHeading, windowLabel, finishedLabel,
} from './briefing';

function view(over: Partial<BriefingView> = {}): BriefingView {
  return {
    id: 'b1', trigger: 'manual', status: 'done', error: null,
    window: { since: '2026-10-09T16:05:00Z', until: '2026-10-12T07:00:00Z', tz: 'UTC', label: 'Fri 9 Oct 16:05 to Mon 12 Oct 07:00 (2 days 14 hours)' },
    boxName: 'box-1', content: { summary: 's', carryovers: [], suggestions: [] }, stats: null,
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
  it('counts carry-overs of the latest only', () => {
    expect(openCount(null)).toBe(0);
    const c = { summary: '', suggestions: [], carryovers: [{ projectId: null, workstream: null, kind: 'action' as const, title: 't', detail: 'd', evidence: 'git' as const }] };
    expect(openCount({ latest: view({ content: c }), pending: null })).toBe(1);
  });
});

describe('finishedLabel', () => {
  it('writes the finish time in the briefing zone', () => {
    const w = { since: '', until: '', tz: 'America/New_York', label: '' };
    expect(finishedLabel({ finishedAt: '2026-10-12T14:05:00Z', window: w }, 'en-GB')).toMatch(/10:05/);
    expect(finishedLabel({ finishedAt: null, window: w })).toBeNull();
  });
});
