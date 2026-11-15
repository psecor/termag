import { describe, expect, it } from 'vitest';
import { agoLabel, commitLabel, inLabel, onWarmLine, poolFailureLine, poolHasBox, poolLine, refreshLine } from './environmentPool';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const base = { target: 3, ready: 3, preparing: 0, preparedAt: '2026-11-06T11:20:00Z', preparedCommit: { 'e2e-org/envdemo': 'abc1234def'.padEnd(40, '0') }, lastFailure: null, nextRefreshAt: null };

describe('poolLine', () => {
  it('reads "3 ready, prepared 40 min ago at abc1234"', () => {
    expect(poolLine(base, NOW)).toEqual({ text: '3 ready, prepared 40 min ago at', commit: 'abc1234' });
  });
  it('says what is still preparing', () => {
    expect(poolLine({ ...base, ready: 1, preparing: 2 }, NOW).text).toBe('1 ready, 2 preparing, prepared 40 min ago at');
    expect(poolLine({ ...base, ready: 0, preparing: 2 }, NOW)).toEqual({ text: 'None ready yet, 2 preparing', commit: null });
    expect(poolLine({ ...base, ready: 0 }, NOW).text).toBe('None ready');
    expect(poolLine({ ...base, ready: 0, target: 0 }, NOW).text).toBe('No pool: its boxes are going');
  });
  it('names each repository of a multi-repo pool', () => {
    expect(commitLabel({ 'o/a': '1'.repeat(40), 'o/b': '2'.repeat(40) })).toBe('a@1111111, b@2222222');
    expect(commitLabel(null)).toBeNull();
  });
});

describe('agoLabel and poolHasBox', () => {
  it('is coarse', () => {
    expect(agoLabel('2026-11-06T11:59:50Z', NOW)).toBe('just now');
    expect(agoLabel('2026-11-06T09:00:00Z', NOW)).toBe('3 h ago');
    expect(agoLabel('2026-11-01T12:00:00Z', NOW)).toBe('5 days ago');
  });
  it('needs a ready box', () => {
    expect(poolHasBox(base)).toBe(true);
    expect(poolHasBox({ ...base, ready: 0 })).toBe(false);
    expect(poolHasBox(null)).toBe(false);
  });
});

describe('refreshLine', () => {
  it('says when the stopped boxes are next checked', () => {
    expect(refreshLine({ ...base, nextRefreshAt: '2026-11-06T12:40:00Z' }, NOW)).toBe('Next refresh check in 40 min');
    expect(refreshLine({ ...base, nextRefreshAt: '2026-11-06T12:00:20Z' }, NOW)).toBe('Next refresh check now');
  });
  it('says nothing with nothing to check, or no pool', () => {
    expect(refreshLine(base, NOW)).toBeNull();
    expect(refreshLine({ ...base, target: 0, nextRefreshAt: '2026-11-06T12:40:00Z' }, NOW)).toBeNull();
  });
  it('is coarse', () => {
    expect(inLabel('2026-11-06T15:10:00Z', NOW)).toBe('in 3 h');
  });
});

describe('onWarmLine', () => {
  it("says how the newest box's warm-up went", () => {
    expect(onWarmLine({ ...base, onWarm: { state: 'succeeded', seconds: 41, log: null } })).toEqual({ text: "termag's warm-up done in 41 s", failed: false });
    expect(onWarmLine({ ...base, onWarm: { state: 'failed', seconds: 5, log: 'x' } })?.failed).toBe(true);
    expect(onWarmLine({ ...base, onWarm: { state: 'running', seconds: 0, log: null } })?.failed).toBe(true);
    expect(onWarmLine({ ...base, onWarm: null })).toBeNull();
    expect(onWarmLine(base)).toBeNull();
  });
});

describe('poolFailureLine (Devin on #1453)', () => {
  it('says what the pool does next: it waits for a change, or an hour', () => {
    expect(poolFailureLine('2026-11-06T11:40:00Z', NOW)).toBe('The last prepare failed 20 min ago. The pool waits until its setup or a default branch changes, or an hour after the failure.');
  });
});
