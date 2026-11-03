import { describe, expect, it } from 'vitest';
import type { PrGroupMember, PrReviewGroup } from '../../services/api';
import { groupReviewPlan } from '../../utils/prReviewGroups';
import { noRunReason, openPlan } from './ReviewMenu';

const pane = { projectId: 'p', projectName: 'termag', workstream: 'termag-pr1' };
const member = (number: number, state: PrGroupMember['state'], extra: Partial<PrGroupMember> = {}): PrGroupMember => ({
  repo: 'example-org/termag', number, note: null, title: `PR ${number}`, url: '', author: 'e2e-fabian', state,
  yourReview: null, askedYou: true, checked: false, row: null, inLane: true, ...extra,
} as PrGroupMember);
const group = (members: PrGroupMember[]): PrReviewGroup => ({ id: 'g', name: 'Port forward', closedAt: null, createdAt: '', done: false, members } as PrReviewGroup);

describe('Review all together', () => {
  it("reviews only the open members, from a closed member's checkout when it's the only one", () => {
    const plan = openPlan(groupReviewPlan(group([member(1, 'merged', { pane }), member(2, 'open'), member(3, 'closed')]), 'e2e-octocat'));
    expect(plan).toEqual({ members: [expect.objectContaining({ number: 2 })], target: pane });
  });

  it('says nothing is left once only closed members are', () => {
    expect(openPlan(groupReviewPlan(group([member(1, 'merged', { pane }), member(3, 'closed')]), 'e2e-octocat'))).toEqual({ reason: 'Nothing left to review in this group' });
  });
});

describe('a Review button with nowhere to run', () => {
  it('says why under it: no project, and with cloning on, no box either', () => {
    expect(noRunReason('example-org/terraform', false)).toBe('No project on terraform');
    expect(noRunReason('example-org/terraform', true)).toBe('No project on terraform, and no box to clone it on');
    expect(noRunReason(undefined, true)).toBe('Nowhere to run it');
  });
});
