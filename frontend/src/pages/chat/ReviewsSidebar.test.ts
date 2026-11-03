import { describe, expect, it } from 'vitest';
import type { PrPipelineResponse, PrRow } from '../../services/api';
import { reviewQueue, type PostedRound } from '../../chat/reviews';
import { sameLink, sidebarCount } from './ReviewsSidebar';

describe("the Reviews section's current row", () => {
  it('is the same page and workstream, never a prefix of another', () => {
    expect(sameLink('/chat/pr/example-org/termag/1', '/chat/pr/example-org/termag/1')).toBe(true);
    expect(sameLink('/chat/pr/example-org/termag/12', '/chat/pr/example-org/termag/1')).toBe(false);
    // A project's main session has no ws in its link: it's not every workstream of the project.
    expect(sameLink('/chat/p/p1?ws=termag-pr804', '/chat/p/p1')).toBe(false);
    expect(sameLink('/chat/p/p1', '/chat/p/p1')).toBe(true);
    expect(sameLink('/chat/p/p1?ws=main', '/chat/p/p1')).toBe(true);
    expect(sameLink('/chat/p/p1?ws=termag-pr804&x=1', '/chat/p/p1?ws=termag-pr804')).toBe(true);
  });
});

describe("the Reviews section's count", () => {
  it('leaves out a PR you reviewed, though GitHub kept its request', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const row = { kind: 'pr', lane: 'needs_my_review', repo: 'example-org/termag', number: 5, title: 'PR 5', url: '', author: 'e2e-fabian', headRefName: 'b5', baseRefName: 'main',
      at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [], blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null,
      requestedAt: '2026-10-28T09:00:00Z', reviewTarget: null, askedYou: true, requestedYou: true } as unknown as PrRow;
    const prs = { connected: true, viewer: 'e2e-octocat', lanes: [{ id: 'needs_my_review', label: '', rows: [row] }, { id: 'team_review', label: '', rows: [] }] } as unknown as PrPipelineResponse;
    expect(sidebarCount(reviewQueue({ prs, now }), prs, now).toReview).toBe(1);
    const round: PostedRound = { repo: 'example-org/termag', number: 5, round: 1, headSha: 'aaa', event: 'COMMENT', comments: 1, postedAt: '2026-10-28T11:00:00Z',
      now: { state: 'open', headSha: 'aaa', askedAgain: false, title: 'PR 5', author: 'e2e-fabian', url: '' } };
    const queue = reviewQueue({ prs, now, rounds: [round] });
    expect(queue.items.map(i => i.section)).toEqual(['waiting']);
    expect(sidebarCount(queue, prs, now)).toEqual({ count: 0, toReview: 0 });
  });
});
