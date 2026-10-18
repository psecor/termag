import { describe, it, expect } from 'vitest';
import type { PrLane, PrRow } from '../services/api';
import { actionableCount, hasOverview, bakePending, boxesBehindText, deferrals, deferredText, splitDeferred, viewEntries, isPrsView, needsYou, needsYouRows, prsSearch, rowParam, canSubmitReview, checksSummary, compareUrl, deployStage, firstNonEmpty, laneTabLabel, mention, mergeReadiness, PHONE_LANE_ORDER, pingText, reviewerRoster, reviewStateLabel, rowDetail, rowLabel, rowAction } from './prPipeline';

const NOW = Date.parse('2026-10-09T12:00:00Z');

function row(over: Partial<PrRow>): PrRow {
  return {
    kind: 'pr', lane: 'checks', repo: 'example-org/termag', number: 1, title: 't', url: 'u', author: 'me',
    headRefName: 'feat', baseRefName: 'main', at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [],
    blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null,
    ...over,
  };
}

const lane = (id: PrLane['id'], rows: PrRow[] = []): PrLane => ({ id, label: id, rows });

describe('rowDetail', () => {
  it('names failing checks before running ones', () => {
    expect(rowDetail(row({ failingChecks: ['Bugbot'], pendingChecks: ['ci'] }), NOW)).toBe('failing: Bugbot');
    expect(rowDetail(row({ pendingChecks: ['a', 'b', 'c', 'd'] }), NOW)).toBe('running: a, b, c +1');
  });
  it('says who a review is from and when it was asked', () => {
    expect(rowDetail(row({ lane: 'needs_my_review', author: 'alice', requestedAt: '2026-10-09T10:00:00Z' }), NOW)).toBe('by alice · asked 2h ago');
  });
  it('describes deploy states', () => {
    const merged = { mergedAt: '2026-10-09T09:00:00Z' };
    expect(rowDetail(row({ lane: 'merged_not_deployed', ...merged, deploy: { state: 'not_deployed' } }), NOW)).toBe('merged 3h ago · not on prod');
    expect(rowDetail(row({ lane: 'deployed', ...merged, deploy: { state: 'orchestrator_only', boxesBehind: 2, boxesUnknown: 0, boxes: 5 } }), NOW))
      .toBe('on prod · merged 3h ago · 2 of your 5 boxes behind');
    expect(rowDetail(row({ lane: 'deployed', ...merged, deploy: { state: 'orchestrator_only', boxesBehind: 1, boxesUnknown: 0, boxes: 1 } }), NOW))
      .toBe('on prod · merged 3h ago · 1 of your 1 box behind');
    expect(rowDetail(row({ lane: 'deployed', ...merged, deploy: { state: 'orchestrator_only', boxesBehind: 2, boxesUnknown: 1, boxes: 5 } }), NOW))
      .toBe('on prod · merged 3h ago · 2 of your 5 boxes behind · 1 box unverifiable');
    expect(rowDetail(row({ lane: 'deployed', ...merged, deploy: { state: 'deployed', boxes: 4, boxesUnknown: 1 } }), NOW))
      .toBe('on prod · merged 3h ago · 1 box unverifiable');
  });
  it('a pushed branch with uncommitted changes says so', () => {
    expect(rowDetail(row({ kind: 'branch', lane: 'needs_pr', badges: ['dirty'], at: '2026-10-09T11:00:00Z' }), NOW))
      .toBe('pushed, last commit 1h ago · no pull request · uncommitted changes');
  });
  it('prefers what blocks a merge', () => {
    expect(rowDetail(row({ lane: 'ready_to_merge', blockedBy: 'merge conflict', badges: ['auto-merge'] }), NOW)).toBe('merge conflict');
    expect(rowDetail(row({ lane: 'ready_to_merge', badges: ['auto-merge'] }), NOW)).toBe('auto-merge on');
  });
});

describe('labels and counts', () => {
  it('labels PRs by repo#number and branches by repo · branch', () => {
    expect(rowLabel(row({ number: 280 }))).toBe('termag#280');
    expect(rowLabel(row({ kind: 'branch', number: null, headRefName: 'wip' }))).toBe('termag · wip');
  });
  it('counts every row that needs you, and nothing waiting on others', () => {
    const res = { connected: true as const, viewer: 'me', prod: { sha: null, source: 'unknown' as const }, boxes: 0, fetchedAt: '', notes: [],
      lanes: [
        lane('needs_my_review', [row({ lane: 'needs_my_review' }), row({ lane: 'needs_my_review' })]),
        lane('ready_to_merge', [row({ lane: 'ready_to_merge' })]),
        lane('checks', [row({}), row({ failingChecks: ['ci'] })]),
        lane('needs_approval', [row({ lane: 'needs_approval' }), row({ lane: 'needs_approval', badges: ['changes-requested'] })]),
        lane('merged_not_deployed', [row({ lane: 'merged_not_deployed' })]),
      ] };
    expect(actionableCount(res)).toBe(5);
    expect(actionableCount({ connected: false })).toBe(0);
    expect(actionableCount(null)).toBe(0);
  });
  it('opens on the first non-empty lane in phone order', () => {
    expect(firstNonEmpty([lane('checks', [row({})]), lane('needs_my_review')], PHONE_LANE_ORDER)).toBe('checks');
    expect(firstNonEmpty([], PHONE_LANE_ORDER)).toBe('needs_my_review');
  });
});

describe('the overview dialog helpers', () => {
  it('lets an approval go without text but not a comment or change request', () => {
    expect(canSubmitReview('APPROVE', '')).toBe(true);
    expect(canSubmitReview('COMMENT', '  ')).toBe(false);
    expect(canSubmitReview('REQUEST_CHANGES', '')).toBe(false);
    expect(canSubmitReview('REQUEST_CHANGES', 'fix x')).toBe(true);
  });
  it('words review states as verbs', () => {
    expect(reviewStateLabel('CHANGES_REQUESTED')).toBe('requested changes');
    expect(reviewStateLabel('APPROVED')).toBe('approved');
    expect(reviewStateLabel('SOMETHING_NEW')).toBe('something_new');
  });
  it('summarizes checks, failing first', () => {
    expect(checksSummary([])).toEqual({ text: 'no checks', tone: 'good' });
    expect(checksSummary([{ name: 'ci', state: 'pending' }, { name: 'Bugbot', state: 'failed' }])).toEqual({ text: 'failing: Bugbot', tone: 'bad' });
    expect(checksSummary([{ name: 'ci', state: 'pending' }, { name: 'lint', state: 'passed' }])).toEqual({ text: 'running: ci', tone: 'wait' });
    expect(checksSummary([{ name: 'ci', state: 'passed' }])).toEqual({ text: '1 check passed', tone: 'good' });
  });
});

describe('mergeReadiness', () => {
  const pr = (over: Partial<Parameters<typeof mergeReadiness>[0]> = {}) => ({
    isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMerge: false,
    mergeSettings: { methods: ['SQUASH' as const], defaultMethod: 'SQUASH' as const, autoMergeAllowed: true }, ...over,
  });
  it('offers Merge now on a clean PR, and not auto-merge (GitHub refuses it there)', () => {
    expect(mergeReadiness(pr())).toEqual({ canMergeNow: true, note: null, canEnableAuto: false });
  });
  it('offers auto-merge instead when blocked or behind', () => {
    expect(mergeReadiness(pr({ mergeStateStatus: 'BLOCKED' }))).toMatchObject({ canMergeNow: false, canEnableAuto: true });
    expect(mergeReadiness(pr({ mergeStateStatus: 'BEHIND' }))).toMatchObject({ canMergeNow: false, canEnableAuto: true });
  });
  it('does not offer auto-merge twice, or where the repo disallows it', () => {
    expect(mergeReadiness(pr({ mergeStateStatus: 'BLOCKED', autoMerge: true })).canEnableAuto).toBe(false);
    expect(mergeReadiness(pr({ mergeStateStatus: 'BLOCKED', mergeSettings: { methods: ['SQUASH'], defaultMethod: 'SQUASH', autoMergeAllowed: false } })).canEnableAuto).toBe(false);
  });
  it('offers nothing on a draft or a conflict', () => {
    expect(mergeReadiness(pr({ isDraft: true }))).toMatchObject({ canMergeNow: false, canEnableAuto: false });
    expect(mergeReadiness(pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }))).toMatchObject({ canMergeNow: false, note: expect.stringContaining('conflict') });
  });
  it('lets a merge be tried with a caveat when non-required checks fail', () => {
    expect(mergeReadiness(pr({ mergeStateStatus: 'UNSTABLE' }))).toMatchObject({ canMergeNow: true, note: expect.stringContaining('non-required') });
  });
});

describe('reviewer roster and ping', () => {
  const pr = {
    author: 'me',
    reviews: [
      { author: 'bob', state: 'CHANGES_REQUESTED', submittedAt: null },
      { author: 'dan', state: 'APPROVED', submittedAt: null },
      { author: 'carol', state: 'COMMENTED', submittedAt: null },
      { author: 'me', state: 'COMMENTED', submittedAt: null },
    ],
    requestedUsers: ['carol'],
    requestedTeams: ['platform-team'],
  };
  it('lists answered reviewers (preselecting all but approvals), then the ones still asked', () => {
    expect(reviewerRoster(pr)).toEqual([
      { name: 'bob', kind: 'user', state: 'CHANGES_REQUESTED', pending: false, pick: true },
      { name: 'dan', kind: 'user', state: 'APPROVED', pending: false, pick: false },
      { name: 'carol', kind: 'user', state: 'REQUESTED', pending: true, pick: false },
      { name: 'platform-team', kind: 'team', state: 'REQUESTED', pending: true, pick: false },
    ]);
  });
  it('mentions teams as org/slug', () => {
    expect(mention({ name: 'platform-team', kind: 'team' }, 'example-org/termag')).toBe('@example-org/platform-team');
  });
  it('pings the reviewers still asked, else the picked ones, else nobody', () => {
    const roster = reviewerRoster(pr);
    expect(pingText(roster, new Set(['bob']), 'example-org/termag')).toMatch(/^@carol @example-org\/platform-team friendly ping/);
    const answered = roster.filter(e => !e.pending);
    expect(pingText(answered, new Set(['bob']), 'example-org/termag')).toMatch(/^@bob friendly ping/);
    expect(pingText(answered, new Set(), 'example-org/termag')).toBe('');
  });
});

describe('compareUrl', () => {
  const branch = (over: Partial<PrRow> = {}) => row({ kind: 'branch', lane: 'needs_pr', number: null, url: null, headRefName: 'psecor/feat x', baseRefName: 'main', ...over });
  it('opens GitHub\'s new-PR form for a pushed branch, keeping slashes and encoding the rest', () => {
    expect(compareUrl(branch())).toBe('https://github.com/example-org/termag/compare/main...psecor/feat%20x?expand=1');
  });
  it('is null outside Needs a PR, without a repository, or for a PR row', () => {
    expect(compareUrl(branch({ lane: 'in_progress' }))).toBeNull();
    expect(compareUrl(branch({ repo: null }))).toBeNull();
    expect(compareUrl(branch({ repo: 'not a repo' }))).toBeNull();
    expect(compareUrl(row({ lane: 'needs_pr' }))).toBeNull();
  });
});

describe('the deploy stage', () => {
  const waiting = (baked: boolean | null | undefined) => row({ lane: 'merged_not_deployed', mergedAt: '2026-10-09T09:00:00Z', deploy: { state: 'not_deployed', baked } });
  const d = (bakes: unknown[] | null = null) => ({ image: { sha: 'a'.repeat(40), createdAt: '2026-10-09T10:00:00Z' }, bakes: bakes as never, workflowUrl: 'w' });
  it('words each row by whether the newest image has it', () => {
    expect(rowDetail(waiting(true), NOW)).toBe('merged 3h ago · baked, rolling out');
    expect(rowDetail(waiting(false), NOW)).toBe('merged 3h ago · waiting for a bake');
    expect(rowDetail(waiting(null), NOW)).toBe('merged 3h ago · not on prod');
  });
  it('offers a bake when something waits for one and none runs', () => {
    expect(deployStage([waiting(false), waiting(true)], d(), NOW)).toMatchObject({ offerBake: true, text: expect.stringMatching(/^1 of 2 not in a baked image/) });
    expect(deployStage([waiting(false)], d(), NOW).text).toMatch(/^Not in a baked image/);
  });
  it('points at a running bake instead of offering another', () => {
    const got = deployStage([waiting(false)], d([{ url: 'https://github.com/r/1', status: 'in_progress', event: 'schedule', createdAt: '2026-10-09T11:56:00Z' }]), NOW);
    expect(got).toEqual({ text: 'A bake of main is running (started 4m ago); it deploys itself when it finishes.', offerBake: false, runUrl: 'https://github.com/r/1' });
  });
  it('says nothing about merges already on prod: they are in Deployed', () => {
    expect(deployStage([waiting(true)], d(), NOW).text).not.toContain('orchestrator;');
    expect(boxesBehindText(row({ deploy: { state: 'orchestrator_only', boxesBehind: 2, boxesUnknown: 0, boxes: 3 } }))).toBe('2 of your 3 boxes behind');
    expect(boxesBehindText(row({ deploy: { state: 'deployed', boxesUnknown: 0, boxes: 3 } }))).toBeNull();
  });
  it('offers a bake when it cannot tell whether the image has a merge, but not for an unknown prod', () => {
    expect(deployStage([waiting(null)], d(), NOW).offerBake).toBe(true);
    expect(deployStage([row({ lane: 'merged_not_deployed', deploy: { state: 'unknown', reason: 'x' } })], d(), NOW).offerBake).toBe(false);
  });
  it('says rolling out when every waiting merge is baked', () => {
    expect(deployStage([waiting(true)], d(), NOW)).toMatchObject({ offerBake: false, text: expect.stringContaining('baked 2h ago') });
  });
});

describe('bakePending', () => {
  it('holds the button back only until the run is listed or three minutes pass', () => {
    expect(bakePending(null, false, NOW)).toBe(false);
    expect(bakePending(NOW - 60_000, false, NOW)).toBe(true);
    expect(bakePending(NOW - 60_000, true, NOW)).toBe(false);
    expect(bakePending(NOW - 4 * 60_000, false, NOW)).toBe(false);
  });
});

describe('rowAction', () => {
  it('names the dialog by what the lane needs next', () => {
    expect(rowAction(row({ lane: 'needs_my_review' })).label).toBe('Review');
    expect(rowAction(row({ lane: 'ready_to_merge' })).label).toBe('Merge');
    expect(rowAction(row({ lane: 'checks', failingChecks: ['ci'] })).label).toBe('Re-run');
    expect(rowAction(row({ lane: 'checks', pendingChecks: ['ci'] }))).toMatchObject({ label: 'Overview', primary: false });
    expect(rowAction(row({ lane: 'needs_approval' })).label).toBe('Ping');
    expect(rowAction(row({ lane: 'deployed' })).label).toBe('Overview');
  });
});

describe('needsYou', () => {
  it('says why a row is yours to act on', () => {
    expect(needsYou(row({ lane: 'needs_my_review' }))).toBe('review asked of you');
    expect(needsYou(row({ lane: 'ready_to_merge' }))).toBe('ready to merge');
    expect(needsYou(row({ lane: 'ready_to_merge', badges: ['conflict'] }))).toBe('merge conflict');
    expect(needsYou(row({ lane: 'checks', failingChecks: ['ci'] }))).toBe('checks failing');
    expect(needsYou(row({ lane: 'needs_approval', badges: ['changes-requested'] }))).toBe('changes requested');
    expect(needsYou(row({ lane: 'needs_approval', badges: ['conflict'] }))).toBe('merge conflict');
    expect(needsYou(row({ kind: 'branch', lane: 'needs_pr', number: null }))).toBe('pushed, no pull request');
  });
  it('leaves out what waits on others or runs by itself', () => {
    expect(needsYou(row({ lane: 'checks', pendingChecks: ['ci'] }))).toBeNull();
    expect(needsYou(row({ lane: 'checks', failingChecks: ['ci'], badges: ['draft'] }))).toBeNull();
    expect(needsYou(row({ lane: 'needs_approval' }))).toBeNull();
    expect(needsYou(row({ lane: 'in_progress', kind: 'branch' }))).toBeNull();
    expect(needsYou(row({ lane: 'merged_not_deployed' }))).toBeNull();
    expect(needsYou(row({ lane: 'deployed' }))).toBeNull();
  });
  it('lists reviews asked of you first', () => {
    const res = { connected: true as const, viewer: 'me', prod: { sha: null, source: 'unknown' as const }, boxes: 0, fetchedAt: '', notes: [],
      lanes: [lane('checks', [row({ number: 1, failingChecks: ['ci'] })]), lane('needs_my_review', [row({ lane: 'needs_my_review', number: 2 })])] };
    expect(needsYouRows(res).map(x => x.row.number)).toEqual([2, 1]);
  });
});

describe('the PR overlay URL', () => {
  it('opens, selects and closes, keeping the page\'s own parameters', () => {
    expect(prsSearch('?project=p1&ws=feat', 'needs_you')).toBe('?project=p1&ws=feat&prs=needs_you');
    expect(prsSearch('?project=p1&prs=needs_you', 'checks', 'example-org/termag#9')).toBe('?project=p1&prs=checks&pr=example-org%2Ftermag%239');
    expect(prsSearch('?project=p1&prs=checks&pr=x', null)).toBe('?project=p1');
    expect(prsSearch('?prs=checks', null)).toBe('');
  });
  it('knows its views and keys rows', () => {
    expect(isPrsView('needs_you')).toBe(true);
    expect(isPrsView('ready_to_merge')).toBe(true);
    expect(isPrsView('bogus')).toBe(false);
    expect(isPrsView(null)).toBe(false);
    expect(rowParam(row({ number: 9 }))).toBe('example-org/termag#9');
    expect(rowParam(row({ kind: 'branch', number: null, headRefName: 'feat/x' }))).toBe('example-org/termag:feat/x');
  });
});

describe('laneTabLabel', () => {
  const res = (mergedWindowDays?: number) => ({
    connected: true as const, viewer: 'me', lanes: [], prod: { sha: null, source: 'unknown' as const }, boxes: 0,
    fetchedAt: '', notes: [], mergedWindowDays,
  });
  it('adds the merged-search window to Deployed and Merged only', () => {
    expect(laneTabLabel('deployed', res(14))).toBe('Deployed 14d');
    expect(laneTabLabel('merged', res(14))).toBe('Other merges 14d');
    expect(laneTabLabel('ready_to_merge', res(14))).toBe('Ready');
  });
  it('keeps the plain label without a window (older backend, not connected)', () => {
    expect(laneTabLabel('deployed', res())).toBe('Deployed');
    expect(laneTabLabel('deployed', { connected: false })).toBe('Deployed');
    expect(laneTabLabel('deployed', null)).toBe('Deployed');
  });
});

describe('deferring a row', () => {
  const NOW_MS = Date.parse('2026-10-14T12:00:00Z');
  const base = { connected: true as const, viewer: 'me', prod: { sha: null, source: 'unknown' as const }, boxes: 0, fetchedAt: '', notes: [] };
  const res = {
    ...base,
    lanes: [
      lane('needs_my_review', [row({ lane: 'needs_my_review', number: 99 }), row({ lane: 'needs_my_review', number: 100 })]),
      lane('ready_to_merge', [row({ lane: 'ready_to_merge', number: 101 })]),
    ],
    deferred: [
      { key: 'example-org/termag#99', until: '2026-10-15T12:00:00Z' },
      { key: 'example-org/termag#101', until: '2026-10-14T11:00:00Z' },
    ],
  };
  it('reads running deferrals only', () => {
    expect([...deferrals(res, NOW_MS).keys()]).toEqual(['example-org/termag#99']);
    expect(deferrals({ ...base, lanes: [] }, NOW_MS).size).toBe(0);
    expect(deferrals({ connected: false }, NOW_MS).size).toBe(0);
  });
  it('leaves a deferred row out of Needs you and the count until its time is up', () => {
    expect(needsYouRows(res, NOW_MS).map(e => e.row.number)).toEqual([100, 101]);
    expect(actionableCount(res, NOW_MS)).toBe(2);
    expect(actionableCount(res, Date.parse('2026-10-15T12:00:01Z'))).toBe(3);
  });
  it('splits a view into shown and deferred, deferred ones carrying their end', () => {
    const { shown, deferred } = splitDeferred(viewEntries('needs_my_review', res, NOW_MS), res, NOW_MS);
    expect(shown.map(e => e.row.number)).toEqual([100]);
    expect(deferred.map(e => [e.row.number, e.until])).toEqual([[99, Date.parse('2026-10-15T12:00:00Z')]]);
    expect(viewEntries('needs_you', res, NOW_MS).map(e => e.row.number)).toEqual([99, 100, 101]);
  });
  it('says when it comes back', () => {
    expect(deferredText(NOW_MS + 23 * 3_600_000, NOW_MS)).toBe('deferred · back in 23h');
  });
});

describe('apiErrorText', () => {
  it("prefers the backend's error, else the fallback", async () => {
    const { apiErrorText } = await import('./prPipeline');
    expect(apiErrorText({ response: { data: { error: 'GitHub timed out listing your pull requests. It retries in a minute.' } } }, 'x'))
      .toBe('GitHub timed out listing your pull requests. It retries in a minute.');
    expect(apiErrorText(new Error('Network Error'), 'GitHub did not answer.')).toBe('GitHub did not answer.');
    expect(apiErrorText({ response: { data: '<html>504</html>' } }, 'fallback')).toBe('fallback');
  });
});

describe('prsTileView', () => {
  it('hides the tile when GitHub is not connected and nothing failed', async () => {
    const { prsTileView } = await import('./prPipeline');
    expect(prsTileView(null, null, 0)).toEqual({ show: false });
    expect(prsTileView({ connected: false }, null, 0)).toEqual({ show: false });
  });
  it('shows the count when connected; zero marks it quiet', async () => {
    const { prsTileView } = await import('./prPipeline');
    expect(prsTileView({ connected: true }, null, 3)).toMatchObject({ show: true, failed: false, text: '3', zero: false });
    expect(prsTileView({ connected: true }, null, 0)).toMatchObject({ show: true, failed: false, text: '0', zero: true });
  });
  it('a list that never loaded shows "!" with the reason, never as zero', async () => {
    const { prsTileView } = await import('./prPipeline');
    const err = { response: { data: { error: 'GitHub timed out listing your pull requests. It retries in a minute.' } } };
    expect(prsTileView(null, err, 0)).toEqual({
      show: true, failed: true, text: '!', zero: false,
      title: 'Could not list your pull requests: GitHub timed out listing your pull requests. It retries in a minute.',
    });
  });
  it('after one good answer a failed refresh keeps the counts', async () => {
    const { prsTileView } = await import('./prPipeline');
    expect(prsTileView({ connected: true }, new Error('x'), 2)).toMatchObject({ failed: false, text: '2' });
  });
});

describe('checks red by rollup alone (names unread)', () => {
  it('still needs you, says so, and offers Re-run', () => {
    const r = row({ lane: 'checks', failingChecks: [], checksFailed: true });
    expect(needsYou(r)).toBe('checks failing');
    expect(rowDetail(r, NOW)).toBe('checks failing');
    expect(rowAction(r).label).toBe('Re-run');
  });
  it('an older backend without the field behaves as before', () => {
    const r = row({ lane: 'checks', failingChecks: [] });
    expect(needsYou(r)).toBeNull();
    expect(rowDetail(r, NOW)).toBe('checks not green');
  });
});

describe('hasOverview', () => {
  it('is a PR with its repository and number; a branch, or a PR row missing either, has none', () => {
    expect(hasOverview({ kind: 'pr', repo: 'example-org/termag', number: 425 })).toBe(true);
    expect(hasOverview({ kind: 'branch', repo: 'example-org/termag', number: null })).toBe(false);
    expect(hasOverview({ kind: 'pr', repo: null, number: 425 })).toBe(false);
    expect(hasOverview({ kind: 'pr', repo: 'example-org/termag', number: null })).toBe(false);
  });
});
