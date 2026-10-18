import { describe, expect, it } from 'vitest';
import { lobbyPills, prCount, workstreamKey, type PrLaneId, type PrRow, type PrsResponse } from './prs.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const WS = { projectId: 'p1', workstream: 'main' };
const KEY = workstreamKey('p1', 'main');

function row(over: Partial<PrRow>): PrRow {
  return {
    kind: 'pr', lane: 'checks', repo: 'example-org/termag', number: 1, title: 't', url: 'https://github.com/example-org/termag/pull/1',
    headRefName: 'feat/x', baseRefName: 'main', badges: [], failingChecks: [], mergedAt: null, workstream: WS, ...over,
  };
}
function res(rows: PrRow[], extra: Partial<Extract<PrsResponse, { connected: true }>> = {}): PrsResponse {
  const lanes = new Map<PrLaneId, PrRow[]>();
  for (const r of rows) lanes.set(r.lane, [...(lanes.get(r.lane) ?? []), r]);
  return { connected: true, lanes: [...lanes].map(([id, rs]) => ({ id, rows: rs })), ...extra };
}

describe('lobbyPills', () => {
  it('gives a workstream its live PRs, most pressing first, without the past ones', () => {
    const pills = lobbyPills(res([
      row({ number: 5, lane: 'needs_approval' }),
      row({ number: 6, lane: 'ready_to_merge' }),
      row({ number: 7, failingChecks: ['ci'] }),
      row({ number: 2, lane: 'deployed', mergedAt: '2026-10-10T00:00:00Z' }),
    ]), NOW).get(KEY)!;
    expect(pills.map(p => `${p.label}:${p.tone}`)).toEqual(['#7:bad', '#6:good', '#5:wait']);
  });

  it('keeps the newest past PR when that is all a workstream has', () => {
    const pills = lobbyPills(res([
      row({ number: 2, lane: 'deployed', mergedAt: '2026-10-10T00:00:00Z' }),
      row({ number: 3, lane: 'merged', mergedAt: '2026-10-12T00:00:00Z' }),
    ], { earlier: [{ repo: 'example-org/termag', number: 1, workstream: WS, at: '2026-10-01T00:00:00Z' }] }), NOW).get(KEY)!;
    expect(pills).toEqual([{ key: 'example-org/termag#3', label: '#3', tone: 'past', url: 'https://github.com/example-org/termag/pull/1' }]);
  });

  it('falls back to an earlier stored link, linking to GitHub', () => {
    const pills = lobbyPills(res([], { earlier: [{ repo: 'example-org/termag', number: 9, workstream: WS, at: null }] }), NOW).get(KEY)!;
    expect(pills).toEqual([{ key: 'example-org/termag#9', label: '#9', tone: 'past', url: 'https://github.com/example-org/termag/pull/9' }]);
  });

  it('gives a pushed branch a "no PR" pill that opens the compare page', () => {
    const [p] = lobbyPills(res([row({ kind: 'branch', lane: 'needs_pr', number: null, url: null })]), NOW).get(KEY)!;
    expect(p).toMatchObject({ label: 'no PR', tone: 'branch', url: 'https://github.com/example-org/termag/compare/main...feat/x?expand=1' });
  });

  it('skips in-progress branches, unlinked rows and a disconnected pipeline', () => {
    expect(lobbyPills(res([row({ kind: 'branch', lane: 'in_progress', number: null }), row({ workstream: null })]), NOW).size).toBe(0);
    expect(lobbyPills({ connected: false }, NOW).size).toBe(0);
    expect(lobbyPills(null, NOW).size).toBe(0);
  });

  it('never shows a deferred PR as yours to act on', () => {
    const r = row({ number: 4, badges: ['changes-requested'] });
    expect(lobbyPills(res([r]), NOW).get(KEY)![0].tone).toBe('act');
    const deferred = res([r], { deferred: [{ key: 'example-org/termag#4', until: '2026-10-18T00:00:00Z' }] });
    expect(lobbyPills(deferred, NOW).get(KEY)![0].tone).toBe('wait');
  });
});

describe('prCount', () => {
  it('counts what needs the user, not what waits on others, and not deferred rows', () => {
    const r = res([
      row({ number: 1, lane: 'needs_my_review' }),
      row({ number: 2, lane: 'ready_to_merge' }),
      row({ number: 3, failingChecks: ['ci'] }),
      row({ number: 4, failingChecks: ['ci'], badges: ['draft'] }),
      row({ number: 5, lane: 'needs_approval' }),
      row({ number: 6, lane: 'merged_not_deployed' }),
    ], { deferred: [{ key: 'example-org/termag#2', until: '2026-10-18T00:00:00Z' }, { key: 'example-org/termag#1', until: '2026-10-01T00:00:00Z' }] });
    expect(prCount(r, NOW)).toBe(2);
    expect(prCount({ connected: false }, NOW)).toBe(0);
  });
});
