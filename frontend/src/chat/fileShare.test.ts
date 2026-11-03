import { describe, expect, it } from 'vitest';
import { SHARE_CONFIRM_SKIP_KEY, clearShareConfirmSkips, linkAudience, shareConfirmSkips, skipShareConfirm, skipsShareConfirm } from './fileShare';

function memory(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('the share confirmation skip list', () => {
  it('is per space, remembered, and cleared all at once', () => {
    const s = memory();
    expect(skipsShareConfirm(s, 'improve-termag')).toBe(false);
    skipShareConfirm(s, 'improve-termag');
    skipShareConfirm(s, 'assets');
    skipShareConfirm(s, 'assets');
    expect(shareConfirmSkips(s)).toEqual(['assets', 'improve-termag']);
    expect(skipsShareConfirm(s, 'improve-termag')).toBe(true);
    expect(skipsShareConfirm(s, 'other')).toBe(false);
    clearShareConfirmSkips(s);
    expect(shareConfirmSkips(s)).toEqual([]);
  });

  it('reads junk, or no storage at all, as asking every time', () => {
    expect(shareConfirmSkips(memory({ [SHARE_CONFIRM_SKIP_KEY]: '{' }))).toEqual([]);
    expect(shareConfirmSkips(memory({ [SHARE_CONFIRM_SKIP_KEY]: '{"a":1}' }))).toEqual([]);
    expect(shareConfirmSkips(memory({ [SHARE_CONFIRM_SKIP_KEY]: '["a", 3, "", null]' }))).toEqual(['a']);
    expect(skipsShareConfirm(null, 'a')).toBe(false);
    expect(() => skipShareConfirm(null, 'a')).not.toThrow();
  });
});

describe('linkAudience', () => {
  it('says who the link opens for', () => {
    expect(linkAudience(false)).toBe('space members only');
    expect(linkAudience(true)).toBe('anyone signed in to termag');
  });
});
