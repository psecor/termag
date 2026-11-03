import { describe, expect, it } from 'vitest';
import type { PrPipelineResponse, PrRow } from '../services/api';
import { approvedSince, githubListUrl, postedAt, leftToReview, parsePrRef, prPath, reviewQueue, sidebarItems, type AgentReview, type PostedRound, type SessionState } from './reviews';

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
