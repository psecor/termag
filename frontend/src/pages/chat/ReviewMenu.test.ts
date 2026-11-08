import { describe, expect, it, vi } from 'vitest';
import type { PrGroupMember, PrReviewGroup } from '../../services/api';
import { groupReviewPlan } from '../../utils/prReviewGroups';
import { clearStarting, markStarting, noRunReason, noteStartingBefore, openPlan, runReviewStart, startingFor } from './ReviewMenu';

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
    expect(noRunReason('example-org/terraform', false)).toBe('No project on terraform yet. Start a New session on example-org/terraform, and Review runs there.');
    expect(noRunReason('example-org/terraform', true))
      .toBe('No project on terraform, and no box to clone it on. Start a New session on example-org/terraform (it can make a box too), and Review runs there.');
    expect(noRunReason(undefined, true)).toBe('Nowhere to run it');
    expect(noRunReason('example-org/terraform', true, true))
      .toBe("No project on terraform, and your boxes couldn't be read to clone it onto. Reload the page to try again.");
    expect(noRunReason('example-org/terraform', false, false, true))
      .toBe("Your projects couldn't be read to find one on terraform. Reload the page to try again.");
  });
});

describe('a review started in its session', () => {
  const at = { projectId: 'p20', workstream: 'main' };
  const begin = (id = 's1') => markStarting(at.projectId, at.workstream, { reviewer: 'Devin', repo: 'example-org/termag', number: 1, at: 0, before: [], pending: true, step: 'Starting the review…', id });
  const deps = (held: Array<{ state: 'waking' | 'starting' | 'failed'; box: string; error?: string; since?: number } | null>) => {
    const seq = [...held];
    const steps: Array<string | undefined> = [];
    return {
      steps,
      readHeld: vi.fn(async () => { const h = seq.length > 1 ? seq.shift()! : seq[0]; return h; }),
      sleep: async () => { steps.push(startingFor(at.projectId, at.workstream)?.step); },
      now: () => 42,
    };
  };

  it('starts at once when the box is up, and the wait for its pane begins', async () => {
    begin();
    const d = deps([null]);
    await runReviewStart(at, 's1', async () => ({}), d);
    expect(d.readHeld).not.toHaveBeenCalled();
    expect(startingFor(at.projectId, at.workstream)).toMatchObject({ pending: false, step: undefined, at: 42 });
  });

  it('follows a start the route holds while its box wakes, step by step', async () => {
    begin();
    const d = deps([{ state: 'waking', box: 'termag-20', since: 1000 }, { state: 'starting', box: 'termag-20', since: 1000 }, null]);
    await runReviewStart(at, 's1', async () => ({ held: true, box: 'termag-20' }), d);
    expect(d.steps).toEqual(['Waking termag-20…', 'Waking termag-20…', 'Starting the review…']);
    expect(startingFor(at.projectId, at.workstream)?.heldSince).toBe(1000);
    expect(startingFor(at.projectId, at.workstream)).toMatchObject({ pending: false, step: undefined });
    expect(startingFor(at.projectId, at.workstream)?.error).toBeUndefined();
  });

  it('shows what to do in the session when the held start fails', async () => {
    begin();
    const d = deps([{ state: 'failed', box: 'termag-20', error: 'termag-20 took too long to wake. Start termag-20 from your boxes, then Review again.' }]);
    await runReviewStart(at, 's1', async () => ({ held: true, box: 'termag-20' }), d);
    expect(startingFor(at.projectId, at.workstream)).toMatchObject({
      pending: false, error: 'termag-20 took too long to wake. Start termag-20 from your boxes, then Review again.',
    });
  });

  it('shows the start\'s refusal in the session', async () => {
    begin();
    const refused = { response: { status: 409, data: { error: 'termag-20 is stopped, and only its owner can start it. Ask them to, then Review again.' } } };
    await runReviewStart(at, 's1', async () => { throw refused; }, deps([null]));
    expect(startingFor(at.projectId, at.workstream)).toMatchObject({
      pending: false, error: 'termag-20 is stopped, and only its owner can start it. Ask them to, then Review again.',
    });
  });

  it('leaves a later start\'s entry alone', async () => {
    begin('s1');
    const d = deps([{ state: 'failed', box: 'termag-20', error: 'late failure' }]);
    // A second Review replaced the entry while the first followed its held start.
    d.sleep = async () => { begin('s2'); };
    await runReviewStart(at, 's1', async () => ({ held: true, box: 'termag-20' }), d);
    expect(startingFor(at.projectId, at.workstream)).toMatchObject({ id: 's2', pending: true, step: 'Starting the review…' });
    expect(startingFor(at.projectId, at.workstream)?.error).toBeUndefined();
  });

  it('keeps a pane listed while the start is pending with the earlier ones, and none once it answered', () => {
    begin('s3');
    noteStartingBefore(at.projectId, at.workstream, '2026-11-06T17:00:00Z');
    noteStartingBefore(at.projectId, at.workstream, '2026-11-06T17:00:00Z');
    expect(startingFor(at.projectId, at.workstream)?.before).toEqual(['2026-11-06T17:00:00Z']);
    markStarting(at.projectId, at.workstream, { ...startingFor(at.projectId, at.workstream)!, pending: false });
    noteStartingBefore(at.projectId, at.workstream, '2026-11-06T17:05:00Z');
    expect(startingFor(at.projectId, at.workstream)?.before).toEqual(['2026-11-06T17:00:00Z']);
  });

  it('stops following once dismissed', async () => {
    begin();
    const d = deps([{ state: 'waking', box: 'termag-20' }]);
    d.sleep = async () => { clearStarting(at.projectId, at.workstream); };
    await runReviewStart(at, 's1', async () => ({ held: true, box: 'termag-20' }), d);
    expect(d.readHeld).not.toHaveBeenCalled();
    expect(startingFor(at.projectId, at.workstream)).toBeNull();
  });
});
