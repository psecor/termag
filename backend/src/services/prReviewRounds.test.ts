import { describe, expect, it } from 'vitest';
import { latestPerPr, type ReviewRound } from './prReviewRounds';

const r = (number: number, round: number, postedAt: string): ReviewRound => ({
  repo: 'example-org/termag', number, round, headSha: 'a'.repeat(40), event: 'COMMENT', comments: 1, title: `PR ${number}`, author: 'e2e-fabian', postedAt,
});

describe('latestPerPr', () => {
  it("keeps each PR's newest round, newest first", () => {
    const got = latestPerPr([r(1, 1, '2026-10-27T10:00:00Z'), r(1, 2, '2026-10-28T10:00:00Z'), r(2, 1, '2026-10-28T11:00:00Z')]);
    expect(got.map(x => [x.number, x.round])).toEqual([[2, 1], [1, 2]]);
  });

  it('carries what was posted in the rounds before, oldest first', () => {
    const [one] = latestPerPr([r(1, 2, '2026-10-28T10:00:00Z'), { ...r(1, 1, '2026-10-27T10:00:00Z'), event: 'REQUEST_CHANGES', comments: 3 }]);
    expect(one.round).toBe(2);
    expect(one.earlier).toEqual([{ round: 1, headSha: expect.any(String), event: 'REQUEST_CHANGES', comments: 3, postedAt: '2026-10-27T10:00:00Z' }]);
  });
});
