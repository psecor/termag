import { describe, expect, it } from 'vitest';
import { runNowRefusal } from './automationRunNow';

describe('runNowRefusal', () => {
  it('says why a skipped start did not happen, in the run row\'s words', () => {
    const err = { response: { status: 409, data: { run: { reasonLabel: 'the box was asleep' }, decision: { kind: 'skip', reason: 'box_unavailable' } } } };
    expect(runNowRefusal(err)).toBe('Not started: the box was asleep');
    expect(runNowRefusal({ response: { status: 409, data: { run: null, decision: { kind: 'skip', reason: 'budget' } } } })).toBe('Not started: budget');
  });
  it('carries the box\'s error for a start that failed', () => {
    expect(runNowRefusal({ response: { status: 502, data: { error: 'the run could not start: agent timed out', run: null, decision: { kind: 'failed', reason: 'launch', error: 'agent timed out' } } } }))
      .toBe('Not started: the run could not start: agent timed out');
  });
  it('leaves other errors to the caller', () => {
    expect(runNowRefusal({ response: { status: 403, data: { error: 'automations_disabled' } } })).toBeNull();
    expect(runNowRefusal(new Error('network'))).toBeNull();
    expect(runNowRefusal(null)).toBeNull();
  });
});
