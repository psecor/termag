// Which day's theme applies. Days are Pacific (termag's team and the research
// both are), so a theme turns over at midnight in Oakland for everyone.

export const DAILY_THEME_TIME_ZONE = 'America/Los_Angeles';
export const DAILY_THEME_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ?dailyTheme=<date> shows that day's theme whatever the flag and the setting
// say, for the preview script and reviewers; ?dailyTheme=off shows no day,
// even to someone who turned the theme on, until the tab closes or another
// date is asked for. Either is kept in sessionStorage so it survives the
// app's own navigation.
export const DAILY_THEME_PARAM = 'dailyTheme';
export const DAILY_THEME_OVERRIDE_KEY = 'termag.dailyThemeOverride';

/** The Pacific calendar date of `now`, as YYYY-MM-DD. */
export function pacificDate(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_THEME_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

interface OverrideStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What a ?dailyTheme= override asks for: a date, 'off' (no day at all), or null for no override. */
export type ThemeDateOverride = string | 'off' | null;

const validOverride = (v: string | null): ThemeDateOverride =>
  v === 'off' || (v !== null && DAILY_THEME_DATE.test(v)) ? v : null;

/** The ?dailyTheme= override in the URL, else the one remembered for the tab. */
export function themeDateOverride(search: string, storage: OverrideStorage | null): ThemeDateOverride {
  const asked = validOverride(new URLSearchParams(search).get(DAILY_THEME_PARAM));
  try {
    if (asked) {
      storage?.setItem(DAILY_THEME_OVERRIDE_KEY, asked);
      return asked;
    }
    return validOverride(storage?.getItem(DAILY_THEME_OVERRIDE_KEY) ?? null);
  } catch {
    // Storage blocked: the override lasts only while it is in the URL.
    return asked;
  }
}

export function safeSessionStorage(): OverrideStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
