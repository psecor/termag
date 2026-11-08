import { describe, expect, it } from 'vitest';
import type { PrPipelineResponse, PrRow } from '../services/api';
import {
  approvedSince, filterOptions, filterQueue, filtersFromSearch, filtersToSearch, githubListUrl, hasFilters, isBotAuthor, matchesFilters, NO_FILTERS,
  filtersOnOpen, postedAt, leftToReview, parsePrRef, prPath, queueNote, readRememberedFilters, reviewQueue, reviewStateOf, sectionCounts, sidebarItems, writeRememberedFilters,
  type AgentReview, type PostedRound, type QueueFilters, type SessionState,
} from './reviews';

const NOW = Date.parse('2026-10-28T12:00:00Z');

function row(n: number, extra: Partial<PrRow> = {}): PrRow {
  return {
    kind: 'pr', lane: 'needs_my_review', repo: 'example-org/termag', number: n, title: `PR ${n}`, url: `https://github.com/example-org/termag/pull/${n}`,
    author: 'e2e-fabian', headRefName: `b${n}`, baseRefName: 'main', at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [],
    blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: '2026-10-28T10:00:00Z', reviewTarget: null,
    askedYou: true, ...extra,
  };
}

function prs(rows: PrRow[], extra: Record<string, unknown> = {}): PrPipelineResponse {
  const review = rows.filter(r => r.lane === 'needs_my_review');
  const team = rows.filter(r => r.lane === 'team_review');
  return {
    connected: true, viewer: 'e2e-octocat', prod: { sha: null, source: 'unknown' }, boxes: 0, fetchedAt: '', notes: [],
    lanes: [{ id: 'needs_my_review', label: 'Needs my review', rows: review }, { id: 'team_review', label: 'Team reviews', rows: team }],
    ...extra,
  } as unknown as PrPipelineResponse;
}

describe('reviewQueue', () => {
  it('puts requests by name in To review and team-only ones in Asks your team', () => {
    const q = reviewQueue({ prs: prs([row(1), row(2, { lane: 'team_review', askedYou: false })]), now: NOW });
    expect(q.items.map(i => [i.number, i.section])).toEqual([[1, 'to-review'], [2, 'team']]);
    expect(q.needYou).toBe(0);
  });

  it('moves a request with a working review session to Reviewing, and a finished one to Your call', () => {
    const link = { projectId: 'p', workstream: 'termag-pr1-b1', projectName: 'termag' };
    const linked = (n: number) => row(n, { workstream: { ...link, workstream: `w${n}` }, linkedBy: 'manual' });
    const state = (l: { workstream: string }): 'working' | 'done' => (l.workstream === 'w1' ? 'working' : 'done');
    const q = reviewQueue({ prs: prs([linked(1), linked(2)]), now: NOW, sessionState: state });
    expect(q.items.map(i => [i.number, i.section])).toEqual([[2, 'your-call'], [1, 'reviewing']]);
    expect(q.needYou).toBe(1);
  });

  it('says a review session that stopped on an error needs you for that, not that it reviewed the PR', () => {
    const ws = { projectId: 'p', projectName: 'termag', workstream: 'termag-pr3' };
    const q = reviewQueue({ prs: prs([row(3, { workstream: ws, linkedBy: 'manual' })]), now: NOW, sessionState: (): SessionState => 'error' });
    expect(q.items[0]).toMatchObject({ section: 'your-call', why: ['e2e-fabian', 'the review stopped on an error'] });
  });

  it("shows a PR once when its agent review's repo and its round's differ in case", () => {
    const agent: AgentReview = { projectId: 'p', workstream: 'main', session: null, number: 9, url: 'https://github.com/Example-Org/Termag/pull/9', reviewer: 'Devin', state: 'reviewing', seen: false };
    const round: PostedRound = { repo: 'example-org/termag', number: 9, round: 1, headSha: 'aaa', event: 'COMMENT', comments: 1, postedAt: '2026-10-28T11:00:00Z',
      now: { state: 'open', headSha: 'aaa', askedAgain: false, title: 'PR 9', author: 'e2e-fabian', url: '' } };
    const q = reviewQueue({ prs: prs([]), now: NOW, agentReviews: [agent], rounds: [round] });
    expect(q.items.map(i => [i.number, i.section])).toEqual([[9, 'reviewing']]);
  });

  it('lists agent reviews by their pane state, and drops one already read', () => {
    const a = (n: number, state: AgentReview['state'], seen = false): AgentReview => ({
      projectId: 'p', workstream: 'main', session: null, number: n, url: `https://github.com/example-org/termag/pull/${n}`, reviewer: 'Devin', state, seen,
    });
    const q = reviewQueue({ prs: prs([]), now: NOW, agentReviews: [a(7, 'reviewing'), a(8, 'waiting'), a(9, 'done'), a(10, 'done', true)] });
    expect(q.items.map(i => [i.number, i.section, i.why[0]])).toEqual([
      [8, 'your-call', 'Devin needs an answer'], [9, 'your-call', "Devin's review is ready"], [7, 'reviewing', 'Devin is reading it'],
    ]);
  });

  it("titles an agent review of the user's own PR from the lane that lists it", () => {
    const mine = prs([], { lanes: [{ id: 'mine', label: 'Mine', rows: [row(12, { lane: 'mine' as PrRow['lane'], title: 'Fix the flaky retry' })] }] });
    const q = reviewQueue({ prs: mine, now: NOW, agentReviews: [{ projectId: 'p', workstream: 'main', session: null, number: 12, url: 'https://github.com/example-org/termag/pull/12', reviewer: 'Devin', state: 'waiting', seen: false }] });
    expect(q.items[0]).toMatchObject({ title: 'Fix the flaky retry', section: 'your-call', row: null });
  });

  it("keeps a round whose head GitHub couldn't read, so a request it kept doesn't come back as a new one", () => {
    const blip = (event: PostedRound['event']): PostedRound => ({ repo: 'example-org/termag', number: 5, round: 1, headSha: 'aaa', event, comments: 2, postedAt: '2026-10-28T11:00:00Z', title: 'PR 5', author: 'e2e-fabian', now: null });
    const kept = row(5, { lane: 'team_review', askedYou: false, requestedAt: '2026-10-28T09:00:00Z' });
    expect(reviewQueue({ prs: prs([kept]), now: NOW, rounds: [blip('COMMENT')] }).items.map(i => [i.number, i.section])).toEqual([[5, 'waiting']]);
    const approved = reviewQueue({ prs: prs([kept]), now: NOW, rounds: [blip('APPROVE')] });
    expect(approved.items).toEqual([]);
    expect(approved.reviewed.map(i => i.number)).toEqual([5]);
    // Asked again since (a request newer than the round): a request once more.
    const again = row(5, { requestedAt: '2026-10-28T11:30:00Z' });
    expect(reviewQueue({ prs: prs([again]), now: NOW, rounds: [blip('COMMENT')] }).items[0]).toMatchObject({ section: 'pushed' });
  });

  it('keeps a posted review waiting until the head moves, then asks for round 2', () => {
    const round = (headNow: string, askedAgain = false): PostedRound => ({
      repo: 'example-org/termag', number: 5, round: 1, headSha: 'aaa', event: 'REQUEST_CHANGES', comments: 3, postedAt: '2026-10-28T11:00:00Z',
      now: { state: 'open', headSha: headNow, askedAgain, title: 'PR 5', author: 'e2e-fabian', url: 'https://github.com/example-org/termag/pull/5' },
    });
    expect(reviewQueue({ prs: prs([]), now: NOW, rounds: [round('aaa')] }).items[0]).toMatchObject({ section: 'waiting', why: ['you requested changes', '3 comments'] });
    expect(reviewQueue({ prs: prs([]), now: NOW, rounds: [round('bbb')] }).items[0]).toMatchObject({ section: 'pushed', why: ['pushed since your review', 'round 2'] });
    expect(reviewQueue({ prs: prs([]), now: NOW, rounds: [round('aaa', true)] }).items[0]).toMatchObject({ section: 'pushed' });
  });

  it("takes a posted round's session only from a review session the user started on the PR", () => {
    const round: PostedRound = {
      repo: 'example-org/termag', number: 5, round: 1, headSha: 'aaa', event: 'REQUEST_CHANGES', comments: 3, postedAt: '2026-10-28T11:00:00Z',
      now: { state: 'open', headSha: 'bbb', askedAgain: true, title: 'PR 5', author: 'e2e-fabian', url: 'https://github.com/example-org/termag/pull/5' },
    };
    const ws = { projectId: 'p', projectName: 'termag', workstream: 'termag-pr5' };
    const linked = (linkedBy: PrRow['linkedBy']) => reviewQueue({ prs: prs([row(5, { workstream: ws, linkedBy })]), now: NOW, rounds: [round] }).items[0];
    expect(linked('manual')).toMatchObject({ section: 'pushed', session: ws });
    // A session of theirs that only has the PR's branch checked out isn't its review session.
    expect(linked('branch')).toMatchObject({ section: 'pushed', session: null });
  });

  it('lists every review session in the sidebar, so none is hidden from its space with no row', () => {
    const ws = { projectId: 'p', projectName: 'termag', workstream: 'termag-pr6' };
    const q = reviewQueue({ prs: prs([row(6, { workstream: ws, linkedBy: 'manual' }), row(7)]), now: NOW, sessionState: () => 'off' });
    expect(q.items.map(i => [i.number, i.section, !!i.session])).toEqual(expect.arrayContaining([[6, 'to-review', true], [7, 'to-review', false]]));
    expect(sidebarItems(q).map(i => i.number)).toEqual([6]);
  });

  it('keeps a finished review, and its session, out of the sections once approved or merged', () => {
    const session = { projectId: 'p', workstream: 'termag-pr5' };
    const round = (event: PostedRound['event'], state: 'open' | 'merged'): PostedRound => ({
      repo: 'example-org/termag', number: 5, round: 2, headSha: 'bbb', event, comments: 0, postedAt: '2026-10-28T11:00:00Z',
      now: { state, headSha: 'bbb', askedAgain: false, title: 'PR 5', author: 'e2e-fabian', url: 'https://github.com/example-org/termag/pull/5' },
    });
    const earlier = (rows: PrRow[]) => prs(rows, { earlier: [{ repo: 'example-org/termag', number: 5, workstream: session, at: null, source: 'manual' }] });
    const merged = reviewQueue({ prs: earlier([]), now: NOW, rounds: [round('APPROVE', 'merged')] });
    expect(merged.items).toEqual([]);
    expect(merged.reviewed[0]).toMatchObject({ section: 'reviewed', session, why: ['you approved', 'merged'] });
    expect(reviewQueue({ prs: earlier([]), now: NOW, rounds: [round('REQUEST_CHANGES', 'merged')] }).reviewed[0]).toMatchObject({ why: ['you requested changes', 'merged'] });
    expect(reviewQueue({ prs: earlier([]), now: NOW, rounds: [round('APPROVE', 'open')] }).reviewed[0]).toMatchObject({ why: ['you approved'] });
    // A stored link that isn't a review session the user started (a branch checked out) is no session of the review's.
    const branchLink = prs([], { earlier: [{ repo: 'example-org/termag', number: 5, workstream: session, at: null, source: 'branch' }] });
    expect(reviewQueue({ prs: branchLink, now: NOW, rounds: [round('APPROVE', 'merged')] }).reviewed[0]).toMatchObject({ session: null });
    // Just merged, the PR is still listed, under merged rather than a review lane: its row keeps the tie.
    const ws = { projectId: 'p', projectName: 'termag', workstream: 'termag-pr5' };
    const mergedLane = prs([], { lanes: [{ id: 'merged', label: 'Merged', rows: [row(5, { lane: 'merged' as PrRow['lane'], workstream: ws, linkedBy: 'manual' })] }] });
    expect(reviewQueue({ prs: mergedLane, now: NOW, rounds: [round('APPROVE', 'merged')] }).reviewed[0]).toMatchObject({ session: ws });
  });

  it('keeps an approval finished when a team request lingers in its lane, and reopens it when asked again', () => {
    const round = (askedAgain: boolean): PostedRound => ({
      repo: 'example-org/termag', number: 5, round: 1, headSha: 'aaa', event: 'APPROVE', comments: 0, postedAt: '2026-10-28T11:00:00Z',
      now: { state: 'open', headSha: 'aaa', askedAgain, title: 'PR 5', author: 'e2e-fabian', url: 'https://github.com/example-org/termag/pull/5' },
    });
    const lingering = prs([row(5, { lane: 'team_review', askedYou: false })]);
    const kept = reviewQueue({ prs: lingering, now: NOW, rounds: [round(false)] });
    expect(kept.items).toEqual([]);
    expect(kept.reviewed.map(i => i.number)).toEqual([5]);
    const asked = reviewQueue({ prs: prs([row(5)]), now: NOW, rounds: [round(true)] });
    expect(asked.items.map(i => [i.number, i.section])).toEqual([[5, 'to-review']]);
    expect(asked.reviewed).toEqual([]);
  });

  it('knows a head was approved by its SHA, not by a round number a reviewer may give again', () => {
    const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
    const latest: PostedRound = {
      repo: 'Example-Org/termag', number: 5, round: 3, headSha: c, event: 'COMMENT', comments: 1, postedAt: '2026-10-29T11:00:00Z', now: null,
      earlier: [{ round: 1, headSha: a, event: 'REQUEST_CHANGES', comments: 3, postedAt: '2026-10-28T11:00:00Z' }, { round: 2, headSha: b, event: 'APPROVE', comments: 0, postedAt: '2026-10-29T10:00:00Z' }],
    };
    expect(approvedSince([latest], 'example-org/termag', 5, 'BBBBBBB')).toBe(true);      // b, short and in capitals
    expect(approvedSince([latest], 'example-org/termag', 5, c)).toBe(false);              // the latest head: commented, not approved
    expect(approvedSince([latest], 'example-org/termag', 5, 'd'.repeat(40))).toBe(false); // a head never reviewed, whatever its round
    expect(approvedSince([latest], 'example-org/termag', 6, b)).toBe(false);
    expect(postedAt([latest], 'example-org/termag', 5, a).map(x => x.round)).toEqual([1]);
  });

  it('folds deferred requests away, and shows a grouped PR only in its group', () => {
    const q = reviewQueue({
      prs: prs([row(1), row(2), row(3)], {
        deferred: [{ key: 'example-org/termag#2', until: '2026-10-29T12:00:00Z' }],
        groups: [{ id: 'g', name: 'Port forward', closedAt: null, createdAt: '', done: false, members: [
          { repo: 'example-org/termag', number: 3, note: null, title: 'PR 3', url: '', author: 'e2e-fabian', state: 'open', yourReview: null, askedYou: true, checked: false, row: null, inLane: true },
        ] }],
      }),
      now: NOW,
    });
    expect(q.items.map(i => i.number)).toEqual([1]);
    expect(q.deferred.map(i => i.number)).toEqual([2]);
    expect(q.groups.map(g => [g.group.name, g.left])).toEqual([['Port forward', 1]]);
  });

  it("lists a grouped request's review session in the sidebar, though the group's card shows the request", () => {
    const ws = { projectId: 'p', projectName: 'termag', workstream: 'termag-pr3' };
    const q = reviewQueue({
      prs: prs([row(3, { workstream: ws, linkedBy: 'manual' }), row(4)], {
        groups: [{ id: 'g', name: 'Port forward', closedAt: null, createdAt: '', done: false, members: [3, 4].map(number => (
          { repo: 'example-org/termag', number, note: null, title: `PR ${number}`, url: '', author: 'e2e-fabian', state: 'open', yourReview: null, askedYou: true, checked: false, row: null, inLane: true }
        )) }],
      }),
      now: NOW, sessionState: () => 'done' as const,
    });
    expect(q.items.map(i => i.number)).toEqual([3]);           // Your call: a finished review session, outside the card
    expect(sidebarItems(q).map(i => i.number)).toEqual([3]);
    const idle = reviewQueue({ prs: prs([row(3, { workstream: ws, linkedBy: 'manual' })], {
      groups: [{ id: 'g', name: 'Port forward', closedAt: null, createdAt: '', done: false, members: [
        { repo: 'example-org/termag', number: 3, note: null, title: 'PR 3', url: '', author: 'e2e-fabian', state: 'open', yourReview: null, askedYou: true, checked: false, row: null, inLane: true },
      ] }],
    }), now: NOW, sessionState: () => 'off' as const });
    expect(idle.items).toEqual([]);                               // the card shows the request
    expect(sidebarItems(idle).map(i => [i.number, !!i.session])).toEqual([[3, true]]);
  });

  it("lists a deferred request's review session in the sidebar: a deferral hides the request, not the session", () => {
    const ws = { projectId: 'p', projectName: 'termag', workstream: 'termag-pr2' };
    const q = reviewQueue({
      prs: prs([row(2, { workstream: ws, linkedBy: 'manual' })], { deferred: [{ key: 'example-org/termag#2', until: '2026-10-29T12:00:00Z' }] }),
      now: NOW, sessionState: () => 'off' as const,
    });
    expect(q.deferred.map(i => i.number)).toEqual([2]);
    expect(sidebarItems(q).map(i => [i.number, !!i.session])).toEqual([[2, true]]);
  });

  it("matches a group's members without case, as the lab stores them: no PR twice, none of yours left", () => {
    const member = (number: number, author: string) => ({ repo: 'example-org/termag', number, note: null, title: `PR ${number}`, url: '', author, state: 'open' as const, yourReview: null, askedYou: true, checked: false, row: null, inLane: true });
    const q = reviewQueue({
      prs: prs([row(3, { repo: 'Example-Org/termag' }), row(4, { repo: 'Example-Org/termag' })], {
        groups: [{ id: 'g', name: 'Port forward', closedAt: null, createdAt: '', done: false, members: [member(3, 'e2e-fabian'), member(4, 'E2E-Octocat')] }],
      }),
      now: NOW,
    });
    expect(q.items.map(i => i.number)).toEqual([]);
    expect(q.groups[0].left).toBe(1);
  });

  it("counts and opens the same members left in a group: never a closed one, nor yours", () => {
    const member = (number: number, state: 'open' | 'closed' | 'merged', author = 'e2e-fabian') => ({ repo: 'example-org/termag', number, note: null, title: `PR ${number}`, url: '', author, state, yourReview: null, askedYou: true, checked: false, row: null, inLane: true });
    const group = { id: 'g', name: 'Port forward', closedAt: null, createdAt: '', done: false, members: [member(1, 'closed'), member(2, 'open', 'e2e-octocat'), member(3, 'merged'), member(4, 'open')] };
    const q = reviewQueue({ prs: prs([], { groups: [group] }), now: NOW });
    expect(q.groups[0].left).toBe(1);
    expect(leftToReview(group, 'e2e-octocat').map(m => m.number)).toEqual([4]);
    expect(leftToReview({ ...group, members: group.members.slice(0, 3) }, 'e2e-octocat')).toEqual([]);
  });
});

describe('PR references', () => {
  it('reads a GitHub URL, owner/name#N and the GitHub-shaped termag path', () => {
    expect(parsePrRef('https://github.com/example-org/termag/pull/804/files')).toEqual({ repo: 'example-org/termag', number: 804 });
    expect(parsePrRef('example-org/webapp#76240')).toEqual({ repo: 'example-org/webapp', number: 76240 });
    expect(parsePrRef('https://example.test/termag/chat/gh/example-org/termag/pull/12')).toEqual({ repo: 'example-org/termag', number: 12 });
    expect(parsePrRef('termag#12')).toBeNull();
  });

  it('builds the page path and the same list on GitHub', () => {
    expect(prPath('example-org/termag', 804)).toBe('/chat/pr/example-org/termag/804');
    expect(decodeURIComponent(githubListUrl('to-review')!)).toContain('user-review-requested:@me');
    expect(githubListUrl('your-call')).toBeNull();
  });
});

describe('review filters', () => {
  const people = (approved: string[] = [], changes: string[] = []) => ({ approved, changes, commented: [], botsApproved: [], botsChanges: [] });
  const f = (over: Partial<QueueFilters>): QueueFilters => ({ ...NO_FILTERS, ...over });
  const queue = () => reviewQueue({
    prs: prs([
      row(1, { title: 'Port forward a box', reviewDecision: 'REVIEW_REQUIRED', reviewers: people() }),
      row(2, { repo: 'example-org/webapp', url: 'https://github.com/example-org/webapp/pull/2', reviewDecision: 'APPROVED', reviewers: people(['alice']) }),
      row(3, { lane: 'team_review', askedYou: false, author: 'dependabot', badges: ['draft'], reviewDecision: 'CHANGES_REQUESTED', reviewers: people([], ['bob']) }),
      row(4, { lane: 'team_review', askedYou: false, author: 'devin-ai-integration', checksFailed: true, reviewDecision: null, reviewers: people() }),
    ]),
    now: NOW,
  });

  it('reads the review state from GitHub, and from people when the repo requires no review', () => {
    const subject = (extra: Partial<PrRow>) => ({ repo: 'a/b', number: 1, title: '', author: null, row: row(1, extra) });
    expect(reviewStateOf(subject({ reviewDecision: 'APPROVED', reviewers: null }))).toBe('approved');
    expect(reviewStateOf(subject({ reviewDecision: 'CHANGES_REQUESTED', reviewers: null }))).toBe('changes');
    // GitHub still wants a review (a second approver, a code owner): not approved yet, whoever approved.
    expect(reviewStateOf(subject({ reviewDecision: 'REVIEW_REQUIRED', reviewers: people(['alice']) }))).toBe('none');
    expect(reviewStateOf(subject({ reviewDecision: null, reviewers: people(['alice']) }))).toBe('approved');
    expect(reviewStateOf(subject({ reviewDecision: null, reviewers: people(['alice'], ['bob']) }))).toBe('changes');
    // A bot's approval is not a person's.
    expect(reviewStateOf(subject({ reviewDecision: null, reviewers: { ...people(), botsApproved: ['cursor'] } }))).toBe('none');
    // An older backend says nothing: unknown, which no review-state filter matches.
    expect(reviewStateOf(subject({}))).toBe('unknown');
    expect(reviewStateOf({ repo: 'a/b', number: 1, title: '', author: null, row: null })).toBe('unknown');
  });

  it('tells bots from people by login', () => {
    expect(['dependabot', 'dependabot[bot]', 'Devin-AI-Integration', 'renovate[bot]', 'some-app[bot]', 'github-actions'].every(isBotAuthor)).toBe(true);
    expect(['alice', 'e2e-fabian', null].some(isBotAuthor)).toBe(false);
  });

  it('filters every section by repository, review state, author, bots, draft, CI and text', () => {
    const q = queue();
    const nums = (x: QueueFilters) => filterQueue(q, x).items.map(i => i.number);
    expect(nums(NO_FILTERS)).toEqual([1, 2, 3, 4]);
    expect(nums(f({ repos: ['example-org/termag'] }))).toEqual([1, 3, 4]);
    expect(nums(f({ repos: ['Example-Org/Webapp', 'example-org/termag'] }))).toEqual([1, 2, 3, 4]);
    expect(nums(f({ review: 'not-approved' }))).toEqual([1, 3, 4]);
    expect(nums(f({ review: 'approved' }))).toEqual([2]);
    expect(nums(f({ review: 'changes' }))).toEqual([3]);
    expect(nums(f({ hideBots: true }))).toEqual([1, 2]);
    expect(nums(f({ author: 'DEPENDABOT' }))).toEqual([3]);
    expect(nums(f({ draft: 'draft' }))).toEqual([3]);
    expect(nums(f({ draft: 'ready' }))).toEqual([1, 2, 4]);
    expect(nums(f({ ciFailing: true }))).toEqual([4]);
    expect(nums(f({ q: 'port FORWARD' }))).toEqual([1]);
    expect(nums(f({ q: '#2' }))).toEqual([2]);
    expect(nums(f({ q: 'webapp#2' }))).toEqual([2]);
    expect(nums(f({ repos: ['example-org/termag'], review: 'not-approved', hideBots: true }))).toEqual([1]);
  });

  it('counts each section after filtering, a group card counted while any member matches', () => {
    const member = (number: number, extra: Record<string, unknown> = {}) => ({ repo: 'example-org/termag', number, note: null, title: `PR ${number}`, url: '', author: 'alice', state: 'open' as const, yourReview: null, askedYou: true, checked: false, row: null, inLane: true, reviewers: people(), ...extra });
    const q = reviewQueue({
      prs: prs([row(1, { reviewDecision: null, reviewers: people() }), row(2, { lane: 'team_review', askedYou: false, reviewDecision: 'APPROVED', reviewers: people() })], {
        groups: [{ id: 'g', name: 'Port forward', closedAt: null, createdAt: '', done: false, members: [member(5, { reviewers: people(['bob']) }), member(6, { reviewers: people(['bob']) })] }],
      }),
      now: NOW,
    });
    expect(sectionCounts(filterQueue(q, NO_FILTERS))).toMatchObject({ 'to-review': 2, team: 1 });
    const open = filterQueue(q, f({ review: 'not-approved' }));
    expect(open.groups).toEqual([]);
    expect(sectionCounts(open)).toMatchObject({ 'to-review': 1, team: 0 });
    expect(filterQueue(q, f({ review: 'approved' })).groups.map(g => g.group.id)).toEqual(['g']);
  });

  it('matches a number exactly, never a longer one that starts with it', () => {
    const q = reviewQueue({ prs: prs([row(2), row(20), row(21), row(123), row(12, { title: 'bump vite 7.1.2' })]), now: NOW });
    const nums = (text: string) => filterQueue(q, f({ q: text })).items.map(i => i.number).sort((a, b) => a - b);
    expect(nums('#2')).toEqual([2]);
    expect(nums('2')).toEqual([2]);
    expect(nums('12')).toEqual([12]);
    expect(nums('termag#12')).toEqual([12]);
    expect(nums('example-org/termag#2')).toEqual([2]);
    expect(nums('webapp#2')).toEqual([]);
    // Text that isn't a reference still searches the titles.
    expect(nums('vite 7.1')).toEqual([12]);
  });

  it('shows one note: nothing to review, or nothing matching the filters', () => {
    const empty = reviewQueue({ prs: prs([]), now: NOW });
    const some = queue();
    const state = { loading: false, failed: false, disconnected: false };
    expect(queueNote(empty, empty, NO_FILTERS, state)).toBe('nothing');
    // Filters set over a queue with nothing to review: only "nothing asks for your review".
    expect(queueNote(empty, filterQueue(empty, f({ review: 'approved' })), f({ review: 'approved' }), state)).toBe('nothing');
    const deferredOnly = { ...empty, deferred: some.items.slice(0, 1) };
    expect(queueNote(deferredOnly, filterQueue(deferredOnly, f({ q: 'zzz' })), f({ q: 'zzz' }), state)).toBe('nothing');
    expect(queueNote(some, filterQueue(some, f({ q: 'zzz' })), f({ q: 'zzz' }), state)).toBe('no-match');
    expect(queueNote(some, filterQueue(some, f({ q: 'port' })), f({ q: 'port' }), state)).toBe(null);
    expect(queueNote(some, some, NO_FILTERS, state)).toBe(null);
    for (const s of [{ ...state, loading: true }, { ...state, failed: true }, { ...state, disconnected: true }]) {
      expect(queueNote(empty, empty, f({ q: 'zzz' }), s)).toBe(null);
    }
  });

  it("reads a group member's own GitHub decision, whatever lane its row is from", () => {
    const authored = row(7, { lane: 'needs_approval', askedYou: undefined, reviewDecision: 'REVIEW_REQUIRED', reviewers: undefined });
    expect(reviewStateOf({ repo: 'example-org/termag', number: 7, title: '', author: 'e2e-octocat', row: authored, reviewers: people(['bob']) })).toBe('none');
  });

  it("shows only a group card's matching members, and how many the filters hide", () => {
    const member = (repo: string, number: number) => ({ repo, number, note: null, title: `PR ${number}`, url: '', author: 'alice', state: 'open' as const, yourReview: null, askedYou: true, checked: false, row: null, inLane: true, reviewers: people() });
    const group = { id: 'g', name: 'Port forward', closedAt: null, createdAt: '', done: false, members: [member('example-org/termag', 5), member('example-org/webapp', 6), member('example-org/termag', 7)] };
    const q = reviewQueue({ prs: prs([], { groups: [group] }), now: NOW });
    const g = filterQueue(q, f({ repos: ['example-org/termag'] })).groups[0];
    expect(g.shown!.map(m => m.number)).toEqual([5, 7]);
    expect(g.group.members).toHaveLength(3);
    expect(g.left).toBe(2);
    expect(filterQueue(q, NO_FILTERS).groups[0].shown).toBeUndefined();
  });

  it('a link that names filters becomes the remembered choice; a bare one brings the remembered choice back', () => {
    const last = f({ review: 'approved' });
    expect(filtersOnOpen(new URLSearchParams('review=not-approved'), last)).toEqual({ remember: f({ review: 'not-approved' }) });
    expect(filtersOnOpen(new URLSearchParams(''), last)).toEqual({ apply: last });
    expect(filtersOnOpen(new URLSearchParams(''), NO_FILTERS)).toEqual({});
    // A link that clears every filter (?review= with nothing) is a choice too.
    expect(filtersOnOpen(new URLSearchParams('review='), last)).toEqual({ remember: NO_FILTERS });
  });

  it('offers the repositories and authors the queue holds, once each', () => {
    const o = filterOptions(queue());
    expect(o.repos).toEqual(['example-org/termag', 'example-org/webapp']);
    expect(o.authors).toEqual(['dependabot', 'devin-ai-integration', 'e2e-fabian']);
  });

  it('says when any filter is set', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters(f({ q: '  ' }))).toBe(false);
    expect(hasFilters(f({ hideBots: true }))).toBe(true);
  });

  it('round-trips through the URL, keeping its other parameters, and drops values it does not know', () => {
    const all = f({ repos: ['example-org/termag', 'example-org/webapp'], review: 'not-approved', author: 'alice', hideBots: true, draft: 'ready', ciFailing: true, q: 'port #12' });
    const params = filtersToSearch(all, new URLSearchParams('tab=x&review=approved'));
    expect(params.get('tab')).toBe('x');
    expect(filtersFromSearch(params)).toEqual(all);
    expect(params.toString()).toBe('tab=x&review=not-approved&repo=example-org%2Ftermag&repo=example-org%2Fwebapp&author=alice&bots=hide&draft=ready&ci=failing&q=port+%2312');
    expect(filtersToSearch(NO_FILTERS, params).toString()).toBe('tab=x');
    expect(filtersFromSearch(new URLSearchParams('review=maybe&draft=x&ci=1&bots=show&repo=not a repo'))).toEqual(NO_FILTERS);
  });

  it("remembers the last choice per user, and a user's own only", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    writeRememberedFilters(storage, 'zane', f({ review: 'not-approved', repos: ['example-org/termag'] }));
    expect(readRememberedFilters(storage, 'zane')).toEqual(f({ review: 'not-approved', repos: ['example-org/termag'] }));
    expect(readRememberedFilters(storage, 'alice')).toEqual(NO_FILTERS);
    expect(readRememberedFilters(storage, null)).toEqual(NO_FILTERS);
    store.set('termag.chat.reviewFilters.zane', '%%garbage');
    expect(readRememberedFilters(storage, 'zane')).toEqual(NO_FILTERS);
  });

  it('matches a row with no lane data only on what it has', () => {
    const it0 = { repo: 'example-org/termag', number: 9, title: 'x', author: 'alice', row: null };
    expect(matchesFilters(it0, f({ repos: ['example-org/termag'] }))).toBe(true);
    expect(matchesFilters(it0, f({ review: 'not-approved' }))).toBe(false);
    expect(matchesFilters(it0, f({ draft: 'ready' }))).toBe(false);
  });
});
