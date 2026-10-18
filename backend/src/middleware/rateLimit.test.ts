import { describe, it, expect } from 'vitest';
import { takeToken, type Bucket } from './rateLimit';

describe('takeToken', () => {
  it('allows up to capacity, then refuses until refill', () => {
    const b = new Map<string, Bucket>();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(takeToken(b, 'k', 3, 1, t0)).toBe(true);
    expect(takeToken(b, 'k', 3, 1, t0)).toBe(false);
    expect(takeToken(b, 'k', 3, 1, t0 + 999)).toBe(false);
    expect(takeToken(b, 'k', 3, 1, t0 + 1000)).toBe(true);
    expect(takeToken(b, 'other', 3, 1, t0)).toBe(true); // independent keys
  });
});
