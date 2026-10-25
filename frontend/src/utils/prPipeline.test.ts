import { describe, it, expect } from 'vitest';
import type { PrLane, PrRow } from '../services/api';
import { myReviewCount, asksForMyReview, hasOverview, bakePending, boxesBehindText, deferrals, deferredText, splitDeferred, viewEntries, inRepo, isPrsView, needsYou, needsYouRows, prsRepoSearch, prsSearch, rowParam, canSubmitReview, checksSummary, compareUrl, deployStage, firstNonEmpty, laneTabLabel, mention, mergeReadiness, PHONE_LANE_ORDER, pingText, reviewerRoster, reviewStateLabel, rowDetail, rowLabel, rowAction, searchPrRows } from './prPipeline';

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
  it('counts only reviews asked of you by name; Needs you lists your own PRs too, team reviews neither', () => {
    const res = { connected: true as const, viewer: 'me', prod: { sha: null, source: 'unknown' as const }, boxes: 0, fetchedAt: '', notes: [],
      lanes: [
        lane('needs_my_review', [
          row({ lane: 'needs_my_review', number: 1, askedYou: true }),
          row({ lane: 'needs_my_review', number: 3 }), // an older backend: no flag, counted
        ]),
        lane('team_review', [row({ lane: 'team_review', number: 2, askedYou: false })]),
        lane('ready_to_merge', [row({ lane: 'ready_to_merge' })]),
        lane('checks', [row({}), row({ failingChecks: ['ci'] })]),
        lane('needs_approval', [row({ lane: 'needs_approval' }), row({ lane: 'needs_approval', badges: ['changes-requested'] })]),
        lane('merged_not_deployed', [row({ lane: 'merged_not_deployed' })]),
      ] };
    expect(myReviewCount(res)).toBe(2);
    expect(myReviewCount(res, Date.now(), r => r.number === 1)).toBe(1);
    expect(needsYouRows(res).map(e => e.why)).toEqual(['review asked of you', 'review asked of you', 'ready to merge', 'checks failing', 'changes requested']);
    expect(needsYou(row({ lane: 'team_review' }))).toBeNull();
    expect(rowAction(row({ lane: 'team_review' })).label).toBe('Review');
    expect(myReviewCount({ connected: false })).toBe(0);
    expect(myReviewCount(null)).toBe(0);
  });
  it('asks for my review only on a review request that names me', () => {
    expect(asksForMyReview(row({ lane: 'needs_my_review', askedYou: true }))).toBe(true);
    expect(asksForMyReview(row({ lane: 'team_review', askedYou: false }))).toBe(false);
    expect(asksForMyReview(row({ lane: 'ready_to_merge' }))).toBe(false);
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

describe('the repo filter', () => {
  it('passes every row with no filter, only that repository with one', () => {
    expect(inRepo({ repo: null }, null)).toBe(true);
    expect(inRepo({ repo: 'example-org/termag' }, null)).toBe(true);
    expect(inRepo({ repo: 'example-org/termag' }, 'example-org/termag')).toBe(true);
    expect(inRepo({ repo: 'example-org/webapp' }, 'example-org/termag')).toBe(false);
    expect(inRepo({ repo: null }, 'example-org/termag')).toBe(false);
  });
});

describe('the PR overlay URL', () => {
  it('opens, selects and closes, keeping the page\'s own parameters', () => {
    expect(prsSearch('?project=p1&ws=feat', 'needs_you')).toBe('?project=p1&ws=feat&prs=needs_you');
    expect(prsSearch('?project=p1&prs=needs_you', 'checks', 'example-org/termag#9')).toBe('?project=p1&prs=checks&pr=example-org%2Ftermag%239');
    expect(prsSearch('?project=p1&prs=checks&pr=x', null)).toBe('?project=p1');
    expect(prsSearch('?prs=checks', null)).toBe('');
  });
  it('keeps the repo filter across views and drops it on close', () => {
    expect(prsSearch('?prs=needs_you&prs_repo=example-org%2Ftermag', 'checks')).toBe('?prs=checks&prs_repo=example-org%2Ftermag');
    expect(prsSearch('?project=p1&prs=checks&prs_repo=example-org%2Ftermag&pr=x', null)).toBe('?project=p1');
  });
  it('sets and clears the repo filter, dropping the selected row', () => {
    expect(prsRepoSearch('?project=p1&prs=checks&pr=example-org%2Ftermag%239', 'example-org/webapp'))
      .toBe('?project=p1&prs=checks&prs_repo=example-org%2Fwebapp');
    expect(prsRepoSearch('?prs=checks&prs_repo=example-org%2Fwebapp', null)).toBe('?prs=checks');
    expect(prsRepoSearch('?prs_repo=a%2Fb', null)).toBe('');
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
    expect(myReviewCount(res, NOW_MS)).toBe(1);
    expect(myReviewCount(res, Date.parse('2026-10-15T12:00:01Z'))).toBe(2);
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
    const fresh = { connected: true, fetchedAt: new Date(NOW - 60_000).toISOString() };
    expect(prsTileView(fresh, null, 3, NOW)).toMatchObject({ show: true, failed: false, stale: false, text: '3', zero: false });
    expect(prsTileView(fresh, null, 0, NOW)).toMatchObject({ show: true, failed: false, stale: false, text: '0', zero: true });
  });
  it('marks an answer older than five minutes out of date, keeping its number', async () => {
    const { prsTileView } = await import('./prPipeline');
    const old = prsTileView({ connected: true, fetchedAt: new Date(NOW - 14 * 60_000).toISOString() }, null, 2, NOW);
    expect(old).toMatchObject({ show: true, failed: false, stale: true, text: '2?' });
    expect(old.show && old.title).toMatch(/^Last read from GitHub 14m ago\. This may be out of date\. Pull requests asking you/);
    expect(prsTileView({ connected: true, fetchedAt: new Date(NOW - 4 * 60_000).toISOString() }, null, 2, NOW)).toMatchObject({ stale: false, text: '2' });
  });
  it('a list that never loaded shows "!" with the reason, never as zero', async () => {
    const { prsTileView } = await import('./prPipeline');
    const err = { response: { data: { error: 'GitHub timed out listing your pull requests. It retries in a minute.' } } };
    expect(prsTileView(null, err, 0)).toEqual({
      show: true, failed: true, stale: false, text: '!', zero: false,
      title: 'Could not list your pull requests: GitHub timed out listing your pull requests. It retries in a minute.',
    });
  });
  it('after one good answer a failed refresh keeps the count, marked out of date with the reason', async () => {
    const { prsTileView } = await import('./prPipeline');
    const err = { response: { data: { error: 'GitHub rate limit' } } };
    const t = prsTileView({ connected: true, fetchedAt: new Date(NOW - 60_000).toISOString() }, err, 2, NOW);
    expect(t).toMatchObject({ failed: false, stale: true, text: '2?' });
    expect(t.show && t.title).toMatch(/^Last read from GitHub 1m ago: refreshing failed \(GitHub rate limit\)\. This may be out of date\./);
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

describe('searchPrRows', () => {
  const tf = row({ lane: 'needs_my_review', repo: 'example-org/terraform', number: 28280, title: 'Add the termag Envoy route', author: 'zane', headRefName: 'zane/envoy' });
  const mine = row({ lane: 'checks', number: 451, title: 'feat: spawn lifecycle', headRefName: 'termag-spawn-l3' });
  const old = row({ lane: 'deployed', number: 2828, title: 'fix the terraform docs', mergedAt: '2026-10-01T00:00:00Z' });
  const res = { connected: true, viewer: 'me', lanes: [lane('checks', [mine]), lane('needs_my_review', [tf]), lane('deployed', [old])], prod: { sha: null, source: 'unknown' }, boxes: 0, checkouts: [], notes: [], fetchedAt: '' } as never;

  it('finds a PR by its number, with or without #, exact first', () => {
    expect(searchPrRows(res, '28280')).toEqual([tf]);
    expect(searchPrRows(res, '#28280')).toEqual([tf]);
    expect(searchPrRows(res, '2828')).toEqual([old, tf]);
  });
  it('finds one from a pasted pull-request URL', () => {
    expect(searchPrRows(res, 'https://github.com/example-org/terraform/pull/28280/files')).toEqual([tf]);
  });
  it('matches every word across repo, title, branch, author and lane, in lane order', () => {
    expect(searchPrRows(res, 'terraform')).toEqual([tf, old]);
    expect(searchPrRows(res, 'Envoy zane')).toEqual([tf]);
    expect(searchPrRows(res, 'my review')).toEqual([tf]);
    expect(searchPrRows(res, 'spawn-l3')).toEqual([mine]);
    expect(searchPrRows(res, 'envoy lifecycle')).toEqual([]);
  });
  it('reads repo#number the way rows are labelled, with or without the owner', () => {
    expect(searchPrRows(res, 'terraform#28280')).toEqual([tf]);
    expect(searchPrRows(res, 'example-org/terraform#28280')).toEqual([tf]);
    expect(searchPrRows(res, 'Terra#2828')).toEqual([tf]);
    // The repository has to match, not a title that mentions it.
    expect(searchPrRows(res, 'termag#2828')).toEqual([old]);
    expect(searchPrRows(res, 'terraform#451')).toEqual([]);
    expect(searchPrRows(res, 'termag#')).toEqual([mine, old]);
  });
  it('applies the repo filter before the limit', () => {
    expect(searchPrRows(res, 't', 1)).toEqual([tf]);
    expect(searchPrRows(res, 't', 1, 'example-org/termag')).toEqual([mine]);
  });
  it('nothing for an empty query, a lone #, or no GitHub', () => {
    expect(searchPrRows(res, '  ')).toEqual([]);
    expect(searchPrRows(res, '#')).toEqual([]);
    expect(searchPrRows({ connected: false }, '28280')).toEqual([]);
    expect(searchPrRows(null, '28280')).toEqual([]);
  });
});

describe('prsStale', () => {
  it('is null for a current answer and when not connected', async () => {
    const { prsStale } = await import('./prPipeline');
    expect(prsStale({ connected: true, fetchedAt: new Date(NOW - 60_000).toISOString() }, null, NOW)).toBeNull();
    expect(prsStale({ connected: false }, new Error('x'), NOW)).toBeNull();
    expect(prsStale(null, new Error('x'), NOW)).toBeNull();
  });
  it('says how old, and why, when it is not', async () => {
    const { prsStale } = await import('./prPipeline');
    expect(prsStale({ connected: true, fetchedAt: new Date(NOW - 3 * 3_600_000).toISOString() }, null, NOW)).toBe('Last read from GitHub 3h ago. This may be out of date.');
    expect(prsStale({ connected: true }, new Error('boom'), NOW)).toMatch(/^Last read from GitHub a while ago: refreshing failed/);
  });
});
