import { describe, expect, it } from 'vitest';
import { DAILY_THEME_OVERRIDE_KEY, pacificDate, themeDateOverride } from './date';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    m,
  };
}

describe('pacificDate', () => {
  it('is the date in Oakland, not UTC', () => {
    // 06:30 UTC on Nov 5 is 22:30 on Nov 4 in Pacific standard time.
    expect(pacificDate(new Date('2026-11-05T06:30:00Z'))).toBe('2026-11-04');
    expect(pacificDate(new Date('2026-11-05T08:30:00Z'))).toBe('2026-11-05');
    // Daylight time: UTC-7.
    expect(pacificDate(new Date('2026-07-01T06:59:00Z'))).toBe('2026-06-30');
    expect(pacificDate(new Date('2026-07-01T07:00:00Z'))).toBe('2026-07-01');
  });
});

describe('themeDateOverride', () => {
  it('takes a date from the URL and remembers it for the tab', () => {
    const s = memoryStorage();
    expect(themeDateOverride('?dailyTheme=2026-11-05', s)).toBe('2026-11-05');
    expect(s.m.get(DAILY_THEME_OVERRIDE_KEY)).toBe('2026-11-05');
    expect(themeDateOverride('', s)).toBe('2026-11-05');
  });

  it('keeps ?dailyTheme=off apart from no override, and remembers it too', () => {
    const s = memoryStorage();
    themeDateOverride('?dailyTheme=2026-11-05', s);
    expect(themeDateOverride('?dailyTheme=off', s)).toBe('off');
    expect(themeDateOverride('', s)).toBe('off');
    expect(themeDateOverride('?dailyTheme=2026-11-05', s)).toBe('2026-11-05');
  });

  it('ignores anything that is neither a date nor off', () => {
    const s = memoryStorage();
    expect(themeDateOverride('', s)).toBeNull();
    expect(themeDateOverride('?dailyTheme=../x', s)).toBeNull();
    s.m.set(DAILY_THEME_OVERRIDE_KEY, 'junk');
    expect(themeDateOverride('', s)).toBeNull();
  });

  it('still works from the URL when storage throws', () => {
    const throwing = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(themeDateOverride('?dailyTheme=2026-11-05', throwing)).toBe('2026-11-05');
    expect(themeDateOverride('?dailyTheme=off', throwing)).toBe('off');
    expect(themeDateOverride('', throwing)).toBeNull();
  });
});
