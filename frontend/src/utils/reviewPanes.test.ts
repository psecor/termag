import { describe, expect, it } from 'vitest';
import type { SessionReview } from '../types';
import { overlayCovered, panePrLabel, reviewPanes, reviewStartNote, reviewStartPlan, type ReviewPane } from './reviewPanes';

const T = 'https://github.com/example-org/termag/pull/';
const names = { owner: 'ada', project: 'termag', workstream: 'main' };
const review = (over: Partial<SessionReview> = {}): SessionReview => ({
  state: 'reviewing', pr: 646, url: `${T}646`, at: '2026-10-27T00:00:00Z', doneAt: null, seenAt: null, ...over,
});
const pane = (slot: number, pr: number, url: string | null = `${T}${pr}`): ReviewPane =>
  ({ ...review({ pr, url, slot, session: slot === 1 ? 'ada-termag-review' : `ada-termag-review-${slot}` }), session: slot === 1 ? 'ada-termag-review' : `ada-termag-review-${slot}`, slot });

describe('reviewPanes', () => {
  it('lists the status\'s panes in slot order', () => {
    const got = reviewPanes({ reviews: [review({ pr: 648, slot: 3, session: 'ada-termag-review-3' }), review({ slot: 1, session: 'ada-termag-review' })] }, names);
    expect(got.map(p => [p.slot, p.session, p.pr])).toEqual([[1, 'ada-termag-review', 646], [3, 'ada-termag-review-3', 648]]);
  });
  it('reads an older backend\'s one review as slot 1, named like the backend names it', () => {
    expect(reviewPanes({ review: review() }, { ...names, workstream: 'feat' }).map(p => [p.slot, p.session])).toEqual([[1, 'ada-termag-feat-review']]);
    expect(reviewPanes(null, names)).toEqual([]);
  });
  it('lays the optimistic entries over the truth: a start shows or replaces its pane, a stop hides it', () => {
    const status = { reviews: [review({ slot: 1, session: 'ada-termag-review' }), review({ pr: 647, slot: 2, session: 'ada-termag-review-2' })] };
    const got = reviewPanes(status, names, { 'ada-termag-review': 'cleared', 'ada-termag-review-3': { review: pane(3, 700) } });
    expect(got.map(p => [p.slot, p.pr])).toEqual([[2, 647], [3, 700]]);
    expect(reviewPanes(status, names, { 'ada-termag-review-2': { review: pane(2, 701) } }).map(p => p.pr)).toEqual([646, 701]);
  });
  it('says when the truth covers an entry', () => {
    const truth = [pane(1, 646)];
    expect(overlayCovered('cleared', 'ada-termag-review', truth)).toBe(false);
    expect(overlayCovered('cleared', 'ada-termag-review-2', truth)).toBe(true);
    expect(overlayCovered({ review: pane(1, 646) }, 'ada-termag-review', truth)).toBe(true);
  });
});

describe('panePrLabel', () => {
  it('names the repository from the link', () => {
    expect(panePrLabel(28576, 'https://github.com/example-org/terraform/pull/28576')).toBe('terraform#28576');
    expect(panePrLabel(12, null)).toBe('PR #12');
    expect(panePrLabel(null, null)).toBeNull();
  });
});

describe('reviewStartPlan and its note', () => {
  it('starts the first review with nothing to say', () => {
    const plan = reviewStartPlan([], { pr: 1, url: `${T}1` }, true);
    expect(plan).toEqual({ kind: 'new' });
    expect(reviewStartNote(plan)).toBe('');
  });
  it('with the flag off replaces the first pane, whatever the PR', () => {
    const plan = reviewStartPlan([pane(1, 646), pane(2, 647)], { pr: 647, url: `${T}647` }, false);
    expect(plan).toMatchObject({ kind: 'replace', pane: { slot: 1 } });
    expect(reviewStartNote(plan)).toBe('The running review (termag#646) is replaced.');
  });
  it('with the flag off and slot 1 free, says nothing is replaced though another pane runs (Devin, #786)', () => {
    expect(reviewStartPlan([pane(2, 647)], { pr: 700, url: `${T}700` }, false)).toEqual({ kind: 'new' });
  });
  it('on, restarts the PR\'s own pane, telling a number in another repository apart', () => {
    const plan = reviewStartPlan([pane(1, 646), pane(2, 647)], { pr: 647, url: `${T}647` }, true);
    expect(plan).toMatchObject({ kind: 'restart', pane: { slot: 2 }, others: 1 });
    expect(reviewStartNote(plan)).toBe('Restarts the review of termag#647; the other 1 keeps running.');
    expect(reviewStartPlan([pane(1, 646)], { pr: 646, url: 'https://github.com/example-org/terraform/pull/646' }, true)).toEqual({ kind: 'add', inUse: 1 });
  });
  it('on, adds a pane, until all 8 are in use', () => {
    expect(reviewStartNote(reviewStartPlan([pane(1, 646), pane(2, 647)], { pr: 700, url: `${T}700` }, true)))
      .toBe('Adds a review pane beside the 2 running (3 of 8).');
    const all = [1, 2, 3, 4, 5, 6, 7, 8].map(n => pane(n, 100 + n));
    const plan = reviewStartPlan(all, { pr: 999, url: `${T}999` }, true);
    expect(plan).toEqual({ kind: 'full' });
    expect(reviewStartNote(plan)).toBe('All 8 review panes are in use: close one to start another.');
    // Restarting one still works when all are in use.
    expect(reviewStartPlan(all, { pr: 103, url: `${T}103` }, true)).toMatchObject({ kind: 'restart', pane: { slot: 3 } });
  });
});
