import { describe, expect, it } from 'vitest';
import { readRefreshHint, REFRESH_HINT_KEY, writeRefreshHint } from './refreshHint';

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    m,
  };
}

describe('the sign-in page\'s memory of onboarding-refresh-enabled', () => {
  it('is off until a signed-in page has seen the flag on', () => {
    expect(readRefreshHint(memory())).toBe(false);
  });

  it('follows the last value written', () => {
    const s = memory();
    writeRefreshHint(true, s);
    expect(s.m.get(REFRESH_HINT_KEY)).toBe('1');
    expect(readRefreshHint(s)).toBe(true);
    writeRefreshHint(false, s);
    expect(s.m.has(REFRESH_HINT_KEY)).toBe(false);
    expect(readRefreshHint(s)).toBe(false);
  });

  it('reads off, and writes nothing, when storage throws', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(readRefreshHint(broken)).toBe(false);
    expect(() => writeRefreshHint(true, broken)).not.toThrow();
  });
});
