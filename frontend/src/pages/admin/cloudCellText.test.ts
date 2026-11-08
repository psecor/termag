// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { AdminCloudSession } from '../../services/adminApi';
import { liveCellText } from './AdminCloud';
import { matchesTerms, queryTerms } from './tablePaging';

// The Cloud tab's live status cell is a component, which the table's filter can't read, so its
// column says what it shows (Devin on #1298): the pill's word, then what the run waits on, a rate
// limit and the context size.
const run = (live: Partial<NonNullable<AdminCloudSession['live']>> | null, state = 'running') =>
  ({ state, live: live ? { status: 'waiting', waitingReason: null, rateLimited: null, contextTokens: null, ...live } : null }) as unknown as AdminCloudSession;

describe('liveCellText', () => {
  it('says what the cell shows, so "rate limited" finds a rate-limited run', () => {
    const text = liveCellText(run({ status: 'waiting', waitingReason: 'permission', rateLimited: 'quota', contextTokens: 42_000 }));
    expect(text).toBe('waiting on permission · rate limited: quota · 42k ctx');
    expect(matchesTerms(text, queryTerms('rate limited'))).toBe(true);
    expect(matchesTerms(text, queryTerms('quota waiting'))).toBe(true);
  });
  it('reads a status as its pill does, and a run with no status yet as the cell does', () => {
    expect(liveCellText(run({ status: 'not_running' }))).toBe('not running');
    expect(liveCellText(run(null))).toBe('no status yet');
    expect(liveCellText(run(null, 'ended'))).toBe('');
  });
});
