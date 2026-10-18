import { describe, it, expect } from 'vitest';
import { reviewKeyLabel, reviewPollStatus, reviewStopCopy, reviewSubmitLabel, reviewTabLabel, roleFromParam } from './review';

describe('roleFromParam', () => {
  it('accepts the three panes and defaults to agent', () => {
    expect(roleFromParam('ctrl')).toBe('ctrl');
    expect(roleFromParam('review')).toBe('review');
    expect(roleFromParam('agent')).toBe('agent');
    expect(roleFromParam(null)).toBe('agent');
    expect(roleFromParam('data')).toBe('agent');
  });
});

describe('reviewPollStatus', () => {
  it('maps the pane state onto the capture cadence', () => {
    expect(reviewPollStatus({ alive: true, state: 'reviewing' })).toBe('working');
    expect(reviewPollStatus({ alive: true, state: 'waiting' })).toBe('waiting');
    expect(reviewPollStatus({ alive: true, state: 'done' })).toBe('idle');
    expect(reviewPollStatus({ alive: true, state: 'exited' })).toBe('idle');
  });
  it('treats an unknown state as busy and no pane as not running', () => {
    expect(reviewPollStatus({ alive: true, state: null })).toBe('working');
    expect(reviewPollStatus({ alive: false, state: null })).toBe('not_running');
    expect(reviewPollStatus(null)).toBe('not_running');
  });
});

describe('labels', () => {
  it('carry the PR number when the pane is alive', () => {
    expect(reviewTabLabel({ alive: true, pr: 212 })).toBe('review · #212');
    expect(reviewTabLabel({ alive: true, pr: null })).toBe('review');
    expect(reviewTabLabel(null)).toBe('review');
  });

  it('read Close once the review is ready or Devin is gone, Stop while it works', () => {
    expect(reviewKeyLabel('reviewing')).toBe('Stop');
    expect(reviewKeyLabel('waiting')).toBe('Stop');
    expect(reviewKeyLabel('done')).toBe('Close');
    expect(reviewKeyLabel('exited')).toBe('Close');
    expect(reviewKeyLabel('gone')).toBe('Stop');
    expect(reviewStopCopy('done')).toEqual({ verb: 'Close', confirmLabel: 'Close pane' });
    expect(reviewStopCopy('reviewing')).toEqual({ verb: 'Stop', confirmLabel: 'Stop review' });
  });

  it('name the PR on the submit button and say "again" for the one already under review', () => {
    expect(reviewSubmitLabel({ pr: null, hasReview: false, starting: false })).toBe('Review');
    expect(reviewSubmitLabel({ pr: 261, hasReview: false, starting: false })).toBe('Review PR #261');
    expect(reviewSubmitLabel({ pr: 261, currentPr: 246, hasReview: true, starting: false })).toBe('Review PR #261');
    expect(reviewSubmitLabel({ pr: 246, currentPr: 246, hasReview: true, starting: false })).toBe('Review PR #246 again');
    expect(reviewSubmitLabel({ pr: 246, currentPr: null, hasReview: true, starting: false })).toBe('Review PR #246');
    expect(reviewSubmitLabel({ pr: 246, currentPr: 246, hasReview: true, starting: true })).toBe('Starting…');
  });
});
