import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
const { MAX_DEFER_DAYS, deferredUntil, parseDeferInput, parseDeferKey } = await import('./prDeferrals');
const { PrInputError } = await import('./prReview');

const NOW = new Date('2026-10-14T12:00:00Z');

describe('parseDeferKey', () => {
  it('takes the overlay\'s PR and branch keys', () => {
    expect(parseDeferKey('example-org/termag#99')).toBe('example-org/termag#99');
    expect(parseDeferKey('example-org/termag:feat/pr-defer')).toBe('example-org/termag:feat/pr-defer');
    expect(parseDeferKey(':local-only')).toBe(':local-only');
  });
  it('refuses anything else', () => {
    for (const bad of ['termag#99', 'example-org/termag#x', 'example-org/termag:', 'a/b:has space', 7, null, 'a/b:' + 'x'.repeat(300)]) {
      expect(() => parseDeferKey(bad)).toThrow(PrInputError);
    }
  });
});

describe('parseDeferInput', () => {
  it('defaults to one day', () => {
    expect(parseDeferInput({ key: 'example-org/termag#99' })).toEqual({ key: 'example-org/termag#99', days: 1 });
    expect(parseDeferInput({ key: 'example-org/termag#99', days: 3 }).days).toBe(3);
  });
  it('refuses odd day counts', () => {
    for (const days of [0, -1, 1.5, '2', MAX_DEFER_DAYS + 1]) {
      expect(() => parseDeferInput({ key: 'example-org/termag#99', days })).toThrow(PrInputError);
    }
  });
});

describe('deferredUntil', () => {
  it('counts from now for a new or expired deferral', () => {
    expect(deferredUntil(null, 1, NOW).toISOString()).toBe('2026-10-15T12:00:00.000Z');
    expect(deferredUntil(new Date('2026-10-13T00:00:00Z'), 2, NOW).toISOString()).toBe('2026-10-16T12:00:00.000Z');
  });
  it('pushes a running deferral on from its own end ("another day")', () => {
    expect(deferredUntil(new Date('2026-10-15T09:00:00Z'), 1, NOW).toISOString()).toBe('2026-10-16T09:00:00.000Z');
  });
});
