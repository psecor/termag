import { describe, it, expect } from 'vitest';
import { shortDate } from './range';

describe('shortDate', () => {
  it('formats a day key without timezone drift', () => {
    expect(shortDate('2026-10-09')).toBe('Oct 9');
    expect(shortDate('2026-01-31')).toBe('Jan 31');
  });
  it('returns anything that is not a day key unchanged', () => {
    // A row from another grouping, shown for a moment under the day labels.
    expect(shortDate('psecor')).toBe('psecor');
    expect(shortDate('my-project')).toBe('my-project');
    expect(shortDate('ip-10-0-75-157')).toBe('ip-10-0-75-157');
    expect(shortDate('2026-13-01')).toBe('2026-13-01');
    expect(shortDate('')).toBe('');
  });
});
