import { describe, expect, it } from 'vitest';
import { aggregateReviewRing, reviewRingTooltip, ringStateFor } from './reviewRing';
import type { SessionReview } from '../types';

const rev = (over: Partial<SessionReview> = {}): SessionReview => ({
  state: 'reviewing', pr: 205, url: null, at: '2026-10-09T12:00:00Z', doneAt: null, seenAt: null,
  ...over,
});

describe('ringStateFor (the seen rule)', () => {
  it('pulses for reviewing and waiting, none for exited or when there is nothing', () => {
    expect(ringStateFor(rev())).toBe('reviewing');
    expect(ringStateFor(rev({ state: 'waiting' }))).toBe('waiting');
    expect(ringStateFor(rev({ state: 'exited' }))).toBeNull();
    expect(ringStateFor(null)).toBeNull();
    expect(ringStateFor(undefined)).toBeNull();
  });

  it('a done not yet seen rings', () => {
    expect(ringStateFor(rev({ state: 'done', doneAt: '2026-10-09T13:00:00Z' }))).toBe('done');
  });

  it('a done seen after it does not ring', () => {
    expect(ringStateFor(rev({
      state: 'done', doneAt: '2026-10-09T13:00:00Z', seenAt: '2026-10-09T13:00:01Z',
    }))).toBeNull();
  });

  it('a seen equal to done counts as seen (the stamp answers that done)', () => {
    expect(ringStateFor(rev({
      state: 'done', doneAt: '2026-10-09T13:00:00Z', seenAt: '2026-10-09T13:00:00Z',
    }))).toBeNull();
  });

  it('a later done rings again (seenAt older than the new doneAt)', () => {
    expect(ringStateFor(rev({
      state: 'done', doneAt: '2026-10-09T14:00:00Z', seenAt: '2026-10-09T13:00:01Z',
    }))).toBe('done');
  });

  it('a seen that predates done only because the review ran again rings', () => {
    expect(ringStateFor(rev({
      state: 'done', doneAt: '2026-10-09T13:00:00Z', seenAt: '2026-10-09T12:00:00Z',
    }))).toBe('done');
  });

  it('a done without a doneAt stamp rings anyway (defensive)', () => {
    expect(ringStateFor(rev({ state: 'done', doneAt: null }))).toBe('done');
    expect(ringStateFor(rev({ state: 'done', doneAt: null, seenAt: '2026-10-09T13:00:00Z' }))).toBe('done');
  });
});

describe('aggregateReviewRing (the tile)', () => {
  it('waiting wins over everything', () => {
    expect(aggregateReviewRing(['done', 'waiting', 'reviewing'])).toBe('waiting');
    expect(aggregateReviewRing([null, 'waiting'])).toBe('waiting');
  });
  it('reviewing beats done; done beats nothing', () => {
    expect(aggregateReviewRing(['done', 'reviewing'])).toBe('reviewing');
    expect(aggregateReviewRing([null, null])).toBeNull();
    expect(aggregateReviewRing([])).toBeNull();
    expect(aggregateReviewRing(['done', null])).toBe('done');
    expect(aggregateReviewRing([undefined, 'done'])).toBe('done');
  });
});

describe('reviewRingTooltip', () => {
  it('names the PR when one is known, and reads on without it', () => {
    expect(reviewRingTooltip('reviewing', 205)).toBe('Devin reviewing PR #205');
    expect(reviewRingTooltip('waiting', 205)).toBe('Devin needs an answer in the review pane');
    expect(reviewRingTooltip('done', 205)).toBe('Review of PR #205 ready');
    expect(reviewRingTooltip('done', null)).toBe('Review ready');
    expect(reviewRingTooltip('reviewing', null)).toBe('Devin reviewing…');
  });
});

describe('reviewRingTooltip with a reviewer', () => {
  it('names the pane\'s reviewer', () => {
    expect(reviewRingTooltip('reviewing', 9, 'claude')).toBe('Claude reviewing PR #9');
    expect(reviewRingTooltip('waiting', 9, 'cursor')).toBe('Cursor needs an answer in the review pane');
    expect(reviewRingTooltip('done', 9, 'claude')).toBe('Review of PR #9 ready');
  });
});
