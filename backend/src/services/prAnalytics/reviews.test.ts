import { describe, it, expect } from 'vitest';
import { reviewFields, reviewRows, reviewTrend, reviewWindow, topReviewers, type RPr, type RReview } from './reviews';
import { DEFAULT_AGENT_LOGINS, DEFAULT_BOT_LOGINS } from './classify';
import type { PrNode } from './sync';

const lists = { agentLogins: DEFAULT_AGENT_LOGINS, botLogins: DEFAULT_BOT_LOGINS };
const NOW = new Date('2026-10-23T12:00:00Z');
const at = (iso: string) => new Date(iso);
const since = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const pr = (id: string, o: Partial<RPr> = {}): RPr => ({
  id, repo: 'example-org/termag', author: 'ada', credited: 'ada', readyAt: at('2026-10-20T00:00:00Z'), createdAt: at('2026-10-20T00:00:00Z'),
  mergedAt: null, comments: 0, humanComments: 0, reviewsRead: true, requests: [], ...o,
});
const rv = (prId: string, login: string, state: string, iso: string, o: Partial<RReview> = {}): RReview =>
  ({ prId, login, cls: 'human', state, submittedAt: at(iso), comments: 0, ...o });
const agent = (prId: string, iso: string): RReview => rv(prId, 'cursor', 'APPROVED', iso, { cls: 'agent' });
const AGENT_REPOS = new Set(['example-org/termag']);

describe('ingest', () => {
  const node = {
    id: 'PR1', number: 1, state: 'MERGED', isDraft: false, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z',
    mergedAt: '2026-10-21T00:00:00Z', closedAt: '2026-10-21T00:00:00Z', baseRefName: 'main', additions: 1, deletions: 1, changedFiles: 1, body: '',
    author: { login: 'Ada', __typename: 'User' }, commits: { nodes: [] },
    reviews: { totalCount: 3, nodes: [
      { id: 'R1', author: { login: 'cursor', __typename: 'Bot' }, state: 'COMMENTED', submittedAt: '2026-10-20T01:00:00Z', comments: { totalCount: 4 } },
      { id: 'R2', author: { login: 'Grace', __typename: 'User' }, state: 'APPROVED', submittedAt: '2026-10-20T02:00:00Z', comments: { totalCount: 1 } },
      { id: 'R3', author: { login: 'grace', __typename: 'User' }, state: 'PENDING', submittedAt: null, comments: { totalCount: 0 } },
      { id: 'R4', author: { login: 'ada', __typename: 'User' }, state: 'COMMENTED', submittedAt: '2026-10-20T03:00:00Z', body: 'Looks good.\n\nReviewed by Devin', comments: { totalCount: 0 } },
    ] },
    comments: { totalCount: 3, nodes: [{ author: { login: 'grace', __typename: 'User' } }, { author: { login: 'example-org', __typename: 'Bot' } }, { author: null }] },
    timelineItems: { nodes: [
      { __typename: 'ReadyForReviewEvent', createdAt: '2026-10-20T00:10:00Z' },
      { __typename: 'ReviewRequestedEvent', createdAt: '2026-10-20T00:20:00Z', requestedReviewer: { __typename: 'User', login: 'Grace' } },
      { __typename: 'ReviewRequestedEvent', createdAt: '2026-10-20T00:25:00Z', requestedReviewer: { __typename: 'Team', slug: 'Team-Flags' } },
      { __typename: 'ReviewRequestedEvent', createdAt: '2026-10-20T00:26:00Z', requestedReviewer: null },
      { __typename: 'ReadyForReviewEvent', createdAt: '2026-10-20T00:30:00Z' },
    ] },
  } as PrNode;

  it('stores submitted reviews with the reviewer class, skipping pending ones', () => {
    expect(reviewRows(node, lists)).toEqual([
      { id: 'R1', reviewerLogin: 'cursor', reviewerClass: 'agent', state: 'COMMENTED', submittedAt: at('2026-10-20T01:00:00Z'), comments: 4 },
      { id: 'R2', reviewerLogin: 'grace', reviewerClass: 'human', state: 'APPROVED', submittedAt: at('2026-10-20T02:00:00Z'), comments: 1 },
      // Devin posting with a person's token is an agent review.
      { id: 'R4', reviewerLogin: 'ada', reviewerClass: 'agent', state: 'COMMENTED', submittedAt: at('2026-10-20T03:00:00Z'), comments: 0 },
    ]);
  });
  it('counts comments by people, and takes the last ready event and the review requests', () => {
    expect(reviewFields(node, lists, NOW)).toEqual({
      readyAt: at('2026-10-20T00:30:00Z'), comments: 3, humanComments: 1, reviewCount: 3, reviewsReadAt: NOW,
      reviewRequests: [{ who: 'grace', at: '2026-10-20T00:20:00Z' }, { who: 'team:team-flags', at: '2026-10-20T00:25:00Z' }],
    });
    expect(reviewFields({ ...node, timelineItems: { nodes: [] } }, lists, NOW)!.readyAt).toEqual(at('2026-10-20T00:00:00Z'));
    expect(reviewFields({ ...node, reviews: undefined }, lists, NOW)).toBeNull();
  });
});

describe('reviewWindow', () => {
  it('counts one review per person per PR, and leaves out bots and the author', () => {
    const prs = [pr('a'), pr('b', { author: 'devin-ai-integration', credited: 'grace' })];
    const reviews = [
      rv('a', 'grace', 'COMMENTED', '2026-10-21T00:00:00Z', { comments: 2 }),
      rv('a', 'grace', 'COMMENTED', '2026-10-21T01:00:00Z', { comments: 3 }),
      rv('a', 'grace', 'APPROVED', '2026-10-21T02:00:00Z'),
      rv('a', 'linus', 'CHANGES_REQUESTED', '2026-10-21T00:00:00Z'),
      rv('a', 'ada', 'COMMENTED', '2026-10-21T00:00:00Z'),                 // the author
      rv('b', 'grace', 'COMMENTED', '2026-10-21T00:00:00Z'),               // credited to grace: her own
      rv('a', 'cursor', 'COMMENTED', '2026-10-21T00:00:00Z', { cls: 'agent', comments: 9 }),
      rv('a', 'old', 'APPROVED', '2026-09-01T00:00:00Z'),                  // before the window
    ];
    const w = reviewWindow(prs, reviews, since(30), NOW, AGENT_REPOS);
    expect(w.reviews).toBe(2);
    expect(w.distribution).toMatchObject({ contributors: 2, max: 1 });
    expect([w.approved, w.changesRequested, w.commentOnly]).toEqual([1, 1, 0]);
    expect(w.inlineComments).toBe(5);
  });

  it('splits merged PRs by approval, only in agent repos and only approvals before the merge', () => {
    const m = (id: string, o: Partial<RPr> = {}) => pr(id, { mergedAt: at('2026-10-22T00:00:00Z'), ...o });
    const prs = [m('agentOnly'), m('both'), m('human'), m('none'), m('late'), m('other', { repo: 'example-org/webapp' }), m('unread', { reviewsRead: false })];
    const reviews = [
      agent('agentOnly', '2026-10-21T00:00:00Z'),
      agent('both', '2026-10-21T00:00:00Z'), rv('both', 'grace', 'APPROVED', '2026-10-21T00:00:00Z'),
      rv('human', 'grace', 'APPROVED', '2026-10-21T00:00:00Z'),
      rv('late', 'grace', 'APPROVED', '2026-10-22T05:00:00Z'),            // after the merge
      agent('other', '2026-10-21T00:00:00Z'),
    ];
    expect(reviewWindow(prs, reviews, since(30), NOW, AGENT_REPOS).agent)
      .toEqual({ repos: 1, merged: 5, agentOnly: 1, humanAndAgent: 1, humanOnly: 1, none: 2, unread: 1 });
  });

  it('counts comments by people per merged PR, zeros included, and the bot share', () => {
    const m = (id: string, o: Partial<RPr>) => pr(id, { mergedAt: at('2026-10-22T00:00:00Z'), ...o });
    const prs = [m('a', { comments: 5, humanComments: 2 }), m('b', {}), m('c', { comments: 1, humanComments: 1 })];
    const reviews = [rv('a', 'grace', 'COMMENTED', '2026-10-21T00:00:00Z', { comments: 4 }), rv('a', 'cursor', 'COMMENTED', '2026-10-21T00:00:00Z', { cls: 'agent', comments: 7 })];
    const w = reviewWindow(prs, reviews, since(30), NOW, AGENT_REPOS);
    expect(w.mergedComments).toMatchObject({ prs: 3, p50: 1, max: 6 });
    expect(w.mergedComments.botShare).toBeCloseTo(10 / 17, 5);
  });

  it('counts bots only among the comments read, on a PR with more than were read', () => {
    const prs = [pr('busy', { mergedAt: at('2026-10-22T00:00:00Z'), comments: 250, humanComments: 40 })];
    expect(reviewWindow(prs, [], since(30), NOW, AGENT_REPOS).mergedComments.botShare).toBeCloseTo(60 / 100, 5);
  });

  it('counts a dismissed review as neither an approval nor changes', () => {
    const w = reviewWindow([pr('a')], [rv('a', 'grace', 'DISMISSED', '2026-10-21T00:00:00Z')], since(30), NOW, AGENT_REPOS);
    expect([w.reviews, w.approved, w.changesRequested, w.commentOnly]).toEqual([1, 0, 0, 1]);
  });

  it('leaves PRs whose reviews were cut short out of the split and deciding approvals', () => {
    const prs = [pr('big', { mergedAt: at('2026-10-22T00:00:00Z'), reviewsRead: false })];
    const reviews = [rv('big', 'grace', 'APPROVED', '2026-10-21T00:00:00Z')];
    expect(reviewWindow(prs, reviews, since(30), NOW, AGENT_REPOS).agent).toMatchObject({ merged: 0, unread: 1 });
    expect(topReviewers(prs, reviews, since(30), NOW)[0]).toMatchObject({ reviews: 1, decidingApprovals: 0 });
  });
});

describe('topReviewers', () => {
  it('credits the last human approval before the merge, and counts authors', () => {
    const prs = [
      pr('a', { mergedAt: at('2026-10-22T00:00:00Z') }),
      pr('b', { author: 'linus', credited: 'linus', readyAt: at('2026-10-21T00:00:00Z') }),
      pr('c', { author: 'linus', credited: 'linus', readyAt: at('2026-10-21T10:00:00Z') }),
    ];
    const reviews = [
      rv('a', 'grace', 'APPROVED', '2026-10-20T04:00:00Z'),
      rv('a', 'hopper', 'APPROVED', '2026-10-21T00:00:00Z'),
      agent('a', '2026-10-21T06:00:00Z'),
      rv('b', 'grace', 'COMMENTED', '2026-10-21T02:00:00Z'),
      rv('b', 'grace', 'APPROVED', '2026-10-21T08:00:00Z'),
      rv('c', 'grace', 'COMMENTED', '2026-10-21T08:00:00Z'),               // on the draft, before ready
    ];
    const top = topReviewers(prs, reviews, since(30), NOW);
    const g = top.find(r => r.login === 'grace')!;
    expect(g).toMatchObject({ reviews: 3, approved: 2, commentOnly: 1, decidingApprovals: 0, authorsHelped: 2, medianHoursToFirstReview: null });
    expect(top.find(r => r.login === 'hopper')).toMatchObject({ reviews: 1, decidingApprovals: 1 });
    expect(top[0].login).toBe('grace');
  });
});

describe('time to first review and stale pickups', () => {
  const req = (who: string, iso: string) => ({ who, at: at(iso) });
  it('times only reviews they were asked for by name, from the latest such request', () => {
    const prs = [
      pr('named', { requests: [req('grace', '2026-10-20T00:00:00Z'), req('grace', '2026-10-21T00:00:00Z')] }),
      pr('named2', { requests: [req('grace', '2026-10-21T00:00:00Z')] }),
      pr('team', { requests: [req('team:flags', '2026-10-21T00:00:00Z')] }),         // a team request isn't asking her
      pr('late', { requests: [req('grace', '2026-10-22T00:00:00Z')] }),              // asked after she reviewed
    ];
    const reviews = [
      rv('named', 'grace', 'COMMENTED', '2026-10-21T03:00:00Z'), rv('named2', 'grace', 'COMMENTED', '2026-10-21T05:00:00Z'),
      rv('team', 'grace', 'COMMENTED', '2026-10-21T12:00:00Z'), rv('late', 'grace', 'COMMENTED', '2026-10-21T06:00:00Z'),
    ];
    expect(topReviewers(prs, reviews, since(30), NOW)[0]).toMatchObject({ reviews: 4, askedReviews: 2, medianHoursToFirstReview: 4 });
  });
  it('still times an ask that came after a review on the draft', () => {
    const prs = [pr('draft', { requests: [req('grace', '2026-10-21T00:00:00Z')] })];
    const reviews = [rv('draft', 'grace', 'COMMENTED', '2026-10-19T00:00:00Z'), rv('draft', 'grace', 'APPROVED', '2026-10-21T06:00:00Z')];
    expect(topReviewers(prs, reviews, since(30), NOW)[0]).toMatchObject({ askedReviews: 1, medianHoursToFirstReview: 6 });
  });
  it('counts PRs they reviewed first after the PR waited three days since ready', () => {
    const prs = [pr('old', { readyAt: at('2026-10-01T00:00:00Z') }), pr('fresh'), pr('second', { readyAt: at('2026-10-01T00:00:00Z') })];
    const reviews = [
      rv('old', 'grace', 'APPROVED', '2026-10-21T00:00:00Z'),
      rv('fresh', 'grace', 'APPROVED', '2026-10-21T00:00:00Z'),
      rv('second', 'linus', 'COMMENTED', '2026-10-02T00:00:00Z'), rv('second', 'grace', 'APPROVED', '2026-10-21T00:00:00Z'),
    ];
    const top = topReviewers(prs, reviews, since(30), NOW);
    expect(top.find(r => r.login === 'grace')).toMatchObject({ reviews: 3, stalePickups: 1, askedReviews: 0, medianHoursToFirstReview: null });
  });
});

describe('reviewTrend', () => {
  it('buckets Monday weeks, the last one partial', () => {
    const prs = [pr('a', { mergedAt: at('2026-10-14T00:00:00Z') }), pr('b', { mergedAt: at('2026-10-21T00:00:00Z') })];
    const reviews = [agent('a', '2026-10-13T00:00:00Z'), rv('b', 'grace', 'APPROVED', '2026-10-20T00:00:00Z')];
    const w = reviewTrend(prs, reviews, at('2026-10-12T00:00:00Z'), NOW, AGENT_REPOS);
    expect(w).toEqual([
      { week: '2026-10-12', reviews: 0, reviewers: 0, agentOnly: 1, humanApproved: 0, unapproved: 0 },
      { week: '2026-10-19', reviews: 1, reviewers: 1, agentOnly: 0, humanApproved: 1, unapproved: 0 },
    ]);
  });
});
