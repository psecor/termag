import { describe, it, expect } from 'vitest';
import type { PrLane, PrPipelineResponse, PrRow } from '../services/api';
import { isPrsView } from './prPipeline';
import { phonePillTarget, phonePills, pillTarget, pillTone, provisionalPill, withProvisional, worktreeKey, worktreePills, type WorktreePill } from './worktreePrs';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const WS = { projectId: 'p1', projectName: 'termag', workstream: 'termag-pr-defer' };

function row(over: Partial<PrRow>): PrRow {
  return {
    kind: 'pr', lane: 'checks', repo: 'example-org/termag', number: 1, title: 't', url: 'u', author: 'me',
    headRefName: 'feat', baseRefName: 'main', at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [],
    blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: WS, requestedAt: null, reviewTarget: null,
    ...over,
  };
}

const lane = (id: PrLane['id'], rows: PrRow[] = []): PrLane => ({ id, label: id, rows });
const res = (lanes: PrLane[], deferred: { key: string; until: string }[] = []): Extract<PrPipelineResponse, { connected: true }> => ({
  connected: true, viewer: 'me', lanes, prod: { sha: null, source: 'unknown' }, boxes: 0, fetchedAt: '', notes: [], deferred,
});

describe('worktreePills', () => {
  it('gives each linked workstream its PRs, most pressing first', () => {
    const pills = worktreePills(res([
      lane('needs_approval', [row({ lane: 'needs_approval', number: 7 })]),
      lane('checks', [row({ number: 9, failingChecks: ['ci'] })]),
      lane('merged_not_deployed', [row({ lane: 'merged_not_deployed', number: 5 })]),
    ]), NOW).get(worktreeKey('p1', 'termag-pr-defer'))!;
    expect(pills.map(p => [p.label, p.tone, p.view])).toEqual([
      ['#9', 'bad', 'checks'], ['#7', 'wait', 'needs_approval'], ['#5', 'merged', 'merged_not_deployed'],
    ]);
    expect(pills[0].key).toBe('example-org/termag#9');
  });
  it('drops unpushed branches and unlinked rows', () => {
    const pills = worktreePills(res([
      lane('in_progress', [row({ kind: 'branch', lane: 'in_progress', number: null })]),
      lane('checks', [row({ number: 8, workstream: null })]),
    ]), NOW);
    expect(pills.size).toBe(0);
  });
  it('puts deployed, merged and earlier PRs last as past pills, newest first, a few at most', () => {
    const r = res([
      lane('checks', [row({ number: 9 })]),
      lane('deployed', [row({ lane: 'deployed', number: 3, mergedAt: '2026-10-13T00:00:00Z' })]),
      lane('merged', [row({ lane: 'merged', number: 4, mergedAt: '2026-10-14T00:00:00Z' })]),
    ]);
    const earlier = [10, 11, 12, 13, 14].map((n, i) => ({ repo: 'example-org/termag', number: n, workstream: WS, at: `2026-10-0${i + 1}T00:00:00Z` }));
    const pills = worktreePills({ ...r, earlier: [...earlier, { repo: 'example-org/termag', number: 9, workstream: WS, at: '2026-10-09T00:00:00Z' }] }, NOW)
      .get(worktreeKey('p1', 'termag-pr-defer'))!;
    expect(pills.map(p => [p.label, p.tone])).toEqual([
      ['#9', 'wait'], ['#4', 'past'], ['#3', 'past'], ['#14', 'past'], ['#13', 'past'], ['#12', 'past'],
    ]);
    const old = pills.find(p => p.label === '#14')!;
    expect(old).toMatchObject({ view: null, href: 'https://github.com/example-org/termag/pull/14' });
    expect(pills.find(p => p.label === '#3')!.view).not.toBeNull();
  });
  it('shows a just-opened PR as live, not as its own grey past pill (Bugbot)', () => {
    const listed = worktreePills({ ...res([]), earlier: [{ repo: 'example-org/termag', number: 363, workstream: WS, at: null }] }, NOW).get(worktreeKey('p1', 'termag-pr-defer'))!;
    const m = { kind: 'pr_created' as const, url: 'https://github.com/example-org/termag/pull/363', at: '2026-10-14T11:55:00Z', contextTokens: null };
    const fresh = provisionalPill(m, listed, NOW);
    expect(fresh).not.toBeNull();
    expect(withProvisional(listed, fresh).map(p => [p.label, p.tone])).toEqual([['#363', 'wait']]);
  });
  it('keeps a past pill behind a just-opened one', () => {
    const listed = worktreePills({ ...res([]), earlier: [{ repo: 'example-org/termag', number: 5, workstream: WS, at: null }] }, NOW).get(worktreeKey('p1', 'termag-pr-defer'))!;
    const m = { kind: 'pr_created' as const, url: 'https://github.com/example-org/termag/pull/363', at: '2026-10-14T11:55:00Z', contextTokens: null };
    expect(withProvisional(listed, provisionalPill(m, listed, NOW)).map(p => p.label)).toEqual(['#363', '#5']);
  });
  it('shows a pushed branch without a PR as a hollow pill', () => {
    const [p] = worktreePills(res([lane('needs_pr', [row({ kind: 'branch', lane: 'needs_pr', number: null, headRefName: 'feat/x' })])]), NOW)
      .get(worktreeKey('p1', 'termag-pr-defer'))!;
    expect(p).toMatchObject({ label: 'no PR', tone: 'branch', key: 'example-org/termag:feat/x' });
  });
  it('is empty when GitHub is not connected', () => {
    expect(worktreePills({ connected: false }, NOW).size).toBe(0);
    expect(worktreePills(null, NOW).size).toBe(0);
  });
  it('does not call a deferred row yours to act on', () => {
    const r = row({ lane: 'checks', number: 2, badges: ['changes-requested'] });
    const until = new Date(NOW + 3_600_000).toISOString();
    const [p] = worktreePills(res([lane('checks', [r])], [{ key: 'example-org/termag#2', until }]), NOW).get(worktreeKey('p1', 'termag-pr-defer'))!;
    expect(p.tone).toBe('wait');
    expect(p.title).toContain('deferred');
  });
  it('marks a deferred branch row too', () => {
    const r = row({ kind: 'branch', lane: 'needs_pr', number: null, headRefName: 'feat/x' });
    const until = new Date(NOW + 3_600_000).toISOString();
    const [p] = worktreePills(res([lane('needs_pr', [r])], [{ key: 'example-org/termag:feat/x', until }]), NOW).get(worktreeKey('p1', 'termag-pr-defer'))!;
    expect(p.title).toContain('deferred');
  });
  it('only ever opens the overlay on a view it has', () => {
    const lanes = (['needs_pr', 'checks', 'needs_approval', 'needs_my_review', 'ready_to_merge', 'merged_not_deployed'] as const)
      .map((id, i) => lane(id, [row({ lane: id, number: 10 + i, workstream: { ...WS, workstream: `w${i}` } })]));
    const pills = [...worktreePills(res(lanes), NOW).values()].flat();
    expect(pills).toHaveLength(6);
    expect(pills.every(p => p.view !== null && isPrsView(p.view))).toBe(true);
  });
});

describe('pillTone', () => {
  it('reads the lane and its badges', () => {
    expect(pillTone(row({ lane: 'ready_to_merge' }), false)).toBe('good');
    expect(pillTone(row({ lane: 'ready_to_merge', badges: ['conflict'] }), false)).toBe('act');
    expect(pillTone(row({ lane: 'needs_my_review' }), false)).toBe('act');
    expect(pillTone(row({ lane: 'checks', failingChecks: ['ci'], badges: ['draft'] }), false)).toBe('wait');
    expect(pillTone(row({ lane: 'checks', pendingChecks: ['ci'] }), false)).toBe('wait');
    expect(pillTone(row({ lane: 'deployed' }), false)).toBe('past');
  });
});

describe('provisionalPill', () => {
  const m = { kind: 'pr_created' as const, url: 'https://github.com/example-org/termag/pull/363', at: '2026-10-14T11:55:00Z', contextTokens: null };
  it('shows a just-opened PR the pipeline has not listed yet, linking to GitHub', () => {
    expect(provisionalPill(m, [], NOW)).toMatchObject({ label: '#363', view: null, href: m.url });
  });
  it('steps aside once the pipeline lists it', () => {
    const listed = worktreePills(res([lane('checks', [row({ number: 363 })])]), NOW).get(worktreeKey('p1', 'termag-pr-defer'))!;
    expect(provisionalPill(m, listed, NOW)).toBeNull();
  });
  it('ignores merges, missing URLs and old milestones', () => {
    expect(provisionalPill({ ...m, kind: 'pr_merged' }, [], NOW)).toBeNull();
    expect(provisionalPill({ ...m, url: null }, [], NOW)).toBeNull();
    expect(provisionalPill({ ...m, at: '2026-10-14T11:00:00Z' }, [], NOW)).toBeNull();
    expect(provisionalPill(null, [], NOW)).toBeNull();
  });
});

describe('withProvisional and pillTarget', () => {
  const m = { kind: 'pr_created' as const, url: 'https://github.com/example-org/termag/pull/363', at: '2026-10-14T11:55:00Z', contextTokens: null };
  it('keeps an amber or red pill in front of a just-opened one', () => {
    const listed = worktreePills(res([lane('checks', [row({ number: 9, failingChecks: ['ci'] })])]), NOW).get(worktreeKey('p1', 'termag-pr-defer'))!;
    expect(withProvisional(listed, provisionalPill(m, listed, NOW)).map(p => p.label)).toEqual(['#9', '#363']);
    expect(withProvisional(listed, null)).toBe(listed);
  });
  it('opens the overlay on a listed pill, keeping the page parameters, and GitHub for a provisional one', () => {
    const [p] = worktreePills(res([lane('checks', [row({ number: 9 })])]), NOW).get(worktreeKey('p1', 'termag-pr-defer'))!;
    expect(pillTarget(p, '?project=p1&ws=w')).toEqual({ search: '?project=p1&ws=w&prs=checks&pr=example-org%2Ftermag%239' });
    expect(pillTarget(provisionalPill(m, [], NOW)!, '')).toEqual({ href: m.url });
  });
});

describe('phonePills', () => {
  const pill = (label: string, tone: WorktreePill['tone']): WorktreePill => ({ key: label, label, tone, title: '', view: null, href: null });
  it('drops the past pills when a live one is there', () => {
    expect(phonePills([pill('#2', 'act'), pill('#3', 'wait'), pill('#1', 'past')]).map(p => p.label)).toEqual(['#2', '#3']);
  });
  it('keeps the newest past pill when it is all the workstream has', () => {
    expect(phonePills([pill('#5', 'past'), pill('#4', 'past')]).map(p => p.label)).toEqual(['#5']);
    expect(phonePills([])).toEqual([]);
  });
});

describe('phonePillTarget', () => {
  const pill = (o: Partial<WorktreePill> = {}): WorktreePill => ({ key: 'k', label: '#1', tone: 'wait', title: '', view: 'checks', href: null, ...o });
  it('opens the overview for a listed PR', () => {
    const r = row({ number: 9 });
    expect(phonePillTarget(pill(), r)).toEqual({ overview: r });
  });
  it('does not open an overview for a PR row the list would not either (hasOverview)', () => {
    expect(phonePillTarget(pill({ href: 'https://github.com/o/r/pull/9' }), row({ number: 9, repo: null }))).not.toHaveProperty('overview');
  });
  it('opens the compare page for a pushed branch, or its branch page without one', () => {
    const b = row({ kind: 'branch', lane: 'needs_pr', number: null, headRefName: 'feat/x' });
    expect(phonePillTarget(pill(), b)).toEqual({ href: 'https://github.com/example-org/termag/compare/main...feat/x?expand=1' });
    expect(phonePillTarget(pill(), { ...b, baseRefName: '' })).toEqual({ href: 'https://github.com/example-org/termag/tree/feat%2Fx' });
    expect(phonePillTarget(pill(), { ...b, repo: null })).toBeNull();
  });
  it('opens GitHub for a pill the lanes do not list', () => {
    expect(phonePillTarget(pill({ view: null, href: 'https://github.com/o/r/pull/3' }), null)).toEqual({ href: 'https://github.com/o/r/pull/3' });
    expect(phonePillTarget(pill(), null)).toBeNull();
  });
});
